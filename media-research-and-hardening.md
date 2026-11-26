# Media, camera, rotation, and quick-control research

## What the research established

The strongest current reference for the existing media dependency is the `Discord-RE/Discord-video-stream` codebase, while older UDP-based forks are not suitable as a direct implementation reference. Its current lifecycle treats voice signaling, WebRTC readiness, camera signaling, Go Live stream signaling, and cleanup as separate stages. A `voiceConnection` object or a resolved join promise is not sufficient proof that media is ready; the transport must reach its ready state and the requested target must still match.

The most important failure pattern in this project was not simply the 20-second timeout. `Promise.race` rejected the caller while the underlying join/readiness/polling work could continue. That allowed late callbacks, stale WebRTC checks, and transport objects from an old attempt to interfere with a newer rotation or quick-control operation.

The research also confirmed that rotation should be treated as a state machine: scheduled, applying, awaiting confirmation, confirmed, retry-wait, paused, or superseded. A timer firing is not proof of success. Per-account serialization and a process-local lock are appropriate for the current single-process deployment, but they must not be mistaken for a distributed lock if Railway is later scaled to multiple replicas.

For the UI, the safest pattern for voice/media mutations is pessimistic confirmation. The control should show pending, prevent a second mutation for the same operation, and only display success after the operation endpoint/Gateway confirmation. Local canvas or synthetic preview is not the same thing as confirmed remote media.

## Changes applied

- Replaced the unbounded WebRTC readiness polling path with a cancellable waiter that clears its timer on success, timeout, or stale-generation cancellation.
- Added timeout cleanup hooks and actively stops a failed dedicated media connection when its join deadline expires.
- Added a `runToken` to room rotation tasks. Stop, replacement, pause, and account removal now prevent an old in-flight move from writing state or scheduling work for the newer task.
- Applied the same run-token guard to restored rotation tasks after process restart.
- Added a quick-control operation generation in the browser. Stale mutation results cannot overwrite the current control state, and buttons expose `aria-busy` while awaiting confirmation.
- Changed the preview badge from `Live` to `Confirmed` after the server has confirmed the requested state; the activity text explicitly distinguishes local preview from Discord confirmation.
- Kept the current primary voice transport ownership rule. No second competing voice handshake was introduced.
- Did not upgrade `@dank074/discord-video-stream` automatically. The research found a newer upstream/npm line with changed internals and a different lifecycle; it should be pinned and tested independently before adoption.

## Verification

- `npm run check` passed.
- `npm test` passed: 103 tests.
- `npm run test:scale` passed in synthetic-cache-only mode through 100 accounts. This does not measure real Discord Gateway/WebRTC traffic.
- `git diff --check` passed.

## Important operational caveat

The public research repeatedly notes that Discord prohibits automated user accounts/self-bots and may terminate accounts. The current repository uses selfbot-oriented dependencies. The changes here harden lifecycle, cleanup, confirmation, and UI behavior; they do not bypass permissions, CAPTCHA, rate limits, or Discord policy. A compliant production migration would require an authorized bot/OAuth2 design. Discord's public APIs do not provide an equivalent, supported Node.js bot path for arbitrary user camera/video automation, so that gap should not be filled with undocumented protocol tricks.

## Sources

- [Discord-RE/Discord-video-stream](https://github.com/Discord-RE/Discord-video-stream)
- [Streamer.ts](https://raw.githubusercontent.com/dank074/Discord-video-stream/master/src/client/Streamer.ts)
- [BaseMediaConnection.ts](https://raw.githubusercontent.com/dank074/Discord-video-stream/master/src/client/voice/BaseMediaConnection.ts)
- [WebRtcWrapper.ts](https://raw.githubusercontent.com/dank074/Discord-video-stream/master/src/client/voice/WebRtcWrapper.ts)
- [Package registry](https://registry.npmjs.org/@dank074/discord-video-stream)
- [Discord Gateway events](https://docs.discord.com/developers/events/gateway-events)
- [Discord Gateway](https://docs.discord.com/developers/events/gateway)
- [Discord voice connections](https://discord.com/developers/docs/topics/voice-connections)
- [Discord automated user accounts policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots)
- [discord.js voice package](https://github.com/discordjs/discord.js/tree/main/packages/voice)
- [discord.js voice examples](https://github.com/discordjs/voice-examples)
- [MDN RTCPeerConnection connection state](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/connectionState)
- [MDN ICE connection state](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/iceConnectionState)
- [MDN AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
- [Node.js timers](https://nodejs.org/api/timers.html)
- [BullMQ job deduplication](https://docs.bullmq.io/guide/jobs/deduplication)
- [XState persistence](https://stately.ai/docs/xstate/v5/persistence)
- [TanStack optimistic updates](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates)
