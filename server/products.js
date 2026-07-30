// Produkt-Registry — Fork der Sable-Plattform (websites/sable/server/
// products.js), Struktur unverändert übernommen. Frontend (/api/products)
// und Redeem-Endpoint lesen ausschließlich aus dieser Registry.

"use strict";

function envList(...names) {
  return names.map((n) => process.env[n]).filter(Boolean);
}

const PRODUCTS = {
  riff: {
    slug: "riff",
    name: "Riff",
    tagline: "Sprich. Es steht schon da.",
    status: "available", // available | coming_soon
    totalSlots: Number(process.env.RIFF_TOTAL_SLOTS || 100),
    // Codes: RIFF-XXXX-XXXX-XXXX, Crockford-Alphabet (kein 0/O/1/I/L/U)
    codePattern: /^RIFF-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/,
    codePlaceholder: "RIFF-XXXX-XXXX-XXXX",
    // Zwei Google Sheets à 50 Codes = ein logischer Pool von 100.
    sheets: envList("RIFF_SHEET_ID_1", "RIFF_SHEET_ID_2").map((id) => ({
      id,
      tab: process.env.RIFF_SHEET_TAB || "Codes",
    })),
    // Dieser Code schaltet NUR den Download frei (Zugang zu den 100
    // Erstplätzen) - er ist NICHT derselbe Code wie fuer die Pro-Freischaltung
    // in der App (siehe "riff-pro" unten, Nutzerwunsch 2026-07-29: zwei
    // getrennte Codes, damit "Download freigeschaltet" und "unbegrenztes
    // Diktieren" unabhaengig voneinander verkauft/verschenkt werden koennen).
    // Free-Tier-Wochenkontingent (1500 Woerter) wird app-/n8n-seitig
    // durchgesetzt (Master-Prompt §6.10/§9), nicht hier.
    //
    // Default zeigt auf den GitHub-Release-Asset-Link statt auf einen lokal
    // mitgelieferten Installer - die 82-MB-EXE muss so nie manuell aufs VPS
    // kopiert werden (kein scp/Kodee-Schritt fuer den Download-Teil noetig).
    // RIFF_DOWNLOAD_URL bleibt als Override fuer eine andere Ablage nutzbar.
    delivery: {
      type: "download",
      url:
        process.env.RIFF_DOWNLOAD_URL ||
        "https://github.com/BreezyBuddy69/riff-site/releases/download/v1.0.0/Riff-Setup.exe",
      label: "Riff herunterladen",
      steps: [
        "Riff-Setup.exe herunterladen und doppelklicken — installiert sich automatisch, kein Entpacken nötig.",
        "Windows SmartScreen kann beim ersten Start warnen (unsignierte App) — „Weitere Informationen“ → „Trotzdem ausführen“.",
        "Riff startet nach der Installation automatisch und legt eine Verknüpfung im Startmenü an.",
        "Strg + Alt halten und sprechen zum Diktieren — Strg + Alt + D zweimal antippen für den Freihand-Modus.",
        "Kostenlos: 1500 Wörter/Woche. Für unbegrenztes Diktieren einen Pro-Code in den Riff-Einstellungen einlösen.",
      ],
    },
  },
  // Zweiter, unabhaengiger Code-Pool fuer die App-interne Pro-Freischaltung
  // (unbegrenztes Diktieren statt 1500 Woerter/Woche) - eingeloest NICHT auf
  // dieser Website, sondern direkt in Riffs Settings ("Konto"-Sektion, siehe
  // Riff/src/main/license.js). Eigener Codepattern-Prefix ("RIFFPRO-" statt
  // "RIFF-"), damit Zugangs- und Pro-Codes auf den ersten Blick unterscheidbar
  // sind - genau die Verwechslung, die der Nutzer als Problem beschrieben hat.
  "riff-pro": {
    slug: "riff-pro",
    name: "Riff Pro",
    tagline: "Unbegrenztes Diktieren.",
    status: "available",
    totalSlots: Number(process.env.RIFF_PRO_TOTAL_SLOTS || 0), // 0 = kein Live-Zaehler auf der Website (Pro wird nicht hier beworben)
    codePattern: /^RIFFPRO-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/,
    codePlaceholder: "RIFFPRO-XXXX-XXXX-XXXX",
    sheets: envList("RIFF_PRO_SHEET_ID_1").map((id) => ({
      id,
      tab: process.env.RIFF_PRO_SHEET_TAB || "Codes",
    })),
    // Keine Datei-Auslieferung - die App liest nur "ok:true" und setzt
    // account.tier = 'pro' lokal (siehe license.js#redeem).
    delivery: { type: "unlock", url: null, label: null, steps: [] },
  },
};

function getProduct(slug) {
  return PRODUCTS[slug] || null;
}

// Öffentliche Sicht — ohne Sheets/Patterns, nichts Internes leakt ins Frontend.
function publicProducts() {
  return Object.values(PRODUCTS).map((p) => ({
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    status: p.status,
    totalSlots: p.totalSlots,
  }));
}

module.exports = { PRODUCTS, getProduct, publicProducts };
