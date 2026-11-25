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
const thumbnailUpload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ["image/jpeg", "image/png"].includes(file.mimetype))
});
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const oauthReady = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const oauth2 = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`
);
const tokenPath = path.join(__dirname, "token.json");
function getAuth() {
  if (!fs.existsSync(tokenPath)) return null;
  const client = oauth2();
  client.setCredentials(JSON.parse(fs.readFileSync(tokenPath, "utf8")));
  return client;
}
app.get("/api/status", (_req, res) => {
  res.json({ configured: oauthReady(), connected: Boolean(getAuth()) });
});
app.get("/auth/youtube", (_req, res) => {
  if (!oauthReady()) return res.status(400).send("أضف بيانات Google OAuth في ملف .env أولاً.");
  const url = oauth2().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/youtube.upload"]
  });
  res.redirect(url);
});
app.get("/oauth2callback", async (req, res) => {
  try {
    if (!req.query.code) throw new Error("لم يصل رمز التفويض من Google");
    const { tokens } = await oauth2().getToken(String(req.query.code));
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    res.redirect("/?connected=1");
  } catch (e) {
    res.status(500).send(`فشل ربط يوتيوب: ${e.message}`);
  }
});
app.post("/api/disconnect", (_req, res) => {
  if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
  res.json({ ok: true });
});
app.post("/api/upload", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "اختر ملف فيديو صالحاً." });
  const auth = getAuth();
  if (!auth) {
    fs.unlinkSync(req.file.path);
    return res.status(401).json({ error: "اربط قناة يوتيوب أولاً." });
  }
  try {
    const youtube = google.youtube({ version: "v3", auth });
    const tags = String(req.body.tags || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 500);
    const response = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: String(req.body.title || "فيديو جديد").slice(0, 100),
          description: String(req.body.description || ""),
          tags,
          categoryId: String(req.body.categoryId || "22")
        },
        status: {
          privacyStatus: ["private", "unlisted", "public"].includes(req.body.privacy) ? req.body.privacy : "private",
          selfDeclaredMadeForKids: req.body.madeForKids === "true"
        }
      },
      media: { body: fs.createReadStream(req.file.path) }
    });
    const videoId = response.data.id;
    if (req.file) fs.unlink(req.file.path, () => {});
    res.json({ ok: true, videoId, url: `https://www.youtube.com/watch?v=${videoId}` });
  } catch (e) {
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: e.message || "تعذر رفع الفيديو." });
  }
});
app.post("/api/thumbnail", thumbnailUpload.single("thumbnail"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "اختر صورة JPG أو PNG." });
  const auth = getAuth();
  if (!auth) { fs.unlink(req.file.path, () => {}); return res.status(401).json({ error: "اربط يوتيوب أولاً." }); }
  try {
    const youtube = google.youtube({ version: "v3", auth });
    await youtube.thumbnails.set({
      videoId: String(req.body.videoId || ""),
      media: { body: fs.createReadStream(req.file.path) }
    });
    fs.unlink(req.file.path, () => {});
    res.json({ ok: true });
  } catch (e) {
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: e.message });
  }
});
app.listen(PORT, () => console.log(`Fr3oun AI يعمل على http://localhost:${PORT}`));
