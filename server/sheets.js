// Google-Sheets-Anbindung — zwei Sheets à 50 Codes bilden den Pool.
//
// Architektur-Entscheidung (bewusst): Die Sheets sind NICHT der Ort, an dem
// entschieden wird, ob ein Code gültig ist. Ein direktes Read-Modify-Write
// aufs Sheet wäre eine Race-Condition mit Ansage. Stattdessen:
//
//   Sheets --(Pull-Sync, periodisch)--> SQLite (Source of Truth, atomar)
//   SQLite --(Writeback-Queue, retry)--> Sheets (Status-Spiegel fürs Team)
//
// Fällt die Sheets-API aus, läuft die Einlösung unverändert weiter; nur der
// Spiegel hinkt nach und holt per Backoff-Queue auf.
//
// Auth: Service-Account-JWT (RS256), von Hand mit node:crypto signiert —
// dafür braucht es keine Dependency. Erwartetes Sheet-Layout (Tab "Codes"):
//   A: Code | B: Status | C: Eingelöst am | D: Beleg-ID
// Zeile 1 ist Kopfzeile, Codes ab Zeile 2.

"use strict";

const { createSign } = require("node:crypto");
const { stmts, importCode, logAudit } = require("./db");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_SECONDS || 300) * 1000;
const WRITEBACK_INTERVAL_MS = 30_000;

// --- Credentials -----------------------------------------------------------

function loadServiceAccount() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  if (b64) {
    try {
      return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    } catch {
      console.error("[sheets] GOOGLE_SERVICE_ACCOUNT_JSON_B64 ist kein gültiges Base64-JSON.");
      return null;
    }
  }
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (email && key) {
    // In .env-Dateien stehen Zeilenumbrüche oft als literal "\n"
    return { client_email: email, private_key: key.replace(/\\n/g, "\n") };
  }
  return null;
}

const serviceAccount = loadServiceAccount();

// --- OAuth-Token (JWT Bearer Flow) ------------------------------------------

let cachedToken = null; // { token, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const iat = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    })
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(serviceAccount.private_key).toString("base64url");
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token-Austausch fehlgeschlagen: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

async function sheetsFetch(url, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Sheets-API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

// --- Pull-Sync: Sheet -> SQLite ---------------------------------------------

async function syncProduct(product) {
  for (const sheet of product.sheets) {
    const range = encodeURIComponent(`${sheet.tab}!A2:D`);
    const data = await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/${range}`
    );
    const rows = data.values || [];
    let imported = 0;
    rows.forEach((row, i) => {
      const code = String(row[0] || "").trim().toUpperCase();
      if (!code || !product.codePattern.test(code)) return;
      importCode(code, product.slug, {
        sheetId: sheet.id,
        rowIndex: i + 2, // A2 = erste Code-Zeile
        redeemedInSheet: /^redeemed$/i.test(String(row[1] || "").trim()),
        source: "sheet",
      });
      imported++;
    });
    console.log(`[sheets] ${product.slug}: ${imported} Codes aus Sheet …${sheet.id.slice(-6)} synchronisiert.`);
  }
  stmts.metaSet.run(`last_sync:${product.slug}`, new Date().toISOString());
}

// --- Writeback-Queue: SQLite -> Sheet ----------------------------------------

async function processWritebacks(products) {
  const due = stmts.dueWritebacks.all(new Date().toISOString());
  for (const job of due) {
    const product = Object.values(products).find((p) =>
      p.sheets.some((s) => s.id === job.sheet_id)
    );
    const tab = product ? product.sheets.find((s) => s.id === job.sheet_id).tab : "Codes";
    try {
      const payload = JSON.parse(job.payload);
      const range = encodeURIComponent(`${tab}!B${job.row_index}:D${job.row_index}`);
      await sheetsFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${job.sheet_id}/values/${range}?valueInputOption=RAW`,
        {
          method: "PUT",
          body: JSON.stringify({
            values: [[payload.status, payload.redeemedAt, payload.redemptionId]],
          }),
        }
      );
      stmts.writebackDone.run(job.id);
    } catch (err) {
      // Exponentieller Backoff, max. 1 h — Job bleibt liegen, bis das Sheet
      // wieder erreichbar ist. Die Einlösung selbst ist längst abgeschlossen.
      const attempts = job.attempts + 1;
      const backoffMs = Math.min(2 ** attempts * 30_000, 3_600_000);
      stmts.writebackRetry.run(
        attempts,
        new Date(Date.now() + backoffMs).toISOString(),
        job.id
      );
      logAudit("writeback_failed", { code: job.code, detail: `Versuch ${attempts}: ${err.message}` });
      console.error(`[sheets] Writeback für ${job.code} fehlgeschlagen (Versuch ${attempts}): ${err.message}`);
    }
  }
}

// --- Öffentliche API ----------------------------------------------------------

function isConfigured() {
  return Boolean(serviceAccount);
}

function startSync(products) {
  if (!serviceAccount) {
    console.warn("[sheets] Keine Google-Credentials konfiguriert — Sync deaktiviert (lokaler Modus).");
    return;
  }
  const productsWithSheets = Object.values(products).filter((p) => p.sheets.length > 0);
  if (productsWithSheets.length === 0) {
    console.warn("[sheets] Credentials vorhanden, aber keine Sheet-IDs gesetzt — Sync deaktiviert.");
    return;
  }

  const runSync = async () => {
    for (const p of productsWithSheets) {
      try {
        await syncProduct(p);
      } catch (err) {
        // Sync-Fehler sind nicht fatal: die lokale DB bedient weiterhin
        // alle Einlösungen mit dem letzten bekannten Stand.
        logAudit("sync_failed", { product: p.slug, detail: err.message });
        console.error(`[sheets] Sync für ${p.slug} fehlgeschlagen: ${err.message}`);
      }
    }
  };

  runSync();
  setInterval(runSync, SYNC_INTERVAL_MS).unref();
  setInterval(() => processWritebacks(products).catch(() => {}), WRITEBACK_INTERVAL_MS).unref();
  console.log(`[sheets] Sync aktiv (alle ${SYNC_INTERVAL_MS / 1000}s), Writeback-Queue läuft.`);
}

function lastSyncInfo(products) {
  const info = {};
  for (const slug of Object.keys(products)) {
    const row = stmts.metaGet.get(`last_sync:${slug}`);
    info[slug] = row ? row.value : null;
  }
  return info;
}

module.exports = { startSync, isConfigured, lastSyncInfo };
