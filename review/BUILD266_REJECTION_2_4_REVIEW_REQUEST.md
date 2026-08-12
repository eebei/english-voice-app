# Build 266 差戻し #2 / #4 — Codexレビュー依頼

作成: 2026-08-12 / Claude Code
正本: [PITWALL_SHARED_WORKING_LOG.md](PITWALL_SHARED_WORKING_LOG.md) / [PITWALL_INTERNAL_SIMULATION_TEST_POLICY.md](PITWALL_INTERNAL_SIMULATION_TEST_POLICY.md)
前段: [BUILD266_REJECTION_1_5_3_CODEX_REREVIEW.md](BUILD266_REJECTION_1_5_3_CODEX_REREVIEW.md)（#1 / #3a / #3b / #5 承認済み）

## レビューモード

読み取り専用の独立レビュー。編集・commit・push・build・deploy・公開はしない。
`file:line` を根拠に P0 / P1 / P2 で報告する。

## この依頼の範囲

差戻し7項目のうち **#2（再計算が記録だけ）と #4（Plan C未実装）** を実装した。
両者は同じエンジンの話なので分けずに扱っている。

**残る #6（統合テストがBridge実行経路外）と #7（原価ゲート未証明）は未着手。**
八木さんログ由来5項目も未着手。したがって Build 266 は依然 **Build候補ではない**。
commit / push / build / 公開はしていない。

## 変更ファイル

| ファイル | 役割 |
|---|---|
| `irsdk-bridge/strategy_options.py` | Plan C の生成・条件判定・Plan A/B/C の実再評価 |
| `irsdk-bridge/bridge.py` | 再計算の待ち行列・実行本体・Plan C条件の実測配線 |
| `irsdk-bridge/tests_strategy_reevaluation.py` | 新規39テスト（挙動） |
| `irsdk-bridge/tests_bridge_recalculation_wiring.py` | 64テスト（+13・配線） |
| `irsdk-bridge/tests_judge_llm_gate.py` | 正規表現の走査窓を6000→8000へ（後述） |

---

## 差戻し#2 — 再計算が記録だけで、戦略を再計算していない

### 何が壊れていたか

7つのトリガーは全て `recalculate_strategy()` に **既存の `active_plan` をそのまま渡して** trace を出すだけだった。
燃費が悪化しても、損傷を申告しても、Planは一切組み直されず、`active_plan` も動かなかった。

### 直し方

#### (a) トリガー検出と再計算の実行を分離した

トリガーが立つ場所（損傷検出・ドライバー申告・燃費/ペース乖離・クリーン3周）はフレーム前半にある。
一方、再計算に必要な権威データ（残り周回・容量・ピットリジョイン予測）はフレーム後半でしか揃わない。
前半で再計算すると **1周古い入力で組み直す** ことになる。

- `bridge.py:624` `queue_recalculation()` — 前半では待ち行列へ積むだけ。同一フレームで同じ (reason, dedupe_key) が二重に積まれない。
- `bridge.py:5510` 実行ブロック — `fuel_strategy` / `_fuel_strategy_live` / リジョイン予測が今フレームの値に更新された後で、一度だけ実行する。
- `bridge.py:639` `execute_recalculation()` — 1件分の実行。Plan組み直し → `active_plan` 更新 → trace記録。

**7トリガー全てがこの1本の経路を通る。** `rival_pit_or_rejoin_shift` だけ別経路で記録していた箇所も同じ経路へ寄せた（別経路のままだと Plan C を含む再評価を通らない）。

#### (b) 実際に組み直す本体

- `strategy_options.py:280` `reevaluate_plans()` — 実測された燃費・燃料・残り周回・容量からPlan A/B/Cを組み直し、選び直す。

証拠が足りない時は **前のPlanを維持して理由を返す**。黙って古い前提を使い続けることも、根拠なく乗り換えることもしない。

### trace

```text
STRATEGY_RECALCULATION | reason=driver_reported_damage | baseline_fuel_l_per_lap=3.6 | recent_fuel_l_per_lap=3.9 | ...
STRATEGY RECALCULATION OUTCOME reason=driver_reported_damage available=True previous_plan=A selected_plan=A plan_changed=False decision=plan_a_equal_or_safer_rejoin plan_c={...}
```

### 検証してほしい契約

1. 燃費が悪化した入力で、`plan_a.target_in_laps` が実際に前倒しされること。
2. 再計算後の `active_plan_snapshot` が、**組み直した方**のスナップショットであること。
3. 入力が不足した時に、前のPlanが消えないこと。
4. 7トリガーが全て同じ経路を通ること。
5. 実行がトリガー検出より後、かつ権威データ更新より後にあること。
6. 待ち行列がフレームごとに必ず排出されること。

---

## 差戻し#4 — Plan C未実装

### 設計

brief 3-1 の「オーバーカットを常設の同格案として扱わない。根拠がないなら unavailable」に従い、二段構えにした。

1. **ブリーフィング時**（`strategy_options.py:174` `_build_plan_c`）：燃料計算だけで「そもそも届くのか」を出す（`fuel_feasible`）。届いても `available` は **False**。根拠が無いからである。
2. **ライブ**（`strategy_options.py:234` `decide_plan_c`）：4条件が全て実測で揃った時にだけ `available=True`。

条件（`strategy_options.py:25`）：

| 条件 | 実測の出どころ |
|---|---|
| `rival_pitted_first` | 同クラス前走車が今ピットロード上にいる（`CarIdxOnPitRoad`） |
| `clean_air` | 前走車とのギャップ ≥ 2.0秒（`PLAN_C_CLEAN_AIR_GAP_S`） |
| `fuel_save_on_target` | ラッチした目標を直近クリーン周の中央値が下回った |
| `rejoin_not_worse` | 延長後の予測が likely / worst のどちらも悪化しない |

**`None`（不明）は決して「満たされている」と扱わない。** 未証明は未証明である。

非現実的な節約が必要な場合（`PLAN_C_MAX_SAVE_FRACTION = 0.08` 超）は `fuel_save_target_unrealistic` として届かない扱いにする。捏造した希望を出さない。

### 実装中に見つけて直した自分の欠陥（重要）

最初の実装では **Plan C が本番で構造的に成立し得なかった。**

目標値は「今の燃費なら latest_safe+1 まで届かせるのに必要な燃費」であり、計算に使った燃費より必ず小さい。
節約して燃費が下がるたびに組み直すと、**目標も一緒に下がって逃げ続ける**。

```text
計画燃費 3.5 → 目標 3.45（3.5 では届かない）
節約して 3.2 → 組み直すと目標 3.136（3.2 では届かない）
```

`strategy_options.py:322` で **最初に提案した時の目標をラッチ** し、その後の実測がそれを下回った時に達成とする形へ直した。
テストを書いたことで出てきた欠陥であり、変異試験にも「ラッチしない」パターンを入れてある。

### 検証してほしい契約

1. ブリーフィング時点で `available` が必ず False であること。
2. 4条件のどれか1つでも欠けたら成立しないこと。`None` でも成立しないこと。
3. 目標がラッチされ、節約が実際に達成に届くこと。
4. 目標未達なら成立しないこと。
5. 8%超の節約が必要な時に「届く」と言わないこと。
6. bridge が条件を実測から埋めており、`None` 固定になっていないこと。

---

## 変異試験

**11件すべて、実際にコードを壊してテストが落ちることを確認済み**（確認後に復元）。

| # | 変異 | 検出 |
|---|---|---|
| 1 | 再計算を trace だけに戻す | ✅ |
| 2 | `active_plan` を更新しない | ✅ |
| 3 | 古い燃費で組み直す | ✅ |
| 4 | 証拠不足でも前のPlanを捨てる | ✅ |
| 5 | 待ち行列を排出しない | ✅ |
| 6 | briefing で Plan C を同格に出す | ✅ |
| 7 | 未証明（None）を満たしたと扱う | ✅ |
| 8 | 非現実的な節約でも「届く」と言う | ✅ |
| 9 | Plan C の目標をラッチしない（逃げる目標） | ✅ |
| 10 | Plan C 条件を None 固定に戻す | ✅ |
| 11 | 節約目標を自分自身と比較する | ✅ |

**#1 と #2 は最初、検出できなかった。** `execute_recalculation` が静的なソース文字列チェックしか持たず、
中身を空にしても文字列自体は残るためである。bridge を実際に import して動かす挙動テスト
（`BridgeRecalculationExecution`）を追加し、両方とも検出されるようにした。

## テスト結果

```bash
python3 irsdk-bridge/tests_strategy_reevaluation.py        # 39 tests OK（新規）
python3 irsdk-bridge/tests_bridge_recalculation_wiring.py  # 64 tests OK（+13）
python3 irsdk-bridge/tests_strategy_options.py             # 既存契約 OK
for t in irsdk-bridge/tests_*.py; do python3 "$t"; done    # 34スイート全green
for t in tests-*.js; do node "$t"; done                    # 後述1件を除きgreen
```

挙動テストは静的検査ではなく、bridge が呼ぶのと同じ関数を同じ順序で動かしている
（`BridgeRecalculationExecution` は `bridge` モジュールを直接 import している）。

## 原価ゲート

- 外部Anthropic呼出：**0** / 外部Google STT・TTS呼出：**0**
- 新規・変更テストはファイル読み込みと純関数とモジュールimportのみ。HTTPクライアントを一切importしていない。
- **正本が要求する simulated / generated / played / deferred / discarded / wasted-generation cost の計装自体は未実装（差戻し#7）。** 上記は「実APIを呼んでいない」ことの確認であって、原価ゲートの証明ではない。

## 判断がほしい点

### 1. Plan B の意味が brief と実装で食い違っている

brief 3-1 は **Plan B = undercut（早めに入る）** と書いている。
しかし公開中の Build 265 の実装では `plan_b` は `extend_one_lap`、つまり **Plan A より1周遅く入る** 案である
（`plan_a_in = latest_safe - 1`、`plan_b_in = latest_safe`）。日本語無線も「1周延長案」と読み上げている。

今回はこの既存定義を変えず、Plan C を **Plan B のさらに1周先へ延ばす fuel-save 案** として実装した。
既存のPlan A/Bの意味を変えると、公開済みBuildの発話契約（renderer の文面・`strategy_plan_decision` の無線）まで変わるため、独断では動かしていない。

**brief の通り B を undercut へ定義し直すべきか、現行の意味のままでよいか**を指示してほしい。

### 2. `tests_judge_llm_gate.py` の走査窓を広げた

SessionNum reset 経路にセッションスコープ変数が増え、既存の正規表現（6000字窓）がブロック末尾へ届かなくなった。
sig 経路側の窓（8000）と揃えた。検証しているのは「両経路で unpack されていること」であって窓幅ではないと判断したが、
テストを触っているので報告する。

## 今回の作業と無関係の既存不具合（報告のみ・触っていない）

`tests-five-day-access.js` が失敗する。`applyPitwallAccess(...)` の出現数が10で期待値7と合わない。
**現在の HEAD（`da0c4a3`）でも同じ数・同じ失敗**を確認済みで、今回の変更が原因ではない。
作業中に HEAD が `de54d0e` → `da0c4a3`（`Define time-boxed free access policy`）へ進んだが、失敗は両方の HEAD で再現する。課金・認証まわりのため触っていない。

## 残る限界（正直に）

- 挙動テストは bridge のモジュール関数を直接動かしているが、**poll loop 自体を回した完全な再生ではない**（差戻し#6）。
- Plan C の `rival_pitted_first` は「前走車が今ピットロード上にいる」という現在値を根拠にしている。
  「既にストップを終えた」という履歴ベースの判定ではない。保守側（見えている時だけ True）に倒してあるが、
  より強い根拠が要るなら指示がほしい。
- 差戻し #6 / #7 と八木さんログ由来5項目は未着手。Build 266 は候補不可。
