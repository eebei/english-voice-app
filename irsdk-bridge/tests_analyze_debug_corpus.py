#!/usr/bin/env python3
import os
import tempfile

from analyze_debug_corpus import build_corpus


text = '''=== OMORAY PITWALL debug log 2026-08-09T00:00:00Z ===
[10:00:00][main] [bridge] OMORAY PITWALL Bridge  BUILD Build 261 test  started
[10:00:01][main] [bridge] [10:00:01] Session info sent: Race SOF:1 class:GT3 drivers:20 car:Mercedes-AMG GT3 2020 currentSession:Race track:monza full iR:1
[10:00:02][main] [bridge] [10:00:02] Session authority transition sent without duplicate reset: ('Autodromo Nazionale Monza', 'Mercedes-AMG GT3 2020', 'Practice', 0) -> ('Autodromo Nazionale Monza', 'Mercedes-AMG GT3 2020', 'Race', 1)
[10:02:00][main] [bridge] [10:02:00] CONVO [LunaJP] 平均3.67L/周、クリーン3周の実測。現在燃料で約2.0周。
[10:03:00][main] [bridge] [10:03:00] PIT EXIT SHADOW forecast: {"available":true,"snapshot_id":"s1","best":{"position":3},"likely":{"position":4},"worst":{"position":5}}
[10:04:00][main] [bridge] [10:04:00] PIT EXIT SHADOW actual: {"snapshot_id":"s1","actual_class_position":3,"score":{"snapshot_id":"s1","likely_error_positions":-1,"inside_best_worst":true}}
[10:10:00][main] [bridge] [10:10:00] PIT CYCLE outcome: {"snapshot_id":"s1","physical_exit_position":5,"conditional_cycle_position":3,"post_cycle_actual_position":3,"observed_pack_car_count":10,"observed_pack_pit_count":8,"condition_met":true,"conditional_error_positions":0}
'''
with tempfile.TemporaryDirectory() as temp:
    first = os.path.join(temp, 'one.log')
    second = os.path.join(temp, 'duplicate.log')
    for path in (first, second):
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(text)
    corpus = build_corpus([first, second])
    summary = corpus['summary']
    assert summary['input_file_count'] == 2
    assert summary['unique_file_count'] == 1
    assert summary['duplicate_file_count'] == 1
    assert summary['unique_files_with_monza_session'] == 1
    assert summary['unique_files_mentioning_monza'] == 1
    assert summary['matched_snapshot_count'] == 1
    assert summary['scored_snapshot_count'] == 1
    assert summary['inside_range_rate'] == 1.0
    assert summary['likely_mae_positions'] == 1.0
    assert summary['monza_clean_fuel_evidence_count'] == 1
    assert summary['valid_race_scored_count'] == 1
    assert summary['pit_cycle_outcome_count'] == 1
    assert summary['pit_cycle_condition_met_count'] == 1
    assert summary['pit_cycle_conditional_scored_count'] == 1
    assert summary['pit_cycle_conditional_mae_positions'] == 0.0
print('✅ debug corpus analyzer')
