# Session Evidence Debrief — Independent Review Request

## Review boundary

Review the current uncommitted diff only. Do not modify files and do not commit, push,
build, deploy, or publish. Report P0/P1/P2 findings with `file:line` evidence.

This feature contains a confidential product concept. Do not introduce its internal
project name into public UI, normal logs, release notes, or source identifiers.

## Goal

Turn Practice, Qualifying, and Race/Stint evidence into driver-confirmed memory:

1. Reach debrief even when `session_summary` is delayed or missing.
2. Prefer a later complete summary over the initial fallback.
3. Show factual session evidence separately from driver interpretation.
4. Ask one short question at a time.
5. Save nothing until the driver explicitly confirms.
6. Scope saved memory by driver, track, car/class, and session type.
7. Feed only relevant confirmed records into later briefing/strategy/debrief prompts.
8. Keep Practice/Qualifying review optional so it cannot block the next session.
9. Release speech-window holds while stopped and in debrief.
10. Avoid broken sentence fragments when the race reply limit is reached.

## Files

- `desktop/renderer.html`
- `irsdk-bridge/bridge.py`
- `server.js`
- `tests-evidence-debrief.js`
- `preflight.sh`

## Required failure scenarios

- `FINISHED` arrives before `session_summary`.
- `session_summary` never arrives.
- Complete summary arrives during the 8-second fallback timer.
- User manually enters debrief before the timer fires.
- Practice/Qualifying transitions while the user wants to continue immediately.
- User dismisses or restarts confirmation.
- localStorage is malformed or unavailable.
- Different driver, track, or car attempts to consume stored memory.
- Car is stopped on grid with steering/brake values outside the moving safety window.
- First complete sentence fits but the next sentence exceeds the race reply budget.
- Rapid PTT/chat input while a guided answer is being recorded.
- Repeated PTT while the current guided question is queued or still being spoken.

## Acceptance contracts

- No fabricated telemetry is labeled as factual evidence.
- No unconfirmed response enters `pw_session_evidence`.
- Memory from another named driver must not be injected.
- Missing track/car must fail conservatively; broad matching must not contaminate a
  different known track or car.
- A late complete summary must replace fallback data before the guided review starts.
- The UI must not trap the user in debrief.
- Existing radio safety, TTS queue, Cost Telemetry, update gate, and Session Authority
  tests must stay green.
- No confidential internal product name is exposed in public-facing surfaces.

## Verification already run

- `node tests-evidence-debrief.js` — 22/22
- `node --check server.js`
- `python3 -m py_compile irsdk-bridge/bridge.py`
- `git diff --check`
- `bash preflight.sh` — all green (localhost HTTP tests run outside sandbox)

## Explicitly deferred

- Cross-driver/team-shared memory is not enabled. Driver identity and consent contracts
  must be reviewed before that storage scope is activated.
- Windows Electron E2E and live iRacing telemetry validation remain required after an
  approved build.
