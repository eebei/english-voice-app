# Build 281 — 2026-08-24 field-failure correction review

## Scope

This is a targeted correction of Build 280 field failures from:

- `/Users/yuji.s/Downloads/OMORAY-bridge-debug-20260824-1236.log`

`20260824-1234.log` is only the updater transition from Build 279 and is not
the race trace. The live session begins as Build 280 in `1236.log`.

## Field facts to preserve

1. **Rear-gap PTT had Bridge evidence but replied unavailable.**
   At 13:11:28, 13:18:30, 13:27:27 and 13:29:43, the caller asked for rear
   gap while the live snapshot contained `gap_behind` (for example 1.7, 2.4,
   and 8.4 seconds). The UI emitted `unresolved_operational` and
   `そのGAPは確認できない。` instead.
2. **Truth Gate then degraded valid gap claims to `了解。`.**
   It correctly blocked LLM-generated vehicle numbers but lacked a nearest-gap
   factual fallback.
3. **The early pit was not a verified undercut.**
   Plan A was selected; Plan B remained conditions-unproven. A -0.025L
   projected post-stop margin triggered `planned_service_cannot_finish` at
   Lap 6 even though the selected Lap-16 target remained reachable.
4. **Debrief invented the pit lap.**
   It said Lap 15, then Lap 16. The actual entry event in the trace was Lap 6.
5. **No stopped-car radio was delivered.**
   A `danger` candidate was dropped as P3 by a PB P2 call. A stopped vehicle
   must remain P0; forward danger cannot be ducked by a lap-time/PB call.

## Implemented changes

### 1. GAP authority path

- `desktop/renderer.html`: local Bridge-fact router now runs **before** any
  active `evidenceDebrief` branch. A stale debrief cannot intercept live race
  PTT.
- Added `LOCAL_INTENT_BYPASS` trace with debrief state when a live race utterance
  is intentionally not handled locally.
- `telemetryTruthFallback()` now rebuilds requested front/rear/both nearest
  gaps from the current Bridge snapshot rather than ending at `了解。`.

### 2. Fuel-plan P0 guard

- `irsdk-bridge/plan_fuel_authority.py`: a post-stop miss up to 0.5L is a
  deterministic service top-up / whole-litre-setting correction, not an early
  `box this lap` emergency.
- It returns `recommended_add_l` and `recommended_set_fuel_l`, keeps the
  selected pit target, writes that correction back into the selected live plan
  for the dashboard/later box call, and only preserves early P0 for a true
  inability to reach the selected pit window or an unexecutable plan.

### 3. Debrief pit facts

- `irsdk-bridge/bridge.py`: records each completed pit visit as a structured
  event (entry/exit laps, positions, fuel added, lane and stall time) and
  includes events in `session_summary`.
- `desktop/renderer.html`: injects current-race Bridge pit facts into the
  conversational contract. Without a recorded fact, it may not infer or
  correct a pit lap. It must not call an undercut successful unless rival pit
  cycles were actually recorded.

### 4. Hazard priority

- `danger` is P1, so it cannot be ducked by P2 PB/lap calls.
- `stopped_ahead` remains P0. This change does **not** yet add a generic
  moving off-track call: that needs a return-to-racing-line/proximity contract
  to avoid unsafe radio spam.

## Required reviewer checks

1. Can any `evidenceDebrief`/manual-review path still intercept a race PTT
   before local GAP authority?
2. Does the small-top-up rule ever suppress a genuine fuel emergency? The
   only intended relaxation is a negative post-stop margin no worse than 0.5L
   while the target pit remains reachable and capacity fits.
3. Are pit events reset correctly on session boundary and preserved through
   race summary dispatch?
4. Is promoting generic `danger` to P1 acceptable, or should the bridge split
   forward danger into its own P1 trigger while keeping rear danger lower?
5. Confirm existing tests do not merely unit-test helpers: Build 281 adds the
   real 8/24 GAP values and the exact early-pit input to replay regressions.

## Test evidence (local, no external model calls)

- All `tests-*.js`: passed.
- Python: `python3 -m unittest discover -s irsdk-bridge -p 'tests_*.py'`:
  **261 passed**.
- Targeted:
  - `tests-local-intent-router.js`: **30/30**
  - `tests-telemetry-truth-gate.js`: **56/56**
  - `irsdk-bridge/tests_plan_fuel_authority.py`: **19/19**

No commit, push, installer build, or public deployment has been performed.
