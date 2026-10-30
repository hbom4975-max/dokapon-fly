// Dokapon Cloud — เซิร์ฟเวอร์เดียวจบ: เสิร์ฟหน้าเว็บ รับอัปโหลดไฟล์เกม และเปิดเบราว์เซอร์ฝั่งเซิร์ฟเวอร์เป็นโฮสต์
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const DATA = process.env.DATA_DIR || '/data';
const TOKEN = process.env.ADMIN_TOKEN || '';
const IDLE_MS = (Number(process.env.IDLE_MINUTES) || 15) * 60000;
const MAX_UPLOAD = 1024 * 1024 * 1024;   // 1 GB
const MAX_WS_MS = 5 * 3600 * 1000;       // เกิน 5 ชม. ตัดการเชื่อมต่อค้าง (กันลืมเปิดแท็บ)

const PUBLIC_FILES = new Set(['index.html', 'play.html', 'upload.html']);
const LOCAL_FILES = new Set(['cloud-host.html']); // ให้เฉพาะเบราว์เซอร์ในเครื่องนี้เปิด
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.zip': 'application/zip' };

const state = { peer: false, game: false };
let lastActivity = Date.now();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function isLocal(req) {
  const ra = req.socket.remoteAddress;
  const loop = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  const proxied = ['x-forwarded-for', 'fly-client-ip', 'forwarded', 'x-real-ip'].some((h) => req.headers[h]);
  return loop && !proxied;
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function firstFile(kind) {
  try {
    const dir = path.join(DATA, kind);
    return fs.readdirSync(dir).find((f) => fs.statSync(path.join(dir, f)).isFile()) || null;
  } catch (e) { return null; }
}
function authed(req, res) {
  if (!TOKEN) { json(res, 503, { error: 'ยังไม่ได้ตั้ง ADMIN_TOKEN' }); return false; }
  if (!safeEq(req.headers['x-token'] || '', TOKEN)) { json(res, 401, { error: 'รหัสผู้ดูแลไม่ถูกต้อง' }); return false; }
  return true;
}

function handleUpload(req, res, u) {
  if (!authed(req, res)) return;
  const kind = u.searchParams.get('kind');
  if (kind !== 'game' && kind !== 'bios') return json(res, 400, { error: 'kind ต้องเป็น game หรือ bios' });
  const name = path.basename(u.searchParams.get('name') || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 100) || 'file';
  const dir = path.join(DATA, kind);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return json(res, 500, { error: 'สร้างโฟลเดอร์ไม่ได้ ' + e.message }); }
  const tmp = path.join(DATA, 'upload.tmp');
  const out = fs.createWriteStream(tmp);
  let n = 0, aborted = false;
  req.on('data', (c) => {
    n += c.length;
    if (n > MAX_UPLOAD && !aborted) {
      aborted = true;
      out.destroy();
      fs.unlink(tmp, () => {});
      json(res, 413, { error: 'ไฟล์ใหญ่เกิน 1 GB' });
      req.destroy();
    }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (aborted) return;
    try {
      for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
      fs.renameSync(tmp, path.join(dir, name));
      console.log(`อัปโหลด ${kind}: ${name} (${Math.round(n / 1048576)} MB)`);
      json(res, 200, { ok: true, name, size: n });
    } catch (e) { json(res, 500, { error: e.message }); }
  });
  out.on('error', (e) => { if (!aborted) json(res, 500, { error: e.message }); });
}

const wss = new WebSocketServer({ noServer: true });

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const local = isLocal(req);
  if (p === '/healthz') return json(res, 200, { ok: true });
  if (!local) lastActivity = Date.now();

  if (p === '/status') {
    return json(res, 200, { ready: state.peer && state.game, hasGame: !!firstFile('game'), viewers: wss.clients.size });
  }
  if (p === '/internal/status' && req.method === 'POST') {
    if (!local) return json(res, 403, { error: 'local only' });
    let b = '';
    req.on('data', (c) => { if (b.length < 4096) b += c; });
    req.on('end', () => {
      try { const j = JSON.parse(b); state.peer = !!j.peer; state.game = !!j.game; } catch (e) {}
      json(res, 200, { ok: true });
    });
    return;
  }
  if (p === '/game/list.json') {
    if (!local) return json(res, 403, { error: 'local only' });
    return json(res, 200, { game: firstFile('game'), bios: firstFile('bios') });
  }
  if (p.startsWith('/game/file/')) {
    if (!local) return json(res, 403, { error: 'local only' });
    const parts = p.split('/'); // ['', 'game', 'file', kind, name]
    let name; try { name = decodeURIComponent(parts[4] || ''); } catch (e) { return json(res, 400, {}); }
    const kind = parts[3];
    if ((kind !== 'game' && kind !== 'bios') || name !== path.basename(name)) return json(res, 400, {});
    const file = path.join(DATA, kind, name);
    return fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  }
  if (p === '/upload' && req.method === 'PUT') return handleUpload(req, res, u);
  if (p === '/restart' && req.method === 'POST') {
    if (!authed(req, res)) return;
    json(res, 200, { ok: true });
    setTimeout(() => { console.log('รีสตาร์ทตามคำสั่ง'); process.exit(1); }, 500);
    return;
  }

  const name = p === '/' ? 'index.html' : p.slice(1);
  if (PUBLIC_FILES.has(name) || (local && LOCAL_FILES.has(name))) {
    return fs.readFile(path.join(__dirname, name), (err, data) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }
  json(res, 404, { error: 'not found' });
});

// WebSocket /keepalive: ให้ Fly รู้ว่ายังมีคนเล่นอยู่ (ภาพ/เสียงวิ่งตรงไม่ผ่านพร็อกซีของ Fly)
server.on('upgrade', (req, sock, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/keepalive') { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => {
    ws.born = Date.now();
    lastActivity = Date.now();
    ws.on('message', () => { lastActivity = Date.now(); });
    ws.on('close', () => { lastActivity = Date.now(); });
    ws.on('error', () => {});
  });
});

setInterval(() => {
  for (const ws of wss.clients) if (Date.now() - ws.born > MAX_WS_MS) ws.close(4000, 'session too long');
  if (wss.clients.size === 0 && Date.now() - lastActivity > IDLE_MS) {
    console.log('ไม่มีคนเล่นนานเกินกำหนด ปิดเครื่องเพื่อประหยัดค่าใช้จ่าย');
    process.exit(0); // exit 0 => Fly ไม่รีสตาร์ท และจะปลุกใหม่เมื่อมีคนเปิดลิงก์
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('เซิร์ฟเวอร์พร้อมที่พอร์ต ' + PORT);
  if (process.env.NO_BROWSER !== '1') {
    require('./launcher').start(PORT).catch((e) => { console.error('เปิดเบราว์เซอร์โฮสต์ไม่สำเร็จ:', e); process.exit(1); });
  }
});
