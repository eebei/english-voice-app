"""Weekend authority: entry counts and qualifying fail-close."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from bridge import parse_session_info, session_time_to_seconds  # noqa: E402


def fixture(fastest):
    return f"""WeekendInfo:
 TrackName: monza
 SeriesID: 539
 SeasonID: 6312
 RaceWeek: 6
DriverInfo:
 DriverCarIdx: 8
 Drivers:
  - CarIdx: 0
    IRating: 3000
    IsSpectator: 0
    CarClassShortName: GTP
  - CarIdx: 8
    IRating: 2500
    IsSpectator: 0
    CarClassShortName: IMSA23
  - CarIdx: 9
    IRating: 2200
    IsSpectator: 0
    CarClassShortName: IMSA23
  - CarIdx: 10
    IRating: 0
    IsSpectator: 0
    CarClassShortName: IMSA23
    UserName: AI Driver
  - CarIdx: 11
    IRating: 0
    IsSpectator: 0
    CarIsPaceCar: 1
    CarClassShortName: GTP
    UserName: Pace Car
QualifyResultsInfo:
 Results:
  - Position: 0
    ClassPosition: 0
    CarIdx: 0
    FastestTime: 105.000
  - Position: 1
    ClassPosition: 0
    CarIdx: 9
    FastestTime: 106.000
  - Position: 11
    ClassPosition: 3
    CarIdx: 8
    FastestTime: {fastest}
SessionInfo:
 Sessions:
  - SessionNum: 0
    SessionType: Practice
    SessionTime: 30 min
  - SessionNum: 1
    SessionType: Qualify
    SessionLaps: 2
"""


valid = parse_session_info(fixture('107.321'))
assert valid['num_drivers'] == 4
assert valid['class_entry_counts'] == {'GTP': 1, 'IMSA23': 3}
assert valid['player_class_entry_count'] == 3
assert valid['qualifying_result']['status'] == 'valid'
assert valid['qualifying_result']['overall_position'] == 12
assert valid['qualifying_result']['class_position'] == 4
assert valid['qualifying_result']['position_base_verified'] is True
assert valid['qualifying_result']['class_position_base_verified'] is True
assert valid['session_details'][1]['session_laps'] == 2
assert session_time_to_seconds('20 min') == 1200.0
assert session_time_to_seconds('1200 sec') == 1200.0
assert session_time_to_seconds('20:00.000') == 1200.0
assert session_time_to_seconds('1:20:00') == 4800.0
assert session_time_to_seconds('20:60') is None
assert session_time_to_seconds('2 laps') is None

missing = parse_session_info(fixture('-1.000'))
assert missing['qualifying_result']['status'] == 'no_valid_time'
assert missing['qualifying_result']['overall_position'] is None
assert missing['qualifying_result']['class_position'] is None
print('✅ weekend authority')
