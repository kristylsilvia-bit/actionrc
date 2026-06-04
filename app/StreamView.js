'use client';

import { useEffect, useRef, useState } from 'react';

const TOKEN_KEY = 'stream_token';

export default function StreamView({ passwordRequired, streamUrl }) {
  const [authed, setAuthed] = useState(!passwordRequired);
  const [checking, setChecking] = useState(passwordRequired);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // On revisit, validate any saved token against the server (the password
  // itself never reaches the browser, only a hash-derived token does).
  useEffect(() => {
    if (!passwordRequired) return;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setChecking(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        if (res.ok) setAuthed(true);
        else localStorage.removeItem(TOKEN_KEY);
      } catch {
        /* offline: fall through to the password form */
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [passwordRequired]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.token) {
        localStorage.setItem(TOKEN_KEY, data.token);
        setAuthed(true);
      } else {
        setError('Incorrect password');
        setPassword('');
      }
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) {
    return (
      <main className="center">
        <div className="spinner" />
      </main>
    );
  }

  if (!authed) {
    return (
      <main className="center">
        <form className="login" onSubmit={handleSubmit}>
          <h1>Private Stream</h1>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            autoComplete="current-password"
          />
          <button type="submit" disabled={submitting || !password}>
            {submitting ? '…' : 'Enter'}
          </button>
          {error ? <p className="error">{error}</p> : null}
        </form>
      </main>
    );
  }

  return <Stream streamUrl={streamUrl} />;
}

function Stream({ streamUrl }) {
  const [offline, setOffline] = useState(false);
  const [bust, setBust] = useState(0);
  const retryRef = useRef(null);

  useEffect(() => () => clearTimeout(retryRef.current), []);

  // MJPEG renders natively in an <img>. A cache-buster is appended only when we
  // need to force a reconnect after an error.
  const src = bust
    ? `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}_=${bust}`
    : streamUrl;

  function handleError() {
    setOffline(true);
    clearTimeout(retryRef.current);
    retryRef.current = setTimeout(() => {
      setOffline(false); // optimistically clear, then force a reconnect
      setBust(Date.now());
    }, 4000);
  }

  return (
    <main className="stage">
      <div className={`badge${offline ? ' offline' : ''}`}>
        <span className="dot" />
        {offline ? 'OFFLINE' : 'LIVE'}
      </div>
      <img
        className="stream"
        src={src}
        alt="Live stream"
        onError={handleError}
        onLoad={() => setOffline(false)}
      />
      {offline ? <div className="overlay">Reconnecting…</div> : null}
    </main>
  );
}
