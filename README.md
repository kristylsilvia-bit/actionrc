# Webcam Stream

A two-part live webcam setup:

- **Pi stream server** — Node.js + ffmpeg on a Raspberry Pi, captures `/dev/video0`
  and serves it as an MJPEG stream on port `2638`. Runs permanently via pm2.
- **Vercel frontend** — a single-page Next.js app with a dark, minimal UI that
  shows the stream full-screen with a `LIVE` badge, behind an optional password.

```
┌──────────────────────┐        MJPEG over HTTP        ┌────────────────────────┐
│  Browser (viewer)    │  ───────────────────────────▶ │  Pi @ 104.229.7.78:2638 │
│  Vercel page <img/>  │    GET /stream                │  (LAN 192.168.0.186)    │
│                      │                               │  ffmpeg /dev/video0     │
└──────────────────────┘                               └────────────────────────┘
         ▲
         │  HTTPS  (the page itself is served by Vercel)
         │
┌──────────────────────┐
│  Vercel (Next.js)    │
│  password gate +     │
│  /api/auth           │
└──────────────────────┘
```

The `<img>` points straight at the Pi (`NEXT_PUBLIC_STREAM_URL`); video never
flows through Vercel.

---

## Repository layout

```
.
├── app/                  # Next.js frontend (App Router)
│   ├── api/auth/route.js #   server-side password check (password stays server-side)
│   ├── page.js           #   decides whether to show the gate
│   ├── StreamView.js     #   gate + stream UI (client component)
│   ├── layout.js
│   └── globals.css
├── pi-server/            # Raspberry Pi stream server
│   ├── server.js
│   └── package.json
├── pm2.config.js         # pm2 process config for the Pi
├── vercel.json
├── .env.example
└── README.md
```

---

## Part 1 — Pi stream server

### Prerequisites

- A Raspberry Pi with a camera exposed at `/dev/video0` (USB webcam or the CSI
  camera via `bcm2835-v4l2`). Confirm with `ls /dev/video*` and
  `v4l2-ctl --list-formats-ext -d /dev/video0`.
- Node.js 18+ and ffmpeg:

  ```bash
  sudo apt update
  sudo apt install -y ffmpeg
  node -v   # should be >= 18
  npm i -g pm2
  ```

### Install & run

From the repo root **on the Pi**:

```bash
cd pi-server
npm install
cd ..

pm2 start pm2.config.js   # starts "pi-stream-server"
pm2 save                  # persist the process list
pm2 startup               # run the command it prints to start pm2 on boot
```

Check it locally on the Pi:

```bash
curl http://localhost:2638/health
# {"status":"ok","streaming":false,...}
xdg-open http://localhost:2638/        # or open the stream in a browser
```

Useful pm2 commands: `pm2 logs pi-stream-server`, `pm2 restart pi-stream-server`,
`pm2 stop pi-stream-server`.

### Endpoints

| Route     | Description                                              |
| --------- | ------------------------------------------------------- |
| `/stream` | MJPEG stream (`multipart/x-mixed-replace`)              |
| `/health` | JSON: streaming state, viewer count, frames, last error |
| `/`       | Tiny built-in test page                                 |

### Configuration (env vars, set in `pm2.config.js`)

| Var            | Default           | Notes                                                       |
| -------------- | ----------------- | ---------------------------------------------------------- |
| `HOST`         | `0.0.0.0`         | Bind address. `0.0.0.0` = reachable on every interface.    |
| `PORT`         | `2638`            | Listen port.                                               |
| `VIDEO_DEVICE` | `/dev/video0`     | Capture device.                                            |
| `RESOLUTION`   | `1280x720`        | `WIDTHxHEIGHT`.                                            |
| `FRAMERATE`    | `15`              | Lower it if the Pi's CPU is maxed out.                     |
| `QUALITY`      | `5`               | ffmpeg `-q:v` (2 = best … 31 = worst).                     |
| `INPUT_FORMAT` | _(unset)_         | e.g. `mjpeg` to request the camera's native MJPEG.         |
| `COPY`         | _(unset)_         | `1` = stream native MJPEG without re-encoding (low CPU).   |
| `LAN_IP`       | `192.168.0.186`   | Informational; reported by `/health`.                      |

**Low-CPU tip:** if `v4l2-ctl --list-formats-ext` shows the camera supports MJPEG,
set `INPUT_FORMAT=mjpeg` and `COPY=1` in `pm2.config.js` to skip re-encoding.

### Test without a camera

Set `SOURCE=test` to serve a synthetic moving test pattern instead of the
camera — handy for validating the server, network, and frontend before any
hardware is connected. Switch back to `SOURCE=camera` (the default) for the
real device. Requires ffmpeg but no `/dev/video0`.

### Binding vs. the internal IP

The server binds to `0.0.0.0` so it answers on the LAN address
`192.168.0.186:2638` **and** externally. To reach it from the internet, forward
the public IP/port to the Pi on your router:

```
104.229.7.78:2638  ──▶  192.168.0.186:2638
```

`LAN_IP` in `pm2.config.js` is only used for the `/health` readout. Set `HOST`
to `192.168.0.186` if you instead want to restrict the server to the LAN.

### One camera, many viewers

`/dev/video0` can typically only be opened by one process. The server therefore
runs a **single** ffmpeg and fans the frames out to every connected viewer; it
starts on the first viewer and stops when the last one disconnects.

---

## Part 2 — Vercel frontend

### Local development

```bash
npm install
cp .env.example .env.local   # then edit values
npm run dev                  # http://localhost:3000
```

### Deploy to Vercel

```bash
npm i -g vercel
vercel        # first run links/creates the project
vercel --prod # production deploy
```

The Next.js app is at the repository root, so Vercel auto-detects it — no Root
Directory change needed. The `pi-server/` folder is excluded via `.vercelignore`.

### Environment variables (Vercel dashboard)

Set these under **Project → Settings → Environment Variables**, then redeploy:

| Var                      | Example                              | Purpose                                    |
| ------------------------ | ------------------------------------ | ------------------------------------------ |
| `STREAM_PASSWORD`        | `hunter2`                            | Password gate (see below).                 |
| `NEXT_PUBLIC_STREAM_URL` | `http://104.229.7.78:2638/stream`    | Stream URL the browser loads.              |

`NEXT_PUBLIC_STREAM_URL` is embedded into the client at build time — change it
and **redeploy** for it to take effect.

### Password behaviour

- `STREAM_PASSWORD=0` (or empty/unset): **no gate** — the stream shows
  immediately, no prompt.
- `STREAM_PASSWORD=anything-else`: a password screen appears first. A wrong
  password shows an error. A correct one unlocks the stream for that view only —
  the prompt reappears on **every** page load and reload (auth is not persisted).

The password is only ever checked **server-side** in `app/api/auth/route.js`; it
is never shipped to the browser, and nothing is stored in the browser.

> **Scope of the gate:** this protects the *page*. The Pi's `/stream` URL is
> itself public, so anyone who knows it can open it directly. For a real lock,
> put the Pi behind auth at the network edge (see below).

---

## HTTPS / mixed content (important)

Vercel serves the page over **HTTPS**, but the default stream URL is plain
**HTTP**. Browsers treat an `http://` image on an `https://` page as mixed
content and may block or fail to upgrade it — the most common reason the stream
shows up blank.

Pick one:

1. **Put TLS in front of the Pi (recommended).** Use a
   [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
   or a reverse proxy (Caddy/nginx) so the stream is reachable at an
   `https://…/stream` URL, then set `NEXT_PUBLIC_STREAM_URL` to that. A tunnel
   also removes the need for router port-forwarding.
2. **Serve the frontend over HTTP too** (e.g. run `npm run start` on the same
   LAN). Fine for a home setup, not for a public Vercel deploy.

A Cloudflare Tunnel is the simplest path to a clean `https://` stream URL and
also hides the Pi's home IP.

---

## Troubleshooting

| Symptom                                   | Likely cause / fix                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Blank stream on the Vercel page           | Mixed content — see the HTTPS section. Test the raw stream URL in a browser first.  |
| `/health` shows a `lastError` about v4l2  | Wrong device, unsupported `RESOLUTION`/`FRAMERATE`, or device busy. Check formats.  |
| Second viewer breaks the first            | Should not happen (single shared ffmpeg). Confirm you're on this `server.js`.       |
| High CPU on the Pi                         | Lower `FRAMERATE`/`RESOLUTION`, or use `INPUT_FORMAT=mjpeg` + `COPY=1`.             |
| Stream works on LAN but not externally    | Router port-forward `2638` → `192.168.0.186`, and check the ISP/firewall.          |
| Password never asked                      | `STREAM_PASSWORD` is `0`, empty, or unset. Set a real value and redeploy.           |
