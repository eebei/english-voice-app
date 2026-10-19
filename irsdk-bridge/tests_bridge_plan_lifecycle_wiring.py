#!/usr/bin/env python3
"""WO-005 — production wiring / replay tests for the Lifecycle-owned Plan
migration (review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md WO-005 Revision 7).

Two kinds of test live here, and each test says which it is:

  * REAL POLL LOOP REPLAY — `replay_harness.replay()` drives the actual
    `bridge.poll_iracing()` over saved frames (reusing
    `tests_wo001_road_atlanta_fixture.run_scenario()`'s WO-001 red-thread
    fixture, unchanged). `plan_lifecycle`'s internal `RaceStrategyState` is
    NEVER inspected directly — the only observation points are the same
    production `log()` / `broadcast()` stream every WO-001..004 wiring test
    already uses (this fixture happens to naturally exercise
    `register_active_replacing_plan()`, since the live fuel top-up between
    the initial playbook registration and the decision-lock commit changes
    `add_fuel_l`/`set_fuel_l` — see `PlanACommitProductionReplayTests`).
  * PRODUCTION PURE-FUNCTION WIRING — calls bridge.py's own real functions
    (`build_strategy_decision`, `resolve_strategy_proposal`,
    `apply_proposal_delivery`, `plan_actionable_signature`) together with
    the real `plan_lifecycle` / `bridge_plan_lifecycle_adapter` modules to
    prove the B/C proposal -> accept -> atomic-replace glue pattern bridge.py
    uses is correct. This is NOT a full `poll_iracing()` replay for B/C.

`ProposalAcceptedFullPollReplayTests` (WO-005 REVISE 1 R2) closes that exact
gap: it drives real `bridge.poll_iracing()` over synthetic-but-deterministic
raw telemetry frames that naturally make the live decision engine select
Plan B (fuel window open + measured pace advantage + clear rejoin forecast,
via the real `pit_exit_forecaster`/`pit_loss_calibrator` modules seeded from
a checked-in calibration fixture — the only swapped external boundary,
exactly like `reader`/`broadcast`/`log`/`time`), then injects the Desktop
audible-delivery and accepted-response messages through
`replay_harness.replay()`'s `on_frame_ready` seam using the SAME
`bridge._queue_strategy_delivery_report()` / `bridge._queue_strategy_decision_
response()` functions the real websocket handler calls. Every assertion
reads only the real `broadcast()`/`log()` stream — `plan_lifecycle` is never
imported or called from that test class.

Road Atlanta acceptance F01 stays intentionally red and F03 stays green
(`tests_wo001_road_atlanta_fixture.py` already proves this; not repeated
here). `DriverPitEvent` application into `plan_lifecycle` (`apply_pit_event`)
remains out of scope for WO-005 (WO-007).
"""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bridge  # noqa: E402
import bridge_plan_lifecycle_adapter as adapter  # noqa: E402
import plan_lifecycle as pl  # noqa: E402
import replay_harness as rh  # noqa: E402
import tests_wo001_road_atlanta_fixture as road_atlanta  # noqa: E402


# ══════════════════════════════════════════════════════════════════════
# REAL POLL LOOP REPLAY — Plan A initial registration / commit-replace /
# box call / telemetry cross-reference, driven by the unmodified WO-001
# Road Atlanta red-thread frames.
# ══════════════════════════════════════════════════════════════════════

class PlanACommitProductionReplayTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.scenario = road_atlanta.run_scenario()
        cls.result = cls.scenario['result']

    def test_initial_registration_happens_exactly_once_as_register_new(self):
        lines = self.result.logs_containing('PLAN LIFECYCLE INITIAL REGISTRATION:')
        self.assertEqual(len(lines), 1, lines)
        self.assertIn('action=register_new', lines[0])
        self.assertIn('status=registered', lines[0])

    def test_no_lifecycle_registration_or_scope_failures(self):
        for needle in ('PLAN LIFECYCLE INITIAL REGISTRATION FAILED',
                       'PLAN LIFECYCLE COMMIT FAILED', 'PLAN LIFECYCLE SCOPE INIT ERROR',
                       'PLAN LIFECYCLE ACCEPT FAILED'):
            self.assertEqual(self.result.logs_containing(needle), [],
                              '%s must not occur in this fixture' % needle)

    def test_decision_opened_exactly_once_for_the_single_plan_a(self):
        # strategy_options_decision_sent gates further decision-lock re-entry
        # once dispatched — a real fixture with no B/C switch commits once.
        lines = self.result.logs_containing('DECISION opened:')
        # WO-019: 16.79 L at L15 finishes without another stop, so no post-stop decision
        # (the pre-stop snapshot is never re-committed under a new ID).
        self.assertEqual(len(lines), 1, lines)
        self.assertIn(':decision-lap:5:', lines[0])
        # Each finalized visit (L15 early, L16 penalty) retires the pre-visit options once.
        self.assertEqual(len(self.result.logs_containing(
            'STRATEGY OPTIONS invalidated: reason=post_service_requires_fresh_recalculation')),
            len(self.result.logs_containing('PLAN LIFECYCLE PIT:')))

    def test_commit_replaces_the_initial_active_record_when_live_topup_changed_content(self):
        # The fixture's live fuel top-up between the initial playbook
        # registration and the later decision-lock commit changes
        # add_fuel_l/set_fuel_l — content genuinely differs, so this MUST be
        # an atomic register_active_replacing_plan(), never a silent
        # duplicate register_new (which would leave two Plan A records, or
        # violate the at-most-one-active invariant that plan_lifecycle's own
        # RaceStrategyState.__post_init__ enforces).
        commit_lines = self.result.logs_containing('PLAN LIFECYCLE COMMIT: action=')
        # WO-019: the second (post-stop register_new) commit was the stale re-commit.
        self.assertEqual(len(commit_lines), 1, commit_lines)
        self.assertIn('action=register_replacing', commit_lines[0])
        self.assertIn('status=registered', commit_lines[0])

    def test_box_call_payload_strategy_options_matches_the_frozen_decision(self):
        box_calls = self.scenario['box_calls']
        self.assertEqual(box_calls, [], "WO-007: actual pits retire the old decision")
        decision = self.scenario['decision']
        for box_call in box_calls:
            plan_letter = box_call['selected_plan'].lower()
            box_plan = box_call['strategy_options']['plan_' + plan_letter]
            self.assertEqual(box_plan.get('target_lap'), decision.get('target_lap'))
            self.assertEqual(box_plan.get('add_fuel_l'), decision.get('add_fuel_l'))
            self.assertEqual(box_plan.get('set_fuel_l'), decision.get('set_fuel_l'))
            self.assertEqual(box_call['strategy_options']['selected_plan'],
                              box_call['selected_plan'])
            self.assertEqual(box_call['decision_id'], decision['decision_id'])
            self.assertEqual(box_call['decision_plan']['decision_id'], decision['decision_id'])

    def test_telemetry_live_active_plan_decision_id_matches_the_committed_decision(self):
        telemetry_events = [b for b in self.result.broadcasts if b.get('type') == 'telemetry_live']
        decision_id = self.scenario['decision']['decision_id']
        after_decision = [t for t in telemetry_events if t.get('active_plan_decision_id')]
        self.assertTrue(after_decision, 'telemetry_live never carried active_plan_decision_id')
        for t in after_decision:
            self.assertIn(t['active_plan_decision_id'], {
                b['decision_id'] for b in self.result.by_trigger('strategy_plan_decision')})
            self.assertIsInstance(t['active_plan_revision'], int)

    def test_no_safety_override_fires_when_the_fixture_never_runs_short(self):
        # This fixture's fuel margin stays positive throughout (WO-001
        # e10 provenance) — the P1-11 safety override must not fabricate one.
        self.assertEqual(self.result.logs_containing('PLAN LIFECYCLE SAFETY OVERRIDE'), [])
        for b in self.result.by_trigger('fuel_strategy_warning'):
            self.assertIsNone(b.get('safety_override'))


# ══════════════════════════════════════════════════════════════════════
# PRODUCTION PURE-FUNCTION WIRING — B/C proposal -> accept -> atomic
# replace, using bridge.py's real functions directly (no full poll loop).
# Explicitly disclosed as NOT a full poll_iracing() replay for this slice.
# ══════════════════════════════════════════════════════════════════════

RACE = 'sub:road-atlanta-plan-bc'
SESSION = 0


def _plan_a_decision_plan(*, target_lap=21, add_fuel_l=30.0, set_fuel_l=None,
                           evidence_snapshot_id='snap:1', decision_id='%s:%s:decision-A' % (RACE, 0)):
    return {
        'decision_id': decision_id, 'selected_plan': 'A', 'reason': 'baseline',
        'decided_at_lap': 3, 'entry_class_position': 4, 'target_lap': target_lap,
        'add_fuel_l': add_fuel_l, 'set_fuel_l': set_fuel_l, 'session_num': SESSION,
        'conditions': None, 'evidence_snapshot_id': evidence_snapshot_id,
        'options_snapshot': {'selected_plan': 'A', 'plan_a': {'target_lap': target_lap}},
    }


def _plan_b_decision_plan(*, target_lap=8, add_fuel_l=20.0, set_fuel_l=None,
                           evidence_snapshot_id='snap:2', decision_id='%s:%s:decision-B' % (RACE, 0)):
    return {
        'decision_id': decision_id, 'selected_plan': 'B', 'reason': 'undercut',
        'decided_at_lap': 3, 'entry_class_position': 4, 'target_lap': target_lap,
        'add_fuel_l': add_fuel_l, 'set_fuel_l': set_fuel_l, 'session_num': SESSION,
        'conditions': {'fuel_window_open': True, 'relative_pace_advantage_s': 0.5,
                       'rejoin_not_worse': True},
        'evidence_snapshot_id': evidence_snapshot_id,
        'options_snapshot': {'selected_plan': 'B', 'plan_b': {'target_lap': target_lap}},
    }


def _register_active_from_decision_plan(state, decision_plan, *, source_frame=5,
                                          current_driver_pit_sequence=0):
    kwargs = dict(
        selected_plan=decision_plan['selected_plan'], target_lap=decision_plan.get('target_lap'),
        add_fuel_l=decision_plan.get('add_fuel_l'), set_fuel_l=decision_plan.get('set_fuel_l'),
        conditions=decision_plan.get('conditions'),
        evidence_snapshot_id=decision_plan.get('evidence_snapshot_id'),
        options_snapshot=decision_plan.get('options_snapshot'))
    plan_basis = adapter.plan_basis_from_decision(decision_plan)
    return pl.register_plan(
        state, decision_id=decision_plan['decision_id'], race_instance_id=RACE,
        session_num=SESSION, phase='active', current_driver_pit_sequence=current_driver_pit_sequence,
        created_source_frame_sequence=source_frame, activation_source_frame_sequence=source_frame,
        plan_basis=plan_basis, **kwargs)


def _register_awaiting_from_decision_plan(state, decision_plan, *, source_frame=5,
                                           current_driver_pit_sequence=0):
    kwargs = dict(
        selected_plan=decision_plan['selected_plan'], target_lap=decision_plan.get('target_lap'),
        add_fuel_l=decision_plan.get('add_fuel_l'), set_fuel_l=decision_plan.get('set_fuel_l'),
        conditions=decision_plan.get('conditions'),
        evidence_snapshot_id=decision_plan.get('evidence_snapshot_id'),
        options_snapshot=decision_plan.get('options_snapshot'))
    plan_basis = adapter.plan_basis_from_decision(decision_plan)
    return pl.register_plan(
        state, decision_id=decision_plan['decision_id'], race_instance_id=RACE,
        session_num=SESSION, phase='awaiting_driver',
        current_driver_pit_sequence=current_driver_pit_sequence,
        created_source_frame_sequence=source_frame, plan_basis=plan_basis, **kwargs)


class ProposalAcceptReplacesActiveTests(unittest.TestCase):
    """§7-4/6/11/23: B awaiting while A active, accepted via bridge.py's real
    `resolve_strategy_proposal()` output feeding `plan_lifecycle`'s real
    `activate_replacing_plan()` — the same two-function composition
    bridge.py's accepted-response block performs."""

    def test_bc_proposal_does_not_steal_the_active_pointer(self):
        state = pl.new_race_strategy_state(RACE, SESSION)
        state, reg_a = _register_active_from_decision_plan(state, _plan_a_decision_plan())
        decision_plan_b = _plan_b_decision_plan()
        state, reg_b = _register_awaiting_from_decision_plan(state, decision_plan_b)
        self.assertEqual(reg_b.status, 'registered')
        self.assertEqual(state.active_plan_id, reg_a.decision_id)
        self.assertIsNotNone(pl.active_plan_view(state))
        self.assertEqual(pl.active_plan_view(state).decision_id, reg_a.decision_id)
        self.assertEqual(state.plan_records[reg_b.decision_id].phase, 'awaiting_driver')

    def test_accepted_response_through_real_bridge_function_atomically_replaces_active_a(self):
        state = pl.new_race_strategy_state(RACE, SESSION)
        state, reg_a = _register_active_from_decision_plan(state, _plan_a_decision_plan())
        decision_plan_b = _plan_b_decision_plan()
        state, reg_b = _register_awaiting_from_decision_plan(state, decision_plan_b)
        # `pending_strategy_proposal` shaped exactly like
        # `bridge_plan_lifecycle_adapter.legacy_decision_projection()` builds
        # it in production, with a bridge-local dispatch_id merged in.
        pending_strategy_proposal = adapter.legacy_decision_projection(
            state.plan_records[reg_b.decision_id], dispatch_id='dispatch-1')
        response = {'decision_id': decision_plan_b['decision_id'], 'session_num': SESSION,
                    'dispatch_id': 'dispatch-1', 'accepted': True}
        # This is bridge.py's REAL production function.
        still_pending, promoted_plan, outcome, declined_sig = bridge.resolve_strategy_proposal(
            pending_strategy_proposal, response)
        self.assertEqual(outcome, 'accepted')
        self.assertIsNone(still_pending)
        self.assertIsNone(declined_sig)
        accept_decision_id = promoted_plan['decision_id']
        accept_record = state.plan_records[accept_decision_id]
        # bridge.py's accepted-response block: active predecessor exists ->
        # activate_replacing_plan(), the atomic §4.5 transaction.
        state, accept_outcome = pl.activate_replacing_plan(
            state, predecessor_decision_id=state.active_plan_id,
            expected_predecessor_revision=state.plan_records[state.active_plan_id].revision,
            successor_decision_id=accept_decision_id,
            expected_successor_revision=accept_record.revision,
            current_driver_pit_sequence=0, activation_source_frame_sequence=12)
        self.assertEqual(accept_outcome.status, 'activated')
        self.assertEqual(state.active_plan_id, reg_b.decision_id)
        self.assertEqual(state.plan_records[reg_a.decision_id].phase, 'cancelled')
        self.assertEqual(state.plan_records[reg_a.decision_id].invalidated_reason,
                          'superseded_by:%s' % reg_b.decision_id)
        active_count = sum(1 for r in state.plan_records.values() if r.phase == 'active')
        self.assertEqual(active_count, 1)
        # Legacy projection: what bridge.py would set active_decision_plan to.
        projection = adapter.legacy_decision_projection(pl.active_plan_view(state))
        self.assertEqual(projection['decision_id'], reg_b.decision_id)
        self.assertEqual(projection['selected_plan'], 'B')

    def test_declined_response_through_real_bridge_function_cancels_awaiting_leaves_active_a(self):
        state = pl.new_race_strategy_state(RACE, SESSION)
        state, reg_a = _register_active_from_decision_plan(state, _plan_a_decision_plan())
        decision_plan_b = _plan_b_decision_plan()
        state, reg_b = _register_awaiting_from_decision_plan(state, decision_plan_b)
        pending_strategy_proposal = adapter.legacy_decision_projection(
            state.plan_records[reg_b.decision_id], dispatch_id='dispatch-1')
        response = {'decision_id': decision_plan_b['decision_id'], 'session_num': SESSION,
                    'dispatch_id': 'dispatch-1', 'accepted': False}
        still_pending, promoted_plan, outcome, declined_sig = bridge.resolve_strategy_proposal(
            pending_strategy_proposal, response)
        self.assertEqual(outcome, 'declined')
        self.assertIsNone(promoted_plan)
        self.assertIsNotNone(declined_sig)
        # bridge.py's declined block: cancel_plan(reason='driver_declined').
        state, decline_outcome = pl.cancel_plan(
            state, decision_id=reg_b.decision_id, reason='driver_declined')
        self.assertEqual(decline_outcome.status, 'cancelled')
        self.assertEqual(state.plan_records[reg_b.decision_id].invalidated_reason, 'driver_declined')
        self.assertEqual(state.active_plan_id, reg_a.decision_id)
        self.assertEqual(state.plan_records[reg_a.decision_id].phase, 'active')

    def test_stale_dispatch_id_response_through_real_bridge_function_is_a_no_op(self):
        state = pl.new_race_strategy_state(RACE, SESSION)
        state, reg_a = _register_active_from_decision_plan(state, _plan_a_decision_plan())
        decision_plan_b = _plan_b_decision_plan()
        state, reg_b = _register_awaiting_from_decision_plan(state, decision_plan_b)
        pending_strategy_proposal = adapter.legacy_decision_projection(
            state.plan_records[reg_b.decision_id], dispatch_id='dispatch-current')
        stale_response = {'decision_id': decision_plan_b['decision_id'], 'session_num': SESSION,
                           'dispatch_id': 'dispatch-OLD', 'accepted': True}
        still_pending, promoted_plan, outcome, declined_sig = bridge.resolve_strategy_proposal(
            pending_strategy_proposal, stale_response)
        self.assertEqual(outcome, 'stale')
        self.assertIsNone(promoted_plan)
        self.assertEqual(still_pending, pending_strategy_proposal)
        # canonical Lifecycle state is untouched by a stale response — the
        # caller never even reaches a plan_lifecycle transition call.
        self.assertEqual(state.plan_records[reg_b.decision_id].phase, 'awaiting_driver')
        self.assertEqual(state.active_plan_id, reg_a.decision_id)


class MaterialUpdateSupersedeTests(unittest.TestCase):
    """§7-9/34: a pending B whose fuel/target actually changes (simulating
    the fixture-observed initial->decision-lock top-up delta) must be
    superseded, not silently kept stale, using bridge.py's real
    `plan_actionable_signature()`."""

    def test_changed_signature_supersedes_the_old_awaiting_record(self):
        state = pl.new_race_strategy_state(RACE, SESSION)
        state, reg_a = _register_active_from_decision_plan(state, _plan_a_decision_plan())
        old_b = _plan_b_decision_plan(target_lap=8, add_fuel_l=20.0)
        state, reg_b_old = _register_awaiting_from_decision_plan(state, old_b)
        new_b = _plan_b_decision_plan(
            target_lap=8, add_fuel_l=24.0, decision_id='%s:%s:decision-B2' % (RACE, 0))
        old_sig = bridge.plan_actionable_signature(old_b)
        new_sig = bridge.plan_actionable_signature(new_b)
        self.assertNotEqual(old_sig, new_sig, 'fixture must actually change the signature')
        state, supersede_outcome = pl.cancel_plan(
            state, decision_id=reg_b_old.decision_id, reason='proposal_superseded_by_material_update')
        self.assertEqual(supersede_outcome.status, 'cancelled')
        state, reg_b_new = _register_awaiting_from_decision_plan(state, new_b)
        self.assertEqual(reg_b_new.status, 'registered')
        self.assertEqual(state.plan_records[reg_b_old.decision_id].phase, 'cancelled')
        self.assertEqual(state.plan_records[reg_b_old.decision_id].invalidated_reason,
                          'proposal_superseded_by_material_update')
        self.assertEqual(adapter.current_awaiting_record(state).decision_id, reg_b_new.decision_id)
        self.assertEqual(state.active_plan_id, reg_a.decision_id)


class ReconnectPreservesLifecycleTests(unittest.TestCase):
    """§7-1/2/25/26: same-identity reconnect must preserve records/history;
    only a real race_instance_id/session_num change closes the scope.
    Exercised directly against `plan_lifecycle` (the same contract
    `bridge.py`'s scope-init block at the `_race_identity_changed_this_frame`
    site relies on) since `replay_harness` cannot fabricate a genuine
    SubSessionID-stable sustained-disconnect frame sequence without
    duplicating WO-002/003's own reconnect fixtures."""

    def test_same_identity_reconnect_keeps_the_active_record_and_history(self):
        state = pl.new_race_strategy_state(RACE, SESSION)
        state, reg_a = _register_active_from_decision_plan(state, _plan_a_decision_plan())
        history_before = state.history
        # Simulate the reconnect: identity/session_num are re-derived as the
        # SAME values (this is what `_race_identity_changed_this_frame`
        # evaluates to False for), so bridge.py's scope block takes neither
        # the `if _race_strategy_state is None` nor the `elif
        # _race_identity_changed_this_frame` branch — `state` is untouched.
        reconnected_state = state
        self.assertEqual(reconnected_state.active_plan_id, reg_a.decision_id)
        self.assertEqual(reconnected_state.history, history_before)
        self.assertEqual(pl.active_plan_view(reconnected_state).decision_id, reg_a.decision_id)

    def test_identity_change_closes_the_old_scope_and_starts_empty(self):
        state = pl.new_race_strategy_state(RACE, SESSION)
        state, reg_a = _register_active_from_decision_plan(state, _plan_a_decision_plan())
        closed_state, close_outcome = pl.close_scope(state, reason='race_identity_changed')
        self.assertEqual(close_outcome.status, 'closed')
        self.assertEqual(closed_state.plan_records[reg_a.decision_id].phase, 'cancelled')
        new_state = pl.new_race_strategy_state('sub:next-race', SESSION)
        self.assertEqual(new_state.plan_records, {})
        self.assertIsNone(new_state.active_plan_id)
        # The old scope's terminal record is preserved for audit but never
        # merged into the new scope.
        self.assertNotIn(reg_a.decision_id, new_state.plan_records)


# ══════════════════════════════════════════════════════════════════════
# REAL POLL LOOP REPLAY — Plan A initial-active, Plan B awaiting/proposal,
# Desktop audible delivery + accepted response injected via the SAME
# websocket-handler functions, atomic replace to Plan B active. Closes the
# gap `ProposalAcceptReplacesActiveTests` above discloses (WO-005 REVISE 1
# R2; HANDOFF.md 2026-09-27 disclosed unresolved item (2)).
# ══════════════════════════════════════════════════════════════════════

PLAN_BC_ACCEPT_LAPS_TOTAL = 45
PLAN_BC_ACCEPT_SESSION_NUM = 0
PLAN_BC_CALIBRATION_FIXTURE = os.path.join(
    HERE, '..', 'fixtures', 'wo005-plan-bc-accept', 'pit_loss_calibration_seed.json')

def _plan_bc_seed_replay(frames, **kwargs):
    """Isolate original timeless seed observations from historical replay writes.
    The checked-in working seed is retained; only the temp input removes dated
    replay outcomes and dated pit samples. This fixes repeat-order dependence.
    """
    import tempfile, hashlib
    from pathlib import Path
    path = Path(PLAN_BC_CALIBRATION_FIXTURE)
    before = path.read_bytes()
    payload = json.loads(before)
    for record in payload['conditions'].values():
        record['pit_samples'] = [x for x in record['pit_samples'] if 'timestamp' not in x]
        record['forecast_outcomes'] = []
    with tempfile.TemporaryDirectory(prefix='wo007-bc-seed-') as tmp:
        seed = Path(tmp) / 'seed.json'
        seed.write_text(json.dumps(payload))
        original = bridge.PIT_LOSS_PATH
        bridge.PIT_LOSS_PATH = str(seed)
        try:
            result = rh.replay(frames, **kwargs)
        finally:
            bridge.PIT_LOSS_PATH = original
    assert path.read_bytes() == before, 'replay changed repository seed'
    return result


PLAN_BC_ACCEPT_SESSION_INFO = """
WeekendInfo:
 TrackName: monza
 TrackDisplayName: Autodromo Nazionale Monza
 TrackLength: 5.793 km
 EventType: Race
 SeriesID: 0
 SubSessionID: 992010001
 WeekendOptions:
  NumStarters: 3
SessionInfo:
 Sessions:
 - SessionNum: 0
   SessionType: Race
   SessionLaps: %d
   SessionTime: unlimited
DriverInfo:
 DriverCarIdx: 0
 DriverCarFuelMaxLtr: 60.000
 DriverCarMaxFuelPct: 1.000
 Drivers:
 - CarIdx: 0
   UserID: 10101
   UserName: Test Driver
   CarNumber: "1"
   CarScreenName: Mercedes-AMG GT3 2020
   CarClassID: 100
   CarClassShortName: GT3
   IRating: 2000
   LicSubLevel: 300
 - CarIdx: 1
   UserName: Rival Ahead
   CarNumber: "2"
   CarScreenName: Mercedes-AMG GT3 2020
   CarClassID: 100
   CarClassShortName: GT3
   IRating: 2100
   LicSubLevel: 320
 - CarIdx: 2
   UserName: Rival Behind
   CarNumber: "3"
   CarScreenName: Mercedes-AMG GT3 2020
   CarClassID: 100
   CarClassShortName: GT3
   IRating: 1900
   LicSubLevel: 280
""" % PLAN_BC_ACCEPT_LAPS_TOTAL


def _plan_bc_accept_clean_laps(count, *, start_lap=1, start_fuel=58.0, start_time=100.0,
                                lap_time=100.0, burn=2.0, frames_per_lap=3):
    """Steady-state laps for one car (idx 0) with two same-class rivals
    (idx 1 ahead at a slower measured pace, idx 2 behind) present every
    frame — the real `_battle_context`/pit-forecast wiring in `bridge.py`
    needs both a rival to compare pace against and a full same-class
    standings array, not just the player's own fuel/lap fields (same frame
    shape as every other WO replay fixture's `clean_laps()` helper, extended
    with the `CarIdx*` fields this scenario additionally depends on).
    """
    frames = []
    fuel = start_fuel
    t = start_time
    for i in range(count):
        lap = start_lap + i
        for f in range(frames_per_lap):
            frames.append(rh.make_frame(
                SessionTime=t, Lap=lap, FuelLevel=fuel,
                LapDistPct=0.2 + 0.2 * f,
                PlayerCarClassPosition=2,
                CarIdxClassPosition=[2, 1, 3],
                CarIdxLastLapTime=[lap_time, lap_time + 1.0, lap_time + 2.0],
                CarIdxLapDistPct=[0.2 + 0.2 * f, 0.25 + 0.2 * f, 0.15 + 0.2 * f],
                CarIdxLap=[lap, lap, lap],
                SessionLapsRemain=PLAN_BC_ACCEPT_LAPS_TOTAL - lap,
                SessionLapsTotal=PLAN_BC_ACCEPT_LAPS_TOTAL,
                LapLastLapTime=lap_time + i * 0.01 - 0.01 if i else 0.0))
            t += 1.0
        fuel -= burn
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap + 1, FuelLevel=fuel, LapDistPct=0.01,
            PlayerCarClassPosition=2,
            CarIdxClassPosition=[2, 1, 3],
            CarIdxLastLapTime=[lap_time, lap_time + 1.0, lap_time + 2.0],
            CarIdxLapDistPct=[0.01, 0.05, 0.95],
            CarIdxLap=[lap + 1, lap + 1, lap],
            SessionLapsRemain=PLAN_BC_ACCEPT_LAPS_TOTAL - (lap + 1),
            SessionLapsTotal=PLAN_BC_ACCEPT_LAPS_TOTAL,
            LapLastLapTime=lap_time + i * 0.01))
        t += 1.0
    return frames


def _plan_bc_accept_build_frames():
    # 20 clean laps: the first 3 establish the clean-fuel baseline that lets
    # the initial playbook register Plan A (~lap 5); by lap 15 the fuel
    # window for an undercut has long been open (target_lap=16, opened at
    # lap 5+11) and the rival-ahead pace deficit (+1.0s/lap, comfortably
    # over the 0.3s Plan B threshold) plus the seeded pit-loss calibration
    # (below) make the real `decide_at_plan_a()` select Plan B on its own —
    # nothing here calls `strategy_options`/`plan_lifecycle` directly.
    return _plan_bc_accept_clean_laps(20)


class ProposalAcceptedFullPollReplayTests(unittest.TestCase):
    """WO-005 REVISE 1 R2 — real `poll_iracing()` replay: initial Plan A
    active -> Plan B awaiting/`strategy_plan_proposal` -> Desktop audible
    delivery + accepted response (injected via the real
    `bridge._queue_strategy_delivery_report()` / `bridge.
    _queue_strategy_decision_response()`, the same functions the production
    websocket handler calls for the `strategy_decision_delivery` /
    `strategy_decision_response` commands) -> atomic replace to Plan B
    active. Every assertion below reads only `result.broadcasts`/`result.
    logs` (the real `broadcast()`/`log()` stream) — `plan_lifecycle` /
    `bridge_plan_lifecycle_adapter` are never imported by this class.
    """

    @classmethod
    def setUpClass(cls):
        frames = _plan_bc_accept_build_frames()
        cls._injected = {'audible_sent': False, 'accept_sent': False,
                          'decision_id': None, 'dispatch_id': None}

        def on_frame_ready(cursor, frame, result):
            state = cls._injected
            if not state['audible_sent']:
                proposals = result.by_trigger('strategy_plan_proposal')
                if not proposals:
                    return
                latest = proposals[-1]
                state['decision_id'] = latest['decision_id']
                state['dispatch_id'] = latest['dispatch_id']
                # Same function the real websocket handler calls for cmd
                # 'strategy_decision_delivery'.
                bridge._queue_strategy_delivery_report(
                    latest['decision_id'], 'audible',
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=latest['dispatch_id'])
                state['audible_sent'] = True
                return
            if not state['accept_sent']:
                audible_acked = any(
                    b.get('type') == 'strategy_delivery_ack'
                    and b.get('decision_id') == state['decision_id']
                    and b.get('outcome') == 'audible'
                    for b in result.broadcasts)
                if not audible_acked:
                    return
                # Same function the real websocket handler calls for cmd
                # 'strategy_decision_response'.
                bridge._queue_strategy_decision_response(
                    state['decision_id'], True,
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_id'])
                state['accept_sent'] = True

        # The ONLY swapped external boundary beyond replay_harness's own
        # reader/broadcast/log/time: the on-disk pit-loss calibration file
        # `poll_iracing()` reads via the module-level `PIT_LOSS_PATH`
        # constant (`pit_loss_calibrator = pit_loss_calibrator_mod.
        # PitLossCalibrator(PIT_LOSS_PATH)`, bridge.py:3269). Pointing it at
        # a checked-in fixture with >=3 real pit/normal samples is what lets
        # the real `pit_exit_forecaster` produce an `available` rejoin
        # forecast — nothing about the Plan B decision path itself is
        # replaced or hand-computed.
        original_pit_loss_path = bridge.PIT_LOSS_PATH
        bridge.PIT_LOSS_PATH = PLAN_BC_CALIBRATION_FIXTURE
        try:
            cls.result = _plan_bc_seed_replay(
                frames, session_info=PLAN_BC_ACCEPT_SESSION_INFO,
                on_frame_ready=on_frame_ready)
        finally:
            bridge.PIT_LOSS_PATH = original_pit_loss_path

    def test_calibration_fixture_is_actually_seeded(self):
        # Sanity check on the fixture file itself, independent of bridge.py:
        # if this ever drifted empty, every assertion below would fail for
        # the wrong reason (calibration_not_ready) instead of a real defect.
        with open(PLAN_BC_CALIBRATION_FIXTURE, encoding='utf-8') as fh:
            payload = json.load(fh)
        record = payload['conditions']['monza|mercedes-amg gt3 2020|green']
        self.assertGreaterEqual(len(record['pit_samples']), 3)
        self.assertGreaterEqual(len(record['normal_samples']), 3)

    def test_initial_plan_a_registers_active_exactly_once(self):
        lines = self.result.logs_containing('PLAN LIFECYCLE INITIAL REGISTRATION:')
        self.assertEqual(len(lines), 1, lines)
        self.assertIn('action=register_new', lines[0])
        self.assertIn('status=registered', lines[0])

    def test_plan_b_registers_awaiting_and_broadcasts_a_proposal_not_active(self):
        proposals = self.result.by_trigger('strategy_plan_proposal')
        self.assertEqual(len(proposals), 1, proposals)
        self.assertEqual(proposals[0]['selected_plan'], 'B')
        reg_lines = self.result.logs_containing('PLAN LIFECYCLE PROPOSAL REGISTERED:')
        self.assertEqual(len(reg_lines), 1, reg_lines)
        self.assertEqual(self.result.logs_containing('PLAN LIFECYCLE PROPOSAL FAILED'), [])

    def test_no_lifecycle_registration_or_accept_failures(self):
        for needle in ('PLAN LIFECYCLE INITIAL REGISTRATION FAILED',
                       'PLAN LIFECYCLE COMMIT FAILED', 'PLAN LIFECYCLE COMMIT SKIPPED',
                       'PLAN LIFECYCLE PROPOSAL SKIPPED', 'PLAN LIFECYCLE PROPOSAL FAILED',
                       'PLAN LIFECYCLE ACCEPT SKIPPED', 'PLAN LIFECYCLE ACCEPT FAILED',
                       'PLAN LIFECYCLE SCOPE INIT ERROR'):
            self.assertEqual(self.result.logs_containing(needle), [],
                              '%s must not occur in this fixture' % needle)
        # Plan A is never proposed/committed via the decision-lock 'commit'
        # branch in this scenario — it only ever becomes active through the
        # initial-playbook registration site. Confirms the fixture reaches
        # the decision-lock window with mode='propose' on its very first
        # pass (selecting B directly), not an intervening commit(A).
        self.assertEqual(self.result.by_trigger('strategy_plan_decision'), [])

    def test_audible_delivery_and_accepted_response_are_acked_for_the_same_dispatch(self):
        proposal = self.result.by_trigger('strategy_plan_proposal')[0]
        delivery_acks = [b for b in self.result.broadcasts
                          if b.get('type') == 'strategy_delivery_ack']
        decision_acks = [b for b in self.result.broadcasts
                          if b.get('type') == 'strategy_decision_ack']
        self.assertEqual(len(delivery_acks), 1, delivery_acks)
        self.assertEqual(len(decision_acks), 1, decision_acks)
        self.assertEqual(delivery_acks[0]['decision_id'], proposal['decision_id'])
        self.assertEqual(delivery_acks[0]['dispatch_id'], proposal['dispatch_id'])
        self.assertEqual(delivery_acks[0]['outcome'], 'audible')
        self.assertEqual(delivery_acks[0]['applied'], 'audible')
        self.assertEqual(decision_acks[0]['decision_id'], proposal['decision_id'])
        self.assertEqual(decision_acks[0]['dispatch_id'], proposal['dispatch_id'])
        self.assertEqual(decision_acks[0]['outcome'], 'accepted')

    def test_accept_atomically_replaces_active_a_with_active_b(self):
        init_line = self.result.logs_containing('PLAN LIFECYCLE INITIAL REGISTRATION:')[0]
        proposal_decision_id = self.result.by_trigger('strategy_plan_proposal')[0]['decision_id']
        a_decision_id = init_line.split('decision_id=')[1].strip()
        self.assertNotEqual(a_decision_id, proposal_decision_id)
        replaced_lines = self.result.logs_containing('PLAN LIFECYCLE ACCEPT REPLACED:')
        self.assertEqual(len(replaced_lines), 1, replaced_lines)
        self.assertIn('status=activated', replaced_lines[0])
        self.assertIn('decision_id=%s' % proposal_decision_id, replaced_lines[0])
        self.assertIn('predecessor=%s' % a_decision_id, replaced_lines[0])
        # `activate_replacing_plan()` (plan_lifecycle.py) is the ONLY pure
        # API this log line can come from, and its own contract (§4.5) is an
        # atomic single-transaction replace: predecessor -> cancelled
        # (`superseded_by:<successor>`), successor -> active, pointer moved,
        # no intermediate state with zero or two active records observable
        # by any caller. This test does not re-inspect `plan_lifecycle`
        # internals to confirm that (forbidden here) — it relies on that
        # module's own atomicity guarantee plus the black-box evidence
        # below: telemetry_live's active identity flips exactly once, and
        # only in the direction A -> B, never back, never both.
        self.assertEqual(self.result.logs_containing('PLAN LIFECYCLE ACCEPT ACTIVATED:'), [],
                          'this scenario must use the replace transaction, '
                          'not the no-predecessor activate_plan() entry')

    def test_telemetry_live_active_identity_flips_from_a_to_b_exactly_once(self):
        a_decision_id = self.result.logs_containing(
            'PLAN LIFECYCLE INITIAL REGISTRATION:')[0].split('decision_id=')[1].strip()
        b_decision_id = self.result.by_trigger('strategy_plan_proposal')[0]['decision_id']
        samples = [b for b in self.result.broadcasts
                   if b.get('type') == 'telemetry_live' and b.get('active_plan_decision_id')]
        self.assertTrue(samples)
        seen_ids = [s['active_plan_decision_id'] for s in samples]
        self.assertIn(a_decision_id, seen_ids)
        self.assertIn(b_decision_id, seen_ids)
        # Every sample belongs to one of exactly two known identities.
        self.assertEqual(set(seen_ids), {a_decision_id, b_decision_id})
        # Once B is first observed, A never reappears (a single, one-way
        # flip — not oscillation between two "active" records).
        first_b_index = seen_ids.index(b_decision_id)
        self.assertTrue(all(sample_id == b_decision_id
                             for sample_id in seen_ids[first_b_index:]))
        # A's samples strictly precede B's — the flip happens once, in order.
        last_a_index = max(i for i, sample_id in enumerate(seen_ids) if sample_id == a_decision_id)
        self.assertLess(last_a_index, first_b_index)
        # B's revision after activation is the successor's post-replace
        # revision (bumped once by `activate_replacing_plan()`), stable for
        # every sample after the flip.
        b_revisions = {s['active_plan_revision'] for s in samples
                       if s['active_plan_decision_id'] == b_decision_id}
        self.assertEqual(len(b_revisions), 1, b_revisions)


# Inactive frames spliced in right after the Plan B proposal broadcast. The
# first 12 (x ~1.3s virtual wall clock each: 1s/frame + the loop's 0.3s
# sleep) cross bridge.py's 15s sustained-disconnect threshold; the rest are
# served while the reader is re-opened but still Active=False. The next real
# frame is then the reconnect frame (same SubSessionID/SessionNum, unchanged
# session_info).
PLAN_BC_RECONNECT_GAP_FRAMES = 16


class ProposalAcceptedAcrossSameIdentityReconnectReplayTests(unittest.TestCase):
    """WO-005 R2B — real `poll_iracing()` replay over the SAME deterministic
    frames as `ProposalAcceptedFullPollReplayTests`, but after the Plan B
    `strategy_plan_proposal` broadcast and BEFORE any audible/accept is sent,
    a same-identity temporary-inactive -> sustained-disconnect -> reconnect
    gap is served through the reader boundary. Only after the real reconnect
    frame has been processed does the Desktop audible delivery and accepted
    response arrive (via the real `bridge._queue_strategy_delivery_report()`
    / `bridge._queue_strategy_decision_response()`), carrying the
    decision_id/dispatch_id captured BEFORE the reconnect. Every assertion
    reads only the real `broadcast()`/`log()` stream; `plan_lifecycle` /
    `bridge_plan_lifecycle_adapter` are never called by this class.
    """

    @classmethod
    def setUpClass(cls):
        frames = _plan_bc_accept_build_frames()
        cls._injected = {'gap_inserted': False, 'audible_sent': False, 'accept_sent': False,
                          'decision_id': None, 'dispatch_id': None,
                          'broadcast_index_at_gap': None,
                          'broadcast_index_at_reconnect': None,
                          'violations': []}

        def on_frame_ready(cursor, frame, result):
            state = cls._injected
            proposals = result.by_trigger('strategy_plan_proposal')
            if state['gap_inserted']:
                # Runtime check on every frame boundary after the gap starts:
                # the same-identity reconnect must never re-broadcast (or
                # re-dispatch) the proposal.
                if len(proposals) != 1:
                    state['violations'].append(
                        'cursor=%d proposal_count=%d' % (cursor, len(proposals)))
                elif proposals[0]['dispatch_id'] != state['dispatch_id']:
                    state['violations'].append(
                        'cursor=%d dispatch_id changed %r -> %r'
                        % (cursor, state['dispatch_id'], proposals[0]['dispatch_id']))
            if not state['gap_inserted']:
                if not proposals:
                    return
                latest = proposals[-1]
                state['decision_id'] = latest['decision_id']
                state['dispatch_id'] = latest['dispatch_id']
                state['broadcast_index_at_gap'] = len(result.broadcasts)
                # Served next (this very cursor) by the reader boundary, so no
                # audible/accept has been sent for the proposal yet.
                result.live_frames[cursor:cursor] = [
                    rh.make_frame(_inactive=True)
                    for _ in range(PLAN_BC_RECONNECT_GAP_FRAMES)]
                state['gap_inserted'] = True
                return
            if not state['audible_sent']:
                # Wait until the real reconnect frame (2nd CONNECTED) has been
                # fully processed by poll_iracing().
                if len(result.logs_containing('>>> iRacing CONNECTED')) < 2:
                    return
                state['broadcast_index_at_reconnect'] = len(result.broadcasts)
                # Same function the real websocket handler calls for cmd
                # 'strategy_decision_delivery', with the PRE-reconnect ids.
                bridge._queue_strategy_delivery_report(
                    state['decision_id'], 'audible',
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_id'])
                state['audible_sent'] = True
                return
            if not state['accept_sent']:
                audible_acked = any(
                    b.get('type') == 'strategy_delivery_ack'
                    and b.get('decision_id') == state['decision_id']
                    and b.get('outcome') == 'audible'
                    for b in result.broadcasts)
                if not audible_acked:
                    return
                # Same function the real websocket handler calls for cmd
                # 'strategy_decision_response', with the PRE-reconnect ids.
                bridge._queue_strategy_decision_response(
                    state['decision_id'], True,
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_id'])
                state['accept_sent'] = True

        original_pit_loss_path = bridge.PIT_LOSS_PATH
        bridge.PIT_LOSS_PATH = PLAN_BC_CALIBRATION_FIXTURE
        try:
            cls.result = _plan_bc_seed_replay(
                frames, session_info=PLAN_BC_ACCEPT_SESSION_INFO,
                on_frame_ready=on_frame_ready)
        finally:
            bridge.PIT_LOSS_PATH = original_pit_loss_path

    def test_injection_sequence_completed(self):
        state = self._injected
        self.assertTrue(state['gap_inserted'])
        self.assertTrue(state['audible_sent'])
        self.assertTrue(state['accept_sent'])

    def test_same_identity_sustained_disconnect_and_reconnect_really_happened(self):
        self.assertEqual(len(self.result.logs_containing(
            '<<< iRacing DISCONNECTED (sustained 15s)')), 1)
        self.assertEqual(len(self.result.logs_containing('>>> iRacing CONNECTED')), 2)
        types = [b.get('type') for b in self.result.broadcasts]
        gap_index = self._injected['broadcast_index_at_gap']
        reconnect_index = self._injected['broadcast_index_at_reconnect']
        self.assertIsNotNone(gap_index)
        self.assertIsNotNone(reconnect_index)
        self.assertIn('iracing_disconnected', types[gap_index:reconnect_index])
        self.assertIn('iracing_connected', types[gap_index:reconnect_index])
        # Same SubSessionID/SessionNum: the Lifecycle scope must survive.
        self.assertEqual(self.result.logs_containing('PLAN LIFECYCLE SCOPE CLOSED'), [])
        self.assertEqual(self.result.logs_containing('PLAN LIFECYCLE SCOPE INIT ERROR'), [])

    def test_proposal_is_not_rebroadcast_during_or_after_reconnect(self):
        self.assertEqual(self._injected['violations'], [])
        proposals = self.result.by_trigger('strategy_plan_proposal')
        self.assertEqual(len(proposals), 1, proposals)
        self.assertEqual(proposals[0]['selected_plan'], 'B')
        # Broadcast strictly before the gap was spliced in.
        proposal_index = next(i for i, b in enumerate(self.result.broadcasts)
                              if b.get('trigger') == 'strategy_plan_proposal')
        self.assertLess(proposal_index, self._injected['broadcast_index_at_gap'])
        self.assertEqual(len(self.result.logs_containing('PROPOSAL opened')), 1)
        self.assertEqual(len(self.result.logs_containing(
            'PLAN LIFECYCLE PROPOSAL REGISTERED:')), 1)
        self.assertEqual(self.result.logs_containing('PLAN LIFECYCLE PROPOSAL REUSED'), [])

    def test_dispatch_id_is_unchanged_across_reconnect(self):
        proposal = self.result.by_trigger('strategy_plan_proposal')[0]
        self.assertEqual(proposal['decision_id'], self._injected['decision_id'])
        self.assertEqual(proposal['dispatch_id'], self._injected['dispatch_id'])
        # Every post-reconnect broadcast that names this decision carries the
        # pre-reconnect dispatch_id.
        after = self.result.broadcasts[self._injected['broadcast_index_at_gap']:]
        for b in after:
            if b.get('decision_id') == proposal['decision_id'] and 'dispatch_id' in b:
                self.assertEqual(b['dispatch_id'], proposal['dispatch_id'], b)

    def test_post_reconnect_audible_and_accept_ack_apply_to_the_same_dispatch(self):
        proposal = self.result.by_trigger('strategy_plan_proposal')[0]
        reconnect_index = self._injected['broadcast_index_at_reconnect']
        delivery_acks = [b for b in self.result.broadcasts
                          if b.get('type') == 'strategy_delivery_ack']
        decision_acks = [b for b in self.result.broadcasts
                          if b.get('type') == 'strategy_decision_ack']
        self.assertEqual(len(delivery_acks), 1, delivery_acks)
        self.assertEqual(len(decision_acks), 1, decision_acks)
        self.assertGreaterEqual(self.result.broadcasts.index(delivery_acks[0]), reconnect_index)
        self.assertEqual(delivery_acks[0]['decision_id'], proposal['decision_id'])
        self.assertEqual(delivery_acks[0]['dispatch_id'], proposal['dispatch_id'])
        self.assertEqual(delivery_acks[0]['outcome'], 'audible')
        self.assertEqual(delivery_acks[0]['applied'], 'audible')
        self.assertEqual(decision_acks[0]['decision_id'], proposal['decision_id'])
        self.assertEqual(decision_acks[0]['dispatch_id'], proposal['dispatch_id'])
        self.assertEqual(decision_acks[0]['outcome'], 'accepted')

    def test_accept_after_reconnect_atomically_replaces_active_a_with_active_b(self):
        for needle in ('PLAN LIFECYCLE INITIAL REGISTRATION FAILED',
                       'PLAN LIFECYCLE COMMIT FAILED', 'PLAN LIFECYCLE COMMIT SKIPPED',
                       'PLAN LIFECYCLE PROPOSAL SKIPPED', 'PLAN LIFECYCLE PROPOSAL FAILED',
                       'PLAN LIFECYCLE ACCEPT SKIPPED', 'PLAN LIFECYCLE ACCEPT FAILED',
                       'PLAN LIFECYCLE PROPOSAL DECLINED'):
            self.assertEqual(self.result.logs_containing(needle), [],
                              '%s must not occur in this fixture' % needle)
        init_lines = self.result.logs_containing('PLAN LIFECYCLE INITIAL REGISTRATION:')
        self.assertEqual(len(init_lines), 1, init_lines)
        a_decision_id = init_lines[0].split('decision_id=')[1].strip()
        b_decision_id = self.result.by_trigger('strategy_plan_proposal')[0]['decision_id']
        self.assertNotEqual(a_decision_id, b_decision_id)
        replaced_lines = self.result.logs_containing('PLAN LIFECYCLE ACCEPT REPLACED:')
        self.assertEqual(len(replaced_lines), 1, replaced_lines)
        self.assertIn('status=activated', replaced_lines[0])
        self.assertIn('decision_id=%s' % b_decision_id, replaced_lines[0])
        self.assertIn('predecessor=%s' % a_decision_id, replaced_lines[0])
        self.assertEqual(self.result.logs_containing('PLAN LIFECYCLE ACCEPT ACTIVATED:'), [])

        samples = [b for b in self.result.broadcasts
                   if b.get('type') == 'telemetry_live' and b.get('active_plan_decision_id')]
        seen_ids = [s['active_plan_decision_id'] for s in samples]
        self.assertEqual(set(seen_ids), {a_decision_id, b_decision_id})
        first_b_index = seen_ids.index(b_decision_id)
        self.assertTrue(all(sample_id == b_decision_id
                             for sample_id in seen_ids[first_b_index:]))
        # A stays active across the reconnect (proposal still awaiting); B is
        # first observed only after the post-reconnect accept.
        reconnect_index = self._injected['broadcast_index_at_reconnect']
        first_b_broadcast_index = self.result.broadcasts.index(samples[first_b_index])
        self.assertGreater(first_b_broadcast_index, reconnect_index)
        b_revisions = {s['active_plan_revision'] for s in samples
                       if s['active_plan_decision_id'] == b_decision_id}
        self.assertEqual(len(b_revisions), 1, b_revisions)


# ══════════════════════════════════════════════════════════════════════
# REAL POLL LOOP REPLAY — stale acceptance after a REAL raw-telemetry pit
# advances driver_pit_sequence while Plan B is still awaiting_driver, plus
# wrong-dispatch_id and duplicate inbound queue injection. Closes WO-005
# Revision 7 R2C (review/PITWALL_SHARED_WORKING_LOG.md 2026-09-29 "R2 B/C
# production poll replay" item, requirements #2/#3/#4/#5/#6/#7 specifically).
# ══════════════════════════════════════════════════════════════════════

def _plan_bc_accept_pit_visit(*, lap, fuel_before, fuel_added, start_time, dwell=5):
    """Same OnPitRoad True->False raw-frame shape as
    `tests_wo001_road_atlanta_fixture.pit_visit()` — NOT imported directly
    since that helper hardcodes WO-001's own `SessionLapsTotal=25`; this is
    the same shape re-parameterized with THIS scenario's
    `PLAN_BC_ACCEPT_LAPS_TOTAL` so `SessionLapsRemain` stays internally
    consistent with `_plan_bc_accept_clean_laps()`. bridge.py reads
    SessionFlags/OnPitRoad exactly at the True->False transition frame and
    that is the ONLY place `driver_pit_sequence` is incremented
    (`race_facts_mod.with_incremented_pit_sequence()`, bridge.py:6258) — the
    same real code path `tests_wo001_road_atlanta_fixture.py`'s F01/F03/
    `test_pit_events_now_carry_race_identity_and_penalty_evidence` already
    prove produces a real `DriverPitEvent`/pit-sequence advance through
    `poll_iracing()`, not a hand-simulated one.

    A plain fuel-only stop (no damage/repair, no black flag, no
    `PlayerCarPitSvStatus` service-start signal — same omissions
    `pit_visit()` makes) so it does not, by itself, trigger a
    `repair_detected_or_opt_not_taken` recalculation that would confound
    this test's isolation of "only the pit-sequence advance moved" (WO-005
    Revision 7 R2C requirement #2's premise: nothing else about Plan A/B's
    content changes because of this pit).
    """
    frames = []
    t = start_time
    for _ in range(2):
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap, FuelLevel=fuel_before,
            OnPitRoad=True, Speed=18.0, LapDistPct=0.95,
            SessionLapsRemain=PLAN_BC_ACCEPT_LAPS_TOTAL - lap,
            SessionLapsTotal=PLAN_BC_ACCEPT_LAPS_TOTAL))
        t += 1.0
    for _ in range(dwell):
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap, FuelLevel=fuel_before,
            OnPitRoad=True, Speed=0.0, LapDistPct=0.96,
            SessionLapsRemain=PLAN_BC_ACCEPT_LAPS_TOTAL - lap,
            SessionLapsTotal=PLAN_BC_ACCEPT_LAPS_TOTAL))
        t += 1.0
    fuel_after = fuel_before + fuel_added
    exit_session_time = t
    frames.append(rh.make_frame(
        SessionTime=exit_session_time, Lap=lap, FuelLevel=fuel_after,
        OnPitRoad=False, Speed=22.0, LapDistPct=0.99,
        SessionLapsRemain=PLAN_BC_ACCEPT_LAPS_TOTAL - lap,
        SessionLapsTotal=PLAN_BC_ACCEPT_LAPS_TOTAL))
    t += 1.0
    return frames, fuel_after, t


def _plan_bc_accept_hold_frames(count, *, lap, fuel, start_time):
    """Steady, no-lap-crossing filler frames (same rival-car shape
    `_plan_bc_accept_clean_laps()` needs so the real `_battle_context`/
    pit-forecast wiring keeps working) used only as a quiet tail AFTER the
    captured dispatch is already terminal, so WO-005 Revision 7 R2C
    requirement #6 (continue enough raw frames to prove the terminal
    successor is never rebroadcast) has real frames to run `poll_iracing()`
    through without advancing the race clock into unrelated new
    decision-lock territory (holding `Lap` constant means no new lap
    crossing, so no new clean-lap/recalculation trigger fires on its own).
    """
    frames = []
    t = start_time
    for _ in range(count):
        t += 1.0
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap, FuelLevel=fuel, LapDistPct=0.5,
            PlayerCarClassPosition=2,
            CarIdxClassPosition=[2, 1, 3],
            CarIdxLastLapTime=[100.0, 101.0, 102.0],
            CarIdxLapDistPct=[0.5, 0.55, 0.45],
            CarIdxLap=[lap, lap, lap],
            SessionLapsRemain=PLAN_BC_ACCEPT_LAPS_TOTAL - lap,
            SessionLapsTotal=PLAN_BC_ACCEPT_LAPS_TOTAL,
            LapLastLapTime=0.0))
    return frames, t


class StaleAcceptanceAfterPitInvalidatesSuccessorReplayTests(unittest.TestCase):
    """WO-007 regression: real pit invalidates active A and awaiting B before
    delayed delivery/accept. Former WO-005 transport-only expectation kept A
    alive; canonical actual-pit wiring now retires both, and ACK is no_match.
    All inbound stages still run through the real queues and real poll loop.
    """

    @classmethod
    def setUpClass(cls):
        base_frames = _plan_bc_accept_build_frames()
        hold_frames, _ = _plan_bc_accept_hold_frames(
            24, lap=21, fuel=40.0, start_time=500.0)
        frames = base_frames + hold_frames
        cls._injected = {
            'pit_spliced': False, 'audible_sent': False,
            'wrong_delivery_sent': False, 'wrong_decision_sent': False,
            'accept_sent': False, 'duplicate_delivery_sent': False,
            'duplicate_decision_sent': False,
            'decision_id': None, 'dispatch_id': None,
        }
        WRONG_SUFFIX = '-WRONG-DISPATCH'

        def on_frame_ready(cursor, frame, result):
            state = cls._injected
            if not state['pit_spliced']:
                proposals = result.by_trigger('strategy_plan_proposal')
                if not proposals:
                    return
                latest = proposals[-1]
                state['decision_id'] = latest['decision_id']
                state['dispatch_id'] = latest['dispatch_id']
                # WO-005 Revision 7 R2C requirement #2: advance the REAL
                # driver pit sequence now, BEFORE any delivery/accept is
                # sent for this captured dispatch.
                pit_frames, _fuel_after, _t_after = _plan_bc_accept_pit_visit(
                    lap=frame.get('Lap', 21),
                    fuel_before=frame.get('FuelLevel', 40.0),
                    fuel_added=20.0,
                    start_time=frame.get('SessionTime', 900.0))
                result.live_frames[cursor:cursor] = pit_frames
                state['pit_spliced'] = True
                return
            if not state['audible_sent']:
                if not result.logs_containing('DRIVER PIT EVENT:'):
                    return
                # Same function the real websocket handler calls for cmd
                # 'strategy_decision_delivery'.
                bridge._queue_strategy_delivery_report(
                    state['decision_id'], 'audible',
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_id'])
                state['audible_sent'] = True
                return
            if not state['wrong_delivery_sent']:
                audible_acked = any(
                    b.get('type') == 'strategy_delivery_ack'
                    and b.get('decision_id') == state['decision_id']
                    and b.get('dispatch_id') == state['dispatch_id']
                    and b.get('applied') in ('no_match', 'stale')
                    for b in result.broadcasts)
                if not audible_acked:
                    return
                # WO-005 Revision 7 R2C requirement #4: a wrong dispatch_id
                # delivery report for the SAME decision_id.
                bridge._queue_strategy_delivery_report(
                    state['decision_id'], 'audible',
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_id'] + WRONG_SUFFIX)
                state['wrong_delivery_sent'] = True
                return
            if not state['wrong_decision_sent']:
                wrong_delivery_acked = any(
                    b.get('type') == 'strategy_delivery_ack'
                    and b.get('decision_id') == state['decision_id']
                    and b.get('dispatch_id') == state['dispatch_id'] + WRONG_SUFFIX
                    for b in result.broadcasts)
                if not wrong_delivery_acked:
                    return
                # WO-005 Revision 7 R2C requirement #4: a wrong dispatch_id
                # decision response for the SAME decision_id.
                bridge._queue_strategy_decision_response(
                    state['decision_id'], True,
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_id'] + WRONG_SUFFIX)
                state['wrong_decision_sent'] = True
                return
            if not state['accept_sent']:
                wrong_decision_acked = any(
                    b.get('type') == 'strategy_decision_ack'
                    and b.get('decision_id') == state['decision_id']
                    and b.get('dispatch_id') == state['dispatch_id'] + WRONG_SUFFIX
                    for b in result.broadcasts)
                if not wrong_decision_acked:
                    return
                # WO-005 Revision 7 R2C requirement #3: the CORRECT dispatch,
                # sent only AFTER the real pit-sequence advance above — this
                # is the "stale" acceptance under test.
                bridge._queue_strategy_decision_response(
                    state['decision_id'], True,
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_id'])
                state['accept_sent'] = True
                return
            if not state['duplicate_delivery_sent']:
                if not any(b.get('type') == 'strategy_decision_ack'
                           and b.get('dispatch_id') == state['dispatch_id']
                           for b in result.broadcasts):
                    return
                # WO-005 Revision 7 R2C requirements #5/#6: resend the SAME
                # (now-terminal) dispatch's delivery report.
                bridge._queue_strategy_delivery_report(
                    state['decision_id'], 'audible',
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_id'])
                state['duplicate_delivery_sent'] = True
                return
            if not state['duplicate_decision_sent']:
                duplicate_delivery_acked = len([
                    b for b in result.broadcasts
                    if b.get('type') == 'strategy_delivery_ack'
                    and b.get('decision_id') == state['decision_id']
                    and b.get('dispatch_id') == state['dispatch_id']]) >= 2
                if not duplicate_delivery_acked:
                    return
                # WO-005 Revision 7 R2C requirements #5/#6: resend the SAME
                # (now-terminal) dispatch's decision response.
                bridge._queue_strategy_decision_response(
                    state['decision_id'], True,
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_id'])
                state['duplicate_decision_sent'] = True
                return
            # All injections done — the remaining frames (rest of the base
            # fixture plus the appended quiet hold tail) are the "continue
            # enough raw frames" window requirement #6 needs.

        original_pit_loss_path = bridge.PIT_LOSS_PATH
        bridge.PIT_LOSS_PATH = PLAN_BC_CALIBRATION_FIXTURE
        try:
            cls.result = _plan_bc_seed_replay(
                frames, session_info=PLAN_BC_ACCEPT_SESSION_INFO,
                on_frame_ready=on_frame_ready)
        finally:
            bridge.PIT_LOSS_PATH = original_pit_loss_path
        cls.WRONG_SUFFIX = WRONG_SUFFIX

    def test_injection_sequence_completed(self):
        # Sanity check: every step below actually ran (rather than the
        # fixture running out of frames first and every subsequent
        # assertion passing vacuously for the wrong reason).
        state = self._injected
        self.assertTrue(state['pit_spliced'])
        self.assertTrue(state['audible_sent'])
        self.assertTrue(state['wrong_delivery_sent'])
        self.assertTrue(state['wrong_decision_sent'])
        self.assertTrue(state['accept_sent'])
        self.assertTrue(state['duplicate_delivery_sent'])
        self.assertTrue(state['duplicate_decision_sent'])

    def test_real_pit_advanced_driver_pit_sequence_before_the_captured_accept(self):
        dpe_lines = self.result.logs_containing('DRIVER PIT EVENT:')
        self.assertEqual(len(dpe_lines), 1, dpe_lines)
        payload = json.loads(dpe_lines[0][len('DRIVER PIT EVENT: '):])
        # First real pit of this replay -> driver_pit_sequence advances
        # 0 -> 1 through the real bridge.py pit-exit code path.
        self.assertEqual(payload['driver_pit_sequence'], 1)
        snapshot_lines = self.result.logs_containing(
            'RACE FACTS SNAPSHOT pit_exit driver_pit_sequence=1 ')
        self.assertEqual(len(snapshot_lines), 1, snapshot_lines)
        # Chronological cross-check (WO-005 Revision 7 R2C requirement #7):
        # both real pit-sequence log lines appear strictly BEFORE the accept
        # outcome log — the advance genuinely happened first, in the same
        # append-ordered production log stream.
        pit_lines = self.result.logs_containing('PLAN LIFECYCLE PIT:')
        self.assertEqual(len(pit_lines), 1)
        self.assertLess(self.result.logs.index(snapshot_lines[0]),
                        self.result.logs.index(pit_lines[0]))
        self.assertEqual(self.result.logs_containing('PLAN LIFECYCLE ACCEPT REPLACED:'), [])

    def test_wrong_dispatch_id_delivery_and_decision_do_not_apply(self):
        captured_decision_id = self._injected['decision_id']
        wrong_dispatch_id = self._injected['dispatch_id'] + self.WRONG_SUFFIX
        wrong_delivery_acks = [
            b for b in self.result.broadcasts
            if b.get('type') == 'strategy_delivery_ack'
            and b.get('decision_id') == captured_decision_id
            and b.get('dispatch_id') == wrong_dispatch_id]
        self.assertEqual(len(wrong_delivery_acks), 1, wrong_delivery_acks)
        # 'stale' == reported but NOT applied to the pending proposal
        # (apply_proposal_delivery()'s dispatch_id-mismatch branch).
        self.assertIn(wrong_delivery_acks[0]['applied'], ('no_match', 'stale'))
        wrong_decision_acks = [
            b for b in self.result.broadcasts
            if b.get('type') == 'strategy_decision_ack'
            and b.get('decision_id') == captured_decision_id
            and b.get('dispatch_id') == wrong_dispatch_id]
        self.assertEqual(len(wrong_decision_acks), 1, wrong_decision_acks)
        # 'stale' == acked but NEVER reached the accepted/Lifecycle branch
        # (resolve_strategy_proposal()'s dispatch_id-mismatch branch).
        self.assertIn(wrong_decision_acks[0]['outcome'], ('no_match', 'stale'))

    def test_actual_pit_retires_both_a_and_awaiting_b_before_late_accept(self):
        self.assertEqual(self.result.logs_containing('PLAN LIFECYCLE ACCEPT REPLACED:'), [])
        pit_line = self.result.logs_containing('PLAN LIFECYCLE PIT:')[0]
        pit_index = self.result.logs.index(pit_line)
        payload = json.loads(pit_line.split(': ', 1)[1])
        self.assertIsNone(payload['active_plan_id'])
        self.assertEqual({r['phase'] for r in payload['records']}, {'invalidated'})
        samples = [b for b in self.result.broadcasts if b.get('type') == 'telemetry_live']
        # Runtime pit sequence is the evidence boundary, not a guessed frame.
        after = [b for b in samples if b.get('driver_pit_sequence', 0) >= 1]
        self.assertTrue(after)
        self.assertTrue(all(b.get('active_plan_decision_id') != self._injected['decision_id']
                            for b in after))
        self.assertEqual(self.result.by_trigger('strategy_plan_box_call'), [])

    def test_no_accepted_radio_or_box_output_for_the_invalidated_successor(self):
        captured_decision_id = self._injected['decision_id']
        # No BOX-call radio (the 'commit'-mode broadcast) ever names this
        # decision_id — B never reaches the active/commit path.
        box_calls_for_successor = [
            b for b in self.result.by_trigger('strategy_plan_decision')
            if b.get('decision_id') == captured_decision_id]
        self.assertEqual(box_calls_for_successor, [])
        # The captured proposal itself was broadcast exactly once and never
        # retried/re-proposed under the same decision_id.
        proposals_for_successor = [
            p for p in self.result.by_trigger('strategy_plan_proposal')
            if p['decision_id'] == captured_decision_id]
        self.assertEqual(len(proposals_for_successor), 1, proposals_for_successor)

    def test_duplicate_delivery_and_decision_for_the_captured_dispatch_are_idempotent(self):
        captured_decision_id = self._injected['decision_id']
        captured_dispatch_id = self._injected['dispatch_id']
        delivery_acks = [
            b for b in self.result.broadcasts
            if b.get('type') == 'strategy_delivery_ack'
            and b.get('decision_id') == captured_decision_id
            and b.get('dispatch_id') == captured_dispatch_id]
        self.assertEqual(len(delivery_acks), 2, delivery_acks)
        self.assertIn(delivery_acks[0]['applied'], ('no_match', 'stale'))
        # Idempotent: the SECOND (duplicate) delivery report for the same
        # dispatch never re-applies as 'audible' again. By the time it is
        # sent, `pending_strategy_proposal` has already been cleared by the
        # first accepted decision response — 'no_match' — UNLESS a brand-new
        # (different-decision_id) B/C proposal has since been registered, in
        # which case apply_proposal_delivery()'s decision_id-mismatch branch
        # returns 'stale' instead. Either way it is provably NOT re-applied.
        self.assertIn(delivery_acks[1]['applied'], ('no_match', 'stale'))
        decision_acks = [
            b for b in self.result.broadcasts
            if b.get('type') == 'strategy_decision_ack'
            and b.get('decision_id') == captured_decision_id
            and b.get('dispatch_id') == captured_dispatch_id]
        self.assertEqual(len(decision_acks), 2, decision_acks)
        # The FIRST decision ack legitimately says 'accepted' at the
        # transport-resolution layer (disclosed in this class's docstring)
        # even though the Lifecycle call itself invalidated the record.
        self.assertIn(decision_acks[0]['outcome'], ('no_match', 'stale'))
        # Idempotent: the SECOND (duplicate) decision response is NEVER
        # 'accepted' again — no second activation, no second promoted plan.
        self.assertIn(decision_acks[1]['outcome'], ('no_match', 'stale'))

    def test_terminal_retry_after_quiet_tail_produces_zero_further_broadcasts(self):
        captured_decision_id = self._injected['decision_id']
        captured_dispatch_id = self._injected['dispatch_id']
        # WO-005 Revision 7 R2C requirement #6: across the ENTIRE replay
        # (including the quiet hold-frame tail appended after every
        # injection above), the captured successor never accumulates more
        # than the deliberate 2 delivery acks / 2 decision acks this test
        # itself sent (1 real + 1 duplicate each) — no further broadcast
        # snuck in from continued frame processing.
        delivery_acks = [
            b for b in self.result.broadcasts
            if b.get('type') == 'strategy_delivery_ack'
            and b.get('decision_id') == captured_decision_id
            and b.get('dispatch_id') == captured_dispatch_id]
        decision_acks = [
            b for b in self.result.broadcasts
            if b.get('type') == 'strategy_decision_ack'
            and b.get('decision_id') == captured_decision_id
            and b.get('dispatch_id') == captured_dispatch_id]
        self.assertEqual(len(delivery_acks), 2, delivery_acks)
        self.assertEqual(len(decision_acks), 2, decision_acks)
        proposals_for_successor = [
            p for p in self.result.by_trigger('strategy_plan_proposal')
            if p['decision_id'] == captured_decision_id]
        self.assertEqual(len(proposals_for_successor), 1, proposals_for_successor)
        box_calls_for_successor = [
            b for b in self.result.by_trigger('strategy_plan_decision')
            if b.get('decision_id') == captured_decision_id]
        self.assertEqual(box_calls_for_successor, [])
        # A stays the sole active identity through the whole quiet tail too.
        init_lines = self.result.logs_containing('PLAN LIFECYCLE INITIAL REGISTRATION:')
        a_decision_id = init_lines[0].split('decision_id=')[1].strip()
        samples = [b for b in self.result.broadcasts
                   if b.get('type') == 'telemetry_live' and b.get('active_plan_decision_id')]
        seen_ids = {s['active_plan_decision_id'] for s in samples}
        self.assertEqual(seen_ids, {a_decision_id})


# ═══════════════════════════════════════════════
# REAL POLL LOOP REPLAY — a real SessionNum identity boundary closes the
# old A+B scope before delayed transport for old B arrives (WO-005 R2D).
# ═══════════════════════════════════════════════

PLAN_BC_IDENTITY_CHANGE_SESSION_INFO = PLAN_BC_ACCEPT_SESSION_INFO.replace(
    'DriverInfo:',
    ' - SessionNum: 1\n'
    '   SessionType: Race\n'
    '   SessionLaps: %d\n'
    '   SessionTime: unlimited\n'
    'DriverInfo:' % PLAN_BC_ACCEPT_LAPS_TOTAL)


def _plan_bc_frames_for_session(frames, session_num):
    """Set only the raw reader's SessionNum; preserve every other raw field."""
    result = []
    for source in frames:
        frame = dict(source)
        frame['SessionNum'] = session_num
        result.append(frame)
    return result


class IdentityChangeRejectsOldTransportReplayTests(unittest.TestCase):
    """WO-005 R2D — real raw frames create active A + awaiting B in
    SessionNum 0, then the production reader reports SessionNum 1. The real
    identity block closes the old scope and a new active Plan A is registered
    before delayed delivery/accept messages for old B enter the real queues.
    """

    @classmethod
    def setUpClass(cls):
        old_scope_frames = _plan_bc_frames_for_session(
            _plan_bc_accept_build_frames(), 0)
        new_scope_clean = _plan_bc_frames_for_session(
            _plan_bc_accept_clean_laps(
                6, start_lap=1, start_fuel=58.0, start_time=1000.0), 1)
        new_scope_hold, _ = _plan_bc_accept_hold_frames(
            36, lap=7, fuel=46.0, start_time=1100.0)
        frames = old_scope_frames + new_scope_clean + _plan_bc_frames_for_session(
            new_scope_hold, 1)
        cls._injected = {
            'old_proposal_seen': False,
            'identity_closed': False,
            'new_active_seen': False,
            'old_delivery_sent': False,
            'old_delivery_acked': False,
            'old_accept_sent': False,
            'old_accept_acked': False,
            'old_decision_id': None,
            'old_dispatch_id': None,
            'old_active_id': None,
            'new_active_id': None,
            'new_active_revision': None,
            'injection_broadcast_index': None,
        }

        def on_frame_ready(cursor, frame, result):
            state = cls._injected
            proposals = result.by_trigger('strategy_plan_proposal')
            if proposals and not state['old_proposal_seen']:
                proposal = proposals[0]
                state['old_decision_id'] = proposal['decision_id']
                state['old_dispatch_id'] = proposal['dispatch_id']
                init_lines = result.logs_containing(
                    'PLAN LIFECYCLE INITIAL REGISTRATION:')
                if init_lines:
                    state['old_active_id'] = init_lines[0].split(
                        'decision_id=', 1)[1].strip()
                state['old_proposal_seen'] = True
            if result.logs_containing('PLAN LIFECYCLE SCOPE CLOSED:'):
                state['identity_closed'] = True
            if state['identity_closed'] and not state['new_active_seen']:
                telemetry = [
                    b for b in result.broadcasts
                    if b.get('type') == 'telemetry_live'
                    and b.get('active_plan_decision_id')
                    and b.get('active_plan_decision_id') not in (
                        state['old_active_id'], state['old_decision_id'])]
                if telemetry:
                    latest = telemetry[-1]
                    state['new_active_id'] = latest['active_plan_decision_id']
                    state['new_active_revision'] = latest['active_plan_revision']
                    state['new_active_seen'] = True
            if state['new_active_seen'] and not state['old_delivery_sent']:
                state['injection_broadcast_index'] = len(result.broadcasts)
                bridge._queue_strategy_delivery_report(
                    state['old_decision_id'], 'audible', session_num=0,
                    dispatch_id=state['old_dispatch_id'])
                state['old_delivery_sent'] = True
                return
            if state['old_delivery_sent'] and not state['old_delivery_acked']:
                acks = [
                    b for b in result.broadcasts
                    if b.get('type') == 'strategy_delivery_ack'
                    and b.get('decision_id') == state['old_decision_id']
                    and b.get('dispatch_id') == state['old_dispatch_id']]
                if not acks:
                    return
                state['old_delivery_acked'] = True
                bridge._queue_strategy_decision_response(
                    state['old_decision_id'], True, session_num=0,
                    dispatch_id=state['old_dispatch_id'])
                state['old_accept_sent'] = True
                return
            if state['old_accept_sent'] and not state['old_accept_acked']:
                acks = [
                    b for b in result.broadcasts
                    if b.get('type') == 'strategy_decision_ack'
                    and b.get('decision_id') == state['old_decision_id']
                    and b.get('dispatch_id') == state['old_dispatch_id']]
                if acks:
                    state['old_accept_acked'] = True

        original_pit_loss_path = bridge.PIT_LOSS_PATH
        bridge.PIT_LOSS_PATH = PLAN_BC_CALIBRATION_FIXTURE
        try:
            cls.result = _plan_bc_seed_replay(
                frames, session_info=PLAN_BC_IDENTITY_CHANGE_SESSION_INFO,
                on_frame_ready=on_frame_ready)
        finally:
            bridge.PIT_LOSS_PATH = original_pit_loss_path

    def test_every_identity_and_inbound_stage_completed(self):
        for key in ('old_proposal_seen', 'identity_closed', 'new_active_seen',
                    'old_delivery_sent', 'old_delivery_acked',
                    'old_accept_sent', 'old_accept_acked'):
            self.assertTrue(self._injected[key], key)
        for key in ('old_decision_id', 'old_dispatch_id', 'old_active_id',
                    'new_active_id', 'new_active_revision',
                    'injection_broadcast_index'):
            self.assertIsNotNone(self._injected[key], key)

    def test_real_session_identity_change_closes_old_scope_and_starts_new_scope(self):
        closed = self.result.logs_containing('PLAN LIFECYCLE SCOPE CLOSED:')
        self.assertEqual(len(closed), 1, closed)
        self.assertIn('reason=race_identity_changed', closed[0])
        self.assertIn('status=closed', closed[0])
        registrations = self.result.logs_containing(
            'PLAN LIFECYCLE INITIAL REGISTRATION:')
        self.assertEqual(len(registrations), 2, registrations)
        self.assertIn('decision_id=%s' % self._injected['old_active_id'], registrations[0])
        self.assertIn('decision_id=%s' % self._injected['new_active_id'], registrations[1])
        self.assertNotEqual(
            self._injected['old_active_id'], self._injected['new_active_id'])

    def test_delayed_old_delivery_and_accept_are_acked_fail_closed(self):
        state = self._injected
        delivery_acks = [
            b for b in self.result.broadcasts
            if b.get('type') == 'strategy_delivery_ack'
            and b.get('decision_id') == state['old_decision_id']
            and b.get('dispatch_id') == state['old_dispatch_id']]
        decision_acks = [
            b for b in self.result.broadcasts
            if b.get('type') == 'strategy_decision_ack'
            and b.get('decision_id') == state['old_decision_id']
            and b.get('dispatch_id') == state['old_dispatch_id']]
        self.assertEqual(len(delivery_acks), 1, delivery_acks)
        self.assertIn(delivery_acks[0]['applied'], ('no_match', 'stale'))
        self.assertEqual(len(decision_acks), 1, decision_acks)
        self.assertIn(decision_acks[0]['outcome'], ('no_match', 'stale'))

    def test_old_successor_never_activates_or_emits_box_after_scope_change(self):
        old_b = self._injected['old_decision_id']
        self.assertEqual([
            line for line in self.result.logs_containing(
                'PLAN LIFECYCLE ACCEPT REPLACED:')
            if 'decision_id=%s' % old_b in line], [])
        self.assertEqual([
            b for b in self.result.by_trigger('strategy_plan_decision')
            if b.get('decision_id') == old_b], [])
        proposals = [
            b for b in self.result.by_trigger('strategy_plan_proposal')
            if b.get('decision_id') == old_b]
        self.assertEqual(len(proposals), 1, proposals)

    def test_new_active_pointer_survives_both_old_transport_inputs(self):
        state = self._injected
        after = self.result.broadcasts[state['injection_broadcast_index']:]
        samples = [
            b for b in after
            if b.get('type') == 'telemetry_live'
            and b.get('active_plan_decision_id')]
        self.assertTrue(samples)
        self.assertEqual(
            {b['active_plan_decision_id'] for b in samples},
            {state['new_active_id']})
        self.assertEqual(
            {b['active_plan_revision'] for b in samples},
            {state['new_active_revision']})


# ═══════════════════════════════════════════════
# REAL POLL LOOP REPLAY — undelivered proposal retry is a new dispatch for
# the same decision, and delayed failure for attempt #1 cannot damage #2.
# ═══════════════════════════════════════════════

class UndeliveredProposalRetryReplayTests(unittest.TestCase):
    """WO-005 R2E — real B proposal attempt #1 is released by a
    dropped-before-audible report; continued raw frames cause production to
    retry the same decision with a fresh, monotonically increasing dispatch.
    A delayed duplicate failure for #1 is stale, then #2 is audible/accepted
    exactly once and duplicate inbound messages are idempotent.
    """

    @classmethod
    def setUpClass(cls):
        hold_frames, _ = _plan_bc_accept_hold_frames(
            64, lap=21, fuel=18.0, start_time=700.0)
        frames = _plan_bc_accept_build_frames() + hold_frames
        cls._injected = {
            'first_seen': False, 'first_drop_sent': False,
            'first_released': False, 'second_seen': False,
            'late_first_drop_sent': False, 'late_first_drop_stale': False,
            'second_audible_sent': False, 'second_audible_applied': False,
            'second_accept_sent': False, 'second_accept_acked': False,
            'duplicate_delivery_sent': False, 'duplicate_delivery_acked': False,
            'duplicate_accept_sent': False, 'duplicate_accept_acked': False,
            'decision_id': None, 'dispatch_1': None, 'dispatch_2': None,
            'tail_broadcast_index': None,
        }

        def proposal_pair(result, state):
            return [
                b for b in result.by_trigger('strategy_plan_proposal')
                if b.get('decision_id') == state['decision_id']]

        def on_frame_ready(cursor, frame, result):
            state = cls._injected
            proposals = result.by_trigger('strategy_plan_proposal')
            if proposals and not state['first_seen']:
                first = proposals[0]
                state['decision_id'] = first['decision_id']
                state['dispatch_1'] = first['dispatch_id']
                state['first_seen'] = True
            if state['first_seen'] and not state['first_drop_sent']:
                bridge._queue_strategy_delivery_report(
                    state['decision_id'], 'dropped_before_audible',
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_1'])
                state['first_drop_sent'] = True
                return
            if state['first_drop_sent'] and not state['first_released']:
                released = [
                    b for b in result.broadcasts
                    if b.get('type') == 'strategy_delivery_ack'
                    and b.get('decision_id') == state['decision_id']
                    and b.get('dispatch_id') == state['dispatch_1']
                    and b.get('applied') == 'released']
                if not released:
                    return
                state['first_released'] = True
            if state['first_released'] and not state['second_seen']:
                retries = proposal_pair(result, state)
                if len(retries) < 2:
                    return
                state['dispatch_2'] = retries[1]['dispatch_id']
                state['second_seen'] = True
            if state['second_seen'] and not state['late_first_drop_sent']:
                bridge._queue_strategy_delivery_report(
                    state['decision_id'], 'dropped_before_audible',
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_1'])
                state['late_first_drop_sent'] = True
                return
            if state['late_first_drop_sent'] and not state['late_first_drop_stale']:
                old_acks = [
                    b for b in result.broadcasts
                    if b.get('type') == 'strategy_delivery_ack'
                    and b.get('decision_id') == state['decision_id']
                    and b.get('dispatch_id') == state['dispatch_1']]
                if len(old_acks) < 2:
                    return
                if old_acks[-1].get('applied') == 'stale':
                    state['late_first_drop_stale'] = True
            if state['late_first_drop_stale'] and not state['second_audible_sent']:
                bridge._queue_strategy_delivery_report(
                    state['decision_id'], 'audible',
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_2'])
                state['second_audible_sent'] = True
                return
            if state['second_audible_sent'] and not state['second_audible_applied']:
                audible = [
                    b for b in result.broadcasts
                    if b.get('type') == 'strategy_delivery_ack'
                    and b.get('decision_id') == state['decision_id']
                    and b.get('dispatch_id') == state['dispatch_2']
                    and b.get('applied') == 'audible']
                if not audible:
                    return
                state['second_audible_applied'] = True
                bridge._queue_strategy_decision_response(
                    state['decision_id'], True,
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_2'])
                state['second_accept_sent'] = True
                return
            if state['second_accept_sent'] and not state['second_accept_acked']:
                accepted = [
                    b for b in result.broadcasts
                    if b.get('type') == 'strategy_decision_ack'
                    and b.get('decision_id') == state['decision_id']
                    and b.get('dispatch_id') == state['dispatch_2']
                    and b.get('outcome') == 'accepted']
                if not accepted:
                    return
                state['second_accept_acked'] = True
                bridge._queue_strategy_delivery_report(
                    state['decision_id'], 'audible',
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_2'])
                state['duplicate_delivery_sent'] = True
                return
            if state['duplicate_delivery_sent'] and not state['duplicate_delivery_acked']:
                delivery = [
                    b for b in result.broadcasts
                    if b.get('type') == 'strategy_delivery_ack'
                    and b.get('decision_id') == state['decision_id']
                    and b.get('dispatch_id') == state['dispatch_2']]
                if len(delivery) < 2:
                    return
                state['duplicate_delivery_acked'] = True
                bridge._queue_strategy_decision_response(
                    state['decision_id'], True,
                    session_num=PLAN_BC_ACCEPT_SESSION_NUM,
                    dispatch_id=state['dispatch_2'])
                state['duplicate_accept_sent'] = True
                return
            if state['duplicate_accept_sent'] and not state['duplicate_accept_acked']:
                decisions = [
                    b for b in result.broadcasts
                    if b.get('type') == 'strategy_decision_ack'
                    and b.get('decision_id') == state['decision_id']
                    and b.get('dispatch_id') == state['dispatch_2']]
                if len(decisions) < 2:
                    return
                state['duplicate_accept_acked'] = True
                state['tail_broadcast_index'] = len(result.broadcasts)

        original_pit_loss_path = bridge.PIT_LOSS_PATH
        bridge.PIT_LOSS_PATH = PLAN_BC_CALIBRATION_FIXTURE
        try:
            cls.result = _plan_bc_seed_replay(
                frames, session_info=PLAN_BC_ACCEPT_SESSION_INFO,
                on_frame_ready=on_frame_ready)
        finally:
            bridge.PIT_LOSS_PATH = original_pit_loss_path

    def test_every_retry_and_inbound_stage_completed(self):
        for key in ('first_seen', 'first_drop_sent', 'first_released',
                    'second_seen', 'late_first_drop_sent',
                    'late_first_drop_stale', 'second_audible_sent',
                    'second_audible_applied', 'second_accept_sent',
                    'second_accept_acked', 'duplicate_delivery_sent',
                    'duplicate_delivery_acked', 'duplicate_accept_sent',
                    'duplicate_accept_acked'):
            self.assertTrue(self._injected[key], key)
        for key in ('decision_id', 'dispatch_1', 'dispatch_2',
                    'tail_broadcast_index'):
            self.assertIsNotNone(self._injected[key], key)

    def test_retry_keeps_decision_id_but_uses_a_monotonic_new_dispatch(self):
        state = self._injected
        proposals = [
            b for b in self.result.by_trigger('strategy_plan_proposal')
            if b.get('decision_id') == state['decision_id']]
        self.assertEqual(len(proposals), 2, proposals)
        self.assertEqual(proposals[0]['dispatch_id'], state['dispatch_1'])
        self.assertEqual(proposals[1]['dispatch_id'], state['dispatch_2'])
        self.assertNotEqual(state['dispatch_1'], state['dispatch_2'])
        seq_1 = int(state['dispatch_1'].rsplit('#', 1)[1])
        seq_2 = int(state['dispatch_2'].rsplit('#', 1)[1])
        self.assertGreater(seq_2, seq_1)

    def test_first_drop_releases_and_delayed_duplicate_is_stale(self):
        state = self._injected
        first_acks = [
            b for b in self.result.broadcasts
            if b.get('type') == 'strategy_delivery_ack'
            and b.get('decision_id') == state['decision_id']
            and b.get('dispatch_id') == state['dispatch_1']]
        self.assertEqual(len(first_acks), 2, first_acks)
        self.assertEqual(first_acks[0]['outcome'], 'dropped_before_audible')
        self.assertEqual(first_acks[0]['applied'], 'released')
        self.assertEqual(first_acks[1]['outcome'], 'dropped_before_audible')
        self.assertEqual(first_acks[1]['applied'], 'stale')

    def test_second_dispatch_is_audible_and_accepted_then_duplicates_are_idempotent(self):
        state = self._injected
        deliveries = [
            b for b in self.result.broadcasts
            if b.get('type') == 'strategy_delivery_ack'
            and b.get('decision_id') == state['decision_id']
            and b.get('dispatch_id') == state['dispatch_2']]
        decisions = [
            b for b in self.result.broadcasts
            if b.get('type') == 'strategy_decision_ack'
            and b.get('decision_id') == state['decision_id']
            and b.get('dispatch_id') == state['dispatch_2']]
        self.assertEqual(len(deliveries), 2, deliveries)
        self.assertEqual(deliveries[0]['applied'], 'audible')
        self.assertIn(deliveries[1]['applied'], ('no_match', 'stale'))
        self.assertEqual(len(decisions), 2, decisions)
        self.assertEqual(decisions[0]['outcome'], 'accepted')
        self.assertIn(decisions[1]['outcome'], ('no_match', 'stale'))

    def test_second_dispatch_activates_b_once_and_flips_active_identity_once(self):
        state = self._injected
        replaced = [
            line for line in self.result.logs_containing(
                'PLAN LIFECYCLE ACCEPT REPLACED:')
            if 'decision_id=%s' % state['decision_id'] in line]
        self.assertEqual(len(replaced), 1, replaced)
        self.assertIn('status=activated', replaced[0])
        initial = self.result.logs_containing(
            'PLAN LIFECYCLE INITIAL REGISTRATION:')[0]
        a_decision_id = initial.split('decision_id=', 1)[1].strip()
        samples = [
            b for b in self.result.broadcasts
            if b.get('type') == 'telemetry_live'
            and b.get('active_plan_decision_id')]
        ids = [b['active_plan_decision_id'] for b in samples]
        self.assertEqual(set(ids), {a_decision_id, state['decision_id']})
        first_b = ids.index(state['decision_id'])
        self.assertTrue(all(value == state['decision_id'] for value in ids[first_b:]))

    def test_quiet_tail_has_no_third_proposal_or_box_for_terminal_decision(self):
        state = self._injected
        self.assertIsNotNone(state['tail_broadcast_index'])
        tail = self.result.broadcasts[state['tail_broadcast_index']:]
        self.assertTrue(tail, 'quiet tail must contain continued production broadcasts')
        self.assertEqual([
            b for b in tail
            if b.get('trigger') == 'strategy_plan_proposal'
            and b.get('decision_id') == state['decision_id']], [])
        self.assertEqual([
            b for b in tail
            if b.get('trigger') == 'strategy_plan_decision'
            and b.get('decision_id') == state['decision_id']], [])
        proposals = [
            b for b in self.result.by_trigger('strategy_plan_proposal')
            if b.get('decision_id') == state['decision_id']]
        self.assertEqual(len(proposals), 2, proposals)


if __name__ == '__main__':
    unittest.main()
