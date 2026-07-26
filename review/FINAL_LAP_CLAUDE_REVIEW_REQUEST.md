# Claude独立レビュー依頼：Final Lap / Last 5-3-1 Unit 1

日付：2026-07-26
状態：未コミット・未push・未ビルド
作業ツリー：`/private/tmp/pitwall-final-lap`（基点 `f26260c`）

## レビュー目的

7月25日のIMSA耐久で、Final Lapが実際より1周早く発話した欠陥を修正する。
時間制マルチクラスでは自車／クラス首位の周回番号ではなく、総合首位が
チェッカーを受ける壁時計時刻と、自車の将来S/F通過時刻を比較する。

## 変更ファイル

- `irsdk-bridge/final_lap.py`（新規・純粋関数）
- `irsdk-bridge/bridge.py`（テレメトリ／FSM／dispatch配線）
- `irsdk-bridge/tests_final_lap.py`（純粋モデル72件）
- `irsdk-bridge/tests_final_lap_wiring.py`（本番配線20件）
- `irsdk-bridge/tests_bridge_lifecycle_wiring.py`（旧Last 5/3/1テストを新契約へ移行、75件）
- `preflight.sh`（上記2スイートを出荷ゲートへ追加）

## 実装契約

1. 時間制は `CarIdxPosition == 1` の有効車だけを総合首位とする。
   既存の「最大CarIdxLapを代替首位とする」フォールバックはFinal Lapには使わない。
2. 総合首位の予測チェッカー時刻：
   - 次のS/Fが時間切れ後なら、そのS/F
   - 時間切れ前なら、時間切れ後に最初に到達するS/F
3. 自車の次回S/Fが首位チェッカーより後なら、自車は現在Final Lap。
   前なら、まだ次周がある。非首位で差が±0.5秒以内なら曖昧として沈黙する。
4. 自車／首位とも20–600秒の有効ラップ3本以上、LapDistPct有効、
   pit/garage外、FSM=RACINGが揃わなければfail-closedで沈黙する。
5. 時間制でモデルが不成立でも旧own-pace推定へfallbackしない。
   周回制だけ既存`SessionLapsTotal`経路を維持する。
6. Last 5/3/1は単一路線。閾値ジャンプ時は最も緊急な1件だけを出し、
   `DISPATCHED`後にだけ通過閾値を消費する。HELD/DROPPEDでは消費しない。
7. Final LapはP2。P3のduck/budgetで消失させない。
8. `RACING -> CHECKER_OUT`の真のedgeだけfallback noticeを許す。
   同フレーム`PLAYER_FINISHED`では出さない。
9. Final Lap計算は燃料残量・燃料履歴に依存しない。

## 7月25日回帰fixture

ログ照合値を固定：

- 残り時間：約82秒
- 総合首位の次S/F：約71秒後
- 総合首位平均：約114秒
- よって総合首位チェッカー：約185秒後
- 自車の次S/F：約120秒後、自車平均：約127秒

期待：自車はチェッカーまでに2回S/Fを通るため、この時点ではFinal Lapを発話しない。
テスト `7/25 regression predicts two crossings, not Final Lap` で固定済み。

## 機械検証

```text
tests_final_lap.py                    72 / 72
tests_final_lap_wiring.py             20 / 20
tests_bridge_lifecycle_wiring.py      75 / 75
preflight.sh                          PASS（ローカルHTTPポート許可環境）
git diff --check                      PASS
```

変異検出：

- checkerまでの追加周回計算を0へ破壊
- 時間制を旧own-pace値へ戻す
- Final Lap送信済みguardを削除
- `CarIdxPosition`を`CarIdxClassPosition`へ置換
- model呼出し削除
- dispatch後commit契約削除
- 旧milestone経路復活
- checker edge配線削除
- FuelLevelをFinal Lapの前提へ戻す

## E0との統合注意

この分離作業ツリーはE0差分を汚さないため、E0前の`f26260c`を基点にしている。
ここでは旧`broadcast()`へ最小のbool戻り値を追加して孤立テストを成立させた。
最終統合時はE0の三値契約
`BROADCAST_DISPATCHED / HELD / DROPPED`を権威とし、bool互換部分を持ち込まない。
したがって本レビューは、モデル・配線設計・回帰テストの承認であり、
E0上へ載せた最終差分は統合後にもう一度Claude独立レビューを行う。

## Claudeへ依頼する反対尋問

1. 時間制の壁時計式に境界／off-by-oneがないか。
2. ラップダウン車が首位より先／後にS/Fへ到達する両ケースが正しいか。
3. `CarIdxPosition==1`、pit/surface、pace sampleのfail-closedが不足していないか。
4. ±0.5秒曖昧帯が危険な断言を止められるか。
5. CHECKER_OUT fallbackとFinal Lapの二重発話経路が残っていないか。
6. stateがdispatch前に消費される経路が残っていないか。
7. E0統合時に競合する契約・状態reset・summary経路がないか。

コミット・push・exeビルドは禁止継続。承認後もE0上へ統合して再レビューする。
