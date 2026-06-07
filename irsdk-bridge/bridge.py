"""
OMORAY PITWALL - iRacing Bridge v2
Reads iRacing shared memory directly using ctypes
Requires: pip install websockets
Usage: python bridge.py
"""

import asyncio
import json
import mmap
import struct
import time
import threading
import websockets

IRSDK_MEMMAPFILE = "Local\\IRSDKMemMapFileName"
PORT = 8765
connected_clients = set()
loop = None

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


def fmt_time(seconds):
    if seconds is None or seconds <= 0:
        return None
    m = int(seconds / 60)
    s = seconds % 60
    return "%d:%06.3f" % (m, s)


reader = IRacingReader()

def poll_iracing():
    ir_was_connected = False
    last_lap = None
    personal_best = None
    lap_times = []

    prev = {
        'pos': None, 'fuel': None, 'lap': None,
        'lapsTot': None, 'onPit': None
    }

    while True:
        if not reader.mm:
            if reader.open():
                print("iRacing memory map opened")
            else:
                time.sleep(2)
                continue

        active = reader.is_active()

        if active and not ir_was_connected:
            print("iRacing connected!")
            broadcast({'type': 'iracing_connected'})
            ir_was_connected = True
            reader.var_cache.clear()

        if not active and ir_was_connected:
            print("iRacing disconnected")
            broadcast({'type': 'iracing_disconnected'})
            ir_was_connected = False
            time.sleep(2)
            continue

        if not active:
            time.sleep(1)
            continue

        # Read all telemetry
        pos      = reader.read_int('PlayerCarPosition')
        lapTime  = reader.read_float('LapLastLapTime')
        bestLap  = reader.read_float('LapBestLapTime')
        delta    = reader.read_float('LapDeltaToBestLap')
        fuel     = reader.read_float('FuelLevel')
        lap      = reader.read_int('Lap')
        lapsTot  = reader.read_int('SessionLapsTotal')
        onPit    = reader.read_bool('OnPitRoad')
        onTrack  = reader.read_bool('IsOnTrack')

        # Tire temps (average front/rear)
        lfTemp   = reader.read_float('LFtempCM')
        rfTemp   = reader.read_float('RFtempCM')
        lrTemp   = reader.read_float('LRtempCM')
        rrTemp   = reader.read_float('RRtempCM')

        # ── Lap completion ──────────────────────────────────────────────
        if lapTime and lapTime > 0 and lapTime != last_lap and lap is not None:
            t = fmt_time(lapTime)
            if t:
                # Personal best check
                if personal_best is None or lapTime < personal_best:
                    if personal_best is not None:
                        diff = personal_best - lapTime
                        broadcast({'type': 'radio', 'trigger': 'personal_best',
                            'message': "Personal best! " + t + ". That's " + str(round(diff, 3)) + " seconds up. Can you back that up?"})
                    personal_best = lapTime
                else:
                    # Compare to best
                    diff = lapTime - personal_best
                    best_t = fmt_time(personal_best)
                    if diff < 0.3:
                        broadcast({'type': 'radio', 'trigger': 'lap_time',
                            'message': "That's a " + t + ". Only " + str(round(diff, 3)) + " off your best. Very consistent."})
                    elif diff < 1.0:
                        broadcast({'type': 'radio', 'trigger': 'lap_time',
                            'message': "That's a " + t + ". " + str(round(diff, 1)) + " off the best. Where are you losing it?"})
                    else:
                        broadcast({'type': 'radio', 'trigger': 'lap_time_slow',
                            'message': "That's a " + t + ". Pace is down. Talk to me, what's happening?"})

                lap_times.append(lapTime)
                last_lap = lapTime

        # ── Position change ─────────────────────────────────────────────
        if pos is not None and prev['pos'] is not None and pos != prev['pos']:
            gained = prev['pos'] - pos
            if gained > 0:
                broadcast({'type': 'radio', 'trigger': 'position_up',
                    'message': "P" + str(pos) + " now. You gained " + str(gained) + ". Keep it clean."})
            else:
                broadcast({'type': 'radio', 'trigger': 'position_down',
                    'message': "P" + str(pos) + ". We lost a position. Talk to me."})

        # ── Fuel warning ────────────────────────────────────────────────
        if fuel is not None and fuel < 5 and (prev['fuel'] is None or prev['fuel'] >= 5):
            broadcast({'type': 'radio', 'trigger': 'fuel_warning',
                'message': "Fuel warning. " + str(round(fuel, 1)) + " litres. Fuel save from now. Confirm."})

        # ── Tire temp info (every 5 laps approx, when all temps available) ──
        if lfTemp and rfTemp and lrTemp and rrTemp and lap and lap % 5 == 0 and lap != prev.get('tempLap'):
            avg_front = (lfTemp + rfTemp) / 2
            avg_rear  = (lrTemp + rrTemp) / 2
            if avg_front < 75:
                broadcast({'type': 'radio', 'trigger': 'tyre_cold',
                    'message': "Front tyres are cold. " + str(round(avg_front)) + " degrees. Get some heat in them."})
            elif avg_front > 105:
                broadcast({'type': 'radio', 'trigger': 'tyre_hot',
                    'message': "Front tyres are overheating. " + str(round(avg_front)) + " degrees. Back off the kerbs."})
            prev['tempLap'] = lap

        # ── Final lap ───────────────────────────────────────────────────
        if lapsTot and lap and lapsTot > 0 and lap == lapsTot and lap != prev['lapsTot']:
            broadcast({'type': 'radio', 'trigger': 'final_lap',
                'message': "Final lap. P" + str(pos) + ". Bring it home. No mistakes."})

        # ── Pit in/out ──────────────────────────────────────────────────
        if onPit and not prev['onPit']:
            broadcast({'type': 'radio', 'trigger': 'pit_entry',
                'message': "Box confirmed. Speed limiter on. Focus."})

        if prev['onPit'] and not onPit and onTrack:
            broadcast({'type': 'radio', 'trigger': 'pit_exit',
                'message': "Out of the pits. P" + str(pos) + ". Build the tyres up, one lap."})

        prev.update({'pos': pos, 'fuel': fuel, 'lap': lap, 'lapsTot': lapsTot, 'onPit': onPit})
        time.sleep(1)


async def handler(websocket):
    connected_clients.add(websocket)
    print("Browser connected (" + str(len(connected_clients)) + " client)")
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
    print("OMORAY PITWALL Bridge v2 started")
    print("WebSocket: ws://localhost:" + str(PORT))
    print("Waiting for iRacing...")
    async with websockets.serve(handler, "localhost", PORT):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
