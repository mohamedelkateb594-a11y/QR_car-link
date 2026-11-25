# QR Car

يمسح الزائر رمز QR على السيارة فيرسل طلبًا لصاحبها ويتبادلان الرسائل لمدة 15 دقيقة، دون أن يظهر رقم أي طرف.

| الجزء | المكان |
|---|---|
| صفحة الزائر (GitHub Pages) | `docs/` |
| تطبيق صاحب السيارة (Android 10 فأحدث) | `android/` |
| قواعد الأمان (Realtime Database، الخطة المجانية) | `database.rules.json` |
| اختبارات القواعد | `rules-tests/` (لتشغيلها في Actions انسخ `docs/rules-ci.yml.txt` إلى `.github/workflows/rules.yml`) |

`functions/` و`firestore.*` و`firebase.json` تخص نسخة سابقة تحتاج خطة Blaze، **وغير مستخدمة**.

## التشغيل لأول مرة (من المتصفح، دون أوامر)

1. **Firebase Console** ← مشروع `qr-car-contact` ← Authentication ← Sign-in method: فعّل **Email/Password** و**Anonymous**.
2. Realtime Database ← Rules: الصق محتوى `database.rules.json` كاملًا ثم **Publish**.
3. GitHub ← Settings ← Pages: المصدر **Deploy from a branch**، الفرع `main`، المجلد `/docs`.
4. GitHub ← Actions ← **Android build** ← **Run workflow** (اختر الفرع)، وبعد نجاحه نزّل `qr-car-debug-apk` من Artifacts وثبّته على الهاتف.
5. في التطبيق: أنشئ حسابًا، أضف سيارة، اطبع بطاقة الـ QR، ثم امسحها بهاتف آخر وجرّب.

> عند تحديث المشروع انشر القواعد (الخطوة 2) في نفس وقت دمج التغييرات في `main`، فالصفحة والتطبيق يعتمدان عليها.

> نسخة الـ APK تجريبية (debug) ويتغير توقيعها مع كل بناء: احذف النسخة القديمة قبل تثبيت الجديدة. السيارات تعود تلقائيًا بعد تسجيل الدخول.
