# Build 289 — Gate 6 Windows handoff

次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`

**`BUILD288_GATE6_WINDOWS_HANDOFF.md` を置き換える。**
module は同じ10本だが **installer の SHA と run が違う**ため、そのまま使うと照合が通らない。

## 前提

- 対象は **Build 289 private artifact** のみ。
- Build 286 / 287 / 288、公開 latest、ローカルソースはテスト対象にしない。
- **Gate 5 は Claude Code の確認者署名済み**（2026-08-28・作業者 Codex／確認者 Claude・全17項目一致）。

---

## 1. 取得する installer

```
https://github.com/eebei/english-voice-app/actions/runs/33130906223
→ Artifacts → OMORAY-PITWALL-Desktop-Build-289-20260828-0049
```

zip 内の3本はすべて同一内容（同一ハッシュを実測確認済み）。どれを使ってもよい。

| 項目 | 値 |
|---|---|
| ファイル | `OMORAY-PITWALL-Setup-20260828-0049.exe` |
| サイズ | 100,680,483 bytes |
| SHA-256 | `03A5F08158819CBBB69594D031F9B6BFA81A6B6603BFEB5C235AD6939A525C7A` |
| 対象SHA | `5f9ef109fd10430bcee0764dd68633fb9e343c6c` |

```powershell
Get-FileHash .\OMORAY-PITWALL-Setup-20260828-0049.exe -Algorithm SHA256
```

**一致しなければインストールしない。** 別物を掴んでいる。

**SmartScreen が出る**（未署名のため）。「詳細情報」→「実行」。

---

## 2. Build 番号をどこで見るか

| 場所 | 期待値 |
|---|---|
| タイトルバー | `Build 289` を含む |
| Bridge ログ 1行目 | `=== OMORAY PITWALL Bridge session start (BUILD Build 289 (voice question resilience and STT diagnostics)) ===` |
| 対象Build | 289 |

---

## 3. module 診断（**10本**・Build 288 と同数なので番号で見分ける）

```
%USERPROFILE%\Desktop\OMORAY-bridge-debug-<日時>.log
```

```powershell
Select-String -Path "$env:USERPROFILE\Desktop\OMORAY-bridge-debug-*.log" -Pattern "RUNTIME_MODULE_STATUS"
```

**10本すべて `true`・`missing:[]`・`status:"loaded"`**：

```
cost-meter.js          decision-memory.js     driving-style-v1.js
fuel-plan-guard.js     gap-freshness.js       local-intent-router.js
luna-self-memory.js    memory-action-layer.js session-memory.js
strategy-playbook.js
```

| 症状 | 意味 |
|---|---|
| 9本しか並ばない | Build 287 以前 |
| 8本しか並ばない | Build 286 以前 |
| **10本だが Build 表示が 288** | **Build 288 を掴んでいる**（module 数では区別できない。§2 の番号で見る） |

---

## 4. 更新バナーが出ないこと

公開 latest の最新 versioned asset は **`20260826-1250`**、Build 289 は `20260828-0049`。

```
localN  = 202608280049   （Build 289）
remoteN = 202608261250   （公開 latest）
remoteN > localN は false
```

- **「Update available」バナーが出ないこと**が正しい挙動
- **出たら不合格**。公開中の Build 287 へ引き戻す誤誘導になる

---

## 5. 確認項目

| # | 確認 | 合格条件 |
|---|---|---|
| 1 | クリーンインストール | 成功する |
| 2 | 公開中の旧exe（Build 287）から上書き | 成功する |
| 3 | Build 表示 | タイトルバー / Bridgeログ / 対象Build がすべて **289** |
| 4 | Bridge 起動 | 同梱 Bridge が開始し、**二重起動しない** |
| 5 | iRacing 状態表示 | 未起動 / 検出済み / live telemetry が正しく切り替わる |
| 6 | **module 診断** | **10本すべて `true`・`missing:[]`・`status:"loaded"`** |
| 7 | PTT / マイク / TTS / overlay / Settings保存 / 診断ログ | 動作する |
| 8 | 更新バナー | **出ないこと**（§4） |

### Build 289 の新機能を触るなら（Gate 8 の予行）

実走ログ由来の修正なので、**PTT で声に出して**確認するのが要点。

| 言うこと | 期待 |
|---|---|
| 「ベストラップ いくつ？」 | `ベスト7分50秒356。`のように**その場で答える**（`了解。`にならない） |
| 「ルナ データいってる？」 | `データは来ている。…`（`了解。`にならない） |
| 「コースデータは空いてる？」 | 同上（STT 揺れを拾う） |
| 「コースは空いてる？」 | **data-status に寄らない**（別の話として扱う） |
| 診断ログ `PTT_STT_RESULT` | `chars` / `confidence` / `duration_s` / `language` のみ。**発話全文や音声は出ない** |

---

## 6. 不合格時

Build番号不一致、module欠落（10本未満）、Bridge二重起動、更新バナー表示、ACK欠落のいずれかがあれば **Gate 6 不合格**。
症状・時刻・ログファイル名・対象SHA（`5f9ef10…`）を `review/PITWALL_SHARED_WORKING_LOG.md` へ記録する。

## 7. ACK の記録先

`review/PITWALL_SHARED_WORKING_LOG.md`。
Build番号・起動時刻・`RUNTIME_MODULE_STATUS` の実際の1行・各項目の可否。

---

## 8. Gate 7（2026-08-28 合格済み）

Build 289 は **`server.js` に +19/-5 の変更を含む**（STT ヒント・`parseGoogleSttResponse`）。
**Build 288 の「Gate 7 N/A」は流用できない。**

deploy 後は `./verify-deploy.sh` が必須で、**SHA 一致だけでは合格にしない**
（経路の応答まで見る。401=正常 / 404=未反映 / 503=DB失敗 / 200=認証欠落）。

YujiのDeploy GO後、`main`の `a587940edd52af69cd09abbc75bafe909042b14f` をRailwayへ反映。
本番 `/api/version` のSHA一致と、未認証 `/api/memory/decisions` の **401** を
`./verify-deploy.sh`で実測したため、**Gate 7は合格**。起動直後の初回確認はDB初期化中の503だったが、
再確認で401へ復帰した。公開Releaseは変更していない。

## 9. 公開後の状態

本書は **Gate 6 の手順**であり、結果ではない。
2026-08-28のYuji公開GO後、Desktop公開版はBuild 289へ更新済み。通常のlatest URLから取得できる。
serverもGate 7合格済み。ただし、**Windows実機での起動とiRacing実走は未確認**。
