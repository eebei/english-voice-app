"""Static contract for the Bridge → gated radio → JP renderer route."""

import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, 'bridge.py'), encoding='utf-8') as fh:
    BRIDGE = fh.read()


class GapTrendWiringTests(unittest.TestCase):
    def test_policy_is_imported_and_session_scoped_in_poll_loop(self):
        self.assertIn('import gap_call_policy as gap_call_policy_mod', BRIDGE)
        self.assertIn('gap_call_policy = gap_call_policy_mod.GapCallPolicy()', BRIDGE)
        self.assertIn("(cur_snum, session_track, session_car_model)", BRIDGE)

    def test_trend_is_information_and_uses_workload_gate(self):
        self.assertIn("'rolling_gap': 4, 'gap_trend': 4", BRIDGE)
        self.assertIn("'rolling_gap', 'gap_trend',", BRIDGE)
        self.assertIn("'trigger': 'gap_trend'", BRIDGE)
        block = BRIDGE[BRIDGE.index("'trigger': 'gap_trend'") - 900:BRIDGE.index("'trigger': 'gap_trend'")]
        self.assertIn('is_race_session and session_racing_started and onTrack and not onPit', block)
        self.assertIn('not in_formation', block)

    def test_gap_snapshot_is_taken_before_policy_observe(self):
        gap_calc = BRIDGE.index('nearest_ahead_gap = -_gd')
        observe = BRIDGE.index('gap_call_policy.observe(')
        self.assertLess(gap_calc, observe)


if __name__ == '__main__':
    unittest.main()
