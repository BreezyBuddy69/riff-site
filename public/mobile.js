/* Riff am Handy (D41): tippen, sprechen, tippen - Text erscheint, wird
   kopiert, kann geteilt werden. Aufnahme per MediaRecorder (iPhone liefert
   mp4, Android webm), im Browser zu 16-kHz-WAV umgewandelt: der Server und
   der bestehende n8n-Webhook kennen dann nur ein einziges Format. */

"use strict";

const $ = (id) => document.getElementById(id);
const micBtn = $("mic");
const meter = $("meter");
const statusEl = $("status");
const out = $("out");
const copyBtn = $("copy");
const shareBtn = $("share");
const clearBtn = $("clear");

const STORE_KEY = "riff-mobile-text";
const MAX_MS = 90_000;        // Server nimmt max. ~90 s (4 MB) an
const MUTE_PEAK = 0.0005;     // darunter liefert das Mikro keinen echten Ton
const QUIET_PEAK = 0.02;      // darunter wurde nichts Verstaendliches gesagt

let rec = null;
let chunks = [];
let stream = null;
let ctx = null;
let raf = 0;
let maxTimer = 0;
let startedAt = 0;
let peak = 0;
let metered = false; // hat die Pegelmessung wirklich laufen koennen?

const ERRORS = {
  rate_limited: "Kurz durchatmen: zu viele Aufnahmen hintereinander. Gleich nochmal.",
  daily_limit: "Das Tageskontingent ist aufgebraucht. Morgen geht es weiter.",
  too_long: "Zu lang für eine Aufnahme. Maximal 90 Sekunden am Stück.",
  invalid_audio: "Die Aufnahme konnte nicht gelesen werden. Nochmal versuchen.",
  stt_failed: "Die Erkennung hat gerade nicht geklappt. Nochmal versuchen.",
};

try { out.value = localStorage.getItem(STORE_KEY) || ""; } catch { /* privater Modus */ }
function save() { try { localStorage.setItem(STORE_KEY, out.value); } catch { /* egal */ } }
out.addEventListener("input", save);

function setStatus(text, tone = "") {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function setState(state) {
  document.body.dataset.state = state;
  const listening = state === "listening";
  micBtn.setAttribute("aria-pressed", String(listening));
  micBtn.setAttribute("aria-label", listening ? "Aufnahme beenden" : "Aufnahme starten");
  micBtn.disabled = state === "thinking";
}

async function start() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setStatus("Dieser Browser kann nicht aufnehmen. Öffne die Seite in Safari oder Chrome.", "error");
    return;
  }
  // AudioContext noch INNERHALB des Tipps anlegen: iPhone startet ihn sonst
  // "suspended", der Pegel bliebe 0 und Riff hielte das Mikro fuer stumm.
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume().catch(() => {});
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    setStatus(err && err.name === "NotAllowedError"
      ? "Kein Mikrofon-Zugriff. Erlaube das Mikrofon für diese Seite in den Browser-Einstellungen."
      : "Kein Mikrofon gefunden.", "error");
    ctx.close().catch(() => {});
    ctx = null;
    return;
  }

  chunks = [];
  peak = 0;
  metered = false;
  rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = finish;
  rec.start();
  startedAt = Date.now();
  setState("listening");

  // Pegel fuer den Ring und fuer die Stumm-Erkennung (wie in der Desktop-App:
  // ein stummes Mikro liefert digitale Stille, kein leises Rauschen).
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const tick = () => {
    analyser.getFloatTimeDomainData(buf);
    let p = 0;
    for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
    if (ctx.state === "running") { metered = true; peak = Math.max(peak, p); }
    meter.style.setProperty("--level", Math.min(1, p * 3).toFixed(3));
    const ms = Date.now() - startedAt;
    if (metered && ms > 1500 && peak < MUTE_PEAK) setStatus("Kein Ton vom Mikrofon. Ist es stumm geschaltet?", "warn");
    else setStatus(`Hört zu … ${Math.floor(ms / 1000)} s. Tippen zum Beenden.`);
    raf = requestAnimationFrame(tick);
  };
  tick();
  maxTimer = setTimeout(stop, MAX_MS);
}

function stop() {
  clearTimeout(maxTimer);
  cancelAnimationFrame(raf);
  meter.style.setProperty("--level", "0");
  if (rec && rec.state !== "inactive") rec.stop();
  if (stream) for (const t of stream.getTracks()) t.stop();
  if (ctx) ctx.close().catch(() => {});
  stream = null;
  ctx = null;
}

function idle() {
  setState("idle");
  rec = null;
}

async function finish() {
  const durationMs = Date.now() - startedAt;
  setState("thinking");
  setStatus("Wird erkannt …");

  if (metered && peak < MUTE_PEAK) { setStatus("Nichts aufgenommen: das Mikrofon lieferte keinen Ton. Ist es stumm geschaltet?", "warn"); idle(); return; }
  if ((metered && peak < QUIET_PEAK) || durationMs < 400) { setStatus("Nichts gehört. Sprich etwas lauter oder näher am Handy.", "warn"); idle(); return; }

  let wav;
  try {
    wav = await toWav16k(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
  } catch {
    setStatus("Die Aufnahme konnte nicht gelesen werden. Nochmal versuchen.", "error");
    idle();
    return;
  }

  try {
    const res = await fetch("api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64: wav }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setStatus(ERRORS[data.reason] || ERRORS.stt_failed, "error");
    } else if (!data.text) {
      setStatus("Nichts erkannt. Nochmal versuchen.", "warn");
    } else {
      out.value = out.value.trim() ? `${out.value.trimEnd()} ${data.text}` : data.text;
      save();
      // iPhone erlaubt Kopieren nur direkt nach einem Tipp - klappt es hier
      // nicht, reicht ein Tipp auf "Kopieren".
      const copied = await copyText(out.value);
      setStatus(copied ? "Fertig und kopiert. In jeder App einfügen." : "Fertig. Tipp auf Kopieren.", "ok");
    }
  } catch {
    setStatus("Keine Verbindung. Prüf dein Internet und versuch es nochmal.", "error");
  }
  idle();
}

// Beliebiges Aufnahmeformat -> 16 kHz Mono -> WAV (Base64).
async function toWav16k(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const decoder = new Ctx();
  const audio = await decoder.decodeAudioData(await blob.arrayBuffer());
  decoder.close().catch(() => {});
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * rate)), rate);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);

  const bytes = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function copyText(text) {
  if (!text) return false;
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

micBtn.addEventListener("click", () => {
  if (rec && rec.state === "recording") stop();
  else if (!rec) start();
});

copyBtn.addEventListener("click", async () => {
  if (!out.value.trim()) { setStatus("Noch nichts zum Kopieren."); return; }
  if (await copyText(out.value)) {
    setStatus("Kopiert. In jeder App einfügen.", "ok");
  } else {
    out.select();
    setStatus("Text ist markiert. Lange tippen und „Kopieren“ wählen.");
  }
});

if (navigator.share) {
  shareBtn.hidden = false;
  shareBtn.addEventListener("click", () => {
    if (out.value.trim()) navigator.share({ text: out.value }).catch(() => {});
  });
}

clearBtn.addEventListener("click", () => {
  out.value = "";
  save();
  setStatus("Tippen und sprechen.");
});
