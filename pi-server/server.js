'use strict';

/**
 * Raspberry Pi MJPEG stream server.
 *
 * Captures /dev/video0 with ffmpeg and serves it as an MJPEG stream that any
 * browser can render in a plain <img> tag.
 *
 *   GET /stream  -> multipart/x-mixed-replace MJPEG stream
 *   GET /health  -> JSON status
 *   GET /        -> tiny test page
 *
 * A SINGLE ffmpeg process is started on the first viewer and shared (fanned
 * out) to every connected client. This matters because a v4l2 device like
 * /dev/video0 can usually only be opened by one process at a time, so spawning
 * one ffmpeg per viewer would fail with "device busy" on the second tab.
 * ffmpeg is stopped automatically when the last viewer disconnects.
 */

const express = require('express');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '2638', 10);
const HOST = process.env.HOST || '0.0.0.0'; // bind all interfaces -> reachable externally
const VIDEO_DEVICE = process.env.VIDEO_DEVICE || '/dev/video0';
const FRAMERATE = process.env.FRAMERATE || '15';
const RESOLUTION = process.env.RESOLUTION || '1280x720';
const QUALITY = process.env.QUALITY || '5'; // ffmpeg -q:v (2 = best, 31 = worst)
const INPUT_FORMAT = process.env.INPUT_FORMAT || ''; // e.g. "mjpeg" or "yuyv422"
const COPY = process.env.COPY === '1'; // copy native MJPEG instead of re-encoding
const LAN_IP = process.env.LAN_IP || '192.168.0.186'; // informational only
const SOURCE = (process.env.SOURCE || 'camera').toLowerCase(); // 'camera' or 'test'

const SOI = Buffer.from([0xff, 0xd8]); // JPEG "Start Of Image" marker
const BOUNDARY = 'mjpegstream';

function buildFfmpegArgs() {
  const args = ['-hide_banner', '-loglevel', 'error'];

  if (SOURCE === 'test') {
    // Synthetic moving test pattern. Lets you validate the whole pipeline
    // (server, network, frontend) before a real camera is connected.
    args.push('-f', 'lavfi', '-i', `testsrc=size=${RESOLUTION}:rate=${FRAMERATE}`);
    args.push('-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', QUALITY, '-');
    return args;
  }

  args.push('-f', 'v4l2');
  if (INPUT_FORMAT) args.push('-input_format', INPUT_FORMAT);
  args.push('-framerate', FRAMERATE, '-video_size', RESOLUTION, '-i', VIDEO_DEVICE);
  args.push('-f', 'image2pipe');
  if (COPY) {
    // No re-encode: lowest CPU, requires the camera to output MJPEG natively
    // (pair with INPUT_FORMAT=mjpeg).
    args.push('-vcodec', 'copy');
  } else {
    args.push('-vcodec', 'mjpeg', '-q:v', QUALITY);
  }
  args.push('-'); // write to stdout
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
      // End every client response so browsers reconnect (which restarts ffmpeg).
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

  /**
   * ffmpeg's image2pipe output is just complete JPEG frames concatenated back
   * to back. Each frame starts with the SOI marker (0xFFD8). We split on SOI:
   * everything from one SOI up to (but not including) the next SOI is exactly
   * one complete JPEG. 0xFFD8 never appears inside JPEG entropy data, so this
   * is reliable across ffmpeg versions.
   */
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    let start = this.buffer.indexOf(SOI);
    if (start === -1) {
      // Haven't seen a frame start yet; guard against unbounded growth.
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

    // Keep the trailing partial frame for the next chunk.
    this.buffer = this.buffer.subarray(start);
  }

  broadcast(frame) {
    const header = Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Type: image/jpeg\r\n` +
        `Content-Length: ${frame.length}\r\n\r\n`
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

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    source: SOURCE,
    streaming: broadcaster.streaming,
    clients: broadcaster.clients.size,
    frames: broadcaster.frames,
    device: SOURCE === 'test' ? 'testsrc' : VIDEO_DEVICE,
    resolution: RESOLUTION,
    framerate: FRAMERATE,
    lanIp: LAN_IP,
    port: PORT,
    uptime: Math.round(process.uptime()),
    lastError: broadcaster.lastError,
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

// Minimal self-test page, handy when you hit the Pi directly.
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
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down`);
  broadcaster.stop();
  server.close(() => process.exit(0));
  // Don't hang forever if a socket is stuck.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
