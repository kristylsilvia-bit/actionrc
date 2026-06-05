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

  return <Stream streamUrl={STREAM} zones={zones} pi={PI} />;
}

function Stream({ streamUrl, zones, pi }) {
  const stageRef = useRef(null);
  const retryRef = useRef(null);
  const [offline, setOffline] = useState(false);
  const [bust, setBust] = useState(0);
  const [aspect, setAspect] = useState(16 / 9);
  const rect = useContainRect(stageRef, aspect);

  useEffect(() => () => clearTimeout(retryRef.current), []);

  // Watchdog: an MJPEG <img> can stall silently (tunnel hiccup, dropped socket,
  // overloaded Pi) without firing onError. Poll /health and force a reconnect
  // when the server is unreachable, idle (our socket died), or producing no new
  // frames. Also drives the OFFLINE badge.
  useEffect(() => {
    let stop = false;
    let prevFrames = null;
    let lastAdvance = Date.now();
    let lastReconnect = 0;
    let idle = 0;
    let reachable = true;
    function reconnect() {
      const now = Date.now();
      if (now - lastReconnect < 8000) return; // cooldown so we never loop
      lastReconnect = now;
      setOffline(false);
      setBust(now);
    }
    async function tick() {
      try {
        const r = await fetch(`${pi}/health`, { cache: 'no-store' });
        if (stop) return;
        if (!r.ok) throw new Error('health');
        const h = await r.json();
        if (!reachable) {
          reachable = true;
          reconnect();
          return;
        }
        if (h.frames !== prevFrames) {
          prevFrames = h.frames;
          lastAdvance = Date.now();
        }
        if (!h.streaming) {
          idle += 1;
          if (idle >= 2) reconnect(); // our connection isn't registered server-side
          return;
        }
        idle = 0;
        if (Date.now() - lastAdvance > 8000) reconnect(); // streaming but no new frames
      } catch {
        if (stop) return;
        reachable = false;
        idle = 0;
        setOffline(true);
      }
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [pi]);

  const src = bust
    ? `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}_=${bust}`
    : streamUrl;

  function handleError() {
    setOffline(true);
    clearTimeout(retryRef.current);
    retryRef.current = setTimeout(() => {
      setOffline(false);
      setBust(Date.now());
    }, 1500);
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
