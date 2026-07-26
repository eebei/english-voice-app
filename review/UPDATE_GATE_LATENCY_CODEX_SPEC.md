# Update Gate 表示遅延の短縮 — Codex 実装 spec

Date: 2026-07-26
Worktree: `/Users/yuji.s/Desktop/Claude/english-voice-app`
Status: uncommitted 前提・実装後 Yuji + Claude 独立レビュー待ち・commit/push/merge/build 禁止

## 目的

exe 起動から Update Required ゲート表示までの遅延を、現状 **4.5〜5秒** から **1.0〜1.5秒** に短縮する。

## 動機（Why）

- 現状: 4秒固定 setTimeout → GitHub API 往復 → DOM inject で実測 4.5〜5秒
- 2026-07-25 Road America 6HR 耐久で、ダートが旧ビルドで走ったことが判明。原因はほぼこの起動窓（3〜5秒間ユーザーが操作可能）で更新ゲート出現前に走り始めた可能性が高い
- テレメトリ解釈がバージョン依存のため、旧ビルドでの走行は誤読リスクあり（既存コメント `desktop/main.js:352-354` 参照）

## 変更対象ファイル

`desktop/main.js`

## 変更内容

### 現状 (`desktop/main.js:413`)

```javascript
setTimeout(checkForUpdate, 4000);   // 起動直後の輻輳を避けて少し待ってからチェック
```

### 目標

`win.webContents.once('did-finish-load', () => checkForUpdate())` に置換。

理由:
- `setTimeout(4000)` の意図は「webContents が ready 前だと `executeJavaScript()` が失敗する」ことへの保険（推定）
- `did-finish-load` イベントは renderer 読み込み完了を保証するため、`executeJavaScript()` の失敗リスクを固定 4秒より確実に排除できる
- renderer 準備完了直後 (~500〜800ms) にチェック開始 → GitHub API 往復 (~500ms) を足しても **合計 1.0〜1.5秒**

### 実装詳細（Codex 判断領域）

- `win` は `createWindow()` 内で作成されるため、`app.whenReady()` の同期チェーンの中で `win.webContents.once()` を掛けるか、`createWindow()` 内で完結させるかは Codex 判断
- `checkForUpdate()` 内部ロジック（バージョン比較・ゲート inject）は無変更が原則
- ただし `did-finish-load` を待つことで `win.webContents.executeJavaScript()` の失敗ケースが減るはずなので、既存の `.catch((e) => log('update gate inject failed: ' + e.message))` は残す

## 非目的（触ってはいけない範囲）

- fetch 並列先行（案 B）は今回スコープ外
- 起動スプラッシュによる完全ブロック（案 C）は今回スコープ外
- `checkForUpdate()` 内のバージョン比較ロジック
- ゲート DOM の HTML/CSS
- コード署名などのビルド系設定

## 検証条件

1. **実測秒数**: Yuji のマシンで exe 起動 → ゲート表示までの実測時間を、修正前 (setTimeout 4000) と修正後 (did-finish-load) で比較。修正後が **1.0〜1.5秒台**に収まること
2. **回帰なし**:
   - 最新版利用時は `up to date (local=...)` ログのみ出て、ゲートは出ない
   - dev build 時は `update check skipped (dev build)` ログのみ
   - build-info.json 欠損時はエラーなく静かに終了
   - ネット切断時は `checkForUpdate failed:` ログで静かに終了
3. **`executeJavaScript()` 失敗ログが増えていない**: `did-finish-load` を待つ設計なので失敗は減る想定。逆に増えていたら回帰
4. **既存の全 preflight（`./preflight.sh`）が緑**

## 禁止事項（プロジェクト標準）

- commit / push / merge / EXE build 禁止
- Yuji の明示承認までいかなる自動化も走らせない
- Claude が独立レビューを行った後、Yuji が最終承認

## 参考

- 既存の update gate 実装: `desktop/main.js:322-389`
- 既存の起動フロー: `desktop/main.js:391-417`
- 過去の update gate バグ: [[bug_update_gate_apostrophe]]（Build 166 でゲートがクラッシュしていた実績あり）
- 過去の SmartScreen 対応: [[session_20260716_onboarding_mic_crev]]（Build 170 で手動突破ガイドを追加）
