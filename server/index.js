// Riff Sales & Redemption Platform — HTTP-Server.
// Fork von websites/sable/server/index.js (Struktur/Sicherheitsmechanik
// unverändert, nur Produkt-Defaults ausgetauscht - siehe DEFAULT_PRODUCT).
//
// Bewusst ohne Dependencies (kein Express, kein Framework): die Angriffs-
// und Wartungsfläche eines Launch-kritischen Systems soll klein sein, das
// Docker-Image winzig, der Start instantan. Statische Dateien werden beim
// Start einmal in den Speicher geladen und gzip-vorkomprimiert ausgeliefert.

"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const zlib = require("node:zlib");
const { timingSafeEqual } = require("node:crypto");

const { stmts, redeemCode, importCode, getCounts, logAudit, getMetaCount, bumpMetaCount } = require("./db");
const { PRODUCTS, getProduct, publicProducts } = require("./products");
const { checkRedeemAttempt, failureDelay } = require("./ratelimit");
const sheets = require("./sheets");
const SEED_CODES = require("./seed-codes");

const DEFAULT_PRODUCT = "riff";

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const N8N_REDEEM_WEBHOOK_URL = process.env.N8N_REDEEM_WEBHOOK_URL || "";
const startedAt = Date.now();

// --- n8n-Redeem-Pfad -----------------------------------------------------------
// Alternative zum lokalen SQLite-Sheets-Sync (sheets.js): ein n8n-Workflow prüft
// den Code direkt gegen ein Google Sheet und markiert ihn dort als eingelöst
// (Sheet ist hier die Wahrheit, nicht die lokale DB). Nur aktiv, wenn die Env-Var
// gesetzt ist — sonst läuft unverändert der bisherige lokale/Sheets-Sync-Pfad.
async function redeemViaN8n(product, code, ip) {
  let res;
  try {
    res = await fetch(N8N_REDEEM_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product, code }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    logAudit("redeem_error", { product, code, ip, detail: `n8n unreachable: ${err.message}` });
    return { ok: false, reason: "server_error" };
  }

  const data = await res.json().catch(() => null);
  // Nur eine Antwort, die exakt unserem Vertrag entspricht (HTTP 2xx + boolesches
  // "ok"), gilt als echte Geschäftslogik-Antwort. Alles andere (z. B. n8n gibt
  // 404 zurück, weil der Workflow nicht aktiv ist) ist ein Server-/Config-Fehler
  // — und darf dem Nutzer nie fälschlich als "Code unbekannt" angezeigt werden.
  if (!res.ok || !data || typeof data.ok !== "boolean") {
    logAudit("redeem_error", {
      product,
      code,
      ip,
      detail: `n8n unerwartete Antwort (HTTP ${res.status}): ${JSON.stringify(data).slice(0, 200)}`,
    });
    return { ok: false, reason: "server_error" };
  }

  if (data.ok) {
    bumpMetaCount(`n8n_redeemed:${product}`);
    logAudit("redeem_success", { product, code, ip, detail: data.redemptionId });
    return {
      ok: true,
      redemptionId: data.redemptionId,
      redeemedAt: data.redeemedAt || new Date().toISOString(),
    };
  }

  const KNOWN_REASONS = new Set(["not_found", "already_redeemed"]);
  const reason = KNOWN_REASONS.has(data.reason) ? data.reason : "server_error";
  logAudit(
    reason === "already_redeemed"
      ? "redeem_already_redeemed"
      : reason === "not_found"
      ? "redeem_not_found"
      : "redeem_error",
    { product, code, ip, detail: reason === "server_error" ? `n8n unbekannter reason: ${data.reason}` : undefined }
  );
  return { ok: false, reason };
}

// --- Statische Dateien (in-memory, vorkomprimiert) ---------------------------

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const staticCache = new Map(); // urlPath -> { body, gzip, type, immutable }
function loadStatic(dir, prefix = "") {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const urlPath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      // downloads/ wird bewusst NICHT in den In-Memory-Cache geladen: das
      // sind grosse Release-Binaries (zig/hundert MB), kein Landingpage-
      // Asset - die werden gestreamt (siehe handleDownload), sonst blaeht
      // ein einzelnes ZIP den RSS jedes Serverstarts auf.
      if (urlPath === "/downloads") continue;
      loadStatic(full, urlPath);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!MIME[ext]) continue;
    const body = fs.readFileSync(full);
    const compressible = /^text\/|json|svg|javascript/.test(MIME[ext]);
    staticCache.set(urlPath, {
      body,
      gzip: compressible ? zlib.gzipSync(body, { level: 9 }) : null,
      type: MIME[ext],
      immutable: urlPath.startsWith("/assets/"),
    });
  }
}
loadStatic(PUBLIC_DIR);
staticCache.set("/", staticCache.get("/index.html"));

// --- Downloads (gestreamt, nicht im In-Memory-Cache) --------------------------

const DOWNLOADS_DIR = path.join(PUBLIC_DIR, "downloads");
const DOWNLOAD_MIME = { ".zip": "application/zip", ".exe": "application/vnd.microsoft.portable-executable" };

function handleDownload(req, res, urlPath) {
  const name = urlPath.slice("/downloads/".length);
  // Kein Encoded-Slash/Traversal: nur ein einzelnes Datei-Segment ohne "..".
  if (!name || name.includes("/") || name.includes("..")) {
    res.writeHead(404);
    return res.end();
  }
  const ext = path.extname(name).toLowerCase();
  const mime = DOWNLOAD_MIME[ext];
  const full = path.join(DOWNLOADS_DIR, name);
  if (!mime || !full.startsWith(DOWNLOADS_DIR) || !fs.existsSync(full)) {
    res.writeHead(404);
    return res.end();
  }
  const stat = fs.statSync(full);
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "public, max-age=3600",
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(full).pipe(res);
}

// --- Helpers -----------------------------------------------------------------

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return String(fwd).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function securityHeaders(res) {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (TRUST_PROXY) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function sendJson(req, res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function safeTokenEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Status-Antworten kurz cachen (Zähler steht auf der Landingpage — der
// Endpoint darf unter Last nicht pro Pageview die DB zählen lassen).
const statusCache = new Map(); // slug -> { at, payload }
function productStatus(slug) {
  const cached = statusCache.get(slug);
  if (cached && Date.now() - cached.at < 5000) return cached.payload;
  const product = getProduct(slug);
  const { total, redeemed } = N8N_REDEEM_WEBHOOK_URL
    ? { total: product.totalSlots, redeemed: getMetaCount(`n8n_redeemed:${slug}`) }
    : getCounts(slug);
  const payload = {
    product: slug,
    totalSlots: product.totalSlots,
    // "vergeben" zählt nur echte Einlösungen — nie erfunden. Solange noch
    // keine Codes importiert sind, melden wir das ehrlich als "unbekannt".
    poolLoaded: total > 0,
    redeemed,
    remaining: total > 0 ? Math.max(0, total - redeemed) : null,
  };
  statusCache.set(slug, { at: Date.now(), payload });
  return payload;
}

// --- Routen --------------------------------------------------------------------

async function handleRedeem(req, res) {
  const ip = clientIp(req);
  const gate = checkRedeemAttempt(ip);
  if (!gate.allowed) {
    logAudit("redeem_rate_limited", { ip });
    return sendJson(req, res, 429, {
      ok: false,
      reason: "rate_limited",
      retryAfterSeconds: gate.retryAfterSeconds,
    }, { "Retry-After": String(gate.retryAfterSeconds) });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    await failureDelay();
    return sendJson(req, res, 400, { ok: false, reason: "invalid_request" });
  }

  const product = getProduct(String(body.product || DEFAULT_PRODUCT));
  if (!product || product.status !== "available") {
    await failureDelay();
    return sendJson(req, res, 404, { ok: false, reason: "unknown_product" });
  }

  const code = String(body.code || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!product.codePattern.test(code)) {
    await failureDelay();
    return sendJson(req, res, 422, { ok: false, reason: "invalid_format" });
  }

  let result;
  try {
    result = N8N_REDEEM_WEBHOOK_URL
      ? await redeemViaN8n(product.slug, code, ip)
      : redeemCode(product.slug, code, ip);
  } catch (err) {
    console.error("[redeem] DB-Fehler:", err);
    logAudit("redeem_error", { product: product.slug, ip, detail: err.message });
    return sendJson(req, res, 500, { ok: false, reason: "server_error" });
  }

  statusCache.delete(product.slug);

  if (!result.ok) {
    await failureDelay();
    const status = result.reason === "not_found" ? 404 : 409;
    return sendJson(req, res, status, { ok: false, reason: result.reason });
  }

  return sendJson(req, res, 200, {
    ok: true,
    redemptionId: result.redemptionId,
    redeemedAt: result.redeemedAt,
    delivery: {
      type: product.delivery.type,
      platforms: product.delivery.platforms,
    },
    status: productStatus(product.slug),
  });
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    if (p === "/healthz") {
      let dbOk = true;
      try {
        stmts.pendingWritebacks.get();
      } catch {
        dbOk = false;
      }
      return sendJson(req, res, dbOk ? 200 : 503, {
        ok: dbOk,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        sheetsConfigured: sheets.isConfigured(),
        n8nConfigured: Boolean(N8N_REDEEM_WEBHOOK_URL),
        lastSync: sheets.lastSyncInfo(PRODUCTS),
        pendingWritebacks: dbOk ? stmts.pendingWritebacks.get().n : null,
      });
    }

    if (p === "/api/products" && (req.method === "GET" || req.method === "HEAD")) {
      return sendJson(req, res, 200, { products: publicProducts() });
    }

    if (p === "/api/status" && (req.method === "GET" || req.method === "HEAD")) {
      const slug = url.searchParams.get("product") || DEFAULT_PRODUCT;
      if (!getProduct(slug)) return sendJson(req, res, 404, { ok: false, reason: "unknown_product" });
      return sendJson(req, res, 200, productStatus(slug));
    }

    if (p === "/api/redeem" && req.method === "POST") {
      return await handleRedeem(req, res);
    }

    if (p === "/api/admin/audit" && req.method === "GET") {
      if (!ADMIN_TOKEN) return sendJson(req, res, 404, { ok: false });
      const auth = String(req.headers.authorization || "");
      if (!auth.startsWith("Bearer ") || !safeTokenEqual(auth.slice(7), ADMIN_TOKEN)) {
        return sendJson(req, res, 401, { ok: false, reason: "unauthorized" });
      }
      return sendJson(req, res, 200, { entries: stmts.auditTail.all(200) });
    }

    if (p.startsWith("/downloads/") && (req.method === "GET" || req.method === "HEAD")) {
      return handleDownload(req, res, p);
    }

    // Statische Dateien
    if (req.method === "GET" || req.method === "HEAD") {
      const file = staticCache.get(p);
      if (file) {
        const headers = {
          "Content-Type": file.type,
          "Cache-Control": file.immutable
            ? "public, max-age=31536000, immutable"
            : "public, max-age=300",
          Vary: "Accept-Encoding",
        };
        const acceptsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
        const body = file.gzip && acceptsGzip ? file.gzip : file.body;
        if (file.gzip && acceptsGzip) headers["Content-Encoding"] = "gzip";
        headers["Content-Length"] = body.length;
        res.writeHead(200, headers);
        return res.end(req.method === "HEAD" ? undefined : body);
      }
    }

    // Unbekannte Pfade: zurück zur Landingpage (Single-Purpose-Seite)
    res.writeHead(302, { Location: "/" });
    return res.end();
  } catch (err) {
    console.error("[server] Unerwarteter Fehler:", err);
    return sendJson(req, res, 500, { ok: false, reason: "server_error" });
  }
});

// --- Lokaler Modus / Seed -------------------------------------------------------
// Ohne Google-Sheets-Credentials (Standardfall, siehe server/seed-codes.js)
// wird der fest im Repo verankerte Code-Pool importiert, sobald die lokale DB
// für das Produkt leer ist. Das macht den Redeem-Flow unabhängig von externer
// .env/Sheets/n8n-Konfiguration — ein "Ordner löschen + neu klonen"-Deploy
// reicht, die echten 100 Codes sind sofort wieder da.

// Seedet ALLE Produkte in SEED_CODES (nicht nur DEFAULT_PRODUCT) - seit dem
// zweiten Code-Pool "riff-pro" (Pro-Freischaltung, eingeloest in der App statt
// auf der Website, siehe products.js) braucht auch der einen lokalen Seed-Pfad.
function seedCodesIfEmpty() {
  if (sheets.isConfigured()) return;
  for (const product of Object.keys(SEED_CODES)) {
    const { total } = getCounts(product);
    if (total > 0) continue;
    const codes = SEED_CODES[product] || [];
    for (const code of codes) importCode(code, product, { source: "seed" });
    console.log(`[seed] ${codes.length} Codes für "${product}" aus server/seed-codes.js importiert (kein Sheets konfiguriert).`);
  }
}

seedCodesIfEmpty();
sheets.startSync(PRODUCTS);

server.listen(PORT, HOST, () => {
  console.log(`Riff-Plattform läuft auf http://${HOST}:${PORT} (Sheets: ${sheets.isConfigured() ? "aktiv" : "lokaler Modus"})`);
});

// Sauberes Herunterfahren (Docker SIGTERM)
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
