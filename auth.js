// ─────────────────────────────────────────────────────────────────────────────
// auth.js — OMORAY 会員基盤（マジックリンク認証・Neon Postgres・Gmail送信）
//   RaceVoice / PITWALL 共通の1アカウント。パスワードなし（メールのリンクで入る）。
//   フェイルセーフ設計：必要な環境変数が無ければ認証機能だけ無効化し、
//   既存のサイト（会話・TTS・STT）は今まで通り動く。
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

let Pool, nodemailer, jwt;
try {
  ({ Pool } = require('pg'));
  nodemailer = require('nodemailer');
  jwt = require('jsonwebtoken');
} catch (e) {
  console.warn('[auth] optional deps not installed yet:', e.message);
}

const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const GMAIL_USER = process.env.GMAIL_USER;               // 例: omoraypitwall@gmail.com（送信元アドレス）
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD; // （旧SMTP用・RailwayはSMTP遮断のため未使用）
// Brevo（HTTP API・ポート443・PaaSでも遮断されない）でメール送信
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || GMAIL_USER || 'omoraypitwall@gmail.com'; // Brevoで認証済みの送信元
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'OMORAY PITWALL';
const BASE_URL = (process.env.BASE_URL || 'https://english-voice-app-production.up.railway.app').replace(/\/$/, '');

const MAGIC_TTL_MIN = 20;        // マジックリンクの有効期限（分）
const SESSION_TTL_DAYS = 60;     // ログインセッション（JWT）の有効期限（日）

// ── 状態 ──
let pool = null;
let mailer = null;
let ready = false;

function isConfigured() {
  return !!(Pool && DATABASE_URL && JWT_SECRET);
}

// ── 初期化（サーバー起動時に1回呼ぶ。未設定なら静かにスキップ） ──
async function init() {
  if (!isConfigured()) {
    console.warn('[auth] disabled — set DATABASE_URL and JWT_SECRET to enable login.');
    return false;
  }
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            BIGSERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login    TIMESTAMPTZ,
      is_member     BOOLEAN NOT NULL DEFAULT false,   -- PITWALL課金者フラグ
      plan          TEXT,                             -- 'founding' | 'standard' | 'pro' 等
      stripe_customer_id TEXT,
      subscription_status TEXT,                       -- 'active' | 'canceled' | null
      display_name  TEXT,
      leaderboard_opt_in BOOLEAN NOT NULL DEFAULT false  -- 将来のランキング/速報ページにニックネーム表示を許可するか（明示同意）
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_tokens (
      token       TEXT PRIMARY KEY,
      email       TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      used        BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // ベータ・テスター用アクセスコード（八木さん・Tobi等の限定配布を管理）。
  //   隠しロックではなく「Yujiが発行した個人コード」。Yujiがactive=falseで即無効化できる。
  //   tier: 'lifetime'=永久無料 / 'cost_share'=billing_start以降にコスト代($9.99/年)請求。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS beta_tokens (
      code          TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      tier          TEXT NOT NULL DEFAULT 'lifetime',
      active        BOOLEAN NOT NULL DEFAULT true,
      billing_start DATE,
      note          TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen     TIMESTAMPTZ
    );
  `);
  // 大石との会話・成長記録（アカウントに紐付く永続メモリ）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character   TEXT,
      kind        TEXT,          -- 'summary' | 'track_best' | 'note' 等
      content     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  if (BREVO_API_KEY) {
    mailer = 'brevo';
    // 診断：鍵の長さと頭だけログ（秘密は出さない）。正しいv3鍵は xkeysib- で始まり約89文字。
    console.log('[auth] BREVO key check: len=' + BREVO_API_KEY.length +
      ' prefix=' + JSON.stringify(BREVO_API_KEY.slice(0, 9)) +
      ' tailhasSpace=' + /\s/.test(BREVO_API_KEY));
    console.log('[auth] email via Brevo HTTP API (from ' + EMAIL_FROM + ').');
  } else if (nodemailer && GMAIL_USER && GMAIL_APP_PASSWORD) {
    // フォールバック（ローカル開発用）。RailwayはSMTP遮断のため本番では不可。
    mailer = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      connectionTimeout: 12000, greetingTimeout: 10000, socketTimeout: 12000,
    });
    console.warn('[auth] email via Gmail SMTP (may be blocked on PaaS).');
  } else {
    console.warn('[auth] email disabled — set BREVO_API_KEY to send magic links.');
  }

  ready = true;
  console.log('[auth] ready (Neon connected).');
  return true;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// ── メール送信（Brevo HTTP APIを優先。無ければnodemailerフォールバック） ──
async function sendEmail({ to, subject, text, html }) {
  if (mailer === 'brevo') {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({
        sender: { email: EMAIL_FROM, name: EMAIL_FROM_NAME },
        to: [{ email: to }],
        subject, textContent: text, htmlContent: html,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error('brevo_send_failed: ' + resp.status + ' ' + detail.slice(0, 200));
    }
    return;
  }
  if (mailer && mailer.sendMail) {
    await mailer.sendMail({ from: `${EMAIL_FROM_NAME} <${EMAIL_FROM}>`, to, subject, text, html });
    return;
  }
  throw new Error('no_mailer');
}

// ── マジックリンク発行＋メール送信 ──
async function requestMagicLink(rawEmail, product) {
  if (!ready) throw new Error('auth_not_ready');
  const email = normalizeEmail(rawEmail);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('invalid_email');

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + MAGIC_TTL_MIN * 60 * 1000);
  await pool.query(
    'INSERT INTO login_tokens (token, email, expires_at) VALUES ($1, $2, $3)',
    [token, email, expires]
  );

  const verifyUrl = `${BASE_URL}/api/auth/verify?token=${token}` +
    (product ? `&product=${encodeURIComponent(product)}` : '');

  if (!mailer) {
    // メール未設定時：開発用にリンクをログへ（本番では必ずメール設定する）
    console.warn('[auth] (no mailer) magic link for', email, '->', verifyUrl);
    return { sent: false, devLink: verifyUrl };
  }

  await sendEmail({
    to: email,
    subject: 'OMORAY ログインリンク / Your login link',
    text:
      `ログインするには次のリンクを開いてください（${MAGIC_TTL_MIN}分間有効）:\n${verifyUrl}\n\n` +
      `Open this link to log in (valid ${MAGIC_TTL_MIN} min):\n${verifyUrl}\n\n` +
      `心当たりがなければ無視してください。 / If you didn't request this, ignore this email.`,
    html:
      `<div style="font-family:system-ui,sans-serif;max-width:480px">
        <h2 style="color:#9D4EDD">OMORAY PITWALL</h2>
        <p>下のボタンでログイン（${MAGIC_TTL_MIN}分間有効）／ Click to log in (valid ${MAGIC_TTL_MIN} min):</p>
        <p><a href="${verifyUrl}" style="display:inline-block;background:#9D4EDD;color:#fff;
           padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">ログイン / Log in</a></p>
        <p style="color:#888;font-size:12px">心当たりがなければ無視してください。<br>If you didn't request this, ignore this email.</p>
      </div>`,
  });
  return { sent: true };
}

// ── リンク検証 → ユーザー確定 → セッションJWT発行 ──
async function verifyMagicToken(token) {
  if (!ready) throw new Error('auth_not_ready');
  if (!token) throw new Error('missing_token');

  const { rows } = await pool.query(
    'SELECT * FROM login_tokens WHERE token = $1', [token]
  );
  const rec = rows[0];
  if (!rec) throw new Error('invalid_token');
  if (rec.used) throw new Error('token_used');
  if (new Date(rec.expires_at) < new Date()) throw new Error('token_expired');

  await pool.query('UPDATE login_tokens SET used = true WHERE token = $1', [token]);

  // ユーザーを作成 or 取得
  const up = await pool.query(
    `INSERT INTO users (email, last_login) VALUES ($1, now())
     ON CONFLICT (email) DO UPDATE SET last_login = now()
     RETURNING *`,
    [rec.email]
  );
  const user = up.rows[0];
  const sessionJwt = jwt.sign(
    { uid: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: `${SESSION_TTL_DAYS}d` }
  );
  return { user, token: sessionJwt };
}

// ── JWTからユーザーを引く ──
async function getUserFromToken(bearer) {
  if (!ready || !bearer) return null;
  try {
    const payload = jwt.verify(bearer, JWT_SECRET);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.uid]);
    return rows[0] || null;
  } catch {
    return null;
  }
}

function publicUser(u) {
  if (!u) return null;
  return {
    email: u.email,
    isMember: u.is_member,
    plan: u.plan || null,
    subscriptionStatus: u.subscription_status || null,
    displayName: u.display_name || null,
    leaderboardOptIn: u.leaderboard_opt_in || false,
  };
}

// ニックネーム（呼び名）とランキング公開同意を更新。本名でなく識別子にも使わない＝表示専用。
async function updateProfile(userId, { displayName, leaderboardOptIn }) {
  if (!ready) throw new Error('auth_not_ready');
  const name = typeof displayName === 'string' ? displayName.trim().slice(0, 40) : null;
  const optIn = !!leaderboardOptIn;
  const { rows } = await pool.query(
    `UPDATE users SET display_name = COALESCE($1, display_name), leaderboard_opt_in = $2 WHERE id = $3 RETURNING *`,
    [name, optIn, userId]
  );
  return rows[0] || null;
}

// ── 課金／会員管理（Stripe Webhookから呼ぶ） ──
const FOUNDING_CAP = parseInt(process.env.FOUNDING_CAP || '50', 10);

// 決済成功 → そのメールのユーザーを会員化（アカウントが無ければ作る）
async function setMemberByEmail(rawEmail, { plan, stripeCustomerId, subscriptionStatus } = {}) {
  if (!ready) throw new Error('auth_not_ready');
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error('no_email');
  const { rows } = await pool.query(
    `INSERT INTO users (email, is_member, plan, stripe_customer_id, subscription_status)
     VALUES ($1, true, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET
       is_member = true,
       plan = COALESCE($2, users.plan),
       stripe_customer_id = COALESCE($3, users.stripe_customer_id),
       subscription_status = COALESCE($4, users.subscription_status)
     RETURNING *`,
    [email, plan || 'founding', stripeCustomerId || null, subscriptionStatus || 'active']
  );
  log('member set: ' + email + ' (plan=' + (plan || 'founding') + ')');
  return rows[0];
}

// 解約 → 会員フラグを落とす（Stripe customer id で特定）
async function unsetMemberByCustomer(stripeCustomerId, status) {
  if (!ready || !stripeCustomerId) return;
  await pool.query(
    `UPDATE users SET is_member = false, subscription_status = $2 WHERE stripe_customer_id = $1`,
    [stripeCustomerId, status || 'canceled']
  );
  log('member unset (customer ' + stripeCustomerId + ')');
}

// 現在の会員数と Founding 枠の残り
async function foundingStatus() {
  if (!ready) return { members: 0, cap: FOUNDING_CAP, spotsLeft: FOUNDING_CAP, soldOut: false };
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE is_member = true');
  const members = rows[0].n;
  const spotsLeft = Math.max(0, FOUNDING_CAP - members);
  return { members, cap: FOUNDING_CAP, spotsLeft, soldOut: spotsLeft <= 0 };
}

// ── ベータ・アクセスコード照合（exe起動ゲート） ──
function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

async function verifyBetaToken(rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, reason: 'empty' };
  if (!ready) return { ok: false, reason: 'unavailable' };
  const { rows } = await pool.query('SELECT * FROM beta_tokens WHERE code = $1', [code]);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (!row.active) return { ok: false, reason: 'revoked' };
  // 最終接続時刻を更新（Yujiが「最後にいつ使ったか」を見られる）
  pool.query('UPDATE beta_tokens SET last_seen = now() WHERE code = $1', [code]).catch(() => {});
  return { ok: true, name: row.name, tier: row.tier };
}

// ── ベータコード管理（Yuji専用・ADMIN_SECRETで保護） ──
function genBetaCode(name) {
  const tag = String(name || 'USER').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'USER';
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6桁
  return `PITWALL-${tag}-${rand}`;
}

async function createBetaToken({ name, tier = 'lifetime', billingStart = null, note = null }) {
  if (!ready) throw new Error('unavailable');
  const code = genBetaCode(name);
  await pool.query(
    `INSERT INTO beta_tokens (code, name, tier, billing_start, note) VALUES ($1,$2,$3,$4,$5)`,
    [code, name || 'tester', tier, billingStart, note]
  );
  return { code, name, tier, billingStart };
}

async function listBetaTokens() {
  if (!ready) return [];
  const { rows } = await pool.query(
    `SELECT code, name, tier, active, billing_start, note, created_at, last_seen
       FROM beta_tokens ORDER BY created_at DESC`
  );
  return rows;
}

async function setBetaActive(rawCode, active) {
  if (!ready) throw new Error('unavailable');
  const code = normalizeCode(rawCode);
  const { rowCount } = await pool.query(
    `UPDATE beta_tokens SET active = $2 WHERE code = $1`, [code, !!active]
  );
  return { ok: rowCount > 0 };
}

// Authorizationヘッダ（Bearer）or ?token= から現在ユーザーを解決するミドルウェア
async function attachUser(req, _res, next) {
  try {
    const h = req.headers.authorization || '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7)
      : (req.query && req.query.token) ? String(req.query.token) : null;
    req.user = await getUserFromToken(bearer);
  } catch { req.user = null; }
  next();
}

module.exports = {
  init, isConfigured, isReady: () => ready,
  requestMagicLink, verifyMagicToken, getUserFromToken,
  publicUser, attachUser, updateProfile,
  setMemberByEmail, unsetMemberByCustomer, foundingStatus,
  verifyBetaToken, createBetaToken, listBetaTokens, setBetaActive,
  FOUNDING_CAP,
  _pool: () => pool,
};
