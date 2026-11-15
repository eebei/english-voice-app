'use strict';
// STR-001：保存fixture（Montreal sub:89653165）から、指定Lap「時点で観測できた」入力だけを計算器の入力に組み立てる。
// 未来の行・未来の校正・終了結果は読まない（outcome-verification-only.json は検証側だけ）。
// 補った値は source:'assumed'/'synthetic' を付ける。固定の判定しきい値は置かない。
const fs = require('fs');
const C = require('../../desktop/pit-strategy-compare.js');
const path = require('path');
const FIX = path.join(__dirname, 'montreal-sub89653165-inputs.json');
const sec = w => { const [h, m, s] = w.split(':').map(Number); return h * 3600 + m * 60 + s; };
const load = () => JSON.parse(fs.readFileSync(FIX, 'utf8'));

function replayInputAt(fx, lap, overrides, expect) {
  // 観測時刻とsessionで切る：lap番号だけでなく、そのLapを観測した時刻より後に届いた行（遅着/順序異常の過去Lap行）も入力にしない。
  if (expect && expect.race_instance_id && expect.race_instance_id !== fx.race_instance_id) return null;   // 別raceの保存入力は使わない
  const target = fx.rows.find(r => r.lap === lap);
  if (!target) return null;
  const tNow = sec(target.wall);
  const rows = fx.rows.filter(r => r.lap <= lap && sec(r.wall) <= tNow && (r.session_time_s == null || target.session_time_s == null || r.session_time_s <= target.session_time_s));
  const row = rows[rows.length - 1];
  if (!row || row.lap !== lap) return null;
  const clean = rows.filter(r => r.lap >= 3 && r.lap < lap && r.last_lap_s > 80 && r.last_lap_s < 110);   // 直近のクリーンLap（前Lapタイム）。ピット周(>110)・出口周は除く
  const lastClean = rows.filter(r => r.last_lap_s && r.last_lap_s > 80 && r.last_lap_s < 110).slice(-4);
  const lapTime = lastClean.length ? lastClean.reduce((a, r) => a + r.last_lap_s, 0) / lastClean.length : null;
  const bestClean = lastClean.length ? Math.min(...lastClean.map(r => r.last_lap_s)) : null;
  // 燃費：観測済みの燃料減少の中央値（ピット周を除く連続Lap）
  const burns = [];
  for (let i = 1; i < rows.length; i++) { const d = rows[i - 1].fuel_l - rows[i].fuel_l; if (rows[i].lap === rows[i - 1].lap + 1 && d > 1 && d < 6) burns.push(d); }
  burns.sort((a, b) => a - b);
  const burn = burns.length ? burns[Math.floor(burns.length / 2)] : null;
  // 残り時間：このLapで観測、無ければ過去の観測から経過分を引く（派生）
  let timeRem = row.time_remaining_s, timeRemSource = 'observed';
  if (timeRem == null) { const prev = rows.slice().reverse().find(r => r.time_remaining_s != null); if (prev && row.session_time_s != null && prev.session_time_s != null) { timeRem = prev.time_remaining_s - (row.session_time_s - prev.session_time_s); timeRemSource = 'derived'; } }
  // 事前に観測済みのピット実測（この観測時刻より前だけ）
  const pre = fx.pit_service_samples.filter(s => sec(s.wall) < tNow);
  const lastFs = pre.length ? pre[pre.length - 1].fuel_service : null;
  const preCal = fx.pit_calibration_snapshots.filter(c => sec(c.wall) < tNow);
  const q = (value, low, high, source, note) => ({ value, low, high, source, note });
  const lapEst = lapTime;
  const totalLaps = timeRem != null && lapEst ? (() => { const left = Math.ceil(timeRem / lapEst); return q(lap + left, lap + left - 1, lap + left + 1, timeRemSource === 'observed' ? 'assumed' : 'assumed', `時間制: 残り${Math.round(timeRem)}秒÷${lapEst.toFixed(1)}秒/Lap。最終周回は±1`); })() : null;
  const input = {
    meta: { race_instance_id: fx.race_instance_id, session_num: 0, observed_wall: row.wall, observed_session_s: row.session_time_s, lap, position: row.pos, series: fx.series_hint, track: fx.track, car: fx.car },
    total_laps: totalLaps,
    own: {
      fuel_l: q(row.fuel_l, row.fuel_l, row.fuel_l, 'observed'),
      fuel_per_lap_l: burn != null ? q(burn, burns[0], burns[burns.length - 1], 'observed', `観測${burns.length}Lapの燃料減少の中央値`) : null,
      tank_l: q(53, 53, 53, 'observed', 'セッション情報 fuelPhysicalL=106 × fuelLimitRatio=0.5（ログ）'),
      reserve_l: q(0.5, 0.5, 0.5, 'assumed', '予備燃料（仮定。シリーズ規則・Driver設定で置換）'),
      lap_time_s: lapTime != null ? q(lapTime, Math.min(...lastClean.map(r => r.last_lap_s)), Math.max(...lastClean.map(r => r.last_lap_s)), 'observed', `直近${lastClean.length}周のクリーンLap平均`) : null,
      best_clean_lap_s: bestClean != null ? q(bestClean, bestClean, bestClean, 'observed') : null,
    },
    pit: {
      // コース・車別の通過時間：観測済みのPIT SERVICE（練習の停止）の lane_total − stall でピットレーン走行分を出し、
      // 同区間の本線通過時間(normal segment)は、この時点で観測が無いので assumed の幅で置く。
      transit_extra_s: (() => {
        const lane = pre.length ? pre[0].lane_total_s - pre[0].stall_s : null;
        if (lane == null) return null;
        const normal = preCal.length && preCal[preCal.length - 1].normal_segment_median_s != null ? preCal[preCal.length - 1].normal_segment_median_s : null;
        return normal != null ? q(lane - normal, lane - normal - 2, lane - normal + 2, 'observed', 'PIT SERVICE(lane_total−stall) − 本線同区間の実測') : q(lane - 8, lane - 12, lane - 4, 'assumed', `PIT SERVICE(lane_total−stall)=${lane.toFixed(1)}s − 本線同区間(未観測→仮定8s[4,12])`);
      })(),
      fixed_stall_s: lastFs ? q(lastFs.fixed_stall_s, lastFs.fixed_stall_s - 2, lastFs.fixed_stall_s + 2, 'observed', `Bridge校正 n=${lastFs.sample_count}`) : null,
      fuel_rate_s_per_l: lastFs ? q(lastFs.fuel_rate_s_per_l, lastFs.fuel_rate_s_per_l * 0.9, lastFs.fuel_rate_s_per_l * 1.25, 'observed', `Bridge校正 n=${lastFs.sample_count}`) : null,
    },
    field: [],
    field_complete: false,
    // 通常案：現行の燃料計画が無い保存入力では、出所つきの暫定の比較基準（総周回の半分）。燃料の限界周は使わない。
    baseline_pit_lap: totalLaps ? C.provisionalBaselineLap(lap, totalLaps.value) : null,
    baseline_source: 'provisional_even_split',
  };
  // 隣接2台（ログにある唯一の他車情報）。ペースは未観測→自車の直近ペースを仮定(assumed)。停止時期も未観測。
  const mkRival = (id, label, gap) => ({ id, label, gap_s: q(gap, gap, gap, 'observed', '自車基準の隣接GAP'), lap_time_s: lapTime != null ? q(lapTime, lapTime - 0.5, lapTime + 0.5, 'assumed', '未観測→自車の直近ペースと同じと仮定') : null, class_rel: 'same', stops_done: 0, on_pit: false, is_target: id === 'ahead1' });
  if (row.gap_ahead_s != null && row.gap_ahead_s > 0) input.field.push(mkRival('ahead1', '前走車', row.gap_ahead_s));
  if (row.gap_behind_s != null && row.gap_behind_s > 0) input.field.push(mkRival('behind1', '後続車', -row.gap_behind_s));
  const out = Object.assign({}, input, overrides || {});
  return out;
}
module.exports = { load, replayInputAt, FIX };
