#!/usr/bin/env node
'use strict';
// U2/U3 — undercut-forecast の検査。
//   A. 手計算対照（合成。数式を紙で解いた値と一致するか）
//   B. 交通：観測/推測位置/見えていない車を区別し、見えていない車がいる区間を「空いている」と言わない
//   C. 鈴鹿決勝の実U1ログ再生（50台の名簿に対し同時に見える車は最大21台）
//   D. 富士VRS GT Sprint（Driver報告に基づく再現用の仮定＝合成）：待つと逆転されるケース／早く入ると交通で損をするケース
//   E. 未来情報・別session・欠測の拒否
const fs = require('fs');
const F = require('./desktop/field-snapshot.js');
const U = require('./desktop/undercut-forecast.js');
const Fuji = require('./fixtures/u2/fuji-gt-sprint-synthetic.js');
let pass = 0, fail = 0, skipped = 0;
const ck = (name, ok, detail) => { (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + name + (ok ? '' : ' -> ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 600))); ok ? pass++ : fail++; };
// 節ごとに例外を捕まえる：変異や不具合で例外になっても、❌(節名＋例外)として赤くなり、他の節の検査は続く
const SEC = async (name, fn) => { try { await fn(); } catch (e) { fail++; console.error('❌ ' + name + ' 例外 -> ' + String((e && e.stack) || e).split('\n').slice(0, 2).join(' | ').slice(0, 300)); } };
const near = (a, b, e = 0.02) => typeof a === 'number' && Math.abs(a - b) <= e;

// ── 合成U1標本（本物の検証 F.check を通す）─────────────────────────────────
let seq = 0;
function snap({ t, cars, own = 0, race = 'sub:SYN', session = 2 }) {
  const rows = cars.map(c => c.st === 'out' || c.gone
    ? { i: c.i, no: c.no || String(c.i), c: c.c || 1, r: 'car', p: null, cp: null, l: null, lc: null, d: null, f2: null, est: null, ll: null, pit: null, s: -1, st: 'out' }
    : { i: c.i, no: c.no || String(c.i), c: c.c || 1, r: 'car', p: c.p ?? null, cp: null, l: Math.floor(c.prog), lc: Math.floor(c.prog) - 1, d: Math.round((c.prog - Math.floor(c.prog)) * 1e5) / 1e5, f2: 0, est: 0, ll: c.ll ?? null, pit: c.pit ? 1 : 0, s: c.pit ? 1 : 3, st: 'ok' });
  const ob = rows.filter(r => r.st === 'ok').length;
  const s = { type: 'field_snapshot', schema_version: 1, seq: ++seq, race_instance_id: race, session_num: session, bridge_process_epoch: 'e1', source_frame_sequence: seq, session_time_s: t, observed_at: 1.8e9 + t,
    player_car_idx: own, roster_session_num: session, roster_update: 1, generation: 1, gen: 'consistent', ok: true, sample_interval_s: 1.0,
    counts: { target: rows.length, observed: ob, departed: rows.length - ob, missing: 0, other: 0 }, events: [], cars: rows };
  const why = F.check(s); if (why) throw new Error('synthetic snapshot invalid: ' + why);
  return s;
}
const baseInput = (tracker, s, extra) => Object.assign({ meta: { race_instance_id: s.race_instance_id, session_num: s.session_num },
  own: { fuel_l: 30, fuel_per_lap_l: 3, tank_l: 53, reserve_l: 0.5, lap_time_s: { value: 100, source: 'observed' } }, total_laps: { value: 20, low: 20, high: 20, source: 'assumed' },
  pit: { transit_extra_s: 12, fixed_stall_s: 10, fuel_rate_s_per_l: 0.4 }, snapshot: s, tracker, options: { fuel_pace_s_per_l_per_lap: 0 } }, extra || {});
const optById = (sec, id) => sec.options.find(o => o.id === id);
const vs = (o, rival, scen) => o.vs_rivals.find(v => v.rival_id === rival && v.scenario === scen);

(async () => {
  await SEC('R-U2-6 finish boundary', async () => {
    function run(lap, total, override, rivalLap=lap, pit=false) {
      const tr=U.createTracker();
      const s=snap({t:500,cars:[{i:0,prog:lap+0.5,ll:100},{i:1,prog:rivalLap+0.45,ll:100,pit}]});
      tr.update(s);
      return U.compute(baseInput(tr,s,{total_laps:total, options:{rival_stops:override?{1:override}:{},
        rival_ids:[1], fuel_pace_s_per_l_per_lap:0}}));
    }
    const total={value:30,low:30,high:30};
    const nearFinish=run(29,total);
    ck('UR1 29周目の次周停止は除外、今周の停止比較は30周まで', nearFinish.rivals[0].excluded_scenarios.some(x=>x.id==='pits_next' && x.excluded==='rival_stop_not_before_finish')
      && nearFinish.options.some(o=>o.vs_rivals.some(x=>x.scenario==='pits_now' && x.common_point_lap===30)), nearFinish.rivals);
    const cases=[nearFinish];
    for (const [lap,stop,source] of [[29,30,'driver_declared'],[20,30,'driver_declared'],[29,31,'driver_declared'],[29,30,'observed']]) {
      const u=run(lap,total,{lap:stop,source}); cases.push(u);
      ck('UR2 '+source+' '+lap+'→'+stop+' は全案から除外される', u.rivals[0].scenarios.length===0
        && u.rivals[0].excluded_scenarios.some(x=>x.basis===source && x.stop_lap===stop && x.excluded==='rival_stop_not_before_finish')
        && u.options.every(o=>o.vs_rivals.length===0), u.rivals);
    }
    const observed=run(29,total,null,30,true); cases.push(observed);
    ck('UR3 相手が実際にピットレーンにいる場合も相手自身の周を検査する', observed.rivals[0].excluded_scenarios.some(x=>x.id==='in_pit_now' && x.stop_lap===30 && x.excluded==='rival_stop_not_before_finish'), observed.rivals);
    const past=run(28,total,{lap:27,source:'driver_declared'});
    ck('UR7 過去の相手停止は候補にならず除外理由を返す', past.rivals[0].excluded_scenarios.some(x=>x.stop_lap===27 && x.excluded==='rival_stop_already_passed')
      && past.options.every(o=>o.vs_rivals.every(x=>x.rival_stop_lap!==27)),past.rivals);
    const inside=run(28,total); cases.push(inside);
    ck('UR4 28周目→29周停止、共通地点30周は成立する', inside.options.some(o=>o.vs_rivals.some(x=>x.scenario==='pits_next' && x.rival_stop_lap===29 && x.common_point_lap===30)), inside.rivals);
    const timed=run(28,{value:30,low:29,high:31}); cases.push(timed);
    ck('UR5 時間制は下限29周を使い、中央値より前の29周停止でも除外', timed.rivals[0].excluded_scenarios.some(x=>x.id==='pits_next' && x.stop_lap===29 && x.excluded==='rival_stop_not_before_finish'), timed.rivals);
    ck('UR6 全案・全想定の共通地点が完走上限以内', cases.every(u=>u.options.every(o=>
      (o.common_point_lap_all_options ?? 0)<=u.finish_lap_range.high && o.vs_rivals.every(x=>x.common_point_lap<=u.finish_lap_range.high))), null);
  });
  await SEC('blend and course of action', async () => {
    function run({focus, fuel=20, missing=false, trafficTiming=false, currentDeadline=false}={}) {
      const tr=U.createTracker();
      const s=snap({t:500,cars:[{i:0,prog:5.5,ll:100},{i:1,prog:5.35,ll:100},
        missing?{i:2,st:'out'}:{i:2,prog:5.08,ll:100}]});
      tr.update(s);
      // 20s pit loss. Early blend at t=70; normal blend at t=170.
      // At either blend #1 is +0.05 laps, #2 is −0.22 laps.
      return U.compute(baseInput(tr,s,{own:{fuel_l:fuel,fuel_per_lap_l:3,tank_l:53,reserve_l:0.5,lap_time_s:100},
        pit:{transit_extra_s:12,fixed_stall_s:8,fuel_rate_s_per_l:0},total_laps:15,
        options:{normal_pit_lap:currentDeadline?5:6,normal_source:currentDeadline?'plan_a':null,focus,fuel_pace_s_per_l_per_lap:0,rival_stops:{1:{lap:7,source:'driver_declared'}},
          ...(trafficTiming?{traffic_extra_s:2,traffic_extra_option_ids:['now']}: {})}}));
    }
    const u=run();
    for(const [id,at] of [['now',70],['next',170]]) {
      const r=optById(u,id).rejoin;
      ck('BL '+id+' t='+at+'s、前5秒（負）・後22秒（正）。交通窓の外でも出す', near(r.at_s,at)
        && near(r.blend_gap.ahead?.signed_gap_s,-5) && near(r.blend_gap.behind?.signed_gap_s,22)
        && r.ahead.length===0 && r.behind.length===0,r);
    }
    const reply=U.consultationReply(u,true);
    ck('BL 比較の返答は通常と今周の合流予測を両方話す', (reply.match(/前車まで約5秒、後続まで約22秒/g)||[]).length===2, reply);
    const m=run({focus:{kind:'normal'},missing:true}), mr=U.consultationReply(m,true);
    ck('BL 片側欠測は前5秒を保持し後方を不明とし、次の行動を返す', m.focus.option_id==='next' && /前車まで約5秒、後方は算出できず/.test(mr)
      && /見直そう|確認しよう/.test(mr) && m.action.gain==='unknown', mr);
    const noGain=run({trafficTiming:true});
    ck('ACT 利得が出ない場合はその根拠と再判断時期を返す', noGain.action.gain==='no_early_benefit'
      && /利得は出ていない/.test(U.consultationReply(noGain,true)),noGain.action);
    const due=run({fuel:40,currentDeadline:true});
    // 40 L covers next lap and the finish, but the adopted plan is due this lap.
    ck('ACT 今周がPlan A期限なら燃料に余裕があっても次周まで待たせない',
      due.action.kind==='verify_now' && !/あと1周/.test(U.consultationReply(due,true)),due.action);
    const free=run({fuel:40});
    ck('ACT 燃料上の無停止完走と順位を狙う比較を明示する', /燃料上は停止なしで完走.*順位を狙う/.test(U.consultationReply(free,true)),free.action);
    const tight=run({fuel:3,focus:{kind:'next'}}), tightReply=U.consultationReply(tight,true);
    ck('ACT 3Lでは今は届くが次周は届かない。今周案と期限を出し、待たせない', tight.action.kind==='review_feasible_stop'
      && tight.focus.excluded==='fuel_insufficient_to_reach_pit' && /5周目に.*完走できる案/.test(tightReply)
      && !/あと1周/.test(tightReply),tightReply);
  });
  // ═══ A. 手計算対照 ═══
  console.log('── A. 手計算（合成）──');
  await SEC('A', async () => {
    // 自車(idx0) 5.5周・ペース100s、相手R(idx1) 5.45周(5秒後ろ)・ペース100s。燃料30L・燃費3L・タンク53L・全20周。作業：通過12+固定10+0.4s/L。k=0。
    const tr = U.createTracker();
    const s = snap({ t: 500, cars: [{ i: 0, no: '10', prog: 5.5, ll: 100 }, { i: 1, no: '11', prog: 5.45, ll: 100 }] }); tr.update(s);
    const sec = U.compute(baseInput(tr, s, { options: { fuel_pace_s_per_l_per_lap: 0, rival_stops: { 1: { lap: 6, source: 'driver_declared' } } } }));
    const next = optById(sec, 'next');
    ck('A1 次周案：停止前の燃料25.5L・給油17.0L・ピットロス28.8s（手計算：停止後は20−6=14周×3L+予備0.5=42.5L、給油42.5−25.5=17.0、12+10+0.4×17）', near(next.fuel_at_entry_l, 25.5) && near(next.add_l, 17.0) && near(next.pit_loss_s.value, 28.8), next);
    ck('A2 完走燃料：停止後の余裕＝25.5+17−3×14=0.5L（予備ぶん）', near(next.fuel_margin_laps_after_l, 0.5, 0.05), next.fuel_margin_laps_after_l);
    const g = vs(next, 'car1', 'stops_lap_6');
    ck('A3 双方が同じ周に入り他条件が同じなら、給油後の共通地点のGAPは現GAP(−5.0s＝自車が先)のまま', near(g.gap_s, -5.0) && g.leads_at_common_point === 'own', g);
    ck('A4 比較地点は全候補の停止後の共通ライン（限界案14周＝30−3×(14+1−5.5)=1.5L≧予備0.5L→15周終了）で、全案で同じ', optById(sec, 'now').vs_rivals[0].common_point_lap === 15 && optById(sec, 'limit').vs_rivals[0].common_point_lap === 15 && optById(sec, 'limit').pit_lap === 14, { limit: optById(sec, 'limit').pit_lap, cp: next.vs_rivals[0].common_point_lap });
    // k=0.03：相手が今周(5)先に入る＝補給後の重い時間が自車次周案より長い。−5.0 + 0.03×17×(15−7) − 0.03×17×(15−6) = −5.51
    const s2 = U.compute(baseInput(tr, s, { options: { fuel_pace_s_per_l_per_lap: 0.03, rival_stops: { 1: { lap: 5, source: 'driver_declared' } } } }));
    const g2 = vs(optById(s2, 'next'), 'car1', 'stops_lap_5');
    ck('A5 燃料重量k=0.03：相手が先に入った分だけ相手の補給後の重い時間が長く、GAPは−5.51s（手計算）', near(g2.gap_s, -5.51, 0.03), g2);
    // 逆転に必要なペース：自車が後ろの設定（現GAP+4s、同時停止）→ gap=+4、次周案の停止後の周数 15−7=8周 → 0.5s/Lap
    const tr3 = U.createTracker(); const s3 = snap({ t: 500, cars: [{ i: 0, no: '10', prog: 5.5, ll: 100 }, { i: 1, no: '11', prog: 5.54, ll: 100 }] }); tr3.update(s3);   // Rは自車より前（0.04周=4s前）
    const sec3 = U.compute(baseInput(tr3, s3, { options: { fuel_pace_s_per_l_per_lap: 0, rival_stops: { 1: { lap: 6, source: 'driver_declared' } }, rival_ids: [1] } }));
    const g3 = vs(optById(sec3, 'next'), 'car1', 'stops_lap_6');
    ck('A6 相手が4秒前なら、同条件の停止後GAPは+4.0s（相手が先）で、必要ペースは停止後の9周(15−6)で4/9=0.444s/Lap速い', near(g3.gap_s, 4.0) && g3.leads_at_common_point === 'rival' && g3.required_pace && near(g3.required_pace.faster_per_lap_s, 0.444, 0.005) && g3.required_pace.laps === 9, g3);
  });
  // ═══ B. 交通（観測／推測位置／見えていない車） ═══
  console.log('── B. 復帰交通と未観測 ──');
  await SEC('B', async () => {
    // 遅い車S(idx2、ペース105)を、次周案の復帰時に自車の2秒前に出るよう置く。X=7.0、tx=155+28.8=178.8s、Y=7.02 → S0=7.02−178.8/105
    const tr = U.createTracker();
    const S0 = 7.02 - 178.8 / 105;
    const s = snap({ t: 500, cars: [{ i: 0, no: '10', prog: 5.5, ll: 100 }, { i: 1, no: '11', prog: 5.45, ll: 100 }, { i: 2, no: '12', prog: S0, ll: 105 }] }); tr.update(s);
    const sec = U.compute(baseInput(tr, s, { options: { fuel_pace_s_per_l_per_lap: 0, rival_stops: { 1: { lap: 6, source: 'driver_declared' } } } }));
    const next = optById(sec, 'next'), now = optById(sec, 'now');
    ck('B1 次周案の復帰先：遅い車12が2.0s前（観測・手計算 |7.02−7.0|×100）で、交通損失は通過コスト1.5s', next.rejoin.ahead.length === 1 && near(next.rejoin.ahead[0].gap_s, 2.0, 0.05) && next.rejoin.ahead[0].basis === 'observed' && near(next.rejoin.traffic_loss_s.value, 1.5), next.rejoin);
    ck('B2 今案の復帰時は同じ車が窓の外（約6.8s前）＝交通なし、全車観測できているので「空いている」と言える', now.rejoin.ahead.length === 0 && now.rejoin.traffic_loss_s.value === 0 && now.rejoin.clear === true && sec.coverage.clear_claim_allowed === true, { rejoin: now.rejoin, cov: sec.coverage });
    const gNow = vs(now, 'car1', 'stops_lap_6'), gNext = vs(next, 'car1', 'stops_lap_6');
    ck('B3 交通の分だけ次周案のGAPが悪い（−5.0 → −3.5）。推奨は交通のない案側', near(gNow.gap_s, -5.0) && near(gNext.gap_s, -3.5), { gNow: gNow.gap_s, gNext: gNext.gap_s });
    // 見えていない車（名簿にいるが位置が取れない）を足す：同クラス1台＋遅いクラス1台（そのクラスは観測ペース110の車がもう1台）
    const tr2 = U.createTracker();
    const mk = (extraCars) => snap({ t: 500, cars: [{ i: 0, no: '10', prog: 5.5, ll: 100 }, { i: 1, no: '11', prog: 5.45, ll: 100 }, { i: 2, no: '12', prog: S0, ll: 105 }, { i: 4, no: '40', c: 2, prog: 3.1, ll: 110 }].concat(extraCars) });
    const s2 = mk([{ i: 3, no: '13', st: 'out' }, { i: 5, no: '50', c: 2, st: 'out' }]); tr2.update(s2);
    const sec2 = U.compute(baseInput(tr2, s2, { options: { fuel_pace_s_per_l_per_lap: 0, rival_stops: { 1: { lap: 6, source: 'driver_declared' } } } }));
    const n2 = optById(sec2, 'now');
    ck('B4 名簿に位置が見えない車がいる間は、復帰区間を「空いている」と言わない（clear=false・理由=unobserved_cars_exist）', n2.rejoin.clear === false && n2.rejoin.clear_basis === 'unobserved_cars_exist' && sec2.coverage.clear_claim_allowed === false && sec2.coverage.unknown === 2, { rejoin: n2.rejoin, cov: sec2.coverage });
    ck('B5 見えていない遅いクラスの車は、窓に居る確率3/110×通過コスト1.5=0.041sが期待損失に入り、観測だけの下限(0)より大きく、上限はそれ以上', near(n2.rejoin.traffic_loss_s.value, 0.041, 0.005) && n2.rejoin.traffic_loss_s.low === 0 && n2.rejoin.traffic_loss_s.high >= n2.rejoin.traffic_loss_s.value, n2.rejoin.traffic_loss_s);
    ck('B6 計算パケットに「見えていない車」の件数と注意が入る（観測=名簿−2）', sec2.coverage.observed_now === 4 && sec2.coverage.roster_competitors === 6 && /空いている/.test(sec2.coverage.note) && sec2.assumptions.some(a => a.id === 'unobserved_cars'), sec2.coverage);
    // 推測位置：以前は見えていた車が今は見えない。最後の位置からペースで進める（σは経過時間で広がる）
    const tr3 = U.createTracker();
    tr3.update(snap({ t: 470, cars: [{ i: 0, no: '10', prog: 5.2, ll: 100 }, { i: 1, no: '11', prog: 5.15, ll: 100 }, { i: 6, no: '60', prog: 5.5, ll: 100 }] }));
    const s3 = snap({ t: 500, cars: [{ i: 0, no: '10', prog: 5.5, ll: 100 }, { i: 1, no: '11', prog: 5.45, ll: 100 }, { i: 6, no: '60', st: 'out' }] }); tr3.update(s3);
    const v3 = U.buildView(tr3, s3);
    const c6 = v3.cars.find(c => c.i === 6);
    ck('B7 30秒前に見えた車は推測位置(dead_reckoned)として扱う（観測ではない）。進行量は5.5+30/100=5.8', c6.state === 'dead_reckoned' && c6.progress === null && near(c6.seen.progress + (500 - c6.seen.t) / 100, 5.8, 0.001), c6);
    const sec3 = U.compute(baseInput(tr3, s3, { options: { fuel_pace_s_per_l_per_lap: 0 } }));
    ck('B8 推測位置の車は「観測」と表示されず、coverageはdead_reckoned=1・clear_claim_allowed=false', sec3.coverage.dead_reckoned === 1 && sec3.coverage.observed_now === 2 && sec3.coverage.clear_claim_allowed === false, sec3.coverage);
  });
  // 相手の復帰交通・完走燃料・周回遅れ（手計算）
  console.log('── A2. 相手の復帰交通／完走燃料／周回遅れ（手計算・合成）──');
  await SEC('A2', async () => {
    // 相手Rが7周の頭(停止後)に復帰する位置の2.0s前に遅い車S(ペース105)を置く：R復帰 tx=(7−5.45)×100+28.8=183.8s、Y=7.02 → S0=7.02−183.8/105。Rの損失+1.5 → 次周案のGAPは −5.0 → −6.5
    const tr = U.createTracker(); const S0 = 7.02 - 183.8 / 105;
    const s = snap({ t: 500, cars: [{ i: 0, no: '10', prog: 5.5, ll: 100 }, { i: 1, no: '11', prog: 5.45, ll: 100 }, { i: 2, no: '12', prog: S0, ll: 105 }] }); tr.update(s);
    const sec = U.compute(baseInput(tr, s, { options: { fuel_pace_s_per_l_per_lap: 0, rival_ids: [1], rival_stops: { 1: { lap: 6, source: 'driver_declared' } } } }));
    const g = vs(optById(sec, 'next'), 'car1', 'stops_lap_6');
    ck('A7 相手の復帰先にも遅い車が居れば相手の損失(+1.5s)になる（自車だけを不利にしない）：次周案のGAPは −5.0 → −6.5、相手の復帰交通=1.5s', near(g.gap_s, -6.5) && near(g.rival_rejoin_traffic_loss_s, 1.5), g);
    // 完走燃料：タンクが小さい(25L)と、今案は停止後の完走に45.5L必要で追加停止が要る＝除外。燃料が足りない(4L)と次周案は入口に届かない
    const small = U.compute(baseInput(tr, s, { options: { fuel_pace_s_per_l_per_lap: 0 }, own: { fuel_l: 30, fuel_per_lap_l: 3, tank_l: 25, reserve_l: 0.5, lap_time_s: { value: 100, source: 'observed' } } }));
    const nowS = optById(small, 'now');
    ck('A8 完走燃料：タンク25Lでは今案(停止後の完走に45.5L必要)は追加停止が要る＝除外(needs_extra_stop)。除外した案を推奨にしない', nowS.excluded === 'needs_extra_stop' && /45\.5/.test(nowS.extra_stop_note) && !(small.decision && small.decision.recommendation.option_id === 'now'), { now: nowS.excluded, note: nowS.extra_stop_note });
    const low = U.compute(baseInput(tr, s, { options: { fuel_pace_s_per_l_per_lap: 0 }, own: { fuel_l: 4, fuel_per_lap_l: 3, tank_l: 53, reserve_l: 0.5, lap_time_s: { value: 100, source: 'observed' } } }));
    const nextL = optById(low, 'next');
    ck('A9 予備燃料：残4Lでは次周案は入口の燃料が4−3×1.5=−0.5Lで届かない＝除外(fuel_insufficient_to_reach_pit)、余裕は−1.0L', nextL.excluded === 'fuel_insufficient_to_reach_pit' && near(nextL.fuel_margin_l, -1.0, 0.01), { nextL: nextL.excluded, margin: nextL.fuel_margin_l });
    // 燃料が十分（残60L・燃費2L・残り14.5周）＝燃料だけで完走できる：停止は燃料上は不要。停止を促す提案はしない
    const rich = U.compute(baseInput(tr, s, { options: { fuel_pace_s_per_l_per_lap: 0 }, own: { fuel_l: 60, fuel_per_lap_l: 2, tank_l: 60, reserve_l: 0.5, lap_time_s: { value: 100, source: 'observed' } } }));
    ck('A11 燃料だけで完走できる(60−2×15.5=29L≧予備)なら、停止は燃料上は不要と明示（stop_required_for_fuel=false・義務ピット規則は未確認）し、停止を促す提案文は出さない', rich.decision.recommendation.stop_required_for_fuel === false && /義務ピット/.test(rich.decision.recommendation.fuel_note) && rich.own.no_stop_feasible === true && U.proposal(rich, null).text === null && U.proposal(rich, null).reason === 'no_fuel_need', rich.decision.recommendation);
    // 周回遅れ：0.6周後ろの車は後続の脅威にしない（同じ周内の後続だけ）
    const tr2 = U.createTracker(); const s2 = snap({ t: 500, cars: [{ i: 0, no: '10', prog: 5.5, ll: 100 }, { i: 1, no: '11', prog: 4.9, ll: 100 }] }); tr2.update(s2);
    const lapped = U.compute(baseInput(tr2, s2, { options: { fuel_pace_s_per_l_per_lap: 0 } }));
    ck('A10 0.6周後ろの車は周回遅れとして後続の脅威にしない（rivals=0・後続を評価していないと明示）', lapped.rivals.length === 0 && lapped.decision.rival_threat_assessed === false, lapped.rivals.map(r => r.no));
  });
  // ═══ C. 鈴鹿決勝（実U1ログ） ═══
  console.log('── C. 鈴鹿 IMSA Fixed 決勝（実U1ログ sub:90078233 session_num=2）──');
  const R = require('./tools/u2-replay-suzuka.js');
  const run = R.run();
  if (!run) { skipped++; console.log('⏭  C 実U1ログ(OMORAY-field-20261113-1039-p01..p03.jsonl)が ' + R.dirOf() + ' に無いため未実施（U2_FIELD_LOG_DIRで場所を指定）'); }
  else await SEC('C', async () => {
    const L = run.logs, res = run.results.filter(x => x.section);
    ck('C0 実ログ3ファイルを実 field-snapshot.check で読み戻せた（決勝の標本2516件、不正行0、検証で弾いたのは1件=identity_stale）', L.race.length === 2516 && L.bad_lines === 0 && L.rejected_by_check === 1, { race: L.race.length, bad: L.bad_lines, rej: L.rejected_by_check });
    const maxObs = Math.max(...L.race.map(s => s.counts.observed)), roster = L.race[0].counts.target;
    ck('C1 名簿' + roster + '台に対し、同時に位置が取れたのは最大' + maxObs + '台（依頼の「最大21台」と一致）', roster === 50 && maxObs === 21, { roster, maxObs });
    ck('C2 計算できたLapが8つ以上（残燃料・燃費・残り時間が観測できた Lap5〜14）で、全Lapで標本は決勝(session 2)だけ', res.length >= 8 && res.every(x => x.section.race.session_num === 2 && x.section.race.race_instance_id === 'sub:90078233'), res.map(x => x.lap));
    ck('C3 全Lapで、見えていない車がいる＝復帰区間を「空いている」としない（clear=false・clear_claim_allowed=false）', res.every(x => x.section.coverage.clear_claim_allowed === false && x.section.options.filter(o => o.rejoin).every(o => o.rejoin.clear === false && o.rejoin.clear_basis === 'unobserved_cars_exist')), res.map(x => [x.lap, x.section.coverage.observed_now, x.section.coverage.unknown]));
    ck('C4 全Lapで、観測だけの下限＜期待値≦上限の順（見えていない車を0台とみなしていない）', res.every(x => x.section.options.filter(o => o.rejoin).every(o => o.rejoin.traffic_loss_s.low <= o.rejoin.traffic_loss_s.value + 1e-9 && o.rejoin.traffic_loss_s.value <= o.rejoin.traffic_loss_s.high + 1e-9)) && res.some(x => x.section.options.filter(o => o.rejoin).some(o => o.rejoin.traffic_loss_s.high > o.rejoin.traffic_loss_s.low + 1)), null);
    const x9 = res.find(x => x.lap === 9);
    const listed = res.flatMap(x => x.section.options.filter(o => o.rejoin).flatMap(o => o.rejoin.ahead.concat(o.rejoin.behind)));
    ck('C5 混走：復帰先の車列にクラス違い(GTP=4029)が出る場面があり、各車に観測/推測位置の別が付く（推測位置には窓内確率と経過秒）', listed.some(c => c.class_id === 4029) && listed.every(c => c.basis === 'observed' || (c.basis === 'dead_reckoned' && c.probability_in_window > 0 && c.age_s >= 0)), { listed: listed.length, gtp: listed.filter(c => c.class_id === 4029).length });
    console.log('   鈴鹿の復帰先の車列（全Lap・全案の合計）：観測=' + listed.filter(c => c.basis === 'observed').length + '台分／推測位置=' + listed.filter(c => c.basis === 'dead_reckoned').length + '台分。復帰先に入る車は「いま自車の約24秒後ろ」にいた車で、このログではそこがほとんど見えていない');
    const rear = res.map(x => x.section.rivals.length);
    ck('C6 後続(同クラス・同じ周内)が観測できない場面は、後続のアンダーカットを評価していないと明示（rival_threat_assessed=false・注意文）し、後続が居ない・空いているとは言わない', res.filter(x => x.section.comparable).every(x => x.section.decision.rival_threat_assessed === (x.section.rivals.length > 0) && (x.section.rivals.length > 0 || /評価していない/.test(x.section.decision.rival_threat_note))) && rear.some(n => n === 0) && res.filter(x => x.section.comparable).every(x => x.section.rear_coverage.same_class_unobserved > 0), rear);
    ck('C7 燃料：全Lapで、停止後に完走できない案(needs_extra_stop)・予備を切る案は除外され、選ばれた案は完走燃料が成立（停止後の余裕≧0）', res.every(x => x.section.options.filter(o => !o.excluded && !o.same_lap_as).every(o => o.fuel_margin_laps_after_l >= -1e-6 && o.fuel_margin_l >= 0)), null);
    // 未来を使わない：Lap9の計算は、Lap9より後の標本・燃料を壊しても変わらない
    const idx = L.race.findIndex(s => s.seq === x9.snapshot_seq);
    const tr = U.createTracker(); for (const s of L.race.slice(0, idx + 1)) tr.update(s);
    const inp = R.inputsAt(9, L.race[idx], tr);
    const again = U.compute(Object.assign({}, inp, { tracker: tr, snapshot: L.race[idx] }));
    const tr2 = U.createTracker(); for (const s of L.race.slice(0, idx + 1)) tr2.update(s);
    // 未来側の標本をtrackerへ入れて壊しても、その時刻の snapshot を渡す限り変わらない＝trackerは「今まで」だけを持つ。逆に未来を入れたtrackerは拒否側で判定される
    ck('C8 未来を使わない：同じ標本までの入力から決定的に同じ計算版(calc_id)が出る', again.calc_id === x9.section.calc_id, [again.calc_id, x9.section.calc_id]);
    const futureTr = U.createTracker(); for (const s of L.race.slice(0, idx + 80)) futureTr.update(s);
    const withFuture = U.compute(Object.assign({}, inp, { tracker: futureTr, snapshot: L.race[idx] }));
    ck('C9 未来の標本が入ったtrackerは使わない（その標本時刻より新しい観測が混ざる＝計算版が変わるので、呼び出し側が持つ“今まで”のtrackerでなければ検出できる）', withFuture.calc_id !== x9.section.calc_id, [withFuture.calc_id, x9.section.calc_id]);
    // 実データで相手を明示した時の頑健性（後続は見えないため、見えている同クラスの近い2台を相手にして経路を通す）。数値の妥当性ではなく、実標本でも破綻しないことの確認
    const x10 = res.find(x => x.lap === 10), i10 = L.race.findIndex(s => s.seq === x10.snapshot_seq), tr10 = U.createTracker(); for (const s of L.race.slice(0, i10 + 1)) tr10.update(s);
    const v10 = U.buildView(tr10, L.race[i10]), mine = v10.own, cand = v10.cars.filter(c => c.role === 'car' && c.cls === mine.cls && c.state === 'observed' && c.i !== mine.i).sort((a, b) => Math.abs(a.progress - mine.progress) - Math.abs(b.progress - mine.progress)).slice(0, 2);
    const s10 = U.compute(Object.assign({}, R.inputsAt(10, L.race[i10], tr10), { tracker: tr10, snapshot: L.race[i10], options: { rival_ids: cand.map(c => c.i) } }));
    ck('C10 実標本で相手を明示（見えている同クラス2台）しても計算が成立し、全案×相手の想定（既に入った車は観測の1想定、未入は3想定）に有限のGAPと先行側(leads)が付く。後続が見えない注意は相手を明示した時も coverage に残る', s10.comparable === true && s10.rivals.length === 2 && s10.options.filter(o => !o.excluded && !o.same_lap_as).every(o => o.vs_rivals.length === s10.rivals.reduce((a, r) => a + r.scenarios.length, 0) && o.vs_rivals.every(v => Number.isFinite(v.gap_s) && ['own', 'rival', 'close'].includes(v.leads_at_common_point))) && s10.rivals.every(r => r.scenarios.length === (r.stops_done >= 1 || r.on_pit_now ? 1 : 3)) && s10.coverage.clear_claim_allowed === false, { rivals: s10.rivals.map(r => [r.no, r.stops_done, r.scenarios.map(x => x.id)]), cmp: s10.comparable });
    console.log('   鈴鹿 Lap別の推奨：' + res.map(x => 'L' + x.lap + ':' + (x.section.decision ? x.section.decision.recommendation.option_id + '/P' + x.section.decision.recommendation.pit_lap : '-') + '(観測' + x.section.coverage.observed_now + '/' + x.section.coverage.roster_competitors + ')').join(' '));
  });
  // ═══ D. 富士VRS GT Sprint（再現用の仮定＝合成） ═══
  console.log('── D. 富士 VRS GT Sprint（Driver報告に基づく再現用の仮定・合成）──');
  await SEC('D', async () => {
    const cases = Fuji.build();
    const meta = Fuji.ASSUMPTIONS;
    ck('D0 富士の条件はDriver報告に基づく再現用の仮定として記録されている（合成・実測ではない）', meta.source === 'driver_report_reproduction_assumption' && meta.synthetic === true && Array.isArray(meta.items) && meta.items.length >= 6, meta.source);
    const w = cases.wait_loses, e = cases.early_loses;
    const sw = U.compute(w.input), se = U.compute(e.input);
    // 待つと逆転されるケース：上位走行中、後ろ2台が先に入る→次周/限界まで待つと給油後の共通地点で後ろに回る。今入れば前に出られる
    const wNext = optById(sw, 'next'), wLimit = optById(sw, 'limit'), wNow = optById(sw, 'now');
    const thr = sw.decision.rival_first_threats;
    ck('D1 待つと逆転される：後ろ2台のうち#11が先に入る想定（今周／次周）で、次周案と限界案は給油後の共通地点で相手が前(leads=rival, gap>0)になる', thr.some(t => t.option_id === 'next' && t.rival_no === '11' && t.scenario === 'pits_now' && t.behind_by_s > 0) && thr.some(t => t.option_id === 'limit' && t.rival_no === '11' && t.scenario !== 'stays_out') && thr.every(t => t.scenario !== 'stays_out'), thr);
    ck('D2 今入る案は、後ろ2台のどの想定でも自車が前に出る(leads=own)＝アンダーカットを防げる（範囲は仮定次第で0をまたぐ場合があり leads_robust で区別）', wNow.vs_rivals.length === 6 && wNow.vs_rivals.every(x => x.leads_at_common_point === 'own' && x.gap_s < 0), wNow.vs_rivals.map(x => [x.rival_no, x.scenario, x.gap_s, x.leads_at_common_point, x.leads_robust]));
    ck('D3 推奨は今入る案。優劣が仮定で変わる条件(flips_when)と、待つと負ける条件(rival_first_threats)をLUNAへ渡す。結論が未校正コストに依存するかも明示', sw.decision.recommendation.option_id === 'now' && Array.isArray(sw.decision.flips_when) && sw.decision.flips_when.every(f => f.condition && f.best_option_id !== 'now') && sw.decision.rival_first_threats.length >= 2 && typeof sw.decision.conditional_on_assumed_costs === 'boolean' && Array.isArray(sw.sensitivity) && sw.sensitivity.length === 4, { rec: sw.decision.recommendation, flips: sw.decision.flips_when, cond: sw.decision.conditional_on_assumed_costs });
    ck('D4 後ろの2台を両方評価（rivals=2）し、相手の給油予定は仮定(assumed)で、自車の給油量を一律適用したことをassumptionsに明記', sw.rivals.length === 2 && sw.rivals.map(r => r.no).join() === '11,12' && sw.rivals.every(r => r.scenarios.every(s => s.basis === 'assumed')) && sw.assumptions.some(a => a.id === 'rival_fill' && /一律/.test(a.text)), sw.assumptions.map(a => a.id));
    // 早く入ると交通で損をするケース：今入ると復帰先に遅い車列。次周以降は前の車列が散る
    const eNow = optById(se, 'now'), eNext = optById(se, 'next');
    ck('D5 早く入ると交通で損：今案の復帰先に遅い車が窓内にいて交通損失が次周案より大きい（観測された車の列）', eNow.rejoin.ahead.length >= 2 && eNow.rejoin.traffic_loss_s.value > eNext.rejoin.traffic_loss_s.value + 1.0 && eNow.rejoin.ahead.every(c => c.basis === 'observed'), { now: eNow.rejoin, next: eNext.rejoin.traffic_loss_s });
    ck('D6 交通の分だけ今案のGAPが次周案より悪くなり、推奨は今案ではない（次周案）', se.decision.recommendation.option_id !== 'now' && eNow.vs_rivals.every(x => { const y = eNext.vs_rivals.find(z => z.rival_id === x.rival_id && z.scenario === x.scenario); return y && x.gap_s > y.gap_s; }), { rec: se.decision.recommendation, now: eNow.vs_rivals.map(x => x.gap_s), next: eNext.vs_rivals.map(x => x.gap_s) });
    ck('D7 両ケースとも、全車を観測できている場面は復帰区間を「空いている」と言える／見えていない車を足すと言えなくなる（同じ入力で名簿に未観測を追加）',
      (() => { const hidden = Fuji.withHiddenCars(e.input, 6); const sh = U.compute(hidden); return se.coverage.clear_claim_allowed === true && sh.coverage.clear_claim_allowed === false && optById(sh, 'next').rejoin.clear === false; })(), null);
    // 訂正（Driverの意見）で再計算：「次周なら？」の焦点
    const sf = U.compute(Object.assign({}, w.input, { options: Object.assign({}, w.input.options, { focus: U.parseFocus('じゃあ次周なら？') }) }));
    ck('D8 「じゃあ次周なら？」＝焦点が次周案になり、同じ入力から新しい計算版(calc_id)で次周案の内訳が返る（案の優劣・数値は変えない）', sf.focus && sf.focus.option_id === 'next' && sf.focus.evaluated === true && sf.calc_id !== sw.calc_id && optById(sf, 'next').vs_rivals.length === optById(sw, 'next').vs_rivals.length && JSON.stringify(optById(sf, 'next').vs_rivals) === JSON.stringify(wNext.vs_rivals), sf.focus);
    ck('D9 走行中のLUNA提案文は決定論で、パケットの数値だけを使い、判断期限を含み、推奨変更が無ければ繰り返さない', (() => { const p1 = U.proposal(sw, null); const p2 = U.proposal(sw, p1.key); return p1.text && /判断は\d+周まで/.test(p1.text) && p2.text === null && p2.reason === 'unchanged'; })(), U.proposal(sw, null));
  });
  // ═══ E. 拒否 ═══
  console.log('── E. 拒否・欠測 ──');
  await SEC('E', async () => {
    const tr = U.createTracker(); const s = snap({ t: 500, cars: [{ i: 0, prog: 5.5, ll: 100 }, { i: 1, prog: 5.45, ll: 100 }] }); tr.update(s);
    const mixed = Object.assign({}, s, { gen: 'mixed', ok: false });
    ck('E1 世代が混在した標本は計算しない（snapshot_not_consistent）', U.compute(baseInput(tr, mixed)).blocking[0] === 'snapshot_not_consistent:mixed' && U.compute(baseInput(tr, mixed)).comparable === false, null);
    ck('E2 別のsession/raceの標本は計算しない', U.compute(Object.assign(baseInput(tr, s), { meta: { race_instance_id: 'sub:OTHER', session_num: 2 } })).blocking[0] === 'race_mismatch' && U.compute(Object.assign(baseInput(tr, s), { meta: { race_instance_id: 'sub:SYN', session_num: 1 } })).blocking[0] === 'session_mismatch', null);
    const inp = baseInput(tr, s); delete inp.own.fuel_l;
    const miss = U.compute(inp);
    ck('E3 自車の残燃料が無ければ計算しない（missing_input:own.fuel_l）。推測で埋めない', miss.comparable === false && miss.blocking.includes('missing_input:own.fuel_l'), miss.blocking);
    const own2 = snap({ t: 501, cars: [{ i: 0, st: 'out' }, { i: 1, prog: 5.45, ll: 100 }] }); tr.update(own2);
    ck('E4 自車自身が観測できない標本では計算しない（own_not_observed）', U.compute(baseInput(tr, own2)).blocking.includes('missing_input:own_not_observed'), null);
    const tr5 = U.createTracker(); tr5.update(snap({ t: 600, cars: [{ i: 0, prog: 6.5, ll: 100 }] })); const late = snap({ t: 590, cars: [{ i: 0, prog: 6.4, ll: 100 }] });
    ck('E5 時刻が戻る遅着標本はtrackerが採用しない', tr5.update(late) === false && tr5.stats().rejected >= 1, tr5.stats());
    const a = U.compute(baseInput(tr, s)), b = U.compute(baseInput(tr, s));
    ck('E6 同じ入力から同じ計算版(calc_id)が決定的に出る。calc_idは中身のhashで、改ざんすると一致しない', a.calc_id === b.calc_id && (() => { const x = JSON.parse(JSON.stringify(a)); x.options[0].add_l = 99; const id = x.calc_id; delete x.calc_id; return U.hashString(JSON.stringify(x)) !== id; })(), null);
  });
  await SEC('E8', async () => {
    const kinds = { 'じゃあ次周なら？': 'next', '次周ならどうなる？': 'next', 'もう1周待てば？': 'next', '今入ったら？': 'now', '今ピットに入ったらどうなる？': 'now', '限界まで待つと？': 'limit', '燃料の限界ギリギリまで引っ張ったら？': 'limit',
      '12周目に入ったら？': 'lap', '後ろが先に入ったら？': 'rival_first', '後ろの車が先に入ったらどうなる？': 'rival_first' };
    const bad = [];
    for (const [t, k] of Object.entries(kinds)) { const f = U.parseFocus(t); if (!f || f.kind !== k) bad.push([t, f && f.kind]); }
    const neg = ['今ピットに入るのと、アンダーカットはどっちが得？', '今入るのと次周に入るのと、どっちが得？', 'もう一度、今ピットに入るのと、アンダーカットはどっちが得？', 'アンダーカットとオーバーカット、どっちが得？', 'いつピットに入ればいい？', '燃料の限界は何周？', '今日は調子いいな', '次周のラップタイムは？', '前に詰まってる、アンダーカットは厳しいかも'];
    for (const t of neg) if (U.parseFocus(t)) bad.push([t, 'false_positive']);
    ck('E8 焦点の判定：「〜なら？／〜たら？」の仮定の形だけを焦点にし、「今入るのと次周と、どっちが得？」等の通常の比較質問・訂正は焦点にしない', bad.length === 0 && U.parseFocus('12周目に入ったら？').lap === 12, bad);
    const C = require('./desktop/pit-strategy-compare.js');
    const inp = { meta: { race_instance_id: 'r', session_num: 1, lap: 5 }, driver_assumptions: [], options: {} };
    ck('E8b 焦点はSTR-001の入力・driver_assumptionsを変えない（計算版を動かさない）。通常の比較質問は意見として扱わない', JSON.stringify(C.applyDriverOpinion(inp, C.parseDriverOpinion('じゃあ次周なら？'), {})) === JSON.stringify(inp) && C.parseDriverOpinion('今ピットに入るのと、アンダーカットはどっちが得？') === null, null);
  });
  await SEC('E7', async () => {
    const C = require('./desktop/pit-strategy-compare.js');
    const tr = U.createTracker(); const s = snap({ t: 500, cars: [{ i: 0, prog: 5.5, ll: 100 }, { i: 1, prog: 5.45, ll: 100 }] }); tr.update(s);
    const u = U.compute(baseInput(tr, s));
    const p0 = { schema: 'pit_strategy_compare', calc_version: C.VERSION, race: { race_instance_id: s.race_instance_id, session_num: s.session_num }, comparable: false, blocking: ['x'], cases: [], recommendation: null, inputs: [], expires: { valid_until_lap: 99 } };
    const p1 = C.attachUndercut(p0, u);
    ck('E7 packetUsable：STR-001が不成立でもundercutが成立なら使える。どちらも不成立なら使えない。validatePacketも通る（付け替え後のcalc_idは中身のhash）', C.packetUsable(p1) === true && C.packetUsable(p0) === false && C.packetUsable(C.attachUndercut(p0, Object.assign({}, u, { comparable: false }))) === false && C.validatePacket(p1, { race_instance_id: s.race_instance_id, session_num: s.session_num, lap: 5 }).ok === true && C.verifyCalcId(p1) === true, C.validatePacket(p1, { race_instance_id: s.race_instance_id, session_num: s.session_num, lap: 5 }));
  });
  // ═══ F. 検査Claudeの差戻し対応（R-U2-1〜5）═══
  console.log('── F. 周回数制の完走燃料／Truth Gate語句／ピットレーン上／追跡の境界 ──');
  await SEC('F1', async () => {
    // R-U2-1：周回数制(low=high=20)。自車10.0周の頭・残燃料20L・燃費2.0L/周・予備0.5L。今案＝10周の終わりに停止（進行量11）。チェッカー＝進行量21→停止後に走るのは10周
    //   必要＝2.0×10+0.5＝20.5L、停止前＝20−2.0×1=18.0L → 給油2.5L（手計算）。以前は停止後を9周と数えて給油0.5Lを返していた。
    const C = require('./desktop/pit-strategy-compare.js');
    const tr = U.createTracker(); const s = snap({ t: 600, cars: [{ i: 0, no: '10', prog: 10.0, ll: 90 }, { i: 1, no: '11', prog: 9.95, ll: 90 }] }); tr.update(s);
    const mkU = (fuel, low, high) => U.compute(baseInput(tr, s, { own: { fuel_l: fuel, fuel_per_lap_l: 2.0, tank_l: 60, reserve_l: 0.5, lap_time_s: { value: 90, source: 'observed' } }, total_laps: { value: high, low, high, source: 'assumed' }, options: { fuel_pace_s_per_l_per_lap: 0 } }));
    const sec = mkU(20, 20, 20), now = optById(sec, 'now'), next = optById(sec, 'next');
    ck('F1 周回数制(総20周)：今案の停止前18.0L・給油2.5L・停止後の総燃料20.5L＝必要20.5L（予備ぶんだけ残る）', near(now.fuel_at_entry_l, 18.0) && near(now.add_l, 2.5, 0.001) && near(now.fuel_margin_laps_after_l, 0.5, 0.001), { entry: now.fuel_at_entry_l, add: now.add_l, margin: now.fuel_margin_laps_after_l });
    ck('F2 次周案(11周の終わり)：停止前16.0L・停止後9周で必要18.5L → 給油2.5L（今案と同量。遅く入っても給油量は変わらない）', near(next.fuel_at_entry_l, 16.0) && near(next.add_l, 2.5, 0.001), { entry: next.fuel_at_entry_l, add: next.add_l });
    // STR-001（同じ入力）と給油量が一致する
    const sc = C.compute({ meta: { race_instance_id: 'syn:F', session_num: 0, lap: 10 }, total_laps: 20, baseline_pit_lap: 10, own: { fuel_l: 20, fuel_per_lap_l: 2.0, tank_l: 60, reserve_l: 0.5, lap_time_s: 90, best_clean_lap_s: 89 },
      pit: { transit_extra_s: 12, fixed_stall_s: 10, fuel_rate_s_per_l: 0.4 }, field: [{ id: 'a', gap_s: 6, lap_time_s: 90, class_rel: 'same', is_target: true }], options: { offsets: [0, 1] } });
    const strNow = (sc.cases || []).find(c => c.pit_lap === 10 && c.add_l !== undefined);
    ck('F3 STR-001（同じ入力）の給油量と一致する（総20周・10周の終わり＝2.5L）', !!strNow && near(strNow.add_l, now.add_l, 0.001), { str: strNow && strNow.add_l, u2: now.add_l });
    // 時間制（総周回に幅 low=19・high=21）：高い側(21)で数える＝停止後11周＝必要22.5L → 給油4.5L。STR-001の total.high−P と同じ定義
    const t = mkU(20, 19, 21), tn = optById(t, 'now');
    ck('F4 時間制(総周回19〜21)は高い側で数える：今案の給油4.5L（停止後11周×2.0+0.5−18.0）。幅のぶん安全側に増える', near(tn.add_l, 4.5, 0.001) && tn.add_l > now.add_l, { add: tn.add_l });
    const ex = U.compute(baseInput(tr, s, { own: { fuel_l: 60, fuel_per_lap_l: 2.0, tank_l: 60, reserve_l: 0.5, lap_time_s: { value: 90, source: 'observed' } }, total_laps: { value: 20, low: 20, high: 20, source: 'assumed' }, options: { fuel_pace_s_per_l_per_lap: 0, extra_pit_laps: [19, 20] } }));
    ck('F5 総20周・燃料60L：燃料の限界案は19周の終わり（停止後1周）まで。20周の終わり（＝チェッカー）は評価できない', optById(ex, 'limit') && optById(ex, 'limit').pit_lap === 19 && optById(ex, 'limit').excluded === null, optById(ex, 'limit') && { pit: optById(ex, 'limit').pit_lap, ex: optById(ex, 'limit').excluded });
    ck('F5b 20周の終わり（チェッカー）に入る案は pit_lap_not_before_finish', optById(ex, 'lap_20') && optById(ex, 'lap_20').excluded === 'pit_lap_not_before_finish', optById(ex, 'lap_20'));
  });
  await SEC('F6', async () => {
    // R-U2-2：Truth Gate。見えていない車がいる(clear_claim_allowed=false)パケットで、正しい説明は通し、肯定の断定は止める
    const C = require('./desktop/pit-strategy-compare.js');
    const pk = { undercut_forecast: { coverage: { clear_claim_allowed: false } } }, pkOk = { undercut_forecast: { coverage: { clear_claim_allowed: true } } };
    const honest = ['復帰先は見えていない車がいるので空いているとは言えません。', '復帰先は空いているとは言えません。', '復帰先が空いているとは断定できません。', '出口はクリアとは言えません。', '復帰区間は空いているか不明です。', '復帰先が空いているかどうか、不明です。', '復帰先は空いているのか、現時点では不明です。', '復帰先が空いているのか、今のところ分かりません。', '見えていない車がいるので、誰もいないとは言えません。', '巻き込まれないとは断定できません。', '復帰先が空いているか分かりません。',
      '後続の位置が見えていないので、後続のアンダーカットは評価できていません。', '渋滞がないとは言い切れません。', 'ピットから出てもクリアとは限りません。', "I can't say the rejoin is clear.", 'The rejoin traffic is unknown.'];
    const claims = ['出口は詰まらないと思います', 'ピットから出てもクリアです', 'ガラ空きです、行けます', '前に車はいません', '渋滞はありません', '出たところはクリアエアです', 'there is no traffic when you rejoin', 'トラフィックは少ない', '混んでいません',
      '復帰先は空いています。', '見えていない車がいますが、出口はクリアです。', '他の車に引っかかりません', 'The rejoin is clear.', 'You will have clean air.', '交通はありません', 'ノートラフィックです',
      'ピットを出たら前は空いてますよ。', '戻ってもトラフィックは気にしなくて大丈夫です。', '出た先は誰もいません。', '今入れば渋滞に巻き込まれません。', '復帰後は自分のペースで走れます。', '出口の先は障害物がなく走りやすいです。', '復帰は問題なく空いたところに出ます。', '出ても他の車と絡みません。', '復帰位置の前後は空白です。'];   // 後半9例＝監査/検査Claudeの再検査で漏れた自然な言い方
    const badH = honest.filter(t => C.hasUnobservedClearClaim(t, pk)), badC = claims.filter(t => !C.hasUnobservedClearClaim(t, pk));
    ck('F6 見えていない車がいる時：「空いているとは言えない／断定できない／不明／分からない」の正しい説明を止めない（誤検知0）', badH.length === 0, badH);
    ck('F7 見えていない車がいる時：「詰まらない／クリア／ガラ空き／車はいない／渋滞はない／トラフィックは少ない／混んでいない／there is no traffic／clean air」等の肯定の断定は止める（漏れ0）', badC.length === 0, badC);
    ck('F8 全車観測できている(clear_claim_allowed=true)時は止めない', claims.every(t => !C.hasUnobservedClearClaim(t, pkOk)) && !C.hasUnobservedClearClaim('復帰先は空いています', {}), null);
  });
  await SEC('F9', async () => {
    // R-U2-3：自車がピットレーン上なら計算しない（第二の停止を推奨しない）
    const tr = U.createTracker(); const s = snap({ t: 500, cars: [{ i: 0, no: '10', prog: 5.5, ll: 100, pit: true }, { i: 1, no: '11', prog: 5.45, ll: 100 }] }); tr.update(s);
    const sec = U.compute(baseInput(tr, s));
    ck('F9 自車がピットレーン上なら blocking=own_in_pit で、案も推奨も出さない（第二の停止を提案しない）', sec.comparable === false && sec.blocking.includes('own_in_pit') && sec.options.length === 0 && sec.decision === null, { b: sec.blocking, n: sec.options.length });
    const C = require('./desktop/pit-strategy-compare.js');
    ck('F9b own_in_pitのパケットはSTR-001側でも使えない（packetUsable=false）', C.packetUsable(C.attachUndercut({ schema: 'pit_strategy_compare', calc_version: C.VERSION, race: sec.race, comparable: false, blocking: ['x'], observed_at: sec.observed_at, cases: [], recommendation: null, inputs: [], expires: { valid_until_lap: 99 } }, sec)) === false, null);
  });
  await SEC('F10', async () => {
    // R-U2-4①：別session/raceでは追跡をリセットする（前sessionのピット通過回数・位置を持ち越さない）
    const tr = U.createTracker();
    tr.update(snap({ t: 100, session: 1, cars: [{ i: 0, prog: 3.1, ll: 90 }, { i: 1, prog: 3.0, ll: 90 }] }));
    tr.update(snap({ t: 110, session: 1, cars: [{ i: 0, prog: 3.2, ll: 90 }, { i: 1, prog: 3.1, ll: 90, pit: true }] }));
    tr.update(snap({ t: 130, session: 1, cars: [{ i: 0, prog: 3.4, ll: 90 }, { i: 1, prog: 3.3, ll: 90 }] }));
    const had = tr.cars.get(1).stops;
    tr.update(snap({ t: 50, session: 2, cars: [{ i: 0, prog: 1.1, ll: 90 }, { i: 1, prog: 1.0, ll: 90 }] }));
    ck('F10 別sessionの最初の標本で追跡をリセットする：session1のピット通過(1回)を持ち越さない。時刻が戻っても新sessionとして採用', had === 1 && tr.cars.get(1).stops === 0 && tr.stats().accepted >= 4, { had, now: tr.cars.get(1).stops, st: tr.stats() });
    const tr2 = U.createTracker(); tr2.update(snap({ t: 100, race: 'sub:A', cars: [{ i: 0, prog: 3.1, ll: 90 }] }));
    const okB = tr2.update(snap({ t: 20, race: 'sub:B', cars: [{ i: 0, prog: 1.1, ll: 90 }] }));
    ck('F10b 別raceの標本は、時刻が前でも新raceとして採用され、前raceの車の位置は残らない', okB === true && tr2.cars.get(0).seen.progress < 2, { okB, seen: tr2.cars.get(0).seen });
    // R-U2-4②：推測位置の車しか居なくても(見えていない車0台)、復帰先を「空いている」としない
    const tr3 = U.createTracker();
    tr3.update(snap({ t: 400, cars: [{ i: 0, prog: 7.2, ll: 90 }, { i: 1, prog: 7.1, ll: 90 }, { i: 2, prog: 6.8, ll: 90, c: 2 }] }));
    const s3 = snap({ t: 430, cars: [{ i: 0, prog: 7.5, ll: 90 }, { i: 1, prog: 7.4, ll: 90 }, { i: 2, st: 'out', no: '2' }] }); tr3.update(s3);
    const sec3 = U.compute(baseInput(tr3, s3, { total_laps: { value: 30, low: 30, high: 30, source: 'assumed' } }));
    ck('F11 推測位置の車(unknown=0・dead_reckoned=1)でも、どの案のrejoin.clearもtrueにならず、clear_claim_allowed=false', sec3.coverage.dead_reckoned === 1 && sec3.coverage.unknown === 0 && sec3.coverage.clear_claim_allowed === false && sec3.options.every(o => !o.rejoin || o.rejoin.clear !== true) && sec3.options.some(o => o.rejoin), { cov: sec3.coverage, clear: sec3.options.map(o => o.rejoin && o.rejoin.clear) });
    // R-U2-4③：相手の給油量の仮定（自車「次周」案の量×0.7〜1.3）が、GAPの範囲に反映される（範囲が点ではなく、下限＜中央値＜上限）
    const tr4 = U.createTracker(); const s4 = snap({ t: 500, cars: [{ i: 0, no: '10', prog: 5.5, ll: 100 }, { i: 1, no: '11', prog: 5.45, ll: 100 }] }); tr4.update(s4);
    const sec4 = U.compute(baseInput(tr4, s4, { options: { fuel_pace_s_per_l_per_lap: 0, rival_stops: { 1: { lap: 5, source: 'driver_declared' } } } }));
    const g4 = vs(optById(sec4, 'next'), 'car1', 'stops_lap_5');
    ck('F12 相手の給油量の仮定幅(×0.7〜1.3)がGAP範囲に出る：相手の給油ロス(+4.0s≒0.4s/L×17L×0.6)ぶん、下限＜中央値＜上限で幅は約4.1s', g4.gap_range_s[0] < g4.gap_s && g4.gap_s < g4.gap_range_s[1] && near(g4.gap_range_s[1] - g4.gap_range_s[0], 4.08, 0.2), g4);
  });
  console.log('\n=== U2 undercut forecast: ' + pass + ' passed, ' + fail + ' failed' + (skipped ? ', ' + skipped + ' skipped(未実施)' : '') + ' ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS_ERROR', e); process.exit(2); });
