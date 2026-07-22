// ══════════════════════════════════════════════════════════════════════
// Google使用量のレース帰属テスト（Codex再レビュー 2026-07-23 指摘 #5 への対応）
//   auth.jsの本番関数（recordApiUsage/recordGoogleUsage/getApiUsageStats）を
//   実際に呼び、pg.Poolだけをスタブに差し替えて検証する（ロジックの写経はしない）。
//   加えて、server.jsのaudioDurationSeconds/usageSessionId検証ロジックを本番コードから
//   抽出して実行し、範囲外・不正値がどう扱われるかを確認する。
// ══════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const Module = require('module');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  cond ? pass++ : fail++;
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (cond && !detail ? '' : ('  → ' + (detail !== undefined ? detail : ''))));
}

// ── pg.Poolをスタブに差し替える（実DB不要。INSERT/CREATE TABLE等の呼び出しを記録するだけ）──
const inserts = []; // { table, values }
const stubPool = {
  async query(sql, params) {
    const s = String(sql);
    if (/^\s*CREATE TABLE|^\s*ALTER TABLE|^\s*CREATE INDEX/i.test(s)) return { rows: [] };
    const m = s.match(/INSERT INTO (\w+)/i);
    if (m) {
      inserts.push({ table: m[1], sql: s, params });
      // RETURNING id を含むクエリはidを返す（auth.js側がrows[0].idを読む）
      if (/RETURNING id/i.test(s)) return { rows: [{ id: inserts.length }] };
      return { rows: [] };
    }
    if (/^\s*SELECT/i.test(s)) return { rows: [] };
    return { rows: [] };
  },
};

// 'pg'モジュールを事前にrequireし、そのキャッシュを丸ごとスタブへ差し替える。
// こうするとauth.js内の `const { Pool } = require('pg')` が我々のスタブを受け取る。
const pgResolved = require.resolve('pg');
require('pg'); // キャッシュへ載せる
require.cache[pgResolved].exports = { Pool: function Pool() { return stubPool; } };

process.env.DATABASE_URL = 'postgres://stub/stub';
process.env.JWT_SECRET = 'test-secret';
delete process.env.BREVO_API_KEY;
delete process.env.GMAIL_USER;

const auth = require('./auth');

(async () => {
  const ok = await auth.init();
  check('auth.init()がスタブPoolで完了する(ready)', ok === true && auth.isReady() === true);

  // ── シナリオ1: TTS成功 → user_id + session_id + char_count ──
  inserts.length = 0;
  await auth.recordGoogleUsage({
    userId: 42, sessionId: 'race-session-A', kind: 'tts', charCount: 87, voice: 'ja-JP-Neural2-B',
    language: 'ja-JP', success: true, environment: 'production',
  });
  {
    const row = inserts.find(r => r.table === 'google_usage_log');
    check('TTS成功: google_usage_logへINSERTされる', !!row);
    if (row) {
      const [userId, sessionId, kind, charCount, audioBytes, audioSeconds, voice, language, success] = row.params;
      check('TTS成功: user_id=42', userId === 42);
      check('TTS成功: session_id一致', sessionId === 'race-session-A');
      check('TTS成功: kind=tts', kind === 'tts');
      check('TTS成功: char_count=87', charCount === 87);
      check('TTS成功: success=true', success === true);
    }
  }

  // ── シナリオ2: TTS失敗 → 同じsession_id + success=false ──
  inserts.length = 0;
  await auth.recordGoogleUsage({
    userId: 42, sessionId: 'race-session-A', kind: 'tts', charCount: 87, voice: 'ja-JP-Neural2-B',
    language: 'ja-JP', success: false, environment: 'production',
  });
  {
    const row = inserts.find(r => r.table === 'google_usage_log');
    const success = row && row.params[8];
    const sessionId = row && row.params[1];
    check('TTS失敗: success=falseで記録される', success === false);
    check('TTS失敗: session_idは成功時と同じ', sessionId === 'race-session-A');
  }

  // ── シナリオ3: Bridge STT成功 → session_id + audio_seconds + audio_bytes ──
  inserts.length = 0;
  await auth.recordGoogleUsage({
    userId: null, sessionId: 'race-session-A', kind: 'stt', audioBytes: 48000, audioSeconds: 3.25,
    language: 'ja-JP', success: true, environment: 'production',
  });
  {
    const row = inserts.find(r => r.table === 'google_usage_log');
    if (row) {
      const [userId, sessionId, kind, charCount, audioBytes, audioSeconds] = row.params;
      check('STT成功: session_id一致', sessionId === 'race-session-A');
      check('STT成功: audio_bytes=48000', audioBytes === 48000);
      check('STT成功: audio_seconds=3.25', audioSeconds === 3.25);
      // BridgeはAuthorizationを持たないためuser_idはNULLで正しい（設計通り）
      check('STT成功: user_idはNULL(Bridge経路は未認証が仕様)', userId === null);
    } else check('STT成功: google_usage_logへINSERTされる', false);
  }

  // ── シナリオ4: STT失敗 → 同じsession_id + success=false ──
  inserts.length = 0;
  await auth.recordGoogleUsage({
    userId: null, sessionId: 'race-session-A', kind: 'stt', audioBytes: 12000, audioSeconds: null,
    language: 'ja-JP', success: false, environment: 'production',
  });
  {
    const row = inserts.find(r => r.table === 'google_usage_log');
    const success = row && row.params[8];
    const sessionId = row && row.params[1];
    const audioSeconds = row && row.params[5];
    check('STT失敗: success=falseで記録される', success === false);
    check('STT失敗: session_idは成功時と同じ', sessionId === 'race-session-A');
    check('STT失敗(圧縮音声等でaudio_seconds不明): NULLのまま(推測しない)', audioSeconds === null);
  }

  // ── シナリオ5: session_idがGoogleログとAnthropicログで一致（同一レース帰属）──
  inserts.length = 0;
  await auth.recordApiUsage({
    userId: 42, sessionId: 'race-session-A', character: 'LunaJP', mode: 'race',
    source: 'auto_judge', trigger: 'battle', model: 'claude-haiku-4-5-20251001',
    usage: { input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    environment: 'production',
  });
  await auth.recordGoogleUsage({
    userId: 42, sessionId: 'race-session-A', kind: 'tts', charCount: 20, voice: 'v', language: 'ja-JP',
    success: true, environment: 'production',
  });
  {
    const apiRow = inserts.find(r => r.table === 'api_usage_log');
    const googleRow = inserts.find(r => r.table === 'google_usage_log');
    check('同一session_idでapi_usage_logとgoogle_usage_logを結合できる',
      !!apiRow && !!googleRow && apiRow.params[1] === googleRow.params[1] && apiRow.params[1] === 'race-session-A');
  }

  // ── シナリオ6: 未知モデルはコストをNULLで保存（過少計上しない）──
  inserts.length = 0;
  await auth.recordApiUsage({
    userId: 1, sessionId: 's', model: 'claude-future-model-9000',
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    environment: 'production',
  });
  {
    const row = inserts.find(r => r.table === 'api_usage_log');
    const estimatedCost = row && row.params[11];
    check('未知モデルはestimated_cost_usdがNULL(0円にしない)', estimatedCost === null);
  }

  // ── シナリオ7: DB書込失敗時、recordApiUsage/recordGoogleUsage自体はPromiseをrejectする ──
  //   （呼び出し元=server.jsがそれを.catch()で握りつぶす設計になっているかは、下の
  //    server.js静的配線検査で別途確認する。ここではauth.js側がエラーを飲み込んで
  //    「成功したフリ」をしないことを確認する）。
  //   pool自体は差し替えず、参照済みのstubPoolの.queryだけ一時的に失敗させる。
  const originalQuery = stubPool.query;
  stubPool.query = async () => { throw new Error('stub DB down'); };
  let apiUsageRejected = false, googleUsageRejected = false;
  try { await auth.recordApiUsage({ sessionId: 's', model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 1, output_tokens: 1 }, environment: 'production' }); }
  catch (e) { apiUsageRejected = true; }
  try { await auth.recordGoogleUsage({ sessionId: 's', kind: 'tts', charCount: 1, success: true, environment: 'production' }); }
  catch (e) { googleUsageRejected = true; }
  stubPool.query = originalQuery;
  check('DB失敗時: recordApiUsageは例外を飲み込まずrejectする', apiUsageRejected);
  check('DB失敗時: recordGoogleUsageは例外を飲み込まずrejectする', googleUsageRejected);

  // ── server.js側：recordApiUsage/recordGoogleUsage呼び出しがawaitされていない(fire-and-forget)か ──
  const serverSrc = fs.readFileSync(__dirname + '/server.js', 'utf8');
  const callSites = [...serverSrc.matchAll(/auth\.record(?:ApiUsage|GoogleUsage)\(/g)];
  check('server.js内にrecordApiUsage/recordGoogleUsage呼び出しが存在する', callSites.length >= 3, 'found=' + callSites.length);
  let allFireAndForget = true;
  for (const m of callSites) {
    const before = serverSrc.slice(Math.max(0, m.index - 20), m.index);
    if (/await\s*$/.test(before)) allFireAndForget = false;
  }
  check('全呼び出しがawaitされていない(fire-and-forget=DB失敗で応答をブロックしない)', allFireAndForget);
  const hasCatchNearby = callSites.every(m => {
    const after = serverSrc.slice(m.index, m.index + 300);
    return /\.catch\(/.test(after);
  });
  check('全呼び出しに.catch()が付いている(未処理rejectionでプロセスを落とさない)', hasCatchNearby);

  // ── server.js側：usageSessionId(64文字制限)とaudioDurationSeconds(範囲検証)の抽出テスト ──
  const usageSessionIdBlock = serverSrc.match(/const usageSessionId = \(typeof req\.body\.usageSessionId[\s\S]*?: null;/)[0];
  check('server.jsにusageSessionId長さ検証コードが存在する', !!usageSessionIdBlock);
  const vm = require('vm');
  function validateSessionId(input) {
    const ctx = { req: { body: { usageSessionId: input } } };
    vm.createContext(ctx);
    vm.runInContext(usageSessionIdBlock + '\nthis.__out = usageSessionId;', ctx);
    return ctx.__out;
  }
  check('65文字のsession_idはnullになる(64文字上限)', validateSessionId('x'.repeat(65)) === null);
  check('64文字ちょうどのsession_idは許可される', validateSessionId('x'.repeat(64)) === 'x'.repeat(64));
  check('数値のsession_idはnullになる(型検証)', validateSessionId(12345) === null);
  check('未指定のsession_idはnull', validateSessionId(undefined) === null);

  const durationBlock = serverSrc.match(/const MAX_PTT_SECONDS[\s\S]*?rawDuration <= MAX_PTT_SECONDS\) \? rawDuration : null;/)[0];
  check('server.jsにaudioDurationSeconds範囲検証コードが存在する', !!durationBlock);
  function validateDuration(input) {
    const ctx = { req: { body: { audioDurationSeconds: input } } };
    vm.createContext(ctx);
    vm.runInContext(durationBlock + '\nthis.__out = audioDurationSeconds;', ctx);
    return ctx.__out;
  }
  check('負の秒数はnullになる', validateDuration(-1) === null);
  check('121秒(上限超過)はnullになる', validateDuration(121) === null);
  check('120秒(上限ちょうど)は許可される', validateDuration(120) === 120);
  check('0秒は許可される(0以上)', validateDuration(0) === 0);
  check('文字列はnullになる(型検証)', validateDuration('3.5') === null);
  check('NaNはnullになる', validateDuration(NaN) === null);
  check('未指定はnull(圧縮音声経路はNULLのまま)', validateDuration(undefined) === null);

  console.log(`\n${fail === 0 ? '✅' : '❌'} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
