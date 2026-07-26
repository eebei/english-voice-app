# Cost Telemetry 独立レビュー依頼（2026-07-26）

## 役割と禁止事項

Codex実装に対するClaude Codeの独立レビュー。レビューのみ行い、修正・commit・push・merge・buildは禁止。
承認後もYujiの明示承認までコミットしない。

## 目的

テスターがログを手動提出しなくても、PITWALLのAPI原価をユーザー／セッション／利用内容別に
測定できるようにする。全文会話とraw iRacing telemetryは回収しない。

## 変更ファイル

- `auth.js`
- `server.js`
- `desktop/renderer.html`
- `irsdk-bridge/bridge.py`
- `public/privacy.html`
- `tests-cost-telemetry.js`
- `tests-usage-google-attribution.js`
- `preflight.sh`

ユーザー所有の未追跡 `PITWALL_発話種別一覧.txt` は対象外・変更禁止。

## 実装契約

1. Desktopは累積カウンターを60秒ごと、iRacing切断時、アプリ終了時に送る。
2. 送信失敗はlocalStorageへ最大20セッション保持し、次回起動時に再送する。
3. DBは`session_id`主キー＋単調増加`sequence`でUPSERTし、再送を二重計上しない。
4. 古いsequenceは新しい累積値を巻き戻さない。
5. Anthropic実費、Google課金単位、Desktopチェックポイントは同じ`session_id`で結合する。
6. E0の`driver_activity`をbridge→renderer→chatへ伝播し、以下へ分類する。
   - ACTIVEのPTT/typed: `driver_support`
   - DRIVER_HANDOFF/INACTIVE_DRIVER/FINISHEDのPTT/typed: `team_engineer`
   - judge/pace: `auto_driver_support`
7. Build 220以前は`driverState=garage`を`team_engineer`のfallbackにする。
8. ベータアクセスコードの生値はusage DBへ保存しない。サーバー検証後のテスター名とSHA-256だけを保存する。
9. 匿名・無認証のチェックポイント投稿を拒否する。
10. 会話本文・raw telemetry・メールアドレスをチェックポイントに含めない。
11. 管理API `/api/usage/session-stats` でセッション時間、分類回数、Anthropic原価、
    TTS文字数、STT秒数を結合して取得できる。
12. privacyページは実際の収集内容と再送動作を明記する。

## 重点レビュー観点

### P0/P1候補

- `beforeunload`時にキュー保存前にrendererが破棄される経路がないか。
- `newUsageSessionId()`の非同期終了送信と新セッション生成が混線しないか。
- periodic送信と終了送信が競合してもsequenceで最新値を失わないか。
- 古い再送が新しいDB行を上書きしないか。
- E0 reset二経路と通常遷移の全てで`driver_activity`がrendererへ届くか。
- 非搭乗中のチーム車`driverState=track`が`driver_support`へ誤分類されないか。
- checkpoint endpointが偽betaCode、巨大値、不正日時、session_id衝突を安全に処理するか。
- access codeやdevice IDの生値がDB・管理API・ログへ漏れないか。
- rate limit 12/minで通常運用・再送キュー回復を妨げないか。
- DB migrationが既存本番表に安全か。

### P2候補

- `normal_exit`の意味が「終了送信を試みた」と「サーバーが受領した」で混同されないか。
- Google実費はまだ推定単価なので、管理APIの名称が過剰な確定表現になっていないか。
- privacy文言と実装の差異。

## テスト

- `node tests-cost-telemetry.js`: 25/25
- `node tests-usage-google-attribution.js`: 40/40
- `python3 irsdk-bridge/tests_driver_handoff.py`: 125/125
- `python3 irsdk-bridge/tests_phase_ab_integration.py`: 28/28
- `./preflight.sh`: 全緑・出荷可

変異試験：

- sequenceガード削除を検出
- 終了時送信削除を検出
- E0非搭乗分類破壊を動的検出

## 報告形式

P0/P1/P2順、ファイル・行・再現条件・影響・最小修正条件を示す。
問題がなければ各契約1〜12を確認した根拠を簡潔に示し、承認可否を明記する。

## 独立レビュー結果

初回レビューでP0なし、P1 3件（flush競合、接続直後の分類ドリフト、
429時の再送回復）、P2 3件を確認。P1を修正し、回帰・変異テストを追加した。

修正後の再レビュー結果（2026-07-26）：

- flush単一in-flight化：契約準拠、P0/P1なし。後着レコードの1周期遅延窓のみP2。
- `driver_activity`強制通知：契約準拠、P0/P1なし。初回フレームの冪等な重複通知のみP2。
- 429中断・次周期再送：契約準拠、P0/P1/P2なし。
- 総括：元のP1 3件はすべて解消。P0/P1は0件。

最終検証：

- `node tests-cost-telemetry.js`: 29/29
- `./preflight.sh`: 全緑・出荷可
