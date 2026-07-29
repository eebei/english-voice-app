# Character Capability Parity — Independent Review Request

## Review boundary

Review the current uncommitted diff only. Do not modify files. Do not commit, push,
build, deploy, or publish. Report P0/P1/P2 findings with `file:line` evidence.

## Goal

All seven PITWALL engineer characters must have the same judgment, confirmed-memory,
and speech-safety capabilities. Personality, voice, and language may differ; capability
and safety contracts must not.

## Character and language matrix

| Character | Evidence debrief language |
|---|---|
| James | English |
| Luna | English |
| Hajime | English |
| 官兵衛 | Japanese |
| 大石 | Japanese |
| HajimeJP | Japanese |
| LunaJP | Japanese |
| Matthias | German |
| Camila | Brazilian Portuguese |

Luna/LunaJP and Hajime/HajimeJP are one persona each with language profiles; public
character count remains seven.

## Contracts to verify

1. All character profiles use the same Practice/Qualifying/Race question structure.
2. A fuel question is added under the same factual condition for every character.
3. Driver confirmation is mandatory before storage for every character.
4. Driver/track/car fail-close, 90-day expiry, and malformed-storage recovery are shared.
5. No Luna-only gate exists in evidence-memory selection or injection.
6. The same telemetry evidence is shown regardless of character.
7. UI controls, spoken questions, status messages, and memory prompt instructions use
   the selected engineer language.
8. Changing language must not change stored schema or confidence.
9. `speak_gate`, priority queue, and P0/P1 safety behavior remain character-independent.
10. Rapid PTT protection remains active in all languages.
11. A stored answer in one language may be read by another character without being
    relabeled as measured telemetry.
12. No confidential internal product name appears in public UI or normal logs.

## Failure scenarios

- Select James, Matthias, or Camila and receive a Japanese guided question.
- Select LunaJP and receive an English save/error message.
- Character switch changes the number/order of evidence questions.
- German/Portuguese copy falls back to a missing key or `undefined`.
- Character switch bypasses confirmation or the 90-day filter.
- Stored driver feedback is presented as telemetry fact.
- Non-Japanese prompt text causes the engineer to answer in the wrong language.
- A localized string introduces unsafe HTML.

## Files

- `desktop/renderer.html`
- `tests-character-capability-parity.js`
- `tests-evidence-debrief.js`
- `preflight.sh`

## Verification already run

- `node tests-evidence-debrief.js` — 22/22
- `node tests-character-capability-parity.js` — 33/33
- `git diff --check`
- `bash preflight.sh` — all green

## Explicitly unchanged

- Telemetry calculations
- Memory storage schema
- Driver/track/car matching
- 90-day expiry
- Speech priority and safety-window thresholds
- Character identity/personality prompts
- TTS voice selection
