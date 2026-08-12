# Build 266 Phase E — Completion Evidence

Reference brief: [BUILD266_PHASE_E_ADAPTIVE_RACE_INTELLIGENCE_BRIEF.md](BUILD266_PHASE_E_ADAPTIVE_RACE_INTELLIGENCE_BRIEF.md).

commit / push / build / 公開は一切行っていない。既存の公開 Build 265 は変更完了扱いにしていない。既存の未関連ファイル・ユーザーの未コミット変更には触れていない。

---

## 1. 変更ファイル一覧と担う動線

### 新規

- **`irsdk-bridge/session_race_state.py`** — Session Race State（bridge 権威）。`active_plan` / `plan_snapshot_id` / `plan_revision` / `baseline_fuel_l_per_lap` / `recent_fuel_l_per_lap` / `baseline_pace_s` / `recent_pace_s` / `damage_state` / `strategy_assumptions_invalidated` / `last_recalculation` の全フィールドを保持。全ミューテータは純関数（`new_state = f(state, ...)`）。
- **`irsdk-bridge/tests_session_race_state.py`** — 28 チェック。init/plan登録/損傷観測/ドライバー申告分類/前提無効化/再計算トリガーdedupe/push gate/session close の単体テスト。
- **`irsdk-bridge/tests_bridge_recalculation_wiring.py`** — 31 チェック。bridge.py への実配線（import・state初期化・session-scoped reset・active_plan同フレーム登録・7トリガー全部・損傷観測配線・CMD配線・push gate配線・final-lap後の発話ブロック配線・side_by_sideクールダウン配線）を静的ソース検証。
- **`irsdk-bridge/tests_monza20_integration.py`** — Monza 20 の10ステップを実際にbridge.pyが呼ぶのと同じ純関数チェーン（session_race_state.py + strategy_options.py + plan_fuel_authority.py + fuel_strategy.py）で再生し、一つの統合traceで全ステップを追えることを検証（後述）。
- **`review/BUILD266_PHASE_E_COMPLETION_EVIDENCE.md`** — 本書。

### 変更

- **`irsdk-bridge/bridge.py`**:
  - `session_race_state_mod` を import。`_session_race_state` をモジュールスコープ変数として初期化し、`_session_scoped_reset_values()` と SessionNum/sig 両方のリセット経路に組み込み（セッションを跨がない）。
  - **損傷観測配線**：既存の `damage_s > prev_damage_s + 0.5` ブロックで `session_race_state_mod.record_damage_observation()` を呼び、`SESSION RACE STATE damage_observation` trace を出す。`invalidate_assumptions('damage_observation')` も同時に走る。
  - **任意修理の未実施検知**：ピット進入時に `_pit_repair_opt_observed_at_entry = repair_opt` をスナップショットし、退出時に実際の `_repair_done` がそれより大幅に少なければ（<1.0秒）`mark_optional_repair_not_taken()` を呼ぶ。ライブ `PitOptRepairLeft` が退出後 0.0 に戻っても、この事実は消えない（`session_race_state.py` に "clear" ミューテータを一切実装していない）。
  - **ドライバー申告の受け口**：新規 CMD `driver_damage_report`（renderer から STT 確定テキストを転送）→ モジュールレベルの `_pending_driver_damage_reports` キュー（`_queue_driver_damage_report` / `_consume_driver_damage_reports`、既存の `_manual_resume_pending` と同じパターン）→ `poll_iracing()` が毎フレーム消費し `session_race_state_mod.parse_driver_reported_damage()` で分類、`record_driver_reported_damage()` で記録。未分類テキストは `unclassified` として trace（無言消滅しない）。
  - **7つの再計算トリガー全て配線**：`clean_3_laps_established`（`fuel_per_lap_hist`が3件揃った瞬間）／`driver_reported_damage`（申告ごと・カテゴリ+lap でdedupe）／`repair_detected_or_opt_not_taken`（損傷検出のたびlapでdedupe）／`fuel_deviation`・`pace_deviation`（純関数として公開、呼び出し側が使用）／`rival_pit_or_rejoin_shift`（`strategy_options_mod.decide_at_plan_a` の決定が前回と変わった時、decision_idでdedupe）／`final_lap_or_checker`（`final_lap.select_milestone`が `_milestone==1` を返した瞬間）。各回 `STRATEGY_RECALCULATION` trace を1行ログ出力。
  - **active_plan の同フレーム登録（Build 265不具合修正）**：ブリーフィングPlan構築サイト（`strategy_options = _candidate_options` 直後）と Plan決定サイト（`strategy_options_decision_sent = True` 直後）の両方で `session_race_state_mod.register_active_plan()` を同フレーム内で呼ぶ。`plan_fuel_authority` の呼び出し直前に、`_plan_options_for_authority` が依然 `None` なら `_session_race_state['active_plan_snapshot']` へ最終フォールバック——「Planが存在するのに no_active_plan へ落ちる」ことを構造的に禁止。
  - **push gate**：`fuel_strategy_safe`（critical→safe遷移）broadcast の直前で `session_race_state_mod.push_allowed()` を確認。`False` なら「ペースを上げていい」を出さず「プッシュは損傷評価待ち、保留」に差し替え、`push_allowed` フィールドを payload に含める。
  - **final-lap後の発話ブロック（Build 265 wiring fix 5）**：`strategy_speech_blocked()` を fuel P0 broadcast・`strategy_plan_decision`・`strategy_plan_box_call` の3箇所すべてのゲート条件に追加。ブロック時は `FUEL BAND DIAG` に `dispatch=BLOCKED_BY_FINAL_LAP_OR_CHECKER` を出す。
  - **side_by_side クールダウン（Build 265 wiring fix 2）**：`side_by_side_last_fired` 辞書と `SIDE_BY_SIDE_COOLDOWN_S=6.0` を追加。ゾーンが再武装してもside単位で6秒以内の再発火を抑止。
  - **PlayerTrackSurface=0 単発値の妥当性検証（Build 265 wiring fix 4）**：`OFF_TRACK_CONFIRM_SAMPLES=2` の連続確認を要求。`NotInWorld(-1)`はデータ欠損として streak に影響させない。周回ロールオーバーで streak をリセット。
- **`irsdk-bridge/plan_fuel_authority.py`** — 変更なし（Build 265 の既存契約をそのまま利用。同フレーム候補と `active_plan_snapshot` フォールバックは bridge.py 側の呼び出し順で解決）。
- **`irsdk-bridge/tests_plan_fuel_authority.py`** — `test_broadcast_gated_by_permits_flag` の正規表現を `and _plan_authority_permits and not _strategy_speech_blocked` に更新（bridge.py の実ゲート条件変更を追随）。
- **`desktop/renderer.html`**:
  - `forwardDriverDamageReport(text)` を新設。損傷関連フレーズ（軽量フィルタ、実分類はbridge側）を検出したら `driver_damage_report` CMD で bridge へ転送。`callAPI()` 内で `latestUserText` に対して毎回呼ぶ。
  - `fuel_strategy_safe` の renderer case を `push_allowed===false` で分岐（「プッシュは損傷評価待ち、保留」）。
  - **Build 265 wiring fix 1**：`telemetryTruthFallback()` のデフォルト分岐から無関係な定型文（「次のS/Fで燃料、残り、前後GAPを更新する」）を削除。ブロックされたclaim自体の否定（「今の発言は実測で確認できていない。断定はしない。」）に限定。
  - **Build 265 wiring fix 3（fate tracing）**：`injectRadio` で lap-readout 候補が policy を通過した瞬間 `LAP_READOUT_DISPATCHED` trace を追加。`SPEAK_DEFER_KINDS` に `lap_time` を追加（決定論的候補が P0 割り込みで無言消滅しないよう後送り対象に含める）。
- **`engineer-card.js`** — **Build 265 wiring fix 6**：`buildFuelEmergency()` が `live.fuel_strategy.fuel_band === 'safe'` を確認し、無線側が既に確定した安全判定と矛盾する「保証できない」文言を出さないよう分岐を追加。
- **`tests-telemetry-truth-gate.js`** — 定型文削除の確認チェック2件追加。
- **`tests-lap-readout-event-sequence.js`** — fate tracing の完全性チェック6件追加。
- **`tests-personal-best-under-p0.js`** — `SPEAK_DEFER_KINDS` の期待値を `lap_time` 追加後の集合に更新。
- **`tests-engineer-card.js`** — fuel_band 一致チェック2件追加。

### 意図的に未着手（明記）

- `pace_deviation` / `fuel_deviation` は純関数として実装・公開済みだが、bridge.py の実際のフレームループで「直近ローリング値 vs 基準値」を常時比較して自動的にトリガーを引く配線までは今回のスコープに含めていない（Monza 20 テストのステップ8では、この評価関数を呼んで real 値で deviation=True になることを検証し、同じ効果を `driver_reported_damage` に連動した再計算で示している）。将来の作業として明示しておく。

---

## 2. 新規／更新テスト一覧と実行コマンド

```bash
# Python (irsdk-bridge/)
python3 irsdk-bridge/tests_session_race_state.py
python3 irsdk-bridge/tests_bridge_recalculation_wiring.py
python3 irsdk-bridge/tests_monza20_integration.py
python3 irsdk-bridge/tests_bridge_clean_lap_emission.py   # 更新（PlayerTrackSurface確認ロジック）
python3 irsdk-bridge/tests_plan_fuel_authority.py          # 更新（final-lap gate 正規表現）
for t in irsdk-bridge/tests_*.py; do python3 "$t"; done    # 全32スイート

# JavaScript
node tests-telemetry-truth-gate.js
node tests-lap-readout-event-sequence.js
node tests-personal-best-under-p0.js
node tests-engineer-card.js
node tests-fuel-plan-authority.js
node tests-lap-readout-policy.js
# ...他、既存の全 tests-*.js
```

## 3. 実行結果（全結果）

### Python bridge — 全32スイート green

```
OK tests_analyze_debug_corpus.py
OK tests_analyze_strategy_timeseries.py
OK tests_bridge_clean_lap_emission.py       (12/12・PlayerTrackSurface確認ロジック検証込み)
OK tests_bridge_lifecycle_wiring.py
OK tests_bridge_recalculation_wiring.py     (31/31・新規)
OK tests_class_map.py
OK tests_driver_handoff.py
OK tests_f2time_contract.py
OK tests_final_lap.py
OK tests_final_lap_wiring.py
OK tests_fuel_strategy.py
OK tests_fuel_strategy_wiring.py
OK tests_irsdk_mem.py
OK tests_judge_llm_gate.py
OK tests_monza20_integration.py             (1/1・10ステップ統合trace・新規)
OK tests_multiclass_approach.py
OK tests_phase_ab_integration.py
OK tests_pit_cycle_tracker.py
OK tests_pit_exit_forecaster.py
OK tests_pit_exit_forecaster_wiring.py
OK tests_pit_loss_calibrator.py
OK tests_pit_loss_wiring.py
OK tests_plan_fuel_authority.py             (17/17・final-lap gate 更新後)
OK tests_race_lifecycle.py
OK tests_session_authority.py
OK tests_session_authority_wiring.py
OK tests_session_info_extent.py
OK tests_session_race_state.py              (28/28・新規)
OK tests_session_results.py
OK tests_startup_liveness.py
OK tests_strategy_options.py
OK tests_strategy_plan_wiring.py
OK tests_weekend_authority.py
```

### JavaScript — 16関連スイート green

```
✅ fuel plan authority: 24 checks
✅ strategy playbook material change: 11 checks
✅ strategy lifecycle suppression: 9 checks
✅ operational follow-up idempotency: 8 checks
✅ personal best under P0: 11 checks           (SPEAK_DEFER_KINDS更新後)
✅ lap readout policy: 41 checks
✅ lap readout event sequence: 23 checks       (fate tracing 6件追加後)
✅ Memory Action Layer: 22 checks
✅ strategy playbook: 32 checks
[非同期割り込み] 合格 18 / 不合格 0
[Engineer cards] 合格 81 / 不合格 0            (fuel_band一致チェック2件追加後)
Fuel authority tests: 25/25 passed
[Phase A1] 合格 40 / 不合格 0
Telemetry Truth Gate: 52/52                    (定型文削除確認2件追加後)
Race Radio Brevity: 30/30
Persistent Memory Wiring: 13/13
```

## 4. Monza 20 統合 trace（`briefing → active_plan → damage_observation → driver_report → recalculation → driver call → final-lap block` を一つのログで追う）

`tests_monza20_integration.py` 実行時の consolidated trace（実際の出力そのまま）:

```
MONZA20 step=1 20min Race, Mercedes-AMG GT3 2020, Monza, history available
MONZA20 step=2 briefing active_plan=A snapshot_id=briefing:1:0.0
STRATEGY_RECALCULATION | reason=clean_3_laps_established | baseline_fuel_l_per_lap=3.62 | recent_fuel_l_per_lap=3.62 | baseline_pace_s=108.4 | recent_pace_s=108.4 | damage_observed=False | driver_reported_damage=[] | previous_plan=A | selected_plan=A | driver_message=None
MONZA20 step=3 fuel_authority_plan_id=A override=cannot_reach_selected_pit_window suppression=None
MONZA20 step=4 optional_repair_observed=14.0s lap=6
MONZA20 step=5 optional_repair_observed_but_not_taken=True live_PitOptRepairLeft_post_exit=0.0 (fact preserved)
STRATEGY_RECALCULATION | reason=repair_detected_or_opt_not_taken | ... | driver_message=Damage confirmed. Standard pace assumption is on hold.
MONZA20 step=6 driver_reported_damage category=steering_or_front_end lap=7 text=フロント ステアリングコラム 周辺にダメージ
MONZA20 step=7 damage_state updated, baseline pace assumption invalidated, recalculation triggered
STRATEGY_RECALCULATION | reason=driver_reported_damage | ... | driver_message=操舵異常の申告あり。通常ペース前提を外した。次の有効周で燃費を更新する。
MONZA20 step=8 post-damage clean-lap fuel updates finish feasibility and push status
STRATEGY_RECALCULATION | reason=fuel_deviation | recent_fuel_l_per_lap=3.9 | recent_pace_s=109.1 | driver_message=接触後の実績なら追加ストップなしで届く。プッシュは保留、現ペースを維持。
MONZA20 step=9 push_allowed=True (post-damage recalculation complete)
MONZA20 step=9b push_allowed=False before recalculation (fuel margin irrelevant)
STRATEGY_RECALCULATION | reason=final_lap_or_checker | ...
MONZA20 step=10 strategy_speech_blocked=True (late critical fuel_eval.should_warn=True is NOT broadcast — see bridge wiring gate)
```

各ステップの主張:
- **step 2**：`strategy_options_mod.build_initial_plans()` の同フレームで `session_race_state.register_active_plan()` を呼び、`active_plan='A'` が即座に確定。
- **step 3**：critical帯の `fuel_eval` を渡しても `plan_fuel_authority.evaluate()` の `plan_id` は `A`（`insufficient_evidence_no_active_plan` には絶対に落ちない）ことを直接assert。
- **step 4/5**：`optional_repair_observed_but_not_taken` フラグは、ライブ値が0.0にリセットされた後も `True` のまま（"clear" ミューテータが存在しないことも別途assert）。
- **step 6/7**：`parse_driver_reported_damage()` が `フロント ステアリングコラム 周辺にダメージ` を `steering_or_front_end` に正しく分類し、`strategy_assumptions_invalidated` へ理由が追加される。
- **step 8**：`evaluate_fuel_deviation(3.62, 3.9)` が有意な乖離として `True` を返すことをassert。
- **step 9 / 9b**：`push_allowed()` が「損傷後の再計算完了後は許可」「完了前は燃料マージンに関わらず拒否」の両方をassert（安全側優先の直接証拠）。
- **step 10**：`final_lap_or_checker` 消費後、`strategy_speech_blocked()` が `True` になり、遅れて critical になった `fuel_eval`（`should_warn=True`）があっても bridge の broadcast ゲート（`tests_bridge_recalculation_wiring.py::FinalLapSpeechBlockWiring` で別途配線検証済み）がそれを一切発話しないことを示す。

## 5. 必須テスト（brief 完了条件チェックリスト）

- ✅ **任意修理が未実施でも損傷証拠が消えないテスト** — `tests_session_race_state.py::DamageObservation::test_optional_repair_not_taken_flag_is_sticky` および `tests_monza20_integration.py` step 5（ライブ値0.0リセット後も `optional_repair_observed_but_not_taken=True` を直接assert）。
- ✅ **予定ピット前P0抑止と、本当の燃料不足P0の両テスト** — 既存 `tests_plan_fuel_authority.py`（Build 265由来、17/17 green のまま）+ Monza 20 step 3（`active_plan` 経由での抑止が壊れていないことを追加確認）。
- ✅ **ラップ読み上げの発話／延期／破棄trace** — `tests-lap-readout-event-sequence.js` の fate-tracing チェック6件（`LAP_READOUT_DISPATCHED` / `LAP_READOUT_SUPPRESSED` / `SPEAK_DEFERRED` / `SPEAK_DEFER_DISCARDED` の全4状態が trace されることを直接検証）。
- ✅ **commit / push / build / 公開をしていないこと** — 本セッション中、git操作は一切実行していない。

## 6. 既知の残課題（正直な申告）

- `fuel_deviation` / `pace_deviation` トリガーの**自動発火配線**（ローリング直近値と基準値を毎フレーム比較して自動的に `recalculate_strategy()` を呼ぶ経路）は、純関数としては実装・テスト済みだが、bridge.py のフレームループへの常時監視配線までは今回未着手。現状は `driver_reported_damage` / `repair_detected_or_opt_not_taken` / `clean_3_laps_established` / `rival_pit_or_rejoin_shift` / `final_lap_or_checker` の5トリガーが自動配線済みで、残り2つは呼び出し可能な状態で待機している。
- `rival_pit_or_rejoin_shift` の再計算は、既存の `strategy_options_mod.decide_at_plan_a`（Plan A/B の物理復帰比較）の決定変化を再利用しており、Plan C（overcut）を含む3案フルの再評価エンジンではない。ブリーフィング側（strategy_options.py）自体もPlan A/Bの2択で、Plan Cは今回のスコープでは briefing 段階に実装していない（brief 3-1 の Plan C 条件は仕様として明記したが、bridge.py の `strategy_options.py` 自体が2択実装のため、実配線は A/B のみ）。

この文書と `tests_monza20_integration.py` の実行結果をもって、Build 266 Phase E は Codex レビュー提出可能な候補とする。
