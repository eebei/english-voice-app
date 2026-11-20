#!/usr/bin/env python3
"""給油ウィンドウ見込みの保存入力：富士(11/15 決勝 sub:90134103 session_num=2)の自車の各Lap先頭の観測を、同日のBridge debug logから抜く。
  python3 tools/fw-extract-fuji.py "~/Downloads/OMORAY-bridge-debug-20261115-1855 (1).log" > fixtures/fw/fuji-20261115-own-laps.json
使うのは各Lap先頭の DATA CHECK（自車=CarIdx 26・ピット外の最初の行：残燃料・直前周回タイム）と FINAL LAP DIAG（Bridgeの残りS/F通過回数・残り時間・トップ/自車の平均ペース）だけ。結果は含めない。"""
import hashlib, json, os, re, sys
p = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/Downloads/OMORAY-bridge-debug-20261115-1855 (1).log')
raw = open(p, 'rb').read(); lines = raw.decode('utf-8', 'replace').split('\n')
dc = re.compile(r'\[(\d\d:\d\d:\d\d)\].*DATA CHECK -> Lap:(\d+) Pos:(-?\d+) LastLap:([\d.]+).*?OnTrack:(\w+) OnPit:(\w+) SessState:(\d) .*?Fuel:([\d.]+) CarIdx:(\d+)')
fl = re.compile(r'\[(\d\d:\d\d:\d\d)\].*FINAL LAP DIAG lap=(\d+) leaderIdx=(\S+) driverDist=([\d.]+) leaderDist=([\d.]+) driverAvg=([\d.]+) leaderAvg=([\d.]+) timeRem=([\d.]+) crossings=(\S+) reason=(\S+) confidence=(\S+)')
laps, diag = {}, {}
for i, l in enumerate(lines):
    m = dc.search(l)
    if m and m.group(9) == '26' and m.group(7) == '4' and m.group(6) == 'False' and m.group(1) >= '19:11:30':
        lap = int(m.group(2))
        if lap >= 1 and lap not in laps: laps[lap] = {'lap': lap, 'wall': m.group(1), 'fuel_l': float(m.group(8)), 'pos': int(m.group(3)), 'last_lap_s': float(m.group(4)) or None, 'log_line': i + 1}
    f = fl.search(l)
    if f and int(f.group(2)) not in diag:
        diag[int(f.group(2))] = {'wall': f.group(1), 'time_remaining_s': float(f.group(8)), 'crossings': None if f.group(9) == 'None' else int(f.group(9)), 'crossings_reason': f.group(10), 'driver_avg_s': float(f.group(6)), 'leader_avg_s': float(f.group(7)), 'log_line': i + 1}
out = {'schema': 'fw.fuji.own_laps.v1', 'source': {'file': os.path.basename(p), 'sha256_16': hashlib.sha256(raw).hexdigest()[:16], 'lines': len(lines)},
       'race_instance_id': 'sub:90134103', 'session_num': 2, 'own_car_idx': 26, 'effective_capacity_l': 53.0, 'own_pit': {'in_lap': 11, 'out_lap': 12, 'note': '11周終わりにIN・12周頭にOUT（全車ログ）。給油量はfuel_lの差(24.0→40.2)から約18.85L'},
       'note': '各Lap先頭の観測（ピット外の最初のDATA CHECK行）とFINAL LAP DIAG。結果は含めない。FINAL LAP DIAGが無いLap(12・18)はcrossingsなし。',
       'laps': [dict(laps[k], **{kk: vv for kk, vv in (diag.get(k) or {}).items() if kk != 'wall'}) for k in sorted(laps)]}
print(json.dumps(out, ensure_ascii=False, indent=1))
