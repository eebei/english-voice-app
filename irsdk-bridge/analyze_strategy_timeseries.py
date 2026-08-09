#!/usr/bin/env python3
"""Extract measured fuel laps and pit cycles from strategy_ts CSV files."""

import argparse
import csv
import glob
import json
import math
import os
from collections import Counter, defaultdict


def _num(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def _integer(value):
    value = _num(value)
    return int(value) if value is not None else None


def _flag(value):
    return str(value).strip().lower() in ('1', 'true')


def _player_class_position(row):
    idx = _integer(row.get('PlayerCarIdx'))
    if idx is None or idx < 0:
        return None
    value = _integer(row.get('CarIdxClassPosition[%d]' % idx))
    return value if value is not None and value >= 1 else None


def _classify_pit_cycle(entry_lap, exit_lap, lane_time_s, fuel_delta_l):
    if None not in (entry_lap, exit_lap) and exit_lap < entry_lap:
        return 'invalid_session_boundary'
    if lane_time_s is None or lane_time_s <= 0:
        return 'invalid_timing'
    if lane_time_s > 120:
        return 'long_stop'
    if fuel_delta_l is not None and fuel_delta_l > 0.2:
        return 'normal_refuel'
    if lane_time_s < 45:
        return 'drive_through_or_no_refuel'
    return 'no_refuel_extended_stop'


def analyze_file(path):
    with open(path, newline='', encoding='utf-8-sig') as handle:
        rows = list(csv.DictReader(handle))
    session_scores = Counter()
    for row in rows:
        session_num = _integer(row.get('SessionNum'))
        if session_num is not None and _integer(row.get('SessionState')) == 4:
            session_scores[session_num] += 1
    active_session = session_scores.most_common(1)[0][0] if session_scores else None
    active = [row for row in rows if _integer(row.get('SessionNum')) == active_session]

    lap_groups = defaultdict(list)
    for row in active:
        lap = _integer(row.get('Lap'))
        if lap is not None:
            lap_groups[lap].append(row)
    lap_starts = {}
    for lap, group in lap_groups.items():
        candidates = [row for row in group
                      if _integer(row.get('SessionState')) == 4
                      and not _flag(row.get('OnPitRoad'))
                      and _integer(row.get('PlayerTrackSurface')) == 3
                      and _num(row.get('FuelLevel')) is not None]
        if candidates:
            lap_starts[lap] = candidates[0]

    clean_fuel_laps = []
    for lap in sorted(lap_starts):
        # iRacing uses lap 0 around the pre-start/green transition.  That fuel
        # delta is not a completed racing lap and must never train fuel usage.
        if lap < 1:
            continue
        if lap + 1 not in lap_starts:
            continue
        interval = lap_groups.get(lap, [])
        if any(_flag(row.get('OnPitRoad')) for row in interval):
            continue
        start_fuel = _num(lap_starts[lap].get('FuelLevel'))
        next_fuel = _num(lap_starts[lap + 1].get('FuelLevel'))
        last_lap = _num(lap_starts[lap + 1].get('LapLastLapTime'))
        used = start_fuel - next_fuel if None not in (start_fuel, next_fuel) else None
        if used is None or not 0.1 < used < 50.0:
            continue
        clean_fuel_laps.append({
            'lap': lap,
            'fuel_start_l': round(start_fuel, 3),
            'fuel_end_l': round(next_fuel, 3),
            'fuel_used_l': round(used, 3),
            'lap_time_s': round(last_lap, 3) if last_lap and last_lap > 0 else None,
            'source': 'strategy_timeseries_s_f_fuel_delta',
        })

    pit_cycles = []
    entry = None
    previous_on_pit = None
    for row in active:
        on_pit = _flag(row.get('OnPitRoad'))
        if on_pit and previous_on_pit is False:
            entry = row
        elif not on_pit and previous_on_pit is True and entry is not None:
            entry_time = _num(entry.get('SessionTime'))
            exit_time = _num(row.get('SessionTime'))
            entry_fuel = _num(entry.get('FuelLevel'))
            exit_fuel = _num(row.get('FuelLevel'))
            entry_lap = _integer(entry.get('Lap'))
            exit_lap = _integer(row.get('Lap'))
            lane_time = (round(exit_time - entry_time, 3)
                         if None not in (entry_time, exit_time) else None)
            fuel_delta = (round(exit_fuel - entry_fuel, 3)
                          if None not in (entry_fuel, exit_fuel) else None)
            pit_cycles.append({
                'entry_time_s': round(entry_time, 3) if entry_time is not None else None,
                'exit_time_s': round(exit_time, 3) if exit_time is not None else None,
                'lane_time_s': lane_time,
                'entry_lap': entry_lap,
                'exit_lap': exit_lap,
                'entry_fuel_l': round(entry_fuel, 3) if entry_fuel is not None else None,
                'exit_fuel_l': round(exit_fuel, 3) if exit_fuel is not None else None,
                'observed_fuel_delta_l': fuel_delta,
                'pit_sv_fuel_l': _num(entry.get('PitSvFuel')),
                'entry_class_position': _player_class_position(entry),
                'exit_class_position': _player_class_position(row),
                'classification': _classify_pit_cycle(
                    entry_lap, exit_lap, lane_time, fuel_delta),
                'source': 'strategy_timeseries_on_pit_road_transition',
            })
            entry = None
        previous_on_pit = on_pit

    fuel_values = [_num(row.get('FuelLevel')) for row in active]
    fuel_values = [value for value in fuel_values if value is not None]
    average = (sum(item['fuel_used_l'] for item in clean_fuel_laps) / len(clean_fuel_laps)
               if clean_fuel_laps else None)
    pit_classifications = Counter(item['classification'] for item in pit_cycles)
    return {
        'path': os.path.abspath(path),
        'row_count': len(rows),
        'active_session_num': active_session,
        'active_session_row_count': len(active),
        'lap_min': min(lap_groups) if lap_groups else None,
        'lap_max': max(lap_groups) if lap_groups else None,
        'fuel_min_l': round(min(fuel_values), 3) if fuel_values else None,
        'fuel_max_l': round(max(fuel_values), 3) if fuel_values else None,
        'clean_fuel_laps': clean_fuel_laps,
        'clean_fuel_sample_count': len(clean_fuel_laps),
        'average_fuel_per_lap_l': round(average, 3) if average is not None else None,
        'pit_cycles': pit_cycles,
        'pit_cycle_count': len(pit_cycles),
        'pit_cycle_classification_counts': dict(pit_classifications),
        'limitations': [
            'car_class_id_not_logged',
            'car_idx_last_lap_time_not_logged',
            'counterfactual_next_lap_rejoin_requires_missing_fields',
        ],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('paths', nargs='*')
    parser.add_argument('--glob', dest='patterns', action='append', default=[])
    parser.add_argument('--output')
    args = parser.parse_args()
    paths = list(args.paths)
    for pattern in args.patterns:
        paths.extend(glob.glob(pattern))
    files = [analyze_file(path) for path in sorted(set(paths))]
    all_laps = [lap for item in files for lap in item['clean_fuel_laps']]
    all_pit_cycles = [cycle for item in files for cycle in item['pit_cycles']]
    result = {
        'summary': {
            'file_count': len(files),
            'row_count': sum(item['row_count'] for item in files),
            'clean_fuel_sample_count': len(all_laps),
            'weighted_average_fuel_per_lap_l': (
                round(sum(lap['fuel_used_l'] for lap in all_laps) / len(all_laps), 3)
                if all_laps else None),
            'pit_cycle_count': sum(item['pit_cycle_count'] for item in files),
            'pit_cycle_classification_counts': dict(Counter(
                cycle['classification'] for cycle in all_pit_cycles)),
        },
        'files': files,
    }
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as handle:
            handle.write(rendered + '\n')
    print(json.dumps(result['summary'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
