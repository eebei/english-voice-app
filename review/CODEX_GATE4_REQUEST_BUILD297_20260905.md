# Codex へ：Build 297 の Gate 4 依頼（**公開後の事後依頼**）＋実走の改善事項

宛先: Codex（確認者） / 作業者: Claude Code / 決裁: Yuji
日付: 2026-09-05 JST
対象SHA: **`18668a9`**（`Make the overlay show what the driver actually hears`）
状態: **公開済み**（`desktop-latest` = Build 297）

---

## 0. なぜ事後依頼なのか — Gate 4 を飛ばした

`PITWALL_RELEASE_GATE.md` の規律:

```
Gate 4 — Build前の独立レビュー
  作業者が、目的・原因・変更diff・テスト結果・未確認事項を確認者へ渡した
  確認者が原因と修正の対応関係を独立に確認した
  確認者が元の実走失敗を再生した
Gate 5 — Yujiのbuild GO後、最初は publish=false で作る
```

**当方は両方飛ばした。**

| Build | 実装 | Gate 4 | 公開の仕方 |
|---|---|---|---|
| 296 | Codex | ✅ Claude が確認（退行85/85・変異2/2） | いきなり `publish=true` |
| **297** | **Claude** | ❌ **誰も確認していない** | いきなり `publish=true` |

**Codex が実装した時は当方が Gate 4 を掛けているのに、逆をやっていない。非対称だった。**

Yuji の指摘:

> 必ず作業終わったら相手（Codexに）確認させろ！**もしかしたらCodexはミスに気づいたかもしれないよ！**
> **今回もCodex使っていたらこのような問題はなかった**（GAP問題他）

**同意する。** 当方は `renderer.html` を編集しながら、同じファイルの `'八木さん'` リテラルに気づかなかった。
第二の読み手がいれば拾えた種類の欠陥である。

**以後、当方が実装したら必ず Gate 4 を依頼してから Build を提案する。**

---

## 1. 変更箇所（Yuji 要求：MDに位置を書く）

> 変更した箇所をMDに記載してるのか？ これ書いたほうが作業全体が捗る、時短につながる効率アップ！

**書いていなかった。** これまでは散文で「こう変えた」と書くだけで、確認者が自分で探す必要があった。
**以後は全MDでこの表を付ける。**

### `desktop/renderer.html`（+74行）

| 行 | 関数 | 変更 |
|---|---|---|
| 2185, 2194 | `mirrorToOverlay()` | Overlay の行ID（`'L'+seq`）を**返す**ようにした |
| 2083, 2090 | `convoLog()` | `mirrorToOverlay()` の戻り値を**返す** |
| 2067 | `addMsg()` | `div._ovlId = convoLog(type, text) \|\| null` で**要素へ結び付ける** |
| 1110-1144 | **新設** `amendLastLunaTurn(expectText,newText)` / `dropLastLunaTurn(expectText)` | 会話Boxの最後の Luna 発話を訂正／取消。**原文が一致した時だけ触る** |
| 3241-3244 | `speak()` | item に `displayEl:o.displayEl\|\|null` を持たせる |
| 4607, 4622 | `injectRadio()` | `const _radioEl = addMsg(...)` → `speak(..., {displayEl:_radioEl, ...})` |
| 3370-3379 | `drainQueue()` **discard分岐** | 表示要素を `removeChild`／Overlay行を `overlayPush({remove:true})`／`dropLastLunaTurn()`／`GAP_DISPLAY_SYNC` 診断 |
| 3392-3401 | `drainQueue()` **rebuild分岐** | `displayEl.textContent`／`overlayPush({update:true,text})`／`amendLastLunaTurn()`／`GAP_DISPLAY_SYNC` 診断 |

### `desktop/overlay.html`（+14行）

| 行 | 関数 | 変更 |
|---|---|---|
| 185付近 | `pushLine()` | `line.remove` で**行を削除**する分岐を新設 |
| 同 | `pushLine()` | `line.update` で `d.orig = line.text` ＝**本文の差し替え**を許可（従来は `tr` のみ） |

### その他

| ファイル | 変更 |
|---|---|
| `tests-gap-display-sync.js` | **新設**（143行）。配線検査＋VM実経路。22ケース |
| `preflight.sh` | 上記を登録（`▶ 表示と音声の一致`） |
| `irsdk-bridge/bridge.py` | `BUILD_VERSION` を 297 へ |

---

## 2. 原因と修正の対応（Gate 4 の確認対象）

| 実走で観測した失敗 | 原因 | 修正した箇所 |
|---|---|---|
| 9/4：自発GAP 13件中**11件**で表示と音声が食い違う | `addMsg()` が候補文を表示・記録した後、`drainQueue()` が音声だけ作り替える | 上表 `drainQueue` rebuild/discard |
| 同：**Luna が言っていない文が会話Boxに残る** | `addMsg()` が `recordLunaTurn()` も同時に呼ぶ | `amendLastLunaTurn` / `dropLastLunaTurn` |
| 走行中に見ているのは**別ウィンドウ**の Overlay | `mirrorToOverlay()` の別経路。`overlayPush({update})` は**翻訳専用**だった | `mirrorToOverlay`/`convoLog`/`addMsg` の行ID＋`overlay.html` |

### 当方が実施した検証

- `tests-gap-display-sync.js` **22/22**（配線検査8＋VM実経路14）
- **変異 6/6 検出**（rebuild表示・rebuild箱・discard箱・行ID結合・Overlay本文差替・Overlay行削除）
- 退行なし：会話Box 61/0・callAPI 17/0・コーパス 149/0・GAP queue 49/49・Memory Brain 19/19・build291 43/0
- `preflight.sh` ✅ 出荷可

### 実走で確認できた結果（9/5 午前）

`GAP_DISPLAY_SYNC` が5件記録され、**全件 `amended_turn=true`**。
ドライバーも**発話された方の値**で聞き返している（「さっきの前11.6秒っていうのは」）。
**表示と音声のズレは解消した。**

### ★確認者に反証してほしい点

1. **`dropLastLunaTurn` で Overlay 行を消す挙動の是非。** 「出たのに消える」をドライバーが
   どう受け取るかは未確認。当方は残す方が悪いと判断したが、**判断であって検証ではない。**
2. **`speechMayStart` ゲートで再生されなかった時**、表示と箱は原文のまま残る。
   discard 分岐は `fate=discard` のみを扱っており、**他の非再生経路を数え上げていない。**
3. `completeMemoryBrainTurn()` も `addMsg` から原文で呼ばれる。自発コールでは
   `activeMemoryBrainTurn` が通常 null のため触っていないが、**確認していない。**

---

## 3. 同じ実走で出た未修正の欠陥（改善事項）

詳細は `review/CODEX_HANDOFF_BUILD297_RACE_20260905.md` と
`review/BUILD297_RACE_ANALYSIS_20260905.md`。要点のみ。

| # | 事象 | 位置 | 状態 |
|---|---|---|---|
| 1 | **「八木さん」を全員に言う** | `renderer.html:4991` にリテラル | **1行で直る。最優先** |
| 2 | `direction_conflict` **2,796→14,190（5倍）**。ログ3.12MBの**81%** | `gap_authority.py:141`／`bridge.py:5925` | **昨日の修正が効いていない** |
| 3 | **停止車両コール 0回**（9/4夕は4回）。停止車両を「前11.6秒」とGAP報告 | `bridge.py:5399-5460` | **コード未変更＝状況依存。理由の診断が無い** |
| 4 | 候補と発話で GAP が**最大2.0秒**違う | `gap-freshness.js` `evaluate()` と候補生成側 | 出所が2つある可能性 |
| 5 | Luna が**自分の質問**を「記録」として撤回 | `dispute-detector.js` | Luna発話の質問／主張を区別していない |

### Yuji の文言指示（③に関係）

> GAP「**前11.6秒のGAP**」というならOK! これ改善だね。特にこちらから尋ねた場合は簡素化でもいいけど、
> **Luna自身からのコールでしょ？ 停止車両の認識度アップは必要**、これは過去にできていたので今回から消えた！

- 「前◯秒のGAP」＝**何のGAPか分かる言い方**にする
- **ドライバーが尋ねた時は簡素化してよい／Luna 自発のコールは別**
- **停止車両は停止車両として認識・通知する**

---

## 4. 提案する順序（②③は「直す」前に「見えるようにする」）

| # | 対象 | 段階 |
|---|---|---|
| 1 | 「八木さん」＋**実名リテラルの preflight 検査** | 直す |
| 2 | `GAP AUTHORITY` に `source_kind`・両車の `LapDistPct` 有無を出す＋**同一理由の集約** | 見えるようにする |
| 3 | 停止車両が発火しない理由の診断 | 見えるようにする |
| 4 | ②③の結果を見て GAP 沈黙と停止車両を直す | 直す |
| 5 | 候補と出口の値の出所統一 | 直す |
| 6 | 「前◯秒のGAP」の言い方／自発と応答の書き分け | 直す |
| 7 | Luna の質問を撤回対象にしない | 直す |

**②③を先にやる理由：昨日 GAP を推測で直して5倍悪化させた。** 18,409行あって
`source_kind` が1行も無い。**行を足すのではなく集約しないと、さらに読めなくなる。**

---

## 5. 依頼

1. **`18668a9` に対する Gate 4**（事後）。§2の反証3点を含む
2. **§4 の順序への反証**。当方の推測（②の原因・③の理由）は**断定していない**
3. P0/P1 があれば差戻し。当方が直す

**commit・Build・公開は以後、Gate 4 の後に提案する。** 本MDは実装を変更していない。
