# Phase A–B integration — Claude independent review request

Date: 2026-07-26
Worktree: `/Users/yuji.s/Desktop/Claude/english-voice-app`
Status: uncommitted; commit/push/merge/EXE build prohibited

## Integrated scope

- Unit E0 v3: driver handoff / inactive-driver suppression
- Unit 1: overall-leader wall-clock Final Lap and sole Last 5/3/1 path
- Unit 2: endurance fuel-to-finish in litres with safe/tight/critical bands
- Unit 3: authoritative current track/car model/session identity

The user-owned untracked `PITWALL_発話種別一覧.txt` is intentionally untouched
and out of scope.

## Critical merge contract

1. E0 `broadcast()` remains tri-state:
   `DISPATCHED / HELD / DROPPED`.
2. Final Lap and fuel warning state commit only on `DISPATCHED`.
   `HELD` and `DROPPED` retain the candidate state.
3. Checker-out notice sets `checker_out_notice_sent` only on `DISPATCHED`.
4. Driver activity gate remains before director gate and denies voice by
   default while handoff/inactive.
5. `session_info`, `session_summary`, and `pit_timing` remain allowed metadata.
6. Race summary stays in E0’s `_pending_summary` retry loop and includes the
   exact `car_model`.
7. Both signature and SessionNum reset paths reset `fuel_warning_band`,
   driver activity state, and `_pending_summary`.
8. Practice → Qualify → Race authority changes are emitted without repeating an
   already-consumed SessionNum reset.
9. Final Lap uses overall `CarIdxPosition == 1`, not class leader, and fuel uses
   the exact same `estimated_crossings_to_finish`.
10. Session Authority is at the first byte of the system prompt and overrides
    historical memory; UNKNOWN remains fail-closed.

## Primary files

- `irsdk-bridge/bridge.py`
- `irsdk-bridge/race_lifecycle.py`
- `irsdk-bridge/driver_activity.py`
- `irsdk-bridge/final_lap.py`
- `irsdk-bridge/fuel_strategy.py`
- `irsdk-bridge/session_authority.py`
- `desktop/renderer.html`
- `prompts.js`
- `preflight.sh`

Tests:

- `tests_driver_handoff.py`
- `tests_final_lap.py`
- `tests_final_lap_wiring.py`
- `tests_fuel_strategy.py`
- `tests_fuel_strategy_wiring.py`
- `tests_session_authority.py`
- `tests_session_authority_wiring.py`
- `tests_phase_ab_integration.py`
- existing lifecycle/judge/preflight suites

## Current evidence

- E0 driver handoff: 125/125
- Final Lap pure + wiring: 72/72 + 20/20
- Fuel pure + wiring: 47/47 + 25/25
- Session Authority pure + wiring: 20/20 + 36/36
- Cross-unit tri-state integration: 20/20
- Existing bridge lifecycle wiring: 77/77
- Existing judge LLM gate: 92/92
- Full `preflight.sh`: `✅ 出荷可`
- `git diff --check`: clean

## Required independent review

Report findings in P0/P1/P2 order with file, evidence, reproduction condition,
and minimum fix condition.

Focus especially on:

1. Any truthy use of tri-state `broadcast()` that consumes Final Lap, fuel,
   checker, stage, or summary state on HELD/DROPPED.
2. Handoff/inactive → active re-entry: no teammate data may be treated as the
   user’s stint; fuel/final states must re-arm safely.
3. Race completion: final lap recording, PLAYER_FINISHED, pending summary, and
   DEBRIEF must occur once and in the correct order.
4. SessionNum and SessionInfo signature transitions: no double reset, no stale
   pending summary, and no lost authority update.
5. Timed multiclass/lapped cases: no class-leader fallback and no own-pace
   fallback when the authority model is unavailable.
6. Fuel band boundaries (+0.5L safe, 0..+0.5L tight, negative critical),
   lifecycle suppression, pit suppression, and dispatch-only dedup.
7. Every speech-producing API path receives current Session Authority; old
   class-key memory remains usable without overriding current facts.
8. Any integration regression not covered by the isolated worktree reviews.

Do not modify files. Do not commit, push, merge, or build. Return review only
and wait for Yuji.

## First integration-review remediation

Claude’s first integration review returned P0 0 / P1 0 / P2 3. Codex chose to
close all three before calling Phase A–B complete:

1. Practice/Qualify transition summaries now use an independent
   `_pending_non_race_summary` retry. It does not set the new session’s
   `summary_sent`.
2. Checker fallback now uses `_pending_checker_notice` and retries throughout
   CHECKER_OUT. Only `BROADCAST_DISPATCHED` clears it.
3. Race summary readiness now requires the current lap number and rounded
   `LapLastLapTime` to exist in the latest `session_laps` record. Teammate laps
   are excluded from `session_laps`; only `driver_activity == ACTIVE` can append.

Both new pending states are in the single session-scoped reset dictionary and
are unpacked by both signature and SessionNum reset paths.

Updated evidence:

- Cross-unit integration: 28/28
- judge LLM gate: 92/92
- full `preflight.sh`: `✅ 出荷可`
- `git diff --check`: clean

Please re-review only this remediation delta and report any remaining
P0/P1/P2 blocker. All prohibitions remain in force.
