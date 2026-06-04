'use client';

import { useEffect, useRef, useState } from 'react';
import { piBase, streamUrl } from './lib/pi';
import { useContainRect } from './lib/contain';

export default function StreamView() {
  const PI = piBase();
  const STREAM = streamUrl();
  const [authed, setAuthed] = useState(false);
  const [zones, setZones] = useState([]);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`${PI}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setZones(Array.isArray(data.zones) ? data.zones : []);
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
            autoComplete="off"
          />
          <button type="submit" disabled={submitting || !password}>
            {submitting ? '…' : 'Enter'}
          </button>
          {error ? <p className="error">{error}</p> : null}
        </form>
      </main>
    );
  }

  return <Stream streamUrl={STREAM} zones={zones} />;
}

function Stream({ streamUrl, zones }) {
  const stageRef = useRef(null);
  const retryRef = useRef(null);
  const [offline, setOffline] = useState(false);
  const [bust, setBust] = useState(0);
  const [aspect, setAspect] = useState(16 / 9);
  const rect = useContainRect(stageRef, aspect);

  useEffect(() => () => clearTimeout(retryRef.current), []);

  const src = bust
    ? `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}_=${bust}`
    : streamUrl;

  function handleError() {
    setOffline(true);
    clearTimeout(retryRef.current);
    retryRef.current = setTimeout(() => {
      setOffline(false);
      setBust(Date.now());
    }, 4000);
  }

  function handleLoad(e) {
    setOffline(false);
    const w = e.currentTarget.naturalWidth;
    const h = e.currentTarget.naturalHeight;
    if (w && h) setAspect(w / h);
  }

  return (
    <main className="stage" ref={stageRef}>
      <div className={`badge${offline ? ' offline' : ''}`}>
        <span className="dot" />
        {offline ? 'OFFLINE' : 'LIVE'}
      </div>
      <img
        className="stream"
        src={src}
        alt="Live stream"
        onError={handleError}
        onLoad={handleLoad}
      />
      {rect && zones.length > 0 ? (
        <div
          className="zones"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }}
        >
          {zones.map((z, i) => (
            <div
              key={z.id || i}
              className="zone"
              style={{
                left: `${z.x * 100}%`,
                top: `${z.y * 100}%`,
                width: `${z.w * 100}%`,
                height: `${z.h * 100}%`,
              }}
            />
          ))}
        </div>
      ) : null}
      {offline ? <div className="overlay">Reconnecting…</div> : null}
    </main>
  );
}
