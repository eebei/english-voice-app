from pit_cycle_tracker import PitCycleTracker


forecast = {
    'snapshot_id': 'live:1',
    'pit_cycle': {
        'observed_pack': [{'car_idx': 4}, {'car_idx': 5}],
        'if_pack_stops': {'likely': {'position': 8}},
    },
}
t = PitCycleTracker()
assert t.begin(forecast, 100.0, 10)['conditional_cycle_position'] == 8
assert t.observe(session_time=110.0, player_lap=10, player_on_pit_road=True,
                 player_class_position=20, cars=[]) is None
assert t.observe(session_time=120.0, player_lap=10, player_on_pit_road=False,
                 player_class_position=20, cars=[{'car_idx': 4, 'on_pit_road': True}]) is None
# Two laps must not close the cycle while the target pack has not stopped.
assert t.observe(session_time=250.0, player_lap=12, player_on_pit_road=False,
                 player_class_position=20, cars=[]) is None
assert t.status()['observed_pack_pit_count'] == 1
r = t.observe(session_time=490.0, player_lap=14, player_on_pit_road=False,
              player_class_position=8, cars=[{'car_idx': 5, 'on_pit_road': True}])
assert r['physical_exit_position'] == 20
assert r['post_cycle_actual_position'] == 8
assert r['condition_met'] is True
assert r['conditional_error_positions'] == 0
assert r['window_laps'] == 4
assert r['closed_reason'] == 'condition_met'

# Race end closes an incomplete observation without grading it as an error.
t2 = PitCycleTracker()
t2.begin(forecast, 100.0, 10)
r2 = t2.observe(session_time=600.0, player_lap=15, player_on_pit_road=False,
                player_class_position=9,
                cars=[{'car_idx': 4, 'on_pit_road': True}],
                session_finished=True)
assert r2['condition_met'] is False
assert r2['closed_reason'] == 'race_finished'
assert 'conditional_error_positions' not in r2
print('✅ pit cycle tracker')
