# PITWALL Shared Working Log

Status: Yuji ↔ Codex ↔ Claude Code の作業共有用正本  
更新者: Yuji またはCodex  
運用開始: 2026-08-12

## 使い方

YujiはClaudeへ長文を転記しない。**YujiはClaude CodeとCodexの伝書鳩ではない。** 実装者と確認者の連絡・証拠・差戻しはこの共有ログだけで完結させる。Yujiが判断するのはscope、優先順位、Build / 公開GOだけである。

- Claude Codeは、実装開始・変更・テスト・未確認をこの文書の`Claude Code 実装報告`へ記す。
- Codexは、その報告と実際のdiffを自分で読み、同じ文書へ独立確認・差戻し・承認条件を書く。
- Yujiは結果の転記、テスト出力の説明、両者への質問の中継をしない。Yujiが「次」または「確認」と言えば、Codexが正本を確認して次の判定を進める。

Claudeを明示的に再開させる必要がある時も、Yujiは次の一文だけ伝える。

```text
2026-08-12 08:21 JST。review/PITWALL_SHARED_WORKING_LOG.md を更新した。作業前に必ず全文を確認して、現行の指示と差戻しを反映して。
```

Claude Codeは作業前に必ず、この文書と次を全文確認する。

- `review/PITWALL_INTERNAL_SIMULATION_TEST_POLICY.md`（内部シミュレーション・原価ゲートの正本）
- `review/PITWALL_RELEASE_GATE.md`（Build・出荷・公開の正本。作業者と確認者を分離する）
- 該当Buildのbrief／completion evidence

Claude Codeは実装後、この文書を勝手に「完了」へ書き換えない。変更ファイル、テスト、未完了、commit/build/publicの未実施を `Claude Code 実装報告` に追記し、Codexレビューを待つ。

## 絶対ルール

- commit / push / build / 公開はYujiの明示GOまでしない。
- 実装、ローカルテスト、配布、Windows取得、実走は別の証拠として扱う。
- LLMに燃料、残周回、損傷部位、復帰順位を推測させない。Bridgeの決定論的状態を権威とする。
- 通常テストでAnthropic、Google STT、Google TTSの実APIを呼ばない。詳細は内部シミュレーション正本に従う。
- 保存だけでは学習完了ではない。`申告 → 状態 → Plan → handler → 無線 → 結果保存` のtraceを要求する。
- `preflight成功`だけでは出荷可にしない。完成installerの`app.asar`、同梱Bridge、Windows旧版更新、本番server SHA、公開取得物を`review/PITWALL_RELEASE_GATE.md`に従って別々に検査する。

## 2026-08-25 12:33 JST Yuji配置変更・即時作業指示

**Claude Codeが実装担当、Codexが独立確認担当。** 作業開始前に`AGENTS.md`→`HANDOFF.md`→`review/MEMORY_TO_STRATEGY_SHARED_UNDERSTANDING_V1.md`17節→関連コードの順で全文確認する。

Yuji恒久ルールは**「トンネルに入口があるなら、出口を必ず作る」**。保存、handler、注入、テストの一部だけを作って完了にしない。`source → authority → state/persistence → retrieval/identity → decision → radio/UI/briefing → outcome/scoring → correction/delete/reset → proof`を一つの完成単位として接続する。入口→出口マトリクスに空欄がある場合は実装済みと報告しない。

今回Claude Codeが実装する統合scope:

1. Build 282のpackage/GAP/fuel/hazard/session-state修正を回帰基盤として保持する。
2. 過去天候を実測要約として保存し、同一driver/car/track/session/日時で取得し、質問回答と次回briefing/setup協議へ出す。現在値を過去値として代用しない。
3. setup fingerprint/versionと本人申告変更を、変更前後のvalid lap・fuel・tyre/handling・天候へ結び、次回Practiceの比較・提案・訂正まで出す。取得不能なsetup数値は推測しない。
4. Decision IDを提案→pit cycle→blend→session終了→成功/失敗/途中終了採点→次回自発発話→当日Plan採用→今回再採点まで繋ぐ。成功例だけでなく失敗例と異議訂正も使う。
5. server canonical、auth分離、local cache、privacy/terms、表示・訂正・削除・保持期間を同scopeで閉じる。

禁止事項:

- 過去天候だけの単独patch、setup保存だけ、Decision ID保存だけで完了報告しない。
- LLMに数値・事実・対象record・採用戦略を選ばせない。
- source直テストだけでradio/briefing/package/Windows/実走成功とみなさない。
- 新しい重複仕様書を作らない。正本17節と本共有ログを更新する。
- この指示単独ではcommit / push / build / deploy / 公開を行わない。各工程はYujiの明示GOを待つ。

Claude Codeの報告後、Codexは4本の入口→出口を出力側から逆引きし、欠損、stale cache、別identity、失敗例、訂正後再利用、package欠落を独立に反証する。

## 2026-08-24 Build 281実走後の最優先

### 2026-08-25 Build 282 artifact記録の無効化 — Gate 5やり直し

Build 282 artifactに関する従来の記録は証拠として無効。Gate 5は**未通過**へ戻す。過去artifact、過去SHA、過去hash、旧`desktop/dist`を次候補のpackage合格証拠として再利用しない。

**2026-08-25再訂正**：スライス1が入った現HEADを同じBuild 282としてprivate buildしてしまったが、番号衝突のため配布不可。実体検査（installer展開、`app.asar`、Bridge、renderer参照module、SHA-256）は完了しているが、これはGate 5合格証拠に使わない。製品Build番号を**283**へ上げ、Build 283のprivate candidateを新規生成・検査する。

次のYuji明示Build GO後だけ、現HEADから`publish=false`のprivate candidateを新規生成する。Codexは完成installer、`app.asar`のrenderer参照runtime全件（`session-memory.js`を含む）、同梱Bridge、bytes、SHA-256、workflow SHAを実物で検査する。公開・配布・Windows field testは別Gateであり、この記録だけでは行わない。

- Build 281では、Bridgeに`gapBehind`が届きデブリーフでも参照できた一方、Windows installerへ`local-intent-router.js`が同梱されず、ライブ後方GAP質問がno-dataへ落ちた。`fuel-plan-guard.js`も同じpackage指定漏れだった。
- ソース直接テストと`preflight.sh`は合格していたが、完成`app.asar`を検査していなかった。これは出荷ゲートの欠陥であり、保存・計算・デブリーフ成功をライブ発話成功とみなしてはならない。
- Codexがpackage指定、完成asar検査、runtime欠落診断、後方GAPの実走文言回帰、過去天候の現在値代用禁止を修正中。commit / build / 公開は未実施。
- 次のBuildは`review/PITWALL_RELEASE_GATE.md`の署名欄を、作業者と別の確認者が埋めるまで出荷不可。Claude CodeはCodex実装の独立確認者として、差分だけでなくprivate candidate artifactを確認する。

## 2026-08-25 Claude Code — スライス1（A/B/C）実装完了報告

範囲は Yuji 指定どおり **A/B/C のみ**。Decision ID（D）、サーバー正本（E）、訂正・削除（F）には手をつけていない。
**commit / push / build / deploy / 公開はすべて未実施。**

### 変更ファイル（完全diff）

| ファイル | 内容 |
|---|---|
| `irsdk-bridge/bridge.py` | スタート順位の捕捉、天候の保持、setup_fingerprint / series_id の取得、両session_summaryへの搭載、両リセット経路 |
| `desktop/session-memory.js` | **新規**。決定論的な取得層（数字を持つ唯一の場所） |
| `desktop/renderer.html` | script tag、`currentMemoryIdentity()`、過去天候の決定論回答、ブリーフィングへの確定事実注入、trace |
| `tests-session-memory-tunnel.js` | **新規**。入口→出口の一本証明 59ケース |
| `preflight.sh` | 上記を出荷ゲートへ収録 |

### 状態遷移

```
[session開始]        race_start_class_pos = None / last_weather = None
     ↓ SessionInfo   session_setup_fingerprint, session_series_id ← Bridge が既に計算していた値
     ↓ 毎フレーム     last_weather ← weather（実測）
     ↓ cur_ss 3→4    race_start_class_pos ← class_pos（**この瞬間しか取れない**・一度だけ・logに残す）
     ↓ session終了    session_summary へ4項目を搭載（**両方の生成箇所**）
     ↓ renderer      pw_raceHistory へ保存（Bridge由来のみ・欠けたらnull・推測で埋めない）
     ↓ 翌セッション   selectPrevious(identity) で同一条件の最新1件だけ選択
     ↓ 出口①        過去天候の質問 → 決定論回答（LLMより前）
     ↓ 出口②        ブリーフィング → briefingLine() の確定文を注入
[session境界]        _reset と _sig_reset の**両方**で全変数を破棄
```

### 入口→出口 trace（テストが実際に出力）

```
bridge_summary:     start=8 finish=4 track_temp=41.2
stored:             startPos=8 trackTempC=41.2
retrieved:          2026-08-24@Okayama
spoken:             前回2026-08-24のOkayamaは8番手スタートで4位、路面41.2℃。
asked_past_weather: historical_weather -> 2026-08-24のOkayamaは路面41.2℃、気温29.8℃。
```

**北極星の骨格が自発発話として出る。** 別コースでは `spoken` が空＝**言わない**ことも同trace内で反証済み。

### 実測から分かったこと

**新規計測は A（スタート順位）だけ。** B（天候）と C（setup/series）は Bridge が既に計算しており、
`session_summary` へ渡していなかっただけだった。`setup_fingerprint` は `bridge.py:1848`、
`series_id` は `bridge.py:1870` に以前から存在する。

### Build 281 の教訓の適用

新設した4変数すべてを共通リセット辞書へ入れ、`_reset` と `_sig_reset` の**両方**から読む。
`pit_events` が片系統だけだった欠陥（Claude が P1-2 として指摘）と同じ穴を作らないため。
**Codex が同指摘を規約どおり修正済み**（`_session_scoped_reset_values()` へ集約）だったので、その規約に合わせた。
変異試験 T4 で「片方だけ消さない」が検出されることを確認済み。

### 決定論であることの担保

- 数字を持つのは `session-memory.js` **だけ**。LLM は記録も数字も選ばない
- 記録が無ければ `briefingLine()` は**空文字＝言わない**（捏造しない）
- 過去天候は**LLMより先**に答え、記録が無ければ「無い」と言う。**現在値を代用しない**（Build 281 実走欠陥の再発防止）
- identity は **Bridge権威だけ**で作る（`lastSessionAuthority` 由来。会話・推測から作らない）
- `SESSION_MEMORY` / `MEMORY_BRIEFING` trace で**黙った理由が必ず残る**（`module_missing` を通常の未処理と区別）

### 検証

| 項目 | 結果 |
|---|---|
| `tests-session-memory-tunnel.js` | **72/72**（preflightへ収録） |
| JS 全スイープ | ✅ 全緑 |
| Python | ✅ 264 passed |
| `./preflight.sh` | ✅ 出荷可 |
| `git diff --check` | ✅ |
| 外部有料API呼出 | **0件** |

変異試験 **14件すべて検出**：現在値代用へ戻す／別トラック流用／summaryへ載せない／sig_resetで消さない／
記録なしでも喋る／決定論回答をLLMより後ろへ／script tagを外す／**発話せずに終わる（queueへ入らない）**／
**優先度を暗黙のP4へ戻す**／別認証ユーザー／車種欠損／series欠損／90日超過／未来日時。

**13:21 GO の受入条件「queue→実発話または明示的破棄」への対応**：初版は発話文の生成と `speak()` 呼び出しまでしか
証明しておらず、**queue段が抜けていた**。決定論回答を `speak(text, {prio:SPEAK_PRIO.P2_PROCEDURE, kind:'reply'})` と
明示して投入する形へ変更し、暗黙の `P4_INFO` へ落ちないようにした。Codex独立確認で、次回ブリーフィングの記憶も
LLMへの注入だけでは出口未接続と判断し、`memory_strategy_briefing`として先に直接queueへ投入、LLMは数字を言い直さない
契約へ修正した。queue投入後の fate
（`queued` → `played` / `deferred` / `discarded`＋理由）は既存 speech queue 契約が持つため、
**独自queueを作らずその契約に乗っていること**を検査項目として追加した（`costRecord` / `speechLatencyTrace` の両方）。

### 未確認（field evidence）

- **Windows実機・iRacing実走とも未実施。** スタート順位の捕捉は `cur_ss 3→4` 遷移に依存するため、
  ローリングスタート／スタンディング／セーフティカー先導での実挙動は**実走でしか確認できない**。
- `session-memory.js` は renderer が参照するため、次Buildで**完成asar検査の自動対象**になる（変異試験T7で確認）。
- サーバー側は未変更のため `./verify-deploy.sh` の対象外。

### Codex への確認依頼（17節の逆引き）

出口から source へ逆向きに、次を反証してほしい。

1. 別session・別car・別series・古いcacheの記録が発話へ混入しないか
2. `cur_ss 3→4` 以外の開始形態（既に走行中に接続、リジョイン、セッション再開）でスタート順位が誤らないか
3. `last_weather` が前セッションの値を今回の条件として運ばないか（両リセット経路）
4. 記録が欠損している時に、LLM側が数字を補完して喋る余地が残っていないか

## 2026-08-25 Claude Code — Tunnel Completion Rule 入口→出口マトリクス（実装前・実態調査結果）

17節の指示どおり、コードを書く前に**現行実装の実測**でマトリクスを埋めた。`Tunnel Completion Rule` は
「実装前に入口→出口マトリクスを作り、空欄が一つでもあれば未完成として扱う」と定めているため、
共通契約を決める前の着手は禁止されている片道patchになる。

### 実測サマリ（すべてコードで確認）

**既存の永続ストア（localStorage 17キー）**
`pw_raceHistory`（レース結果11項目）／`pw_ctmem`（コース×車種のベスト・燃費）／`pw_session_evidence`（デブリーフ証拠）／
`pw_profile_*`／`pw_contract`／`pw_chief_*`（耐久relay）／認証・UI設定系。

**サーバー側の記憶API**：`/api/memory/import-seeds` と `/ack` の**2本のみ**。
いずれも**サーバー→利用者へ配る**方向で、**利用者データを預かる方向は存在しない**。

**Bridge が既に持っている identity**
- `setup_fingerprint`（`bridge.py:1848` SHA-256 先頭16桁）— **setup進化の source は既に存在する**
- `series_id`（`bridge.py:1870`）— **series 識別は既に取れる**
- `track` / `car_class` / `car_model` / `session_num`（`bridge.py:2931-2933`）

**`session_summary` が現在運んでいるもの**
`is_race, total_laps, finish_pos, finish_pos_confirmed, best_lap, worst_lap, avg_lap, avg_fuel_per_lap,
pace_first_half, pace_last_half, incidents, laps, pit_events`

### 空欄（＝これが埋まるまで未完成）

| # | 欠落 | 影響する行 | 現状 |
|---|---|---|---|
| A | **スタート順位を誰も記録していない** | Memory→Strategy | `start_pos` / `grid_pos` 相当が Bridge に**存在しない**。北極星の「8位からスタート」が言えない。捕捉時点は `session_racing_started`（`bridge.py:825`）が使える |
| B | **`session_summary` に天候が入っていない** | 過去天候 | `weather` は telemetry として毎フレーム broadcast されるが（`bridge.py:6395`）、**セッション記録には残らない**。だから「昨日の路面温度」に答える材料が無い |
| C | **`session_summary` に `setup_fingerprint` / `series_id` が入っていない** | setup進化 / Memory→Strategy | Bridge は持っているのに**サマリへ渡していない**。同一setupの前後比較ができない |
| D | **Decision ID が存在しない** | Memory→Strategy | 提案・予測・実結果を貫くIDが無い。`score_execution()` は採点しているが broadcast して捨てている（`bridge.py:5018`） |
| E | **サーバー正本が存在しない** | 全行 | 預かる方向のAPIもschemaも認証付きCRUDも無い。**新規設計が必要** |
| F | **訂正・削除の経路が存在しない** | 全行 | `disputed` / supersede / 削除のrecordも導線も無い |

### 共通契約（4行が共有すべき単一の identity）

17節が禁じる「別々の片道patch」を避けるため、4行すべてがこの identity を使う。

```
memory_identity = {
  user_id      : 認証ユーザー（サーバー正本の分離キー）
  series_id    : bridge.py:1870（既存）
  track        : 既存
  car_model    : 既存
  setup_fingerprint : bridge.py:1848（既存）
  session_num  : 既存
  recorded_at  : 日時
}
```

**A / B / C は「新規計測」ではなく「既にある値をサマリへ渡す」だけ。** D / E / F が新規実装。

### 実装順序の提案（各段が単独で入口→出口を閉じる）

1. **スライス1：identity と欠落フィールドを `session_summary` へ通す**（A・B・C）
   source（Bridge既存値）→ 権威（Bridgeが唯一の出所）→ 保存（`pw_raceHistory` 拡張）→
   取得（`buildPreviousRaceBriefingNote` が読む）→ 出口（**前回天候・setup・スタート順位を答える**）→
   証拠（fixture 再生 + E2E trace）。
   **これ単独で「昨日の路面温度」に根拠付きで答えられるようになり、過去天候の行が閉じる。**

2. **スライス2：Decision ID と結果採点**（D）
   `score_execution()` の出口を繋ぎ、成功・失敗・途中終了を同じIDへ追記する。

3. **スライス3：サーバー正本と訂正・削除**（E・F）
   privacy / terms / 表示・訂正・削除・保持期間を同scope。**公開済みの
   `Telemetry never leaves your machine` の改定が必須**（13節）。

### 着手前に Yuji の判断が要る点

- **スライス3のプライバシー文言改定**は公開ページの変更であり、`PITWALL_RELEASE_GATE.md` Gate 7 の対象。
  実装は進められるが、**文言案の承認なしに公開ページを確定させない**。
- スライス1→3の順で進めてよいか。1だけでも過去天候の行は閉じるため、**空欄を残したまま次へ行かない**方針には合致する。

commit / push / build / deploy / 公開は未実施。Build 282 は Gate 5 合格（Codex確認待ち）。

## 2026-08-25 Claude Code — **Build前最終確認：Gate 5 の証拠が HEAD と一致しない（進行停止事項）**

作業者 Codex（`bb5e9cf`）／確認者 Claude Code。機械検証は全て緑だが、**Gate 5 の合格証拠が現在のコードに対するものではない**。

### 事実（実物で確認）

```
Gate 5 で合格を出した installer : 7bc5cb8 由来
  artifact  OMORAY-PITWALL-Desktop-Build-282-20260825-0022
  SHA-256   880a98b34931155684566b692bfd8ca80f6c2c5d2e88c41444046da160933d8a

その installer の app.asar 内 JS（実際に展開して列挙）:
  cost-meter.js / fuel-plan-guard.js / local-intent-router.js
  main.js / memory-action-layer.js / preload.js / strategy-playbook.js
  ← **session-memory.js が無い**

現在の renderer が要求するモジュール: 上記5本 + session-memory.js

現在のコード基準で同じ installer を検査した結果:
  ❌ missing packaged runtime modules: session-memory.js
```

`7bc5cb8 → bb5e9cf` の差分は `desktop/renderer.html +83` / `desktop/session-memory.js +156（新規）` / `irsdk-bridge/bridge.py +37`。

**判定が誤っていたのではない。** `7bc5cb8` 時点では正しかった。その後スライス1が入り、**証拠だけが古くなった**。

### なぜ危険か — Build 281 と同じ形

| | Build 281 | 今回 |
|---|---|---|
| ソース | ✅ 正しい | ✅ 正しい |
| テスト | ✅ 緑 | ✅ 緑 |
| **届く物** | ❌ module 欠落 | ❌ **module が入る前の版** |

Build 281 は「packageへ入れ忘れた」、今回は「**入れた後にビルドし直していない**」。
症状は同じで、**テスターの手元には記憶機能が1行も無い installer が届く**。

さらに悪いのは、この installer は**正常に起動し、GAP も燃料も動く**こと。
動かないのは記憶機能だけで、それは「**Luna が昨日の話をしない**」という形でしか現れない。
＝**Yuji が1ヶ月待った症状とまったく同じ見え方になる。**

`HANDOFF.md` には「Build 282 / SHA-256 `880a98b3...` / Gate 5 合格」が記録済みで、
**その記録だけを見ると出荷可能に見える**。古い証拠を残したまま進むのが最も危険。

### 機械検証（Claude Code が独立実行・すべて緑）

| 項目 | 結果 |
|---|---|
| JS 全スイープ | ✅ 全緑 |
| Python | ✅ 264 passed |
| `tests-session-memory-tunnel.js` | **72/72**（Codex が9件追加） |
| `tests_bridge_poll_replay.py` | ✅ 19 tests（poll loop 実再生） |
| `./preflight.sh` | ✅ 出荷可 |
| `git diff --check` | ✅ |
| 変異試験 | **7/7 検出** |
| renderer 参照JSの package 対象 | **6/6**（`session-memory.js` 含む） |

### 内部テスト（静的検査ではなく実挙動）

Bridge のリセット辞書を実際に呼び出し：
`race_start_class_pos=None / session_setup_fingerprint='' / session_series_id=None / last_weather=None / pit_events=[]`
→ 既定値は全て「事実なし」。前回値を引き継がない。

1レース→翌日を実際に流した：
```
発話    : 前回2026-08-24のOkayamaは8番手スタートで4位、路面41.2℃。
過去天候 : 2026-08-24のOkayamaは路面41.2℃、気温29.8℃。
```

漏洩の反証を実際に流した（数値 41.2 / 29.8 / 8番手 / 4位 が一切出ないこと）：
```
✅ 別コース(Monza) → briefing=(無言) / historical_weather_unavailable
✅ 別シリーズ      → briefing=(無言) / historical_weather_unavailable
✅ 記録ゼロ        → briefing=(無言) / historical_weather_unavailable
```

### Yuji の逆引き5項目

| 項目 | 結果 |
|---|---|
| identity漏れ | ✅ 実測で漏洩なし。`lastSessionAuthority` 由来のみ |
| 別コース混入 | ✅ 実測で無言。変異でも検出 |
| 記録なし | ✅ 数字を一切含まず「無い」と言う |
| package欠落 | ✅ 追跡済み・6/6対象。欠ければ build が止まる（実証済み） |
| queue未再生 | ✅ `speak()` 明示投入。`dedupeKey` は**キュー内のみ**の判定（`renderer.html:2782`）で、再生後は再度発話される＝恒久抑止ではない |

### Codex が Claude の弱点を閉じた点（記録）

Claude が「最も弱い」と自己申告した「**ブリーフィングが最終的に LLM 経由**」を Codex が解消した。
`memory_strategy_briefing` として**決定論 queue へ直接投入**し、LLM へは「数字を言い直すな」と指示する形。
**Claude の実装より上。** Codex が正本12節で提案した「決定論カード＋queue fate」の設計どおり。

### Yuji 判断待ち（2点）

1. **Build 番号**：`BUILD_VERSION` は 282 のまま。このまま build すると**中身の違う2つの artifact が同じ「Build 282」を名乗る**。
   7bc5cb8 の 282 は未公開だが `HANDOFF.md` に hash が記録済み。**283 へ上げるのが安全**というのが Claude の意見。
2. **push GO**：現在 `origin/main` は `7bc5cb8`、ローカルは 4コミット先行。CI は push された commit を見るため、build には push が前提。

### 再実施が必要な手順

1. push
2. Build 番号の確定
3. 新 candidate を `publish=false` で生成
4. Claude Code が実物を展開し、**`session-memory.js` の存在を app.asar 内で確認**
5. `HANDOFF.md` の Build 282 / `880a98b3...` の記録を**無効化または上書き**（古い証拠を残さない）

**Gate 5 は未合格として扱う。commit 済み・push / build / deploy / 公開はすべて未実施。**

### 2026-08-25 13:21 JST Yuji決定 — スライス1（A・B・C）着手GO

Claude Codeはスライス1だけに着手してよい。対象は、Bridge既存値を`session_summary`から`pw_raceHistory`へ通し、同一identityで過去天候・setup・スタート順位を取得して、質問回答および次回briefingへ**決定論的に出す**経路である。

- fixtureとE2E traceで、source→保存→取得→handler/briefing→queue→実発話または明示的破棄までを証明する。
- `current value`を過去値として代用しない。setup数値の推測もしない。
- スライス2以降、commit / push / build / deploy / 公開には進まない。
- CodexはBuild 282 Gate 5とスライス1の出口から入口への独立確認を並行して行う。

## 2026-08-25 記憶→戦略 共有認識 V1（Claude Code ↔ Codex 突き合わせ）

正本: [MEMORY_TO_STRATEGY_SHARED_UNDERSTANDING_V1.md](MEMORY_TO_STRATEGY_SHARED_UNDERSTANDING_V1.md)

Yuji が同一質問を両者へ**独立に**投げ、回答を突き合わせた記録。目的は**共有認識度を上げて開発速度を上げること**と**最終Buildでの作業漏れを無くすこと**。割れた項目は Yuji が決める。

**北極星**：Luna が「昨日は8番手スタート、6周目にアンダーカット、ブレンドでP4」と**自分から言い**、それを**今日の Plan へ渡す**。
前提の訂正：Claude Code の記憶は学習ではなく「①書く ②索引を読む ③引く ④訂正される」だけ＝**特別な技術ではなく配管**。PITWALL でも再現できる。

**両者一致（事実確定・議論再開しない）**
1. 過去レースをブリーフィングへ渡す仕組みは**存在する**（`renderer.html:4214`）
2. 発動条件3つ：`selMode==='strategy'`（**走行中は発動しない**）／`lastTrack` 確定／同コース記録あり
3. `pw_raceHistory` は11項目のみ（`date, track, car, carClass, bestLap, avgLap, totalLaps, incidents, finishPos, irating, sr`）
4. **スタート順位・判断時点・戦略・予測・実際の復帰順位は1つも保存されていない**
5. **5番（Character）より4番（Memory→Strategy）が先**という Yuji の順序認識は正しい

**Codex が正確だった点**：ブリーフィングは**リクエストが出るだけ**で、過去の話が出るかは LLM 次第＝**必ず出る決定論的契約になっていない**。Claude Code はここを言い落としていた。「聞いたことがない」理由は**材料が薄い＋出る保証が無い**の合わせ技。

**Claude Code しか指摘していない点（実装量の見積もりが変わる）**
- `score_execution()`（`bridge.py:5018`）は**採点済みで捨てている**＝新規実装ではなく出口を繋ぐ話
- `pit_loss_calibrator`（`bridge.py:5022`）は**既に学習・永続化している唯一の前例**＝4番は新発明ではない
- `pit_events` は Build 281 で Bridge 側に実装済み＝`pw_raceHistory` へ流れていないだけ

**食い違いに見えたが両方正しかった点**：キャラ差は `prompts.js` **26箇所**、`engineer-card.js` **0箇所**、`bridge.py` **0箇所**。
＝**キャラクターは LLM が喋る時だけ効き、決定論経路（安全・GAP・燃料）は全キャラ一字一句同じ**。Codexの診断と同じものを別表現で見ていた。

**Codex の提案が優れている点**：**Decision ID** で保存・採点・翌日選択を1本で貫く／条件が揃わなければ再提案せず「今回は未成立」と言う fail-closed。

**合意した実装方針（Memory Action Layer 実戦版 v1）**：Codex案に上記3点を統合。既存の `pit_events` / `score_execution` を使い新規計測を作らない。`pit_loss_calibrator` の形に倣う。
**完成条件：「保存済み」では合格にしない。翌セッションでの自発発話と根拠traceまで。**

**進め方（両者一致）**：Build 282 の配布検査を通した次の最優先を v1 に絞る。Build 282 は Gate 4 通過・P0/P1 0件で、残る Gate 5〜9 は Yuji の手が必要な部分。

**突き合わせ運用の作法（今回確立）**：①同一質問を独立に投げる ②事実と見解を分ける ③**事実が食い違った点だけ**をコードで再検証させる ④見解が割れたら Yuji が決める。
理由＝先に相手の結論を読むと引きずられるため、**根拠を先に固定してから照合する**。今回 Claude Code は Codex の回答を見る前に9項目を確定させてから照合した。

**2026-08-25 Codex回覧完了**：中心設計に異論なし。正本の12節へ、実装漏れ防止として次を追加した。

- Decision IDは完走時だけでなく、提案→pit exit→blend安定→session終了の各段階で追記する。DNF・切断・途中終了でも判断材料を失わない。
- 戦略事実は全キャラクター・全PCで共有する。Codex推奨は認証ユーザー単位のサーバー正本＋ローカルcache。
- 次回の自発発話はLLMの自由選択にせず、`memory_strategy_briefing`決定論カードとqueue fate traceで保証する。
- 保存→翌日選択→自発発話→条件成立後のPlan利用→今回結果採点を一本のfixtureで検証する。

中心設計でClaude CodeとCodexの対立はない。Yuji判断待ちは、①Build 282 Gate 5を先に閉じるか、②サーバー正本をv1必須にするか、の2点。

**2026-08-25 Yuji決定**：2点とも決定済み。①Build 282をGate 5まで先に閉じる。②Memory Action Layer実戦版v1は認証ユーザー単位のサーバー正本を必須とし、privacy / terms / 事前明示・オプトアウト / 表示・訂正・削除 / 保持期間を同じscopeに含める。Claude Codeが作業者、Codexが独立確認者。詳細な作業指示と受入条件は正本16節を参照する。

## 2026-08-24 Claude Code — Build 282候補 **再確認：Gate 4 通過 / P0・P1 0件**

結果本文: [BUILD282_CLAUDE_INDEPENDENT_VERIFICATION.md](BUILD282_CLAUDE_INDEPENDENT_VERIFICATION.md)（末尾「再確認」節）

前回の P1 2件・P2 2件は**すべて解消**。症状を消すのではなく構造で直されていることを変異試験7件で個別確認した。

- P1-1 → `tests-cost-gate.js` をパターン対応判定へ。**`preflight.sh:54` へ収録**。JS全スイープ全緑。
- P1-2 → `desktop/scripts/verify-packaged-runtime.js` を新設し、**rendererの`<script src>`から検査対象を派生**。CIは呼ぶだけ。ハードコードを固定していたテストも解消され、架空の `future-runtime.js` で「新script追加＋package入れ忘れ」を検査している＝**Gateの必須反証そのもの**。
- P2-1 → `@electron/asar` を `devDependencies` へ明示。 P2-2 → 「前回の**天候記録**は確認できない」へ対象非依存化。
- Gate 2 未達だった起動時module診断 → `RUNTIME_MODULE_STATUS` で5module全件記録。**Gate 6 の要求を満たす**。
- **実証**：旧 `app.asar`（8/19生成・実走障害を起こした版）に新スクリプトを当てると `missing packaged runtime modules: fuel-plan-guard.js, cost-meter.js, local-intent-router.js` で失敗する。**実際に起きた事故をそのまま検出する。**
- 機械検証（私が独立実行）：JS **全緑** ／ Python **264 passed** ／ preflight ✅ ／ `git diff --check` ✅ ／ 有料実API呼出 **0件** ／ 変異試験 **7件中6件検出**。

**残 P2-3（新規・Buildは止めない）**：`verify-packaged-runtime.js` の `throw` を `if(false)` に変えても `tests-nsis-installer.js` が通る。テストは純関数（`missingRuntimeScripts`/`extractLocalScripts`）しか呼んでおらず、**`verifyPackagedRuntime()` 本体を一度も実行していない**。「欠落を検出できる」は検査済みだが「欠落時に止める」が未検査。`options.asar` の注入口が既にあり、両方向1件ずつ足せば済む（動作確認済み）。**次のBuildまでに入れないと、ゲート自身が静かに無効化されうる。**

**署名欄：Gate 4 まで合格・P0/P1 0件。ただし Gate 5〜9（private candidate artifact / Windows / iRacing / server SHA）は未実施のため「出荷可」の署名はしない。** build GO の前に `BUILD_VERSION` の更新が必要（未更新）。`engineer-card.js` を変更しているので deploy 後に `./verify-deploy.sh` が必須。

## 2026-08-24 Codex — Claude残P2-3対応

- `tests-nsis-installer.js`から`verifyPackagedRuntime()`本体を直接実行する二方向テストを追加した。renderer参照moduleを全件返すmock asarは成功し、1件欠落させたmock asarは`missing packaged runtime modules:`例外でBuildを停止する。
- 検証: NSIS installer **14/14成功**、`./preflight.sh`全項目成功、`git diff --check`成功。通常sandboxではlocalhostを使うHTTP二項目が起動制限で落ちたため、localhost許可下で同じpreflightを再実行し合格を確認した。
- Claudeが示した`missing packaged runtime modules: fuel-plan-guard.js, cost-meter.js, local-intent-router.js`は、8/19生成の旧`desktop/dist/.../app.asar`へ新検査を当てた実証結果。新しいprivate candidateはまだ生成していないため、新candidateのpackage合格証拠とは扱わない。
- commit / push / private build / deploy / 公開は未実施。次はBuild番号更新後、Yujiの明示build GOを受けてGate 5のprivate candidateを生成・検査する。

## 2026-08-24 Claude Code — Build 282候補 独立確認結果：**出荷不可・署名欄は空のまま**

確認結果本文: [BUILD282_CLAUDE_INDEPENDENT_VERIFICATION.md](BUILD282_CLAUDE_INDEPENDENT_VERIFICATION.md)
対象: `d3f3eb5` ＋ 未コミット作業ツリー（11ファイル / +136 -9）／作業者 Codex ／確認者 Claude Code

package指定の修正自体は正しい。列挙をやめて `*.js` にしたのは「列挙はコードが育つと必ずズレる」型の正しい適用で、
`tests-nsis-installer.js` が renderer の `<script src>` から**派生させて**検査しているのも筋が良い。
Gate 1（失敗の固定）も要求を満たしている。**ただし Gate 3 の報告と実態が食い違っている。**

- **P1-1 本作業が既存テストを壊し、preflight がそれを隠している。**
  `tests-cost-gate.js` は **HEAD では合格、本作業ツリーでは失敗**（stash して両方実行し確認）。
  `files` から `cost-meter.js` のリテラル列挙を消したため `tests-cost-gate.js:122` が落ちる。
  実体の同梱は `*.js` で満たされるので壊れてはいないが、**cost-meter の同梱を守っていたガードが消えた**。
  そして **`preflight.sh` に `tests-cost-gate.js` が入っていない**（grep 0件）ため `./preflight.sh` は「✅ 出荷可」と表示する。
  Gate 3 の「対象単体テスト合格」「preflight 全項目合格」を**両方満たしたと報告できてしまう状態で回帰している**。
  Build 281 の欠陥（ソース合格を製品合格と取り違える）と同じ構造がテスト層で再発。
  → 対応：`tests-cost-gate.js:122` をパターン対応判定へ揃える＋**`preflight.sh` へ追加する（入っていないテストは出荷ゲートではない）**。

- **P1-2 完成artifact検査が2moduleのハードコードで、Gateの必須反証を満たさない。**
  CI新設ステップは `['local-intent-router.js','fuel-plan-guard.js']` の2本のみ。renderer は**5本**参照している。
  手元の旧 `app.asar`（8/19生成）を列挙した実測：**5本中3本が欠落**（`local-intent-router.js` / `fuel-plan-guard.js` / **`cost-meter.js`**）。
  `cost-meter.js` は**旧 `files` に列挙されていたのに artifact に無い**＝manifest記載と実同梱は別の事実であり、Gateの分け方が実データで裏付けられた。
  現在のCI検査はこの欠落を**検出できない**。
  さらに `tests-nsis-installer.js` が `workflow.includes("'local-intent-router.js','fuel-plan-guard.js'")` と書いているため、
  **CI検査を派生型へ改善するとテストが落ちる**＝修正を妨げるテストになっている。
  → 対応：CI の検査対象を renderer の `<script src>` から生成。テストも性質を見る形へ。

- **P2-1** `@electron/asar` が未宣言依存（electron-builder経由の推移的解決のみ）。失敗方向はfail-closedだが `devDependencies` へ明示すべき。
- **P2-2** `buildHistoricalWeather()` の日本語固定文が「前回の**路面温度**は…」で、`classify` は雨・湿度・気温も同topicへ振る。「昨日は雨だった？」に路面温度の話が返る。

- **Gate 2 未達**：`router_missing` の分離は正しいが、Gate 6 が要求する「起動ログに必要moduleのloaded/missing状態が記録され全てloaded」は**未実装**（欠落を検出できるのは発話が来た時だけ）。
- **Gate 5〜9 未実施**：private candidate が存在しない。手元の asar は8/19の旧物で今回の候補ではない。
- 機械検証（私が独立実行）：Python **264 passed** ／ `git diff --check` OK ／ 有料実API呼出 0件 ／ JS全スイープ **1件失敗**。
- **署名欄は空のまま。commit / push / build / deploy / 公開はしていない。**

## 2026-08-24 Codex — Build 282候補 Claude差戻し対応：**再レビュー待ち**

Claude CodeのP1 2件・P2 2件・Gate 2未達へ対応した。commit / push / build / deploy / 公開はしていない。

- **P1-1** `tests-cost-gate.js`の同梱判定をリテラル一致からpackage pattern対応へ変更。`*.js`でも`cost-meter.js`が同梱対象であることを検査する。さらに`tests-cost-gate.js`を`preflight.sh`の恒久ゲートへ追加した。
- **P1-2** CIの完成asar検査から2moduleのハードコードを撤去。`desktop/scripts/verify-packaged-runtime.js`が`renderer.html`のローカル`<script src>`を毎回抽出し、完成`app.asar`に全件存在するか照合する。6本目以降を追加しても自動的に検査対象になる。`tests-nsis-installer.js`も特定ファイル名ではなく、この派生契約と欠落検出を検査する。
- **P2-1** `desktop/package.json`の`devDependencies`へ`@electron/asar ^3.4.1`を明示した。推移依存へ依存しない。
- **P2-2** 過去天候のfail-closed文を「前回の天候記録は確認できない。現在値では代用しない。」へ変更。「昨日は雨だった？」でも路面温度の話へずれない回帰をLocal RouterとEngineer Cardの両方へ追加した。
- **Gate 2** Bridge WebSocket接続直後に`RUNTIME_MODULE_STATUS`を診断ログへ記録する。memory / strategy / fuel guard / cost meter / local routerのloaded状態とmissing一覧を一行で確認できる。発話が来る前に欠落を判定できる。

独立実行結果:

- JavaScript全スイープ: **57/57 suites成功**（localhost統合3本を含む。外部有料API呼出なし）。
- Python discovery: **264/264成功**。
- `tests-cost-gate.js`: **36/36成功**。
- `tests-nsis-installer.js`: **12/12成功**。
- Local Intent Router: **38/38成功**。
- Engineer Card: **112/112成功**。
- `./preflight.sh`: 新設cost gateを含め全項目成功。ただしこれはGate 3までであり、artifact/Windows/実走の合格とは扱わない。
- `git diff --check`: 成功。

Claude Codeへの再レビュー依頼:

1. P1/P2とGate 2の直し方を独立再確認する。
2. 全JSスイープと`preflight.sh`が`tests-cost-gate.js`の失敗を実際に捕捉することを確認する。
3. `verify-packaged-runtime.js`へrenderer参照を一件追加／package entryを一件欠落させる反証で失敗することを確認する。
4. P0/P1が0件ならGate 4へ署名する。private candidateはまだ無いためGate 5以降へ署名しない。

## 現在の最優先: Build 266 / Phase E

目的は、状況が変われば前提を更新し、燃費・ペース・Plan A/B/Cを再計算して短く提案すること。

正しい動線：

```text
SDK損傷／ドライバー申告／燃費・ペース変化／相手のピット
  → Session Race State（Bridge権威）
  → 直近有効周の燃費・ペース再算出
  → Plan A/B/C・復帰位置・燃料ウインドウ再評価
  → active_plan更新
  → 決定論的handler
  → 短いLuna無線
  → traceと次回用の結果保存
```

### 戦略仕様

- Plan A: 通常ペースの基準戦略。
- Plan B / undercut: 単なる−1周ではない。必要給油が容量内に収まる最初の燃料ウインドウ、前走車への相対ペース優位、遅い後方集団を避ける物理リジョインの全条件が必要。
- Plan C / overcut・fuel-save: 単なる＋1周ではない。相手の先ピット、クリーンエア、燃費目標、悪化しないリジョイン等の成立条件が必要。根拠がなければ unavailable。

### Monza 20実走から必須の損傷要件

- 任意修理秒は**ピット進入時だけでなく、ピット中を含めて初めて非ゼロになった瞬間**に保存する。
- 任意修理を選ばずピットアウトし、ライブ修理秒が0になっても「観測した任意修理」と「未実施」の事実を消さない。
- 「フロントバンパー」「ステアリングコラム」「アライメント」のドライバー申告は `driver_reported_damage` として保存する。SDKの部位確定とは混同しない。
- 損傷後は通常ペース前提を停止し、接触後の直近3〜5有効周を使って再計算する。
- 損傷後の再計算前に「プッシュしていい」を言わない。

## Build 266候補のCodex差戻し（未解決）

以下が解決・テスト・trace実証されるまでBuild候補にしない。

1. **任意修理の観測時刻が誤り**
   - 現候補はピット進入時だけをスナップショットしており、ボックス付近で接触して後から発生する任意修理を失う。
   - 修理秒の最大観測値と初検出時刻を、ピット中も更新すること。

2. **再計算が記録だけで、戦略を再計算していない**
   - `recalculate_strategy()` に既存Planを渡してtraceするだけでは不可。
   - 損傷／燃費／ペース変化時に、実際の燃費・ペース・復帰予測を入力してPlan A/B/Cを再評価し、`active_plan` を更新すること。

3. **fuel_deviation / pace_deviationの自動監視が未配線**
   - 純関数の存在だけでは不可。
   - Bridgeの実フレームループで、直近3〜5有効周中央値と基準値を比較して自動発火すること。

4. **Plan C未実装**
   - briefingとライブ判定に、条件付きPlan Cを実装すること。

5. **日本語無線の未配線**
   - `strategy_recalculation` にLunaJPの日本語caseを追加する。英語のBridge messageをLunaJPが読む経路を残さない。

6. **統合テストがBridge実行経路を通っていない**
   - 純関数を手で順番に呼ぶだけでは不可。
   - 保存telemetry／event fixtureから、Bridgeの実際の受信→状態→再計算→broadcast→queue fateまでを通す再生テストにする。

7. **内部シミュレーション・原価ゲート未証明**
   - 外部API 0件、simulated/generated/played/deferred/discarded、wasted-generation costを出す。
   - 生成、保留、再生、完了、期限切れ／破棄を別eventでtraceする。

## 八木さんログ（2026-08-11 17:09〜 / Build 264）からの追加修正

- 高路温・タイヤが持たない・セットアップ相談を `weather_status` に誤ルーティングしない。`handling_setup_advice` を優先する。
- アンダーステア相談直後の「どうしたらいい？」は直前文脈を引き継ぐ。
- 途中で切れる発話（例: `次のピットで内。`）を禁止する。
- 技術相談中にデブリーフ質問を割り込ませない。
- 同一pit cycleの `limiter_off` を一回だけにする。
- Build 264ログはBuild 265のLap Readout設定を検証する証拠ではない。

## Claude Code 実装報告

> ここへ追記する。上の差戻し項目ごとに、実装場所・実行テスト・trace・未完了を明記すること。

### 2026-08-12 Claude Code — 差戻し #1 / #5 / #3 のみ着手（#2 #4 #6 #7 は未着手）

Codexレビュー依頼書：[BUILD266_REJECTION_1_5_3_REVIEW_REQUEST.md](BUILD266_REJECTION_1_5_3_REVIEW_REQUEST.md)（`file:line` 根拠・受入契約・変異試験の実施結果つき）

commit / push / build / 公開はしていない。Codexレビュー待ち。Build 266候補としては**まだ不可**（#2 #4 #6 #7 が未解決のため）。

#### 差戻し#1 任意修理の観測時刻 — 実装した

- 旧実装は `bridge.py` のピット進入ブロック1箇所で `_pit_repair_opt_observed_at_entry = repair_opt or 0.0` を取るだけだった。ボックス付近で接触した場合 `PitOptRepairLeft` は OnPitRoad が True になった**後**に非ゼロになるため、任意修理の存在そのものを取り逃がす。
- `session_race_state.py` に `record_optional_repair_observation()` を新設。最大観測値と初検出時刻（lap / session time / その時ピットロード上だったか）を保持する。冪等なのでpoll loopから無条件に呼べる。ライブ値が 0.0 に戻っても最大値は下がらない。
- `bridge.py` は毎フレームこれを呼ぶようにした（`if isinstance(repair_opt, (int, float)) and repair_opt > 0:`）。ピット中は `_pit_repair_opt_observed_max` と `_pit_damage_s_max` も更新する。
- 実消費秒の算出も直した。旧 `_repair_done = pit_repair_start_s - damage_s` は、ボックス内で接触して damage_s が増えると負になり `max(0.0, …)` で 0 に潰れ、未実施検知が黙って死ぬ。ピット中に見えた damage_s の最大値を基準に変更。
- trace: `SESSION RACE STATE optional_repair_observed: max=…s on_pit_road=… lap=…` / `… optional_repair_observed_but_not_taken: observed_max_in_pit=… repair_done=… first_seen_on_pit_road=…`

#### 差戻し#5 日本語無線 — 実装した

- `bridge.py` は `trigger:'strategy_recalculation'` に英語の `driver_message` を載せて broadcast している。`renderer.html` の日本語キャラクター経路は `oishiRadio(data,false) || data.message` の順で文面を決めるため、caseが無い＝英語がそのままLunaJPで読み上げられる（実走で `pit_box_here` が同じ事故を起こしている）。
- `oishiRadio()` に `strategy_recalculation` の日本語caseを追加。英語 `message` は読まず、構造化フィールド `reason` / `category` だけから組み立てる。未知reason・reason欠落でも必ず日本語を返す（空を返すと英語へ落ちるため）。
- **未対応**：`matthiasRadio()`（ドイツ語）は同じ構造で英語へ落ちる。差戻し文面がJPのみを指しているため今回は触っていない。要判断。

#### 差戻し#3 fuel/pace deviation の自動監視 — 実装した

- 周回確定ブロック（`if lap_time_changed and onTrack:` 内）で、`fuel_per_lap_hist` / `lap_time_hist` の**直近3〜5有効周の中央値**と基準値を毎周比較する配線を追加。毎フレームではなく周回確定時のみ評価する。
- 判定は `session_race_state.next_deviation_trigger()` という純関数に持たせ、bridgeはそれを呼ぶだけにした。bridgeにインラインで書くと「配線はされたが挙動を試験できない＝静的な文字列一致でしか裏が取れない」形になるため。
- 発火規則：許容内なら発火せず再武装（episode+1）／乖離中はしきい値の倍数（step）ごとに1回だけ発火（毎周の連呼をしない）／悪化して次のしきい値を跨いだら再発火／基準値未確定の間は発火も再武装もしない。
- 中央値（平均でない）を使う理由：トラフィック1周や1回のオフで走行値が引きずられないようにするため。
- **未完了**：発火時に渡している `selected_plan` は現行 `active_plan` のままで、`driver_message=None`。**実際のPlan再評価は差戻し#2の作業**であり、今回は検知と trace までしか到達していない。ここを「再計算できた」と読まないこと。

#### 実行したテスト

```bash
for t in irsdk-bridge/tests_*.py; do python3 "$t"; done   # 33スイート全green
for t in tests-*.js; do node "$t"; done                    # 下記1件を除きgreen
node tests-strategy-recalculation-jp-radio.js              # 新規 28/28
python3 irsdk-bridge/tests_session_race_state.py           # 52 tests（+24件）
python3 irsdk-bridge/tests_bridge_recalculation_wiring.py  # 41 tests（+10件）
```

- 新規 `tests-strategy-recalculation-jp-radio.js`（28チェック）：reasonごとの日本語文面／英語 `message` を素通しさせないこと／未知reasonでも英語へ落ちないこと／発話が三文以内かつ数値を読み上げないこと／bridgeが `reason`・`category` を載せていること。
- `tests_session_race_state.py` 追加：任意修理の最大値・初検出（進入後に発生するケースを含む）、中央値、乖離判定を**ラップ列の再生**で検証（`DeviationTriggerSequence.replay()`）。安定＝無発火／持続＝1回だけ／悪化＝再発火／回復後の再乖離＝再武装、を実挙動で確認。
- `tests_bridge_recalculation_wiring.py` 追加：進入時1点でないこと（`if onPit:` 配下であること、進入遷移でgateされていないこと）、`_repair_basis_s` が最大値を使うこと、乖離ループが周回確定ブロック内にあること、episodeカウンタがセッションscopeでresetされること。

#### 原価ゲート（内部シミュレーション正本 §Cost gate）

- 外部Anthropic呼出：0／外部Google STT・TTS呼出：0。新規・変更テストはファイル読み込みと純関数のみで、HTTPクライアントを一切importしていない（`requests` / `urllib` / `http.client` / `socket` / `fetch` / `axios` / `anthropic` / `texttospeech` の参照件数 = 0 を確認）。
- ただし **正本が要求する simulated / generated / played / deferred / discarded / wasted-generation cost の計装そのものは未実装**（差戻し#7）。上記は「実APIを呼んでいない」ことの確認であって、原価ゲートの証明ではない。

#### 今回の作業とは無関係の既存不具合（報告のみ・触っていない）

- `tests-five-day-access.js` が失敗する。`desktop/renderer.html` 内の `applyPitwallAccess(...)` の出現数が10で、テストの期待値7と合わない。**HEAD（commit de54d0e / 公開Build 265）でも同じ数・同じ失敗**を確認済みで、Build 266候補の変更が原因ではない。課金・認証まわりのため独断で触らない。要判断。
- 前回のBuild 266候補のcompletion evidenceは「JavaScript 16関連スイートgreen」と書いているが、これは選択した16本を回した結果であり、`tests-*.js` 全数ではない。この失敗はそこで表に出ていない。

#### 未着手（今回のスコープ外・共有ログの差戻し項目のまま）

- 差戻し#2（再計算が記録だけ／実際にPlan A/B/Cを再評価していない）
- 差戻し#4（Plan C未実装）
- 差戻し#6（統合テストがBridge実行経路を通っていない）
- 差戻し#7（内部シミュレーション・原価ゲート未証明）
- 八木さんログ由来の5項目（`handling_setup_advice` 誤ルーティング／文脈引き継ぎ／途中で切れる発話／デブリーフ割り込み／`limiter_off` 二重発火）。うち `limiter_off` は `limiter_off_announced_stop` によるガードが既に存在するが、発火条件がリミッター状態遷移ベースで、指示書が要求する `OnPitRoad true→false` の一意条件になっていない。実走で二重発火した以上、現ガードでは足りていない。

### 2026-08-12 Claude Code — Codex限定レビューのP1三点に対応（#1 / #3a / #3b）

Codexへの回答書：[BUILD266_REJECTION_1_5_3_CODEX_REVIEW_RESPONSE.md](BUILD266_REJECTION_1_5_3_CODEX_REVIEW_RESPONSE.md)
実装の詳細：[BUILD266_REJECTION_1_5_3_REVIEW_REQUEST.md](BUILD266_REJECTION_1_5_3_REVIEW_REQUEST.md) の「第2版」節。
commit / push / build / 公開はしていない。#5 は承認済みのため触っていない。

- **P1(#1) 取消／未実施と実修理の区別** — 実施の証拠を「退出時の残秒差」から「実時間に沿って消化された秒（countdown）」へ変更した。`PitOptRepairLeft` の減少が経過秒で説明できる時だけサービス消化として積む。取消・選択変更・ピットアウトのリセットは経過時間に対して不釣り合いな瞬間的な落ち方をするため積まれない。判定は `not_taken` / `partial` / `taken` / `none` を返し、`not_taken` の時だけ sticky フラグを立てる。
- **P1(#3a) ペース基準がNoneで固定** — 燃費履歴だけで発火していた `clean_3_laps_established` を、燃費とラップタイムの両方が3本揃ってから一度だけ確定する形に変更した。基準も中央値で、逸脱判定と同じ関数・同じ集合を使う。
- **P1(#3b) 有効周でない履歴の混入** — 有効周判定（incident 0 / pit road未通過 / アウトラップでない / off-track未検出）を燃費履歴を積む前へ引き上げ、Phase E 専用のクリーン周履歴に燃費とラップタイムを**同じ周に同時に**積むようにした。下流のラップタイム読み上げブロックは同じ確定値を共有する（同一周に二つの定義を並存させない）。
- **Codexの文面との相違（要判断）**：Codexは `lap_time_hist` 自体へ有効周判定を適用せよと書いている。`lap_time_hist` は残り周回推定・ペース比較など既存consumerが多く（`bridge.py` 内9箇所）、絞り込むとそれらの挙動が変わるため、Phase E 専用のクリーン周履歴を別に持つ形にした。「baseline と median が同一の有効周集合から作られる」という要件は満たしているが、既存履歴の定義自体は変えていない。この判断でよいか確認してほしい。
- **Bridge実行経路の再生テスト**：ピット修理の取消／実施はフレーム列の再生（`PitServiceCancelledVersusPerformed.replay()`）、クリーン3周とdirty lap混入は周回列の再生（`CleanLapBaselineOrdering.latch()`）で検証した。いずれも bridge が呼ぶのと同じ純関数を同じ順序で流している。**ただし poll loop 自体を回す完全な再生ではない**（それは差戻し#6の作業として残っている）。
- テスト: Python 33スイート全green（`tests_session_race_state.py` 65件／`tests_bridge_recalculation_wiring.py` 51件）。JSは既存の `tests-five-day-access.js` のみ失敗（HEADでも同じ・無関係）。変異試験7件すべて検出を確認。
- 外部Anthropic／Google呼出：0。原価ゲートの計装自体は未実装のまま（差戻し#7）。

### 2026-08-12 Claude Code — 差戻し #2 / #4 を実装（#6 #7 は未着手）

Codexレビュー依頼書：[BUILD266_REJECTION_2_4_REVIEW_REQUEST.md](BUILD266_REJECTION_2_4_REVIEW_REQUEST.md)
commit / push / build / 公開はしていない。Build 266 は依然として候補不可。

- **#2 実際のPlan再評価** — 7トリガーが `active_plan` をそのまま渡して trace するだけだった状態を、実測値からPlan A/B/Cを組み直して選び直す形にした。トリガー検出（フレーム前半）と再計算の実行（フレーム後半・権威データ更新後）を分離。前半で再計算すると1周古い入力で組み直すことになるため。`rival_pit_or_rejoin_shift` だけ別経路で記録していた箇所も同じ経路へ寄せた。証拠が足りない時は前のPlanを維持し理由を返す（黙って古い前提を使わない・根拠なく乗り換えない）。
- **#4 Plan C** — overcut / fuel-save として実装。ブリーフィング時は燃料計算だけを答え `available=False`。「前走車が先にピット・クリーンエア・燃費目標達成・リジョイン悪化なし」の4条件が実測で揃った時だけ成立する。`None`（不明）は満たされたと扱わない。8%超の節約が要る場合は「届かない」とする。
- **実装中に見つけて直した自分の欠陥**：最初の実装では Plan C が本番で構造的に成立し得なかった。目標値は計算に使った燃費より必ず小さいため、節約して燃費が下がるたび組み直すと目標も一緒に逃げる。最初に提案した時の目標をラッチする形へ修正した。
- **変異試験11件すべて検出を確認**。ただし最初、`execute_recalculation` に対する2件が検出できなかった（静的なソース文字列チェックのみで、中身を空にしても文字列が残るため）。bridge を直接 import して動かす挙動テストを追加して解消した。
- テスト: Python 34スイート全green（新規 `tests_strategy_reevaluation.py` 39件／`tests_bridge_recalculation_wiring.py` 64件）。JSは既存の `tests-five-day-access.js` のみ失敗（現HEAD `da0c4a3` でも同じ・今回の変更とは無関係）。
- 外部Anthropic／Google呼出：0。原価ゲートの計装自体は未実装のまま（差戻し#7）。
- **判断がほしい点①**：brief 3-1 は Plan B = undercut（早めに入る）と書いているが、公開中の Build 265 の `plan_b` は `extend_one_lap`（Plan Aより1周遅い）で、日本語無線も「1周延長案」と読み上げている。既存定義を変えると公開済みBuildの発話契約まで変わるため独断で動かしていない。brief通りに定義し直すべきか指示がほしい。
- **判断がほしい点②**：`tests_judge_llm_gate.py` の正規表現の走査窓を6000→8000へ広げた（reset経路が長くなり末尾へ届かなくなったため。sig経路側の窓と同値）。テストを触ったので報告する。

### 2026-08-12 Codex — Plan B定義の決定

判断本文: [BUILD266_REJECTION_2_4_PLAN_B_DECISION.md](BUILD266_REJECTION_2_4_PLAN_B_DECISION.md)

- **Plan Bは条件付きアンダーカットへ定義し直す。** 現行の`Plan B = extend_one_lap`は採用しない。
- Plan Aは基準、Plan Bはfuel / capacity / finish + 相対ペース優位 + 遅い集団を避けるrejoinが全て揃う早いfuel window、Plan Cは条件付きovercut / fuel-saveとする。
- 現行のPlan Cを「Plan Bのさらに1周先」にする計算も採用しない。Plan A基準のfuel-save延長案として独立に組み立てる。
- renderer無線、Bridge box call、A/B比較器、テストを新しいA/B/C契約に揃えるまで、#2 / #4は承認しない。Build 266は候補不可。commit / push / build / 公開はしない。

### 2026-08-12 Yuji — Plan B（Undercut）のFuel Window補足

- GT Sprint（GT3）／IMSA Seriesでは、Plan Bの最適な候補は通常、**Fuel Windowが開いた時点以降**にある。
- Fuel Windowの最低条件は、当該周でピットして、満タン容量を超えずにチェッカーまで必要な燃料を搭載できること。早すぎて必要給油が容量に収まらない周はUndercut候補ではない。
- その最初の成立周から、前走車に対する相対ペース優位と、遅い後方集団を避けるphysical rejoinを比較して、実際のPlan Bを選ぶ。単なる固定の-1周ではない。

### 2026-08-12 商用方針と `da0c4a3` の扱い

- `da0c4a3 Define time-boxed free access policy` は `HANDOFF.md` だけを変更したローカルcommitであり、`auth.js`／決済／利用権／公開ページは変更していない。`origin/main` は引き続き公開済みBuild 265の `de54d0e`。
- このcommitの「通常5日無料trial」は、採用済みの商用方針（無料5日を廃止し、有料US$9.99 Starter Passを入口にする）と矛盾する。今後の料金・紹介・ホームページ実装の正本には使わない。必要なら履歴／テスター専用の参考記録としてのみ扱う。
- 8/31本格公開に向けた現行方針は、GT3／耐久に絞った有料Starter PassとRace Passである。具体的な期間・価格・利用権・紹介台帳は商用実装の前にYujiが最終決定する。

### 2026-08-12 Claude Code — Plan A/B/C 契約を統一（Plan B定義の判断へ対応）

レビュー依頼書：[BUILD266_PLAN_ABC_UNIFIED_REVIEW_REQUEST.md](BUILD266_PLAN_ABC_UNIFIED_REVIEW_REQUEST.md)
commit / push / build / 公開はしていない。Build 266 は依然として候補不可。

- **Plan B = Fuel Window が開いた後の条件付きアンダーカット**へ定義し直した。候補周は `_fuel_window_open_in()` が返す「容量内で完走分を積める最初の周」。固定の -1 周は実装していない。相対ペース優位（0.3秒以上）と rejoin clear が揃った時だけ available。
- **Plan A = 基準 = `latest_safe`**（通常ペースで成立する最後の燃料安全周）へ戻した。旧 `latest_safe-1` のままだと Plan C（A+1）が無節約で届いてしまい fuel-save の意味が消えるため。この解釈でよいか確認してほしい。
- **Plan C は Plan A 基準の延長**へ組み替えた（旧「Plan B のさらに1周先」は破棄）。
- **無線を全置換**：ブリーフィングの「1周延長案」を削除しB は候補として述べる（断定しない・ウインドウが開いていなければ触れない）／決定は A=基準・B=アンダーカット・C=延長／box call から「延長案」を削除。Bridge の英語 box call も `Undercut is on.` へ変更。
- 判断書が指定した再生テスト5件を全て追加（ペース優位なし→unavailable／遅い集団へblend→unavailable／全成立→selected=B・早いpit lap／C条件欠落→unavailable／無線でBとCの語が混ざらない）。
- **変異試験7件すべて検出を確認**（Aを`latest_safe-1`に戻す／Fuel Window無視／ペース優位なしでB／復帰未証明でB／CをB起点に戻す／無線でBを「延長」と言う／ブリーフィングでBを断定する）。
- テスト: Python 34スイート全green。`tests-strategy-recalculation-jp-radio.js` 39/39。JSは既存の `tests-five-day-access.js` のみ失敗（現HEADでも同じ・無関係）。
- **契約変更で期待値を更新したテスト（明記）**：`tests_strategy_options.py`（全面書き換え）／`tests_plan_fuel_authority.py` の Monza 35 参照ログ再生（Plan A の目標周が lap 14 → lap 15。A の定義が変わったため。参照ログは旧契約時点の記録）／`tests-engineer-card.js`（無線文言）。実装に合わせて緩めたのではなく、新契約の値へ置き換えた。
- **`da0c4a3` の無料trial方針は使っていない。** 今回の作業は戦略エンジンと無線のみで、`auth.js`・決済・利用権・公開ページには一切触れていない。
- 外部Anthropic／Google呼出：0。原価ゲートの計装自体は未実装のまま（差戻し#7）。

### 2026-08-12 Claude Code — #6 / #7 / 八木さんログ5項目を実装（全項目着手完了）

完了証拠：[BUILD266_PHASE_E_COMPLETION_EVIDENCE_V2.md](BUILD266_PHASE_E_COMPLETION_EVIDENCE_V2.md)
commit / push / build / 公開はしていない。Yujiのレビュー待ち。Build候補としての申請ではない。

- **#6 Bridge poll loop の完全再生** — `irsdk-bridge/replay_harness.py` を新設し、本番の `poll_iracing()` そのものを保存フレームで回す。差し替えるのは reader / broadcast / log / time の境界だけで、判断・状態遷移・発話生成は全て本番コードが行う。`while True:` は fixture 枯渇時に FakeReader が例外を投げて止める（ループ構造は未変更）。**仮想時計が必要だった**：`now - last_telem_ts > 3` のような実時間スロットルがあり、時間を止めると本番なら毎秒走る経路が1回しか走らず再計算へ到達しなかった。`tests_bridge_poll_replay.py` 19テスト。
- **#7 原価ゲート計装** — `desktop/cost-meter.js` を新設。generated / queued / tts_requested / deferred / played / completed / expired / discarded を別イベントで記録し、renderer の各 seam（16箇所）から報告させる。計装は機能依存にしていない（全呼び出しが `typeof` ガード付きで、meter が無くても発話経路は変わらない）。`node tests-cost-gate.js` が正本要求の全指標を出力。**外部API呼出は全て0**、無駄生成は件数と原価で可視化。
- **八木さんログ5項目** — 7-1 `handling_setup_advice` 新設（セットアップ語は単独で weather に勝つ／Practice でもカードを引くが、race 以外で採用するのは相談だけに限定し燃料ハンドラは race 限定のまま）。7-2 曖昧フォローアップの文脈引き継ぎ（race ゲートの外へ）。7-3 相談中のデブリーフ抑止（根拠はサーバの確定 intent・推測しない）。7-4 途中で切れる発話の検証。7-5 `limiter_off` を OnPitRoad true→false の一意発火へ統一し、再武装は確定したピット訪問だけに限定。
- **7-5 は再生で実走の二重発火を再現してから直した。** しきい値も再生で決めている（当初1.0秒では1フレームのちらつきを弾けず二重発火が再現したため3.0秒へ）。
- **変異試験9件すべて検出を確認**（累計34件）。
- テスト: Python 35スイート全green／JS 47スイート中、既存の `tests-five-day-access.js` のみ失敗（現HEADでも同じ・無関係）。
- **契約変更で更新したテストは明記**（`tests_strategy_options.py` 全面書き換え／Monza 35 参照ログの lap 14→15／`tests-engineer-card.js` 文言／`tests_judge_llm_gate.py` 走査窓／`tests-fuel-authority.js` は守るべき性質を直接検証する形へ変更し**緩めていない**）。
- **実走でしか確認できない項目を明記**：音声の自然さと間合い／実 iRacing テレメトリ接続／相談回答が実際に役立つか／`LIMITER_OFF_MIN_PIT_DWELL_S=3.0` の妥当性／Plan B・C が実レースで妥当なタイミングに出るか。
- **`da0c4a3` の無料trial方針は使っていない。** `auth.js`・決済・利用権・公開ページには一切触れていない。

### 2026-08-12 Codex — Build 266 #6/#7/八木さん5項目レビュー

レビュー本文: [BUILD266_PHASE_E_COMPLETION_EVIDENCE_V2_CODEX_REVIEW.md](BUILD266_PHASE_E_COMPLETION_EVIDENCE_V2_CODEX_REVIEW.md)

- **差戻し。Build候補にはしない。** Codex再実行では `tests-cost-gate.js` 35/35、`tests-fuel-authority.js` 26/26、`tests-yagi-log-regressions.js` 39/39、`tests_bridge_poll_replay.py` 19 tests が通過した。しかし#7の原価ゲートにP0が2件ある。
- **P0-1**: 実rendererでは `generated` がidなし／chat応答前、queued/played/discardedは別idであり、生成→再生／破棄の同一reply追跡が不能。未再生生成を `wasted_generation` として実測できない。stable reply id、応答後のgenerated、chunk親子fate、stubbed renderer integration testが必要。
- **P0-2**: STTと複数chat経路が原価計装外。全 `/api/chat`／`/api/tts`／`/api/stt` をwrapperまたは全siteで計上し、STT retry・秒数も含めた外部ゼロのintegration testが必要。
- **P1**: 非Race direct-pit fallback（`server.js:995-1001`）をrace限定にし、テストを追加すること。
- **P1 / Yuji確定文言**: `engineer-card.js` の長文no-dataを廃止。固定文言は **「今、ここでは伝えられない。」**。そのターンに燃料／GAP／S/F／根拠／次回更新予定を一切追加しない。英語版と会話・無線回帰テストも揃える。
- **P1**: replay testのResourceWarningを解消する。
- #6の本番 `poll_iracing()` 再生の方向、八木さん5項目の限定回帰、Plan BのFuel Window条件付きUndercut契約は維持。実SDK／音声の間合い／相談有用性／3秒dwell／Plan B/C時機はBuild後の実走確認。
- commit / push / build / 公開はしない。

### 2026-08-12 Yuji — ストレート上のペース基準コール（次期検討）

- ストレートなど安全な走行区間で、Lunaが「トップは何秒台」「直前車両は何秒台」を短くコールできるとよい。
- 目的は毎周実況ではなく、退屈を減らし集中を維持するための**ペース基準**の提供。
- 実装時は安全窓（ストレート／低舵角・非ブレーキ）と頻度制限を必須にする。トップ・直前車のラップ値が権威データとして同一周回文脈で取れない時は黙る。相対差が小さい／前車がトラフィック・ピット等で代表性が無い時も発話しない。
- 例: 「トップ、2分55秒台。前は2分56秒台。」。レース中の発話は一文で終える。

### 2026-08-12 GT Sprint 実走確認 — Indianapolis Road Course

- 中盤でタイヤ消耗のコメントがあることを確認対象にする。車両固有の摩耗値を捏造せず、利用可能な実測・ドライバー感覚に基づく短いコメントであること。
- 後方車両がパッシング後に並走へ入った瞬間の「左に車」は、安全コールとして許容する。コーナー限定ではなく、横並びが実際に成立した場合に必要。
- 予定給油まで残り4周の局面では、Lunaが画面を読むのではなくBridgeの権威テレメトリ／active planから、必要な場合のみ燃料・予定ピットを短く発話するかを確認する。無根拠な連呼、早過ぎる「この周ボックス」は不可。
- 実走観測: 予定ピットをスルーした後、次のホームストレートで「3.4L余る見込み。ペースを上げていい」と更新した。残り5周・燃料3L台で八木さんが即応。前のピット判断との反転理由（残り・燃費・ペース）のtrace確認が必要だが、固定プランに固執せず再計算した可能性がある。
- 次期要件: ピット後の順位予測は、ピット出口直後の一時的なblend順位だけで終えず、前後関係が安定する**blend終了後の復帰順位**も示す。ピット前後の車群・相対ペース・同クラス順位を証拠として持てない時は予測しない。
- 終盤観測: 後半に舵角増加のコメント、残り5周コールあり。残り2周付近で燃料余裕が約0.9Lなら、fuel_strategy_safe の「ペースを上げていい」は危険。**完走余裕（margin）とpush許可を別契約にする**。pushは、当日実測の通常ペースより速く走っても成立する追加余裕を証明できる場合のみ。0.9Lは「完走見込み」までで、push許可の根拠にはしない。
- ファイナルラップの後方GAPは、給油後3秒→1.4秒→0.9秒へ接近。Yuji判断: ドライバーに不要なプレッシャーを掛けないため、即時の物理危険・明確なオーバーテイク局面でない限り、最終周の通常の後方接近コールは黙る。既存battle/defendのfinal-lap抑止条件をこの方針で見直す。

### 2026-08-19 Claude Code — 状況訂正と Build 277（アンダー相談の間合い短縮）

**状況訂正（重要）**：この文書の 2026-08-12 付 Claude Code 追記は「未コミット・レビュー待ち」と書いているが、**実態と異なる**。
Build 266 は `388abb7 Build 266 adaptive race intelligence` として既に commit・出荷済みで、その上に 267〜276 が積まれている。
現在の HEAD は `3903b03`。八木さんの 8/18 実走も **Build 276** である。Build 266 のレビュー待ちは解消済みとして扱う（Yuji判断・8/19）。

**八木さんログ（2026-08-18 21:03〜 / Build 276 / St Petersburg / Audi R8 LMS GT3 / Offline Testing）の解析**

良かった点：
- セットアップ相談が `intent=handling_setup_advice authority=deterministic` で正しく発火。STTが「アンダーが**ニット**である」と崩れても分類できた。
- 温度質問「データ 行ってる？路面温度とか？」は `weather_status` のまま。取り違えなし。
- 21:47〜22:44 の57分沈黙はピット駐車（Speed 0 / OnPit True）。黙っていたのが正しい挙動。
- 発話の途中切れなし。最初の声は **665ms** で出ている。

**P1：アンダー相談の回答が長すぎた（24秒）**
- 129文字がTTS4チャンクに分割され、22:44:42 質問 → 22:45:06 完了。待ちが 665ms → 5.4秒 → 18.6秒 と積み上がった。
- Build 276 は `rear_grip` だけ短縮し、**アンダー経路が Build 266 の旧形式のまま残っていた**（私が書いた形）。
- 実測レート **約7文字/秒**（chars=35 のチャンクが5秒）。Yuji判断で許容範囲は **3〜5秒＝21〜35文字**。
- 対応：`engineer-card.js` のアンダー経路を最初の一手だけに短縮（**34字 ≈ 4.9秒**）。温度の復唱と速度域の聞き返しを削除。
  二手目は続けて聞かれた時（文脈引き継ぎ）に出す（**30字 ≈ 4.3秒**）。同じ答えを繰り返さない。
- テストで固定：秒数上限・温度を復唱しない・聞き返さない・最初の一手を出す・観測を1つ指定・追撃で別の答えを返す。`tests-yagi-log-regressions.js` 51/51。
- 変異試験3件すべて検出（旧形式へ戻す／温度復唱を戻す／追撃で同じ答えを返す）。

**追加対応（Yuji指示・8/19 第2次）**

1. **部品名を略さない** — 「フロントのバー」→「フロントのアンチロールバー」。予算内に収めるため症状ラベルの重複を落とした。
2. **他の全経路も短縮** — `buildHandlingSetupAdvice()` を書き直し、5症状すべてを「最初の一手＋観測1つ」の統一形式にした。

| 症状 | 変更前 | 変更後 | 発話文 |
|---|---|---|---|
| understeer | 129字 18.4秒 | **34字 4.9秒** | まずフロントのアンチロールバーを1段柔らかく。低速進入を3周比べて。 |
| rear_grip | 68字 9.7秒 | **30字 4.3秒** | まずリアスプリングを1段柔らかく。低速出口を3周だけ比べて。 |
| oversteer | 126字 18.0秒 | **32字 4.6秒** | まずリアのアンチロールバーを1段柔らかく。低速出口を3周比べて。 |
| tyre_degradation | 131字 18.7秒 | **33字 4.7秒** | まずタイヤ内圧を少し下げて発熱を抑える。3周後のタイム落ちを見て。 |
| unspecified | 108字 15.4秒 | **34字 4.9秒** | まず1周、同じラインで基準を取る。アンダーとオーバー、どっちが強い？ |
| 追撃（二手目） | — | **27字 3.9秒** | 次はリアの車高をわずかに上げる。低速進入を3周比べて。 |

症状が特定できている時は聞き返さない（一往復増やさない）。`unspecified` の時だけ、どこを直すか決められないので絞る質問を1つ返す。

3. **SESSION INFO 警告602回の抑止** — `bridge.py`。**金銭コストはゼロ**（`log()` は stdout とローカルファイルのみ・API呼び出しなし）。代償はログ1.8MBとノイズ。
   判定を `si_len >= cap`（バッファサイズ比較なので常に真）から、診断関数の結論 `cap_verdict == 'truncated_at_cap'`（実データが cap に到達）へ変更。さらに verdict 変化時のみ鳴らす。本物の切り詰めが起きた時だけ1回鳴る。

**テスト契約の変更（緩めたのではない）**
`tests-yagi-log-regressions.js` の旧6項目（温度を根拠として述べる／速度域を聞き返す／`試すなら` で2案／`次の走行では`／`断定できない`）は、**今回意図的に廃止した長文契約そのもの**である。実装に合わせて緩めたのではなく、Yuji判断で契約側を置き換えた。削除ではなく、新契約（温度を復唱しない・一手だけ・観測1つ・数値を断定しない）へ書き換えている。

**検証**
- `tests-yagi-log-regressions.js` **74/74**（全5症状 × 秒数・温度復唱・終端記号・助詞切れ・聞き返し・一手目）
- `tests_session_info_extent.py` **124/124**（警告ゲートの配線テストを新規追加）
- 全体スイープ：Python 36 suites 全緑 / JS 54 suites 中 53 緑。`tests-five-day-access.js` の1件（`desktop authenticates every cost API request`）は **HEAD時点で既に落ちている既存の失敗**で、今回の変更とは無関係（stash して確認済み）。別件として要対応。
- 変異試験5件すべて検出：観測文を旧長文へ戻す／部品名を「バー」に略す／追撃で一手目を返す／警告ゲートを外す／変化検出を外す。
- commit / push / build / 公開はしていない。

**追加：`tests-five-day-access.js` の既存失敗を解決（8/19）**

- 症状：`desktop authenticates every cost API request` が HEAD 時点で落ちていた（今回の変更とは無関係・stash して確認済み）。
- 原因：検査が `applyPitwallAccess()` の**呼び出し回数が7**であることを見ていた。実装が育って呼び出しは10になっており、
  認証は全経路で効いているのにテストだけが落ちていた。**回数はコードが育てば必ずズレる書き方**だった。
- 実害の有無を先に確認：`renderer.html` の課金API（chat/translate/tts/stt）fetch は **9箇所すべて認証済み**。
  8箇所が `applyPitwallAccess()` 経由、TTSの1箇所が `ttsHeaders['X-Pitwall-Access-Code']` の直付け。**無認証の課金呼び出しは無かった**。
- 対応：回数比較を廃止し、「課金APIを叩く fetch はすべて認証されている」という**性質そのものを走査する検査**へ書き換えた。緩めたのではなく強くしている。
- 検査を強くする過程で、初版が3件の変異を見逃した（コメントアウトされた認証を証拠と誤認する／文脈を行数で切って隣の fetch を巻き込む）。
  行コメントの除去と、fetch 第2引数の波括弧対応による切り出しで修正。
- 変異試験5件すべて検出：chat経路の認証をコメントアウト／STT経路をコメントアウト／TTSのアクセスコード付与を外す／無認証の課金fetchを1つ追加／認証を別変数へすり替え。
- 全体スイープ：**JS 54 suites・Python 36 suites 全緑**（既存失敗は解消）。

**Codexレビュー結果**：[BUILD277_SETUP_BREVITY_AND_AUTH_TEST_FOR_CODEX.md](BUILD277_SETUP_BREVITY_AND_AUTH_TEST_FOR_CODEX.md) — **P1修正後に承認**（8/19）

- P1（新設SessionInfoテストがリポジトリ直下からの実行で `FileNotFoundError`）は修正済み。`__file__` 基準へ変更。同ファイルの既存規約に合わせた。cwd依存はリポジトリ全体でこの1箇所のみだった。
- 追加で自分で見つけた穴：`tests-yagi-log-regressions.js` と `tests-five-day-access.js` が **`preflight.sh` から呼ばれていなかった**。発話が18秒に戻る変更も認証が抜ける変更も出荷ゲートを素通りする状態だった。両方を preflight に追加。
- 確認：リポジトリ直下 124/124 ／ `irsdk-bridge` 直下 124/124 ／ `./preflight.sh` ✅ 出荷可。
- P2（認証静的テストの限界：ブロックコメント・将来の別記法）は今回のBuildを止めない扱いでCodex判断。**ASTベースまたは明示的経路表への強化は未実施の残タスク**。

### 2026-08-20 Claude Code — Codexの質問への回答：Bridge exe のビルド手順

回答本文: [BRIDGE_EXE_BUILD_PROCEDURE_FOR_CODEX.md](BRIDGE_EXE_BUILD_PROCEDURE_FOR_CODEX.md)

- `desktop/bridge/OMORAY-PITWALL-Bridge.exe` が Git に無いのは**設計どおり**。CI が毎回生成して同梱し、成果物だけ出して捨てる。チェックアウト直後に空なのが正常。
- 生成は `windows-latest` / Python 3.12 / PyInstaller。**`.spec` は存在せず**、引数のみ（`--onefile --console --name OMORAY-PITWALL-Bridge`）。
- **2系統あり依存が違う**。Electron同梱用（`build-desktop.yml`）は `pygame` `pyaudio` を入れ `--hidden-import pygame` を付ける。Bridge単体用（`build-bridge.yml`）は付けない。**取り違えるとPTTが欠けたexeになる**。
- **PyInstallerはクロスコンパイル不可。Yujiの作業機はdarwinなので手元ビルドは不可能。** exe実物が要る時は `gh workflow run build-desktop.yml -f publish=false` でartifactを取る（配布物と完全同一）。
- 罠：`bridge.py` だけの変更では `build-desktop.yml` が**発火しない**（pushトリガーは `desktop/**` のみ）。`build-bridge.yml` だけ走るので**Actionsが緑でもElectron側は古いbridgeのまま**。Build 277でも実際に踏み、手動dispatchで解消。
- 罠：製品Build番号の出所は `irsdk-bridge/bridge.py:54` の `BUILD_VERSION` ただ一箇所。GitHubのrun番号ではない。

### 2026-08-24 Claude Code — Build 281 レビュー結果：**差戻し**

結果本文: [BUILD281_CLAUDE_REVIEW_RESULT.md](BUILD281_CLAUDE_REVIEW_RESULT.md)
対象: [BUILD281_GAP_FUEL_DEBRIEF_HAZARD_REVIEW_REQUEST.md](BUILD281_GAP_FUEL_DEBRIEF_HAZARD_REVIEW_REQUEST.md)

方向性は正しく、GAP経路の順序入れ替え（#1）とハザード優先度（#4）には問題を見つけられなかった。ただし**燃料P0ガードに、実行不可能な補正でP0を握り潰す経路が残っている**。

- **P1-1** `plan_fuel_authority.py:223` — 小口補正が `fuel_at_stop + corrected_add <= capacity` を検査していない。満タンで頭打ちの計画では推奨給油を増やしても搭載量が1滴も増えず、**補正が物理的に無効なままP0を抑止する**。`evaluate()` を実データ形状で直接呼んで再現済み（容量50L/給油前残1.5L/計画49L → 補正後の余裕は -0.1L のまま変化なし）。`capacity_fits` は `planned_add <= capacity` しか見ていない。
- **P1-2** `bridge.py:2953` / `2764` — `pit_events` のリセットが**片系統だけ**。`session_laps` は `_reset` と `_sig_reset` の両方で消えるのに `pit_events` は `_reset` のみ。前セッションのピット記録が生き残ると `buildCurrentSessionFactNote()` が「今回レースのBridge確定ピット記録・この記録だけを事実として使え」としてLLMへ注入する＝**捏造を止める仕組みが古い事実を今回の事実として断言させる**。`_session_scoped_reset_values()` へ入れて両系統から取るべき。
- **P2-1** `SMALL_SERVICE_CORRECTION_L` を 0.5→5.0（10倍）に緩めても **Python 261テストが全部通る**。本物の緊急を握り潰す唯一のレバーなのに境界テストが無い。
- **P2-2** `test_bridge_persists_small_top_up_into_the_later_box_plan` が `assertIn` の文字列一致のみで、書き戻しが実際に起きるかを検証していない。Build 277 で踏んだ失敗（`exit 1` の存在だけを見ていた）と同型。
- 追加（Buildは止めない）：GAP再構築ロジックが `local-intent-router.js:139` と `renderer.html:2253` に重複。router 側の `wantsBoth` 第2項が `!A && B && A` で**恒偽**の死んだ条件。
- 検証：`tests-local-intent-router.js` ✅ / `tests-telemetry-truth-gate.js` ✅ / Python **261 passed**（依頼文書の主張と一致）。変異試験2件はどちらも**検出されず**。
- commit / push / installer build / 公開はしていない。

### 2026-08-24 Codex — Build 281 Claude差戻し対応（再レビュー待ち）

対応本文: [BUILD281_CLAUDE_REVIEW_RESPONSE.md](BUILD281_CLAUDE_REVIEW_RESPONSE.md)

- **P1-1を修正**：小口補正後の実搭載量を容量上限込みで再計算し、補正後の物理的なfinish marginが0以上になる時だけP0を抑止する。満タン頭打ちで補正が無効なケースは`planned_service_correction_cannot_finish`としてP0を通す。
- **P1-2を修正**：`pit_events`を`_session_scoped_reset_values()`へ移し、SessionNum resetとSessionInfo signature resetの両方で、その単一reset値から代入する。
- **P2を修正**：-0.50L / -0.51Lの境界を実行テストに固定。文字列一致だった書き戻し検査を、本番helperを呼んでplanとsnapshotの燃料値更新を確認するテストへ置換。
- GAP routerの恒偽条件も削除。commit / push / build / 公開は未実施。Claude再レビュー待ち。

### 2026-08-24 Claude Code — Luna 自己訂正記憶 設計V1（**設計レビュー依頼・実装前**）

設計本文: [LUNA_SELF_CORRECTION_MEMORY_DESIGN_V1.md](LUNA_SELF_CORRECTION_MEMORY_DESIGN_V1.md)

Yuji発案：「Claudeは指摘されると記憶して方向転換できるが、Lunaにはそれが無い。**開発中は俺が訂正できるが、手を離れたら訂正者はドライバー本人しかいない**。この往復をLunaにもやらせたい」

- **実測**：`renderer.html:2100` の `sendFeedback()` は画面の文字を書き換えるだけで**どこにも保存していない**。サーバー側に受け口も無い。記憶が無いのではなく**材料を捨てている**。
- 既存記憶（`memory-action-layer.js`＝コース×車種の走行事実）とは**対象が違う**。既存は「ドライバーについての事実」、本設計は「Lunaがどう振る舞うべきか」。重複しない。
- 構造：①捕捉（決定論的文脈つき）→②集約（閾値・LLM不使用）→**③合意（Lunaが一度だけ言い直して確認）**→④保存→⑤適用→⑥可視化・撤回。**③が Yuji↔Claude の往復に相当し、これが無いものは会話ではなく一方通行の学習になる。**

**設計上の禁止4点（4節）**
1. **LLMに自分の反省を書かせない** — 間違った教訓を書いて永久適用する危険。教訓は決定論的観測（trigger/文字数/実測秒数/LapDistPct）から作る。
2. **一時の感情を恒久ルールにしない** — クラッシュ直後の「うるさい！」は状況への反応。同型が閾値回数溜まって初めて③へ。
3. **安全を黙らせない** — 調整できる軸を**閉じたホワイトリスト**（頻度・長さ・タイミング窓・口調）に限定。P0安全とBridgeの決定論的事実は訂正を受け付けない。ただし**拒否ではなく代案**を返す。
4. **事実を曲げない** — 教訓がBridgeの事実と矛盾したら必ず事実が勝つ。既存Truth Gateと同じ従属関係。

**Yujiの判断待ち4点（8節）**：保存先（ローカル/サーバー・プライバシーポリシー範囲）／確認を取るタイミング／閾値（初期案2回）／2階集合知への接続可否。

**未確定3点（10節）**：走行中の「長い」をSTTの揺れ込みで確実に拾えるか（八木さんログで「アンダーがニット」の崩れ実績あり・誤検出でルール化すると悪化）／訂正の対象特定（連続コール後は曖昧）／キャラクター変更時の引き継ぎ。

**Codexへの依頼**：実装前の設計レビュー。特に③合意ループの有無、ホワイトリストの閉じ方、誤った教訓を殺す機構（反証・時間減衰）の妥当性。commit / push / 実装はしていない。

## Codexレビュー結果

- 2026-08-12: Build 266初回候補を差戻し。上記「Build 266候補のCodex差戻し」7項目が未解決。

### 2026-08-12 Codex — 限定レビュー #1 / #5 / #3

レビュー本文: [BUILD266_REJECTION_1_5_3_CODEX_REVIEW.md](BUILD266_REJECTION_1_5_3_CODEX_REVIEW.md)

- **#5 日本語無線**はこの範囲で承認。`strategy_recalculation` は英語messageを読まず、未知reasonも日本語へ落とす。
- **#1 任意修理**は差戻し。ピット中の初観測・最大値保存はできたが、任意修理を取消して燃料だけで出た場合に、退出時の0を「修理完了」と誤認する。取消／未実施と実修理を別の権威証拠で区別し、Bridge経路の再生テストを追加すること。
- **#3 燃料・ペース逸脱**は差戻し。3周目のbaseline計算が今回lap timeの履歴追加より先なので、`baseline_pace_s` がNoneのまま固定される。また、`lap_time_hist` にpit in/out・incident・off-track周が入り、要件の「直近3〜5有効周」ではない。クリーン周を同一集合として基準・中央値に使うこと。
- 今回の限定テストは `52 Python + 41 Python + 28 JS` 全緑をCodexが再実行した。ただし上記の取消修理／クリーン3周／dirty lapの実走形状を再生しておらず、受入証拠には不足する。
- #2 / #4 / #6 / #7 と八木さんログ由来5項目は未着手のまま。Build 266は候補不可。commit / push / build / 公開はしない。

### 2026-08-12 Codex — P1三点の再レビュー

レビュー本文: [BUILD266_REJECTION_1_5_3_CODEX_REREVIEW.md](BUILD266_REJECTION_1_5_3_CODEX_REREVIEW.md)

- #1（任意修理取消）と#3a（基準確定順序）を、この限定範囲で承認。
- #3bは、**既存 `lap_time_hist` を温存し、Phase E専用のクリーン周履歴を別に持つ方式を正式に承認**。既存の残り周回推定等を変えず、Phase Eのbaseline／median／逸脱だけを同一クリーン周集合で扱う。
- Codex再実行: session state 65 tests、bridge wiring 51 tests、JP radio 28/28、Python compile、diff checkは全て通過。
- この承認は前回P1三点だけ。#2 / #4 / #6 / #7、八木さんログ由来5項目は未解決。Build 266は候補不可。commit / push / build / 公開はしない。
