#!/bin/bash
# Riff fuer macOS installieren.
# Aufruf: curl -fsSL https://riff.jaydenmikus.com/install-mac.sh | bash
#
# Warum ein Skript statt Zip im Browser: macOS versieht Browser-Downloads mit
# einer Download-Sperre (Quarantaene). Ohne bezahltes Apple-Zertifikat meldet
# es dann "Riff ist beschaedigt" oder laesst sich nur ueber Umwege oeffnen.
# curl setzt diese Sperre nicht. Das Skript macht nur das hier Sichtbare:
# herunterladen, nach /Applications kopieren, starten.
set -euo pipefail

URL="${RIFF_MAC_URL:-https://github.com/BreezyBuddy69/riff-site/releases/download/v1.0.0/Riff-Mac.zip}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Riff wird heruntergeladen ..."
curl -fL --progress-bar "$URL" -o "$TMP/Riff.zip"
ditto -x -k "$TMP/Riff.zip" "$TMP/app"

DEST="/Applications"
if [ ! -w "$DEST" ]; then DEST="$HOME/Applications"; mkdir -p "$DEST"; fi

# Laufende alte Version beenden, dann ersetzen.
pkill -x Riff 2>/dev/null || true
rm -rf "$DEST/Riff.app"
ditto "$TMP/app/Riff.app" "$DEST/Riff.app"
xattr -cr "$DEST/Riff.app" 2>/dev/null || true

echo "Fertig: $DEST/Riff.app"
echo "Beim ersten Start fragt macOS nach Mikrofon, Bedienungshilfen und Eingabeueberwachung: bitte erlauben."
open "$DEST/Riff.app"
