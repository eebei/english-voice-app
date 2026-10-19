"""WO017: outcome events carry their SOURCE race identity from the Bridge.

Desktop joins pit_cycle_outcome / session_summary to a decision record only by the
race_instance_id the Bridge stamped at the frame that produced the event (never by the
Desktop's arrival-time scope).  These tests drive the real poll loop through
replay_harness and read what the Bridge actually broadcast.

pit_cycle_outcome: no saved replay reaches a real blend outcome, so the outcome
*producer* (pit_cycle_tracker.PitCycleTracker.observe) is replaced by a deterministic
one that returns a single outcome.  The emission site and its identity stamping in
bridge.py run unchanged.  Telemetry/iRacing IO is the replay fake.  No paid API.
"""
import unittest

import replay_harness as rh
import tests_wo001_road_atlanta_fixture as road
import pit_cycle_tracker as pit_cycle_tracker_mod

PRACTICE_THEN_RACE = road.ROAD_ATLANTA_SESSION_INFO.replace(
    ' - SessionNum: 0\n   SessionType: Race\n   SessionLaps: 25\n   SessionTime: unlimited\n',
    ' - SessionNum: 0\n   SessionType: Practice\n   SessionLaps: unlimited\n   SessionTime: 3600 sec\n'
    ' - SessionNum: 1\n   SessionType: Race\n   SessionLaps: 25\n   SessionTime: unlimited\n')


def snapshots(result):
    return [b for b in result.broadcasts if b.get('type') == 'canonical_lifecycle_snapshot']


class SessionSummaryIdentity(unittest.TestCase):
    def test_finished_session_summary_carries_the_ended_session_not_the_new_one(self):
        self.assertNotEqual(PRACTICE_THEN_RACE, road.ROAD_ATLANTA_SESSION_INFO)
        frames, t, fuel, _lap = road.clean_laps(4)
        race_frames = road.clean_laps(2, start_time=t + 5, start_fuel=fuel, start_lap=1)[0]
        for f in race_frames:
            f['SessionNum'] = 1
        result = rh.replay(frames + race_frames, session_info=PRACTICE_THEN_RACE)
        summaries = [b for b in result.broadcasts if b.get('type') == 'session_summary']
        self.assertEqual(len(summaries), 1, 'practice->race boundary must finalize exactly one summary')
        s = summaries[0]
        races = {(x['race_instance_id'], x['session_num']) for x in snapshots(result)}
        self.assertIn((s['race_instance_id'], 0), races)
        self.assertEqual(s['session_num'], 0, 'summary must name the ENDED practice session')
        self.assertTrue(s['race_instance_id'].startswith('sub:'))
        self.assertIsInstance(s.get('bridge_process_epoch'), str)


class _OneOutcomeTracker(pit_cycle_tracker_mod.PitCycleTracker):
    """Deterministic producer: the first observation in a race frame yields one outcome."""
    emitted = 0

    def observe(self, **kwargs):
        if _OneOutcomeTracker.emitted == 0:
            _OneOutcomeTracker.emitted += 1
            return {'condition_met': True, 'post_cycle_actual_position': 3,
                    'physical_exit_position': 5, 'closed_reason': 'test'}
        return None


class PitCycleOutcomeIdentity(unittest.TestCase):
    def test_outcome_carries_the_emitting_frame_race_and_session(self):
        original = pit_cycle_tracker_mod.PitCycleTracker
        _OneOutcomeTracker.emitted = 0
        pit_cycle_tracker_mod.PitCycleTracker = _OneOutcomeTracker
        try:
            frames, _t, _fuel, _lap = road.clean_laps(4)
            result = rh.replay(frames, session_info=road.ROAD_ATLANTA_SESSION_INFO)
        finally:
            pit_cycle_tracker_mod.PitCycleTracker = original
        outcomes = [b for b in result.broadcasts if b.get('type') == 'pit_cycle_outcome']
        self.assertEqual(len(outcomes), 1, 'the real emission site must publish the produced outcome')
        o = outcomes[0]
        races = {(x['race_instance_id'], x['session_num']) for x in snapshots(result)}
        self.assertIn((o.get('race_instance_id'), o.get('session_num')), races)
        self.assertTrue(o['race_instance_id'].startswith('sub:'))
        self.assertIsInstance(o.get('bridge_process_epoch'), str)


if __name__ == '__main__':
    unittest.main()
