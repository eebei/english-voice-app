# Build 286 — Gate 6 Windows handoff

## 前提

- 対象は **Build 286 private artifact** のみ。
- Build 285、公開latest、ローカルソースはテスト対象にしない。
- Gate 5（Codex独立artifact検査）が完了するまで、Yujiへ実行依頼を出さない。

## Yujiが行う確認

1. Gate 5 evidenceに記載されたBuild 286 installerを取得する。
2. クリーンインストールが成功すること。
3. 既存の旧PITWALLから上書き更新できること。
4. タイトルバー／Bridgeログ／Build表示がすべて286であること。
5. Bridgeが一重で起動し、iRacing未起動→検出→live telemetryへ遷移すること。
6. 起動ログの`RUNTIME_MODULE_STATUS`を確認する。
   - `status: "loaded"`
   - `missing: []`
   - runtime module 8本がすべて列挙されること
7. PTT、マイク、TTS、Race Overlay、Settings保存を確認する。
8. 旧URLと現行URLが同じprivate candidateを指すことを確認する。
9. ACK（Build番号・起動時刻・結果）を共有MDへ記録する。

## 不合格時

- Build番号不一致、module欠落、Bridge二重起動、ACK欠落のいずれかがあればGate 6不合格。
- 実走へ進めず、症状・時刻・ログ名・対象SHAを共有MDへ記録する。

## 役割

- Claude：手順・artifact情報・証拠MDを更新する。Yujiへ同じ確認を再質問しない。
- Codex：Gate 5独立判定と結果記録。
- Yuji：このGate 6のWindows実機操作とACKのみ。

Gate 6合格後に、Gate 7（server反映）とGate 8（iRacing実走）へ進む。公開はGate 9の別GOまで禁止。

---

# Claude Code 追記 — artifact情報と実機手順（2026-08-26）

役割分担「Claude：手順・artifact情報・証拠MDを更新する」に従い、実機で必要な具体情報を埋める。
**Gate 5 が Codex で完了するまで、Yuji へ実行依頼は出さない**（本書 §前提）。

## 1. 取得する installer

```
https://github.com/eebei/english-voice-app/actions/runs/32911905149
→ Artifacts → OMORAY-PITWALL-Desktop-Build-286-20260825-2342
```

zip 内の3本はすべて同一内容。**どれを使ってもよい**（同一ハッシュを実測確認済み）。

| 項目 | 値 |
|---|---|
| ファイル | `OMORAY-PITWALL-Setup-20260825-2342.exe` |
| サイズ | 100,660,198 bytes |
| SHA-256 | `4D87C3E436CB8428727BBFFBF11356EEB9F7609427AB40FD377ED2B6C0679F13` |
| 対象SHA | `88517124f0868436b00d312d718c495d096411f1` |

Windows 側でのハッシュ確認：

```powershell
Get-FileHash .\OMORAY-PITWALL-Setup-20260825-2342.exe -Algorithm SHA256
```

**一致しなければインストールしない。** 別物を掴んでいる。

**SmartScreen が出る**（コード署名していないため）。「詳細情報」→「実行」。

## 2. Build 番号をどこで見るか（本書 項目4）

| 場所 | 期待値 |
|---|---|
| タイトルバー | `Build 286` を含む |
| Bridge ログ 1行目 | `=== OMORAY PITWALL Bridge session start (BUILD Build 286 (decision memory, server ledger and derived runtime module diagnostics)) ===` |
| 対象Build | 286 |

## 3. 診断ログの場所（本書 項目6）

**デスクトップ**に出る。

```
%USERPROFILE%\Desktop\OMORAY-bridge-debug-<日時>.log
```

`RUNTIME_MODULE_STATUS` を検索する。期待する形：

```
RUNTIME_MODULE_STATUS {"modules":{
  "memory-action-layer.js":true,"strategy-playbook.js":true,"fuel-plan-guard.js":true,
  "cost-meter.js":true,"local-intent-router.js":true,"session-memory.js":true,
  "decision-memory.js":true,"gap-freshness.js":true},
  "missing":[],"status":"loaded"}
```

**8本すべてが `true`、`missing` が空、`status` が `loaded`。**

- **5本しか並んでいなければ Build 285 以前を掴んでいる**（この派生検査は Build 286 の新規分）
- `decision-memory.js` が `false` なら、package には入っているのに評価に失敗している

PowerShell での確認：

```powershell
Select-String -Path "$env:USERPROFILE\Desktop\OMORAY-bridge-debug-*.log" -Pattern "RUNTIME_MODULE_STATUS"
```

## 4. ★本書 項目8について — private candidate では実行できない

> 8. 旧URLと現行URLが同じprivate candidateを指すことを確認する。

**この確認は private candidate では成立しない。** 実装を確認した結果：

```
desktop/main.js:12  LATEST_EXE_URL  = .../releases/download/desktop-latest/OMORAY-PITWALL-Setup-latest.exe
desktop/main.js:13  RELEASE_API_URL = .../releases/tags/desktop-latest
```

どちらも**公開 `desktop-latest` リリース**を指す。private artifact はそこに存在しない
（今回 `Publish to Release` を skipped にしているため）。
**この項目を満たそうとすると公開が必要になり、Gate 9 を先に踏むことになる。**
よって項目8は **Gate 9（公開）の確認事項**であり、Gate 6 では実行しない。

### 代わりに Gate 6 で確認すべきこと（更新ゲートの誤爆）

公開 latest は現在 **Build 284**（`2026-06-30` 公開・以後変化なし）。
更新ゲートは build **番号**ではなく **buildTag（日時）** を比較する。

```js
const localN  = parseInt(buildTag.replace('-', ''), 10);   // 286 は 202608252342
const remoteN = parseInt(latestTag.replace('-', ''), 10);
if (remoteN > localN) { /* Update available を出す */ }
```

したがって Build 286 を起動した時、

- **「Update available」バナーが出ないこと**が正しい挙動。
- **もし出たら不合格**。テスターを古い Build 284 へ引き戻す誤誘導になる。

## 5. 合否の記録先

本書 項目9 の ACK は `review/PITWALL_SHARED_WORKING_LOG.md` へ記録する。
Build番号・起動時刻・`RUNTIME_MODULE_STATUS` の実際の1行・各項目の可否。

不合格時は、症状・時刻・ログファイル名・対象SHA（`8851712…`）を同じ場所へ。

## 6. この文書で言えないこと

本書は **Gate 6 の手順**であり、Gate 6 の結果ではない。
**Windows 実機での起動は未確認、iRacing 実走も未実施、本番サーバーも未反映、公開もしていない。**
