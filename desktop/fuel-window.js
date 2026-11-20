'use strict';
// 給油ウィンドウ（決定論）。Owner定義（2026-11-15 監督）：
//   「今回のピットで給油後にタンクへ持てる量」が「ピット出口からチェッカーまでの予測消費＋設定余裕」以上なら、ウィンドウは開いている。
//   追加給油量＝目標タンク量−入庫時見込み残量。容量上限・ピット到達可否と両立させる。
//   必要量（消費）と余裕は**別の値として**返す。余裕の固定既定値は決めていない（短時間レースで2〜4L。Driver設定可）。
//   「完走可能（燃料の面）」と「入る周の推奨（交通・順位）」は別物：この関数は前者だけを答える。
// 入力は全て観測値（telemetry／Bridgeのfuel_strategy／セッションの有効タンク容量）。欠けたら 'unknown'（空き扱い・開き扱いにしない）。
(function (root) {
  const DEFAULT_MARGIN_L = 3.0;                 // 候補（2〜4Lの中央）。固定既定値の決定は保留＝出力に source を付けて区別する
  const MARGIN_RANGE_L = Object.freeze({ min: 0.3, max: 25 });   // 余裕(L)の許容範囲。周数×燃費で換算した値も入る広さ（燃費の大きい車の1周分でも）
  const fin = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const r2 = v => Math.round(v * 100) / 100;
  function normMargin(m) {
    const v = fin(m);
    if (v === null) return { value: DEFAULT_MARGIN_L, source: 'candidate_default', note: '短時間レースの余裕候補(2〜4L)の中央。固定既定値は未決定' };
    if (v < MARGIN_RANGE_L.min || v > MARGIN_RANGE_L.max) return { value: DEFAULT_MARGIN_L, source: 'candidate_default', note: '設定値が範囲外(' + MARGIN_RANGE_L.min + '〜' + MARGIN_RANGE_L.max + 'L)のため候補値を使用' };
    return { value: v, source: 'driver_setting' };
  }
  // 入力：fuel_l 現在の残燃料／burn_l 1周の消費（燃費の高い側を渡す）／crossings S/F通過のあと何回（チェッカーを含む）／capacity_l セッションの有効タンク容量／lap_dist_pct 0〜1（無ければ0＝入口までの消費を多めに見る）
  function evaluate(input) {
    const i = input || {};
    const fuel = fin(i.fuel_l), burn = fin(i.burn_l), crossings = fin(i.crossings), cap = fin(i.capacity_l);
    const pctRaw = fin(i.lap_dist_pct), pct = pctRaw === null ? 0 : Math.min(1, Math.max(0, pctRaw));
    const margin = normMargin(i.margin_l);
    const missing = [];
    if (fuel === null || fuel < 0) missing.push('fuel_l');
    if (burn === null || burn <= 0) missing.push('burn_l');
    if (crossings === null || crossings < 1 || !Number.isInteger(crossings)) missing.push('crossings');
    if (cap === null || cap <= 0) missing.push('capacity_l');
    if (missing.length) return { state: 'unknown', open: false, missing, margin_l: margin.value, margin_source: margin.source };
    const run = burn * crossings;                                  // ピット出口からチェッカーまでの予測消費（Bridgeのfuel_strategyと同じ数え方：通過回数×1周消費。1周ぶん安全側）
    const entry = fuel - burn * (1 - pct);                         // この周の終わりでピットに入る時の見込み残量
    const reachPit = entry >= 0;
    const target = run + margin.value;                             // 給油後に持ちたい量（消費＋余裕）
    const out = { state: null, open: false, margin_l: margin.value, margin_source: margin.source, required_l: r2(run), target_tank_l: r2(target), entry_fuel_l: r2(entry), capacity_l: r2(cap),
      add_l: null, no_stop_needed: false, opens_in_laps: null, reach_pit: reachPit };
    out.no_stop_needed = fuel - run >= margin.value;               // 給油なしでも余裕込みで完走できる
    if (!reachPit) { out.state = 'unreachable'; out.reason = 'fuel_short_of_pit_entry'; return out; }
    if (target <= cap + 1e-9) {
      out.open = true; out.state = 'open';
      out.add_l = r2(Math.max(0, target - entry));
      return out;
    }
    // まだ閉じている：チェッカーまでの必要量＋余裕がタンクに収まるまであと何周か（通過回数が減るほど必要量が減る）
    const k = Math.ceil((target - cap) / burn - 1e-9);
    out.opens_in_laps = Math.max(1, k);
    const fuelAtThen = fuel - burn * (out.opens_in_laps + 1 - pct);   // その周の終わりにピットへ入る時の残量
    if (fuelAtThen < 0) { out.state = 'unreachable'; out.reason = 'window_opens_after_fuel_runs_out'; return out; }
    out.state = 'waiting';
    return out;
  }
  // Driverへの短い一文（結論から。内部の計算ルール・欠測注記は含めない）。必要量と余裕は別々に言う。
  function sentence(res, kind, lang) {
    const jp = lang !== 'en';
    if (!res) return '';
    if (res.state === 'unknown') return jp ? '燃料の計算に必要な値がまだ揃っていない。' : 'The fuel numbers needed for the window are not available yet.';
    if (kind === 'status' || kind === 'arm') {
      if (res.state === 'open') return jp ? `いま入れば完走できる。追加は約${res.add_l.toFixed(1)}L（必要${res.required_l.toFixed(1)}L＋余裕${res.margin_l.toFixed(1)}L）。` : `A stop now gets us to the end: about ${res.add_l.toFixed(1)} L (need ${res.required_l.toFixed(1)} L plus ${res.margin_l.toFixed(1)} L margin).`;
      if (res.state === 'waiting') return jp ? `まだ。あと約${res.opens_in_laps}周で開く。` : `Not yet. About ${res.opens_in_laps} laps to go.`;
      if (res.state === 'unreachable') return jp ? '燃料がウィンドウまで持たない。別の手を考える。' : 'Fuel will not last until the window. We need another plan.';
    }
    if (kind === 'notify') {
      if (res.state === 'open') return jp ? `給油ウィンドウが開いた、追加約${res.add_l.toFixed(1)}Lで完走できる。` : `Fuel window is open, about ${res.add_l.toFixed(1)} L gets us to the end.`;
    }
    return '';
  }

  // ── 燃費サンプルの採否（早期の見込み用）─────────────────────────────────────────────
  //   既存のBridgeのクリーン判定・安全燃料警告・BOXガードは変えない。ここは「4周目に開く周を見込む」ためだけの採否で、結果は事前見込み（BOX指示・給油設定にしない）。
  //   行：{lap, fuel_l(そのLap先頭の残燃料), last_lap_s(直前Lapのタイム), pit_touched(直前Lapにピットレーン通過), in_pit_at_boundary(その境界がピットレーン上)}
  //   サンプル＝連続する2行(L−1, L)の残燃料の差。採用：実測の消費・ペースが安定している周（軽い逸脱は可）。
  //   除外：ピット出入り・給油（残燃料が増える／境界がピットレーン上）、長い減速や黄旗（最も速い周より10%超遅い）、大きな外れ（消費が中央値から25%超）。
  const SAMPLE_RULES = Object.freeze({ slow_lap_ratio: 1.10, fuel_outlier_ratio: 0.25, fuel_outlier_min_l: 0.3, stable_min_laps: 3, stable_spread_ratio: 0.25, max_drop_l: 12 });
  const median = a => { const b = a.slice().sort((x, y) => x - y); const n = b.length; return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : null; };
  function selectBurnSamples(rows) {
    const R = (rows || []).filter(r => r && Number.isInteger(r.lap) && Number.isFinite(Number(r.fuel_l))).sort((a, b) => a.lap - b.lap);
    const cand = [], rejected = [];
    for (let i = 1; i < R.length; i++) {
      const a = R[i - 1], b = R[i];
      if (b.lap !== a.lap + 1) continue;                                      // 連続していないLapは使わない（欠測を補間しない）
      const drop = Number(a.fuel_l) - Number(b.fuel_l), lt = Number(b.last_lap_s);
      const base = { lap: a.lap, drop_l: Math.round(drop * 100) / 100, lap_time_s: Number.isFinite(lt) && lt > 0 ? lt : null };
      if (a.in_pit_at_boundary || b.in_pit_at_boundary || b.pit_touched || a.pit_touched_next) { rejected.push(Object.assign(base, { reason: 'pit_involved' })); continue; }
      if (!(drop > 0.05)) { rejected.push(Object.assign(base, { reason: 'fuel_not_decreasing_refuel_or_gap' })); continue; }
      if (drop > SAMPLE_RULES.max_drop_l) { rejected.push(Object.assign(base, { reason: 'drop_out_of_range' })); continue; }
      cand.push(base);
    }
    // ペース：候補の中で最も速い周より10%超遅い周は長い減速・黄旗・接触等として除外（遅い周が多数派でも中央値に引きずられない。周回タイムが無い周は判定できないので採用）
    const times = cand.map(c => c.lap_time_s).filter(v => v !== null), bestT = times.length >= 2 ? Math.min(...times) : null;
    let kept = [];
    for (const c of cand) { if (bestT !== null && c.lap_time_s !== null && c.lap_time_s > bestT * SAMPLE_RULES.slow_lap_ratio) rejected.push(Object.assign(c, { reason: 'slow_lap' })); else kept.push(c); }
    // 消費：3周以上で中央値から25%（かつ0.3L）超離れた周は大きな外れとして除外。軽い逸脱は採用
    if (kept.length >= 3) { const m = median(kept.map(c => c.drop_l)); const k2 = []; for (const c of kept) { if (Math.abs(c.drop_l - m) > Math.max(m * SAMPLE_RULES.fuel_outlier_ratio, SAMPLE_RULES.fuel_outlier_min_l)) rejected.push(Object.assign(c, { reason: 'fuel_outlier' })); else k2.push(c); } kept = k2; }
    const drops = kept.map(c => c.drop_l), m = median(drops);
    const spread = drops.length ? (Math.max(...drops) - Math.min(...drops)) / m : null;
    const stable = kept.length >= SAMPLE_RULES.stable_min_laps && spread !== null && spread <= SAMPLE_RULES.stable_spread_ratio;
    return { accepted: kept, rejected, n: kept.length, burn_l: m, spread_ratio: spread === null ? null : Math.round(spread * 1000) / 1000, stable };
  }
  // 見込み：開く周（P）と、燃料の面で入れる最終周。provisional＝安定3周が揃っていない／履歴・Bridge平均で補った暫定。
  function forecast(input) {
    const i = input || {};
    const burn = fin(i.burn_l);
    const res = evaluate(i);
    const out = { state: res.state, evaluation: res, provisional: i.stable !== true, burn_source: i.burn_source || null, samples_used: i.samples_used === undefined ? null : i.samples_used, lap: fin(i.lap), open_lap: null, last_feasible_lap: null };
    if (res.state === 'unknown') return out;
    const lap = fin(i.lap); if (lap === null) { out.state = 'unknown'; return out; }
    const pct = fin(i.lap_dist_pct) === null ? 0 : Math.min(1, Math.max(0, fin(i.lap_dist_pct)));
    const kmax = Math.floor((fin(i.fuel_l) - burn * (1 - pct)) / burn + 1e-9);
    out.last_feasible_lap = kmax >= 0 ? lap + kmax : null;
    if (res.state === 'open') out.open_lap = lap;
    else if (res.state === 'waiting') out.open_lap = lap + res.opens_in_laps;
    return out;
  }
  // 見込みを伝えるかの判定（純粋）。前回伝えた見込みと比べ、Driverの判断が変わる時だけ伝える。同じ結論は繰り返さない。一時的なぶれは抑える。
  //   prev: {spoken_open_lap, spoken_lost, pending_open_lap, pending_count}（無ければ初回）。minLap: 初回を伝える最小のLap（4周目の入口）
  function decideForecastCall(prev, f, opts) {
    const o = opts || {}, minLap = o.minLap || 4;
    const p = Object.assign({ spoken_open_lap: null, spoken_lost: false, pending_open_lap: null, pending_count: 0 }, prev || {});
    const none = (extra) => ({ speak: null, next: Object.assign(p, extra || {}) });
    if (!f || f.state === 'unknown' || !Number.isFinite(f.lap)) return none();
    if (f.state === 'open') return none({ pending_open_lap: null, pending_count: 0 });          // 開いた後は実際の開通通知(別経路)
    if (f.state === 'unreachable') {                                                              // 入れる周が無くなる＝選択肢が失われる：すぐ知らせる（一度だけ）
      if (p.spoken_lost) return none();
      return { speak: { type: 'lost', provisional: f.provisional }, next: Object.assign(p, { spoken_lost: true, pending_open_lap: null, pending_count: 0 }) };
    }
    if (p.spoken_lost) p.spoken_lost = false;                                                      // 見込みが戻った
    const P = f.open_lap;
    if (p.spoken_open_lap === null) {                                                             // 初回
      if (f.lap < minLap) return none();
      return { speak: { type: 'initial', open_lap: P, provisional: f.provisional, last_feasible_lap: f.last_feasible_lap }, next: Object.assign(p, { spoken_open_lap: P, pending_open_lap: null, pending_count: 0 }) };
    }
    if (P === p.spoken_open_lap) return none({ pending_open_lap: null, pending_count: 0 });        // 変わらない＝無音
    // 変わった：2回続けて同じ新しい値になるまで待つ（境目の行き来を抑える）。燃料の面で入れる最終周が新しい開通周を下回る時は上の unreachable で処理済み。
    const cnt = p.pending_open_lap === P ? p.pending_count + 1 : 1;
    if (cnt < 2) return none({ pending_open_lap: P, pending_count: cnt });
    return { speak: { type: 'shift', open_lap: P, from_open_lap: p.spoken_open_lap, direction: P < p.spoken_open_lap ? 'earlier' : 'later', provisional: f.provisional }, next: Object.assign(p, { spoken_open_lap: P, pending_open_lap: null, pending_count: 0 }) };
  }
  function forecastSentence(call, f, lang) {
    const jp = lang !== 'en';
    if (!call) return '';
    const src = f && f.burn_source === 'observed_stable' ? (jp ? `燃費の実測${f.samples_used}周から` : `from ${f.samples_used} measured laps, `) : (jp ? '暫定、' : 'Provisionally, ');
    if (call.type === 'lost') return jp ? '燃料がもたない、給油ウィンドウに間に合わない。' : 'Fuel will not reach the window.';
    if (call.type === 'initial') return jp ? `${src}給油ウィンドウは${call.open_lap}周目に開く見込み。` : `${src}the fuel window should open on lap ${call.open_lap}.`;
    if (call.type === 'shift') return jp ? `見込み更新、給油ウィンドウは${call.open_lap}周目に${call.direction === 'earlier' ? '前倒し' : '後ろ倒し'}。` : `Update: the fuel window moves ${call.direction === 'earlier' ? 'earlier' : 'later'} to lap ${call.open_lap}.`;
    return '';
  }
  const api = { DEFAULT_MARGIN_L, MARGIN_RANGE_L, SAMPLE_RULES, normMargin, evaluate, sentence, selectBurnSamples, forecast, decideForecastCall, forecastSentence };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallFuelWindow = api;
})(typeof window !== 'undefined' ? window : globalThis);
