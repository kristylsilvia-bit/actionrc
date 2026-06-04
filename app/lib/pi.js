// Stream + Pi API base, derived from the public stream URL.
const DEFAULT = 'http://104.229.7.78:2638/stream';

export function streamUrl() {
  return process.env.NEXT_PUBLIC_STREAM_URL || DEFAULT;
}

// The Pi's origin (everything before /stream) — where /auth and /admin/* live.
export function piBase() {
  return streamUrl().replace(/\/stream\/?$/, '');
}
