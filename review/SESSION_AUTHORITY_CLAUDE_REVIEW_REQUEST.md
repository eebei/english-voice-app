# Unit 3 Session Authority — Claude independent review request

Date: 2026-07-26
Status: uncommitted; no push/build authorized
Stacked worktree: `/private/tmp/pitwall-final-lap` (base `f26260c`)

## Purpose

Prevent current-session hallucinations such as “Okayama/Ferrari” or “Monza”
while iRacing is actually at Road America in a McLaren. Historical memories are
retained, but current iRacing SessionInfo must override them.

## Production contract

1. `CarScreenName` is parsed for the player and exported as
   `player_car_model`; class remains a separate field.
2. Current session type comes only from `Sessions[SessionNum]`.
   Weekend-level `EventType` is never used as a current-session fallback.
3. Bridge emits a structured `current_session_authority` payload:
   track, car model, current session type, SessionNum, source, completeness,
   and missing fields.
4. Authority signature changes on Practice → Qualify → Race and re-sends
   `session_info`.
5. Renderer propagates the structured payload through every LLM request path.
6. The system prompt begins, at byte zero, with
   `[CURRENT SESSION — AUTHORITATIVE iRACING DATA]`.
7. That block explicitly overrides profile notes, race history, car/track
   memory, conversation history, and assumptions.
8. Missing facts are represented as `UNKNOWN`; the model is forbidden to
   infer, reuse stale values, or promise a later check.
9. Existing memory is not deleted. New summaries and pit timing use exact car
   model keys, with class only as a compatibility fallback.

## Files

- `irsdk-bridge/session_authority.py`
- `irsdk-bridge/tests_session_authority.py`
- `irsdk-bridge/tests_session_authority_wiring.py`
- `irsdk-bridge/bridge.py`
- `desktop/renderer.html`
- `prompts.js`
- `preflight.sh`

## Acceptance evidence

- Pure authority contract: 20/20
- Bridge → renderer → prompt wiring: 27/27
- Prompt runtime checks use the production `buildSystem()` export.
- Practice, Open Qualify, and Race each produce distinct authority signatures.
- Missing/placeholder values fail closed to `unknown`/`UNKNOWN`.
- Both session-summary paths and pit timing carry `car_model`.
- Full `preflight.sh`: green, `✅ 出荷可`
- `git diff --check`: clean

## Deterministic mutation evidence

- Replace `Sessions[SessionNum]` with `EventType` → Practice fixture changes to
  Race and fails.
- Remove `TrackDisplayName` preference → spoken track changes to internal name
  and fails.
- Substitute car class for car model → McLaren fixture changes to IMSA23 and
  fails.
- Restore renderer’s old `event_type` assignment → wiring contract fails.
- Remove one structured authority API payload → four-path count fails.
- Remove `CarScreenName` parser → parser contract fails.
- Move authority block behind character prompt → first-block contract fails.

## Independent reviewer focus

1. Confirm SessionInfo parser cannot accidentally attach `CarScreenName` to the
   wrong driver.
2. Confirm authority signature and SessionNum reset occurring in the same frame
   do not cause a harmful double reset.
3. Confirm all API paths that can produce speech carry `sessionAuthority`.
4. Confirm no later prompt section weakens the authority/UNKNOWN contract.
5. Confirm memory retention matches Yuji’s decision: preserve history, override
   it for current facts.
6. Review the stacked interaction with Final Lap and fuel, especially the
   isolated pre-E0 boolean `broadcast()` compatibility note. Final integration
   must use E0 `DISPATCHED/HELD/DROPPED` semantics and requires another review.

## Prohibitions

Do not commit, push, merge, or build the EXE. Report findings by severity and
wait for Yuji approval.

## Independent-review remediation

Claude review reported P0 0 / P1 1 / P2 4. All findings were addressed before
commit:

- P1: strategy-mode instructions now repeat the authority-only/UNKNOWN contract
  and explicitly forbid inference from memory, conversation, or series knowledge.
- P2: same-frame and delayed SessionInfo refreshes publish the new authority
  without repeating an already-consumed SessionNum reset; track/model changes
  still take the full reset path.
- P2: DRIVER_INSIGHT requests now carry `sessionAuthority`.
- P2: old class-key car/track memory is a fallback seed for retrieval, session
  summary, and pit timing, while new writes use the exact model key.
- P2: `unknown` car class cannot overwrite `lastCarClass`.

The wiring suite includes reversal checks for the new contracts. Re-run the full
preflight and independently verify these remediations before approval.
