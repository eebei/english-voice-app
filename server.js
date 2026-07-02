require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { buildSystem } = require('./prompts');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Verify API key is set
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY is not set in .env file');
  console.error('Please copy .env.example to .env and add your API key.');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Stripe（課金）──未設定でもサイトは動く ──
let stripe = null;
try {
  const StripeLib = require('stripe');
  if (process.env.STRIPE_SECRET_KEY) stripe = new StripeLib(process.env.STRIPE_SECRET_KEY);
} catch (e) { console.warn('[stripe] lib not installed:', e.message); }
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

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

// ── Stripe Webhook（署名検証のため“生ボディ”が必要。JSONパーサより前に置く）──
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'stripe_unavailable' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe] signature verify failed:', err.message);
    return res.status(400).send('bad signature');
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const email = (s.customer_details && s.customer_details.email) || s.customer_email;
      await auth.setMemberByEmail(email, {
        plan: 'founding',
        stripeCustomerId: s.customer,
        subscriptionStatus: 'active',
      });
      console.log('[stripe] checkout completed → member:', email);
    } else if (event.type === 'customer.subscription.deleted') {
      await auth.unsetMemberByCustomer(event.data.object.customer, 'canceled');
    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      if (['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status)) {
        await auth.unsetMemberByCustomer(sub.customer, sub.status);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] webhook handler error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cap request body size → bounds the cost of any single call.
// ※ /api/stt は音声(base64 WAV)を送るため大きい。ここでは弾かず、ルート側の 4mb パーサに任せる。
app.use((req, res, next) => {
  if (req.path === '/api/stt') return next();
  return express.json({ limit: '128kb' })(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));

// Founding 枠の残り（サイトの「参加」ボタンの出し分けに使う）
app.get('/api/founding/status', async (_req, res) => {
  try { res.json(await auth.foundingStatus()); }
  catch { res.json({ members: 0, cap: 50, spotsLeft: 50, soldOut: false }); }
});

// ── 会員基盤（マジックリンク認証） ───────────────────────────────────────────
// 現在ユーザーをreqに付与（未ログイン/未設定ならreq.user=null。既存機能は不変）。
app.use(auth.attachUser);

// メールアドレス → ログインリンクを送る
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.post('/api/auth/request', authLimiter, async (req, res) => {
  try {
    if (!auth.isReady()) return res.status(503).json({ error: 'auth_unavailable' });
    const { email, product } = req.body || {};
    const r = await auth.requestMagicLink(email, product);
    res.json({ ok: true, sent: r.sent !== false });
  } catch (err) {
    const map = { invalid_email: 400, auth_not_ready: 503 };
    res.status(map[err.message] || 500).json({ error: err.message });
  }
});

// リンククリック → セッション発行 → アプリへ戻す
app.get('/api/auth/verify', async (req, res) => {
  try {
    if (!auth.isReady()) return res.status(503).send('auth unavailable');
    const { user, token } = await auth.verifyMagicToken(req.query.token);
    const product = req.query.product === 'pitwall' ? 'pitwall' : 'racevoice';
    // トークンをフロントに渡すため、簡易な完了ページを返す（localStorageに保存→アプリへ）
    res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8">
<title>OMORAY ログイン完了</title>
<body style="font-family:system-ui,sans-serif;background:#0a0a0a;color:#eee;text-align:center;padding:15vh 20px">
<h2 style="color:#9D4EDD">ログイン完了 ✅</h2>
<p>${user.email}</p>
<p id="msg">アプリに戻ります…</p>
<script>
  try{ localStorage.setItem('omoray_token', ${JSON.stringify(token)}); }catch(e){}
  // PITWALLデスクトップ用：トークンをコード表示（アプリに貼り付け）
  var isPitwall = ${JSON.stringify(product === 'pitwall')};
  if(isPitwall){
    document.getElementById('msg').innerHTML =
      'このコードをアプリに貼り付けてください：<br><textarea readonly style="width:90%;height:80px;margin-top:10px">' +
      ${JSON.stringify(token)} + '</textarea>';
  } else {
    setTimeout(function(){ location.href='/'; }, 1200);
  }
</script></body>`);
  } catch (err) {
    res.status(400).set('Content-Type', 'text/html; charset=utf-8')
      .send('<body style="font-family:sans-serif;padding:40px">リンクが無効か期限切れです。もう一度お試しください。<br>Link invalid or expired.</body>');
  }
});

// 現在のログイン状態
app.get('/api/auth/me', (req, res) => {
  res.json({ user: auth.publicUser(req.user) });
});

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

    // ── PITWALL課金ゲート ──
    // exe(PITWALL)は product:'pitwall' を送る。課金者(is_member)のみ許可。
    // RaceVoice(無料)や旧クライアントは product を送らない → 従来通り通す。
    if (req.body.product === 'pitwall') {
      if (!auth.isReady()) return res.status(503).json({ error: 'auth_unavailable' });
      if (!req.user) return res.status(401).json({ error: 'login_required' });
      if (!req.user.is_member) return res.status(403).json({ error: 'membership_required' });
    }

    // ── Build the system prompt SERVER-SIDE (crown jewels never leave the server) ──
    // prefix(キャラ固定部分)に prompt cache を効かせてAPIコストを大幅削減。suffix(動的)は非キャッシュ。
    // クライアントが system を送ってこない場合はサーバー側でキャラのプロンプトを構築する
    // （crown jewels をサーバーに保持。デスクトップ/RaceVoice双方に自動適用）。
    if (character && (req.body.useServerPrompt || !system)) {
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
    let safeMaxTokens = Math.min(Math.max(parseInt(max_tokens, 10) || 300, 1), MAX_TOKENS_CAP);
    // レース無線は物理的にも短く（長文の暴走を防ぐバックストップ）
    if (mode === 'race') safeMaxTokens = Math.min(safeMaxTokens, 100);

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

// ── Google Speech-to-Text proxy (PTT: 押してる間の音声→文字) ───────────────────
// クライアントが録音した音声(base64)を受けてGoogle STTで文字起こし。
// ※同じGOOGLE_TTS_API_KEYを使うが、Google CloudでSpeech-to-Text APIの有効化＋
//   APIキー制限にSpeech-to-Textを追加する必要がある（TTSのみ許可だと動かない）。
app.post('/api/stt', ttsLimiter, express.json({ limit: '4mb' }), async (req, res) => {
  try {
    if (!TTS_API_KEY) return res.status(503).json({ error: 'stt_unavailable' });
    const { audio, languageCode, encoding, sampleRateHertz } = req.body;
    if (!audio || typeof audio !== 'string') {
      return res.status(400).json({ error: 'audio is required' });
    }
    const sttBody = {
      config: {
        encoding: encoding || 'WEBM_OPUS',
        languageCode: languageCode || 'en-US',
        enableAutomaticPunctuation: true,
        model: 'latest_short',
      },
      audio: { content: audio },
    };
    if (sampleRateHertz) sttBody.config.sampleRateHertz = sampleRateHertz;

    const r = await fetch(
      `https://speech.googleapis.com/v1/speech:recognize?key=${TTS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sttBody),
      }
    );
    if (!r.ok) {
      const errText = await r.text();
      console.error('Google STT error:', r.status, errText);
      return res.status(502).json({ error: 'stt_failed', detail: errText.slice(0, 200) });
    }
    const data = await r.json();
    const text = (data.results || [])
      .map(x => x.alternatives && x.alternatives[0] && x.alternatives[0].transcript)
      .filter(Boolean).join(' ').trim();
    res.json({ text });
  } catch (err) {
    console.error('STT proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ────────────────────────────────────────────────────────────
// 会員基盤を初期化（env未設定なら静かに無効化＝既存機能は不変）。失敗してもサーバーは起動。
auth.init().catch(err => console.error('[auth] init failed (site still runs):', err.message));

app.listen(PORT, () => {
  console.log('');
  console.log('  ✅  English Voice Practice is running!');
  console.log(`  🌐  Open → http://localhost:${PORT}`);
  console.log(`  🔐  Auth: ${auth.isConfigured() ? 'configured' : 'DISABLED (set DATABASE_URL + JWT_SECRET)'}`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
