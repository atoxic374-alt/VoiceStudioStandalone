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
function cleanAccountRecords(records) {
  const result = [];
  const seenTokens = new Set();
  const seenNames = new Set();
  for (const item of Array.isArray(records) ? records : []) {
    const token = String(item?.token || '').trim();
    const name = String(item?.name || '').trim().slice(0, 48);
    if (!token || !name) continue;
    const tokenKey = token.toLowerCase();
    const nameKey = name.toLocaleLowerCase();
    if (seenTokens.has(tokenKey) || seenNames.has(nameKey)) continue;
    seenTokens.add(tokenKey);
    seenNames.add(nameKey);
    result.push({ name, token, savedAt: Number(item?.savedAt) || Date.now() });
  }
  return result.slice(0, 500);
}
function loadAccounts() {
  try {
    const payload = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', persistenceKey(), Buffer.from(payload.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64url')), decipher.final()]);
    const records = JSON.parse(plain.toString('utf8'));
    return cleanAccountRecords(records);
  } catch (error) {
    if (fs.existsSync(ACCOUNT_FILE)) console.warn('[accounts] saved accounts could not be restored:', error.message);
    return [];
  }
}
function persistConnectedAccounts() {
  try { saveAccounts(cleanAccountRecords([...clients.entries()].map(([name, entry]) => ({ name, token: entry.token, savedAt: entry.savedAt || Date.now() })))); }
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
const connectingTokens = new Set();
const voiceSessions = new Map();
const rotations = new Map();
const stateCycles = new Map();
const syntheticStreams = new Map();
const mediaStreamers = new Map();
const pendingMediaRestarts = new Map();
const mediaRestartAttempts = new Map();
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
const MEDIA_JOIN_TIMEOUT_MS = Math.max(10000, Number(process.env.MEDIA_JOIN_TIMEOUT_MS || 20000));
const MEDIA_WEBRTC_TIMEOUT_MS = Math.max(6000, Number(process.env.MEDIA_WEBRTC_TIMEOUT_MS || 10000));
const MEDIA_STREAM_TIMEOUT_MS = Math.max(12000, Number(process.env.MEDIA_STREAM_TIMEOUT_MS || 20000));
// Media starts are serialized through an explicit FIFO queue. The next camera
// or Go Live account starts only after the previous attempt has reached a
// terminal result (ready, failed, or cancelled) and its resources are cleaned.
// An optional gap can still be configured, but the default is zero.
const MEDIA_START_GAP_MS = Math.max(0, Number(process.env.MEDIA_START_GAP_MS || 0));
const SYNTHETIC_VIDEO_FILE = path.join(DATA_DIR, 'synthetic-stream-black-v2.mp4');
const DISCORD_REQUEST_GAP_MS = Math.max(0, Number(process.env.DISCORD_REQUEST_GAP_MS || 120));
let nextDiscordRequestAt = 0;
const WATCHDOG_INTERVAL_MS = Math.max(5000, Number(process.env.VOICE_WATCHDOG_INTERVAL_MS || 10000));
const WATCHDOG_CONFIRMATION_MISSES = 2;
const WATCHDOG_REPAIR_COOLDOWN_MS = Math.max(10000, Number(process.env.VOICE_WATCHDOG_COOLDOWN_MS || 30000));
const AUTOMATION_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.VOICE_AUTOMATION_CONCURRENCY || 2)));
const watchdogObservations = new Map();
const mediaDesired = new Map();
const mediaRunGenerations = new Map();
// Keep a failed primary stream handshake from being retried by every state
// cycle tick. Retrying a broken handshake immediately is both ineffective and
// causes the upstream voice library to retain transport listeners.
const primaryMediaFailures = new Map();
const pendingRoomMoves = new Set();
let watchdogRunning = false;
const mediaStartQueue = [];
let mediaStartRunning = false;
let mediaStartSequence = 0;

function ok(res, payload = {}) { return res.json({ success: true, ...payload }); }
function redact(value) { return String(value ?? '').replace(/(token|authorization|password|cookie)(["']?\s*[:=]\s*["']?)[^"',;\s}]+/gi, '$1$2[redacted]'); }
function fail(res, error, status = 200, payload = {}) {
  const message = redact(error?.message || String(error || 'Unknown error'));
  return res.status(status).json({ success: false, error: message, ...payload });
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
function normalizeExclusiveVoiceState(state = {}) {
  const requested = normalizeVoiceState(state);
  // A rotation item represents one mode, not a patch over the previous mode.
  // Media modes also explicitly clear mute/deafen so Discord cannot retain a
  // stale voice flag while the streamer is being started.
  if (requested.selfStream) return { selfMute: false, selfDeaf: false, selfVideo: false, selfStream: true };
  if (requested.selfVideo) return { selfMute: false, selfDeaf: false, selfVideo: true, selfStream: false };
  if (requested.selfDeaf) return { selfMute: false, selfDeaf: true, selfVideo: false, selfStream: false };
  if (requested.selfMute) return { selfMute: true, selfDeaf: false, selfVideo: false, selfStream: false };
  return { selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false };
}
function hasVoiceFlags(state = {}) {
  return !!(state.selfMute || state.selfDeaf || state.selfVideo || state.selfStream);
}
function mergeVoiceState(current = {}, requested = {}) {
  const merged = { ...normalizeVoiceState(current) };
  for (const key of ['selfMute', 'selfDeaf', 'selfVideo', 'selfStream']) {
    if (typeof requested?.[key] === 'boolean') merged[key] = requested[key];
  }
  return normalizeExclusiveVoiceState(merged);
}
function randomStateIndex(states, previous = -1) {
  const count = Array.isArray(states) ? states.length : 0;
  if (!count) return 0;
  if (count === 1) return 0;
  const choices = Array.from({ length: count }, (_, index) => index).filter((index) => index !== previous);
  return choices[Math.floor(Math.random() * choices.length)];
}
function nextStateIndex(states, history = []) {
  const count = Array.isArray(states) ? states.length : 0;
  if (!count) return 0;
  const used = new Set((Array.isArray(history) ? history : []).filter((index) => Number.isInteger(index) && index >= 0 && index < count));
  const available = Array.from({ length: count }, (_, index) => index).filter((index) => !used.has(index));
  const choices = available.length ? available : Array.from({ length: count }, (_, index) => index).filter((index) => index !== history.at(-1));
  return choices[Math.floor(Math.random() * choices.length)];
}
async function recoverVoiceAfterStateFailure(name, guildId, current) {
  const client = getClient(name);
  if (!client || !current?.channelId) return { ok: false, error: 'No confirmed voice session to recover' };
  // Recovery restores the same voice room. Leaving it here invalidates the
  // session/token that the following OP4 needs and turns a recoverable media
  // failure into a guaranteed voice-state confirmation timeout.
  stopSyntheticStream(name, { leaveVoice: false });
  const restored = await sendVoiceOpConfirmed(client, guildId, current.channelId, {
    selfMute: !!current.selfMute,
    selfDeaf: !!current.selfDeaf,
    selfVideo: false,
    selfStream: false,
  }, 4500);
  if (restored.ok) {
    Object.assign(current, { selfVideo: false, selfStream: false, updatedAt: Date.now() });
    persistSessions();
  }
  return restored;
}
async function executeStateForAccount(name, task, requestedState, expectedRunToken = null) {
  const taskIsCurrent = () => task.active !== false && (expectedRunToken == null || task.runToken === expectedRunToken);
  if (!taskIsCurrent()) return { name, ok: false, stale: true, error: 'State cycle was stopped or superseded' };
  if (pendingRoomMoves.has(name)) return { name, ok: false, deferred: true, error: 'State cycle deferred while the account is moving rooms' };
  const current = voiceSessions.get(sessionKey(name, task.guildId));
  const client = getClient(name);
  if (!current) return { name, ok: false, error: 'Account is not currently in a voice channel' };
  if (!client) return { name, ok: false, error: 'Account is not connected' };
  const operation = beginAccountOperation(name, task.guildId, 'cycle');
  try {
    const next = { ...current, ...mergeVoiceState({}, requestedState) };
    if (next.selfDeaf && (next.selfVideo || next.selfStream)) return { name, ok: false, error: 'Invalid deafened media state' };
    const stoppingMedia = current.selfStream || current.selfVideo || syntheticStreams.has(name);
    if (stoppingMedia) {
      stopSyntheticStream(name, { leaveVoice: false });
      // STREAM_DELETE is asynchronous on Discord. Do not race its teardown
      // with an OP4 reset; Discord can otherwise omit the reset update and the
      // state cycle is left showing the old stream.
      await new Promise((resolve) => setTimeout(resolve, MEDIA_SETTLE_DELAY_MS));
    }
    const cleared = await clearVoiceFlags(client, task.guildId, current.channelId, current);
    if (!cleared.ok) return { name, ok: false, error: `Unable to clear previous voice state: ${cleared.error}` };
    if (!taskIsCurrent()) return { name, ok: false, stale: true, error: 'State cycle was stopped or superseded' };
    await waitForMediaSettle(next, current);
    if (!taskIsCurrent()) return { name, ok: false, stale: true, error: 'State cycle was stopped or superseded' };
    let result;
    if (next.selfStream || next.selfVideo) {
      result = await startSyntheticStream(name, task.guildId, next.selfStream ? 'go-live' : 'camera', next);
      if (!result.ok) await recoverVoiceAfterStateFailure(name, task.guildId, current);
    } else {
      result = await sendVoiceOpConfirmed(client, task.guildId, current.channelId, next, 6000);
    }
    if (!operationIsCurrent(operation)) return { name, ok: false, stale: true, error: 'State operation was superseded by a newer request' };
    if (result.ok) {
      Object.assign(current, next, { updatedAt: Date.now() });
      persistSessions();
    }
    return { name, ok: result.ok, permissionDenied: result.permissionDenied === true, error: result.ok ? null : result.error };
  } finally {
    endAccountOperation(operation);
  }
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
async function waitForDiscordRequestSlot() {
  const now = Date.now();
  const scheduled = Math.max(now, nextDiscordRequestAt);
  nextDiscordRequestAt = scheduled + DISCORD_REQUEST_GAP_MS;
  if (scheduled > now) await new Promise((resolve) => setTimeout(resolve, scheduled - now));
}
function componentLabel(component) { const label = component?.label || component?.data?.label || ''; const emoji = component?.emoji || component?.data?.emoji; const emojiName = typeof emoji === 'string' ? emoji : emoji?.name || emoji?.id || ''; return `${String(label).trim()} ${String(emojiName).trim()}`.trim(); }
function messageButtons(message) { return (message?.components || []).flatMap((row) => row?.components || []).filter((component) => String(component?.type || '').toUpperCase() === 'BUTTON' || component?.type === 2); }
function normalizePlayingButton(value) { return String(value || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase(); }
async function dispatchPlayingButton(message, customId, details, canContinue = () => true) {
  if (!canContinue()) return { ok: false, stopped: true, error: 'Playing session stopped before click' };
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
async function findPlayingButton(channel, session, step, canContinue = () => true) {
  if (!canContinue()) return null;
  await waitForDiscordRequestSlot();
  if (!canContinue()) return null;
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!canContinue()) return null;
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
async function findAnyPlayingButton(channel, session, canContinue = () => true) {
  if (!canContinue()) return null;
  await waitForDiscordRequestSlot();
  if (!canContinue()) return null;
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!canContinue()) return null;
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
  await waitForDiscordRequestSlot();
  const channel = await client.channels?.fetch?.(session.channelId).catch?.(() => null);
  if (!channel?.messages?.fetch) return { ok: false, error: 'Text channel is not available for this account' };
  const found = await findAnyPlayingButton(channel, session, canContinue);
  const step = found?.step;
  const stepIndex = found?.stepIndex ?? 0;
  if (!found) { const available = session.lastScan?.flatMap((item) => item.labels).filter(Boolean).slice(0, 20) || []; logPlayingEvent('button.waiting', { account: session.account, requested: session.steps.map((item) => item.button), available }); return { ok: false, waiting: true, error: 'Waiting for any configured button', available }; }
  if (!canContinue()) return { ok: false, stopped: true, error: 'Playing session stopped before click' };
  logPlayingEvent('button.click.started', { account: session.account, requested: step.button, label: found.label, messageId: String(found.message.id), customId: found.customId });
  const click = await dispatchPlayingButton(found.message, found.customId, { account: session.account, requested: step.button, label: found.label, messageId: String(found.message.id), customId: found.customId }, canContinue);
  if (click.stopped) return click;
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
    await waitForDiscordRequestSlot();
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
async function addPlayingAccounts(sessionAccount, accounts) {
  const source = playingSessions.get(playingKey(sessionAccount));
  if (!source) return { ok: false, error: 'The source Playing session does not exist' };
  const names = cleanAccounts(accounts).filter((account) => account !== source.account);
  if (!names.length) return { ok: false, error: 'Select at least one new account' };
  const results = [];
  for (const account of names) {
    if (playingSessions.has(account)) { results.push({ account, ok: false, error: 'Account already has a Playing session' }); continue; }
    const entry = clients.get(account);
    if (!entry) { results.push({ account, ok: false, error: 'Account is not connected' }); continue; }
    const channel = await entry.client.channels?.fetch?.(source.channelId).catch?.(() => null);
    if (!channel?.messages?.fetch) { results.push({ account, ok: false, error: `Account "${account}" cannot access the selected text room` }); continue; }
    const session = { ...source, account, active: !!source.active, status: source.active ? 'running' : 'saved', runToken: 1, currentIndex: 0, createdAt: Date.now(), updatedAt: Date.now(), timer: null, lastAction: null, lastResult: null };
    playingSessions.set(account, session);
    if (session.active) schedulePlaying(session);
    results.push({ account, ok: true, active: session.active });
  }
  persistPlayingSessions();
  emitLive('playing.accounts_added', { sourceAccount: source.account, results });
  logPlayingEvent('accounts-added', { sourceAccount: source.account, results });
  return { ok: results.some((item) => item.ok), results, added: results.filter((item) => item.ok).length };
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
  if (configuredChannel && String(message.channel?.id || '') !== configuredChannel) {
    console.log(`[playing-command] ignored: channel mismatch author=${String(message.author?.id || 'unknown')} channel=${String(message.channel?.id || 'unknown')} expected=${configuredChannel}`);
    return false;
  }
  const owners = String(process.env.DISCORD_COMMAND_OWNERS || '')
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const authorId = String(message.author?.id || '');
  // An explicit allow-list is required. Never fall back to the connected
  // account, because every connected account can receive the same command.
  if (!authorId || !owners.includes(authorId)) {
    console.log(`[playing-command] ignored: owner mismatch author=${authorId || 'unknown'} configured=${owners.length ? owners.join(',') : 'none'} command=${command}`);
    return false;
  }
  const messageKey = String(message.id || '');
  if (messageKey && handledPlayingCommands.has(messageKey)) return false;
  if (messageKey) {
    handledPlayingCommands.add(messageKey);
    if (handledPlayingCommands.size > 1000) handledPlayingCommands.delete(handledPlayingCommands.values().next().value);
  }
  console.log(`[playing-command] accepted command=${command} author=${authorId} listener=${String(client?.user?.id || 'unknown')} sessions=${playingSessions.size}`);
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
function isInvalidCredentialError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = Number(error?.code || 0);
  const text = String(error?.error || error?.message || '').toLowerCase();
  return status === 401 || code === 40001 || code === 4004 || /invalid token|improper token|token is invalid|incorrect login details/.test(text);
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
async function clearVoiceFlags(client, guildId, channelId, current = {}) {
  // Clearing is an explicit transition barrier, not an optimization based on
  // cached state. Discord may still have a media flag when the local session
  // is stale or when the dedicated streamer owns the most recent transition.
  // Always send the complete zeroed OP4 payload before applying the next mode.
  const reset = {
    selfMute: false,
    selfDeaf: false,
    selfVideo: false,
    selfStream: false,
  };
  // Discord may drop one VOICE_STATE_UPDATE while a media transport is being
  // torn down. This reset is idempotent, so retry it before aborting rotation.
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await sendVoiceOpConfirmed(client, guildId, channelId, {
      ...reset,
      // Discord may omit disabled media fields from VOICE_STATE_UPDATE after a
      // STREAM_DELETE. The room and every field it does report must still
      // match; only these already-disabled fields are optional.
      confirmOmittedFalseFlags: ['selfVideo', 'selfStream'],
    }, attempt === 0 ? 6000 : 3000);
    if (last.ok) return last;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
  }
  return last || { ok: false, error: 'Unable to reset voice state' };
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
function stopSyntheticStream(name, { leaveVoice = false, silent = false, invalidate = true, preserveRestartState = false } = {}) {
  // Replacing an old transport as part of a new start must not invalidate the
  // new start's generation. Previously startSyntheticStreamUnqueued() called
  // this function after capturing its generation, so every camera/Go Live
  // replacement cancelled itself with "Media start cancelled...".
  if (invalidate) mediaRunGenerations.set(name, Number(mediaRunGenerations.get(name) || 0) + 1);
  const pendingRestart = pendingMediaRestarts.get(name);
  if (pendingRestart) {
    clearTimeout(pendingRestart);
    pendingMediaRestarts.delete(name);
  }
  if (!preserveRestartState) mediaRestartAttempts.delete(name);
  const active = syntheticStreams.get(name);
  const trackedStreamer = mediaStreamers.get(name);
  const streamers = [...new Set([active?.streamer, trackedStreamer].filter(Boolean))];
  if (active) {
    try { active.controller?.abort?.(); } catch {}
    try { active.sourceProcess?.kill?.('SIGTERM'); } catch {}
    // During a room move, do not send STREAM_DELETE/OP4 from the dedicated
    // transport. The primary voice connection is about to send the canonical
    // state and any extra gateway signal can suppress VOICE_SERVER_UPDATE.
    if (silent) {
      try { active.streamer?.voiceConnection?.streamConnection?.stop?.(); } catch {}
    } else {
      try { active.streamer?.stopStream?.(); } catch {}
      try { active.streamer?.signalVideo?.(false); } catch {}
    }
    try { active.dispatcher?.destroy?.(); } catch {}
    try { active.streamConnection?.disconnect?.(); } catch {}
    if (active.connection?.streamConnection === active.streamConnection) {
      try { active.connection.streamConnection = null; } catch {}
    }
    try { active.streamer?.voiceConnection?.stop?.(); } catch {}
    try { active.streamer?._gatewayEmitter?.removeAllListeners?.(); } catch {}
    if (!leaveVoice && active.streamer) {
      try { active.streamer._voiceConnection = undefined; } catch {}
    }
  }
  syntheticStreams.delete(name);
  for (const streamer of streamers) {
    try { streamer.stopStream?.(); } catch {}
    try { streamer.voiceConnection?.stop?.(); } catch {}
    try { streamer._gatewayEmitter?.removeAllListeners?.(); } catch {}
    try { streamer._voiceConnection = undefined; } catch {}
  }
  const streamer = trackedStreamer;
  if (leaveVoice) {
    try { streamer?.leaveVoice?.(); } catch {}
  }
  // Every media run gets a fresh Streamer. Releasing the reference here is
  // safe; leaving the primary voice room remains an explicit operation.
  mediaStreamers.delete(name);
  mediaDesired.delete(name);
}
function scheduleMediaRestart(name, active, reason) {
  if (!active || active.restarting || pendingMediaRestarts.has(name)) return;
  active.restarting = true;
  const attempts = Number(mediaRestartAttempts.get(name) || 0) + 1;
  mediaRestartAttempts.set(name, attempts);
  if (attempts > 6) {
    active.restarting = false;
    logMediaEvent('error', 'media.restart_paused', { account: name, guildId: active.guildId, channelId: active.channelId, mediaKind: active.mediaKind, attempts, reason });
    return;
  }
  const delayMs = Math.min(5 * 60 * 1000, 1000 * (2 ** (attempts - 1)));
  logMediaEvent('warn', 'media.restart_scheduled', { account: name, guildId: active.guildId, channelId: active.channelId, mediaKind: active.mediaKind, reason, attempts, delayMs });
  const restartTimer = setTimeout(async () => {
    pendingMediaRestarts.delete(name);
    const current = voiceSessions.get(sessionKey(name, active.guildId));
    const expectedKind = current?.selfStream ? 'go-live' : current?.selfVideo ? 'camera' : null;
    if (!current || current.channelId !== active.channelId || expectedKind !== active.mediaKind) return;
    try {
      const result = await startSyntheticStream(name, active.guildId, active.mediaKind, current);
      if (result.ok) {
        const restored = voiceSessions.get(sessionKey(name, active.guildId));
        if (restored) Object.assign(restored, { selfVideo: active.mediaKind === 'camera', selfStream: active.mediaKind === 'go-live', updatedAt: Date.now() });
        persistSessions();
      }
    } catch (error) {
      // Timers do not have a caller to await them. Contain any unforeseen
      // failure so a retry never becomes a process-level crash.
      logMediaEvent('error', 'media.restart_failed', { account: name, guildId: active.guildId, channelId: active.channelId, error: error?.message || String(error) });
    }
  }, delayMs);
  pendingMediaRestarts.set(name, restartTimer);
}
function createBlackMediaSource() {
  const sourceProcess = spawn(FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=15',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-f', 'nut', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  // ChildProcess reports spawn failures asynchronously. Without this listener
  // errors such as EAGAIN become an unhandled error and terminate Node.
  sourceProcess.once('error', (error) => {
    logMediaEvent('error', 'stream.source_failed', { pid: sourceProcess.pid || null, code: error?.code || null, error: error?.message || String(error) });
  });
  sourceProcess.stderr.on('data', (chunk) => logMediaEvent('warn', 'stream.source_warning', { pid: sourceProcess.pid, error: String(chunk).trim().slice(0, 300) }));
  sourceProcess.once('close', (code, signal) => {
    if (code !== 0) logMediaEvent('error', 'stream.source_exited', { pid: sourceProcess.pid, code, signal });
  });
  return { stream: sourceProcess.stdout, sourceProcess };
}
function waitForMediaSource(source, timeoutMs = 3000) {
  let cleanup = () => {};
  const waiting = new Promise((resolve, reject) => {
    let received = false;
    const onData = (chunk) => {
      if (chunk?.length) { received = true; cleanup(); resolve({ bytes: chunk.length }); }
    };
    const onError = (error) => { if (!received) { cleanup(); reject(error); } };
    const onClose = (code, signal) => { if (!received) { cleanup(); reject(new Error(`FFmpeg exited before producing media (code=${code}, signal=${signal || 'none'})`)); } };
    cleanup = () => { source.stream.off('data', onData); source.sourceProcess.off('error', onError); source.sourceProcess.off('close', onClose); };
    source.stream.on('data', onData);
    source.sourceProcess.once('error', onError);
    source.sourceProcess.once('close', onClose);
  });
  return withTimeout(waiting, timeoutMs, 'FFmpeg produced no media data within 3 seconds').catch((error) => { cleanup(); throw error; });
}
function cleanupPrimaryStreamAttempt(connection, streamConnection = connection?.streamConnection) {
  if (!streamConnection) return false;
  // createStreamConnection() creates and stores this object synchronously,
  // before its WebRTC promise settles. If that promise times out, leaving it
  // cached makes the next start reuse a half-open transport and can cause
  // repeated STREAM_SERVER_UPDATE/voice-socket failures.
  try { streamConnection.disconnect?.(); } catch {}
  if (connection?.streamConnection === streamConnection) {
    try { connection.streamConnection = null; } catch {}
  }
  return true;
}
function compactPrimaryVoiceClosingListeners(connection) {
  if (!connection || typeof connection.listenerCount !== 'function' || typeof connection.removeAllListeners !== 'function') return false;
  // discord.js-selfbot-v13 creates a WebSocket and UDP object on reconnect,
  // and each object adds a `closing` listener without removing its predecessor.
  // Once this reaches 11 Node emits MaxListenersExceededWarning and retains
  // dead transports. Rebuild the small, current cleanup set instead.
  if (connection.listenerCount('closing') <= 3) return false;
  connection.removeAllListeners('closing');
  connection.on?.('closing', () => connection.player?.destroy?.());
  connection.on?.('closing', () => connection.sockets?.ws?.shutdown?.());
  connection.on?.('closing', () => connection.sockets?.udp?.shutdown?.());
  logMediaEvent('warn', 'media.primary_listener_cleanup', {
    channelId: voiceConnectionChannelId(connection),
    listeners: connection.listenerCount('closing'),
  });
  return true;
}
function primaryMediaRetryError(name, guildId, channelId, mediaKind) {
  const previous = primaryMediaFailures.get(name);
  if (!previous || previous.guildId !== guildId || previous.channelId !== channelId || previous.mediaKind !== mediaKind || previous.retryAt <= Date.now()) return null;
  return `Media transport is cooling down after a failed Discord handshake; retry in ${Math.ceil((previous.retryAt - Date.now()) / 1000)} seconds`;
}
function recordPrimaryMediaFailure(name, guildId, channelId, mediaKind, error) {
  const previous = primaryMediaFailures.get(name);
  const attempts = previous?.guildId === guildId && previous?.channelId === channelId && previous?.mediaKind === mediaKind ? previous.attempts + 1 : 1;
  const delayMs = Math.min(5 * 60 * 1000, 30_000 * (2 ** (attempts - 1)));
  primaryMediaFailures.set(name, { guildId, channelId, mediaKind, attempts, retryAt: Date.now() + delayMs });
  logMediaEvent('warn', 'media.primary_retry_delayed', { account: name, guildId, channelId, mediaKind, attempts, delayMs, error });
}
function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]).finally(() => clearTimeout(timer));
}
async function playPrimaryMediaAndWait(streamConnection, sourceStream, signaling, isCurrent = () => true) {
  const dispatcher = streamConnection.playVideo(sourceStream, { fps: 15, presetH26x: 'superfast', bitrate: 300, inputFFmpegArgs: ['-re'], outputFFmpegArgs: ['-g', '30'] });
  if (!isCurrent()) {
    try { dispatcher?.destroy?.(); } catch {}
    throw new Error('Media start cancelled by a newer account operation');
  }
  await signaling;
  if (!isCurrent()) {
    try { dispatcher?.destroy?.(); } catch {}
    throw new Error('Media start cancelled by a newer account operation');
  }
  return dispatcher;
}
function installVoiceEventFilter(streamer, userId, guildId, channelId) {
  const emitter = streamer?._gatewayEmitter;
  if (!emitter || typeof emitter.emit !== 'function') return false;
  if (emitter.__voiceEventFilterInstalled) {
    Object.assign(emitter.__voiceEventFilterState, { userId: String(userId), guildId: String(guildId), channelId: String(channelId) });
    return true;
  }
  const emit = emitter.emit.bind(emitter);
  const filterState = { userId: String(userId), guildId: String(guildId), channelId: String(channelId) };
  emitter.emit = (type, data, ...args) => {
    const current = emitter.__voiceEventFilterState;
    if (type === 'VOICE_STATE_UPDATE') {
      if (String(data?.user_id) !== current.userId
          || String(data?.guild_id) !== current.guildId
          || (data?.channel_id != null && String(data.channel_id) !== current.channelId)) return false;
    }
    if (type === 'VOICE_SERVER_UPDATE') {
      if (data?.guild_id != null && String(data.guild_id) !== current.guildId) return false;
      if (data?.channel_id != null && String(data.channel_id) !== current.channelId) return false;
    }
    return emit(type, data, ...args);
  };
  emitter.__voiceEventFilterState = filterState;
  emitter.__voiceEventFilterInstalled = true;
  return true;
}
function voiceFailureHints(diagnostics) {
  const hints = [];
  if (diagnostics.gatewayReady !== true) hints.push('gateway-session-not-ready');
  if (diagnostics.rawVoiceState === 0) hints.push('no-matching-voice-state-dispatch');
  if (diagnostics.rawVoiceServer === 0) hints.push('no-matching-voice-server-dispatch');
  if (diagnostics.rawVoiceState > 0 && diagnostics.rawVoiceServer === 0) hints.push('voice-server-update-missing-or-filtered');
  if (diagnostics.rawVoiceServer > 0 && !diagnostics.hasVoiceToken) hints.push('voice-server-dispatch-without-token');
  if (diagnostics.rawVoiceServer > 0 && !diagnostics.voiceEndpoint) hints.push('voice-server-dispatch-without-endpoint');
  if (diagnostics.voiceEventGuildMismatch > 0) hints.push('voice-event-guild-mismatch');
  if (diagnostics.voiceEventChannelMismatch > 0) hints.push('voice-event-channel-mismatch');
  if (diagnostics.targetValidation?.ok === false) hints.push('target-channel-validation-failed');
  if (diagnostics.hasSession && diagnostics.hasVoiceToken && !diagnostics.voiceSocketStarted) hints.push('voice-library-did-not-start-socket');
  if (diagnostics.voiceSocketStarted && !diagnostics.voiceSocketOpen) hints.push('voice-socket-open-failed');
  if (diagnostics.voiceSocketOpen && !diagnostics.webRtcReady) hints.push('webrtc-not-ready');
  return hints;
}
function mediaJoinDiagnostics(client, streamer, guildId, channelId, events = {}) {
  const connection = streamer?.voiceConnection;
  const shards = client?.ws?.shards;
  const shard = shards?.first?.() || shards?.get?.(0);
  const status = connection?.status || {};
  const targetValidation = validateMediaTarget(client, guildId, channelId);
  const diagnostics = {
    gatewayStatus: shard?.status ?? null,
    gatewayReady: shard?.status === undefined ? null : shard.status === 0,
    gatewayShardCount: shards?.size ?? null,
    gatewayShardId: shard?.id ?? 0,
    targetGuildId: String(guildId),
    targetChannelId: String(channelId),
    targetValidation: {
      ok: targetValidation.ok,
      error: targetValidation.error || null,
      guildId: targetValidation.guild?.id ?? String(guildId),
      channelId: targetValidation.channel?.id ?? String(channelId),
      channelType: targetValidation.channel?.type ?? null,
      channelName: targetValidation.channel?.name ?? null,
      userLimit: targetValidation.channel?.userLimit ?? null,
      memberCount: targetValidation.channel?.members?.size ?? null,
    },
    voiceConnectionCreated: !!connection,
    voiceGuildId: connection?.guildId ?? null,
    voiceChannelId: connection?.channelId ?? null,
    hasSession: !!connection?.session_id || status.hasSession === true,
    hasVoiceToken: !!connection?.token || status.hasToken === true,
    voiceSocketStarted: status.started === true,
    voiceSocketOpen: connection?.ws?.readyState === 1,
    webRtcReady: connection?.webRtcConn?.ready === true,
    voiceEndpoint: typeof connection?.endpoint === 'string' ? connection.endpoint.replace(/^.*?:\/\//, '').split('/')[0] : null,
    events,
  };
  diagnostics.rawVoiceState = Number(events.rawVoiceState || 0);
  diagnostics.rawVoiceServer = Number(events.rawVoiceServer || 0);
  diagnostics.voiceEventGuildMismatch = Number(events.voiceEventGuildMismatch || 0);
  diagnostics.voiceEventChannelMismatch = Number(events.voiceEventChannelMismatch || 0);
  diagnostics.failureHints = voiceFailureHints(diagnostics);
  return diagnostics;
}
async function joinMediaVoiceWithDiagnostics(client, streamer, guildId, channelId, timeoutMs, context) {
  const events = { voiceState: 0, voiceServer: 0, rawVoiceState: 0, rawVoiceServer: 0, voiceEventGuildMismatch: 0, voiceEventChannelMismatch: 0, samples: [] };
  const onRaw = (packet) => {
    if (!['VOICE_STATE_UPDATE', 'VOICE_SERVER_UPDATE'].includes(packet?.t)) return;
    const data = packet.d || {};
    const isState = packet.t === 'VOICE_STATE_UPDATE';
    const isOwn = !isState || String(data.user_id) === String(client.user?.id);
    const guildMatches = !data.guild_id || String(data.guild_id) === String(guildId);
    const channelMatches = !isState || data.channel_id == null || String(data.channel_id) === String(channelId);
    if (!guildMatches) events.voiceEventGuildMismatch += 1;
    if (!channelMatches) events.voiceEventChannelMismatch += 1;
    if (isOwn && guildMatches && channelMatches) {
      if (isState) events.rawVoiceState += 1; else events.rawVoiceServer += 1;
    }
    if (events.samples.length < 12) events.samples.push({ type: packet.t, guildId: data.guild_id ?? null, channelId: data.channel_id ?? null, endpoint: data.endpoint ?? null, hasToken: Boolean(data.token), hasSessionId: Boolean(data.session_id), isOwn });
  };
  const onVoiceState = (data) => { events.voiceState += 1; if (events.samples.length < 12) events.samples.push({ type: 'streamer:VOICE_STATE_UPDATE', guildId: data?.guild_id ?? null, channelId: data?.channel_id ?? null, hasSessionId: Boolean(data?.session_id) }); };
  const onVoiceServer = (data) => { events.voiceServer += 1; if (events.samples.length < 12) events.samples.push({ type: 'streamer:VOICE_SERVER_UPDATE', guildId: data?.guild_id ?? null, endpoint: data?.endpoint ?? null, hasToken: Boolean(data?.token) }); };
  client?.on?.('raw', onRaw);
  streamer?._gatewayEmitter?.on?.('VOICE_STATE_UPDATE', onVoiceState);
  streamer?._gatewayEmitter?.on?.('VOICE_SERVER_UPDATE', onVoiceServer);
  logMediaEvent('info', 'media.join.diagnostics_start', { ...context, diagnostics: mediaJoinDiagnostics(client, streamer, guildId, channelId, events) });
  try {
    return await withTimeout(streamer.joinVoice(guildId, channelId), timeoutMs, 'Dedicated media voice connection timed out');
  } catch (error) {
    const diagnostics = mediaJoinDiagnostics(client, streamer, guildId, channelId, events);
    logMediaEvent('error', 'media.join.diagnostics_failed', { ...context, error: error?.message || String(error), diagnostics });
    const waiting = [];
    if (!diagnostics.gatewayReady) waiting.push('gateway-not-ready');
    if (!diagnostics.hasSession) waiting.push('VOICE_STATE_UPDATE/session');
    if (!diagnostics.hasVoiceToken) waiting.push('VOICE_SERVER_UPDATE/token');
    if (!diagnostics.voiceSocketStarted) waiting.push('voice-socket-not-started');
    if (diagnostics.voiceSocketStarted && !diagnostics.voiceSocketOpen) waiting.push('voice-socket-not-open');
    if (diagnostics.voiceSocketOpen && !diagnostics.webRtcReady) waiting.push('voice-websocket/WebRTC');
    const detail = waiting.length ? waiting.join(', ') : 'unknown-join-stage';
    logMediaEvent('error', 'media.join.failure_classified', { ...context, stage: detail, hints: diagnostics.failureHints, diagnostics });
    throw new Error(`${error?.message || String(error)} [stage=${detail}; hints=${diagnostics.failureHints.join('|') || 'none'}; diagnostics=${JSON.stringify(diagnostics)}]`);
  } finally {
    client?.off?.('raw', onRaw);
    streamer?._gatewayEmitter?.off?.('VOICE_STATE_UPDATE', onVoiceState);
    streamer?._gatewayEmitter?.off?.('VOICE_SERVER_UPDATE', onVoiceServer);
  }
}
async function resyncPrimaryVoiceForMedia(client, guildId, channelId, session) {
  // A dedicated Streamer uses the same Discord gateway as the primary voice
  // connection. Re-asserting the primary room immediately before the media
  // handshake gives Discord a clean, current voice session/token pair instead
  // of relying on a stale VOICE_STATE_UPDATE from the previous room.
  const primary = await sendVoiceOpConfirmed(client, guildId, channelId, {
    selfMute: !!session?.selfMute,
    selfDeaf: !!session?.selfDeaf,
    selfVideo: false,
    selfStream: false,
  }, 4500);
  if (!primary.ok) throw new Error(`Primary voice resync failed: ${primary.error}`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  return primary;
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
async function startBuiltInGoLive(name, guildId, session, mediaKind = 'go-live', isCurrent = () => true) {
  const client = getClient(name);
  const target = validateMediaTarget(client, guildId, session.channelId);
  if (!target.ok) return { ok: false, error: target.error };
  const connection = client?.voice?.connection;
  if (!connection || voiceConnectionChannelId(connection) !== String(session.channelId)) return { ok: false, error: 'The account has no active voice connection' };
  const cooldownError = primaryMediaRetryError(name, guildId, session.channelId, mediaKind);
  if (cooldownError) return { ok: false, error: cooldownError, cooldown: true };
  compactPrimaryVoiceClosingListeners(connection);
  // playVideo() starts FFmpeg internally. Feed it the reusable one-hour file
  // instead of starting a second FFmpeg producer for every account.
  const source = ensureSyntheticVideo();
  let streamConnection;
  let pendingStreamConnection;
  let dispatcher;
  let active;
  try {
    // The VoiceConnection implementation sends STREAM_CREATE itself and only
    // resolves this promise after the stream transport has authenticated and
    // become ready. Do not run a second, parallel raw-event timeout here: it
    // can reject first while the library is still cleaning up its transport.
    const connecting = connection.createStreamConnection();
    pendingStreamConnection = connection.streamConnection;
    streamConnection = await withTimeout(connecting, MEDIA_STREAM_TIMEOUT_MS, `Discord media connection timed out after ${Math.round(MEDIA_STREAM_TIMEOUT_MS / 1000)} seconds`);
    pendingStreamConnection = streamConnection;
    dispatcher = await playPrimaryMediaAndWait(streamConnection, source, Promise.resolve(), isCurrent);
    active = { connection, streamConnection, dispatcher, sourceProcess: null, guildId, channelId: session.channelId, mediaKind };
    syntheticStreams.set(name, active);
    const restartPrimaryMedia = (reason, error) => {
      if (syntheticStreams.get(name) !== active || active.restarting) return;
      active.restarting = true;
      if (error) logMediaEvent('error', 'stream.runtime_failed', { account: name, guildId, channelId: session.channelId, error: error?.message || String(error) });
      stopSyntheticStream(name, { silent: true, preserveRestartState: true });
      active.restarting = false;
      scheduleMediaRestart(name, active, reason);
    };
    dispatcher.on?.('error', (error) => restartPrimaryMedia('primary dispatcher failed', error));
    dispatcher.once?.('finish', () => restartPrimaryMedia('primary dispatcher finished'));
    const confirmed = await sendVoiceOpConfirmed(client, guildId, session.channelId, mediaKind === 'camera'
      ? { selfMute: !!session.selfMute, selfDeaf: false, selfVideo: true, selfStream: false }
      : { selfMute: !!session.selfMute, selfDeaf: false, selfVideo: false, selfStream: true }, 3000);
    if (!confirmed.ok) throw new Error(confirmed.error || 'Discord did not confirm Go Live state');
    primaryMediaFailures.delete(name);
    return { ok: true };
  } catch (error) {
    // A failed confirmation must release every object created by this attempt.
    // Most importantly, clear the synchronously cached StreamConnection when
    // its readiness promise times out. Otherwise a later start reuses the
    // half-open object instead of sending a fresh STREAM_CREATE.
    if (syntheticStreams.get(name) === active) stopSyntheticStream(name, { silent: true, invalidate: false });
    else {
      try { dispatcher?.destroy?.(); } catch {}
      cleanupPrimaryStreamAttempt(connection, streamConnection || pendingStreamConnection);
    }
    const message = error.message || 'Unable to start Go Live';
    recordPrimaryMediaFailure(name, guildId, session.channelId, mediaKind, message);
    return { ok: false, error: message };
  }
}
function voiceConnectionChannelId(connection) {
  return connection?.channel?.id ?? connection?.channelId ?? connection?.channel_id ?? null;
}
async function startSyntheticStream(name, guildId, mediaKind = 'go-live', desiredState = null) {
  const generation = Number(mediaRunGenerations.get(name) || 0);
  const sequence = ++mediaStartSequence;
  const position = mediaStartQueue.length + (mediaStartRunning ? 1 : 0) + 1;
  logMediaEvent('info', 'media.queue_enter', { sequence, account: name, guildId, mediaKind, position, queueDepth: mediaStartQueue.length + (mediaStartRunning ? 1 : 0) });
  const result = await new Promise((resolve) => {
    mediaStartQueue.push({ sequence, name, guildId, mediaKind, desiredState, generation, resolve });
    processMediaStartQueue();
  });
  return result;
}
async function processMediaStartQueue() {
  if (mediaStartRunning) return;
  mediaStartRunning = true;
  while (mediaStartQueue.length) {
    const item = mediaStartQueue.shift();
    let result;
    const startedAt = Date.now();
    logMediaEvent('info', 'media.queue_start', { sequence: item.sequence, account: item.name, guildId: item.guildId, mediaKind: item.mediaKind, queueDepth: mediaStartQueue.length });
    try {
      if (item.generation !== Number(mediaRunGenerations.get(item.name) || 0)) {
        result = { ok: false, cancelled: true, error: 'Media start cancelled by a newer account operation' };
      } else {
        result = await startSyntheticStreamUnqueued(item.name, item.guildId, item.mediaKind, item.desiredState, item.generation);
      }
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) };
    } finally {
      logMediaEvent(result?.ok ? 'info' : 'warn', 'media.queue_complete', { sequence: item.sequence, account: item.name, guildId: item.guildId, mediaKind: item.mediaKind, ok: result?.ok === true, cancelled: result?.cancelled === true, durationMs: Date.now() - startedAt, queueDepth: mediaStartQueue.length, error: result?.ok ? undefined : result?.error });
      item.resolve(result || { ok: false, error: 'Media queue item completed without a result' });
      if (MEDIA_START_GAP_MS > 0 && mediaStartQueue.length) await new Promise((resolve) => setTimeout(resolve, MEDIA_START_GAP_MS));
    }
  }
  mediaStartRunning = false;
}
function mediaQueueSnapshot() {
  return {
    running: mediaStartRunning,
    active: mediaStartRunning ? 1 : 0,
    pending: mediaStartQueue.length,
    items: mediaStartQueue.map((item, index) => ({ sequence: item.sequence, account: item.name, guildId: item.guildId, mediaKind: item.mediaKind, position: index + 1 })),
  };
}
async function startSyntheticStreamUnqueued(name, guildId, mediaKind = 'go-live', desiredState = null, generation = Number(mediaRunGenerations.get(name) || 0)) {
  const pendingRestart = pendingMediaRestarts.get(name);
  if (pendingRestart) { clearTimeout(pendingRestart); pendingMediaRestarts.delete(name); }
  const client = getClient(name);
  const isCurrentRun = () => generation === Number(mediaRunGenerations.get(name) || 0);
  const saved = voiceSessions.get(sessionKey(name, guildId)) || {};
  const observed = client ? readGatewayVoiceState(client, guildId) : null;
  const session = { ...saved, ...(observed || {}), ...(desiredState || {}) };
  for (const key of ['selfMute', 'selfDeaf', 'selfVideo', 'selfStream']) if (typeof observed?.[key] !== 'boolean' && typeof saved?.[key] === 'boolean') session[key] = saved[key];
  if (!isCurrentRun()) return { ok: false, cancelled: true, error: 'Media start cancelled by a newer account operation' };
  if (!client || !session?.channelId) return { ok: false, error: 'Account is not in a voice channel' };
  const existing = syntheticStreams.get(name);
  // Replacing a media transport must not send a voice leave for the account.
  // The primary voice connection owns room membership.
  if (existing) stopSyntheticStream(name, { invalidate: false });
  const liveTarget = await confirmLiveMediaTarget(client, guildId, session.channelId);
  if (!liveTarget.ok) {
    logMediaEvent('warn', 'media.live_target_changed', { account: name, guildId, channelId: session.channelId, mediaKind, error: liveTarget.error, first: liveTarget.first, second: liveTarget.second });
    return { ok: false, error: liveTarget.error };
  }
  logMediaEvent('info', 'media.live_target_confirmed', { account: name, guildId, channelId: session.channelId, mediaKind, confirmations: 2 });
  const startedAt = Date.now();
  const channel = client.guilds?.cache?.get?.(guildId)?.channels?.cache?.get?.(session.channelId);
  if (!channel) return { ok: false, error: 'Voice channel is not available for streaming' };
  let primaryConnection = client.voice?.connection;
  if ((!primaryConnection || String(voiceConnectionChannelId(primaryConnection)) !== String(session.channelId))
      && typeof client.voice?.joinChannel === 'function') {
    try {
      primaryConnection = await withTimeout(client.voice.joinChannel(channel, {
        selfMute: !!session.selfMute,
        selfDeaf: false,
        selfVideo: false,
      }), MEDIA_JOIN_TIMEOUT_MS, 'Primary voice connection did not become ready');
      logMediaEvent('info', 'media.primary_voice_ready', { account: name, guildId, channelId: session.channelId, mediaKind, source: 'voice.joinChannel' });
      // Some discord.js-selfbot versions update the manager's connection
      // property after the promise resolves instead of returning the exact
      // object stored there. Always re-read the canonical connection before
      // selecting the media transport.
      primaryConnection = client.voice?.connection || primaryConnection;
    } catch (error) {
      logMediaEvent('warn', 'media.primary_voice_unavailable', { account: name, guildId, channelId: session.channelId, mediaKind, error: error?.message || String(error) });
      primaryConnection = null;
    }
  }
  // Prefer the already-authenticated primary voice connection. Opening a
  // second Streamer voice connection on the same gateway is what produces the
  // observed state=184/token=missing timeout: Discord can deliver the state
  // event while omitting VOICE_SERVER_UPDATE for the competing transport.
    if (primaryConnection && typeof primaryConnection.createStreamConnection === 'function'
        && (!voiceConnectionChannelId(primaryConnection) || String(voiceConnectionChannelId(primaryConnection)) === String(session.channelId))) {
      logMediaEvent('info', 'media.primary_transport_selected', { account: name, guildId, channelId: session.channelId, mediaKind });
      const primaryResult = await startBuiltInGoLive(name, guildId, session, mediaKind, isCurrentRun);
    if (primaryResult.ok) {
      mediaDesired.set(name, { guildId, channelId: session.channelId, mediaKind });
      mediaRestartAttempts.delete(name);
      logMediaEvent('info', 'media.ready', { account: name, guildId, channelId: session.channelId, mediaKind, transport: 'primary-voice', durationMs: Date.now() - startedAt });
      return primaryResult;
    }
    // A primary StreamConnection timeout is recoverable. Its handshake has
    // been cleaned above, but do not start a second voice handshake on the
    // same Gateway identity. The old fallback created a Dedicated Streamer
    // while the primary VoiceConnection was still authoritative; that is the
    // exact condition behind the missing VOICE_SERVER_UPDATE/token entries in
    // the production log. Returning the primary error keeps one owner for the
    // voice session and lets the caller's normal retry/watchdog retry safely.
    logMediaEvent('warn', 'media.primary_transport_failed', { account: name, guildId, channelId: session.channelId, mediaKind, error: primaryResult.error, fallback: 'blocked' });
    // This is intentional protection, not an application error: a second
    // Streamer handshake would compete with the authoritative connection and
    // is the source of the missing voice-token failures.
    logMediaEvent('warn', 'media.dedicated_fallback_blocked', { account: name, guildId, channelId: session.channelId, mediaKind, reason: 'primary-voice-connection-exists' });
    return primaryResult;
  }
  logMediaEvent('warn', 'media.primary_transport_unavailable', { account: name, guildId, channelId: session.channelId, mediaKind, hasConnection: !!primaryConnection, connectionChannelId: voiceConnectionChannelId(primaryConnection), hasCreateStreamConnection: typeof primaryConnection?.createStreamConnection === 'function' });
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let streamer;
    let controller;
    let source;
    let createdStreamer = false;
    let stage = 'module';
    try {
      const { Streamer, playStream } = await loadVideoStreamModule();
      if (!isCurrentRun()) return { ok: false, cancelled: true, error: 'Media start cancelled by a newer account operation' };
      logMediaEvent('info', 'media.module_ready', { account: name, guildId, channelId: session.channelId, mediaKind, attempt });
      // Each media run gets a fresh transport. Reusing a finished transport can
      // silently stop the next camera or Go Live session.
      streamer = new Streamer(client);
      stage = 'streamer-created';
      logMediaEvent('info', 'media.streamer_created', { account: name, guildId, channelId: session.channelId, mediaKind, attempt });
      mediaStreamers.set(name, streamer);
      createdStreamer = true;
      installVoiceEventFilter(streamer, client.user?.id, guildId, session.channelId);
      // The library calls signalVideo(false) from joinVoice(). Its default
      // payload also sets self_deaf=true, which can override the account's
      // primary voice state and break the dedicated media handshake. Keep the
      // historical payload used by the working media path.
      streamer.signalVideo = (enabled) => streamer.sendOpcode(4, {
        guild_id: guildId,
        channel_id: session.channelId,
        self_mute: !!session.selfMute,
        self_deaf: false,
        self_video: !!enabled,
      });
      // A fresh Streamer can expose a placeholder voiceConnection before its
      // gateway/WebRTC handshake is complete. Always call joinVoice for a new
      // transport; checking only the object existence can skip the handshake
      // and leave the media connection waiting until the timeout.
      stage = 'join-voice';
      logMediaEvent('info', 'media.join.start', { account: name, guildId, channelId: session.channelId, mediaKind, attempt });
      logMediaEvent('info', 'media.join.waiting_gateway', { account: name, guildId, channelId: session.channelId, mediaKind, attempt, timeoutMs: MEDIA_JOIN_TIMEOUT_MS });
      await joinMediaVoiceWithDiagnostics(client, streamer, guildId, session.channelId, MEDIA_JOIN_TIMEOUT_MS, { account: name, mediaKind, attempt });
      if (!isCurrentRun()) throw new Error('Media start cancelled by a newer account operation');
      logMediaEvent('info', 'media.join.ready', { account: name, guildId, channelId: session.channelId, mediaKind, attempt });
      controller = new AbortController();
      source = createBlackMediaSource();
      stage = 'ffmpeg-output';
      await waitForMediaSource(source);
      logMediaEvent('info', 'media.ffmpeg_ready', { account: name, guildId, channelId: session.channelId, mediaKind, attempt, pid: source.sourceProcess.pid });
      const active = { streamer, controller, sourceProcess: source.sourceProcess, guildId, channelId: session.channelId, mediaKind, startedAt };
      syntheticStreams.set(name, active);
      const task = playStream(source.stream, streamer, { type: mediaKind, format: 'nut', width: 640, height: 360, frameRate: 15 }, controller.signal);
      if (!isCurrentRun()) throw new Error('Media start cancelled by a newer account operation');
      stage = 'webrtc-ready';
      active.task = task;
      task.then(() => {
        active.completedAt = Date.now();
        if (syntheticStreams.get(name) === active) {
          // The media transport ended; keep the primary voice session alive
          // while a replacement transport is scheduled.
          stopSyntheticStream(name, { preserveRestartState: true });
          scheduleMediaRestart(name, active, 'media task ended');
        }
      }).catch((error) => {
        logMediaEvent('error', 'media.runtime_failed', { account: name, guildId, channelId: session.channelId, mediaKind, error: error?.message || String(error) });
        if (syntheticStreams.get(name) === active) {
          // Runtime media failures must not turn into a voice-room leave.
          stopSyntheticStream(name, { preserveRestartState: true });
          scheduleMediaRestart(name, active, error?.message || 'media task failed');
        }
      });
      await withTimeout(new Promise((resolve) => {
        const check = () => {
          const voiceReady = streamer.voiceConnection?.webRtcConn?.ready === true;
          const mediaReady = mediaKind === 'camera' || streamer.voiceConnection?.streamConnection?.webRtcConn?.ready === true;
          if (voiceReady && mediaReady) return resolve();
          setTimeout(check, 150);
        };
        check();
      }), MEDIA_WEBRTC_TIMEOUT_MS, `WebRTC media transport was not ready after ${Math.round(MEDIA_WEBRTC_TIMEOUT_MS / 1000)} seconds`);
      logMediaEvent('info', 'media.webrtc_ready', { account: name, guildId, channelId: session.channelId, mediaKind, attempt });
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
      mediaDesired.set(name, { guildId, channelId: session.channelId, mediaKind });
      mediaRestartAttempts.delete(name);
      logMediaEvent('info', 'media.ready', { account: name, guildId, channelId: session.channelId, mediaKind, durationMs: Date.now() - startedAt, attempt });
      return { ok: true };
    } catch (error) {
      lastError = error;
      try { controller?.abort?.(); } catch {}
      try { source?.sourceProcess?.kill?.('SIGTERM'); } catch {}
      // Clean up only this failed media transport. The account may still be
      // connected to the primary voice room.
      try { streamer?.stopStream?.(); } catch {}
      try { streamer?.voiceConnection?.stop?.(); } catch {}
      try { streamer?._gatewayEmitter?.removeAllListeners?.(); } catch {}
      try { if (streamer) streamer._voiceConnection = undefined; } catch {}
      if (syntheticStreams.get(name)?.streamer === streamer) syntheticStreams.delete(name);
      if (createdStreamer && mediaStreamers.get(name) === streamer) mediaStreamers.delete(name);
      logMediaEvent('error', 'media.attempt_failed', { account: name, guildId, channelId: session.channelId, mediaKind, attempt, stage, error: error?.message || String(error) });
      if (attempt < 2) {
        // A missing session/token is a gateway ordering failure, not an FFmpeg
        // failure. Give Discord time to publish the replacement voice server
        // update before constructing the next dedicated transport.
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
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
  // Room rotation owns membership only. Media flags are intentionally omitted
  // here because the state cycle owns Stream/Camera and restarting a media
  // transport inside a room move can block the move on VOICE_SERVER_UPDATE.
  const roomState = { selfMute: !!opts.selfMute, selfDeaf: !!opts.selfDeaf };
  const start = Math.max(0, ids.indexOf(preferredChannelId));
  const ordered = [...ids.slice(start), ...ids.slice(0, start)];
  let last = { name, ok: false, error: 'All rotation rooms failed', attemptedChannels: [] };
  const wasOutsideRoom = !voiceSessions.has(sessionKey(name, task.guildId));
  const mediaVariants = [roomState];
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
function watchdogKey(kind, id, account) { return `${kind}:${id}:${account}`; }
function watchdogIsMismatch(key, mismatch) {
  const previous = watchdogObservations.get(key) || { misses: 0, lastRepairAt: 0 };
  if (!mismatch) {
    watchdogObservations.delete(key);
    return false;
  }
  previous.misses += 1;
  watchdogObservations.set(key, previous);
  return previous.misses >= WATCHDOG_CONFIRMATION_MISSES
    && Date.now() - previous.lastRepairAt >= WATCHDOG_REPAIR_COOLDOWN_MS;
}
function watchdogMarkRepair(key) {
  const previous = watchdogObservations.get(key) || { misses: 0 };
  previous.lastRepairAt = Date.now();
  previous.misses = 0;
  watchdogObservations.set(key, previous);
}
function voiceStateMatchesExpected(actual, expected) {
  if (!actual?.channelId || !expected) return false;
  return ['selfMute', 'selfDeaf', 'selfVideo', 'selfStream']
    .every((key) => expected[key] === undefined || !!actual[key] === !!expected[key]);
}
async function watchdogRotation(task, account) {
  const client = getClient(account);
  if (!client || !task.active || task.running) return;
  if (accountOperations.has(operationKey(account, task.guildId))) return;
  const key = watchdogKey('rotation', task.id, account);
  const actual = readGatewayVoiceState(client, task.guildId);
  const expectedChannel = task.accountTargets?.[account] || rotationPreferredChannel(account, task, 0);
  const mismatch = !actual?.channelId || String(actual.channelId) !== String(expectedChannel);
  if (!watchdogIsMismatch(key, mismatch)) return;
  logMediaEvent('warn', 'watchdog.rotation_repair', { account, guildId: task.guildId, expectedChannel, actualChannel: actual?.channelId || null });
  const result = await moveRotationAccount(account, task, expectedChannel, normalizeVoiceState(actual || {}));
  watchdogMarkRepair(key);
  emitLive('watchdog.repair', { type: 'rotation', account, taskId: task.id, result });
}
async function watchdogStateCycle(task, account) {
  const client = getClient(account);
  if (!client || !task.active || task.running) return;
  if (accountOperations.has(operationKey(account, task.guildId))) return;
  const key = watchdogKey('cycle', task.id, account);
  const actual = readGatewayVoiceState(client, task.guildId);
  const expected = task.states?.[task.accountStateIdx?.[account]];
  // A state cycle cannot infer a room that was never joined. It only repairs
  // flags for an existing confirmed voice session; rotations repair rooms.
  const mismatch = !!actual?.channelId && !voiceStateMatchesExpected(actual, expected);
  if (!watchdogIsMismatch(key, mismatch)) return;
  logMediaEvent('warn', 'watchdog.state_repair', { account, guildId: task.guildId, expected, actual });
  const result = await withAccountLock(account, () => executeStateForAccount(account, task, expected || {}));
  watchdogMarkRepair(key);
  emitLive('watchdog.repair', { type: 'state-cycle', account, taskId: task.id, result });
}
async function watchdogMedia(session) {
  const client = getClient(session.name);
  if (!client || !session.channelId) return;
  // Do not revive stale selfVideo/selfStream flags restored from disk after a
  // process restart. Only repair media that was confirmed successfully during
  // this process; normal rotation/state tasks can explicitly start it again.
  const desired = mediaDesired.get(session.name);
  if (!desired || String(desired.guildId) !== String(session.guildId) || String(desired.channelId) !== String(session.channelId)) return;
  const expectedKind = session.selfStream ? 'go-live' : session.selfVideo ? 'camera' : null;
  const key = watchdogKey('media', session.name, session.guildId);
  const active = syntheticStreams.get(session.name);
  const primaryTransport = active?.connection && active?.streamConnection;
  const dedicatedTransport = active?.streamer?.voiceConnection;
  const voiceReady = primaryTransport
    ? active.connection.status === 0
    : dedicatedTransport?.webRtcConn?.ready === true;
  const mediaReady = primaryTransport
    ? active.streamConnection.status === 0
    : expectedKind === 'camera'
      ? voiceReady
      : dedicatedTransport?.streamConnection?.webRtcConn?.ready === true;
  // Primary playVideo owns the FFmpeg process internally and uses the shared
  // file, so there is no sourceProcess to inspect in that transport.
  const sourceReady = primaryTransport
    ? !!active?.dispatcher && active.dispatcher.destroyed !== true
    : !!active?.sourceProcess && active.sourceProcess.exitCode === null && !active.sourceProcess.killed;
  const mismatch = !!expectedKind && (!active || !voiceReady || !mediaReady || !sourceReady) && !pendingMediaRestarts.has(session.name);
  if (!watchdogIsMismatch(key, mismatch)) return;
  logMediaEvent('warn', 'watchdog.media_repair', { account: session.name, guildId: session.guildId, channelId: session.channelId, mediaKind: expectedKind });
  const result = await withAccountLock(session.name, () => startSyntheticStream(session.name, session.guildId, expectedKind, session));
  watchdogMarkRepair(key);
  emitLive('watchdog.repair', { type: 'media', account: session.name, result });
}
async function runVoiceWatchdog() {
  if (watchdogRunning) return;
  watchdogRunning = true;
  try {
    const repairs = [
      ...[...rotations.values()].flatMap((task) => (task.accounts || []).map((account) => () => watchdogRotation(task, account).catch((error) => logMediaEvent('error', 'watchdog.rotation_failed', { account, taskId: task.id, error: error.message })))),
      ...[...stateCycles.values()].flatMap((task) => (task.accounts || []).map((account) => () => watchdogStateCycle(task, account).catch((error) => logMediaEvent('error', 'watchdog.state_failed', { account, taskId: task.id, error: error.message })))),
    ];
    await mapWithConcurrency(repairs, 4, (repair) => repair());
    const mediaSessions = [...voiceSessions.values()].filter((session) => session.selfStream || session.selfVideo);
    await mapWithConcurrency(mediaSessions, 2, (session) => watchdogMedia(session));
    for (const session of playingSessions.values()) {
      const key = watchdogKey('playing', session.account, session.account);
      const mismatch = session.active === true && !session.running && !session.timer;
      if (watchdogIsMismatch(key, mismatch)) {
        schedulePlaying(session);
        watchdogMarkRepair(key);
        emitLive('watchdog.repair', { type: 'playing', account: session.account });
      }
    }
  } finally {
    watchdogRunning = false;
  }
}
function startVoiceWatchdog() {
  const timer = setInterval(() => { runVoiceWatchdog().catch((error) => logMediaEvent('error', 'watchdog.failed', { error: error.message })); }, WATCHDOG_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
function markTokenChanged(name, token, error) {
  const previous = clients.get(name);
  if (previous?.token && previous.token !== token) return;
  stopTasksForAccount(name);
  playingSessions.delete(name);
  persistPlayingSessions();
  stopSyntheticStream(name, { leaveVoice: true });
  removeSessionsForAccount(name);
  try { previous?.client?.destroy?.(); } catch {}
  // Invalid credentials are not accounts. Do not keep a placeholder entry:
  // clients.size drives the counter, preview, account selector, and persistence.
  clients.delete(name);
  persistConnectedAccounts();
  emitLive('account.removed', { name, reason: 'invalid-token', error: error?.message || String(error || 'Login failed') });
}
async function connectOneWithRetry(token, name) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await connectOne(token, name); }
    catch (error) {
      lastError = error;
      // A temporary gateway/network/rate-limit failure is not evidence that
      // Discord rotated or revoked the token. Do not label or destroy the
      // account for that case; the caller can retry it later.
      if (isInvalidCredentialError(error)) break;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const finalName = String(name || '').trim().slice(0, 48) || `account-${clients.size + 1}`;
  if (isInvalidCredentialError(lastError)) {
    markTokenChanged(finalName, String(token || '').trim(), lastError);
    throw new Error('Invalid Discord token: Discord rejected the token or it was revoked');
  }
  throw new Error(`Temporary Discord connection failure after retry: ${lastError?.message || 'Gateway unavailable'}`);
}
function rotationControlledAccounts(guildId) {
  const controlled = new Set();
  for (const task of rotations.values()) {
    if (String(task.guildId) !== String(guildId)) continue;
    for (const name of task.accounts || []) controlled.add(name);
  }
  return controlled;
}
// Voice, camera, and Go Live all share one Discord gateway identity per
// account. Scope operation supersession to the account, not the guild: a room
// move in one guild must cancel stale media/state work started for that
// account elsewhere as well. Keeping guildId in the operation is still useful
// for diagnostics and callers.
function operationKey(name) { return String(name); }
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
  const activeTasks = type === 'rotation' ? rotations.values() : stateCycles.values();
  for (const task of activeTasks) {
    if (String(task.guildId) !== String(guildId)) continue;
    const overlap = accounts.filter((name) => (task.accounts || []).includes(name));
    if (overlap.length) conflicts.push({ id: task.id, accounts: overlap });
  }
  return conflicts;
}
function taskAccountConflicts(accounts, guildId, type) { return taskConflict(accounts, guildId, type).flatMap((item) => item.accounts); }
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
    const optionalFalseFlags = new Set(Array.isArray(opts.confirmOmittedFalseFlags) ? opts.confirmOmittedFalseFlags : []);

    let settled = false;
    let timer = null;
    let verifyTimer = null;
    const cleanup = () => {
      try { client.ws?.off?.('VOICE_STATE_UPDATE', onWsState); } catch {}
      try { client.off?.('voiceStateUpdate', onJsState); } catch {}
      if (timer) clearTimeout(timer);
      if (verifyTimer) clearTimeout(verifyTimer);
      timer = null;
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
      const payload = data?.d?.d || data?.d || data;
      const eventUserId = payload?.user_id ?? payload?.userId ?? payload?.member?.user?.id;
      const eventGuildId = payload?.guild_id ?? payload?.guildId ?? payload?.guild?.id;
      const eventChannelId = payload?.channel_id ?? payload?.channelId ?? payload?.channel?.id ?? null;
      if (!payload || String(eventUserId) !== String(userId) || !matches(eventGuildId, eventChannelId)) return false;
      const flags = [
        ['self_mute', 'selfMute'], ['self_deaf', 'selfDeaf'], ['self_video', 'selfVideo'], ['self_stream', 'selfStream'],
      ];
      return flags.every(([wire, local]) => {
        if (opts[local] === undefined) return true;
        const reported = payload[wire] ?? payload[local];
        if (reported === undefined) return opts[local] === false && optionalFalseFlags.has(local);
        return !!reported === !!opts[local];
      });
    };
    const cachedStateMatches = () => {
      const state = readGatewayVoiceState(client, guildId);
      if (!state || (channelId != null && String(state.channelId) !== String(channelId))) return false;
      return Object.entries(opts).every(([key, value]) => !['selfMute', 'selfDeaf', 'selfVideo', 'selfStream'].includes(key)
        || (state[key] === undefined ? value === false && optionalFalseFlags.has(key) : !!state[key] === !!value));
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
        return observed[key] === undefined ? value === false && optionalFalseFlags.has(key) : !!observed[key] === !!value;
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

    const sent = sendVoiceOp(client, guildId, channelId, opts);
    if (!sent.ok) return finish(sent);
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
  if (!state || String(state.guild?.id || state.guildId || guildId) !== String(guildId)) return fallback ? { ...fallback, ...normalizeExclusiveVoiceState(fallback) } : fallback;
  const observed = {
    guildId: state.guild?.id || state.guildId || guildId,
    channelId: state.channelId ?? state.channel_id ?? null,
    selfMute: !!(state.selfMute ?? state.self_mute),
    selfDeaf: !!(state.selfDeaf ?? state.self_deaf),
    selfVideo: !!(state.selfVideo ?? state.self_video),
    selfStream: !!(state.streaming ?? state.selfStream ?? state.self_stream),
  };
  return { ...observed, ...normalizeExclusiveVoiceState(observed) };
}
async function waitForConfirmedVoiceChannel(client, guildId, channelId, connection = null, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const observed = readGatewayVoiceState(client, guildId);
    const returnedChannel = voiceConnectionChannelId(connection);
    last = observed || (returnedChannel ? { channelId: returnedChannel } : null);
    if (String(observed?.channelId || returnedChannel || '') === String(channelId)) return { ok: true, state: observed || { channelId } };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ok: false, state: last, error: `Discord did not confirm the target room ${channelId} in time` };
}
async function confirmLiveMediaTarget(client, guildId, channelId, delayMs = 120) {
  const read = () => {
    const rawTarget = validateMediaTarget(client, guildId, channelId);
    const target = {
      ok: rawTarget.ok,
      error: rawTarget.error || null,
      guildId: rawTarget.guild?.id ?? String(guildId),
      channelId: rawTarget.channel?.id ?? String(channelId),
      channelType: rawTarget.channel?.type ?? null,
      channelName: rawTarget.channel?.name ?? null,
      userLimit: rawTarget.channel?.userLimit ?? null,
      memberCount: rawTarget.channel?.members?.size ?? null,
    };
    const state = readGatewayVoiceState(client, guildId);
    const matches = rawTarget.ok && state?.channelId != null && String(state.channelId) === String(channelId);
    return { target, state, matches };
  };
  const first = read();
  if (!first.matches) return { ok: false, error: 'Live voice target changed or is no longer available', first };
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  const second = read();
  if (!second.matches) return { ok: false, error: 'Live voice target changed during confirmation', first, second };
  return { ok: true, guildId: String(guildId), channelId: String(channelId), first, second };
}
function upsertSession(name, guildId, channelId, opts = {}) {
  const previous = voiceSessions.get(sessionKey(name, guildId));
  const flags = normalizeExclusiveVoiceState({
    selfMute: opts.selfMute !== undefined ? opts.selfMute : previous?.selfMute,
    selfDeaf: opts.selfDeaf !== undefined ? opts.selfDeaf : previous?.selfDeaf,
    selfVideo: opts.selfVideo !== undefined ? opts.selfVideo : previous?.selfVideo,
    selfStream: opts.selfStream !== undefined ? opts.selfStream : previous?.selfStream,
  });
  voiceSessions.set(sessionKey(name, guildId), {
    name, guildId, channelId,
    ...flags,
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
    if (!entry?.client) continue;
    for (const session of [...voiceSessions.values()].filter((item) => item.name === name)) {
      const actual = readGatewayVoiceState(entry.client, session.guildId);
      if (!actual || !actual.channelId) {
        // A dedicated media transport can briefly report no voice state while
        // its replacement Streamer is being created. Keep the confirmed
        // session during the bounded restart window.
        if (pendingMediaRestarts.has(name) && session.channelId) continue;
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
  pendingRoomMoves.add(name);
  try { return await withAccountLock(name, () => moveAccountLocked(name, guildId, channelId, opts)); }
  finally { pendingRoomMoves.delete(name); }
}
async function moveAccountLocked(name, guildId, channelId, opts = {}) {
  return (async () => {
    const client = getClient(name);
    if (!client) return { name, ok: false, error: 'Account is not connected' };
    const operation = beginAccountOperation(name, guildId, 'move');
    const target = validateTarget(client, guildId, channelId);
    if (!target.ok) { endAccountOperation(operation); return { name, ok: false, error: target.error }; }
    const saved = voiceSessions.get(sessionKey(name, guildId));
    const observed = readGatewayVoiceState(client, guildId);
    const current = { ...(saved || {}), ...(observed || {}) };
    for (const key of ['selfMute', 'selfDeaf', 'selfVideo', 'selfStream']) if (typeof observed?.[key] !== 'boolean' && typeof saved?.[key] === 'boolean') current[key] = saved[key];
    const hasCanonicalConnection = client.voice?.connection
      && String(voiceConnectionChannelId(client.voice.connection)) === String(channelId);
    if (current?.channelId === channelId && hasCanonicalConnection) {
      endAccountOperation(operation);
      return { name, ok: true, alreadyIn: true, channelId };
    }
    // Moving rooms is deliberately a voice-membership operation only. Media
    // state is re-applied by the independent state-cycle task after the move.
    const desired = normalizeVoiceState({ ...(current || {}), ...opts, selfVideo: false, selfStream: false });
    // The primary discord.js voice state owns room membership. A media
    // Streamer must be torn down without sending its own OP4 leave request;
    // doing so races the move below and can suppress VOICE_SERVER_UPDATE for
    // the next media connection.
    if (syntheticStreams.has(name) || mediaStreamers.has(name)) stopSyntheticStream(name, { silent: true });
    // Prefer VoiceManager.joinChannel(). It owns the complete
    // VOICE_STATE_UPDATE/VOICE_SERVER_UPDATE handshake and stores the
    // canonical connection in client.voice.connection. Sending OP4 here and
    // then creating a Streamer creates competing handshakes on one Gateway
    // identity; Discord can deliver the state event to one transport and the
    // server event to the other.
    let result;
    const voiceChannel = client.guilds?.cache?.get?.(guildId)?.channels?.cache?.get?.(channelId);
    if (voiceChannel && typeof client.voice?.joinChannel === 'function') {
      try {
        const connection = await withTimeout(client.voice.joinChannel(voiceChannel, {
          selfMute: !!desired.selfMute,
          selfDeaf: !!desired.selfDeaf,
          selfVideo: false,
        }), MEDIA_JOIN_TIMEOUT_MS, 'Primary voice connection did not become ready');
        result = { ok: true, connection };
      } catch (error) {
        result = { ok: false, error: error?.message || 'Primary voice connection failed' };
      }
    } else {
      result = await sendVoiceOpConfirmed(client, guildId, channelId, { ...desired, selfVideo: false, selfStream: false });
    }
    if (!operationIsCurrent(operation)) { endAccountOperation(operation); return { name, ok: false, stale: true, error: 'Voice move was superseded by a newer request' }; }
    if (result.ok) {
      const confirmation = await waitForConfirmedVoiceChannel(client, guildId, channelId, result.connection);
      const confirmed = confirmation.state;
      if (!confirmation.ok) {
        logMediaEvent('warn', 'voice.room_move_unconfirmed', { account: name, guildId, channelId, observedChannelId: confirmed?.channelId || null, error: confirmation.error });
        endAccountOperation(operation);
        return { name, ok: false, error: confirmation.error, channelId };
      }
      for (const key of [...voiceSessions.keys()]) if (key.startsWith(`${name}__`) && key !== sessionKey(name, guildId)) voiceSessions.delete(key);
      const actual = confirmed;
      upsertSession(name, guildId, channelId, { ...desired, ...(actual || {}), selfVideo: false, selfStream: false });
    }
    endAccountOperation(operation);
    return { name, ok: result.ok, error: result.ok ? null : result.error, channelId };
  })();
}

function renamePersistedAccount(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  for (const [key, session] of [...voiceSessions.entries()]) {
    if (session.name !== oldName) continue;
    voiceSessions.delete(key);
    voiceSessions.set(sessionKey(newName, session.guildId), { ...session, name: newName });
  }
  for (const task of [...rotations.values(), ...stateCycles.values()]) {
    task.accounts = (task.accounts || []).map((account) => account === oldName ? newName : account);
    if (task.accountTargets?.[oldName]) {
      task.accountTargets[newName] = task.accountTargets[oldName];
      delete task.accountTargets[oldName];
    }
    if (task.accountStatus?.[oldName]) {
      task.accountStatus[newName] = task.accountStatus[oldName];
      delete task.accountStatus[oldName];
    }
  }
  const playing = playingSessions.get(oldName);
  if (playing) {
    playingSessions.delete(oldName);
    playingSessions.set(newName, { ...playing, account: newName });
  }
  persistSessions();
  persistAutomationTasks();
  persistPlayingSessions();
}
function normalizeConnectedAccountNames() {
  let changed = false;
  for (const [oldName, entry] of [...clients.entries()]) {
    if (!/^account-\d+$/i.test(oldName)) continue;
    const preferred = String(entry.client?.user?.globalName || entry.client?.user?.username || entry.client?.user?.tag || entry.client?.user?.id || '').trim().slice(0, 48);
    if (!preferred || preferred === oldName || clients.has(preferred)) continue;
    clients.delete(oldName);
    clients.set(preferred, entry);
    renamePersistedAccount(oldName, preferred);
    emitLive('account.renamed', { oldName, name: preferred });
    changed = true;
  }
  if (changed) persistConnectedAccounts();
  return changed;
}

async function connectOne(token, name) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('A Discord token is required');
  let finalName = String(name || '').trim().slice(0, 48);
  const normalizedToken = token.trim();
  const existing = [...clients.entries()].find(([, entry]) => String(entry.token || '').trim().toLowerCase() === normalizedToken.toLowerCase());
  if (existing) throw new Error(`Duplicate token: already connected as ${existing[0]}`);
  if (connectingTokens.has(normalizedToken)) throw new Error('Duplicate token: connection already in progress');
  connectingTokens.add(normalizedToken);
  const client = new Client({ checkUpdate: false, fetchAllMembers: false });
  try { await client.login(normalizedToken); }
  finally { connectingTokens.delete(normalizedToken); }
  const generatedAlias = /^account-\d+$/i.test(finalName);
  if (!finalName || generatedAlias) {
    const discordName = client.user?.globalName || client.user?.username || client.user?.tag || client.user?.id;
    const previousName = finalName;
    finalName = String(discordName || `account-${clients.size + 1}`).trim().slice(0, 48);
    if (generatedAlias) renamePersistedAccount(previousName, finalName);
  }
  const duplicateName = [...clients.keys()].find((accountName) => accountName.toLowerCase() === finalName.toLowerCase());
  if (duplicateName) {
    stopTasksForAccount(duplicateName);
    stopSyntheticStream(duplicateName, { leaveVoice: true });
    try { await clients.get(duplicateName)?.client?.destroy?.(); } catch {}
    clients.delete(duplicateName);
  }
  const entry = { client, token: normalizedToken, savedAt: Date.now(), connectedAt: Date.now(), lastSeenAt: Date.now(), lastError: null };
  clients.set(finalName, entry);
  persistConnectedAccounts();
  const markError = (error) => {
    if (isInvalidCredentialError(error)) {
      markTokenChanged(finalName, normalizedToken, error);
      return;
    }
    entry.lastError = redact(error?.message || String(error || 'Unknown Discord client error'));
    entry.lastSeenAt = Date.now();
    emitLive('account.health.changed', { account: accountHealth(finalName, entry) });
  };
  client.on?.('error', markError);
  client.on?.('ready', () => { entry.lastError = null; entry.lastSeenAt = Date.now(); emitLive('account.health.changed', { account: accountHealth(finalName, entry) }); });
  client.on?.('disconnect', () => { entry.lastSeenAt = Date.now(); emitLive('account.health.changed', { account: accountHealth(finalName, entry) }); });
  client.on?.('messageCreate', (message) => { handlePlayingDiscordCommand(client, message).catch((error) => console.warn('[playing-command] failed:', error.message)); });
  emitLive('account.connected', { account: accountHealth(finalName, entry) });

  // Restore only the channel state; media capture remains browser-owned and must be
  // explicitly re-enabled by the user after reconnecting. Use VoiceManager here
  // as well: sending OP4 alone restores Discord's visible state but does not
  // create client.voice.connection, which would force the next media start into
  // the competing dedicated Streamer fallback.
  setTimeout(() => {
    for (const session of voiceSessions.values()) {
      if (session.name !== finalName) continue;
      const channel = client.guilds?.cache?.get?.(session.guildId)?.channels?.cache?.get?.(session.channelId);
      if (!channel || typeof client.voice?.joinChannel !== 'function') {
        logMediaEvent('warn', 'voice.restore.unavailable', { account: finalName, guildId: session.guildId, channelId: session.channelId, reason: 'VoiceManager or channel unavailable' });
        return;
      }
      client.voice.joinChannel(channel, {
        selfMute: !!session.selfMute,
        selfDeaf: !!session.selfDeaf,
        selfVideo: false,
      }).then(() => {
        logMediaEvent('info', 'voice.restore.ready', { account: finalName, guildId: session.guildId, channelId: session.channelId });
      }).catch((error) => {
        logMediaEvent('warn', 'voice.restore.failed', { account: finalName, guildId: session.guildId, channelId: session.channelId, error: error?.message || String(error) });
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
app.get('/api/health', (_req, res) => ok(res, { service: 'voice-studio', connected: clients.size, watchdog: { enabled: true, intervalMs: WATCHDOG_INTERVAL_MS, running: watchdogRunning, observations: watchdogObservations.size }, accounts: [...clients.entries()].map(([name, entry]) => accountHealth(name, entry)) }));
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
  normalizeConnectedAccountNames();
  const sessionByName = new Map([...voiceSessions.values()].map((session) => [session.name, session]));
  return ok(res, { clients: [...clients.entries()].map(([name, entry]) => {
    const user = entry.client?.user;
    const savedVoice = sessionByName.get(name) || null;
    const actualVoice = entry.client ? readGatewayVoiceState(entry.client, savedVoice?.guildId || '') || null : null;
    const voice = actualVoice?.channelId ? { ...(savedVoice || {}), ...actualVoice, name } : savedVoice;
    const guild = voice && entry.client ? entry.client.guilds?.cache?.get?.(voice.guildId) : null;
    const member = guild?.members?.cache?.get?.(user?.id);
    const channel = voice ? guild?.channels?.cache?.get?.(voice.channelId) : null;
    return {
      name,
      username: user?.tag || user?.username || name,
      displayName: user?.globalName || user?.username || name,
      nickname: member?.displayName || user?.globalName || user?.username || name,
      id: user?.id || null,
      avatar: user?.displayAvatarURL?.({ size: 128 }) || null,
      status: entry.invalidToken ? 'offline' : (user?.presence?.status || 'online'),
      health: accountHealth(name, entry),
      voice: voice ? { guildId: voice.guildId, guildName: guild?.name || voice.guildId, guildIcon: guild?.iconURL?.({ size: 64 }) || null, channelId: voice.channelId, channelName: channel?.name || voice.channelId, selfMute: !!voice.selfMute, selfDeaf: !!voice.selfDeaf, selfVideo: !!voice.selfVideo, selfStream: !!voice.selfStream } : null,
    };
  }) });
});
app.post('/api/discord/connect', async (req, res) => {
  try { return ok(res, await connectOneWithRetry(req.body?.token, req.body?.name)); }
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
      results[index] = await connectOneWithRetry(item.token, item.name)
        .then((result) => ({ ok: true, ...result }))
        .catch((error) => ({ ok: false, name: item.name || `bulk-${index + 1}`, error: error.message }));
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
  try { await entry.client?.destroy?.(); } catch {}
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
      try { await entry.client?.destroy?.(); } catch (error) { return { name, ok: false, error: error.message }; }
      clients.delete(name);
      emitLive('account.disconnected', { name });
      return { name, ok: true };
    }));
  persistConnectedAccounts();
  return ok(res, { results, summary: summary(results) });
});
app.post('/api/discord/disconnect-all', async (_req, res) => {
  for (const name of clients.keys()) { stopTasksForAccount(name); stopSyntheticStream(name, { leaveVoice: true }); }
  for (const entry of clients.values()) { try { await entry.client?.destroy?.(); } catch {} }
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
    if (!entry?.client) continue;
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
app.get('/api/voice/media-queue', (_req, res) => ok(res, { queue: mediaQueueSnapshot() }));
app.get('/api/voice/target-accounts', (req, res) => {
  const guildId = String(req.query?.guildId || '').trim();
  const channelId = String(req.query?.channelId || '').trim();
  if (!guildId || !channelId) return fail(res, new Error('guildId and channelId are required'), 400);
  const accounts = [...clients.entries()].map(([name, entry]) => {
    const user = entry.client?.user;
    const guild = entry.client?.guilds?.cache?.get?.(guildId);
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
    if (!entry?.client) continue;
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
app.post('/api/playing/add-accounts', async (req, res) => {
  const sourceAccount = String(req.body?.sourceAccount || '').trim();
  const accounts = cleanAccounts(req.body?.accounts);
  if (!sourceAccount || !accounts.length) return fail(res, new Error('sourceAccount and at least one account are required'), 400);
  const result = await addPlayingAccounts(sourceAccount, accounts);
  if (!result.ok) return fail(res, new Error(result.error || 'No accounts were added'), 400, { results: result.results || [] });
  return ok(res, { ...result, sessions: [...playingSessions.values()].map(({ timer, ...item }) => item) });
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
  // Leaving is intentionally fast and idempotent. Wrapping it in the normal
  // three-attempt retry helper multiplied a 5s gateway confirmation into a
  // request long enough for Railway/browser fetch to time out.
  const results = await mapWithConcurrency(accounts, 12, (name) => withAccountLock(name, async () => {
    const client = getClient(name);
    if (!client) return { name, ok: false, error: 'Account is not connected' };
    const current = readGatewayVoiceState(client, guildId) || voiceSessions.get(sessionKey(name, guildId));
    // A manual leave only removes the current room session. Keep the account
    // in its active rotation so the next tick can join it again.
    if (!current?.channelId) { removeSessionsForAccount(name, guildId); return { name, ok: true, alreadyLeft: true }; }
    stopSyntheticStream(name, { leaveVoice: true });
    const result = await sendVoiceOpConfirmed(client, guildId, null, {}, 2500);
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
    const next = normalizeExclusiveVoiceState({
      selfMute: selfMute !== undefined ? selfMute : !!current.selfMute,
      selfDeaf: selfDeaf !== undefined ? selfDeaf : enablingMedia ? false : !!current.selfDeaf,
      selfVideo: selfVideo !== undefined ? selfVideo : !!current.selfVideo,
      selfStream: selfStream !== undefined ? selfStream : !!current.selfStream,
    });
    if (next.selfDeaf && (next.selfVideo || next.selfStream)) { endAccountOperation(operation); return { name, ok: false, error: 'Video or screen share cannot be enabled while deafened' }; }
    // Use the same settle window as state rotation before touching media. The
    // account lock above prevents concurrent operations for this account, and
    // rotationControlledAccounts prevents Quick controls from racing a room
    // rotation in the same guild.
    if (current.selfStream || current.selfVideo || syntheticStreams.has(name)) stopSyntheticStream(name, { leaveVoice: false });
    const cleared = await clearVoiceFlags(client, guildId, current.channelId, current);
    if (!cleared.ok) { endAccountOperation(operation); return { name, ok: false, error: `Unable to clear previous voice state: ${cleared.error}` }; }
    await waitForMediaSettle(next, current);
    let result;
    if (next.selfStream || next.selfVideo) {
      // Stop the previous transport/state before starting the replacement
      // media mode. This prevents a stale mute/deafen or old camera transport
      // from surviving into Go Live.
      result = await startSyntheticStream(name, guildId, next.selfStream ? 'go-live' : 'camera', next);
    }
    else {
      result = await sendVoiceOpConfirmed(client, guildId, current.channelId, next, 6000);
    }
    if (!operationIsCurrent(operation)) { endAccountOperation(operation); return { name, ok: false, stale: true, error: 'Voice operation was superseded by a newer request' }; }
    if (result.ok) {
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
  const id = crypto.randomUUID();
  const task = { id, accounts, guildId, guildName: guildName || guildId, channels: channelIds, intervalMs: delay, randomOrder: !!randomOrder, currentIdx: 0, startedAt: Date.now(), nextAt: Date.now() + delay, accountStatus: {}, accountTargets: {}, running: true, active: true, initializing: true, lastResults: [] };
  // Register and persist the task before moving any account. Joining a voice
  // room can take several seconds per account; keeping this request open made
  // the browser report "Failed to fetch" and left no automation visible.
  rotations.set(id, task);
  persistAutomationTasks();
  emitLive('task.started', { id: task.id, taskType: 'rotation', initializing: true, accounts: task.accounts });
  const runInitial = async () => {
    let initial = [];
    try {
      initial = await mapWithConcurrency(accounts, AUTOMATION_CONCURRENCY, (name, index) => {
        const current = voiceSessions.get(sessionKey(name, guildId));
        const target = initialTargets?.get(name);
        const currentIndex = channelIds.indexOf(current?.channelId);
        const preferred = target || channelIds[currentIndex >= 0 ? (currentIndex + 1) % channelIds.length : index % channelIds.length];
        return moveRotationAccount(name, initialTask, preferred, normalizeVoiceState(current || {}));
      });
      initial.forEach((result) => recordTaskResult(task, result));
      task.accountTargets = { ...initialTask.accountTargets };
      task.lastResults = initial;
      task.nextAt = Date.now() + task.intervalMs;
      emitLive('task.completed', { id: task.id, taskType: 'rotation', initializing: false, nextAt: task.nextAt, currentIdx: task.currentIdx, results: task.lastResults });
    } catch (error) {
      const result = { name: 'rotation', ok: false, error: error?.message || String(error) };
      task.lastResults = [result];
      recordTaskResult(task, result);
      logMediaEvent('error', 'automation.rotation_initialization_failed', { id: task.id, guildId, error: result.error });
    } finally {
      task.initializing = false;
      task.running = false;
      persistAutomationTasks();
    }
  };
  runInitial().catch((error) => logMediaEvent('error', 'automation.rotation_background_failed', { id: task.id, guildId, error: error?.message || String(error) }));
  task.timer = setInterval(async () => {
    if (!task.active || task.running) return;
    task.running = true;
    // Advance the visible deadline before doing network/media work. A slow
    // Discord operation must not leave the dashboard stuck at 00:00.
    task.nextAt = Date.now() + task.intervalMs;
    task.currentIdx = (task.currentIdx + 1) % task.channels.length;
    const randomTargets = task.randomOrder
      ? randomRotationTargets(task.accounts, task.channels, (name) => voiceSessions.get(sessionKey(name, task.guildId))?.channelId)
      : null;
    try {
      task.lastResults = await mapWithConcurrency(task.accounts, AUTOMATION_CONCURRENCY, async (name, index) => {
        const current = voiceSessions.get(sessionKey(name, task.guildId));
        const randomTarget = randomTargets?.get(name);
        const preferred = rotationPreferredChannel(name, task, index, randomTarget);
        return recordTaskResult(task, await moveRotationAccount(name, task, preferred, normalizeVoiceState(current || {})));
      });
      task.nextAt = Date.now() + task.intervalMs;
      persistAutomationTasks();
      emitLive('task.completed', { id: task.id, taskType: 'rotation', nextAt: task.nextAt, currentIdx: task.currentIdx, results: task.lastResults });
    } catch (error) {
      const result = { name: 'rotation', ok: false, error: error?.message || String(error) };
      task.lastResults = [result];
      recordTaskResult(task, result);
      logMediaEvent('error', 'automation.rotation_tick_failed', { id: task.id, guildId: task.guildId, error: result.error });
    } finally { task.running = false; }
  }, delay);
  persistAutomationTasks();
  return ok(res, { id, started: true, initializing: true, accounts: task.accounts, summary: { total: accounts.length, ok: 0, failed: 0, skipped: 0, pending: accounts.length, retries: 0 } });
});
app.post('/api/voice/rotation/stop', (req, res) => {
  const id = String(req.body?.id || '');
  const task = rotations.get(id);
  if (!task) return fail(res, new Error('Rotation not found'), 404);
  task.active = false; clearInterval(task.timer); rotations.delete(id); persistAutomationTasks(); return ok(res);
});
function findAutomationTask(type, id) {
  const collection = type === 'rotation' ? rotations : stateCycles;
  return collection.get(String(id || '')) || null;
}
function taskHasAccountElsewhere(name, guildId, type, currentId) {
  const collection = type === 'rotation' ? rotations : stateCycles;
  for (const [id, task] of collection) {
    if (String(id) === String(currentId) || String(task.guildId) !== String(guildId)) continue;
    if ((task.accounts || []).includes(name)) return true;
  }
  return false;
}
function automationAccountCheck(name, task, type) {
  const entry = clients.get(name);
  if (!entry?.client) return { name, available: false, reason: 'الحساب غير متصل' };
  const guild = entry.client.guilds?.cache?.get?.(task.guildId);
  if (!guild) return { name, available: false, reason: 'الحساب ليس عضوًا في السيرفر' };
  if (type === 'cycle') {
    const session = voiceSessions.get(sessionKey(name, task.guildId));
    if (!session?.channelId) return { name, available: false, reason: 'الحساب ليس داخل روم صوتي في هذا السيرفر' };
    return { name, available: true, current: session.channelId };
  }
  for (const channelId of task.channels || []) {
    const channel = guild.channels?.cache?.get?.(channelId);
    const me = guild.members?.me || entry.client.user?.id;
    if (!channel || !isVoiceChannel(channel)) return { name, available: false, reason: 'أحد رومات التدوير غير موجود للحساب' };
    if (!canJoin(channel, me)) return { name, available: false, reason: `لا يملك صلاحية دخول روم ${channel.name || channelId}` };
  }
  return { name, available: true };
}
app.get('/api/voice/task/candidates', (req, res) => {
  const type = String(req.query?.type || '');
  const id = String(req.query?.id || '');
  if (!['rotation', 'cycle'].includes(type) || !id) return fail(res, new Error('type and id are required'), 400);
  const task = findAutomationTask(type, id);
  if (!task) return fail(res, new Error('Task not found'), 404);
  const candidates = [...clients.keys()].filter((name) => !(task.accounts || []).includes(name)).map((name) => {
    const check = automationAccountCheck(name, task, type);
    if (check.available && taskHasAccountElsewhere(name, task.guildId, type, task.id)) return { name, available: false, reason: 'الحساب موجود في جلسة تدوير أخرى' };
    return check;
  });
  return ok(res, { type, id, candidates });
});
app.post('/api/voice/task/add-accounts', async (req, res) => {
  const type = String(req.body?.type || '');
  const id = String(req.body?.id || '');
  const accounts = cleanAccounts(req.body?.accounts);
  if (!['rotation', 'cycle'].includes(type) || !id || !accounts.length) return fail(res, new Error('type, id and accounts are required'), 400);
  const task = findAutomationTask(type, id);
  if (!task) return fail(res, new Error('Task not found'), 404);
  if (!task.active) return fail(res, new Error('Task is not active'), 409);
  const checks = accounts.map((name) => {
    if ((task.accounts || []).includes(name)) return { name, available: false, reason: 'الحساب موجود أصلًا في الجلسة' };
    if (taskHasAccountElsewhere(name, task.guildId, type, task.id)) return { name, available: false, reason: 'الحساب موجود في جلسة تدوير أخرى' };
    return automationAccountCheck(name, task, type);
  });
  const rejected = checks.filter((item) => !item.available);
  if (rejected.length) return fail(res, new Error(rejected.map((item) => `${item.name}: ${item.reason}`).join('؛ ')), 409, { rejected });
  const added = [];
  for (const name of accounts) {
    let result;
    if (type === 'rotation') {
      const current = voiceSessions.get(sessionKey(name, task.guildId));
      const preferred = rotationPreferredChannel(name, task, task.accounts.length, null);
      result = await moveRotationAccount(name, task, preferred, normalizeVoiceState(current || {}));
    } else {
      const state = task.states?.[task.currentIdx % (task.states.length || 1)] || {};
      result = await withResultRetry(() => withAccountLock(name, async () => executeStateForAccount(name, task, state)));
    }
    if (!result.ok) return fail(res, new Error(`${name}: ${result.error || 'تعذر تشغيل الحساب'}`), 409, { added, failed: { name, ...result } });
    task.accounts.push(name);
    added.push(name);
    recordTaskResult(task, result);
  }
  persistAutomationTasks();
  emitLive('task.accounts.added', { id: task.id, taskType: type, accounts: added });
  return ok(res, { id: task.id, type, added, accounts: task.accounts, message: `تمت إضافة ${added.length} حساب`, summary: { total: added.length, ok: added.length, failed: 0, skipped: 0, retries: 0 } });
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
  const task = { id, type: 'cycle', accounts, guildId, states, intervalMs: delay, currentIdx: 0, accountStateIdx: {}, stateHistory: {}, runToken: 0, startedAt: Date.now(), nextAt: Date.now() + delay };
  task.running = false; task.active = true;
  task.lastResults = [];
  const runStateCycle = async () => {
    if (task.nextAt > Date.now()) { if (task.active) task.timer = setTimeout(runStateCycle, task.nextAt - Date.now()); return; }
    if (!task.active || task.running) return;
    task.running = true;
    const runToken = task.runToken;
    task.currentIdx = (task.currentIdx + 1) % task.states.length;
    try {
      task.lastResults = [];
      await mapWithConcurrency(task.accounts, AUTOMATION_CONCURRENCY, (name) => withResultRetry(() => withAccountLock(name, async () => {
        const history = task.stateHistory[name] || [];
        const index = nextStateIndex(task.states, history);
        task.stateHistory[name] = [...history, index];
        task.accountStateIdx[name] = index;
        const result = await executeStateForAccount(name, task, task.states[index], runToken);
        if (!task.active || task.runToken !== runToken) return recordTaskResult(task, { name, ok: false, stale: true, error: 'State cycle stopped before completion' });
        return recordTaskResult(task, result);
      })));
      task.nextAt = Date.now() + task.intervalMs;
      persistAutomationTasks();
      emitLive('task.completed', { id: task.id, taskType: 'cycle', nextAt: task.nextAt, currentIdx: task.currentIdx, results: task.lastResults });
    } finally { task.running = false; if (task.active) task.timer = setTimeout(runStateCycle, Math.max(1000, task.nextAt - Date.now())); }
  };
  stateCycles.set(id, task);
  persistAutomationTasks();
  // Do not hold the HTTP request open while Stream/WebRTC accounts initialize.
  // Eight accounts can take minutes through the media queue and otherwise make
  // the browser report "Failed to fetch" even though the server is working.
  setImmediate(async () => {
    task.running = true;
    try {
      task.lastResults = await mapWithConcurrency(task.accounts, AUTOMATION_CONCURRENCY, (name) => withResultRetry(() => withAccountLock(name, async () => {
        const index = nextStateIndex(task.states, task.stateHistory[name] || []);
        task.stateHistory[name] = [index];
        task.accountStateIdx[name] = index;
        return recordTaskResult(task, await executeStateForAccount(name, task, task.states[index], task.runToken));
      })));
      task.nextAt = Date.now() + task.intervalMs;
      persistAutomationTasks();
      emitLive('task.initialized', { id: task.id, taskType: 'cycle', nextAt: task.nextAt, results: task.lastResults });
    } catch (error) {
      logMediaEvent('error', 'state_cycle.initialization_failed', { taskId: task.id, error: error.message });
    } finally {
      task.running = false;
      if (task.active) task.timer = setTimeout(runStateCycle, Math.max(1000, task.nextAt - Date.now()));
    }
  });
  return ok(res, { id, started: true, initializing: true, summary: { total: accounts.length, ok: 0, failed: 0, pending: accounts.length } });
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
      task.nextAt = Date.now() + task.intervalMs;
      task.currentIdx = (task.currentIdx + 1) % task.channels.length;
      const randomTargets = task.randomOrder
        ? randomRotationTargets(task.accounts, task.channels, (name) => voiceSessions.get(sessionKey(name, task.guildId))?.channelId)
        : null;
      try {
        task.lastResults = await mapWithConcurrency(task.accounts, AUTOMATION_CONCURRENCY, async (name, index) => {
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
    const task = { ...item, type: 'cycle', accounts, accountStateIdx: { ...(item.accountStateIdx || {}) }, stateHistory: { ...(item.stateHistory || {}) }, running: false, active: true, intervalMs: Math.max(1000, Number(item.intervalMs || 60000)), nextAt: Number(item.nextAt || Date.now() + Number(item.intervalMs || 60000)) };
    const runStateCycle = async () => {
      if (!task.active) return;
      if (task.nextAt > Date.now()) { task.timer = setTimeout(runStateCycle, task.nextAt - Date.now()); return; }
      if (task.running) { task.timer = setTimeout(runStateCycle, 1000); return; }
      task.running = true;
      task.nextAt = Date.now() + task.intervalMs;
      task.currentIdx = (task.currentIdx + 1) % task.states.length;
      try {
        task.lastResults = await mapWithConcurrency(task.accounts, AUTOMATION_CONCURRENCY, (name) => withResultRetry(() => withAccountLock(name, async () => {
          const history = task.stateHistory[name] || [];
          const index = nextStateIndex(task.states, history);
          task.stateHistory[name] = [...history, index];
          task.accountStateIdx[name] = index;
          return recordTaskResult(task, await executeStateForAccount(name, task, task.states[index]));
        })));
      } finally {
        task.running = false;
        task.nextAt = Date.now() + task.intervalMs;
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
  app.listen(PORT, '0.0.0.0', () => { console.log(`Voice Studio listening on http://localhost:${PORT}`); setInterval(() => { try { reconcileVoiceSessions(); } catch (error) { console.warn('[voice] session reconciliation failed:', error.message); } }, 3000).unref?.(); startVoiceWatchdog(); restoreSavedAccounts().then(() => restoreAutomationTasks()).catch((error) => console.warn('[restore] restore failed:', error.message)); });
}

module.exports = { app, clients, voiceSessions, rotations, stateCycles, playingSessions, stopPlayingSession, startAllPlayingSessions, addPlayingAccounts, stopAllPlayingSessions, handlePlayingDiscordCommand, rotationControlledAccounts, taskConflict, operationKey, beginAccountOperation, operationIsCurrent, endAccountOperation, sendVoiceOp, sendVoiceOpConfirmed, validateTarget, validateMediaTarget, voiceFailureHints, mediaJoinDiagnostics, installVoiceEventFilter, confirmLiveMediaTarget, voiceConnectionChannelId, compactPrimaryVoiceClosingListeners, cleanupPrimaryStreamAttempt, primaryMediaRetryError, recordPrimaryMediaFailure, primaryMediaFailures, startSyntheticStream, stopSyntheticStream, ensureSyntheticVideo, normalizeExclusiveVoiceState, clearVoiceFlags, cleanAccountRecords, saveAccounts, loadAccounts, cleanPlayingSteps, sendPlayingPhrase, randomRotationTargets, playPrimaryMediaAndWait, taskHasAccountElsewhere, automationAccountCheck };
