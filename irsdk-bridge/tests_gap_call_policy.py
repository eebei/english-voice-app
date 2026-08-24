import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gap_call_policy import GapCallPolicy


class GapCallPolicyTests(unittest.TestCase):
    def setUp(self):
        self.p = GapCallPolicy()

    def test_requires_a_second_snapshot_and_sample_interval(self):
        self.assertIsNone(self.p.observe('race-1', 0, ahead_s=8.0, behind_s=7.0))
        self.assertIsNone(self.p.observe('race-1', 2, ahead_s=5.0, behind_s=7.0))
        event = self.p.observe('race-1', 3, ahead_s=5.0, behind_s=7.0)
        self.assertEqual(event['direction'], 'ahead')
        self.assertEqual(event['trend'], 'closing')
        self.assertEqual(event['change_s'], 3.0)

    def test_needs_both_relative_and_absolute_change(self):
        self.p.observe('race-1', 0, ahead_s=4.0)
        self.assertIsNone(self.p.observe('race-1', 3, ahead_s=3.0))  # 25%, but only 1.0 s
        self.p.observe('race-1', 6, ahead_s=10.0)
        self.assertIsNone(self.p.observe('race-1', 9, ahead_s=8.0))  # 2.0 s, but only 20%

    def test_closing_beats_opening_when_both_change(self):
        self.p.observe('race-1', 0, ahead_s=8.0, behind_s=4.0)
        event = self.p.observe('race-1', 3, ahead_s=5.0, behind_s=6.0)
        self.assertEqual(event['direction'], 'ahead')
        self.assertEqual(event['trend'], 'closing')

    def test_cooldown_and_session_reset(self):
        self.p.observe('race-1', 0, behind_s=8.0)
        self.assertIsNotNone(self.p.observe('race-1', 3, behind_s=5.0))
        self.assertIsNone(self.p.observe('race-1', 6, behind_s=8.0))
        self.assertIsNone(self.p.observe('race-1', 9, behind_s=5.0))
        self.assertIsNone(self.p.observe('race-2', 10, behind_s=8.0))
        self.assertIsNotNone(self.p.observe('race-2', 13, behind_s=5.0))

    def test_out_of_window_is_not_reported(self):
        self.p.observe('race-1', 0, ahead_s=20.0)
        self.assertIsNone(self.p.observe('race-1', 3, ahead_s=15.0))
        self.p.observe('race-1', 6, ahead_s=4.0)
        self.assertIsNone(self.p.observe('race-1', 9, ahead_s=0.5))

    def test_adjacent_car_change_restarts_the_baseline(self):
        self.assertIsNone(self.p.observe('race-1', 0, ahead_s=8.0, ahead_car_idx=10))
        self.assertIsNone(self.p.observe('race-1', 3, ahead_s=5.0, ahead_car_idx=11))
        event = self.p.observe('race-1', 6, ahead_s=3.0, ahead_car_idx=11)
        self.assertIsNotNone(event)
        self.assertEqual(event['car_idx'], 11)
        self.assertEqual(event['gap_s'], 3.0)

    def test_incident_change_discards_old_gap_and_waits_for_settle(self):
        self.p.observe('race-1', 0, behind_s=8.0, behind_car_idx=21,
                       player_position=8, incident_count=0)
        self.assertIsNone(self.p.observe('race-1', 3, behind_s=5.0, behind_car_idx=21,
                                         player_position=8, incident_count=1))
        self.assertIsNone(self.p.observe('race-1', 10, behind_s=4.5, behind_car_idx=21,
                                         player_position=8, incident_count=1))
        self.assertIsNone(self.p.observe('race-1', 12, behind_s=4.0, behind_car_idx=21,
                                         player_position=8, incident_count=1))
        event = self.p.observe('race-1', 15, behind_s=2.5, behind_car_idx=21,
                               player_position=8, incident_count=1)
        self.assertIsNotNone(event)

    def test_multi_position_jump_discards_old_comparison(self):
        self.p.observe('race-1', 0, ahead_s=8.0, ahead_car_idx=10,
                       player_position=10, incident_count=0)
        self.assertIsNone(self.p.observe('race-1', 3, ahead_s=5.0, ahead_car_idx=10,
                                         player_position=7, incident_count=0))
        self.assertIsNone(self.p.observe('race-1', 9, ahead_s=5.0, ahead_car_idx=10,
                                         player_position=7, incident_count=0))
        event = self.p.observe('race-1', 12, ahead_s=3.0, ahead_car_idx=10,
                               player_position=7, incident_count=0)
        self.assertIsNotNone(event)


if __name__ == '__main__':
    unittest.main()
