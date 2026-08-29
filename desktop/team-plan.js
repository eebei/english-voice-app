(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallTeamPlan = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ★2026-08-29 Team Plan（ブリーフィング→実測→引き継ぎ→レース後）
  //
  // 実測して分かった欠陥：Luna は訂正に「了解」と答えるだけで、合意内容が
  // どこにも構造化されて残らなかった。だから
  //   ・交代先の PC には fuel/next pit しか届かない
  //   ・レース後に「誰が何周・何秒だったか」を確定値で答えられない
  //   ・「はい」一つで戦略が変わったように見えて、実際は何も変わっていない
  // という三重の断絶が起きていた。ここが Plan の唯一の台帳。
  //
  // 規律（AGENTS.md Tunnel Completion Rule）：
  //   - confirmed になるのは **人間の明示確認だけ**。曖昧語では絶対に変えない。
  //   - 実測（Bridge）は candidate を作れるが confirmed を上書きしない。
  //   - 欠損は null のまま。0 や推測値へ化かさない（incidents も同じ）。
  //   - 引き継ぎに載せるのは confirmed のみ。candidate を確定事実として渡さない。
  //   - 「北コースは残70%なら交換不要」のような固定ルールを持たない。
  //     揃っていない材料での判断は `insufficient_evidence` で止める。

  const SCHEMA = 'team_plan_v1';
  const MIN_CLEAN_LAPS = 3;          // 実測燃費を採用する最小クリーン周数
  const PIT_WINDOW_TOLERANCE_LAPS = 1; // これ以下のズレは「維持」
  const MAX_LOG = 40;

  // Plan が持つ確定項目。ここに無いキーは保存しない（自由文の垂れ流し防止）。
  const FIELDS = Object.freeze([
    'driver_order',        // ドライバー順と交代の意図
    'handover_intent',
    'initial_pit_plan',    // 初期ピット方針
    'fuel_policy',         // 燃料方針（不明は不明のまま）
    'three_clean_lap_rule',// 最初の3クリーン周で実測確定して再判定する方針
    'review_conditions'    // タイヤ・損傷・天候変化時の見直し条件
  ]);

  const LABEL = {
    ja: {
      driver_order: 'ドライバー順',
      handover_intent: '交代の意図',
      initial_pit_plan: '初期ピット方針',
      fuel_policy: '燃料方針',
      three_clean_lap_rule: '3クリーン周での再判定',
      review_conditions: '見直し条件'
    },
    en: {
      driver_order: 'driver order',
      handover_intent: 'handover intent',
      initial_pit_plan: 'initial pit plan',
      fuel_policy: 'fuel policy',
      three_clean_lap_rule: 'three-clean-lap recheck',
      review_conditions: 'review conditions'
    }
  };

  // 一度に 2〜3 項目だけ聞く（一気に全部読み上げてキューを詰まらせない）。
  const BRIEFING_STEPS = Object.freeze([
    ['driver_order', 'handover_intent'],
    ['initial_pit_plan', 'fuel_policy'],
    ['three_clean_lap_rule', 'review_conditions']
  ]);

  const QUESTION = {
    ja: {
      driver_order: '走行順は誰から誰へ？',
      handover_intent: '交代はどのタイミングで回す？',
      initial_pit_plan: '初期のピット方針は？分からなければ「未定」でいい。',
      fuel_policy: '燃料はどう積む方針？未定なら未定と言って。',
      three_clean_lap_rule: '最初の3クリーン周で実測燃費を確定して見直す、でいい？',
      review_conditions: '見直すのはどの条件？タイヤ、損傷、天候変化。'
    },
    en: {
      driver_order: 'Who runs, in what order?',
      handover_intent: 'When do you want the handovers?',
      initial_pit_plan: 'Initial pit plan? "unknown" is a valid answer.',
      fuel_policy: 'Fuel policy? Say unknown if it is unknown.',
      three_clean_lap_rule: 'Lock measured burn after the first three clean laps and recheck?',
      review_conditions: 'What triggers a review: tyres, damage, weather?'
    }
  };

  // ── 言語判定・数値ヘルパー ────────────────────────────────────────────
  const isJa = lang => lang === 'ja';
  const finite = value => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const intOrNull = value => {
    const n = finite(value);
    return n === null ? null : Math.trunc(n);
  };
  const clean = text => String(text === null || text === undefined ? '' : text).trim();

  // ── 明示確認の閉じた集合 ──────────────────────────────────────────────
  // 「はい」「OK」「了解」単体は **確定ではない**。走行中の相槌を拾って
  // Plan を書き換える事故（実走で最も起きやすい形）をここで止める。
  const CONFIRM_RE = /(?:内容|それ|これ|以上|そ)?で?確定(?:で|します|お願い)?|プラン(?:を)?確定|確定でいい|lock (?:it|the plan) in|plan confirmed|confirm(?:ed)? (?:the )?plan|that'?s confirmed/i;
  const BARE_ACK_RE = /^(?:はい|ええ|うん|おk|ok|okay|yes|yep|了解|わかった|分かった|copy|roger)[。.!！]?$/i;
  const AMBIGUOUS_FIX_RE = /^(?:違う|ちがう|ちがいます|違います|修正|直して|なおして|no|wrong|not right|change it|fix it)[。.!！]?$/i;
  const START_RE = /(?:作戦会議|ブリーフィング|打ち合わせ|チームプラン).{0,6}(?:開始|始め|作る|決め)|start (?:the )?(?:team )?briefing|team plan setup|build (?:the )?team plan/i;
  const SHOW_RE = /(?:チーム)?プラン.{0,4}(?:どうなって|確認|教えて|は？)|作戦.{0,4}(?:確認|どうなって)|(?:show|what'?s) (?:me )?the (?:team )?plan/i;

  function isExplicitConfirmation(text) {
    const t = clean(text);
    if (!t) return false;
    if (BARE_ACK_RE.test(t)) return false;   // 相槌は確定ではない
    return CONFIRM_RE.test(t);
  }
  function isAmbiguousCorrection(text) { return AMBIGUOUS_FIX_RE.test(clean(text)); }
  function isBriefingStart(text) { return START_RE.test(clean(text)); }
  function isPlanQuery(text) { return SHOW_RE.test(clean(text)); }

  // 自由文をどの項目へ束ねるか。該当しなければ null（推測で入れない）。
  const FIELD_HINTS = [
    ['driver_order', /走行順|ドライバー順|順番|オーダー|driver order|running order|stint order/i],
    ['handover_intent', /交代|ハンドオーバー|引き継ぎ|スティント長|handover|hand over|driver change|stint length/i],
    ['initial_pit_plan', /ピット|ストップ|給油回数|pit|stop\b/i],
    ['fuel_policy', /燃料|ガソリン|給油量|満タン|燃費|fuel|top ?up|full tank/i],
    ['three_clean_lap_rule', /3周|三周|クリーン周|実測|clean lap|three lap/i],
    ['review_conditions', /見直し|条件|タイヤ|損傷|ダメージ|天候|雨|路面|review|tyre|tire|damage|weather|rain/i]
  ];
  function fieldForText(text) {
    const t = clean(text);
    for (const [field, re] of FIELD_HINTS) if (re.test(t)) return field;
    return null;
  }

  // ── state ────────────────────────────────────────────────────────────
  function emptyState() {
    return {
      schema: SCHEMA,
      revision: 0,
      confirmed: null,
      candidate: null,
      briefing: { active: false, step: 0, asked: [], awaiting_confirmation: false },
      pending_proposal: null,
      updated_at: null,
      log: []
    };
  }

  function normalize(state) {
    const base = emptyState();
    if (!state || typeof state !== 'object' || state.schema !== SCHEMA) return base;
    return {
      schema: SCHEMA,
      revision: intOrNull(state.revision) || 0,
      confirmed: normalizeBody(state.confirmed),
      candidate: normalizeBody(state.candidate),
      briefing: {
        active: state.briefing && state.briefing.active === true,
        step: intOrNull(state.briefing && state.briefing.step) || 0,
        asked: Array.isArray(state.briefing && state.briefing.asked)
          ? state.briefing.asked.filter(f => FIELDS.includes(f)) : [],
        awaiting_confirmation: !!(state.briefing && state.briefing.awaiting_confirmation)
      },
      pending_proposal: state.pending_proposal && typeof state.pending_proposal === 'object'
        ? state.pending_proposal : null,
      updated_at: state.updated_at || null,
      log: Array.isArray(state.log) ? state.log.slice(-MAX_LOG) : []
    };
  }

  function normalizeBody(body) {
    if (!body || typeof body !== 'object') return null;
    const fields = {};
    FIELDS.forEach(name => {
      const entry = body.fields && body.fields[name];
      if (!entry || typeof entry !== 'object') return;
      const value = clean(entry.value).slice(0, 240);
      if (!value) return;
      fields[name] = {
        value,
        source: entry.source === 'bridge_evidence' || entry.source === 'team_handoff'
          ? entry.source : 'human',
        at: entry.at || null
      };
    });
    if (!Object.keys(fields).length) return null;
    return {
      revision: intOrNull(body.revision) || 0,
      status: body.status === 'confirmed' ? 'confirmed' : 'candidate',
      source: body.source === 'team_handoff' ? 'team_handoff' : 'human',
      updated_at: body.updated_at || null,
      fields
    };
  }

  function cloneBody(body) {
    if (!body) return null;
    return JSON.parse(JSON.stringify(body));
  }

  function pushLog(state, action, detail) {
    state.log = (state.log || []).concat([{
      at: state.updated_at, action, revision: state.revision,
      detail: detail === undefined ? null : detail
    }]).slice(-MAX_LOG);
    return state;
  }

  function missingFields(state) {
    const body = state.candidate || state.confirmed;
    const have = body ? Object.keys(body.fields) : [];
    return FIELDS.filter(f => !have.includes(f));
  }

  // ── ブリーフィング ────────────────────────────────────────────────────
  function startBriefing(input) {
    const state = normalize(input && input.state);
    const lang = isJa(input && input.lang) ? 'ja' : 'en';
    const now = (input && input.now) || new Date().toISOString();
    const roster = Array.isArray(input && input.roster)
      ? input.roster.map(clean).filter(Boolean).slice(0, 3) : [];
    state.briefing = { active: true, step: 0, asked: BRIEFING_STEPS[0].slice(), awaiting_confirmation: false };
    state.updated_at = now;
    pushLog(state, 'briefing_started');
    // 走行順は人が決める。Luna が勝手に完成戦略を発明しない（roster は既定値の提示だけ）。
    const hint = roster.length >= 2
      ? (lang === 'ja' ? `登録は${roster.join('→')}。` : `Roster on file: ${roster.join(' → ')}. `)
      : '';
    return {
      state,
      questions: BRIEFING_STEPS[0].map(f => QUESTION[lang][f]),
      reply: hint + BRIEFING_STEPS[0].map(f => QUESTION[lang][f]).join(' ')
    };
  }

  function advanceBriefing(state, lang) {
    const step = state.briefing.step + 1;
    if (step >= BRIEFING_STEPS.length) {
      state.briefing = { active: true, step: BRIEFING_STEPS.length, asked: [], awaiting_confirmation: true };
      return lang === 'ja'
        ? '以上で候補。この内容で確定するなら「確定」と言って。'
        : 'That is the candidate plan. Say "confirm plan" to lock it in.';
    }
    state.briefing = {
      active: true, step, asked: BRIEFING_STEPS[step].slice(), awaiting_confirmation: false
    };
    return BRIEFING_STEPS[step].map(f => QUESTION[lang][f]).join(' ');
  }

  function setCandidateField(state, field, value, now, source) {
    const body = cloneBody(state.candidate) || cloneBody(state.confirmed) || {
      revision: state.revision, status: 'candidate', source: 'human', updated_at: now, fields: {}
    };
    body.status = 'candidate';
    body.updated_at = now;
    body.fields[field] = { value: clean(value).slice(0, 240), source: source || 'human', at: now };
    state.candidate = normalizeBody(body);
    return state;
  }

  // 人間の入力を candidate へ反映する。confirmed は絶対に触らない。
  function ingestHumanInput(input) {
    const state = normalize(input && input.state);
    const lang = isJa(input && input.lang) ? 'ja' : 'en';
    const now = (input && input.now) || new Date().toISOString();
    const text = clean(input && input.text);
    const result = { state, handled: false, changed: false, reply: '', confirmed: false };
    if (!text) return result;

    // ① 明示確定だけが confirmed を作る。
    if (isExplicitConfirmation(text)) {
      if (!state.candidate) {
        result.handled = true;
        result.reply = lang === 'ja'
          ? '確定できる候補がまだ無い。先に方針を聞かせて。'
          : 'There is no candidate plan to confirm yet. Give me the outline first.';
        return result;
      }
      return Object.assign(result, confirmCandidate({ state, lang, now }), { handled: true });
    }

    // ② 相槌は Plan の中身にならない。ブリーフィング中でも「はい」を
    //    回答本文として保存しない（走行中の相槌が Plan に化ける事故の本体）。
    if (BARE_ACK_RE.test(text)) {
      if (!state.briefing.active) return result;   // 通常会話へ返す
      result.handled = true;
      result.reply = lang === 'ja'
        ? '確定するなら「確定」と言って。違うなら直す項目を言って。'
        : 'Say "confirm plan" to lock it in, or name the item you want changed.';
      return result;
    }

    // ③ 曖昧な否定は confirmed を変えない。何を直すのかだけ短く聞く。
    if (isAmbiguousCorrection(text)) {
      state.updated_at = now;
      pushLog(state, 'ambiguous_correction_ignored');
      result.handled = true;
      result.reply = lang === 'ja'
        ? 'どこを直す？項目を言って。確定済みのプランはそのままにしてある。'
        : 'Which item should change? The confirmed plan stays as it is until you say.';
      return result;
    }

    // ④ ブリーフィング中は、今聞いている項目に束ねる（自由文の迷子を作らない）。
    // 語で項目が特定できるならそれを採る（「ピットは30周」を走行順へ入れない）。
    // 特定できない短い答えだけを、今聞いている項目へ束ねる。
    let field = fieldForText(text);
    if (!field && state.briefing.active && state.briefing.asked.length) field = state.briefing.asked[0];
    if (!field) {
      result.handled = false;   // Plan の話ではない。通常会話へ返す。
      return result;
    }

    setCandidateField(state, field, text, now, 'human');
    state.updated_at = now;
    pushLog(state, 'candidate_field_set', field);
    result.handled = true;
    result.changed = true;

    if (state.briefing.active && state.briefing.asked.length) {
      const remaining = state.briefing.asked.filter(f => f !== field);
      if (remaining.length) {
        state.briefing.asked = remaining;
        result.reply = QUESTION[lang][remaining[0]];
      } else {
        result.reply = advanceBriefing(state, lang);
      }
      return result;
    }
    result.reply = lang === 'ja'
      ? `${LABEL.ja[field]}を候補に入れた。確定するなら「確定」と言って。`
      : `Noted as a candidate ${LABEL.en[field]}. Say "confirm plan" to lock it in.`;
    return result;
  }

  function confirmCandidate(input) {
    const state = normalize(input && input.state);
    const lang = isJa(input && input.lang) ? 'ja' : 'en';
    const now = (input && input.now) || new Date().toISOString();
    if (!state.candidate) {
      return { state, changed: false, confirmed: false,
        reply: lang === 'ja' ? '確定できる候補が無い。' : 'No candidate plan to confirm.' };
    }
    state.revision = (state.revision || 0) + 1;
    const body = cloneBody(state.candidate);
    body.status = 'confirmed';
    body.revision = state.revision;
    body.updated_at = now;
    state.confirmed = normalizeBody(body);
    state.candidate = null;
    state.pending_proposal = null;
    state.briefing = { active: false, step: 0, asked: [], awaiting_confirmation: false };
    state.updated_at = now;
    pushLog(state, 'confirmed');
    const gaps = missingFields(state);
    const tail = gaps.length
      ? (lang === 'ja' ? `未確定は${gaps.map(f => LABEL.ja[f]).join('・')}。` : ` Still open: ${gaps.map(f => LABEL.en[f]).join(', ')}.`)
      : '';
    return {
      state, changed: true, confirmed: true,
      reply: (lang === 'ja' ? `Plan rev${state.revision}で確定。` : `Plan rev${state.revision} confirmed.`) + tail
    };
  }

  function describe(state, lang) {
    const s = normalize(state);
    const L = isJa(lang) ? 'ja' : 'en';
    if (!s.confirmed) {
      return L === 'ja'
        ? '確定したチームプランはまだ無い。候補' + (s.candidate ? 'はある。' : 'も無い。')
        : 'No confirmed team plan yet' + (s.candidate ? ' (a candidate exists).' : '.');
    }
    const parts = FIELDS.filter(f => s.confirmed.fields[f])
      .map(f => `${LABEL[L][f]}: ${s.confirmed.fields[f].value}`);
    const head = L === 'ja' ? `Plan rev${s.confirmed.revision}。` : `Plan rev${s.confirmed.revision}. `;
    return head + parts.join(' / ');
  }

  // ── 実測（Bridge）からの証拠 ──────────────────────────────────────────
  // 取れない値は null。0 にしない。推測しない。
  function evidenceSnapshot(live) {
    const l = live && typeof live === 'object' ? live : {};
    const fuelStrategy = l.fuel_strategy && typeof l.fuel_strategy === 'object' ? l.fuel_strategy : {};
    const weather = l.weather && typeof l.weather === 'object' ? l.weather : {};
    const measurement = l.tire_measurement && typeof l.tire_measurement === 'object' ? l.tire_measurement : {};
    const tires = l.tires && typeof l.tires === 'object' ? l.tires : {};
    const damageS = finite(l.damage_s);
    const plan = l.strategy_plan && typeof l.strategy_plan === 'object' ? l.strategy_plan : {};

    const cleanLaps = intOrNull(fuelStrategy.clean_laps_sampled);
    const burn = finite(fuelStrategy.avg_fuel_per_lap);
    const forecast = l.timed_finish_forecast && typeof l.timed_finish_forecast === 'object'
      ? l.timed_finish_forecast : {};
    const avgLap = finite(forecast.driver_avg_lap_s);
    const remainS = finite(l.session_time_remaining_s);
    const projectedLaps = (avgLap !== null && avgLap > 0 && remainS !== null)
      ? Math.floor(remainS / avgLap) : null;

    // タイヤはピット計測時のみ本物。走行中の既定値を「計測値」にしない。
    const measured = measurement.available === true;
    const corners = {};
    if (measured) {
      ['lf', 'rf', 'lr', 'rr'].forEach(c => {
        const entry = tires[c];
        if (entry && typeof entry === 'object') corners[c] = entry;
      });
    }

    return {
      fuel_l: finite(l.fuel),
      clean_fuel_burn_l: burn,
      clean_laps_sampled: cleanLaps,
      laps_of_fuel_left: finite(fuelStrategy.laps_of_fuel_left),
      avg_lap_s: avgLap,
      session_time_remaining_s: remainS,
      projected_laps_remaining: projectedLaps,
      projected_pit_window_lap: intOrNull(plan.target_lap),
      finish_margin_l: finite(plan.projected_finish_margin_l),
      weather: {
        available: weather.track_temp_c !== undefined || weather.air_temp_c !== undefined,
        track_temp_c: finite(weather.track_temp_c),
        air_temp_c: finite(weather.air_temp_c),
        track_wetness_code: intOrNull(weather.track_wetness_code)
      },
      tires: {
        available: measured,
        measured_at_session_s: measured ? finite(measurement.session_time_s) : null,
        source: measured ? (measurement.source || 'pit_return') : 'unavailable_while_running',
        corners: measured ? corners : {}
      },
      damage: {
        observed: damageS !== null && damageS > 0,
        damage_s: damageS,
        // 修理要否は損傷秒だけでは決まらない。分からないものは null のまま渡す。
        repair_required: null
      }
    };
  }

  // 3クリーン周が揃った時だけ「維持」か「小変更候補」を出す。pit now は出さない。
  function compareLiveEvidence(input) {
    const state = normalize(input && input.state);
    const lang = isJa(input && input.lang) ? 'ja' : 'en';
    const evidence = evidenceSnapshot(input && input.live);
    const minLaps = intOrNull(input && input.minCleanLaps) || MIN_CLEAN_LAPS;
    const out = { available: false, verdict: 'insufficient_evidence', evidence, changes: [], reply: '' };

    if (evidence.clean_laps_sampled === null || evidence.clean_laps_sampled < minLaps
        || evidence.clean_fuel_burn_l === null) {
      const have = evidence.clean_laps_sampled === null ? 0 : evidence.clean_laps_sampled;
      out.reply = lang === 'ja'
        ? `クリーン周${have}本。実測はまだ${minLaps}本に届いていない。Planは動かさない。`
        : `${have} clean laps so far, short of ${minLaps}. The plan stays untouched.`;
      return out;
    }
    out.available = true;

    const confirmed = state.confirmed;
    const plannedWindow = confirmed ? plannedPitLap(confirmed) : null;
    const measuredWindow = evidence.projected_pit_window_lap;

    if (!confirmed) {
      out.verdict = 'minor_change_candidate';
      out.changes.push({
        field: 'fuel_policy', from: null,
        to: `${evidence.clean_fuel_burn_l}L/lap (clean ${evidence.clean_laps_sampled})`,
        reason: 'measured_burn_available'
      });
    } else if (plannedWindow !== null && measuredWindow !== null
        && Math.abs(plannedWindow - measuredWindow) > PIT_WINDOW_TOLERANCE_LAPS) {
      out.verdict = 'minor_change_candidate';
      out.changes.push({
        field: 'initial_pit_plan', from: String(plannedWindow), to: String(measuredWindow),
        reason: 'measured_pit_window_differs'
      });
    } else if (plannedWindow === null && measuredWindow !== null) {
      out.verdict = 'minor_change_candidate';
      out.changes.push({
        field: 'initial_pit_plan', from: null, to: String(measuredWindow),
        reason: 'plan_had_no_number'
      });
    } else {
      out.verdict = 'hold';
    }

    out.reply = evidenceLine(evidence, out, lang);
    return out;
  }

  function plannedPitLap(body) {
    const entry = body && body.fields && body.fields.initial_pit_plan;
    if (!entry) return null;
    const m = String(entry.value).match(/(\d{1,3})\s*(?:周|lap)/i);
    return m ? Number(m[1]) : null;
  }

  function evidenceLine(evidence, comparison, lang) {
    const L = isJa(lang) ? 'ja' : 'en';
    const num = (v, d) => (v === null ? (L === 'ja' ? '未取得' : 'not available') : v.toFixed(d));
    const head = L === 'ja'
      ? `実測。燃料${num(evidence.fuel_l, 1)}L、燃費${num(evidence.clean_fuel_burn_l, 2)}L、クリーン${evidence.clean_laps_sampled}本。`
      : `Measured: ${num(evidence.fuel_l, 1)}L on board, ${num(evidence.clean_fuel_burn_l, 2)}L per lap over ${evidence.clean_laps_sampled} clean laps. `;
    if (comparison.verdict === 'hold') {
      return head + (L === 'ja' ? 'Planは維持でいい。' : 'The plan holds.');
    }
    const change = comparison.changes[0] || {};
    return head + (L === 'ja'
      ? `小変更の候補：${LABEL.ja[change.field] || change.field}を${change.to}へ。確定するなら「確定」と言って。`
      : `Minor change candidate: ${LABEL.en[change.field] || change.field} to ${change.to}. Say "confirm plan" to lock it in.`);
  }

  // 実測由来の候補を state へ。confirmed は触らない（人の確認が要る）。
  function proposeFromEvidence(input) {
    const state = normalize(input && input.state);
    const now = (input && input.now) || new Date().toISOString();
    const comparison = input && input.comparison;
    if (!comparison || comparison.verdict !== 'minor_change_candidate') return { state, changed: false };
    comparison.changes.forEach(c => setCandidateField(state, c.field, String(c.to), now, 'bridge_evidence'));
    state.pending_proposal = {
      source: 'live_evidence', changes: comparison.changes,
      evidence: comparison.evidence, created_at: now
    };
    state.updated_at = now;
    pushLog(state, 'evidence_candidate');
    return { state, changed: true };
  }

  // タイヤ交換の判断。固定しきい値で断定しない。
  function tyreChangeReview(input) {
    const evidence = (input && input.evidence) || {};
    const tires = evidence.tires || {};
    const corners = tires.corners || {};
    const names = ['lf', 'rf', 'lr', 'rr'];
    const haveAll = tires.available === true && names.every(n => corners[n]);
    const nextStintLaps = intOrNull(input && input.nextStintLaps);
    const weatherKnown = !!(evidence.weather && (evidence.weather.track_temp_c !== null
      || evidence.weather.track_wetness_code !== null));
    const repairKnown = !!(evidence.damage && (evidence.damage.observed === false
      || finite(evidence.damage.damage_s) !== null));
    if (!haveAll || nextStintLaps === null || !weatherKnown || !repairKnown) {
      return {
        verdict: 'insufficient_evidence',
        missing: [
          haveAll ? null : 'four_corner_measurement',
          nextStintLaps === null ? 'next_stint_length' : null,
          weatherKnown ? null : 'weather',
          repairKnown ? null : 'damage_or_repair_time'
        ].filter(Boolean)
      };
    }
    const threshold = finite(input && input.reviewThresholdPct);
    return { verdict: 'review_with_driver', missing: [], review_threshold_pct: threshold };
  }

  // ── 交代 packet ──────────────────────────────────────────────────────
  // confirmed だけを渡す。candidate は「確定事項」として交代先へ流さない。
  function buildHandoffTeamSection(input) {
    const state = normalize(input && input.state);
    const evidence = input && input.evidence ? input.evidence : null;
    const stint = input && input.stintSummary ? input.stintSummary : null;
    const confirmed = state.confirmed;
    return {
      schema: SCHEMA,
      plan_revision: confirmed ? confirmed.revision : null,
      plan_confirmed_at: confirmed ? confirmed.updated_at : null,
      plan_fields: confirmed ? confirmed.fields : null,
      plan_status: confirmed ? 'confirmed' : 'none',
      candidate_pending: !!state.candidate,
      evidence: evidence || null,
      stint_summary: stint || null
    };
  }

  // 受信側。revision が古い/同じなら適用しない（stale の再適用を防ぐ）。
  function applyReceivedTeamSection(input) {
    const state = normalize(input && input.state);
    const section = input && input.section;
    const now = (input && input.now) || new Date().toISOString();
    const lang = isJa(input && input.lang) ? 'ja' : 'en';
    if (!section || typeof section !== 'object' || section.schema !== SCHEMA
        || section.plan_status !== 'confirmed' || !section.plan_fields) {
      return { state, applied: false,
        reply: lang === 'ja' ? '受け取った引き継ぎに確定プランは入っていない。'
                             : 'The received handoff carries no confirmed plan.' };
    }
    const revision = intOrNull(section.plan_revision) || 0;
    if (revision <= (state.confirmed ? state.confirmed.revision : 0)) {
      return { state, applied: false,
        reply: lang === 'ja' ? '手元のプランの方が新しい。上書きしない。'
                             : 'The local plan is newer; not overwriting.' };
    }
    state.confirmed = normalizeBody({
      revision, status: 'confirmed', source: 'team_handoff',
      updated_at: section.plan_confirmed_at || now, fields: section.plan_fields
    });
    state.revision = revision;
    state.candidate = null;
    state.updated_at = now;
    pushLog(state, 'received_team_plan', revision);
    return {
      state, applied: true,
      reply: lang === 'ja'
        ? `Plan rev${revision}を受領。${describe(state, 'ja')} 違うなら今言って。`
        : `Received plan rev${revision}. ${describe(state, 'en')} Correct me now if that is wrong.`
    };
  }

  // ── スティント要約（レース後に確定値で答えるための唯一のソース）────────
  function summarizeStint(input) {
    const i = input && typeof input === 'object' ? input : {};
    const laps = Array.isArray(i.laps) ? i.laps : [];
    const times = laps.map(l => finite(l && l.lap_time_s)).filter(v => v !== null && v > 0);
    const cleanLaps = laps.filter(l => l && l.valid_clean === true);
    const cleanTimes = cleanLaps.map(l => finite(l.lap_time_s)).filter(v => v !== null && v > 0);
    const burns = laps.map(l => finite(l && l.fuel_used_l)).filter(v => v !== null);
    // incidents は「観測できた範囲」を必ず添える。観測が無ければ 0 と言わない。
    const incidentValues = laps.map(l => intOrNull(l && l.incidents)).filter(v => v !== null);
    const pitEvents = Array.isArray(i.pit_events) ? i.pit_events.slice(0, 12) : [];
    return {
      schema: SCHEMA,
      driver_name: clean(i.driver_name) || null,
      driver_index: intOrNull(i.driver_index),
      start_lap: intOrNull(i.start_lap),
      end_lap: intOrNull(i.end_lap),
      laps_completed: laps.length || null,
      clean_laps: cleanLaps.length ? cleanLaps.length : (laps.length ? 0 : null),
      best_lap_s: times.length ? Math.min.apply(null, times) : null,
      average_lap_s: times.length
        ? Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(3)) : null,
      clean_average_lap_s: cleanTimes.length
        ? Number((cleanTimes.reduce((a, b) => a + b, 0) / cleanTimes.length).toFixed(3)) : null,
      fuel_burn_l_per_lap: burns.length
        ? Number((burns.reduce((a, b) => a + b, 0) / burns.length).toFixed(3)) : null,
      incidents: incidentValues.length ? incidentValues.reduce((a, b) => a + b, 0) : null,
      incident_scope: incidentValues.length ? 'observed_laps_in_stint' : 'unknown',
      pit_events: pitEvents,
      repairs: pitEvents.filter(p => p && p.repair === true).length || (pitEvents.length ? 0 : null),
      plan_revision: intOrNull(i.plan_revision)
    };
  }

  function buildRaceLearning(input) {
    const i = input && typeof input === 'object' ? input : {};
    const state = normalize(i.state);
    const stints = Array.isArray(i.stints) ? i.stints : [];
    const result = i.result && typeof i.result === 'object' ? i.result : {};
    const confirmed = state.confirmed;
    const plannedLap = confirmed ? plannedPitLap(confirmed) : null;
    const actualStops = stints.reduce((n, s) => n + ((s.pit_events || []).length), 0);
    return {
      schema: SCHEMA,
      id: 'tp-' + (i.now || new Date().toISOString()),
      saved_at: i.now || new Date().toISOString(),
      track: clean(result.track) || null,
      car_class: clean(result.car_class) || null,
      is_race: result.is_race === true,
      plan_revision: confirmed ? confirmed.revision : null,
      plan_fields: confirmed ? confirmed.fields : null,
      stints: stints,
      plan_vs_actual: {
        planned_first_pit_lap: plannedLap,
        actual_pit_events: actualStops || (stints.length ? 0 : null),
        // 差分は両方が数値の時だけ。片方が null なら null（0 にしない）。
        first_pit_delta_laps: (plannedLap !== null && stints.length && stints[0].pit_events
          && stints[0].pit_events.length && intOrNull(stints[0].pit_events[0].entry_lap) !== null)
          ? intOrNull(stints[0].pit_events[0].entry_lap) - plannedLap : null
      }
    };
  }

  // レース後の質問に、LLM 要約ではなく確定した構造から答える。
  function answerFromRaceLearning(input) {
    const entry = input && input.entry;
    const lang = isJa(input && input.lang) ? 'ja' : 'en';
    const who = clean(input && input.driverName);
    if (!entry || !Array.isArray(entry.stints) || !entry.stints.length) return null;
    const stint = who
      ? entry.stints.find(s => s.driver_name && clean(s.driver_name) === who)
      : entry.stints[0];
    if (!stint) {
      return lang === 'ja'
        ? `${who}のスティント記録が無い。推測では答えない。`
        : `There is no stint record for ${who}. I will not guess.`;
    }
    const fmt = (v, unit, d) => (v === null || v === undefined
      ? (lang === 'ja' ? '未取得' : 'not recorded') : v.toFixed(d) + unit);
    const incidents = stint.incident_scope === 'unknown'
      ? (lang === 'ja' ? 'インシデントは記録範囲外' : 'incident count not recorded')
      : (lang === 'ja' ? `インシデント${stint.incidents}（${stint.incident_scope}）`
                       : `${stint.incidents} incidents (${stint.incident_scope})`);
    return lang === 'ja'
      ? `${stint.driver_name || 'ドライバー'}：${stint.laps_completed ?? '未取得'}周、ベスト${fmt(stint.best_lap_s, '秒', 3)}、平均${fmt(stint.average_lap_s, '秒', 3)}、クリーン${stint.clean_laps ?? '未取得'}本、燃費${fmt(stint.fuel_burn_l_per_lap, 'L', 2)}。${incidents}。`
      : `${stint.driver_name || 'Driver'}: ${stint.laps_completed ?? 'unknown'} laps, best ${fmt(stint.best_lap_s, 's', 3)}, average ${fmt(stint.average_lap_s, 's', 3)}, ${stint.clean_laps ?? 'unknown'} clean, ${fmt(stint.fuel_burn_l_per_lap, 'L', 2)} per lap. ${incidents}.`;
  }

  return {
    SCHEMA, FIELDS, MIN_CLEAN_LAPS, BRIEFING_STEPS, LABEL, QUESTION,
    emptyState, normalize, describe, missingFields,
    isExplicitConfirmation, isAmbiguousCorrection, isBriefingStart, isPlanQuery,
    startBriefing, ingestHumanInput, confirmCandidate,
    evidenceSnapshot, compareLiveEvidence, proposeFromEvidence, tyreChangeReview,
    buildHandoffTeamSection, applyReceivedTeamSection,
    summarizeStint, buildRaceLearning, answerFromRaceLearning
  };
}));
