#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════
// 2026-08-29 Phase F — Trackside Strategy Intelligence V1
//
//   F1 前後相対ペースの専用 authority（燃料・運転スタイル・古いGapを代理にしない）
//   F2 Gap truth とドライバー訂正（自由文を実測へ昇格させず、誤値も繰り返さない）
//   F3 Plan／実測／燃料／handoff が同じ authority snapshot を見る
//   F4 Chief Engineer Mode の実戦導線（単独走行を壊さない）
//
// 固定再生でテストする。外部 API も本番 Team Link Code も使わない。
// ══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const vm = require('vm');
const RP = require('./desktop/relative-pace.js');
const GF = require('./desktop/gap-freshness.js');
const TP = require('./desktop/team-plan.js');
const router = require('./desktop/local-intent-router.js');

const html = fs.readFileSync('desktop/renderer.html', 'utf8');
let pass = 0, fail = 0;
function ck(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '  ✅ ' : '  ❌ ') + label + (ok ? '' : ' -> ' + (detail === undefined ? '' : String(detail))));
  ok ? pass++ : fail++;
}

const T0 = 1_700_000_000_000;
// 同クラス5台。自車 P3、前 P2（#14）、後ろ P4（#7）。別クラスは competitors に入らない。
function snap(overrides = {}) {
  return Object.assign({
    session_num: 2, lap: 12, class_pos: 3, last: 105.0, lap_valid_clean: true,
    fuel: 60.0,
    fuel_strategy: { avg_fuel_per_lap: 3.1, clean_laps_sampled: 4 },
    strategy_plan: { target_lap: 30 },
    competitors: [
      { car_idx: 14, name: 'Ahead One', car_number: '14', class_pos: 2, gap_s: -2.4, lap: 12, last_lap_s: 104.2 },
      { car_idx: 7, name: 'Behind One', car_number: '7', class_pos: 4, gap_s: 1.6, lap: 12, last_lap_s: 106.4 },
      { car_idx: 9, name: 'Behind Two', car_number: '9', class_pos: 5, gap_s: 8.2, lap: 12, last_lap_s: 107.0 }
    ],
    gap_ahead: 2.4, gap_behind: 1.6,
    gap_authority: {
      ahead: { generation: 11, target_car_idx: 14, direction: 'ahead', session_key: '2', gap_s: 2.4 },
      behind: { generation: 11, target_car_idx: 7, direction: 'behind', session_key: '2', gap_s: 1.6 }
    }
  }, overrides);
}
// 実測を積むための連続 snapshot（自車と相手が別々のラップを刻む）。
function feed(laps) {
  let store = RP.emptyStore();
  laps.forEach((lapRow, i) => {
    const s = snap({
      lap: 10 + i, last: lapRow.own, lap_valid_clean: lapRow.clean !== false,
      competitors: [
        { car_idx: 14, name: 'Ahead One', car_number: '14', class_pos: 2, gap_s: -2.4, lap: 10 + i, last_lap_s: lapRow.ahead },
        { car_idx: 7, name: 'Behind One', car_number: '7', class_pos: 4, gap_s: 1.6, lap: 10 + i, last_lap_s: lapRow.behind },
        { car_idx: 9, name: 'Behind Two', car_number: '9', class_pos: 5, gap_s: 8.2, lap: 10 + i, last_lap_s: 107.0 }
      ]
    });
    store = RP.observe({ store, live: s, now: T0 + i * 100000 }).store;
  });
  return store;
}

// ── F1 ───────────────────────────────────────────────────────────────
console.log('══ F1 前後相対ペースの専用 authority ══');
{
  const store = feed([
    { own: 105.2, ahead: 104.2, behind: 106.4 },
    { own: 105.0, ahead: 104.0, behind: 106.6 },
    { own: 104.8, ahead: 104.4, behind: 106.2 }
  ]);
  const now = T0 + 300000;

  const behind = RP.compare({ store, live: snap(), direction: 'behind', lang: 'ja', now });
  ck('後方の同クラス車を CarIdx で固定する', behind.target.car_idx === 7, JSON.stringify(behind.target));
  ck('後ろは実測で遅いと判定', behind.verdict === 'target_slower' && behind.delta_s > 1, JSON.stringify(behind.delta_s));
  ck('比較した有効周数と時間窓を持つ',
    behind.compared_laps === 3 && behind.window_s > 0, JSON.stringify({ l: behind.compared_laps, w: behind.window_s }));
  ck('回答に相手・前後・差分が入る',
    /後ろ/.test(behind.reply) && /#7/.test(behind.reply) && /秒/.test(behind.reply), behind.reply);
  ck('回答は短い一息', behind.reply.length <= 60, behind.reply);

  const ahead = RP.compare({ store, live: snap(), direction: 'ahead', lang: 'ja', now });
  ck('前方も同じ契約で比較する', ahead.target.car_idx === 14 && ahead.verdict === 'target_faster', JSON.stringify(ahead.verdict));

  // 欠損：相手のラップが取れていない
  const blindStore = RP.observe({
    store: RP.emptyStore(),
    live: snap({ competitors: [{ car_idx: 7, name: 'Behind One', car_number: '7', class_pos: 4, gap_s: 1.6, lap: 12, last_lap_s: null }] }),
    now: T0
  }).store;
  const blind = RP.compare({ store: blindStore, live: snap(), direction: 'behind', lang: 'ja', now: T0 });
  ck('相手の実測が無ければ未確認', blind.verdict === 'unconfirmed' && blind.available === false, JSON.stringify(blind.verdict));
  ck('未確認でも相手ペースを作らない', blind.delta_s === null && /未確認/.test(blind.reply), blind.reply);

  // 古いデータ
  const stale = RP.compare({ store, live: snap(), direction: 'behind', lang: 'ja', now: T0 + 10 * 60 * 1000 });
  ck('古い標本は比較に使わない', stale.verdict === 'unconfirmed', JSON.stringify(stale.verdict));

  // 別 CarIdx（順位が入れ替わり、後方が別車になった）
  const swapped = snap({
    competitors: [
      { car_idx: 22, name: 'New Behind', car_number: '22', class_pos: 4, gap_s: 1.1, lap: 12, last_lap_s: 106.0 },
      { car_idx: 14, name: 'Ahead One', car_number: '14', class_pos: 2, gap_s: -2.4, lap: 12, last_lap_s: 104.2 }
    ]
  });
  const other = RP.compare({ store, live: swapped, direction: 'behind', lang: 'ja', now });
  ck('後方が別の車になったら前の車の標本で答えない',
    other.verdict === 'unconfirmed' && other.target.car_idx === 22, JSON.stringify({ v: other.verdict, t: other.target }));

  // 同クラス外は competitors に入らない＝混ざらない
  ck('同クラス外を比較対象にしない',
    RP.adjacentTarget(snap({ class_pos: 1 }), 'ahead') === null);

  // 被覆率
  // 見えている同クラス車を全部標本化しても、クラス総数を知らないうちは
  // 「全車分析済み」を名乗らない（competitors は F2Time が有効な車だけ）。
  const coverage = RP.fieldCoverage({ store, live: snap(), now });
  ck('クラス総数が未確認なら全車分析を装わない',
    coverage.complete_field === false && coverage.class_entry_count === null,
    JSON.stringify(coverage));
  ck('見えている台数と標本数を分けて持つ',
    coverage.visible_same_class_cars === 3 && coverage.sampled_cars === 3, JSON.stringify(coverage));
  ck('クラス総数が分かっていても未標本車があれば装わない',
    RP.fieldCoverage({ store, live: snap(), now, classEntryCount: 12 }).complete_field === false);
  ck('全車を実測できた時だけ complete_field',
    RP.fieldCoverage({ store, live: snap(), now, classEntryCount: 4 }).complete_field === true,
    JSON.stringify(RP.fieldCoverage({ store, live: snap(), now, classEntryCount: 4 })));
  ck('将来の全車拡張のためスコープを明示する', coverage.scope === 'nearest_10', coverage.scope);
}

// ── F1-b 相対ペース質問が pit now にならない ─────────────────────────
console.log('══ F1-b 相対ペース質問は燃料回答にしない ══');
{
  const store = feed([
    { own: 105.2, ahead: 104.2, behind: 106.4 },
    { own: 105.0, ahead: 104.0, behind: 106.6 },
    { own: 104.8, ahead: 104.4, behind: 106.2 }
  ]);
  // 総燃料が全く足りない状況を再現する（RBR の誤答条件）。
  const shortfall = snap({
    fuel: 4.0,
    fuel_strategy: {
      avg_fuel_per_lap: 3.1, clean_laps_sampled: 4, pit_required: true,
      required_fuel_l: 40.0, add_fuel_l: 36.0,
      pit_timing_authority: { available: true, decision: 'hold', selected_plan: 'A', laps_until_latest_safe_pit: 6 }
    }
  });
  ['後ろの方がペース速い？', '前の車、ペース速い？', 'is the car behind faster?'].forEach(q => {
    const out = RP.answerQuestion({ store, live: shortfall, text: q, lang: /[ぁ-ん]/.test(q) ? 'ja' : 'en', now: T0 + 300000 });
    ck(`「${q}」を相対ペースとして扱う`, out.handled === true && out.intent === 'relative_pace');
    ck(`「${q}」の回答に pit / 燃料が出ない`,
      !/ピット|給油|燃料|リットル|pit|box|fuel/i.test(out.reply), out.reply);
  });
  ck('燃料・ピットを含む質問は相対ペース側で扱わない',
    RP.isRelativePaceQuestion('燃料足りる？ピット入る？') === false);
  ck('相対ペース回答は pit 指示を含まないと明示する',
    RP.answerQuestion({ store, live: shortfall, text: '後ろのペース速い？', lang: 'ja', now: T0 + 300000 })
      .contains_pit_instruction === false);
}

// ── F2 Gap truth とドライバー訂正 ────────────────────────────────────
console.log('══ F2 Gap の対象取り違え・古い値・訂正後の再観測 ══');
{
  // 別 CarIdx の値を今の後方車間として言わない（既存 G1/G2 契約の再確認）
  const identity = { direction: 'behind', target_car_idx: 7, generation: 11, session_key: '2', gap_s: 1.6 };
  const wrongTarget = GF.evaluate(identity, snap({
    gap_authority: { behind: { generation: 11, target_car_idx: 22, direction: 'behind', session_key: '2', gap_s: 0.4 } },
    gap_behind: 0.4
  }), T0, { liveAgeMs: 0 });
  ck('対象車が違えば再生しない', wrongTarget.fate === GF.FATE_DISCARD, JSON.stringify(wrongTarget));
  const oldGeneration = GF.evaluate(identity, snap({
    gap_authority: { behind: { generation: 12, target_car_idx: 7, direction: 'behind', session_key: '2', gap_s: 1.9 } },
    gap_behind: 1.9
  }), T0, { liveAgeMs: 0 });
  ck('世代が進んだ古い値はそのまま再生しない',
    oldGeneration.fate !== GF.FATE_PLAY, JSON.stringify(oldGeneration));

  // ドライバー訂正
  const live = snap({ gap_behind: 0.1,
    gap_authority: { behind: { generation: 11, target_car_idx: 7, direction: 'behind', session_key: '2', gap_s: 0.1 } } });
  const disputed = GF.disputeGap(GF.emptyHolds(), 'behind', live, T0);
  ck('訂正でソースを保留にする', disputed.held === true && !!disputed.holds.behind);
  ck('訂正の中の数値を実測として保存しない',
    !('driver_stated_gap_s' in disputed.holds.behind)
    && disputed.holds.behind.disputed_value_s === 0.1
    && disputed.holds.behind.reason === 'driver_disputed', JSON.stringify(disputed.holds.behind));

  const stillHeld = GF.gapHoldStatus(disputed.holds, 'behind', live);
  ck('再観測が無い間は保留のまま', stillHeld.held === true && stillHeld.released === false);
  ck('保留中は未確認と言い、前の値を繰り返さない',
    /未確認/.test(GF.holdReply('behind', 'ja')) && !/0\.1/.test(GF.holdReply('behind', 'ja')));

  const reobserved = GF.gapHoldStatus(disputed.holds, 'behind', snap({
    gap_behind: 1.4,
    gap_authority: { behind: { generation: 12, target_car_idx: 7, direction: 'behind', session_key: '2', gap_s: 1.4 } }
  }));
  ck('新しい観測が来たら保留は解ける', reobserved.held === false && reobserved.released === true);
  ck('別方向は巻き添えにしない', GF.gapHoldStatus(disputed.holds, 'ahead', live).held === false);

  // router が保留を尊重する
  const heldAnswer = router.route({
    text: '後ろとの差は？', lang: 'ja', live, snapshotAgeMs: 0, gapHeld: { ahead: false, behind: true }
  });
  ck('保留中の方向は router が古い値を答えない',
    heldAnswer.handled === true && heldAnswer.intent === 'nearest_gap_held' && !/0\.1/.test(heldAnswer.reply),
    JSON.stringify(heldAnswer));
  const normalAnswer = router.route({ text: '後ろとの差は？', lang: 'ja', live, snapshotAgeMs: 0 });
  ck('保留していなければ従来どおり答える',
    normalAnswer.intent === 'nearest_gap' && /0\.1/.test(normalAnswer.reply), JSON.stringify(normalAnswer));
  const aheadStillAnswered = router.route({
    text: '前との差は？', lang: 'ja', live, snapshotAgeMs: 0, gapHeld: { ahead: false, behind: true }
  });
  ck('保留は方向ごと（前は答え続ける）',
    aheadStillAnswered.intent === 'nearest_gap', JSON.stringify(aheadStillAnswered));
}

// ── F3 単一 authority snapshot ───────────────────────────────────────
console.log('══ F3 Plan／実測／燃料／handoff が同じ snapshot を見る ══');
{
  const NOW = '2026-08-29T02:00:00.000Z';
  const state = TP.confirmCandidate({
    state: TP.ingestHumanInput({
      state: TP.startBriefing({ state: TP.emptyState(), lang: 'ja', now: NOW }).state,
      text: 'ピットは30周で入る', lang: 'ja', now: NOW
    }).state, lang: 'ja', now: NOW
  }).state;

  const onPlanLive = snap({ strategy_plan: { target_lap: 30 } });
  const onPlan = TP.strategyAuthoritySnapshot({ state, live: onPlanLive });
  ck('計画どおりは on_plan', onPlan.verdict === 'on_plan', onPlan.verdict);
  ck('snapshot が Plan revision と実測を同時に持つ',
    onPlan.plan_revision === 1 && onPlan.plan_pit_lap === 30 && onPlan.measured.clean_laps_sampled === 4);

  const drifted = TP.strategyAuthoritySnapshot({ state, live: snap({ strategy_plan: { target_lap: 35 } }) });
  ck('実測がズレたら小変更候補', drifted.verdict === 'minor_change_candidate', drifted.verdict);

  const early = TP.strategyAuthoritySnapshot({ state,
    live: snap({ fuel_strategy: { avg_fuel_per_lap: 3.1, clean_laps_sampled: 1 } }) });
  ck('3クリーン周未満は判断保留', early.verdict === 'insufficient_evidence', early.verdict);

  const pitNow = TP.strategyAuthoritySnapshot({ state, live: snap({
    fuel_strategy: { avg_fuel_per_lap: 3.1, clean_laps_sampled: 4,
      pit_timing_authority: { available: true, decision: 'pit_now', selected_plan: 'A' } } }) });
  ck('pit now は Bridge の pit timing authority からだけ来る',
    pitNow.verdict === 'pit_now' && pitNow.pit_timing.source === 'bridge_pit_timing_authority',
    JSON.stringify(pitNow.pit_timing));
  ck('Team Plan 自身は pit now を作らない',
    TP.strategyAuthoritySnapshot({ state, live: snap({
      fuel_strategy: { avg_fuel_per_lap: 3.1, clean_laps_sampled: 4, pit_required: true, add_fuel_l: 30 } }) })
      .verdict !== 'pit_now');

  const comparison = TP.compareLiveEvidence({ state, live: onPlanLive, lang: 'ja' });
  const section = TP.buildHandoffTeamSection({ state, snapshot: onPlan, evidence: onPlan.measured });
  ck('実測発話と交代 packet が同じ snapshot id を名乗る',
    comparison.snapshot_id === onPlan.snapshot_id && section.snapshot_id === onPlan.snapshot_id,
    JSON.stringify({ c: comparison.snapshot_id, s: section.snapshot_id }));
  ck('交代 packet は同じ判定を運ぶ', section.authority_verdict === onPlan.verdict);
  ck('未確認候補は confirmed へ漏れない',
    TP.proposeFromEvidence({ state, comparison: TP.compareLiveEvidence({
      state, live: snap({ strategy_plan: { target_lap: 35 } }), lang: 'ja' }), now: NOW })
      .state.confirmed.fields.initial_pit_plan.value === state.confirmed.fields.initial_pit_plan.value);
  ck('候補があることは packet に事実として載る',
    TP.buildHandoffTeamSection({ state: TP.proposeFromEvidence({ state,
      comparison: TP.compareLiveEvidence({ state, live: snap({ strategy_plan: { target_lap: 35 } }), lang: 'ja' }),
      now: NOW }).state, snapshot: drifted }).candidate_pending === true);
  ck('3クリーン周は燃費と平均ラップを同じ有効周集合から使う',
    onPlan.measured.clean_laps_sampled === 4 && onPlan.measured.clean_fuel_burn_l === 3.1);
}

// ── F4 Chief Engineer Mode 導線 / 単独走行 ───────────────────────────
console.log('══ F4 renderer 実経路 ══');
{
  ck('relative-pace.js を読み込む', /<script src="relative-pace\.js"><\/script>/.test(html));
  ck('telemetry ごとに相対ペースを観測する', /observeRelativePace\(lastTelemetry\)/.test(html));
  ck('相対ペースの問いを燃料経路より前で受ける',
    html.indexOf('handleRelativePaceQuestion(text)') < html.indexOf('const localRouterAvailable'));
  ck('GAP訂正を受ける導線がある', /handleGapDispute\(text\)/.test(html));
  ck('保留状態を router へ渡す', /gapHeld:\(typeof currentGapHeld==='function'\?currentGapHeld\(\):null\)/.test(html));
  ck('交代 packet は authority snapshot から作る',
    /const snapshot=m\.strategyAuthoritySnapshot\(\{state,live:lastTelemetry\}\);[\s\S]{0,160}buildHandoffTeamSection\(\{state,snapshot/.test(html));
  ck('セッションが変われば標本と保留を捨てる', /relativePaceStore=null; gapHolds=null;/.test(html));

  // 本番関数を抽出して実挙動を見る
  const grab = name => {
    const i = html.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const rest = html.slice(i);
    const end = rest.slice(1).search(/\n(?:async function |function |const |let |\/\/ )/);
    return rest.slice(0, end > 0 ? end + 1 : rest.length);
  };
  const spoken = [];
  const traces = [];
  const box = {
    console, JSON, Number, String, Math, Date, RegExp, Object, Array,
    window: { PitwallRelativePace: RP, PitwallGapFreshness: GF },
    addMsg: () => {}, pushMsg: () => {},
    speak: text => spoken.push(text),
    diagnosticLog: (tag, body) => traces.push(tag + ' ' + body),
    SPEAK_PRIO: { P2_PROCEDURE: 2, P3_STRATEGY: 3, P4_INFO: 4 },
    isJapaneseEngineer: () => true,
    selMode: 'race', iracingLive: true,
    lastTelemetry: null, relativePaceStore: null, gapHolds: null
  };
  vm.createContext(box);
  vm.runInContext(['relativePaceModule', 'gapFreshnessModule', 'observeRelativePace',
    'handleRelativePaceQuestion', 'handleGapDispute', 'currentGapHeld']
    .map(grab).join('\n')
    + '\nconst GAP_DISPUTE_RE=' + (html.match(/const GAP_DISPUTE_RE=(\/[\s\S]*?\/i);/) || [])[1] + ';', box);

  // 3周ぶん流す
  [
    { own: 105.2, ahead: 104.2, behind: 106.4 },
    { own: 105.0, ahead: 104.0, behind: 106.6 },
    { own: 104.8, ahead: 104.4, behind: 106.2 }
  ].forEach((row, i) => {
    box.lastTelemetry = snap({
      lap: 10 + i, last: row.own,
      competitors: [
        { car_idx: 14, name: 'Ahead One', car_number: '14', class_pos: 2, gap_s: -2.4, lap: 10 + i, last_lap_s: row.ahead },
        { car_idx: 7, name: 'Behind One', car_number: '7', class_pos: 4, gap_s: 1.6, lap: 10 + i, last_lap_s: row.behind }
      ]
    });
    box.observeRelativePace(box.lastTelemetry);
  });
  ck('本番導線：標本が積まれる', !!box.relativePaceStore && Object.keys(box.relativePaceStore.cars).length === 2);
  ck('本番導線：相対ペースの問いを受ける', box.handleRelativePaceQuestion('後ろの方がペース速い？') === true);
  ck('本番導線：回答に燃料もピットも出ない',
    spoken.length === 1 && !/燃料|ピット|給油/.test(spoken[0]), spoken[0]);
  ck('本番導線：根拠を診断ログへ残す',
    traces.some(t => t.startsWith('RELATIVE_PACE') && /target_car_idx/.test(t) && /window_s/.test(t)),
    traces[0]);
  ck('本番導線：燃料の問いは相対ペースが飲み込まない',
    box.handleRelativePaceQuestion('燃料足りる？') === false);

  ck('本番導線：GAP訂正を受ける', box.handleGapDispute('後ろ、実際はもっと離れてる') === true);
  ck('本番導線：保留の発話に古い値を混ぜない',
    /未確認/.test(spoken[spoken.length - 1]) && !/1\.6/.test(spoken[spoken.length - 1]), spoken[spoken.length - 1]);
  ck('本番導線：ドライバーの数値を保存しない',
    traces.some(t => t.startsWith('GAP_DISPUTE') && /"stored_driver_number":false/.test(t)));
  ck('本番導線：保留中は held を router へ渡す', box.currentGapHeld().behind === true);
  box.lastTelemetry = snap({ gap_behind: 1.4,
    gap_authority: { behind: { generation: 12, target_car_idx: 7, direction: 'behind', session_key: '2', gap_s: 1.4 } } });
  ck('本番導線：再観測で保留が解ける', box.currentGapHeld().behind === false);

  // Chief 無効の単独走行は Team Plan 側の挙動（tests-team-plan.js ⑥-b）で担保。
  // ここでは相対ペースが Chief に依存せず、レース中だけ働くことを確認する。
  box.selMode = 'practice';
  ck('レースモード外では相対ペースを答えない',
    box.handleRelativePaceQuestion('後ろの方がペース速い？') === false);
}

console.log(`\n[phase F] 合格 ${pass} / 不合格 ${fail}`);
process.exit(fail ? 1 : 0);
