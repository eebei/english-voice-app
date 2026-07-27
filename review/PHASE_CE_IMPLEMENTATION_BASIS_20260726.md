# Phase C–E 実装基盤

**日付**：2026-07-26
**期限**：2026-08-07
**状態**：既存CSVによる入力監査完了、実装未着手

## 結論

旧案の次式は、そのままでは採用しない。

```text
predicted_player_f2 = current_player_f2 + pit_loss
rejoin_position = count(other_f2 < predicted_player_f2) + 1
```

理由は、`CarIdxF2Time`が現在位置を連続表現する値ではないため。
同一tick CSVで、主にS/F等の計時点で段階更新され、ピット中は凍結することを再確認した。

## 実測結果

対象：

- `strategy_ts-20260721-134043-ai-race.csv`
- `strategy_ts-20260721-203846-ai-race.csv`

### F2Time更新間隔

`SessionState=RACING`、`CarIdxTrackSurface=3` の車について、
F2Time値が変化した間隔を集計した。

| CSV | 変化数 | 中央値 | p90 | p95 | p99 |
|---|---:|---:|---:|---:|---:|
| 13:40 | 625 | 110.82s | 141.18s | 206.45s | 263.98s |
| 20:38 | 674 | 104.97s | 136.97s | 204.08s | 221.55s |

5秒や10秒のfreshness thresholdでは、正常な値の大半がstaleになる。
逆に200秒を許すと「現在位置」と呼べない古い値を通す。
したがってF2Timeのage閾値だけで復帰順位入力の妥当性を決めない。

### ピット中の凍結

20:38 CSV、player car idx 0：

```text
21:04:21 pit entry       F2Time=99.376
21:04:29 pit stall start F2Time=114.666
21:04:33 stall end       F2Time=114.666
21:04:48 pit exit        F2Time=114.666
21:04:50 track return    F2Time=114.666
```

S/Fを跨いだ時に一度更新した後、停止・退出中は凍結している。

### 既存CSVだけではsame classを再構成できない

配列にはClassPositionはあるがCarClassIDがないため、
異なるクラスのP1/P2が複数存在する。オフラインreplayで同クラス車だけを
選べない。20:38ログは当時のSessionInfo class mapも不完全だった。

## 新しいstrategy snapshot契約

bridgeが同一tickで次を生成する。

```text
snapshot_id
session_num
session_time
track
car_model
player_car_idx
player_class_id
player_class_position
player_fuel_l
planned_fuel_add_l
planned_tire_service
repair_s
pit_loss_calibration_id

cars[]:
  car_idx
  class_id
  class_position
  overall_position
  lap
  lap_dist_pct
  f2_time
  f2_last_update_session_time
  est_time
  last_lap_time
  on_pit_road
  track_surface
```

必須入力が欠けた車は候補から除外し、playerまたは校正値が欠ければ
snapshot全体を`unavailable`にする。

## 復帰順位モデルの選抜

最初から一つの式を正解扱いしない。記録済みsnapshotを使い、
複数モデルを実際のpit exit class positionと照合する。

### Candidate A：F2 scoring gap

旧案。F2Timeへpit lossを加える。baselineとして残すが、
凍結と非同期計時点のため採用には実測精度が必要。

### Candidate B：lap progress + calibrated time projection

- `lap + lap_dist_pct` で順序を保持。
- `CarIdxEstTime` と直近lap timeから、予測時刻後の進行位置を投影。
- S/F跨ぎをlapへ繰り上げる。
- pit中の相手は観測事実として別scenarioへ置く。

### Candidate C：hybrid

- 順位と周回差はlap/class positionをauthorityにする。
- 同一周回の近傍車だけEstTime差で前後を投影。
- F2Timeは診断と大きな周回差の補助に限定する。

採用条件：

- replay 10ストップ以上。
- 実復帰順位がbest–worstレンジ内80%以上。
- likely誤差の中央値が±1台以内。
- class map欠損、session transition、repair、towを除外した結果で評価。
- 条件別成績を保存し、全条件を一つの平均へ混ぜない。

## best / likely / worst

ピットロス校正の分布から機械的に作る。

- `best`：Q1のobserved loss。
- `likely`：median。
- `worst`：Q3。
- 同条件3サンプル未満：予測しない。
- 他車が既にpit road上なら「その車もpit中」scenarioを追加。
- コース上の他車が次周pitへ入る確率は捏造しない。

出力：

```json
{
  "available": true,
  "snapshot_id": "...",
  "best": 5,
  "likely": 6,
  "worst": 7,
  "assumptions": {
    "fuel_add_l": 18,
    "tires": false,
    "repair_s": 0,
    "other_cars_pit": "only cars already observed on pit road"
  },
  "evidence": {
    "pit_loss_median_s": 27.1,
    "pit_loss_iqr_s": [25.9, 28.4],
    "sample_count": 5,
    "model_version": "..."
  }
}
```

## Phase D：戦略比較

比較対象を数値エンジンが作り、LLMは説明と選択理由だけを担当する。

初版option：

- `pit_now`
- `pit_next_lap`
- `extend_n_laps`
- `fuel_only`
- `fuel_and_tires`

各optionは同じsnapshotから、

- rejoin best/likely/worst
- traffic density
- expected fuel margin
- tire confidence
- pit-loss calibration confidence
- unavailable_reason

を返す。比較できないoptionは「不利」とせず`unavailable`にする。

## Phase E：undercut / overcut

### 言ってよい条件

- 同クラス対象車が明確。
- 自車と相手の現在class position/lap/gapが有効。
- 自車のpit loss校正が同条件3本以上。
- 自車の直近clean paceが3周以上。
- 相手のpit状態は観測事実だけを使う。
- traffic/rejoinレンジが利用可能。

### undercut提案

```text
pit_nowのlikely rejoinがclear air
かつ
現在のtraffic lossまたは相手との差を、fresh tire/fuel効果の実測範囲で回収可能
```

タイヤ効果の実測がなければ「undercut」という名称で断言せず、
「今入ればclear airへ出られる」という観測事実だけを伝える。

### overcut提案

```text
extend optionの燃料marginがsafe
かつ
現在のclean paceが相手より有利
かつ
後続trafficが許容範囲
```

相手の燃料・pit intentは取得できないため、
「相手は次に入る」と予測してはならない。

### 発話契約

- 一発話一根拠。
- 数字はcalculator出力だけ。
- 推奨と仮定を分ける。
- `unavailable_reason`があれば自由文LLMへ流さない。
- ドライバーが質問した応答は自動発話予算の対象外。
- 自動提案はP3候補で、同じsnapshot/optionを重複発話しない。

## ロガー追加項目

次の実走前に`log_strategy_timeseries.py`へ追加する。

- `CarIdxPosition`
- `CarIdxClassID`（SDK名が無ければSessionInfo class mapのsidecar）
- `CarIdxEstTime`
- `CarIdxLastLapTime`
- player car model / class ID
- pit calibration sample ID
- SessionFlags

CSV単独でsame classと答え合わせを再構成できることを受入条件とする。

## 変異試験

- class filter削除 → 別クラスを復帰順位へ混入。
- pit中F2Timeをlive扱い → 凍結値で誤順位。
- pit loss加算の符号反転 → pitで順位が改善。
- Q1/Q3反転 → bestがworstより悪化。
- 3サンプル未満guard削除 → 根拠不足で予測。
- repair sample除外削除 →通常stop分布を汚染。
- `unavailable_reason`削除 →自由文LLMが推測。
- 他車のpit intentを捏造する分岐追加 →事実契約テスト失敗。

## 実装順

1. Phase B pit-loss calibrator
2. snapshot logger拡張
3. replay harness
4. Candidate A/B/C比較
5. 採用モデルを純粋Pythonモジュール化
6. strategy guardへ構造化接続
7. option comparison
8. undercut/overcut条件
9. Claude独立レビュー
10. 実走答え合わせ
