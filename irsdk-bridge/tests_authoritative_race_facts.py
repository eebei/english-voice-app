"""Pure unit tests for authoritative_race_facts.py (WO-002).

Covers review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md WO-002 §8 items 1-5, 10
(the parts that are pure-function contracts, independent of bridge.py wiring).
Items 6-9, 11-12 (pit-sequence increment/reset, reconnect, real poll_iracing()
wiring, mutation) are covered by tests_authoritative_race_facts_wiring.py via
the real replay_harness.py -> bridge.poll_iracing() path.
"""

import unittest

from authoritative_race_facts import (
    BLACK_FLAG_BIT, SESSION_FLAGS_AUTHORITY,
    classify_black_flag, build_snapshot, project_black_flag_evidence,
    with_incremented_pit_sequence,
)


class ClassifyBlackFlagTests(unittest.TestCase):

    def test_raw_bit_set_is_true(self):
        out = classify_black_flag(BLACK_FLAG_BIT)
        self.assertEqual(out['state'], 'true')
        self.assertEqual(out['raw_value'], BLACK_FLAG_BIT)
        self.assertEqual(out['authority'], SESSION_FLAGS_AUTHORITY)
        self.assertEqual(out['freshness'], 'fresh')

    def test_raw_zero_is_known_false_not_unknown(self):
        out = classify_black_flag(0)
        self.assertEqual(out['state'], 'false')
        self.assertEqual(out['raw_value'], 0)
        self.assertEqual(out['freshness'], 'fresh')

    def test_raw_none_is_unknown_never_false(self):
        out = classify_black_flag(None)
        self.assertEqual(out['state'], 'unknown')
        self.assertNotEqual(out['state'], 'false')
        self.assertIsNone(out['raw_value'])
        self.assertEqual(out['freshness'], 'unavailable')
        self.assertEqual(out['authority'], SESSION_FLAGS_AUTHORITY)

    def test_other_bits_set_without_black_flag_bit_is_false(self):
        # 0xC000 (yellow/caution bits) set, black-flag bit clear.
        out = classify_black_flag(0xC000)
        self.assertEqual(out['state'], 'false')
        self.assertEqual(out['raw_value'], 0xC000)

    def test_black_flag_bit_combined_with_other_bits_is_true(self):
        out = classify_black_flag(BLACK_FLAG_BIT | 0xC000)
        self.assertEqual(out['state'], 'true')

    def test_non_int_raw_value_is_unknown(self):
        for bad in (None, '65536', 65536.0, [65536]):
            out = classify_black_flag(bad)
            self.assertEqual(out['state'], 'unknown', msg=repr(bad))
            self.assertIsNone(out['raw_value'], msg=repr(bad))


class BuildSnapshotTests(unittest.TestCase):

    def test_known_true_snapshot_carries_source_frame_and_identity(self):
        snap = build_snapshot(
            race_instance_id='sub:992001177', session_num=2,
            source_frame_sequence=41, session_time_s=456.7,
            raw_session_flags=BLACK_FLAG_BIT, driver_pit_sequence=2)
        self.assertEqual(snap['race_instance_id'], 'sub:992001177')
        self.assertEqual(snap['session_num'], 2)
        self.assertEqual(snap['source_frame'], {'sequence': 41, 'session_time_s': 456.7})
        self.assertEqual(snap['driver_pit_sequence'], 2)
        self.assertEqual(snap['black_flag']['state'], 'true')
        self.assertEqual(snap['black_flag']['raw_value'], BLACK_FLAG_BIT)
        self.assertEqual(snap['black_flag']['observed_session_time'], 456.7)
        self.assertEqual(snap['black_flag']['source_frame_sequence'], 41)
        self.assertTrue(snap['session_flags']['available'])
        self.assertEqual(snap['session_flags']['raw_value'], BLACK_FLAG_BIT)

    def test_unknown_snapshot_does_not_fabricate_raw_value_or_freshness(self):
        snap = build_snapshot(
            race_instance_id='sub:1', session_num=0,
            source_frame_sequence=1, session_time_s=10.0,
            raw_session_flags=None, driver_pit_sequence=0)
        self.assertEqual(snap['black_flag']['state'], 'unknown')
        self.assertIsNone(snap['black_flag']['raw_value'])
        self.assertEqual(snap['black_flag']['freshness'], 'unavailable')
        self.assertFalse(snap['session_flags']['available'])
        self.assertIsNone(snap['session_flags']['raw_value'])

    def test_known_false_after_known_true_does_not_carry_over(self):
        # Two independently-built snapshots (as bridge.py would build one per
        # poll iteration): a later known-false frame must not inherit the
        # earlier frame's true state — build_snapshot() has no memory of any
        # prior call, so this also documents that contract explicitly.
        first = build_snapshot(
            race_instance_id='sub:1', session_num=0, source_frame_sequence=1,
            session_time_s=10.0, raw_session_flags=BLACK_FLAG_BIT,
            driver_pit_sequence=1)
        second = build_snapshot(
            race_instance_id='sub:1', session_num=0, source_frame_sequence=2,
            session_time_s=20.0, raw_session_flags=0,
            driver_pit_sequence=2)
        self.assertEqual(first['black_flag']['state'], 'true')
        self.assertEqual(second['black_flag']['state'], 'false')
        self.assertNotEqual(second['black_flag']['observed_session_time'],
                             first['black_flag']['observed_session_time'])

    def test_unknown_then_recovered_read_reports_known_state_on_new_frame(self):
        unknown = build_snapshot(
            race_instance_id='sub:1', session_num=0, source_frame_sequence=5,
            session_time_s=50.0, raw_session_flags=None, driver_pit_sequence=0)
        recovered = build_snapshot(
            race_instance_id='sub:1', session_num=0, source_frame_sequence=6,
            session_time_s=51.0, raw_session_flags=0, driver_pit_sequence=0)
        self.assertEqual(unknown['black_flag']['state'], 'unknown')
        self.assertEqual(recovered['black_flag']['state'], 'false')
        self.assertEqual(recovered['black_flag']['freshness'], 'fresh')


class ProjectBlackFlagEvidenceTests(unittest.TestCase):

    def test_projection_copies_fields_and_tags_source_visit(self):
        snap = build_snapshot(
            race_instance_id='sub:1', session_num=0, source_frame_sequence=9,
            session_time_s=99.0, raw_session_flags=BLACK_FLAG_BIT,
            driver_pit_sequence=1)
        evidence = project_black_flag_evidence(snap, source_visit_fuel_added_l=0.0)
        self.assertEqual(evidence, {
            'state': 'true',
            'source_visit_fuel_added_l': 0.0,
            'freshness': 'fresh',
            'authority': SESSION_FLAGS_AUTHORITY,
            'raw_value': BLACK_FLAG_BIT,
            'observed_session_time': 99.0,
            'source_frame_sequence': 9,
        })

    def test_projection_is_a_copy_not_a_live_reference(self):
        snap = build_snapshot(
            race_instance_id='sub:1', session_num=0, source_frame_sequence=1,
            session_time_s=1.0, raw_session_flags=BLACK_FLAG_BIT,
            driver_pit_sequence=1)
        evidence = project_black_flag_evidence(snap, source_visit_fuel_added_l=16.79)
        evidence['state'] = 'mutated'
        self.assertEqual(snap['black_flag']['state'], 'true',
                          'mutating a returned projection must not rewrite the snapshot')

    def test_unavailable_evidence_names_authority_and_observed_time_without_raw_value(self):
        snap = build_snapshot(
            race_instance_id='sub:1', session_num=0, source_frame_sequence=3,
            session_time_s=33.0, raw_session_flags=None, driver_pit_sequence=0)
        evidence = project_black_flag_evidence(snap, source_visit_fuel_added_l=5.0)
        self.assertEqual(evidence['state'], 'unknown')
        self.assertNotEqual(evidence['state'], 'false')
        self.assertIsNone(evidence['raw_value'])
        self.assertEqual(evidence['authority'], SESSION_FLAGS_AUTHORITY)
        self.assertEqual(evidence['observed_session_time'], 33.0)
        self.assertEqual(evidence['freshness'], 'unavailable')


class WithIncrementedPitSequenceTests(unittest.TestCase):
    """WO-002 REVISE 1, item 1: the snapshot itself must be the single owner
    of driver_pit_sequence — a confirmed pit exit advances it via this
    function, not via a side counter bridge.py keeps independently."""

    def test_increments_by_exactly_one(self):
        snap = build_snapshot(
            race_instance_id='sub:1', session_num=0, source_frame_sequence=7,
            session_time_s=70.0, raw_session_flags=0, driver_pit_sequence=1)
        updated = with_incremented_pit_sequence(snap)
        self.assertEqual(updated['driver_pit_sequence'], 2)

    def test_does_not_mutate_the_input_snapshot(self):
        snap = build_snapshot(
            race_instance_id='sub:1', session_num=0, source_frame_sequence=7,
            session_time_s=70.0, raw_session_flags=0, driver_pit_sequence=1)
        with_incremented_pit_sequence(snap)
        self.assertEqual(snap['driver_pit_sequence'], 1,
                          'the original snapshot object must be left unchanged')

    def test_carries_every_other_field_over_unchanged_without_rereading_raw_sources(self):
        snap = build_snapshot(
            race_instance_id='sub:992001177', session_num=2,
            source_frame_sequence=41, session_time_s=456.7,
            raw_session_flags=BLACK_FLAG_BIT, driver_pit_sequence=1)
        updated = with_incremented_pit_sequence(snap)
        self.assertEqual(updated['race_instance_id'], snap['race_instance_id'])
        self.assertEqual(updated['session_num'], snap['session_num'])
        self.assertEqual(updated['source_frame'], snap['source_frame'])
        self.assertEqual(updated['session_flags'], snap['session_flags'])
        self.assertEqual(updated['black_flag'], snap['black_flag'])

    def test_a_projection_already_taken_from_the_old_snapshot_is_unaffected(self):
        snap = build_snapshot(
            race_instance_id='sub:1', session_num=0, source_frame_sequence=1,
            session_time_s=1.0, raw_session_flags=BLACK_FLAG_BIT,
            driver_pit_sequence=1)
        evidence_before = project_black_flag_evidence(snap, source_visit_fuel_added_l=16.79)
        with_incremented_pit_sequence(snap)
        self.assertEqual(evidence_before['state'], 'true')


if __name__ == '__main__':
    unittest.main()
