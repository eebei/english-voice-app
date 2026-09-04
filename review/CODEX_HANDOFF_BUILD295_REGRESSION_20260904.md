# Codex へ：Build 295 実走退行3件（2026-09-04 夕・Le Mans / IMSA）

宛先: Codex / 報告: Claude Code / 決裁: Yuji
ログ: `OMORAY-bridge-debug-20260904-1606.log`（1.73MB・**公開中の Build 295**）
詳細: `review/BUILD295_REGRESSION_REPORT_20260904.md`

Yuji 報告:

> **GAP全くダメだね、悪くなってるし！ 記憶発動もない！**

**3件とも再現。うち2件は今日の変更による退行。公開中の製品で今起きている。**

---

## 先に当方の責任

**当方は `CLAUDE_VERIFICATION_OF_CODEX_IMPL_20260904.md` で「合格。反証しようとして反証できなかった」
と報告した。3件とも見つけられなかった。**

そちらが「過去ログの位置配列を使った新GAP方式のフル再生は未実施」と明記していたのに、
当方はそれを**引用しただけで埋めなかった**。単体テストと合成データだけで「合格」と書いた。
**`gap_authority` を実ログに対して一度も回していない。** 今回の①は、それをやれば必ず出た。

---

## 退行① GAP が黙る — 原因確定 ★最優先

### 実測

| | |
|---|---|
| `direction_conflict_rank_vs_physical` | **2,796回**（発話不可の理由は**これ1種類のみ**） |
| `dropping unconfirmed behind gap` | **2,771回** |
| 捨てられた `est` の符号 | **2,771件すべて正（＝物理は一貫して「後方」と言っている）** |
| 衝突相手 car idx | **idx=40 が2,023回 / idx=23 が657回**（＋29, 22 が各58回） |

```
18:07:42 Driver「後ろとのギャップ どう？」      ← 開始から24分
18:07:42 Luna  「後ろのGAPはまだ取れていない。」
18:11:45 GAP AUTHORITY: dropping unconfirmed behind gap (est=0.208秒)   ← 真後ろに張り付かれている
18:11:45 GAP AUTHORITY: dropping unconfirmed behind gap (est=0.209秒)
```

**特定の車で数千pollにわたり連続。ジッターではなく系統的。**
（当方は最初「至近距離での符号揺れ」と考えたが、**est が全件正で符号は揺れていない**。この仮説は誤り。）

### 根本原因：**クラスを跨いで順位を比較している**

`gap_authority.py:137`:

```python
direction, conflict = resolve_direction(
    rank_direction(target_class_position, player_class_position),   # ← クラス一致の確認が無い
    signed_gap_direction(signed_gap_s))
```

`rank_direction()` は2つの**クラス内順位**を大小比較するだけで、
**両車が同じクラスかを一切確認していない**（`gap_authority.py:70-81`）。

したがって GTP の P3 と 自車 GT3 の P10 を比べ、`3 < 10` → **`ahead`** と判定する。
物理位置は正しく **`behind`** と言う。→ `resolve_direction` が食い違いと見なす → **沈黙**。

**49台マルチクラス（GTP + IMSA23 32台）では、これが延々と起き続ける。**

`rank_direction` の docstring は「順位は曖昧さが無い（前は必ず番号が小さい）」と書いているが、
**それが成立するのは同一クラス内だけ**である。前提が明文化されないまま、呼び出し側で守られていない。

### なぜ単体テストで出なかったか

`tests_gap_authority.py:35-38` は `ga.rank_direction(7, 8)` のように**同クラスの想定しか試していない**。
**クラス跨ぎの入力が一件も無い。**

### 当方の提案（そちらの判断を仰ぐ）

順位方向と物理方向は**別々の問いに答えている**。互いの検算に使ってはいけない。

- **同クラス**（`same_class_battle_gap`）… `rank_direction` を使う。物理と食い違っても黙らない
- **クラス跨ぎ**（`physical_traffic_gap`）… **物理のみ**。順位比較を行わない
- 衝突判定は**同クラスが確定している時だけ**に限定する

判断を仰ぎたい点:

1. `rank_direction` に**同クラス判定を引数として要求する**（`target_class_id == player_class_id`）のが素直か、
   呼び出し側で分岐するのが良いか。**前者なら型で守れる。**
2. 同クラスかつ**周回差がある**場合（ラップダウン／ラップアップ）、順位と物理は正当に食い違う。
   ここも黙るべきではないはずだが、**当方は実データで確認できていない**。

---

## 退行② 記憶が発動しない

```
MEMORY_ACTION {
  record_count = 1          matched_keys = ['Mercedes-AMG GT3 2020|Circuit des 24 Heures du Mans']
  avg_fuel_l_per_lap = 7.85     ← 旧集計(pw_ctmem)由来
  memory_basis = None           ← ★personalFuelEvidence が unavailable
  avg_lap_s = None              ← ★直接の原因
  playbook_available = False    reason = historical_average_lap_unavailable
}
```

```
18:08:45 Driver「プランaは何週目？」→ Luna「Plan Aのピット周はまだ成立していない。」
18:12:31 Driver「前回の記録 持ってないの？」→ Luna「前回のこのコース・このクルマはデータがない。」
18:12:49 Driver「そんなわけないだろう。同じ車ででやってんのにさ。前6週 終わりで入ったんだよ。」
```

### 原因A タイム制には平均ラップが要るのに、記憶から通していない

```js
if (format.kind === 'timed') {
  if (!(averageLap > 20 && averageLap < 900)) return unavailable('historical_average_lap_unavailable');
  totalLaps = Math.ceil(format.duration_s / averageLap) + 1;
}
```

このレースは **timed 2700秒**。**燃費だけ記憶から通しても、タイム制では計画が立たない。**
午前のレースは `avgLap` を `pw_raceHistory` に保存している。**値は在るのに届いていない。**

平均ラップは `personalFuelEvidence.record?.avgLap` 経由でしか個人記憶から来ない
（`renderer.html:6702`）。そこが unavailable なので `avg_lap_s = None` になる。

### 原因B `strategyFuelEvidence` が unavailable な理由が**分からない**

`memory_basis = None` は `personalFuelEvidence.available === false` を意味する。
燃費 7.85 は旧集計由来（`matched_keys` の形式がそれ）。

**`strategyFuelEvidence` は `available:false` の時に `reason` を返しているのに、診断へ出していない。**

```js
return { available: false, reason: 'no_matching_record' };   // ← これが見えない
```

**`no_matching_record` / `fuel_burn_unavailable` / 各 mismatch のどれで落ちたかが分からず、
原因を特定できない。憶測で直したくない。まず診断に出してほしい。**

### Yuji の要求（言い方の順序）

> 「今実測データがない…」ではなく「**前回のでデータは…**」言わせるようじゃなきゃね

設計の契約は**グリッドでは記憶を根拠に答え、実測が出たら差し替える**だった。
現状は「実測が無い＝答えられない」の組み立てになっている。
A・Bを直した上で、**記憶がある時に記憶から先に喋る順序**が実装で担保されているかの確認が要る。

---

## 退行③ `null秒` がそのまま発話された

```
17:44:53  Luna「前方に停止車両。null秒。注意。」
18:02:43  Luna「前方に停止車両。null秒。注意。」
```

距離が無い時に `null` が文字列として発話へ流れている。
数値が無いなら距離を言わない（「前方に停止車両。注意。」）。

---

## 提案する順序

| # | 対象 | 理由 |
|---|---|---|
| **1** | **①GAPの沈黙（クラス跨ぎの順位比較）** | **公開中の製品で今起きている。接近戦で必ず黙る** |
| 2 | ③`null秒` | 1行。意味不明な語がドライバーに届いている |
| 3 | ②-B `strategyFuelEvidence` の `reason` を診断へ | **原因未特定。まず見えるようにする** |
| 4 | ②-A 平均ラップを記憶から通す | タイム制で計画が立たない直接原因 |
| 5 | 記憶を先に喋る順序の担保 | Yuji の要求 |

## 必須の検証（今回の失敗を繰り返さない）

**単体テストでは3件とも1つも捕まらなかった。実ログ再生を必須にする。**

| # | 検査 | 落とすもの |
|---|---|---|
| **A** | 本ログを `gap_authority` へ再生し、**`direction_conflict` が2,796回出ない** | ① |
| **B** | **クラス跨ぎの入力**（GTP P3 × 自車 GT3 P10・物理は後方）で**沈黙しない** | ①の本体・現行テストに存在しない |
| C | 同クラスで周回差がある入力で沈黙しない | ①の派生（当方未確認） |
| D | timed 2700秒＋記憶（燃費7.87・平均ラップ236秒）で**計画が成立** | ②-A |
| E | `strategyFuelEvidence` が unavailable な時、**理由が診断に出る** | ②-B |
| F | 距離が無い停止車両コールで **`null` を含む文字列を発話しない** | ③ |
| G | 変異：クラス一致判定を外すと **B が赤くなる** | 修正が効いている証拠 |

**A と B は今すぐ書ける。** 特に **B は現行 `tests_gap_authority.py` に一件も存在しない入力**である。

---

## 未確認・注意

- `strategyFuelEvidence` が落ちた理由は**未特定**（診断が無い）。**憶測で直さない。**
- 同クラスの周回差ケース（検査C）は**当方が実データで確認できていない**。
- 公開中の Build 295 は**この退行を含んだまま**。ロールバックの要否は Yuji の判断。
- **本レポートは実装を一切変更していない。**
