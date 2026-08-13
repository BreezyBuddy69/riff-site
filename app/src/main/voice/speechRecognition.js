// Online-Route fuer Speech-to-Text: OpenRouter /audio/transcriptions (Whisper-kompatibel),
// entweder direkt mit dem eigenen Key ODER - falls keiner in config.json hinterlegt ist -
// ueber Riffs n8n-Fallback-Webhook (n8n haelt dort einen eigenen OpenRouter-Key, siehe
// DECISIONS.md D5). JSON+Base64 statt multipart, weil nur das JSON-Format laut OpenRouter-
// Doku zuverlaessig den `provider`-Parameter unterstuetzt: `order: ['groq']` erzwingt Groqs
// Whisper-Inferenz (~200x Realtime statt eines langsameren Default-Anbieters) - der groesste
// Hebel gegen die 3-5s Diktier-Latenz. Kein hartes Pinning (kein allow_fallbacks:false) -
// ist Groq fuer ein Modell nicht verfuegbar, routet OpenRouter automatisch anders.
const { encodeWav } = require('./wav');

const N8N_STT_URL = 'https://n8n.halovisionai.cloud/webhook/riff-stt';

async function transcribeDirect(cfg, base64Wav, opts) {
  const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
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
      provider: { order: ['groq'] },
    }),
    signal: AbortSignal.timeout(opts.partial ? 8000 : 15000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, text: '', error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
  }
  const data = await res.json();
  return { ok: true, text: data.text || '', error: null };
}

// Kein lokaler Key -> Riffs eigener n8n-Webhook uebernimmt denselben Job (Groq-Whisper
// ueber ein in n8n hinterlegtes OpenRouter-Konto) - der Nutzer braucht dafuer nie einen
// eigenen Key (Wispr-Flow-Prinzip).
async function transcribeViaN8n(base64Wav, language, opts) {
  const res = await fetch(N8N_STT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioBase64: base64Wav, language: language && language !== 'auto' ? language : 'auto' }),
    signal: AbortSignal.timeout(opts.partial ? 12000 : 20000),
  });
  if (!res.ok) return { ok: false, text: '', error: `HTTP ${res.status}` };
  const data = await res.json();
  return { ok: !!data.ok, text: data.text || '', error: data.error || null };
}

// Whisper unterstuetzt einen `prompt`-Parameter als Vokabular-Hinweis (bekannte
// Schreibweisen VOR der Erkennung statt hinterher zu korrigieren) - genau der
// Punkt, an dem oft gesagte Woerter am billigsten richtig ankommen. Nur der
// transcribeDirect-Pfad (echtes Whisper via Groq) nutzt das; der n8n-Fallback
// laeuft inzwischen ueber ein Chat-Modell ohne dieses Feld (DECISIONS.md).
// ponytail: harte Zeichenobergrenze statt Tokenbudget - Whisper-Prompts sind
// ohnehin auf ~224 Tokens gedeckelt, ein grosses Woerterbuch wuerde sonst
// stillschweigend abgeschnitten.
function vocabularyPrompt(dictionary) {
  const terms = (dictionary || []).map((d) => d.term).filter(Boolean);
  return terms.length ? terms.join(', ').slice(0, 800) : undefined;
}

async function transcribe(cfg, pcmBuffer, sampleRate, opts = {}) {
  try {
    const base64Wav = encodeWav(pcmBuffer, sampleRate).toString('base64');
    return cfg.voice.openRouterApiKey
      ? await transcribeDirect(cfg, base64Wav, opts)
      : await transcribeViaN8n(base64Wav, cfg.voice.language, opts);
  } catch (err) {
    return { ok: false, text: '', error: err.message || 'NETWORK_ERROR' };
  }
}

module.exports = { transcribe, vocabularyPrompt };
