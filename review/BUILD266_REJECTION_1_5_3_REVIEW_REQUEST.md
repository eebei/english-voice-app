# Build 266 差戻し #1 / #5 / #3 — Codexレビュー依頼

作成: 2026-08-12 / Claude Code
正本: [PITWALL_SHARED_WORKING_LOG.md](PITWALL_SHARED_WORKING_LOG.md) / [BUILD266_PHASE_E_ADAPTIVE_RACE_INTELLIGENCE_BRIEF.md](BUILD266_PHASE_E_ADAPTIVE_RACE_INTELLIGENCE_BRIEF.md)

> **第2版（2026-08-12）** — Codex限定レビュー [BUILD266_REJECTION_1_5_3_CODEX_REVIEW.md](BUILD266_REJECTION_1_5_3_CODEX_REVIEW.md) の P1三点に対応した。
> #5 は承認されたため触っていない。差分は末尾の「第2版：Codex P1三点への対応」を参照。
> 本文の #1 / #3 の節は初版の内容であり、対応後の実装は第2版の節が正となる。

## レビューモード

読み取り専用の独立レビュー。編集・commit・push・build・deploy・公開はしない。
`file:line` を根拠に P0 / P1 / P2 で報告する。

## この依頼の範囲（重要）

**Build 266候補の合否判定を求めていない。** Codex差戻し7項目のうち **#1 / #5 / #3 の3件だけ** を実装した。
残る **#2（再計算が記録だけ）／#4（Plan C未実装）／#6（統合テストがBridge実行経路外）／#7（原価ゲート未証明）は未着手のまま** である。
八木さんログ由来の5項目も未着手である。

したがって Build 266 は依然として **Build候補にしない**。今回見てほしいのは「この3件の直し方が正しいか」だけである。

## 変更ファイル

| ファイル | 役割 |
|---|---|
| `irsdk-bridge/session_race_state.py` | 任意修理の最大観測値・実施/取消判定／中央値／乖離判定の純関数 |
| `irsdk-bridge/bridge.py` | 上記の実配線（ピット中の更新・有効周履歴・周回確定時の乖離監視） |
| `desktop/renderer.html` | `strategy_recalculation` の日本語ケース |
| `irsdk-bridge/tests_session_race_state.py` | 計65テスト（初版52、第2版+13） |
| `irsdk-bridge/tests_bridge_recalculation_wiring.py` | 計51テスト（初版41、第2版+10） |
| `tests-strategy-recalculation-jp-radio.js` | 新規28チェック |

---

## 差戻し#1 任意修理の観測時刻

### 何が壊れていたか

旧実装は `bridge.py` のピット進入ブロック1箇所でしか任意修理秒を見ていなかった。
ボックス付近／ボックス内で接触した場合、`PitOptRepairLeft` は `OnPitRoad` が True になった**後**に初めて非ゼロになる。進入時の一点スナップショットでは任意修理の存在そのものを取り逃がす。Monza 20実走がまさにこの形である。

### どう直したか

- `session_race_state.py:103` `record_optional_repair_observation()` — 最大観測値と初検出時刻（lap / session time / その瞬間ピットロード上だったか）を保持する。冪等（同値・より小さい値では state を作り替えない）なので poll loop から無条件に呼べる。**値を下げる経路も clear する経路も実装していない。**
- `session_race_state.py:220` `optional_repair_observed_max()` — 参照用。
- `bridge.py:4227` — 毎フレーム `record_optional_repair_observation()` を呼ぶ。ピット中に限定していない（走行中の検出も初検出時刻として正しい）。
- `bridge.py:4242-4244` — `if onPit:` 配下で `_pit_repair_opt_observed_max` と `_pit_damage_s_max` を更新し続ける。進入遷移（`prev['onPit'] is False`）では gate していない。
- `bridge.py:4291` — 進入時の値は最大値の初期シードとしてのみ残す。
- `bridge.py:4408` `_repair_basis_s` — **併せて直した別の欠陥。** 旧 `_repair_done = pit_repair_start_s - damage_s` は、ボックス内で接触して damage_s が進入時より増えると負になり `max(0.0, …)` で 0 に潰れ、未実施検知が黙って死ぬ。ピット訪問中に見えた damage_s の最大値を基準に変更した。#1 だけ直してもここを直さなければ Monza 20 の形では動かない。
- 未実施の事実には最大観測値を持たせた（進入時の値ではない）。**この判定部分は第2版で countdown ベースへ差し替えたため、現在この行は存在しない。**

### trace

```text
SESSION RACE STATE optional_repair_observed: max=14.0s on_pit_road=True lap=6
SESSION RACE STATE optional_repair_observed_but_not_taken: observed_max_in_pit=14.0 repair_done=0.0 first_seen_on_pit_road=True
```

### 検証してほしい契約

1. 進入時に任意修理が0で、進入後に14秒が立ち上がるフレーム列で、最大観測値が14.0になること。
2. ピットアウト後に `PitOptRepairLeft=0.0` を受けても最大観測値も未実施フラグも消えないこと。
3. ボックス内接触で damage_s が進入時より増えたケースで、実消費秒が0に潰れないこと。
4. 最大観測値の更新が `if onPit:` 配下にあり、進入遷移で gate されていないこと。
5. 初検出時刻が「初回のみ」記録され、後続の増分で上書きされないこと。

---

## 差戻し#5 日本語無線の未配線

### 何が壊れていたか

`bridge.py` は `trigger:'strategy_recalculation'` に英語の `driver_message` を載せて broadcast している。
`renderer.html` の日本語キャラクター経路（LunaJP / Oishi / Kanbe / HajimeJP）は `oishiRadio(data,false) || data.message` の順で文面を決めるため、case が無いと **英語がそのまま日本語音声で読み上げられる**。実走では `pit_box_here` が同じ事故を起こしており、renderer.html 内にその旨のコメントが残っている。

### どう直したか

- `desktop/renderer.html:3231` — `strategy_recalculation` の日本語ケースを追加。
- 英語 `message` は読まない。構造化フィールド `reason` / `category` だけから日本語を組み立てる。発話の権威は bridge の状態、文面は renderer 側、という分担を崩していない。
- 未知 reason・reason 欠落でも必ず日本語を返す。ここで空文字を返すと `|| data.message` で英語へ落ちるため、フォールバック自体を塞いだ。

### 検証してほしい契約

1. 4つの reason すべてで日本語が返ること。
2. `message` に英文が入っていても英文が採用されないこと。
3. 未知 reason・reason 欠落・category 欠落でも英語へ落ちないこと。
4. 走行中の発話として長すぎないこと（三文以内・内部数値を読み上げない）。

### 未対応（要判断）

`matthiasRadio()`（ドイツ語）は同じ構造で英語へ落ちる。差戻し文面が日本語のみを指しているため触っていない。同様に直すべきか指示がほしい。

---

## 差戻し#3 fuel_deviation / pace_deviation の自動監視

### 何が壊れていたか

純関数 `evaluate_fuel_deviation` / `evaluate_pace_deviation` は存在したが、Bridgeの実フレームループから誰も呼んでいなかった。

### どう直したか

- `bridge.py:3382-3396` — 周回確定ブロック（`if lap_time_changed and onTrack:` 内）で、`fuel_per_lap_hist` / `lap_time_hist` の**直近3〜5有効周の中央値**と基準値を毎周比較する。毎フレームではなく周回確定時のみ評価する。
- `session_race_state.py:396` `recent_median()` — 平均ではなく中央値。トラフィック1周や1回のオフで走行値が引きずられないようにするため。3周揃うまでは `None`。
- `session_race_state.py:414` `next_deviation_trigger()` — **1周分の発火判定を純関数に出した。** bridge にインラインで書くと「実配線ではあるが挙動を試験できない＝静的な文字列一致でしか裏が取れない」形になり、#3 および #6 と同じ指摘を受け直すため。
- `bridge.py:3397` — bridgeはこの純関数を呼び、返り値の episode を書き戻すだけ。

### 発火規則

| 状態 | 挙動 |
|---|---|
| 基準値未確定（クリーン3周前） | 発火しない・再武装もしない |
| 許容内 | 発火しない・再武装する（episode+1） |
| 乖離中（同じ step） | 一度だけ発火。持続しても毎周は鳴らさない |
| しきい値をもう1段跨いで悪化 | 再発火（step+1） |
| 一度回復して再び乖離 | 新しい episode として再発火 |

### 検証してほしい契約

1. 安定した燃費で一度も発火しないこと。
2. 接触後に燃費が悪化したまま続く列で、発火が1回だけであること。
3. 悪化が倍化したら再発火すること。
4. 回復後の再乖離で再発火すること。
5. 基準値が無い間に episode カウンタが進まないこと。
6. episode カウンタがセッションを跨がないこと（両方のreset経路）。

### この項目の未完了（明記する）

発火時に渡している `selected_plan` は現行 `active_plan` のままで、`driver_message=None` である。
**実際のPlan A/B/C再評価は差戻し#2の作業であり、今回は「検知」と「trace」までしか到達していない。**
ここを「再計算できるようになった」と読まないでほしい。#2 に着手した時点で、この呼び出し側を実計算へ差し替える。

---

## 変異試験

**8件すべて、実際にコードを壊してテストを走らせ、検出されることを確認済み**（確認後にコードは復元してある）。

| # | 変異 | 検出したテスト |
|---|---|---|
| 1 | 最大値更新を `if onPit:` から進入遷移条件へ戻す | `test_optional_repair_max_updated_during_pit_not_only_at_entry` |
| 2 | `_repair_basis_s` の `max` を `min` に変える | `test_repair_done_uses_max_damage_seen_in_pit` |
| 3 | `record_optional_repair_observation` で最大値を下げられるようにする | `test_running_maximum_never_drops` |
| 4 | `oishiRadio` の `strategy_recalculation` の default を空文字にする | `未知の reason でも空文字を返さない` |
| 5 | 日本語ケースを削除する | `bridge の英語 message を素通しさせない` |
| 6 | `next_deviation_trigger` の step==0 で episode を進めない | `test_recovered_then_deviating_again_re_arms` |
| 7 | dedupe_key から step を外す | `test_worsening_deviation_fires_again` |
| 8 | 乖離ループを dedent して周回確定ブロックの外へ出す | `test_deviation_evaluated_per_lap_not_per_frame` |

**#8 は最初この変異を検出できなかった。** 当該テストがソースの出現順しか見ておらず、ネストを検証していなかったためである。
ループを1段 dedent すれば出現順は変わらないまま「毎フレーム評価」に変わってしまい、brief の「毎telemetry frameで再計算しない」に違反する。
テストを、`for` の直近の外側ステートメントが `if lap_time_changed and onTrack:` であることを検証する形へ書き直した上で、再度 dedent 変異を当てて検出されることを確認した。

## 実行したテストと結果（初版時点・第2版の結果は末尾を参照）

```bash
for t in irsdk-bridge/tests_*.py; do python3 "$t"; done   # 33スイート全green
for t in tests-*.js; do node "$t"; done                    # 後述1件を除きgreen
python3 irsdk-bridge/tests_session_race_state.py           # 52 tests OK
python3 irsdk-bridge/tests_bridge_recalculation_wiring.py  # 41 tests OK
node tests-strategy-recalculation-jp-radio.js              # 28/28
```

乖離判定は静的検査ではなく**ラップ列の再生**で挙動確認している（`DeviationTriggerSequence.replay()`）。
poll loop が1周ごとに引くのと同じ判定を、同じ順序で呼んで発火した周を返す。

## 原価ゲート（内部シミュレーション正本）

- 外部Anthropic呼出：**0** / 外部Google STT・TTS呼出：**0**
- 根拠：新規・変更テストはファイル読み込みと純関数のみで、HTTPクライアントを一切importしていない（`requests` / `urllib` / `http.client` / `socket` / `fetch` / `axios` / `anthropic` / `texttospeech` の参照件数 = 0）。
- **ただし正本が要求する simulated / generated / played / deferred / discarded / wasted-generation cost の計装そのものは未実装（差戻し#7）。** 上記は「実APIを呼んでいない」ことの確認であって、原価ゲートの証明ではない。この項目は未達のままである。

## 今回の作業と無関係の既存不具合（報告のみ・触っていない）

`tests-five-day-access.js` が失敗する。`desktop/renderer.html` の `applyPitwallAccess(...)` 出現数が10で、テストの期待値7と合わない。
**HEAD（commit `de54d0e` / 公開Build 265）でも同じ数・同じ失敗**を確認済みで、Build 266候補の変更が原因ではない。課金・認証まわりのため独断で触っていない。

なお前回のBuild 266候補の completion evidence が「JavaScript 16関連スイートgreen」と書いているのは選択した16本の結果であり、`tests-*.js` 全数ではない。この失敗はそこで表に出ていなかった。

## 未着手（差戻しのまま残っている項目）

- #2 再計算が記録だけで、実際にPlan A/B/Cを再評価していない
- #4 Plan C未実装
- #6 統合テストがBridge実行経路を通っていない
- #7 内部シミュレーション・原価ゲート未証明
- 八木さんログ5項目（`handling_setup_advice` 誤ルーティング／文脈引き継ぎ／途中で切れる発話／デブリーフ割り込み／`limiter_off` 二重発火）

`limiter_off` については、`limiter_off_announced_stop` によるガードが既に存在する（`bridge.py`）。ただし発火条件がリミッター状態遷移ベースで、指示書が要求する `OnPitRoad true→false` の一意条件になっていない。実走で二重発火した以上、現ガードでは足りていないと見ている。

## commit / push / build / 公開

一切行っていない。作業ツリーの未コミット変更として存在する。

---

# 第2版：Codex P1三点への対応（2026-08-12）

限定レビューの P1三点はいずれも実コードで再現を確認した上で修正した。#5 は承認されたため触っていない。

## P1(#1) 取消して出た場合を「修理完了」と誤認する

### 指摘は正しい

`_repair_done = _repair_basis_s - damage_s` は、ピットアウト時に `damage_s` が 0 へ戻るため、
**修理を実施した場合も取り消した場合も同じ値（＝最大観測値）になる。** 退出時の残秒では両者を区別できない。
結果として `_repair_done < 1.0` は偽になり、`optional_repair_observed_but_not_taken` が保存されなかった。

### 直し方

実施の証拠を「退出時の残秒差」から **「実時間に沿って消化された秒」** へ変更した。
サービス中の `PitOptRepairLeft` は経過秒とほぼ同じ速度で減る。取消・選択変更・ピットアウトのリセットは、
経過時間では説明できない瞬間的な落ち方をする。両者はこの一点で分かれる。

- `session_race_state.py:171` `observe_pit_repair_frame()` — 1フレームの減少が `drop <= elapsed + 0.5` を満たす時だけサービス消化として積む。
- `session_race_state.py:200` `classify_optional_repair()` — `none` / `not_taken` / `partial` / `taken`。
  `not_taken` は「countdown が一度も走らなかった」時だけ。**ライブ値が0であることからは決して推論しない。**
- `session_race_state.py:250` `record_optional_repair_outcome()` — 結果を state に残す。`not_taken` の時だけ sticky フラグを立てる。`taken` も記録するので「確認して実施済みだった」と「そもそも見ていない」が区別できる。
- `bridge.py:4249` — ピットロード上の毎フレーム観測。`bridge.py:4417-4419` — 退出時に判定・記録。
- ピット訪問ごとに tracker を初期化（`bridge.py` のピット進入ブロック）。

`_repair_done` は既存のピットサンプル分類（`repair_s`）が引き続き使うため残してあるが、
**未実施判定には一切使っていない**（変異試験で担保）。

### trace

```text
SESSION RACE STATE optional_repair_outcome=not_taken observed_max_in_pit=148.0 countdown_s=0.0 repair_done=148.0 first_seen_on_pit_road=True
```

`repair_done=148.0` と `countdown_s=0.0` が同じ行に出るので、旧実装がなぜ誤認したかがログから読める。

### 再生テスト

`tests_session_race_state.py::PitServiceCancelledVersusPerformed` — フレーム列を poll loop と同じ順序で流す。

1. ピット進入後に `PitOptRepairLeft=148` を初観測 → 取消 → `0` でピットアウト → `not_taken` / max=148 / countdown=0。
2. 実時間に沿って148秒消化 → `taken`。
3. **1 と 2 が別結論になること**を直接assert（退出時の値はどちらも0）。
4. 途中で打ち切り → `partial`。
5. 選択変更による瞬間的な低下 → サービスとみなさない。

## P1(#3a) 3周目でペース基準が未確定のまま固定される

### 指摘は正しい

`clean_3_laps_established` は `len(fuel_per_lap_hist) == 3` で発火し、その時点でラップタイム履歴はまだ2本。
`baseline_pace_s` が `None` で確定し、以後 `== 3` を二度と満たさないため**永久に None で固定**され、
pace_deviation は一度も発火できなかった。

### 直し方

- `bridge.py:3342` — 燃費とラップタイムの**両方が3本以上揃ってから**、一度だけ確定する（`>=` ＋ `should_recalculate` の dedupe）。
- 基準値も `recent_median()` で作る。逸脱判定と同じ関数・同じ集合を使う（平均と中央値の混在をやめた）。

### 再生テスト

`tests_session_race_state.py::CleanLapBaselineOrdering` — 周回列を流して確定結果を返す。

- クリーン3周で `baseline_pace_s` が非nullになること（これが欠陥の直接の再現）。
- 確定が一度だけであること。
- 確定後に pace_deviation が発火できること（基準が無ければ永久に発火しない）。

## P1(#3b) `lap_time_hist` は「有効周」ではない

### 指摘は正しい

`lap_time_hist` は 20〜600秒であればピット周・アウトラップ・接触周・off-track周も積む。
一方、厳密なクリーン周判定は別ブロック（ラップタイム読み上げ側）にしか無かった。

### 直し方

- `bridge.py:3300` — 有効周判定を**燃費履歴を積む前**へ引き上げた。
- `bridge.py:3326` — Phase E 専用のクリーン周履歴に、燃費とラップタイムを**同じ周に、同じ判定で、同時に**積む。片方だけ積むと2つの履歴が別の周を指し、「同一集合」でなくなるため、両方が揃った有効周だけを積む。
- 下流のラップタイム読み上げブロックは再計算せず同じ確定値を共有する（同一周に二つの「クリーン」の定義を並存させない）。
- `bridge.py:3388` / `3414` — 逸脱監視はクリーン周履歴を読む。

### Codexの文面との相違（判断がほしい）

Codexは「`lap_time_hist` と fuel history の双方に同じ `lap_valid_clean` を適用する」と書いている。
`lap_time_hist` は残り周回推定・ペース比較など**既存consumerが `bridge.py` 内9箇所**あり、
ここを絞り込むとそれらの挙動が変わる（例：incidentの多いドライバーで残り周回推定の母数が枯れる）。

そのため Phase E 専用のクリーン周履歴を別に持つ形にした。
「baseline と median が同一の有効周集合から作られる」という要件は満たしているが、既存履歴の定義自体は変えていない。
この判断でよいか、既存履歴ごと絞るべきかを指示してほしい。

### 再生テスト

`CleanLapBaselineOrdering.test_dirty_laps_do_not_count_toward_the_three` — ピット周・アウトラップ・off-track周を挟んだ6周の列で、
クリーン3周だけが集合を構成し、ピット周のラップタイムが基準に入らないことを確認する。

## 第2版の変異試験

**7件すべて、実際に壊してテストが落ちることを確認済み**（確認後に復元）。

| # | 変異 | 検出 |
|---|---|---|
| 1 | #1 を旧ロジック（退出時残秒で判定）へ戻す | ✅ |
| 2 | `classify_optional_repair` が `not_taken` を返さないようにする | ✅ |
| 3 | ピットアウトのリセットも消化に数える（時間整合チェックを外す） | ✅ |
| 4 | 基準確定を燃費履歴だけに戻す | ✅ |
| 5 | 逸脱監視を dirty lap を含む `lap_time_hist` へ戻す | ✅ |
| 6 | クリーン周判定を外して履歴を積む | ✅ |
| 7 | 2つの履歴を別ブランチで積む（集合がずれる） | ✅ |

## 第2版のテスト結果

```bash
python3 irsdk-bridge/tests_session_race_state.py           # 65 tests OK（+13）
python3 irsdk-bridge/tests_bridge_recalculation_wiring.py  # 51 tests OK（+10）
for t in irsdk-bridge/tests_*.py; do python3 "$t"; done    # 33スイート全green
node tests-strategy-recalculation-jp-radio.js              # 28/28（#5・変更なし）
```

外部Anthropic／Google呼出：0。原価ゲートの計装自体は未実装のまま（差戻し#7）。

## 第2版で残る限界（正直に）

- 取消／実施の判定も、クリーン3周の確定も、**bridge が呼ぶのと同じ純関数を同じ順序で流す再生**で検証している。
  **poll loop 自体を回した完全な再生ではない。** それは差戻し#6の作業として残っている。
- 差戻し #2 / #4 / #6 / #7 と八木さんログ由来5項目は未着手のまま。Build 266 は候補不可。
