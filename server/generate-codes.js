// Code-Generator: erzeugt 2 × 50 Zugangscodes als CSV — je eine Datei pro
// Google Sheet. In die Sheets einfügen (Tab "Codes", Kopfzeile beibehalten).
//
//   node server/generate-codes.js            -> 2 Dateien à 50 Codes
//   node server/generate-codes.js 3 40       -> 3 Dateien à 40 Codes
//
// Format: RIFF-XXXX-XXXX-XXXX, Crockford-artiges Alphabet ohne
// verwechselbare Zeichen (0/O, 1/I/L, U/V-Problemfälle entfernt).
// 12 Zeichen × log2(30) ≈ 59 Bit Entropie — bei 100 gültigen Codes und
// Rate-Limiting ist Raten praktisch aussichtslos.

"use strict";

const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const sheetCount = Number(process.argv[2] || 2);
const perSheet = Number(process.argv[3] || 50);

function group() {
  // Rejection-Sampling gegen Modulo-Bias
  const chars = [];
  while (chars.length < 4) {
    const b = randomBytes(1)[0];
    if (b < 240) chars.push(ALPHABET[b % ALPHABET.length]);
  }
  return chars.join("");
}

const seen = new Set();
function newCode() {
  let code;
  do {
    code = `RIFF-${group()}-${group()}-${group()}`;
  } while (seen.has(code));
  seen.add(code);
  return code;
}

const outDir = path.join(__dirname, "..", "data");
fs.mkdirSync(outDir, { recursive: true });

for (let s = 1; s <= sheetCount; s++) {
  const lines = ["Code,Status,Eingelöst am,Beleg-ID"];
  for (let i = 0; i < perSheet; i++) lines.push(`${newCode()},,,`);
  const file = path.join(outDir, `codes-sheet-${s}.csv`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  console.log(`Sheet ${s}: ${perSheet} Codes -> ${file}`);
}

console.log(`\nGesamt: ${seen.size} Codes. CSVs in die Google Sheets importieren`);
console.log(`(Datei -> Importieren -> Tab "Codes", Codes stehen ab Zeile 2).`);
console.log(`Die CSV-Dateien danach lokal löschen oder sicher verwahren.`);
