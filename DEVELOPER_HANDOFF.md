# DEVELOPER_HANDOFF — QR Car Contact

- **آخر تحديث:** 2026-11-24
- **المرحلة المنفذة:** Phase 2 من 7 (منطق الخدمة مختبر، **ربط Firebase غير مختبر**) — راجع `docs/EXECUTION_PLAN.md`
- **المرجع الأساسي للمتطلبات:** `QR_Car_Contact_Spec.md` (غير موجود في الريبو حاليًا — يُرفع يدويًا)

## 1. ملخص التنفيذ

**الهيكل:** أُعيد رفع الملفات على البنية الصحيحة (`functions/src/core`، `functions/test`، `docs/`، `web/`) بعد أن كانت مسطحة في جذر الريبو.

**Phase 2 ما تم كتابته:**
- `functions/src/service.js` — كل قواعد العمل: `createCar`, `rotateQr`, `createRequest`, `markViewed`, `ackDelivered`, `sendMessage`, `closeRequest`, `cancelRequest`, `fireAlert`, `expireRequest`, `sweepExpired`. كل التعديلات تتم داخل transaction وتتحقق من الدور والحالة والانتهاء (انتهاء كسول لو فاتت المهمة).
- `functions/src/firestoreStore.js`، `functions/src/notifier.js` (FCM)، `functions/src/errors.js`.
- `functions/index.js` — ربط callables وـ Cloud Tasks (`alertTask`, `expireTask`) وـ `expirySweep` كل دقيقة.
- `functions/test/service.test.js` و`notifier.test.js` مع `test-support/memoryStore.js`.
- `functions/test-emulator/rules.test.js` (اختبار القواعد، `npm run test:rules`).

**تعديلات على ما كان موجودًا (بسبب خلل أو حاجة فعلية):**
- `firestore.rules`: قراءة `messages` صارت عبر `get()` للطلب الأب بدل `participants` في كل رسالة (استعلام القائمة لا يُثبت شرطًا على حقل في كل مستند فكان سيُرفض).
- `firestore.indexes.json`: استعلام قائمة المالك صار `participants array-contains` (نفس سبب القواعد)، وأُضيفت indexes للـ rate-limit وللـ sweep، وحُذف index بحقل واحد على `messages` (غير صالح كـ composite غالبًا وقد يكسر النشر).
- `core/escalation.js`: `Object.hasOwn` لتجنب انهيار `level: 'constructor'`.
- `package.json`: `engines.node = 22` (هو ما اختُبر فعليًا، يحل K3)، وأُضيفت الاعتماديات (`firebase-admin ^13`, `firebase-functions ^6.3`) وسكربت `test:rules`، و`firebase.json` فيه إعدادات emulators.

## 2. حالة المشروع

**يعمل ومختبر:** منطق `core/` + `service.js` + `notifier.js` — **40 اختبار ناجح** على Node v22 بمخزن في الذاكرة (جرّبت تكسير شرطين من الكود واختبار واحد فشل فعلًا).

**غير مختبر إطلاقًا (لا شبكة ولا Emulator في بيئة العمل):**
- `functions/index.js` و`src/firestoreStore.js`: فُحصا لغويًا فقط (`node --check`)، **لم تُثبت المكتبات ولم تُشغّل**. أسماء الـ API من معرفة المكتبات، وتحتاج مراجعة مقابل الإصدارات المثبتة فعليًا.
- `firestore.rules` و`firestore.indexes.json` و`firebase.json` و`test-emulator/rules.test.js`: لم تُنشر ولم تُشغّل.
- لا يوجد `package-lock.json` (لم يُنفّذ `npm install`).

**لم يبدأ:** صفحة الويب، تطبيق Android (وبالتالي لا يوجد APK)، الإشعارات على جهاز، App Check، retention.

**مشاكل ومخاطر معروفة:**
- **K1 (قُبل):** مستند `requests` يقرأه الزائر وفيه `ownerUid` و`carId` (معرّفات معتمة بلا بيانات شخصية). لم أضف مستند مرآة. قابل للمراجعة.
- **K2:** rate-limit الزائر مبني على uid مجهول يُتجاوز بمسح بيانات المتصفح. حد السيارة موجود، والحماية الكاملة (App Check + hash للـ IP) في المرحلة 7.
- **K4:** لا `.firebaserc` — لم يُربط مشروع Firebase (D4).
- **K5 (جديد):** الخادم يخزّن hash الـ token فقط، فالـ QR يُعاد مرة واحدة عند `createCar`/`rotateQr`. تطبيق Android لازم يحفظه محليًا، ولو ضاع يُعمل `rotateQr` (والمطبوع القديم يبطل). المواصفات تطلب عرض/تنزيل الـ QR لاحقًا — **قرار منتج مطلوب**.
- **K6 (جديد):** حالة `delivered` تتم فقط عند استدعاء التطبيق `ackDelivered`، ولا تُسجّل من الخادم.

## 3. القرارات المعتمدة افتراضيًا (لم يوافق عليها صاحب المنتج بعد)

- **D1 / A2:** التنبيه يتوقف عند `viewed` (فتح الطلب فعليًا).
- **D2 / A7:** الـ 15 دقيقة من إنشاء الطلب وتسري حتى لو الشات شغال.
- **D3:** دوال المالك ترفض فقط الحساب المجهول، فهي لا تفرض مزوّد تسجيل معين. اختيار SMS/بريد/Google لا يحجب هذه المرحلة.
- **A8 / A9 (جديد):** 5 سيارات لكل مالك، و100 رسالة لكل طلب.
- نص الـ push يحمل سبب الطلب فقط ولا يحمل رسالة الزائر (خصوصية شاشة القفل).

**ما زال يحجب النشر:** D4 (مشروع Firebase + خطة Blaze + المنطقة — حاليًا `europe-west1` مؤقتًا في `index.js`) وD5 (دومين الـ QR → متغير `PUBLIC_BASE_URL`). D6 (مدة الاحتفاظ) يخص المرحلة 7.

## 4. الاختبارات

| الاختبار | النتيجة |
|---|---|
| `cd functions && npm test` (Node v22.23.5) | **40 ناجح، 0 فاشل** |
| `node --check functions/index.js`، صياغة JSON للـ `firebase.json` و`firestore.indexes.json` | سليمة |
| `npm run test:rules`، التشغيل على Emulator، `npm install`، النشر | **لم يُنفّذ** |

> اختبارات الوحدة تثبت منطق الخدمة فقط، ولا تثبت أن أي من معايير القبول الـ 12 يعمل على Firebase الحقيقي.

## 5. المهام المتبقية (بالأولوية)

1. على جهاز فيه إنترنت: `cd functions && npm install` ثم `npm test`، ثم `firebase emulators:start` و`npm run test:rules`، وإصلاح أي خطأ في `index.js` / `firestoreStore.js` / القواعد.
2. حسم D4 وD5 ثم إنشاء `.firebaserc`.
3. **Phase 3:** صفحة الويب للزائر (`web/`).
4. **Phase 4–6:** مشروع `android/` وworkflow بناء APK على GitHub Actions.
5. **Phase 7:** App Check وretention واختبار القبول.

## 6. تعليمات المطور التالي

- ابدأ بالبند 1 أعلاه قبل أي ميزة جديدة. لا تعتبر Phase 2 مكتملة حتى تنجح اختبارات القواعد على الـ Emulator.
- لا تعد كتابة المنطق داخل Functions: استخدم `service.js`. كل الكتابة الحساسة تبقى عبر Functions فقط، وتخزين الـ hash بدل الـ token.
- **ممنوع حسب المواصفات:** مكالمات هاتفية، مشاركة الموقع، إعادة فتح جلسة مغلقة، وضع رقم هاتف/بيانات شخصية في QR أو صفحة الزائر.
- تذكير: وصول الـ push ليس دليلًا أن المالك شاهده. `viewed` تُسجَّل فقط عند فتح المالك للطلب فعليًا (`markViewed`).

## سجل المراحل

| المرحلة | التاريخ | الحالة |
|---|---|---|
| 1 — نواة الـ Backend | 2026-11-24 | منفذة |
| 2 — الخدمة وربط Firebase | 2026-11-24 | المنطق مختبر؛ الربط والقواعد غير مختبرين |
| 3 → 7 | — | لم تبدأ |
