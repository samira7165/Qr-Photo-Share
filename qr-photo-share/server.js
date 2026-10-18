const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || ''; // optional: set to protect uploads
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(__dirname, 'data.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// The QR code must point to an address the phone can reach.
// If BASE_URL isn't set, use this computer's Wi-Fi/LAN IP (phone must be on same network).
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
const BASE_URL = (process.env.BASE_URL || `http://${lanIp()}:${PORT}`).replace(/\/$/, '');

// ---- tiny JSON "database" ----
function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; }
}
let photos = load();
function save() { fs.writeFileSync(DB_FILE, JSON.stringify(photos, null, 2)); }

const viewUrl = (id) => `${BASE_URL}/p/${id}`;
const publicPhoto = (p) => ({
  id: p.id,
  imageUrl: `/uploads/${p.file}`,
  viewUrl: viewUrl(p.id),
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

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY || req.get('x-admin-key') === ADMIN_KEY) return next();
  res.status(401).json({ error: 'Wrong admin key' });
}

const app = express();
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use('/static', express.static(path.join(__dirname, 'public')));

// Pages
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public/display.html')));
app.get('/p/:id', (req, res) => res.sendFile(path.join(__dirname, 'public/view.html')));

// API
app.get('/api/config', (req, res) => res.json({ needsKey: !!ADMIN_KEY, baseUrl: BASE_URL }));

app.post('/api/upload', requireAdmin, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please upload a JPG, PNG, WEBP or GIF image.' });
  const photo = { id: req.photoId, file: req.file.filename, createdAt: Date.now() };
  photos.unshift(photo);
  save();
  res.json(publicPhoto(photo));
});

app.get('/api/photos', (req, res) => res.json(photos.slice(0, 50).map(publicPhoto)));

app.get('/api/photos/latest', (req, res) => {
  if (!photos.length) return res.status(404).json({ error: 'No photos yet' });
  res.json(publicPhoto(photos[0]));
});

app.get('/api/photos/:id', (req, res) => {
  const p = photos.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Photo not found' });
  res.json(publicPhoto(p));
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
  const png = await QRCode.toBuffer(viewUrl(p.id), {
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
  console.log(`  QR codes point to: ${BASE_URL}/p/<id>\n`);
});
