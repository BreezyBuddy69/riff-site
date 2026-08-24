// Toggle-Watcher (Mode B, Master-Prompt §6.1 in websites/riff-MASTER-
// PROMPT.md): erkennt EINEN kurzen Druck der konfigurierten Kombination
// (Default Strg+Alt+D) und meldet genau ein Ereignis (onTap) - ob das eine
// Session startet oder beendet, entscheidet der Aufrufer (dictationRouter
// kennt den Session-Zustand, dieser Watcher nicht).
//
// Frueher brauchte es zwei Taps innerhalb von 400ms. Nutzer-Feedback
// (2026-08-24): "Strg+Alt+D drücken, die Bubble soll bleiben, nochmal drücken
// beendet" - der Doppel-Tap wurde in der Praxis nie zuverlaessig getroffen
// und die Kombination hat stattdessen die Hold-Session (Strg+Alt) angetriggert.
// Ein Einzel-Tap ist hier gefahrlos, weil die Toggle-Kombination anders als
// flowHold eine echte Haupttaste enthaelt.
//
// Gleiches Polling-Prinzip wie holdWatcher.js (GetAsyncKeyState ueber den
// Helper), aber Kanten- statt Level-Auswertung: ein langes Halten darf NIE als
// Tap zaehlen - sonst kaeme sich Mode A (halten) mit Mode B in die Quere.
const helper = require('../helper');

const TAP_MAX_MS = 600;   // laenger gehalten = kein Tap mehr. War 220ms - zu knapp fuer eine bewusst gedrueckte Dreier-Kombi (Nutzer-Feedback: "tut nichts")
const POLL_IDLE_MS = 20;  // war 80ms - gleicher Latenz-Fix wie holdWatcher.js, s. dort
const POLL_ACTIVE_MS = 30;

let cfg = null;
let onTap = null;

let timer = null;
let downSince = 0;  // 0 = Kombination ist oben
let suspended = false;
let lastAccel = '';
let helperKeys = '';

function keysFor() {
  const accel = (cfg.hotkeys.flowToggle || '').trim();
  if (accel !== lastAccel) {
    lastAccel = accel;
    helperKeys = accel.toLowerCase().replace(/control/g, 'ctrl').replace(/\s+/g, '');
  }
  return helperKeys;
}

async function poll() {
  if (suspended || !cfg || !cfg.voice.enabled) { reset(); schedule(POLL_IDLE_MS); return; }
  const keys = keysFor();
  if (!keys) { reset(); schedule(POLL_IDLE_MS); return; }

  let down = false;
  try {
    const r = await helper.request('key_state', { keys }, 1500);
    down = !!r.down;
  } catch {
    schedule(POLL_ACTIVE_MS);
    return;
  }

  const now = Date.now();
  if (down && !downSince) {
    downSince = now; // steigende Flanke
  } else if (!down && downSince) {
    const heldMs = now - downSince;
    downSince = 0;
    if (heldMs <= TAP_MAX_MS && onTap) onTap();
  }

  schedule(down ? POLL_ACTIVE_MS : POLL_IDLE_MS);
}

function reset() {
  downSince = 0;
}

function schedule(ms) {
  timer = setTimeout(poll, ms);
}

function start({ cfgRef, onTap: cb }) {
  cfg = cfgRef;
  onTap = cb;
  if (!timer) schedule(POLL_IDLE_MS);
}

function stop() {
  if (timer) { clearTimeout(timer); timer = null; }
  reset();
}

function setSuspended(on) {
  suspended = !!on;
  if (suspended) reset();
}

module.exports = { start, stop, setSuspended };
