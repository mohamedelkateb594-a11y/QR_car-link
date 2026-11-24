# DEVELOPER_HANDOFF — QR Car Contact

- **آخر تحديث:** 2026-11-25
- **المرحلة المنفذة:** Phase 1 ✅ + Phase 2 (جزئيًا: المنطق مختبر، الربط بـ Firebase غير مختبر) — راجع `docs/EXECUTION_PLAN.md`
- **المرجع الأساسي للمتطلبات:** `QR_Car_Contact_Spec.md` (أي تغيير في السلوك الأساسي يحتاج موافقة صاحب المنتج)

## 1. ما تم في هذه الجلسة (Phase 2)

- `functions/src/services/service.js`: كل منطق الأعمال (createCar, rotateQr, createRequest, sendMessage, markViewed, closeRequest, cancelRequest, expireRequest, fireAlert, sweepExpired) بدون أي import لـ Firebase؛ الـ store والـ notifier والـ scheduler تُحقن.
- `functions/src/services/memoryStore.js`: store في الذاكرة للاختبار (transactions متسلسلة مع rollback).
- `functions/test/service.test.js`: **17 اختبار ناجح** لمعايير القبول 3، 5، 7، 8، 9، 10، 11، 12 على مستوى المنطق.
- `functions/src/services/firestoreStore.js` و`functions/index.js`: ربط Firestore وCloud Functions v2 وCloud Tasks وFCM. **لم يُشغَّل أي منهما** (فُحصت صياغة JS فقط بـ `node --check`).
- `firestore.rules`: حُسم K1 — الزائر يقرأ `sessions/{id}` (مرآة بلا `ownerUid`/`carId`)، والمالك يقرأ `requests/{id}`. **غير مختبرة على Emulator.**
- `functions/package.json`: أُضيف `firebase-admin ^12` و`firebase-functions ^5` — **لم تُثبَّت** (لا شبكة) والإصدارات لم تُتحقق.

**خلل وُجد وأُصلح:** كان الانتهاء المتأخر (lazy expiry) يُلغى بالـ rollback لأن الخطأ يُرمى داخل الـ transaction. الآن الأخطاء المتوقعة تُرمى بعد الـ commit (`txOrFail`).

## 2. قرارات اتخذتها (افتراضات جديدة)

- **K1 محسوم:** مستند مرآة `sessions/{id}`؛ الرسائل في `sessions/{id}/messages` (بلا uids).
- **A8:** حد أقصى 5 سيارات لكل مستخدم (غير موجود في المواصفات).
- خطأ موحّد `not_found` لأي token غير صالح/مُبطَل/متوقف/غير موجود، وأيضًا لغير المشاركين في الجلسة، كي لا يُستخدم كأداة تخمين.
- فشل الـ push لا يُفقد الطلب: يبقى `created` ويراه المالك داخل التطبيق؛ `sent` فقط عند قبول FCM، ولا تُسجَّل `viewed` إلا عند فتح المالك الفعلي.
- `firestoreStore` يؤجل الكتابات إلى نهاية الـ transaction (قيد Firestore: القراءات قبل الكتابات). **لا تقرأ في `service.js` مستندًا كُتب في نفس الـ transaction.**

## 3. مشاكل ومخاطر معروفة

- **K0:** القواعد و`firebase.json` والـ indexes وfirestoreStore وindex.js **لم تُختبر**. الخطوة التالية الإلزامية: `npm install` ثم Firebase Emulator + `@firebase/rules-unit-testing`.
- **Q1:** الرابط الخام للـ QR يُعاد مرة واحدة فقط من `createCar`/`rotateQr` (نخزن hash فقط). التطبيق يجب أن يحفظه محليًا/يولد الصورة فورًا، وإلا لا يمكن عرض نفس QR لاحقًا (الحل البديل: تخزين token مشفّر — قرار لصاحب المنتج).
- **K2:** rate-limit للزائر مبني على uid مجهول (يمكن تجاوزه)؛ الحد لكل سيارة موجود. App Check وhash الـ IP في Phase 7.
- **K3:** `engines.node = 20` والاختبارات على Node 22 فقط.
- **K4:** لا `.firebaserc`. **D3–D6** ما زالت مفتوحة (D4 وD5 تحجبان النشر).
- لا اختبار تزامن حقيقي (سباق رسالة/إغلاق) إلا عبر store متسلسل؛ يحتاج Emulator.
- `sweepExpired` يجلب 200 طلبًا كحد أقصى في الدقيقة.

## 4. الاختبارات

| الاختبار | النتيجة |
|---|---|
| `node --test` على `service.test.js` (Node v22.23.5) | **17 ناجح، 0 فاشل** (شُغّل فعليًا) |
| اختبارات النواة الـ 22 (`states/token/policy/escalation`) | أُبلغ عنها ناجحة في الـ handoff السابق؛ **لم أعد تشغيلها** في هذه الجلسة، فشغّل `npm test` كاملًا أولًا |
| `node --check` لـ index.js وfirestoreStore.js | سليم |
| Emulator / قواعد Firestore / نشر / Android / ويب | **لم يُنفَّذ** |

## 5. المهام المتبقية

1. تثبيت الاعتماديات وتشغيل Emulator واختبار القواعد وfirestoreStore وindex.js (إكمال Phase 2).
2. حسم D1–D6 وQ1 مع صاحب المنتج.
3. Phase 3 (صفحة الويب) → 7 حسب الخطة.

## سجل المراحل

| المرحلة | التاريخ | الحالة |
|---|---|---|
| 1 — نواة الـ Backend | 2026-11-24 | منفذة |
| 2 — Functions + اختبارات | 2026-11-25 | المنطق مختبر؛ الربط والقواعد غير مختبرين |
| 3 → 7 | — | لم تبدأ |
