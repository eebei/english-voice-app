(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  // ★2026-08-30：desktop は <script src> + グローバルで runtime module を読む
  //   （renderer に require は無い）。CommonJS だけだとアプリからは一切使えない。
  else root.PitwallPddp = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

// PITWALL Driver Development Program (PDDP)
// Deterministic driver-improvement summary.  No LLM or rating promises here:
// it turns confirmed race-history rows into one measurable next focus.

function finite(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

function classify(row) {
  const incidents = finite(row && row.incidents);
  const finish = finite(row && (row.finishPos ?? row.finish_pos));
  const start = finite(row && (row.startPos ?? row.start_pos));
  const dnf = row && (row.dnf === true || /dnf|disconnect|abandon/i.test(String(row.status || row.reason || '')));
  if (dnf) return 'completion';
  if (incidents !== null && incidents >= 8) return 'incident_control';
  if (incidents !== null && incidents >= 4) return 'racecraft';
  if (start !== null && finish !== null && finish - start >= 4) return 'conversion';
  return 'consistency';
}

function analyze(rows, options = {}) {
  const source = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 10));
  const recent = source.slice(-limit);
  const incidents = recent.map(r => finite(r.incidents)).filter(v => v !== null);
  const finishes = recent.map(r => finite(r.finishPos ?? r.finish_pos)).filter(v => v !== null);
  const iratings = recent.map(r => finite(r.irating)).filter(v => v !== null);
  const counts = recent.reduce((m, r) => { const k = classify(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const focus = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 'consistency';
  return {
    sample_size: recent.length,
    average_incidents: avg(incidents),
    average_finish: avg(finishes),
    latest_irating: iratings.length ? iratings[iratings.length - 1] : null,
    irating_min: iratings.length ? Math.min(...iratings) : null,
    irating_max: iratings.length ? Math.max(...iratings) : null,
    issue_counts: counts,
    primary_focus: focus,
    rows: recent,
  };
}

function nextFocus(summary) {
  const s = summary || {};
  const avgInc = finite(s.average_incidents);
  if (s.primary_focus === 'completion') return { key: 'completion', metric: 'DNF率', target: '完走率を上げる' };
  if (s.primary_focus === 'incident_control' || (avgInc !== null && avgInc >= 8)) {
    return { key: 'incident_control', metric: '平均Incidents', target: 'まず平均4未満' };
  }
  if (s.primary_focus === 'racecraft' || (avgInc !== null && avgInc >= 4)) {
    return { key: 'racecraft', metric: '接触・オフトラック', target: '直近レースで半減' };
  }
  if (s.primary_focus === 'conversion') return { key: 'conversion', metric: 'スタート順位→決勝順位', target: '失う順位を2以下' };
  return { key: 'consistency', metric: '完走順位のばらつき', target: '同じ判断を再現する' };
}

function briefingLine(summary, name = 'ドライバー') {
  const s = summary || {};
  const f = nextFocus(s);
  const n = Number.isInteger(s.sample_size) ? s.sample_size : 0;
  const avgInc = finite(s.average_incidents);
  const ir = finite(s.latest_irating);
  const facts = [];
  if (n) facts.push(`直近${n}レース`);
  if (avgInc !== null) facts.push(`平均Incidents ${avgInc.toFixed(1)}`);
  if (ir !== null) facts.push(`最新iRating ${Math.round(ir)}`);
  return `${name}、${facts.join('、') || '確認できた実測がまだ少ない'}。今回の重点は${f.metric}。次の1レースは${f.target}を一つだけ試そう。`;
}

// ══ 2026-08-30 仕様 review/PDDP_SPEC_V1.md への追補 ══════════════════
// 既存の analyze / nextFocus / briefingLine は変えない。仕様のうち未実装だった
// 「レース後の質問」「目標状態」「成功と失敗の保存」「訂正の反映」「横取り禁止」
// と、欠損を推測へ化かさない分類の穴を足す。

// PDDP を喋ってよい局面。走行中の戦略・燃料・反射安全コールを横取りしない。
const ALLOWED_CONTEXTS = ['briefing', 'debrief'];
const GOAL_IRATING = 2000;   // 最初の目標
const GOAL_STREAK = 10;      // 連続レース数（3kは検証後の挑戦目標・保証しない）

function isPddpContext(context) {
  return ALLOWED_CONTEXTS.indexOf(String(context || '').trim()) >= 0;
}

// 実測が一つも無い行を classify() は 'consistency' と呼ぶ。これは
// 「安定している」という主張になってしまう。測れた行があるかを別に数え、
// 呼び出し側が「材料不足」と「安定」を取り違えないようにする。
function measuredRowCount(rows) {
  return (Array.isArray(rows) ? rows : []).filter(r => r && (
    finite(r.incidents) !== null
    || (finite(r.startPos ?? r.start_pos) !== null && finite(r.finishPos ?? r.finish_pos) !== null)
    || r.dnf === true
  )).length;
}

/** 主因は一つ。頻度ではなく重大度の順（仕様の分類順）で選ぶ。 */
function primaryIssue(rows, options = {}) {
  const summary = analyze(rows, options);
  const recent = summary.rows || [];
  const measured = measuredRowCount(recent);
  if (!recent.length || !measured) {
    return { category: null, actionable: false, reason: 'insufficient_measured_evidence',
      measured_rows: measured, sample_size: summary.sample_size, summary };
  }
  const order = ['completion', 'incident_control', 'racecraft', 'conversion', 'consistency'];
  const counts = summary.issue_counts || {};
  for (const key of order) {
    if (key === 'consistency') break;
    if (counts[key]) {
      return { category: key, actionable: true, reason: 'highest_severity_present',
        occurrences: counts[key], measured_rows: measured, sample_size: summary.sample_size, summary };
    }
  }
  return { category: 'consistency', actionable: true, reason: 'no_dominant_failure_mode',
    measured_rows: measured, sample_size: summary.sample_size, summary };
}

/** レース後：事実を一つ示して、答えやすい質問を一つだけ。抽象質問は返さない。 */
function debriefQuestion(race, issue) {
  const r = race && typeof race === 'object' ? race : {};
  const incidents = finite(r.incidents);
  const start = finite(r.startPos ?? r.start_pos);
  const finish = finite(r.finishPos ?? r.finish_pos);
  const category = issue && issue.category;
  if (r.dnf === true) {
    return { speak: true, kind: 'completion',
      line: '今回は完走できなかった。止まった原因は接触、機械、それとも判断ミス？' };
  }
  if (incidents !== null) {
    const fact = `今回はIncidents ${Math.round(incidents)}。`;
    const question = (category === 'conversion' && start !== null && finish !== null)
      ? `スタートP${Math.round(start)}からP${Math.round(finish)}。失ったのは序盤、中盤、終盤のどれ？`
      : '一番危なかった接触は、こちらから行った側？受けた側？';
    return { speak: true, kind: category || 'consistency', line: fact + question };
  }
  if (start !== null && finish !== null) {
    return { speak: true, kind: 'conversion',
      line: `スタートP${Math.round(start)}からP${Math.round(finish)}。順位が動いた一番大きな場面はどこ？` };
  }
  // 事実が一つも無い時に「どうだった？」へ逃げない。
  return { speak: false, kind: null,
    line: '今回は確定した実測が取れていない。記録が揃った時にまた見よう。' };
}

/** 目標の状態。上昇も3k到達も保証しない＝状態を述べるだけ。 */
function goalStatus(rows) {
  const recent = (Array.isArray(rows) ? rows.filter(Boolean) : []).slice(-GOAL_STREAK);
  const values = recent.map(r => finite(r.irating)).filter(v => v !== null);
  if (!values.length) {
    return { goal_irating: GOAL_IRATING, streak_target: GOAL_STREAK, streak: null,
      met: null, guaranteed: false, line: 'iRatingの記録がまだ無い。' };
  }
  let streak = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] >= GOAL_IRATING) streak++; else break;
  }
  return { goal_irating: GOAL_IRATING, streak_target: GOAL_STREAK, streak,
    met: streak >= GOAL_STREAK, sample_count: values.length, guaranteed: false,
    line: `iRating ${GOAL_IRATING}以上が${streak}レース連続（目標${GOAL_STREAK}）。` };
}

function outcomeId(race) {
  const r = race || {};
  return String(r.recordedAt || [r.date, r.track, r.car].filter(Boolean).join('|') || '').trim();
}

/** 成功だけでなく、失敗した戦略・失敗したレースも同じ形で残す。 */
function buildOutcome(input = {}) {
  const race = input.race && typeof input.race === 'object' ? input.race : {};
  const before = finite(input.baselineIncidents);
  const after = finite(race.incidents);
  // 効果判定は両方の実測が揃った時だけ。片方でも欠ければ unknown。
  const outcome = (before === null || after === null) ? 'unknown'
    : after < before ? 'improved' : after > before ? 'worse' : 'unchanged';
  return {
    saved_at: String(input.now || new Date().toISOString()),
    race_id: outcomeId(race) || null,
    focus_key: input.focusKey ? String(input.focusKey) : null,
    target: input.target ? String(input.target) : null,
    baseline_incidents: before,
    result_incidents: after,
    start_pos: finite(race.startPos ?? race.start_pos),
    finish_pos: finite(race.finishPos ?? race.finish_pos),
    outcome,
    driver_note: input.driverNote ? String(input.driverNote) : null,
    disputed: false,
  };
}

/** 本人の訂正。記録は消さず disputed にし、次回分析の母数から外す。 */
function applyDriverCorrection(outcomes, input = {}) {
  const list = Array.isArray(outcomes) ? outcomes : [];
  const raceId = String(input.raceId || '').trim();
  let changed = false;
  const next = list.map(o => {
    if (!o || !raceId || o.race_id !== raceId) return o;
    changed = true;
    return Object.assign({}, o, { disputed: true,
      driver_note: input.note ? String(input.note) : o.driver_note });
  });
  return { outcomes: next, changed,
    disputed_race_ids: next.filter(o => o && o.disputed).map(o => o.race_id) };
}

/** 訂正済みレースを外して集計する（次回分析への反映）。 */
function analyzeExcludingDisputed(rows, outcomes, options = {}) {
  const disputed = new Set((Array.isArray(outcomes) ? outcomes : [])
    .filter(o => o && o.disputed && o.race_id).map(o => o.race_id));
  const kept = (Array.isArray(rows) ? rows.filter(Boolean) : [])
    .filter(r => !disputed.has(outcomeId(r)));
  return analyze(kept, options);
}

return { analyze, nextFocus, briefingLine,
  ALLOWED_CONTEXTS, GOAL_IRATING, GOAL_STREAK,
  isPddpContext, measuredRowCount, primaryIssue, debriefQuestion, goalStatus,
  outcomeId, buildOutcome, applyDriverCorrection, analyzeExcludingDisputed };
}));
