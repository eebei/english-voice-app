require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const strategyGuard = require('./strategy-guard');
const engineerCard = require('./engineer-card');
const { buildSystem } = require('./prompts');
const auth = require('./auth');

const app = express();
// プロセス起動時刻。/api/version で「いつ入れ替わったか」を見るために使う。
const SERVER_STARTED_AT = new Date().toISOString();
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

// ── コスト計測: 環境判定（クライアントに決めさせない。サーバー環境変数のみを正とする）──
const PITWALL_ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT_NAME || 'local';

// ── コスト計測: source/triggerをサーバー側で導出する（クライアント申告を無条件に信用しない）──
// 許可source: auto_judge / auto_pace / ptt / typed / translate / other
const USAGE_INPUT_SOURCES = new Set(['ptt', 'typed']);
function deriveUsageSourceTrigger(body) {
  if (body.judgeCall && typeof body.judgeCall === 'object') {
    return { source: 'auto_judge', trigger: String(body.judgeCall.kind || 'unknown').slice(0, 64) };
  }
  if (body.paceCheck && typeof body.paceCheck === 'object') {
    return { source: 'auto_pace', trigger: 'pace_check' };
  }
  if (body.driverInsight === true) {
    return { source: 'other', trigger: 'driver_insight' };
  }
  if (body.briefingKickoff === true) {
    return { source: 'other', trigger: 'briefing_kickoff' };
  }
  // PTT/typedはサーバー側で判別できないため、ホワイトリスト検証したクライアント申告のみ許可。
  if (typeof body.inputSource === 'string' && USAGE_INPUT_SOURCES.has(body.inputSource)) {
    return { source: body.inputSource, trigger: null };
  }
  return { source: 'other', trigger: null };
}

function deriveUsageContext(body, source) {
  const activity = String(body && body.driverActivity || '').toUpperCase();
  const state = String(body && body.driverState || '').toLowerCase();
  if ((source === 'ptt' || source === 'typed')
      && (activity === 'DRIVER_HANDOFF' || activity === 'INACTIVE_DRIVER' || activity === 'FINISHED')) {
    return 'team_engineer';
  }
  // Build 220以前との後方互換。新buildではdriverActivityを権威とする。
  if (!activity && (source === 'ptt' || source === 'typed') && state === 'garage') return 'team_engineer';
  if (source === 'ptt' || source === 'typed') return 'driver_support';
  if (source === 'auto_judge' || source === 'auto_pace') return 'auto_driver_support';
  return 'other';
}

// Google TTS/STTの生課金単位を記録（DB書込失敗で音声を止めない・非同期fire-and-forget）。
function recordGoogleUsageSafe(req, fields) {
  if (!auth.isReady()) return;
  const usageSessionId = (typeof req.body.usageSessionId === 'string' && req.body.usageSessionId.length <= 64)
    ? req.body.usageSessionId : null;
  auth.recordGoogleUsage({
    userId: req.user ? req.user.id : null, betaTokenHash: req.betaTokenHash || null, sessionId: usageSessionId,
    environment: PITWALL_ENVIRONMENT, ...fields,
  }).catch(err => console.error('[USAGE] Google usage DB write failed:', err.message));
}

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
  exposedHeaders: ['X-Pitwall-Authority', 'X-Pitwall-Intent'],
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
      const isStarter = s.mode === 'payment' && s.payment_status === 'paid'
        && s.metadata && s.metadata.product === 'starter';
      const result = isStarter
        ? await auth.grantStarterPass({
          rawEmail: email, stripeCustomerId: s.customer, checkoutSessionId: s.id,
          paymentIntentId: s.payment_intent, displayName,
        })
        : await auth.setMemberByEmail(email, {
          plan: 'founding', stripeCustomerId: s.customer,
          subscriptionStatus: 'active', displayName,
        });
      console.log('[stripe] checkout completed → ' + (isStarter ? 'Starter Pass' : 'member') + ':', email, 'alreadyGranted:', !!result.alreadyGranted);
      const anonId = (s.metadata && s.metadata.anon_id) || '';
      const isTest = !event.livemode;
      try {
        await auth.recordFunnelEvent({ event: 'checkout_completed', anon_id: anonId, extra: { stripe_customer: s.customer }, idempotency_key: 'checkout_' + s.id, is_test: isTest });
        if (!isStarter && result.justActivated) {
          await auth.recordFunnelEvent({ event: 'trial_started', anon_id: anonId, extra: { stripe_customer: s.customer }, idempotency_key: 'trial_' + s.id, is_test: isTest });
        }
      } catch (e) { console.error('[stripe] funnel event failed:', e.message); }
      if (isStarter || result.justActivated) {
        auth.sendWelcomeEmail(email, result.plan).catch((e) => console.error('[stripe] welcome email failed:', e.message));
      }
      if (!isStarter) {
        try {
          const cf = Array.isArray(s.custom_fields) ? s.custom_fields.find(f => f.text && f.text.value) : null;
          if (cf) await auth.recordReferralAttribution(email, cf.text.value);
        } catch (e) { console.error('[stripe] referral attribution failed:', e.message); }
      }
    } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
      // Grow the Grid：友達の"初回実課金"（トライアル明けの最初の支払い）で紹介カウント＋クーポン適用。
      // amount_paid > 0 が実課金の証（トライアル開始時の$0請求は billing_reason=subscription_create かつ 0円）。
      // 2ヶ月目以降の請求もここを通るが、referral_conversionsのPRIMARY KEYで二重加算は起きない。
      const inv = event.data.object;
      const isTestInv = !event.livemode;
      // 支払い失敗で停止済みでも、Stripeが再請求に成功した場合だけ自動で戻す。
      // tester codeのアクセス権には一切触れない。
      if (inv.customer) await auth.restoreMemberByCustomer(inv.customer, 'active');
      if (inv.amount_paid > 0 && inv.customer && inv.billing_reason === 'subscription_cycle') {
        // invoiceオブジェクト自身にsubscriptionのmetadataが埋め込まれている（Stripe API 2026-06-24〜の invoice.parent.subscription_details）。
        //   まずここから読む。無ければ古い形の inv.subscription 経由で取得にフォールバック。
        let invAnonId = (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.metadata
          && inv.parent.subscription_details.metadata.anon_id) || '';
        const subId = inv.subscription || (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription);
        if (!invAnonId && subId && stripe) {
          try {
            const sub = await stripe.subscriptions.retrieve(subId);
            invAnonId = (sub.metadata && sub.metadata.anon_id) || '';
          } catch (e) { console.error('[stripe] subscription retrieve for anon_id failed:', e.message); }
        }
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
      // 原価が発生するAPIは、最初の決済失敗（past_due）から止める。
      // 回収成功時だけinvoice.paid上で復帰する。Stripeの再試行期間を無制限の
      // 無料利用期間にしない。
      if (['canceled', 'past_due', 'unpaid', 'incomplete_expired'].includes(sub.status)) {
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

// ── 本番が今どのコミットで動いているか（デプロイ反映の確認用） ──
// ★8/19：Build 277 の発話短縮は engineer-card.js＝サーバー側にしか無く、exe を
//   更新しても Railway が反映していなければ何も直らない。にもかかわらず「push した
//   から反映されているはず」で運用しており、反映を確認する手段が存在しなかった。
//   GitHub Actions が緑でも Railway が落ちていれば、見た目だけ新しい状態になる。
//   Railway が注入する commit SHA をそのまま返す。認証不要・読み取り専用で、
//   秘密は一切出さない（SHAは公開リポジトリのcommit識別子）。
app.get('/api/version', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    branch: process.env.RAILWAY_GIT_BRANCH || null,
    startedAt: SERVER_STARTED_AT,   // このプロセスが立った時刻＝実際に入れ替わった時刻
  });
});

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
    if (r.ok) return res.json({ ok: true, name: r.name, tier: r.tier,
      activatedAt: r.activatedAt || null, expiresAt: r.expiresAt || null });
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
// ★2026-07-23 Codexレビュー：URLクエリ(?secret=)はアクセスログ・ブラウザ履歴・リファラに
//   秘密値が残るため廃止。ヘッダーのみ受け付ける。timingSafeEqualで比較タイミングからの
//   推測を防ぐが、型・長さが不一致でも例外にせず安全にfalse扱いする。
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'admin_disabled (set ADMIN_SECRET)' });
  const given = req.headers['x-admin-secret'];
  if (typeof given !== 'string' || !constantTimeEquals(given, secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // 長さが違うと timingSafeEqual 自体が例外を投げるため、長さ不一致は先に安全にfalseで弾く
  // （長さ比較自体は秘密の中身を漏らさないので、フェイルクローズドとして問題ない）。
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
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
app.post('/api/beta/admin/expire', requireAdmin, express.json(), async (req, res) => {
  try {
    const { code } = req.body || {};
    res.json(await auth.expireBetaToken(code));
  } catch (err) { res.status(500).json({ ok: false, error: String(err.message || err) }); }
});
// 過去ログから厳選した本人申告を、対象テスターの認証済みPCへ一回だけ移植する。
// targetNameでDB内検索するため、管理操作の応答にもアクセスコードは出さない。
app.post('/api/beta/admin/memory-import/queue', requireAdmin, express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const { targetName, sourceLabel, records } = req.body || {};
    const result = await auth.queueMemoryImportSeed({ targetName, sourceLabel, records });
    res.json(result);
  } catch (err) {
    const message = String(err.message || err);
    const status = ['tester_not_found', 'ambiguous_tester_name'].includes(message) ? 400 : 422;
    res.status(status).json({ ok: false, error: message });
  }
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

// Public Starter checkout deliberately has no client-supplied price, customer,
// duration, or entitlement fields.  Those are server/Stripe-owned facts.
app.post('/api/starter/checkout', express.json(), async (req, res) => {
  try {
    const { anon_id, lang } = req.body || {};
    const r = await auth.createStarterCheckout({ anon_id, lang });
    res.json({ ok: true, url: r.url });
  } catch (err) {
    console.error('[starter] checkout creation failed:', err.message);
    res.status(503).json({ ok: false, error: err.message === 'starter_price_not_configured' ? 'starter_price_not_configured' : 'unavailable' });
  }
});

// The public button uses a normal top-level navigation, rather than browser
// fetch, so restrictive browser/privacy settings cannot block Checkout.
app.get('/api/starter/checkout', async (req, res) => {
  try {
    const r = await auth.createStarterCheckout({
      anon_id: typeof req.query.anon_id === 'string' ? req.query.anon_id.slice(0, 120) : '',
      lang: typeof req.query.lang === 'string' ? req.query.lang.slice(0, 12) : '',
    });
    res.redirect(303, r.url);
  } catch (err) {
    console.error('[starter] checkout redirect failed:', err.message);
    res.redirect(303, '/pitwall.html#pricing');
  }
});

// The desktop polls this after member login to display remaining included use.
// It requires the authenticated user; no account identifier comes from client input.
app.get('/api/starter/status', async (req, res) => {
  if (!req.user || req.user.plan !== 'starter') return res.status(403).json({ ok: false, error: 'starter_required' });
  try {
    res.json({ ok: true, ...(await auth.getStarterPassStatus(req.user.id)) });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'unavailable' });
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
const CTA_LOCATION_EVENTS = ['primary_cta_click', 'checkout_started'];
const CTA_LOCATIONS = ['hero', 'manifesto', 'pricing'];
const funnelLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.post('/api/funnel/event', funnelLimiter, express.json(), async (req, res) => {
  try {
    if (!auth.isReady()) return res.status(204).end();
    const d = req.body || {};
    if (!d.event || !CLIENT_EVENTS.includes(d.event)) return res.status(400).json({ ok: false });
    if (d.anon_id && (typeof d.anon_id !== 'string' || d.anon_id.length > 64)) {
      return res.status(400).json({ ok: false });
    }
    if (d.extra !== undefined) {
      if (typeof d.extra !== 'object' || d.extra === null || Array.isArray(d.extra) || JSON.stringify(d.extra).length > 500) {
        return res.status(400).json({ ok: false });
      }
      if (d.extra.cta_location !== undefined) {
        if (!CTA_LOCATION_EVENTS.includes(d.event) || !CTA_LOCATIONS.includes(d.extra.cta_location)) {
          return res.status(400).json({ ok: false });
        }
      }
    }
    await auth.recordFunnelEvent(d);
    res.json({ ok: true });
  } catch { res.status(204).end(); }
});
app.get('/api/funnel/stats', requireAdmin, async (_req, res) => {
  try {
    const [stats, statsByCtaLocation] = await Promise.all([
      auth.getFunnelStats(),
      auth.getFunnelStatsByCtaLocation(),
    ]);
    res.json({ ok: true, stats, statsByCtaLocation });
  }
  catch (err) { res.status(500).json({ ok: false, error: String(err.message || err) }); }
});
// user_id/session_id/source等の識別子のみを扱う。メールアドレスや表示名は一切返さない。
app.get('/api/usage/stats', requireAdmin, async (req, res) => {
  try {
    const q = req.query || {};
    const filters = {
      from: q.from || undefined,
      to: q.to || undefined,
      userId: q.user_id ? parseInt(q.user_id, 10) : undefined,
      sessionId: q.session_id || undefined,
      source: q.source || undefined,
    };
    const stats = await auth.getApiUsageStats(filters);
    res.json({ ok: true, stats });
  }
  catch (err) { res.status(500).json({ ok: false, error: String(err.message || err) }); }
});
app.get('/api/usage/session-stats', requireAdmin, async (req, res) => {
  try {
    const stats = await auth.getUsageSessionStats({ from: req.query.from || undefined, to: req.query.to || undefined });
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});
app.get('/api/admin/credits/stats', requireAdmin, async (_req, res) => {
  try { res.json({ ok: true, accounts: await auth.getCreditAccountStats() }); }
  catch (err) { res.status(500).json({ ok: false, error: String(err.message || err) }); }
});
app.post('/api/admin/credits/shadow-enroll', requireAdmin, express.json(), async (req, res) => {
  try {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!code) return res.status(400).json({ ok: false, error: 'code_required' });
    const verified = await auth.verifyBetaToken(code, '');
    if (!verified.ok) return res.status(400).json({ ok: false, error: 'invalid_access_code' });
    const betaTokenHash = crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');
    const account = await auth.enrollShadowCreditAccount({
      betaTokenHash, displayName: verified.name, memoryTier: req.body?.memoryTier || 'session',
    });
    await auth.recordCreditLedgerEvent({
      betaTokenHash, eventKey: `shadow-starter-grant:${betaTokenHash}`, eventType: 'grant', creditsDelta: 30,
      source: 'admin', note: '$9.99 Starter shadow allocation',
    });
    res.json({ ok: true, account });
  } catch (err) { res.status(500).json({ ok: false, error: String(err.message || err) }); }
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

// One server-side entitlement gate protects every paid-cost API. The desktop
// sends the same identity on chat, translation, TTS and STT; no route may rely
// on a hidden screen or a one-time startup check.
async function requirePitwallEntitlement(req, res, next) {
  try {
    // Deliberately do not trust body.product or any other client-controlled flag:
    // omitting such a flag must never turn a paid endpoint into a public one.
    if (!auth.isReady()) return res.status(503).json({ error: 'auth_unavailable' });
    if (req.user && await auth.hasPitwallEntitlement(req.user)) return next();

    const code = req.headers['x-pitwall-access-code'];
    const deviceId = req.headers['x-pitwall-device-id'];
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(401).json({ error: 'access_required' });
    }
    const access = await auth.verifyBetaToken(code, deviceId);
    if (!access.ok) {
      const status = access.reason === 'expired' ? 403 : 401;
      return res.status(status).json({ error: 'access_' + (access.reason || 'denied') });
    }
    req.betaAccess = access;
    req.betaTokenHash = crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
    next();
  } catch (err) {
    console.error('[entitlement] verification failed:', err.message);
    return res.status(503).json({ error: 'auth_unavailable' });
  }
}

app.use(['/api/chat', '/api/translate', '/api/tts', '/api/stt'], requirePitwallEntitlement);

// Cross-PC endurance handoff.  Each driver still authenticates with their own
// PITWALL entitlement; a Team Link Code only selects the team's latest compact
// handoff packet and is never persisted in plaintext.
const chiefShareLimiter = rateLimit({ windowMs: 60 * 1000, max: 24, standardHeaders: true, legacyHeaders: false });
function chiefSenderIdentity(req) {
  if (req.user && req.user.id) return 'user:' + req.user.id;
  if (req.betaTokenHash) return 'beta:' + req.betaTokenHash;
  return null;
}
app.post('/api/chief/handoff', chiefShareLimiter, express.json(), requirePitwallEntitlement, async (req, res) => {
  try {
    const r = await auth.publishChiefTeamHandoff({
      teamCode: req.body && req.body.teamCode,
      senderIdentity: chiefSenderIdentity(req),
      packet: req.body && req.body.packet,
    });
    res.json(r);
  } catch (err) {
    res.status(400).json({ ok: false, error: 'invalid_chief_handoff' });
  }
});
app.get('/api/chief/handoff', chiefShareLimiter, requirePitwallEntitlement, async (req, res) => {
  try {
    const r = await auth.getChiefTeamHandoff({ teamCode: req.query && req.query.teamCode });
    res.json(r);
  } catch (err) {
    res.status(400).json({ ok: false, error: 'invalid_chief_team' });
  }
});

// Build 251: beta access code hash is resolved by the entitlement middleware.
// The desktop receives only its own pending seed and acknowledges only after
// its local memory write succeeds. Paid accounts do not receive beta seeds.
app.get('/api/memory/import-seeds', requirePitwallEntitlement, async (req, res) => {
  try {
    if (!req.betaTokenHash) return res.json({ ok: true, seeds: [] });
    const seeds = await auth.getPendingMemoryImportSeeds(req.betaTokenHash);
    res.json({ ok: true, seeds });
  } catch (err) {
    console.error('[memory-import] fetch failed:', err.message);
    res.status(503).json({ ok: false, error: 'memory_import_unavailable' });
  }
});
app.post('/api/memory/import-seeds/ack', requirePitwallEntitlement, async (req, res) => {
  try {
    if (!req.betaTokenHash) return res.status(400).json({ ok: false, error: 'beta_access_required' });
    const result = await auth.acknowledgeMemoryImportSeeds(req.betaTokenHash, req.body && req.body.seedIds);
    res.json(result);
  } catch (err) {
    console.error('[memory-import] acknowledgement failed:', err.message);
    res.status(400).json({ ok: false, error: 'invalid_memory_import_ack' });
  }
});

// ★スライス3（2026-08-25）戦略判断のサーバー正本。
//
// 認証主体（ログインユーザー or beta token）ごとに分離する。req.user / req.betaTokenHash は
// requirePitwallEntitlement が確定させたものだけを使い、body の識別子は一切信用しない。
// 保存してよい形は auth.sanitizeDecisionRecord がサーバー側で強制する。
// 表示・訂正・削除・保持期間を同じ scope に置き、預けたものを本人が見て消せる状態にする。
const decisionMemoryLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
function decisionOwner(req) {
  return { userId: (req.user && req.user.id) || null, betaTokenHash: req.betaTokenHash || null };
}
app.put('/api/memory/decisions', decisionMemoryLimiter, express.json({ limit: '256kb' }), requirePitwallEntitlement, async (req, res) => {
  try {
    const result = await auth.saveStrategyDecisions({
      ...decisionOwner(req), decisions: req.body && req.body.decisions });
    res.json(result);
  } catch (err) {
    console.error('[decision-memory] save failed:', err.message);
    res.status(400).json({ ok: false, error: 'invalid_decision_payload' });
  }
});
app.get('/api/memory/decisions', decisionMemoryLimiter, requirePitwallEntitlement, async (req, res) => {
  try {
    res.json(await auth.listStrategyDecisions(decisionOwner(req)));
  } catch (err) {
    console.error('[decision-memory] list failed:', err.message);
    res.status(503).json({ ok: false, error: 'decision_memory_unavailable' });
  }
});
app.post('/api/memory/decisions/dispute', decisionMemoryLimiter, express.json(), requirePitwallEntitlement, async (req, res) => {
  try {
    res.json(await auth.markStrategyDecisionDisputed({
      ...decisionOwner(req), decisionId: req.body && req.body.decisionId }));
  } catch (err) {
    res.status(400).json({ ok: false, error: 'invalid_decision_dispute' });
  }
});
app.delete('/api/memory/decisions', decisionMemoryLimiter, express.json(), requirePitwallEntitlement, async (req, res) => {
  try {
    const body = req.body || {};
    // 全削除は明示指定でだけ通す。id 欠落を「全部消す」と解釈しない。
    const decisionId = (body.all === true) ? null
      : (typeof body.decisionId === 'string' && body.decisionId ? body.decisionId : undefined);
    if (decisionId === undefined) return res.status(400).json({ ok: false, error: 'decision_id_required' });
    res.json(await auth.deleteStrategyDecision({ ...decisionOwner(req), decisionId }));
  } catch (err) {
    res.status(400).json({ ok: false, error: 'invalid_decision_delete' });
  }
});

const usageCheckpointLimiter = rateLimit({ windowMs: 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false });
app.post('/api/usage/session-checkpoint', usageCheckpointLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const sessionId = typeof b.sessionId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(b.sessionId) ? b.sessionId : null;
    const deviceId = typeof b.deviceId === 'string' ? b.deviceId.slice(0, 128) : '';
    const betaCode = typeof b.betaCode === 'string' ? b.betaCode.slice(0, 128) : '';
    if (!sessionId) return res.status(400).json({ ok: false, error: 'invalid_session_id' });

    let testerName = null;
    let betaTokenHash = null;
    if (betaCode) {
      const verified = await auth.verifyBetaToken(betaCode, deviceId);
      if (!verified.ok) return res.status(403).json({ ok: false, error: 'invalid_beta_code' });
      testerName = String(verified.name || '').slice(0, 80) || null;
      betaTokenHash = crypto.createHash('sha256').update(betaCode.trim().toUpperCase()).digest('hex');
    } else if (!req.user) {
      return res.status(401).json({ ok: false, error: 'identity_required' });
    }

    const int = (v, max = 2147483647) => Number.isInteger(v) && v >= 0 && v <= max ? v : 0;
    const iso = v => typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
    const result = await auth.recordUsageSessionCheckpoint({
      sessionId,
      userId: req.user ? req.user.id : null,
      betaTokenHash,
      testerName,
      deviceIdHash: deviceId ? crypto.createHash('sha256').update(deviceId).digest('hex') : null,
      build: typeof b.build === 'string' ? b.build.slice(0, 40) : null,
      sequence: int(b.sequence, 1000000000),
      startedAt: iso(b.startedAt),
      endedAt: iso(b.endedAt),
      totalSeconds: int(b.totalSeconds),
      iracingSeconds: int(b.iracingSeconds),
      pttCalls: int(b.pttCalls),
      typedCalls: int(b.typedCalls),
      autoJudgeCalls: int(b.autoJudgeCalls),
      autoPaceCalls: int(b.autoPaceCalls),
      briefingCalls: int(b.briefingCalls),
      insightCalls: int(b.insightCalls),
      debriefOffered: int(b.debriefOffered),
      debriefStarted: int(b.debriefStarted),
      debriefCompleted: int(b.debriefCompleted),
      debriefDismissed: int(b.debriefDismissed),
      practiceReviewEligible: int(b.practiceReviewEligible),
      practiceReviewOffered: int(b.practiceReviewOffered),
      practiceReviewStarted: int(b.practiceReviewStarted),
      practiceReviewCompleted: int(b.practiceReviewCompleted),
      practiceReviewSaved: int(b.practiceReviewSaved),
      practiceReviewManual: int(b.practiceReviewManual),
      feedbackPrompted: int(b.feedbackPrompted),
      feedbackAnswered: int(b.feedbackAnswered),
      normalExit: b.normalExit === true,
      lastReason: typeof b.reason === 'string' ? b.reason.slice(0, 40) : null,
    });
    res.json({ ok: true, sessionId, sequence: result.sequence });
  } catch (err) {
    console.error('[USAGE_CHECKPOINT]', err.message);
    res.status(500).json({ ok: false, error: 'checkpoint_failed' });
  }
});

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
function sendGuardReply(req, res, text, structuredLimit = null, authority = 'deterministic', intent = null) {
  const charLimit = Number.isFinite(structuredLimit)
    ? structuredLimit
    : resolveReplyCharLimit(req.body || {}, req.body && req.body.mode);
  const limitedText = limitReplyText(text, charLimit);
  res.setHeader('X-Pitwall-Authority', authority);
  if (intent) res.setHeader('X-Pitwall-Intent', String(intent));
  if (req.body.stream) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(limitedText);
  }
  return res.json({ content: [{ type: 'text', text: limitedText }] });
}

// Phase C is a numeric radio contract, not prose generated by the LLM.  Keep
// the six requested outputs together so a generic race-mode character limit
// cannot silently cut off the traffic or blend-line warning.
function buildPitExitForecastReply(forecast, lang) {
  const likely = forecast && forecast.likely;
  const best = forecast && forecast.best;
  const worst = forecast && forecast.worst;
  if (!likely || !best || !worst) return null;

  const pos = value => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null;
  const gap = value => Number.isFinite(Number(value)) ? Math.abs(Number(value)).toFixed(1) : null;
  const car = item => item && item.car_number != null ? `#${item.car_number}` : null;
  const likelyPos = pos(likely.position);
  const bestPos = pos(best.position);
  const worstPos = pos(worst.position);
  if (![likelyPos, bestPos, worstPos].every(Number.isFinite)) return null;

  const aheadCar = car(likely.nearest_ahead);
  const behindCar = car(likely.nearest_behind);
  const aheadGap = likely.nearest_ahead && gap(likely.nearest_ahead.gap_s);
  const behindGap = likely.nearest_behind && gap(likely.nearest_behind.gap_s);
  const blendRisk = Array.isArray(likely.blend_conflicts) && likely.blend_conflicts.length > 0;
  const traffic = likely.traffic_state === 'clear_air' ? 'clear_air' : 'traffic';
  const cycle = forecast && forecast.pit_cycle;
  const cycleLikely = cycle && cycle.if_pack_stops && cycle.if_pack_stops.likely;
  const cyclePosition = pos(cycleLikely && cycleLikely.position);
  const packCount = Number(cycleLikely && cycleLikely.pack_car_count);

  if (lang === 'ja') {
    const ahead = aheadCar && aheadGap ? `前${aheadCar} ${aheadGap}秒` : '前なし';
    const behind = behindCar && behindGap ? `後${behindCar} ${behindGap}秒` : '後なし';
    const cycleText = Number.isFinite(cyclePosition) && packCount > 0
      ? `近傍${packCount}台が次の停止窓で入れば、ブレンド後P${cyclePosition}。停止意図は未確認。`
      : 'ブレンド後順位は、前方の停止意図が未確認。';
    return `物理復帰P${likelyPos}、範囲P${bestPos}〜P${worstPos}。${cycleText}${ahead}、${behind}。${traffic === 'clear_air' ? 'クリアエア' : 'トラフィック内'}、${blendRisk ? '合流注意' : '合流リスク低い'}。`;
  }
  const ahead = aheadCar && aheadGap ? `${aheadCar} ${aheadGap}s ahead` : 'none ahead';
  const behind = behindCar && behindGap ? `${behindCar} ${behindGap}s behind` : 'none behind';
  const cycleText = Number.isFinite(cyclePosition) && packCount > 0
    ? `If the ${packCount}-car nearby pack stops in the next window, cycle P${cyclePosition}; their pit intent is unconfirmed.`
    : 'Cycle position unavailable: rival pit intent is unconfirmed.';
  return `Physical exit P${likelyPos}, P${bestPos}-${worstPos}. ${cycleText} ${ahead}; ${behind}. ${traffic === 'clear_air' ? 'Clear air' : 'Traffic'}; ${blendRisk ? 'blend risk' : 'low blend risk'}.`;
}

function buildPitCalibrationReply(forecast, lang) {
  const evidence = forecast && forecast.evidence || {};
  const usable = Math.max(0, Number.parseInt(evidence.usable_sample_count, 10) || 0);
  const required = Math.max(1, Number.parseInt(evidence.required_sample_count, 10) || 3);
  const remaining = Math.max(0, Number.parseInt(evidence.remaining_sample_count, 10) || (required - usable));
  if (lang === 'ja') {
    return `この車とコースのピット実測は${usable}/${required}。あと${remaining}回必要。`;
  }
  return `Pit calibration for this car and track is ${usable}/${required}. ${remaining} more required.`;
}

// These answers are facts from the current live payload, never LLM inference.
function buildDirectPitReply(command, liveData, lang) {
  const live = liveData && typeof liveData === 'object' ? liveData : {};
  if (command.topic === strategyGuard.TOPIC.PIT_THIS_LAP) {
    return lang === 'ja' ? '了解。この周の終わりでボックス。'
      : 'Copy. Box at the end of this lap.';
  }
  if (command.topic === strategyGuard.TOPIC.PIT_NEXT_LAP) {
    return lang === 'ja' ? '了解。次のラップの終わりでボックス。'
      : 'Copy. Box at the end of the next lap.';
  }
  if (command.topic === strategyGuard.TOPIC.PIT_TIMING) {
    const sample = live.last_pit_service;
    const lane = Number(sample && sample.lane_total_s);
    if (!Number.isFinite(lane) || lane <= 0) {
      return lang === 'ja' ? '直近のピット総時間は、まだ実測できていない。'
        : 'I do not have an exact measured pit-lane time yet.';
    }
    const fuel = Number(sample.fuel_added_l);
    const stall = Number(sample.stall_s);
    if (lang === 'ja') {
      const detail = [
        Number.isFinite(fuel) ? `給油${fuel.toFixed(1)}L` : null,
        Number.isFinite(stall) ? `停止${stall.toFixed(1)}秒` : null,
      ].filter(Boolean).join('、');
      return `直近のINからOUTまで${lane.toFixed(1)}秒。${detail || 'サービス内訳は未計測'}。`;
    }
    const detail = [
      Number.isFinite(fuel) ? `${fuel.toFixed(1)}L fuel` : null,
      Number.isFinite(stall) ? `${stall.toFixed(1)}s stationary` : null,
    ].filter(Boolean).join(', ');
    return `Last measured pit lane, IN to OUT: ${lane.toFixed(1)}s. ${detail || 'Service detail unavailable'}.`;
  }
  return null;
}

function isFuelQuestion(text) {
  return /燃料|給油|足りる|リットル|リッター|何(?:リットル|リッター|L)|fuel|lit(?:er|re)|make it/i.test(String(text || ''));
}

function isAccountChangeRequest(text) {
  return /契約解除|解約|退会|返金|subscription\s*(?:cancel|cancellation)|cancel\s*(?:my\s*)?subscription|refund/i.test(String(text || ''));
}

// Fuel arithmetic and account entitlement are server-owned facts.  Do not
// let conversational text improvise either one during a race.
function buildFuelAuthorityReply(liveData, lang) {
  const live = liveData && typeof liveData === 'object' ? liveData : {};
  const cardReply = engineerCard.build(
    { topic: engineerCard.TOPIC.FUEL_PLAN }, live, lang);
  if (cardReply) return cardReply;
  const fs = live.fuel_strategy && typeof live.fuel_strategy === 'object'
    ? live.fuel_strategy : {};
  if (!engineerCard.hasAuthoritativeFinishTarget(live)) {
    const current = Number(live.fuel);
    const average = Number(fs.avg_fuel_per_lap);
    return lang === 'ja'
      ? `${Number.isFinite(current) ? `現在${current.toFixed(1)}L。` : ''}${Number.isFinite(average) ? `平均${average.toFixed(2)}L/周。` : ''}完走目標が確定していないため、必要燃料・給油量・ピット周は出さない。`
      : `${Number.isFinite(current) ? `Current ${current.toFixed(1)}L. ` : ''}${Number.isFinite(average) ? `Average ${average.toFixed(2)}L/lap. ` : ''}The finish target is not authoritative, so I will not give required fuel, an add amount, or a pit-lap call.`;
  }
  const required = Number(fs.required_fuel_l);
  const margin = Number(fs.margin_l);
  const exact = Number(fs.estimated_crossings_to_finish);
  const provisional = Number(fs.provisional_laps_to_time_expiry);
  const current = Number(live.fuel);
  const add = Number(fs.add_fuel_l);
  const setFuel = Number.isFinite(add) && add > 0
    ? (lang === 'ja' ? `、${add.toFixed(1)}L追加。${Math.ceil(add)}Lセット` : `, add ${add.toFixed(1)}L; set ${Math.ceil(add)}L`)
    : '';
  if (Number.isFinite(required) && Number.isFinite(margin) && Number.isInteger(exact)) {
    return lang === 'ja'
      ? `現在${Number.isFinite(current) ? current.toFixed(1) + 'L。' : ''}チェッカーまで${exact}回、必要${required.toFixed(1)}L。${margin >= 0 ? margin.toFixed(1) + 'L余裕' : Math.abs(margin).toFixed(1) + 'L不足'}${setFuel}。`
      : `${Number.isFinite(current) ? `Current ${current.toFixed(1)}L. ` : ''}${exact} crossings to the finish: ${required.toFixed(1)}L required, ${margin >= 0 ? margin.toFixed(1) + 'L margin' : Math.abs(margin).toFixed(1) + 'L short'}${setFuel}.`;
  }
  if (Number.isFinite(required) && Number.isFinite(margin) && Number.isInteger(provisional)) {
    return lang === 'ja'
      ? `現在${Number.isFinite(current) ? current.toFixed(1) + 'L。' : ''}暫定であと${provisional}周分、必要${required.toFixed(1)}L。${margin >= 0 ? margin.toFixed(1) + 'L余裕' : Math.abs(margin).toFixed(1) + 'L不足'}${setFuel}。チェッカー周は確定後に更新する。`
      : `${Number.isFinite(current) ? `Current ${current.toFixed(1)}L. ` : ''}Provisional plan: ${provisional} laps, ${required.toFixed(1)}L required, ${margin >= 0 ? margin.toFixed(1) + 'L margin' : Math.abs(margin).toFixed(1) + 'L short'}${setFuel}. I will update it when the checker lap is confirmed.`;
  }
  const average = Number(fs.avg_fuel_per_lap);
  if (Number.isFinite(average)) {
    return lang === 'ja'
      ? `平均${average.toFixed(2)}L/周。必要量はクリーン3周そろい次第、計算で出す。`
      : `Average ${average.toFixed(2)}L per lap. I will calculate the requirement after three clean laps.`;
  }
  return lang === 'ja'
    ? '燃料の実測がまだ足りない。クリーンラップを待つ。'
    : 'I need clean-lap fuel data before I can calculate the requirement.';
}

function buildAccountChangeReply(lang) {
  return lang === 'ja'
    ? '契約状態はここでは変更できない。手続き先を案内するね。'
    : 'I cannot change subscription status here. I can point you to the cancellation process.';
}

function isSessionFormatQuestion(text) {
  return /(?:レース.{0,10})?(?:フォーマット|フォーマー|形式)|何分\s*(?:制|製)(?:の)?(?:レース)?|session format|race format/i.test(String(text || ''));
}

function isRaceRuleQuestion(text) {
  const raw = String(text || '');
  if (isSessionFormatQuestion(raw)) return false;
  return /(?:レース|race).{0,12}(?:何分|時間|何周|laps?)|(?:何分|何周|laps?).{0,12}(?:レース|race)|残り.{0,8}(?:何周|\d+\s*周)|(?:何周|laps?).{0,8}(?:残り|left|remaining)/i.test(raw);
}

function buildRacePlanReply(liveData, lang) {
  const plan = liveData && liveData.race_plan && typeof liveData.race_plan === 'object'
    ? liveData.race_plan : {};
  const numberOrNull = value => value === null || value === undefined || value === ''
    ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
  const duration = numberOrNull(plan.configured_duration_s);
  const remaining = numberOrNull(liveData && liveData.session_time_remaining_s);
  const crossings = numberOrNull(liveData && liveData.finish_crossings_authority);
  const minutes = Number.isFinite(duration) ? Math.round(duration / 60) : null;
  if (plan.kind === 'timed' && minutes != null) {
    const remain = Number.isFinite(remaining)
      ? (lang === 'ja'
        ? `残り${engineerCard.formatDuration(Math.max(0, remaining), 'ja')}。`
        : `${engineerCard.formatDuration(Math.max(0, remaining), 'en')} remaining. `)
      : '';
    const distance = Number.isInteger(crossings) && crossings >= 1 && crossings <= 10
      ? (lang === 'ja' ? `チェッカーまで自車のS/F通過あと${crossings}回。` : `${crossings} driver S/F crossings to the finish.`)
      : '';
    return lang === 'ja'
      ? `${duration >= 3600 ? Math.round(duration / 3600) + '時間' : minutes + '分'}のタイムレース。${remain}${distance}`
      : `${duration >= 3600 ? Math.round(duration / 3600) + '-hour' : minutes + '-minute'} timed race. ${remain}${distance}`;
  }
  if (plan.kind === 'laps') {
    const total = numberOrNull(liveData && liveData.laps_total);
    const current = numberOrNull(liveData && liveData.lap);
    if (Number.isInteger(total) && total > 0 && Number.isInteger(current) && current >= 0) {
      const left = Math.max(0, total - current);
      return lang === 'ja'
        ? `全${total}周。現在${current}周目、残り約${left}周。`
        : `${total} laps total. Lap ${current} now, about ${left} remaining.`;
    }
  }
  return lang === 'ja'
    ? 'このレースの時間・周回ルールはまだ確定できない。'
    : 'The race duration and lap rule are not confirmed yet.';
}

function unicodeLength(text) {
  return Array.from(String(text || '')).length;
}

function unicodeSlice(text, limit) {
  return Array.from(String(text || '')).slice(0, limit).join('');
}

// LLMの指示追従だけに依存せず、表示・TTS・会話履歴へ返す本文そのものを制限する。
// 上限超過時は最後の文末までを優先し、文末が無ければ句点を付けて尻切れを避ける。
function limitReplyText(text, maxChars) {
  const clean = String(text || '').trim();
  if (!clean || unicodeLength(clean) <= maxChars) return clean;
  const head = unicodeSlice(clean, maxChars);
  const points = Array.from(head);
  let lastBoundary = -1;
  for (let i = 0; i < points.length; i++) {
    if (/[。．！？!?]/.test(points[i])) lastBoundary = i;
  }
  if (lastBoundary >= Math.min(8, Math.floor(maxChars / 3))) {
    return points.slice(0, lastBoundary + 1).join('').trim();
  }
  return points.slice(0, Math.max(1, maxChars - 1)).join('').trimEnd() + '。';
}

function resolveReplyCharLimit(body, mode) {
  const defaults = mode === 'race' ? 35 : mode === 'debrief' ? 70 : 180;
  const hardCap = mode === 'race' ? 60 : mode === 'debrief' ? 70 : 300;
  const requested = Number.parseInt(body.max_chars, 10);
  return Math.min(Math.max(Number.isFinite(requested) ? requested : defaults, 12), hardCap);
}

// ── Chat proxy ──────────────────────────────────────────────────────────────
app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    let { system, messages, max_tokens = 300, userName, character, mode } = req.body;

    // コスト計測用session_id（クライアント値。認証には使わない。長さ・型のみサーバー側で検証）。
    const usageSessionId = (typeof req.body.usageSessionId === 'string' && req.body.usageSessionId.length <= 64)
      ? req.body.usageSessionId : null;

    // PITWALL entitlement was already enforced by the shared route middleware.

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
    let _directPitCommand = null;
    try {
      const _msgs = Array.isArray(req.body.messages) ? req.body.messages : [];
      const _lastUser = [..._msgs].reverse().find(m => m && m.role === 'user');
      const _lastText = _lastUser && typeof _lastUser.content === 'string'
        ? _lastUser.content : '';
      _strategyQ = _lastText
        ? strategyGuard.classifyStrategyQuestion(_lastUser.content, {
          activePitObjective: req.body.strategyObjective?.kind === 'pit_total_race_outcome'
            && req.body.strategyObjective?.status === 'active',
        }) : null;
      _directPitCommand = _lastText
        ? strategyGuard.classifyDirectRaceCommand(_lastUser.content) : null;
      const _lang = /JP$|Kanbe|Oishi/.test(String(character || '')) ? 'ja' : 'en';
      if (isAccountChangeRequest(_lastText)) {
        console.log('[account_guard] conversational account change blocked');
        return sendGuardReply(req, res, buildAccountChangeReply(_lang), 100);
      }
      if (mode === 'race' && _directPitCommand) {
        const _directReply = buildDirectPitReply(_directPitCommand, req.body.liveData, _lang);
        if (_directReply) {
          console.log(`[INTENT_ROUTE] intent=${_directPitCommand.topic} confidence=1 handler=fired`);
          return sendGuardReply(req, res, _directReply, 100, 'deterministic', _directPitCommand.topic);
        }
      }
      if (mode === 'race' && isRaceRuleQuestion(_lastText)) {
        console.log('[INTENT_ROUTE] intent=race_distance confidence=1 handler=fired');
        return sendGuardReply(req, res, buildRacePlanReply(req.body.liveData, _lang), 110,
          'deterministic', engineerCard.TOPIC.RACE_DISTANCE);
      }
      const _recentUserText = _msgs.slice(0, -1).reverse()
        .find(m => m && m.role === 'user' && typeof m.content === 'string')?.content || '';
      const _engineerLive = {
        ...(req.body.liveData && typeof req.body.liveData === 'object' ? req.body.liveData : {}),
        session_type: req.body.sessionType
          || (req.body.liveData && req.body.liveData.session_type),
      };
      // ★八木さん実走ログ 7-1 / 7-2（2026-08-11・Barcelona Practice）：
      //   セットアップ相談は本来 Practice で起きる。race mode でしかカードを引かないと、
      //   相談が決定論ハンドラに届かず温度読み上げで終わる。
      //   影響範囲を広げないため、race 以外で採用するのは setup 相談だけに限定する。
      const _cardRoute = engineerCard.route(_lastText, _engineerLive, _lang, {
        race: mode === 'race', recentText: _recentUserText,
      });
      // Internal pace probes are not driver questions. Routing the literal
      // "[PACE_CHECK]" through the conversation card matched PACE and turned
      // a periodic background probe into the deterministic fuel reply every
      // few laps. Keep it on the dedicated one-shot judgement path below.
      const _engineerRoute = (mode === 'race' && !req.body.paceCheck)
        ? _cardRoute
        : (_cardRoute && _cardRoute.card
           && _cardRoute.card.topic === engineerCard.TOPIC.HANDLING_SETUP_ADVICE
           ? _cardRoute : null);
      // Keep the established Phase-C path for the exact "pit now -> where"
      // contract: it carries calibration reasons, traffic and blend evidence.
      // Broader undercut/cycle language is handled by the new runtime card.
      if (_engineerRoute && !(_engineerRoute.card.topic === engineerCard.TOPIC.REJOIN && _strategyQ)) {
        const _intent = _engineerRoute.card.topic;
        console.log(`[INTENT_ROUTE] intent=${_intent} confidence=${_engineerRoute.card.confidence ?? 0} handler=${_engineerRoute.status}`);
        return sendGuardReply(req, res, _engineerRoute.reply, 180, 'deterministic', _intent);
      }
      if (mode === 'race' && isFuelQuestion(_lastText)) {
        console.log('[fuel_guard] authoritative fuel reply');
        return sendGuardReply(req, res, buildFuelAuthorityReply(_engineerLive, _lang), 110);
      }
    } catch (e) {
      console.log('[strategy_guard] classify skipped: ' + e.message);   // 分類前の失敗のみ通常経路へ
    }
    // 例外fallbackでもRace以外にピット無線を漏らさない。
    if (mode === 'race' && _directPitCommand) {
      const _lang = /JP$|Kanbe|Oishi/.test(String(character || '')) ? 'ja' : 'en';
      const _reply = buildDirectPitReply(_directPitCommand, req.body.liveData, _lang);
      if (_reply) {
        console.log(`[strategy_guard] direct=${_directPitCommand.topic} -> authoritative reply`);
        return sendGuardReply(req, res, _reply, 100);
      }
    }
    if (_strategyQ) {
      // ★P1-2（Codexレビュー）：対象質問だと分かった後は fail-closed。
      //   評価／返答生成で例外が起きても自由文LLMへは絶対に流さない
      //   （＝計算できないのに答えたふりをする経路を、ガード自身の不具合で復活させない）。
      try {
        // sessionTypeはトップレベルで送られる（liveData配下ではない・P1-5修正）
        const _sessionType = req.body.sessionType;
        const _forecast = req.body.liveData && req.body.liveData.pit_exit_forecast;
        const _avail = strategyGuard.evaluateAvailability(_strategyQ.topic, {
          hasRejoinCalculator: !!(_forecast && _forecast.available),
          isRaceSession: _sessionType ? /race/i.test(String(_sessionType)) : undefined,
        });
        if (!_avail.available) {
          const _lang = /JP$|Kanbe|Oishi/.test(String(character || '')) ? 'ja' : 'en';
          if (_forecast && ['calibration_not_ready', 'calibration_insufficient_samples']
            .includes(_forecast.unavailable_reason)) {
            console.log(`[strategy_guard] topic=${_strategyQ.topic} reason=${_forecast.unavailable_reason} -> calibration reply`);
            return sendGuardReply(req, res, buildPitCalibrationReply(_forecast, _lang), 90);
          }
          if (_forecast && _forecast.available === false) {
            const _reply = _lang === 'ja'
              ? '復帰予測に必要なライブデータが揃っていない。今は順位を出せない。'
              : 'The live data needed for a rejoin forecast is incomplete. I cannot give a position now.';
            console.log(`[strategy_guard] topic=${_strategyQ.topic} reason=${_forecast.unavailable_reason || 'live_data_incomplete'} -> live-data reply`);
            return sendGuardReply(req, res, _reply, 100);
          }
          const _reply = strategyGuard.buildUnavailableReply(_avail.reason, _lang)
            || strategyGuard.buildUnavailableReply(strategyGuard.REASON.NO_CALCULATOR, _lang);
          console.log(`[strategy_guard] topic=${_strategyQ.topic} reason=${_avail.reason} -> structured reply`);
          return sendGuardReply(req, res, _reply);
        }
        const _lang = /JP$|Kanbe|Oishi/.test(String(character || '')) ? 'ja' : 'en';
        const _reply = buildPitExitForecastReply(_forecast, _lang);
        if (!_reply) throw new Error('pit exit forecast payload incomplete');
        console.log(`[strategy_guard] topic=${_strategyQ.topic} forecast=${_forecast.snapshot_id} -> Phase C reply`);
        return sendGuardReply(req, res, _reply, 120);
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
    const safeMaxChars = resolveReplyCharLimit(req.body, mode);

    // ユーザーログ（Railway のログで確認可能）
    if (userName) {
      const now = new Date().toISOString();
      console.log(`[${now}] 👤 ${userName} | 🎭 ${character || '?'} | 💬 turn ${messages.filter(m=>m.role==='user').length}`);
    }

    // Race mode: Haiku (2-3x faster, sufficient for short radio calls)
    const model = (mode === 'race') ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-5';

    // 実測コストログ（Railwayログは7日で消えるため、DBにも永続化する。粗利率の実測に使う）
    const { source: usageSource, trigger: usageTrigger } = deriveUsageSourceTrigger(req.body);
    const usageContext = deriveUsageContext(req.body, usageSource);
    const logUsage = (usage) => {
      if (!usage) return;
      console.log(`[USAGE] user=${userName || '?'} char=${character || '?'} mode=${mode || '?'} model=${model} source=${usageSource} in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0}`);
      if (auth.isReady()) {
        auth.recordApiUsage({
          userId: req.user ? req.user.id : null, betaTokenHash: req.betaTokenHash || null, sessionId: usageSessionId,
          character, mode, source: usageSource, trigger: usageTrigger, usageContext, model, usage,
          environment: PITWALL_ENVIRONMENT,
        }).catch(err => console.error('[USAGE] DB write failed:', err.message));
      }
    };

    // ── ストリーミング：文字が生成された端からクライアントへ流す（体感レスポンス短縮）──
    // クライアントが stream:true を送った時のみ。生成量＝同じなのでコストは増えない。
    // renderer側は文が完成するたびTTS再生するので「流れるような会話」になる。
    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');  // プロキシのバッファリング無効化（即時flush）
      let streamUsage = null;
      let pendingText = '';
      let emittedText = '';
      let outputClosed = false;
      const emitCompleteSentences = (final = false) => {
        if (outputClosed) return;
        while (pendingText) {
          const boundary = pendingText.search(/[。．！？!?\n]/);
          if (boundary < 0 && !final) return;
          // 完成文の後にモデルがtoken上限等で単語途中のまま終了した場合、
          // 未完tailは捨てる。「。ス」のような断片を表示/TTSへ流さない。
          if (boundary < 0 && final && emittedText) {
            pendingText = '';
            outputClosed = true;
            return;
          }
          const take = boundary >= 0 ? boundary + 1 : pendingText.length;
          const sentence = pendingText.slice(0, take).trim();
          pendingText = pendingText.slice(take);
          if (!sentence) continue;
          const remaining = safeMaxChars - unicodeLength(emittedText);
          if (remaining <= 0) {
            outputClosed = true;
            return;
          }
          // 既に完全な一文を返しているなら、残り枠へ次の文を途中まで詰めない。
          // 「最終ラッ。」「次回は見越。」のような尻切れより、完成文1つを優先する。
          if (emittedText && unicodeLength(sentence) > remaining) {
            outputClosed = true;
            return;
          }
          const limited = limitReplyText(sentence, remaining);
          if (limited) {
            res.write(limited);
            emittedText += limited;
            if (typeof res.flush === 'function') res.flush();
          }
          if (unicodeLength(sentence) > remaining || unicodeLength(emittedText) >= safeMaxChars) {
            outputClosed = true;
            return;
          }
        }
      };
      try {
        const stream = await client.messages.create({
          model, max_tokens: safeMaxTokens, system, messages, stream: true,
        });
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
            if (!outputClosed) {
              pendingText += event.delta.text;
              emitCompleteSentences(false);
            }
          } else if (event.type === 'message_start') {
            streamUsage = { ...event.message.usage };
          } else if (event.type === 'message_delta' && event.usage) {
            streamUsage = { ...streamUsage, output_tokens: event.usage.output_tokens };
          }
        }
        emitCompleteSentences(true);
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
    if (Array.isArray(response.content)) {
      response.content = response.content.map(block => (
        block && block.type === 'text'
          ? { ...block, text: limitReplyText(block.text, safeMaxChars) }
          : block
      ));
    }
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
    // PITWALL entitlement was already enforced by the shared route middleware.
    const text = (req.body.text || '').toString().slice(0, 500);
    const target = req.body.target === 'ja' ? 'Japanese' : 'English';
    if (!text.trim()) return res.json({ text: '' });

    const translateModel = 'claude-haiku-4-5-20251001';
    const r = await client.messages.create({
      model: translateModel,
      max_tokens: 200,
      system: `You are a subtitle translator for a motorsport race-engineer radio overlay. Translate the user's line into ${target}. Keep it terse and natural, like a real radio call. Preserve driver/car numbers, positions (P3), lap/sector terms, and units (°C, L). Output ONLY the translation — no quotes, no notes, no romaji.`,
      messages: [{ role: 'user', content: text }],
    });
    // 失敗時（例外側）はusageが無いので記録しない。成功時のみusageが存在する。
    if (r.usage && auth.isReady()) {
      const usageSessionId = (typeof req.body.usageSessionId === 'string' && req.body.usageSessionId.length <= 64)
        ? req.body.usageSessionId : null;
      auth.recordApiUsage({
        userId: req.user ? req.user.id : null, betaTokenHash: req.betaTokenHash || null, sessionId: usageSessionId,
        source: 'translate', trigger: null, model: translateModel, usage: r.usage,
        environment: PITWALL_ENVIRONMENT,
      }).catch(err => console.error('[USAGE] DB write failed (translate):', err.message));
    }
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
      recordGoogleUsageSafe(req, { kind: 'tts', charCount: text.length, voice: ttsBody.voice.name, language: ttsBody.voice.languageCode, success: false });
      return res.status(502).json({ error: 'tts_failed' });
    }
    const data = await r.json();
    recordGoogleUsageSafe(req, { kind: 'tts', charCount: text.length, voice: ttsBody.voice.name, language: ttsBody.voice.languageCode, success: true });
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
    // bridge.pyがraw PCMから逆算した実測秒数（LINEAR16経路のみ送られる）。数値・0以上・現実的な
    // PTT録音上限(120秒)以内のみ採用。推測で埋めない＝範囲外や非数値はNULLのままにする。
    const MAX_PTT_SECONDS = 120;
    const rawDuration = req.body.audioDurationSeconds;
    const audioDurationSeconds = (typeof rawDuration === 'number' && Number.isFinite(rawDuration)
      && rawDuration >= 0 && rawDuration <= MAX_PTT_SECONDS) ? rawDuration : null;
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
    // audio_bytesは常に実測できる診断用の補助値（主単位ではない）。
    // audio_secondsはbridge.pyがLINEAR16 raw PCMから逆算した実測秒数がある時だけ埋める。
    // WEBM_OPUS等の圧縮音声経路ではNULLのまま＝推測で秒数を作らない。
    const audioBytes = Buffer.byteLength(audio, 'base64');
    if (!r.ok) {
      const errText = await r.text();
      console.error('Google STT error:', r.status, errText);
      recordGoogleUsageSafe(req, { kind: 'stt', audioBytes, audioSeconds: audioDurationSeconds, language: lang, success: false });
      return res.status(502).json({ error: 'stt_failed', detail: errText.slice(0, 200) });
    }
    const data = await r.json();
    recordGoogleUsageSafe(req, { kind: 'stt', audioBytes, audioSeconds: audioDurationSeconds, language: lang, success: true });
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
