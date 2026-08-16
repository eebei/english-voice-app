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
  // 誰の紹介で来たか（紹介者のREFコード）。決済時のカスタムフィールド入力から記録（2026-07-19 Grow the Grid自動化）
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT;`);
  // 紹介の"実課金転換"を1人1回だけ数えるための台帳。PRIMARY KEYが冪等性の要
  // （Stripeのwebhook再送でも同じ友達を二度数えない）。percent_awardedは監査用の記録。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_conversions (
      referred_user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      referrer_code    TEXT NOT NULL,
      percent_awarded  INT NOT NULL,
      counted_at       TIMESTAMPTZ NOT NULL DEFAULT now()
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
  // Time-limited tester access is anchored in the database. Client clocks,
  // reinstalls and device changes cannot reset these values.
  await pool.query(`ALTER TABLE beta_tokens ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE beta_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;`);
  // 過去ログから抽出した本人申告を、該当テスターの認証済みPCへ一度だけ渡すための台帳。
  // 生ログやアクセスコードは保存しない。codeはサーバー内でのみハッシュ化して紐付ける。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_import_seeds (
      id              BIGSERIAL PRIMARY KEY,
      beta_token_hash TEXT NOT NULL,
      target_name     TEXT NOT NULL,
      source_label    TEXT NOT NULL,
      records         JSONB NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      acknowledged_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS memory_import_seeds_target_source_uq
      ON memory_import_seeds(beta_token_hash, source_label);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS memory_import_seeds_pending_idx
      ON memory_import_seeds(beta_token_hash, acknowledged_at, created_at);
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS founding_applications (
      id              BIGSERIAL PRIMARY KEY,
      program         TEXT NOT NULL DEFAULT 'general',
      email           TEXT NOT NULL,
      discord         TEXT,
      series          TEXT NOT NULL,
      discipline      TEXT NOT NULL,
      language        TEXT NOT NULL,
      expectations    TEXT,
      referral_source TEXT,
      page_lang       TEXT,
      consent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at     TIMESTAMPTZ
    );
  `);
  await pool.query(`ALTER TABLE founding_applications ADD COLUMN IF NOT EXISTS program TEXT NOT NULL DEFAULT 'general';`);
  await pool.query(`ALTER TABLE founding_applications ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ NOT NULL DEFAULT now();`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funnel_events (
      id              BIGSERIAL PRIMARY KEY,
      event           TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      anon_id         TEXT,
      lang            TEXT,
      utm_source      TEXT,
      utm_medium      TEXT,
      utm_campaign    TEXT,
      referrer        TEXT,
      extra           JSONB,
      is_test         BOOLEAN NOT NULL DEFAULT false,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // ★2026-07-23 Codexレビュー（P0-1〜P0-4, P1-1〜P1-2）：1レース・1ユーザー・経路別に原価を
  //   測れるよう、session_id/user_id/source/trigger/environmentを追加。user_nameは
  //   クライアント申告値のため原価帰属の主キーにしない（認証済みuser_idを正とする）。
  //   本テーブルは本番未デプロイのためALTER TABLEでなくCREATE TABLE定義を直接更新する。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_usage_log (
      id                  BIGSERIAL PRIMARY KEY,
      user_id             BIGINT,
      session_id          TEXT,
      character           TEXT,
      mode                TEXT,
      source              TEXT NOT NULL DEFAULT 'other',
      "trigger"           TEXT,
      model               TEXT NOT NULL,
      input_tokens        INTEGER NOT NULL DEFAULT 0,
      output_tokens       INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd  NUMERIC(12, 8),
      environment         TEXT,
      is_test             BOOLEAN NOT NULL DEFAULT false,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_usage_log_created_at ON api_usage_log (created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_usage_log_session_id ON api_usage_log (session_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_usage_log_user_id ON api_usage_log (user_id);`);
  await pool.query(`ALTER TABLE api_usage_log ADD COLUMN IF NOT EXISTS usage_context TEXT NOT NULL DEFAULT 'unknown';`);
  await pool.query(`ALTER TABLE api_usage_log ADD COLUMN IF NOT EXISTS beta_token_hash TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_usage_log_beta_hash ON api_usage_log (beta_token_hash);`);

  // Desktop の累積チェックポイント。session_id を主キーにすることで定期送信・終了時送信・
  // 次回起動時再送が重なっても二重計上しない。アクセスコードの生値は保存しない。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_session_checkpoints (
      session_id          TEXT PRIMARY KEY,
      user_id             BIGINT,
      beta_token_hash     TEXT,
      tester_name         TEXT,
      device_id_hash      TEXT,
      build               TEXT,
      sequence            INTEGER NOT NULL DEFAULT 0,
      started_at          TIMESTAMPTZ,
      ended_at            TIMESTAMPTZ,
      total_seconds       INTEGER NOT NULL DEFAULT 0,
      iracing_seconds     INTEGER NOT NULL DEFAULT 0,
      ptt_calls           INTEGER NOT NULL DEFAULT 0,
      typed_calls         INTEGER NOT NULL DEFAULT 0,
      auto_judge_calls    INTEGER NOT NULL DEFAULT 0,
      auto_pace_calls     INTEGER NOT NULL DEFAULT 0,
      briefing_calls      INTEGER NOT NULL DEFAULT 0,
      insight_calls       INTEGER NOT NULL DEFAULT 0,
      debrief_offered     INTEGER NOT NULL DEFAULT 0,
      debrief_started     INTEGER NOT NULL DEFAULT 0,
      debrief_completed   INTEGER NOT NULL DEFAULT 0,
      debrief_dismissed   INTEGER NOT NULL DEFAULT 0,
      practice_review_eligible  INTEGER NOT NULL DEFAULT 0,
      practice_review_offered   INTEGER NOT NULL DEFAULT 0,
      practice_review_started   INTEGER NOT NULL DEFAULT 0,
      practice_review_completed INTEGER NOT NULL DEFAULT 0,
      practice_review_saved     INTEGER NOT NULL DEFAULT 0,
      practice_review_manual    INTEGER NOT NULL DEFAULT 0,
      feedback_prompted   INTEGER NOT NULL DEFAULT 0,
      feedback_answered   INTEGER NOT NULL DEFAULT 0,
      normal_exit         BOOLEAN NOT NULL DEFAULT false,
      last_reason         TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_session_checkpoint_user_id ON usage_session_checkpoints (user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_session_checkpoint_beta_hash ON usage_session_checkpoints (beta_token_hash);`);
  for (const column of ['debrief_offered','debrief_started','debrief_completed','debrief_dismissed',
    'practice_review_eligible','practice_review_offered','practice_review_started',
    'practice_review_completed','practice_review_saved','practice_review_manual',
    'feedback_prompted','feedback_answered']) {
    await pool.query(`ALTER TABLE usage_session_checkpoints ADD COLUMN IF NOT EXISTS ${column} INTEGER NOT NULL DEFAULT 0;`);
  }

  // Google TTS/STT の生課金単位（正確な単価はまだ固定せず、Google Cloud請求と後から照合する）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS google_usage_log (
      id            BIGSERIAL PRIMARY KEY,
      user_id       BIGINT,
      session_id    TEXT,
      kind          TEXT NOT NULL,
      char_count    INTEGER,
      audio_bytes   INTEGER,
      audio_seconds NUMERIC(8, 3),
      voice         TEXT,
      language      TEXT,
      success       BOOLEAN NOT NULL,
      environment   TEXT,
      is_test       BOOLEAN NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_google_usage_log_created_at ON google_usage_log (created_at);`);
  await pool.query(`ALTER TABLE google_usage_log ADD COLUMN IF NOT EXISTS beta_token_hash TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_google_usage_log_beta_hash ON google_usage_log (beta_token_hash);`);

  // PITWALL Credits shadow ledger. Access codes are never persisted here;
  // beta testers are keyed only by the same SHA-256 hash used by session telemetry.
  // The append-only ledger makes grants/debits auditable and event_key prevents
  // retries from charging the same vendor call twice.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_accounts (
      id                  BIGSERIAL PRIMARY KEY,
      user_id             BIGINT REFERENCES users(id) ON DELETE CASCADE,
      beta_token_hash     TEXT,
      display_name        TEXT,
      mode                TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow','enforced','disabled')),
      memory_tier         TEXT NOT NULL DEFAULT 'session' CHECK (memory_tier IN ('session','rolling','full','team')),
      memory_active_until TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((user_id IS NOT NULL)::int + (beta_token_hash IS NOT NULL)::int = 1)
    );
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_accounts_user ON credit_accounts(user_id) WHERE user_id IS NOT NULL;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_accounts_beta ON credit_accounts(beta_token_hash) WHERE beta_token_hash IS NOT NULL;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id               BIGSERIAL PRIMARY KEY,
      account_id       BIGINT NOT NULL REFERENCES credit_accounts(id) ON DELETE CASCADE,
      event_key        TEXT NOT NULL UNIQUE,
      event_type       TEXT NOT NULL CHECK (event_type IN ('grant','debit','adjustment','expiry','upgrade','grace')),
      credits_delta    NUMERIC(14, 6) NOT NULL,
      vendor_cost_usd  NUMERIC(14, 8),
      vendor           TEXT,
      source           TEXT,
      session_id       TEXT,
      note             TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_ledger_account_created ON credit_ledger(account_id, created_at);`);

  // Cross-PC endurance handoff.  The shared team code is never stored in
  // plaintext; only its SHA-256 digest is the row key.  One latest,
  // evidence-only handoff is enough for the next driver's PITWALL to resume
  // a stint without treating unrelated local telemetry as team truth.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chief_team_handoffs (
      team_key_hash TEXT PRIMARY KEY,
      handoff_id TEXT NOT NULL,
      sender_identity TEXT NOT NULL,
      packet JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chief_team_handoffs_updated ON chief_team_handoffs (updated_at);`);

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

// ── Grow the Grid 自動化（2026-07-19） ──────────────────────────────────────
// 設計の要点（7/11の無制限クーポン事故の教訓を踏まえた安全設計）：
//   1. クーポンは「特定の1人のサブスクに・1回限り(duration:once)・サーバーが直接」当てる。共有可能なコードは作らない
//   2. 全ステップ冪等：帰属は初回のみ記録(referred_byがNULLの時だけ)・転換はPRIMARY KEYで1人1回・
//      クーポンIDは固定3種を使い回し(re-createしない)
//   3. 紹介処理の失敗でwebhook本体(会員化)を巻き込まない：呼び出し側でtry/catch necking

// 決済完了時：カスタムフィールドのREFコードを検証して帰属を記録する。
// rawCode例: "REF-K3M9P2" / "ref-k3m9p2" / "K3M9P2"（プレフィックス無し入力も救済）
async function recordReferralAttribution(rawEmail, rawCode) {
  if (!ready || !rawCode) return { ok: false, reason: 'no_code' };
  const email = normalizeEmail(rawEmail);
  let code = String(rawCode).trim().toUpperCase().replace(/\s+/g, '');
  if (!code) return { ok: false, reason: 'empty' };
  if (!code.startsWith('REF-') && /^[A-Z0-9]{6}$/.test(code)) code = 'REF-' + code;
  if (!/^REF-[A-Z0-9]{6}$/.test(code)) {
    log('referral attribution rejected (bad format): ' + email + ' -> ' + JSON.stringify(rawCode));
    return { ok: false, reason: 'bad_format' };
  }
  const ref = await pool.query('SELECT id, email FROM users WHERE referral_code = $1', [code]);
  if (!ref.rows[0]) {
    log('referral attribution rejected (unknown code): ' + email + ' -> ' + code);
    return { ok: false, reason: 'unknown_code' };
  }
  if (normalizeEmail(ref.rows[0].email) === email) {
    log('referral attribution rejected (self-referral): ' + email);
    return { ok: false, reason: 'self' };
  }
  // 初回のみ記録（webhook再送や2回目の決済で上書きしない）
  const upd = await pool.query(
    'UPDATE users SET referred_by = $1 WHERE email = $2 AND referred_by IS NULL RETURNING id',
    [code, email]
  );
  if (upd.rows[0]) log('referral attribution recorded: ' + email + ' <- ' + code);
  return { ok: !!upd.rows[0], reason: upd.rows[0] ? 'recorded' : 'already_set' };
}

// 固定クーポン3種（33/66/100・1回限り）。既存ならそのまま使う＝冪等。
const GROW_COUPONS = { 1: { id: 'GROW_THE_GRID_33', pct: 33 }, 2: { id: 'GROW_THE_GRID_66', pct: 66 }, 3: { id: 'GROW_THE_GRID_100', pct: 100 } };
async function ensureGrowCoupon(cyclePos) {
  const c = GROW_COUPONS[cyclePos];
  try {
    await stripe.coupons.retrieve(c.id);
  } catch (e) {
    if (e && e.code === 'resource_missing') {
      await stripe.coupons.create({ id: c.id, percent_off: c.pct, duration: 'once', name: `Grow the Grid ${c.pct}% off` });
      log('grow coupon created: ' + c.id);
    } else throw e;
  }
  return c;
}

// 友達の"初回実課金"時：転換を数え、紹介者の次回請求にクーポンを当て、通知メールを送る。
// stripeCustomerId = 課金した友達のStripe customer。戻り値は監査ログ用。
async function countReferralConversion(stripeCustomerId) {
  if (!ready || !stripe || !stripeCustomerId) return { ok: false, reason: 'not_ready' };
  const friend = await pool.query(
    'SELECT id, email, referred_by FROM users WHERE stripe_customer_id = $1', [stripeCustomerId]);
  if (!friend.rows[0] || !friend.rows[0].referred_by) return { ok: false, reason: 'no_attribution' };
  const code = friend.rows[0].referred_by;

  const referrer = await pool.query(
    'SELECT id, email, is_member, stripe_customer_id FROM users WHERE referral_code = $1', [code]);
  if (!referrer.rows[0]) return { ok: false, reason: 'referrer_gone' };

  // 冪等の要：この友達が既に数えられていたら何もしない（webhook再送・2ヶ月目以降の請求で二重加算しない）
  const ins = await pool.query(
    `INSERT INTO referral_conversions (referred_user_id, referrer_code, percent_awarded)
     VALUES ($1, $2, 0) ON CONFLICT (referred_user_id) DO NOTHING RETURNING referred_user_id`,
    [friend.rows[0].id, code]
  );
  if (!ins.rows[0]) return { ok: false, reason: 'already_counted' };

  const tot = await pool.query('SELECT COUNT(*)::int AS n FROM referral_conversions WHERE referrer_code = $1', [code]);
  const total = tot.rows[0].n;
  const cyclePos = ((total - 1) % 3) + 1;   // 1→33% / 2→66% / 3→100%、以降リセットして繰り返し
  const coupon = await ensureGrowCoupon(cyclePos);
  await pool.query('UPDATE referral_conversions SET percent_awarded = $1 WHERE referred_user_id = $2', [coupon.pct, friend.rows[0].id]);

  // 紹介者のアクティブなサブスクにクーポン適用。特典は「メンバーである限り」なので、
  // 解約済みならカウントだけ残して適用はスキップ（Terms/HPの文言と整合）。
  let applied = false;
  if (referrer.rows[0].is_member && referrer.rows[0].stripe_customer_id) {
    const subs = await stripe.subscriptions.list({ customer: referrer.rows[0].stripe_customer_id, status: 'active', limit: 3 });
    const sub = subs.data[0] || (await stripe.subscriptions.list({ customer: referrer.rows[0].stripe_customer_id, status: 'trialing', limit: 3 })).data[0];
    if (sub) {
      // 同一サイクル内で2人目が来たら33%→66%に"置き換え"る（積算でなく上位で上書き＝設計どおり）
      await stripe.subscriptions.update(sub.id, { coupon: coupon.id });
      applied = true;
      log(`grow the grid: ${code} conversion #${total} -> ${coupon.pct}% applied to ${referrer.rows[0].email}`);
    } else {
      log(`grow the grid: ${code} conversion #${total} counted, but no active subscription to discount`);
    }
  }

  // 通知メール（失敗しても処理全体は成功扱い）
  try {
    const pct = coupon.pct;
    await sendEmail({
      to: referrer.rows[0].email,
      bcc: ADMIN_NOTIFY_EMAIL || undefined,
      subject: `Grow the Grid — a driver you invited just joined! ${pct}% off your next month 🏁`,
      text:
        `A driver you brought to the grid just converted to a paid month.\n\n` +
        `Your reward: ${pct}% off your next month${applied ? ' — already applied, nothing to do.' : ' (will be applied to your next active billing).'}\n` +
        `Progress in this cycle: ${cyclePos}/3 drivers. Bring ${3 - (total % 3 === 0 ? 3 : total % 3) || 3} more for a free month — it resets every 3, forever.\n\n` +
        `あなたが招いたドライバーが実課金に転換しました。\n翌月${pct}%OFF${applied ? '（適用済み・手続き不要）' : '（次のアクティブな請求時に適用）'}。このサイクル: ${cyclePos}/3人。\n\n— OMORAY PITWALL`,
    });
  } catch (e) {
    log('grow the grid notify email failed: ' + (e && e.message || e));
  }

  return { ok: true, total, percent: coupon.pct, applied, referrer: referrer.rows[0].email };
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
     RETURNING exe_code, email`,
    [stripeCustomerId, status || 'canceled']
  );
  log('member unset (customer ' + stripeCustomerId + ')');
  const exeCode = rows[0] && rows[0].exe_code;
  if (exeCode) {
    await pool.query('UPDATE beta_tokens SET active = false WHERE code = $1', [exeCode]);
    log('exe code revoked on cancellation: ' + exeCode);
  }
  const email = rows[0] && rows[0].email;
  if (email) {
    const isTrial = (status === 'incomplete_expired');
    try {
      await sendEmail({
        to: email,
        subject: 'OMORAY PITWALL — Your subscription has ended',
        text: isTrial
          ? 'Hi,\n\nYour PITWALL free trial has ended. We hope you enjoyed having an engineer in your ear.\n\nIf you want to come back, Founding Season pricing is still available — your spot is open:\nhttps://omoraypitwall.com\n\nSee you on track.\n— Yuji, OMORAY PITWALL'
          : 'Hi,\n\nYour PITWALL subscription has been canceled and your access has been deactivated.\n\nIf you ever want to come back, we\'ll be here:\nhttps://omoraypitwall.com\n\nThank you for racing with us.\n— Yuji, OMORAY PITWALL',
        html: isTrial
          ? '<p>Hi,</p><p>Your PITWALL free trial has ended. We hope you enjoyed having an engineer in your ear.</p><p>If you want to come back, Founding Season pricing is still available — your spot is open:<br><a href="https://omoraypitwall.com">omoraypitwall.com</a></p><p>See you on track.<br>— Yuji, OMORAY PITWALL</p>'
          : '<p>Hi,</p><p>Your PITWALL subscription has been canceled and your access has been deactivated.</p><p>If you ever want to come back, we\'ll be here:<br><a href="https://omoraypitwall.com">omoraypitwall.com</a></p><p>Thank you for racing with us.<br>— Yuji, OMORAY PITWALL</p>',
      });
      log('cancellation email sent to ' + email + ' (status=' + status + ')');
    } catch (e) {
      log('cancellation email failed: ' + e.message);
    }
  }
}

// Founding Checkout Session作成（LP CTAから直接Stripe Checkoutへ。匿名IDをmetadataに載せてファネル接続）。
const STRIPE_FOUNDING_PRICE_ID = process.env.STRIPE_FOUNDING_PRICE_ID || null;
// customer: テスト専用。Test Clockに紐付けた顧客IDを渡すとトライアル進行を早送りできる。
//   本番の /api/founding/checkout ルートはこの引数を絶対にクライアント入力から渡さない
//   （渡してしまうと他人のStripe顧客IDへ本番決済をなりすませる脆弱性になる）。
async function createFoundingCheckout({ anon_id, lang, referral_code, customer } = {}) {
  if (!stripe) throw new Error('stripe_unavailable');
  if (!STRIPE_FOUNDING_PRICE_ID) throw new Error('price_not_configured');
  const params = {
    mode: 'subscription',
    line_items: [{ price: STRIPE_FOUNDING_PRICE_ID, quantity: 1 }],
    subscription_data: { trial_period_days: 5, metadata: { source: 'founding_lp', anon_id: anon_id || '' } },
    success_url: `${BASE_URL}/welcome.html?checkout=success`,
    cancel_url: `${BASE_URL}/pitwall.html#pricing`,
    metadata: { anon_id: anon_id || '', lang: lang || '' },
    custom_fields: [{
      key: 'referral_code', label: { type: 'custom', custom: 'Referral code (optional)' },
      type: 'text', optional: true,
    }],
  };
  if (customer) params.customer = customer;
  const session = await stripe.checkout.sessions.create(params);
  return { url: session.url, session_id: session.id };
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

  const isFiveDayTester = row.tier === 'trial_5day';
  let activatedAt = row.activated_at;
  let expiresAt = row.expires_at;
  if (isFiveDayTester && !activatedAt) {
    // First successful verification wins. The conditional UPDATE is atomic,
    // so concurrent first requests cannot move the five-day window.
    const activated = await pool.query(
      `UPDATE beta_tokens
          SET activated_at = now(), expires_at = now() + interval '5 days'
        WHERE code = $1 AND active = true AND activated_at IS NULL
        RETURNING activated_at, expires_at`, [code]
    );
    if (activated.rows[0]) {
      activatedAt = activated.rows[0].activated_at;
      expiresAt = activated.rows[0].expires_at;
    } else {
      const current = await pool.query(
        'SELECT active, activated_at, expires_at FROM beta_tokens WHERE code = $1', [code]);
      const currentRow = current.rows[0];
      if (!currentRow || !currentRow.active) return { ok: false, reason: 'revoked' };
      activatedAt = currentRow.activated_at;
      expiresAt = currentRow.expires_at;
    }
  }
  if (isFiveDayTester && (!expiresAt || new Date(expiresAt).getTime() <= Date.now())) {
    return { ok: false, reason: 'expired', activatedAt, expiresAt };
  }

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
  return { ok: true, name: row.name, tier: row.tier, activatedAt, expiresAt };
}

// ── ベータコード管理（Yuji専用・ADMIN_SECRETで保護） ──
function genBetaCode(name) {
  const tag = String(name || 'USER').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'USER';
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6桁
  return `PITWALL-${tag}-${rand}`;
}

async function createBetaToken({ name, tier = 'trial_5day', billingStart = null, note = null }) {
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
    `SELECT code, name, tier, active, billing_start, note, created_at, last_seen,
            activated_at, expires_at,
            CASE WHEN expires_at IS NULL THEN NULL
                 ELSE GREATEST(0, EXTRACT(EPOCH FROM (expires_at - now()))) END AS seconds_remaining
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

// Test/support control: expire a five-day code immediately without changing
// the global five-day policy or waiting for wall-clock time to pass.
async function expireBetaToken(rawCode) {
  if (!ready) throw new Error('unavailable');
  const code = normalizeCode(rawCode);
  const { rowCount } = await pool.query(
    `UPDATE beta_tokens SET expires_at = now() - interval '1 second'
      WHERE code = $1 AND tier = 'trial_5day'`, [code]
  );
  return { ok: rowCount > 0 };
}

// ── 過去ログ記憶の一回限りインポート ─────────────────────────────────────
// 管理側は名前だけ指定する。アクセスコード／ハッシュはレスポンス・ログへ返さない。
function sanitizeMemoryImportRecords(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 16) {
    throw new Error('records must contain 1-16 entries');
  }
  return input.map((item) => {
    const scope = item && typeof item.scope === 'object' ? item.scope : {};
    const qa = Array.isArray(item && item.qa) ? item.qa.slice(0, 6) : [];
    const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
    const cleanQa = qa.map((pair) => ({
      question: text(pair && pair.question, 240),
      answer: text(pair && pair.answer, 700),
    })).filter((pair) => pair.question || pair.answer);
    if (!cleanQa.length) throw new Error('each record needs a question or answer');
    return {
      kind: item && item.kind === 'driver_preference' ? 'driver_preference' : 'session_evidence',
      scope: {
        session_type: text(scope.session_type, 80),
        track: text(scope.track, 120),
        car: text(scope.car, 160),
        car_class: text(scope.car_class, 80),
      },
      qa: cleanQa,
      source_date: text(item && item.source_date, 32),
      note: text(item && item.note, 360),
    };
  });
}

async function queueMemoryImportSeed({ targetName, sourceLabel, records }) {
  if (!ready) throw new Error('unavailable');
  const name = String(targetName || '').trim().slice(0, 80);
  const label = String(sourceLabel || '').trim().slice(0, 120);
  if (!name || !label) throw new Error('targetName and sourceLabel are required');
  const cleanRecords = sanitizeMemoryImportRecords(records);
  const { rows } = await pool.query(
    `SELECT code, name FROM beta_tokens WHERE lower(name) = lower($1) ORDER BY created_at DESC LIMIT 2`, [name]
  );
  if (rows.length !== 1) throw new Error(rows.length ? 'ambiguous_tester_name' : 'tester_not_found');
  const tokenHash = crypto.createHash('sha256').update(rows[0].code).digest('hex');
  const result = await pool.query(
    `INSERT INTO memory_import_seeds (beta_token_hash, target_name, source_label, records)
     VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (beta_token_hash, source_label)
     DO UPDATE SET records = EXCLUDED.records, target_name = EXCLUDED.target_name,
                   created_at = now(), acknowledged_at = NULL
     RETURNING id`,
    [tokenHash, rows[0].name, label, JSON.stringify(cleanRecords)]
  );
  return { ok: true, targetName: rows[0].name, sourceLabel: label, count: cleanRecords.length, seedId: result.rows[0].id };
}

async function getPendingMemoryImportSeeds(betaTokenHash) {
  if (!ready) throw new Error('unavailable');
  if (!/^[a-f0-9]{64}$/.test(String(betaTokenHash || ''))) throw new Error('invalid_token_hash');
  const { rows } = await pool.query(
    `SELECT id, source_label, records, created_at
       FROM memory_import_seeds
      WHERE beta_token_hash = $1 AND acknowledged_at IS NULL
      ORDER BY created_at ASC`, [betaTokenHash]
  );
  return rows.map((row) => ({ id: String(row.id), sourceLabel: row.source_label, records: row.records, createdAt: row.created_at }));
}

async function acknowledgeMemoryImportSeeds(betaTokenHash, seedIds) {
  if (!ready) throw new Error('unavailable');
  if (!/^[a-f0-9]{64}$/.test(String(betaTokenHash || ''))) throw new Error('invalid_token_hash');
  const ids = Array.from(new Set((Array.isArray(seedIds) ? seedIds : [])
    .map((id) => String(id)).filter((id) => /^\d{1,18}$/.test(id)))).slice(0, 32);
  if (!ids.length) return { ok: true, acknowledged: 0 };
  const { rowCount } = await pool.query(
    `UPDATE memory_import_seeds SET acknowledged_at = now()
      WHERE beta_token_hash = $1 AND id = ANY($2::bigint[]) AND acknowledged_at IS NULL`,
    [betaTokenHash, ids]
  );
  return { ok: true, acknowledged: rowCount };
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

// ── Founding応募 ──
async function createFoundingApplication(data) {
  if (!ready) throw new Error('unavailable');
  const { rows } = await pool.query(
    `INSERT INTO founding_applications (program, email, discord, series, discipline, language, expectations, referral_source, page_lang)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
    [data.program || 'general', data.email, data.discord, data.series, data.discipline, data.language, data.expectations, data.referral_source, data.page_lang]
  );
  return rows[0];
}

async function listFoundingApplications() {
  if (!ready) return [];
  const { rows } = await pool.query('SELECT * FROM founding_applications ORDER BY created_at DESC');
  return rows;
}

// ── ファネルイベント ──
async function recordFunnelEvent(data) {
  if (!ready) return null;
  const key = data.idempotency_key || null;
  if (key) {
    const dup = await pool.query('SELECT id FROM funnel_events WHERE idempotency_key = $1', [key]);
    if (dup.rows.length) return { id: dup.rows[0].id, deduplicated: true };
  }
  const extra = data.extra ? JSON.stringify(data.extra) : null;
  const { rows } = await pool.query(
    `INSERT INTO funnel_events (event, idempotency_key, anon_id, lang, utm_source, utm_medium, utm_campaign, referrer, extra, is_test)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [data.event, key, data.anon_id || null, data.lang || null,
     data.utm_source || null, data.utm_medium || null, data.utm_campaign || null,
     data.referrer || null, extra, !!data.is_test]
  );
  return { id: rows[0].id, deduplicated: false };
}

async function getFunnelStats() {
  if (!ready) return [];
  const { rows } = await pool.query(
    `SELECT event, date_trunc('day', created_at)::date AS day, COUNT(*)::int AS count
     FROM funnel_events WHERE is_test = false
     GROUP BY event, day ORDER BY day DESC, event`
  );
  return rows;
}

// ── APIコストログ ──
// per-1M-token USD rates. Haiku 4.5 / Sonnet 4.5 のみ対応（PITWALLが実際に使うモデル）。
const MODEL_RATES_PER_MTOK = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00, cacheWrite: 1.25, cacheRead: 0.10 },
  'claude-sonnet-4-5': { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
};

// 未知モデル（レート表未登録）はコストを黙って0にしない＝過少計上の温床になる。
// NULLで保存し、statsのunknown_rate_callsで検知できるようにする（P1-2）。
function estimateApiCostUsd(model, { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens }) {
  const rates = MODEL_RATES_PER_MTOK[model];
  if (!rates) {
    console.error(`[USAGE] unknown model "${model}" — rate table not updated, cost NOT estimated (row still saved)`);
    return null;
  }
  const cost =
    (input_tokens || 0) * rates.input +
    (output_tokens || 0) * rates.output +
    (cache_read_tokens || 0) * rates.cacheRead +
    (cache_write_tokens || 0) * rates.cacheWrite;
  return cost / 1_000_000;
}

// environment !== 'production' は自動でis_test扱い（本番以外の実験を顧客集計に混ぜない）。
// 本番上でのYujiの明示的コスト試験は、後からsession_id単位でis_test=trueへ変更する運用。
async function recordApiUsage({ userId, betaTokenHash, sessionId, character, mode, source, trigger, usageContext, model, usage, environment }) {
  if (!ready || !usage) return null;
  const input_tokens = usage.input_tokens || 0;
  const output_tokens = usage.output_tokens || 0;
  const cache_read_tokens = usage.cache_read_input_tokens || 0;
  const cache_write_tokens = usage.cache_creation_input_tokens || 0;
  const estimated_cost_usd = estimateApiCostUsd(model, { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens });
  const is_test = (environment || 'production') !== 'production';
  const { rows } = await pool.query(
    `INSERT INTO api_usage_log (user_id, session_id, character, mode, source, "trigger", usage_context, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, environment, is_test, beta_token_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [userId || null, sessionId || null, character || null, mode || null, source || 'other', trigger || null,
     usageContext || 'unknown', model,
     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
     estimated_cost_usd, environment || null, is_test, betaTokenHash || null]
  );
  const id = rows[0].id;
  await recordAnthropicCreditDebit({ userId, betaTokenHash, usageLogId: id, estimatedCostUsd: estimated_cost_usd, source, sessionId });
  return { id, estimatedCostUsd: estimated_cost_usd };
}

const PITWALL_CREDITS_PER_USD = 10;
const GOOGLE_STT_USD_PER_SECOND = 0.024 / 60; // conservative post-free-tier V1 price
const GOOGLE_TTS_USD_PER_CHAR = 16 / 1_000_000; // Neural2 post-free-tier list price

function normalizeCreditIdentity({ userId, betaTokenHash } = {}) {
  if (userId) return { column: 'user_id', value: userId };
  if (typeof betaTokenHash === 'string' && /^[a-f0-9]{64}$/.test(betaTokenHash)) {
    return { column: 'beta_token_hash', value: betaTokenHash };
  }
  return null;
}

async function enrollShadowCreditAccount({ userId, betaTokenHash, displayName, memoryTier = 'session' }) {
  if (!ready) return null;
  const identity = normalizeCreditIdentity({ userId, betaTokenHash });
  if (!identity) throw new Error('invalid_credit_identity');
  const safeMemoryTier = ['session','rolling','full','team'].includes(memoryTier) ? memoryTier : 'session';
  const userValue = identity.column === 'user_id' ? identity.value : null;
  const betaValue = identity.column === 'beta_token_hash' ? identity.value : null;
  const { rows } = await pool.query(
    `INSERT INTO credit_accounts (user_id,beta_token_hash,display_name,mode,memory_tier)
     VALUES ($1,$2,$3,'shadow',$4)
     ON CONFLICT (${identity.column}) WHERE ${identity.column} IS NOT NULL DO UPDATE SET
       display_name=COALESCE(EXCLUDED.display_name,credit_accounts.display_name),
       mode='shadow',memory_tier=EXCLUDED.memory_tier,updated_at=now()
     RETURNING id,mode,memory_tier`,
    [userValue,betaValue,String(displayName || '').slice(0,80) || null,safeMemoryTier]
  );
  return rows[0] || null;
}

async function recordCreditLedgerEvent({ userId, betaTokenHash, eventKey, eventType = 'debit', creditsDelta, vendorCostUsd, vendor, source, sessionId, note }) {
  if (!ready) return null;
  const identity = normalizeCreditIdentity({ userId, betaTokenHash });
  if (!identity || typeof eventKey !== 'string' || !eventKey || !Number.isFinite(Number(creditsDelta))) return null;
  const { rows } = await pool.query(
    `INSERT INTO credit_ledger (account_id,event_key,event_type,credits_delta,vendor_cost_usd,vendor,source,session_id,note)
     SELECT id,$2,$3,$4,$5,$6,$7,$8,$9 FROM credit_accounts
      WHERE ${identity.column}=$1 AND mode IN ('shadow','enforced')
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [identity.value,eventKey,eventType,Number(creditsDelta),vendorCostUsd == null ? null : Number(vendorCostUsd),
     vendor || null,source || null,sessionId || null,note || null]
  );
  return rows[0] || null;
}

async function recordAnthropicCreditDebit({ userId, betaTokenHash, usageLogId, estimatedCostUsd, source, sessionId }) {
  if (!usageLogId || estimatedCostUsd == null) return null;
  const cost = Number(estimatedCostUsd);
  return recordCreditLedgerEvent({
    userId,betaTokenHash,eventKey:`anthropic:${usageLogId}`,eventType:'debit',
    creditsDelta:-(cost * PITWALL_CREDITS_PER_USD),vendorCostUsd:cost,
    vendor:'anthropic',source,sessionId,
  });
}

async function recordGoogleCreditDebit({ userId, betaTokenHash, usageLogId, kind, charCount, audioSeconds, success, sessionId }) {
  if (!usageLogId || !success) return null;
  let cost = null;
  if (kind === 'tts' && Number.isFinite(Number(charCount))) cost = Number(charCount) * GOOGLE_TTS_USD_PER_CHAR;
  if (kind === 'stt' && Number.isFinite(Number(audioSeconds))) cost = Number(audioSeconds) * GOOGLE_STT_USD_PER_SECOND;
  if (cost == null) return null;
  return recordCreditLedgerEvent({
    userId,betaTokenHash,eventKey:`google:${usageLogId}`,eventType:'debit',
    creditsDelta:-(cost * PITWALL_CREDITS_PER_USD),vendorCostUsd:cost,
    vendor:`google_${kind}`,source:kind,sessionId,
  });
}

async function getCreditAccountStats() {
  if (!ready) return [];
  await reconcileCreditLedger();
  const { rows } = await pool.query(
    `SELECT a.id,a.display_name,a.mode,a.memory_tier,a.memory_active_until,
            COALESCE(SUM(l.credits_delta),0)::numeric AS balance,
            COALESCE(-SUM(l.credits_delta) FILTER (WHERE l.event_type='debit'),0)::numeric AS consumed_credits,
            COALESCE(SUM(l.vendor_cost_usd) FILTER (WHERE l.event_type='debit'),0)::numeric AS vendor_cost_usd,
            COUNT(l.id) FILTER (WHERE l.event_type='debit')::int AS debit_events,
            MIN(l.created_at) FILTER (WHERE l.event_type='debit') AS first_usage_at,
            MAX(l.created_at) FILTER (WHERE l.event_type='debit') AS last_usage_at
       FROM credit_accounts a LEFT JOIN credit_ledger l ON l.account_id=a.id
      GROUP BY a.id ORDER BY consumed_credits DESC`);
  return rows;
}

async function reconcileCreditLedger() {
  if (!ready) return null;
  const anthropic = await pool.query(
    `INSERT INTO credit_ledger (account_id,event_key,event_type,credits_delta,vendor_cost_usd,vendor,source,session_id,note)
     SELECT a.id,'anthropic:'||u.id,'debit',-(u.estimated_cost_usd*($1::numeric)),u.estimated_cost_usd,
            'anthropic',u.source,u.session_id,'reconciled from api_usage_log'
       FROM api_usage_log u JOIN credit_accounts a
         ON ((u.user_id IS NOT NULL AND a.user_id=u.user_id)
          OR (u.beta_token_hash IS NOT NULL AND a.beta_token_hash=u.beta_token_hash))
      WHERE u.estimated_cost_usd IS NOT NULL AND a.mode IN ('shadow','enforced')
     ON CONFLICT (event_key) DO NOTHING RETURNING id`, [PITWALL_CREDITS_PER_USD]);
  const google = await pool.query(
    `INSERT INTO credit_ledger (account_id,event_key,event_type,credits_delta,vendor_cost_usd,vendor,source,session_id,note)
     SELECT a.id,'google:'||g.id,'debit',
            -(CASE WHEN g.kind='tts' THEN COALESCE(g.char_count,0)*($1::numeric)
                   WHEN g.kind='stt' THEN COALESCE(g.audio_seconds,0)*($2::numeric) ELSE 0 END)*($3::numeric),
            CASE WHEN g.kind='tts' THEN COALESCE(g.char_count,0)*($1::numeric)
                 WHEN g.kind='stt' THEN COALESCE(g.audio_seconds,0)*($2::numeric) ELSE 0 END,
            'google_'||g.kind,g.kind,g.session_id,'reconciled from google_usage_log'
       FROM google_usage_log g JOIN credit_accounts a
         ON ((g.user_id IS NOT NULL AND a.user_id=g.user_id)
          OR (g.beta_token_hash IS NOT NULL AND a.beta_token_hash=g.beta_token_hash))
      WHERE g.success=true AND g.kind IN ('tts','stt') AND a.mode IN ('shadow','enforced')
        AND ((g.kind='tts' AND g.char_count IS NOT NULL) OR (g.kind='stt' AND g.audio_seconds IS NOT NULL))
     ON CONFLICT (event_key) DO NOTHING RETURNING id`,
    [GOOGLE_TTS_USD_PER_CHAR,GOOGLE_STT_USD_PER_SECOND,PITWALL_CREDITS_PER_USD]);
  return { anthropic: anthropic.rows.length, google: google.rows.length };
}

async function recordUsageSessionCheckpoint(data) {
  if (!ready) return null;
  const { rows } = await pool.query(
    `INSERT INTO usage_session_checkpoints (
       session_id,user_id,beta_token_hash,tester_name,device_id_hash,build,sequence,
       started_at,ended_at,total_seconds,iracing_seconds,ptt_calls,typed_calls,
       auto_judge_calls,auto_pace_calls,briefing_calls,insight_calls,
       debrief_offered,debrief_started,debrief_completed,debrief_dismissed,
       practice_review_eligible,practice_review_offered,practice_review_started,
       practice_review_completed,practice_review_saved,practice_review_manual,
       feedback_prompted,feedback_answered,
       normal_exit,last_reason
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
     ON CONFLICT (session_id) DO UPDATE SET
       user_id=COALESCE(EXCLUDED.user_id,usage_session_checkpoints.user_id),
       beta_token_hash=COALESCE(EXCLUDED.beta_token_hash,usage_session_checkpoints.beta_token_hash),
       tester_name=COALESCE(EXCLUDED.tester_name,usage_session_checkpoints.tester_name),
       device_id_hash=COALESCE(EXCLUDED.device_id_hash,usage_session_checkpoints.device_id_hash),
       build=EXCLUDED.build,sequence=EXCLUDED.sequence,started_at=EXCLUDED.started_at,
       ended_at=EXCLUDED.ended_at,total_seconds=EXCLUDED.total_seconds,
       iracing_seconds=EXCLUDED.iracing_seconds,ptt_calls=EXCLUDED.ptt_calls,
       typed_calls=EXCLUDED.typed_calls,auto_judge_calls=EXCLUDED.auto_judge_calls,
       auto_pace_calls=EXCLUDED.auto_pace_calls,briefing_calls=EXCLUDED.briefing_calls,
       insight_calls=EXCLUDED.insight_calls,debrief_offered=EXCLUDED.debrief_offered,
       debrief_started=EXCLUDED.debrief_started,debrief_completed=EXCLUDED.debrief_completed,
       debrief_dismissed=EXCLUDED.debrief_dismissed,
       practice_review_eligible=EXCLUDED.practice_review_eligible,
       practice_review_offered=EXCLUDED.practice_review_offered,
       practice_review_started=EXCLUDED.practice_review_started,
       practice_review_completed=EXCLUDED.practice_review_completed,
       practice_review_saved=EXCLUDED.practice_review_saved,
       practice_review_manual=EXCLUDED.practice_review_manual,
       feedback_prompted=EXCLUDED.feedback_prompted,
       feedback_answered=EXCLUDED.feedback_answered,normal_exit=EXCLUDED.normal_exit,
       last_reason=EXCLUDED.last_reason,updated_at=now()
     WHERE EXCLUDED.sequence >= usage_session_checkpoints.sequence
     RETURNING session_id,sequence`,
    [data.sessionId, data.userId || null, data.betaTokenHash || null, data.testerName || null,
     data.deviceIdHash || null, data.build || null, data.sequence, data.startedAt || null,
     data.endedAt || null, data.totalSeconds, data.iracingSeconds, data.pttCalls, data.typedCalls,
     data.autoJudgeCalls, data.autoPaceCalls, data.briefingCalls, data.insightCalls,
     data.debriefOffered, data.debriefStarted, data.debriefCompleted, data.debriefDismissed,
     data.practiceReviewEligible, data.practiceReviewOffered, data.practiceReviewStarted,
     data.practiceReviewCompleted, data.practiceReviewSaved, data.practiceReviewManual,
     data.feedbackPrompted, data.feedbackAnswered,
     !!data.normalExit, data.lastReason || null]
  );
  return rows[0] || { session_id: data.sessionId, sequence: data.sequence };
}

async function recordGoogleUsage({ userId, betaTokenHash, sessionId, kind, charCount, audioBytes, audioSeconds, voice, language, success, environment }) {
  if (!ready) return null;
  const is_test = (environment || 'production') !== 'production';
  const { rows } = await pool.query(
    `INSERT INTO google_usage_log (user_id, session_id, kind, char_count, audio_bytes, audio_seconds, voice, language, success, environment, is_test, beta_token_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [userId || null, sessionId || null, kind, charCount ?? null, audioBytes ?? null, audioSeconds ?? null,
     voice || null, language || null, !!success, environment || null, is_test, betaTokenHash || null]
  );
  const id = rows[0].id;
  await recordGoogleCreditDebit({ userId, betaTokenHash, usageLogId: id, kind, charCount, audioSeconds, success, sessionId });
  return { id };
}

// 既存の日別集計は後方互換のため残し、任意フィルタ＋source/trigger/session別の内訳を追加。
async function getApiUsageStats({ from, to, userId, sessionId, source } = {}) {
  if (!ready) return { byDay: [], bySource: [], byTrigger: [], byContext: [], bySession: [], unknownRateCalls: 0 };
  const where = ['is_test = false'];
  const params = [];
  if (from) { params.push(from); where.push(`created_at >= $${params.length}`); }
  if (to) { params.push(to); where.push(`created_at < $${params.length}`); }
  if (userId) { params.push(userId); where.push(`user_id = $${params.length}`); }
  if (sessionId) { params.push(sessionId); where.push(`session_id = $${params.length}`); }
  if (source) { params.push(source); where.push(`source = $${params.length}`); }
  const whereSql = where.join(' AND ');

  const [byDay, bySource, byTrigger, byContext, bySession, unknownRate] = await Promise.all([
    pool.query(
      `SELECT date_trunc('day', created_at)::date AS day, model, mode,
              COUNT(*)::int AS calls,
              SUM(input_tokens)::bigint AS input_tokens,
              SUM(output_tokens)::bigint AS output_tokens,
              SUM(cache_read_tokens)::bigint AS cache_read_tokens,
              SUM(cache_write_tokens)::bigint AS cache_write_tokens,
              ROUND(SUM(estimated_cost_usd)::numeric, 4) AS estimated_cost_usd
       FROM api_usage_log WHERE ${whereSql}
       GROUP BY day, model, mode ORDER BY day DESC, model, mode`, params),
    pool.query(
      `SELECT source, COUNT(*)::int AS calls, ROUND(SUM(estimated_cost_usd)::numeric, 4) AS estimated_cost_usd
       FROM api_usage_log WHERE ${whereSql} GROUP BY source ORDER BY calls DESC`, params),
    pool.query(
      `SELECT source, "trigger", COUNT(*)::int AS calls, ROUND(SUM(estimated_cost_usd)::numeric, 4) AS estimated_cost_usd
       FROM api_usage_log WHERE ${whereSql} AND "trigger" IS NOT NULL GROUP BY source, "trigger" ORDER BY calls DESC`, params),
    pool.query(
      `SELECT usage_context, COUNT(*)::int AS calls, ROUND(SUM(estimated_cost_usd)::numeric, 4) AS estimated_cost_usd
       FROM api_usage_log WHERE ${whereSql} GROUP BY usage_context ORDER BY calls DESC`, params),
    pool.query(
      `SELECT session_id, COUNT(*)::int AS calls, ROUND(SUM(estimated_cost_usd)::numeric, 4) AS estimated_cost_usd
       FROM api_usage_log WHERE ${whereSql} AND session_id IS NOT NULL GROUP BY session_id ORDER BY estimated_cost_usd DESC NULLS LAST LIMIT 200`, params),
    pool.query(
      `SELECT COUNT(*)::int AS unknown_rate_calls FROM api_usage_log WHERE ${whereSql} AND estimated_cost_usd IS NULL`, params),
  ]);
  return {
    byDay: byDay.rows, bySource: bySource.rows, byTrigger: byTrigger.rows,
    byContext: byContext.rows, bySession: bySession.rows,
    unknownRateCalls: unknownRate.rows[0] ? unknownRate.rows[0].unknown_rate_calls : 0,
  };
}

async function getUsageSessionStats({ from, to } = {}) {
  if (!ready) return [];
  const params = [];
  const where = ['1=1'];
  if (from) { params.push(from); where.push(`c.started_at >= $${params.length}`); }
  if (to) { params.push(to); where.push(`c.started_at < $${params.length}`); }
  const { rows } = await pool.query(
    `WITH api AS (
       SELECT session_id,COUNT(*)::int api_calls,
              ROUND(SUM(estimated_cost_usd)::numeric,4) anthropic_cost_usd
       FROM api_usage_log WHERE is_test=false GROUP BY session_id
     ), google AS (
       SELECT session_id,
              COUNT(*) FILTER (WHERE kind='tts')::int tts_calls,
              COUNT(*) FILTER (WHERE kind='stt')::int stt_calls,
              COALESCE(SUM(char_count) FILTER (WHERE kind='tts'),0)::bigint tts_chars,
              COALESCE(SUM(audio_seconds) FILTER (WHERE kind='stt'),0)::numeric stt_seconds
       FROM google_usage_log WHERE is_test=false GROUP BY session_id
     )
     SELECT c.session_id,c.user_id,c.tester_name,c.build,c.started_at,c.ended_at,
            c.total_seconds,c.iracing_seconds,c.ptt_calls,c.typed_calls,
            c.auto_judge_calls,c.auto_pace_calls,c.briefing_calls,c.insight_calls,
            c.debrief_offered,c.debrief_started,c.debrief_completed,c.debrief_dismissed,
            c.practice_review_eligible,c.practice_review_offered,c.practice_review_started,
            c.practice_review_completed,c.practice_review_saved,c.practice_review_manual,
            c.feedback_prompted,c.feedback_answered,
            c.normal_exit,c.last_reason,
            COALESCE(api.api_calls,0) api_calls,api.anthropic_cost_usd,
            COALESCE(google.tts_calls,0) tts_calls,COALESCE(google.stt_calls,0) stt_calls,
            COALESCE(google.tts_chars,0) tts_chars,COALESCE(google.stt_seconds,0) stt_seconds
     FROM usage_session_checkpoints c
     LEFT JOIN api USING(session_id) LEFT JOIN google USING(session_id)
     WHERE ${where.join(' AND ')}
     ORDER BY c.started_at DESC LIMIT 500`, params);
  return rows;
}

// CTA位置別の内訳（Hero/Manifesto/Pricingのどこが起点になったか）。既存 getFunnelStats() の形は変えず、別関数として追加。
async function getFunnelStatsByCtaLocation() {
  if (!ready) return [];
  // イベント名・cta_location値ともホワイトリストで防御。APIの入力検証が効く前に混入した不正値を集計から除外する。
  const { rows } = await pool.query(
    `SELECT event, extra->>'cta_location' AS cta_location, date_trunc('day', created_at)::date AS day, COUNT(*)::int AS count
     FROM funnel_events
     WHERE is_test = false
       AND event IN ('primary_cta_click', 'checkout_started')
       AND extra->>'cta_location' IN ('hero', 'manifesto', 'pricing')
     GROUP BY event, cta_location, day ORDER BY day DESC, event, cta_location`
  );
  return rows;
}

// ── Cross-PC Chief Engineer handoff ────────────────────────────────────────
// A Team Link Code is a shared secret entered locally by the drivers.  It is
// deliberately separate from a personal EXE access code and is stored only as
// a digest.  The server accepts only a compact, deterministic handoff packet;
// it is not a general team chat or telemetry archive.
const CHIEF_HANDOFF_TTL_MS = 6 * 60 * 60 * 1000;

function chiefTeamKey(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{7,63}$/.test(code)) return null;
  return crypto.createHash('sha256').update('pitwall-chief-team:v1:' + code).digest('hex');
}

function cleanChiefPacket(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const str = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : null;
  const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const int = value => Number.isInteger(value) && value >= 0 && value <= 100000 ? value : null;
  const roster = Array.isArray(raw.roster)
    ? raw.roster.map(v => str(v, 30)).filter(Boolean).slice(0, 3) : [];
  const selectedPlan = str(raw.selected_plan, 12);
  if (!roster.length || !selectedPlan || !['A', 'B', 'C'].includes(selectedPlan.toUpperCase())) return null;
  const nextIndex = int(raw.next_driver_index);
  if (nextIndex === null || nextIndex >= roster.length) return null;
  const handoffId = str(raw.handoff_id, 80);
  if (!handoffId || !/^[A-Za-z0-9_-]{8,80}$/.test(handoffId)) return null;
  const rawTire = raw.tire_report && typeof raw.tire_report === 'object' && !Array.isArray(raw.tire_report)
    ? raw.tire_report : null;
  const tireSummary = rawTire && str(rawTire.summary, 180);
  const tireMeasuredAt = rawTire && finite(rawTire.measured_at_session_s);
  const rawSplash = raw.endurance_splash && typeof raw.endurance_splash === 'object' && !Array.isArray(raw.endurance_splash)
    ? raw.endurance_splash : null;
  const splashStops = rawSplash && int(rawSplash.future_stop_count);
  const splashLitres = rawSplash && finite(rawSplash.projected_final_service_l);
  const splashWindow = rawSplash && int(rawSplash.final_stint_window_in_laps);
  const enduranceSplash = (rawSplash && splashStops !== null && splashLitres !== null && splashWindow !== null
    && splashLitres >= 0 && splashLitres <= 200)
    ? {
      future_stop_count: splashStops,
      projected_final_service_l: splashLitres,
      final_stint_window_in_laps: splashWindow,
      final_stint_window_open: rawSplash.final_stint_window_open === true,
      traffic_rejoin_check_required: rawSplash.traffic_rejoin_check_required === true,
    } : null;
  return {
    handoff_id: handoffId,
    roster,
    selected_plan: selectedPlan.toUpperCase(),
    current_lap: int(raw.current_lap),
    class_position: int(raw.class_position),
    next_pit_lap: int(raw.next_pit_lap),
    fuel_set_l: finite(raw.fuel_set_l),
    finish_margin_l: finite(raw.finish_margin_l),
    gap_ahead_s: finite(raw.gap_ahead_s),
    strategy_reason: str(raw.strategy_reason, 180),
    damage_observed: raw.damage_observed === true,
    damage_seconds: finite(raw.damage_seconds),
    tire_report: tireSummary ? {
      summary: tireSummary,
      measured_at_session_s: tireMeasuredAt,
    } : null,
    endurance_splash: enduranceSplash,
    current_driver: str(raw.current_driver, 30),
    next_driver: roster[nextIndex],
    next_driver_index: nextIndex,
  };
}

async function publishChiefTeamHandoff({ teamCode, senderIdentity, packet } = {}) {
  if (!ready) throw new Error('auth_not_ready');
  const teamHash = chiefTeamKey(teamCode);
  const clean = cleanChiefPacket(packet);
  const sender = String(senderIdentity || '').slice(0, 160);
  if (!teamHash || !clean || !sender) throw new Error('invalid_chief_handoff');
  await pool.query(
    `INSERT INTO chief_team_handoffs (team_key_hash,handoff_id,sender_identity,packet,created_at,updated_at)
     VALUES ($1,$2,$3,$4,now(),now())
     ON CONFLICT (team_key_hash) DO UPDATE SET
       handoff_id=EXCLUDED.handoff_id, sender_identity=EXCLUDED.sender_identity,
       packet=EXCLUDED.packet, updated_at=now()`,
    [teamHash, clean.handoff_id, sender, JSON.stringify(clean)]
  );
  return { ok: true, handoffId: clean.handoff_id };
}

async function getChiefTeamHandoff({ teamCode } = {}) {
  if (!ready) throw new Error('auth_not_ready');
  const teamHash = chiefTeamKey(teamCode);
  if (!teamHash) throw new Error('invalid_chief_team');
  const { rows } = await pool.query(
    `SELECT handoff_id,packet,updated_at FROM chief_team_handoffs WHERE team_key_hash=$1`, [teamHash]
  );
  const row = rows[0];
  if (!row) return { ok: true, handoff: null };
  const updatedAt = new Date(row.updated_at).getTime();
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > CHIEF_HANDOFF_TTL_MS) {
    return { ok: true, handoff: null, stale: true };
  }
  const packet = cleanChiefPacket(row.packet);
  if (!packet || packet.handoff_id !== row.handoff_id) return { ok: true, handoff: null };
  return { ok: true, handoff: { id: row.handoff_id, packet, updatedAt: row.updated_at } };
}

module.exports = {
  init, isConfigured, isReady: () => ready,
  requestMagicLink, verifyMagicToken, getUserFromToken,
  publicUser, attachUser, updateProfile,
  setMemberByEmail, sendWelcomeEmail, setMemberActive, unsetMemberByCustomer, foundingStatus,
  recordReferralAttribution, countReferralConversion,
  createFoundingCheckout,
  createBillingPortalSession,
  verifyBetaToken, createBetaToken, listBetaTokens, setBetaActive, expireBetaToken,
  queueMemoryImportSeed, getPendingMemoryImportSeeds, acknowledgeMemoryImportSeeds,
  createFoundingApplication, listFoundingApplications,
  recordFunnelEvent, getFunnelStats, getFunnelStatsByCtaLocation,
  recordApiUsage, getApiUsageStats, recordGoogleUsage, recordUsageSessionCheckpoint, getUsageSessionStats,
  enrollShadowCreditAccount, recordCreditLedgerEvent, recordAnthropicCreditDebit, recordGoogleCreditDebit, reconcileCreditLedger, getCreditAccountStats,
  publishChiefTeamHandoff, getChiefTeamHandoff,
  FOUNDING_CAP,
  _pool: () => pool,
};
