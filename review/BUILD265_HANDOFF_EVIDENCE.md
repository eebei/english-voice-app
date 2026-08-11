# Build 265 handoff evidence

Reference audit spec: [CLAUDE_CODE_BUILD265_CIRCUIT_AUDIT.md](CLAUDE_CODE_BUILD265_CIRCUIT_AUDIT.md).
Circuit audit matrix: [BUILD265_CIRCUIT_AUDIT.md](BUILD265_CIRCUIT_AUDIT.md).
Real-run evidence source: `/Users/yuji.s/Downloads/OMORAY-bridge-debug-20260810-1838.log` (Build 264, Monza 35 GT3 one-make).

Nothing was committed, pushed, packaged, published or written to the public release channel.

---

## 0d. Codex differential — 2026-08-11 (final pass)

Codex's final differential — 4 concrete points, all addressed:

1. **Bridge emits a deterministic `lap_time` radio only when `lap_valid_clean=true`.** [bridge.py](irsdk-bridge/bridge.py) — in the `lap_time_changed and onTrack` block, the `else` (non-PB, non-SB) branch now emits `broadcast({'type':'radio','trigger':'lap_time', ..., **_clean_lap_evidence})` gated on `if _lap_valid_clean:`. Dirty laps (incident / pit_in / pit_out / off_track) do NOT emit a radio candidate at all — the renderer's Lap Readout gate cannot even see them, so `every_2_laps` counts and `every_clean_lap` allowance stay consistent with the bridge's own `clean_lap_candidate_count`.
2. **`lap_valid_clean` explicit on both paths.** Radio payload: `_clean_lap_evidence` (spread into every lap-readout broadcast) has `lap_valid_clean` as a top-level key. `telemetry_live`: new field `lap_valid_clean` (live prediction for the in-progress lap) computed from the same accumulators as the radio judgment.
3. **`Off` UI hint corrected.** Old: "ベスト更新は Best only 以外では常に発話する" (implied Off spoke Best too). New: "Off はベスト更新も含めラップ読み上げを完全に止める。Best only はベスト更新のみ発話。Every clean lap はインシデントなし・ピット外・オフトラックなしの周だけ発話（ベスト更新は常に通す）。Every 2 laps はそのクリーン周のうち 2 周ごとに 1 度発話（ベスト更新は常に通す）。" Aligned with the enum semantics: Off silences everything including PB/SB; Best only allows only PB/SB; every_clean_lap / every_2_laps let PB/SB through as celebrate moments.
4. **Event-sequence test.** New [tests-lap-readout-event-sequence.js](tests-lap-readout-event-sequence.js) — 17 checks. Simulates the actual bridge radio stream: laps 3,4,6,8 clean and laps 5(incident),7(pit_in),9(pit_out),10(off_track) dirty. Verifies:
   - `every_2_laps`: exactly 2 events speak — lap 4 (2nd clean) and lap 8 (4th clean). Laps 3, 6 (1st, 3rd clean) silent. Every dirty lap silent AND produces a suppressed verdict (never silently skipped upstream).
   - `every_clean_lap`: exactly 4 events speak, in order 3→4→6→8. Every dirty lap silent.
   - `off`: nothing speaks across the whole sequence (including Best would if any).
   - `best_only`: no lap_time event speaks (PB path verified elsewhere).
   - Fallback: with the bridge's `clean_lap_candidate_count` stripped from the payload, the renderer's local counter still produces the same 2nd/4th behaviour.
   - Bridge wiring: `if _lap_valid_clean:` gate exists ONLY at the lap_time broadcast; `_clean_lap_evidence` is spread; `telemetry_live` carries `lap_valid_clean`; the UI hint text change is present.

Rerun results are in section 2 below; every suite green.

---

## 0c. Codex differential — 2026-08-10 nightly (fourth pass)

Codex rejected the third pass because:

1. **Renderer computed clean-lap validity itself.** Codex wants the bridge to be the sole judge (per-lap validity, pit in/out, incidents, off-track). Otherwise the renderer's judgment can drift from the actual telemetry.
2. **`Every 2 laps` used raw lap parity, not clean-lap sequence.** A driver who had an incident on an odd lap would still be silenced on the next even lap regardless of cleanliness.
3. **Target-lap suppression was still unconditional.** Codex requires it to be gated on three explicit proofs (capacity fits + planned add defined + post-stop finish margin ≥ 0). Without all three, the strategy path cannot reliably speak, so the plan authority must not silence the fuel P0.
4. **Final Settings enum wasn't the spec.** Final spec is `Off / Best only / Every 2 laps / Every clean lap` — no `every_lap` and `none` becomes `off`.

All four addressed:

- **Bridge is the sole clean-lap judge.** `irsdk-bridge/bridge.py` tracks `_lap_start_incidents`, `_lap_had_pit_road`, `_lap_had_pit_road_prev`, `_lap_had_off_track`, `_clean_lap_candidate_count` per-frame. Every lap-readout broadcast (`personal_best`, `session_best`, `first_lap`) now carries `_clean_lap_evidence` (`lap_number`, `lap_valid_clean`, `incidents_this_lap`, `pit_in_this_lap`, `pit_out_this_lap`, `off_track_this_lap`, `clean_lap_candidate_count`). The same evidence is exposed on `telemetry_live`. Session-num and sig resets wipe the state (invisible-loss禁止). Coverage: `irsdk-bridge/tests_bridge_clean_lap_emission.py` — 8 checks including state init, per-frame updates, evidence definition, roll-over, telemetry exposure, and both reset paths.
- **`Every 2 laps` counts clean lap candidates.** The renderer reads `clean_lap_candidate_count` (bridge-authoritative) when present; falls back to a local counter (`lapReadoutCleanCount`) when the field is missing. A dirty lap never speaks and never increments the counter. Session-num reset clears the counter. Coverage: `tests-lap-readout-policy.js::every_2_laps: N-th clean candidate speaks/silenced`.
- **Target-lap suppression requires all three proofs.** `plan_fuel_authority.py` and `desktop/fuel-plan-guard.js` both compute a `finish_margin_after_stop_l` at target lap and suppress ONLY when `capacity_fits` and `planned_add` and `finish_margin >= 0` hold together. Any missing proof → `override_reason: 'planned_pit_lap_but_strategy_proof_incomplete'` and P0 flows through (safe side). Coverage: Py `test_lap14_authority_allows_p0_when_capacity_does_not_fit`, `test_lap14_authority_allows_p0_when_finish_margin_missing`; JS `at planned pit lap without finish proof/with capacity overflow, P0 is allowed`.
- **Final Settings enum.** `LAP_READOUT_POLICIES = ['off','best_only','every_2_laps','every_clean_lap']`. `every_lap` and `none` removed; `off` silences everything including Best updates; `best_only` allows only PB/SB; the other two rely on bridge clean-lap evidence. Settings UI select and hydrator whitelist all match. Legacy values in `pw_contract` (`every_lap`, `after_change`, `none`) fall back to allow-with-trace. DEFAULT_CONTRACT default is `every_clean_lap`. Coverage: `tests-lap-readout-policy.js` — 41 checks including `off silences personal_best`, `best_only allows/silences the right set`, and full UI wiring.

Rerun results are in section 2 below; every suite green.

---

## 0b. Codex differential — 2026-08-10 late-evening (third pass)

Codex rejected the second pass because:

1. **Plan generation ran AFTER the fuel-band evaluation.** On the first frame fuel went critical, `strategy_options` was still `None` — the plan authority fell back to `no_active_plan` and the P0 was allowed anyway. Bridge budget still burned, downstream characters still spoke `data.message`.
2. **The plan authority hard-coded Plan A.** A mid-race switch to Plan B/C was ignored; the authority evaluated the wrong plan.
3. **At the target lap, the P0 was permitted alongside `strategy_plan_decision`.** Both spoke, producing a duplicate "この周ボックス" (P0) plus "Baseline fuel timing selected" (P2).
4. **Insufficient-evidence branches silently suppressed** (returning `suppression_reason='...'`) in one place while allowing in others — inconsistent and unsafe.
5. **The 4 Lap Readout options were the wrong four.** Spec calls for `Every lap / Every 2 laps / Every clean lap / None` with telemetry-based judgment for the two middle ones; implementation had `every_lap / after_change / best_only / none` and no UI select.

All five addressed:

- **Same-frame plan snapshot.** `irsdk-bridge/bridge.py` now builds a `_plan_options_for_authority` candidate INLINE just before the fuel-band evaluation, using the same `fuel_strategy` inputs that produced `_fuel_eval`. The authority always evaluates against a live snapshot even on the very first critical frame. Covered by `tests_plan_fuel_authority.py::BridgeWiring::test_same_frame_plan_snapshot_before_fuel_authority`.
- **`selected_plan` is the authority.** `plan_fuel_authority.py::_selected_plan` picks `plans[selected_plan.lower()]` instead of hard-coding plan_a. JS mirror `desktop/fuel-plan-guard.js::activePlan` now requires `playbook.selected_plan` (no `|| 'A'` fallback). Test: `test_selected_plan_b_is_honored` (Py) and `authority honors selected_plan=B not hard-coded A` (JS).
- **Target lap: suppression, not permission.** At and past the planned pit lap the authority returns `allow_p0_pit_now: false` with `suppression_reason: 'planned_pit_lap_speaks_via_strategy_decision'`, ceding the speech to `strategy_plan_decision` / `strategy_plan_box_call`. Both the Py and JS suites now assert this. The full-timeline sweep test asserts lap 5–13 suppress AND lap 14 also suppresses (so P0 never speaks in the whole Monza 35 race).
- **Insufficient evidence = safe side (allow).** All "no plan / no burn / no fuel / no target_lap / invalid current_lap" branches now return `allow_p0_pit_now: true` with `override_reason: 'insufficient_evidence_*'`. Never silent suppression under uncertainty.
- **4 Lap Readout options with telemetry.** Contract enum is now exactly `['every_lap','every_2_laps','every_clean_lap','none']`. `every_2_laps` reads `lastTelemetry.lap` (missing lap → allow + `telemetry_missing:true` trace). `every_clean_lap` silences `lap_slow` by definition and additionally silences any kind when `lastTelemetry.incidents_this_lap > 0`. Best updates (`personal_best`, `session_best`) always speak under `every_lap` / `every_2_laps` / `every_clean_lap`. `none` silences everything (absolute). Legacy values (`best_only`, `after_change` still in a driver's localStorage) fall back to allow with `policy: 'unknown_falls_back_to_every_lap'` trace. New Settings UI has a select control (`#lap-readout-select`) with all four options, populated by `hydrateLapReadoutSelect()` on `showScreen('screen-setup')` and persisted through `onLapReadoutChanged()` which marks `signed: true` and traces `LAP_READOUT_POLICY set=... signed=true`. Coverage: `tests-lap-readout-policy.js` — 35 checks covering all four policies, telemetry judgment, missing-telemetry safe side, legacy-value fallback, and the UI wiring end-to-end.

Rerun results are in section 2 below; every suite green.

---

## 0. Codex differential — 2026-08-10 evening

Codex rejected the first pass because the plan-aware guard lived only in the renderer. Renderer suppression left the bridge director charging budget for the P0 and left non-JP characters (English/German/Portuguese `injectRadio` paths) speaking `data.message` even after JP was silenced. Fixes below are the second pass; the renderer guard is kept as defense-in-depth but is no longer the primary gate.

Additional issues Codex flagged, all addressed:

- **Bridge-authoritative contract.** New `irsdk-bridge/plan_fuel_authority.py` decides `allow_p0_pit_now`; `irsdk-bridge/bridge.py` calls it before the `broadcast()` that creates `fuel_strategy_warning`. When suppressed, no `broadcast()` happens at all — director never sees the event, budget is never charged, and no character speaks it. A `PLAN FUEL AUTHORITY` log line is emitted every time the gate runs; `FUEL BAND DIAG` now shows `dispatch=SUPPRESSED_BY_PLAN_AUTHORITY` when the plan gate denies. Coverage: `irsdk-bridge/tests_plan_fuel_authority.py` — 12 checks including a full 10-lap Monza 35 sweep and a wiring assertion that the authority is evaluated before the broadcast site.
- **Follow-up delivery after Final Lap.** The first pass only gated the *arm* path. Codex correctly pointed out that a follow-up armed pre-final-lap would still deliver post-final-lap. Fixed in `deliverOperationalFollowUp` and `maybeRunOperationalFollowUp`: both now consult `isSessionEndingLifecycle()` and emit `OPERATIONAL_FOLLOWUP expired reason=session_ending` when they abort. Covered by additional checks in `tests-operational-followup-idempotency.js`.
- **PB defer-cap silent loss.** When a PB is interrupted twice by successive P0s, the second interrupt exceeded `SPEAK_DEFER_MAX` and the PB was silently dropped. Fixed: `SPEAK_DEFER_DISCARDED` trace on the discard path (`reason=defer_cap_reached`). Covered by additional check in `tests-personal-best-under-p0.js`.
- **Lap Readout preference not connected.** `pw_contract.pace.readout` was stored by the UI but only exposed to the LLM as advice; the actual dispatch spoke everything the bridge broadcast. New `lapReadoutPolicyAllows` in the renderer gates every lap-readout kind (`personal_best`, `session_best`, `first_lap`, `lap_time`, `lap_slow`, `lap_consistent`) with the four policies (`none`, `best_only`, `after_change`, `every_lap`) at the top of `injectRadio`. Unsigned contract remains pass-through so no existing driver is silently silenced. Coverage: new `tests-lap-readout-policy.js` — 23 checks across all four policies and the wiring.

---

## 1. Changed files

New:
- `irsdk-bridge/plan_fuel_authority.py` — bridge-side authoritative plan-aware fuel decision. Only owner of the pit-now permission; broadcast() is not called when it denies.
- `irsdk-bridge/tests_plan_fuel_authority.py` — Monza 35 regression, full timeline sweep, plan decision fires exactly once, bridge wiring, true emergency.
- `desktop/fuel-plan-guard.js` — renderer defense-in-depth guard mirroring the bridge contract (retained; the bridge gate is the primary).
- `tests-fuel-plan-authority.js` — Monza 35, emergency, plan-exceeds-capacity, tight band, plan reached, no-plan fallback, safety override, renderer wiring.
- `tests-strategy-playbook-material-change.js` — playbook material change threshold, renderer speaks only on promotion or material change, silent trace for burn drift.
- `tests-strategy-lifecycle-suppression.js` — final-lap / checker / PLAYER_FINISHED / debrief latches, session-num reset clears latches, operational followup and strategy speech both refuse during session-ending lifecycle.
- `tests-operational-followup-idempotency.js` — one arm per intent + session + lap, no parallel copies, session-ending refusal on both the arm and deliver paths, session-num reset drops any pending job.
- `tests-personal-best-under-p0.js` — priority ordering keeps PB after P0, deferable-kinds set includes personal_best / session_best / first_lap, bounded interrupt re-queue with `SPEAK_DEFERRED` trace, `SPEAK_DEFER_DISCARDED` trace on cap.
- `tests-lap-readout-policy.js` — UI-saved `pw_contract.pace.readout` is enforced at dispatch under all four policies (unsigned pass-through, none, best_only, after_change, every_lap) and the renderer wires the gate into `injectRadio`.
- `review/BUILD265_CIRCUIT_AUDIT.md` — full audit matrix (one row per supported live call).
- `review/BUILD265_HANDOFF_EVIDENCE.md` — this document.

Modified:
- `irsdk-bridge/bridge.py` — imports `plan_fuel_authority`, evaluates the plan gate before the `fuel_strategy_warning` broadcast, and reflects the verdict in `FUEL BAND DIAG` (`dispatch=SUPPRESSED_BY_PLAN_AUTHORITY`). No change to the bridge's plan-agnostic evaluator; the gate sits between evaluator and broadcast.
- `desktop/memory-action-layer.js` — `normalizeTrack` for Monza now uses an explicit alias whitelist; unknown Monza layouts (e.g. `monza gpsecondchicane`) keep their distinct canonical key.
- `desktop/renderer.html`:
  - Loads `fuel-plan-guard.js` (defense-in-depth).
  - Adds lifecycle latches `finalLapNoticeSeen`, `checkerOutNoticeSeen`, helper `isSessionEndingLifecycle()`, and clears them at session-num reset.
  - `armOperationalFollowUp` refuses duplicate arms and session-ending arms; `deliverOperationalFollowUp` and `maybeRunOperationalFollowUp` refuse to deliver in session-ending lifecycle and always emit an expired-reason trace.
  - `evaluateFuelPlanGuard` and the top-of-`injectRadio` fuel guard remain as defense-in-depth; the bridge is now the primary gate.
  - Rewrites `updateStrategyPlaybookFromLive` to emit speech only on promotion-to-live or material change; adds silent `STRATEGY_PLAYBOOK_UPDATE_SILENT` trace with structured reason.
  - Tracks `currentSpeakItem`, adds `SPEAK_DEFER_KINDS` and `SPEAK_DEFER_MAX`, re-queues a displaced deferable item once on interrupt, emits `SPEAK_DEFERRED` on defer and `SPEAK_DEFER_DISCARDED` when the defer cap is reached.
  - Adds `LAP_READOUT_KINDS`, `BEST_ONLY_KINDS`, and `lapReadoutPolicyAllows`; `injectRadio` consults the gate for every lap-readout trigger. Emits `LAP_READOUT_SUPPRESSED` on drop. Unsigned contract passes through unchanged.
- `tests-memory-action-layer.js` — new asserts for Monza layout separation.
- `tests-speak-async.js` — sandbox now exports the new deferable-kind constants so the extracted `speak` function evaluates cleanly.

Unchanged (deliberately):
- `irsdk-bridge/fuel_strategy.py` — plan-agnostic evaluator is unchanged. The gate is layered on top so the base fuel arithmetic and its tests stay intact.

## 2. Test commands and actual results

Commands (all run from repo root):

```bash
node tests-fuel-plan-authority.js
node tests-strategy-playbook-material-change.js
node tests-strategy-lifecycle-suppression.js
node tests-operational-followup-idempotency.js
node tests-personal-best-under-p0.js
node tests-memory-action-layer.js
node tests-strategy-playbook.js
node tests-memory-wiring.js
node tests-radio-brevity.js
node tests-engineer-card.js
node tests-fuel-authority.js
node tests-strategy-guard.js
node tests-telemetry-truth-gate.js
node tests-speak-async.js
for t in irsdk-bridge/tests_*.py; do python3 "$t"; done
```

Actual results (FIFTH / FINAL-pass rerun after bridge lap_time emission + explicit lap_valid_clean + Off hint + event-sequence test):

- `tests-lap-readout-event-sequence.js` — **17/17 pass** (new: 4 clean + 4 dirty event stream verifies every_2_laps=2 events at laps 4&8, every_clean_lap=4 events at 3,4,6,8, off=0, best_only=0; local fallback identical; bridge wiring assertions)
- `irsdk-bridge/tests_bridge_clean_lap_emission.py` — **8/8 pass** (still green after adding lap_valid_clean to telemetry_live)
- `irsdk-bridge/tests_plan_fuel_authority.py` — **17/17 pass** (unchanged)
- `tests-fuel-plan-authority.js` — **24/24 pass** (unchanged)
- `tests-lap-readout-policy.js` — **41/41 pass** (unchanged; the semantic contract stays the same)
- All other JS suites: material-change 11, lifecycle-suppression 9, followup 8, PB 11, memory-layer 22, playbook 32, speak-async 18, engineer-card 79, fuel-authority 25, strategy-guard 40, truth-gate 50, radio-brevity 30, memory-wiring 13 — **all green, unchanged**.
- All 30 Python bridge suites — **OK**.

(historical) Fourth-pass results:

- `irsdk-bridge/tests_plan_fuel_authority.py` — **17/17 pass** (adds `test_lap14_plan_authority_suppresses_when_all_proofs_hold`, `test_lap14_authority_allows_p0_when_capacity_does_not_fit`, `test_lap14_authority_allows_p0_when_finish_margin_missing`)
- `irsdk-bridge/tests_bridge_clean_lap_emission.py` — **8/8 pass** (new: state init, per-frame updates, evidence definition, roll-over, telemetry exposure, session-num + sig reset consumers)
- `tests-fuel-plan-authority.js` — **24/24 pass** (new: `at planned pit lap with complete proofs`, `without finish proof, P0 is allowed`, `with capacity overflow, P0 is allowed`)
- `tests-lap-readout-policy.js` — **41/41 pass** (final 4-option enum, bridge evidence extraction, `_hasCleanEvidenceFields` check, clean-lap counter fallback)
- All other JS suites: material-change 11, lifecycle-suppression 9, follow-up 8, PB 11, memory-layer 22, playbook 32, speak-async 18, engineer-card 79, fuel-authority 25, strategy-guard 40, truth-gate 50, radio-brevity 30, memory-wiring 13 — **unchanged, all green**.
- All 30 Python bridge suites — **OK** (adds new `tests_bridge_clean_lap_emission.py`; also updates `tests_judge_llm_gate.py` regex window from 4000→8000 so the block containing new clean-lap reset consumers still matches).

(historical) Third-pass results:

- `irsdk-bridge/tests_plan_fuel_authority.py` — **15/15 pass** (Monza 35 lap 5 suppress + lap 14 also suppress, selected_plan=B honored, insufficient evidence → safe side, same-frame plan snapshot precedes authority)
- `tests-fuel-plan-authority.js` — **21/21 pass** (JS mirror updated for suppression at target lap; selected_plan honored)
- `tests-lap-readout-policy.js` — **35/35 pass** (four policies with telemetry, missing telemetry trace, legacy-value fallback, full UI wiring)
- `tests-operational-followup-idempotency.js` — **8/8 pass**
- `tests-personal-best-under-p0.js` — **11/11 pass**
- Prior (unchanged): `tests-strategy-playbook-material-change.js` **11/11**, `tests-strategy-lifecycle-suppression.js` **9/9**, `tests-memory-action-layer.js` **22/22**, `tests-strategy-playbook.js` **32/32**, `tests-speak-async.js` **18/18**, `tests-engineer-card.js` **79/79**, `tests-fuel-authority.js` **25/25**, `tests-strategy-guard.js` **40/40**, `tests-telemetry-truth-gate.js` **50/50**, `tests-radio-brevity.js` **30/30**, `tests-memory-wiring.js` **13/13**.
- All 29 Python bridge suites (`irsdk-bridge/tests_*.py`) — **OK**.

(historical) Second-pass results:

- `irsdk-bridge/tests_plan_fuel_authority.py` — **12/12 pass**
  - Monza 35 lap 5: authority denies P0, `suppression_reason='plan_window_reachable'`, `reach_pit_margin_l>0`.
  - Full 10-lap timeline sweep (laps 5–14): denies on every intermediate lap, permits on lap 14 with `override_reason='plan_pit_window_reached_or_passed'`.
  - `strategy_plan_decision` fires exactly once at the target lap.
  - Bridge wiring: `plan_fuel_authority` imported, evaluated before the broadcast site, gated by `_plan_authority_permits`, and traced as `PLAN FUEL AUTHORITY` + `dispatch=SUPPRESSED_BY_PLAN_AUTHORITY`.
- `tests-fuel-plan-authority.js` — **20/20 pass** (renderer defense-in-depth guard).
- `tests-strategy-playbook-material-change.js` — **11/11 pass**.
- `tests-strategy-lifecycle-suppression.js` — **9/9 pass**.
- `tests-operational-followup-idempotency.js` — **8/8 pass** (extended with deliver-path session-ending and timeout traces).
- `tests-personal-best-under-p0.js` — **11/11 pass** (extended with `SPEAK_DEFER_DISCARDED` assertion).
- `tests-lap-readout-policy.js` — **23/23 pass** (new).
- `tests-memory-action-layer.js` — **22/22 pass**.
- `tests-strategy-playbook.js` — **32/32 pass**.
- `tests-memory-wiring.js` — **13/13 pass**.
- `tests-radio-brevity.js` — **30/30 pass**.
- `tests-engineer-card.js` — **79/79 pass**.
- `tests-fuel-authority.js` — **25/25 pass**.
- `tests-strategy-guard.js` — **40/40 pass**.
- `tests-telemetry-truth-gate.js` — **50/50 pass**.
- `tests-speak-async.js` — **18/18 pass** (sandbox exports the new deferable-kind constants).
- All 29 `irsdk-bridge/tests_*.py` (28 pre-existing + new `tests_plan_fuel_authority.py`) — **all OK**.

Not caused by Build 265 (pre-existing failure, independently verified by `git stash` + rerun on `main`):
- `tests-five-day-access.js` — expects 7 `applyPitwallAccess(...)` calls in renderer, current tree has 10. Same failure exists on the untouched `main` tree. **Not in scope for Build 265**; documented as remaining risk.

## 3. Synthetic trace — Monza 35 integrated event order (bridge-side)

Reproduces the exact event order recorded in the reference log with the Build 265 bridge contract applied. Produced by driving `plan_fuel_authority.evaluate` with the same inputs the bridge holds at the fuel-band dispatch site (see `irsdk-bridge/tests_plan_fuel_authority.py::Monza35FullTimeline`).

Lap 5 (18:55:02 in the log — `FUEL BAND DIAG lap=5 fuel=37.63 avg=3.641 crossings=16 required=58.251 marginL=-20.626 band=critical … clean=3`, and `STRATEGY OPTIONS ready … selected_plan=A plan_a.target_lap=14 plan_a.add_fuel_l≈24.6L`):

```
[bridge] PLAN FUEL AUTHORITY: {"allow_p0_pit_now":false,"override_reason":null,
  "suppression_reason":"plan_window_reachable","plan_id":"A","next_pit_lap":14,
  "laps_to_pit":9,"reach_pit_margin_l":4.861,"planned_add_l":24.6,
  "capacity_fits_plan":true,"finish_margin_after_stop_l":<computed>}
[bridge] FUEL BAND DIAG lap=5 fuel=37.63 avg=3.641 crossings=16 required=58.251
  marginL=-20.626 band=critical prev=None transition=initial_to_critical
  warn=True dispatch=SUPPRESSED_BY_PLAN_AUTHORITY reason=warning_candidate clean=3
```

Consequence:
- `broadcast(fuel_strategy_warning)` is **not called**. The director never sees the event; budget is not charged; no JP/EN/DE/BR character speaks it.
- The band dedupe is not committed (dispatch was not `True`/`'DISPATCHED'`), so the next frame re-evaluates. As soon as the plan becomes unreachable, the gate flips and the P0 fires without needing a band edge.
- The plan-decision path continues to own the planned pit call at lap 14 as before.

Laps 6–13 (same fuel-band verdict on each frame):

```
[bridge] PLAN FUEL AUTHORITY: {"allow_p0_pit_now":false,
  "suppression_reason":"plan_window_reachable","plan_id":"A",...}
[bridge] FUEL BAND DIAG lap=N … dispatch=SUPPRESSED_BY_PLAN_AUTHORITY reason=warning_candidate
```

Every intermediate lap denies with the same reason — proved by `test_bridge_dispatch_timeline_matches_expected_pattern`.

Lap 14 (the planned pit — driver has burned down from 37.63L to ~4.75L over 9 laps):

```
[bridge] PLAN FUEL AUTHORITY: {"allow_p0_pit_now":true,
  "override_reason":"plan_pit_window_reached_or_passed","plan_id":"A",
  "next_pit_lap":14,"laps_to_pit":0,"planned_add_l":24.6,"capacity_fits_plan":true}
[bridge] STRATEGY OPTIONS decision: snapshot_id=initial:2:588.567 selected=A|B
  reason=baseline_fuel_plan|plan_b_fuel_reserve_not_met decision_id=...
  dispatch=DISPATCHED evidence={fuel_after_extension_l:...,fuel_safe_for_plan_b:...}
```

Exactly one `strategy_plan_decision` broadcast — proved by `test_plan_decision_fires_exactly_once_at_target_lap`.

If plan A stayed selected the driver hears once, from Luna's translated frame in `injectRadio`:

> 燃料タイミングは基準案。この周でピット、給油設定 22 リットル。

The renderer defense-in-depth guard (`FUEL_PLAN_GUARD` trace) mirrors this decision even if a downstream refactor ever moved the gate; the bridge contract is authoritative and runs first.

## 4. Synthetic trace — P0 and personal best do not silently conflict

Reproduces the 18:55:02 concurrent events (log lines 1179-1188) with Build 265 in place. Only the queue behavior is shown; both events are inserted with their original priorities.

Queue timeline:

```
T0     speak(personal_best, prio=P2, kind='personal_best', ts=T0)
T0+ε   speak(fuel_strategy_warning, prio=P0, kind='fuel_strategy_warning', ts=T0+ε)
       -> currentSpeakItem is null (nothing playing yet)
       -> sort keys queue: [P0 fuel_strategy_warning, P2 personal_best]
T1     drainQueue picks P0, plays, sets currentSpeakItem={kind:'fuel_strategy_warning',prio:0}
T1+Δ   onUtteranceDone clears currentSpeakItem, drainQueue picks P2 personal_best
T2     personal_best plays to completion
```

If instead the personal_best had already started when the P0 arrived:

```
T0     speak(personal_best, prio=P2)  -> currentSpeakItem={kind:'personal_best',prio:2}, plays
T0+Δ   speak(fuel_strategy_warning, prio=P0)
       interrupt path detects prio<=P1 and currentSpeakPrio>prio
       SPEAK_DEFER_KINDS contains 'personal_best' and defer_count=0 < 1
       -> speakQueue.push({...personal_best, ts:now, dedupeKey:'deferred_personal_best_...', _deferCount:1})
       -> diagnosticLog('SPEAK_DEFERRED', 'kind=personal_best by=P0 incoming=fuel_strategy_warning defer_count=1')
       -> stopCurrentAudio() -> P0 fires immediately
T1     P0 completes -> drainQueue picks the deferred personal_best
T2     personal_best plays once
```

The `_deferCount` cap keeps a P0 storm from re-queueing the same PB endlessly; the second concurrent P0 would drop the PB with a trace, never silently.

## 5. Remaining unsupported paths and risks

- Explicit driver "quiet" spoken command remains **UNSUPPORTED** as a separate intent (documented in the audit matrix). The existing budget factor is the only quiet path.
- Tyre temperature during racing remains a documented iRacing limitation (values only surface at pit release); the reply itself says so.
- The bridge gate's `finish_margin_after_stop_l` uses `plan_a.remaining_crossings_after_stop` when available. If that field is null the gate cannot detect a "planned service cannot finish" case that is not already caught by capacity. The fallback is the plan-agnostic fuel-band warning, which still fires because the gate only suppresses cases the plan genuinely reaches; a true emergency is never silently suppressed.
- `tests-five-day-access.js` counts entitlement wiring in `renderer.html` and expects 7 while the current tree has 10 (pre-existing on `main`, not caused by Build 265). Needs a separate updater pass.
- The Lap Readout gate honours the driver's UI choice only when the contract is **signed**. Unsigned drivers keep the previous pass-through behaviour so no existing user is silently silenced by this change. Once a driver signs, all four policies are enforced deterministically.

## 6. What Build 265 does NOT do

- Does not commit, push, tag, package or publish anything.
- Does not touch the public `desktop-latest` release channel.
- Does not modify bridge Python (fuel_strategy.py, race_lifecycle.py, bridge.py); the plan-awareness lives in the renderer, which owns the active playbook state.
- Does not raise personal_best above P0 safety. The deferred delivery preserves the existing priority ordering.
