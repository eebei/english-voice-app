#!/usr/bin/env python3
"""WO-003 — Immutable DriverPitEvent / Execution Classification: pure tests.

review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md WO-003 §8 (必須反証テスト), the
items that are pure-function properties of irsdk-bridge/driver_pit_event.py
itself (identity determinism, immutability, idempotent store, visit-wide
penalty accumulation, classification priority). Production wiring through
the real bridge.py poll_iracing() path is covered separately by
tests_driver_pit_event_wiring.py (and by the Road Atlanta fixture replay in
tests_wo001_road_atlanta_fixture.py, which this WO extends rather than
duplicates).
"""

import copy
import dataclasses
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import driver_pit_event as dpe  # noqa: E402


def make_plan_reference(race_instance_id='sub:123', session_num=0, target_lap=21,
                         decision_id=None, selected_plan='A',
                         evidence_snapshot_id='recalc:x:0:13'):
    if decision_id is None:
        decision_id = '%s:%s:decision-lap:13:sig-abc123' % (race_instance_id, evidence_snapshot_id)
    return dpe.FrozenPlanReference(
        decision_id=decision_id, selected_plan=selected_plan, target_lap=target_lap,
        session_num=session_num, evidence_snapshot_id=evidence_snapshot_id)


def make_entry_fact(lap=15, session_time_s=100.0, source_frame_sequence=10,
                     class_position=4, lap_dist_pct=0.95, fuel_l=20.0):
    return dpe.PitBoundaryFact(
        lap=lap, session_time_s=session_time_s, source_frame_sequence=source_frame_sequence,
        class_position=class_position, lap_dist_pct=lap_dist_pct, fuel_l=fuel_l)


def make_exit_fact(lap=15, session_time_s=110.0, source_frame_sequence=17,
                    class_position=4, lap_dist_pct=0.99, fuel_l=36.0):
    return dpe.PitBoundaryFact(
        lap=lap, session_time_s=session_time_s, source_frame_sequence=source_frame_sequence,
        class_position=class_position, lap_dist_pct=lap_dist_pct, fuel_l=fuel_l)


def make_service_fact(fuel_added_l=16.0, lane_total_s=25.0, stall_s=8.0,
                       repair_s=0.0, tire_service='unknown'):
    return dpe.PitServiceFact(
        fuel_added_l=fuel_added_l, lane_total_s=lane_total_s, stall_s=stall_s,
        repair_s=repair_s, tire_service=tire_service)


def black_flag(state, *, raw_value=None, authority='iRacing SessionFlags',
                observed_session_time=100.0, source_frame_sequence=10):
    return {
        'state': state, 'authority': authority, 'raw_value': raw_value,
        'observed_session_time': observed_session_time,
        'source_frame_sequence': source_frame_sequence,
    }


class PitEventIdTests(unittest.TestCase):
    """§8 item 1: same canonical tuple -> same ID; any differing component -> different ID."""

    def test_same_tuple_produces_same_id(self):
        a = dpe.build_pit_event_id('sub:123', 0, 1)
        b = dpe.build_pit_event_id('sub:123', 0, 1)
        self.assertEqual(a, b)

    def test_different_race_instance_id_produces_different_id(self):
        a = dpe.build_pit_event_id('sub:123', 0, 1)
        b = dpe.build_pit_event_id('sub:456', 0, 1)
        self.assertNotEqual(a, b)

    def test_different_session_num_produces_different_id(self):
        a = dpe.build_pit_event_id('sub:123', 0, 1)
        b = dpe.build_pit_event_id('sub:123', 1, 1)
        self.assertNotEqual(a, b)

    def test_different_sequence_produces_different_id(self):
        a = dpe.build_pit_event_id('sub:123', 0, 1)
        b = dpe.build_pit_event_id('sub:123', 0, 2)
        self.assertNotEqual(a, b)

    def test_id_is_not_a_fresh_uuid_on_each_call(self):
        """Retry/rebroadcast must not mint a new random ID for the same visit."""
        ids = {dpe.build_pit_event_id('sub:123', 0, 1) for _ in range(5)}
        self.assertEqual(len(ids), 1)


class ImmutabilityTests(unittest.TestCase):
    """§8 item 2: frozen event/nested facts cannot be mutated; serializer
    copies cannot write back into the store."""

    def _make_event(self):
        return dpe.finalize_driver_pit_event(
            race_instance_id='sub:123', session_num=0, driver_pit_sequence=1,
            entry_fact=make_entry_fact(), exit_fact=make_exit_fact(),
            service_fact=make_service_fact(),
            visit_penalty_state=dpe.observe_black_flag_frame(
                dpe.initial_visit_penalty_state(), black_flag('false', raw_value=0)),
            plan_reference=make_plan_reference(target_lap=21),
        )

    def test_event_fields_are_frozen(self):
        event = self._make_event()
        with self.assertRaises(dataclasses.FrozenInstanceError):
            event.execution_relation = 'penalty'

    def test_nested_facts_are_frozen(self):
        event = self._make_event()
        with self.assertRaises(dataclasses.FrozenInstanceError):
            event.entry.lap = 999
        with self.assertRaises(dataclasses.FrozenInstanceError):
            event.penalty_evidence.state = 'true'
        with self.assertRaises(dataclasses.FrozenInstanceError):
            event.plan_reference.target_lap = 999

    def test_mutating_serializer_output_does_not_affect_the_store_or_future_calls(self):
        event = self._make_event()
        store = {}
        store, _ = dpe.store_put(store, event)
        serialized = dpe.serialize_driver_pit_event(event)
        serialized['execution_relation'] = 'TAMPERED'
        serialized['entry']['lap'] = 999
        # A fresh serialize call must be unaffected by the earlier mutation.
        fresh = dpe.serialize_driver_pit_event(store[event.pit_event_id])
        self.assertEqual(fresh['execution_relation'], event.execution_relation)
        self.assertEqual(fresh['entry']['lap'], event.entry.lap)

    def test_serialize_returns_a_new_dict_each_call(self):
        event = self._make_event()
        a = dpe.serialize_driver_pit_event(event)
        b = dpe.serialize_driver_pit_event(event)
        self.assertIsNot(a, b)
        self.assertIsNot(a['entry'], b['entry'])
        self.assertEqual(a, b)


class IdempotentStoreTests(unittest.TestCase):
    """§8 item 3: same ID + same content is a no-op; same ID + different
    content is a detected collision, never a silent overwrite."""

    def _event(self, **overrides):
        kwargs = dict(
            race_instance_id='sub:123', session_num=0, driver_pit_sequence=1,
            entry_fact=make_entry_fact(), exit_fact=make_exit_fact(),
            service_fact=make_service_fact(),
            visit_penalty_state=dpe.observe_black_flag_frame(
                dpe.initial_visit_penalty_state(), black_flag('false', raw_value=0)),
            plan_reference=make_plan_reference(target_lap=21),
        )
        kwargs.update(overrides)
        return dpe.finalize_driver_pit_event(**kwargs)

    def test_same_id_same_content_is_a_noop(self):
        event = self._event()
        store = {}
        store, inserted1 = dpe.store_put(store, event)
        self.assertTrue(inserted1)
        same_event = self._event()  # independently rebuilt, same inputs
        store2, inserted2 = dpe.store_put(store, same_event)
        self.assertFalse(inserted2)
        self.assertEqual(len(store2), 1)
        self.assertIs(store2[event.pit_event_id], event)  # unchanged, not replaced

    def test_same_id_different_content_raises_and_does_not_overwrite(self):
        event = self._event()
        store = {}
        store, _ = dpe.store_put(store, event)
        different = self._event(service_fact=make_service_fact(fuel_added_l=999.0))
        with self.assertRaises(dpe.DriverPitEventCollisionError):
            dpe.store_put(store, different)
        # Store itself (the dict we still hold) must be untouched.
        self.assertEqual(store[event.pit_event_id].service.fuel_added_l, 16.0)

    def test_store_put_does_not_mutate_its_input_dict(self):
        event = self._event()
        store = {}
        new_store, _ = dpe.store_put(store, event)
        self.assertEqual(store, {})
        self.assertIn(event.pit_event_id, new_store)


class VisitPenaltyAccumulationTests(unittest.TestCase):
    """§8 item 8/9: visit-wide penalty evidence, not a single exit-frame read."""

    def test_true_observed_mid_visit_survives_a_later_false_at_exit(self):
        state = dpe.initial_visit_penalty_state()
        state = dpe.observe_black_flag_frame(state, black_flag('false', raw_value=0, source_frame_sequence=1))
        state = dpe.observe_black_flag_frame(
            state, black_flag('true', raw_value=0x00010000, source_frame_sequence=2))
        state = dpe.observe_black_flag_frame(state, black_flag('false', raw_value=0, source_frame_sequence=3))
        evidence = dpe.resolve_visit_penalty_evidence(state)
        self.assertEqual(evidence.state, 'true')
        self.assertEqual(evidence.raw_value, 0x00010000)
        self.assertEqual(evidence.source_frame_sequence, 2,
                          'must keep the FIRST true observation, not the last frame')

    def test_fuel_zero_still_produces_penalty_true_when_black_flag_true(self):
        state = dpe.observe_black_flag_frame(
            dpe.initial_visit_penalty_state(), black_flag('true', raw_value=0x00010000))
        evidence = dpe.resolve_visit_penalty_evidence(state)
        entry = make_entry_fact(lap=16)
        relation, reason = dpe.classify_execution_relation(
            race_instance_id='sub:123', session_num=0, entry_lap=entry.lap,
            plan_reference=make_plan_reference(target_lap=21), penalty_evidence=evidence)
        self.assertEqual((relation, reason), ('penalty', 'authoritative_black_flag'))

    def test_fuel_nonzero_still_produces_penalty_true_when_black_flag_true(self):
        """§8 item 4: penalty true + fuel>0 is still `penalty` — fuel amount
        must never suppress or override an authoritative penalty."""
        state = dpe.observe_black_flag_frame(
            dpe.initial_visit_penalty_state(), black_flag('true', raw_value=0x00010000))
        evidence = dpe.resolve_visit_penalty_evidence(state)
        relation, reason = dpe.classify_execution_relation(
            race_instance_id='sub:123', session_num=0, entry_lap=16,
            plan_reference=make_plan_reference(target_lap=21), penalty_evidence=evidence)
        self.assertEqual(relation, 'penalty')

    def test_unknown_observed_with_no_true_produces_unresolved_state(self):
        state = dpe.initial_visit_penalty_state()
        state = dpe.observe_black_flag_frame(state, black_flag('false', raw_value=0))
        state = dpe.observe_black_flag_frame(state, black_flag('unknown', raw_value=None))
        state = dpe.observe_black_flag_frame(state, black_flag('false', raw_value=0))
        evidence = dpe.resolve_visit_penalty_evidence(state)
        self.assertEqual(evidence.state, 'unknown')

    def test_all_known_false_produces_false(self):
        state = dpe.initial_visit_penalty_state()
        for _ in range(3):
            state = dpe.observe_black_flag_frame(state, black_flag('false', raw_value=0))
        evidence = dpe.resolve_visit_penalty_evidence(state)
        self.assertEqual(evidence.state, 'false')

    def test_observe_black_flag_frame_does_not_mutate_its_input(self):
        state = dpe.initial_visit_penalty_state()
        new_state = dpe.observe_black_flag_frame(state, black_flag('true', raw_value=0x00010000))
        self.assertFalse(state['saw_true'])
        self.assertTrue(new_state['saw_true'])


class ClassificationPriorityTests(unittest.TestCase):
    """§8 items 5-7: penalty > unresolved-unknown > no_frozen_plan/target-
    invalid > plan-identity-mismatch > early/normal > after-target-unresolved."""

    def _evidence(self, state, **kw):
        st = dpe.initial_visit_penalty_state()
        if state == 'true':
            st = dpe.observe_black_flag_frame(st, black_flag('true', raw_value=0x00010000, **kw))
        elif state == 'unknown':
            st = dpe.observe_black_flag_frame(st, black_flag('unknown', raw_value=None, **kw))
        else:
            st = dpe.observe_black_flag_frame(st, black_flag('false', raw_value=0, **kw))
        return dpe.resolve_visit_penalty_evidence(st)

    def test_penalty_unknown_before_target_is_unresolved_not_early(self):
        relation, reason = dpe.classify_execution_relation(
            race_instance_id='sub:123', session_num=0, entry_lap=15,
            plan_reference=make_plan_reference(target_lap=21),
            penalty_evidence=self._evidence('unknown'))
        self.assertEqual((relation, reason), ('unresolved', 'penalty_evidence_unknown'))

    def test_penalty_unknown_at_target_is_unresolved_not_normal(self):
        relation, reason = dpe.classify_execution_relation(
            race_instance_id='sub:123', session_num=0, entry_lap=21,
            plan_reference=make_plan_reference(target_lap=21),
            penalty_evidence=self._evidence('unknown'))
        self.assertEqual((relation, reason), ('unresolved', 'penalty_evidence_unknown'))

    def test_false_before_target_is_early(self):
        relation, reason = dpe.classify_execution_relation(
            race_instance_id='sub:123', session_num=0, entry_lap=15,
            plan_reference=make_plan_reference(target_lap=21),
            penalty_evidence=self._evidence('false'))
        self.assertEqual((relation, reason), ('early', 'before_target_lap'))

    def test_false_at_target_is_normal(self):
        relation, reason = dpe.classify_execution_relation(
            race_instance_id='sub:123', session_num=0, entry_lap=21,
            plan_reference=make_plan_reference(target_lap=21),
            penalty_evidence=self._evidence('false'))
        self.assertEqual((relation, reason), ('normal', 'at_target_lap'))

    def test_false_after_target_is_unresolved_not_normal(self):
        relation, reason = dpe.classify_execution_relation(
            race_instance_id='sub:123', session_num=0, entry_lap=25,
            plan_reference=make_plan_reference(target_lap=21),
            penalty_evidence=self._evidence('false'))
        self.assertEqual((relation, reason), ('unresolved', 'after_target_lap'))

    def test_no_plan_reference_is_unresolved(self):
        relation, reason = dpe.classify_execution_relation(
            race_instance_id='sub:123', session_num=0, entry_lap=15,
            plan_reference=None, penalty_evidence=self._evidence('false'))
        self.assertEqual((relation, reason), ('unresolved', 'no_frozen_plan'))

    def test_missing_target_lap_is_unresolved(self):
        relation, reason = dpe.classify_execution_relation(
            race_instance_id='sub:123', session_num=0, entry_lap=15,
            plan_reference=make_plan_reference(target_lap=None),
            penalty_evidence=self._evidence('false'))
        self.assertEqual((relation, reason), ('unresolved', 'no_frozen_plan'))

    def test_missing_entry_lap_is_unresolved(self):
        relation, reason = dpe.classify_execution_relation(
            race_instance_id='sub:123', session_num=0, entry_lap=None,
            plan_reference=make_plan_reference(target_lap=21),
            penalty_evidence=self._evidence('false'))
        self.assertEqual((relation, reason), ('unresolved', 'no_frozen_plan'))

    def test_plan_identity_mismatch_by_race_instance_id_is_unresolved(self):
        relation, reason = dpe.classify_execution_relation(
            race_instance_id='sub:999', session_num=0, entry_lap=15,
            plan_reference=make_plan_reference(race_instance_id='sub:123', target_lap=21),
            penalty_evidence=self._evidence('false'))
        self.assertEqual((relation, reason), ('unresolved', 'plan_identity_mismatch'))

    def test_plan_identity_mismatch_by_session_num_is_unresolved(self):
        plan_ref = make_plan_reference(race_instance_id='sub:123', session_num=0, target_lap=21)
        relation, reason = dpe.classify_execution_relation(
            race_instance_id='sub:123', session_num=1, entry_lap=15,
            plan_reference=plan_ref, penalty_evidence=self._evidence('false'))
        self.assertEqual((relation, reason), ('unresolved', 'plan_identity_mismatch'))

    def test_penalty_wins_over_missing_plan(self):
        """Priority: penalty (1) must win even when plan_reference is also absent."""
        relation, reason = dpe.classify_execution_relation(
            race_instance_id='sub:123', session_num=0, entry_lap=15,
            plan_reference=None, penalty_evidence=self._evidence('true'))
        self.assertEqual((relation, reason), ('penalty', 'authoritative_black_flag'))


class FreezePlanReferenceTests(unittest.TestCase):
    """§3.1: entry-time freeze; None when the Plan cannot prove its identity."""

    def test_valid_plan_is_frozen_with_the_five_required_fields_only(self):
        plan = {
            'decision_id': 'sub:123:recalc:x:0:13:decision-lap:13:sig-abc',
            'selected_plan': 'A', 'target_lap': 21, 'session_num': 0,
            'evidence_snapshot_id': 'recalc:x:0:13',
            'add_fuel_l': 40.0, 'options_snapshot': {'huge': 'blob'},
        }
        ref = dpe.freeze_plan_reference(plan, race_instance_id='sub:123', session_num=0)
        self.assertEqual(ref.decision_id, plan['decision_id'])
        self.assertEqual(ref.selected_plan, 'A')
        self.assertEqual(ref.target_lap, 21)
        self.assertEqual(ref.session_num, 0)
        self.assertEqual(ref.evidence_snapshot_id, 'recalc:x:0:13')

    def test_none_plan_freezes_to_none(self):
        self.assertIsNone(dpe.freeze_plan_reference(None, race_instance_id='sub:123', session_num=0))

    def test_plan_from_a_different_race_instance_id_freezes_to_none(self):
        plan = {
            'decision_id': 'sub:999:recalc:x:0:13:decision-lap:13:sig-abc',
            'selected_plan': 'A', 'target_lap': 21, 'session_num': 0,
        }
        self.assertIsNone(dpe.freeze_plan_reference(plan, race_instance_id='sub:123', session_num=0))

    def test_plan_from_a_different_session_num_freezes_to_none(self):
        plan = {
            'decision_id': 'sub:123:recalc:x:0:13:decision-lap:13:sig-abc',
            'selected_plan': 'A', 'target_lap': 21, 'session_num': 1,
        }
        self.assertIsNone(dpe.freeze_plan_reference(plan, race_instance_id='sub:123', session_num=0))

    def test_later_active_decision_plan_mutation_does_not_affect_an_already_frozen_reference(self):
        """§8 item 10 (pure half): entry-time snapshot copy semantics."""
        plan = {
            'decision_id': 'sub:123:recalc:x:0:13:decision-lap:13:sig-abc',
            'selected_plan': 'A', 'target_lap': 21, 'session_num': 0,
        }
        ref = dpe.freeze_plan_reference(plan, race_instance_id='sub:123', session_num=0)
        plan['target_lap'] = 999  # simulate a later recalculation mutating the live dict
        self.assertEqual(ref.target_lap, 21)


class FinalizeEntryExitIdentityMismatchTests(unittest.TestCase):
    """§3.3: entry/exit identity mismatch must not synthesize a normal visit."""

    def test_entry_exit_race_instance_id_mismatch_forces_unresolved(self):
        event = dpe.finalize_driver_pit_event(
            race_instance_id='sub:456', session_num=0, driver_pit_sequence=1,
            entry_fact=make_entry_fact(), exit_fact=make_exit_fact(),
            service_fact=make_service_fact(),
            visit_penalty_state=dpe.observe_black_flag_frame(
                dpe.initial_visit_penalty_state(), black_flag('false', raw_value=0)),
            plan_reference=make_plan_reference(race_instance_id='sub:456', target_lap=21),
            entry_race_instance_id='sub:123', entry_session_num=0,
        )
        self.assertEqual(event.execution_relation, 'unresolved')
        self.assertEqual(event.classification_reason, 'entry_exit_identity_mismatch')

    def test_entry_exit_session_num_mismatch_forces_unresolved(self):
        event = dpe.finalize_driver_pit_event(
            race_instance_id='sub:123', session_num=1, driver_pit_sequence=1,
            entry_fact=make_entry_fact(), exit_fact=make_exit_fact(),
            service_fact=make_service_fact(),
            visit_penalty_state=dpe.observe_black_flag_frame(
                dpe.initial_visit_penalty_state(), black_flag('false', raw_value=0)),
            plan_reference=make_plan_reference(session_num=1, target_lap=21),
            entry_race_instance_id='sub:123', entry_session_num=0,
        )
        self.assertEqual(event.execution_relation, 'unresolved')
        self.assertEqual(event.classification_reason, 'entry_exit_identity_mismatch')

    def test_matching_entry_exit_identity_classifies_normally(self):
        event = dpe.finalize_driver_pit_event(
            race_instance_id='sub:123', session_num=0, driver_pit_sequence=1,
            entry_fact=make_entry_fact(lap=15), exit_fact=make_exit_fact(lap=15),
            service_fact=make_service_fact(),
            visit_penalty_state=dpe.observe_black_flag_frame(
                dpe.initial_visit_penalty_state(), black_flag('false', raw_value=0)),
            plan_reference=make_plan_reference(target_lap=21),
            entry_race_instance_id='sub:123', entry_session_num=0,
        )
        self.assertEqual(event.execution_relation, 'early')


class MalformedBlackFlagFailsClosedTests(unittest.TestCase):
    """WO-003 REVISE 1 P1-3: a `state` that is neither 'true' nor 'false'
    (missing key, non-dict input, or an unexpected/malformed value) must fold
    into 'unknown', never silently degrade to 'false'."""

    def test_missing_state_key_is_unknown_not_false(self):
        state = dpe.observe_black_flag_frame(
            dpe.initial_visit_penalty_state(), {'authority': 'x'})
        evidence = dpe.resolve_visit_penalty_evidence(state)
        self.assertEqual(evidence.state, 'unknown')

    def test_non_dict_black_flag_is_unknown_not_false(self):
        state = dpe.observe_black_flag_frame(dpe.initial_visit_penalty_state(), None)
        evidence = dpe.resolve_visit_penalty_evidence(state)
        self.assertEqual(evidence.state, 'unknown')

    def test_garbage_state_string_is_unknown_not_false(self):
        state = dpe.observe_black_flag_frame(
            dpe.initial_visit_penalty_state(), black_flag('False'))  # wrong case: malformed
        evidence = dpe.resolve_visit_penalty_evidence(state)
        self.assertEqual(evidence.state, 'unknown')

    def test_explicit_false_state_is_still_false(self):
        """Guards against over-correcting: exact 'false' must still resolve to
        'false' when nothing else was observed — only non-'true'/'false'
        values fold to unknown."""
        state = dpe.observe_black_flag_frame(
            dpe.initial_visit_penalty_state(), black_flag('false', raw_value=0))
        evidence = dpe.resolve_visit_penalty_evidence(state)
        self.assertEqual(evidence.state, 'false')

    def test_malformed_state_does_not_override_an_already_seen_true(self):
        state = dpe.observe_black_flag_frame(
            dpe.initial_visit_penalty_state(), black_flag('true', raw_value=0x00010000))
        state = dpe.observe_black_flag_frame(state, {'state': 'garbage'})
        evidence = dpe.resolve_visit_penalty_evidence(state)
        self.assertEqual(evidence.state, 'true')


class ReconnectGapBlackFlagEvidenceTests(unittest.TestCase):
    """WO-003 REVISE 1 P1-3: the synthetic evidence folded in for a sustained
    reconnect gap during an open pit visit must always resolve to unknown
    unless a real 'true' was already observed, and must never degrade an
    all-false visit into 'false' just because the gap frame is missing."""

    def test_reconnect_gap_evidence_is_unknown_shaped(self):
        gap = dpe.reconnect_gap_black_flag_evidence()
        self.assertEqual(gap['state'], 'unknown')

    def test_gap_with_known_false_on_both_sides_resolves_unknown_not_false(self):
        """Entry false, gap (disconnect), exit false — must NOT collapse to
        'false' just because both observed boundaries were false; the gap
        itself is unresolved evidence."""
        state = dpe.initial_visit_penalty_state()
        state = dpe.observe_black_flag_frame(state, black_flag('false', raw_value=0, source_frame_sequence=1))
        state = dpe.observe_black_flag_frame(state, dpe.reconnect_gap_black_flag_evidence())
        state = dpe.observe_black_flag_frame(state, black_flag('false', raw_value=0, source_frame_sequence=9))
        evidence = dpe.resolve_visit_penalty_evidence(state)
        self.assertEqual(evidence.state, 'unknown')

    def test_known_true_elsewhere_still_wins_over_a_gap(self):
        state = dpe.initial_visit_penalty_state()
        state = dpe.observe_black_flag_frame(state, black_flag('false', raw_value=0, source_frame_sequence=1))
        state = dpe.observe_black_flag_frame(
            state, black_flag('true', raw_value=0x00010000, source_frame_sequence=5))
        state = dpe.observe_black_flag_frame(state, dpe.reconnect_gap_black_flag_evidence())
        evidence = dpe.resolve_visit_penalty_evidence(state)
        self.assertEqual(evidence.state, 'true')

    def test_gap_before_a_later_true_still_produces_true(self):
        state = dpe.initial_visit_penalty_state()
        state = dpe.observe_black_flag_frame(state, black_flag('false', raw_value=0, source_frame_sequence=1))
        state = dpe.observe_black_flag_frame(state, dpe.reconnect_gap_black_flag_evidence())
        state = dpe.observe_black_flag_frame(
            state, black_flag('true', raw_value=0x00010000, source_frame_sequence=9))
        evidence = dpe.resolve_visit_penalty_evidence(state)
        self.assertEqual(evidence.state, 'true')


class LegacyPitEventsViewTests(unittest.TestCase):
    """WO-003 REVISE 1 P1-2: `legacy_pit_events_view()` must reconstruct the
    existing pit_events-compatible aliases from canonical facts only, sorted
    by driver_pit_sequence, without needing any bridge-local state."""

    def _event(self, sequence, entry_lap, exit_lap):
        return dpe.finalize_driver_pit_event(
            race_instance_id='sub:123', session_num=0, driver_pit_sequence=sequence,
            entry_fact=make_entry_fact(lap=entry_lap, class_position=5),
            exit_fact=make_exit_fact(lap=exit_lap, class_position=6),
            service_fact=make_service_fact(fuel_added_l=12.5, lane_total_s=30.0, stall_s=9.0),
            visit_penalty_state=dpe.observe_black_flag_frame(
                dpe.initial_visit_penalty_state(), black_flag('false', raw_value=0)),
            plan_reference=make_plan_reference(target_lap=21),
        )

    def test_empty_store_produces_empty_view(self):
        self.assertEqual(dpe.legacy_pit_events_view({}), [])

    def test_view_carries_the_existing_alias_fields_from_canonical_facts(self):
        event = self._event(1, entry_lap=15, exit_lap=15)
        store = {event.pit_event_id: event}
        view = dpe.legacy_pit_events_view(store)
        self.assertEqual(len(view), 1)
        row = view[0]
        self.assertEqual(row['entry_lap'], 15)
        self.assertEqual(row['exit_lap'], 15)
        self.assertEqual(row['entry_class_position'], 5)
        self.assertEqual(row['exit_class_position'], 6)
        self.assertEqual(row['fuel_added_l'], 12.5)
        self.assertEqual(row['lane_total_s'], 30.0)
        self.assertEqual(row['stall_s'], 9.0)
        # Canonical identity fields must also be present (same ID everywhere).
        self.assertEqual(row['pit_event_id'], event.pit_event_id)
        self.assertEqual(row['execution_relation'], event.execution_relation)

    def test_view_is_sorted_by_driver_pit_sequence_regardless_of_dict_order(self):
        e2 = self._event(2, entry_lap=16, exit_lap=16)
        e1 = self._event(1, entry_lap=15, exit_lap=15)
        store = {e2.pit_event_id: e2, e1.pit_event_id: e1}  # inserted out of order
        view = dpe.legacy_pit_events_view(store)
        self.assertEqual([row['driver_pit_sequence'] for row in view], [1, 2])

    def test_view_does_not_mutate_the_store_or_its_events(self):
        event = self._event(1, entry_lap=15, exit_lap=15)
        store = {event.pit_event_id: event}
        view = dpe.legacy_pit_events_view(store)
        view[0]['entry_lap'] = 999
        fresh = dpe.legacy_pit_events_view(store)
        self.assertEqual(fresh[0]['entry_lap'], 15)


class ResolveLaneEntryTimeTests(unittest.TestCase):
    """WO-003 REVISE 2: `resolve_lane_entry_time_s()` is the pure fallback
    used when a same-identity sustained reconnect mid-visit wipes the legacy
    `pit_enter_time`. It must prefer the legacy value when present, fall
    back to the frozen entry fact's `session_time_s` only when the tracker
    is alive AND identity matches, and stay fail-closed (return `None`,
    never another visit's time) whenever the tracker is missing or the
    identity does not match."""

    def _entry_fact(self, session_time_s=1234.5):
        return make_entry_fact(session_time_s=session_time_s)

    def test_legacy_value_present_is_used_as_is_and_entry_fact_is_ignored(self):
        result = dpe.resolve_lane_entry_time_s(
            legacy_pit_enter_time_s=500.0, entry_fact=self._entry_fact(session_time_s=999.0),
            entry_race_instance_id='sub:1', entry_session_num=0,
            exit_race_instance_id='sub:1', exit_session_num=0)
        self.assertEqual(result, 500.0)

    def test_legacy_none_same_identity_falls_back_to_frozen_entry_fact_time(self):
        result = dpe.resolve_lane_entry_time_s(
            legacy_pit_enter_time_s=None, entry_fact=self._entry_fact(session_time_s=777.0),
            entry_race_instance_id='sub:1', entry_session_num=0,
            exit_race_instance_id='sub:1', exit_session_num=0)
        self.assertEqual(result, 777.0)

    def test_legacy_none_and_no_tracker_returns_none(self):
        result = dpe.resolve_lane_entry_time_s(
            legacy_pit_enter_time_s=None, entry_fact=None,
            entry_race_instance_id=None, entry_session_num=None,
            exit_race_instance_id='sub:1', exit_session_num=0)
        self.assertIsNone(result)

    def test_legacy_none_race_instance_id_mismatch_returns_none(self):
        result = dpe.resolve_lane_entry_time_s(
            legacy_pit_enter_time_s=None, entry_fact=self._entry_fact(),
            entry_race_instance_id='sub:1', entry_session_num=0,
            exit_race_instance_id='sub:2', exit_session_num=0)
        self.assertIsNone(result, 'a different race_instance_id must not borrow another visit\'s time')

    def test_legacy_none_session_num_mismatch_returns_none(self):
        result = dpe.resolve_lane_entry_time_s(
            legacy_pit_enter_time_s=None, entry_fact=self._entry_fact(),
            entry_race_instance_id='sub:1', entry_session_num=0,
            exit_race_instance_id='sub:1', exit_session_num=1)
        self.assertIsNone(result, 'a different session_num must not borrow another visit\'s time')

    def test_legacy_none_entry_identity_unknown_returns_none(self):
        """A tracker whose entry identity fields were never populated (should
        not happen alongside a live entry_fact, but the guard must not
        assume that invariant) must fail closed rather than treat a `None`
        entry identity as a wildcard match."""
        result = dpe.resolve_lane_entry_time_s(
            legacy_pit_enter_time_s=None, entry_fact=self._entry_fact(),
            entry_race_instance_id=None, entry_session_num=None,
            exit_race_instance_id='sub:1', exit_session_num=0)
        self.assertIsNone(result)


if __name__ == '__main__':
    unittest.main(verbosity=2)
