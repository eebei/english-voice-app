# Unit 1 Final Lap：実装根拠と確定契約

**日付**：2026-07-26
**状態**：E0独立レビュー待ちのため実装未着手
**対象実測**：`OMORAY-bridge-debug-20260725-1423.log`

## 7月25日耐久ログで再現した欠陥

現行の時間制計算は `own_pace_lapped` を使い、次の順序で動いた。

```text
22:44:07  final_lap_notice候補
          lap=166 / rem_est=1 / timeRemain=82.0
22:44:10  「ファイナルラップ」発話完了
22:46頃    自車が次のS/Fを通過（Lap 167）
22:47:12  SessionState 4→5（総合首位チェッカー）
22:48:23  自車がさらにS/Fを通過（Lap 168）
```

したがって22:44時点の自車のfinishまでのS/F通過数は1ではなく2。
Yujiの「Final Lapが1周早い」という体感とログが一致する。

## v3/v4設計に対する追加確認

### 時刻モデル

総合首位の「時間切れ後、最初のS/F」と、自車が今後S/Fへ到達する時刻列を
比較する方式を採用する。周回差をlap番号の引き算で補正しない。

7月25日の再現値では、`timeRemain=82s` の後に総合首位チェッカーまで約185秒、
自車はその前後に2回S/Fを通過している。この形は
`estimated_crossings_to_finish=2` を返すべきfixtureとして固定する。

### leader pit/garage入力

v4では未証明扱いだったが、現リポジトリで次を確認済み。

- `log_strategy_timeseries.py` が `CarIdxOnPitRoad` と
  `CarIdxTrackSurface` を記録対象にしている。
- `bridge.py` が両64要素配列を本番で読み取っている。
- `f2time_contract.py` も両入力を必須候補として契約化している。

よってleaderについて、

```text
CarIdxOnPitRoad[leader_idx] == True
または
CarIdxTrackSurface[leader_idx] in (-1, 0, 1, 2)
```

の間はFinal Lap予測をfail-closedできる。`False` 固定運用は不要。
ただしTrackSurface=2（ApproachingPits）をoff-racing-lineとして黙るかは、
pit entry直前の有効なリーダーを過剰に除外する可能性があるため、
初版は `OnPitRoad=True` またはsurface `-1/0/1` を除外し、
surface `2/3` は有効とする。

## 実装境界

- 新規純粋モジュール `irsdk-bridge/final_lap.py` に置く。
- `bridge.py` は入力収集、純粋関数呼出し、milestone配線、broadcastだけを担う。
- `MIN_AVG_LAP_S=20.0` / `MAX_AVG_LAP_S=600.0` /
  `MIN_PACE_SAMPLES=3` / `SAME_TIME_TOL_S=0.5` は純粋モジュールへ置く。
- confidence名は `model_valid | ambiguous | none`。
- 時間制のLast 5/3/1は全て新しい
  `estimated_crossings_to_finish` へ一本化する。
- 周回制は検証済みの既存 `SessionLapsTotal` 経路を維持する。
  `SessionLapsRemain`は基準未確定のため使用禁止。
- `final_lap_notice` をP2へ昇格する。
- CHECKER_OUT通知は `RACING→CHECKER_OUT` の遷移時だけ。
  `RACING→PLAYER_FINISHED` 同フレームでは発火しない。
- 文言は「総合首位がチェッカーを受けた。ファイナルラップだ。」
- Final Lapが既にdispatch済みならCHECKER_OUT通知を重ねない。
- `broadcast()==DISPATCHED` の時だけmilestone sent状態を確定する。
  E0でbroadcastが3値化されたため、暗黙bool判定は禁止する。

## 必須テストへの追加

v4のCase 1–39 / M1–M16に加えて次を固定する。

1. 7月25日再現fixture：`timeRemain=82s` 相当でcrossings=2、Final Lapなし。
2. leader `OnPitRoad=True` → fail-closed。
3. leader `TrackSurface=-1/0/1` → fail-closed。
4. leader `TrackSurface=2/3` →他入力が正常なら評価継続。
5. `broadcast()==HELD/DROPPED` ではsentを消費しない。
6. E0 INACTIVE中に候補が落ちてもmilestoneを消費せず、
   ACTIVE復帰後に正しい現在値から再評価する。
7. time raceで旧`own_pace_lapped`値と新crossingsが不一致の場合、
   milestoneへ渡るのは新crossingsだけ。

## 実装開始条件

Unit E0をClaudeが独立レビューし、YujiがE0コミットを承認した後。
E0とFinal Lapを同一未コミット差分へ混在させない。
