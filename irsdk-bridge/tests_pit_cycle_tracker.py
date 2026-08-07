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
r = t.observe(session_time=250.0, player_lap=12, player_on_pit_road=False,
              player_class_position=8, cars=[{'car_idx': 5, 'on_pit_road': True}])
assert r['physical_exit_position'] == 20
assert r['post_cycle_actual_position'] == 8
assert r['condition_met'] is True
assert r['conditional_error_positions'] == 0
print('✅ pit cycle tracker')
