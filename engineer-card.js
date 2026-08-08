'use strict';

// Runtime race-engineer cards.  These are deliberately pure and deterministic:
// spoken race operations are classified here and answered only from liveData.
// The conversational model remains available for conversation, but it cannot
// invent fuel, gaps, pace permission, or pit-cycle positions.

const TOPIC = Object.freeze({
  CURRENT_FUEL: 'current_fuel',
  FUEL_PLAN: 'fuel_plan',
  REJOIN: 'rejoin',
  PACE: 'pace',
  POSITION_GAP: 'position_gap',
});

function classify(text, options = {}) {
  const t = String(text || '').trim();
  if (!t) return null;

  const fuelWord = /燃料|ガソリン|リットル|fuel|lit(?:er|re)/i.test(t);
  const fuelPlan = /給油|足り|必要|不足|余裕|完走|最後|ゴール|チェッカー|入れ|セット|何周.*(?:持|走)|make it|to (?:the )?finish|add fuel|fuel plan/i.test(t);
  if (fuelWord && fuelPlan) return { topic: TOPIC.FUEL_PLAN };
  if (fuelWord && /搭載|残量|現在|いま|今|スタート|積ん|どれだけ|何(?:リットル|L)|on board|remaining|right now|how much/i.test(t)) {
    return { topic: TOPIC.CURRENT_FUEL };
  }
  if (/給油|何(?:リットル|L).*(?:入れ|セット)|(?:入れ|セット).*何(?:リットル|L)/i.test(t)) {
    return { topic: TOPIC.FUEL_PLAN };
  }
  if (/\d+(?:\.\d+)?\s*[lL].*(?:大丈夫|足り|必要)|(?:大丈夫|足り|必要).*\d+(?:\.\d+)?\s*[lL]/.test(t)) {
    return { topic: TOPIC.FUEL_PLAN };
  }
  if (/今.{0,8}\d+(?:\.\d+)?\s*[lL]/.test(t)) return { topic: TOPIC.CURRENT_FUEL };

  if (/アンダーカット|オーバーカット|復帰|戻れ|戻る|ブレンド|サイクル後|予測.{0,8}(?:何位|何番手)|ピット.*(?:何位|何番手|どこ)|(?:何位|何番手).*(?:ピット|戻|復帰)|undercut|overcut|rejoin|blend|cycle position/i.test(t)) {
    return { topic: TOPIC.REJOIN };
  }
  if (/ペース|タイム.*上げ|上げて|プッシュ|攻め|飛ば|push|pace|speed up/i.test(t)) {
    return { topic: TOPIC.PACE };
  }
  if (/(?:P|p)\s*\d+.*(?:何秒|差|ギャップ)|(?:何秒|差|ギャップ).*(?:P|p)\s*\d+|前.*(?:何秒|差|ギャップ)|今.*(?:何位|何番手)|current position|gap/i.test(t)) {
    const m = t.match(/(?:P|p)\s*(\d+)/);
    return { topic: TOPIC.POSITION_GAP, targetPosition: m ? Number(m[1]) : null };
  }
  if (options.race === true && /計算|判断|どうする|大丈夫|予測|これ|それ|もう/.test(t)) {
    const prior = classify(String(options.recentText || ''), { race: false });
    if (prior && [TOPIC.FUEL_PLAN, TOPIC.REJOIN, TOPIC.PACE].includes(prior.topic)) return prior;
  }
  return null;
}

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};
const position = value => {
  const n = finite(value);
  return n != null && n >= 1 ? Math.trunc(n) : null;
};

function fuelPlan(live) {
  const fs = live && typeof live.fuel_strategy === 'object' ? live.fuel_strategy : {};
  const current = finite(live && live.fuel);
  const required = finite(fs.required_fuel_l);
  // This is the number the driver can enter in iRacing while still on track.
  // Recompute it from the current tank level on every live snapshot; a value
  // frozen at the previous S/F crossing becomes stale during the in-lap.
  const add = current != null && required != null ? Math.max(0, required - current) : finite(fs.add_fuel_l);
  return { fs, current, required, add, set: add != null ? Math.ceil(add) : null };
}

function buildCurrentFuel(live, lang) {
  const current = finite(live && live.fuel);
  if (current == null) return lang === 'ja' ? '現在燃料は取得できない。' : 'Current fuel is unavailable.';
  return lang === 'ja' ? `現在${current.toFixed(1)}L。` : `Current fuel ${current.toFixed(1)}L.`;
}

function buildFuelPlan(live, lang) {
  const { fs, current, required, add, set } = fuelPlan(live || {});
  const exact = finite(fs.estimated_crossings_to_finish);
  const provisional = finite(fs.provisional_laps_to_time_expiry);
  if (current != null && required != null && add != null) {
    const distance = Number.isInteger(exact)
      ? (lang === 'ja' ? `チェッカーまでS/Fあと${exact}回。` : `${exact} S/F crossings to the finish. `)
      : Number.isInteger(provisional)
        ? (lang === 'ja' ? `暫定あと${provisional}周分。` : `Provisional ${provisional}-lap plan. `)
        : '';
    if (lang === 'ja') {
      if (add > 0) return `現在${current.toFixed(1)}L。${distance}必要総量${required.toFixed(1)}L。${add.toFixed(1)}L追加、${set}Lセット。`;
      return `現在${current.toFixed(1)}L。${distance}必要総量${required.toFixed(1)}L。給油不要。`;
    }
    if (add > 0) return `Current ${current.toFixed(1)}L. ${distance}${required.toFixed(1)}L total required; add ${add.toFixed(1)}L, set ${set}L.`;
    return `Current ${current.toFixed(1)}L. ${distance}${required.toFixed(1)}L total required; no fuel needed.`;
  }
  const avg = finite(fs.avg_fuel_per_lap);
  if (avg != null) return lang === 'ja'
    ? `現在${current != null ? current.toFixed(1) + 'L。' : ''}平均${avg.toFixed(2)}L/周。ゴール必要量はまだ確定していない。`
    : `${current != null ? `Current ${current.toFixed(1)}L. ` : ''}Average ${avg.toFixed(2)}L/lap; finish requirement is not confirmed.`;
  return lang === 'ja' ? '燃料計画に必要な実測がまだ揃っていない。' : 'Measured data for a fuel plan is not ready.';
}

function buildRejoin(live, lang) {
  const status = live && live.pit_cycle_status;
  if (status && status.active) {
    const current = position(live.class_pos);
    const stopped = Number(status.observed_pack_pit_count) || 0;
    const total = Number(status.observed_pack_car_count) || 0;
    const predicted = position(status.conditional_cycle_position);
    if (lang === 'ja') return `現在P${current || '不明'}。対象集団の停止は${stopped}/${total}台。サイクル後P${predicted || '不明'}予測はまだ未確定。`;
    return `Currently P${current || 'unknown'}. ${stopped}/${total} target cars have stopped; projected cycle P${predicted || 'unknown'} is not confirmed yet.`;
  }
  const outcome = live && live.pit_cycle_outcome;
  if (outcome && outcome.condition_met === true) {
    const actual = position(outcome.post_cycle_actual_position);
    const predicted = position(outcome.conditional_cycle_position);
    if (lang === 'ja') return `ピットサイクル実績P${actual || '不明'}。条件付き予測P${predicted || '不明'}、${actual && predicted ? Math.abs(actual - predicted) + 'ポジション差。' : '誤差は未採点。'}`;
    return `Pit-cycle result P${actual || 'unknown'}. Conditional forecast P${predicted || 'unknown'}${actual && predicted ? `, ${Math.abs(actual - predicted)} positions off.` : '; error ungraded.'}`;
  }
  const f = live && live.pit_exit_forecast;
  const likely = position(f && f.likely && f.likely.position);
  const best = position(f && f.best && f.best.position);
  const worst = position(f && f.worst && f.worst.position);
  if (!(f && f.available && likely && best && worst)) {
    return lang === 'ja' ? '復帰予測のライブデータが揃っていない。順位は出さない。' : 'Live rejoin data is incomplete; I will not give a position.';
  }
  const cycle = f.pit_cycle && f.pit_cycle.if_pack_stops && f.pit_cycle.if_pack_stops.likely;
  const cyclePos = position(cycle && cycle.position);
  const pack = finite(cycle && cycle.pack_car_count);
  if (lang === 'ja') {
    const c = cyclePos && pack ? `近傍${Math.trunc(pack)}台が停止すればサイクル後P${cyclePos}。停止意図は未確認。` : '他車の停止意図は未確認。';
    return `今入る物理復帰P${likely}、範囲P${best}〜P${worst}。${c}`;
  }
  const c = cyclePos && pack ? `If the ${Math.trunc(pack)}-car pack stops, cycle P${cyclePos}; intent unconfirmed.` : 'Rival pit intent is unconfirmed.';
  return `Physical exit P${likely}, range P${best}-P${worst}. ${c}`;
}

function buildPace(live, lang) {
  const { fs, current, required, add } = fuelPlan(live || {});
  const margin = finite(fs.margin_l);
  if (fs.pit_required === true || (add != null && add > 0)) {
    if (lang === 'ja') return `今はペースアップよりピット優先。現在${current != null ? current.toFixed(1) : '不明'}L、必要総量${required != null ? required.toFixed(1) : '未確定'}L。`;
    return `Prioritise the stop, not a pace increase. Current ${current != null ? current.toFixed(1) : 'unknown'}L; ${required != null ? required.toFixed(1) + 'L required' : 'requirement unconfirmed'}.`;
  }
  if (margin != null && margin >= 0) return lang === 'ja'
    ? `燃料は${margin.toFixed(1)}L余裕。ペースを上げていい。ライバル比較は確定データがないので秒数は言わない。`
    : `${margin.toFixed(1)}L fuel margin. You can push; I do not have a verified rival pace delta to quote.`;
  return lang === 'ja' ? 'ペースアップ可否を決める燃料余裕がまだ確定していない。' : 'Fuel margin is not confirmed, so I cannot clear a push yet.';
}

function findStandingGap(live, targetPosition) {
  const raw = live && live.standings_gaps;
  if (raw && !Array.isArray(raw) && typeof raw === 'object') return finite(raw[String(targetPosition)]);
  const rows = Array.isArray(raw) ? raw : [];
  const row = rows.find(r => position(r.class_pos ?? r.class_position ?? r.position) === targetPosition);
  return row ? finite(row.gap_s ?? row.gap_to_player_s ?? row.delta_s) : null;
}

function buildPositionGap(live, targetPosition, lang) {
  const current = position(live && live.class_pos);
  if (targetPosition) {
    const gap = findStandingGap(live, targetPosition);
    if (gap != null) return lang === 'ja' ? `現在P${current || '不明'}。P${targetPosition}まで${Math.abs(gap).toFixed(1)}秒。` : `Currently P${current || 'unknown'}; ${Math.abs(gap).toFixed(1)}s to P${targetPosition}.`;
    return lang === 'ja' ? `現在P${current || '不明'}。P${targetPosition}との確定GAPは取得できない。` : `Currently P${current || 'unknown'}; verified gap to P${targetPosition} is unavailable.`;
  }
  const gap = finite(live && live.gap_ahead);
  if (gap != null) return lang === 'ja' ? `現在P${current || '不明'}。直前車まで${Math.abs(gap).toFixed(1)}秒。` : `Currently P${current || 'unknown'}; ${Math.abs(gap).toFixed(1)}s to the car ahead.`;
  return lang === 'ja' ? `現在P${current || '不明'}。直前車GAPは取得できない。` : `Currently P${current || 'unknown'}; gap ahead is unavailable.`;
}

function build(card, live, lang = 'en') {
  if (!card) return null;
  if (card.topic === TOPIC.CURRENT_FUEL) return buildCurrentFuel(live || {}, lang);
  if (card.topic === TOPIC.FUEL_PLAN) return buildFuelPlan(live || {}, lang);
  if (card.topic === TOPIC.REJOIN) return buildRejoin(live || {}, lang);
  if (card.topic === TOPIC.PACE) return buildPace(live || {}, lang);
  if (card.topic === TOPIC.POSITION_GAP) return buildPositionGap(live || {}, card.targetPosition, lang);
  return null;
}

module.exports = { TOPIC, classify, build, fuelPlan };
