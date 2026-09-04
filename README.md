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

Open [http://localhost:5050](http://localhost:5050). Connected Discord tokens are stored encrypted in `data/accounts.enc` and restored automatically after restart; voice sessions are persisted in `data/voice-sessions.json`. Set `DATA_ENCRYPTION_KEY` to a stable random value in production; otherwise `APP_PASSWORD` is used as the encryption key. Use HTTPS or `localhost` when deploying the browser UI so browser media permissions are available.

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


## Simple interface

The interface is intentionally organized into six English product sections: `Dashboard`, `Accounts`, `Voice`, `Automation`, `Media`, and `Activity`. Only one section is shown at a time, so connection forms, voice controls, automation settings, media preview, and logs do not compete for attention on the same screen. The breadcrumb updates with the active section.

All write operations use one consistent processing dialog. It shows the operation name, a loading state while the request is running, the selected account avatar and nickname when available, and an individual `Success` or failure message after completion. The dialog remains available until the user closes it, while background refreshes stay silent so they do not interrupt the workflow.


## Clear status controls and large account lists

Technical voice states use consistent English labels throughout the interface: `Mute`, `Unmute`, `Deafen`, `Video`, and `Stream`. The Automation state selector is a large visual panel rather than a compact multi-select, with a separate card for each state and a short explanation. The Accounts and live profile lists use bounded scrolling so a large number of connected accounts remains usable without stretching the page indefinitely.


## Railway security requirements

عند النشر على Railway يجب ضبط `NODE_ENV=production` وإنشاء `APP_PASSWORD` قوية وعشوائية داخل Railway Variables، وكذلك `DATA_ENCRYPTION_KEY` ثابتة وعشوائية. في وضع الإنتاج تعمل الواجهة بنظام مغلق افتراضيًا؛ أي طلب API بدون Cookie صالحة يعيد `401`. توكنات Discord تدخل فقط عبر واجهة HTTPS المصادق عليها، وتحفظ مشفرة في ملف بيانات محلي مستبعد من Git ولا يعيدها أي endpoint. يجب الإبقاء على HTTPS وعدم وضع Node خلف proxy عام يلغي المصادقة.

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
