// Transforms: markierten Text irgendwo im System per Hotkey umschreiben
// lassen ("Polish", "Prompt Engineer", eigene Presets). Wispr-Flow-Prinzip -
// funktioniert in jeder App, weil der Weg ueber Zwischenablage + Paste laeuft
// und nicht ueber App-spezifische Integrationen.
//
// Ablauf: Hotkey -> Ctrl+C (Auswahl holen) -> LLM -> Paste an dieselbe Stelle.
// Genutzt wird derselbe llm.js-Pfad wie der Cleanup, also auch derselbe
// n8n-Fallback ohne eigenen API-Key. Das Diktat-ueber-Auswahl-Umschreiben
// (D40) sitzt NICHT hier, sondern direkt in dictationRouter.js - dort nutzt
// es denselben grabSelection() aus selectionGrab.js.
const { globalShortcut } = require('electron');
const llm = require('./llm');
const store = require('./store');
const typingEngine = require('./voice/typingEngine');
const { restoreClipboard } = typingEngine;
const helper = require('./helper');
const voiceWindow = require('./voice/window');
const dictationRouter = require('./voice/dictationRouter');
const { grabSelection } = require('./voice/selectionGrab');

const ERROR_HIDE_MS = 4000;
const IDLE_HIDE_MS = 900;

let cfg = null;
let registered = [];
let busy = false;

function showBubble(phase, errorText = '') {
  voiceWindow.show({ size: phase === 'error' ? 'error' : 'normal' });
  voiceWindow.send('voice:ui-state', { kind: 'hold', phase, errorText });
}

function hideBubble(ms) {
  setTimeout(() => voiceWindow.hide(), ms);
}

// Reine Textumwandlung ohne Zwischenablage/Paste - fuer die App-Oberflaeche
// (Transform auf einen Verlaufseintrag oder eine Scratchpad-Notiz anwenden).
async function runOnText(transformId, text) {
  const t = store.transforms.find((x) => x.id === transformId);
  if (!t) return { ok: false, error: 'unknown_transform' };
  if (!text || !text.trim()) return { ok: false, error: 'empty_input' };
  const res = await llm.chat(cfg, {
    system: t.prompt,
    user: text,
    temperature: 0.4,
    maxTokens: 2048,
    timeoutMs: 20000,
  });
  return res.ok ? { ok: true, text: res.text } : { ok: false, error: res.error };
}

async function runOnSelection(transformId) {
  if (busy || dictationRouter.isActive()) return;
  const t = store.transforms.find((x) => x.id === transformId);
  if (!t) return;
  console.log(`[transforms] "${t.name}" ausgeloest`);
  busy = true;
  let prev = null;
  try {
    showBubble('thinking');
    // App mitgeben: in Terminals schickt grabSelection kein Strg+C (das
    // wuerde dort das laufende Programm abbrechen, D41).
    const fg = await helper.request('foreground', {}, 1500).catch(() => ({}));
    const grabbed = await grabSelection({ app: fg.app });
    prev = grabbed.prev;
    if (!grabbed.text) {
      // grabSelection hat die Zwischenablage ohne Auswahl schon zurueckgesetzt.
      showBubble('error', 'Kein Text markiert — erst markieren, dann Transform drücken.');
      hideBubble(ERROR_HIDE_MS);
      return;
    }

    const res = await runOnText(transformId, grabbed.text);
    if (!res.ok) {
      restoreClipboard(prev);
      showBubble('error', `Transform "${t.name}" fehlgeschlagen. Später erneut versuchen.`);
      hideBubble(ERROR_HIDE_MS);
      return;
    }

    // typeText sichert/restauriert die Zwischenablage selbst - danach steht
    // dort wieder die kopierte Auswahl, deshalb hier explizit den Original-
    // Inhalt des Nutzers zurueckschreiben.
    await typingEngine.typeText(res.text);
    setTimeout(() => restoreClipboard(prev), 700);

    showBubble('idle');
    hideBubble(IDLE_HIDE_MS);
  } catch (err) {
    console.warn('[transforms] fehlgeschlagen:', err.message);
    restoreClipboard(prev);
    showBubble('error', 'Transform fehlgeschlagen.');
    hideBubble(ERROR_HIDE_MS);
  } finally {
    busy = false;
  }
}

// Hotkeys neu setzen (beim Start und nach jeder Aenderung in der Oberflaeche).
// Rueckgabe: Liste der Transforms, deren Kombination Windows/eine andere App
// schon belegt hat - die Oberflaeche zeigt das an, statt es zu verschlucken.
function refreshShortcuts() {
  for (const acc of registered) {
    try { globalShortcut.unregister(acc); } catch {}
  }
  registered = [];
  const failed = [];
  if (!cfg || !cfg.transforms.enabled) {
    console.log('[transforms] deaktiviert - keine Hotkeys registriert');
    return failed;
  }
  for (const t of store.transforms) {
    if (!t.accelerator) continue;
    try {
      if (globalShortcut.register(t.accelerator, () => runOnSelection(t.id))) registered.push(t.accelerator);
      else failed.push({ id: t.id, name: t.name, accelerator: t.accelerator });
    } catch (err) {
      failed.push({ id: t.id, name: t.name, accelerator: t.accelerator, error: err.message });
    }
  }
  // Ein Hotkey, der sich still nicht registriert, ist genau die Fehlerart, die
  // uns hier zweimal Zeit gekostet hat (D20) - deshalb steht sie im Log.
  console.log(`[transforms] registriert: ${registered.join(', ') || 'keine'}${failed.length ? ` | belegt: ${failed.map((f) => f.accelerator).join(', ')}` : ''}`);
  return failed;
}

function init({ cfgRef }) {
  cfg = cfgRef;
  return refreshShortcuts();
}

function stop() {
  for (const acc of registered) {
    try { globalShortcut.unregister(acc); } catch {}
  }
  registered = [];
}

module.exports = { init, refreshShortcuts, runOnSelection, runOnText, stop };
