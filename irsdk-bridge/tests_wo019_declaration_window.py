#!/usr/bin/env python3
"""WO-019: validity window of a Driver early-pit declaration (bridge.early_pit_declaration_outstanding).

The record under test is produced by the real plan_lifecycle transitions (register ->
apply_driver_plan_intent early_pit -> optional apply_pit_event / new register / recovery
invalidation); nothing here hand-builds a terminal record.
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bridge  # noqa: E402
import plan_lifecycle as pl  # noqa: E402
import durable_recovery as recovery  # noqa: E402
import tests_bridge_plan_lifecycle_wiring as w  # noqa: E402  (real register helpers)

RACE, SESSION, DECLARED_LAP = w.RACE, w.SESSION, 15


def declared_state():
    state = pl.new_race_strategy_state(RACE, SESSION)
    state, _ = w._register_active_from_decision_plan(state, w._plan_a_decision_plan())
    active = pl.active_plan_view(state)
    intent = pl.DriverPlanIntent(
        command_id='c1', operation='early_pit', race_instance_id=RACE, session_num=SESSION,
        target_decision_id=active.decision_id, expected_revision=active.revision,
        expected_activation_source_frame_sequence=active.activated_source_frame_sequence,
        received_source_frame_sequence=active.activated_source_frame_sequence + 3,
        driver_pit_sequence=active.expected_pit_sequence - 1, utterance_id='u1',
        requested_target_lap=None, reason_text=None)
    state, outcome = pl.apply_driver_plan_intent(state, intent)
    assert outcome.status == 'applied', outcome
    declaration = {'decision_id': active.decision_id, 'race_instance_id': RACE, 'session_num': SESSION,
                   'driver_pit_sequence': 0, 'lap': DECLARED_LAP, 'command_id': 'c1'}
    return state, declaration


def outstanding(declaration, state, *, lap, race=RACE, session=SESSION, pit_seq=0):
    return bridge.early_pit_declaration_outstanding(
        declaration, state=state, race_instance_id=race, session_num=session,
        driver_pit_sequence=pit_seq, current_lap=lap)


class DeclarationWindow(unittest.TestCase):
    def setUp(self):
        self.state, self.decl = declared_state()

    def test_real_terminal_record(self):
        rec = self.state.plan_records[self.decl['decision_id']]
        self.assertEqual((rec.phase, rec.invalidated_reason), ('invalidated', 'driver_early_pit_declared'))

    def test_declared_lap_and_next_lap_only(self):
        got = {lap: outstanding(self.decl, self.state, lap=lap) is not None for lap in (12, 14, 15, 16, 17)}
        self.assertEqual(got, {12: False, 14: False, 15: True, 16: True, 17: False})

    def test_other_scope_or_later_pit_sequence(self):
        self.assertIsNone(outstanding(self.decl, self.state, lap=15, race='sub:other'))
        self.assertIsNone(outstanding(self.decl, self.state, lap=15, session=1))
        self.assertIsNone(outstanding(self.decl, self.state, lap=15, pit_seq=1))

    def test_malformed_inputs(self):
        self.assertIsNone(outstanding(None, self.state, lap=15))
        self.assertIsNone(outstanding(self.decl, None, lap=15))
        self.assertIsNone(outstanding(self.decl, self.state, lap=True))
        self.assertIsNone(outstanding(dict(self.decl, lap=None), self.state, lap=15))
        self.assertIsNone(outstanding(dict(self.decl, decision_id='unknown'), self.state, lap=15))

    def test_new_active_plan_ends_the_declaration(self):
        state, _ = w._register_active_from_decision_plan(
            self.state, w._plan_a_decision_plan(decision_id='%s:%s:decision-A2' % (RACE, 0), target_lap=22),
            source_frame=20)
        self.assertIsNone(outstanding(self.decl, state, lap=15))

    def test_restore_invalidation_keeps_terminal_but_bridge_resets_the_declaration(self):
        # durable_recovery leaves terminal records as they are; the Bridge clears its
        # declaration on scope reset / restore / raw time rollback (asserted in source).
        restored = recovery.invalidate_restored(self.state, reason='raw_session_time_rollback')
        self.assertIsNotNone(outstanding(self.decl, restored, lap=15))
        src = open(os.path.join(HERE, 'bridge.py'), encoding='utf-8').read()
        rollback = src.index("reason='raw_session_time_rollback')")
        self.assertIn('_declared_early_pit=None', src[rollback:rollback + 200])
        self.assertEqual(src.count('_declared_early_pit=None'), 3)


if __name__ == '__main__':
    unittest.main(verbosity=2)
