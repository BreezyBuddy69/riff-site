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

`public/downloads/Riff-Setup.exe` does NOT need to be copied onto the server
— `server/products.js` defaults the download button to the public GitHub
Release asset (`releases/download/v1.0.0/Riff-Setup.exe`). Only put a file at
`public/downloads/Riff-Setup.exe` (gitignored) if you want to self-host it
instead; otherwise skip straight to the codes below.

`server/seed-codes.local.js` (the real, sellable codes) is committed directly
in this repo as of 2026-07-31 — it used to be gitignored and had to be copied
up separately, which was the #1 cause of "poolLoaded: false" / every code
failing with "unknown" on a fresh deploy. It comes with the `git clone` now,
nothing extra to do. **Trade-off, deliberately accepted:** this repo is
public, so these codes are visible to anyone who looks — if they leak/get
scraped, regenerate a fresh batch the same way as the previous compromise
(see git history around 2026-07-29).

This only seeds an EMPTY pool (`total === 0` in the DB on first boot) — once
codes have synced into the `riff_data` volume, this file is ignored on
redeploy and the volume stays the source of truth.

---

## Step 2 — Configure `.env`

```bash
cp .env.example .env
nano .env   # or vi
```

The app **runs without `.env`** too — but for real redemptions you need
either `server/seed-codes.local.js` present (Step 1, local/offline pool) or
one of:

- **Google Sheets sync** (`GOOGLE_SERVICE_ACCOUNT_JSON_B64` + `RIFF_SHEET_ID_1`
  + `RIFF_SHEET_ID_2`), or
- **n8n redeem webhook** (`N8N_REDEEM_WEBHOOK_URL`) — alternative to Sheets,
  if a workflow for this already exists on `n8n.halovisionai.cloud`.

If Sheets credentials ARE set but `RIFF_PRO_SHEET_ID_1` / `RIFF_PRO_TOTAL_SLOTS`
are not, the "riff-pro" pool silently never syncs (Sheets configured = local
seed is skipped entirely for every product) — either set those too, or leave
Sheets unconfigured and rely on `seed-codes.local.js` for both pools.

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
curl "https://halovisionai.cloud/riff/api/status?product=riff"
curl "https://halovisionai.cloud/riff/api/status?product=riff-pro"
```

Check `"poolLoaded"` in the last two responses — `false` means that product's
code pool is empty (nobody can redeem anything) even though the server is
"healthy". This is the actual go-live check, not just `healthz`.

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
