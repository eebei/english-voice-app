# Build 288 — Gate 6 Windows handoff

次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`

**`BUILD286_GATE6_WINDOWS_HANDOFF.md` を置き換える。**
あちらは Build 286 向け（module 8本・旧SHA）で、そのまま使うと**古い期待値で合否を出す**。

## 前提

- 対象は **Build 288 private artifact** のみ。
- Build 286 / 287、公開 latest、ローカルソースはテスト対象にしない。
- **Gate 5 は Claude Code の確認者署名済み**（2026-08-27・作業者 Codex／確認者 Claude）。

---

## 1. 取得する installer

```
https://github.com/eebei/english-voice-app/actions/runs/33074707192
→ Artifacts → OMORAY-PITWALL-Desktop-Build-288-20260827-1302
```

zip 内の3本はすべて同一内容（同一ハッシュを実測確認済み）。どれを使ってもよい。

| 項目 | 値 |
|---|---|
| ファイル | `OMORAY-PITWALL-Setup-20260827-1302.exe` |
| サイズ | 100,682,608 bytes |
| SHA-256 | `B6BE060B3C056C0455E85EEBC07AC19AE219A5338480D7D8A61D834D31961DC4` |
| 対象SHA | `2ba8ce4a72c4034e6b4c6af20eb41ce0fc007a12` |

Windows 側でのハッシュ確認：

```powershell
Get-FileHash .\OMORAY-PITWALL-Setup-20260827-1302.exe -Algorithm SHA256
```

**一致しなければインストールしない。** 別物を掴んでいる。

**SmartScreen が出る**（コード署名していないため）。「詳細情報」→「実行」。

---

## 2. Build 番号をどこで見るか

| 場所 | 期待値 |
|---|---|
| タイトルバー | `Build 288` を含む |
| Bridge ログ 1行目 | `=== OMORAY PITWALL Bridge session start (BUILD Build 288 (fuel timing authority and confirmed driving-style coaching v1)) ===` |
| 対象Build | 288 |

---

## 3. ★module 診断（今回の要点・期待値が **10本** に増えた）

診断ログは**デスクトップ**に出る。

```
%USERPROFILE%\Desktop\OMORAY-bridge-debug-<日時>.log
```

```powershell
Select-String -Path "$env:USERPROFILE\Desktop\OMORAY-bridge-debug-*.log" -Pattern "RUNTIME_MODULE_STATUS"
```

期待する形（**10本すべて `true`・`missing:[]`・`status:"loaded"`**）：

```
cost-meter.js          decision-memory.js     driving-style-v1.js  ← Build 288 で新設
fuel-plan-guard.js     gap-freshness.js       local-intent-router.js
luna-self-memory.js    memory-action-layer.js session-memory.js
strategy-playbook.js
```

| 症状 | 意味 |
|---|---|
| **9本しか並ばない** | Build 287 以前を掴んでいる（`driving-style-v1.js` は 288 の新設） |
| **8本しか並ばない** | Build 286 以前 |
| `driving-style-v1.js` が `false` | package には入っているのに評価に失敗している |

---

## 4. 更新バナーが出ないこと

公開 latest の最新 versioned asset は **`20260826-1250`**、Build 288 は `20260827-1302`。
更新ゲートは日時タグを比較する（`desktop/main.js:475-477`）ので `remoteN > localN` は false。

- **「Update available」バナーが出ないこと**が正しい挙動
- **出たら不合格**。テスターを古い公開版へ引き戻す誤誘導になる
- Bridge ログに `update available:` 行が出ないことでも確認できる

（`旧URLと現行URLが同じcandidateを指す`確認は **Gate 9（公開）の項目**。private artifact は公開 Release に存在しないため Gate 6 では実行しない。）

---

## 5. 確認項目

| # | 確認 | 合格条件 |
|---|---|---|
| 1 | クリーンインストール | 成功する |
| 2 | 公開中の旧exe（Build 287）から上書き | 成功する |
| 3 | Build 表示 | タイトルバー / Bridgeログ / 対象Build がすべて **288** |
| 4 | Bridge 起動 | 同梱 Bridge が開始し、**二重起動しない** |
| 5 | iRacing 状態表示 | 未起動 / 検出済み / live telemetry が正しく切り替わる |
| 6 | **module 診断** | **10本すべて `true`・`missing:[]`・`status:"loaded"`** |
| 7 | PTT / マイク / TTS / overlay / Settings保存 / 診断ログ | 動作する |
| 8 | 更新バナー | **出ないこと**（§4） |

### 今回の新機能を触るなら（Gate 8 の予行）

- 「走りを分析して」→ 助言が**1件だけ**返り、参照が無ければ**数字を含まない**こと
- 燃料質問で、完走に給油が必要でも**まだ入れる時は「今周ピット」と言わない**こと
- 確認が複数保留の時に「はい」だけ返すと、**どれへの返事か聞き返す**こと

---

## 6. 不合格時

Build番号不一致、module欠落（10本未満）、Bridge二重起動、更新バナー表示、ACK欠落のいずれかがあれば **Gate 6 不合格**。
実走へ進めず、症状・時刻・ログファイル名・対象SHA（`2ba8ce4…`）を
`review/PITWALL_SHARED_WORKING_LOG.md` へ記録する。

## 7. ACK の記録先

`review/PITWALL_SHARED_WORKING_LOG.md` へ。
Build番号・起動時刻・`RUNTIME_MODULE_STATUS` の実際の1行・各項目の可否。

---

## 8. この文書で言えないこと

本書は **Gate 6 の手順**であり、Gate 6 の結果ではない。
**Windows 実機での起動は未確認、iRacing 実走も未実施、公開もしていない。**
Gate 7 は server 系に差分ゼロを実測したため **N/A**。
