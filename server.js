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
// The auth session intentionally expires after 12 hours, but the device
// binding must survive that expiry so the same client can log in again.
const CLIENT_DEVICE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
// Fail closed: a production deployment without an owner password must not expose the API.
const AUTH_ENABLED = true;
const ACCOUNT_FILE = path.join(__dirname, 'data', 'accounts.enc');

const app = express();
const PORT = Number(process.env.PORT || 5050);
const DATA_DIR = path.join(__dirname, 'data');
const VOICE_STATE_FILE = path.join(DATA_DIR, 'voice-sessions.json');
const AUTOMATION_TASKS_FILE = path.join(DATA_DIR, 'automation-tasks.json');
const PLAYING_FILE = path.join(DATA_DIR, 'playing-sessions.json');
const PLAYING_LOG_FILE = path.join(DATA_DIR, 'playing-events.log');
const CLIENT_BIND_FILE = path.join(DATA_DIR, 'client-binding.json');
const MEDIA_LOG_FILE = path.join(DATA_DIR, 'media-events.log');
fs.mkdirSync(DATA_DIR, { recursive: true });
const BUILD_FILES = ['server.js', 'package.json', 'public/app.js', 'public/index.html', 'public/styles.css', 'public/playing.css'];
function getBuildVersion() {
  return crypto.createHash('sha256').update(BUILD_FILES.map((file) => {
    const fullPath = path.join(__dirname, file);
    try { const stat = fs.statSync(fullPath); return `${file}:${stat.size}:${stat.mtimeMs}`; } catch { return `${file}:missing`; }
  }).join('|')).digest('hex').slice(0, 16);
}

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
const mediaStreamers = new Map();
const accountOperations = new Map();
const playingSessions = new Map();
const playingSafety = new Map();
const PLAYING_MIN_INTERACTION_GAP_MS = 2500;
const playingEvents = [];
let videoStreamModulePromise;
const liveEvents = new EventEmitter();
liveEvents.setMaxListeners(0);
const accountLocks = new Map();
const MEDIA_SETTLE_DELAY_MS = 4000;
const ROTATION_PHASE_GAP_MS = 120000;
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
function normalizeVoiceState(state = {}) {
  return { selfMute: !!state.selfMute, selfDeaf: !!state.selfDeaf, selfVideo: !!state.selfVideo, selfStream: !!state.selfStream };
}
function persistAutomationTasks() {
  const payload = { version: 1, rotations: [...rotations.values()].map(({ timer, running, ...task }) => task), stateCycles: [...stateCycles.values()].map(({ timer, running, ...task }) => task), savedAt: Date.now() };
  const temp = `${AUTOMATION_TASKS_FILE}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 }); fs.renameSync(temp, AUTOMATION_TASKS_FILE); } catch (error) { try { fs.rmSync(temp, { force: true }); } catch {} console.warn('[automation] unable to persist tasks:', error.message); }
}
function loadAutomationTasks() { try { const value = JSON.parse(fs.readFileSync(AUTOMATION_TASKS_FILE, 'utf8')); return value && typeof value === 'object' ? value : { rotations: [], stateCycles: [] }; } catch { return { rotations: [], stateCycles: [] }; } }
function persistPlayingSessions() {
  const safe = [...playingSessions.values()].map(({ timer, running, ...session }) => session);
  const temp = `${PLAYING_FILE}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(safe, null, 2), { mode: 0o600 }); fs.renameSync(temp, PLAYING_FILE); } catch (error) { try { fs.rmSync(temp, { force: true }); } catch {} console.warn('[playing] unable to persist sessions:', error.message); }
}
function loadPlayingSessions() { try { const value = JSON.parse(fs.readFileSync(PLAYING_FILE, 'utf8')); return Array.isArray(value) ? value : []; } catch { return []; } }
function logPlayingEvent(event, details = {}) { const record = { time: new Date().toISOString(), event, ...details }; playingEvents.unshift(record); playingEvents.splice(500); try { fs.appendFileSync(PLAYING_LOG_FILE, `${JSON.stringify(record)}\n`, { mode: 0o600 }); } catch {} emitLive(`playing.${event}`, details); }
function readPlayingEvents() { try { return fs.readFileSync(PLAYING_LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-500).reverse().map((line) => JSON.parse(line)); } catch { return [...playingEvents]; } }
function cleanPlayingSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => { const button = String(step?.button || '').trim().slice(0, 80); return { button, buttons: button.split(/[|,]/).map((item) => item.trim()).filter(Boolean).slice(0, 10), messageId: String(step?.messageId || '').trim().slice(0, 40), customId: String(step?.customId || '').trim().slice(0, 100), phrase: String(step?.phrase || '').trim().slice(0, 500) }; }).filter((step) => step.button).slice(0, 30);
}
function playingKey(account) { return String(account || ''); }
function pickPlayingPhrase(value) {
  const choices = String(value || '').split('|').map((item) => item.trim()).filter(Boolean);
  return choices.length ? choices[Math.floor(Math.random() * choices.length)] : '';
}
function componentLabel(component) { const label = component?.label || component?.data?.label || ''; const emoji = component?.emoji || component?.data?.emoji; const emojiName = typeof emoji === 'string' ? emoji : emoji?.name || emoji?.id || ''; return `${String(label).trim()} ${String(emojiName).trim()}`.trim(); }
function messageButtons(message) { return (message?.components || []).flatMap((row) => row?.components || []).filter((component) => String(component?.type || '').toUpperCase() === 'BUTTON' || component?.type === 2); }
function normalizePlayingButton(value) { return String(value || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase(); }
async function dispatchPlayingButton(message, customId, details) {
  let interaction;
  try { interaction = message.clickButton(customId); } catch (error) { const messageText = error.message || String(error); const rateLimited = error.status === 429 || /429|rate.?limit|too many requests/i.test(messageText); logPlayingEvent(rateLimited ? 'safety.rate-limited' : 'button.click.failed', { ...details, error: messageText }); return { ok: false, skip: true, rateLimited, error: messageText }; }
  const response = await Promise.race([
    Promise.resolve(interaction).then(() => ({ responded: true })).catch((error) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 1500)),
  ]);
  if (response.timedOut) { logPlayingEvent('button.click.no-response', { ...details, error: 'No response from Application; interaction was dispatched' }); return { ok: true, noResponse: true }; }
  if (response.error) { const error = response.error.message || String(response.error); const rateLimited = response.error.status === 429 || /429|rate.?limit|too many requests/i.test(error); logPlayingEvent(rateLimited ? 'safety.rate-limited' : 'button.click.failed', { ...details, error }); return { ok: false, skip: true, rateLimited, error }; }
  return { ok: true, responded: true };
}
async function findPlayingButton(channel, session, step) {
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return null;
  const entries = [...messages.values()].sort((a, b) => Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0));
  session.lastScan = entries.slice(0, 10).map((message) => ({ messageId: String(message.id), labels: messageButtons(message).map(componentLabel).filter(Boolean) }));
  const candidates = entries.filter((message) => !session.lastActionAt || Number(message.createdTimestamp || 0) > Number(session.lastActionAt));
  const sameMessage = session.lastMessageId ? entries.filter((message) => String(message.id) === String(session.lastMessageId)) : [];
  const requestedButtons = (step.buttons || [step.button]).map(normalizePlayingButton).filter(Boolean);
  // Every configured value is an explicit target. Never reinterpret a label
  // as permission to click an unrelated button.
  const explicitButtons = requestedButtons;
  for (const message of [...candidates, ...sameMessage.filter((message) => !candidates.includes(message))]) {
    if (step.messageId && String(message.id) !== step.messageId) continue;
    for (const component of messageButtons(message)) {
      const customId = String(component.customId ?? component.custom_id ?? '').trim();
      if (step.customId && customId !== step.customId) continue;
      const label = componentLabel(component);
      const rawLabel = component?.label || component?.data?.label || '';
      const normalizedLabel = normalizePlayingButton(label);
      const normalizedRawLabel = normalizePlayingButton(rawLabel);
      const labelWithoutLeadingEmoji = normalizedRawLabel.replace(/^(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]\s*)+/u, '').trim();
      // Never use substring matching here: with buttons such as "Join",
      // "Join now", and "Re-join", a partial match can click the wrong one.
      const explicitMatch = explicitButtons.some((wanted) => normalizedRawLabel === wanted || normalizedLabel === wanted || labelWithoutLeadingEmoji === wanted);
      if (!step.customId && !explicitMatch) continue;
      if (component.disabled || !customId) continue;
      const key = `${message.id}:${customId}`;
      return { message, customId, key, label };
    }
  }
  return null;
}
async function findAnyPlayingButton(channel, session) {
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return null;
  const entries = [...messages.values()].sort((a, b) => Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0));
  session.lastScan = entries.slice(0, 10).map((message) => ({ messageId: String(message.id), labels: messageButtons(message).map(componentLabel).filter(Boolean) }));
  const candidates = entries.filter((message) => !session.lastActionAt || Number(message.createdTimestamp || 0) > Number(session.lastActionAt));
  const sameMessage = session.lastMessageId ? entries.filter((message) => String(message.id) === String(session.lastMessageId)) : [];
  const orderedMessages = [...candidates, ...sameMessage.filter((message) => !candidates.includes(message))];
  for (const message of orderedMessages) {
    for (const component of messageButtons(message)) {
      const customId = String(component.customId ?? component.custom_id ?? '').trim();
      if (component.disabled || !customId) continue;
      const key = `${message.id}:${customId}`;
      if (key === session.lastActionKey) continue;
      const label = componentLabel(component);
      const rawLabel = component?.label || component?.data?.label || '';
      const normalizedLabel = normalizePlayingButton(label);
      const normalizedRawLabel = normalizePlayingButton(rawLabel);
      const labelWithoutLeadingEmoji = normalizedRawLabel.replace(/^(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]\s*)+/u, '').trim();
      const stepIndex = session.steps.findIndex((step) => {
        if (step.customId) return customId === step.customId;
        const requested = (step.buttons || [step.button]).map(normalizePlayingButton).filter(Boolean);
        return requested.some((wanted) => normalizedRawLabel === wanted || normalizedLabel === wanted || labelWithoutLeadingEmoji === wanted);
      });
      if (stepIndex >= 0) return { message, customId, key, label, step: session.steps[stepIndex], stepIndex };
    }
  }
  return null;
}
function stopPlayingSession(account, reason = 'manual') { const session = playingSessions.get(playingKey(account)); if (!session) return false; session.active = false; session.status = 'stopped'; session.startDelayMs = 0; session.runToken = Number(session.runToken || 0) + 1; clearTimeout(session.timer); session.timer = null; persistPlayingSessions(); logPlayingEvent('stopped', { account, reason }); return true; }
function skipPlayingStep(session, step, stepIndex, found, details = {}) { session.lastActionAt = Date.now(); if (found?.message?.id) session.lastMessageId = String(found.message.id); session.currentIndex = (stepIndex + 1) % session.steps.length; session.lastAction = { button: step.button, phrase: null, skipped: true, clickFailed: true, error: details.error || '', at: Date.now() }; return { ok: true, skipped: true, clickFailed: true, button: step.button, error: details.error || '' }; }
async function sendPlayingPhrase(session, canContinue = () => true) {
  const entry = clients.get(session.account); const client = entry?.client;
  if (!client) return { ok: false, error: 'Account is not connected' };
  const safety = playingSafety.get(session.account) || 0; if (Date.now() < safety) { const waitMs = safety - Date.now(); logPlayingEvent('safety.cooldown', { account: session.account, waitMs }); return { ok: false, waiting: true, safety: true, error: `Safety cooldown ${Math.ceil(waitMs / 1000)}s` }; }
  const channel = await client.channels?.fetch?.(session.channelId).catch?.(() => null);
  if (!channel?.messages?.fetch) return { ok: false, error: 'Text channel is not available for this account' };
  const found = await findAnyPlayingButton(channel, session);
  const step = found?.step;
  const stepIndex = found?.stepIndex ?? 0;
  if (!found) { const available = session.lastScan?.flatMap((item) => item.labels).filter(Boolean).slice(0, 20) || []; logPlayingEvent('button.waiting', { account: session.account, requested: session.steps.map((item) => item.button), available }); return { ok: false, waiting: true, error: 'Waiting for any configured button', available }; }
  if (!canContinue()) return { ok: false, stopped: true, error: 'Playing session stopped before click' };
  logPlayingEvent('button.click.started', { account: session.account, requested: step.button, label: found.label, messageId: String(found.message.id), customId: found.customId });
  const click = await dispatchPlayingButton(found.message, found.customId, { account: session.account, requested: step.button, label: found.label, messageId: String(found.message.id), customId: found.customId });
  session.lastActionKey = found.key;
  playingSafety.set(session.account, Date.now() + (click.rateLimited ? 15000 : PLAYING_MIN_INTERACTION_GAP_MS));
  if (!click.ok) return skipPlayingStep(session, step, stepIndex, found, { error: `Button "${step.button}" click failed: ${click.error}` });
  if (click.noResponse) return skipPlayingStep(session, step, stepIndex, found, { error: 'No response from Application' });
  logPlayingEvent('button.click.completed', { account: session.account, requested: step.button, label: found.label, messageId: String(found.message.id), customId: found.customId });
  session.lastActionAt = Date.now(); session.lastMessageId = String(found.message.id);
  logPlayingEvent('button.found', { account: session.account, button: step.button, label: found.label, messageId: String(found.message.id) });
  const phrase = pickPlayingPhrase(step.phrase);
  if (!phrase) {
    session.currentIndex = (stepIndex + 1) % session.steps.length;
    session.lastAction = { button: step.button, phrase: null, skipped: true, at: Date.now() };
    return { ok: true, button: step.button, skipped: true };
  }
  if (!canContinue()) return { ok: false, stopped: true, error: 'Playing session stopped before message' };
  logPlayingEvent('phrase.send.started', { account: session.account, phrase, button: step.button });
  try {
    await channel.send(phrase);
  } catch (error) {
    // Sending the optional follow-up phrase must never stop the Playing loop.
    // The button action already happened, so record the failure, advance the
    // scenario, and let the next scheduled run try the next configured button.
    const messageText = error.message || String(error);
    const rateLimited = error.status === 429 || /429|rate.?limit|too many requests/i.test(messageText);
    logPlayingEvent(rateLimited ? 'safety.rate-limited' : 'phrase.send.failed', { account: session.account, phrase, button: step.button, error: messageText });
    if (rateLimited) playingSafety.set(session.account, Date.now() + 15000);
    session.currentIndex = (stepIndex + 1) % session.steps.length;
    session.lastAction = { button: step.button, phrase, phraseSkipped: true, messageFailed: true, rateLimited, error: messageText, at: Date.now() };
    return { ok: true, skipped: true, phraseSkipped: true, messageFailed: true, rateLimited, button: step.button, error: `Message skipped: ${messageText}` };
  }
  logPlayingEvent('phrase.send.completed', { account: session.account, phrase, button: step.button });
  session.currentIndex = (stepIndex + 1) % session.steps.length;
  session.lastAction = { button: step.button, phrase, noResponse: !!click.noResponse, at: Date.now() };
  return { ok: true, button: step.button, phrase, noResponse: !!click.noResponse };
}
function schedulePlaying(session, restoreDelayMs = null) {
  const run = async () => {
    if (!session.active || !playingSessions.has(session.account)) return;
    const runToken = Number(session.runToken || 0);
    const canContinue = () => session.active && Number(session.runToken || 0) === runToken;
    session.running = true;
    try { session.status = 'running'; session.lastResult = await withAccountLock(session.account, () => sendPlayingPhrase(session, canContinue)); if (session.lastResult?.stopped) return; logPlayingEvent(session.lastResult.skipped ? 'action.skipped' : session.lastResult.ok ? 'action.completed' : session.lastResult.waiting ? 'action.waiting' : 'action.failed', { account: session.account, result: session.lastResult, step: session.steps[session.currentIndex % session.steps.length]?.button }); }
    catch (error) { session.lastResult = { ok: false, error: error.message || String(error) }; }
    finally { session.running = false; if (session.lastResult?.fatal) { session.active = false; session.status = 'error'; logPlayingEvent('paused', { account: session.account, reason: session.lastResult.error }); } else if (session.lastResult?.waiting) session.status = 'waiting'; session.nextAt = Date.now() + session.intervalMs; if (session.active && canContinue()) session.timer = setTimeout(run, session.intervalMs); persistPlayingSessions(); }
  };
  session.runToken = Number(session.runToken || 0);
  const delay = restoreDelayMs === null ? Number(session.startDelayMs || 250) : restoreDelayMs;
  session.timer = setTimeout(run, Math.max(0, delay));
}
for (const saved of loadPlayingSessions()) {
  if (saved?.account && saved?.channelId && Array.isArray(saved.steps) && saved.steps.length) {
    // Restore the persisted state exactly. A manually stopped session must stay stopped
    // after a server restart; only an explicit Start/Restart action may activate it again.
    const session = { ...saved, active: saved.active === true, running: false, timer: null, runToken: Number(saved.runToken || 0) };
    playingSessions.set(playingKey(session.account), session);
    if (session.active) {
      const savedNextAt = Number(session.nextAt);
      const restoreDelay = Number.isFinite(savedNextAt) ? savedNextAt - Date.now() : 250;
      schedulePlaying(session, restoreDelay);
    }
  }
}
function startAllPlayingSessions(reason = 'discord-start') {
  const results = [];
  for (const session of playingSessions.values()) {
    if (session.active) {
      results.push({ account: session.account, ok: true, alreadyActive: true });
      continue;
    }
    session.active = true;
    session.status = 'starting';
    session.startDelayMs = 0;
    session.updatedAt = Date.now();
    schedulePlaying(session);
    results.push({ account: session.account, ok: true });
  }
  persistPlayingSessions();
  logPlayingEvent('bulk-started', { reason, accounts: results.map((item) => item.account) });
  return { results, started: results.filter((item) => !item.alreadyActive).length, alreadyActive: results.filter((item) => item.alreadyActive).length };
}
function stopAllPlayingSessions(reason = 'discord-stop') {
  const accounts = [...playingSessions.keys()];
  const results = accounts.map((account) => ({ account, ok: stopPlayingSession(account, reason) }));
  logPlayingEvent('bulk-stopped', { reason, accounts });
  return { results, stopped: results.filter((item) => item.ok).length };
}
function playingCommandText(message) {
  const prefix = String(process.env.DISCORD_COMMAND_PREFIX || '').trim();
  const content = String(message?.content || '').trim();
  if (prefix && !content.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) return '';
  return (prefix ? content.slice(prefix.length) : content).trim().toLocaleLowerCase();
}
const handledPlayingCommands = new Set();
async function handlePlayingDiscordCommand(client, message) {
  const command = playingCommandText(message);
  if (!['start', 'stop'].includes(command)) return false;
  const configuredChannel = String(process.env.DISCORD_COMMAND_CHANNEL_ID || '').trim();
  if (configuredChannel && String(message.channel?.id || '') !== configuredChannel) return false;
  const owners = String(process.env.DISCORD_COMMAND_OWNERS || '')
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const authorId = String(message.author?.id || '');
  // An explicit allow-list is required. Never fall back to the connected
  // account, because every connected account can receive the same command.
  if (!authorId || !owners.includes(authorId)) return false;
  const messageKey = String(message.id || '');
  if (messageKey && handledPlayingCommands.has(messageKey)) return false;
  if (messageKey) {
    handledPlayingCommands.add(messageKey);
    if (handledPlayingCommands.size > 1000) handledPlayingCommands.delete(handledPlayingCommands.values().next().value);
  }
  const result = command === 'start' ? startAllPlayingSessions() : stopAllPlayingSessions();
  try {
    await message.react?.('✅');
  } catch (error) { console.warn('[playing-command] unable to add confirmation reaction:', error.message); }
  return true;
}
function cleanChannelIds(channelIds) {
  if (!Array.isArray(channelIds)) return [];
  return [...new Set(channelIds.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 500);
}
function randomRotationTargets(accounts, channels, currentChannelFor) {
  const remainingAccounts = [...accounts].sort(() => Math.random() - 0.5);
  const usedTargets = new Set();
  const targets = new Map();
  for (const name of remainingAccounts) {
    const current = currentChannelFor(name);
    const available = channels.filter((channel) => channel !== current && !usedTargets.has(channel));
    const fallback = channels.filter((channel) => channel !== current);
    const choices = available.length ? available : fallback.length ? fallback : channels;
    const target = choices[Math.floor(Math.random() * choices.length)];
    targets.set(name, target);
    usedTargets.add(target);
  }
  return targets;
}
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length); let cursor = 0;
  const run = async () => { while (true) { const index = cursor++; if (index >= items.length) return; results[index] = await worker(items[index], index); } };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
  return results;
}
function summary(results) {
  const okCount = results.filter((item) => item?.ok === true && !item?.skipped).length;
  const skipped = results.filter((item) => item?.skipped === true).length;
  const failed = results.filter((item) => item?.ok !== true && !item?.skipped).length;
  const retries = results.reduce((total, item) => total + Number(item?.retries || 0), 0);
  return { total: results.length, ok: okCount, skipped, failed, retries };
}
function retryableError(error) {
  const text = String(error?.error || error?.message || '').toLowerCase();
  return /timeout|timed out|did not confirm|gateway not ready|no active gateway|web.?rtc|media transport|temporar|rate.?limit|connection|socket|network/.test(text);
}
async function withResultRetry(worker, maxRetries = 2) {
  let last = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try { last = await worker(attempt); } catch (error) { last = { ok: false, error: error?.message || String(error) }; }
    if (last?.ok === true || !retryableError(last)) return { ...last, attempts: attempt + 1, retries: attempt };
    if (attempt < maxRetries) {
      const retryDelay = retryableError(last) && /web.?rtc|media transport/i.test(String(last?.error || '')) ? 1000 * (2 ** attempt) : 250 * (2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
  return { ...last, attempts: maxRetries + 1, retries: maxRetries };
}
async function waitForMediaSettle(next, current) {
  if ((next?.selfStream || next?.selfVideo) && current?.channelId) await new Promise((resolve) => setTimeout(resolve, MEDIA_SETTLE_DELAY_MS));
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
function stopSyntheticStream(name, { leaveVoice = false } = {}) {
  const active = syntheticStreams.get(name);
  if (active) {
    try { active.controller?.abort?.(); } catch {}
    try { active.sourceProcess?.kill?.('SIGTERM'); } catch {}
    try { active.streamer?.stopStream?.(); } catch {}
    try { active.streamer?.signalVideo?.(false); } catch {}
    try { active.dispatcher?.destroy?.(); } catch {}
    try { active.streamConnection?.disconnect?.(); } catch {}
  }
  syntheticStreams.delete(name);
  if (leaveVoice) {
    const streamer = mediaStreamers.get(name);
    try { streamer?.leaveVoice?.(); } catch {}
    mediaStreamers.delete(name);
  }
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
  const target = validateMediaTarget(client, guildId, session.channelId);
  if (!target.ok) return { ok: false, error: target.error };
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
    const confirmed = await sendVoiceOpConfirmed(client, guildId, session.channelId, mediaKind === 'camera'
      ? { selfMute: !!session.selfMute, selfDeaf: false, selfVideo: true, selfStream: false }
      : { selfMute: !!session.selfMute, selfDeaf: false, selfVideo: false, selfStream: true }, 3000);
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
  const saved = voiceSessions.get(sessionKey(name, guildId)) || {};
  const observed = client ? readGatewayVoiceState(client, guildId) : null;
  const session = { ...saved, ...(observed || {}) };
  for (const key of ['selfMute', 'selfDeaf', 'selfVideo', 'selfStream']) if (typeof observed?.[key] !== 'boolean' && typeof saved?.[key] === 'boolean') session[key] = saved[key];
  if (!client || !session?.channelId) return { ok: false, error: 'Account is not in a voice channel' };
  const existing = syntheticStreams.get(name);
  if (existing) {
    if (existing.mediaKind === mediaKind && existing.channelId === session.channelId) return { ok: true, alreadyActive: true };
    stopSyntheticStream(name);
  }
  const channel = client.guilds?.cache?.get?.(guildId)?.channels?.cache?.get?.(session.channelId);
  if (!channel) return { ok: false, error: 'Voice channel is not available for streaming' };
  const startedAt = Date.now();
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let streamer;
    let controller;
    let source;
    let createdStreamer = false;
    try {
      const { Streamer, playStream } = await loadVideoStreamModule();
      streamer = mediaStreamers.get(name);
      if (!streamer) {
        streamer = new Streamer(client);
        mediaStreamers.set(name, streamer);
        createdStreamer = true;
      }
      streamer.signalVideo = (enabled) => streamer.sendOpcode(4, {
        guild_id: guildId,
        channel_id: session.channelId,
        self_mute: !!session.selfMute,
        self_deaf: false,
        self_video: !!enabled,
      });
      const mediaConnection = streamer.voiceConnection;
      if (mediaConnection && (String(mediaConnection.guildId) !== String(guildId) || String(mediaConnection.channelId) !== String(session.channelId))) {
        try { streamer.leaveVoice(); } catch {}
      }
      if (!streamer.voiceConnection) {
        logMediaEvent('info', 'media.join.start', { account: name, guildId, channelId: session.channelId, mediaKind, attempt });
        await withTimeout(streamer.joinVoice(guildId, session.channelId), 10000, 'Dedicated media voice connection timed out after 10 seconds');
      } else {
        logMediaEvent('info', 'media.join.reuse', { account: name, guildId, channelId: session.channelId, mediaKind, attempt });
      }
      controller = new AbortController();
      source = createBlackMediaSource();
      const active = { streamer, controller, sourceProcess: source.sourceProcess, guildId, channelId: session.channelId, mediaKind, startedAt };
      syntheticStreams.set(name, active);
      const task = playStream(source.stream, streamer, { type: mediaKind, format: 'nut', width: 640, height: 360, frameRate: 15 }, controller.signal);
      active.task = task;
      task.then(() => { active.completedAt = Date.now(); if (syntheticStreams.get(name)?.task === task) stopSyntheticStream(name); })
        .catch((error) => logMediaEvent('error', 'media.runtime_failed', { account: name, guildId, channelId: session.channelId, mediaKind, error: error?.message || String(error) }));
      await withTimeout(new Promise((resolve) => {
        const check = () => {
          const voiceReady = streamer.voiceConnection?.webRtcConn?.ready === true;
          const mediaReady = mediaKind === 'camera' || streamer.voiceConnection?.streamConnection?.webRtcConn?.ready === true;
          if (voiceReady && mediaReady) return resolve();
          setTimeout(check, 150);
        };
        check();
      }), 6000, 'WebRTC media transport was not ready');
      if (active.completedAt || syntheticStreams.get(name) !== active) throw new Error('Media transport stopped before activation');
      const mediaState = mediaKind === 'camera'
        ? { selfMute: !!session.selfMute, selfDeaf: false, selfVideo: true, selfStream: false }
        : { selfMute: !!session.selfMute, selfDeaf: false, selfVideo: false, selfStream: true };
      // For Go Live, the library's STREAM_CREATE/STREAM_SERVER_UPDATE flow and
      // the ready stream WebRTC connection are the real Discord confirmation.
      // Do not send a second OP4 with self_stream: Streamer.signalStream() owns
      // that state, and a competing OP4 can cancel/replace the live stream.
      const confirmed = mediaKind === 'camera'
        ? await sendVoiceOpConfirmed(client, guildId, session.channelId, mediaState, 3000)
        // Go Live's stream transport owns the stream flag. Sending a second OP4
        // here used to force selfDeaf=true and could override the selected state.
        : { ok: true, confirmed: true, source: 'stream-transport' };
      if (!confirmed.ok) throw new Error(confirmed.error || 'Discord did not accept media state');
      logMediaEvent('info', 'media.ready', { account: name, guildId, channelId: session.channelId, mediaKind, durationMs: Date.now() - startedAt, attempt });
      return { ok: true };
    } catch (error) {
      lastError = error;
      try { controller?.abort?.(); } catch {}
      try { source?.sourceProcess?.kill?.('SIGTERM'); } catch {}
      try { streamer?.stopStream?.(); } catch {}
      try { streamer?.leaveVoice?.(); } catch {}
      if (syntheticStreams.get(name)?.streamer === streamer) syntheticStreams.delete(name);
      if (createdStreamer && !streamer?.voiceConnection) mediaStreamers.delete(name);
      logMediaEvent('error', 'media.attempt_failed', { account: name, guildId, channelId: session.channelId, mediaKind, attempt, error: error?.message || String(error) });
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  stopSyntheticStream(name);
  return { ok: false, error: lastError?.message || `Unable to start ${mediaKind}` };
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

function taskResultSnapshot(result = {}) {
  return { name: result.name, ok: result.ok === true, error: result.ok === true ? null : (result.error || 'فشل التنفيذ'), channelId: result.channelId || null, attemptedChannels: result.attemptedChannels || [], retries: Number(result.retries || 0), at: Date.now() };
}
function recordTaskResult(task, result) {
  const snapshot = taskResultSnapshot(result);
  task.accountStatus = { ...(task.accountStatus || {}), [snapshot.name]: snapshot };
  task.lastResults = [...(task.lastResults || []).filter((item) => item.name !== snapshot.name), snapshot];
  emitLive('task.account.updated', { id: task.id, taskType: task.type || (task.channels ? 'rotation' : 'cycle'), result: snapshot, nextAt: task.nextAt, currentIdx: task.currentIdx, active: task.active !== false });
  return result;
}
function rotationPreferredChannel(name, task, index = 0, randomTarget = null) {
  if (randomTarget) return randomTarget;
  const current = voiceSessions.get(sessionKey(name, task.guildId));
  // A kicked account has no live session. Rejoin the last confirmed room first;
  // this is different from normal rotation, where the next room is always used.
  if (!current?.channelId && task.accountTargets?.[name]) return task.accountTargets[name];
  const ids = task.channels || [];
  const currentIndex = ids.indexOf(current?.channelId);
  return ids[currentIndex >= 0 ? (currentIndex + 1) % ids.length : (task.currentIdx + index) % ids.length];
}
async function moveRotationAccount(name, task, preferredChannelId, opts = {}) {
  const ids = [...(task.channels || [])];
  if (!ids.length) return { name, ok: false, error: 'No rotation rooms configured' };
  const start = Math.max(0, ids.indexOf(preferredChannelId));
  const ordered = [...ids.slice(start), ...ids.slice(0, start)];
  let last = { name, ok: false, error: 'All rotation rooms failed', attemptedChannels: [] };
  const wasOutsideRoom = !voiceSessions.has(sessionKey(name, task.guildId));
  const mediaVariants = [opts];
  if (opts.selfStream === true) mediaVariants.push({ ...opts, selfStream: false, selfVideo: true });
  else if (opts.selfVideo === true) mediaVariants.push({ ...opts, selfVideo: false, selfStream: true });
  for (const channelId of ordered) {
    for (let mediaIndex = 0; mediaIndex < mediaVariants.length; mediaIndex += 1) {
      const variant = mediaVariants[mediaIndex];
      const result = await withResultRetry(() => moveAccount(name, task.guildId, channelId, variant));
      if (result.ok) {
        task.accountTargets = { ...(task.accountTargets || {}), [name]: channelId };
        return { ...result, attemptedChannels: [...last.attemptedChannels, channelId], mediaFallback: mediaIndex > 0 ? (variant.selfVideo ? 'camera' : 'live') : null, resumedAfterRemoval: wasOutsideRoom };
      }
      last = { ...result, attemptedChannels: [...last.attemptedChannels, channelId], mediaFallback: mediaIndex > 0 ? (variant.selfVideo ? 'camera' : 'live') : last.mediaFallback };
    }
  }
  return last;
}
async function startRotationMediaWithFallback(name, guildId, next) {
  const variants = next.selfStream === true
    ? [{ ...next, selfStream: true, selfVideo: false }, { ...next, selfStream: false, selfVideo: true }]
    : next.selfVideo === true
      ? [{ ...next, selfVideo: true, selfStream: false }, { ...next, selfVideo: false, selfStream: true }]
      : [{ ...next }];
  let last = { ok: false, error: 'Media start failed' };
  for (const variant of variants) {
    const result = await startSyntheticStream(name, guildId, variant.selfStream ? 'go-live' : 'camera');
    if (result.ok) return { ...result, mediaFallback: variant !== variants[0] ? (variant.selfVideo ? 'camera' : 'live') : null, appliedState: variant };
    last = result;
  }
  return last;
}
function stopTasksForAccount(name) {
  stopPlayingSession(name);
  let changed = false;
  for (const [id, task] of rotations.entries()) {
    const before = task.accounts.length;
    task.accounts = task.accounts.filter((item) => item !== name);
    changed ||= before !== task.accounts.length;
    if (!task.accounts.length) { clearInterval(task.timer); rotations.delete(id); emitLive('task.stopped', { id, reason: 'no accounts remaining' }); }
  }
  for (const [id, task] of stateCycles.entries()) {
    const before = task.accounts.length;
    task.accounts = task.accounts.filter((item) => item !== name);
    changed ||= before !== task.accounts.length;
    if (!task.accounts.length) { clearInterval(task.timer); stateCycles.delete(id); emitLive('task.stopped', { id, reason: 'no accounts remaining' }); }
  }
  if (changed) persistAutomationTasks();
}
function rotationControlledAccounts(guildId) {
  const controlled = new Set();
  for (const task of rotations.values()) {
    if (String(task.guildId) !== String(guildId)) continue;
    for (const name of task.accounts || []) controlled.add(name);
  }
  return controlled;
}
function operationKey(name, guildId) { return `${String(name)}__${String(guildId)}`; }
function beginAccountOperation(name, guildId, kind) {
  const key = operationKey(name, guildId);
  const previous = accountOperations.get(key);
  const operation = { key, name: String(name), guildId: String(guildId), kind, generation: (previous?.generation || 0) + 1, cancelled: false, startedAt: Date.now() };
  if (previous) previous.cancelled = true;
  accountOperations.set(key, operation);
  return operation;
}
function operationIsCurrent(operation) { return accountOperations.get(operation.key) === operation && !operation.cancelled; }
function endAccountOperation(operation) { if (accountOperations.get(operation.key) === operation) accountOperations.delete(operation.key); }
function taskConflict(accounts, guildId, type) {
  const conflicts = [];
  const activeTasks = type === 'rotation' ? rotations : stateCycles;
  for (const task of activeTasks.values()) {
    if (String(task.guildId) !== String(guildId)) continue;
    const overlap = accounts.filter((name) => (task.accounts || []).includes(name));
    if (overlap.length) conflicts.push({ id: task.id, accounts: overlap });
  }
  return conflicts;
}
function taskAccountConflicts(accounts, guildId, type) { return taskConflict(accounts, guildId, type).flatMap((item) => item.accounts); }
function linkedRoomRotation(accounts, guildId) {
  return [...rotations.values()].find((task) => String(task.guildId) === String(guildId) && (task.accounts || []).some((name) => accounts.includes(name))) || null;
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
    let verifyTimer = null;
    let attempts = 0;
    const cleanup = () => {
      try { client.ws?.off?.('VOICE_STATE_UPDATE', onWsState); } catch {}
      try { client.off?.('voiceStateUpdate', onJsState); } catch {}
      if (timer) clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
      if (verifyTimer) clearTimeout(verifyTimer);
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
    const cachedStateMatches = () => {
      const state = readGatewayVoiceState(client, guildId);
      if (!state || (channelId != null && String(state.channelId) !== String(channelId))) return false;
      return Object.entries(opts).every(([key, value]) => !['selfMute', 'selfDeaf', 'selfVideo', 'selfStream'].includes(key) || (state[key] !== undefined && !!state[key] === !!value));
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
    const verifyUntilDeadline = () => {
      if (settled) return;
      if (cachedStateMatches()) return finish({ ok: true, confirmed: true, source: 'gateway-cache' });
      if (Date.now() >= deadline) return finish({ ok: false, error: 'Discord did not confirm the voice state in time' });
      verifyTimer = setTimeout(verifyUntilDeadline, 250);
    };
    const deadline = Date.now() + timeoutMs;
    timer = setTimeout(verifyUntilDeadline, 250);

    const send = () => {
      if (settled) return;
      attempts += 1;
      const sent = sendVoiceOp(client, guildId, channelId, opts);
      if (!sent.ok) return finish(sent);
      verifyTimer = setTimeout(() => { if (cachedStateMatches()) finish({ ok: true, confirmed: true, source: 'gateway-cache' }); }, 150);
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
function validateMediaTarget(client, guildId, channelId) {
  const target = validateTarget(client, guildId, channelId);
  if (!target.ok) return target;
  const me = target.guild.members?.me || target.guild.members?.cache?.get?.(client.user?.id) || client.user?.id;
  const permissions = target.channel?.permissionsFor?.(me);
  if (permissions?.has?.('STREAM') === false) return { ok: false, error: 'Missing Stream permission for Camera or Screen Share in this voice channel' };
  return target;
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
        const active = syntheticStreams.get(name);
        if (active && active.guildId === session.guildId && active.channelId === session.channelId) {
          upsertSession(name, session.guildId, session.channelId, { selfMute: session.selfMute, selfDeaf: false, selfVideo: active.mediaKind === 'camera', selfStream: active.mediaKind === 'go-live' });
          continue;
        }
        stopSyntheticStream(name, { leaveVoice: true });
        // The account may have been dragged/kicked by another user. Remove
        // only the stale session; an active room rotation must keep ownership
        // so its next tick can join the account to the next configured room.
        removeSessionsForAccount(name, session.guildId);
        continue;
      }
      const active = syntheticStreams.get(name);
      const observed = { ...actual, selfVideo: active?.mediaKind === 'camera' ? true : actual.selfVideo, selfStream: active?.mediaKind === 'go-live' ? true : actual.selfStream };
      const changed = observed.channelId !== session.channelId || observed.selfMute !== !!session.selfMute || observed.selfDeaf !== !!session.selfDeaf || observed.selfVideo !== !!session.selfVideo || observed.selfStream !== !!session.selfStream;
      if (changed) {
        if (observed.channelId !== session.channelId) stopSyntheticStream(name, { leaveVoice: true });
        upsertSession(name, session.guildId, observed.channelId, observed);
      }
    }
  }
}
async function moveAccount(name, guildId, channelId, opts = {}) {
  return withAccountLock(name, async () => {
    const client = getClient(name);
    if (!client) return { name, ok: false, error: 'Account is not connected' };
    const operation = beginAccountOperation(name, guildId, 'move');
    const target = validateTarget(client, guildId, channelId);
    if (!target.ok) { endAccountOperation(operation); return { name, ok: false, error: target.error }; }
    const saved = voiceSessions.get(sessionKey(name, guildId));
    const observed = readGatewayVoiceState(client, guildId);
    const current = { ...(saved || {}), ...(observed || {}) };
    for (const key of ['selfMute', 'selfDeaf', 'selfVideo', 'selfStream']) if (typeof observed?.[key] !== 'boolean' && typeof saved?.[key] === 'boolean') current[key] = saved[key];
    if (current?.channelId === channelId) return { name, ok: true, alreadyIn: true, channelId };
    const desired = normalizeVoiceState({ ...(current || {}), ...opts });
    if (syntheticStreams.has(name) || mediaStreamers.has(name)) stopSyntheticStream(name, { leaveVoice: true });
    const result = await sendVoiceOpConfirmed(client, guildId, channelId, { ...desired, selfVideo: false, selfStream: false });
    if (!operationIsCurrent(operation)) { endAccountOperation(operation); return { name, ok: false, stale: true, error: 'Voice move was superseded by a newer request' }; }
    if (result.ok) {
      for (const key of [...voiceSessions.keys()]) if (key.startsWith(`${name}__`) && key !== sessionKey(name, guildId)) voiceSessions.delete(key);
      const actual = readGatewayVoiceState(client, guildId);
      upsertSession(name, guildId, channelId, { ...desired, ...(actual || {}), selfVideo: desired.selfVideo, selfStream: desired.selfStream });
      if (desired.selfStream || desired.selfVideo) {
        const media = await startSyntheticStream(name, guildId, desired.selfStream ? 'go-live' : 'camera');
        if (!media.ok) { endAccountOperation(operation); return { name, ok: false, error: media.error, channelId }; }
      }
    }
    endAccountOperation(operation);
    return { name, ok: result.ok, error: result.ok ? null : result.error, channelId };
  });
}

async function connectOne(token, name) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('A Discord token is required');
  let finalName = String(name || '').trim().slice(0, 48);
  const normalizedToken = token.trim();
  const existing = [...clients.entries()].find(([, entry]) => entry.token === normalizedToken);
  if (existing) {
    const existingClient = existing[1].client;
    return { name: existing[0], username: existingClient.user?.tag || existingClient.user?.username || existing[0], displayName: existingClient.user?.globalName || existingClient.user?.username || existing[0], nickname: existingClient.user?.globalName || existingClient.user?.username || existing[0], id: existingClient.user?.id || null, avatar: existingClient.user?.displayAvatarURL?.({ size: 128 }) || null, alreadyConnected: true };
  }
  const client = new Client({ checkUpdate: false, fetchAllMembers: false });
  await client.login(normalizedToken);
  if (!finalName) finalName = String(client.user?.globalName || client.user?.username || `account-${clients.size + 1}`).trim().slice(0, 48);
  if (clients.has(finalName)) {
    stopTasksForAccount(finalName);
    stopSyntheticStream(finalName, { leaveVoice: true });
    try { await clients.get(finalName).client.destroy(); } catch {}
    clients.delete(finalName);
  }
  const entry = { client, token: normalizedToken, savedAt: Date.now(), connectedAt: Date.now(), lastSeenAt: Date.now(), lastError: null };
  clients.set(finalName, entry);
  persistConnectedAccounts();
  const markError = (error) => { entry.lastError = redact(error?.message || String(error || 'Unknown Discord client error')); entry.lastSeenAt = Date.now(); emitLive('account.health.changed', { account: accountHealth(finalName, entry) }); };
  client.on?.('error', markError);
  client.on?.('ready', () => { entry.lastError = null; entry.lastSeenAt = Date.now(); emitLive('account.health.changed', { account: accountHealth(finalName, entry) }); });
  client.on?.('disconnect', () => { entry.lastSeenAt = Date.now(); emitLive('account.health.changed', { account: accountHealth(finalName, entry) }); });
  client.on?.('messageCreate', (message) => { handlePlayingDiscordCommand(client, message).catch((error) => console.warn('[playing-command] failed:', error.message)); });
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
    displayName: client.user?.globalName || client.user?.username || finalName,
    nickname: client.user?.globalName || client.user?.username || finalName,
    id: client.user?.id || null,
    avatar: client.user?.displayAvatarURL?.({ size: 128 }) || null,
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
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'; const flags = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  const cookies = [`${AUTH_COOKIE}=${encodeURIComponent(value)}; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}; ${flags}`];
  if (deviceCookie) cookies.push(`${CLIENT_DEVICE_COOKIE}=${encodeURIComponent(deviceCookie)}; Max-Age=${Math.floor(CLIENT_DEVICE_TTL_MS / 1000)}; ${flags}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', cookies);
  return ok(res, { authenticated: true, required: true, role });
});
app.get('/api/auth/status', (req, res) => ok(res, { authenticated: hasValidAuth(req), role: req.authRole || null, clientBound: Boolean(readClientBinding()) }));

const requestBuckets = new Map();
const authAttempts = new Map();
function originGuard(req, res, next) {
  if (req.method === 'GET' || req.path === '/auth') return next();
  if (req.get('x-voice-studio') !== '1') return res.status(403).json({ success: false, error: 'Invalid request context' });
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
app.get('/version', (_req, res) => res.json({ success: true, version: getBuildVersion() }));
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
      voice: voice ? { guildId: voice.guildId, guildName: guild?.name || voice.guildId, guildIcon: guild?.iconURL?.({ size: 64 }) || null, channelId: voice.channelId, channelName: channel?.name || voice.channelId, selfMute: !!voice.selfMute, selfDeaf: !!voice.selfDeaf, selfVideo: !!voice.selfVideo, selfStream: !!voice.selfStream } : null,
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
      results[index] = await withResultRetry(async () => {
        try { return { ok: true, ...(await connectOne(item.token, item.name || `account-${index + 1}`)) }; }
        catch (error) { return { ok: false, name: item.name || `account-${index + 1}`, error: error.message }; }
      });
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
  stopSyntheticStream(name, { leaveVoice: true });
  try { await entry.client.destroy(); } catch {}
  clients.delete(name);
  persistConnectedAccounts();
  emitLive('account.disconnected', { name });
  return ok(res, { name });
});
app.post('/api/discord/disconnect-bulk', async (req, res) => {
  const names = cleanAccounts(req.body?.accounts);
  if (!names.length) return fail(res, new Error('Select at least one account'), 400);
  const results = await mapWithConcurrency(names, 8, (name) => withResultRetry(async () => {
      const entry = clients.get(name);
      if (!entry) return { name, ok: false, error: 'Account is not connected' };
      stopTasksForAccount(name);
      stopSyntheticStream(name, { leaveVoice: true });
      removeSessionsForAccount(name);
      try { await entry.client.destroy(); } catch (error) { return { name, ok: false, error: error.message }; }
      clients.delete(name);
      emitLive('account.disconnected', { name });
      return { name, ok: true };
    }));
  persistConnectedAccounts();
  return ok(res, { results, summary: summary(results) });
});
app.post('/api/discord/disconnect-all', async (_req, res) => {
  for (const name of clients.keys()) { stopTasksForAccount(name); stopSyntheticStream(name, { leaveVoice: true }); }
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
app.get('/api/playing/sessions', (_req, res) => ok(res, { sessions: [...playingSessions.values()].map(({ timer, ...item }) => item), active: [...playingSessions.values()].filter((item) => item.active).length }));
app.get('/api/playing/channels', (req, res) => {
  const channels = new Map();
  for (const [account, entry] of clients.entries()) {
    for (const guild of entry.client.guilds?.cache?.values?.() || []) {
      for (const channel of guild.channels?.cache?.values?.() || []) {
        const isText = channel?.isText?.() || [0, 5, 10, 11, 12, 15].includes(Number(channel?.type));
        if (!isText || !channel.id || channel.isThread?.()) continue;
        const key = String(channel.id); const permissions = channel.permissionsFor?.(entry.client.user?.id);
        if (permissions?.has?.('VIEW_CHANNEL') === false || permissions?.has?.('READ_MESSAGE_HISTORY') === false) continue;
        if (!channels.has(key)) channels.set(key, { id: key, name: channel.name || key, guildId: guild.id, guildName: guild.name, accounts: [] });
        channels.get(key).accounts.push(account);
      }
    }
  }
  const selectedGuild = String(req.query?.guildId || '').trim();
  const filtered = [...channels.values()].filter((channel) => !selectedGuild || channel.guildId === selectedGuild);
  const guilds = [...new Map(filtered.map((channel) => [channel.guildId, { id: channel.guildId, name: channel.guildName }])).values()].sort((a, b) => a.name.localeCompare(b.name));
  return ok(res, { channels: filtered.sort((a, b) => a.name.localeCompare(b.name)), guilds });
});
app.get('/api/playing/events', (_req, res) => ok(res, { events: readPlayingEvents() }));
app.post('/api/playing/preview', (req, res) => { const steps = cleanPlayingSteps(req.body?.steps); if (!steps.length) return fail(res, new Error('At least one complete action is required'), 400); return ok(res, { preview: steps.map((step, index) => ({ order: index + 1, button: step.button, phrase: step.phrase || null, messageId: step.messageId || 'auto-detect', customId: step.customId || 'auto-detect' })) }); });
app.post('/api/playing/save', async (req, res) => {
  const account = String(req.body?.account || '').trim();
  const channelId = String(req.body?.channelId || '').trim();
  const channelName = String(req.body?.channelName || '').trim().slice(0, 120);
  const guildId = String(req.body?.guildId || '').trim().slice(0, 40);
  const scenarioName = String(req.body?.scenarioName || 'Playing scenario').trim().slice(0, 100) || 'Playing scenario';
  const steps = cleanPlayingSteps(req.body?.steps);
  const intervalMs = Math.max(1500, Math.min(24 * 60 * 60 * 1000, Number(req.body?.intervalMs || 5000)));
  if (!account || !channelId || steps.length < 1) return fail(res, new Error('account, channelId and at least one button action are required'), 400);
  const entry = clients.get(account);
  if (!entry) return fail(res, new Error('Account is not connected'), 400);
  const channel = await entry.client.channels?.fetch?.(channelId).catch?.(() => null);
  if (!channel?.messages?.fetch) return fail(res, new Error(`Account "${account}" cannot access the selected text room`), 400);
  const existing = playingSessions.get(account);
  const wasActive = !!existing?.active;
  const nextRunToken = Number(existing?.runToken || 0) + 1;
  if (existing) { existing.active = false; existing.runToken = nextRunToken; clearTimeout(existing.timer); existing.timer = null; }
  const session = { account, scenarioName, guildId: guildId || existing?.guildId || '', channelId, channelName: channelName || channelId, steps, intervalMs, currentIndex: existing?.currentIndex || 0, active: wasActive, status: wasActive ? 'running' : (existing?.status || 'saved'), runToken: nextRunToken, createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now() };
  if (existing) session.lastAction = existing.lastAction;
  playingSessions.set(account, session); if (session.active) schedulePlaying(session); persistPlayingSessions();
  return ok(res, { session: { ...session, timer: undefined } });
});
app.post('/api/playing/start', (req, res) => {
  const accounts = cleanAccounts(req.body?.accounts);
  const accountDelayMs = Math.max(0, Math.min(600000, Number(req.body?.accountDelayMs || 0)));
  if (!accounts.length) return fail(res, new Error('Select at least one account'), 400);
  const results = accounts.map((account, index) => { const session = playingSessions.get(account); if (!session) return { account, ok: false, error: 'Save a Playing setup for this account first' }; if (session.active) return { account, ok: true, alreadyActive: true }; session.active = true; session.startDelayMs = accountDelayMs * index; session.updatedAt = Date.now(); schedulePlaying(session); return { account, ok: true, startDelayMs: session.startDelayMs }; });
  persistPlayingSessions(); return ok(res, { results, sessions: [...playingSessions.values()].map(({ timer, ...item }) => item) });
});
app.post('/api/playing/stop', (req, res) => {
  const accounts = cleanAccounts(req.body?.accounts);
  if (!accounts.length) return fail(res, new Error('Select at least one account'), 400);
  return ok(res, { results: accounts.map((account) => ({ account, ok: stopPlayingSession(account), alreadyStopped: !playingSessions.has(account) })) });
});
app.post('/api/playing/emergency-stop', (_req, res) => { const accounts = [...playingSessions.keys()]; accounts.forEach((account) => stopPlayingSession(account, 'emergency-stop')); logPlayingEvent('emergency-stop', { accounts }); return ok(res, { stopped: accounts.length }); });
app.post('/api/playing/delete', (req, res) => {
  const account = String(req.body?.account || '').trim();
  if (!account) return fail(res, new Error('account is required'), 400);
  stopPlayingSession(account); playingSessions.delete(account); persistPlayingSessions(); return ok(res);
});

app.post('/api/voice/join', async (req, res) => {
  const accounts = cleanAccounts(req.body?.accounts);
  const { guildId, channelId, selfMute = false, selfDeaf = false } = req.body || {};
  if (!accounts.length || !guildId || !channelId) return fail(res, new Error('accounts, guildId and channelId are required'), 400);
  if (typeof selfMute !== 'boolean' || typeof selfDeaf !== 'boolean') return fail(res, new Error('Mute values must be boolean'), 400);
  const results = await mapWithConcurrency(accounts, 8, (name) => withResultRetry(() => moveAccount(name, guildId, channelId, { selfMute, selfDeaf })));
  emitLive('operation.completed', { operation: 'join', results, summary: summary(results) });
  return ok(res, { results, summary: summary(results) });
});
app.post('/api/voice/leave', async (req, res) => {
  const accounts = cleanAccounts(req.body?.accounts);
  const guildId = String(req.body?.guildId || '');
  if (!accounts.length || !guildId) return fail(res, new Error('accounts and guildId are required'), 400);
  const results = await mapWithConcurrency(accounts, 8, (name) => withResultRetry(() => withAccountLock(name, async () => {
    const client = getClient(name);
    if (!client) return { name, ok: false, error: 'Account is not connected' };
    const current = readGatewayVoiceState(client, guildId) || voiceSessions.get(sessionKey(name, guildId));
    // A manual leave only removes the current room session. Keep the account
    // in its active rotation so the next tick can join it again.
    if (!current?.channelId) { removeSessionsForAccount(name, guildId); return { name, ok: true, alreadyLeft: true }; }
    stopSyntheticStream(name, { leaveVoice: true });
    const result = await sendVoiceOpConfirmed(client, guildId, null, {}, 5000);
    if (result.ok) removeSessionsForAccount(name, guildId);
    return { name, ok: result.ok, error: result.ok ? null : result.error };
  })));
  emitLive('operation.completed', { operation: 'leave', results, summary: summary(results) });
  return ok(res, { results, summary: summary(results) });
});
app.post('/api/voice/state', async (req, res) => {
  const accounts = cleanAccounts(req.body?.accounts);
  const { guildId, selfMute, selfDeaf, selfVideo, selfStream } = req.body || {};
  if (!accounts.length || !guildId) return fail(res, new Error('accounts and guildId are required'), 400);
  for (const value of [selfMute, selfDeaf, selfVideo, selfStream]) if (value !== undefined && typeof value !== 'boolean') return fail(res, new Error('Voice state values must be boolean'), 400);
  if (selfDeaf === true && (selfVideo === true || selfStream === true)) return fail(res, new Error('Video or screen share cannot be enabled while deafened'), 400);
  const rotationAccounts = rotationControlledAccounts(guildId);
  const results = await mapWithConcurrency(accounts, 8, (name) => withResultRetry(() => withAccountLock(name, async () => {
    if (rotationAccounts.has(name)) return { name, ok: true, skipped: true, reason: 'Account is controlled by an active rotation' };
    const operation = beginAccountOperation(name, guildId, 'state');
    const operationStartedAt = Date.now();
    const mediaKind = selfStream !== undefined ? 'stream' : selfVideo !== undefined ? 'camera' : 'voice-state';
    const client = getClient(name);
    const observed = readGatewayVoiceState(client, guildId);
    const current = {
      ...(observed || voiceSessions.get(sessionKey(name, guildId)) || {}),
      selfStream: syntheticStreams.has(name) || !!observed?.selfStream,
      selfVideo: syntheticStreams.get(name)?.mediaKind === 'camera' || !!observed?.selfVideo,
    };
    if (!client) { endAccountOperation(operation); return { name, ok: false, error: 'Account is not connected' }; }
    if (!current?.channelId) { endAccountOperation(operation); return { name, ok: false, error: 'Account is not in a voice channel' }; }
    const enablingMedia = selfVideo === true || selfStream === true;
    const next = {
      selfMute: selfMute !== undefined ? selfMute : !!current.selfMute,
      selfDeaf: selfDeaf !== undefined ? selfDeaf : enablingMedia ? false : !!current.selfDeaf,
      selfVideo: selfVideo !== undefined ? selfVideo : !!current.selfVideo,
      selfStream: selfStream !== undefined ? selfStream : !!current.selfStream,
    };
    if (next.selfDeaf && (next.selfVideo || next.selfStream)) { endAccountOperation(operation); return { name, ok: false, error: 'Video or screen share cannot be enabled while deafened' }; }
    // Use the same settle window as state rotation before touching media. The
    // account lock above prevents concurrent operations for this account, and
    // rotationControlledAccounts prevents Quick controls from racing a room
    // rotation in the same guild.
    await waitForMediaSettle(next, current);
    let result;
    if (next.selfStream) result = await startSyntheticStream(name, guildId, 'go-live');
    else if (next.selfVideo) result = await startSyntheticStream(name, guildId, 'camera');
    else result = await sendVoiceOpConfirmed(client, guildId, current.channelId, next, 6000);
    if (!operationIsCurrent(operation)) { endAccountOperation(operation); return { name, ok: false, stale: true, error: 'Voice operation was superseded by a newer request' }; }
    if (result.ok) {
      if (!next.selfStream && !next.selfVideo && (current.selfStream || current.selfVideo)) stopSyntheticStream(name);
      const actual = readGatewayVoiceState(client, guildId);
      Object.assign(current, actual || {}, next, { selfStream: !!next.selfStream, selfVideo: !!next.selfVideo, updatedAt: Date.now() });
      persistSessions();
    }
    const output = { name, ok: result.ok, error: result.ok ? null : result.error };
    logMediaEvent(result.ok ? 'info' : 'error', `${mediaKind}.${result.ok ? 'confirmed' : 'failed'}`, { account: name, guildId, channelId: current.channelId, durationMs: Date.now() - operationStartedAt, error: output.error || undefined });
    endAccountOperation(operation);
    return output;
  })));
  emitLive('operation.completed', { operation: 'state', results, summary: summary(results) });
  return ok(res, { results, summary: summary(results) });
});
app.post('/api/voice/join-all', async (req, res) => {
  const { guildId, channelId, selfMute = false, selfDeaf = false } = req.body || {};
  const accounts = [...clients.keys()];
  if (!guildId || !channelId) return fail(res, new Error('guildId and channelId are required'), 400);
  const results = await mapWithConcurrency(accounts, 8, (name) => withResultRetry(() => moveAccount(name, guildId, channelId, { selfMute, selfDeaf })));
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
  const conflicts = taskAccountConflicts(accounts, guildId, 'rotation');
  if (conflicts.length) return fail(res, new Error(`These accounts already have a room rotation: ${conflicts.join(', ')}`), 409);
  const initialTargets = randomOrder
    ? randomRotationTargets(accounts, channelIds, (name) => voiceSessions.get(sessionKey(name, guildId))?.channelId)
    : null;
  const initialTask = { guildId, channels: channelIds, type: 'rotation', accountTargets: {} };
  const initial = await mapWithConcurrency(accounts, 8, (name, index) => {
    const current = voiceSessions.get(sessionKey(name, guildId));
    const target = initialTargets?.get(name);
    const currentIndex = channelIds.indexOf(current?.channelId);
    const preferred = target || channelIds[currentIndex >= 0 ? (currentIndex + 1) % channelIds.length : index % channelIds.length];
    return moveRotationAccount(name, initialTask, preferred, normalizeVoiceState(current || {}));
  });
  const id = crypto.randomUUID();
  const task = { id, accounts, guildId, guildName: guildName || guildId, channels: channelIds, intervalMs: delay, randomOrder: !!randomOrder, currentIdx: 0, startedAt: Date.now(), nextAt: Date.now() + delay, accountStatus: {}, accountTargets: { ...initialTask.accountTargets } };
  initial.forEach((result) => recordTaskResult(task, result));
  task.running = false; task.active = true;
  task.lastResults = initial;
  task.timer = setInterval(async () => {
    if (!task.active || task.running) return;
    task.running = true;
    task.currentIdx = (task.currentIdx + 1) % task.channels.length;
    const randomTargets = task.randomOrder
      ? randomRotationTargets(task.accounts, task.channels, (name) => voiceSessions.get(sessionKey(name, task.guildId))?.channelId)
      : null;
    try {
      task.lastResults = await mapWithConcurrency(task.accounts, 8, async (name, index) => {
        const current = voiceSessions.get(sessionKey(name, task.guildId));
        const randomTarget = randomTargets?.get(name);
        const preferred = rotationPreferredChannel(name, task, index, randomTarget);
        return recordTaskResult(task, await moveRotationAccount(name, task, preferred, normalizeVoiceState(current || {})));
      });
      task.nextAt = Date.now() + task.intervalMs;
      persistAutomationTasks();
      emitLive('task.completed', { id: task.id, taskType: 'rotation', nextAt: task.nextAt, currentIdx: task.currentIdx, results: task.lastResults });
    } finally { task.running = false; }
  }, delay);
  rotations.set(id, task);
  for (const stateTask of stateCycles.values()) {
    if (String(stateTask.guildId) !== String(guildId) || !(stateTask.accounts || []).some((name) => accounts.includes(name))) continue;
    stateTask.phaseRoomId = id;
    stateTask.phaseGapMs = ROTATION_PHASE_GAP_MS;
    stateTask.nextAt = Number(task.nextAt || Date.now() + delay) + ROTATION_PHASE_GAP_MS;
  }
  persistAutomationTasks();
  return ok(res, { id, started: true, initial, summary: summary(initial) });
});
app.post('/api/voice/rotation/stop', (req, res) => {
  const id = String(req.body?.id || '');
  const task = rotations.get(id);
  if (!task) return fail(res, new Error('Rotation not found'), 404);
  task.active = false; clearInterval(task.timer); rotations.delete(id); persistAutomationTasks(); return ok(res);
});
app.post('/api/voice/state-cycle/start', async (req, res) => {
  const accounts = cleanAccounts(req.body?.accounts);
  const { guildId, states, intervalMs } = req.body || {};
  const delay = Math.max(1000, Number(intervalMs || 60000));
  if (!accounts.length || !guildId || !Array.isArray(states) || states.length < 2) return fail(res, new Error('At least two states and one account are required'), 400);
  const conflicts = taskAccountConflicts(accounts, guildId, 'cycle');
  if (conflicts.length) return fail(res, new Error(`These accounts already have a state rotation: ${conflicts.join(', ')}`), 409);
  const validStates = states.every((item) => item && typeof item === 'object'
    && ['selfMute', 'selfDeaf', 'selfVideo', 'selfStream'].every((key) => item[key] === undefined || typeof item[key] === 'boolean')
    && !(item.selfDeaf === true && (item.selfVideo === true || item.selfStream === true)));
  if (!validStates) return fail(res, new Error('State cycle contains an invalid voice state'), 400);
  const id = crypto.randomUUID();
  const task = { id, type: 'cycle', accounts, guildId, states, intervalMs: delay, currentIdx: 0, runToken: 0, startedAt: Date.now(), nextAt: Date.now() + delay };
  task.running = false; task.active = true;
  const linkedRoom = linkedRoomRotation(accounts, guildId);
  if (linkedRoom) { task.phaseRoomId = linkedRoom.id; task.phaseGapMs = ROTATION_PHASE_GAP_MS; task.nextAt = Number(linkedRoom.nextAt || Date.now() + delay) + ROTATION_PHASE_GAP_MS; }
  task.lastResults = linkedRoom
    ? task.accounts.map((name) => ({ name, ok: true, scheduled: true, reason: 'State rotation scheduled after room rotation' }))
    : await mapWithConcurrency(task.accounts, 8, (name) => withResultRetry(() => withAccountLock(name, async () => {
    const current = voiceSessions.get(sessionKey(name, task.guildId));
    const client = getClient(name);
    if (!current || !client) return recordTaskResult(task, { name, ok: false, error: !current ? 'Account is not currently in a voice channel' : 'Account is not connected' });
    const operation = beginAccountOperation(name, task.guildId, 'cycle');
    const next = { ...current, ...normalizeVoiceState(task.states[0]), selfMute: task.states[0].selfMute === undefined ? !!current.selfMute : !!task.states[0].selfMute };
    if (next.selfDeaf && (next.selfVideo || next.selfStream)) { endAccountOperation(operation); return { name, ok: false, error: 'Invalid deafened media state' }; }
    await waitForMediaSettle(next, current);
    const result = (next.selfStream || next.selfVideo)
      ? await startRotationMediaWithFallback(name, task.guildId, next)
      : await sendVoiceOpConfirmed(client, task.guildId, current.channelId, next, 6000);
    if (!operationIsCurrent(operation)) { endAccountOperation(operation); return { name, ok: false, stale: true, error: 'State operation was superseded by a newer request' }; }
    if (result.ok) { const applied = result.appliedState || next; Object.assign(current, applied, { selfStream: !!applied.selfStream, updatedAt: Date.now() }); persistSessions(); }
    endAccountOperation(operation);
    return { name, ok: result.ok, error: result.ok ? null : result.error };
  })));
  if (!linkedRoom) task.nextAt = Date.now() + task.intervalMs;
  const runStateCycle = async () => {
    if (task.nextAt > Date.now()) { if (task.active) task.timer = setTimeout(runStateCycle, task.nextAt - Date.now()); return; }
    if (!task.active || task.running) return;
    task.running = true;
    const runToken = task.runToken;
    task.currentIdx = (task.currentIdx + 1) % task.states.length;
    const state = task.states[task.currentIdx];
    try {
      task.lastResults = [];
      await mapWithConcurrency(task.accounts, 8, (name) => withResultRetry(() => withAccountLock(name, async () => {
        const current = voiceSessions.get(sessionKey(name, task.guildId));
        if (!current) return recordTaskResult(task, { name, ok: false, error: 'Account is not currently in a voice channel' });
        const client = getClient(name);
        if (!client) return recordTaskResult(task, { name, ok: false, error: 'Account is not connected' });
        const operation = beginAccountOperation(name, task.guildId, 'cycle');
        const next = { ...current, ...normalizeVoiceState(state), selfMute: state.selfMute === undefined ? !!current.selfMute : !!state.selfMute };
        if (next.selfDeaf && (next.selfVideo || next.selfStream)) { endAccountOperation(operation); return; }
        let result;
        await waitForMediaSettle(next, current);
        if (next.selfStream || next.selfVideo) result = await startSyntheticStream(name, task.guildId, next.selfStream ? 'go-live' : 'camera');
        else {
          if (current.selfStream || current.selfVideo) stopSyntheticStream(name);
          result = await sendVoiceOpConfirmed(client, task.guildId, current.channelId, next, 6000);
        }
        if (!operationIsCurrent(operation)) { endAccountOperation(operation); task.lastResults.push({ name, ok: false, stale: true, error: 'State operation was superseded by a newer request' }); return; }
        if (result.ok && task.active && task.runToken === runToken) { Object.assign(current, next, { selfStream: !!next.selfStream, updatedAt: Date.now() }); persistSessions(); }
        recordTaskResult(task, { name, ok: result.ok, error: result.ok ? null : result.error });
        endAccountOperation(operation);
      })));
      const roomTask = task.phaseRoomId ? rotations.get(task.phaseRoomId) : null;
      task.nextAt = roomTask ? Number(roomTask.nextAt || Date.now() + task.intervalMs) + Number(task.phaseGapMs || 0) : Date.now() + task.intervalMs;
      persistAutomationTasks();
      emitLive('task.completed', { id: task.id, taskType: 'cycle', nextAt: task.nextAt, currentIdx: task.currentIdx, results: task.lastResults });
    } finally { task.running = false; if (task.active) task.timer = setTimeout(runStateCycle, Math.max(1000, task.nextAt - Date.now())); }
  };
  task.timer = setTimeout(runStateCycle, Math.max(1000, task.nextAt - Date.now()));
  stateCycles.set(id, task);
  persistAutomationTasks();
  return ok(res, { id });
});
app.post('/api/voice/state-cycle/stop', (req, res) => {
  const id = String(req.body?.id || '');
  const task = stateCycles.get(id);
  if (!task) return fail(res, new Error('State cycle not found'), 404);
  task.active = false; task.runToken = Number(task.runToken || 0) + 1; clearTimeout(task.timer); clearInterval(task.timer); stateCycles.delete(id); persistAutomationTasks(); return ok(res);
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
async function restoreAutomationTasks() {
  const saved = loadAutomationTasks();
  for (const item of Array.isArray(saved.rotations) ? saved.rotations : []) {
    if (!item.id || !item.guildId || !Array.isArray(item.channels) || item.channels.length < 2) continue;
    const accounts = cleanAccounts(item.accounts);
    if (taskAccountConflicts(accounts, item.guildId, 'rotation').length) continue;
    const task = { ...item, type: 'rotation', accounts, accountTargets: { ...(item.accountTargets || {}) }, running: false, active: true, intervalMs: Math.max(1000, Number(item.intervalMs || 60000)), nextAt: Number(item.nextAt || Date.now() + Number(item.intervalMs || 60000)) };
    const runRotation = async () => {
      if (!task.active) return;
      if (task.nextAt > Date.now()) { task.timer = setTimeout(runRotation, task.nextAt - Date.now()); return; }
      if (task.running) { task.timer = setTimeout(runRotation, 1000); return; }
      task.running = true;
      task.currentIdx = (task.currentIdx + 1) % task.channels.length;
      const randomTargets = task.randomOrder
        ? randomRotationTargets(task.accounts, task.channels, (name) => voiceSessions.get(sessionKey(name, task.guildId))?.channelId)
        : null;
      try {
        task.lastResults = await mapWithConcurrency(task.accounts, 8, async (name, index) => {
          const current = voiceSessions.get(sessionKey(name, task.guildId));
          const randomTarget = randomTargets?.get(name);
          const preferred = rotationPreferredChannel(name, task, index, randomTarget);
          return recordTaskResult(task, await moveRotationAccount(name, task, preferred, normalizeVoiceState(current || {})));
        });
      } finally {
        task.running = false;
        task.nextAt = Date.now() + task.intervalMs;
        persistAutomationTasks();
        if (task.active) task.timer = setTimeout(runRotation, task.intervalMs);
      }
    };
    rotations.set(task.id, task);
    task.timer = setTimeout(runRotation, Math.max(0, task.nextAt - Date.now()));
  }
  for (const item of Array.isArray(saved.stateCycles) ? saved.stateCycles : []) {
    if (!item.id || !item.guildId || !Array.isArray(item.states) || item.states.length < 2) continue;
    const accounts = cleanAccounts(item.accounts);
    if (taskAccountConflicts(accounts, item.guildId, 'cycle').length) continue;
    const task = { ...item, type: 'cycle', accounts, running: false, active: true, intervalMs: Math.max(1000, Number(item.intervalMs || 60000)), nextAt: Number(item.nextAt || Date.now() + Number(item.intervalMs || 60000)) };
    const runStateCycle = async () => {
      if (!task.active) return;
      if (task.nextAt > Date.now()) { task.timer = setTimeout(runStateCycle, task.nextAt - Date.now()); return; }
      if (task.running) { task.timer = setTimeout(runStateCycle, 1000); return; }
      task.running = true;
      task.currentIdx = (task.currentIdx + 1) % task.states.length;
      const state = normalizeVoiceState(task.states[task.currentIdx]);
      try {
        task.lastResults = await mapWithConcurrency(task.accounts, 8, (name) => withResultRetry(() => withAccountLock(name, async () => {
          const current = voiceSessions.get(sessionKey(name, task.guildId)); const client = getClient(name);
          if (!current || !client) return { name, ok: false, error: 'Account is not currently in a voice channel' };
          const next = { ...current, ...normalizeVoiceState(state), selfMute: state.selfMute === undefined ? !!current.selfMute : !!state.selfMute };
          if (next.selfDeaf && (next.selfVideo || next.selfStream)) return { name, ok: false, error: 'Invalid deafened media state' };
          let result;
          await waitForMediaSettle(next, current);
          if (next.selfStream || next.selfVideo) result = await startSyntheticStream(name, task.guildId, next.selfStream ? 'go-live' : 'camera');
          else { if (current.selfStream || current.selfVideo) stopSyntheticStream(name); result = await sendVoiceOpConfirmed(client, task.guildId, current.channelId, next, 6000); }
          if (result.ok) { Object.assign(current, next, { updatedAt: Date.now() }); persistSessions(); }
          return { name, ok: result.ok, error: result.ok ? null : result.error };
        })));
      } finally {
        task.running = false;
        const roomTask = task.phaseRoomId ? rotations.get(task.phaseRoomId) : null;
        task.nextAt = roomTask ? Number(roomTask.nextAt || Date.now() + task.intervalMs) + Number(task.phaseGapMs || 0) : Date.now() + task.intervalMs;
        persistAutomationTasks();
        if (task.active) task.timer = setTimeout(runStateCycle, Math.max(1000, task.nextAt - Date.now()));
      }
    };
    stateCycles.set(task.id, task);
    task.timer = setTimeout(runStateCycle, Math.max(0, task.nextAt - Date.now()));
  }
}
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => { console.log(`Voice Studio listening on http://localhost:${PORT}`); setInterval(() => { try { reconcileVoiceSessions(); } catch (error) { console.warn('[voice] session reconciliation failed:', error.message); } }, 3000).unref?.(); restoreSavedAccounts().then(() => restoreAutomationTasks()).catch((error) => console.warn('[restore] restore failed:', error.message)); });
}

module.exports = { app, clients, voiceSessions, rotations, stateCycles, playingSessions, stopPlayingSession, startAllPlayingSessions, stopAllPlayingSessions, handlePlayingDiscordCommand, rotationControlledAccounts, taskConflict, beginAccountOperation, operationIsCurrent, endAccountOperation, sendVoiceOp, sendVoiceOpConfirmed, validateTarget, validateMediaTarget, startSyntheticStream, stopSyntheticStream, ensureSyntheticVideo, saveAccounts, loadAccounts, cleanPlayingSteps, sendPlayingPhrase, randomRotationTargets };
