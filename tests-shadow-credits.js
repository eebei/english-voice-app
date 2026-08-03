'use strict';
// Shadow PITWALL Credits: enrollment, vendor-cost conversion and idempotent ledger events.
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, condition) {
  condition ? pass++ : fail++;
  console.log((condition ? '  ✅ ' : '  ❌ ') + name);
}

const ledger = [];
const eventKeys = new Set();
let nextId = 1;
const stubPool = {
  async query(sql, params = []) {
    const s = String(sql);
    if (/^\s*(CREATE|ALTER)/i.test(s)) return { rows: [] };
    if (/INSERT INTO credit_accounts/i.test(s)) return { rows: [{ id: 7, mode: 'shadow', memory_tier: params[3] }] };
    if (/INSERT INTO credit_ledger/i.test(s)) {
      const eventKey = params[1];
      if (eventKeys.has(eventKey)) return { rows: [] };
      eventKeys.add(eventKey);
      ledger.push({ eventKey, eventType: params[2], delta: Number(params[3]), cost: params[4], vendor: params[5] });
      return { rows: [{ id: nextId++ }] };
    }
    if (/INSERT INTO api_usage_log/i.test(s)) return { rows: [{ id: 101 }] };
    if (/INSERT INTO google_usage_log/i.test(s)) return { rows: [{ id: nextId++ + 200 }] };
    if (/^\s*SELECT/i.test(s)) return { rows: [] };
    if (/^\s*UPDATE/i.test(s)) return { rows: [] };
    return { rows: [] };
  },
};

const pgResolved = require.resolve('pg');
require('pg');
require.cache[pgResolved].exports = { Pool: function Pool() { return stubPool; } };
process.env.DATABASE_URL = 'postgres://stub/stub';
process.env.JWT_SECRET = 'shadow-test-secret';
delete process.env.BREVO_API_KEY;
delete process.env.GMAIL_USER;

const auth = require('./auth');

(async () => {
  check('auth初期化', await auth.init() === true);
  const betaHash = 'a'.repeat(64);
  const account = await auth.enrollShadowCreditAccount({ betaTokenHash: betaHash, displayName: 'Tester', memoryTier: 'session' });
  check('Shadowアカウントを作成', account && account.mode === 'shadow');

  await auth.recordCreditLedgerEvent({ betaTokenHash: betaHash, eventKey: 'grant:test', eventType: 'grant', creditsDelta: 30 });
  await auth.recordCreditLedgerEvent({ betaTokenHash: betaHash, eventKey: 'grant:test', eventType: 'grant', creditsDelta: 30 });
  check('同じevent_keyを二重計上しない', ledger.filter(x => x.eventKey === 'grant:test').length === 1);

  await auth.recordApiUsage({
    betaTokenHash: betaHash, sessionId: 'session-shadow', model: 'claude-haiku-4-5-20251001', source: 'ptt',
    usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    environment: 'production',
  });
  const anthropic = ledger.find(x => x.eventKey === 'anthropic:101');
  check('Anthropic原価を1USD=10 Creditsで減算', anthropic && Math.abs(anthropic.delta + 10) < 1e-9);

  await auth.recordGoogleUsage({
    betaTokenHash: betaHash, sessionId: 'session-shadow', kind: 'tts', charCount: 1000,
    voice: 'ja-JP-Neural2-B', language: 'ja-JP', success: true, environment: 'production',
  });
  const tts = ledger.find(x => x.vendor === 'google_tts');
  check('Neural2 TTSを$16/100万文字で換算', tts && Math.abs(tts.delta + 0.16) < 1e-9);

  await auth.recordGoogleUsage({
    betaTokenHash: betaHash, sessionId: 'session-shadow', kind: 'stt', audioSeconds: 60,
    language: 'ja-JP', success: true, environment: 'production',
  });
  const stt = ledger.find(x => x.vendor === 'google_stt');
  check('STTを保守的な$0.024/分で換算', stt && Math.abs(stt.delta + 0.24) < 1e-9);

  await auth.recordGoogleUsage({
    betaTokenHash: betaHash, sessionId: 'session-shadow', kind: 'tts', charCount: 999,
    success: false, environment: 'production',
  });
  check('失敗したGoogle呼出はCredits減算しない', ledger.filter(x => x.vendor === 'google_tts').length === 1);

  const authSource = fs.readFileSync(__dirname + '/auth.js', 'utf8');
  check('Credits台帳にAccess Code生値カラムを持たない', !/credit_accounts[\s\S]{0,1000}\baccess_code\b/i.test(authSource));
  check('台帳event_keyにUNIQUE制約', /event_key\s+TEXT NOT NULL UNIQUE/.test(authSource));
  check('reconciliation単価をnumericへ明示変換', /\$1::numeric/.test(authSource) && /\$2::numeric/.test(authSource));

  console.log(`\nShadow Credits: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
})().catch(err => { console.error(err); process.exit(1); });
