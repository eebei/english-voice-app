require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const strategyGuard = require('./strategy-guard');
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

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 25000,  // 25秒でタイムアウト（exe fetch timeout: 30秒より短く）
  httpClient: require('@anthropic-ai/sdk').defaultHttpClient,
});

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
  'https://www.omoraypitwall.com,https://omoraypitwall.com,http://localhost:3000')
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
      const displayName = s.customer_details && s.customer_details.name;
      const result = await auth.setMemberByEmail(email, {
        plan: 'founding',
        stripeCustomerId: s.customer,
        subscriptionStatus: 'active',
        displayName,
      });
      console.log('[stripe] checkout completed → member:', email, 'justActivated:', result.justActivated);
      const anonId = (s.metadata && s.metadata.anon_id) || '';
      const isTest = !event.livemode;
      try {
        await auth.recordFunnelEvent({ event: 'checkout_completed', anon_id: anonId, extra: { stripe_customer: s.customer }, idempotency_key: 'checkout_' + s.id, is_test: isTest });
        if (result.justActivated) {
          await auth.recordFunnelEvent({ event: 'trial_started', anon_id: anonId, extra: { stripe_customer: s.customer }, idempotency_key: 'trial_' + s.id, is_test: isTest });
        }
      } catch (e) { console.error('[stripe] funnel event failed:', e.message); }
      if (result.justActivated) {
        auth.sendWelcomeEmail(email, result.plan).catch((e) => console.error('[stripe] welcome email failed:', e.message));
      }
      try {
        const cf = Array.isArray(s.custom_fields) ? s.custom_fields.find(f => f.text && f.text.value) : null;
        if (cf) await auth.recordReferralAttribution(email, cf.text.value);
      } catch (e) { console.error('[stripe] referral attribution failed:', e.message); }
    } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
      // Grow the Grid：友達の"初回実課金"（トライアル明けの最初の支払い）で紹介カウント＋クーポン適用。
      // amount_paid > 0 が実課金の証（トライアル開始時の$0請求は billing_reason=subscription_create かつ 0円）。
      // 2ヶ月目以降の請求もここを通るが、referral_conversionsのPRIMARY KEYで二重加算は起きない。
      const inv = event.data.object;
      const isTestInv = !event.livemode;
      if (inv.amount_paid > 0 && inv.customer && inv.billing_reason === 'subscription_cycle') {
        let invAnonId = '';
        try {
          if (inv.subscription && stripe) {
            const sub = await stripe.subscriptions.retrieve(inv.subscription);
            invAnonId = (sub.metadata && sub.metadata.anon_id) || '';
          }
        } catch {}
        try {
          await auth.recordFunnelEvent({ event: 'first_paid_invoice', anon_id: invAnonId, extra: { stripe_customer: inv.customer, amount: inv.amount_paid }, idempotency_key: 'first_paid_' + inv.customer, is_test: isTestInv });
        } catch (e) { console.error('[stripe] funnel paid event failed:', e.message); }
        try {
          const r = await auth.countReferralConversion(inv.customer);
          if (r && r.ok) console.log('[stripe] grow-the-grid conversion:', JSON.stringify(r));
        } catch (e) { console.error('[stripe] referral conversion failed:', e.message); }
      }
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
// ルート直打ち（ .../ ）は PITWALL LP を見せる。Founding客がドメイン直打ちで来ても
// 旧RaceVoiceページでなくPITWALLが出る。RaceVoiceは /index.html で引き続きアクセス可。
app.get('/', (_req, res) => res.redirect(302, '/pitwall.html'));
app.use(express.static(path.join(__dirname, 'public')));

// Founding 枠の残り（サイトの「参加」ボタンの出し分けに使う）
app.get('/api/founding/status', async (_req, res) => {
  try { res.json(await auth.foundingStatus()); }
  catch { res.json({ members: 0, cap: 50, spotsLeft: 50, soldOut: false }); }
});

// ── ベータ・アクセスコード照合（exe起動ゲート／八木さん・Tobi等） ──
const betaLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.post('/api/beta/verify', betaLimiter, express.json(), async (req, res) => {
  try {
    const { code, deviceId } = req.body || {};
    const r = await auth.verifyBetaToken(code, deviceId);
    if (r.ok) return res.json({ ok: true, name: r.name, tier: r.tier });
    return res.status(403).json({ ok: false, reason: r.reason || 'denied' });
  } catch (err) {
    res.status(500).json({ ok: false, reason: 'error' });
  }
});

// ── ベータコード管理（Yuji専用・ADMIN_SECRETヘッダで保護） ──
//   発行:   POST /api/beta/admin/create {name,tier,billingStart}
//   一覧:   GET  /api/beta/admin/list
//   無効化: POST /api/beta/admin/revoke {code}   / 再有効化: {code,active:true}
// (removed) one-time /api/beta/bootstrap seeder and /api/beta/admin/_debug diagnostic —
//   beta tokens are already seeded in the DB; these launch-prep helpers are no longer needed.
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'admin_disabled (set ADMIN_SECRET)' });
  const given = req.headers['x-admin-secret'] || (req.query && req.query.secret);
  if (given !== secret) return res.status(401).json({ error: 'unauthorized' });
  next();
}
app.post('/api/beta/admin/create', requireAdmin, express.json(), async (req, res) => {
  try {
    const { name, tier, billingStart } = req.body || {};
    const r = await auth.createBetaToken({ name, tier, billingStart });
    res.json({ ok: true, ...r });
  } catch (err) { res.status(500).json({ ok: false, error: String(err.message || err) }); }
});
app.get('/api/beta/admin/list', requireAdmin, async (_req, res) => {
  try { res.json({ ok: true, tokens: await auth.listBetaTokens() }); }
  catch (err) { res.status(500).json({ ok: false, error: String(err.message || err) }); }
});
app.post('/api/beta/admin/revoke', requireAdmin, express.json(), async (req, res) => {
  try {
    const { code, active } = req.body || {};
    const r = await auth.setBetaActive(code, active === true);
    res.json(r);
  } catch (err) { res.status(500).json({ ok: false, error: String(err.message || err) }); }
});

// ── Founding Checkout（LP→Stripe Checkout直行・5日トライアル付き） ──
app.post('/api/founding/checkout', express.json(), async (req, res) => {
  try {
    const { anon_id, lang, referral_code } = req.body || {};
    const r = await auth.createFoundingCheckout({ anon_id, lang, referral_code });
    res.json({ ok: true, url: r.url });
  } catch (err) {
    console.error('[founding] checkout creation failed:', err.message);
    res.status(503).json({ ok: false, error: err.message === 'price_not_configured' ? 'price_not_configured' : 'unavailable' });
  }
});

// ── テスター応募（Super Formula / IndyCar / GTP / 言語開発など、選考が必要なプログラム専用） ──
const applyLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });
const VALID_DISCIPLINES = ['road', 'oval', 'dirt_road', 'dirt_oval'];
const VALID_LANGUAGES = ['en', 'ja', 'de', 'other'];
const VALID_PROGRAMS = ['open_wheel', 'prototype', 'german_language', 'portuguese_language', 'general'];
app.post('/api/tester/apply', applyLimiter, express.json(), async (req, res) => {
  try {
    if (!auth.isReady()) return res.status(503).json({ ok: false, error: 'unavailable' });
    const d = req.body || {};
    if (!d.email || !d.series || !d.discipline || !d.language || !d.program) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }
    if (d.consent !== true) {
      return res.status(400).json({ ok: false, error: 'consent_required' });
    }
    if (typeof d.email !== 'string' || !d.email.includes('@') || d.email.length > 320) {
      return res.status(400).json({ ok: false, error: 'invalid_email' });
    }
    if (!VALID_DISCIPLINES.includes(d.discipline)) {
      return res.status(400).json({ ok: false, error: 'invalid_discipline' });
    }
    if (!VALID_LANGUAGES.includes(d.language)) {
      return res.status(400).json({ ok: false, error: 'invalid_language' });
    }
    if (!VALID_PROGRAMS.includes(d.program)) {
      return res.status(400).json({ ok: false, error: 'invalid_program' });
    }
    if (d.series && d.series.length > 200) d.series = d.series.slice(0, 200);
    if (d.expectations && d.expectations.length > 1000) d.expectations = d.expectations.slice(0, 1000);
    if (d.discord && d.discord.length > 100) d.discord = d.discord.slice(0, 100);
    const row = await auth.createFoundingApplication(d);
    res.json({ ok: true, id: row.id });
  } catch (err) { res.status(500).json({ ok: false, error: 'server_error' }); }
});
app.get('/api/tester/applications', requireAdmin, async (_req, res) => {
  try { res.json({ ok: true, applications: await auth.listFoundingApplications() }); }
  catch (err) { res.status(500).json({ ok: false, error: String(err.message || err) }); }
});

// ── ファネルイベント ──
const CLIENT_EVENTS = [
  'lp_view', 'primary_cta_click', 'checkout_started',
  'founding_apply_start', 'founding_apply_complete', 'discord_click',
  'app_download_click',
  'share_page_open', 'share_copy_click',
];
const funnelLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.post('/api/funnel/event', funnelLimiter, express.json(), async (req, res) => {
  try {
    if (!auth.isReady()) return res.status(204).end();
    const d = req.body || {};
    if (!d.event || !CLIENT_EVENTS.includes(d.event)) return res.status(400).json({ ok: false });
    if (d.anon_id && (typeof d.anon_id !== 'string' || d.anon_id.length > 64)) {
      return res.status(400).json({ ok: false });
    }
    await auth.recordFunnelEvent(d);
    res.json({ ok: true });
  } catch { res.status(204).end(); }
});
app.get('/api/funnel/stats', requireAdmin, async (_req, res) => {
  try { res.json({ ok: true, stats: await auth.getFunnelStats() }); }
  catch (err) { res.status(500).json({ ok: false, error: String(err.message || err) }); }
});

// ── 課金会員（Founding Season等）の強制遮断／復帰（Stripe解約を待たず即座に反映・悪質ユーザー対応） ──
//   POST /api/admin/member/revoke {email}            → 即座にis_member=false
//   POST /api/admin/member/revoke {email,active:true} → 復帰
app.post('/api/admin/member/revoke', requireAdmin, express.json(), async (req, res) => {
  try {
    const { email, active } = req.body || {};
    const r = await auth.setMemberActive(email, active === true);
    res.json(r);
  } catch (err) { res.status(500).json({ ok: false, error: String(err.message || err) }); }
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
    // 自己解約リンク（manage.html発）：ログイン確認後そのままStripe Billing Portalへ飛ばす。
    if (req.query.product === 'portal') {
      try {
        const portalUrl = await auth.createBillingPortalSession(user.email);
        return res.redirect(302, portalUrl);
      } catch (e) {
        return res.status(400).set('Content-Type', 'text/html; charset=utf-8')
          .send('<body style="font-family:sans-serif;padding:40px">' +
            (e.message === 'no_subscription'
              ? 'アクティブなサブスクリプションが見つかりませんでした。 / No active subscription found for this email.'
              : '解約ページを開けませんでした。しばらくして再度お試しください。 / Could not open the billing portal — please try again shortly.') +
            '</body>');
      }
    }
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

// ニックネーム（呼び名）とランキング公開同意の登録・更新。要ログイン。
app.patch('/api/auth/profile', express.json(), async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'login_required' });
    const { displayName, leaderboardOptIn } = req.body || {};
    const updated = await auth.updateProfile(req.user.id, { displayName, leaderboardOptIn });
    res.json({ user: auth.publicUser(updated) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ── ガード早期returnの応答契約（2026-07-21 Codexレビュー P0-1 修正）──────────
//   デスクトップ側は stream:true の時、本文を text/plain のプレーンテキストとして
//   読み、そのまま吹き出し・TTSへ渡す。ガードがここを無視して常にJSONを返すと、
//   stream経路では拒否文の代わりに生JSON文字列が喋られてしまう。
//   非stream経路は既存のAnthropic互換JSON形（{content:[{type:'text',text}]}）を維持する。
function sendGuardReply(req, res, text) {
  if (req.body.stream) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(text);
  }
  return res.json({ content: [{ type: 'text', text }] });
}

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
    // ★★2026-07-21 Phase A1：戦略質問の構造化拒否（Codexレビュー反映）★★
    //   実走で「今ピットへ入ると何番手で復帰するか」に対し「確認する」「リアルタイムで見ないとな」
    //   と返し、復帰順位も根拠も出せなかった。原因は①計算器が無い ②プロンプトに
    //   「確認すると言え」と「確認するな」が併存、の2つ。
    //   ここでは①に対し、**計算できない戦略質問を自由文LLMへ渡さず**、
    //   構造化された理由から正直な返答をコード側で組む。
    //   ※分類は狭い（ピットに入る意図×順位を問う の両方が揃った時だけ）。
    //     通常会話を禁止語で置換するようなことはしない。
    let _strategyQ = null;
    try {
      const _msgs = Array.isArray(req.body.messages) ? req.body.messages : [];
      const _lastUser = [..._msgs].reverse().find(m => m && m.role === 'user');
      _strategyQ = _lastUser && typeof _lastUser.content === 'string'
        ? strategyGuard.classifyStrategyQuestion(_lastUser.content) : null;
    } catch (e) {
      console.log('[strategy_guard] classify skipped: ' + e.message);   // 分類前の失敗のみ通常経路へ
    }
    if (_strategyQ) {
      // ★P1-2（Codexレビュー）：対象質問だと分かった後は fail-closed。
      //   評価／返答生成で例外が起きても自由文LLMへは絶対に流さない
      //   （＝計算できないのに答えたふりをする経路を、ガード自身の不具合で復活させない）。
      try {
        // sessionTypeはトップレベルで送られる（liveData配下ではない・P1-5修正）
        const _sessionType = req.body.sessionType;
        const _avail = strategyGuard.evaluateAvailability(_strategyQ.topic, {
          // Phase A：復帰順位の計算器はまだ存在しない。Phase C 完了時にここが true になる。
          hasRejoinCalculator: false,
          isRaceSession: _sessionType ? /race/i.test(String(_sessionType)) : undefined,
        });
        if (!_avail.available) {
          const _lang = /JP$|Kanbe|Oishi/.test(String(character || '')) ? 'ja' : 'en';
          const _reply = strategyGuard.buildUnavailableReply(_avail.reason, _lang)
            || strategyGuard.buildUnavailableReply(strategyGuard.REASON.NO_CALCULATOR, _lang);
          console.log(`[strategy_guard] topic=${_strategyQ.topic} reason=${_avail.reason} -> structured reply`);
          return sendGuardReply(req, res, _reply);
        }
      } catch (e) {
        // ★P1-2再指摘（Codexレビュー）：ここで strategyGuard.buildUnavailableReply を再度呼ぶと、
        //   その関数自体が壊れて例外を投げた場合に fail-closed が機能しない
        //   （catch内の呼び出しがまた投げ、fail-openに戻ってしまう）。
        //   最終フォールバックは strategy-guard.js に一切依存しない固定文字列にする。
        console.error('[strategy_guard] evaluate/reply FAILED (fail-closed): ' + e.message);
        const _lang = /JP$|Kanbe|Oishi/.test(String(character || '')) ? 'ja' : 'en';
        const _fixedFallback = _lang === 'ja'
          ? '復帰順位はまだ出せない。ピットロスの計算がこっちに入ってないんだ。'
          : "I can't give you a rejoin position — the pit loss maths isn't wired up on my side yet.";
        return sendGuardReply(req, res, _fixedFallback);
      }
    }

    // ★2026-07-20 判断コールの二重防御（Codexレビュー反映）
    //   判断コールなのに状況説明(judgeCallNote)を組めない条件が揃うと、モデルは内部合図だけを
    //   受け取って「はい、ここにいます」と返事してしまう（Interlagos実走で約18回発生）。
    //   未知kind・必須値欠落・note生成不能は、LLMを呼ばずにサーバーで沈黙を返す（コストも節約）。
    const _jc = req.body.judgeCall;
    if (_jc && typeof _jc === 'object') {
      const REQ = { best_lap:['best_kind','time'], time_loss:['lost','time'], danger:['reason'],
                    multiclass:['stage'], towing:[], battle:['gap'], catchup:['gap'], defend:['gap'] };
      const missing = !REQ[_jc.kind] || REQ[_jc.kind].some(f => _jc[f] === undefined || _jc[f] === null);
      if (missing) {
        console.log(`[judge_call] forced silence: kind=${_jc.kind}`);
        return sendGuardReply(req, res, 'NO_CALL');
      }
    }

    if (character && (req.body.useServerPrompt || !system)) {
      console.log(`[buildSystem] char=${character}, mode=${req.body.mode}, liveData=${req.body.liveData ? JSON.stringify(req.body.liveData).substring(0,100) : 'null'}`);
      const built = buildSystem(req.body);
      if (built) {
        system = [
          { type: 'text', text: built.prefix, cache_control: { type: 'ephemeral' } }
        ];
        if (built.suffix) system.push({ type: 'text', text: built.suffix });
        console.log(`[buildSystem] suffix length=${built.suffix.length}, has fuel=${built.suffix.includes('fuel')}`);
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

    // 実測コストログ（Railwayログで確認可能。粗利率の実測に使う）
    const logUsage = (usage) => {
      if (!usage) return;
      console.log(`[USAGE] user=${userName || '?'} char=${character || '?'} mode=${mode || '?'} model=${model} in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0}`);
    };

    // ── ストリーミング：文字が生成された端からクライアントへ流す（体感レスポンス短縮）──
    // クライアントが stream:true を送った時のみ。生成量＝同じなのでコストは増えない。
    // renderer側は文が完成するたびTTS再生するので「流れるような会話」になる。
    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');  // プロキシのバッファリング無効化（即時flush）
      let streamUsage = null;
      try {
        const stream = await client.messages.create({
          model, max_tokens: safeMaxTokens, system, messages, stream: true,
        });
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
            res.write(event.delta.text);
            if (typeof res.flush === 'function') res.flush();
          } else if (event.type === 'message_start') {
            streamUsage = { ...event.message.usage };
          } else if (event.type === 'message_delta' && event.usage) {
            streamUsage = { ...streamUsage, output_tokens: event.usage.output_tokens };
          }
        }
        logUsage(streamUsage);
        res.end();
      } catch (streamErr) {
        console.error('[/api/chat stream ERROR]', streamErr.message);
        // 既にヘッダ送出済みなら本文を終えるだけ（クライアントは受信済み分で処理）
        try { res.end(); } catch (e) {}
      }
      return;
    }

    const response = await client.messages.create({
      model,
      max_tokens: safeMaxTokens,
      system,
      messages,
    });

    logUsage(response.usage);
    res.json(response);
  } catch (err) {
    // ★2026-07-21（Codexレビュー・変異テストで実証）：character/modeはtryブロック内で
    //   letされておりcatchのスコープ外。ReferenceErrorで再クラッシュし、意図したエラー
    //   レスポンスが返らずソケットが切断されていた。req.bodyから直接参照する。
    console.error(`[/api/chat ERROR] char=${req.body?.character}, mode=${req.body?.mode}`);
    console.error(`  Type: ${err.constructor.name}`);
    console.error(`  Message: ${err.message}`);
    console.error(`  Status: ${err.status || 'none'}`);
    if (err.error) console.error(`  API Error: ${JSON.stringify(err.error)}`);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
});

// ── 翻訳プロキシ（レースオーバーレイのEN/JP字幕用）────────────────────────────
// 1行ずつの短い無線を翻訳する。haiku（激安・高速）。会話品質には影響させない独立系統。
app.post('/api/translate', ttsLimiter, async (req, res) => {
  try {
    if (req.body.product === 'pitwall') {
      if (!auth.isReady()) return res.status(503).json({ error: 'auth_unavailable' });
      if (!req.user) return res.status(401).json({ error: 'login_required' });
      if (!req.user.is_member) return res.status(403).json({ error: 'membership_required' });
    }
    const text = (req.body.text || '').toString().slice(0, 500);
    const target = req.body.target === 'ja' ? 'Japanese' : 'English';
    if (!text.trim()) return res.json({ text: '' });

    const r = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: `You are a subtitle translator for a motorsport race-engineer radio overlay. Translate the user's line into ${target}. Keep it terse and natural, like a real radio call. Preserve driver/car numbers, positions (P3), lap/sector terms, and units (°C, L). Output ONLY the translation — no quotes, no notes, no romaji.`,
      messages: [{ role: 'user', content: text }],
    });
    const out = (r.content || []).map(b => b.text || '').join('').trim();
    res.json({ text: out });
  } catch (err) {
    console.error('[/api/translate ERROR]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'translate_failed' });
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

    // 日本語音声でPSI等の略語がローマ字読み("プシー")になるのを防ぐ→カタカナ読みを強制
    if ((languageCode || '').startsWith('ja')) {
      text = text.replace(/\bPSI\b/gi, 'ピーエスアイ');
    }

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
    const lang = languageCode || 'en-US';
    const isJapanese = lang.startsWith('ja');
    const racingPhrases = isJapanese
      ? ['燃料', '燃料残量', 'タイヤ', '内圧', 'タイヤ内圧', 'ギャップ', 'ピット', 'ピットイン',
         'セクター', 'ラップタイム', 'ベスト', '自己ベスト', '順位', 'アンダーカット', 'オーバーカット',
         'ブレーキバランス', 'セーフティカー', 'イエローフラッグ']
      : ['fuel', 'fuel level', 'fuel remaining', 'tyre', 'tyres', 'tire', 'tires',
         'tyre pressure', 'tire pressure', 'tyre temperature', 'tire temperature',
         'gap', 'gap ahead', 'gap behind', 'box', 'box box box', 'pit', 'pit stop',
         'undercut', 'overcut', 'brake bias', 'sector', 'lap time', 'personal best',
         'safety car', 'yellow flag', 'push now', 'free air'];

    const sttBody = {
      config: {
        encoding: encoding || 'WEBM_OPUS',
        languageCode: lang,
        enableAutomaticPunctuation: true,
        model: 'latest_long',
        speechContexts: [{ phrases: racingPhrases, boost: 15 }],
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
