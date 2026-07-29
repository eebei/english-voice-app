# PITWALL Weekend Authority / Luna Review Request

## Review mode

Independent, read-only review. Use `file:line` evidence. Do not modify, commit,
push, build, publish, or deploy.

## Real-session failures this change must prevent

1. SessionInfo contained 31 real entries (8 GTP / 23 GT3), but Luna said the
   class counts were unavailable.
2. The driver set no valid qualifying lap. Luna inferred `P1 start` and
   attributed it to iRating. The actual grid was P12.
3. Luna used masculine phrases such as `その通りだ`, `P12スタートだ`,
   `必要だ`, and `あ、待てよ`.
4. A 323.5-second repair estimate was read as raw seconds instead of 5m23s.
5. During guided debrief, `走り自体はどうだった？` was consumed as the next
   questionnaire answer instead of receiving an engineering analysis.

## Acceptance contracts

1. `num_drivers` counts real non-spectator drivers only.
2. `class_entry_counts` and `player_class_entry_count` come from SessionInfo,
   not LLM inference.
3. Session type and advertised length/laps are retained per SessionNum.
4. Qualifying is factual only when the player's QualifyResultsInfo row has a
   positive FastestTime.
5. Missing/invalid qualifying result must fail closed; live position, iRating,
   and entry order must never become qualifying/grid position.
6. Weekend authority reaches both normal chat and automatic briefing.
7. Luna prompt and deterministic output normalization block the four observed
   masculine phrase patterns without changing technical numbers.
8. Repair durations >=60 seconds are rendered in minutes and seconds in both
   LLM context and deterministic radio.
9. An analysis question during guided debrief reaches the normal debrief LLM
   and does not advance the evidence questionnaire.
10. Existing fuel authority, session evidence, safety window, driver handoff,
    update gate, Cost Telemetry, and character parity remain intact.

## Files in scope

- `irsdk-bridge/bridge.py`
- `desktop/renderer.html`
- `prompts.js`
- `irsdk-bridge/tests_weekend_authority.py`
- `tests-weekend-authority.js`
- `preflight.sh`

## Required report

- P0 / P1 / P2 findings with concrete failure scenario and minimal correction.
- Verify contracts 1-10 with `file:line` evidence.
- Specifically inspect SessionInfo YAML section-boundary behavior and
  QualifyResultsInfo zero-based-to-one-based conversion.
- Check synthesis risks with fuel authority, auto briefing, guided debrief,
  streaming TTS, and all-character shared contracts.
- State unverified real-iRacing assumptions separately.

## Test result supplied by Codex

- `python3 irsdk-bridge/tests_weekend_authority.py`: green
- `node tests-weekend-authority.js`: 10/10
- `node tests-fuel-authority.js`: 23/23
- full `bash preflight.sh`: green (local HTTP integration tests included)

## Remediation after first independent review

The first review reported P1 concerns for position offset assumptions, AI entry
counting, and bare-question-mark debrief routing.

1. Position conversion now requires an observed zero row in the same result
   list. Without that evidence, the position remains null rather than applying
   `+1`. Class-position base is verified independently within the player's class.
2. Entry counts now include non-spectator AI cars even when iRating is absent.
   Explicit pace cars are excluded. SOF still uses rated drivers only.
3. Guided-debrief analysis routing no longer treats a trailing `?`/`？` alone
   as analysis intent; it requires semantic analysis/evaluation wording.

Please re-review these remediations and report whether the prior P1 findings are
fully resolved, including any new P0/P1/P2 introduced by them.
