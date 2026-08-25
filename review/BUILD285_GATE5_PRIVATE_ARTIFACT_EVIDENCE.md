# Build 285 — Gate 5 private artifact 実物検査 証拠

作成: 2026-08-26 JST  
作業者: Claude Code  
独立確認者: Codex（未実施）

指示: 共有ログ「2026-08-25 JST — Claude向けBuild 285 private artifact引き渡し指示」

---

## 1. 対象と生成

| 項目 | 値 |
|---|---|
| target_sha | `c6db9f4a1ae2cc22828408b456da3a2b1c9dd190` |
| Build 番号 | **285**（`irsdk-bridge/bridge.py:58` = `Build 285 (decision memory, server ledger and gap answer freshness)`） |
| workflow | `build-desktop.yml` |
| run id | `32858968763` |
| run 種別 | `workflow_dispatch`（`publish=false`） |
| run の headSha | `c6db9f4a1ae2cc22828408b456da3a2b1c9dd190`（**target_sha と一致**） |
| 生成日時 | 2026-08-25T14:21:23Z 開始 / installer 14:23 |
| artifact 名 | `OMORAY-PITWALL-Desktop-Build-285-20260825-1422` |
| artifact サイズ | 301,985,895 bytes |
| 取得元 | `https://github.com/eebei/english-voice-app/actions/runs/32858968763` |
| ref | `build/285` |

### push について（明記）

**`origin/main` は動かしていない。** `828ca13`（Build 284）のまま。

CI は GitHub 上の ref をチェックアウトするため、artifact 生成には push が必須だった。
`origin/main` への push は指示書で独断禁止のため、**Yuji の選択（ブランチ方式）に従い
`build/285` ブランチだけを push** した。ビルド後にブランチを削除すれば完全に戻せる。

```
origin/main  = 828ca13  (Build 284 / decision-memory.js は存在しない)
build/285    = c6db9f4  (Build 285 / 本artifactの出所)
```

---

## 2. Publish がスキップされた証拠

| 確認 | 結果 |
|---|---|
| `Publish to Release` ステップ | **skipped** |
| 公開 Release `desktop-latest` の最終公開 | **2026-06-30T10:37:33Z**（assets 242 のまま増えていない） |
| push トリガーで併走した run `32858953256` | `Publish to Release` → **skipped** |

workflow の条件は `if: github.event_name == 'workflow_dispatch' && inputs.publish` であり、
`publish=false` の dispatch と push トリガーの双方で公開ステップが動かないことを実測で確認した。

**公開 Release・latest URL・利用者配布はいずれも行っていない。**

---

## 3. installer（実測値。すべて Claude Code が自分で計算した）

artifact に含まれる installer は3本で、**すべて同一ハッシュ**
（＝`latest` が古い版を指す事故は無い）。

```
c55f7f7b12cc17c89929c2d26a494323d7eb16dcb3cc5c1b71716c984608e043  OMORAY-PITWALL-Desktop-latest.exe
c55f7f7b12cc17c89929c2d26a494323d7eb16dcb3cc5c1b71716c984608e043  OMORAY-PITWALL-Setup-20260825-1422.exe
c55f7f7b12cc17c89929c2d26a494323d7eb16dcb3cc5c1b71716c984608e043  OMORAY-PITWALL-Setup-latest.exe
ユニークなハッシュ数: 1
```

| ファイル | bytes | SHA-256 |
|---|---|---|
| `OMORAY-PITWALL-Setup-20260825-1422.exe` | 100,659,008 | `c55f7f7b12cc17c89929c2d26a494323d7eb16dcb3cc5c1b71716c984608e043` |

---

## 4. 同梱物（installer を実際に展開して取り出した実物）

installer は NSIS 自己展開形式。`bsdtar` で `resources/` を取り出した
（この機に 7z 等の新規ツールは入れていない）。

```
resources/app.asar
resources/OMORAY-PITWALL-Bridge.exe
resources/elevate.exe
```

| ファイル | bytes | SHA-256 |
|---|---|---|
| `app.asar` | 4,252,147 | `e550a9379ff7294681b90344e534ae8e1fe4f21b849a7baf075d4011570897f3` |
| `OMORAY-PITWALL-Bridge.exe` | 17,013,753 | `19cfd0c6c3272fb091c6b016ed0a4102c8908fca58b470b8b6fefe7e45a96535` |

### CI 側 manifest との突合

artifact 同梱の `BUILD-285-GATE5-MANIFEST.json` は CI（Windows runner）の自己申告である。
**その値を証拠として採用せず、こちらで独立に計算して突合した。**

| 対象 | manifest | 実測 | 判定 |
|---|---|---|---|
| installer | 100659008 / `C55F7F7B…` | 100659008 / `c55f7f7b…` | ✅ 一致 |
| app.asar | 4252147 / `E550A937…` | 4252147 / `e550a937…` | ✅ 一致 |
| Bridge | 17013753 / `19CFD0C6…` | 17013753 / `19cfd0c6…` | ✅ 一致 |

---

## 5. app.asar 内の runtime module（実物を展開して列挙）

```
/cost-meter.js          /decision-memory.js   ← スライス2で新設
/fuel-plan-guard.js     /gap-freshness.js
/local-intent-router.js /main.js
/memory-action-layer.js /preload.js
/session-memory.js      /strategy-playbook.js
```

`build-info.json`:

```json
{"buildDate": "2026-08-25T14:22:12.0591021+00:00", "buildTag": "20260825-1422", "buildNum": 285}
```

### 欠落検査（renderer の `<script src>` から派生。ファイル名をハードコードしない）

```
✅ memory-action-layer.js
✅ strategy-playbook.js
✅ fuel-plan-guard.js
✅ cost-meter.js
✅ local-intent-router.js
✅ session-memory.js
✅ decision-memory.js       ← Build 284 artifact には存在しなかったもの
✅ gap-freshness.js
✅ 欠落なし (8/8)
```

**missing packaged runtime modules: （空）**

### 中身が target_sha と同一であること

同梱された JS / renderer.html を HEAD のソースと突き合わせた。

初回比較は**全ファイル不一致**になったが、原因は Windows runner のチェックアウトによる
**改行コード（CRLF）**であることを実測で特定した
（`decision-memory.js`：asar 側 CR 421個 / HEAD 側 0個）。
改行を正規化して再比較した結果、**9ファイルすべてバイト単位で一致**。

```
✅ decision-memory.js   ✅ session-memory.js      ✅ gap-freshness.js
✅ local-intent-router.js ✅ cost-meter.js        ✅ fuel-plan-guard.js
✅ memory-action-layer.js ✅ strategy-playbook.js ✅ renderer.html
```

---

## 6. Bridge 実行体の中身

`strings` では `Build 285` が出ない。PyInstaller がバイトコードを zlib 圧縮するためで、
**「見つからない＝入っていない」ではない。** 推測で済ませず、埋め込まれた zlib ストリームを
実際に展開して確認した（416 ストリームを展開）。

| 探した文字列 | 結果 |
|---|---|
| `Build 285` | **✅ 実在** |
| `Build 284` | ✗ 無し |
| `active_decision_id` | **✅ 実在**（スライス2の結合キー） |
| `decision_plan` | **✅ 実在** |
| `strategy_plan_decision` | **✅ 実在** |

### 2系統の取り違え検査

`BRIDGE_EXE_BUILD_PROCEDURE_FOR_CODEX.md` の罠（Electron同梱用と Bridge単体用で依存が違い、
取り違えると PTT が欠けた exe になる）を検査した。

| 依存 | 結果 |
|---|---|
| `pygame` | ✅ 52件（**Electron同梱用の正しい系統**） |
| `pyaudio` | ✅ 2件 |
| `irsdk` | ✅ 1件 |

Bridge の SHA-256 は Build 284 の `2199c6aa23dff434…` から `19cfd0c6c3272fb0…` へ変わっており、
このチェックアウトから再ビルドされている。

---

## 7. target_sha での再実行（指示書 step5）

| 検査 | 結果 |
|---|---|
| `tests-decision-memory-tunnel.js` | **74/74** |
| `tests-decision-memory-server.js` | **54/54** |
| `tests-session-memory-tunnel.js` | **118/118** |
| `tests-gap-answer-queue.js` | **44/44** |
| `tests-deploy-verification.js` | **28/28** |
| `./preflight.sh` | ✅ 出荷可 |
| Python 全体 | ✅ **305 passed** |
| `git diff --check` | ✅ |
| 外部有料API呼出 | **0件** |

---

## 8. Gate の状態

| Gate | 状態 |
|---|---|
| 0 変更範囲 | ✅ 未追跡の利用者ファイルを混ぜていない |
| 2 package 対象 | ✅ renderer 参照8本すべて実物に同梱 |
| 3 機械検証 | ✅ 上記 §7 |
| 4 P0/P1 | ✅ 0件（2026-08-25 Codex 独立確認） |
| **5 artifact** | ✅ **実物検査完了（本書）。ただし下記の但し書き** |
| 6 Windows 取得・ACK | ⏸ **未実施** |
| 7 server 反映 | ⏸ **未実施**（`auth.js` / `server.js` 変更あり。`strategy_decisions` の DB マイグレーションを含む） |
| 8 iRacing 実走 | ⏸ **未実施** |
| 9 公開 | **未実施** |

### ★署名を埋めていない理由

`PITWALL_RELEASE_GATE.md` 絶対ルール：

> 同じAIが作業と確認を兼任した場合は**独立確認済みとしない**。

**スライス2/3/4 と G5 は Claude Code が実装した。** よって本書は**作業者による自己検査**であり、
ゲートが要求する独立確認ではない。**Codex の独立確認が必要。**

### Codex への逆引き依頼

1. artifact の installer / app.asar / Bridge を**自分で再計算**し、本書の値と一致するか
2. `app.asar` 内の JS を自分で列挙し、renderer 参照との差集合が空か
3. Bridge exe から `Build 285` / `active_decision_id` を自分で取り出せるか
4. `build/285` の `c6db9f4` が run `32858968763` の headSha と一致するか
5. 公開 Release が動いていないこと（`desktop-latest` の publishedAt）

---

## 9. これで言えないこと（重要）

- **Windows 実機での起動・更新は未確認**（Gate 6）。installer の実行は行っていない。
- **本番サーバーは未反映**（Gate 7）。`/api/memory/decisions` は本番に存在しない。
  deploy 後は `./verify-deploy.sh` が必須で、**SHA 一致だけでは合格にならない**
  （`strategy_decisions` のマイグレーション失敗を検出するため経路の応答も見る）。
- **iRacing 実走は未実施**（Gate 8）。Decision ID の4段が実走で同じ id へ揃うか、
  GAP の数値が実測と一致するか、翌日の自発 Memory 発話が出るかは**実データでしか確認できない**。
- 本書は **artifact が target_sha の中身を含むことの証拠**であって、
  **実走で正しく動くことの証拠ではない**。
