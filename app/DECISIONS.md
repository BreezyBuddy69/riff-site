# Riff — Entscheidungen

Vollständiger Plan: `../websites/riff-MASTER-PROMPT.md`. Diese Datei hält nur
die tatsächlich getroffenen Entscheidungen fest (D-Nummern), analog zu
Sable2s `DECISIONS.md` — Riff ist ein Fork von `Sable2/src/main/voice/`
(2026-07-27), kein Neubau.

**D0 — Fork, kein Shared-Package.** Code aus `Sable2/src/main/voice/*`
(holdWatcher, speechRecognition, transcriptCleanup, dictationEngine,
typingEngine, wav, window) und `Sable2/helper/SableHelper.ps1` wurde kopiert,
nicht als npm-Workspace geteilt. Begründung: Master-Prompt §0/§11.

**D1 — Zwei Session-Typen, ein Router.** `dictationRouter.js` kennt nur
`kind: 'hold' | 'toggle' | null`, keinen Assistent-/Weckwort-/Bubble-im-Chat-
Zustand wie Sable2s `router.js`. Weder Hold- noch Toggle-Sessions enden über
VAD-Sprechpausen — Hold endet nur per Loslassen, Toggle nur per zweitem
Doppel-Tap oder Haken/Kreuz-Klick (Master-Prompt §6.1).

**D2 — Bubble-Fenstergrößen als feste Presets.** `window.js` kennt drei feste
Größen (`normal`/`toggle`/`error`) statt stufenlosem Resize — gleiches
Prinzip wie Sable2 D2 (kein Ruckeln). `toggle` ist breiter, weil die Haken/
Kreuz-Icons sonst vom Fensterrahmen abgeschnitten würden.

**D3 — RiffHelper.ps1 vorerst 1:1 aus Sable2 übernommen**, inkl. ungenutzter
Ops (click/drag/uia_*/speak/...). Siehe `ponytail:`-Kommentar im Datei-Kopf —
Aufräumen verschoben auf Phase 2 (`read_context`, Master-Prompt §6.3/§8),
wenn der Helper ohnehin angefasst wird.

**D4 — Redemption-Plattform bleibt unverändert wie bei Sable2, KEIN
Kontingent-Umbau.** Master-Prompt §7 hatte nahegelegt, `products.js`/`db.js`
müssten fürs Wochenkontingent angepasst werden. Umgesetzt wurde stattdessen:
`websites/riff/` ist ein 1:1-Struktur-Fork von `websites/sable/` — Code
schaltet weiterhin permanent "Pro" frei (identische atomare SQLite-Logik),
das Wochenkontingent (1500 Wörter/Woche) ist ausschließlich ein
App-/n8n-Enforcement-Thema (§6.10/§9), keine Änderung an der
Code-Redemption. Sauberere Trennung als im Plan beschrieben.

**Stand 2026-07-27:** Phase 0 (Fork&Skelett) + Kern-Diktat-Loop aus Phase 1
sind lauffähig — UND installiert: `npm run dist` erzeugt `Riff-Setup.exe`,
real ausgeführt, `Riff.lnk` liegt im Start-Menü, über Windows-Suche auffindbar.
Phase 4 (Website) ist ebenfalls fertig UND smoke-getestet (nicht nur gebaut):
`websites/riff/` läuft lokal, kompletter Redeem-Flow (Erfolg + korrekt
abgelehnte Doppel-Einlösung) und der Installer-Download (Content-Length
gegen die reale Datei geprüft) wurden gegen den echten Server verifiziert.
Phase 4 wurde bewusst vor Phase 2/3 gebaut (Nutzerwunsch).

Noch NICHT gebaut: n8n-Auth, Wortkontingent-Durchsetzung, Kontext-Fenster,
Streaming-Cleanup, Wörter-Gedächtnis. Siehe Master-Prompt §12 für die
Reihenfolge.

**D5 — Kein OpenRouter-Key noetig, Fallback ueber Riffs eigenes n8n statt
Website-Redemption-Umbau.** Ohne `voice.openRouterApiKey` in config.json
laufen sowohl Transkription als auch Cleanup ueber
`n8n.halovisionai.cloud/webhook/riff-stt` (neuer Webhook, Groq-Whisper via
OpenRouter-Provider-Pinning) bzw. den bestehenden `sable-chat`-Webhook (fuer
Cleanup wiederverwendet, gleicher deepseek-v4-flash-Pfad wie Sable2s
Online-Chat) - beide nutzen ein in n8n hinterlegtes OpenRouter-Konto, der
Nutzer braucht nie einen eigenen Key (Wispr-Flow-Prinzip). `provider: {
order: ['groq'] }` (kein `allow_fallbacks:false`) erzwingt bevorzugt Groqs
~200x-Realtime-Whisper-Inferenz - groesster Hebel gegen die 3-5s
Diktier-Latenz, faellt automatisch auf einen anderen Anbieter zurueck falls
Groq das Modell nicht hostet. Kurze Aeusserungen (<=3 Woerter) ueberspringen
den Cleanup-Roundtrip komplett.

**D6 — Kein sichtbares Fenster beim Start, per Setting umschaltbar.**
`general.showWindowOnStartup` (Default `false`) in config.json ersetzt das
bisherige "Settings oeffnen bei jedem normalen Start" - Riff verhaelt sich
jetzt wie Wispr Flow: startet komplett im Hintergrund/Tray, egal ob per
Autostart oder Doppelklick. Wer die Settings beim Start sehen will, schaltet
das in den Settings selbst wieder ein; sonst bleiben sie nur ueber den Tray
erreichbar.

**D37 — Shortcut-Recorder statt Freitext-Eingabe.** Roter Kreisknopf neben
`flowHold`/`flowToggle` in den Settings: Klick startet die Aufnahme, die
naechste Tastenkombination wird direkt als Accelerator-String
(`"Control+Alt+D"`) erfasst - kein manuelles Tippen des Formats mehr. Ein
Zuruecksetzen-Knopf (↺) je Shortcut stellt `config.DEFAULTS.hotkeys` wieder
her. Waehrend der Aufnahme pausieren `holdWatcher`/`toggleWatcher`
(`setSuspended`, IPC `settings:suspend-hotkeys`) - sonst wuerde das Druecken
der aufzunehmenden Kombi sofort ein echtes Diktat starten. Erfasst werden nur
Tasten, die `RiffHelper.ps1`s `$VK`-Tabelle kennt (ctrl/alt/shift/win, a-z,
0-9, f1-f12); alles andere wird beim Aufnehmen stillschweigend ignoriert.
Escape oder Fensterwechsel (blur) bricht die Aufnahme ab und stellt den
vorherigen Wert wieder her.

**D7 — Bubble immer vor Sable2/Mumat (Nutzerwunsch: "Vortritt").** Beide
Bubbles laufen auf demselben `alwaysOnTop`-Level `screen-saver` - bei
Gleichstand entscheidet Windows nach zuletzt-angefasst, Riffs Pille konnte
also hinter Sable2/Mumats eigener Bubble verschwinden. `window.js#show()`
ruft jetzt zusaetzlich `win.moveTop()` (zwingt an die Spitze des Z-Order,
ohne Fokus zu stehlen) - einfachster Fix, ohne Sable2/Mumat anzufassen.

**D8 — Bubble rein schwarz/weiss/transparent, kein Farb-Akzent mehr.**
`--accent` (#d97757-Orange, faerbte bisher den `listening`-Zustand) entfernt;
die Waveform-Baelkchen waren mit `--ink` (#f5f5f7) schon vorher fast-weiss,
nur der Pill-Hintergrund/Rand im `listening`-Zustand wurde von Orange auf
halbtransparentes Weiss umgestellt. Lautstaerke-/tonabhaengige Einfaerbung
bewusst NICHT gebaut (Nutzer hat die Idee im selben Atemzug wieder verworfen
- "mach es einfach weiss").

**D9 — Neu-starten/Beenden-Knoepfe in den Settings.** `app.relaunch()` +
`app.exit()` bzw. `app.quit()` (mit `app.isQuitting = true`, sonst faengt
`window-all-closed`/`settingsWindow`s close-Handler den Quit ab) ueber neue
IPC-Kanaele `settings:restart`/`settings:quit` - bisher ging Beenden nur ueber
den Tray.

**D10 — Bubble-Redesign Runde 2: opak statt Glas.** D8 hatte den Orange-Akzent
entfernt, aber die Glas-/Blur-Optik (`backdrop-filter`, halbtransparenter
Hintergrund) beibehalten - das war nicht gemeint, Rueckmeldung: "das
Transparent ist hässlich". `voice.css`: `--glass` jetzt `#000000` (voll opak),
`backdrop-filter` komplett entfernt, `listening`-Zustand faerbt/tint nicht mehr
(nur noch der bestehende Scale-Pulse). Pille zusaetzlich von 22px auf 34px
Hoehe gebracht (Fenstergroesse in `window.js` von 28 auf 40, Waveform-Balken
von 13px auf 20px) - "dicker, eher wie ein Tic Tac" statt duenner Streifen.

**D11 — Shortcut-Recorder: Gnadenfrist vor Modifier-only-Finalisierung.**
`onRecordKeyup` (Settings-Renderer) finalisierte bisher SOFORT, sobald alle
gehaltenen Modifier wieder oben waren - wer beim Aufnehmen eines 3-Tasten-
Shortcuts (z.B. "Control+Alt+D") die Modifier vor der Haupttaste losliess
(sehr verbreitetes Timing beim Tippen), bekam ungewollt nur die 2-Tasten-
Modifier-Kombi, die Haupttaste kam zu spaet. `RELEASE_GRACE_MS = 350`:
Finalisierung als reine Modifier-Kombi wird jetzt per `setTimeout` verzoegert
und verworfen, falls doch noch eine Taste kommt.

**D12 — Vortritt vor Sable2 beim Diktieren (nicht nur visuell).** D7 (letzte
Session) hatte nur den Z-Order der Bubble-Fenster geregelt (`moveTop()`).
Eigentliches Problem: Riffs `flowHold`-Default ("Control+Alt") ist identisch
zu Sable2s `voiceFlow`-Default - laufen beide Apps, reagieren beide
gleichzeitig auf denselben Tastendruck (zwei Mikrofon-Captures, zwei Paste-
Versuche). Riff hinterlegt jetzt beim Start seine PID in
`os.tmpdir()/riff-dictation.lock` (geschrieben in `app.whenReady()`, entfernt
in `before-quit`) - Sable2s `holdWatcher.js` prueft dieselbe Datei und
ignoriert seinen eigenen Hotkey komplett, solange die dortige PID lebt. Siehe
Sable2/DECISIONS.md D52 fuer die Gegenseite.

**D13 — Umlaute (ä/ö/ü) im Shortcut-Recorder.** `mainKeyName()` (Settings-
Renderer) erkennt jetzt auch Umlaute als Haupttaste - ueber `e.key` statt
`e.code` (Umlaute sitzen je nach DE/AT/CH-Layout an unterschiedlichen
physischen Positionen, `e.key` liefert direkt das layoutaufgeloeste Zeichen).
`RiffHelper.ps1`s `$VK`-Tabelle bekam passende Eintraege dazu - NICHT als
hartkodierte OEM-VK-Konstanten (die waeren geraten und pro Layout
unterschiedlich), sondern per `VkKeyScanW` zur Laufzeit aufgeloest. Live auf
dem Zielsystem geprueft: ä=0xDC, ö=0xDE, ü=0xBA - deckt sich NICHT mit den aus
dem Gedaechtnis geratenen OEM-Konstanten, die geplante Implementierung waere
mit hartkodierten Werten also tatsaechlich kaputt gewesen. Beim ersten
Testlauf ausserdem ein PowerShell-Stolperstein gefunden+gefixt: `$vk` und
`$VK` sind dieselbe Variable (case-insensitiv) - die urspruengliche
Zwischenvariable hatte die grosse Tabelle mit einem Int32 ueberschrieben und
den Helper beim Start crashen lassen.

**D14 — Bubble-Aktivierungslatenz: gezielte AltGr-Erkennung statt Pauschal-
Verzoegerung.** Nutzerwunsch: Bubble soll wie bei Wispr Flow instant
erscheinen (gemessen ~20% langsamer). Analyse ergab: NICHT das Rendering ist
der Flaschenhals (Fenster wird vorab erzeugt, `show()` ist praktisch 0ms),
sondern die ERKENNUNG - bis zu 330ms (Poll-Intervall + `HOLD_START_MS`), davon
>85% allein `HOLD_START_MS=250ms`, eine pauschale Sicherheitsspanne gegen
AltGr fuer JEDEN Tastendruck. Umgesetzt (`holdWatcher.js`,
`toggleWatcher.js`, `RiffHelper.ps1`):
- `POLL_IDLE_MS` 80ms -> 20ms in beiden Watchern (kostet praktisch nichts -
  GetAsyncKeyState ist ein einzelner nativer Call).
- Neuer Helper-Op `mods_state` liefert Links/Rechts-Aufschluesselung von
  Strg/Alt (`VK_LCONTROL`/`VK_RCONTROL`/`VK_LMENU`/`VK_RMENU` - fest &
  layoutunabhaengig, anders als die Umlaut-OEM-Codes aus D13). Windows
  synthetisiert AltGr IMMER als exakt linke-Strg+rechte-Alt - nur wenn der
  Hotkey exakt "ctrl+alt" ist (der einzige AltGr-Kollisionsfall) UND diese
  Signatur NICHT vorliegt, gilt `HOLD_START_FAST_MS=50ms` statt der vollen
  250ms. Bleibt die Bestaetigung aus oder sieht's nach AltGr aus, greift
  weiterhin der volle Schutz - nie unsicherer als vorher, nur manchmal
  schneller. Live gegen den echten Helper getestet (`mods_state`-Antwort +
  `key_state` fuer ctrl+alt/ctrl+alt+d/ctrl+alt+ö strukturell verifiziert,
  keine Regression), die AltGr-Erkennung selbst kann nur auf echter Hardware
  verifiziert werden (siehe Bitte an den Nutzer im Chat).
- Rechnerisches Ziel: haeufigster Fall (bewusster Zwei-Finger-Druck, kein
  AltGr-Verdacht) von ~290ms auf ~60-70ms - deckt die berichtete Luecke zu
  Wispr Flow grossteils.
- Tier 3 (echter Low-Level-Keyboard-Hook statt Polling, WH_KEYBOARD_LL) wurde
  NICHT umgesetzt - technisch die sauberste Loesung, aber ein fehlerhafter
  globaler Hook kann System-weite Tipp-Verzoegerungen ausloesen, und das laesst
  sich hier nicht gegen echte Hardware testen. Empfehlung fuer spaeter, falls
  Tier 1+2 nicht reichen.

**D15 — Aus dem Einstellungsfenster wird eine App (2026-07-30).** Nutzerwunsch
nach Wispr-Flow-Screenshot: "nicht nur Settings, sondern ein ganzes Profil".
Plan in `APP-MASTER-PROMPT.md` (nach /prompt-max-Prinzip). `settingsWindow.js`
(540x640) + `renderer/settings/` wurden ERSETZT, nicht ergaenzt, durch
`appWindow.js` (1120x760) + `renderer/app/` mit neun Views: Diktat (Verlauf,
Suche, Stat-Panel), Insights, Woerterbuch, Snippets, Stil, Transforms,
Scratchpad, Konto, Einstellungen. Der komplette bisherige Settings-Inhalt
inklusive Shortcut-Recorder (D37/D11/D13) ist als gleichwertige View erhalten.

**D16 — JSON statt SQLite fuer App-Daten.** `store.js` haelt Verlauf (gedeckelt
auf 500 Eintraege), Woerterbuch, Snippets, Notizen, Transforms und
Stil-Einstellungen in EINER `data.json` neben config.json - Schreibvorgaenge
entprellt (400ms) plus `flush()` in `before-quit`. Begruendung: `better-sqlite3`
haette native Rebuilds erzwungen (siehe Guardians electron-builder-Gotchas,
Projekt-Memory), und der gesamte Datenbestand ist ein gedeckelter Verlauf plus
vier kurze Listen. Null neue Dependencies im gesamten Umbau.

**D17 — Jede Zahl aus dem Verlauf gerechnet, keine mitgefuehrten Zaehler.**
`insights.js` aggregiert bei jedem Oeffnen aus `history` (500 Eintraege =
Mikrosekunden). Bewusste Abweichungen vom Vorbild: **kein "Top 0,1 %"** - die
Vergleichsgruppe kennt Riff nicht; stattdessen der messbare Bezug
"x-mal so schnell wie Tippen (40 WPM)". WPM ist der **Median** ueber Sessions
mit >=5 Woertern und >=1,5s (ein 3-Wort-Diktat in 0,4s = rechnerisch 450 WPM
und wuerde jeden Mittelwert unbrauchbar machen). Ohne Vormonat wird `null`
statt "+0 %" geliefert. Selbstpruefung: `npm test` (`test/check.js`).

**D18 — Ein `foreground`-Helper-Call bedient drei Features.** `dictationRouter`
holt beim Session-START (fire-and-forget, parallel zur Aufnahme, nie im
kritischen Pfad) die Vordergrund-App. Daraus entstehen gleichzeitig: die
Stil-Kategorie (`appContext.js`: personal/work/email/other), die
App-Nutzungs-Statistik in Insights und das Label im Verlauf. Faellt der Call
aus, fehlt nur das Label - das Diktat laeuft unveraendert.

**D19 — Woerterbuch und Stil reisen im bestehenden Cleanup-Call mit.**
`appContext.cleanupExtras()` haengt Stil-Anweisung + korrekte Schreibweisen an
den Cleanup-System-Prompt an, statt einen zweiten Roundtrip zu bauen: null
zusaetzliche Latenz. `formal` haengt bewusst NICHTS an (das ist das
Default-Verhalten des Prompts, kuerzerer Prompt = weniger Tokens). Snippets
laufen dagegen rein lokal in `dictationEngine.js` und ZWINGEND nach
`normalizeSpacing` - davor wuerde aus `a.b@mail.com` ein `a. b@mail. com`.

**D20 — Transforms mit `Alt+Shift+<Buchstabe>`, nicht `Control+Alt+<n>`.** Riffs
`flowHold`-Default ist die reine Modifier-Kombi "Control+Alt" - ein
Transform-Hotkey `Control+Alt+1` wuerde beim Druecken zuverlaessig erst ein
echtes Diktat starten. Deshalb die Windows-Taste, wie im Vorbild. Registrierung
laeuft ueber Electrons `globalShortcut` (braucht immer eine Haupttaste, anders
als der Diktat-Watcher) und ist per Default AUS ("Opt in"), weil ein
Transform markierten Text in jeder App ueberschreibt. Schlaegt eine
Registrierung fehl (Kombination schon belegt), zeigt die Oberflaeche das an,
statt es zu verschlucken - und genau das hat beim Installationstest zweimal
gegriffen. Die Kombination wurde in zwei Runden GEMESSEN statt geraten:
1. Die nach dem Wispr-Screenshot gewaehlten `Super+Alt+1`/`Super+Alt+2` liessen
   sich gar nicht erst registrieren - Windows belegt Win+Alt+Ziffer selbst
   (Sprunglisten der Taskleiste). Elf Kandidaten gegen
   `globalShortcut.register` geprueft.
2. Der naheliegende Ersatz `Super+Alt+<Buchstabe>` registrierte sich zwar
   erfolgreich, loeste aber NIE aus - ein Transform-Versuch auf echten,
   markierten Text in Notepad liess den Text unveraendert. Gegen eine
   Electron-Sonde nachgemessen: `Super+Alt+P` kam nie im Callback an,
   `Alt+Shift+P` schon. Die Shell faengt Win-Kombinationen ab, bevor
   RegisterHotKey sie sieht. **Lehre: "registriert sich" ist nicht
   "funktioniert" - nur der Ende-zu-Ende-Test zaehlt.**
`store.js` migriert beide ueberholten Kombinationen bei genau den zwei
eingebauten Transforms still weiter; eine selbst gewaehlte Kombination bleibt
unberuehrt.

**D22 — Transforms warten auf das Loslassen der Modifier, bevor kopiert wird.**
Der eigentliche Grund, warum Transforms zunaechst wirkungslos blieben (D20 war
nur die halbe Wahrheit): `globalShortcut` feuert beim DRUECKEN der Haupttaste -
Alt/Shift sind zu dem Zeitpunkt noch unten. Das unmittelbar folgende Ctrl+C
kommt bei der Ziel-App als Ctrl+Alt+Shift+C an und kopiert NICHTS; die
Zwischenablage blieb leer, der Transform lief scheinbar durch, der markierte
Text blieb unveraendert. `transforms.js#waitForModifiersUp()` pollt jetzt
`mods_state` (Strg/Alt, links+rechts) plus `key_state` fuer Shift im
40ms-Raster, bis alle Modifier oben sind (Frist 2s, danach Bestenfalls-
Versuch). Ende-zu-Ende auf echtem markierten Text in Notepad verifiziert:
"also ich wollte halt eigentlich nur mal ganz kurz sagen dass das hier
irgendwie viel zu umstaendlich geschrieben ist" -> "Das ist mir zu umstaendlich
geschrieben." Zusaetzlich loggt `refreshShortcuts()` jetzt, welche Hotkeys
tatsaechlich registriert bzw. belegt sind - ein still nicht registrierter
Hotkey war die Fehlerart, die hier zweimal Zeit gekostet hat.

**D21 — Konto ueber den geteilten n8n-Auth-Workflow, Tier bleibt lokal.**
`account.js` spricht `n8n.halovisionai.cloud/webhook/accounts-auth`
("Accounts — Auth (Guardian + Riff)", Workflow `5xY8shjEqT4j1yjk`) mit
signup/login/request_reset/confirm_reset/verify. Der Workflow kennt kein
Tier-Feld: die Pro-Freischaltung bleibt komplett beim Code-Redemption (D4),
ein Login aendert sie nie - weder rauf noch runter. Anmelden ist nirgends
Voraussetzung; ohne Konto laeuft alles lokal weiter. Die Oberflaeche zeigt die
fertige Servermeldung (`reply`) statt einer eigenen Fehlercode-Tabelle, die bei
jeder Workflow-Aenderung veralten wuerde. Live verifiziert: Fehlversuch in der
App liefert "E-Mail oder Passwort ist falsch." aus dem echten Workflow.

**Blocker geloest (2026-07-29).** `riff-stt` lief lange auf 401 "Invalid API
Key" (Credentials "Mumat Groq API"/"Mumat OpenRouter API", beide
httpHeaderAuth in n8n, vermutlich abgelaufen). Geloest wurde das NICHT durch
Credential-Refresh, sondern durch kompletten Umbau des HTTP-Request-Node: statt
`openai/whisper-large-v3` ueber OpenRouters `/audio/transcriptions` (+Groq-
Provider-Pinning) laeuft der Node jetzt gegen `/chat/completions` mit
`google/gemini-3.5-flash-lite` (multimodaler `input_audio`-Content) und nutzt
die LangChain-Credential "OpenRouter account" (`GDFOYPAtBRjNOgyd`) - dieselbe,
die fuer `sable-chat` schon nachweislich funktioniert. `Normalize` liest jetzt
`body.choices[0].message.content` statt des alten Whisper-Response-Formats.
Live verifiziert: `ok:true`, echter Text zurueck. Nebenbefund: dieser Pfad
kann auf reinem Rauschen/Stille kurze plausibel klingende Phrasen halluzinieren
(Chat-Modell statt dediziertem ASR) - bei echter Sprache kein beobachtetes
Problem, aber ein Verhalten, das der alte Whisper-Pfad so nicht hatte. Wer
einen eigenen OpenRouter-Key in den Settings hinterlegt, bekommt weiterhin den
direkten `transcribeDirect`-Pfad (echtes Whisper via Groq) statt dieses
Fallbacks.

**D38 — STT-Modell in den Settings waehlbar, Parakeet TDT 0.6B v3 als neue
Option (2026-08-17).** `speechModel` (config.js) war zwar seit D0 ein Feld,
hatte aber nie eine UI - nur per Hand editierbarer Default. Jetzt ein
`<select>` in den Einstellungen (Whisper Turbo/Whisper Large/Parakeet TDT
0.6B v3), analog zum Sprach-Select. Default bleibt Whisper Large v3 Turbo
(Kostengrund von weiter oben gilt unveraendert) - Parakeet ist nur eine
zusaetzliche Option, kein neuer Default, trotz besserer Preis-Leistung laut
Nutzer-Recherche (Groq-Whisper-Turbo ist auf reinem $/Minute-Vergleich sogar
noch guenstiger, Parakeet gewinnt auf Qualitaet). `speechRecognition.js`
pinnt den `provider.order:['groq']`-Parameter nur noch fuer die beiden
Whisper-Modelle: Parakeet liegt auf OpenRouter nur bei einem Anbieter (nicht
Groq), ein Pin auf Groq wuerde dort schlicht keinen Treffer finden. Gilt fuer
den `transcribeDirect`-Pfad (eigener OpenRouter-Key).

**Nachtrag (2026-08-17, selber Tag):** Nutzerwunsch, das AUCH fuer den
n8n-Fallback nachzuziehen - der lief seit dem Fix vom 2026-07-29 ueber
`google/gemini-3.5-flash-lite` Chat-Completions statt eines echten
ASR-Endpoints (siehe Blocker-Eintrag oben) und kannte `speechModel` gar
nicht. Workflow `sMzWUdNhAqHAixA0` (n8n, umbenannt zu "Riff – STT (Parakeet
via OpenRouter)") laeuft jetzt wieder gegen den echten
`/audio/transcriptions`-Endpoint mit `nvidia/parakeet-tdt-0.6b-v3` - derselbe
Credential ("OpenRouter account", `GDFOYPAtBRjNOgyd`), der seit dem Fix
bewiesen funktioniert. Der 401 von damals kam nachweislich von einer
abgelaufenen ANDEREN Credential, nicht vom Endpoint - der Umweg ueber
Chat-Completions war also nie zwingend. `Normalize` liest wieder `body.text`
statt `body.choices[0].message.content`. Live verifiziert per curl direkt
gegen `n8n.halovisionai.cloud/webhook/riff-stt` (Stille-WAV, `language`
sowohl `auto` als `de`): `ok:true`, HTTP 200, leerer Text (korrekt fuer
Stille - kein Halluzinieren mehr wie beim Chat-Modell-Pfad).

## 2026-08-24 — Toggle-Diktat: Einzeldruck, fremde Shortcuts verwerfen, zwei Notausstiege

Bug-Report (per Riff selbst diktiert): "Strg+Alt+D drücken, die Bubble sollte
bleiben — sie geht aber sofort wieder weg", "wenn ich andere Shortcuts klicke,
geht sie einfach hoch". Vier Aenderungen, eine gemeinsame Ursache und zwei
Zusatzwuensche:

**Ursache (der eigentliche Bug):** `key_state` lieferte fuer eine Kombination
nur EIN Bit — `down`, und das schon exklusiv gegen Fremdtasten geprueft
(CONFLICT_VK-Scan). Sobald zu einem gehaltenen Strg+Alt eine dritte Taste kam,
sah das fuer `holdWatcher.js` exakt aus wie Loslassen: `holding` war true, also
lief `onHoldEnd` → `finish()` → STT-Call → **Paste in die fremde App**. Genau
das passierte bei jedem eigenen Strg+Alt+D (Bubble blitzt auf, verschwindet
wieder) und bei jedem fremden Strg+Alt+X-Shortcut. Der Helper gibt jetzt
zusaetzlich `raw` zurueck (Kombination physisch unten, ohne Exklusiv-Scan) —
`raw && !down` heisst "dritte Taste dazugekommen" und fuehrt ueber den neuen
`onHoldAbort` → `abortHold()` zum VERWERFEN statt Abschicken. Der zweite Scan
laeuft nur, wenn `raw` bereits wahr ist, kostet im Leerlauf also nichts.
Zusaetzlich: der AltGr-Fast-Path (50ms statt 250ms, siehe Kommentar in
`holdWatcher.js`) greift nicht mehr, wenn der Toggle-Hotkey die Hold-Kombi
erweitert ("ctrl+alt" steckt in "ctrl+alt+d") — sonst startet schon das Anlegen
der Modifier eine Hold-Session, bevor das D ueberhaupt unten ist.

**Doppel-Tap → Einzel-Tap.** `toggleWatcher.js` verlangte zwei Taps in 400ms.
Nutzer hat den Doppel-Tap in der Praxis nie zuverlaessig getroffen (und der
erste Tap ist mit dem Fehler oben ohnehin als Hold-Session weggegangen). Ein
Einzel-Tap ist hier gefahrlos, weil `flowToggle` anders als `flowHold` eine
echte Haupttaste enthaelt. `TAP_MAX_MS` dabei 220 → 600ms: eine bewusst
gedrueckte Dreier-Kombi ist laenger unten als ein Tippfehler. Die
Doppel-Tap-Buchhaltung faellt ersatzlos weg.

**Enter/Leertaste beenden eine laufende Toggle-Session** (Nutzerwunsch) — ueber
`globalShortcut` statt Tastatur-Polling, weil Electron die Taste dann SCHLUCKT:
die Leertaste landet nicht zusaetzlich als Zeichen in der App, in die gleich
gepastet wird. Nur waehrend einer Toggle-Session registriert.

**Zwei Notausstiege:** Aufnahme-Cap 5 → 10 Minuten, plus Stopp nach 60s ohne
jeden Ton (`SILENCE_STOP_MS`, RMS-Check auf den ohnehin ankommenden PCM-Chunks
— kein eigener Timer, keine neue VAD). Bewusst deutlich laenger als eine
Sprechpause: der Grundsatz aus dem Datei-Kopf von `dictationRouter.js` (eine
Denkpause mitten im Satz darf nie beenden) bleibt unangetastet.

Regression-Check in `test/check.js` (`npm test`, stubbt `helper.request`, laeuft
unter nacktem Node): Fremdtaste waehrend Hold → `abort`, echtes Loslassen →
`end`, ein kurzer Toggle-Druck → genau ein Tap, langes Halten → kein Tap.

---

## 2026-08-26 — "Vielen Dank" am Ende eines langen Diktats

Nutzer-Report: nach einem laengeren Diktat stand hinter dem echten Text noch
ein "Vielen Dank." Der Filter aus 2026-07-30 konnte das nie fangen — er
verglich das **ganze** Transkript mit der Phrasenliste und liess ein
angehaengtes Schlusswort per Definition durch.

**Ursache, nicht Symptom:** Whisper erfindet diese Floskeln auf **Stille**
(Untertitel-Trainingsdaten). Die Stille zwischen dem letzten gesprochenen Wort
und dem Stopp-Druck fuhr bisher bei jedem Diktat mit hoch. `trimSilence()` in
`silenceFilter.js` schneidet sie vorne und hinten weg (Frame-RMS, 250ms Rand,
damit leise An-/Auslaute bleiben) — was nicht hochgeladen wird, kann nichts
ausloesen. Nebeneffekt: weniger Upload, also schnelleres Diktat.

**Auffangnetz** `stripHallucination()` ersetzt `isHallucination()` und prueft
den letzten Satz statt das ganze Transkript. Zwei Listen, weil "Vielen Dank"
kein sauberes Signal ist:

- `NEVER_SPOKEN` ("Untertitel der Amara.org-Community", "Danke fuers
  Zuschauen", …) — faellt immer, das diktiert niemand.
- `AMBIGUOUS_PHRASES` ("Vielen Dank", "Tschuess", …) — als **ganzes**
  Transkript immer weg (wie bisher), als Schlusssatz nur, wenn die Aufnahme
  davor >= 1,5s still war. Sonst wuerde eine diktierte Mail, die echt mit
  "Vielen Dank." endet, still um ihren Gruss gekuerzt — der teurere Fehler.

Satzgrenze ist Satzzeichen **plus** Leerraum, damit "Amara.org" ein Wort
bleibt; Satzzeichen werden beim Normalisieren zu Leerraum, nicht geloescht.

`raw` im Verlauf bleibt das ungekuerzte Whisper-Ergebnis — sonst waere im
Nachhinein nicht mehr zu sehen, dass ueberhaupt etwas entfernt wurde.

Regression-Check in `test/check.js`: angehaengte Floskel nach Stille faellt,
dieselbe Floskel ohne Stille davor bleibt, "Vielen Dank fuer die Info, ruf
mich zurueck" wird nie angeschnitten, 3s Aufnahme mit 0,5s Sprache schrumpft
auf ~1s.

## 2026-09-04 — Voice Edit: Auswahl markieren, Anweisung sprechen, umschreiben

Nutzerwunsch: ein Transform, dessen Anweisung nicht fest hinterlegt ist,
sondern bei jedem Aufruf frei gesprochen wird ("kuerzer", "auf Englisch",
"foermlicher") - Wispr-Flow-Edit-Pendant zu den festen Presets ("Polish",
"Prompt Engineer").

**D39 — Voice Edit als dritte dictationRouter-Session-Art statt eigenes
Aufnahme-System.** `dictationRouter.js` kannte bisher genau zwei Session-Arten
(`hold`/`toggle`) und war fest verdrahtet, das Transkript am Ende IMMER zu
saeubern+pasten. Eine dritte Art `voice-edit` haengt sich an dieselbe
Aufnahme-/STT-Pipeline (Mikrofon, Whisper, Stille-/Halluzinations-Filter,
Wochenlimit-Check) - `finish()` ueberspringt fuer sie Cleanup/Paste/Verlauf
komplett und reicht das rohe Transkript stattdessen an einen Callback durch,
den `transforms.js` beim Start uebergibt (`startVoiceEdit(onText)`). Grund
gegen ein komplett eigenes Aufnahme-System: die gesamte Mikrofon-/Renderer-
IPC-Verdrahtung (`voice:pcm` etc., main.js) ist global auf GENAU einen
Consumer (dictationRouter) verdrahtet - ein zweiter Consumer haette diese
Verdrahtung verdoppelt, statt eine Session-Art zu ergaenzen.

**Ablauf (transforms.js `runVoiceEdit()`):** Hotkey (Default `Alt+Shift+V`,
eigenes Feld in den Transform-Einstellungen, NICHT Teil der
nutzerdefinierten transforms-Liste, weil kein fester Prompt existiert) →
Auswahl greifen (derselbe `grabSelection()`-Weg wie die Presets, Ctrl+C +
Zwischenablage-Polling) → `dictationRouter.startVoiceEdit()` startet die
Aufnahme, Bubble zeigt "listening" → zweiter Hotkey-Druck (oder Enter/
Leertaste, wie Toggle-Diktat) beendet sie → Transkript kommt als Anweisung
zurueck → EIN LLM-Call (`llm.chat`, derselbe Zwei-Routen-Pfad wie Cleanup/
Presets: eigener OpenRouter-Key oder n8n-Fallback `sable-chat` - **kein
n8n-Workflow musste geaendert werden**, der Webhook nimmt beliebige
system/user-Prompts entgegen) mit System-Prompt "schreibe den Text exakt nach
der Anweisung um" + `Anweisung: … / Text: …` als User-Message → Ergebnis wird
per `typingEngine.typeText()` ueber die Auswahl gepastet, Zwischenablage
danach auf den Original-Inhalt des Nutzers zurueckgesetzt (identisch zu den
Presets).

**Kein Klick-Icon zum Beenden.** Die Toggle-Bubble-Groesse mit Haken/Kreuz
haengt an fest verdrahteter `kind === 'toggle'`-Semantik in `voice:toggle-
confirm`/`-cancel` (main.js/dictationRouter.js) - ein Klick waere bei
`kind === 'voice-edit'` wirkungslos verpufft. Bewusst NICHT mitgezogen (haette
die IPC-Handler kind-generisch machen muessen, fuer eine zweite
Beendigungs-Option, die es mit Enter/Leertaste/zweitem Hotkey-Druck schon
gibt) - Voice Edit bekommt die schmale "normal"-Bubble ohne Buttons.

**Vier Ausstiegspunkte in `finish()`, nicht einer.** Stille erkannt, STT
fehlgeschlagen, Transkript nach Halluzinations-Filter leer, echter Text da -
jeder davon braucht seinen eigenen `finishVoiceEdit(text)`-Aufruf, sonst
bleibt `transforms.js`s `busy`-Flag fuer immer haengen (der Callback waere nie
gekommen). Fuenfter Pfad `onLocalError` (Mikrofon-Berechtigung abgelehnt)
ebenfalls nachgezogen - vorher haette ein verweigerter Mikrofon-Zugriff
waehrend Voice Edit Riff bis zum Neustart "busy" gelassen.

Kein Regression-Check in `test/check.js`: `dictationRouter.js`/`transforms.js`
haben `electron` im require-Baum (globalShortcut/clipboard), laufen also nicht
unter nacktem Node - wie beim Rest dieser beiden Dateien ist der echte
`npm start`-Boot der Pruef-Weg (verifiziert: Hotkey registriert sich sauber
neben den bestehenden Presets, keine Kollision, kein Crash beim Laden).
