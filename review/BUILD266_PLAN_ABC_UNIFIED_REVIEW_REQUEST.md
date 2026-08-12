# Build 266 — Plan A/B/C 契約の統一（Plan B定義の判断への対応）

作成: 2026-08-12 / Claude Code
対象判断: [BUILD266_REJECTION_2_4_PLAN_B_DECISION.md](BUILD266_REJECTION_2_4_PLAN_B_DECISION.md)
正本: [PITWALL_SHARED_WORKING_LOG.md](PITWALL_SHARED_WORKING_LOG.md) / [PITWALL_INTERNAL_SIMULATION_TEST_POLICY.md](PITWALL_INTERNAL_SIMULATION_TEST_POLICY.md)
前段: [BUILD266_REJECTION_2_4_REVIEW_REQUEST.md](BUILD266_REJECTION_2_4_REVIEW_REQUEST.md)

## レビューモード

読み取り専用の独立レビュー。編集・commit・push・build・deploy・公開はしない。
`file:line` を根拠に P0 / P1 / P2 で報告する。

## この依頼の範囲

Plan B を **Fuel Window が開いた後の条件付きアンダーカット** へ定義し直し、
Plan A / B / C・無線・テストを新契約へ統一した。判断書の必要修正1〜5に対応している。

**#6（Bridge実行経路の完全再生）と #7（原価ゲート計装）は未着手。** 八木さんログ由来5項目も未着手。
Build 266 は依然 **Build候補ではない**。commit / push / build / 公開はしていない。

## 採用した契約

| Plan | 意味 | ピット周 | 成立条件 |
|---|---|---|---|
| A | 基準 | 通常ペースで成立する **最後の燃料安全周**（`latest_safe_in`） | ブリーフィングで提示可 |
| B | 条件付きアンダーカット | **Fuel Window が開いた最初の周**（A より前） | fuel window + 相対ペース優位 + rejoin clear |
| C | 条件付きオーバーカット／fuel-save | **A の1周先** | 相手先ピット + クリーンエア + fuel-save目標達成 + rejoin悪化なし |

旧契約（A = `latest_safe-1`、B = A の1周後＝延長）は破棄した。

## 判断書の必要修正への対応

### 1. Plan B を `extend_one_lap` から `undercut` へ

- `strategy_options.py:156` — `plan_a_in = latest_safe_in`（A を基準へ戻した）。
- `strategy_options.py:210` `_fuel_window_open_in()` — **Fuel Window の実装**。
  Yuji補足のとおり「その周でピットして、満タン容量を超えずにチェッカーまで必要な燃料を積めること」を最低条件とし、
  それを満たす **最初の周** を返す。容量が不明なら制約が無いので即開く。
- `strategy_options.py:230` `_build_plan_b()` — ウインドウ開始周を候補にする。A 以降にしか開かないなら `no_undercut_room`。
- `strategy_options.py:270` `decide_plan_b()` — 3条件（`PLAN_B_CONDITIONS`）が揃った時だけ available。
  相対ペース優位は `PLAN_B_MIN_PACE_ADVANTAGE_S = 0.3` 秒未満を「速い」と言わない。
  `None`（不明）は決して満たされたと扱わない。

**固定の -1 周は実装していない。** 候補周は必ずウインドウ計算から出る。

### 2. `decide_at_plan_a()` / `reevaluate_plans()` / Bridge box call

- `strategy_options.py:556` `decide_at_plan_a()` — 判断材料を差し替えた。
  燃料が持つかどうかではなく、ウインドウ・相対ペース・復帰の3点で選ぶ。
  復帰比較は「早入れ側（now）が基準側（next）より悪くない」で判定する。
- `reevaluate_plans()` は `relative_pace_advantage_s` を受け取り、B が選ばれた時だけ `plan_b.available` を True にする。
- `bridge.py:5473` — B の box call を `Undercut is on. Box this lap and set N liters.` に変更。`extended one lap` の文言を削除。
- ブリーフィングの成立条件も `plan_b.available` から `plan_b.fuel_window_open` へ変更した（B は条件付きなので、この時点で available=False が正常）。

### 3. renderer 無線の全置換

- `desktop/renderer.html:3212` ブリーフィング — 「1周延長案」を削除。B は **候補として** 述べる（`前とのペース差と復帰位置が揃えば出す`）。未証明の相対ペース・復帰を断定しない。ウインドウが開いていなければ B に触れない。
- `desktop/renderer.html:3220` 決定 — A=`基準` / B=`アンダーカットに行く` / C=`延長する`。
- `desktop/renderer.html:3228` box call — `1周延長案` を削除し、選択中プランの給油量を読む。
- 会話コンテキスト側の要約文言も `アンダーカット(B)` / `延長` へ統一した。

### 4. Plan C を Plan A 基準へ

- `strategy_options.py:318` — `target_in = plan_a_in + 1`。
  旧実装の「Plan B のさらに1周先」は破棄した（B はアンダーカットなので、その先を足しても延長にならない）。

### 5. 再生テスト

判断書が指定した5件を全て追加した（`tests_strategy_reevaluation.py::PlanBUndercutContract` ほか）。

| 指定 | テスト |
|---|---|
| B: 早いfuel windowだが相対ペース優位なし → unavailable | `test_early_window_without_pace_advantage_is_unavailable` |
| B: 相対ペース優位ありだが遅い集団へblend → unavailable | `test_pace_advantage_but_blending_into_a_slow_pack_is_unavailable` |
| B: 全成立 → selected=B、早いpit lap | `test_all_conditions_proven_selects_b_at_the_early_lap` |
| C: Aより後の候補でも4条件欠落 → unavailable | `PlanCConditions`（既存・A基準へ更新） |
| radio: Bに`延長`、Cに`アンダーカット`が混ざらない | `tests-strategy-recalculation-jp-radio.js`（+13チェック） |

追加で、ウインドウが容量制約で開かないケース（`test_window_is_shut_while_the_tank_cannot_hold_the_finish`）と、
しきい値ぎりぎりのペース差を却下するケースも入れてある。

## 変異試験

**7件すべて、実際に壊してテストが落ちることを確認済み**（確認後に復元）。

| # | 変異 | 検出 |
|---|---|---|
| 1 | Plan A を `latest_safe-1` に戻す（B が再び延長になる） | ✅ |
| 2 | Fuel Window を無視して常に0周目起点にする | ✅ |
| 3 | ペース優位なしでも B を出す | ✅ |
| 4 | 復帰未証明でも B を出す | ✅ |
| 5 | Plan C を B 起点に戻す | ✅ |
| 6 | 無線で B を「1周延長」と言う | ✅ |
| 7 | ブリーフィングで B を断定する | ✅ |

## テスト結果

```bash
for t in irsdk-bridge/tests_*.py; do python3 "$t"; done    # 34スイート全green
python3 irsdk-bridge/tests_strategy_options.py             # 新A/B/C契約
python3 irsdk-bridge/tests_strategy_reevaluation.py        # 39 tests OK
python3 irsdk-bridge/tests_plan_fuel_authority.py          # 17 tests OK
node tests-strategy-recalculation-jp-radio.js              # 39/39
for t in tests-*.js; do node "$t"; done                    # 後述1件を除きgreen
```

## 契約変更に伴って期待値を更新したテスト（明記）

契約が変わったので、旧契約を前提にしていたテストの期待値を追随させた。**実装に合わせて緩めたのではなく、新契約の値へ置き換えた。**

- `tests_strategy_options.py` — 全面的に新A/B/C契約へ書き換え。
- `tests_plan_fuel_authority.py`（Monza 35 の参照ログ再生）— Plan A の目標周が **lap 14 → lap 15** へ移動する。
  同じ入力でも A の定義が `latest_safe-1` から `latest_safe` へ変わったためである。
  参照ログは旧契約時点の記録なので、周番号は追随させた。タイムラインのループ範囲と `laps_to_pit` も同様。
- `tests-engineer-card.js` — 無線文言の期待を新契約へ更新。あわせて「B の無線に延長が混ざらない」チェックを追加。

## 原価ゲート

- 外部Anthropic呼出：**0** / 外部Google STT・TTS呼出：**0**
- 新規・変更テストはファイル読み込みと純関数とモジュールimportのみ。
- **正本が要求する計装自体は未実装（差戻し#7）。** 上記は「実APIを呼んでいない」ことの確認であって、原価ゲートの証明ではない。

## 確認してほしい点

1. **Plan A を `latest_safe` へ移した判断**。判断書は A を「通常ペースで成立する基準のpit window」としか書いておらず、
   周の指定は無い。ただし A を `latest_safe-1` のままにすると、C（A+1）が無節約で届いてしまい fuel-save の意味が消える。
   そのため A = `latest_safe` とした。この解釈でよいか。
2. **rejoin_clear の判定に使う予測**。早入れ側に `forecast_pit_now`、基準側に `forecast_pit_after_laps(1)` を使っている。
   本来は「B の周」と「A の周」の予測を突き合わせたいが、現行の forecaster は任意周の予測を持たない。
   保守側（両方取れた時だけ判定し、取れなければ未証明）に倒してあるが、より厳密な形が要るなら指示がほしい。
3. Monza 35 参照ログ再生の期待値を lap 15 へ移した件。

## 商用方針について（コードには手を入れていない）

`da0c4a3` の「通常5日無料trial」は、採用済みの商用方針（無料5日を廃止し有料 Starter Pass を入口にする）と矛盾するため、
今後の料金・紹介・ホームページ実装の正本には使わない、と共有ログに記載されている。
**今回の作業では `auth.js`・決済・利用権・公開ページに一切触れていない。** 戦略エンジンと無線のみである。

## 残る限界

- 差戻し #6（Bridge poll loop 自体を回した完全な再生）と #7（原価ゲート計装）は未着手。
- 八木さんログ由来5項目は未着手。
- `tests-five-day-access.js` は現HEAD（`da0c4a3`）でも同じ失敗が再現する既存不具合。課金・認証まわりのため触っていない。
