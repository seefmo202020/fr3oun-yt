import 'dotenv/config';
import express from 'express';
import cookieSession from 'cookie-session';
import multer from 'multer';
import { google } from 'googleapis';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  PORT = 3000, BASE_URL = `http://localhost:${PORT}`,
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
  SESSION_SECRET, MAX_FILE_MB = 2048, DAILY_VIDEOS_PER_USER = 5,
} = process.env;

for (const [k, v] of Object.entries({ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET })) {
  if (!v) { console.error(`Missing env: ${k} (شوف ملف .env.example)`); process.exit(1); }
}

const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

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
  fileFilter: (_r, f, cb) => {
    const ok = f.fieldname === 'thumbnail'
      ? /^image\/(jpeg|png|gif)$/.test(f.mimetype)
      : f.mimetype.startsWith('video/');
    cb(ok ? null : new Error(f.fieldname === 'thumbnail' ? 'الصورة لازم تكون JPG أو PNG' : 'لازم يكون فيديو'), ok);
  },
});

const jobs = new Map();

function parseTags(input) {
  const raw = String(input || '').split(/[,،\n]/).map((t) => t.replace(/[<>#]/g, '').trim()).filter(Boolean);
  const tags = []; let total = 0;
  for (const t of raw) {
    if (t.length > 60 || tags.includes(t)) continue;
    const cost = t.length + (t.includes(' ') ? 2 : 0) + 1;
    if (total + cost > 480) break;
    tags.push(t); total += cost;
  }
  return tags;
}
const cleanText = (v) => String(v || '').replace(/[<>]/g, '').trim();

/* حد يومي لكل مستخدم (حصة يوتيوب بتكفي حوالي 6 فيديوهات في اليوم) */
const daily = new Map();
function takeDailySlot(channelId) {
  const key = `${channelId}:${new Date().toISOString().slice(0, 10)}`;
  const n = daily.get(key) || 0;
  if (n >= Number(DAILY_VIDEOS_PER_USER)) return false;
  daily.set(key, n + 1);
  return true;
}

async function runJob(job, channelId, file, thumb, meta) {
  try {
    const auth = getClient(channelId);
    if (!auth) throw new Error('اربط القناة تاني');
    const size = fs.statSync(file.path).size;
    job.total = size; job.uploaded = 0; job.t0 = Date.now();
    const yt = google.youtube({ version: 'v3', auth });
    const r = await yt.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: meta.title, description: meta.description, tags: meta.tags, categoryId: meta.categoryId,
          ...(meta.language ? { defaultLanguage: meta.language, defaultAudioLanguage: meta.language } : {}),
        },
        status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: false },
      },
      media: { body: fs.createReadStream(file.path) },
    }, {
      onUploadProgress: (e) => { job.uploaded = e.bytesRead; job.progress = Math.min(99, Math.round((e.bytesRead / size) * 100)); },
    });
    const videoId = r.data.id;
    job.url = `https://www.youtube.com/watch?v=${videoId}`;

    if (thumb) {
      job.step = 'thumbnail';
      try {
        await yt.thumbnails.set({
          videoId,
          media: { mimeType: thumb.mimetype, body: fs.createReadStream(thumb.path) },
        });
      } catch (e) {
        console.error(e);
        job.thumbError = 'الفيديو اترفع، بس الصورة المصغرة فشلت. لازم القناة تكون موثّقة برقم الموبايل عشان تضيف صورة مخصصة.';
      }
    }
    job.progress = 100;
    job.step = 'done';
  } catch (e) {
    console.error(e);
    job.step = 'error';
    job.error = e?.errors?.[0]?.message || e.message || 'حصل خطأ';
  } finally {
    fs.unlink(file.path, () => {});
    if (thumb) fs.unlink(thumb.path, () => {});
    setTimeout(() => jobs.delete(job.id), 3600 * 1000);
  }
}

app.post('/api/upload', (req, res) => {
  const channelId = req.session?.channelId;
  if (!channelId || !loadUsers()[channelId]) return res.status(401).json({ error: 'اربط قناتك الأول' });
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }])(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const file = req.files?.video?.[0];
    const thumb = req.files?.thumbnail?.[0];
    if (!file) return res.status(400).json({ error: 'مفيش فيديو' });
    const drop = (code, error) => {
      fs.unlink(file.path, () => {});
      if (thumb) fs.unlink(thumb.path, () => {});
      return res.status(code).json({ error });
    };

    const title = cleanText(req.body.title).slice(0, 100);
    if (!title) return drop(400, 'اكتب عنوان للفيديو');
    if (thumb && thumb.size > 2 * 1024 * 1024) return drop(400, 'الصورة لازم تكون أقل من 2MB');
    if (!takeDailySlot(channelId)) return drop(429, `وصلت للحد اليومي (${DAILY_VIDEOS_PER_USER} فيديوهات). جرّب بكرة.`);

    const description = Buffer.from(cleanText(req.body.description)).subarray(0, 4900).toString('utf8').replace(/\uFFFD$/, '');
    const meta = {
      title, description,
      tags: parseTags(req.body.tags),
      categoryId: /^\d+$/.test(req.body.category || '') ? req.body.category : '22',
      language: cleanText(req.body.lang).slice(0, 20) || undefined,
      privacy: ['private', 'unlisted', 'public'].includes(req.body.privacy) ? req.body.privacy : 'private',
    };
    const job = { id: crypto.randomUUID(), channelId, step: 'uploading', progress: 0 };
    jobs.set(job.id, job);
    runJob(job, channelId, file, thumb, meta);
    res.json({ jobId: job.id });
  });
});

app.get('/api/videos', async (req, res) => {
  const channelId = req.session?.channelId;
  const auth = channelId && getClient(channelId);
  if (!auth) return res.status(401).json({ error: 'اربط قناتك الأول' });
  try {
    const yt = google.youtube({ version: 'v3', auth });
    const ch = (await yt.channels.list({ part: ['contentDetails', 'statistics'], mine: true })).data.items?.[0];
    const pl = await yt.playlistItems.list({
      part: ['contentDetails'], playlistId: ch.contentDetails.relatedPlaylists.uploads,
      maxResults: 24, pageToken: req.query.page || undefined,
    });
    const ids = pl.data.items.map((i) => i.contentDetails.videoId);
    let videos = [];
    if (ids.length) {
      const v = await yt.videos.list({ part: ['snippet', 'contentDetails', 'statistics', 'status'], id: ids });
      videos = v.data.items
        .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
        .map((x) => ({
          id: x.id, title: x.snippet.title, description: x.snippet.description, tags: x.snippet.tags || [],
          publishedAt: x.snippet.publishedAt, categoryId: x.snippet.categoryId,
          thumb: (x.snippet.thumbnails?.medium || x.snippet.thumbnails?.default || {}).url,
          duration: x.contentDetails.duration, definition: x.contentDetails.definition,
          dimension: x.contentDetails.dimension, caption: x.contentDetails.caption === 'true',
          privacy: x.status.privacyStatus, uploadStatus: x.status.uploadStatus,
          views: +x.statistics.viewCount || 0, likes: +x.statistics.likeCount || 0, comments: +x.statistics.commentCount || 0,
        }));
    }
    let watch = {}, analytics = false;
    if (ids.length) {
      try {
        const ya = google.youtubeAnalytics({ version: 'v2', auth });
        const r = await ya.reports.query({
          ids: 'channel==MINE', startDate: '2005-02-14', endDate: new Date().toISOString().slice(0, 10),
          metrics: 'estimatedMinutesWatched,averageViewDuration', dimensions: 'video',
          filters: `video==${ids.join(',')}`, sort: '-estimatedMinutesWatched', maxResults: 50,
        });
        (r.data.rows || []).forEach(([id, mins, avg]) => { watch[id] = { mins, avg }; });
        analytics = true;
      } catch (e) { console.error('analytics:', e.message); }
    }
    videos.forEach((v) => { v.watchMins = watch[v.id]?.mins ?? null; v.avgSecs = watch[v.id]?.avg ?? null; });
    res.json({
      channel: { subs: +ch.statistics.subscriberCount || 0, views: +ch.statistics.viewCount || 0, videos: +ch.statistics.videoCount || 0 },
      videos, analytics, nextPage: pl.data.nextPageToken || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.errors?.[0]?.message || e.message });
  }
});

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.channelId !== req.session?.channelId) return res.status(404).json({ error: 'غير موجود' });
  const { id, channelId, t0, ...pub } = job;
  res.json({ ...pub, elapsed: t0 ? (Date.now() - t0) / 1000 : 0 });
});

const server = app.listen(PORT, () => console.log(`Running on ${BASE_URL}`));
server.requestTimeout = 0;
server.headersTimeout = 0;
