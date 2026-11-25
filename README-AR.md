# Fr3oun AI — الإصدار الأول

## المطلوب
- كمبيوتر عليه Node.js 18 أو أحدث.
- حساب Google وقناة YouTube.
- تفعيل YouTube Data API v3 وإنشاء OAuth Client من نوع Web application.

## التشغيل
1. فك ضغط الملف.
2. افتح مجلد المشروع في Terminal.
3. نفّذ: `npm install`
4. انسخ `.env.example` إلى `.env` وأدخل GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET.
5. في Google Cloud Console أضف Redirect URI حرفياً: `http://localhost:3000/oauth2callback`
6. نفّذ: `npm start`
7. افتح: `http://localhost:3000` ثم اضغط ربط قناة يوتيوب.

## تنبيه
- الرفع يبدأ بوضع Private افتراضياً. راجع البيانات قبل اختيار Public.
- هذا الإصدار الأول ينفذ لوحة التحكم وربط يوتيوب ورفع الفيديو والبيانات والصورة المصغرة.
- تحليل الفيديو وكتابة العنوان والوصف والكلمات المفتاحية بالذكاء الاصطناعي ستكون المرحلة التالية بعد تجهيز مزود AI ومفتاح API.
- لا تشارك ملف `.env` أو `token.json` مع أي شخص.
