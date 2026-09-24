// Kontext-Erkennung: welche App war beim Diktieren im Vordergrund, und was
// bedeutet das für den Stil? Ein einziger `foreground`-Helper-Call pro Session
// bedient drei Features (Master-Prompt §3 Synergie 2): Stil-Wahl,
// App-Nutzungs-Statistik und das Label im Verlauf.
//
// Prozessnamen (ohne .exe, kleingeschrieben) statt Fenstertitel: Titel
// wechseln mit dem Inhalt ("Posteingang - Outlook"), der Prozessname nicht.

const CATEGORY_BY_APP = {
  // Persönliche Messenger
  whatsapp: 'personal',
  telegram: 'personal',
  discord: 'personal',
  signal: 'personal',
  instagram: 'personal',
  messenger: 'personal',
  // Arbeit
  slack: 'work',
  teams: 'work',
  'ms-teams': 'work',
  notion: 'work',
  linear: 'work',
  jira: 'work',
  // E-Mail
  outlook: 'email',
  thunderbird: 'email',
  hxoutlook: 'email',
  mailspring: 'email',
};

const CATEGORY_LABELS = {
  personal: 'Persönliche Nachrichten',
  work: 'Arbeit',
  email: 'E-Mail',
  other: 'Sonstiges',
};

const STYLE_LABELS = {
  formal: 'Formal — Groß- und Kleinschreibung + Satzzeichen',
  casual: 'Casual — Groß- und Kleinschreibung, weniger Satzzeichen',
  'very-casual': 'Very casual — alles klein, weniger Satzzeichen',
};

// Stil-Anweisungen als Ergänzung zum bestehenden Cleanup-Prompt. 'formal' ist
// exakt das Default-Verhalten des Cleanup-Prompts - dafür wird bewusst NICHTS
// angehängt (kürzerer Prompt = weniger Tokens = schneller).
const STYLE_INSTRUCTIONS = {
  formal: '',
  casual: 'Style: keep normal capitalization but use minimal punctuation - no trailing period at the end of a short message, commas only where meaning would otherwise be unclear.',
  'very-casual': 'Style: write everything in lowercase, no trailing period, minimal punctuation. Keep proper nouns and acronyms as spoken.',
};

function categorize(appName) {
  if (!appName) return 'other';
  const key = String(appName).toLowerCase().replace(/\.exe$/, '');
  return CATEGORY_BY_APP[key] || 'other';
}

// Ab hier lohnt sich Filtern: kleinere Woerterbuecher einfach komplett
// mitschicken (Filtern selbst kostet auch Tokens/Zeit, siehe relevantTerms).
const FILTER_ABOVE = 40;

// Begrenzt die mitgeschickten Begriffe auf die, die zur aktuellen Aeusserung
// passen koennten (Nutzerwunsch Tokeneffizienz, 2026-07-30) - sonst waechst
// der Cleanup-Prompt mit jedem gelernten Begriff, obwohl in einem einzelnen
// Diktat nur eine Handvoll je ueberhaupt vorkommen kann. Grobe Heuristik:
// Anfangsbuchstaben eines Begriffs tauchen irgendwo im Rohtext auf (faengt
// auch falsch gehoerte Endungen ab, z.B. "Mikus" -> "Mikas"), kein echtes
// Phonetik-Modell.
// ponytail: Praefix-Heuristik statt Soundex/Levenshtein - austauschen, falls
// sie zu oft falsch/gar nicht matcht.
function relevantTerms(terms, rawText) {
  if (terms.length <= FILTER_ABOVE) return terms;
  const raw = (rawText || '').toLowerCase();
  const hits = terms.filter((t) => raw.includes(t.slice(0, Math.min(3, t.length)).toLowerCase()));
  return hits.length ? hits : terms.slice(0, FILTER_ABOVE);
}

// Ob eine Aeusserung ueberhaupt zu einem Woerterbuch-Begriff passen koennte -
// dieselbe Praefix-Heuristik wie relevantTerms. Wird derzeit von keinem
// Laufzeitpfad mehr gesteuert (kurze Aeusserungen ueberspringen die Cleanup-
// Runde seit 2026-09-06 IMMER, das Woerterbuch reist stattdessen als
// Vokabular-Hint an die Transkription) - bleibt als util exportiert, falls
// ein lokaler Woerterbuch-Match im Paste-Pfad das irgendwann wieder braucht.
function matchesDictionary(dictionary, rawText) {
  const raw = (rawText || '').toLowerCase();
  return (dictionary || []).some((d) => {
    const t = (d.term || '').toLowerCase();
    return t.length >= 2 && raw.includes(t.slice(0, Math.min(3, t.length)));
  });
}

// Baut den Zusatz zum Cleanup-Prompt aus Stil-Einstellung + Wörterbuch.
// Leerer String = Cleanup läuft genau wie vorher.
function cleanupExtras(styles, category, dictionary, rawText) {
  const parts = [];
  const style = styles[category] || 'casual';
  if (STYLE_INSTRUCTIONS[style]) parts.push(STYLE_INSTRUCTIONS[style]);
  const terms = relevantTerms((dictionary || []).map((d) => d.term).filter(Boolean), rawText);
  if (terms.length) {
    // Die Begriffe sind Schreibweisen-Autorität, kein Ersetzungsauftrag: das
    // Modell soll ähnlich klingende Fehlschreibungen korrigieren, aber keine
    // Begriffe erfinden, die nie gesprochen wurden.
    parts.push(`Known correct spellings (fix close phonetic matches, never insert a term that was not spoken): ${terms.join(', ')}`);
  }
  return parts.join('\n');
}

// Was ein Strg+C in dieser App anrichtet, wenn NICHTS markiert ist (Voice
// Edit prueft nach jedem Diktat per Strg+C auf eine Auswahl, D40/D41):
//   'never' - Terminals: Strg+C bricht das laufende Programm ab. Nie senden.
//   'line'  - Code-Editoren kopieren ohne Auswahl die ganze aktuelle Zeile
//             (VS Code "emptySelectionClipboard", JetBrains, Sublime) - eine
//             kopierte Einzelzeile mit Zeilenumbruch ist dort KEINE Auswahl.
//   'normal'- alles andere.
// Windows-Prozessnamen und macOS-App-Namen (localizedName) in einer Liste.
// ponytail: feste Namensliste - fehlt ein Terminal, schickt Riff dort Strg+C.
// Ergaenzen, sobald eins gemeldet wird. Bekannte Luecke: das INTEGRIERTE
// Terminal in VS Code sieht von aussen aus wie der Editor ('line').
const NEVER_COPY_APPS = new Set([
  'windowsterminal', 'wt', 'cmd', 'powershell', 'pwsh', 'powershell_ise', 'conhost', 'openconsole',
  'mintty', 'alacritty', 'wezterm-gui', 'wezterm', 'putty', 'kitty', 'hyper', 'tabby', 'warp',
  'terminal', 'iterm2', 'ghostty',
]);
const LINE_COPY_APPS = new Set([
  'code', 'code - insiders', 'visual studio code', 'cursor', 'windsurf', 'devenv', 'sublime_text', 'sublime text',
  'idea64', 'pycharm64', 'webstorm64', 'rider64', 'clion64', 'goland64', 'phpstorm64', 'rubymine64',
  'datagrip64', 'studio64', 'intellij idea', 'pycharm', 'webstorm', 'android studio', 'zed',
]);

function copyBehavior(appName) {
  const key = String(appName || '').toLowerCase().replace(/\.exe$/, '');
  if (NEVER_COPY_APPS.has(key)) return 'never';
  if (LINE_COPY_APPS.has(key)) return 'line';
  return 'normal';
}

// Genau eine Zeile plus Zeilenumbruch = die Zeilen-Kopie eines Editors.
function looksLikeLineCopy(text) {
  return /^[^\r\n]*\r?\n$/.test(text || '');
}

module.exports = {
  categorize, cleanupExtras, matchesDictionary, copyBehavior, looksLikeLineCopy,
  CATEGORY_LABELS, STYLE_LABELS, STYLE_INSTRUCTIONS,
};
