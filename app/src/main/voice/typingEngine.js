// Fuegt Diktat-Text per Clipboard-Paste ein (D25, Wispr-Flow-Prinzip):
// Text in die Zwischenablage -> Ctrl+V ueber den Helper -> alten Clipboard-
// Inhalt wiederherstellen. EIN Paste statt n simulierten Tastendruecken -
// der Text erscheint unabhaengig von seiner Laenge "instant" an der Cursor-
// Position der fokussierten App (auch in Sables eigenem Eingabefeld).
// Merkt sich weiterhin, wie viel dieses Modul selbst eingefuegt hat - so
// kann "letzten Satz loeschen" per gezielten Backspaces rueckgaengig gemacht
// werden, ohne auf OS-Textauswahl zu vertrauen (funktioniert in jeder
// Ziel-App identisch, Paste wie Tippen).
const { clipboard } = require('electron');
const helper = require('../helper');

const MAX_SEGMENTS = 20;
// Wie lange die Ziel-App nach dem Ctrl+V realistisch braucht, um den
// Clipboard-Inhalt zu LESEN, bevor wir den alten wiederherstellen - zu
// fruehes Restore liesse die App den ALTEN Inhalt pasten.
const CLIPBOARD_RESTORE_MS = 500;
const segments = [];

function rememberSegment(length) {
  segments.push({ length });
  if (segments.length > MAX_SEGMENTS) segments.shift();
}

// Kompletter Zwischenablage-Schnappschuss statt nur Text: wer formatierten
// Text (HTML/RTF, z.B. aus Word/Browser) oder ein Bild kopiert hat und dann
// diktiert, soll danach genau das wieder in der Zwischenablage haben.
// ponytail: Text/HTML/RTF/Bild - kopierte DATEIEN (Explorer) ueberleben einen
// Paste nicht. Ergaenzen per readBuffer('FileNameW'), falls das jemand meldet.
function snapshotClipboard() {
  const snap = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF() };
  const image = clipboard.readImage();
  if (!image.isEmpty()) snap.image = image;
  return snap;
}

function restoreClipboard(snap) {
  if (!snap) return;
  try {
    // Nur befuellte Formate schreiben - ein leeres HTML-Format wuerde manche
    // Apps beim naechsten Einfuegen "nichts" einfuegen lassen.
    const data = {};
    for (const k of ['text', 'html', 'rtf', 'image']) if (snap[k]) data[k] = snap[k];
    if (Object.keys(data).length) clipboard.write(data);
    else clipboard.clear();
  } catch { /* Clipboard gerade von anderer App gesperrt - Restore verwerfen */ }
}

async function typeText(text) {
  const prev = snapshotClipboard();

  clipboard.writeText(text);
  try {
    await helper.request('keys', { keys: 'ctrl+v' });
  } catch (err) {
    // Paste nicht moeglich (Helper beschaeftigt o.ae.) - Fallback auf das
    // alte Zeichen-fuer-Zeichen-Tippen: langsamer, aber gleiche Wirkung.
    restoreClipboard(prev);
    try {
      await helper.request('type', { text });
      rememberSegment(text.length);
    } catch (err2) {
      console.warn('[typingEngine] type fehlgeschlagen:', err2.message);
    }
    return;
  }
  rememberSegment(text.length);

  // Restore verzoegert und nur, wenn der Clipboard-Inhalt noch unserer ist -
  // hat der Nutzer inzwischen selbst etwas kopiert, gewinnt der Nutzer.
  setTimeout(() => {
    try { if (clipboard.readText() !== text) return; } catch { return; }
    restoreClipboard(prev);
  }, CLIPBOARD_RESTORE_MS);
}

async function pressKeys(keys) {
  try {
    await helper.request('keys', { keys });
  } catch (err) {
    console.warn('[typingEngine] keys fehlgeschlagen:', err.message);
  }
}

async function deleteLastSegment() {
  const entry = segments.pop();
  if (!entry) return false;
  // Sequenziell statt Promise.all: seltener Korrektur-Befehl, kein Hot-Path,
  // und der Helper verarbeitet ohnehin einen Tastendruck nach dem anderen.
  for (let i = 0; i < entry.length; i++) {
    await helper.request('keys', { keys: 'backspace' });
  }
  return true;
}

module.exports = { typeText, pressKeys, deleteLastSegment, snapshotClipboard, restoreClipboard };
