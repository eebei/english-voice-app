# Claude 独立反証：Build 295 退行3件の修正

対象: `review/CODEX_RESPONSE_BUILD295_REGRESSION_20260904.md`
検証者: Claude Code（実装は一切していない）／2026-09-04

## 判定

**3件とも直っている。実走で沈黙した状況をそのまま入力して確認した。**

---

## ① GAP の沈黙 — 実走の失敗ケースで直接確認

実走で **2,023回** 沈黙した状況（`idx=40`・GTP P3 × 自車 GT3 P10・物理は後方）を
`build_record()` へそのまま入れた。

| 入力 | 結果 |
|---|---|
| `physical_traffic_gap` / GTP P3 × GT3 P10 / 物理 +5.5秒 | **speakable=True / behind / 5.5秒** |
| `same_class_battle_gap` / P11 × P10 / 0.21秒 | **speakable=True / behind / 0.21秒** |

**沈黙しない。** 修正前はどちらも `direction_conflict_rank_vs_physical` で捨てられていた。

### 修正が実走の経路を本当に覆っているかを確認した

当方の懸念は「実走で捨てられたのは `same_class_battle_gap` ではないか。
それなら `physical_traffic_gap` だけ直しても効かない」だった。**確認した結果、効いている。**

`bridge.py:5877-5882`:

```python
standings_by_pos[_spos] = {
    'signed_gap_s': (_physical_signed if _physical_signed is not None else _signed),
    'source_kind': ('physical_traffic_gap' if _physical_signed is not None
                    else 'same_class_battle_gap')}
```

**同クラス隣接順位の車でも、物理値が取れていれば `physical_traffic_gap` が付く。**
実走ログの沈黙はすべてこの経路であり、今回の除外が直接効く。

### 設計として1点、記録しておく（差戻しではない）

`source_kind` は現在「**どう測ったか**」で決まり、「**同クラスか跨ぎか**」では決まっていない。
結果として:

- 物理値が取れる時 … 順位による二重検証は**行われない**
- 物理値が取れない時 … F2Time へ落ち、`same_class_battle_gap` として**順位検証が効く**

**これは実は妥当である。** F2Time は S/F 跨ぎで符号が反転しうるので二重検証が要り、
物理位置は符号がそのまま意味を持つので不要。**必要な場所にだけ検証が残っている。**
ただし**名前が実態と食い違う**（同クラスのバトル相手に `physical_traffic_gap` が付く）ので、
将来の読み手が誤解しうる。改名または注記を勧める。

### 変異試験

```
from_rank = rank_direction(...)   ← クラス跨ぎ除外を旧挙動へ戻す
→ ✅ tests_gap_authority.py が赤くなる
```

---

## ② 記憶が発動しない — 直っている

### タイム制で計画が成立するか（当方の検査D）

```
buildPlaybook(timed 2700秒, 燃費7.87L/周, 平均ラップ236秒, 52.3L)
→ available:true  推定周回:13  進入:6周  作業:7周目
```

**実走で `historical_average_lap_unavailable` になっていた条件で、計画が立つ。**

### 不採用理由が見えるようになったか（当方の検査E）

```
空履歴        → {"available":false, "reason":"no_matching_record"}
一致あり      → {"available":true, "basis":"memory_previous", "fuel":7.87, "confidence":"estimate"}
平均ラップ    → {"available":true, "avgLap":236}
```

`strategyLapEvidence` が新設され、**燃料規則と独立に平均ラップを取れる**ようになった。
`memory_rejection_reason` / `lap_memory_rejection_reason` も診断へ入っている。

**当方が「原因未特定・憶測で直さない」と書いた点は、理由が見えるようになったことで解消した。**
ただし**実走で `strategyFuelEvidence` が落ちた本当の理由は、まだ分かっていない。**
次の実走ログで `memory_rejection_reason` を読めば確定する。**そこまでは断定しない。**

---

## ③ `null秒` — 直っている

```js
case 'stopped_ahead': return d.delta!==null && d.delta!==undefined && Number.isFinite(Number(d.delta))
  ? `前方に停止車両。${d.delta}秒。注意。`
  : `前方に停止車両。注意。`;
```

`stopped_behind` も同じ形。**変異（ガードを `true` に）で `tests-build291-real-failures.js` が赤くなる。**

---

## 独立再実行（当方環境・外部有料API呼出なし）

| 検査 | Codex報告 | 当方実測 |
|---|---|---|
| Bridge GAP authority / wiring | 51 tests OK | **OK** ✓ |
| Session memory tunnel | 126/126 | **126 / 126** ✓ |
| Strategy playbook | 45 checks | **45** ✓ |
| Engineer card / multi-intent | 116/116 | **116 / 0** ✓ |
| Local intent router | 54/54 | **54 / 54** ✓ |
| GAP freshness | 70/70 | **70 / 70** ✓ |
| **変異試験（当方追加）** | — | **2/2 検出**（クラス跨ぎ除外・nullガード） |
| `./preflight.sh` | — | 当方環境 **✅ 出荷可** |

---

## 残る指摘

1. **`source_kind` の命名**（上記①）— 実態と食い違う。差戻しではない。
2. **実走で記憶が落ちた理由は未確定。** 次のログで `memory_rejection_reason` を確認するまで
   「記憶不発は直った」と断定しない。**今言えるのは「理由が見えるようになった」までである。**
3. **`direction_conflict` が実走で0件になる証明はまだ無い**（Codex も明記）。
   ログに他車の LapDistPct 配列が無いため完全再生ができない。**Gate 8 でしか埋まらない。**

## まだ誰も主張していないこと

- Windows実機・iRacing実走・耳での確認は未実施。
- **公開中の Build 295 は退行を含んだまま。** この修正はまだ commit されていない。
- 今回の検証もすべて内部計算であり、`EXTERNAL_USER_DISCOVERY_SAHIDE_20260902.md` の
  受入条件「**耳で確認できたときだけ合格**」には届いていない。

## 当方の誤りの記録

- 初版の退行レポートで原因を「至近距離での符号揺れ」と書いた。**誤り。**
  捨てられた `est` は全件正で符号は揺れておらず、**クラス跨ぎの順位比較**が真因だった。
- そもそも `CLAUDE_VERIFICATION_OF_CODEX_IMPL_20260904.md` で「合格」と報告して公開に至らせ、
  **3件とも見逃した。** `gap_authority` を実ログに一度も回していなかった。
