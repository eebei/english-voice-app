# Build 295 実走レポート — 退行3件（2026-09-04 夕 Le Mans / IMSA）

ログ: `OMORAY-bridge-debug-20260904-1606.log`（1.73MB・Build 295・Le Mans × Mercedes-AMG GT3 2020）
公式結果: `eventresult-88462769.json`

Yuji 報告:

> いまいち！**GAP全くダメだね、悪くなってるし！**
> **記憶発動もない！** こっちから聞いた。最初に聞いた時も、「今実測データがない…」ではなく
> 「**前回のでデータは…**」言わせるようじゃなきゃね！

**3件とも再現し、原因を特定した。うち2件は今日の変更による退行である。**

---

## まず当方の責任

**当方はこの実装を「合格」と独立検証し、公開に至った。3件とも見つけられなかった。**

検証が単体テストと合成データに閉じており、**実ログに対する GAP authority の再生を一度もしていない**。
Codex 自身が「過去ログの位置配列を使った新GAP方式のフル再生は未実施」と明記しており、
当方はそれを**引用しただけで、埋めないまま**「公開物で Gate 5 合格」と報告した。
**Gate 5 は中身がSHAと一致する証拠であって、正しく動く証拠ではない。** 混同はしていないが、
**未検証の穴を残したまま公開の判断材料を出した**ことに変わりはない。

---

## 退行① GAP が黙る ★最も重い

### 実測

| | |
|---|---|
| `direction_conflict_rank_vs_physical` | **2,796回**（発話不可の理由は**これ1種類のみ**） |
| `dropping unconfirmed behind gap` | **2,771回** |
| 走行中サンプルで `gapBehind=None` | 653件中 149件（23%） |

実走の会話:

```
18:07:42 Driver「後ろとのギャップ どう？」        ← レース開始から24分
18:07:42 Luna  「後ろのGAPはまだ取れていない。」
18:07:51 Luna  「今のテレメトリだと後ろとの距離が届いてないん。ごめん。」
```

### 原因

今回 `resolve_direction()` に**物理位置（LapDistPct）由来の方向**を追加した（`gap_authority.py`）。

```python
def resolve_direction(from_rank, from_physical):
    if from_rank and from_physical:
        if from_rank == from_physical:
            return from_rank, None
        return None, CONFLICT_RANK_VS_PHYSICAL      # ← 食い違ったら黙る
    return (from_rank or from_physical or None), None
```

**変更前は方向の出所が1つしか無かったので、この分岐に入りようが無かった。**
物理方向を足したことで、初めて「食い違い」が発生し得るようになった。

### 根本原因：クラスを跨いで順位を比較している（★確定・初版の推測を訂正）

**初版で「至近距離での符号揺れ」と書いたが誤り。** 捨てられた `est` は**2,771件すべて正**で、
符号は揺れていない。衝突相手も **idx=40 が2,023回 / idx=23 が657回**と**特定の車で連続**しており、
系統的である。

`gap_authority.py:137`:

```python
direction, conflict = resolve_direction(
    rank_direction(target_class_position, player_class_position),   # ← クラス一致の確認が無い
    signed_gap_direction(signed_gap_s))
```

`rank_direction()` は2つの**クラス内順位**を大小比較するだけで、**同じクラスかを確認していない**。
GTP の P3 と 自車 GT3 の P10 を比べ `3 < 10` → `ahead`。物理は正しく `behind`。→ 衝突 → 沈黙。

**49台マルチクラスでは延々と起き続ける。**
docstring の「順位は曖昧さが無い」が成立するのは**同一クラス内だけ**であり、
その前提が明文化されないまま呼び出し側で守られていない。

`tests_gap_authority.py:35-38` は同クラスの入力しか試しておらず、**クラス跨ぎが一件も無い**。

### 参考：捨てられた値

```
18:11:45  dropping unconfirmed behind gap (est=0.2082672119140625)
18:11:45  dropping unconfirmed behind gap (est=0.20947265625)
18:11:45  dropping unconfirmed behind gap (est=0.210723876953125)
18:11:45  dropping unconfirmed behind gap (est=0.212127685546875)
```

**0.21秒＝真後ろに張り付かれている状態。** この距離では LapDistPct 差の符号が毎 poll 揺れる。
一方クラス順位は安定している。**結果、接近戦のあいだ中ずっと食い違い、ずっと黙る。**

**ドライバーが最も GAP を必要とする瞬間に、最も黙る。** 挙動として逆である。

### 直し方（当方案・Codex の判断を仰ぐ）

コード内のコメント自身が答えを持っている:

```python
def rank_direction(...):
    """クラス順位から方向を出す。順位は曖昧さが無い（前は必ず番号が小さい）。"""
```

**同クラスの順位は曖昧でない**と宣言している。物理位置が必要なのは**クラスを跨ぐ traffic** である。
したがって:

- **同クラス（`same_class_battle_gap`）は順位を正とし、物理と食い違っても黙らない**
- 物理方向は**クラス跨ぎ（`physical_traffic_gap`）の判定にのみ使う**
- どうしても両方で検証したいなら、**符号が意味を持つ距離（例 |gap| > 0.5秒）でのみ**衝突判定する

---

## 退行② 記憶が発動しない

### 実測（診断行が全部語っている）

```
MEMORY_ACTION {
  record_count       = 1                    ← 記録は見つかっている
  matched_keys       = ['Mercedes-AMG GT3 2020|Circuit des 24 Heures du Mans']
  avg_fuel_l_per_lap = 7.85                 ← 燃費はある
  memory_basis       = None                 ← ★新しい個人記憶は使われていない
  avg_lap_s          = None                 ← ★これが直接の原因
  playbook_available = False
  reason             = historical_average_lap_unavailable
}
```

実走の会話:

```
18:08:45 Driver「プランaは何週目？」
18:08:46 Luna  「Plan Aのピット周はまだ成立していない。」
18:12:31 Driver「前回の記録 持ってないの？」
18:12:33 Luna  「前回のこのコース・このクルマはデータがない。」
18:12:49 Driver「そんなわけないだろう。同じ車ででやってんのにさ。前6週 終わりで入ったんだよ。」
```

### 原因A タイム制レースには平均ラップが要るのに、記憶から渡していない

```js
if (format.kind === 'timed') {
  if (!(averageLap > 20 && averageLap < 900)) return unavailable('historical_average_lap_unavailable');
  totalLaps = Math.ceil(format.duration_s / averageLap) + 1;
}
```

このレースは **timed（2700秒）**。総周回数を出すのに平均ラップが必須である。
**燃費だけ記憶から通しても、タイム制では計画が立たない。**

午前のレースは `avgLap` を `pw_raceHistory` に保存している（`renderer.html:6452`）。**値は在る。届いていない。**

### 原因B 個人記憶（`pw_raceHistory`）自体が使われていない

`memory_basis = None` は `personalFuelEvidence.available === false` を意味する。
燃費 7.85 は**旧集計（`pw_ctmem`）由来**である（`matched_keys` の形式がそれ）。

```js
const personalAverageLap = personalFuelEvidence && personalFuelEvidence.available
  ? Number(personalFuelEvidence.record?.avgLap) : NaN;
const storedAverageLap = Number.isFinite(personalAverageLap) && personalAverageLap > 20
  ? personalAverageLap : (canUseLegacyAggregate ? matchingHistoricalAverageLap() : null);
```

**平均ラップは `personalFuelEvidence` 経由でしか個人記憶から来ない。**
そこが unavailable なので `avg_lap_s = None` になる。

**なぜ `strategyFuelEvidence` が unavailable なのかは未特定。** `selectPrevious` の
どの条件で落ちたかを示す診断が無い。**`reason` を診断へ出すべきである**（`no_matching_record` /
`fuel_burn_unavailable` / 各 mismatch のどれか）。ここが分からないと直せない。

### Yuji の要求（言い方）

> 「今実測データがない…」ではなく「**前回のでデータは…**」言わせるようじゃなきゃね

現在は**実測が無い＝答えられない**という組み立てになっている。
設計MDで契約として書いたのは逆で、**グリッドでは記憶を根拠に答え、実測が出たら差し替える**である。
原因AとBを直せば言えるようになるが、**「記憶がある時は記憶から先に喋る」順序そのものが
実装で担保されているか**を確認する必要がある。

---

## 退行③ `null秒` がそのまま発話された

```
17:44:53  Luna「前方に停止車両。null秒。注意。」
18:02:43  Luna「前方に停止車両。null秒。注意。」
```

**2回。** 距離が無い時に `null` が文字列として流れている。
数値が無いなら距離を言わない（「前方に停止車両。注意。」）が正しい。

---

## 副次的に見えた既知の弱点（今回の変更とは無関係）

- `右に車` / `左に車` が 18:03:05〜18:03:51 の46秒間に**5回**。局面の束ねが未実装（Road Atlanta 分析 §9 の未着手項目）。
- 18:15:42 Driver「5.7秒とかいないと思うんだけどな。gdp？ いるの？」→ Luna「今の質問、聞き取れた範囲では答えを持っていない。」
  直後に Driver「ごめん いた。」 ＝ **コール自体は正しかったが、確認の問いに答えられていない。**

---

## 提案する順序

| # | 対象 | 理由 |
|---|---|---|
| **1** | **退行①（GAPの沈黙）** | 接近戦で必ず黙る。**公開中の製品で今起きている。最優先** |
| 2 | 退行③（`null秒`） | 1行の修正で消える。ドライバーに意味不明な語が届いている |
| 3 | 退行②-A（平均ラップを記憶から通す） | タイム制で計画が立たない直接原因 |
| 4 | 退行②-B（`strategyFuelEvidence` の失敗理由を診断へ） | **原因が特定できていない。まず見えるようにする** |
| 5 | 記憶を先に喋る順序の担保 | Yuji の言う「前回のデータは…」 |

## 検証（今回の失敗を繰り返さないために）

**単体テストでは今回の3件は1つも捕まらなかった。実ログに対する再生を必須にする。**

| # | 検査 | 落とすもの |
|---|---|---|
| A | 本ログを `gap_authority` へ再生し、**`direction_conflict` が2,796回出ないこと** | 退行① |
| B | 0.2秒の接近戦サンプルで**方向が確定し発話可能**になること | 退行①の本体 |
| C | timed 2700秒＋記憶（燃費7.87・平均ラップ236秒）で**計画が成立**すること | 退行②-A |
| D | `strategyFuelEvidence` が unavailable な時、**理由が診断に出る**こと | 退行②-B |
| E | 距離が無い停止車両コールで **`null` を含む文字列を発話しない**こと | 退行③ |

**Aは今すぐ実行できる。** 本ログには `GAP AUTHORITY` の入力に必要な値が残っている。

---

## 未確認・注意

- `strategyFuelEvidence` が落ちた理由は**未特定**（診断が無いため）。憶測で直さない。
- 公開中の Build 295 は**この退行を含んだまま**である。ロールバックの要否は Yuji の判断。
- 本レポートは実装を一切変更していない。
