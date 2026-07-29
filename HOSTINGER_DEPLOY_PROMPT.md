# Deployment Prompt for Hostinger AI / Server Setup

## Task
Deploy the "Riff" sales & redemption platform as a Docker container on this
server, behind the existing Traefik reverse proxy. The site must be reachable
at: **https://halovisionai.cloud/riff**

This follows the exact same pattern as the other sites already running on
this VPS (sable, ai-company, guardian, ...) — shared Traefik on the external
`traefik-proxy` Docker network, TLS via the `letsencrypt` certresolver. No new
subdomain and no new DNS record needed — it's a path (`/riff`) on the domain
that's already routed here.

---

## Project details
- **Type:** Node.js server (zero npm dependencies), Docker multi-stage build
- **Port:** 8080 (internal container port, exposed to Traefik only — not
  published to the host)
- **Container name:** riff
- **Repo:** https://github.com/BreezyBuddy69/riff-site.git

---

## Step 1 — Get the code onto the server

```bash
git clone https://github.com/BreezyBuddy69/riff-site.git
cd riff-site
```

`public/downloads/Riff-Setup.exe` is gitignored (large binary, same call as
the other sites' installers) — copy it up separately before building:

```bash
scp Riff-Setup.exe user@vps:riff-site/public/downloads/
```

Without it, the download button 404s but the rest of the site (redemption
flow, admin) works fine — not a blocker for going live, just do it before
announcing the download link.

---

## Step 2 — Configure `.env`

```bash
cp .env.example .env
nano .env   # or vi
```

The app **runs without `.env`** too (falls back to a demo mode, see
`server/index.js`) — but for real redemptions you need at least one of:

- **Google Sheets sync** (`GOOGLE_SERVICE_ACCOUNT_JSON_B64` + `RIFF_SHEET_ID_1`
  + `RIFF_SHEET_ID_2`), or
- **n8n redeem webhook** (`N8N_REDEEM_WEBHOOK_URL`) — alternative to Sheets,
  if a workflow for this already exists on `n8n.halovisionai.cloud`.

Also set `ADMIN_TOKEN` (random, e.g. `openssl rand -hex 32`) to unlock
`GET /api/admin/audit`. Leave `TRUST_PROXY=true` — this runs behind Traefik.

---

## Step 3 — Build and start

```bash
docker compose up -d --build
docker compose ps        # "healthy" within ~15s
```

Verify locally on the server before relying on Traefik/DNS:

```bash
docker exec riff node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.text()).then(console.log)"
```

---

## Step 4 — Traefik routing

Already fully declared in `docker-compose.yml`'s `labels:` block — nothing to
configure by hand. It:
- routes `Host(halovisionai.cloud) && PathPrefix(/riff)` to this container
- redirects bare `/riff` → `/riff/` (the frontend needs the trailing slash for
  its relative asset paths)
- strips the `/riff` prefix before it reaches the Node app
- uses the existing `letsencrypt` certresolver (TLS already covers this
  domain from the other sites — no new cert needed)

Just confirm the shared network exists before `docker compose up`:

```bash
docker network ls | grep traefik-proxy
```

---

## Step 5 — Verify live

```bash
curl -I https://halovisionai.cloud/riff/
curl https://halovisionai.cloud/riff/healthz
```

---

## Updating the installer later

The site serves whatever's at `public/downloads/Riff-Setup.exe` at build
time. Rebuild the desktop app, `scp` the new `Riff-Setup.exe` over the old
one on the server, then `docker compose up -d --build` again — no other
changes needed.

## Data note

`riff_data` is a named Docker volume holding the SQLite redemption DB — the
source of truth for which codes are used. **Never** `docker compose down -v`
or otherwise remove this volume without a backup; the Google Sheets mirror
(if configured) only trails it, it isn't a substitute.
