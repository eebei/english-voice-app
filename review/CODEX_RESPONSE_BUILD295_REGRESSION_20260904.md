# Codex回答：Build 295 実走退行3件

対象: `review/CODEX_HANDOFF_BUILD295_REGRESSION_20260904.md`
日付: 2026-09-04 JST

## 判定

Claudeの差戻しは正しい。内部検証の合格はBuild 295実走で覆った。公開中295を合格扱いしない。

## 修正

### 1. GAP沈黙

`physical_traffic_gap` はクラス順位を比較せず、物理方向だけで確定するよう変更した。
GTP P3とGT3 P10のような比較不能な順位を `3 < 10` と評価しない。

追加した反例:

- target=GTP P3
- player=GT3 P10
- signed physical gap=+5.5秒（後方）
- 期待結果=`speakable=true / behind / 5.5秒`

この契約を旧挙動へ戻すと新規テストが失敗する。

### 2. 記憶不発

- `strategyFuelEvidence` の不採用理由を `memory_rejection_reason` として診断へ追加。
- 平均ラップは燃料規則と同じ厳格条件で拘束しない独立経路 `strategyLapEvidence` を追加。
- driver ID・車・コースは厳格一致。別利用者の値は使わない。
- series/setup違いは捏造せず `estimate_low` と警告を付ける。
- タイム制レースは個人履歴の平均ラップを使ってグリッド時点の推定計画を作れる。
- 平均ラップ側の不採用理由も `lap_memory_rejection_reason` に記録。

### 3. `null秒`

日本語／ドイツ語の前方・後方停止車両コール全てで、`null`／`undefined` を数値扱いしない。
距離欠損時は「前方に停止車両。注意。」のように距離自体を省く。

## 再検証

- Bridge GAP authority / wiring: **51 tests OK**
- Session memory tunnel: **126/126**
- Build 291 real-failure replay including null guard: **42/42**
- Strategy playbook: **45 checks**
- Engineer card / multi-intent: **116/116**
- Local intent router: **54/54**
- GAP freshness: **70/70**
- Python / JavaScript syntax、`git diff --check`: 合格

## 未確認

- 9/4実走ログには他車のLapDistPct配列が無いため、新方式を同じ入力で完全再生できない。
- `direction_conflict` 2,796件はログで確認したが、修正版の実走で0件になった証明はまだ無い。
- Windows／iRacing／TTS実走は未確認。
- commit / push / Build / 公開は未実施。

## 次工程

1. Claude独立反証。
2. Codex Gate 4。
3. commit / push はYuji GO後。
4. Build後のGate 5でDesktop・Bridgeの同一SHAと同梱を確認。
5. Gate 8で `physical_traffic_gap`、記憶の推定ピット周、停止車両の距離欠損を実走確認。
