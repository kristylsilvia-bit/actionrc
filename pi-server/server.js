'use strict';

/**
 * Raspberry Pi MJPEG stream server with an admin-managed config.
 *
 *   GET  /stream         MJPEG stream (multipart/x-mixed-replace)
 *   GET  /health         public JSON status
 *   POST /auth           viewer login -> { ok, zones } (checks active passwords)
 *   POST /admin/login    admin login  -> { ok, token }
 *   GET  /admin/config   read full config (admin token required)
 *   POST /admin/config   update passwords / zones / stream / admin password
 *   POST /admin/restart  restart the capture pipeline
 *
 * A single shared ffmpeg is fanned out to all viewers (a v4l2 device can only
 * be opened once). It starts on the first viewer and stops when the last one
 * leaves. Stream settings (resolution/fps/quality) live in the config file so
 * the admin can change them at runtime.
 */

const express = require('express');
const { spawn } = require('child_process');
const cfg = require('./config');

const PORT = parseInt(process.env.PORT || '2638', 10);
const HOST = process.env.HOST || '0.0.0.0';
const VIDEO_DEVICE = process.env.VIDEO_DEVICE || '/dev/video0';
const INPUT_FORMAT = process.env.INPUT_FORMAT || '';
const COPY = process.env.COPY === '1';
const LAN_IP = process.env.LAN_IP || '192.168.0.186';
const SOURCE = (process.env.SOURCE || 'camera').toLowerCase(); // 'camera' or 'test'

const SOI = Buffer.from([0xff, 0xd8]); // JPEG Start Of Image marker
const BOUNDARY = 'mjpegstream';

let config = cfg.load();

function buildFfmpegArgs() {
  const { resolution, framerate, quality } = config.stream;
  const args = ['-hide_banner', '-loglevel', 'error'];

  if (SOURCE === 'test') {
    args.push('-f', 'lavfi', '-i', `testsrc=size=${resolution}:rate=${framerate}`);
    args.push('-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', String(quality), '-');
    return args;
  }

  args.push('-f', 'v4l2');
  if (INPUT_FORMAT) args.push('-input_format', INPUT_FORMAT);
  args.push('-framerate', String(framerate), '-video_size', resolution, '-i', VIDEO_DEVICE);
  args.push('-f', 'image2pipe');
  if (COPY) {
    args.push('-vcodec', 'copy');
  } else {
    args.push('-vcodec', 'mjpeg', '-q:v', String(quality));
  }
  args.push('-');
  return args;
}

class MjpegBroadcaster {
  constructor() {
    this.clients = new Set();
    this.ffmpeg = null;
    this.buffer = Buffer.alloc(0);
    this.frames = 0;
    this.startedAt = null;
    this.lastError = null;
  }

  get streaming() {
    return this.ffmpeg !== null;
  }

  addClient(res) {
    this.clients.add(res);
    if (!this.ffmpeg) this.start();
  }

  removeClient(res) {
    this.clients.delete(res);
    if (this.clients.size === 0) this.stop();
  }

  start() {
    const args = buildFfmpegArgs();
    console.log(`[ffmpeg] start: ffmpeg ${args.join(' ')}`);
    this.buffer = Buffer.alloc(0);
    this.frames = 0;
    this.startedAt = Date.now();
    this.lastError = null;

    const proc = spawn('ffmpeg', args);
    this.ffmpeg = proc;

    proc.stdout.on('data', (chunk) => this.onData(chunk));
    proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) {
        this.lastError = msg;
        console.error(`[ffmpeg] ${msg}`);
      }
    });
    proc.on('error', (err) => {
      this.lastError = err.message;
      console.error(`[ffmpeg] spawn error: ${err.message}`);
    });
    proc.on('close', (code, signal) => {
      console.error(`[ffmpeg] exited code=${code} signal=${signal}`);
      this.ffmpeg = null;
      this.buffer = Buffer.alloc(0);
      // End every client so browsers reconnect (which restarts ffmpeg with the
      // current settings — this is also how runtime setting changes apply).
      for (const res of this.clients) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      this.clients.clear();
    });
  }

  stop() {
    if (!this.ffmpeg) return;
    console.log('[ffmpeg] no viewers, stopping');
    try {
      this.ffmpeg.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    this.ffmpeg = null;
    this.buffer = Buffer.alloc(0);
  }

  // Apply new stream settings: if running, drop the current ffmpeg so viewers
  // reconnect and pick up the new resolution/fps/quality.
  applySettings() {
    if (this.ffmpeg) {
      try {
        this.ffmpeg.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let start = this.buffer.indexOf(SOI);
    if (start === -1) {
      if (this.buffer.length > 5 * 1024 * 1024) this.buffer = Buffer.alloc(0);
      return;
    }
    let next = this.buffer.indexOf(SOI, start + 2);
    while (next !== -1) {
      const frame = this.buffer.subarray(start, next);
      this.broadcast(frame);
      this.frames++;
      start = next;
      next = this.buffer.indexOf(SOI, start + 2);
    }
    this.buffer = this.buffer.subarray(start);
  }

  broadcast(frame) {
    const header = Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
    );
    const tail = Buffer.from('\r\n');
    for (const res of this.clients) {
      if (res.writableEnded) {
        this.clients.delete(res);
        continue;
      }
      try {
        res.write(header);
        res.write(frame);
        res.write(tail);
      } catch {
        this.clients.delete(res);
      }
    }
  }
}

const broadcaster = new MjpegBroadcaster();
const app = express();

app.use(express.json({ limit: '256kb' }));

// CORS: the browser on the Vercel origin calls /auth and /admin/* directly.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const expected = cfg.adminToken(config);
  if (expected && token && cfg.safeEqual(token, expected)) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

// ── Public ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    source: SOURCE,
    streaming: broadcaster.streaming,
    clients: broadcaster.clients.size,
    frames: broadcaster.frames,
    device: SOURCE === 'test' ? 'testsrc' : VIDEO_DEVICE,
    resolution: config.stream.resolution,
    framerate: config.stream.framerate,
    quality: config.stream.quality,
    lanIp: LAN_IP,
    port: PORT,
    uptime: Math.round(process.uptime()),
    lastError: broadcaster.lastError,
    adminConfigured: cfg.adminHash(config) != null,
    viewerPasswords: config.viewerPasswords.length,
  });
});

app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Connection: 'close',
    'Access-Control-Allow-Origin': '*',
  });
  broadcaster.addClient(res);
  req.on('close', () => broadcaster.removeClient(res));
});

app.post('/auth', (req, res) => {
  const password =
    req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (cfg.checkViewerPassword(config, password)) {
    return res.json({ ok: true, zones: config.privacyZones });
  }
  return res.status(401).json({ ok: false });
});

// ── Admin ──
app.post('/admin/login', (req, res) => {
  const password =
    req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (cfg.checkAdminPassword(config, password)) {
    return res.json({ ok: true, token: cfg.adminToken(config) });
  }
  return res.status(401).json({ ok: false });
});

app.get('/admin/config', requireAdmin, (req, res) => {
  res.json({ ok: true, ...cfg.publicConfig(config) });
});

app.post('/admin/config', requireAdmin, (req, res) => {
  const body = req.body || {};
  let streamChanged = false;
  let adminChanged = false;

  if (Array.isArray(body.viewerPasswords)) {
    config.viewerPasswords = cfg.sanitizePasswords(body.viewerPasswords);
  }
  if (Array.isArray(body.privacyZones)) {
    config.privacyZones = cfg.sanitizeZones(body.privacyZones);
  }
  if (body.stream && typeof body.stream === 'object') {
    const ns = body.stream;
    if (ns.resolution && /^\d{2,5}x\d{2,5}$/.test(String(ns.resolution))) {
      config.stream.resolution = String(ns.resolution);
    }
    if (ns.framerate && /^\d{1,3}$/.test(String(ns.framerate))) {
      config.stream.framerate = String(ns.framerate);
    }
    if (ns.quality && /^\d{1,2}$/.test(String(ns.quality))) {
      config.stream.quality = String(ns.quality);
    }
    streamChanged = true;
  }
  if (typeof body.adminPassword === 'string' && body.adminPassword.length > 0) {
    config.adminPasswordHash = cfg.hash(body.adminPassword);
    adminChanged = true;
  }

  cfg.save(config);
  if (streamChanged) broadcaster.applySettings();

  res.json({
    ok: true,
    adminChanged,
    token: adminChanged ? cfg.adminToken(config) : undefined,
    ...cfg.publicConfig(config),
  });
});

app.post('/admin/restart', requireAdmin, (req, res) => {
  broadcaster.applySettings();
  res.json({ ok: true });
});

// Tiny self-test page when you hit the Pi directly.
app.get('/', (req, res) => {
  res
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><title>Pi Stream Server</title>` +
        `<body style="background:#111;color:#eee;font-family:system-ui,sans-serif;text-align:center;padding:2rem">` +
        `<h1>Pi Stream Server</h1>` +
        `<p><a style="color:#4af" href="/stream">/stream</a> &middot; ` +
        `<a style="color:#4af" href="/health">/health</a></p>` +
        `<img src="/stream" style="max-width:100%;border-radius:8px" alt="stream">` +
        `</body>`
    );
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Pi stream server listening on http://${HOST}:${PORT}`);
  console.log(`LAN address: http://${LAN_IP}:${PORT}  (stream: /stream, health: /health)`);
  if (cfg.adminHash(config) == null) {
    console.warn('[admin] No admin password set. Set ADMIN_PASSWORD to use /admin.');
  }
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down`);
  broadcaster.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
