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

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']; // Sun..Sat
const DOW_FULL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const DEFAULT_SCHEDULE = { days: [1, 2, 3, 4, 5], start: '08:00', end: '16:30' };

function PasswordsPanel({ config, save }) {
  const tz = config.timezone || 'local';
  const [rows, setRows] = useState(config.viewerPasswords);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [expires, setExpires] = useState('');

  useEffect(() => {
    setRows(config.viewerPasswords);
    setDirty(false);
  }, [config.viewerPasswords]);

  async function persist(list) {
    setBusy(true);
    await save({ viewerPasswords: list.map(strip) });
    setBusy(false);
  }

  // Immediate single-click actions (mode toggle, add, delete). Each persists
  // the whole current list, so any pending schedule edits are committed too.
  async function setMode(id, mode) {
    const next = rows.map((p) => (p.id === id ? { ...p, mode } : p));
    setRows(next);
    await persist(next);
  }
  async function remove(id) {
    const next = rows.filter((p) => p.id !== id);
    setRows(next);
    await persist(next);
  }
  async function add(e) {
    e.preventDefault();
    if (!password || busy) return;
    const next = [
      ...rows,
      {
        id: `tmp-${Date.now()}`,
        label,
        password,
        mode: 'auto',
        schedule: null,
        expiresAt: expires ? new Date(expires).toISOString() : null,
      },
    ];
    setLabel('');
    setPassword('');
    setExpires('');
    await persist(next);
  }

  // Staged schedule edits: update locally, commit with the button.
  function edit(id, patch) {
    setRows((rs) => rs.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    setDirty(true);
  }
  async function saveChanges() {
    await persist(rows);
    setDirty(false);
  }

  return (
    <section className="panel">
      <h2>Viewer passwords</h2>
      <p className="muted small">
        Mode: <b>Auto</b> follows the schedule · <b>On</b> = always active ·{' '}
        <b>Off</b> = disabled (kept, not deleted). Schedule times use the Pi&apos;s
        timezone ({tz}).
      </p>
      <div className="pw-list">
        {rows.length === 0 ? (
          <p className="muted">No passwords — nobody can log in.</p>
        ) : null}
        {rows.map((p) => (
          <PasswordCard key={p.id} p={p} onMode={setMode} onRemove={remove} onEdit={edit} />
        ))}
      </div>
      {dirty ? (
        <div className="row">
          <button onClick={saveChanges} disabled={busy}>
            Save schedule changes
          </button>
          <span className="muted small">unsaved schedule edits</span>
        </div>
      ) : null}
      <form className="addrow" onSubmit={add}>
        <input
          placeholder="Label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <input
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          type="datetime-local"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          title="Hard expiry (optional)"
        />
        <button type="submit" disabled={busy || !password}>
          Add
        </button>
      </form>
      <p className="muted small">
        Expiry is a one-time hard cutoff; schedules recur weekly.
      </p>
    </section>
  );
}

function PasswordCard({ p, onMode, onRemove, onEdit }) {
  const sched = p.schedule;

  function toggleDay(d) {
    const base = sched || DEFAULT_SCHEDULE;
    const days = base.days.includes(d)
      ? base.days.filter((x) => x !== d)
      : [...base.days, d].sort();
    onEdit(p.id, { schedule: { ...base, days } });
  }
  function setTime(field, val) {
    const base = sched || DEFAULT_SCHEDULE;
    onEdit(p.id, { schedule: { ...base, [field]: val } });
  }

  return (
    <div className={`pw-card${p.active ? '' : ' off'}`}>
      <div className="pw-head">
        <span className={`pill ${p.active ? 'on' : 'off'}`}>
          {p.active ? 'Active' : 'Inactive'}
        </span>
        <strong>{p.label || '—'}</strong>
        <code>{p.password}</code>
        <span className="spacer" />
        {p.expiresAt ? (
          <span className="muted small">expires {fmtDate(p.expiresAt)}</span>
        ) : null}
        <button className="del" title="Delete" onClick={() => onRemove(p.id)}>
          ✕
        </button>
      </div>

      <div className="pw-controls">
        <div className="seg">
          {['auto', 'on', 'off'].map((m) => (
            <button
              key={m}
              className={p.mode === m ? 'active' : ''}
              onClick={() => onMode(p.id, m)}
            >
              {m === 'auto' ? 'Auto' : m === 'on' ? 'On' : 'Off'}
            </button>
          ))}
        </div>
        {p.mode === 'on' ? <span className="muted small">always active</span> : null}
        {p.mode === 'off' ? <span className="muted small">disabled</span> : null}
      </div>

      {p.mode === 'auto' ? (
        <div className="pw-sched">
          {sched ? (
            <>
              <div className="days">
                {DOW.map((lab, d) => (
                  <button
                    key={d}
                    className={sched.days.includes(d) ? 'on' : ''}
                    onClick={() => toggleDay(d)}
                    title={DOW_FULL[d]}
                  >
                    {lab}
                  </button>
                ))}
              </div>
              <label className="t">
                from
                <input
                  type="time"
                  value={sched.start}
                  onChange={(e) => setTime('start', e.target.value)}
                />
              </label>
              <label className="t">
                to
                <input
                  type="time"
                  value={sched.end}
                  onChange={(e) => setTime('end', e.target.value)}
                />
              </label>
              <button
                className="ghost-btn small-btn"
                onClick={() => onEdit(p.id, { schedule: null })}
              >
                Remove schedule
              </button>
            </>
          ) : (
            <button
              className="ghost-btn small-btn"
              onClick={() => onEdit(p.id, { schedule: { ...DEFAULT_SCHEDULE } })}
            >
              + Add schedule (always on without one)
            </button>
          )}
        </div>
      ) : null}
    </div>
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
  return {
    id: p.id,
    label: p.label,
    password: p.password,
    mode: p.mode,
    schedule: p.schedule,
    expiresAt: p.expiresAt,
  };
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
