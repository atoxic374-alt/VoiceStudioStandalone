const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sendVoiceOp, sendVoiceOpConfirmed, voiceFailureHints, installVoiceEventFilter, rotations, stateCycles, stateCycleStateForAccount, nextStateIndex, recordSuccessfulCycleState, isAccountManagedByActiveStateCycle, expectedMediaStateIsPresent, registerAccountStreamer, mediaStreamers, rotationControlledAccounts, taskConflict, beginAccountOperation, operationIsCurrent, endAccountOperation, clients, sendPlayingPhrase, playingSessions, stopPlayingSession, schedulePlaying, startAllPlayingSessions, stopAllPlayingSessions, handlePlayingDiscordCommand, randomRotationTargets, playPrimaryMediaAndWait, taskHasAccountElsewhere, operationKey, addPlayingAccounts, voiceConnectionChannelId, compactPrimaryVoiceClosingListeners, primaryMediaRetryError, recordPrimaryMediaFailure, primaryMediaFailures, clearPrimaryMediaFailure, cleanAccountRecords, buildAccountSnapshot, safeErrorSummary, guardVoiceWebSocketTeardown, normalizeExclusiveVoiceState, voiceRecoveryState, retryableError, isCaptchaChallengeError, isHardMediaFailure, isRateLimitFailure, discordRetryAfterMs, retryDelayWithJitter, retryMediaTransportImmediately, resetFailedCameraState, primaryMediaTransportIsActive, mediaWatchdogReadiness, mediaTransportReadyForTarget, syntheticStreams, waitForPrimaryVideoReady, clearVoiceFlags, cleanupPrimaryStreamAttempt, isRecoverableDiscordInteractionError, parseRotationChannelIds, removeAccountFromAutomationTasks } = require('../server');
const { dueRotationAccounts, scheduleRotationTask, setRotationAccountPaused, rotationAccountPaused } = require('../server');
const { failureResultFromError } = require('../server');
const VoiceWebSocket = require('discord.js-selfbot-v13/src/client/voice/networking/VoiceWebSocket');

test('captures delayed errors from a WebSocket after voice teardown without suppressing live errors', () => {
  const streamConnection = new EventEmitter();
  const voiceWebSocket = new EventEmitter();
  const forwarded = [];
  voiceWebSocket.dead = false;
  voiceWebSocket.on('error', (error) => streamConnection.emit('error', error));
  voiceWebSocket.ws = { onerror: (error) => voiceWebSocket.emit('error', error) };
  streamConnection.sockets = { ws: voiceWebSocket };
  streamConnection.on('error', (error) => forwarded.push(error));
  assert.equal(guardVoiceWebSocketTeardown(streamConnection, { account: 'teardown-test', transport: 'stream' }), true);
  const closeRace = new Error('WebSocket was closed before the connection was established');
  voiceWebSocket.removeAllListeners('error');
  voiceWebSocket.dead = true;
  assert.doesNotThrow(() => voiceWebSocket.ws.onerror(closeRace));
  assert.deepEqual(forwarded, []);
  voiceWebSocket.dead = false;
  voiceWebSocket.on('error', (error) => streamConnection.emit('error', error));
  const liveFailure = new Error('Unexpected server response: 522');
  voiceWebSocket.ws.onerror(liveFailure);
  assert.deepEqual(forwarded, [liveFailure]);
});

test('absorbs only the closed-before-connect VoiceWebSocket error after cleanup', () => {
  const connection = new EventEmitter();
  const voiceWebSocket = new VoiceWebSocket(connection);
  const errors = [];
  voiceWebSocket.on('error', (error) => errors.push(error));
  voiceWebSocket.dead = true;
  assert.doesNotThrow(() => voiceWebSocket.onError(new Error('WebSocket was closed before the connection was established')));
  assert.deepEqual(errors, []);
  voiceWebSocket.dead = false;
  const liveFailure = new Error('Unexpected server response: 522');
  voiceWebSocket.onError(liveFailure);
  assert.deepEqual(errors, [liveFailure]);
});

test('account diagnostic snapshots never retain credentials', () => {
  const snapshot = buildAccountSnapshot([
    { name: 'Alpha', token: 'secret-account-token', savedAt: 123, status: 'connected' },
    { name: 'Beta', token: 'another-secret', status: 'failed', error: 'Invalid token=another-secret', savedAt: 789, lastAttemptAt: 456 },
  ]);
  assert.deepEqual(snapshot, [
    { name: 'Alpha', status: 'connected', savedAt: 123 },
    { name: 'Beta', status: 'failed', savedAt: 789, lastAttemptAt: 456, error: 'Invalid token=[redacted]' },
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-account-token|another-secret/);
});

test('summarizes unhandled errors without serializing request headers or stacks', () => {
  const summary = safeErrorSummary({
    name: 'DiscordError', code: 'E_FAIL', status: 522,
    message: 'request failed with token=secret-value',
    request: { headers: { Authorization: 'Bearer sensitive-value' } },
    stack: 'private stack trace',
  });
  assert.deepEqual(summary, {
    name: 'DiscordError', message: 'request failed with token=[redacted]', code: 'E_FAIL', status: '522',
  });
  assert.doesNotMatch(JSON.stringify(summary), /sensitive-value|secret-value|stack/);
});

test('classifies stale Discord component validation failures as recoverable', () => {
  assert.equal(isRecoverableDiscordInteractionError({ code: 50035, message: 'DiscordAPIError: Invalid Form Body' }), true);
  assert.equal(isRecoverableDiscordInteractionError({ code: 50035, message: 'Component validation failed' }), true);
  assert.equal(isRecoverableDiscordInteractionError({ code: 50013, message: 'Missing Permissions' }), false);
});

test('off freezes an account rotation countdown and excludes it from due rotations until on', () => {
  const now = Date.now();
  let rescheduleCount = 0;
  const task = {
    id: 'pause-resume-rotation-test', type: 'rotation', active: true,
    accounts: ['pause-resume-account'], intervalMs: 60_000,
    accountNextAt: { 'pause-resume-account': now + 5_000 },
    pausedAccounts: [], accountPauseState: { 'pause-resume-account': false }, pausedRemainingMs: {}, accountTargets: {}, accountStatus: {},
    runTick() {},
    scheduleNext() { rescheduleCount += 1; scheduleRotationTask(this); },
  };

  scheduleRotationTask(task);
  assert.ok(task.timer);
  assert.equal(setRotationAccountPaused(task, 'pause-resume-account', true).ok, true);
  assert.equal(task.timer, null);
  assert.equal(task.accountPauseState['pause-resume-account'], true);
  const savedRemaining = task.pausedRemainingMs['pause-resume-account'];
  assert.ok(savedRemaining > 1_000 && savedRemaining <= 5_000);
  assert.deepEqual(dueRotationAccounts(task, now + 60_000), []);
  assert.equal(rotationAccountPaused(task, 'pause-resume-account'), true);

  assert.equal(setRotationAccountPaused(task, 'pause-resume-account', false).ok, true);
  assert.equal(rotationAccountPaused(task, 'pause-resume-account'), false);
  assert.equal(task.accountPauseState['pause-resume-account'], false);
  assert.ok(task.accountNextAt['pause-resume-account'] > Date.now());
  assert.equal(task.pausedRemainingMs['pause-resume-account'], undefined);
  assert.equal(rescheduleCount, 2);
  assert.ok(task.timer);
  assert.deepEqual(dueRotationAccounts(task, Date.now()), []);
  clearTimeout(task.timer);
});

test('rotation scheduler clears its timer when every account is off', () => {
  const task = {
    active: true, running: false, accounts: ['paused-account'],
    pausedAccounts: ['paused-account'], accountNextAt: { 'paused-account': Date.now() },
    runTick() {},
  };
  scheduleRotationTask(task);
  assert.equal(task.timer, null);
  assert.equal(task.nextAt, null);
});

test('restored legacy accountStatus paused flag keeps the account off', () => {
  assert.equal(rotationAccountPaused({ accountStatus: { legacy: { paused: true } } }, 'legacy'), true);
  assert.equal(rotationAccountPaused({ accountStatus: { legacy: { paused: false } } }, 'legacy'), false);
});

test('off cancels any in-flight voice operation for the account, not only rotation operations', () => {
  const account = 'pause-any-operation-account';
  const operation = beginAccountOperation(account, 'pause-guild', 'state');
  const task = {
    id: 'pause-any-operation-task', type: 'rotation', active: true,
    guildId: 'pause-guild', accounts: [account], pausedAccounts: [], accountPauseState: {},
    accountNextAt: { [account]: Date.now() + 60_000 }, intervalMs: 60_000,
    accountTargets: {}, accountStatus: {}, runTick() {}, scheduleNext() {},
  };
  try {
    assert.equal(setRotationAccountPaused(task, account, true).ok, true);
    assert.equal(operationIsCurrent(operation), false);
    assert.equal(rotationAccountPaused(task, account), true);
  } finally {
    endAccountOperation(operation);
  }
});

test('cleans saved account records before they can affect the account count', () => {
  const records = cleanAccountRecords([
    { name: 'Alpha', token: 'token-a' },
    { name: 'alpha', token: 'token-b' },
    { name: 'Beta', token: 'TOKEN-A' },
    { name: 'Gamma', token: '  token-c  ' },
    { name: '', token: 'token-d' },
    { name: 'Empty', token: '   ' },
  ]);
  assert.deepEqual(records.map(({ name, token }) => ({ name, token })), [
    { name: 'Alpha', token: 'token-a' },
    { name: 'Gamma', token: 'token-c' },
  ]);
});

test('writes account names and plaintext tokens to a restricted JSON mirror', () => {
  const { saveReadableAccountJson } = require('../server');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-studio-account-json-'));
  const file = path.join(directory, 'accounts.json');
  try {
    saveReadableAccountJson([{ name: 'Mirror Account', token: 'example-token', savedAt: 123 }], file);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [
      { name: 'Mirror Account', token: 'example-token', savedAt: 123 },
    ]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('treats each rotation item as one exclusive voice mode', () => {
  assert.deepEqual(normalizeExclusiveVoiceState({ selfMute: true, selfDeaf: true }), { selfMute: false, selfDeaf: true, selfVideo: false, selfStream: false });
  assert.deepEqual(normalizeExclusiveVoiceState({ selfMute: true, selfStream: true }), { selfMute: false, selfDeaf: false, selfVideo: false, selfStream: true });
  assert.deepEqual(normalizeExclusiveVoiceState({ selfDeaf: true, selfVideo: true }), { selfMute: false, selfDeaf: false, selfVideo: true, selfStream: false });
  assert.deepEqual(normalizeExclusiveVoiceState({}), { selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false });
});

test('does not restore a previous deafen state after a failed camera or stream start', () => {
  assert.deepEqual(voiceRecoveryState({ selfMute: false, selfDeaf: true, selfVideo: false, selfStream: true }), {
    selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false,
  });
  assert.deepEqual(voiceRecoveryState({ selfMute: true, selfDeaf: false, selfVideo: true, selfStream: false }), {
    selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false,
  });
});

test('recognizes CAPTCHA challenges as manual-verification failures', () => {
  assert.equal(isCaptchaChallengeError({ message: 'CAPTCHA_SOLVER_NOT_IMPLEMENTED — Discord code 500' }), true);
  assert.equal(isCaptchaChallengeError({ code: 'CAPTCHA_SOLVER_NOT_IMPLEMENTED' }), true);
  assert.equal(isCaptchaChallengeError({ message: 'Gateway temporarily unavailable' }), false);
});
test('retries transient live voice target confirmation failures', () => {
  assert.equal(retryableError({ error: 'Live voice target changed or is no longer available' }), true);
  assert.equal(retryableError({ error: 'Voice state mismatch for channel channel-1: gateway=none, connection=none' }), true);
});

test('the optional immediate retry helper creates a fresh transport only for a transient failure', async () => {
  const calls = [];
  const result = await retryMediaTransportImmediately(async (attempt) => {
    calls.push(attempt);
    return attempt === 1 ? { ok: false, error: 'first transport failed' } : { ok: true };
  }, 2);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
});

test('does not immediately retry permission, CAPTCHA, or rate-limit media failures', async () => {
  for (const failure of [
    { ok: false, error: 'Missing Permissions', status: 403 },
    { ok: false, error: 'CAPTCHA verification required' },
    { ok: false, error: 'Too many requests', status: 429, retryAfterMs: 2500 },
  ]) {
    let attempts = 0;
    const result = await retryMediaTransportImmediately(async () => { attempts += 1; return failure; }, 3);
    assert.equal(attempts, 1);
    assert.equal(result.ok, false);
  }
});

test('extracts Discord Retry-After values from numeric fields and HTTP headers', () => {
  assert.equal(discordRetryAfterMs({ retryAfterMs: 1250 }), 1250);
  assert.equal(discordRetryAfterMs({ timeout: 4250 }), 4250);
  assert.equal(discordRetryAfterMs({ retry_after: 2.5 }), 2500);
  assert.equal(discordRetryAfterMs({ headers: { 'Retry-After': '3' } }), 3000);
  assert.equal(discordRetryAfterMs({ headers: { 'retry-after': 'not-a-date' } }), 0);
  assert.deepEqual(failureResultFromError(Object.assign(new Error('Too many requests'), { status: 429, code: 20028, retryAfterMs: 1500 })), {
    ok: false, error: 'Too many requests', status: 429, code: 20028, retryAfterMs: 1500, rateLimited: true,
  });
});

test('classifies permission and CAPTCHA failures as non-retryable hard failures', () => {
  for (const failure of [
    { status: 403, message: 'Forbidden' },
    { code: 50013, message: 'Missing Permissions' },
    { message: 'Missing Stream permission for Camera or Screen Share in this voice channel' },
    { message: 'CAPTCHA challenge required' },
  ]) {
    assert.equal(isHardMediaFailure(failure), true);
    assert.equal(retryableError(failure), false);
  }
  assert.equal(isHardMediaFailure('CAPTCHA verification required'), true);
  assert.equal(isRateLimitFailure({ status: 429 }), true);
  assert.equal(retryableError({ status: 429, error: 'Too many requests' }), false);
});

test('uses bounded equal jitter for transient exponential retry delays', () => {
  assert.equal(retryDelayWithJitter(0, 1000, 10_000, () => 0), 500);
  assert.equal(retryDelayWithJitter(0, 1000, 10_000, () => 1), 1000);
  assert.equal(retryDelayWithJitter(10, 1000, 10_000, () => 1), 10_000);
});

test('resets failed camera media flags without leaving the room or changing the current self-mute', async () => {
  const order = [];
  const connection = {
    channel: { id: 'channel-1' }, videoStatus: true,
    setVideoStatus(value) { order.push(`video:${value}`); this.videoStatus = value; },
  };
  const dispatcher = { destroy() { order.push('dispatcher:destroy'); } };
  const confirmVoiceState = async (_client, _guildId, channelId, state) => {
    order.push('voice-state:confirm');
    assert.equal(channelId, 'channel-1');
    assert.deepEqual(state, {
      selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false,
      confirmOmittedFalseFlags: ['selfVideo', 'selfStream'],
    });
    return { ok: true };
  };
  const client = {
    user: { id: 'user-1' },
    guilds: { cache: new Map([['guild-1', { voiceStates: { cache: new Map([['user-1', { guildId: 'guild-1', channelId: 'channel-1', selfMute: false }]]) } }]]) },
  };
  const result = await resetFailedCameraState(client, connection, 'guild-1', 'channel-1', { selfMute: true }, dispatcher, confirmVoiceState);
  assert.equal(result.ok, true);
  assert.deepEqual(order, ['dispatcher:destroy', 'video:false', 'voice-state:confirm']);
  assert.equal(connection.videoStatus, false);
});

test('does not send camera cleanup to a stale room after the account has moved', async () => {
  const order = [];
  const connection = { channel: { id: 'channel-1' }, videoStatus: true, setVideoStatus(value) { order.push(`video:${value}`); } };
  const client = {
    user: { id: 'user-1' },
    guilds: { cache: new Map([['guild-1', { voiceStates: { cache: new Map([['user-1', { guildId: 'guild-1', channelId: 'channel-2', selfMute: true }]]) } }]]) },
  };
  const result = await resetFailedCameraState(client, connection, 'guild-1', 'channel-1', { selfMute: false }, { destroy() { order.push('dispatcher:destroy'); } }, async () => { order.push('voice-state:confirm'); return { ok: true }; });
  assert.equal(result.cancelled, true);
  assert.deepEqual(order, ['dispatcher:destroy']);
});

test('waits for camera video packets on the primary voice connection', async () => {
  const connection = { videoStatus: false };
  const dispatcher = new EventEmitter();
  const ready = waitForPrimaryVideoReady(connection, dispatcher, 500);
  setTimeout(() => { connection.videoStatus = true; }, 20);
  await ready;
  assert.equal(connection.videoStatus, true);
});

test('recognizes an active camera transport before attempting to restart it', () => {
  const name = 'verify-active-camera-test';
  const connection = { status: 0, videoStatus: true, streamConnection: null };
  const dispatcher = new EventEmitter();
  clients.set(name, { client: { voice: { connection } } });
  syntheticStreams.set(name, { connection, dispatcher, mediaKind: 'camera', guildId: 'guild-1', channelId: 'channel-1' });
  try {
    assert.equal(primaryMediaTransportIsActive(name, 'guild-1', 'channel-1', 'camera'), true);
    assert.equal(primaryMediaTransportIsActive(name, 'guild-1', 'channel-1', 'go-live'), false);
    connection.videoStatus = false;
    assert.equal(primaryMediaTransportIsActive(name, 'guild-1', 'channel-1', 'camera'), false);
  } finally {
    syntheticStreams.delete(name);
    clients.delete(name);
  }
});

test('recognizes a connected Go Live transport before attempting to restart it', () => {
  const name = 'verify-active-stream-test';
  const streamConnection = { status: 0 };
  const connection = { status: 0, streamConnection };
  const dispatcher = new EventEmitter();
  clients.set(name, { client: { voice: { connection } } });
  syntheticStreams.set(name, { connection, streamConnection, dispatcher, mediaKind: 'go-live', guildId: 'guild-1', channelId: 'channel-1' });
  try {
    assert.equal(primaryMediaTransportIsActive(name, 'guild-1', 'channel-1', 'go-live'), true);
    streamConnection.status = 1;
    assert.equal(primaryMediaTransportIsActive(name, 'guild-1', 'channel-1', 'go-live'), false);
  } finally {
    syntheticStreams.delete(name);
    clients.delete(name);
  }
});

test('treats primary voice-camera transport as healthy in the watchdog', () => {
  const name = 'watchdog-primary-camera-test';
  const connection = { status: 0, videoStatus: true, streamConnection: null };
  const client = { voice: { connection } };
  const active = { connection, dispatcher: new EventEmitter(), mediaKind: 'camera', guildId: 'guild-1', channelId: 'channel-1' };
  const session = { name, guildId: 'guild-1', channelId: 'channel-1', selfVideo: true, selfStream: false };
  clients.set(name, { client });
  try {
    assert.deepEqual(mediaWatchdogReadiness(session, client, active), {
      expectedKind: 'camera', primaryTransport: true, targetMatches: true, voiceReady: true, mediaReady: true, sourceReady: true,
    });
    connection.videoStatus = false;
    assert.equal(mediaWatchdogReadiness(session, client, active).mediaReady, false);
  } finally {
    clients.delete(name);
  }
});

test('treats primary Go Live transport as healthy in the watchdog', () => {
  const name = 'watchdog-primary-live-test';
  const streamConnection = { status: 0 };
  const connection = { status: 0, streamConnection };
  const client = { voice: { connection } };
  const active = { connection, streamConnection, dispatcher: new EventEmitter(), mediaKind: 'go-live', guildId: 'guild-1', channelId: 'channel-1' };
  const session = { name, guildId: 'guild-1', channelId: 'channel-1', selfVideo: false, selfStream: true };
  clients.set(name, { client });
  try {
    const readiness = mediaWatchdogReadiness(session, client, active);
    assert.equal(readiness.primaryTransport, true);
    assert.equal(readiness.targetMatches, true);
    assert.equal(readiness.voiceReady, true);
    assert.equal(readiness.mediaReady, true);
    assert.equal(readiness.sourceReady, true);
  } finally {
    clients.delete(name);
  }
});

test('recognizes a healthy dedicated Streamer transport before scheduling another recovery', () => {
  const name = 'watchdog-dedicated-live-test';
  const active = {
    mediaKind: 'go-live', guildId: 'guild-1', channelId: 'channel-1',
    streamer: { voiceConnection: { webRtcConn: { ready: true }, streamConnection: { webRtcConn: { ready: true } } } },
    sourceProcess: { exitCode: null, killed: false },
  };
  const client = { voice: { connection: null } };
  assert.equal(mediaTransportReadyForTarget(name, 'guild-1', 'channel-1', 'go-live', active, client), true);
  assert.equal(mediaTransportReadyForTarget(name, 'guild-1', 'channel-2', 'go-live', active, client), false);
});

test('state-cycle ownership is discoverable for watchdog media monitoring', () => {
  const id = 'watchdog-cycle-ownership-test';
  stateCycles.set(id, { active: true, guildId: 'guild-1', accounts: ['cycle-account'] });
  try {
    assert.equal(isAccountManagedByActiveStateCycle('cycle-account', 'guild-1'), true);
    assert.equal(isAccountManagedByActiveStateCycle('cycle-account', 'guild-2'), false);
    stateCycles.get(id).active = false;
    assert.equal(isAccountManagedByActiveStateCycle('cycle-account', 'guild-1'), false);
  } finally {
    stateCycles.delete(id);
  }
});

test('restores the last persisted state-cycle state instead of choosing a new one', () => {
  const camera = { selfVideo: true, selfStream: false };
  const live = { selfVideo: false, selfStream: true };
  assert.equal(stateCycleStateForAccount({ states: [camera, live], accountStateIdx: { alpha: 1 }, stateHistory: { alpha: [0, 1] } }, 'alpha'), live);
  assert.equal(stateCycleStateForAccount({ states: [camera, live], accountStateIdx: {}, stateHistory: { alpha: [0, 1] } }, 'alpha'), live);
  assert.equal(stateCycleStateForAccount({ states: [camera, live], accountStateIdx: {}, stateHistory: {} }, 'alpha'), camera);
});

test('keeps an in-flight media state available for recovery until that state succeeds', () => {
  const mute = { selfMute: true, selfDeaf: false, selfVideo: false, selfStream: false };
  const live = { selfMute: false, selfDeaf: false, selfVideo: false, selfStream: true };
  const task = { states: [mute, live], accountStateIdx: { alpha: 0 }, accountPendingStateIdx: { alpha: 1 }, stateHistory: { alpha: [0] } };
  assert.equal(stateCycleStateForAccount(task, 'alpha'), live);
  assert.equal(recordSuccessfulCycleState(task, 'alpha', 1, false), false);
  assert.equal(stateCycleStateForAccount(task, 'alpha'), live);
  assert.equal(recordSuccessfulCycleState(task, 'alpha', 1, true), true);
  assert.equal(task.accountPendingStateIdx.alpha, undefined);
  assert.equal(stateCycleStateForAccount(task, 'alpha'), live);
});

test('keeps state-cycle choices random and independent per account without skipping unseen states', () => {
  const originalRandom = Math.random;
  const states = ['unmute', 'mute', 'camera', 'stream'];
  try {
    Math.random = () => 0;
    const ahmed = nextStateIndex(states, []);
    Math.random = () => 0.999;
    const mohammed = nextStateIndex(states, []);
    assert.equal(ahmed, 0);
    assert.equal(mohammed, 3);
    Math.random = () => 0;
    assert.equal(nextStateIndex(states, [ahmed]), 1);
    assert.deepEqual(new Set([ahmed, nextStateIndex(states, [ahmed]), nextStateIndex(states, [ahmed, 1]), nextStateIndex(states, [ahmed, 1, 2])]), new Set([0, 1, 2, 3]));
  } finally {
    Math.random = originalRandom;
  }
});

test('does not mark a failed state as completed in the cycle history', () => {
  const task = { states: [{ selfVideo: true }, { selfStream: true }], stateHistory: { alpha: [1] }, accountStateIdx: { alpha: 1 } };
  assert.equal(recordSuccessfulCycleState(task, 'alpha', 0, false), false);
  assert.deepEqual(task.stateHistory.alpha, [1]);
  assert.equal(task.accountStateIdx.alpha, 1);
  assert.equal(recordSuccessfulCycleState(task, 'alpha', 0, true), true);
  assert.deepEqual(task.stateHistory.alpha, [1, 0]);
  assert.equal(task.accountStateIdx.alpha, 0);
});

test('keeps Streamer instances exclusive to their account', () => {
  const alpha = { tag: 'alpha-streamer' };
  const beta = { tag: 'beta-streamer' };
  try {
    assert.equal(registerAccountStreamer('streamer-isolation-alpha', alpha), alpha);
    assert.equal(registerAccountStreamer('streamer-isolation-beta', beta), beta);
    assert.equal(mediaStreamers.get('streamer-isolation-alpha'), alpha);
    assert.equal(mediaStreamers.get('streamer-isolation-beta'), beta);
    assert.throws(() => registerAccountStreamer('streamer-isolation-beta', alpha), /already owned by account streamer-isolation-alpha/);
  } finally {
    mediaStreamers.delete('streamer-isolation-alpha');
    mediaStreamers.delete('streamer-isolation-beta');
  }
});

test('verifies camera and Go Live state against the actual account voice state', () => {
  assert.equal(expectedMediaStateIsPresent({ channelId: 'channel-1', selfVideo: true, selfStream: false, selfDeaf: false }, 'channel-1', 'camera'), true);
  assert.equal(expectedMediaStateIsPresent({ channelId: 'channel-1', selfVideo: false, selfStream: true, selfDeaf: false }, 'channel-1', 'go-live'), true);
  assert.equal(expectedMediaStateIsPresent({ channelId: 'channel-1', selfVideo: false, selfStream: false, selfDeaf: false }, 'channel-1', 'camera'), false);
  assert.equal(expectedMediaStateIsPresent({ channelId: 'channel-2', selfVideo: true, selfStream: false, selfDeaf: false }, 'channel-1', 'camera'), false);
  assert.equal(expectedMediaStateIsPresent({ channelId: 'channel-1', selfVideo: true, selfStream: false, selfDeaf: true }, 'channel-1', 'camera'), false);
});

test('clears every previous voice flag before the next rotation state', async () => {
  const { client, getSent } = fakeClient();
  const result = await clearVoiceFlags(client, 'guild-1', 'channel-1', { selfMute: true, selfDeaf: true, selfStream: true });
  assert.equal(result.ok, true);
  assert.deepEqual(getSent().d, { guild_id: 'guild-1', channel_id: 'channel-1', self_mute: false, self_deaf: false, self_video: false, self_stream: false });
});

test('accepts Discord omitting disabled media fields after stopping a stream', async () => {
  const { client } = fakeClient({ omitFlags: ['self_video', 'self_stream'] });
  const result = await clearVoiceFlags(client, 'guild-1', 'channel-1', { selfStream: true });
  assert.equal(result.ok, true);
});

test('always sends an explicit voice reset when cached state has no flags', async () => {
  const { client, getSent } = fakeClient();
  const result = await clearVoiceFlags(client, 'guild-1', 'channel-1', {});
  assert.equal(result.ok, true);
  assert.deepEqual(getSent().d, { guild_id: 'guild-1', channel_id: 'channel-1', self_mute: false, self_deaf: false, self_video: false, self_stream: false });
});

function fakeClient({ ready = true, confirms = true, omitFlags = [] } = {}) {
  const ws = new EventEmitter();
  let sent = null;
  const shard = {
    status: ready ? 0 : 1,
    send(payload) {
      sent = payload;
      if (confirms) setImmediate(() => {
        const update = {
        user_id: 'user-1', guild_id: 'guild-1', channel_id: payload.d.channel_id,
        self_mute: payload.d.self_mute, self_deaf: payload.d.self_deaf,
        self_video: payload.d.self_video, self_stream: payload.d.self_stream,
        };
        omitFlags.forEach((flag) => delete update[flag]);
        ws.emit('VOICE_STATE_UPDATE', update);
      });
    },
  };
  ws.shards = { first: () => shard };
  const client = new EventEmitter();
  client.user = { id: 'user-1' };
  client.ws = ws;
  return { client, getSent: () => sent };
}

test('sends a complete OP4 payload for camera and screen share state', () => {
  const { client, getSent } = fakeClient({ confirms: false });
  const result = sendVoiceOp(client, 'guild-1', 'channel-1', { selfMute: false, selfDeaf: false, selfVideo: true, selfStream: true });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(getSent().d, { guild_id: 'guild-1', channel_id: 'channel-1', self_mute: false, self_deaf: false, self_video: true, self_stream: true });
});

test('detects the active voice channel from every supported connection shape', () => {
  assert.equal(voiceConnectionChannelId({ channel: { id: 'channel-a' } }), 'channel-a');
  assert.equal(voiceConnectionChannelId({ channelId: 'channel-b' }), 'channel-b');
  assert.equal(voiceConnectionChannelId({ channel_id: 'channel-c' }), 'channel-c');
});

test('compacts leaked primary voice closing listeners while retaining active cleanup', () => {
  const connection = new EventEmitter();
  connection.channel = { id: 'channel-primary' };
  let playerDestroyed = 0;
  let websocketShutdown = 0;
  let udpShutdown = 0;
  connection.player = { destroy: () => { playerDestroyed += 1; } };
  connection.sockets = { ws: { shutdown: () => { websocketShutdown += 1; } }, udp: { shutdown: () => { udpShutdown += 1; } } };
  connection.setMaxListeners(0); // Construct the already-leaked production state without warning in the test runner.
  for (let index = 0; index < 11; index += 1) connection.on('closing', () => {});
  assert.equal(compactPrimaryVoiceClosingListeners(connection), true);
  assert.equal(connection.listenerCount('closing'), 3);
  connection.emit('closing');
  assert.deepEqual({ playerDestroyed, websocketShutdown, udpShutdown }, { playerDestroyed: 1, websocketShutdown: 1, udpShutdown: 1 });
});

test('hardens a voice connection without retaining more than three closing listeners', () => {
  const connection = new EventEmitter();
  connection.channel = { id: 'channel-hardened' };
  connection.setMaxListeners(0);
  for (let index = 0; index < 20; index += 1) connection.on('closing', () => {});
  const { hardenVoiceConnection } = require('../server');
  assert.equal(hardenVoiceConnection(connection), true);
  assert.equal(connection.listenerCount('closing'), 3);
  assert.equal(connection.getMaxListeners(), 0);
});

test('backs off repeated failed primary media starts for the same target', () => {
  const account = 'primary-retry-test';
  clearPrimaryMediaFailure(account);
  try {
    assert.equal(primaryMediaRetryError(account, 'guild-1', 'channel-1', 'go-live'), null);
    recordPrimaryMediaFailure(account, 'guild-1', 'channel-1', 'go-live', 'handshake timed out');
    assert.match(primaryMediaRetryError(account, 'guild-1', 'channel-1', 'go-live'), /cooling down/);
    assert.equal(primaryMediaRetryError(account, 'guild-1', 'channel-2', 'go-live'), null);
  } finally {
    clearPrimaryMediaFailure(account);
  }
});

test('honors Retry-After and pauses automatic retries for permission/CAPTCHA failures', () => {
  const account = 'primary-retry-policy-test';
  clearPrimaryMediaFailure(account);
  try {
    const rateLimited = recordPrimaryMediaFailure(account, 'guild-1', 'channel-1', 'go-live', {
      status: 429, retryAfterMs: 10_000, error: 'Too many requests',
    });
    assert.equal(rateLimited.retryAt - rateLimited.updatedAt, 10_000);
    assert.match(primaryMediaRetryError(account, 'guild-1', 'channel-1', 'go-live'), /cooling down/);
    clearPrimaryMediaFailure(account);

    recordPrimaryMediaFailure(account, 'guild-1', 'channel-1', 'camera', { status: 403, error: 'Missing Permissions' });
    assert.match(primaryMediaRetryError(account, 'guild-1', 'channel-1', 'camera'), /Automatic media recovery is paused/);
    assert.equal(primaryMediaFailures.get(account).retryAt, 0);
    assert.equal(primaryMediaRetryError(account, 'guild-1', 'channel-2', 'camera'), null);

    recordPrimaryMediaFailure(account, 'guild-1', 'channel-1', 'camera', { error: 'CAPTCHA verification required' });
    assert.match(primaryMediaRetryError(account, 'guild-1', 'channel-1', 'camera'), /CAPTCHA/);
  } finally {
    clearPrimaryMediaFailure(account);
  }
});

test('opens the media circuit breaker after repeated transient failures and retains its probe delay', () => {
  const account = 'primary-retry-circuit-test';
  clearPrimaryMediaFailure(account);
  try {
    let state;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      state = recordPrimaryMediaFailure(account, 'guild-1', 'channel-1', 'go-live', 'WebRTC media transport timed out');
    }
    assert.equal(state.attempts, 5);
    assert.ok(state.circuitOpenUntil > Date.now());
    assert.match(primaryMediaRetryError(account, 'guild-1', 'channel-1', 'go-live'), /circuit breaker is open/);
  } finally {
    clearPrimaryMediaFailure(account);
  }
});

test('does not classify an active media cooldown as an immediate retryable error', () => {
  assert.equal(retryableError({ ok: false, cooldown: true, retryAfterMs: 20_000, error: 'Media transport is cooling down; retry in 20 seconds' }), false);
  assert.equal(retryableError({ ok: false, error: 'Media transport is cooling down; retry in 20 seconds' }), false);
  assert.equal(retryableError({ ok: false, error: 'WebRTC media transport timed out' }), true);
});

test('serializes media handshakes globally across accounts and applies global pacing', async () => {
  const { enqueueGlobalMediaStart, mediaQueueSnapshot } = require('../server');
  let active = 0;
  let peak = 0;
  let releaseFirst;
  let markFirstStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const starts = [];
  const run = async (account) => {
    active += 1;
    peak = Math.max(peak, active);
    starts.push({ account, at: Date.now() });
    if (account === 'global-media-first-test') {
      markFirstStarted();
      await firstGate;
    }
    active -= 1;
    return { ok: true, account };
  };
  const first = enqueueGlobalMediaStart({ sequence: 900001, name: 'global-media-first-test', guildId: 'guild-test', mediaKind: 'camera', generation: 0 }, () => run('global-media-first-test'));
  const second = enqueueGlobalMediaStart({ sequence: 900002, name: 'global-media-second-test', guildId: 'guild-test', mediaKind: 'go-live', generation: 0 }, () => run('global-media-second-test'));
  try {
    await firstStarted;
    const snapshot = mediaQueueSnapshot();
    assert.equal(snapshot.global.concurrency, 1);
    assert.equal(snapshot.global.active, 1);
    assert.equal(snapshot.global.pending, 1);
    releaseFirst();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.ok), [true, true]);
    assert.equal(peak, 1);
    assert.deepEqual(starts.map((item) => item.account), ['global-media-first-test', 'global-media-second-test']);
    assert.ok(starts[1].at - starts[0].at >= snapshot.global.gapMs - 50);
  } finally {
    releaseFirst();
  }
});

test('cancels a stale media start while it is waiting in the global queue', async () => {
  const { enqueueGlobalMediaStart, stopSyntheticStream } = require('../server');
  let releaseBlocker;
  let markBlockerStarted;
  let staleRunStarted = false;
  const blockerGate = new Promise((resolve) => { releaseBlocker = resolve; });
  const blockerStarted = new Promise((resolve) => { markBlockerStarted = resolve; });
  const blocker = enqueueGlobalMediaStart({ sequence: 900003, name: 'global-media-blocker-test', guildId: 'guild-test', mediaKind: 'camera', generation: 0 }, async () => {
    markBlockerStarted();
    await blockerGate;
    return { ok: true };
  });
  try {
    await blockerStarted;
    const stale = enqueueGlobalMediaStart({ sequence: 900004, name: 'global-media-stale-test', guildId: 'guild-test', mediaKind: 'go-live', generation: 0 }, async () => {
      staleRunStarted = true;
      return { ok: true };
    });
    stopSyntheticStream('global-media-stale-test');
    const result = await stale;
    assert.equal(result.cancelled, true);
    assert.equal(staleRunStarted, false);
  } finally {
    releaseBlocker();
    await blocker;
  }
});

test('confirms a voice state from the gateway', async () => {
  const { client } = fakeClient();
  const result = await sendVoiceOpConfirmed(client, 'guild-1', 'channel-1', { selfVideo: true }, 250);
  assert.equal(result.ok, true);
});

test('confirms a raw gateway envelope and rejects mismatched requested flags', async () => {
  const { client } = fakeClient({ confirms: false });
  const pending = sendVoiceOpConfirmed(client, 'guild-1', 'channel-1', { selfVideo: true }, 250);
  client.ws.emit('VOICE_STATE_UPDATE', { d: { user_id: 'user-1', guild_id: 'guild-1', channel_id: 'channel-1', self_video: false } });
  setImmediate(() => client.ws.emit('VOICE_STATE_UPDATE', { d: { user_id: 'user-1', guild_id: 'guild-1', channel_id: 'channel-1', self_video: true } }));
  assert.equal((await pending).ok, true);
});

test('confirms a doubly wrapped gateway voice event', async () => {
  const { client } = fakeClient({ confirms: false });
  const pending = sendVoiceOpConfirmed(client, 'guild-1', 'channel-1', { selfMute: false }, 250);
  client.ws.emit('VOICE_STATE_UPDATE', { d: { d: { user_id: 'user-1', guild_id: 'guild-1', channel_id: 'channel-1', self_mute: false } } });
  assert.equal((await pending).ok, true);
});

test('returns a clear error when the gateway is not ready', async () => {
  const { client } = fakeClient({ ready: false });
  const result = await sendVoiceOpConfirmed(client, 'guild-1', 'channel-1', {}, 250);
  assert.equal(result.ok, false);
  assert.match(result.error, /Gateway not ready/);
});

test('does not hang when a client has no active shard', async () => {
  const client = { user: { id: 'user-1' }, ws: { shards: { first: () => null } } };
  const result = await sendVoiceOpConfirmed(client, 'guild-1', 'channel-1', {}, 250);
  assert.deepEqual(result, { ok: false, error: 'No active gateway shard' });
});

test('does not treat a stale cached room as confirmation that a null-channel leave succeeded', async () => {
  const { client } = fakeClient({ confirms: false });
  client.guilds = { cache: new Map([['guild-1', {
    id: 'guild-1', voiceStates: { cache: new Map([['user-1', { id: 'user-1', guildId: 'guild-1', channelId: 'channel-1' }]]) },
  }]]) };
  const result = await sendVoiceOpConfirmed(client, 'guild-1', null, {}, 100);
  assert.equal(result.ok, false);
  assert.match(result.error, /did not confirm/);
});

test('queues a leave locally when Gateway is disconnected instead of surfacing status 5 as an error', async () => {
  const { pendingVoiceLeaves, requestVoiceLeave, voiceSessions } = require('../server');
  const suffix = `${Date.now()}-${Math.random()}`;
  const name = `deferred-leave-${suffix}`;
  const guildId = `guild-${suffix}`;
  const userId = `user-${suffix}`;
  const ws = new EventEmitter();
  let sent = 0;
  const shard = { status: 5, send() { sent += 1; } };
  ws.shards = { first: () => shard };
  const client = new EventEmitter();
  client.user = { id: userId, username: name };
  client.ws = ws;
  client.guilds = { cache: new Map([[guildId, { id: guildId, voiceStates: { cache: new Map([[userId, { id: userId, guildId, channelId: 'room-1' }]]) } }]]) };
  let localDisconnects = 0;
  client.voice = { connection: { channel: { id: 'room-1' }, _disconnect() { localDisconnects += 1; } } };
  const key = `${name}__${guildId}`;
  clients.set(name, { client });
  voiceSessions.set(key, { name, guildId, channelId: 'room-1' });
  try {
    const result = await requestVoiceLeave(name, guildId);
    assert.equal(result.ok, true);
    assert.equal(result.deferred, true);
    assert.equal(result.pendingGateway, true);
    assert.equal(result.channelId, 'room-1');
    assert.equal(sent, 0, 'must not send OP4 while disconnected');
    assert.equal(localDisconnects, 1, 'local media/voice resources should be detached');
    assert.equal(client.voice.connection, null);
    assert.equal(pendingVoiceLeaves.get(key)?.channelId, 'room-1');
    assert.equal(voiceSessions.has(key), false);
  } finally {
    require('../server').clearPendingVoiceLeave(name, guildId);
    clients.delete(name);
    voiceSessions.delete(key);
  }
});

test('sends the queued leave after Gateway becomes ready and clears its pending record', async () => {
  const { pendingVoiceLeaves, queuePendingVoiceLeave, flushPendingVoiceLeavesForAccount, voiceSessions, clearPendingVoiceLeave } = require('../server');
  const suffix = `${Date.now()}-${Math.random()}`;
  const name = `flush-leave-${suffix}`;
  const guildId = `guild-${suffix}`;
  const userId = `user-${suffix}`;
  const ws = new EventEmitter();
  const shard = { status: 5, send(payload) {
    setImmediate(() => ws.emit('VOICE_STATE_UPDATE', {
      user_id: userId, guild_id: guildId, channel_id: payload.d.channel_id,
      self_mute: false, self_deaf: false, self_video: false, self_stream: false,
    }));
  } };
  ws.shards = { first: () => shard };
  const client = new EventEmitter();
  client.user = { id: userId, username: name };
  client.ws = ws;
  client.guilds = { cache: new Map([[guildId, { id: guildId, voiceStates: { cache: new Map([[userId, { id: userId, guildId, channelId: 'room-1' }]]) } }]]) };
  clients.set(name, { client });
  const key = `${name}__${guildId}`;
  voiceSessions.set(key, { name, guildId, channelId: 'room-1' });
  queuePendingVoiceLeave(name, guildId, 'room-1');
  try {
    shard.status = 0;
    const results = await flushPendingVoiceLeavesForAccount(name);
    assert.deepEqual(results, [{ name, ok: true }]);
    assert.equal(pendingVoiceLeaves.has(key), false);
    assert.equal(voiceSessions.has(key), false);
  } finally {
    clearPendingVoiceLeave(name, guildId);
    clients.delete(name);
    voiceSessions.delete(key);
  }
});

test('cancels a queued leave when the account has moved to another room before retry', async () => {
  const { pendingVoiceLeaves, queuePendingVoiceLeave, flushPendingVoiceLeavesForAccount, clearPendingVoiceLeave } = require('../server');
  const suffix = `${Date.now()}-${Math.random()}`;
  const name = `moved-before-leave-${suffix}`;
  const guildId = `guild-${suffix}`;
  const userId = `user-${suffix}`;
  const ws = new EventEmitter();
  let sent = 0;
  const shard = { status: 0, send() { sent += 1; } };
  ws.shards = { first: () => shard };
  const client = new EventEmitter();
  client.user = { id: userId, username: name };
  client.ws = ws;
  client.guilds = { cache: new Map([[guildId, { id: guildId, voiceStates: { cache: new Map([[userId, { id: userId, guildId, channelId: 'room-2' }]]) } }]]) };
  clients.set(name, { client });
  const key = `${name}__${guildId}`;
  queuePendingVoiceLeave(name, guildId, 'room-1');
  try {
    const results = await flushPendingVoiceLeavesForAccount(name);
    assert.deepEqual(results, [{ name, ok: true, cancelled: true, reason: 'Account moved to another room before the queued leave ran' }]);
    assert.equal(sent, 0, 'must not send OP4 after the account moved');
    assert.equal(pendingVoiceLeaves.has(key), false);
  } finally {
    clearPendingVoiceLeave(name, guildId);
    clients.delete(name);
  }
});

test('requires a connected primary voice and initialized UDP socket before video transmission', () => {
  const { primaryVoiceTransportReady } = require('../server');
  const ready = { status: 0, sockets: { udp: { socket: {}, discordAddress: '127.0.0.1', discordPort: 5000, localAddress: '127.0.0.1', localPort: 5001 } } };
  assert.equal(primaryVoiceTransportReady(ready), true);
  assert.equal(primaryVoiceTransportReady({ ...ready, status: 1 }), false);
  assert.equal(primaryVoiceTransportReady({ ...ready, sockets: { udp: { discordAddress: '127.0.0.1', discordPort: 5000, localAddress: '127.0.0.1', localPort: 5001 } } }), false);
});

test('rebuilds a broken camera voice connection through VoiceManager without a competing transport', async () => {
  const { ensurePrimaryVoiceConnectionReady } = require('../server');
  const guildId = 'camera-recovery-guild';
  const channelId = 'camera-recovery-room';
  const userId = 'camera-recovery-user';
  const channel = { id: channelId };
  let oldDisconnects = 0;
  const oldConnection = { status: 1, channel, _disconnect() { oldDisconnects += 1; } };
  const freshConnection = { status: 0, channel, sockets: { udp: { socket: {}, discordAddress: '127.0.0.1', discordPort: 5000, localAddress: '127.0.0.1', localPort: 5001 } } };
  const shard = { status: 0, send() {} };
  const client = {
    user: { id: userId },
    ws: { shards: { first: () => shard } },
    guilds: { cache: new Map([[guildId, {
      id: guildId,
      channels: { cache: new Map([[channelId, channel]]) },
      voiceStates: { cache: new Map([[userId, { id: userId, guildId, channelId }]]) },
    }]]) },
    voice: { connection: oldConnection, async joinChannel(joinedChannel, options) {
      assert.equal(joinedChannel, channel);
      assert.deepEqual(options, { selfMute: true, selfDeaf: false, selfVideo: false });
      this.connection = freshConnection;
      return freshConnection;
    } },
  };
  const result = await ensurePrimaryVoiceConnectionReady(client, guildId, channelId, { selfMute: true });
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(result.connection, freshConnection);
  assert.equal(oldDisconnects, 1);
  assert.equal(client.voice.connection, freshConnection);
});

test('does not accept a voice event that omits requested state flags', async () => {
  const { client } = fakeClient({ confirms: false });
  const pending = sendVoiceOpConfirmed(client, 'guild-1', 'channel-1', { selfMute: true }, 80);
  client.ws.emit('VOICE_STATE_UPDATE', { user_id: 'user-1', guild_id: 'guild-1', channel_id: 'channel-1' });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /did not confirm/);
});

test('classifies missing Voice Server Update separately from socket and WebRTC failures', () => {
  assert.deepEqual(voiceFailureHints({ gatewayReady: true, rawVoiceState: 1, rawVoiceServer: 0, hasSession: false, hasVoiceToken: false, voiceSocketStarted: false, voiceSocketOpen: false, webRtcReady: false, voiceEventGuildMismatch: 0, voiceEventChannelMismatch: 0, targetValidation: { ok: true } }), ['no-matching-voice-server-dispatch', 'voice-server-update-missing-or-filtered']);
  assert.deepEqual(voiceFailureHints({ gatewayReady: true, rawVoiceState: 1, rawVoiceServer: 1, hasSession: true, hasVoiceToken: true, voiceSocketStarted: true, voiceSocketOpen: false, webRtcReady: false, voiceEndpoint: null, voiceEventGuildMismatch: 1, voiceEventChannelMismatch: 1, targetValidation: { ok: false } }), ['voice-server-dispatch-without-endpoint', 'voice-event-guild-mismatch', 'voice-event-channel-mismatch', 'target-channel-validation-failed', 'voice-socket-open-failed']);
});

test('filters Streamer voice events to the requested guild and channel', () => {
  const { EventEmitter } = require('node:events');
  const streamer = { _gatewayEmitter: new EventEmitter() };
  const received = [];
  streamer._gatewayEmitter.on('VOICE_STATE_UPDATE', (data) => received.push(data));
  assert.equal(installVoiceEventFilter(streamer, 'user-1', 'guild-1', 'channel-1'), true);
  streamer._gatewayEmitter.emit('VOICE_STATE_UPDATE', { user_id: 'user-1', guild_id: 'other-guild', channel_id: 'channel-1', session_id: 'wrong' });
  streamer._gatewayEmitter.emit('VOICE_STATE_UPDATE', { user_id: 'user-1', guild_id: 'guild-1', channel_id: 'other-channel', session_id: 'wrong' });
  streamer._gatewayEmitter.emit('VOICE_STATE_UPDATE', { user_id: 'user-1', guild_id: 'guild-1', channel_id: 'channel-1', session_id: 'right' });
  assert.deepEqual(received.map((item) => item.session_id), ['right']);
});

test('re-targets an existing Streamer event filter for the next account', () => {
  const streamer = { _gatewayEmitter: new EventEmitter() };
  const received = [];
  streamer._gatewayEmitter.on('VOICE_STATE_UPDATE', (data) => received.push(data.session_id));
  assert.equal(installVoiceEventFilter(streamer, 'user-1', 'guild-1', 'channel-1'), true);
  assert.equal(installVoiceEventFilter(streamer, 'user-2', 'guild-2', 'channel-2'), true);
  streamer._gatewayEmitter.emit('VOICE_STATE_UPDATE', { user_id: 'user-1', guild_id: 'guild-1', channel_id: 'channel-1', session_id: 'old' });
  streamer._gatewayEmitter.emit('VOICE_STATE_UPDATE', { user_id: 'user-2', guild_id: 'guild-2', channel_id: 'channel-2', session_id: 'new' });
  assert.deepEqual(received, ['new']);
});

test('does not treat a cached voice session as a canonical VoiceManager connection', () => {
  const connection = { channel: { id: 'channel-live' } };
  assert.equal(voiceConnectionChannelId(connection), 'channel-live');
  assert.equal(voiceConnectionChannelId(null), null);
});

test('starts primary media before waiting for Discord stream signaling', async () => {
  const order = [];
  let resolveSignaling;
  const signaling = new Promise((resolve) => { resolveSignaling = resolve; });
  const connection = {
    playVideo: () => {
      order.push('playVideo');
      setImmediate(() => { order.push('discord-signaling'); resolveSignaling(); });
      return { id: 'dispatcher' };
    },
  };
  const dispatcher = await playPrimaryMediaAndWait(connection, {}, signaling);
  assert.deepEqual(order, ['playVideo', 'discord-signaling']);
  assert.deepEqual(dispatcher, { id: 'dispatcher' });
});

test('cleans a half-open primary stream connection without crashing on a delayed websocket error', async () => {
  let disconnected = 0;
  const streamConnection = new EventEmitter();
  streamConnection.disconnect = () => {
    disconnected += 1;
    setImmediate(() => streamConnection.emit('error', new Error('WebSocket was closed before the connection was established')));
  };
  const connection = { streamConnection };
  assert.equal(cleanupPrimaryStreamAttempt(connection, streamConnection), true);
  assert.equal(disconnected, 1);
  assert.equal(connection.streamConnection, null);
  assert.equal(cleanupPrimaryStreamAttempt(connection, null), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(streamConnection.listenerCount('error'), 1);
});

test('destroys a primary dispatcher when media start is cancelled during signaling', async () => {
  let resolveSignaling;
  const signaling = new Promise((resolve) => { resolveSignaling = resolve; });
  let destroyed = 0;
  const pending = playPrimaryMediaAndWait({ playVideo: () => ({ destroy: () => { destroyed += 1; } }) }, {}, signaling, () => false);
  resolveSignaling();
  await assert.rejects(pending, /cancelled by a newer account operation/);
  assert.equal(destroyed, 1);
});

test('supersedes operations for the whole account, even across guilds', () => {
  const first = beginAccountOperation('account-scope', 'guild-a', 'media');
  const second = beginAccountOperation('account-scope', 'guild-b', 'move');
  assert.equal(operationKey('account-scope', 'guild-a'), operationKey('account-scope', 'guild-b'));
  assert.equal(operationIsCurrent(first), false);
  assert.equal(operationIsCurrent(second), true);
  endAccountOperation(second);
});

test('isolates bulk voice control from accounts managed by rotation in the same guild', () => {
  const taskId = 'test-rotation-isolation';
  rotations.set(taskId, { id: taskId, guildId: 'guild-1', accounts: ['rotating-account'] });
  try {
    assert.deepEqual([...rotationControlledAccounts('guild-1')], ['rotating-account']);
    assert.deepEqual([...rotationControlledAccounts('guild-2')], []);
  } finally {
    rotations.delete(taskId);
  }
});

test('detects duplicate task ownership and supersedes stale account operations', () => {
  const taskId = 'test-duplicate-rotation';
  rotations.set(taskId, { id: taskId, guildId: 'guild-1', accounts: ['account-a'] });
  try {
    assert.deepEqual(taskConflict(['account-a', 'account-b'], 'guild-1', 'rotation'), [{ id: taskId, accounts: ['account-a'] }]);
    const first = beginAccountOperation('account-a', 'guild-1', 'state');
    const second = beginAccountOperation('account-a', 'guild-1', 'move');
    assert.equal(operationIsCurrent(first), false);
    assert.equal(operationIsCurrent(second), true);
    endAccountOperation(second);
  } finally {
    rotations.delete(taskId);
  }
});

test('filters accounts already owned by another live task', () => {
  const rotationId = 'candidate-rotation';
  const cycleId = 'candidate-cycle';
  rotations.set(rotationId, { id: rotationId, guildId: 'guild-candidates', accounts: ['account-busy'] });
  stateCycles.set(cycleId, { id: cycleId, guildId: 'guild-candidates', accounts: ['account-cycle-busy'] });
  try {
    assert.equal(taskHasAccountElsewhere('account-busy', 'guild-candidates', 'rotation', 'new-task'), true);
    assert.equal(taskHasAccountElsewhere('account-free', 'guild-candidates', 'rotation', 'new-task'), false);
    assert.equal(taskHasAccountElsewhere('account-cycle-busy', 'guild-candidates', 'cycle', 'new-task'), true);
    assert.equal(taskHasAccountElsewhere('account-cycle-busy', 'guild-candidates', 'rotation', 'new-task'), false);
    assert.equal(taskHasAccountElsewhere('account-busy', 'guild-candidates', 'rotation', rotationId), false);
  } finally {
    rotations.delete(rotationId);
    stateCycles.delete(cycleId);
  }
});

test('parses rot room IDs separated by spaces, commas, Arabic commas, pipes, or Discord channel mentions', () => {
  const ids = ['123456789012345678', '234567890123456789', '345678901234567890'];
  assert.deepEqual(parseRotationChannelIds(`${ids[0]} ${ids[1]}, <#${ids[2]}>`), { ok: true, ids });
  assert.deepEqual(parseRotationChannelIds(`${ids[0]}،${ids[1]}|${ids[2]}`), { ok: true, ids });
  assert.equal(parseRotationChannelIds(`${ids[0]} ${ids[0]}`).ok, false);
  assert.equal(parseRotationChannelIds(`${ids[0]} nope ${ids[1]}`).ok, false);
});

test('automation task conflicts are global by task type, not limited to the selected guild', () => {
  const taskId = 'global-conflict-rotation';
  rotations.set(taskId, { id: taskId, type: 'rotation', active: true, guildId: 'guild-old', accounts: ['rot-global-account'] });
  try {
    assert.deepEqual(taskConflict(['rot-global-account'], 'guild-new', 'rotation'), [{ id: taskId, accounts: ['rot-global-account'] }]);
    assert.deepEqual(taskConflict(['rot-global-account'], 'guild-new', 'cycle'), []);
  } finally {
    rotations.delete(taskId);
  }
});

test('removing an account from old automation tasks preserves peers and deletes emptied task timers', () => {
  const rotationId = 'remove-old-rotation';
  const cycleId = 'remove-old-cycle';
  const rotationTimer = setInterval(() => {}, 60_000);
  const cycleTimer = setTimeout(() => {}, 60_000);
  const rotation = { id: rotationId, active: true, guildId: 'guild-old', accounts: ['rot-replaced', 'rot-peer'], pausedAccounts: ['rot-replaced'], accountTargets: { 'rot-replaced': 'room-old', 'rot-peer': 'room-peer' }, accountStatus: { 'rot-replaced': { ok: false }, 'rot-peer': { ok: true } }, timer: rotationTimer };
  const cycle = { id: cycleId, active: true, guildId: 'guild-old', accounts: ['rot-replaced'], pausedAccounts: [], accountStateIdx: { 'rot-replaced': 2 }, stateHistory: { 'rot-replaced': [0, 2] }, timer: cycleTimer };
  rotations.set(rotationId, rotation);
  stateCycles.set(cycleId, cycle);
  try {
    assert.equal(removeAccountFromAutomationTasks('rot-replaced'), true);
    assert.deepEqual(rotation.accounts, ['rot-peer']);
    assert.deepEqual(rotation.pausedAccounts, []);
    assert.deepEqual(rotation.accountTargets, { 'rot-peer': 'room-peer' });
    assert.equal(rotation.accountStatus['rot-replaced'], undefined);
    assert.equal(rotations.has(rotationId), true);
    assert.equal(stateCycles.has(cycleId), false);
    assert.equal(removeAccountFromAutomationTasks('rot-replaced'), false);
  } finally {
    clearInterval(rotationTimer);
    clearTimeout(cycleTimer);
    rotations.delete(rotationId);
    stateCycles.delete(cycleId);
  }
});

test('same-kind replacement preserves a paused task of the other automation kind', () => {
  const rotationId = 'same-kind-replace-room';
  const cycleId = 'same-kind-replace-cycle';
  const rotation = { id: rotationId, active: true, guildId: 'guild-a', accounts: ['replace-one', 'room-peer'], pausedAccounts: ['replace-one'], accountTargets: { 'replace-one': 'room-a' } };
  const cycle = { id: cycleId, active: true, guildId: 'guild-a', accounts: ['replace-one'], pausedAccounts: ['replace-one'], stateHistory: { 'replace-one': [0, 1] }, accountStateIdx: { 'replace-one': 1 } };
  rotations.set(rotationId, rotation);
  stateCycles.set(cycleId, cycle);
  try {
    assert.equal(removeAccountFromAutomationTasks('replace-one', ['rotation']), true);
    assert.deepEqual(rotation.accounts, ['room-peer']);
    assert.deepEqual(rotation.pausedAccounts, []);
    assert.deepEqual(cycle.accounts, ['replace-one']);
    assert.deepEqual(cycle.pausedAccounts, ['replace-one']);
    assert.deepEqual(cycle.stateHistory['replace-one'], [0, 1]);
  } finally {
    rotations.delete(rotationId);
    stateCycles.delete(cycleId);
  }
});

test('continues Playing when the optional follow-up message cannot be sent', async () => {
  const account = 'playing-message-failure';
  const message = {
    id: 'message-1',
    createdTimestamp: Date.now(),
    components: [{ components: [{ type: 2, customId: 'button-1', label: 'Join' }] }],
    clickButton: async () => {},
  };
  const channel = {
    messages: { fetch: async () => new Map([[message.id, message]]) },
    send: async () => { throw new Error('temporary send failure'); },
  };
  clients.set(account, { client: { channels: { fetch: async () => channel } } });
  const session = { account, channelId: 'text-1', steps: [{ button: 'Join', phrase: 'hello' }], currentIndex: 0 };
  try {
    const result = await sendPlayingPhrase(session);
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.messageFailed, true);
    assert.equal(session.currentIndex, 0);
  } finally {
    clients.delete(account);
  }
});

test('captures Invalid Form Body from the component REST request and skips the rejected button', async () => {
  const account = 'playing-invalid-component';
  const { EventEmitter } = require('node:events');
  const eventClient = new EventEmitter();
  eventClient.incrementMaxListeners = () => {};
  eventClient.decrementMaxListeners = () => {};
  eventClient.sessionId = 'session';
  eventClient.api = { interactions: { post: async () => { const error = new Error('DiscordAPIError[50035]: Invalid Form Body'); error.code = 50035; throw error; } } };
  const message = {
    id: 'invalid-component-message',
    createdTimestamp: Date.now(),
    guildId: 'guild',
    channelId: 'text-invalid',
    applicationId: 'application',
    author: { id: 'application' },
    flags: { bitfield: 0 },
    client: eventClient,
    components: [{ components: [{ type: 2, customId: 'stale-button', label: 'Join' }] }],
    resolveComponent: (customId) => customId === 'stale-button' ? { type: 'BUTTON', customId, disabled: false } : null,
    clickButton: () => { throw new Error('fallback must not be used'); },
  };
  const channel = { messages: { fetch: async () => new Map([[message.id, message]]) } };
  clients.set(account, { client: { channels: { fetch: async () => channel } } });
  const session = { account, channelId: 'text-invalid', steps: [{ button: 'Join' }], currentIndex: 0 };
  try {
    const result = await sendPlayingPhrase(session);
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.clickFailed, true);
    assert.match(result.error, /Invalid Form Body/);
    assert.equal(session.lastAction.clickFailed, true);
    assert.equal(eventClient.listenerCount('messageCreate'), 1, 'waiter is consumed safely and expires without an unhandled rejection');
  } finally {
    clients.delete(account);
  }
});

test('uses the current step and exact button label when several buttons are present', async () => {
  const account = 'playing-exact-button';
  const sent = [];
  const messages = [
    { id: 'message-many-buttons', createdTimestamp: Date.now(), components: [{ components: [{ type: 2, customId: 'join', label: 'Join' }, { type: 2, customId: 'join-now', label: 'Join now' }] }], clickButton: async () => {} },
  ];
  const channel = {
    messages: { fetch: async () => new Map(messages.map((message) => [message.id, message])) },
    send: async (phrase) => { sent.push(phrase); },
  };
  clients.set(account, { client: { channels: { fetch: async () => channel } } });
  const session = { account, channelId: 'text-2', steps: [{ button: 'Join', phrase: 'first' }, { button: 'Join now', phrase: 'second' }], currentIndex: 0 };
  try {
    const first = await sendPlayingPhrase(session);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const second = await sendPlayingPhrase(session);
    assert.equal(first.button, 'Join');
    assert.equal(second.button, 'Join now');
    assert.deepEqual(sent, ['first', 'second']);
  } finally {
    clients.delete(account);
  }
});

test('treats any configured label as an exact target instead of selecting any button', async () => {
  const account = 'playing-explicit-label';
  const clicked = [];
  const message = {
    id: 'message-explicit-label',
    createdTimestamp: Date.now(),
    components: [{ components: [
      { type: 2, customId: 'other', label: 'Ahmed.' },
      { type: 2, customId: 'explicit', label: '🎲 اختيار' },
    ] }],
    clickButton: async (customId) => { clicked.push(customId); },
  };
  const channel = {
    messages: { fetch: async () => new Map([[message.id, message]]) },
    send: async () => {},
  };
  clients.set(account, { client: { channels: { fetch: async () => channel } } });
  try {
    const result = await sendPlayingPhrase({ account, channelId: 'text-3', steps: [{ button: 'اختيار', phrase: '' }], currentIndex: 0 });
    assert.equal(result.button, 'اختيار');
    assert.deepEqual(clicked, ['explicit']);
  } finally {
    clients.delete(account);
  }
});

test('stopping a Playing session invalidates its pending run', () => {
  const account = 'playing-stop-token';
  const timer = setTimeout(() => {}, 10000);
  playingSessions.set(account, { account, active: true, status: 'running', runToken: 4, timer });
  try {
    assert.equal(stopPlayingSession(account, 'test'), true);
    const session = playingSessions.get(account);
    assert.equal(session.active, false);
    assert.equal(session.status, 'stopped');
    assert.equal(session.runToken, 5);
    assert.equal(session.timer, null);
  } finally {
    playingSessions.delete(account);
  }
});

test('stop prevents an in-flight Playing interaction from continuing or scheduling duplicate clicks', async () => {
  const account = 'playing-stop-inflight';
  const eventClient = new EventEmitter();
  eventClient.incrementMaxListeners = () => {};
  eventClient.decrementMaxListeners = () => {};
  eventClient.sessionId = 'session';
  let releasePost;
  let signalPostStarted;
  const postStarted = new Promise((resolve) => { signalPostStarted = resolve; });
  let postCount = 0;
  let sentPhrase = false;
  eventClient.api = { interactions: { post: ({ data }) => {
    postCount += 1;
    signalPostStarted(data.nonce);
    return new Promise((resolve) => { releasePost = () => { eventClient.emit('messageCreate', { nonce: data.nonce }); resolve(); }; });
  } } };
  const message = {
    id: 'inflight-message', createdTimestamp: Date.now(), guildId: 'guild', channelId: 'text-inflight',
    applicationId: 'application', author: { id: 'application' }, flags: { bitfield: 0 }, client: eventClient,
    components: [{ components: [{ type: 2, customId: 'join', label: 'Join' }] }],
    resolveComponent: (customId) => ({ type: 'BUTTON', customId, disabled: false }),
  };
  const channel = {
    messages: { fetch: async () => new Map([[message.id, message]]) },
    send: async () => { sentPhrase = true; },
  };
  const session = { account, channelId: 'text-inflight', steps: [{ button: 'Join', phrase: 'should-not-send' }], intervalMs: 10, active: true, status: 'running', timer: null, currentIndex: 0, runToken: 1 };
  const saved = playingSessions.get(account);
  playingSessions.set(account, session);
  clients.set(account, { client: { channels: { fetch: async () => channel } } });
  try {
    schedulePlaying(session, 0);
    schedulePlaying(session, 0);
    const nonce = await postStarted;
    assert.equal(postCount, 1, 'duplicate scheduling must not dispatch concurrent clicks');
    assert.equal(stopPlayingSession(account, 'test-stop-inflight'), true);
    releasePost();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(session.active, false);
    assert.equal(session.timer, null);
    assert.equal(postCount, 1, `only the already-submitted request ${nonce} may complete`);
    assert.equal(sentPhrase, false, 'stopped session must not continue to the follow-up action');
    assert.equal(session.currentIndex, 0);
  } finally {
    clearTimeout(session.timer);
    playingSessions.delete(account);
    if (saved) playingSessions.set(account, saved);
    clients.delete(account);
  }
});

test('starts all saved Playing sessions and does not duplicate active timers', () => {
  const saved = [...playingSessions.entries()];
  playingSessions.clear();
  const first = { account: 'bulk-start-1', channelId: 'text-1', steps: [{ button: 'Join' }], intervalMs: 60000, active: false, status: 'saved', timer: null };
  const second = { account: 'bulk-start-2', channelId: 'text-2', steps: [{ button: 'Join' }], intervalMs: 60000, active: true, status: 'running', timer: null };
  playingSessions.set(first.account, first);
  playingSessions.set(second.account, second);
  try {
    const result = startAllPlayingSessions('test');
    assert.equal(result.started, 1);
    assert.equal(result.alreadyActive, 1);
    assert.equal(first.active, true);
    assert.equal(second.active, true);
    clearTimeout(first.timer);
  } finally {
    playingSessions.delete(first.account);
    playingSessions.delete(second.account);
    for (const [account, session] of saved) playingSessions.set(account, session);
  }
});

test('adds a connected account to an active Playing session and starts it immediately', async () => {
  const source = 'playing-add-source';
  const added = 'playing-add-target';
  const savedSessions = [...playingSessions.entries()];
  const savedClients = [...clients.entries()];
  playingSessions.clear();
  clients.clear();
  const channel = { messages: { fetch: async () => new Map() } };
  clients.set(source, { client: { channels: { fetch: async () => channel } } });
  clients.set(added, { client: { channels: { fetch: async () => channel } } });
  playingSessions.set(source, { account: source, channelId: 'text-add', steps: [{ button: 'Join' }], intervalMs: 60000, active: true, status: 'running', runToken: 3, timer: null });
  try {
    const result = await addPlayingAccounts(source, [added]);
    assert.equal(result.added, 1);
    assert.equal(playingSessions.get(added).active, true);
    clearTimeout(playingSessions.get(added).timer);
  } finally {
    for (const session of playingSessions.values()) clearTimeout(session.timer);
    playingSessions.clear();
    for (const [account, entry] of savedClients) clients.set(account, entry);
    for (const [account, session] of savedSessions) playingSessions.set(account, session);
  }
});

test('stops every saved Playing session', () => {
  const saved = [...playingSessions.entries()];
  playingSessions.clear();
  const accounts = ['bulk-stop-1', 'bulk-stop-2'];
  for (const account of accounts) playingSessions.set(account, { account, active: true, status: 'running', timer: setTimeout(() => {}, 10000) });
  try {
    const result = stopAllPlayingSessions('test');
    assert.equal(result.stopped, 2);
    for (const account of accounts) assert.equal(playingSessions.get(account).active, false);
  } finally {
    for (const account of accounts) playingSessions.delete(account);
    for (const [account, session] of saved) playingSessions.set(account, session);
  }
});

test('Discord start and stop commands control every Playing session with one reaction', async () => {
  const previousOwners = process.env.DISCORD_COMMAND_OWNERS;
  process.env.DISCORD_COMMAND_OWNERS = 'owner-1, owner-2';
  const saved = [...playingSessions.entries()];
  playingSessions.clear();
  const sessions = ['discord-command-1', 'discord-command-2'].map((account) => ({ account, channelId: 'text', steps: [{ button: 'Join' }], intervalMs: 60000, active: false, status: 'saved', timer: null }));
  sessions.forEach((session) => playingSessions.set(session.account, session));
  const reacted = [];
  let reactionAttempts = 0;
  const channel = {};
  const client = { user: { id: 'owner-1' } };
  try {
    assert.equal(await handlePlayingDiscordCommand(client, { id: 'command-start', content: 'start', author: { id: 'owner-1' }, channel, react: async (emoji) => {
      reactionAttempts += 1;
      if (reactionAttempts === 1) { const error = new Error('temporary network reset'); error.code = 'ECONNRESET'; throw error; }
      reacted.push(emoji);
    } }), true);
    assert.deepEqual(sessions.map((session) => session.active), [true, true]);
    assert.deepEqual(reacted, ['✅']);
    assert.equal(reactionAttempts, 2);
    assert.equal(await handlePlayingDiscordCommand(client, { id: 'command-stop', content: 'stop', author: { id: 'owner-1' }, channel, react: async (emoji) => reacted.push(emoji) }), true);
    assert.deepEqual(sessions.map((session) => session.active), [false, false]);
    assert.deepEqual(reacted, ['✅', '✅']);
    assert.equal(await handlePlayingDiscordCommand(client, { id: 'command-stop', content: 'stop', author: { id: 'owner-1' }, channel, react: async (emoji) => reacted.push(emoji) }), false);
    assert.deepEqual(reacted, ['✅', '✅']);
    assert.equal(await handlePlayingDiscordCommand(client, { id: 'command-unauthorized', content: 'start', author: { id: 'not-an-owner' }, channel, react: async (emoji) => reacted.push(emoji) }), false);
    assert.deepEqual(reacted, ['✅', '✅']);
    sessions.forEach((session) => clearTimeout(session.timer));
  } finally {
    sessions.forEach((session) => playingSessions.delete(session.account));
    for (const [account, session] of saved) playingSessions.set(account, session);
    if (previousOwners === undefined) delete process.env.DISCORD_COMMAND_OWNERS;
    else process.env.DISCORD_COMMAND_OWNERS = previousOwners;
  }
});

test('Discord on/off commands control only the rotation of the connected account that wrote them', async () => {
  const previousOwners = process.env.DISCORD_COMMAND_OWNERS;
  const previousChannel = process.env.DISCORD_COMMAND_CHANNEL_ID;
  const previousPrefix = process.env.DISCORD_COMMAND_PREFIX;
  const savedClients = [...clients.entries()];
  const taskId = 'discord-rotation-pause-resume';
  const accountA = 'rotation account a';
  const accountB = 'rotation account b';
  const clientA = { user: { id: 'discord-account-a' } };
  const clientB = { user: { id: 'discord-account-b' } };
  const task = { id: taskId, type: 'rotation', active: true, running: true, guildId: 'guild-x', channels: ['room-1', 'room-2'], accounts: [accountA, accountB], pausedAccounts: [], accountTargets: { [accountA]: 'room-1', [accountB]: 'room-2' }, accountStatus: {}, lastResults: [] };
  const cycleId = 'discord-state-cycle-pause-resume';
  const cycle = { id: cycleId, type: 'cycle', active: true, running: true, guildId: 'guild-x', accounts: [accountA], pausedAccounts: [], states: [{ selfMute: true }, { selfMute: false }], accountStateIdx: { [accountA]: 1 }, stateHistory: { [accountA]: [0, 1] } };
  process.env.DISCORD_COMMAND_OWNERS = '';
  process.env.DISCORD_COMMAND_CHANNEL_ID = 'commands';
  process.env.DISCORD_COMMAND_PREFIX = '!';
  clients.set(accountA, { client: clientA });
  clients.set(accountB, { client: clientB });
  rotations.set(taskId, task);
  stateCycles.set(cycleId, cycle);
  const reacted = [];
  const invoke = (listener, id, content, authorId) => handlePlayingDiscordCommand(listener, { id, content, channel: { id: 'commands' }, author: { id: authorId }, react: async (emoji) => reacted.push(emoji) });
  try {
    // Another connected account hearing the same message cannot control account A.
    assert.equal(await invoke(clientB, 'rotation-wrong-account', '!off', 'discord-account-a'), false);
    assert.deepEqual(task.pausedAccounts, []);
    assert.equal(await invoke(clientA, 'rotation-off', '!off', 'discord-account-a'), true);
    assert.deepEqual(task.pausedAccounts, [accountA]);
    assert.deepEqual(cycle.pausedAccounts, [accountA]);
    assert.equal(await invoke(clientA, 'rotation-off-again', '!off', 'discord-account-a'), true);
    assert.deepEqual(task.pausedAccounts, [accountA]);
    assert.deepEqual(cycle.pausedAccounts, [accountA]);
    assert.equal(isAccountManagedByActiveStateCycle(accountA, 'guild-x'), false);
    assert.deepEqual(task.accounts, [accountA, accountB]);
    assert.equal(task.accountTargets[accountA], 'room-1');
    assert.equal(await invoke(clientA, 'rotation-on', '!on', 'discord-account-a'), true);
    assert.deepEqual(task.pausedAccounts, []);
    assert.deepEqual(cycle.pausedAccounts, []);
    assert.equal(await invoke(clientA, 'rotation-on-again', '!on', 'discord-account-a'), true);
    assert.deepEqual(task.pausedAccounts, []);
    assert.deepEqual(cycle.pausedAccounts, []);
    assert.equal(isAccountManagedByActiveStateCycle(accountA, 'guild-x'), true);
    assert.deepEqual(cycle.accountStateIdx, { [accountA]: 1 });
    assert.deepEqual(cycle.stateHistory, { [accountA]: [0, 1] });
    assert.deepEqual(task.accounts, [accountA, accountB]);
    assert.deepEqual(reacted, ['✅', '✅', '✅', '✅']);
  } finally {
    rotations.delete(taskId);
    stateCycles.delete(cycleId);
    clients.delete(accountA); clients.delete(accountB);
    for (const [name, entry] of savedClients) clients.set(name, entry);
    if (previousOwners === undefined) delete process.env.DISCORD_COMMAND_OWNERS; else process.env.DISCORD_COMMAND_OWNERS = previousOwners;
    if (previousChannel === undefined) delete process.env.DISCORD_COMMAND_CHANNEL_ID; else process.env.DISCORD_COMMAND_CHANNEL_ID = previousChannel;
    if (previousPrefix === undefined) delete process.env.DISCORD_COMMAND_PREFIX; else process.env.DISCORD_COMMAND_PREFIX = previousPrefix;
  }
});

test('Discord rotation on/off rejects accounts without exactly one active rotation and honors channel restriction', async () => {
  const previousOwners = process.env.DISCORD_COMMAND_OWNERS;
  const previousChannel = process.env.DISCORD_COMMAND_CHANNEL_ID;
  const previousPrefix = process.env.DISCORD_COMMAND_PREFIX;
  const savedClients = [...clients.entries()];
  const account = 'rotation-cmd-account';
  const accountClient = { user: { id: 'rotation-self-id' } };
  const firstId = 'discord-rotation-task-a';
  const secondId = 'discord-rotation-task-b';
  const first = { id: firstId, active: true, guildId: 'guild-x', accounts: [account], pausedAccounts: [] };
  const second = { id: secondId, active: true, guildId: 'guild-y', accounts: [account], pausedAccounts: [] };
  process.env.DISCORD_COMMAND_OWNERS = '';
  process.env.DISCORD_COMMAND_CHANNEL_ID = 'commands';
  process.env.DISCORD_COMMAND_PREFIX = '!';
  clients.set(account, { client: accountClient });
  const reacted = [];
  const invoke = (id, content, channelId = 'commands') => handlePlayingDiscordCommand(accountClient, { id, content, channel: { id: channelId }, author: { id: 'rotation-self-id' }, react: async (emoji) => reacted.push(emoji) });
  try {
    assert.equal(await invoke('discord-rotation-no-task', '!off'), true);
    assert.deepEqual(reacted, ['❌']);
    rotations.set(firstId, first);
    rotations.set(secondId, second);
    assert.equal(await invoke('discord-rotation-ambiguous', '!off'), true);
    assert.equal(await invoke('discord-rotation-wrong-channel', '!off', 'other-channel'), false);
    assert.deepEqual(first.pausedAccounts, []);
    assert.deepEqual(second.pausedAccounts, []);
    assert.deepEqual(reacted, ['❌', '❌']);
  } finally {
    rotations.delete(firstId); rotations.delete(secondId);
    clients.delete(account);
    for (const [name, entry] of savedClients) clients.set(name, entry);
    if (previousOwners === undefined) delete process.env.DISCORD_COMMAND_OWNERS; else process.env.DISCORD_COMMAND_OWNERS = previousOwners;
    if (previousChannel === undefined) delete process.env.DISCORD_COMMAND_CHANNEL_ID; else process.env.DISCORD_COMMAND_CHANNEL_ID = previousChannel;
    if (previousPrefix === undefined) delete process.env.DISCORD_COMMAND_PREFIX; else process.env.DISCORD_COMMAND_PREFIX = previousPrefix;
  }
});

test('Discord on is idempotent for an already-running rotation and state cycle', async () => {
  const previousOwners = process.env.DISCORD_COMMAND_OWNERS;
  const previousChannel = process.env.DISCORD_COMMAND_CHANNEL_ID;
  const previousPrefix = process.env.DISCORD_COMMAND_PREFIX;
  const savedClients = [...clients.entries()];
  const account = 'rotation-already-on';
  const client = { user: { id: 'rotation-already-on-user' } };
  const rotationId = 'rotation-already-on-task';
  const cycleId = 'cycle-already-on-task';
  const rotation = { id: rotationId, active: true, running: false, guildId: 'guild-x', channels: [], accounts: [account], pausedAccounts: [] };
  const cycle = { id: cycleId, active: true, running: false, guildId: 'guild-x', states: [{ selfMute: false }, { selfMute: true }], accounts: [account], pausedAccounts: [] };
  process.env.DISCORD_COMMAND_OWNERS = '';
  process.env.DISCORD_COMMAND_CHANNEL_ID = '';
  process.env.DISCORD_COMMAND_PREFIX = '!';
  clients.set(account, { client });
  rotations.set(rotationId, rotation);
  stateCycles.set(cycleId, cycle);
  const reacted = [];
  try {
    assert.equal(await handlePlayingDiscordCommand(client, { id: 'rotation-already-on-command', content: '!on', author: { id: client.user.id }, channel: {}, react: async (emoji) => reacted.push(emoji) }), true);
    assert.deepEqual(rotation.pausedAccounts, []);
    assert.deepEqual(cycle.pausedAccounts, []);
    assert.deepEqual(reacted, ['✅']);
  } finally {
    rotations.delete(rotationId);
    stateCycles.delete(cycleId);
    clients.delete(account);
    for (const [name, entry] of savedClients) clients.set(name, entry);
    if (previousOwners === undefined) delete process.env.DISCORD_COMMAND_OWNERS; else process.env.DISCORD_COMMAND_OWNERS = previousOwners;
    if (previousChannel === undefined) delete process.env.DISCORD_COMMAND_CHANNEL_ID; else process.env.DISCORD_COMMAND_CHANNEL_ID = previousChannel;
    if (previousPrefix === undefined) delete process.env.DISCORD_COMMAND_PREFIX; else process.env.DISCORD_COMMAND_PREFIX = previousPrefix;
  }
});

test('Discord on keeps both task types paused and reacts with failure if room resumption fails', async () => {
  const previousOwners = process.env.DISCORD_COMMAND_OWNERS;
  const previousChannel = process.env.DISCORD_COMMAND_CHANNEL_ID;
  const previousPrefix = process.env.DISCORD_COMMAND_PREFIX;
  const savedClients = [...clients.entries()];
  const account = 'rotation-resume-failure';
  const client = { user: { id: 'rotation-resume-failure-user' } };
  const rotationId = 'rotation-resume-failure-task';
  const cycleId = 'cycle-resume-failure-task';
  const rotation = { id: rotationId, active: true, running: false, initializing: false, guildId: 'guild-x', channels: [], accounts: [account], pausedAccounts: [account] };
  const cycle = { id: cycleId, active: true, running: false, guildId: 'guild-x', states: [{ selfMute: false }, { selfMute: true }], accounts: [account], pausedAccounts: [account] };
  process.env.DISCORD_COMMAND_OWNERS = '';
  process.env.DISCORD_COMMAND_CHANNEL_ID = '';
  process.env.DISCORD_COMMAND_PREFIX = '!';
  clients.set(account, { client });
  rotations.set(rotationId, rotation);
  stateCycles.set(cycleId, cycle);
  const reacted = [];
  try {
    assert.equal(await handlePlayingDiscordCommand(client, { id: 'rotation-resume-failure-command', content: '!on', author: { id: client.user.id }, channel: {}, react: async (emoji) => reacted.push(emoji) }), true);
    assert.deepEqual(rotation.pausedAccounts, [account]);
    assert.deepEqual(cycle.pausedAccounts, [account]);
    assert.deepEqual(reacted, ['❌']);
  } finally {
    rotations.delete(rotationId);
    stateCycles.delete(cycleId);
    clients.delete(account);
    for (const [name, entry] of savedClients) clients.set(name, entry);
    if (previousOwners === undefined) delete process.env.DISCORD_COMMAND_OWNERS; else process.env.DISCORD_COMMAND_OWNERS = previousOwners;
    if (previousChannel === undefined) delete process.env.DISCORD_COMMAND_CHANNEL_ID; else process.env.DISCORD_COMMAND_CHANNEL_ID = previousChannel;
    if (previousPrefix === undefined) delete process.env.DISCORD_COMMAND_PREFIX; else process.env.DISCORD_COMMAND_PREFIX = previousPrefix;
  }
});

test('random room rotation assigns independent targets and avoids current rooms when possible', () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const targets = randomRotationTargets(
      ['account-a', 'account-b', 'account-c'],
      ['room-1', 'room-2', 'room-3'],
      (account) => ({ 'account-a': 'room-1', 'account-b': 'room-2', 'account-c': 'room-3' }[account]),
    );
    assert.deepEqual([...targets.values()].sort(), ['room-1', 'room-2', 'room-3']);
    assert.notEqual(targets.get('account-a'), 'room-1');
    assert.notEqual(targets.get('account-b'), 'room-2');
    assert.notEqual(targets.get('account-c'), 'room-3');
  } finally {
    Math.random = originalRandom;
  }
});


test('compacts state-cycle history to the current cycle without changing unseen-state selection', () => {
  const { compactStateHistory } = require('../server');
  const states = ['one', 'two', 'three'];
  const history = [0, 1, 2, 1, 0, 2];
  const compacted = compactStateHistory(states, history);
  assert.deepEqual(compacted, [1, 0, 2]);
  assert.equal(compacted.length, states.length);
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    assert.equal(nextStateIndex(states, history), nextStateIndex(states, compacted));
  } finally {
    Math.random = originalRandom;
  }
});

test('bounds successful state-cycle history even after many completed transitions', () => {
  const task = { states: ['one', 'two'], stateHistory: { alpha: Array.from({ length: 5000 }, (_, index) => index % 2) }, accountStateIdx: {} };
  assert.equal(recordSuccessfulCycleState(task, 'alpha', 0, true), true);
  assert.deepEqual(task.stateHistory.alpha, [0]);
  assert.equal(task.accountStateIdx.alpha, 0);
});

test('expires stale rate-limit buckets and caps high-cardinality maps', () => {
  const { getRateLimitBucket, pruneRateLimitBuckets } = require('../server');
  const buckets = new Map([
    ['stale', { start: 0, count: 3 }],
    ['active', { start: 900, count: 2 }],
  ]);
  assert.equal(pruneRateLimitBuckets(buckets, 1000, 500, 2), 1);
  assert.equal(buckets.has('stale'), false);
  assert.equal(getRateLimitBucket(buckets, 'next', 1000, 2).count, 0);
  getRateLimitBucket(buckets, 'overflow', 1001, 2);
  assert.equal(buckets.size, 2);
  assert.equal(buckets.has('active'), false, 'the oldest bucket is evicted only when the explicit capacity is reached');
});


test('projects only the account-owned Gateway voice state into a minimal event snapshot', () => {
  const { projectGatewayVoiceState } = require('../server');
  const client = { user: { id: 'self-user' } };
  const guild = { id: 'guild-event-test' };
  assert.equal(projectGatewayVoiceState(client, null, { id: 'other-user', guild, channelId: 'room-1' }), null);
  assert.deepEqual(projectGatewayVoiceState(client, null, {
    id: 'self-user', guild, channelId: 'room-1', selfMute: true,
    selfDeaf: false, selfVideo: true, streaming: false,
  }), {
    guildId: 'guild-event-test', channelId: 'room-1',
    selfMute: true, selfDeaf: false, selfVideo: true, selfStream: false,
  });
  assert.deepEqual(projectGatewayVoiceState(client, { id: 'self-user', guild }, {
    id: 'self-user', guild, channelId: null,
  }), {
    guildId: 'guild-event-test', channelId: null,
    selfMute: undefined, selfDeaf: undefined, selfVideo: undefined, selfStream: undefined,
  });
});

test('dashboard snapshots clear an explicitly left room and find voice membership in another guild', () => {
  const { buildClientSnapshots, voiceSessions } = require('../server');
  const account = `dashboard-voice-sync-${Date.now()}`;
  const userId = `dashboard-user-${Date.now()}`;
  const oldGuildId = `dashboard-old-guild-${Date.now()}`;
  const newGuildId = `dashboard-new-guild-${Date.now()}`;
  const oldGuild = { id: oldGuildId, channels: { cache: new Map() }, voiceStates: { cache: new Map([[userId, { id: userId, guildId: oldGuildId, channelId: null }]]) } };
  const newGuild = { id: newGuildId, channels: { cache: new Map() }, voiceStates: { cache: new Map() } };
  const client = { user: { id: userId, username: account }, guilds: { cache: new Map([[oldGuildId, oldGuild], [newGuildId, newGuild]]) } };
  const sessionKey = `${account}__${oldGuildId}`;
  clients.set(account, { client });
  voiceSessions.set(sessionKey, { name: account, guildId: oldGuildId, channelId: 'stale-room', selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false });
  try {
    assert.equal(buildClientSnapshots().find((item) => item.name === account).voice, null, 'an explicit channelId=null must override a stale saved session');
    newGuild.voiceStates.cache.set(userId, { id: userId, guildId: newGuildId, channelId: 'current-room', selfMute: true });
    const voice = buildClientSnapshots().find((item) => item.name === account).voice;
    assert.equal(voice.guildId, newGuildId);
    assert.equal(voice.channelId, 'current-room');
    assert.equal(voice.selfMute, true);
  } finally {
    clients.delete(account);
    voiceSessions.delete(sessionKey);
  }
});

test('caches per-account voice and Playing catalogs until a Gateway invalidation', () => {
  const { clients, buildVoiceGuildCatalog, buildPlayingChannelCatalog, invalidateVoiceGuildCatalog } = require('../server');
  const account = `catalog-test-${Date.now()}`;
  const guildId = `catalog-guild-${Date.now()}`;
  const voice = {
    id: `voice-${guildId}`, type: 2, name: 'Voice room', userLimit: 4, bitrate: 64000,
    members: { size: 1 }, permissionsFor: () => ({ has: () => true }),
  };
  const text = {
    id: `text-${guildId}`, type: 0, name: 'general', isText: () => true,
    permissionsFor: () => ({ has: () => true }),
  };
  const guild = {
    id: guildId, name: 'Test guild', iconURL: () => null,
    members: { me: { id: 'self-user' }, cache: new Map() },
    channels: { cache: new Map([[voice.id, voice], [text.id, text]]) },
    voiceStates: { cache: new Map() },
  };
  clients.set(account, { client: { user: { id: 'self-user' }, guilds: { cache: new Map([[guildId, guild]]) } } });
  try {
    invalidateVoiceGuildCatalog(account);
    assert.equal(buildVoiceGuildCatalog(account)[0].voiceChannels[0].name, 'Voice room');
    assert.equal(buildPlayingChannelCatalog(guildId).channels[0].name, 'general');
    voice.name = 'Renamed voice';
    text.name = 'renamed-general';
    assert.equal(buildVoiceGuildCatalog(account)[0].voiceChannels[0].name, 'Voice room', 'the derived voice catalog is reused before invalidation');
    assert.equal(buildPlayingChannelCatalog(guildId).channels[0].name, 'general', 'the Playing catalog is reused before invalidation');
    invalidateVoiceGuildCatalog(account);
    assert.equal(buildVoiceGuildCatalog(account)[0].voiceChannels[0].name, 'Renamed voice');
    assert.equal(buildPlayingChannelCatalog(guildId).channels[0].name, 'renamed-general');
  } finally {
    clients.delete(account);
    invalidateVoiceGuildCatalog(account);
  }
});

test('coalesces catalog changes for several accounts in the same guild', async () => {
  const { liveEvents, scheduleCatalogEvent } = require('../server');
  const guildId = `catalog-burst-${Date.now()}`;
  const events = [];
  const listener = (event) => { if (event.type === 'catalog.changed' && event.guildId === guildId) events.push(event); };
  liveEvents.on('event', listener);
  try {
    scheduleCatalogEvent(guildId, 'alpha');
    scheduleCatalogEvent(guildId, 'beta');
    scheduleCatalogEvent(guildId, 'gamma');
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].accounts.sort(), ['alpha', 'beta', 'gamma']);
  } finally {
    liveEvents.off('event', listener);
  }
});

test('parses a positive whole-number account limit and falls back to 30 for invalid values', () => {
  const { parseAccountLimit } = require('../server');
  assert.equal(parseAccountLimit('50'), 50);
  assert.equal(parseAccountLimit('0'), 30);
  assert.equal(parseAccountLimit('-2'), 30);
  assert.equal(parseAccountLimit('2.5'), 30);
  assert.equal(parseAccountLimit('invalid'), 30);
});

test('reserves account slots up to the configured account limit without concurrent overbooking', () => {
  const { clients, accountLimit, reserveAccountConnectSlots, releaseAccountConnectSlots } = require('../server');
  const previous = [...clients.entries()];
  clients.clear();
  try {
    for (let index = 0; index < accountLimit - 1; index += 1) clients.set(`limit-test-${index}`, {});
    const first = reserveAccountConnectSlots(1);
    assert.equal(first.accepted, 1);
    const competing = reserveAccountConnectSlots(1);
    assert.equal(competing.accepted, 0);
    assert.ok(competing.message.includes(`(${accountLimit} حسابًا)`));
    assert.ok(competing.message.includes(`${accountLimit + 10} حسابًا`));
    assert.match(competing.message, /20\$/);
    releaseAccountConnectSlots(first.reserved);
    clients.set(`limit-test-${accountLimit - 1}`, {});
    const atLimit = reserveAccountConnectSlots(1);
    assert.equal(atLimit.accepted, 0);
    assert.equal(atLimit.blocked, 1);
  } finally {
    releaseAccountConnectSlots(100);
    clients.clear();
    for (const [name, entry] of previous) clients.set(name, entry);
  }
});
test('Discord rot is self-authenticated and validates the current server voice rooms before reacting', async () => {
  const previousChannel = process.env.DISCORD_COMMAND_CHANNEL_ID;
  const previousPrefix = process.env.DISCORD_COMMAND_PREFIX;
  const savedClients = [...clients.entries()];
  const account = 'rot-validation-account';
  const client = { user: { id: 'rot-validation-self' }, guilds: { cache: new Map() } };
  const validVoice = { id: '123456789012345678', type: 2, permissionsFor: () => ({ has: () => true }), members: { size: 0 } };
  const textRoom = { id: '234567890123456789', type: 0 };
  const guild = { id: 'guild-rot-validation', name: 'Test guild', channels: { cache: new Map([[validVoice.id, validVoice], [textRoom.id, textRoom]]) }, members: { me: {} }, voiceStates: { cache: new Map() } };
  client.guilds.cache.set(guild.id, guild);
  clients.set(account, { client });
  process.env.DISCORD_COMMAND_CHANNEL_ID = '';
  process.env.DISCORD_COMMAND_PREFIX = '!';
  const reacted = [];
  const invoke = (id, authorId, guildArg, content = '!rot 123456789012345678 234567890123456789') => handlePlayingDiscordCommand(client, {
    id, content, guild: guildArg, channel: { id: 'rot-validation-channel', guild: guildArg }, author: { id: authorId },
    react: async (emoji) => reacted.push(emoji),
  });
  try {
    assert.equal(await invoke('rot-validation-not-self', 'someone-else', guild), false);
    assert.equal(await invoke('rot-validation-text-room', client.user.id, guild), true);
    assert.equal(await invoke('rot-validation-no-guild', client.user.id, null, '!rot 123456789012345678 345678901234567890'), true);
    assert.deepEqual(reacted, ['❌', '❌']);
    assert.equal([...rotations.values()].some((task) => (task.accounts || []).includes(account)), false);
    assert.equal([...stateCycles.values()].some((task) => (task.accounts || []).includes(account)), false);
  } finally {
    clients.delete(account);
    for (const [name, entry] of savedClients) clients.set(name, entry);
    if (previousChannel === undefined) delete process.env.DISCORD_COMMAND_CHANNEL_ID; else process.env.DISCORD_COMMAND_CHANNEL_ID = previousChannel;
    if (previousPrefix === undefined) delete process.env.DISCORD_COMMAND_PREFIX; else process.env.DISCORD_COMMAND_PREFIX = previousPrefix;
  }
});
test('scoped automation cleanup cannot remove a newer replacement task', () => {
  const oldId = 'stale-rot-setup';
  const newId = 'newer-rot-setup';
  rotations.set(oldId, { id: oldId, active: true, accounts: ['rot-race-account'], pausedAccounts: [] });
  rotations.set(newId, { id: newId, active: true, accounts: ['rot-race-account'], pausedAccounts: [] });
  try {
    assert.equal(removeAccountFromAutomationTasks('rot-race-account', ['rotation'], [oldId]), true);
    assert.equal(rotations.has(oldId), false);
    assert.equal(rotations.has(newId), true);
    assert.deepEqual(rotations.get(newId).accounts, ['rot-race-account']);
  } finally {
    rotations.delete(oldId);
    rotations.delete(newId);
  }
});
