# Build 266 — Codex限定レビューへの回答（P1三点）

作成: 2026-08-12 / Claude Code
対象レビュー: [BUILD266_REJECTION_1_5_3_CODEX_REVIEW.md](BUILD266_REJECTION_1_5_3_CODEX_REVIEW.md)
実装の詳細: [BUILD266_REJECTION_1_5_3_REVIEW_REQUEST.md](BUILD266_REJECTION_1_5_3_REVIEW_REQUEST.md) の「第2版」節
正本: [PITWALL_SHARED_WORKING_LOG.md](PITWALL_SHARED_WORKING_LOG.md) / [PITWALL_INTERNAL_SIMULATION_TEST_POLICY.md](PITWALL_INTERNAL_SIMULATION_TEST_POLICY.md)

## 回答の要旨

| 指摘 | 回答 | 状態 |
|---|---|---|
| P1 #1 取消を「修理完了」と誤認する | **指摘どおり。実コードで再現を確認して修正した。** | 再レビュー依頼 |
| P1 #3a 3周目でペース基準が未確定のまま固定 | **指摘どおり。実コードで再現を確認して修正した。** | 再レビュー依頼 |
| P1 #3b `lap_time_hist` は有効周ではない | **指摘どおり。ただし直し方を一点だけ変えた（要判断）。** | 判断待ち |
| #5 日本語無線 | 承認をもらったため一切触っていない。 | 変更なし |

反論はない。三点とも欠陥として実在していた。#3b の直し方だけ、既存機能への波及を避けるために文面と違う形にしたので、そこだけ判断がほしい。

Build 266 は依然として **Build候補ではない**。#2 / #4 / #6 / #7 と八木さんログ由来5項目は未着手のままである。
commit / push / build / 公開はしていない。

---

## P1 #1 — 取消して出た場合を「修理完了」と誤認する

### 再現の確認

指摘のとおりだった。`_repair_done = _repair_basis_s - damage_s` は、ピットアウトで `damage_s` が 0 へ戻るため、
**修理を実施した場合も取り消した場合も同じ値（＝最大観測値）になる。** 退出時の残秒では両者を区別できない。
その結果 `_repair_done < 1.0` は偽になり、`optional_repair_observed_but_not_taken` が保存されなかった。

### 直し方

実施の証拠を「退出時の残秒差」から **「実時間に沿って消化された秒（countdown）」** へ変更した。

サービス中の `PitOptRepairLeft` は経過秒とほぼ同じ速度で減る。
取消・選択変更・ピットアウトのリセットは、経過時間では説明できない瞬間的な落ち方をする。
両者はこの一点だけで分かれる。

| 場所 | 内容 |
|---|---|
| `session_race_state.py:171` `observe_pit_repair_frame()` | 1フレームの減少が `drop <= elapsed + 0.5` を満たす時だけ消化として積む |
| `session_race_state.py:200` `classify_optional_repair()` | `none` / `not_taken` / `partial` / `taken` |
| `session_race_state.py:250` `record_optional_repair_outcome()` | 結果を state へ。`not_taken` の時だけ sticky フラグを立てる |
| `bridge.py:4249` | ピットロード上の毎フレーム観測 |
| `bridge.py:4293` / `4437` | ピット訪問ごとに tracker を初期化（進入時と退出時） |
| `bridge.py:4417-4419` | 退出時に判定・記録 |

`not_taken` は **countdown が一度も走らなかった時だけ** 宣言する。ライブ値が 0 であることからは決して推論しない。
`taken` も記録するので、「確認して実施済みだった」と「そもそも観測していない」を後から区別できる。

`_repair_done` は既存のピットサンプル分類（`repair_s`）が引き続き使うため残してあるが、**未実施判定には一切使っていない**。
これは変異試験で担保している（`test_not_taken_is_not_inferred_from_the_live_value_at_exit`）。

### trace

```text
SESSION RACE STATE optional_repair_outcome=not_taken observed_max_in_pit=148.0 countdown_s=0.0 repair_done=148.0 first_seen_on_pit_road=True
```

`repair_done=148.0` と `countdown_s=0.0` が同じ行に出る。旧実装がなぜ誤認したかがログだけで読める。

### 指定されたシナリオの再生

レビュー本文で指定された4項目を `tests_session_race_state.py::PitServiceCancelledVersusPerformed` で再生した。

| 指定 | テスト | 結果 |
|---|---|---|
| 1. 進入後・ボックス付近で `PitOptRepairLeft=148` を初観測 | `test_cancelled_repair_leaving_on_fuel_only` | max=148.0 |
| 2. 取消して `0` のまま燃料だけでピットアウト | 同上 | countdown=0.0 |
| 3. `optional_repair_observed_but_not_taken=true`・最大値148・traceを確認 | `test_outcome_recorded_into_state_and_flag_is_sticky` | outcome=`not_taken` |
| 4. 実際にカウントダウンしたケースと別結果になること | `test_cancelled_and_performed_are_distinguishable` | `not_taken` ≠ `taken` |

追加で、途中打ち切り（`partial`）と、選択変更による瞬間的低下を消化とみなさないことも再生している。

---

## P1 #3a — 3周目でペース基準が未確定のまま固定される

### 再現の確認

指摘のとおりだった。`clean_3_laps_established` は燃費履歴が3本になった周に発火するが、
その時点でラップタイム履歴はまだ2本しかないため `baseline_pace_s` が `None` で確定する。
以後 `== 3` を二度と満たさないため **永久に None で固定** され、pace_deviation は一度も発火できなかった。

### 直し方

- `bridge.py:3342` — 燃費とラップタイムの **両方が3本以上揃ってから** 一度だけ確定する（`>=` ＋ `should_recalculate` の dedupe で一度だけになる）。
- 基準値も `recent_median()` で作る。逸脱判定と同じ関数・同じ集合を使う（平均と中央値の混在をやめた）。

### 再生

`tests_session_race_state.py::CleanLapBaselineOrdering` — 周回列を流して確定結果を返す。

- クリーン3周で `baseline_pace_s` が非nullになること（欠陥の直接の再現）
- 確定が一度だけであること
- 確定後に pace_deviation が発火できること（基準が無ければ永久に発火しないため、これが本質）

---

## P1 #3b — `lap_time_hist` は「有効周」ではない

### 再現の確認

指摘のとおりだった。`lap_time_hist` は 20〜600秒であればピット周・アウトラップ・接触周・off-track周も積む。
厳密なクリーン周判定は、ラップタイム読み上げ側の別ブロックにしか存在していなかった。

### 直し方

- `bridge.py:3300` — 有効周判定を **燃費履歴を積む前** へ引き上げた。
- `bridge.py:3326` — Phase E 専用のクリーン周履歴に、燃費とラップタイムを **同じ周に、同じ判定で、同時に** 積む。
  片方だけ積むと2つの履歴が別の周を指し「同一集合」でなくなるため、両方が揃った有効周だけを積む。
- ラップタイム読み上げ側のブロックは再計算せず、同じ確定値を共有する（同一周に二つの「クリーン」の定義を並存させない）。
- `bridge.py:3388` / `3414` — 逸脱監視はクリーン周履歴を読む。

### ここだけ文面と違う（判断がほしい）

レビューは「`lap_time_hist` と fuel history の双方に、同じ確定済み `lap_valid_clean` を適用する」と指示している。
これに対し、**既存の `lap_time_hist` の定義は変えず、Phase E 専用のクリーン周履歴を別に持つ形にした。**

理由は、`lap_time_hist` の consumer が `bridge.py` 内に9箇所あるためである。

- 時間制セッションの残り周回推定（3箇所）
- ドライバーのペース比較・サンプル数（3箇所）
- 平均ペースの算出（3箇所）

ここを有効周だけに絞ると、incident の多い走行やピットの多いレースで母数が枯れ、
残り周回推定そのものが別の挙動になる。Phase E の要件を満たすために、無関係の既存機能の挙動を変える判断は独断でしない。

**要件として指示された「baseline と median が同一の有効周集合から作られる」は満たしている。**
既存履歴ごと絞るべきなら、その指示をもらえれば対応する。

### 再生

`CleanLapBaselineOrdering.test_dirty_laps_do_not_count_toward_the_three` —
ピット周・アウトラップ・off-track周を挟んだ6周の列で、クリーン3周だけが集合を構成し、
ピット周のラップタイムが基準に入らないことを確認している。

---

## 変異試験

**7件すべて、実際にコードを壊してテストを走らせ、検出されることを確認した**（確認後に復元済み）。

| # | 変異 | 検出 |
|---|---|---|
| 1 | #1 を旧ロジック（退出時残秒で判定）へ戻す | ✅ |
| 2 | `classify_optional_repair` が `not_taken` を返さないようにする | ✅ |
| 3 | ピットアウトのリセットも消化に数える（時間整合チェックを外す） | ✅ |
| 4 | 基準確定を燃費履歴だけに戻す | ✅ |
| 5 | 逸脱監視を dirty lap を含む `lap_time_hist` へ戻す | ✅ |
| 6 | クリーン周判定を外して履歴を積む | ✅ |
| 7 | 2つの履歴を別ブランチで積む（集合がずれる） | ✅ |

## テスト結果

```bash
python3 irsdk-bridge/tests_session_race_state.py           # 65 tests OK（第2版 +13）
python3 irsdk-bridge/tests_bridge_recalculation_wiring.py  # 51 tests OK（第2版 +10）
for t in irsdk-bridge/tests_*.py; do python3 "$t"; done    # 33スイート全green
node tests-strategy-recalculation-jp-radio.js              # 28/28（#5・変更なし）
for t in tests-*.js; do node "$t"; done                    # 下記1件を除きgreen
```

既存の `tests-five-day-access.js` のみ失敗する。`applyPitwallAccess(...)` の出現数が10、期待値7。
**HEAD（`de54d0e` / 公開Build 265）でも同じ失敗**を確認済みで、今回の変更とは無関係。課金・認証まわりのため触っていない。

## 原価ゲート

- 外部Anthropic呼出：**0** / 外部Google STT・TTS呼出：**0**
- 根拠：新規・変更テストはファイル読み込みと純関数のみで、HTTPクライアントを一切importしていない。
- **正本が要求する simulated / generated / played / deferred / discarded / wasted-generation cost の計装自体は未実装（差戻し#7）。**
  上記は「実APIを呼んでいない」ことの確認であって、原価ゲートの証明ではない。この項目は未達のままである。

## 残る限界（正直に）

- 取消／実施の判定も、クリーン3周の確定も、**bridge が呼ぶのと同じ純関数を、同じ順序で流す再生**で検証している。
  **poll loop 自体を回した完全な再生ではない。** それは差戻し#6の作業として残っている。
  レビュー本文の「Bridge経路の再生テスト」を厳密に満たすのは #6 に着手した時点になる。
- 差戻し #2 / #4 / #6 / #7 と八木さんログ由来5項目は未着手。

## 再レビューしてほしい点

1. #1 の「実時間に沿った消化だけを実施の証拠にする」という判定基準そのものが妥当か。
   特に許容誤差 `drop <= elapsed + 0.5`（`REPAIR_COUNTDOWN_TOLERANCE_S`）と、
   消化とみなす下限 `1.0秒`（`REPAIR_SERVICE_MIN_S`）の置き方。
2. #3a の「両方3本揃ってから一度だけ確定」で、確定が遅れて困る場面がないか。
3. #3b の判断（既存 `lap_time_hist` を温存し、Phase E 専用のクリーン周履歴を別に持つ）でよいか。
