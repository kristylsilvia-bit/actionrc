import crypto from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Deterministic token derived from the password. The browser stores this (not
// the password) and we re-verify it on each visit. Changing STREAM_PASSWORD
// invalidates every previously issued token.
function expectedToken(secret) {
  return crypto.createHash('sha256').update(`stream:${secret}`).digest('hex');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export async function POST(request) {
  const secret = process.env.STREAM_PASSWORD;

  // No gate configured -> everything is allowed.
  if (secret === undefined || secret === '' || secret === '0') {
    return Response.json({ ok: true });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Bad request' }, { status: 400 });
  }

  const expected = expectedToken(secret);

  // Revisit: validate a stored token.
  if (typeof body.token === 'string') {
    if (safeEqual(body.token, expected)) return Response.json({ ok: true });
    return Response.json({ ok: false }, { status: 401 });
  }

  // First login: check the password and hand back a token.
  if (typeof body.password === 'string') {
    if (safeEqual(body.password, secret)) {
      return Response.json({ ok: true, token: expected });
    }
    return Response.json({ ok: false }, { status: 401 });
  }

  return Response.json({ ok: false, error: 'Bad request' }, { status: 400 });
}
