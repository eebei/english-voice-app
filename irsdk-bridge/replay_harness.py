"""Build 266 — Bridge poll-loop replay harness (Codex差戻し#6).

差戻し#6：「純関数を手で順番に呼ぶだけでは不可。保存telemetry／event fixtureから、
Bridgeの実際の受信→状態→再計算→broadcast→queue fate までを通す再生テストにする。」

そのため、ここでは bridge.poll_iracing() **そのもの** を回す。
呼ぶのは本番の関数であり、写経した簡易版ではない。

差し替えるのは外界との境界だけである。

  reader     → FakeReader（保存フレームを1frameずつ返す）
  broadcast  → 収集器（送信の代わりに記録する）
  log        → 収集器
  time.sleep → no-op

外部APIは一切呼ばない（内部シミュレーション正本 §Non-negotiable rules 1）。
FakeReader はメモリ上の dict しか読まないので、iRacing も HTTP も介在しない。
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


class ReplayComplete(Exception):
    """Raised by the fake reader when the fixture runs out.

    This is how a `while True:` production loop is stopped without editing it.
    """


# 1フレーム分のテレメトリ既定値。fixture は必要な変数だけ上書きすればよい。
DEFAULT_FRAME = {
    'SessionNum': 0,
    'SessionTime': 0.0,
    'SessionState': 4,          # racing
    'SessionFlags': 0,
    'SessionTimeRemain': 3600.0,
    'SessionLapsRemain': 20,
    'SessionLapsTotal': 20,
    'IsOnTrack': True,
    'OnPitRoad': False,
    'PlayerTrackSurface': 3,    # on track
    'PlayerCarPosition': 4,
    'PlayerCarClassPosition': 4,
    'PlayerCarMyIncidentCount': 0,
    'PlayerCarPitSvStatus': 0,
    'Lap': 1,
    'LapDistPct': 0.10,
    'LapLastLapTime': 0.0,
    'LapCurrentLapTime': 0.0,
    'FuelLevel': 40.0,
    'Speed': 55.0,
    'Brake': 0.0,
    'SteeringWheelAngle': 0.0,
    'EngineWarnings': 0,
    'PitRepairLeft': 0.0,
    'PitOptRepairLeft': 0.0,
    'PitsOpen': 1,
    'CarLeftRight': 0,
    'AirTemp': 25.0,
    'TrackTemp': 35.0,
    'TrackTempCrew': 35.0,
    'TrackWetness': 1,
    'RelativeHumidity': 0.4,
    'LFtempCM': 80.0,
    'RFtempCM': 80.0,
    'LRtempCM': 80.0,
    'RRtempCM': 80.0,
}

DEFAULT_ARRAYS = {
    'CarIdxLap': [1, 1, 1],
    'CarIdxLapCompleted': [0, 0, 0],
    'CarIdxLapDistPct': [0.10, 0.30, 0.05],
    'CarIdxPosition': [4, 1, 2],
    'CarIdxClassPosition': [4, 1, 2],
    'CarIdxOnPitRoad': [0, 0, 0],
    'CarIdxTrackSurface': [3, 3, 3],
    'CarIdxEstTime': [10.0, 12.0, 8.0],
    'CarIdxF2Time': [0.0, 0.0, 0.0],
    'CarIdxLastLapTime': [108.0, 107.5, 109.0],
}


SESSION_INFO = """
WeekendInfo:
 TrackName: monza
 TrackDisplayName: Autodromo Nazionale Monza
 TrackLength: 5.793 km
 EventType: Race
 SeriesID: 0
 WeekendOptions:
  NumStarters: 3
SessionInfo:
 Sessions:
 - SessionNum: 0
   SessionType: Race
   SessionLaps: 20
   SessionTime: unlimited
DriverInfo:
 DriverCarIdx: 0
 DriverCarFuelMaxLtr: 60.000
 DriverCarMaxFuelPct: 1.000
 Drivers:
 - CarIdx: 0
   UserName: Test Driver
   CarNumber: "1"
   CarScreenName: Mercedes-AMG GT3 2020
   CarClassID: 100
   CarClassShortName: GT3
   IRating: 2000
   LicSubLevel: 300
 - CarIdx: 1
   UserName: Rival Ahead
   CarNumber: "2"
   CarScreenName: Mercedes-AMG GT3 2020
   CarClassID: 100
   CarClassShortName: GT3
   IRating: 2100
   LicSubLevel: 320
 - CarIdx: 2
   UserName: Rival Behind
   CarNumber: "3"
   CarScreenName: Mercedes-AMG GT3 2020
   CarClassID: 100
   CarClassShortName: GT3
   IRating: 1900
   LicSubLevel: 280
"""


def make_frame(**overrides):
    """One telemetry frame: defaults with the given fields overridden."""
    frame = dict(DEFAULT_FRAME)
    arrays = {k: list(v) for k, v in DEFAULT_ARRAYS.items()}
    for key, value in overrides.items():
        if key in arrays:
            arrays[key] = value
        else:
            frame[key] = value
    frame['_arrays'] = arrays
    return frame


class FakeReader:
    """Serves saved frames in place of the iRacing shared-memory reader.

    Advances one frame per poll-loop iteration.  `is_active()` is called once
    per iteration at the top of the loop, so that is where the cursor moves.
    """

    def __init__(self, frames, session_info=SESSION_INFO):
        self.frames = list(frames)
        self.session_info = session_info
        self.cursor = -1
        self._opened = False
        self.frames_served = 0
        # 本番 reader が持つキャッシュ。poll ループが毎フレーム clear() する。
        self.var_cache = {}
        self._last_si_len = len(session_info or '')

    # ── connection ────────────────────────────────────────────────────
    def is_open(self):
        return self._opened

    def open(self):
        self._opened = True
        return True

    def close(self):
        self._opened = False

    def is_active(self):
        self.cursor += 1
        if self.cursor >= len(self.frames):
            raise ReplayComplete()
        self.frames_served += 1
        return True

    # ── data ──────────────────────────────────────────────────────────
    @property
    def frame(self):
        idx = max(0, min(self.cursor, len(self.frames) - 1))
        return self.frames[idx]

    def read_session_info(self):
        return self.session_info

    def find_var(self, name):
        # 本番と同じ (vtype, voffset) タプルを返す。5=double。
        if name in self.frame or name in self.frame.get('_arrays', {}):
            return (5, 0)
        return None

    def dump_temp_vars(self):
        return {}

    def _read_int(self, off):
        return 0

    def read_float(self, name):
        value = self.frame.get(name)
        return float(value) if isinstance(value, (int, float)) else None

    read_double = read_float

    def read_int(self, name):
        value = self.frame.get(name)
        return int(value) if isinstance(value, (int, float)) else None

    def read_bool(self, name):
        value = self.frame.get(name)
        return bool(value) if value is not None else None

    def read_float_array(self, name, count=64):
        return [float(v) for v in self.frame.get('_arrays', {}).get(name, [])]

    def read_int_array(self, name, count=64):
        return [int(v) for v in self.frame.get('_arrays', {}).get(name, [])]


class _ReplayClock:
    """Virtual wall clock tied to the frame cursor.

    `sleep()` does nothing but still advances time, so the production loop's
    real-time throttles (`now - last_telem_ts > 3`, cooldowns, re-arm windows)
    behave the way they would in a live session instead of freezing.
    """

    def __init__(self, reader, *, seconds_per_frame=1.0, base=1_700_000_000.0):
        self._reader = reader
        self._per_frame = seconds_per_frame
        self._base = base
        self._slept = 0.0

    def time(self):
        return (self._base
                + max(0, self._reader.cursor) * self._per_frame
                + self._slept)

    def sleep(self, seconds=0.0):
        try:
            self._slept += float(seconds)
        except (TypeError, ValueError):
            pass


class ReplayResult:
    """Everything the replayed loop emitted, for assertions."""

    def __init__(self):
        self.broadcasts = []
        self.logs = []
        self.frames_served = 0

    # ── convenience queries ───────────────────────────────────────────
    def triggers(self):
        return [b.get('trigger') for b in self.broadcasts if b.get('trigger')]

    def by_trigger(self, trigger):
        return [b for b in self.broadcasts if b.get('trigger') == trigger]

    def logs_containing(self, needle):
        return [line for line in self.logs if needle in line]

    def first_log(self, needle):
        found = self.logs_containing(needle)
        return found[0] if found else None


def replay(frames, *, session_info=SESSION_INFO, dispatch_result=None,
           seconds_per_frame=1.0):
    """Run the REAL `bridge.poll_iracing()` over saved frames.

    Returns a `ReplayResult` with every broadcast and log line the production
    loop produced.  Nothing here reimplements bridge logic.
    """
    import bridge

    result = ReplayResult()
    fake = FakeReader(frames, session_info=session_info)

    original = {
        'reader': bridge.reader,
        'broadcast': bridge.broadcast,
        'log': bridge.log,
        'time': bridge.time,
    }
    dispatched = (dispatch_result if dispatch_result is not None
                  else getattr(bridge, 'BROADCAST_DISPATCHED', True))

    def capture_broadcast(event):
        result.broadcasts.append(dict(event) if isinstance(event, dict) else event)
        return dispatched

    def capture_log(msg):
        result.logs.append(str(msg))

    bridge.reader = fake
    bridge.broadcast = capture_broadcast
    bridge.log = capture_log
    # ★壁時計も再生する。bridge には `now - last_telem_ts > 3` のように実時間で
    #   間引かれるブロックがあり、時間が止まったままだと本番なら毎秒走る経路が
    #   一度しか走らない。フレームごとに1秒進める仮想時計を渡す。
    bridge.time = _ReplayClock(fake, seconds_per_frame=seconds_per_frame)
    try:
        bridge.poll_iracing()
    except ReplayComplete:
        pass
    finally:
        bridge.reader = original['reader']
        bridge.broadcast = original['broadcast']
        bridge.log = original['log']
        bridge.time = original['time']
    result.frames_served = fake.frames_served
    return result
