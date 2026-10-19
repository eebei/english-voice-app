#!/usr/bin/env python3
"""WO-004 — Pure PlanLifecycleRecord State Machine: pure/falsification tests.

review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md WO-004 (Revision 2) §7 (必須反証
テスト、items 1-21) and §11 (Codex独立確認チェックリスト). All events fed into
`plan_lifecycle.py` here are real `driver_pit_event.DriverPitEvent` objects
built via `driver_pit_event.finalize_driver_pit_event()` — this module never
reimplements WO-003's classification. Production wiring (`bridge.py`,
Desktop, Server, BOX calls, Driver intent) is explicitly out of scope for
WO-004 and is not exercised here.
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
import plan_lifecycle as pl  # noqa: E402


RACE = 'sub:road-atlanta-1'
SESSION = 0


def make_plan_reference(decision_id, target_lap=21, selected_plan='A',
                         race_instance_id=RACE, session_num=SESSION,
                         evidence_snapshot_id='recalc:x:0:13'):
    return dpe.FrozenPlanReference(
        decision_id=decision_id, selected_plan=selected_plan, target_lap=target_lap,
        session_num=session_num, evidence_snapshot_id=evidence_snapshot_id)


def make_event(*, driver_pit_sequence, entry_lap=21, entry_frame=100, exit_frame=110,
               race_instance_id=RACE, session_num=SESSION, plan_reference=None,
               black_flag_state='false', fuel_added_l=35.0,
               entry_race_instance_id=None, entry_session_num=None):
    """Builds a real, correctly-classified `DriverPitEvent` through the actual
    WO-003 pipeline (`observe_black_flag_frame` + `finalize_driver_pit_event`)
    rather than constructing the frozen dataclass by hand, so
    `execution_relation` always comes from WO-003's own classifier."""
    entry_fact = dpe.PitBoundaryFact(
        lap=entry_lap, session_time_s=float(entry_frame), source_frame_sequence=entry_frame,
        class_position=1, lap_dist_pct=0.95, fuel_l=5.0)
    exit_fact = dpe.PitBoundaryFact(
        lap=entry_lap, session_time_s=float(exit_frame), source_frame_sequence=exit_frame,
        class_position=1, lap_dist_pct=0.02, fuel_l=5.0 + fuel_added_l)
    service_fact = dpe.PitServiceFact(
        fuel_added_l=fuel_added_l, lane_total_s=25.0, stall_s=8.0, repair_s=0.0,
        tire_service='unknown')
    visit_state = dpe.initial_visit_penalty_state()
    visit_state = dpe.observe_black_flag_frame(visit_state, {
        'state': black_flag_state, 'authority': 'iRacing SessionFlags', 'raw_value': None,
        'observed_session_time': float(entry_frame), 'source_frame_sequence': entry_frame,
    })
    return dpe.finalize_driver_pit_event(
        race_instance_id=race_instance_id, session_num=session_num,
        driver_pit_sequence=driver_pit_sequence, entry_fact=entry_fact, exit_fact=exit_fact,
        service_fact=service_fact, visit_penalty_state=visit_state, plan_reference=plan_reference,
        entry_race_instance_id=entry_race_instance_id, entry_session_num=entry_session_num)


def fresh_state():
    return pl.new_race_strategy_state(RACE, SESSION)


def register_active(state, decision_id='sub:road-atlanta-1:decision-A', target_lap=21,
                     current_driver_pit_sequence=0, created_frame=5, activation_frame=5,
                     **overrides):
    kwargs = dict(
        decision_id=decision_id, race_instance_id=RACE, session_num=SESSION,
        selected_plan='A', phase='active', current_driver_pit_sequence=current_driver_pit_sequence,
        created_source_frame_sequence=created_frame, activation_source_frame_sequence=activation_frame,
        target_lap=target_lap, add_fuel_l=30.0, set_fuel_l=None, conditions={'k': 'v'},
        validity_contract={'kind': 'stint'}, evidence_snapshot_id='snap:1',
        options_snapshot={'plan_a': {'target_lap': target_lap}})
    kwargs.update(overrides)
    return pl.register_plan(state, **kwargs)


def register_awaiting(state, decision_id='sub:road-atlanta-1:decision-B', target_lap=21,
                       current_driver_pit_sequence=0, created_frame=5, **overrides):
    kwargs = dict(
        decision_id=decision_id, race_instance_id=RACE, session_num=SESSION,
        selected_plan='B', phase='awaiting_driver',
        current_driver_pit_sequence=current_driver_pit_sequence,
        created_source_frame_sequence=created_frame, target_lap=target_lap, add_fuel_l=25.0,
        set_fuel_l=None, conditions={'k': 'v'}, validity_contract={'kind': 'stint'},
        evidence_snapshot_id='snap:2', options_snapshot={'plan_b': {'target_lap': target_lap}})
    kwargs.update(overrides)
    return pl.register_plan(state, **kwargs)


# ══════════════════════════════════════════════════════════════════════
# §7-1 / §7-9: active -> normal pit -> executed, sequence mismatch fail-closed
# ══════════════════════════════════════════════════════════════════════

class NormalExecutionTests(unittest.TestCase):

    def test_active_normal_pit_becomes_executed_and_clears_active_view(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        decision_id = reg.decision_id
        event = make_event(
            driver_pit_sequence=1, entry_lap=21,
            plan_reference=make_plan_reference(decision_id))
        state, outcome = pl.apply_pit_event(state, event)
        record = state.plan_records[decision_id]
        self.assertEqual(record.phase, 'executed')
        self.assertEqual(record.resolved_pit_sequence, 1)
        self.assertEqual(record.terminal_pit_event_id, event.pit_event_id)
        self.assertEqual(record.execution_relation, 'normal')
        self.assertIsNone(pl.active_plan_view(state))
        self.assertIsNone(state.active_plan_id)

    def test_normal_relation_with_sequence_mismatch_is_fail_closed_invalidated(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        decision_id = reg.decision_id
        # expected_pit_sequence == 1, but the event claims sequence 2 —
        # WO-003 classified it 'normal' (target lap reached) yet the pit
        # bookkeeping disagrees; must not be trusted as the Plan's own pit.
        event = make_event(
            driver_pit_sequence=2, entry_lap=21,
            plan_reference=make_plan_reference(decision_id))
        state, outcome = pl.apply_pit_event(state, event)
        record = state.plan_records[decision_id]
        self.assertEqual(record.phase, 'invalidated')
        self.assertEqual(record.invalidated_reason, 'pit_sequence_mismatch')
        self.assertIsNone(pl.active_plan_view(state))


# ══════════════════════════════════════════════════════════════════════
# §7-2 / §7-4 / §7-5: early / penalty / unresolved -> invalidated, fuel-blind
# ══════════════════════════════════════════════════════════════════════

class InvalidatingRelationTests(unittest.TestCase):

    def _active_state(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        return state, reg.decision_id

    def test_early_pit_invalidates_with_driver_early_pit_reason(self):
        state, decision_id = self._active_state()
        event = make_event(
            driver_pit_sequence=1, entry_lap=15,
            plan_reference=make_plan_reference(decision_id))
        self.assertEqual(event.execution_relation, 'early')
        state, outcome = pl.apply_pit_event(state, event)
        record = state.plan_records[decision_id]
        self.assertEqual(record.phase, 'invalidated')
        self.assertEqual(record.invalidated_reason, 'driver_early_pit')
        self.assertIsNone(state.active_plan_id)

    def test_penalty_pit_invalidates_regardless_of_fuel_added(self):
        state, decision_id = self._active_state()
        event_no_fuel = make_event(
            driver_pit_sequence=1, entry_lap=16, black_flag_state='true', fuel_added_l=0.0,
            plan_reference=make_plan_reference(decision_id))
        self.assertEqual(event_no_fuel.execution_relation, 'penalty')
        state, outcome = pl.apply_pit_event(state, event_no_fuel)
        record = state.plan_records[decision_id]
        self.assertEqual(record.phase, 'invalidated')
        self.assertEqual(record.invalidated_reason, 'penalty_pit')

    def test_penalty_pit_transition_is_identical_with_nonzero_fuel(self):
        # Mutation-style: two Plans, identical except the pit event differs
        # ONLY in fuel_added_l. plan_lifecycle must reach the exact same
        # phase/reason — proof it never reads service.fuel_added_l.
        state = fresh_state()
        state, reg_a = register_active(
            state, decision_id='sub:road-atlanta-1:decision-fuel-a', current_driver_pit_sequence=0)
        state, reg_b = register_active(
            state, decision_id='sub:road-atlanta-1:decision-fuel-b', current_driver_pit_sequence=0,
            activation_frame=5)
        # decision-a can't both be active simultaneously with decision-b under
        # the single-active-owner rule, so cancel A's active ownership before
        # registering B, then compare each in isolation instead.
        event_zero = make_event(
            driver_pit_sequence=1, entry_lap=16, black_flag_state='true', fuel_added_l=0.0,
            plan_reference=make_plan_reference(reg_a.decision_id))
        state, _ = pl.apply_pit_event(state, event_zero)
        record_zero = state.plan_records[reg_a.decision_id]

        state2 = fresh_state()
        state2, reg_c = register_active(
            state2, decision_id='sub:road-atlanta-1:decision-fuel-c', current_driver_pit_sequence=0)
        event_nonzero = make_event(
            driver_pit_sequence=1, entry_lap=16, black_flag_state='true', fuel_added_l=42.0,
            plan_reference=make_plan_reference(reg_c.decision_id))
        state2, _ = pl.apply_pit_event(state2, event_nonzero)
        record_nonzero = state2.plan_records[reg_c.decision_id]

        self.assertEqual(record_zero.phase, record_nonzero.phase)
        self.assertEqual(record_zero.invalidated_reason, record_nonzero.invalidated_reason)
        self.assertEqual(record_zero.execution_relation, record_nonzero.execution_relation)

    def test_unresolved_relation_invalidates_fail_closed_not_kept_active(self):
        state, decision_id = self._active_state()
        event = make_event(
            driver_pit_sequence=1, entry_lap=21, black_flag_state='unknown',
            plan_reference=make_plan_reference(decision_id))
        self.assertEqual(event.execution_relation, 'unresolved')
        state, outcome = pl.apply_pit_event(state, event)
        record = state.plan_records[decision_id]
        self.assertEqual(record.phase, 'invalidated')
        self.assertEqual(record.invalidated_reason, 'pit_relation_unresolved')
        self.assertIsNone(state.active_plan_id)

    def test_awaiting_driver_normal_pit_is_invalidated_not_executed(self):
        state = fresh_state()
        state, reg = register_awaiting(state, current_driver_pit_sequence=0)
        # A direct plan_reference to an awaiting_driver record is not how
        # WO-003 freezes references today, but the pure table must still
        # never claim a Plan the Driver hasn't accepted was "executed".
        event = make_event(
            driver_pit_sequence=1, entry_lap=21,
            plan_reference=make_plan_reference(reg.decision_id))
        state, outcome = pl.apply_pit_event(state, event)
        record = state.plan_records[reg.decision_id]
        self.assertEqual(record.phase, 'invalidated')
        self.assertEqual(record.invalidated_reason, 'pit_before_plan_activation')


# ══════════════════════════════════════════════════════════════════════
# §7-6 / §7-7 / §7-11 / §7-18: idempotency and collision
# ══════════════════════════════════════════════════════════════════════

class IdempotencyAndCollisionTests(unittest.TestCase):

    def test_terminal_record_retry_and_different_event_leave_it_unchanged(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        decision_id = reg.decision_id
        event = make_event(
            driver_pit_sequence=1, entry_lap=15,
            plan_reference=make_plan_reference(decision_id))
        state, _ = pl.apply_pit_event(state, event)
        terminal_record = state.plan_records[decision_id]
        self.assertEqual(terminal_record.phase, 'invalidated')

        # Same event applied again: retry no-op.
        state2, outcome2 = pl.apply_pit_event(state, event)
        self.assertEqual(outcome2.status, 'retry_no_op')
        self.assertEqual(state2.plan_records[decision_id], terminal_record)
        self.assertEqual(len(state2.history), len(state.history))

        # A different, later pit event referencing the same (terminal) Plan
        # must not resurrect it or overwrite its reason.
        other_event = make_event(
            driver_pit_sequence=2, entry_lap=16, black_flag_state='true',
            plan_reference=make_plan_reference(decision_id))
        state3, outcome3 = pl.apply_pit_event(state, other_event)
        self.assertEqual(
            state3.plan_records[decision_id].phase, terminal_record.phase)
        self.assertEqual(
            state3.plan_records[decision_id].invalidated_reason,
            terminal_record.invalidated_reason)
        self.assertEqual(
            state3.plan_records[decision_id].revision, terminal_record.revision)

    def test_applying_the_same_pit_event_twice_only_advances_history_once(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        decision_id = reg.decision_id
        event = make_event(
            driver_pit_sequence=1, entry_lap=21,
            plan_reference=make_plan_reference(decision_id))
        history_before = len(state.history)
        state, _ = pl.apply_pit_event(state, event)
        history_after_first = len(state.history)
        revision_after_first = state.plan_records[decision_id].revision
        state, outcome = pl.apply_pit_event(state, event)
        self.assertEqual(outcome.status, 'retry_no_op')
        self.assertEqual(len(state.history), history_after_first)
        self.assertEqual(state.plan_records[decision_id].revision, revision_after_first)
        self.assertGreater(history_after_first, history_before)

    def test_register_plan_same_id_same_content_is_a_noop(self):
        state = fresh_state()
        state, reg1 = register_active(state, current_driver_pit_sequence=0)
        history_before = len(state.history)
        state2, reg2 = register_active(state, current_driver_pit_sequence=0)
        self.assertEqual(reg2.status, 'retry_no_op')
        self.assertEqual(len(state2.history), history_before)
        self.assertEqual(state2.plan_records, state.plan_records)

    def test_register_plan_same_id_different_content_is_a_collision_and_does_not_overwrite(self):
        state = fresh_state()
        state, reg1 = register_active(state, current_driver_pit_sequence=0)
        original = state.plan_records[reg1.decision_id]
        state2, reg2 = register_active(state, current_driver_pit_sequence=0, target_lap=25)
        self.assertEqual(reg2.status, 'collision')
        self.assertEqual(state2.plan_records[reg1.decision_id], original)

    def test_pit_event_same_id_different_content_is_a_collision_diagnostic_not_an_exception(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        decision_id = reg.decision_id
        event = make_event(
            driver_pit_sequence=1, entry_lap=21,
            plan_reference=make_plan_reference(decision_id))
        state, _ = pl.apply_pit_event(state, event)
        before = state

        forged_event = dataclasses.replace(event, exit=dataclasses.replace(event.exit, fuel_l=999.0))
        self.assertEqual(forged_event.pit_event_id, event.pit_event_id)
        self.assertNotEqual(forged_event, event)
        state2, outcome = pl.apply_pit_event(state, forged_event)
        self.assertEqual(outcome.status, 'collision')
        self.assertEqual(state2.plan_records, before.plan_records)
        self.assertEqual(state2.active_plan_id, before.active_plan_id)
        self.assertEqual(len(state2.history), len(before.history))
        self.assertEqual(state2.applied_pit_events[event.pit_event_id], event)


# ══════════════════════════════════════════════════════════════════════
# §7-3 / §7-8 / §7-10 / §7-19: scope, missing-plan, mismatch diagnostics
# ══════════════════════════════════════════════════════════════════════

class DiagnosticsDoNotCrashOrMutateTests(unittest.TestCase):

    def test_pit_event_with_no_plan_at_all_is_diagnostic_only(self):
        state = fresh_state()
        event = make_event(driver_pit_sequence=1, entry_lap=21, plan_reference=None)
        state2, outcome = pl.apply_pit_event(state, event)
        self.assertEqual(outcome.status, 'diagnostic')
        self.assertEqual(outcome.reason, 'no_plan_for_pit_event')
        self.assertEqual(state2.plan_records, state.plan_records)
        self.assertEqual(state2.active_plan_id, state.active_plan_id)
        self.assertTrue(any(d.code == 'no_plan_for_pit_event' for d in state2.diagnostics))

    def test_a_later_registered_plan_is_not_affected_by_an_earlier_orphan_event(self):
        state = fresh_state()
        old_event = make_event(driver_pit_sequence=1, entry_lap=21, plan_reference=None)
        state, _ = pl.apply_pit_event(state, old_event)
        state, reg = register_active(
            state, current_driver_pit_sequence=1, created_frame=200, activation_frame=200)
        self.assertEqual(state.plan_records[reg.decision_id].phase, 'active')
        self.assertEqual(state.active_plan_id, reg.decision_id)

    def test_event_race_session_mismatch_leaves_active_plan_untouched(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        decision_id = reg.decision_id
        foreign_event = make_event(
            driver_pit_sequence=1, entry_lap=21, race_instance_id='sub:other-race',
            plan_reference=make_plan_reference(decision_id, race_instance_id='sub:other-race'))
        state2, outcome = pl.apply_pit_event(state, foreign_event)
        self.assertEqual(outcome.status, 'diagnostic')
        self.assertEqual(outcome.reason, 'event_scope_mismatch')
        self.assertEqual(state2.plan_records[decision_id], state.plan_records[decision_id])
        self.assertEqual(state2.active_plan_id, decision_id)

    def test_register_plan_scope_mismatch_is_rejected(self):
        state = fresh_state()
        state2, outcome = pl.register_plan(
            state, decision_id='sub:other:decision-X', race_instance_id='sub:other',
            session_num=0, selected_plan='A', phase='active',
            current_driver_pit_sequence=0, created_source_frame_sequence=1,
            activation_source_frame_sequence=1, target_lap=10)
        self.assertEqual(outcome.status, 'rejected')
        self.assertEqual(outcome.reason, 'scope_mismatch')
        self.assertEqual(state2.plan_records, {})

    def test_activate_plan_unknown_decision_in_this_scope_is_rejected(self):
        # `RaceStrategyState.__post_init__` already makes a record/state scope
        # mismatch unrepresentable (register_plan is the only writer and it
        # enforces scope), so the reachable failure mode for activate_plan's
        # scope guard is an unknown decision_id for this state's scope —
        # e.g. a decision_id that belongs to a different race/session and was
        # never registered here.
        state = fresh_state()
        result_state, outcome = pl.activate_plan(
            state, decision_id='sub:other-race:decision-X', expected_record_revision=0,
            current_driver_pit_sequence=0, activation_source_frame_sequence=6)
        self.assertEqual(outcome.status, 'rejected')
        self.assertEqual(outcome.reason, 'unknown_decision')
        self.assertEqual(result_state.plan_records, {})

    def test_close_scope_only_cancels_current_scope_and_new_scope_starts_independent(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        state, _ = pl.close_scope(state, reason='race_identity_changed')
        self.assertEqual(state.plan_records[reg.decision_id].phase, 'cancelled')
        self.assertIsNone(state.active_plan_id)

        new_state = pl.new_race_strategy_state('sub:road-atlanta-2', 0)
        self.assertEqual(new_state.plan_records, {})
        self.assertIsNone(new_state.active_plan_id)
        # old terminal archive is untouched and not merged into the new scope
        self.assertEqual(state.plan_records[reg.decision_id].phase, 'cancelled')


# ══════════════════════════════════════════════════════════════════════
# §7-12: cancel / session_end terminal archive
# ══════════════════════════════════════════════════════════════════════

class CancelAndSessionEndTests(unittest.TestCase):

    def test_cancelled_plan_does_not_revive_and_is_traceable_from_serializer(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        state, cancel_outcome = pl.cancel_plan(
            state, decision_id=reg.decision_id, reason='driver_declined')
        self.assertEqual(cancel_outcome.status, 'cancelled')
        record = state.plan_records[reg.decision_id]
        self.assertEqual(record.phase, 'cancelled')
        self.assertEqual(record.invalidated_reason, 'driver_declined')
        self.assertIsNone(state.active_plan_id)

        # A pit event referencing the cancelled decision must not revive it.
        event = make_event(
            driver_pit_sequence=1, entry_lap=21,
            plan_reference=make_plan_reference(reg.decision_id))
        state2, _ = pl.apply_pit_event(state, event)
        self.assertEqual(state2.plan_records[reg.decision_id].phase, 'cancelled')

        serialized = pl.serialize_race_strategy_state(state2)
        self.assertEqual(serialized['plan_records'][reg.decision_id]['phase'], 'cancelled')

    def test_session_end_cancels_only_non_terminal_records(self):
        state = fresh_state()
        state, reg_active = register_active(state, current_driver_pit_sequence=0)
        event = make_event(
            driver_pit_sequence=1, entry_lap=21,
            plan_reference=make_plan_reference(reg_active.decision_id))
        state, _ = pl.apply_pit_event(state, event)
        self.assertEqual(state.plan_records[reg_active.decision_id].phase, 'executed')

        state, reg_awaiting = register_awaiting(
            state, decision_id='sub:road-atlanta-1:decision-late-b', current_driver_pit_sequence=1)
        state, close_outcome = pl.close_scope(state, reason='session_end')
        self.assertEqual(close_outcome.status, 'closed')
        self.assertEqual(state.plan_records[reg_active.decision_id].phase, 'executed')
        self.assertEqual(state.plan_records[reg_awaiting.decision_id].phase, 'cancelled')


# ══════════════════════════════════════════════════════════════════════
# §7-13: input immutability
# ══════════════════════════════════════════════════════════════════════

class ImmutabilityTests(unittest.TestCase):

    def test_register_plan_does_not_mutate_caller_dicts(self):
        state = fresh_state()
        conditions = {'fuel_window_open': True}
        options_snapshot = {'plan_a': {'target_lap': 21}}
        state, reg = register_active(
            state, current_driver_pit_sequence=0, conditions=conditions,
            options_snapshot=options_snapshot)
        conditions['fuel_window_open'] = False
        options_snapshot['plan_a']['target_lap'] = 999
        stored = state.plan_records[reg.decision_id]
        self.assertEqual(stored.conditions, {'fuel_window_open': True})
        self.assertEqual(stored.options_snapshot, {'plan_a': {'target_lap': 21}})

    def test_apply_pit_event_does_not_mutate_the_input_event_or_prior_state(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        event = make_event(
            driver_pit_sequence=1, entry_lap=21,
            plan_reference=make_plan_reference(reg.decision_id))
        event_copy = copy.deepcopy(dataclasses.asdict(event))
        state_before_records = dict(state.plan_records)
        pl.apply_pit_event(state, event)
        self.assertEqual(dataclasses.asdict(event), event_copy)
        self.assertEqual(state.plan_records, state_before_records)

    def test_serializer_output_mutation_does_not_affect_the_store(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        serialized = pl.serialize_plan_lifecycle_record(state.plan_records[reg.decision_id])
        serialized['conditions']['k'] = 'mutated'
        self.assertEqual(state.plan_records[reg.decision_id].conditions, {'k': 'v'})


# ══════════════════════════════════════════════════════════════════════
# §7-15: constructor/validator rejects invalid phase/active-pointer combos
# ══════════════════════════════════════════════════════════════════════

class ConstructorValidationTests(unittest.TestCase):

    def _record_kwargs(self, **overrides):
        kwargs = dict(
            decision_id='x', race_instance_id=RACE, session_num=SESSION, revision=0,
            selected_plan='A', plan_basis=None, target_lap=None, add_fuel_l=None,
            set_fuel_l=None, conditions=None, validity_contract=None,
            evidence_snapshot_id=None, options_snapshot=None, phase='awaiting_driver',
            registered_phase='awaiting_driver',
            expected_pit_sequence=None, resolved_pit_sequence=None, invalidated_reason=None,
            execution_relation=None, terminal_pit_event_id=None,
            created_source_frame_sequence=0, registered_driver_pit_sequence=0,
            activated_source_frame_sequence=None, activation_record_revision=None)
        kwargs.update(overrides)
        return kwargs

    def test_unknown_phase_value_is_rejected(self):
        with self.assertRaises(ValueError):
            pl.PlanLifecycleRecord(**self._record_kwargs(phase='mid_flight'))

    def test_awaiting_driver_with_frozen_activation_fields_is_rejected(self):
        with self.assertRaises(ValueError):
            pl.PlanLifecycleRecord(**self._record_kwargs(
                phase='awaiting_driver', activated_source_frame_sequence=5))
        with self.assertRaises(ValueError):
            pl.PlanLifecycleRecord(**self._record_kwargs(
                phase='awaiting_driver', expected_pit_sequence=1))

    def test_state_with_active_pointer_to_missing_record_is_rejected(self):
        with self.assertRaises(ValueError):
            pl.RaceStrategyState(
                race_instance_id=RACE, session_num=SESSION, plan_records={},
                active_plan_id='ghost', applied_pit_events={}, history=(), diagnostics=())

    def test_state_with_active_pointer_to_non_active_phase_is_rejected(self):
        record = pl.PlanLifecycleRecord(**self._record_kwargs(
            decision_id='x', phase='awaiting_driver'))
        with self.assertRaises(ValueError):
            pl.RaceStrategyState(
                race_instance_id=RACE, session_num=SESSION, plan_records={'x': record},
                active_plan_id='x', applied_pit_events={}, history=(), diagnostics=())

    def _active_record(self, decision_id):
        return pl.PlanLifecycleRecord(**self._record_kwargs(
            decision_id=decision_id, phase='active', registered_phase='active',
            expected_pit_sequence=1, activated_source_frame_sequence=5,
            activation_record_revision=0))

    def test_state_with_two_active_phase_records_is_rejected(self):
        # §7-15 / 2026-09-24 監査Codex REVISE 1 P1-2: at most one phase==active
        # record may exist, regardless of which one active_plan_id names.
        record_a = self._active_record('a')
        record_b = self._active_record('b')
        with self.assertRaises(ValueError):
            pl.RaceStrategyState(
                race_instance_id=RACE, session_num=SESSION,
                plan_records={'a': record_a, 'b': record_b}, active_plan_id='a',
                applied_pit_events={}, history=(), diagnostics=())

    def test_state_with_an_active_record_but_no_active_pointer_is_rejected(self):
        # P1-2: the inverse direction — an active-phase record must always be
        # named by active_plan_id, not silently orphaned.
        record_a = self._active_record('a')
        with self.assertRaises(ValueError):
            pl.RaceStrategyState(
                race_instance_id=RACE, session_num=SESSION, plan_records={'a': record_a},
                active_plan_id=None, applied_pit_events={}, history=(), diagnostics=())

    def test_state_with_one_active_and_one_awaiting_record_is_allowed(self):
        # P1-2 explicitly permits an active + awaiting_driver pair coexisting
        # (needed for the current proposal-under-negotiation workflow).
        record_a = self._active_record('a')
        record_b = pl.PlanLifecycleRecord(**self._record_kwargs(
            decision_id='b', phase='awaiting_driver', registered_phase='awaiting_driver'))
        state = pl.RaceStrategyState(
            race_instance_id=RACE, session_num=SESSION,
            plan_records={'a': record_a, 'b': record_b}, active_plan_id='a',
            applied_pit_events={}, history=(), diagnostics=())
        self.assertEqual(state.active_plan_id, 'a')


# ══════════════════════════════════════════════════════════════════════
# 2026-09-24 監査Codex REVISE 1 P1-1: deep immutability of nested payloads
# ══════════════════════════════════════════════════════════════════════

class DeepImmutabilityTests(unittest.TestCase):

    def test_state_plan_records_cannot_be_cleared_or_mutated_in_place(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        with self.assertRaises(AttributeError):
            state.plan_records.clear()
        with self.assertRaises(TypeError):
            state.plan_records['ghost'] = state.plan_records[reg.decision_id]
        self.assertIn(reg.decision_id, state.plan_records)

    def test_state_applied_pit_events_cannot_be_mutated_in_place(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        event = make_event(
            driver_pit_sequence=1, entry_lap=21,
            plan_reference=make_plan_reference(reg.decision_id))
        state, _ = pl.apply_pit_event(state, event)
        with self.assertRaises(AttributeError):
            state.applied_pit_events.clear()
        with self.assertRaises(TypeError):
            state.applied_pit_events[event.pit_event_id] = event

    def test_record_nested_conditions_and_options_snapshot_cannot_be_mutated(self):
        state = fresh_state()
        state, reg = register_active(
            state, current_driver_pit_sequence=0, conditions={'fuel_window_open': True},
            options_snapshot={'plan_a': {'target_lap': 21}})
        record = state.plan_records[reg.decision_id]
        with self.assertRaises(TypeError):
            record.conditions['fuel_window_open'] = False
        with self.assertRaises(TypeError):
            record.options_snapshot['plan_a']['target_lap'] = 999
        with self.assertRaises(TypeError):
            record.options_snapshot['plan_a']['new_key'] = 'x'

    def test_diagnostic_detail_cannot_be_mutated(self):
        state = fresh_state()
        state2, outcome = pl.register_plan(
            state, decision_id='sub:other:decision-X', race_instance_id='sub:other',
            session_num=0, selected_plan='A', phase='active',
            current_driver_pit_sequence=0, created_source_frame_sequence=1,
            activation_source_frame_sequence=1, target_lap=10)
        diagnostic = state2.diagnostics[-1]
        with self.assertRaises(TypeError):
            diagnostic.detail['state_scope'] = 'mutated'


# ══════════════════════════════════════════════════════════════════════
# §7-16 / §7-20: activate_plan single entry point, staleness, delayed-ACK
# ══════════════════════════════════════════════════════════════════════

class ActivatePlanTests(unittest.TestCase):

    def test_activation_freezes_expected_sequence_and_frame_exactly_once(self):
        state = fresh_state()
        state, reg = register_awaiting(state, current_driver_pit_sequence=0, created_frame=5)
        state, outcome = pl.activate_plan(
            state, decision_id=reg.decision_id, expected_record_revision=0,
            current_driver_pit_sequence=0, activation_source_frame_sequence=8)
        self.assertEqual(outcome.status, 'activated')
        record = state.plan_records[reg.decision_id]
        self.assertEqual(record.phase, 'active')
        self.assertEqual(record.expected_pit_sequence, 1)
        self.assertEqual(record.activated_source_frame_sequence, 8)
        self.assertEqual(record.activation_record_revision, record.revision)
        self.assertEqual(state.active_plan_id, reg.decision_id)

    def test_same_ack_retry_after_activation_is_a_noop(self):
        state = fresh_state()
        state, reg = register_awaiting(state, current_driver_pit_sequence=0, created_frame=5)
        state, _ = pl.activate_plan(
            state, decision_id=reg.decision_id, expected_record_revision=0,
            current_driver_pit_sequence=0, activation_source_frame_sequence=8)
        record_after_first = state.plan_records[reg.decision_id]
        state2, outcome2 = pl.activate_plan(
            state, decision_id=reg.decision_id, expected_record_revision=0,
            current_driver_pit_sequence=0, activation_source_frame_sequence=8)
        self.assertEqual(outcome2.status, 'retry_no_op')
        self.assertEqual(state2.plan_records[reg.decision_id], record_after_first)

    def test_stale_revision_activation_is_diagnostic_only(self):
        state = fresh_state()
        state, reg = register_awaiting(state, current_driver_pit_sequence=0, created_frame=5)
        state2, outcome = pl.activate_plan(
            state, decision_id=reg.decision_id, expected_record_revision=99,
            current_driver_pit_sequence=0, activation_source_frame_sequence=8)
        self.assertEqual(outcome.status, 'diagnostic')
        self.assertEqual(outcome.reason, 'stale_activation_revision')
        self.assertEqual(state2.plan_records[reg.decision_id].phase, 'awaiting_driver')

    def test_delayed_ack_after_a_real_pit_during_awaiting_window_is_terminal_invalidated(self):
        state = fresh_state()
        state, reg = register_awaiting(state, current_driver_pit_sequence=0, created_frame=5)
        # Driver actually pits (sequence advances to 1) before the ACK for
        # this Plan arrives — its premise (no pit yet) is gone.
        state, outcome = pl.activate_plan(
            state, decision_id=reg.decision_id, expected_record_revision=0,
            current_driver_pit_sequence=1, activation_source_frame_sequence=50)
        self.assertEqual(outcome.status, 'invalidated')
        record = state.plan_records[reg.decision_id]
        self.assertEqual(record.phase, 'invalidated')
        self.assertEqual(record.invalidated_reason, 'pit_before_plan_activation')
        self.assertIsNone(state.active_plan_id)

        # A second, later ACK for the same decision is terminal-late: diagnostic only.
        state2, outcome2 = pl.activate_plan(
            state, decision_id=reg.decision_id, expected_record_revision=1,
            current_driver_pit_sequence=1, activation_source_frame_sequence=60)
        self.assertEqual(outcome2.status, 'diagnostic')
        self.assertEqual(state2.plan_records[reg.decision_id], record)

    def test_active_owner_conflict_blocks_a_second_activation(self):
        state = fresh_state()
        state, reg_active = register_active(state, current_driver_pit_sequence=0)
        state, reg_awaiting = register_awaiting(
            state, decision_id='sub:road-atlanta-1:decision-second', current_driver_pit_sequence=0,
            created_frame=5)
        state2, outcome = pl.activate_plan(
            state, decision_id=reg_awaiting.decision_id, expected_record_revision=0,
            current_driver_pit_sequence=0, activation_source_frame_sequence=8)
        self.assertEqual(outcome.status, 'diagnostic')
        self.assertEqual(outcome.reason, 'active_owner_conflict')
        self.assertEqual(state2.plan_records[reg_awaiting.decision_id].phase, 'awaiting_driver')
        self.assertEqual(state2.active_plan_id, reg_active.decision_id)


# ══════════════════════════════════════════════════════════════════════
# §7-17 / §7-21: unbound/foreign plan_reference fail-closed binding
# ══════════════════════════════════════════════════════════════════════

class IndirectBindingTests(unittest.TestCase):

    def test_active_plan_unbound_reference_after_activation_is_pit_relation_unbound(self):
        state = fresh_state()
        state, reg = register_active(
            state, current_driver_pit_sequence=0, created_frame=5, activation_frame=5)
        event = make_event(
            driver_pit_sequence=1, entry_lap=21, entry_frame=10, plan_reference=None)
        state, outcome = pl.apply_pit_event(state, event)
        record = state.plan_records[reg.decision_id]
        self.assertEqual(record.phase, 'invalidated')
        self.assertEqual(record.invalidated_reason, 'pit_relation_unbound')
        self.assertIsNone(state.active_plan_id)

    def test_foreign_plan_reference_still_binds_by_frame_and_sequence(self):
        state = fresh_state()
        state, reg = register_active(
            state, current_driver_pit_sequence=0, created_frame=5, activation_frame=5)
        foreign_ref = make_plan_reference('sub:road-atlanta-1:decision-unknown')
        event = make_event(
            driver_pit_sequence=1, entry_lap=21, entry_frame=10, plan_reference=foreign_ref)
        state, outcome = pl.apply_pit_event(state, event)
        record = state.plan_records[reg.decision_id]
        self.assertEqual(record.phase, 'invalidated')
        self.assertEqual(record.invalidated_reason, 'pit_relation_unbound')

    def test_same_frame_ordering_ambiguous_fails_closed_instead_of_guessing(self):
        state = fresh_state()
        state, reg = register_active(
            state, current_driver_pit_sequence=0, created_frame=5, activation_frame=5)
        event = make_event(
            driver_pit_sequence=1, entry_lap=21, entry_frame=5, plan_reference=None)
        state, outcome = pl.apply_pit_event(state, event)
        record = state.plan_records[reg.decision_id]
        self.assertEqual(record.phase, 'invalidated')
        self.assertEqual(record.invalidated_reason, 'pit_order_ambiguous')

    def test_old_event_before_activation_is_diagnostic_only_and_preserves_the_new_plan(self):
        state = fresh_state()
        state, reg = register_active(
            state, current_driver_pit_sequence=5, created_frame=100, activation_frame=100)
        # An event whose sequence/frame predate this Plan's own registration —
        # must not touch a Plan created after it.
        old_event = make_event(
            driver_pit_sequence=3, entry_lap=10, entry_frame=40, plan_reference=None)
        state, outcome = pl.apply_pit_event(state, old_event)
        self.assertEqual(outcome.status, 'diagnostic')
        record = state.plan_records[reg.decision_id]
        self.assertEqual(record.phase, 'active')
        self.assertEqual(state.active_plan_id, reg.decision_id)

    def test_awaiting_plan_unbound_event_after_registration_is_pit_before_plan_activation(self):
        state = fresh_state()
        state, reg = register_awaiting(state, current_driver_pit_sequence=0, created_frame=5)
        event = make_event(
            driver_pit_sequence=1, entry_lap=21, entry_frame=10, plan_reference=None)
        state, outcome = pl.apply_pit_event(state, event)
        record = state.plan_records[reg.decision_id]
        self.assertEqual(record.phase, 'invalidated')
        self.assertEqual(record.invalidated_reason, 'pit_before_plan_activation')

    def test_awaiting_plan_same_frame_ordering_ambiguous_fails_closed(self):
        state = fresh_state()
        state, reg = register_awaiting(state, current_driver_pit_sequence=0, created_frame=5)
        event = make_event(
            driver_pit_sequence=1, entry_lap=21, entry_frame=5, plan_reference=None)
        state, outcome = pl.apply_pit_event(state, event)
        record = state.plan_records[reg.decision_id]
        self.assertEqual(record.phase, 'invalidated')
        self.assertEqual(record.invalidated_reason, 'pit_order_ambiguous')

    def test_awaiting_plan_event_before_registration_is_diagnostic_only(self):
        state = fresh_state()
        state, reg = register_awaiting(state, current_driver_pit_sequence=5, created_frame=100)
        old_event = make_event(
            driver_pit_sequence=3, entry_lap=10, entry_frame=40, plan_reference=None)
        state, outcome = pl.apply_pit_event(state, old_event)
        self.assertEqual(outcome.status, 'diagnostic')
        self.assertEqual(state.plan_records[reg.decision_id].phase, 'awaiting_driver')


# ══════════════════════════════════════════════════════════════════════
# §7-14: Road Atlanta single-thread — lap 15 early, then lap 16 penalty
# ══════════════════════════════════════════════════════════════════════

class RoadAtlantaSingleThreadTests(unittest.TestCase):
    """Mirrors the Road Atlanta Build 302 scenario already fixed by WO-001/003
    fixtures (target_lap=21, lap 15 = early declaration, lap 16 = penalty
    pit) but exercises it purely through plan_lifecycle + real DriverPitEvent
    objects — no bridge.py / replay harness involved (out of WO-004 scope)."""

    def test_lap15_early_invalidates_plan_a_once_lap16_penalty_does_not_overwrite(self):
        state = fresh_state()
        state, reg = register_active(
            state, decision_id='sub:road-atlanta-1:decision-plan-a', target_lap=21,
            current_driver_pit_sequence=0, created_frame=5, activation_frame=5)
        decision_id = reg.decision_id
        self.assertIsNotNone(pl.active_plan_view(state))

        lap15_event = make_event(
            driver_pit_sequence=1, entry_lap=15, entry_frame=1500, exit_frame=1510,
            black_flag_state='false', fuel_added_l=16.79,
            plan_reference=make_plan_reference(decision_id, target_lap=21))
        self.assertEqual(lap15_event.execution_relation, 'early')
        state, outcome15 = pl.apply_pit_event(state, lap15_event)
        self.assertEqual(outcome15.status, 'applied')
        record_after_lap15 = state.plan_records[decision_id]
        self.assertEqual(record_after_lap15.phase, 'invalidated')
        self.assertEqual(record_after_lap15.invalidated_reason, 'driver_early_pit')
        self.assertEqual(record_after_lap15.terminal_pit_event_id, lap15_event.pit_event_id)
        self.assertIsNone(pl.active_plan_view(state))
        self.assertIsNone(state.active_plan_id)
        revision_after_lap15 = record_after_lap15.revision

        # lap 16: driver pits again for what turns out to be a penalty. The
        # frozen plan_reference is still Plan A's original decision_id (the
        # Driver never got a new accepted Plan), but Plan A must stay exactly
        # as lap 15 left it — no second invalidation, no reason overwrite.
        lap16_event = make_event(
            driver_pit_sequence=2, entry_lap=16, entry_frame=1600, exit_frame=1610,
            black_flag_state='true', fuel_added_l=0.0,
            plan_reference=make_plan_reference(decision_id, target_lap=21))
        self.assertEqual(lap16_event.execution_relation, 'penalty')
        state, outcome16 = pl.apply_pit_event(state, lap16_event)
        record_after_lap16 = state.plan_records[decision_id]
        self.assertEqual(record_after_lap16.phase, 'invalidated')
        self.assertEqual(record_after_lap16.invalidated_reason, 'driver_early_pit')
        self.assertEqual(record_after_lap16.terminal_pit_event_id, lap15_event.pit_event_id)
        self.assertEqual(record_after_lap16.revision, revision_after_lap15)
        self.assertIsNone(pl.active_plan_view(state))
        self.assertIsNone(state.active_plan_id)

        # Both real DriverPitEvents ended up in the canonical ledger exactly once.
        self.assertIn(lap15_event.pit_event_id, state.applied_pit_events)
        self.assertIn(lap16_event.pit_event_id, state.applied_pit_events)
        self.assertEqual(state.applied_pit_events[lap15_event.pit_event_id], lap15_event)
        self.assertEqual(state.applied_pit_events[lap16_event.pit_event_id], lap16_event)


# ══════════════════════════════════════════════════════════════════════
# 2026-09-24 監査Codex REVISE 1 P1-3: register_plan collision detection
# survives lifecycle progression (4 paths: active/terminal x same/different)
# ══════════════════════════════════════════════════════════════════════

class RegisterPlanCollisionAcrossProgressionTests(unittest.TestCase):

    def test_same_content_retry_after_activation_is_a_noop(self):
        state = fresh_state()
        state, reg = register_awaiting(state, current_driver_pit_sequence=0, created_frame=5)
        state, _ = pl.activate_plan(
            state, decision_id=reg.decision_id, expected_record_revision=0,
            current_driver_pit_sequence=0, activation_source_frame_sequence=8)
        active_record = state.plan_records[reg.decision_id]
        self.assertEqual(active_record.phase, 'active')

        state2, retry_outcome = register_awaiting(
            state, decision_id=reg.decision_id, current_driver_pit_sequence=0, created_frame=5)
        self.assertEqual(retry_outcome.status, 'retry_no_op')
        self.assertEqual(state2.plan_records[reg.decision_id], active_record)

    def test_different_content_retry_after_activation_is_a_collision(self):
        state = fresh_state()
        state, reg = register_awaiting(state, current_driver_pit_sequence=0, created_frame=5)
        state, _ = pl.activate_plan(
            state, decision_id=reg.decision_id, expected_record_revision=0,
            current_driver_pit_sequence=0, activation_source_frame_sequence=8)
        active_record = state.plan_records[reg.decision_id]

        state2, collision_outcome = register_awaiting(
            state, decision_id=reg.decision_id, current_driver_pit_sequence=0, created_frame=5,
            target_lap=99)
        self.assertEqual(collision_outcome.status, 'collision')
        self.assertEqual(state2.plan_records[reg.decision_id], active_record)

    def test_same_content_retry_after_terminal_is_a_noop(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        event = make_event(
            driver_pit_sequence=1, entry_lap=21,
            plan_reference=make_plan_reference(reg.decision_id))
        state, _ = pl.apply_pit_event(state, event)
        terminal_record = state.plan_records[reg.decision_id]
        self.assertEqual(terminal_record.phase, 'executed')

        state2, retry_outcome = register_active(
            state, decision_id=reg.decision_id, current_driver_pit_sequence=0)
        self.assertEqual(retry_outcome.status, 'retry_no_op')
        self.assertEqual(state2.plan_records[reg.decision_id], terminal_record)

    def test_different_content_retry_after_terminal_is_a_collision(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        event = make_event(
            driver_pit_sequence=1, entry_lap=21,
            plan_reference=make_plan_reference(reg.decision_id))
        state, _ = pl.apply_pit_event(state, event)
        terminal_record = state.plan_records[reg.decision_id]

        state2, collision_outcome = register_active(
            state, decision_id=reg.decision_id, current_driver_pit_sequence=0, target_lap=99)
        self.assertEqual(collision_outcome.status, 'collision')
        self.assertEqual(state2.plan_records[reg.decision_id], terminal_record)

    def test_requesting_a_different_registered_phase_for_the_same_id_is_a_collision(self):
        # The originally-requested phase itself is part of the registration
        # contract — asking to (re)register the same decision_id as the other
        # phase is a genuine content disagreement, not a harmless retry.
        state = fresh_state()
        state, reg = register_awaiting(state, current_driver_pit_sequence=0, created_frame=5)
        state2, outcome = register_active(
            state, decision_id=reg.decision_id, current_driver_pit_sequence=0, created_frame=5,
            activation_frame=5)
        self.assertEqual(outcome.status, 'collision')
        self.assertEqual(state2.plan_records[reg.decision_id].phase, 'awaiting_driver')


# ══════════════════════════════════════════════════════════════════════
# 2026-09-24 監査Codex REVISE 1 P1-4: pit event ledger idempotency even when
# the event never bound to any Plan
# ══════════════════════════════════════════════════════════════════════

class UnboundPitEventLedgerIdempotencyTests(unittest.TestCase):

    def test_orphan_event_is_recorded_to_the_ledger_on_first_application(self):
        state = fresh_state()
        event = make_event(driver_pit_sequence=1, entry_lap=21, plan_reference=None)
        state, outcome = pl.apply_pit_event(state, event)
        self.assertEqual(outcome.status, 'diagnostic')
        self.assertIn(event.pit_event_id, state.applied_pit_events)
        self.assertEqual(state.applied_pit_events[event.pit_event_id], event)

    def test_retrying_an_orphan_event_does_not_grow_diagnostics_or_history(self):
        state = fresh_state()
        event = make_event(driver_pit_sequence=1, entry_lap=21, plan_reference=None)
        state, _ = pl.apply_pit_event(state, event)
        diagnostics_after_first = len(state.diagnostics)
        history_after_first = len(state.history)

        state, retry_outcome = pl.apply_pit_event(state, event)
        self.assertEqual(retry_outcome.status, 'retry_no_op')
        self.assertEqual(len(state.diagnostics), diagnostics_after_first)
        self.assertEqual(len(state.history), history_after_first)

    def test_too_old_event_is_ledgered_once_and_retry_does_not_reevaluate_the_plan(self):
        state = fresh_state()
        state, reg = register_active(
            state, current_driver_pit_sequence=5, created_frame=100, activation_frame=100)
        old_event = make_event(
            driver_pit_sequence=3, entry_lap=10, entry_frame=40, plan_reference=None)
        state, outcome1 = pl.apply_pit_event(state, old_event)
        self.assertEqual(outcome1.status, 'diagnostic')
        self.assertIn(old_event.pit_event_id, state.applied_pit_events)
        record_after_first = state.plan_records[reg.decision_id]

        state, outcome2 = pl.apply_pit_event(state, old_event)
        self.assertEqual(outcome2.status, 'retry_no_op')
        self.assertEqual(state.plan_records[reg.decision_id], record_after_first)

    def test_orphan_event_processed_then_new_plan_registered_then_retry_leaves_new_plan_untouched(self):
        state = fresh_state()
        orphan_event = make_event(driver_pit_sequence=1, entry_lap=21, plan_reference=None)
        state, _ = pl.apply_pit_event(state, orphan_event)

        state, reg = register_active(
            state, decision_id='sub:road-atlanta-1:decision-fresh', current_driver_pit_sequence=1,
            created_frame=500, activation_frame=500)
        record_before_retry = state.plan_records[reg.decision_id]

        state, retry_outcome = pl.apply_pit_event(state, orphan_event)
        self.assertEqual(retry_outcome.status, 'retry_no_op')
        self.assertEqual(state.plan_records[reg.decision_id], record_before_retry)
        self.assertEqual(state.plan_records[reg.decision_id].phase, 'active')
        self.assertEqual(state.active_plan_id, reg.decision_id)


# ══════════════════════════════════════════════════════════════════════
# 2026-09-24 監査Codex REVISE 1 不安点2: one event may invalidate an active
# AND an awaiting_driver record simultaneously (judged acceptable — explicit
# positive/negative coverage requested)
# ══════════════════════════════════════════════════════════════════════

class SimultaneousMultiRecordInvalidationTests(unittest.TestCase):

    def test_one_unbound_event_invalidates_both_active_and_awaiting_records(self):
        state = fresh_state()
        state, reg_active = register_active(
            state, decision_id='sub:road-atlanta-1:decision-active', current_driver_pit_sequence=0,
            created_frame=5, activation_frame=5)
        state, reg_awaiting = register_awaiting(
            state, decision_id='sub:road-atlanta-1:decision-awaiting', current_driver_pit_sequence=0,
            created_frame=5)

        # entry_frame(10) is after BOTH anchors (active's activation frame=5,
        # awaiting's creation frame=5), and driver_pit_sequence=1 clears both
        # thresholds (active expected=1, awaiting registered+1=1).
        event = make_event(
            driver_pit_sequence=1, entry_lap=21, entry_frame=10, plan_reference=None)
        state, outcome = pl.apply_pit_event(state, event)
        self.assertEqual(outcome.status, 'applied')

        active_record = state.plan_records[reg_active.decision_id]
        awaiting_record = state.plan_records[reg_awaiting.decision_id]
        self.assertEqual(active_record.phase, 'invalidated')
        self.assertEqual(active_record.invalidated_reason, 'pit_relation_unbound')
        self.assertEqual(awaiting_record.phase, 'invalidated')
        self.assertEqual(awaiting_record.invalidated_reason, 'pit_before_plan_activation')
        self.assertIsNone(state.active_plan_id)
        self.assertIsNone(pl.active_plan_view(state))

    def test_an_unbound_event_that_only_proves_against_the_active_record_leaves_the_awaiting_one_alone(self):
        state = fresh_state()
        state, reg_active = register_active(
            state, decision_id='sub:road-atlanta-1:decision-active', current_driver_pit_sequence=0,
            created_frame=5, activation_frame=5)
        # Registered later (after the active Plan) with a higher creation
        # frame/pit sequence threshold that this event does not clear.
        state, reg_awaiting = register_awaiting(
            state, decision_id='sub:road-atlanta-1:decision-awaiting', current_driver_pit_sequence=3,
            created_frame=400)

        event = make_event(
            driver_pit_sequence=1, entry_lap=21, entry_frame=10, plan_reference=None)
        state, outcome = pl.apply_pit_event(state, event)
        self.assertEqual(outcome.status, 'applied')
        self.assertEqual(state.plan_records[reg_active.decision_id].phase, 'invalidated')
        self.assertEqual(state.plan_records[reg_awaiting.decision_id].phase, 'awaiting_driver')


# ══════════════════════════════════════════════════════════════════════
# 2026-09-24 監査Codex REVISE 1 不安点5: out-of-contract execution_relation
# fails closed under its own distinct reason instead of masquerading as a
# real WO-003 'unresolved' classification
# ══════════════════════════════════════════════════════════════════════

class InvalidRelationFallbackTests(unittest.TestCase):

    def test_an_execution_relation_outside_wo003s_contract_invalidates_as_pit_relation_invalid(self):
        state = fresh_state()
        state, reg = register_active(state, current_driver_pit_sequence=0)
        real_event = make_event(
            driver_pit_sequence=1, entry_lap=21,
            plan_reference=make_plan_reference(reg.decision_id))
        self.assertEqual(real_event.execution_relation, 'normal')
        # WO-003 itself never produces anything outside
        # {normal, early, penalty, unresolved}; this forges a corrupted value
        # purely to prove plan_lifecycle fails closed on a contract violation
        # instead of silently reusing the real 'unresolved' diagnosis.
        forged_event = dataclasses.replace(real_event, execution_relation='mystery_relation')
        state, outcome = pl.apply_pit_event(state, forged_event)
        record = state.plan_records[reg.decision_id]
        self.assertEqual(record.phase, 'invalidated')
        self.assertEqual(record.invalidated_reason, 'pit_relation_invalid')
        self.assertNotEqual(record.invalidated_reason, 'pit_relation_unresolved')


# ══════════════════════════════════════════════════════════════════════
# 2026-09-24 監査Codex REVISE 2: public dataclass constructors themselves
# must freeze nested payloads and normalize state mappings — bypassing
# register_plan()/_with_diagnostic()/_store_record() must not escape the
# immutability or active-record invariants.
# ══════════════════════════════════════════════════════════════════════

class PublicConstructorFreezingTests(unittest.TestCase):

    def _minimal_record_kwargs(self, **overrides):
        kwargs = dict(
            decision_id='sub:road-atlanta-1:decision-direct', race_instance_id=RACE,
            session_num=SESSION, revision=0, selected_plan='A', plan_basis=None,
            target_lap=21, add_fuel_l=None, set_fuel_l=None, conditions={'k': 'v'},
            validity_contract={'kind': 'stint'}, evidence_snapshot_id='snap:1',
            options_snapshot={'plan_a': {'target_lap': 21}}, phase='awaiting_driver',
            registered_phase='awaiting_driver', expected_pit_sequence=None,
            resolved_pit_sequence=None, invalidated_reason=None, execution_relation=None,
            terminal_pit_event_id=None, created_source_frame_sequence=5,
            registered_driver_pit_sequence=0, activated_source_frame_sequence=None,
            activation_record_revision=None)
        kwargs.update(overrides)
        return kwargs

    def test_directly_constructed_record_conditions_and_options_snapshot_are_frozen(self):
        # register_plan() is bypassed entirely here — item 1.
        record = pl.PlanLifecycleRecord(**self._minimal_record_kwargs())
        with self.assertRaises(TypeError):
            record.conditions['k'] = 'mutated'
        with self.assertRaises(TypeError):
            record.options_snapshot['plan_a']['target_lap'] = 999
        with self.assertRaises(TypeError):
            record.validity_contract['kind'] = 'mutated'

    def test_directly_constructed_record_is_not_affected_by_later_mutation_of_the_original_dict(self):
        original_conditions = {'k': 'v'}
        original_options = {'plan_a': {'target_lap': 21}}
        record = pl.PlanLifecycleRecord(**self._minimal_record_kwargs(
            conditions=original_conditions, options_snapshot=original_options))
        original_conditions['k'] = 'mutated-after-construction'
        original_options['plan_a']['target_lap'] = 999
        self.assertEqual(record.conditions, {'k': 'v'})
        self.assertEqual(record.options_snapshot, {'plan_a': {'target_lap': 21}})

    def test_directly_constructed_active_record_requires_full_activation_bookkeeping(self):
        # item 5: phase='active' via the public constructor must still be
        # rejected if activation frame / expected sequence / activation
        # revision are not all frozen together.
        base = self._minimal_record_kwargs(
            phase='active', registered_phase='active', expected_pit_sequence=1,
            activated_source_frame_sequence=5, activation_record_revision=0)
        pl.PlanLifecycleRecord(**base)  # valid combination must succeed

        with self.assertRaises(ValueError):
            pl.PlanLifecycleRecord(**dict(base, activated_source_frame_sequence=None))
        with self.assertRaises(ValueError):
            pl.PlanLifecycleRecord(**dict(base, expected_pit_sequence=None))
        with self.assertRaises(ValueError):
            pl.PlanLifecycleRecord(**dict(base, activation_record_revision=None))

    def test_directly_constructed_diagnostic_detail_is_frozen(self):
        # item 2 — bypasses _with_diagnostic() entirely.
        original_detail = {'a': 1}
        diagnostic = pl.LifecycleDiagnostic(
            code='manual_probe', decision_id=None, pit_event_id=None,
            race_instance_id=RACE, session_num=SESSION, detail=original_detail)
        with self.assertRaises(TypeError):
            diagnostic.detail['a'] = 999
        original_detail['a'] = 'mutated-after-construction'
        self.assertEqual(diagnostic.detail, {'a': 1})

    def test_directly_constructed_diagnostic_with_none_detail_defaults_to_empty_frozen_mapping(self):
        diagnostic = pl.LifecycleDiagnostic(
            code='manual_probe', decision_id=None, pit_event_id=None,
            race_instance_id=RACE, session_num=SESSION, detail=None)
        self.assertEqual(dict(diagnostic.detail), {})
        with self.assertRaises(TypeError):
            diagnostic.detail['a'] = 1

    def test_directly_constructed_state_normalizes_plan_records_and_applied_pit_events(self):
        # item 3 — bypasses _store_record()/new_race_strategy_state() entirely,
        # and reproduces the exact audit repro (plain dict -> constructor ->
        # .clear() must now fail instead of silently succeeding).
        record = pl.PlanLifecycleRecord(**self._minimal_record_kwargs(
            phase='active', registered_phase='active', expected_pit_sequence=1,
            activated_source_frame_sequence=5, activation_record_revision=0))
        original_plan_records = {record.decision_id: record}
        original_events = {}
        state = pl.RaceStrategyState(
            race_instance_id=RACE, session_num=SESSION, plan_records=original_plan_records,
            active_plan_id=record.decision_id, applied_pit_events=original_events,
            history=[], diagnostics=[])

        with self.assertRaises(AttributeError):
            state.plan_records.clear()
        with self.assertRaises(TypeError):
            state.plan_records['ghost'] = record
        with self.assertRaises(AttributeError):
            state.applied_pit_events.clear()

        # Mutating the ORIGINAL dicts after construction must not leak into state.
        original_plan_records['ghost'] = record
        original_events['ghost'] = 'leak'
        self.assertNotIn('ghost', state.plan_records)
        self.assertNotIn('ghost', state.applied_pit_events)
        self.assertEqual(state.active_plan_id, record.decision_id)

    def test_directly_constructed_state_normalizes_history_and_diagnostics_to_tuples(self):
        history_entry = pl.LifecycleHistoryEntry(
            decision_id='x', race_instance_id=RACE, session_num=SESSION, revision=0,
            phase='awaiting_driver', reason='register_awaiting_driver', pit_event_id=None)
        diagnostic_entry = pl.LifecycleDiagnostic(
            code='manual_probe', decision_id=None, pit_event_id=None,
            race_instance_id=RACE, session_num=SESSION, detail=None)
        state = pl.RaceStrategyState(
            race_instance_id=RACE, session_num=SESSION, plan_records={}, active_plan_id=None,
            applied_pit_events={}, history=[history_entry], diagnostics=[diagnostic_entry])
        self.assertIsInstance(state.history, tuple)
        self.assertIsInstance(state.diagnostics, tuple)
        self.assertEqual(state.history, (history_entry,))
        self.assertEqual(state.diagnostics, (diagnostic_entry,))

    def test_direct_construction_still_enforces_active_pointer_invariant_after_normalization(self):
        # Normalization must happen BEFORE the P1-2 active-pointer validation
        # runs, not instead of it.
        record = pl.PlanLifecycleRecord(**self._minimal_record_kwargs(
            phase='active', registered_phase='active', expected_pit_sequence=1,
            activated_source_frame_sequence=5, activation_record_revision=0))
        with self.assertRaises(ValueError):
            pl.RaceStrategyState(
                race_instance_id=RACE, session_num=SESSION,
                plan_records={record.decision_id: record}, active_plan_id=None,
                applied_pit_events={}, history=[], diagnostics=[])


# ══════════════════════════════════════════════════════════════════════
# WO-005 §4.5 / §7-11..13: atomic active-predecessor -> successor replacement
# ══════════════════════════════════════════════════════════════════════

class ActivateReplacingPlanTests(unittest.TestCase):

    def test_accepted_successor_atomically_replaces_active_predecessor(self):
        state = fresh_state()
        state, reg_a = register_active(state, current_driver_pit_sequence=0)
        state, reg_b = register_awaiting(
            state, decision_id='sub:road-atlanta-1:decision-B', current_driver_pit_sequence=0)
        state, outcome = pl.activate_replacing_plan(
            state, predecessor_decision_id=reg_a.decision_id, expected_predecessor_revision=0,
            successor_decision_id=reg_b.decision_id, expected_successor_revision=0,
            current_driver_pit_sequence=0, activation_source_frame_sequence=12)
        self.assertEqual(outcome.status, 'activated')
        self.assertEqual(state.active_plan_id, reg_b.decision_id)
        predecessor = state.plan_records[reg_a.decision_id]
        successor = state.plan_records[reg_b.decision_id]
        self.assertEqual(predecessor.phase, 'cancelled')
        self.assertEqual(predecessor.invalidated_reason, 'superseded_by:%s' % reg_b.decision_id)
        self.assertEqual(successor.phase, 'active')
        self.assertEqual(successor.expected_pit_sequence, 1)
        self.assertEqual(successor.activated_source_frame_sequence, 12)
        # No intermediate state is observable: never zero, never two actives.
        active_count = sum(1 for r in state.plan_records.values() if r.phase == 'active')
        self.assertEqual(active_count, 1)

    def test_pit_sequence_advance_during_awaiting_invalidates_only_successor(self):
        state = fresh_state()
        state, reg_a = register_active(state, current_driver_pit_sequence=0)
        state, reg_b = register_awaiting(
            state, decision_id='sub:road-atlanta-1:decision-B', current_driver_pit_sequence=0)
        state, outcome = pl.activate_replacing_plan(
            state, predecessor_decision_id=reg_a.decision_id, expected_predecessor_revision=0,
            successor_decision_id=reg_b.decision_id, expected_successor_revision=0,
            current_driver_pit_sequence=1, activation_source_frame_sequence=12)
        self.assertEqual(outcome.status, 'invalidated')
        self.assertEqual(outcome.reason, 'pit_before_plan_activation')
        # Predecessor stays active and the pointer is untouched — this is an
        # explicit transition, not a generic validation failure.
        self.assertEqual(state.active_plan_id, reg_a.decision_id)
        self.assertEqual(state.plan_records[reg_a.decision_id].phase, 'active')
        self.assertEqual(state.plan_records[reg_a.decision_id].revision, 0)
        self.assertEqual(state.plan_records[reg_b.decision_id].phase, 'invalidated')

    def test_stale_predecessor_revision_mutates_nothing(self):
        state = fresh_state()
        state, reg_a = register_active(state, current_driver_pit_sequence=0)
        state, reg_b = register_awaiting(
            state, decision_id='sub:road-atlanta-1:decision-B', current_driver_pit_sequence=0)
        before = state
        state2, outcome = pl.activate_replacing_plan(
            state, predecessor_decision_id=reg_a.decision_id, expected_predecessor_revision=99,
            successor_decision_id=reg_b.decision_id, expected_successor_revision=0,
            current_driver_pit_sequence=0, activation_source_frame_sequence=12)
        self.assertEqual(outcome.status, 'diagnostic')
        self.assertEqual(outcome.reason, 'stale_predecessor_revision')
        self.assertEqual(state2.plan_records[reg_a.decision_id], before.plan_records[reg_a.decision_id])
        self.assertEqual(state2.plan_records[reg_b.decision_id], before.plan_records[reg_b.decision_id])
        self.assertEqual(state2.active_plan_id, reg_a.decision_id)

    def test_stale_call_never_disturbs_a_different_current_active(self):
        # Predecessor A was already replaced by C in a prior transaction; a
        # late replacement call naming A as predecessor must never touch the
        # NOW-current active C, nor the terminal A, nor the awaiting B.
        state = fresh_state()
        state, reg_a = register_active(state, current_driver_pit_sequence=0)
        state, reg_b = register_awaiting(
            state, decision_id='sub:road-atlanta-1:decision-B', current_driver_pit_sequence=0)
        state, reg_c = register_awaiting(
            state, decision_id='sub:road-atlanta-1:decision-C', current_driver_pit_sequence=0,
            selected_plan='C')
        state, _ = pl.activate_replacing_plan(
            state, predecessor_decision_id=reg_a.decision_id, expected_predecessor_revision=0,
            successor_decision_id=reg_c.decision_id, expected_successor_revision=0,
            current_driver_pit_sequence=0, activation_source_frame_sequence=12)
        self.assertEqual(state.active_plan_id, reg_c.decision_id)
        before = state
        state2, outcome = pl.activate_replacing_plan(
            state, predecessor_decision_id=reg_a.decision_id, expected_predecessor_revision=0,
            successor_decision_id=reg_b.decision_id, expected_successor_revision=0,
            current_driver_pit_sequence=0, activation_source_frame_sequence=20)
        self.assertEqual(outcome.status, 'diagnostic')
        self.assertEqual(outcome.reason, 'replacement_predecessor_not_current_active')
        self.assertEqual(state2.active_plan_id, reg_c.decision_id)
        self.assertEqual(state2.plan_records[reg_c.decision_id], before.plan_records[reg_c.decision_id])
        self.assertEqual(state2.plan_records[reg_b.decision_id], before.plan_records[reg_b.decision_id])
        self.assertEqual(state2.plan_records[reg_a.decision_id], before.plan_records[reg_a.decision_id])

    def test_successor_must_be_awaiting_driver_not_terminal_or_already_active(self):
        state = fresh_state()
        state, reg_a = register_active(state, current_driver_pit_sequence=0)
        state, reg_b = register_awaiting(
            state, decision_id='sub:road-atlanta-1:decision-B', current_driver_pit_sequence=0)
        state, _ = pl.cancel_plan(state, decision_id=reg_b.decision_id, reason='driver_declined')
        before = state
        state2, outcome = pl.activate_replacing_plan(
            state, predecessor_decision_id=reg_a.decision_id, expected_predecessor_revision=0,
            successor_decision_id=reg_b.decision_id, expected_successor_revision=1,
            current_driver_pit_sequence=0, activation_source_frame_sequence=12)
        self.assertEqual(outcome.status, 'diagnostic')
        self.assertEqual(outcome.reason, 'terminal_or_active_late_ack')
        self.assertEqual(state2.plan_records[reg_b.decision_id], before.plan_records[reg_b.decision_id])
        self.assertEqual(state2.active_plan_id, reg_a.decision_id)


class RegisterActiveReplacingPlanTests(unittest.TestCase):

    def test_new_content_plan_a_atomically_replaces_active_predecessor(self):
        state = fresh_state()
        state, reg_a = register_active(state, current_driver_pit_sequence=0, target_lap=21)
        state, outcome = pl.register_active_replacing_plan(
            state, decision_id='sub:road-atlanta-1:decision-A2', race_instance_id=RACE,
            session_num=SESSION, selected_plan='A', current_driver_pit_sequence=0,
            created_source_frame_sequence=40, activation_source_frame_sequence=40,
            expected_predecessor_decision_id=reg_a.decision_id, expected_predecessor_revision=0,
            target_lap=18, add_fuel_l=32.0, set_fuel_l=None, conditions={'k': 'v2'},
            evidence_snapshot_id='snap:2', options_snapshot={'plan_a': {'target_lap': 18}})
        self.assertEqual(outcome.status, 'registered')
        self.assertEqual(state.active_plan_id, 'sub:road-atlanta-1:decision-A2')
        predecessor = state.plan_records[reg_a.decision_id]
        successor = state.plan_records['sub:road-atlanta-1:decision-A2']
        self.assertEqual(predecessor.phase, 'cancelled')
        self.assertEqual(predecessor.invalidated_reason, 'superseded_by:sub:road-atlanta-1:decision-A2')
        self.assertEqual(successor.phase, 'active')
        self.assertEqual(successor.target_lap, 18)
        active_count = sum(1 for r in state.plan_records.values() if r.phase == 'active')
        self.assertEqual(active_count, 1)

    def test_stale_predecessor_revision_mutates_nothing_and_registers_no_successor(self):
        state = fresh_state()
        state, reg_a = register_active(state, current_driver_pit_sequence=0)
        before = state
        state2, outcome = pl.register_active_replacing_plan(
            state, decision_id='sub:road-atlanta-1:decision-A2', race_instance_id=RACE,
            session_num=SESSION, selected_plan='A', current_driver_pit_sequence=0,
            created_source_frame_sequence=40, activation_source_frame_sequence=40,
            expected_predecessor_decision_id=reg_a.decision_id, expected_predecessor_revision=99,
            target_lap=18)
        self.assertEqual(outcome.status, 'diagnostic')
        self.assertEqual(outcome.reason, 'stale_predecessor_revision')
        self.assertNotIn('sub:road-atlanta-1:decision-A2', state2.plan_records)
        self.assertEqual(state2.plan_records[reg_a.decision_id], before.plan_records[reg_a.decision_id])
        self.assertEqual(state2.active_plan_id, reg_a.decision_id)

    def test_predecessor_no_longer_current_active_is_diagnostic_only(self):
        state = fresh_state()
        state, reg_a = register_active(state, current_driver_pit_sequence=0)
        state, outcome_c = pl.register_active_replacing_plan(
            state, decision_id='sub:road-atlanta-1:decision-C', race_instance_id=RACE,
            session_num=SESSION, selected_plan='C', current_driver_pit_sequence=0,
            created_source_frame_sequence=40, activation_source_frame_sequence=40,
            expected_predecessor_decision_id=reg_a.decision_id, expected_predecessor_revision=0,
            target_lap=19)
        self.assertEqual(outcome_c.status, 'registered')
        before = state
        state2, outcome = pl.register_active_replacing_plan(
            state, decision_id='sub:road-atlanta-1:decision-A2', race_instance_id=RACE,
            session_num=SESSION, selected_plan='A', current_driver_pit_sequence=0,
            created_source_frame_sequence=45, activation_source_frame_sequence=45,
            expected_predecessor_decision_id=reg_a.decision_id, expected_predecessor_revision=0,
            target_lap=18)
        self.assertEqual(outcome.status, 'diagnostic')
        self.assertEqual(outcome.reason, 'replacement_predecessor_not_current_active')
        self.assertNotIn('sub:road-atlanta-1:decision-A2', state2.plan_records)
        self.assertEqual(state2.active_plan_id, 'sub:road-atlanta-1:decision-C')
        self.assertEqual(state2.plan_records['sub:road-atlanta-1:decision-C'],
                          before.plan_records['sub:road-atlanta-1:decision-C'])

    def test_decision_id_collision_is_rejected_without_touching_predecessor(self):
        state = fresh_state()
        state, reg_a = register_active(state, current_driver_pit_sequence=0)
        # A terminal record already occupies the desired id — the realistic
        # collision case (an active record can never coexist with reg_a
        # under the single-active invariant, so this is the only reachable
        # occupant to test the collision guard against).
        state, reg_other = register_awaiting(
            state, decision_id='sub:road-atlanta-1:decision-taken', current_driver_pit_sequence=0)
        state, _ = pl.cancel_plan(state, decision_id=reg_other.decision_id, reason='driver_declined')
        before = state
        state2, outcome = pl.register_active_replacing_plan(
            state, decision_id=reg_other.decision_id, race_instance_id=RACE,
            session_num=SESSION, selected_plan='A', current_driver_pit_sequence=0,
            created_source_frame_sequence=40, activation_source_frame_sequence=40,
            expected_predecessor_decision_id=reg_a.decision_id, expected_predecessor_revision=0,
            target_lap=18)
        self.assertEqual(outcome.status, 'collision')
        self.assertEqual(state2.plan_records[reg_a.decision_id], before.plan_records[reg_a.decision_id])
        self.assertEqual(state2.active_plan_id, reg_a.decision_id)


if __name__ == '__main__':
    unittest.main()
