# Build 266 — Codex限定レビュー（#1 / #5 / #3）

レビュー日: 2026-08-12  
対象: `BUILD266_REJECTION_1_5_3_REVIEW_REQUEST.md` の3項目のみ  
対象外: #2 / #4 / #6 / #7、八木さんログ由来の項目、Build 266全体の合否

## 結論

| 項目 | 判定 | 根拠 |
|---|---|---|
| #1 任意修理 | **差戻し** | ボックス内で任意修理を見つける観測は直ったが、「修理を選ばずに出た」を正しく判定できない。|
| #5 日本語無線 | **この範囲で承認** | `strategy_recalculation` は構造化された `reason` / `category` から必ず日本語を返し、英語 `message` を読まない。|
| #3 fuel / pace deviation | **差戻し** | 実フレームではなく周回確定時に評価する配線と再武装はあるが、ペース基準が成立しない順序と、有効周でない履歴混入がある。|

Build 266は、依頼文どおり今回もBuild候補ではない。今回の判定は上の3項目だけである。

## 実行確認

次の限定テストはすべて通過した。

```text
python3 irsdk-bridge/tests_session_race_state.py           52 tests OK
python3 irsdk-bridge/tests_bridge_recalculation_wiring.py  41 tests OK
node tests-strategy-recalculation-jp-radio.js              28/28
```

ただし、これらの緑は下記の実走形状を再生していないため、#1 / #3の受入証拠には足りない。

## P1 — #1: 任意修理を取消して出た場合を「修理完了」と誤認する

`bridge.py:4350-4361` は、`damage_s`（mandatory + optional のライブ残秒）がピットアウト時に0へ戻った場合、`_repair_done = _repair_basis_s - damage_s` を最大観測値と同じ秒数にする。その結果、実際には任意修理を外して燃料だけで出た場合でも `_repair_done < 1.0` が偽になり、`optional_repair_observed_but_not_taken` が保存されない。

これはMonza 20の「任意修理は表示されたが、燃料だけでピットアウトした」形を取り逃がす。ライブ値の0は、修理完了とドライバーによる取消の両方で起こり得るため、退出時の残秒差分だけでは区別できない。

`bridge.py:4176-4192` と `session_race_state.py:103-141` の毎フレーム最大観測・初検出保存自体は正しい。直すべきなのは完了／未実施の判定である。

必要な修正:

- optional repair が実際にカウントダウンした連続区間、またはサービス開始・完了を示す別の権威シグナルを追跡する。
- 「見えた最大値 − ピットアウト時0」だけを修理実施の証拠にしない。
- 少なくとも次をBridge経路で再生するテストを追加する。
  1. ピット進入後・ボックス付近で `PitOptRepairLeft=148` を初観測。
  2. 任意修理を取消し、`PitOptRepairLeft=0` のまま燃料だけでピットアウト。
  3. `optional_repair_observed_but_not_taken=true`、最大値148、取消／未実施のtraceを確認。
  4. 実際に修理カウントダウンしたケースとは別結果になることを確認。

現行テスト `tests_bridge_recalculation_wiring.py:149-156` はソース文字列の存在を確認するだけで、この取消ケースを再生していない。

## P1 — #3a: 3周目でペース基準が未確定のまま固定される

`bridge.py:3284-3306` の `clean_3_laps_established` は、`lap_time_hist` への今回ラップ追加（`bridge.py:3312-3315`）より前に走る。

燃費履歴が初めて3本になった周には、ペース履歴は通常まだ前の2本しかないため、`baseline_pace_s` は `None` になる。次周以降は燃費履歴が4本になり、`len(fuel_per_lap_hist) == 3` 条件を二度と満たさないため、ペース基準が設定されず、`bridge.py:3331-3345` の pace deviation は発火できない。

必要な修正:

- 完了周の有効性を確定してから、今回のlap timeと燃費を同じ順序で履歴へ積む。
- その後、両方が3本以上ある時点で baseline fuel / pace を同一の有効周集合から一度確定する。燃費だけ3本の時点でbaselineを確定しない。
- 3周の同一クリーンラップ列で `baseline_pace_s` が非nullになり、4周目の逸脱が発火するBridge再生テストを追加する。

## P1 — #3b: `lap_time_hist` は「有効周」ではない

`bridge.py:3275-3282` は燃費だけを `pit_this_lap` で除外し、その直後に `pit_this_lap` をFalseへリセットする。一方 `bridge.py:3312-3315` は20〜600秒であれば、pit in/out、incident、off-trackを問わずlap timeを積む。

既にBridgeには厳密なクリーン周判定がある（`bridge.py:3760-3783`）。#3の要件である「直近3〜5有効周の中央値」には、その証拠を共有しなければならない。現行の中央値はピット周・アウトラップ・接触周・off-track周を含み得る。

必要な修正:

- `lap_time_hist` と fuel history の双方に、同じ確定済み `lap_valid_clean` を適用する。フラグをリセットする前に完成ラップ側へ渡す。
- dirty lapを混ぜず、クリーン3〜5周だけからmedian／baselineを作る。
- pit in/out、incident、off-trackを挟むfixtureで、履歴件数・median・発火／無発火を検証する。

## #5 承認根拠

`desktop/renderer.html:3231-3248` は `strategy_recalculation` を処理し、既知reason・未知reason・reason欠落のすべてに日本語文を返す。`data.message` を材料にせず、`reason` と `category` だけを使うため、英語Bridge messageがLunaJPに落ちる経路をこのtriggerで閉じている。限定テスト28/28もこの動作を確認している。

## 次のClaude Code作業

このレビューのP1三点だけを直す場合も、次の正本を事前に全文確認すること。

- `review/PITWALL_SHARED_WORKING_LOG.md`
- `review/PITWALL_INTERNAL_SIMULATION_TEST_POLICY.md`

修正後は、上記の取消修理・クリーン3周ペース基準・dirty lap除外を、Bridge実行経路のfixture再生で証明すること。commit / push / build / 公開はしない。
