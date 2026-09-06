// Session strategy state — 走行中の「合意した戦略」を1つの正本に集約する。
//
// なぜ要るか（2026-09-05 Build 298 実走・Codex 事後Gate §3）:
//   fuel履歴・race format・残時間／残周・pit実績・ドライバーと合意したPlanが
//   **別系統のまま**で、質問ごとに違う前提から答えていた。
//
//     18:22:48 Driver「この週でピットイン だ。」→ Luna「了解。この周の終わりでボックス。」
//     18:25:54 pit_entry ＝ **実際にピットした**
//     18:43:21 Luna「今はステイアウト。ピットウィンドウまで走れる。」← 17分前に済んだPlan
//     18:44:53 Luna「完走まで8.3L不足。Plan Aを継続」← 実際は 15.9L・残り約2周で足りている
//     18:51:35 Driver「戦略も毎回同じなんだけど、君が把握してないっていうのが一番痛いね。」
//
//   8.3L不足は「pit前の全レース距離」を前提に計算し続けた結果である。値の誤差ではなく、
//   **前提が更新されていない**ことが原因。だから個々の回答を直すのではなく、
//   前提そのものを1つの state に集めて revision で読む。
//
// 契約:
//   - Plan は合意・訂正・取消・実行のいずれでも revision が進む。
//   - pit を実行したら、その Plan は即座に失効する（履歴には残す）。
//   - 燃料の判定は**残り距離**に対して行う。全レース距離を前提に残さない。
//   - ドライバーの戦略申告は保存ACKで終わらせず、内容を短く復唱して返す。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallSessionStrategyState = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const finite = v => {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    return Number.isFinite(Number(v)) ? Number(v) : null;
  };

  function create(input) {
    const opts = input && typeof input === 'object' ? input : {};
    return {
      session_key: String(opts.session_key || ''),
      revision: 0,
      pit_plan: null,        // {lap, source, at}
      pit_executed: null,    // {lap, at}
      history: [],           // 監査用。合意・訂正・取消・実行を全部残す
      driver_strategy: null, // ドライバー本人の申告
    };
  }

  function bump(st, entry) {
    st.revision += 1;
    st.history.push({ ...entry, revision: st.revision });
    return st.revision;
  }

  const revision = st => (st && Number.isInteger(st.revision) ? st.revision : 0);

  // 合意されたピット周。source は 'driver'（本人申告）か 'engineer'（提案の承認）。
  function agreePitPlan(st, input) {
    if (!st) return null;
    const lap = finite(input && input.lap);
    if (lap === null) return null;
    st.pit_plan = { lap, source: String((input && input.source) || 'driver'),
      at: finite(input && input.at) };
    bump(st, { kind: 'plan_agreed', lap, at: st.pit_plan.at });
    return st.pit_plan;
  }

  // 訂正。合意元（誰が決めたか）は引き継ぐ。訂正で「ドライバーが決めた」事実は消えない。
  function amendPitPlan(st, input) {
    if (!st || !st.pit_plan) return agreePitPlan(st, input);
    const lap = finite(input && input.lap);
    if (lap === null) return st.pit_plan;
    const prev = st.pit_plan;
    st.pit_plan = { lap, source: prev.source, at: finite(input && input.at),
      amended_from: prev.lap };
    bump(st, { kind: 'plan_amended', from: prev.lap, lap, at: st.pit_plan.at });
    return st.pit_plan;
  }

  function cancelPitPlan(st, input) {
    if (!st) return null;
    const prev = st.pit_plan;
    st.pit_plan = null;
    bump(st, { kind: 'plan_cancelled', from: prev ? prev.lap : null,
      at: finite(input && input.at) });
    return null;
  }

  // ★pit_entry が成立したらここを通す。旧Planは即座に失効する。
  function recordPitExecuted(st, input) {
    if (!st) return null;
    const lap = finite(input && input.lap);
    const at = finite(input && input.at);
    st.pit_executed = { lap, at, planned_lap: st.pit_plan ? st.pit_plan.lap : null };
    st.pit_plan = null;
    bump(st, { kind: 'pit_executed', lap, at });
    return st.pit_executed;
  }

  const pitPlan = st => (st && st.pit_plan ? st.pit_plan : null);
  const pitExecuted = st => (st && st.pit_executed ? st.pit_executed : null);

  // ピット判断の回答。**実行済みなら古い「ステイアウト」を絶対に出さない。**
  function answerPitDecision(st, input) {
    const at = finite(input && input.at);
    const lapsRemaining = finite(input && input.laps_remaining);
    if (!st) return { reply: 'ピット周はまだ決めていない。', state: 'unknown', revision: 0 };
    if (st.pit_executed) {
      const done = st.pit_executed;
      const tail = lapsRemaining !== null ? `残り${lapsRemaining}周、このまま走り切る。` : 'このまま走り切る。';
      return {
        reply: (done.lap !== null ? `${done.lap}周目でピット済み。` : 'ピットは済んでいる。') + tail,
        state: 'executed', revision: revision(st), at,
      };
    }
    if (st.pit_plan) {
      return { reply: `${st.pit_plan.lap}周目でボックス。合意どおり。`,
        state: 'planned', revision: revision(st), at };
    }
    return { reply: 'ピット周はまだ決めていない。', state: 'none', revision: revision(st), at };
  }

  // 燃料は**残り距離**に対して判定する。全レース距離を前提に残さない。
  function answerFuel(st, input) {
    const fuel = finite(input && input.fuel_l);
    const perLap = finite(input && input.per_lap_l);
    const laps = finite(input && input.laps_remaining);
    if (fuel === null || perLap === null || perLap <= 0 || laps === null) {
      return { shortfall_l: null, laps_possible: null,
        reply: '燃料の権威データがまだ足りない。', revision: revision(st) };
    }
    const need = perLap * laps;
    const possible = fuel / perLap;
    const shortfall = need - fuel;
    if (shortfall <= 0) {
      return { shortfall_l: null, laps_possible: Math.round(possible * 10) / 10,
        reply: `残り${laps}周に対して燃料${fuel.toFixed(1)}L。足りている。`,
        revision: revision(st) };
    }
    return { shortfall_l: Math.round(shortfall * 10) / 10,
      laps_possible: Math.round(possible * 10) / 10,
      reply: `残り${laps}周に${shortfall.toFixed(1)}L足りない。`,
      revision: revision(st) };
  }

  // ドライバーの戦略申告。保存ACKだけで返さず、内容を短く復唱する。
  function restateDriverStrategy(st, input) {
    const text = String((input && input.text) || '').trim();
    const at = finite(input && input.at);
    if (!st || !text) return { reply: '', stored: false };
    st.driver_strategy = { text, at };
    bump(st, { kind: 'driver_strategy', at });
    const gist = text.length > 40 ? text.slice(0, 40) + '…' : text;
    return {
      reply: `「${gist}」だね。この方針で今のPlanを見る。`,
      stored: true, revision: revision(st),
    };
  }

  return { create, revision, agreePitPlan, amendPitPlan, cancelPitPlan,
    pitPlan, pitExecuted, recordPitExecuted, answerPitDecision, answerFuel,
    restateDriverStrategy };
}));
