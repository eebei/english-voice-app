#!/usr/bin/env python3
"""U2：鈴鹿決勝(sub:90078233 session_num=2)の自車入力（残燃料・残り時間）を、同日のBridge debug logから抜いて小さなfixtureにする。
  python3 tools/u2-extract-suzuka-own.py [~/Downloads/OMORAY-bridge-debug-20261113-1039.log] > fixtures/u2/suzuka-own-inputs.json
元ログ（約22MB）はrepo外。ここで使うのは各Lapの先頭の観測だけ：DATA CHECK（自車=CarIdx 22、ピット外の最初の行の Fuel）と FINAL LAP DIAG の timeRem。
結果（eventresult-90078233.json）は検証側だけ。計算の入力には使わない。"""
import hashlib, json, os, re, sys
p = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/Downloads/OMORAY-bridge-debug-20261113-1039.log')
raw = open(p, 'rb').read()
lines = raw.decode('utf-8', 'replace').split('\n')
rx = re.compile(r'\[(\d\d:\d\d:\d\d)\].*DATA CHECK -> Lap:(\d+) Pos:(-?\d+) LastLap:([\d.]+).*?OnPit:(\w+) SessState:(\d) .*?Fuel:([\d.]+) CarIdx:(\d+)')
fl = re.compile(r'FINAL LAP DIAG lap=(\d+) leaderIdx=\S+ .*?timeRem=([\d.]+)')
laps, rem = {}, {}
for i, l in enumerate(lines):
    m = rx.search(l)
    if m and m.group(8) == '22' and m.group(6) == '4' and m.group(5) == 'False':
        lap = int(m.group(2))
        if lap >= 1 and lap not in laps: laps[lap] = {'lap': lap, 'wall': m.group(1), 'fuel_l': float(m.group(7)), 'pos': int(m.group(3)), 'last_lap_s': float(m.group(4)) or None, 'log_line': i + 1}
    f = fl.search(l)
    if f and int(f.group(1)) not in rem: rem[int(f.group(1))] = {'time_remaining_s': float(f.group(2)), 'log_line': i + 1}
out = {'schema': 'u2.suzuka.own_inputs.v1', 'source': {'file': os.path.basename(p), 'sha256_16': hashlib.sha256(raw).hexdigest()[:16], 'lines': len(lines)},
       'race_instance_id': 'sub:90078233', 'session_num': 2, 'own_car_idx': 22, 'tank_start_l': 53.0,
       'note': '各Lap先頭の観測（ピット外の最初のDATA CHECK行）。time_remaining_sはFINAL LAP DIAGのtimeRem（無いLapは未観測＝null）。結果は含めない。',
       'laps': [dict(laps[k], time_remaining_s=(rem.get(k) or {}).get('time_remaining_s')) for k in sorted(laps)]}
print(json.dumps(out, ensure_ascii=False, indent=1))
