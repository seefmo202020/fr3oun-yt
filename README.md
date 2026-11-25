# رفع ذكي على يوتيوب

موقع بيربط قناتك، يستقبل الفيديو، Gemini يحلله ويولد (عنوان، وصف، هاشتاجات، تاجز، لغة، تصنيف)، وبعدين يرفعه على يوتيوب.

> ⚠️ ده مش هيشتغل على GitHub Pages. محتاج سيرفر Node.js (زي Ubuntu).

## 1) إعداد Google
1. افتح Google Cloud Console وأنشئ مشروع.
2. فعّل **YouTube Data API v3**.
3. OAuth consent screen: ضيف نفسك في Test users.
4. Credentials → Create OAuth client ID → **Web application**.
5. في Authorized redirect URIs حط: `https://موقعك/auth/callback` (ولو تجربة محلية: `http://localhost:3000/auth/callback`).
6. انسخ Client ID و Client Secret.

مفتاح Gemini من: https://aistudio.google.com/apikey

## 2) التشغيل المحلي
```bash
npm install
cp .env.example .env   # واملأه
npm start
```

## 3) النشر على Ubuntu
```bash
sudo apt update && sudo apt install -y git nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm i -g pm2

git clone https://github.com/USER/REPO.git && cd REPO
npm install
cp .env.example .env && nano .env      # BASE_URL لازم يكون https://دومينك
pm2 start server.js --name yt-uploader && pm2 save && pm2 startup
```

إعداد nginx (`/etc/nginx/sites-available/yt`):
```nginx
server {
  server_name دومينك.com;
  client_max_body_size 2g;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/yt /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d دومينك.com
```

## ملاحظات مهمة
- مشروع Google غير الموثّق: الفيديوهات بتتقفل **Private** لحد ما تقدّم على YouTube API Audit.
- الحصة الافتراضية 10,000 وحدة يومياً، والرفع الواحد بـ 1600.
- الخطة المجانية في Gemini ممكن جوجل تستخدم فيها البيانات لتحسين منتجاتها.
- التوكنز متخزنة مشفّرة في `data/users.json`، ومتعملهاش commit (موجودة في `.gitignore`).
- لا ترفع ملف `.env` على GitHub أبداً.
