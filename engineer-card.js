'use strict';

// Build 255 substrate: race-operation numbers come from deterministic handlers.
// The LLM remains for ordinary conversation, never for these intents.

const TOPIC = Object.freeze({
  CURRENT_FUEL: 'current_fuel',
  FUEL_EMERGENCY: 'fuel_emergency',
  FUEL_PLAN: 'fuel_plan',
  FUEL_USE: 'fuel_use',
  RACE_DISTANCE: 'race_distance',
  REJOIN: 'rejoin',
  PIT_LOSS: 'pit_loss',
  PIT_DECISION: 'pit_decision',
  STRATEGY_SWITCH: 'strategy_switch',
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
  SESSION_FORMAT: 'session_format',
  ACKNOWLEDGEMENT: 'acknowledgement',
  UNRESOLVED_OPERATIONAL: 'unresolved_operational',
});

const OPERATIONAL_RE = /燃料|給油|リットル|リッター|ピット|ボックス|順位|何番手|ギャップ|差|ペース|タイヤ|摩耗|ダメージ|修理|天候|気温|路面|雨|残り(?:周|時間)|レース時間|戦略|プラン|アンダー\s*カット|オーバー\s*カット|トラフィック|前の車|後ろの車|fuel|pit|box|position|gap|pace|tyre|tire|damage|repair|weather|rain|laps? left|race time|strategy|plan|traffic|undercut|overcut/i;

function classify(text, options = {}) {
  const t = String(text || '').trim();
  if (!t) return null;

  if (/ピット(?:レーン)?(?:ロス|タイム|時間)|IN.{0,8}OUT|制限ライン.{0,8}(?:秒|時間)|直近.{0,8}ピット.{0,8}(?:秒|時間)|pit loss|pit lane time|in.{0,8}out/i.test(t)) return { topic: TOPIC.PIT_LOSS, confidence: 0.99 };
  if (/ピット(?:作業|サービス)|給油量.*(?:さっき|直近)|停止時間|service time|pit service|fuel added/i.test(t)) return { topic: TOPIC.PIT_SERVICE, confidence: 0.98 };

  const shortageClarification = t.match(/(\d+(?:\.\d+)?)\s*(?:リットル|リッター|[lL])\s*(?:足りない|たりない|不足)(?:ってこと|ということ)?/i);
  if (shortageClarification) return {
    topic: TOPIC.FUEL_PLAN,
    confidence: 0.995,
    shortageClarificationL: Number(shortageClarification[1]),
  };

  const fuelWord = /燃料|燃費|消費|ガソリン|リットル|リッター|fuel|consumption|lit(?:er|re)/i.test(t);
  // A splash question is not a generic checker-distance question.  It asks
  // whether the planned stop leaves another fuel stop before the finish.
  if (/スプラッシュ|splash/i.test(t)) return {
    topic: TOPIC.FUEL_PLAN,
    splashQuestion: true,
    confidence: 0.995,
  };
  // Fuel starvation is a safety-critical immediate condition.  It must not
  // fall into the generic "wait for the next S/F" follow-up path.
  if (/(?:ガス欠|燃料.{0,10}(?:ゼロ|0(?:\.0+)?\s*(?:[lL]|リットル|リッター)?|持たない)|ピット.{0,10}持たない|out of fuel|won'?t make it to (?:the )?pit)/i.test(t)) return { topic: TOPIC.FUEL_EMERGENCY, confidence: 0.995 };
  if (fuelWord && /燃費|消費|一周|1周|周あたり|平均|per lap|consumption|burn/i.test(t)) return { topic: TOPIC.FUEL_USE, confidence: 0.99 };
  const fuelPlan = /給油|足り|必要|不足|余裕|完走|最後|ゴール|チェッカー|入れ|セット|何周.*(?:持|走)|make it|to (?:the )?finish|add fuel|fuel plan/i.test(t);
  if (fuelWord && fuelPlan) return { topic: TOPIC.FUEL_PLAN, confidence: 0.99 };
  if (fuelWord && /搭載|残量|現在|いま|今|スタート|積ん|どれだけ|何(?:リットル|リッター|L)|0(?:\.?0*)?(?:\s*[lL])?|ゼロ|on board|remaining|right now|how much/i.test(t)) return { topic: TOPIC.CURRENT_FUEL, confidence: 0.99 };
  if (/給油|何(?:リットル|リッター|L).*(?:入れ|セット)|(?:入れ|セット).*何(?:リットル|リッター|L)/i.test(t)) return { topic: TOPIC.FUEL_PLAN, confidence: 0.97 };
  if (/\d+(?:\.\d+)?\s*[lL].*(?:大丈夫|足り|必要)|(?:大丈夫|足り|必要).*\d+(?:\.\d+)?\s*[lL]/.test(t)) return { topic: TOPIC.FUEL_PLAN, confidence: 0.96 };
  if (/今.{0,8}\d+(?:\.\d+)?\s*[lL]/.test(t)) return { topic: TOPIC.CURRENT_FUEL, confidence: 0.94 };

  if (/(?:レース.{0,10})?(?:フォーマット|フォーマー|形式)|レース.{0,10}(?:距離|時間)|何分\s*(?:制|製)(?:の)?(?:レース)?|予選(?:あり|なし)|このセッション.{0,8}(?:何|なん|どれ)|セッション.{0,8}(?:何|なん|どれ|練習|予選|決勝)|練習.{0,8}予選.{0,8}(?:決勝|レース)|session format|race format|qualifying/i.test(t)) return { topic: TOPIC.SESSION_FORMAT, confidence: 0.99 };
  if (/残り.{0,8}(?:何[周週]|周回|時間)|あと.{0,8}(?:何[周週]|何分)|レース.{0,8}(?:何[周週]|何分|時間)|チェッカー|ホワイトフラッグ|race distance|laps? left|time remaining|white flag/i.test(t)) return { topic: TOPIC.RACE_DISTANCE, confidence: 0.98 };
  if (/(?:アンダー\s*カット|オーバー\s*カット).*(?:どう思う|どうする|あり|狙|判断|いけ)|(?:どう思う|どうする|判断).*(?:アンダー\s*カット|オーバー\s*カット)/i.test(t)) return {
    topic: TOPIC.STRATEGY_SWITCH,
    requestedPlan: /オーバー\s*カット|overcut/i.test(t) ? 'C' : 'B',
    confidence: 0.99,
  };
  if (/ボックス(?:する|入る|入れ)|ピット(?:する|入る|入れ|判断)|入るべき|ステイアウト|もう(?:1|一)周|この(?:ラップ|周).*(?:入|ピット|判断)|(?:この|ディス|this)(?:ラップ|周|lap).{0,8}(?:ボックス|box)|判断してくれ|box or|pit or|stay out|should .*pit/i.test(t)) return { topic: TOPIC.PIT_DECISION, confidence: 0.97 };
  if (/アンダー\s*カット|オーバー\s*カット|復帰|戻れ|戻る|ブレンド|サイクル後|予測.{0,12}(?:何位|何番手|順位|ポジション)|(?:何位|何番手|順位|ポジション).{0,12}予測|ピット.*(?:何位|何番手|どこ)|(?:何位|何番手).*(?:ピット|戻|復帰)|undercut|overcut|rejoin|blend|cycle position/i.test(t)) return { topic: TOPIC.REJOIN, confidence: 0.99 };
  if (/戦略.{0,8}(?:は|どう|確認|ある|何|教)|作戦.{0,8}(?:は|どう|確認|ある|何|教)|プラン.{0,8}(?:は|どう|確認|ある|何|教)|プラン\s*[ABCＡＢＣ]|次の判断|strategy status|what(?:'s| is) the plan|plan status|plan\s*[abc]/i.test(t)) {
    const choice=/プラン\s*[AＡ]|plan\s*a/i.test(t)?'A':/プラン\s*[BＢ]|plan\s*b/i.test(t)?'B':/プラン\s*[CＣ]|plan\s*c/i.test(t)?'C':null;
    return { topic: TOPIC.PLAN_STATUS, planChoice: choice, confidence: 0.96 };
  }
  if (/トラフィック|集団|クリアエア|前方.*(?:集団|車群)|traffic|pack|clear air/i.test(t)) return { topic: TOPIC.TRAFFIC_STATUS, confidence: 0.96 };
  if (/ペース|タイム.*上げ|上げて|プッシュ|攻め|飛ば|push|pace|speed up/i.test(t)) return { topic: TOPIC.PACE, confidence: 0.97 };

  if (/クラストップ|クラスリーダー|トップまで|首位まで|リーダーまで|overall leader|class leader|gap to (?:the )?leader/i.test(t)) return { topic: TOPIC.LEADER_GAP, confidence: 0.99 };
  if (/(?:P|p)\s*\d+.*(?:何秒|差|ギャップ)|(?:何秒|差|ギャップ).*(?:P|p)\s*\d+|前.*(?:何秒|\d+(?:\.\d+)?秒|差|ギャップ)|gap/i.test(t)) {
    const m = t.match(/(?:P|p)\s*(\d+)/);
    return { topic: TOPIC.POSITION_GAP, targetPosition: m ? Number(m[1]) : null, confidence: 0.97 };
  }
  if (/今.*(?:何位|何番手)|現在.*(?:順位|ポジション)|順位は|current position|what position/i.test(t)) return { topic: TOPIC.CURRENT_POSITION, confidence: 0.98 };
  // Weather must win before the generic tyre vocabulary.  Previously
  // "路面温度" matched the bare "温度" tyre rule and returned tyre wear.
  if (/天気|天候|気温|路面(?:温度|状況)|路温|トラック温度|雨|濡れ|湿度|weather|track temp|air temp|rain|wet/i.test(t)) return { topic: TOPIC.WEATHER_STATUS, confidence: 0.99 };
  if (/タイヤ|摩耗|左前|右前|左後|右後|tyre|tire|wear/i.test(t)) {
    const tyreQuery = /(?:タイヤ|tyre|tire).{0,8}(?:温度|temp)|(?:温度|temp).{0,8}(?:タイヤ|tyre|tire)/i.test(t)
      ? 'temperature'
      : /摩耗|残量|残り|wear/i.test(t) ? 'wear' : 'status';
    return { topic: TOPIC.TYRE_STATUS, tyreQuery, confidence: 0.98 };
  }
  if (/ダメージ|損傷|修理|壊れ|damage|repair/i.test(t)) return { topic: TOPIC.DAMAGE_STATUS, confidence: 0.98 };

  if (options.race === true && /^\s*\d+(?:\.\d+)?\s*[lL](?:級|ぐらい|くらい|だ|です)?[。.!！?？]?\s*$/.test(t)) return { topic: TOPIC.FUEL_PLAN, confidence: 0.85 };
  if (options.race === true && /計算|判断|どうする|大丈夫|予測|これ|それ|もう/.test(t)) {
    const prior = classify(String(options.recentText || ''), { race: false });
    if (prior && ![TOPIC.CURRENT_POSITION, TOPIC.UNRESOLVED_OPERATIONAL].includes(prior.topic)) return {
      ...prior,
      confidence: Math.min(prior.confidence || 0.9, 0.9),
      inherited: true,
      actionRequested: /どうする|どっち|ゆっくり|セーブ|飛ば|ペース/i.test(t),
    };
  }
  if (options.race === true && OPERATIONAL_RE.test(t)) return { topic: TOPIC.UNRESOLVED_OPERATIONAL, confidence: 0 };
  if (/^(?:了解|了解です|分かった|わかった|なるほど|OK|オーケー|ありがとう|ナイス)[。.!！?？]*$/i.test(t)) {
    return { topic: TOPIC.ACKNOWLEDGEMENT, confidence: 1 };
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
const ja = lang => lang === 'ja';

function formatDuration(seconds, lang = 'en') {
  const value = finite(seconds);
  if (value == null) return null;
  const total = Math.max(0, Math.round(value));
  const minutes = Math.floor(total / 60), rest = total % 60;
  if (ja(lang)) return minutes > 0 ? `${minutes}分${rest}秒` : `${rest}秒`;
  if (minutes > 0) return `${minutes} minute${minutes === 1 ? '' : 's'} ${rest} second${rest === 1 ? '' : 's'}`;
  return `${rest} second${rest === 1 ? '' : 's'}`;
}

function pitPhase(live) {
  const lifecycle = String(live && live.lifecycle_state || '').toUpperCase();
  if (['PLAYER_FINISHED', 'DEBRIEF'].includes(lifecycle)) return 'finished';
  const explicit = String(live && live.pit_phase_state || '').toLowerCase();
  if (['in_lap', 'pit_lane', 'out_lap', 'racing', 'finished'].includes(explicit)) return explicit;
  if (live && live.on_pit_road === true) return 'pit_lane';
  return 'racing';
}

function fuelPlan(live) {
  const fs = live && typeof live.fuel_strategy === 'object' ? live.fuel_strategy : {};
  const current = finite(live && live.fuel);
  const required = finite(fs.required_fuel_l);
  const authoritativeAdd = finite(fs.evaluated_fuel_l) != null || fs.awaiting_post_pit_s_f === true
    ? finite(fs.add_fuel_l) : null;
  const add = authoritativeAdd != null ? authoritativeAdd
    : current != null && required != null ? Math.max(0, required - current) : null;
  const set = finite(fs.set_fuel_l) != null ? Math.trunc(finite(fs.set_fuel_l))
    : add != null ? Math.ceil(add) : null;
  return { fs, current, required, add, set };
}

function hasAuthoritativeFinishTarget(live) {
  const fs = live && typeof live.fuel_strategy === 'object' ? live.fuel_strategy : {};
  const sessionType = String(live && (live.session_type || live.sessionType) || '').toLowerCase();
  const manualTarget = fs.authoritative_target_kind === 'driver_stint'
    && Number.isInteger(finite(fs.authoritative_target_laps));
  const raceTarget = /race/.test(sessionType)
    && (Number.isInteger(finite(fs.estimated_crossings_to_finish))
      || Number.isInteger(finite(fs.provisional_laps_to_time_expiry)));
  return manualTarget || raceTarget;
}

function buildCurrentFuel(live, lang) {
  const current = finite(live && live.fuel);
  if (current == null) return ja(lang) ? '現在燃料は取得できない。' : 'Current fuel is unavailable.';
  return ja(lang) ? `現在${current.toFixed(1)}L。` : `Current fuel ${current.toFixed(1)}L.`;
}

function buildFuelEmergency(live, lang) {
  const current = finite(live && live.fuel);
  if (current == null) return ja(lang)
    ? '燃料危機は受信したが、現在燃料を確認できない。ピット到達可否は断定しない。'
    : 'Fuel emergency received, but current fuel is unavailable. I will not claim whether the pit is reachable.';
  if (current <= 0.5) return ja(lang)
    ? `燃料${current.toFixed(1)}L。ガス欠域で、ピット到達は保証できない。次のS/F待ちはしない。安全を優先して。`
    : `Fuel ${current.toFixed(1)}L. This is a fuel-starvation range; pit arrival is not guaranteed. I will not wait for the next S/F. Prioritise safety.`;
  return ja(lang)
    ? `燃料${current.toFixed(1)}L。ピット到達は保証できない。今は燃費セーブと安全を優先。`
    : `Fuel ${current.toFixed(1)}L. Pit arrival is not guaranteed. Save fuel now and prioritise safety.`;
}

function buildFuelUse(live, lang) {
  const fs = live && live.fuel_strategy || {};
  const avg = finite(fs.avg_fuel_per_lap), samples = finite(fs.clean_laps_sampled), range = finite(fs.laps_of_fuel_left);
  if (avg == null) return ja(lang) ? '一周あたりの燃料消費はまだ実測できていない。' : 'Measured fuel use per lap is not ready.';
  return ja(lang)
    ? `平均${avg.toFixed(2)}L/周、クリーン${samples == null ? '不明' : Math.trunc(samples)}周の実測。現在燃料で約${range == null ? '不明' : range.toFixed(1)}周。`
    : `${avg.toFixed(2)}L/lap from ${samples == null ? 'unknown' : Math.trunc(samples)} clean laps; about ${range == null ? 'unknown' : range.toFixed(1)} laps in the tank.`;
}

function buildFuelPlan(live, lang, card = {}) {
  const { fs, current, required, add, set } = fuelPlan(live || {});
  if (!hasAuthoritativeFinishTarget(live)) {
    const avg = finite(fs.avg_fuel_per_lap);
    return ja(lang)
      ? `${current != null ? `現在${current.toFixed(1)}L。` : ''}${avg != null ? `平均${avg.toFixed(2)}L/周。` : ''}完走目標が確定していないため、必要燃料・給油量・ピット周は出さない。`
      : `${current != null ? `Current ${current.toFixed(1)}L. ` : ''}${avg != null ? `Average ${avg.toFixed(2)}L/lap. ` : ''}The finish target is not authoritative, so I will not give required fuel, an add amount, or a pit-lap call.`;
  }
  if (card.splashQuestion) {
    const bridgeProjection = live && live.post_stop_fuel_projection || {};
    const bridgeMargin = finite(bridgeProjection.margin_l);
    if (bridgeProjection.available === true && bridgeMargin != null) {
      if (ja(lang)) return bridgeProjection.splash_required === true
        ? `スプラッシュが必要。満タンでも約${Math.abs(bridgeMargin).toFixed(1)}L不足。`
        : `スプラッシュ不要。このピットで満タンなら、ゴール時約${bridgeMargin.toFixed(1)}L余る見込み。`;
      return bridgeProjection.splash_required === true
        ? `Splash required. A full tank still projects ${Math.abs(bridgeMargin).toFixed(1)}L short.`
        : `No splash. A full tank at this stop projects about ${bridgeMargin.toFixed(1)}L at the finish.`;
    }
    const timed = live && live.timed_finish_forecast || {};
    const calibration = live && live.pit_loss_calibration || {};
    const leaderChecker = finite(timed.leader_time_to_checkered_s);
    const driverNextSf = finite(timed.driver_time_to_next_sf_s);
    const driverLap = finite(timed.driver_avg_lap_s);
    const pitLoss = finite(calibration.observed_loss_median_s);
    const burn = finite(fs.avg_fuel_per_lap);
    const capacity = finite(fs.effective_capacity_l);
    const reserve = finite(fs.reserve_l) == null ? 0.5 : finite(fs.reserve_l);
    if (timed.confidence === 'model_valid' && leaderChecker != null
        && driverNextSf != null && driverLap != null && driverLap > 0
        && pitLoss != null && pitLoss >= 0 && burn != null && capacity != null) {
      // The next S/F is the pit-entry crossing.  Fuel added at the stop only
      // has to cover the complete crossings after service.  Pit loss moves
      // the driver later relative to the overall leader's checker clock.
      const postStopCrossings = Math.max(0, Math.floor(
        (leaderChecker - driverNextSf - pitLoss) / driverLap + 1e-9));
      const postStopRequired = postStopCrossings * burn + reserve;
      const margin = capacity - postStopRequired;
      if (ja(lang)) return margin >= 0
        ? `スプラッシュ不要。このピットで満タンなら、ゴール時約${margin.toFixed(1)}L余る見込み。`
        : `スプラッシュが必要。満タンでも約${Math.abs(margin).toFixed(1)}L不足。`;
      return margin >= 0
        ? `No splash. A full tank at this stop projects about ${margin.toFixed(1)}L at the finish.`
        : `Splash required. A full tank still projects ${Math.abs(margin).toFixed(1)}L short.`;
    }
    return ja(lang)
      ? 'スプラッシュの要否は、このピット後の周回予測がまだ成立していない。'
      : 'The post-stop lap projection is not ready, so splash need is not confirmed.';
  }
  const exact = finite(fs.estimated_crossings_to_finish), provisional = finite(fs.provisional_laps_to_time_expiry);
  const oneStopShort=finite(fs.one_stop_shortfall_l);
  const settingJP=oneStopShort!=null&&oneStopShort>0.05
    ? `設定上限${set}Lでも一度では${oneStopShort.toFixed(1)}L不足。追加のセーブか別ピットが必要。`
    : `給油設定${set}L。`;
  const settingEN=oneStopShort!=null&&oneStopShort>0.05
    ? `The ${set}L setting limit still leaves ${oneStopShort.toFixed(1)}L short in one stop; additional saving or another stop is required.`
    : `Set ${set}L.`;
  if (current != null && required != null && add != null) {
    const distance = Number.isInteger(exact)
      ? (ja(lang) ? `チェッカーまでS/Fあと${exact}回。` : `${exact} S/F crossings to the finish. `)
      : Number.isInteger(provisional) ? (ja(lang) ? `暫定あと${provisional}周分。` : `Provisional ${provisional}-lap plan. `) : '';
    if (ja(lang)) {
      if (finite(card.shortageClarificationL) != null) return add > 0
        ? `${finite(card.shortageClarificationL).toFixed(0)}L不足という意味ではない。最新値では現在${current.toFixed(1)}L、ゴールまで${required.toFixed(1)}L必要。燃料は${add.toFixed(1)}L不足。${settingJP}`
        : `${finite(card.shortageClarificationL).toFixed(0)}L不足という意味ではない。最新値では燃料は足りる。現在${current.toFixed(1)}L、ゴールまで${required.toFixed(1)}L必要。`;
      if (add > 0) {
        const action = card.actionRequested && fs.pit_required === true
          ? 'この周でピットを推奨。'
          : '追加給油が必要。';
        return `${action}現在${current.toFixed(1)}L、ゴールまで${required.toFixed(1)}L必要。燃料は${add.toFixed(1)}L不足。${settingJP}`;
      }
      return `燃料は足りる。現在${current.toFixed(1)}L、ゴールまで${required.toFixed(1)}L必要。${distance}`;
    }
    return add > 0
      ? `Current ${current.toFixed(1)}L. ${distance}${required.toFixed(1)}L total required; ${add.toFixed(1)}L short. ${settingEN}`
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
    const clock = formatDuration(remaining, lang);
    if (ja(lang)) return `${clock ? `残り${clock}。` : '残り時間は未取得。'}${crossings != null ? `チェッカーまでS/Fあと${Math.trunc(crossings)}回。` : '残り周回はまだ確定していない。'}`;
    return `${clock ? `${clock} remaining. ` : 'Remaining time unavailable. '}${crossings != null ? `${Math.trunc(crossings)} S/F crossings to the finish.` : 'Remaining laps are not confirmed yet.'}`;
  }
  if (plan.kind === 'laps' && totalLaps != null && lap != null) {
    const left = Math.max(0, Math.trunc(totalLaps - lap));
    return ja(lang) ? `全${Math.trunc(totalLaps)}周、現在${Math.trunc(lap)}周目。残り約${left}周。` : `${Math.trunc(totalLaps)} laps total, lap ${Math.trunc(lap)} now, about ${left} remaining.`;
  }
  return ja(lang) ? 'レース距離の権威データが未確定。周回数は作らない。' : 'Authoritative race distance is unavailable; I will not invent a lap count.';
}

function buildRejoin(live, lang) {
  const outcome = live && live.pit_cycle_outcome;
  if (outcome) {
    const actual = position(outcome.post_cycle_actual_position), predicted = position(outcome.conditional_cycle_position);
    const stopped = Number(outcome.observed_pack_pit_count) || 0;
    const total = Number(outcome.observed_pack_car_count) || 0;
    if (outcome.condition_met === true) {
      return ja(lang) ? `ブレンド実績P${actual || '不明'}。事前予測P${predicted || '不明'}、${actual && predicted ? Math.abs(actual - predicted) + 'ポジション差。' : '誤差は未採点。'}`
        : `Blended result P${actual || 'unknown'}. Forecast P${predicted || 'unknown'}${actual && predicted ? `, ${Math.abs(actual - predicted)} positions off.` : '; error ungraded.'}`;
    }
    if (actual && predicted) {
      const delta = predicted - actual;
      const comparison = delta > 0 ? (ja(lang) ? `予測より${delta}つ上。` : `${delta} position${delta === 1 ? '' : 's'} better than forecast. `)
        : delta < 0 ? (ja(lang) ? `予測より${Math.abs(delta)}つ下。` : `${Math.abs(delta)} position${Math.abs(delta) === 1 ? '' : 's'} worse than forecast. `)
          : (ja(lang) ? '予測通り。' : 'Matched the forecast. ');
      return ja(lang)
        ? `ブレンド実績P${actual}。事前の条件付き予測P${predicted}、${comparison}停止条件は${stopped}/${total}台で未成立。`
        : `Blended result P${actual}. Conditional forecast P${predicted}; ${comparison}The stop condition was not met (${stopped}/${total}).`;
    }
  }
  const status = live && live.pit_cycle_status;
  if (status && status.active) {
    const current = position(live.class_pos), stopped = Number(status.observed_pack_pit_count) || 0;
    const total = Number(status.observed_pack_car_count) || 0, predicted = position(status.conditional_cycle_position);
    return ja(lang)
      ? `現在順位P${current || '不明'}。対象集団停止${stopped}/${total}台で条件はまだ未成立。事前のP${predicted || '不明'}は条件付き予測なので、現順位との一致判定はまだしない。`
      : `Current position P${current || 'unknown'}. The condition is not met: ${stopped}/${total} target cars have stopped. P${predicted || 'unknown'} remains conditional, so I will not grade it against the current position yet.`;
  }
  const f = live && live.pit_exit_forecast;
  const likely = position(f && f.likely && f.likely.position), best = position(f && f.best && f.best.position), worst = position(f && f.worst && f.worst.position);
  if (!(f && f.available && likely && best && worst)) return ja(lang) ? '復帰予測のライブデータが揃っていない。順位は出さない。' : 'Live rejoin data is incomplete; I will not give a position.';
  const cycle = f.pit_cycle && f.pit_cycle.if_pack_stops && f.pit_cycle.if_pack_stops.likely;
  const cyclePos = position(cycle && cycle.position), pack = finite(cycle && cycle.pack_car_count);
  if (ja(lang)) return `今入る物理復帰P${likely}、範囲P${best}〜P${worst}。${cyclePos && pack ? `近傍${Math.trunc(pack)}台が停止すればブレンド後P${cyclePos}。停止意図は未確認。` : '他車の停止意図は未確認。'}`;
  return `Physical exit P${likely}, range P${best}-P${worst}. ${cyclePos && pack ? `If the ${Math.trunc(pack)}-car pack stops, cycle P${cyclePos}; intent unconfirmed.` : 'Rival pit intent is unconfirmed.'}`;
}

function buildStrategySwitch(live, lang, card = {}) {
  const requested=card.requestedPlan==='C'?'C':'B';
  const playbook=live&&live.strategy_playbook;
  if(!playbook||!playbook.available) return ja(lang)
    ? 'ベース戦略がまだ成立していない。アンダーカット／オーバーカットを推測では選ばない。'
    : 'The baseline playbook is not established, so I will not guess an undercut or overcut.';
  const plan=playbook.plans&&playbook.plans[requested];
  if(!plan||plan.available===false) return ja(lang)
    ? `Plan ${requested}は同じ給油回数では成立しない。`
    : `Plan ${requested} is not viable with the same stop count.`;
  const battle=live.battle_context||{};
  const gap=finite(live.gap_ahead??battle.gap_ahead_s);
  const pace=finite(battle.player_pace_advantage_s);
  const now=live.pit_exit_forecast||{}, next=live.pit_next_lap_forecast||{};
  const nowPos=position(now.likely&&now.likely.position), nextPos=position(next.likely&&next.likely.position);
  if(requested==='B'){
    if(gap!=null&&pace!=null&&gap<=1.5&&pace>=0.4&&nowPos!=null
      &&String(now.likely?.traffic_state||'')!=='blend_risk') return ja(lang)
      ? `Plan B、アンダーカットを推奨。前は${gap.toFixed(1)}秒、こちらが${pace.toFixed(1)}秒速く詰まっている。根拠は燃料不足ではなくトラフィック回避。今入る物理復帰P${nowPos}。`
      : `Recommend Plan B, the undercut. The gap is ${gap.toFixed(1)}s and we are ${pace.toFixed(1)}s faster. The reason is traffic avoidance, not a fuel shortfall. Physical rejoin P${nowPos}.`;
    return ja(lang)
      ? `Plan Bの条件を確認中。${gap!=null?`前は${gap.toFixed(1)}秒。`:''}${pace!=null?`相対ペースは${pace>=0?'こちらが'+pace.toFixed(1)+'秒速い':'こちらが'+Math.abs(pace).toFixed(1)+'秒遅い'}。`:'3周の相対ペース待ち。'}物理復帰がクリアになればアンダーカットを出す。`
      : `Plan B conditions are still being checked. ${gap!=null?`Gap ${gap.toFixed(1)}s. `:''}${pace!=null?`Our pace delta is ${pace.toFixed(1)}s. `:'Waiting for a three-lap relative pace sample. '}I will call the undercut only with a clear physical rejoin.`;
  }
  const fs=live.fuel_strategy||{}, avg=finite(fs.avg_fuel_per_lap), fuel=finite(live.fuel);
  const lap=finite(live.lap), target=finite(plan.first_pit_lap);
  const laps=lap!=null&&target!=null?Math.max(1,target-lap):null;
  const fuelSafe=avg!=null&&fuel!=null&&laps!=null&&fuel-avg*laps>=0.5;
  if(gap!=null&&pace!=null&&Math.abs(pace)<=0.3&&fuelSafe&&nowPos!=null&&nextPos!=null&&nextPos<=nowPos) return ja(lang)
    ? `Plan C、オーバーカットを推奨。ペース差は${Math.abs(pace).toFixed(1)}秒で小さい。次周まで燃料成立、復帰予測は今P${nowPos}に対して次周P${nextPos}。`
    : `Recommend Plan C, the overcut. Pace difference is only ${Math.abs(pace).toFixed(1)}s. Fuel supports the next lap, and rejoin improves from P${nowPos} now to P${nextPos} next lap.`;
  return ja(lang)
    ? `Plan Cの条件を確認中。ペース差、次周までの燃料、今と次周の物理復帰をそろえてからオーバーカットを出す。`
    : 'Plan C conditions are still being checked. I need the pace delta, fuel to the next lap, and physical rejoin now versus next lap before calling the overcut.';
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
  if (!hasAuthoritativeFinishTarget(live)) {
    return { action: 'hold', reason: 'finish_target_unavailable', set_fuel_l: null };
  }
  const { fs, add, set } = fuelPlan(live || {});
  const phase = pitPhase(live);
  if (phase === 'finished') return { action: 'hold', reason: 'race_finished', set_fuel_l: 0 };
  if (phase === 'out_lap' && add != null && add <= 0) {
    return { action: 'hold', reason: 'out_lap', set_fuel_l: 0, margin_l: finite(fs.margin_l) };
  }
  const owned = live && live.strategy_plan;
  if (owned && owned.action) {
    if (owned.action === 'box' && add != null && add <= 0) {
      return { action: phase === 'racing' ? 'push' : 'hold', reason: phase === 'racing' ? 'fuel_margin' : phase,
        set_fuel_l: 0, margin_l: finite(fs.margin_l) };
    }
    return owned;
  }
  if (fs.pit_required === true || (add != null && add > 0)) return { action: 'box', reason: 'fuel_shortfall', set_fuel_l: set };
  const margin = finite(fs.margin_l);
  if (margin != null && margin >= 0) return { action: 'push', reason: 'fuel_margin', margin_l: margin };
  return { action: 'hold', reason: 'insufficient_data' };
}

function buildPitDecision(live, lang) {
  const p = derivedAction(live), phase = pitPhase(live), shortage = fuelPlan(live || {}).add;
  if (phase === 'finished') return ja(lang) ? 'レース終了。追加のピット判断は出さない。' : 'Race finished; no further pit decision.';
  if (phase === 'pit_lane') return ja(lang) ? '現在ピットレーン内。今の作業を完了する。' : 'Currently in the pit lane; complete this stop.';
  if (phase === 'out_lap') {
    if (p.action === 'box') return ja(lang)
      ? `給油不足が${finite(shortage) == null ? '残っている' : finite(shortage).toFixed(1) + 'L残っている'}。ペースは上げず、次の周で再ピット。`
      : `Fuel shortfall remains. Do not push; box again next lap.`;
    return ja(lang) ? 'ピット完了。アウトラップはタイヤを作ってペースキープ。' : 'Stop complete. Build the tyres and hold pace on the out-lap.';
  }
  if (p.action === 'box') {
    const f = live && live.pit_exit_forecast || {};
    const cycle = f.pit_cycle && f.pit_cycle.if_pack_stops && f.pit_cycle.if_pack_stops.likely;
    const cyclePos = position(cycle && cycle.position), current = position(live && live.class_pos);
    const strong = cyclePos && current && cyclePos < current;
    if (ja(lang)) return `${strong ? 'この周でピットを強く推奨' : 'ピットを推奨'}。燃料不足が根拠。${finite(p.set_fuel_l) == null ? '給油量は未確定' : '給油設定は' + Math.trunc(p.set_fuel_l) + 'L'}。${cyclePos ? `条件成立ならブレンド後P${cyclePos}見込み。` : ''}`;
    return `${strong ? 'Strong recommendation: box this lap' : 'Recommendation: box'}. Fuel shortfall is the reason. ${finite(p.set_fuel_l) == null ? 'Fuel amount unconfirmed' : `Set ${Math.trunc(p.set_fuel_l)}L`}.${cyclePos ? ` P${cyclePos} blended if the condition is met.` : ''}`;
  }
  if (p.action === 'push') return ja(lang) ? `判断はステイアウトしてプッシュ。燃料余裕${finite(p.margin_l) == null ? '確認済み' : finite(p.margin_l).toFixed(1) + 'L'}。` : `Decision: stay out and push; fuel margin ${finite(p.margin_l) == null ? 'confirmed' : finite(p.margin_l).toFixed(1) + 'L'}.`;
  return ja(lang) ? '判断はホールド。確定データが足りないのでボックス指示は出さない。' : 'Decision: hold. Data is insufficient, so I will not call a stop.';
}

function buildPlanStatus(live, lang, card = {}) {
  const p = derivedAction(live), prefix = '';
  const playbook=live&&live.strategy_playbook;
  if(playbook&&playbook.available){
    const chosen=card.planChoice||playbook.selected_plan||'A';
    const plan=playbook.plans&&playbook.plans[chosen];
    if(card.planChoice&&plan){
      const label={A:'ベースライン',B:'アンダーカット',C:'オーバーカット'}[chosen];
      const stops=Array.isArray(plan.pit_laps)&&plan.pit_laps.length?plan.pit_laps.join('・'):'なし';
      const condition=chosen==='B'?'前で詰まり、こちらの相対ペースが速く、物理復帰がクリアなら切り替える。'
        :chosen==='C'?`ペース差が小さく、次周の復帰が悪化せず、燃費${Number(plan.required_fuel_saving_pct||0).toFixed(1)}%改善が成立すれば切り替える。`
          :'現在の基準案。';
      return ja(lang)?`Plan ${chosen}は${label}。ピット予定${stops}周。${condition}`
        :`Plan ${chosen} is the ${chosen==='A'?'baseline':chosen==='B'?'undercut':'overcut'}. Planned stops: laps ${stops}.`;
    }
    const a=playbook.plans.A||{}, b=playbook.plans.B||{}, c=playbook.plans.C||{};
    return ja(lang)
      ? `現在はPlan ${playbook.selected_plan||'A'}。Plan Aはベースライン${(a.pit_laps||[]).join('・')}周、Plan Bはアンダーカット${b.first_pit_lap||'不明'}周、Plan Cはオーバーカット${c.first_pit_lap||'不明'}周。`
      : `Current selection is Plan ${playbook.selected_plan||'A'}. Plan A is the baseline, Plan B the undercut, and Plan C the overcut.`;
  }
  const options=live&&live.strategy_options;
  if(card.planChoice&&options&&options.available){
    const plan=options['plan_'+card.planChoice.toLowerCase()]||{};
    if(!plan.available) return ja(lang)?`プラン${card.planChoice}は現在成立していない。`:`Plan ${card.planChoice} is not currently viable.`;
    const when=Number(plan.target_in_laps)===0?(ja(lang)?'この周':'this lap'):(ja(lang)?`あと${Math.trunc(plan.target_in_laps)}周走って`:`in ${Math.trunc(plan.target_in_laps)} laps`);
    return ja(lang)
      ? `${card.planChoice==='B'?'1周延長案':'燃料タイミング基準案'}は${when}ピット、給油設定${Math.trunc(plan.set_fuel_l)}L。${card.planChoice==='B'?'燃料予測と復帰トラフィックを再確認して切り替える。':'現在の燃料基準案。'}`
      : `${card.planChoice==='B'?'One-lap fuel extension':'Fuel timing baseline'}: pit ${when}, set ${Math.trunc(plan.set_fuel_l)}L.`;
  }
  if (p.action === 'box') return prefix + (ja(lang) ? `燃料不足でボックス。給油${finite(p.set_fuel_l) == null ? '未確定' : Math.trunc(p.set_fuel_l) + 'L'}。` : `Box for fuel; set ${finite(p.set_fuel_l) == null ? 'unconfirmed' : Math.trunc(p.set_fuel_l) + 'L'}.`);
  if (p.action === 'push') return prefix + (ja(lang) ? 'ステイアウトしてプッシュ。燃料余裕あり。' : 'Stay out and push; fuel margin is positive.');
  const current = position(live && live.class_pos), remaining = finite(live && live.session_time_remaining_s);
  const fs = live && live.fuel_strategy || {};
  const samples = finite(fs.clean_laps_sampled), avg = finite(fs.avg_fuel_per_lap);
  if (ja(lang)) {
    const facts = `${current != null ? `現在P${current}。` : ''}${remaining != null ? `残り${formatDuration(remaining, lang)}。` : ''}`;
    if (avg != null && samples != null && samples < 3) return prefix + `${facts}燃費はクリーン${Math.trunc(samples)}周の実測。あと${Math.max(0, 3 - Math.trunc(samples))}周で燃料判断を更新する。今はピット判断を固定しない。`;
    if (avg == null) return prefix + `${facts}燃費のクリーン実測がまだない。3周そろうまでピット判断は固定しない。`;
    return prefix + `${facts}燃料の完走根拠がまだ不足。今はピット判断を固定しない。`;
  }
  return prefix + 'Fuel-finish evidence is not ready; I will not lock a pit call yet.';
}

function buildPace(live, lang) {
  const { fs, current, required, add } = fuelPlan(live || {});
  const computedMargin = current != null && required != null ? current - required : null;
  const margin = computedMargin != null ? computedMargin : finite(fs.margin_l);
  const phase = pitPhase(live);
  if (phase === 'finished') return ja(lang) ? 'レース終了。ペース指示は終了。' : 'Race finished; pace calls are complete.';
  if (phase === 'pit_lane') return ja(lang) ? '現在ピットレーン内。作業完了を優先。' : 'Currently in the pit lane; complete the stop.';
  if (phase === 'out_lap') return ja(lang)
    ? (add != null && add > 0
      ? `給油不足が${add.toFixed(1)}L残っている。ペースは上げず、次の周で再ピット。`
      : `ピット完了。${margin != null && margin >= 0 ? `ゴール時約${margin.toFixed(1)}L余る見込み。` : ''}タイヤを作って、アウトラップはペースキープ。`)
    : (add != null && add > 0
      ? `Fuel shortfall ${add.toFixed(1)}L. Do not push; box again next lap.`
      : `Stop complete. ${margin != null && margin >= 0 ? `Projected finish margin ${margin.toFixed(1)}L. ` : ''}Build the tyres and hold pace.`);
  if (fs.pit_required === true || (add != null && add > 0)) return ja(lang) ? `今はペースアップよりピット優先。現在${current != null ? current.toFixed(1) : '不明'}L、必要総量${required != null ? required.toFixed(1) : '未確定'}L。` : `Prioritise the stop, not a pace increase. Current ${current != null ? current.toFixed(1) : 'unknown'}L; ${required != null ? required.toFixed(1) + 'L required' : 'requirement unconfirmed'}.`;
  if (margin != null && margin >= 0) return ja(lang) ? `燃料は${margin.toFixed(1)}L余裕。ペースを上げていい。` : `${margin.toFixed(1)}L fuel margin. You can push.`;
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

function buildTyreStatus(live, lang, card = {}) {
  const tires = live && live.tires || {}, names = { lf:'左前', rf:'右前', lr:'左後', rr:'右後' };
  const measurement = live && live.tire_measurement || {};
  const query = card.tyreQuery || 'status';
  if (measurement.available !== true) {
    if (query === 'temperature') return ja(lang)
      ? '走行中のタイヤ温度はエンジニア側では取得できない。車種によってダッシュ表示があれば値を教えて。表示がなければ挙動と路面温度で判断する。'
      : 'Live tyre temperature is unavailable to the engineer. If this car shows it on the dash, read me the value; otherwise we work from handling and track temperature.';
    if (query === 'wear') return ja(lang)
      ? '走行中のタイヤ摩耗は取得できない。ピット帰還後の計測値で確認する。'
      : 'Live tyre wear is unavailable. I can confirm the measured value after the car returns to the pit.';
    return ja(lang)
      ? '走行中のタイヤ温度・摩耗は取得できない。温度は車両ダッシュ、摩耗はピット帰還後に確認する。'
      : 'Live tyre temperature and wear are unavailable. Read temperature from the car dashboard and confirm wear after returning to the pit.';
  }
  const rows = Object.keys(names).map(k => {
    const tire = tires[k] || {}, wear = Array.isArray(tire.w) ? tire.w.map(finite).filter(v => v != null) : [];
    const temp = Array.isArray(tire.t) ? tire.t.map(finite).filter(v => v != null) : [];
    return { k, wear: wear.length ? Math.min(...wear) : null, temp: temp.length ? temp.reduce((a,b)=>a+b,0)/temp.length : null };
  });
  if (!rows.some(r => r.wear != null || r.temp != null)) return ja(lang) ? '走行中に信頼できるタイヤ摩耗・温度は取得できない。' : 'Reliable tyre wear and temperature are unavailable while running.';
  const parts = rows.filter(r => query === 'temperature' ? r.temp != null : query === 'wear' ? r.wear != null : (r.wear != null || r.temp != null)).map(r => ja(lang)
    ? `${names[r.k]}${query === 'temperature' ? ` ${r.temp.toFixed(1)}℃` : query === 'wear' ? ` 残${r.wear.toFixed(1)}%` : ` 残${r.wear == null ? '不明' : r.wear.toFixed(1) + '%'}${r.temp == null ? '' : ` ${r.temp.toFixed(1)}℃`}`}`
    : `${r.k.toUpperCase()}${query === 'temperature' ? ` ${r.temp.toFixed(1)}C` : query === 'wear' ? ` ${r.wear.toFixed(1)}% remaining` : ` ${r.wear == null ? 'wear unknown' : r.wear.toFixed(1) + '% remaining'}${r.temp == null ? '' : ` ${r.temp.toFixed(1)}C`}`}`);
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
  const a = finite(live && live.gap_ahead), b = finite(live && live.gap_behind);
  if (a == null && b == null) return ja(lang) ? '現在の前後GAPは取得できない。' : 'Current verified gaps are unavailable.';
  return ja(lang) ? `現在の直前車まで${a == null ? '不明' : a.toFixed(1) + '秒'}、直後車まで${b == null ? '不明' : b.toFixed(1) + '秒'}。` : `Current gaps: ${a == null ? 'unknown' : a.toFixed(1) + 's'} to the car ahead, ${b == null ? 'unknown' : b.toFixed(1) + 's'} to the car behind.`;
}

function buildUnresolved(lang) {
  return ja(lang) ? '今は確定のコールを出さない。次のS/F通過で燃料、残り、前後GAPを更新する。' : 'No confirmed call yet. I will update fuel, remaining distance and gaps at the next S/F crossing.';
}

function buildSessionFormat(live, lang) {
  const plan = live && live.race_plan || {};
  const type = String(live && live.session_type || '').trim();
  const remaining = finite(live && live.session_time_remaining_s);
  const configuredDuration = finite(plan.configured_duration_s);
  const totalLaps = finite(live && live.laps_total);
  if (plan.kind === 'timed') return ja(lang)
    ? `${type || 'レース'}、${configuredDuration != null ? `${Math.round(configuredDuration / 60)}分の` : ''}時間制。${remaining != null ? `残り${formatDuration(remaining, lang)}。` : '残り時間は未取得。'}`
    : `${type || 'Race'}, ${configuredDuration != null ? `${Math.round(configuredDuration / 60)}-minute ` : ''}timed.${remaining != null ? ` ${formatDuration(remaining, lang)} remaining.` : ' Remaining time unavailable.'}`;
  if (plan.kind === 'laps' && totalLaps != null) return ja(lang)
    ? `${type || 'レース'}、${Math.trunc(totalLaps)}周制。` : `${type || 'Race'}, ${Math.trunc(totalLaps)} laps.`;
  return ja(lang) ? `${type || '現在のセッション'}の形式は、確定データを受信中。次の更新で伝える。` : `Session format data is still being confirmed; I will update on the next snapshot.`;
}

function build(card, live, lang = 'en') {
  if (!card) return null;
  const handlers = {
    [TOPIC.CURRENT_FUEL]: buildCurrentFuel, [TOPIC.FUEL_EMERGENCY]: buildFuelEmergency, [TOPIC.FUEL_PLAN]: buildFuelPlan,
    [TOPIC.FUEL_USE]: buildFuelUse, [TOPIC.RACE_DISTANCE]: buildRaceDistance,
    [TOPIC.REJOIN]: buildRejoin, [TOPIC.PIT_LOSS]: buildPitLoss,
    [TOPIC.PIT_DECISION]: buildPitDecision, [TOPIC.STRATEGY_SWITCH]: buildStrategySwitch,
    [TOPIC.PIT_SERVICE]: buildPitService,
    [TOPIC.PACE]: buildPace, [TOPIC.CURRENT_POSITION]: buildCurrentPosition,
    [TOPIC.LEADER_GAP]: buildLeaderGap, [TOPIC.TYRE_STATUS]: buildTyreStatus,
    [TOPIC.DAMAGE_STATUS]: buildDamageStatus, [TOPIC.WEATHER_STATUS]: buildWeatherStatus,
    [TOPIC.TRAFFIC_STATUS]: buildTrafficStatus, [TOPIC.PLAN_STATUS]: buildPlanStatus,
    [TOPIC.SESSION_FORMAT]: buildSessionFormat,
  };
  if (card.topic === TOPIC.ACKNOWLEDGEMENT) return ja(lang) ? '了解。' : 'Copy.';
  if (card.topic === TOPIC.FUEL_PLAN) return buildFuelPlan(live || {}, lang, card);
  if (card.topic === TOPIC.POSITION_GAP) return buildPositionGap(live || {}, card.targetPosition, lang);
  if (card.topic === TOPIC.UNRESOLVED_OPERATIONAL) return buildUnresolved(lang);
  const handler = handlers[card.topic];
  return handler ? handler(live || {}, lang, card) : null;
}

function route(text, live, lang = 'en', options = {}) {
  const card = classify(text, options);
  if (!card) return null;
  const reply = build(card, live || {}, lang);
  return { card, reply, status: card.topic === TOPIC.UNRESOLVED_OPERATIONAL ? 'deferred' : 'fired' };
}

module.exports = { TOPIC, classify, build, route, fuelPlan, hasAuthoritativeFinishTarget, formatDuration, pitPhase, OPERATIONAL_RE };
