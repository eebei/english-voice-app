# Codex → Claude Code：開発体制変更・次スプリント実装指示

**日付**：2026-07-21  
**決定者**：Yuji（Product Owner）  
**技術方針・合否判定**：Codex  
**実装担当**：Claude Code

## 0. 本日からの役割

- **Yuji**：商品価値、実走条件、体感、優先順位の最終決定
- **Codex**：ログ解析、技術方針、実装指示、受入条件、独立レビュー
- **Claude Code**：指示範囲の実装、テスト、変異試験、差分報告

Claude Codeは、レビュー依頼を受けて独自に製品優先順位を変更しない。別の問題を発見した場合は実装せず、`SIDE FINDING`として証拠・影響・推奨優先度だけを報告する。CodexまたはYujiが明示的に許可してから着手する。

今回の指示は**実装着手可**。追加の承認待ちは不要。ただしコミットはCodex再レビューまで行わない。

## 1. 今回の実測で確定した事実

対象：`strategy_ts-20260721-134043-ai-race.csv` / `OMORAY-bridge-debug-20260721-1250.log`

### ピットイベント

1. 14:08：実Box停止1回目。自動給油約6L、タイヤ交換なし
2. 14:12：ドライブスルー。停止・サービスなし
3. 14:14：実Box停止2回目。4輪交換＋オプショナルリペア約161秒
4. 14:29：レース終了後のピット／ガレージ移行。校正サンプルに使わない

`PitstopActive`の3サイクルは、ピットロード通過回数と同義ではない。ドライブスルーでは立たず、終了後ガレージ移行でも一時的に立つ。

### ピット入力

- `PitSvFuel`はiRacingの自動給油予定量。走行中に10→9→7→6Lと更新され、停止時の6Lと実増加量約6Lが一致
- `PitSvLFP/RFP/LRP/RRP`は設定圧。非ゼロでもタイヤ選択済みとは限らない
- タイヤ選択は`PitSvFlags`のbitで判定する
- `PitSvFlags`は選択状態であり、実際に完了した作業結果とは分離する
- 作業実績はflagsの遷移、燃料実増加、repair残量減少、`PitstopActive`、`PlayerCarPitSvStatus`、停止有無を組み合わせて確定する

### 時間実測

- ドライブスルー（OnPitRoad）：約19.4秒
- 約6L給油（OnPitRoad）：約30.4秒
- 観測差：約11.0秒
- 給油ピットのservice active：約7.3秒
- タイヤ＋長時間修理（OnPitRoad）：約192.5秒

総OnPitRoad時間には停止・給油・タイヤ・修理を含む。これらを総時間へ足し直して二重計上しない。

### F2Time・クラス

- `CarIdxF2Time[0]`は有効レース約31分で約15回しか変化せず、主に計時点で段階更新され、ピット停止中も凍結する
- `-1`は無効値。`0`にも未確定／先頭等の複数意味があり得るため単独で信用しない
- F2Time単独で即時復帰順位を出してはいけない
- CSVでは約40台が走行している一方、bridgeログは`drivers:1 / class空`。複数クラスのClassPositionが重複するため、現状は同クラス比較を安全に行えない

### レース終了

- 14:25:44に`SessionState 4→5`
- 14:27:15に残り推定が7周へ跳ね、終了局面で燃料不足／ピット計画を誤発話
- 14:28:19にYujiが「レース終わってる」と訂正
- リーダーへのチェッカー、自車のチェッカー、デブリーフを区別できていない

## 2. 優先順位

1. レース結果を壊す誤判断
2. 根拠のない回答・先送り・将来約束
3. 状態認識の誤り
4. 計算入力の品質
5. 会話品質
6. 翻訳・表示・言い回し

今回、翻訳漏れや「0秒後方」の言い換えは実装しない。別コミット候補として保留する。

## 3. 実装指示 R1：レース終了状態機械（P0）

巨大な`bridge.py`へ判定を直書きせず、副作用のない純粋Pythonモジュールへ分離し、bridge本体とテストが同じ関数をimportする。

最低限、次の状態を持つ。

```text
RACING
CHECKER_OUT       リーダーにチェッカー、自車は未完走
PLAYER_FINISHED   自車がチェッカー通過済み
DEBRIEF           ガレージ／走行終了後
```

### 判定条件

- iRSDKの実値・列挙値をコードコメントとテストfixtureで明示する
- `SessionState=5`だけで即`PLAYER_FINISHED`にしない
- `SessionState 4→5`時点の自車Lap/LapCompletedを保持し、その後の自車S/F通過を検出する
- 利用可能なら`CarIdxLapCompleted[PlayerCarIdx]`を優先する。存在を記憶で断定せず、既存dumpまたは実コード索引で確認する
- リーダー＝自車等の同時遷移もテストする
- ガレージ／telemetry inactiveで`DEBRIEF`

### 発話・計算ゲート

- `fuel_strategy_warning`と新規ピット戦略は`RACING`でのみ許可
- `CHECKER_OUT`では新規ピット戦略を禁止。必要なら一度だけ「最終周／チェッカーが出た。残量○L」
- `PLAYER_FINISHED`ではピット計画・残り周回計算を禁止
- `DEBRIEF`では走行中ディレクターを停止
- State 5以後、残り周回推定値を増加させない
- Last 5 / Last 3 / Last Lapは同じ節目を一度だけ発話し、チェッカー後に再発火しない

### R1必須テスト

- 通常のState 4継続
- State 4→5、他車／リーダーのみチェッカー
- State 5中に自車がS/F通過
- 自車がリーダーでState変化と完走が近接／同時
- State 5で残り時間値が増えても燃料戦略が発火しない
- PLAYER_FINISHED後にfuel/pit directorが発火しない
- garageでDEBRIEF
- 状態巻き戻り、sessionNum変更、telemetry再接続
- 旧バグを戻す変異で最低1件失敗

## 4. 実装指示 R2：同クラス入力をfail-closed（P0）

### 即時安全化

- active car数に対してDriverInfo rosterが不完全、PlayerCarIdx不在、PlayerCarのClassID不明、または比較車のClassID不明なら、復帰順位計算を禁止
- 構造化理由`NO_CLASS_MAP`（名称は既存体系に合わせてよい）を返す
- 未知の車名・カテゴリ表示でも、同じ数値ClassIDなら同クラスとして扱う
- 車名辞書や`GT3`という文字列だけで分類しない
- `CarIdxClassPosition`の順位番号だけで同クラス集合を推測しない

### 原因修正

- AI約40台なのに`drivers:1 / class空`となるSessionInfo解析経路を特定する
- 通常編成と未知車種混在編成を分けてfixture化する
- raw SessionInfoが現ログに無ければ、推測修正をしない。安全化を先に入れ、次回1回で採取できるread-only診断を追加する
- 診断追加が必要な場合、保存場所と実行方法をPITWALL本体側へ統合し、YujiにPowerShell手作業を要求しない

### R2必須テスト

- 3クラス×複数台、ClassPosition 1..Nがクラスごとに重複
- 未知車種名だがClassIDは既知／同一
- rosterが自車1台だけでtelemetry上は40台
- player class空
- 一部他車のみclass欠損
- 完全なrosterでは同クラス集合だけを返す
- 不完全時は推測せず`NO_CLASS_MAP`
- fail-openへ戻す変異で失敗

## 5. 実装指示 R3：F2Time入力契約（P1・計算器本体はまだ作らない）

このスプリントでは復帰順位の数値計算を完成させない。入力の有効／無効判定だけを純粋モジュールとして定義する。

- `-1`はinvalid
- 更新tick／更新SessionTimeを車ごとに保持し、staleを判定
- F2Time単独で現在位置を表現しない
- `CarIdxLap`、`CarIdxLapDistPct`、`CarIdxOnPitRoad`、`CarIdxTrackSurface`を必須入力候補にする
- 同クラスmapが無ければ無効
- 欠損理由を構造化する
- 出力は少なくとも`valid`, `reason`, `ageSec`, `sourceFields`を持つ

R3は入力契約とテストまで。予測式、confidence、発話文生成には着手しない。

## 6. ロガーの小修正（P2・R1/R2を遅らせない範囲）

- telemetry inactiveではCSVへ書かない
- 同一tickを重複保存しない
- sessionNum変更／tick巻き戻りを区間イベントとして記録
- 終了時にwritten / tick-race retry dropped / inactive skipped / duplicate skippedを別々に表示

ロガー修正がR1/R2を遅らせる場合は別コミットへ分ける。

## 7. コミット構成

コミットはまだ実行しない。差分は次の単位へ分けられる状態にする。

1. `R1 race lifecycle state machine and gates`
2. `R2 fail closed on incomplete class map`
3. `R3 define telemetry validity contract`
4. `P2 skip stale logger rows`（任意・別）

翻訳修正を混ぜない。既存の未コミット変更と混在している場合は、ファイル一覧と分離案を先に報告し、ユーザー変更を破壊する操作はしない。

## 8. 完了報告フォーマット

Claude Codeは完了時に次だけを報告する。

1. 各Rで変更したファイルと要点
2. 状態遷移表
3. 構造化unavailable reason一覧
4. 通常テスト結果
5. 変異テストのdiffと失敗ケース
6. 未解決事項（証拠付き）
7. コミット候補の分割

「preflightが緑」だけでは完了にならない。受入条件を直接検出するテストと、旧欠陥を戻した変異試験が必要。

## 9. 出荷判定

- R1/R2はCodex再レビュー必須
- R1/R2合格前にPhase Bの復帰順位計算へ進まない
- R3は契約レビュー後に初めて計算式設計へ進む
- Claude Codeはコミット・ビルド・配布を行わず、差分と証拠を提出する

## 10. 週末限定ベータの運用要件（追加決定）

### テスターへPython／PowerShell操作を要求しない

今回Yujiが行った手動Pythonロガー起動は開発診断限定であり、一般ユーザーおよび週末の開発ドライバー3名には要求しない。

- PITWALL起動中に必要な診断ログを自動開始する
- iRacing接続／sessionNum変更／切断で自動的に区間を分ける
- inactive／同一tick重複を保存しない
- セッション終了時にflushして確実に閉じる
- ログはセッション日時・track・匿名化可能なuser/session識別子で分離する
- UIに「診断ログを開く」または「サポート用ログを書き出す」を用意する
- サポート用書き出しはbridgeログ、戦略時系列、build/version、設定要約を1つへまとめる
- 生ログの自動外部送信は今回行わない。ユーザーが明示操作した時だけ書き出す

診断機能の統合が週末版を遅らせる場合、時系列全量の常時記録ではなく、戦略判断前後とピット／燃料／session遷移のリングバッファ保存へ縮小してよい。ただしPowerShell手順へ戻さない。

### 3人は同一チーム・同一セッション・全員利用とは限らない

週末版は、各ユーザーのPITWALLが他のPITWALL利用者なしで完結して動くことを必須とする。

- 3人が別チーム／別レースでも動く
- 同じチームでも1人または2人しかPITWALLを使わなくても動く
- 他ユーザーのPITWALL接続、共有メモリ、共有会話を前提にしない
- 判断入力はそのPCのiRacing SDKと、そのユーザー自身の保存履歴だけを使う
- 他ユーザーが同じチームかどうかを推測しない
- ユーザー間の燃料・ピット設定・戦略状態を混ぜない
- ログ、記憶、校正サンプルは最低限user/session/car/trackで名前空間を分ける

### 今週末はチーム同期を実装しない

同一車両のドライバー交代、チーム共有戦略、複数PITWALL間の同期は将来の`Team Mode`候補とし、今回の出荷条件に含めない。

同じ耐久チームで複数人がPITWALLを利用しても、週末版では各クライアントは独立動作する。共有されていない情報を「チームメイトから受け取った」ように扱わない。ドライバー交代を検出できない／入力が不完全な場合は、燃料履歴や戦略状態を引き継いだふりをせず、再初期化または構造化unavailableへ落とす。

### ベータ識別

各ログへ次を必ず含める。

- PITWALL build/version
- userまたはtester ID（匿名ID可）
- iRacing session ID/subsession ID（取得可能な範囲）
- sessionNum
- car/class/track
- calculator/version

これにより、3人のログを混同せず、使用者が2人だけの場合も欠測を障害と誤認しない。
