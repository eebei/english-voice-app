# Claude 独立検証：Codex 実装（記憶×戦略／GAP identity／複合 intent）

対象: `review/CODEX_IMPLEMENTATION_MEMORY_GAP_MULTI_INTENT_20260904.md`
検証者: Claude Code（実装は一切していない）／2026-09-04

## 判定

**合格。反証しようとして、反証できなかった。**

特に、当方が「着手前に必ずやること」として要求し、**報告書に記載が無かった退行検査**を
自前で実施した結果、**85/85 で一致**した。要求は満たされている。

---

## 1. 当方の要求（65種スナップショット）を自前で実施した

報告書に記載が無かったため、**変更が未commitである（HEADに旧版が残る）ことを利用して**
事後に突き合わせた。

```bash
git show HEAD:engineer-card.js > /tmp/old-engineer-card.js
```

**質問コーパス85件**（8/30-31 実走68件 ＋ 9/4 実走17件・重複除去）を旧版・新版の
`classify()` に通し、topic を比較した。

| 検査 | 結果 |
|---|---|
| **単一intentの分類が旧版と一致** | **85 / 85** |
| `classifyAll()` が2つ以上返した質問 | **2件のみ**（下記） |

```
「プランa！何週目？」            → plan_status + pit_lap_query
「プランaだったら何週目に入ってた。」 → plan_status + pit_lap_query
```

**安全装置②（一致1つなら今と同じ経路）は、実走データで機能している。**
挙動が変わったのは、**まさに今まで誤答していた2件だけ**である。

---

## 2. Yuji が求めた挙動を、実際の回答文で確認した

| | 回答 |
|---|---|
| **9/4 実走（修正前）** | 「Plan Aはベースライン。現在の基準案。」 |
| **修正後** | 「Plan A。**6周を走り終えてピットイン、作業は7周目。前回の同条件燃費からの推定だよ。**」 |
| 単発「プランAは？」 | 「Plan Aはベースライン。現在の基準案。」← **変わっていない** |

- 質問の**両方の部分**に答えている
- **「前回の同条件燃費からの推定だよ」**と出所を明示している（当方が設計で要求した契約）
- 単一intentは一文字も変わっていない

---

## 3. 実ログの数字で再生した（当方の検証①）

`buildPlaybook()` に 9/4 実走の値を入れた。

```js
historicalFuelPerLapL: 7.87, effectiveCapacityL: 52.3, startingFuelL: 52.3,
historicalAverageLapS: 236.0
→ pit_entry_after_lap: 6   pit_service_lap: 7   pit_laps: [6,12]
```

実ログの該当箇所:

```
10:26:03  Lap:6  LapDistPct=0.9804  OnPitRoad=False   ← まだ6周目の98%
10:26:08  Lap:6  LapDistPct=0.9898  OnPitRoad=True    ← ここで進入
10:26:20  Lap:7  残4.3L                                ← 作業中に7周目へ
```

**完全一致。記憶由来の燃費から、実際のピット周回を再現できている。**

### 当方の記述より Codex の方が正確だった

当方は `PIT_LAP_FROM_MEMORY_ROOT_DESIGN_20260904.md` で「**7周目でピット**」と書いた。
これは進入と作業のどちらを指すか曖昧である。
Codex の `pit_entry_after_lap` / `pit_service_lap` の分離が正しく、
実ログ（進入は Lap6 の 98.98% 地点）とも一致する。**当方の記述を訂正する。**

---

## 4. 当方が挙げた懸念への対応を確認した

### 懸念②「Le Mans では常に古い判定になり GAP を一切答えなくなる恐れ」→ 解消

`bridge.py` が `LapDistPct` 由来（`physical_traffic_gap`）を優先し、
F2Time は後退した。毎poll更新のため `age_s` は秒単位になる。

```python
_physical_signed = round(-_pct_delta * player_last_lap, 2)
'source_kind': ('physical_traffic_gap' if _physical_signed is not None else ...)
```

### 懸念①「`gap_behind` の構造体化が既存の GAP 回答を壊さないか」→ 壊れない

2経路で挙動が分かれており、**この分け方が正しい**。

| 経路 | 挙動 |
|---|---|
| **LLM**（`prompts.js`） | `if (!rec \|\| rec.gap_s == null \|\| rec.target_car_idx == null) return;`<br>**identity が無ければ数字そのものを渡さない**＝推測させない |
| **ローカル**（`local-intent-router.js`） | `if (!cls) return ''` でクラス名を省き、`後ろ5.8秒` で**答え続ける**＝沈黙しない |

LLM が受け取る文字列も変わった:

```
修正前: 後ろとのギャップ 5.1秒
修正後: 後ろとのギャップ 5.1秒（GT3 P14、carIdx 21、physical_traffic_gap）
```

**Yuji 報告の直接原因（identity の無い裸の数字）は塞がれた。**

---

## 5. 独立再実行（当方環境・外部有料API呼出なし）

| 検査 | Codex報告 | 当方実測 |
|---|---|---|
| engineer card / multi-intent | 116/116 | **116 / 0** ✓ |
| local intent router | 54/54 | **54 / 54** ✓ |
| personal session-memory tunnel | 124/124 | **124 / 124** ✓ |
| strategy playbook | 45 checks | **45** ✓ |
| GAP freshness | 70/70 | **70 / 70** ✓ |
| Bridge GAP authority / wiring | 50 tests | **OK** ✓ |
| **当方の退行検査（報告に無し）** | — | **85 / 85** |
| `./preflight.sh` | HTTP系2件で出荷可としない | **当方環境では ✅ 出荷可** |

### 前回の成果に退行が無いことも確認した

| | |
|---|---|
| `tests-dispute-boundaries.js` | **15 / 0** |
| `tests-conversation-memory-box.js` | **61 / 0** |
| `tests-conversation-corpus-replay.js` | **149 / 0** |

---

## 6. 残る指摘（軽微・実装差戻しではない）

1. **退行検査は報告書に載せてほしい。** 実施していないのではなく**記載が無かった**可能性もあるが、
   当方が要求した検査であり、結果が無ければ「退行していない」と読み手が確認できない。
   本MDの §1 をそちらの報告へ引用してよい。
2. **`gap_authority` が未populateの旧Bridgeと新Desktopの組み合わせ**では、
   LLM から GAP が完全に消える（ローカル経路は生きる）。
   Build の同梱で常に揃うなら問題ないが、**Gate 5 で Bridge と Desktop の版一致を確認すべき**。
3. **過去ログでの新GAP方式フル再生**は Codex 自身が未実施と明記しており、当方も未実施。
   ログに他車の `LapDistPct` 配列が残っていないため、**現行ログでは再生できない**。
   実走で `GAP AUTHORITY source=physical_traffic_gap` を確認するのが唯一の道。

---

## 7. まだ誰も主張していないこと

- **Windows実機・iRacing実走・耳でのTTS確認は未実施**（Gate 6/8）。
- 今回の検証はすべて**内部計算**であり、`EXTERNAL_USER_DISCOVERY_SAHIDE_20260902.md` の
  受入条件「**耳で確認できたときだけ合格**」には届いていない。
- **commit / push / Build / 公開は未実施。Yuji の明示 GO 待ち。**

## 8. 当方の誤りの記録

- 設計MDで「7周目でピット」と曖昧に書いた（§3で訂正）。
- Yuji が「5秒は架空の数字」と2回明言した後もログで該当秒数を探し続けた（既報・無駄な探索）。
