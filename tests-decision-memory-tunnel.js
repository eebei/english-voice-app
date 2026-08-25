#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════
// スライス2（2026-08-25）— Decision ID の入口→出口。
//
// 正本 `GAP_AUTHORITY_AND_MEMORY_TUNNEL_IMPLEMENTATION_BRIEF.md` §5.1 / §6 / §9。
//
//   source/capture → authority → state/persistence → identity retrieval
//   → decision/consumer → radio/briefing output → outcome/scoring
//   → correction/delete/reset → proof
//
// 「保存した」「注入した」では合格にしない。**翌セッションの自発発話**または
// **条件付き Plan 採用**まで届くことを証明する。
//
// 外部有料APIは呼ばない。
// ══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const D = require('./desktop/decision-memory');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)('  ' + (ok ? '✅ ' : '❌ ') + label + (ok ? '' : ' -> ' + (detail || '')));
  ok ? pass++ : fail++;
}

const NOW = Date.parse('2026-08-25T12:00:00Z');
const YESTERDAY = Date.parse('2026-08-24T12:00:00Z');

const identity = (over) => Object.assign({
  userId: 'user-1', track: 'Okayama', car: 'Audi R8 LMS GT3',
  carClass: 'GT3', seriesId: 419, setupFingerprint: 'abc123', raceFormat: 'race',
}, over || {});

// ── Bridge が実際に broadcast する形（bridge.py の該当行と同じ形）──
const proposalEvent = (over) => ({
  type: 'radio', trigger: 'strategy_plan_decision',
  decision_id: 'snap-1:decision-lap:6', selected_plan: 'B',
  decision_plan: Object.assign({
    decision_id: 'snap-1:decision-lap:6', selected_plan: 'B',
    reason: 'undercut_window_open', decided_at_lap: 6,
    entry_class_position: 8, target_lap: 6, add_fuel_l: 34.0, set_fuel_l: 40.0,
    session_num: 2,
    conditions: { fuel_window_open: true, relative_pace_advantage_s: 0.4, rejoin_not_worse: true },
  }, (over && over.decision_plan) || {}),
});
const pitTimingEvent = (over) => Object.assign({
  type: 'pit_timing', decision_id: 'snap-1:decision-lap:6',
  pos_in: 8, pos_out: 12, pit_lane_sec: 41.2,
  strategy_option_score: {
    available: true, executed_plan: 'B', actual_entry_lap: 6, entry_lap_error: 0,
    planned_add_fuel_l: 34.0, actual_fuel_added_l: 34.1, fuel_add_error_l: 0.1,
  },
}, over || {});
const blendEvent = (over) => ({
  type: 'pit_cycle_outcome', decision_id: 'snap-1:decision-lap:6',
  outcome: Object.assign({
    physical_exit_position: 12, conditional_cycle_position: 5,
    post_cycle_actual_position: 4, condition_met: true, closed_reason: 'condition_met',
  }, (over && over.outcome) || {}),
});
const closureEvent = (over) => Object.assign({
  type: 'session_summary', is_race: true,
  active_decision_id: 'snap-1:decision-lap:6',
  finish_pos: 4, finish_pos_confirmed: true, total_laps: 20, incidents: 0,
}, over || {});

/** Bridge の4段を順に流す（本番の renderer が呼ぶのと同じ順序・同じ引数）。 */
function runFullCycle(opts) {
  const o = opts || {};
  let store = [];
  store = D.appendProposal(store, o.proposal || proposalEvent(), o.identity || identity(), YESTERDAY).store;
  if (o.skipExecution !== true) store = D.appendExecution(store, o.pit || pitTimingEvent(), YESTERDAY).store;
  if (o.skipBlend !== true) store = D.appendBlend(store, o.blend || blendEvent(), YESTERDAY).store;
  if (o.skipClosure !== true) store = D.appendClosure(store, o.closure || closureEvent(), YESTERDAY).store;
  return store;
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ① 入口→保存：4段が同じ Decision ID へ積まれる ══');
// ══════════════════════════════════════════════════════════════════
{
  const store = runFullCycle();
  check('記録は1件（4段が別レコードに散らない）', store.length === 1, String(store.length));
  const r = store[0];
  check('提案が入っている', r.proposal.selected_plan === 'B' && r.proposal.decided_at_lap === 6);
  check('実行が入っている', r.execution.actual_entry_lap === 6 && r.execution.pos_in === 8);
  check('blend が入っている', r.blend.post_cycle_actual_position === 4);
  check('終了が入っている', r.closure.finish_pos === 4 && r.status === D.STATUS_CLOSED);
  check('identity が Bridge 権威から入る', r.track === 'Okayama' && r.seriesId === 419);

  console.log('\n  [trace] 入口→保存');
  console.log('    proposal : lap=' + r.proposal.decided_at_lap + ' plan=' + r.proposal.selected_plan + ' from=P' + r.proposal.entry_class_position);
  console.log('    execution: entry_lap=' + r.execution.actual_entry_lap + ' P' + r.execution.pos_in + '->P' + r.execution.pos_out);
  console.log('    blend    : P' + r.blend.post_cycle_actual_position + ' condition_met=' + r.blend.condition_met);
  console.log('    outcome  : ' + r.outcome);
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ② 採点：閉じた enum・根拠が無ければ unknown ══');
// ══════════════════════════════════════════════════════════════════
{
  check('成功（P8→blend後P4）', runFullCycle()[0].outcome === D.OUTCOME_SUCCESS);

  const traffic = runFullCycle({ blend: blendEvent({ outcome: { post_cycle_actual_position: 12 } }) });
  check('traffic失敗（P8→P12）', traffic[0].outcome === D.OUTCOME_TRAFFIC, traffic[0].outcome);

  const fuel = runFullCycle({
    pit: pitTimingEvent({ strategy_option_score: Object.assign({}, pitTimingEvent().strategy_option_score, { fuel_add_error_l: -2.5 }) }),
    blend: blendEvent({ outcome: { post_cycle_actual_position: 12 } }),
  });
  check('fuel失敗（計画より積まずに順位低下）', fuel[0].outcome === D.OUTCOME_FUEL, fuel[0].outcome);

  const notExec = runFullCycle({ skipExecution: true, skipBlend: true });
  check('未実行（提案したが入らずセッション終了）', notExec[0].outcome === D.OUTCOME_NOT_EXECUTED, notExec[0].outcome);

  const incident = runFullCycle({ closure: closureEvent({ closure_reason: 'disconnect' }) });
  check('切断（事故・切断は失敗として数えない）', incident[0].outcome === D.OUTCOME_INCIDENT, incident[0].outcome);

  const partial = runFullCycle({ blend: blendEvent({ outcome: { condition_met: false } }) });
  check('★条件が起きていない予測は採点しない（unknown）',
    partial[0].outcome === D.OUTCOME_UNKNOWN, partial[0].outcome);

  const held = runFullCycle({ blend: blendEvent({ outcome: { post_cycle_actual_position: 8 } }) });
  check('★同順位維持は success と断定しない（unknown）',
    held[0].outcome === D.OUTCOME_UNKNOWN, held[0].outcome);

  const noBlend = runFullCycle({ skipBlend: true });
  check('blend が無ければ採点しない', noBlend[0].outcome === D.OUTCOME_UNKNOWN, noBlend[0].outcome);

  check('outcome は必ず閉じた集合の中',
    [runFullCycle(), traffic, fuel, notExec, incident, partial, held, noBlend]
      .every(s => D.OUTCOMES.indexOf(s[0].outcome) >= 0));
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ③ 正本 §6-1 成功：翌日の自発発話 → 条件成立で Plan 採用 ══');
// ══════════════════════════════════════════════════════════════════
{
  const store = runFullCycle();
  const sel = D.selectForBriefing(store, identity(), NOW);
  check('翌日、同一条件で1件選ばれる', sel.available === true);
  const line = D.briefingLine(sel, 'ja');
  check('★自分から前回の判断と結果を述べる', line.includes('P8') && line.includes('6周目') && line.includes('P4'), line);
  check('北極星の骨格になっている', /アンダーカット/.test(line), line);

  const metAll = D.planAdvice(sel, { fuelWindowOpen: true, relativePaceAdvantageS: 0.4, rejoinNotWorse: true }, 'ja');
  check('★今日の条件が揃えば Plan 根拠へ採用', metAll.action === 'adopt' && metAll.fate === D.FATE_SPOKEN, metAll.action);

  const notMet = D.planAdvice(sel, { fuelWindowOpen: false, relativePaceAdvantageS: 0.4, rejoinNotWorse: true }, 'ja');
  check('★条件が揃わなければ過去の成功を保証として話さない',
    notMet.action === 'none' && notMet.fate === D.FATE_NOT_APPLICABLE && notMet.reply === '', notMet.fate);

  const noRejoin = D.planAdvice(sel, { fuelWindowOpen: true, relativePaceAdvantageS: 0.4, rejoinNotWorse: null }, 'ja');
  check('rejoin 未証明でも採用しない（null を満たしたと扱わない）',
    noRejoin.action === 'none', noRejoin.action);

  console.log('\n  [trace] 保存 → 翌日取得 → 発話 → Plan採用');
  console.log('    spoken : ' + line);
  console.log('    advice : action=' + metAll.action + ' fate=' + metAll.fate);
  console.log('             ' + metAll.reply);
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ④ 正本 §6-2 失敗：同条件では非推奨・条件が変われば再評価 ══');
// ══════════════════════════════════════════════════════════════════
{
  const store = runFullCycle({ blend: blendEvent({ outcome: { post_cycle_actual_position: 12 } }) });
  const sel = D.selectForBriefing(store, identity(), NOW);
  check('失敗例も翌日の候補になる（成功だけを使わない）', sel.available === true);
  const line = D.briefingLine(sel, 'ja');
  check('★失敗を成功のように勧めない', /勧めない/.test(line), line);
  check('失敗の事実（P8→P12）を述べる', line.includes('P8') && line.includes('P12'), line);

  const same = D.planAdvice(sel, { fuelWindowOpen: true, relativePaceAdvantageS: 0.4, rejoinNotWorse: false }, 'ja');
  check('★同条件なら非推奨', same.action === 'discourage', same.action);

  const changed = D.planAdvice(sel, { fuelWindowOpen: true, relativePaceAdvantageS: 0.4, rejoinNotWorse: true }, 'ja');
  check('★復帰先が空けば再評価（失敗記録で永久に封じない）', changed.action === 're_evaluate', changed.action);

  console.log('\n  [trace] 失敗の再利用');
  console.log('    spoken     : ' + line);
  console.log('    same cond  : ' + same.action + ' / ' + same.reply);
  console.log('    changed    : ' + changed.action + ' / ' + changed.reply);
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ⑤ 正本 §6-3 訂正：即 disputed → 読み返し → 合意後だけ再利用 ══');
// ══════════════════════════════════════════════════════════════════
{
  let store = runFullCycle();
  const id = store[0].decision_id;
  check('訂正前は使える', D.selectForBriefing(store, identity(), NOW).available === true);

  const disputed = D.dispute(store, id, 'pit lap が違う', NOW);
  store = disputed.store;
  check('★「それ違う」で即 disputed', store[0].status === D.STATUS_DISPUTED);
  check('★disputed は即座に利用停止（次回発話に出ない）',
    D.selectForBriefing(store, identity(), NOW).available === false);

  const readback = D.readbackLine(disputed.record, 'ja');
  check('★一度だけ読み返して確認する', /6周目/.test(readback) && /合っている/.test(readback), readback);

  const corrected = D.confirmCorrection(store, id, { actual_entry_lap: 7 }, NOW);
  store = corrected.store;
  check('本人合意後だけ訂正が効く', corrected.reason === 'corrected' && store[0].status === D.STATUS_CORRECTED);
  check('訂正値が入る', store[0].execution.actual_entry_lap === 7);
  check('★訂正後は再び使える', D.selectForBriefing(store, identity(), NOW).available === true);

  // 合意していない訂正は効かない
  const noConsent = D.confirmCorrection(runFullCycle(), id, { actual_entry_lap: 7 }, NOW);
  check('★disputed でない記録は訂正できない（勝手に書き換えない）',
    noConsent.reason === 'not_disputed', noConsent.reason);

  const noTarget = D.dispute(store, 'no-such-id', null, NOW);
  check('特定できない訂正は保存しない', noTarget.record === null && noTarget.reason === 'decision_not_found');
  check('特定できない時の読み返しは推測しない',
    /特定できない/.test(D.readbackLine(null, 'ja')) === false && D.readbackLine(null, 'ja') === '');

  console.log('\n  [trace] 訂正');
  console.log('    readback : ' + readback);
  console.log('    status   : ' + store[0].status + ' entry_lap=' + store[0].execution.actual_entry_lap);
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ⑥ 正本 §6-5 拒否：別条件・古い・未来・削除では使わない ══');
// ══════════════════════════════════════════════════════════════════
{
  const store = runFullCycle();
  const nope = (over, label) => check(label,
    D.selectForBriefing(store, identity(over), NOW).available === false,
    JSON.stringify(over));
  nope({ track: 'Monza' }, '別コースでは使わない');
  nope({ car: 'BMW M4 GT3', carClass: 'BMW M4 GT3' }, '別車種では使わない');
  nope({ seriesId: 999 }, '別シリーズでは使わない');
  nope({ userId: 'user-2' }, '★別ユーザーでは使わない');
  nope({ raceFormat: 'practice' }, '別 race format では使わない');
  nope({ track: '' }, 'コース未確定では使わない');

  const old = runFullCycle();
  old[0].updatedAt = new Date(NOW - 91 * 24 * 3600 * 1000).toISOString();
  check('90日超過は使わない', D.selectForBriefing(old, identity(), NOW).available === false);

  const future = runFullCycle();
  future[0].updatedAt = new Date(NOW + 24 * 3600 * 1000).toISOString();
  check('未来日時の cache は使わない', D.selectForBriefing(future, identity(), NOW).available === false);

  const removed = D.remove(runFullCycle(), 'snap-1:decision-lap:6', NOW);
  check('削除済みは使わない', D.selectForBriefing(removed.store, identity(), NOW).available === false);
  check('削除は store から消える', removed.store.length === 0);

  const unknownOnly = runFullCycle({ blend: blendEvent({ outcome: { condition_met: false } }) });
  const selUnknown = D.selectForBriefing(unknownOnly, identity(), NOW);
  check('★根拠不足(unknown)は発話に使わない', selUnknown.available === false, selUnknown.reason);
  check('黙った理由が残る', selUnknown.reason === D.FATE_MISSING, selUnknown.reason);
  check('記録ゼロと根拠不足を区別する',
    D.selectForBriefing([], identity(), NOW).reason === 'no_matching_record');
  check('★使えない時は文を作らない（捏造しない）', D.briefingLine(selUnknown, 'ja') === '');
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ⑦ 正本 §6-6 一本の trace：Bridge入力→採点→翌日出力 ══');
// ══════════════════════════════════════════════════════════════════
{
  const store = runFullCycle();
  const sel = D.selectForBriefing(store, identity(), NOW);
  const advice = D.planAdvice(sel, { fuelWindowOpen: true, relativePaceAdvantageS: 0.4, rejoinNotWorse: true }, 'ja');
  const r = store[0];
  console.log('  bridge_proposal  : id=' + r.decision_id + ' plan=' + r.proposal.selected_plan + ' lap=' + r.proposal.decided_at_lap);
  console.log('  bridge_pit_exit  : P' + r.execution.pos_in + '->P' + r.execution.pos_out + ' fuel_err=' + r.execution.fuel_add_error_l);
  console.log('  bridge_blend     : P' + r.blend.post_cycle_actual_position + ' condition_met=' + r.blend.condition_met);
  console.log('  bridge_closure   : finish=P' + r.closure.finish_pos + ' status=' + r.status);
  console.log('  scored           : ' + r.outcome);
  console.log('  next_retrieved   : ' + r.date + '@' + r.track);
  console.log('  next_spoken      : ' + D.briefingLine(sel, 'ja'));
  console.log('  plan_adoption    : ' + advice.action + ' (' + advice.fate + ')');
  check('★一本の trace が入口から出口まで欠けなく通る',
    !!r.proposal && !!r.execution && !!r.blend && !!r.closure
    && r.outcome === D.OUTCOME_SUCCESS && sel.available && advice.action === 'adopt');
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ⑧ 権威：LLM は record も数字も選ばない ══');
// ══════════════════════════════════════════════════════════════════
{
  const bad = D.appendProposal([], { type: 'radio', trigger: 'strategy_plan_decision' }, identity(), NOW);
  check('Bridge の decision_plan が無ければ開かない', bad.record === null && bad.reason === 'missing_decision_evidence');
  const orphanPit = D.appendExecution([], pitTimingEvent(), NOW);
  check('提案の無い pit exit は台帳へ入らない', orphanPit.record === null && orphanPit.reason === 'no_open_decision');
  const orphanBlend = D.appendBlend([], blendEvent(), NOW);
  check('提案の無い blend は台帳へ入らない', orphanBlend.record === null);
  const orphanClose = D.appendClosure([], closureEvent(), NOW);
  check('提案の無い session 終了は台帳へ入らない', orphanClose.record === null);

  const dup = D.appendProposal(runFullCycle(), proposalEvent(), identity(), NOW);
  check('同じ decision_id を二重に開かない', dup.reason === 'already_open' && dup.store.length === 1);

  const src = fs.readFileSync(path.join(__dirname, 'desktop/decision-memory.js'), 'utf8');
  check('決定論層が LLM を呼ばない', !/fetch\(|anthropic|\/api\/chat/i.test(src));
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ⑨ 配線：出口が外れていないこと ══');
// ══════════════════════════════════════════════════════════════════
{
  // ★コメントアウトされた配線を「繋がっている証拠」と誤認しない。
  //   Build 277 で自分が指摘した型（`tests-five-day-access.js` と同じ規約）。
  const stripLineComments = t => t.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const renderer = stripLineComments(
    fs.readFileSync(path.join(__dirname, 'desktop/renderer.html'), 'utf8'));
  check('renderer が module を読み込む（＝package 検査対象になる）',
    /<script src="decision-memory\.js"><\/script>/.test(renderer));
  check('提案を保存する', /trigger==='strategy_plan_decision'\) recordDecisionStage\('proposal'/.test(renderer));
  check('★提案の保存が injectRadio の早期returnに巻き込まれない',
    renderer.indexOf("recordDecisionStage('proposal'") < renderer.indexOf("if(data.type==='radio') injectRadio(data)"));
  check('pit exit を保存する', /recordDecisionStage\('execution',data\)/.test(renderer));
  check('blend を保存する', /pit_cycle_outcome'\) recordDecisionStage\('blend',data\)/.test(renderer));
  check('★session終了（DNF・途中終了含む）を保存する', /recordDecisionStage\('closure',data\)/.test(renderer));
  check('★次回ブリーフィングで queue へ直接入れる（LLM任せにしない）',
    /kind:'decision_strategy_briefing'/.test(renderer));
  check('★条件付き Plan 採用も queue へ入れる', /kind:'decision_plan_advice'/.test(renderer));
  check('LLM に数字を言い直させない', /周回・順位・Plan名を言い直すな/.test(renderer));
  check('★「それ違う」が LLM ではなく台帳を止める', /disputeLatestDecision\(_lang\)/.test(renderer));
  check('合意で訂正が有効化される', /confirmDecisionCorrection\(\{\},_lang\)/.test(renderer));
  check('fate が trace に残る', /DECISION_BRIEFING','available=/.test(renderer));

  const bridge = fs.readFileSync(path.join(__dirname, 'irsdk-bridge/bridge.py'), 'utf8');
  check('Bridge が pit exit に結合キーを載せる',
    /'decision_id': active_decision_id,\n\s+'decision_plan': active_decision_plan,\n\s+'pos_in'/.test(bridge));
  check('Bridge が blend に結合キーを載せる',
    /'pit_cycle_outcome',\n\s+'decision_id': active_decision_id/.test(bridge));
  check('Bridge が session 終了に結合キーを載せる',
    (bridge.match(/'active_decision_id': active_decision_id,/g) || []).length >= 2);
  check('★結合キーが両リセット経路で消える（Build 281 P1-2 の教訓）',
    /active_decision_id = _sig_reset\['active_decision_id'\]/.test(bridge)
    && /active_decision_id = _reset\['active_decision_id'\]/.test(bridge));
  check('結合キーが共通リセット辞書にある', /'active_decision_id': None,/.test(bridge));
}

console.log(`\nDecision memory tunnel: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
