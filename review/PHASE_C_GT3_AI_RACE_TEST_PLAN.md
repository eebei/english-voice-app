# Phase C — GT3ワンメイク AI Race 実走試験票

## 目的

Build 251の `Pit Exit Forecast` が出した `Best / Likely / Worst` と、実際のピット出口クラス順位を照合する。
最初の3件を補正学習へ渡し、4件目で補正有効後の予測を初めて検証する。

この試験ではPhase Dの戦略判断は評価しない。「いつ入るべきか」ではなく、「この周に入った場合、どこへ戻るか」の精度だけを測る。

## 固定条件

- Build：251
- 形式：GT3ワンメイク AI Race
- 長さ：18分を基準（許容15〜20分）
- コース：全4本で同一
- 車両：全4本で同一GT3
- コンディション：ドライ固定、時刻と気温も同一
- 台数：自車を含め16〜20台
- 初期燃料：通常ペースで4〜5周走れる軽燃料
- 給油：全走行で同じ給油量
- タイヤ：全走行で交換しない
- Fast Repair：使用しない
- コーション：Green条件だけを採用

コースと車両は、Build 251の同一条件に `prediction_ready: true` のPit Loss校正がすでに存在する組み合わせを使う。候補は既存計画どおり Monza Grand Prix × Chevrolet Corvette Z06 GT3.R。校正が3件未満なら本試験へ進まず、先に同条件のPit Loss校正を完了する。

## 走行前チェック

1. PITWALLとBridgeを起動し、Build 251であることを確認する。
2. 対象条件の `pit_loss_calibration.json` を試験前にコピー保存する。ファイルの中身は編集しない。
3. 対象条件について次を記録する。
   - `usable_sample_count`
   - `prediction_ready`
   - `forecast_learning.outcome_count`
   - `forecast_learning.bias_ready`
   - `forecast_learning.likely_bias_positions`
4. AI全車が同一GT3クラスであることを確認する。
5. 給油量とタイヤ判断を全4本で固定する。

## 4本の試験マトリクス

| Run | ピット投入時の狙い | 予測を聞く位置 | 主な評価対象 |
|---|---|---|---|
| 1 | 中団の密集状態 | ピット入口の手前、同じ周回内 | 基準誤差、traffic / blend risk |
| 2 | 前後5秒以内に車がいる状態 | Run 1と同程度の位置 | 前後車両と合流リスク |
| 3 | 可能なら前後5秒超の空間 | Run 1と同程度の位置 | clear air判定、3件目の学習保存 |
| 4 | 再び中団の密集状態 | Run 1と同程度の位置 | 補正有効後の初回精度 |

Run 1〜3で希望する交通状態を作れなくても走行は捨てない。実際の交通状態を記録し、同じ種類に偏った場合だけ追加走行を判断する。

## 各Runの手順

1. スタート後、最低1周は有効なラップタイムを全車に作らせる。
2. ピットへ入る周のピット入口手前で、Lunaへ「今ピットに入ったら何位で戻れる？」と一度だけ聞く。
3. 返答を聞いたら、その周にピットへ入る。次周へ変更しない。
4. 指定した同一量を給油し、タイヤ交換なしで退出する。
5. ピット出口ライン通過後のクラス順位を記録する。
6. レースは可能なら完走する。予測採点後に中断した場合は、その事実を試験票へ残す。
7. Run終了ごとにBridgeデバッグログを別名で保存する。

## 1本ごとの記録欄

| 項目 | 記録 |
|---|---|
| Run番号 | |
| 日時 | |
| コース / 車両 | |
| AI台数 | |
| スタート燃料 / 給油量 | |
| ピット周 | |
| ピット進入時クラス順位 | |
| Best / Likely / Worst | |
| 予測した直前車 # / gap | |
| 予測した直後車 # / gap | |
| 予測traffic_state | |
| 実ピット出口クラス順位 | |
| Likely誤差（実順位 − Likely） | |
| Best〜Worst内か | |
| 実際の直前車 # / gap | |
| 実際の直後車 # / gap | |
| 無線の誤り・不明瞭点と時刻 | |
| ログファイル名 | |

## ログで必ず確認する証拠

各Runに次の2行が同一 `snapshot_id` で存在すること。

```text
PIT EXIT SHADOW forecast:
PIT EXIT SHADOW actual:
```

`actual` 側の `score` が `null` のRunは精度サンプルに数えない。次も確認する。

- `actual_class_position`
- `likely_position`
- `likely_error_positions`
- `inside_best_worst`
- `model_version`
- `forecast_learning.outcome_count`
- `forecast_learning.bias_ready`

## 初回判定

4本だけで完成判定はしない。Phase C実測の初回ゲートとして次を使う。

### 継続可能

- 有効な採点が4本中4本ある。
- `snapshot_id` の取り違えがない。
- 4本中3本以上で実順位がBest〜Worst内に入る。
- Likelyの絶対誤差平均が2.0順位以内。
- 4本目で `bias_ready: true` が確認できる。

### 要調査

- `score: null` が1本でもある。
- `class_standings_unreliable` が繰り返す。
- 実順位がBest〜Worst外になるRunが2本以上ある。
- Likelyが実順位から5順位以上外れる。
- 予測した前後車両と実際の前後車両が大きく入れ替わる。
- `traffic` / `clear_air` / `blend_risk` が実景と明確に矛盾する。

要調査時は補正値を手で直さない。該当Runの無編集ログとリザルトを先に比較し、入力欠損、他車のピットイン、AI順位値、サービス時間差のどれが原因かを切り分ける。

## 実走後に共有するもの

- 4本分の無編集Bridgeデバッグログ
- 各Runの公式リザルトまたは結果画面
- 記入済みの本試験票
- 試験後の `pit_loss_calibration.json` のコピー
- 誤答または不明瞭な無線があった時刻

Access ID、生ログ以外の個人情報、Memory V2のドライバー申告はPhase C検証資料へ含めない。
