#!/usr/bin/env node
'use strict';
// U2 — 鈴鹿決勝(sub:90078233 session_num=2)の実U1ログを時間順に再生し、各Lap先頭で undercut-forecast を計算する。
//   入力：U1記録 OMORAY-field-<stamp>-p01..p03.jsonl（repo外。U2_FIELD_LOG_DIR か ~/Downloads）＋自車の各Lap先頭の残燃料・残り時間(fixtures/u2/suzuka-own-inputs.json)。
//   未来を使わない：そのLapの標本までのU1標本だけをtrackerへ入れる。燃料・総周回・ピット作業は、観測できたものと出所付きの仮定だけ。
//   終了結果は読まない（検証側のみ）。
const fs = require('fs'), os = require('os'), path = require('path');
const F = require('../desktop/field-snapshot.js');
const U = require('../desktop/undercut-forecast.js');
const OWN = require('../fixtures/u2/suzuka-own-inputs.json');
const dirOf = () => process.env.U2_FIELD_LOG_DIR || path.join(os.homedir(), 'Downloads');
function findLogs(dir) { try { return fs.readdirSync(dir).filter(f => /^OMORAY-field-20261113-1039-p\d+\.jsonl$/.test(f)).sort().map(f => path.join(dir, f)); } catch (_) { return []; } }
function loadSnapshots(dir) {
  const files = findLogs(dir || dirOf()); if (!files.length) return null;
  const all = []; let bad = 0, rejected = 0;
  for (const f of files) { const p = F.parseLog(fs.readFileSync(f, 'utf8')); bad += p.bad_lines; for (const s of p.snapshots) { const why = F.check(s); if (why) { rejected++; continue; } all.push(s); } }
  const race = all.filter(s => s.race_instance_id === OWN.race_instance_id && s.session_num === OWN.session_num).sort((a, b) => a.seq - b.seq);
  return { files, race, bad_lines: bad, rejected_by_check: rejected, total_valid: all.length };
}
const asm = (v, lo, hi, note) => ({ value: v, low: lo, high: hi, source: 'assumed', note });
// 自車の燃費（観測した燃料の減少の中央値。ピット周を除く）：そのLapより前の観測だけ
function burnUpTo(lap) {
  const rows = OWN.laps.filter(r => r.lap <= lap && r.lap >= 2).sort((a, b) => a.lap - b.lap); const d = [];
  for (let i = 1; i < rows.length; i++) { if (rows[i].lap === rows[i - 1].lap + 1) { const x = rows[i - 1].fuel_l - rows[i].fuel_l; if (x > 1 && x < 8) d.push(x); } }
  if (d.length < 2) return null; d.sort((a, b) => a - b); const m = d[d.length >> 1]; return { value: m, low: d[0], high: d[d.length - 1], source: 'observed', note: '観測' + d.length + 'Lapの燃料減少の中央値' };
}
function inputsAt(lap, snap, tracker) {
  const row = OWN.laps.find(r => r.lap === lap); if (!row) return null;
  const own = tracker.cars.get(snap.player_car_idx), pace = own ? tracker.paceOf(own) : null; if (!pace) return null;
  const burn = burnUpTo(lap); if (!burn) return null;
  const total = row.time_remaining_s ? (() => { const left = Math.ceil(row.time_remaining_s / pace.value); return asm(lap + left, lap + left - 1, lap + left + 1, '時間制: 残り時間÷最近のペース。最終周回は±1'); })() : null;
  return { meta: { race_instance_id: snap.race_instance_id, session_num: snap.session_num },
    own: { fuel_l: { value: row.fuel_l, source: 'observed' }, fuel_per_lap_l: burn, tank_l: { value: OWN.tank_start_l, source: 'observed', note: 'レース開始時の燃料' }, reserve_l: asm(0.5, 0.5, 0.5, '予備燃料（仮定）'),
      lap_time_s: { value: pace.value, low: pace.value - 0.5, high: pace.value + 0.5, source: 'observed', note: '自車の直近の周回タイム(中央値)' } },
    total_laps: total, pit: { transit_extra_s: asm(12, 8, 16, '暫定（校正なし）'), fixed_stall_s: asm(10, 6, 14, '暫定（校正なし）'), fuel_rate_s_per_l: asm(0.4, 0.3, 0.5, '暫定（校正なし）') },
    snapshot: snap, tracker, options: {} };
}
function run(opts) {
  const L = loadSnapshots(opts && opts.dir); if (!L) return null;
  const tracker = U.createTracker(); const out = []; let i = 0; const seenLap = new Set();
  for (const s of L.race) {
    tracker.update(s);
    const me = s.cars.find(c => c.i === s.player_car_idx); if (!me || me.st !== 'ok' || me.l === null || me.d === null) continue;
    if (seenLap.has(me.l) || me.d > 0.25) continue;          // Lap先頭の最初の標本
    if (!OWN.laps.some(r => r.lap === me.l)) continue;
    seenLap.add(me.l);
    const input = inputsAt(me.l, s, tracker); if (!input) { out.push({ lap: me.l, snapshot_seq: s.seq, section: null, skipped: 'missing_input' }); continue; }
    if (opts && opts.mutate) opts.mutate(input, me.l);
    const section = U.compute(input);
    out.push({ lap: me.l, snapshot_seq: s.seq, t: s.session_time_s, section, input });
  }
  return { logs: L, results: out, tracker };
}
const mark = v => (v.leads_at_common_point === 'own' ? '▲' : v.leads_at_common_point === 'rival' ? '▼' : '?');
function describeOption(o) {
  if (o.excluded) return o.id + ' P' + o.pit_lap + ' EXCL ' + o.excluded;
  if (o.same_lap_as) return o.id + ' P' + o.pit_lap + ' same_as ' + o.same_lap_as;
  const rj = o.rejoin;
  return o.id + ' P' + o.pit_lap + ' add=' + o.add_l + ' loss=' + (o.pit_loss_s && o.pit_loss_s.value) + ' traffic=' + JSON.stringify(rj && rj.traffic_loss_s) + ' clear=' + (rj && rj.clear)
    + ' ahead=' + (rj && rj.ahead.length) + ' behind=' + (rj && rj.behind.length) + ' vs=' + o.vs_rivals.map(v => v.rival_no + ':' + v.scenario + ':' + v.gap_s + mark(v)).join(' ');
}
module.exports = { run, loadSnapshots, inputsAt, OWN, findLogs, dirOf };

if (require.main === module) {
  const r = run(); if (!r) { console.error('U1ログが見つからない: ' + dirOf()); process.exit(2); }
  console.log('logs:', r.logs.files.map(f => path.basename(f)).join(', '), ' snapshots(race,valid):', r.logs.race.length, ' bad_lines:', r.logs.bad_lines, ' rejected_by_check:', r.logs.rejected_by_check);
  for (const x of r.results) {
    const s = x.section; if (!s) { console.log('Lap' + x.lap, 'skip', x.skipped); continue; }
    const cov = s.coverage, d = s.decision;
    console.log('Lap' + x.lap, 't=' + (x.t | 0), 'comparable=' + s.comparable, s.blocking ? ' blocking=' + s.blocking.join(',') : '', 'cov', cov.observed_now + '+' + cov.dead_reckoned + '/' + cov.roster_competitors,
      'rear', JSON.stringify((s.rivals || []).map(v => ({ no: v.no, gap: v.gap_now_s, st: v.state }))));
    for (const o of (s.options || [])) console.log('   ', describeOption(o));
    if (d) console.log('    → rec', d.recommendation.option_id, 'P' + d.recommendation.pit_lap, 'worst', d.recommendation.worst_case_gap_s, 'flips', JSON.stringify(d.flips_when.map(f => f.condition + '→' + f.best_option_id)), 'threats', d.rival_first_threats.length);
  }
}
