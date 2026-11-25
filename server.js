import 'dotenv/config';
import express from 'express';
import cookieSession from 'cookie-session';
import multer from 'multer';
import { google } from 'googleapis';
import { GoogleGenAI, createUserContent, createPartFromUri } from '@google/genai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  PORT = 3000, BASE_URL = `http://localhost:${PORT}`,
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GEMINI_API_KEY,
  SESSION_SECRET, GEMINI_MODEL = 'gemini-2.5-flash', MAX_FILE_MB = 2048,
} = process.env;

for (const [k, v] of Object.entries({ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GEMINI_API_KEY, SESSION_SECRET })) {
  if (!v) { console.error(`Missing env: ${k} (شوف ملف .env.example)`); process.exit(1); }
}

const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

/* ---------- تخزين مشفّر للتوكنز ---------- */
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
const KEY = crypto.createHash('sha256').update(SESSION_SECRET).digest();

const enc = (t) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const e = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), e]).toString('base64');
};
const dec = (b64) => {
  const b = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
};
const loadUsers = () => { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; } };
const saveUsers = (u) => fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2), { mode: 0o600 });

const newOAuth = () => new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

function getClient(channelId) {
  const users = loadUsers();
  const u = users[channelId];
  if (!u) return null;
  const o = newOAuth();
  o.setCredentials(JSON.parse(dec(u.tokens)));
  o.on('tokens', (t) => {
    const all = loadUsers();
    if (!all[channelId]) return;
    const cur = JSON.parse(dec(all[channelId].tokens));
    all[channelId].tokens = enc(JSON.stringify({ ...cur, ...t }));
    saveUsers(all);
  });
  return o;
}

/* ---------- السيرفر ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(cookieSession({
  name: 'sess', keys: [SESSION_SECRET], maxAge: 30 * 24 * 3600 * 1000,
  httpOnly: true, sameSite: 'lax', secure: BASE_URL.startsWith('https'),
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/auth/google', (req, res) => {
  req.session.state = crypto.randomBytes(16).toString('hex');
  res.redirect(newOAuth().generateAuthUrl({
    access_type: 'offline', prompt: 'consent', scope: SCOPES, state: req.session.state,
  }));
});

app.get('/auth/callback', async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== req.session.state) return res.status(400).send('طلب غير صالح');
    const o = newOAuth();
    const { tokens } = await o.getToken(req.query.code);
    o.setCredentials(tokens);
    const r = await google.youtube({ version: 'v3', auth: o }).channels.list({ part: ['snippet'], mine: true });
    const ch = r.data.items?.[0];
    if (!ch) return res.status(400).send('الحساب ده مفيهوش قناة يوتيوب');
    const users = loadUsers();
    const old = users[ch.id] ? JSON.parse(dec(users[ch.id].tokens)) : {};
    users[ch.id] = {
      title: ch.snippet.title,
      thumb: ch.snippet.thumbnails?.default?.url || '',
      tokens: enc(JSON.stringify({ ...old, ...tokens })),
    };
    saveUsers(users);
    req.session = { channelId: ch.id };
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.status(500).send('فشل ربط القناة');
  }
});

app.post('/auth/logout', (req, res) => {
  const id = req.session?.channelId;
  if (id) { const u = loadUsers(); delete u[id]; saveUsers(u); }
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = loadUsers()[req.session?.channelId];
  res.json(u ? { connected: true, title: u.title, thumb: u.thumb } : { connected: false });
});

/* ---------- الرفع والمعالجة ---------- */
const UP_DIR = path.join(os.tmpdir(), 'yt-uploads');
fs.mkdirSync(UP_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UP_DIR,
    filename: (_r, f, cb) => cb(null, crypto.randomUUID() + path.extname(f.originalname || '.mp4')),
  }),
  limits: { fileSize: Number(MAX_FILE_MB) * 1024 * 1024 },
  fileFilter: (_r, f, cb) => cb(f.mimetype.startsWith('video/') ? null : new Error('لازم يكون فيديو'), f.mimetype.startsWith('video/')),
});

const jobs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CATEGORIES = '1 Film&Animation, 2 Autos, 10 Music, 15 Pets, 17 Sports, 19 Travel, 20 Gaming, 22 People&Blogs, 23 Comedy, 24 Entertainment, 25 News&Politics, 26 Howto&Style, 27 Education, 28 Science&Tech, 29 Nonprofits';

function buildPrompt(hint, langHint) {
  return `You are a YouTube SEO expert. Watch this video fully (audio + visuals) and produce metadata based ONLY on what is actually in it. Never be misleading or clickbait-lies.
${langHint ? `Write everything in this language: ${langHint}.` : 'Write everything in the same language spoken in the video.'}
${hint ? `Creator notes: ${hint}` : ''}

Return JSON only with this exact shape:
{
 "language": "BCP-47 code of the video's spoken language, e.g. ar or en",
 "title": "catchy, honest, max 70 characters, main keyword near the start",
 "description": "hook in the first 2 lines containing the main keyword, then a clear summary, then key points. Add chapters as '0:00 Title' lines only if the video structure is clear. No hashtags here.",
 "hashtags": ["3 to 5 relevant hashtags, each starting with #, no spaces"],
 "tags": ["15 to 25 tags: mostly long-tail search phrases of 2-4 words people really search, plus a few short ones"],
 "categoryId": "one id from: ${CATEGORIES}"
}`;
}

function sanitize(m) {
  const clean = (s) => String(s || '').replace(/[<>]/g, '').trim();
  const title = clean(m.title).slice(0, 100) || 'Untitled';
  const hashtags = (m.hashtags || []).map((h) => '#' + clean(h).replace(/^#+/, '').replace(/\s+/g, '')).filter((h) => h.length > 1).slice(0, 5);
  let description = clean(m.description);
  if (hashtags.length) description += `\n\n${hashtags.join(' ')}`;
  description = Buffer.from(description).subarray(0, 4900).toString('utf8').replace(/\uFFFD$/, '');
  const tags = []; let total = 0;
  for (const t of (m.tags || []).map(clean)) {
    if (!t || t.length > 60) continue;
    const cost = t.length + (t.includes(' ') ? 2 : 0) + 1;
    if (total + cost > 480) break;
    if (!tags.includes(t)) { tags.push(t); total += cost; }
  }
  const categoryId = /^\d+$/.test(String(m.categoryId)) ? String(m.categoryId) : '22';
  return { title, description, tags, hashtags, categoryId, language: clean(m.language) || undefined };
}

async function analyzeWithGemini(filePath, mime, hint, langHint) {
  let file = await ai.files.upload({ file: filePath, config: { mimeType: mime } });
  try {
    while (file.state === 'PROCESSING') { await sleep(3000); file = await ai.files.get({ name: file.name }); }
    if (file.state === 'FAILED') throw new Error('Gemini فشل في معالجة الفيديو');
    const r = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: createUserContent([createPartFromUri(file.uri, file.mimeType), buildPrompt(hint, langHint)]),
      config: { responseMimeType: 'application/json' },
    });
    return JSON.parse(r.text.replace(/```json|```/g, '').trim());
  } finally {
    ai.files.delete({ name: file.name }).catch(() => {});
  }
}

async function runJob(job, channelId, file, opts) {
  try {
    const auth = getClient(channelId);
    if (!auth) throw new Error('اربط القناة تاني');
    job.step = 'analyzing';
    const meta = sanitize(await analyzeWithGemini(file.path, file.mimetype || 'video/mp4', opts.hint, opts.lang));
    job.meta = meta;
    job.step = 'uploading';
    const yt = google.youtube({ version: 'v3', auth });
    const r = await yt.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: meta.title, description: meta.description, tags: meta.tags,
          categoryId: meta.categoryId, defaultLanguage: meta.language, defaultAudioLanguage: meta.language,
        },
        status: { privacyStatus: opts.privacy, selfDeclaredMadeForKids: false },
      },
      media: { body: fs.createReadStream(file.path) },
    });
    job.url = `https://www.youtube.com/watch?v=${r.data.id}`;
    job.step = 'done';
  } catch (e) {
    console.error(e);
    job.step = 'error';
    job.error = e?.errors?.[0]?.message || e.message || 'حصل خطأ';
  } finally {
    fs.unlink(file.path, () => {});
    setTimeout(() => jobs.delete(job.id), 3600 * 1000);
  }
}

app.post('/api/upload', (req, res) => {
  const channelId = req.session?.channelId;
  if (!channelId || !loadUsers()[channelId]) return res.status(401).json({ error: 'اربط قناتك الأول' });
  upload.single('video')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'مفيش فيديو' });
    const privacy = ['private', 'unlisted', 'public'].includes(req.body.privacy) ? req.body.privacy : 'private';
    const job = { id: crypto.randomUUID(), channelId, step: 'queued' };
    jobs.set(job.id, job);
    runJob(job, channelId, req.file, { privacy, hint: (req.body.hint || '').slice(0, 500), lang: (req.body.lang || '').slice(0, 20) });
    res.json({ jobId: job.id });
  });
});

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.channelId !== req.session?.channelId) return res.status(404).json({ error: 'غير موجود' });
  const { id, channelId, ...pub } = job;
  res.json(pub);
});

const server = app.listen(PORT, () => console.log(`Running on ${BASE_URL}`));
server.requestTimeout = 0;
server.headersTimeout = 0;
