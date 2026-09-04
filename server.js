const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const FFMPEG_PATH = require('ffmpeg-static');
const { EventEmitter } = require('events');
const { Client } = require('discord.js-selfbot-v13');
const helmet = require('helmet');
const AUTH_COOKIE = 'voice_studio_auth';
const CLIENT_DEVICE_COOKIE = 'voice_studio_client_device';
const AUTH_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_ENABLED = Boolean(process.env.APP_PASSWORD || process.env.NODE_ENV === 'production');
const ACCOUNT_FILE = path.join(__dirname, 'data', 'accounts.enc');

const app = express();
const PORT = Number(process.env.PORT || 5050);
const DATA_DIR = path.join(__dirname, 'data');
const VOICE_STATE_FILE = path.join(DATA_DIR, 'voice-sessions.json');
const CLIENT_BIND_FILE = path.join(DATA_DIR, 'client-binding.json');
const MEDIA_LOG_FILE = path.join(DATA_DIR, 'media-events.log');
fs.mkdirSync(DATA_DIR, { recursive: true });

function logMediaEvent(level, event, details = {}) {
  const record = { time: new Date().toISOString(), level, event, ...details };
  try { fs.appendFileSync(MEDIA_LOG_FILE, `${JSON.stringify(record)}\n`, { mode: 0o600 }); } catch (error) { console.warn('[media-log] write failed:', error.message); }
  if (level === 'error') console.warn(`[media:${event}]`, details.error || details.stage || 'operation failed');
}

// Account tokens are persisted only as an authenticated AES-256-GCM payload.
// Set DATA_ENCRYPTION_KEY in production to keep this storage independent from
// the login password; APP_PASSWORD is retained as a backwards-compatible fallback.
function persistenceKey() { return crypto.createHash('sha256').update(String(process.env.DATA_ENCRYPTION_KEY || process.env.APP_PASSWORD || 'voice-studio-local-storage')).digest(); }
function saveAccounts(records) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', persistenceKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(records), 'utf8'), cipher.final()]);
  const payload = JSON.stringify({ version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: encrypted.toString('base64url') });
  const temp = `${ACCOUNT_FILE}.tmp`;
  fs.writeFileSync(temp, payload, { mode: 0o600 });
  fs.renameSync(temp, ACCOUNT_FILE);
  try { fs.chmodSync(ACCOUNT_FILE, 0o600); } catch {}
}
function loadAccounts() {
  try {
    const payload = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', persistenceKey(), Buffer.from(payload.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64url')), decipher.final()]);
    const records = JSON.parse(plain.toString('utf8'));
    return Array.isArray(records) ? records.filter((item) => item?.name && item?.token) : [];
  } catch (error) {
    if (fs.existsSync(ACCOUNT_FILE)) console.warn('[accounts] saved accounts could not be restored:', error.message);
    return [];
  }
}
function persistConnectedAccounts() {
  try { saveAccounts([...clients.entries()].map(([name, entry]) => ({ name, token: entry.token, savedAt: entry.savedAt || Date.now() })).filter((item) => item.token)); }
  catch (error) { console.warn('[accounts] unable to persist encrypted account file:', error.message); }
}

app.set('trust proxy', 1);
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], fontSrc: ["'self'", 'https:', 'data:'], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"] } },
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// This standalone app intentionally keeps tokens in memory only.
const clients = new Map();
const voiceSessions = new Map();
const rotations = new Map();
const stateCycles = new Map();
const syntheticStreams = new Map();
let videoStreamModulePromise;
const liveEvents = new EventEmitter();
liveEvents.setMaxListeners(0);
const accountLocks = new Map();
const SYNTHETIC_VIDEO_FILE = path.join(DATA_DIR, 'synthetic-stream-black-v2.mp4');

function ok(res, payload = {}) { return res.json({ success: true, ...payload }); }
function redact(value) { return String(value ?? '').replace(/(token|authorization|password|cookie)(["']?\s*[:=]\s*["']?)[^"',;\s}]+/gi, '$1$2[redacted]'); }
function fail(res, error, status = 200) {
  const message = redact(error?.message || String(error || 'Unknown error'));
  return res.status(status).json({ success: false, error: message });
}
function parseCookies(req) { const result = {}; for (const part of String(req.headers.cookie || '').split(';')) { const separator = part.indexOf('='); if (separator < 1) continue; const key = part.slice(0, separator).trim(); const raw = part.slice(separator + 1).trim(); try { result[key] = decodeURIComponent(raw); } catch {} } return result; }
function authSignature(value, secret = process.env.APP_PASSWORD || 'disabled') { return crypto.createHmac('sha256', secret).update(value).digest('base64url'); }
function hashSecret(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function readClientBinding() { try { const value = JSON.parse(fs.readFileSync(CLIENT_BIND_FILE, 'utf8')); return value && typeof value === 'object' ? value : null; } catch { return null; } }
function writeClientBinding(value) { const temp = `${CLIENT_BIND_FILE}.tmp`; try { fs.writeFileSync(temp, JSON.stringify(value)); fs.renameSync(temp, CLIENT_BIND_FILE); } catch (error) { try { fs.rmSync(temp, { force: true }); } catch {} throw new Error(`Unable to save client binding: ${redact(error.message)}`); } }
function makeAuthCookie(role, secret) { const stamp = String(Date.now()); return `${role}.${stamp}.${authSignature(stamp, secret)}`; }
function cookieMatches(raw, role, secret) { const [cookieRole, stamp, signature] = String(raw || '').split('.'); if (cookieRole !== role || !stamp || !signature || !/^\d+$/.test(stamp) || Date.now() - Number(stamp) > AUTH_TTL_MS) return false; const expected = authSignature(stamp, secret); return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)); }
function hasValidAuth(req) {
  if (!AUTH_ENABLED) { req.authRole = 'owner'; return true; }
  const cookies = parseCookies(req); const raw = cookies[AUTH_COOKIE];
  if (process.env.APP_PASSWORD && cookieMatches(raw, 'owner', process.env.APP_PASSWORD)) { req.authRole = 'owner'; return true; }
  if (process.env.CLIENT_PASSWORD && cookieMatches(raw, 'client', process.env.CLIENT_PASSWORD)) {
    const binding = readClientBinding(); const device = cookies[CLIENT_DEVICE_COOKIE];
    if (binding && binding.passwordFingerprint === hashSecret(process.env.CLIENT_PASSWORD) && device && binding.deviceHash === hashSecret(device)) { req.authRole = 'client'; return true; }
  }
  return false;
}
function requireAuth(req, res, next) {
  if (hasValidAuth(req)) return next();
  return res.status(401).json({ success: false, error: 'Authentication required' });
}
function emitLive(type, payload = {}) { liveEvents.emit('event', { type, at: Date.now(), ...payload }); }
function accountHealth(name, entry) {
  const client = entry?.client;
  const status = client?.ws?.status;
  const ready = status === 0;
  const state = ready ? 'healthy' : status == null ? 'unknown' : 'degraded';
  return { name, state, gatewayStatus: status ?? null, username: client?.user?.tag || client?.user?.username || name, lastError: entry?.lastError || null, connectedAt: entry?.connectedAt || null, lastSeenAt: entry?.lastSeenAt || null };
}
function sessionKey(name, guildId) { return `${name}__${guildId}`; }
function cleanAccounts(accounts) {
  const values = Array.isArray(accounts) ? accounts : [accounts];
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 500);
}
function cleanChannelIds(channelIds) {
  if (!Array.isArray(channelIds)) return [];
  return [...new Set(channelIds.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 500);
}
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length); let cursor = 0;
  const run = async () => { while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await worker(items[index], index); } };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
  return results;
}
function summary(results) {
  const okCount = results.filter((item) => item.ok).length;
  return { total: results.length, ok: okCount, failed: results.length - okCount };
}
function readPersistedSessions() {
  try {
    const value = JSON.parse(fs.readFileSync(VOICE_STATE_FILE, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
function persistSessions() {
  const safe = [...voiceSessions.values()].map(({ name, guildId, channelId, selfMute, selfDeaf, selfVideo, selfStream }) => ({
    name, guildId, channelId, selfMute: !!selfMute, selfDeaf: !!selfDeaf, selfVideo: !!selfVideo, selfStream: !!selfStream,
  }));
  const temp = `${VOICE_STATE_FILE}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(safe, null, 2));
    fs.renameSync(temp, VOICE_STATE_FILE);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    console.warn('[voice] unable to persist sessions:', error.message);
  }
}
for (const session of readPersistedSessions()) {
  if (session?.name && session?.guildId && session?.channelId) voiceSessions.set(sessionKey(session.name, session.guildId), session);
}

function ensureSyntheticVideo() {
  if (fs.existsSync(SYNTHETIC_VIDEO_FILE)) return SYNTHETIC_VIDEO_FILE;
  try {
    execFileSync(FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=15', '-t', '3600', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', SYNTHETIC_VIDEO_FILE], { stdio: 'ignore' });
    return SYNTHETIC_VIDEO_FILE;
  } catch (error) {
    throw new Error(`Unable to create synthetic stream source: ${error.message}`);
  }
}
function stopSyntheticStream(name) {
  const active = syntheticStreams.get(name);
  if (!active) return;
  try { active.controller?.abort?.(); } catch {}
  try { active.sourceProcess?.kill?.('SIGTERM'); } catch {}
  try { active.streamer?.stopStream?.(); } catch {}
  try { active.streamer?.signalVideo?.(false); } catch {}
  try { active.dispatcher?.destroy?.(); } catch {}
  try { active.streamConnection?.disconnect?.(); } catch {}
  syntheticStreams.delete(name);
}
function createBlackMediaSource() {
  const sourceProcess = spawn(FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=15',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-f', 'nut', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  sourceProcess.stderr.on('data', (chunk) => logMediaEvent('warn', 'stream.source_warning', { error: String(chunk).trim().slice(0, 300) }));
  return { stream: sourceProcess.stdout, sourceProcess };
}
function waitForDiscordStreamEvents(client, guildId, channelId, timeoutMs = 8000) {
  const expectedKey = `guild:${guildId}:${channelId}:${String(client.user?.id || '')}`;
  return new Promise((resolve, reject) => {
    let created = false;
    let serverUpdated = false;
    const finish = (error) => {
      clearTimeout(timer);
      client.off?.('raw', onRaw);
      if (error) reject(error); else resolve();
    };
    const onRaw = (packet) => {
      if (!packet || !['STREAM_CREATE', 'STREAM_SERVER_UPDATE'].includes(packet.t)) return;
      if (String(packet.d?.stream_key || '') !== expectedKey) return;
      if (packet.t === 'STREAM_CREATE') created = true;
      if (packet.t === 'STREAM_SERVER_UPDATE' && packet.d?.endpoint && packet.d?.token) serverUpdated = true;
      if (created && serverUpdated) finish();
    };
    const timer = setTimeout(() => finish(new Error(`Discord did not confirm stream signaling (create=${created}, server_update=${serverUpdated})`)), timeoutMs);
    client.on?.('raw', onRaw);
  });
}
function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]).finally(() => clearTimeout(timer));
}
function waitForWebRtcReady(streamer, timeoutMs = 6000) {
  return withTimeout(new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      if (streamer.voiceConnection?.webRtcConn?.ready === true) return resolve();
      if (Date.now() - startedAt < timeoutMs) return setTimeout(check, 150);
    };
    check();
  }), timeoutMs, 'Camera WebRTC media transport was not ready');
}
async function loadVideoStreamModule() {
  videoStreamModulePromise ||= import('@dank074/discord-video-stream');
  return videoStreamModulePromise;
}
async function startBuiltInGoLive(name, guildId, session, mediaKind = 'go-live') {
  const client = getClient(name);
  const connection = client?.voice?.connection;
  if (!connection || connection.channel?.id !== session.channelId) return { ok: false, error: 'The account has no active voice connection' };
  const source = createBlackMediaSource();
  let streamConnection;
  const signaling = waitForDiscordStreamEvents(client, guildId, session.channelId, 8000);
  try {
    streamConnection = await withTimeout(connection.createStreamConnection(), 8000, 'Discord media connection timed out after 8 seconds');
    await signaling;
    const dispatcher = streamConnection.playVideo(source.stream, { fps: 15, presetH26x: 'superfast', bitrate: 300, inputFFmpegArgs: ['-re'], outputFFmpegArgs: ['-g', '30'] });
    const active = { connection, streamConnection, dispatcher, sourceProcess: source.sourceProcess, guildId, channelId: session.channelId, mediaKind };
    syntheticStreams.set(name, active);
    dispatcher.on?.('error', (error) => logMediaEvent('error', 'stream.runtime_failed', { account: name, guildId, channelId: session.channelId, error: error?.message || String(error) }));
    dispatcher.once?.('finish', () => { if (syntheticStreams.get(name) === active) stopSyntheticStream(name); });
    const confirmed = await sendVoiceOpConfirmed(client, guildId, session.channelId, mediaKind === 'camera' ? { selfDeaf: false, selfVideo: true, selfStream: false } : { selfDeaf: false, selfStream: true }, 3000);
    if (!confirmed.ok) throw new Error(confirmed.error || 'Discord did not confirm Go Live state');
    return { ok: true };
  } catch (error) {
    await signaling.catch(() => {});
    syntheticStreams.delete(name);
    try { source.sourceProcess.kill('SIGTERM'); } catch {}
    try { streamConnection?.disconnect?.(); } catch {}
    return { ok: false, error: error.message || 'Unable to start Go Live' };
  }
}
async function startSyntheticStream(name, guildId, mediaKind = 'go-live') {
  const client = getClient(name);
  const session = voiceSessions.get(sessionKey(name, guildId));
  if (!client || !session?.channelId) return { ok: false, error: 'Account is not in a voice channel' };
  if (syntheticStreams.has(name)) return { ok: true, alreadyActive: true };
  const guild = client.guilds?.cache?.get?.(guildId);
  const channel = guild?.channels?.cache?.get?.(session.channelId);
  if (!channel) return { ok: false, error: 'Voice channel is not available for streaming' };
  if (mediaKind === 'go-live') return startBuiltInGoLive(name, guildId, session, mediaKind);
  let lastError;
  const startedAt = Date.now();
  logMediaEvent('info', 'stream.start', { account: name, guildId, channelId: session.channelId });
  try {
    const { Streamer, playStream } = await loadVideoStreamModule();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let streamer;
      let controller;
      try {
        streamer = new Streamer(client);
        // The upstream helper currently signals video with self_deaf=true.
        // That makes Discord reject both camera and Go Live transitions.
        streamer.signalVideo = (enabled) => streamer.sendOpcode(4, {
          guild_id: guildId,
          channel_id: session.channelId,
          self_mute: !!session.selfMute,
          self_deaf: false,
          self_video: !!enabled,
        });
        await withTimeout(streamer.joinVoice(guildId, session.channelId), 8000, 'Voice WebRTC connection timed out after 8 seconds');
        logMediaEvent('info', 'stream.media_connecting', { account: name, guildId, channelId: session.channelId, attempt });
        controller = new AbortController();
        const source = createBlackMediaSource();
        const active = { streamer, controller, sourceProcess: source.sourceProcess, guildId, channelId: session.channelId, mediaKind, startedAt: Date.now() };
        syntheticStreams.set(name, active);
        const task = playStream(source.stream, streamer, { type: mediaKind, format: 'nut', width: 640, height: 360, frameRate: 15 }, controller.signal);
        active.task = task;
        task.then(() => {
          active.completedAt = Date.now();
          if (syntheticStreams.get(name)?.task === task) stopSyntheticStream(name);
        }).catch((error) => logMediaEvent('error', 'stream.runtime_failed', { account: name, guildId, channelId: session.channelId, error: error?.message || String(error) }));
        await waitForWebRtcReady(streamer, 6000);
        await new Promise((resolve) => setTimeout(resolve, 700));
        if (active.completedAt || syntheticStreams.get(name) !== active) throw new Error('Media transport stopped before Discord confirmed it was active');
        logMediaEvent('info', 'stream.ready', { account: name, guildId, channelId: session.channelId, durationMs: Date.now() - startedAt, attempt });
        return { ok: true };
      } catch (error) {
        lastError = error;
        try { controller?.abort?.(); } catch {}
        try { streamer?.stopStream?.(); } catch {}
        if (syntheticStreams.get(name)?.streamer === streamer) syntheticStreams.delete(name);
        logMediaEvent('error', 'stream.attempt_failed', { account: name, guildId, channelId: session.channelId, attempt, durationMs: Date.now() - startedAt, error: error?.message || String(error) });
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  } catch (error) { lastError = error; }
  stopSyntheticStream(name);
  logMediaEvent('error', 'stream.failed', { account: name, guildId, channelId: session.channelId, durationMs: Date.now() - startedAt, error: lastError?.message || 'Unable to start synthetic stream' });
  return { ok: false, error: lastError?.message || 'Unable to start synthetic stream' };
}
async function withAccountLock(name, operation) {
  const key = String(name);
  const previous = accountLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  accountLocks.set(key, current);
  await previous.catch(() => {});
  try { return await operation(); }
  finally { release(); if (accountLocks.get(key) === current) accountLocks.delete(key); }
}
function stopTasksForAccount(name) {
  for (const [id, task] of rotations.entries()) {
    task.accounts = task.accounts.filter((item) => item !== name);
    if (!task.accounts.length) { clearInterval(task.timer); rotations.delete(id); emitLive('task.stopped', { id, reason: 'no accounts remaining' }); }
  }
  for (const [id, task] of stateCycles.entries()) {
    task.accounts = task.accounts.filter((item) => item !== name);
    if (!task.accounts.length) { clearInterval(task.timer); stateCycles.delete(id); emitLive('task.stopped', { id, reason: 'no accounts remaining' }); }
  }
}
function getClient(name) {
  const entry = clients.get(String(name || ''));
  return entry?.client || null;
}
function getGatewayShard(client) {
  return client?.ws?.shards?.first?.() || client?.ws?.shards?.get?.(0) || null;
}
function sendVoiceOp(client, guildId, channelId, opts = {}) {
  try {
    const shard = getGatewayShard(client);
    if (!shard) return { ok: false, error: 'No active gateway shard' };
    if (shard.status !== undefined && shard.status !== 0) return { ok: false, error: `Gateway not ready (status=${shard.status})` };
    shard.send({
      op: 4,
      d: {
        guild_id: guildId,
        channel_id: channelId ?? null,
        self_mute: !!opts.selfMute,
        self_deaf: !!opts.selfDeaf,
        self_video: !!opts.selfVideo,
        self_stream: !!opts.selfStream,
      },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Unable to send voice state' };
  }
}

// Fixed confirmation flow: timer is allocated before any early failure can call cleanup.
// The old implementation could leave the request pending because clearTimeout() ran
// while `timer` was still in the temporal dead zone.
function sendVoiceOpConfirmed(client, guildId, channelId, opts = {}, timeoutMs = 4500) {
  return new Promise((resolve) => {
    const userId = client?.user?.id;
    if (!userId) return resolve({ ok: false, error: 'Client not ready (no user id)' });

    let settled = false;
    let timer = null;
    let retryTimer = null;
    let attempts = 0;
    const cleanup = () => {
      try { client.ws?.off?.('VOICE_STATE_UPDATE', onWsState); } catch {}
      try { client.off?.('voiceStateUpdate', onJsState); } catch {}
      if (timer) clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
      timer = null;
      retryTimer = null;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const matches = (guild, channel) => String(guild) === String(guildId)
      && (channelId == null ? channel == null : String(channel) === String(channelId));
    const stateMatches = (data) => {
      if (!data || String(data.user_id) !== String(userId) || !matches(data.guild_id, data.channel_id)) return false;
      const flags = [
        ['self_mute', 'selfMute'], ['self_deaf', 'selfDeaf'], ['self_video', 'selfVideo'], ['self_stream', 'selfStream'],
      ];
      return flags.every(([wire, local]) => opts[local] === undefined || (data[wire] !== undefined && !!data[wire] === !!opts[local]));
    };
    const onWsState = (packet) => {
      const data = packet?.d || packet;
      if (stateMatches(data)) finish({ ok: true, confirmed: true });
    };
    const onJsState = (_oldState, newState) => {
      const id = newState?.member?.id || newState?.id || newState?.userId;
      if (String(id) !== String(userId)) return;
      const guild = newState?.guild?.id || newState?.guildId;
      const channel = newState?.channelId ?? newState?.channel_id;
      if (!matches(guild, channel)) return;
      const observed = {
        selfMute: newState?.selfMute ?? newState?.self_mute,
        selfDeaf: newState?.selfDeaf ?? newState?.self_deaf,
        selfVideo: newState?.selfVideo ?? newState?.self_video,
        selfStream: newState?.streaming ?? newState?.selfStream ?? newState?.self_stream,
      };
      const flagsMatch = Object.entries(opts).every(([key, value]) => {
        if (!['selfMute', 'selfDeaf', 'selfVideo', 'selfStream'].includes(key)) return true;
        return observed[key] !== undefined && !!observed[key] === !!value;
      });
      if (flagsMatch) finish({ ok: true, confirmed: true });
    };

    try { client.ws?.on?.('VOICE_STATE_UPDATE', onWsState); } catch {}
    try { client.on?.('voiceStateUpdate', onJsState); } catch {}
    timer = setTimeout(() => finish({ ok: false, error: 'Discord did not confirm the voice state in time' }), timeoutMs);

    const send = () => {
      if (settled) return;
      attempts += 1;
      const sent = sendVoiceOp(client, guildId, channelId, opts);
      if (!sent.ok) return finish(sent);
      if (attempts < 3) retryTimer = setTimeout(send, Math.min(900, Math.floor(timeoutMs / 3)));
    };
    send();
  });
}

function isVoiceChannel(channel) {
  return channel?.type === 'GUILD_VOICE' || channel?.type === 'GUILD_STAGE_VOICE' || channel?.type === 2 || channel?.type === 13;
}
function canJoin(channel, memberOrId) {
  const permissions = channel?.permissionsFor?.(memberOrId);
  return (permissions?.has?.('VIEW_CHANNEL') ?? true) && (permissions?.has?.('CONNECT') ?? true);
}
function validateTarget(client, guildId, channelId) {
  const guild = client?.guilds?.cache?.get?.(guildId);
  if (!guild) return { ok: false, error: 'Guild not found in this account' };
  const channel = guild.channels?.cache?.get?.(channelId);
  if (!channel) return { ok: false, error: 'Channel not found in this server' };
  if (!isVoiceChannel(channel)) return { ok: false, error: 'Selected channel is not a voice channel' };
  const me = guild.members?.me || guild.members?.cache?.get?.(client.user?.id) || client.user?.id;
  if (!canJoin(channel, me)) return { ok: false, error: 'Missing permission to view or join this channel' };
  const limit = Number(channel.userLimit || 0);
  const current = channel.members?.size || 0;
  const alreadyIn = guild.voiceStates?.cache?.get?.(client.user?.id)?.channelId === channelId;
  if (!alreadyIn && limit > 0 && current >= limit) return { ok: false, error: 'Voice channel is full' };
  return { ok: true, guild, channel };
}
function readGatewayVoiceState(client, guildId) {
  const state = client?.guilds?.cache?.get?.(guildId)?.voiceStates?.cache?.get?.(client.user?.id)
    || client?.voiceStates?.cache?.get?.(client.user?.id);
  const connection = client?.voice?.connection;
  const connectedGuildId = connection?.channel?.guild?.id || connection?.channel?.guildId;
  const fallback = connection?.channel?.id && (!guildId || String(connectedGuildId) === String(guildId)) ? {
    channelId: connection.channel.id,
    selfMute: !!(connection.voice?.selfMute ?? connection.voice?.self_mute),
    selfDeaf: !!(connection.voice?.selfDeaf ?? connection.voice?.self_deaf),
    selfVideo: !!(connection.voice?.selfVideo ?? connection.voice?.self_video),
    selfStream: !!(connection.voice?.streaming ?? connection.voice?.selfStream ?? connection.voice?.self_stream),
    guildId: connectedGuildId || guildId,
  } : null;
  if (!state || String(state.guild?.id || state.guildId || guildId) !== String(guildId)) return fallback;
  return {
    guildId: state.guild?.id || state.guildId || guildId,
    channelId: state.channelId ?? state.channel_id ?? null,
    selfMute: !!(state.selfMute ?? state.self_mute),
    selfDeaf: !!(state.selfDeaf ?? state.self_deaf),
    selfVideo: !!(state.selfVideo ?? state.self_video),
    selfStream: !!(state.streaming ?? state.selfStream ?? state.self_stream),
  };
}
function upsertSession(name, guildId, channelId, opts = {}) {
  const previous = voiceSessions.get(sessionKey(name, guildId));
  voiceSessions.set(sessionKey(name, guildId), {
    name, guildId, channelId,
    selfMute: opts.selfMute !== undefined ? !!opts.selfMute : !!previous?.selfMute,
    selfDeaf: opts.selfDeaf !== undefined ? !!opts.selfDeaf : !!previous?.selfDeaf,
    selfVideo: opts.selfVideo !== undefined ? !!opts.selfVideo : !!previous?.selfVideo,
    selfStream: opts.selfStream !== undefined ? !!opts.selfStream : !!previous?.selfStream,
    joinedAt: previous?.joinedAt || Date.now(), updatedAt: Date.now(),
  });
  persistSessions();
  emitLive('session.updated', { session: voiceSessions.get(sessionKey(name, guildId)) });
}
function removeSessionsForAccount(name, guildId) {
  if (guildId) voiceSessions.delete(sessionKey(name, guildId));
  else for (const key of voiceSessions.keys()) if (key.startsWith(`${name}__`)) voiceSessions.delete(key);
  persistSessions();
  emitLive('session.removed', { name, guildId });
}
function reconcileVoiceSessions() {
  for (const [name, entry] of clients.entries()) {
    for (const session of [...voiceSessions.values()].filter((item) => item.name === name)) {
      const actual = readGatewayVoiceState(entry.client, session.guildId);
      if (!actual || !actual.channelId) {
        stopSyntheticStream(name);
        removeSessionsForAccount(name, session.guildId);
        continue;
      }
      const observed = { ...actual, selfStream: syntheticStreams.has(name) ? true : actual.selfStream };
      const changed = observed.channelId !== session.channelId || observed.selfMute !== !!session.selfMute || observed.selfDeaf !== !!session.selfDeaf || observed.selfVideo !== !!session.selfVideo || observed.selfStream !== !!session.selfStream;
      if (changed) {
        if (observed.channelId !== session.channelId) stopSyntheticStream(name);
        upsertSession(name, session.guildId, observed.channelId, observed);
      }
    }
  }
}
async function moveAccount(name, guildId, channelId, opts = {}) {
  return withAccountLock(name, async () => {
    const client = getClient(name);
    if (!client) return { name, ok: false, error: 'Account is not connected' };
    const target = validateTarget(client, guildId, channelId);
    if (!target.ok) return { name, ok: false, error: target.error };
    const current = readGatewayVoiceState(client, guildId) || voiceSessions.get(sessionKey(name, guildId));
    if (current?.channelId === channelId) return { name, ok: true, alreadyIn: true, channelId };
    if (syntheticStreams.has(name)) stopSyntheticStream(name);
    const result = await sendVoiceOpConfirmed(client, guildId, channelId, { ...opts, selfVideo: false, selfStream: false });
    if (result.ok) {
      for (const key of [...voiceSessions.keys()]) if (key.startsWith(`${name}__`) && key !== sessionKey(name, guildId)) voiceSessions.delete(key);
      const actual = readGatewayVoiceState(client, guildId);
      upsertSession(name, guildId, channelId, { ...opts, ...(actual || {}), selfVideo: false, selfStream: false });
    }
    return { name, ok: result.ok, error: result.ok ? null : result.error, channelId };
  });
}

async function connectOne(token, name) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('A Discord token is required');
  let finalName = String(name || '').trim().slice(0, 48);
  const client = new Client({ checkUpdate: false, fetchAllMembers: false });
  await client.login(token.trim());
  if (!finalName) finalName = String(client.user?.globalName || client.user?.username || `account-${clients.size + 1}`).trim().slice(0, 48);
  if (clients.has(finalName)) {
    stopTasksForAccount(finalName);
    stopSyntheticStream(finalName);
    try { await clients.get(finalName).client.destroy(); } catch {}
    clients.delete(finalName);
  }
  const entry = { client, token: token.trim(), savedAt: Date.now(), connectedAt: Date.now(), lastSeenAt: Date.now(), lastError: null };
  clients.set(finalName, entry);
  persistConnectedAccounts();
  const markError = (error) => { entry.lastError = redact(error?.message || String(error || 'Unknown Discord client error')); entry.lastSeenAt = Date.now(); emitLive('account.health.changed', { account: accountHealth(finalName, entry) }); };
  client.on?.('error', markError);
  client.on?.('ready', () => { entry.lastError = null; entry.lastSeenAt = Date.now(); emitLive('account.health.changed', { account: accountHealth(finalName, entry) }); });
  client.on?.('disconnect', () => { entry.lastSeenAt = Date.now(); emitLive('account.health.changed', { account: accountHealth(finalName, entry) }); });
  emitLive('account.connected', { account: accountHealth(finalName, entry) });

  // Restore only the channel state; media capture remains browser-owned and must be
  // explicitly re-enabled by the user after reconnecting.
  setTimeout(() => {
    for (const session of voiceSessions.values()) {
      if (session.name !== finalName) continue;
      sendVoiceOp(client, session.guildId, session.channelId, {
        selfMute: session.selfMute, selfDeaf: session.selfDeaf, selfVideo: false, selfStream: false,
      });
    }
  }, 1200).unref?.();

  return {
    name: finalName,
    username: client.user?.tag || client.user?.username || finalName,
    id: client.user?.id || null,
  };
}

app.post('/api/auth', (req, res) => {
  if (!AUTH_ENABLED) return ok(res, { authenticated: true, required: false, role: 'owner' });
  const supplied = String(req.body?.password || '');
  const ip = req.ip || req.socket.remoteAddress || 'unknown'; const attempt = authAttempts.get(ip) || { start: Date.now(), count: 0 };
  if (Date.now() - attempt.start > 15 * 60 * 1000) { attempt.start = Date.now(); attempt.count = 0; }
  attempt.count += 1; authAttempts.set(ip, attempt);
  if (authAttempts.size > 10000) { for (const [attemptIp, value] of authAttempts) if (Date.now() - value.start > 30 * 60 * 1000) authAttempts.delete(attemptIp); }
  if (attempt.count > 10) return fail(res, new Error('Too many authentication attempts; try again later'), 429);
  if (!supplied || supplied.length > 256) return fail(res, new Error('Invalid access password'), 401);
  const ownerPassword = Buffer.from(process.env.APP_PASSWORD || ''); const suppliedPassword = Buffer.from(supplied);
  const ownerMatches = ownerPassword.length === suppliedPassword.length && crypto.timingSafeEqual(ownerPassword, suppliedPassword);
  let role = ownerMatches ? 'owner' : null;
  if (!role && process.env.CLIENT_PASSWORD) {
    const clientPassword = Buffer.from(process.env.CLIENT_PASSWORD); const clientMatches = clientPassword.length === suppliedPassword.length && crypto.timingSafeEqual(clientPassword, suppliedPassword);
    if (clientMatches) role = 'client';
  }
  if (!role) return fail(res, new Error('Invalid access password'), 401);
  let deviceCookie = null;
  if (role === 'client') {
    const current = readClientBinding(); const suppliedDevice = parseCookies(req)[CLIENT_DEVICE_COOKIE];
    const passwordFingerprint = hashSecret(process.env.CLIENT_PASSWORD);
    if (current && current.passwordFingerprint === passwordFingerprint) {
      if (!suppliedDevice || current.deviceHash !== hashSecret(suppliedDevice)) return fail(res, new Error('This client password is already bound to another device'), 403);
      deviceCookie = suppliedDevice;
    } else {
      deviceCookie = crypto.randomBytes(32).toString('base64url');
      try { writeClientBinding({ passwordFingerprint, deviceHash: hashSecret(deviceCookie), boundAt: Date.now() }); } catch (error) { return fail(res, error, 500); }
    }
  }
  const value = makeAuthCookie(role, role === 'owner' ? process.env.APP_PASSWORD : process.env.CLIENT_PASSWORD);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'; const flags = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const cookies = [`${AUTH_COOKIE}=${encodeURIComponent(value)}; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}; ${flags}`];
  if (deviceCookie) cookies.push(`${CLIENT_DEVICE_COOKIE}=${encodeURIComponent(deviceCookie)}; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}; ${flags}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', cookies);
  return ok(res, { authenticated: true, required: true, role });
});
app.get('/api/auth/status', (req, res) => ok(res, { authenticated: hasValidAuth(req), role: req.authRole || null, clientBound: Boolean(readClientBinding()) }));

const requestBuckets = new Map();
const authAttempts = new Map();
function originGuard(req, res, next) {
  if (req.method === 'GET' || req.path === '/auth') return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ success: false, error: 'Cross-origin request blocked' }); } catch { return res.status(403).json({ success: false, error: 'Invalid request origin' }); }
  return next();
}
function rateLimit(req, res, next) {
  const key = `${req.ip}:${req.method === 'GET' ? 'read' : 'write'}`;
  const now = Date.now(); const bucket = requestBuckets.get(key) || { start: now, count: 0 };
  if (now - bucket.start >= 60000) { bucket.start = now; bucket.count = 0; }
  bucket.count += 1; requestBuckets.set(key, bucket);
  if (requestBuckets.size > 10000) { for (const [bucketKey, value] of requestBuckets) if (now - value.start > 120000) requestBuckets.delete(bucketKey); }
  if (bucket.count > (req.method === 'GET' ? 240 : 90)) return res.status(429).json({ success: false, error: 'Too many requests; try again shortly' });
  res.setHeader('Cache-Control', 'no-store');
  return next();
}
app.use('/api', rateLimit, originGuard, requireAuth);
app.get('/api/health', (_req, res) => ok(res, { service: 'voice-studio', connected: clients.size, accounts: [...clients.entries()].map(([name, entry]) => accountHealth(name, entry)) }));
const healthTimer = setInterval(() => {
  for (const [name, entry] of clients.entries()) {
    emitLive('health.updated', { account: accountHealth(name, entry) });
  }
}, 10000);
healthTimer.unref?.();
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders?.();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  liveEvents.on('event', send);
  req.on('close', () => { clearInterval(heartbeat); liveEvents.off('event', send); });
});
app.get('/api/accounts/health', (_req, res) => ok(res, { accounts: [...clients.entries()].map(([name, entry]) => accountHealth(name, entry)) }));
app.get('/api/discord/clients', (_req, res) => {
  const sessionByName = new Map([...voiceSessions.values()].map((session) => [session.name, session]));
  return ok(res, { clients: [...clients.entries()].map(([name, entry]) => {
    const user = entry.client.user;
    const savedVoice = sessionByName.get(name) || null;
    const actualVoice = readGatewayVoiceState(entry.client, savedVoice?.guildId || '') || null;
    const voice = actualVoice?.channelId ? { ...(savedVoice || {}), ...actualVoice, name } : savedVoice;
    const guild = voice ? entry.client.guilds?.cache?.get?.(voice.guildId) : null;
    const member = guild?.members?.cache?.get?.(user?.id);
    const channel = voice ? guild?.channels?.cache?.get?.(voice.channelId) : null;
    return {
      name,
      username: user?.tag || user?.username || name,
      displayName: user?.globalName || user?.username || name,
      nickname: member?.displayName || user?.globalName || user?.username || name,
      id: user?.id || null,
      avatar: user?.displayAvatarURL?.({ size: 128 }) || null,
      status: user?.presence?.status || 'online',
      health: accountHealth(name, entry),
      voice: voice ? { guildId: voice.guildId, guildName: guild?.name || voice.guildId, channelId: voice.channelId, channelName: channel?.name || voice.channelId, selfMute: !!voice.selfMute, selfDeaf: !!voice.selfDeaf, selfVideo: !!voice.selfVideo, selfStream: !!voice.selfStream } : null,
    };
  }) });
});
app.post('/api/discord/connect', async (req, res) => {
  try { return ok(res, await connectOne(req.body?.token, req.body?.name)); }
  catch (error) { return fail(res, error, 400); }
});
app.post('/api/discord/connect-bulk', async (req, res) => {
  const items = Array.isArray(req.body?.accounts) ? req.body.accounts.slice(0, 500) : [];
  if (!items.length) return fail(res, new Error('accounts must contain at least one token'), 400);
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index] || {};
      try {
        const info = await connectOne(item.token, item.name || `account-${index + 1}`);
        results[index] = { ok: true, ...info };
      } catch (error) {
        results[index] = { ok: false, name: item.name || `account-${index + 1}`, error: error.message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
  return ok(res, { results, summary: summary(results) });
});
app.post('/api/discord/disconnect', async (req, res) => {
  const name = String(req.body?.name || [...clients.keys()][0] || '');
  const entry = clients.get(name);
  if (!entry) return ok(res);
  stopTasksForAccount(name);
  stopSyntheticStream(name);
  try { await entry.client.destroy(); } catch {}
  clients.delete(name);
  persistConnectedAccounts();
  emitLive('account.disconnected', { name });
  return ok(res, { name });
});
app.post('/api/discord/disconnect-all', async (_req, res) => {
  for (const name of clients.keys()) { stopTasksForAccount(name); stopSyntheticStream(name); }
  for (const entry of clients.values()) { try { await entry.client.destroy(); } catch {} }
  clients.clear();
  persistConnectedAccounts();
  emitLive('account.disconnected-all');
  return ok(res);
});

app.get('/api/voice/guilds', (req, res) => {
  const requested = String(req.query?.account || '').trim();
  const entries = requested ? [[requested, clients.get(requested)]] : [...clients.entries()];
  const guilds = [];
  for (const [name, entry] of entries) {
    if (!entry?.client?.guilds?.cache) continue;
    for (const guild of entry.client.guilds.cache.values()) {
      const me = guild.members?.me || entry.client.user?.id;
      const voiceChannels = [...guild.channels.cache.values()]
        .filter((channel) => isVoiceChannel(channel) && canJoin(channel, me))
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          userLimit: Number(channel.userLimit || 0),
          members: channel.members?.size || 0,
          bitrate: Math.round((Number(channel.bitrate || 64000)) / 1000),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (voiceChannels.length) guilds.push({ account: name, guildId: guild.id, guildName: guild.name, guildIcon: guild.iconURL?.({ size: 64 }) || null, voiceChannels });
    }
  }
  return ok(res, { guilds });
});
app.get('/api/voice/sessions', (req, res) => {
  const sessions = [];
  const sessionsByName = new Map();
  for (const session of voiceSessions.values()) { if (!sessionsByName.has(session.name)) sessionsByName.set(session.name, []); sessionsByName.get(session.name).push(session); }
  for (const [name, entry] of clients.entries()) {
    for (const session of (sessionsByName.get(name) || [])) {
      const actual = readGatewayVoiceState(entry.client, session.guildId);
      if (actual && !actual.channelId) { removeSessionsForAccount(name, session.guildId); continue; }
      const guild = entry.client.guilds?.cache?.get?.(session.guildId);
      const channel = guild?.channels?.cache?.get?.(actual?.channelId || session.channelId);
      const merged = { ...session, ...(actual || {}), channelId: actual?.channelId || session.channelId, guildName: guild?.name || session.guildId, channelName: channel?.name || actual?.channelId || session.channelId, guildIcon: guild?.iconURL?.({ size: 64 }) || null, memberCount: channel?.members?.size || 0 };
      sessions.push(merged);
    }
  }
  return ok(res, { sessions });
});
app.get('/api/voice/media-logs', (_req, res) => {
  try {
    const lines = fs.existsSync(MEDIA_LOG_FILE) ? fs.readFileSync(MEDIA_LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-200).map((line) => JSON.parse(line)) : [];
    return ok(res, { logs: lines });
  } catch (error) { return fail(res, new Error(`Unable to read media logs: ${error.message}`), 500); }
});
app.get('/api/voice/target-accounts', (req, res) => {
  const guildId = String(req.query?.guildId || '').trim();
  const channelId = String(req.query?.channelId || '').trim();
  if (!guildId || !channelId) return fail(res, new Error('guildId and channelId are required'), 400);
  const accounts = [...clients.entries()].map(([name, entry]) => {
    const user = entry.client.user;
    const guild = entry.client.guilds?.cache?.get?.(guildId);
    const channel = guild?.channels?.cache?.get?.(channelId);
    const member = guild?.members?.cache?.get?.(user?.id);
    const session = voiceSessions.get(sessionKey(name, guildId));
    let reason = null;
    let available = true;
    if (!guild) { available = false; reason = 'الحساب ليس عضوًا في هذا السيرفر'; }
    else if (!channel || !isVoiceChannel(channel)) { available = false; reason = 'الروم غير موجود لهذا الحساب'; }
    else if (!canJoin(channel, guild.members?.me || user?.id)) { available = false; reason = 'لا يملك صلاحية دخول الروم أو الروم ممتلئ'; }
    return { name, username: user?.tag || user?.username || name, nickname: member?.displayName || user?.globalName || user?.username || name, id: user?.id || null, avatar: user?.displayAvatarURL?.({ size: 64 }) || null, available, reason, current: session ? { channelId: session.channelId, channelName: guild?.channels?.cache?.get?.(session.channelId)?.name || session.channelId, selfMute: !!session.selfMute, selfDeaf: !!session.selfDeaf, selfVideo: !!session.selfVideo, selfStream: !!session.selfStream } : null };
  });
  return ok(res, { guildId, channelId, accounts });
});
app.get('/api/voice/rotations', (_req, res) => ok(res, { rotations: [...rotations.values()].map(({ timer, ...item }) => item) }));
app.get('/api/voice/state-cycles', (_req, res) => ok(res, { cycles: [...stateCycles.values()].map(({ timer, ...item }) => item) }));

app.post('/api/voice/join', async (req, res) => {
  const accounts = cleanAccounts(req.body?.accounts);
  const { guildId, channelId, selfMute = false, selfDeaf = false } = req.body || {};
  if (!accounts.length || !guildId || !channelId) return fail(res, new Error('accounts, guildId and channelId are required'), 400);
  if (typeof selfMute !== 'boolean' || typeof selfDeaf !== 'boolean') return fail(res, new Error('Mute values must be boolean'), 400);
  const results = await mapWithConcurrency(accounts, 8, (name) => moveAccount(name, guildId, channelId, { selfMute, selfDeaf }));
  emitLive('operation.completed', { operation: 'join', results, summary: summary(results) });
  return ok(res, { results, summary: summary(results) });
});
app.post('/api/voice/leave', async (req, res) => {
  const accounts = cleanAccounts(req.body?.accounts);
  const guildId = String(req.body?.guildId || '');
  if (!accounts.length || !guildId) return fail(res, new Error('accounts and guildId are required'), 400);
  const results = await mapWithConcurrency(accounts, 8, (name) => withAccountLock(name, async () => {
    const client = getClient(name);
    if (!client) return { name, ok: false, error: 'Account is not connected' };
    const current = readGatewayVoiceState(client, guildId) || voiceSessions.get(sessionKey(name, guildId));
    if (!current?.channelId) { stopTasksForAccount(name); removeSessionsForAccount(name, guildId); return { name, ok: true, alreadyLeft: true }; }
    stopTasksForAccount(name);
    stopSyntheticStream(name);
    const result = await sendVoiceOpConfirmed(client, guildId, null, {}, 5000);
    if (result.ok) removeSessionsForAccount(name, guildId);
    return { name, ok: result.ok, error: result.ok ? null : result.error };
  }));
  emitLive('operation.completed', { operation: 'leave', results, summary: summary(results) });
  return ok(res, { results, summary: summary(results) });
});
app.post('/api/voice/state', async (req, res) => {
  const accounts = cleanAccounts(req.body?.accounts);
  const { guildId, selfMute, selfDeaf, selfVideo, selfStream } = req.body || {};
  if (!accounts.length || !guildId) return fail(res, new Error('accounts and guildId are required'), 400);
  for (const value of [selfMute, selfDeaf, selfVideo, selfStream]) if (value !== undefined && typeof value !== 'boolean') return fail(res, new Error('Voice state values must be boolean'), 400);
  if (selfDeaf === true && (selfVideo === true || selfStream === true)) return fail(res, new Error('Video or screen share cannot be enabled while deafened'), 400);
  const results = await mapWithConcurrency(accounts, 8, (name) => withAccountLock(name, async () => {
    const operationStartedAt = Date.now();
    const mediaKind = selfStream !== undefined ? 'stream' : selfVideo !== undefined ? 'camera' : 'voice-state';
    const client = getClient(name);
    const observed = readGatewayVoiceState(client, guildId);
    const current = {
      ...(observed || voiceSessions.get(sessionKey(name, guildId)) || {}),
      selfStream: syntheticStreams.has(name) || !!observed?.selfStream,
      selfVideo: syntheticStreams.get(name)?.mediaKind === 'camera' || !!observed?.selfVideo,
    };
    if (!client) return { name, ok: false, error: 'Account is not connected' };
    if (!current?.channelId) return { name, ok: false, error: 'Account is not in a voice channel' };
    const enablingMedia = selfVideo === true || selfStream === true;
    const next = {
      selfMute: selfMute !== undefined ? selfMute : !!current.selfMute,
      selfDeaf: selfDeaf !== undefined ? selfDeaf : enablingMedia ? false : !!current.selfDeaf,
      selfVideo: selfVideo !== undefined ? selfVideo : !!current.selfVideo,
      selfStream: selfStream !== undefined ? selfStream : !!current.selfStream,
    };
    if (next.selfDeaf && (next.selfVideo || next.selfStream)) return { name, ok: false, error: 'Video or screen share cannot be enabled while deafened' };
    let result;
    if (next.selfStream && !syntheticStreams.has(name)) result = await startSyntheticStream(name, guildId, 'go-live');
    else if (next.selfVideo && !syntheticStreams.has(name)) result = await startSyntheticStream(name, guildId, 'camera');
    else result = await sendVoiceOpConfirmed(client, guildId, current.channelId, next, 9000);
    if (result.ok) {
      if (!next.selfStream && !next.selfVideo && (current.selfStream || current.selfVideo)) stopSyntheticStream(name);
      const actual = readGatewayVoiceState(client, guildId);
      Object.assign(current, actual || {}, next, { selfStream: !!next.selfStream, selfVideo: !!next.selfVideo, updatedAt: Date.now() });
      persistSessions();
    }
    const output = { name, ok: result.ok, error: result.ok ? null : result.error };
    logMediaEvent(result.ok ? 'info' : 'error', `${mediaKind}.${result.ok ? 'confirmed' : 'failed'}`, { account: name, guildId, channelId: current.channelId, durationMs: Date.now() - operationStartedAt, error: output.error || undefined });
    return output;
  }));
  emitLive('operation.completed', { operation: 'state', results, summary: summary(results) });
  return ok(res, { results, summary: summary(results) });
});
app.post('/api/voice/join-all', async (req, res) => {
  const { guildId, channelId, selfMute = false, selfDeaf = false } = req.body || {};
  const accounts = [...clients.keys()];
  if (!guildId || !channelId) return fail(res, new Error('guildId and channelId are required'), 400);
  const results = await mapWithConcurrency(accounts, 8, (name) => moveAccount(name, guildId, channelId, { selfMute, selfDeaf }));
  emitLive('operation.completed', { operation: 'join-all', results, summary: summary(results) });
  return ok(res, { results, summary: summary(results) });
});
app.post('/api/voice/distribute-random', async (req, res) => {
  const accounts = cleanAccounts(req.body?.accounts).length ? cleanAccounts(req.body.accounts) : [...clients.keys()];
  const { guildId, channelIds } = req.body || {};
  if (!guildId || !Array.isArray(channelIds) || !channelIds.length) return fail(res, new Error('guildId and channelIds are required'), 400);
  const shuffled = [...channelIds].sort(() => Math.random() - 0.5);
  const results = await mapWithConcurrency(accounts, 8, (name, index) => moveAccount(name, guildId, shuffled[index % shuffled.length]));
  emitLive('operation.completed', { operation: 'distribute-random', results, summary: summary(results) });
  return ok(res, { results, summary: summary(results) });
});

app.post('/api/voice/rotation/start', async (req, res) => {
  const accounts = cleanAccounts(req.body?.accounts);
  const { guildId, guildName, intervalMs, randomOrder = false } = req.body || {};
  const channelIds = cleanChannelIds(req.body?.channelIds);
  const delay = Math.max(1000, Number(intervalMs || 60000));
  if (!accounts.length || !guildId || !Array.isArray(channelIds) || channelIds.length < 2) return fail(res, new Error('At least two channels and one account are required'), 400);
  const initial = await Promise.all(accounts.map((name) => moveAccount(name, guildId, channelIds[0])));
  const readyAccounts = initial.filter((result) => result.ok).map((result) => result.name);
  if (!readyAccounts.length) return ok(res, { id: null, started: false, initial, summary: summary(initial) });
  const id = crypto.randomUUID();
  const task = { id, accounts: readyAccounts, guildId, guildName: guildName || guildId, channels: channelIds, intervalMs: delay, randomOrder: !!randomOrder, currentIdx: 0, nextAt: Date.now() + delay };
  task.running = false;
  task.lastResults = initial;
  task.timer = setInterval(async () => {
    if (task.running) return;
    task.running = true;
    task.currentIdx = (task.currentIdx + 1) % task.channels.length;
    const ids = task.randomOrder ? [...task.channels].sort(() => Math.random() - 0.5) : task.channels;
    try {
      task.lastResults = await Promise.all(task.accounts.map((name, index) => moveAccount(name, task.guildId, ids[(task.currentIdx + index) % ids.length])));
      task.nextAt = Date.now() + task.intervalMs;
    } finally { task.running = false; }
  }, delay);
  rotations.set(id, task);
  return ok(res, { id, started: true, initial, summary: summary(initial) });
});
app.post('/api/voice/rotation/stop', (req, res) => {
  const id = String(req.body?.id || '');
  const task = rotations.get(id);
  if (!task) return fail(res, new Error('Rotation not found'), 404);
  clearInterval(task.timer); rotations.delete(id); return ok(res);
});
app.post('/api/voice/state-cycle/start', async (req, res) => {
  const accounts = cleanAccounts(req.body?.accounts);
  const { guildId, states, intervalMs } = req.body || {};
  const delay = Math.max(1000, Number(intervalMs || 60000));
  if (!accounts.length || !guildId || !Array.isArray(states) || states.length < 2) return fail(res, new Error('At least two states and one account are required'), 400);
  const validStates = states.every((item) => item && typeof item === 'object'
    && ['selfMute', 'selfDeaf', 'selfVideo', 'selfStream'].every((key) => item[key] === undefined || typeof item[key] === 'boolean')
    && !(item.selfDeaf === true && (item.selfVideo === true || item.selfStream === true)));
  if (!validStates) return fail(res, new Error('State cycle contains an invalid voice state'), 400);
  const id = crypto.randomUUID();
  const task = { id, accounts, guildId, states, intervalMs: delay, currentIdx: 0, nextAt: Date.now() + delay };
  task.running = false;
  task.lastResults = await Promise.all(task.accounts.map(async (name) => {
    const current = voiceSessions.get(sessionKey(name, task.guildId));
    const client = getClient(name);
    if (!current || !client) return { name, ok: false, error: 'Account is not currently in a voice channel' };
    const next = { ...current, ...task.states[0] };
    if (next.selfDeaf && (next.selfVideo || next.selfStream)) return { name, ok: false, error: 'Invalid deafened media state' };
    const result = next.selfStream ? await startSyntheticStream(name, task.guildId) : await sendVoiceOpConfirmed(client, task.guildId, current.channelId, next, 9000);
    if (result.ok) { Object.assign(current, next, { selfStream: !!next.selfStream, updatedAt: Date.now() }); persistSessions(); }
    return { name, ok: result.ok, error: result.ok ? null : result.error };
  }));
  task.timer = setInterval(async () => {
    if (task.running) return;
    task.running = true;
    task.currentIdx = (task.currentIdx + 1) % task.states.length;
    const state = task.states[task.currentIdx];
    try {
      task.lastResults = [];
      await Promise.all(task.accounts.map((name) => withAccountLock(name, async () => {
        const current = voiceSessions.get(sessionKey(name, task.guildId));
        if (!current) return;
        const client = getClient(name);
        if (!client) return;
        const next = { ...current, ...state };
        if (next.selfDeaf && (next.selfVideo || next.selfStream)) return;
        let result;
        if (next.selfStream) result = await startSyntheticStream(name, task.guildId);
        else {
          if (current.selfStream) stopSyntheticStream(name);
          result = await sendVoiceOpConfirmed(client, task.guildId, current.channelId, next, 5000);
        }
        if (result.ok) { Object.assign(current, next, { selfStream: !!next.selfStream, updatedAt: Date.now() }); persistSessions(); }
        task.lastResults.push({ name, ok: result.ok, error: result.ok ? null : result.error });
      })));
      task.nextAt = Date.now() + task.intervalMs;
    } finally { task.running = false; }
  }, delay);
  stateCycles.set(id, task);
  return ok(res, { id });
});
app.post('/api/voice/state-cycle/stop', (req, res) => {
  const id = String(req.body?.id || '');
  const task = stateCycles.get(id);
  if (!task) return fail(res, new Error('State cycle not found'), 404);
  clearInterval(task.timer); stateCycles.delete(id); return ok(res);
});

async function restoreSavedAccounts() {
  const saved = loadAccounts();
  if (!saved.length) return;
  console.log(`[accounts] restoring ${saved.length} saved account${saved.length === 1 ? '' : 's'}`);
  for (const account of saved) {
    try { await connectOne(account.token, account.name); }
    catch (error) { console.warn(`[accounts] unable to restore ${account.name}:`, redact(error.message)); }
  }
}
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => { console.log(`Voice Studio listening on http://localhost:${PORT}`); setInterval(() => { try { reconcileVoiceSessions(); } catch (error) { console.warn('[voice] session reconciliation failed:', error.message); } }, 3000).unref?.(); restoreSavedAccounts().catch((error) => console.warn('[accounts] restore failed:', error.message)); });
}

module.exports = { app, clients, voiceSessions, sendVoiceOp, sendVoiceOpConfirmed, validateTarget, startSyntheticStream, stopSyntheticStream, ensureSyntheticVideo, saveAccounts, loadAccounts };
