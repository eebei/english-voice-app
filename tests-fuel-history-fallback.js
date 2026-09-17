#!/usr/bin/env node
'use strict';

// 2026-09-14 Yuji指示「既存11イベントfixtureと実ログを製品経路へ接続」の第一段。
//
// session-memory.strategyFuelEvidence()（本人・同条件の過去燃費、確認済み・独自
// テスト済み）が answerFuel の梯子へ一度も配線されていなかった——2026-09-13の
// 独立調査（review/CLAUDE_INDEPENDENT_RESEARCH_20260913.md）で既に指摘済みの
// 未接続で、review/fixtures/race-conversation-fuel-pit-v1.json の e01/e02が
// 要求する「履歴燃費4.28を暫定として使い、実測待ちだけで終了しない」を満たせて
// いなかった。この配線を実装し、実製品コード（session-strategy-state.js /
// local-intent-router.js / session-memory.js）を通して検証する。

const path = require('path');
let pass = 0;
const failures = [];
function check(group, name, ok, detail) {
  if (ok) { pass++; return true; }
  failures.push(`[${group}] ${name}` + (detail ? '\n       ' + detail : ''));
  return false;
}

const S = require(path.join(__dirname, 'desktop/session-strategy-state.js'));
const router = require(path.join(__dirname, 'desktop/local-intent-router.js'));
const memory = require(path.join(__dirname, 'desktop/session-memory.js'));

const NOW = Date.now();
function historyRecord(overrides) {
  return Object.assign({
    userId: 'driver-a', custId: 'c1', track: 'fixture-track', car: 'fixture-car',
    date: '2026-09-01', recordedAt: new Date(NOW - 24 * 3600 * 1000).toISOString(),
    avgFuelPerLap: 4.28, totalLaps: 20,
  }, overrides || {});
}

// ════════════════════════════════════════════════════════════════════
// ① answerFuel（state層）：history_per_lap_l のAPI契約
// ════════════════════════════════════════════════════════════════════
{
  const G = '①answerFuel';

  // ライブ実測が無い・履歴だけある：履歴を暫定根拠として使う。
  {
    const st = S.create({ session_key: 'af1' });
    const a = S.answerFuel(st, { fuel_l: 8.56, per_lap_l: null, history_per_lap_l: 4.28, at: NOW });
    check(G, '履歴のみの時、約走行可能周回数を返す', /約2周走行可能/.test(a.reply), a.reply);
    check(G, '履歴を実測(平均)ではなく前回実績(暫定)と明示する',
      a.reply.includes('前回実績4.28L/周（暫定）'), a.reply);
    check(G, '必要量・過不足は断定しない（残り周回未確定のまま）',
      a.shortfall_l === null, JSON.stringify(a));
  }

  // ライブ実測が有る時は、ライブを優先し履歴を使わない（「先に見つけたから終了」を避ける）。
  {
    const st = S.create({ session_key: 'af2' });
    const a = S.answerFuel(st, { fuel_l: 20, per_lap_l: 4.8, history_per_lap_l: 4.28, at: NOW });
    check(G, 'ライブ実測がある時は履歴を使わない', a.reply.includes('平均4.80L/周'), a.reply);
    check(G, 'ライブ優先時は「前回実績」と言わない', !a.reply.includes('前回実績'), a.reply);
  }

  // 履歴根拠で残り周回まで確定した場合、過不足断定にも「推定」と明示する。
  {
    const st = S.create({ session_key: 'af3' });
    const a = S.answerFuel(st, { fuel_l: 8.56, per_lap_l: null, history_per_lap_l: 4.28,
      laps_remaining: 12, at: NOW });
    check(G, '履歴根拠でも残り周回が確定すれば過不足を計算する', a.shortfall_l !== null, JSON.stringify(a));
    check(G, '履歴根拠の過不足断定は推定であると明示する（実測とは言わない）',
      a.reply.includes('前回実績ベースの推定'), a.reply);
  }

  // 履歴も無ければ従来どおり（回帰）。
  {
    const st = S.create({ session_key: 'af4' });
    const a = S.answerFuel(st, { fuel_l: 8.56, per_lap_l: null, at: NOW });
    check(G, '回帰：履歴も無ければ従来の「実測がまだ足りない」のまま',
      a.reply === '現在燃料8.6L。燃費の実測がまだ足りない。', a.reply);
  }
}

// ════════════════════════════════════════════════════════════════════
// ② 実routerを通した end-to-end（fixture e01/e02相当の状況）
// ════════════════════════════════════════════════════════════════════
{
  const G = '②router e2e';

  // pit未実行・ライブ実測ゼロ・本人同条件の履歴あり：履歴フォールバックが効く。
  {
    const st = S.create({ session_key: 'r1' });
    const history = [historyRecord()];
    const live = { fuel: 8.56, track: 'fixture-track', car_model: 'fixture-car', cust_id: 'c1' };
    const r = router.route({ text: '燃料足りる？', lang: 'ja', live, strategy: { state: st, api: S },
      raceHistory: history, currentUserId: 'driver-a', sessionMemory: memory });
    check(G, 'fixture e01/e02相当：pit前でも履歴フォールバックで答える',
      r && r.handled === true && /前回実績4\.28L\/周/.test(r.reply), JSON.stringify(r));
  }

  // fuelReplyがより詳しい権威(pit_timing_authority)を持つ時は、それを優先する（回帰）。
  {
    const st = S.create({ session_key: 'r2' });
    const history = [historyRecord()];
    const live = {
      fuel: 8.56, track: 'fixture-track', car_model: 'fixture-car', cust_id: 'c1',
      fuel_strategy: { pit_timing_authority: { available: true, range_laps: 2.0,
        shortfall_to_finish_l: 8.3, decision: 'hold', laps_until_latest_safe_pit: null,
        latest_safe_pit_lap: null, selected_plan: 'A' } },
    };
    const r = router.route({ text: '燃料足りる？', lang: 'ja', live, strategy: { state: st, api: S },
      raceHistory: history, currentUserId: 'driver-a', sessionMemory: memory });
    check(G, '回帰：pit_timing_authorityがある時は履歴フォールバックへ迂回しない',
      r && /8\.3L不足/.test(r.reply) && !r.reply.includes('前回実績'), JSON.stringify(r));
  }

  // ライブ実測3周分がある時は、履歴ではなくライブを使う（回帰）。
  {
    const st = S.create({ session_key: 'r3' });
    const history = [historyRecord()];
    const live = {
      fuel: 20, track: 'fixture-track', car_model: 'fixture-car', cust_id: 'c1',
      fuel_strategy: { avg_fuel_per_lap: 4.8 },
    };
    const r = router.route({ text: '燃料足りる？', lang: 'ja', live, strategy: { state: st, api: S },
      raceHistory: history, currentUserId: 'driver-a', sessionMemory: memory });
    check(G, '回帰：ライブ実測がある時は履歴を使わない',
      r && !r.reply.includes('前回実績'), JSON.stringify(r));
  }

  // 別ドライバーの履歴は使わない（本人以外の実績を暫定根拠にしない）。
  {
    const st = S.create({ session_key: 'r4' });
    const history = [historyRecord({ userId: 'someone-else', custId: 'c999' })];
    const live = { fuel: 8.56, track: 'fixture-track', car_model: 'fixture-car', cust_id: 'c1' };
    const r = router.route({ text: '燃料足りる？', lang: 'ja', live, strategy: { state: st, api: S },
      raceHistory: history, currentUserId: 'driver-a', sessionMemory: memory });
    check(G, '別ドライバーの履歴は使わない（従来の実測待ちのまま）',
      r && !r.reply.includes('前回実績') && r.reply.includes('実測がまだ足りない'), JSON.stringify(r));
  }

  // 別車種の履歴は使わない。
  {
    const st = S.create({ session_key: 'r5' });
    const history = [historyRecord({ car: 'different-car' })];
    const live = { fuel: 8.56, track: 'fixture-track', car_model: 'fixture-car', cust_id: 'c1' };
    const r = router.route({ text: '燃料足りる？', lang: 'ja', live, strategy: { state: st, api: S },
      raceHistory: history, currentUserId: 'driver-a', sessionMemory: memory });
    check(G, '別車種の履歴は使わない',
      r && !r.reply.includes('前回実績'), JSON.stringify(r));
  }
}

// ════════════════════════════════════════════════════════════════════
// ③ 2026-09-14 Codex差戻し：同じdriver/car/trackでも「条件が違う履歴」を使わない
//    反例は Codex が実routerで再現したもの——履歴=別series・Practice・sprint・
//    無制限給油・タイヤ自由・旧setup・路温10℃／現在=別series・Race・endurance・
//    給油制限・タイヤ制限・新setup・路温40℃。旧実装は identity に driver/car/track
//    しか渡していなかったため、全ての条件が「不明」として照合を素通りした。
// ════════════════════════════════════════════════════════════════════
{
  const G = '③条件照合';

  const priorLoose = () => historyRecord({
    seriesId: 111, sessionType: 'PRACTICE', raceFormat: 'sprint',
    fuelRule: 'unlimited', tyreRule: 'free', setupFingerprint: 'setup-old', trackTempC: 10,
  });
  const currentStrict = {
    seriesId: 222, sessionType: 'RACE', raceFormat: 'endurance',
    fuelRule: 'restricted', tyreRule: 'limited', setupFingerprint: 'setup-new', trackTempC: 40,
  };
  const identityFor = over => Object.assign({
    userId: 'driver-a', custId: 'c1', track: 'fixture-track', car: 'fixture-car',
  }, currentStrict, over || {});
  const liveBase = { fuel: 8.56, track: 'fixture-track', car_model: 'fixture-car', cust_id: 'c1' };
  const routeWith = (history, memoryIdentity) => router.route({
    text: '燃料足りる？', lang: 'ja', live: liveBase,
    strategy: { state: S.create({ session_key: 'c' + Math.random() }), api: S },
    raceHistory: history, currentUserId: 'driver-a', sessionMemory: memory, memoryIdentity,
  });

  // Codexの反例そのもの。
  {
    const r = routeWith([priorLoose()], identityFor());
    check(G, 'Codex反例：別series・Practice・別規則の履歴を燃費根拠にしない',
      r && !r.reply.includes('前回実績') && !/約\d+周走行可能/.test(r.reply), JSON.stringify(r));
  }

  // 条件を1つずつ崩し、どれ単独でも fail-closed になることを確認する。
  const solo = [
    ['別series', { seriesId: 111 }],
    ['別session種別', { sessionType: 'PRACTICE' }],
    ['別レース形式', { raceFormat: 'sprint' }],
    ['別燃料規則', { fuelRule: 'unlimited' }],
    ['別タイヤ規則', { tyreRule: 'free' }],
  ];
  for (const [label, over] of solo) {
    const rec = historyRecord(Object.assign({}, currentStrict, over));
    const r = routeWith([rec], identityFor());
    check(G, `${label}の履歴は単独でも使わない`, r && !r.reply.includes('前回実績'), JSON.stringify(r));
  }

  // 現在側が既知なのに履歴側に記録が無い（旧形式レコード）＝ fail-closed。
  {
    const rec = historyRecord();  // series/sessionType/rule 系が未記録
    const r = routeWith([rec], identityFor());
    check(G, '現在は既知・履歴は欠損なら使わない（不明を「同じ」にしない）',
      r && !r.reply.includes('前回実績'), JSON.stringify(r));
  }

  // 全条件一致：使える。かつ confidence は confirmed にしない。
  {
    const rec = historyRecord(Object.assign({}, currentStrict));
    const r = routeWith([rec], identityFor());
    check(G, '全条件一致なら履歴を使う', r && /前回実績4\.28L\/周/.test(r.reply), JSON.stringify(r));
    check(G, '履歴根拠の回答は confidence:confirmed にしない（本文の「暫定」と一致）',
      r && r.confidence === 'estimate' && r.basis === 'memory_previous', JSON.stringify(r));
  }

  // setup違い・路温差は設計上の許容差：使えるが低確度＋差異を本文に明示する。
  {
    const rec = historyRecord(Object.assign({}, currentStrict,
      { setupFingerprint: 'setup-old', trackTempC: 10 }));
    const r = routeWith([rec], identityFor());
    check(G, 'setup違い・路温差は使うが差異を本文へ明示する',
      r && r.reply.includes('前回実績') && /セットアップが違う/.test(r.reply)
        && /路温差30℃/.test(r.reply), JSON.stringify(r));
    check(G, 'setup違い・路温差の回答は estimate_low',
      r && r.confidence === 'estimate_low'
        && Array.isArray(r.evidence_warnings) && r.evidence_warnings.length === 2, JSON.stringify(r));
  }

  // 現在側が不明な条件は問わない（回帰：条件が取れないだけで記憶を全部殺さない）。
  {
    const rec = historyRecord(Object.assign({}, currentStrict));
    const r = routeWith([rec], { userId: 'driver-a', custId: 'c1',
      track: 'fixture-track', car: 'fixture-car' });
    check(G, '現在側が不明な条件は照合しない（従来どおり使える）',
      r && /前回実績4\.28L\/周/.test(r.reply), JSON.stringify(r));
  }
}

// ════════════════════════════════════════════════════════════════════
// ④ renderer の currentMemoryIdentity() を実抽出して実行する。
//    router がいくら照合しても、renderer が条件を載せなければ全て「不明」で
//    素通りする（Codex 2026-09-14 P1の実害）。文字列検査ではなく実関数を動かす。
//    「renderer がこの戻り値をそのまま router へ渡すこと」は
//    tests-previous-fuel-utterance-fixture.js が実 route() を spy して確認する。
// ════════════════════════════════════════════════════════════════════
{
  const G = '④renderer identity';
  const fs = require('fs');
  const vm = require('vm');
  const html = fs.readFileSync(path.join(__dirname, 'desktop/renderer.html'), 'utf8');
  const grab = name => {
    const start = html.indexOf(`function ${name}(`);
    if (start < 0) return null;
    let depth = 0, i = html.indexOf('{', start);
    const open = i;
    for (; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
    }
    return null;
  };
  const src = grab('currentMemoryIdentity');
  if (!check(G, 'renderer から currentMemoryIdentity を抽出できる', !!src)) {
    // 抽出できないなら以降は実行できない
  } else {
    const sandbox = {
      currentMemoryUserId: () => 'driver-a',
      lastTrack: 'fixture-track', lastCarModel: 'fixture-car', lastCarClass: 'GT3',
      lastSessionType: 'RACE',
      lastTelemetry: { cust_id: 'c1', laps_total: 40,
        race_plan: { kind: 'endurance', configured_duration_s: 3600 },
        weather: { track_temp_c: 40 } },
      lastSessionAuthority: { series_id: 222, fuel_rule: 'restricted', tyre_rule: 'limited',
        setup_fingerprint: 'setup-new' },
      Number, JSON,
    };
    vm.createContext(sandbox);
    vm.runInContext(src + '\nvar __id = currentMemoryIdentity();', sandbox, { filename: 'renderer.html#identity' });
    const id = sandbox.__id;
    check(G, 'seriesId を Bridge 権威から載せる', id.seriesId === 222, JSON.stringify(id));
    check(G, 'sessionType を載せる', id.sessionType === 'RACE', JSON.stringify(id));
    check(G, 'raceFormat（race_plan.kind）を載せる', id.raceFormat === 'endurance', JSON.stringify(id));
    check(G, 'fuelRule を載せる', id.fuelRule === 'restricted', JSON.stringify(id));
    check(G, 'tyreRule を載せる', id.tyreRule === 'limited', JSON.stringify(id));
    check(G, 'setupFingerprint を載せる', id.setupFingerprint === 'setup-new', JSON.stringify(id));
    check(G, 'trackTempC を載せる', id.trackTempC === 40, JSON.stringify(id));

    // この identity を実 router へ通すと、条件違いの履歴は使われない（①〜③と同じ経路）。
    const st = S.create({ session_key: 'rid' });
    const loose = historyRecord({ seriesId: 111, sessionType: 'PRACTICE', raceFormat: 'sprint',
      fuelRule: 'unlimited', tyreRule: 'free', setupFingerprint: 'setup-old', trackTempC: 10 });
    const r = router.route({ text: '燃料足りる？', lang: 'ja',
      live: { fuel: 8.56, track: 'fixture-track', car_model: 'fixture-car', cust_id: 'c1' },
      strategy: { state: st, api: S }, raceHistory: [loose],
      currentUserId: 'driver-a', sessionMemory: memory, memoryIdentity: id });
    check(G, '実 renderer identity を通すと条件違いの履歴は採用されない',
      r && !r.reply.includes('前回実績'), JSON.stringify(r));
  }
}

console.log(`\n${pass} checks passed, ${failures.length} failed.`);
if (failures.length) {
  console.error('\nFAILURES:\n' + failures.join('\n\n'));
  process.exit(1);
}
