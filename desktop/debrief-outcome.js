(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallDebriefOutcome = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // WO018：Plan結果・penalty・Driver訂正をdebriefへ。
  //
  // 事実の出所はBridgeの session_summary だけ：
  //   pit_events     … WO003 canonical DriverPitEvent（execution_relation／penalty証拠）
  //   plan_outcomes  … 同じrace/sessionのLifecycleがPlanをどう終えたか（executed/invalidated/cancelled＋理由）
  // ここでは再分類しない。fuel 0・Driver発話・停止時間からpenaltyを作らない。unknownはunknownのまま。
  // summaryと違うrace/sessionのpit・Planは捨てる（件数だけ残す）。
  // Driver訂正はcanonical事実を上書きせず、対象pitを一意に特定できた時だけ並記する。

  const RELATIONS = ['normal', 'early', 'penalty', 'unresolved'];
  const PHASES = ['executed', 'invalidated', 'cancelled', 'active', 'awaiting_driver'];
  const MAX_PITS = 12, MAX_PLANS = 16, MAX_CORRECTIONS = 8, NOTE_MAX = 160;
  const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

  const text = v => typeof v === 'string' && v.length > 0;
  const int = v => Number.isInteger(v);
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v, max) => (text(v) ? v.slice(0, max) : null);
  const isJa = lang => String(lang || '').toLowerCase().startsWith('ja');

  function pitView(e, race, session) {
    if (!e || typeof e !== 'object' || e.schema_version !== 1 || !text(e.pit_event_id)) return null;
    if (e.race_instance_id !== race || e.session_num !== session || !int(e.driver_pit_sequence)) return null;
    if (RELATIONS.indexOf(e.execution_relation) < 0) return null;
    const pen = e.penalty_evidence && typeof e.penalty_evidence === 'object' ? e.penalty_evidence : {};
    const entry = e.entry && typeof e.entry === 'object' ? e.entry : {};
    const exit = e.exit && typeof e.exit === 'object' ? e.exit : {};
    const ref = e.plan_reference && typeof e.plan_reference === 'object' ? e.plan_reference : null;
    return {
      pit_event_id: e.pit_event_id.slice(0, 200), driver_pit_sequence: e.driver_pit_sequence,
      entry_lap: int(e.entry_lap) ? e.entry_lap : (int(entry.lap) ? entry.lap : null),
      exit_lap: int(e.exit_lap) ? e.exit_lap : (int(exit.lap) ? exit.lap : null),
      relation: e.execution_relation,
      penalty_state: ['true', 'false', 'unknown'].indexOf(pen.state) >= 0 ? pen.state : 'unknown',
      fuel_added_l: num(e.service?.fuel_added_l ?? e.fuel_added_l),
      plan_ref: ref && text(ref.decision_id) ? { decision_id: ref.decision_id.slice(0, 200),
        selected_plan: str(ref.selected_plan, 8), target_lap: int(ref.target_lap) ? ref.target_lap : null } : null,
    };
  }

  // Lifecycleの直接遷移（normal/driver_early_pit/penalty_pit/pit_relation_unresolved等）は
  // plan_reference.decision_id==このPlanの時だけ起きる。pit側の参照が別decisionなら結合しない。
  // plan_referenceが無い／別Planのpitでも、frame・sequence証拠だけで失効させる間接結合の理由。
  const INDIRECT_REASONS = ['pit_relation_unbound', 'pit_before_plan_activation', 'pit_order_ambiguous'];
  function pitLinks(r, p) {
    if (!p || p.relation !== r.execution_relation) return false;
    // executedは必ず解決したpit sequenceを持つ。持っているなら一致が必要。
    if (int(r.resolved_pit_sequence) && r.resolved_pit_sequence !== p.driver_pit_sequence) return false;
    if (r.phase === 'executed' && !int(r.resolved_pit_sequence)) return false;
    const refDecision = p.plan_ref ? p.plan_ref.decision_id : null;
    if (refDecision === r.decision_id) return true;
    // 別decision（または参照無し）のpitへは、間接結合の理由を持つ非executedだけ。直接遷移の理由は結合しない。
    if (r.phase === 'executed') return false;
    return INDIRECT_REASONS.indexOf(r.reason) >= 0;
  }
  function referenceView(v) {
    if (!v || v.contract !== 'provisional_history_v1') return null;
    const keys=['command_id','evidence_version','source_snapshot_id'];
    if(keys.some(k=>!text(v[k])||v[k].length>512)) return null;
    if(!(num(v.rate_l_per_lap)>0&&v.rate_l_per_lap<50&&num(v.pace_s)>20&&v.pace_s<2000
        &&(v.planning_pace_s===undefined||num(v.planning_pace_s)!==null&&v.planning_pace_s>20&&v.planning_pace_s<=v.pace_s)
        &&(v.planning_rate_l_per_lap===undefined||num(v.planning_rate_l_per_lap)!==null&&v.planning_rate_l_per_lap>=v.rate_l_per_lap&&v.planning_rate_l_per_lap<50)
        &&int(v.record_count)&&v.record_count>0&&v.record_count<=500
        &&Array.isArray(v.record_ids)&&v.record_ids.length>0&&v.record_ids.length<=32
        &&v.record_ids.every(x=>text(x)&&x.length<=512)
        &&new Set(v.record_ids).size===v.record_ids.length
        &&(v.record_ids_truncated===true?v.record_count>v.record_ids.length:v.record_count===v.record_ids.length)
        &&num(v.predicted_add_fuel_l)!==null&&v.predicted_add_fuel_l>=0
        &&num(v.set_fuel_l)!==null&&v.set_fuel_l>=0)) return null;
    return {contract:v.contract,command_id:v.command_id,evidence_version:v.evidence_version,
      source_snapshot_id:v.source_snapshot_id,rate_l_per_lap:v.rate_l_per_lap,pace_s:v.pace_s,
      ...(v.planning_rate_l_per_lap===undefined?{}:{planning_rate_l_per_lap:v.planning_rate_l_per_lap}),
      ...(v.planning_pace_s===undefined?{}:{planning_pace_s:v.planning_pace_s}),
      record_count:v.record_count,record_ids:v.record_ids.slice(),record_ids_truncated:v.record_ids_truncated===true,
      predicted_add_fuel_l:v.predicted_add_fuel_l,set_fuel_l:v.set_fuel_l};
  }

  function planView(r, race, session, pitsById) {
    if (!r || typeof r !== 'object' || !text(r.decision_id)) return null;
    if (r.race_instance_id !== race || r.session_num !== session) return null;
    if (PHASES.indexOf(r.phase) < 0) return null;
    const terminal = ['executed', 'invalidated', 'cancelled'].indexOf(r.phase) >= 0;
    let pit = null, pitLink = 'none';
    if (text(r.terminal_pit_event_id)) {
      const p = pitsById[r.terminal_pit_event_id];
      // Plan↔pitは同じsummary内pitで、relation・解決sequence・decision参照（直接遷移）が一致する時だけ結合する。
      if (pitLinks(r, p)) { pit = p.pit_event_id; pitLink = 'linked'; }
      else pitLink = 'missing';
    }
    return {
      decision_id: r.decision_id.slice(0, 200), revision: int(r.revision) ? r.revision : null,
      selected_plan: str(r.selected_plan, 8), target_lap: int(r.target_lap) ? r.target_lap : null,
      add_fuel_l:num(r.add_fuel_l),set_fuel_l:num(r.set_fuel_l),provisional_history:referenceView(r.provisional_history),
      phase: r.phase, terminal, reason: terminal ? str(r.reason, 200) : null,
      relation: RELATIONS.indexOf(r.execution_relation) >= 0 ? r.execution_relation : null,
      pit_event_id: pit, pit_link: pitLink,
      resolved_pit_sequence: int(r.resolved_pit_sequence) ? r.resolved_pit_sequence : null,
      after_pit_sequence: int(r.registered_driver_pit_sequence) && r.registered_driver_pit_sequence > 0
        ? r.registered_driver_pit_sequence : null,
    };
  }

  /** session_summary → 検証済みoutcome。identityが無い旧Bridgeのsummaryは unavailable。 */
  function fromSummary(summary) {
    const s = summary && typeof summary === 'object' ? summary : {};
    const race = s.race_instance_id, session = s.session_num;
    if (!text(race) || !int(session)) {
      return { schema: 1, available: false, reason: 'summary_identity_missing', race_instance_id: null,
        session_num: null, pits: [], plans: [], plans_available: false, rejected: { pits: 0, plans: 0 } };
    }
    const rawPits = Array.isArray(s.pit_events) ? s.pit_events : [];
    const pits = []; let rejectedPits = 0;
    for (const e of rawPits) {
      const v = pitView(e, race, session);
      if (v && !pits.some(p => p.pit_event_id === v.pit_event_id)) pits.push(v); else rejectedPits += 1;
    }
    pits.sort((a, b) => a.driver_pit_sequence - b.driver_pit_sequence);
    const pitsById = {}; pits.forEach(p => { pitsById[p.pit_event_id] = p; });
    const po = s.plan_outcomes && typeof s.plan_outcomes === 'object' ? s.plan_outcomes : null;
    const plansAvailable = !!(po && po.available === true && Array.isArray(po.records));
    const plans = []; let rejectedPlans = 0;
    if (plansAvailable) {
      for (const r of po.records) {
        const v = planView(r, race, session, pitsById);
        if (v) plans.push(v); else rejectedPlans += 1;
      }
    }
    return {
      schema: 1, available: true, reason: null, race_instance_id: race.slice(0, 200), session_num: session,
      pits: pits.slice(0, MAX_PITS), plans: plans.slice(-MAX_PLANS),
      plans_available: plansAvailable,
      plans_reason: plansAvailable ? null : (po && text(po.reason) ? po.reason.slice(0, 80) : 'plan_outcomes_missing'),
      rejected: { pits: rejectedPits, plans: rejectedPlans },
    };
  }

  // 保存済みoutcomeを再検証する（壊れた・改変されたlocal記録をそのまま事実にしない）。
  function revalidate(stored) {
    if (!stored || stored.schema !== 1 || stored.available !== true) return null;
    const pits = (Array.isArray(stored.pits) ? stored.pits : []).map(p => p && Object.assign({ schema_version: 1,
      race_instance_id: stored.race_instance_id, session_num: stored.session_num, execution_relation: p.relation,
      penalty_evidence: { state: p.penalty_state }, plan_reference: p.plan_ref }, p));
    const plans = (Array.isArray(stored.plans) ? stored.plans : []).map(r => r && Object.assign({
      race_instance_id: stored.race_instance_id, session_num: stored.session_num, execution_relation: r.relation,
      terminal_pit_event_id: r.pit_event_id, registered_driver_pit_sequence: r.after_pit_sequence }, r));
    const out = fromSummary({ race_instance_id: stored.race_instance_id, session_num: stored.session_num,
      pit_events: pits, plan_outcomes: { available: stored.plans_available === true, reason: stored.plans_reason, records: plans } });
    return out.available ? out : null;
  }

  const sameSource = (a, b) => !!(a && b && a.available && b.available
    && a.race_instance_id === b.race_instance_id && a.session_num === b.session_num);

  // ── Driver訂正 ────────────────────────────────────────────────
  function lapMentioned(t) {
    const m = String(t).match(/(\d{1,3})\s*(?:周目|周|ラップ)|\blap\s*(\d{1,3})\b/i);
    return m ? Number(m[1] || m[2]) : null;
  }
  function claimOf(t) {
    const s = String(t || '');
    if (/(?:ペナ(?:ルティ)?|penalty).{0,8}(?:じゃな|ではな|でもな|違う|ちゃう|なかった|無かった)|(?:not|wasn'?t|was\s+not|no)\s+(?:a\s+)?penalty/i.test(s)) return 'not_penalty';
    if (/(?:早め|前倒し).{0,6}(?:じゃな|ではな|違う)|not\s+early|wasn'?t\s+early/i.test(s)) return 'not_early';
    // 否定は肯定より先に見る（「予定どおりじゃなかった」「It was not planned」を予定どおりと読まない）。
    if (/(?:予定|計画|プラン)(?:どおり|通り)(?:じゃな|じゃ無|ではな|でもな|ではありませ|にいかな|には?いかな)|(?:予定|計画)外|(?:was\s+not|wasn'?t|not)\s+(?:the\s+)?plan(?:ned)?|not\s+on\s+plan|off\s+plan|unplanned/i.test(s)) return 'not_planned';
    if (/(?:予定|計画|プラン)(?:どおり|通り)|(?:was|it\s+was)\s+(?:the\s+)?plan(?:ned)?|on\s+plan/i.test(s)) return 'planned';
    if (/(?:ペナ(?:ルティ)?|penalty)(?:だった|でした|消化|を受けた)|(?:was|it\s+was)\s+a\s+penalty|served\s+(?:a\s+|the\s+)?penalty/i.test(s)) return 'penalty';
    if (/(?:早め|前倒し|先に入)(?:だった|に入った|で入った)|(?:came|pitted|boxed)\s+(?:in\s+)?early/i.test(s)) return 'early';
    return null;
  }
  // claimと衝突するcanonical relation（訂正の対象）と、同意とみなすrelation。
  const CLAIM_TARGET = { not_penalty: ['penalty'], not_early: ['early'], not_planned: ['normal'],
    planned: ['early', 'penalty', 'unresolved'], penalty: ['normal', 'early', 'unresolved'], early: ['normal', 'unresolved'] };
  const CLAIM_AGREES = { not_penalty: [], not_early: [], not_planned: ['early', 'penalty'],
    planned: ['normal'], penalty: ['penalty'], early: ['early'] };
  const NEGATIONS = ['not_penalty', 'not_early', 'not_planned'];
  function isWithdraw(t) {
    return /(?:訂正|申告).{0,6}(?:取り消|取消|撤回|なし|無し|やめ)|(?:withdraw|cancel|undo)\s+(?:the\s+|my\s+)?correction/i.test(String(t || ''));
  }

  /**
   * debrief中の発話がpit分類への訂正か。一意に特定できた時だけ記録対象を返す。
   * @returns null（訂正ではない）| {status:'ambiguous'|'no_target'} | {status:'recorded', correction}
   */
  // focusPitId：周回を言わない回答が指すpit（今のcanonical質問が聞いているpit）。無ければnull。
  function parseCorrection(textIn, outcome, nowMs, focusPitId) {
    const claim = claimOf(textIn);
    if (!claim || !outcome || !outcome.available) return null;
    const lap = lapMentioned(textIn);
    // 対象：周回指定→そのpit。否定（〜じゃない）は否定したrelationを持つ全pit。肯定は今の質問のpit、無ければ全pit。
    let scoped = outcome.pits;
    if (lap !== null) scoped = outcome.pits.filter(p => p.entry_lap === lap);
    else if (NEGATIONS.indexOf(claim) < 0 && focusPitId) scoped = outcome.pits.filter(p => p.pit_event_id === focusPitId);
    const agrees = scoped.filter(p => CLAIM_AGREES[claim].indexOf(p.relation) >= 0);
    const candidates = scoped.filter(p => CLAIM_TARGET[claim].indexOf(p.relation) >= 0);
    // 衝突するpitが無い＝Bridge記録と一致する回答か無関係な回答。訂正として横取りしない。
    if (!candidates.length) return null;
    // 同意し得るpitと訂正し得るpitが両方ある＝対象未確定。どちらかを黙って選ばず聞き返す。
    if (agrees.length) return { status: 'ambiguous', claim, laps: scoped.map(p => p.entry_lap) };
    if (candidates.length > 1) return { status: 'ambiguous', claim, laps: candidates.map(p => p.entry_lap) };
    const p = candidates[0];
    return { status: 'recorded', correction: {
      kind: 'pit_relation', race_instance_id: outcome.race_instance_id, session_num: outcome.session_num,
      pit_event_id: p.pit_event_id, entry_lap: p.entry_lap, canonical_relation: p.relation,
      driver_claim: claim, status: 'driver_disputed',
      note: String(textIn || '').trim().slice(0, NOTE_MAX),
      at: new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString(),
    } };
  }
  function applyCorrection(corrections, correction) {
    const list = (Array.isArray(corrections) ? corrections : []).filter(c => c && c.pit_event_id !== correction.pit_event_id);
    list.push(correction);
    return list.slice(-MAX_CORRECTIONS);
  }
  function withdrawLast(corrections) {
    const list = Array.isArray(corrections) ? corrections.slice() : [];
    const removed = list.pop() || null;
    return { corrections: list, removed };
  }
  // 保存・再読込時：同じoutcomeのpitを指す訂正だけ残す（別race・消えたpitへの訂正を持ち越さない）。
  function sanitizeCorrections(corrections, outcome) {
    if (!outcome || !outcome.available) return [];
    const ids = new Set(outcome.pits.map(p => p.pit_event_id));
    return (Array.isArray(corrections) ? corrections : []).filter(c => c && c.kind === 'pit_relation'
      && c.race_instance_id === outcome.race_instance_id && c.session_num === outcome.session_num
      && ids.has(c.pit_event_id) && Object.keys(CLAIM_TARGET).indexOf(c.driver_claim) >= 0
      && c.status === 'driver_disputed').map(c => ({
      kind: 'pit_relation', race_instance_id: c.race_instance_id, session_num: c.session_num,
      pit_event_id: String(c.pit_event_id).slice(0, 200), entry_lap: int(c.entry_lap) ? c.entry_lap : null,
      canonical_relation: RELATIONS.indexOf(c.canonical_relation) >= 0 ? c.canonical_relation : null,
      driver_claim: c.driver_claim, status: 'driver_disputed', note: String(c.note || '').slice(0, NOTE_MAX),
      at: text(c.at) ? c.at.slice(0, 40) : null,
    })).slice(-MAX_CORRECTIONS);
  }

  // ── 出力 ──────────────────────────────────────────────────────
  const RELATION_WORD = {
    ja: { normal: '予定どおり', early: '早めのピット', penalty: 'ペナルティ（black flag確認）', unresolved: '分類不明' },
    en: { normal: 'as planned', early: 'early stop', penalty: 'penalty (black flag confirmed)', unresolved: 'unclassified' },
  };
  const CLAIM_WORD = {
    ja: { not_penalty: 'ペナルティではない', not_early: '早めではない', not_planned: '予定外だった', planned: '予定どおりだった', penalty: 'ペナルティだった', early: '早めに入った' },
    en: { not_penalty: 'not a penalty', not_early: 'not early', not_planned: 'it was not planned', planned: 'it was planned', penalty: 'it was a penalty', early: 'came in early' },
  };
  function reasonWord(reason, lang) {
    const ja = isJa(lang), r = String(reason || '');
    const table = ja
      ? { normal: '実行', driver_early_pit: '失効：早めのピット', driver_early_pit_declared: '失効：ドライバーの早めピット宣言',
          driver_plan_amended: '失効：ドライバーが周回を変更', penalty_pit: '失効：ペナルティピット',
          pit_relation_unresolved: '失効：ピット分類不明', session_end: '未実行のままレース終了',
          race_identity_changed: '別raceへ切替で終了', driver_cancel: 'ドライバーが取消',
          pit_before_plan_activation: '失効：合意前にピット', pit_sequence_mismatch: '失効：予定外のピット' }
      : { normal: 'executed', driver_early_pit: 'invalidated by early stop', driver_early_pit_declared: 'invalidated by the driver\'s early-stop call',
          driver_plan_amended: 'invalidated by the driver\'s lap change', penalty_pit: 'invalidated by penalty stop',
          pit_relation_unresolved: 'invalidated: stop unclassified', session_end: 'not executed before the finish',
          race_identity_changed: 'ended by race change', driver_cancel: 'cancelled by driver',
          pit_before_plan_activation: 'invalidated: stop before agreement', pit_sequence_mismatch: 'invalidated: unplanned stop' };
    if (table[r]) return table[r];
    if (/^superseded_by:/.test(r)) return null;               // 合意前の内部置換は振り返り行にしない
    return ja ? `終了（${r || '理由不明'}）` : `ended (${r || 'reason unknown'})`;
  }
  const pitNo = (outcome, id) => { const p = outcome.pits.find(x => x.pit_event_id === id); return p ? p.driver_pit_sequence : null; };

  function lines(outcome, corrections, decisionNotes, lang) {
    if (!outcome || !outcome.available) return [];
    const ja = isJa(lang), W = RELATION_WORD[ja ? 'ja' : 'en'], C = CLAIM_WORD[ja ? 'ja' : 'en'];
    const out = [];
    for (const p of outcome.pits) {
      const lap = p.entry_lap !== null ? (ja ? `${p.entry_lap}周目` : `L${p.entry_lap}`) : (ja ? '周回不明' : 'lap unknown');
      let s = `Pit ${p.driver_pit_sequence} · ${lap} · ${W[p.relation]}`;
      if (p.relation === 'early' && p.plan_ref && p.plan_ref.target_lap !== null) {
        s += ja ? `（予定Plan ${p.plan_ref.selected_plan || '?'}は${p.plan_ref.target_lap}周目）`
                : ` (Plan ${p.plan_ref.selected_plan || '?'} was lap ${p.plan_ref.target_lap})`;
      }
      const c = (corrections || []).find(x => x.pit_event_id === p.pit_event_id);
      if (c) s += ja ? ` ／ Driver訂正：${C[c.driver_claim]}（Bridge記録は維持）` : ` / Driver disputes: ${C[c.driver_claim]} (Bridge record kept)`;
      out.push(s);
    }
    if (!outcome.plans_available) {
      out.push(ja ? 'Plan結果：Bridge記録なし（推測しない）' : 'Plan outcome: no Bridge record (not inferred)');
    }
    for (const r of outcome.plans) {
      const word = r.terminal ? reasonWord(r.reason, lang) : (ja ? '終了時点で未実行' : 'still open at the summary');
      if (!word) continue;
      const head = `Plan ${r.selected_plan || '?'}` + (r.target_lap !== null ? (ja ? `（${r.target_lap}周目）` : ` (lap ${r.target_lap})`) : '')
        + (r.after_pit_sequence ? (ja ? `［Pit ${r.after_pit_sequence}後に再計算］` : ` [recalculated after pit ${r.after_pit_sequence}]`) : '');
      const n = r.pit_event_id ? pitNo(outcome, r.pit_event_id) : null;
      let s = `${head} → ${word}` + (n ? ` (Pit ${n})` : '');
      const d = (decisionNotes || []).find(x => x.decision_id === r.decision_id);
      // Driverが判断記録を削除した → その判断を次の根拠として出さない（pitの測定事実は残す）。
      if (d && d.status === 'deleted') continue;
      const ref=r.provisional_history;
      if(ref){
        const pit=r.pit_event_id?outcome.pits.find(p=>p.pit_event_id===r.pit_event_id):null;
        s += ja ? ` ／ 履歴${ref.record_count}件・${ref.rate_l_per_lap.toFixed(2)}L/周・${ref.pace_s.toFixed(1)}秒/周、予測追加${ref.predicted_add_fuel_l.toFixed(1)}L・設定${ref.set_fuel_l}L`
          : ` / ${ref.record_count} history records, ${ref.rate_l_per_lap.toFixed(2)} L/lap, ${ref.pace_s.toFixed(1)} s/lap; predicted add ${ref.predicted_add_fuel_l.toFixed(1)} L, set ${ref.set_fuel_l} L`;
        if(ref.planning_pace_s<ref.pace_s)s += ja ? `・当日計測により${ref.planning_pace_s.toFixed(1)}秒/周で計画` : `; planned at measured ${ref.planning_pace_s.toFixed(1)} s/lap`;
        if(ref.planning_rate_l_per_lap>ref.rate_l_per_lap)s += ja ? `・当日計測により${ref.planning_rate_l_per_lap.toFixed(2)}L/周で計画` : `; planned at measured ${ref.planning_rate_l_per_lap.toFixed(2)} L/lap`;
        if(pit&&pit.fuel_added_l!==null)s += ja ? `・実補給${pit.fuel_added_l.toFixed(1)}L` : `; actual added ${pit.fuel_added_l.toFixed(1)} L`;
        s += ` [decision=${r.decision_id}; sources=${ref.record_ids.slice(0,3).join(',')}${ref.record_ids.length>3?',…':''}]`;
      }
      if (d) s += d.status === 'disputed'
        ? (ja ? ' ／ Driver訂正：この判断記録は保留中' : ' / Driver disputed this decision record')
        : (ja ? ` ／ Driver訂正済み${d.outcome ? '：' + d.outcome : ''}` : ` / Driver-corrected${d.outcome ? ': ' + d.outcome : ''}`);
      out.push(s);
    }
    return out;
  }

  // 最初の一問が聞いているpit（firstQuestionと同じ優先順位）。分類不明があれば聞かない＝null。
  function questionFocus(outcome) {
    if (!outcome || !outcome.available || !outcome.pits.length) return null;
    const pick = rel => outcome.pits.find(p => p.relation === rel);
    const p = pick('penalty') || pick('early') || (outcome.pits.some(x => x.relation === 'unresolved') ? null : pick('normal'));
    return p ? p.pit_event_id : null;
  }
  // 最初の一問。Bridgeが分類済みの停止をDriverに分類させない。
  function firstQuestion(outcome, lang) {
    if (!outcome || !outcome.available || !outcome.pits.length) return null;
    const ja = isJa(lang);
    const pen = outcome.pits.find(p => p.relation === 'penalty');
    if (pen) {
      return ja ? `${pen.entry_lap ?? '?'}周目の停止はペナルティだった。何がきっかけでペナルティを受けた？`
                : `The lap ${pen.entry_lap ?? '?'} stop was a penalty. What led to it?`;
    }
    const early = outcome.pits.find(p => p.relation === 'early');
    if (early) {
      const tgt = early.plan_ref && early.plan_ref.target_lap !== null ? early.plan_ref.target_lap : null;
      return ja ? `${early.entry_lap ?? '?'}周目に${tgt !== null ? `予定の${tgt}周目より` : ''}早く入った。早めた理由は何だった？`
                : `You stopped on lap ${early.entry_lap ?? '?'}${tgt !== null ? `, before the planned lap ${tgt}` : ''}. What made you come in early?`;
    }
    if (outcome.pits.some(p => p.relation === 'unresolved')) return null;   // 分類不明は従来の質問で本人に聞く
    const normal = outcome.pits.find(p => p.relation === 'normal');
    return normal ? (ja ? `${normal.entry_lap ?? '?'}周目のピットは予定どおり実行できた。タイミングと復帰の手応えはどうだった？`
                        : `The lap ${normal.entry_lap ?? '?'} stop ran to plan. How did the timing and rejoin feel?`) : null;
  }

  // 次回参照：前回race（同本人・別race・90日以内）のoutcomeを1行に要約する。
  // decisionNotes：呼び出し時点の判断台帳（同本人・同race）の正本から作ったdispute/correction/delete。
  //   保存済みコピーに残る古い判断を、台帳での異議・訂正・削除後も出し続けないため毎回渡す。
  function historicalLine(record, currentRace, ownerRef, nowMs, lang, decisionNotes) {
    if (!record || !text(ownerRef) || record.owner_ref !== ownerRef) return '';
    const outcome = revalidate(record.race_outcome);
    if (!outcome) return '';
    if (currentRace && text(currentRace.race_instance_id) && outcome.race_instance_id === currentRace.race_instance_id) return '';
    const at = Date.parse(record.created_at || '');
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (!Number.isFinite(at) || now - at > MAX_AGE_MS || at > now + 5 * 60 * 1000) return '';
    const corr = sanitizeCorrections(record.outcome_corrections, outcome);
    const body = lines(outcome, corr, decisionNotes || [], lang).filter(s => !/^Plan結果：|^Plan outcome:/.test(s));
    return body.length ? body.join(' / ') : '';
  }

  function storable(outcome) {
    return outcome && outcome.available ? JSON.parse(JSON.stringify(outcome)) : null;
  }

  return { fromSummary, revalidate, sameSource, parseCorrection, applyCorrection, withdrawLast, isWithdraw,
    sanitizeCorrections, lines, firstQuestion, questionFocus, historicalLine, storable, MAX_AGE_MS };
}));
