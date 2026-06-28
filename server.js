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
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
}));

// Cap request body size → bounds the cost of any single call.
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Per-IP rate limit on the expensive endpoint.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,               // 30 requests / minute / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
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

// ── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ✅  English Voice Practice is running!');
  console.log(`  🌐  Open → http://localhost:${PORT}`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
