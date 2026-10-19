#!/usr/bin/env python3
"""WO-005 REVISE 1 R4 — production `poll_iracing()` replay for the frozen
active-Plan fuel shortfall -> Bridge `safety_override` path
(review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md WO-005 §4.6, required
disproof tests #29-31).

This is a REAL POLL LOOP REPLAY (`replay_harness.replay()` drives the actual
`bridge.poll_iracing()`), not a hand-built Plan dict fed directly into
`plan_lifecycle`. The scenario:

  1. Six clean laps at a modest, steady burn rate let the initial playbook
     register Plan A as the Lifecycle `active` record through the real
     `poll_iracing()` initial-registration site (unchanged from
     `PlanACommitProductionReplayTests` in `tests_bridge_plan_lifecycle_
     wiring.py`).
  2. Two more laps then burn fuel far faster than the frozen Plan A assumed
     (simulating a genuine post-registration deterioration — harder driving,
     damage drag, etc.). `plan_fuel_authority.evaluate()` — the real
     production function — proves the frozen active record can no longer
     reach its own planned pit lap (`cannot_reach_selected_pit_window`) and
     the real `poll_iracing()` site attaches the structured `safety_override`
     to the real `fuel_strategy_warning` broadcast.

Every assertion reads the real `broadcast()`/`log()` stream the production
loop produced — `plan_lifecycle`'s internal `RaceStrategyState` is never
inspected directly, matching every other WO-005 replay test's convention.

This module ALSO writes the captured `fuel_strategy_warning` /
`telemetry_live` broadcasts to
`fixtures/wo005-fuel-safety-override/fuel_safety_override_replay_v1.json`
so `tests-fuel-safety-override-wiring.js` can drive the REAL renderer.html
`injectRadio()` with the REAL shape Bridge produces, instead of a
hand-typed JS object — closing the Bridge -> Renderer loop required by
Revision 7 §4.6 / REVISE 1 R4 without re-implementing either side.
"""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import replay_harness as rh  # noqa: E402

FIXTURE_DIR = os.path.join(HERE, '..', 'fixtures', 'wo005-fuel-safety-override')
FIXTURE_PATH = os.path.join(FIXTURE_DIR, 'fuel_safety_override_replay_v1.json')

LAPS_TOTAL = 30

SESSION_INFO = """
WeekendInfo:
 TrackName: test track
 TrackDisplayName: Test Track
 TrackLength: 4.000 km
 EventType: Race
 SeriesID: 0
 SubSessionID: 992009999
 WeekendOptions:
  NumStarters: 2
SessionInfo:
 Sessions:
 - SessionNum: 0
   SessionType: Race
   SessionLaps: 30
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


def _clean_laps(count, *, start_lap=1, start_fuel=60.0, start_time=100.0,
                 lap_time=100.0, burn=2.9, frames_per_lap=3):
    """Same shape as every other WO replay fixture's `clean_laps()` helper
    (`tests_driver_pit_event_wiring.py`, `tests_wo001_road_atlanta_
    fixture.py`): each synthetic lap gets a distinct `LapLastLapTime` so the
    real `lap_time_changed` edge detector in `poll_iracing()` actually fires
    once per lap, not a single time for a constant value."""
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


def build_frames():
    frames = []
    f, fuel, t, lap = _clean_laps(6, burn=2.9)
    frames += f
    # Post-registration deterioration: burn far above what Plan A assumed.
    # Stops after 2 accelerated laps, BEFORE the natural recalculation this
    # deterioration eventually triggers a lap later — this fixture is about
    # the frozen-Plan-A safety override, not the subsequent recalculation
    # (which is already covered by WO-004/WO-005's own recalculation tests).
    f2, _, _, _ = _clean_laps(2, start_lap=lap, start_fuel=fuel, start_time=t,
                               burn=6.5, lap_time=100.5)
    frames += f2
    return frames


class FuelSafetyOverrideProductionReplayTests(unittest.TestCase):
    """§7-29/30/31: active-registration fuel shortfall through the real
    `poll_iracing()` loop, observed only via `broadcast()`/`log()`."""

    @classmethod
    def setUpClass(cls):
        cls.result = rh.replay(build_frames(), session_info=SESSION_INFO)
        cls.warnings = [b for b in cls.result.broadcasts
                         if b.get('trigger') == 'fuel_strategy_warning']
        cls.telemetry = [b for b in cls.result.broadcasts
                          if b.get('type') == 'telemetry_live']
        cls.box_calls = [b for b in cls.result.broadcasts
                          if b.get('trigger') == 'strategy_plan_box_call']
        cls._write_fixture()

    @classmethod
    def _write_fixture(cls):
        os.makedirs(FIXTURE_DIR, exist_ok=True)
        # Only the fields the renderer wiring test actually consumes are
        # kept from `telemetry_live` (it also carries the full tires/
        # driving_controls/etc. payload, irrelevant here) — every value is
        # still read straight off the real broadcast, not fabricated.
        _telemetry_slim = [
            {'active_plan_decision_id': t.get('active_plan_decision_id'),
             'active_plan_revision': t.get('active_plan_revision'),
             'active_plan_activated_source_frame_sequence':
                 t.get('active_plan_activated_source_frame_sequence')}
            for t in cls.telemetry]
        payload = {
            'source': 'tests_bridge_fuel_safety_override_replay.py '
                       '(regenerated on every run — deterministic synthetic '
                       'telemetry through the real bridge.poll_iracing())',
            'fuel_strategy_warning_broadcasts': cls.warnings,
            'telemetry_live_active_plan_fields': _telemetry_slim,
            'box_call_broadcasts': cls.box_calls,
        }
        with open(FIXTURE_PATH, 'w', encoding='utf-8') as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)

    def test_no_lifecycle_registration_or_scope_failures(self):
        for needle in ('PLAN LIFECYCLE INITIAL REGISTRATION FAILED',
                       'PLAN LIFECYCLE COMMIT FAILED', 'PLAN LIFECYCLE SCOPE INIT ERROR'):
            self.assertEqual(self.result.logs_containing(needle), [],
                              '%s must not occur in this fixture' % needle)

    def test_exactly_one_safety_override_fires_from_the_active_record(self):
        overridden = [w for w in self.warnings if w.get('safety_override')]
        self.assertEqual(len(overridden), 1, self.warnings)
        override = overridden[0]['safety_override']
        self.assertEqual(override['diagnostic'], 'authority_requires_new_decision')
        self.assertIsInstance(override['override_reason'], str)
        self.assertTrue(self.result.logs_containing('PLAN LIFECYCLE SAFETY OVERRIDE:'))

    def test_override_carries_the_same_stable_identity_telemetry_live_carries(self):
        overridden = [w for w in self.warnings if w.get('safety_override')][0]
        override = overridden['safety_override']
        matching_telemetry = [
            t for t in self.telemetry
            if t.get('active_plan_decision_id') == override['decision_id']]
        self.assertTrue(matching_telemetry,
                         'no telemetry_live ever carried this override\'s decision_id')
        for t in matching_telemetry:
            self.assertEqual(t['active_plan_revision'], override['revision'])
            self.assertEqual(t['active_plan_activated_source_frame_sequence'],
                              override['activated_source_frame_sequence'])

    def test_active_decision_identity_is_frozen_across_the_whole_replay(self):
        # The active record must NOT be silently rewritten while the
        # shortfall is live: every telemetry_live sample after registration
        # must show the SAME decision_id/revision/activated frame.
        seen_ids = {t.get('active_plan_decision_id') for t in self.telemetry
                    if t.get('active_plan_decision_id')}
        self.assertEqual(len(seen_ids), 1, seen_ids)
        seen_revisions = {t.get('active_plan_revision') for t in self.telemetry
                           if t.get('active_plan_decision_id')}
        self.assertEqual(seen_revisions, {0})

    def test_no_box_call_ever_fires_for_the_insufficient_frozen_plan(self):
        self.assertEqual(self.box_calls, [])

    def test_fixture_file_written_for_the_renderer_test(self):
        self.assertTrue(os.path.isfile(FIXTURE_PATH))
        with open(FIXTURE_PATH, encoding='utf-8') as fh:
            payload = json.load(fh)
        self.assertEqual(len(payload['fuel_strategy_warning_broadcasts']), 1)
        self.assertTrue(payload['fuel_strategy_warning_broadcasts'][0].get('safety_override'))
        self.assertTrue(payload['telemetry_live_active_plan_fields'])


if __name__ == '__main__':
    unittest.main()
