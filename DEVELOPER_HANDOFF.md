# DEVELOPER_HANDOFF — QR Car Contact

- **آخر تحديث:** 2026-11-24
- **المرحلة المنفذة:** Phase 1 من 7 (نواة الـ Backend) — راجع `docs/EXECUTION_PLAN.md`
- **المرجع الأساسي للمتطلبات:** `QR_Car_Contact_Spec.md` (أي تغيير في السلوك الأساسي يحتاج موافقة صاحب المنتج)

## 1. ملخص التنفيذ

**ما تم:** مراجعة المواصفات، كتابة خطة تنفيذ من 7 مراحل، وبناء نواة منطق الـ Backend + قواعد Firestore + إعدادات Firebase.

**الخصائص التي تعمل فعلًا (منطق فقط، مختبر بوحدات):**
- آلة حالات الطلب وصلاحيات كل طرف في الانتقال بينها، ومنع أي إعادة فتح بعد الإغلاق، ومنع الرسائل بعد الإغلاق.
- توليد token عشوائي 192-bit، التحقق من شكله، تخزينه كـ hash، وبناء رابط QR.
- التحقق من مدخلات الزائر (السبب والرسالة) وتنظيف النص (محارف التحكم ومحارف bidi-override).
- حساب الانتهاء (15 دقيقة افتراضيًا، قابلة للتعديل) وحاسب rate-limit.
- جدول التنبيهات (0/30/60/90 ث وبدائله) وقرار "هل يُرسل التنبيه الآن؟".

**لا توجد حتى الآن أي خاصية تظهر للمستخدم النهائي** (لا صفحة ويب، لا تطبيق، لا Cloud Functions فعلية).

**ملفات أُنشئت (كلها جديدة، لم يُعدّل أي ملف قائم):** انظر القسم 3.

## 2. حالة المشروع

**يعمل ومختبر:** الوحدات الأربع في `functions/src/core/` (22 اختبار ناجح).

**غير مكتمل (لم يبدأ):**
- ربط Cloud Functions (`functions/index.js` فارغ عمدًا).
- صفحة الويب، تطبيق Android، الإشعارات، الـ retention، الـ App Check.

**مشاكل ومخاطر معروفة:**
- **K0:** `firestore.rules` و`firestore.indexes.json` و`firebase.json` **لم تُختبر ولم تُنشر**. تحققت فقط أن ملفات JSON سليمة الصياغة. لا يوجد Emulator ولا شبكة في بيئة العمل.
- **K1:** مستند `requests` يحتوي `ownerUid` و`carId` ويقرأه الزائر. هذه معرّفات Firebase معتمة بلا بيانات شخصية، لكنها تكشف معرّف المالك للزائر. حلّان: قبولها، أو مستند مرآة للزائر (`sessions/{id}`) فيه الحالة والرسائل فقط. **القرار مؤجل للمرحلة 2.**
- **K2:** rate-limit لكل زائر مبني على uid المجهول، ويمكن تجاوزه بمسح بيانات المتصفح. الحماية الفعلية تحتاج حدًّا لكل سيارة (موجود كمنطق) + hash للـ IP + App Check (المرحلة 7).
- **K3:** `engines.node = 20` في `package.json` لكن الاختبارات شُغّلت على Node v22 فقط.
- **K4:** لا يوجد `.firebaserc` — لم يُربط أي مشروع Firebase.

## 3. التغييرات التقنية

**ملفات أُنشئت:**
- `functions/src/core/states.js` — الحالات والانتقالات
- `functions/src/core/token.js` — token وhash ورابط QR
- `functions/src/core/policy.js` — التحقق، التنظيف، الانتهاء، rate-limit، الإعدادات الافتراضية
- `functions/src/core/escalation.js` — جدول التنبيهات وقرار الإرسال
- `functions/test/{states,token,policy,escalation}.test.js`
- `functions/index.js` (stub فارغ)، `functions/package.json`
- `firestore.rules`، `firestore.indexes.json`، `firebase.json`
- `web/.gitkeep`، `docs/EXECUTION_PLAN.md`، `DEVELOPER_HANDOFF.md`

**Dependencies:** لم تُضف أي مكتبة (النواة تستخدم `node:crypto` و`node:test` فقط). المرحلة 2 ستضيف `firebase-admin` و`firebase-functions` — **لم أختر لهما إصدارات.**

**Firebase / قاعدة البيانات:** القواعد والـ indexes مكتوبة ومحلية فقط. لا Cloud Functions منشورة. ترويسات الاستضافة (`Referrer-Policy: no-referrer`، `Cache-Control: no-store`، …) و rewrite لـ `/c/**` معرّفة في `firebase.json`.

## 4. الاختبارات

| الاختبار | النتيجة |
|---|---|
| `cd functions && npm test` (`node --test`) على Node v22.23.5 | **22 ناجح، 0 فاشل** |
| صياغة JSON لـ `firebase.json` و`firestore.indexes.json` | سليمة |
| Build | **لا ينطبق** — لا يوجد مشروع Android ولا ويب بعد |

**لم يُختبر بعد:** قواعد Firestore (كل الحالات)، صلاحية `firebase.json` بالـ CLI، الـ indexes، أي تكامل مع Firebase، Node 20، انقطاع الإنترنت، تكرار الطلب، الإغلاق/الإلغاء/الانتهاء من البداية للنهاية.

> اختبارات الوحدة تثبت منطق الوحدات فقط، ولا تثبت أن أي سيناريو من معايير القبول الـ 12 يعمل.

## 5. المهام المتبقية (بالأولوية)

1. **حسم القرارات المفتوحة D1–D6** في `docs/EXECUTION_PLAN.md` (D4 وD5 يحجبان النشر، وD3 يحجب تصميم التسجيل).
2. **Phase 2:** تثبيت الاعتماديات، كتابة الـ callables والـ Tasks والـ sweep، واختبار القواعد والـ Functions على Firebase Emulator.
3. حسم K1 (مستند مرآة للزائر أم لا) قبل كتابة قواعد القراءة النهائية.
4. Phase 3 → 7 حسب الخطة.

## 6. تعليمات المطور التالي

- **ابدأ من:** Phase 2. اقرأ أولًا `QR_Car_Contact_Spec.md` (خصوصًا الأقسام 6، 7، 8، 14) ثم `docs/EXECUTION_PLAN.md`.
- **راجع:** `functions/src/core/*.js` (استخدمها داخل الـ Functions بدل إعادة كتابة المنطق)، `firestore.rules`.
- **الخطوة التالية المقترحة:** `npm install firebase-admin firebase-functions` داخل `functions/`، ثم كتابة `createRequest` أولًا (التحقق من token → rate-limit → إنشاء الطلب + `expiresAt` → جدولة الـ Tasks → FCM) مع اختبارها على الـ Emulator، ثم اختبار القواعد بـ `@firebase/rules-unit-testing`.
- **لا تغيّر ولا تعد تنفيذ:** منطق `core/` (مختبر)، قرار Firestore، قاعدة "كل الكتابة الحساسة عبر Functions"، تخزين الـ hash بدل الـ token.
- **ممنوع حسب المواصفات:** أي مكالمات هاتفية، مشاركة الموقع، إعادة فتح جلسة مغلقة، أو وضع رقم هاتف/بيانات شخصية في QR أو صفحة الزائر.
- **تذكير:** وصول الـ push ليس دليلًا أن المالك شاهده. الحالة `viewed` تُسجَّل فقط عند فتح المالك للطلب فعليًا.

## سجل المراحل

| المرحلة | التاريخ | الحالة |
|---|---|---|
| 1 — نواة الـ Backend | 2026-11-24 | منفذة (القواعد غير مختبرة) |
| 2 → 7 | — | لم تبدأ |
