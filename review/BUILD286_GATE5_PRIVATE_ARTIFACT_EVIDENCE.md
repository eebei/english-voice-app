# Build 286 — Gate 5 private artifact 実物検査 証拠

作成: 2026-08-26 JST  
作業者: Claude Code  
独立確認者: Codex（未実施）

**Build 285 を supersede する。** 理由は §0。

---

## 0. なぜ Build 285 では駄目だったのか

Gate 6 の実機作業に入る前に、**Gate 6 のチェック項目そのものを検証したところ欠陥が出た。**

`PITWALL_RELEASE_GATE.md` Gate 6:

> 起動ログに必要moduleのloaded / missing状態が記録され、全てloadedである。

`desktop/renderer.html` の `reportRuntimeModuleStatus()` は **5本のハードコード**だった。

```
検査していた   : memory-action-layer / strategy-playbook / fuel-plan-guard
                 cost-meter / local-intent-router
見ていなかった : session-memory / decision-memory / gap-freshness  ← 今回の新機能そのもの
```

**`decision-memory.js` が読み込めなくても `status:'loaded'` と報告する**状態であり、
Gate 6 が偽の合格を出す。Build 281（package 漏れ）、Build 282 P1-2（CI 検査の2本ハードコード）と同型。

### asar 検査があるのに、なぜこれが要るのか

両者は**別の失敗を捕まえる**。

| 検査 | 捕まえるもの |
|---|---|
| asar 展開（Gate 5） | ファイルが **package に入っていない** |
| 起動時 module 診断（Gate 6） | ファイルは入ったが **評価に失敗して global が生えない** |

後者はまさに最新コードで起きうるもので、そこが素通りだった。

### 修正

自分の `<script src>` から検査対象を派生させる。9本目を足しても自動で対象になる。

本番関数を `renderer.html` から抽出して実行し、**8本を1本ずつ欠けさせて `missing` に出ること**を
実挙動で確認した（`tests-runtime-module-status.js` 10/10・`preflight.sh` 収録）。
変異試験2件（新moduleを対象から外す／ハードコード列挙へ戻す）とも検出。

**この修正で `renderer.html` が変わったため、Build 285 の artifact は中身が古くなった。**
同一番号で中身違いは Build 282 で証拠を無効化した事故と同じ形なので、**286 へ上げて作り直した。**

---

## 1. 対象と生成

| 項目 | 値 |
|---|---|
| target_sha | `88517124f0868436b00d312d718c495d096411f1` |
| Build 番号 | **286**（`irsdk-bridge/bridge.py:58` = `Build 286 (decision memory, server ledger and derived runtime module diagnostics)`） |
| run id | [`32911905149`](https://github.com/eebei/english-voice-app/actions/runs/32911905149) |
| run 種別 | `workflow_dispatch`（`publish=false`） / success |
| run の headSha | `88517124f0868436b00d312d718c495d096411f1`（**target_sha と一致**） |
| artifact 名 | `OMORAY-PITWALL-Desktop-Build-286-20260825-2342` |
| artifact サイズ | 301,989,583 bytes |
| ref | `build/286` |

**`origin/main` は動かしていない。** `828ca13`（Build 284）のまま。

---

## 2. Publish がスキップされた証拠

| 確認 | 結果 |
|---|---|
| `Publish to Release` ステップ | **skipped** |
| 公開 Release `desktop-latest` | **2026-06-30T10:37:33Z / assets 242**（変化なし） |

**公開・latest URL 更新・利用者配布はいずれも行っていない。**

---

## 3. installer（実測値。すべて Claude Code が自分で計算した）

3本すべて**同一ハッシュ**（＝`latest` が古い版を指す事故なし）。

```
4d87c3e436cb8428727bbffbf11356eeb9f7609427ab40fd377ed2b6c0679f13  OMORAY-PITWALL-Desktop-latest.exe
4d87c3e436cb8428727bbffbf11356eeb9f7609427ab40fd377ed2b6c0679f13  OMORAY-PITWALL-Setup-20260825-2342.exe
4d87c3e436cb8428727bbffbf11356eeb9f7609427ab40fd377ed2b6c0679f13  OMORAY-PITWALL-Setup-latest.exe
ユニークなハッシュ数: 1
```

| ファイル | bytes | SHA-256 |
|---|---|---|
| `OMORAY-PITWALL-Setup-20260825-2342.exe` | 100,660,198 | `4d87c3e436cb8428727bbffbf11356eeb9f7609427ab40fd377ed2b6c0679f13` |

---

## 4. 同梱物（installer を実際に展開して取り出した実物）

NSIS 自己展開形式を `bsdtar` で展開（新規ツールは入れていない）。

| ファイル | bytes | SHA-256 |
|---|---|---|
| `app.asar` | 4,253,139 | `28c6026a0df25f9690c3e4fede6a17b00afaaf00b722dafe8f42386d756604f4` |
| `OMORAY-PITWALL-Bridge.exe` | 17,014,431 | `660eea44dcf7836e5738c033ce2e9562aef115830f7cd10e9bb7561e608757f5` |

### CI manifest との突合

`BUILD-286-GATE5-MANIFEST.json` は Windows runner の自己申告。**証拠に採らず独立に計算した。**

| 対象 | 判定 |
|---|---|
| installer | ✅ 一致（100,660,198 / `4d87c3e4…`） |
| app.asar | ✅ 一致（4,253,139 / `28c6026a…`） |
| Bridge | ✅ 一致（17,014,431 / `660eea44…`） |

---

## 5. app.asar 内の runtime module

```
cost-meter.js  decision-memory.js  fuel-plan-guard.js  gap-freshness.js
local-intent-router.js  main.js  memory-action-layer.js  preload.js
session-memory.js  strategy-playbook.js
```

`build-info.json`:

```json
{"buildDate": "2026-08-25T23:42:36.8244442+00:00", "buildTag": "20260825-2342", "buildNum": 286}
```

### 欠落検査（renderer の `<script src>` から派生。ハードコードしない）

```
✅ memory-action-layer.js  ✅ strategy-playbook.js  ✅ fuel-plan-guard.js
✅ cost-meter.js  ✅ local-intent-router.js  ✅ session-memory.js
✅ decision-memory.js  ✅ gap-freshness.js
✅ 欠落なし (8/8)
```

### 中身が target_sha と同一であること

Windows runner のチェックアウトは CRLF になる（Build 285 で原因特定済み）。
改行を正規化して比較し、**9ファイルすべてバイト単位で一致**。

```
✅ decision-memory.js  ✅ session-memory.js  ✅ gap-freshness.js
✅ local-intent-router.js  ✅ cost-meter.js  ✅ fuel-plan-guard.js
✅ memory-action-layer.js  ✅ strategy-playbook.js  ✅ renderer.html
```

### §0 の修正が実物に入っていること

| 確認 | 結果 |
|---|---|
| `runtimeModuleGlobalName` | ✅ 2箇所 |
| `querySelectorAll('script[src]')` による派生 | ✅ 1箇所 |
| 旧ハードコード列挙（`PitwallMemoryActionLayer,`） | ✅ **0箇所**（撤去済み） |

---

## 6. Bridge 実行体の中身

`strings` では出ない（PyInstaller が zlib 圧縮するため）。**推測せず 416 ストリームを展開して確認。**

| 探した文字列 | 結果 |
|---|---|
| `Build 286` | **✅ 実在** |
| `Build 285` | ✗ 無し |
| `active_decision_id` / `decision_plan` | **✅ 実在** |

### 2系統の取り違え検査（PTT が欠けた exe を掴まない）

| 依存 | 結果 |
|---|---|
| `pygame` | ✅ 52件（**Electron同梱用の正しい系統**） |
| `pyaudio` | ✅ 2件 |

---

## 7. target_sha での再実行

| 検査 | 結果 |
|---|---|
| `tests-runtime-module-status.js` | **10/10**（新設） |
| `tests-decision-memory-tunnel.js` | 74/74 |
| `tests-decision-memory-server.js` | 54/54 |
| `tests-session-memory-tunnel.js` | 118/118 |
| `tests-gap-answer-queue.js` | 44/44 |
| `tests-deploy-verification.js` | 28/28 |
| JS 全スイープ | ✅ 全緑 |
| Python | ✅ 305 passed |
| `./preflight.sh` | ✅ 出荷可 |
| 外部有料API呼出 | **0件** |

---

## 8. Gate の状態

| Gate | 状態 |
|---|---|
| 0 変更範囲 | ✅ |
| 2 package 対象 | ✅ 8/8 実物同梱 |
| 3 機械検証 | ✅ §7 |
| 4 P0/P1 | ✅ 0件（Build 285 時点で Codex 独立確認。以降の差分は §0 の1件のみ） |
| **5 artifact** | ✅ **実物検査完了（本書）**／**Codex 独立確認 待ち** |
| 6 Windows 取得・ACK | ⏸ 未実施 |
| 7 server 反映 | ⏸ 未実施 |
| 8 iRacing 実走 | ⏸ 未実施 |
| 9 公開 | 未実施 |

### ★署名を埋めていない理由

`PITWALL_RELEASE_GATE.md`「同じAIが作業と確認を兼任した場合は**独立確認済みとしない**」。
本書は**作業者の自己検査**である。**Codex の独立確認が必要。**

### 再現手順（ワンコマンド）

本書の検査は `verify-artifact.sh` に道具化してある。手で打ち直さなくてよい。

```bash
./verify-artifact.sh 32911905149 88517124f0868436b00d312d718c495d096411f1 286
```

- 途中まで落ちている zip があれば `--dir <作業ディレクトリ>` で渡すと**続きから取得する**
  （302MB は GitHub 側で普通に停滞する。やり直しにすると終わらない）
- `--keep` で展開結果を残せる
- 合格なら exit 0、1つでも欠ければ exit 1

この道具が信用できるかは `tests-artifact-verification.js`（44件・`preflight.sh` 収録）が
「落ちるべき時に落ちる」性質を固定している。

### ★ブランチ HEAD と artifact の出所は別物

```
run 32911905149 の headSha : 88517124f0868436b00d312d718c495d096411f1  ← artifact の出所
origin/build/286 の HEAD   : （これより先行。証拠書と報告の doc commit が乗る）
```

**ブランチ HEAD から再ビルドしても対象SHAは一致しない。**
「ブランチ HEAD = artifact の出所」として扱うと Build 282 型の取り違えになる。

### Codex への逆引き依頼

1. installer / app.asar / Bridge を**自分で再計算**し、本書の値と一致するか
2. `app.asar` 内の JS を自分で列挙し、renderer 参照との差集合が空か
3. Bridge exe から `Build 286` を自分で取り出せるか（`Build 285` が無いこと）
4. run `32911905149` の headSha が `8851712…` であること（ブランチ HEAD ではない）
5. §0 の派生検査が **1本ずつ欠けさせた時に必ず missing を出す**か
6. 公開 Release が動いていないこと
7. 道具そのものを信用しないなら、`tests-artifact-verification.js` の変異耐性を反証する

---

## 9. Gate 6 の実施手順（Yuji の Windows 実機）

### installer の入手

```
https://github.com/eebei/english-voice-app/actions/runs/32911905149
→ Artifacts → OMORAY-PITWALL-Desktop-Build-286-20260825-2342
```

zip 内の `OMORAY-PITWALL-Setup-20260825-2342.exe` を使う。
SHA-256 が `4d87c3e436cb8428727bbffbf11356eeb9f7609427ab40fd377ed2b6c0679f13` であることを
PowerShell で確認できる。

```powershell
Get-FileHash .\OMORAY-PITWALL-Setup-20260825-2342.exe -Algorithm SHA256
```

**SmartScreen が出る**（コード署名していないため）。「詳細情報」→「実行」。

### 確認項目（`PITWALL_RELEASE_GATE.md` Gate 6）

| # | 確認 | 合格条件 |
|---|---|---|
| 1 | クリーンインストール | 成功する |
| 2 | 公開中の旧exeから上書き | 成功する |
| 3 | Build 表示の一致 | **タイトルバー / Bridgeログ / 対象Build がすべて 286** |
| 4 | Bridge 起動 | Desktop 起動で同梱 Bridge が開始し、**二重起動しない** |
| 5 | iRacing 状態表示 | 未起動 / 検出済み / live telemetry が正しく切り替わる |
| 6 | **module 診断** | 診断ログの `RUNTIME_MODULE_STATUS` が **`"status":"loaded"` かつ `missing:[]`**、かつ **modules に8本すべて**が並ぶ |
| 7 | PTT / マイク / TTS / overlay / Settings保存 / 診断ログ | 動作する |
| 8 | 更新通知 | 正しい installer へ到達できる（自動更新とは表現しない） |
| 9 | 旧互換URL と現行URL | 同じ candidate を指す |

**#6 が今回の新設分。** 診断ログに次の形が1行出る。

```
RUNTIME_MODULE_STATUS {"modules":{"memory-action-layer.js":true,...,"decision-memory.js":true,
                        "gap-freshness.js":true},"missing":[],"status":"loaded"}
```

**8本すべてが `true` で `missing:[]` であること。** 5本しか並んでいなければ古い版を掴んでいる。

---

## 10. これで言えないこと

- **Gate 6 未実施。** installer を実行していない。
- **Gate 7 未実施。** `auth.js` / `server.js` の変更は `build/286` にしかなく、本番に `/api/memory/decisions` は存在しない。
  deploy 後の `./verify-deploy.sh` は必須で、**SHA 一致だけでは合格にならない**
  （`strategy_decisions` のマイグレーション失敗を経路の応答で検出する）。
- **Gate 8 未実施。** Decision ID の4段が実走で同じ id へ揃うか、翌日の自発 Memory 発話が出るか、
  GAP が dashboard と一致するかは**実データでしか確認できない**。
- 本書は **artifact が target_sha の中身を含むことの証拠**であって、
  **実走で正しく動くことの証拠ではない。**
