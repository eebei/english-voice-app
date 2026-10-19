#!/usr/bin/env python3
"""WO-001 — Road Atlanta red-thread fixture / trace contract (Bridge slice).

review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md WO-001. This file does NOT fix
product behaviour. It reproduces, through the real `bridge.poll_iracing()`
loop (via `replay_harness.replay()` — see that module's own header for why
that is the real production loop and not a rewritten pipeline), the exact
shape of the Build 302 failure described in HANDOFF.md's 2026-09-22 entry:

  Plan A committed at an early lap -> Driver pits for real, then again for a
  penalty -> the ORIGINAL decision_id still fires a BOX call at its target
  lap, as if neither pit had ever happened (F01). A raw black-flag bit
  (0x00010000) present during the penalty stop is never read by any code
  path in bridge.py; only the yellow/caution bits (0xC000) are checked
  anywhere (F03).

Two run modes, selected by the WO001_MODE environment variable (default
'characterization'):

  characterization (default) — asserts the CURRENT (buggy) behaviour is
    reproduced through real code. This command is expected to PASS on
    unmodified HEAD and is safe to run in CI/preflight.
      $ python3 irsdk-bridge/tests_wo001_road_atlanta_fixture.py

  acceptance — asserts the TARGET (fixed) behaviour. This command is
    EXPECTED TO FAIL (exit 1) on unmodified HEAD; that failure is the
    correct, documented "red" state this WO is required to produce. It must
    NOT be added to preflight.sh (review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md
    WO-001 §6: "意図的に赤いacceptance modeを通常preflight.shへ登録してmainを
    常時赤にしない").
      $ WO001_MODE=acceptance python3 irsdk-bridge/tests_wo001_road_atlanta_fixture.py

Non-negotiable rules honoured here:
  - The Plan A decision is produced by the real `build_strategy_decision()` /
    `decide_plan_at_target()` path inside the real `poll_iracing()` loop —
    never injected via `active_decision_plan = ...` from test code.
  - Only `reader` / `time` / `broadcast` / `log` (external I/O boundaries)
    are replaced, exactly as `replay_harness.py` already does for every
    other Bridge replay test in this repo.
  - No external paid API is reachable from this file (checked directly,
    mirroring tests_bridge_poll_replay.py's own self-check).
"""

import copy
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import replay_harness as rh  # noqa: E402
import bridge  # noqa: E402

FIXTURE_PATH = os.path.join(ROOT, 'fixtures', 'road-atlanta',
                             'road_atlanta_build302_red_thread_v1.json')

LAP_S = 108.0
# ★2026-09-23 Codex REVISE #1: target_lap=21 must be a REAL
# build_strategy_decision() output, not asserted text (see
# test_road_atlanta_lap21_target_and_fuel_margin_are_real_product_output).
# 2.9 L/lap is a synthetic_reconstruction fixture input chosen ONLY to make
# the real fuel-strategy arithmetic land on lap 13 + floor((fuel-reserve)/
# avg) = 21, matching HANDOFF's record of the real incident's target lap.
# It is NOT a claim about the original session's real fuel consumption.
# ★2026-09-23 Codex REVISE #1, item 6: LAPS_TOTAL=25 (rather than the prior
# 30) is likewise tuned only so the REAL fuel-to-finish arithmetic at lap 21
# (bridge.py's telemetry_live fuel_strategy) lands on a positive margin,
# matching HANDOFF's qualitative "safe" characterization of the real
# incident. It is not a claim about the original session's actual race
# distance.
FUEL_PER_LAP = 2.9
LAPS_TOTAL = 25
BLACK_FLAG_BIT = 0x00010000

# ── Fixture schema constants (Codex REVISE #2, item 4) ──────────────────
# The loader below must reject a fixture whose scenario_id, event order, or
# event-type order no longer matches these constants. This is what makes
# "順序入替え/scenario変更を拒否" an enforced loader property instead of an
# assumption.
EXPECTED_SCENARIO_ID = 'road_atlanta_build302_red_thread_v1'
EXPECTED_EVENT_ID_ORDER = ['e%02d' % i for i in range(1, 13)]
EXPECTED_TYPE_ORDER = [
    'telemetry', 'driver_utterance', 'driver_utterance', 'driver_utterance',
    'telemetry', 'pit_entry', 'pit_exit', 'flag', 'pit_exit', 'telemetry',
    'delivery', 'debrief',
]

# ── HANDOFF required-value expectation fact (Codex REVISE #2, item 1) ───
# HANDOFF.md's 2026-09-22 entry records these four numbers for the real
# incident. No raw log for that incident exists in this repo (see the
# fixture's _readme), so they are never asserted equal to this fixture's own
# synthetic fuel curve (see test_road_atlanta_lap21_target_and_fuel_margin_
# are_real_product_output). They are instead pinned here as a separate,
# handoff_only EXPECTATION fact that the fixture's e10 event must carry
# verbatim (fixture JSON key "handoff_expectation") — editing or deleting
# that fact in the fixture is a loader-rejected schema violation, not a
# silent drift.
HANDOFF_LAP21_EXPECTATION = {
    'lap': 21, 'fuel_l': 18.14, 'required_fuel_l': 9.98, 'margin_l': 8.16,
}

# ── Road Atlanta identity — test-only (Codex REVISE #1) ────────────────
# replay_harness.py's own default SESSION_INFO is Monza
# (irsdk-bridge/replay_harness.py:89-104). Passing that default silently
# through this fixture would make every "Road Atlanta" claim below false —
# the fixture would actually be exercising a Monza-identity replay. None of
# this SessionInfo text is from the original log (it does not exist in this
# repository); SubSessionID is an arbitrary fixture constant whose only
# contract requirement is that resolve_race_instance_id() (bridge.py:1092)
# derives race_instance_id from it via the real code path.
ROAD_ATLANTA_SUB_SESSION_ID = 992001177
ROAD_ATLANTA_TRACK_NAME = 'road atlanta'
ROAD_ATLANTA_SESSION_INFO = """
WeekendInfo:
 TrackName: road atlanta
 TrackDisplayName: Michelin Raceway Road Atlanta
 TrackLength: 4.088 km
 EventType: Race
 SeriesID: 0
 SubSessionID: %d
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
 - CarIdx: 2
   UserName: Rival Behind
   CarNumber: "3"
   CarScreenName: Mercedes-AMG GT3 2020
   CarClassID: 100
   CarClassShortName: GT3
   IRating: 1900
   LicSubLevel: 280
""" % ROAD_ATLANTA_SUB_SESSION_ID

MODE = os.environ.get('WO001_MODE', 'characterization').strip() or 'characterization'
if MODE not in ('characterization', 'acceptance'):
    sys.stderr.write("WO001_MODE must be 'characterization' or 'acceptance', got %r\n" % MODE)
    sys.exit(2)


# ══════════════════════════════════════════════════════════════════════
# Fixture loading / schema validation (WO-001 §8 item 9)
# ══════════════════════════════════════════════════════════════════════

def load_fixture():
    with open(FIXTURE_PATH, encoding='utf-8') as f:
        return json.load(f)


def _leaf_paths(value, prefix):
    """Recursively enumerate dotted/indexed leaf paths of a JSON value.

    dict -> 'prefix.key', list -> 'prefix[i]', scalar -> 'prefix' itself.
    Used so provenance completeness (Codex REVISE #1, item 3) is checked
    against EVERY payload leaf, including array elements, not just whichever
    top-level keys happen to already have a tag.
    """
    if isinstance(value, dict):
        paths = []
        for k, v in value.items():
            paths.extend(_leaf_paths(v, '%s.%s' % (prefix, k)))
        return paths
    if isinstance(value, list):
        paths = []
        for i, v in enumerate(value):
            paths.extend(_leaf_paths(v, '%s[%d]' % (prefix, i)))
        return paths
    return [prefix]


def validate_fixture(doc):
    """Structural checks only: event_id uniqueness, ordering, required keys,
    provenance classification and completeness. Raises AssertionError with a
    specific reason.

    Codex REVISE #2, item 4 additions: top-level scenario_id, non-empty/
    unique harness_correlation_id, typed non-null product_identity values,
    and the FULL e01-e12 event_id/type order (not just pit_entry < flag) are
    now enforced so that an order swap, a duplicated correlation id, or a
    changed scenario_id is rejected by the loader itself, not merely assumed
    absent.

    Codex REVISE #3, item 1: a non-null product_identity value legitimately
    REAPPEARING across events (e.g. the same decision_id correlating e05's
    Plan A commit to e10's BOX outcome) is the normal longitudinal
    correlation this WO exists to prove, and must be ACCEPTED, not rejected
    as a duplicate. Only a CONTRADICTORY mapping — the same child identity
    value (decision_id, pit_event_id) attributed to two different parent
    identity values (race_instance_id, decision_id) in different events — is
    rejected.
    """
    scenario_id = doc.get('scenario_id')
    assert scenario_id == EXPECTED_SCENARIO_ID, \
        'fixture scenario_id %r does not match expected %r' % (scenario_id, EXPECTED_SCENARIO_ID)
    events = doc.get('events')
    assert isinstance(events, list) and events, 'fixture has no events array'
    seen_ids = set()
    seen_correlation_ids = set()
    identity_mapping = {
        ('decision_id', 'race_instance_id'): {},
        ('pit_event_id', 'race_instance_id'): {},
        ('pit_event_id', 'decision_id'): {},
    }
    handoff_expectation_events = []
    for i, ev in enumerate(events):
        eid = ev.get('event_id')
        assert isinstance(eid, str) and eid, 'event %d missing event_id' % i
        assert eid not in seen_ids, 'duplicate event_id %s' % eid
        seen_ids.add(eid)
        corr = ev.get('harness_correlation_id')
        assert isinstance(corr, str) and corr, '%s missing/empty harness_correlation_id' % eid
        assert corr not in seen_correlation_ids, \
            '%s duplicate harness_correlation_id %r (already used by another event)' % (eid, corr)
        seen_correlation_ids.add(corr)
        pid = ev.get('product_identity')
        assert isinstance(pid, dict), '%s missing product_identity' % eid
        for key in ('race_instance_id', 'decision_id', 'pit_event_id'):
            assert key in pid, '%s product_identity missing %s' % (eid, key)
            val = pid[key]
            if val is not None:
                assert isinstance(val, str) and val, \
                    '%s product_identity.%s must be null or a non-empty string, got %r' % (eid, key, val)
        # Codex REVISE #3, item 1: reject only a CONTRADICTORY mapping (same
        # child identity value attributed to two different parent identity
        # values), never a repeated but consistent value.
        for (child_key, parent_key), mapping in identity_mapping.items():
            child_val = pid.get(child_key)
            parent_val = pid.get(parent_key)
            if child_val is not None and parent_val is not None:
                prior_parent = mapping.get(child_val)
                assert prior_parent is None or prior_parent == parent_val, (
                    '%s contradictory product_identity mapping: %s %r was already mapped to '
                    '%s %r by an earlier event, but this event maps it to %s %r'
                    % (eid, child_key, child_val, parent_key, prior_parent, parent_key, parent_val))
                mapping[child_val] = parent_val
        assert ev.get('type') in (
            'telemetry', 'driver_utterance', 'pit_entry', 'pit_exit',
            'flag', 'delivery', 'speech', 'debrief'), \
            '%s has unknown type %r' % (eid, ev.get('type'))
        payload = ev.get('payload')
        assert isinstance(payload, dict), '%s payload must be an object' % eid
        prov = ev.get('provenance')
        assert isinstance(prov, dict) and prov, '%s missing provenance' % eid
        for field, tag in prov.items():
            src = tag.get('source_class')
            assert src in ('repository_evidence', 'handoff_only',
                            'synthetic_reconstruction'), \
                '%s provenance %s has invalid source_class %r' % (eid, field, src)
            assert tag.get('reference'), '%s provenance %s missing reference' % (eid, field)
        # ★Codex REVISE #1, item 3: every payload leaf (including array
        # elements) and every populated top-level synthetic fact
        # (source_frame_id/at) must carry EXACTLY one provenance tag —
        # neither missing nor unmatched/extra.
        required_tags = set(_leaf_paths(payload, 'payload'))
        if ev.get('source_frame_id') is not None:
            required_tags.add('source_frame_id')
        if ev.get('at') is not None:
            required_tags.add('at')
        provided_tags = set(prov.keys())
        missing = required_tags - provided_tags
        extra = provided_tags - required_tags
        assert not missing, '%s provenance missing tags for %s' % (eid, sorted(missing))
        assert not extra, '%s provenance has extra/unmatched tags %s' % (eid, sorted(extra))
        if 'handoff_expectation' in ev:
            handoff_expectation_events.append((eid, ev['handoff_expectation']))
    # ★Codex REVISE #2, item 4: assert the FULL fixed event_id and type
    # order, not merely "pit_entry before flag".
    ids_in_order = [e.get('event_id') for e in events]
    assert ids_in_order == EXPECTED_EVENT_ID_ORDER, \
        'fixture event_id order %r does not match expected %r' % (ids_in_order, EXPECTED_EVENT_ID_ORDER)
    types_in_order = [e.get('type') for e in events]
    assert types_in_order == EXPECTED_TYPE_ORDER, \
        'fixture type order %r does not match expected %r' % (types_in_order, EXPECTED_TYPE_ORDER)
    # ★Codex REVISE #2, item 1: the HANDOFF lap-21 expectation fact must be
    # present exactly once (on e10) and must match HANDOFF.md's recorded
    # numbers verbatim — an edit or deletion is a loader-rejected schema
    # violation, not a silent drift.
    assert len(handoff_expectation_events) == 1, \
        'expected exactly one event carrying handoff_expectation, got %d: %r' % (
            len(handoff_expectation_events), handoff_expectation_events)
    hx_eid, hx = handoff_expectation_events[0]
    assert hx_eid == 'e10', 'handoff_expectation must be carried by e10, found on %s' % hx_eid
    assert isinstance(hx, dict), '%s handoff_expectation must be an object' % hx_eid
    for key, expected_val in HANDOFF_LAP21_EXPECTATION.items():
        assert hx.get(key) == expected_val, \
            '%s handoff_expectation.%s = %r does not match HANDOFF.md-recorded %r' % (
                hx_eid, key, hx.get(key), expected_val)
    assert hx.get('source_class') == 'handoff_only', \
        '%s handoff_expectation.source_class must be handoff_only, got %r' % (hx_eid, hx.get('source_class'))
    assert hx.get('reference'), '%s handoff_expectation missing reference' % hx_eid
    return len(events)


# ══════════════════════════════════════════════════════════════════════
# Frame construction (external-boundary-only test doubles; production
# judgement — pit event creation, Plan A commit, BOX eligibility — is all
# real code inside poll_iracing()).
# ══════════════════════════════════════════════════════════════════════

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
    # ★Codex REVISE #1, item 4: bridge.py reads SessionFlags exactly at the
    # OnPitRoad True->False transition frame (bridge.py:5822-5914), not
    # aggregated across the whole stop. The exit frame used to hardcode
    # SessionFlags=0 regardless of `black_flag`, so a black-flag pit's own
    # bit was already gone by the one instant bridge.py actually reads it —
    # no product fix could ever have made the "known true" F03 case pass
    # against that input. Carry the same `flags` through to the exit frame.
    # ★Codex REVISE #3, item 2: this exact instant is also the visit's own
    # "observed SessionTime" that the F03 raw-authority target contract
    # (see the Acceptance F03 tests) must be able to source-bind to.
    exit_session_time = t
    frames.append(rh.make_frame(
        SessionTime=exit_session_time, Lap=lap, FuelLevel=fuel_after,
        OnPitRoad=False, Speed=22.0, LapDistPct=0.99, SessionFlags=flags,
        SessionLapsRemain=LAPS_TOTAL - lap, SessionLapsTotal=LAPS_TOTAL))
    t += 1.0
    return frames, fuel_after, t, exit_session_time


def unknown_flags_pit_visit(*, lap, fuel_before, fuel_added, start_time, dwell=5):
    """A pit visit where SessionFlags is never available at all (simulates the
    SDK var itself being unreadable), as opposed to a known value of 0
    (green). Used by the F03 "unknown must not be reported as false" assert
    (WO-001 §8 item 7), kept separate from `pit_visit()`'s known-true/known-
    green cases so the two are never conflated.
    """
    frames = []
    t = start_time
    for _ in range(2):
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap, FuelLevel=fuel_before,
            OnPitRoad=True, Speed=18.0, LapDistPct=0.95, SessionFlags=None,
            SessionLapsRemain=LAPS_TOTAL - lap, SessionLapsTotal=LAPS_TOTAL))
        t += 1.0
    for _ in range(dwell):
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap, FuelLevel=fuel_before,
            OnPitRoad=True, Speed=0.0, LapDistPct=0.96, SessionFlags=None,
            SessionLapsRemain=LAPS_TOTAL - lap, SessionLapsTotal=LAPS_TOTAL))
        t += 1.0
    fuel_after = fuel_before + fuel_added
    exit_session_time = t
    frames.append(rh.make_frame(
        SessionTime=exit_session_time, Lap=lap, FuelLevel=fuel_after,
        OnPitRoad=False, Speed=22.0, LapDistPct=0.99, SessionFlags=None,
        SessionLapsRemain=LAPS_TOTAL - lap, SessionLapsTotal=LAPS_TOTAL))
    t += 1.0
    return frames, fuel_after, t, exit_session_time


def build_red_thread_frames():
    """Assembles the frame list for fixture events e01, e05-e10.

    Driver-utterance events (e02-e04) and the delivery event (e11) are
    handled by the JS-side harness (tests-wo001-road-atlanta-fixture.js),
    not here — this file only drives the telemetry/pit/flag slice that
    `poll_iracing()` consumes.

    Returns (frames, pit_visit_times): the second element records each real
    pit visit's own exit-transition SessionTime (Codex REVISE #3, item 2),
    so the F03 Acceptance tests can assert `black_flag_evidence` binds its
    observed-instant marker to the SPECIFIC visit it describes.
    """
    frames, fuel, t, lap = clean_laps(14, start_fuel=60.0)
    pit1, fuel, t, pit1_exit_ts = pit_visit(lap=15, fuel_before=fuel, fuel_added=16.79, start_time=t)
    frames += pit1
    more, fuel, t, lap = clean_laps(1, start_lap=15, start_fuel=fuel, start_time=t)
    frames += more
    pit2, fuel, t, pit2_exit_ts = pit_visit(lap=16, fuel_before=fuel, fuel_added=0.0,
                                             start_time=t, black_flag=True)
    frames += pit2
    more2, fuel, t, lap = clean_laps(8, start_lap=16, start_fuel=fuel, start_time=t)
    frames += more2
    return frames, {'pit1_exit_session_time': pit1_exit_ts, 'pit2_exit_session_time': pit2_exit_ts}


class HarnessError(Exception):
    """Fixture/harness failure distinct from a finding reproduction.

    Per WO-001 §7: "fixture読込失敗、製品経路未到達、例外、timeout、必要な
    instrumentation欠落はfinding再現ではなくHARNESS_ERRORとし、characterization
    も失敗させる。"
    """


def run_scenario():
    """Runs the real poll loop once and derives every fact both modes need.

    Any unexpected exception here is a HARNESS_ERROR, not a finding.
    """
    try:
        frames, pit_visit_times = build_red_thread_frames()
        result = rh.replay(frames, session_info=ROAD_ATLANTA_SESSION_INFO)
    except rh.ReplayComplete:
        raise HarnessError('replay stopped before the scripted frames were exhausted')
    except Exception as exc:  # noqa: BLE001 - intentionally broad: harness boundary
        raise HarnessError('unexpected exception driving poll_iracing(): %r' % exc)

    decisions = result.logs_containing('DECISION opened')
    if not decisions:
        raise HarnessError('product code never reached Plan A commit '
                            '(reachability=not_reached for build_strategy_decision)')
    pit_facts = [json.loads(line.split('PIT EVENT FACT: ', 1)[1])
                 for line in result.logs_containing('PIT EVENT FACT:')]
    if len(pit_facts) != 2:
        raise HarnessError('expected exactly 2 real pit_event facts, got %d' % len(pit_facts))
    box_calls = result.by_trigger('strategy_plan_box_call')
    decision_line = decisions[0]
    decision_json = json.loads(decision_line.split('DECISION opened: ', 1)[1])
    session_info_events = [b for b in result.broadcasts if b.get('type') == 'session_info']
    if not session_info_events:
        raise HarnessError('product code never broadcast session_info '
                            '(reachability=not_reached for the Road Atlanta identity assert)')
    pit_timings = [b for b in result.broadcasts if b.get('type') == 'pit_timing']
    return {
        'result': result,
        'decision': decision_json,
        'pit_facts': pit_facts,
        'box_calls': box_calls,
        'session_info_events': session_info_events,
        'pit_timings': pit_timings,
        'pit_visit_times': pit_visit_times,
    }


def emit_trace(event_id, ev_type, source, harness_correlation_id, *,
               product_race_id=None, product_decision_id=None, product_pit_event_id=None,
               reachability='reached', harness_status='ok', finding='none',
               expected='', actual=''):
    sys.stdout.write(
        'SCENARIO_TRACE scenario_id=road_atlanta_build302_red_thread_v1 '
        'event_id=%s type=%s\n'
        'source=%s\n'
        'harness_correlation_id=%s\n'
        'product_race_id=%s product_decision_id=%s product_pit_event_id=%s\n'
        'reachability=%s harness_status=%s\n'
        'finding=%s\n'
        'expected=%s actual=%s\n'
        % (event_id, ev_type, source, harness_correlation_id,
           product_race_id, product_decision_id, product_pit_event_id,
           reachability, harness_status, finding, expected, actual))


def find_telemetry_live_at_lap(result, lap):
    """Last real `telemetry_live` broadcast observed at the given lap, or
    None. Used to read the REAL product's own fuel-strategy computation
    (bridge.py:7605-7701) rather than re-deriving it in test code."""
    matches = [b for b in result.broadcasts
               if b.get('type') == 'telemetry_live' and b.get('lap') == lap]
    return matches[-1] if matches else None


def find_pit_timing_by_fuel_added(pit_timings, fuel_added_l):
    """Codex REVISE #2, item 2: correlate a `pit_timing` broadcast to the
    SPECIFIC real pit visit it describes via the visit's own, independently
    fixture-chosen `fuel_added_l` (also cross-checked against the separate
    `pit_facts` list by test_pit_events_carry_no_race_identity_or_penalty_
    evidence), instead of trusting `pit_timings[N]` array position as a
    stand-in for source identity. Fails loudly if the correlation is not
    exactly one-to-one.
    """
    matches = [pt for pt in pit_timings if (pt.get('sample') or {}).get('fuel_added_l') == fuel_added_l]
    assert len(matches) == 1, (
        'expected exactly one pit_timing sample with sample.fuel_added_l=%r to '
        'source-correlate this assertion to one specific real pit visit; got %d'
        % (fuel_added_l, len(matches)))
    return matches[0]


# ══════════════════════════════════════════════════════════════════════
# characterization mode: current (buggy) HEAD behaviour, reproduced
# through real code. Expected to PASS on unmodified HEAD.
# ══════════════════════════════════════════════════════════════════════

class Characterization(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.doc = load_fixture()
        cls.scenario = run_scenario()

    def test_fixture_loader_validates_schema_and_provenance(self):
        n = validate_fixture(self.doc)
        self.assertGreaterEqual(n, 10)

    def test_no_external_paid_api_reachable(self):
        with open(rh.__file__, encoding='utf-8') as f:
            src = f.read()
        for forbidden in ('requests', 'urllib', 'http.client', 'socket',
                          'anthropic', 'texttospeech'):
            self.assertNotIn('import %s' % forbidden, src)

    def test_plan_a_committed_by_real_decision_function_not_injected(self):
        decision = self.scenario['decision']
        self.assertEqual(decision.get('selected_plan'), 'A')
        self.assertIsInstance(decision.get('target_lap'), int)
        emit_trace('e05', 'telemetry', 'synthetic_reconstruction',
                   'fixture-race-a/event-005',
                   product_decision_id=decision.get('decision_id'),
                   expected='Plan A committed via build_strategy_decision()',
                   actual='selected_plan=%s target_lap=%s' % (
                       decision.get('selected_plan'), decision.get('target_lap')))

    def test_road_atlanta_identity_reaches_session_broadcast_and_decision(self):
        """Codex REVISE #1, item 1: this fixture must actually run on Road
        Atlanta identity, not replay_harness.py's Monza default. Checks both
        ends of the connection: the real session_info parser's own OUTPUT
        (product code, not the fixture's input string) and the real
        decision_id's race_instance_id component, which resolve_race_instance_id()
        (bridge.py:1092) derives from the same SubSessionID via the real
        `poll_iracing()` path.
        """
        session_info_events = self.scenario['session_info_events']
        track = (session_info_events[0].get('data') or {}).get('track')
        self.assertEqual(track, ROAD_ATLANTA_TRACK_NAME,
                          'product-parsed session_info.track must reflect the '
                          'Road Atlanta SessionInfo this replay was given, not '
                          'a Monza default')
        decision_id = self.scenario['decision'].get('decision_id') or ''
        expected_prefix = 'sub:%d:' % ROAD_ATLANTA_SUB_SESSION_ID
        self.assertTrue(
            decision_id.startswith(expected_prefix),
            'decision_id %r must derive its race_instance_id from the fixture '
            'Road Atlanta SubSessionID (expected prefix %r)'
            % (decision_id, expected_prefix))
        emit_trace('e01', 'telemetry', 'synthetic_reconstruction',
                   'fixture-race-a/event-001',
                   product_race_id=decision_id.split(':decision-lap:', 1)[0],
                   expected='session_info.track=%r and decision_id prefix %r'
                            % (ROAD_ATLANTA_TRACK_NAME, expected_prefix),
                   actual='track=%r decision_id=%r' % (track, decision_id))

    def test_road_atlanta_lap21_target_and_fuel_margin_are_real_product_output(self):
        """Codex REVISE #1, item 6: HANDOFF's target lap 21 must be an
        actually-executed fixture input/output, not prose. This fixture's
        synthetic fuel burn (FUEL_PER_LAP) is tuned so the REAL
        build_strategy_decision() commits target_lap=21 from real fuel-
        strategy arithmetic (strategy_options.py:149-150), and the REAL
        lap-21 `telemetry_live` broadcast's own fuel_strategy (bridge.py:7696)
        is asserted directly.

        No raw log for the original incident exists in this repo (see the
        fixture's `_readme`), so HANDOFF's exact 18.14L/9.98L/8.16L figures
        stay `handoff_only` narrative reference (fixture e10 provenance) and
        are never asserted numerically equal to this fixture's own synthetic
        curve — only that the REAL product's own lap-21 computation agrees
        with HANDOFF's qualitative claim (a positive, i.e. safe, margin).
        """
        decision = self.scenario['decision']
        # WO-020 P0: lap 21 is the real opening builder's raw target (the incident's lap);
        # the committed Plan is the lap/frozen set the BOX authority accepted in the same
        # frame (logged by the Bridge), never a constant.
        aligned = [json.loads(l.split(': ', 1)[1]) for l in
                   self.scenario['result'].logs_containing('OPENING TARGET ALIGNED: ')]
        self.assertEqual(len(aligned), 1, 'opening Plan must be aligned to the authority once')
        self.assertEqual(aligned[0]['from_target_lap'], 21,
                          'this fixture\'s synthetic fuel inputs must make the '
                          'real opening builder propose lap 21, '
                          'matching HANDOFF\'s record of the real incident')
        self.assertEqual((decision.get('target_lap'), decision.get('set_fuel_l')),
                         (aligned[0]['target_lap'], aligned[0]['set_fuel_l']),
                         'committed Plan A is the authority-aligned target/frozen set')
        self.assertLessEqual(decision.get('target_lap'), aligned[0]['from_target_lap'])
        live = find_telemetry_live_at_lap(self.scenario['result'], 21)
        self.assertIsNotNone(live, 'no real telemetry_live broadcast observed at lap 21')
        fs = live.get('fuel_strategy') or {}
        self.assertIsInstance(fs.get('required_fuel_l'), (int, float),
                               'real fuel_strategy.required_fuel_l missing at lap 21: %r' % fs)
        self.assertIsInstance(fs.get('margin_l'), (int, float),
                               'real fuel_strategy.margin_l missing at lap 21: %r' % fs)
        self.assertGreater(
            fs['margin_l'], 0,
            'lap 21 target: the real product\'s own fuel margin must be positive '
            '(safe), matching HANDOFF\'s characterization that the stale box call '
            'at lap 21 was unjustified. Currently: margin_l=%s' % fs.get('margin_l'))
        emit_trace('e10', 'telemetry', 'synthetic_reconstruction',
                   'fixture-race-a/event-010',
                   product_decision_id=decision.get('decision_id'),
                   expected='builder target 21 -> authority-aligned committed target, '
                            'real lap-21 fuel_strategy.margin_l > 0',
                   actual='target_lap=%s fuel=%s required_fuel_l=%s margin_l=%s '
                          '(HANDOFF handoff_only reference: fuel 18.14L required '
                          '9.98L margin 8.16L, not asserted equal — see e10 provenance)'
                          % (decision.get('target_lap'), live.get('fuel'),
                             fs.get('required_fuel_l'), fs.get('margin_l')))

    def test_handoff_lap21_expectation_is_a_fixed_fact_separate_from_synthetic_observation(self):
        """Codex REVISE #2, item 1: HANDOFF.md's lap 21 numbers (18.14L /
        9.98L / 8.16L) must exist as a schema-enforced fact fixed to fixture
        e10 (validate_fixture() rejects a missing/changed handoff_expectation
        — see the dedicated negative-mutation test below), not merely live on
        in a provenance.note prose string. This test additionally proves the
        two value sets are genuinely kept separate: the fixture's own
        synthetic replay numbers are NOT equal to the HANDOFF expectation
        (if they were, a future implementer could not tell whether a passing
        test proved the real incident's numbers or just an accidental
        coincidence of the synthetic fuel curve).
        """
        events = load_fixture()['events']
        e10 = next(e for e in events if e['event_id'] == 'e10')
        hx = e10['handoff_expectation']
        self.assertEqual(hx, dict(HANDOFF_LAP21_EXPECTATION,
                                   source_class=hx['source_class'], reference=hx['reference']))
        self.assertEqual(hx['source_class'], 'handoff_only')
        live = find_telemetry_live_at_lap(self.scenario['result'], 21)
        fs = live.get('fuel_strategy') or {}
        self.assertNotEqual(
            fs.get('required_fuel_l'), hx['required_fuel_l'],
            'this fixture\'s synthetic lap-21 required_fuel_l coincides with the '
            'HANDOFF expectation value; tune FUEL_PER_LAP/LAPS_TOTAL so the two '
            'stay visibly distinct and are never mistaken for the same measurement')
        self.assertNotEqual(
            fs.get('margin_l'), hx['margin_l'],
            'this fixture\'s synthetic lap-21 margin_l coincides with the HANDOFF '
            'expectation value; the two must stay visibly distinct')
        emit_trace('e10', 'telemetry', 'handoff_only',
                   'fixture-race-a/event-010',
                   expected='handoff_expectation fact fixed to lap=21/fuel_l=18.14/'
                            'required_fuel_l=9.98/margin_l=8.16, distinct from synthetic observation',
                   actual='handoff_expectation=%r synthetic required_fuel_l=%s margin_l=%s'
                          % (hx, fs.get('required_fuel_l'), fs.get('margin_l')))

    def test_pit_events_now_carry_race_identity_and_penalty_evidence(self):
        """WO-003 (review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md WO-003 section
        6 item 5): the pit_event dict is now the serialized view of the
        canonical, immutable DriverPitEvent (irsdk-bridge/driver_pit_event.py),
        wired into bridge.py's real poll_iracing() pit-exit path. This test
        used to characterize the PRE-WO-003 absence of any identity/penalty
        field on pit_event (its old name/docstring referenced 'F07'); it is
        rewritten here to be a green regression over the CURRENT, now-
        authoritative behaviour, exactly mirroring how WO-002 REVISE 1 rewrote
        the two F03 characterization tests above instead of leaving a stale
        assertion that the fix does not exist. F01/F02/F06 characterization
        and all Acceptance findings are unchanged by this rewrite; WO-003 does
        not touch Plan terminal-state/BOX-call suppression (F01 is fixed by WO-007).
        """
        for fact in self.scenario['pit_facts']:
            self.assertIn('race_instance_id', fact)
            self.assertIn('pit_event_id', fact)
            self.assertIn('penalty_evidence', fact)
            self.assertIn('execution_relation', fact)
        self.assertEqual(self.scenario['pit_facts'][0]['fuel_added_l'], 16.79)
        self.assertEqual(self.scenario['pit_facts'][1]['fuel_added_l'], 0.0)
        # lap 15 (early declaration, no black flag) vs lap 16 (penalty pit,
        # black flag true) must be distinct events with sequence 1/2.
        self.assertEqual(self.scenario['pit_facts'][0]['driver_pit_sequence'], 1)
        self.assertEqual(self.scenario['pit_facts'][1]['driver_pit_sequence'], 2)
        self.assertNotEqual(self.scenario['pit_facts'][0]['pit_event_id'],
                             self.scenario['pit_facts'][1]['pit_event_id'])
        self.assertEqual(self.scenario['pit_facts'][0]['execution_relation'], 'early')
        self.assertEqual(self.scenario['pit_facts'][1]['execution_relation'], 'penalty')
        emit_trace('e07', 'pit_exit', 'repository_evidence',
                   'fixture-race-a/event-007',
                   product_pit_event_id=self.scenario['pit_facts'][0]['pit_event_id'],
                   finding='none',
                   expected='pit_event carries race_instance_id/pit_event_id/penalty_evidence/execution_relation',
                   actual='pit_event keys=%s' % sorted(self.scenario['pit_facts'][0].keys()))

    def test_F01_old_decision_produces_zero_box_calls_after_real_pits(self):
        self.assertEqual(self.scenario['box_calls'], [])
        self.assertEqual(len(self.scenario['result'].logs_containing('PLAN LIFECYCLE PIT:')), 2)

    def test_F03_black_flag_bit_is_recognized_via_the_authoritative_source_bound_module(self):
        """WO-002 REVISE 1, item 2 (review/PITWALL_SHARED_WORKING_LOG.md
        2026-09-23 "WO-002実装後独立確認 REVISE 1"): F03 is now product-fixed
        (irsdk-bridge/authoritative_race_facts.py, wired into bridge.py's
        poll_iracing()). This test used to characterize the PRE-fix absence
        of any black-flag recognition; it is rewritten here to be a green
        regression over the CURRENT, now-authoritative behaviour instead of a
        stale assertion that the fix does not exist. F01/F02/F06
        characterization and all four Acceptance findings (F01 red; F03 x3
        green) are unchanged by this rewrite.
        """
        with open(os.path.join(HERE, 'bridge.py'), encoding='utf-8') as f:
            bridge_src = f.read()
        self.assertIn('import authoritative_race_facts', bridge_src,
                       'bridge.py must delegate black-flag authority to the single-owner module')
        race_facts_path = os.path.join(HERE, 'authoritative_race_facts.py')
        with open(race_facts_path, encoding='utf-8') as f:
            race_facts_src = f.read()
        self.assertIn('0x00010000', race_facts_src,
                       'the black-flag bit constant must live in the authoritative module')
        # Functional side: the penalty-pit frames (SessionFlags=0x00010000)
        # now produce a distinguishable, source-bound trace, not an ordinary
        # green-flag stop.
        pit_timings = self.scenario['pit_timings']
        penalty_sample = find_pit_timing_by_fuel_added(pit_timings, 0.0).get('sample') or {}
        evidence = penalty_sample.get('black_flag_evidence') or {}
        self.assertEqual(evidence.get('state'), 'true')
        self.assertEqual(evidence.get('authority'), 'iRacing SessionFlags')
        self.assertEqual(evidence.get('raw_value'), BLACK_FLAG_BIT)
        emit_trace('e08', 'flag', 'synthetic_reconstruction',
                   'fixture-race-a/event-008',
                   finding='none',
                   expected='black flag bit recorded as an authoritative non-false state',
                   actual='authoritative_race_facts.classify_black_flag() reports state=%r '
                          'raw_value=0x%08x via bridge.py poll_iracing()'
                          % (evidence.get('state'), evidence.get('raw_value') or 0))

    def test_F03_known_true_black_flag_pit_sample_carries_source_bound_evidence(self):
        """Codex REVISE #1, item 4 / REVISE #2, item 2 (characterization
        original design), rewritten per WO-002 REVISE 1, item 2 into a green
        regression: the penalty-pit sample (its own frames carried
        SessionFlags=0x00010000) now carries a `black_flag_evidence` object
        that is source-bound to that SPECIFIC visit — correlated via its own
        fuel_added_l=0.0 (not `pit_timings[1]` array position — see
        find_pit_timing_by_fuel_added()) — and does not also mark the OTHER
        real pit in the same run (fuel_added_l=16.79, no black-flag bit in
        its own frames) as true.
        """
        pit_timings = self.scenario['pit_timings']
        self.assertEqual(len(pit_timings), 2, 'expected exactly 2 real pit_timing broadcasts')
        penalty_sample = find_pit_timing_by_fuel_added(pit_timings, 0.0).get('sample') or {}
        real_pit_sample = find_pit_timing_by_fuel_added(pit_timings, 16.79).get('sample') or {}
        self.assertEqual(
            penalty_sample.get('caution_state'), 'green',
            'unrelated field: 0x00010000 (black flag) must not also set the separate '
            '0xC000 (yellow/caution) bits this fixture never asserts: %r' % penalty_sample)
        evidence = penalty_sample.get('black_flag_evidence') or {}
        self.assertEqual(evidence.get('state'), 'true')
        self.assertEqual(evidence.get('source_visit_fuel_added_l'), 0.0)
        other_evidence = real_pit_sample.get('black_flag_evidence') or {}
        self.assertNotEqual(other_evidence.get('state'), 'true',
                             'the other real pit (no black-flag bit in its own frames) '
                             'must not also report true: %r' % other_evidence)

    def test_F06_pit_declaration_is_misrouted_by_the_real_router(self):
        router_path = os.path.join(ROOT, 'desktop', 'local-intent-router.js')
        with open(router_path, encoding='utf-8') as f:
            src = f.read()
        # The exact regex this characterization depends on (see also the JS
        # harness's reachability probe on the same line).
        self.assertIn('入る|行く|どう|べき|判断', src)
        emit_trace('e03', 'driver_utterance', 'handoff_only',
                   'fixture-race-a/event-003',
                   finding='F06',
                   expected='"ピット入るぞ" recognized as an execution declaration',
                   actual='matched by strategyCallKind "recommendation" regex '
                          '(desktop/local-intent-router.js:202); JS harness runs the real router')

    def test_reachability_plan_a_commit_depends_on_real_decide_function(self):
        """Mutation-style reachability probe: break the real decision function,
        confirm the characterization result flips from reproduced to not-reached.
        """
        original = bridge.decide_plan_at_target

        def poisoned(*args, **kwargs):
            # selected_plan='B' forces build_strategy_decision() into
            # mode='propose' (only 'A' ever commits immediately — see
            # bridge.py: "return {'mode': 'commit' if selected == 'A' else
            # 'propose', ...}"), so active_decision_plan is never set and no
            # 'DECISION opened' log can appear.
            return {'selected_plan': 'B', 'reason': 'probe_disabled'}

        bridge.decide_plan_at_target = poisoned
        try:
            frames, _pit_visit_times = build_red_thread_frames()
            result = rh.replay(frames)
        finally:
            bridge.decide_plan_at_target = original
        self.assertNotIn(True, [bool(l) for l in result.logs_containing('DECISION opened')] or [False],
                          'poisoning decide_plan_at_target must suppress DECISION opened')
        self.assertEqual(len(result.logs_containing('DECISION opened')), 0)

    def test_reachability_box_call_depends_on_real_speech_block_gate(self):
        """Mutation-style reachability probe on the BOX-call connection itself:
        force strategy_speech_blocked() True and confirm the box call the
        F01 test depends on disappears.
        """
        import session_race_state as srs_mod
        original = srs_mod.strategy_speech_blocked
        srs_mod.strategy_speech_blocked = lambda *a, **k: True
        try:
            frames, _pit_visit_times = build_red_thread_frames()
            result = rh.replay(frames)
        finally:
            srs_mod.strategy_speech_blocked = original
        self.assertEqual(len(result.by_trigger('strategy_plan_box_call')), 0,
                          'forcing strategy_speech_blocked=True must suppress the box call '
                          'that test_F01_old_decision_still_fires_box_call_after_real_pits relies on')

    def test_reachability_pit_events_depend_on_real_onpitroad_transitions(self):
        """Reachability probe on the Bridge-poll pit-processing connection:
        replay the SAME frame count/shape but with OnPitRoad never asserted
        True, and confirm the real loop produces 0 pit_event facts instead
        of 2 — proving test_pit_events_carry_no_race_identity_or_penalty_evidence
        and the F01/F07 tests genuinely depend on real OnPitRoad-transition
        detection inside poll_iracing(), not a coincidence of frame count.
        """
        frames, fuel, t, lap = clean_laps(14, start_fuel=60.0)
        # Same lap range and frame count as the real scenario's two pit
        # visits, but OnPitRoad stays False throughout (no pit_visit()).
        more, fuel, t, lap = clean_laps(2, start_lap=15, start_fuel=fuel, start_time=t)
        frames += more
        more2, fuel, t, lap = clean_laps(8, start_lap=17, start_fuel=fuel, start_time=t)
        frames += more2
        result = rh.replay(frames)
        pit_facts = result.logs_containing('PIT EVENT FACT:')
        self.assertEqual(len(pit_facts), 0,
                          'without a real OnPitRoad transition, no pit_event should be created')

    def test_harness_error_is_not_misclassified_as_a_finding(self):
        """A reader that raises mid-poll must surface as HARNESS_ERROR, never
        as a (false) finding reproduction or a (false) acceptance pass.
        """
        class ExplodingReader(rh.FakeReader):
            def is_active(self):
                if self.cursor >= 2:
                    raise RuntimeError('simulated unexpected harness fault')
                return super().is_active()

        frames = [rh.make_frame(SessionTime=float(i)) for i in range(10)]
        fake = ExplodingReader(frames)
        original = {'reader': bridge.reader, 'broadcast': bridge.broadcast,
                    'log': bridge.log, 'time': bridge.time}
        bridge.reader = fake
        bridge.broadcast = lambda ev: True
        bridge.log = lambda msg: None
        bridge.time = rh._ReplayClock(fake)
        status = 'ok'
        try:
            bridge.poll_iracing()
            status = 'no_exception_raised_unexpectedly'
        except RuntimeError:
            status = 'HARNESS_ERROR'
        except rh.ReplayComplete:
            status = 'no_exception_raised_unexpectedly'
        finally:
            bridge.reader = original['reader']
            bridge.broadcast = original['broadcast']
            bridge.log = original['log']
            bridge.time = original['time']
        self.assertEqual(status, 'HARNESS_ERROR')
        emit_trace('harness-probe', 'telemetry', 'synthetic_reconstruction',
                   'fixture-race-a/harness-error-probe',
                   reachability='not_reached', harness_status='HARNESS_ERROR', finding='none',
                   expected='unexpected exceptions are tagged HARNESS_ERROR, never a finding',
                   actual=status)


# ══════════════════════════════════════════════════════════════════════
# acceptance mode: target (fixed) behaviour. EXPECTED TO FAIL on
# unmodified HEAD — that failure is this WO's required deliverable.
# Each finding is asserted independently (WO-001 §8 item 8).
# ══════════════════════════════════════════════════════════════════════

class Acceptance(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.scenario = run_scenario()

    def test_F01_old_decision_produces_zero_box_calls_after_real_pits(self):
        box_calls = self.scenario['box_calls']
        decision_id = self.scenario['decision']['decision_id']
        stale = [b for b in box_calls if b.get('decision_id') == decision_id]
        self.assertEqual(len(stale), 0,
                          'F01 target: a decision whose plan already pitted (real + penalty) '
                          'must never box-call again. Currently: %d such call(s).' % len(stale))

    def test_F03_known_true_black_flag_state_is_authoritative_and_source_bound(self):
        """WO-001 §8 item 7, first half, rewritten for Codex REVISE #2, item 2,
        extended for Codex REVISE #3, item 2.

        Target contract (this test's own design placeholder for the
        not-yet-implemented product field, same caveat as the prior round's
        note: the structural requirement — source-bound, not merely a
        string/array-position match — is what matters, not this exact field
        name): each `pit_timing.sample` carries a `black_flag_evidence`
        object `{state, source_visit_fuel_added_l, freshness, authority,
        raw_value, observed_session_time}`.

        Source-bound: the assertion is tied to the visit whose OWN frames
        carried SessionFlags=0x00010000, correlated via that visit's
        independently-fixed fuel_added_l=0.0 (find_pit_timing_by_fuel_added),
        not `pit_timings[1]` array position. The OTHER real pit in the SAME
        run (fuel_added_l=16.79, no black-flag bit in its own frames) is
        asserted NOT true, proving a globally-true or positionally-true
        implementation would fail this test even though it might pass a
        single-sample check.

        Codex REVISE #3, item 2: `state` alone is not proof of authority — a
        product could report "true" from a heuristic (e.g. "fuel_added_l==0
        implies black flag") instead of the raw SDK bit. The evidence must
        additionally name its raw authority/source, carry the raw SessionFlags
        integer this visit's own exit-transition frame produced
        (BLACK_FLAG_BIT, not a derived boolean), and record the observed
        SessionTime of that SAME frame (bridge.py:5914's read instant),
        cross-checked here against the exact SessionTime this fixture's own
        `pit_visit(black_flag=True)` call produced for its exit frame.
        """
        pit_timings = self.scenario['pit_timings']
        self.assertEqual(len(pit_timings), 2, 'expected exactly 2 real pit_timing broadcasts')
        penalty_sample = find_pit_timing_by_fuel_added(pit_timings, 0.0).get('sample') or {}
        real_pit_sample = find_pit_timing_by_fuel_added(pit_timings, 16.79).get('sample') or {}
        evidence = penalty_sample.get('black_flag_evidence') or {}
        self.assertEqual(
            evidence.get('state'), 'true',
            'F03 target: the penalty-pit sample (source frames carried '
            'SessionFlags=0x00010000) must expose black_flag_evidence.state="true". '
            'Currently: %r' % penalty_sample)
        self.assertEqual(
            evidence.get('source_visit_fuel_added_l'), 0.0,
            'F03 target: black_flag_evidence must identify the SAME visit it '
            'describes (its own fuel_added_l), not merely occupy array position 1. '
            'Currently: %r' % evidence)
        self.assertEqual(
            evidence.get('freshness'), 'fresh',
            'F03 target: evidence must be read fresh from this visit\'s own frames. '
            'Currently: %r' % evidence)
        self.assertEqual(
            evidence.get('authority'), 'iRacing SessionFlags',
            'F03 target: black_flag_evidence must name its raw authority/source '
            '("iRacing SessionFlags"), not a state derived from an unrelated fact '
            '(e.g. fuel_added_l==0). Currently: %r' % evidence)
        self.assertEqual(
            evidence.get('raw_value'), BLACK_FLAG_BIT,
            'F03 target: black_flag_evidence must carry the raw SessionFlags integer '
            '(0x%08x) this visit\'s own exit frame produced, not merely a derived '
            'boolean state. Currently: %r' % (BLACK_FLAG_BIT, evidence))
        expected_session_time = self.scenario['pit_visit_times']['pit2_exit_session_time']
        self.assertEqual(
            evidence.get('observed_session_time'), expected_session_time,
            'F03 target: black_flag_evidence must record the observed SessionTime '
            '(%r) of THIS visit\'s own exit-transition frame, the same instant '
            'bridge.py reads SessionFlags, not omit it or misattribute another '
            'visit\'s time. Currently: %r' % (expected_session_time, evidence))
        other_evidence = real_pit_sample.get('black_flag_evidence') or {}
        self.assertNotEqual(
            other_evidence.get('state'), 'true',
            'F03 target: the OTHER real pit in the same run (fuel_added_l=16.79, no '
            'black-flag bit in its own frames) must NOT also report true — a '
            'globally/positionally-true implementation must fail this assert. '
            'Currently: %r' % other_evidence)

    def test_F03_unknown_black_flag_state_is_never_reported_as_false(self):
        """WO-001 §8 item 7, second half. A separate assert from the known-true
        case above. When the SessionFlags SDK var is unavailable during a pit
        stop, the resulting state must be reported as unknown, never silently
        coerced to a known-false/green value (bridge.py:5914's
        `reader.read_int('SessionFlags') or 0` currently collapses "SDK var
        unavailable" and "SDK var reports 0" into the same green result).
        Codex REVISE #2, item 2: also assert the structured evidence's
        freshness is not fabricated as "fresh" when no real evidence exists.
        Codex REVISE #3, item 2: also assert the raw authority/value/observed-
        time fields do not fabricate certainty either — raw_value must be
        None (the SDK var itself was unreadable, distinct from a real read of
        0), while the authority name and this visit's own observed
        SessionTime must still be reported (an unknown STATE is not an excuse
        to omit WHEN and via WHAT source the unknown was observed)."""
        frames, fuel, t, lap = clean_laps(3, start_fuel=60.0)
        pit_frames, _, _, exit_ts = unknown_flags_pit_visit(
            lap=lap, fuel_before=fuel, fuel_added=5.0, start_time=t)
        result = rh.replay(frames + pit_frames, session_info=ROAD_ATLANTA_SESSION_INFO)
        pit_timings = [b for b in result.broadcasts if b.get('type') == 'pit_timing']
        self.assertEqual(len(pit_timings), 1, 'expected exactly 1 isolated pit stop for this probe')
        sample = pit_timings[0].get('sample') or {}
        evidence = sample.get('black_flag_evidence') or {}
        self.assertNotEqual(
            evidence.get('state'), 'false',
            'F03 target: SessionFlags unavailable must not be reported as a '
            'known-false black flag state. Currently: %r' % evidence)
        self.assertEqual(
            evidence.get('state'), 'unknown',
            'F03 target: SessionFlags unavailable must be reported as unknown. '
            'Currently: %r' % evidence)
        self.assertNotEqual(
            evidence.get('freshness'), 'fresh',
            'F03 target: with no real SessionFlags evidence, freshness must not be '
            'fabricated as "fresh". Currently: %r' % evidence)
        self.assertEqual(
            evidence.get('authority'), 'iRacing SessionFlags',
            'F03 target: even an unknown state must still name the authority it '
            'attempted to read from. Currently: %r' % evidence)
        self.assertIsNone(
            evidence.get('raw_value'),
            'F03 target: raw_value must be None when the SDK var itself was '
            'unreadable, never fabricated as 0 (a real known-false read) or the '
            'black-flag bit. Currently: %r' % evidence)
        self.assertEqual(
            evidence.get('observed_session_time'), exit_ts,
            'F03 target: even an unknown SessionFlags read must record the '
            'observed_session_time (%r) of this visit\'s own exit-transition frame '
            '— SessionTime is a separate, always-available SDK var. Currently: %r'
            % (exit_ts, evidence))

    def test_F03_known_false_after_known_true_is_not_stale_carried_over(self):
        """Codex REVISE #2, item 2, freshness half: a pit visit with a KNOWN
        black flag followed by a LATER pit visit whose own frames carry a
        known-false (green) SessionFlags must not inherit/carry over the
        earlier visit's true state. This is a separate isolated replay (not
        the shared red-thread scenario) so a naive "latch true forever once
        seen" implementation is caught even though it might otherwise pass
        the single-visit known-true/unknown tests above.

        Codex REVISE #3, item 2: also assert the later visit's raw_value is
        the later visit's OWN raw SessionFlags read (0, not the earlier
        visit's BLACK_FLAG_BIT) and its observed_session_time is the later
        visit's OWN exit-frame instant, not the earlier visit's — proving a
        raw-value/authority pair, not just the derived `state`/`freshness`
        strings, is source-bound to the correct visit.
        """
        frames, fuel, t, lap = clean_laps(3, start_fuel=60.0)
        pit1, fuel, t, pit1_exit_ts = pit_visit(lap=lap, fuel_before=fuel, fuel_added=5.0,
                                                 start_time=t, black_flag=True)
        frames += pit1
        more, fuel, t, lap = clean_laps(2, start_lap=lap, start_fuel=fuel, start_time=t)
        frames += more
        pit2, fuel, t, pit2_exit_ts = pit_visit(lap=lap, fuel_before=fuel, fuel_added=7.0,
                                                 start_time=t, black_flag=False)
        frames += pit2
        result = rh.replay(frames, session_info=ROAD_ATLANTA_SESSION_INFO)
        pit_timings = [b for b in result.broadcasts if b.get('type') == 'pit_timing']
        self.assertEqual(len(pit_timings), 2, 'expected exactly 2 isolated pit stops for this freshness probe')
        later_sample = find_pit_timing_by_fuel_added(pit_timings, 7.0).get('sample') or {}
        evidence = later_sample.get('black_flag_evidence') or {}
        self.assertNotEqual(
            evidence.get('state'), 'true',
            'F03 target: a later, fresh known-false pit must not inherit the '
            'earlier pit\'s true state. Currently: %r' % evidence)
        self.assertEqual(
            evidence.get('freshness'), 'fresh',
            'F03 target: the later pit\'s own reading must itself be reported as '
            'fresh, not stale-carried from the earlier visit. Currently: %r' % evidence)
        self.assertEqual(
            evidence.get('raw_value'), 0,
            'F03 target: raw_value must be the LATER visit\'s own raw SessionFlags '
            'read (0), not carried over from the earlier visit\'s BLACK_FLAG_BIT '
            '(0x%08x) or fabricated as None. Currently: %r' % (BLACK_FLAG_BIT, evidence))
        self.assertNotEqual(
            evidence.get('observed_session_time'), pit1_exit_ts,
            'F03 target: observed_session_time must not be the EARLIER visit\'s '
            'exit-frame instant (%r) stale-carried forward. Currently: %r'
            % (pit1_exit_ts, evidence))
        self.assertEqual(
            evidence.get('observed_session_time'), pit2_exit_ts,
            'F03 target: observed_session_time must be THIS later visit\'s own '
            'exit-transition frame instant (%r). Currently: %r' % (pit2_exit_ts, evidence))


class FixtureSchemaNegativeMutation(unittest.TestCase):
    """Codex REVISE #2, item 4: dedicated negative-mutation tests proving the
    loader REJECTS an event-order swap, a duplicated harness_correlation_id,
    a changed scenario_id, and a duplicated product_identity value — not
    merely that it accepts a well-formed fixture. Operates entirely on an
    in-memory `copy.deepcopy()` of the loaded fixture; never writes to disk.
    Runs in both characterization and acceptance mode (schema validity is not
    a mode-dependent product behaviour).
    """

    @classmethod
    def setUpClass(cls):
        cls.doc = load_fixture()

    def test_event_order_swap_is_rejected(self):
        mutated = copy.deepcopy(self.doc)
        mutated['events'][0], mutated['events'][1] = mutated['events'][1], mutated['events'][0]
        with self.assertRaises(AssertionError):
            validate_fixture(mutated)

    def test_duplicate_harness_correlation_id_is_rejected(self):
        mutated = copy.deepcopy(self.doc)
        mutated['events'][1]['harness_correlation_id'] = mutated['events'][0]['harness_correlation_id']
        with self.assertRaises(AssertionError):
            validate_fixture(mutated)

    def test_empty_harness_correlation_id_is_rejected(self):
        mutated = copy.deepcopy(self.doc)
        mutated['events'][0]['harness_correlation_id'] = ''
        with self.assertRaises(AssertionError):
            validate_fixture(mutated)

    def test_scenario_id_change_is_rejected(self):
        mutated = copy.deepcopy(self.doc)
        mutated['scenario_id'] = 'some_other_scenario_id'
        with self.assertRaises(AssertionError):
            validate_fixture(mutated)

    def test_repeated_consistent_product_identity_value_is_accepted(self):
        """Codex REVISE #3, item 1: the same non-null decision_id (and its
        consistently-paired race_instance_id) legitimately reappearing on a
        later event — e.g. e05's Plan A commit correlating to e10's BOX
        outcome — is the normal longitudinal correlation WO-001 exists to
        prove, and must be ACCEPTED, not rejected as a duplicate.
        """
        mutated = copy.deepcopy(self.doc)
        for eid in ('e05', 'e10'):
            ev = next(e for e in mutated['events'] if e['event_id'] == eid)
            ev['product_identity']['decision_id'] = 'decision-1'
            ev['product_identity']['race_instance_id'] = 'race-1'
        self.assertGreaterEqual(validate_fixture(mutated), 10)

    def test_contradictory_product_identity_mapping_is_rejected(self):
        """Codex REVISE #3, item 1: unlike a repeated-but-consistent value
        (see the accept test above), the SAME decision_id attributed to TWO
        DIFFERENT race_instance_id values across events is a genuine identity
        contradiction and must be rejected.
        """
        mutated = copy.deepcopy(self.doc)
        e05 = next(e for e in mutated['events'] if e['event_id'] == 'e05')
        e10 = next(e for e in mutated['events'] if e['event_id'] == 'e10')
        e05['product_identity']['decision_id'] = 'decision-1'
        e05['product_identity']['race_instance_id'] = 'race-1'
        e10['product_identity']['decision_id'] = 'decision-1'
        e10['product_identity']['race_instance_id'] = 'race-2'
        with self.assertRaises(AssertionError):
            validate_fixture(mutated)

    def test_non_string_product_identity_value_is_rejected(self):
        mutated = copy.deepcopy(self.doc)
        mutated['events'][5]['product_identity']['pit_event_id'] = 12345
        with self.assertRaises(AssertionError):
            validate_fixture(mutated)

    def test_missing_handoff_expectation_is_rejected(self):
        mutated = copy.deepcopy(self.doc)
        e10 = next(e for e in mutated['events'] if e['event_id'] == 'e10')
        del e10['handoff_expectation']
        with self.assertRaises(AssertionError):
            validate_fixture(mutated)

    def test_changed_handoff_expectation_value_is_rejected(self):
        mutated = copy.deepcopy(self.doc)
        e10 = next(e for e in mutated['events'] if e['event_id'] == 'e10')
        e10['handoff_expectation']['margin_l'] = 999.0
        with self.assertRaises(AssertionError):
            validate_fixture(mutated)

    def test_unmutated_fixture_still_validates(self):
        # Sanity control: the mutation helpers above must be exercising a
        # real failure mode, not a validator that rejects everything.
        self.assertGreaterEqual(validate_fixture(copy.deepcopy(self.doc)), 10)


def _run(mode):
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    # FixtureSchemaNegativeMutation is not a mode-dependent product-behaviour
    # finding; it must pass in both modes.
    suite.addTests(loader.loadTestsFromTestCase(FixtureSchemaNegativeMutation))
    suite.addTests(loader.loadTestsFromTestCase(
        Characterization if mode == 'characterization' else Acceptance))
    runner = unittest.TextTestRunner(verbosity=2)
    res = runner.run(suite)
    return 0 if res.wasSuccessful() else 1


if __name__ == '__main__':
    sys.stdout.write('WO-001 road-atlanta fixture — mode=%s\n' % MODE)
    try:
        code = _run(MODE)
    except HarnessError as exc:
        sys.stdout.write('HARNESS_ERROR: %s\n' % exc)
        code = 1
    sys.exit(code)
