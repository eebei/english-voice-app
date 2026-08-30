#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════
// PITWALL Driver Development Program (PDDP) v1
// 仕様：review/PDDP_SPEC_V1.md
//
// ⓪ は Codex が `b948427` で置いた既存アサーション（そのまま維持＝退行検知）。
// ①以降は仕様の受入条件を、`pw_raceHistory` の実レコード形で検査する。
// ══════════════════════════════════════════════════════════════════════
const assert = require('assert');
const P = require('./desktop/pddp.js');
const { analyze, nextFocus, briefingLine } = P;
const fs = require('fs');

let pass = 0, fail = 0;
function ck(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '  ✅ ' : '  ❌ ') + label + (ok ? '' : ' -> ' + (detail === undefined ? '' : String(detail))));
  ok ? pass++ : fail++;
}

// ── ⓪ 既存アサーション（Codex `b948427`）──────────────────────────────
console.log('══ ⓪ 既存契約 ══');
{
  const rows = [
    { finishPos: 12, incidents: 2, irating: 1800 },
    { finishPos: 18, incidents: 9, irating: 1700 },
    { finishPos: 15, incidents: 8, irating: 1750 },
  ];
  const s = analyze(rows);
  assert.strictEqual(s.sample_size, 3);
  assert.strictEqual(s.primary_focus, 'incident_control');
  assert.strictEqual(Math.round(s.average_incidents * 10) / 10, 6.3);
  assert.strictEqual(nextFocus(s).key, 'incident_control');
  assert.match(briefingLine(s, '八木さん'), /平均Incidents 6\.3/);
  assert.doesNotMatch(briefingLine(s), /2500|3000/);
  assert.strictEqual(analyze([{ incidents: null, irating: null }]).average_incidents, null);
  ck('Codex の既存7アサーションが通る', true);
}
// pw_raceHistory の実形（renderer.html saveRaceRecord と同じキー）
const row = (o = {}) => Object.assign({
  date: '2026-08-01', recordedAt: '2026-08-01T10:00:00.000Z', userId: 'yagi',
  track: 'Road Atlanta', car: 'Mercedes-AMG GT3 2020', carClass: 'GT3',
  bestLap: '1:19.130', avgLap: '1:20.4', totalLaps: 34,
  incidents: 3, finishPos: 8, startPos: 9, irating: 2100
}, o);

// ── ① 既存APIを壊していない ─────────────────────────────────────────
console.log('══ ① 既存の analyze / nextFocus / briefingLine を保持 ══');
{
  ['analyze', 'nextFocus', 'briefingLine'].forEach(fn =>
    ck(`${fn} が残っている`, typeof P[fn] === 'function'));
  const s = P.analyze([row(), row({ incidents: 5 })]);
  ck('analyze は従来の形を返す',
    s.sample_size === 2 && s.average_incidents === 4 && !!s.issue_counts, JSON.stringify(s.issue_counts));
  ck('briefingLine は一文で事実＋一つの重点',
    /直近2レース/.test(P.briefingLine(s, '八木さん')) && /一つだけ試そう/.test(P.briefingLine(s, '八木さん')),
    P.briefingLine(s, '八木さん'));
  ck('desktop から読めるUMDになっている',
    /root\.PitwallPddp = api/.test(fs.readFileSync('desktop/pddp.js', 'utf8')));
}

// ── ② 欠損を0や推測へ変換しない ─────────────────────────────────────
console.log('══ ② 欠損は欠損のまま ══');
{
  const blind = [row({ incidents: null, startPos: null, finishPos: null, irating: null })];
  const s = P.analyze(blind);
  ck('平均Incidentsは0でなくnull', s.average_incidents === null, JSON.stringify(s.average_incidents));
  ck('平均順位も0でなくnull', s.average_finish === null);
  ck('iRatingも0でなくnull', s.latest_irating === null);
  ck('実測のある行を別に数える', P.measuredRowCount(blind) === 0);
  const issue = P.primaryIssue(blind);
  ck('実測ゼロを「安定」と言わない',
    issue.category === null && issue.actionable === false
    && issue.reason === 'insufficient_measured_evidence', JSON.stringify(issue.category));
  ck('空文字・boolean も数値へ通さない',
    P.analyze([row({ incidents: '' }), row({ incidents: true })]).average_incidents === null);
  ck('実測0は0として扱う（欠損と取り違えない）',
    P.analyze([row({ incidents: 0 }), row({ incidents: 0 })]).average_incidents === 0);
}

// ── ③ 主因は一つ・重大度順 ──────────────────────────────────────────
console.log('══ ③ 主因を一つに絞る ══');
{
  // consistency 8件 + DNF 1件。頻度で選ぶと consistency になるが、
  // 完走できていない事実の方が重い。
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(row({ recordedAt: '2026-08-0' + (i + 1) + 'T00:00:00Z', incidents: 1 }));
  rows.push(row({ recordedAt: '2026-08-09T00:00:00Z', dnf: true, finishPos: null }));
  const issue = P.primaryIssue(rows);
  ck('DNFがあれば completion を主因にする',
    issue.category === 'completion' && issue.actionable === true, JSON.stringify(issue));
  ck('主因は常に1つだけ返す', typeof issue.category === 'string' && !Array.isArray(issue.category));

  ck('平均8以上は incident_control',
    P.primaryIssue([row({ incidents: 9 }), row({ incidents: 8 })]).category === 'incident_control');
  ck('平均4以上は racecraft',
    P.primaryIssue([row({ incidents: 5 }), row({ incidents: 4 })]).category === 'racecraft');
  ck('4順位以上失えば conversion',
    P.primaryIssue([row({ incidents: 1, startPos: 5, finishPos: 10 })]).category === 'conversion');
  ck('それ以外は consistency',
    P.primaryIssue([row({ incidents: 1, startPos: 8, finishPos: 8 })]).category === 'consistency');

  const focus = P.nextFocus(P.analyze([row({ incidents: 9 })]));
  ck('改善案も一つだけ', !!focus.key && !!focus.target && !Array.isArray(focus.target), JSON.stringify(focus));
}

// ── ④ レース後は事実1つ＋答えやすい質問1つ ──────────────────────────
console.log('══ ④ デブリーフの質問 ══');
{
  const q = P.debriefQuestion(row({ incidents: 6 }), { category: 'racecraft' });
  ck('事実を先に述べる', /Incidents 6/.test(q.line), q.line);
  ck('答えやすい二択・三択で聞く', /？/.test(q.line) && /側/.test(q.line), q.line);
  ck('抽象的な「どうだった？」を使わない', !/どうだった/.test(q.line), q.line);
  const conv = P.debriefQuestion(row({ incidents: 2, startPos: 5, finishPos: 12 }), { category: 'conversion' });
  ck('conversion では失った局面を聞く', /序盤、中盤、終盤/.test(conv.line), conv.line);
  const dnf = P.debriefQuestion(row({ dnf: true, finishPos: null }), { category: 'completion' });
  ck('DNFは原因の三択で聞く', /接触、機械、それとも判断ミス/.test(dnf.line), dnf.line);
  const blind = P.debriefQuestion(row({ incidents: null, startPos: null, finishPos: null }), null);
  ck('事実が無ければ質問しない', blind.speak === false && !/？/.test(blind.line), blind.line);
}

// ── ⑤ 目標を保証しない ─────────────────────────────────────────────
console.log('══ ⑤ iRatingを保証しない ══');
{
  const g = P.goalStatus([row({ irating: 2100 }), row({ irating: 2050 })]);
  ck('連続数を数える', g.streak === 2 && g.goal_irating === 2000 && g.streak_target === 10, JSON.stringify(g));
  ck('保証しないことを明示する', g.guaranteed === false);
  ck('達成前に met=true にしない', g.met === false);
  ck('文言に上昇の約束を含めない',
    !/上がる|必ず|保証|達成できる|3k|3000/.test(g.line), g.line);
  ck('記録が無ければ null を返す（0にしない）',
    P.goalStatus([]).streak === null && P.goalStatus([]).met === null);
  const below = P.goalStatus([row({ irating: 2100 }), row({ irating: 1950 })]);
  ck('割った時点で連続は途切れる', below.streak === 0, JSON.stringify(below.streak));
  // 3k は「検証後の挑戦目標」として仕様本文に書かれている。禁じたいのは
  // *目標値として持つこと* と *発話に出すこと*であって、注意書きではない。
  ck('目標定数は2000のままで3000を持たない',
    P.GOAL_IRATING === 2000 && !/GOAL[_A-Z]*\s*=\s*3000/.test(fs.readFileSync('desktop/pddp.js', 'utf8')));
  ck('発話文に3kを出さない',
    !/3k|3000/.test(P.goalStatus([{ irating: 2100 }]).line)
    && !/3k|3000/.test(P.briefingLine(P.analyze([{ incidents: 2, irating: 2100 }]))));
}

// ── ⑥ 成功も失敗も保存する ─────────────────────────────────────────
console.log('══ ⑥ 失敗した戦略も残す ══');
{
  const improved = P.buildOutcome({ race: row({ incidents: 2 }), baselineIncidents: 6,
    focusKey: 'racecraft', target: '直近レースで半減', now: '2026-08-30T00:00:00Z' });
  ck('改善は improved', improved.outcome === 'improved' && improved.baseline_incidents === 6);
  const worse = P.buildOutcome({ race: row({ incidents: 9 }), baselineIncidents: 6, focusKey: 'racecraft' });
  ck('悪化も同じ形で残す', worse.outcome === 'worse', JSON.stringify(worse.outcome));
  ck('失敗記録も試した内容を保持する', worse.focus_key === 'racecraft');
  const unknown = P.buildOutcome({ race: row({ incidents: null }), baselineIncidents: 6 });
  ck('片方でも欠ければ unknown（推測で採点しない）',
    unknown.outcome === 'unknown' && unknown.result_incidents === null, JSON.stringify(unknown.outcome));
  ck('レースを識別できる', !!improved.race_id);
}

// ── ⑦ 訂正を次回分析へ反映する ─────────────────────────────────────
console.log('══ ⑦ ドライバーの訂正 ══');
{
  const disputedRace = row({ recordedAt: '2026-08-20T00:00:00Z', incidents: 12 });
  const rows = [row({ recordedAt: '2026-08-19T00:00:00Z', incidents: 2 }), disputedRace];
  const before = P.analyze(rows);
  ck('訂正前は高い平均になる', before.average_incidents === 7, JSON.stringify(before.average_incidents));

  let outcomes = [P.buildOutcome({ race: disputedRace, baselineIncidents: 3 })];
  const applied = P.applyDriverCorrection(outcomes, {
    raceId: P.outcomeId(disputedRace), note: 'あれは相手の突っ込みで自分のミスじゃない' });
  ck('訂正が適用される', applied.changed === true && applied.outcomes[0].disputed === true);
  ck('記録は消さずに残す', applied.outcomes.length === 1 && !!applied.outcomes[0].race_id);
  ck('本人の言葉を保持する', /相手の突っ込み/.test(applied.outcomes[0].driver_note));

  const after = P.analyzeExcludingDisputed(rows, applied.outcomes);
  ck('次回分析の母数から外れる',
    after.sample_size === 1 && after.average_incidents === 2, JSON.stringify(after));
  ck('訂正していないレースは残る',
    P.analyzeExcludingDisputed(rows, []).sample_size === 2);
}

// ── ⑧ 走行中の戦略・燃料・反射を横取りしない ────────────────────────
console.log('══ ⑧ 横取り禁止 ══');
{
  ck('briefing では喋ってよい', P.isPddpContext('briefing') === true);
  ck('debrief では喋ってよい', P.isPddpContext('debrief') === true);
  ['race', 'radio', 'reflex', 'fuel', 'strategy', '', null].forEach(ctx =>
    ck(`${JSON.stringify(ctx)} では喋らない`, P.isPddpContext(ctx) === false));
  const src = fs.readFileSync('desktop/pddp.js', 'utf8');
  ck('モジュールが安全コール語彙を持たない',
    !/左に車|右に車|イエロー|停止車両|ボックス/.test(src));
  ck('モジュールが燃料・ピット指示を出さない',
    !/給油設定|この周でピット|pit now/i.test(src));
}

console.log(`\n[PDDP v1] 合格 ${pass} / 不合格 ${fail}`);
process.exit(fail ? 1 : 0);
