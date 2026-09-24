// Online-Route fuer Speech-to-Text: OpenRouter /audio/transcriptions,
// entweder direkt mit dem eigenen Key ODER - falls keiner in config.json
// hinterlegt ist - ueber Riffs n8n-Fallback-Webhook (n8n haelt dort einen
// eigenen OpenRouter-Key, siehe DECISIONS.md D5). JSON+Base64 statt multipart,
// weil OpenRouter das fuer beide Modellfamilien akzeptiert.
//
// WICHTIG (OpenRouter-Doku 2026): die Transcription-Route unterstuetzt KEIN
// per-Request-Provider-Routing - ein `provider: { order: [...] }`-Block wird
// komplett ignoriert. Ein Groq-Pin lief hier also nie; fuer Whisper-Modelle
// waehlt OpenRouter den Anbieter selbst und der Default ist nicht
// garantiert der schnellste. Qualitaet+Schnelligkeit steuert ALLEIN die
// Modellwahl: Default ist inzwischen openai/gpt-4o-mini-transcribe (OpenAI
// direkt, ~0.7s Latenz, bessere Deutsche Erkennung als Whisper).
//
// net.fetch (Chromium-Netzwerkstack) statt Nodes fetch (D41): haelt HTTP/2-
// Verbindungen ueber Minuten warm und nutzt den System-Proxy - gemessen ~20ms
// statt ~40-50ms pro Anfrage auf warmer Verbindung, ~80ms statt ~160ms kalt.
// Unter nacktem Node (test/check.js) gibt es kein net - dann Nodes fetch.
const { net } = require('electron');
const { encodeWav } = require('./wav');

const N8N_STT_URL = 'https://n8n.halovisionai.cloud/webhook/riff-stt';
const OPENROUTER_STT_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

const httpFetch = (url, init) => (net && net.fetch ? net.fetch(url, init) : fetch(url, init));

async function transcribeDirect(cfg, base64Wav, opts) {
  const res = await httpFetch(OPENROUTER_STT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.voice.openRouterApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.voice.speechModel,
      input_audio: { data: base64Wav, format: 'wav' },
      ...(cfg.voice.language && cfg.voice.language !== 'auto' ? { language: cfg.voice.language } : {}),
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, text: '', error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
  }
  const data = await res.json();
  return { ok: true, text: data.text || '', error: null };
}

// Kein lokaler Key -> Riffs eigener n8n-Webhook uebernimmt denselben Job (Parakeet
// ueber ein in n8n hinterlegtes OpenRouter-Konto) - der Nutzer braucht dafuer nie einen
// eigenen Key (Wispr-Flow-Prinzip).
async function transcribeViaN8n(base64Wav, language) {
  const res = await httpFetch(N8N_STT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioBase64: base64Wav, language: language && language !== 'auto' ? language : 'auto' }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return { ok: false, text: '', error: `HTTP ${res.status}` };
  const data = await res.json();
  return { ok: !!data.ok, text: data.text || '', error: data.error || null };
}

// Whisper/GPT-4o-Transcribe nehmen einen `prompt` als Vokabular-Hinweis
// (bekannte Schreibweisen VOR der Erkennung statt hinterher zu korrigieren).
// Nur der transcribeDirect-Pfad nutzt ihn; Parakeet (n8n) kennt das Feld nicht.
// ponytail: harte Zeichenobergrenze statt Tokenbudget - Whisper-Prompts sind
// ohnehin auf ~224 Tokens gedeckelt, ein grosses Woerterbuch wuerde sonst
// stillschweigend abgeschnitten.
function vocabularyPrompt(dictionary) {
  const terms = (dictionary || []).map((d) => d.term).filter(Boolean);
  return terms.length ? terms.join(', ').slice(0, 800) : undefined;
}

// "Kein Netz" ist fuer den Nutzer eine andere Aussage als "Server kaputt" -
// Chromium meldet es als net::ERR_INTERNET_DISCONNECTED/NAME_NOT_RESOLVED,
// Node als ENOTFOUND/ECONNREFUSED/"fetch failed".
function isOfflineError(message) {
  return /INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|ADDRESS_UNREACHABLE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|fetch failed/i
    .test(String(message || ''));
}

async function once(route, cfg, base64Wav, opts) {
  try {
    return route === 'direct'
      ? await transcribeDirect(cfg, base64Wav, opts)
      : await transcribeViaN8n(base64Wav, cfg.voice.language);
  } catch (err) {
    return { ok: false, text: '', error: err.message || 'NETWORK_ERROR' };
  }
}

// Ein Diktat darf nicht an einem einzelnen Netzwerk-Wackler sterben (D41):
// schlaegt die erste Route fehl, geht es EINMAL ueber die andere (eigener Key
// <-> n8n). Ohne Key gibt es nur n8n - dann derselbe Weg ein zweites Mal.
async function transcribe(cfg, pcmBuffer, sampleRate, opts = {}) {
  const base64Wav = encodeWav(pcmBuffer, sampleRate).toString('base64');
  const primary = cfg.voice.openRouterApiKey ? 'direct' : 'n8n';
  const first = await once(primary, cfg, base64Wav, opts);
  if (first.ok) return first;
  console.warn(`[stt] ${primary} fehlgeschlagen (${first.error}) - zweiter Versuch ueber n8n`);
  const second = await once('n8n', cfg, base64Wav, opts);
  if (second.ok) return second;
  return { ...second, offline: isOfflineError(first.error) && isOfflineError(second.error) };
}

// Verbindung zum STT-Host oeffnen, WAEHREND gesprochen wird - der TLS-
// Handshake liegt dann nicht mehr zwischen "Taste los" und "Text da".
// Antwort egal, das Pooling greift pro Origin.
function prewarm(cfg) {
  const url = cfg.voice.openRouterApiKey ? 'https://openrouter.ai/api/v1/models' : N8N_STT_URL;
  httpFetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).catch(() => {});
}

module.exports = { transcribe, prewarm, vocabularyPrompt, isOfflineError, httpFetch };
