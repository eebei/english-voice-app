"""WO-002 — Authoritative Race Facts Snapshot: production wiring replay tests.

review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md WO-002 §8 (必須反証テスト), the
items that require the REAL `bridge.poll_iracing()` loop rather than a pure
function call: pit-sequence increment/reset (6-9), immutable copy-on-broadcast
(10), full replay wiring (11), and mutation/reachability probes (12).

Only `reader` / `time` / `broadcast` / `log` are replaced, via
`replay_harness.replay()` — exactly as every other Bridge replay test in this
repo does. No product logic is reimplemented here; every assertion reads a
value the real loop produced.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import replay_harness as rh  # noqa: E402
import bridge  # noqa: E402
import authoritative_race_facts as race_facts_mod  # noqa: E402

LAP_S = 108.0
FUEL_PER_LAP = 3.6
BLACK_FLAG_BIT = race_facts_mod.BLACK_FLAG_BIT

# replay_harness.py's own default SESSION_INFO has no SubSessionID/
# WeekendSessionID, so resolve_race_instance_id() (bridge.py:1092) is always
# on the fallback path there, and bridge.py's PRE-EXISTING (not WO-002)
# reconnect handling already mints a fresh fallback id on every sustained
# reconnect (see ReconnectTests' docstring). To prove WO-002's actual
# contract — "same Bridge process, race/session identity UNCHANGED -> a
# reconnect alone must not reset driver_pit_sequence" — the identity itself
# must be authoritative and reconnect-stable, so this fixture adds a
# SubSessionID.
SESSION_INFO_WITH_SUB_SESSION_ID = """
WeekendInfo:
 TrackName: monza
 TrackDisplayName: Autodromo Nazionale Monza
 TrackLength: 5.793 km
 EventType: Race
 SeriesID: 0
 SubSessionID: 555001234
 WeekendOptions:
  NumStarters: 3
SessionInfo:
 Sessions:
 - SessionNum: 0
   SessionType: Race
   SessionLaps: 20
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
"""


def clean_laps(count, *, start_lap=1, start_fuel=40.0, start_time=100.0,
                session_num=0, lap_time=LAP_S, burn=FUEL_PER_LAP, frames_per_lap=3):
    frames = []
    fuel = start_fuel
    t = start_time
    for i in range(count):
        lap = start_lap + i
        for f in range(frames_per_lap):
            frames.append(rh.make_frame(
                SessionTime=t, SessionNum=session_num, Lap=lap, FuelLevel=fuel,
                LapDistPct=0.2 + 0.2 * f,
                LapLastLapTime=lap_time + i * 0.01 - 0.01 if i else 0.0))
            t += 1.0
        fuel -= burn
        frames.append(rh.make_frame(
            SessionTime=t, SessionNum=session_num, Lap=lap + 1, FuelLevel=fuel,
            LapDistPct=0.01, LapLastLapTime=lap_time + i * 0.01))
        t += 1.0
    return frames, fuel, t, start_lap + count


def pit_visit(*, lap, fuel_before, fuel_added, start_time, session_num=0,
               session_flags=0, dwell=5):
    """One OnPitRoad True->False cycle. `session_flags` is fed identically to
    every frame of the visit, including the exit-transition frame bridge.py
    actually reads (mirrors tests_wo001_road_atlanta_fixture.py's own
    pit_visit(), independently reconstructed here so this WO-002 test file
    does not depend on WO-001's private fixture helpers)."""
    frames = []
    t = start_time
    for _ in range(2):
        frames.append(rh.make_frame(
            SessionTime=t, SessionNum=session_num, Lap=lap, FuelLevel=fuel_before,
            OnPitRoad=True, Speed=18.0, LapDistPct=0.95, SessionFlags=session_flags))
        t += 1.0
    for _ in range(dwell):
        frames.append(rh.make_frame(
            SessionTime=t, SessionNum=session_num, Lap=lap, FuelLevel=fuel_before,
            OnPitRoad=True, Speed=0.0, LapDistPct=0.96, SessionFlags=session_flags))
        t += 1.0
    fuel_after = fuel_before + fuel_added
    exit_session_time = t
    frames.append(rh.make_frame(
        SessionTime=exit_session_time, SessionNum=session_num, Lap=lap,
        FuelLevel=fuel_after, OnPitRoad=False, Speed=22.0, LapDistPct=0.99,
        SessionFlags=session_flags))
    t += 1.0
    return frames, fuel_after, t, exit_session_time


def inactive_gap(start_time, count=20):
    """`count` frames the FakeReader will report as SDK-inactive (see
    replay_harness.FakeReader.is_active()'s `_inactive` support added for
    WO-002). At the default 1s/frame replay clock plus each inactive
    iteration's own 0.3s `time.sleep(0.3)`, `count=20` comfortably exceeds
    bridge.py's 15s sustained-disconnect threshold, so the loop actually
    takes the `reader.close()` -> reopen reconnect path, not the <15s
    "brief blip" path that does not touch identity/sequence state at all."""
    frames = []
    t = start_time
    for _ in range(count):
        frames.append(rh.make_frame(SessionTime=t, _inactive=True))
        t += 1.0
    return frames, t


def pit_timings_of(result):
    return [b for b in result.broadcasts if b.get('type') == 'pit_timing']


def by_fuel_added(pit_timings, fuel_added_l):
    matches = [pt for pt in pit_timings
               if (pt.get('sample') or {}).get('fuel_added_l') == fuel_added_l]
    assert len(matches) == 1, (
        'expected exactly one pit_timing sample with fuel_added_l=%r, got %d'
        % (fuel_added_l, len(matches)))
    return matches[0]


class PitSequenceIncrementTests(unittest.TestCase):
    """§8 item 6: pit exit x2 -> sequence 1, 2. No double-increment."""

    def test_two_real_pit_exits_produce_sequence_1_then_2(self):
        frames, fuel, t, lap = clean_laps(3, start_fuel=60.0)
        pit1, fuel, t, _ = pit_visit(lap=lap, fuel_before=fuel, fuel_added=10.0, start_time=t)
        frames += pit1
        more, fuel, t, lap = clean_laps(2, start_lap=lap, start_fuel=fuel, start_time=t)
        frames += more
        pit2, fuel, t, _ = pit_visit(lap=lap, fuel_before=fuel, fuel_added=8.0, start_time=t)
        frames += pit2
        result = rh.replay(frames)
        timings = pit_timings_of(result)
        self.assertEqual(len(timings), 2)
        first = by_fuel_added(timings, 10.0)['sample']
        second = by_fuel_added(timings, 8.0)['sample']
        self.assertEqual(first['driver_pit_sequence'], 1)
        self.assertEqual(second['driver_pit_sequence'], 2)

    def test_reachability_pit_sequence_increment_depends_on_a_real_onpitroad_exit(self):
        """Same frame count/shape, but OnPitRoad never asserted True. Proves
        the sequence-1/2 result above depends on the real transition, not
        merely on frame count (mirrors WO-001's own reachability-probe
        style)."""
        frames, fuel, t, lap = clean_laps(3, start_fuel=60.0)
        more, fuel, t, lap = clean_laps(7, start_lap=lap, start_fuel=fuel, start_time=t)
        frames += more
        result = rh.replay(frames)
        self.assertEqual(len(pit_timings_of(result)), 0)


class SessionAndRaceIdentityResetTests(unittest.TestCase):
    """§8 items 7-8: SessionNum change resets pit sequence to 0 and does not
    let flags/identity from the old session leak into the new one."""

    def test_session_num_change_resets_pit_sequence_and_race_instance_id(self):
        frames, fuel, t, lap = clean_laps(3, start_fuel=60.0, session_num=0)
        pit1, fuel, t, _ = pit_visit(lap=lap, fuel_before=fuel, fuel_added=12.0,
                                      start_time=t, session_num=0, session_flags=BLACK_FLAG_BIT)
        frames += pit1
        # SessionNum changes 0 -> 1 (e.g. Qualify -> Race boundary within the
        # same weekend). No SubSessionID/WeekendSessionID is configured by
        # replay_harness's default SESSION_INFO, so race_instance_id is on
        # the fallback path, which bridge.py already regenerates on every
        # SessionNum change (maybe_reset_on_session_num_change).
        more, fuel, t, lap2 = clean_laps(3, start_lap=1, start_fuel=fuel, start_time=t, session_num=1)
        frames += more
        pit2, fuel, t, _ = pit_visit(lap=lap2, fuel_before=fuel, fuel_added=9.0,
                                      start_time=t, session_num=1, session_flags=0)
        frames += pit2
        result = rh.replay(frames,session_info=rh.SESSION_INFO.replace(" SubSessionID: 101000\n", ""))
        timings = pit_timings_of(result)
        self.assertEqual(len(timings), 2)
        first = by_fuel_added(timings, 12.0)['sample']
        second = by_fuel_added(timings, 9.0)['sample']
        self.assertEqual(first['driver_pit_sequence'], 1,
                          'first pit of session 0 must be sequence 1')
        self.assertEqual(second['driver_pit_sequence'], 1,
                          'first pit of session 1 must reset to sequence 1, not continue to 2')
        self.assertNotEqual(first['race_instance_id'], second['race_instance_id'],
                             'a SessionNum change must not keep the old session\'s race_instance_id')

    def test_first_frame_after_session_change_does_not_inherit_prior_black_flag_state(self):
        """The new session's own first pit read is SessionFlags=None
        (simulates an SDK var lag immediately after a session transition).
        This must report unknown, never silently inherit the OLD session's
        known-true black flag."""
        frames, fuel, t, lap = clean_laps(3, start_fuel=60.0, session_num=0)
        pit1, fuel, t, _ = pit_visit(lap=lap, fuel_before=fuel, fuel_added=12.0,
                                      start_time=t, session_num=0, session_flags=BLACK_FLAG_BIT)
        frames += pit1
        more, fuel, t, lap2 = clean_laps(3, start_lap=1, start_fuel=fuel, start_time=t, session_num=1)
        frames += more
        pit2, fuel, t, _ = pit_visit(lap=lap2, fuel_before=fuel, fuel_added=9.0,
                                      start_time=t, session_num=1, session_flags=None)
        frames += pit2
        result = rh.replay(frames)
        second = by_fuel_added(pit_timings_of(result), 9.0)['sample']
        evidence = second['black_flag_evidence']
        self.assertEqual(evidence['state'], 'unknown')
        self.assertNotEqual(evidence['state'], 'true')
        self.assertIsNone(evidence['raw_value'])
        self.assertEqual(evidence['freshness'], 'unavailable')


class ReconnectTests(unittest.TestCase):
    """§8 item 9: a genuine sustained (>=15s) disconnect + reopen, all within
    ONE poll_iracing() invocation (same Bridge process).

    bridge.py's PRE-EXISTING (not WO-002) reconnect handling always forces a
    fresh SessionInfo re-parse and clears `last_session_sig`, which already
    wipes several other session-scoped state dicts unconditionally on any
    sustained reconnect (`pit_events`, `active_decision_plan`, etc. — this
    predates WO-002 and is explicitly out of its scope; see F05 in
    PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md, assigned to WO-009/010). When no
    authoritative SubSessionID/WeekendSessionID is available,
    race_instance_id itself is on that same fallback path and genuinely
    changes on every such reconnect — in that case WO-002's own contract
    ("race identity変更でpit sequenceを再利用しない") requires
    driver_pit_sequence to reset too, and the two tests below prove exactly
    that pair of outcomes for the two cases (identity authoritative-and-
    stable vs. fallback-and-reconnect-churned)."""

    def _disconnect_and_reconnect_scenario(self, *, session_info):
        frames, fuel, t, lap = clean_laps(3, start_fuel=60.0)
        pit1, fuel, t, _ = pit_visit(lap=lap, fuel_before=fuel, fuel_added=11.0,
                                      start_time=t, session_flags=BLACK_FLAG_BIT)
        frames += pit1
        gap, t = inactive_gap(t, count=20)
        frames += gap
        # First frame back after reconnect: SessionFlags unavailable (as a
        # real SDK var frequently is for a frame or two right after the
        # shared-memory map reattaches).
        frames.append(rh.make_frame(SessionTime=t, Lap=lap + 1, FuelLevel=fuel,
                                     LapDistPct=0.1, SessionFlags=None))
        t += 1.0
        more, fuel, t, lap2 = clean_laps(3, start_lap=lap + 1, start_fuel=fuel, start_time=t)
        frames += more
        pit2, fuel, t, _ = pit_visit(lap=lap2, fuel_before=fuel, fuel_added=7.0,
                                      start_time=t, session_flags=0)
        frames += pit2
        result = rh.replay(frames, session_info=session_info)
        self.assertTrue(result.logs_containing('iRacing DISCONNECTED (sustained 15s)'),
                         'harness setup error: the scripted gap did not reach the real '
                         '15s-disconnect branch (reachability check for this test itself)')
        reconnects = [b for b in result.broadcasts if b.get('type') == 'iracing_connected']
        self.assertGreaterEqual(len(reconnects), 2, 'expected an initial connect plus a reconnect')
        timings = pit_timings_of(result)
        self.assertEqual(len(timings), 2)
        first = by_fuel_added(timings, 11.0)['sample']
        second = by_fuel_added(timings, 7.0)['sample']
        # The SECOND pit's own evidence is what must reflect the post-reconnect
        # read; it is fresh (session_flags=0 fed at its own exit frame), not a
        # stale carry-over of the first pit's known-true state, regardless of
        # which identity case is under test.
        self.assertEqual(second['black_flag_evidence']['state'], 'false')
        self.assertEqual(second['black_flag_evidence']['freshness'], 'fresh')
        return first, second

    def test_reconnect_with_stable_authoritative_identity_does_not_reset_pit_sequence(self):
        first, second = self._disconnect_and_reconnect_scenario(
            session_info=SESSION_INFO_WITH_SUB_SESSION_ID)
        self.assertEqual(first['race_instance_id'], second['race_instance_id'],
                          'a reconnect alone must not change an authoritative '
                          '(SubSessionID-derived) race_instance_id')
        self.assertEqual(first['driver_pit_sequence'], 1)
        self.assertEqual(second['driver_pit_sequence'], 2,
                          'reconnect alone must not reset driver_pit_sequence when '
                          'race/session identity is unchanged and authoritative')
        self.assertLess(first['source_frame_sequence'], second['source_frame_sequence'],
                         'source_frame_sequence must stay monotonic across a reconnect, '
                         'not reset to a small number')

    def test_reconnect_without_authoritative_id_mints_new_fallback_and_resets_pit_sequence(self):
        # Documents the interaction with the pre-existing, out-of-WO-002-scope
        # fallback-identity reconnect behaviour: when race_instance_id itself
        # changes (no SubSessionID available), driver_pit_sequence resetting
        # alongside it is the CORRECT, self-consistent outcome per WO-002's
        # own "race identity変更でpit sequenceを再利用しない" contract — not
        # a violation of "reconnect alone must not reset" (identity did not
        # stay the same here).
        first, second = self._disconnect_and_reconnect_scenario(session_info=rh.SESSION_INFO.replace(" SubSessionID: 101000\n", ""))
        self.assertNotEqual(first['race_instance_id'], second['race_instance_id'],
                             'harness/pre-existing-behaviour assumption: without an '
                             'authoritative id, this reconnect path mints a new fallback')
        self.assertEqual(first['driver_pit_sequence'], 1)
        self.assertEqual(second['driver_pit_sequence'], 1,
                          'when race_instance_id itself changed, pit sequence must '
                          'restart at 1, consistent with the SessionNum-change case above')


class ImmutablePastSampleTests(unittest.TestCase):
    """§8 item 10: a later frame's snapshot update must not rewrite an
    already-broadcast pit_timing sample."""

    def test_earlier_pit_timing_broadcast_is_unchanged_by_a_later_pit(self):
        frames, fuel, t, lap = clean_laps(3, start_fuel=60.0)
        pit1, fuel, t, _ = pit_visit(lap=lap, fuel_before=fuel, fuel_added=13.0,
                                      start_time=t, session_flags=BLACK_FLAG_BIT)
        frames += pit1
        more, fuel, t, lap = clean_laps(2, start_lap=lap, start_fuel=fuel, start_time=t)
        frames += more
        pit2, fuel, t, _ = pit_visit(lap=lap, fuel_before=fuel, fuel_added=6.0,
                                      start_time=t, session_flags=0)
        frames += pit2
        result = rh.replay(frames)
        first_evidence_at_capture = dict(
            by_fuel_added(pit_timings_of(result), 13.0)['sample']['black_flag_evidence'])
        # Re-read the same broadcast object again (post second-pit processing)
        # and compare against the copy captured right after replay finished.
        first_evidence_now = by_fuel_added(pit_timings_of(result), 13.0)['sample']['black_flag_evidence']
        self.assertEqual(first_evidence_now, first_evidence_at_capture)
        self.assertEqual(first_evidence_now['state'], 'true')
        self.assertNotEqual(first_evidence_now['state'],
                             by_fuel_added(pit_timings_of(result), 6.0)['sample']
                             ['black_flag_evidence']['state'])


class SnapshotSampleConsistencyTests(unittest.TestCase):
    """WO-002 REVISE 1, item 1: the authoritative snapshot itself must be the
    single owner of driver_pit_sequence at the moment of a confirmed pit
    exit — the value bridge.py logs as belonging to the snapshot and the
    value it puts on the pit_timing.sample must be identical, because both
    must come from the SAME `race_facts_mod.with_incremented_pit_sequence()`
    return value, not from two independently-incremented sources that could
    drift apart."""

    def _two_pit_scenario_frames(self):
        frames, fuel, t, lap = clean_laps(3, start_fuel=60.0)
        pit1, fuel, t, _ = pit_visit(lap=lap, fuel_before=fuel, fuel_added=5.0,
                                      start_time=t, session_flags=BLACK_FLAG_BIT)
        frames += pit1
        more, fuel, t, lap = clean_laps(2, start_lap=lap, start_fuel=fuel, start_time=t)
        frames += more
        pit2, fuel, t, _ = pit_visit(lap=lap, fuel_before=fuel, fuel_added=3.0,
                                      start_time=t, session_flags=0)
        frames += pit2
        return frames

    def _snapshot_log_sequences(self, result):
        """Parses the 'RACE FACTS SNAPSHOT pit_exit driver_pit_sequence=N ...'
        lines bridge.py logs from the snapshot itself, right after
        with_incremented_pit_sequence() runs — an observation point
        independent of the pit_timing broadcast payload."""
        out = []
        for line in result.logs_containing('RACE FACTS SNAPSHOT pit_exit'):
            out.append(int(line.split('driver_pit_sequence=', 1)[1].split(' ', 1)[0]))
        return out

    def test_exit_frame_snapshot_and_sample_driver_pit_sequence_match(self):
        result = rh.replay(self._two_pit_scenario_frames())
        logged = self._snapshot_log_sequences(result)
        self.assertEqual(logged, [1, 2])
        timings = pit_timings_of(result)
        first = by_fuel_added(timings, 5.0)['sample']
        second = by_fuel_added(timings, 3.0)['sample']
        self.assertEqual(first['driver_pit_sequence'], logged[0],
                          'sample.driver_pit_sequence must match the snapshot\'s own '
                          'logged value for the SAME exit frame')
        self.assertEqual(second['driver_pit_sequence'], logged[1])

    def test_mutation_breaking_single_owner_increment_makes_sequence_never_advance(self):
        """Poison with_incremented_pit_sequence() into a no-op (returns the
        snapshot unchanged, so driver_pit_sequence never leaves its initial
        0). If bridge.py genuinely sources both the log and the sample from
        this function's return value, driver_pit_sequence must then get
        stuck at 0 for BOTH pits instead of reaching 1 then 2 — proving the
        control-case test above depends on this exact production call, not
        on an independent side-counter bridge.py could have kept instead."""
        original = race_facts_mod.with_incremented_pit_sequence
        race_facts_mod.with_incremented_pit_sequence = lambda snap: snap
        try:
            result = rh.replay(self._two_pit_scenario_frames())
        finally:
            race_facts_mod.with_incremented_pit_sequence = original
        timings = pit_timings_of(result)
        first = by_fuel_added(timings, 5.0)['sample']
        second = by_fuel_added(timings, 3.0)['sample']
        self.assertEqual(first['driver_pit_sequence'], 0,
                          'poisoning with_incremented_pit_sequence() into a no-op must '
                          'suppress the 0->1 advance the unmutated control case shows')
        self.assertEqual(second['driver_pit_sequence'], 0,
                          'and must also suppress the following 1->2 advance')
        logged = self._snapshot_log_sequences(result)
        self.assertEqual(logged, [0, 0],
                          'the logged snapshot value must move in lockstep with the '
                          'poisoned function, proving the log itself is sourced from it')


class MutationWiringProbeTests(unittest.TestCase):
    """§8 item 12: breaking one production wiring connection must flip a
    currently-green result to red. Each probe monkeypatches exactly one
    authoritative_race_facts function bridge.py calls into (not a copy of
    it living in bridge.py), proving bridge.py genuinely calls through the
    module rather than reimplementing the same logic inline."""

    def _known_true_scenario_frames(self):
        frames, fuel, t, lap = clean_laps(3, start_fuel=60.0)
        pit, _, _, _ = pit_visit(lap=lap, fuel_before=fuel, fuel_added=4.0,
                                  start_time=t, session_flags=BLACK_FLAG_BIT)
        return frames + pit

    def test_control_case_reports_true_without_mutation(self):
        result = rh.replay(self._known_true_scenario_frames())
        sample = by_fuel_added(pit_timings_of(result), 4.0)['sample']
        self.assertEqual(sample['black_flag_evidence']['state'], 'true')

    def test_mutating_classify_black_flag_flips_the_known_true_result(self):
        original = race_facts_mod.classify_black_flag
        race_facts_mod.classify_black_flag = lambda raw: {
            'state': 'false', 'authority': race_facts_mod.SESSION_FLAGS_AUTHORITY,
            'raw_value': raw if isinstance(raw, int) else None,
            'freshness': 'fresh' if isinstance(raw, int) else 'unavailable'}
        try:
            result = rh.replay(self._known_true_scenario_frames())
        finally:
            race_facts_mod.classify_black_flag = original
        sample = by_fuel_added(pit_timings_of(result), 4.0)['sample']
        self.assertNotEqual(sample['black_flag_evidence']['state'], 'true',
                             'poisoning classify_black_flag() must suppress the known-true '
                             'result bridge.py otherwise reports')

    def test_mutating_project_black_flag_evidence_changes_the_broadcast_field(self):
        original = race_facts_mod.project_black_flag_evidence
        sentinel = {'state': 'MUTATED_SENTINEL'}
        race_facts_mod.project_black_flag_evidence = lambda snap, fuel: dict(sentinel)
        try:
            result = rh.replay(self._known_true_scenario_frames())
        finally:
            race_facts_mod.project_black_flag_evidence = original
        sample = by_fuel_added(pit_timings_of(result), 4.0)['sample']
        self.assertEqual(sample['black_flag_evidence'], sentinel,
                          'bridge.py must call race_facts_mod.project_black_flag_evidence() '
                          'itself, not build the field independently')

    def test_mutating_build_snapshot_changes_the_race_identity_field(self):
        original = race_facts_mod.build_snapshot

        def poisoned(**kwargs):
            snap = original(**kwargs)
            snap['race_instance_id'] = 'MUTATION_PROBE_RACE_ID'
            return snap
        race_facts_mod.build_snapshot = poisoned
        try:
            result = rh.replay(self._known_true_scenario_frames())
        finally:
            race_facts_mod.build_snapshot = original
        sample = by_fuel_added(pit_timings_of(result), 4.0)['sample']
        self.assertEqual(sample['race_instance_id'], 'MUTATION_PROBE_RACE_ID',
                          'bridge.py must source pit_timing.sample.race_instance_id from '
                          'race_facts_mod.build_snapshot(), not an independently-computed value')


class NoExternalPaidApiTests(unittest.TestCase):

    def test_no_external_paid_api_reachable(self):
        with open(race_facts_mod.__file__, encoding='utf-8') as f:
            src = f.read()
        for forbidden in ('requests', 'urllib', 'http.client', 'socket',
                           'anthropic', 'texttospeech'):
            self.assertNotIn('import %s' % forbidden, src)


if __name__ == '__main__':
    unittest.main()
