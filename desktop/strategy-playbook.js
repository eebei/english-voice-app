(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallStrategyPlaybook = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RESERVE_L = 0.5;

  const finite = value => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  function durationSeconds(value) {
    if (finite(value) != null) return finite(value);
    const text = String(value || '').trim();
    let match = text.match(/^(\d+(?:\.\d+)?)\s*(?:sec|seconds?|s)$/i);
    if (match) return Number(match[1]);
    match = text.match(/^(\d+(?:\.\d+)?)\s*(?:min|minutes?|m)$/i);
    if (match) return Number(match[1]) * 60;
    match = text.match(/^(\d+(?:\.\d+)?)\s*(?:hr|hours?|h)$/i);
    if (match) return Number(match[1]) * 3600;
    match = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/);
    if (!match) return null;
    const hours = Number(match[1] || 0), minutes = Number(match[2]), seconds = Number(match[3]);
    return minutes < 60 && seconds < 60 ? hours * 3600 + minutes * 60 + seconds : null;
  }

  function normalizeFormat(input) {
    const detail = input && typeof input.raceDetail === 'object' ? input.raceDetail : {};
    const laps = finite(input && input.totalLaps) ?? finite(detail.session_laps);
    if (Number.isInteger(laps) && laps > 0) return { kind: 'laps', total_laps: laps, duration_s: null };
    const seconds = durationSeconds(input && input.durationS) ?? durationSeconds(detail.session_time);
    if (seconds != null && seconds > 0) return { kind: 'timed', total_laps: null, duration_s: seconds };
    return { kind: 'unknown', total_laps: null, duration_s: null };
  }

  function schedule(totalLaps, stintLaps, firstPitLap) {
    if (!(totalLaps > 0) || !(stintLaps > 0) || !(firstPitLap > 0) || firstPitLap >= totalLaps) return [];
    const stops = [Math.trunc(firstPitLap)];
    while (stops[stops.length - 1] + stintLaps < totalLaps) stops.push(stops[stops.length - 1] + stintLaps);
    return stops;
  }

  function firstService(planStops, totalLaps, burn, capacity, firstStintBurn) {
    if (!planStops.length) return { estimated_add_l: 0, target_onboard_l: 0, entry_fuel_l: null };
    const first = planStops[0];
    const next = planStops[1] || totalLaps;
    const nextLength = Math.max(1, next - first);
    const entry = Math.max(0, capacity - firstStintBurn * first);
    const target = Math.min(capacity, burn * nextLength + RESERVE_L);
    return {
      estimated_add_l: Math.round(Math.max(0, Math.min(capacity - entry, target - entry)) * 10) / 10,
      target_onboard_l: Math.round(target * 10) / 10,
      entry_fuel_l: Math.round(entry * 10) / 10,
    };
  }

  function unavailable(reason, evidence) {
    return { available: false, reason, evidence: evidence || {}, selected_plan: null, plans: {} };
  }

  function buildPlaybook(input = {}) {
    const format = normalizeFormat(input);
    const burn = finite(input.historicalFuelPerLapL);
    const samples = Math.max(0, Math.trunc(finite(input.historicalFuelSamples) || 0));
    const averageLap = finite(input.historicalAverageLapS);
    const capacity = finite(input.effectiveCapacityL);
    const pitLane = finite(input.pitLaneS);
    const memoryEvidence = input.memoryEvidence && typeof input.memoryEvidence === 'object'
      ? input.memoryEvidence : {};
    const selfMemory = input.selfMemory && typeof input.selfMemory === 'object'
      ? input.selfMemory : {};
    const selfTags = Array.isArray(selfMemory.tags)
      ? selfMemory.tags.filter(tag => typeof tag === 'string').slice(0, 6) : [];
    if (format.kind === 'unknown') return unavailable('race_format_unavailable', { format });
    if (!(burn > 0)) return unavailable('historical_fuel_unavailable', { format });
    if (!(capacity > burn + RESERVE_L)) return unavailable('effective_capacity_unavailable', { format, burn });

    let totalLaps = format.total_laps;
    if (format.kind === 'timed') {
      if (!(averageLap > 20 && averageLap < 900)) return unavailable('historical_average_lap_unavailable', { format, burn, samples });
      totalLaps = Math.ceil(format.duration_s / averageLap) + 1;
    }
    if (!(totalLaps > 0)) return unavailable('race_laps_unavailable', { format });

    const safeStintLaps = Math.max(1, Math.floor((capacity - RESERVE_L) / burn));
    const baselineStops = schedule(totalLaps, safeStintLaps, safeStintLaps);
    const undercutFirst = Math.max(1, safeStintLaps - 1);
    const undercutStops = schedule(totalLaps, safeStintLaps, undercutFirst);
    const overcutFirst = safeStintLaps + 1;
    const overcutTargetBurn = (capacity - RESERVE_L) / overcutFirst;
    const overcutSavingPct = Math.max(0, (burn - overcutTargetBurn) / burn * 100);
    const overcutStops = schedule(totalLaps, safeStintLaps, overcutFirst);
    const qualifier = finite(input.qualifyingPosition);
    const classEntries = finite(input.classEntryCount);
    const baselineService = firstService(baselineStops, totalLaps, burn, capacity, burn);
    const undercutService = firstService(undercutStops, totalLaps, burn, capacity, burn);
    const overcutService = firstService(overcutStops, totalLaps, burn, capacity, overcutTargetBurn);

    const planA = {
      id: 'A', kind: 'baseline', available: true,
      first_pit_lap: baselineStops[0] || null, pit_laps: baselineStops,
      stop_count: baselineStops.length, first_service: baselineService,
      conditions: ['standard_pace', 'no_verified_traffic_gain'],
    };
    const planB = {
      id: 'B', kind: 'undercut', available: undercutStops.length <= baselineStops.length,
      reason: undercutStops.length <= baselineStops.length ? 'same_stop_count' : 'adds_extra_stop',
      first_pit_lap: undercutStops[0] || null, pit_laps: undercutStops,
      stop_count: undercutStops.length, first_service: undercutService,
      conditions: ['blocked_by_slower_same_class_car', 'verified_clean_pace_advantage', 'clear_rejoin']
        .concat(selfTags.includes('gap_accuracy') ? ['latest_gap_same_frame_required'] : []),
    };
    const planC = {
      id: 'C', kind: 'overcut', available: overcutFirst < totalLaps,
      reason: overcutSavingPct > 0 ? 'fuel_save_required' : 'normal_extension',
      first_pit_lap: overcutFirst < totalLaps ? overcutFirst : null,
      pit_laps: overcutStops, stop_count: overcutStops.length,
      first_service: overcutService,
      required_first_stint_burn_l_per_lap: Math.round(overcutTargetBurn * 1000) / 1000,
      required_fuel_saving_pct: Math.round(overcutSavingPct * 10) / 10,
      conditions: ['pace_difference_small', 'fuel_target_achieved', 'next_lap_rejoin_not_worse']
        .concat(selfTags.includes('gap_accuracy') ? ['latest_gap_same_frame_required'] : [])
        .concat(selfTags.includes('fuel_window_proactive') ? ['fuel_window_authority_required'] : []),
    };

    let endurance = null;
    if (format.kind === 'timed' && format.duration_s >= 90 * 60 && baselineStops.length >= 2) {
      const reducedStops = baselineStops.length - 1;
      const tanksAvailable = reducedStops + 1;
      const targetBurn = (capacity * tanksAvailable - RESERVE_L) / totalLaps;
      const saving = Math.max(0, (burn - targetBurn) / burn * 100);
      endurance = {
        standard_stop_count: baselineStops.length,
        no_splash_stop_count: reducedStops,
        no_splash_target_burn_l_per_lap: Math.round(targetBurn * 1000) / 1000,
        no_splash_required_saving_pct: Math.round(saving * 10) / 10,
        tyre_plan_status: 'practice_validation_required',
        tyre_plan: 'combine_tyre_service_with_a_main_fuel_stop',
      };
    }

    const backHalf = qualifier != null && classEntries != null && classEntries > 0 && qualifier > classEntries / 2;
    // GT Sprint / IMSA Fixed の短時間・一給油レースでは、1周違いの三択を
    // 並べるより「通常運用」と「集団を抜ける早めのアンダーカット」を
    // 主軸にする。C は耐久／明確なセーブ根拠がある場合だけ補助候補。
    const sprintLike = format.kind === 'timed' && format.duration_s <= 45 * 60;
    const midfieldUndercut = sprintLike && backHalf;
    return {
      available: true,
      reason: 'historical_reference_playbook',
      source: 'historical_reference',
      provisional: true,
      selected_plan: 'A',
      opening_priority: backHalf ? ['B', 'A', 'C'] : ['A', 'B', 'C'],
      strategy_mode: midfieldUndercut ? 'sprint_midfield_undercut' : (sprintLike ? 'sprint' : 'endurance'),
      primary_plan_ids: midfieldUndercut ? ['B', 'A'] : ['A', 'B'],
      strategy_doctrine: midfieldUndercut
        ? 'start_midfield_pack_early_undercut: pit_when_fuel_window_opens_if_clean_pace_and_clear_rejoin_are_verified'
        : 'baseline_first_undercut_only_when_live_evidence_supports_it',
      outcome_capture_contract: [
        'pre_pit_class_position', 'pit_entry_lap', 'fuel_added_l', 'pit_lane_loss_s',
        'immediate_exit_class_position', 'post_cycle_class_position', 'final_class_position',
        'forward_pack_size', 'rejoin_traffic_state', 'rival_pit_timestamps'
      ],
      format: { ...format, estimated_race_laps: totalLaps },
      evidence: {
        track: input.track || '', car: input.car || '',
        historical_fuel_l_per_lap: Math.round(burn * 1000) / 1000,
        historical_fuel_samples: samples,
        historical_average_lap_s: averageLap,
        effective_capacity_l: Math.round(capacity * 1000) / 1000,
        starting_fuel_assumption_l: Math.round(capacity * 1000) / 1000,
        pit_lane_s: pitLane,
        qualifying_position: qualifier,
        class_entry_count: classEntries,
        memory_source: memoryEvidence.source || 'none',
        memory_record_count: Math.max(0, Math.trunc(finite(memoryEvidence.recordCount) || 0)),
        historical_session_count: Math.max(0, Math.trunc(finite(memoryEvidence.sessionCount) || 0)),
        memory_matched_keys: Array.isArray(memoryEvidence.matchedKeys)
          ? memoryEvidence.matchedKeys.slice(0, 12) : [],
        canonical_track: memoryEvidence.canonicalTrack || '',
        canonical_car: memoryEvidence.canonicalCar || '',
        luna_self_memory_tags: selfTags,
        luna_self_memory_id: selfMemory.memoryId || null,
      },
      safe_stint_laps: safeStintLaps,
      plans: { A: planA, B: planB, C: planC },
      endurance,
      update_contract: 'replace_historical_fuel_after_three_live_clean_laps',
    };
  }

  function updateWithLive(playbook, live = {}) {
    const fuel = live.fuel_strategy || {};
    const samples = Math.trunc(finite(fuel.clean_laps_sampled) || 0);
    const burn = finite(fuel.avg_fuel_per_lap);
    if (!playbook || !playbook.available || samples < 3 || !(burn > 0)) return playbook;
    if (playbook.source === 'live_clean_laps'
        && playbook.evidence && playbook.evidence.live_fuel_samples === samples
        && playbook.evidence.live_fuel_l_per_lap === burn) return playbook;
    const rebuilt = buildPlaybook({
      track: playbook.evidence.track, car: playbook.evidence.car,
      durationS: playbook.format.duration_s, totalLaps: playbook.format.total_laps,
      historicalFuelPerLapL: burn, historicalFuelSamples: samples,
      historicalAverageLapS: playbook.evidence.historical_average_lap_s,
      effectiveCapacityL: playbook.evidence.effective_capacity_l,
      pitLaneS: playbook.evidence.pit_lane_s,
      qualifyingPosition: playbook.evidence.qualifying_position,
      classEntryCount: playbook.evidence.class_entry_count,
      memoryEvidence: {
        source: playbook.evidence.memory_source,
        recordCount: playbook.evidence.memory_record_count,
        sessionCount: playbook.evidence.historical_session_count,
        matchedKeys: playbook.evidence.memory_matched_keys,
        canonicalTrack: playbook.evidence.canonical_track,
        canonicalCar: playbook.evidence.canonical_car,
      },
      selfMemory: {
        tags: playbook.evidence.luna_self_memory_tags || [],
        memoryId: playbook.evidence.luna_self_memory_id || null,
      },
    });
    if (!rebuilt.available) return playbook;
    rebuilt.source = 'live_clean_laps';
    rebuilt.provisional = false;
    rebuilt.evidence.live_fuel_l_per_lap = burn;
    rebuilt.evidence.live_fuel_samples = samples;
    rebuilt.revision_reason = 'three_live_clean_laps';
    return rebuilt;
  }

  function physicalPosition(forecast, family) {
    const value = forecast && forecast.available && forecast[family || 'likely']
      ? finite(forecast[family || 'likely'].position) : null;
    return value != null && value >= 1 ? Math.trunc(value) : null;
  }

  function sameFrameGapProof(live) {
    const battle = live && live.battle_context && typeof live.battle_context === 'object'
      ? live.battle_context : {};
    const now = live && live.pit_exit_forecast && typeof live.pit_exit_forecast === 'object'
      ? live.pit_exit_forecast : {};
    const next = live && live.pit_next_lap_forecast && typeof live.pit_next_lap_forecast === 'object'
      ? live.pit_next_lap_forecast : {};
    const id = typeof battle.snapshot_id === 'string' ? battle.snapshot_id : '';
    const topGap = finite(live && live.gap_ahead);
    const battleGap = finite(battle.gap_ahead_s);
    return !!id && now.snapshot_id === id && next.snapshot_id === id
      && topGap != null && battleGap != null && Math.abs(topGap - battleGap) < 0.011;
  }

  function evaluateSwitch(playbook, live = {}) {
    if (!playbook || !playbook.available || !/race/i.test(String(live.session_type || ''))
        || live.on_track !== true || live.on_pit_road === true) return null;
    // 履歴プレイブックは「候補を作る」だけで、レース中のPlan B/C決定権は持たない。
    // 完走周回とFuel Windowを同一frameで確定した bridge の strategy_options が無い限り、
    // 数字付きのアンダー／オーバー候補を自発発話しない。
    const authority = live.strategy_options;
    const crossings = finite(live.fuel_strategy && live.fuel_strategy.estimated_crossings_to_finish);
    if (!authority || authority.available !== true || !Number.isInteger(crossings)) return null;
    const lap = Math.trunc(finite(live.lap) || 0);
    const gap = finite(live.gap_ahead);
    const paceAdvantage = finite(live.battle_context && live.battle_context.player_pace_advantage_s);
    const baseline = playbook.plans.A, undercut = playbook.plans.B, overcut = playbook.plans.C;
    if (!(lap > 0) || gap == null || paceAdvantage == null) return null;
    const selfTags = Array.isArray(playbook.evidence && playbook.evidence.luna_self_memory_tags)
      ? playbook.evidence.luna_self_memory_tags : [];
    const gapProofRequired = selfTags.includes('gap_accuracy');
    if (gapProofRequired && !sameFrameGapProof(live)) return null;

    const now = live.pit_exit_forecast || {};
    const next = live.pit_next_lap_forecast || {};
    const nowLikely = physicalPosition(now, 'likely');
    const nextLikely = physicalPosition(next, 'likely');
    const nowClear = nowLikely != null && now.likely && now.likely.traffic_state !== 'blend_risk';
    const authorityB = authority.plan_b || {};
    if (authority.selected_plan === 'B' && authorityB.fuel_window_open === true
        && undercut.available && lap >= Math.max(1, undercut.first_pit_lap - 1)
        && lap <= baseline.first_pit_lap && gap <= 1.5 && paceAdvantage >= 0.4 && nowClear) {
      return {
        decision_id: `playbook:${live.session_num ?? 'x'}:${lap}:B`, selected_plan: 'B',
        reason: 'blocked_with_verified_pace_advantage_and_clear_rejoin',
        evidence: { lap, gap_ahead_s: gap, player_pace_advantage_s: paceAdvantage, physical_rejoin_position: nowLikely,
          self_memory_guards: gapProofRequired ? ['latest_gap_same_frame_verified'] : [] },
      };
    }

    const avg = finite(live.fuel_strategy && live.fuel_strategy.avg_fuel_per_lap);
    const currentFuel = finite(live.fuel);
    const lapsToTarget = overcut.first_pit_lap != null ? Math.max(1, overcut.first_pit_lap - lap) : null;
    const fuelSafe = avg != null && currentFuel != null && lapsToTarget != null
      && currentFuel - avg * lapsToTarget >= RESERVE_L;
    if (authority.selected_plan === 'C' && overcut.available && lap >= Math.max(1, baseline.first_pit_lap - 1)
        && lap <= baseline.first_pit_lap && gap <= 1.5 && Math.abs(paceAdvantage) <= 0.3
        && fuelSafe && nowLikely != null && nextLikely != null && nextLikely <= nowLikely) {
      return {
        decision_id: `playbook:${live.session_num ?? 'x'}:${lap}:C`, selected_plan: 'C',
        reason: 'similar_pace_fuel_safe_and_next_lap_rejoin_not_worse',
        evidence: { lap, gap_ahead_s: gap, player_pace_advantage_s: paceAdvantage,
          pit_now_position: nowLikely, pit_next_lap_position: nextLikely,
          self_memory_guards: gapProofRequired ? ['latest_gap_same_frame_verified'] : [] },
      };
    }
    return null;
  }

  function formatLapList(plan) {
    return plan && plan.pit_laps && plan.pit_laps.length ? plan.pit_laps.join('・') : 'ノーストップ';
  }

  function briefing(playbook, lang = 'ja') {
    if (!playbook || !playbook.available) return lang === 'ja'
      ? '過去実測から事前戦略を作るためのデータがまだ揃っていない。'
      : 'Historical evidence is not sufficient for a pre-race strategy yet.';
    const a = playbook.plans.A, b = playbook.plans.B, c = playbook.plans.C;
    const live = playbook.source === 'live_clean_laps';
    const qualifier = finite(playbook.evidence && playbook.evidence.qualifying_position);
    const undercutFirst = Array.isArray(playbook.opening_priority)
      && playbook.opening_priority[0] === 'B';
    if (lang !== 'ja') {
      return `${live ? 'Live measured plan.' : 'Provisional historical plan.'} Start-fuel assumption: ${playbook.evidence.starting_fuel_assumption_l.toFixed(1)} litres. Baseline stops: laps ${formatLapList(a)}. `
        + `Undercut: first stop lap ${b.first_pit_lap}. Overcut: lap ${c.first_pit_lap}, `
        + `${c.required_fuel_saving_pct.toFixed(1)}% fuel saving required.`
        + (qualifier != null
          ? ` Qualified P${Math.trunc(qualifier)}; ${undercutFirst ? 'review the undercut first.' : 'keep the baseline as the opening priority.'}`
          : ' Qualifying position is not confirmed yet; keep the baseline provisional.')
        + (live ? '' : ' I will update after three clean laps.');
    }
    const rememberedSessions = Math.max(0, Math.trunc(finite(playbook.evidence && playbook.evidence.historical_session_count) || 0));
    // The number spoken here is the session count, not the record count:
    // `historical_session_count` and `memory_record_count` are different
    // facts and "件" read as the latter.
    // Grid radio is deliberately one sentence.  Detailed B/C conditions are
    // retained in the playbook and are announced only after live clean-lap
    // evidence exists; front-loading them created a 38-second queue at RBR.
    return live
      ? `実測${playbook.evidence.live_fuel_l_per_lap.toFixed(2)}L/周でPlan Aを更新。`
      : `${rememberedSessions ? `履歴${rememberedSessions}セッション。` : ''}Plan Aで開始、クリーン3周で更新。`;
  }

  return { durationSeconds, normalizeFormat, buildPlaybook, updateWithLive, evaluateSwitch, briefing };
}));
