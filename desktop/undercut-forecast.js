(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallUndercutForecast = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // U2/U3 — 全車スナップショット(U1)から、毎周「今入る／次周に入る／燃料の限界まで待つ」を比較し、
  //   後続（同クラスの後ろ2台）が先に入る場合も試算して、給油後の共通地点でどちらが前に出そうかを返す。
  //   決定論の周回予測（設計§24.10 方式A）＋ 相手の停止時期を振る小規模B。LLMは数値を作らない。
  //
  //   ・GAPの符号：自車の到達時刻 − 相手の到達時刻（同じ地点）。負＝自車が先。
  //   ・進行量 progress = Lap + LapDistPct（周）。比較地点＝自車の停止と相手の想定停止が全て終わった後の最初の共通ライン。
  //   ・相手の給油予定は観測できないので仮定（assumed）。観測できるのは「今ピットレーンにいる」「ピットレーンへ入って出た回数」だけ。
  //   ・復帰交通は「観測できた車」「直近まで見えていた車(推測位置)」「見えていない車」を区別する。
  //     見えていない車がいる限り、復帰区間を『空いている』とは言わない（clear_claim_allowed=false）。
  //   ・タイヤ交換・インラップ/アウトラップの差・相手側の交通は入っていない（unmeasured に明記）。
  const VERSION = 'undercut-forecast-1.1.0';
  const SOURCES = ['observed', 'dead_reckoned', 'driver_declared', 'assumed', 'synthetic'];
  const DEFAULTS = Object.freeze({
    windowS: 3.0,              // 復帰地点の前後この秒数以内を「交通」とみなす（暫定）
    passCostS: { value: 1.5, low: 0.5, high: 3.0 },       // 遅い車・周回遅れ・遅いクラスの直後に出た時の損失（暫定）
    fasterClassCostS: { value: 0.7, low: 0.3, high: 1.5 }, // 後ろから速いクラスが来た時の損失（暫定）
    slowerPaceThresholdS: 0.3,
    fasterClassPaceS: 3.0,
    fuelPaceSPerL: { value: 0.03, low: 0.0, high: 0.045 }, // 燃料重量による1周の遅れ(秒/L/Lap)。未校正の暫定
    inferredStop: { minUnseenS: 15, maxUnseenS: 300, minDeficitLap: 0.2, maxDeficitLap: 0.6 },    // 見えなかった時間(15〜300秒)と、再び見えた時の推測位置との差(0.2〜0.6周＝ピットで説明できる範囲)のときだけ停止と推定
    rivalFill: { low: 0.7, high: 1.3 },                    // 相手の給油量＝自車案の量×この比（暫定）
    rivalsBehind: 2,
    tieEpsS: 0.1,
    deadReckon: { sigmaBaseS: 1.5, sigmaPerS: 0.02, maxAgeS: 180 },
    pitExitOffsetLaps: 0.0,    // ピット出口の位置＝スタート/フィニッシュライン直後（暫定。コース別に未確認）
    rivalInPitRemainingFrac: 0.5,
    reserveL: 0.5,
  });

  const fin = v => (v === null || v === undefined || v === '' || typeof v === 'boolean') ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
  const r3 = v => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 1000) / 1000;
  const r1 = v => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 10) / 10;
  const hashString = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('00000000' + h.toString(16)).slice(-8); };
  function q(x, source) {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const value = fin(x.value); if (value === null) return null;
      const low = fin(x.low), high = fin(x.high);
      return { value, low: low === null ? value : low, high: high === null ? value : high, source: SOURCES.includes(x.source) ? x.source : (source || 'assumed'), note: x.note || null };
    }
    const value = fin(x); return value === null ? null : { value, low: value, high: value, source: source || 'assumed', note: null };
  }
  const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  function normalCdf(z) { // Abramowitz-Stegun 26.2.17
    const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  const wrapHalf = d => ((d + 0.5) % 1 + 1) % 1 - 0.5;   // [-0.5,0.5)

  // ── 追跡：U1の標本を時間順に受け取り、各車の最後に見えた位置・ラップタイム・ピットレーン通過を持つ ──────────────
  function createTracker() {
    const cars = new Map(); let scope = null, lastT = -Infinity, rejected = 0, accepted = 0;
    function update(snap) {
      if (!snap || snap.ok === false || snap.gen !== 'consistent' || !Array.isArray(snap.cars) || !Number.isFinite(snap.session_time_s)) { rejected++; return false; }
      const sc = String(snap.race_instance_id) + '|' + String(snap.session_num);
      if (sc !== scope) { cars.clear(); scope = sc; lastT = -Infinity; }
      if (snap.session_time_s < lastT - 0.5) { rejected++; return false; }   // 時刻が戻る標本は使わない（遅着・順序違い）
      lastT = snap.session_time_s; accepted++;
      const t = snap.session_time_s;
      for (const c of snap.cars) {
        let s = cars.get(c.i);
        if (!s) { s = { i: c.i, no: c.no, cls: c.c, role: c.r, seen: null, paces: [], lastLl: null, stops: 0, pit: false, pitInT: null, on_pit_now: false }; cars.set(c.i, s); }
        s.no = c.no; s.cls = c.c; s.role = c.r;
        const ok = c.st === 'ok' && Number.isFinite(c.l) && Number.isFinite(c.d);
        // ピットレーン上は車が「見えない(out)」状態になる車がある（Build 308実走：#12は約33秒見えず、再び見えた時は推測位置より約0.3周後ろ）。
        //   ピットに入る瞬間が観測できていない車は、見えなかった間の遅れ（推測位置との差）が大きければ「停止した」と推定する（basis=inferred。観測とは区別する）。
        if (ok && s.seen && !s.pit && c.pit !== 1 && !(s.lastObservedStopT >= s.seen.t)) {   // 見えなかった間に観測済みの停止があれば二重に数えない
          const gapS = t - s.seen.t, pace = s.paces.length ? median(s.paces.slice(-6)) : (Number.isFinite(c.ll) && c.ll > 0 ? c.ll : null);
          if (gapS >= DEFAULTS.inferredStop.minUnseenS && pace) {
            const deficit = s.seen.progress + gapS / pace - (c.l + c.d);
            const D = DEFAULTS.inferredStop;
            // ピットの損失は約25〜60秒。それを大きく超える遅れや、数百秒の欠測は「ピットで説明できない」（切断・離脱・修復など）＝停止と断定せず unresolved に数える（Build 308 実ログ：#14は928秒見えず3.66周遅れ）。
            if (deficit >= D.minDeficitLap && deficit <= D.maxDeficitLap && gapS <= D.maxUnseenS) { s.stops += 1; s.stopsInferred = (s.stopsInferred || 0) + 1; }
            else if (deficit >= D.minDeficitLap) s.stopsUnresolved = (s.stopsUnresolved || 0) + 1;
          }
        }
        if (ok) s.seen = { t, progress: c.l + c.d, lap: c.l, d: c.d, pit: c.pit === 1 };
        if (ok && (Number.isFinite(c.p) || Number.isFinite(c.cp))) s.lastPos = { p: Number.isFinite(c.p) ? c.p : null, cp: Number.isFinite(c.cp) ? c.cp : null, t };   // 最後に見えた時点の順位（見えなくなった車の説明に使う。現在の順位ではない）
        s.on_pit_now = ok && c.pit === 1;
        if (Number.isFinite(c.ll) && c.ll > 0 && c.ll !== s.lastLl) { s.lastLl = c.ll; s.paces.push(c.ll); if (s.paces.length > 8) s.paces.shift(); }
        if (ok && c.pit === 0 || ok && c.pit === 1) {
          const on = c.pit === 1;
          if (on && !s.pit) s.pitInT = t;
          if (!on && s.pit && s.pitInT !== null) { s.stops += 1; s.pitInT = null; s.lastObservedStopT = t; }   // ピットレーンに入って出た回数（給油の有無は1Hzでは区別できない）
          s.pit = on;
        }
      }
      return true;
    }
    function paceOf(s) {   // 直近の周回タイムのうち、遅い周（インラップ・アウトラップ・事故）を除いた中央値
      if (!s.paces.length) return null;
      const lo = Math.min(...s.paces.slice(-6)); const ok = s.paces.filter(x => x <= lo * 1.08);
      return ok.length ? { value: median(ok), n: ok.length } : null;
    }
    return { update, cars, paceOf, stats: () => ({ accepted, rejected, scope, lastT }) };
  }

  // ── 視点：ある標本時刻での全車の状態（観測／推測位置／不明）と、クラス別ペース ───────────────────────
  function buildView(tracker, snap, opts) {
    const dr = Object.assign({}, DEFAULTS.deadReckon, (opts && opts.deadReckon) || {});
    const t = snap.session_time_s, ownIdx = snap.player_car_idx;
    const entries = new Map(snap.cars.map(c => [c.i, c]));
    const cars = [];
    for (const [i, s] of tracker.cars) {
      if (s.role === 'spec') continue;
      const e = entries.get(i);
      let state = 'unknown', progress = null, sigmaS = null, ageS = null;
      if (e && e.st === 'ok' && Number.isFinite(e.l) && Number.isFinite(e.d)) { state = 'observed'; progress = e.l + e.d; sigmaS = 0.5; ageS = 0; }
      else if (s.seen && t - s.seen.t <= dr.maxAgeS && t >= s.seen.t) { state = 'dead_reckoned'; ageS = t - s.seen.t; }
      const p = tracker.paceOf(s);
      cars.push({ i, no: s.no, cls: s.cls, role: s.role, state, progress, ageS, sigmaS, pace: p ? { value: p.value, source: 'observed', n: p.n } : null,
        stops_done: s.stops, stops_inferred: s.stopsInferred || 0, on_pit_now: state === 'observed' && s.on_pit_now, seen: s.seen, last_overall_pos: (e && e.p !== null && e.p !== undefined) ? e.p : (s.lastPos ? s.lastPos.p : null), last_class_pos: (e && e.cp !== null && e.cp !== undefined) ? e.cp : (s.lastPos ? s.lastPos.cp : null) });
    }
    const own = cars.find(c => c.i === ownIdx) || null;
    const classPace = {};
    for (const c of cars) if (c.pace) (classPace[c.cls] = classPace[c.cls] || []).push(c.pace.value);
    const classMedian = {}; for (const k of Object.keys(classPace)) classMedian[k] = median(classPace[k]);
    return { t, cars, own, ownIdx, classMedian, counts: snap.counts || null };
  }

  // ── 本体 ────────────────────────────────────────────────────────────────
  function norm(raw) {
    const i = raw || {}, meta = i.meta || {}, own = i.own || {}, pit = i.pit || {}, o = i.options || {};
    return {
      meta: { race_instance_id: meta.race_instance_id ?? null, session_num: fin(meta.session_num), observed_wall: meta.observed_wall ?? null },
      own: { fuel_l: q(own.fuel_l, 'observed'), fuel_per_lap_l: q(own.fuel_per_lap_l, 'observed'), tank_l: q(own.tank_l, 'observed'), reserve_l: q(own.reserve_l, 'assumed') || { value: DEFAULTS.reserveL, low: DEFAULTS.reserveL, high: DEFAULTS.reserveL, source: 'assumed', note: '予備燃料（仮定）' },
        lap_time_s: q(own.lap_time_s, 'observed') },
      total_laps: q(i.total_laps, 'assumed'),
      pit: { transit_extra_s: q(pit.transit_extra_s, 'assumed'), fixed_stall_s: q(pit.fixed_stall_s, 'assumed'), fuel_rate_s_per_l: q(pit.fuel_rate_s_per_l, 'assumed') },
      snapshot: i.snapshot || null, tracker: i.tracker || null,
      fuelPace: o.fuel_pace_s_per_l_per_lap === undefined ? Object.assign({ source: 'assumed', note: '燃料重量による1周の遅れ。未校正の暫定' }, DEFAULTS.fuelPaceSPerL) : (q(o.fuel_pace_s_per_l_per_lap, 'assumed') || { value: 0, low: 0, high: 0, source: 'assumed' }),
      windowS: fin(o.window_s) ?? DEFAULTS.windowS, passCost: q(o.pass_cost_s, 'assumed') || Object.assign({ source: 'assumed' }, DEFAULTS.passCostS),
      fasterCost: q(o.faster_class_cost_s, 'assumed') || Object.assign({ source: 'assumed' }, DEFAULTS.fasterClassCostS),
      rivalsBehind: Number.isInteger(o.rivals_behind) ? o.rivals_behind : DEFAULTS.rivalsBehind,
      rivalIds: Array.isArray(o.rival_ids) ? o.rival_ids : null,
      normalSource: o.normal_source || null,
      normalPitLap: Number.isInteger(o.normal_pit_lap) ? o.normal_pit_lap : null,
      focus: o.focus || null, extraPitLaps: Array.isArray(o.extra_pit_laps) ? o.extra_pit_laps.filter(Number.isInteger) : [],
      rivalStops: o.rival_stops && typeof o.rival_stops === 'object' ? o.rival_stops : {},   // {carIdx: {lap, source}} Driver申告など
      trafficExtraS: q(o.traffic_extra_s, 'driver_declared'), trafficExtraOptionIds: Array.isArray(o.traffic_extra_option_ids) ? o.traffic_extra_option_ids : null,
      declinedOptionIds: Array.isArray(o.declined_option_ids) ? o.declined_option_ids : [],
      ownRefuelsDone: Number.isInteger(o.own_refuels_done) && o.own_refuels_done >= 0 ? o.own_refuels_done : null,   // 給油を確認したピットの回数（renderer）。進入・ドライブスルー・ノイズは数えない
      raceRules: o.race_rules && typeof o.race_rules === 'object' ? { applies: o.race_rules.applies === true, refuels_required: Number.isInteger(o.race_rules.refuels_required) ? o.race_rules.refuels_required : null, source: o.race_rules.source || null, reason: o.race_rules.reason || null } : null,
      driver_assumptions: Array.isArray(i.driver_assumptions) ? i.driver_assumptions : [],
    };
  }

  // 評価できた車と、判断に影響する欠測車（Owner/監督 2026-11-18）。連続した順位範囲（「◯位まで把握」）は作らない：途中の欠測を含む。
  //   順位は総合(overall)とクラス(class)を区別して持つ（標本に無ければnull）。
  function coverageDetail(view, own, rivals, sameCls, p0) {
    const pos = c => ({ overall: c.last_overall_pos === undefined ? null : c.last_overall_pos, class: c.last_class_pos === undefined ? null : c.last_class_pos });
    const age = c => (c.ageS === null || c.ageS === undefined ? null : Math.round(c.ageS));
    // 3状態で一貫して表す（監査Codex 11/19：同じ車が「評価できている」と「評価外」の両方に載らない）：
    //   observed＝観測して評価／dead_reckoned＝直近の位置からの推測位置で条件付きに評価／unassessed＝位置不明または評価対象外（見えていない）
    const evaluated = rivals.map(c => Object.assign({ no: c.no, basis: c.state === 'observed' ? 'observed' : 'dead_reckoned', last_seen_age_s: c.state === 'observed' ? 0 : age(c) }, pos(c)));
    const evaluatedIds = new Set(rivals.map(c => c.i));
    const unassessedAll = sameCls.filter(c => c.state !== 'observed' && !evaluatedIds.has(c.i));
    const unassessed = unassessedAll.map(c => Object.assign({ no: c.no, state: c.state, last_seen_age_s: age(c), rank_as_of_last_seen: true }, pos(c))).sort((a, b) => (a.last_seen_age_s === null ? 1e9 : a.last_seen_age_s) - (b.last_seen_age_s === null ? 1e9 : b.last_seen_age_s)).slice(0, 8);
    return { own_position: pos(own), evaluated_rivals: evaluated, unassessed_same_class: unassessed, unassessed_count: unassessedAll.length, note: '評価外の車は見えていない。順位は最後に見えた時点のもので、現在の順位ではない。順位の連続範囲は主張しない' };
  }

  function compute(rawInput) {
    const n = norm(rawInput);
    const snap = n.snapshot, tracker = n.tracker;
    const base = { schema: 'undercut_forecast', version: VERSION, race: { race_instance_id: snap ? snap.race_instance_id : n.meta.race_instance_id, session_num: snap ? snap.session_num : n.meta.session_num },
      gap_sign: 'gap = own_arrival - rival_arrival at the common point; negative = own car is ahead' };
    const fail = (blocking, extra) => Object.assign(base, { comparable: false, blocking, options: [], rivals: [], decision: null }, extra || {}, { calc_id: undefined });
    const seal = p => { delete p.calc_id; p.calc_id = hashString(JSON.stringify(p)); return p; };
    if (!snap || !tracker) return seal(fail(['no_field_snapshot']));
    if (snap.ok === false || snap.gen !== 'consistent') return seal(fail(['snapshot_not_consistent:' + snap.gen]));
    if (n.meta.race_instance_id !== null && n.meta.race_instance_id !== snap.race_instance_id) return seal(fail(['race_mismatch']));
    if (n.meta.session_num !== null && n.meta.session_num !== snap.session_num) return seal(fail(['session_mismatch']));
    const view = buildView(tracker, snap);
    base.observed_at = { bridge_process_epoch: snap.bridge_process_epoch ?? null, session_time_s: r3(snap.session_time_s), wall: n.meta.observed_wall, lap: view.own && view.own.state === 'observed' ? Math.floor(view.own.progress) : null, progress: view.own && view.own.state === 'observed' ? r3(view.own.progress) : null };
    const comp = view.cars.filter(c => c.role === 'car');
    const cov = { roster_competitors: comp.length, observed_now: comp.filter(c => c.state === 'observed').length, dead_reckoned: comp.filter(c => c.state === 'dead_reckoned').length, unknown: comp.filter(c => c.state === 'unknown').length };
    cov.observed_fraction = comp.length ? r3(cov.observed_now / comp.length) : null;
    cov.clear_claim_allowed = comp.length > 0 && cov.observed_now === comp.length;
    cov.note = cov.clear_claim_allowed ? '全車を同時に観測' : '名簿の全車を同時には観測できていない。見えていない車がいる区間を「空いている」とは言わない';
    base.coverage = cov;
    const missing = [];
    if (!view.own || view.own.state !== 'observed') missing.push('own_not_observed');
    if (!n.own.fuel_l) missing.push('own.fuel_l');
    if (!(n.own.fuel_per_lap_l && n.own.fuel_per_lap_l.value > 0)) missing.push('own.fuel_per_lap_l');
    if (!n.own.tank_l) missing.push('own.tank_l');
    if (!(n.total_laps && n.total_laps.value > 0)) missing.push('total_laps');
    if (!(n.pit.transit_extra_s && n.pit.fixed_stall_s && n.pit.fuel_rate_s_per_l)) missing.push('pit.{transit_extra_s,fixed_stall_s,fuel_rate_s_per_l}');
    const ownTracked = view.own ? tracker.paceOf(tracker.cars.get(view.own.i)) : null;
    const L = n.own.lap_time_s || (ownTracked ? { value: ownTracked.value, low: ownTracked.value - 0.5, high: ownTracked.value + 0.5, source: 'observed', note: '自車の直近の周回タイム' } : null);
    if (!(L && L.value > 0)) missing.push('own.lap_time_s');
    if (missing.length) return seal(Object.assign(base, { comparable: false, blocking: missing.map(k => 'missing_input:' + k), options: [], rivals: [], decision: null, inputs: describeInputs(n, L), unmeasured: unmeasured(n, cov) }));

    if (view.own.on_pit_now) return seal(Object.assign(base, { comparable: false, blocking: ['own_in_pit'], options: [], rivals: [], decision: null, inputs: describeInputs(n, L), unmeasured: unmeasured(n, cov) }));   // 自車がピットレーン上＝第二の停止を提案しない
    const own = view.own, p0 = own.progress, lap = Math.floor(p0);
    const fpl = n.own.fuel_per_lap_l, fuelNow = n.own.fuel_l.value, tank = n.own.tank_l.value, reserve = n.own.reserve_l.value, N = n.total_laps;
    const rate = n.pit.fuel_rate_s_per_l, fixed = n.pit.fixed_stall_s, transit = n.pit.transit_extra_s, k = n.fuelPace;
    // 自車が既にピットで給油を済ませ（ピットレーン通過を観測）、残りの燃料でチェッカーまで足りるなら、もう「入る周」の比較は無い。
    //   給油後も旧い「今／次周／限界」の停止提案を出し続けない（Build 308実走の「給油後も提案が繰り返された」の再現条件）。足りない時だけ再停止の比較を続ける。
    const ownStops = n.ownRefuelsDone !== null ? n.ownRefuelsDone : ((tracker.cars.get(own.i) || {}).stops || 0);   // 給油回数はrendererの確認済み回数を優先（ピット進入・通過で消費しない）
    if (ownStops >= 1 && fuelNow - fpl.value * (N.high - p0 + 1) >= reserve) return seal(Object.assign(base, { comparable: false, blocking: ['own_stop_done'], options: [], rivals: [], decision: null, inputs: describeInputs(n, L), unmeasured: unmeasured(n, cov), own_stops_done: ownStops }));
    const loss = (add, side) => transit[side] + fixed[side] + rate[side] * add;

    // 1) 自車の候補：今(この周の終わり)／次周／燃料の限界。追加の指定周も評価する（「じゃあ○周目なら？」）
    const entryFuel = (P, burn) => fuelNow - burn * (P + 1 - p0);
    const mk = (id, P, label) => {
      const c = { id, label, pit_lap: P, same_lap_as: null, excluded: null };
      const fe = entryFuel(P, fpl.high); c.fuel_at_entry_l = r3(entryFuel(P, fpl.value)); c.fuel_margin_l = r3(fe - reserve);
      const after = N.high - P;   // 停止後に走る周数。チェッカー＝進行量N+1、停止＝進行量P+1なので N-P（高い側＝安全側。STR-001と同じ定義）
      if (P < lap) c.excluded = 'pit_lap_already_passed';
      else if (P >= Math.floor(N.low)) c.excluded = 'pit_lap_not_before_finish';
      else if (fe < reserve) c.excluded = 'fuel_insufficient_to_reach_pit';
      else if (n.declinedOptionIds.includes(id)) c.excluded = 'driver_declined';
      else {
        const need = fpl.high * after + reserve, add = Math.max(0, need - fe);
        c.add_l = r3(add);
        if (fe + add > tank + 1e-9) { c.excluded = 'needs_extra_stop'; c.add_l = r3(Math.max(0, tank - fe)); c.extra_stop_note = '停止後の完走に必要な燃料' + r1(need) + 'Lがタンク容量' + r1(tank) + 'Lを超える'; }
        else {
          c.service_s = r3(fixed.value + rate.value * add);
          c.pit_loss_s = { value: r3(loss(add, 'value')), low: r3(loss(add, 'low')), high: r3(loss(add, 'high')) };
          c.fuel_margin_laps_after_l = r3(fe + add - fpl.high * after);
          c.finish_ok = true; c.stops_needed = 1;
        }
      }
      return c;
    };
    const cands = [mk('now', lap, '今（この周の終わり）'), mk('next', lap + 1, '次周')];
    // 燃料の限界＝予備を切らずにピットへ入れる最も遅い周（燃費の高い側で数える）。完走できない周は除く
    let limitP = null;
    for (let P = lap; P < Math.floor(N.low); P++) { if (entryFuel(P, fpl.high) - reserve >= 0) limitP = P; else break; }
    // 限界周で完走不可（タンク不足）なら、完走できる最も遅い周まで戻す
    const limit = (() => { if (limitP === null) return mk('limit', lap, '燃料の限界まで待つ'); let P = limitP; let c = mk('limit', P, '燃料の限界まで待つ'); while (c.excluded === 'needs_extra_stop' && P > lap) { P--; c = mk('limit', P, '燃料の限界まで待つ'); } return c; })();
    cands.push(limit);
    if (n.normalPitLap !== null) cands.push(mk('normal', n.normalPitLap, '通常案'));
    for (const P of n.extraPitLaps) if (!cands.some(c => c.pit_lap === P)) cands.push(mk('lap_' + P, P, P + '周目の終わり'));
    for (const c of cands) { const d = cands.find(x => x !== c && x.pit_lap === c.pit_lap && cands.indexOf(x) < cands.indexOf(c)); if (d) c.same_lap_as = d.id; }
    const live = cands.filter(c => !c.excluded && !c.same_lap_as);
    const fuelFinishNoStop = fuelNow - fpl.high * (N.high - p0 + 1) >= reserve;

    // 2) 相手：同クラスで自車より後ろ（観測できた車、または直近まで見えていた車）の近い順。名簿全体の中で見えている後続の数も返す
    const sameCls = comp.filter(c => c.cls === own.cls && c.i !== own.i);
    const deadPos = (c, t, pace) => { const pc = (c.pace && c.pace.value) || pace; return c.seen.progress + (t - c.seen.t) / pc; };
    const posNow = c => c.state === 'observed' ? c.progress : (c.state === 'dead_reckoned' ? deadPos(c, view.t, L.value) : null);
    const behindAll = sameCls.filter(c => c.state !== 'unknown' && posNow(c) < p0 && (p0 - posNow(c)) <= 0.5);   // 同じ周内の後続（周回遅れは脅威にしない）
    let rivals = (n.rivalIds ? sameCls.filter(c => n.rivalIds.includes(c.i)) : behindAll.slice().sort((a, b) => posNow(b) - posNow(a)).slice(0, n.rivalsBehind));
    const classPaceOf = c => c.pace ? { value: c.pace.value, source: 'observed' } : (view.classMedian[c.cls] ? { value: view.classMedian[c.cls], source: 'assumed', note: '同クラスの観測ペースの中央値' } : { value: L.value, source: 'assumed', note: '未観測→自車のペースを仮定' });
    const rivalInfo = rivals.map(c => { const pc = classPaceOf(c), x = posNow(c); return { id: 'car' + c.i, car_idx: c.i, no: c.no, state: c.state, progress: x, pace: pc, gap_now_s: r3((x - p0) * L.value), age_s: c.ageS, stops_done: c.stops_done, on_pit_now: c.on_pit_now, raw: c }; });
    const unknownSameClass = sameCls.filter(c => c.state === 'unknown').length;

    // 3) 比較地点までの時刻・交通
    const rivalLossAdd = (add, side) => add * (side === 'low' ? DEFAULTS.rivalFill.low : side === 'high' ? DEFAULTS.rivalFill.high : 1);
    const nextAdd = (cands.find(c => c.id === 'next' && !c.excluded) || live[0] || { add_l: 0 }).add_l || 0;   // 相手の給油量の仮定＝自車「次周」案の量
    const maxOwnP = Math.max(...live.map(c => c.pit_lap), lap);
    const scenariosFor = r => {
      const ov = n.rivalStops[r.car_idx];
      const rivalLap = Math.floor(r.progress);
      const late = Math.min(Math.floor(N.low) - 1, Math.max(maxOwnP, rivalLap) + 1);
      const candidates = r.progress === null ? []
        : r.on_pit_now ? [{ id: 'in_pit_now', stop_lap: rivalLap, basis: 'observed', in_pit: true }]
        : r.stops_done >= 1 ? (r.raw && r.raw.stops_inferred > 0 && r.raw.stops_inferred >= r.stops_done
          // 推定だけの停止は確定扱いにしない（監督 2026-11-18）：給油済みの場合と未給油の場合の両方を計算し、結論が変わる条件を出す
          ? [{ id: 'already_stopped', stop_lap: null, basis: 'inferred' }, { id: 'stays_out', stop_lap: late, basis: 'assumed_if_not_stopped' }, { id: 'pits_now', stop_lap: lap, basis: 'assumed_if_not_stopped' }, { id: 'pits_next', stop_lap: lap + 1, basis: 'assumed_if_not_stopped' }]
          : [{ id: 'already_stopped', stop_lap: null, basis: 'observed' }])
        : ov && Number.isInteger(ov.lap) ? [{ id: 'stops_lap_' + ov.lap, stop_lap: ov.lap, basis: ov.source === 'observed' ? 'observed' : 'driver_declared' }]
        : [{ id: 'stays_out', stop_lap: late, basis: 'assumed', note: '相手は燃料限界付近まで延ばすと仮定' },
          { id: 'pits_now', stop_lap: lap, basis: 'assumed' }, { id: 'pits_next', stop_lap: lap + 1, basis: 'assumed' }];
      return candidates.map(sc => {
        if (sc.stop_lap === null) return sc;
        if (sc.stop_lap >= Math.floor(N.low)) return { ...sc, excluded: 'rival_stop_not_before_finish' };
        if (sc.stop_lap < rivalLap) return { ...sc, excluded: 'rival_stop_already_passed' };
        return sc;
      });
    };
    const scenarios = new Map(rivalInfo.map(r => [r.id, scenariosFor(r).map(sc =>
      !sc.excluded && Math.max(maxOwnP, sc.stop_lap ?? maxOwnP) + 2 > N.high + 1
        ? { ...sc, excluded: 'comparison_line_after_finish' } : sc)]));
    // car j が時刻 t(今を0, 秒) に居る進行量。stop={entryProgress, lossS} の通りに止まる（ピットレーン上は進まない）。
    function posAt(j, t, stop) {
      const pace = j.pace ? j.pace.value : L.value; let x = j.progress0 + t / pace;
      if (j.inPitNow) { const rem = (stop?.lossS ?? j.lossNow) * DEFAULTS.rivalInPitRemainingFrac; x = j.progress0 + Math.max(0, t - rem) / pace; }
      else if (stop) { const tEntry = (stop.entryProgress - j.progress0) * pace; if (t > tEntry) x -= Math.min(t - tEntry, stop.lossS) / pace; }
      return x;
    }
    // 全車（自車を含む）。自車の復帰交通を見る時は自車を除き、相手の復帰交通を見る時は自車も車列に入れる。
    const allCars = comp.map(c => { const pc = c.i === own.i ? { value: L.value, source: 'observed' } : classPaceOf(c); const x = c.i === own.i ? p0 : posNow(c);
      return { i: c.i, no: c.no, cls: c.cls, state: c.state, pace: pc, progress0: x, sigmaS: c.state === 'dead_reckoned' ? DEFAULTS.deadReckon.sigmaBaseS + DEFAULTS.deadReckon.sigmaPerS * c.ageS : (c.state === 'observed' ? 0.5 : null),
        ageS: c.ageS, inPitNow: c.on_pit_now && c.i !== own.i, lossNow: loss(nextAdd, 'value'), isOwn: c.i === own.i }; });
    // 復帰した car(subject) から見た前後の車列と交通損失。subject={i, cls, pace, progress0}、entryProgress=ピットへ入る地点、lossS=停止の損失秒、stops={car_idx: {entryProgress, lossS}}
    function rejoinFor(subj, entryProgress, lossS, side, stops) {
      const Ls = subj.pace, tx = (entryProgress - subj.progress0) * Ls + lossS, X = entryProgress + DEFAULTS.pitExitOffsetLaps;
      const slowerFor = j => (j.cls !== subj.cls || j.pace.value - Ls >= DEFAULTS.slowerPaceThresholdS) && j.pace.value - Ls >= DEFAULTS.slowerPaceThresholdS;
      const fasterFor = j => j.cls !== subj.cls && j.pace.value <= Ls - DEFAULTS.fasterClassPaceS;
      const W = n.windowS, ahead = [], behind = []; let costObs = 0, costExp = 0, relevantUnobs = 0, expUnobsCount = 0; const costPerUnobs = [];
      const blendGap = { ahead: null, behind: null };
      for (const j of allCars) {
        if (j.i === subj.i) continue;
        if (j.state === 'unknown') {   // 位置が全く分からない車：一様に分布すると仮定（assumed）。窓に居る確率＝窓幅/周回時間
          const pj = j.pace.value, pIn = W / pj;
          const cost = slowerFor(j) ? n.passCost[side] : (fasterFor(j) ? n.fasterCost[side] : 0);
          expUnobsCount += pIn; if (cost > 0) { relevantUnobs++; costExp += pIn * cost; costPerUnobs.push(cost); }
          continue;
        }
        const Y = posAt(j, tx, stops && stops[j.i] ? stops[j.i] : null);
        const raw = X - Y, d = wrapHalf(raw), gapS = Math.abs(d) * Ls, lapped = d < 0 && raw >= 0.5;
        if (j.state === 'observed') {
          // Nearest observed neighbor on each side of the blend, independent of the traffic-loss window.
          const direction = d < 0 ? 'ahead' : 'behind';
          if (!blendGap[direction] || gapS < blendGap[direction].gap_s) {
            blendGap[direction] = { gap_s: r3(gapS), signed_gap_s: r3(d * Ls), car_idx: j.i, basis: 'projected_from_observed_position' };
          }
          if (d < 0 && gapS <= W) { ahead.push({ id: 'car' + j.i, no: j.no, class_id: j.cls, gap_s: r3(gapS), basis: 'observed', lapped }); if (slowerFor(j) || lapped) costObs += n.passCost[side]; }
          else if (d >= 0 && gapS <= W) { behind.push({ id: 'car' + j.i, no: j.no, class_id: j.cls, gap_s: r3(gapS), basis: 'observed' }); if (fasterFor(j)) costObs += n.fasterCost[side]; }
        } else {   // dead_reckoned：推測位置の確率分布
          const sig = Math.max(j.sigmaS, 0.5) / Ls, mu = -d;   // mu>0 なら相手が前
          const pAhead = normalCdf((W / Ls - mu) / sig) - normalCdf((0 - mu) / sig), pBehind = normalCdf((0 - mu) / sig) - normalCdf((-W / Ls - mu) / sig);
          const cA = (slowerFor(j) || lapped) ? n.passCost[side] : 0, cB = fasterFor(j) ? n.fasterCost[side] : 0;
          costExp += pAhead * cA + pBehind * cB; if (cA > 0 || cB > 0) { relevantUnobs++; costPerUnobs.push(Math.max(cA, cB)); }
          expUnobsCount += pAhead + pBehind;
          if (pAhead > 0.05) ahead.push({ id: 'car' + j.i, no: j.no, class_id: j.cls, gap_s: r3(mu * Ls), basis: 'dead_reckoned', probability_in_window: r3(pAhead), age_s: r1(j.ageS) });
          if (pBehind > 0.05) behind.push({ id: 'car' + j.i, no: j.no, class_id: j.cls, gap_s: r3(-mu * Ls), basis: 'dead_reckoned', probability_in_window: r3(pBehind), age_s: r1(j.ageS) });
        }
      }
      const avg = costPerUnobs.length ? costPerUnobs.reduce((a, b) => a + b, 0) / costPerUnobs.length : 0;
      const eN = Math.max(0, costExp / (avg || 1)), high = costObs + Math.min(relevantUnobs * avg, (eN + 2 * Math.sqrt(eN)) * avg);
      const unobsCount = cov.dead_reckoned + cov.unknown;
      return { ahead, behind, blend_gap: blendGap, cost: { value: costObs + costExp, low: costObs, high: Math.max(high, costObs + costExp) },
        unobserved: { cars: unobsCount, expected_in_window: r3(expUnobsCount), note: '見えていない車は位置不明（一様分布を仮定）または直近位置からの推測' },
        clear: unobsCount === 0 && ahead.length === 0 && behind.length === 0, clear_basis: unobsCount === 0 ? 'all_cars_observed' : 'unobserved_cars_exist', rejoin_progress: r3(X), at_s: r3(tx) };
    }
    const ownSubj = { i: own.i, cls: own.cls, pace: L.value, progress0: p0 };
    const declaredFor = (c, side) => n.trafficExtraS && (!n.trafficExtraOptionIds || n.trafficExtraOptionIds.includes(c.id)) ? n.trafficExtraS[side] : 0;
    // 自車が P周の終わりに停止して復帰する時の前後の車列と交通損失（相手の停止は stops の通り）
    function rejoin(c, side, stops) {
      const rj = rejoinFor(ownSubj, c.pit_lap + 1, loss(c.add_l, side), side, stops), dec = declaredFor(c, side);
      return Object.assign(rj, { traffic_loss_s: { value: r3(rj.cost.value + dec), low: r3(rj.cost.low + dec), high: r3(rj.cost.high + dec) }, traffic_extra_declared_s: dec ? r3(dec) : 0 });
    }

    // 4) 候補×相手の想定ごとの比較（給油後の共通ラインでの到達時刻差）。相手の復帰交通も同じ方法で入れる（自車だけを不利にしない）
    const rivalRows = rivalInfo.map(r => ({ id: r.id, car_idx: r.car_idx, no: r.no, state: r.state, gap_now_s: r.gap_now_s, pace_s: r3(r.pace.value), pace_basis: r.pace.source, stops_done: r.stops_done, stops_inferred: (r.raw && r.raw.stops_inferred) || 0, on_pit_now: r.on_pit_now, age_s: r.age_s === null ? null : r1(r.age_s),
      scenarios: scenarios.get(r.id).filter(sc => !sc.excluded).map(({ in_pit, ...sc }) => sc),
      excluded_scenarios: scenarios.get(r.id).filter(sc => sc.excluded) }));
    const perOption = new Map();
    for (const c of cands) perOption.set(c.id, []);
    for (const c of live) {
      for (const r of rivalInfo) {
        for (const sc of scenarios.get(r.id)) {
          if (sc.excluded) continue;
          const Cprog = Math.max(maxOwnP, sc.stop_lap ?? maxOwnP) + 2;
          const sides = {};
          for (const side of ['value', 'low', 'high']) {
            // 自車に有利な角（low：自車の損失小・交通小・相手の損失大・相手の交通大）と不利な角（high：その逆）。value=中央
            const own_side = side, riv_side = side === 'low' ? 'high' : side === 'high' ? 'low' : 'value';
            const addR = rivalLossAdd(nextAdd, riv_side);
            const rLoss = sc.stop_lap === null ? 0 : transit[riv_side] + fixed[riv_side] + rate[riv_side] * addR;
            const ownLoss = loss(c.add_l, own_side);
            const stops = {}; stops[own.i] = { entryProgress: c.pit_lap + 1, lossS: ownLoss }; if (sc.stop_lap !== null) stops[r.car_idx] = { entryProgress: sc.stop_lap + 1, lossS: rLoss };
            const ownTf = rejoin(c, own_side, stops);
            const rivSubj = { i: r.car_idx, cls: own.cls, pace: r.pace.value, progress0: r.progress };
            const rivTf = sc.stop_lap === null || sc.in_pit ? null : rejoinFor(rivSubj, sc.stop_lap + 1, rLoss, riv_side, stops);
            const rivTraffic = rivTf ? rivTf.cost[riv_side === 'low' ? 'low' : riv_side === 'high' ? 'high' : 'value'] : 0;
            const kOwn = k[own_side], kRiv = k[riv_side];
            const ownT = (Cprog - p0) * L.value + ownLoss + kOwn * c.add_l * (Cprog - (c.pit_lap + 1)) + ownTf.traffic_loss_s[own_side];
            const rivT = (Cprog - r.progress) * r.pace.value + (sc.stop_lap === null ? 0 : rLoss + kRiv * addR * (Cprog - (sc.stop_lap + 1))) + rivTraffic;
            sides[side] = { gap: ownT - rivT, Cprog, ownTf, rivTraffic, rLoss };
          }
          const v = sides.value, lo = sides.low, hi = sides.high;
          const gapV = r3(v.gap), range = [r3(Math.min(lo.gap, hi.gap, v.gap)), r3(Math.max(lo.gap, hi.gap, v.gap))];
          const eps = DEFAULTS.tieEpsS;
          const leads = Math.abs(gapV) <= eps ? 'close' : (gapV < 0 ? 'own' : 'rival'), robust = range[1] < -eps || range[0] > eps;   // 中央の見積りで先に出る側。範囲が0をまたぐなら robust=false（仮定次第で入れ替わる）
          const lapsAfter = v.Cprog - (c.pit_lap + 1);
          const rp = gapV > 0 && lapsAfter > 0 ? { faster_per_lap_s: r3(gapV / lapsAfter), required_avg_lap_s: r3(L.value - gapV / lapsAfter), laps: lapsAfter } : null;
          perOption.get(c.id).push({ rival_id: r.id, rival_no: r.no, rival_state: r.state, scenario: sc.id, scenario_basis: sc.basis, rival_stop_lap: sc.stop_lap, common_point_lap: v.Cprog - 1,
            gap_s: gapV, gap_range_s: range, leads_at_common_point: leads, leads_robust: robust, rival_pit_loss_s: sc.stop_lap === null ? 0 : r3(v.rLoss), rival_rejoin_traffic_loss_s: r3(v.rivTraffic), required_pace: rp, _traffic: v.ownTf });
        }
      }
    }
    // 5) 出力：各案の復帰交通（相手の想定に依らない自車だけの車列）＋比較
    const C0 = maxOwnP + 2;   // 全候補が復帰した後の最初の共通ライン（相手が居なくても候補を並べるための自車だけの比較地点）
    const options = cands.map(c => {
      if (c.excluded || c.same_lap_as) return Object.assign({}, c, { vs_rivals: [] });
      const tf = rejoin(c, 'value', {}), tfLo = rejoin(c, 'low', {}), tfHi = rejoin(c, 'high', {});
      const vs = perOption.get(c.id).map(({ _traffic, ...rest }) => Object.assign(rest, { rejoin_traffic_loss_s: _traffic.traffic_loss_s.value, rejoin_ahead: _traffic.ahead.slice(0, 4), rejoin_behind: _traffic.behind.slice(0, 4), blend_gap: _traffic.blend_gap }));
      const t0 = (C0 - p0) * L.value + loss(c.add_l, 'value') + k.value * c.add_l * (C0 - (c.pit_lap + 1)) + tf.traffic_loss_s.value;
      return Object.assign({}, c, { rejoin: Object.assign(tf, { traffic_loss_s: { value: tf.traffic_loss_s.value, low: tfLo.traffic_loss_s.low, high: tfHi.traffic_loss_s.high } }),
        own_time_to_common_point_s: r3(t0), common_point_lap_all_options: C0 - 1, vs_rivals: vs });
    });

    // 6) 判断：相手が居れば「最悪の想定での差」が最も小さい案。居なければ自車だけの共通地点までの所要時間(交通・燃料重量込み)。
    //    相手の想定ごとの最良案が変わるなら、その条件を返す。後続が見えていない時は、後続のアンダーカットを評価していないと明示する。
    const liveOpts = options.filter(o => !o.excluded && !o.same_lap_as);
    const haveRivals = rivalRows.some(r => r.scenarios.length > 0);
    const worst = {}; for (const o of liveOpts) worst[o.id] = haveRivals && o.vs_rivals.length ? Math.max(...o.vs_rivals.map(x => x.gap_s)) : o.own_time_to_common_point_s;
    const prefOrder = ['next', 'limit', 'now'];
    const ranked = liveOpts.filter(o => o.id !== 'normal').sort((a, b) => (Math.abs(worst[a.id] - worst[b.id]) > DEFAULTS.tieEpsS ? worst[a.id] - worst[b.id] : 0) || ((prefOrder.indexOf(a.id) < 0 ? 9 : prefOrder.indexOf(a.id)) - (prefOrder.indexOf(b.id) < 0 ? 9 : prefOrder.indexOf(b.id))) || a.pit_lap - b.pit_lap);
    const best = ranked[0] || liveOpts[0] || null, next = ranked[1] || null;
    const scenarioIds = haveRivals ? [...new Set(liveOpts.flatMap(o => o.vs_rivals.map(x => x.rival_id + ':' + x.scenario)))] : [];
    const bestByScenario = scenarioIds.map(key => { const [rid, sid] = key.split(':'); const rows = liveOpts.map(o => ({ o, x: o.vs_rivals.find(v => v.rival_id === rid && v.scenario === sid) })).filter(z => z.x);
      rows.sort((a, b) => a.x.gap_s - b.x.gap_s || a.o.pit_lap - b.o.pit_lap); const top = rows[0]; const second = rows[1];
      const rec = rows.find(z => best && z.o.id === best.id);
      return { rival_id: rid, scenario: sid, best_option_id: top.o.id, best_pit_lap: top.o.pit_lap, best_gap_s: top.x.gap_s, margin_to_next_s: second ? r3(second.x.gap_s - top.x.gap_s) : null, recommended_gap_s: rec ? rec.x.gap_s : null, leads: top.x.leads_at_common_point }; });
    const flips = best ? bestByScenario.filter(b => b.best_option_id !== best.id && (b.recommended_gap_s === null || b.recommended_gap_s - b.best_gap_s > DEFAULTS.tieEpsS)).map(b => {
      const r = rivalRows.find(x => x.id === b.rival_id);
      return { condition: '後続#' + (r ? r.no : b.rival_id) + 'が' + scenarioText(b.scenario), rival_id: b.rival_id, scenario: b.scenario, best_option_id: b.best_option_id, best_pit_lap: b.best_pit_lap, gain_vs_recommended_s: b.recommended_gap_s === null ? null : r3(b.recommended_gap_s - b.best_gap_s) }; }) : [];
    // 「相手が先に入る」想定の脅威：その想定で、自車が後ろへ回る案
    const threats = [];
    for (const o of liveOpts) for (const x of o.vs_rivals) if (x.scenario !== 'stays_out' && x.leads_at_common_point === 'rival') threats.push({ option_id: o.id, pit_lap: o.pit_lap, rival_id: x.rival_id, rival_no: x.rival_no, scenario: x.scenario, behind_by_s: x.gap_s });
    const decision = best ? { recommendation: { option_id: best.id, pit_lap: best.pit_lap, add_l: best.add_l, decide_by_lap: Math.max(lap, best.pit_lap), basis: haveRivals ? 'minimax_gap_at_common_point' : 'own_time_to_common_point_no_rival_tracked',
        worst_case_gap_s: haveRivals ? r3(worst[best.id]) : null, own_time_to_common_point_s: best.own_time_to_common_point_s,
        leads_in_all_assumptions: haveRivals ? best.vs_rivals.every(x => x.leads_at_common_point === 'own') : null, success_probability: null, success_probability_note: '校正前のため出さない',
        stop_required_for_fuel: !fuelFinishNoStop, fuel_note: fuelFinishNoStop ? '燃料だけでも完走できる見込み（停止は燃料上は不要）。義務ピットの規則は未確認' : null },
      next_best: next ? { option_id: next.id, pit_lap: next.pit_lap, worst_case_gap_s: haveRivals ? r3(worst[next.id]) : null, own_time_to_common_point_s: next.own_time_to_common_point_s, behind_best_by_s: r3(worst[next.id] - worst[best.id]) } : null,
      rival_threat_assessed: haveRivals, rival_threat_note: haveRivals ? null : '後続（同クラス・同じ周内）の位置が見えていないため、後続のアンダーカットは評価していない',
      flips_when: flips, rival_first_threats: threats, best_by_scenario: bestByScenario } : null;

    // 6b) 感度：燃料重量の係数と通過コストを振っても推奨が変わらないか。変わるなら条件としてLUNAへ渡す（未校正の暫定値に結論を預けない）
    let sensitivity = null;
    if (decision && !(rawInput && rawInput._noSensitivity)) {
      const vary = (label, optsPatch) => { const alt = compute(Object.assign({}, rawInput, { _noSensitivity: true, options: Object.assign({}, rawInput.options || {}, optsPatch) }));
        return { label, best_option_id: alt.decision ? alt.decision.recommendation.option_id : null, pit_lap: alt.decision ? alt.decision.recommendation.pit_lap : null }; };
      sensitivity = [vary('燃料重量=0', { fuel_pace_s_per_l_per_lap: 0 }), vary('燃料重量=上限' + n.fuelPace.high, { fuel_pace_s_per_l_per_lap: n.fuelPace.high }),
        vary('通過コスト=下限' + n.passCost.low, { pass_cost_s: n.passCost.low }), vary('通過コスト=上限' + n.passCost.high, { pass_cost_s: n.passCost.high })];
      for (const x of sensitivity) if (x.best_option_id && x.best_option_id !== decision.recommendation.option_id) decision.flips_when.push({ condition: x.label + 'のとき', rival_id: null, scenario: null, best_option_id: x.best_option_id, best_pit_lap: x.pit_lap, gain_vs_recommended_s: null });
      decision.conditional_on_assumed_costs = sensitivity.some(x => x.best_option_id && x.best_option_id !== decision.recommendation.option_id);
    }

    // 7) 焦点（Driverの「じゃあ次周なら？」）：指定の案の内訳を返す。案の優劣は変えない
    let focus = null;
    if (n.focus) {
      let target = null;
      if (n.focus.kind === 'now') target = options.find(o => o.id === 'now'); else if (n.focus.kind === 'next') target = options.find(o => o.id === 'next'); else if (n.focus.kind === 'limit') target = options.find(o => o.id === 'limit');
      else if (n.focus.kind === 'normal') target = options.find(o => o.id === 'normal');
      else if (n.focus.kind === 'lap') target = options.find(o => o.pit_lap === n.focus.lap);
      if (target && target.same_lap_as) target = options.find(o => o.id === target.same_lap_as) || target;
      focus = target ? { requested: n.focus, option_id: target.id, pit_lap: target.pit_lap, excluded: target.excluded || null, evaluated: !target.excluded } : { requested: n.focus, option_id: null, excluded: 'not_evaluated' };
    }

    const out = Object.assign(base, {
      comparable: !!best, blocking: liveOpts.length ? null : ['no_feasible_option'], coverage: cov,
      own: { car_idx: own.i, lap, progress: r3(p0), lap_time_s: r3(L.value), fuel_l: r3(fuelNow), no_stop_feasible: fuelFinishNoStop },
      normal_plan_source: n.normalSource,
      race_rules: n.raceRules, own_refuels_done: n.ownRefuelsDone,
      coverage_detail: coverageDetail(view, own, rivals, sameCls, p0),
      finish_lap_range: { low: N.low, high: N.high },
      rivals: rivalRows, rear_coverage: { tracked_behind: rivals.length, same_class_unobserved: unknownSameClass, note: unknownSameClass ? '同クラスに位置が見えていない車がいる。後続はここに出した車だけとは限らない' : null },
      options, decision, sensitivity, focus, action: decisionAction({ options, decision, focus, lap, fuelFinishNoStop, canReachNext: lap + 1 < Math.floor(N.low) && entryFuel(lap + 1, fpl.high) >= reserve, cov, planDeadline: n.normalSource==='plan_a' ? n.normalPitLap : null }), inputs: describeInputs(n, L), assumptions: assumptionList(n, nextAdd, cov), unmeasured: unmeasured(n, cov),
      driver_assumptions: n.driver_assumptions, expires: { valid_until_lap: lap + 1, decide_by_lap: decision ? decision.recommendation.decide_by_lap : null },
    });
    return seal(out);
  }

  function decisionAction({ options, decision, focus, lap, fuelFinishNoStop, canReachNext, cov, planDeadline }) {
    const rec = decision?.recommendation;
    const option = id => options.find(o => o.id === id);
    const usable = o => o && !o.excluded ? option(o.same_lap_as) || o : null;
    const focused = focus && usable(option(focus.option_id));
    const early = usable(option('now')), normal = usable(option('normal'));
    const comparisons = early && normal && early.id !== normal.id
      ? early.vs_rivals.map(row => [row, normal.vs_rivals.find(x => x.rival_id === row.rival_id && x.scenario === row.scenario)]) : [];
    // Only claim a benefit or lack of benefit when every like-for-like range supports it.
    const complete = cov.clear_claim_allowed && comparisons.length > 0 && comparisons.every(([a, b]) =>
      a.rival_state === 'observed' && b && a.common_point_lap === b.common_point_lap);
    let gain = 'unknown';
    if (complete && comparisons.every(([a, b]) => a.gap_range_s[1] < b.gap_range_s[0] - DEFAULTS.tieEpsS)) gain = 'early_benefit';
    if (complete && comparisons.every(([a, b]) => a.gap_range_s[0] >= b.gap_range_s[1] - DEFAULTS.tieEpsS)) gain = 'no_early_benefit';
    const canWait = canReachNext && (fuelFinishNoStop || rec?.pit_lap > lap)
      && !(Number.isInteger(planDeadline) && planDeadline <= lap);
    const kind = canWait ? 'recheck_next_lap' : rec && !fuelFinishNoStop ? 'review_feasible_stop' : 'verify_now';
    return { kind, gain, normal_option_id: normal?.id ?? null, early_option_id: early?.id ?? null, option_id: (focused || (!focus && (normal || usable(option(rec?.option_id)))))?.id ?? null,
      recommendation_id: rec?.option_id ?? null, plan_deadline: planDeadline, recheck_lap: canWait ? lap + 1 : lap,
      limit: canReachNext ? 'plan_or_comparison' : 'fuel_or_finish' };
  }

  function consultationReply(u, isJP) {
    const jp = (ja, en) => isJP ? ja : en;
    const a = u?.action;
    if (!a) {
      if (u?.blocking?.includes('own_in_pit')) return jp('ピットレーン走行中。合流後の位置と残燃料を確認してから、次の案を見直そう。',
        'We are in the pit lane. Check position and fuel after the blend, then reassess.');
      return jp('今の情報ではピット案を比べられない。残燃料とピット期限を今確認し、位置情報が更新されたら見直そう。',
        'I cannot compare the stops from the current data. Check fuel and the pit deadline now, then reassess when positions update.');
    }
    const rec = u.decision?.recommendation;
    const parts = [];
    if (u.own.no_stop_feasible) parts.push(jp('燃料上は停止なしで完走できる見込みです。ピット案は順位を狙う場合の比較です。義務ピットの有無は別に確認しよう。',
      'On fuel, we can finish without a stop. The pit options are for gaining position. Check any mandatory stop separately.'));
    if (u.focus?.excluded) parts.push(jp('指定のピット案は今の条件では成立しない。', 'The requested stop is unavailable under the current conditions.'));
    const ids = u.focus ? [a.option_id] : [...new Set([a.early_option_id, a.normal_option_id, a.option_id])];
    for (const id of ids) {
      const o = u.options.find(x => x.id === id), gaps = o?.rejoin?.blend_gap;
      if (!gaps) continue;
      const gap = side => Number.isFinite(gaps[side]?.gap_s) ? r1(gaps[side].gap_s) : null;
      const ahead = gap('ahead'), behind = gap('behind');
      const label = u.focus?.requested?.kind === 'normal' || id === a.normal_option_id
        ? jp('通常案、', 'Normal stop, ') : id === 'now' ? jp('今周の案、', 'Stop this lap, ') : '';
      parts.push(label + jp(o.pit_lap + '周目。' + (o.add_l > 0 ? '追加給油は' + r1(o.add_l) + 'リットル。' : '追加給油は不要。'), 'lap ' + o.pit_lap + '. ' + (o.add_l > 0 ? 'Add ' + r1(o.add_l) + ' liters.' : 'No fuel needed at this stop.')));
      const bounds = [
        ahead === null ? jp('前方は算出できず', 'the gap ahead is unavailable') : jp('前車まで約' + ahead + '秒', 'about ' + ahead + ' seconds to the car ahead'),
        behind === null ? jp('後方は算出できず', 'the gap behind is unavailable') : jp('後続まで約' + behind + '秒', 'about ' + behind + ' seconds to the car behind'),
      ];
      parts.push(jp('合流時は' + bounds.join('、') + '。', 'At the blend, ' + bounds.join(', and ') + '.'));
    }
    if (ids.some(Boolean)) parts.push(jp('ピットレーンの通過時間と作業、相手のペースを仮定した見積もりです。',
      'This estimate assumes pit lane transit time, service time and rival pace.'));
    if (ids.includes(a.normal_option_id) && a.normal_option_id && u.normal_plan_source==='provisional_even_split')
      parts.push(jp('通常案の周は暫定です。','The normal stop lap is provisional.'));
    if (!u.coverage.clear_claim_allowed) parts.push(jp('見えていない車がいるので、合流区間が空いているとは言えない。',
      'Some cars are out of view, so I cannot say the blend is clear.'));
    if (a.gain === 'no_early_benefit') parts.push(jp('今の試算では早く入る利得は出ていない。', 'The current comparison shows no gain from stopping early.'));
    else if (a.gain === 'early_benefit') parts.push(jp('給油後の共通ラインでは、試した条件で早めの案が有利。', 'At the common line after the stops, the early stop leads in the scenarios tested.'));
    else parts.push(jp('早めに入る利得はまだ判断できない。', 'The benefit of stopping early is still uncertain.'));
    if (a.kind === 'recheck_next_lap') parts.push(jp('燃料は次周まで持つ見込み。あと1周走り、燃料と車列が更新されたら見直そう。',
      'Fuel should reach the next lap. Run one more lap, then reassess with updated fuel and traffic.'));
    else if (a.kind === 'review_feasible_stop' && rec && a.plan_deadline !== null && a.plan_deadline <= u.own.lap && rec.pit_lap > a.plan_deadline) {
      parts.push(jp('現行プランの判断期限は今周。燃料上は' + rec.pit_lap + '周目に' + r1(rec.add_l) + 'リットルで完走できる試算だけど、今すぐ現行プランと残燃料を確認しよう。',
        'The current plan needs a decision this lap. The fuel model supports lap ' + rec.pit_lap + ' with ' + r1(rec.add_l) + ' liters. Check the current plan and fuel now.'));
    } else if (a.kind === 'review_feasible_stop' && rec) parts.push(jp('燃料計算上は' + rec.pit_lap + '周目に' + r1(rec.add_l) + 'リットルで完走できる案がある。' + rec.decide_by_lap + '周までに残燃料とピット入口を確認しよう。',
      'The fuel estimate supports a lap ' + rec.pit_lap + ' stop with ' + r1(rec.add_l) + ' liters. Check fuel and pit entry by lap ' + rec.decide_by_lap + '.'));
    else if (u.options.find(x => x.id === 'now')?.excluded === 'needs_extra_stop') {
      parts.push(jp('一度の給油では完走分がタンクに入らない。今、複数回の停止が必要か燃料計画を確認しよう。',
        'The tank cannot hold enough to finish after one stop. Check the fuel plan now for an extra stop.'));
    } else parts.push(jp('残燃料とピット期限を今確認しよう。条件が確認できたら判断を更新する。',
      'Check fuel and the pit deadline now. Reassess as soon as those limits are confirmed.'));
    return parts.join(isJP ? '' : ' ');
  }

  function scenarioText(id) { return id === 'pits_now' ? '今周先に入る' : id === 'pits_next' ? '次周先に入る' : id === 'stays_out' ? '入らず引っ張る' : id === 'in_pit_now' ? '今ピットレーンにいる' : id === 'already_stopped' ? '既に入った' : id; }
  function describeInputs(n, L) {
    const rows = [], add = (key, x, unit) => { if (x) rows.push({ key, value: x.value, low: x.low, high: x.high, unit: unit || null, source: x.source, note: x.note || null }); };
    add('own.fuel_l', n.own.fuel_l, 'L'); add('own.fuel_per_lap_l', n.own.fuel_per_lap_l, 'L/lap'); add('own.tank_l', n.own.tank_l, 'L'); add('own.reserve_l', n.own.reserve_l, 'L'); add('own.lap_time_s', L, 's'); add('total_laps', n.total_laps, 'lap');
    add('pit.transit_extra_s', n.pit.transit_extra_s, 's'); add('pit.fixed_stall_s', n.pit.fixed_stall_s, 's'); add('pit.fuel_rate_s_per_l', n.pit.fuel_rate_s_per_l, 's/L');
    add('own.fuel_pace_s_per_l_per_lap', n.fuelPace, 's/L/lap'); add('traffic.pass_cost_s', n.passCost, 's'); add('traffic.faster_class_cost_s', n.fasterCost, 's');
    rows.push({ key: 'traffic.window_s', value: n.windowS, low: n.windowS, high: n.windowS, unit: 's', source: 'assumed', note: '復帰地点の前後この秒数以内を交通とみなす（暫定）' });
    return rows;
  }
  function assumptionList(n, nextAdd, cov) {
    const a = [
      { id: 'rival_fill', source: 'assumed', text: '相手の給油量は自車「次周」案の量(' + r1(nextAdd) + 'L)の' + DEFAULTS.rivalFill.low + '〜' + DEFAULTS.rivalFill.high + '倍を仮定（相手の燃料は未観測。自車の量を一律に適用している）' },
      { id: 'rival_stop_timing', source: 'assumed', text: '相手の停止周は観測できない。「入らず引っ張る(Owner現場知見＝燃料限界付近まで延ばす傾向)」「今周先に入る」「次周先に入る」を条件別に比較し、どれが起きるかは言わない' },
      { id: 'pit_exit_position', source: 'assumed', text: 'ピット出口はスタート/フィニッシュライン直後と仮定（コース別に未確認）' },
      { id: 'rival_pace', source: 'assumed', text: '相手のペースは直近の周回タイムの中央値。未観測は同クラスの中央値、無ければ自車のペース' },
    ];
    if (!cov.clear_claim_allowed) a.push({ id: 'unobserved_cars', source: 'assumed', text: '名簿' + cov.roster_competitors + '台のうち同時に位置が取れたのは' + cov.observed_now + '台。見えていない車は直近位置からの推測または一様分布で扱い、復帰区間を「空いている」とは判定しない' });
    return a;
  }
  function unmeasured(n, cov) {
    const u = ['相手の燃料・給油量・停止予定は観測できない（条件別の仮定）', 'タイヤ交換・インラップ/アウトラップのペース差・相手側の復帰交通は入っていない', '燃料重量の係数(' + n.fuelPace.value + ' s/L/lap)は未校正の暫定値', 'ピット1回の作業時間・通過時間は暫定値または観測した校正値（inputsの出所を参照）'];
    if (!cov.clear_claim_allowed) u.push('見えていない車の位置は推測。復帰交通は観測できた車の下限と、推測を含む期待値・上限で示す');
    u.push('実iRacing・実走での検証は未実施');
    return u;
  }

  // ── Driverの質問 → 焦点／相手の停止申告 ───────────────────────────────────────
  //   「じゃあ次周なら？」「今入ったら？」「限界まで待つと？」「12周目に入ったら」「後ろが先に入ったら？」
  function parseFocus(text) {
    const t = String(text || '');
    if (!t.trim()) return null;
    if (/(?:アンダーカット|under\s*cut).{0,24}(?:合流|復帰|交通|blend|rejoin)|(?:合流|復帰|blend|rejoin).{0,24}(?:アンダーカット|under\s*cut)/i.test(t)
        && !/(?:通常|normal|比較|versus|vs)/i.test(t)) return { kind: 'now' };
    if (!/(?:アンダーカット|under\s*cut).{0,32}(?:比較|versus|vs)|(?:比較|versus|vs).{0,32}(?:アンダーカット|under\s*cut)/i.test(t) && /通常(?:の)?(?:ピット|案)|normal (?:pit|stop)|regular (?:pit|stop)/i.test(t)) return { kind: 'normal' };
    if (/^(?:(?:what (?:if|about)|how about) )?(?:pit(?:ting)? )?next lap[?.! ]*$/i.test(t.trim())) return { kind: 'next' };
    if (/^(?:(?:what (?:if|about)|how about) )?pit(?:ting)? now[?.! ]*$/i.test(t.trim())) return { kind: 'now' };
    // 「〜なら？／〜たら？」の仮定の形だけ。「今入るのと次周と、どっちが得？」のような通常の比較質問は焦点にしない（STR-001の通常の相談と区別する）。
    const COND = '(?:なら|だと|では|入っ(?:たら|た場合)|入れば|入るなら|入ると|ピット(?:に)?入(?:ったら|れば|るなら|ると)|待(?:てば|ったら|つと|つなら)|引っ張(?:れば|ったら|ると|るなら)|粘(?:れば|ったら|ると))';
    if (/(?:後ろ|後続|後方|うしろ)\S{0,8}(?:先に|先へ)\S{0,4}(?:入|ピット)/.test(t) && /(?:たら|ると|なら|場合|どう)/.test(t)) return { kind: 'rival_first', text: t };
    if (/(?:後ろ|後続|後方|うしろ)\S{0,8}(?:入っ|ピットイン)(?:たら|ると|なら)/.test(t)) return { kind: 'rival_first', text: t };
    const lap = t.match(new RegExp('(\\d{1,3})\\s*周目\\s*(?:に|で|の終わり)?\\s*' + COND));   // 「12周目に入ったら」。「もう1周待てば」は次周側
    if (lap) return { kind: 'lap', lap: Number(lap[1]), text: t };
    if (new RegExp('(?:限界|ギリギリ)\\s*(?:まで)?\\s*' + COND).test(t) || /燃料(?:が)?(?:持つ|もつ)(?:まで)?\s*(?:待|引っ張|粘)(?:てば|ったら|つと|る)/.test(t)) return { kind: 'limit', text: t };
    if (new RegExp('(?:次周|次の周|次のラップ|もう1?周|もう一周)\\s*(?:に|で)?\\s*' + COND).test(t)) return { kind: 'next', text: t };
    if (new RegExp('(?:今(?:すぐ)?|いま|すぐ|今回|この周)\\s*(?:に|で)?\\s*' + COND).test(t) && !/(?:今|いま)(?:の|は|から)/.test(t.slice(0, 2))) return { kind: 'now', text: t };
    return null;
  }

  // ── LUNAへ渡す塊（全体の部分集合。ここに無い数値は言わせない）。費用のため最小限 ──────────────
  function promptSlim(u) {
    if (!u) return null;
    const rd = x => (typeof x === 'number' ? Math.round(x * 10) / 10 : x);
    const dec = u.decision;
    return { id: u.calc_id, ver: u.version, comparable: u.comparable, blocking: u.blocking || undefined, lap: u.observed_at && u.observed_at.lap,
      coverage: u.coverage && { roster: u.coverage.roster_competitors, observed: u.coverage.observed_now, dead_reckoned: u.coverage.dead_reckoned, unknown: u.coverage.unknown, clear_claim_allowed: u.coverage.clear_claim_allowed },
      rear: u.rivals && u.rivals.map(r => ({ no: r.no, gap_now_s: rd(r.gap_now_s), state: r.state, pace_s: rd(r.pace_s), stops_done: r.stops_done, on_pit_now: r.on_pit_now })),
      options: u.options && u.options.map(o => o.excluded ? { id: o.id, pit_lap: o.pit_lap, excluded: o.excluded } : o.same_lap_as ? { id: o.id, pit_lap: o.pit_lap, same_as: o.same_lap_as } : { id: o.id, pit_lap: o.pit_lap, add_l: o.add_l, pit_loss_s: rd(o.pit_loss_s && o.pit_loss_s.value), fuel_margin_laps_after_l: rd(o.fuel_margin_laps_after_l),
        traffic_loss_s: o.rejoin && [rd(o.rejoin.traffic_loss_s.low), rd(o.rejoin.traffic_loss_s.value), rd(o.rejoin.traffic_loss_s.high)], clear: o.rejoin && o.rejoin.clear, blend_gap: o.rejoin && o.rejoin.blend_gap, ahead_at_rejoin: o.rejoin && o.rejoin.ahead.length, behind_at_rejoin: o.rejoin && o.rejoin.behind.length,
        vs: o.vs_rivals.map(x => [x.rival_no, x.scenario, rd(x.gap_s), x.leads_at_common_point, x.common_point_lap, x.required_pace && rd(x.required_pace.faster_per_lap_s)]) }),
      rules: u.race_rules && { refuels_required: u.race_rules.refuels_required, applies: u.race_rules.applies, source: u.race_rules.source, reason: u.race_rules.reason, refuels_done: u.own_refuels_done },
      unassessed: u.coverage_detail && { count: u.coverage_detail.unassessed_count, cars: u.coverage_detail.unassessed_same_class.map(c => c.no) },
      action: u.action,
      vs_fields: 'rival_no,scenario,gap_s(neg=own ahead),leads,common_point_lap,faster_per_lap_s',
      rec: dec && { option: dec.recommendation.option_id, pit_lap: dec.recommendation.pit_lap, add_l: dec.recommendation.add_l, decide_by_lap: dec.recommendation.decide_by_lap, worst_gap_s: rd(dec.recommendation.worst_case_gap_s), leads_in_all_assumptions: dec.recommendation.leads_in_all_assumptions, stop_required_for_fuel: dec.recommendation.stop_required_for_fuel,
        next: dec.next_best && dec.next_best.option_id, flips_when: dec.flips_when.slice(0, 4).map(f => f.condition + '→' + f.best_option_id + '(' + f.best_pit_lap + ')' + (f.gain_vs_recommended_s === null ? '' : ' ' + rd(f.gain_vs_recommended_s) + 's')), rival_first_threats: dec.rival_first_threats.slice(0, 4).map(t => [t.option_id, t.rival_no, t.scenario, rd(t.behind_by_s)]) },
      focus: u.focus && { option: u.focus.option_id, pit_lap: u.focus.pit_lap, excluded: u.focus.excluded, kind: u.focus.requested && u.focus.requested.kind },
      assumptions: (u.assumptions || []).map(a => a.id), unmeasured: u.unmeasured, expires: u.expires };
  }

  // ── 走行中のLUNA提案（能動）：Driverがまだ選べる間に、変化があった時だけ ────────────────
  //   決定論の文面。数値は全てパケットの値。LLMを呼ばない（費用0）。提案は実行指示ではない（採用は既存のPlan/ACK）。
  // 走行中の自発提案（決定論・LLMを呼ばない）。Owner 2026-11-17（Build 308実走：同種の126文字前後の提案が自車ピット後を含め毎周9回）：
  //   ・一文で「結論＋必要な理由」。内部注記（見えていない車・評価できていない旨）・括弧説明・「最もきつくない」は話さない（診断ログへ）。
  //   ・判断が目前(決定期限まで1周以内)の時だけ。遠い周の案や、条件が変わるだけの案は話さない。
  //   ・前回話した結論と実質差が無ければ再コールしない（結論＝入る案と周）。相手の仮定が変わっただけでは話さない。
  function proposal(u, prevKey) {
    if (!u || u.comparable !== true || !u.decision) return null;
    const rec = u.decision.recommendation, lap = u.observed_at.lap;
    if (!(rec.decide_by_lap >= lap)) return null;
    if (rec.stop_required_for_fuel === false) return { key: 'no_fuel_need|' + u.race.race_instance_id, text: null, reason: 'no_fuel_need' };   // 燃料上は停止不要。義務ピットの規則が未確認なので、停止を促す提案はしない
    const imminent = rec.decide_by_lap - lap <= 1;
    const key = [u.race.race_instance_id, u.race.session_num, rec.option_id, rec.pit_lap].join('|');   // 結論＝入る案と周だけ（相手の仮定の変化では変えない）
    if (!imminent) return { key: prevKey || null, text: null, reason: 'not_imminent' };
    if (key === prevKey) return { key, text: null, reason: 'unchanged' };
    const worst = arr => arr.sort((a, b) => b.behind_by_s - a.behind_by_s)[0] || null;
    const th = rec.option_id === 'now' ? worst(u.decision.rival_first_threats.filter(t => t.option_id !== 'now')) : worst(u.decision.rival_first_threats.filter(t => t.option_id === rec.option_id));   // 理由＝今入る時は「待つ案が相手の先入れで負ける」、待つ案の時は「その案が相手の先入れで負ける」
    const when = rec.option_id === 'now' ? '今周' : rec.option_id === 'next' ? '次の周' : rec.pit_lap + '周目';
    const parts = [when + 'に入るのがいい。'];
    const secs = th ? (Math.round(th.behind_by_s * 10) / 10) : null;
    const rv = th ? (u.rivals || []).find(r => r.id === th.rival_id) : null, inferredRival = !!(rv && rv.stops_inferred > 0);   // 停止が推定だけの相手は「未給油なら」と条件を付ける（確定しない）
    // 相手の給油状態で結論が変わる時は、その条件を言う：停止が推定だけの相手は「給油済みなら／未給油なら」と確定しない。観測した停止は「給油済みで」。
    const cond = !th ? null : (th.scenario === 'already_stopped' ? (inferredRival ? 'が給油済みなら' : 'は給油済みで') : (inferredRival ? 'が未給油なら' : null));
    if (th) parts.push(cond !== null
      ? (rec.option_id === 'now' ? th.rival_no + '番' + cond + '、待つと約' + secs + '秒逆転される。' : th.rival_no + '番' + cond + '約' + secs + '秒逆転される。')
      : (rec.option_id === 'now' ? '待つと' + th.rival_no + '番が先に入って約' + secs + '秒逆転される。' : th.rival_no + '番が先に入ると約' + secs + '秒逆転される。'));
    // 後続の脅威を評価できていない時は、短く制約と再評価の行動を伝える（監督 2026-11-18）。詳細は聞かれた時に答える。
    if (u.decision.rival_threat_assessed === false) parts.push('後ろの車は見えていない。見えたら言い直す。');
    return { key, text: parts.join(''), reason: 'changed',
      refs: th ? [{ rival_no: th.rival_no, car_idx: ((u.rivals || []).find(r => r.id === th.rival_id) || {}).car_idx, stops_done: ((u.rivals || []).find(r => r.id === th.rival_id) || {}).stops_done }] : [],
      diag: { coverage_clear: !!(u.coverage && u.coverage.clear_claim_allowed), rival_threat_assessed: u.decision.rival_threat_assessed, inferred_rival: inferredRival, decide_by_lap: rec.decide_by_lap, option_id: rec.option_id, pit_lap: rec.pit_lap } };
  }

  // 「誰を評価していて、誰が見えていないか」への決定論の返答。順位は総合/クラスを区別し、連続範囲（「◯位まで把握」）は言わない。
  function coverageReply(u, lang) {
    const jp = lang !== 'en';
    if (!u || !u.coverage_detail) return jp ? '評価の対象はまだ確認できていない。' : 'The evaluated cars are not available yet.';
    const d = u.coverage_detail, pn = c => (c.class !== null && c.class !== undefined ? 'クラス' + c.class + '位' : (c.overall !== null && c.overall !== undefined ? '総合' + c.overall + '位' : '順位不明'));
    const ev = d.evaluated_rivals.length ? d.evaluated_rivals.map(c => '#' + c.no + '（' + pn(c) + (c.basis === 'dead_reckoned' ? '、直近の位置から推測' : '') + '）').join('、') : null;
    // 評価外：最後に見えた時点の順位と何秒前かを添える（現在の順位として言わない）
    const un = d.unassessed_same_class.length ? d.unassessed_same_class.slice(0, 5).map(c => '#' + c.no + '（見えていない' + (c.last_seen_age_s !== null && (c.class !== null || c.overall !== null) ? '、' + c.last_seen_age_s + '秒前は' + pn(c) : '') + '）').join('、') : null;
    const own = d.own_position && (d.own_position.class !== null || d.own_position.overall !== null) ? '自車は' + pn(d.own_position) + '。' : '';
    if (!jp) return (ev ? 'Evaluated: ' + ev + '. ' : 'No rival is evaluated. ') + (un ? 'Not evaluated (not visible): ' + un + '.' : '');
    return own + (ev ? '評価できているのは' + ev + '。' : '評価できている相手はいない。') + (un ? '評価外は' + un + (d.unassessed_count > 5 ? 'ほか' + (d.unassessed_count - 5) + '台' : '') + '。' : '') + '順位の連続範囲は言えない。';
  }

  return { VERSION, SOURCES, DEFAULTS, createTracker, buildView, compute, parseFocus, promptSlim, proposal, coverageReply, consultationReply, scenarioText, hashString, normalCdf };
}));
