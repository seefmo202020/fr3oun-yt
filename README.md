# رفع فيديو على يوتيوب

موقع بيربط قناتك، وترفع فيه الفيديو وتكتب العنوان والوصف والتاجز وتختار صورة مصغرة، وبعدين بيرفعه على يوتيوب.

> ⚠️ ده مش هيشتغل على GitHub Pages. محتاج سيرفر Node.js (زي Bonto أو Ubuntu).

## 1) إعداد Google
1. افتح Google Cloud Console وأنشئ مشروع.
2. فعّل **YouTube Data API v3** و **YouTube Analytics API** (للمشاهدة والـ watch time).
3. OAuth consent screen: ضيف إيميل قناتك في Test users.
4. Credentials → Create OAuth client ID → **Web application**.
5. في Authorized redirect URIs حط: `https://موقعك/auth/callback`
6. انسخ Client ID و Client Secret.

## 2) المتغيرات (Environment Variables)
```
BASE_URL=https://موقعك
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SESSION_SECRET=نص-عشوائي-طويل
```
أمر التشغيل: `npm start`

## 3) تشغيل محلي
```bash
npm install
cp .env.example .env   # واملأه
npm start
```

## ملاحظات مهمة
- مشروع Google غير الموثّق: الفيديوهات بتتقفل **Private** لحد ما تقدّم على YouTube API Audit.
- حصة يوتيوب الافتراضية 10,000 وحدة يومياً، والرفع الواحد بـ 1600 (حوالي 6 فيديوهات).
- الصورة المصغرة المخصصة محتاجة قناة موثّقة برقم الموبايل، وحجمها أقل من 2MB.
- الفيديو بيتخزن مؤقتاً على السيرفر وقت الرفع بس، وبعدين بيتمسح.
- التوكنز متخزنة مشفّرة في `data/users.json` (موجودة في `.gitignore`).
- ارفع `.env.example` بس، وماترفعش `.env` على GitHub أبداً.
- بعد إضافة صلاحية الإحصائيات لازم تفصل القناة وتربطها تاني.
- بيانات الـ watch time بتتأخر يوم أو اتنين من يوتيوب.
