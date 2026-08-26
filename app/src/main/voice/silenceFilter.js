// Reine Filterlogik gegen Whisper-Halluzinationen auf Nicht-Sprache (Stille,
// Atmen, Rauschen, Tastaturklicks) - kein Electron im Require-Baum, damit
// test/check.js sie wie dictationEngine.js pruefen kann. Ausgelagert aus
// dictationRouter.js (Nutzer-Feedback: "vielen dank" kam trotz bestehendem
// Filter noch durch).
const SILENCE_RMS = 300;

function isSilence(buf) {
  const n = buf.length >> 1;
  if (!n) return true;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n) < SILENCE_RMS;
}

// Zweite Verteidigungslinie GEGEN DIESELBE Ursache wie isSilence, aber mit
// einer anderen Schwaeche: eine globale RMS ueber den GESAMTEN Puffer kann ein
// kurzes Rauschen/Klick-Ereignis (wenige laute Samples in ansonsten stiller
// Aufnahme) durchlassen, weil der Mittelwert trotzdem unter der Schwelle
// bleibt ODER knapp drueber liegt, ohne dass irgendwo tatsaechlich gesprochen
// wurde. MIN_VOICED_MS verlangt zusaetzlich eine Mindestmenge an einzelnen
// "lauten" Samples (nicht nur einen hohen Mittelwert) - ein Wimpernschlag
// Rauschen faellt durch, ein kurzes echtes Wort (schon ab ~1-2 Silben) besteht.
// ponytail: feste Amplituden-Schwelle statt echter VAD - hochsetzen, falls
// legitime kurze Woerter faelschlich verworfen werden.
const MIN_VOICED_MS = 350;

function voicedMs(buf, sampleRate) {
  const n = buf.length >> 1;
  let loud = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(buf.readInt16LE(i * 2)) > SILENCE_RMS) loud++;
  }
  return (loud / sampleRate) * 1000;
}

// Aufnahme gilt als "nichts gesagt", wenn sie global zu leise ist ODER zu
// wenige tatsaechlich laute Samples enthaelt - beide Bedingungen muessen
// bestanden werden, damit ueberhaupt ein STT-Call (und dessen Kosten)
// ausgeloest wird.
function isSpeech(buf, sampleRate) {
  return buf.length > 0 && !isSilence(buf) && voicedMs(buf, sampleRate) >= MIN_VOICED_MS;
}

// Ursachen-Korrektur (Bug-Report 2026-08-26: "am Ende sagt es einfach vielen
// Dank"): Whisper halluziniert diese Floskeln auf STILLE - und die Stille
// zwischen dem letzten Wort und dem Stopp-Druck faehrt bei jedem Diktat mit.
// Wird sie gar nicht erst hochgeladen, entsteht die Halluzination nicht; die
// Phrasenliste unten bleibt nur noch Auffangnetz. Spart nebenbei Upload.
const PAD_MS = 250;   // Rand um die erkannte Sprache, damit leise An-/Auslaute nicht abschneiden
const FRAME_MS = 30;  // Fensterlaenge der Pegelmessung - glaettet einzelne Samples

// Schneidet fuehrende/abschliessende Stille weg und meldet zurueck, wie lange
// die Aufnahme am Ende schon still war (die Halluzinations-Signatur, siehe
// stripHallucination).
// ponytail: Frame-RMS, kein echtes VAD - ein Tastaturklick am Ende zaehlt als
// Sprache und bleibt stehen. Dann greift die Phrasenliste.
function trimSilence(buf, sampleRate) {
  const samples = buf.length >> 1;
  const frame = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  let first = -1;
  let last = -1;
  for (let start = 0; start < samples; start += frame) {
    const end = Math.min(start + frame, samples);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const v = buf.readInt16LE(i * 2);
      sum += v * v;
    }
    if (Math.sqrt(sum / (end - start)) >= SILENCE_RMS) {
      if (first < 0) first = start;
      last = end;
    }
  }
  // Nichts erkannt: unveraendert weiterreichen statt einen leeren Puffer zu
  // bauen - isSpeech() haette hier ohnehin schon abgebrochen.
  if (first < 0) return { audio: buf, trailingSilenceMs: 0 };
  const pad = Math.round((sampleRate * PAD_MS) / 1000);
  return {
    audio: buf.subarray(Math.max(0, first - pad) * 2, Math.min(samples, last + pad) * 2),
    trailingSilenceMs: ((samples - last) / sampleRate) * 1000,
  };
}

// Phrasen, die NIE ein echtes Diktat sind (Video-/Untertitel-Trainingsdaten) -
// die duerfen auch als angehaengter Schlusssatz mitten aus einem langen
// Transkript raus.
const NEVER_SPOKEN = new Set([
  'vielen dank fuers zuschauen', 'vielen dank fürs zuschauen', 'danke fürs zuschauen',
  'vielen dank für ihre aufmerksamkeit', 'vielen vielen dank', 'vielen dank euch',
  'untertitelung des zdf für funk', 'untertitel der amara org-community',
  'untertitel von stephanie geiges', 'untertitel im auftrag des zdf',
  'copyright wdr', 'thanks for watching', 'thank you for watching',
  'das wars für heute',
]);

// Phrasen, die als GANZES Transkript immer Halluzination sind, am Satzende
// aber echt sein koennen ("...schicken Sie mir das bitte zu. Vielen Dank.").
// Als Schlusssatz fliegen sie nur, wenn die Aufnahme davor lange still war -
// genau die Situation, in der Whisper sie erfindet.
const AMBIGUOUS_PHRASES = new Set([
  'vielen dank', 'dankeschön', 'danke schön', 'amen', 'bis zum nächsten mal',
  'tschüss', 'thank you', 'bye', 'you',
]);

// ponytail: 1,5s Stille als Halluzinations-Signatur, keine Logprob-Auswertung
// (OpenRouters Transcription-Route liefert nur `text`). Runter, falls die
// Floskel weiter durchkommt; hoch, falls ein echtes Schluss-"Vielen Dank"
// verschwindet.
const HALLUCINATION_SILENCE_MS = 1500;

const HALLUCINATION_PHRASES = new Set([...NEVER_SPOKEN, ...AMBIGUOUS_PHRASES]);

// Apostroph-Variante ("für's") auf die Listenform ("fürs") normalisieren -
// Whisper schreibt beide, die Liste braucht nicht jede Schreibvariante.
// Satzzeichen werden zu Leerraum, nicht geloescht, sonst wird aus
// "Amara.org-Community" ein "amaraorg-community", das in keiner Liste steht.
function normalize(text) {
  return text.toLowerCase().replace(/[.!?,;:…]/g, ' ').replace(/['’]/g, '').replace(/\s+/g, ' ').trim();
}

function isHallucination(text) {
  return HALLUCINATION_PHRASES.has(normalize(text || ''));
}

// Entfernt angehaengte Halluzinations-Schlusssaetze. Gibt '' zurueck, wenn vom
// Transkript nichts uebrig bleibt - dann war die ganze Aufnahme Halluzination.
// Nie ein Teiltreffer: "Vielen Dank für die Info, ruf mich zurück" bleibt
// unangetastet, weil nur der LETZTE Satz als Ganzes geprueft wird.
function stripHallucination(text, endedInSilence = false) {
  let out = (text || '').trim();
  // Whisper haengt gelegentlich zwei Floskeln hintereinander ("... Vielen
  // Dank. Bis zum nächsten Mal.") - deshalb wiederholt schneiden.
  for (let i = 0; i < 3 && out; i++) {
    // Satzgrenze = Satzzeichen PLUS Leerraum, damit "Amara.org" ein Wort
    // bleibt statt in zwei Saetze zu zerfallen.
    let cut = 0;
    const boundary = /[.!?…]+\s+/g;
    for (let m = boundary.exec(out); m; m = boundary.exec(out)) cut = m.index + m[0].length;
    const norm = normalize(out.slice(cut));
    const kill = NEVER_SPOKEN.has(norm)
      || (AMBIGUOUS_PHRASES.has(norm) && (cut === 0 || endedInSilence));
    if (!kill) break;
    out = out.slice(0, cut).trim();
  }
  return out;
}

module.exports = {
  isSilence, voicedMs, isSpeech, isHallucination, stripHallucination, trimSilence,
  SILENCE_RMS, MIN_VOICED_MS, HALLUCINATION_SILENCE_MS,
};
