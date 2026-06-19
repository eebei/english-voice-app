"""
OMORAY PITWALL - iRacing Bridge  BUILD 2026-06-19-013
Reads iRacing shared memory directly
Features: lap times, personal best, tire temps, iRating, SOF, Safety Rating, track info
Requires: pip install websockets
Usage: python bridge.py
"""

import asyncio
import os
import sys
import json
import mmap
import ctypes
from ctypes import wintypes
import struct
import time
import random
from datetime import datetime
import threading
import websockets

IRSDK_MEMMAPFILE = "Local\\IRSDKMemMapFileName"
MEM_SIZE = 1164 * 1024
FILE_MAP_READ = 0x0004

try:
    _k32 = ctypes.windll.kernel32
    _k32.OpenFileMappingW.restype = wintypes.HANDLE
    _k32.OpenFileMappingW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    _k32.MapViewOfFile.restype = ctypes.c_void_p
    _k32.MapViewOfFile.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_size_t]
    _k32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
except Exception:
    _k32 = None
PORT = 8765
connected_clients = set()
loop = None

# ログは実行ファイル（exe/py）と同じ場所に書く（どこに置いても動く）
try:
    _base = os.path.dirname(os.path.abspath(sys.argv[0])) or os.getcwd()
except Exception:
    _base = "."
LOG_PATH = os.path.join(_base, "bridge_log.txt")
def log(msg):
    line = "[" + datetime.now().strftime("%H:%M:%S") + "] " + msg
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

def broadcast(event):
    if not connected_clients or loop is None:
        return
    msg = json.dumps(event)
    asyncio.run_coroutine_threadsafe(_broadcast_async(msg), loop)

async def _broadcast_async(msg):
    dead = set()
    for client in connected_clients.copy():
        try:
            await client.send(msg)
        except Exception:
            dead.add(client)
    connected_clients.difference_update(dead)

class IRacingReader:
    H_STATUS = 4
    H_SESSION_INFO_LEN = 16
    H_SESSION_INFO_OFFSET = 20
    H_NUM_VARS = 24
    H_VAR_HEADER_OFFSET = 28
    H_NUM_BUF = 32
    VARBUF_BASE = 48
    VARBUF_STRIDE = 16
    VAR_HEADER_SIZE = 144
    VAR_NAME_OFF = 16

    def __init__(self):
        self._handle = None
        self._ptr = None
        self.var_cache = {}

    def is_open(self):
        return self._ptr is not None

    def open(self):
        # iRacingが作った既存メモリに接続する（自分で作らない＝空マップ誤作成を防ぐ）
        if _k32 is None:
            return False
        h = _k32.OpenFileMappingW(FILE_MAP_READ, False, IRSDK_MEMMAPFILE)
        if not h:
            return False  # iRacing未起動
        ptr = _k32.MapViewOfFile(h, FILE_MAP_READ, 0, 0, 0)
        if not ptr:
            _k32.CloseHandle(h)
            return False
        self._handle = h
        self._ptr = ptr
        return True

    def close(self):
        try:
            if self._ptr:
                _k32.UnmapViewOfFile(ctypes.c_void_p(self._ptr))
            if self._handle:
                _k32.CloseHandle(self._handle)
        except Exception:
            pass
        self._ptr = None
        self._handle = None
        self.var_cache = {}

    def _bytes(self, offset, size):
        return ctypes.string_at(self._ptr + offset, size)

    def _read_int(self, off):
        return struct.unpack('i', self._bytes(off, 4))[0]

    def is_active(self):
        if not self._ptr:
            return False
        try:
            return self._read_int(self.H_STATUS) == 1
        except Exception:
            return False

    def get_buf_offset(self):
        try:
            num_buf = self._read_int(self.H_NUM_BUF)
            best_tick = -1
            best_off = 0
            for i in range(min(num_buf, 4)):
                base = self.VARBUF_BASE + i * self.VARBUF_STRIDE
                tick = self._read_int(base)
                off = self._read_int(base + 4)
                if tick > best_tick:
                    best_tick = tick
                    best_off = off
            return best_off
        except Exception:
            return 0

    def find_var(self, name):
        if name in self.var_cache:
            return self.var_cache[name]
        if not self._ptr:
            return None
        try:
            num_vars = self._read_int(self.H_NUM_VARS)
            var_hdr_off = self._read_int(self.H_VAR_HEADER_OFFSET)
            for i in range(min(num_vars, 600)):
                base = var_hdr_off + i * self.VAR_HEADER_SIZE
                vh = self._bytes(base, self.VAR_HEADER_SIZE)
                if len(vh) < self.VAR_HEADER_SIZE:
                    break
                vtype = struct.unpack_from('i', vh, 0)[0]
                voffset = struct.unpack_from('i', vh, 4)[0]
                raw_name = vh[self.VAR_NAME_OFF:self.VAR_NAME_OFF + 32]
                vname = raw_name.split(b'\x00')[0].decode('utf-8', errors='ignore')
                if vname == name:
                    result = (vtype, voffset)
                    self.var_cache[name] = result
                    return result
        except Exception:
            pass
        return None

    def read_float(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            return struct.unpack('f', self._bytes(self.get_buf_offset() + info[1], 4))[0]
        except Exception:
            return None

    def read_double(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            return struct.unpack('d', self._bytes(self.get_buf_offset() + info[1], 8))[0]
        except Exception:
            return None

    def read_int(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            return struct.unpack('i', self._bytes(self.get_buf_offset() + info[1], 4))[0]
        except Exception:
            return None

    def read_bool(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            return self._bytes(self.get_buf_offset() + info[1], 1)[0] != 0
        except Exception:
            return None

    def read_float_array(self, name, count=64):
        try:
            info = self.find_var(name)
            if not info:
                return None
            data = self._bytes(self.get_buf_offset() + info[1], 4 * count)
            return list(struct.unpack('f' * count, data))
        except Exception:
            return None

    def read_int_array(self, name, count=64):
        try:
            info = self.find_var(name)
            if not info:
                return None
            data = self._bytes(self.get_buf_offset() + info[1], 4 * count)
            return list(struct.unpack('i' * count, data))
        except Exception:
            return None

    def read_session_info(self):
        try:
            si_len = self._read_int(self.H_SESSION_INFO_LEN)
            si_offset = self._read_int(self.H_SESSION_INFO_OFFSET)
            if si_len <= 0 or si_offset <= 0:
                return None
            raw = self._bytes(si_offset, min(si_len, 200000))
            return raw.decode('utf-8', errors='ignore')
        except Exception:
            return None


def parse_session_info(yaml_str):
    result = {}
    if not yaml_str:
        return result
    try:
        # Track name
        for line in yaml_str.split('\n'):
            line = line.strip()
            if line.startswith('TrackName:'):
                result['track'] = line.split(':', 1)[1].strip()
            elif line.startswith('TrackDisplayName:'):
                result['track_display'] = line.split(':', 1)[1].strip()
            elif line.startswith('EventType:'):
                result['event_type'] = line.split(':', 1)[1].strip()

        # Parse drivers for iRating and SOF
        drivers = []
        in_drivers = False
        current_driver = {}
        player_car_idx = -1

        for line in yaml_str.split('\n'):
            stripped = line.strip()
            if 'Drivers:' in line and stripped.startswith('Drivers:'):
                in_drivers = True
                continue
            if in_drivers:
                if stripped.startswith('- CarIdx:'):
                    if current_driver:
                        drivers.append(current_driver)
                    current_driver = {'car_idx': int(stripped.split(':')[1].strip())}
                elif stripped.startswith('IRating:'):
                    try:
                        current_driver['irating'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('LicLevel:'):
                    try:
                        current_driver['lic_level'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('LicSubLevel:'):
                    try:
                        current_driver['lic_sublevel'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('UserName:'):
                    current_driver['name'] = stripped.split(':', 1)[1].strip()
                elif stripped.startswith('IsSpectator:'):
                    try:
                        current_driver['spectator'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('CarClassID:'):
                    try:
                        current_driver['class_id'] = int(stripped.split(':')[1].strip())
                    except:
                        pass
                elif stripped.startswith('CarClassShortName:'):
                    current_driver['class_name'] = stripped.split(':', 1)[1].strip()
                elif stripped.startswith('CarClassRelSpeed:'):
                    try:
                        current_driver['class_rel_speed'] = int(stripped.split(':')[1].strip())
                    except:
                        pass

        if current_driver:
            drivers.append(current_driver)

        # Get player car idx（iRacingの正式名は DriverCarIdx。PlayerCarIdxもフォールバック）
        for line in yaml_str.split('\n'):
            s = line.strip()
            if s.startswith('DriverCarIdx:'):
                try:
                    player_car_idx = int(s.split(':')[1].strip())
                    break
                except:
                    pass
        if player_car_idx < 0:
            for line in yaml_str.split('\n'):
                if 'PlayerCarIdx:' in line:
                    try:
                        player_car_idx = int(line.split(':')[1].strip())
                    except:
                        pass
                    break

        # Calculate SOF (exclude spectators)
        real_drivers = [d for d in drivers if d.get('spectator', 0) == 0 and d.get('irating', 0) > 0]
        if real_drivers:
            sof = int(sum(d['irating'] for d in real_drivers) / len(real_drivers))
            result['sof'] = sof
            result['num_drivers'] = len(real_drivers)

        # Store drivers and player_car_idx for class map
        result['drivers'] = drivers
        result['player_car_idx'] = player_car_idx

        # Get player info
        player = next((d for d in drivers if d.get('car_idx') == player_car_idx), None)
        if player:
            result['player_irating'] = player.get('irating', 0)
            lic_level = player.get('lic_level', 0)
            lic_sublevel = player.get('lic_sublevel', 0)
            # Convert to SR display (e.g., B 4.50)
            lic_names = {1: 'R', 2: 'D', 3: 'C', 4: 'B', 5: 'A'}
            lic_name = lic_names.get(lic_level, '?')
            sr_value = round(lic_sublevel / 100, 2)
            result['safety_rating'] = lic_name + ' ' + str(sr_value)
            result['safety_rating_raw'] = sr_value

        # セクター構成（SplitTimeInfo > Sectors > SectorStartPct）
        sectors = []
        in_split = False
        for line in yaml_str.split('\n'):
            s = line.strip()
            if s.startswith('SplitTimeInfo:'):
                in_split = True
                continue
            if in_split:
                if s.startswith('SectorStartPct:'):
                    try:
                        sectors.append(float(s.split(':', 1)[1].strip()))
                    except:
                        pass
                # SplitTimeInfoブロックの終わり（次のトップレベルキー）で抜ける
                elif s and not s.startswith('-') and not s.startswith('Sector') and ':' in s and not line.startswith(' '):
                    in_split = False
        if sectors:
            result['sectors'] = sorted(sectors)
            result['num_sectors'] = len(sectors)

    except Exception as e:
        print('Session info parse error:', e)

    return result


def fmt_time(seconds):
    if seconds is None or seconds <= 0:
        return None
    m = int(seconds / 60)
    s = seconds % 60
    return "%d:%06.3f" % (m, s)

def fmt_radio(seconds):
    # 本物のF1無線方式：分は省いて秒だけ言う（1:41.587 → 「41.6」）
    # ドライバーは分を分かっているので秒だけで通じる。コロンを消すとTTS誤読も防げる
    if seconds is None or seconds <= 0:
        return None
    if seconds < 60:
        return "%.2f" % seconds
    s_in_min = seconds % 60
    if seconds < 120:
        # 1分台：秒だけ・百分台（41.54）
        return "%.2f" % s_in_min
    # 2分以上は分も付ける：2分5.34秒 → 「2分5.34」
    m = int(seconds / 60)
    return "%d分%.2f" % (m, s_in_min)


reader = IRacingReader()
session_info_sent = False

def poll_iracing():
    global session_info_sent
    ir_was_connected = False
    last_lap_time = None
    session_best = None
    personal_best = None
    prev_current_lap = None
    player_car_idx = -1
    player_class_id = -1
    car_class_map = {}          # car_idx -> class_id
    car_relspeed_map = {}       # car_idx -> rel speed
    player_rel_speed = 0
    is_race_session = False
    inactive_since = None
    multiclass_warned = {}      # car_idx -> last warned time
    battle_warned = {}          # car_idx -> last warned time
    fuel_strategy_warned = False
    session_check_counter = 0
    last_session_sig = None
    consecutive_slow = 0
    debug_counter = 0
    prev_incidents = None
    incident_times = []
    sector_bounds = []          # 例 [0.0, 0.333, 0.667]
    cur_sector = None
    sector_entry_time = None
    lap_sector_times = []
    best_sectors = []
    prev = {
        'pos': None, 'fuel': None, 'lap': None,
        'lapsTot': None, 'onPit': None, 'tempLap': None
    }

    while True:
        if not reader.is_open():
            if reader.open():
                log("iRacing memory map opened (attached to iRacing)")
            else:
                time.sleep(2)
                continue

        active = reader.is_active()

        if active and not ir_was_connected:
            log(">>> iRacing CONNECTED - telemetry flowing")
            session_info_sent = False
            reader.var_cache.clear()
            broadcast({'type': 'iracing_connected'})
            ir_was_connected = True
            inactive_since = None

        # 切断は5秒間ずっと非アクティブな時だけ（ピット・メニュー一瞬のブリップで初期化しない）
        if not active and ir_was_connected:
            if inactive_since is None:
                inactive_since = time.time()
            elif time.time() - inactive_since >= 5.0:
                log("<<< iRacing DISCONNECTED (sustained 5s)")
                broadcast({'type': 'iracing_disconnected'})
                ir_was_connected = False
                session_info_sent = False
                last_session_sig = None
                inactive_since = None
                # ベストタイム/セクターは保持する（週末を通して継続＝エンジニアの記憶）
                reader.close()
                time.sleep(2)
                continue
            # 5秒未満の中断：何もせず維持（記憶も接続も保つ）
            time.sleep(0.3)
            continue
        else:
            inactive_since = None

        if not active:
            time.sleep(1)
            continue

        # Send session info once per connection
        # セッション情報：初回送信＋10秒ごとに変更チェック（練習→レース移行を検知）
        session_check_counter += 1
        if not session_info_sent or session_check_counter >= 100:
            session_check_counter = 0
            yaml_str = reader.read_session_info()
            if yaml_str:
                info = parse_session_info(yaml_str)
                if info.get('player_irating'):
                    sig = str(info.get('event_type', '')) + '|' + str(info.get('sof', '')) + '|' + str(info.get('num_drivers', ''))
                    if sig != last_session_sig:
                        broadcast({'type': 'session_info', 'data': info})
                        log("Session info sent: " + str(info.get('event_type')) + " SOF:" + str(info.get('sof')))
                        last_session_sig = sig
                    session_info_sent = True
                    et = str(info.get('event_type', '')).lower()
                    is_race_session = ('race' in et)
                if 'drivers' in info:
                    for d in info.get('drivers', []):
                        if 'car_idx' in d and 'class_id' in d:
                            car_class_map[d['car_idx']] = d['class_id']
                        if 'car_idx' in d and 'class_rel_speed' in d:
                            car_relspeed_map[d['car_idx']] = d['class_rel_speed']
                player_car_idx = info.get('player_car_idx', -1)
                player_class_id = car_class_map.get(player_car_idx, -1)
                player_rel_speed = car_relspeed_map.get(player_car_idx, 0)
                if info.get('sectors'):
                    sector_bounds = info['sectors']
                    best_sectors = [None] * len(sector_bounds)
                    log("Track sectors detected: " + str(len(sector_bounds)))

        pos         = reader.read_int('PlayerCarPosition')
        lapTime     = reader.read_float('LapLastLapTime')
        currentLap  = reader.read_float('LapCurrentLapTime')
        fuel        = reader.read_float('FuelLevel')
        lap         = reader.read_int('Lap')
        lapsTot     = reader.read_int('SessionLapsTotal')
        onPit       = reader.read_bool('OnPitRoad')
        onTrack     = reader.read_bool('IsOnTrack')
        incidents   = reader.read_int('PlayerCarMyIncidentCount')
        lfTemp      = reader.read_float('LFtempCM')
        rfTemp      = reader.read_float('RFtempCM')
        lrTemp      = reader.read_float('LRtempCM')
        rrTemp      = reader.read_float('RRtempCM')

        # ── 診断ログ：データが実際に読めているか5秒ごとに表示 ──
        debug_counter += 1
        if debug_counter >= 50:
            debug_counter = 0
            spd = reader.read_float('Speed')
            log("DATA CHECK -> Lap:" + str(lap) + " Pos:" + str(pos) +
                " LastLap:" + str(lapTime) + " Speed:" + str(round(spd,1) if spd else None) +
                " OnTrack:" + str(onTrack))


        # ── コントロールライン通過検知（超高速）──────────────────────────
        # LapCurrentLapTimeが大きい値から突然0近くにリセット = ライン通過！
        line_crossed = False
        if (prev_current_lap is not None and currentLap is not None and
                prev_current_lap > 5.0 and currentLap < 2.0):
            line_crossed = True

        prev_current_lap = currentLap

        # ── セクター計測（走行中は黙る・ラップ完了時にデータのみ送信）──
        if sector_bounds and onTrack:
            try:
                dist = reader.read_float('LapDistPct')
                stime = reader.read_double('SessionTime')
                if dist is not None and stime is not None and dist >= 0:
                    # 現在のセクター番号（dist以下で最大の境界のindex）
                    idx = 0
                    for i, b in enumerate(sector_bounds):
                        if dist >= b:
                            idx = i
                    if cur_sector is None:
                        cur_sector = idx
                        sector_entry_time = stime
                    elif idx != cur_sector:
                        st = stime - sector_entry_time if sector_entry_time is not None else 0
                        if 0 < st < 600:
                            while len(lap_sector_times) <= cur_sector:
                                lap_sector_times.append(None)
                            lap_sector_times[cur_sector] = st
                        sector_entry_time = stime
                        # スタート地点に戻った（idx < cur_sector）= ラップ完了 → データ送信
                        if idx < cur_sector and lap_sector_times:
                            secs = []
                            for i, t_ in enumerate(lap_sector_times):
                                if t_ is None:
                                    continue
                                pb = best_sectors[i] if i < len(best_sectors) else None
                                delta = round(t_ - pb, 2) if pb else 0.0
                                is_best = (pb is None or t_ < pb)
                                if is_best and i < len(best_sectors):
                                    best_sectors[i] = t_
                                secs.append({'sector': i + 1, 'time': round(t_, 2),
                                             'delta': delta, 'best': is_best})
                            if secs:
                                broadcast({'type': 'lap_sectors', 'sectors': secs})
                            lap_sector_times = []
                        cur_sector = idx
            except Exception:
                pass

        # ── ラップタイム処理（ライン通過直後に即発火）────────────────────
        if line_crossed and lapTime and lapTime > 0 and lapTime != last_lap_time:
            t = fmt_radio(lapTime)
            if t:
                is_session_best = (session_best is None or lapTime < session_best)
                is_personal_best = (personal_best is None or lapTime < personal_best)

                if is_personal_best:
                    if personal_best is not None:
                        diff = personal_best - lapTime
                        broadcast({'type': 'radio', 'trigger': 'personal_best', 'time': t, 'diff': round(diff, 2),
                            'message': 'Personal best. ' + t + '. Plus ' + str(round(diff, 3)) + '.'})
                    else:
                        broadcast({'type': 'radio', 'trigger': 'first_lap', 'time': t,
                            'message': t + '. Baseline lap.'})
                    personal_best = lapTime
                    session_best = lapTime

                elif is_session_best:
                    diff = lapTime - (personal_best or lapTime)
                    broadcast({'type': 'radio', 'trigger': 'session_best', 'time': t, 'diff': round(diff, 2),
                        'message': 'Session best. ' + t + '.'})
                    session_best = lapTime

                else:
                    diff = lapTime - session_best
                    if diff < 0.3:
                        consecutive_slow = 0
                        broadcast({'type': 'radio', 'trigger': 'lap_consistent', 'time': t,
                            'message': t + '. Consistent.'})
                    elif diff < 1.0:
                        broadcast({'type': 'radio', 'trigger': 'lap_time', 'time': t, 'diff': round(diff, 2),
                            'message': t + '. ' + str(round(diff, 1)) + ' off.'})
                    else:
                        consecutive_slow += 1
                        if consecutive_slow >= 2:
                            # 2周連続スロー＝ドライバーが乱れている可能性。落ち着かせる
                            broadcast({'type': 'radio', 'trigger': 'pace_unstable', 'time': t, 'pos': pos,
                                'message': 'Two laps off. Breathe. Reset. We are still in this. Clean laps to the flag.'})
                            consecutive_slow = 0
                        else:
                            broadcast({'type': 'radio', 'trigger': 'lap_slow', 'time': t,
                                'message': t + '. Pace down. Status?'})

                last_lap_time = lapTime

        # ── インシデント検知（コースオフ/接触/クラッシュ） ──────────────
        if incidents is not None:
            if prev_incidents is not None and incidents > prev_incidents:
                delta = incidents - prev_incidents
                now = time.time()
                incident_times = [t for t in incident_times if now - t < 90]
                incident_times.append(now)
                recent = len(incident_times)
                if recent >= 3:
                    msg = random.choice([
                        'Too many incidents. Calm down. Forget position — just finish.',
                        'That is enough. Reset your head. Clean laps to the flag.',
                        'Stop the risks now. Bring this car home in one piece.'])
                    broadcast({'type': 'radio', 'trigger': 'incident', 'delta': delta, 'recent': recent,
                        'message': msg})
                elif delta >= 4:
                    msg = random.choice([
                        'Contact. Breathe. No more risks now.',
                        'That is contact. Stay calm. Protect what we have.',
                        'Big one. Reset. Clean laps from here.'])
                    broadcast({'type': 'radio', 'trigger': 'incident', 'delta': delta, 'recent': recent,
                        'message': msg})
                elif delta >= 2:
                    msg = random.choice([
                        'Watch it. Bring it back.',
                        'Spin. Collect yourself. We are okay.',
                        'Easy. Settle it down.'])
                    broadcast({'type': 'radio', 'trigger': 'incident', 'delta': delta, 'recent': recent,
                        'message': msg})
                # delta==1（コースオフ）は基本黙る。連発時のみ上のrecent>=3で拾う
            prev_incidents = incidents

        # Position change（レースセッションのみ。練習に順位は無い）
        if is_race_session and pos is not None and prev['pos'] is not None and pos != prev['pos']:
            gained = prev['pos'] - pos
            if gained > 0:
                broadcast({'type': 'radio', 'trigger': 'position_up', 'pos': pos,
                    'message': 'P' + str(pos) + '.'})
            else:
                broadcast({'type': 'radio', 'trigger': 'position_down', 'pos': pos,
                    'message': 'P' + str(pos) + '. Lost one.'})

        # Fuel warning
        if fuel is not None and fuel < 5 and (prev['fuel'] is None or prev['fuel'] >= 5):
            broadcast({'type': 'radio', 'trigger': 'fuel_warning', 'fuel': round(fuel, 1),
                'message': 'Fuel ' + str(round(fuel, 1)) + '. Save mode now.'})

        # Tyre temps: 自動警告は無効化（読んでる変数がカーカス温度で不正確。較正後に復活予定）
        # データ自体は将来デブリーフで参照可能にする

        # Final lap（レースのみ）
        if is_race_session and lapsTot and lap and lapsTot > 0 and lap == lapsTot and lap != prev['lapsTot']:
            broadcast({'type': 'radio', 'trigger': 'final_lap', 'pos': pos,
                'message': 'Final lap. P' + str(pos) + '.'})

        # Pit in/out
        if onPit and not prev['onPit']:
            broadcast({'type': 'radio', 'trigger': 'pit_entry',
                'message': 'Box confirmed. Limiter.'})

        if prev['onPit'] and not onPit and onTrack:
            broadcast({'type': 'radio', 'trigger': 'pit_exit', 'pos': pos,
                'message': 'Out. P' + str(pos) + '. Tyres one lap.'})

        # ── マルチクラス・バトル検知 ────────────────────────────────────
        if player_car_idx >= 0 and not onPit:
            car_est_times = reader.read_float_array('CarIdxEstTime', 64)
            car_class_pos = reader.read_int_array('CarIdxClassPosition', 64)

            if car_est_times and player_car_idx < len(car_est_times):
                player_time = car_est_times[player_car_idx]
                now = time.time()

                for idx, est_time in enumerate(car_est_times):
                    if idx == player_car_idx or est_time <= 0:
                        continue

                    # タイム差（プラスなら後方、マイナスなら前方）
                    delta = player_time - est_time

                    # ── マルチクラス接近警告（自分より速いクラスが後方接近）──
                    other_class = car_class_map.get(idx, -1)
                    other_rel = car_relspeed_map.get(idx, 0)
                    if (other_class != -1 and other_class != player_class_id and
                            other_rel > player_rel_speed):  # CarClassRelSpeedで速いクラス判定
                        if 0 < delta < 5.0:  # 後方5秒以内（IMSA急接近対応）
                            last_warn = multiclass_warned.get(idx, 0)
                            if now - last_warn > 20:
                                broadcast({'type': 'radio', 'trigger': 'multiclass_approaching', 'delta': round(delta, 1),
                                    'message': 'Faster class behind. ' + str(round(delta, 1)) + '. Give room.'})
                                multiclass_warned[idx] = now

                    # ── バトル検知（同クラスが近い・レースのみ）──────────
                    if is_race_session and other_class == player_class_id:
                        if 0 < delta < 1.5:  # 後方1.5秒以内 = バトル中
                            last_warn = battle_warned.get(idx, 0)
                            if now - last_warn > 20:  # 20秒に1回
                                broadcast({'type': 'radio', 'trigger': 'battle_behind', 'delta': round(delta, 1),
                                    'message': 'Behind ' + str(round(delta, 1)) + '. Defend.'})
                                battle_warned[idx] = now
                        elif -1.5 < delta < 0:  # 前方1.5秒以内 = 前を攻める
                            last_warn = battle_warned.get(idx, 0)
                            if now - last_warn > 20:
                                broadcast({'type': 'radio', 'trigger': 'battle_ahead', 'delta': round(abs(delta), 1),
                                    'message': 'Ahead ' + str(round(abs(delta), 1)) + '. In range.'})
                                battle_warned[idx] = now

        prev.update({'pos': pos, 'fuel': fuel, 'lap': lap, 'lapsTot': lapsTot, 'onPit': onPit})
        time.sleep(0.1)  # 0.1秒ポーリング = コントロールライン通過を0.1秒以内に検知


async def handler(websocket):
    connected_clients.add(websocket)
    log("Browser connected (" + str(len(connected_clients)) + " client)")
    try:
        await websocket.send(json.dumps({'type': 'connected'}))
        await websocket.wait_closed()
    finally:
        connected_clients.discard(websocket)

async def main():
    global loop
    loop = asyncio.get_running_loop()
    # ログファイルをリセット（今回のセッションだけ記録）
    try:
        with open(LOG_PATH, "w", encoding="utf-8") as f:
            f.write("=== OMORAY PITWALL Bridge BUILD 2026-06-18-012 ===\n")
    except Exception:
        pass
    t = threading.Thread(target=poll_iracing, daemon=True)
    t.start()
    print("OMORAY PITWALL Bridge  BUILD 2026-06-18-012  started")
    print("WebSocket: ws://localhost:" + str(PORT))
    log("Waiting for iRacing...")
    async with websockets.serve(handler, "localhost", PORT):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
