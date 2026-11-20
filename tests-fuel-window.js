#!/usr/bin/env node
'use strict';
// 給油ウィンドウ（desktop/fuel-window.js）の手計算対照。Owner定義（2026-11-15）：
//   開く ⇔ 給油後にタンクへ持てる量(容量) ≥ ピット出口からチェッカーまでの予測消費＋設定余裕 、かつ ピットへ到達できる。
//   追加給油量＝目標タンク量（消費＋余裕）−入庫時見込み残量。必要量（消費）と余裕は別の値で返す。
const W = require('./desktop/fuel-window.js');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + n + (ok ? '' : ' -> ' + JSON.stringify(d === undefined ? null : d).slice(0, 500))); ok ? pass++ : fail++; };
const near = (a, b, e = 0.011) => typeof a === 'number' && Math.abs(a - b) <= e;

// 手計算：残燃料12L・1周2.0L・チェッカーまで通過10回・容量25L・余裕3L・周回の半分(0.5)
//   消費(出口→チェッカー)=2.0×10=20L、目標=23L≦25L→開いている。入庫時見込み=12−2.0×(1−0.5)=11L、追加=23−11=12L
const a = W.evaluate({ fuel_l: 12, burn_l: 2.0, crossings: 10, capacity_l: 25, margin_l: 3, lap_dist_pct: 0.5 });
ck('W1 開いている：必要(消費)20L・余裕3L・目標23L・入庫時11L・追加12L。必要量と余裕は別の値', a.state === 'open' && a.open === true && near(a.required_l, 20) && near(a.margin_l, 3) && near(a.target_tank_l, 23) && near(a.entry_fuel_l, 11) && near(a.add_l, 12), a);
const b = W.evaluate({ fuel_l: 12, burn_l: 2.0, crossings: 10, capacity_l: 25, margin_l: 4, lap_dist_pct: 0.5 });
ck('W2 余裕を3→4Lにすると、必要量は変わらず追加だけが1L増える（余裕は必要量に混ぜない）', near(b.required_l, a.required_l) && near(b.add_l - a.add_l, 1) && b.margin_source === 'driver_setting', { a: a.add_l, b: b.add_l });
const c = W.evaluate({ fuel_l: 12, burn_l: 2.0, crossings: 10, capacity_l: 18, margin_l: 3, lap_dist_pct: 0.5 });
ck('W3 まだ閉じている：目標23L＞容量18L。通過回数が減って必要量が減る＝あと3周（ceil((23−18)/2)）で開く', c.state === 'waiting' && c.open === false && c.opens_in_laps === 3 && c.add_l === null, c);
const d = W.evaluate({ fuel_l: 0.5, burn_l: 2.0, crossings: 10, capacity_l: 25, margin_l: 3, lap_dist_pct: 0.5 });
ck('W4 この周のピットまで燃料が届かない(入庫時−0.5L)は unreachable。開き扱いにしない', d.state === 'unreachable' && d.open === false && d.reason === 'fuel_short_of_pit_entry', d);
const e = W.evaluate({ fuel_l: 6, burn_l: 2.0, crossings: 10, capacity_l: 18, margin_l: 3, lap_dist_pct: 0.5 });
ck('W5 開く周まで燃料が持たない(あと3周で開くが、その周の入庫時6−2×3.5=−1L)は unreachable（再停止が要る／別の手）', e.state === 'unreachable' && e.reason === 'window_opens_after_fuel_runs_out', e);
ck('W6 容量が不明なら unknown（開き扱いにしない）。欠けた項目を返す', (() => { const x = W.evaluate({ fuel_l: 12, burn_l: 2, crossings: 10, capacity_l: null, margin_l: 3 }); return x.state === 'unknown' && x.open === false && x.missing.includes('capacity_l'); })(), null);
ck('W7 燃費・通過回数・残燃料のどれが欠けても unknown', ['fuel_l', 'burn_l', 'crossings'].every(k => { const i = { fuel_l: 12, burn_l: 2, crossings: 10, capacity_l: 25 }; i[k] = null; return W.evaluate(i).state === 'unknown'; }), null);
ck('W8 余裕の設定：未設定=候補値3L(source=candidate_default・固定既定値ではない)、範囲内の設定=driver_setting、範囲外(30L)=候補値へ・燃費の大きい車の1周分(7.5L)は有効', W.normMargin(null).source === 'candidate_default' && W.normMargin(4).source === 'driver_setting' && W.normMargin(4).value === 4 && W.normMargin(30).source === 'candidate_default' && W.normMargin(30).value === W.DEFAULT_MARGIN_L && W.normMargin(7.5).source === 'driver_setting', null);
ck('W9 給油なしでも余裕込みで完走できる時は no_stop_needed=true（窓は開いていても停止は必須でない）', W.evaluate({ fuel_l: 30, burn_l: 2, crossings: 10, capacity_l: 40, margin_l: 3, lap_dist_pct: 0 }).no_stop_needed === true && W.evaluate({ fuel_l: 12, burn_l: 2, crossings: 10, capacity_l: 25, margin_l: 3 }).no_stop_needed === false, null);
// 容量ちょうど：目標＝容量なら開く（≦）
ck('W10 目標＝容量ちょうど(消費20＋余裕5＝25L)は開く。1Lでも超えれば閉じる', W.evaluate({ fuel_l: 12, burn_l: 2, crossings: 10, capacity_l: 25, margin_l: 5, lap_dist_pct: 0 }).state === 'open' && W.evaluate({ fuel_l: 12, burn_l: 2, crossings: 10, capacity_l: 24, margin_l: 5, lap_dist_pct: 0 }).state === 'waiting', null);
const s1 = W.sentence(a, 'notify', 'ja'), s2 = W.sentence(a, 'status', 'ja'), s3 = W.sentence(c, 'status', 'ja');
ck('W11 通知は一文・結論から・追加量を言う。状況回答は必要量と余裕を別々に言う。内部の計算ルール・欠測注記を含めない', /^給油ウィンドウが開いた、/.test(s1) && /追加約12\.0L/.test(s1) && (s1.match(/。/g) || []).length === 1 && /必要20\.0L＋余裕3\.0L/.test(s2) && /あと約3周/.test(s3) && !/Bridge|assumed|仮定|除外|calc_id/.test(s1 + s2 + s3), { s1, s2, s3 });
ck('W12 周回の位置(lap_dist_pct)が進むほど入庫時残量は増えず、追加は増える（0.5→0.9）。pct未指定は0＝入庫までの消費を多めに見る', (() => { const lo = W.evaluate({ fuel_l: 12, burn_l: 2, crossings: 10, capacity_l: 25, margin_l: 3, lap_dist_pct: 0.5 }), hi = W.evaluate({ fuel_l: 12, burn_l: 2, crossings: 10, capacity_l: 25, margin_l: 3, lap_dist_pct: 0.9 }), none = W.evaluate({ fuel_l: 12, burn_l: 2, crossings: 10, capacity_l: 25, margin_l: 3 }); return near(hi.entry_fuel_l, 11.8) && hi.add_l < lo.add_l && near(none.entry_fuel_l, 10); })(), null);
// ═══ 4周目の見込み（燃費サンプルの採否・見込み周・再コールの判定）═══
const rows = (arr) => arr.map(([lap, fuel, last, pit, inpit]) => ({ lap, fuel_l: fuel, last_lap_s: last || null, pit_touched: !!pit, in_pit_at_boundary: !!inpit }));
// 実ログ（鈴鹿 11/13 決勝・自車）：2周目にピット→49.5Lへ給油。1→2周は3.5L、3→4周は3.6L。
const suz = W.selectBurnSamples(rows([[1, 49.6], [2, 46.1, 119.2], [3, 49.5, 155.4, true], [4, 45.9, 119.4]]));
ck('S1 実ログ(鈴鹿)：ピットを挟む周は除外(pit_involved)。安定3周は揃わない(n=2・stable=false)＝暫定', suz.n === 2 && !suz.stable && suz.rejected.length === 1 && suz.rejected[0].reason === 'pit_involved' && near(suz.burn_l, 3.55), suz);
const ok3 = W.selectBurnSamples(rows([[1, 50.0], [2, 46.5, 119], [3, 42.8, 121], [4, 39.4, 119.5]]));
ck('S2 軽い逸脱を含む安定3周(消費3.5/3.7/3.4L・周回119/121/119.5s)は採用。stable=true・燃費は中央値3.5L', ok3.n === 3 && ok3.stable && near(ok3.burn_l, 3.5) && ok3.rejected.length === 0, ok3);
const bad = W.selectBurnSamples(rows([[1, 50.0], [2, 46.5, 119], [3, 43.0, 150], [4, 39.5, 119.5], [5, 32.5, 119], [6, 29.0, 119.5]]));
ck('S3 長い減速・黄旗(周回150s＝中央値の10%超遅い)は slow_lap、消費が中央値から25%超(7.0L)は fuel_outlier として除外。残りの3周で採用', bad.rejected.some(r => r.reason === 'slow_lap') && bad.rejected.some(r => r.reason === 'fuel_outlier') && bad.n === 3 && near(bad.burn_l, 3.5), bad);
ck('S4 ピットレーン上の境界・給油(残燃料が増える)・連続しないLapは使わない', (() => { const x = W.selectBurnSamples(rows([[1, 50], [2, 46.5, 119, false, true], [3, 43, 119], [5, 36, 119], [6, 40, 119]])); return x.n === 0 && x.rejected.filter(r => r.reason === "pit_involved").length === 2 && !x.rejected.some(r => r.lap === 3) && x.rejected.some(r => r.reason === 'fuel_not_decreasing_refuel_or_gap'); })(), null);
// 見込み周：残燃料30L・燃費2.0・通過20回・容量25L・余裕3L・4周目の頭
//   目標=2.0×20+3=43L＞25L→ ceil((43−25)/2)=9周後(13周目)に開く。入れる最終周＝4+floor((30−2.0×1)/2)=18周目
const fc = W.forecast({ lap: 4, fuel_l: 30, burn_l: 2.0, crossings: 20, capacity_l: 25, margin_l: 3, lap_dist_pct: 0, stable: true, burn_source: 'observed_stable', samples_used: 3 });
ck('F1 見込み：13周目に開く・燃料の面で入れる最終周は18周目・安定3周なので暫定ではない', fc.state === 'waiting' && fc.open_lap === 13 && fc.last_feasible_lap === 18 && fc.provisional === false, fc);
ck('F2 安定3周が揃わない／Bridge平均で補った見込みは暫定(provisional=true)', W.forecast({ lap: 4, fuel_l: 30, burn_l: 2, crossings: 20, capacity_l: 25, margin_l: 3, lap_dist_pct: 0, stable: false, burn_source: 'bridge_average', samples_used: 1 }).provisional === true, null);
// 再コールの判定
const mk = (open, o) => Object.assign({ state: 'waiting', lap: 4, open_lap: open, last_feasible_lap: 18, provisional: false, burn_source: 'observed_stable', samples_used: 3 }, o || {});
let st = null; const seq = [];
const step = (f) => { const d = W.decideForecastCall(st, f, { minLap: 4 }); st = d.next; seq.push(d.speak ? d.speak.type : null); return d; };
ck('C1 3周目まで(minLap未満)は初回を伝えない。4周目の入口で一度だけ「13周目に開く見込み」', (() => { const a = step(mk(13, { lap: 3 })); const b = step(mk(13, { lap: 4 })); return a.speak === null && b.speak && b.speak.type === 'initial' && b.speak.open_lap === 13; })(), seq);
ck('C2 見込みが変わらない周は無音（同じ結論を繰り返さない）', (() => { const a = step(mk(13, { lap: 5 })), b = step(mk(13, { lap: 6 })); return a.speak === null && b.speak === null; })(), seq);
ck('C3 1周だけ前倒しになってすぐ戻る一時的なぶれは伝えない（2回続けて同じ新しい値になるまで待つ）', (() => { const a = step(mk(12, { lap: 7 })), b = step(mk(13, { lap: 8 })); return a.speak === null && b.speak === null && st.pending_open_lap === null; })(), seq);
ck('C4 前倒しが2回続けて同じ値(12周目)になったら、Driverの判断が変わる移動として一度伝える（前倒し）', (() => { const a = step(mk(12, { lap: 9 })), b = step(mk(12, { lap: 10 })); return a.speak === null && b.speak && b.speak.type === 'shift' && b.speak.direction === 'earlier' && b.speak.open_lap === 12 && b.speak.from_open_lap === 13; })(), seq);
ck('C5 伝えた後は新しい値が基準：同じ12周目では無音、後ろ倒し(14周目)が2回続いたら後ろ倒しとして伝える', (() => { const a = step(mk(12, { lap: 11 })); const b = step(mk(14, { lap: 12 })), c = step(mk(14, { lap: 13 })); return a.speak === null && b.speak === null && c.speak && c.speak.direction === 'later'; })(), seq);
ck('C6 入れる周が無くなる(燃料が開く周まで持たない=unreachable)時は、2回待たずにすぐ一度だけ伝える。続けても繰り返さない', (() => { const a = step({ state: 'unreachable', lap: 14, provisional: false }), b = step({ state: 'unreachable', lap: 15, provisional: false }); return a.speak && a.speak.type === 'lost' && b.speak === null; })(), seq);
ck('C7 既に開いている(open)間は見込みを言わない（実際の開通通知は別経路）', W.decideForecastCall(null, { state: 'open', lap: 6, open_lap: 6 }, { minLap: 4 }).speak === null, null);
ck('C8 初回に安定3周が無くても「暫定」として一度は伝える（一律に黙らない）。文面は「暫定、…開く見込み」', (() => { const d = W.decideForecastCall(null, mk(13, { provisional: true, burn_source: 'bridge_average', samples_used: 1 }), { minLap: 4 }); return d.speak && d.speak.provisional === true && /^暫定、給油ウィンドウは13周目に開く見込み。$/.test(W.forecastSentence(d.speak, mk(13, { provisional: true, burn_source: 'bridge_average' }), 'ja')); })(), null);
ck('C9 文面：初回は燃費の出所つき一文、更新は「見込み更新、…前倒し/後ろ倒し」、消失は短く。内部の計算ルール・欠測注記を含めない', (() => { const i = W.forecastSentence({ type: 'initial', open_lap: 13 }, mk(13), 'ja'), sh = W.forecastSentence({ type: 'shift', open_lap: 12, direction: 'earlier' }, mk(12), 'ja'), lo = W.forecastSentence({ type: 'lost' }, mk(0), 'ja'); return i === '燃費の実測3周から給油ウィンドウは13周目に開く見込み。' && sh === '見込み更新、給油ウィンドウは12周目に前倒し。' && /もたない/.test(lo) && ![i, sh, lo].some(t => /assumed|calc|仮定|除外|Bridge/.test(t)); })(), null);
// ═══ 保存入力（富士 11/15 決勝・自車。Bridge debug logから抜いた各Lap先頭の観測）での見込み：暫定→更新→成立 ═══
{
  const fs = require('fs'), path = require('path');
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/fw/fuji-20261115-own-laps.json'), 'utf8'));
  const rowsAt = L => fx.laps.filter(r => r.lap <= L).map(r => ({ lap: r.lap, fuel_l: r.fuel_l, last_lap_s: r.last_lap_s, pit_touched: false, in_pit_at_boundary: false }));
  let prev = null; const seq = []; const outs = {};
  for (let L = 1; L <= 11; L++) {
    const cur = fx.laps.find(r => r.lap === L), sel = W.selectBurnSamples(rowsAt(L));
    const useObs = sel.n >= 2, burn = useObs ? sel.burn_l : null;
    const f = W.forecast({ lap: L, fuel_l: cur.fuel_l, burn_l: burn, crossings: cur.crossings === undefined ? null : cur.crossings, capacity_l: fx.effective_capacity_l, margin_l: 3, lap_dist_pct: 0.02, stable: useObs && sel.stable, burn_source: useObs ? (sel.stable ? 'observed_stable' : 'observed_partial') : null, samples_used: sel.n });
    const d = W.decideForecastCall(prev, f, { minLap: 4 }); prev = d.next;
    seq.push([L, f.state, f.open_lap, d.speak ? d.speak.type : null]); outs[L] = { f, sel, d };
  }
  ck('R1 実ログ(富士)：Bridgeの残り通過回数が無い1〜3周目は見込みを出さない（unknown）。4周目に安定3周(消費2.9/2.7/2.7L・周回108.7/102.6/99.7s＝最速周の10%以内)が揃い、初回「7周目に開く見込み」', [1, 2, 3].every(L => outs[L].f.state === 'unknown' && outs[L].d.speak === null) && outs[4].sel.n === 3 && outs[4].sel.stable && outs[4].d.speak && outs[4].d.speak.type === 'initial' && outs[4].d.speak.open_lap === 7 && !outs[4].d.speak.provisional, seq);
  ck('R2 5周目：通過回数が21のまま(モデル更新)で、開く周が8周目に変わる見込み＝1回目なので伝えない。6周目に2回続けて8周目になり「見込み更新・8周目に後ろ倒し」を一度だけ', outs[5].d.speak === null && outs[5].f.open_lap === 8 && outs[6].d.speak && outs[6].d.speak.type === 'shift' && outs[6].d.speak.open_lap === 8 && outs[6].d.speak.direction === 'later', seq);
  ck('R3 7周目は見込み不変で無音。8周目(通過回数18・必要48.6L＋余裕3L＝51.6L≦容量53L)に実際に開く＝見込みどおり', outs[7].d.speak === null && outs[7].f.open_lap === 8 && outs[8].f.state === 'open' && outs[8].d.speak === null, seq);
  const o8 = outs[8].f.evaluation;
  ck('R4 開いた時の追加給油量：必要48.6L・余裕3.0L・目標51.6L・入庫時の残量から計算(約' + (o8.add_l) + 'L)。必要量と余裕が別々に出る。実際の給油は18.85L（Ownerが11周終わりに入った：窓は3周前から開いていた）', o8.state === 'open' && near(o8.required_l, 48.6, 0.2) && near(o8.margin_l, 3) && near(o8.target_tank_l, 51.6, 0.2) && o8.add_l > 0, o8);
  // 余裕＝周数×燃費（監督 2026-11-18：既定1周分・Driverが0.5周分へ変更可）。実ログ(富士)の燃費2.7L/周で、窓が開く周がどう変わるか。
  const RRm = require('./desktop/race-rules.js');
  const openLap = laps => { for (let L = 4; L <= 11; L++) { const cur = fx.laps.find(r => r.lap === L); const e = W.evaluate({ fuel_l: cur.fuel_l, burn_l: 2.7, crossings: cur.crossings, capacity_l: fx.effective_capacity_l, margin_l: RRm.marginLiters({ laps }, 2.7), lap_dist_pct: 0.02 }); if (e.state === 'open') return { lap: L, e }; } return null; };
  const o1 = openLap(1), o05 = openLap(0.5);
  ck('R7 実ログ(富士)・燃費2.7L/周・容量53L：余裕1周分(2.7L)なら8周目に開く（必要48.6L＋2.7L＝51.3L≦53L）、0.5周分(1.35L)なら7周目＝1周早く開く（必要51.3L＋1.35L＝52.65L≦53L）。余裕の設定が窓へ反映される', o1 && o1.lap === 8 && o05 && o05.lap === 7 && near(o1.e.margin_l, 2.7) && near(o05.e.margin_l, 1.35), { o1: o1 && [o1.lap, o1.e.target_tank_l], o05: o05 && [o05.lap, o05.e.target_tank_l] });
  // 反例：ピット・事故・減速の周が混ざると、安定3周が揃わず暫定になる（早開きしない）。実ログの1周目を除外して2周分だけにした場合
  const two = W.selectBurnSamples(rowsAt(4).filter(r => r.lap >= 2));
  ck('R5 反例：2〜4周目の2サンプルだけ(安定3周に満たない)なら stable=false＝暫定。暫定の見込みは「暫定、…」と言い、採用周数は2', two.n === 2 && !two.stable, two);
  // 給油後(12周以降)：燃料が増える周はサンプルに入らない（実ログの11→12周）
  const post = W.selectBurnSamples(fx.laps.filter(r => r.lap >= 10 && r.lap <= 14).map(r => ({ lap: r.lap, fuel_l: r.fuel_l, last_lap_s: r.last_lap_s, pit_touched: r.lap === 12, in_pit_at_boundary: false })));
  ck('R6 実ログの給油周(11→12周：24.0→40.2L)は pit_involved／燃料増として除外され、給油後の消費は別に採用される', post.rejected.some(r => r.lap === 11 && /pit_involved|fuel_not_decreasing/.test(r.reason)) && post.accepted.every(a => a.drop_l > 2 && a.drop_l < 4), post);
}
console.log('\n=== fuel-window: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
