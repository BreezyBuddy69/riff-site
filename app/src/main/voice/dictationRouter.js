// DictationRouter: Zustandsmaschine fuer Riffs EINEN Job - Diktat. Getrimmte
// Fassung von Sable2s router.js (websites/riff-MASTER-PROMPT.md §5/§11):
// kein Assistent-Modus, kein Weckwort, keine Bubble-im-Chat/Hologramm/TTS -
// nur Aufnahme -> Transkript -> Cleanup -> Format-Tokens -> Paste, fuer
// GENAU EINEN aktiven Session-Typ zur Zeit (Mode A "hold" oder Mode B
// "toggle").
//
// Wichtiger Unterschied zu Sable2: WEDER Hold- NOCH Toggle-Sessions enden
// ueber VAD-Sprechpausen (Master-Prompt §6.1) - Hold endet ausschliesslich
// per Loslassen, Toggle ausschliesslich per erneutem Druck, Enter/Leertaste
// oder Klick auf die Haken/Kreuz-Icons der Bubble. Eine kurze Sprechpause
// mitten im Satz darf eine Aufnahme nie beenden.
//
// D41 (2026-09-24, "schneller + merkt, wenn das Mikro stumm ist"):
// - Voice-Edit-Auswahlcheck laeuft PARALLEL zur Spracherkennung statt danach
//   (vorher ~350ms obendrauf bei jedem Diktat).
// - Lange Diktate werden an Sprechpausen in Stuecken schon waehrend des
//   Sprechens transkribiert (silenceFilter.shouldCutSegment).
// - Digital leerer Mikro-Stream -> Hinweis in der Bubble, Klick hilft direkt.
// - Erkennung fehlgeschlagen -> zweite Route, danach "klicken zum Wiederholen"
//   (Audio bleibt im Speicher, ein Diktat geht nicht mehr verloren).
const { globalShortcut, shell } = require('electron');
const speechRecognition = require('./speechRecognition');
const transcriptCleanup = require('./transcriptCleanup');
const dictationEngine = require('./dictationEngine');
const typingEngine = require('./typingEngine');
const voiceWindow = require('./window');
const { grabSelection } = require('./selectionGrab');
const license = require('../license');
const store = require('../store');
const insights = require('../insights');
const appContext = require('../appContext');
const appWindow = require('../appWindow');
const helper = require('../helper');
const llm = require('../llm');
const {
  isSilence, isSpeech, stripHallucination, trimSilence, isDigitalSilence, micHintFor,
  shouldCutSegment, joinSegments, HALLUCINATION_SILENCE_MS, MUTE_DETECT_MS,
} = require('./silenceFilter');

// Voice Edit (D40, Nutzerwunsch 2026-09-04): kein eigener Hotkey - ist nach
// dem Stoppen einer normalen Diktier-Session (Hold ODER Toggle) im selben
// Feld/derselben App etwas markiert, gilt das gerade Diktierte als Anweisung
// dafuer statt als einzufuegender Text. Ctrl+C-Grab erst nach dem Stoppen,
// nie waehrend die Hotkey-Modifier noch gehalten werden (selectionGrab.js
// wartet auf das Loslassen).
const VOICE_EDIT_SYSTEM_PROMPT = 'Rewrite the given text by exactly following the spoken instruction. '
  + 'Keep the original language unless the instruction explicitly asks for another one. '
  + 'Output only the rewritten text, no commentary, no quotes around it.';

const SAMPLE_RATE = 16000; // Whisper-Standard
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000; // Int16 mono
// Harte Obergrenze fuer EINE Aufnahme (uebernommen aus Sable2 D28) - ohne die
// laeuft eine Aufnahme unbegrenzt weiter, wenn eine klemmende Taste oder ein
// vergessener Toggle-Modus niemand sie beendet. Nutzerwunsch 2026-08-24:
// 10 statt 5 Minuten.
const MAX_CAPTURE_MS = 10 * 60 * 1000;
// Zweiter Notausstieg fuer den Toggle-Modus (Nutzerwunsch 2026-08-24): wer den
// zweiten Tastendruck vergisst, soll nicht bis zum 10-Minuten-Cap aufnehmen.
// Bewusst DEUTLICH laenger als eine Sprechpause - eine Minute ohne jeden
// Ton ist keine Pause mehr, da laeuft die Aufnahme ins Leere.
const SILENCE_STOP_MS = 60 * 1000;
// Nutzerwunsch: fuehlte sich traege an ("wartet 5 Sek zum Wegfaden") - war
// vorher 1400ms. Der Timer laeuft erst NACH dem Paste.
const IDLE_HIDE_MS = 700;
const ERROR_HIDE_MS = 6000;
// Fehler mit "klicken zum Wiederholen" bleiben laenger stehen - man muss
// Zeit haben, hinzuklicken.
const RETRY_HIDE_MS = 15000;
// Kuerzer als das ist ein versehentlicher Tastendruck, kein Diktat - dafuer
// keinen "Nichts gehoert"-Hinweis einblenden.
const NOTHING_HEARD_MIN_MS = 700;
// Wie lange finish() nach "stop-capture" auf die letzten Audio-Puffer aus dem
// Renderer wartet (Worklet-Rest, sonst fehlt die letzte Silbe).
const CAPTURE_FLUSH_WAIT_MS = 150;
// Nutzerwunsch: der zweite Netzwerk-Roundtrip (Cleanup-LLM) kostet spuerbare
// Latenz und lohnt sich bei kurzen Aeusserungen kaum - Schwelle in Schritten
// angehoben: 3 -> 25 -> 100 -> 300 Woerter (~1min Diktat).
const SKIP_CLEANUP_MAX_WORDS = 300;

let cfg = null;

let kind = null;       // 'hold' | 'toggle' | null (keine aktive Session)
let phase = 'idle';    // 'idle' | 'listening' | 'thinking' | 'error' | 'resting'
let capturing = false; // nimmt Audio an (bis der Renderer den Rest geliefert hat)
let pcmChunks = [];    // ganze Aufnahme (fuer Stille-Check + Wiederholen)
let pendingChunks = []; // seit dem letzten Stueck-Schnitt
let pendingMs = 0;
let segmentJobs = [];  // laufende Stueck-Transkriptionen dieser Session
let lastSegmentText = '';
let silentRunMs = 0;
let zeroRunMs = 0;     // wie lange schon digitale Stille (stummes Mikro)
let micHint = null;    // { text, action } waehrend der Aufnahme
let micCheckInFlight = false;
let notice = null;     // { text, tone, action } im Fehler-/Hinweis-Zustand
let lastFailed = null; // Aufnahme, deren Erkennung scheiterte (Wiederholen)
let hideTimer = null;
let captureCapTimer = null;
let captureStoppedResolve = null;
// Mikro schon beim Druecken der Kombination oeffnen (prepareCapture), damit
// das erste Wort nicht in den ~200ms getUserMedia + 250ms Halte-Schwelle
// verloren geht. Wird binnen PREPARE_MAX_MS keine Session daraus, zu.
let prepared = false;
let prepareTimer = null;
const PREPARE_MAX_MS = 1500;
// Session-Telemetrie fuer Verlauf/Insights (Master-Prompt §3 Synergie 2).
// sessionApp wird beim Start PARALLEL zur Aufnahme geholt - der Helper-Call
// darf nie zwischen "Taste los" und "Text steht da" liegen.
let sessionStartedAt = 0;
let firstAudioAt = 0;
let sessionApp = { app: '', title: '' };
let lastVoiceAt = 0; // letzter PCM-Chunk mit Pegel ueber der Stille-Schwelle

function isActive() { return kind !== null; }
function getKind() { return kind; }

function sendUi() {
  voiceWindow.send('voice:ui-state', {
    kind,
    phase,
    errorText: phase === 'error' && notice ? notice.text : '',
    tone: phase === 'error' && notice ? notice.tone : '',
    hint: phase === 'listening' && micHint ? micHint.text : '',
    clickable: !!((phase === 'listening' && micHint) || (phase === 'error' && notice && notice.action)),
  });
}

// Statt komplett zu verschwinden, faellt die Pille bei aktivem
// voice.idleBubbleEnabled auf den kleinen Ruhezustand zurueck (Nutzerwunsch) -
// bleibt sichtbar+klickbar, ein Klick startet ein Diktat genau wie der
// Shortcut. Ohne die Einstellung unveraendertes Verhalten: hide().
function restingOrHide() {
  notice = null;
  if (cfg.voice.idleBubbleEnabled && cfg.voice.bubbleEnabled !== false) {
    phase = 'resting';
    voiceWindow.show({ size: 'mini' });
    voiceWindow.setInteractive(true);
    sendUi();
  } else {
    voiceWindow.setInteractive(false);
    voiceWindow.hide();
  }
}

function scheduleHide(ms) {
  clearHideTimer();
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (phase === 'idle' || phase === 'error') restingOrHide();
  }, ms);
}
function clearHideTimer() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

function toIdle() {
  phase = 'idle';
  notice = null;
  sendUi();
  scheduleHide(IDLE_HIDE_MS);
}

// Eine Meldung in der grossen Bubble (Fehler, Hinweis, "Nichts gehoert").
// Mit `action` wird die Bubble klickbar (runAction entscheidet, was passiert).
function showNotice(text, { tone = 'error', action = null, ms = ERROR_HIDE_MS } = {}) {
  phase = 'error';
  notice = { text, tone, action };
  if (cfg.voice.bubbleEnabled !== false) voiceWindow.show({ size: 'error' });
  voiceWindow.setInteractive(!!action);
  sendUi();
  scheduleHide(ms);
}

function armCaptureCap() {
  clearCaptureCap();
  captureCapTimer = setTimeout(() => {
    captureCapTimer = null;
    if (!kind) return;
    console.warn(`[voice] Aufnahmelimit von ${MAX_CAPTURE_MS / 1000}s erreicht - beende Aufnahme.`);
    finish();
  }, MAX_CAPTURE_MS);
}
function clearCaptureCap() {
  if (captureCapTimer) { clearTimeout(captureCapTimer); captureCapTimer = null; }
}

// Nutzerwunsch 2026-08-24: eine laufende Toggle-Session soll auch mit Enter
// oder Leertaste enden, nicht nur ueber den Shortcut/Haken. globalShortcut
// statt Tastatur-Polling: Electron SCHLUCKT die Taste, solange sie registriert
// ist - die Leertaste landet also nicht zusaetzlich als Zeichen in der App, in
// die gleich gepastet wird. Nur waehrend einer Toggle-Session registriert,
// danach sofort wieder frei.
const STOP_ACCELERATORS = ['Return', 'Space'];

function armStopKeys() {
  for (const accel of STOP_ACCELERATORS) {
    try {
      globalShortcut.register(accel, () => { if (kind === 'toggle') finish(); });
    } catch (err) {
      console.warn(`[voice] Stopp-Taste ${accel} nicht registrierbar:`, err.message);
    }
  }
}

function disarmStopKeys() {
  for (const accel of STOP_ACCELERATORS) {
    try { globalShortcut.unregister(accel); } catch { /* war nie registriert */ }
  }
}

function resetCaptureState() {
  pcmChunks = [];
  pendingChunks = [];
  pendingMs = 0;
  segmentJobs = [];
  lastSegmentText = '';
  silentRunMs = 0;
  zeroRunMs = 0;
  micHint = null;
  micCheckInFlight = false;
}

function captureCommand() {
  return {
    type: 'start-capture',
    deviceId: cfg.voice.audioDeviceId || undefined,
    sampleRate: SAMPLE_RATE,
    noiseSuppression: cfg.voice.noiseSuppression,
  };
}

// Von holdWatcher beim ersten Druck der Kombination gerufen (nach dem
// AltGr-Check, D41) - nimmt schon auf, bevor die Halte-Schwelle erreicht ist.
// beginSession() uebernimmt das laufende Mikro samt der ersten Millisekunden.
function prepareCapture() {
  if (!cfg || !cfg.voice.enabled || kind || prepared || !license.canDictate(cfg)) return;
  prepared = true;
  capturing = true;
  resetCaptureState();
  voiceWindow.send('voice:command', captureCommand());
  prepareTimer = setTimeout(cancelPrepare, PREPARE_MAX_MS);
}

function cancelPrepare() {
  if (prepareTimer) { clearTimeout(prepareTimer); prepareTimer = null; }
  if (!prepared || kind) return;
  prepared = false;
  capturing = false;
  resetCaptureState();
  voiceWindow.send('voice:command', { type: 'stop-capture' });
}

function beginSession(newKind) {
  if (!cfg || !cfg.voice.enabled || kind) return false;
  if (!license.canDictate(cfg)) {
    cancelPrepare();
    showNotice(`Wochenlimit erreicht (${license.WEEKLY_LIMIT} Wörter). Code einlösen in den Einstellungen für unbegrenztes Diktieren.`, { action: 'settings' });
    return false;
  }
  clearHideTimer();
  console.log(`[voice] Aufnahme startet (${newKind})`);
  kind = newKind;
  phase = 'listening';
  notice = null;
  capturing = true;
  const adopt = prepared;
  if (prepareTimer) { clearTimeout(prepareTimer); prepareTimer = null; }
  prepared = false;
  if (!adopt) resetCaptureState();
  sessionStartedAt = Date.now();
  firstAudioAt = adopt && pcmChunks.length ? sessionStartedAt : 0;
  if (adopt) console.log(`[voice] Mikro lief schon (${Math.round(pcmChunks.reduce((n, c) => n + c.length, 0) / BYTES_PER_MS)}ms Vorlauf)`);
  lastVoiceAt = sessionStartedAt;
  sessionApp = { app: '', title: '' };
  // Fire-and-forget: laeuft waehrend gesprochen wird. Kommt die Antwort nicht
  // (Helper beschaeftigt/tot), bleibt der Verlaufseintrag eben ohne App-Label -
  // ein Diktat scheitert daran nie.
  helper.request('foreground', {}, 3000).then(
    (info) => { sessionApp = { app: info.app || '', title: info.title || '' }; },
    () => {},
  );
  speechRecognition.prewarm(cfg);
  armCaptureCap();
  if (newKind === 'toggle') armStopKeys();
  // Toggle-Bubble bekommt Haken/Kreuz-Icons und braucht dafuer die breitere
  // 'toggle'-Groesse + wird dafuer kurz klickbar - Hold-Bubble bleibt bei
  // 'normal' und immer click-through (Master-Prompt §6.6). bubbleEnabled
  // false (Nutzer-Feedback) zeigt sie nie - Diktat funktioniert unveraendert.
  if (cfg.voice.bubbleEnabled !== false) {
    voiceWindow.show({ size: newKind === 'toggle' ? 'toggle' : 'normal' });
    voiceWindow.setInteractive(newKind === 'toggle');
  }
  sendUi();
  playCue('start');
  if (!adopt) voiceWindow.send('voice:command', captureCommand());
  return true;
}

// Kurzer synthetischer Ton (kein Audio-Asset, siehe voice.js im Renderer) -
// Nutzer-Feedback: man soll auch ohne Blick auf die Bubble hoeren, ob Riff
// gerade zuhoert.
function playCue(cueName) {
  if (!cfg.voice.sounds.enabled) return;
  voiceWindow.send('voice:command', { type: 'play-cue', cue: cueName, volume: cfg.voice.sounds.volume });
}

// ---------- Mode A: Halten ----------
function startHold() { return beginSession('hold'); }
function endHold() { if (kind === 'hold') finish(); }

// ---------- Mode B: Einzeldruck / Maus-Bestaetigung ----------
// EIN Aufruf deckt beide Rollen ab: keine Session aktiv -> starten; eine
// Toggle-Session laeuft -> bestaetigen+verarbeiten (identisch zum
// Haken-Klick). Eine laufende HOLD-Session laesst der Toggle-Druck bewusst in
// Ruhe: sonst wuerde ein Strg+Alt+D, dessen Strg+Alt kurz vorher schon eine
// Hold-Session gestartet hat, sie sofort wieder abschicken.
function toggleFlow() {
  if (kind === 'toggle') finish();
  else beginSession('toggle');
}

// Kreuz-Klick in der Bubble - Aufnahme verwerfen, NICHT verarbeiten.
function cancelToggle() {
  if (kind !== 'toggle') return;
  cancelSession();
}

// Fremder Shortcut waehrend einer Hold-Session (holdWatcher.js: raw ohne down,
// z.B. Strg+Alt+S in irgendeiner App) - Aufnahme wegwerfen, NICHT abschicken.
function abortHold() {
  if (kind !== 'hold') return;
  cancelSession();
}

function cancelSession() {
  clearCaptureCap();
  disarmStopKeys();
  kind = null;
  capturing = false;
  resetCaptureState();
  voiceWindow.send('voice:command', { type: 'stop-capture' });
  voiceWindow.setInteractive(false);
  voiceWindow.resize('normal');
  toIdle();
}

// ---------- Stummes Mikro ----------
async function checkMic() {
  micCheckInFlight = true;
  let state = {};
  try { state = await helper.request('mic_state', {}, 1500); } catch { /* Mac/alter Helper: allgemeiner Hinweis */ }
  micCheckInFlight = false;
  // Waehrend der Abfrage kam doch Ton oder die Session ist vorbei.
  if (!kind || zeroRunMs < MUTE_DETECT_MS) return;
  micHint = micHintFor(state);
  console.warn(`[voice] Kein Ton vom Mikrofon (${JSON.stringify(state)}) - Hinweis: ${micHint.action}`);
  voiceWindow.resize('error');
  voiceWindow.setInteractive(true);
  sendUi();
}

function clearMicHint() {
  micHint = null;
  voiceWindow.resize(kind === 'toggle' ? 'toggle' : 'normal');
  voiceWindow.setInteractive(kind === 'toggle');
  sendUi();
}

function onPcmChunk(buf) {
  if (!capturing) return;
  const chunk = Buffer.from(buf);
  if (!chunk.length) return;
  if (!firstAudioAt) {
    firstAudioAt = Date.now();
    console.log(`[voice] erstes Audio ${firstAudioAt - sessionStartedAt}ms nach Tastendruck`);
  }
  pcmChunks.push(chunk);
  pendingChunks.push(chunk);
  const chunkMs = chunk.length / BYTES_PER_MS;
  pendingMs += chunkMs;
  if (!kind) return; // Nachzuegler nach dem Stopp: nur einsammeln

  if (isDigitalSilence(chunk)) {
    zeroRunMs += chunkMs;
    if (zeroRunMs >= MUTE_DETECT_MS && !micHint && !micCheckInFlight) checkMic();
  } else {
    zeroRunMs = 0;
    if (micHint) clearMicHint();
  }

  // Chunks kommen ~alle 32ms (pcm-worklet.js) - der RMS-Check darauf ist die
  // billigste vorhandene Stille-Erkennung. Kein eigener Timer noetig: solange
  // das Mikrofon laeuft, kommen auch in Stille Chunks.
  if (!isSilence(chunk)) {
    lastVoiceAt = Date.now();
    silentRunMs = 0;
    return;
  }
  silentRunMs += chunkMs;
  if (Date.now() - lastVoiceAt >= SILENCE_STOP_MS) {
    console.warn(`[voice] ${SILENCE_STOP_MS / 1000}s ohne Ton - beende Aufnahme.`);
    finish();
    return;
  }
  if (shouldCutSegment(pendingMs, silentRunMs)) {
    const audio = Buffer.concat(pendingChunks);
    pendingChunks = [];
    pendingMs = 0;
    console.log(`[voice] Stueck (${Math.round(audio.length / BYTES_PER_MS / 1000)}s) wird schon im Hintergrund erkannt`);
    segmentJobs.push(transcribeSegment(audio));
  }
}

// VAD-Events werden bewusst NICHT zum Sessionende genutzt (siehe Datei-
// Kommentar oben). Bleibt als No-Op-Hook stehen, weil main.js/preload.js das
// Ereignis ohnehin vom Renderer bekommen.
function onVadEvent() {}

// Ein Stueck Audio -> Text. Stille-only-Stuecke kosten keinen Call. Der
// Text des vorigen Stuecks reist (falls schon da) als `prompt` mit, damit
// Satzanfang/Schreibweisen am Schnitt zusammenpassen.
async function transcribeSegment(buf) {
  if (!isSpeech(buf, SAMPLE_RATE)) return { ok: true, text: '', trailingSilenceMs: 0 };
  const { audio, trailingSilenceMs } = trimSilence(buf, SAMPLE_RATE);
  const prompt = [speechRecognition.vocabularyPrompt(store.dictionary), lastSegmentText.slice(-300)]
    .filter(Boolean).join('\n') || undefined;
  const res = await speechRecognition.transcribe(cfg, audio, SAMPLE_RATE, { prompt });
  if (res.ok) lastSegmentText = res.text;
  return { ...res, trailingSilenceMs };
}

// Aufnahme im Renderer stoppen und auf die letzten Puffer warten (Worklet-
// Rest). Der Renderer meldet 'voice:capture-stopped', spaetestens nach
// CAPTURE_FLUSH_WAIT_MS geht es ohne weiter.
function stopCaptureAndFlush() {
  voiceWindow.send('voice:command', { type: 'stop-capture' });
  return new Promise((resolve) => {
    const done = () => {
      if (captureStoppedResolve === done) captureStoppedResolve = null;
      capturing = false;
      resolve();
    };
    captureStoppedResolve = done;
    setTimeout(done, CAPTURE_FLUSH_WAIT_MS);
  });
}

function onCaptureStopped() {
  if (captureStoppedResolve) captureStoppedResolve();
}

async function finish() {
  if (!kind) return;
  clearCaptureCap();
  disarmStopKeys();
  const mode = kind;
  const releasedAt = Date.now();
  const durationMs = sessionStartedAt ? releasedAt - sessionStartedAt : 0;
  const wasMuted = zeroRunMs >= MUTE_DETECT_MS;
  const hint = micHint;
  kind = null;
  micHint = null;
  phase = 'thinking';
  voiceWindow.setInteractive(false);
  voiceWindow.resize('normal'); // Haken/Kreuz sind ab hier weg
  sendUi();
  playCue('end');
  await stopCaptureAndFlush();
  const flushedAt = Date.now();

  const buf = Buffer.concat(pcmChunks);
  const tail = Buffer.concat(pendingChunks);
  const jobs = segmentJobs;
  const app = { ...sessionApp };
  resetCaptureState();

  if (!isSpeech(buf, SAMPLE_RATE)) {
    if (wasMuted) {
      const h = hint || micHintFor({});
      showNotice(h.text, { tone: 'warn', action: h.action, ms: RETRY_HIDE_MS });
    } else if (durationMs >= NOTHING_HEARD_MIN_MS) {
      showNotice('Nichts gehört. Sprich etwas lauter oder näher am Mikro.', { tone: 'info', ms: 2500 });
    } else {
      toIdle();
    }
    return;
  }

  // Voice-Edit-Check (D40) PARALLEL zur Erkennung (D41) - der Strg+C-Weg
  // braucht ~350ms, die Erkennung laenger; so steht er nie mehr auf der Uhr.
  const selectionPromise = grabSelection({ timeoutMs: 300, app: app.app })
    .catch((err) => { console.warn('[voice] Auswahl-Check fehlgeschlagen:', err.message); return { text: '', prev: null }; });
  const results = await Promise.all([...jobs, transcribeSegment(tail)]);
  const selection = await selectionPromise;

  const failed = results.find((r) => !r.ok);
  if (failed) {
    if (selection.text) typingEngine.restoreClipboard(selection.prev);
    console.warn(`[voice] Spracherkennung fehlgeschlagen: ${failed.error}`);
    lastFailed = { audio: buf, mode, durationMs, app };
    showNotice(failed.offline
      ? 'Keine Internetverbindung. Klick zum Wiederholen, sobald du wieder online bist.'
      : 'Spracherkennung fehlgeschlagen. Klick zum Wiederholen.', { action: 'retry', ms: RETRY_HIDE_MS });
    return;
  }

  const raw = joinSegments(results.map((r) => r.text));
  const last = results[results.length - 1];
  // Auffangnetz, falls trotz Trim eine Floskel angehaengt wurde.
  const text = stripHallucination(raw, last.trailingSilenceMs >= HALLUCINATION_SILENCE_MS);
  if (!text) {
    if (selection.text) typingEngine.restoreClipboard(selection.prev);
    toIdle();
    return;
  }
  console.log(`[voice] Text ${Date.now() - releasedAt}ms nach Loslassen erkannt (Mikro-Rest ${flushedAt - releasedAt}ms, Erkennung ${Date.now() - flushedAt}ms, ${results.length} Stueck)`);
  await deliver({ text, raw, mode, durationMs, app, selection });
}

// Klick auf "Wiederholen": dieselbe Aufnahme noch einmal am Stueck
// erkennen und an der aktuellen Cursor-Position einfuegen (die Bubble ist
// nicht fokussierbar - der Klick nimmt der Ziel-App den Fokus nicht weg).
async function retryLast() {
  const job = lastFailed;
  if (!job || kind) return;
  lastFailed = null;
  clearHideTimer();
  phase = 'thinking';
  notice = null;
  voiceWindow.setInteractive(false);
  voiceWindow.resize('normal');
  sendUi();
  const res = await transcribeSegment(job.audio);
  if (!res.ok) {
    lastFailed = job;
    showNotice(res.offline ? 'Immer noch offline. Klick zum Wiederholen.' : 'Wieder fehlgeschlagen. Klick zum Wiederholen.', { action: 'retry', ms: RETRY_HIDE_MS });
    return;
  }
  const text = stripHallucination(res.text, res.trailingSilenceMs >= HALLUCINATION_SILENCE_MS);
  if (!text) { toIdle(); return; }
  await deliver({ text, raw: res.text, mode: job.mode, durationMs: job.durationMs, app: job.app, selection: { text: '' } });
}

// Klick auf die Bubble, waehrend sie einen Hinweis/Fehler mit Aktion zeigt.
function runAction() {
  const action = (phase === 'listening' && micHint && micHint.action) || (phase === 'error' && notice && notice.action);
  if (!action) return;
  console.log(`[voice] Bubble-Aktion: ${action}`);
  if (action === 'retry') { retryLast(); return; }
  if (action === 'unmute') {
    helper.request('mic_mute', { mute: false }, 3000).then(
      () => { if (phase === 'error') showNotice('Mikrofon ist wieder an. Du kannst diktieren.', { tone: 'info', ms: 2500 }); },
      (err) => console.warn('[voice] Stummschaltung aufheben fehlgeschlagen:', err.message),
    );
    return;
  }
  if (action === 'privacy') shell.openExternal('ms-settings:privacy-microphone');
  if (action === 'settings') appWindow.show('settings');
  if (phase === 'error') restingOrHide();
}

// Text -> (Cleanup) -> Voice Edit ODER Paste -> Verlauf.
async function deliver({ text, raw, mode, durationMs, app, selection }) {
  // Kurze Aeusserungen ueberspringen die Cleanup-LLM-Runde IMMER (Nutzerwunsch
  // 2026-09-06: "ein 3-Woerter-Diktat muss instant da sein") - das
  // Woerterbuch reist ohnehin als Vokabular-Hinweis an die Transkription.
  // autoCleanup aus: Rohtranskript wird immer gepastet.
  const dictionary = store.dictionary;
  const wordCount = text.split(/\s+/).length;
  const category = appContext.categorize(app.app);
  const styles = store.styles;
  const skipCleanup = styles.autoCleanup === false || wordCount <= SKIP_CLEANUP_MAX_WORDS;
  const cleanedText = skipCleanup
    ? text
    : (await transcriptCleanup.clean(cfg, text, appContext.cleanupExtras(styles, category, dictionary, text))).text;
  license.recordWords(cfg, cleanedText);
  console.log(`[voice] Diktat fertig: "${cleanedText}"`);

  let pastedText;
  let editFailed = false;
  try {
    if (selection.text) {
      console.log(`[voice] Voice Edit auf Auswahl (${selection.text.length} Zeichen)`);
      const res = await llm.chat(cfg, {
        system: VOICE_EDIT_SYSTEM_PROMPT,
        user: `Anweisung: ${cleanedText}\n\nText:\n${selection.text}`,
        temperature: 0.4,
        maxTokens: 2048,
        timeoutMs: 20000,
      });
      if (res.ok) {
        await typingEngine.typeText(res.text);
        pastedText = res.text;
      } else {
        console.warn(`[voice] Voice Edit fehlgeschlagen (${res.error})`);
        pastedText = ''; // Auswahl bleibt unangetastet, nichts Falsches ueberschreiben
        editFailed = true;
      }
      setTimeout(() => typingEngine.restoreClipboard(selection.prev), 700);
    } else {
      pastedText = await paste(cleanedText);
    }
  } catch (err) {
    // Darf deliver() nie unbeobachtet abbrechen lassen (Bubble bliebe auf
    // 'thinking' stehen) - lieber roh pasten als nichts tun.
    console.warn('[voice] Einfuegen fehlgeschlagen, zweiter Versuch mit Rohtext:', err.message);
    pastedText = await paste(cleanedText).catch(() => '');
  }

  if (editFailed) showNotice('Voice Edit fehlgeschlagen. Später erneut versuchen.');
  else toIdle();

  // Erst NACH dem Paste protokollieren - der Verlauf darf den Hot-Path nie
  // verlaengern (Master-Prompt §2 C14).
  if (!pastedText) return;
  try {
    store.addHistory({
      mode,
      app: app.app,
      appTitle: app.title,
      appCategory: category,
      raw: raw.trim(),
      text: pastedText.trim(),
      words: (pastedText.match(/\S+/g) || []).length,
      durationMs,
      fixes: skipCleanup ? 0 : insights.countFixes(text, cleanedText),
      dictFixes: skipCleanup ? 0 : insights.countDictFixes(text, cleanedText, dictionary),
    });
    store.learnWords(cleanedText, dictionary);
    appWindow.notifyDataChanged();
  } catch (err) {
    console.warn('[voice] Verlaufseintrag fehlgeschlagen:', err.message);
  }
}

// Format-Tokens + "letzten Satz loeschen" aufloesen und aufeinanderfolgende
// Text-Ops zu EINEM String buendeln - ein einziger Paste pro Aeusserung
// (Sable2 D25, Wispr-Prinzip) statt Helper-Roundtrip pro Op.
// Gibt den tatsaechlich eingefuegten Text zurueck (mit aufgeloesten Format-
// Tokens und Snippets) - genau der gehoert in den Verlauf.
async function paste(text) {
  const ops = dictationEngine.resolveDictation(text, { snippets: store.snippets });
  let pending = '';
  let pasted = '';
  const flush = async () => {
    if (pending) { await typingEngine.typeText(pending); pasted += pending; pending = ''; }
  };
  for (const op of ops) {
    if (op.kind === 'delete-last-segment') {
      await flush();
      await typingEngine.deleteLastSegment();
    } else if (op.value) {
      pending += op.value;
    }
  }
  await flush();
  return pasted;
}

// Renderer-lokaler Fehler (z.B. getUserMedia abgelehnt).
function onLocalError(text) {
  clearCaptureCap();
  disarmStopKeys();
  kind = null;
  capturing = false;
  resetCaptureState();
  showNotice(String(text || 'Mikrofon nicht verfügbar. Klick hier, um eins zu wählen.'), { action: 'settings' });
}

function init({ cfgRef }) {
  cfg = cfgRef;
  voiceWindow.allowMicPermission();
  restingOrHide(); // zeigt beim Start sofort den Ruhezustand, falls aktiviert
}

// Wird nach settings:save gerufen (main.js) - wer idleBubbleEnabled gerade
// erst anschaltet, soll den Ruhezustand sofort sehen, nicht erst nach dem
// naechsten Diktat. Waehrend eine Session laeuft (kind gesetzt) nicht
// eingreifen, die regelt ihre Anzeige selbst zu Ende.
function syncIdleBubble() {
  if (kind) return;
  restingOrHide();
}

module.exports = {
  init, startHold, endHold, abortHold, toggleFlow, cancelToggle, prepareCapture, cancelPrepare,
  onPcmChunk, onVadEvent, onLocalError, onCaptureStopped, runAction,
  isActive, getKind, syncIdleBubble,
};
