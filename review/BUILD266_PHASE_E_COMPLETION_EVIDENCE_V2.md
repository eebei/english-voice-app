# Build 266 Phase E — 完了証拠 第2版

作成: 2026-08-12 / Claude Code
正本: [PITWALL_SHARED_WORKING_LOG.md](PITWALL_SHARED_WORKING_LOG.md) / [PITWALL_INTERNAL_SIMULATION_TEST_POLICY.md](PITWALL_INTERNAL_SIMULATION_TEST_POLICY.md)
brief: [BUILD266_PHASE_E_ADAPTIVE_RACE_INTELLIGENCE_BRIEF.md](BUILD266_PHASE_E_ADAPTIVE_RACE_INTELLIGENCE_BRIEF.md)

**commit / push / build / 公開は一切行っていない。** Yuji のレビュー待ちであり、Build 候補としての申請ではない。

## 差戻し項目の現況

| # | 項目 | 状態 |
|---|---|---|
| 1 | 任意修理の観測時刻 | Codex 承認済み（再レビューで確定） |
| 2 | 再計算が記録だけ | 実装済み・Plan B 再定義に追随済み |
| 3 | fuel/pace deviation の自動監視 | Codex 承認済み（#3a / #3b とも） |
| 4 | Plan C 未実装 | 実装済み・Plan A 基準へ組み替え済み |
| 5 | 日本語無線の未配線 | Codex 承認済み |
| 6 | 統合テストが Bridge 実行経路外 | **本書で対応** |
| 7 | 内部シミュレーション・原価ゲート未証明 | **本書で対応** |
| — | 八木さんログ由来5項目 | **本書で対応** |
| — | Plan B = 条件付きアンダーカット | 対応済み（[BUILD266_PLAN_ABC_UNIFIED_REVIEW_REQUEST.md](BUILD266_PLAN_ABC_UNIFIED_REVIEW_REQUEST.md)） |

---

## 差戻し#6 — Bridge poll loop の完全再生

### 何が足りなかったか

従来の統合テストは純関数を手で順番に呼ぶ擬似パイプラインで、`poll_iracing()` そのものを通していなかった。
配線が実際につながっているかは、静的なソース文字列一致でしか裏が取れていなかった。

### どう直したか

`irsdk-bridge/replay_harness.py` — **本番の `bridge.poll_iracing()` をそのまま回す**再生ハーネス。

差し替えるのは外界との境界だけである。

| 差し替え | 目的 |
|---|---|
| `reader` → `FakeReader`（`replay_harness.py:149`） | 保存フレームを1フレームずつ返す。`is_active()` が1周期に1回呼ばれるので、そこでカーソルを進める |
| `broadcast` → 収集器 | 送信の代わりに記録する |
| `log` → 収集器 | trace を検証可能にする |
| `time` → `_ReplayClock`（`replay_harness.py:226`） | 壁時計も再生する |

`while True:` の本番ループは、fixture が尽きた時に `FakeReader` が `ReplayComplete` を投げて止める。ループ構造は一切書き換えていない。

**仮想時計が必要だった理由**：bridge には `now - last_telem_ts > 3` のように実時間で間引かれるブロックがある。
時間を止めたまま回すと、本番なら毎秒走る経路が最初の1回しか走らず、再計算の実行ブロックへ到達しなかった。
フレームごとに時間を進めることで、ライブセッションと同じ頻度で回る。

### 通っている動線

`tests_bridge_poll_replay.py`（19テスト）が、保存フレームから次を一本の再生で確認する。

```text
接続 → session_info → クリーン周の確定 → baseline latch →
ボックス付近での接触（進入後に PitOptRepairLeft が立ち上がる）→
任意修理を取らずにピットアウト → damage_observation →
ドライバー申告（CMD キュー）→ 再計算 → active_plan 更新 → 無線 broadcast
```

主な確認項目：

- 進入時0 → ボックス内で14秒の任意修理を観測し、`on_pit_road=True` で初検出が記録される
- ピットアウトのライブ値0リセットの後も `optional_repair_outcome=not_taken` / `countdown_s=0.0` が残る
- `baseline_pace_s` が None で固定されない（Codex P1 #3a の回帰）
- 再計算がプラン結果まで到達する（`STRATEGY RECALCULATION OUTCOME` に `selected_plan` が載る）
- 「基準確定 → 損傷検出 → その損傷による再計算」の順序が一本のログで追える
- ドライバー申告が本番の `_queue_driver_damage_report()` から入り、無線に `selected_plan` が載って返る
- 未分類の申告も `unclassified` として trace され、無言で消えない

---

## 差戻し#7 — 内部シミュレーション・原価ゲートの計装

### 何が足りなかったか

「実APIを呼んでいない」ことは確認できても、正本が要求する
simulated / generated / played / deferred / discarded / wasted-generation cost の**計装そのもの**が無かった。

### どう直したか

`desktop/cost-meter.js` — 会計だけを行う module。発話するかどうかの判断にも、APIを呼ぶかどうかの判断にも一切関与しない。

正本が「別イベントとして記録・検証せよ」と指定した粒度（`desktop/cost-meter.js:34`）：

```text
generated / queued / tts_requested / deferred / played / completed / expired / discarded
```

renderer の各 seam から実際に報告させている（16箇所）。

| seam | 記録 |
|---|---|
| `/api/chat` 呼び出し | `generated` ＋ external Anthropic 呼出 |
| `speak()` / `speakReplyChunk()` | `queued` |
| dedupe 重複破棄 | `discarded reason=duplicate_dedupe_key` |
| キュー溢れ | `discarded reason=queue_overflow` |
| 後送り | `deferred` |
| 後送り上限 | `discarded reason=defer_cap_reached` |
| `/api/tts` 呼び出し | `tts_requested` ＋ external Google TTS 呼出 |
| 再生開始 | `played` |
| 再生完了 | `completed` |

**計装は機能依存にしていない。** 全ての呼び出しが `typeof costRecord==='function'&&…` で守られており、
meter が無い環境（既存のサンドボックス抽出テスト）でも発話経路は一切変わらない。

### 原価ゲートの出力（`node tests-cost-gate.js`）

縮約1レース（15生成・12再生・2後送り期限切れ・1破棄）のシミュレーション結果：

```text
COST GATE
external_anthropic_calls=0
external_google_stt_calls=0
external_google_tts_calls=0
simulated_api_calls=27
generated_replies=15
played_replies=12
deferred_replies=2
expired_or_discarded_replies=3
estimated_anthropic_cost_usd=0.10575
estimated_google_cost_usd=0.009216
wasted_generation_count=3
wasted_generation_cost_usd=0.02115
```

- **外部API呼出はすべて0。** 実外部呼出を1件でも検出したら `verdict.pass === false` になることをテストで確認している。
- 生成したのに一度も再生されなかった回答は `wasted_generation` として件数と原価が出る（不可視の無駄生成を可視化する、が正本の目的）。
- 無駄生成の上限を課して失敗させられることも確認済み。

**単価は見積もりであり、実測原価の断定ではない**（`desktop/cost-meter.js` の `RATES`）。変更時は出典を添える前提で置いてある。

---

## 八木さんログ由来の5項目

実測事実は 2026-08-11 17:09〜 の Barcelona / Ferrari 296 GT3 / Practice、路面約50.6℃・気温約30.7℃。

### 7-1 セットアップ相談を `weather_status` へ誤ルーティングしない

- `engineer-card.js:24` `HANDLING_SETUP_ADVICE` を新設。
- 「セットアップ」「セッティング」という語そのものは温度の質問ではありえないので、単独で weather に勝つ。
  「方向」「変えたい」「意見」等の弱い語は、ハンドリング症状と組み合わせた時だけ成立させる。
- `engineer-card.js:659` `buildHandlingSetupAdvice()` — brief 指定の順序で組む。
  ①実測の環境値を短く根拠として確認 ②症状と低速／中速／高速のどこで強いかを確認
  ③車種固有の未検証な数値を断定せず、試す方向を**最大二つ** ④次の走行で比較する観測項目を一つ指定。
- `server.js:975` — 相談は本来 Practice で起きる。race mode でしかカードを引かないと決定論ハンドラへ届かない。
  **race 以外で採用するのはセットアップ相談だけ**に限定し、燃料系ハンドラは従来どおり race 限定のままにした。

実際の出力：

```text
路面50.6℃、気温30.7℃。タイヤの垂れは低速・中速・高速のどこが強い？
車種ごとの正解値は断定できないから、試すならタイヤ内圧を少し下げて発熱を抑えるか、
ブレーキバイアスをわずかに後ろへ。次の走行では、コーナー脱出のスロットル開け始めの位置だけ比べて教えて。
```

温度そのものの質問（`路面温度は？` / `今の気温教えて` / `雨降ってきた？`）は従来どおり `weather_status` のまま。

### 7-2 曖昧なフォローアップが直前の相談を引き継ぐ

- `engineer-card.js:127` — 短く対象語を含まない問いだけを引き継ぎ対象にする。
  既存の引き継ぎ機構は race ゲートの中にあったが、相談は Practice で起きるのでゲートの外に置いた。
- 「どうしたらいいですか？」「どうすればいい？」「他に何かある？」「何か対策は？」が直前の相談（症状つき）を引き継ぐ。
- 直前が無関係なら引き継がない。長い新規質問（`…今のタイヤの状態を詳しく教えて`）は奪わない。

### 7-3 技術相談中にデブリーフを割り込ませない

- `desktop/renderer.html:4066` `markConsultationTurn()` / `:4069` `consultationInProgress()`。
- 相談だったという事実は**サーバが返した確定 intent**（`X-Pitwall-Intent`）で判断する。推測しない。
- 相談から90秒以内はデブリーフの開始も、デブリーフへの誘い自体も抑止し、理由を trace する
  （`DEBRIEF_SUPPRESSED` / `DEBRIEF_OFFER_SUPPRESSED` reason=consultation_in_progress）。

### 7-4 途中で切れる発話の禁止

- セットアップ相談の回答が終端記号で終わること、助詞で途切れていないことをテストで検証。
- 実走で出た破断（`次のピットで内。`）そのものを弾くチェックを入れてある。
- 日本語・英語の両方で確認。

### 7-5 同一 pit cycle の `limiter_off` は一回だけ

**再生で実走の二重発火を再現し、そのうえで直した。**

- 原因：発話経路が2つ（EngineWarnings のリミッタービット ON→OFF と、ピット退出フォールバック）あり、
  さらに OnPitRoad が一瞬 True へちらつくと進入ブロックが再武装して二度目が通っていた。
- `irsdk-bridge/bridge.py:4517` — 指示どおり **OnPitRoad の true→false を一意の発火条件**にした。
  リミッタービットは診断としてのみ記録し、発話しない（`LIMITER BIT DIAG`）。
- 再武装は「確定したピット訪問」だけが行う。`irsdk-bridge/bridge.py:2269` の
  `LIMITER_OFF_MIN_PIT_DWELL_S = 3.0` を満たすピットロード滞在があって初めて再武装する。
  進入ブロックでの無条件再武装は削除した。
- 抑止時は `LIMITER_OFF_SUPPRESSED reason=already_announced_for_pit_cycle` を残す。

**しきい値は再生で決めた。** 最初 1.0 秒にしていたが、再生した1フレームのちらつきを弾けず二重発火が再現した。
最短のドライブスルーでもピットロード上に数秒はいるため 3.0 秒とし、再生で単発になることを確認した。

---

## 変異試験

**9件すべて、実際に壊してテストが落ちることを確認済み**（確認後に復元）。

| # | 変異 | 検出 |
|---|---|---|
| 1 | poll loop 再生を素通しにする（本番ループを回さない） | ✅ |
| 2 | 無駄生成を数えない | ✅ |
| 3 | 外部呼出検出を失敗にしない | ✅ |
| 4 | 破棄理由を trace しない | ✅ |
| 5 | セットアップ相談を weather へ戻す | ✅ |
| 6 | 文脈を引き継がない | ✅ |
| 7 | デブリーフのゲートを外す | ✅ |
| 8 | ちらつきで再武装させる（dwell しきい値を下げる） | ✅ |
| 9 | リミッタービット経路の発話を復活させる | ✅ |

これまでの Build 266 作業分と合わせた変異試験は、累計 34 件すべて検出を確認している。

## 全体テスト結果

```bash
for t in irsdk-bridge/tests_*.py; do python3 "$t"; done   # 35スイート全green
for t in tests-*.js; do node "$t"; done                    # 47スイート・後述1件を除きgreen

python3 irsdk-bridge/tests_bridge_poll_replay.py           # 19 tests OK（新規・#6）
python3 irsdk-bridge/tests_strategy_reevaluation.py        # 39 tests OK
python3 irsdk-bridge/tests_bridge_recalculation_wiring.py  # 64 tests OK
python3 irsdk-bridge/tests_session_race_state.py           # 65 tests OK
node tests-cost-gate.js                                    # 35/35（新規・#7）
node tests-yagi-log-regressions.js                         # 39/39（新規・八木さんログ）
node tests-strategy-recalculation-jp-radio.js              # 39/39
```

### 契約変更に伴って更新したテスト（明記）

実装に合わせて緩めたのではなく、変わった契約の値へ置き換えた。

- `tests_strategy_options.py` — 新 A/B/C 契約へ全面書き換え。
- `tests_plan_fuel_authority.py` — Monza 35 参照ログ再生。Plan A の目標周が lap 14 → lap 15（A の定義が `latest_safe-1` から `latest_safe` へ移ったため）。
- `tests-engineer-card.js` — 無線文言を新契約へ。
- `tests_judge_llm_gate.py` — 正規表現の走査窓を 6000 → 8000（reset 経路が長くなり末尾へ届かなくなった。sig 経路側と同値）。
- `tests-fuel-authority.js` — 「非 race では燃料ハンドラへ到達しない」という**守るべき性質そのもの**を検証する形へ変更し、非 race で通すのがセットアップ相談だけであることを追加で検証するようにした（緩めていない）。

## 原価ゲート（正本 §Completion evidence）

| 項目 | 値 |
|---|---|
| 外部 Anthropic 呼出 | 0 |
| 外部 Google STT 呼出 | 0 |
| 外部 Google TTS 呼出 | 0 |
| simulated API calls | 27（縮約1レース分） |
| generated / played / deferred / expired・discarded | 15 / 12 / 2 / 3 |
| estimated Anthropic cost | $0.10575 |
| estimated Google cost | $0.009216 |
| wasted-generation | 3件 / $0.02115 |

実APIを使ったテストは**一件も無い**。再生ハーネスも cost meter もメモリ上の dict しか触らず、HTTP クライアントを import していない。

## 実走でしか確認できない項目（未確認・明記）

以下は再生でも計装でも代替できない。Yuji の実走確認が要る。

- 音声の自然さ、走行中の間合い（TTS の実レイテンシ）
- 実 iRacing テレメトリとの接続（`FakeReader` は保存フレームであって実 SDK ではない）
- セットアップ相談の回答が、実際のドライバーにとって役に立つ内容か
- `LIMITER_OFF_MIN_PIT_DWELL_S = 3.0` が実レースのピット滞在時間に対して妥当か
- Plan B / Plan C が実レースの状況で妥当なタイミングに出るか

## 既存の失敗（今回の変更とは無関係・触っていない）

`tests-five-day-access.js` が失敗する。`applyPitwallAccess(...)` の出現数が10で期待値7と合わない。
現HEAD（`da0c4a3`）でも同じ失敗が再現する。課金・認証まわりのため独断で触っていない。

なお `da0c4a3` の「通常5日無料trial」は、採用済みの商用方針（無料5日を廃止し有料 Starter Pass を入口にする）と矛盾するため使っていない。
**今回の作業では `auth.js`・決済・利用権・公開ページに一切触れていない。**

## commit / push / build / 公開

一切行っていない。作業ツリーの未コミット変更として存在する。
