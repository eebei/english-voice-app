# Build 281 — Claude Code レビュー結果

レビュー: 2026-08-24 / Claude Code
対象: [BUILD281_GAP_FUEL_DEBRIEF_HAZARD_REVIEW_REQUEST.md](BUILD281_GAP_FUEL_DEBRIEF_HAZARD_REVIEW_REQUEST.md)
基点: HEAD `c5d7206` ＋ 未コミット作業ツリー（8ファイル / +154 -25）

## 判定：**差戻し（P1 2件・P2 2件）**

方向性は正しい。5つの実走欠陥に対する切り口はどれも妥当で、GAP経路の順序入れ替えとハザード優先度は問題を見つけられなかった。
ただし**燃料P0ガードに、実行不可能な補正でP0を握り潰す経路が残っている**。ここは実際に手を動かして再現した。

---

## P1-1: 満タンで頭打ちの時、小口給油補正が「効果ゼロ」なのにP0を抑止する

`irsdk-bridge/plan_fuel_authority.py:223`

`corrected_add = planned_add + |finish_margin|` を返すが、**補正後の給油量がタンクに入るかを検査していない**。
`target_onboard = min(effective_capacity_l, fuel_at_stop_l + planned_add)` は容量で頭打ちになるため、
既に容量を飽和している計画では、いくら `recommended_add_l` を増やしても搭載量は1滴も増えない。

`capacity_fits` は手前で検査済みだが、それは `planned_add <= capacity` を見ているだけで、
**`fuel_at_stop_l + corrected_add <= capacity` は誰も見ていない。**

### 再現（実行して確認した）

```
容量 50.0L / 給油前残 1.5L / 計画給油 49.0L → 搭載上限は満タン 50.0L
ピット後 20周 × 2.48L = 49.6L ＋ 予備 0.5L = 50.1L 必要

結果:
  allow_p0_pit_now      = False
  suppression_reason    = planned_service_small_top_up_required
  finish_margin         = -0.1
  recommended_add_l     = 49.1
  recommended_set_fuel_l= 50

推奨どおり 49.1L 入れた時の搭載量 = min(50.0, 1.5+49.1) = 50.0L
補正後の余裕 = -0.1L  ← 補正前と同一。**補正は物理的に無効。**
```

つまりこの経路は、**「決定論的な給油補正で直る」と宣言しながら、直らない補正を返してP0を消している**。
`bridge.py:4093` の書き戻しも同じ値を全plan owner に配るので、後のボックスコールとダッシュボードは
「入らない量」で揃うことになる。

RESERVE_L=0.5 が緩衝として効いているため即ガス欠にはならないが、不足が -0.5L に近づくほど
予備ゼロで終える。耐久では実害になる。

### 求める修正

小口補正の分岐に入る条件へ、**補正後の実搭載量が余裕を非負にできること**を加える。
できない場合（＝満タンでも届かない）は、給油では解決しないので P0 か、燃料セーブ要求へ回す。

---

## P1-2: `pit_events` が signature reset で消えない（デブリーフのピット周捏造が別経路で復活する）

`irsdk-bridge/bridge.py:2953` / `2764`

セッション境界のリセットは**2系統**ある。今回の変更は片方にしか入っていない。

| 変数 | `_reset`（2952-2953） | `_sig_reset`（2764付近） |
|---|---|---|
| `session_laps` | ✅ | ✅ |
| **`pit_events`** | ✅ `pit_events = []` | ❌ **無い** |

`_session_scoped_reset_values()` にも `pit_events` は入っていない（リテラル `[]` の直接代入のため）。

これは Build 281 が潰そうとしている欠陥そのものを別経路で再生産する。
前セッションのピット記録が生き残ったまま `session_summary` に載り、
`renderer.html:5985` の `buildCurrentSessionFactNote()` が
「**今回レースのBridge確定ピット記録**」「この記録だけを事実として使え」として LLM に注入する。
**捏造を止めるはずの仕組みが、古い事実を今回の事実として断言させる。**

他のセッションスコープ変数がすべて両系統で消えている中、`pit_events` だけが片系統。**規約からの逸脱。**

### 求める修正

`_session_scoped_reset_values()` に `pit_events` を入れて、両系統から同じ値を取る。
`session_laps` と同じ扱いにすれば非対称が構造的に消える。

---

## P2-1: 安全側の定数 `SMALL_SERVICE_CORRECTION_L` に上限テストが無い

閾値を **0.5 → 5.0（10倍）** に書き換えても、Python 261 テストが**全部通る**（実行して確認）。

```
❌ 閾値0.5→5.0(10倍緩和)を検出できない
Ran 261 tests — OK
```

5.0L の不足を「小口の給油補正」として P0 を消すのは、まさに reviewer check #2 が危惧している事態。
**この定数は本物の緊急を握り潰す唯一のレバー**なので、境界の両側を固定するテストが要る。

- `finish_margin = -0.5` ちょうど → 抑止される
- `finish_margin = -0.51` → **P0 が通る**（`planned_service_cannot_finish`）

---

## P2-2: `test_bridge_persists_small_top_up_into_the_later_box_plan` が文字列一致でしかない

`irsdk-bridge/tests_plan_fuel_authority.py`

```python
self.assertIn("_plan_fix['set_fuel_l'] = int(_recommended_set)", source)
```

ソースにその文字列があることしか見ていない。**書き戻しが実際に起きるかは検証していない。**
条件分岐が壊れても、行が残っていれば通る。

これは Build 277 で私が踏んだ失敗と同型（`exit 1` という文字列の存在だけを見ていて、
不一致で本当に失敗するかを見ていなかった）。同じ轍。

---

## reviewer check への回答

### 1. `evidenceDebrief` / 手動レビュー経路が race PTT を横取りしうるか → **問題なし**

`sendMsg()` で local GAP authority より前にあるのは
`^(?:ルール|rules?|help)[。.!！?？]?$` の完全一致のみ。GAP 質問は該当しない。
PTT の入口も `renderer.html:3382` / `6305` / `3125` すべて `sendMsg()` 経由で、迂回路は無い。
`isManualReviewCommand` は後ろへ移ったが、router は該当しない発話に `null` を返すので飲み込まれない。

### 2. 小口補正ルールが本物の燃料緊急を抑止しうるか → **する（P1-1）**

順序自体は正しい。`cannot_reach_selected_pit_window`（reach_margin<0）と
`planned_service_exceeds_capacity`（capacity_fits False）はどちらも**手前**にあり、両方 P0 を通す。
文書の主張どおり「到達可能かつ容量が収まる」時だけ緩和に入る。

**ただし「容量が収まる」の判定が `planned_add` に対してだけで、`fuel_at_stop + corrected_add` に対して行われていない。**
そこが P1-1。

### 3. `pit_events` はセッション境界で正しくリセットされ、summary まで運ばれるか → **片方だけ（P1-2）**

summary への搭載は 2921 / 3246 の両方に入っており正しい。**リセットが片系統。**

### 4. `danger` を P1 に上げるのは妥当か → **妥当。ただし前後分割を推奨**

`stopped_ahead` は P0 のまま（`bridge.py:499`）で、意図どおり。
`danger` が P3 のままだと P2 の PB コールにダッキングされる、という診断は正しい。

分割については **文書の懸念（#4後段）に同意**する。低SR車が**後方**にいることと**前方**にいることは危険度が違う。
今の一律 P1 は、後方の低SR車の告知が P2 の手順コール（`pit_entry` / `limiter_off`）を押しのけうる。
ピット進入手順が遅れる方が実害が大きい場面がある。

ただしこれは**今回の実走ログで実害が出た事象ではない**ので、Build 281 を止める理由にはしない。
前後分割は別Buildで、接近速度と復帰ライン距離の契約とセットで入れるのが筋。

### 5. テストがヘルパーの単体試験に留まっていないか → **半分**

| テスト | 実行するか | 評価 |
|---|---|---|
| `tests_plan_fuel_authority` 小口補正 | ✅ 実際に `evaluate()` を呼ぶ・8/24の実値 | 良い |
| `tests-telemetry-truth-gate` GAP | ✅ 実際に `telemetryTruthFallback()` を呼ぶ | 良い |
| `tests-local-intent-router` 順序 | △ `indexOf` の順序比較のみ | 順序の逆転は検出できる。許容 |
| `tests_plan_fuel_authority` 書き戻し | ❌ 文字列一致のみ | **P2-2** |

また GAP のテストは**後ろのみ**。`前後`（both）と、値が無い時の `〜はまだ取れていない。` が未検証。

---

## 追加で気づいた点（Buildは止めない）

**GAP再構築ロジックが2箇所に重複している。**

- `desktop/local-intent-router.js:139`
- `desktop/renderer.html:2253`（`telemetryTruthFallback` 内）

正規表現は同一だが `wantsBoth` の算出が違う。router 側は

```js
const wantsBoth = /前後|both/i.test(text) || (!/前|ahead/i.test(text) && /後ろ|後方|behind/i.test(text) && /前|ahead/i.test(text));
```

第2項が `!A && B && A` で**恒偽**。死んだ条件で、実挙動は renderer 側と同じになるため今は無害だが、
片方だけ直すと静かに食い違う。共通化するか、少なくとも死んだ項を削るのが安全。

---

## 検証（私が実行した内容）

- `tests-local-intent-router.js` ✅ / `tests-telemetry-truth-gate.js` ✅
- `python3 -m unittest discover -s irsdk-bridge -p 'tests_*.py'` → **261 passed**（文書の主張と一致）
- P1-1 は `plan_fuel_authority.evaluate()` を実データ形状で直接呼んで再現
- 変異試験2件：
  - `SMALL_SERVICE_CORRECTION_L` 0.5→5.0 → **検出されず**（P2-1）
  - `pit_events = []` を削除 → **検出されず**（P1-2 にテストが無いことの裏付け）

commit / push / installer build / 公開はしていない。
