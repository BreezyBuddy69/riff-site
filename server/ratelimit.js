// Rate-Limiting für den Einlöse-Endpoint. 100 Codes sind ein kleiner Raum —
// ohne Bremse wäre der Pool per Brute-Force durchprobierbar (wenn auch bei
// ~59 Bit Entropie pro Code praktisch aussichtslos; wir bremsen trotzdem).
//
// Drei Schichten:
//   1. Pro IP: max. ATTEMPTS_PER_WINDOW Versuche in WINDOW_MS (Sliding Window)
//   2. Global: max. GLOBAL_PER_MINUTE Versuche/Minute über alle IPs
//      (gegen verteiltes Raten)
//   3. Fehlversuche antworten erst nach 400–900 ms Zufallsverzögerung
//      (macht Timing-/Enumeration-Angriffe zäh, echte Nutzer merken nichts)

"use strict";

const WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 10 * 60 * 1000);
const ATTEMPTS_PER_WINDOW = Number(process.env.RATE_ATTEMPTS_PER_WINDOW || 8);
const GLOBAL_PER_MINUTE = Number(process.env.RATE_GLOBAL_PER_MINUTE || 120);

const perIp = new Map(); // ip -> [timestamps]
let globalWindow = []; // timestamps der letzten Minute

function prune(arr, horizon) {
  const cutoff = Date.now() - horizon;
  while (arr.length && arr[0] < cutoff) arr.shift();
  return arr;
}

// Rückgabe: { allowed: true } oder { allowed: false, retryAfterSeconds }
function checkRedeemAttempt(ip) {
  const now = Date.now();

  globalWindow = prune(globalWindow, 60_000);
  if (globalWindow.length >= GLOBAL_PER_MINUTE) {
    return { allowed: false, retryAfterSeconds: 60 };
  }

  let hits = perIp.get(ip);
  if (!hits) {
    hits = [];
    perIp.set(ip, hits);
  }
  prune(hits, WINDOW_MS);
  if (hits.length >= ATTEMPTS_PER_WINDOW) {
    const retryMs = hits[0] + WINDOW_MS - now;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
  }

  hits.push(now);
  globalWindow.push(now);
  return { allowed: true };
}

// Verzögerung vor Fehler-Antworten (nicht vor Erfolgen — der zahlende
// Nutzer soll den Erfolg sofort sehen).
function failureDelay() {
  return new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 500)));
}

// Speicher-Hygiene: alte IP-Einträge regelmäßig entsorgen.
setInterval(() => {
  for (const [ip, hits] of perIp) {
    prune(hits, WINDOW_MS);
    if (hits.length === 0) perIp.delete(ip);
  }
}, 5 * 60 * 1000).unref();

module.exports = { checkRedeemAttempt, failureDelay };
