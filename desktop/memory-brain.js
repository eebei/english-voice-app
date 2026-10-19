(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallMemoryBrain = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const finite = value => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const norm = value => String(value == null ? '' : value).trim().toLowerCase();
  const safe = (value, max = 240) => String(value == null ? '' : value).trim().slice(0, max);
  const idValue = value => value === null || value === undefined || value === '' ? null : String(value);

  // WO017：記憶の持ち主（認証本人）。旧recordはuserIdからだけ導出し、無ければ不明。
  function ownerOf(record) {
    if (record.owner_ref) return String(record.owner_ref);
    const u = idValue(record.userId);
    return u ? 'user:' + u : null;
  }
  const trackOf = r => r.track ?? (r.scope && r.scope.track);
  const carOf = r => r.car || r.carClass || (r.scope && (r.scope.car || r.scope.car_class));

  function identityMatches(record, identity) {
    if (!record || record.disputed === true || record.deleted === true || !identity) return false;
    // 本人を渡された時（製品経路）は、本人不明・別本人の記録を使わない。
    if (Object.prototype.hasOwnProperty.call(identity, 'ownerRef')) {
      if (!identity.ownerRef || ownerOf(record) !== String(identity.ownerRef)) return false;
    }
    const user = idValue(identity.userId);
    const cust = idValue(identity.custId);
    if (!user && !cust && !identity.ownerRef) return false;
    if (user && idValue(record.userId) !== user) return false;
    if (cust && idValue(record.custId ?? record.cust_id) !== cust) return false;
    if (norm(identity.track) && norm(trackOf(record)) !== norm(identity.track)) return false;
    if (norm(identity.car || identity.carClass)
        && norm(carOf(record)) !== norm(identity.car || identity.carClass)) return false;
    return true;
  }
  // 振り返り（debrief）を結果（race記録）と同じ発生race/sessionの時だけ結合する。
  // どちらかのrace identityが不明な旧記録は、別raceへ推測結合しない。
  // 旧記録のiRacing SubSessionID（Bridgeのsession_summaryが送った権威値）は 'sub:<id>' と同じraceを指す。
  function raceIdOf(row) {
    if (!row) return null;
    if (row.race_instance_id) return String(row.race_instance_id);
    const sub = Number(row.subsessionId ?? row.subsession_id);
    return Number.isInteger(sub) && sub > 0 ? 'sub:' + sub : null;
  }
  function sameSourceRace(debrief, race) {
    const a = raceIdOf(debrief), b = raceIdOf(race);
    if (!a || !b || String(a) !== String(b)) return false;
    const sa = debrief.session_num, sb = race.sessionNum ?? race.session_num;
    return !(Number.isInteger(sa) && Number.isInteger(sb) && sa !== sb);
  }

  function memoryId(kind, row, index) {
    return safe(row.memory_id || row.memoryId || [kind,
      row.subsessionId || row.subsession_id || row.sessionKey || row.recordedAt || row.date || index,
      row.userId ?? row.custId ?? row.cust_id ?? 'unknown'].join('|'), 180);
  }

  function search(stores, identity) {
    const source = stores && typeof stores === 'object' ? stores : {};
    const found = [];
    const add = (kind, rows) => (Array.isArray(rows) ? rows : []).forEach((row, index) => {
      if (identityMatches(row, identity)) found.push({ kind, memory_id: memoryId(kind, row, index), row });
    });
    add('race', source.raceHistory);
    add('debrief', source.debriefRecords);
    add('decision', source.decisionRecords);
    add('evaluation', source.evaluations);
    return found.slice(-12);
  }

  function latestRace(matches) {
    const rows = matches.filter(x => x.kind === 'race');
    return rows.length ? rows[rows.length - 1] : null;
  }

  // WO018：Bridge確定のPlan結果・pit分類（race記録のraceOutcome、無ければ同じ発生raceのdebrief記録）。
  //   race identityが一致しないcopy、運んでいる記録が90日超／未来時刻のcopyは使わない
  //   （判断台帳・debrief noteと同じ失効契約。墓標の失効後に削除した判断が復活しないため）。
  const OUTCOME_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000, CLOCK_SKEW_MS = 5 * 60 * 1000;
  function freshRow(row, nowMs) {
    const at = Date.parse(String((row && (row.recordedAt || row.created_at)) || ''));
    return Number.isFinite(at) && nowMs - at <= OUTCOME_MAX_AGE_MS && at <= nowMs + CLOCK_SKEW_MS;
  }
  function outcomeCopy(row, field, race) {
    const o = row && row[field];
    return (o && o.available === true && o.schema === 1 && String(o.race_instance_id) === String(raceIdOf(race))) ? o : null;
  }
  // 旧推測（plan名＋pit＋順位維持）の成功を、Bridge確定の失効・penalty・Driver異議と矛盾させない。
  // ここで新しい成功/失敗の採点はしない：penalty発生・Plan失効・順位維持は観測として別欄に出し、
  // plan_successは既存の判断台帳の採点（decision-memory、Driver訂正を含む）がある時だけ使う。
  function planVerdict(race, debrief, decisions, start, finish, opts) {
    const nowMs = opts && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const raceId = String(raceIdOf(race));
    const raceCopy = outcomeCopy(race, 'raceOutcome', race), debriefCopy = outcomeCopy(debrief, 'race_outcome', race);
    const outcome = (raceCopy && freshRow(race, nowMs) ? raceCopy : null) || (debriefCopy && freshRow(debrief, nowMs) ? debriefCopy : null);
    const plan = safe(race.planName ?? race.plan_name ?? race.selectedPlan);
    if (outcome) {
      // 本人が判断台帳で削除した判断は再利用しない（pitの測定事実は別欄で残す）。
      const deleted = new Set(((opts && opts.tombstones) || [])
        .filter(t => t && String(t.race_instance_id || '') === raceId).map(t => String(t.decision_id)));
      const byId = {};
      decisions.forEach(d => { byId[String(d.decision_id)] = d; });
      const plans = (Array.isArray(outcome.plans) ? outcome.plans : [])
        .filter(p => !/^superseded_by:/.test(String(p.reason || '')) && !deleted.has(String(p.decision_id)));
      const pits = Array.isArray(outcome.pits) ? outcome.pits : [];
      const corrections = debrief && debriefCopy && freshRow(debrief, nowMs) && Array.isArray(debrief.outcome_corrections)
        ? debrief.outcome_corrections : [];
      const view = {
        outcome_source: 'bridge_session_summary',
        plan_outcomes: plans.slice(-6).map(p => {
          const d = byId[String(p.decision_id)];
          return { plan: p.selected_plan || null, target_lap: Number.isInteger(p.target_lap) ? p.target_lap : null,
            phase: p.phase, reason: p.reason || null,
            pit_lap: (pits.find(x => x.pit_event_id === p.pit_event_id) || {}).entry_lap ?? null,
            driver_note: d && d.status === 'disputed' ? 'disputed_record_not_reused'
              : d && d.status === 'corrected' ? 'driver_corrected' : null,
            driver_corrected_outcome: d && d.status === 'corrected' && d.outcomeSource === 'driver_correction' ? (d.outcome || null) : null };
        }),
        penalty_pit_laps: pits.filter(x => x.relation === 'penalty').map(x => x.entry_lap ?? null),
        driver_pit_corrections: corrections.filter(c => c && c.race_instance_id === outcome.race_instance_id)
          .map(c => ({ pit_lap: c.entry_lap ?? null, bridge: c.canonical_relation || null, driver_claim: c.driver_claim || null })),
      };
      const executedRows = plans.filter(p => p.phase === 'executed').map(p => byId[String(p.decision_id)]).filter(Boolean);
      if (executedRows.some(d => d.status === 'disputed')) return Object.assign(view, { plan_success: null, plan_success_basis: 'driver_disputed' });
      const scored = executedRows.find(d => ['success', 'traffic_failure', 'fuel_failure'].indexOf(d.outcome) >= 0);
      if (scored) {
        return Object.assign(view, { plan_success: scored.outcome === 'success',
          plan_success_basis: (scored.outcomeSource === 'driver_correction' ? 'driver_corrected_outcome:' : 'decision_memory_outcome:') + scored.outcome });
      }
      return Object.assign(view, { plan_success: null, plan_success_basis: 'no_authoritative_score' });
    }
    // Plan結果のcopyはあるが失効した → 旧推測へ戻さない。
    if (raceCopy || debriefCopy) return { outcome_source: null, plan_success: null, plan_success_basis: 'outcome_expired' };
    // Bridge確定outcomeが無い旧記録：失効・penalty・異議の印があれば推測成功を出さない。
    const marker = race.canonical_lifecycle && race.canonical_lifecycle.phase;
    if ((marker && marker !== 'executed') || (race.penalty_evidence && race.penalty_evidence.state === 'true')
        || decisions.some(d => d.status === 'disputed' || d.status === 'corrected')) {
      return { outcome_source: null, plan_success: null, plan_success_basis: 'contradicting_marker' };
    }
    const inferred = race.planSuccess === true || race.plan_success === true
      || (plan && finite(race.pitEntryLap ?? race.pit_entry_lap) !== null && finish !== null && start !== null && finish <= start);
    return { outcome_source: inferred ? 'legacy_inference' : null, plan_success: inferred || null,
      plan_success_basis: inferred ? 'legacy_position_inference' : null };
  }

  // opts：{nowMs, tombstones}（Plan結果copyの失効と、本人が削除した判断の除外に使う）
  function derive(matches, opts) {
    const raceHit = latestRace(matches);
    if (!raceHit) return { available:false, reason:'matching_race_unavailable', memory_ids:[] };
    const r = raceHit.row;
    const debriefs = matches.filter(x => x.kind === 'debrief' && sameSourceRace(x.row, r));
    const debrief = debriefs.length ? debriefs[debriefs.length - 1].row : null;
    const start = finite(r.startPos ?? r.start_pos);
    const finish = finite(r.finishPos ?? r.finish_pos);
    const incidents = finite(r.incidents);
    const irBefore = finite(r.iratingBefore ?? r.irating_before);
    const irAfter = finite(r.iratingAfter ?? r.irating_after ?? r.irating);
    const irDelta = finite(r.iratingDelta ?? r.irating_delta)
      ?? (irBefore !== null && irAfter !== null ? irAfter - irBefore : null);
    const driverStatement=safe((debrief&&(debrief.driverStatement??debrief.driver_statement??debrief.driverNote??debrief.note))
      ??r.driverStatement??r.driver_statement??r.driverNote,500);
    const controlled = /危険|無理な追い抜き|抑え|control|avoid/i.test(driverStatement);
    const gained = start !== null && finish !== null ? start - finish : null;
    const clean = incidents !== null && incidents <= 1;
    const plan = safe(r.planName ?? r.plan_name ?? r.selectedPlan);
    // 判断台帳は同じ発生raceのものだけ（別raceの異議を混ぜない）。
    const decisions = matches.filter(x => x.kind === 'decision' && raceIdOf(x.row) && raceIdOf(x.row) === raceIdOf(r));
    const verdict = planVerdict(r, debrief, decisions.map(x => x.row), start, finish, opts || {});
    // 使った根拠だけをidとして返す（別raceのdebrief・判断を混ぜたように見せない）。
    const ids = matches.filter(x => (x.kind !== 'debrief' || sameSourceRace(x.row, r))
      && (x.kind !== 'decision' || decisions.includes(x))).map(x => x.memory_id);
    return {
      available:true,
      memory_ids:ids,
      facts:{ start_class_pos:start, finish_class_pos:finish, positions_gained:gained,
        incidents, irating_before:irBefore, irating_after:irAfter, irating_delta:irDelta,
        sof:finite(r.sof), completed_laps:finite(r.totalLaps ?? r.total_laps), best_lap:safe(r.bestLap ?? r.best_lap),
        plan:plan || null, pit_entry_lap:finite(r.pitEntryLap ?? r.pit_entry_lap),
        pit_exit_lap:finite(r.pitExitLap ?? r.pit_exit_lap), plan_success:verdict.plan_success,
        plan_success_basis:verdict.plan_success_basis || null, outcome_source:verdict.outcome_source || null,
        plan_outcomes:verdict.plan_outcomes || null, penalty_pit_laps:verdict.penalty_pit_laps || null,
        driver_pit_corrections:verdict.driver_pit_corrections && verdict.driver_pit_corrections.length ? verdict.driver_pit_corrections : null,
        driver_statement:driverStatement || null },
      assessment:{ controlled_risk:controlled, brought_home_result:!!(controlled && clean && gained !== null && gained > 0),
        one_focus:clean ? '同じリスク管理を再現し、確実な機会だけ使う' : 'インシデントの発生場面を一つ特定する' }
    };
  }

  function promptBlock(result) {
    if (!result || !result.available) return '';
    return '\n\n━━ LUNA MEMORY BRAIN（回答前に検索済み）━━\n'
      + JSON.stringify({memory_ids:result.memory_ids,facts:result.facts,assessment:result.assessment})
      + '\nこの検索結果を必要な時だけ使え。factは確定事実、assessmentは根拠付き評価。推定を実測と言うな。plan_successがfalse/nullならPlanが成功したと言うな（plan_success_basisが根拠。plan_outcomes・penalty_pit_lapsは観測でありPlanの成否の判定ではない）。driver_pit_correctionsはDriver申告でありBridge記録を上書きしない。質問へ直接答え、関係する根拠は最大2点。未計測のライン・距離・操作を作るな。';
  }

  function evaluationRecord(result, reply, identity, nowMs) {
    if (!result || !result.available || !safe(reply)) return null;
    const at = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
    return { version:1, memory_id:'evaluation|'+at+'|'+result.memory_ids[0],
      owner_ref:identity.ownerRef ?? null,
      userId:identity.userId ?? null, custId:identity.custId ?? null,
      track:identity.track || null, car:identity.car || identity.carClass || null,
      recordedAt:at, source_memory_ids:result.memory_ids.slice(), assessment:result.assessment,
      reply:safe(reply, 600), disputed:false, deleted:false };
  }

  return { identityMatches, search, derive, promptBlock, evaluationRecord };
}));
