# تقرير إصلاح مشكلة كائن Streamer

## النتيجة

المشكلة الأساسية ليست انقطاع اتصال عام ولا خطأ في اختيار السيرفر أو الروم. السجل يثبت أن التحقق من الروم نجح وأن الـGateway كان في حالة جاهزة، لكنه يثبت أيضًا أن مصافحة الاتصال المخصصة للوسائط لم تكتمل: لم يصل `VOICE_STATE_UPDATE` و`VOICE_SERVER_UPDATE` المطابقان إلى كائن `Streamer`، ولذلك بقيت الجلسة بلا `session_id` وبلا `token` ولم يبدأ WebSocket الصوت.

السبب الجذري في التطبيق هو أن الانضمام العادي كان يرسل Opcode 4 يدويًا عبر الـGateway فقط، من دون إنشاء الاتصال القانوني داخل `client.voice.connection`. بعد ذلك كان التطبيق ينشئ `Streamer` ثانيًا للحساب نفسه ويرسل منه مصافحة صوت أخرى إلى نفس هوية الـGateway. هذا يخلق مصافحتين متنافستين. Discord قد يرسل تحديث الحالة إلى مسار، وتحديث خادم الصوت إلى المسار الآخر، فتظهر النتيجة التي في السجل: `hasSession=false`, `hasVoiceToken=false`, و`voiceSocketStarted=false`.

## الأدلة

| الدليل | الاستنتاج |
| --- | --- |
| `targetValidation.ok=true` | السيرفر والروم صحيحان وقابلان للوصول من ناحية البيانات المحلية. |
| `gatewayReady=true` | المشكلة ليست أن جلسة الـGateway غير جاهزة. |
| `voiceConnectionCreated=true` مع غياب الجلسة والتوكن | تم إنشاء كائن النقل، لكن مصافحة أحداث Discord لم تكتمل. |
| `voiceEventGuildMismatch` و`voiceEventChannelMismatch` بأعداد كبيرة | عدة مستمعين/نواقل على نفس الـGateway كانت ترى أحداث حسابات أو عمليات أخرى، ثم تُرشّحها محليًا. |
| `voiceSocketStarted=false` | الفشل وقع قبل فتح WebSocket الصوت، وليس في WebRTC أو FFmpeg. |

## الإصلاحات المنفذة

أصبح `client.voice.joinChannel()` هو المسار الأساسي للانضمام والنقل عندما تكون قناة الصوت متاحة. هذه الدالة تنشئ اتصال `VoiceConnection` الأساسي، وترسل طلب الانضمام، وتنتظر المصافحة الكاملة، وتحفظ الاتصال في `client.voice.connection`. بعد ذلك يستخدم مسار الوسائط اتصال الصوت الأساسي و`createStreamConnection()` بدل إنشاء `Streamer` مستقل متنافس متى كان ذلك ممكنًا.

لم يعد التطبيق يعتبر جلسة محفوظة في `voice-sessions.json` اتصالًا حيًا إذا لم يوجد اتصال أساسي فعلي يطابق القناة. هذا يمنع تجاوز `joinChannel()` بعد إعادة تشغيل الخادم أو فقدان كائن الاتصال في الذاكرة.

أزيلت إعادة إرسال OP4 قبل مصافحة `Streamer`، لأنها كانت تعيد تشغيل مصافحة ثانية مباشرة قبل `joinVoice()` وتزيد احتمال فقدان `VOICE_SERVER_UPDATE`.

بقي تنظيف ناقل الوسائط منفصلًا عن مغادرة الروم. الفشل أو انتهاء البث يوقف الوسيط فقط، بينما مغادرة الروم لا تحدث إلا في العمليات الصريحة مثل الخروج اليدوي أو تغيير الحساب/القناة.

## التحقق

تم تشغيل فحص الصياغة والاختبارات بعد التعديل:

```text
npm run check   passed
npm test        25 passed, 0 failed
 git diff --check passed
```

لا يمكن إجراء اختبار Discord/WebRTC حي من دون حساب مصرح به وروم فعلي. لذلك يثبت الاختبار المحلي صحة المسار البرمجي، لكنه لا يستبدل اختبار تشغيل حي بعد النشر.

## ملاحظة عن المكتبات

توثيق Discord يوضح أن الاتصال الصوتي يتطلب انتظار حدثي `VOICE_STATE_UPDATE` و`VOICE_SERVER_UPDATE` معًا، وأن `VOICE_SERVER_UPDATE` يحمل `token` و`endpoint`. كما يذكر أن تغيير القناة قد يعيد استخدام نفس `endpoint` لكن لا يجوز إعادة استخدام الجلسة أو التوكن السابقين.[1]

مكتبة `discord.js-selfbot-v13` المستخدمة في المشروع مؤرشفة وغير مدعومة بحسب مستودعها، وتحذر من أن استخدام حسابات المستخدمين آليًا يخالف شروط Discord وقد يؤدي إلى حظر الحساب.[2] كما أن `@dank074/discord-video-stream` مكتبة تجريبية، وإصدار المشروع الحالي يمر عبر اعتماديات تظهر لها أربع ثغرات عالية في `npm audit`. لم أقم بترقية أو تخفيض الإصدار قسرًا، لأن ذلك تغيير رئيسي قد يكسر واجهة `Streamer`، ويجب أن يتم في فرع منفصل مع اختبار حي للوسائط.

## التوصية التشغيلية

بعد نشر الإصلاح، يجب اختبار حساب واحد أولًا: دخول روم، تشغيل Stream، الانتظار، إيقاف Stream، ثم تغيير الروم. ينبغي التأكد من أن `data/media-events.log` يسجل `media.primary_transport_selected` و`media.ready`، وألا يظهر `voice-socket-not-started`. إذا ظهر الفشل فقط عند استخدام المسار الاحتياطي، فالخيار الآمن هو تعطيل Go Live التجريبي بدل إعادة إنشاء مصافحات `Streamer` متنافسة.

## References

[1]: https://docs.discord.com/developers/topics/voice-connections "Discord Voice Connections documentation"
[2]: https://github.com/aiko-chan-ai/discord.js-selfbot-v13 "discord.js-selfbot-v13 repository and archival warning"
[3]: https://github.com/dank074/Discord-video-stream "discord-video-stream source repository"
