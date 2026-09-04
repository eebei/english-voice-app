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

  function identityMatches(record, identity) {
    if (!record || record.disputed === true || record.deleted === true || !identity) return false;
    const user = idValue(identity.userId);
    const cust = idValue(identity.custId);
    if (!user && !cust) return false;
    if (user && idValue(record.userId) !== user) return false;
    if (cust && idValue(record.custId ?? record.cust_id) !== cust) return false;
    if (norm(identity.track) && norm(record.track) !== norm(identity.track)) return false;
    if (norm(identity.car || identity.carClass)
        && norm(record.car || record.carClass) !== norm(identity.car || identity.carClass)) return false;
    return true;
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

  function derive(matches) {
    const raceHit = latestRace(matches);
    if (!raceHit) return { available:false, reason:'matching_race_unavailable', memory_ids:[] };
    const r = raceHit.row;
    const debriefs = matches.filter(x => x.kind === 'debrief');
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
    const planSuccess = r.planSuccess === true || r.plan_success === true
      || (plan && finite(r.pitEntryLap ?? r.pit_entry_lap) !== null && finish !== null && start !== null && finish <= start);
    const ids = matches.map(x => x.memory_id);
    return {
      available:true,
      memory_ids:ids,
      facts:{ start_class_pos:start, finish_class_pos:finish, positions_gained:gained,
        incidents, irating_before:irBefore, irating_after:irAfter, irating_delta:irDelta,
        sof:finite(r.sof), completed_laps:finite(r.totalLaps ?? r.total_laps), best_lap:safe(r.bestLap ?? r.best_lap),
        plan:plan || null, pit_entry_lap:finite(r.pitEntryLap ?? r.pit_entry_lap),
        pit_exit_lap:finite(r.pitExitLap ?? r.pit_exit_lap), plan_success:planSuccess || null,
        driver_statement:driverStatement || null },
      assessment:{ controlled_risk:controlled, brought_home_result:!!(controlled && clean && gained !== null && gained > 0),
        one_focus:clean ? '同じリスク管理を再現し、確実な機会だけ使う' : 'インシデントの発生場面を一つ特定する' }
    };
  }

  function promptBlock(result) {
    if (!result || !result.available) return '';
    return '\n\n━━ LUNA MEMORY BRAIN（回答前に検索済み）━━\n'
      + JSON.stringify({memory_ids:result.memory_ids,facts:result.facts,assessment:result.assessment})
      + '\nこの検索結果を必要な時だけ使え。factは確定事実、assessmentは根拠付き評価。推定を実測と言うな。質問へ直接答え、関係する根拠は最大2点。未計測のライン・距離・操作を作るな。';
  }

  function evaluationRecord(result, reply, identity, nowMs) {
    if (!result || !result.available || !safe(reply)) return null;
    const at = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
    return { version:1, memory_id:'evaluation|'+at+'|'+result.memory_ids[0],
      userId:identity.userId ?? null, custId:identity.custId ?? null,
      track:identity.track || null, car:identity.car || identity.carClass || null,
      recordedAt:at, source_memory_ids:result.memory_ids.slice(), assessment:result.assessment,
      reply:safe(reply, 600), disputed:false, deleted:false };
  }

  return { identityMatches, search, derive, promptBlock, evaluationRecord };
}));
