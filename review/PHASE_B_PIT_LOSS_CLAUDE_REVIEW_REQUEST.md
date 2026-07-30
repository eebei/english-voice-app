# Phase B Pit Loss Calibration — Claude Independent Review Request

## Review mode

Read-only independent review. Do not edit, commit, push, build, deploy, or publish.
Report P0/P1/P2 with `file:line` evidence. Verify every contract below.

## Scope

- `irsdk-bridge/pit_loss_calibrator.py`
- `irsdk-bridge/tests_pit_loss_calibrator.py`
- `irsdk-bridge/tests_pit_loss_wiring.py`
- Phase B changes in `irsdk-bridge/bridge.py`
- Phase B additions in `preflight.sh`

## Product objective

Replace the old opaque average of total pit-lane seconds with observed pit loss:

`observed_loss_s = lane_total_s - normal_segment_s`

The normal segment must be the driver's clean on-track traversal between the
same learned pit-entry and pit-exit coordinates. Collection must be automatic.

## Acceptance contracts

1. Bridge-side JSON under persistent `%APPDATA%/OMORAY-PITWALL` is the source of truth.
2. Pit entry and exit `LapDistPct` are learned from genuine `OnPitRoad` edges.
3. Normal segment timing uses the same coordinates, supports S/F wrap, and rejects reverse/teleport ticks.
4. A normal segment is discarded if the car enters pit road, leaves the track, changes session, or has invalid duration.
5. Pit samples contain track, car model, entry/exit pct, lane total, stall, fuel added, tyre-service state, repair, caution, timestamp, and calculator version.
6. Repair, long-stop, and drive-through samples are classified separately and excluded from calibration statistics.
7. Unverified tyre service is `unknown`; it is never inferred from duration.
8. Fewer than 3 valid pit samples or fewer than 3 normal samples stays `low` and `prediction_ready=false`.
9. At 3+ usable samples, median and Q1/Q3 are returned; a simple mean must not be used.
10. Each calibration pit sample remains `normal_segment_s=null` and `observed_loss_s=null` until a measured normal baseline exists.
11. Persistence is bounded and atomic (`.tmp` + `os.replace`).
12. `pit_loss_calibration` remains allowed during `INACTIVE_DRIVER` because it is metadata, not driver-directed speech.
13. Existing pit radio, countdown, session authority, fuel, handoff, and Cost Telemetry behavior is unchanged.
14. `./preflight.sh` is all green.

## Mutation / failure scenarios to inspect

- Change `usable >= 3` to `>= 2`: tests must fail.
- Include `classification=repair` in statistics: tests must fail.
- Remove modulo wrap handling: tests must fail.
- Allow a large reverse/teleport step: tests must fail.
- Replace median with mean: the fixture should detect the mutation.
- Delete normal-segment runtime wiring: wiring test must fail.
- JSON is corrupt or absent: startup must fail open with an empty calibration store.
- Disk write fails: bridge loop must not crash (verify call-site exception behavior).

## Known evidence from 2026-07-29 IMSA Fixed Monza logs

- Lane totals observed: approximately 31.3s, 27.0s, 33.3s.
- Moving lane components inferred manually: approximately 24.3s, 24.0s, 23.3s.
- These logs establish that lane timing exists, but do not contain a precise
  same-coordinate normal segment. The implementation must not backfill one by guess.

## Required conclusion format

- Contract table 1–14: verify / fail / unverified with `file:line`.
- P0/P1/P2 findings with concrete failure scenarios and minimum fixes.
- Explicitly list real-iRacing items that remain unverified until the next run.
- Do not decide approval; that remains Yuji's decision.
