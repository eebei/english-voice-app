# Claude独立レビュー依頼：耐久燃料管理 Unit 2

日付：2026-07-26
状態：未コミット・未push・未ビルド
作業ツリー：`/private/tmp/pitwall-final-lap`

## 目的

旧実装の周単位marginと二重安全加算を廃止し、Final Lap Unitが確定した
自車の残りS/F通過回数だけをrace-distance authorityとして、L単位で
完走燃料を判定する。

## 変更ファイル

- `irsdk-bridge/fuel_strategy.py`（新規・純粋関数）
- `irsdk-bridge/tests_fuel_strategy.py`（47件）
- `irsdk-bridge/tests_fuel_strategy_wiring.py`（25件）
- `irsdk-bridge/bridge.py`（Final Lap crossingsとの統合、band state、P0配線）
- `irsdk-bridge/tests_bridge_lifecycle_wiring.py`（bandのセッションreset追加）
- `desktop/renderer.html`（tight/critical日本語・ドイツ語）
- `prompts.js`（L単位authorityをLLMへ渡す）
- `preflight.sh`

## 計算契約

```text
required_fuel_l = avg_fuel_per_lap_l * estimated_crossings_to_finish
margin_l = fuel_level_l - required_fuel_l

safe     margin_l >= 0.5
tight    0.0 <= margin_l < 0.5
critical margin_l < 0.0
```

- 0.5Lはsafe判定のreserve境界。必要燃料へ別途足さない。
- `estimated_crossings_to_finish`はFinal Lap Unitの
  `_milestone_laps`と同一値。時間制でFinal Lapモデルが不成立なら
  fuel-to-finishも不成立とし、旧own-paceへfallbackしない。
- クリーンラップ3本未満は不成立。
- 初回観測がtight/criticalなら警告候補にする。
- 同band内は発話しない。
- `safe→tight`と`tight→critical`は別々に発話する。
- `critical→tight`、給油後の`→safe`は無音で状態更新し、再悪化へrearmする。
- CHECKER_OUT / PLAYER_FINISHED / DEBRIEFでは警告しない。
- pit road中は発話せず、bandも消費しない。次の有効ラップで再評価する。
- warning bandは`DISPATCHED`後だけcommit。HELD/DROPPED/Noneでは元bandを維持する。

## 発話契約

- `fuel_warning` / `fuel_strategy_warning`をP0へ昇格。
- `fuel_strategy_warning`を間合いゲート対象から除外。
- band遷移dedupがあるため、P0化しても同band連呼はしない。
- tight：
  `燃料マージン0.5リットル未満。セーブ開始。`
- critical：
  `燃料X.Xリットル不足。ピットが必要。`
- rendererとLLM promptの双方が`margin_l`、`required_fuel_l`、
  `estimated_crossings_to_finish`を使用する。

## 削除した旧本番契約

```python
fuel_needed = avg_fuel_lap * (laps_remaining_est + 1)
margin_laps = (fuel - fuel_needed) / avg_fuel_lap
warning = margin_laps < -0.5
```

この旧式は1周の安全分を必要燃料へ足した後、さらに0.5周不足まで待つため、
単位と意味が混在していた。また時間制でFinal Lapとは別の残周回推測を使っていた。

## 7月25日統合回帰

Final Lap fixture：

- 総合首位チェッカー：約185秒後
- 自車次S/F：約120秒後
- 自車平均：約127秒
- 正しい残りS/F通過：2回

燃料fixture：

- 平均2.0L/周
- 現燃料4.0L
- 必要4.0L
- margin 0.0L
- `tight`、警告候補

旧誤推定1周へfallbackすると必要2.0Lでsafeになるため、
統合テストは「必ずFinal Lapの2回を使う」ことを固定している。

## 検証結果

```text
tests_fuel_strategy.py                 47 / 47
tests_fuel_strategy_wiring.py          25 / 25
tests_final_lap.py                     72 / 72
tests_final_lap_wiring.py              20 / 20
tests_bridge_lifecycle_wiring.py       77 / 77
tests_judge_llm_gate.py                92 / 92
preflight.sh                           PASS
git diff --check                       PASS
```

preflightのHTTPテストはローカルport許可環境で実行済み。

## 変異検出

- `margin >= 0.5`を`> 0.5`へ変更
- 必要燃料へ旧`+1周`を復活
- dispatch guard削除
- CHECKER_OUT抑止削除
- Final Lap crossingsを旧estimateへ置換
- bridgeからdispatch後commitを削除
- SessionNum reset unpack削除
- promptを旧margin_lapsへ復元

## Claudeへ依頼する反対尋問

1. 0.5L境界とrequired/marginの単位に二重計上がないか。
2. Final Lapと燃料が本当に同じcrossings値を共有しているか。
3. attach mid-race、給油、fuel saving、band悪化の状態遷移に欠落がないか。
4. director、pit、lifecycle、dispatch dropで警告が永久消失／連呼しないか。
5. P0化が他P0コールへ悪影響を与えないか。
6. rendererとpromptに旧周単位契約が残っていないか。
7. E0のdriver activity/stint resetへ統合する際に追加resetが必要か。

E0統合前の分離実装である。Claude承認後もE0上へ統合し、
三値broadcast契約とdriver handoffを含む最終差分を再レビューする。
