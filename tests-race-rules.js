#!/usr/bin/env node
'use strict';
// レース設定（desktop/race-rules.js）：Owner指定「60分以内のショート耐久・給油1回」を出所付きで保持し、観測したレース形式が範囲に入る時だけ適用する。Driverの訂正はそのレース限り。
const R = require('./desktop/race-rules.js');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + n + (ok ? '' : ' -> ' + JSON.stringify(d === undefined ? null : d).slice(0, 400))); ok ? pass++ : fail++; };
const timed = m => ({ kind: 'timed', configured_duration_s: m * 60 });
const a = R.resolve({ race_plan: timed(40) });
ck('RR1 40分のタイムレース（11/15富士）には、Owner設定「給油1回」が適用される（出所=owner_directive）', a.applies && a.refuels_required === 1 && a.source === 'owner_directive' && a.rule_id === 'owner_short_endurance_1_refuel', a);
ck('RR2 60分ちょうどは適用、61分と3時間耐久は適用しない（全レースへ固定値を埋め込まない）。周回制も適用しない', R.resolve({ race_plan: timed(60) }).applies && !R.resolve({ race_plan: timed(61) }).applies && R.resolve({ race_plan: timed(61) }).reason === 'outside_rule_scope' && !R.resolve({ race_plan: timed(180) }).applies && !R.resolve({ race_plan: { kind: 'laps' } }).applies, null);
ck('RR3 形式が未確認(kind不明／時間不明)なら適用せず race_format_unconfirmed', R.resolve({ race_plan: {} }).reason === 'race_format_unconfirmed' && R.resolve({ race_plan: { kind: 'timed' } }).reason === 'race_format_unconfirmed' && !R.resolve({ race_plan: {} }).applies, null);
ck('RR4 Driverの訂正(給油2回)は、設定の範囲外のレースでも、そのレースでは優先される（source=driver_correction）。0回も有効', (() => { const x = R.resolve({ race_plan: timed(180), override: { refuels_required: 2 } }), z = R.resolve({ race_plan: timed(40), override: { refuels_required: 0 } }); return x.applies && x.refuels_required === 2 && x.source === 'driver_correction' && z.applies && z.refuels_required === 0; })(), null);
ck('RR5 ルール自体が無ければ適用しない（no_rule）', R.resolve({ race_plan: timed(40), rule: null }).reason === 'no_rule', null);
const s = R.sentence(a, 0, 'ja');
ck('RR6 確認文：結論から「給油は1回の設定（Owner設定、40分のタイムレース）。済んだのは0回。違えば言って。」', s === '給油は1回の設定（Owner設定、40分のタイムレース）。済んだのは0回。違えば言って。', s);
ck('RR7 範囲外・未確認は、適用していないことと理由を言い、回数の指定を促す。訂正後はあなたの訂正と言う', /60分以内のショート耐久ではないので/.test(R.sentence(R.resolve({ race_plan: timed(180) }), 0, 'ja')) && /形式がまだ確認できていない/.test(R.sentence(R.resolve({ race_plan: {} }), 0, 'ja')) && /あなたの訂正/.test(R.sentence(R.resolve({ race_plan: timed(40), override: { refuels_required: 2 } }), 1, 'ja')), null);
ck('RR8 合計の給油回数の言い直しの解釈（「給油は2回」「ピットストップは1回でいい」「給油なし」）。**序数（次のピットは2回目）・残り（ピットあと2回入る／もう1回入れる）・過去の話・質問は対象にしない**（R-RR-1）', R.parseRefuelStatement('このレースは給油は2回だよ').refuels_stated === 2 && R.parseRefuelStatement('ピットストップは1回でいい').refuels_stated === 1 && R.parseRefuelStatement('今回は給油なしで行く').refuels_stated === 0 && R.parseRefuelStatement('次のピットは2回目になる') === null && R.parseRefuelStatement('ピットあと2回入る') === null && R.parseRefuelStatement('もう1回入れる') === null && R.parseRefuelStatement('最初の給油は1回目だった') === null && R.parseRefuelStatement('給油は何回？') === null && R.parseRefuelStatement('今日は暑い') === null && R.parseRefuelStatement('ピットに入る') === null && R.parseRefuelStatement('前回は給油2回だった') === null && R.parseRefuelStatement('昨日のレースはピット1回だった') === null, null);
ck('RR8b 言い直しへの返答は設定を変えない：形式(40分・給油1回)に矛盾する「給油は2回」には「給油1回の設定のまま、言い直しでは変えない。足りない時は不足量と追加停止の条件を伝える」。一致すれば「設定どおり」。適用しないレースでも「会話では変えない」', (() => { const a = R.resolve({ race_plan: timed(40) }); return /^このレースは給油1回の設定のまま、言い直しでは変えない。足りない時は、不足量と追加の停止が要る条件を伝える。$/.test(R.statementReply(a, 2, 0, 'ja')) && /^給油1回の設定どおり。済んだのは0回。$/.test(R.statementReply(a, 1, 0, 'ja')) && /会話の言い直しでは変えない/.test(R.statementReply(R.resolve({ race_plan: timed(180) }), 2, 0, 'ja')); })(), null);
ck('RR9 確認の質問の解釈（過去のレースの質問は設定の確認にしない）：「給油は何回の設定？」「ピットは何回？」は質問、「給油は2回」は質問ではない', R.isRefuelCountQuestion('給油は何回の設定？') && R.isRefuelCountQuestion('ピットは何回？') && !R.isRefuelCountQuestion('給油は2回だよ') && !R.isRefuelCountQuestion('今日は暑い') && !R.isRefuelCountQuestion('何回ピットで何位でゴールした？') && !R.isRefuelCountQuestion('昨日のレースは何回ピットした？') && !R.isRefuelCountQuestion('前回は給油何回だった？'), null);
ck('RR10 余裕の既定は1周分。「余裕は半周でいい」→0.5周、「1周分」→1周。質問や無関係は訂正にしない', R.marginLaps(null) === 1 && R.parseMarginCorrection('余裕は半周でいい').laps === 0.5 && R.parseMarginCorrection('余裕は0.5周で').laps === 0.5 && R.parseMarginCorrection('余裕は1周分ほしい').laps === 1 && R.parseMarginCorrection('余裕はどのくらい？') === null && R.parseMarginCorrection('今日は暑い') === null, null);
ck('RR10b 余裕の周数の許容範囲（0.5/1/1.5/2周）：9周・12周・0.4周のような許容外は訂正にしない（「12周」を「2周」と読まない）。許容外の周数が設定として入っても既定1周へ（H8）', R.parseMarginCorrection('余裕は9周ほしい') === null && R.parseMarginCorrection('余裕は12周で') === null && R.parseMarginCorrection('余裕は10周') === null && R.parseMarginCorrection('余裕は2周').laps === 2 && R.parseMarginCorrection('余裕は1.5周').laps === 1.5 && R.marginLaps({ laps: 9 }) === 1 && R.marginLaps({ laps: 0.4 }) === 1 && R.marginLaps({ laps: 2 }) === 2 && R.marginLaps({ laps: 0.5 }) === 0.5 && R.marginLiters({ laps: 9 }, 2.7) === 2.7, null);
ck('RR11 余裕(L)＝周数×1周の燃費（2.7L/周で1周分＝2.7L、0.5周分＝1.35L）。燃費が無ければnull。許容外の周数(0.1)は既定1周へ', R.marginLiters({ laps: 1 }, 2.7) === 2.7 && R.marginLiters({ laps: 0.5 }, 2.7) === 1.35 && R.marginLiters(null, 2.7) === 2.7 && R.marginLiters({ laps: 1 }, null) === null && R.marginLaps({ laps: 0.1 }) === 1, null);
const F = R.parseFormatStatement;
const NG_FMT = ['このレースはあと30分で終わる', '今回のレースは残り45分', 'このレース45分じゃないよ', 'このレースは周回レースじゃなくて45分', '45分前にスタート', '45分走った', 'タイヤは45分もたせたい今回のレース', 'プラクティス45分', '1回目の予選が45分', '45分のレースが2回', 'このレースは45分のレースで合ってる', 'このレースは何分？', '前回は45分のレースだった', 'このレースは4分のレース', 'このレースは1441分のレース', '45分のレース', '給油は2回', '今日は暑い', 'このレースは45分のレースかな', 'このレースは45分のタイムレース？', '今回のレースは前回と同じ45分のタイムレース', 'このレースは45分のタイムレースだった', 'このレースはあと45分のレースだ', '今回のレースはまだ45分のレース', '今回は予選45分のレース', '今回はプラクティス45分のレース', '今回は練習45分のレース'];
ck('RR12 形式の明示訂正：「このレースは45分のタイムレース」→2700s、「今回は90分の耐久」→5400s、「周回レース」→laps、「30分のタイムレース、給油は2回」→30分（給油の部分は形式から外す）', F('このレースは45分のタイムレース').duration_s === 2700 && F('今回は90分の耐久だ').duration_s === 5400 && F('このレースは周回レースだよ').kind === 'laps' && F('今日のレースは30分のスプリント').duration_s === 1800 && F('このレースは30分のタイムレース、給油は2回').duration_s === 1800, null);
ck('RR12b 形式にしない入力（残り・あと・否定・前にスタート・走った・もたせ・予選・練習・確認文・質問・過去・4分・1441分・主語なし・給油回数のみ）：' + NG_FMT.length + '件すべて null', NG_FMT.every(t => F(t) === null), NG_FMT.filter(t => F(t) !== null));
ck('RR13 形式訂正で適用可否だけが変わる：90分→不適用(outside_rule_scope)、30分（形式未確認から）→適用・形式の出所=あなたの訂正、周回レースは不適用。給油回数の設定そのものは変えない', (() => { const a = R.resolve({ race_plan: timed(30), format_override: { kind: 'timed', duration_s: 5400 } }), b = R.resolve({ race_plan: {}, format_override: { kind: 'timed', duration_s: 1800 } }), c = R.resolve({ race_plan: timed(30), format_override: { kind: 'laps', duration_s: null } }); return a.applies === false && a.reason === 'outside_rule_scope' && b.applies === true && b.refuels_required === 1 && b.format_source === 'driver_correction' && c.applies === false && /^了解、このレースは30分のタイムレースとして見る。/.test(R.formatReply(b, { kind: 'timed', duration_s: 1800 }, 0, 'ja')); })(), null);
ck('RR14 観測した形式と食い違う訂正は確認が要る（観測180分→45分／観測タイム→周回）。一致（±2分）・観測不明は即採用。確認文は「観測では3時間のタイムレース。45分のタイムレースとして見る？」', (() => { const f45 = { kind: 'timed', duration_s: 2700 }; return R.formatConflicts(timed(180), f45) === true && R.formatConflicts(timed(45), f45) === false && R.formatConflicts(timed(46), f45) === false && R.formatConflicts({}, f45) === false && R.formatConflicts({ kind: 'timed' }, f45) === false && R.formatConflicts(timed(45), { kind: 'laps', duration_s: null }) === true && R.formatConfirmQuestion(timed(180), f45, 'ja') === '観測では3時間のタイムレース。45分のタイムレースとして見る？'; })(), R.formatConfirmQuestion(timed(180), { kind: 'timed', duration_s: 2700 }, 'ja'));
ck('RR15 確認への返答：「はい／うん／お願い」→yes、「いや／違う／そのまま」→no、無関係や「了解」は null（勝手に採用しない）', R.parseConfirmation('はい') === 'yes' && R.parseConfirmation('うん、お願い') === 'yes' && R.parseConfirmation('いや、そのまま') === 'no' && R.parseConfirmation('違う') === 'no' && R.parseConfirmation('了解') === null && R.parseConfirmation('今日は暑い') === null, null);
ck('RR16 形式の読み戻し：「今のレース形式は？」「何分のレース？」は質問、過去や無関係は質問にしない。返答は出所つき（観測／あなたの訂正）', R.isFormatQuestion('今のレース形式は？') && R.isFormatQuestion('このレースは何分のレース？') && !R.isFormatQuestion('前回のレース形式は？') && !R.isFormatQuestion('今日は暑い') && R.formatReadback(R.resolve({ race_plan: timed(40) }), 'ja') === '今は40分のタイムレース、観測。' && R.formatReadback(R.resolve({ race_plan: {}, format_override: { kind: 'timed', duration_s: 2700 } }), 'ja') === '今は45分のタイムレース、あなたの訂正。' && /まだ確認できていない/.test(R.formatReadback(R.resolve({ race_plan: {} }), 'ja')), null);
// Counterexamples for the effective correction contract (not just rule applicability).
{
 const l={race_instance_id:'r',session_num:2,lap:5,driver_pace_median_s:100,race_plan:{kind:'timed',configured_duration_s:10800},session_time_remaining_s:10200};
 const f=R.effectiveFormat(l,{kind:'timed',duration_s:2700},'r|2');
 ck('RR17 timed correction derives 35 minutes from consistent same-race elapsed',f.ready&&f.remaining_s===2100&&f.total_laps===26&&f.crossings===22,f);
 const bad=R.effectiveFormat({...l,session_time_remaining_s:1500},{kind:'timed',duration_s:2700},'r|2');
 ck('RR18 inconsistent elapsed cannot become a corrected finish',!bad.ready&&bad.crossings===null&&bad.missing==='valid_race_elapsed',bad);
 ck('RR19 other session cannot consume correction',!R.effectiveFormat({...l,session_num:3},{kind:'timed',duration_s:2700},'r|2').corrected);
 const lap=R.effectiveFormat({...l,laps_total:999},{kind:'laps'},'r|2');
 ck('RR20 old timed total never substitutes for driver lap-race total',!lap.ready&&lap.total_laps===null&&lap.missing==='total_laps',lap);
 const last=R.effectiveFormat(l,{kind:'laps',total_laps:5},'r|2');
 ck('RR21 total equal to current lap means one final crossing',last.ready&&last.crossings===1,last);
 const unknown=R.effectiveFormat({...l,session_time_remaining_s:null},{kind:'timed',duration_s:2700},'r|2');
 ck('RR22 null remaining does not become zero elapsed or a fabricated finish',!unknown.ready&&unknown.crossings===null,unknown);
}
{
 const anchor={elapsed_s:600,clock_s:1000,epoch:'epoch-a'},fo={kind:'timed',duration_s:2700,elapsed_anchor:anchor};
 const l={race_instance_id:'r',session_num:2,lap:7,driver_pace_median_s:100,race_plan:{kind:'timed',configured_duration_s:10800},session_time_remaining_s:1500,bridge_process_epoch:'epoch-a',canonical_lifecycle:{source_frame:{session_time_s:1601}}};
 const next=R.effectiveFormat(l,fo,'r|2');
 ck('RR23 driver elapsed correction advances with same-session clock beyond five minutes',next.ready&&next.remaining_s===1499,next);
 const changed=R.effectiveFormat({...l,bridge_process_epoch:'epoch-b'},fo,'r|2');
 ck('RR24 process restart cannot reuse elapsed anchor',!changed.ready&&changed.missing==='valid_race_elapsed',changed);
 const rolled=R.effectiveFormat({...l,canonical_lifecycle:{source_frame:{session_time_s:900}}},fo,'r|2');
 ck('RR25 clock rollback cannot reuse elapsed anchor',!rolled.ready,rolled);
}
{
 for(const plan of [{kind:'unknown'},{},{kind:'timed',configured_duration_s:null},{kind:'unrecognized'}]){
  ck('RR26 missing/unknown format is not observed laps: '+JSON.stringify(plan),R.observedFormat(plan)===null&&!R.formatConflicts(plan,{kind:'timed',duration_s:2700}),plan);
  const f=R.effectiveFormat({race_instance_id:'u',session_num:2,lap:5,race_plan:plan},{kind:'timed',duration_s:2700},'u|2');
  const reply=R.calculationStatus(f,'ja');
  ck('RR27 missing format requests elapsed without alleging inconsistency: '+JSON.stringify(plan),reply.includes('訂正した時間に対する経過時間が必要')&&!reply.includes('整合しない'),reply);
 }
 ck('RR28 known laps still conflicts with timed correction',R.observedFormat({kind:'laps'}).kind==='laps'&&R.formatConflicts({kind:'laps'},{kind:'timed',duration_s:2700}));
}
console.log('\n=== race-rules: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
