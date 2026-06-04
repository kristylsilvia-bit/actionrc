'use strict';

/**
 * Persistent admin config for the stream server.
 *
 * Stored as a JSON file on the Pi (the only always-on, stateful piece).
 * Holds viewer passwords (with optional expiry), privacy zones, stream
 * settings, and the admin password (stored only as a hash).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH =
  process.env.CONFIG_PATH || path.join(__dirname, 'config.local.json');

function hash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function defaultConfig() {
  // Seed the first viewer password from STREAM_PASSWORD so the stream works
  // out of the box; the admin manages the rest from the panel.
  const seed = process.env.STREAM_PASSWORD;
  const viewerPasswords = [];
  if (seed && seed !== '0') {
    viewerPasswords.push({
      id: crypto.randomUUID(),
      label: 'default',
      password: seed,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    });
  }
  return {
    adminPasswordHash: null, // null => fall back to ADMIN_PASSWORD env
    viewerPasswords,
    privacyZones: [],
    stream: {
      resolution: process.env.RESOLUTION || '1280x720',
      framerate: process.env.FRAMERATE || '15',
      quality: process.env.QUALITY || '5',
    },
  };
}

function normalize(c) {
  c = c && typeof c === 'object' ? c : {};
  if (typeof c.adminPasswordHash !== 'string') c.adminPasswordHash = null;
  c.viewerPasswords = Array.isArray(c.viewerPasswords) ? c.viewerPasswords : [];
  c.privacyZones = Array.isArray(c.privacyZones) ? c.privacyZones : [];
  c.stream = c.stream && typeof c.stream === 'object' ? c.stream : {};
  c.stream.resolution = c.stream.resolution || process.env.RESOLUTION || '1280x720';
  c.stream.framerate = c.stream.framerate || process.env.FRAMERATE || '15';
  c.stream.quality = c.stream.quality || process.env.QUALITY || '5';
  return c;
}

function load() {
  try {
    return normalize(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    const c = defaultConfig();
    save(c);
    return c;
  }
}

function save(c) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, CONFIG_PATH); // atomic-ish write
  return c;
}

function adminHash(c) {
  if (c.adminPasswordHash) return c.adminPasswordHash;
  if (process.env.ADMIN_PASSWORD) return hash(process.env.ADMIN_PASSWORD);
  return null; // admin not configured
}

function adminToken(c) {
  const h = adminHash(c);
  return h ? hash(h + ':admintoken') : null;
}

function checkAdminPassword(c, pw) {
  const h = adminHash(c);
  return !!h && !!pw && safeEqual(hash(pw), h);
}

function isActive(p) {
  if (!p.expiresAt) return true;
  const t = Date.parse(p.expiresAt);
  return !isNaN(t) && t > Date.now();
}

function checkViewerPassword(c, pw) {
  if (!pw) return false;
  return c.viewerPasswords.some((p) => isActive(p) && safeEqual(p.password, pw));
}

function sanitizePasswords(arr) {
  return arr
    .filter((p) => p && typeof p.password === 'string' && p.password.length > 0)
    .slice(0, 100)
    .map((p) => ({
      id: typeof p.id === 'string' && p.id ? p.id : crypto.randomUUID(),
      label: typeof p.label === 'string' ? p.label.slice(0, 60) : '',
      password: String(p.password).slice(0, 200),
      expiresAt:
        p.expiresAt && !isNaN(Date.parse(p.expiresAt))
          ? new Date(p.expiresAt).toISOString()
          : null,
      createdAt:
        p.createdAt && !isNaN(Date.parse(p.createdAt))
          ? p.createdAt
          : new Date().toISOString(),
    }));
}

function clamp01(n) {
  n = Number(n);
  if (isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function sanitizeZones(arr) {
  return arr
    .filter((z) => z && typeof z === 'object')
    .slice(0, 50)
    .map((z) => ({
      id: typeof z.id === 'string' && z.id ? z.id : crypto.randomUUID(),
      x: clamp01(z.x),
      y: clamp01(z.y),
      w: clamp01(z.w),
      h: clamp01(z.h),
    }))
    .filter((z) => z.w > 0.005 && z.h > 0.005);
}

// Everything the admin panel may read. Includes viewer passwords in plaintext
// (the admin needs to see/share them) but never the admin hash.
function publicConfig(c) {
  return {
    viewerPasswords: c.viewerPasswords,
    privacyZones: c.privacyZones,
    stream: c.stream,
    adminConfigured: adminHash(c) != null,
  };
}

module.exports = {
  load,
  save,
  hash,
  safeEqual,
  adminHash,
  adminToken,
  checkAdminPassword,
  checkViewerPassword,
  sanitizePasswords,
  sanitizeZones,
  publicConfig,
};
