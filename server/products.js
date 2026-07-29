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
    // Anders als bei Sable (Einmalkauf/Permanent-Unlock) schaltet ein Riff-
    // Code Pro dauerhaft frei, das WOCHENKONTINGENT (1500 Wörter) selbst wird
    // aber app-/n8n-seitig durchgesetzt (Master-Prompt §6.10/§9), nicht hier
    // auf der Redemption-Plattform — die kennt nur "eingelöst ja/nein", genau
    // wie bei Sable.
    //
    // Ohne RIFF_DOWNLOAD_URL wird der lokal mitgelieferte Installer unter
    // /downloads/Riff-Setup.exe ausgeliefert (siehe server/index.js
    // handleDownload) - funktioniert ohne jede .env-Konfiguration. Für
    // Produktion optional auf eine externe Ablage (GitHub Release, CDN)
    // umleiten, um die VPS-Bandbreite zu schonen (Sable macht das bereits so).
    delivery: {
      type: "download",
      url: process.env.RIFF_DOWNLOAD_URL || "/downloads/Riff-Setup.exe",
      label: "Riff herunterladen",
      steps: [
        "Riff-Setup.exe herunterladen und doppelklicken — installiert sich automatisch, kein Entpacken nötig.",
        "Windows SmartScreen kann beim ersten Start warnen (unsignierte App) — „Weitere Informationen“ → „Trotzdem ausführen“.",
        "Riff startet nach der Installation automatisch und legt eine Verknüpfung im Startmenü an.",
        "Strg + Alt halten und sprechen zum Diktieren — Strg + Alt + D zweimal antippen für den Freihand-Modus.",
        "In den Einstellungen deinen OpenRouter-API-Key eintragen, dann ist Riff einsatzbereit.",
      ],
    },
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
