// Autostart via .lnk im Windows-Startup-Ordner - bewusst nicht der
// Registry-Run-Key: eine Verknuepfung kann der Nutzer im Explorer einfach
// loeschen, komplett reversibel. "--autostart" laesst main.js einen stillen
// Login-Start von einem expliziten Oeffnen unterscheiden.
const { execFile } = require('child_process');
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'create-shortcut.ps1');

function shortcutPath() {
  return path.join(
    process.env.APPDATA,
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    'Riff.lnk',
  );
}

// macOS (D41): kein %APPDATA%, keine .lnk - Anmeldeobjekte ueber Electron.
// Vorher warf shortcutPath() dort (path.join(undefined)) und riss die ganze
// Startsequenz in main.js mit: kein Fenster, kein Tray ("Mac tut nichts").
const isMac = process.platform === 'darwin';

function isEnabled() {
  if (isMac) return app.getLoginItemSettings().openAtLogin;
  return fs.existsSync(shortcutPath());
}

// hidden (Master-Prompt §6.9): "versteckt starten" haengt zusaetzlich
// --hidden an - main.js liest das beim Boot und ueberspringt dann Tray-Icon-
// Anzeige/Hauptfenster, nur die Diktat-Watcher laufen. --autostart bleibt wie
// bei Sable2 die generelle "das war ein stiller Login-Start"-Markierung.
async function enable({ exePath, appDir, hidden = false }) {
  if (isMac) { app.setLoginItemSettings({ openAtLogin: true, openAsHidden: hidden, args: hidden ? ['--hidden'] : [] }); return; }
  const args = hidden ? '. --autostart --hidden' : '. --autostart';
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH,
        '-ShortcutPath', shortcutPath(),
        '-TargetPath', exePath,
        '-Arguments', args,
        '-WorkingDirectory', appDir,
        '-IconPath', path.join(appDir, 'assets', 'icon.ico'),
      ],
      { timeout: 10000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`Autostart konnte nicht eingerichtet werden: ${stderr?.trim() || err.message}`));
        else resolve();
      },
    );
  });
}

function disable() {
  if (isMac) { app.setLoginItemSettings({ openAtLogin: false }); return; }
  const target = shortcutPath();
  if (fs.existsSync(target)) fs.unlinkSync(target);
}

module.exports = { isEnabled, enable, disable, shortcutPath };
