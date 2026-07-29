// Lokale SQLite-Datenbank — die Source of Truth für Code-Einlösungen.
// Google Sheets ist nur Zulieferer (Code-Pool) und Empfänger (Status-Writeback);
// entschieden wird ausschließlich hier, in einer einzigen Transaktion.
//
// node:sqlite (DatabaseSync) ist synchron und der Server läuft single-process —
// zwei gleichzeitige Redeem-Requests werden dadurch strikt serialisiert.
// Ein Doppel-Einlösen desselben Codes ist damit strukturell ausgeschlossen.

"use strict";

const { DatabaseSync } = require("node:sqlite");
const { randomBytes, createHash } = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "platform.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS codes (
    code          TEXT PRIMARY KEY,
    product       TEXT NOT NULL,
    sheet_id      TEXT,
    row_index     INTEGER,
    status        TEXT NOT NULL DEFAULT 'available'
                    CHECK (status IN ('available','redeemed')),
    redeemed_at   TEXT,
    redemption_id TEXT,
    source        TEXT NOT NULL DEFAULT 'sheet'
  );
  CREATE INDEX IF NOT EXISTS idx_codes_product ON codes (product, status);

  CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    event     TEXT NOT NULL,
    product   TEXT,
    code      TEXT,
    ip_hash   TEXT,
    detail    TEXT
  );

  CREATE TABLE IF NOT EXISTS writeback_queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT NOT NULL,
    sheet_id     TEXT NOT NULL,
    row_index    INTEGER NOT NULL,
    payload      TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    next_attempt TEXT NOT NULL,
    done         INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

const stmts = {
  getCode: db.prepare(`SELECT * FROM codes WHERE code = ? AND product = ?`),
  claimCode: db.prepare(
    `UPDATE codes SET status = 'redeemed', redeemed_at = ?, redemption_id = ?
     WHERE code = ? AND product = ? AND status = 'available'`
  ),
  insertCode: db.prepare(
    `INSERT INTO codes (code, product, sheet_id, row_index, status, redeemed_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       sheet_id = excluded.sheet_id,
       row_index = excluded.row_index
     -- Status wird bei bestehenden Codes NIE vom Sheet überschrieben:
     -- die lokale DB ist die Wahrheit, das Sheet nur der Spiegel.`
  ),
  counts: db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed
     FROM codes WHERE product = ?`
  ),
  audit: db.prepare(
    `INSERT INTO audit_log (ts, event, product, code, ip_hash, detail)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  auditTail: db.prepare(
    `SELECT ts, event, product, code, ip_hash, detail
     FROM audit_log ORDER BY id DESC LIMIT ?`
  ),
  enqueueWriteback: db.prepare(
    `INSERT INTO writeback_queue (code, sheet_id, row_index, payload, next_attempt)
     VALUES (?, ?, ?, ?, ?)`
  ),
  dueWritebacks: db.prepare(
    `SELECT * FROM writeback_queue
     WHERE done = 0 AND next_attempt <= ? ORDER BY id LIMIT 10`
  ),
  writebackDone: db.prepare(`UPDATE writeback_queue SET done = 1 WHERE id = ?`),
  writebackRetry: db.prepare(
    `UPDATE writeback_queue SET attempts = ?, next_attempt = ? WHERE id = ?`
  ),
  pendingWritebacks: db.prepare(
    `SELECT COUNT(*) AS n FROM writeback_queue WHERE done = 0`
  ),
  metaGet: db.prepare(`SELECT value FROM meta WHERE key = ?`),
  metaSet: db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ),
};

// IPs werden nie im Klartext gespeichert — nur ein mit Tagessalt gehashter
// Fingerprint für Missbrauchs-Nachvollziehbarkeit ohne PII-Hortung.
function hashIp(ip) {
  const daySalt = new Date().toISOString().slice(0, 10);
  return createHash("sha256").update(`${daySalt}|${ip}`).digest("hex").slice(0, 16);
}

function logAudit(event, { product = null, code = null, ip = null, detail = null } = {}) {
  stmts.audit.run(
    new Date().toISOString(),
    event,
    product,
    code,
    ip ? hashIp(ip) : null,
    detail ? String(detail).slice(0, 500) : null
  );
}

// Atomare Einlösung. Rückgabe:
//   { ok: true, redemptionId, redeemedAt }
//   { ok: false, reason: 'not_found' | 'already_redeemed' }
function redeemCode(product, code, ip) {
  const redemptionId = "MR-" + randomBytes(4).toString("hex").toUpperCase();
  const now = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    const row = stmts.getCode.get(code, product);
    if (!row) {
      logAudit("redeem_not_found", { product, code, ip });
      db.exec("COMMIT");
      return { ok: false, reason: "not_found" };
    }
    const claimed = stmts.claimCode.run(now, redemptionId, code, product);
    if (claimed.changes !== 1) {
      logAudit("redeem_already_redeemed", { product, code, ip });
      db.exec("COMMIT");
      return { ok: false, reason: "already_redeemed" };
    }
    logAudit("redeem_success", { product, code, ip, detail: redemptionId });
    if (row.sheet_id && row.row_index) {
      stmts.enqueueWriteback.run(
        code,
        row.sheet_id,
        row.row_index,
        JSON.stringify({ status: "REDEEMED", redeemedAt: now, redemptionId }),
        now
      );
    }
    db.exec("COMMIT");
    return { ok: true, redemptionId, redeemedAt: now };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Import aus Sheet/Seed. Neue Codes werden angelegt; bei bestehenden wird nur
// die Sheet-Position aktualisiert, nie der Einlöse-Status.
function importCode(code, product, { sheetId = null, rowIndex = null, redeemedInSheet = false, source = "sheet" } = {}) {
  stmts.insertCode.run(
    code,
    product,
    sheetId,
    rowIndex,
    redeemedInSheet ? "redeemed" : "available",
    redeemedInSheet ? new Date().toISOString() : null,
    source
  );
}

function getCounts(product) {
  const row = stmts.counts.get(product);
  return { total: row.total || 0, redeemed: row.redeemed || 0 };
}

// Generischer Zähler in `meta` — genutzt vom n8n-Redeem-Pfad, der Codes nicht
// mehr lokal speichert (die Google-Sheet-Sync via n8n ist dort die Wahrheit),
// aber der Live-Zähler auf der Landingpage trotzdem einen Stand braucht.
function getMetaCount(key) {
  const row = stmts.metaGet.get(key);
  return row ? Number(row.value) || 0 : 0;
}

function bumpMetaCount(key) {
  const next = getMetaCount(key) + 1;
  stmts.metaSet.run(key, String(next));
  return next;
}

module.exports = {
  db,
  stmts,
  redeemCode,
  importCode,
  getCounts,
  logAudit,
  hashIp,
  DATA_DIR,
  getMetaCount,
  bumpMetaCount,
};
