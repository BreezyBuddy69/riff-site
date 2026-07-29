// Committed placeholder — the REAL sellable codes live in seed-codes.local.js
// (gitignored, same pattern as .env/.env.example): never expose actual codes
// on the public GitHub repo, or anyone can redeem them for free before a
// paying customer does. Copy the real seed-codes.local.js onto the server
// separately (like Riff-Setup.exe / .env), same out-of-band delivery.
let codes = { riff: [] };
try {
  codes = require("./seed-codes.local.js");
} catch {
  // Kein lokales File (frischer Clone ohne den Out-of-band-Kopiervorgang) —
  // leerer Pool statt Absturz, seedCodesIfEmpty() importiert dann einfach 0.
}
module.exports = codes;
