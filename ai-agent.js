'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const OPENAI_BASE = String(process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

function requireConfig() {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY is not configured');
}
function tempFile(ext) { return path.join(os.tmpdir(), `voice-studio-${crypto.randomUUID()}${ext}`); }
function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22); header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
function collect(stream, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    stream.on('data', (chunk) => { size += chunk.length; if (size <= maxBytes) chunks.push(chunk); else stream.destroy(new Error('Audio segment too large')); });
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}
async function openaiFetch(endpoint, init) {
  requireConfig();
  const response = await fetch(`${OPENAI_BASE}${endpoint}`, { ...init, headers: { Authorization: `Bearer ${OPENAI_KEY}`, ...(init.headers || {}) } });
  if (!response.ok) throw new Error(`AI provider error (${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response;
}
async function transcribe(pcm) {
  const file = tempFile('.wav'); fs.writeFileSync(file, pcmToWav(pcm), { mode: 0o600 });
  try {
    const form = new FormData(); form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', process.env.AI_STT_MODEL || 'gpt-4o-mini-transcribe');
    const response = await openaiFetch('/audio/transcriptions', { method: 'POST', body: form });
    return String((await response.json()).text || '').trim();
  } finally { fs.rmSync(file, { force: true }); }
}
async function reply(messages, systemPrompt) {
  const response = await openaiFetch('/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    model: process.env.AI_CHAT_MODEL || 'gpt-4o-mini', temperature: 0.5, max_tokens: 180,
    messages: [{ role: 'system', content: systemPrompt }, ...messages.slice(-10)],
  }) });
  return String((await response.json()).choices?.[0]?.message?.content || '').trim();
}
async function synthesize(text) {
  const response = await openaiFetch('/audio/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    model: process.env.AI_TTS_MODEL || 'gpt-4o-mini-tts', voice: process.env.AI_TTS_VOICE || 'alloy', input: text, response_format: 'wav',
  }) });
  return Buffer.from(await response.arrayBuffer());
}
function playWav(connection, wav) {
  return new Promise((resolve, reject) => {
    const dispatcher = connection.playAudio(Readable.from(wav), { type: 'unknown', inputArgs: ['-f', 'wav'] });
    dispatcher.once?.('finish', resolve); dispatcher.once?.('error', reject);
  });
}

class VoiceAgent {
  constructor({ account, connection, userId, systemPrompt, onEvent }) {
    this.account = account; this.connection = connection; this.userId = userId; this.systemPrompt = systemPrompt;
    this.onEvent = onEvent || (() => {}); this.active = false; this.processing = false; this.history = []; this.listener = null;
  }
  emit(event, details = {}) { this.onEvent({ event, account: this.account, at: Date.now(), ...details }); }
  start() {
    if (!this.connection?.receiver || !this.connection?.on) throw new Error('The account must be connected to a voice channel first');
    requireConfig(); if (this.active) return false;
    this.active = true;
    this.listener = async (user, speaking) => {
      if (!this.active || this.processing || !speaking?.has?.(1) || !user?.id || String(user.id) === String(this.connection.client.user?.id)) return;
      this.processing = true; let stream;
      try {
        stream = this.connection.receiver.createStream(user, { mode: 'pcm', end: 'silence' });
        const pcm = await collect(stream);
        if (pcm.length < 4800 || !this.active) return;
        this.emit('transcription.started', { userId: user.id });
        const text = await transcribe(pcm); if (!text || !this.active) return;
        this.emit('transcription.completed', { userId: user.id, text });
        this.history.push({ role: 'user', content: text });
        const answer = await reply(this.history, this.systemPrompt);
        if (!answer || !this.active) return;
        this.history.push({ role: 'assistant', content: answer }); this.emit('response.ready', { text: answer });
        await playWav(this.connection, await synthesize(answer)); this.emit('response.played', { text: answer });
      } catch (error) { this.emit('error', { error: error.message || String(error) }); }
      finally { this.processing = false; }
    };
    this.connection.on('speaking', this.listener); this.emit('started'); return true;
  }
  stop() { if (!this.active) return false; this.active = false; if (this.listener) this.connection.off?.('speaking', this.listener); this.listener = null; this.emit('stopped'); return true; }
  status() { return { account: this.account, active: this.active, processing: this.processing, turns: this.history.filter((item) => item.role === 'user').length }; }
}
module.exports = { VoiceAgent, pcmToWav };
