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
    // mitgelieferten Installer - die Binaries muessen so nie manuell aufs VPS
    // kopiert werden (kein scp/Kodee-Schritt fuer den Download-Teil noetig).
    // Ein Zugangscode schaltet den Download frei, die Plattform waehlt man
    // danach (win/mac) - RIFF_DOWNLOAD_URL_WIN/_MAC bleiben als Overrides
    // nutzbar (z.B. eigenes Hosting statt GitHub Releases).
    delivery: {
      type: "download",
      platforms: {
        win: {
          label: "Riff für Windows herunterladen",
          url:
            process.env.RIFF_DOWNLOAD_URL_WIN ||
            process.env.RIFF_DOWNLOAD_URL ||
            "https://github.com/BreezyBuddy69/riff-site/releases/download/v1.0.0/Riff-Setup.exe",
          steps: [
            "Riff-Setup.exe herunterladen und doppelklicken. Kein Entpacken, keine Adminrechte.",
            "Zeigt Windows „Der Computer wurde durch Windows geschützt“: auf „Weitere Informationen“ klicken, dann auf „Trotzdem ausführen“. Die Warnung kommt, weil Riff noch kein kostenpflichtiges Signatur-Zertifikat hat. Sie ist kein Virusfund.",
            "Riff startet danach im Hintergrund und ab jetzt mit Windows.",
            "Strg + Alt halten, sprechen, loslassen. Für freihändiges Diktieren Strg + Alt + D einmal antippen, zum Beenden nochmal oder Enter.",
            "Ist dein Mikro stumm geschaltet, sagt dir Riff das direkt in der Bubble. Ein Klick schaltet es wieder ein.",
            "Kostenlos: 1500 Wörter pro Woche. Für unbegrenztes Diktieren einen Pro-Code in Riffs Einstellungen einlösen.",
          ],
        },
        // Beta (2026-08-03): erste macOS-Fassung, auf echter Hardware noch
        // nicht getestet (kein Mac verfuegbar, nur ueber einen GitHub-Actions-
        // macOS-Runner kompiliert+paketiert verifiziert) - Steps/Label sagen
        // das ehrlich, statt es wie die ausgereifte Windows-Version zu verkaufen.
        mac: {
          label: "Riff für Mac herunterladen (Beta)",
          beta: true,
          url:
            process.env.RIFF_DOWNLOAD_URL_MAC ||
            "https://github.com/BreezyBuddy69/riff-site/releases/download/v1.0.0/Riff-Mac.zip",
          // Terminal-Einzeiler (D41): curl setzt keine Download-Sperre
          // (Quarantaene), deshalb kein "beschaedigt"-Dialog und kein
          // Rechtsklick-Oeffnen noetig. Die Seite baut daraus mit ihrer
          // eigenen Adresse den kompletten Befehl + Kopier-Knopf.
          command: "install-mac.sh",
          steps: [
            "Am einfachsten: Terminal öffnen (Cmd + Leertaste, „Terminal“ tippen), den Befehl oben einfügen und Enter drücken. Er lädt Riff, legt es in „Programme“ und startet es.",
            "Beim ersten Start fragt macOS nach Mikrofon, Bedienungshilfen und Eingabeüberwachung. Alle drei erlauben und Riff danach einmal neu starten.",
            "Control + Option halten, sprechen, loslassen. Für freihändiges Diktieren Control + Option + D einmal antippen.",
            "Lieber per Download? Riff-Mac.zip laden, Riff.app in „Programme“ ziehen, mit Rechtsklick → Öffnen starten. Meldet macOS „beschädigt“, im Terminal xattr -cr /Applications/Riff.app ausführen.",
            "Beta: läuft auf Intel und Apple Silicon. Rückmeldungen helfen uns sehr.",
          ],
        },
      },
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
