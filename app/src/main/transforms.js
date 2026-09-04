// Transforms: markierten Text irgendwo im System per Hotkey umschreiben
// lassen ("Polish", "Prompt Engineer", eigene Presets). Wispr-Flow-Prinzip -
// funktioniert in jeder App, weil der Weg ueber Zwischenablage + Paste laeuft
// und nicht ueber App-spezifische Integrationen.
//
// Ablauf: Hotkey -> Ctrl+C (Auswahl holen) -> LLM -> Paste an dieselbe Stelle.
// Genutzt wird derselbe llm.js-Pfad wie der Cleanup, also auch derselbe
// n8n-Fallback ohne eigenen API-Key.
const { globalShortcut, clipboard } = require('electron');
const llm = require('./llm');
const store = require('./store');
const helper = require('./helper');
const typingEngine = require('./voice/typingEngine');
const voiceWindow = require('./voice/window');
const dictationRouter = require('./voice/dictationRouter');

// Ctrl+C ist asynchron aus unserer Sicht: die Ziel-App schreibt die Auswahl
// erst ein paar Millisekunden spaeter in die Zwischenablage. Deshalb pollen
// statt einmal blind zu warten - so ist der schnelle Fall schnell.
const COPY_POLL_MS = 60;
const COPY_POLL_TRIES = 12; // max ~720ms
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

// Der Hotkey feuert beim DRUECKEN der Haupttaste - Alt/Shift/Strg sind zu dem
// Zeitpunkt noch unten. Ein sofortiges Ctrl+C sieht die Ziel-App deshalb als
// Ctrl+Alt+Shift+C und kopiert NICHTS (real gemessen: Transform lief durch,
// Text blieb unveraendert). Also warten, bis die Finger wirklich weg sind.
// Bestenfalls-Verhalten: laeuft die Frist ab (klemmende Taste), wird es
// trotzdem versucht - schlimmstenfalls greift die "Kein Text markiert"-Meldung.
const MOD_RELEASE_TIMEOUT_MS = 2000;
const MOD_POLL_MS = 40;

async function waitForModifiersUp() {
  const deadline = Date.now() + MOD_RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // mods_state kennt kein Shift (es loest links/rechts fuer die
      // AltGr-Erkennung auf, D14) - Shift kommt separat ueber key_state.
      const [mods, shift] = await Promise.all([
        helper.request('mods_state', {}, 1500),
        helper.request('key_state', { keys: 'shift' }, 1500),
      ]);
      if (!mods.ctrlLeft && !mods.ctrlRight && !mods.altLeft && !mods.altRight && !shift.down) return true;
    } catch {
      return false; // Helper nicht erreichbar - Versuch trotzdem wagen
    }
    await new Promise((r) => setTimeout(r, MOD_POLL_MS));
  }
  return false;
}

async function grabSelection() {
  await waitForModifiersUp();
  const prev = clipboard.readText();
  // Leeren, damit ein fehlgeschlagenes Ctrl+C nicht den alten Inhalt als
  // "Auswahl" ausgibt und woanders einfuegt.
  clipboard.writeText('');
  await helper.request('keys', { keys: 'ctrl+c' });
  for (let i = 0; i < COPY_POLL_TRIES; i++) {
    await new Promise((r) => setTimeout(r, COPY_POLL_MS));
    const text = clipboard.readText();
    if (text && text.trim()) return { text, prev };
  }
  return { text: '', prev };
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
  let prevClipboard = '';
  try {
    showBubble('thinking');
    const grabbed = await grabSelection();
    prevClipboard = grabbed.prev;
    if (!grabbed.text) {
      if (prevClipboard) clipboard.writeText(prevClipboard);
      showBubble('error', 'Kein Text markiert — erst markieren, dann Transform drücken.');
      hideBubble(ERROR_HIDE_MS);
      return;
    }

    const res = await runOnText(transformId, grabbed.text);
    if (!res.ok) {
      if (prevClipboard) clipboard.writeText(prevClipboard);
      showBubble('error', `Transform "${t.name}" fehlgeschlagen. Später erneut versuchen.`);
      hideBubble(ERROR_HIDE_MS);
      return;
    }

    // typeText sichert/restauriert die Zwischenablage selbst - danach steht
    // dort wieder unser geleerter Zwischenstand, deshalb hier explizit den
    // Original-Inhalt des Nutzers zurueckschreiben.
    await typingEngine.typeText(res.text);
    setTimeout(() => {
      try { if (prevClipboard) clipboard.writeText(prevClipboard); } catch { /* Clipboard gesperrt */ }
    }, 700);

    showBubble('idle');
    hideBubble(IDLE_HIDE_MS);
  } catch (err) {
    console.warn('[transforms] fehlgeschlagen:', err.message);
    try { if (prevClipboard) clipboard.writeText(prevClipboard); } catch {}
    showBubble('error', 'Transform fehlgeschlagen.');
    hideBubble(ERROR_HIDE_MS);
  } finally {
    busy = false;
  }
}

const VOICE_EDIT_SYSTEM_PROMPT = 'Rewrite the given text by exactly following the spoken instruction. '
  + 'Keep the original language unless the instruction explicitly asks for another one. '
  + 'Output only the rewritten text, no commentary, no quotes around it.';

// Auswahl + gesprochene Anweisung sind da - LLM-Call + Zurueckschreiben, exakt
// der zweite Teil von runOnSelection() oben, nur mit gesprochenem statt festem
// Prompt. Eigene Funktion statt Inline-Callback, damit runVoiceEdit() unten
// nicht durch verschachtelte try/finally unlesbar wird.
async function processVoiceEdit(instruction, selectedText, prevClipboard) {
  if (!instruction || !instruction.trim()) {
    if (prevClipboard) clipboard.writeText(prevClipboard);
    voiceWindow.hide();
    return;
  }
  showBubble('thinking');
  const res = await llm.chat(cfg, {
    system: VOICE_EDIT_SYSTEM_PROMPT,
    user: `Anweisung: ${instruction}\n\nText:\n${selectedText}`,
    temperature: 0.4,
    maxTokens: 2048,
    timeoutMs: 20000,
  });
  if (!res.ok) {
    if (prevClipboard) clipboard.writeText(prevClipboard);
    showBubble('error', 'Voice Edit fehlgeschlagen. Später erneut versuchen.');
    hideBubble(ERROR_HIDE_MS);
    return;
  }
  await typingEngine.typeText(res.text);
  setTimeout(() => {
    try { if (prevClipboard) clipboard.writeText(prevClipboard); } catch { /* Zwischenablage gesperrt */ }
  }, 700);
  showBubble('idle');
  hideBubble(IDLE_HIDE_MS);
}

// Voice Edit: Auswahl greifen (wie runOnSelection), dann per dictationRouters
// dritter Session-Art eine gesprochene Anweisung aufnehmen ("kürzer", "auf
// Englisch", "förmlicher") und damit die Auswahl umschreiben - Wispr-Flow-
// Edit-Pendant zu den Presets oben, nur mit frei gesprochener statt fest
// hinterlegter Anweisung. Zweiter Hotkey-Druck (oder Enter/Leertaste) beendet
// die Aufnahme, siehe dictationRouter.js Mode C.
async function runVoiceEdit() {
  if (dictationRouter.getKind() === 'voice-edit') { dictationRouter.endVoiceEdit(); return; }
  if (busy || dictationRouter.isActive()) return;
  busy = true;
  showBubble('thinking');
  const grabbed = await grabSelection();
  if (!grabbed.text) {
    if (grabbed.prev) clipboard.writeText(grabbed.prev);
    showBubble('error', 'Kein Text markiert — erst markieren, dann Voice Edit drücken.');
    hideBubble(ERROR_HIDE_MS);
    busy = false;
    return;
  }
  const started = dictationRouter.startVoiceEdit((instruction) => {
    processVoiceEdit(instruction, grabbed.text, grabbed.prev).finally(() => { busy = false; });
  });
  if (!started) {
    // Kein Fehlerhinweis hier: beginSession() zeigt bei Wochenlimit selbst
    // eine Bubble, bei deaktiviertem Diktieren bleibt Riff app-weit still
    // (gleiches Verhalten wie holdWatcher/toggleWatcher in diesem Fall).
    if (grabbed.prev) clipboard.writeText(grabbed.prev);
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
  // Voice Edit ist kein Eintrag in der nutzerdefinierten transforms-Liste
  // (kein fester Prompt) - eigener Accelerator aus cfg.transforms, aber
  // dieselbe Registrierung + dieselbe "belegt"-Meldung wie die Presets oben.
  const veAccel = cfg.transforms.voiceEditAccelerator;
  if (veAccel) {
    try {
      if (globalShortcut.register(veAccel, () => runVoiceEdit())) registered.push(veAccel);
      else failed.push({ id: 'voice-edit', name: 'Voice Edit', accelerator: veAccel });
    } catch (err) {
      failed.push({ id: 'voice-edit', name: 'Voice Edit', accelerator: veAccel, error: err.message });
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
