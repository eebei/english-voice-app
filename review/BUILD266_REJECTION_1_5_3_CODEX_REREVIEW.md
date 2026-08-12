# Build 266 — #1 / #3a / #3b 再レビュー

レビュー日: 2026-08-12  
対象: `BUILD266_REJECTION_1_5_3_CODEX_REVIEW_RESPONSE.md` のP1三点  
対象外: Build 266全体の合否、#2 / #4 / #6 / #7、八木さんログ由来の項目

## 結論

前回のP1三点について、今回の限定実装は受け入れる。

| 項目 | 判定 | 根拠 |
|---|---|---|
| #1 任意修理取消 | 承認 | 退出時の0ではなく、ピット中の時間整合するcountdownだけを実施証拠に変更した。取消と実施を別結果にするテストがある。|
| #3a baseline順序 | 承認 | 燃費・ペースがともに3本のクリーン周で揃ってから、同一集合の中央値を基準に固定する。|
| #3b clean-lap履歴 | **承認（この方式で進める）** | 既存 `lap_time_hist` を温存し、Phase E専用の `clean_fuel_per_lap_hist` / `clean_lap_time_hist` を持つ分離が適切。|

## #3b の判断

既存の `lap_time_hist` は残り周回推定など、Phase E以外の既存consumerが使う履歴である。これをクリーン周だけに変えると、今回の目的と無関係な既存機能まで同時に挙動変更する。

そのため、次の形を正式に採用する。

```text
既存 lap_time_hist / fuel_per_lap_hist
  → 既存の残り周回推定等（従来挙動を維持）

Phase E clean_fuel_per_lap_hist / clean_lap_time_hist
  → 同一の完成ラップ判定 _lap_valid_clean
  → baseline / recent median / fuel_deviation / pace_deviation
```

実装はこの契約を満たしている。

- `bridge.py:3287-3304` が、完了ラップの `_lap_valid_clean` を先に一度だけ確定する。
- `bridge.py:3321-3333` が、燃費とラップタイムの両方を同じbranchで同時に積む。
- `bridge.py:3342-3348` と `bridge.py:3381-3389` が、baselineと逸脱medianの双方にこの専用履歴だけを使う。
- `bridge.py:2203-2208` と session resetで、既存履歴とPhase E履歴の責務・寿命を分けている。

`tests_session_race_state.py` のdirty-lap列、および `tests_bridge_recalculation_wiring.py` の「同一branch」「判定は一度」「session reset」確認も、この意図と一致する。

## 限定テストの再実行

```text
python3 irsdk-bridge/tests_session_race_state.py           65 tests OK
python3 irsdk-bridge/tests_bridge_recalculation_wiring.py  51 tests OK
node tests-strategy-recalculation-jp-radio.js              28/28
python3 -m py_compile irsdk-bridge/bridge.py irsdk-bridge/session_race_state.py  OK
git diff --check                                            OK
```

## 境界の明記

この承認は、前回P1三点の局所修正に限る。完全なBridge poll-loop replay、外部APIゼロを含む原価計装、実Plan A/B/C再評価、Plan C、八木さんログ対応は未解決のままである。従ってBuild 266は依然Build候補ではない。commit / push / build / 公開もしない。
