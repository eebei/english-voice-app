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

    def test_candidate_carries_adjacent_identity_and_delivery_epoch(self):
        self.assertIn('ahead_car_idx=nearest_ahead_idx', BRIDGE)
        self.assertIn('behind_car_idx=nearest_behind_idx', BRIDGE)
        self.assertIn("_gap_event['context_generation'] = _gap_generation", BRIDGE)
        self.assertIn('def _gap_candidate_is_fresh(', BRIDGE)
        self.assertIn("return False, 'adjacent_identity_changed'", BRIDGE)
        self.assertIn("return False, 'gap_changed_before_delivery'", BRIDGE)

    def test_p0_stopped_car_invalidates_queued_gap_before_new_observe(self):
        hazard = BRIDGE.index("_invalidate_gap_live_context('stopped_ahead')")
        observe = BRIDGE.index('gap_call_policy.observe(')
        self.assertLess(hazard, observe)
        self.assertIn('gap_call_policy.suppress(_now2, 8.0)', BRIDGE)

    def test_incident_and_position_are_part_of_gap_context(self):
        self.assertIn('class_pos, incidents)', BRIDGE)
        self.assertIn('player_position=class_pos, incident_count=incidents', BRIDGE)

    def test_held_gap_flush_waits_for_same_poll_context_refresh(self):
        refresh = BRIDGE.index('_gap_generation = _update_gap_live_context(')
        observe = BRIDGE.index('gap_call_policy.observe(')
        guarded_flush = BRIDGE.index(
            'flush_radio()', refresh)
        self.assertLess(refresh, guarded_flush)
        self.assertLess(guarded_flush, observe)
        early_gate = BRIDGE[BRIDGE.index('_pending_is_gap = bool('):refresh]
        self.assertIn('elif not _pending_is_gap:', early_gate)
        self.assertNotIn('elif _pending_is_gap:', early_gate)


if __name__ == '__main__':
    unittest.main()
