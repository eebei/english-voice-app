'use strict';
// U2 — 富士VRS GT Sprint の再現用入力（合成）。**実測ではない。Driver報告に基づく再現用の仮定**を ASSUMPTIONS に全て記録する。
//   再現する場面：上位走行中に後ろ2台が先に入る。
//     wait_loses  … 待つと給油後の共通地点で後続(#11)に逆転される（次周に入る側の復帰先に遅い車列がいる）
//     early_loses … 早く入ると交通で損をする（今入る側の復帰先に遅い車列がいる）。待てば車列は後ろへ流れる
//   U1の標本は本物の field-snapshot.check を通る形で作る（実Bridgeが出す形式）。
//   ⚠ Driver報告の具体値（実際のギャップ・周回・燃料）は指示書に無かったため、下の数値は再現用に置いたもの。実報告があれば ASSUMPTIONS と CONST を差し替えて同じテストで再確認する。
const F = require('../../desktop/field-snapshot.js');
const U = require('../../desktop/undercut-forecast.js');

const CONST = Object.freeze({
  L: 97, burn: 2.6, tank: 60, startFuel: 60, totalLaps: 25, pit: { transit_extra_s: 12, fixed_stall_s: 10, fuel_rate_s_per_l: 0.4 },
  ownLap: 9, ownD: 0.0,           // 自車は9周目の頭(ライン通過直後。残燃料＝直前3周と同じ燃費で減った値)
  rearGaps_s: [3.0, 7.0],         // 後ろ2台（#11, #12）
  aheadGaps_s: [20, 40],          // 前の2台
  trainPace: 101, trainGaps_s: [1.5, 2.2, 2.8],
  waitTrainGaps_s: { next: [1.0, 1.8, 2.3, 2.8], limit: [0.4, 0.9, 1.5, 2.0, 2.4, 2.8] },   // wait_loses：待つ側の復帰位置に居る遅い車の数
});
const ASSUMPTIONS = Object.freeze({
  source: 'driver_report_reproduction_assumption', synthetic: true,
  statement: '富士VRS GT Sprintの場面は、Driverの報告（上位走行中に後ろ2台が先に入る）を再現するための仮定。実測値・実走ログではない。',
  items: [
    '40分のSprint。周回ペース97s（暫定）、燃費2.6L/周、タンク容量60L・開始燃料60L（満タン・暫定）、総周回25（暫定）。1回の給油停止が必要',
    '自車は9周目頭(ライン通過直後)の上位走行。後ろに#11が3.0s・#12が7.0s、前に20s・40sの車。競争相手は同クラス・同ペース(97s)',
    '遅い車の列は別クラス（ペース101s）の混走車で、競争相手ではなく復帰先の交通として扱う',
    'ピット：通過損失12s＋固定作業10s＋給油0.4s/L（rendererの校正なし時の暫定値と同じ）。燃料重量0.03s/L/周（未校正）',
    '相手の停止予定は未観測：入らず引っ張る／今周先に入る／次周先に入る を条件別に比較',
    '後続集団（8台）は自車の20〜50s後ろを同ペースで走る（復帰先の車列として全員観測できている）',
    'wait_loses：ペース101sの遅い車の列が2組（「次周」案の復帰位置に4台・「燃料の限界」案の復帰位置に6台、いずれも自車の0.4〜2.8s前）。今案の復帰位置には居ない＝待つ側の復帰先がどちらも詰まる',
    'early_loses：同じ3台が、自車が「今」案で復帰する位置に居る（次周案の復帰位置には居ない＝待てば車列は後ろへ流れる）',
    '全車を同時に観測できている前提（名簿24台＝観測24台）。「見えていない車」を足す場合は withHiddenCars で別に検証する',
  ],
});

let seq = 1000;
function mkSnapshot(spec, hiddenCars) {
  const rows = spec.cars.map(c => ({ i: c.i, no: c.no, c: c.cls || 1, r: 'car', p: null, cp: null, l: Math.floor(c.prog), lc: Math.floor(c.prog) - 1, d: Math.round((c.prog - Math.floor(c.prog)) * 1e5) / 1e5, f2: 0, est: 0, ll: c.ll, pit: 0, s: 3, st: 'ok' }));
  for (let h = 0; h < (hiddenCars || 0); h++) rows.push({ i: 40 + h, no: 'H' + h, c: 1, r: 'car', p: null, cp: null, l: null, lc: null, d: null, f2: null, est: null, ll: null, pit: null, s: -1, st: 'out' });
  const ob = rows.filter(r => r.st === 'ok').length;
  const s = { type: 'field_snapshot', schema_version: 1, seq: ++seq, race_instance_id: 'sub:SYN-FUJI', session_num: 2, bridge_process_epoch: 'e-fuji', source_frame_sequence: seq, session_time_s: 900, observed_at: 1.8e9 + 900,
    player_car_idx: 0, roster_session_num: 2, roster_update: 1, generation: 1, gen: 'consistent', ok: true, sample_interval_s: 1.0,
    counts: { target: rows.length, observed: ob, departed: rows.length - ob, missing: 0, other: 0 }, events: [], cars: rows };
  const why = F.check(s); if (why) throw new Error('fuji synthetic snapshot invalid: ' + why);
  return s;
}
// 自車が option(now|next) で復帰する時刻・位置に、遅い車の列を置く（手計算で窓内に収まるよう逆算）
function trainFor(alignTo, gaps) {
  const { L, ownLap, ownD, pit, burn, tank, totalLaps, trainPace } = CONST; const trainGaps_s = gaps || CONST.trainGaps_s;
  const p0 = ownLap + ownD, fuelNow = CONST.startFuel - burn * (p0 - 1);
  let P = alignTo === 'now' ? ownLap : ownLap + 1;
  if (alignTo === 'limit') { P = ownLap; while (fuelNow - burn * (P + 1 + 1 - p0) >= 0.5 && P + 1 < totalLaps - 1) P++; }   // 予備を切らずに入れる最も遅い周（undercut-forecastの限界案と同じ定義）
  const X = P + 1, fe = fuelNow - burn * (P + 1 - p0), add = Math.max(0, burn * ((totalLaps + 1) - P) + 0.5 - fe);   // 総周回の高い側(+1)で必要量
  const loss = pit.transit_extra_s + pit.fixed_stall_s + pit.fuel_rate_s_per_l * add, tx = (X - p0) * L + loss;
  return { P, progress: trainGaps_s.map(g => X + g / L - tx / trainPace) };   // 現在の進行量
}
function build() {
  const out = {};
  for (const [name, align] of [['wait_loses', 'next'], ['early_loses', 'now']]) {
    const { L, ownLap, ownD, burn, tank, totalLaps, pit, rearGaps_s, aheadGaps_s, trainPace } = CONST;
    const p0 = ownLap + ownD;
    const cars = [{ i: 0, no: '77', prog: p0, ll: L }];
    rearGaps_s.forEach((g, k) => cars.push({ i: 1 + k, no: String(11 + k), prog: p0 - g / L, ll: L }));
    aheadGaps_s.forEach((g, k) => cars.push({ i: 3 + k, no: String(3 + k), prog: p0 + g / L, ll: L }));
    trainFor(align, name === 'wait_loses' ? CONST.waitTrainGaps_s.next : null).progress.forEach((pr, k) => cars.push({ i: 5 + k, no: 'T' + (k + 1), cls: 2, prog: pr, ll: trainPace }));
    if (name === 'wait_loses') trainFor('limit', CONST.waitTrainGaps_s.limit).progress.forEach((pr, k) => cars.push({ i: 20 + k, no: 'U' + (k + 1), cls: 2, prog: pr, ll: trainPace }));
    for (let k = 0; k < 8; k++) cars.push({ i: 12 + k, no: String(20 + k), prog: p0 - (20 + 4 * k) / L, ll: L });   // 後続集団
    const spec = { cars };
    const snap = mkSnapshot(spec, 0);
    const tracker = U.createTracker(); tracker.update(snap);
    const fuelNow = CONST.startFuel - burn * (p0 - 1);
    out[name] = { align, narrative: name === 'wait_loses' ? '後続#11が先に入ると、次周に入る案は復帰先の遅い車列で損をして逆転される' : '今入る案は復帰先の遅い車列で損をする。待てば車列は後ろへ流れる',
      input: { meta: { race_instance_id: snap.race_instance_id, session_num: snap.session_num },
        own: { fuel_l: { value: fuelNow, source: 'synthetic' }, fuel_per_lap_l: { value: burn, low: burn, high: burn, source: 'synthetic' }, tank_l: { value: tank, source: 'synthetic' }, reserve_l: { value: 0.5, source: 'assumed' }, lap_time_s: { value: L, source: 'synthetic' } },
        total_laps: { value: totalLaps, low: totalLaps - 1, high: totalLaps + 1, source: 'assumed' },
        pit: { transit_extra_s: { value: pit.transit_extra_s, source: 'assumed' }, fixed_stall_s: { value: pit.fixed_stall_s, source: 'assumed' }, fuel_rate_s_per_l: { value: pit.fuel_rate_s_per_l, source: 'assumed' } },
        snapshot: snap, tracker, options: {}, _spec: spec } };
  }
  return out;
}
// 同じ入力の名簿に、位置が見えない車を n 台足す（全車観測できている前提を崩す）
function withHiddenCars(input, n) {
  const snap = mkSnapshot(input._spec, n); const tracker = U.createTracker(); tracker.update(snap);
  return Object.assign({}, input, { snapshot: snap, tracker });
}
module.exports = { CONST, ASSUMPTIONS, build, withHiddenCars, trainFor };
