const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { sendVoiceOp, sendVoiceOpConfirmed, rotations, rotationControlledAccounts, taskConflict, beginAccountOperation, operationIsCurrent, endAccountOperation, clients, sendPlayingPhrase, playingSessions, stopPlayingSession, startAllPlayingSessions, stopAllPlayingSessions, handlePlayingDiscordCommand } = require('../server');

function fakeClient({ ready = true, confirms = true } = {}) {
  const ws = new EventEmitter();
  let sent = null;
  const shard = {
    status: ready ? 0 : 1,
    send(payload) {
      sent = payload;
      if (confirms) setImmediate(() => ws.emit('VOICE_STATE_UPDATE', {
        user_id: 'user-1', guild_id: 'guild-1', channel_id: payload.d.channel_id,
        self_mute: payload.d.self_mute, self_deaf: payload.d.self_deaf,
        self_video: payload.d.self_video, self_stream: payload.d.self_stream,
      }));
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

test('does not accept a voice event that omits requested state flags', async () => {
  const { client } = fakeClient({ confirms: false });
  const pending = sendVoiceOpConfirmed(client, 'guild-1', 'channel-1', { selfMute: true }, 80);
  client.ws.emit('VOICE_STATE_UPDATE', { user_id: 'user-1', guild_id: 'guild-1', channel_id: 'channel-1' });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /did not confirm/);
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
  const saved = [...playingSessions.entries()];
  playingSessions.clear();
  const sessions = ['discord-command-1', 'discord-command-2'].map((account) => ({ account, channelId: 'text', steps: [{ button: 'Join' }], intervalMs: 60000, active: false, status: 'saved', timer: null }));
  sessions.forEach((session) => playingSessions.set(session.account, session));
  const reacted = [];
  const channel = {};
  const client = { user: { id: 'owner-1' } };
  try {
    assert.equal(await handlePlayingDiscordCommand(client, { id: 'command-start', content: 'start', author: { id: 'owner-1' }, channel, react: async (emoji) => reacted.push(emoji) }), true);
    assert.deepEqual(sessions.map((session) => session.active), [true, true]);
    assert.deepEqual(reacted, ['✅']);
    assert.equal(await handlePlayingDiscordCommand(client, { id: 'command-stop', content: 'stop', author: { id: 'owner-1' }, channel, react: async (emoji) => reacted.push(emoji) }), true);
    assert.deepEqual(sessions.map((session) => session.active), [false, false]);
    assert.deepEqual(reacted, ['✅', '✅']);
    assert.equal(await handlePlayingDiscordCommand(client, { id: 'command-stop', content: 'stop', author: { id: 'owner-1' }, channel, react: async (emoji) => reacted.push(emoji) }), false);
    assert.deepEqual(reacted, ['✅', '✅']);
    sessions.forEach((session) => clearTimeout(session.timer));
  } finally {
    sessions.forEach((session) => playingSessions.delete(session.account));
    for (const [account, session] of saved) playingSessions.set(account, session);
  }
});
