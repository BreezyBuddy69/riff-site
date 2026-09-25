// Rate-Limiting, In-Memory, ohne Dependencies.
//
// Redeem: 100 Codes sind ein kleiner Raum — ohne Bremse wäre der Pool per
// Brute-Force durchprobierbar (bei ~59 Bit Entropie pro Code praktisch
// aussichtslos; wir bremsen trotzdem). Drei Schichten:
//   1. Pro IP: max. perWindow Versuche in windowMs (Sliding Window)
//   2. Global: max. globalPerMinute Versuche/Minute über alle IPs
//   3. Fehlversuche antworten erst nach 400–900 ms Zufallsverzögerung
//      (failureDelay - macht Timing-/Enumeration-Angriffe zäh)
//
// Transcribe (Handy-Web-App, D41): dasselbe Muster plus Tagesdeckel - jede
// Anfrage kostet echtes Geld beim STT-Anbieter, der Tagesdeckel begrenzt den
// schlimmsten Fall, auch wenn jemand viele IPs hat.
//
// Rückgabe: { allowed: true } oder { allowed: false, retryAfterSeconds }

"use strict";

function prune(arr, horizon) {
  const cutoff = Date.now() - horizon;
  while (arr.length && arr[0] < cutoff) arr.shift();
  return arr;
}

function makeLimiter({ windowMs, perWindow, globalPerMinute, perDay = Infinity }) {
  const perIp = new Map(); // ip -> [timestamps]
  let globalWindow = []; // timestamps der letzten Minute
  let dayKey = "";
  let dayCount = 0;

  setInterval(() => {
    for (const [ip, hits] of perIp) {
      prune(hits, windowMs);
      if (hits.length === 0) perIp.delete(ip);
    }
  }, 5 * 60 * 1000).unref();

  return function check(ip) {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== dayKey) { dayKey = today; dayCount = 0; }
    if (dayCount >= perDay) {
      const tomorrow = Date.parse(`${today}T00:00:00Z`) + 86400000;
      return { allowed: false, retryAfterSeconds: Math.ceil((tomorrow - now) / 1000), daily: true };
    }

    globalWindow = prune(globalWindow, 60_000);
    if (globalWindow.length >= globalPerMinute) {
      return { allowed: false, retryAfterSeconds: 60 };
    }

    let hits = perIp.get(ip);
    if (!hits) {
      hits = [];
      perIp.set(ip, hits);
    }
    prune(hits, windowMs);
    if (hits.length >= perWindow) {
      const retryMs = hits[0] + windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
    }

    hits.push(now);
    globalWindow.push(now);
    dayCount++;
    return { allowed: true };
  };
}

const checkRedeemAttempt = makeLimiter({
  windowMs: Number(process.env.RATE_WINDOW_MS || 10 * 60 * 1000),
  perWindow: Number(process.env.RATE_ATTEMPTS_PER_WINDOW || 8),
  globalPerMinute: Number(process.env.RATE_GLOBAL_PER_MINUTE || 120),
});

// ~40 Diktate in 10 Minuten reichen fuer echtes Tippen-Ersetzen am Handy.
const checkTranscribe = makeLimiter({
  windowMs: 10 * 60 * 1000,
  perWindow: Number(process.env.STT_PER_10MIN || 40),
  globalPerMinute: Number(process.env.STT_GLOBAL_PER_MINUTE || 60),
  perDay: Number(process.env.STT_DAILY_CAP || 2000),
});

function failureDelay() {
  return new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 500)));
}

module.exports = { checkRedeemAttempt, checkTranscribe, failureDelay };
