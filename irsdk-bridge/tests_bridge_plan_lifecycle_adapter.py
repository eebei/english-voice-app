#!/usr/bin/env python3
"""WO-005 — pure tests for `bridge_plan_lifecycle_adapter.py`.

These exercise the translation layer in isolation from `bridge.py` and from
`plan_lifecycle.py`'s own state-machine tests (`tests_plan_lifecycle.py`).
Production wiring is covered separately by
`tests_bridge_plan_lifecycle_wiring.py` (real `poll_iracing()` replay).
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bridge_plan_lifecycle_adapter as adapter  # noqa: E402
import plan_lifecycle as pl  # noqa: E402


RACE = 'sub:road-atlanta-1'
SESSION = 0


def fresh_state():
    return pl.new_race_strategy_state(RACE, SESSION)


def register_active_a(state, *, target_lap=21, add_fuel_l=30.0, set_fuel_l=None,
                       conditions=None, evidence_snapshot_id='snap:1',
                       options_snapshot=None, decision_id='sub:road-atlanta-1:decision-A',
                       current_driver_pit_sequence=0, created_frame=5, activation_frame=5):
    conditions = conditions if conditions is not None else {'k': 'v'}
    options_snapshot = (options_snapshot if options_snapshot is not None
                        else {'plan_a': {'target_lap': target_lap}})
    return pl.register_plan(
        state, decision_id=decision_id, race_instance_id=RACE, session_num=SESSION,
        selected_plan='A', phase='active',
        current_driver_pit_sequence=current_driver_pit_sequence,
        created_source_frame_sequence=created_frame,
        activation_source_frame_sequence=activation_frame,
        target_lap=target_lap, add_fuel_l=add_fuel_l, set_fuel_l=set_fuel_l,
        conditions=conditions, evidence_snapshot_id=evidence_snapshot_id,
        options_snapshot=options_snapshot)


def register_awaiting_b(state, *, target_lap=8, decision_id='sub:road-atlanta-1:decision-B',
                         current_driver_pit_sequence=0, created_frame=5,
                         evidence_snapshot_id='snap:2', conditions=None):
    conditions = conditions if conditions is not None else {'k': 'v'}
    return pl.register_plan(
        state, decision_id=decision_id, race_instance_id=RACE, session_num=SESSION,
        selected_plan='B', phase='awaiting_driver',
        current_driver_pit_sequence=current_driver_pit_sequence,
        created_source_frame_sequence=created_frame, target_lap=target_lap, add_fuel_l=20.0,
        set_fuel_l=None, conditions=conditions, evidence_snapshot_id=evidence_snapshot_id,
        options_snapshot={'plan_b': {'target_lap': target_lap}})


class RegistrationContentMatchesTests(unittest.TestCase):

    def test_identical_candidate_matches(self):
        state, reg = register_active_a(fresh_state())
        record = state.plan_records[reg.decision_id]
        self.assertTrue(adapter.registration_content_matches(
            record, selected_plan='A', target_lap=21, add_fuel_l=30.0, set_fuel_l=None,
            conditions={'k': 'v'}, evidence_snapshot_id='snap:1',
            options_snapshot={'plan_a': {'target_lap': 21}}))

    def test_different_target_lap_does_not_match(self):
        state, reg = register_active_a(fresh_state())
        record = state.plan_records[reg.decision_id]
        self.assertFalse(adapter.registration_content_matches(
            record, selected_plan='A', target_lap=18, add_fuel_l=30.0, set_fuel_l=None,
            conditions={'k': 'v'}, evidence_snapshot_id='snap:1',
            options_snapshot={'plan_a': {'target_lap': 21}}))

    def test_different_evidence_snapshot_id_does_not_match(self):
        state, reg = register_active_a(fresh_state())
        record = state.plan_records[reg.decision_id]
        self.assertFalse(adapter.registration_content_matches(
            record, selected_plan='A', target_lap=21, add_fuel_l=30.0, set_fuel_l=None,
            conditions={'k': 'v'}, evidence_snapshot_id='snap:DIFFERENT',
            options_snapshot={'plan_a': {'target_lap': 21}}))

    def test_conditions_key_order_independence(self):
        state, reg = register_active_a(fresh_state(), conditions={'a': 1, 'b': 2})
        record = state.plan_records[reg.decision_id]
        self.assertTrue(adapter.registration_content_matches(
            record, selected_plan='A', target_lap=21, add_fuel_l=30.0, set_fuel_l=None,
            conditions={'b': 2, 'a': 1}, evidence_snapshot_id='snap:1',
            options_snapshot={'plan_a': {'target_lap': 21}}))

    def test_nested_options_snapshot_mismatch_detected(self):
        state, reg = register_active_a(fresh_state())
        record = state.plan_records[reg.decision_id]
        self.assertFalse(adapter.registration_content_matches(
            record, selected_plan='A', target_lap=21, add_fuel_l=30.0, set_fuel_l=None,
            conditions={'k': 'v'}, evidence_snapshot_id='snap:1',
            options_snapshot={'plan_a': {'target_lap': 21, 'extra': 'field'}}))


class ClassifyActiveRegistrationTests(unittest.TestCase):

    def test_no_active_record_yields_register_new(self):
        state = fresh_state()
        plan = adapter.classify_active_registration(
            state, selected_plan='A', target_lap=21, add_fuel_l=30.0, set_fuel_l=None,
            conditions={'k': 'v'}, evidence_snapshot_id='snap:1',
            options_snapshot={'plan_a': {'target_lap': 21}})
        self.assertEqual(plan.action, 'register_new')

    def test_matching_active_record_yields_reuse_with_its_decision_id(self):
        state, reg = register_active_a(fresh_state())
        plan = adapter.classify_active_registration(
            state, selected_plan='A', target_lap=21, add_fuel_l=30.0, set_fuel_l=None,
            conditions={'k': 'v'}, evidence_snapshot_id='snap:1',
            options_snapshot={'plan_a': {'target_lap': 21}})
        self.assertEqual(plan.action, 'reuse')
        self.assertEqual(plan.decision_id, reg.decision_id)

    def test_differing_active_record_yields_register_replacing(self):
        state, reg = register_active_a(fresh_state())
        plan = adapter.classify_active_registration(
            state, selected_plan='A', target_lap=15, add_fuel_l=25.0, set_fuel_l=None,
            conditions={'k': 'v2'}, evidence_snapshot_id='snap:2',
            options_snapshot={'plan_a': {'target_lap': 15}})
        self.assertEqual(plan.action, 'register_replacing')
        self.assertEqual(plan.decision_id, reg.decision_id)


class InitialPlanADecisionIdTests(unittest.TestCase):

    def test_starts_with_race_instance_id_prefix(self):
        decision_id = adapter.initial_plan_a_decision_id(
            RACE, 'snap:1', selected_plan='A', target_lap=21, add_fuel_l=30.0,
            set_fuel_l=None, conditions={'k': 'v'}, evidence_snapshot_id='snap:1')
        self.assertTrue(decision_id.startswith(RACE + ':'))

    def test_deterministic_for_same_content(self):
        kwargs = dict(selected_plan='A', target_lap=21, add_fuel_l=30.0, set_fuel_l=None,
                      conditions={'k': 'v'}, evidence_snapshot_id='snap:1')
        first = adapter.initial_plan_a_decision_id(RACE, 'snap:1', **kwargs)
        second = adapter.initial_plan_a_decision_id(RACE, 'snap:1', **kwargs)
        self.assertEqual(first, second)

    def test_differs_for_different_content(self):
        base = dict(selected_plan='A', target_lap=21, add_fuel_l=30.0, set_fuel_l=None,
                    conditions={'k': 'v'}, evidence_snapshot_id='snap:1')
        changed = dict(base, target_lap=18)
        first = adapter.initial_plan_a_decision_id(RACE, 'snap:1', **base)
        second = adapter.initial_plan_a_decision_id(RACE, 'snap:1', **changed)
        self.assertNotEqual(first, second)


class LegacyProjectionTests(unittest.TestCase):

    def test_decision_projection_reads_plan_basis_and_frozen_fields(self):
        state = fresh_state()
        state, reg = pl.register_plan(
            state, decision_id='sub:road-atlanta-1:decision-A', race_instance_id=RACE,
            session_num=SESSION, selected_plan='A', phase='active',
            current_driver_pit_sequence=0, created_source_frame_sequence=5,
            activation_source_frame_sequence=5, target_lap=21, add_fuel_l=30.0,
            plan_basis={'reason': 'baseline', 'decided_at_lap': 3, 'entry_class_position': 4},
            conditions={'k': 'v'}, evidence_snapshot_id='snap:1',
            options_snapshot={'plan_a': {'target_lap': 21}})
        record = state.plan_records[reg.decision_id]
        projection = adapter.legacy_decision_projection(record, dispatch_id='dispatch-1')
        self.assertEqual(projection['decision_id'], reg.decision_id)
        self.assertEqual(projection['reason'], 'baseline')
        self.assertEqual(projection['decided_at_lap'], 3)
        self.assertEqual(projection['entry_class_position'], 4)
        self.assertEqual(projection['dispatch_id'], 'dispatch-1')
        self.assertEqual(projection['target_lap'], 21)

    def test_decision_projection_is_a_fresh_dict_each_call(self):
        state, reg = register_active_a(fresh_state())
        record = state.plan_records[reg.decision_id]
        first = adapter.legacy_decision_projection(record)
        first['target_lap'] = 999
        second = adapter.legacy_decision_projection(record)
        self.assertEqual(second['target_lap'], 21)

    def test_strategy_options_projection_uses_frozen_snapshot_and_overrides_selected_plan(self):
        state = fresh_state()
        state, reg = pl.register_plan(
            state, decision_id='sub:road-atlanta-1:decision-B', race_instance_id=RACE,
            session_num=SESSION, selected_plan='B', phase='awaiting_driver',
            current_driver_pit_sequence=0, created_source_frame_sequence=5,
            target_lap=8, add_fuel_l=20.0, conditions={'k': 'v'},
            evidence_snapshot_id='snap:2',
            options_snapshot={'selected_plan': 'A', 'plan_b': {'target_lap': 8}})
        record = state.plan_records[reg.decision_id]
        projection = adapter.legacy_strategy_options_projection(record)
        self.assertEqual(projection['selected_plan'], 'B')
        self.assertEqual(projection['plan_b']['target_lap'], 8)

    def test_strategy_options_projection_mutation_never_reaches_canonical_record(self):
        state, reg = register_active_a(fresh_state())
        record = state.plan_records[reg.decision_id]
        projection = adapter.legacy_strategy_options_projection(record)
        projection['plan_a']['target_lap'] = 999
        with self.assertRaises(TypeError):
            record.options_snapshot['plan_a']['target_lap'] = 999
        self.assertEqual(
            pl.serialize_plan_lifecycle_record(record)['options_snapshot']['plan_a']['target_lap'],
            21)


class AwaitingLookupTests(unittest.TestCase):

    def test_find_awaiting_record_for_signature_matches_by_content_not_decision_id(self):
        state, reg = register_awaiting_b(fresh_state())
        found = adapter.find_awaiting_record_for_signature(
            state, selected_plan='B', target_lap=8, add_fuel_l=20.0, set_fuel_l=None,
            conditions={'k': 'v'}, evidence_snapshot_id='snap:2',
            options_snapshot={'plan_b': {'target_lap': 8}})
        self.assertIsNotNone(found)
        self.assertEqual(found.decision_id, reg.decision_id)

    def test_find_awaiting_record_for_signature_returns_none_when_content_differs(self):
        state, reg = register_awaiting_b(fresh_state())
        found = adapter.find_awaiting_record_for_signature(
            state, selected_plan='B', target_lap=9, add_fuel_l=20.0, set_fuel_l=None,
            conditions={'k': 'v'}, evidence_snapshot_id='snap:2',
            options_snapshot={'plan_b': {'target_lap': 9}})
        self.assertIsNone(found)

    def test_current_awaiting_record_returns_the_sole_awaiting_record(self):
        state, reg_a = register_active_a(fresh_state())
        state, reg_b = register_awaiting_b(state)
        found = adapter.current_awaiting_record(state)
        self.assertEqual(found.decision_id, reg_b.decision_id)

    def test_current_awaiting_record_returns_none_when_absent(self):
        state, reg_a = register_active_a(fresh_state())
        self.assertIsNone(adapter.current_awaiting_record(state))


if __name__ == '__main__':
    unittest.main()
