#!/usr/bin/env python3
"""WO-018: Plan outcomes reach the debrief source (session_summary) from the real
Lifecycle owner, with the same race/session/decision/pit identity.

The scenarios drive the real poll loop through replay_harness (iRacing IO is the replay
fake; Plan commit, pit event classification, Lifecycle transitions and the summary are
all real product code).  No paid API.

`--emit <scenario>` prints the real broadcast session_summary (and the last canonical
snapshot) as JSON so the Desktop suite (tests-wo018-debrief-outcome.js) consumes the
actual Bridge output, from either the current tree or the pre-WO018 tree.
"""
import json
import os
import sys
import unittest

# WO018_BRIDGE_ROOT lets the Desktop suite run the SAME scenarios against the saved pre-WO018 tree.
sys.path.insert(0, os.environ.get('WO018_BRIDGE_ROOT') or os.path.dirname(os.path.abspath(__file__)))

import replay_harness as rh  # noqa: E402
import tests_wo001_road_atlanta_fixture as road  # noqa: E402
import plan_lifecycle as pl  # noqa: E402

try:
    import debrief_outcomes as do  # noqa: E402  (absent in the pre-WO018 tree)
except ImportError:  # pragma: no cover - before-tree emit mode only
    do = None


def _finish_frames(last):
    """Leader checker, then the player's own line crossing (real RaceLifecycle finish)."""
    base = last['LapLastLapTime']
    t = last['SessionTime'] + 1
    fuel = last['FuelLevel']
    lap = last['Lap']
    out = []
    for i in range(6):
        out.append(rh.make_frame(SessionTime=t + i, Lap=lap, FuelLevel=fuel, SessionState=5,
                                 LapLastLapTime=base, LapDistPct=0.5 + 0.05 * i,
                                 SessionLapsRemain=1, SessionLapsTotal=road.LAPS_TOTAL))
    t += 6
    for i in range(10):
        out.append(rh.make_frame(SessionTime=t + i, Lap=lap + 1, FuelLevel=fuel - 1, SessionState=5,
                                 LapLastLapTime=base + 1, LapDistPct=0.02,
                                 SessionLapsRemain=0, SessionLapsTotal=road.LAPS_TOTAL))
    return out


def scenario_red_thread():
    """Road Atlanta: Plan A lap 21 -> early stop L15 -> penalty stop L16 (black flag) -> finish."""
    frames, _times = road.build_red_thread_frames()
    return rh.replay(frames + _finish_frames(frames[-1]), session_info=road.ROAD_ATLANTA_SESSION_INFO)


SHORT_FUEL_ADDED_L = 2.0   # synthetic: the L15 stop adds too little to finish (not the 16.79 L handoff fact)


def scenario_short_fuel_penalty():
    """WO-019 synthetic variant of the red thread: the L15 early stop adds only 2.0 L, so a
    further stop is required. The post-stop Plan comes only from post-stop measured inputs;
    the L16 black-flag stop then invalidates it as a penalty pit."""
    frames, fuel, t, lap = road.clean_laps(14, start_fuel=60.0)
    pit1, fuel, t, _ = road.pit_visit(lap=15, fuel_before=fuel, fuel_added=SHORT_FUEL_ADDED_L, start_time=t)
    frames += pit1
    more, fuel, t, lap = road.clean_laps(1, start_lap=15, start_fuel=fuel, start_time=t)
    frames += more
    pit2, fuel, t, _ = road.pit_visit(lap=16, fuel_before=fuel, fuel_added=0.0, start_time=t, black_flag=True)
    frames += pit2
    more2, fuel, t, lap = road.clean_laps(8, start_lap=16, start_fuel=fuel, start_time=t)
    frames += more2
    return rh.replay(frames + _finish_frames(frames[-1]), session_info=road.ROAD_ATLANTA_SESSION_INFO)


def scenario_unknown_flags():
    """Same early stop, but the second stop's SessionFlags are unreadable (never 'penalty')."""
    frames, fuel, t, lap = road.clean_laps(14, start_fuel=60.0)
    pit1, fuel, t, _ = road.pit_visit(lap=15, fuel_before=fuel, fuel_added=16.79, start_time=t)
    frames += pit1
    more, fuel, t, lap = road.clean_laps(1, start_lap=15, start_fuel=fuel, start_time=t)
    frames += more
    pit2, fuel, t, _ = road.unknown_flags_pit_visit(lap=16, fuel_before=fuel, fuel_added=0.0, start_time=t)
    frames += pit2
    more2, fuel, t, lap = road.clean_laps(8, start_lap=16, start_fuel=fuel, start_time=t)
    frames += more2
    return rh.replay(frames + _finish_frames(frames[-1]), session_info=road.ROAD_ATLANTA_SESSION_INFO)


def scenario_normal():
    """Control: the active Plan's own target lap stop executes it, then the race finishes."""
    frames = road.clean_laps(7)[0]
    state = {'spliced': False}

    def hook(cursor, frame, result):
        live = [b for b in result.broadcasts if b.get('type') == 'telemetry_live' and b.get('active_plan_decision_id')]
        if state['spliced'] or not live:
            return
        active = live[-1]['canonical_lifecycle']['lifecycle']['active']
        target = active['target_lap']
        pit, fuel, tm, _ = road.pit_visit(lap=target, fuel_before=30, fuel_added=5, start_time=400)
        after = road.clean_laps(2, start_lap=target, start_fuel=fuel, start_time=tm)[0]
        tail = pit + after + _finish_frames(after[-1])
        frames[cursor:] = tail
        result.live_frames[cursor:] = tail
        state['spliced'] = True

    r = rh.replay(frames, session_info=road.ROAD_ATLANTA_SESSION_INFO, on_frame_ready=hook)
    assert state['spliced'], 'normal scenario never reached an active Plan'
    return r


SCENARIOS = {'red_thread': scenario_red_thread, 'unknown_flags': scenario_unknown_flags, 'normal': scenario_normal,
             'short_fuel_penalty': scenario_short_fuel_penalty}


def summaries(result):
    return [b for b in result.broadcasts if b.get('type') == 'session_summary']


def last_snapshot(result):
    snaps = [b for b in result.broadcasts if b.get('type') == 'canonical_lifecycle_snapshot']
    return snaps[-1] if snaps else None


_CACHE = {}


def run(name):
    if name not in _CACHE:
        _CACHE[name] = SCENARIOS[name]()
    return _CACHE[name]


def by_pit(summary):
    return {p['pit_event_id']: p for p in summary['pit_events']}


class RealProducer(unittest.TestCase):
    def _summary(self, name):
        r = run(name)
        ss = summaries(r)
        self.assertEqual(len(ss), 1)
        s = ss[0]
        self.assertTrue(s['is_race'])
        po = s.get('plan_outcomes')
        self.assertIsNotNone(po, 'session_summary must carry the Lifecycle plan outcomes')
        self.assertTrue(po['available'], po)
        for rec in po['records']:
            self.assertEqual((rec['race_instance_id'], rec['session_num']), (s['race_instance_id'], s['session_num']))
        return r, s, po, by_pit(s)

    def _assert_traced(self, r, records):
        # The same decision/pit identity is visible in the Lifecycle's own trace.
        traced = {}
        for line in r.logs_containing('PLAN LIFECYCLE PIT:'):
            d = json.loads(line.split(': ', 1)[1])
            for rec in d['records']:
                traced[rec['decision_id']] = (rec['phase'], rec['invalidated_reason'], rec['terminal_pit_event_id'])
        for rec in records:
            self.assertEqual(traced[rec['decision_id']], (rec['phase'], rec['reason'], rec['terminal_pit_event_id']))

    def _assert_early_plan_a(self, r, s, po, pits):
        early = [x for x in po['records'] if x['reason'] == 'driver_early_pit']
        self.assertEqual(len(early), 1)
        self.assertEqual(early[0]['phase'], 'invalidated')
        # WO-020 P0: the opening Plan A is the authority-aligned target, not a constant.
        opening = [json.loads(l.split(': ', 1)[1]) for l in r.logs_containing('OPENING TARGET ALIGNED:')]
        self.assertEqual(len(opening), 1)
        self.assertEqual((early[0]['target_lap'], early[0]['add_fuel_l']),
                         (opening[0]['target_lap'], opening[0]['add_fuel_l']))
        self.assertEqual(pits[early[0]['terminal_pit_event_id']]['entry_lap'], 15)
        self.assertEqual(pits[early[0]['terminal_pit_event_id']]['plan_reference']['decision_id'], early[0]['decision_id'])
        return early

    def test_red_thread_summary_names_old_plan_invalidation_and_penalty_fact(self):
        # WO-019: 16.79 L at L15 is enough to finish. The pre-stop snapshot (opening Plan A /
        # its amount from lap-5 fuel) is NOT re-committed as a "recalculated" Plan, so the
        # L16 penalty stop is recorded as a penalty fact with no Plan to invalidate.
        r, s, po, pits = self._summary('red_thread')
        self.assertEqual([p['execution_relation'] for p in s['pit_events']], ['early', 'penalty'])
        early = self._assert_early_plan_a(r, s, po, pits)
        self.assertEqual([x for x in po['records'] if x['reason'] == 'penalty_pit'], [])
        self.assertEqual([x for x in po['records'] if x.get('registered_driver_pit_sequence') == 1], [],
                         'no post-stop Plan when no further stop is needed')
        pen = [p for p in s['pit_events'] if p['execution_relation'] == 'penalty'][0]
        self.assertEqual(pen['entry_lap'], 16)
        self.assertEqual(pen['penalty_evidence']['state'], 'true')
        self.assertIsNone(pen['plan_reference'])
        self._assert_traced(r, early)

    def test_short_fuel_fresh_plan_then_penalty_invalidation(self):
        # WO-019 synthetic variant (2.0 L at L15): a further stop is needed, the post-stop
        # Plan comes from post-stop inputs only, and the L16 black-flag stop invalidates it.
        r, s, po, pits = self._summary('short_fuel_penalty')
        self.assertEqual([p['execution_relation'] for p in s['pit_events']], ['early', 'penalty'])
        early = self._assert_early_plan_a(r, s, po, pits)
        penalty = [x for x in po['records'] if x['reason'] == 'penalty_pit']
        self.assertEqual(len(penalty), 1)
        self.assertIn(':recalc:post_service:', penalty[0]['decision_id'])
        self.assertEqual(penalty[0]['registered_driver_pit_sequence'], 1, 'recalculated after pit 1')
        self.assertNotEqual((penalty[0]['target_lap'], penalty[0]['add_fuel_l']),
                            (early[0]['target_lap'], early[0]['add_fuel_l']),
                            'the pre-stop target/amount is never reused')
        fresh = [json.loads(l.split(': ', 1)[1]) for l in r.logs_containing('POST SERVICE TARGET ALIGNED:')]
        opened = [json.loads(l.split('DECISION opened: ', 1)[1]) for l in r.logs_containing('DECISION opened: ')]
        post = [d for d in opened if d['decision_id'] == penalty[0]['decision_id']]
        self.assertEqual(len(post), 1)
        self.assertEqual(post[0]['decided_at_lap'], 15)
        if fresh:
            self.assertEqual(fresh[0]['target_lap'], penalty[0]['target_lap'])
        self.assertEqual(pits[penalty[0]['terminal_pit_event_id']]['execution_relation'], 'penalty')
        self.assertEqual(pits[penalty[0]['terminal_pit_event_id']]['penalty_evidence']['state'], 'true')
        self._assert_traced(r, early + penalty)

    def test_unknown_black_flag_is_never_reported_as_penalty(self):
        s = summaries(run('unknown_flags'))[0]
        self.assertEqual([p['execution_relation'] for p in s['pit_events']], ['early', 'unresolved'])
        self.assertEqual(s['pit_events'][1]['penalty_evidence']['state'], 'unknown')
        reasons = [x['reason'] for x in s['plan_outcomes']['records']]
        self.assertNotIn('penalty_pit', reasons)

    def test_normal_control_executes_plan(self):
        s = summaries(run('normal'))[0]
        executed = [x for x in s['plan_outcomes']['records'] if x['phase'] == 'executed']
        self.assertEqual(len(executed), 1)
        self.assertEqual(executed[0]['reason'], 'normal')
        self.assertEqual(by_pit(s)[executed[0]['terminal_pit_event_id']]['execution_relation'], 'normal')


def _state_with_records(race='sub:1', session=0, n=1):
    state = pl.new_race_strategy_state(race, session)
    for i in range(n):
        state, out = pl.register_plan(
            state, decision_id='d%02d' % i, race_instance_id=race, session_num=session, selected_plan='A',
            plan_basis={}, target_lap=20, add_fuel_l=10.0, set_fuel_l=None, conditions={'ok': True},
            validity_contract={'ok': True}, evidence_snapshot_id=None, options_snapshot={},
            phase='awaiting_driver', created_source_frame_sequence=i, current_driver_pit_sequence=0)
    return state


class PureContract(unittest.TestCase):
    def setUp(self):
        if do is None:
            self.skipTest('debrief_outcomes absent (pre-WO018 tree)')

    def test_scope_mismatch_missing_state_and_missing_identity_are_unavailable(self):
        state = _state_with_records()
        self.assertEqual(do.plan_outcomes(state, 'sub:2', 0)['reason'], 'lifecycle_scope_mismatch')
        self.assertEqual(do.plan_outcomes(state, 'sub:1', 1)['reason'], 'lifecycle_scope_mismatch')
        self.assertEqual(do.plan_outcomes(None, 'sub:1', 0)['reason'], 'lifecycle_state_missing')
        self.assertEqual(do.plan_outcomes(state, None, 0)['reason'], 'summary_identity_missing')
        for bad in (('sub:2', 0), ('sub:1', 1)):
            self.assertEqual(do.plan_outcomes(state, *bad)['records'], [])
        ok = do.plan_outcomes(state, 'sub:1', 0)
        self.assertTrue(ok['available'])
        self.assertEqual(ok['records'][0]['phase'], 'awaiting_driver')
        self.assertIsNone(ok['records'][0]['reason'])

    def test_refresh_only_rereads_its_own_scope(self):
        state = _state_with_records()
        held = {'type': 'session_summary', 'race_instance_id': 'sub:1', 'session_num': 0,
                'plan_outcomes': {'available': True, 'records': []}}
        self.assertEqual(len(do.refresh(held, state)['plan_outcomes']['records']), 1)
        other = pl.new_race_strategy_state('sub:9', 0)
        self.assertIs(do.refresh(held, other), held, 'a different race must never overwrite the held summary')

    def test_published_view_is_detached_from_owner(self):
        state = _state_with_records()
        out = do.plan_outcomes(state, 'sub:1', 0)
        out['records'][0]['phase'] = 'executed'          # consumer側の改変
        out['records'][0]['reason'] = 'normal'
        again = do.plan_outcomes(state, 'sub:1', 0)
        self.assertEqual(again['records'][0]['phase'], 'awaiting_driver')
        self.assertIsNone(again['records'][0]['reason'])
        self.assertEqual(state.plan_records['d00'].phase, 'awaiting_driver')

    def test_bounded(self):
        out = do.plan_outcomes(_state_with_records(n=do.MAX_RECORDS + 3), 'sub:1', 0)
        self.assertEqual(len(out['records']), do.MAX_RECORDS)
        self.assertTrue(out['truncated'])


class GuardCut(unittest.TestCase):
    """The scope guard is what keeps another race's Plans out (cut -> RED, restore -> GREEN)."""

    def test_scope_guard_cut_leaks_other_scope(self):
        if do is None:
            self.skipTest('debrief_outcomes absent (pre-WO018 tree)')
        import types
        with open(do.__file__, encoding='utf-8') as fh:
            src = fh.read()
        guard = "    if state.race_instance_id != race_instance_id or state.session_num != session_num:\n" \
                "        return {'available': False, 'reason': 'lifecycle_scope_mismatch', 'records': []}\n"
        self.assertIn(guard, src)
        cut = types.ModuleType('debrief_outcomes_cut')
        exec(compile(src.replace(guard, ''), 'debrief_outcomes_cut', 'exec'), cut.__dict__)
        state = _state_with_records()
        self.assertTrue(cut.plan_outcomes(state, 'sub:2', 0)['available'], 'cut must leak (RED)')
        self.assertFalse(do.plan_outcomes(state, 'sub:2', 0)['available'], 'restored guard rejects (GREEN)')


def _emit(name):
    r = run(name)
    ss = summaries(r)
    sys.stdout.write(json.dumps({'scenario': name, 'summaries': ss, 'last_snapshot': last_snapshot(r)},
                                ensure_ascii=False, default=str))


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == '--emit':
        _emit(sys.argv[2])
    else:
        unittest.main()
