# Voice Studio Standalone

Voice Studio is a single-purpose dashboard extracted from the original Discord Account Manager. It focuses on one personal workflow: connect a Discord account, choose a voice channel, control the voice state, and preview a camera or screen source locally before changing the corresponding Discord gateway state.

## What changed

The extracted app has its own Express server, browser UI, encrypted persistent account store, persisted voice-session metadata, and focused test suite. The interface was rebuilt as a personal control room with a glass-card layout, subtle animated signal bars, animated media stage, responsive mobile layout, dark/light theme support, and Arabic/English direction switching. The browser media flow now uses the real `getUserMedia` and `getDisplayMedia` APIs, binds the stream to a muted inline video preview, handles the browser's native track-ended event, and always stops tracks during source changes and page unload.

The gateway confirmation path was also hardened. The timer is created before any early failure can call cleanup, so a missing shard or a non-ready gateway returns immediately instead of leaving a request stuck. State changes are validated so a deafened account cannot be marked as broadcasting video or screen share.

## Run locally

```bash
npm install
npm start
```

Open [http://localhost:5050](http://localhost:5050). Connected Discord tokens are stored encrypted in `data/accounts.enc` and saved accounts are restored after restart; voice sessions, automation tasks, and Playing sessions are persisted in their corresponding JSON files. The loader accepts canonical and uploader-renamed files (for example `accounts.enc(1).txt` or `voice-sessions (1).json`) and merges valid copies instead of silently reading just the first file. A portable backup should include `accounts.enc`, `voice-sessions.json`, `automation-tasks.json`, `playing-sessions.json`, and the same `DATA_ENCRYPTION_KEY` configured on the source host. Keep the key in the host's secret-variable store; without it the encrypted account file cannot be decrypted. Never replace `accounts.enc` with a plaintext token JSON. There is no account-count restore limit: 50 or more saved accounts are processed through a small concurrency window of 2, so they do not all open Gateway sessions at the same instant. Each token is checked through Discord REST before a Gateway session is opened, so revoked tokens fail cheaply; failed Gateway clients are destroyed immediately. After account restoration, saved automation and Playing settings are restored for the matching account names. Set `ACCOUNT_RESTORE_CONCURRENCY` and `ACCOUNT_CONNECT_CONCURRENCY` explicitly in Railway when the instance has measured memory headroom. Set `DATA_ENCRYPTION_KEY` to a stable random value in production; the loader also tries the current `APP_PASSWORD` and the local-development fallback so an older export can be migrated when its original key is still available. Set `DATA_DIR` only when the Railway Volume is mounted at `/app/data` or another custom path. Use HTTPS or `localhost` when deploying the browser UI so browser media permissions are available.

At every process start and account change, the server writes two local JSON diagnostic snapshots in `data/`: `active-tokens.json` and `failed-tokens.json` retain their legacy filenames but contain account names, status, timestamps, and a sanitized error only—not tokens. In addition to the encrypted `accounts.enc`, the app now mirrors saved account names and tokens into `data/accounts.json` in readable plaintext, as explicitly requested by the owner. The JSON mirror is atomically replaced and restricted to file mode `0600`, and `data/*.json` is ignored by Git; these controls do not encrypt it. Protect the Railway Volume and backups, never upload or share `accounts.json`, and rotate all tokens immediately if it is exposed. Set a stable, random `DATA_ENCRYPTION_KEY` in production to protect the encrypted copy.

## One-file migration

On the source deployment, sign in as the owner and download `https://<source-host>/api/storage/portable-backup`. The authenticated endpoint creates one JSON backup containing only currently connected account records (still AES-256-GCM encrypted), plus their saved voice sessions and matching automation/Playing settings. On the destination, set the same `DATA_ENCRYPTION_KEY` as the source, upload the downloaded file into the mounted data directory, and restart the service. The importer accepts the timestamped filename produced by the Download button directly, or `voice-studio-portable-backup.json`. Startup validates the bundle checksum and verifies the account key before importing. Existing destination account/session/task files are moved into a hidden `.pre-portable-import-*` recovery folder, then the backup becomes the active data set so stale accounts are not merged into the migration. A marker prevents re-importing the same backup on every restart. The bundle deliberately excludes `.env`, passwords, diagnostic snapshots, and log files. A failed key check leaves the bundle and destination data unchanged.

## Test and check

```bash
npm run check
npm test
```

The tests cover the complete gateway OP4 payload, gateway confirmation, non-ready gateway errors, and the no-shard early-exit path that previously risked a hanging request.

## Account dashboard and background tasks

### Configuring the connected-account limit

The connected-account cap is controlled by the `Limit` environment variable. In Railway, open the service's **Variables** settings and add `Limit` with a positive whole number, such as `50`; redeploy or restart the service for the change to take effect. If `Limit` is unset or invalid, the app uses the default of `30`. This only changes the app's cap; increasing it also increases memory, socket, and Discord rate-limit usage, so raise it within the capacity of your Railway service.

The dashboard accepts one account at a time or a bulk list. Bulk lines may be written as `name | token` or as a token alone. The server connects with a small concurrency window rather than opening hundreds of Gateway sessions at once; a single request accepts up to 500 entries and larger collections can be submitted in additional batches. There is no technically safe literal infinity: each connected account consumes memory, sockets, Discord rate-limit budget, and operating-system resources. The UI therefore reports individual successes and failures instead of failing the whole batch.

Each connected account is shown with its avatar, display name, username, guild nickname when available, Discord user ID, presence status, current guild/channel, and current voice flags. Active sessions also show in the session list and refresh automatically.

The automation panel starts and stops channel rotation and voice-state cycling. Rotation visits only the voice channels explicitly selected by the user in the selected guild at the configured interval. State cycling applies the selected sequence of mute, deaf, video, and stream flags at the same interval. Both task types are kept in memory, exposed through status endpoints, and stopped cleanly by their task ID.

A connected account can pause or resume its own active room rotation and voice-state cycle by sending `off` or `on` in Discord, optionally with the configured `DISCORD_COMMAND_PREFIX` (for example, `!off` and `!on`). The message must be authored by that same connected account; commands heard by other connected accounts are ignored. Optionally restrict these commands with `DISCORD_COMMAND_CHANNEL_ID`. An accepted command shows a temporary `⏳` acknowledgement while it runs, followed by `✅` or `❌`. `off` preserves task membership, the current room, rotation target, state-cycle position, and state history; it pauses every active task for that account, including multiple state cycles. For room rotation it cancels that account's timer and freezes its remaining countdown, so it cannot be moved while paused. `on` resumes state cycles from their saved progress; if there is exactly one room rotation, it immediately moves the account to the next room and starts a fresh interval. If several room rotations make the destination ambiguous, `on` is rejected rather than moving the account unpredictably. An action already sent to Discord may finish before the pause takes full effect. Bare `start` and `stop` retain their existing meaning for all Playing sessions and continue to require `DISCORD_COMMAND_OWNERS`.

The same connected account can create or replace its own automatic rotation with `rot <room-id> <room-id> ...` (for example, `!rot 123456789012345678 234567890123456789`). Separate IDs with spaces, commas, semicolons, pipes, or Discord channel mentions. The command must be sent in the target server; every ID is checked against that server and must identify an accessible voice room. At least two distinct voice rooms are required. On success, the account moves into the first room, then rotates rooms every 15 minutes; its voice state changes every 10 minutes among Unmute, Mute, Camera, and Stream. State selection is randomized and avoids repeating a state until all four have been used. Reissuing `rot` first removes the account from its previous room/state automation tasks and discards empty tasks, while other accounts in shared tasks remain enrolled. Starting a new room-rotation or state-cycle task from the UI similarly replaces only that account's previous task of the same type; a paused task of the other type remains paused with its progress. `off` never deletes tasks, while `on` resumes them. Accepted `rot` commands receive the same processing acknowledgement followed by their final result reaction.

## تخصص اختيار الحسابات والسيرفر والرومات

يبدأ الاستخدام من قسم الاتصال. يمكنك إضافة حساب واحد بإدخال اسم اختياري والتوكن، أو إضافة مجموعة حسابات في مربع الاستيراد الجماعي؛ استخدم الصيغة `name | token`، أو ضع توكنًا واحدًا في كل سطر. بعد الاتصال، تظهر الحسابات في دليل البروفايلات مع الأفاتار والنيك نيم والـ ID والحالة.

في العملية الجماعية المتخصصة يبدأ التدفق بالسيرفر، ثم الروم، ثم الحسابات. قائمة السيرفرات تجمع السيرفرات التي يراها أي حساب متصل، وليست مبنية على حساب واحد فقط. بعد اختيار السيرفر والروم، يستعلم التطبيق عن كل حساب متصل ويعرضه كبطاقة **متاح** أو **مستبعد**. الحساب المستبعد يبقى ظاهرًا مع سبب واضح مثل عدم العضوية في السيرفر، عدم وجود الروم لديه، عدم امتلاك صلاحية الدخول، أو امتلاء الروم. الحسابات المتاحة فقط يمكن تحديدها للتنفيذ.

كل بطاقة حساب تعرض الأفاتار والنيك نيم والـ ID، وإذا كان داخل فويس تعرض الروم الحالي وحالته الفردية: صوت مفتوح أو مكتوم، معزول، فيديو، أو مشاركة شاشة. زر **دخول الحسابات المحددة إلى الروم** ينفذ العملية دفعة واحدة ويرجع نتيجة منفصلة لكل حساب مع ملخص النجاح والفشل. أما التنقل الدوري فيملك قائمة رومات مستقلة؛ تحدد منها رومتين أو أكثر، ويستخدم التنقل هذه الرومات فقط، مع خيار العشوائية أو التسلسل.

للمهام الدورية، انتقل إلى قسم **المهام الدورية**. في الخطوة الأولى اختر السيرفر، وفي الثانية اختر الروم المرجعي الذي تريد تنفيذ الدخول الجماعي إليه. بعد ذلك تظهر كل الحسابات المتصلة كبطاقات، مع تفعيل الحسابات القابلة للدخول وتعطيل الحسابات المستبعدة وذكر السبب. اختر الحسابات المتاحة واضغط **دخول الحسابات المحددة إلى الروم** للحصول على تقرير نجاح وفشل مستقل. وللتنقل الدوري، حدد رومتين أو أكثر من قسم رومات التنقل؛ لن تستخدم المهمة أي روم خارج هذه القائمة. فعّل التنقل العشوائي لتغيير ترتيب الرومات في كل دورة، أو اتركه مغلقًا للتنقل بالتسلسل. عند الضغط على بدء التنقل، ينقل النظام الحسابات الناجحة إلى أول روم محدد ثم يبدأ التنقل بينها حسب الفترة.

لتدوير الحالة الصوتية، استخدم نفس اختيار الحسابات والسيرفر، ثم اختر حالتين أو أكثر من قائمة الحالات، مثل كتم ثم صوت مفتوح أو فيديو ثم صوت مفتوح، وحدد الفترة بالدقائق. هذه المهمة تطبق أعلام الحالة على الجلسات الصوتية للحسابات المستهدفة، ويمكن إيقاف أي مهمة من قائمة المهام النشطة.

## Camera and screen-share behavior

The camera and screen-share buttons are functional local capture controls. They request permission, show the selected source in the preview, expose a live status and timer, and clean up when the user stops the source or the browser ends the track. In a headless environment with no camera, the app shows the browser's explicit `Requested device not found` error instead of pretending the camera is live.

The backend uses the experimental media path exposed by `discord.js-selfbot-v13`: it prepares a short synthetic H.264 source with `ffmpeg-static`, opens `createStreamConnection()`, and feeds it through `playVideo()`. This is an actual media attempt rather than a state-only flag, but it is not an officially supported Discord client and may fail when Discord changes its Go Live/WebRTC or DAVE/E2EE requirements. Failures are logged in `data/media-events.log`; the primary voice connection is preserved where the library permits it.

## Project layout

| Path | Responsibility |
| --- | --- |
| `server.js` | Standalone Express API, account connections, voice state, session persistence, rotations, and state cycles |
| `public/index.html` | Single-purpose dashboard structure |
| `public/styles.css` | Visual system, responsive layout, animation, and themes |
| `public/app.js` | UI state, API calls, media capture lifecycle, and notifications |
| `test/voice-core.test.js` | Gateway payload and failure-path tests |

## Security note

Automating Discord user accounts can violate Discord's Terms of Service and may result in account action. Use this project only with accounts and credentials you are authorized to control. Never commit a real token.


## Simple interface

The interface is intentionally organized into six English product sections: `Dashboard`, `Accounts`, `Voice`, `Automation`, `Media`, and `Activity`. Only one section is shown at a time, so connection forms, voice controls, automation settings, media preview, and logs do not compete for attention on the same screen. The breadcrumb updates with the active section.

All write operations use one consistent processing dialog. It shows the operation name, a loading state while the request is running, the selected account avatar and nickname when available, and an individual `Success` or failure message after completion. The dialog remains available until the user closes it, while background refreshes stay silent so they do not interrupt the workflow.


## Clear status controls and large account lists

Technical voice states use consistent English labels throughout the interface: `Mute`, `Unmute`, `Deafen`, `Video`, and `Stream`. The Automation state selector is a large visual panel rather than a compact multi-select, with a separate card for each state and a short explanation. The Accounts and live profile lists use bounded scrolling so a large number of connected accounts remains usable without stretching the page indefinitely.


## Railway security requirements

عند النشر على Railway يجب ضبط `NODE_ENV=production` وإنشاء `APP_PASSWORD` قوية وعشوائية داخل Railway Variables، وكذلك `DATA_ENCRYPTION_KEY` ثابتة وعشوائية. في وضع الإنتاج تعمل الواجهة بنظام مغلق افتراضيًا؛ أي طلب API بدون Cookie صالحة يعيد `401`. توكنات Discord تدخل فقط عبر واجهة HTTPS المصادق عليها، ولا يعيدها أي endpoint. تُحفظ نسخة مشفرة في `accounts.enc`، وبناءً على طلب المالك تُحفظ كذلك نسخة نصية مقروءة في `accounts.json` داخل مجلد البيانات المستبعد من Git. تعامل مع ملف JSON والنسخ الاحتياطية وRailway Volume على أنها أسرار مكشوفة لمن لديه وصول إليها؛ يجب عدم مشاركتها أو رفعها مطلقًا. يجب الإبقاء على HTTPS وعدم وضع Node خلف proxy عام يلغي المصادقة.

يطبق الخادم كذلك Security Headers، وContent Security Policy، وحدود حجم الطلب، وRate Limiting، وتحديد محاولات المصادقة، و`Cache-Control: no-store` لاستجابات API، وتنقيح رسائل الأخطاء من أنماط token وpassword وauthorization. ملفات الجلسات وملفات البث الناتجة أثناء التشغيل مستثناة من Git. إذا تعرض مشروع Railway أو جلسة المتصفح أو السجلات أو Variables، يجب تغيير `APP_PASSWORD` وتدوير جميع توكنات Discord فورًا.

قبل النشر، تحقق من وجود `APP_PASSWORD` داخل Railway Variables، ومن عدم ظهور أي توكن في Build Logs أو Deployment Logs، ومن أن `/api/health` يعيد `401` بدون Cookie المصادقة. حافظ على المستودع Private، ولا ترفع `.env` أو صادرات Railway أو مجلد `data/` أو لقطات شاشة تحتوي على توكنات أو Browser Storage منسوخ.


## Owner and client access

Set two different Railway Variables in production:

```env
APP_PASSWORD=long-random-owner-password
CLIENT_PASSWORD=different-long-random-client-password
```

`APP_PASSWORD` is the owner credential. `CLIENT_PASSWORD` is a separate client credential. The first successful client login creates a random device cookie and stores only its SHA-256 hash in `data/client-binding.json`; the raw client password and raw device value are never written to disk. Later attempts using `CLIENT_PASSWORD` from a different browser or device are rejected until `CLIENT_PASSWORD` is changed in Railway. Changing the variable changes its fingerprint and resets the binding, allowing one new client device to register. Owner access remains available independently through `APP_PASSWORD`.

Do not use the same value for both variables. Changing either password invalidates the corresponding signed access cookies. The one-device rule cannot protect a browser session after its HttpOnly cookie has been stolen; rotate `CLIENT_PASSWORD` immediately if that is suspected.

For permanent Railway data, create and mount a Railway Volume at `/app/data` (or set `DATA_DIR` to the mounted path). The application writes account exports with an atomic temporary-file rename, preserves saved records across partial reconnects and invalid-token events, and performs a final synchronous persistence pass on `SIGTERM` and `SIGINT`. After authentication, `/api/storage/status` reports the active data directory, account file, file sizes, saved-account count, and connected-account count so the deployment can be verified without inspecting tokens.
