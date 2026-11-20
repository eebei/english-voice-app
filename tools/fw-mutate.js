#!/usr/bin/env node
'use strict';
// 給油ウィンドウ監視/ピット完了の変異試験：製品コードを1か所ずつ壊し、検査(unit/e2e)が赤くなることを確認する。ファイルは必ず元へ戻す。
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const M = [
  ['FW1', 'desktop/renderer.html', "if(outcome==='spoken'){cur.state='spoken';w.announced=true;w.armed=false;", "if(true){cur.state='spoken';w.announced=true;w.armed=false;", 'e2e', '再生確定を待たず(破棄でも)通知済みにする'],
  ['FW2', 'desktop/renderer.html', ["if(fuelWindowWatch.armed) releaseFuelWindowWatch('pit_completed');", "if(w.pitCompletions!==undefined&&w.pitCompletions!==ownPitObserver.completions){releaseFuelWindowWatch('pit_completed');return;}"], ["", ""], 'e2e', 'ピット完了で監視を解除しない（解除は2経路の冗長防御：両方外した時に検出）'],
  ['FW3', 'desktop/renderer.html', "const dropped=invalidateQueuedSpeech(['pit_undercut_proposal','fuel_window_watch','pit_post_stop_fuel','fuel_window_forecast','pit_rival_update'],'own_pit_completed');", "const dropped=0;", 'e2e', 'ピット完了で待機中の旧提案を失効させない'],
  ['FW4', 'desktop/undercut-forecast.js', "if (ownStops >= 1 && fuelNow", "if (false && fuelNow", 'unit', '給油後も停止の比較を出し続ける'],
  ['FW5', 'desktop/renderer.html', "} else if(_res&&_res.state==='open'){\n        fuelWindowWatch={armed:false", "} else if(false){\n        fuelWindowWatch={armed:false", 'e2e', '既に開いていてもその場で答えず監視を登録する'],
  ['FW7', 'desktop/renderer.html', "  if(w.pitCompletions!==ownPitObserver.completions) return false;\n  const r=currentFuelWindowResult(lastTelemetry);", "  const r=currentFuelWindowResult(lastTelemetry);", 'e2e', '再生直前の確認でピット完了を見ない'],
  ['FW10', 'desktop/fuel-window.js', "if (cnt < 2) return none(", "if (cnt < 1) return none(", 'unit', '見込みの一時的なぶれ(1回だけ)でも伝える'],
  ['FW11', 'desktop/fuel-window.js', "c.lap_time_s > bestT * SAMPLE_RULES.slow_lap_ratio", "false", 'unit', '長い減速・黄旗の周を燃費サンプルに採用する'],
  ['FW12', 'desktop/renderer.html', "if(!W||!newLap||selMode!=='race'||!live||isSessionEndingLifecycle()||live.on_pit_road===true||ownPitObserver.completions>0||spontaneousMuted()) return;", "if(!W||!newLap||selMode!=='race'||!live||isSessionEndingLifecycle()||live.on_pit_road===true||spontaneousMuted()) return;", 'e2e', '給油済みの後も旧い見込みを出す'],
  ['FW13', 'desktop/undercut-forecast.js', "if (deficit >= D.minDeficitLap && deficit <= D.maxDeficitLap && gapS <= D.maxUnseenS) {", "if (false) {", 'unit', '見えなかった間の遅れから停止を推定しない（#12の停止を見逃し、入った後も「先に入ると」と話す）'],
  ['FW14', 'desktop/undercut-forecast.js', "if (deficit >= D.minDeficitLap && deficit <= D.maxDeficitLap && gapS <= D.maxUnseenS) {", "if (deficit >= -9) {", 'unit', '遅れが小さくても停止と推定する（スピン等の誤検出）'],
  ['FW15', 'desktop/renderer.html', "if(spontaneousMuted()){diagnosticLog('UNDERCUT_PROPOSAL',JSON.stringify({calc_id:packet.undercut_forecast.calc_id,reason,spoken:false,why:'driver_mute'}));return;}", "", 'pitcalls', 'Driverの停止依頼後もU2の自発提案を話す'],
  ['FW16', 'desktop/renderer.html', "(inferred?`${ref.rival_no}番は入ったようだ、`:`${ref.rival_no}番は入った、`)", "`${ref.rival_no}番は入った、`", 'pitcalls', '推定の停止を観測と同じ確度で言う'],
  ['FW17', 'desktop/undercut-forecast.js', "if (!imminent) return { key: prevKey || null, text: null, reason: 'not_imminent' };", "", 'unit', '判断が目前でない遠い周の案も話す'],
  ['FW18', 'desktop/local-intent-router.js', "if(e.fuel_l!==null&&finishShort>0.05){", "if(e.fuel_l!==null&&true){", 'router', '予備の不足だけで「追加を推奨」と言う（完走に必要な不足と希望余裕の不足を混ぜる）'],
  ['FW19', 'desktop/local-intent-router.js', "if (remaining !== null && remaining > 0 && paceNow !== null", "if (false && remaining !== null && remaining > 0 && paceNow !== null", 'router', '時間制の見込み周回数を返さず「まだ確定できない」だけにする'],
  ['FW20', 'desktop/undercut-forecast.js', " && !(s.lastObservedStopT >= s.seen.t)) {", ") {", 'unit', '観測済みの停止の後の欠測を二重に数える'],
  ['FW21', 'desktop/renderer.html', "      const text=(inferred?", "      if(true){ref.announced=true;continue;}\n      const text=(inferred?", 'pitcalls', '再観測しても実測の前後を知らせない'],
  ['FW22', 'desktop/undercut-forecast.js', "if (deficit >= D.minDeficitLap && deficit <= D.maxDeficitLap && gapS <= D.maxUnseenS) {", "if (deficit >= D.minDeficitLap) {", 'unit', 'ピットで説明できない遅れ・長い欠測も停止と推定する（R-FW-1）'],
  ['FW23', 'desktop/renderer.html', "if(samples<3){diagnosticLog('OWN_PIT_NOISE'", "if(false){diagnosticLog('OWN_PIT_NOISE'", 'e2e', '1標本のon_pit_roadノイズを完了と数える（R-FW-4）'],
  ['FW24', 'desktop/renderer.html', "if(gained!==null&&gained>=0.5){", "if(true){", 'e2e', '給油を確かめず通過を「給油完了」と数える（R-FW-4）'],
  ['FW25', 'desktop/renderer.html', "|^(?:もう)?うるさい(?:な|よ|ね)?[。！!、\\s]*$/;", "|うるさい/;", 'pitcalls', '騒音の「うるさい」でも戦略の自発コールを止める（R-FW-2）'],
  ['FW26', 'desktop/renderer.html', "  if(!was){\n    const ack=", "  if(false){\n    const ack=", 'pitcalls', '停止したことをDriverへ返さない（R-FW-2）'],
  ['FW27', 'desktop/local-intent-router.js', "if(lapBurn!==null&&spare<lapBurn)reply+=", "if(false)reply+=", 'router', '余裕が1周の消費量未満でも「入らなくていい」と断定する（R-FW-3）'],
  ['FW28', 'desktop/renderer.html', "if(st&&st.stops>(ref.stops_done||0)){diagnosticLog('UNDERCUT_PROPOSAL_DROPPED','rival_stopped_since rival='+ref.rival_no);return false;}", "", 'pitcalls', '音声開始時に「話した相手が既に入った」を確認しない（R-FW-5）'],
  ['FW29', 'desktop/renderer.html', "return {muted:true,closeTurn:!hasQuestion};", "return {muted:true,closeTurn:false};", 'pitcalls', '停止だけの発話でもターンを閉じず、受領の後に別の発話が続く（R-FW-6）'],
  ['FW30', 'desktop/renderer.html', "  raceRulesState.override=null;raceRulesState.marginPolicy=null;", "", 'rules', '別raceへ給油回数の訂正・余裕の変更を持ち越す'],
  ['FW31', 'desktop/race-rules.js', "if (kind === 'timed' && dur <= rule.max_duration_s) return", "if (kind === 'timed') return", 'rules', '60分を超えるレースにも給油1回を適用する（全レースへ固定値）'],
  ['FW32', 'desktop/undercut-forecast.js', "r.raw.stops_inferred >= r.stops_done\n          // 推定だけの停止は確定扱いにしない", "r.raw.stops_inferred >= 999\n          // 推定だけの停止は確定扱いにしない", 'unit', '推定だけの停止を確定扱いにして脅威から除外する'],
  ['FW33', 'desktop/undercut-forecast.js', "const ownStops = n.ownRefuelsDone !== null ? n.ownRefuelsDone : (", "const ownStops = false ? n.ownRefuelsDone : (", 'unit', 'ドライブスルー等のピット通過で給油回数を消費する'],
  ['FW34', 'desktop/renderer.html', "margin_l:currentMarginLiters(f.burn_l)}):null;", "margin_l:fuelWindowMarginL}):null;", 'e2e', '余裕の設定(周数×燃費)を窓の判定に使わない'],
  ['FW35', 'desktop/local-intent-router.js', "const usePolicy=policyLaps!==null&&", "const usePolicy=false&&", 'router', '余裕の周数設定を燃料回答に使わず、固定の予備2Lで二重に数える'],
  ['FW36', 'desktop/renderer.html', "  }else if(COVERAGE_QUESTION_RE.test(text)){", "  }else if(false){", 'pitcalls', '認識範囲の質問に決定論で答えない'],
  ['FW37', 'desktop/race-rules.js', "if (/回目|[0-9０-９一二三]\\s*回\\s*目|", "if (/ZZZ|ZZZ|", 'rules', '序数（次のピットは2回目）を給油回数の言い直しと読む（R-RR-1）'],
  ['FW38', 'desktop/renderer.html', "    diagnosticLog('RACE_RULES','refuel count restated='", "    raceRulesState.override={refuels_required:stated.refuels_stated,at:Date.now()};\n    diagnosticLog('RACE_RULES','refuel count restated='", 'rules', '会話の「給油は2回」でレース設定を上書きする（R-RR-1）'],
  ['FW39', 'desktop/renderer.html', "reserve_l:(()=>{const m=burn?currentMarginLiters(burn):null;", "reserve_l:(()=>{const m=null;", 'rules', '余裕の設定をSTR-001/U2の入力へ接続しない（固定0.5Lのまま）'],
  ['FW40', 'desktop/undercut-forecast.js', "c.state !== 'observed' && !evaluatedIds.has(c.i));", "c.state !== 'observed');", 'unit', '評価できている車が評価外にも載る（認識範囲の矛盾）'],
  ['FW41', 'desktop/undercut-forecast.js', "(inferredRival ? 'が給油済みなら' : 'は給油済みで')", "(inferredRival ? 'が未給油なら' : 'は給油済みで')", 'unit', '給油済みの仮定でも「未給油なら」と言う'],
  ['FW42', 'desktop/renderer.html', "  if(R&&pol&&pol.source==='driver_setting'){const L=R.marginLiters(pol,burn);if(L!==null) return L;}", "", 'rules', '直接L指定がDriverの周数訂正を上書きする'],
  ['FW8', 'desktop/fuel-window.js', "if (target <= cap + 1e-9) {", "if (target <= cap + 1e9) {", 'unit', '容量に収まらなくても開き扱いにする'],
  ['FW9', 'desktop/renderer.html', "if(postPitFuel.pendingFor===0||postPitFuel.announcedFor===postPitFuel.pendingFor) return;", "if(postPitFuel.pendingFor===0) return;", 'e2e', '給油後の同じ結論を繰り返す'],
];
let surv = 0;
for (const [id, file, from, to, suite, note] of M) {
  const p = path.join(ROOT, file), orig = fs.readFileSync(p, 'utf8');
  const froms = Array.isArray(from) ? from : [from], tos = Array.isArray(to) ? to : [to];
  if (froms.some(f => orig.split(f).length !== 2)) { console.log('ANCHOR?', id); surv++; continue; }
  try {
    let mut = orig; froms.forEach((f, k) => { mut = mut.replace(f, tos[k]); });
    fs.writeFileSync(p, mut);
    const scripts = suite === 'unit' ? ['tests-fuel-window.js', 'tests-u2-undercut-forecast.js'] : suite === 'pitcalls' ? ['tests-pit-calls-e2e.js'] : suite === 'router' ? ['tests-fuel-memory-planning.js', 'tests-local-intent-router.js'] : suite === 'rules' ? ['tests-race-rules.js', 'tests-race-rules-e2e.js'] : ['tests-fuel-window-e2e.js'];
    let red = [];
    for (const sc of scripts) { const r = spawnSync(process.execPath, [sc], { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 400000 }); const out = (r.stdout || '') + (r.stderr || ''); red = red.concat(out.split('\n').filter(l => l.startsWith('❌')).map(l => l.slice(0, 50))); if (!red.length && r.status !== 0) red.push('exit=' + r.status + '（assertで停止）'); }
    console.log((red.length ? 'killed  ' : 'SURVIVED'), id, note, '→', red.slice(0, 3).join(' | '));
    if (!red.length) surv++;
  } finally { fs.writeFileSync(p, orig); }
}
console.log('\n変異 ' + M.length + '件 生存 ' + surv); process.exit(surv ? 1 : 0);
