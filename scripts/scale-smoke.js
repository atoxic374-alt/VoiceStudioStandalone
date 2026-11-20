const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const {
  clients,
  buildVoiceGuildCatalog,
  buildPlayingChannelCatalog,
  invalidateVoiceGuildCatalog,
} = require('../server');

const ACCOUNT_COUNTS = [10, 25, 50, 100];
const GUILD_COUNT = 3;
const VOICE_CHANNELS_PER_GUILD = 12;
const TEXT_CHANNELS_PER_GUILD = 8;
const SCALE_PREFIX = '__scale_smoke_';

function makeCacheClient(accountIndex) {
  const guilds = new Map();
  for (let guildIndex = 0; guildIndex < GUILD_COUNT; guildIndex += 1) {
    const guildId = `scale-guild-${guildIndex}`;
    const channels = new Map();
    for (let channelIndex = 0; channelIndex < VOICE_CHANNELS_PER_GUILD; channelIndex += 1) {
      const id = `scale-voice-${guildIndex}-${channelIndex}`;
      channels.set(id, {
        id,
        type: 2,
        name: `Voice ${channelIndex}`,
        bitrate: 64000,
        userLimit: 0,
        members: { size: channelIndex % 5 },
        permissionsFor: () => ({ has: () => true }),
      });
    }
    for (let channelIndex = 0; channelIndex < TEXT_CHANNELS_PER_GUILD; channelIndex += 1) {
      const id = `scale-text-${guildIndex}-${channelIndex}`;
      channels.set(id, {
        id,
        type: 0,
        name: `text-${channelIndex}`,
        isText: () => true,
        permissionsFor: () => ({ has: () => true }),
      });
    }
    guilds.set(guildId, {
      id: guildId,
      name: `Scale Guild ${guildIndex}`,
      iconURL: () => null,
      members: { me: { id: `scale-user-${accountIndex}` }, cache: new Map() },
      channels: { cache: channels },
      voiceStates: { cache: new Map() },
    });
  }
  return { user: { id: `scale-user-${accountIndex}` }, guilds: { cache: guilds } };
}

function clearScaleClients() {
  for (const name of [...clients.keys()]) if (name.startsWith(SCALE_PREFIX)) clients.delete(name);
  invalidateVoiceGuildCatalog();
}

function warmUp() {
  clients.set(`${SCALE_PREFIX}warmup`, { client: makeCacheClient('warmup') });
  buildVoiceGuildCatalog();
  buildPlayingChannelCatalog('scale-guild-0');
  buildPlayingChannelCatalog('');
  clearScaleClients();
  global.gc?.();
}

warmUp();
const results = [];
for (const accountCount of ACCOUNT_COUNTS) {
  clearScaleClients();
  global.gc?.();
  const names = [];
  for (let index = 0; index < accountCount; index += 1) {
    const name = `${SCALE_PREFIX}${accountCount}_${index}`;
    names.push(name);
    clients.set(name, { client: makeCacheClient(index) });
  }

  const startedAt = performance.now();
  const voiceGuilds = buildVoiceGuildCatalog();
  const selectedGuild = buildPlayingChannelCatalog('scale-guild-0');
  const guildOptions = buildPlayingChannelCatalog('');
  const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
  global.gc?.();
  const processMemory = process.memoryUsage();
  const expectedVoiceGroups = accountCount * GUILD_COUNT;
  const expectedUniqueVoiceChannels = VOICE_CHANNELS_PER_GUILD;

  assert.equal(voiceGuilds.length, expectedVoiceGroups);
  assert.equal(voiceGuilds.reduce((sum, guild) => sum + guild.voiceChannels.length, 0), accountCount * GUILD_COUNT * VOICE_CHANNELS_PER_GUILD);
  assert.equal(selectedGuild.channels.length, TEXT_CHANNELS_PER_GUILD);
  assert.equal(selectedGuild.channels[0].accounts.length, accountCount);
  assert.equal(guildOptions.channels.length, 0, 'guild-list requests do not serialize all text-channel records');
  assert.equal(guildOptions.guilds.length, GUILD_COUNT);

  results.push({
    accounts: accountCount,
    voiceGuildGroups: voiceGuilds.length,
    uniqueVoiceChannelsPerGuild: expectedUniqueVoiceChannels,
    uniqueTextChannelsInSelectedGuild: selectedGuild.channels.length,
    accountsPerSharedTextChannel: selectedGuild.channels[0].accounts.length,
    guildListChannelRecords: guildOptions.channels.length,
    catalogBuildMilliseconds: elapsedMs,
    voiceCatalogJsonBytes: Buffer.byteLength(JSON.stringify(voiceGuilds)),
    selectedPlayingCatalogJsonBytes: Buffer.byteLength(JSON.stringify(selectedGuild)),
    guildListJsonBytes: Buffer.byteLength(JSON.stringify(guildOptions)),
    processHeapUsedBytesSnapshot: processMemory.heapUsed,
    processRssBytesSnapshot: processMemory.rss,
  });

  for (const name of names) clients.delete(name);
  invalidateVoiceGuildCatalog();
}

console.log(JSON.stringify({
  mode: 'synthetic-cache-only; no Discord login or network calls',
  caveat: 'Fake cached client objects only. Build time, JSON output sizes, and process-level memory snapshots do not measure Discord.js clients, Gateway/WebSocket memory, media transport, network behavior, or sustained 100-account operation; memory snapshots are process-wide and noisy.',
  guildsPerAccount: GUILD_COUNT,
  voiceChannelsPerGuild: VOICE_CHANNELS_PER_GUILD,
  textChannelsPerGuild: TEXT_CHANNELS_PER_GUILD,
  results,
}, null, 2));
