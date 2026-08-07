"""Grade a conditional pit-cycle forecast using observed rival pit events.

This is deliberately not a rival-intent predictor.  The forecast says
"if this observed nearby pack stops"; this tracker records which of that
pack actually entered pit road and the position after two player laps.
"""


class PitCycleTracker:
    def __init__(self):
        self._event = None

    def begin(self, forecast, session_time, player_lap):
        cycle = forecast.get('pit_cycle') if isinstance(forecast, dict) else None
        scenarios = cycle.get('if_pack_stops') if isinstance(cycle, dict) else None
        likely = scenarios.get('likely') if isinstance(scenarios, dict) else None
        pack = cycle.get('observed_pack') if isinstance(cycle, dict) else None
        if not isinstance(likely, dict) or not isinstance(pack, list) or not pack:
            self._event = None
            return None
        ids = {item.get('car_idx') for item in pack if item.get('car_idx') is not None}
        if not ids:
            self._event = None
            return None
        self._event = {
            'snapshot_id': forecast.get('snapshot_id'),
            'started_at_s': session_time,
            'entry_lap': player_lap,
            'target_lap': (player_lap + 2 if isinstance(player_lap, (int, float)) else None),
            'physical_exit_position': None,
            'conditional_cycle_position': likely.get('position'),
            'pack_car_ids': ids,
            'observed_pit_car_ids': set(),
        }
        return {'armed': True, 'pack_car_count': len(ids),
                'conditional_cycle_position': likely.get('position')}

    def observe(self, *, session_time, player_lap, player_on_pit_road,
                player_class_position, cars):
        event = self._event
        if not event:
            return None
        if player_on_pit_road:
            return None
        if event['physical_exit_position'] is None:
            event['physical_exit_position'] = player_class_position
        for car in cars if isinstance(cars, list) else []:
            if (car.get('car_idx') in event['pack_car_ids']
                    and car.get('on_pit_road')):
                event['observed_pit_car_ids'].add(car.get('car_idx'))
        target = event['target_lap']
        if not isinstance(target, (int, float)) or not isinstance(player_lap, (int, float)):
            return None
        if player_lap < target:
            return None
        actual = player_class_position
        predicted = event['conditional_cycle_position']
        result = {
            'snapshot_id': event['snapshot_id'],
            'physical_exit_position': event['physical_exit_position'],
            'conditional_cycle_position': predicted,
            'post_cycle_actual_position': actual,
            'observed_pack_car_count': len(event['pack_car_ids']),
            'observed_pack_pit_count': len(event['observed_pit_car_ids']),
            'condition_met': event['pack_car_ids'] == event['observed_pit_car_ids'],
            'window_laps': 2,
        }
        if isinstance(actual, int) and isinstance(predicted, int):
            result['conditional_error_positions'] = actual - predicted
        self._event = None
        return result
