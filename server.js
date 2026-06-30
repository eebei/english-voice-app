require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { buildSystem } = require('./prompts');

const app = express();
const PORT = process.env.PORT || 3000;

// Verify API key is set
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY is not set in .env file');
  console.error('Please copy .env.example to .env and add your API key.');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Abuse / cost guards (server-side, never trust the client) ─────────────────
const MAX_TOKENS_CAP = 2000;   // legit usage tops out at 1500
const MAX_MESSAGES   = 100;    // cap conversation length per request
const MAX_SYSTEM_LEN = 20000;  // cap system prompt size (chars)

// ── Security middleware ───────────────────────────────────────────────────────
app.set('trust proxy', 1); // Railway sits behind a proxy → needed for real client IP

app.use(helmet({
  // index.html uses inline scripts/styles; don't break it with a strict CSP here.
  contentSecurityPolicy: false,
}));

// Only allow the app's own front-end (and local dev) to call the API from a browser.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://english-voice-app-production.up.railway.app,http://localhost:3000')
  .split(',').map(s => s.trim());
app.use(cors({
  origin(origin, cb) {
    // same-origin / curl / mobile webview have no Origin header → allow
    // 'null' = Electronデスクトップアプリ(file://)が送るオリジン。デスクトップ版を許可。
    //   ※本命の防御はアカウント実装時のトークン認証。CORSは補助。レート制限で当面ガード。
    if (!origin || origin === 'null' || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
}));

// Cap request body size → bounds the cost of any single call.
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Per-IP rate limit on the chat endpoint (the driver's conversation — never starve this).
// レース中は会話が生命線。十分余裕を持たせる。
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,              // 120 chat requests / minute / IP（会話を絶対に弾かない）
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// TTS は別枠。自動ラジオの音声化で消費するため独立した余裕枠を持つ。
const ttsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,              // 200 TTS requests / minute / IP（ラジオ＋会話の音声化）
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'tts_rate_limited' },
});

// ── Chat proxy ──────────────────────────────────────────────────────────────
app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    let { system, messages, max_tokens = 300, userName, character, mode } = req.body;

    // ── Build the system prompt SERVER-SIDE (crown jewels never leave the server) ──
    // prefix(キャラ固定部分)に prompt cache を効かせてAPIコストを大幅削減。suffix(動的)は非キャッシュ。
    if (req.body.useServerPrompt && character) {
      const built = buildSystem(req.body);
      if (built) {
        system = [
          { type: 'text', text: built.prefix, cache_control: { type: 'ephemeral' } }
        ];
        if (built.suffix) system.push({ type: 'text', text: built.suffix });
      }
    }

    // ── Input validation (reject abusive / malformed payloads) ──
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }
    if (messages.length > MAX_MESSAGES) {
      return res.status(400).json({ error: 'conversation too long' });
    }
    if (typeof system === 'string' && system.length > MAX_SYSTEM_LEN) {
      return res.status(400).json({ error: 'system prompt too long' });
    }

    // Never trust the client's token count — clamp it server-side.
    const safeMaxTokens = Math.min(Math.max(parseInt(max_tokens, 10) || 300, 1), MAX_TOKENS_CAP);

    // ユーザーログ（Railway のログで確認可能）
    if (userName) {
      const now = new Date().toISOString();
      console.log(`[${now}] 👤 ${userName} | 🎭 ${character || '?'} | 💬 turn ${messages.filter(m=>m.role==='user').length}`);
    }

    // Race mode: Haiku (2-3x faster, sufficient for short radio calls)
    const model = (mode === 'race') ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-5';

    const response = await client.messages.create({
      model,
      max_tokens: safeMaxTokens,
      system,
      messages,
    });

    res.json(response);
  } catch (err) {
    console.error('Anthropic API error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Google Cloud TTS proxy ────────────────────────────────────────────────────
// テキスト → MP3 base64。APIキーはサーバー側のみ（クライアントに漏らさない）。
const TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY;
const MAX_TTS_CHARS = 600;  // 1コールの上限（コスト保護）

app.post('/api/tts', ttsLimiter, async (req, res) => {
  try {
    if (!TTS_API_KEY) {
      return res.status(503).json({ error: 'tts_unavailable' });
    }
    let { text, voice, languageCode, rate, pitch } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }
    text = text.slice(0, MAX_TTS_CHARS);

    const ttsBody = {
      input: { text },
      voice: {
        languageCode: languageCode || 'en-GB',
        name: voice || 'en-GB-Neural2-B',
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: Math.min(Math.max(parseFloat(rate) || 1.0, 0.5), 2.0),
        pitch: Math.min(Math.max(parseFloat(pitch) || 0, -20), 20),
      },
    };

    const r = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${TTS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ttsBody),
      }
    );
    if (!r.ok) {
      const errText = await r.text();
      console.error('Google TTS error:', r.status, errText);
      return res.status(502).json({ error: 'tts_failed' });
    }
    const data = await r.json();
    res.json({ audioContent: data.audioContent });  // base64 MP3
  } catch (err) {
    console.error('TTS proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ✅  English Voice Practice is running!');
  console.log(`  🌐  Open → http://localhost:${PORT}`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
