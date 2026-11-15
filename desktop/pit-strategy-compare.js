(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallPitStrategyCompare = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // STR-001 — 毎Lapの「通常／アンダーカット／オーバーカット」比較（方式A：決定論の周回予測＋少数の条件別B）。
  //   給油のみ・各車最大1停止。入力の各値は {value, low, high, source} を持ち、source は
  //   observed（Bridge実測）／driver_declared（Driver申告）／assumed（出典付き初期値・仮定）／synthetic（合成）のいずれか。
  //   校正前の成功確率は出さない。順位は必要な車群を投影できた時だけ出す。
  //
  //   GAPの符号：GAP = 自車の到達時刻 − 相手の到達時刻（同じ地点）。負なら自車が先。
  //   比較地点：自車の全候補と相手の全想定停止が終わった後の、最初の共通のスタート/フィニッシュライン通過（C周終了）。
  // U2/U3：全車snapshotからの「今／次周／燃料の限界」比較（undercut-forecast.js）。nodeではrequire、rendererではscriptタグ（先に読み込む）。
  const UC = (typeof require === 'function' && typeof module === 'object') ? (function () { try { return require('./undercut-forecast'); } catch (_) { return null; } }()) : ((typeof globalThis !== 'undefined' && globalThis.PitwallUndercutForecast) || null);
  const VERSION = 'str001-compare-1.0.0';
  const TIE_EPS_S = 0.1;   // 計算誤差と区別できる最小差（暫定。実測まで確定値にしない）
  const SOURCES = ['observed', 'driver_declared', 'assumed', 'synthetic'];
  const DEFAULTS = Object.freeze({
    offsets: [-3, -2, -1, 0, 1, 2],
    trafficWindowS: 3.0,
    passCostS: { value: 1.5, low: 0.5, high: 3.0, source: 'assumed' },
    fasterClassCostS: { value: 0.7, low: 0.3, high: 1.5, source: 'assumed' },
    slowerPaceThresholdS: 0.3,
    // 燃料1Lあたり、1周が何秒遅くなるか（重い車ほど遅い）。後で入る案ほど軽い時間が長い＝オーバーカット側に効く。暫定値（実測まで確定しない）。
    fuelPaceSPerL: { value: 0.03, low: 0.0, high: 0.045, source: 'assumed', note: '燃料重量による1周の遅れ(秒/L/Lap)。暫定' },
  });

  const fin = v => (v === null || v === undefined || v === '' || typeof v === 'boolean') ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
  const r3 = v => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 1000) / 1000;
  // 値の正規化：数値 or {value, low, high, source}
  function q(x, source) {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const value = fin(x.value);
      if (value === null) return null;
      const low = fin(x.low), high = fin(x.high);
      return { value, low: low === null ? value : low, high: high === null ? value : high, source: SOURCES.includes(x.source) ? x.source : (source || 'assumed'), note: x.note || null };
    }
    const value = fin(x);
    return value === null ? null : { value, low: value, high: value, source: source || 'assumed', note: null };
  }
  const hashString = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('00000000' + h.toString(16)).slice(-8); };

  // ── 手計算できる基本関数（検査が直接呼ぶ） ───────────────────────────────
  // 同じ比較地点でのGAP＝現在のGAP + 自車の所要時間 − 相手の所要時間。
  function gapAt(gapNowS, ownTimeS, rivalTimeS) { return r3((fin(gapNowS) ?? 0) + ownTimeS - rivalTimeS); }
  // 逆転に必要な秒数を、比較地点までの残りLapで割った「基準平均より速くすべき秒/Lap」と必要平均ラップ。
  function requiredPace(baselineAvgLapS, needS, laps) {
    if (!(laps > 0) || !(needS >= 0)) return null;
    const perLap = r3(needS / laps);
    return { faster_per_lap_s: perLap, required_avg_lap_s: r3(baselineAvgLapS - perLap), need_s: r3(needS), laps };
  }
  // 停止前の最終Lapを走る前の残燃料から、その1Lap分の消費と予備を引いた余裕(L)。負なら候補外。
  function fuelMargin(fuelBeforeFinalLapL, fuelPerLapL, reserveL) { return r3(fuelBeforeFinalLapL - fuelPerLapL - reserveL); }
  // 候補ごとの所要時間を渡して、通常案との差と逆転を求める（compute()もこれを使う）。
  function compareAtPoint({ gapNowS, rivalTimeS, ownTimesS, baselineId, extraS }) {
    const out = {};
    for (const id of Object.keys(ownTimesS)) {
      const t = ownTimesS[id] + ((extraS && extraS[id]) || 0);
      out[id] = { own_time_s: r3(t), gap_s: gapAt(gapNowS, t, rivalTimeS) };
    }
    const base = out[baselineId];
    const ids = Object.keys(out);
    // 通常案との差がTIE_EPS_S以内なら「差なし」＝通常案を維持（同点で別案を勧めない）。
    const best = ids.reduce((b, id) => (out[id].gap_s < out[b].gap_s - TIE_EPS_S ? id : b), baselineId);
    for (const id of ids) out[id].vs_baseline_s = r3(out[id].gap_s - base.gap_s);   // 負＝通常案より自車が前
    return { cases: out, best_case_id: best, flipped_vs_baseline: best !== baselineId };
  }

  // ── 入力の正規化 ─────────────────────────────────────────────────────────
  function normalize(input) {
    const i = input || {}, meta = i.meta || {}, own = i.own || {}, pit = i.pit || {}, opts = i.options || {};
    const n = {
      meta: { race_instance_id: meta.race_instance_id ?? null, session_num: fin(meta.session_num), car_idx: meta.car_idx ?? null,
        observed_session_s: fin(meta.observed_session_s), observed_wall: meta.observed_wall ?? null, lap: fin(meta.lap), position: fin(meta.position),
        series: meta.series ?? null, track: meta.track ?? null, car: meta.car ?? null },
      total_laps: q(i.total_laps, 'assumed'),
      own: { fuel_l: q(own.fuel_l, 'observed'), fuel_per_lap_l: q(own.fuel_per_lap_l, 'observed'), tank_l: q(own.tank_l, 'observed'), reserve_l: q(own.reserve_l, 'assumed'),
        lap_time_s: q(own.lap_time_s, 'observed'), best_clean_lap_s: q(own.best_clean_lap_s, 'observed'), max_sustainable_lap_s: q(own.max_sustainable_lap_s, 'driver_declared') },
      fuel_pace: opts.fuel_pace_s_per_l_per_lap === undefined ? { ...DEFAULTS.fuelPaceSPerL } : (q(opts.fuel_pace_s_per_l_per_lap, 'assumed') || { value: 0, low: 0, high: 0, source: 'assumed', note: null }),
      pit: { transit_extra_s: q(pit.transit_extra_s, 'assumed'), fixed_stall_s: q(pit.fixed_stall_s, 'assumed'), fuel_rate_s_per_l: q(pit.fuel_rate_s_per_l, 'assumed') },
      baseline_pit_lap: fin(i.baseline_pit_lap), baseline_source: i.baseline_source || null,
      field: (Array.isArray(i.field) ? i.field : []).map(c => ({ id: String(c.id), label: c.label ?? String(c.id), class_rel: c.class_rel || 'same',
        gap_s: q(c.gap_s, 'observed'), lap_time_s: q(c.lap_time_s, 'assumed'), stops_done: fin(c.stops_done) ?? 0, on_pit: c.on_pit === true, declared_pit: c.declared_pit === true,
        stop_lap: fin(c.stop_lap), stop_lap_source: c.stop_lap_source || null, is_target: c.is_target === true })),
      field_complete: i.field_complete === true,
      traffic: { window_s: fin(opts.traffic_window_s) ?? DEFAULTS.trafficWindowS, pass_cost_s: q(opts.pass_cost_s, 'assumed') || { ...DEFAULTS.passCostS },
        faster_class_cost_s: q(opts.faster_class_cost_s, 'assumed') || { ...DEFAULTS.fasterClassCostS }, extra_s: q(opts.traffic_extra_s, 'driver_declared'),
        extra_plan_ids: Array.isArray(opts.traffic_extra_plan_ids) ? opts.traffic_extra_plan_ids : null },
      offsets: Array.isArray(opts.offsets) && opts.offsets.length ? opts.offsets.map(Number).filter(Number.isFinite) : DEFAULTS.offsets.slice(),
      declined_plan_ids: Array.isArray(i.declined_plan_ids) ? i.declined_plan_ids : [],
      driver_assumptions: Array.isArray(i.driver_assumptions) ? i.driver_assumptions : [],
      rival_stop_resolved: i.rival_stop_resolved || {},
    };
    return n;
  }

  const PLAN_NAME = (offset) => offset < 0 ? 'undercut' : offset > 0 ? 'overcut' : 'normal';

  // ── 本体 ────────────────────────────────────────────────────────────────
  function compute(rawInput) {
    const n = normalize(rawInput);
    const missing = [];
    const need = (cond, key) => { if (!cond) missing.push(key); };
    need(n.meta.lap !== null && n.meta.lap >= 1, 'meta.lap');
    need(n.own.fuel_l, 'own.fuel_l'); need(n.own.fuel_per_lap_l && n.own.fuel_per_lap_l.value > 0, 'own.fuel_per_lap_l');
    need(n.own.lap_time_s && n.own.lap_time_s.value > 0, 'own.lap_time_s'); need(n.total_laps && n.total_laps.value > 0, 'total_laps');
    need(n.own.tank_l, 'own.tank_l'); need(n.pit.transit_extra_s && n.pit.fixed_stall_s && n.pit.fuel_rate_s_per_l, 'pit.{transit_extra_s,fixed_stall_s,fuel_rate_s_per_l}');
    const base = { schema: 'pit_strategy_compare', calc_version: VERSION, race: { race_instance_id: n.meta.race_instance_id, session_num: n.meta.session_num },
      observed_at: { session_time_s: n.meta.observed_session_s, wall: n.meta.observed_wall, lap: n.meta.lap, position: n.meta.position },
      gap_sign: 'gap = own_arrival - rival_arrival at the same point; negative = own car is ahead' };
    if (missing.length) {
      const packet = Object.assign(base, { comparable: false, blocking: missing.map(k => 'missing_input:' + k), cases: [], recommendation: null, safe_candidates: [],
        required_conditions: missing, inputs: describeInputs(n), unmeasured: unmeasured(n) });
      packet.calc_id = hashString(JSON.stringify(packet)); return packet;
    }
    const lap = n.meta.lap, L = n.own.lap_time_s, fpl = n.own.fuel_per_lap_l, reserve = (n.own.reserve_l || { value: 0.5, low: 0.5, high: 0.5, source: 'assumed' }).value;
    const tank = n.own.tank_l.value, fuelNow = n.own.fuel_l.value, total = n.total_laps;
    const rate = n.pit.fuel_rate_s_per_l;
    const addTime = (add, side) => n.pit.fixed_stall_s[side] + rate[side] * add;   // side: value|low|high
    const lossOf = (add, side) => n.pit.transit_extra_s[side] + addTime(add, side);

    // 1) 候補周の列挙（燃料）
    const lastFeasible = (() => { // 参考情報：予備を切らずにピットへ入れる最も遅い周（通常案の定義には使わない）
      let p = lap; while (fuelNow - fpl.high * (p - lap + 2) >= reserve && p < total.value) p++; return p; })();
    // 通常案＝現行の燃料計画が示す有効な通常ピット周、または出所つきの暫定の比較基準。燃料の限界周は通常案にしない。無ければ比較を保留する。
    if (n.baseline_pit_lap === null) {
      const packet = Object.assign(base, { comparable: false, blocking: ['baseline_unavailable'], cases: [], recommendation: null,
        safe_candidates: baseLapOk(n, lastFeasible) ? [{ pit_lap: lastFeasible, reason: 'latest_lap_that_keeps_reserve_to_pit_entry(参考。通常案ではない)' }] : [],
        required_conditions: ['現行の燃料計画の通常ピット周、または出所つきの暫定の比較基準が必要'], inputs: describeInputs(n), unmeasured: unmeasured(n) });
      packet.calc_id = hashString(JSON.stringify(packet)); return packet;
    }
    const baselineLap = n.baseline_pit_lap;
    const candidates = [];
    for (const off of n.offsets) {
      const P = baselineLap + off;
      const id = off === 0 ? 'normal' : (off < 0 ? 'under' + (-off) : 'over' + off);
      const c = { id, kind: PLAN_NAME(off), offset_laps: off, pit_lap: P, excluded: null };
      const lapsIn = P - lap + 1;                                    // 停止までに走る周数（P周の終わりで入る）
      const fuelBeforeFinal = fuelNow - fpl.high * (lapsIn - 1);     // 最終周に入る前の残燃料（消費は高い側＝安全側）
      const entry = fuelNow - fpl.value * lapsIn;
      c.fuel_at_entry_l = r3(entry); c.fuel_margin_l = fuelMargin(fuelBeforeFinal, fpl.high, reserve);
      if (P < lap) c.excluded = 'pit_lap_already_passed';
      else if (P >= total.value) c.excluded = 'pit_lap_not_before_finish';
      else if (c.fuel_margin_l < 0) c.excluded = 'fuel_insufficient_to_reach_pit';
      else if (n.declined_plan_ids.includes(id) || n.declined_plan_ids.includes(c.kind)) c.excluded = 'driver_declined';
      else {
        const after = total.high - P;                                // 停止後の残り周（高い側）
        const needFuel = fpl.high * after + reserve;
        const add = Math.max(0, needFuel - (fuelNow - fpl.high * lapsIn));
        c.add_l = r3(add);
        if (fuelNow - fpl.high * lapsIn + add > tank + 1e-9 || add > tank) { c.excluded = 'cannot_finish_with_one_stop'; c.add_l = r3(Math.min(add, tank)); }
        c.service_s = r3(addTime(add, 'value')); c.pit_loss_s = { value: r3(lossOf(add, 'value')), low: r3(lossOf(add, 'low')), high: r3(lossOf(add, 'high')) };
        c.pit_loss_parts = { transit_extra_s: n.pit.transit_extra_s.value, fixed_stall_s: n.pit.fixed_stall_s.value, fuel_s: r3(rate.value * add), source: 'transit/stall/rate: see inputs' };
        c.fuel_margin_laps_after_l = r3(fuelNow - fpl.value * lapsIn + add - fpl.value * after);
      }
      candidates.push(c);
    }
    const live = candidates.filter(c => !c.excluded);
    const baseCase = candidates.find(c => c.id === 'normal');
    if (!live.length || !baseCase || baseCase.excluded) {
      const safe = [];
      if (baseLapOk(n, lastFeasible)) safe.push({ pit_lap: lastFeasible, reason: 'latest_lap_that_keeps_reserve_to_pit_entry' });
      const packet = Object.assign(base, { comparable: false, blocking: baseCase && baseCase.excluded ? ['baseline_excluded:' + baseCase.excluded] : ['no_feasible_candidate'],
        cases: candidates, recommendation: null, safe_candidates: safe, required_conditions: ['baseline pit lap must be reachable with reserve and able to finish with one stop'],
        inputs: describeInputs(n), unmeasured: unmeasured(n) });
      packet.calc_id = hashString(JSON.stringify(packet)); return packet;
    }

    // 2) 想定する相手の停止（未観測は 早い／遅い の条件別。観測済みはその事実）
    const earliest = Math.min(...live.map(c => c.pit_lap)), latest = Math.max(...live.map(c => c.pit_lap));
    const target = n.field.find(c => c.is_target) || n.field.filter(c => c.gap_s && c.gap_s.value > 0).sort((a, b) => a.gap_s.value - b.gap_s.value)[0] || n.field[0] || null;
    const scenariosFor = c => {
      if (c.stops_done >= 1) return [{ id: 'rival_already_stopped', stop_lap: null, basis: 'observed' }];
      if (c.on_pit) return [{ id: 'rival_in_pit_now', stop_lap: lap, basis: 'observed' }];
      if (c.declared_pit) return [{ id: 'rival_pitted_declared', stop_lap: lap, basis: 'driver_declared' }];   // Driver申告は観測へ昇格させない
      const res = n.rival_stop_resolved[c.id];
      if (res) return [{ id: 'rival_stops_lap_' + res, stop_lap: res, basis: 'driver_declared' }];
      if (c.stop_lap !== null) return [{ id: 'rival_stops_lap_' + c.stop_lap, stop_lap: c.stop_lap, basis: c.stop_lap_source || 'assumed' }];
      return [{ id: 'rival_stops_early', stop_lap: Math.max(lap, earliest - 1), basis: 'assumed' }, { id: 'rival_stops_late', stop_lap: Math.min(total.value - 1, latest + 1), basis: 'assumed' }];
    };
    const stopLaps = [...live.map(c => c.pit_lap)];
    for (const c of n.field) for (const s of scenariosFor(c)) if (s.stop_lap !== null) stopLaps.push(s.stop_lap);
    // 比較地点＝全想定停止の後の最初の共通ライン。完走までに成立しない時は、完走周へ切り詰めて成立扱いにせず比較不可にする。
    const compLap = Math.max(...stopLaps) + 1;
    if (compLap > total.value) {
      const packet = Object.assign(base, { comparable: false, blocking: ['comparison_line_after_finish: 全候補と想定停止が終わる共通ライン(' + compLap + '周終了)が完走(' + total.value + '周)までに成立しない'],
        cases: candidates, recommendation: null, safe_candidates: [], required_conditions: ['相手の想定停止周を完走前にする、または比較対象の相手を変える'], inputs: describeInputs(n), unmeasured: unmeasured(n) });
      packet.calc_id = hashString(JSON.stringify(packet)); return packet;
    }
    const nC = compLap - lap + 1;

    // 3) 交通：自車の復帰時刻と各車の通過時刻の関係（観測できた車だけ）
    // override={id, stop_lap}：比較している相手の想定停止。その相手が自車の復帰前に停止済みなら時刻が損失ぶん後ろへずれて窓から出る／同時なら復帰時の車列に含めない／後なら窓に残る。
    //   他の車は、観測/申告で停止が分かっている場合を除き「コース上にいる」と仮定（assumed）。
    const trafficFor = (c, side, override) => {
      const lapsIn = c.pit_lap - lap + 1, tOwn = lapsIn * L.value + lossOf(c.add_l, side);
      let cost = 0; const ahead = [], behind = [];
      for (const j of n.field) {
        if (!j.gap_s || !j.lap_time_s) continue;
        let stopLap = null;
        if (override && override.id === j.id) stopLap = override.stop_lap;
        else if (j.on_pit || j.declared_pit) stopLap = lap;
        else if (j.stop_lap !== null && (j.stop_lap_source === 'observed' || j.stop_lap_source === 'driver_declared')) stopLap = j.stop_lap;
        if (stopLap !== null && stopLap === c.pit_lap) continue;               // 同じ周に入る＝復帰時の車列に含めない
        const shift = stopLap !== null && stopLap < c.pit_lap ? lossOf(baseCase.add_l, side) + n.fuel_pace[side] * baseCase.add_l * (c.pit_lap - stopLap) : 0;
        const tJ = -j.gap_s.value + lapsIn * j.lap_time_s.value + shift;      // 相手が同じ地点を通る時刻（今を0として）
        const rel = tOwn - tJ;                                                  // >0 なら相手が先
        const slower = j.lap_time_s.value - L.value >= DEFAULTS.slowerPaceThresholdS;
        if (rel > 0 && rel <= n.traffic.window_s) { ahead.push({ id: j.id, gap_s: r3(rel), class_rel: j.class_rel }); if (slower || j.class_rel === 'slower') cost += n.traffic.pass_cost_s[side]; }
        else if (rel <= 0 && -rel <= n.traffic.window_s) { behind.push({ id: j.id, gap_s: r3(-rel), class_rel: j.class_rel }); if (j.class_rel === 'faster') cost += n.traffic.faster_class_cost_s[side]; }
      }
      const extra = n.traffic.extra_s && (!n.traffic.extra_plan_ids || n.traffic.extra_plan_ids.includes(c.id) || n.traffic.extra_plan_ids.includes(c.kind)) ? n.traffic.extra_s[side] : 0;
      return { cost: cost + extra, ahead, behind, extra };
    };
    const rivalTime = (j, sc, side) => {
      const stops = sc.stop_lap !== null && sc.stop_lap <= compLap;
      const loss = stops ? lossOf(baseCase.add_l, side) : 0;   // 相手の給油量は不明＝通常案と同じ量を仮定（assumed）
      const weight = stops ? n.fuel_pace[side] * baseCase.add_l * (compLap - sc.stop_lap) : 0;   // 相手も補給後は重い
      return nC * j.lap_time_s.value + loss + weight;
    };

    // 4) 候補×相手想定ごとの比較
    const rivals = n.field.filter(j => j.gap_s && j.lap_time_s);
    const vs = {};   // candidateId -> [{rival, scenario, gap, ...}]
    const perRivalScenario = [];
    for (const j of rivals) {
      for (const sc of scenariosFor(j)) {
        const sides = {};
        for (const side of ['value', 'low', 'high']) {
          const ownTimes = {}, extra = {};
          for (const c of live) { const tf = trafficFor(c, side, { id: j.id, stop_lap: sc.stop_lap }); ownTimes[c.id] = nC * L.value + lossOf(c.add_l, side) + n.fuel_pace[side] * c.add_l * (compLap - c.pit_lap); extra[c.id] = tf.cost; }
          sides[side] = compareAtPoint({ gapNowS: j.gap_s.value, rivalTimeS: rivalTime(j, sc, side), ownTimesS: ownTimes, baselineId: 'normal', extraS: extra });
        }
        perRivalScenario.push({ rival: j, scenario: sc, sides });
      }
    }
    const caseOut = candidates.map(c => {
      if (c.excluded) return { ...c, comparisons: [] };
      const tfC = trafficFor(c, 'value', null);
      const comparisons = perRivalScenario.map(({ rival, scenario, sides }) => {
        const tfS = trafficFor(c, 'value', { id: rival.id, stop_lap: scenario.stop_lap });
        const v = sides.value.cases[c.id], lo = sides.low.cases[c.id], hi = sides.high.cases[c.id];
        const need = v.gap_s > 0 ? v.gap_s : 0;
        const lapsGain = compLap - c.pit_lap;
        const rp = requiredPace(L.value, need, lapsGain);
        const declared = n.own.max_sustainable_lap_s;
        const exceeds = !!(rp && declared && rp.required_avg_lap_s < declared.value - 1e-9);
        return { rival_id: rival.id, scenario: scenario.id, scenario_basis: scenario.basis, gap_s: v.gap_s, gap_range_s: [Math.min(lo.gap_s, hi.gap_s, v.gap_s), Math.max(lo.gap_s, hi.gap_s, v.gap_s)],
          vs_baseline_s: v.vs_baseline_s, vs_baseline_range_s: [Math.min(lo.vs_baseline_s, hi.vs_baseline_s, v.vs_baseline_s), Math.max(lo.vs_baseline_s, hi.vs_baseline_s, v.vs_baseline_s)],
          own_ahead_at_comparison: v.gap_s < 0, rejoin: { ahead: tfS.ahead, behind: tfS.behind, traffic_loss_s: r3(tfS.cost) }, required_pace: rp ? { ...rp, vs_best_clean_s: n.own.best_clean_lap_s ? r3(rp.required_avg_lap_s - n.own.best_clean_lap_s.value) : null, exceeds_declared_limit: exceeds } : null };
      });
      return { ...c, rejoin: { ahead: tfC.ahead, behind: tfC.behind, traffic_loss_s: r3(tfC.cost), traffic_extra_declared_s: tfC.extra ? r3(tfC.extra) : 0 }, comparisons };
    });

    // 5) 推奨：相手の想定ごとの最良案のうち、最悪ケースの差が小さい案。想定で最良案が変わるなら反転条件を返す。
    const worstGap = {};
    const bestByScenario = [];
    for (const { rival, scenario, sides } of perRivalScenario) {
      bestByScenario.push({ rival_id: rival.id, scenario: scenario.id, best_case_id: sides.value.best_case_id });
    }
    for (const c of caseOut) {
      if (c.excluded) continue;
      const usable = c.comparisons.filter(x => !(x.required_pace && x.required_pace.exceeds_declared_limit && x.gap_s > 0));
      worstGap[c.id] = { worst: c.comparisons.length ? Math.max(...c.comparisons.map(x => x.gap_s)) : null, within_declared_pace: usable.length === c.comparisons.length };
    }
    const eligible = caseOut.filter(c => !c.excluded && worstGap[c.id].worst !== null);
    const ranked = eligible.slice().sort((a, b) => (worstGap[a.id].within_declared_pace === worstGap[b.id].within_declared_pace ? 0 : worstGap[a.id].within_declared_pace ? -1 : 1)
      || (Math.abs(worstGap[a.id].worst - worstGap[b.id].worst) > TIE_EPS_S ? worstGap[a.id].worst - worstGap[b.id].worst : 0) || Math.abs(a.offset_laps) - Math.abs(b.offset_laps));
    const best = ranked[0] || null, next = ranked[1] || null;
    const flips = [];
    if (best) for (const b of bestByScenario) if (b.best_case_id !== best.id) flips.push({ condition: b.scenario + (b.rival_id ? '(' + b.rival_id + ')' : ''), best_case_id: b.best_case_id });
    const baseWorst = worstGap.normal ? worstGap.normal.worst : null;
    const recommendation = best ? {
      case_id: best.id, kind: best.kind, pit_lap: best.pit_lap, add_l: best.add_l, decide_by_lap: Math.max(lap, best.pit_lap - 1),
      basis: 'minimax_gap_at_comparison_point', worst_case_gap_s: r3(worstGap[best.id].worst), baseline_worst_case_gap_s: baseWorst === null ? null : r3(baseWorst),
      improves_on_baseline_s: baseWorst === null ? null : r3(baseWorst - worstGap[best.id].worst),
      within_declared_pace: worstGap[best.id].within_declared_pace,
      next_best: next ? { case_id: next.id, pit_lap: next.pit_lap, worst_case_gap_s: r3(worstGap[next.id].worst) } : null,
      flips_when: flips, success_probability: null, success_probability_note: '校正前のため出さない',
    } : null;
    const excluded = caseOut.filter(c => c.excluded).map(c => ({ case_id: c.id, pit_lap: c.pit_lap, reason: c.excluded }));

    // 6) 絶対順位：必要な車群を投影できた時だけ
    let rank = { value: null, basis: 'field_incomplete', known_cars: rivals.length };
    if (n.field_complete && best) {
      const tOwn = nC * L.value + lossOf(best.add_l, 'value') + trafficFor(best, 'value', null).cost;
      let ahead = 0;
      for (const j of n.field) { if (!j.gap_s || !j.lap_time_s) { ahead = null; break; } const sc = scenariosFor(j)[0]; if (-j.gap_s.value + rivalTime(j, sc, 'value') < tOwn) ahead++; }
      if (ahead !== null) rank = { value: ahead + 1, basis: 'all_cars_projected', known_cars: n.field.length };
    }

    // 燃料重量係数は未校正の試算値。係数0・中央値・上限で推奨を比べ、優劣が反転するなら条件付きで示す。
    let sensitivity = null;
    if (!rawInput._noSensitivity && n.fuel_pace.high !== n.fuel_pace.low) {
      const kv = [{ k: 0, label: 'k=0(燃料重量なし)' }, { k: n.fuel_pace.value, label: 'k=' + n.fuel_pace.value + '(中央値)' }, { k: n.fuel_pace.high, label: 'k=' + n.fuel_pace.high + '(上限)' }];
      sensitivity = { fuel_weight: kv.map(x => {
        const alt = compute(Object.assign({}, rawInput, { _noSensitivity: true, options: Object.assign({}, rawInput.options || {}, { fuel_pace_s_per_l_per_lap: { value: x.k, low: x.k, high: x.k, source: 'assumed' } }) }));
        return { k_s_per_l_per_lap: x.k, label: x.label, best_case_id: alt.recommendation ? alt.recommendation.case_id : null, improves_on_baseline_s: alt.recommendation ? alt.recommendation.improves_on_baseline_s : null };
      }) };
      const ids = new Set(sensitivity.fuel_weight.map(x => x.best_case_id));
      if (recommendation) {
        recommendation.conditional_on_fuel_weight = ids.size > 1;
        if (ids.size > 1) for (const x of sensitivity.fuel_weight) if (x.best_case_id !== recommendation.case_id) recommendation.flips_when.push({ condition: x.label, best_case_id: x.best_case_id });
      }
    }
    const packet = Object.assign(base, {
      sensitivity,
      comparable: true, comparison_point: { lap: compLap, definition: 'start_finish_line_after_all_candidate_and_assumed_rival_stops', laps_from_now: nC },
      target: target ? { id: target.id, label: target.label, gap_now_s: target.gap_s ? target.gap_s.value : null } : null,
      baseline: { case_id: 'normal', pit_lap: baseCase.pit_lap, add_l: baseCase.add_l, derived_from: n.baseline_source || 'unspecified' },
      inputs: describeInputs(n), cases: caseOut, excluded, recommendation, absolute_rank: rank,
      driver_assumptions: n.driver_assumptions, expires: { valid_until_lap: lap + 1, decide_by_lap: recommendation ? recommendation.decide_by_lap : null },
      unmeasured: unmeasured(n),
    });
    packet.calc_id = hashString(JSON.stringify(packet));
    return packet;
  }
  const baseLapOk = (n, lastFeasible) => Number.isFinite(lastFeasible) && n.meta.lap !== null && lastFeasible >= n.meta.lap;

  function describeInputs(n) {
    const rows = [];
    const add = (key, x, unit) => { if (x) rows.push({ key, value: x.value, low: x.low, high: x.high, unit: unit || null, source: x.source, note: x.note || null }); };
    add('own.fuel_l', n.own.fuel_l, 'L'); add('own.fuel_per_lap_l', n.own.fuel_per_lap_l, 'L/lap'); add('own.tank_l', n.own.tank_l, 'L'); add('own.reserve_l', n.own.reserve_l, 'L');
    add('own.lap_time_s', n.own.lap_time_s, 's'); add('own.best_clean_lap_s', n.own.best_clean_lap_s, 's'); add('own.max_sustainable_lap_s', n.own.max_sustainable_lap_s, 's');
    add('total_laps', n.total_laps, 'lap');
    add('pit.transit_extra_s', n.pit.transit_extra_s, 's'); add('pit.fixed_stall_s', n.pit.fixed_stall_s, 's'); add('pit.fuel_rate_s_per_l', n.pit.fuel_rate_s_per_l, 's/L');
    add('own.fuel_pace_s_per_l_per_lap', n.fuel_pace, 's/L/lap'); add('traffic.pass_cost_s', n.traffic.pass_cost_s, 's'); add('traffic.faster_class_cost_s', n.traffic.faster_class_cost_s, 's'); add('traffic.extra_s', n.traffic.extra_s, 's');
    for (const j of n.field) { add('field.' + j.id + '.gap_s', j.gap_s, 's'); add('field.' + j.id + '.lap_time_s', j.lap_time_s, 's'); }
    return rows;
  }
  function unmeasured(n) {
    const u = [];
    if (!n.field_complete) u.push('全車の位置・ペースが揃っていない（観測できた隣接車のみ）。絶対順位は出さない');
    for (const j of n.field) if (j.lap_time_s && j.lap_time_s.source !== 'observed') u.push('相手(' + j.id + ')のペースは' + j.lap_time_s.source + '（自車の最近ペースを仮定）');
    if (n.field.some(j => !j.stop_lap && j.stops_done === 0 && !j.on_pit)) u.push('相手の停止時期は未観測。早い/遅いの条件別に比較');
    u.push('相手の給油量・タイヤ作業は不明（通常案と同じ量を仮定）');
    u.push('モデル範囲：給油のみ。案の差は ①復帰時の交通 ②燃料重量による遅れ(' + (n.fuel_pace.source) + ') ③相手の停止時期 から生じる。タイヤ・インラップ/アウトラップのペース差は入っていない');
    return u;
  }

  // ── Driverの意見 → 仮定の更新（同じ相談から計算へ戻す） ─────────────────────
  //   意見は観測にしない。source='driver_declared' の仮定として記録し、計算版が変わる。
  function parseDriverOpinion(text) {
    const t = String(text || '');
    if (/(?:前|前走車|前の車).{0,6}(?:詰ま|つまっ|混んで|渋滞|遅い)|トラフィック|交通.{0,4}(?:多|混)/.test(t)) {
      const under = /アンダー|早め|早く/.test(t), over = /オーバー|遅め|引っ張/.test(t);
      return { kind: 'traffic', extra_s: { value: 3, low: 1.5, high: 5, source: 'driver_declared' }, plan_ids: under ? ['under1', 'under2', 'under3', 'undercut'] : over ? ['over1', 'over2', 'overcut'] : null, text: t };
    }
    if (/(?:その|そんな)?ペース.{0,6}(?:厳し|きつ|無理|出せない|保てない)|(?:厳し|きつ).{0,4}ペース|1[:：]\d\d.{0,6}(?:無理|厳し)/.test(t)) return { kind: 'pace_limit', text: t };
    if (/(?:前|相手|あいつ|その車).{0,6}(?:ピット(?:に)?入っ|ピットイン(?:した|してる)|入った)/.test(t)) return { kind: 'rival_pitted', text: t };
    if (/(?:前|相手|あいつ|その車).{0,8}(?:まだ|当分).{0,6}(?:入らない|ステイアウト|入らなさそう)/.test(t)) return { kind: 'rival_stays_out', text: t };
    const rej = t.match(/(アンダーカット|オーバーカット|アンダー|オーバー).{0,8}(?:は|も)?(?:嫌|いや|やめ|やらない|なし|無し|使わない)/);
    if (rej) return { kind: 'reject_plan', plan: /アンダー/.test(rej[1]) ? 'undercut' : 'overcut', text: t };
    // 「じゃあ次周なら？」「今入ったら？」「限界まで待つと？」「12周目に入ったら」「後ろが先に入ったら？」＝比較の焦点を変える質問（仮定ではなく、同じ入力の別の見方）
    const foc = UC && UC.parseFocus ? UC.parseFocus(t) : null;
    if (foc) return { kind: 'undercut_focus', focus: foc, text: t };
    return null;
  }
  function applyDriverOpinion(input, op, ctx) {
    if (!op) return input;
    // 焦点（「じゃあ次周なら？」）は仮定ではなく同じ入力の別の見方。STR-001の入力・driver_assumptionsは変えない（計算版を動かさない）。
    if (op.kind === 'undercut_focus') return input;
    const next = JSON.parse(JSON.stringify(input));
    next.driver_assumptions = (next.driver_assumptions || []).concat([{ kind: op.kind, text: op.text || null, at_lap: ctx && ctx.lap !== undefined ? ctx.lap : null, source: 'driver_declared' }]);
    next.options = next.options || {};
    if (op.kind === 'traffic') { next.options.traffic_extra_s = op.extra_s; next.options.traffic_extra_plan_ids = op.plan_ids; }
    else if (op.kind === 'pace_limit') { const L = q(next.own && next.own.lap_time_s, 'observed'); if (L) { next.own.max_sustainable_lap_s = { value: L.value, low: L.value, high: L.value, source: 'driver_declared', note: 'Driver申告：最近の平均ペースより速くは保てない' }; } }
    else if (op.kind === 'rival_pitted') { const t = (next.field || []).find(c => c.is_target) || (next.field || [])[0]; if (t) { t.declared_pit = true; } }   // 申告は観測へ昇格させない（on_pitにしない）
    else if (op.kind === 'rival_stays_out') { const t = (next.field || []).find(c => c.is_target) || (next.field || [])[0]; if (t) { t.stop_lap = (ctx && ctx.total_laps ? ctx.total_laps - 1 : null); t.stop_lap_source = 'driver_declared'; } }
    else if (op.kind === 'reject_plan') next.declined_plan_ids = (next.declined_plan_ids || []).concat([op.plan]);
    return next;
  }

  // 暫定の比較基準（現行の燃料計画が使えない時）：残りを均等に分ける2スティント＝総周回の半分の周。燃料の限界周ではない。出所は 'provisional_even_split'（assumed）。
  function provisionalBaselineLap(lap, totalLapsValue) {
    if (!(totalLapsValue > 0) || !(lap >= 1)) return null;
    return Math.max(lap, Math.round(totalLapsValue / 2));
  }
  // ── U2/U3：undercut-forecast の結果をパケットへ付ける ────────────────────────────────
  //   STR-001の比較が成立しない時でも、全車snapshotからの比較が成立していれば相談に使える（packetUsable）。
  //   calc_id は付けた後の中身全体のhash（付け替えると再計算される）。
  function attachUndercut(packet, section) {
    if (!packet || typeof packet !== 'object') return packet;
    const { calc_id, ...rest } = packet;
    const next = Object.assign({}, rest); delete next.undercut_forecast;
    if (section) next.undercut_forecast = section;
    next.calc_id = hashString(JSON.stringify(next));
    return next;
  }
  const packetUsable = p => !!p && (p.comparable === true || !!(p.undercut_forecast && p.undercut_forecast.comparable === true));
  // ── 検証（server/rendererが使う）・LUNAへ渡す形 ──────────────────────────────
  function validatePacket(p, ctx) {
    const c = ctx || {};
    const bad = [];
    if (!p || typeof p !== 'object') return { ok: false, reasons: ['not_object'] };
    if (p.schema !== 'pit_strategy_compare') bad.push('schema');
    if (p.calc_version !== VERSION) bad.push('calc_version');
    if (!p.calc_id || !/^[0-9a-f]{8}$/.test(String(p.calc_id))) bad.push('calc_id');
    else if (!verifyCalcId(p)) bad.push('calc_id_mismatch');
    if (c.race_instance_id !== undefined && c.race_instance_id !== null && (!p.race || p.race.race_instance_id !== c.race_instance_id)) bad.push('race_mismatch');
    if (c.session_num !== undefined && c.session_num !== null && (!p.race || p.race.session_num !== c.session_num)) bad.push('session_mismatch');
    if (c.requireLap === true && !Number.isFinite(c.lap)) bad.push('no_current_lap');
    if (Number.isFinite(c.lap) && p.expires && Number.isFinite(p.expires.valid_until_lap) && c.lap > p.expires.valid_until_lap) bad.push('stale_lap');
    if (p.undercut_forecast) {
      const u = p.undercut_forecast;
      if (u.schema !== 'undercut_forecast') bad.push('undercut_schema');
      else {
        if (!UC) bad.push('undercut_module_missing');   // 検証できないなら通さない（fail-closed）
        else if (u.version !== UC.VERSION) bad.push('undercut_version');
        if (c.race_instance_id !== undefined && c.race_instance_id !== null && (!u.race || u.race.race_instance_id !== c.race_instance_id)) bad.push('undercut_race_mismatch');
        if (c.session_num !== undefined && c.session_num !== null && (!u.race || u.race.session_num !== c.session_num)) bad.push('undercut_session_mismatch');
        if (Number.isFinite(c.lap) && u.expires && Number.isFinite(u.expires.valid_until_lap) && c.lap > u.expires.valid_until_lap) bad.push('undercut_stale_lap');
        if (u.comparable === true) {
          if (!Array.isArray(u.options) || !u.options.length || !u.decision) bad.push('undercut_no_options');
          if (!Array.isArray(u.inputs) || !u.inputs.every(r => SOURCES.includes(r.source) || r.source === 'dead_reckoned')) bad.push('undercut_input_source_label');
          if (u.decision && u.decision.recommendation && u.decision.recommendation.success_probability !== null) bad.push('uncalibrated_probability');
          if (u.coverage && u.coverage.clear_claim_allowed === false && (u.options || []).some(o => o.rejoin && o.rejoin.clear === true)) bad.push('undercut_clear_claim_with_unobserved');
        }
      }
    }
    if (p.comparable === true) {
      if (!Array.isArray(p.cases) || !p.cases.length) bad.push('no_cases');
      if (!Array.isArray(p.inputs) || !p.inputs.every(r => SOURCES.includes(r.source))) bad.push('input_source_label');
      if (p.recommendation && p.recommendation.success_probability !== null) bad.push('uncalibrated_probability');
    }
    return { ok: bad.length === 0, reasons: bad };
  }
  // ── LUNAの返答に出てよい数値＝送ったパケットの数値。ただし「単位」だけでなく「項目」と「現況/予測」ごとに別の集合 ──
  //   周：基準/推奨のピット周・判断期限・比較ライン・周数。L：現燃料・追加給油・入口の燃料・余裕・燃費・タンク。秒：現GAP・予測GAP・ピットロス・交通・ペース。順位：absolute_rankが出た時だけ。
  //   項目が違う数値の偶然の一致（追加給油14.5Lを「残り燃料14.5リットル」と言う等）を、文脈語で項目を特定できる時は通さない。文脈が特定できない時は、その単位の全項目の和集合で照合する。
  //   意味の正しさ（その数値をその条件で言っているか）はここでは保証しない。
  const ITEM_ROLE = { 'litre:now': 'litre', 'litre:add': 'litre', 'litre:entry': 'litre', 'litre:margin': 'litre', 'litre:burn': 'litre', 'litre:tank': 'litre',
    'sec:gapNow': 'gap', 'sec:gapPred': 'gap', 'sec:pitLoss': 'sec', 'sec:traffic': 'sec', 'sec:pace': 'sec', 'lap:pit': 'lap', 'lap:decide': 'lap', 'lap:count': 'lap' };
  function itemOfPath(part, keys, key) {
    const path = keys.concat([key]).join('.');
    if (/(^|\.)add_l$/.test(path)) return 'litre:add';
    if (/fuel_at_entry_l$/.test(path)) return 'litre:entry';
    if (/fuel_margin(_laps_after)?_l$/.test(path)) return 'litre:margin';
    if (/pit_loss_s\.|(^|\.)service_s$|pit_loss_parts\./.test(path)) return 'sec:pitLoss';
    if (/traffic_loss_s(\.|$)|traffic_extra_declared_s$/.test(path)) return 'sec:traffic';
    if (/required_pace\.laps$/.test(path)) return 'lap:count';
    if (/required_pace\.|faster_per_lap_s$|required_avg_lap_s$|vs_best_clean_s$|(^|\.)need_s$/.test(path)) return 'sec:pace';
    if (/(^|\.)own\.fuel_l$/.test(path)) return 'litre:now';
    if (/(^|\.)own\.lap_time_s$|rivals\.pace_s$/.test(path)) return 'sec:pace';
    if (/pit_lap$|rival_stop_lap$|common_point_lap$|common_point_lap_all_options$/.test(path)) return 'lap:pit';
    if (/decide_by_lap$|valid_until_lap$/.test(path)) return 'lap:decide';
    if (/laps_from_now$|(^|\.)lap$/.test(path)) return 'lap:count';
    if (part === 'target' && /gap_now_s$/.test(path)) return 'sec:gapNow';
    if (/(^|\.)rivals\.gap_now_s$/.test(path)) return 'sec:gapNow';
    if (/rejoin\.(ahead|behind)\./.test(path)) return 'sec:gapPred';
    if (/gap_s$|gap_now_s$|vs_baseline_s$|worst_case_gap_s$|improves_on_baseline_s$|_range_s/.test(path)) return 'sec:gapPred';
    return null;
  }
  const INPUT_ITEM = [[/^own\.fuel_l$/, 'litre:now'], [/^own\.fuel_per_lap_l$/, 'litre:burn'], [/^own\.(tank_l|reserve_l)$/, 'litre:tank'], [/^total_laps$/, 'lap:count'],
    [/^(own\.(lap_time_s|best_clean_lap_s|max_sustainable_lap_s)|field\.[^.]+\.lap_time_s)$/, 'sec:pace'], [/^pit\./, 'sec:pitLoss'], [/^traffic\./, 'sec:traffic'], [/^field\.[^.]+\.gap_s$/, 'sec:gapNow']];
  function numberSets(p) {
    const sets = { lap: new Set(), litre: new Set(), sec: new Set(), gap: new Set(), pos: new Set() };
    for (const it of Object.keys(ITEM_ROLE)) sets[it] = new Set();
    const addTo = (setName, x) => { const set = sets[setName]; for (const v of [x, Math.abs(x), Math.round(x), Math.round(Math.abs(x)), Math.round(x * 10) / 10, Math.round(Math.abs(x) * 10) / 10]) set.add(String(v)); };
    const add = (item, x) => { if (typeof x !== 'number' || !Number.isFinite(x) || !ITEM_ROLE[item]) return; addTo(item, x); addTo(ITEM_ROLE[item], x); if (ITEM_ROLE[item] === 'gap') addTo('sec', x); };
    const walk = (v, part, keys, key) => {
      if (v === null || v === undefined) return;
      if (typeof v === 'number') { const it = itemOfPath(part, keys, key); if (it) add(it, v); return; }
      if (Array.isArray(v)) { v.forEach(x => walk(x, part, keys, key)); return; }
      if (typeof v === 'object') for (const k of Object.keys(v)) { if (k === 'calc_id' || k === 'wall' || k === 'offset_laps') continue; walk(v[k], part, key ? keys.concat([key]) : keys, k); }
    };
    if (p && typeof p === 'object') {
      for (const part of ['baseline', 'recommendation', 'observed_at', 'comparison_point', 'excluded', 'safe_candidates', 'cases', 'expires', 'target', 'sensitivity', 'undercut_forecast']) walk(p[part], part, [], part);
      for (const r of (p.inputs || []).concat((p.undercut_forecast && p.undercut_forecast.inputs) || [])) {
        const hit = INPUT_ITEM.find(([re]) => re.test(r.key)); if (!hit) continue;
        for (const x of [r.value, r.low, r.high]) { add(hit[1], x); if (hit[1] === 'sec:gapNow') add(hit[1], -x); }
      }
      if (p.absolute_rank && Number.isInteger(p.absolute_rank.value)) { sets.pos.add(String(p.absolute_rank.value)); }
    }
    return sets;
  }
  const numberSet = numberSets;
  const GAP_CONTEXT = /前車|前の車|前走|後続|後ろ|後方|ahead|behind|gap|差|GAP|ギャップ/i;
  const FUEL_CONTEXT = /燃料|ガス|ガソリン|足り|持つ|もつ|fuel|enough/i;
  // 順位claim（N位／N番手／P{N}）：absolute_rank が出ていない限りパケット由来になり得ない。真なら「パケットに無い順位を言っている」。
  function hasUncoveredPositionClaim(text, sets) {
    const t = String(text || ''), pos = (sets && sets.pos) || new Set();
    for (const m of t.matchAll(/(\d+)\s*(?:位|番手)|\bP\s*(\d+)\b/gi)) { if (!pos.has(String(Number(m[1] || m[2])))) return true; }
    return false;
  }
  // 見えていない車がいるのに、復帰先を「空いている」と言う返答（全車を同時に観測できていない間は、その区間を空いていると判定しない）。
  //   パターン照合なので意味の保証ではない。真なら返答を止める側に倒す。
  //   否定・留保（とは言えない／断定できない／不明／分からない）が同じ節にある文は、正しい説明として通す。肯定の断定だけを止める。
  const CLEAR_CLAIMS = [
    /(?:復帰|出口|ピット出口|コースに戻|コース復帰|戻った後|出た後|出ても|出ても|出て(?:から)?|出たところ|戻って(?:から)?|戻っても).{0,14}(?:空いて|クリア|ガラ|スカスカ|詰まって(?:い)?な|詰まらな|詰まりませ|交通(?:は|も)?(?:ない|なし|無い|ゼロ)|トラフィック(?:は|も)?(?:ない|なし|無い))/,
    /(?:空いて(?:い)?る|空いてます|空いています|クリアエア|クリアな|ガラガラ|スカスカ).{0,10}(?:復帰|出口|コース|交通|区間)/,
    /(?:交通|トラフィック|渋滞|混雑|車)(?:は|も|が)?(?:ない|なし|無い|ゼロ|ありません|いません|いない|居ない|少ない|少なめ|軽い|心配(?:ない|なし|いらない))/,
    /ガラ空き|ガラガラ|スカスカ|クリアエア|クリア(?:です|だ|ですね|ですよ|になり|になる|な状態|ライン)|ノートラフィック|クリーンエア/,
    /混(?:んで|み)(?:い)?(?:ません|ない|なさ)|詰まら(?:ない|ず)|詰まりません|引っ?(?:掛|か)(?:から|かり)(?:ない|ません)|邪魔(?:は|され)(?:入り|され)?(?:ない|ません)|前(?:に|には)(?:は)?(?:他の)?(?:車|他車|誰)(?:も|は)?(?:いません|いない|居ない)/,
    /(?:前|先|出口|復帰先?|区間|ところ)(?:は|が|の先は)?空いて(?:い)?(?:る|ます)|空いてますよ|空いたところに出|問題なく空い|誰(?:も|か)(?:いません|いない|居ない|おらず)|巻き込まれ(?:ません|ない)|(?:トラフィック|渋滞|交通)(?:は|を)(?:気にしなくて|気にせず|気にする必要)|自分のペースで(?:走れ|行け)|障害物(?:は|が)?(?:なく|ない|ありません)|(?:他の車|他車)と(?:絡み|絡ま)(?:ません|ない)|(?:前後|前方|周り|周辺|出口)(?:は|が)空白/,
    /(?:rejoin|traffic|exit|pit exit|out of the pits?).{0,24}(?:is |are |looks? |will be )?(?:clear|free|empty|open|light)|clear (?:track|air|rejoin|road)|clean air|(?:no|zero|little|light|low|minimal) traffic|traffic (?:is |looks? )?(?:light|minimal|low)|(?:nobody|no ?one|no cars?) (?:ahead|in front)/i,
  ];
  const CLEAR_HEDGE = /とは言え|とは言い切れ|言い切れ|断定(?:は)?(?:でき|しな|は避け|できま)|断言(?:でき|しな)|不明|分から|わかりませ|分かりませ|判断(?:でき|がつ)|確認(?:でき|が取れ)|保証(?:でき|は)|とは限り|とは限ら|(?:空いて|クリア|混ん|詰まら|いるか|いないか)(?:いる|いない|い)?か(?:どうか)?(?:は|も)?(?:、|$)|can'?t (?:say|tell|confirm|be sure)|cannot|not (?:sure|certain|confirmed)|unknown|unclear|don'?t know|isn'?t (?:clear|known|confirmed)|may not|might not/i;
  const CLEAR_HEDGE_NEXT = /^\s*(?:(?:かどうか|かは|か)?(?:は|も)?\s*)?(?:(?:現時点|現状|今のところ|いまのところ|今|いま)(?:では|は)?\s*)?(?:不明|分から|わかりませ|分かりませ|言えません|言えない|断定|確認でき|判断でき)/;
  function hasUnobservedClearClaim(text, packet) {
    const u = packet && packet.undercut_forecast;
    if (!u || !u.coverage || u.coverage.clear_claim_allowed !== false) return false;
    const t = String(text || '');
    for (const sentence of t.split(/(?<=[。！？!?\n])|(?<=[.](?:\s|$))/)) {
      const clauses = sentence.split(/(?<=[、,，；;])/);
      for (let i = 0; i < clauses.length; i++) {
        const cl = clauses[i];
        if (!CLEAR_CLAIMS.some(re => re.test(cl))) continue;
        if (CLEAR_HEDGE.test(cl)) continue;                                  // 同じ節に否定・留保がある＝正しい説明
        if (i + 1 < clauses.length && CLEAR_HEDGE_NEXT.test(clauses[i + 1]) && clauses[i + 1].length <= 14) continue;   // 「空いているかどうか、不明です」のように次の短い節で留保
        return true;
      }
    }
    return false;
  }
  // 節（、。で区切る）ごとの文脈語から項目を特定する。特定できなければ null（＝その単位の和集合で照合）。
  const CTX = {
    litre: [[/追加給油|給油(?:量|は|が|を|する)|補給|入れる|入れて|入れます/, 'litre:add'], [/ピット入口|入口|入る時|入る前/, 'litre:entry'], [/余裕|マージン|予備/, 'litre:margin'], [/燃費|消費|1周あたり|一周あたり/, 'litre:burn'],
      [/満タン|タンク容量|容量/, 'litre:tank'], [/残り燃料|残燃料|残量|現在の?燃料|今の燃料|いまの燃料|燃料(?:は|が)|あと.{0,4}リットル|タンク(?:に)?(?:は)?/, 'litre:now']],
    sec: [[/ピット(?:ロス|損失)|ロス|停止時間|作業時間|ピットで失う|失う|レーン通過/, 'sec:pitLoss'], [/交通|抜く|抜き|トラフィック|詰ま/, 'sec:traffic'], [/ペース|ラップタイム|ラップ|平均/, 'sec:pace']],
    lap: [[/判断|期限|までに決め|決めて/, 'lap:decide'], [/基準|通常|ピット周|入る(?:周|のは)|周目に入/, 'lap:pit'], [/比較ライン|共通ライン|比較まで|あと|残り/, 'lap:count']],
  };
  const itemFor = (kind, clause) => { const hit = (CTX[kind] || []).find(([re]) => re.test(clause)); return hit ? hit[1] : null; };
  // 節ごとに、項目（特定できれば）に合う集合に載っている数値だけを '〓' に置換する。残った数値が「パケットに無い（または項目が違う）数値」。
  function maskPacketNumbers(text, sets) {
    if (!sets || typeof sets !== 'object') return String(text || '');
    const has = (setName, x) => !!(sets[setName] && sets[setName].has(String(Math.round(x * 1000) / 1000)));   // 言われた数値は表記どおりに照合（丸めはパケット側の値だけ）
    return String(text || '').split(/(?<=[。！？!?\n、,，；;])/).map(clause => {
      const gapCtx = GAP_CONTEXT.test(clause), fuelCtx = FUEL_CONTEXT.test(clause);
      const nowMark = /今|現在|いま|ただいま|currently|now/i.test(clause), predMark = /比較時点|復帰後|復帰したら|予測|見込み|通常案より|入れば|入ったら|案(?:で|なら)|だと|なら/.test(clause);
      let out = clause.replace(/\b(\d+):(\d{2}(?:\.\d{1,3})?)\b/g, (m, a, b) => has('sec:pace', Number(a) * 60 + Number(b)) || has('sec', Number(a) * 60 + Number(b)) ? '〓' : m);
      out = out.replace(/(\d+(?:\.\d+)?)(\s*)(周|ラップ|リットル|リッター|L\b|秒|分|laps?\b|lit(?:er|re)s?\b|seconds?\b|minutes?\b)/gi, (m, n, sp, unit) => {
        const x = Number(n), u = unit.toLowerCase();
        let ok;
        if (/周|ラップ|lap/.test(u)) { if (fuelCtx && /足り|持つ|もつ|燃料|enough|fuel/i.test(clause)) ok = false; else { const it = itemFor('lap', clause); ok = has(it || 'lap', x); } }
        else if (/リットル|リッター|^l$|lit/.test(u)) { const it = itemFor('litre', clause); ok = has(it || 'litre', x); }
        else if (/分|minute/.test(u)) ok = has('sec', x * 60);
        else if (gapCtx) { const it = nowMark && !predMark ? 'sec:gapNow' : (predMark && !nowMark ? 'sec:gapPred' : 'gap'); ok = has(it, x); }
        else { const it = itemFor('sec', clause); ok = has(it || 'sec', x); }
        return ok ? '〓' + sp + unit : m;
      });
      out = out.replace(/\bP\s*(\d+)\b/gi, (m, n) => has('pos', Number(n)) ? '〓' : m);
      out = out.replace(/((?:前|後ろ|後方|ahead|behind|gap(?:\s+is)?)\s*(?:は|が|まで)?\s*)(\d+(?:\.\d+)?)/gi, (m, pre, n) => has('gap', Number(n)) ? pre + '〓' : m);
      return out;
    }).join('');
  }
  // 戦略相談かどうか（renderer／router／serverの「パケットを載せる・固定応答で終端しない」判断の共通述語）。Driverの意見（訂正）も相談の一部。
  const STRATEGY_RE = [
    /(?:ピット|復帰|合流).{0,8}(?:交通|ギャップ|GAP)|(?:rejoin|blend|pit exit).{0,18}(?:traffic|gaps?|ahead|behind)|(?:traffic|gaps?).{0,18}(?:rejoin|blend|pit exit)/i,
    /(?:when|should|which lap|how about|what if).{0,25}(?:pit|box|stay out)/i,
    /アンダー\s*カット|オーバー\s*カット|under\s*cut|over\s*cut/i,
    /(?:ピット|ボックス|pit|box).{0,12}(?:入る|入って|入れ|行く|どう|べき|判断|いつ|何周|得|有利|タイミング|早め|遅らせ|延ば)/i,
    /(?:戦略|作戦|ストラテジ|strategy).{0,12}(?:どう|どれ|判断|比較|得|順位)/i,
    /(?:いつ|何周).{0,12}(?:ピット|ボックス|入る)/,
    /(?:順位|ポジション).{0,10}(?:上|アップ|改善|得|前に出)/,
    /(?:どっち|どちら).{0,8}(?:得|有利|いい|良い)/,
  ];
  // 「いつ入った？」 is retrospective; only prospective or neutral timing
  // questions about a stop override the ambiguous 「最後の」.
  const PAST_STOP_ENDING = String.raw`\s*(?:目\s*)?(?:に\s*)?(?:だった|でした|入った|入って(?:い)?た|だっけ|あった|やった|した|止まった|入れた|行った)`;
  const PAST_PIT_TIMING = new RegExp(String.raw`(?:何周|いつ)` + PAST_STOP_ENDING);
  const PIT_TIMING = new RegExp(String.raw`(?:ピット(?:イン)?|ボックス).{0,12}(?:(?:いつ|何周)(?!` +
    PAST_STOP_ENDING + String.raw`)|タイミング(?:は|って)?[？?]|入る(?:べき|のがいい)|どうする)`, 'i');
  const ELAPSED_PIT_LAP = /(?:さっきの|先ほどの|あの|前の|直前の)(?:\s*)(?:ピット(?:イン)?|ボックス)(?:は|、|って)?\s*何周(?:目)?\s*[？?]?\s*$/i;
  // A request for specific stops must not fall back to the latest stop.
  function requestedPitSequence(text) {
    const t = String(text || '').normalize('NFKC').trim();
    // Accept only a complete target phrase. An unrecognized modifier or a
    // selection of multiple stops cannot inherit the latest stop's record.
    const match = t.match(/^(.*?)\s*(?:ピット(?:イン)?|ボックス|pit(?:\s+stop)?\b|stop\b)\s*(?:は|って|、|,)?\s*(?:何周|いつ)/i);
    if (!match) return { kind:'unresolved' };
    const modifier = match[1].trim();
    const target = modifier === 'あの' ? modifier : modifier.replace(/\s*の$/, '').trim();
    if (/^(?:最後|直近|さっき|先ほど|直前|今|あの|last|latest)?$/i.test(target)) return { kind:'latest' };
    if (/^(?:最初|初めて)$/u.test(target)) return { kind:'ordinal', sequence:1 };
    const english = { first:1, '1st':1, second:2, '2nd':2, third:3, '3rd':3 };
    if (Object.hasOwn(english, target.toLowerCase())) return { kind:'ordinal', sequence:english[target.toLowerCase()] };
    const ordinal = target.match(/^([0-9]+|[一二三四五六七八九十])\s*(?:回目|度目|番目)$/u);
    if (!ordinal) return { kind:'unresolved' };
    const n = ordinal[1];
    const sequence = /^\d+$/.test(n) ? Number(n) : '一二三四五六七八九十'.indexOf(n) + 1;
    return Number.isSafeInteger(sequence) && sequence >= 1 ? { kind:'ordinal', sequence } : { kind:'unresolved' };
  }

  function isRecordedPitLapQuestion(text) {
    return isRetrospectivePitQuestion(text) && (PAST_PIT_TIMING.test(text) || ELAPSED_PIT_LAP.test(text));
  }
  function isRetrospectivePitQuestion(text) {
    const t = String(text || '');
    if (ELAPSED_PIT_LAP.test(t)) return true;
    if (PIT_TIMING.test(t)) return false;
    if (/(?:ピット|ボックス)/i.test(t) && PAST_PIT_TIMING.test(t)) return true;
    return (/(?:さっき|先ほど|あの|前の|直前の|最後の|前回の).{0,24}(?:ピット|判断|作戦)|(?:ピット|判断|作戦).{0,20}(?:どうだった|正しかった|よかった|良かった)|(?:how|was).{0,30}(?:last|earlier).{0,12}(?:stop|pit|call)/i.test(t)
        && !/(?:今は|今なら|次は|次周|次のピット|from here|next lap|what now)/i.test(t));
  }
  // Within a calculation consultation, provider prose about the blend is not
  // authoritative. Even a hedge can coexist with a claim in the same response.
  function hasBlendTopic(text) {
    return /合流|復帰|出口|ピットアウト|出た先|前方|前車|後続|後方|車列|空いて|通せんぼ|ブロック|(?:進路|行く手)|走りやす|安全|交通|トラフィック|\b(?:blend|rejoin|exit|traffic|clear|ahead|behind|merge|safe(?:ly)?|blocked|unobstructed)\b/i.test(text);
  }
  function isStrategyConsultation(text) {
    const t = String(text || '');
    if (!t.trim()) return false;
    if (/前回|前戦|昨日|previous race|last race/i.test(t)) return false;
    if (isRetrospectivePitQuestion(t)) return false;
    return PIT_TIMING.test(t) || STRATEGY_RE.some(re => re.test(t)) || parseDriverOpinion(t) !== null;
  }
  // calc_idは内容のhash（calc_idを除いたJSON）。送られてきたパケットが改ざん/手書きされていないか。
  function verifyCalcId(p) {
    if (!p || typeof p !== 'object') return false;
    const { calc_id, ...rest } = p;
    return hashString(JSON.stringify(rest)) === calc_id;
  }
  const PROMPT_RULES = '参照できる戦略の数値は、そのレースで有効な計算パケットに従う。推奨案と基準案の差、必要ペース、判断期限、結論が変わる条件から、Driverの質問に必要なものを短く伝える。'
    + '仮定と実測を言い分ける。相手の停止時期が未観測なら、条件別の計算結果を示す。安全に使える暫定案があれば提示し、計算できる部分を答える。'
    + 'Driverが条件を訂正したら変更内容を計算器へ返し、結果を受け取ってから提案を更新する。承認済みの操作は既存Plan/ACKで確認する。計算版が失効したら再照会する。'
    + 'パケットに無い数値・順位・成功確率を作らない。提案は実行指示ではない。';
  const PROMPT_RULES_UC = 'uc＝全車の位置から「今／次周／燃料の限界」を比較した結果。後ろの車が先に入る場合も試算済み。'
    + '給油後の共通地点で誰が前に出るかは各案のvs（gap_s負＝自車が先）に従う。相手の給油予定は仮定で、観測できたのはピットレーンにいる事実だけ。優劣が条件で変わる時は flips_when と rival_first_threats の条件をそのまま伝える。'
    + 'coverageで全車を観測できていない限り復帰先を「空いている」と言わない（観測できた車だけの交通は下限）。後続が見えていない時（rival_threat_assessed=false）は、後続のアンダーカットを評価していないと言う。'
    + 'stop_required_for_fuel=falseの時は「燃料だけでも完走できる見込み。義務ピットの規則は未確認」と伝え、停止を勧めない。'
    + 'focusがある時は、その案の内訳（vs・交通・給油量・判断期限）で答え、他の案との差も添える。';
  // LUNAへ渡す塊。費用のため必要最小限に絞る（全パケットの部分集合のみ＝numberSets に載る数値だけを含む）。
  function promptBlock(p) {
    if (!p) return '';
    const r1 = x => (typeof x === 'number' ? Math.round(x * 100) / 100 : x);
    const rec = p.recommendation;
    const slim = {
      id: p.calc_id, ver: p.calc_version, race: p.race && [p.race.race_instance_id, p.race.session_num], lap: p.observed_at && p.observed_at.lap, comparable: p.comparable,
      gap: p.gap_sign, compare_at_lap: p.comparison_point && p.comparison_point.lap, baseline: p.baseline && { pit_lap: p.baseline.pit_lap, add_l: p.baseline.add_l },
      rec: rec && { case: rec.case_id, kind: rec.kind, pit_lap: rec.pit_lap, add_l: rec.add_l, decide_by_lap: rec.decide_by_lap, worst_gap_s: rec.worst_case_gap_s, better_than_baseline_s: rec.improves_on_baseline_s,
        next: rec.next_best && rec.next_best.case_id, flips_when: (rec.flips_when || []).slice(0, 4).map(f => f.condition + '→' + f.best_case_id) },
      out: (p.excluded || []).map(e => e.case_id + ':' + e.reason), blocking: p.blocking, safe: p.safe_candidates, rank: p.absolute_rank && p.absolute_rank.value,
      fuel_weight_sensitivity: p.sensitivity && p.sensitivity.fuel_weight && p.sensitivity.fuel_weight.map(x => [x.k_s_per_l_per_lap, x.best_case_id, x.improves_on_baseline_s]),
      assumed_by_driver: (p.driver_assumptions || []).map(a => a.kind), expires: p.expires, unmeasured: p.unmeasured,
      cases: (p.cases || []).filter(c => !c.excluded).map(c => [c.id, c.pit_lap, c.add_l, r1(c.pit_loss_s && c.pit_loss_s.value), r1(c.fuel_margin_laps_after_l), c.rejoin && r1(c.rejoin.traffic_loss_s),
        (c.comparisons || []).map(x => [x.rival_id, x.scenario, r1(x.gap_s), r1(x.vs_baseline_s), x.required_pace && r1(x.required_pace.required_avg_lap_s), x.required_pace && r1(x.required_pace.faster_per_lap_s)])]),
      case_fields: 'id,pit_lap,add_l,pit_loss_s,fuel_after_margin_l,traffic_loss_s,[rival,scenario,gap_s,vs_baseline_s,required_avg_lap_s,faster_per_lap_s]',
      inputs: (p.inputs || []).map(x => [x.key, r1(x.value), x.source]),
    };
    if (p.undercut_forecast && UC && UC.promptSlim) slim.uc = UC.promptSlim(p.undercut_forecast);
    return '\n\n━━ PIT STRATEGY COMPARE（計算器の出力。LLMは数値を創作しない）━━\n' + PROMPT_RULES + (slim.uc ? '\n' + PROMPT_RULES_UC : '') + '\n' + JSON.stringify(slim) + '\n';
  }

  return { VERSION, SOURCES, DEFAULTS, compute, gapAt, requiredPace, fuelMargin, compareAtPoint, provisionalBaselineLap, numberSet, numberSets, maskPacketNumbers, hasUncoveredPositionClaim, hasUnobservedClearClaim, hasBlendTopic, requestedPitSequence, isRecordedPitLapQuestion, isRetrospectivePitQuestion, isStrategyConsultation, verifyCalcId, parseDriverOpinion, applyDriverOpinion, validatePacket, promptBlock, hashString, attachUndercut, packetUsable };
}));
