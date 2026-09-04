# Voice Studio Standalone

Voice Studio is a single-purpose dashboard extracted from the original Discord Account Manager. It focuses on one personal workflow: connect a Discord account, choose a voice channel, control the voice state, and preview a camera or screen source locally before changing the corresponding Discord gateway state.

## What changed

The extracted app has its own Express server, browser UI, in-memory account pool, persisted voice-session metadata, and focused test suite. The interface was rebuilt as a personal control room with a glass-card layout, subtle animated signal bars, animated media stage, responsive mobile layout, dark/light theme support, and Arabic/English direction switching. The browser media flow now uses the real `getUserMedia` and `getDisplayMedia` APIs, binds the stream to a muted inline video preview, handles the browser's native track-ended event, and always stops tracks during source changes and page unload.

The gateway confirmation path was also hardened. The timer is created before any early failure can call cleanup, so a missing shard or a non-ready gateway returns immediately instead of leaving a request stuck. State changes are validated so a deafened account cannot be marked as broadcasting video or screen share.

## Run locally

```bash
npm install
npm start
```

Open [http://localhost:5050](http://localhost:5050). The app keeps the Discord token in memory only and does not write it to disk. Use HTTPS or `localhost` when deploying the browser UI so browser media permissions are available.

## Test and check

```bash
npm run check
npm test
```

The tests cover the complete gateway OP4 payload, gateway confirmation, non-ready gateway errors, and the no-shard early-exit path that previously risked a hanging request.

## Account dashboard and background tasks

The dashboard accepts one account at a time or a bulk list. Bulk lines may be written as `name | token` or as a token alone. The server connects with a small concurrency window rather than opening hundreds of Gateway sessions at once; a single request accepts up to 500 entries and larger collections can be submitted in additional batches. There is no technically safe literal infinity: each connected account consumes memory, sockets, Discord rate-limit budget, and operating-system resources. The UI therefore reports individual successes and failures instead of failing the whole batch.

Each connected account is shown with its avatar, display name, username, guild nickname when available, Discord user ID, presence status, current guild/channel, and current voice flags. Active sessions also show in the session list and refresh automatically.

The automation panel starts and stops channel rotation and voice-state cycling. Rotation visits only the voice channels explicitly selected by the user in the selected guild at the configured interval. State cycling applies the selected sequence of mute, deaf, video, and stream flags at the same interval. Both task types are kept in memory, exposed through status endpoints, and stopped cleanly by their task ID.

## تخصص اختيار الحسابات والسيرفر والرومات

يبدأ الاستخدام من قسم الاتصال. يمكنك إضافة حساب واحد بإدخال اسم اختياري والتوكن، أو إضافة مجموعة حسابات في مربع الاستيراد الجماعي؛ استخدم الصيغة `name | token`، أو ضع توكنًا واحدًا في كل سطر. بعد الاتصال، تظهر الحسابات في دليل البروفايلات مع الأفاتار والنيك نيم والـ ID والحالة.

في العملية الجماعية المتخصصة يبدأ التدفق بالسيرفر، ثم الروم، ثم الحسابات. قائمة السيرفرات تجمع السيرفرات التي يراها أي حساب متصل، وليست مبنية على حساب واحد فقط. بعد اختيار السيرفر والروم، يستعلم التطبيق عن كل حساب متصل ويعرضه كبطاقة **متاح** أو **مستبعد**. الحساب المستبعد يبقى ظاهرًا مع سبب واضح مثل عدم العضوية في السيرفر، عدم وجود الروم لديه، عدم امتلاك صلاحية الدخول، أو امتلاء الروم. الحسابات المتاحة فقط يمكن تحديدها للتنفيذ.

كل بطاقة حساب تعرض الأفاتار والنيك نيم والـ ID، وإذا كان داخل فويس تعرض الروم الحالي وحالته الفردية: صوت مفتوح أو مكتوم، معزول، فيديو، أو مشاركة شاشة. زر **دخول الحسابات المحددة إلى الروم** ينفذ العملية دفعة واحدة ويرجع نتيجة منفصلة لكل حساب مع ملخص النجاح والفشل. أما التنقل الدوري فيملك قائمة رومات مستقلة؛ تحدد منها رومتين أو أكثر، ويستخدم التنقل هذه الرومات فقط، مع خيار العشوائية أو التسلسل.

للمهام الدورية، انتقل إلى قسم **المهام الدورية**. في الخطوة الأولى اختر السيرفر، وفي الثانية اختر الروم المرجعي الذي تريد تنفيذ الدخول الجماعي إليه. بعد ذلك تظهر كل الحسابات المتصلة كبطاقات، مع تفعيل الحسابات القابلة للدخول وتعطيل الحسابات المستبعدة وذكر السبب. اختر الحسابات المتاحة واضغط **دخول الحسابات المحددة إلى الروم** للحصول على تقرير نجاح وفشل مستقل. وللتنقل الدوري، حدد رومتين أو أكثر من قسم رومات التنقل؛ لن تستخدم المهمة أي روم خارج هذه القائمة. فعّل التنقل العشوائي لتغيير ترتيب الرومات في كل دورة، أو اتركه مغلقًا للتنقل بالتسلسل. عند الضغط على بدء التنقل، ينقل النظام الحسابات الناجحة إلى أول روم محدد ثم يبدأ التنقل بينها حسب الفترة.

لتدوير الحالة الصوتية، استخدم نفس اختيار الحسابات والسيرفر، ثم اختر حالتين أو أكثر من قائمة الحالات، مثل كتم ثم صوت مفتوح أو فيديو ثم صوت مفتوح، وحدد الفترة بالدقائق. هذه المهمة تطبق أعلام الحالة على الجلسات الصوتية للحسابات المستهدفة، ويمكن إيقاف أي مهمة من قائمة المهام النشطة.

## Camera and screen-share behavior

The camera and screen-share buttons are functional local capture controls. They request permission, show the selected source in the preview, expose a live status and timer, and clean up when the user stops the source or the browser ends the track. In a headless environment with no camera, the app shows the browser's explicit `Requested device not found` error instead of pretending the camera is live.

The original backend sends Discord Gateway voice-state flags (`self_video` and `self_stream`) but does not implement Discord's RTP/WebRTC media transport. This standalone version therefore does **not** claim to publish the browser's pixels or camera frames into a Discord voice channel. It provides a reliable local preview and synchronizes the state flag when a voice session is selected. Actual Discord media publishing requires an approved Discord client/media transport rather than a self-bot gateway flag.

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
