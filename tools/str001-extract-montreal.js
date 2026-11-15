#!/usr/bin/env node
'use strict';
// STR-001：Build306 Montreal 公式レース（sub:89653165）のBridgeデバッグログから、各Lap時点で「その時点までに観測できた」
// 自車の入力だけを取り出し、fixtures/str001/ に固定する。ログ本体（32MB）はrepo外 pitwall-local-evidence に置く。
//   node tools/str001-extract-montreal.js <log> [outDir]
// 出力は2ファイル：
//   montreal-sub89653165-inputs.json            … 計算の入力（各Lap観測＋その時刻より前に観測済みの校正）。未来の値を含まない。
//   montreal-sub89653165-outcome-verification-only.json … 終了後の実績。検証側だけが読む（計算は読まない）。
// ログに無い値（他車の周回・ペース・停止、全車の連続データ）は取らない。補う場合は計算側で source:'assumed'/'synthetic' と明示する。
const fs = require('fs');
const path = require('path');

const RACE = 'sub:89653165';
const logPath = process.argv[2];
const outDir = process.argv[3] || path.join(__dirname, '..', 'fixtures', 'str001');
if (!logPath) { console.error('usage: node tools/str001-extract-montreal.js <log> [outDir]'); process.exit(2); }

const lines = fs.readFileSync(logPath, 'utf8').split('\n');
const num = v => { if (v === undefined || v === null || v === 'None') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const wallOf = l => { const m = l.match(/^\[(\d\d:\d\d:\d\d)\]/); return m ? m[1] : null; };
const sec = w => { const [h, m, s] = w.split(':').map(Number); return h * 3600 + m * 60 + s; };

// 対象raceの行範囲＝そのrace_instance_idのBOX AUTHORITY snapshotが現れる最初〜最後（他sessionは除外）
let first = -1, last = -1;
const snaps = [];   // {wall, session_time_s}
lines.forEach((l, i) => {
  if (l.includes('"race_instance_id": "' + RACE + '"')) {
    if (first < 0) first = i; last = i;
    const m = l.match(/"session_time_s": ([0-9.]+)/);
    if (m) snaps.push({ wall: wallOf(l), t: Number(m[1]) });
  }
});
if (first < 0) { console.error('race not found: ' + RACE); process.exit(3); }
const sessionTimeAt = wall => { const w = sec(wall); let best = null; for (const s of snaps) { if (sec(s.wall) <= w) best = s; else break; } return best ? Math.round((best.t + (w - sec(best.wall))) * 10) / 10 : null; };

const body = lines.slice(first, last + 1);
const dc = [];       // DATA CHECK rows
const finalLap = {}; // lap -> {wall, time_remaining_s, driver_avg_s, leader_avg_s}
const services = []; // PIT SERVICE sample（race前の練習を含む＝全体から取り、観測時刻より前のものだけを計算に渡す）
const calibs = [];   // PIT LOSS calibration
lines.forEach((l, i) => {
  const w = wallOf(l);
  if (!w) return;
  if (l.includes('PIT SERVICE sample:')) {
    try { const j = JSON.parse(l.slice(l.indexOf('{'))); services.push({ wall: w, in_race_window: i >= first && i <= last, fuel_added_l: j.fuel_added_l, stall_s: j.stall_s, lane_total_s: j.lane_total_s, fuel_service: j.fuel_service || null }); } catch { /* skip */ }
  }
  if (l.includes('PIT LOSS calibration:')) {
    const g = k => { const m = l.match(new RegExp("'" + k + "': ([0-9.]+)")); return m ? Number(m[1]) : null; };
    calibs.push({ wall: w, in_race_window: i >= first && i <= last, lane_total_median_s: g('lane_total_median_s'), normal_segment_median_s: g('normal_segment_median_s'),
      observed_loss_median_s: g('observed_loss_median_s'), observed_loss_q1_s: g('observed_loss_q1_s'), observed_loss_q3_s: g('observed_loss_q3_s'),
      fuel_rate_s_per_l: g('fuel_rate_s_per_l'), fixed_stall_s: g('fixed_stall_s') });
  }
});
body.forEach(l => {
  const w = wallOf(l);
  if (l.includes('DATA CHECK ->')) {
    const d = {}; for (const m of l.split('->')[1].matchAll(/(\w+):(\S+)/g)) d[m[1]] = m[2];
    dc.push({ wall: w, lap: num(d.Lap), pos: num(d.Pos), last_lap_s: num(d.LastLap), fuel_l: num(d.Fuel), gap_ahead_s: num(d.gapAhead), gap_behind_s: num(d.gapBehind),
      on_pit: d.OnPit === 'True', driver_state: d.DriverState, sess_state: num(d.SessState) });
  }
  const f = l.match(/FINAL LAP DIAG lap=(\d+) .*?driverAvg=([0-9.]+) leaderAvg=([0-9.]+) timeRem=([0-9.]+)/);
  if (f) finalLap[Number(f[1])] = { wall: w, driver_avg_s: Number(f[2]), leader_avg_s: Number(f[3]), time_remaining_s: Number(f[4]) };
});

// 各Lapの観測＝そのLap番号が最初に現れた「走行中・ピット外」のDATA CHECK（Lap頭の直後）
const rows = [];
const seen = new Set();
for (const r of dc) {
  if (r.driver_state !== 'track' || r.on_pit || !(r.lap >= 1) || seen.has(r.lap)) continue;
  seen.add(r.lap);
  const fl = finalLap[r.lap];
  rows.push({ lap: r.lap, wall: r.wall, session_time_s: sessionTimeAt(r.wall), pos: r.pos, last_lap_s: r.last_lap_s > 0 ? r.last_lap_s : null, fuel_l: r.fuel_l,
    gap_ahead_s: r.gap_ahead_s, gap_behind_s: r.gap_behind_s,
    time_remaining_s: fl && fl.time_remaining_s < 3000 && sec(fl.wall) - sec(r.wall) < 30 && sec(fl.wall) >= sec(r.wall) - 5 ? fl.time_remaining_s : null,
    source: 'observed_bridge_debug_log' });
}
// ピット滞在の事実（観測済みの区間）：その時点でピット内にいた事実だけ。将来の停止は入力にしない。
const pitVisits = [];
let cur = null;
for (const r of dc) {
  if (r.on_pit && r.driver_state !== 'garage') { if (!cur) cur = { wall_in: r.wall, lap_at_entry: r.lap, fuel_in_l: r.fuel_l }; cur.wall_out = r.wall; cur.fuel_out_l = r.fuel_l; cur.lap_at_exit = r.lap; }
  else if (cur) { pitVisits.push(cur); cur = null; }
}
if (cur) pitVisits.push(cur);

const inputs = {
  schema: 'str001_replay_inputs_v1',
  race_instance_id: RACE, track: 'Circuit Gilles Villeneuve (Montreal)', car: 'Mercedes-AMG GT3 2020', series_hint: 'IMSA23', build: 'Build 306',
  source_log: path.basename(logPath), source_note: 'Bridgeデバッグログ（約5秒間隔のDATA CHECK＋Lap単位の診断行）。全車の連続データではない。',
  rows,
  pit_service_samples: services.map(s => ({ wall: s.wall, in_race: s.in_race_window, fuel_added_l: s.fuel_added_l, stall_s: s.stall_s, lane_total_s: s.lane_total_s, fuel_service: s.fuel_service })),
  pit_calibration_snapshots: calibs.map(c => ({ wall: c.wall, in_race: c.in_race_window, lane_total_median_s: c.lane_total_median_s, normal_segment_median_s: c.normal_segment_median_s,
    observed_loss_median_s: c.observed_loss_median_s, observed_loss_q1_s: c.observed_loss_q1_s, observed_loss_q3_s: c.observed_loss_q3_s, fuel_rate_s_per_l: c.fuel_rate_s_per_l, fixed_stall_s: c.fixed_stall_s })),
  coverage: {
    available: ['自車の周回番号', '総合順位', '前走車/後続車へのGAP(秒・自車基準の隣接2台のみ)', '前Lapタイム', '残燃料(L)', 'ピット内か', '残り時間(timed race)', 'ピット作業の実測サンプル(PIT SERVICE)', 'ピット損失の校正要約(PIT LOSS calibration)'],
    missing: ['全車の周回・位置・ペース(隣接2台以外)', '他車のピット停止状態と停止予定', '他車の燃料・タイヤ', 'クラス別順位(class_posが無い)', '隣接2台の車番・クラス', 'コース・車別の確定済み校正値(通過時間・秒/L)は実測サンプル数が少なく暫定'],
    synthetic_rule: '欠測を補う値は計算側で source:"assumed" または "synthetic" を付ける。このfixture自体には合成値を入れていない。',
  },
};
const outcome = {
  schema: 'str001_replay_outcome_verification_only_v1', race_instance_id: RACE,
  warning: '検証側だけが読む。計算入力に使わない（未来情報の混入になる）。',
  pit_visits: pitVisits,
  final_row: rows[rows.length - 1] || null,
  laps_observed: rows.length,
  last_lap_times_s: rows.map(r => [r.lap, r.last_lap_s]),
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'montreal-sub89653165-inputs.json'), JSON.stringify(inputs, null, 1) + '\n');
fs.writeFileSync(path.join(outDir, 'montreal-sub89653165-outcome-verification-only.json'), JSON.stringify(outcome, null, 1) + '\n');
console.log(`rows=${rows.length} pit_visits=${pitVisits.length} services=${services.length} calibs=${calibs.length} -> ${outDir}`);
