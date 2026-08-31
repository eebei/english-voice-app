(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallDecisionMemory = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ★スライス2（2026-08-25）Decision ID の一生。
  //
  // 実測して分かったこと：Bridge は既に4段すべてを broadcast していた。
  //
  //   提案      radio/strategy_plan_decision   `decision_id` を持っていた
  //   pit exit  pit_timing + score_execution   **結合キーが無く採点を捨てていた**
  //   blend安定 pit_cycle_outcome              **同上**
  //   session終了 session_summary              **同上**
  //
  // つまり足りなかったのは計測ではなく **結合キーと台帳** だけ。
  // このモジュールがその台帳で、数字と採点を持つ唯一の場所。
  //
  // 原則（正本 §7 / §10）：
  //   - LLM は record も outcome も採用戦略も選ばない。ここが決定論で決める。
  //   - 根拠が無ければ `unknown`。推測で success / failure を付けない。
  //   - 成功例だけでなく失敗例も次回へ渡す。失敗は「勧めない理由」として使う。
  //   - 「それ違う」で即 `disputed`。本人合意まで再利用しない。
  //   - 条件が起きていない予測は採点しない（`PitCycleTracker` と同じ規律）。

  const MAX_RECORD_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  const MAX_RECORDS = 60;

  // 採点の閉じた集合。ここに無い文字列を outcome にしない。
  const OUTCOME_SUCCESS = 'success';
  const OUTCOME_TRAFFIC = 'traffic_failure';
  const OUTCOME_FUEL = 'fuel_failure';
  const OUTCOME_NOT_EXECUTED = 'not_executed';
  const OUTCOME_INCIDENT = 'incident_or_disconnect';
  const OUTCOME_UNKNOWN = 'unknown';
  const OUTCOMES = [OUTCOME_SUCCESS, OUTCOME_TRAFFIC, OUTCOME_FUEL,
    OUTCOME_NOT_EXECUTED, OUTCOME_INCIDENT, OUTCOME_UNKNOWN];

  const STATUS_OPEN = 'open';
  const STATUS_CLOSED = 'closed';
  const STATUS_DISPUTED = 'disputed';
  const STATUS_CORRECTED = 'corrected';

  // 出口の fate。黙った理由が必ず残るようにする（正本 §10）。
  const FATE_SPOKEN = 'spoken';
  const FATE_NOT_APPLICABLE = 'not_applicable_current_conditions';
  const FATE_DEFERRED = 'deferred_unsafe_driving_window';
  const FATE_STALE = 'discarded_stale';
  const FATE_MISSING = 'missing_required_evidence';

  // 計画より積まなかった量がこれを超えたら、順位低下の原因を燃料側とみなす。
  const FUEL_SHORTFALL_L = 1.0;

  const finite = value => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const intOrNull = value => {
    const n = finite(value);
    return n !== null && Number.isInteger(n) ? n : null;
  };
  const norm = value => String(value == null ? '' : value).trim().toLowerCase();
  const isJP = lang => String(lang || '').toLowerCase().startsWith('ja');
  const nowOr = ms => (Number.isFinite(ms) ? ms : Date.now());
  const list = store => (Array.isArray(store) ? store : []);

  function isFresh(record, nowMs) {
    const at = Date.parse(String((record && (record.updatedAt || record.recordedAt)) || ''));
    if (!Number.isFinite(at)) return false;
    const now = nowOr(nowMs);
    // 未来日時の cache も、90日より古い記録も、今日の判断材料にしない。
    return at <= now + 5 * 60 * 1000 && now - at <= MAX_RECORD_AGE_MS;
  }

  function find(store, decisionId) {
    const id = String(decisionId || '');
    if (!id) return null;
    return list(store).find(r => r && String(r.decision_id) === id) || null;
  }

  function trim(store) {
    while (store.length > MAX_RECORDS) store.shift();
    return store;
  }

  // ── 入口：提案 ────────────────────────────────────────────────
  // Bridge の `strategy_plan_decision` だけを出所にする。会話や推測から作らない。
  function appendProposal(store, event, identity, nowMs) {
    const out = list(store).slice();
    const plan = event && typeof event.decision_plan === 'object' ? event.decision_plan : null;
    const id = String((event && event.decision_id) || (plan && plan.decision_id) || '');
    if (!id || !plan) return { store: out, record: null, reason: 'missing_decision_evidence' };
    const now = nowOr(nowMs);
    const iso = new Date(now).toISOString();
    const existing = find(out, id);
    if (existing) return { store: out, record: existing, reason: 'already_open' };
    const record = {
      decision_id: id,
      userId: identity && identity.userId !== undefined ? identity.userId : null,
      track: (identity && identity.track) || null,
      car: (identity && (identity.car || identity.carClass)) || null,
      carClass: (identity && identity.carClass) || null,
      seriesId: intOrNull(identity && identity.seriesId),
      setupFingerprint: (identity && identity.setupFingerprint) || null,
      raceFormat: (identity && identity.raceFormat) || null,
      sessionNum: intOrNull(plan.session_num),
      date: iso.slice(0, 10),
      recordedAt: iso,
      updatedAt: iso,
      status: STATUS_OPEN,
      outcome: OUTCOME_UNKNOWN,
      deleted: false,
      proposal: {
        selected_plan: plan.selected_plan || null,
        reason: plan.reason || null,
        decided_at_lap: intOrNull(plan.decided_at_lap),
        entry_class_position: intOrNull(plan.entry_class_position),
        target_lap: intOrNull(plan.target_lap),
        add_fuel_l: finite(plan.add_fuel_l),
        conditions: {
          fuel_window_open: (plan.conditions && plan.conditions.fuel_window_open) === true ? true
            : (plan.conditions && plan.conditions.fuel_window_open) === false ? false : null,
          relative_pace_advantage_s: finite(plan.conditions && plan.conditions.relative_pace_advantage_s),
          rejoin_not_worse: (plan.conditions && plan.conditions.rejoin_not_worse) === true ? true
            : (plan.conditions && plan.conditions.rejoin_not_worse) === false ? false : null,
        },
      },
      execution: null, blend: null, closure: null, dispute: null,
    };
    out.push(record);
    return { store: trim(out), record, reason: 'opened' };
  }

  // ── 入口：pit exit（実行された事実）────────────────────────────
  function appendExecution(store, event, nowMs) {
    const out = list(store).slice();
    const record = find(out, event && event.decision_id);
    if (!record) return { store: out, record: null, reason: 'no_open_decision' };
    const score = event && typeof event.strategy_option_score === 'object' ? event.strategy_option_score : {};
    record.execution = {
      executed_plan: score.executed_plan || null,
      actual_entry_lap: intOrNull(score.actual_entry_lap),
      entry_lap_error: intOrNull(score.entry_lap_error),
      planned_add_fuel_l: finite(score.planned_add_fuel_l),
      actual_fuel_added_l: finite(score.actual_fuel_added_l !== undefined ? score.actual_fuel_added_l : (event && event.sample && event.sample.fuel_added_l)),
      fuel_add_error_l: finite(score.fuel_add_error_l),
      pos_in: intOrNull(event && event.pos_in),
      pos_out: intOrNull(event && event.pos_out),
      lane_total_s: finite(event && event.pit_lane_sec),
      // GT Sprint／IMSA Fixed のアンダーカット答え合わせ用。無い値は null のまま
      // にして、順位だけから成功を推測しない。
      forward_pack_size: intOrNull(event && event.forward_pack_size),
      rejoin_traffic_state: event && event.rejoin_traffic_state
        ? String(event.rejoin_traffic_state).slice(0, 40) : null,
    };
    record.updatedAt = new Date(nowOr(nowMs)).toISOString();
    record.outcome = score_(record);
    return { store: out, record, reason: 'executed' };
  }

  // ── 入口：blend 安定（その判断が効いたのかの答え）─────────────
  function appendBlend(store, event, nowMs) {
    const out = list(store).slice();
    const record = find(out, event && event.decision_id);
    if (!record) return { store: out, record: null, reason: 'no_open_decision' };
    const o = event && typeof event.outcome === 'object' ? event.outcome : {};
    record.blend = {
      physical_exit_position: intOrNull(o.physical_exit_position),
      post_cycle_actual_position: intOrNull(o.post_cycle_actual_position),
      conditional_cycle_position: intOrNull(o.conditional_cycle_position),
      condition_met: o.condition_met === true,
      closed_reason: o.closed_reason || null,
      rival_pit_timestamps: Array.isArray(o.rival_pit_timestamps)
        ? o.rival_pit_timestamps.slice(0, 24).map(item => ({
            session_id: item && item.session_id != null ? String(item.session_id).slice(0, 80) : null,
            class_position: intOrNull(item && item.class_position),
            pit_entry_lap: intOrNull(item && item.pit_entry_lap),
            pit_entry_time_s: finite(item && item.pit_entry_time_s),
          })) : [],
    };
    record.updatedAt = new Date(nowOr(nowMs)).toISOString();
    record.outcome = score_(record);
    return { store: out, record, reason: 'blended' };
  }

  // ── 入口：session 終了（DNF・切断・途中終了も同じ id へ）───────
  function appendClosure(store, event, nowMs) {
    const out = list(store).slice();
    const record = find(out, (event && (event.active_decision_id || event.decision_id)));
    if (!record) return { store: out, record: null, reason: 'no_open_decision' };
    record.closure = {
      finish_pos: intOrNull(event && event.finish_pos),
      finish_pos_confirmed: (event && event.finish_pos_confirmed) === true,
      total_laps: intOrNull(event && event.total_laps),
      incidents: intOrNull(event && event.incidents),
      reason: String((event && event.closure_reason) || 'session_ended'),
    };
    record.status = STATUS_CLOSED;
    record.updatedAt = new Date(nowOr(nowMs)).toISOString();
    record.outcome = score_(record);
    return { store: out, record, reason: 'closed' };
  }

  // ── 採点（決定論・閉じた enum）────────────────────────────────
  function score_(record) {
    if (!record) return OUTCOME_UNKNOWN;
    const exec = record.execution;
    const blend = record.blend;
    const closure = record.closure;

    // 切断・事故で終わった判断は、実行の有無に関わらず採点材料を失っている。
    if (closure && /disconnect|abandon|incident/i.test(String(closure.reason || ''))) {
      return OUTCOME_INCIDENT;
    }
    // 提案したが実行されなかった。失敗ではないので、次回の非推奨材料にしない。
    if (!exec) return closure ? OUTCOME_NOT_EXECUTED : OUTCOME_UNKNOWN;

    if (!blend) return OUTCOME_UNKNOWN;
    // 条件付き予測は、その条件が実際に起きた時だけ採点できる。
    // 部分的なパック停止は「予測の誤り」ではなく単なる証拠不足。
    if (!blend.condition_met) return OUTCOME_UNKNOWN;

    const before = record.proposal ? record.proposal.entry_class_position : null;
    const entry = exec.pos_in !== null ? exec.pos_in : before;
    const after = blend.post_cycle_actual_position;
    if (entry === null || after === null) return OUTCOME_UNKNOWN;

    if (after < entry) return OUTCOME_SUCCESS;      // 順位は小さいほど前
    if (after > entry) {
      const shortfall = exec.fuel_add_error_l;
      // 計画より積まずに順位を落としたなら、原因は traffic ではなく燃料側。
      if (shortfall !== null && shortfall <= -FUEL_SHORTFALL_L) return OUTCOME_FUEL;
      return OUTCOME_TRAFFIC;
    }
    // 同順位維持は、成功とも失敗とも証明できない。推測しない。
    return OUTCOME_UNKNOWN;
  }

  // ── 訂正・削除 ───────────────────────────────────────────────
  // 「それ違う」は即時に利用停止。本人合意まで訂正を有効化しない。
  function dispute(store, decisionId, note, nowMs) {
    const out = list(store).slice();
    const record = find(out, decisionId);
    if (!record) return { store: out, record: null, reason: 'decision_not_found' };
    record.status = STATUS_DISPUTED;
    record.dispute = {
      at: new Date(nowOr(nowMs)).toISOString(),
      note: note ? String(note) : null,
      resolved_at: null, correction: null,
    };
    record.updatedAt = new Date(nowOr(nowMs)).toISOString();
    return { store: out, record, reason: 'disputed' };
  }

  // 一度だけ読み返して確認する文。合意が取れるまで訂正は効かない。
  function readbackLine(record, lang) {
    if (!record) return '';
    const ja = isJP(lang);
    const p = record.proposal || {};
    const lap = p.decided_at_lap;
    const plan = p.selected_plan;
    if (lap === null || lap === undefined || !plan) {
      return ja ? '訂正したい記録を特定できない。どのレースのどの判断か教えて。'
                : 'I cannot identify the record to correct. Which race and which call?';
    }
    return ja ? `${lap}周目のPlan ${plan}の記録を止めた。これで合っている？`
              : `I have suspended the lap ${lap} Plan ${plan} record. Is that the right one?`;
  }

  // 本人合意後だけ訂正が効く。特定できない訂正は保存しない（推測しない）。
  function confirmCorrection(store, decisionId, correction, nowMs) {
    const out = list(store).slice();
    const record = find(out, decisionId);
    if (!record) return { store: out, record: null, reason: 'decision_not_found' };
    if (record.status !== STATUS_DISPUTED) {
      return { store: out, record, reason: 'not_disputed' };
    }
    const patch = correction && typeof correction === 'object' ? correction : null;
    if (!patch) return { store: out, record, reason: 'missing_correction' };
    const iso = new Date(nowOr(nowMs)).toISOString();
    if (patch.actual_entry_lap !== undefined && record.execution) {
      record.execution.actual_entry_lap = intOrNull(patch.actual_entry_lap);
      record.execution.corrected = true;
    }
    if (patch.decided_at_lap !== undefined && record.proposal) {
      record.proposal.decided_at_lap = intOrNull(patch.decided_at_lap);
    }
    if (patch.outcome !== undefined && OUTCOMES.indexOf(String(patch.outcome)) >= 0) {
      record.outcome = String(patch.outcome);
      record.outcomeSource = 'driver_correction';
    }
    record.status = STATUS_CORRECTED;
    record.dispute.resolved_at = iso;
    record.dispute.correction = patch;
    record.updatedAt = iso;
    return { store: out, record, reason: 'corrected' };
  }

  function remove(store, decisionId, nowMs) {
    const out = list(store).slice();
    const record = find(out, decisionId);
    if (!record) return { store: out, record: null, reason: 'decision_not_found' };
    record.deleted = true;
    record.updatedAt = new Date(nowOr(nowMs)).toISOString();
    return { store: out.filter(r => r !== record), record, reason: 'deleted' };
  }

  // ── 取得：翌回に使ってよい1件を決定論的に選ぶ ───────────────
  function usable(record, identity, nowMs) {
    if (!record || record.deleted) return false;
    if (record.status === STATUS_DISPUTED) return false;      // 訂正前は再利用しない
    if (!isFresh(record, nowMs)) return false;
    if (!identity) return false;
    if (!norm(identity.track) || norm(record.track) !== norm(identity.track)) return false;
    const wantUser = identity.userId;
    if (wantUser !== null && wantUser !== undefined && wantUser !== '') {
      if (String(record.userId === undefined ? '' : record.userId) !== String(wantUser)) return false;
    }
    const wantCar = norm(identity.car || identity.carClass);
    if (wantCar && norm(record.car || record.carClass) !== wantCar) return false;
    if (Number.isInteger(identity.seriesId)) {
      if (!Number.isInteger(record.seriesId) || identity.seriesId !== record.seriesId) return false;
    }
    if (identity.raceFormat && record.raceFormat && norm(identity.raceFormat) !== norm(record.raceFormat)) return false;
    return true;
  }

  /**
   * 次回ブリーフィングで使う1件。成功例と失敗例のどちらも候補にする。
   * `unknown` は根拠が足りないので選ばない（＝黙る理由が残る）。
   */
  function selectForBriefing(store, identity, nowMs) {
    const candidates = list(store).filter(r => usable(r, identity, nowMs)
      && (r.outcome === OUTCOME_SUCCESS || r.outcome === OUTCOME_TRAFFIC || r.outcome === OUTCOME_FUEL));
    if (!candidates.length) {
      const anyMatch = list(store).some(r => usable(r, identity, nowMs));
      return { available: false, reason: anyMatch ? FATE_MISSING : 'no_matching_record', record: null };
    }
    return { available: true, reason: null, record: candidates[candidates.length - 1] };
  }

  // ── 出口①：次回の自発発話 ───────────────────────────────────
  // 文面は事実からしか作らない。無ければ空文字＝言わない。
  function briefingLine(selection, lang) {
    if (!selection || !selection.available || !selection.record) return '';
    const r = selection.record;
    const ja = isJP(lang);
    const p = r.proposal || {};
    const start = p.entry_class_position;
    const lap = p.decided_at_lap;
    const after = r.blend ? r.blend.post_cycle_actual_position : null;
    const planWord = ja ? (p.selected_plan === 'B' ? 'アンダーカット' : '基準戦略')
                        : (p.selected_plan === 'B' ? 'the undercut' : 'the baseline plan');
    if (r.outcome === OUTCOME_SUCCESS) {
      if (start === null || lap === null || after === null) return '';
      return ja
        ? `前回はP${start}から${lap}周目に${planWord}、ブレンド後P${after}。今日も燃料ウィンドウと復帰trafficが揃えば候補にする。`
        : `Last time from P${start} we took ${planWord} on lap ${lap} and came out P${after} after the blend. If the fuel window and rejoin traffic line up today, it is a candidate again.`;
    }
    if (r.outcome === OUTCOME_TRAFFIC) {
      if (start === null || after === null) return '';
      return ja
        ? `前回は同じ${planWord}で復帰先のtrafficに捕まってP${start}からP${after}まで落ちた。今日も同条件なら早入りは勧めない。`
        : `Last time ${planWord} put us into rejoin traffic and we dropped from P${start} to P${after}. On the same conditions today I would not recommend stopping early.`;
    }
    if (r.outcome === OUTCOME_FUEL) {
      if (start === null || after === null) return '';
      return ja
        ? `前回は${planWord}で給油が計画に届かず、P${start}からP${after}。今日は必要量が積める周まで待つ。`
        : `Last time ${planWord} left us short of the planned fuel and we went from P${start} to P${after}. Today I want to wait until the full requirement fits.`;
    }
    return '';
  }

  // ── 出口②：今日の条件が成立した時だけ Plan の根拠へ採用する ───
  /**
   * @param today {fuelWindowOpen, relativePaceAdvantageS, rejoinNotWorse}
   * @returns {{fate, action, reply}} action: adopt | discourage | re_evaluate | none
   */
  function planAdvice(selection, today, lang) {
    const ja = isJP(lang);
    if (!selection || !selection.available || !selection.record) {
      return { fate: FATE_MISSING, action: 'none', reply: '' };
    }
    const r = selection.record;
    const t = today && typeof today === 'object' ? today : {};
    const windowOpen = t.fuelWindowOpen === true;
    const paceOk = finite(t.relativePaceAdvantageS) !== null && Number(t.relativePaceAdvantageS) > 0;
    const rejoinOk = t.rejoinNotWorse === true;
    const allMet = windowOpen && paceOk && rejoinOk;

    if (r.outcome === OUTCOME_SUCCESS) {
      if (!allMet) {
        // 過去の成功を、条件が揃わない今日の保証として話さない。
        return { fate: FATE_NOT_APPLICABLE, action: 'none', reply: '' };
      }
      return {
        fate: FATE_SPOKEN, action: 'adopt',
        reply: ja ? '前回と同じ条件が揃った。前回効いた早入れを今日の候補に戻す。'
                  : 'The same conditions have lined up. I am putting the early stop that worked last time back on the table.',
      };
    }
    if (r.outcome === OUTCOME_TRAFFIC || r.outcome === OUTCOME_FUEL) {
      // 失敗した条件が変わったなら、失敗記録で永久に封じない。
      if (rejoinOk && windowOpen) {
        return {
          fate: FATE_SPOKEN, action: 're_evaluate',
          reply: ja ? '前回詰まった復帰先が今日は空いている。早入れを見直す。'
                    : 'The rejoin that trapped us last time is clear today. I am re-evaluating the early stop.',
        };
      }
      return {
        fate: FATE_SPOKEN, action: 'discourage',
        reply: ja ? '前回と同じ条件なので早入れは勧めない。復帰先が空くなら見直す。'
                  : 'Conditions match the run that failed, so I would not stop early. If the rejoin clears I will re-evaluate.',
      };
    }
    return { fate: FATE_MISSING, action: 'none', reply: '' };
  }

  return {
    OUTCOME_SUCCESS, OUTCOME_TRAFFIC, OUTCOME_FUEL, OUTCOME_NOT_EXECUTED,
    OUTCOME_INCIDENT, OUTCOME_UNKNOWN, OUTCOMES,
    STATUS_OPEN, STATUS_CLOSED, STATUS_DISPUTED, STATUS_CORRECTED,
    FATE_SPOKEN, FATE_NOT_APPLICABLE, FATE_DEFERRED, FATE_STALE, FATE_MISSING,
    MAX_RECORD_AGE_MS, FUEL_SHORTFALL_L,
    appendProposal, appendExecution, appendBlend, appendClosure,
    score: score_, dispute, readbackLine, confirmCorrection, remove,
    usable, selectForBriefing, briefingLine, planAdvice, find, isFresh,
  };
}));
