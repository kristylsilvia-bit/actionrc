import StreamView from './StreamView';

// Render per-request so STREAM_PASSWORD / NEXT_PUBLIC_STREAM_URL are read from
// the live environment rather than baked in at build time.
export const dynamic = 'force-dynamic';

const DEFAULT_STREAM_URL = 'http://104.229.7.78:2638/stream';

export default function Page() {
  const pw = process.env.STREAM_PASSWORD;

  // The gate is shown only when a real password is configured. Setting
  // STREAM_PASSWORD to "0" (or leaving it empty/unset) skips it entirely.
  const passwordRequired = pw !== undefined && pw !== '' && pw !== '0';

  const streamUrl = process.env.NEXT_PUBLIC_STREAM_URL || DEFAULT_STREAM_URL;

  return <StreamView passwordRequired={passwordRequired} streamUrl={streamUrl} />;
}
