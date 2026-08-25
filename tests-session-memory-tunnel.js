#!/usr/bin/env node
'use strict';

// スライス1（2026-08-25）— Tunnel Completion Rule の入口→出口を一本で証明する。
//
//   Bridge捕捉 → session_summary → pw_raceHistory → 決定論的取得 → 発話
//
// 「保存済み」を合格にしない。**発話まで到達すること**と、
// **記録が無い時に現在値を代用しないこと**の両方を検査する。
//
// 外部APIは呼ばない。

const fs = require('fs');
const assert = require('assert');
const memory = require('./desktop/session-memory');
const TEST_NOW = Date.parse('2026-08-25T12:00:00Z');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : ' -> ' + (detail || '')));
  ok ? pass++ : fail++;
}

const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');

// ── 入口：Bridge が捕捉して session_summary へ載せる ───────────────
console.log('\n══ 入口（Bridge） ══');
check('スタート順位を Racing 遷移の一度だけ捕捉する',
  /if cur_ss == 4 and prev_session_state != 4:[\s\S]{0,400}race_start_class_pos = class_pos/.test(bridge));
check('捕捉をログに残す（後から辿れる）', /RACE START POSITION/.test(bridge));
check('天候を毎フレーム保持する', /last_weather = weather/.test(bridge));
check('setup_fingerprint と series_id を SessionInfo から取る',
  /session_setup_fingerprint = info\.get\('setup_fingerprint'\)/.test(bridge)
  && /session_series_id = info\.get\('series_id'\)/.test(bridge));

// session_summary は2箇所ある。片方だけに載せると、遷移経路で事実が落ちる。
const summaryFields = ['setup_fingerprint', 'series_id', 'start_class_position', 'weather'];
summaryFields.forEach(field => {
  const hits = (bridge.match(new RegExp("'" + field + "': ", 'g')) || []).length;
  check(`session_summary の両方に ${field} が載る（${hits}箇所）`, hits >= 2, String(hits));
});

// ★Build 281 の P1-2：片系統だけのリセットは前セッションの事実を今回として流出させる。
console.log('\n══ セッション境界（両系統で消える） ══');
['race_start_class_pos', 'session_setup_fingerprint', 'session_series_id', 'last_weather'].forEach(v => {
  check(`${v} が共通リセット辞書にある`, new RegExp("'" + v + "': ").test(bridge));
  check(`  ${v} が _reset 経路で消える`, new RegExp(v + " = _reset\\['" + v + "'\\]").test(bridge));
  check(`  ${v} が _sig_reset 経路で消える`, new RegExp(v + " = _sig_reset\\['" + v + "'\\]").test(bridge));
});

// ── 保存：renderer が pw_raceHistory へ残す ──────────────────────
console.log('\n══ 保存（pw_raceHistory） ══');
['userId', 'startPos', 'setupFingerprint', 'seriesId', 'trackTempC', 'airTempC', 'recordedAt'].forEach(f => {
  check(`${f} を保存する`, new RegExp(f + ':').test(renderer));
});
check('Bridge由来の値だけを採用し、欠けていれば null で残す',
  /startPos:\(Number\.isInteger\(data\.start_class_position\)/.test(renderer));

// ── 取得：決定論層（ここが数字を持つ唯一の場所）────────────────────
console.log('\n══ 取得（決定論） ══');
const YESTERDAY = {
  userId: 42, date: '2026-08-24', track: 'Okayama', car: 'Audi R8 LMS GT3', carClass: 'GT3',
  seriesId: 77, setupFingerprint: 'abc123', startPos: 8, finishPos: 4,
  trackTempC: 41.2, airTempC: 29.8, bestLap: 88.4, totalLaps: 20, incidents: 0,
};
const OTHER_TRACK = { ...YESTERDAY, date: '2026-08-23', track: 'Suzuka', trackTempC: 30.1 };
const HISTORY = [OTHER_TRACK, YESTERDAY];
const IDENTITY = { userId: 42, track: 'Okayama', car: 'Audi R8 LMS GT3', seriesId: 77, setupFingerprint: 'abc123' };

check('同一条件の最新1件だけを選ぶ',
  memory.selectPrevious(HISTORY, IDENTITY, TEST_NOW) === YESTERDAY);
check('別トラックの記録は選ばない',
  memory.selectPrevious(HISTORY, { track: 'Monza' }, TEST_NOW) === null);
check('別シリーズの記録は選ばない',
  memory.selectPrevious(HISTORY, { ...IDENTITY, seriesId: 999 }, TEST_NOW) === null);
check('認証ユーザーが違う記録は選ばない',
  memory.selectPrevious(HISTORY, { ...IDENTITY, userId: 999 }, TEST_NOW) === null);
// car だけ空にしても carClass へフォールバックして別値になるため、
// 「欠損」ではなく「不一致」を試すことになる。両方を空にして初めて欠損を再現できる。
check('現在側に車種がある時、記録側の車種欠損を一致扱いにしない',
  memory.selectPrevious([{ ...YESTERDAY, car: '', carClass: '' }], IDENTITY, TEST_NOW) === null);
check('  車種が不一致の記録も選ばない（欠損とは別経路）',
  memory.selectPrevious([{ ...YESTERDAY, car: 'Ferrari 296 GT3', carClass: 'GT3' }], IDENTITY, TEST_NOW) === null);
check('現在側にseriesがある時、記録側のseries欠損を一致扱いにしない',
  memory.selectPrevious([{ ...YESTERDAY, seriesId: null }], IDENTITY, TEST_NOW) === null);
check('認証ユーザーが分かる時、旧recordのuserId欠損を一致扱いにしない',
  memory.selectPrevious([{ ...YESTERDAY, userId: null }], IDENTITY, TEST_NOW) === null);
check('車種が取れていない時は車種で絞り込まない（正しい記録を捨てない）',
  memory.selectPrevious(HISTORY, { userId: 42, track: 'Okayama' }, TEST_NOW) === YESTERDAY);
check('90日を超える記録は今回の事実として使わない',
  memory.selectPrevious([{ ...YESTERDAY, date: '2026-05-01' }], IDENTITY, TEST_NOW) === null);
check('未来日時のrecordは今回の事実として使わない',
  memory.selectPrevious([{ ...YESTERDAY, date: '2026-09-01' }], IDENTITY, TEST_NOW) === null);

// ── 出口①：過去天候の質問（Build 281 の実走欠陥の再発防止）──────────
console.log('\n══ 出口①：過去天候 ══');
const w = memory.answerHistoricalWeather(HISTORY, IDENTITY, 'ja', TEST_NOW);
check('記録があれば日時と場所つきで答える',
  w.intent === 'historical_weather' && w.reply === '2026-08-24のOkayamaは路面41.2℃、気温29.8℃。', w.reply);
const none = memory.answerHistoricalWeather([], IDENTITY, 'ja', TEST_NOW);
check('記録が無ければ「無い」と言う', none.intent === 'historical_weather_unavailable', none.reply);
check('★現在値を代用しない（23.3のような当日値を混ぜない）',
  !/[0-9]/.test(none.reply), none.reply);
const wrongTrack = memory.answerHistoricalWeather(HISTORY, { track: 'Monza' }, 'ja', TEST_NOW);
check('別トラックでは過去値を流用しない',
  wrongTrack.intent === 'historical_weather_unavailable', wrongTrack.reply);
check('英語でも同じ契約', memory.answerHistoricalWeather([], IDENTITY, 'en', TEST_NOW)
  .reply.includes('will not substitute'));

// ── 出口②：次回ブリーフィング ────────────────────────────────
console.log('\n══ 出口②：次回ブリーフィング ══');
const facts = memory.briefingFacts(HISTORY, IDENTITY, TEST_NOW);
check('スタート順位が事実として出る', facts.startPos === 8, String(facts.startPos));
check('順位変動を計算する（8→4 で +4）', facts.positionsGained === 4, String(facts.positionsGained));
check('同一setupを matched と判定', facts.setupMatch === 'matched', facts.setupMatch);
check('別setupを mismatch と判定',
  memory.briefingFacts(HISTORY, { ...IDENTITY, setupFingerprint: 'zzz' }, TEST_NOW).setupMatch === 'mismatch');
check('setupが取れない時は unknown（断定しない）',
  memory.briefingFacts(HISTORY, { userId: 42, track: 'Okayama' }, TEST_NOW).setupMatch === 'unknown');

const line = memory.briefingLine(facts, 'ja');
check('★北極星の骨格を自分から言える',
  line === '前回2026-08-24のOkayamaは8番手スタートで4位、路面41.2℃。', line);
check('記録が無ければ空文字＝言わない（捏造しない）',
  memory.briefingLine(memory.briefingFacts([], IDENTITY, TEST_NOW), 'ja') === '');
check('setupが違えば、その旨を添える',
  /セットアップは前回と別/.test(
    memory.briefingLine(memory.briefingFacts(HISTORY, { ...IDENTITY, setupFingerprint: 'zzz' }, TEST_NOW), 'ja')));

// ── 配線：出口が実際に発話・注入へ繋がっているか ──────────────────
console.log('\n══ 配線（発話まで到達するか） ══');
check('renderer が session-memory.js を読み込む（＝完成asar検査の対象になる）',
  /<script src="session-memory\.js"><\/script>/.test(renderer));
check('過去天候はLLMより先に決定論で答える',
  renderer.indexOf('answerHistoricalWeatherLocally(text') < renderer.indexOf("await callAPI(inputSource==='ptt'?'ptt':'typed', memoryStatus)"));
check('決定論回答が実際に speak() される',
  /past&&past\.handled\)\{[\s\S]{0,500}speak\(past\.reply/.test(renderer));
check('決定論回答を明示優先度でqueueへ入れる（暗黙のP4へ落とさない）',
  /speak\(past\.reply,\{prio:SPEAK_PRIO\.P2_PROCEDURE, kind:'reply'\}\)/.test(renderer));
// queue に入った後の fate（queued→played / deferred / discarded）は speech queue 契約が持つ。
// この経路がその契約に乗っていることを確認する（独自queueを作っていない）。
check('queue投入が計上される（queued）', /costRecord\('queued'/.test(renderer));
check('破棄は理由つきで計上される（明示的破棄）',
  /costRecord\('discarded'[\s\S]{0,120}reason:'duplicate_dedupe_key'/.test(renderer)
  && /reason:'queue_overflow'/.test(renderer));
check('queue投入と破棄が latency trace にも残る',
  /speechLatencyTrace\('queued'/.test(renderer) && /speechLatencyTrace\('discarded'/.test(renderer));
check('ブリーフィング本文にも確定事実を参照として渡す', /参照用事実: \$\{memoryLine\}/.test(renderer));
check('ブリーフィングの確定事実をLLM任せにせず、先に直接queueへ入れる',
  /if\(memoryLine\)\{[\s\S]{0,500}speak\(memoryLine,\{prio:SPEAK_PRIO\.P2_PROCEDURE,kind:'memory_strategy_briefing'/.test(renderer));
check('LLMには同じ数字を言い直さないよう指示する',
  /決定論radioで既に伝達済み。数字を言い直さず/.test(renderer));
check('事実が無い時は「作るな」と明示する', /前回同条件の確定事実なし。過去の数字を作るな。/.test(renderer));
check('identity は Bridge権威だけで作る（会話・推測から作らない）',
  /function currentMemoryIdentity\(\)\{[\s\S]{0,400}lastSessionAuthority/.test(renderer));

// ── trace：黙った理由が必ず残る ──────────────────────────────
console.log('\n══ trace ══');
check('取得結果を trace する', /diagnosticLog\('SESSION_MEMORY'/.test(renderer));
check('module 欠落を通常の未処理と区別する', /reason=module_missing/.test(renderer));
check('ブリーフィングで喋ったか否かを trace する',
  /diagnosticLog\('MEMORY_BRIEFING'[\s\S]{0,160}spoken='/.test(renderer));

// ── E2E：Bridge の生summary から発話までを一本で再生 ────────────────
console.log('\n══ E2E trace（Bridge summary → 保存 → 取得 → 発話） ══');
{
  // Bridge が送る形そのもの
  const summary = {
    type: 'session_summary', track: 'Okayama', car_model: 'Audi R8 LMS GT3',
    car_class: 'GT3', is_race: true, total_laps: 20, finish_pos: 4,
    best_lap: 88.4, avg_lap: 89.1, incidents: 0,
    setup_fingerprint: 'abc123', series_id: 77, start_class_position: 8,
    weather: { track_temp_c: 41.2, air_temp_c: 29.8, humidity: 55, track_wetness_code: 1 },
    pit_events: [{ entry_lap: 6, exit_lap: 7, entry_class_position: 8, exit_class_position: 4 }],
  };
  // renderer の保存規則をそのまま再現（同じ判定式を使う）
  const w = summary.weather;
  const stored = {
    userId: 42, date: '2026-08-24', track: summary.track, car: summary.car_model, carClass: summary.car_class,
    bestLap: summary.best_lap, totalLaps: summary.total_laps, incidents: summary.incidents,
    finishPos: summary.finish_pos,
    startPos: Number.isInteger(summary.start_class_position) && summary.start_class_position > 0
      ? summary.start_class_position : null,
    setupFingerprint: summary.setup_fingerprint || null,
    seriesId: Number.isInteger(summary.series_id) ? summary.series_id : null,
    trackTempC: Number(w.track_temp_c), airTempC: Number(w.air_temp_c),
  };
  const nextDay = { userId: 42, track: 'Okayama', car: 'Audi R8 LMS GT3', seriesId: 77, setupFingerprint: 'abc123' };

  const trace = [];
  trace.push('bridge_summary: start=' + summary.start_class_position + ' finish=' + summary.finish_pos
    + ' track_temp=' + summary.weather.track_temp_c);
  trace.push('stored: startPos=' + stored.startPos + ' trackTempC=' + stored.trackTempC);
  const picked = memory.selectPrevious([stored], nextDay, TEST_NOW);
  trace.push('retrieved: ' + (picked ? picked.date + '@' + picked.track : 'none'));
  const spoken = memory.briefingLine(memory.briefingFacts([stored], nextDay, TEST_NOW), 'ja');
  trace.push('spoken: ' + (spoken || '(silent)'));
  const asked = memory.answerHistoricalWeather([stored], nextDay, 'ja', TEST_NOW);
  trace.push('asked_past_weather: ' + asked.intent + ' -> ' + asked.reply);
  trace.forEach(l => console.log('   ' + l));

  check('E2E：Bridgeの値が欠けずに保存される',
    stored.startPos === 8 && stored.trackTempC === 41.2);
  check('E2E：翌日に同一条件で取得できる', picked !== null);
  check('E2E：自発発話の一文になる', spoken.includes('8番手スタートで4位'));
  check('E2E：過去天候の質問に41.2℃で答える', asked.reply.includes('41.2'));

  // 反証：翌日が別コースなら、同じ記録を使ってはならない。
  const otherDay = { track: 'Monza', car: 'Audi R8 LMS GT3' };
  check('E2E反証：別コースでは発話しない',
    memory.briefingLine(memory.briefingFacts([stored], otherDay, TEST_NOW), 'ja') === '');
  check('E2E反証：別コースの過去天候は unavailable',
    memory.answerHistoricalWeather([stored], otherDay, 'ja', TEST_NOW).intent === 'historical_weather_unavailable');
}

console.log(`\nSession memory tunnel: ${pass}/${pass + fail}`);
if (fail) process.exit(1);

// ══════════════════════════════════════════════════════════════════════
// ★スライス4（2026-08-25）setup の前後比較（正本 §5.4）
//   本人申告はラベルとしてのみ持ち、数値は Bridge 実測だけを使う。
// ══════════════════════════════════════════════════════════════════════
{
  const fsx = require('fs');
  const M = require('./desktop/session-memory');
  const NOWX = Date.parse('2026-08-25T12:00:00Z');
  const rec = (over) => Object.assign({
    date: '2026-08-24', recordedAt: '2026-08-24T12:00:00.000Z', userId: 'u1',
    track: 'Okayama', car: 'Audi R8 LMS GT3', carClass: 'GT3', seriesId: 419,
    setupFingerprint: 'aaa111', bestLap: 95.400,
  }, over || {});
  const idx = (over) => Object.assign({
    userId: 'u1', track: 'Okayama', car: 'Audi R8 LMS GT3',
    seriesId: 419, setupFingerprint: 'bbb222',
  }, over || {});

  console.log('\n══ スライス4 setup 前後比較 ══');
  const history = [rec(), rec({ setupFingerprint: 'bbb222', bestLap: 94.850,
    date: '2026-08-25', recordedAt: '2026-08-25T10:00:00.000Z' })];
  const cmp = M.setupComparison(history, idx(), NOWX);
  check('同一条件で fingerprint が違う2件を比較する', cmp.available === true, cmp.reason);
  check('数値は Bridge 実測のみ', cmp.measuredSource === 'sdk' && Math.abs(cmp.deltaS + 0.55) < 1e-6);
  const line = M.setupComparisonLine(cmp, 'ja');
  check('★次回 Practice で比較材料として言える', /0\.550秒速く/.test(line), line);

  const same = M.setupComparison([rec(), rec({ bestLap: 94.8 })], idx({ setupFingerprint: 'aaa111' }), NOWX);
  check('★同じ setup 同士は比較しない', same.available === false && same.reason === 'no_setup_change_to_compare');
  const noFp = M.setupComparison(history, idx({ setupFingerprint: null }), NOWX);
  check('現在の fingerprint が無ければ比較しない', noFp.available === false);
  const other = M.setupComparison(history, idx({ track: 'Monza' }), NOWX);
  check('★別コースの setup と比べない', other.available === false);
  check('比較できない時は文を作らない', M.setupComparisonLine(other, 'ja') === '');

  // 欠損記録を比較材料にすると NaN が「0.000秒速くなった」として喋られる。
  const missingLap = M.setupComparison(
    [rec({ bestLap: null }), rec({ setupFingerprint: 'bbb222', bestLap: null })], idx(), NOWX);
  check('★bestLap が無い記録は比較に使わない', missingLap.available === false, missingLap.reason);
  const missingFp = M.setupComparison(
    [rec({ setupFingerprint: '' }), rec({ setupFingerprint: 'bbb222', bestLap: 94.8 })], idx(), NOWX);
  check('★fingerprint が無い記録は「別のsetup」として扱わない',
    missingFp.available === false, missingFp.reason);
  check('★欠損があっても NaN を喋らない',
    M.setupComparisonLine(missingLap, 'ja') === '' && M.setupComparisonLine(missingFp, 'ja') === '');

  const declared = M.attachSetupDeclaration(history.slice(), 'アンチロールバーを1段柔らかく', NOWX);
  check('本人申告はラベルとして貼る', declared.attached === true
    && declared.history[1].setupDeclared.label === 'アンチロールバーを1段柔らかく');
  check('★申告は source=declared で分けて持つ', declared.history[1].setupDeclared.source === 'declared');
  const declaredCmp = M.setupComparison(declared.history, idx(), NOWX);
  check('★申告があれば出所を明示して述べる',
    declaredCmp.declaredSource === 'declared'
    && /申告のあと/.test(M.setupComparisonLine(declaredCmp, 'ja')));
  check('★申告文から数値を作らない',
    !/1段/.test(String(declaredCmp.deltaS)) && declaredCmp.deltaS === cmp.deltaS);
  check('空の申告は貼らない', M.attachSetupDeclaration(history.slice(), '  ', NOWX).attached === false);
  check('記録が無ければ貼らない', M.attachSetupDeclaration([], 'x', NOWX).attached === false);

  const renderer4 = fsx.readFileSync(__dirname + '/desktop/renderer.html', 'utf8')
    .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  check('renderer が申告を捕捉する', /recordSetupDeclaration\(_m\[0\]\)/.test(renderer4));
  check('★renderer がブリーフィングで発話する', /kind:'setup_comparison_briefing'/.test(renderer4));
  check('fate が trace に残る', /SETUP_MEMORY','available=/.test(renderer4));
}

console.log(`\n(スライス4含む累計) ${pass}/${pass + fail}`);
if (fail) process.exit(1);

// ══════════════════════════════════════════════════════════════════════
// ★スライス4b：pit / 燃費（正本 §10 ジャンル2）。
//   `session-memory.js` は record.pitEvents を読んでいたが、renderer が
//   一度も書いていなかった＝pitCount が常に null の死んだ経路だった。
// ══════════════════════════════════════════════════════════════════════
{
  const fsy = require('fs');
  const M2 = require('./desktop/session-memory');
  const NOWY = Date.parse('2026-08-25T12:00:00Z');
  const base = {
    date: '2026-08-24', recordedAt: '2026-08-24T12:00:00.000Z', userId: 'u1',
    track: 'Okayama', car: 'Audi R8 LMS GT3', seriesId: 419,
    startPos: 8, finishPos: 4, trackTempC: 41.2,
  };
  const id2 = { userId: 'u1', track: 'Okayama', car: 'Audi R8 LMS GT3', seriesId: 419 };

  console.log('\n══ スライス4b pit / 燃費 ══');
  const withPit = M2.briefingFacts([Object.assign({}, base, {
    pitEvents: [{ entry_lap: 6 }, { entry_lap: 14 }], avgFuelPerLap: 2.71,
  })], id2, NOWY);
  check('★pit 回数が取り出せる（死んだ経路が生きた）', withPit.pitCount === 2, String(withPit.pitCount));
  check('★燃費が取り出せる', withPit.avgFuelPerLap === 2.71, String(withPit.avgFuelPerLap));
  const line2 = M2.briefingLine(withPit, 'ja');
  check('★pit 回数を自発発話に含める', /ピット2回/.test(line2), line2);
  check('★燃費を自発発話に含める', /平均2\.71L\/周/.test(line2), line2);

  const noPit = M2.briefingFacts([Object.assign({}, base)], id2, NOWY);
  check('記録が無ければ null（0回と混同しない）', noPit.pitCount === null && noPit.avgFuelPerLap === null);
  check('★記録が無ければ言わない', !/ピット/.test(M2.briefingLine(noPit, 'ja')));

  const renderer4b = fsy.readFileSync(__dirname + '/desktop/renderer.html', 'utf8')
    .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  check('★renderer が pit_events を保存する',
    /pitEvents:Array\.isArray\(data\.pit_events\)\?data\.pit_events:null/.test(renderer4b));
  check('★renderer が燃費を保存する',
    /avgFuelPerLap:Number\.isFinite\(Number\(data\.avg_fuel_per_lap\)\)/.test(renderer4b));
}

console.log(`\n(スライス4b含む累計) ${pass}/${pass + fail}`);
if (fail) process.exit(1);
