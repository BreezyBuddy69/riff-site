// electron-builder afterSign-Hook: signiert die .app ad-hoc (Signatur ohne
// Zertifikat/Apple-ID, kostenlos - "kein Signing-Budget", siehe Riffs
// Projekt-Memory). Ohne JEDE Signatur weigert sich Apple Silicon oft, die App
// ueberhaupt zu starten ("Riff ist beschaedigt und sollte in den Papierkorb
// verschoben werden") statt nur Gatekeepers ueblicher "unbekannter
// Entwickler"-Warnung zu zeigen, die sich per Rechtsklick->Oeffnen umgehen
// laesst (siehe server/products.js Mac-Anleitung). Ad-hoc-Signatur (`-` statt
// einer echten Identity) macht daraus wieder den harmlosen, umgehbaren Fall.
//
// BEWUSST afterSign statt afterPack: afterPack laeuft bei einem universal
// (x64+arm64) Build EINMAL PRO ARCH, auf den noch ungemergten Zwischen-Apps
// - eigenes Signieren dort veraendert pro Arch die eingebettete
// _CodeSignature/CodeResources-Datei unterschiedlich und lässt
// @electron/universal beim Mergen mit "Expected all non-binary files to have
// identical SHAs" abbrechen (live erlebt, 2026-08-13). afterSign laeuft
// dagegen genau EINMAL, NACH dem Merge, auf der fertigen universal-App -
// exakt der Punkt, an dem electron-builder selbst signieren wuerde, haette es
// eine echte Identity.
// ponytail: behebt NICHT Gatekeepers Entwickler-Warnung selbst - dafuer
// braucht es ein bezahltes Apple Developer ID Zertifikat + Notarisierung.
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
