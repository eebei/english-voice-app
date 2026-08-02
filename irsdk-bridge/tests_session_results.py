"""Authoritative race result parsing from Sessions[].ResultsPositions."""

import bridge


def run():
    raw = """
WeekendInfo:
 TrackName: monza full
DriverInfo:
 DriverCarIdx: 12
 Drivers:
 - CarIdx: 7
   UserName: Leader
   CarClassID: 1
   CarClassShortName: GT3
 - CarIdx: 12
   UserName: Yuji
   CarClassID: 1
   CarClassShortName: GT3
SessionInfo:
 Sessions:
 - SessionNum: 2
   SessionType: Race
   ResultsPositions:
   - Position: 0
     ClassPosition: 0
     CarIdx: 7
     LapsComplete: 31
   - Position: 3
     ClassPosition: 3
     CarIdx: 12
     LapsComplete: 31
   ResultsFastestLap:
   - CarIdx: 7
"""
    info = bridge.parse_session_info(raw)
    rows = info['session_results'][2]
    assert len(rows) == 2, rows
    player = next(row for row in rows if row.get('car_idx') == 12)
    assert player['position_zero'] == 3, player
    assert player['class_position_zero'] == 3, player
    assert player['laps_complete'] == 31, player
    print('✅ Session ResultsPositions parser: 5 checks')


if __name__ == '__main__':
    run()
