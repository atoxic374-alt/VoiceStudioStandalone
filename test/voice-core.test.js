const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { sendVoiceOp, sendVoiceOpConfirmed, rotations, rotationControlledAccounts, taskConflict, beginAccountOperation, operationIsCurrent, endAccountOperation } = require('../server');

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
