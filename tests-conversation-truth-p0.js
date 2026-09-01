#!/usr/bin/env node
'use strict';

// 2026-08-31 Spielberg 実走の P0 2件（review/CONVERSATION_QUALITY_CONVERGENCE_V1.md §9-1）。
//   型①捏造 : Incidents 不明を 0 と断定して「今回はIncidents 0」と発話した
//   型⑤echo : ドライバーの前回回答（自由文）をそのまま読み上げ、途中で切れた
// どちらも「実例を1件潰した」までしか主張しない。収束判定は §9-5。

const fs = require('fs');
const vm = require('vm');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');
const pddp = require('./desktop/pddp.js');

let pass = 0, fail = 0;
function check(label, ok) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label);
  ok ? pass++ : fail++;
}

// ── 型①捏造：不明を 0 に化けさせない（入口→保存→判断→発話→表示） ──────────

check('Bridge: summary の incidents が `or 0` で 0 に化けない（2箇所とも）',
  !bridge.includes("'incidents': prev_incidents or 0")
  && (bridge.match(/'incidents': prev_incidents if isinstance\(prev_incidents, int\) else None/g) || []).length === 2);

check('Bridge: レースsummaryが止まった条件を RACE SUMMARY GATE に残す',
  bridge.includes('RACE SUMMARY GATE:')
  && bridge.includes('should_fire=') && bridge.includes('lap_time_settled=')
  && bridge.includes('latest_lap_recorded=')
  && bridge.includes('_gate_state != _race_summary_gate_last'));

check('Bridge: 実走で何が読めていたかを INCIDENTS DIAG に残す',
  bridge.includes('INCIDENTS DIAG:')
  && bridge.includes("var_found=")
  && bridge.includes("reader.read_int('PlayerCarMyIncidentCount')"));

check('renderer: live telemetry からの summary で不明を 0 にしない',
  !renderer.includes('incidents:lastTelemetry?.incidents||0')
  && (renderer.match(/incidents:Number\.isInteger\(lastTelemetry\?\.incidents\)\?lastTelemetry\.incidents:null/g) || []).length === 2);

check('renderer: race history へ 0 として保存しない（PDDP の正本）',
  !renderer.includes('incidents:data.incidents||0')
  && renderer.includes('incidents:Number.isInteger(data.incidents)?data.incidents:null'));

check('renderer: 戦歴の読み上げ・表示で null を数値として出さない',
  renderer.includes("インシデント${Number.isInteger(s.incidents)?s.incidents:'記録なし'}")
  && renderer.includes("inc ${Number.isInteger(s.incidents)?s.incidents:'not recorded'}")
  && renderer.includes("(Number.isInteger(h.incidents)?h.incidents:'記録なし')"));

// PDDP は不明を「0」と言ってはならない。8/31 の実際の入力形で再生する。
{
  const raceUnknown = { track: 'Red Bull Ring', car: 'Mercedes-AMG GT3 2020', incidents: null };
  const q = pddp.debriefQuestion(raceUnknown, { category: 'consistency' });
  check('PDDP: incidents 不明で「今回はIncidents 0」と言わない',
    !String(q.line || '').includes('Incidents 0'));
  check('PDDP: 事実が一つも無ければ質問を発話しない（fail-closed）',
    q.speak === false);
}
{
  // 順位が確定していれば、incidents 不明でも答えられる軸へ寄せる（黙り込まない）。
  const raceUnknownWithPos = { incidents: null, startPos: 5, finishPos: 4 };
  const q = pddp.debriefQuestion(raceUnknownWithPos, { category: 'consistency' });
  check('PDDP: incidents 不明でも順位が確定していれば順位の軸で聞く',
    q.speak === true && q.kind === 'conversion' && !String(q.line).includes('Incidents'));
}
{
  // 本物の 0 は 0 と言ってよい。不明と 0 を混同しない。
  const raceZero = { incidents: 0, startPos: 5, finishPos: 4 };
  const q = pddp.debriefQuestion(raceZero, {category: 'consistency'});
  check('PDDP: 実測 0 は従来どおり「Incidents 0」と言える',
    q.speak === true && String(q.line).includes('Incidents 0'));
}
{
  // 8/31 の分類：incidents 不明の行を「0件＝優秀」と誤って扱わない。
  const rows = [{ incidents: null, startPos: 5, finishPos: 4 }];
  const summary = pddp.analyze(rows);
  check('PDDP: 不明の行を incidents 平均へ混ぜない',
    summary.avg_incidents === null || summary.avg_incidents === undefined);
}

check('renderer: 「インシデント0」の称賛が不明値で出ない（parseInt が NaN を弾く）',
  renderer.includes('const inc=parseInt(prev.incidents,10);')
  && renderer.includes("if(Number.isFinite(inc) && inc===0) positives.push('インシデント0');"));

// ── 型⑤echo：ドライバーの自由文を読み上げない ──────────────────────────

check('renderer: 前回のドライバー回答を発話文へ埋め込まない',
  !renderer.includes('前回は「${selected.answer}」と話していた。')
  && !renderer.includes('Last time you said: “${selected.answer}”')
  && !/\$\{selected\.answer\}/.test(renderer));

check('renderer: 記憶コンテキストへ自由文回答を注入しない',
  !renderer.includes('`${x.question} → ${x.answer}`')
  && renderer.includes('const qa=(r.qa||[]).map(x=>String(x?.question||\'\').trim())'));

check('public client: incidents 不明を 0 に丸めずBridge契約(snake_case)を使う',
  !renderer.includes('incidents:data.incidents||0')
  && fs.readFileSync('public/pitwall.html','utf8').includes('incidents:Number.isInteger(data.incidents)?data.incidents:null')
  && !fs.readFileSync('public/pitwall.html','utf8').includes('incidents:data.incidents||0'));

check('renderer: 再利用するのは Luna 自身の前回質問だけ',
  renderer.includes('const prevQuestion=sanitizeOwnFollowupQuestion(selected.question);')
  && renderer.includes('if(!prevQuestion) return null;')
  && renderer.includes('`前回と同じことを聞くね。${prevQuestion}`'));

// sanitizeOwnFollowupQuestion を実際に動かして反証する。
{
  const src = renderer.match(/function sanitizeOwnFollowupQuestion\(raw\)\{[\s\S]*?\n\}/);
  const ctx = { };
  vm.createContext(ctx);
  vm.runInContext(src[0] + '\nthis.f=sanitizeOwnFollowupQuestion;', ctx);
  const f = ctx.f;

  check('sanitize: 通常の自作質問はそのまま聞き直せる',
    f('一番危なかった接触は、こちらから行った側？') === '一番危なかった接触は、こちらから行った側？');
  check('sanitize: 8/31 に流出した長いドライバー自由文を弾く',
    f('接触がちょっと多かったね。あと、オフ トラックが。 4回ぐらいあったかな？ それをちょっと改善しないといけないね。 あとは ドライビング中の目線の持って行き方') === '');
  // 変異試験で判明：長さ上限だけを無効化しても既存assertionは全部通ってしまった。
  // 8/31 の流出文は「？で終わらない」ので長さ以外の規則で弾かれていたため。
  // 疑問符で終わる長文＝自由文が質問形で保存された場合を、長さだけで弾けることを確かめる。
  check('sanitize: 疑問符で終わっても60文字を超える記録は弾く（長さ上限が効いている）',
    f('接触がちょっと多かったね。あと、オフ トラックが4回ぐらいあったかな、それをちょっと改善しないといけないね、目線の持って行き方はどうだった？') === '');
  check('sanitize: 60文字ちょうどは通し、61文字は弾く（境界）',
    f('あ'.repeat(59) + '？') === 'あ'.repeat(59) + '？'
    && f('あ'.repeat(60) + '？') === '');
  check('sanitize: 引用符を含む記録は弾く（他人の言葉を運んでいる）',
    f('前回は「オフトラック」と言っていた？') === '');
  check('sanitize: 質問形でない記録は聞き直さない',
    f('オフトラックが4回あった。') === '');
  check('sanitize: 空・欠損は弾く',
    f('') === '' && f(null) === '' && f(undefined) === '');
  check('sanitize: 改行を含む記録も1行へ正規化して判定する',
    f('今日は\n  どうだった？') === '今日は どうだった？');
  // ★2026-09-01：8/31夜の実走で、朝の質問をそのまま復唱して12時間前の
  //   「今回はIncidents 0」を今日の事実として再生した。測定値を持つ質問は再利用しない。
  check('sanitize: 8/31夜に再放送された質問そのものを弾く',
    f('今回はIncidents 0。一番危なかった接触は、こちらから行った側？受けた側？') === '');
  check('sanitize: 数字を含む質問は弾く（順位・周回・タイムは次回には古い）',
    f('スタートP5からP4。失ったのは序盤、中盤、終盤のどれ？') === ''
    && f('19周目のピットは予定どおりだった？') === '');
  check('sanitize: 事実文＋質問の二文構成を弾く',
    f('後半のペースが落ちている。主因はタイヤだった？') === '');
  check('sanitize: 測定値を持たない純粋な問いは通す',
    f('一番危なかった接触は、こちらから行った側？受けた側？')
      === '一番危なかった接触は、こちらから行った側？受けた側？');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
