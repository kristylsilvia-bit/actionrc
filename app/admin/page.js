'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { piBase, streamUrl } from '../lib/pi';
import { useContainRect } from '../lib/contain';

const PI = piBase();
const STREAM = streamUrl();
const TOKEN_KEY = 'admin_token';

export default function AdminPage() {
  const [token, setToken] = useState(null);
  const [ready, setReady] = useState(false);

  // Validate any saved admin token on load (kept in sessionStorage: survives
  // reloads, cleared when the tab closes).
  useEffect(() => {
    const t = sessionStorage.getItem(TOKEN_KEY);
    if (!t) {
      setReady(true);
      return;
    }
    let cancelled = false;
    fetch(`${PI}/admin/config`, { headers: { Authorization: `Bearer ${t}` } })
      .then((r) => {
        if (cancelled) return;
        if (r.ok) setToken(t);
        else sessionStorage.removeItem(TOKEN_KEY);
      })
      .catch(() => {})
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  function onLogin(t) {
    sessionStorage.setItem(TOKEN_KEY, t);
    setToken(t);
  }
  function onLock() {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
  }

  if (!ready)
    return (
      <main className="center">
        <div className="spinner" />
      </main>
    );
  if (!token) return <Login onLogin={onLogin} />;
  return <Dashboard token={token} onTokenChange={onLogin} onLock={onLock} />;
}

function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`${PI}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.token) onLogin(d.token);
      else setError('Incorrect admin password');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="login" onSubmit={submit}>
        <h1>Admin</h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Admin password"
          autoFocus
          autoComplete="off"
        />
        <button type="submit" disabled={busy || !password}>
          {busy ? '…' : 'Sign in'}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </form>
    </main>
  );
}

function Dashboard({ token, onTokenChange, onLock }) {
  const [config, setConfig] = useState(null);
  const [health, setHealth] = useState(null);
  const [err, setErr] = useState('');

  const authedFetch = useCallback(
    (path, opts = {}) =>
      fetch(`${PI}${path}`, {
        ...opts,
        headers: {
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${token}`,
          ...(opts.headers || {}),
        },
      }),
    [token]
  );

  const loadConfig = useCallback(async () => {
    try {
      const r = await authedFetch('/admin/config');
      if (r.ok) setConfig(await r.json());
      else if (r.status === 401) onLock();
    } catch {
      setErr('Could not reach the server.');
    }
  }, [authedFetch, onLock]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Poll health for the status panel.
  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const r = await fetch(`${PI}/health`);
        if (!stop && r.ok) setHealth(await r.json());
      } catch {
        /* ignore */
      }
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const save = useCallback(
    async (patch) => {
      const r = await authedFetch('/admin/config', {
        method: 'POST',
        body: JSON.stringify(patch),
      });
      if (r.status === 401) {
        onLock();
        return null;
      }
      const d = await r.json().catch(() => ({}));
      if (d && Array.isArray(d.viewerPasswords)) setConfig(d);
      if (d && d.token) onTokenChange(d.token); // admin password changed
      return d;
    },
    [authedFetch, onLock, onTokenChange]
  );

  if (!config)
    return (
      <main className="center">
        <div className="spinner" />
      </main>
    );

  return (
    <div className="admin">
      <header className="admin-top">
        <h1>Stream Admin</h1>
        <span className="spacer" />
        <a className="ghost-btn" href="/" target="_blank" rel="noreferrer">
          View stream ↗
        </a>
        <button className="ghost-btn" onClick={onLock}>
          Lock
        </button>
      </header>
      {err ? <p className="error">{err}</p> : null}
      <StatusPanel health={health} />
      <PasswordsPanel config={config} save={save} />
      <ZonesPanel config={config} save={save} />
      <StreamPanel config={config} save={save} authedFetch={authedFetch} />
      <AdminPwPanel save={save} />
    </div>
  );
}

function StatusPanel({ health }) {
  return (
    <section className="panel">
      <h2>Status</h2>
      {!health ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="stats">
          <Stat label="State" value={health.streaming ? '● streaming' : 'idle'} />
          <Stat label="Viewers" value={health.clients} />
          <Stat label="Source" value={health.source} />
          <Stat label="Resolution" value={health.resolution} />
          <Stat label="FPS (target)" value={health.framerate} />
          <Stat label="Frames" value={health.frames} />
          <Stat label="Uptime" value={fmtUptime(health.uptime)} />
        </div>
      )}
      {health && health.lastError ? (
        <p className="error small">last error: {health.lastError}</p>
      ) : null}
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{String(value)}</span>
    </div>
  );
}

function PasswordsPanel({ config, save }) {
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(e) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    const expiresAt = expires ? new Date(expires).toISOString() : null;
    const next = [
      ...config.viewerPasswords.map(strip),
      { label, password, expiresAt },
    ];
    await save({ viewerPasswords: next });
    setLabel('');
    setPassword('');
    setExpires('');
    setBusy(false);
  }

  async function remove(id) {
    await save({
      viewerPasswords: config.viewerPasswords.filter((p) => p.id !== id).map(strip),
    });
  }

  return (
    <section className="panel">
      <h2>Viewer passwords</h2>
      <table className="tbl">
        <thead>
          <tr>
            <th>Label</th>
            <th>Password</th>
            <th>Expires</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {config.viewerPasswords.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">
                No passwords — nobody can log in.
              </td>
            </tr>
          ) : null}
          {config.viewerPasswords.map((p) => {
            const expired =
              p.expiresAt && new Date(p.expiresAt).getTime() <= Date.now();
            return (
              <tr key={p.id} className={expired ? 'expired' : ''}>
                <td>{p.label || '—'}</td>
                <td>
                  <code>{p.password}</code>
                </td>
                <td>
                  {p.expiresAt
                    ? `${expired ? 'expired · ' : ''}${fmtDate(p.expiresAt)}`
                    : 'never'}
                </td>
                <td>
                  <button className="del" onClick={() => remove(p.id)} title="Delete">
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <form className="addrow" onSubmit={add}>
        <input
          placeholder="Label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <input
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          type="datetime-local"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          title="Expiry (optional)"
        />
        <button type="submit" disabled={busy || !password}>
          Add
        </button>
      </form>
      <p className="muted small">Leave expiry blank for a permanent password.</p>
    </section>
  );
}

function ZonesPanel({ config, save }) {
  const [zones, setZones] = useState(config.privacyZones);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setZones(config.privacyZones);
    setDirty(false);
  }, [config.privacyZones]);

  function update(next) {
    setZones(next);
    setDirty(true);
  }
  async function persist() {
    setBusy(true);
    await save({ privacyZones: zones });
    setDirty(false);
    setBusy(false);
  }

  return (
    <section className="panel">
      <h2>Privacy zones</h2>
      <p className="muted small">
        Drag on the video to add a blackout box. Saved zones are drawn over the
        stream for every viewer.
      </p>
      <ZoneEditor zones={zones} onChange={update} />
      <div className="row">
        <button onClick={persist} disabled={!dirty || busy}>
          {dirty ? 'Save zones' : 'Saved'}
        </button>
        <button
          className="ghost-btn"
          onClick={() => update([])}
          disabled={zones.length === 0}
        >
          Clear all
        </button>
        <span className="muted small">
          {zones.length} zone{zones.length === 1 ? '' : 's'}
        </span>
      </div>
    </section>
  );
}

function ZoneEditor({ zones, onChange }) {
  const stageRef = useRef(null);
  const [aspect, setAspect] = useState(16 / 9);
  const rect = useContainRect(stageRef, aspect);
  const [draft, setDraft] = useState(null);
  const dragging = useRef(null);

  function fracFromEvent(e) {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - r.left) / r.width),
      y: clamp01((e.clientY - r.top) / r.height),
    };
  }

  function onDown(e) {
    if (!rect) return;
    const p = fracFromEvent(e);
    dragging.current = p;
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
    if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onMove(e) {
    if (!dragging.current) return;
    const p = fracFromEvent(e);
    const s = dragging.current;
    setDraft({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    });
  }
  function onUp() {
    if (draft && draft.w > 0.01 && draft.h > 0.01) {
      onChange([...zones, { id: `tmp-${Date.now()}`, ...draft }]);
    }
    dragging.current = null;
    setDraft(null);
  }
  function removeZone(id) {
    onChange(zones.filter((z) => z.id !== id));
  }

  return (
    <div className="editor-stage" ref={stageRef}>
      <img
        className="editor-stream"
        src={STREAM}
        alt="stream"
        draggable={false}
        onLoad={(e) => {
          const w = e.currentTarget.naturalWidth;
          const h = e.currentTarget.naturalHeight;
          if (w && h) setAspect(w / h);
        }}
      />
      <div
        className="editor-overlay"
        style={
          rect
            ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
            : { display: 'none' }
        }
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        {zones.map((z, i) => (
          <div
            key={z.id || i}
            className="ezone"
            style={{
              left: `${z.x * 100}%`,
              top: `${z.y * 100}%`,
              width: `${z.w * 100}%`,
              height: `${z.h * 100}%`,
            }}
          >
            <button
              className="ezone-del"
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={(ev) => {
                ev.stopPropagation();
                removeZone(z.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
        {draft ? (
          <div
            className="ezone draft"
            style={{
              left: `${draft.x * 100}%`,
              top: `${draft.y * 100}%`,
              width: `${draft.w * 100}%`,
              height: `${draft.h * 100}%`,
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function StreamPanel({ config, save, authedFetch }) {
  const [resolution, setResolution] = useState(config.stream.resolution);
  const [framerate, setFramerate] = useState(config.stream.framerate);
  const [quality, setQuality] = useState(config.stream.quality);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setResolution(config.stream.resolution);
    setFramerate(config.stream.framerate);
    setQuality(config.stream.quality);
  }, [config.stream]);

  async function apply() {
    setBusy(true);
    setMsg('');
    await save({ stream: { resolution, framerate, quality } });
    setMsg('Applied — viewers reconnect automatically.');
    setBusy(false);
  }
  async function restart() {
    setBusy(true);
    setMsg('');
    const r = await authedFetch('/admin/restart', { method: 'POST' });
    setMsg(r.ok ? 'Restarted.' : 'Restart failed.');
    setBusy(false);
  }

  const resolutions = ['640x480', '1280x720', '1920x1080', config.stream.resolution].filter(
    (v, i, a) => a.indexOf(v) === i
  );

  return (
    <section className="panel">
      <h2>Stream settings</h2>
      <div className="grid2">
        <label>
          Resolution
          <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
            {resolutions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label>
          Framerate
          <input
            type="number"
            min="1"
            max="60"
            value={framerate}
            onChange={(e) => setFramerate(e.target.value)}
          />
        </label>
        <label>
          Quality (2 best – 31 worst)
          <input
            type="number"
            min="2"
            max="31"
            value={quality}
            onChange={(e) => setQuality(e.target.value)}
          />
        </label>
      </div>
      <div className="row">
        <button onClick={apply} disabled={busy}>
          Apply &amp; restart
        </button>
        <button className="ghost-btn" onClick={restart} disabled={busy}>
          Restart stream
        </button>
        {msg ? <span className="muted small">{msg}</span> : null}
      </div>
      <p className="muted small">
        Resolution/quality apply only when re-encoding (not in COPY mode).
      </p>
    </section>
  );
}

function AdminPwPanel({ save }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  async function change(e) {
    e.preventDefault();
    if (!pw || busy) return;
    if (pw !== pw2) {
      setErr('Passwords do not match');
      return;
    }
    setBusy(true);
    setErr('');
    setMsg('');
    const d = await save({ adminPassword: pw });
    if (d && d.ok) {
      setMsg('Admin password changed.');
      setPw('');
      setPw2('');
    }
    setBusy(false);
  }

  return (
    <section className="panel">
      <h2>Admin password</h2>
      <form className="grid2" onSubmit={change}>
        <label>
          New password
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label>
          Confirm
          <input
            type="password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <div className="row">
          <button type="submit" disabled={busy || !pw}>
            Change password
          </button>
          {msg ? <span className="muted small">{msg}</span> : null}
          {err ? <span className="error small">{err}</span> : null}
        </div>
      </form>
    </section>
  );
}

// ── helpers ──
function strip(p) {
  // Send only the fields the server cares about (keep id so it's stable).
  return { id: p.id, label: p.label, password: p.password, expiresAt: p.expiresAt };
}
function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
function fmtUptime(s) {
  s = Number(s) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
