"""Build 265 (Codex 差戻し 3) — bridge lap_valid_clean emission wiring.

The bridge must:
  1. Track per-lap validity (incidents_this_lap / pit_in_this_lap /
     pit_out_this_lap / off_track_this_lap) as the lap unfolds.
  2. Attach that evidence to every lap-readout broadcast
     (personal_best / session_best / first_lap) so the renderer's Lap Readout
     gate can enforce Every clean lap / Every 2 laps deterministically.
  3. Expose the same evidence on `telemetry_live` so any consumer that reads
     the live snapshot sees identical numbers.
  4. Reset the evidence across a session change so a stale off-track from a
     previous session cannot contaminate the new one.
"""

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_SRC = None


def bridge_src():
    global BRIDGE_SRC
    if BRIDGE_SRC is None:
        with open(os.path.join(HERE, 'bridge.py'), 'r', encoding='utf-8') as fh:
            BRIDGE_SRC = fh.read()
    return BRIDGE_SRC


class LapReadoutBroadcastCarriesCleanEvidence(unittest.TestCase):

    def setUp(self):
        self.src = bridge_src()

    def test_state_variables_are_initialised(self):
        for name, initial in (('_lap_start_incidents', 'None'),
                              ('_lap_had_pit_road', 'False'),
                              ('_lap_had_pit_road_prev', 'False'),
                              ('_lap_had_off_track', 'False'),
                              ('_clean_lap_candidate_count', '0')):
            self.assertRegex(
                self.src, re.escape(name) + r'\s*=\s*' + re.escape(initial),
                'clean-lap state var %s must be initialised to %s' % (name, initial))

    def test_per_frame_updates_mark_pit_road_and_off_track(self):
        # onPit → _lap_had_pit_road; PlayerTrackSurface not in (-1,1,2,3) → off_track
        self.assertIn('if onPit:\n            _lap_had_pit_road = True', self.src)
        self.assertIn('_lap_had_off_track = True', self.src)
        self.assertIn('player_track_surface not in (-1, 1, 2, 3)', self.src)

    def test_lap_readout_broadcasts_carry_clean_evidence(self):
        # The evidence must be spread into each of the three lap-readout paths.
        for path in ("'trigger': 'personal_best'",
                     "'trigger': 'first_lap'",
                     "'trigger': 'session_best'"):
            i = self.src.index(path)
            window = self.src[i:i + 800]
            self.assertIn('_clean_lap_evidence', window,
                          '%s broadcast must carry _clean_lap_evidence' % path)

    def test_clean_evidence_definition_has_all_required_fields(self):
        # The evidence dict definition must expose exactly the fields the
        # renderer gate reads.
        idx = self.src.index('_clean_lap_evidence = {')
        block = self.src[idx:idx + 800]
        for field in ('lap_number', 'lap_valid_clean', 'incidents_this_lap',
                      'pit_in_this_lap', 'pit_out_this_lap',
                      'off_track_this_lap', 'clean_lap_candidate_count'):
            self.assertIn("'%s'" % field, block,
                          'clean evidence must include %s' % field)

    def test_clean_lap_candidate_increments_only_on_valid_clean(self):
        idx = self.src.index('_lap_valid_clean = bool(')
        block = self.src[idx:idx + 500]
        # Definition of clean = no incidents this lap, no pit road, no off track
        self.assertIn('_incidents_this_lap == 0', block)
        self.assertIn('not _lap_had_pit_road', block)
        self.assertIn('not _lap_had_pit_road_prev', block)
        self.assertIn('not _lap_had_off_track', block)
        # Counter increments only when valid clean.
        self.assertIn('if _lap_valid_clean:\n                    _clean_lap_candidate_count += 1', self.src)

    def test_state_rolls_over_after_broadcast(self):
        # After the readout is emitted, the state must roll over for the next
        # lap: pit_road_prev := pit_road, pit_road := False, off_track := False,
        # _lap_start_incidents := incidents.
        idx = self.src.index('last_lap_time = lapTime')
        window = self.src[idx:idx + 600]
        self.assertIn('_lap_had_pit_road_prev = _lap_had_pit_road', window)
        self.assertIn('_lap_had_pit_road = False', window)
        self.assertIn('_lap_had_off_track = False', window)
        self.assertIn('_lap_start_incidents = incidents', window)

    def test_telemetry_live_exposes_clean_evidence(self):
        idx = self.src.index("'type': 'telemetry_live'")
        window = self.src[idx:idx + 1500]
        for field in ('incidents_this_lap', 'pit_in_this_lap',
                      'pit_out_this_lap', 'off_track_this_lap',
                      'clean_lap_candidate_count'):
            self.assertIn(field, window,
                          'telemetry_live must expose %s' % field)

    def test_session_scoped_reset_wipes_clean_lap_state(self):
        # _session_scoped_reset_values must return the new keys; both the
        # SessionNum path and the sig path must consume them.
        reset_def = self.src[self.src.index('def _session_scoped_reset_values'):
                             self.src.index('def derive_pit_phase')]
        for key in ('_lap_start_incidents', '_lap_had_pit_road',
                    '_lap_had_pit_road_prev', '_lap_had_off_track',
                    '_clean_lap_candidate_count'):
            self.assertIn("'%s'" % key, reset_def,
                          'session-scoped reset must include %s' % key)
        # SessionNum path consumer:
        self.assertIn("_lap_had_pit_road = _reset['_lap_had_pit_road']", self.src)
        # sig path consumer:
        self.assertIn("_lap_had_pit_road = _sig_reset['_lap_had_pit_road']", self.src)


if __name__ == '__main__':
    result = unittest.main(verbosity=2, exit=False).result
    if not result.wasSuccessful():
        sys.exit(1)
