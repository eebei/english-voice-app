'use strict';

// Build 255 substrate: race-operation numbers come from deterministic handlers.
// The LLM remains for ordinary conversation, never for these intents.

const TOPIC = Object.freeze({
  CURRENT_FUEL: 'current_fuel',
  FUEL_PLAN: 'fuel_plan',
  FUEL_USE: 'fuel_use',
  RACE_DISTANCE: 'race_distance',
  REJOIN: 'rejoin',
  PIT_LOSS: 'pit_loss',
  PIT_DECISION: 'pit_decision',
  PIT_SERVICE: 'pit_service',
  PACE: 'pace',
  POSITION_GAP: 'position_gap',
  CURRENT_POSITION: 'current_position',
  LEADER_GAP: 'leader_gap',
  TYRE_STATUS: 'tyre_status',
  DAMAGE_STATUS: 'damage_status',
  WEATHER_STATUS: 'weather_status',
  TRAFFIC_STATUS: 'traffic_status',
  PLAN_STATUS: 'plan_status',
  UNRESOLVED_OPERATIONAL: 'unresolved_operational',
});

const OPERATIONAL_RE = /燃料|給油|ピット|ボックス|順位|何番手|ギャップ|差|ペース|タイヤ|摩耗|ダメージ|修理|天候|気温|路面|雨|残り(?:周|時間)|レース時間|戦略|プラン|アンダー\s*カット|オーバー\s*カット|トラフィック|前の車|後ろの車|fuel|pit|box|position|gap|pace|tyre|tire|damage|repair|weather|rain|laps? left|race time|strategy|plan|traffic|undercut|overcut/i;

function classify(text, options = {}) {
  const t = String(text || '').trim();
  if (!t) return null;

  if (/ピット(?:レーン)?(?:ロス|タイム|時間)|IN.{0,8}OUT|制限ライン.{0,8}(?:秒|時間)|直近.{0,8}ピット.{0,8}(?:秒|時間)|pit loss|pit lane time|in.{0,8}out/i.test(t)) return { topic: TOPIC.PIT_LOSS, confidence: 0.99 };
  if (/ピット(?:作業|サービス)|給油量.*(?:さっき|直近)|停止時間|service time|pit service|fuel added/i.test(t)) return { topic: TOPIC.PIT_SERVICE, confidence: 0.98 };

  const fuelWord = /燃料|燃費|消費|ガソリン|リットル|fuel|consumption|lit(?:er|re)/i.test(t);
  if (fuelWord && /燃費|消費|一周|1周|周あたり|平均|per lap|consumption|burn/i.test(t)) return { topic: TOPIC.FUEL_USE, confidence: 0.99 };
  const fuelPlan = /給油|足り|必要|不足|余裕|完走|最後|ゴール|チェッカー|入れ|セット|何周.*(?:持|走)|make it|to (?:the )?finish|add fuel|fuel plan/i.test(t);
  if (fuelWord && fuelPlan) return { topic: TOPIC.FUEL_PLAN, confidence: 0.99 };
  if (fuelWord && /搭載|残量|現在|いま|今|スタート|積ん|どれだけ|何(?:リットル|L)|on board|remaining|right now|how much/i.test(t)) return { topic: TOPIC.CURRENT_FUEL, confidence: 0.99 };
  if (/給油|何(?:リットル|L).*(?:入れ|セット)|(?:入れ|セット).*何(?:リットル|L)/i.test(t)) return { topic: TOPIC.FUEL_PLAN, confidence: 0.97 };
  if (/\d+(?:\.\d+)?\s*[lL].*(?:大丈夫|足り|必要)|(?:大丈夫|足り|必要).*\d+(?:\.\d+)?\s*[lL]/.test(t)) return { topic: TOPIC.FUEL_PLAN, confidence: 0.96 };
  if (/今.{0,8}\d+(?:\.\d+)?\s*[lL]/.test(t)) return { topic: TOPIC.CURRENT_FUEL, confidence: 0.94 };

  if (/残り.{0,8}(?:何周|周回|時間)|あと.{0,8}(?:何周|何分)|レース.{0,8}(?:何周|何分|時間)|チェッカー|ホワイトフラッグ|race distance|laps? left|time remaining|white flag/i.test(t)) return { topic: TOPIC.RACE_DISTANCE, confidence: 0.98 };
  if (/ボックス(?:する|入る|入れ)|ピット(?:する|入る|入れ|判断)|入るべき|ステイアウト|この(?:ラップ|周).*(?:入|ピット|判断)|判断してくれ|box or|pit or|stay out|should .*pit/i.test(t)) return { topic: TOPIC.PIT_DECISION, confidence: 0.97 };
  if (/アンダー\s*カット|オーバー\s*カット|復帰|戻れ|戻る|ブレンド|サイクル後|予測.{0,8}(?:何位|何番手)|ピット.*(?:何位|何番手|どこ)|(?:何位|何番手).*(?:ピット|戻|復帰)|undercut|overcut|rejoin|blend|cycle position/i.test(t)) return { topic: TOPIC.REJOIN, confidence: 0.99 };
  if (/戦略(?:は|どう|確認)|作戦(?:は|どう|確認)|プラン(?:は|どう|確認)|次の判断|strategy status|what(?:'s| is) the plan|plan status/i.test(t)) return { topic: TOPIC.PLAN_STATUS, confidence: 0.96 };
  if (/トラフィック|集団|クリアエア|前方.*(?:集団|車群)|traffic|pack|clear air/i.test(t)) return { topic: TOPIC.TRAFFIC_STATUS, confidence: 0.96 };
  if (/ペース|タイム.*上げ|上げて|プッシュ|攻め|飛ば|push|pace|speed up/i.test(t)) return { topic: TOPIC.PACE, confidence: 0.97 };

  if (/クラストップ|クラスリーダー|トップまで|首位まで|リーダーまで|overall leader|class leader|gap to (?:the )?leader/i.test(t)) return { topic: TOPIC.LEADER_GAP, confidence: 0.99 };
  if (/(?:P|p)\s*\d+.*(?:何秒|差|ギャップ)|(?:何秒|差|ギャップ).*(?:P|p)\s*\d+|前.*(?:何秒|\d+(?:\.\d+)?秒|差|ギャップ)|gap/i.test(t)) {
    const m = t.match(/(?:P|p)\s*(\d+)/);
    return { topic: TOPIC.POSITION_GAP, targetPosition: m ? Number(m[1]) : null, confidence: 0.97 };
  }
  if (/今.*(?:何位|何番手)|現在.*(?:順位|ポジション)|順位は|current position|what position/i.test(t)) return { topic: TOPIC.CURRENT_POSITION, confidence: 0.98 };
  if (/タイヤ|摩耗|温度|左前|右前|左後|右後|tyre|tire|wear/i.test(t)) return { topic: TOPIC.TYRE_STATUS, confidence: 0.97 };
  if (/ダメージ|損傷|修理|壊れ|damage|repair/i.test(t)) return { topic: TOPIC.DAMAGE_STATUS, confidence: 0.98 };
  if (/天気|天候|気温|路面温度|雨|濡れ|湿度|weather|track temp|air temp|rain|wet/i.test(t)) return { topic: TOPIC.WEATHER_STATUS, confidence: 0.98 };

  if (options.race === true && /^\s*\d+(?:\.\d+)?\s*[lL](?:級|ぐらい|くらい|だ|です)?[。.!！?？]?\s*$/.test(t)) return { topic: TOPIC.FUEL_PLAN, confidence: 0.85 };
  if (options.race === true && /計算|判断|どうする|大丈夫|予測|これ|それ|もう/.test(t)) {
    const prior = classify(String(options.recentText || ''), { race: false });
    if (prior && ![TOPIC.CURRENT_POSITION, TOPIC.UNRESOLVED_OPERATIONAL].includes(prior.topic)) return { ...prior, confidence: Math.min(prior.confidence || 0.9, 0.9), inherited: true };
  }
  if (options.race === true && OPERATIONAL_RE.test(t)) return { topic: TOPIC.UNRESOLVED_OPERATIONAL, confidence: 0 };
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
const ja = lang => lang === 'ja';

function fuelPlan(live) {
  const fs = live && typeof live.fuel_strategy === 'object' ? live.fuel_strategy : {};
  const current = finite(live && live.fuel);
  const required = finite(fs.required_fuel_l);
  const add = current != null && required != null ? Math.max(0, required - current) : finite(fs.add_fuel_l);
  return { fs, current, required, add, set: add != null ? Math.ceil(add) : null };
}

function buildCurrentFuel(live, lang) {
  const current = finite(live && live.fuel);
  if (current == null) return ja(lang) ? '現在燃料は取得できない。' : 'Current fuel is unavailable.';
  return ja(lang) ? `現在${current.toFixed(1)}L。` : `Current fuel ${current.toFixed(1)}L.`;
}

function buildFuelUse(live, lang) {
  const fs = live && live.fuel_strategy || {};
  const avg = finite(fs.avg_fuel_per_lap), samples = finite(fs.clean_laps_sampled), range = finite(fs.laps_of_fuel_left);
  if (avg == null) return ja(lang) ? '一周あたりの燃料消費はまだ実測できていない。' : 'Measured fuel use per lap is not ready.';
  return ja(lang)
    ? `平均${avg.toFixed(2)}L/周、クリーン${samples == null ? '不明' : Math.trunc(samples)}周の実測。現在燃料で約${range == null ? '不明' : range.toFixed(1)}周。`
    : `${avg.toFixed(2)}L/lap from ${samples == null ? 'unknown' : Math.trunc(samples)} clean laps; about ${range == null ? 'unknown' : range.toFixed(1)} laps in the tank.`;
}

function buildFuelPlan(live, lang) {
  const { fs, current, required, add, set } = fuelPlan(live || {});
  const exact = finite(fs.estimated_crossings_to_finish), provisional = finite(fs.provisional_laps_to_time_expiry);
  if (current != null && required != null && add != null) {
    const distance = Number.isInteger(exact)
      ? (ja(lang) ? `チェッカーまでS/Fあと${exact}回。` : `${exact} S/F crossings to the finish. `)
      : Number.isInteger(provisional) ? (ja(lang) ? `暫定あと${provisional}周分。` : `Provisional ${provisional}-lap plan. `) : '';
    if (ja(lang)) return add > 0
      ? `現在${current.toFixed(1)}L。${distance}必要総量${required.toFixed(1)}L。${add.toFixed(1)}L追加、${set}Lセット。`
      : `現在${current.toFixed(1)}L。${distance}必要総量${required.toFixed(1)}L。給油不要。`;
    return add > 0
      ? `Current ${current.toFixed(1)}L. ${distance}${required.toFixed(1)}L total required; add ${add.toFixed(1)}L, set ${set}L.`
      : `Current ${current.toFixed(1)}L. ${distance}${required.toFixed(1)}L total required; no fuel needed.`;
  }
  const avg = finite(fs.avg_fuel_per_lap);
  if (avg != null) return ja(lang)
    ? `現在${current != null ? current.toFixed(1) + 'L。' : ''}平均${avg.toFixed(2)}L/周。ゴール必要量はまだ確定していない。`
    : `${current != null ? `Current ${current.toFixed(1)}L. ` : ''}Average ${avg.toFixed(2)}L/lap; finish requirement is not confirmed.`;
  return ja(lang) ? '燃料計画に必要な実測がまだ揃っていない。' : 'Measured data for a fuel plan is not ready.';
}

function buildRaceDistance(live, lang) {
  const plan = live && live.race_plan || {};
  const crossings = finite(live && live.finish_crossings_authority);
  const remaining = finite(live && live.session_time_remaining_s);
  const totalLaps = finite(live && live.laps_total), lap = finite(live && live.lap);
  if (plan.kind === 'timed') {
    const clock = remaining != null ? `${Math.floor(remaining / 60)}:${String(Math.floor(remaining % 60)).padStart(2, '0')}` : null;
    if (ja(lang)) return `${clock ? `残り時間${clock}。` : '残り時間は未取得。'}${crossings != null ? `チェッカーまでS/Fあと${Math.trunc(crossings)}回。` : '残り周回はまだ確定していない。'}`;
    return `${clock ? `${clock} remaining. ` : 'Remaining time unavailable. '}${crossings != null ? `${Math.trunc(crossings)} S/F crossings to the finish.` : 'Remaining laps are not confirmed yet.'}`;
  }
  if (plan.kind === 'laps' && totalLaps != null && lap != null) {
    const left = Math.max(0, Math.trunc(totalLaps - lap));
    return ja(lang) ? `全${Math.trunc(totalLaps)}周、現在${Math.trunc(lap)}周目。残り約${left}周。` : `${Math.trunc(totalLaps)} laps total, lap ${Math.trunc(lap)} now, about ${left} remaining.`;
  }
  return ja(lang) ? 'レース距離の権威データが未確定。周回数は作らない。' : 'Authoritative race distance is unavailable; I will not invent a lap count.';
}

function buildRejoin(live, lang) {
  const status = live && live.pit_cycle_status;
  if (status && status.active) {
    const current = position(live.class_pos), stopped = Number(status.observed_pack_pit_count) || 0;
    const total = Number(status.observed_pack_car_count) || 0, predicted = position(status.conditional_cycle_position);
    return ja(lang) ? `現在P${current || '不明'}。対象集団の停止は${stopped}/${total}台。サイクル後P${predicted || '不明'}予測はまだ未確定。`
      : `Currently P${current || 'unknown'}. ${stopped}/${total} target cars have stopped; projected cycle P${predicted || 'unknown'} is not confirmed yet.`;
  }
  const outcome = live && live.pit_cycle_outcome;
  if (outcome && outcome.condition_met === true) {
    const actual = position(outcome.post_cycle_actual_position), predicted = position(outcome.conditional_cycle_position);
    return ja(lang) ? `ピットサイクル実績P${actual || '不明'}。条件付き予測P${predicted || '不明'}、${actual && predicted ? Math.abs(actual - predicted) + 'ポジション差。' : '誤差は未採点。'}`
      : `Pit-cycle result P${actual || 'unknown'}. Conditional forecast P${predicted || 'unknown'}${actual && predicted ? `, ${Math.abs(actual - predicted)} positions off.` : '; error ungraded.'}`;
  }
  const f = live && live.pit_exit_forecast;
  const likely = position(f && f.likely && f.likely.position), best = position(f && f.best && f.best.position), worst = position(f && f.worst && f.worst.position);
  if (!(f && f.available && likely && best && worst)) return ja(lang) ? '復帰予測のライブデータが揃っていない。順位は出さない。' : 'Live rejoin data is incomplete; I will not give a position.';
  const cycle = f.pit_cycle && f.pit_cycle.if_pack_stops && f.pit_cycle.if_pack_stops.likely;
  const cyclePos = position(cycle && cycle.position), pack = finite(cycle && cycle.pack_car_count);
  if (ja(lang)) return `今入る物理復帰P${likely}、範囲P${best}〜P${worst}。${cyclePos && pack ? `近傍${Math.trunc(pack)}台が停止すればサイクル後P${cyclePos}。停止意図は未確認。` : '他車の停止意図は未確認。'}`;
  return `Physical exit P${likely}, range P${best}-P${worst}. ${cyclePos && pack ? `If the ${Math.trunc(pack)}-car pack stops, cycle P${cyclePos}; intent unconfirmed.` : 'Rival pit intent is unconfirmed.'}`;
}

function buildPitLoss(live, lang) {
  const exact = live && live.last_pit_service || {};
  const lane = finite(exact.lane_total_s);
  if (lane != null && lane > 0) return ja(lang) ? `直近のINからOUTまで${lane.toFixed(1)}秒。実測値。` : `Latest measured IN-to-OUT time: ${lane.toFixed(1)}s.`;
  const cal = live && live.pit_loss_calibration || {};
  const median = finite(cal.lane_total_median_s), q1 = finite(cal.lane_total_q1_s), q3 = finite(cal.lane_total_q3_s), count = finite(cal.usable_sample_count);
  if (median != null) return ja(lang)
    ? `この車とコースのピットレーン中央値${median.toFixed(1)}秒${q1 != null && q3 != null ? `、実測範囲${q1.toFixed(1)}〜${q3.toFixed(1)}秒` : ''}。${count != null ? `${Math.trunc(count)}件の実測。` : ''}`
    : `Car-and-track pit-lane median ${median.toFixed(1)}s${q1 != null && q3 != null ? `, measured band ${q1.toFixed(1)}-${q3.toFixed(1)}s` : ''}${count != null ? ` from ${Math.trunc(count)} samples.` : '.'}`;
  return ja(lang) ? 'この車とコースのピットロス実測はまだ利用できない。' : 'Measured pit loss for this car and track is unavailable.';
}

function buildPitService(live, lang) {
  const sample = live && live.last_pit_service || {};
  const lane = finite(sample.lane_total_s), stall = finite(sample.stall_s), fuel = finite(sample.fuel_added_l);
  if (lane == null && stall == null && fuel == null) return ja(lang) ? '直近のピットサービス実測はまだない。' : 'No measured pit-service sample is available yet.';
  return ja(lang)
    ? `直近ピットはIN→OUT ${lane == null ? '不明' : lane.toFixed(1) + '秒'}、停止${stall == null ? '不明' : stall.toFixed(1) + '秒'}、給油${fuel == null ? '不明' : fuel.toFixed(1) + 'L'}。`
    : `Latest stop: IN-to-OUT ${lane == null ? 'unknown' : lane.toFixed(1) + 's'}, stationary ${stall == null ? 'unknown' : stall.toFixed(1) + 's'}, fuel ${fuel == null ? 'unknown' : fuel.toFixed(1) + 'L'}.`;
}

function derivedAction(live) {
  const owned = live && live.strategy_plan;
  if (owned && owned.action) return owned;
  const { fs, add, set } = fuelPlan(live || {});
  if (fs.pit_required === true || (add != null && add > 0)) return { action: 'box', reason: 'fuel_shortfall', set_fuel_l: set };
  const margin = finite(fs.margin_l);
  if (margin != null && margin >= 0) return { action: 'push', reason: 'fuel_margin', margin_l: margin };
  return { action: 'hold', reason: 'insufficient_data' };
}

function buildPitDecision(live, lang) {
  const p = derivedAction(live);
  if (p.action === 'box') return ja(lang) ? `判断はボックス。燃料不足が根拠。給油設定は${finite(p.set_fuel_l) == null ? '未確定' : Math.trunc(p.set_fuel_l) + 'L'}。` : `Decision: box for the fuel shortfall. Set ${finite(p.set_fuel_l) == null ? 'unconfirmed' : Math.trunc(p.set_fuel_l) + 'L'}.`;
  if (p.action === 'push') return ja(lang) ? `判断はステイアウトしてプッシュ。燃料余裕${finite(p.margin_l) == null ? '確認済み' : finite(p.margin_l).toFixed(1) + 'L'}。` : `Decision: stay out and push; fuel margin ${finite(p.margin_l) == null ? 'confirmed' : finite(p.margin_l).toFixed(1) + 'L'}.`;
  return ja(lang) ? '判断はホールド。確定データが足りないのでボックス指示は出さない。' : 'Decision: hold. Data is insufficient, so I will not call a stop.';
}

function buildPlanStatus(live, lang) {
  const p = derivedAction(live), rev = finite(p.revision);
  const prefix = rev != null ? (ja(lang) ? `プラン改訂${Math.trunc(rev)}。` : `Plan revision ${Math.trunc(rev)}. `) : '';
  if (p.action === 'box') return prefix + (ja(lang) ? `燃料不足でボックス。給油${finite(p.set_fuel_l) == null ? '未確定' : Math.trunc(p.set_fuel_l) + 'L'}。` : `Box for fuel; set ${finite(p.set_fuel_l) == null ? 'unconfirmed' : Math.trunc(p.set_fuel_l) + 'L'}.`);
  if (p.action === 'push') return prefix + (ja(lang) ? 'ステイアウトしてプッシュ。燃料余裕あり。' : 'Stay out and push; fuel margin is positive.');
  return prefix + (ja(lang) ? '現在はホールド。次の確定データでだけプランを更新する。' : 'Hold for now; the plan changes only on confirmed data.');
}

function buildPace(live, lang) {
  const { fs, current, required, add } = fuelPlan(live || {}), margin = finite(fs.margin_l);
  if (fs.pit_required === true || (add != null && add > 0)) return ja(lang) ? `今はペースアップよりピット優先。現在${current != null ? current.toFixed(1) : '不明'}L、必要総量${required != null ? required.toFixed(1) : '未確定'}L。` : `Prioritise the stop, not a pace increase. Current ${current != null ? current.toFixed(1) : 'unknown'}L; ${required != null ? required.toFixed(1) + 'L required' : 'requirement unconfirmed'}.`;
  if (margin != null && margin >= 0) return ja(lang) ? `燃料は${margin.toFixed(1)}L余裕。ペースを上げていい。ライバル比較は確定データがないので秒数は言わない。` : `${margin.toFixed(1)}L fuel margin. You can push; I do not have a verified rival pace delta to quote.`;
  return ja(lang) ? 'ペースアップ可否を決める燃料余裕がまだ確定していない。' : 'Fuel margin is not confirmed, so I cannot clear a push yet.';
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
    if (gap != null) return ja(lang) ? `現在P${current || '不明'}。P${targetPosition}まで${Math.abs(gap).toFixed(1)}秒。` : `Currently P${current || 'unknown'}; ${Math.abs(gap).toFixed(1)}s to P${targetPosition}.`;
    return ja(lang) ? `現在P${current || '不明'}。P${targetPosition}との確定GAPは取得できない。` : `Currently P${current || 'unknown'}; verified gap to P${targetPosition} is unavailable.`;
  }
  const gap = finite(live && live.gap_ahead);
  if (gap != null) return ja(lang) ? `現在P${current || '不明'}。直前車まで${Math.abs(gap).toFixed(1)}秒。` : `Currently P${current || 'unknown'}; ${Math.abs(gap).toFixed(1)}s to the car ahead.`;
  return ja(lang) ? `現在P${current || '不明'}。直前車GAPは取得できない。` : `Currently P${current || 'unknown'}; gap ahead is unavailable.`;
}

function buildCurrentPosition(live, lang) {
  const cls = position(live && live.class_pos), overall = position(live && live.pos);
  if (cls == null && overall == null) return ja(lang) ? '現在順位は取得できない。' : 'Current position is unavailable.';
  return ja(lang) ? `クラスP${cls || '不明'}、総合P${overall || '不明'}。` : `Class P${cls || 'unknown'}, overall P${overall || 'unknown'}.`;
}

function buildLeaderGap(live, lang) {
  const leader = live && live.leaders && live.leaders.player_class;
  const gap = finite(leader && leader.gap_s), current = position(live && live.class_pos);
  if (current === 1) return ja(lang) ? '現在クラスリーダー。' : 'You are the class leader.';
  if (gap == null) return ja(lang) ? 'クラスリーダーとの確定GAPは取得できない。' : 'Verified gap to the class leader is unavailable.';
  return ja(lang) ? `クラスリーダーまで${Math.abs(gap).toFixed(1)}秒。` : `${Math.abs(gap).toFixed(1)}s to the class leader.`;
}

function buildTyreStatus(live, lang) {
  const tires = live && live.tires || {}, names = { lf:'左前', rf:'右前', lr:'左後', rr:'右後' };
  const rows = Object.keys(names).map(k => {
    const tire = tires[k] || {}, wear = Array.isArray(tire.w) ? tire.w.map(finite).filter(v => v != null) : [];
    const temp = Array.isArray(tire.t) ? tire.t.map(finite).filter(v => v != null) : [];
    return { k, wear: wear.length ? Math.min(...wear) : null, temp: temp.length ? temp.reduce((a,b)=>a+b,0)/temp.length : null };
  });
  if (!rows.some(r => r.wear != null || r.temp != null)) return ja(lang) ? '走行中に信頼できるタイヤ摩耗・温度は取得できない。' : 'Reliable tyre wear and temperature are unavailable while running.';
  const parts = rows.filter(r=>r.wear != null || r.temp != null).map(r => ja(lang)
    ? `${names[r.k]} 残${r.wear == null ? '不明' : r.wear.toFixed(1) + '%'}${r.temp == null ? '' : ` ${r.temp.toFixed(1)}℃`}`
    : `${r.k.toUpperCase()} ${r.wear == null ? 'wear unknown' : r.wear.toFixed(1) + '% remaining'}${r.temp == null ? '' : ` ${r.temp.toFixed(1)}C`}`);
  return parts.join(ja(lang) ? '、' : ', ') + (ja(lang) ? '。' : '.');
}

function buildDamageStatus(live, lang) {
  const seconds = finite(live && live.damage_s);
  if (seconds == null) return ja(lang) ? 'SDK修理時間は取得できない。' : 'SDK repair time is unavailable.';
  if (seconds > 0) return ja(lang) ? `SDKの修理残り${seconds.toFixed(1)}秒。` : `${seconds.toFixed(1)}s SDK repair time remaining.`;
  return ja(lang) ? 'SDKの修理残り0.0秒。空力損傷なしとは断定しない。' : 'SDK repair time is 0.0s; that does not prove zero aero damage.';
}

function buildWeatherStatus(live, lang) {
  const w = live && live.weather || {}, track = finite(w.track_temp_c), air = finite(w.air_temp_c), humidity = finite(w.humidity), wet = finite(w.track_wetness_code);
  if ([track, air, humidity, wet].every(v=>v == null)) return ja(lang) ? '天候テレメトリは取得できない。' : 'Weather telemetry is unavailable.';
  const wetJP = {1:'ドライ',2:'ほぼドライ',3:'ごく薄いウェット',4:'ライトウェット',5:'ウェット',6:'かなりウェット',7:'極端なウェット'};
  const wetEN = {1:'dry',2:'mostly dry',3:'very lightly wet',4:'lightly wet',5:'moderately wet',6:'very wet',7:'extremely wet'};
  return ja(lang)
    ? `路面${track == null ? '不明' : track.toFixed(1) + '℃'}、気温${air == null ? '不明' : air.toFixed(1) + '℃'}、湿度${humidity == null ? '不明' : humidity.toFixed(0) + '%'}、路面${wet == null ? '不明' : wetJP[Math.trunc(wet)] || '不明'}。`
    : `Track ${track == null ? 'unknown' : track.toFixed(1) + 'C'}, air ${air == null ? 'unknown' : air.toFixed(1) + 'C'}, humidity ${humidity == null ? 'unknown' : humidity.toFixed(0) + '%'}, surface ${wet == null ? 'unknown' : wetEN[Math.trunc(wet)] || 'unknown'}.`;
}

function buildTrafficStatus(live, lang) {
  const f = live && live.pit_exit_forecast || {}, likely = f && f.likely || {};
  const state = String(likely.traffic_state || f.traffic_state || ''), ahead = likely.ahead || {}, behind = likely.behind || {};
  if (!state) {
    const a = finite(live && live.gap_ahead), b = finite(live && live.gap_behind);
    if (a == null && b == null) return ja(lang) ? '前後トラフィックの確定データは取得できない。' : 'Verified traffic data is unavailable.';
    return ja(lang) ? `走行中の前${a == null ? '不明' : a.toFixed(1) + '秒'}、後ろ${b == null ? '不明' : b.toFixed(1) + '秒'}。ピット復帰トラフィックは未計算。` : `On-track gaps: ahead ${a == null ? 'unknown' : a.toFixed(1) + 's'}, behind ${b == null ? 'unknown' : b.toFixed(1) + 's'}; pit-exit traffic is uncalculated.`;
  }
  const label = state === 'clear_air' ? (ja(lang) ? 'クリアエア' : 'clear air') : (ja(lang) ? 'トラフィック内' : 'in traffic');
  const ag = finite(ahead.gap_s), bg = finite(behind.gap_s);
  return ja(lang) ? `予測復帰は${label}。前${ag == null ? '不明' : ag.toFixed(1) + '秒'}、後ろ${bg == null ? '不明' : bg.toFixed(1) + '秒'}。` : `Predicted rejoin is ${label}; ahead ${ag == null ? 'unknown' : ag.toFixed(1) + 's'}, behind ${bg == null ? 'unknown' : bg.toFixed(1) + 's'}.`;
}

function buildUnresolved(lang) {
  return ja(lang) ? 'そのレース運用質問は専用handlerに未接続。推測では答えない。' : 'That race-operation question has no dedicated handler yet; I will not guess.';
}

function build(card, live, lang = 'en') {
  if (!card) return null;
  const handlers = {
    [TOPIC.CURRENT_FUEL]: buildCurrentFuel, [TOPIC.FUEL_PLAN]: buildFuelPlan,
    [TOPIC.FUEL_USE]: buildFuelUse, [TOPIC.RACE_DISTANCE]: buildRaceDistance,
    [TOPIC.REJOIN]: buildRejoin, [TOPIC.PIT_LOSS]: buildPitLoss,
    [TOPIC.PIT_DECISION]: buildPitDecision, [TOPIC.PIT_SERVICE]: buildPitService,
    [TOPIC.PACE]: buildPace, [TOPIC.CURRENT_POSITION]: buildCurrentPosition,
    [TOPIC.LEADER_GAP]: buildLeaderGap, [TOPIC.TYRE_STATUS]: buildTyreStatus,
    [TOPIC.DAMAGE_STATUS]: buildDamageStatus, [TOPIC.WEATHER_STATUS]: buildWeatherStatus,
    [TOPIC.TRAFFIC_STATUS]: buildTrafficStatus, [TOPIC.PLAN_STATUS]: buildPlanStatus,
  };
  if (card.topic === TOPIC.POSITION_GAP) return buildPositionGap(live || {}, card.targetPosition, lang);
  if (card.topic === TOPIC.UNRESOLVED_OPERATIONAL) return buildUnresolved(lang);
  const handler = handlers[card.topic];
  return handler ? handler(live || {}, lang) : null;
}

function route(text, live, lang = 'en', options = {}) {
  const card = classify(text, options);
  if (!card) return null;
  const reply = build(card, live || {}, lang);
  return { card, reply, status: card.topic === TOPIC.UNRESOLVED_OPERATIONAL ? 'unavailable' : 'fired' };
}

module.exports = { TOPIC, classify, build, route, fuelPlan, OPERATIONAL_RE };
