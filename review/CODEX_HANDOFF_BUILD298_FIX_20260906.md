# Codex へ：Build 298 事後Gate 修正 ④Plan/Memory・③残周回（Gate 4依頼）

宛先: Codex（確認者） / 作業者: Claude Code / 決裁: Yuji
日付: 2026-09-06 JST
base: `6c25500`（未commit）
状態: **4系統すべて緑（追記7時点）。commit・Build・公開は提案しない**

正本の指示: 共有ログ `2026-09-05 17:38 JST — Codex：Build 298実走事後Gate（不合格・修正指示）`
Founder 指示（2026-09-06）: 「4系統の赤テストを先に全部並べる。④→③→①→②の順で直す。
②はBuild 297方式への追加修正ではなく**構造の置き換え**。」

---

## 0. 順序と現在地

| 段階 | 内容 | 状態 |
|---|---|---|
| 1 | ①〜④のreplayを実走ログ由来で作成 | ✅ |
| 2 | 現状コードで意図どおり赤になる確認 | ✅ 4系統18件が赤 |
| 3 | **④ Plan／Memory** | ✅ **本MD** |
| 4 | **③ 残周回** | ✅ **本MD** |
| 5 | **① PDDP** | ✅ **追記4＋追記5**（Codex差戻しP1 2件 closure） |
| 6 | **② GAP（構造置き換え）** | ✅ **追記7** |
| 7 | 各修正後に4系統再実行 | ✅ 実施中 |
| 8 | 全緑まで commit・Build・公開なし | ✅ **全緑到達。commit GO待ち** |

現在 `tests-build298-race-replay.js` **123/123（4系統すべて緑）**。preflight ✅ 出荷可。※数値は追記7時点。
`preflight.sh` は本スイートのみ赤＝**出荷不可の状態を意図的に維持**している。

---

## 1. 赤テストと fixture（実走ログ由来）

新規 `tests-build298-race-replay.js`（58検査）。fixture は合成ではなく実ログから抽出:

| ファイル | 内容 |
|---|---|
| `fixtures/build298/gap-rebuilds.json` | `GAP_FRESHNESS fate=rebuild` **10件全部**（候補本文・最終本文・was/now/target） |
| `fixtures/build298/convo-timeline.json` | 266イベント（ドライバー発話26件を含む） |

出典: `OMORAY-bridge-debug-20260905-1738.log`（5,644行）、`eventresult-88487294.json`。

---

## 2. 変更箇所

### 新規 `desktop/session-strategy-state.js`（157行）

| API | 役割 |
|---|---|
| `create({session_key})` / `revision(st)` | セッション単位の正本。前レースのPlanを持ち越さない |
| `agreePitPlan` / `amendPitPlan` / `cancelPitPlan` / `pitPlan` | 合意・訂正・取消。訂正しても合意元（driver/engineer）を失わない |
| `recordPitExecuted` | **pit実行で旧Planを即失効**。履歴には残す |
| `answerPitDecision` | 実行済みを最優先で返す。「ステイアウト」を構造的に出せない |
| `answerFuel` | **残り距離**に対してのみ判定 |
| `restateDriverStrategy` | 保存ACKで終わらせず内容を復唱 |

### `desktop/local-intent-router.js`（+63行）

| 行 | 変更 |
|---|---|
| 213-236 | **新設** `normalizeLapWords()`。`normalizeSttText()` から呼ぶ |
| 322-355 | **新設** `pit_plan_question` / `pit_this_lap`。残り周回より**手前**に置く |
| 541 | `normalizeLapWords` を export（検査用・理由は §4） |

### `desktop/renderer.html`（+107/−63）

| 行 | 関数 | 変更 |
|---|---|---|
| 707 | — | `<script src="session-strategy-state.js">` を追加（Gate 5 の同梱検査は script src から派生） |
| 4641付近 | **新設** `ensureStrategyState()` | セッションキーが変われば作り直す |
| 4655付近 | `injectRadio()` | `trigger==='pit_entry'` で `recordPitExecuted()` ＋ `STRATEGY_STATE` trace |
| 2589 | 質問経路 | router へ `strategy:{state,api}` を渡す |
| 2799付近 | `telemetryTruthFallback()` | **残り周回の複製を削除**し router へ委譲 |

### テスト

| ファイル | 変更 |
|---|---|
| `tests-build298-race-replay.js` | **新設**（58検査） |
| `preflight.sh` | `▶ Build 298 実走 replay` を登録＝**全緑まで出荷不可** |
| `tests-timed-race-truth.js` | 権威の移動に合わせ**両側**検査へ更新（§5） |

---

## 3. 原因と修正の対応

| 実走の失敗 | 原因 | 修正 |
|---|---|---|
| 18:19:39「何週目にピットインする？」→ unhandled →「Plan Aのピット周はまだ成立していない。」 | **STTが「周」を「週」と書き起こしていた**。router の正規表現は `周\|ラップ` のみ | `normalizeLapWords()` ＋ `pit_plan_question` |
| 18:22:48「この週でピットイン だ。」→ unhandled | 同上。Planとして保存されない | `pit_this_lap` → `agreePitPlan()` |
| 18:25:54 pit実行 → 18:43:21「今はステイアウト。ピットウィンドウまで走れる。」 | pit実行がPlanを失効させない | `injectRadio` の `pit_entry` → `recordPitExecuted()` |
| 18:44:53「完走まで8.3L不足。Plan A継続」 | **pit前の全レース距離**を前提に計算し続けた | `answerFuel()` が残り距離のみで判定 |
| 18:51:35 戦略の指摘へ「保存したよ」 | 保存成功と会話成立の混同 | `restateDriverStrategy()` |
| 同レースで残り周回の答えが三通り | renderer と router に**同じ正規表現ごと複製** | renderer の複製削除・router を唯一の権威へ |

**8.3L不足は値の誤差ではない。** 実走 18:44:53 の実値は Fuel 15.9L・実測 7.865L/lap・残り約2周＝足りている。
前提が更新されていなかっただけである。だから個々の回答ではなく前提を1つに集めた。

---

## 4. 当方が出した欠陥3件（記録）

Founder の固定要件を満たす過程で、当方の作業から3件出た。**隠さず残す。**

1. **`window` を直参照**した。`window` の無い文脈で throw し、
   `tests-telemetry-truth-gate.js` と `tests-build291-fix2.js` を壊した。`globalThis` ガードで修正。
2. **「週目」正規化が死んだコード**だった。数字/何の規則が先に拾うため、
   削除しても**どのテストも赤にならない**。変異試験で発覚し削除した。
3. **反例テストが弱かった。** 「来週も走る？」は周へ化けても `laps_remaining` の
   条件に当たらないため、**一律変換の変異を検出できなかった**。
   `normalizeLapWords` を公開して正規化そのものを直接検査し、
   ③-2 の「不在検査」も `telemetryTruthFallback` の**実経路 VM 実行**へ置き換えた。

3件とも「書いたが呼ばれていない／検出できない」型である。

---

## 5. `tests-timed-race-truth.js` を触った理由（弱めていない）

`'remaining-lap fallback uses crossing authority': renderer.includes('finish_crossings_authority')`
は、renderer の複製を消したことで落ちた。契約は**移動しただけ**なので、両側を検査する形へ更新した:

- renderer が router へ委譲していること（`PitwallLocalIntentRouter` ＋ `_laps.intent==='laps_remaining'`）
- router が `finish_crossings_authority` を持つこと

**片側だけの substring 検査へ戻すと、委譲をやめる変異が通る。**

---

## 6. 変異試験

| 変異 | 結果 |
|---|---|
| renderer の router 委譲を無効化 | ✅ 検出（47→44） |
| 週を一律変換（来週・今週も壊す） | ✅ 検出（47→40） |
| 「この週末」保護を外す | ✅ 検出（47→46） |
| 数字/何＋週の規則を削除 | ✅ 検出（−3） |
| pit実行でPlanを失効させない | ✅ 検出 |
| renderer の pit実行遷移を削除 | ✅ 検出 |
| 燃料を全レース距離で判定（8.3L不足の再現） | ✅ 検出 |

退行: `preflight.sh` 全スイートのうち赤は**本 replay スイートのみ**。

---

## 7. 未確認・反証依頼

1. **`normalizeLapWords` の境界。** 「この週末は空いてる？」「週明けにテスト」は守ったが、
   レース会話で「週」が周回以外に出る言い方を**当方は数え上げていない**。反例を求む。
2. **`ensureStrategyState()` のセッション境界。** `conversationSessionKey()` に依存している。
   Qualify→Race の遷移でキーが変わるかは**実機未確認**。変わらなければ前セッションのPlanが残る。
3. **`pit_entry` 以外のピット成立経路**（ピットレーン進入を取り逃した場合）を数え上げていない。
   `recordPitExecuted` の入口が1つで足りるかは未検証。
4. **`agreePitPlan` に渡す `live.lap`** が「この周」の意味で正しいか。
   S/F通過直前の申告では1周ずれ得る。実走ログでは判定できない。
5. Windows/Electron 実機、実TTS、iRacing 実走はすべて未確認。

---

## 8. 依頼

- ④③に対する **Gate 4**（§7 の反証5点を含む）
- P0/P1 があれば差戻し。当方が直す

**①②は未修正のまま赤。commit・Build・公開は提案しない。**

---

# 追記 2026-09-06 — Codex 差戻し P1 4件への対応（第2回）

差戻し元: 共有ログ `2026-09-06 JST — Codex：Build 298事後Gate ④③ 独立Gate 4（差戻し）`
判定の要旨: **「新しいstate API自体は動くが、実走で失敗した製品経路まで接続されていない」**

**指摘は全面的に正しい。** 当方は API を作って API を直接呼ぶ検査を書き、
製品がその API を呼んでいるかを見ていなかった。**4件とも「書いたが呼ばれていない」型**である。

## 対応表

| P1 | 指摘 | 修正箇所 | 内容 |
|---|---|---|---|
| **1** | `answerFuel()` の製品呼出し0件。`fuelReply()` が旧 `pit_timing_authority` から「不足」「Plan A継続」を今も作れる | `local-intent-router.js:285-303` | `fuel_status` 分岐で pit実行済みなら `fuelReply()` を**通さない**。`range_laps` と `finish_crossings_authority` から残り距離のみで答える。権威値が揃わない時は旧文へ落とさず不足情報だけ言う |
| **2** | `restateDriverStrategy()` の製品呼出し0件。18:51 の経路を塞いでいない | `renderer.html:5798-5807` | 実走18:51の出所は debrief の `recordEvidenceAnswer()` だった。最終回答を復唱してから保存を伝える |
| **3** | radio `pit_entry` は Speed>5m/s のときだけ。低速進入でPlanが失効しない | `renderer.html:4672` **新設** `observePitState(live)`／`renderer.html:4058` 呼出し | 権威 telemetry の `on_pit_road` false→true を**唯一の**遷移条件に。`injectRadio` からは外した。発話可否から独立 |
| **4** | Plan申告テストが保存を検証せず、「次の周」を current へ潰していた | `local-intent-router.js:364-381` | `次の周` を `current+1` として別扱い。復唱も分離。**現在周が取れない時は推測せず周を聞き返す**（合意扱いにしない） |

## 赤テストを先に足してから直した

`tests-build298-race-replay.js` は 58→73検査。追加はすべて**製品経路を実行する**もの。

- **P1-1 は再現を先に証明した。** state を渡さない基準経路で実走の
  「現燃料で約2.0周。完走まで8.3L不足。…Plan Aを継続」がそのまま出ることを確認してから、
  state 付きで出せなくなることを見ている。再現できない修正は証明にならない。
- **P1-2** は `recordEvidenceAnswer()` を VM で実行（`addMsg`/`speak`/保存をスタブ）。
- **P1-3** は `observePitState()` を VM で実行し、コース上→低速進入の順に流す。
- **P1-4** は state を渡し、**保存された lap・source・復唱文**を検証。

## 当方の欠陥（第2回・1件）

**変異「`observePitState` の呼出しを削除」が検出できなかった。**
関数を VM で実行する検査しか無く、**telemetry 受信経路から呼ばれているか**を見ていなかった。
Codex の P1-3 とまったく同じ型の穴を、その修正の中で作っていた。
`data.type==='telemetry_live'` 以降の処理内に呼出しがあることを検査に追加し、検出されるようにした。

## 変異試験（6/6検出）

| 変異 | 結果 |
|---|---|
| `on_pit_road` 遷移を無効化 | ✅ −2 |
| telemetry からの観測呼出しを削除 | ✅ −1（配線検査を足した**後**。足す前は素通り） |
| debrief の復唱を削除 | ✅ −1 |
| 燃料の pit実行判定を無効化 | ✅ −2 |
| 「次の周」を current へ潰す | ✅ −1 |
| 「この週末」保護を外す | ✅ −1 |

## 現在地

`tests-build298-race-replay.js` **62/73**。残り赤11件は **①PDDP 5・②GAP 6 のみ**で、
③④は緑。`preflight.sh` は本スイート以外すべて緑＝**意図した出荷不可**を維持。

## 未対応（Codex の反証で残った分）

- `ensureStrategyState()` の **Qualify→Race セッション境界**。Codex は「コード上成立するが実機未確認、
  VMまたは統合テストを追加する」としている。**当方はまだ追加していない。**
- `pit_entry` 以外の成立経路は `on_pit_road` へ移したが、**ピットレーン進入自体を取り逃す場合**
  （テレメトリ欠損・切断）は数え上げていない。
- Windows/Electron 実機、実TTS、iRacing 実走は未確認のまま。

**commit・Build・公開は提案しない。①へ進む前に本追記の再確認を依頼する。**

---

# 追記2 2026-09-06 — Codex 第2回差戻し（P1-3 初回true誤判定）への対応

差戻し元: 共有ログ `Codex：Build 298事後Gate ④③ 独立Gate 4（第2回・再差戻し）`

## 指摘は正当。**製品として危険な誤爆だった**

`renderer.html` の `_pitRoadPrev = false` 初期化のため、接続時・セッション開始時の
最初の telemetry が `on_pit_road=true` なら、false→true の遷移が無いのに
`recordPitExecuted()` を呼ぶ。

**ピットボックスからのレーススタートは常にこれである。** つまりレース開始直後に
「ピット実行済み」となり、合意したPlanが即失効する。実走で直そうとした
18:43「ステイアウト」より悪い状態を、当方が新たに作っていた。

Bridge 側は同じ誤爆を `prev['onPit'] is False`（None→True を除外）で既に塞いでいる。
**既知の不具合を Strategy State へ再導入した**という Codex の指摘のとおり。

## 修正（受入条件4項目に対応）

| 受入条件 | 修正箇所 | 内容 |
|---|---|---|
| 1 `unknown/off/on` の三値・初回は seed のみ | `renderer.html:4672-4686` | `observePitState.prev` を三値に。初回観測は seed だけで pit実行にしない |
| 2 観測済み `false→true` のときだけ実行 | 同上 | `entered = (prev==='off' && now==='on')` |
| 3 セッション境界・切断で reset | `renderer.html:3929`（切断・stale）／`:4029`（`session_num` 変化） | **新設** `resetPitStateObservation()` を2箇所から呼ぶ |
| 4 replay へ3ケース追加し受信経路から検証 | `tests-build298-race-replay.js` | 「初回trueはpit未実行」「seed後のfalse→trueは実行」「reset後の初回trueも未実行」＋呼出し配線2件 |

状態は**関数自身のプロパティ**に持たせた（`let` を離れた場所に置くと、
検査時に取り違える。実際に前版は VM 抽出で未定義になり、`false` 側の短絡で
たまたま通っていた）。

## 当方の欠陥（第3回・1件）

**配線検査を「出現回数 ≥2」で書いたため、呼出しを1つ消しても緑だった。**
`function resetPitStateObservation(){` の `(){` まで数えていた。
呼出し文脈を名指しで見る形（切断行の直後／`resetSessionScopedReviewState` の直後）に変更し、
変異M2・M3とも検出されるようにした。

**3回連続で「配線を検査していない」型の穴を出している。** 記録しておく。

## 変異試験（4/4検出）

| 変異 | 結果 |
|---|---|
| `unknown` を `off` 初期化へ戻す（差戻し前の誤爆） | ✅ −1 |
| セッション境界の reset を削除 | ✅ −1（文脈検査へ変更後。件数検査では素通り） |
| 切断時の reset を削除 | ✅ −1（同上） |
| 遷移条件を「on なら常に」へ | ✅ −2 |

## 現在地

`tests-build298-race-replay.js` **68/79**。残り赤11件は **①PDDP 5・②GAP 6 のみ**。
③④は緑。preflight は本スイート以外すべて緑。

**commit・Build・公開は提案しない。**

---

# 追記3 2026-09-06 — Codex 第3回差戻し（P1-3 切断配線漏れ）への対応

差戻し元: 共有ログ `Codex：P1-3第2回再確認（切断配線漏れ・再差戻し）`

## 指摘は正当

受入条件に「切断で reset」と自分で書きながら、繋いだ先は `markTelemetryStale()` だけで、
**実切断分岐 `data.type==='iracing_disconnected'`（`renderer.html:3989-3995`）は未配線**だった。
検査も `markTelemetryStale` の文字列にしか一致しておらず、実分岐を見ていなかった。

**切断前の最終観測が `off`、再接続後の初回が `on` なら、seed ではなく false→true と
判定され偽の `pit_executed` が再発する。** 前回塞いだはずの誤爆が、経路を変えて残っていた。

## 修正（受入条件4項目）

| # | 受入条件 | 対応 |
|---|---|---|
| 1 | `iracing_disconnected` 実分岐で reset | `renderer.html:3994` に追加 |
| 2 | 分岐**範囲内**にあることを名指しで検査 | 分岐開始位置から次の `return;` までを切り出して検査。**ファイル全体の有無では通ってしまう** |
| 3 | `off → 切断 → 初回on` で pit未実行を検査 | replay へ状態系列を追加（前提として切断前 off を観測していることも確認） |
| 4 | `markTelemetryStale`・SessionNum境界の既存 reset を維持 | 3箇所すべて個別に検査（`:3929` `:3994` `:4033`） |

## 変異試験（3/3検出）

| 変異 | 結果 |
|---|---|
| 切断分岐の reset を削除 | ✅ −1 |
| stale の reset を削除 | ✅ −1 |
| セッション境界の reset を削除 | ✅ −1 |

**1回目の変異は `perl` の置換が当たらず no-op だった。** 件数が減っていないことに気づき、
行指定でやり直した。**適用されたことを確認せずに「検出できず」と報告しない。**

## 現在地

`tests-build298-race-replay.js` **71/82**。残り赤11件は **①PDDP 5・②GAP 6 のみ**。
③④は緑。preflight は本スイート以外すべて緑。

## 記録：同じ型の欠陥が4回続いている（追記3時点）

第1回「API を作ったが製品が呼んでいない」→ 第2回「関数はあるが受信経路から呼ばれていない」→
第3回「呼出し件数で数えて定義行を含めていた」→ 第4回「reset を stale にだけ繋ぎ実切断分岐を外した」。
**いずれも『動くコードを書いたが、繋がっているかを検査していない』。**
今後 pit/Plan 系に触る時は、**分岐を名指しする配線検査を先に書く。**

**commit・Build・公開は提案しない。**

---

# 追記4 2026-09-06 — ① PDDP（Gate 4依頼）

正本: 共有ログ `2026-09-05 17:38 JST — Codex：Build 298実走事後Gate` §1 と「Build前の受入条件」表。
Founder 固定順序 ④→③→①→② のうち **①を完了**。②GAP は未着手。

## 1. 実走で何が起きていたか

17:49:42、`PDDP_BRIEFING {"available":true,"sample_size":10,"focus":"consistency"}` と共に:

```
八木さん、直近10レース、平均Incidents 1.7、最新iRating 2077。
今回の重点は完走順位のばらつき。次の1レースは同じ判断を再現するを一つだけ試そう。
```

同時刻 `MEMORY_BRIEFING` `DECISION_BRIEFING` `SETUP_MEMORY` はすべて `unavailable`。
**PDDPだけが別履歴から話し、採用10件のidentityも各incidents値も集計式もログに無い。**
添付2ファイルだけでは平均1.7を独立再計算できず、**監査不能＝製品として不合格**（Codexの判定）。
文面も86字で、「完走順位のばらつき」「同じ判断を再現する」は具体的な行動になっていない。

## 2. 変更箇所

### `desktop/pddp.js`

| 行 | 変更 |
|---|---|
| 35 | **新設** `DEFAULT_LIMIT = 5`。`analyze()` の既定母数を10→**5** |
| 78-104 | **新設** `briefingEvidence(rows, options)`。採用行の `subsession_id`/`date`/`incidents`、除外理由（`incidents_missing`）、`incident_sum`、`incident_average`、`prev_sample_size`、`prev_incident_average`、`incident_delta_vs_prev` |
| 56 | `analyze()` の戻り値へ `evidence` を同梱（`briefingLine` の比較材料・traceの出所を一本化） |
| 110-121 | `briefingLine()` を書き換え。**事実＋一行動**の一文。**悪化時のみ発話**、横ばい・改善・比較窓なしは空文字 |
| export | `briefingEvidence` を追加 |

発話例（新）:

```
ドライバー、直近5戦でインシデント3.4、前の5戦から+3.0。今回は接触を減らしてチェッカーまで。
```

### `desktop/renderer.html`

| 行 | 変更 |
|---|---|
| 5179 | `analyze(loadRaceHistory(),{limit:10})` → **`analyze(loadRaceHistory())`**。既定値5を使う |
| 5187-5193 | `PDDP_BRIEFING` trace へ `adopted` / `excluded` / `incident_sum` / `incident_average` / `prev_incident_average` / `incident_delta_vs_prev` を追加 |

### テスト

| ファイル | 変更 |
|---|---|
| `tests-build298-race-replay.js` | ①群を7→9検査へ。**配線検査3件を先に追加**（limit明示・trace根拠・母数一致） |
| `tests-pddp.js` | 旧契約を固定していた2箇所を新契約へ向け直し（§5）。**58/58** |

## 3. ★配線検査を先に書いたことで見つかった罠

`desktop/pddp.js` の既定値を5にしても、**製品は変わらなかった**。
`renderer.html:5179` が `{limit:10}` を**明示的に渡していた**からである。

④で4回続けた「動くコードを書いたが、繋がっているかを検査していない」への対処として、
今回は**モジュールを直す前に配線検査を書いた**。それが直接この罠を捕まえた。

## 4. 当方の欠陥3件（記録）

1. **偽の緑を1件作った。** 配線検査を `/PitwallPddp\.analyze\([^)]*limit:\s*10/` と書いたが、
   `[^)]*` は `loadRaceHistory()` の `)` を越えられず、`{limit:10}` を**検出できないまま緑**だった。
   呼出し位置から範囲を切り出す形へ修正。
2. **`sample_size < 3` の門が死んだコードだった。** 比較窓が無ければ `delta` が null になり
   既に黙るため、この門は到達しても意味を持たない。変異M3が素通りして判明し、削除した。
3. **横ばいの反例が「証拠不足」側で黙っていた。** 5件だけの入力では比較窓が無く、
   `delta<=0`（横ばい・改善）の分岐を**一度も通っていなかった**。10件の入力に変え、
   横ばい／改善／証拠不足の3ケースへ分離した。

さらに、`avg===null || delta===null` と `delta<=0` を別々の門にすると
**`null <= 0` が true のため後段が死ぬ**。`!(delta > 0)` の一つに統合した。

## 5. `tests-pddp.js` を書き換えた理由（弱めていない）

旧契約を固定していた2箇所が新契約と正面から衝突した。**削除ではなく向け直した。**

| 箇所 | 旧 | 新 |
|---|---|---|
| ⓪ 既存契約 | `briefingLine(s)` が `平均Incidents 6.3` を含む | 3件は**比較窓が無く証拠不足＝黙るのが正解**。平均値の検査は `briefingEvidence(rows).incident_average === 6.3` へ移動 |
| ① 既存API保持 | `/直近2レース/` かつ `/一つだけ試そう/` | 前5戦0.0→直近5戦4.0の**悪化入力**で「直近5戦・インシデント4.0・+4.0」「`一つだけ試そう` を含まない」「60字以内」を検査。加えて**横ばい・改善で黙る**ことも検査 |

検査の数は減らしていない（同ファイル 58/58）。

## 6. 変異試験

| 変異 | 結果 |
|---|---|
| `DEFAULT_LIMIT` を10へ戻す | ✅ 検出（replay −4、`tests-pddp` も赤） |
| 沈黙の門 `!(delta>0)` を外す | ✅ 検出（両スイート） |
| 製品が `{limit:10}` を渡す（実走の再現） | ✅ 検出（−1） |
| trace から `adopted` を落とす | ✅ 検出（−1） |
| 横ばい・改善でも喋る（強化前） | ❌→✅（反例を10件入力へ変えて検出） |
| 比較窓が無くても喋る（強化前） | ❌→門を統合し**死んだ分岐を消した** |

## 7. 現在地

`tests-build298-race-replay.js` **84/90**。**残り赤6件は ②GAP のみ**。①③④は緑。
`preflight.sh` は本スイート以外すべて緑。

## 8. 未確認・反証依頼

1. **「悪化時のみ発話」の妥当性は当方の判断であって検証ではない。** Codex の指示は
   「横ばい／改善／証拠不足なら無理に話さない」だが、**改善時に一言あるべきか**は決めていない。
2. **比較窓は「直前5戦」固定。** 5戦未満の履歴では PDDP が一切喋らなくなる。
   新規ドライバーの初期体験としてこれで良いかは未確認。
3. **`subsession_id` は `pw_raceHistory` に無い行がある**（旧レコード）。その場合 `adopted` の
   identity は `null` になる。trace の監査可能性がそこだけ落ちる。
4. 表示・音声・trace の母数一致は**同じ `_pddp.sample_size` を参照する**形にしたが、実機未確認。
5. Windows/Electron 実機、実TTS、iRacing 実走は未確認。

**commit・Build・公開は提案しない。次は②GAP（構造置き換え）。**

---

# 追記5 2026-09-06 — Codex ①PDDP 差戻し P1 2件への対応

差戻し元: 共有ログ `2026-09-06 JST — Codex：①PDDP 独立Gate 4（P1 2件・差戻し）`

Codex の独立反例:
- 直前5戦平均 0.0 → 直近5戦平均 0.2 **でも発話した**
- `subsession_id` が採用5件すべて null **でも「直近5戦、平均5.0」と発話した**

**2件とも正当。** 当方は Codex の「横ばい／改善／証拠不足なら話さない」だけを実装し、
**Founder が明示していた数値基準（直近5レース平均Incidents 5以上）を実装していなかった。**
identity についても、`briefingEvidence()` に `subsession_id` を**出力しただけ**で、
それが無い行を採用から外していなかった。「証拠を出す」と「証拠が無ければ黙る」は別物である。

## P1-1 発話閾値

| 項目 | 内容 |
|---|---|
| 修正 | `pddp.js:37` **新設** `SPEAK_INCIDENT_THRESHOLD = 5`／`:153` `avg < 閾値` なら沈黙 |
| 文言 | `:156` 「今回は**接触**を減らして」→「今回は**インシデント**を減らしてチェッカーまで。」（継続注意。Incidents はオフトラック・スピンも含む） |

反例（replay ①群へ追加）:

| 直前5戦 → 直近5戦 | 期待 |
|---|---|
| 0.0 → 0.2（微増） | 沈黙 |
| 0.0 → 4.0（大きな増加だが平均5未満） | 沈黙 |
| 2.0 → 5.0 | **発話** |
| 5.0 → 5.0（横ばい） | 沈黙 |
| 8.0 → 5.0（改善） | 沈黙 |

## P1-2 identity と窓の完全性

| 修正箇所 | 内容 |
|---|---|
| `pddp.js:123-131` **新設** `stableIdentity(row)` | `subsession_id` が正本 → `sub:<id>`。旧レコードは `recordedAt\|date\|track\|car` から `legacy:...`。**同日2レースを潰さないよう記録時刻・コース・車を混ぜる**。どれも無ければ **`null`＝採用しない**（推測でIDを作らない） |
| `:93` | identity が無い行を `reason:'identity_missing'` で除外 |
| `:106-115` | `windows_complete` を返す。**現在窓5件・比較窓5件がそろい、identity が一意**のときだけ true |
| `:147` | `windows_complete !== true` なら沈黙 |

追加した反例: identity 皆無 → 沈黙／旧レコードから一意 identity を5件生成できる → 発話可／
比較窓が3件しかない → 沈黙／現在窓に `incidents:null` が1件ある → 沈黙。

## 既存 `tests-pddp.js` をさらに2箇所直した（理由つき・弱めていない）

1. **⓪の fixture は `subsession_id` も `date` も持たない**ため、新契約では全件
   `identity_missing` で除外される。`briefingEvidence().incident_average === null` と
   除外理由3件を検査する形へ。**生の平均 6.3 は `analyze()` 側の既存アサーションが引き続き持つ。**
2. **①の悪化ケースは `row()` ヘルパーが同じ日付を返すため identity が衝突して沈黙していた。**
   日付・記録時刻を振り分けた。あわせて 0→4 は閾値未満になるため 2→6 へ変更し、
   新文言（`インシデントを減らして` を含み `接触を減らして` を含まない）も検査対象にした。

**58/58 を維持。** 検査数は減らしていない。

## 変異試験（6/6検出）

| 変異 | 結果 |
|---|---|
| 発話閾値5を外す | ✅ −2 |
| 閾値を0へ | ✅ −2 |
| 窓の完全性検査を外す | ✅ −1 |
| identity 欠損を採用する | ✅ 例外（両スイート赤） |
| 文言を「接触」へ戻す | ✅ 両スイート赤 |
| **identity を推測で捏造する**（`legacy:unknown`） | ✅ `tests-pddp` が赤 |

## 現在地

`tests-build298-race-replay.js` **96/102**。**残り赤6件は ②GAP のみ。**
`tests-pddp.js` 58/58、preflight は本スイート以外すべて緑。

## 未確認

- 10戦未満のドライバーは PDDP が一切喋らない。Codex の指示どおり今回は止めず、**別途UX判断として残す。**
- `legacy:` identity は `pw_raceHistory` の実データで一意になるか未確認（同日・同コース・同車で
  `recordedAt` も同一の行があれば衝突して沈黙する。壊れるのではなく黙る側へ倒してある）。
- Windows/Electron 実機、実TTS、iRacing 実走は未確認。

**commit・Build・公開は提案しない。次は②GAP（構造置き換え）。**

---

# 追記6 2026-09-06 — Codex ①PDDP 再差戻し（比較窓の identity 一意性）

差戻し元: 共有ログ `2026-09-06 JST — Codex：①PDDP P1再確認（P1 1件・再差戻し）`

Codex の独立反例:
> 比較窓5行を同一 `subsession_id=1`、現在窓を一意な5戦にすると `windows_complete=true` となり
> 「前の5戦から+3.0」と発話した。**実際の比較対象は1レースの重複である。**

**正当。** `identitiesUnique` を `adopted`（現在窓）だけで見ていた。
比較窓は「identity が5件ある」ことしか確認しておらず、**別レースかを見ていなかった。**
Codex の要点そのまま — **「5行ある」ではなく「異なる5レースを比較した」と証明できること。**

## 受入条件4項目への対応

| # | 受入条件 | 修正箇所 |
|---|---|---|
| 1 | 現在窓5＋比較窓5の**10件すべて**が一意なときだけ `windows_complete=true` | `pddp.js:113-116` — 両窓の identity を連結して `Set` で判定 |
| 2 | 比較窓内・現在窓内・窓を跨ぐ の3反例で沈黙 | replay へ3件追加（＋10件一意なら発話する対照も） |
| 3 | `subsession_id` 正本と `legacy:` の両方に同じ契約 | 一意性判定は `stableIdentity()` の戻り値に対して行うため両方に効く。`legacy` 側の反例（date/recordedAt を潰して重複）も追加 |
| 4 | 比較窓の identity と各 incidents を trace から再計算可能に | `pddp.js:` evidence へ **`previous`（identity/subsession_id/date/incidents）** と `prev_incident_sum` を追加。`renderer.html` の `PDDP_BRIEFING` へ `previous`・`prev_incident_sum`・`windows_complete` を出力 |

replay では `previous` の合計/5 が `prev_incident_average` と一致することまで検査している
（**平均だけ出して内訳が無い状態＝独立再計算できない、を再発させない**）。

## 変異試験（3/3検出）

| 変異 | 結果 |
|---|---|
| 一意性を現在窓だけに戻す（差戻し前の挙動） | ✅ −3 |
| evidence から `previous` を出さない | ✅ −1 |
| 製品 trace から `previous` を落とす | ✅ −1 |

## 現在地

`tests-build298-race-replay.js` **103/109**。**残り赤6件は ②GAP のみ。**
`tests-pddp.js` 58/58、preflight は本スイート以外すべて緑。

**commit・Build・公開は提案しない。①再Gate後に②GAPへ進む。**

---

# 追記7 2026-09-06 — ② GAP 構造置換（Gate 4依頼）★4系統すべて緑

Founder 指示: 「②は Build 297 方式への追加修正ではなく**構造の置き換え**で進めてください。
赤テストには少なくとも『初期本文とTTSだけが変わる旧方式では不合格』を含めます。」
Codex 事後Gate §2 の修正条件: `authority snapshot確定 → 最終本文1回生成 → 同じ本文を
Overlay・会話Box・TTSへ fan-out`。**表示後のTTS専用rebuildを禁止。**

## 1. 何を置き換えたか

| | 旧（Build 297 まで） | 新 |
|---|---|---|
| 候補時点 | 候補文を `addMsg` で**表示・Overlay・会話Box・履歴へ出す** | **何も出さない**（`deferredRender`） |
| TTS直前 | `GapFreshness` で作り替え、`finalizeUtterance(_,'rebuilt')` が表示/Overlay/箱を**後から直す** | **authority 確定点**で `buildGapUtterance()` が最終本文を1回生成 |
| 表示 | 一度出た文が書き換わる（一瞬ズレる） | 確定後に `addMsg` が chat / Overlay / 会話Box へ**同じ1本**を配る |
| 終端 | spoken / dropped / **rebuilt** | **spoken / dropped のみ**。`rebuilt` は廃止 |

**自発コール（`gap_trend` 等）と PTT回答（`nearest_gap` 等）の両方**を置換した。
Codex の条件は「全GAPについて」なので片方だけでは足りない。

## 2. 変更箇所

| 行 | 内容 |
|---|---|
| `renderer.html:1196` | **新設** `buildGapUtterance(authority)` — 最終本文の**唯一の生成点** |
| `:1240-1254` | `finalizeUtterance` から `rebuilt` 分岐を**削除**。`UTTERANCE_FINAL` へ `tts_text` / `overlay_text` / `box_text` / `chat_text` / `fanout_match` を出力 |
| `:1147` | **新設** `lunaTurnTextById()` — 会話Boxの本文を**箱側から**読む（fan-out の独立検証用） |
| `:2185` | `addMsg` が `div._ovlText` に Overlay へ渡した本文を残す |
| `:4878` | `injectRadio`：`_isGapCandidate` なら `addMsg` しない |
| `:2666` | PTT回答：`_ansIsGap` なら `addMsg` も `pushMsg` もしない |
| `:3579-3599` | `drainQueue` 自発分岐：authority から `_final` を1回生成 → `_it.text` → `deferredRender` なら `addMsg` で fan-out |
| `:3625-3640` | `drainQueue` 回答分岐：同上（`_ansFinal`、確定後に `pushMsg`） |

**trend の扱い**：`buildGapUtterance` は `trend.trend_snapshot_series === true` の時しか
変化量を語らない。実走の「1.6秒縮んだ」は**古い snapshot 間の差**で、作り直した値とは無関係だった。
現在の呼出しは `trend:null` を渡しており、**自発GAPは変化量を喋らない**。

## 3. ★危うかった点（自分で見つけた）

`rebuilt` 分岐と `overlayPush({update,text})` を消した時点で **replay は 119/119 全緑**になった。
しかし `drainQueue` はまだ `finalizeUtterance(_it,'rebuilt',…)` を呼んでおり、
**表示は候補文のまま・音声だけ最終本文**という、置換前より悪い状態だった。
テストが緑でも製品は壊れていた。構造置換の本体（deferredRender と fan-out）を入れて解消した。

## 4. 変異試験

最初の6変異のうち**2件が素通り**した。

| 変異 | 初回 | 対処後 |
|---|---|---|
| 候補を先に表示（自発・旧方式へ戻す） | ❌ 素通り | ✅ 検出 |
| 確定本文を使わず候補文のまま喋る | ❌ 素通り | ✅ 検出 |
| PTT回答も候補を先に表示 | ✅ | ✅ |
| PTT回答も候補文のまま喋る | — | ✅ 検出 |
| 確定後の fan-out を削除 | ✅ | ✅ |
| trend の snapshot 系列拘束を外す | ✅ | ✅ |

素通りした2件は、当方の②群が「旧方式が消えたか」しか見ておらず、
**「候補を表示していないか」「確定本文を喋っているか」を見ていなかった**ため。
4件の名指し検査を追加した（`_isGapCandidate ? null : addMsg` / `_ansIsGap ? null : addMsg` /
`_it.text = _final` / `_it.text = _ansFinal`）。**追加後は全変異を検出する。**

## 5. 既存2スイートを新契約へ書き換えた（弱めていない）

構造置換なので、旧 amend 契約を固定していた検査は正面から衝突する。**削除ではなく向け直した。**

### `tests-gap-answer-queue.js`（71/71）

| 旧 | 新 |
|---|---|
| 統合① 回答が queue に入り uid と**表示要素**を持つ | uid を持ち、`deferredRender===true` で**表示要素はまだ無い** |
| 統合② 候補が Overlay と会話Boxへ**出ている** | 候補は Overlay にも会話Boxにも**出ていない** |
| 統合⑥ stale discard で Overlay **から消える** | stale discard では Overlay に**一度も出ない**（旧契約は「一瞬出てから消える」挙動そのもの） |
| P1② rebuild は自分の履歴だけを直す | `rebuilt` 廃止の確認＋`spoken` が履歴を書き換えないこと |
| P1⑤ 出口が messageId を渡す | 非GAPは enqueue 時、**GAPは確定後に** `pushMsg` することを両方検査 |

追加: 統合③-d「確定後に表示要素・Overlay行・会話turnが作られる」。

### `tests-gap-display-sync.js`（63/63）

- 「rebuild が finalizer を通る」→ **「rebuilt が製品から消えている」＋「確定後に1回生成する」＋「確定後に fan-out する」**
- 分岐の数え上げから `GAP rebuild` 2件を削除し、`gap_no_text_from_authority`・
  `gap_answer_no_text_from_authority`（**authority から本文が作れない時の終端**）を追加
- 「rebuild で訳を無効化して渡す」→ 「Overlay 本文の後追い差し替えが製品に無い」。
  **`overlay.html` 側の世代ガードは残す**（翻訳は今も非同期で後から届く）

`tests-local-intent-router.js` は正規表現の走査窓を 350→700 へ広げただけ
（`speak()` の引数が増えたため。契約は変えていない）。

## 6. 結果

- `tests-build298-race-replay.js` **123/123**（①②③④すべて緑）
- `preflight.sh` **✅ 出荷可**（本スイート登録後、初めて全緑）

## 7. 未確認・反証依頼

1. **候補を表示しないことで、発話までの「間」が長く見える可能性。** 旧方式は候補が即出ていた。
   実走でどう感じるかは**未確認**。Overlay に出る時刻が TTS 開始と揃う設計に変えた。
2. **`fanout_match` は自己申告**である。同一プロセス内で3経路の文字列を比べているだけで、
   Overlay ウィンドウが実際に描画した内容は見ていない。画面録画での確認は未実施。
3. 自発GAPは現在 `trend:null` 固定＝**変化量を一切喋らない**。同一 snapshot 系列の trend を
   Bridge から渡す設計は入れていない。「接近／離脱が分からない」という既知の欠落は残る。
4. `rebuildAnswerText` は回答側の生成関数として使い続けている（名前が旧方式のままで紛らわしい）。
5. Windows/Electron 実機、実TTS、iRacing 実走は未確認。

**commit・Build・公開は提案しない。Founder の GO を待つ。**

---

# 追記8 2026-09-06 — Codex ②GAP 差戻し（`fanout_match` が会話Boxを読めない）

差戻し元: 共有ログ `2026-09-06 JST — Codex：② GAP 独立Gate 4（P1 1件・差戻し）`

## 指摘は正当

`conversation-memory-box.js` の実ターンは **`turn_id`** で保存され、`recordLunaTurn()` も
`turn_id` を返す。当方の `lunaTurnTextById()` は `box.turns.find(x => x.id === turnId)` と
**存在しないキー `id`** を引いていた。したがって `box_text` は常に空になり、
chat・Overlay・会話Box・TTS が実際には同文でも **`fanout_match=false`** を記録していた。

**当方の replay は trace 項目の「存在」しか見ておらず、値が正しいかを見ていなかった。**
「4出力一致を独立検証できる」と書いておきながら、その監査自体が常に不一致を返していた。

## 受入条件4項目への対応

| # | 受入条件 | 対応 |
|---|---|---|
| 1 | 正本キー `turn_id` で読む | `renderer.html:1150` を `x.turn_id===turnId` へ |
| 2 | 実 `conversation-memory-box.js` を使う統合検査で `fanout_match=true` と4本文一致を残す | `tests-gap-display-sync.js` の VM 統合へ追加。`lunaTurnTextById` を実物として読み込み、`diagnosticLog` を捕捉して `UTTERANCE_FINAL` の実値を検査 |
| 3 | 間に別のLuna発話が入っても `turn_id` を名指しして証明 | 「右に車。」を挟んだ2件で検査し、割込み側の turn も取り違えないことを確認 |
| 4 | 存在しない／drop済み turn では true を偽装しない | `fanout_match` を **`true` / `false` / `unverifiable`** の三値へ。`box_reason=no_display_element\|no_turn_id\|turn_not_in_box` を併記 |

## 変異試験でさらに1件、自分の穴が出た

| 変異 | 初回 | 対処後 |
|---|---|---|
| `turn_id` を `id` へ戻す（差戻し前） | ✅ 検出（−4） | ✅ |
| `box_reason` を出さない | ✅ 検出（−3） | ✅ |
| 検証不能でも `true` と書く | ✅ 検出（−1） | ✅ |
| **比較を潰して常に `true` と書く** | ❌ **素通り** | ✅ 検出（−1） |

一致ケースしか作っておらず、**実際に食い違った時に `false` になることを一度も検査していなかった**。
会話Boxだけを `amendLunaTurnById` でずらす不一致ケースを追加し、検出するようにした。

**加えて、変異の1回が置換失敗（Pythonの構文エラー）で no-op のまま「未検出」に見えた。**
適用件数を出して気づき、やり直した。**適用を確認せずに変異結果を報告しない。**

## 結果

- `tests-gap-display-sync.js` **70/70**（+7）
- `tests-build298-race-replay.js` **123/123**、`preflight.sh` ✅ 出荷可

## 未確認

`fanout_match` は同一プロセス内の文字列比較であり、**Overlay ウィンドウの実描画は見ていない**（不変）。
Windows/Electron 実機、実TTS、完成asar、iRacing 実走も未確認。
自発GAPの `trend:null` 固定と旧名 `rebuildAnswerText` は Codex の指示どおり本P1とは分離し後続判断。

**commit・Build・公開は提案しない。**
