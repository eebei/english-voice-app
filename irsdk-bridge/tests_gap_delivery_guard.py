"""Executable delivery-time contract for proactive GAP speech.

These tests exercise the production Bridge helpers directly.  They prove that
an admitted/held sentence is still refused when its adjacent car, incident
epoch, or current raw number changed before the steering/brake gate opened.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bridge  # noqa: E402


class GapDeliveryGuardTests(unittest.TestCase):
    def setUp(self):
        bridge._gate_state['pending'] = None
        bridge._gate_state['since'] = 0.0
        bridge._gap_live_context.update({
            'generation': 0, 'session_key': None, 'updated_at': 0.0,
            'ahead_car_idx': None, 'behind_car_idx': None,
            'ahead_gap_s': None, 'behind_gap_s': None,
            'player_position': None, 'incident_count': None,
        })

    def _seed(self, now=100.0):
        generation = bridge._update_gap_live_context(
            'race-1', now, 10, 21, 5.0, 6.0, 8, 0)
        return {
            'type': 'radio', 'trigger': 'gap_trend',
            'direction': 'ahead', 'gap_s': 5.0, 'car_idx': 10,
            'observed_at': now, 'context_generation': generation,
        }

    def test_same_identity_and_number_remains_fresh(self):
        event = self._seed()
        self.assertEqual(bridge._gap_candidate_is_fresh(event, 102.0), (True, 'fresh'))

    def test_material_number_change_is_refused_at_delivery(self):
        event = self._seed()
        bridge._update_gap_live_context('race-1', 102.0, 10, 21, 7.0, 6.0, 8, 0)
        self.assertEqual(bridge._gap_candidate_is_fresh(event, 102.0),
                         (False, 'gap_changed_before_delivery'))

    def test_adjacent_identity_change_drops_held_candidate(self):
        event = self._seed()
        bridge._gate_state['pending'] = event
        bridge._update_gap_live_context('race-1', 102.0, 11, 21, 5.0, 6.0, 8, 0)
        self.assertIsNone(bridge._gate_state['pending'])
        self.assertEqual(bridge._gap_candidate_is_fresh(event, 102.0),
                         (False, 'context_generation_changed'))

    def test_incident_change_drops_held_candidate(self):
        event = self._seed()
        bridge._gate_state['pending'] = event
        bridge._update_gap_live_context('race-1', 102.0, 10, 21, 5.0, 6.0, 8, 1)
        self.assertIsNone(bridge._gate_state['pending'])
        self.assertEqual(bridge._gap_candidate_is_fresh(event, 102.0),
                         (False, 'context_generation_changed'))

    def test_p0_hazard_invalidates_held_gap(self):
        event = self._seed()
        bridge._gate_state['pending'] = event
        bridge._invalidate_gap_live_context('stopped_ahead')
        self.assertIsNone(bridge._gate_state['pending'])
        self.assertEqual(bridge._gap_candidate_is_fresh(event, 102.0),
                         (False, 'context_generation_changed'))


if __name__ == '__main__':
    unittest.main()
