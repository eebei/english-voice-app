#!/usr/bin/env python3
import csv
import os
import tempfile

from analyze_strategy_timeseries import analyze_file


fields = ['SessionTime','SessionNum','SessionState','Lap','PlayerCarIdx','OnPitRoad',
          'PlayerTrackSurface','FuelLevel','PitSvFuel','CarIdxClassPosition[0]']
rows = [
    [0,1,4,1,0,0,3,20,0,5],
    [100,1,4,2,0,0,3,16.5,0,5],
    [190,1,4,2,0,1,2,13.5,10,5],
    [220,1,4,2,0,0,3,22.5,0,8],
    [300,1,4,3,0,0,3,19.0,0,8],
]
with tempfile.TemporaryDirectory() as temp:
    path = os.path.join(temp, 'strategy.csv')
    with open(path, 'w', newline='', encoding='utf-8') as handle:
        writer = csv.writer(handle)
        writer.writerow(fields)
        writer.writerows(rows)
    result = analyze_file(path)
    assert result['active_session_num'] == 1
    assert result['clean_fuel_sample_count'] == 1
    assert result['clean_fuel_laps'][0]['fuel_used_l'] == 3.5
    assert result['pit_cycle_count'] == 1
    assert result['pit_cycles'][0]['lane_time_s'] == 30.0
    assert result['pit_cycles'][0]['entry_class_position'] == 5
    assert result['pit_cycles'][0]['exit_class_position'] == 8
    assert result['pit_cycles'][0]['classification'] == 'normal_refuel'
    assert result['pit_cycle_classification_counts'] == {'normal_refuel': 1}

# Lap 0 is the start transition, not a completed fuel lap.
rows_with_lap_zero = [
    [0,1,4,0,0,0,3,20,0,5],
    [10,1,4,1,0,0,3,19.8,0,5],
    [110,1,4,2,0,0,3,16.3,0,5],
]
with tempfile.TemporaryDirectory() as temp:
    path = os.path.join(temp, 'lap-zero.csv')
    with open(path, 'w', newline='', encoding='utf-8') as handle:
        writer = csv.writer(handle)
        writer.writerow(fields)
        writer.writerows(rows_with_lap_zero)
    result = analyze_file(path)
    assert result['clean_fuel_sample_count'] == 1
    assert result['clean_fuel_laps'][0]['lap'] == 1
    assert result['clean_fuel_laps'][0]['fuel_used_l'] == 3.5
print('✅ strategy timeseries analyzer')
