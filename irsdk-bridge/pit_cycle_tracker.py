"""Track a conditional pit-cycle forecast until its condition is observable.

The previous implementation graded after a fixed two player laps.  That was
not a pit *cycle*: at Monza the target pack stopped later, so the tracker closed
at physical P20 and missed the eventual P8 blend.  We now finish when every
forecast target has actually visited pit road, or close explicitly at the end
of the race / a generous safety timeout.  Partial conditions are never scored
as though the original condition occurred.
"""


class PitCycleTracker:
    MAX_WINDOW_LAPS = 8
    MAX_WINDOW_SECONDS = 900.0

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
            'physical_exit_position': None,
            'conditional_cycle_position': likely.get('position'),
            'pack_car_ids': ids,
            'observed_pit_car_ids': set(),
        }
        return {'armed': True, 'pack_car_count': len(ids),
                'conditional_cycle_position': likely.get('position')}

    def status(self):
        event = self._event
        if not event:
            return None
        return {
            'active': True,
            'snapshot_id': event['snapshot_id'],
            'physical_exit_position': event['physical_exit_position'],
            'conditional_cycle_position': event['conditional_cycle_position'],
            'observed_pack_car_count': len(event['pack_car_ids']),
            'observed_pack_pit_count': len(event['observed_pit_car_ids']),
        }

    def observe(self, *, session_time, player_lap, player_on_pit_road,
                player_class_position, cars, session_finished=False):
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

        condition_met = event['pack_car_ids'] == event['observed_pit_car_ids']
        lap_window = None
        if isinstance(player_lap, (int, float)) and isinstance(event['entry_lap'], (int, float)):
            lap_window = max(0, player_lap - event['entry_lap'])
        time_window = None
        if isinstance(session_time, (int, float)) and isinstance(event['started_at_s'], (int, float)):
            time_window = max(0.0, session_time - event['started_at_s'])
        timed_out = ((lap_window is not None and lap_window >= self.MAX_WINDOW_LAPS)
                     or (time_window is not None and time_window >= self.MAX_WINDOW_SECONDS))
        if not condition_met and not session_finished and not timed_out:
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
            'condition_met': condition_met,
            'window_laps': lap_window,
            'window_seconds': time_window,
            'closed_reason': ('condition_met' if condition_met else
                              'race_finished' if session_finished else 'timeout'),
        }
        # A conditional forecast is gradable only when its stated condition
        # happened.  A partial pack stop is evidence, not a prediction error.
        if condition_met and isinstance(actual, int) and isinstance(predicted, int):
            result['conditional_error_positions'] = actual - predicted
        self._event = None
        return result
