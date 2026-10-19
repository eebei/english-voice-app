#!/usr/bin/env python3
"""WO-003 — Immutable DriverPitEvent: production wiring replay tests.

review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md WO-003 §8, the items that
require the REAL `bridge.poll_iracing()` loop rather than a pure function
call: visit-wide penalty evidence survives a false exit-frame read (8),
unknown propagation (9), entry-time Plan freeze not re-read at exit (10),
reconnect preserves the canonical store (11), race/session identity change
resets store scope (12), and same-ID cross-projection consistency across
pit_events / pit_timing.driver_pit_event / structured log (14).

Only `reader` / `time` / `broadcast` / `log` are replaced, via
`replay_harness.replay()` — exactly as every other Bridge replay test in this
repo. No product logic is reimplemented here; every assertion reads a value
the real loop produced. Road Atlanta's own lap 15/lap 16 real-replay
assertions (§8 item 13) live in tests_wo001_road_atlanta_fixture.py's
`test_pit_events_now_carry_race_identity_and_penalty_evidence` — not
duplicated here.
"""

import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import replay_harness as rh  # noqa: E402
import bridge  # noqa: E402
import driver_pit_event as dpe  # noqa: E402
import authoritative_race_facts as race_facts_mod  # noqa: E402

LAP_S = 108.0
FUEL_PER_LAP = 2.9
LAPS_TOTAL = 25
BLACK_FLAG_BIT = 0x00010000

SESSION_INFO_WITH_SUB_SESSION_ID = """
WeekendInfo:
 TrackName: road atlanta
 TrackDisplayName: Michelin Raceway Road Atlanta
 TrackLength: 4.088 km
 EventType: Race
 SeriesID: 0
 SubSessionID: 992005555
 WeekendOptions:
  NumStarters: 3
SessionInfo:
 Sessions:
 - SessionNum: 0
   SessionType: Race
   SessionLaps: 25
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
   CarNumber: "25"
   CarScreenName: Mercedes-AMG GT3 2020
   CarClassID: 100
   CarClassShortName: GT3
   IRating: 2100
   LicSubLevel: 320
"""


def clean_laps(count, *, start_lap=1, start_fuel=60.0, start_time=100.0,
                lap_time=LAP_S, burn=FUEL_PER_LAP, frames_per_lap=3):
    frames = []
    fuel = start_fuel
    t = start_time
    for i in range(count):
        lap = start_lap + i
        for f in range(frames_per_lap):
            frames.append(rh.make_frame(
                SessionTime=t, Lap=lap, FuelLevel=fuel,
                LapDistPct=0.2 + 0.2 * f,
                SessionLapsRemain=LAPS_TOTAL - lap, SessionLapsTotal=LAPS_TOTAL,
                LapLastLapTime=lap_time + i * 0.01 - 0.01 if i else 0.0))
            t += 1.0
        fuel -= burn
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap + 1, FuelLevel=fuel, LapDistPct=0.01,
            SessionLapsRemain=LAPS_TOTAL - (lap + 1), SessionLapsTotal=LAPS_TOTAL,
            LapLastLapTime=lap_time + i * 0.01))
        t += 1.0
    return frames, fuel, t, start_lap + count


def pit_visit(*, lap, fuel_before, fuel_added, start_time, black_flag=False, dwell=5):
    frames = []
    t = start_time
    flags = BLACK_FLAG_BIT if black_flag else 0
    for _ in range(2):
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap, FuelLevel=fuel_before,
            OnPitRoad=True, Speed=18.0, LapDistPct=0.95, SessionFlags=flags,
            SessionLapsRemain=LAPS_TOTAL - lap, SessionLapsTotal=LAPS_TOTAL))
        t += 1.0
    for _ in range(dwell):
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap, FuelLevel=fuel_before,
            OnPitRoad=True, Speed=0.0, LapDistPct=0.96, SessionFlags=flags,
            SessionLapsRemain=LAPS_TOTAL - lap, SessionLapsTotal=LAPS_TOTAL))
        t += 1.0
    fuel_after = fuel_before + fuel_added
    frames.append(rh.make_frame(
        SessionTime=t, Lap=lap, FuelLevel=fuel_after,
        OnPitRoad=False, Speed=22.0, LapDistPct=0.99, SessionFlags=flags,
        SessionLapsRemain=LAPS_TOTAL - lap, SessionLapsTotal=LAPS_TOTAL))
    t += 1.0
    return frames, fuel_after, t


def pit_visit_with_flag_sequence(*, lap, fuel_before, fuel_added, start_time,
                                  entry_flags, mid_flags, exit_flags, dwell=5):
    """Same shape as pit_visit(), but lets the caller drive DIFFERENT
    SessionFlags across entry / mid-dwell / exit frames (§8 item 8/9 need
    entry != mid != exit, not one constant value through the whole stop)."""
    frames = []
    t = start_time
    for _ in range(2):
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap, FuelLevel=fuel_before,
            OnPitRoad=True, Speed=18.0, LapDistPct=0.95, SessionFlags=entry_flags,
            SessionLapsRemain=LAPS_TOTAL - lap, SessionLapsTotal=LAPS_TOTAL))
        t += 1.0
    for _ in range(dwell):
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap, FuelLevel=fuel_before,
            OnPitRoad=True, Speed=0.0, LapDistPct=0.96, SessionFlags=mid_flags,
            SessionLapsRemain=LAPS_TOTAL - lap, SessionLapsTotal=LAPS_TOTAL))
        t += 1.0
    fuel_after = fuel_before + fuel_added
    frames.append(rh.make_frame(
        SessionTime=t, Lap=lap, FuelLevel=fuel_after,
        OnPitRoad=False, Speed=22.0, LapDistPct=0.99, SessionFlags=exit_flags,
        SessionLapsRemain=LAPS_TOTAL - lap, SessionLapsTotal=LAPS_TOTAL))
    t += 1.0
    return frames, fuel_after, t


def inactive_gap(start_time, count=20):
    frames = []
    t = start_time
    for _ in range(count):
        frames.append(rh.make_frame(SessionTime=t, _inactive=True))
        t += 1.0
    return frames, t


def pit_visit_with_mid_visit_reconnect(*, lap, fuel_before, fuel_added, start_time,
                                        entry_flags=0, post_reconnect_flags=0,
                                        exit_flags=0, gap_count=20, dwell=3):
    """Same shape as pit_visit(), but a sustained (>=15s) `_inactive` gap runs
    WHILE the visit tracker is still open (after entry, before exit) instead
    of between two separate visits. Used for WO-003 REVISE 1 P1-3: the gap
    itself must fold in as an unknown observation, not silently vanish."""
    frames = []
    t = start_time
    for _ in range(2):
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap, FuelLevel=fuel_before,
            OnPitRoad=True, Speed=18.0, LapDistPct=0.95, SessionFlags=entry_flags,
            SessionLapsRemain=LAPS_TOTAL - lap, SessionLapsTotal=LAPS_TOTAL))
        t += 1.0
    gap, t = inactive_gap(t, count=gap_count)
    frames += gap
    for _ in range(dwell):
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap, FuelLevel=fuel_before,
            OnPitRoad=True, Speed=0.0, LapDistPct=0.96, SessionFlags=post_reconnect_flags,
            SessionLapsRemain=LAPS_TOTAL - lap, SessionLapsTotal=LAPS_TOTAL))
        t += 1.0
    fuel_after = fuel_before + fuel_added
    frames.append(rh.make_frame(
        SessionTime=t, Lap=lap, FuelLevel=fuel_after,
        OnPitRoad=False, Speed=22.0, LapDistPct=0.99, SessionFlags=exit_flags,
        SessionLapsRemain=LAPS_TOTAL - lap, SessionLapsTotal=LAPS_TOTAL))
    t += 1.0
    return frames, fuel_after, t


def driver_pit_event_logs(result):
    return [json_loads(line.split('DRIVER PIT EVENT: ', 1)[1])
            for line in result.logs_containing('DRIVER PIT EVENT:')]


def json_loads(s):
    import json
    return json.loads(s)


def pit_timings_of(result):
    return [b for b in result.broadcasts if b.get('type') == 'pit_timing']


def scenario_with_plan_a(*, session_info=SESSION_INFO_WITH_SUB_SESSION_ID):
    """Builds a replay long enough for the real build_strategy_decision() to
    commit Plan A (mirrors tests_wo001_road_atlanta_fixture.py's own tuning),
    then adds pit visits driven by the caller."""
    return clean_laps(14, start_fuel=60.0)


class VisitWideAndUnknownEvidenceWiringTests(unittest.TestCase):
    """§8 items 8-9 through the real poll loop: entry/false, mid/true,
    exit/false still resolves to penalty 'true'; an unknown observation with
    no true resolves to 'unknown', never silently 'false'."""

    def test_true_mid_visit_survives_false_at_entry_and_exit(self):
        frames, fuel, t, lap = scenario_with_plan_a()
        pit, fuel, t = pit_visit_with_flag_sequence(
            lap=lap, fuel_before=fuel, fuel_added=10.0, start_time=t,
            entry_flags=0, mid_flags=BLACK_FLAG_BIT, exit_flags=0)
        frames += pit
        result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        events = driver_pit_event_logs(result)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['penalty_evidence']['state'], 'true',
                          'a true observed only mid-visit must survive a false exit-frame read; '
                          'an implementation that only reads the exit frame would report false here')
        self.assertEqual(events[0]['execution_relation'], 'penalty')

    def test_unknown_observed_produces_unresolved_never_silently_false(self):
        frames, fuel, t, lap = scenario_with_plan_a()
        pit, fuel, t = pit_visit_with_flag_sequence(
            lap=lap, fuel_before=fuel, fuel_added=10.0, start_time=t,
            entry_flags=0, mid_flags=None, exit_flags=0)
        frames += pit
        result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        events = driver_pit_event_logs(result)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['penalty_evidence']['state'], 'unknown')
        self.assertNotEqual(events[0]['penalty_evidence']['state'], 'false')
        self.assertEqual(events[0]['execution_relation'], 'unresolved')
        self.assertEqual(events[0]['classification_reason'], 'penalty_evidence_unknown')

    def test_reachability_visit_wide_accumulation_depends_on_real_wiring(self):
        """Mutation-style reachability probe: poison observe_black_flag_frame
        into a no-op (never latches true) and confirm the mid-visit true
        this test relies on disappears — proving the result above depends on
        the real per-frame fold, not a coincidence of the exit-frame read."""
        original = bridge.driver_pit_event_mod.observe_black_flag_frame
        bridge.driver_pit_event_mod.observe_black_flag_frame = lambda state, black_flag: state
        try:
            frames, fuel, t, lap = scenario_with_plan_a()
            pit, fuel, t = pit_visit_with_flag_sequence(
                lap=lap, fuel_before=fuel, fuel_added=10.0, start_time=t,
                entry_flags=0, mid_flags=BLACK_FLAG_BIT, exit_flags=0)
            frames += pit
            result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        finally:
            bridge.driver_pit_event_mod.observe_black_flag_frame = original
        events = driver_pit_event_logs(result)
        self.assertEqual(len(events), 1)
        self.assertNotEqual(events[0]['penalty_evidence']['state'], 'true',
                             'poisoning the fold must suppress the mid-visit true this '
                             'family of tests otherwise proves')


class EntryTimePlanFreezeWiringTests(unittest.TestCase):
    """§8 item 10: Plan reference is frozen at entry, never re-read at exit."""

    def test_freeze_plan_reference_is_called_exactly_once_per_visit(self):
        frames, fuel, t, lap = scenario_with_plan_a()
        pit, fuel, t = pit_visit(lap=lap, fuel_before=fuel, fuel_added=10.0, start_time=t)
        frames += pit
        spy = mock.Mock(wraps=dpe.freeze_plan_reference)
        original = bridge.driver_pit_event_mod.freeze_plan_reference
        bridge.driver_pit_event_mod.freeze_plan_reference = spy
        try:
            result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        finally:
            bridge.driver_pit_event_mod.freeze_plan_reference = original
        events = driver_pit_event_logs(result)
        self.assertEqual(len(events), 1)
        self.assertEqual(spy.call_count, 1,
                          'freeze_plan_reference must be called exactly once per pit visit '
                          '(at entry) — a call at exit as well would mean the Plan reference '
                          'is being re-derived instead of frozen')

    def test_reachability_mutation_exit_time_replan_would_be_caught(self):
        """If bridge.py were changed to call freeze_plan_reference again at
        exit with a DIFFERENT plan, this probe (by poisoning the function to
        return a fixed sentinel target_lap) proves the wiring test above
        actually distinguishes one-call-at-entry from N-calls: forcing every
        call to return the SAME sentinel value must make the final event's
        plan_reference.target_lap equal that sentinel regardless of call
        count, so this pairs with the call_count assertion above rather than
        replacing it."""
        frames, fuel, t, lap = scenario_with_plan_a()
        pit, fuel, t = pit_visit(lap=lap, fuel_before=fuel, fuel_added=10.0, start_time=t)
        frames += pit
        sentinel = dpe.FrozenPlanReference(
            decision_id='sentinel:decision', selected_plan='A', target_lap=555,
            session_num=0, evidence_snapshot_id=None)
        original = bridge.driver_pit_event_mod.freeze_plan_reference
        bridge.driver_pit_event_mod.freeze_plan_reference = lambda *a, **k: sentinel
        try:
            result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        finally:
            bridge.driver_pit_event_mod.freeze_plan_reference = original
        events = driver_pit_event_logs(result)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['plan_reference']['target_lap'], 555,
                          'the finalized event must use the entry-time freeze_plan_reference() '
                          'result, proving the real wiring reaches this function')


class ReconnectAndIdentityScopeWiringTests(unittest.TestCase):
    """§8 items 11-12: reconnect preserves the store; identity change resets it."""

    def test_reconnect_with_stable_identity_preserves_first_pit_and_advances_sequence(self):
        frames, fuel, t, lap = scenario_with_plan_a()
        pit1, fuel, t = pit_visit(lap=lap, fuel_before=fuel, fuel_added=11.0, start_time=t)
        frames += pit1
        gap, t = inactive_gap(t, count=20)
        frames += gap
        frames.append(rh.make_frame(SessionTime=t, Lap=lap + 1, FuelLevel=fuel,
                                     LapDistPct=0.1, SessionFlags=None,
                                     SessionLapsRemain=LAPS_TOTAL - (lap + 1),
                                     SessionLapsTotal=LAPS_TOTAL))
        t += 1.0
        more, fuel, t, lap2 = clean_laps(2, start_lap=lap + 1, start_fuel=fuel, start_time=t)
        frames += more
        pit2, fuel, t = pit_visit(lap=lap2, fuel_before=fuel, fuel_added=7.0, start_time=t)
        frames += pit2
        result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        self.assertTrue(result.logs_containing('iRacing DISCONNECTED (sustained 15s)'),
                         'harness setup error: scripted gap did not reach the 15s-disconnect branch')
        events = driver_pit_event_logs(result)
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]['driver_pit_sequence'], 1)
        self.assertEqual(events[1]['driver_pit_sequence'], 2,
                          'reconnect alone (stable authoritative identity) must not reset '
                          'the canonical store scope — the second pit continues at sequence 2')
        self.assertNotEqual(events[0]['pit_event_id'], events[1]['pit_event_id'])
        self.assertEqual(events[0]['race_instance_id'], events[1]['race_instance_id'])

    def test_session_num_change_resets_store_scope_and_sequence(self):
        frames, fuel, t, lap = clean_laps(3, start_fuel=60.0)
        pit1, fuel, t = pit_visit(lap=lap, fuel_before=fuel, fuel_added=12.0,
                                   start_time=t, black_flag=True)
        frames += pit1
        more = []
        fuel2 = fuel
        t2 = t
        for i in range(3):
            more.append(rh.make_frame(SessionTime=t2, SessionNum=1, Lap=1 + i,
                                       FuelLevel=fuel2, LapDistPct=0.1))
            t2 += 1.0
        frames += more
        pit2, fuel2, t2 = pit_visit(lap=1, fuel_before=fuel2, fuel_added=9.0, start_time=t2)
        pit2 = [dict(f, SessionNum=1) for f in pit2]
        frames += pit2
        result = rh.replay(frames,session_info=rh.SESSION_INFO.replace(" SubSessionID: 101000\n", ""))
        events = driver_pit_event_logs(result)
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]['driver_pit_sequence'], 1)
        self.assertEqual(events[1]['driver_pit_sequence'], 1,
                          'a genuine SessionNum change must reset the store scope, so the '
                          'first pit of the new session is sequence 1, not 3')
        self.assertNotEqual(events[0]['race_instance_id'], events[1]['race_instance_id'])
        self.assertNotEqual(events[0]['pit_event_id'], events[1]['pit_event_id'])


class CrossProjectionConsistencyWiringTests(unittest.TestCase):
    """§8 item 14: pit_events / pit_timing.driver_pit_event / structured log
    must carry the exact same pit_event_id/execution_relation/reason."""

    def test_same_finalize_result_projects_identically_across_all_three_sinks(self):
        frames, fuel, t, lap = scenario_with_plan_a()
        pit, fuel, t = pit_visit(lap=lap, fuel_before=fuel, fuel_added=10.0, start_time=t)
        frames += pit
        result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        log_events = driver_pit_event_logs(result)
        self.assertEqual(len(log_events), 1)
        timings = pit_timings_of(result)
        self.assertEqual(len(timings), 1)
        broadcast_event = timings[0]['driver_pit_event']
        pit_fact_lines = result.logs_containing('PIT EVENT FACT:')
        self.assertEqual(len(pit_fact_lines), 1)
        pit_fact = json_loads(pit_fact_lines[0].split('PIT EVENT FACT: ', 1)[1])
        for field in ('pit_event_id', 'execution_relation', 'classification_reason',
                      'race_instance_id', 'session_num', 'driver_pit_sequence'):
            self.assertEqual(log_events[0][field], broadcast_event[field],
                              'DRIVER PIT EVENT log vs pit_timing.driver_pit_event mismatch on %s' % field)
            self.assertEqual(log_events[0][field], pit_fact[field],
                              'DRIVER PIT EVENT log vs pit_events (PIT EVENT FACT) mismatch on %s' % field)


class DoesNotTouchOutOfScopeBehaviourTests(unittest.TestCase):
    """§8 item 15: creating DriverPitEvents must not terminal-ize the old
    Plan or suppress the stale BOX call — that remains WO-004/005/007 scope."""

    def test_old_box_call_is_retired_after_actual_pit_lifecycle_connection(self):
        frames, fuel, t, lap = scenario_with_plan_a()
        # Two pits: one early (before target), one with a black flag (penalty).
        pit1, fuel, t = pit_visit(lap=lap, fuel_before=fuel, fuel_added=16.0, start_time=t)
        frames += pit1
        more, fuel, t, lap2 = clean_laps(1, start_lap=lap, start_fuel=fuel, start_time=t)
        frames += more
        pit2, fuel, t = pit_visit(lap=lap2, fuel_before=fuel, fuel_added=0.0,
                                   start_time=t, black_flag=True)
        frames += pit2
        more2, fuel, t, lap3 = clean_laps(8, start_lap=lap2, start_fuel=fuel, start_time=t)
        frames += more2
        result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        events = driver_pit_event_logs(result)
        self.assertEqual(len(events), 2)
        self.assertEqual(events[1]['execution_relation'], 'penalty')
        box_calls = result.by_trigger('strategy_plan_box_call')
        # WO-007 now connects this event to canonical Lifecycle.
        self.assertEqual(box_calls, [], 'actual pit must retire the pre-pit decision')


class StoreCollisionDoesNotProjectWiringTests(unittest.TestCase):
    """WO-003 REVISE 1 P1-1: a visit whose store_put() collides (poisoned
    single-owner sequence -> same pit_event_id, different content) must not
    be projected into DRIVER PIT EVENT / pit_events (PIT EVENT FACT) /
    pit_timing.driver_pit_event as a normal event. The poll loop must
    continue and leave a structured invariant error instead — it must not
    re-project the existing store event as "this visit" either."""

    def _colliding_two_pit_scenario(self):
        """Poisons with_incremented_pit_sequence() into a no-op so both pit
        exits report driver_pit_sequence=0 (same race_instance_id/session_num
        too) -> same deterministic pit_event_id, but different entry/exit/
        service facts -> a genuine DriverPitEventCollisionError on the 2nd."""
        frames, fuel, t, lap = scenario_with_plan_a()
        pit1, fuel, t = pit_visit(lap=lap, fuel_before=fuel, fuel_added=11.0, start_time=t)
        frames += pit1
        more, fuel, t, lap2 = clean_laps(2, start_lap=lap, start_fuel=fuel, start_time=t)
        frames += more
        pit2, fuel, t = pit_visit(lap=lap2, fuel_before=fuel, fuel_added=7.0, start_time=t)
        frames += pit2
        return frames

    def test_collision_leaves_invariant_error_and_does_not_project_as_normal_event(self):
        original = race_facts_mod.with_incremented_pit_sequence
        race_facts_mod.with_incremented_pit_sequence = lambda snap: snap
        try:
            frames = self._colliding_two_pit_scenario()
            result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        finally:
            race_facts_mod.with_incremented_pit_sequence = original
        # poll loop must not crash on the collision: every scripted frame is served.
        self.assertEqual(result.frames_served, len(frames))
        events = driver_pit_event_logs(result)
        self.assertEqual(len(events), 1,
                          'the colliding (2nd) visit must not be logged as a normal '
                          'DRIVER PIT EVENT, and the rejected event must not be logged '
                          'in place of it either')
        self.assertTrue(result.logs_containing('DRIVER PIT EVENT INVARIANT ERROR'),
                         'the collision must leave a structured invariant error instead of silence')
        pit_fact_lines = result.logs_containing('PIT EVENT FACT:')
        self.assertEqual(len(pit_fact_lines), 1,
                          'pit_events (PIT EVENT FACT log) must not gain a second entry — '
                          'neither the rejected event nor a re-projection of the existing '
                          'store event may be appended for this frame')
        timings = pit_timings_of(result)
        self.assertEqual(len(timings), 2, 'both pit exits still broadcast pit_timing (poll loop continues)')
        self.assertIsNotNone(timings[0]['driver_pit_event'])
        self.assertIsNone(timings[1]['driver_pit_event'],
                           'the colliding visit must not project into pit_timing.driver_pit_event '
                           '(neither as itself nor as a copy of the existing store event)')

    def test_reachability_mutation_removing_the_catch_would_crash_instead_of_recovering(self):
        """Mutation-style reachability probe: with the SAME poisoned sequence
        owner, confirm the collision path is actually reached (not just
        silently avoided by some other guard) by checking the store itself
        only ever holds ONE canonical event after both pits, proving the
        second store_put() call really did raise/collide rather than
        quietly succeeding with different content under the same ID."""
        original = race_facts_mod.with_incremented_pit_sequence
        race_facts_mod.with_incremented_pit_sequence = lambda snap: snap
        try:
            frames = self._colliding_two_pit_scenario()
            result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        finally:
            race_facts_mod.with_incremented_pit_sequence = original
        events = driver_pit_event_logs(result)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['driver_pit_sequence'], 0,
                          'both colliding visits share driver_pit_sequence=0 under the '
                          'poisoned owner, proving the SAME pit_event_id was attempted twice')


class LegacyViewSurvivesReconnectWiringTests(unittest.TestCase):
    """WO-003 REVISE 1 P1-2: pit_events must be reconstructed from the
    canonical ledger (which reconnect alone does not clear) rather than
    adopting the generic `_sig_reset`/`_reset` paths' `[]`. This spies on the
    real legacy_pit_events_view() to observe what bridge.py's reconnect path
    actually rebuilds — the DRIVER PIT EVENT log alone only proves the
    canonical store survived, not that the pit_events-compatible view seen
    by summary consumers was rebuilt from it instead of reset to empty."""

    def test_reconnect_reconstructs_the_view_from_the_surviving_store_not_from_empty(self):
        frames, fuel, t, lap = scenario_with_plan_a()
        pit1, fuel, t = pit_visit(lap=lap, fuel_before=fuel, fuel_added=11.0, start_time=t)
        frames += pit1
        gap, t = inactive_gap(t, count=20)
        frames += gap
        frames.append(rh.make_frame(SessionTime=t, Lap=lap + 1, FuelLevel=fuel,
                                     LapDistPct=0.1, SessionFlags=None,
                                     SessionLapsRemain=LAPS_TOTAL - (lap + 1),
                                     SessionLapsTotal=LAPS_TOTAL))
        calls = []
        original = dpe.legacy_pit_events_view

        def spying_view(store):
            view = original(store)
            calls.append(view)
            return view

        bridge.driver_pit_event_mod.legacy_pit_events_view = spying_view
        try:
            result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        finally:
            bridge.driver_pit_event_mod.legacy_pit_events_view = original
        self.assertTrue(result.logs_containing('iRacing DISCONNECTED (sustained 15s)'),
                         'harness setup error: scripted gap did not reach the 15s-disconnect branch')
        self.assertGreaterEqual(len(calls), 2,
                                 'legacy_pit_events_view() must be called at least once at the '
                                 'pit-1 exit and again at the reconnect reset path — a reversion '
                                 'to `_sig_reset[\'pit_events\']` (always []) would not call it '
                                 'at reconnect at all')
        post_reconnect_view = calls[-1]
        self.assertEqual(len(post_reconnect_view), 1,
                          'the view reconstructed right after reconnect must still contain the '
                          'pre-reconnect pit — not be reset to an empty list')
        self.assertEqual(post_reconnect_view[0]['driver_pit_sequence'], 1)
        self.assertEqual(post_reconnect_view[0]['execution_relation'], 'early')

    def test_second_pit_after_reconnect_yields_a_two_item_view_not_a_reset_singleton(self):
        frames, fuel, t, lap = scenario_with_plan_a()
        pit1, fuel, t = pit_visit(lap=lap, fuel_before=fuel, fuel_added=11.0, start_time=t)
        frames += pit1
        gap, t = inactive_gap(t, count=20)
        frames += gap
        frames.append(rh.make_frame(SessionTime=t, Lap=lap + 1, FuelLevel=fuel,
                                     LapDistPct=0.1, SessionFlags=None,
                                     SessionLapsRemain=LAPS_TOTAL - (lap + 1),
                                     SessionLapsTotal=LAPS_TOTAL))
        t += 1.0
        more, fuel, t, lap2 = clean_laps(2, start_lap=lap + 1, start_fuel=fuel, start_time=t)
        frames += more
        pit2, fuel, t = pit_visit(lap=lap2, fuel_before=fuel, fuel_added=7.0, start_time=t)
        frames += pit2
        result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        pit_fact_lines = result.logs_containing('PIT EVENT FACT:')
        self.assertEqual(len(pit_fact_lines), 2)
        second_fact = json_loads(pit_fact_lines[1].split('PIT EVENT FACT: ', 1)[1])
        self.assertEqual(second_fact['driver_pit_sequence'], 2,
                          'the legacy view rebuilt at the 2nd pit exit must reflect the full '
                          'surviving ledger (sequence continues to 2), proving pit1 was never '
                          'dropped from pit_events by the intervening reconnect')


class SustainedReconnectDuringVisitWiringTests(unittest.TestCase):
    """WO-003 REVISE 1 P1-3: a sustained (>=15s) reconnect gap while a pit
    visit is still open must fold in as ONE unknown observation for that
    gap, so an all-known-false visit around the gap resolves to unresolved/
    unknown rather than silently collapsing to false, while a known true
    anywhere else still wins over the gap.

    Newly discovered, OUT-OF-SCOPE gap (reported, not fixed here): in this
    codebase a sustained (>=15s) disconnect forces `last_session_sig = None`,
    which makes the NEXT session-info read run the general `_sig_reset` path.
    That path resets `pit_enter_time` (session-scoped reset, unrelated to
    WO-003) to None. If the disconnect happened while a pit visit was still
    open, `pit_enter_time` being wiped mid-visit means `pit_lane_sec` never
    re-enters its accepted 5-300s range at that visit's eventual exit, which
    gates off bridge.py's ENTIRE exit-side DriverPitEvent finalize block
    (not just the penalty-evidence fold) — the visit's DriverPitEvent is
    silently never produced at all, regardless of this P1-3 fix. That defect
    belongs to the pit-lane-time legacy computation, not to WO-003's
    black-flag evidence contract, and is out of the 3-item REVISE 1 scope
    (P1-1/P1-2/P1-3), so it is documented here rather than fixed. The tests
    below therefore verify the REAL, already-accumulated visit-wide penalty
    state via observe_black_flag_frame()'s actual production call chain
    (entry fold + per-frame mid-visit fold + the new reconnect-gap fold),
    resolved with the same resolve_visit_penalty_evidence() finalize()
    itself would call — independent of whether this particular scripted
    visit's exit block happens to complete."""

    def _accumulate_with_fold_spy(self, *, post_reconnect_flags):
        calls = []
        original = dpe.observe_black_flag_frame

        def spying(state, black_flag):
            new_state = original(state, black_flag)
            calls.append((black_flag, new_state))
            return new_state

        bridge.driver_pit_event_mod.observe_black_flag_frame = spying
        try:
            frames, fuel, t, lap = scenario_with_plan_a()
            pit, fuel, t = pit_visit_with_mid_visit_reconnect(
                lap=lap, fuel_before=fuel, fuel_added=10.0, start_time=t,
                entry_flags=0, post_reconnect_flags=post_reconnect_flags, exit_flags=0)
            frames += pit
            result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        finally:
            bridge.driver_pit_event_mod.observe_black_flag_frame = original
        self.assertTrue(result.logs_containing('iRacing DISCONNECTED (sustained 15s)'),
                         'harness setup error: mid-visit gap did not reach the 15s-disconnect branch')
        return calls

    def test_all_known_false_around_a_sustained_gap_resolves_unknown_not_false(self):
        calls = self._accumulate_with_fold_spy(post_reconnect_flags=0)
        self.assertGreaterEqual(len(calls), 1)
        final_state = calls[-1][1]
        evidence = dpe.resolve_visit_penalty_evidence(final_state)
        self.assertEqual(evidence.state, 'unknown',
                          'entry/post-reconnect dwell all known false must NOT accumulate to '
                          'false just because a sustained reconnect gap happened mid-visit — '
                          'the gap itself is unresolved evidence, not a false observation')

    def test_known_true_elsewhere_in_the_visit_still_wins_over_the_gap(self):
        calls = self._accumulate_with_fold_spy(post_reconnect_flags=BLACK_FLAG_BIT)
        self.assertGreaterEqual(len(calls), 1)
        final_state = calls[-1][1]
        evidence = dpe.resolve_visit_penalty_evidence(final_state)
        self.assertEqual(evidence.state, 'true',
                          'a true observed after the gap must still win — penalty > unknown')

    def test_reachability_gap_fold_is_actually_invoked_exactly_once(self):
        """Mutation-style reachability probe: spy on
        reconnect_gap_black_flag_evidence() (wraps the real implementation)
        and confirm it is called exactly once for one sustained gap — proving
        the control-case tests above depend on bridge.py actually calling
        this at the disconnect-confirmed point, not on incidental behavior."""
        calls = []
        original = dpe.reconnect_gap_black_flag_evidence

        def spying():
            calls.append(1)
            return original()

        bridge.driver_pit_event_mod.reconnect_gap_black_flag_evidence = spying
        try:
            frames, fuel, t, lap = scenario_with_plan_a()
            pit, fuel, t = pit_visit_with_mid_visit_reconnect(
                lap=lap, fuel_before=fuel, fuel_added=10.0, start_time=t,
                entry_flags=0, post_reconnect_flags=0, exit_flags=0)
            frames += pit
            result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        finally:
            bridge.driver_pit_event_mod.reconnect_gap_black_flag_evidence = original
        self.assertTrue(result.logs_containing('iRacing DISCONNECTED (sustained 15s)'),
                         'harness setup error: mid-visit gap did not reach the 15s-disconnect branch')
        self.assertEqual(len(calls), 1,
                          'exactly one sustained-reconnect gap mid-visit must fold in exactly '
                          'one unknown observation')

    def test_no_open_visit_means_no_gap_fold_is_attempted(self):
        """A sustained disconnect with NO open pit visit (the ordinary,
        already-covered reconnect-between-pits case) must not call the
        gap-fold at all — it has nothing to fold into."""
        calls = []
        original = dpe.reconnect_gap_black_flag_evidence

        def spying():
            calls.append(1)
            return original()

        bridge.driver_pit_event_mod.reconnect_gap_black_flag_evidence = spying
        try:
            frames, fuel, t, lap = scenario_with_plan_a()
            gap, t = inactive_gap(t, count=20)
            frames += gap
            frames.append(rh.make_frame(SessionTime=t, Lap=lap, FuelLevel=fuel, LapDistPct=0.1))
            result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        finally:
            bridge.driver_pit_event_mod.reconnect_gap_black_flag_evidence = original
        self.assertTrue(result.logs_containing('iRacing DISCONNECTED (sustained 15s)'),
                         'harness setup error: gap did not reach the 15s-disconnect branch')
        self.assertEqual(len(calls), 0)


class SustainedReconnectFinalizeReachesOutputWiringTests(unittest.TestCase):
    """WO-003 REVISE 2: the gap #1 documented (but not fixed) in
    SustainedReconnectDuringVisitWiringTests above is now fixed. A
    same-identity sustained reconnect DURING an open pit visit must no
    longer gate off the exit-side finalize block just because the legacy
    `pit_enter_time` was wiped by `_sig_reset` — the frozen
    `_pit_visit_entry_fact.session_time_s` must fall back in as the lane
    entry time, so the visit's `DriverPitEvent` actually reaches
    `DRIVER PIT EVENT` / `pit_events` (`PIT EVENT FACT`) /
    `pit_timing.driver_pit_event`, not just an accumulated in-memory
    penalty state proven only via a spy."""

    def test_entry_known_false_reconnect_exit_known_false_produces_one_unresolved_unknown_event(self):
        frames, fuel, t, lap = scenario_with_plan_a()
        pit, fuel, t = pit_visit_with_mid_visit_reconnect(
            lap=lap, fuel_before=fuel, fuel_added=10.0, start_time=t,
            entry_flags=0, post_reconnect_flags=0, exit_flags=0)
        frames += pit
        result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        self.assertTrue(result.logs_containing('iRacing DISCONNECTED (sustained 15s)'),
                         'harness setup error: mid-visit gap did not reach the 15s-disconnect branch')
        events = driver_pit_event_logs(result)
        self.assertEqual(len(events), 1,
                          'a same-identity sustained reconnect mid-visit must not silently '
                          'drop the visit\'s DriverPitEvent (legacy pit_enter_time being wiped '
                          'must not gate off the whole exit finalize block)')
        self.assertEqual(events[0]['execution_relation'], 'unresolved')
        self.assertEqual(events[0]['classification_reason'], 'penalty_evidence_unknown')
        self.assertEqual(events[0]['penalty_evidence']['state'], 'unknown')

    def test_same_event_reaches_pit_events_and_pit_timing_with_matching_id_relation_reason(self):
        frames, fuel, t, lap = scenario_with_plan_a()
        pit, fuel, t = pit_visit_with_mid_visit_reconnect(
            lap=lap, fuel_before=fuel, fuel_added=10.0, start_time=t,
            entry_flags=0, post_reconnect_flags=0, exit_flags=0)
        frames += pit
        result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        log_events = driver_pit_event_logs(result)
        self.assertEqual(len(log_events), 1)
        timings = pit_timings_of(result)
        self.assertEqual(len(timings), 1)
        broadcast_event = timings[0]['driver_pit_event']
        pit_fact_lines = result.logs_containing('PIT EVENT FACT:')
        self.assertEqual(len(pit_fact_lines), 1)
        pit_fact = json_loads(pit_fact_lines[0].split('PIT EVENT FACT: ', 1)[1])
        for field in ('pit_event_id', 'execution_relation', 'classification_reason'):
            self.assertEqual(log_events[0][field], broadcast_event[field],
                              'DRIVER PIT EVENT log vs pit_timing.driver_pit_event mismatch on %s' % field)
            self.assertEqual(log_events[0][field], pit_fact[field],
                              'DRIVER PIT EVENT log vs pit_events (PIT EVENT FACT) mismatch on %s' % field)

    def test_known_true_after_reconnect_still_wins_and_keeps_a_single_event(self):
        frames, fuel, t, lap = scenario_with_plan_a()
        pit, fuel, t = pit_visit_with_mid_visit_reconnect(
            lap=lap, fuel_before=fuel, fuel_added=10.0, start_time=t,
            entry_flags=0, post_reconnect_flags=BLACK_FLAG_BIT, exit_flags=0)
        frames += pit
        result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        self.assertTrue(result.logs_containing('iRacing DISCONNECTED (sustained 15s)'),
                         'harness setup error: mid-visit gap did not reach the 15s-disconnect branch')
        events = driver_pit_event_logs(result)
        self.assertEqual(len(events), 1,
                          'a known true elsewhere in the visit must not fragment into a second '
                          'event — the reconnect-gap fix must still finalize exactly one event')
        self.assertEqual(events[0]['penalty_evidence']['state'], 'true')
        self.assertEqual(events[0]['execution_relation'], 'penalty')

    def test_known_true_before_reconnect_still_wins_and_keeps_a_single_event(self):
        frames, fuel, t, lap = scenario_with_plan_a()
        pit, fuel, t = pit_visit_with_mid_visit_reconnect(
            lap=lap, fuel_before=fuel, fuel_added=10.0, start_time=t,
            entry_flags=BLACK_FLAG_BIT, post_reconnect_flags=0, exit_flags=0)
        frames += pit
        result = rh.replay(frames, session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        self.assertTrue(result.logs_containing('iRacing DISCONNECTED (sustained 15s)'),
                         'harness setup error: mid-visit gap did not reach the 15s-disconnect branch')
        events = driver_pit_event_logs(result)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['penalty_evidence']['state'], 'true')
        self.assertEqual(events[0]['execution_relation'], 'penalty')

    def test_identity_mismatch_or_missing_tracker_does_not_borrow_another_visits_time(self):
        """Pure-level guarantee (resolve_lane_entry_time_s) that the fallback
        never fires without a live, identity-matched tracker. The exit-side
        integration above only exercises the same-identity path; this proves
        the guard bridge.py relies on is fail-closed by construction, not by
        this particular fixture happening to keep identity stable."""
        entry_fact = dpe.PitBoundaryFact(
            lap=5, session_time_s=1234.5, source_frame_sequence=10,
            class_position=3, lap_dist_pct=0.95, fuel_l=40.0)
        self.assertIsNone(dpe.resolve_lane_entry_time_s(
            legacy_pit_enter_time_s=None, entry_fact=None,
            entry_race_instance_id='race-a', entry_session_num=0,
            exit_race_instance_id='race-a', exit_session_num=0),
            'no tracker must not borrow any time')
        self.assertIsNone(dpe.resolve_lane_entry_time_s(
            legacy_pit_enter_time_s=None, entry_fact=entry_fact,
            entry_race_instance_id='race-a', entry_session_num=0,
            exit_race_instance_id='race-b', exit_session_num=0),
            'race_instance_id mismatch must not borrow another visit\'s time')
        self.assertIsNone(dpe.resolve_lane_entry_time_s(
            legacy_pit_enter_time_s=None, entry_fact=entry_fact,
            entry_race_instance_id='race-a', entry_session_num=0,
            exit_race_instance_id='race-a', exit_session_num=1),
            'session_num mismatch must not borrow another visit\'s time')


if __name__ == '__main__':
    unittest.main(verbosity=2)
