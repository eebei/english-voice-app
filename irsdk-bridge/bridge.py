"""
OMORAY PITWALL - iRacing Bridge v7
Reads iRacing shared memory directly
Features: lap times, personal best, tire temps, iRating, SOF, Safety Rating, track info
Requires: pip install websockets
Usage: python bridge.py
"""

import asyncio
import json
import mmap
import struct
import time
from datetime import datetime
import threading
import websockets

IRSDK_MEMMAPFILE = "Local\\IRSDKMemMapFileName"
PORT = 8765
connected_clients = set()
loop = None

def log(msg):
    print("[" + datetime.now().strftime("%H:%M:%S") + "] " + msg, flush=True)

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
    def __init__(self):
        self.mm = None
        self.var_cache = {}

    def open(self):
        try:
            self.mm = mmap.mmap(-1, 1164 * 1024, IRSDK_MEMMAPFILE, access=mmap.ACCESS_READ)
            return True
        except Exception:
            return False

    def is_active(self):
        if not self.mm:
            return False
        try:
            self.mm.seek(0)
            data = self.mm.read(8)
            _, status = struct.unpack_from('ii', data, 0)
            return status == 1
        except Exception:
            return False

    def get_buf_offset(self):
        try:
            self.mm.seek(0)
            header = self.mm.read(112)
            return struct.unpack_from('i', header, 84)[0]
        except Exception:
            return 0

    def find_var(self, name):
        if name in self.var_cache:
            return self.var_cache[name]
        if not self.mm:
            return None
        try:
            self.mm.seek(144)
            header_data = self.mm.read(112)
            num_vars = struct.unpack_from('i', header_data, 0)[0]
            var_offset_start = struct.unpack_from('i', header_data, 4)[0]
            self.mm.seek(var_offset_start)
            for i in range(min(num_vars, 400)):
                var_data = self.mm.read(144)
                if len(var_data) < 144:
                    break
                var_type = struct.unpack_from('i', var_data, 0)[0]
                offset = struct.unpack_from('i', var_data, 4)[0]
                var_name = var_data[16:48].decode('utf-8', errors='ignore').rstrip('\x00')
                if var_name == name:
                    result = (var_type, offset)
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
            buf = self.get_buf_offset()
            self.mm.seek(buf + info[1])
            return struct.unpack('f', self.mm.read(4))[0]
        except Exception:
            return None

    def read_int(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            buf = self.get_buf_offset()
            self.mm.seek(buf + info[1])
            return struct.unpack('i', self.mm.read(4))[0]
        except Exception:
            return None

    def read_bool(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            buf = self.get_buf_offset()
            self.mm.seek(buf + info[1])
            return self.mm.read(1)[0] != 0
        except Exception:
            return None

    def read_float_array(self, name, count=64):
        """CarIdxEstTime などの配列を読む"""
        try:
            info = self.find_var(name)
            if not info:
                return None
            buf = self.get_buf_offset()
            self.mm.seek(buf + info[1])
            data = self.mm.read(4 * count)
            return list(struct.unpack('f' * count, data))
        except Exception:
            return None

    def read_int_array(self, name, count=64):
        """CarIdxClassPosition などの配列を読む"""
        try:
            info = self.find_var(name)
            if not info:
                return None
            buf = self.get_buf_offset()
            self.mm.seek(buf + info[1])
            data = self.mm.read(4 * count)
            return list(struct.unpack('i' * count, data))
        except Exception:
            return None

    def read_session_info(self):
        try:
            self.mm.seek(0)
            header = self.mm.read(112)
            si_offset = struct.unpack_from('i', header, 96)[0]
            si_len = struct.unpack_from('i', header, 100)[0]
            if si_len <= 0 or si_offset <= 0:
                return None
            self.mm.seek(si_offset)
            raw = self.mm.read(min(si_len, 65536))
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

        # Get player car idx
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

    except Exception as e:
        print('Session info parse error:', e)

    return result


def fmt_time(seconds):
    if seconds is None or seconds <= 0:
        return None
    m = int(seconds / 60)
    s = seconds % 60
    return "%d:%06.3f" % (m, s)


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
    multiclass_warned = {}      # car_idx -> last warned time
    battle_warned = {}          # car_idx -> last warned time
    fuel_strategy_warned = False
    session_check_counter = 0
    last_session_sig = None
    consecutive_slow = 0
    prev = {
        'pos': None, 'fuel': None, 'lap': None,
        'lapsTot': None, 'onPit': None, 'tempLap': None
    }

    while True:
        if not reader.mm:
            if reader.open():
                log("iRacing memory map opened")
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

        if not active and ir_was_connected:
            log("<<< iRacing DISCONNECTED")
            broadcast({'type': 'iracing_disconnected'})
            ir_was_connected = False
            session_info_sent = False
            last_session_sig = None
            # メモリマップを閉じて再接続に備える（古いマップを掴んだままだと再検知できないバグ修正）
            try:
                if reader.mm:
                    reader.mm.close()
            except Exception:
                pass
            reader.mm = None
            reader.var_cache.clear()
            time.sleep(2)
            continue

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
                if 'drivers' in info:
                    for d in info.get('drivers', []):
                        if 'car_idx' in d and 'class_id' in d:
                            car_class_map[d['car_idx']] = d['class_id']
                player_car_idx = info.get('player_car_idx', -1)
                player_class_id = car_class_map.get(player_car_idx, -1)

        pos         = reader.read_int('PlayerCarPosition')
        lapTime     = reader.read_float('LapLastLapTime')
        currentLap  = reader.read_float('LapCurrentLapTime')
        fuel        = reader.read_float('FuelLevel')
        lap         = reader.read_int('Lap')
        lapsTot     = reader.read_int('SessionLapsTotal')
        onPit       = reader.read_bool('OnPitRoad')
        onTrack     = reader.read_bool('IsOnTrack')
        lfTemp      = reader.read_float('LFtempCM')
        rfTemp      = reader.read_float('RFtempCM')
        lrTemp      = reader.read_float('LRtempCM')
        rrTemp      = reader.read_float('RRtempCM')

        # ── コントロールライン通過検知（超高速）──────────────────────────
        # LapCurrentLapTimeが大きい値から突然0近くにリセット = ライン通過！
        line_crossed = False
        if (prev_current_lap is not None and currentLap is not None and
                prev_current_lap > 5.0 and currentLap < 2.0):
            line_crossed = True

        prev_current_lap = currentLap

        # ── ラップタイム処理（ライン通過直後に即発火）────────────────────
        if line_crossed and lapTime and lapTime > 0 and lapTime != last_lap_time:
            t = fmt_time(lapTime)
            if t:
                is_session_best = (session_best is None or lapTime < session_best)
                is_personal_best = (personal_best is None or lapTime < personal_best)

                if is_personal_best:
                    if personal_best is not None:
                        diff = personal_best - lapTime
                        broadcast({'type': 'radio', 'trigger': 'personal_best', 'time': t, 'diff': round(diff, 3),
                            'message': 'Personal best. ' + t + '. Plus ' + str(round(diff, 3)) + '.'})
                    else:
                        broadcast({'type': 'radio', 'trigger': 'first_lap', 'time': t,
                            'message': t + '. Baseline lap.'})
                    personal_best = lapTime
                    session_best = lapTime

                elif is_session_best:
                    diff = lapTime - (personal_best or lapTime)
                    broadcast({'type': 'radio', 'trigger': 'session_best', 'time': t, 'diff': round(diff, 3),
                        'message': 'Session best. ' + t + '.'})
                    session_best = lapTime

                else:
                    diff = lapTime - session_best
                    if diff < 0.3:
                        consecutive_slow = 0
                        broadcast({'type': 'radio', 'trigger': 'lap_consistent', 'time': t,
                            'message': t + '. Consistent.'})
                    elif diff < 1.0:
                        broadcast({'type': 'radio', 'trigger': 'lap_time', 'time': t, 'diff': round(diff, 1),
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

        # Position change
        if pos is not None and prev['pos'] is not None and pos != prev['pos']:
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

        # Tyre temps (every 5 laps)
        if lfTemp and rfTemp and lrTemp and rrTemp and lap and lap % 5 == 0 and lap != prev.get('tempLap'):
            avg_front = (lfTemp + rfTemp) / 2
            if avg_front < 75:
                broadcast({'type': 'radio', 'trigger': 'tyre_cold', 'temp': round(avg_front),
                    'message': 'Fronts cold. ' + str(round(avg_front)) + ' degrees.'})
            elif avg_front > 105:
                broadcast({'type': 'radio', 'trigger': 'tyre_hot', 'temp': round(avg_front),
                    'message': 'Fronts hot. Off the kerbs.'})
            prev['tempLap'] = lap

        # Final lap
        if lapsTot and lap and lapsTot > 0 and lap == lapsTot and lap != prev['lapsTot']:
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

                    # ── マルチクラス接近警告（後方から速いクラスが来る）──
                    other_class = car_class_map.get(idx, -1)
                    if (other_class != -1 and other_class != player_class_id and
                            other_class > player_class_id):  # 速いクラス = 大きいclass_id
                        if 0 < delta < 8.0:  # 後方8秒以内
                            last_warn = multiclass_warned.get(idx, 0)
                            if now - last_warn > 30:  # 30秒に1回
                                broadcast({'type': 'radio', 'trigger': 'multiclass_approaching', 'delta': round(delta, 1),
                                    'message': 'Faster class behind. ' + str(round(delta, 1)) + '. Give room.'})
                                multiclass_warned[idx] = now

                    # ── バトル検知（同クラスが近い）──────────────────────
                    if other_class == player_class_id:
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
    t = threading.Thread(target=poll_iracing, daemon=True)
    t.start()
    print("OMORAY PITWALL Bridge v7 started")
    print("WebSocket: ws://localhost:" + str(PORT))
    log("Waiting for iRacing...")
    async with websockets.serve(handler, "localhost", PORT):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
