(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallSessionMemory = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ★スライス1（2026-08-25）記憶→戦略の取得層。
  //
  // Tunnel Completion Rule：入口（Bridge）→保存（pw_raceHistory）→**取得**→出口（発話）を
  // 一本で閉じるための中間層。ここが決定論であることが要点で、
  // 「どの記録を使うか」「何を事実として言うか」をLLMに選ばせない。
  //
  // 原則：
  //   - 記録が無ければ「無い」と言う。現在値で代用しない（Build 281 の実走欠陥）。
  //   - 同一条件でなければ使わない。別トラック・別車種の記録を流用しない。
  //   - 推測しない。欠けている項目は欠けたまま返す。

  const finite = value => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const norm = value => String(value == null ? '' : value).trim().toLowerCase();
  const SPIELBERG_GP_ALIASES = new Set([
    'red bull ring', 'red bull ring gp', 'spielberg', 'spielberg gp'
  ]);
  const MONZA_GP_ALIASES = new Set(['autodromo nazionale monza','monza grand prix','monza full']);
  function normTrack(value) {
    const text = norm(value).replace(/[^a-z0-9]+/g, ' ').trim();
    return SPIELBERG_GP_ALIASES.has(text) ? 'spielberg:gp' : MONZA_GP_ALIASES.has(text) ? 'monza:gp' : text;
  }
  const isJP = lang => String(lang || '').toLowerCase().startsWith('ja');
  const MAX_RECORD_AGE_MS = 90 * 24 * 60 * 60 * 1000;

  function isFreshRecord(record, nowMs) {
    const raw = record && (record.recordedAt || record.date);
    const at = Date.parse(String(raw || ''));
    if (!Number.isFinite(at)) return false;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    // Future-dated cache or records older than the evidence window cannot
    // become today's strategy/weather fact.
    return at <= now + 5 * 60 * 1000 && now - at <= MAX_RECORD_AGE_MS;
  }

  // 同一条件の判定。現在側で分かっているidentityは、記録側にも同じ値が
  // なければならない。古いrecordの空欄を「何でも一致」と扱うと、別車種・
  // 別series・別アカウントの過去を今回の事実として喋る事故になる。
  function matchesIdentity(record, identity, nowMs) {
    if (!record || !identity) return false;
    // ★スライス4c：ドライバーが「それ違う」と言った記録は、本人合意で訂正される
    //   まで一切使わない。天候・順位・setup・pit すべて同じ規律にする。
    if (record.disputed === true) return false;
    if (!isFreshRecord(record, nowMs)) return false;
    if (!normTrack(identity.track)) return false;
    if (normTrack(record.track) !== normTrack(identity.track)) return false;
    const wantUser = identity.userId;
    const wantCust = identity.custId;
    if (!wantUser && !wantCust) return false;  // userId or custId 必須
    if (wantUser !== null && wantUser !== undefined && wantUser !== '') {
      if (String(record.userId ?? '') !== String(wantUser)) return false;
    }
    if (wantCust !== null && wantCust !== undefined && wantCust !== '') {
      if (String(record.custId ?? record.cust_id ?? '') !== String(wantCust)) return false;
    }
    const wantCar = norm(identity.car || identity.carClass);
    if (wantCar) {
      const gotCar = norm(record.car || record.carClass);
      if (gotCar !== wantCar) return false;
    }
    if (Number.isInteger(identity.seriesId)) {
      if (!Number.isInteger(record.seriesId) || identity.seriesId !== record.seriesId) return false;
    }
    return true;
  }

  // 同一条件のうち最新の1件だけを選ぶ。複数を混ぜると、どの日の事実か言えなくなる。
  function selectPrevious(history, identity, nowMs) {
    if (!Array.isArray(history)) return null;
    const matches = history.filter(record => matchesIdentity(record, identity, nowMs));
    return matches.length ? matches[matches.length - 1] : null;
  }

  const dayKey = value => {
    const raw=String(value||'');
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const d=new Date(raw);return Number.isFinite(d.getTime())
      ? [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'):null;
  };
  function isCurrentRecallQuestion(text){
    return /今|いま|このレース|現在|これから|今日|次(?:の)?周|最後まで.{0,4}(?:持|も|足)|ウィンドウ|\bnow\b|\btoday\b|next lap|current|this (?:race|lap)/i.test(String(text||''));
  }
  function debriefFingerprint(review,captured=null){
    const qa=Array.isArray(review?.qa)?review.qa:[];
    let conversation=(Array.isArray(review?.conversation)?review.conversation:[]).map(x=>({role:x?.role,text:x?.text}));
    if(captured!==null){
      let prior;try{prior=JSON.parse(captured);}catch{return null;}
      if(!prior||!Array.isArray(prior.qa)||!Array.isArray(prior.conversation))return null;
      // The in-flight answer may append itself to the same saved debrief.
      // Preserve every captured entry; ignore only new assistant suffix rows.
      // Driver additions, edits/deletions in the prefix and QA corrections
      // still change the fingerprint and revoke the old answer.
      if(conversation.length>=prior.conversation.length&&conversation.slice(prior.conversation.length).every(x=>x.role==='assistant'))
        conversation=conversation.slice(0,prior.conversation.length);
    }
    return JSON.stringify({qa,conversation,race_outcome:review?.race_outcome||null,
      outcome_corrections:review?.outcome_corrections||[],driver_statement:review?.driver_statement??review?.driverStatement??null});
  }
  function historicalRequest(text, previous, nowMs=Date.now()) {
    const raw=String(text||'');
    if(/路面|路温|気温|温度|天気|weather|temperature/i.test(raw))return null;
    const explicit=/昨日|前回|前戦|前のレース|この前|走ったレース|一緒に走った|yesterday|last race|previous race/i.test(raw);
    const current=isCurrentRecallQuestion(raw);
    if(explicit&&current&&/(?:昨日|前回|前のレース).{0,6}(?:じゃなく|ではなく)/.test(raw))return null;
    const follow=/ピット|給油|燃料|何(?:回|位|週|周)|難易.{0,4}ゴール|サーキット|コース|反省|振り返|アドバイス|pit|fuel|finish|circuit|advice/i.test(raw);
    if(!explicit&&(current||!follow||!previous||nowMs-previous.at>180000||nowMs<previous.at))return null;
    if(!explicit&&/削除|消して|忘れて|delete|forget/i.test(raw))return null;
    let requestedDay=explicit?null:previous.requestedDay;
    if(/昨日|yesterday/i.test(raw)){const d=new Date(nowMs);d.setDate(d.getDate()-1);requestedDay=dayKey(d.toISOString());}
    return {requestedDay,at:nowMs,sameConditions:/この(?:コース|車)|同じ(?:コース|車)|this (?:track|car)/i.test(raw),
      recordId:explicit?null:previous.recordId||null,
      deleteMemory:/(?:記憶|記録|データ|memory|record).{0,10}(?:削除|消して|忘れて|delete|forget)|(?:delete|forget).{0,12}(?:memory|record)/i.test(raw),
      conversationOnly:/(?:前回|前のレース|前戦|last race).{0,15}(?:ピット|pit).{0,12}(?:どうだった|how (?:did|was)|how did|how was)/i.test(raw)&&!/何(?:周|週|回|位)|how many/i.test(raw),
      pit:/ピット|給油|何回|pit|refuel/i.test(raw),fuel:/燃料|残量|fuel/i.test(raw),
      result:/何位|難易|ゴール|結果|リザルト|finish|result/i.test(raw),
      advice:/反省|振り返|アドバイス|デブリ|advice|debrief/i.test(raw),
      trackOnly:/^(?:サーキット|コース)(?:は)?(?:どこ|何)[？?。]*$/i.test(raw)};
  }
  function personalPastRecord(record, identity, request, nowMs) {
    if(!record||!identity||record.deleted||record.disputed||!record.raceRecordId||!isFreshRecord(record,nowMs))return false;
    const cust=finite(identity.custId),rc=finite(record.custId??record.cust_id);
    if(!(Number.isInteger(cust)&&cust>0&&cust===rc))return false;
    if(record.owner_ref&&record.owner_ref!==identity.ownerRef)return false;
    if(record.userId!=null&&String(record.userId)!==String(identity.userId??''))return false;
    const raceId=record.race_instance_id||(record.subsessionId?'sub:'+record.subsessionId:null);
    if(identity.currentRaceInstanceId&&raceId===identity.currentRaceInstanceId)return false;
    const kind=norm(record.sessionType??record.session_type??record.event_type);
    if(kind!=='race')return false;
    if(request.requestedDay&&dayKey(record.recordedAt||record.date)!==request.requestedDay)return false;
    if(request.recordId&&record.raceRecordId!==request.recordId)return false;
    if(request.sameConditions&&(normTrack(record.track)!==normTrack(identity.track)||norm(record.car||record.carClass)!==norm(identity.car||identity.carClass)))return false;
    return true;
  }
  function compactRaceRecord(record) {
    const pits=Array.isArray(record.pitEvents)?record.pitEvents:[];
    return {version:1,date:dayKey(record.recordedAt||record.date),track:String(record.track||''),
      completed_laps:finite(record.completedLaps??record.totalLaps),finish_class_position:finite(record.finishPos),
      finish_overall_position:finite(record.finishOverallPos),incidents:finite(record.incidents),
      official_result_arrived:record.official_result_arrived===true,
      pits:pits.map(p=>({entry_lap:finite(p.entry_lap??p.entry?.lap),fuel_added_l:finite(p.fuel_added_l??p.service?.fuel_added_l)})),
      pit_count:Array.isArray(record.pitEvents)?pits.length:null,fuel_at_finish_l:finite(record.fuelAtFinish)};
  }
  function recallRace(history,identity,request,lang='ja',nowMs=Date.now(),debriefs=[]) {
    if(!request)return null;
    const records=(Array.isArray(history)?history:[]).filter(r=>personalPastRecord(r,identity,request,nowMs))
      .sort((a,b)=>Date.parse(a.recordedAt||a.date)-Date.parse(b.recordedAt||b.date));
    const record=records[records.length-1]||null,ja=isJP(lang);
    if(!record)return {handled:true,intent:'historical_race_unavailable',record:null,
      reply:ja?`${request.requestedDay||'前回'}の本人のレース記録を確認できない。現在の燃料や予定で置き換えず、保存記録の不足として扱う。`:'I cannot verify that personal race record. I will not substitute current fuel or plans.'};
    if(request.deleteMemory)return {handled:true,intent:'historical_race_delete',record,
      reply:ja?'選択したレース記録の削除を処理する。':'Deleting the selected race record.'};
    const summary=compactRaceRecord(record);let reviewRef=null;const parts=[ja?`${summary.date}、${summary.track}の保存記録。`:`Saved race on ${summary.date} at ${summary.track}.`];
    const all=!request.pit&&!request.fuel&&!request.result&&!request.advice;
    if(!request.trackOnly){
      if(request.pit||all){
        const laps=summary.pits.map(p=>p.entry_lap).filter(p=>Number.isInteger(p)&&p>0);
        parts.push(ja?(summary.pit_count===null?'ピット実績は未保存。':`ピットは${summary.pit_count}回。`)+(laps.length?`${laps.join('・')}周目。`:'')
          :`Pit count: ${summary.pit_count??'unknown'}. Recorded entry laps: ${laps.join(', ')||'unknown'}.`);
        if(request.pit&&request.fuel){const adds=summary.pits.map(p=>p.fuel_added_l).filter(v=>v!==null);if(adds.length)parts.push(ja?`実補給は${adds.map(v=>v.toFixed(2)).join('・')}L。`:`Measured additions: ${adds.join(', ')}L.`);}
      }
      if(request.result||all)parts.push(ja?(summary.finish_class_position>0?`クラスP${summary.finish_class_position}。`:'順位は未保存。')+(summary.completed_laps>0?`${summary.completed_laps}周完了。`:'')
        :`Class finish ${summary.finish_class_position??'unknown'}, completed laps ${summary.completed_laps??'unknown'}.`);
      if(request.fuel)parts.push(ja?(summary.fuel_at_finish_l!==null?`終了時残量${summary.fuel_at_finish_l.toFixed(2)}L。`:'終了時の残量は未保存。'):'Finish fuel: '+(summary.fuel_at_finish_l??'unknown')+'L.');
      if(request.advice){
        const race=record.race_instance_id||(record.subsessionId?'sub:'+record.subsessionId:null);
        const review=(Array.isArray(debriefs)?debriefs:[]).filter(d=>!d.deleted&&!d.disputed&&race&&d.race_instance_id===race
          &&d.owner_ref&&d.owner_ref===identity.ownerRef&&finite(d.custId)===finite(identity.custId)
          &&(!Number.isInteger(record.sessionNum)||d.session_num===record.sessionNum)).slice(-1)[0];
        reviewRef=review?{id:review.review_id,owner:review.owner_ref,fingerprint:debriefFingerprint(review)}
          :{missing:true,raceInstanceId:race,owner:identity.ownerRef};
        const notes=(review?.qa||[]).map(q=>q.answer).filter(Boolean).slice(-2);
        const conversation=(review?.conversation||[]).filter(x=>x.role==='user').map(x=>x.text).slice(-2);
        const userNotes=[...notes,...conversation].slice(-2).map(t=>String(t).replace(/[\r\n]+/g,' ').slice(0,150));
        parts.push(userNotes.length?(ja?'当時のDriver申告：':'Driver reports from that race: ')+userNotes.map(t=>'「'+t+'」').join('。')+(ja?'。実測事実とは区別している。':' (not measured facts).')
          :(ja?'振り返りの発言は保存記録で確認できない。今回の助言を昨日の反省として作らない。':'No saved debrief statements are available; I will not invent past advice.'));
        const advice=(review?.conversation||[]).filter(x=>x.role==='assistant'&&!/[?？]/.test(x.text||'')&&/次回|優先|早め|意識|抑え|next time|avoid|keep/i.test(x.text||'')).slice(-1)[0]?.text;
        if(advice)parts.push((ja?'当時のLUNAの助言（未検証）：':'Luna advice from that race (unverified): ')+String(advice).replace(/[\r\n]+/g,' ').slice(0,150));
      }
    }
    return {handled:true,intent:'historical_race_recall',record,summary,reply:parts.join(''),
      memoryFingerprint:JSON.stringify(summary),reviewRef,request:{...request,recordId:record.raceRecordId}};
  }

  function hasWeather(record) {
    return !!record && (finite(record.trackTempC) !== null || finite(record.airTempC) !== null);
  }

  function sameSetup(record, identity) {
    const a = norm(record && record.setupFingerprint);
    const b = norm(identity && identity.setupFingerprint);
    if (!a || !b) return 'unknown';
    return a === b ? 'matched' : 'mismatch';
  }

  // 「昨日の路面温度は？」への決定論回答。
  // 記録が無い時に現在値を返さないことが、この関数の存在理由。
  function answerHistoricalWeather(history, identity, lang, nowMs) {
    const ja = isJP(lang);
    const record = selectPrevious(history, identity, nowMs);
    if (!record || !hasWeather(record)) {
      return {
        handled: true,
        intent: 'historical_weather_unavailable',
        reply: ja ? '同じ条件の過去記録がない。現在値では代用しない。'
                  : 'There is no past record for these conditions. I will not substitute the current value.',
        record: null,
      };
    }
    const track = finite(record.trackTempC);
    const air = finite(record.airTempC);
    const when = String(record.date || '').trim();
    const parts = [];
    if (track !== null) parts.push(ja ? `路面${track.toFixed(1)}℃` : `track ${track.toFixed(1)}C`);
    if (air !== null) parts.push(ja ? `気温${air.toFixed(1)}℃` : `air ${air.toFixed(1)}C`);
    const body = parts.join(ja ? '、' : ', ');
    return {
      handled: true,
      intent: 'historical_weather',
      reply: ja ? `${when}の${record.track}は${body}。` : `On ${when} at ${record.track}: ${body}.`,
      record,
    };
  }

  // 「前回給油は？」への決定論回答。Spa 等の過去レース給油実績から応答。
  function answerPreviousFuel(history, identity, lang, nowMs) {
    const ja = isJP(lang);
    // ★P0-3修正：本人不明を拒否（custId が必須）
    if (!identity || !identity.custId) {
      return {
        handled: true,
        intent: 'previous_fuel_unavailable',
        reply: ja ? '現在のドライバーが不明。' : 'Current driver unknown.',
        record: null,
      };
    }
    const record = selectPrevious(history, identity, nowMs);
    if (!record) {
      return {
        handled: true,
        intent: 'previous_fuel_unavailable',
        reply: ja ? '同じ条件の過去給油記録がない。' : 'No matching fuel record.',
        record: null,
      };
    }
    const pitEntry = finite(record.pitEntryLap);
    const fuelAtPit = finite(record.fuelAtPitEntry);
    const fuelAtFinish = finite(record.fuelAtFinish);
    if (pitEntry === null || fuelAtPit === null || fuelAtFinish === null) {
      return {
        handled: true,
        intent: 'previous_fuel_incomplete',
        reply: ja ? 'かつての給油記録は不完全。' : 'Fuel record is incomplete.',
        record,
      };
    }
    // ★P0-3修正：公式未確認を拒否（official_result_arrived が明示的に true）
    if (record.official_result_arrived !== true) {
      return {
        handled: true,
        intent: 'previous_fuel_pending',
        reply: ja ? '前回レースの公式結果待ち。' : 'Official result pending.',
        record,
      };
    }
    const reply = ja
      ? `前回は${pitEntry}周終了後に入り、${fuelAtPit}L給油。チェッカー時${fuelAtFinish}L残。`
      : `Last time: pit entry at lap ${pitEntry}, refueled ${fuelAtPit}L, finished with ${fuelAtFinish}L.`;
    return {
      handled: true,
      intent: 'previous_fuel_reference',
      reply,
      record,
    };
  }

  // 次回ブリーフィング用の確定事実。文章にはせず、事実だけを返す。
  // 文面を作るのは呼び出し側で、ここが数字を持つ唯一の場所。
  function briefingFacts(history, identity, nowMs) {
    const record = selectPrevious(history, identity, nowMs);
    if (!record) return { available: false, reason: 'no_matching_record' };
    const start = Number.isInteger(record.startPos) && record.startPos > 0 ? record.startPos : null;
    const finish = Number.isInteger(record.finishPos) && record.finishPos > 0 ? record.finishPos : null;
    return {
      available: true,
      // WO017：訂正対象を日付ではなく記録IDで名指しするため（同日別raceを巻き添えにしない）。
      raceRecordId: record.raceRecordId ? String(record.raceRecordId) : null,
      date: String(record.date || '') || null,
      track: record.track || null,
      car: record.car || record.carClass || null,
      startPos: start,
      finishPos: finish,
      positionsGained: (start !== null && finish !== null) ? start - finish : null,
      trackTempC: finite(record.trackTempC),
      airTempC: finite(record.airTempC),
      setupMatch: sameSetup(record, identity),
      pitCount: Array.isArray(record.pitEvents) ? record.pitEvents.length : null,
      avgFuelPerLap: finite(record.avgFuelPerLap),
    };
  }

  // Strategy consumes structured evidence, not the human-readable briefing.
  // Core identity (driver/car/track/series) is enforced by selectPrevious().
  // Session/rules mismatches fail closed when both sides are known; setup and
  // weather differences remain usable only as a clearly-labelled estimate.
  function strategyFuelEvidence(history, identity, nowMs) {
    const record = selectPrevious(history, identity, nowMs);
    if (!record) return { available: false, reason: 'no_matching_record' };
    const burn = finite(record.avgFuelPerLap);
    if (!(burn > 0)) return { available: false, reason: 'fuel_burn_unavailable' };
    // ★2026-09-14 Codex差戻し：以前は「どちらかが不明なら通す」だった。現在側で
    //   既知の条件が履歴側に無い記録は、条件一致を主張できない——燃費は series・
    //   session種別・燃料/タイヤ規則で変わるため fail-closed にする（不明は
    //   「同じ」ではない）。現在側が不明な時だけ、その条件の照合を見送る。
    const ruleGate = (key, recordValue, currentValue) => {
      const want = norm(currentValue);
      if (!want) return null;                       // 現在側が不明：この条件は問わない
      const got = norm(recordValue);
      if (!got) return `${key}_unknown_in_record`;  // 現在は既知・履歴は欠損：使わない
      return got === want ? null : `${key}_mismatch`;
    };
    const ruleReason = ruleGate('session_type', record.sessionType, identity.sessionType)
      || ruleGate('race_format', record.raceFormat, identity.raceFormat)
      || ruleGate('fuel_rule', record.fuelRule, identity.fuelRule)
      || ruleGate('tyre_rule', record.tyreRule, identity.tyreRule);
    if (ruleReason) return { available: false, reason: ruleReason };
    // seriesId は matchesIdentity が現在側既知の時だけ照合する。燃費根拠としては
    // 「現在のseriesが分かっているのに履歴に無い」記録も採らない。
    if (Number.isInteger(identity.seriesId) && !Number.isInteger(record.seriesId)) {
      return { available: false, reason: 'series_unknown_in_record' };
    }
    const setupMatch = sameSetup(record, identity);
    const priorTrackTemp = finite(record.trackTempC);
    const currentTrackTemp = finite(identity.trackTempC);
    const trackTempDeltaC = priorTrackTemp !== null && currentTrackTemp !== null
      ? Math.abs(currentTrackTemp - priorTrackTemp) : null;
    const warnings = [];
    if (setupMatch === 'mismatch') warnings.push('setup_mismatch');
    if (trackTempDeltaC !== null && trackTempDeltaC >= 10) warnings.push('track_temp_delta');
    return {
      available: true,
      reason: warnings.length ? 'matching_identity_with_context_difference' : 'matching_identity',
      avgFuelPerLap: burn,
      sampleLaps: Number.isInteger(record.totalLaps) && record.totalLaps > 0 ? record.totalLaps : 1,
      basis: 'memory_previous',
      confidence: warnings.length ? 'estimate_low' : 'estimate',
      warnings,
      setupMatch,
      trackTempDeltaC,
      recordDate: String(record.date || '') || null,
      record,
    };
  }

  // Planning is an estimate, not a claim that old conditions are today's
  // facts. Keep driver/car/track strict; report age/rule/setup differences.
  function fuelPlanningEvidence(history, identity, nowMs) {
    if (!Array.isArray(history) || !identity || !normTrack(identity.track)
        || !norm(identity.car || identity.carClass)) return {available:false,reason:'identity_unavailable'};
    const now = Number.isFinite(nowMs) ? nowMs : Date.now(), candidates = new Map(), deviceCandidates = new Map();
    for (const record of history) {
      if (!record || record.disputed === true || record.deleted === true) continue;
      if (![identity.track,...(Array.isArray(identity.trackCandidates)?identity.trackCandidates:[])].some(track=>normTrack(record.track)===normTrack(track))
          || norm(record.car || record.carClass) !== norm(identity.car || identity.carClass)) continue;
      const cust=identity.custId, priorCust=record.custId??record.cust_id;
      const user=identity.userId, priorUser=record.userId;
      if (cust && priorCust && String(cust)!==String(priorCust)) continue;
      if (user && priorUser && String(user)!==String(priorUser)) continue;
      const deviceOnly=record.unverified_owner===true&&!priorCust&&!priorUser;
      if (!(cust && priorCust && String(cust)===String(priorCust))
          && !(user && priorUser && String(user)===String(priorUser)) && !deviceOnly) continue;
      const dated=Date.parse(record.recordedAt||record.date||'');
      const at=Number.isFinite(dated)?dated:0;
      if ((!at&&!deviceOnly) || at>now+300000 || !(finite(record.avgFuelPerLap)>0)) continue;
      const warnings=deviceOnly?['owner_unverified']:[];
      if(record.fuelSampleBasis!=='strict_clean')warnings.push('cleanliness_unverified');
      if(!at)warnings.push('record_date_unknown');
      if (now-at>MAX_RECORD_AGE_MS) warnings.push('older_than_90_days');
      for (const [key, field] of [['seriesId','series'],['sessionType','session_type'],['raceFormat','race_format'],['fuelRule','fuel_rule'],['tyreRule','tyre_rule']]) {
        if (identity[key]!==null && identity[key]!==undefined && identity[key]!=='') {
          if (record[key]===null || record[key]===undefined || record[key]==='') warnings.push(field+'_unknown');
          else if (norm(record[key])!==norm(identity[key])) warnings.push(field+'_mismatch');
        }
      }
      if (sameSetup(record,identity)==='mismatch') warnings.push('setup_mismatch');
      if (finite(record.trackTempC)!==null && finite(identity.trackTempC)!==null
          && Math.abs(Number(record.trackTempC)-Number(identity.trackTempC))>=10) warnings.push('track_temp_delta');
      const key=record.race_instance_id ? String(record.race_instance_id)+'|'+String(record.sessionNum??'') : record.raceRecordId||String(at);
      const row={record,at,warnings,quality:record.fuelSampleBasis==='strict_clean'?1:0,weight:Math.max(1,Math.min(50,finite(record.fuelSampleCount)||finite(record.totalLaps)||1))};
      const target=deviceOnly?deviceCandidates:candidates, prior=target.get(key);
      if (!prior || row.quality>prior.quality || row.quality===prior.quality&&(row.weight>prior.weight || row.weight===prior.weight&&at>prior.at)) target.set(key,row);
    }
    const rows=[...(candidates.size?candidates:deviceCandidates).values()];
    if (!rows.length) return {available:false,reason:'no_matching_fuel_history'};
    const samples=rows.reduce((n,r)=>n+r.weight,0);
    const average=rows.reduce((n,r)=>n+Number(r.record.avgFuelPerLap)*r.weight,0)/samples;
    const paceRows=rows.filter(r=>finite(r.record.avgLap)>20);
    const paceWeight=paceRows.reduce((n,r)=>n+r.weight,0);
    const warnings=[...new Set(rows.flatMap(r=>r.warnings))];
    const upper=Math.max(...rows.map(r=>Number(r.record.avgFuelPerLap)));
    const lower=Math.min(...rows.map(r=>Number(r.record.avgFuelPerLap)));
    const variable=upper>lower*1.2;
    if(variable)warnings.push('variable_burn_upper_bound');
    return {available:true,avgFuelPerLap:average,planningFuelPerLap:variable?upper:average,sampleLaps:samples,recordCount:rows.length,
      averageLapS:paceWeight?paceRows.reduce((n,r)=>n+Number(r.record.avgLap)*r.weight,0)/paceWeight:null,
      basis:candidates.size?'memory_analysis':'device_reference',confidence:warnings.length?'estimate_low':'estimate',warnings,
      recordDate:Math.max(...rows.map(r=>r.at))?new Date(Math.max(...rows.map(r=>r.at))).toISOString():null,
      recordIds:rows.map(r=>r.record.raceRecordId||r.record.race_instance_id||new Date(r.at).toISOString()),
      minFuelPerLap:Math.min(...rows.map(r=>Number(r.record.avgFuelPerLap))),
      maxFuelPerLap:Math.max(...rows.map(r=>Number(r.record.avgFuelPerLap)))};
  }

  function fuelPlanningEstimate(live, history, nowMs) {
    if (!live || live.on_track===false && !live.race_plan) return null;
    const state=finite(live.race_plan&&live.race_plan.session_state);
    if (state!==null && state>=5) return null; // checker/cooldown is not a new pit recommendation
    const fs=live.fuel_strategy||{}, measured=finite(fs.avg_fuel_per_lap);
    const count=finite(fs.strict_clean_laps_sampled)||0;
    const strict=finite(fs.strict_clean_avg_fuel_per_lap);
    const measuredCount=finite(fs.measured_laps_sampled)||finite(fs.clean_laps_sampled)||0;
    const historyRate=finite(history&&(history.planningFuelPerLap||history.avgFuelPerLap));
    // Three strict clean laps establish today's basis. Before then use
    // accumulated history; still answer provisionally when only one/two clean
    // samples or pit-excluded measured samples exist.
    let rate,basis,sampleCount;
    if(count>=3&&strict>0){rate=strict;basis='current_clean_laps';sampleCount=count;}
    else if(historyRate>0){rate=historyRate;basis=history.basis||'memory_analysis';sampleCount=0;}
    else if(count>0&&strict>0){rate=strict;basis='current_clean_laps';sampleCount=count;}
    else {rate=measured;basis='current_measured_laps';sampleCount=measuredCount;}
    if (!(rate>0)) return null;
    let crossings=finite(live.finish_crossings_authority),distanceBasis='bridge_finish_crossings',extraLap=0;
    if (crossings===null || crossings<0) {
      const seconds=finite(live.session_time_remaining_s);
      const forecast=live.timed_finish_forecast||{};
      const leader=finite(forecast.leader_time_to_checkered_s);
      const pace=finite(forecast.driver_avg_lap_s)||finite(live.driver_pace_median_s)||finite(history&&history.averageLapS);
      if (seconds!==null && seconds>=0 && pace>20) {
        crossings=Math.ceil((leader!==null&&leader>=0?leader:seconds)/pace)+1;
        distanceBasis=leader!==null&&leader>=0?'leader_clock_estimate':'time_and_pace_estimate';extraLap=1;
      } else crossings=null;
    }
    const reserve=2, fuel=finite(live.fuel);
    const needed=crossings===null?null:crossings*rate+reserve;
    return {basis,rate_l_per_lap:rate,live_sample_laps:sampleCount,strict_clean_laps:count,confidence:basis==='current_clean_laps'&&count>=3?'estimate':'estimate_low',
      crossings,distance_basis:distanceBasis,extra_lap:extraLap,reserve_l:reserve,
      required_l:needed,additional_l:needed!==null&&fuel!==null?Math.max(0,needed-fuel):null,
      fuel_l:fuel,laps_with_reserve:fuel!==null?Math.max(0,Math.floor((fuel-reserve)/rate)):null,
      history:['memory_analysis','device_reference'].includes(basis)?history:null,role:'recommendation_not_execution'};
  }

  // Lap pace is reusable more broadly than fuel burn. Series/fuel/tyre rules
  // may change without invalidating a measured driver/car/track lap time.
  function strategyLapEvidence(history, identity, nowMs) {
    if (!Array.isArray(history) || !identity || !normTrack(identity.track)) {
      return { available:false, reason:'history_or_identity_unavailable' };
    }
    const wantUser = identity.userId;
    const wantCar = norm(identity.car || identity.carClass);
    const rows = history.filter(record => {
      if (!record || record.disputed === true || !isFreshRecord(record, nowMs)) return false;
      if (normTrack(record.track) !== normTrack(identity.track)) return false;
      if (wantCar && norm(record.car || record.carClass) !== wantCar) return false;
      if (wantUser !== null && wantUser !== undefined && wantUser !== ''
          && String(record.userId ?? '') !== String(wantUser)) return false;
      return finite(record.avgLap) > 20;
    });
    if (!rows.length) return { available:false, reason:'average_lap_unavailable' };
    const record = rows[rows.length - 1];
    const warnings = [];
    if (Number.isInteger(identity.seriesId) && Number.isInteger(record.seriesId)
        && identity.seriesId !== record.seriesId) warnings.push('series_mismatch');
    if (sameSetup(record, identity) === 'mismatch') warnings.push('setup_mismatch');
    return { available:true, averageLapS:finite(record.avgLap), record,
      basis:'memory_previous', confidence:warnings.length?'estimate_low':'estimate', warnings };
  }

  // ブリーフィングで読み上げる短い一文。数字は briefingFacts が持つものだけを使う。
  // 事実が無ければ空文字を返し、呼び出し側は「言わない」を選べる。
  function briefingLine(facts, lang) {
    if (!facts || !facts.available) return '';
    const ja = isJP(lang);
    const bits = [];
    if (facts.startPos !== null && facts.finishPos !== null) {
      bits.push(ja ? `${facts.startPos}番手スタートで${facts.finishPos}位`
                   : `started P${facts.startPos}, finished P${facts.finishPos}`);
    } else if (facts.finishPos !== null) {
      bits.push(ja ? `${facts.finishPos}位` : `finished P${facts.finishPos}`);
    }
    if (facts.trackTempC !== null) {
      bits.push(ja ? `路面${facts.trackTempC.toFixed(1)}℃` : `track ${facts.trackTempC.toFixed(1)}C`);
    }
    // ★スライス4：pit 回数と燃費も Bridge 実測なので同じ規律で述べる。
    //   記録が無ければ足さない（0回と「記録なし」を混同しない）。
    if (Number.isInteger(facts.pitCount)) {
      bits.push(ja ? `ピット${facts.pitCount}回` : `${facts.pitCount} stop${facts.pitCount === 1 ? '' : 's'}`);
    }
    if (facts.avgFuelPerLap !== null) {
      bits.push(ja ? `平均${facts.avgFuelPerLap.toFixed(2)}L/周`
                   : `${facts.avgFuelPerLap.toFixed(2)}L per lap`);
    }
    if (!bits.length) return '';
    const head = ja ? `前回${facts.date ? facts.date + 'の' : ''}${facts.track || ''}は`
                    : `Last time at ${facts.track || 'this track'}${facts.date ? ' on ' + facts.date : ''}: `;
    const tail = ja ? '。' : '.';
    const setup = facts.setupMatch === 'mismatch'
      ? (ja ? ' セットアップは前回と別。' : ' Setup differs from that run.')
      : '';
    return `${head}${bits.join(ja ? '、' : ', ')}${tail}${setup}`;
  }

  // ★スライス4（2026-08-25）setup の前後比較（正本 §5.4）。
  //
  // 実測すると、比較に必要な材料は**既に全部 pw_raceHistory にある**。
  // `setupFingerprint`（Bridge の SHA-256 先頭16桁）も `bestLap` も入っている。
  // 足りなかったのは「同一 track / car で fingerprint が違う2件を突き合わせて、
  // 次回 Practice で提示する」出口だけだった。
  //
  // 原則：
  //   - 数値は Bridge 実測（`bestLap`）だけ。SDK が出さない setup の中身は推測しない。
  //   - 本人申告は `source:'declared'` として**ラベルとしてのみ**持つ。
  //     申告文から数値を作らない（「1段柔らかく」を量として解釈しない）。
  //   - fingerprint が同じ2件は「別のsetup」ではないので比較しない。

  function setupComparison(history, identity, nowMs) {
    if (!Array.isArray(history) || !identity) return { available: false, reason: 'no_history' };
    const current = norm(identity.setupFingerprint);
    if (!current) return { available: false, reason: 'no_current_setup_fingerprint' };
    // identity 一致（track / car / series / user / 鮮度）は既存規約をそのまま使う。
    const matches = history.filter(record => matchesIdentity(record, identity, nowMs)
      && finite(record.bestLap) !== null && norm(record.setupFingerprint));
    if (!matches.length) return { available: false, reason: 'no_matching_record' };
    const same = matches.filter(r => norm(r.setupFingerprint) === current);
    const other = matches.filter(r => norm(r.setupFingerprint) !== current);
    if (!same.length || !other.length) {
      return { available: false, reason: 'no_setup_change_to_compare' };
    }
    const now = same[same.length - 1];
    const before = other[other.length - 1];
    const declared = now.setupDeclared || before.setupDeclared || null;
    return {
      available: true, reason: null,
      track: now.track || null,
      currentBestLap: finite(now.bestLap),
      previousBestLap: finite(before.bestLap),
      deltaS: finite(now.bestLap) - finite(before.bestLap),
      previousDate: String(before.date || '') || null,
      previousRaceRecordId: before.raceRecordId ? String(before.raceRecordId) : null,
      // 申告は出所を明示して持つ。SDK 実測と混ぜない。
      declaredLabel: declared && declared.label ? String(declared.label) : null,
      declaredSource: declared ? 'declared' : null,
      measuredSource: 'sdk',
    };
  }

  function setupComparisonLine(comparison, lang) {
    if (!comparison || !comparison.available) return '';
    const ja = isJP(lang);
    const delta = finite(comparison.deltaS);
    if (delta === null) return '';
    const abs = Math.abs(delta).toFixed(3);
    const better = delta < 0;
    const label = comparison.declaredLabel
      ? (ja ? `${comparison.declaredLabel}の申告のあと、` : `After your reported change (${comparison.declaredLabel}), `)
      : (ja ? 'セットアップを変えたあと、' : 'After the setup change, ');
    const body = ja
      ? `ベストは${abs}秒${better ? '速く' : '遅く'}なった。`
      : `your best lap was ${abs}s ${better ? 'quicker' : 'slower'}.`;
    return label + body;
  }

  // 本人申告を最新の記録へラベルとして貼る。数値は作らない。
  function attachSetupDeclaration(history, label, nowMs) {
    const out = Array.isArray(history) ? history.slice() : [];
    if (!out.length || !String(label || '').trim()) return { history: out, attached: false };
    const record = out[out.length - 1];
    record.setupDeclared = {
      label: String(label).trim().slice(0, 60),
      at: new Date(nowOrMs(nowMs)).toISOString(),
      source: 'declared',
    };
    return { history: out, attached: true };
  }
  function nowOrMs(ms) { return Number.isFinite(ms) ? ms : Date.now(); }

  // ★Phase 3：race record を持続記憶へ保存。Bridge pit event & official result を
  // 同一record へマージし、次セッションで再読込可能にする。
  //
  // 契約（「決定論」の出口）：
  //   - 入力: Bridge pit_events (array) + official_result_arrived (boolean) + metadata
  //   - 処理: identity 照合で既存 record 検索 → found なら merge、なければ新規作成
  //   - 出力: 同じhistoryを返すか、新規保存済みrecordを含むhistoryを返す
  //   - 保存先: caller が pw_raceHistory localStorage/IndexedDB へ責任を持つ
  //     （ここは格納logic のみ提供）
  //
  function mergeRaceRecord(existingRecord, bridgeData, nowMs) {
    if (!existingRecord || !bridgeData) return existingRecord;
    const merged = Object.assign({}, existingRecord);
    // pit_events: Bridge from raw pit data
    if (Array.isArray(bridgeData.pit_events) && bridgeData.pit_events.length > 0) {
      merged.pit_events = bridgeData.pit_events;
    }
    // official_result_arrived: Bridge from session final state
    if (typeof bridgeData.official_result_arrived === 'boolean') {
      merged.official_result_arrived = bridgeData.official_result_arrived;
    }
    // recordedAt: update if official result just arrived
    if (bridgeData.official_result_arrived && !existingRecord.official_result_arrived) {
      merged.recordedAt = new Date(nowMs || Date.now()).toISOString();
    }
    return merged;
  }

  function persistRaceRecord(history, newRecordFromBridge, identity, nowMs) {
    if (!newRecordFromBridge || !identity) return history || [];
    const now = nowMs || Date.now();
    // 既存record検索
    const existingIndex = (history || []).findIndex(r => matchesIdentity(r, identity, now));
    if (existingIndex >= 0) {
      // 既存を merge・上書き
      const merged = mergeRaceRecord(history[existingIndex], newRecordFromBridge, now);
      const updated = [...history];
      updated[existingIndex] = merged;
      return updated;
    } else {
      // 新規追加
      const fresh = Object.assign({}, newRecordFromBridge, {
        recordedAt: new Date(now).toISOString(),
      });
      return [...(history || []), fresh];
    }
  }

  return { isCurrentRecallQuestion, debriefFingerprint, historicalRequest, recallRace, compactRaceRecord, personalPastRecord, normalizeTrack:normTrack,matchesIdentity, selectPrevious, answerHistoricalWeather, answerPreviousFuel, briefingFacts, briefingLine, strategyFuelEvidence, fuelPlanningEvidence, fuelPlanningEstimate, strategyLapEvidence, isFreshRecord,
    setupComparison, setupComparisonLine, attachSetupDeclaration, mergeRaceRecord, persistRaceRecord };
}));
