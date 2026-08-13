// electron-builder afterPack-Hook: signiert die .app ad-hoc (Signatur ohne
// Zertifikat/Apple-ID, kostenlos - "kein Signing-Budget", siehe Riffs
// Projekt-Memory). Ohne JEDE Signatur weigert sich Apple Silicon oft, die App
// ueberhaupt zu starten ("Riff ist beschaedigt und sollte in den Papierkorb
// verschoben werden") statt nur Gatekeepers ueblicher "unbekannter
// Entwickler"-Warnung zu zeigen, die sich per Rechtsklick->Oeffnen umgehen
// laesst (siehe server/products.js Mac-Anleitung). Ad-hoc-Signatur (`-` statt
// einer echten Identity) macht daraus wieder den harmlosen, umgehbaren Fall.
// ponytail: behebt NICHT Gatekeepers Entwickler-Warnung selbst - dafuer
// braucht es ein bezahltes Apple Developer ID Zertifikat + Notarisierung.
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
