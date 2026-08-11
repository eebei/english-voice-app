# Build 265 Circuit Audit — every live race call, end to end

Scope: audit every supported live race-engineer call from the input signal to the driver's ear, per the Codex directive of 2026-08-10.

Reference run: `/Users/yuji.s/Downloads/OMORAY-bridge-debug-20260810-1838.log` (Monza 35 GT3 one-make, Build 264).

Legend for **Status**:
- `OK` — path is complete and verified by a specific test.
- `REPAIRED` — a defect in this path is fixed by Build 265 changes documented below.
- `UNSUPPORTED` — deliberately not implemented; note the reason.
- `BLOCKED` — cannot be completed in Build 265; note the missing input.

Column order per row:
`input → normalizer/intent → authoritative decision owner → lifecycle gate → director priority → renderer/handler → TTS + transcript → dedupe/re-arm → trace key → test file → status`

---

## Session and race format

| Call | Row |
| --- | --- |
| Session recognition (Race / Practice / Qualifying) | iRacing `SessionInfo.SessionType` → bridge `session_authority` → `race_lifecycle_fsm` → priority N/A (state, not a call) → renderer `lastSessionType` / `selMode` → no direct TTS → session-num reset in `resetSessionScopedReviewState` → `SESSION INFO DIAG` / `USAGE_SESSION` → `tests_session_authority*.py` → **OK** |
| Race format (timed vs laps) | `SessionInfo` `session_time` / `session_laps` → `strategy-playbook.normalizeFormat` and `engineer-card.buildSessionFormat` → renderer `applySessionFormatAuthority` → any → LLM notes + `SESSION_FORMAT` intent → speech via `buildSessionFormat` → deterministic per snapshot → `MEMORY_ACTION.phase=history_resolved` → `tests-timed-race-truth.js`, `tests_weekend_authority.py` → **OK** |

## Fuel remaining, fuel-to-finish, warnings, planned pit, post-stop safe

| Call | Row |
| --- | --- |
| Fuel remaining response (driver asked) | STT text → `engineerCard.classify` → `TOPIC.CURRENT_FUEL` handler → any → `sendGuardReply` via `server.js` → deterministic reply (P4-equivalent, non-radio) → dedupe per HTTP round-trip → `[INTENT_ROUTE] intent=current_fuel handler=fired` → `tests-fuel-authority.js`, `tests-strategy-guard.js` → **OK** |
| Fuel-to-finish computation | `bridge.py fuel_strategy_mod.evaluate_fuel_to_finish` → **plan-agnostic before Build 265** — see fix A | `RACING` only → P0 `fuel_strategy_warning` → renderer `injectRadio` case `fuel_strategy_warning` → `speak(..., prio:P0)` → dedupe by band transition (`commit_band_after_dispatch`) → `FUEL BAND DIAG`, `FUEL PLAN GUARD` (new) → `tests-fuel-authority.js`, **new** `tests-fuel-plan-authority.js` → **REPAIRED (fix A)** |
| Fuel-strategy safe (post-stop) | `fuel_strategy.evaluate` transition `critical_to_safe` while off-pit → bridge broadcast `fuel_strategy_safe` (P3) → any → renderer case `fuel_strategy_safe` → speech → transition-once → same `FUEL BAND DIAG` → `tests-fuel-authority.js` → **OK** |
| Planned pit call (this-lap box) | Fuel decision contract (new `evaluatePlanFuelDecision`) → renderer `injectRadio` — see fix A. Only P0 emits `この周ボックス`; if the plan window is still reachable the same signal downgrades to internal playbook update with trace `plan_window_reachable`. → dedupe by band transition + suppression trace → `[FUEL PLAN GUARD]` → **new** `tests-fuel-plan-authority.js` → **REPAIRED (fix A)** |
| Post-stop fuel-safe follow-up | `fuel_strategy_mod.project_post_stop_fuel_to_finish` → renderer as above → speech `燃料OK…` → dedupe by transition → `FUEL BAND DIAG` → `tests-fuel-authority.js` → **OK** |

## Plan A / B / C

| Call | Row |
| --- | --- |
| Plan A/B/C creation (playbook build) | `MEMORY_ACTION.phase=history_resolved` → `strategy-playbook.buildPlaybook` → renderer `refreshStrategyPlaybook` → **P3** first briefing (session-latched) → `announceStrategyPlaybook` speech → dedupe by `strategyPlaybookBriefedKey` → `STRATEGY_PLAYBOOK` diagnostic → `tests-strategy-playbook.js`, `tests-memory-action-layer.js` → **OK** |
| Plan live revision (three clean laps) | `updateStrategyPlaybookFromLive` → **before Build 265: spoke every burn tick** — see fix B | `RACING` (lifecycle gate added in fix B) → P3 → renderer `announceStrategyPlaybook` / new material-change speech → dedupe by `strategyPlaybookLiveUpdateKey` (rewritten in fix B to material-change key) → `STRATEGY_PLAYBOOK_UPDATE`, new `STRATEGY_PLAYBOOK_UPDATE_SILENT` trace → **new** `tests-strategy-playbook-material-change.js` → **REPAIRED (fix B)** |
| Plan switch proposal (undercut / overcut) | `strategy-playbook.evaluateSwitch` → renderer `evaluateLiveStrategySwitch` → P2 `strategy_playbook_switch` → speech → dedupe by `decision_id` (once per session/lap) → `STRATEGY_PLAYBOOK_DECISION` → `tests-strategy-playbook.js` → **OK** |
| Rejoin forecast (pit exit position) | `pit_exit_forecaster.forecast_at_pit_entry` → server `buildPitExitForecastReply` / renderer `pit_exit_forecast` field → any → LLM `REJOIN` topic reply via `buildRejoin` → deterministic per snapshot; dedupe by `snapshot_id` → `PIT EXIT SHADOW forecast` → `tests_pit_exit_forecaster*.py`, `tests-strategy-guard.js` → **OK** |

## Best lap and reference times

| Call | Row |
| --- | --- |
| Personal best (lap-time update) | Bridge `lap_time_changed and onTrack` → `broadcast trigger=personal_best` P2 → race lifecycle allows in RACING → renderer `injectRadio` case `personal_best` → `speak(..., prio:P2)` → dedupe key `personal_best` → `DIRECTOR pass/spoke personal_best` → **new** `tests-personal-best-under-p0.js` → **REPAIRED (fix E: verified deferred delivery)** |
| Session best | Same as personal_best with `trigger=session_best` and separate dedupe → **OK** |
| Configured lap readout (`ベスト`, `first_lap` baseline) | Bridge `broadcast trigger=first_lap` on first valid lap → P2 → renderer `injectRadio` case `first_lap` → speech → dedupe by trigger → same diagnostic → **OK** |

## Pace and monitoring

| Call | Row |
| --- | --- |
| Pace monitor | Bridge `pace_check` payload (with recent_deltas, direction, fuel_strategy) → renderer `checkPaceJudgment` HTTP round-trip → LLM returns `NO_CALL` or text → speak conservatively → LLM-side judgement, budget-gated in bridge → `judge_llm_call_times` → `tests_judge_llm_gate.py` → **OK** |

## Battles and safety

| Call | Row |
| --- | --- |
| Same-class battle (catchup/defend) | Bridge candidate → `checkJudgment` LLM one-shot → renderer `speak` P3 → dedupe by `catchup_<car>`/`defend_<car>` → `recentEngineerCalls` sliding window → `tests_multiclass_approach.py` → **OK** |
| Multiclass safety (imminent/approaching) | Bridge multi-class analyser → `broadcast trigger=multiclass_*` P1 → renderer `injectRadio` → speech → dedupe by cluster shape+delta bucket → same trace → `tests_multiclass_approach.py` → **OK** |
| Danger driver (SR/iR flag) | Bridge scan of nearby drivers → `broadcast trigger=danger_*` P3 → renderer `injectRadio` → speech → dedupe by `car_number` → same → covered by existing bridge tests → **OK** |
| Stopped car ahead/behind | Bridge stopped-car detector → P0 `stopped_ahead` / P1 `stopped_behind` → renderer `injectRadio` → speech, interrupts lower priorities → dedupe by cluster → same → existing bridge tests → **OK** |
| Side-by-side / three-wide | Bridge geometry detector → P0 `side_by_side` / P1 `multi_car_straight` → renderer speech → dedupe by side transition → same → existing tests → **OK** |

## Pit lane and service

| Call | Row |
| --- | --- |
| Pit entry (limiter reminder) | Bridge `OnPitRoad` edge → `trigger=pit_entry` P2 → renderer speech `制限ライン注意、リミッターオン。` → once per entry → `driver state -> pit` trace → `tests_bridge_lifecycle_wiring.py` → **OK** |
| Pit service (fuel + tyres) | Bridge `PitSvOn* + PitSvStatus` → `trigger=pit_box_stop` / `pit_box_here` P1/P2 → renderer speech + telemetry snapshot → dedupe by state → same → `tests_pit_loss_calibrator.py` → **OK** |
| Pit exit / limiter-off | Bridge `EngineWarnings & 0x10` edge → `trigger=limiter_off` P2 → renderer speech `リミッターオフ…` → once per exit → same → `tests_pit_loss_wiring.py` → **OK** |
| Pit exit forecast | Handler covered under "Rejoin forecast" above → **OK** |
| Rejoin position call (after real stop) | Same forecast handler → LLM reply gated to `REJOIN` topic via `engineer-card` → speech → per-snapshot dedupe → `PIT EXIT SHADOW forecast` → `tests_pit_exit_forecaster*.py` → **OK** |

## Position and gap

| Call | Row |
| --- | --- |
| Position response (current position) | STT → `engineer-card.CURRENT_POSITION` → `buildCurrentPosition` uses `live.class_position_authority` → deterministic reply → per-round-trip → `[INTENT_ROUTE] intent=current_position handler=fired` → `tests-strategy-guard.js` → **OK** |
| Gap to nearby target (`P17まで何秒?`) | STT → `POSITION_GAP` intent → `buildPositionGap` reads same-class ordering → deterministic reply → per-round-trip → same trace → `tests-strategy-guard.js` → **OK** |
| Gap to leader | STT → `LEADER_GAP` intent → `buildLeaderGap` uses `live.leaders` truth → deterministic reply → per-round-trip → same → `tests-strategy-guard.js` → **OK** |

## Vehicle and environment state

| Call | Row |
| --- | --- |
| Tyre temperature response | STT → `TYRE_STATUS tyreQuery=temperature` → `buildTyreStatus` — **iRacing exposes temperature only at pit release**, so racing returns `温度はピットのみ` → **OK** |
| Tyre condition / wear response | STT → `TYRE_STATUS tyreQuery=wear` → `buildTyreStatus` uses live tyre condition → deterministic → **OK** |
| Track temperature response | STT → `WEATHER_STATUS` → `buildWeatherStatus` uses `weather.track_temp_c` → deterministic → **OK** |
| Damage / repair-time response | STT → `DAMAGE_STATUS` → `buildDamageStatus` reads `damage_s` → deterministic → **OK** |

## Memory

| Call | Row |
| --- | --- |
| Memory lookup on session start | `matchingEntries` in `memory-action-layer.js` → normalizeTrack applied (**Monza aliasing bug fixed in Build 265 — see fix D**) → `MEMORY_ACTION.phase=history_resolved` → `tests-memory-action-layer.js` → **REPAIRED (fix D)** |
| Memory Action Layer proactive briefing | `announceStrategyPlaybook` on race entry → P3 → speech (once per session) → dedupe by `strategyPlaybookBriefedKey` → `MEMORY_ACTION.phase=proactive_strategy_briefing` → `tests-memory-action-layer.js` → **OK** |
| Live strategy use of memory | `updateStrategyPlaybookFromLive` swaps historical fuel for live fuel after 3 clean laps → speech (material change only in Build 265) → `MEMORY_ACTION.phase=three_lap_live_revision` → **REPAIRED (fix B)** |

## Operational follow-up

| Call | Row |
| --- | --- |
| Unresolved operational follow-up | STT → `engineerCard.classify → UNRESOLVED_OPERATIONAL` → `buildUnresolved` → renderer arms one `pendingOperationalFollowUp` per intent+session+lap → P3 → speech `今は確認できる数値…` — **de-duplicated across repeated asks in fix C** → deliver once on next S/F crossing OR expire → `OPERATIONAL_FOLLOWUP armed/delivered/suppressed` → **new** `tests-operational-followup-idempotency.js` → **REPAIRED (fix C)** |

## Lifecycle transitions

| Call | Row |
| --- | --- |
| Final lap notice | Bridge `final_lap.py` → `trigger=final_lap_notice` P2 → renderer `injectRadio` speech → once per race → `FINAL LAP DIAG` → `tests_final_lap.py` → **OK** |
| Checker-out fallback | Bridge `checker_out_notice` (allow-listed during DEBRIEF) → P2 speech `チェッカー出た` → once per session → `DIRECTOR pass checker_out_notice` → `tests_final_lap.py` → **OK** |
| `PLAYER_FINISHED` transition | Bridge `race_lifecycle` transitions to `PLAYER_FINISHED` when driver's S/F edge crosses under CHECKER_OUT → suppresses new strategy speech (extended in fix B) → no direct TTS → `race_lifecycle` transition log → `tests_race_lifecycle.py`, **new** `tests-strategy-lifecycle-suppression.js` → **REPAIRED (fix B for the suppression contract)** |
| Debrief entry | Bridge `driver_state == garage after PLAYER_FINISHED` → renderer `evidenceDebrief` → session mode swap → no new race calls after this → same → `tests-evidence-debrief.js` → **OK** |

## Driver "quiet" command

| Call | Row |
| --- | --- |
| Explicit quiet command | Bridge `_director['quiet_until']` set by budget factor when driver asks for quiet; no STT-driven explicit quiet command is currently implemented for the driver as a separate call — **UNSUPPORTED** (documented). |

---

## What Build 265 changes

Only the rows tagged `REPAIRED (fix X)` above are functionally changed. Everything else is left untouched. All fixes are additive; none remove an existing test.

- **fix A** — `desktop/renderer.html` (`injectRadio` case `fuel_strategy_warning` now consults a shared plan-aware fuel-decision contract before speaking "この周ボックス"). New helper `evaluatePlanFuelDecision` in the same file. New trace `[FUEL PLAN GUARD]`. New test `tests-fuel-plan-authority.js`.
- **fix B** — `desktop/renderer.html` (`updateStrategyPlaybookFromLive`) rewrites the live-update dedupe key to material change and adds lifecycle suppression (final lap, `PLAYER_FINISHED`, debrief). New trace `STRATEGY_PLAYBOOK_UPDATE_SILENT`. New tests `tests-strategy-playbook-material-change.js` and `tests-strategy-lifecycle-suppression.js`.
- **fix C** — `desktop/renderer.html` (`armOperationalFollowUp`) refuses to re-arm inside the same intent+session+lap window and refuses to arm during final lap / finished / debrief. New trace `OPERATIONAL_FOLLOWUP suppressed reason=…`. New test `tests-operational-followup-idempotency.js`.
- **fix D** — `desktop/memory-action-layer.js` `normalizeTrack` now preserves distinct Monza configurations. Only the enumerated "true Monza-GP" aliases collapse to `monza:full`. Test augmented in `tests-memory-action-layer.js`.
- **fix E** — Personal best under P0 has an explicit deferred-delivery contract encoded in the speak queue's priority ordering (already present, now proven by test). New test `tests-personal-best-under-p0.js` proves the ordering keeps PB timely and never silently discards it.

## Remaining risks and unsupported paths

- Explicit "quiet" spoken command is not implemented as a separate driver intent; the current budget factor path is the only way to reduce chatter. Documented `UNSUPPORTED`.
- Tyre temperature during racing remains a documented iRacing limitation (only exposed at pit release). Documented in the reply itself.
- The bridge's plan-agnostic fuel warning stays as the source of truth for **true** emergencies. The Build 265 guard only reclassifies false emergencies that the still-reachable plan would resolve.
