# Build 282候補 — 独立確認結果（Claude Code）

確認者: Claude Code
確認時刻: 2026-08-24 JST
対象SHA: `d3f3eb5` ＋ 未コミット作業ツリー（11ファイル / +136 -9）
作業者: Codex
根拠: [PITWALL_RELEASE_GATE.md](PITWALL_RELEASE_GATE.md) / [PITWALL_SHARED_WORKING_LOG.md](PITWALL_SHARED_WORKING_LOG.md)

## 判定：**出荷不可（P1 2件・P2 2件）。署名欄は埋めない。**

package指定の修正そのものは**正しく、構造的に良い**。列挙をやめて `*.js` にしたのは、
「列挙はコードが育つと必ずズレる」という Build 277 で学んだ型の正しい適用。
`tests-nsis-installer.js` が renderer の `<script src>` から**派生させて**検査しているのも筋が良い。

しかし **Gate 3 が通ったという報告と実態が食い違っている**。以下は私が自分で実行した結果。

---

## P1-1: 本作業が既存テストを壊しており、preflight がそれを隠している

`tests-cost-gate.js` — **HEAD では合格、本作業ツリーでは失敗**（stash して両方実行し確認）。

```
❌ Windows配布物に cost-meter を同梱する
HEAD exit=0   ← 変更前は通っていた
```

原因は `tests-cost-gate.js:122`

```js
check('Windows配布物に cost-meter を同梱する',
  Array.isArray(pkg.build && pkg.build.files) && pkg.build.files.includes('cost-meter.js'));
```

`files` から `cost-meter.js` の**リテラル列挙を削除**して `*.js` にしたため、この検査が落ちる。

**実体としての同梱は `*.js` で満たされている。** よってこれは「packageが壊れた」ではなく
「**cost-meter の同梱を守っていた既存ガードが機能しなくなった**」という劣化。

### なぜ見逃されたか — こちらが本質

`preflight.sh` に **`tests-cost-gate.js` は入っていない**（grep 0件）。
そのため `./preflight.sh` は **✅ 出荷可** と表示する。私の手元でも表示された。

Gate 3 の「対象単体テストに合格した」「`./preflight.sh` が全項目合格した」を
**両方とも満たしたと報告できてしまう状態**で、実際には回帰が起きている。
これは Build 281 の欠陥（ソース合格を製品合格と取り違える）と**同じ構造**が、
テスト層で再発しているもの。

### 求める対応

1. `tests-cost-gate.js:122` を `tests-nsis-installer.js` と同じ**パターン対応の判定**に揃える。
2. `tests-cost-gate.js` を `preflight.sh` に入れる。**入っていないテストは出荷ゲートではない。**

---

## P1-2: 完成artifact検査が2moduleのハードコードで、Gate の必須反証を満たしていない

`.github/workflows/build-desktop.yml` 新設ステップ

```js
for (const f of ['local-intent-router.js','fuel-plan-guard.js']) { ... }
```

Gate の必須反証はこう書かれている。

> rendererが参照するローカルJSを追加したのにpackage manifestへ追加し忘れた場合は失敗する。

**この検査は、その2本以外については失敗しない。** renderer は現在5本を参照している。

### 実データによる裏付け

手元の `desktop/dist/win-unpacked/resources/app.asar`（2026-08-19 08:09 生成）の中身を列挙した。

```
/main.js
/memory-action-layer.js
/preload.js
/strategy-playbook.js
```

**5本中3本が欠落している。**

| renderer 参照 | 旧artifact |
|---|---|
| `local-intent-router.js` | ❌ 欠落（実走障害の原因） |
| `fuel-plan-guard.js` | ❌ 欠落 |
| **`cost-meter.js`** | ❌ **欠落** |
| `memory-action-layer.js` | ✅ |
| `strategy-playbook.js` | ✅ |

`cost-meter.js` は**旧 `files` に列挙されていたにもかかわらず artifact に無い**。
つまり manifest への記載と artifact への同梱は**別の事実**であり、Gate がそう分けているのは正しい。

そして **現在のCI検査は `cost-meter.js` の欠落を検出できない**。同じ事故がもう一度起きても素通りする。

### さらに悪いこと：テストがハードコードを固定している

`tests-nsis-installer.js` 新設

```js
check('CIが完成asar内の重要moduleを検査',
  workflow.includes("'local-intent-router.js','fuel-plan-guard.js'"));
```

CI検査を**renderer から派生させる形に改善すると、このテストが落ちる**。
修正を妨げるテストになっている。

### 求める対応

CI の検査対象を、`tests-nsis-installer.js` と同じく **renderer の `<script src>` から生成**する。
テストもその性質を見る形に変える（特定の2文字列の存在ではなく、
「renderer参照の全JSがasar検査対象になっていること」）。

---

## P2-1: `@electron/asar` が未宣言依存

`desktop/package.json` の `dependencies` は空、`devDependencies` は `electron` と `electron-builder` のみ。
`require('@electron/asar')` は **electron-builder 経由の推移的依存でしか解決していない**（手元で解決することは確認済み）。

electron-builder の更新で hoist 構造が変われば `MODULE_NOT_FOUND` になる。
その場合ステップは**失敗する＝fail-closed**なので危険側ではないが、原因が分かりにくい形で build が止まる。
`devDependencies` へ明示するのが安全。

---

## P2-2: 過去天候の禁止が「路面温度」に寄っている

`engineer-card.js` `buildHistoricalWeather()` は日本語固定文が

> 前回の**路面温度**は保存記録を確認できない。

`classify` 側は 雨・湿度・気温・天候 も `HISTORICAL_WEATHER` へ振り分ける。
「昨日は雨だった？」に対して**路面温度の話が返る**。
文言を対象非依存にするか、聞かれた項目名を差し込むべき。

---

## Gate 別の確認結果

### Gate 0 — 変更範囲 ✅

- HEAD `d3f3eb5`。変更11ファイルを `git status --porcelain` で列挙。
- 影響領域: Desktop（package/workflow/renderer/router）、server共有の `engineer-card.js`。**auth / payment / public page は不変。**
- 未追跡の利用者ファイル（`artifacts/` `desktop/dist/` `review/*.md` 等）は**変更にも commit にも混ざっていない**ことを確認。

### Gate 1 — 失敗の固定と受入条件 ✅（良い）

`tests-local-intent-router.js` に 8/24 実走の文言がそのまま入っている。

- `後ろとのギャップはどう？` → `後ろ5.8秒。`
- `パンで後ろとの差。`（STT揺れ）→ no-data へ落ちない
- `むしろ ギャップ どう？`（方向欠落）→ 前後両方
- 証拠欠落時 → `後ろのGAPはまだ取れていない。`（fail-closed）
- `昨日の路面温度は？` → 現在値を代用せず、`23.3` を含まないことまで検査

**肯定文・否定文・短い追質問・データなしが揃っている。** Gate 1 の要求を満たす。

### Gate 2 — 動線 △

`router_missing` / `no_telemetry` / `unhandled` の3値を分離した診断は正しい。
**ただし runtime 欠落を検出できるのは「発話が来た時」だけ**で、起動時に module の loaded / missing を記録していない。
Gate 6 は「起動ログに必要moduleのloaded / missing状態が記録され、全てloadedである」を要求している。**現状は未達。**

### Gate 3 — ソースと機械検証 ❌

| 項目 | 結果 |
|---|---|
| 構文・`git diff --check` | ✅ |
| Python 264 tests | ✅ |
| JS 全スイープ | ❌ **`tests-cost-gate.js` 失敗（P1-1）** |
| `./preflight.sh` | ✅ 出荷可 ← **失敗を含まないため当てにならない** |
| 有料実API呼出 | ✅ 0件 |

### Gate 4 — Build前独立レビュー ❌ P0/P1 が 0件でない

### Gate 5〜9 — **未実施**

private candidate artifact が存在しないため、以下はすべて未確認。
手元の asar は 8/19 生成の**旧物**であり、今回の候補ではない。

---

## 出荷署名欄（未完成）

```text
製品Build:            未確定（BUILD_VERSION 未更新）
対象Git SHA:          d3f3eb5 + 未コミット
変更領域:             Desktop / Bridge(同梱) / Server(engineer-card.js)

作業者:               Codex
対象テスト:           JS 全スイープ ＝ 1件失敗 / Python 264 passed
preflight:            合格表示（ただし失敗スイープを含まない）
外部有料API呼出:      0件

確認者:               Claude Code
独立確認時刻:         2026-08-24 JST
P0/P1:                **P1 2件**（cost-gate回帰＋preflight不備 / asar検査のハードコード）
Private artifact:     未作成
Artifact bytes/SHA:   未取得
app.asar module検査:  **旧artifactで5本中3本欠落を確認。新candidate未検査**
Windows candidate:    未実施
iRacing candidate:    未実施
Server SHA:           未確認（engineer-card.js 変更あり → deploy後 verify-deploy.sh 必須）

最終判定:             **出荷不可**
```

---

## 補足：私が実行したコマンド（追試用）

```bash
git stash -q -u && node tests-cost-gate.js; echo $?; git stash pop -q
node -e "const asar=require('@electron/asar');asar.listPackage('desktop/dist/win-unpacked/resources/app.asar').filter(x=>x.endsWith('.js'))"
grep -c 'tests-cost-gate.js' preflight.sh
./preflight.sh
python3 -m unittest discover -s irsdk-bridge -p 'tests_*.py'
```

commit / push / build / deploy / 公開はしていない。


---

# 再確認（2026-08-24 / Codex修正後 / Claude Code）

## 判定：**P1 2件・P2 2件はすべて解消。残 P2 1件（新規）。**

前回指摘の4件は、いずれも**症状を消すのではなく構造で直されている**。緑になっただけでないことを、
変異試験7件で個別に確認した。

### 前回指摘の対応状況

| # | 指摘 | 対応 | 私の確認 |
|---|---|---|---|
| P1-1 | `tests-cost-gate.js` 回帰＋preflight未収録 | `packaged()` によるパターン対応判定へ変更。`preflight.sh:54` へ追加 | ✅ JS全緑・preflightに収録を確認 |
| P1-2 | asar検査が2moduleハードコード | `desktop/scripts/verify-packaged-runtime.js` を新設し、**rendererの`<script src>`から派生**。CIは`node scripts/verify-packaged-runtime.js`を呼ぶだけ | ✅ 下記の実artifact検証 |
| P2-1 | `@electron/asar` 未宣言 | `devDependencies` へ `^3.4.1` を明示 | ✅ |
| P2-2 | 過去天候の文言が路面温度に偏る | 「前回の**天候記録**は確認できない」へ対象非依存化 | ✅ |
| Gate 2 | 起動時のmodule loaded/missing未記録 | `RUNTIME_MODULE_STATUS` を新設し5module全件を記録 | ✅ Gate 6の要求を満たす |

### 新しい検査が本物の欠陥を捕まえることの実証

手元の旧 `app.asar`（8/19生成・実走障害を起こした版）に対して新スクリプトを実行した。

```
Error: missing packaged runtime modules: fuel-plan-guard.js, cost-meter.js, local-intent-router.js
```

**実際に起きた事故を、そのまま検出する。** 2moduleのハードコードでは見えなかった `cost-meter.js` も含めて3本を挙げている。

また `tests-nsis-installer.js` が架空の `future-runtime.js` を使って
「**rendererに新しいscriptを足したのにpackageへ入れ忘れた**」場合を検査している。
これは Gate の必須反証そのもので、**前回のハードコード固定（改善するとテストが落ちる形）も解消**されている。

### 変異試験（私が独立実行）

| # | 変異 | 検出 |
|---|---|---|
| V1 | `package.json` から `*.js` を消す（同梱漏れ再発） | ✅ |
| V2 | CI検査ステップを削除 | ✅ |
| **V3** | **検証スクリプトの throw を無効化** | ❌ **未検出** |
| V4 | 起動時module診断を消す | ✅ |
| V5 | `router_missing` の区別を消す | ✅ |
| V6 | 過去天候を現在値で代用させる | ✅ |
| V7 | `@electron/asar` 宣言を外す | ✅ |

---

## P2-3（新規）: artifact ゲート本体の throw が未テスト

`desktop/scripts/verify-packaged-runtime.js`

```js
if (missing.length) throw new Error(`missing packaged runtime modules: ...`);
```

この行を `if (false)` に変えても **`tests-nsis-installer.js` は合格する**（V3）。
テストは純関数 `missingRuntimeScripts()` / `extractLocalScripts()` を呼んでいるが、
**`verifyPackagedRuntime()` 自体を一度も実行していない**。

つまり「欠落を**検出**できる」ことは検査されているが、「欠落時に**止める**」ことは検査されていない。
Build 281 の事故はまさに package が検査されずに出荷されたことなので、
この最後の一段こそ守る価値がある。

### 対応は容易

`verifyPackagedRuntime(options)` には既に `options.asar` / `options.asarPath` の注入口がある。
テスト可能に作られているのに使われていないだけ。実際に動くことは確認した。

```js
const fake = { listPackage: () => ['renderer.html','main.js'] };
// → throw: missing packaged runtime modules: ...   （欠落時に止まる）
const full = { listPackage: () => [/* 5本すべて */] };
// → 正常終了・localScripts 5本                      （揃えば通る）
```

両方向を1件ずつ足せば V3 は検出される。**Buildを止める必要はない**が、
次のBuildまでに入れておかないと、ゲート自身が静かに無効化されうる。

---

## 機械検証（私が独立実行）

| 項目 | 結果 |
|---|---|
| JS 全スイープ | ✅ **全緑**（前回失敗の `tests-cost-gate.js` を含む） |
| Python | ✅ **264 passed** |
| `./preflight.sh` | ✅ 出荷可（**`tests-cost-gate.js` を収録した上で**） |
| `git diff --check` | ✅ |
| 外部有料API呼出 | ✅ 0件 |
| 旧artifactに対する新検査 | ✅ 3本欠落を検出して失敗 |
| 変異試験 | 7件中 **6件検出**（V3のみ未検出＝P2-3） |

---

## 署名欄（Gate 4 まで。Gate 5以降は未実施）

```text
製品Build:            未確定（`BUILD_VERSION` 未更新）
対象Git SHA:          d3f3eb5 + 未コミット（13ファイル）
変更領域:             Desktop / Bridge(同梱) / Server(engineer-card.js)

作業者:               Codex
対象テスト:           JS 全緑 / Python 264 passed
preflight:            ✅ 出荷可
外部有料API呼出:      0件

確認者:               Claude Code
独立確認時刻:         2026-08-24 JST
P0/P1:                **0件**
P2:                   1件（P2-3・artifactゲートの throw が未テスト）
Private artifact:     **未作成**
Artifact bytes/SHA:   未取得
app.asar module検査:  **新candidate未作成のため未実施**（旧artifactでの検出能力は実証済み）
Windows candidate:    未実施
iRacing candidate:    未実施
Server SHA:           未確認（`engineer-card.js` 変更あり → deploy後 `./verify-deploy.sh` 必須）

最終判定:             **Gate 4 まで合格。Gate 5以降が未実施のため「出荷可」ではない。**
```

**Gate 4（Build前独立レビュー）は通過。** P0/P1 は 0件で、残る P2-3 は Yuji へ明示した。
Build GO を出せる状態だが、**公開可否は private candidate の Gate 5〜9 を経てから**判断されるべきで、
現時点で「出荷可」の署名はしない。

`BUILD_VERSION` が未更新なので、build GO の前に製品Build番号を上げる必要がある。
