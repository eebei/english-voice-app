# Build 290 Gate 6 Windows実機確認

## 対象を固定

- public field-test candidate: **Build 290**
- public workflow run: `33152767207`
- final target commit: `7c1ad59facd98702bad648b378953e8c90ecd1b8`
- installer: `OMORAY-PITWALL-Setup-latest.exe`（日付版は`OMORAY-PITWALL-Setup-20260828-0748.exe`）
- installer size: `100,684,274 bytes`
- installer SHA-256: `5D6D343179BC2D4094EE09131AA0293B2860105AD71206EEC64F1391211892EE`

ローカルの`desktop/dist/`やprivate artifactを代用せず、公開update経路から取得する。取得したinstallerは実行前にPowerShellで照合する。

```powershell
(Get-Item .\OMORAY-PITWALL-Setup-latest.exe).Length
(Get-FileHash .\OMORAY-PITWALL-Setup-latest.exe -Algorithm SHA256).Hash
```

## Gate 6 基本確認

1. 旧Build 289への上書きインストールが完了する。
2. アプリ表示がBuild 290で、Bridgeログの版表示が`Build 290 (RBR memory, personal stats, and debrief routing)`と一致する。
3. Bridgeが多重起動せず1プロセスで、iRacing未接続・接続・セッション終了の状態遷移が破綻しない。
4. 診断画面のruntime module 10件がすべて`true`、missingが`[]`になる。
5. PTT、マイク入力、TTS、overlay、設定保存、診断表示が動作する。
6. 古いBuild 289へ戻す更新案内を表示しない。

runtime module 10件:

- `localIntentRouter`
- `driverProfileStore`
- `driverVocabularyStore`
- `dialogueStateManager`
- `circuitProfileStore`
- `conversationMemoryStore`
- `raceKnowledgeStore`
- `sessionEpisodeStore`
- `driverPreferenceStore`
- `driverRelationshipStore`

## Build 290 会話スモーク

- 「今ポジション何位？」に`class_pos`を含む現在順位で答える。
- 「トップは今何周目？」にclass leaderの周回を答え、残り周回やleader gapへ誤配線しない。
- 「直近5レースのインシデント平均は？」にログイン中本人の最大5件だけで答える。本人記録不足・identity不明時は推測や他人の値を返さない。
- 過去記録が`spielberg gp`のRBRで「今回初めて」「データがない」と誤案内しない。
- デブリーフは結果にかかわらず先に労い、その走行のincident／pit／paceの事実から具体的な質問を**一問だけ**行う。
- 「初めてじゃない、前にも走った」のようなLunaへの抗議を走行記憶として保存しない。
- 耐久では総量不足だけで早期`pit now`を出さず、Fuel Window、driver handoff、計画pitと実pitが破綻しない。
- 運転スタイル分析は`DRIVING_STYLE_CAPTURE`が成立した時だけ記録・助言し、captureなしを合格扱いしない。

## 判定と次工程

- Gate 5: Claude Code独立artifact確認署名済み（P0/P1/P2 0件）
- Gate 6: このWindows実機確認待ち
- Gate 7: server差分なしのためN/A
- Gate 8: iRacing実走待ち
- Gate 9: 公開workflow・公開URL取得照合済み

不一致時は、使用installer名・bytes・SHA-256、アプリとBridgeの版表示、再現発話、期待値と実値、該当ログ時刻を`review/PITWALL_SHARED_WORKING_LOG.md`末尾へ記録し、Gate 10停止条件を判断する。
