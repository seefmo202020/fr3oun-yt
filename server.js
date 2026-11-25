import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 20 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith("video/"))
});
const imageUpload = multer({
  dest: uploadDir, limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ["image/jpeg","image/png","image/webp"].includes(file.mimetype))
});
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const oauthReady = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
const oauth2 = () => new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
const tokenPath = path.join(__dirname, "token.json");
function getAuth() {
  if (!fs.existsSync(tokenPath)) return null;
  try {
    const client = oauth2();
    client.setCredentials(JSON.parse(fs.readFileSync(tokenPath, "utf8")));
    return client;
  } catch { return null; }
}
function safeUnlink(p) { if (p) fs.unlink(p, () => {}); }
app.get("/api/status", async (_req, res) => {
  const auth = getAuth();
  let channel = null;
  if (auth) {
    try {
      const yt = google.youtube({version:"v3", auth});
      const r = await yt.channels.list({part:["snippet"], mine:true});
      const c = r.data.items?.[0];
      if (c) channel = { title:c.snippet?.title, id:c.id };
    } catch {}
  }
  res.json({
    aiConfigured: Boolean(process.env.GEMINI_API_KEY),
    oauthConfigured: oauthReady(),
    connected: Boolean(auth),
    channel
  });
});
app.get("/auth/youtube", (_req, res) => {
  if (!oauthReady()) return res.status(400).send("أكمل إعداد Google OAuth في متغيرات البيئة أولاً.");
  const url = oauth2().generateAuthUrl({
    access_type:"offline", prompt:"consent",
    scope:["https://www.googleapis.com/auth/youtube.upload","https://www.googleapis.com/auth/youtube.readonly"]
  });
  res.redirect(url);
});
app.get("/oauth2callback", async (req, res) => {
  try {
    if (!req.query.code) throw new Error("لم يصل رمز التفويض من Google");
    const {tokens} = await oauth2().getToken(String(req.query.code));
    fs.writeFileSync(tokenPath, JSON.stringify(tokens,null,2), {mode:0o600});
    res.redirect("/?connected=1");
  } catch(e) { res.status(500).send(`فشل ربط يوتيوب: ${e.message}`); }
});
app.post("/api/disconnect", (_req,res) => {
  if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
  res.json({ok:true});
});

async function gemini(parts, model, config={}) {
  if (!process.env.GEMINI_API_KEY) throw new Error("أضف GEMINI_API_KEY في متغيرات البيئة لتفعيل الذكاء الاصطناعي.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const r = await fetch(url, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({contents:[{role:"user",parts}],generationConfig:config})
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Gemini API error ${r.status}`);
  return data;
}
app.post("/api/generate-metadata", async (req,res) => {
  try {
    const topic = String(req.body.topic || "").trim();
    const extra = String(req.body.extra || "").trim();
    if (topic.length < 3) return res.status(400).json({error:"اكتب وصفاً مختصراً لمحتوى الفيديو أولاً."});
    const prompt = `أنت خبير تحسين ظهور فيديوهات YouTube باللغة العربية. حلل موضوع الفيديو التالي وأنشئ بيانات دقيقة وجذابة بدون حشو أو ادعاء ضمان تصدر البحث.
الموضوع/ملخص الفيديو: ${topic}
ملاحظات إضافية: ${extra}
أعد JSON فقط بالمفاتيح التالية:
{"title":"عنوان جذاب واضح لا يتجاوز 100 حرف","description":"وصف مفيد منظم، يبدأ بملخص قوي ويتضمن كلمات البحث بشكل طبيعي","tags":["وسم1","وسم2"],"hashtags":["هاشتاج1","هاشتاج2","هاشتاج3"]}
اجعل العنوان والوصف والوسوم بالعربية المناسبة للمحتوى. لا تضف كلمات لا علاقة لها بالفيديو.`;
    const data = await gemini([{text:prompt}], process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash", {temperature:0.7, responseMimeType:"application/json"});
    const raw = data.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("") || "";
    const parsed = JSON.parse(raw.replace(/^```json\s*/i,"").replace(/```$/,"").trim());
    res.json({ok:true, ...parsed});
  } catch(e) { res.status(500).json({error:e.message || "تعذر توليد البيانات."}); }
});
app.post("/api/generate-thumbnail", async (req,res) => {
  try {
    const prompt = String(req.body.prompt || "").trim();
    if (prompt.length < 3) return res.status(400).json({error:"اكتب وصفاً للصورة المصغرة."});
    const data = await gemini([{text:`Create a compelling YouTube thumbnail, 16:9 landscape, high contrast, clear focal subject, professional composition. Avoid logos and watermarks. Image concept: ${prompt}`}], process.env.GEMINI_IMAGE_MODEL || "gemini-2.0-flash-preview-image-generation", {responseModalities:["IMAGE","TEXT"]});
    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p=>p.inlineData?.data);
    if (!imagePart) throw new Error(parts.map(p=>p.text).filter(Boolean).join(" ") || "الموديل لم يرجع صورة. جرّب تغيير GEMINI_IMAGE_MODEL أو راجع إتاحة توليد الصور لحسابك.");
    res.json({ok:true, mimeType:imagePart.inlineData.mimeType || "image/png", image:`data:${imagePart.inlineData.mimeType || "image/png"};base64,${imagePart.inlineData.data}`});
  } catch(e) { res.status(500).json({error:e.message || "تعذر توليد الصورة."}); }
});
app.post("/api/upload", upload.single("video"), async (req,res) => {
  if (!req.file) return res.status(400).json({error:"اختر ملف فيديو صالحاً."});
  const auth = getAuth();
  if (!auth) { safeUnlink(req.file.path); return res.status(401).json({error:"اربط قناة يوتيوب أولاً."}); }
  try {
    const yt = google.youtube({version:"v3", auth});
    const tags = String(req.body.tags || "").split(",").map(s=>s.trim()).filter(Boolean).slice(0,500);
    const response = await yt.videos.insert({
      part:["snippet","status"],
      requestBody:{snippet:{
        title:String(req.body.title || "فيديو جديد").slice(0,100),
        description:String(req.body.description || ""),
        tags, categoryId:String(req.body.categoryId || "22")
      },status:{
        privacyStatus:["private","unlisted","public"].includes(req.body.privacy) ? req.body.privacy : "private",
        selfDeclaredMadeForKids:req.body.madeForKids === "true"
      }},
      media:{body:fs.createReadStream(req.file.path)}
    });
    const videoId = response.data.id;
    safeUnlink(req.file.path);
    res.json({ok:true,videoId,url:`https://www.youtube.com/watch?v=${videoId}`});
  } catch(e) { safeUnlink(req.file.path); res.status(500).json({error:e.message || "تعذر رفع الفيديو."}); }
});
app.post("/api/thumbnail", imageUpload.single("thumbnail"), async (req,res) => {
  if (!req.file) return res.status(400).json({error:"اختر صورة JPG أو PNG أو WebP."});
  const auth = getAuth();
  if (!auth) { safeUnlink(req.file.path); return res.status(401).json({error:"اربط يوتيوب أولاً."}); }
  try {
    const videoId = String(req.body.videoId || "");
    if (!videoId) throw new Error("معرّف الفيديو غير موجود.");
    const yt = google.youtube({version:"v3",auth});
    await yt.thumbnails.set({videoId,media:{body:fs.createReadStream(req.file.path)}});
    safeUnlink(req.file.path);
    res.json({ok:true});
  } catch(e) { safeUnlink(req.file.path); res.status(500).json({error:e.message}); }
});
app.listen(PORT, () => console.log(`Fr3oun AI يعمل على المنفذ ${PORT}`));
