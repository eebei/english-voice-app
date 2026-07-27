# Build 231 Claude 独立レビュー依頼

**日付**：2026-07-28
**基準Build**：公開済み Build 230
**状態**：実装完了・未コミット・全preflight緑
**禁止継続**：修正、commit、push、merge、build、deployを行わず、file:line evidenceでレビューすること。

## 第1回レビュー差し戻しへの対応（2026-07-28）

第1回結果：P0 0 / P1 2 / P2 4。

### P1-1 Luna口調契約の矛盾

- LunaJP strategyの旧`MAXフランク／敬語禁止／あんた`規則を実行経路から除外
- 新しいstrategy規則を単独で構成
- `buildSystem({character:'LunaJP', mode:'strategy'})`を実行する動的テストを追加
- 実生成prefixに旧規則が含まれず、女性標準語契約が含まれることを検証

### P1-2 Active中late joinの緑バー欠落

- handler接続時に副作用なし`iracing_status` snapshotを必ず送信
- `detected`と`telemetry_active`を同時同期
- rendererはsnapshotで`iracingDetected` / `iracingLive` / `usageIracingLive`を更新
- `iracing_connected`は再送しないため、usage session再発行・briefing再実行を起こさない

### P2 Session Authority track UNKNOWN時の全履歴選択

- `lastTrack`未確定時は`buildPreviousRaceBriefingNote()`をfail-closed
- 履歴全件から直近を選ばず、「現在コース未確定」として過去結果を使わない

### 第2回レビューでP2へ降格したLuna character先頭の「タメ口」

- 出荷対象が口調改善そのものなので、P2のまま残さずcharacter定義からも除去
- 冒頭、デブリーフ説明、全モード禁止事項、共通cadenceの4箇所を
  「親しみのある自然な女性の標準語」へ統一
- 動的`buildSystem()`テストで`気の置けないタメ口` / `Lunaはタメ口`が実生成prefixに
  含まれないことを追加検証

追加テスト結果：

- `tests-radio-brevity.js`：29/29
- `tests-iracing-detection.js`：8/8

## 背景となる実走証拠

1. `OMORAY-bridge-debug-20260727-2021.log`
   - Lunaの乱暴・男性的な口調
   - Markdown `**` 等の読み上げ
   - 前回戦歴がロード済みでもブリーフィングで未活用
   - ピット文言、発話安全窓、PTT/STT耐性に関する実走指摘
2. `OMORAY-bridge-debug-20260727-2222.log`（八木氏、Build 230）
   - Desktop→Bridge接続は成立
   - iRacing共有メモリopen済み
   - `>>> iRacing CONNECTED`なし
   - 36秒後に通常終了
   - 従来UIでは「未起動」と「検出済みTelemetry待ち」を区別不能

## レビュー対象

### A. Luna口調契約

- `MAXフランク`・敬語禁止を撤廃
- 自然な女性の標準語へ変更
- 「あんた」「お前」「しようや」「やろうや」「申し訳ねぇ」を禁止
- race / strategy / debriefの後着ルールでも上書きを保証

確認観点：

- 既存の共通プロンプト中にある男性的表現へ再び引っ張られないか
- Luna以外のキャラクターへ意図せず口調制約が漏れないか

### B. TTS Markdown最終関門

- `stripMarkdown()`を、対になった記法だけでなく未閉じの`**`にも対応
- 見出し、箇条書き、リンク、画像、バッククォート等をTTS直前に除去
- 画面表示と会話履歴は変更せず、音声だけをclean化

確認観点：

- ストリーミングchunk境界でも記号を読まないか
- 数値、ラップタイム、通常の句読点を壊さないか

### C. 前回レース・ブリーフィング

- 同コース、可能なら同車両の直近結果を1件選択
- 褒めてよい根拠を「P3以内／Incident 0／過去ベスト更新」に限定
- 根拠なしの美辞麗句を禁止
- SessionInfoが権威。起動時の「レース？テスト？」決め台詞を全キャラから廃止
- Practice / Qualify / RaceをAI側から宣言し、UNKNOWN時は推測しない

確認観点：

- `incidents`未定義をIncident 0と誤認しないか
- 車名のlegacy class keyとの照合で前回記録を不当に落とさないか
- 前回の悪い結果を「良いレース」と褒めないか
- 起動挨拶と接続後briefingが重複しないか

### D. 発話安全窓・ピット文言・PTT/STT・Desktop状態

既存の同一未コミット差分も一括対象：

- 通常発話は舵角約7度／Brake 12%未満の安全窓まで保留
- P0/P1安全無線と期限付きピット手順だけ即時
- `pit_entry`からBox削除、`pit_exit`重複削除、`limiter_off`安全警告維持
- マルチクラスから「譲ろう」を削除
- STTの一時エラーを短いretryで回復
- 設定IPC debounce、音量／Voice／アクセスコード等の永続化
- NSIS更新導線

確認観点：

- 安全窓が永久閉鎖しないか
- reply chunkの順序と遅延
- STT timeout用AbortControllerをretry間で再利用する回帰
- 同期IPC削減後の設定消失

### E. iRacing検出済み／Telemetry待ち

- Bridge共有メモリopen時に`iracing_detected`を送信
- Browser後着時も現在状態をsnapshot送信
- rendererに`iracingDetected`を追加
- UIを次の4状態へ分離：
  1. Desktop↔Bridge未接続
  2. Bridge接続・iRacing未検出
  3. iRacing検出済み・Telemetry非Active
  4. Telemetry Active
- 非Active中は10秒ごとに`status`と`tick`をログ
- 15秒未満の瞬断復帰で内部Active状態を復元

確認観点：

- Bridge openがBrowser接続より早いrace
- active→短時間inactive→active
- active→15秒inactive→close→再open
- `_iracing_mem_detected` / `_iracing_telemetry_active`のthread間可視性
- 初期open済み・Status 0のまま長時間待機した場合のログ量
- この変更が接続成立そのものを遅延・阻害しないか

### F. 期限更新

- Phase A–B：2026-07-31維持
- Phase C–E：2026-08-07へ前倒し
- 2026-08-03〜04に実走開始、2026-08-08耐久本番を想定

## 追加・更新テスト

- `tests-radio-brevity.js`：27/27
- `tests-iracing-detection.js`：7/7
- `tests-speech-window.js`
- `tests-memory-wiring.js`
- `tests-ptt-capture.js`
- `tests-desktop-state.js`
- `tests-speak-async.js`
- `tests-tts-fail-logging.js`
- `irsdk-bridge/tests_driver_handoff.py`
- `irsdk-bridge/tests_judge_llm_gate.py`

`./preflight.sh`：全項目合格、`✅ 出荷可`

## 未追跡ファイルの扱い

- `PITWALL_発話種別一覧.txt`はユーザー指示どおり未追跡のまま保持。レビュー対象外。
- `review/AUTOMATED_DIAGNOSTIC_TELEMETRY_TODO.md`は月内TODO。今回の自動送信実装ではない。

## 出力形式

- 契約A〜Fを各々verify
- P0 / P1 / P2分類
- 各指摘に`file:line`、failure scenario、最小修正案
- 既存の未コミット差分との合成リスクも確認
- 承認可否はYujiの判断領域として書かない
