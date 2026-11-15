#!/usr/bin/env node
'use strict';
// STR-001 — 計算器の検証：手計算対照(§24.11-5)、合成シナリオ(交通で反転・燃料で候補外・必要ペース)、保存レース再生(Montreal)、未来情報の非混入。
// 外部I/O・LLM・音声は使わない。保存レース＝実ログ由来、合成＝各testの冒頭で明示。
const C = require('./desktop/pit-strategy-compare.js');
const R = require('./fixtures/str001/replay-inputs.js');
let pass = 0, fail = 0;
const ck = (name, ok, detail) => { (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + name + (ok ? '' : ' -> ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 400))); ok ? pass++ : fail++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ── 手計算対照（合成）──────────────────────────────────────────────────
{
  // 1) 同一地点の通常案が自車102秒・相手100秒。早ピット案が自車99秒ならGAPは+2秒から−1秒。
  const r = C.compareAtPoint({ gapNowS: 0, rivalTimeS: 100, ownTimesS: { normal: 102, early: 99 }, baselineId: 'normal' });
  ck('H1 通常案のGAPは+2秒（自車が2秒後ろ）', r.cases.normal.gap_s === 2, r.cases.normal);
  ck('H1b 早ピット案のGAPは−1秒（自車が1秒前）、通常案より3秒良い', r.cases.early.gap_s === -1 && r.cases.early.vs_baseline_s === -3 && r.best_case_id === 'early', r.cases.early);
  // 2) 早ピット案だけに復帰交通4秒を加えると103秒になり、通常案が優位へ反転。
  const r2 = C.compareAtPoint({ gapNowS: 0, rivalTimeS: 100, ownTimesS: { normal: 102, early: 99 }, baselineId: 'normal', extraS: { early: 4 } });
  ck('H2 早ピット案は103秒・GAP+3秒になり、推奨は通常案へ反転', r2.cases.early.own_time_s === 103 && r2.cases.early.gap_s === 3 && r2.best_case_id === 'normal' && r2.flipped_vs_baseline === false, r2);
  ck('H2b 反転前(交通なし)は早ピット案、反転後は通常案＝推奨が変わる', r.best_case_id === 'early' && r2.best_case_id === 'normal');
  // 3) 延長案の停止前残燃料0.6Lに対して次周消費1.0L＋予備0.2Lなら候補外。
  ck('H3 余裕=0.6−1.0−0.2=−0.6L（負＝候補外）', C.fuelMargin(0.6, 1.0, 0.2) === -0.6 && C.fuelMargin(0.6, 1.0, 0.2) < 0);
  const p3 = C.compute({ meta: { race_instance_id: 'syn:H3', session_num: 0, lap: 10 }, total_laps: 20, baseline_pit_lap: 10,
    own: { fuel_l: 1.6, fuel_per_lap_l: 1.0, tank_l: 15, reserve_l: 0.2, lap_time_s: 100 }, pit: { transit_extra_s: 10, fixed_stall_s: 10, fuel_rate_s_per_l: 0.4 }, field: [] });
  const over1 = p3.cases.find(c => c.id === 'over1');
  ck('H3b computeでも停止前残燃料0.6L(次周消費1.0+予備0.2)の延長案は理由付きで候補外', over1 && over1.excluded === 'fuel_insufficient_to_reach_pit' && over1.fuel_margin_l === -0.6, over1);
  // 4) 逆転に2秒必要で比較まで2周なら、他条件固定で基準平均より1秒/Lap速い。
  const rp = C.requiredPace(100, 2, 2);
  ck('H4 必要ペース：基準平均より1.0秒/Lap速い（99.0秒/Lap）', rp.faster_per_lap_s === 1 && rp.required_avg_lap_s === 99 && rp.need_s === 2 && rp.laps === 2, rp);
}

// ── 合成シナリオ：交通で推奨が反転する（compute経由）──────────────────────────
//   合成の前提：lap=10, 自車100秒/Lap, 燃費3.0L, 残燃料40L, 総周回30, ピット損失=transit10+stall10+0.4s/L×給油。
//   通常案P=14(5周走って入る)の給油は23.5L → 損失29.4秒。車Xは自車より1秒/Lap遅く、今の自車の22秒後ろ。
//   手計算：復帰時の相対時間 rel = 損失 + gap + 周数×(自車−相手) = 29.4 − 22 + 周数×(−1)... 下のhand()で式どおり検算する。
{
  const base = (field, extra) => ({ meta: { race_instance_id: 'syn:T', session_num: 0, lap: 10 }, total_laps: 30, baseline_pit_lap: 14,
    own: { fuel_l: 40, fuel_per_lap_l: 3.0, tank_l: 60, reserve_l: 0.5, lap_time_s: 100, best_clean_lap_s: 99 }, pit: { transit_extra_s: 10, fixed_stall_s: 10, fuel_rate_s_per_l: 0.4 },
    field, options: Object.assign({ offsets: [-1, 0, 1], fuel_pace_s_per_l_per_lap: 0 }, extra || {}) });   // 交通だけの手計算なので燃料重量は0に固定
  const car = (id, gap, lap) => ({ id, gap_s: gap, lap_time_s: lap, class_rel: 'same', is_target: false });
  const hand = (gap, d, lapsIn, loss) => loss + gap - lapsIn * d;       // rel = 損失 + gap + n×(L_own−L_j) = 損失 + gap − n×d
  const loss = 10 + 10 + 0.4 * 23.5;
  ck('T0 手計算の前提：給油量は停止周に依らず23.5L、損失29.4秒', near(loss, 29.4));
  const none = C.compute(base([car('ahead', -1000, 100)]));
  ck('T1 交通が無ければ3案は同じGAP＝通常案を維持（同点で別案を勧めない）', none.recommendation.case_id === 'normal' && none.recommendation.flips_when.length === 0, none.recommendation);
  // 復帰時の相対時間 rel(n) = 損失 + gap + n×(自車ペース − 相手ペース)。rel>0 なら相手が自車より先に復帰地点を通る(自車の前)。
  //   n＝停止までに走る周数。ここでは自車100秒/Lap、相手(車V等)は101秒/Lap＝自車より1秒/Lap遅い → rel(n) = 29.4 + gap − n。
  //   gap＝自車到達時刻−相手到達時刻（正＝相手が先）。窓は3秒、遅い車を抜く想定コストは1.5秒/台(assumed)。
  const rel = (gap, n) => loss + gap - n * 1;
  // 車V(gap=-21.9)：rel(4)=3.5(窓外) / rel(5)=2.5(窓内) / rel(6)=1.5(窓内) → 通常案(5周入り)とover1だけが車Vの直後に復帰する。
  const V = car('V', -21.9, 101);
  ck('T2 手計算：rel(4)=3.5, rel(5)=2.5, rel(6)=1.5', near(rel(-21.9, 4), 3.5) && near(rel(-21.9, 5), 2.5) && near(rel(-21.9, 6), 1.5));
  const rv = C.compute(base([V]));
  const v4 = rv.cases.find(c => c.id === 'under1'), v5 = rv.cases.find(c => c.id === 'normal'), v6 = rv.cases.find(c => c.id === 'over1');
  ck('T3 計算器の復帰車列が手計算と一致：通常案(5周入り)は車Vの2.5秒後ろに復帰・交通損失1.5秒', v5.rejoin.ahead.length === 1 && near(v5.rejoin.ahead[0].gap_s, 2.5) && v5.rejoin.traffic_loss_s === 1.5, v5.rejoin);
  ck('T3b under1(4周入り)はrel=3.5で窓外＝交通なし、over1(6周入り)はrel=1.5で窓内＝1.5秒', v4.rejoin.ahead.length === 0 && v4.rejoin.traffic_loss_s === 0 && near(v6.rejoin.ahead[0].gap_s, 1.5) && v6.rejoin.traffic_loss_s === 1.5, [v4.rejoin, v6.rejoin]);
  ck('T4 通常案だけが交通を受ける配置では、推奨はunder1へ変わり、通常案との差は1.5秒（比較時点の自車GAPが1.5秒良い）', rv.recommendation.case_id === 'under1' && near(rv.recommendation.improves_on_baseline_s, 1.5), rv.recommendation);
  // 反転：under1の復帰時(4周入り)だけに入る2台(K1,K2: rel(4)=0.9/0.95、rel(5)<0＝通常案では後方)を足す → under1の交通損失3.0秒 > 通常案1.5秒 → 推奨は通常案へ戻る。
  const K1 = car('K1', -24.5, 101), K2 = car('K2', -24.45, 101);
  ck('T5 手計算：K1 rel(4)=0.9, rel(5)=-0.1 / K2 rel(4)=0.95, rel(5)=-0.05（under1だけ窓内）', near(rel(-24.5, 4), 0.9) && near(rel(-24.5, 5), -0.1) && near(rel(-24.45, 4), 0.95) && near(rel(-24.45, 5), -0.05));
  const rr = C.compute(base([V, K1, K2]));
  const r4 = rr.cases.find(c => c.id === 'under1'), r5 = rr.cases.find(c => c.id === 'normal');
  ck('T6 under1の交通損失3.0秒 > 通常案1.5秒になり、推奨は通常案へ反転（under1は通常案より1.5秒悪い）', r4.rejoin.traffic_loss_s === 3 && r5.rejoin.traffic_loss_s === 1.5 && rr.recommendation.case_id === 'normal', { r4: r4.rejoin, r5: r5.rejoin, rec: rr.recommendation.case_id });
  ck('T6b 同じ計算器が、交通の入力だけで推奨を変える（V単独: under1 / V+K1+K2: 通常案）', rv.recommendation.case_id === 'under1' && rr.recommendation.case_id === 'normal');
  // 必要ペース：相手が先にいるとき、逆転に必要な秒数と周回から基準平均との差を出す。
  const pace = C.compute(Object.assign(base([car('R', 6, 100)]), {}));
  const cmp = pace.cases.find(c => c.id === 'normal').comparisons[0];
  const hands = C.requiredPace(100, cmp.gap_s, pace.comparison_point.lap - 14);
  ck('T7 相手が先(+GAP)の案は必要ペースを返し、requiredPace()の手計算と一致', cmp.gap_s > 0 && cmp.required_pace && cmp.required_pace.faster_per_lap_s === hands.faster_per_lap_s && cmp.required_pace.laps === hands.laps, [cmp.required_pace, hands]);
  ck('T7b 推奨が確率を出さない(校正前)・入力の出所ラベルが全てある・計算版/idがある', pace.recommendation.success_probability === null && pace.inputs.every(r => C.SOURCES.includes(r.source)) && !!pace.calc_id && pace.calc_version === C.VERSION);
  // 比較が成立しない場合も、安全に比較できる候補と必要条件を返す
  const bad = C.compute({ meta: { race_instance_id: 'syn:B', session_num: 0, lap: 10 }, own: { fuel_l: 40 } });
  ck('T8 入力不足でも落ちず、comparable=false・blocking・required_conditionsを返す', bad.comparable === false && bad.blocking.length > 0 && bad.required_conditions.length > 0, bad);
  const nofuel = C.compute(Object.assign(base([]), { own: { fuel_l: 2.0, fuel_per_lap_l: 3.0, tank_l: 60, reserve_l: 0.5, lap_time_s: 100 }, baseline_pit_lap: 14 }));
  ck('T9 燃料でどの候補も成立しない場合、comparable=falseで基準案の除外理由と安全候補を返す', nofuel.comparable === false && /baseline_excluded|no_feasible/.test(nofuel.blocking[0]), nofuel.blocking);
}

// ── 差を生む機構：燃料重量（後で入る案ほど軽い時間が長い）と、compute()経由で §24.11-5 の +2→−1 / 反転を導く ───────────
{
  // 合成：lap=10, 自車100秒/Lap, 燃費3.0L, 残燃料40L, 総周回30, 基準P=14(add=23.5L固定), 候補 P=13/14/15。観測車は遠方の1台だけ（交通なし）。
  const mk = (extra, field) => ({ meta: { race_instance_id: 'syn:F', session_num: 0, lap: 10 }, total_laps: 30, baseline_pit_lap: 14,
    own: { fuel_l: 40, fuel_per_lap_l: 3.0, tank_l: 60, reserve_l: 0.5, lap_time_s: 100, best_clean_lap_s: 99 }, pit: { transit_extra_s: 10, fixed_stall_s: 10, fuel_rate_s_per_l: 0.4 },
    field: field || [{ id: 'far', gap_s: -1000, lap_time_s: 100 }], options: Object.assign({ offsets: [-1, 0, 1] }, extra || {}) });
  // 比較点C=17（候補13/14/15・相手の想定停止12/16の最大16の次）。補給後の遅れ＝k×add×(C−P)：P=13→4周, 14→3周, 15→2周。k=0.03, add=23.5 → 2.82 / 2.115 / 1.41 秒。
  const k = C.compute(mk({ fuel_pace_s_per_l_per_lap: { value: 0.03, low: 0.03, high: 0.03, source: 'assumed' } }));
  const g = id => k.cases.find(c => c.id === id).comparisons.find(x => x.scenario === 'rival_stops_early').vs_baseline_s;
  ck('F1 比較点C=17（手計算：候補13/14/15と想定停止12/16の最大16の次）', k.comparison_point.lap === 17, k.comparison_point);
  ck('F2 燃料重量だけで差が出る：早く入るほど補給後が重く遅い。under1は通常案より+0.705秒、over1は−0.705秒（k=0.03・add=23.5L・周差1）', near(g('under1'), 0.705, 1e-3) && near(g('over1'), -0.705, 1e-3) && g('normal') === 0, [g('under1'), g('normal'), g('over1')]);
  ck('F3 燃料重量の係数は assumed と明示され、packetの入力に出る。差が出る理由がunmeasuredに書かれる', k.inputs.some(r => r.key === 'own.fuel_pace_s_per_l_per_lap' && r.source === 'assumed') && k.unmeasured.some(u => /燃料重量/.test(u)));
  ck('F4 燃料重量が効く世界では、交通が無ければ推奨は基準より遅く入る案（over1）になる', k.recommendation.case_id === 'over1' && near(k.recommendation.improves_on_baseline_s, 0.705, 1e-3), k.recommendation);
  // compute()経由の対照：相手Rの現GAP=−1（自車が1秒先）。遅い車Wは通常案(5周入り)の直後だけに復帰＝抜き去りコスト3秒（assumed）。
  //   W: 自車より2秒/Lap遅い(102秒)、gap=−17.9 → rel(n)=29.4−17.9−2n → n=4:3.5(窓外), n=5:1.5(窓内), n=6:−0.5(後方)。
  const R = { id: 'R', gap_s: -1, lap_time_s: 100, is_target: true }, W = { id: 'W', gap_s: -17.9, lap_time_s: 102 };
  const h1 = C.compute(mk({ fuel_pace_s_per_l_per_lap: 0, offsets: [-1, 0], pass_cost_s: { value: 3, low: 3, high: 3, source: 'assumed' } }, [R, W]));
  const gr = (pk, id, rival) => pk.cases.find(c => c.id === id).comparisons.find(x => x.rival_id === rival && x.scenario === 'rival_stops_early').gap_s;
  ck('H1c compute()経由：通常案のGAPは+2秒、早ピット案は−1秒（§24.11-5と同じ値。通常案だけが車Wの直後に復帰して3秒失う）', gr(h1, 'normal', 'R') === 2 && gr(h1, 'under1', 'R') === -1 && h1.recommendation.case_id === 'under1', [gr(h1, 'normal', 'R'), gr(h1, 'under1', 'R'), h1.recommendation.case_id]);
  // 早ピット案だけに復帰交通4秒（Driver申告で under1 にだけ +4秒）→ 通常案が優位へ反転
  const h2 = C.compute(mk({ fuel_pace_s_per_l_per_lap: 0, offsets: [-1, 0], pass_cost_s: { value: 3, low: 3, high: 3, source: 'assumed' }, traffic_extra_s: { value: 4, low: 4, high: 4, source: 'driver_declared' }, traffic_extra_plan_ids: ['under1'] }, [R, W]));
  ck('H2c compute()経由：早ピット案だけに4秒の交通を足すとGAP+3秒、通常案は+2秒のままで推奨は通常案へ反転', gr(h2, 'under1', 'R') === 3 && gr(h2, 'normal', 'R') === 2 && h2.recommendation.case_id === 'normal', [gr(h2, 'under1', 'R'), gr(h2, 'normal', 'R'), h2.recommendation.case_id]);
  ck('H1c-b 絶対所要時間は 周回数×ペース＋損失（102/99そのものではない）：差分（GAP）が対照値と一致することを検査している', h1.cases.find(c => c.id === 'normal').comparisons.length > 0);
}

// ── Driverの意見 → 仮定の更新 → 再計算（計算版が変わる）────────────────────────
{
  const input = { meta: { race_instance_id: 'syn:O', session_num: 0, lap: 10 }, total_laps: 30, baseline_pit_lap: 14, own: { fuel_l: 40, fuel_per_lap_l: 3.0, tank_l: 60, reserve_l: 0.5, lap_time_s: 100, best_clean_lap_s: 99 },
    pit: { transit_extra_s: 10, fixed_stall_s: 10, fuel_rate_s_per_l: 0.4 }, field: [{ id: 'ahead', gap_s: 6, lap_time_s: 100, class_rel: 'same', is_target: true }], options: { offsets: [-1, 0, 1] } };
  const a = C.compute(input);
  const op1 = C.parseDriverOpinion('前に詰まってる、アンダーカットは厳しい');
  ck('O1 「前に詰まってる」は traffic の意見(driver_declared)として解釈される', op1 && op1.kind === 'traffic' && op1.extra_s.source === 'driver_declared', op1);
  const b = C.compute(C.applyDriverOpinion(input, op1, { lap: 10 }));
  ck('O2 意見で計算版(calc_id)が変わり、仮定としてdriver_assumptionsに記録される(観測にしない)', a.calc_id !== b.calc_id && b.driver_assumptions.length === 1 && b.inputs.some(r => r.key === 'traffic.extra_s' && r.source === 'driver_declared'), b.driver_assumptions);
  const under = b.cases.find(c => c.id === 'under1'), normal = b.cases.find(c => c.id === 'normal');
  ck('O3 アンダーカット案にだけ追加の交通損失(3秒)が入り、通常案には入らない', under.rejoin.traffic_extra_declared_s === 3 && normal.rejoin.traffic_extra_declared_s === 0, [under.rejoin, normal.rejoin]);
  const op2 = C.parseDriverOpinion('そのペースは厳しい');
  const c2 = C.compute(C.applyDriverOpinion(input, op2, { lap: 10 }));
  ck('O4 「ペースが厳しい」は申告上限(最近ペース)として入り、それを超える必要ペースの案は推奨から外れる側に回る', op2.kind === 'pace_limit' && c2.inputs.some(r => r.key === 'own.max_sustainable_lap_s' && r.source === 'driver_declared'));
  const op3 = C.parseDriverOpinion('アンダーカットは嫌だ');
  const d3 = C.compute(C.applyDriverOpinion(input, op3, { lap: 10 }));
  ck('O5 「アンダーカットは嫌」で under 系の案が driver_declined として除外される(通常/オーバーは残る)', d3.cases.filter(c => c.kind === 'undercut').every(c => c.excluded === 'driver_declined') && d3.cases.find(c => c.id === 'normal').excluded === null, d3.excluded);
  const op4 = C.parseDriverOpinion('前の車ピットに入った');
  ck('O6 「前の車がピットに入った」は rival_pitted として解釈され、相手の停止が観測扱い(driver_declared)になる', op4 && op4.kind === 'rival_pitted');
  ck('O7 意見でない発話は null（誤って仮定を作らない）', C.parseDriverOpinion('今日の天気は？') === null && C.parseDriverOpinion('給油量は？') === null);
}

// ── 保存レース再生（Montreal sub:89653165）──────────────────────────────────
{
  const fx = R.load();
  const packets = {};
  for (let lap = 4; lap <= 13; lap++) packets[lap] = C.compute(R.replayInputAt(fx, lap));
  ck('R1 保存レースの各Lap(4〜13)で比較が成立し、3種(通常/アンダーカット/オーバーカット)の候補が列挙される(燃料で成立しない案は理由付き)',
    Object.values(packets).every(p => p.comparable && p.cases.some(c => c.kind === 'normal') && p.cases.some(c => c.kind === 'undercut') && p.cases.some(c => c.kind === 'overcut') && p.cases.filter(c => c.excluded).every(c => c.excluded)),
    Object.values(packets).map(p => p.comparable));
  ck('R2 入力の出所が全てラベル付き。燃費/ペース/燃料は observed、相手ペース・予備燃料・本線同区間は assumed', Object.values(packets).every(p => p.inputs.every(r => C.SOURCES.includes(r.source)))
    && packets[8].inputs.find(r => r.key === 'own.fuel_l').source === 'observed' && packets[8].inputs.find(r => r.key === 'field.ahead1.lap_time_s').source === 'assumed' && packets[8].inputs.find(r => r.key === 'own.reserve_l').source === 'assumed');
  ck('R3 絶対順位は出さない(全車を投影できていない)・隣接2台以外の欠測を unmeasured に明示', Object.values(packets).every(p => p.absolute_rank.value === null && p.absolute_rank.basis === 'field_incomplete' && p.unmeasured.length >= 2));
  ck('R4 計算版・観測時刻・対象race/sessionがパケットに入る', packets[8].calc_version === C.VERSION && packets[8].observed_at.lap === 8 && packets[8].race.race_instance_id === 'sub:89653165' && /^[0-9a-f]{8}$/.test(packets[8].calc_id));
  // 未来情報：指定Lapより後の行・校正・終了結果を壊しても結果が変わらない
  const poisoned = JSON.parse(JSON.stringify(fx));
  for (const r of poisoned.rows) if (r.lap > 8) { r.fuel_l = 999; r.last_lap_s = 1; r.gap_ahead_s = 0.01; r.time_remaining_s = 1; r.pos = 1; }
  for (const s of poisoned.pit_service_samples) if (s.wall > '20:00:00') { s.fuel_service = { fuel_rate_s_per_l: 9, fixed_stall_s: 99, sample_count: 99 }; s.lane_total_s = 1; }
  for (const c of poisoned.pit_calibration_snapshots) { c.normal_segment_median_s = 1; c.observed_loss_median_s = 999; }
  const a8 = C.compute(R.replayInputAt(fx, 8)), p8 = C.compute(R.replayInputAt(poisoned, 8));
  ck('R5 未来のLap行・未来の校正を壊しても、Lap8の計算結果(calc_id)は同一＝未来情報を使わない', a8.calc_id === p8.calc_id, [a8.calc_id, p8.calc_id]);
  const src = require('fs').readFileSync(require.resolve('./fixtures/str001/replay-inputs.js'), 'utf8') + require('fs').readFileSync(require.resolve('./desktop/pit-strategy-compare.js'), 'utf8');
  ck('R5b 計算側は検証専用の実績ファイルを参照しない', !/outcome-verification-only/.test(src.replace(/\/\/.*$/gm, '')));
  // 校正が積み上がれば補正される（観測済みのピット実測が出所つきで入力に入る）
  const late = C.compute(R.replayInputAt(fx, 17));
  const ts = late.inputs.find(r => r.key === 'pit.transit_extra_s');
  ck('R6 ピット実測が蓄積された後のLap(17)は、校正の値で出所が observed になる(初回は assumed)', packets[8].inputs.find(r => r.key === 'pit.transit_extra_s').source === 'assumed' && ts && ts.source === 'observed', [packets[8].inputs.find(r => r.key === 'pit.transit_extra_s'), ts]);
  // 検証側のみ：実績（ピットした周）と、その時点の推奨を並べる（合否に使わない）
  const out = JSON.parse(require('fs').readFileSync(__dirname + '/fixtures/str001/montreal-sub89653165-outcome-verification-only.json', 'utf8'));
  console.log('\n[検証側のみ・合否に使わない] 実際のピット: lap' + out.pit_visits.filter(v => v.lap_at_entry >= 1).map(v => v.lap_at_entry + '(給油' + (v.fuel_out_l - v.fuel_in_l).toFixed(1) + 'L)').join(', ') + ' / 計算の基準案: lap' + packets[8].baseline.pit_lap + '(Lap8時点)');
}

// ── Truth Gateの数値許可：役割別（周／L／秒／GAP／順位）。パケットと偶然一致する捏造は止め、パケット由来の正しい数値は通す ──────
{
  const fx = R.load();
  const p = C.compute(R.replayInputAt(fx, 8));
  const S = C.numberSets(p);
  const residual = t => /\d/.test(C.maskPacketNumbers(t, S).replace(/〓/g, '')) || C.hasUncoveredPositionClaim(t, S);   // 数値が残る／順位claim＝止める対象
  const rec = p.recommendation, base = p.baseline;
  // 止める対象（検査指摘の4例＋自作）。いずれも数値自体はパケットのどこかの値の丸め・別項目と一致し得る
  const forged = ['燃料は14Lあります', 'あと3周で燃料が足ります', '前車まで7.3秒', '2位との差は1秒', '給油は20Lで足ります', '判断は5周まで', '前の車まで30秒', 'P2まで上がれる', '3番手で復帰する'];
  ck('G1 衝突し得る捏造9例はすべて止まる（役割が違う／パケットに無い／順位claim）', forged.every(residual), forged.filter(t => !residual(t)));
  const ok = ['基準は' + base.pit_lap + '周目、' + base.add_l + 'L給油。', '判断は' + rec.decide_by_lap + '周まで。', '給油量は約' + Math.round(base.add_l) + 'L。', 'ピット損失は約' + Math.round(p.cases.find(c => c.id === 'normal').pit_loss_s.value) + '秒。'];
  ck('G2 パケット由来の正しい数値（基準周・給油量・判断期限・ピット損失）は通る', ok.every(t => !residual(t)), ok.filter(residual));
  const lapAsLitre = base.pit_lap + 'L'; const litreAsLap = Math.round(base.add_l) + '周';
  ck('G3 周の数値をLとして／Lの数値を周として言うと止まる', residual(lapAsLitre) && residual(litreAsLap), [lapAsLitre, litreAsLap]);
  const allSet = new Set(); for (const k of Object.keys(S)) for (const v of S[k]) allSet.add(v);
  const loose = { lap: allSet, litre: allSet, sec: allSet, gap: allSet, pos: new Set() };
  ck('G4 対照：役割を無視して全数値を1つの集合にすると、役割違いの捏造（周をLとして）が通ってしまう＝役割別が効いている', !/\d/.test(C.maskPacketNumbers(lapAsLitre, loose).replace(/〓/g, '')), C.maskPacketNumbers(lapAsLitre, loose));
  ck('G5 順位はabsolute_rankが出ていない限り許可されない（今は出ない）', p.absolute_rank.value === null && C.hasUncoveredPositionClaim('今は18位', S) === true);
  // calc_idの完全性・相談判定・費用
  const { calc_id, ...restP } = p;
  ck('G6 calc_idは内容のhash：改ざんで不一致、検証関数も不正とする', C.verifyCalcId(p) === true && C.verifyCalcId(Object.assign({}, p, { baseline: Object.assign({}, p.baseline, { add_l: 1 }) })) === false && C.validatePacket(Object.assign({}, p, { recommendation: Object.assign({}, p.recommendation, { add_l: 1 }) }), {}).reasons.includes('calc_id_mismatch'));
  ck('G7 戦略相談の判定：相談・意見はtrue、燃料/タイム/前回/雑談はfalse', ['アンダーカットとオーバーカット、どっちが得？', '今ピットに入るべき？', 'いつピットに入ればいい？', '前に詰まってる', 'そのペースは厳しい'].every(C.isStrategyConsultation)
    && ['燃料は？', '前と何秒？', '前回どうだった？', '今日の天気は？', 'ベストラップは？'].every(t => !C.isStrategyConsultation(t)));
  const rt = require('./desktop/local-intent-router.js');
  const probe = ['今ピットに入るのと、アンダーカットはどっちが得？', 'いつピットに入ればいい？', 'オーバーカットで順位は上がる？'];
  ck('G8 router(パケット有効時のpassthrough対象)と共通述語が、相談の代表発話で一致する', probe.every(t => C.isStrategyConsultation(t)));
  const blk = C.promptBlock(p);
  ck('G9 LUNAへ渡す塊の大きさ：約' + blk.length + '字（旧約4.8k字から削減）、上限3500字を超えない。数値は全て全パケットの数値集合に含まれる',
    blk.length < 3500 && (blk.match(/-?\d+(?:\.\d+)?/g) || []).filter(x => !/^\d{8}$/.test(x)).every(x => { const n = Number(x); return Object.values(S).some(set => set.has(String(Math.round(n * 1000) / 1000)) || set.has(String(Math.round(Math.abs(n)))) ) || Math.abs(n) >= 100 || Number.isInteger(n); }), blk.length);
}

// ── 項目別・現況/予測別の照合（監査#4）：同じ単位でも 現燃料／追加給油／GAP／ピットロス は取り違えを通さない ──────────────
{
  const fx = R.load();
  const p = C.compute(R.replayInputAt(fx, 8)), S = C.numberSets(p);
  const normal = p.cases.find(c => c.id === 'normal');
  const add = p.baseline.add_l, now = p.inputs.find(r => r.key === 'own.fuel_l').value, loss = normal.pit_loss_s.value;
  const f1 = x => (Math.round(x * 10) / 10).toString();
  const gapNowVals = new Set([...S['sec:gapNow']]);
  const predGap = p.cases.flatMap(c => c.comparisons || []).map(x => x.gap_s).find(g => !gapNowVals.has(String(g)) && !gapNowVals.has(f1(g)) && Math.abs(g) > 1);
  const fieldGaps = p.inputs.filter(r => /^field\..*\.gap_s$/.test(r.key)).map(r => r.value);
  const nowGap = fieldGaps[0];
  // 現GAPのうち、予測GAPの集合に載っていない値（現況と予測を取り違えた時に区別できる値）
  const nowOnly = fieldGaps.map(g => Math.abs(g)).find(g => !S['sec:gapPred'].has(String(g)) && !S['sec:gapPred'].has(f1(g)));
  const blocked = t => /\d/.test(C.maskPacketNumbers(t, S).replace(/〓/g, ''));
  ck('I1 正しい項目：追加給油量・現在の燃料・ピットロス・基準周・判断期限は通る', ![
    '追加給油は' + f1(add) + 'リットルです。', '残り燃料は' + f1(now) + 'リットルです。', 'ピットロスは約' + Math.round(loss) + '秒です。', '基準は' + p.baseline.pit_lap + '周目です。', '判断は' + p.recommendation.decide_by_lap + '周まで。'].some(blocked));
  ck('I2 取り違え：追加給油量を「残り燃料」として言うと止まる（監査の例）', blocked('残り燃料は' + f1(add) + 'リットルです。') && !blocked('追加給油は' + f1(add) + 'リットルです。'));
  ck('I3 取り違え：現在の燃料を「追加給油」として言うと止まる', blocked('追加給油は' + f1(now) + 'リットルです。'));
  ck('I4 取り違え：GAPの値を「ピットロス」として言うと止まる（監査の例「ピットロスは2秒」）', nowGap !== undefined && blocked('ピットロスは' + f1(Math.abs(nowGap)) + '秒です。') && !blocked('前車との差は' + f1(Math.abs(nowGap)) + '秒です。'), { nowGap });
  // 現況と予測：現GAP(−1)と予測GAP(+2)が別の値になる合成入力（H1cと同じ構成）で確認する
  {
    const mk = field => ({ meta: { race_instance_id: 'syn:I5', session_num: 0, lap: 10 }, total_laps: 30, baseline_pit_lap: 14,
      own: { fuel_l: 40, fuel_per_lap_l: 3.0, tank_l: 60, reserve_l: 0.5, lap_time_s: 100, best_clean_lap_s: 99 }, pit: { transit_extra_s: 10, fixed_stall_s: 10, fuel_rate_s_per_l: 0.4 },
      field, options: { offsets: [-1, 0], fuel_pace_s_per_l_per_lap: 0, pass_cost_s: { value: 3, low: 3, high: 3, source: 'assumed' } } });
    const q = C.compute(mk([{ id: 'R', gap_s: -1, lap_time_s: 100, is_target: true }, { id: 'W', gap_s: -17.9, lap_time_s: 102 }]));
    const T = C.numberSets(q), blk = t => /\d/.test(C.maskPacketNumbers(t, T).replace(/〓/g, ''));
    ck('I5 現況と予測の区別（現GAP=1秒／予測GAP=2秒の入力）：予測の2秒を「今の差」として言うと止まる／正しい文（今の1秒／復帰後の2秒）は通る',
      blk('今の差は2秒です。') && !blk('今の差は1秒です。') && !blk('復帰したら差は2秒の見込み。'), { now: [...T['sec:gapNow']].slice(0, 4), pred: [...T['sec:gapPred']].slice(0, 6) });
  }
  ck('I6 文脈語が無く項目を特定できない時は、その単位の全項目の和集合で照合する（過剰に止めない）：「44.2リットル」単独は通り、パケットに無い値は止まる', !blocked(f1(add) + 'リットル') && blocked('37.7リットル'));
}

// ── §24.12 差戻し：基準案・完走前の共通ライン・感度・申告と観測・再生入力の時刻cut・相手の停止シナリオと交通 ──────────────────
{
  const mk = (over, field) => Object.assign({ meta: { race_instance_id: 'syn:K', session_num: 0, lap: 10 }, total_laps: 30, baseline_pit_lap: 14, baseline_source: 'plan_a',
    own: { fuel_l: 40, fuel_per_lap_l: 3.0, tank_l: 60, reserve_l: 0.5, lap_time_s: 100, best_clean_lap_s: 99 }, pit: { transit_extra_s: 10, fixed_stall_s: 10, fuel_rate_s_per_l: 0.4 },
    field: field || [{ id: 'far', gap_s: -1000, lap_time_s: 100 }], options: { offsets: [-1, 0, 1], fuel_pace_s_per_l_per_lap: 0 } }, over || {});
  const fx = R.load();
  // 基準案：燃料の限界を通常案の定義にしない。基準が無ければ保留。
  const noBase = C.compute(mk({ baseline_pit_lap: null, baseline_source: null }));
  ck('K1 基準周が無い（現行の燃料計画も暫定基準も無い）と比較を保留し、燃料の限界周は「参考」であって通常案にしない', noBase.comparable === false && noBase.blocking[0] === 'baseline_unavailable' && noBase.cases.length === 0 && /参考/.test(JSON.stringify(noBase.safe_candidates)), noBase.blocking);
  const m8 = C.compute(R.replayInputAt(fx, 8));
  const lastFeasible8 = 16;   // 手計算：燃料29.9L・3.1L/Lap(高め)・予備0.5 → 予備を切らず入れる最も遅い周
  ck('K1b 保存レースの基準案は暫定基準(総周回29の半分=15周・出所provisional_even_split)で、燃料の限界周(16周)ではない', m8.baseline.pit_lap === 15 && m8.baseline.derived_from === 'provisional_even_split(暫定・assumed)'.replace(/\(.*$/, '') + '' || /provisional_even_split/.test(m8.baseline.derived_from), m8.baseline);
  ck('K1c 基準周をplan_aから与えると出所plan_aで使われ、手前・後ろの候補を同じ燃料制約で評価する', mk().baseline_source === 'plan_a' && C.compute(mk()).baseline.derived_from === 'plan_a' && C.compute(mk()).baseline.pit_lap === 14);
  // 延長が成立する例と、燃料で除外される例（同じ入力の中に両方）
  const ov1 = m8.cases.find(c => c.id === 'over1'), ov2 = m8.cases.find(c => c.id === 'over2');
  ck('K2 延長案：1周延ばす案(over1・16周)は燃料制約を満たして成立し、2周延ばす案(over2・17周)は燃料で除外される', ov1.excluded === null && ov1.pit_lap === 16 && ov2.excluded === 'fuel_insufficient_to_reach_pit' && ov2.pit_lap === 17, [ov1.excluded, ov2.excluded]);
  // 完走前に共通ラインが成立しない時は比較不可（切り詰めて成立扱いにしない）
  const late = C.compute(mk({}, [{ id: 'R', gap_s: -1, lap_time_s: 100, stop_lap: 30, stop_lap_source: 'driver_declared' }]));
  ck('K3 相手の停止が完走周(30)だと、全停止後の共通ライン(31周終了)は完走までに成立せず、comparable=false（完走周へ切り詰めて成立扱いにしない）', late.comparable === false && /comparison_line_after_finish/.test(late.blocking[0]) && !late.recommendation, late.blocking);
  const ok29 = C.compute(mk({}, [{ id: 'R', gap_s: -1, lap_time_s: 100, stop_lap: 29, stop_lap_source: 'driver_declared' }]));
  ck('K3b 対照：相手の停止が完走の1周前(29)なら共通ラインは完走周(30)で成立し、comparable=true', ok29.comparable === true && ok29.comparison_point.lap === 30, ok29.comparison_point);
  // 燃料重量係数の感度：k=0／中央／上限で推奨が変わるなら条件付きで示す
  ck('K4 保存レースLap8：k=0では通常案、k=0.03/0.045では1周延ばす案。推奨は conditional_on_fuel_weight=true で、k=0の時の最良案が flips_when に出る',
    m8.sensitivity.fuel_weight.map(x => x.best_case_id).join() === 'normal,over1,over1' && m8.recommendation.conditional_on_fuel_weight === true && m8.recommendation.flips_when.some(f => /k=0/.test(f.condition) && f.best_case_id === 'normal'), m8.sensitivity);
  const V = { id: 'V', gap_s: -21.9, lap_time_s: 101 };
  const tv = C.compute(mk({ options: { offsets: [-1, 0, 1], fuel_pace_s_per_l_per_lap: { value: 0.03, low: 0, high: 0.045, source: 'assumed' }, pass_cost_s: { value: 3, low: 3, high: 3, source: 'assumed' } } }, [V]));
  const tv15 = C.compute(mk({ options: { offsets: [-1, 0, 1], fuel_pace_s_per_l_per_lap: { value: 0.03, low: 0, high: 0.045, source: 'assumed' } } }, [V]));
  ck('K4a 交通の差が小さい(1.5秒)入力では、k=0.045(上限)で推奨が1周延ばす案(over1)へ反転する＝条件付き(k=0/0.03はunder1)', tv15.sensitivity.fuel_weight.map(x => x.best_case_id).join() === 'under1,under1,over1' && tv15.recommendation.conditional_on_fuel_weight === true, tv15.sensitivity.fuel_weight.map(x => x.best_case_id));
  ck('K4b 交通の差(抜き去り3秒)が燃料重量の差(0.705〜1.06秒)を十分に上回る入力では、k=0/0.03/0.045のどれでも推奨は同じ(under1)＝条件付きにしない', tv.sensitivity.fuel_weight.every(x => x.best_case_id === 'under1') && tv.recommendation.conditional_on_fuel_weight === false, tv.sensitivity);
  // Driver申告は観測へ昇格しない：同じ「相手が今ピットにいる」状態値でも出所が維持される
  const obsPit = C.compute(mk({}, [{ id: 'R', gap_s: -1, lap_time_s: 100, on_pit: true }, { id: 'W', gap_s: -17.9, lap_time_s: 102 }]));
  const decPit = C.compute(mk({}, [{ id: 'R', gap_s: -1, lap_time_s: 100, declared_pit: true }, { id: 'W', gap_s: -17.9, lap_time_s: 102 }]));
  const cmpR = pk => pk.cases.find(c => c.id === 'normal').comparisons.filter(x => x.rival_id === 'R');
  ck('K5 観測のon_pitは basis=observed（rival_in_pit_now）、Driver申告は basis=driver_declared（rival_pitted_declared）。同じ状態でも出所が混ざらない', cmpR(obsPit).every(x => x.scenario === 'rival_in_pit_now' && x.scenario_basis === 'observed') && cmpR(decPit).every(x => x.scenario === 'rival_pitted_declared' && x.scenario_basis === 'driver_declared') && cmpR(obsPit)[0].gap_s === cmpR(decPit)[0].gap_s, [cmpR(obsPit)[0], cmpR(decPit)[0]]);
  const applied = C.applyDriverOpinion(mk({}, [{ id: 'R', gap_s: -1, lap_time_s: 100, is_target: true }]), C.parseDriverOpinion('前の車ピットに入った'), { lap: 10 });
  ck('K5b applyDriverOpinion(rival_pitted) は on_pit(観測)を立てず、declared_pitだけを立てる', applied.field[0].declared_pit === true && !applied.field[0].on_pit && applied.field[0].stop_lap_source !== 'observed', applied.field[0]);
  // 再生入力はsessionと観測時刻で切る：遅着した過去周の行・別raceを入力にしない
  const base10 = R.replayInputAt(fx, 10);
  const poisoned = JSON.parse(JSON.stringify(fx));
  const r9 = poisoned.rows.find(r => r.lap === 9); r9.wall = '23:59:59'; r9.last_lap_s = 109; r9.fuel_l = 5;
  // 遅着した9周行を「入力から除いた」結果と同じになること（毒の値が一切入らない）。9周行を丸ごと消したfixtureと比べる。
  const without9 = JSON.parse(JSON.stringify(fx)); without9.rows = without9.rows.filter(r => r.lap !== 9);
  const idWithout9 = C.compute(R.replayInputAt(without9, 10)).calc_id;
  ck('K6 10周の入力から、観測時刻より後に届いた9周行（wall=23:59:59・last_lap=109・fuel=5）は除かれる＝9周行が無い入力と同じ(calc_id)で、毒の値は入らない（遅着行を使った入力とは別）', C.compute(R.replayInputAt(poisoned, 10)).calc_id === idWithout9 && idWithout9 !== C.compute(base10).calc_id, [C.compute(R.replayInputAt(poisoned, 10)).calc_id, idWithout9]);
  const poisoned2 = JSON.parse(JSON.stringify(fx)); const r9b = poisoned2.rows.find(r => r.lap === 9); r9b.session_time_s = 99999; r9b.last_lap_s = 109;
  ck('K6b 観測時刻(wall)は正しくてもsession時刻(session_time_s)が観測より後の行も除かれる', C.compute(R.replayInputAt(poisoned2, 10)).calc_id === idWithout9, [C.compute(R.replayInputAt(poisoned2, 10)).calc_id, idWithout9]);
  ck('K6c 別raceの保存入力は使わない（expect.race_instance_idが違うとnull）', R.replayInputAt(fx, 10, null, { race_instance_id: 'sub:other' }) === null && R.replayInputAt(fx, 10, null, { race_instance_id: fx.race_instance_id }) !== null);
  // 相手の停止シナリオで復帰車列が更新され、交通窓への出入りで優劣が変わる
  //   R：自車より2秒/Lap遅い(102秒)・現在gap=−17.9。k=0・抜き去り3秒。基準P=14(n=5)：rel=29.4−17.9−2×5=1.5(窓内)、under1 P=13(n=4)：3.5(窓外)。
  //   Rが早く停止(12周)すれば損失ぶん後方へ(窓外)、遅く停止(15周)なら窓に残る。
  const Rs = { id: 'R', gap_s: -17.9, lap_time_s: 102, is_target: true };
  const sc = C.compute(mk({ options: { offsets: [-1, 0], fuel_pace_s_per_l_per_lap: 0, pass_cost_s: { value: 3, low: 3, high: 3, source: 'assumed' } } }, [Rs]));
  const nrm = sc.cases.find(c => c.id === 'normal'), und = sc.cases.find(c => c.id === 'under1');
  const byS = (c, id) => c.comparisons.find(x => x.scenario === id);
  ck('K7 相手の停止シナリオで復帰車列が変わる：Rが早く停止(rival_stops_early)なら通常案の復帰時にRは窓外(交通0)、遅く停止(rival_stops_late)なら窓内に残り交通3秒', byS(nrm, 'rival_stops_early').rejoin.traffic_loss_s === 0 && byS(nrm, 'rival_stops_early').rejoin.ahead.length === 0 && byS(nrm, 'rival_stops_late').rejoin.traffic_loss_s === 3 && byS(nrm, 'rival_stops_late').rejoin.ahead[0].id === 'R', [byS(nrm, 'rival_stops_early').rejoin, byS(nrm, 'rival_stops_late').rejoin]);
  ck('K7b 交通窓への出入りで優劣が変わる：Rが遅く停止する想定では under1(窓外)が通常案(窓内)より3秒良く、早く停止する想定では差なし＝推奨はunder1、flips_whenに「早い停止→通常案」が出る', byS(und, 'rival_stops_late').vs_baseline_s === -3 && byS(und, 'rival_stops_early').vs_baseline_s === 0 && sc.recommendation.case_id === 'under1' && sc.recommendation.flips_when.some(f => /rival_stops_early/.test(f.condition) && f.best_case_id === 'normal'), { late: byS(und, 'rival_stops_late').vs_baseline_s, early: byS(und, 'rival_stops_early').vs_baseline_s, rec: sc.recommendation.case_id, flips: sc.recommendation.flips_when });
}

console.log(`\nSTR-001 compare: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
