const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Read settings from .env when it exists (Node 20.12+). Values already in the environment win.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const PORT = process.env.PORT || 3001; // 3000 is used by the Nescafe app
const ADMIN_KEY = process.env.ADMIN_KEY || ''; // needed to delete photos
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(__dirname, 'data.json');
const USED_FILE = path.join(__dirname, 'used-codes.json');

// ---- registration codes (checked against the Nescafe registration portal) ----
// Uploading needs a code from the portal. The code is checked server-to-server with a signed request, so the
// browser never talks to the portal and PARTNER_SECRET never leaves the two servers.
const NESCAFE_API_URL = (process.env.NESCAFE_API_URL || '').replace(/\/$/, '');
const PARTNER_SECRET = process.env.PARTNER_SECRET || '';
const SESSION_MS = 10 * 60 * 1000; // a code opens a 10 minute upload session
const SESSION_COOKIE = 'qps_session';
const derive = (label) => crypto.createHmac('sha256', PARTNER_SECRET).update(label).digest();
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest('base64url');
const codeHash = (code) => crypto.createHmac('sha256', derive('qps-code')).update(code).digest('hex');

if (!NESCAFE_API_URL || !PARTNER_SECRET) {
  console.warn('\n  NESCAFE_API_URL / PARTNER_SECRET are not set: nobody can upload until they are (see .env.example).\n');
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// The QR code must point to an address the phone can reach.
// Priority: BASE_URL env var → the public host the request came in on (e.g. Render) →
// this computer's Wi-Fi/LAN IP when browsing on localhost (phone must be on same network).
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
const ENV_BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
function baseUrl(req) {
  if (ENV_BASE_URL) return ENV_BASE_URL;
  const host = req.get('host') || '';
  if (/^(localhost|127\.0\.0\.1)(:|$)/.test(host)) return `http://${lanIp()}:${PORT}`;
  return `${req.protocol}://${host}`;
}

// ---- tiny JSON "database" ----
function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; }
}
let photos = load();
function save() { fs.writeFileSync(DB_FILE, JSON.stringify(photos, null, 2)); }

const viewUrl = (req, id) => `${baseUrl(req)}/p/${id}`;
const publicPhoto = (req, p) => ({
  id: p.id,
  imageUrl: `/uploads/${p.file}`,
  viewUrl: viewUrl(req, p.id),
  qrUrl: `/api/qr/${p.id}.png`,
  createdAt: p.createdAt,
});

// ---- uploads ----
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const id = crypto.randomBytes(5).toString('hex');
    req.photoId = id;
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, id + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)),
});

// Deleting photos is for the operator only: it needs ADMIN_KEY, and is switched off when none is set.
function requireAdmin(req, res, next) {
  const given = Buffer.from(req.get('x-admin-key') || '');
  const wanted = Buffer.from(ADMIN_KEY);
  if (ADMIN_KEY && given.length === wanted.length && crypto.timingSafeEqual(given, wanted)) return next();
  res.status(401).json({ error: ADMIN_KEY ? 'Wrong admin key' : 'Deleting is switched off (no ADMIN_KEY set).' });
}

// ---- upload sessions ----
function readUsed() {
  try { return JSON.parse(fs.readFileSync(USED_FILE, 'utf8')); } catch { return {}; }
}
let usedCodes = readUsed(); // { codeHash: time it was first used }
function saveUsed() { fs.writeFileSync(USED_FILE, JSON.stringify(usedCodes)); }

function parseCookies(req) {
  const out = {};
  for (const part of (req.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function makeSession(name) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_MS, name })).toString('base64url');
  return `${payload}.${hmac(derive('qps-session'), payload)}`;
}
// Returns { exp, name } for a valid, unexpired session, otherwise null.
function readSession(req) {
  if (!PARTNER_SECRET) return null;
  const [payload, signature] = (parseCookies(req)[SESSION_COOKIE] || '').split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(hmac(derive('qps-session'), payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}
const cookieOptions = (req) => ({ httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });

function requireSession(req, res, next) {
  if (readSession(req)) return next();
  res.status(401).json({ error: 'Enter your registration code first.' });
}

// Small in-memory limiter: `max` hits per `windowMs` for each key.
const hits = new Map();
function limited(key, max, windowMs, count = false) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (count) recent.push(now);
  hits.set(key, recent);
  return recent.length > (count ? max : max - 1);
}

// Asks the registration portal whether `code` is valid. Resolves to { valid, name } or throws when unreachable.
async function checkWithPortal(code) {
  const timestamp = String(Date.now());
  const signature = crypto.createHmac('sha256', PARTNER_SECRET).update(`${timestamp}.${code}`).digest('hex');
  const response = await fetch(`${NESCAFE_API_URL}/api/partner/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-timestamp': timestamp, 'x-signature': signature },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401) return { valid: false };
  if (!response.ok) throw new Error(`portal answered ${response.status}`);
  const data = await response.json();
  return { valid: data.valid === true, name: String(data.name || '') };
}

const app = express();
app.set('trust proxy', true); // so req.protocol is https behind Render's proxy
app.use(express.json({ limit: '1kb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use('/static', express.static(path.join(__dirname, 'public')));

// Pages
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public/display.html')));
app.get('/p/:id', (req, res) => res.sendFile(path.join(__dirname, 'public/view.html')));

// API
app.get('/api/config', (req, res) => res.json({ canDelete: !!ADMIN_KEY, baseUrl: baseUrl(req) }));

app.get('/api/session', (req, res) => {
  const session = readSession(req);
  res.set('Cache-Control', 'no-store');
  res.json(session ? { active: true, name: session.name, secondsLeft: Math.max(0, Math.round((session.exp - Date.now()) / 1000)) } : { active: false });
});

app.post('/api/session', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!NESCAFE_API_URL || !PARTNER_SECRET) return res.status(503).json({ error: 'Uploads are not set up yet. Please ask the staff.' });
  const failKey = `fail:${req.ip}`;
  if (limited(failKey, 10, 5 * 60 * 1000)) return res.status(429).json({ error: 'Too many wrong codes. Please wait a few minutes and try again.' });
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!/^\d{5}$/.test(code)) return res.status(400).json({ error: 'Enter the 5-digit code.' });
  const hash = codeHash(code);
  try {
    const result = await checkWithPortal(code);
    if (!result.valid) {
      limited(failKey, 10, 5 * 60 * 1000, true);
      return res.status(401).json({ error: "That code isn't right. Check it and try again." });
    }
    if (usedCodes[hash]) return res.status(409).json({ error: 'This code has already been used here. Register again to get a new one.' });
    usedCodes[hash] = Date.now();
    saveUsed();
    res.cookie(SESSION_COOKIE, makeSession(result.name), { ...cookieOptions(req), maxAge: SESSION_MS });
    res.json({ active: true, name: result.name, secondsLeft: SESSION_MS / 1000 });
  } catch (error) {
    console.error('Could not check the code:', error.message);
    res.status(503).json({ error: "We couldn't check your code right now. Please try again in a moment." });
  }
});

// The visitor pressed Done: the session ends (the code stays used).
app.post('/api/session/done', (req, res) => {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
  res.json({ active: false });
});

app.post('/api/upload', requireSession, (req, res, next) => (limited(`upload:${req.ip}`, 20, 60 * 1000, true) ? res.status(429).json({ error: 'Too many uploads. Please wait a moment.' }) : next()), upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please upload a JPG, PNG, WEBP or GIF image.' });
  const photo = { id: req.photoId, file: req.file.filename, createdAt: Date.now() };
  photos.unshift(photo);
  save();
  res.json(publicPhoto(req, photo));
});

app.get('/api/photos', (req, res) => res.json(photos.slice(0, 50).map((p) => publicPhoto(req, p))));

app.get('/api/photos/latest', (req, res) => {
  if (!photos.length) return res.status(404).json({ error: 'No photos yet' });
  res.json(publicPhoto(req, photos[0]));
});

app.get('/api/photos/:id', (req, res) => {
  const p = photos.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Photo not found' });
  res.json(publicPhoto(req, p));
});

app.delete('/api/photos/:id', requireAdmin, (req, res) => {
  const p = photos.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Photo not found' });
  photos = photos.filter((x) => x.id !== p.id);
  save();
  fs.unlink(path.join(UPLOAD_DIR, p.file), () => {});
  res.json({ ok: true });
});

app.get('/api/qr/:id.png', async (req, res) => {
  const p = photos.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).end();
  const png = await QRCode.toBuffer(viewUrl(req, p.id), {
    width: 600, margin: 1, errorCorrectionLevel: 'M',
    color: { dark: '#2b2118', light: '#ffffff' },
  });
  res.type('png').send(png);
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, () => {
  console.log(`\n  Admin (upload):   http://localhost:${PORT}/admin`);
  console.log(`  Display (QR):     http://localhost:${PORT}/display`);
  console.log(`  QR codes point to: ${ENV_BASE_URL || 'the address you open the site on (LAN IP for localhost)'}/p/<id>\n`);
});
