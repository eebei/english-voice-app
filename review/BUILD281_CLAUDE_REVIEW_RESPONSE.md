# Build 281 — Claude Code 差戻しへの対応

対象レビュー: `review/BUILD281_CLAUDE_REVIEW_RESULT.md`（2026-08-24）
状態: **再レビュー待ち。commit / push / build / 公開は未実施。**

## P1-1: 満タンで効かない小口補正

修正した。`plan_fuel_authority.evaluate()` は小口補正を返す前に、補正後の実搭載量を次の式で再計算する。

```text
corrected_onboard = min(capacity, fuel_at_stop + corrected_add)
corrected_margin  = corrected_onboard - burn × remaining_crossings - reserve
```

`corrected_margin >= 0` の時だけP0を抑止する。タンク上限に張り付いて補正が実搭載量を増やせない場合は、`planned_service_correction_cannot_finish` としてP0を通す。したがって「入らない補正をダッシュボードへ配る」経路はない。

追加した実データ形状テスト:

- capacity 50.0L / fuel-at-stop 1.5L / planned add 49.0L / 20 × 2.48L + reserve = 50.1L の満タン頭打ち例 → **P0許可**
- ちょうど -0.50L → **小口補正許可**
- -0.51L → **P0許可**

## P1-2: signature resetでのpit_events残留

修正した。`pit_events` を `_session_scoped_reset_values()` の単一reset正本へ移動し、両方の境界経路がそれぞれ

```text
pit_events = _sig_reset['pit_events']
pit_events = _reset['pit_events']
```

を使う。新しいreset辞書が毎回空の独立リストを返すことを、本番`bridge`モジュール直接テストで確認する。

## P2-1: 0.5L境界

上記の -0.50L / -0.51L を両側で固定した。`SMALL_SERVICE_CORRECTION_L` を5.0Lへ緩める変異は後者が失敗する。

## P2-2: 書き戻しの実動作

文字列検索テストを廃止した。Bridge本番が使う `apply_recommended_plan_fuel()` を純粋関数へ抽出し、ライブplanとactive snapshotへ `add_fuel_l=14.173` / `set_fuel_l=15` が実際に書き戻されることを直接検証する。

## 追加整理

- `desktop/local-intent-router.js` の恒偽だった `wantsBoth` 第2項を削除した。`前後` / `both` だけをboth要求として扱う。既存の前後GAP・欠損GAPテストは維持した。
- `danger` のP1化は維持。前後危険の詳細分割は、接近速度・復帰ライン距離の契約を伴う別変更として扱い、今回混ぜない。

## 実行済み検証（外部API呼出なし）

- `python3 -m unittest irsdk-bridge/tests_plan_fuel_authority.py` — 22 tests passed
- `node tests-local-intent-router.js` — 30/30
- `node tests-telemetry-truth-gate.js` — 56/56
- 全 `tests-*.js` とPython discovery — **264 tests passed**
- `git diff --check` — passed

再レビューでは、P1-1の容量頭打ちがP0許可へ落ちること、P1-2が両reset経路で単一正本を使うこと、境界・実書き戻しテストの強度を確認してほしい。
