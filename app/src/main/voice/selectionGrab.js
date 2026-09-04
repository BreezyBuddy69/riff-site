// Aktuelle Auswahl der fokussierten App greifen: Ctrl+C + Zwischenablage-
// Polling statt UIA-Textmuster, weil das (anders als TextPattern, das viele
// Apps/Browser gar nicht implementieren) praktisch ueberall funktioniert -
// Wispr-Flow-Prinzip, kein App-spezifischer Code. Gemeinsam genutzt von
// transforms.js (feste Presets) und dictationRouter.js (Diktat-ueber-
// Auswahl-Umschreiben, D40).
const { clipboard } = require('electron');
const helper = require('../helper');

const COPY_POLL_MS = 60;
const COPY_POLL_TRIES = 12; // max ~720ms
const MOD_RELEASE_TIMEOUT_MS = 2000;
const MOD_POLL_MS = 40;

// Ein Hotkey feuert beim DRUECKEN der Haupttaste - Alt/Shift/Strg sind zu dem
// Zeitpunkt noch unten. Ein sofortiges Ctrl+C sieht die Ziel-App deshalb als
// Ctrl+Alt+Shift+C und kopiert NICHTS (real gemessen: Feature lief durch,
// Text blieb unveraendert). Also warten, bis die Finger wirklich weg sind.
// Bestenfalls-Verhalten: laeuft die Frist ab (klemmende Taste), wird es
// trotzdem versucht - schlimmstenfalls greift die "keine Auswahl"-Erkennung.
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

// Ctrl+C ist asynchron aus unserer Sicht: die Ziel-App schreibt die Auswahl
// erst ein paar Millisekunden spaeter in die Zwischenablage. Deshalb pollen
// statt einmal blind zu warten - so ist der schnelle Fall (Auswahl vorhanden)
// schnell, der haeufigere Fall (keine Auswahl) traegt den vollen Timeout.
// timeoutMs ist absichtlich ein Parameter: transforms.js ruft explizit einen
// Hotkey fuer eine Auswahl-Aktion auf (voller Timeout vertretbar), waehrend
// dictationRouter.js das bei JEDEM Diktat probiert (D40) - dort kuerzer, damit
// der haeufigere "nichts markiert"-Fall normales Diktieren nicht spuerbar
// verlangsamt.
async function grabSelection({ timeoutMs = COPY_POLL_TRIES * COPY_POLL_MS } = {}) {
  await waitForModifiersUp();
  const prev = clipboard.readText();
  // Leeren, damit ein fehlgeschlagenes Ctrl+C nicht den alten Inhalt als
  // "Auswahl" ausgibt und woanders einfuegt.
  clipboard.writeText('');
  await helper.request('keys', { keys: 'ctrl+c' });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, COPY_POLL_MS));
    const text = clipboard.readText();
    if (text && text.trim()) return { text, prev };
  }
  return { text: '', prev };
}

module.exports = { grabSelection };
