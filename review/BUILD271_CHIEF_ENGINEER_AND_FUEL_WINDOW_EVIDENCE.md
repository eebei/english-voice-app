# Build 271候補 — Chief Engineer v0 / Fuel Window T-1 証拠

日時: 2026-08-15 JST
基準公開版: Build 270
状態: 実装・内部再生・全preflight・Windows Build・公開URL取得確認まで完了。

## 実装した動線

1. `⚙ Settings` に `Chief Engineer Mode` を追加。
2. 走行順3名、現在担当、ON/OFFを保存し、Bridge接続時に同期。
3. Race中の `ACTIVE → DRIVER_HANDOFF` だけを発火境界にする。
4. 2名未満、Practice/Qualifying、モードOFF、ACTIVE以外からの遷移は発火しない。
5. Plan、次ピット周、給油設定、チェッカー予測燃料余裕、損傷証拠を確定値だけでパケット化。
6. 非搭乗時の通常radio抑止に落ちない専用イベントでrendererへ配送。
7. Lunaが次担当名を含む短い引き継ぎを発話し、現在担当を次へ自動更新。
8. Plan Bは旧「1周延長」ではなく、Fuel Window起点の条件付きアンダーカットへ統一。
9. Fuel Windowが開く1周前にPlan A/Bを判断。成立しない場合のみPlan A予定周の1周前へフォールバック。
10. 判断周はペースキープ、対象周は短いBOX callとして別triggerで1回だけ発話。
11. 燃料余裕の下方修正時は既存の継続監視から `残量下方修正。ペースキープ。` へ接続。

## 内部テスト実測

- `tests-chief-engineer-mode.js`: 16/16
- `irsdk-bridge/tests_driver_handoff.py`: 154/154
- `tests-engineer-card.js`: 94/94
- `tests-strategy-recalculation-jp-radio.js`: 39/39
- `irsdk-bridge/tests_bridge_recalculation_wiring.py`: 75/75
- `tests-speech-latency-trace.js`: 3/3
- `tests-cost-telemetry.js`: 29/29
- `./preflight.sh`: 全項目合格、最終結果 `出荷可`

途中で検出・修正したP0:

- 交代瞬間に、同フレーム後段でしか生成されない `_battle_context` を参照していた。
- pyflakesが未定義名として検出。交代時点ですでに存在するBridge権威値 `nearest_ahead_gap` へ修正。
- 修正後に権限付き全preflightを再実行し、未定義変数なし・全項目合格を確認。

## 原価・発話検査

- 通常テストで実Anthropic API呼出なし。
- 通常テストで実Google STT/TTS呼出なし。
- 実APIスモーク未実施。
- 外部へのBuild公開・メッセージ送信なし。
- 発話生成／キュー／再生開始／破棄のtrace契約は既存の `tests-speech-latency-trace.js` 3/3で合格。
- この変更専用テストは決定論的fixtureのみ。実音声を再生していないため、専用テスト内のplayed replyは0。

## 未確認・未実装の境界

- Windows exeへの取り込みは未Build。
- Windowsでの設定保存・Bridge受信・実iRacing交代は未実測。
- 音声の自然さ、間合い、実際の耐久交代タイミングは実走確認が必要。
- v0は同じPC上のLunaによるローカル引き継ぎ。別PCの次ドライバーへパケットを送るチーム共有クラウドは未実装。
- ソース内表示は `Build 271 (Chief Engineer and Fuel Window T-1)` へ更新済み。

## 出荷判断

Yujiの明示GO後にBuild 271として公開完了。

- 実装コミット: `db9ce61`
- 公開workflow: `31863165606`、全工程成功
- Release名: `OMORAY PITWALL Desktop — Build 271`
- 公開URL: `https://github.com/eebei/english-voice-app/releases/download/desktop-latest/OMORAY-PITWALL-Setup-latest.exe`
- 公開installer実取得: 100,595,692 bytes
- SHA-256: `f01ba76c5d82b1701bcc5d62bba4a59777a7231e3cdebf49580c24fa6063751a`

Windowsでの起動・旧Buildからの更新取得・実iRacing交代・実音声は未実測のため、公開完了と実走確認完了を混同しない。
