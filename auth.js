// ─────────────────────────────────────────────────────────────────────────────
// auth.js — OMORAY 会員基盤（マジックリンク認証・Neon Postgres・Gmail送信）
//   RaceVoice / PITWALL 共通の1アカウント。パスワードなし（メールのリンクで入る）。
//   フェイルセーフ設計：必要な環境変数が無ければ認証機能だけ無効化し、
//   既存のサイト（会話・TTS・STT）は今まで通り動く。
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

let Pool, nodemailer, jwt, stripe;
try {
  ({ Pool } = require('pg'));
  nodemailer = require('nodemailer');
  jwt = require('jsonwebtoken');
} catch (e) {
  console.warn('[auth] optional deps not installed yet:', e.message);
}
try {
  const StripeLib = require('stripe');
  if (process.env.STRIPE_SECRET_KEY) stripe = new StripeLib(process.env.STRIPE_SECRET_KEY);
} catch (e) { console.warn('[auth] stripe lib not installed:', e.message); }

const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const GMAIL_USER = process.env.GMAIL_USER;               // 例: omoraypitwall@gmail.com（送信元アドレス）
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD; // （旧SMTP用・RailwayはSMTP遮断のため未使用）
// Brevo（HTTP API・ポート443・PaaSでも遮断されない）でメール送信
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || GMAIL_USER || 'omoraypitwall@gmail.com'; // Brevoで認証済みの送信元
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'OMORAY PITWALL';
// 購入時のwelcomeメールをYujiにもBCCする（新規会員をリアルタイムで把握するため）
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'sbyyj.080711@gmail.com';
const BASE_URL = (process.env.BASE_URL || 'https://www.omoraypitwall.com').replace(/\/$/, '');

// 軽量ログヘルパー。以前 setMemberByEmail / unsetMemberByCustomer 等が未定義の log() を呼び、
// INSERT/UPDATE後にReferenceErrorでwebhookが500クラッシュ→welcomeメール未送信＆Stripeリトライ地獄になっていた。
function log(msg) { console.log('[auth] ' + msg); }

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
      leaderboard_opt_in BOOLEAN NOT NULL DEFAULT false,  -- 将来のランキング/速報ページにニックネーム表示を許可するか（明示同意）
      referral_code TEXT UNIQUE,                         -- Founding会員専用の個人紹介コード（Stripe Promotion Codeと1:1）
      exe_code      TEXT UNIQUE                          -- Founding会員専用のexe起動コード（beta_tokensと1:1・SNSシェア用）
    );
  `);
  // 既存DBへの追加カラム（テーブルは既に存在するため IF NOT EXISTS の CREATE TABLE では追加されない）
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS exe_code TEXT UNIQUE;`);
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
  // exe起動コードのデバイス紐付け（2026-07-11深夜追加）。
  //   従来はactiveフラグのみでゲートしていたため、1コードを友達に配ると無制限に無課金で使い放題になる
  //   穴があった。ここで「1コードにつき使える端末はMAX_DEVICES_PER_CODE台まで」に制限する。
  //   deviceIdを送らない旧exe（アップデート前）はこれまで通り無制限のまま＝後方互換のための経過措置。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS beta_token_devices (
      code        TEXT NOT NULL REFERENCES beta_tokens(code) ON DELETE CASCADE,
      device_id   TEXT NOT NULL,
      first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (code, device_id)
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
async function sendEmail({ to, subject, text, html, bcc }) {
  if (mailer === 'brevo') {
    const payload = {
      sender: { email: EMAIL_FROM, name: EMAIL_FROM_NAME },
      to: [{ email: to }],
      subject, textContent: text, htmlContent: html,
    };
    if (bcc) payload.bcc = [{ email: bcc }];
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error('brevo_send_failed: ' + resp.status + ' ' + detail.slice(0, 200));
    }
    return;
  }
  if (mailer && mailer.sendMail) {
    await mailer.sendMail({ from: `${EMAIL_FROM_NAME} <${EMAIL_FROM}>`, to, subject, text, html, bcc });
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
// 1つのexeコードで「現在有効」な端末の上限。iRacingと同じPCで動かす前提のアプリなので1に設定。
// 上限を超えたら締め出すのではなく、一番古い（last_seenが最も過去の）端末を追い出して新しい端末を通す
// 「椅子取りゲーム」方式（詳しくはverifyBetaToken）。再インストールや機種変更は自然に通り、
// 友達に貸すと次に本人が起動した瞬間に本人が席を奪い返す＝どちらか一方しか使えない状態になる。
const MAX_DEVICES_PER_CODE = parseInt(process.env.MAX_DEVICES_PER_CODE || '1', 10);

// 決済成功 → そのメールのユーザーを会員化（アカウントが無ければ作る）
// justActivated: 直前まで非会員だった（新規 or 再課金）→ ウェルカムメールを送るべきタイミング。
// Stripeのwebhookは再送されうる（at-least-once）ので、既に会員だった場合はfalseになり重複送信されない。
async function setMemberByEmail(rawEmail, { plan, stripeCustomerId, subscriptionStatus, displayName } = {}) {
  if (!ready) throw new Error('auth_not_ready');
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error('no_email');
  const before = await pool.query('SELECT is_member FROM users WHERE email = $1', [email]);
  const wasMember = before.rows[0] && before.rows[0].is_member === true;
  const { rows } = await pool.query(
    `INSERT INTO users (email, is_member, plan, stripe_customer_id, subscription_status, display_name)
     VALUES ($1, true, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET
       is_member = true,
       plan = COALESCE($2, users.plan),
       stripe_customer_id = COALESCE($3, users.stripe_customer_id),
       subscription_status = COALESCE($4, users.subscription_status),
       display_name = COALESCE(users.display_name, $5)
     RETURNING *`,
    [email, plan || 'founding', stripeCustomerId || null, subscriptionStatus || 'active', displayName || null]
  );
  log('member set: ' + email + ' (plan=' + (plan || 'founding') + ')');
  // 再加入の場合、以前解約時に無効化したexeコードを再有効化する（払ってるのに使えない、を防ぐ）
  const exeCode = rows[0] && rows[0].exe_code;
  if (exeCode) {
    await pool.query('UPDATE beta_tokens SET active = true WHERE code = $1', [exeCode]);
  }
  return { ...rows[0], justActivated: !wasMember };
}

// Founding会員だけの個人紹介コード（例: REF-A1B2C3）を発行する。
// ★2026-07-11修正：以前はStripeのPromotion Code（REFERRED_1MONTH_FREEクーポン紐付き・利用回数無制限）を
//   同時に作っていたため、このコードを友達がチェックアウトで入力すると誰でも無制限に初月無料になれる
//   状態だった（当初は「紹介された側も初月無料」という設計だったが、7/11に「紹介された側には特典なし・
//   5日トライアルのみ」に変更した際、このバックエンド実装の追従を忘れていた）。
//   Marboの実購入で実際に発行された穴（REF-WPHDC5）が見つかり、手動でアーカイブして対処。
//   今後はStripeに一切触れない、DBだけの識別コードにする（紹介の帰属確認・手動報告用の文字列のみ）。
async function ensureReferralCode(email) {
  if (!ready) return null;
  const { rows } = await pool.query('SELECT id, referral_code FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user) return null;
  if (user.referral_code) return user.referral_code;

  // 短く読みやすいコード（紛らわしい文字0/O/1/Iは除外）。衝突したら数回だけ振り直す。
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const genCode = () => 'REF-' + Array.from({ length: 6 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genCode();
    try {
      await pool.query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, user.id]);
      log('referral code created (DB-only, no Stripe coupon): ' + email + ' -> ' + code);
      return code;
    } catch (e) {
      // unique_violation = コード重複（激レア）→ 振り直す。
      if (e && e.code === '23505') continue;
      log('referral code creation failed for ' + email + ': ' + (e && e.message || e));
      return null;
    }
  }
  log('referral code creation gave up after retries for ' + email);
  return null;
}

// exe起動用の個人コード（PITWALL-<名前>-<6桁英数字>）。beta_tokensに直接登録するので
// 発行した瞬間からverifyBetaTokenで通る。Founding購入者本人専用（最大MAX_DEVICES_PER_CODE台の端末まで）。
// ★2026-07-11深夜修正：以前は「SNSシェアして友人が使う想定」でactiveフラグのみのゲートだったため、
//   1コードを配るだけで無制限に無課金の同時利用が可能になっていた（サブスクモデルが無意味になる穴）。
//   今後はデバイス台数で絞る。友人に本アプリを勧める導線は紹介コード（5日間トライアル）に一本化する。
async function ensureExeCode(email) {
  if (!ready) return null;
  const { rows } = await pool.query('SELECT id, exe_code, display_name FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user) return null;
  if (user.exe_code) return user.exe_code;

  // 名前セグメント：display_name（Stripe決済時の氏名 or exeニックネーム）の名だけ使う。
  // 「山田太郎」「Yuji Sato」等フルネームでも先頭の単語だけ切り出し、読みやすいコードにする
  // （例: PITWALL-YUJI-XXXXXX）。重複は6桁ランダムサフィックスで担保するので同名衝突は問題ない。
  const rawName = (user.display_name || email.split('@')[0] || 'DRIVER');
  const firstWord = rawName.trim().split(/\s+/)[0] || rawName;
  const nameSeg = firstWord.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'DRIVER';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const genCode = () => `PITWALL-${nameSeg}-` + Array.from({ length: 6 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genCode();
    try {
      await pool.query(
        `INSERT INTO beta_tokens (code, name, tier, note) VALUES ($1,$2,$3,$4)`,
        [code, rawName, 'founding', 'auto-generated at Founding purchase (SNS referral share)']
      );
      await pool.query('UPDATE users SET exe_code = $1 WHERE id = $2', [code, user.id]);
      log('exe code created: ' + email + ' -> ' + code);
      return code;
    } catch (e) {
      if (e && e.code === '23505') continue; // unique_violation（コード重複）→ 振り直す
      log('exe code creation failed for ' + email + ': ' + (e && e.message || e));
      return null;
    }
  }
  log('exe code creation gave up after retries for ' + email);
  return null;
}

// 会員化直後のウェルカムメール（justActivated===trueの時だけ呼ぶこと）
// plan==='founding' の時だけ、Founding限定の個人紹介コードを発行してメールに添える。
async function sendWelcomeEmail(rawEmail, plan) {
  const email = normalizeEmail(rawEmail);
  const welcomeUrl = `${BASE_URL}/welcome.html`;
  if (!mailer) {
    console.warn('[auth] (no mailer) welcome email for', email, '->', welcomeUrl);
    return { sent: false };
  }

  let referralCode = null;
  let exeCode = null;
  if (plan === 'founding') {
    try { referralCode = await ensureReferralCode(email); }
    catch (e) { log('ensureReferralCode threw for ' + email + ': ' + e.message); }
    try { exeCode = await ensureExeCode(email); }
    catch (e) { log('ensureExeCode threw for ' + email + ': ' + e.message); }
  }

  const referralText = referralCode
    ? `\n\nあなただけの紹介コード（Founding限定・永続特典）: ${referralCode}\n` +
      `友達があなたのリンク経由で加入し実際に課金開始したら、あなたは1人ごとに翌月33% OFF、3人で1ヶ月無料になります。\n\n` +
      `Your personal referral code (Founding-only, yours to keep): ${referralCode}\n` +
      `Bring 3 paid drivers to the grid — you get 33% off your next month per friend (100% off at 3), once their trial converts to a paid month.\n`
    : '';
  const referralHtml = referralCode
    ? `<div style="margin-top:20px;padding:16px 18px;border:1px dashed #9D4EDD;border-radius:10px;background:#f9f5ff">
        <p style="margin:0 0 8px;font-weight:bold;color:#333">Your referral code (Founding-only perk): <span style="color:#9D4EDD">${referralCode}</span></p>
        <p style="margin:0;font-size:13px;color:#666">Bring 3 paid drivers to the grid — you get 33% off your next month per friend (100% off at 3), once their trial converts to a paid month. あなたの紹介コード（Founding限定）。友達が実際に課金開始したら、あなたも1人ごとに翌月33%OFF。</p>
      </div>`
    : '';

  const exeText = exeCode
    ? `\n\nアプリのアクセスコード（あなた専用）: ${exeCode}\n` +
      `他人に教えないでください——このコードは1台の端末でしか使えないので、誰かがこれで起動すると、あなた自身が使えなくなります。友達を誘いたい時は、代わりに上の紹介コード（5日間無料トライアル）を渡してください。\n\n` +
      `Your app access code (personal): ${exeCode}\n` +
      `Don't give this to anyone — it only works on one device at a time, so if someone else uses it, you get locked out. To invite a friend, send them your referral code above (5-day free trial) instead.\n\n` +
      `起動時にWindowsの警告が出た方はこちら / If Windows shows a warning when you open it: ${BASE_URL}/help.html#first-launch\n`
    : '';
  const exeHtml = exeCode
    ? `<div style="margin-top:12px;padding:16px 18px;border:1px dashed #9D4EDD;border-radius:10px;background:#f9f5ff">
        <p style="margin:0 0 8px;font-weight:bold;color:#333">Your app access code (personal): <span style="color:#9D4EDD">${exeCode}</span></p>
        <p style="margin:0;font-size:13px;color:#666">Don't give this to anyone — it only works on one device at a time, so if someone else uses it, you get locked out. To invite a friend, send them your referral code above (5-day free trial) instead. アプリ起動用コード（あなた専用）。他人に教えないでください——1台の端末でしか使えないので、誰かが使うとあなた自身が使えなくなります。友達には代わりに上の紹介コードを渡してください。</p>
        <p style="margin:10px 0 0"><a href="${BASE_URL}/help.html#first-launch" style="color:#9D4EDD;font-size:13px;font-weight:bold">起動時にWindowsの警告が出た方はこちら → / If Windows shows a warning when you open it, click here →</a></p>
      </div>`
    : '';

  const shareUrl = referralCode
    ? `${BASE_URL}/refer.html?ref=${encodeURIComponent(referralCode)}`
    : null;
  const shareText = shareUrl
    ? `\n\n投稿用テンプレート（X/Instagram/TikTok・コピペOK）: ${shareUrl}\n` +
      `Ready-made posts for X/Instagram/TikTok, your codes pre-filled: ${shareUrl}\n`
    : '';
  const shareHtml = shareUrl
    ? `<p style="margin-top:14px"><a href="${shareUrl}" style="display:inline-block;background:#9D4EDD;color:#fff;
         padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px">Share PITWALL →</a></p>
       <p style="margin:6px 0 0;font-size:12px;color:#888">Ready-made posts for X/Instagram/TikTok, your codes pre-filled.</p>`
    : '';

  await sendEmail({
    to: email,
    bcc: ADMIN_NOTIFY_EMAIL,
    subject: 'Welcome to OMORAY PITWALL — Founding Season',
    text:
      `お支払いありがとうございます。Founding Seasonへようこそ！\n` +
      `セットアップはこちら: ${welcomeUrl}\n\n` +
      `Thanks for subscribing — welcome to the Founding Season!\n` +
      `Get set up here: ${welcomeUrl}` +
      referralText +
      exeText +
      shareText,
    html:
      `<div style="font-family:system-ui,sans-serif;max-width:480px">
        <h2 style="color:#9D4EDD">Welcome to OMORAY PITWALL</h2>
        <p>お支払いありがとうございます。Founding Seasonへようこそ！<br>
           Thanks for subscribing — welcome to the Founding Season.</p>
        <p><a href="${welcomeUrl}" style="display:inline-block;background:#9D4EDD;color:#fff;
           padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Get Set Up →</a></p>
        <p style="color:#888;font-size:12px">${welcomeUrl}</p>
        ${referralHtml}
        ${exeHtml}
        ${shareHtml}
      </div>`,
  });
  return { sent: true, referralCode, exeCode };
}

// 管理者による強制遮断／復帰（Stripe解約を待たず即座にis_memberを操作。悪質ユーザー対応用）
async function setMemberActive(rawEmail, active) {
  if (!ready) throw new Error('auth_not_ready');
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error('no_email');
  const { rows } = await pool.query(
    'UPDATE users SET is_member = $2 WHERE email = $1 RETURNING email, is_member',
    [email, !!active]
  );
  if (!rows[0]) return { ok: false, reason: 'user_not_found' };
  log('member ' + (active ? 'restored' : 'revoked') + ' (admin): ' + email);
  return { ok: true, email: rows[0].email, is_member: rows[0].is_member };
}

// 解約 → 会員フラグを落とす（Stripe customer id で特定）
async function unsetMemberByCustomer(stripeCustomerId, status) {
  if (!ready || !stripeCustomerId) return;
  const { rows } = await pool.query(
    `UPDATE users SET is_member = false, subscription_status = $2 WHERE stripe_customer_id = $1
     RETURNING exe_code`,
    [stripeCustomerId, status || 'canceled']
  );
  log('member unset (customer ' + stripeCustomerId + ')');
  // exe起動コードも同時に無効化（解約後も永久にアプリが使えてしまう穴を塞ぐ）
  const exeCode = rows[0] && rows[0].exe_code;
  if (exeCode) {
    await pool.query('UPDATE beta_tokens SET active = false WHERE code = $1', [exeCode]);
    log('exe code revoked on cancellation: ' + exeCode);
  }
}

// 自己解約用のStripe Billing Portalセッションを作る（メンバー本人が支払い方法変更・解約を自分でできる）。
// Stripeダッシュボード側で一度だけ「顧客ポータル」を有効化しておく必要あり（設定 → 課金 → 顧客ポータル）。
async function createBillingPortalSession(rawEmail) {
  if (!ready || !stripe) throw new Error('unavailable');
  const email = normalizeEmail(rawEmail);
  const { rows } = await pool.query('SELECT stripe_customer_id FROM users WHERE email = $1', [email]);
  const customerId = rows[0] && rows[0].stripe_customer_id;
  if (!customerId) throw new Error('no_subscription');
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${BASE_URL}/pitwall.html`,
  });
  return session.url;
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

async function verifyBetaToken(rawCode, rawDeviceId) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, reason: 'empty' };
  if (!ready) return { ok: false, reason: 'unavailable' };
  const { rows } = await pool.query('SELECT * FROM beta_tokens WHERE code = $1', [code]);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (!row.active) return { ok: false, reason: 'revoked' };

  // デバイス「椅子取りゲーム」（deviceIdを送ってくる新exeのみ対象・旧exeは後方互換で従来通り無制限）。
  //   上限に達している状態で未知の端末が来たら、一番last_seenが古い端末を追い出して席を空ける。
  //   締め出す＝ブロックするのではなく「奪い合う」ことで、再インストールは通し、貸し借りには
  //   毎回どちらかが使えなくなる摩擦を作る。
  const deviceId = String(rawDeviceId || '').trim().slice(0, 128);
  if (deviceId) {
    const known = await pool.query(
      'SELECT device_id FROM beta_token_devices WHERE code = $1 ORDER BY last_seen ASC', [code]
    );
    const knownIds = known.rows.map(r => r.device_id);
    if (!knownIds.includes(deviceId) && knownIds.length >= MAX_DEVICES_PER_CODE) {
      const evictCount = knownIds.length - MAX_DEVICES_PER_CODE + 1;
      const toEvict = knownIds.slice(0, evictCount);
      await pool.query(
        'DELETE FROM beta_token_devices WHERE code = $1 AND device_id = ANY($2)',
        [code, toEvict]
      );
    }
    await pool.query(
      `INSERT INTO beta_token_devices (code, device_id) VALUES ($1, $2)
       ON CONFLICT (code, device_id) DO UPDATE SET last_seen = now()`,
      [code, deviceId]
    );
  }

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
  setMemberByEmail, sendWelcomeEmail, setMemberActive, unsetMemberByCustomer, foundingStatus,
  createBillingPortalSession,
  verifyBetaToken, createBetaToken, listBetaTokens, setBetaActive,
  FOUNDING_CAP,
  _pool: () => pool,
};
