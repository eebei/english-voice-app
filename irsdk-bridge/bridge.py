"""
OMORAY PITWALL - iRacing Bridge (Python)
Reads iRacing shared memory directly using ctypes (no external libs needed)
Requires: pip install websockets
Usage: python bridge.py
"""

import asyncio
import ctypes
import ctypes.wintypes
import json
import mmap
import struct
import time
import websockets

IRSDK_MEMMAPFILE = "Local\\IRSDKMemMapFileName"
IRSDK_DATAVALIDEVENTNAME = "Local\\IRSDKDataValidEvent"
IRSDK_BROADCASTMSGNAME = "IRSDK_BROADCASTMSG"

PORT = 8765
connected_clients = set()

def broadcast(event):
    if not connected_clients:
        return
    msg = json.dumps(event)
    asyncio.get_event_loop().call_soon_threadsafe(
        lambda: [asyncio.ensure_future(c.send(msg)) for c in connected_clients.copy()]
    )

class IRacingReader:
    def __init__(self):
        self.mm = None
        self.header = None
        self.connected = False
        self.prev = {
            'pos': None, 'lapTime': None, 'fuel': None,
            'lap': None, 'onPit': None
        }

    def open(self):
        try:
            self.mm = mmap.mmap(-1, 1164 * 1024, IRSDK_MEMMAPFILE, access=mmap.ACCESS_READ)
            return True
        except Exception:
            return False

    def read_header(self):
        if not self.mm:
            return False
        self.mm.seek(0)
        data = self.mm.read(112)
        ver, status = struct.unpack_from('ii', data, 0)
        return status == 1

    def find_var(self, name):
        if not self.mm:
            return None
        self.mm.seek(144)
        header_data = self.mm.read(112)
        num_vars = struct.unpack_from('i', header_data, 0)[0]
        var_offset_start = struct.unpack_from('i', header_data, 4)[0]

        self.mm.seek(var_offset_start)
        for i in range(min(num_vars, 300)):
            var_data = self.mm.read(144)
            if len(var_data) < 144:
                break
            var_type = struct.unpack_from('i', var_data, 0)[0]
            offset = struct.unpack_from('i', var_data, 4)[0]
            count = struct.unpack_from('i', var_data, 8)[0]
            var_name = var_data[16:48].decode('utf-8', errors='ignore').rstrip('\x00')
            if var_name == name:
                return (var_type, offset, count)
        return None

    def read_var_float(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            var_type, offset, count = info
            self.mm.seek(0)
            header = self.mm.read(112)
            buf_offset = struct.unpack_from('i', header, 84)[0]
            buf_len = struct.unpack_from('i', header, 80)[0]
            self.mm.seek(buf_offset + offset)
            data = self.mm.read(4)
            return struct.unpack('f', data)[0]
        except Exception:
            return None

    def read_var_int(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            var_type, offset, count = info
            self.mm.seek(0)
            header = self.mm.read(112)
            buf_offset = struct.unpack_from('i', header, 84)[0]
            self.mm.seek(buf_offset + offset)
            data = self.mm.read(4)
            return struct.unpack('i', data)[0]
        except Exception:
            return None

    def read_var_bool(self, name):
        try:
            info = self.find_var(name)
            if not info:
                return None
            var_type, offset, count = info
            self.mm.seek(0)
            header = self.mm.read(112)
            buf_offset = struct.unpack_from('i', header, 84)[0]
            self.mm.seek(buf_offset + offset)
            data = self.mm.read(1)
            return data[0] != 0
        except Exception:
            return None


reader = IRacingReader()

def poll_iracing():
    global connected_clients
    ir_was_connected = False

    while True:
        if not reader.mm:
            if reader.open():
                print("iRacing memory map opened")
            else:
                time.sleep(2)
                continue

        is_active = reader.read_header()

        if is_active and not ir_was_connected:
            print("iRacing connected!")
            broadcast({'type': 'iracing_connected'})
            ir_was_connected = True

        if not is_active and ir_was_connected:
            print("iRacing disconnected")
            broadcast({'type': 'iracing_disconnected'})
            ir_was_connected = False
            time.sleep(2)
            continue

        if not is_active:
            time.sleep(1)
            continue

        pos     = reader.read_var_int('PlayerCarPosition')
        lapTime = reader.read_var_float('LapLastLapTime')
        fuel    = reader.read_var_float('FuelLevel')
        lap     = reader.read_var_int('Lap')
        lapsTot = reader.read_var_int('SessionLapsTotal')
        onPit   = reader.read_var_bool('OnPitRoad')
        onTrack = reader.read_var_bool('IsOnTrack')

        p = reader.prev

        if pos is not None and p['pos'] is not None and pos != p['pos']:
            gained = p['pos'] - pos
            if gained > 0:
                broadcast({'type': 'radio', 'trigger': 'position_up',
                    'message': 'P' + str(pos) + ' now! You gained ' + str(gained) + ' position. Keep the pressure on.'})
            else:
                broadcast({'type': 'radio', 'trigger': 'position_down',
                    'message': 'P' + str(pos) + '. We lost a position. Talk to me, what happened out there?'})

        if lapTime and p['lapTime'] and lapTime > 0 and p['lapTime'] > 0:
            delta = lapTime - p['lapTime']
            if delta > 0.8:
                broadcast({'type': 'radio', 'trigger': 'pace_drop',
                    'message': 'Pace is falling. Last lap ' + str(round(lapTime, 1)) + 's, previous ' + str(round(p['lapTime'], 1)) + 's. That is ' + str(round(delta, 1)) + ' seconds off. Talk to me.'})

        if fuel is not None and fuel < 5 and (p['fuel'] is None or p['fuel'] >= 5):
            broadcast({'type': 'radio', 'trigger': 'fuel_warning',
                'message': 'Fuel warning. ' + str(round(fuel, 1)) + ' litres remaining. Fuel save from now. Confirm.'})

        if lapsTot and lap and lapsTot > 0 and lap == lapsTot and lap != p['lap']:
            broadcast({'type': 'radio', 'trigger': 'final_lap',
                'message': 'Final lap. P' + str(pos) + '. Bring it home clean. No mistakes. You have got this.'})

        if onPit and not p['onPit']:
            broadcast({'type': 'radio', 'trigger': 'pit_entry',
                'message': 'Box confirmed. Tyres and fuel. Speed limiter on. Focus.'})

        if p['onPit'] and not onPit and onTrack:
            broadcast({'type': 'radio', 'trigger': 'pit_exit',
                'message': 'Out of the pits. P' + str(pos) + '. Tyres need a lap to come in. Build it up gradually.'})

        reader.prev = {'pos': pos, 'lapTime': lapTime, 'fuel': fuel, 'lap': lap, 'onPit': onPit}
        time.sleep(1)


async def handler(websocket):
    connected_clients.add(websocket)
    print("Browser connected: " + str(len(connected_clients)) + " client(s)")
    try:
        await websocket.send(json.dumps({'type': 'connected'}))
        await websocket.wait_closed()
    finally:
        connected_clients.discard(websocket)
        print("Browser disconnected")


async def main():
    import threading
    t = threading.Thread(target=poll_iracing, daemon=True)
    t.start()

    print("OMORAY PITWALL Bridge started")
    print("WebSocket: ws://localhost:" + str(PORT))
    print("Waiting for iRacing...")

    async with websockets.serve(handler, "localhost", PORT):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
