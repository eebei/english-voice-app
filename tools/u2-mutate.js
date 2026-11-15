#!/usr/bin/env node
'use strict';
// U2/U3 変異試験：製品コードを1か所ずつ壊し、検査が赤くなる(=検出できる)ことを確認する。生き残った変異は「検査が見ていない配線」。
//   node tools/u2-mutate.js [--only M3,M7] [--no-e2e]
//   各変異：{id, file, from, to, suite:'unit'|'e2e', note}。終了コード0＝全変異を検出。ファイルは必ず元に戻す。
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const NODE_PATH = process.env.NODE_PATH || '';
const M = [
  ['M1', 'desktop/undercut-forecast.js', "cov.clear_claim_allowed = comp.length > 0 && cov.observed_now === comp.length;", "cov.clear_claim_allowed = true;", 'unit', '見えていない車がいても「空いている」と言える'],
  ['M2', 'desktop/undercut-forecast.js', "const pj = j.pace.value, pIn = W / pj;", "const pj = j.pace.value, pIn = 0;", 'unit', '見えていない車を0台として扱う'],
  ['M3', 'desktop/undercut-forecast.js', "pBehind = normalCdf((0 - mu) / sig) - normalCdf((-W / Ls - mu) / sig);", "pBehind = normalCdf((0 - (-mu)) / sig) - normalCdf((-W / Ls - mu) / sig);", 'unit', '推測位置の確率の符号'],
  ['M4', 'desktop/undercut-forecast.js', "sides[side] = { gap: ownT - rivT,", "sides[side] = { gap: rivT - ownT,", 'unit', 'GAPの符号'],
  ['M5', 'desktop/undercut-forecast.js', "const Cprog = Math.max(maxOwnP, sc.stop_lap ?? maxOwnP) + 2;", "const Cprog = Math.max(c.pit_lap, sc.stop_lap === null ? c.pit_lap : sc.stop_lap) + 2;", 'unit', '比較地点が候補ごとに違う'],
  ['M6', 'desktop/undercut-forecast.js', "const rivTraffic = rivTf ? rivTf.cost[riv_side === 'low' ? 'low' : riv_side === 'high' ? 'high' : 'value'] : 0;", "const rivTraffic = 0;", 'unit', '相手の復帰交通を入れない'],
  ['M7', 'desktop/undercut-forecast.js', "if (fe + add > tank + 1e-9) { c.excluded = 'needs_extra_stop';", "if (false) { c.excluded = 'needs_extra_stop';", 'unit', '完走燃料（追加停止が要る案の除外）'],
  ['M8', 'desktop/undercut-forecast.js', "else if (fe < reserve) c.excluded = 'fuel_insufficient_to_reach_pit';", "else if (fe < -1000) c.excluded = 'fuel_insufficient_to_reach_pit';", 'unit', '予備を切る案の除外'],
  ['M9', 'desktop/undercut-forecast.js', "if (snap.session_time_s < lastT - 0.5) { rejected++; return false; }", "if (false) { rejected++; return false; }", 'unit', '時刻が戻る遅着標本を採用'],
  ['M10', 'desktop/undercut-forecast.js', "if (snap.ok === false || snap.gen !== 'consistent') return seal(fail(['snapshot_not_consistent:' + snap.gen]));", "if (false) return seal(fail(['snapshot_not_consistent:' + snap.gen]));", 'unit', '世代混在の標本で計算する'],
  ['M11', 'desktop/undercut-forecast.js', "const leads = Math.abs(gapV) <= eps ? 'close' : (gapV < 0 ? 'own' : 'rival')", "const leads = Math.abs(gapV) <= eps ? 'close' : (gapV < 0 ? 'rival' : 'own')", 'unit', '先に出る側の取り違え'],
  ['M12', 'desktop/undercut-forecast.js', "const behindAll = sameCls.filter(c => c.state !== 'unknown' && posNow(c) < p0 && (p0 - posNow(c)) <= 0.5);", "const behindAll = sameCls.filter(c => c.state !== 'unknown' && posNow(c) < p0);", 'unit', '周回遅れを後続の脅威にする'],
  ['M13', 'desktop/undercut-forecast.js', "return { kind: 'next', text: t };", "return null;", 'unit', '「次周なら？」を焦点にしない'],
  ['M14', 'desktop/undercut-forecast.js', "const sides = {};\n          for (const side of ['value', 'low', 'high']) {", "const sides = {};\n          for (const side of ['value', 'value', 'value']) {", 'unit', '範囲(有利/不利の角)を潰す'],
  ['M15', 'desktop/renderer.html', 'if(_pitAnswer||_referenceJudgeBuffering)continue;', 'if(_referenceJudgeBuffering)continue;', 'e2e', '未検証のストリーム本文をキューに流す'],
  ['M38', 'desktop/undercut-forecast.js', 'if (sc.stop_lap >= Math.floor(N.low))', 'if (false)', 'unit', '相手停止の完走下限を外す'],
  ['M39', 'desktop/undercut-forecast.js', "const direction = d < 0 ? 'ahead' : 'behind';", "const direction = d < 0 ? 'behind' : 'ahead';", 'unit', '合流GAPの前後を逆にする'],
  ['M41', 'desktop/undercut-forecast.js', '&& !(Number.isInteger(planDeadline) && planDeadline <= lap)', '&& true', 'unit', '今周のPlan A期限を無視'],
  ['M42', 'desktop/undercut-forecast.js', 'if (sc.stop_lap < rivalLap)', 'if (false)', 'unit', '過去の相手停止を候補に残す'],
  ['M40', 'desktop/undercut-forecast.js', 'const canWait = canReachNext && (fuelFinishNoStop || rec?.pit_lap > lap)', 'const canWait = true', 'unit', '燃料不足でも待たせる'],
  ['M16', 'desktop/pit-strategy-compare.js', "          if (u.coverage && u.coverage.clear_claim_allowed === false && (u.options || []).some(o => o.rejoin && o.rejoin.clear === true)) bad.push('undercut_clear_claim_with_unobserved');", "", 'e2e', 'サーバーが「空いている」偽造を通す'],
  ['M17', 'desktop/pit-strategy-compare.js', "    next.calc_id = hashString(JSON.stringify(next));\n    return next;", "    next.calc_id = calc_id;\n    return next;", 'e2e', '付け替え後にcalc_idを更新しない'],
  ['M18', 'desktop/renderer.html', "o.kind==='undercut_focus'&&o.at_lap===lap", "o.kind==='undercut_focus'", 'e2e', '焦点を次のLapへ持ち越す'],
  ['M19', 'desktop/renderer.html', "if(undercutState.proposalLapKey===lapKey) return;   // 1Lapに1回まで", "", 'e2e', '同じLapで提案を繰り返す'],
  ['M20', 'desktop/renderer.html', "max_age_s:8,now_s:Date.now()/1000", "max_age_s:1e12,now_s:Date.now()/1000", 'e2e', '古い標本を使う'],
  ['M22', 'server.js', "if (_v.ok && pitStrategyCompare.packetUsable(req.body.pitStrategyCompare)) {", "if (_v.ok && req.body.pitStrategyCompare.comparable === true) {", 'e2e', 'サーバーがundercutだけ成立のパケットを拒否する'],
  ['M23', 'desktop/renderer.html', "  if(sec&&sec.observed_at&&Number.isFinite(sec.observed_at.lap)&&Math.abs(sec.observed_at.lap-lap)>1){", "  if(false){", 'e2e', 'Lapが2周以上ずれた標本を使う（検査があるか）'],
  ['M24', 'desktop/renderer.html', "if(!U||!packet||!packet.undercut_forecast||reason==='driver_opinion'||String(reason||'').startsWith('driver_opinion')) return;", "if(!U||!packet||!packet.undercut_forecast) return;", 'e2e', 'Driverの質問の再計算でも提案を話す'],
  ['M27', 'desktop/pit-strategy-compare.js', "    if (op.kind === 'undercut_focus') return input;\n", "", 'unit', '焦点をSTR-001の仮定として記録する（計算版が動く）'],
  ['M28', 'desktop/undercut-forecast.js', "const after = N.high - P;", "const after = N.high - (P + 1);", 'unit', '完走燃料：停止後の周数を1周短く数える（R-U2-1）'],
  ['M29', 'desktop/undercut-forecast.js', "if (view.own.on_pit_now) return seal(", "if (false) return seal(", 'unit', '自車がピットレーン上でも計算して第二の停止を推奨する（R-U2-3）'],
  ['M30', 'desktop/pit-strategy-compare.js', "if (CLEAR_HEDGE.test(cl)) continue;", "", 'unit', 'Truth Gate：「空いているとは言えない」の正しい説明まで止める（R-U2-2）'],
  ['M31', 'desktop/pit-strategy-compare.js', "混(?:んで|み)(?:い)?(?:ません|ない|なさ)", "混ZZ", 'unit', 'Truth Gate：「混んでいません」を通す（R-U2-2）'],
  ['M32', 'desktop/undercut-forecast.js', "if (sc !== scope) { cars.clear(); scope = sc; lastT = -Infinity; }", "if (sc !== scope) { scope = sc; }", 'unit', '別session/raceで追跡をリセットしない（R-U2-4）'],
  ['M33', 'desktop/undercut-forecast.js', "const unobsCount = cov.dead_reckoned + cov.unknown;", "const unobsCount = cov.unknown;", 'unit', '推測位置の車を「見えていない」数に入れない（R-U2-4）'],
  ['M34', 'desktop/undercut-forecast.js', "rivalFill: { low: 0.7, high: 1.3 },", "rivalFill: { low: 1, high: 1 },", 'unit', '相手の給油量の仮定幅を潰す（R-U2-4）'],
  ['M35', 'desktop/undercut-forecast.js', "'秒先に出られる（自車が後ろになる）。'", "'秒前に出られる。'", 'e2e', '提案文の主語を曖昧に戻す（R-U2-5）'],
  ['M36', 'desktop/pit-strategy-compare.js', "巻き込まれ(?:ません|ない)|", "", 'unit', 'Truth Gate：「渋滞に巻き込まれません」を通す（再検査の漏れ）'],
  ['M37', 'desktop/pit-strategy-compare.js', "(?:(?:現時点|現状|今のところ|いまのところ|今|いま)(?:では|は)?\\s*)?", "", 'unit', 'Truth Gate：「現時点では不明です」を誤検知する（再検査の誤検知）'],
  ['M25', 'desktop/undercut-forecast.js', "stop_required_for_fuel: !fuelFinishNoStop, fuel_note:", "stop_required_for_fuel: true, fuel_note:", 'unit', '燃料だけで完走できても停止が要ると言う'],
  ['M26', 'desktop/undercut-forecast.js', "if (rec.stop_required_for_fuel === false) return {", "if (false) return {", 'unit', '燃料上不要でも停止を促す提案を出す'],
];
const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const noE2e = process.argv.includes('--no-e2e');
function run(suite) {
  const f = suite === 'unit' ? 'tests-u2-undercut-forecast.js' : 'tests-u2-undercut-e2e.js';
  const r = spawnSync(process.execPath, [f], { cwd: ROOT, env: { ...process.env, NODE_PATH }, encoding: 'utf8', timeout: 600000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const red = out.split('\n').filter(l => l.startsWith('❌')).map(l => l.slice(0, 40).trim());
  return { code: r.status, red, tail: out.split('\n').filter(Boolean).slice(-3).join(' ⏎ ').slice(0, 400) };
}
const results = [];
for (const [id, file, from, to, suite, note] of M) {
  if (only.length && !only.includes(id)) continue;
  if (noE2e && suite === 'e2e') continue;
  const p = path.join(ROOT, file); const orig = fs.readFileSync(p, 'utf8');
  if (orig.split(from).length !== 2) { results.push({ id, note, status: 'ANCHOR_NOT_UNIQUE(' + (orig.split(from).length - 1) + ')' }); continue; }
  try {
    fs.writeFileSync(p, orig.replace(from, to));
    const r = run(suite);
    results.push({ id, note, suite, status: r.code === 0 ? 'SURVIVED' : (r.red.length ? 'killed' : 'crash-only'), red: r.red.slice(0, 4), code: r.code, tail: r.tail });
  } finally { fs.writeFileSync(p, orig); }
  console.log(results[results.length - 1].status.padEnd(9), id, suite, note, '→', (results[results.length - 1].red || []).join(' | ') || results[results.length - 1].tail);
}
const surv = results.filter(r => r.status !== 'killed');
console.log('\n変異 ' + results.length + '件：検査の❌で検出 ' + results.filter(r => r.status === 'killed').length + ' ／ 例外で止まっただけ(crash-only) ' + results.filter(r => r.status === 'crash-only').length + ' ／ 生存・不成立 ' + results.filter(r => r.status !== 'killed' && r.status !== 'crash-only').length);
for (const s of surv) console.log('  ✗ ' + s.id + ' ' + s.status + ' ' + s.note);
process.exit(surv.length ? 1 : 0);
