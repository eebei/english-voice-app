# PITWALL next-session handoff — 2026-07-29

## Current state

- Build 237 is already published.
- Phase B Pit Loss Calibration is implementation- and review-complete.
- Final review: P0 0 / P1 0 / P2 0; all preflight checks green.
- Phase B remains uncommitted.
- Do not commit, push, build, deploy, merge, or publish without Yuji's new instruction.

## Field evidence received after review

`OMORAY-bridge-debug-20260729-2020.log` showed:

- `PlayerTrackSurface=0` while `IsOnTrack=True` during an incident.
- This validates the Phase B dual fail-closed calibration gate:
  `IsOnTrack && !OnPitRoad && PlayerTrackSurface == 3`.
- The session was Hockenheim Practice, not Race: approximately 22 laps, P5.
- Masato Takeda identity matched app profile, iRacing PlayerCarIdx, and stored memory.
- Luna's old-feeling opening line is still a current static greeting, not evidence
  by itself that the executable was three generations old.

## Tomorrow's topic

**Phase C: Pit Exit Position & Traffic Window Forecast**

Design first at high reasoning:

1. Forecast position after a pit stop.
2. Identify cars immediately ahead and behind after pit exit.
3. Detect traffic and pit-exit/blend overlap risk.
4. Compare pit-now versus extending one or more laps.
5. Define confidence, unavailable-data behavior, and speech safety boundaries.
6. Keep deterministic calculation separate from Luna's natural-language explanation.

Do not begin Phase C implementation until Phase B can be checkpointed separately.
Off-track incident awareness and post-rejoin speech remain a later, separate scope.
