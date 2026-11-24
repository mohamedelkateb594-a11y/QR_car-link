# DEVELOPER_HANDOFF — QR Car Contact

- **آخر تحديث:** 2026-11-24
- **المرحلة المنفذة:** Phase 2 من 7 — **جزئيًا**: طبقة الخدمات مكتملة ومختبرة، أما ربط Firebase الفعلي فمكتوب وغير مشغّل (راجع `docs/EXECUTION_PLAN.md`)
- **مكان الكود:** هذا الريبو (`QR_car-link`، فرع `main`). لا تعتمد على أي نسخة zip؛ الريبو هو المرجع.
- **المرجع الأساسي للمتطلبات:** `QR_Car_Contact_Spec.md` (أي تغيير في السلوك الأساسي يحتاج موافقة صاحب المنتج)

## تحديث Phase 2 (2026-11-24)

**ما تم:**
- `functions/src/services/requestService.js`: إنشاء الطلب، التنبيه، الرسائل، markViewed، الإغلاق بزرّي «في الطريق/تم التحريك»، الإلغاء، الانتهاء، وsweep. الإغلاق يتم بعملية atomic (تغيير الحالة + الرسالة الختامية معًا).
- `functions/src/services/carService.js`: إنشاء سيارة + QR، وإبطال QR وإصدار جديد.
- منافذ (ports) قابلة للحقن: `store`, `push`, `scheduler`, `clock` — لذلك المنطق مختبر بدون Firebase.
- **مكتوب لكن لم يُشغَّل إطلاقًا:** `functions/src/adapters/firestoreStore.js`, `functions/src/adapters/fcmPush.js`, و`functions/index.js` (callables + Cloud Tasks + sweep كل دقيقة).

**اختبارات (47 ناجح / 0 فاشل، Node v22):** 25 اختبارًا جديدًا على الخدمات بمخازن وهمية في الذاكرة: إنشاء الطلب ووصوله للمالك الصحيح، رفض token غير صالح أو مُبطَل أو سيارة موقوفة، عدم تكرار الطلب المفتوح، حدود المعدل (لكل زائر/سيارة/IP)، الشات من الطرفين، منع الغرباء، الإغلاق ومنع الرسائل بعده، الإلغاء، الانتهاء من الخادم، الـ sweep، وتوقف التنبيهات بعد view/close/cancel/expiry. جرّبت 5 تعديلات تخريبية (mutations) على الخدمة وكل واحد منها أسقط اختبارًا واحدًا على الأقل، أي أن الاختبارات تكشف الانحدار.

**ما لم يتحقق (لا تعتبره منجزًا):**
- لا `firebase-admin` ولا `firebase-functions` مثبتان (`npm install` فشل: لا شبكة). **لم أضفهما إلى `package.json`** ولم أختر إصدارات. فحصت صياغة الملفات بـ `node --check` فقط؛ أسماء الواجهات (`sendEachForMulticast`, `getFunctions().taskQueue().enqueue`, `onTaskDispatched`…) من معرفتي بالـ API **ولم تُجرَّب**.
- قواعد Firestore والـ indexes الجديدة والـ transaction والـ Cloud Tasks والـ FCM: **صفر اختبار فعلي**.
- التزامن الحقيقي (إغلاق ورسالة في اللحظة نفسها): المخزن الوهمي متزامن، فلا يثبت سلوك Firestore transaction.
- الدفع للريبو تم عبر GitHub API من بيئة لا تشغّل CI، ولم تُشغَّل الاختبارات على نسخة مستنسخة من الريبو؛ الـ 47 اختبارًا شُغّلت على نسخة محلية مطابقة للملفات المدفوعة.

**تغييرات على قرارات Phase 1:**
- **عُكست قاعدة «تخزين الـ hash بدل الـ token»**: صار الـ token الأصلي مخزنًا أيضًا في مستند السيارة (`qrToken`) كي يستطيع التطبيق إعادة عرض/طباعة الـ QR. البحث ما زال عبر `qrTokens/{sha256}`. السبب: الـ token مطبوع على الزجاج أصلًا فلا يُعتبر سرًّا، ووظيفته منع التخمين. **يلزم اعتماد صاحب المشروع (D7).**
- أضيفت مجموعة `rateEvents` (للخادم فقط) لعدّ الطلبات، حتى لا يظهر hash الـ IP لأي طرف. وأضيف الحقل `open` على الطلب لاستعلام الـ sweep، والأزمنة كلها أرقام ms.
- **K1 (ownerUid يقرأه الزائر) ما زال مفتوحًا.**
- **K2 مخفَّف جزئيًا:** صار هناك حد على IP مملّح (يتطلب ضبط `IP_HASH_SALT`) وحد لكل سيارة، لكنه غير مختبَر على Firebase.

**قيم بيئة مطلوبة قبل النشر:** `QR_BASE_URL` (الدومين النهائي — D5) و`IP_HASH_SALT`. اسم قناة الإشعار الحالي `request_alerts` يجب أن يطابقه تطبيق Android في Phase 6.

## 1. ملخص التنفيذ (Phase 1)

**ما تم:** مراجعة المواصفات، كتابة خطة تنفيذ من 7 مراحل، وبناء نواة منطق الـ Backend + قواعد Firestore + إعدادات Firebase.

**الخصائص التي تعمل فعلًا (منطق فقط، مختبر بوحدات):**
- آلة حالات الطلب وصلاحيات كل طرف في الانتقال بينها، ومنع أي إعادة فتح بعد الإغلاق، ومنع الرسائل بعد الإغلاق.
- توليد token عشوائي 192-bit، التحقق من شكله، وبناء رابط QR (والبحث عنه عبر hash).
- التحقق من مدخلات الزائر (السبب والرسالة) وتنظيف النص (محارف التحكم ومحارف bidi-override).
- حساب الانتهاء (15 دقيقة افتراضيًا، قابلة للتعديل) وحاسب rate-limit.
- جدول التنبيهات (0/30/60/90 ث وبدائله) وقرار "هل يُرسل التنبيه الآن؟".

**لا توجد حتى الآن أي خاصية تظهر للمستخدم النهائي** (لا صفحة ويب، لا تطبيق، ولا Cloud Functions منشورة).

## 2. حالة المشروع

**يعمل ومختبر (منطق فقط):** `functions/src/core/*` و`functions/src/services/*` (47 اختبارًا ناجحًا).

**مكتوب وغير مشغّل:** `functions/index.js`، `functions/src/adapters/*`، `firestore.rules`، `firestore.indexes.json`، `firebase.json`.

**غير مكتمل (لم يبدأ):** صفحة الويب، تطبيق Android، الإشعارات على الجهاز، الـ retention، الـ App Check.

**مشاكل ومخاطر معروفة:**
- **K0:** `firestore.rules` و`firestore.indexes.json` و`firebase.json` **لم تُختبر ولم تُنشر**. تحققت فقط أن ملفات JSON سليمة الصياغة. لا يوجد Emulator ولا شبكة في بيئة العمل.
- **K1:** مستند `requests` يحتوي `ownerUid` و`carId` ويقرأه الزائر. هذه معرّفات Firebase معتمة بلا بيانات شخصية، لكنها تكشف معرّف المالك للزائر. حلّان: قبولها، أو مستند مرآة للزائر (`sessions/{id}`) فيه الحالة والرسائل فقط. **القرار مؤجل.**
- **K2:** rate-limit لكل زائر مبني على uid المجهول، ويمكن تجاوزه بمسح بيانات المتصفح. الحماية الفعلية تحتاج حدًّا لكل سيارة + hash للـ IP (موجودان كمنطق) + App Check (المرحلة 7).
- **K3:** `engines.node = 20` في `package.json` لكن الاختبارات شُغّلت على Node v22 فقط.
- **K4:** لا يوجد `.firebaserc` — لم يُربط أي مشروع Firebase.
- **K5:** يوجد ملف `qr-car-contact.zip` في جذر الريبو، وهو نسخة قديمة (Phase 1) ومكررة. يُنصح بحذفه حتى لا يُستخدم بالخطأ.

## 3. التغييرات التقنية

**Phase 1 — ملفات أُنشئت:**
- `functions/src/core/states.js` — الحالات والانتقالات
- `functions/src/core/token.js` — token وhash ورابط QR
- `functions/src/core/policy.js` — التحقق، التنظيف، الانتهاء، rate-limit، الإعدادات الافتراضية
- `functions/src/core/escalation.js` — جدول التنبيهات وقرار الإرسال
- `functions/test/{states,token,policy,escalation}.test.js`
- `functions/package.json`، `firestore.rules`، `firebase.json`، `web/.gitkeep`، `docs/EXECUTION_PLAN.md`، `DEVELOPER_HANDOFF.md`

**Phase 2 — ملفات أُنشئت أو عُدّلت:**
- جديد: `functions/src/errors.js`، `functions/src/services/{carService,requestService}.js`، `functions/src/adapters/{firestoreStore,fcmPush}.js`
- جديد: `functions/test/{carService,requestService}.test.js`، `functions/test/helpers/{fakes,world}.js`
- معدّل: `functions/index.js` (كان stub فارغًا)، `firestore.indexes.json` (فهارس `open`+`expiresAtMs` و`rateEvents`)، هذا الملف، `docs/EXECUTION_PLAN.md`

**Dependencies:** لم تُضف أي مكتبة. `firebase-admin` و`firebase-functions` مطلوبتان لتشغيل `index.js` ولم تُثبَّتا ولم أختر لهما إصدارات.

**Firebase / قاعدة البيانات:** القواعد والـ indexes مكتوبة ومحلية فقط. لا Cloud Functions منشورة. ترويسات الاستضافة (`Referrer-Policy: no-referrer`، `Cache-Control: no-store`، …) و rewrite لـ `/c/**` معرّفة في `firebase.json`.

## 4. الاختبارات

| الاختبار | النتيجة |
|---|---|
| `cd functions && npm test` (`node --test`) على Node v22.23.5 | **47 ناجح، 0 فاشل** |
| صياغة JS لـ `index.js` والـ adapters (`node --check`) | سليمة (لا تعني أنها تعمل) |
| صياغة JSON لـ `firebase.json` و`firestore.indexes.json` | سليمة |
| Build | **لا ينطبق** — لا يوجد مشروع Android ولا ويب بعد |

**لم يُختبر بعد:** قواعد Firestore (كل الحالات)، صلاحية `firebase.json` بالـ CLI، الـ indexes، الـ adapters، `index.js`، أي تكامل مع Firebase، Node 20، انقطاع الإنترنت، التزامن الحقيقي، الإغلاق/الإلغاء/الانتهاء من البداية للنهاية على Firebase.

> اختبارات الوحدة تثبت منطق الوحدات فقط، ولا تثبت أن أي سيناريو من معايير القبول الـ 12 يعمل على النظام الحقيقي.

## 5. المهام المتبقية (بالأولوية)

1. **حسم القرارات المفتوحة D1–D8** في `docs/EXECUTION_PLAN.md` (D4 وD5 يحجبان النشر، وD3 يحجب تصميم التسجيل).
2. **إكمال Phase 2 (الأولوية القصوى):** `cd functions && npm install firebase-admin firebase-functions`، ثم تشغيل Emulator واختبار `firestoreStore` و`fcmPush` و`index.js` وقواعد Firestore (بـ `@firebase/rules-unit-testing`) فعليًا، وإصلاح ما يظهر.
3. حسم K1 (مستند مرآة للزائر أم لا) قبل كتابة قواعد القراءة النهائية.
4. حذف `qr-car-contact.zip` من الجذر (K5).
5. Phase 3 → 7 حسب الخطة.

## 6. تعليمات المطور التالي

- **ابدأ من:** إكمال Phase 2 (اختبار الـ adapters والـ index.js على Emulator). اقرأ أولًا `QR_Car_Contact_Spec.md` (خصوصًا الأقسام 6، 7، 8، 14) ثم `docs/EXECUTION_PLAN.md`.
- **راجع:** `functions/src/services/*.js` و`functions/src/core/*.js` (استخدمها كما هي)، `firestore.rules`.
- **الخطوة التالية المقترحة:** تثبيت الاعتماديات، تشغيل `firebase emulators:start`، كتابة اختبار تكامل لـ `createRequest → markViewed → closeRequest` عبر الـ callables، ثم اختبار القواعد (زائر لا يقرأ طلب غيره، لا كتابة مباشرة من العميل، لا رسائل بعد الإغلاق).
- **لا تغيّر ولا تعد تنفيذ:** منطق `core/` و`services/` (مختبران بـ 47 اختبارًا؛ شغّل `npm test` بعد أي تعديل)، قرار Firestore، قاعدة "كل الكتابة الحساسة عبر Functions". لا تعِد كتابة الخدمات: اكتب/أصلح الـ adapters فقط.
- **ممنوع حسب المواصفات:** أي مكالمات هاتفية، مشاركة الموقع، إعادة فتح جلسة مغلقة، أو وضع رقم هاتف/بيانات شخصية في QR أو صفحة الزائر.
- **تذكير:** وصول الـ push ليس دليلًا أن المالك شاهده. الحالة `viewed` تُسجَّل فقط عند فتح المالك للطلب فعليًا.

## سجل المراحل

| المرحلة | التاريخ | الحالة |
|---|---|---|
| 1 — نواة الـ Backend | 2026-11-24 | منفذة (القواعد غير مختبرة) |
| 2 — الخدمات + Functions | 2026-11-24 | الخدمات مكتملة ومختبرة (47 اختبارًا)؛ adapters و`index.js` والقواعد **غير مشغّلة** |
| 3 → 7 | — | لم تبدأ |
