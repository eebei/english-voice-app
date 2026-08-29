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
## 2026-08-25 Claude Code — スライス2/3/4：Memory→Strategy v1（**全ジャンル受入マトリクス付き**）

正本 `review/GAP_AUTHORITY_AND_MEMORY_TUNNEL_IMPLEMENTATION_BRIEF.md` §5 / §9 / §10。
**push / private build / deploy / 公開は未実施。**

### ★Codex へ：この作業を確認する前に読むこと（到達性の警告）

**この作業は `origin/main` に無い。** 2026-08-25 時点で `origin/main` は `828ca13`（Build 284）、
ローカル HEAD は `b5787f2` で **9 commit 先行**している。
**GitHub から取得すると、G5 も スライス2/3/4 も一行も見えない。**
同一マシンの作業ツリーを読むか、Yuji の push GO 後に取得すること。

**さらに、正本の指示書 `review/GAP_AUTHORITY_AND_MEMORY_TUNNEL_IMPLEMENTATION_BRIEF.md` は git 未追跡である。**
Yuji のファイルなので Gate 0（未追跡の利用者ファイルを混ぜない）に従い、こちらでは commit していない。
git checkout からは指示書そのものが見えない。**Yuji の判断が要る。**

#### 確認対象の commit（古い順）

| commit | 内容 |
|---|---|
| `86abb16` | G5：PTT質問GAPの出口（Build 284 P1） |
| `ff7066e` | G5 の報告を共有ログへ |
| `65867c0` | スライス2：Decision ID の一生 |
| `8891691` | スライス3：サーバー正本・訂正・削除 |
| `8de7aee` | スライス4：setup 前後比較 |
| `e950661` | スライス4b：pit / 燃費 |
| `02ecbb8` | スライス4c：全ジャンルの訂正・削除 |
| `b5787f2` | 本報告 |

#### そのまま流せる確認コマンド

```bash
git log --oneline 828ca13..HEAD
git diff --stat 828ca13..HEAD
node tests-gap-answer-queue.js && node tests-decision-memory-tunnel.js && node tests-decision-memory-server.js && node tests-session-memory-tunnel.js
python3 -m unittest discover -s irsdk-bridge -p 'tests_*.py' -t irsdk-bridge
./preflight.sh
node desktop/scripts/verify-packaged-runtime.js   # 旧asarでは decision-memory.js 欠落で落ちるのが正
```

#### 逆引きの入口（file:line）

| 見るもの | 場所 |
|---|---|
| 結合キーの生成と4段への搭載 | `irsdk-bridge/bridge.py` の `active_decision_id`（宣言 / 両リセット / 提案 / pit_timing / pit_cycle_outcome / session_summary ×2） |
| 採点の決定論 | `desktop/decision-memory.js` の `score_()` |
| 次回の自発発話と条件付き採用 | `desktop/decision-memory.js` の `briefingLine()` / `planAdvice()` |
| 出口の配線 | `desktop/renderer.html` の `kind:'decision_strategy_briefing'` / `kind:'decision_plan_advice'` |
| サーバー sanitize | `auth.js` の `sanitizeDecisionRecord()` |
| 同期が既定OFF | `desktop/renderer.html` の `decisionSyncEnabled()` |
| 訂正の対象特定 | `desktop/renderer.html` の `noteMemoryUtterance()` / `disputeRaceRecord()` |

### 実測して分かった中心的な事実

**足りなかったのは計測ではなく「結合キー」と「台帳」と「出口」だけだった。**

| 見つけた空欄 | 実態 |
|---|---|
| Decision の4段が繋がらない | Bridge は提案・pit exit・blend安定・session終了を**既に全部 broadcast していた**。結合キーが提案にしか無く、`score_execution()` の採点を毎回捨てていた |
| `record.pitEvents` | `session-memory.js` が読んでいたのに **renderer が一度も書いていなかった**＝`pitCount` が常に null の死んだ経路 |
| setup 比較 | `setupFingerprint` も `bestLap` も **既に `pw_raceHistory` に入っていた**。突き合わせる出口だけが無かった |
| 訂正・削除 | Decision 記録にしか無く、順位・天候・setup・pit の誤りは**止める手段が無かった** |

### 全ジャンル受入マトリクス（§10・空欄を残さない）

凡例：✅ 接続済 ／ ⚠ 部分 ／ ❌ 未接続

| ジャンル | source | 権威 | 保存 | 取得 | 判断 | 出力 | 採点 | 訂正/削除 | 証拠 |
|---|---|---|---|---|---|---|---|---|---|
| 1 レース結果・順位・周回・インシデント | ✅ | ✅ | ⚠ local のみ | ✅ | ✅ | ✅ 自発発話 | ✅ `finish_pos_confirmed` | ✅ | ✅ |
| 2 燃費・pit timing・pit loss・rejoin/blend | ✅ | ✅ | ✅ **本回で接続** | ✅ | ✅ | ✅ 自発発話 | ✅ blend順位 | ✅ | ✅ |
| 3 Plan A/B/C・undercut・baseline | ✅ | ✅ | ✅ server正本 | ✅ | ✅ 条件付き採用 | ✅ 自発発話 | ✅ | ✅ | ✅ |
| 3b splash（耐久最終給油） | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 4 成功/traffic失敗/fuel失敗/未実行/事故切断/不明 | ✅ | ✅ | ✅ | ✅ | ✅ 非推奨・再評価 | ✅ | ✅ 閉じたenum | ✅ | ✅ |
| 5 過去天候 | ✅ | ✅ | ⚠ local のみ | ✅ | ✅ | ✅ 質問回答 | N/A（事実） | ✅ | ✅ |
| 6 setup fingerprint・本人申告・valid lap | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 比較提示 | ✅ lap差 | ✅ | ✅ |
| 6b タイヤ/挙動評価 | ⚠ 会話のみ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 7 フィーリング・発話方針・呼称・情報量 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 8 Chief Engineer 引継ぎ | ✅ | ✅ | ✅ server | ✅ | ✅ | ✅ 無線 | ❌ | ❌ | ✅ |

**❌ を残した理由（推測で埋めない）**

- **ジャンル7（フィーリング・発話方針）は意図的に着手していない。** `renderer.html` の `sendFeedback()` は
  画面の文字を書き換えるだけで何も保存していない（実測で確認）。これは
  [LUNA_SELF_CORRECTION_MEMORY_DESIGN_V1.md](LUNA_SELF_CORRECTION_MEMORY_DESIGN_V1.md) の対象で、
  **Yuji の判断4点（保存先／確認タイミング／閾値／2階集合知への接続可否）が未決**。
  ここを勝手に決めて実装するのは Yuji の判断領域への越境になるため止めた。**判断待ち。**
- **6b タイヤ/挙動評価**：SDK はピット入庫時しかタイヤ温度を出さない（[[bug_tire_temp_stale]] で確定済）。
  走行中の評価は本人申告しか無く、申告から数値を作らない方針と両立する設計が未確定。
- **3b splash**：`endurance_fuel` 側にあり、Decision ID の lifecycle へ載せていない。次スライス候補。
- **8 の採点・訂正**：引継ぎは「次ドライバーへ届いたか」までは閉じているが、
  引継ぎ内容の正否を採点する基準が無い。基準を作らずに enum を付けない。
- **1/5 の保存が local のみ**：サーバー正本は Decision 記録だけに実装した。
  `pw_raceHistory` の server 化は privacy 文言（下記）の確定後に同 scope で行うのが筋。

### スライス2：Decision ID の一生（§5.1 / §9）

Bridge に結合キーを通し、desktop に決定論の台帳を置いた。

```
提案      radio/strategy_plan_decision  → active_decision_id を開く（根拠も同時に確定）
pit exit  pit_timing + score_execution  → 同じ id へ実行を追記
blend安定 pit_cycle_outcome             → 同じ id へ「効いたか」を追記
session終了 session_summary             → 同じ id へ closure（DNF・切断・途中終了も）
```

**採点は閉じた enum で、根拠が無ければ `unknown`。**

- 条件付き予測は、**その条件が実際に起きた時だけ**採点する（`PitCycleTracker` の既存規律に合わせた）
- 同順位維持は success とも failure とも証明できないので `unknown`
- 提案したが入らなかったものは `not_executed`。**失敗として次回の非推奨材料にしない**
- 切断・事故は `incident_or_disconnect`。実行の有無に関わらず採点材料を失っている

**失敗例は捨てずに使う。ただし判決ではなく「勧めない理由」として。**
復帰先が空いていれば `re_evaluate` へ変わる＝失敗記録で永久に封じない。

### スライス3：サーバー正本（§5.2 / §5.5）

- `strategy_decisions` テーブル。`owner_key`（`user:` / `beta:`）で認証主体を分離。
- **何を預かるかはサーバーが決める。** `sanitizeDecisionRecord()` が閉じた集合だけを通す。
  実測で確認：会話全文・raw telemetry・生音声・メールアドレス・自由文メモは**すべて落ちる**。
  訂正の note も保存しない（時刻だけ残す）。
- 保持期間90日。読み書きのたびに期限切れを**物理削除**。削除は tombstone を残さない。
- 表示 / 訂正(dispute) / 削除 / 全削除 の4本を同 scope に置いた。
- 同期の向き：サーバーが正本、localStorage は offline cache。`updatedAt` の新しい方を採る
  （別PCで走った結果を古い cache で潰さない）。

**★同期は既定 OFF（opt-in）。** 公開ページには現在
**「Telemetry never leaves your machine」**と書いてある。この文言を Yuji が改定するまで、
利用者データを機械の外へ出さない。実装の未完成ではなく、公開済みの約束を破らないための fail-closed。
**Gate 7 の文言改定は Yuji の判断待ち。** 承認まで opt-in を既定 ON にしない。

### スライス4：setup / pit・燃費 / 全ジャンル訂正

- **setup**：同一 track/car/series で fingerprint が違う2件の `bestLap` を比較して次回提示。
  本人申告は `source:'declared'` の**ラベルとしてのみ**持ち、**申告文から数値を作らない**
  （「1段柔らかく」を量として解釈しない）。SDK が出さない setup 値は推測しない。
- **pit・燃費**：`pitEvents` / `avgFuelPerLap` を `pw_raceHistory` へ保存し、死んでいた `pitCount` を生かした。
  **記録が無い時は null のまま**（「記録なし」を「0回」と言わない）。
- **訂正の対象特定**：直前に記憶から喋った物を1件だけ覚え、それを止める。
  何も喋っていなければ**推測で直近を止めず聞き返す**。
  設計V1が「未確定3点」に挙げていた「訂正の対象特定」への回答。

### 一本の trace（テストが実際に出力）

```
bridge_proposal  : id=snap-1:decision-lap:6 plan=B lap=6
bridge_pit_exit  : P8->P12 fuel_err=0.1
bridge_blend     : P4 condition_met=true
bridge_closure   : finish=P4 status=closed
scored           : success
next_retrieved   : 2026-08-24@Okayama
next_spoken      : 前回はP8から6周目にアンダーカット、ブレンド後P4。今日も燃料ウィンドウと復帰trafficが揃えば候補にする。
plan_adoption    : adopt (spoken)
```

失敗側も同じ trace で出る：

```
next_spoken : 前回は同じアンダーカットで復帰先のtrafficに捕まってP8からP12まで落ちた。今日も同条件なら早入りは勧めない。
same cond   : discourage
rejoin空き   : re_evaluate
```

### 変更ファイル

| ファイル | 内容 |
|---|---|
| `irsdk-bridge/bridge.py` | `active_decision_id` / `active_decision_plan`。4段すべてへ搭載。**両リセット経路** |
| `desktop/decision-memory.js` | **新規**。決定論の台帳（採点・選択・発話・訂正を持つ唯一の場所） |
| `desktop/session-memory.js` | setup比較、pit/燃費、disputed 除外 |
| `desktop/renderer.html` | 4段の捕捉、ブリーフィング出口2本、setup出口、訂正の振り分け、server同期 |
| `auth.js` | `strategy_decisions` テーブルと sanitize / 保存 / 取得 / dispute / 削除 |
| `server.js` | `/api/memory/decisions` 4本（すべて entitlement + rate limit） |
| `tests-decision-memory-tunnel.js` | **新規 74件** |
| `tests-decision-memory-server.js` | **新規 54件** |
| `tests-session-memory-tunnel.js` | 73 → **118件** |
| `preflight.sh` | 2本を出荷ゲートへ収録 |
| `irsdk-bridge/tests_strategy_plan_wiring.py` | 下記のとおり**性質検査へ書き換え**（緩めていない） |

**新規 runtime module は `decision-memory.js` 1本。** renderer の `<script src>` は7→8本になり、
`verify-packaged-runtime.js` が自動的に検査対象へ加えることを実測で確認した
（現 `desktop/dist` の旧 asar に当てると `missing packaged runtime modules: ... decision-memory.js` で落ちる＝**ゲートが機能している**）。

### 契約変更で書き換えたテスト（明記）

`tests_strategy_plan_wiring.py` の `Plan A/B decision is traced by decision id` は
`"'decision_id': _option_decision.get('decision_id')"` という**リテラル一致**だった。
結合キーを変数へ持たせたため落ちた。**守りたい性質は「決定が id で追える」ことで、変数名ではない。**
性質検査へ書き換え、さらに「broadcast した id と後段へ引き継ぐ id が同一であること」
「両リセット経路で消えること」の2項目を追加した。**緩めたのではなく強くしている。**

### 検証

| 項目 | 結果 |
|---|---|
| `tests-decision-memory-tunnel.js` | **74/74** |
| `tests-decision-memory-server.js` | **54/54** |
| `tests-session-memory-tunnel.js` | **118/118** |
| JS 全スイープ | ✅ **全緑**（失敗0） |
| Python | ✅ **305 passed** |
| `./preflight.sh` | ✅ 出荷可 |
| `git diff --check` | ✅ |
| 外部有料API呼出 | **0件** |

**変異試験 36件すべて検出**（スライス2で16・スライス3で11・スライス4で9）。主なもの：

- 条件が起きていない予測も採点する／同順位維持を success と断定する／未実行を採点対象にする
- disputed を使い続ける／合意なしで訂正を適用する／別ユーザーの記録を使う
- client が送ったものをそのまま預かる（会話・音声が混入）／body の識別子を信用する（なりすまし）
- **既定で同期を有効にする（公開済みの約束を破る）**／id 欠落を全削除と解釈する
- sig_reset で結合キーを消さない／session終了を保存しない（DNFを失う）
- **発話せず LLM 注入だけにする**／pit回数を発話に含めない／記録なしを「0回」と言う
- 出所で振り分けず常にDecisionを止める／**特定できなくても推測で直近を止める**

### 途中で見つけた自分の欠陥（自己申告）

初版は変異2件を**見逃した**。

1. **N13「発話せず LLM 注入だけにする」** — 配線検査が `renderer.html` の生文字列を見ていたため、
   `speak()` を**コメントアウトしても検出できなかった**。Build 277 で自分が指摘した型そのもの。
   `tests-five-day-access.js` と同じ規約で行コメントを除去してから検査する形へ修正。
2. **S4「特定できなくても推測で直近を止める」** — `if(!target) return null;` の存在だけを見ていたため、
   日付照合を外して直近を掴む変異が素通りした。本番の `disputeRaceRecord` を vm で**実行する**形へ修正。

どちらも「文字列があること」を「性質が守られていること」と取り違えた同じ誤り。

### 未確認（field evidence）

- **Windows実機・iRacing実走とも未実施。** Decision の4段が実走で本当に同じ id へ揃うかは、
  `pit_cycle_tracker` の条件成立を含めて**実データでしか確認できない**。
- **サーバー側は未デプロイ。** `auth.js` / `server.js` を変更したので、deploy 後は
  `./verify-deploy.sh` が必須。DB マイグレーション（`strategy_decisions`）は `init()` 内の
  `CREATE TABLE IF NOT EXISTS` なので初回起動で作られるが、**本番での実行は未確認**。
- **Gate 5 は取り直し。** Build 284 artifact は `decision-memory.js` を含まない。
- 同期は既定 OFF のため、**サーバー正本の実挙動（別PC間の共有）は未検証**。
  privacy 文言確定後の実測が必要。

### Yuji の判断待ち（3点・こちらでは決めない）

1. **privacy / terms の文言改定**（Gate 7）。現行「Telemetry never leaves your machine」を、
   戦略要約をサーバーへ預ける opt-in 機能と整合させる必要がある。**承認まで同期は既定 OFF のまま。**
2. **ジャンル7（フィーリング・発話方針の記憶）**の設計V1・判断4点。
3. **3b splash / 6b タイヤ挙動**を次スライスに含めるか。

### Codex への確認依頼（出口→入口の逆引き）

1. 4段の結合キーが、**セッション跨ぎ・SessionNum変更・signature変更**で確実に切れるか
2. `unknown` を「使わない」で正しく閉じているか（過剰に黙る経路になっていないか）
3. サーバー sanitize を回避して会話全文や raw telemetry が保存できる経路が残っていないか
4. opt-in が OFF の状態で、**どこか1経路でも外部送信が起きないか**
5. 「それ違う」の対象特定が、別の記録を巻き添えにする経路を持たないか
6. package：`decision-memory.js` が完成 asar に入ることを次 candidate の実物で確認

## 2026-08-25 Claude Code — G5：Codex Build 284 P1 対応（PTT質問GAPの出口）

commit `86abb16` のみ。**push / private build / deploy / 公開は未実施。**
**この commit は `origin/main`（`828ca13`）に無い。** GitHub からは見えないので、
同一マシンの作業ツリーを読むか push GO 後に取得すること（詳細は上のスライス2/3/4節の到達性の警告）。

### Codex の指摘は正しかった（コードで確認）

`renderer.html:2163` の `speak()` に `gapIdentity` が無い。自発コール（`renderer.html:4023`）は
`data.gap_identity` を渡しているのに、**PTT回答だけが素通り**していた。
回答生成時の 5 秒契約（G3）は満たしていたが、`回答 → queue → TTS開始` の出口は誰も見ていなかった。

### 契約を意図的に分けた（最重要の設計判断）

自発と回答へ同じ判定を当てると、**Build 281 の「値があるのに答えない」を再発させる**。

| | 自発 `gap_trend` | 質問 `nearest_gap` |
|---|---|---|
| 主張の性質 | 「**あの車**に対して2.6秒開いた」＝特定対象への時間差分 | 「**今**、後ろは何秒」＝時点の事実 |
| 対象車が交代 | **破棄**（主張ごと無効） | **最新値へ作り直す**（いま後ろにいる車が答え） |
| 古さの基準 | 候補の `sampled_at` | **現在 snapshot の年齢** |
| 値が消えた | 破棄 | その方向だけ落とし、残りは答える |

回答側で対象車交代を破棄にすると、ドライバーの質問が無応答で終わる。`⑧` と `M10` で固定した。

### 変更ファイル

| ファイル | 内容 |
|---|---|
| `desktop/gap-freshness.js` | `evaluateAnswer()` / `rebuildAnswerText()` 追加。**既存 `evaluate()` は無改変**（自発の契約を動かさない） |
| `desktop/local-intent-router.js` | `gapIdentityFor()` / `gapAnswer()`。**両方の GAP 分岐**が identity を返す |
| `desktop/renderer.html` | `sendMsg` → `speak(gapIdentities)` → queue item → `drainQueue` で照合 |
| `tests-gap-answer-queue.js` | **新規 44件**。renderer 本体を抽出して実行する統合再生 |
| `preflight.sh` | 出荷ゲートへ収録 |

**新規 runtime module なし**（既存3本の変更のみ）。renderer の `<script src>` は7本のまま＝package 対象に変化なし。

### Codex 受入条件4の再生（写経ではなく本番コードを実行）

`tests-speak-async.js` の前例に倣い、`desktop/renderer.html` から本番の
`sendMsg` / `speak` / `drainQueue` を抽出し、本物の `local-intent-router.js` と
`gap-freshness.js` を `window.*` として読み込んで vm で実行した。
**ドライバー発話 → router → speak() → queue待ち6秒 → drainQueue → TTS開始**を一列で流している。
TTS へ実際に渡された文（fetch body の `text`）を読んで判定するので、文面の作り直しが本当に届いたかを見ている。

```
② 質問時 3.8秒 → 6秒待機 → 実測 0.6秒 → 再生 "後ろ0.6秒。"   旧3.8は出ない
④ 前後同時。前だけ 5.5→0.7 → "前0.7秒、後ろ3.8秒。"          片側だけ古く残らない
⑤ 前の値が消失 → "後ろ3.8秒。"（reason=direction_dropped）    消えた方向の旧値を言わない
⑥ snapshot 自体が9秒古い → 破棄（live_snapshot_stale）        古い数字を喋らない
⑦ session_key 変化 → 破棄                                     別セッションの数字にしない
⑧ 対象車 31→44 → "後ろ1.2秒。"                                無応答にしない
⑨ Practice（権威レコード無し）→ 答える／動けば作り直す        G4 の非権威経路を殺さない
⑩ module 欠落 → 破棄                                          Build 281 の package 漏れ対策
```

### 検証

| 項目 | 結果 |
|---|---|
| `tests-gap-answer-queue.js` | **44/44**（新規・preflight収録） |
| JS 全スイープ | ✅ **全緑**（失敗0） |
| Python | ✅ **305 passed** |
| `./preflight.sh` | ✅ 出荷可 |
| `git diff --check` | ✅ |
| 外部有料API呼出 | **0件** |

**変異試験 10件すべて検出**：`sendMsg` が identity を渡さない（＝Codex が見つけた元の欠陥そのもの）／
`speak` が queue item へ載せない／`evaluateAnswer` を常に play にする／回答側だけ14秒へ緩める／
session 変更を無視／消えた方向で旧値を残す／値変化で作り直さない／module 欠落を素通り／
router の第2分岐だけ identity を落とす／対象車交代で破棄（質問に答えなくなる）。

**M1 が検出されることが要点。** Codex が指摘した欠陥を戻すとテストが落ちる状態にしてある。

### 未確認（field evidence）

- **Windows実機・iRacing実走とも未実施。** queue 待ちの実際の長さ、作り直した文の自然さ、
  Practice での挙動は実走でしか確認できない。
- Build 284 artifact はこの変更を**含まない**。Gate 5 は次候補で取り直しになる。
- `physical_traffic_gap` の実GTP/GT3 fixture 再生は未着手のまま（§4-2）。

### Codex への確認依頼

1. 自発と回答で契約を分けた判断が妥当か（対象車交代で回答を破棄しないこと）
2. `liveAgeMs` の出所が `lastTelemetryAt` で正しいか（別の時刻源が要るか）
3. 前後同時質問で片側 discard・片側 rebuild が混ざる経路が残っていないか
4. `nearest_gap_stale`（生成時）と `live_snapshot_stale`（再生時）の二重判定に矛盾が無いか

## 2026-08-25 Claude Code — Build 284 private candidate 完成（**署名は Codex 待ち**）

### Build 番号を 283 → 284 へ

283 の artifact は `6c17a9e` で既に検査済み。そこから **12ファイル / 1,830行**が変わっているため番号を上げた。
同じ番号で中身が違う状態は、282 で無効化した事故と同じ形になる。

### 実物検査（すべて Claude Code が自分で計算した値）

```
target_sha 828ca13 = HEAD                                ✅
build-info {"buildNum": 284}                             ✅
installer  100,641,922 bytes  SHA-256 e237e0c336d11643…  ✅ manifest と一致
app.asar   4,191,225 bytes    sha256 edd7fc26ae27dd62…   ✅ manifest と一致
Bridge.exe 17,013,169 bytes   sha256 2199c6aa23dff434…   ✅ manifest と一致
3本の installer は同一ハッシュ（latest が古い版を指す事故なし）  ✅
```

**app.asar 内の JS 全件（実物を展開して列挙）**

```
/cost-meter.js  /fuel-plan-guard.js  /gap-freshness.js   ← G2 で新設
/local-intent-router.js  /main.js  /memory-action-layer.js
/preload.js  /session-memory.js     ← スライス1で新設   /strategy-playbook.js
```

検証スクリプトを実物へ適用 → **必須7本すべて欠落なし**。

### Gate 進捗

| Gate | 状態 |
|---|---|
| 0 変更範囲 | ✅ 未追跡の利用者ファイルは混ぜていない |
| 2 package 対象 | ✅ renderer 参照7本すべて |
| 3 機械検証 | ✅ JS全緑 / Python 300 / preflight 出荷可 / diff --check / 秘密混入なし |
| 4 P0/P1 | ✅ 0件 |
| 5 artifact | ✅ **実物検査完了。ただし下記の但し書き** |
| 6 Windows | ⏸ Yuji |
| 7 server | 対象外（サーバー側変更なし・`./verify-deploy.sh` 不要） |
| 8 iRacing実走 | ⏸ Yuji |
| 9 公開 | **未実施** |

### ★署名を埋めていない理由

`PITWALL_RELEASE_GATE.md` 絶対ルール：

> 同じAIが作業と確認を兼任した場合は**独立確認済みとしない**。

**GAP修正（G1〜G4）は Claude Code が実装した。** よって上記は**作業者による自己検査**であり、
ゲートが要求する独立確認ではない。Build 282/283 とは役割が逆（あの時は Codex 実装・Claude 確認）。

**Codex の独立確認が必要。** 逆引きで反証してほしい点：

1. `authoritative` が True の poll で、EstTime の残り値が本当に消えているか（G4）
2. 再生側（`gap-freshness.js` 5秒）と質問側（`local-intent-router.js` 5秒）が実際に同じ基準か（G3）
3. `observe()` が権威の後ろで動いているか＝自発コールと質問回答が同じ数字か（G1b）
4. Practice / Qualifying で GAP が全面沈黙していないか（G4 の `authoritative=False` 経路）
5. package 欠落（`gap-freshness.js` / `session-memory.js` の実物同梱）

### 公開について

**publish=false**（push 起動のため公開ステップの条件を満たさない）。
**Gate 6（Windows）と Gate 8（iRacing実走）が未実施**のため、この artifact は配布可能な状態ではない。
GAP修正9本が実際に効くかは**実走でしか分からない**。

## 2026-08-25 Claude Code — G4：S/F 跨ぎ（§4-4）／**GAP側 §4 は §4-2 を除き完了**

### G1 の配線に残っていた穴

```python
if _applied['ahead_gap'] is not None:          # 権威が黙った方向は
    nearest_ahead_gap = _applied['ahead_gap']  # EstTime の値が生き残る
```

**S/F 跨ぎで符号が反転するのは、まさにその EstTime の値。**
権威が「矛盾しているので喋るな」と判断しても、**旧値が残っていればそれが喋られていた**。
G1 の時点でこの穴に気づいていなかった。

### 修正

Race で standings が取れているなら、**権威がその poll の唯一の出所**にする。

```python
if _applied['authoritative']:
    # 確認できなかった方向も None で上書きする
    nearest_ahead_gap  = _applied['ahead_gap']
    nearest_behind_gap = _applied['behind_gap']
```

破棄時はログに残す（`dropping unconfirmed ahead gap (est=1.2)`）。**黙った理由が追えないと実走で原因が分からない。**

### Practice を巻き込まない条件

`authoritative` は **standings が実際に取れていて、自分のクラス順位が有効な時だけ True**。
Practice / Qualifying や F2 配列欠損の poll では False になり、EstTime 値を消さない。
**常に True にすると standings が使えないセッションで GAP が全面沈黙する**（変異 I2 で固定）。

### 内部テスト（実挙動）

```
[通常]     ahead=5.5 idx=12 / behind=3.0 idx=31
[S/F跨ぎ]  ahead=None（誤方向を喋らない） / behind=3.0
           trace: direction_conflict_rank_vs_physical
           authoritative=True → bridge が ahead を None で上書き
[Practice] authoritative=False → EstTime値を消さない
```

**矛盾した方向だけが黙り、正常な後方は喋り続ける。** 片方の異常で全部黙るのは過剰なので方向ごとに判定する。

### 検証

| 項目 | 結果 |
|---|---|
| `tests_gap_authority.py` | **41/41**（36 → +5） |
| Python 全体 | ✅ 300 passed |
| JS 全スイープ | ✅ 全緑 |
| `./preflight.sh` | ✅ 出荷可 |
| 外部有料API呼出 | **0件** |

**変異試験 4件すべて検出**：EstTime残り値を引き継ぐ／権威を常に名乗る（Practiceも黙る）／矛盾方向にも値を入れる／破棄をログに残さない。

### 指示書 §4 の到達点

| # | 内容 | 状態 |
|---|---|---|
| 1・3 | dashboard値一致／EstTime矛盾で誤方向を言わない | ✅ G1 |
| **4** | **S/F 跨ぎで前後が逆転しない** | ✅ **G4** |
| 5・6 | 対象車交代・session変更で破棄 | ✅ G1+G2 |
| 7・8・9 | queue鮮度・14秒の旧数値・値変化後の旧値 | ✅ G2 |
| 10 | PTT質問が no-data へ落ちない | ✅ G3 |
| **2** | 異クラス接近の**実データ再生** | **△ 種別分離のみ・実データ待ち** |

### §4-2 が残る理由（実データが要る）

`SOURCE_PHYSICAL_TRAFFIC` の定数と「同クラス順位GAPと混ぜない」契約は入っているが、
**GTP が後方から接近する実データでの再生は未実施**。合成 fixture では
「対象class・car index・方向・数値が一致する」ことの実証にならない。保存ログの入手が前提。

### 未確認（field evidence）

**Windows実機・iRacing実走とも未実施。** G1〜G4 はすべて決定論層の契約であり、
実走での対象車選択・破棄・作り直しの妥当性は実データでしか確認できない。

commit のみ。**push / private build / deploy / 公開は未実施。**

## 2026-08-25 Claude Code — G3：PTT質問の鮮度と no-data 防止（§4-10 / §3.3 最終項）

### 見つけた不整合

`TELEMETRY_STALE_MS = 12000`（接続判定）のままだったため、**GAPの質問に最大12秒古い値で答えうる**状態だった。
G2 で再生側を 5 秒にしたので、**queue では破棄される古さの値を質問回答では喋る**という食い違いが生まれていた。

```
再生側（G2）  5秒超 → 破棄
質問側（旧）  12秒まで答える  ← 抜け道
```

質問側も 5 秒へ揃え、**両方の GAP 分岐**に入れた（片方だけだと抜け道が残る）。

### 動作

```
新鮮(1s) → {"intent":"nearest_gap","reply":"後ろ5.8秒。"}
古い(9s) → {"intent":"nearest_gap_stale","reply":"いまのGAPは取れていない。少し待って。"}
未指定   → {"intent":"nearest_gap","reply":"後ろ5.8秒。"}
```

**年齢が渡されない時は従来どおり答える（fail-open）。** 呼び出し側が古さを判断できない状況で黙らせると、
Build 281 と同じ「値があるのに答えない」を作ってしまう。**古さが分かる時だけ fail-closed。**

`nearest_gap_unavailable`（値が無い）と `nearest_gap_stale`（古い）を**区別**する。原因が違うため同じ文言にしない。

### §4-10 の回帰（Build 281 実走欠陥）

```
✅ live値があれば答える: 後ろとの差は？ / 前とのギャップは？ / 前後のギャップは？
✅ live値があれば答える: パンで後ろとの差。   ← STT揺れ
✅ no-data文言へ落ちない（全件）
```

### 検証

| 項目 | 結果 |
|---|---|
| `tests-gap-freshness.js` | **70/70**（50 → +20） |
| JS 全スイープ | ✅ 全緑 |
| Python | ✅ 300 passed |
| `./preflight.sh` | ✅ 出荷可 |
| `git diff --check` | ✅ |
| 外部有料API呼出 | **0件** |

**変異試験 5件すべて検出**：質問側の鮮度検査を外す／質問側だけ12秒へ緩める／片方の分岐だけ検査する／
stale時に数字を混ぜる／renderer が年齢を渡さない。

**H2（質問側だけ緩める）を検出できることが要点。** 再生側と質問側の基準が揃っていること自体をテストで固定したので、
片方だけ緩む事故が再発しない。

### 指示書 §4 の進捗

| # | 状態 |
|---|---|
| 1・3・5・6 | ✅ G1/G1b |
| 7・8・9 | ✅ G2 |
| **10** | ✅ **G3** |
| 2 異クラス接近の実データ再生 | △ 種別分離のみ |
| **4 S/F跨ぎ** | ⏸ **残り1つ** |

commit のみ。**push / private build / deploy / 公開は未実施。**

## 2026-08-25 Claude Code — G2：再生直前の鮮度照合（指示書 §2.2 / §3.3 を閉じた）

### 動線

```
Bridge    gap_trend へ gap_identity を積む
          telemetry snapshot へ現在の権威（照合相手）を載せる
              ↓
renderer  injectRadio → speak → queue item が identity を保持
              ↓
drainQueue ★TTS開始の直前に照合
              ├ 対象車 / 方向 / session / 世代が変わった → 破棄
              ├ 5秒超（closed constant）                → 破棄
              ├ 現在値が取れない                        → 破棄
              ├ 値だけ変わった                          → **最新値で作り直す**
              └ 一致                                    → 再生
```

### 実走欠陥の再現（指示書 §4-7/8/9）

| 実走 | 結果 |
|---|---|
| **queue 14,742ms 後に旧「前5.5秒」を再生** | ✅ 破棄（`age_exceeded`） |
| **5.5 → 0.7 へ変化**（19:14:16→19:14:24） | ✅ 旧値を再生せず「前0.7秒。」へ作り直す |
| **3.8 → 0.6 へ変化**（19:11:59→19:12:00） | ✅ 「後ろ0.6秒。」へ作り直す |
| 追越しで対象車交代 | ✅ 破棄（`target_car_changed`） |

境界は `MAX_AGE_MS = 5000` を closed constant にし、**5000ms ちょうどは再生・5001ms は破棄**を固定。

### 設計判断

- **値が変わったら黙るのではなく最新値で言い直す。** 同じ車・同じ方向なら正しい数字を言う方が役に立つ。
  対象車・方向が変わった時だけ破棄する。
- **module 欠落は破棄扱い。** Build 281 の package 漏れを踏まえ、モジュールが無い時に素通り
  （＝古い数字をそのまま再生）させない。変異 F8 で固定。
- **破棄しても queue を止めない。** `draining=false; isSpeaking=false;` の後に次へ進む。
  ここを誤ると1回の破棄で以後全部黙る事故になるためテストで固定。

### 途中で見つけた既存テストの欠陥（自己申告）

`tests_gap_trend_wiring.py` が **900文字の固定窓**でレースガードを判定しており、
候補へ identity を足しただけで落ちた。**ガードは残っているのに窓から押し出されただけ**で、
行が増えるたびにズレる書き方だった（Build 277 の「回数で守る」と同型）。

窓ではなく**ネスト構造**で判定する形へ書き換え、さらに
`if True or (...)` による無効化と、broadcast をガード階層まで下げる変異の**両方**を検出できるようにした。

### 検証

| 項目 | 結果 |
|---|---|
| `tests-gap-freshness.js` | **50/50**（新設・preflight収録） |
| `tests_gap_authority.py` | 36/36 |
| Python 全体 | ✅ **300 passed** |
| JS 全スイープ | ✅ 全緑 |
| `./preflight.sh` | ✅ 出荷可 |
| `git diff --check` | ✅ |
| 外部有料API呼出 | **0件** |

**変異試験 10件すべて検出**：年齢判定を外す／最大年齢を14秒へ緩める／対象車交代を無視／方向反転を無視／
値変化を無視して旧値再生／現在値無しでも再生／renderer が照合しない／module欠落を素通り／
bridge が identity を積まない／snapshot に権威を載せない。

### 指示書 §4 の進捗

| # | 内容 | 状態 |
|---|---|---|
| 1・3 | dashboard値一致 / EstTime矛盾で誤方向を言わない | ✅ G1 |
| 5・6 | 対象車交代・session変更で破棄 | ✅ G1+G2 |
| **7・8・9** | queue鮮度・14秒の旧数値・値変化後の旧値 | ✅ **G2** |
| 2 | 異クラス接近の実データ再生 | △ 種別分離のみ |
| 4 | S/F 跨ぎ | ⏸ 未着手 |
| 10 | PTT質問が no-data へ落ちない | ⏸ 未着手 |

### 未確認

**Windows実機・iRacing実走とも未実施。** `gap-freshness.js` は renderer 参照のため、
次Buildで完成asar検査の自動対象になる。実走での破棄・作り直しの妥当性は実データでしか確認できない。

commit のみ。**push / private build / deploy / 公開は未実施。**

## 2026-08-25 Claude Code — G1b：二重権威を閉じた（前回報告の訂正を含む）

### 前回報告の訂正

「G1完了」と報告したが、**指示書 §2.1 の半分しか閉じていなかった**。同じ poll 内の実行順序が原因。

```
5234  EstTime が gap / idx を決める
5352  gap_call_policy.observe()   ← ★自発コールはここ。EstTime値を読む
5712  standings_by_pos 構築
5742  権威レコード適用             ← ★質問回答（telemetry snapshot）はここから
```

G1 で直したのは**質問回答側と対象車IDの取り残し**だけで、**19:11:59「後ろ3.8秒」は自発コール**なので
その経路は EstTime を読んだままだった。悪化はしていないが、未解決を完了と報告したのは誤り。

### 移動前に確認したこと（前提を鵜呑みにしない）

- **依存の洗い出し**：`_gap_event` / `_gap_generation` / `_gap_now` / `_gap_session_key` /
  `flush_radio` / `_update_gap_live_context` を移動区間 390 行の全行で検索。**該当はコメント1行のみ**、機能的依存ゼロ。
- **ブロック構造**：移動元・移動先とも `if (player_car_idx >= 0 and onTrack and not onPit and not in_formation …)`（`bridge.py:5205`）の中で indent 12 のまま有効。
  **権威ブロック（indent 24）の中へ入れると Practice/Qualifying で動かなくなる**ため、そこは避けた。
- **設計意図との整合**：`bridge.py:3430-3433` に既に
  「A held GAP sentence must not be released against the previous poll's adjacent-car snapshot.
  The current poll refreshes that snapshot in the GAP block below, then calls flush_radio().」
  とある。**保留GAPは更新後スナップショットで再検証してから解放する**設計。
  今回そのスナップショット自体が権威値になったので、**設計意図により忠実になった**。
  `_update_gap_live_context()` と `flush_radio()` を observe と一緒に動かしたのはこのため。

### 変更後の順序

```
5712  standings_by_pos 構築
5715  権威レコード適用
5741  _update_gap_live_context()  ← 権威値
5752  flush_radio()               ← 権威値で保留GAPを再検証
5756  gap_call_policy.observe()   ← ★権威値。質問回答と同じ数字
```

### 順序を固定するテストを追加

移動しただけでは戻りうるので、**行番号で順序を固定**した。

- 権威 < `observe()`
- 権威 < `_update_gap_live_context()`
- context更新 < `flush_radio()`

**変異試験で、旧構造へ戻すと落ちることを確認済み。**

### 検証

| 項目 | 結果 |
|---|---|
| `tests_gap_authority.py` | **36/36**（33 → +3） |
| Python 全体 | ✅ **297 passed** |
| `tests_bridge_poll_replay.py` | ✅ 19（poll loop 実再生） |
| JS 全スイープ | ✅ 全緑 |
| `./preflight.sh` | ✅ 出荷可 |
| `git diff --check` | ✅ |
| 順序変異 | ✅ 検出 |

**指示書 §2.1（二重の数値権威）はこれで閉じた。** §2.2（Renderer queue の陳腐化）は G2 として次に着手する。

commit のみ。**push / private build / deploy / 公開は未実施。**

## 2026-08-25 Claude Code — G1（GAP数値権威）実装完了

指示書 [GAP_AUTHORITY_AND_MEMORY_TUNNEL_IMPLEMENTATION_BRIEF.md](GAP_AUTHORITY_AND_MEMORY_TUNNEL_IMPLEMENTATION_BRIEF.md) の §2.1／§3.1／§3.2 に対応。
§3.3（queue鮮度）は G2 として未着手。

### 指示書の主張をコードで独立確認した（前提を鵜呑みにしない）

| 行 | 実態 |
|---|---|
| `bridge.py:5229-5233` | EstTime が gap と **idx** を決める |
| `bridge.py:5337-5349` | `gap_call_policy.observe()`（自発コール）は EstTime 値を読む |
| `bridge.py:5729-5731` | `standings_gaps`(F2Time) が **gap 値だけ**を `abs()` で上書き |
| 同上 | **`nearest_ahead_idx` / `nearest_behind_idx` は更新されない** |
| その後 | telemetry snapshot（質問回答）は F2 上書き後の値を読む |

**指示書の診断は正しかった。** 自発コールと質問回答が別の数字を使い、対象車IDは EstTime 時点で取り残される。
19:11:59「後ろ3.8秒」と DATA CHECK `gapBehind:0.6` の食い違いは、この構造がそのまま出たもの。

### 変更ファイル

| ファイル | 内容 |
|---|---|
| `irsdk-bridge/gap_authority.py` | **新規**。決定論のみ・SDK非依存。値／方向／対象車を同時確定する権威レコード |
| `irsdk-bridge/tests_gap_authority.py` | **新規 33件** |
| `irsdk-bridge/bridge.py` | `standings_by_pos` に car_idx を持たせ、値だけの `abs()` 上書きを廃止。両リセット経路 |
| `preflight.sh` | 出荷ゲートへ収録 |

### 契約

- **値と対象車を同じ場所から取る**：`standings_by_pos[pos] = {'car_idx', 'signed_gap_s'}`
- **`abs()` を先に取らない**：方向確定後に表示値だけ正数化。`signed_gap_s` も保持
- **矛盾は fail-closed**：順位（class position）と物理位置（符号）が食い違えば `speakable=False` ＋ 理由を trace。値だけ使わせない
- **generation**：対象車・方向・session が変われば進む。G2 の破棄判定の土台
- **種別分離**：`same_class_battle_gap` と `physical_traffic_gap` を一つの変数へ混ぜない
- **セッション境界**：`_reset` と `_sig_reset` の**両方**で破棄（Build 281 P1-2 の教訓）

### 実装途中で自分の欠陥を1件直した（自己申告）

初版は判断ロジックを `bridge.py` 側に置き、テストが**文字列検査**だった。
変異 G1f（値だけ上書きへ戻す）が**すり抜けた**。Build 277／281／282 で私が指摘してきた型を自分でやっていた。

判断を `gap_authority.apply_same_class_records()` へ移し、**挙動で検査**する形へ変更。
bridge 側は結果を代入するだけになり、同じ変異が検出されるようになった。

### 検証

| 項目 | 結果 |
|---|---|
| `tests_gap_authority.py` | **33/33** |
| Python 全体 | ✅ **297 passed**（264 → +33） |
| JS 全スイープ | ✅ 全緑 |
| `./preflight.sh` | ✅ 出荷可 |
| `git diff --check` | ✅ |
| 外部有料API呼出 | **0件** |

**変異試験 9件すべて検出**：方向矛盾でも喋る／`abs()` を先に取る／対象車無しで喋る／世代を進めない／
対象車を適用しない／喋れない方向でも値を適用／trace を残さない／bridge が idx を代入しない／sig_reset で消さない。

### 指示書 §4 必須再生テスト10本の進捗

| # | 内容 | 状態 |
|---|---|---|
| 1 | 同クラス前後が安定・dashboard値と一致 | ✅ G1 |
| 2 | 異クラス接近で class/idx/方向/数値が一致 | ✅ 種別分離まで（実データ再生は G2 以降） |
| 3 | EstTime と順位の矛盾で誤方向を喋らない | ✅ G1 |
| 4 | S/F 跨ぎで前後が逆転しない | ⏸ 未着手 |
| 5 | 追越しで対象車交代→旧候補破棄 | ✅ generation まで（破棄は G2） |
| 6 | pit/順位jump/incident/session変更で破棄 | ✅ session 変更のみ |
| 7〜9 | queue 鮮度・14秒の旧数値・値変化後の旧値 | ⏸ **G2** |
| 10 | PTT質問が no-data へ落ちない | ⏸ 未着手 |

### 未確認

- **Windows実機・iRacing実走とも未実施。** G1 は決定論層の契約であり、実走での対象車選択の妥当性は
  実データ再生（G2 の fixture）と実走でしか確認できない。
- `physical_traffic_gap` は定数と分離契約のみで、**異クラス接近の実データ再生は未実施**。

commit のみ実施。**push / private build / deploy / 公開は未実施。**

# 2026-08-25 JST — Yuji GO: GAP数値権威＋Memory出口完成

Claude Codeは次の正本を全文確認し、実装担当として着手してください。

- `review/GAP_AUTHORITY_AND_MEMORY_TUNNEL_IMPLEMENTATION_BRIEF.md`

今回の最優先実走欠陥は、GAPデータ有無ではなく、二重計算・対象車ID不整合・Renderer queue陳腐化による誤数値／前後逆転です。Virログの19:11:59と19:14:16〜19:14:31を再生証拠として固定しています。

同じ候補で、未搭載だったDecision ID、成功・失敗採点、サーバー正本、次回の決定論的自発発話、当日Planへの条件付き採用、setup/過去天候、訂正・削除までをTunnel Completion Ruleに従って接続します。

commitは変更単位ごとに可能。push / private build / deploy / 公開はYujiの別GOまで禁止です。完了後は本共有ログへ証拠を追記し、Codex独立確認へ回してください。

---

## 2026-08-25 Codex — Build 284 independent review: **P1差戻し / 出荷不可**

対象ソースSHA: `828ca13`（Build 284）。Build、push、公開は行っていない。

### 独立に再実行した結果

- `python3 -m unittest irsdk-bridge/tests_gap_authority.py irsdk-bridge/tests_gap_trend_wiring.py irsdk-bridge/tests_bridge_poll_replay.py` — **67 passed**
- `node tests-gap-freshness.js` — **70/70**
- `node tests-local-intent-router.js` — **38/38**
- `node tests-chat-http.js` — **54/54**（ローカルポートを用いるため、隔離外で実行）
- `node tests-require-admin.js` — **9/9**
- `./preflight.sh` — **出荷可**
- `git diff --check 6c17a9e..828ca13` — **合格**。外部有料API呼出なし。

### P1 — PTTで質問したGAPは、TTS開始直前の鮮度確認を通っていない

`renderer.html` は自発GAP無線の `data.gap_identity` を `speak()` に渡し、queue取り出し直後に
`PitwallGapFreshness.evaluate()` で再検証している。これは正しい。

ただし、PTTの直接質問は `localIntent` から `speak(reply, {...})` する際に `gapIdentity` を渡していない。
そのため質問時点では5秒以内でも、先行発話でqueue待ちになった後に古い数値のまま再生され得る。
「再生側と質問側を同じ5秒にする」というBuild 284の受入条件を、回答生成時だけ満たしており、
**回答→queue→TTS開始の出口まで満たしていない。** `tests-local-intent-router.js` もこのqueue経路を再現していない。

修正受入条件:

1. `nearest_gap` のPTT回答にも、Bridgeの `gap_authority` 由来の対象車・方向・session・generationをqueue itemへ渡す。
2. queue待ち中に対象車／方向／session／generationが変われば破棄、同一対象で数値だけ変われば現在値へ再構成する。
3. 前後同時質問も、片側の旧値を残さない形で扱う。
4. 「質問→先行発話で6秒待機→TTS開始」を再生する統合テストを追加し、古い数値が再生されないことを固定する。

### 未署名のGate

- Gate 4: 上記P1が0件ではないため**不合格**。
- Gate 5: Build 284の完成artifactはローカルに無く、CI artifact / app.asarを確認者が実物で独立検査できていないため**未署名**。
- Gate 6 Windows、Gate 8 iRacing実走: **未実施**。
- `physical_traffic_gap` の実GTP/GT3 fixture再生は未完。今回の「異クラスの物理的接近を正しく話す」までを合格とはしない。

## 2026-08-26 Claude Code — **Gate 6 のチェック自体が壊れていた → Build 286 で作り直し**

証拠本文: [BUILD286_GATE5_PRIVATE_ARTIFACT_EVIDENCE.md](BUILD286_GATE5_PRIVATE_ARTIFACT_EVIDENCE.md)

### 見つけた欠陥（Gate 6 に入る前に、Gate 6 の項目自体を検証して出た）

`PITWALL_RELEASE_GATE.md` Gate 6「起動ログに必要moduleのloaded / missing状態が記録され、全てloadedである」。
その実装 `reportRuntimeModuleStatus()` が **5本のハードコード**だった。

```
検査していた   : memory-action-layer / strategy-playbook / fuel-plan-guard / cost-meter / local-intent-router
見ていなかった : session-memory / decision-memory / gap-freshness   ← 今回の新機能そのもの
```

**`decision-memory.js` が読み込めなくても `status:'loaded'` と報告する。**
Build 281（package漏れ）、Build 282 P1-2（CI検査の2本ハードコード）と同型で、
**Gate 6 が偽の合格を出す**状態だった。

### asar 検査があるのに、なぜこれが要るのか（別の失敗を捕まえる）

| 検査 | 捕まえるもの |
|---|---|
| asar 展開（Gate 5） | ファイルが **package に入っていない** |
| 起動時 module 診断（Gate 6） | ファイルは入ったが **評価に失敗して global が生えない** |

後者はまさに最新コードで起きうるもので、そこだけが素通りだった。

### 修正

自分の `<script src>` から派生させる。9本目を足しても自動で対象になる。
本番関数を抽出して実行し、**8本を1本ずつ欠けさせて `missing` が出ること**を実挙動で確認。
`tests-runtime-module-status.js` **10/10**・`preflight.sh` 収録・変異試験2件検出。

### Build 285 → 286

この修正で `renderer.html` が変わったため、**Codex が独立確認済みの Build 285 artifact は中身が古くなった。**
同一番号で中身違いは Build 282 で証拠を無効化した事故と同じ形なので、**286 へ上げて作り直した。**
Build 285 の証拠書には supersede 注記を入れた（**285 に対する記録としては有効**）。

### Build 286 実物検査（すべて Claude Code が自分で計算した値）

| 項目 | 値 |
|---|---|
| target_sha | `88517124f0868436b00d312d718c495d096411f1` |
| run | [32911905149](https://github.com/eebei/english-voice-app/actions/runs/32911905149)（`workflow_dispatch` / `publish=false` / success・headSha 一致） |
| artifact | `OMORAY-PITWALL-Desktop-Build-286-20260825-2342`（301,989,583 bytes） |
| installer | 100,660,198 / `4d87c3e436cb8428…`（**3本すべて同一ハッシュ**） |
| app.asar | 4,253,139 / `28c6026a0df25f96…` |
| Bridge | 17,014,431 / `660eea44dcf7836e…` |
| build-info | `{"buildNum": 286}` |

CI manifest は runner の自己申告なので**証拠に採らず独立計算 → 3件とも一致**。
runtime module **8/8 欠落なし**。CRLF 正規化後、**9ファイルすべて HEAD と一致**。
実物 asar 内で旧ハードコード列挙が **0箇所**、派生検査が入っていることを確認。
Bridge から zlib 展開で **`Build 286` を検出**（`Build 285` は無し）／`pygame` 52件＝正しい系統。
`Publish to Release` **skipped**、公開 Release は 2026-06-30 のまま、`origin/main` は `828ca13` のまま。

### ★署名は埋めていない

作業者と確認者が同一のため。**Codex の独立確認を依頼する**（逆引き6点は証拠本文 §8）。
特に「§0 の派生検査が 1本ずつ欠けさせた時に必ず missing を出すか」を反証してほしい。

### Gate 6 の実施手順は証拠本文 §9 に書いた

installer の入手先、SHA-256、SmartScreen の扱い、確認9項目を記載。
**新設の #6**：診断ログの `RUNTIME_MODULE_STATUS` が
`"status":"loaded"` / `missing:[]` かつ **modules に8本すべて**並ぶこと。
5本しか並んでいなければ古い版を掴んでいる。

## 2026-08-26 Claude Code — Build 285 private artifact 生成・実物検査完了（**superseded**）

証拠本文: [BUILD285_GATE5_PRIVATE_ARTIFACT_EVIDENCE.md](BUILD285_GATE5_PRIVATE_ARTIFACT_EVIDENCE.md)

### 所在

| 項目 | 値 |
|---|---|
| target_sha | `c6db9f4a1ae2cc22828408b456da3a2b1c9dd190` |
| run | [32858968763](https://github.com/eebei/english-voice-app/actions/runs/32858968763)（`workflow_dispatch` / `publish=false` / success） |
| run の headSha | `c6db9f4…`（**target_sha と一致**） |
| artifact | `OMORAY-PITWALL-Desktop-Build-285-20260825-1422`（301,985,895 bytes） |
| ref | `build/285` |

**`origin/main` は動かしていない（`828ca13` のまま）。**
CI は GitHub 上の ref しかビルドできないため push は必須だったが、指示書の
「`origin/main` へ push を独断で行わない」に従い、**Yuji の選択（ブランチ方式）で
`build/285` だけを push** した。ビルド後にブランチを消せば完全に戻せる。

### 実物検査（すべて Claude Code が自分で計算した値）

```
installer  100,659,008 bytes  sha256 c55f7f7b12cc17c8…   3本すべて同一ハッシュ ✅
app.asar     4,252,147 bytes  sha256 e550a9379ff72946…
Bridge.exe  17,013,753 bytes  sha256 19cfd0c6c3272fb0…
build-info  {"buildNum": 285}
```

CI 同梱の `BUILD-285-GATE5-MANIFEST.json` は**runner の自己申告なので証拠に採らず**、
独立に計算して突合した → **3件とも一致**。

**app.asar 内の JS 全件（実物を展開して列挙）**

```
cost-meter.js  decision-memory.js ← Build 284 には無かったもの
fuel-plan-guard.js  gap-freshness.js  local-intent-router.js
main.js  memory-action-layer.js  preload.js
session-memory.js  strategy-playbook.js
```

renderer の `<script src>` から派生した検査（ファイル名をハードコードしない）で
**8/8 欠落なし**。

### 途中で出た「不一致」を、慌てず原因特定した

同梱 JS を HEAD と突き合わせたところ **9ファイル全部が不一致**になった。
原因は Windows runner のチェックアウトによる **CRLF**（`decision-memory.js` で CR 421個 対 0個）。
改行を正規化して再比較し、**9ファイルすべてバイト単位で一致**を確認した。

### Bridge 実行体：`strings` で出ないことを「入っていない」と読まなかった

`strings` では `Build 285` が出ない。PyInstaller がバイトコードを zlib 圧縮するためである。
推測で済ませず、**埋め込まれた zlib ストリーム 416本を実際に展開**して確認した。

| 探した文字列 | 結果 |
|---|---|
| `Build 285` | **✅ 実在**（`Build 284` は無し） |
| `active_decision_id` / `decision_plan` / `strategy_plan_decision` | **✅ 実在** |
| `pygame` 52件 / `pyaudio` 2件 | ✅ **Electron同梱用の正しい系統**（PTT が欠ける取り違えなし） |

### Publish がスキップされた証拠

| 確認 | 結果 |
|---|---|
| `Publish to Release` ステップ | **skipped** |
| 公開 Release `desktop-latest` | **2026-06-30T10:37:33Z / assets 242 のまま** |
| push トリガーで併走した run `32858953256` | `Publish to Release` → **skipped** |

**公開・latest URL 更新・利用者配布はいずれも行っていない。**

### target_sha での再実行

Decision tunnel **74/74** ／ server **54/54** ／ Session memory **118/118** ／
GAP answer queue **44/44** ／ deploy verification **28/28** ／ `./preflight.sh` **出荷可** ／
Python **305 passed** ／ `git diff --check` ✅ ／ 外部有料API **0件**。

### ★署名は埋めていない

`PITWALL_RELEASE_GATE.md`「同じAIが作業と確認を兼任した場合は独立確認済みとしない」。
スライス2/3/4 と G5 は Claude Code が実装したので、上記は**作業者の自己検査**である。
**Codex の独立確認を依頼する**（逆引き5点は証拠本文 §8）。

### これで言えないこと

- **Gate 6 Windows 未実施。** installer を実行していない。
- **Gate 7 server 未反映。** `/api/memory/decisions` は本番に存在しない。
  deploy 後の `./verify-deploy.sh` は必須で、**SHA一致だけでは合格にならない**
  （`strategy_decisions` のマイグレーション失敗を経路の応答で検出する）。
- **Gate 8 実走 未実施。** Decision ID の4段が実走で同じ id へ揃うか、
  翌日の自発 Memory 発話が出るかは実データでしか確認できない。
- 本検査は **artifact が target_sha の中身を含むことの証拠**であって、
  **実走で正しく動くことの証拠ではない。**

## 2026-08-25 Claude Code — Gate 5〜8 の前提整備（Codex独立確認を受けて）

commit `8641ee5`。**push / build / deploy / 公開は未実施。**

Codex の独立確認（P0/P1 なし・下記セクション）を受け、**GO 不要でできる前提整備**だけを行った。

### ① Build 番号を 284 → 285 へ

Build 284 の artifact は既に存在し、Codex が実物を検査して P1 差戻しを出している
（SHA-256 `e237e0c3…`）。そこから **15ファイル / 2,984行** 変わっているため、
同じ番号で中身の違う artifact を作ると **Build 282 で証拠を無効化した事故と同じ形**になる。

`irsdk-bridge/bridge.py:58` を `Build 285 (decision memory, server ledger and gap answer freshness)` へ。

### ② `verify-deploy.sh` が SHA しか見ていなかった（Gate 7 の穴）

**これは今回の変更で初めて危険になった。** スライス3で `auth.init()` に
`CREATE TABLE strategy_decisions` を足したため、**マイグレーションが失敗しても
プロセスは起動する**。その時：

```
/api/version        → 正しい SHA を返す      → verify-deploy.sh は「✅ 一致」
/api/memory/decisions → 503 auth_unavailable → 記憶APIは永久に死んでいる
```

**Build 281（SHAは合っていたが module が入っていなかった）と同じ型**を、
今度はサーバー側で作るところだった。

対応：未認証のまま経路を叩き、応答で状態を区別する。**認証情報は使わない。**

| 応答 | 判定 |
|---|---|
| **401 / 403** | ✅ 経路が生きていて認証も効いている（**これが正常**） |
| 404 | ❌ 経路が無い＝この版がまだ本番に入っていない |
| 503 | ❌ auth/DB 未準備＝テーブル作成の失敗を疑う |
| **200** | ❌ **認証が外れている＝重大** |

SHA が一致していても経路が死んでいれば `exit 1` にした。

### 契約変更で書き換えたテスト（明記）

`tests-deploy-verification.js` の `一致なら成功する（exit 0）` が落ちた。
**契約が「SHA一致で成功」から「SHA一致 かつ 経路が生きていて成功」へ変わったため**で、
実装に合わせて緩めたのではない。スタブサーバーに経路の応答を持たせ、
新契約へ書き換えたうえで**事故ケース3件を追加**した
（SHA一致でも 404 / 503 / 200 なら失敗する）。

### 検証

| 項目 | 結果 |
|---|---|
| `tests-deploy-verification.js` | **28/28**（19 → +9） |
| JS 全スイープ | ✅ 全緑 |
| Python | ✅ 305 passed |
| `./preflight.sh` | ✅ 出荷可 |
| `git diff --check` | ✅ |

**変異試験 5件すべて検出**：SHA一致で即成功に戻す（経路確認を飛ばす）／404を正常扱い／
503(DB未準備)を正常扱い／認証が外れた200を正常扱い／記憶APIを確認対象から外す。

### 残る Gate と、それぞれに必要な GO

| Gate | 状態 | 必要なもの |
|---|---|---|
| 0〜4 | ✅ Codex 独立確認済（P0/P1 0件） | — |
| 5 artifact | ⏸ | **push GO → build GO**（現HEADから再生成し、`decision-memory.js` の同梱を実物で確認） |
| 6 Windows | ⏸ | Yuji の取得・ACK |
| 7 server | ⏸ | **deploy GO**（`auth.js` / `server.js` 変更あり）→ `./verify-deploy.sh` |
| 8 iRacing実走 | ⏸ | Yuji の実走 |
| 9 公開 | ⏸ | 別GO |

**Gate 7 は今回から `strategy_decisions` の DB マイグレーションを含む。**
deploy 後の `./verify-deploy.sh` は必須で、SHA一致だけでは合格にならない。

### Codex の記述で1点確認したいこと

独立確認セクションの最終行に
「**だが上記P1を残したままBuild 284を利用者テスト候補・出荷可とは扱わない**」とあるが、
同セクションに P1 の記載は無く、判定は「入口→出口は接続済み」となっている。
**前セクション（Build 284 の P1差戻し）からの残り文と思われる。**
こちらでは Codex の記述を書き換えないので、意図を確認したい。
現時点では「Build 284 の P1 は G5（`86abb16`）で解消済み、現HEADに未解決 P1 は無い」と読んでいる。

## 2026-08-25 JST — Codex独立確認（現行HEAD `2bee942`）

Yujiの「mdを確認。GO」に基づき、Claude実装後の現行HEADを独立再検査した。

### 実行証拠

| 検査 | 結果 |
|---|---|
| `./preflight.sh` | **✅ 全ケース合格（出荷可表示）** |
| Decision Memory tunnel | **74/74** |
| Decision Memory server正本 | **54/54** |
| Session Memory tunnel（setup/pit/fuel/訂正/削除を含む） | **118/118** |
| GAP answer queue（PTT→queue→TTS直前再検証） | **44/44** |
| `/api/chat` HTTP統合 | **54/54** |
| requireAdmin | **9/9** |
| Python GAP/bridge関連 | **67 passed** |
| `git diff --check` | **✅** |
| 外部有料API呼出 | **0件** |

### 逆向きに確認できた出口

- `strategy_plan_decision` → Decision ID → pit/blend/checker（または途中終了）→ outcome採点 → 次回briefingの決定論的発話／条件付きPlan根拠。
- 成功だけでなく `traffic_failure`、`fuel_failure`、`not_executed`、`incident_or_disconnect`、`unknown` を同じDecision IDで扱うfixtureがある。
- setup変更、pit/fuel、過去天候、driver申告、訂正／disputed／削除の経路をsession-memory/decision-memoryのテストで確認。
- PTT `nearest_gap` は対象車・方向・session・generation・sampled_atをqueueへ運び、TTS開始直前に旧値を破棄または最新値へ再構成する。前後同時質問もfixtureに含む。

### まだ出荷証拠ではないもの

- 現行HEADは `origin/main` に未到達。**push / private Build / deploy / 公開は未実施**。
- 現行HEADから再生成したartifactのGate 5検査が必要。
- Gate 6（Windows取得・ACK）、Gate 7（本番 `/api/version` 反映）、Gate 8（実iRacing走行）は未実施。
- 実走でのGAP数値一致、停止／コースアウト車両の適切な発話、翌日自発Memory発話はfixture合格だけでは断定しない。

**判定：ソース／ローカル統合の入口→出口は今回の実装で接続済み。出荷可否はartifact再生成後のGate 5〜8を通してから確定する。**

## 2026-08-25 JST — Claude向けBuild 285 private artifact引き渡し指示

### 目的

現行HEADのMemory→Strategy全ジャンル接続、Decision ID採点、訂正／削除、GAP PTT鮮度修正を含む状態から、**Build 285のprivate artifactだけを作成し、独立検査へ渡す**。

### 固定対象

- 対象SHA：作業開始時の現行HEADを記録する（現在の候補は `9f5f5eb` 系列）。
- **Build 282の既存artifact（SHA `81a912b...`）は検査対象に戻さない。**
- artifact内に `decision-memory.js`、`session-memory.js`、`gap-freshness.js`、`local-intent-router.js`、`fuel-plan-guard.js`、`cost-meter.js` とBridge実行体が存在すること。

### Claudeが実施すること

1. 対象SHA、ビルド番号285、workflow run、生成日時を記録。
2. Windows向けprivate installerを再生成する。公開Release・latest URLへのPublishはしない。
3. app.asarを展開し、rendererから参照される全runtime moduleとBridgeの同梱を実物検査。
4. installer／app.asar／Bridgeのサイズ・SHA-256を記録。
5. `preflight.sh`、Decision tunnel、Session memory tunnel、GAP answer queue、deploy verificationを対象SHAで再実行。
6. Gate 5 evidenceを `review/BUILD285_GATE5_PRIVATE_ARTIFACT_EVIDENCE.md` に作成し、以下を明記する。
   - 対象SHAとBuild番号
   - artifact名と取得元
   - packaged runtime moduleのmissing list（空であること）
   - app.asar／Bridge／installerのhash
   - Publishがskipされた証拠
   - Gate 6 Windows、Gate 7 server、Gate 8 iRacing実走、Gate 9公開は未実施であること
7. 完了後、artifactの所在と証拠をこの共有ログへ追記する。

### 禁止

- Build 282 artifactをBuild 285として報告しない。
- `origin/main`へpush、server deploy、公開Release、利用者配布を独断で行わない。
- artifactがない状態でGate 5合格、実走可能、出荷可と断定しない。

### Codex独立確認後の順序

ClaudeのGate 5 evidenceをCodexが対象SHAとartifact内部で再確認する。その後、別途明示GOがあればGate 6（Windows取得・ACK）、Gate 7（server反映確認）、Gate 8（実走）へ進む。公開は最後の別GOとする。

## 2026-08-26 JST — Codex Build 285 Gate 5独立再確認

Claudeの `review/BUILD285_GATE5_PRIVATE_ARTIFACT_EVIDENCE.md` を自己申告のまま採用せず、GitHub Actions run `32858968763` からprivate artifactを再取得して検査した。

| 確認 | 結果 |
|---|---|
| run headSha | `c6db9f4a1ae2cc22828408b456da3a2b1c9dd190`（証拠書記載と一致） |
| ref | `build/285`（`origin/main`はBuild 284のまま） |
| installer 3本 | **同一SHA `c55f7f7b12cc17c89929c2d26a494323d7eb16dcb3cc5c1b71716c984608e043`** |
| app.asar | **SHA `e550a9379ff7294681b90344e534ae8e1fe4f21b849a7baf075d4011570897f3`** |
| Bridge exe | **SHA `19cfd0c6c3272fb091c6b016ed0a4102c8908fca58b470b8b6fefe7e45a96535`** |
| `build-info.json` | `buildNum: 285`, tag `20260825-1422` |
| runtime modules | **8/8存在、missing 0**（decision/session/gap/local/fuel/cost/memory/strategy） |
| sourceとの突合 | CRLF正規化後、renderer＋8 runtime全ファイル **MATCH** |
| workflow | success、`publish=false`、公開Release変更なし |

### 判定

**Gate 5 artifactはCodex独立確認済み。** Claudeの報告値と実物が一致した。

未実施は引き続き以下。

- Gate 6：Windowsで取得・インストール・起動・ACK
- Gate 7：`auth.js`／`server.js`を本番へ反映し、`verify-deploy.sh`でSHAとmemory API経路を確認
- Gate 8：iRacing実走（GAP数値、Memory自発発話、Decision IDの実走結合）
- Gate 9：公開

artifactはprivateのまま。Codexはpush、deploy、公開を行っていない。

G1/G2の自発GAP経路そのもの（同一frame authority、EstTime残留抑止、queue直前再確認）の設計と単体再生は確認できた。だが上記P1を残したままBuild 284を利用者テスト候補・出荷可とは扱わない。

## 2026-08-26 JST — Build 286正式引き渡し指示

Build 285はGate 6のmodule診断が5本ハードコードだったため確認対象から除外する。Claudeが派生検査へ修正した**Build 286**を正式候補とする。

Claudeは `review/BUILD286_GATE5_PRIVATE_ARTIFACT_EVIDENCE.md` に、対象SHA、workflow run、artifact名、installer／app.asar／Bridgeのhash、Publish skip、runtime module欠落0を記録し、Codex独立確認へ渡すこと。Build 285 artifactの再利用は禁止。

進行順は次のとおり。

1. Gate 5：CodexがBuild 286 artifactを独立再計算。
2. Gate 6：YujiがWindowsで取得・起動・8本の`RUNTIME_MODULE_STATUS`・ACK確認。
3. Gate 7：server反映後に`verify-deploy.sh`でSHAだけでなくmemory API経路とDB migrationを確認。
4. Gate 8：YujiがiRacing実走でGAP数値、Memory自発発話、Decision ID結合を確認。
5. Gate 9：上記完了後に公開判断。

Build 286も、artifact検査だけで「実走済み」「公開可」と断定しない。

## 2026-08-26 JST — Claude/Codex連携の再質問禁止プロトコル

担当と順序が共有MDで確定したGateについて、担当AIはYujiへ同じ選択を再質問しない。

### 現在の固定分担

- Claude：Build artifact生成、検査ツール、自己検査、証拠MD更新。
- Codex：Gate 5 artifactの独立完走・合否記録。
- Yuji：Gate 6 Windows取得・起動・ACK、Gate 8実走。Gate 7のdeploy GOとGate 9公開GOのみ判断。

### 運用規則

1. 担当が自分のGateを完了していない場合は、Yujiへ選択肢を投げず作業を継続する。
2. 他担当のGate待ちなら、`待ち／担当／阻害理由／次の入力`をMDへ1回記録し、再質問しない。
3. Gate 5がCodex担当の間、ClaudeはGate 7・次Build・未決設計を勝手に進めず、artifact証拠と引き渡しを整える。
4. Yujiへの確認は、Yuji本人の操作が必要なGate 6・8、または明示GOが必要なGate 7・9に限定する。
5. 作業終了時は必ずMDを更新し、チャットには「MD更新済み／現在地／Yujiの次操作1つ」だけを報告する。

これにより、同じGateの担当確認をYujiが仲介する伝書鳩状態を禁止する。

## 2026-08-26 JST — Claude作業終了時の必須MD報告

以後、Claudeは作業を終えたらチャットだけで「完了」と言わず、必ず共有MDへ最終報告を追記すること。

### 必須報告項目

1. 作業日時（JST）と担当。
2. 対象SHA、ブランチ、Build番号。
3. 実装／変更ファイルと変更内容。
4. 実行したテスト名・件数・終了コード。
5. artifactを作成した場合：workflow run、artifact名、取得元、installer／app.asar／Bridgeの実測hash、runtime module欠落数。
6. Gate 0〜9を、**合格／未実施／保留**で個別に記載。
7. push、deploy、公開、Windows確認、iRacing実走の有無を明記。
8. 未完了項目と、次に実行する担当者・手順。
9. 「実装済み」「内部テスト済み」「artifact確認済み」「実走済み」「公開済み」を混同しない明示。

### 完了文の禁止

証拠MDが更新されていない状態で、チャット上だけの「完了」「出荷可」「実走可能」は禁止する。artifactがClaude自己検査だけの場合は、**Codex独立確認待ち**と書く。Gate 6以降が未実施なら、その事実を最後の行にも再掲する。

## 2026-08-26 JST — Claude Code 作業終了報告（Build 286）

「作業終了時の必須MD報告」規約に従う。

### 1. 作業日時と担当

2026-08-25 〜 2026-08-26 JST。実装担当 Claude Code。独立確認担当 Codex。

### 2. 対象

| 項目 | 値 |
|---|---|
| ブランチ HEAD | `c44c7024a8bda36ebd623b8740cd354b8a18283d` |
| **artifact の対象SHA** | **`88517124f0868436b00d312d718c495d096411f1`** |
| ブランチ | `build/286`（`origin/main` は `828ca13` = Build 284 のまま） |
| Build 番号 | **286**（`Build 286 (decision memory, server ledger and derived runtime module diagnostics)`） |

**ブランチ HEAD と artifact の対象SHA は別物である。** artifact は `8851712` から生成され、
その後に証拠書 commit `c44c702` が乗っている。**artifact に `c44c702` の内容は入っていない。**

### 3. 実装・変更ファイル

| ファイル | 内容 |
|---|---|
| `irsdk-bridge/bridge.py` | Decision ID 結合キー（`active_decision_id` / `active_decision_plan`）を提案・pit exit・blend・session終了の4段へ搭載。両リセット経路。`BUILD_VERSION` 286 |
| `desktop/decision-memory.js` | **新規**。Decision 台帳（採点・選択・発話・訂正・削除）。数字と採点を持つ唯一の場所 |
| `desktop/session-memory.js` | setup 前後比較、pit/燃費、disputed 除外 |
| `desktop/gap-freshness.js` | `evaluateAnswer()` / `rebuildAnswerText()`（PTT回答の出口） |
| `desktop/local-intent-router.js` | GAP 回答へ identity を付与（両分岐） |
| `desktop/renderer.html` | 4段の捕捉、ブリーフィング出口3本、訂正の振り分け、server同期、**起動時module診断を派生化** |
| `auth.js` | `strategy_decisions` テーブル、sanitize、保存/取得/dispute/削除、保持期間90日 |
| `server.js` | `/api/memory/decisions` 4本（PUT/GET/POST dispute/DELETE。すべて entitlement + rate limit） |
| `verify-deploy.sh` | SHA 一致に加え、未認証で経路を叩いて 401/404/503/200 を区別 |
| `preflight.sh` | 新規4本を出荷ゲートへ収録 |
| `irsdk-bridge/tests_strategy_plan_wiring.py` | リテラル一致 → 性質検査へ書き換え（緩めていない） |

### 4. 実行したテスト（件数・終了コード）

| テスト | 件数 | exit |
|---|---|---|
| `tests-runtime-module-status.js` | 10/10 | 0 |
| `tests-decision-memory-tunnel.js` | 74/74 | 0 |
| `tests-decision-memory-server.js` | 54/54 | 0 |
| `tests-session-memory-tunnel.js` | 118/118 | 0 |
| `tests-gap-answer-queue.js` | 44/44 | 0 |
| `tests-deploy-verification.js` | 28/28 | 0 |
| Python discover（irsdk-bridge） | 305 tests | 0 |
| `./preflight.sh` | 出荷可 | 0 |
| `git diff --check` | — | 0 |
| JS 全スイープ | 全緑（失敗0） | — |

**変異試験 累計 48件すべて検出。** 外部有料API呼出 **0件**。

### 5. artifact

| 項目 | 値 |
|---|---|
| workflow run | `32911905149`（`workflow_dispatch` / `publish=false` / success） |
| run の headSha | `88517124f0868436b00d312d718c495d096411f1`（対象SHAと一致） |
| artifact 名 | `OMORAY-PITWALL-Desktop-Build-286-20260825-2342`（301,989,583 bytes） |
| 取得元 | `https://github.com/eebei/english-voice-app/actions/runs/32911905149` |
| installer | 100,660,198 bytes / `4d87c3e436cb8428727bbffbf11356eeb9f7609427ab40fd377ed2b6c0679f13`（3本すべて同一） |
| app.asar | 4,253,139 bytes / `28c6026a0df25f9690c3e4fede6a17b00afaaf00b722dafe8f42386d756604f4` |
| Bridge | 17,014,431 bytes / `660eea44dcf7836e5738c033ce2e9562aef115830f7cd10e9bb7561e608757f5` |
| **runtime module 欠落数** | **0**（renderer 参照 8/8 同梱） |
| build-info | `{"buildNum": 286}` |
| Publish | **skipped**（公開Release `desktop-latest` は 2026-06-30 のまま） |

hash はすべて Claude Code が実物を展開して自分で計算した。CI manifest は自己申告として扱い証拠に採っていない。

### 6. Gate 0〜9

| Gate | 判定 |
|---|---|
| 0 変更範囲 | **合格**（artifact の出所 `8851712` に未追跡の利用者ファイルは無い。§8 の但し書きを参照） |
| 1 失敗の固定 | **合格** |
| 2 package 対象 | **合格**（renderer 参照 8/8） |
| 3 機械検証 | **合格**（§4） |
| 4 P0/P1 | **合格**（Build 285 時点で Codex 独立確認 0件。以降の差分は module 診断の派生化1件のみ） |
| 5 artifact | **保留 — Claude 自己検査のみ。Codex 独立確認待ち** |
| 6 Windows | **未実施** |
| 7 server | **未実施** |
| 8 iRacing 実走 | **未実施** |
| 9 公開 | **未実施** |

### 7. push / deploy / 公開 / Windows / 実走の有無

| 操作 | 実施 |
|---|---|
| commit | **あり**（`build/286` 上） |
| push | **あり — `build/286` ブランチのみ。`origin/main` は動かしていない**（Yuji のブランチ方式選択に従った） |
| private build | **あり**（`publish=false`） |
| server deploy | **なし** |
| 公開 Release / 利用者配布 | **なし** |
| Windows 実機確認 | **なし** |
| iRacing 実走 | **なし** |

### 8. 未完了項目と次の担当・手順

| # | 項目 | 担当 | 手順 |
|---|---|---|---|
| 1 | Gate 5 独立確認 | **Codex** | Build 286 artifact を再取得し hash・module 欠落・Bridge の `Build 286` を自分で再計算。逆引き6点は証拠本文 §8 |
| 2 | Gate 6 Windows | **Yuji** | 証拠本文 §9 の手順。**`RUNTIME_MODULE_STATUS` に8本すべてが並び `missing:[]`** であること |
| 3 | Gate 7 server | **Yuji の deploy GO 後に Claude** | `auth.js`/`server.js` は `build/286` にしかない。本番反映には `origin/main` への push が必要。deploy 後 `./verify-deploy.sh`（SHA だけでなく経路と DB migration） |
| 4 | Gate 8 実走 | **Yuji** | GAP 数値の dashboard 突合、翌日の Memory 自発発話、Decision ID の4段結合 |
| 5 | Gate 9 公開 | **Yuji** | 上記完了後 |

#### ★報告すべき自分のミス（Gate 0 の但し書き）

証拠書 commit `c44c702` で `git add review/` を使い、**未追跡だった利用者ファイルを巻き込んだ**。

- `review/james-radio-review/**`（mp3 / zip **34ファイル**）
- `review/store-build239-screenshot.png`
- 未追跡だった各種 brief / plan の MD（`GAP_AUTHORITY_AND_MEMORY_TUNNEL_IMPLEMENTATION_BRIEF.md` を含む）

**artifact への影響は無い**（`8851712` から生成されており、`c44c702` は artifact の後）。
ただし「未追跡の利用者ファイルを混ぜない」という Gate 0 の規律に反した。
**Yuji の判断待ち**：(a) このまま残す ／ (b) バイナリ34件だけ untrack ／ (c) 巻き込んだ全件を untrack。
なお brief MD は git に入ったことで、GitHub から読む Codex にも見えるようになった。

#### その他の未決（既報）

- **privacy / terms 文言改定**（Gate 7 対象）。決着まで**サーバー同期は既定 OFF** のまま。
- **ジャンル7（フィーリング・発話方針の記憶）は未着手**。設計V1の判断4点が未決のため踏み込んでいない。

### 9. 到達段階の明示（混同しない）

| 段階 | 状態 |
|---|---|
| 実装済み | **✅ 済**（スライス2/3/4・G5・module診断） |
| 内部テスト済み | **✅ 済**（§4。すべて exit 0） |
| artifact 確認済み | **⚠ Claude の自己検査のみ。Codex 独立確認待ち** |
| Windows 確認済み | **❌ 未実施** |
| 実走済み | **❌ 未実施** |
| 公開済み | **❌ 未実施** |

**Gate 6・7・8・9 はいずれも未実施である。**
本報告は「artifact が対象SHAの中身を含むことの証拠」までであり、
**実走で正しく動くことの証拠でも、出荷可の宣言でもない。**

## 2026-08-26 JST — Codex再確認（Build 286報告の形式・ソース回帰）

Claudeが必須報告項目（SHA、変更、テスト、artifact、Gate 0〜9、push/deploy/公開、未完了担当）を本MDへ追記していることを確認した。

Codex側の再実行：

- `node tests-runtime-module-status.js`：**10/10、exit 0**
- `./preflight.sh`：**exit 0、全ケース合格**
- renderer参照runtime **8本**、欠落検出の各変異テストを確認
- Build 286 workflow headSha：`88517124f0868436b00d312d718c495d096411f1`
- `origin/build/286`：同SHA

### 現時点の判定

作業終了報告のMD記録は合格。ソース回帰も合格。ただしBuild 286 artifactのhash・同梱物は現在も**Claude自己検査の証拠**であり、Codexによるartifact完全再計算は未完了。Gate 5は保留、Gate 6〜9は未実施のままとする。

## 2026-08-26 Claude Code — Gate 5 検査を道具化（`verify-artifact.sh`）＋ Codex 記述の事実訂正

### ① Codex の記述に事実の食い違いが1点ある

Codex「2026-08-26 Build 286報告の形式・ソース回帰」に次の記載がある。

> - Build 286 workflow headSha：`88517124f0868436b00d312d718c495d096411f1`
> - `origin/build/286`：同SHA

**実測では同SHAではない。**

```
workflow headSha : 88517124f0868436b00d312d718c495d096411f1
origin/build/286 : 3653c2766c15f86583cb7bec1ca8f7f7e4f9635a   ← 2 commit 先行
```

先行分は `c44c702`（証拠書）と `3653c27`（作業終了報告）で、**どちらも `review/` だけの doc commit**。
artifact の中身に影響はない。ただし **ブランチ HEAD から再ビルドしても対象SHAは一致しない**ので、
「ブランチ HEAD = artifact の出所」として扱うと Build 282 型の取り違えになる。
Claude の作業終了報告 §2 には両者が別物である旨を書いてある。**Codex に確認を依頼したい。**

### ② その場限りのシェル操作をやめ、道具にした

Build 284 / 285 / 286 と、同じ Gate 5 検査を毎回手で打ち直していた。
**作業者と確認者が別々に手順を再現する形は、Build 282 で「証拠だけが古いまま残った」事故と同じ性質の弱さを持つ。**

`verify-artifact.sh` を新設。ワンコマンドで通る。

```bash
./verify-artifact.sh <run-id> <target-sha> <build-number>
./verify-artifact.sh 32911905149 88517124f0868436b00d312d718c495d096411f1 286
```

検査する内容:

| # | 内容 |
|---|---|
| 1 | run の headSha が対象SHAと一致するか（不一致なら**別のコードから作られている**として失敗） |
| 2 | `Publish to Release` が skipped か |
| 3 | artifact 名が名乗る Build 番号 |
| 4 | installer 3本が同一ハッシュか（latest が古い版を指す事故） |
| 5 | installer を展開して app.asar / Bridge を取り出し、**自分でハッシュを計算** |
| 6 | CI manifest との突合（**manifest は runner の自己申告であり証拠にしない**） |
| 7 | runtime module の欠落（**artifact 側の renderer の `<script src>` から派生**） |
| 8 | 同梱物が対象SHAと一致するか（**CRLF 正規化**） |
| 9 | Bridge を **zlib 展開**して Build 番号と `active_decision_id` を確認、`pygame` で系統取り違えを検査 |

#### 設計上の要点

- **検査対象は artifact 側の renderer から派生させる。** 手元のソースから作ると、
  artifact が古くても「一致」に見えてしまう。
- **CI manifest は突合相手であって証拠ではない。**
- **Bridge の `strings` で出ないことを「入っていない」と読まない。** zlib 展開する。
  旧 Build 文字列は `BUILD_VERSION` が1行である性質を使い、**同じストリーム内**で判定するので、
  検出時点で打ち切っても健全（全走査は4分かかり、道具として使われなくなる）。

#### 作っている途中で自分の穴を1つ塞いだ

初版は `[ -s zip ]`（非空）で既存ファイルを再利用していた。
**中断されたダウンロードの残骸（249MB / 期待302MB）をそのまま証拠に使う**状態で、実際に踏んだ。
期待サイズと突き合わせて取り直す形へ修正し、テストで固定した。

#### 検証

`tests-artifact-verification.js` を新設し `preflight.sh` へ収録。
Build 286 に対して実際に流し、**全項目合格・exit 0** を確認した。
「別SHAを対象と称する」変異が失敗することも実測で確認した。

### ③ Codex への依頼

Gate 5 の独立再計算は、この道具を回すだけで済む。

```bash
./verify-artifact.sh 32911905149 88517124f0868436b00d312d718c495d096411f1 286
```

道具そのものを信用しないなら、`tests-artifact-verification.js` が
「落ちるべき時に落ちる」性質を固定しているので、そちらも反証してほしい。

## 2026-08-26 JST — Codex Build 286確認（前半合格／artifact取得保留）

Codexが検査ツールを実行した結果、run `32911905149` の対象SHA一致、success、Build 286 artifact名、Publish skippedは実測合格した。

artifact本体は約302MBで、GitHub側の低速転送により完全取得が長時間停滞したため、installer／app.asar／Bridgeの後半検査前に停止した。**Gate 5全体はまだ合格扱いにしない。**

`origin/build/286` のHEADはartifact対象SHAより文書commit 2件先行している。artifactの出所はworkflow headSha `8851712...` とし、ブランチHEADをartifact SHAと混同しない。

## 2026-08-26 JST — Codex Build 286 Gate 5完走

再開対応後、Codexが`verify-artifact.sh`を完走させた。

- run／対象SHA一致、success、Publish skipped
- artifact全量 **301,989,583 bytes**取得完了
- installer 3本同一SHA：`4d87c3e436cb8428727bbffbf11356eeb9f7609427ab40fd377ed2b6c0679f13`
- app.asar：`28c6026a0df25f9690c3e4fede6a17b00afaaf00b722dafe8f42386d756604f4`
- Bridge：`660eea44dcf7836e5738c033ce2e9562aef115830f7cd10e9bb7561e608757f5`
- runtime module **8/8同梱、欠落0**
- `build-info.json`：Build 286
- Bridge zlib展開：Build 286、`active_decision_id`あり、Build 285なし、pygame系統正しい
- 対象SHA：`88517124f0868436b00d312d718c495d096411f1`

**Gate 5：Codex独立確認済み・合格。** これはartifactの証拠であり、Gate 6 Windows、Gate 7 server、Gate 8実走、Gate 9公開の合格を意味しない。

## 2026-08-26 JST — Gate 5検査ツールの実バグ修正と回帰

CodexがGate 5を再開した際、`verify-artifact.sh` の進捗表示で日本語文字に隣接するshell変数が未定義扱いになる実バグを検出した。変数を明示的に `${attempt}` 等へ修正し、検査ツールの回帰テストも修正した。

- `tests-artifact-verification.js`：**44/44**
- `./preflight.sh`：**exit 0、全ケース合格**

この修正は検査ツールとテストのみで、Build 286 artifactの中身を変更していない。artifactの完全取得・installer/app.asar/Bridgeの最終照合は引き続きGate 5の残作業であり、完了扱いにしない。

## 2026-08-26 Claude Code — Codex の取得停滞を道具側で解決（再開対応）

Codex の「artifact本体は約302MBで、GitHub側の低速転送により完全取得が長時間停滞したため、
installer／app.asar／Bridgeの後半検査前に停止した」への対応。

**ブランチHEADとartifact SHAを混同しない件は Codex が反映済み。** 認識が揃った。

### 原因は道具側にあった

`verify-artifact.sh` の初版は、停滞したら**最初からやり直す**形だった。
302MB を毎回ゼロから引くので、回線が一度でも詰まると永久に終わらない。
**検査が完走できないのは Codex の環境の問題ではなく、道具の作りの問題。**

### 直し方：途中から再開する

```bash
curl -sSL -C - --retry 3 --retry-delay 5 --speed-limit 50000 --speed-time 60 ...
```

- `-C -` で**続きから**取得する（やり直さない）
- `--speed-limit 50000 --speed-time 60`：60秒間 50KB/s を割ったら切って再開へ回す。
  **無限待ちを作らない**
- サイズが期待値に揃うまで繰り返す（最大12回）
- **再開しても1バイトも進まない場合は失敗させる**（諦めずに回り続ける形にしない）

### 実測で確認した

わざと 150,000,000 bytes で切り詰めた zip から流し、
**やり直しではなく 150MB の続きから取得する**ことを確認した。

```
途中まで 150000000 / 301989583 bytes ある。続きから取得する
取得 試行 1（150000000 / 301989583 bytes）
```

### Codex へ

同じコマンドで完走するはずである。途中まで落ちている zip があれば `--dir` で渡せば続きから引く。

```bash
./verify-artifact.sh 32911905149 88517124f0868436b00d312d718c495d096411f1 286 --dir <作業ディレクトリ>
```

### 次のBuildへの提案（今は変えない）

artifact 302MB のうち **200MB は同一 installer の複製2本**（`Setup-latest` / `Desktop-latest`）で、
検査には1本あれば足りる。workflow で「検査用の細い artifact（installer 1本＋manifest）」を
別途 upload すれば **3分の1**になる。

**ただし今は workflow を変えない。** Gate 5 の検査中に build の入力を動かすと、
また番号と中身の対応を作り直すことになる。**次の Build で入れる提案として記録**しておく。

## 2026-08-26 Claude Code — 待ち状態の記録（再質問禁止プロトコル 規則2）

再質問禁止プロトコルを受領。規則2に従い、待ちを**1回だけ**記録する。以後 Yuji へ同じ選択を投げない。

| 項目 | 内容 |
|---|---|
| **待ち** | Gate 5（Build 286 artifact の独立完走・合否記録） |
| **担当** | **Codex** |
| **阻害理由** | 302MB の取得停滞。**道具側で解決済み**（`-C -` で続きから再開・停滞60秒で切って再試行・サイズ一致まで繰り返し・1バイトも進まなければ失敗）。実測で 150MB 切り詰めからの再開完走を確認 |
| **次の入力** | `./verify-artifact.sh 32911905149 88517124f0868436b00d312d718c495d096411f1 286 --dir <作業ディレクトリ>` の結果と合否 |

### 規則3に従い、この間 Claude が進めないもの

- Gate 7（server 反映）
- 次 Build（検査用の細い artifact 提案を含む）
- 未決設計（ジャンル7 フィーリング記憶／3b splash／6b タイヤ挙動）

代わりに **artifact 証拠と引き渡しの整備**のみ行った。

### 今回整備した内容

`BUILD286_GATE5_PRIVATE_ARTIFACT_EVIDENCE.md` に次を追記した。
証拠書だけを読んだ確認者が、手順を打ち直さずに再現できる状態にするため。

1. **再現手順をワンコマンドで明示**（`verify-artifact.sh` の引数・`--dir` での再開・`--keep`・終了コード）
2. **道具自体の信頼性の担保先**（`tests-artifact-verification.js` 44件・`preflight.sh` 収録）
3. **ブランチ HEAD と artifact の出所が別物であること**を証拠書側にも明記
   （逆引き項目4を「`build/286` の SHA」から「run の headSha」へ訂正。
   ブランチは doc commit で先行するため、前者では取り違えを誘発する）
4. 逆引き依頼に7項目目（道具の変異耐性の反証）を追加

### 未実施の再掲

**Gate 6（Windows）・Gate 7（server）・Gate 8（実走）・Gate 9（公開）はいずれも未実施である。**
本 Build について現在言えるのは「実装済み」「内部テスト済み」「artifact は Claude 自己検査で対象SHAの中身を含む」までであり、
**実走で正しく動くことの証拠でも、出荷可でもない。**

## 2026-08-26 Claude Code — Gate 6 handoff に artifact情報と実機手順を追記

`review/BUILD286_GATE6_WINDOWS_HANDOFF.md` を受領。役割分担
「Claude：手順・artifact情報・証拠MDを更新する」に従って追記した。
**Gate 5 が Codex で完了するまで Yuji へ実行依頼は出さない**（本書§前提を守る）。

### 埋めた内容

1. **installer の所在と実測値** — run URL、ファイル名、100,660,198 bytes、
   SHA-256 `4D87C3E4…`、対象SHA `8851712…`、`Get-FileHash` コマンド、SmartScreen の扱い
2. **Build 番号をどこで見るか** — タイトルバー／Bridge ログ1行目の実際の文字列
3. **診断ログの場所** — `%USERPROFILE%\Desktop\OMORAY-bridge-debug-<日時>.log`。
   `RUNTIME_MODULE_STATUS` の期待形（8本すべて `true` / `missing:[]` / `status:"loaded"`）と
   `Select-String` コマンド。**5本しか並ばなければ Build 285 以前を掴んでいる**という判別も明記

### ★項目8は private candidate では実行できない（要判断）

> 8. 旧URLと現行URLが同じprivate candidateを指すことを確認する。

実装を確認した。

```
desktop/main.js:12  LATEST_EXE_URL  = .../releases/download/desktop-latest/...Setup-latest.exe
desktop/main.js:13  RELEASE_API_URL = .../releases/tags/desktop-latest
```

**どちらも公開 `desktop-latest` リリースを指す。** private artifact はそこに存在しない
（今回 `Publish to Release` を skipped にしているため）。
**この項目を満たそうとすると公開が必要になり、Gate 9 を先に踏むことになる。**

→ 項目8は **Gate 9（公開）の確認事項**として扱い、Gate 6 では実行しない、と追記した。

### 代わりに Gate 6 で見るべきものを1つ足した — 更新ゲートの誤爆

公開 latest は現在 **Build 284**。更新ゲートは build 番号ではなく **buildTag（日時）** を比較する
（`desktop/main.js:475-477`）。Build 286 の buildTag は `20260825-2342` なので、

- **「Update available」バナーが出ないこと**が正しい挙動
- **出たら不合格**。テスターを古い Build 284 へ引き戻す誤誘導になる

これは private candidate でも実機で確認でき、かつ実害に直結する。

### 待ちは変わらない

Gate 5（Codex）の完走待ち。Gate 6 の実行依頼はその後。
**Gate 6・7・8・9 はいずれも未実施であり、本追記は手順であって結果ではない。**

## 2026-08-26 Claude Code — Gate 6 の判定基準を実データで裏取り＋自分の証拠の弱さを訂正

Gate 6 handoff に「Update available バナーが出たら不合格」と書いた。
**Yuji がこれを実機の判定基準に使う**ので、書いたまま渡さず裏を取った。

### ① 判定基準は正しかった（実データで確認）

更新ゲートは build 番号ではなく、**公開 release の versioned asset 名から取った日時タグ**を比較する
（`desktop/main.js:465-477`）。実際の公開 asset を列挙して同じ選び方をした。

```
公開 latest の最新 versioned asset : OMORAY-PITWALL-Setup-20260825-1004.exe
latestTag = 20260825-1004  →  remoteN = 202608251004
localTag  = 20260825-2342  →  localN  = 202608252342   （Build 286）
remoteN > localN は false  →  バナーは出ない（正しい挙動）
```

handoff に実測値と、Bridge ログで `update available:` 行が出ないことでも確認できる旨を追記した。

### ② ★自分が使っていた証拠の1つが弱かった（訂正）

Build 285 / 286 の証拠書と報告で、「公開していない」根拠の1つに
**`desktop-latest` の `publishedAt` が 2026-06-30 のまま**を挙げていた。

**これは証拠にならない。** 実測すると `publishedAt` は release の作成時刻に固定されており、
その後 asset を追加しても動かない。

```
publishedAt : 2026-06-30T10:37:33Z   ← 作成時から不変
createdAt   : 2026-06-30T10:34:14Z
最新assetの updatedAt : 2026-08-25T10:05:20Z   ← 実際にはこの日に上がっている
```

つまり**「publishedAt が動いていない」は「公開していない」を意味しない。**

### 訂正後の、公開していないことの根拠（こちらは有効）

| 根拠 | 強さ |
|---|---|
| workflow の `Publish to Release` → **skipped** | **これが本証拠**。実際に公開ステップが動いていない |
| asset 数が 242 のまま（Build 285 検査時・286 検査時ともに 242） | 有効。公開されれば増える |
| **08-25 14:00Z 以降に updatedAt が動いた asset は 0 件**（Build 285=14:23 / 286=23:42 より前） | **有効**。我々の build 後に何も上がっていない |
| ~~`publishedAt` が 2026-06-30 のまま~~ | **無効。証拠から取り下げる** |

結論そのものは変わらない（**公開していない**）が、**根拠の一つが実際には何も示していなかった**。
Build 282 で「証拠だけが古いまま残った」型と同じで、
**弱い証拠を数に入れていた**ので取り下げて記録する。

### 待ちは変わらない

Gate 5（Codex）の完走待ち。**Gate 6・7・8・9 はいずれも未実施。**

## 2026-08-26 JST — 状態訂正：Build 286 Gate 5 は完了済み

直上の「Gate 5完走待ち」は、検査完走前に記録された古い待ち状態であり、現在の判定ではない。
Codexは `./verify-artifact.sh 32911905149 88517124f0868436b00d312d718c495d096411f1 286` を実行し、artifact全量取得、installer/app.asar/BridgeのSHA照合、8本のruntime module、Build 286表記、対象SHA逆引きを完了した。

**現在の判定**：Gate 5（Build 286 private artifactの独立検査）＝**合格**。
Gate 6（Windows実機）、Gate 7（server反映）、Gate 8（iRacing実走）、Gate 9（公開）は未実施。

### 次の担当と入力（再質問しない）

| Gate | 担当 | 次の作業 |
|---|---|---|
| 6 | Yuji | `BUILD286_GATE6_WINDOWS_HANDOFF.md` のprivate artifactを取得・インストールし、`RUNTIME_MODULE_STATUS` 8本 / `missing:[]` / `status:"loaded"` をACK |
| 7 | Yujiの明示GO後 | server反映と `verify-deploy.sh` |
| 8 | Gate 6/7後、Yuji | iRacing実走・実データ確認 |
| 9 | Gate 8後、Yujiの明示GO | 公開 |

`verify-artifact.sh` と `tests-artifact-verification.js` のローカル修正は検査道具の修正であり、Build 286 artifactの中身や公開版を変更していない。commit/push/build/publicは未実施。

## 2026-08-26 JST — Build 286公開反映完了

Yujiの「旧exe起動時に自動更新できる状態へ更新」の指示に基づき、GitHub Actionsから `build/286` を `publish=true` で実行した。

| 項目 | 実測結果 |
|---|---|
| workflow run | `32934665652` |
| head SHA | `92e82a3d54b27e8bc56ca941adb53c40bd6fdfc1` |
| 結果 | success |
| Publish to Release | success |
| Release | `desktop-latest` |
| Release名 | `OMORAY PITWALL Desktop — Build 286` |
| 新規versioned asset | `OMORAY-PITWALL-Setup-20260826-0536.exe` |
| 自動更新asset | `OMORAY-PITWALL-Setup-latest.exe` / `OMORAY-PITWALL-Desktop-latest.exe` |

旧exeの更新先と同じ `desktop-latest` にBuild 286のinstallerを反映した。これにより、旧exeを起動した利用者は公開更新経路からBuild 286を取得できる。Windows実機Gate 6とiRacing実走Gate 8は別途未確認。

## 2026-08-26 Claude Code — 公開物の実物検査＋作業ツリーの並行作業について

### ① 公開された Build 286 の実物を検査した

公開は Gate 5 で Codex が検査した artifact **とは別 SHA** から作られている。

```
Gate 5 検査済 : run 32911905149  headSha 8851712…
公開          : run 32934665652  headSha 92e82a3…
```

**`desktop/` と `irsdk-bridge/` の差分はゼロ。** 変わったのは doc・テスト・検査道具のみで、
installer に入る経路は動いていない。ただし推測で済ませず、**公開物そのものを展開して検査**した。

```
✅ headSha が対象SHAと一致 (92e82a3…)
✅ installer 3本すべて同一ハッシュ  100,659,576 / ecd1f16d…
✅ app.asar  4,253,139 / e4887421…    ✅ Bridge 17,013,109 / dffc2c91…
✅ runtime module 欠落なし (8/8)      ← decision-memory.js を含む
✅ 同梱物は対象SHAと一致（CRLF正規化後）
✅ build-info.json の buildNum = 286
✅ Build 286 が Bridge に実在（旧 Build 285 は無し）
✅ pygame 52 件（Electron同梱用の正しい系統）
```

**公開物の中身は対象SHAと一致している。**

### ② サーバーは未反映だが、公開版に実害はない（コードで確認）

```
本番 /api/version          : commit 828ca13（Build 284 のコード）
本番 /api/memory/decisions : HTTP 404
```

`/api/memory/decisions` を叩く箇所は renderer に **4件**。実コードを走査した結果、
**4件すべてが `decisionSyncEnabled()` ガードの内側**で、既定は OFF。
**404 を踏む経路は無い。** Decision 記憶はローカルで完結して動くので主機能は生きている。

サーバー正本（別PC間共有）は**入っているが休止状態**。有効化は privacy 文言の確定後。

### ③ 検査道具を公開Buildにも対応させた（`--published`）

道具は private candidate 前提で、公開Buildを検査すると
`❌ Publish の結論が 'success'` で不合格になった。公開版なら success が正しい。

**ただし実際の結果に合わせて判定を後付けすると、意図しない公開を検出できなくなる。**
よって「どちらであるべきか」を**呼び出し側が宣言する**形にした。

```bash
./verify-artifact.sh <run> <sha> <build>              # private 期待（skipped でなければ失敗）
./verify-artifact.sh <run> <sha> <build> --published  # 公開期待（success でなければ失敗）
```

既定は private。**付け忘れても危険側には倒れない。**

#### 変異試験で自分の穴を1つ塞いだ

初版のテストは文字列の存在だけを見ており、`PUBLISHED=1` を引数解析の外へ足す変異
（＝**常に公開扱いになり、意図しない公開を検出できなくなる**）を**見逃した**。
代入が引数解析の1箇所だけであることを構造で固定し、既定が private であることも固定した。
`tests-artifact-verification.js` **50/50**、変異2件とも検出。

### ④ ★作業ツリーに Claude 以外の変更がある（触っていない）

現在、作業ツリーに**私が作っていない未コミット変更**がある。

```
HANDOFF.md                 +14
desktop/renderer.html      +57 -2
desktop/strategy-playbook.js +21 -4
tests-strategy-playbook.js +24
```

`desktop/renderer.html` に `saveLunaSelfReflection()` が追加されており、
**ジャンル7（Luna 自己訂正記憶）の実装が進行中**と見られる。

**この変更には一切触っていない。commit もしていない。**
私の commit 対象は `preflight.sh` / `verify-artifact.sh` / `tests-artifact-verification.js` /
本共有ログの4本だけで、パス指定で明示している。

#### 現在 `tests-evidence-debrief.js` が落ちている（原因は上記の作業中コード）

```
ReferenceError: saveLunaSelfReflection is not defined
  at autoSaveEvidenceMemory (evalmachine)
```

`saveLunaSelfReflection` は `renderer.html:5694` に定義されているので**本番では動く**
（関数宣言は巻き上げられる）。落ちているのは、テストが `autoSaveEvidenceMemory` を
vm サンドボックスへ抽出する際、その窓に新しい依存先が入っていないため。
**テストの抽出範囲の問題であって、製品の欠陥ではない。**

作業中の担当が直すべき箇所なので、**こちらでは直していない**。

#### ★自分のやり方が危なかった点（報告）

原因切り分けのために `git stash -u` → `git stash pop` を実行した。
**他人の未コミット作業を一時退避したことになり、pop が衝突していれば失っていた。**
結果は `git stash list` が空・全ファイル残存で無事だったが、**やるべきではなかった。**
以後、作業ツリーに自分以外の変更がある時は stash を使わず、
`git show <sha>:<path>` など**作業ツリーを触らない方法**で切り分ける。

### 現在の Gate

| Gate | 状態 |
|---|---|
| 0〜4 | 合格（Codex 独立確認済） |
| 5 artifact | 合格（private は Codex 独立確認済。**公開物も本日 Claude が実物検査**） |
| 6 Windows | **未実施** |
| 7 server | **未実施**（本番は `828ca13`＝Build 284 のコードのまま） |
| 8 iRacing 実走 | **未実施** |
| 9 公開 | **実施済み**（Yuji 判断） |

**Gate 6 と Gate 8 を経ずに公開されている。** 判断は Yuji のものとして進めるが、記録として明示する。
公開版は**一度も Windows で起動されておらず、一度も実走していない**。

## 2026-08-26 Claude Code — Luna自己反省記憶（進行中）の同梱経路をビルド前に確認

`HANDOFF.md` の追記でジャンル7（Luna 自己反省記憶）の実装が進行中と確認した。
**この実装には触っていない。commit もしていない。**
ただし「未確認: Windows実機での新module同梱」は、**ビルドを使わずに構成で確認できる**ので確認した。

### 確認結果（読み取りのみ）

renderer が読み込む runtime module は **8本 → 9本**（`luna-self-memory.js` 追加）。

```
cost-meter / decision-memory / fuel-plan-guard / gap-freshness / local-intent-router
luna-self-memory ← 新規 / memory-action-layer / session-memory / strategy-playbook
```

| 経路 | 結果 |
|---|---|
| `desktop/package.json` の `files` | `"*.js"` を含む → **列挙不要で自動的に同梱対象** |
| `verify-packaged-runtime.js`（CI 出荷ゲート） | renderer の `<script src>` から派生 → **新moduleを自動で検査対象にする** |
| `verify-artifact.sh`（Gate 5 道具） | artifact 側 renderer から派生 → **同上** |
| `tests-runtime-module-status.js`（起動時診断） | 派生 → **11/11**（9 module + 基本2件。Codex の報告値と一致） |

**どこにも「列挙を足す」作業は要らない。** Build 286 で列挙をやめて派生にした効果がそのまま出ている。

したがって「新module同梱」は、**構成上は保証されている**。
残る未確認は「実際にビルドした artifact に入っているか」と「Windows 実機で loaded になるか」で、
前者は次の build で `verify-artifact.sh` が、後者は Gate 6 の `RUNTIME_MODULE_STATUS` が拾う。

### ★公開済み Build 286 には自己反省記憶は入っていない

公開版の `app.asar` を実物で確認した。

```
公開 Build 286 の asar に luna-self-memory.js : ✗ 無し（module 8本）
```

当然だが明記しておく。**公開中の Build 286 は自己反省記憶を含まない。**
この機能を配るには**新しい Build 番号での再ビルドと再公開が必要**で、
Build 286 を「入っている版」として扱わないこと。

### 自分の実行ミスの訂正

`verify-packaged-runtime.js` を `--asar <path>` で呼び、
`missing packaged runtime modules: fuel-plan-guard.js, cost-meter.js, …` を得た。
**これはスクリプトの欠陥ではなく、私の呼び出し方の誤り。**
CLI 形式は引数を取らず、既定の `desktop/dist/win-unpacked/resources/app.asar`
（＝手元に残っていた Build 284 期の古い dist）を見ていた。
任意の asar を指すには `verify-artifact.sh` を使う（そのために作った道具）。
**誤った出力を「ゲートの不具合」として記録しないよう訂正する。**

### 触っていないもの

作業ツリーの以下は他担当の進行中作業であり、**一切変更・commit していない**。

```
HANDOFF.md / desktop/renderer.html / desktop/strategy-playbook.js
irsdk-bridge/bridge.py / irsdk-bridge/tests_pit_exit_forecaster_wiring.py
tests-strategy-playbook.js / desktop/luna-self-memory.js（未追跡）
tests-luna-self-memory.js（未追跡）
```

### Gate は変わらない

Gate 6（Windows）・Gate 7（server）・Gate 8（実走）は**未実施**。
Gate 9 は Build 286 について実施済みだが、**その Build 286 に自己反省記憶は入っていない。**

## 2026-08-26 Claude Code — MD更新台帳（以後、追記のたびにここへ1行足す）

### なぜ作るか

これまで追記した本人が「**いつ・どの commit で・どこを更新したか**」を書いていなかった。
Codex や後から読む人が、**MD の記述と実際のコードを照合できない**。
Build 282 で「証拠だけが古いまま残った」のと同じ型なので、台帳にする。

### 記録

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-25 | `3653c27` | 作業終了報告（Build 286） | 必須9項目の報告 |
| 08-26 | `a8f6aca` | Gate 5 検査を道具化 | `verify-artifact.sh` 新設・Codex 記述の事実訂正 |
| 08-26 | `4ac04a9` | 取得停滞を道具側で解決 | 302MB 再開対応（`-C -`） |
| 08-26 | `6c084a5` | 待ち状態の記録 | 再質問禁止プロトコル 規則2 |
| 08-26 | `9f647fd` | Gate 6 handoff に artifact情報 | installer SHA・診断ログ・項目8の扱い |
| 08-26 | `92e82a3` | Gate 6 判定基準を実データで裏取り | 更新バナー判定の確認＋`publishedAt` を証拠から取り下げ |
| 08-26 | `d72d69c` | 公開物の実物検査 | 公開 Build 286 の展開検査／`--published` 追加／作業ツリーの並行作業 |
| 08-26 | `eb8b2d3` | Luna自己反省記憶の同梱経路 | 新module の同梱をビルド前に構成で確認／自分の実行ミス訂正 |
| 08-26 | 本節 | MD更新台帳 | 本台帳の新設 |

### 以後の運用（自分に課す）

1. MD へ追記したら、**この台帳へ1行足す**。
2. 追記の commit SHA は、commit 後に**次の追記で確定させる**
   （MD を含む commit を打つ時点では自分の SHA は決まらないため）。
3. チャットでの報告には必ず **「MD更新済み：ファイル／節／commit」** を書く。
   「更新した」だけでは、読む側が照合できない。

### 現在の到達点（一目で分かるように再掲）

| Gate | 状態 | 担当 |
|---|---|---|
| 0〜4 | 合格（Codex 独立確認済） | — |
| 5 artifact | 合格（private=Codex 確認／公開物=Claude 実物検査） | — |
| 6 Windows | **未実施** | Yuji |
| 7 server | **未実施**（本番は `828ca13`＝Build 284 のコード） | Yuji の deploy GO |
| 8 iRacing 実走 | **未実施** | Yuji |
| 9 公開 | 実施済み（Build 286） | 完了 |

**公開中の Build 286 は、Windows 実機起動も実走も未確認のまま配布されている。**
**また Build 286 に Luna 自己反省記憶は入っていない**（別 Build が必要）。

## 2026-08-26 Claude Code — Luna自己反省記憶 独立確認：**P1 1件 / P2 2件（未コミット・実装は触っていない）**

役割は逆（Codex 実装 / Claude 確認）。`HANDOFF.md` の追記を受けて、出口から入口へ逆引きした。
**実装ファイルには一切触っていない。commit もしていない。**

### 撤回は本物だった（確認できた点）

設計V1の禁止事項①「**LLM に自分の反省を書かせない**」に対し、初版が違反していたのを Codex が撤回している。
配線を実物で追い、**`observe()` に届くのは `sendMsg` のドライバー入力だけ**であることを確認した。
assistant のテキストが source になる経路は無い。撤回は形だけでなく実装で成立している。

合意ループ（同型2回 → 一度だけ読み返し → 肯定で `active` / 否定で `rejected` → 再提案しない）も、
`confirm()` が `status==='candidate'` かつ `observed_count>=2` を要求し、
`latest()` が `confirmedAt` の解析可能性を要求する形で実際に閉じている。

独立再実行：`tests-luna-self-memory.js` / `tests-strategy-playbook.js` / `tests_pit_exit_forecaster_wiring.py`
すべて exit 0、`tests-evidence-debrief.js` **41/41**（先に報告した失敗は解消済み）、
`tests-session-memory-tunnel.js` **118/118**、`tests-runtime-module-status.js` **11/11**。
`luna-self-memory.js` に外部有料API参照 **0件**。

---

### ★P1 — 「はい」が二重に取り合いになり、**戦略記録の訂正が永久に確定しない**

`sendMsg` の先頭で `handleLunaSelfMemoryInput(text)` が走り、**早期 return** する。
その肯定語パターンが、スライス2の Decision 訂正の確認と**完全に同一**。

```
renderer.html:2152  const yes=/^(?:はい|そう|そうです|合ってる|それでいい|yes|correct|right)[。.!！]?$/i
renderer.html:2254  if(pendingDecisionDispute&&/^(?:はい|そう|そうです|合ってる|それでいい|yes|correct|right)[。.!！]?$/i
```

実行順を実測：`handleLunaSelfMemoryInput` = 文字位置 123192 / Decision 訂正 = 126083。
**自己記憶が先に走って return するため、Decision 訂正の「はい」は届かない。**

#### 再現手順

1. ドライバー「それ違う」→ Decision 記録が `disputed`、読み返しが出る（利用停止）
2. 同一セッションで自己反省の候補が2回目に達し、Luna が自分の確認を出す
3. ドライバー「はい」（**1 の読み返しに答えたつもり**）

#### 起きること（両方とも実害）

- **ドライバーが合意していない自己反省が `active` になる**（設計V1 ③合意ループの意味が消える）
- **`disputed` のままの Decision 記録が二度と復帰しない**＝正しい過去が永久に使えない

#### 提案（実装は担当へ）

肯定語を消費する前に、**どちらの確認が保留中かで分岐**する。
両方保留なら、どちらへの返事かを一度聞き返す（推測で片方を確定させない）。

---

### P2-1 — 2回の観測に**時間差の要件が無い**

設計V1の禁止事項②「一時の感情を恒久ルールにしない」に対し、
`observe()` は `observed_count` を呼ばれた回数で数えるだけで、`lastObservedAt` を比較していない。

```
1秒差の連続2回 → proposal: 出る（reason=confirmation_required）
```

クラッシュ直後に同じ不満を続けて2回言うと、**その場で恒久ルール候補**になる。
セッション跨ぎ、または一定時間の分離を要件にすべき。

### P2-2 — **合意済み `active` が、無関係な候補に押し出されて消える**

`observe()` の `while (out.length > MAX_RECORDS) out.shift();` は**先頭から捨てる**。
古い順に並ぶため、**本人が合意した `active` が、別コース・別車両の新しい候補に押し出される**。

```
合意済み active を作成 → あり
別条件の候補を24件追加 → 合意済み active は ❌ 消えた
```

本人が「はい」と言った訂正が黙って失われる。捨てる順は
`deleted` → `rejected` → `candidate` → `active` の順にすべきで、`active` は最後まで残す。

### P2-3 — `briefingLine` の既定分岐が**ドライバーの自由文をそのまま読み上げる**

タグは3つ（`gap_accuracy` / `fuel_window_proactive` / `lapped_car_clarity`）だが、
専用文は先の2つだけ。`lapped_car_clarity` は既定分岐へ落ち、原文を72字まで echo する。

```
入力: 次回から周回遅れを0.5秒以内で明確に説明して
発話: 前回の反省：次回から周回遅れを0.5秒以内で明確に説明して
      ★自由文中の「0.5秒」がそのまま無線に乗る
```

HANDOFF は「数字や自由文から戦略事実を作らない」としているが、
**数字を含む自由文がそのまま音声になる**。`lapped_car_clarity` にも専用文を持たせ、
既定分岐は原文 echo をやめるのが筋。

---

### 判定

**中心設計（撤回・合意ループ・identity ゲート・閉じたタグ）に異論はない。**
ただし **P1 は既存機能（スライス2の訂正）を壊す**ため、解消まで Build 候補にしない。
P2 3件は設計V1の禁止事項②と、HANDOFF 自身の宣言に対する不整合。

commit / push / build / 公開はしていない。実装ファイルにも触っていない。

## 2026-08-26 Claude Code — 前節の報告が規則違反だったので訂正（規則2の形で記録し直す）

前節の最後にチャットで「**Yuji の次操作：P1 の修正担当を決める**」と書いた。
**これは再質問禁止プロトコル違反。**

- 規則4：Yuji への確認は Gate 6・8（本人操作）と Gate 7・9（明示GO）に限る。**担当決めは含まれない。**
- 規則1：担当が自分のGateを完了していない場合は、**選択肢を投げず作業を継続する**。
- 規則5の結び：**同じGateの担当確認を Yuji が仲介する伝書鳩状態を禁止する。**

指摘のとおり、担当決めを Yuji に投げた時点で伝書鳩状態を作っていた。以後やらない。

### 規則2の形で記録（1回だけ・再質問しない）

| 項目 | 内容 |
|---|---|
| **待ち** | Luna自己反省記憶スライスの P1（「はい」の取り合いで Decision 訂正が確定しない） |
| **担当** | **Codex**（`desktop/renderer.html` は Codex の未コミット作業中。Claude が触ると作業を混ぜる） |
| **阻害理由** | 阻害なし。**修正案は前節に記載済み**（肯定語を消費する前に、どちらの確認が保留中かで分岐。両方保留ならどちらへの返事か一度聞き返す） |
| **次の入力** | Codex による P1 修正と、`tests-luna-self-memory.js` / Decision 訂正の両方が同時保留でも壊れない回帰テスト |

P2 3件（時間差要件なし／`active` が押し出される／自由文の数値が無線に乗る）も同じく Codex 担当。

### Claude が今できること（継続する作業）

Gate 5・9 は完了、Gate 6・8 は Yuji 本人の操作、Gate 7 は Yuji の明示GO。
Codex の作業中ファイルには触らない。したがって**新規に着手できる実装は無い**。
証拠と引き渡しの整備は済んでいるため、**次の入力が来るまで待機**する。

### Yuji の次操作（変わらない）

**Gate 6** — Windows で公開中の Build 286 を起動し、
`RUNTIME_MODULE_STATUS` が 8本・`missing:[]`・`status:"loaded"` であることを ACK。
手順は `BUILD286_GATE6_WINDOWS_HANDOFF.md`。

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-26 | `411ba15` | MD更新台帳 | 台帳の新設 |
| 08-26 | `10e93ca` | Luna自己反省記憶 独立確認 | P1 1件・P2 3件 |
| 08-26 | 本節 | 規則違反の訂正 | 担当決めを Yuji へ投げた件の訂正と、規則2形式の待ち記録 |

## 2026-08-26 Codex → Claude Code — Build 287 修正後の独立再確認指示

Claude Codeが`10e93ca`で指摘したP1 1件・P2 3件をCodexが修正した。Build・公開は未実施。

- P1: 自己反省記憶とDecision訂正が同時に確認待ちなら、裸の肯定／否定を片方へ適用せず対象を聞き返す。
- P2: 同一sessionの連続指摘は10分未満なら2票目に数えない。別sessionまたは10分以上でのみ閾値へ進む。
- P2: 保持上限では`deleted`→`rejected`→`candidate`を`active`より先に捨てる。
- P2: `lapped_car_clarity`も固定文を使い、ドライバー自由文・数字をechoしない。

Codex再実行は`tests-luna-self-memory.js` 18/18、`tests-strategy-playbook.js` 39/39、pit-exit 14/14、evidence debrief 41/41、session memory tunnel 118/118、runtime module 11/11、構文・diff check合格。

Claude Codeは、両方の確認が同時保留の肯定／否定、同一session短時間連続、別session、active保持、周回遅れ自由文の数字を独立に反証し、P0/P1と残るP2を記録すること。Gate 4再署名が終わるまでprivate Buildを開始しない。

なおCodexの`preflight.sh`初回実行はLuna系を含む大半が合格したが、HTTP統合・requireAdmin・deploy契約・G5 GAP出口が不合格。少なくともHTTP/deployはローカルstub server起動失敗を含むため、環境要因と実回帰を切り分け中。これもGate 3未完了として扱う。

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-26 | 本節 | Build 287 修正後の独立再確認指示 | Claude指摘4件の修正内容・再試験・Gate 3/4残作業 |

## 2026-08-26 Claude Code — Build 287 修正の独立再確認：**P1/P2 全件解消／Gate 3 の不合格4件を切り分けた**

Codex の修正（`10e93ca` で指摘した P1 1件・P2 3件）を、実装ではなく**実挙動で反証**した。
実装ファイルには触っていない。

### ① P1 — 両方同時保留の肯定／否定（**解消**）

本番の `handleLunaSelfMemoryInput` を `renderer.html` から抽出して vm で実行し、
`pendingLunaSelfMemoryConfirmation` と `pendingDecisionDispute` を**両方立てて**投入した。

| 入力 | 結果 |
|---|---|
| 裸の「はい」 | ✅ `確認が2件ある。自己反省記憶と戦略記録、どちらへの返事か教えて。` |
| 　同上 | ✅ 自己反省は `candidate` のまま（勝手に active にしない） |
| 　同上 | ✅ 戦略記録の訂正も確定しない（`confirmDecisionCorrection` 呼び出し 0回） |
| 裸の「違う」 | ✅ 同じく聞き返す。`rejected` にもしない |
| 「戦略記録ははい」 | ✅ 戦略側だけ確定（自己反省は `candidate` のまま） |
| 自己反省だけ保留の「はい」 | ✅ 従来どおり `active` になる（過剰に黙らせていない） |

**推測で片方を確定させない形になっている。** 9/9。

### ② P2 3件（**すべて解消**）

| 項目 | 反証結果 |
|---|---|
| 同一session短時間連続 | 1秒差 ✅出ない／9分後 ✅出ない／**10分超で初めて proposal** ✅ |
| 保持上限で `active` を守る | 合意済み `active` 作成後に**候補30件**を追加 → ✅ `active` は残る |
| 周回遅れの自由文・数字 | 入力「周回遅れを**0.5秒以内**で…」→ 発話 `前回の訂正：周回遅れと同一周回の車を明確に区別して伝える。` ✅ 数値も原文も乗らない（英語も同様） |

8/8。

### ③ ★Codex が「切り分け中」とした preflight 不合格4件の切り分け

Codex の報告：`HTTP統合・requireAdmin・deploy契約・G5 GAP出口が不合格`。
**個別に実行して切り分けた。**

| テスト | Claude 環境 | 判定 |
|---|---|---|
| `tests-chat-http.js` | **exit 0** | Codex 環境の stub server 起動失敗（環境要因） |
| `tests-require-admin.js` | **exit 0** | 同上（環境要因） |
| `tests-deploy-verification.js` | **exit 0**（28/28） | 同上（環境要因） |
| `tests-gap-answer-queue.js` | **exit 1** | **★環境要因ではない。実回帰。** |

```
ReferenceError: handleLunaSelfMemoryInput is not defined
```

`sendMsg` の先頭に自己反省記憶の分岐が入ったため、
`sendMsg` を vm へ抽出している私のテストの窓に新しい依存が入っていなかった。
**先に報告した `tests-evidence-debrief.js` と同型。** 製品は動く（関数宣言は巻き上げられる）。

#### 直した（自分のテストなので Codex の作業中ファイルには触れていない）

スタブで潰さず、**本番の `handleLunaSelfMemoryInput` をそのまま抽出して動かす**形にした。
潰すと「**自己反省記憶が GAP の質問を飲み込む**」回帰を検出できなくなるため。
`tests-gap-answer-queue.js` **44/44** へ復帰。

### 検証（Claude 独立実行）

| 項目 | 結果 |
|---|---|
| P1 反証（本番関数を vm 実行） | **9/9** |
| P2 反証（本番 module を直接実行） | **8/8** |
| `tests-gap-answer-queue.js` | **44/44**（回帰を修正） |
| JS 全スイープ | ✅ **全緑（失敗0）** |
| Python | ✅ **305 passed** |
| `./preflight.sh` | ✅ **出荷可（不合格0件）** |
| `luna-self-memory.js` の外部有料API参照 | **0件** |

### 判定

**P0 0件 / P1 0件 / 残 P2 0件。**
Codex が挙げた preflight 不合格4件のうち **3件は環境要因、1件は実回帰で、こちらで解消した**。
`./preflight.sh` は**不合格0件で出荷可**。

**Gate 3・Gate 4 は、この作業ツリーの状態では満たされている。**
ただし**まだ commit されていない**ため、Build 対象SHA が確定していない。
Build を始めるには、Codex の作業中変更と本件の commit が先。

### 未実施の再掲

**Gate 5（新SHAの artifact）・Gate 6（Windows）・Gate 7（server）・Gate 8（実走）は未実施。**
公開中の Build 286 には自己反省記憶は入っていない。

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-26 | `2e51514` | 規則違反の訂正 | 担当決めを Yuji へ投げた件の訂正 |
| 08-26 | 本節 | Build 287 修正の独立再確認 | P1/P2 全件解消・preflight 不合格4件の切り分け・GAP テスト回帰の修正 |

## 2026-08-26 JST — Claude Code 作業終了報告（Build 287 修正の独立再確認）

必須MD報告。前回この形を書かずに終わらせたため Yuji から指摘された。

### 1. 作業日時と担当

2026-08-26 JST。**確認担当 Claude Code**（実装は Codex）。

### 2. 対象

| 項目 | 値 |
|---|---|
| 対象SHA | **未確定**（Codex の実装が未コミットのため） |
| ブランチ | `build/286`（`origin/main` は `828ca13`） |
| Build番号 | **未採番**（Codex は「Build 287」と呼称。`bridge.py` の `BUILD_VERSION` は **286 のまま**） |
| 公開中 | Build 286（`92e82a3` 由来・自己反省記憶を**含まない**） |

### 3. 変更ファイル

**Codex の実装には触っていない。** Claude が変更したのは1本だけ。

| ファイル | 内容 |
|---|---|
| `tests-gap-answer-queue.js` | `sendMsg` の抽出窓に `handleLunaSelfMemoryInput` / `lunaSelfMemoryProposalLine` を追加。スタブで潰さず本番関数を実行する形にした |
| `review/PITWALL_SHARED_WORKING_LOG.md` | 本報告と再確認結果 |

未コミットで残っている他担当の変更（**触っていない**）:
`AGENTS.md` / `HANDOFF.md` / `desktop/renderer.html` / `desktop/strategy-playbook.js` /
`irsdk-bridge/bridge.py` / `irsdk-bridge/tests_pit_exit_forecaster_wiring.py` / `tests-strategy-playbook.js` /
`desktop/luna-self-memory.js`（未追跡） / `tests-luna-self-memory.js`（未追跡）

### 4. 実行したテスト（件数・終了コード）

| テスト | 件数 | exit |
|---|---|---|
| P1 反証（本番 `handleLunaSelfMemoryInput` を vm 実行） | 9/9 | 0 |
| P2 反証（本番 `luna-self-memory.js` を直接実行） | 8/8 | 0 |
| `tests-gap-answer-queue.js` | 44/44 | 0 |
| `tests-luna-self-memory.js` | — | 0 |
| `tests-strategy-playbook.js` | — | 0 |
| `tests-evidence-debrief.js` | 41/41 | 0 |
| `tests-session-memory-tunnel.js` | 118/118 | 0 |
| `tests-runtime-module-status.js` | 11/11 | 0 |
| `tests-chat-http.js` / `tests-require-admin.js` / `tests-deploy-verification.js` | — | 0（Codex 環境では失敗＝環境要因と切り分け） |
| `irsdk-bridge/tests_pit_exit_forecaster_wiring.py` | — | 0 |
| Python discover | 305 tests | 0 |
| JS 全スイープ | 失敗0 | — |
| `./preflight.sh` | 不合格0件 | 0 |

外部有料API呼出 **0件**。

### 5. artifact

**作成していない。** 本作業で build は行っていない。

### 6. Gate 0〜9

| Gate | 状態 |
|---|---|
| 0 変更範囲 | **合格**（他担当の未追跡ファイルを混ぜていない） |
| 1 失敗の固定 | **合格** |
| 2 package 対象 | **合格**（renderer 参照9本・派生検査が新moduleを自動で拾う） |
| 3 機械検証 | **合格**（preflight 不合格0件。Codex の不合格4件は 3件=環境要因／1件=実回帰でこちらが解消） |
| 4 P0/P1 | **合格**（P0 0件・P1 0件・残 P2 0件） |
| 5 artifact | **未実施**（新SHAの artifact が存在しない） |
| 6 Windows | **未実施** |
| 7 server | **未実施**（本番は `828ca13`＝Build 284 のコード。`/api/memory/decisions` は 404） |
| 8 iRacing 実走 | **未実施** |
| 9 公開 | Build 286 について**実施済み**。自己反省記憶スライスは**未公開** |

### 7. push / deploy / 公開 / Windows / 実走の有無

| 操作 | 実施 |
|---|---|
| commit | **あり**（`6fdf10d`・Claude の2ファイルのみ） |
| push | **なし**（本作業では push していない） |
| private build | **なし** |
| server deploy | **なし** |
| 公開 Release | **なし**（Build 286 の公開は先行作業） |
| Windows 実機確認 | **なし** |
| iRacing 実走 | **なし** |

### 8. 未完了項目と次の担当・手順

| # | 項目 | 担当 | 手順 |
|---|---|---|---|
| 1 | 自己反省記憶スライスの commit | **Codex** | 実装が未コミットのため対象SHAが確定しない。Build はその後 |
| 2 | `BUILD_VERSION` の採番 | **Codex**（実装側） | 現在 286 のまま。公開済み 286 と中身が違うので **287 へ上げないと Build 282 型の事故** |
| 3 | Gate 5 artifact | Yuji の build GO 後 | `./verify-artifact.sh <run> <sha> 287` |
| 4 | Gate 6 Windows | **Yuji** | `BUILD286_GATE6_WINDOWS_HANDOFF.md`（新Build時は差し替え） |
| 5 | Gate 7 server | **Yuji の deploy GO** | `origin/main` への push が必要 → `./verify-deploy.sh` |
| 6 | Gate 8 実走 | **Yuji** | iRacing |

### 9. 到達段階（混同しない）

| 段階 | 状態 |
|---|---|
| 実装済み | ✅（Codex 実装・Claude 確認済） |
| 内部テスト済み | ✅（§4。すべて exit 0） |
| artifact 確認済み | ❌ **未実施**（新SHAの artifact が存在しない） |
| Windows 確認済み | ❌ **未実施** |
| 実走済み | ❌ **未実施** |
| 公開済み | ❌ **自己反省記憶スライスは未公開**（公開中の 286 には入っていない） |

**Gate 5・6・7・8 はいずれも未実施である。**
本報告は「ソースと内部テストが合格」までであり、**出荷可の宣言ではない。**

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-26 | `6fdf10d` | Build 287 修正の独立再確認 | P1/P2 全件解消・不合格4件の切り分け・GAPテスト回帰の修正 |
| 08-26 | 本節 | 作業終了報告（必須9項目） | 上記 |

## 2026-08-26 Codex → Claude Code — Build 287 Gate 5 artifact独立確認指示

YujiのBuild GO後、Codexは実装を`717803478b6fac2c4eafd50613a9425692e13af4`へcommit・pushし、push eventのprivate Desktop workflow `32959088403`を完走した。Publishはskipped。

`./verify-artifact.sh 32959088403 717803478b6fac2c4eafd50613a9425692e13af4 287`のCodex実測は次のとおり。

- artifact: `OMORAY-PITWALL-Desktop-Build-287-20260826-1037` / 302,000,718 bytes
- installer: 100,663,849 bytes / SHA-256 `88c7dbe8592b826fe732beafdf4401d2ebb07a52bf8b9d4b5e5be5da1479fd91`
- app.asar: 4,271,175 bytes / `51fcecf6e04b5aae5eec4f61ce0ffca1d4d2aa2926b14be0690b5ca1439124b6`
- Bridge: 17,013,686 bytes / `61089b1a37fb05793f6ac3f98f46cabe1c330eac5aff8f260fca30ead075e633`
- runtime module 9/9、`luna-self-memory.js`あり、`buildNum=287`、Bridge内Build 287、旧286なし、対象SHA正規化一致

Claude Codeは作業者の数値を転載せず、同runを独立に取得・展開し、SHA、9 module、Build 287、Publish skipped、対象SHAを再計算してGate 5の確認者署名を記録すること。Windows Gate 6、server Gate 7、iRacing Gate 8、公開Gate 9は未実施として混同しない。

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-26 | 本節 | Build 287 Gate 5 artifact独立確認指示 | private run・対象SHA・Codex実測値とClaude独立再計算依頼 |

## 2026-08-26 JST — Claude Code 作業終了報告（Build 287 Gate 5 独立確認・**確認者署名**）

必須MD報告。**Codex の数値は転載せず、同 run を独立に取得・展開して再計算した。**

### 1. 作業日時と担当

2026-08-26 JST。**確認担当 Claude Code**（実装・build は Codex）。

### 2. 対象

| 項目 | 値 |
|---|---|
| 対象SHA | `717803478b6fac2c4eafd50613a9425692e13af4` |
| ブランチ | `origin/main` は `828ca13` のまま（対象SHA は build ブランチ側） |
| Build番号 | **287**（`BUILD_VERSION = "Build 287 (driver-confirmed Luna self-memory and strategy condition guards)"`） |
| workflow run | `32959088403`（push event / private） |

**私が Build 286 報告で未完了に挙げた「`BUILD_VERSION` が 286 のまま」は解消**（287 へ採番済み）。

### 3. 変更ファイル

**本作業で Claude が変更したファイルは無い**（確認のみ）。
対象SHA と公開中 Build 286（`92e82a3`）の出荷経路の差分：

```
desktop/luna-self-memory.js   +116（新規）
desktop/renderer.html         +119 -1
desktop/strategy-playbook.js  +41
irsdk-bridge/bridge.py        +5 -1
irsdk-bridge/tests_pit_exit_forecaster_wiring.py +1
```

### 4. 実行したテスト（件数・終了コード）

**対象SHA を隔離 worktree へ出して実行**（本作業ツリーには触っていない）。

| 項目 | 結果 | exit |
|---|---|---|
| JS 全スイープ（対象SHA） | **失敗0** | — |
| `tests-gap-answer-queue.js` | 44/44 | 0 |
| `tests-runtime-module-status.js` | 11/11 | 0 |
| `tests-luna-self-memory.js` / `tests-strategy-playbook.js` | — | 0 |
| Python discover | 305 tests | 0 |
| `./preflight.sh`（対象SHA） | **出荷可** | 0 |

初回は5本が失敗したが、**worktree に root の `node_modules` が無いだけの環境要因**と切り分けた
（用意して再実行 → 全て exit 0）。**実回帰ではない。**

### 5. artifact（すべて Claude が自分で再計算）

| 項目 | 実測値 |
|---|---|
| artifact | `OMORAY-PITWALL-Desktop-Build-287-20260826-1037` / 302,000,718 bytes |
| run headSha | `717803478b6fac2c4eafd50613a9425692e13af4`（**対象SHAと一致**） |
| Publish | **skipped**（private） |
| installer | 100,663,849 bytes / `88c7dbe8592b826fe732beafdf4401d2ebb07a52bf8b9d4b5e5be5da1479fd91`（**3本すべて同一ハッシュ**） |
| app.asar | 4,271,175 bytes / `51fcecf6e04b5aae5eec4f61ce0ffca1d4d2aa2926b14be0690b5ca1439124b6` |
| Bridge | 17,013,686 bytes / `61089b1a37fb05793f6ac3f98f46cabe1c330eac5aff8f260fca30ead075e633` |
| **runtime module 欠落数** | **0**（9/9・`luna-self-memory.js` を含む） |
| build-info | `buildNum = 287` |
| Bridge 内 | `Build 287` 実在／**旧 `Build 286` は同じ箇所に無し**／`pygame` 52件（正しい系統） |
| 同梱物と対象SHA | **CRLF 正規化後に一致** |

**不合格 0 件。** Codex の申告値と独立再計算値は全項目一致した。

### 6. Gate 0〜9

| Gate | 状態 |
|---|---|
| 0 変更範囲 | **合格** |
| 1 失敗の固定 | **合格** |
| 2 package 対象 | **合格**（renderer 参照9本すべて実物に同梱） |
| 3 機械検証 | **合格**（対象SHA で preflight 出荷可・失敗0） |
| 4 P0/P1 | **合格**（P1/P2 は `6fdf10d` で全件解消を反証済み） |
| **5 artifact** | **合格 — 確認者署名: Claude Code（実装・build は Codex＝作業者と確認者が別）** |
| 6 Windows | **未実施** |
| 7 server | **未実施**（本番は `828ca13`＝Build 284 のコード。`/api/memory/decisions` は 404） |
| 8 iRacing 実走 | **未実施** |
| 9 公開 | **未実施**（Build 287 は private。公開中は Build 286＝自己反省記憶を含まない） |

### 7. push / deploy / 公開 / Windows / 実走の有無

| 操作 | 実施 |
|---|---|
| commit | **なし**（本報告の MD 追記のみ） |
| push | **なし** |
| private build | **なし**（Codex が実施済み） |
| server deploy | **なし** |
| 公開 Release | **なし** |
| Windows 実機確認 | **なし** |
| iRacing 実走 | **なし** |

### 8. 未完了項目と次の担当・手順

| # | 項目 | 担当 | 手順 |
|---|---|---|---|
| 1 | Gate 6 Windows | **Yuji** | Build 287 installer（SHA `88c7dbe8…`）を取得・起動し、`RUNTIME_MODULE_STATUS` が **9本**・`missing:[]`・`status:"loaded"` を ACK |
| 2 | Gate 7 server | **Yuji の deploy GO** | `origin/main` への push が必要 → `./verify-deploy.sh` |
| 3 | Gate 8 実走 | **Yuji** | iRacing。自己反省の訂正往復と次回自発発話は実走でしか確認できない |
| 4 | Gate 9 公開 | **Yuji の別GO** | Gate 6/8 の後 |
| 5 | Gate 6 handoff の更新 | Claude | `BUILD286_GATE6_WINDOWS_HANDOFF.md` は Build 286 向け。**287 用に差し替えが要る**（module 8本→9本、SHA 変更） |

### 9. 到達段階（混同しない）

| 段階 | 状態 |
|---|---|
| 実装済み | ✅（Codex） |
| 内部テスト済み | ✅（対象SHA で全緑・exit 0） |
| **artifact 確認済み** | ✅ **Codex 作成／Claude 独立再計算で一致。確認者署名あり** |
| Windows 確認済み | ❌ **未実施** |
| 実走済み | ❌ **未実施** |
| 公開済み | ❌ **未実施**（公開中は Build 286） |

**Gate 6・7・8・9 はいずれも未実施である。**
本報告は「artifact が対象SHAの中身を含む」までであり、**実走で動く証拠でも出荷可でもない。**

### 自分の実行ミスの訂正（記録）

`git show $S:tests-...` と書いたところ、zsh が `:t` を修飾子として解釈し、
「私の修正が対象SHA に入っていない」という**誤った観測**を得た。
正しい記法（`"${S}:path"`）で再確認したところ**正しく入っていた**。
誤報する前に確かめたので実害は無いが、記録する。

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-26 | `2cf40d9` | 作業終了報告（Build 287 修正の独立再確認） | 必須9項目 |
| 08-26 | 本節 | 作業終了報告（Build 287 Gate 5 独立確認） | Gate 5 確認者署名・独立再計算・未実施の再掲 |

## 2026-08-27 Yuji指示 — 今夜アップデート候補（2案件・配線必須）

今夜の次Build候補として、以下の2案件を同一作業台帳で扱う。**コードや画面だけを追加して完了扱いにせず、本番入力・判断・発話・記憶／次回戦略までの実配線と配線テストを必須**とする。現時点では記録のみで、Build・公開は行わない。

### 1. 燃料判断 — 「将来ピットが必要」と「今すぐピット推奨」の分離

- 残燃料・残周回・必要燃料・不足量の計算結果と、ピット実行時期の判断を分離する。
- レース完走まで給油が必要でも、現在燃料でピットを先延ばしできる場合は `pit now` の根拠にしない。
- Plan側のピットウインドウと会話回答側の推奨時期を同じ決定論的判断へ一本化する。
- 全キャラクター共通エンジンとして修正し、Luna限定にしない。

### 2. 運転スタイル分析 — 本人基準・実測参照・一般傾向の出典分離

PITWALLの商品思想は巨大な分析ダッシュボードではなく、**ドライバーとの関係性**である。60Hz生データはローカルで特徴量へ集約し、必要な助言だけを担当エンジニアが会話で返す。

比較優先順位：

1. 本人の同条件ベストラップ
2. 本人の安定して速かった複数クリーンラップ
3. 本人が確認・登録した基準ラップ
4. 提供・登録された速いドライバーの実測テレメトリ
5. 車種・コーナー特性に基づく一般的な速い運転傾向

発話では根拠を混同しない。

- 本人比較：`あなたのベスト時と比べると`
- 実測参照あり：`登録されたリファレンスドライバーと比べると`
- 一般論のみ：`一般的な傾向としては`。参照実測が無いのに距離・速度・時間差を捏造しない。

必要な実配線：

- iRacing 60Hz入力 → ローカル特徴量集約（ブレーキ開始、最低速度、アクセル開始／全開、操舵修正、再現性など）
- invalid lap、pit lap、yellow、traffic、燃料・タイヤ条件差を比較対象から除外または明示
- 比較根拠とconfidenceをtruth/evidence gateへ接続
- 発話は一度に改善課題を絞り、数値一覧や新規ダッシュボードを主役にしない
- ドライバーが有効性を確認した内容だけ、確認済み記憶および次回戦略条件へ接続
- Jamesを含む全キャラクターで同じ分析能力を共有し、言語・声・人格のみを差分とする
- 純粋関数テスト、保存ログ再生、bridge/renderer実配線テスト、キャラクター同等性回帰を追加

### 完了条件

2案件とも、`入力取得 → 条件除外 → 決定論的評価 → evidence付き発話 → ドライバー確認 → 記憶／次回戦略` の往復がテストで証明されるまで完了としない。Build番号採番、artifact、Windows、実走、公開は別Gateとして、YujiのGOなしに進めない。

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-27 | 未commit | 今夜アップデート候補（2案件・配線必須） | 燃料pit-now誤判定と、運転スタイル分析の比較根拠・記憶／次回戦略までの実配線 |

## 2026-08-27 次チャット引き継ぎ

- 今夜はYujiの走行なし。新しいWindows／iRacing実走証拠は無く、未検証Gateを合格扱いしない。
- 次チャットはBuild 287公開済みを基準に、燃料pit-now誤判定と運転スタイル分析V1の2案件を実装・内部検証する。
- Build・公開は新しいGOまで行わない。
- **次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`**

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-27 | 未commit | 次チャット引き継ぎ | 未実走の記録・2案件の開始指示・専用指示書への導線 |

## 2026-08-27 Codex作業報告 — 燃料pit timing権威／運転スタイル分析V1（未公開）

- 基準: 公開済みBuild 287（`d05ea07`）。Build番号は変更せず、build / artifact / push / deploy / 公開は実施していない。
- 燃料: `plan_fuel_authority.py` に常時生成の `pit_timing_authority` を追加し、航続周回、完走必要量・不足量、最終pit周、`pit_now / hold / pit_later`、Plan A/B/C windowを同じBridge決定論契約へ統合。`bridge.py` telemetryへ実配線し、`local-intent-router.js` は総不足量だけからpit-nowを生成せず同契約を読む。
- 運転スタイル: `driving_style.py` が60Hz入力をlocal clean-lap特徴へ集約。invalid lap / pit lap / yellow / trafficを除外し、raw samplesは外へ出さない。`driving-style-v1.js` は本人best、本人安定周、本人確認基準、登録実測reference、一般傾向を優先順と発話prefixで分離し、改善課題を1件に限定。一般傾向で具体数値を生成しない。
- 往復: renderer telemetry受信→認証user/track/car単位compact profile→決定論比較→短い発話→本人yes/no→yesだけactive memory / 次回条件、noは破棄。全キャラクターが同じmoduleを通り、言語差だけformatで分離。
- 変更対象: `HANDOFF.md`, `preflight.sh`, `desktop/driving-style-v1.js`, `desktop/local-intent-router.js`, `desktop/renderer.html`, `irsdk-bridge/driving_style.py`, `irsdk-bridge/bridge.py`, `irsdk-bridge/plan_fuel_authority.py`, `irsdk-bridge/tests_driving_style.py`, `tests-driving-style-v1.js`, `tests-fuel-timing-authority.js`, 本共有ログ。
- targeted結果: 新規JS **14/14**、新規Python **3 tests**、Python全件 **308 tests**、燃料Plan 24、Fuel authority 27、local router 38、runtime module 12、session-memory tunnel 118、strategy playbook 39、GAP answer queue 44、すべてexit 0。renderer / Python構文も合格。外部有料API呼び出し0。
- preflight再実行: 新規配線由来のG5 harness failure 1件（抽出関数で新global未定義）を修正し44/44へ復帰。新設した燃料timing Gateと運転スタイルGateはいずれも合格。全体はexit **1**で、既存server/admin/deployのlocal起動3件（server early exit / local stub未起動）が不合格。新規2案件と無関係だがGate 3全合格とは記録しない。
- 未達Gate: Build / artifact / Windows / iRacing実走 / push / server deploy / 公開は全て未実施。yellow/traffic、fuel/tyre条件差、実測reference import、助言有用性、driver handoff後の実機継続性は実走または次スライス確認が必要。
- **次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`**

## 2026-08-27 JST — Claude Code 作業終了報告（燃料timing権威／運転スタイルV1 独立確認）**P1 1件・P2 2件**

次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`

必須MD報告。**Codex 実装／Claude 確認**。実装ファイルには触っていない。

### 1. 作業日時と担当

2026-08-27 JST。**確認担当 Claude Code**（実装は Codex）。

### 2. 対象

| 項目 | 値 |
|---|---|
| 基準 | 公開済み Build 287（`d05ea07`） |
| 対象 | **未コミットの作業ツリー** |
| Build番号 | **287 のまま**（採番されていない） |

### 3. 変更ファイル

**Claude は1ファイルも変更していない**（確認のみ）。確認対象は Codex の未コミット変更：
`desktop/local-intent-router.js` / `desktop/renderer.html` / `irsdk-bridge/bridge.py` /
`irsdk-bridge/plan_fuel_authority.py` / `preflight.sh` /
`desktop/driving-style-v1.js`（未追跡） / `irsdk-bridge/driving_style.py`（未追跡） /
`tests-driving-style-v1.js` / `tests-fuel-timing-authority.js` / `irsdk-bridge/tests_driving_style.py`

### 4. 実行したテスト（件数・終了コード）

| テスト | 件数 | exit |
|---|---|---|
| `tests-fuel-timing-authority.js` | 3/3 | 0 |
| `tests-driving-style-v1.js` | 11/11 | 0 |
| `irsdk-bridge/tests_driving_style.py` | — | 0 |
| JS 全スイープ | 失敗0 | — |
| Python discover | **308 tests** | 0 |
| `./preflight.sh` | 出荷可 | 0 |
| Claude 独自の反証（燃料） | 7/8 | — |
| Claude 独自の反証（運転スタイル） | 15/16 | — |
| Claude 独自の反証（同時保留） | **1/3** | — |

外部有料API呼出 **0件**。

### 5. artifact

**作成していない。** build / push / 公開いずれも未実施。

---

## ★P1 — 「はい」の取り合いが**3経路目で復活**した

Codex が `6fdf10d` の指摘を受けて入れた「両方保留なら聞き返す」調停を、
**運転スタイルの確認がその前に入って迂回している。**

```
renderer.html:2236  pendingDrivingStyleAdvice && /^(?:はい|…|yes|…)$/   ← ★先に走る
renderer.html:2246  handleLunaSelfMemoryInput(text)                     ← 調停はこの中
renderer.html:2310  pendingDecisionDispute && /^(?:はい|…)$/
```

肯定語は3経路とも `はい` / `yes` に一致する。**運転スタイルを含む同時保留の分岐は存在しない**（grep 0件）。

### 実挙動（本番 `sendMsg` を vm で実行）

| 保留状態 | 入力 | 結果 |
|---|---|---|
| 運転スタイル＋Decision訂正 | 「はい」 | ❌ **運転スタイルが横取りして保存**／Decision訂正は確定せず |
| 運転スタイル＋自己反省 | 「はい」 | ❌ **運転スタイルが横取り** |
| 運転スタイルのみ | 「はい」 | ✅ 正常に保存（過剰に黙らせてはいない） |

### 再現手順と実害

1. 「それ違う」→ Decision 記録が `disputed`（利用停止・読み返し）
2. 「走りを分析して」→ 運転スタイル助言、`pendingDrivingStyleAdvice` セット
3. 「はい」（**1 に答えたつもり**）

- **合意していない運転スタイル助言が「確認済み」として次回条件へ残る**
- **`disputed` の Decision 記録が二度と復帰しない**

`6fdf10d` で報告し Codex が修正した P1 と**同一の実害**。
**確認経路を1つ足すたびに同じ穴が開く**ので、個別の if ではなく
「保留中の確認を集めて、2つ以上なら聞き返す」共通の調停へ寄せるのが筋。

---

### P2-1 — `confirm()` が `available` を見ておらず、**中身の無い記録を「確認済み」にする**

`driving-style-v1.js:44` の `confirm()` は `result.available` を検査しない。

```
compare結果: {"available":false,"reason":"no_clean_lap_features"}
→ confirm(...,accepted=true) が保存する:
  {"status":"active","source":undefined,"condition":{}}
```

**renderer 側は `if(result.available)pendingDrivingStyleAdvice=result;` で防いでいる**ため
通常経路からは到達しない。よって P2。ただし module 単体では素通りするので、
呼び出し側の1行に依存している状態。

### P2-2 — `range_laps` 欠損で router が例外を投げる

`local-intent-router.js:99` は `available===true` を信頼して `range.toFixed(1)` を呼ぶ。
`range_laps` が null だと **TypeError**。router 呼び出しは `sendMsg` 内で try/catch されておらず、
`sendMsg` は呼び出し元が await/catch しないため、**ドライバーの質問が無言で消える**。

**現行 Bridge では起きない**（`plan_fuel_authority.py:48` が
`'available': range_laps is not None` としているため）。よって P2。
ただし「available を信じて null 検査を省く」形は、Bridge 側の不変条件が変わった瞬間に P1 化する。

---

### 確認できた点（主張は成立している）

**案件1 — 燃料 timing 権威**

| 検証 | 結果 |
|---|---|
| 不足30L でも `decision=hold` なら | ✅ 「今周ピット」と言わない。`現燃料で約17.4周。完走まで30.0L不足。今は待てる。最終目安は18周目、あと8周。` |
| `decision=pit_now` | ✅ 「今周ピット。」と言う（過剰に黙っていない） |
| `decision=pit_later` | ✅ 今周pitを勧めない |
| **権威なし（従来経路）** | ✅ 不足量は述べるが**今周pitを勧めない**＝元の欠陥は再現しない |
| `available=false` | ✅ 権威として採用しない |
| キャラクター限定でないか | ✅ 分岐にキャラ名参照 **0件** |

**案件2 — 運転スタイルV1**

| 検証 | 結果 |
|---|---|
| 出典の優先順位 | ✅ self_best → self_consistent → driver_confirmed → measured_reference → general_tendency |
| **参照が無い時の捏造** | ✅ **数字を一切出さない**（日英とも）。`numeric_allowed=false` / `confidence=low` |
| 改善候補は1件 | ✅ `point` は単一。発話に1つだけ |
| 燃料差 >10L の参照 | ✅ 除外し、理由を `excluded_references` に残す |
| タイヤ差 >15℃ の参照 | ✅ 除外 |
| 本人肯定時だけ保存 | ✅ 否定・identity欠損では保存しない |
| invalid / pit / yellow / traffic | ✅ Bridge 側 `driving_style.py:49-52` で除外 |
| raw 60Hz を外へ出さない | ✅ `driving_style` に samples/raw は無い |
| 全キャラクター共通 | ✅ module にキャラ名参照 **0件**。差分は言語のみ |

#### 観察（欠陥ではない）

`general_tendency` は参照が無いため `deltas` が空になり、**常に「一つに絞れる明確な差がない」**を返す。
捏造しない点では正しいが、指示書の「車種・コーナー特性に基づく一般的な速い運転傾向」は
**実質まだ助言を返さない**。V1 の割り切りとしては妥当だが、意図どおりか確認したい。

---

### 6. Gate 0〜9

| Gate | 状態 |
|---|---|
| 0 変更範囲 | **合格**（Claude は実装に触れていない） |
| 1 失敗の固定 | **合格** |
| 2 package 対象 | **保留**（`driving-style-v1.js` は未追跡。renderer 参照に入れば派生検査が自動で拾う） |
| 3 機械検証 | **合格**（preflight 出荷可・JS全緑・Python 308） |
| 4 P0/P1 | **不合格 — P1 1件**（上記） |
| 5 artifact | **未実施** |
| 6 Windows | **未実施** |
| 7 server | **未実施** |
| 8 iRacing 実走 | **未実施**（2026-08-27 は Yuji の走行なし） |
| 9 公開 | **未実施** |

### 7. push / deploy / 公開 / Windows / 実走の有無

| 操作 | 実施 |
|---|---|
| commit | **本報告のMD追記のみ** |
| push / private build / deploy / 公開 | **すべて なし** |
| Windows 実機確認 / iRacing 実走 | **なし** |

### 8. 未完了項目と次の担当・手順

| # | 項目 | 担当 | 手順 |
|---|---|---|---|
| 1 | **P1 の解消** | **Codex** | 保留中の確認を集約し、2つ以上なら聞き返す共通調停へ。個別 if を足す形では次の機能でまた開く |
| 2 | P2-1 | Codex | `confirm()` で `result.available!==true` を弾く |
| 3 | P2-2 | Codex | `range` / `shortfall` の null 検査、または router 呼び出しの try/catch |
| 4 | Build番号採番 | Codex | 現在 287 のまま。公開中 287 と中身が違うので**288 へ上げないと Build 282 型の事故** |
| 5 | Gate 5〜9 | Yuji の GO | P1 解消後 |

### 9. 到達段階（混同しない）

| 段階 | 状態 |
|---|---|
| 実装済み | ✅（Codex） |
| 内部テスト済み | ✅（既存テストは全緑）。ただし**独立反証で P1 1件・P2 2件**を検出 |
| artifact 確認済み | ❌ **未実施** |
| Windows 確認済み | ❌ **未実施** |
| 実走済み | ❌ **未実施**（8/27 は走行なし） |
| 公開済み | ❌ **未実施**（公開中は Build 287・本変更を含まない） |

**P1 が残るため Build 候補にしない。Gate 5・6・7・8・9 はいずれも未実施。**

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-26 | `677a235` | Build 287 Gate 5 独立確認 | 確認者署名 |
| 08-27 | 本節 | 燃料timing権威／運転スタイルV1 独立確認 | P1 1件・P2 2件・成立した主張の一覧 |

## 2026-08-27 Codex → Claude Code — 独立確認P1/P2修正・再確認依頼

Claude独立確認で検出された3件を修正した。

- P1: `pendingConfirmationKinds()` で運転スタイル、自己反省記憶、Decision訂正の全保留を収集する共通arbiterを `sendMsg` 冒頭へ追加。裸の肯定／否定かつ2件以上なら、個別consumerへ到達する前に対象を聞き返す。運転スタイル＋Decision、運転スタイル＋自己反省の本番`sendMsg` VM再生で、両方とも未確定のまま維持することを確認。
- P2-1: `driving-style-v1.confirm()` は `result.available===true` と実feature pointを必須化。空助言は `advice_unavailable` で保存しない。rendererもpointがある時だけconfirmation pendingを作る。
- P2-2: fuel timingは `available===true` だけでなくfinite `range_laps` を要求してから `toFixed()` する。malformed payloadは従来fail-closed回答へ戻り、例外を投げない。
- targeted: `tests-driving-style-v1.js` **13/13**、`tests-fuel-timing-authority.js` **4/4**、`tests-gap-answer-queue.js` **49/49**、`tests-luna-self-memory.js` **18/18**、renderer / module構文、`git diff --check`、すべてexit 0。外部有料API呼び出し0。
- Build番号、commit、push、build、artifact、Windows、実走、公開は未実施。Claudeは作業者の結果を転載せず、同時保留3系統とmalformed module inputを独立に再実行し、P1/P2解消を判定すること。
- **次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`**

## 2026-08-27 JST — Claude Code 作業終了報告（P1/P2修正の独立再確認）**全件解消**

次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`

必須MD報告。**Codex の結果は転載せず、同時保留3系統と malformed 入力を独立に再実行した。**

### 1. 作業日時と担当

2026-08-27 JST。**確認担当 Claude Code**（実装は Codex）。

### 2. 対象

| 項目 | 値 |
|---|---|
| 基準 | 公開済み Build 287（`d05ea07`） |
| 対象 | **未コミットの作業ツリー** |
| Build番号 | **287 のまま（未採番）** |

### 3. 変更ファイル

**Claude は1ファイルも変更していない。** 確認対象は Codex の未コミット変更。

### 4. 実行したテスト（件数・終了コード）

| テスト | 件数 | exit |
|---|---|---|
| Claude 独自反証（同時保留・本番 `sendMsg` を VM 再生） | **11/11** | 0 |
| Claude 独自反証（P2-1 空助言） | 2/2 | 0 |
| Claude 独自反証（P2-2 malformed payload） | 6/6 | 0 |
| `tests-driving-style-v1.js` | 13/13 | 0 |
| `tests-fuel-timing-authority.js` | 4/4 | 0 |
| `tests-gap-answer-queue.js` | 49/49 | 0 |
| `tests-luna-self-memory.js` | — | 0 |
| JS 全スイープ | 失敗0 | — |
| Python discover | 308 tests | 0 |
| `./preflight.sh` | 出荷可 | 0 |
| `git diff --check` | — | 0 |

外部有料API呼出 **0件**。

### P1 — 解消（本番 `sendMsg` を VM で再生して確認）

`pendingConfirmationKinds()` + `bareConfirmationAnswer()` + `confirmationClarification()` の
共通 arbiter が `sendMsg` 冒頭にあり、**個別 consumer へ到達する前に**聞き返す。

| 保留の組合せ | 「はい」 | 「いいえ」 |
|---|---|---|
| 運転スタイル＋Decision訂正 | ✅ 確定せず聞き返す | ✅ |
| 運転スタイル＋自己反省 | ✅ | ✅ |
| 自己反省＋Decision訂正 | ✅ | ✅ |
| **3つすべて** | ✅ | ✅ |

```
確認が3件ある。運転スタイル助言、自己反省記憶、戦略記録の訂正のどれへの返事か教えて。
```

**単独保留は従来どおり動く**（過剰に黙らせていない）：
運転スタイル単独「はい」→保存／「いいえ」→保存しない／Decision単独「はい」→確定する。

**指摘した「経路を足すたびに穴が開く」形が、集約 arbiter で構造的に閉じた。**
4つ目の確認を足しても `pendingConfirmationKinds()` に1行足すだけで済む。

### P2-1 — 解消

`driving-style-v1.confirm()` が `available===true` と実 feature point を必須化。

```
compare({available:false}) → confirm(accepted=true) → record=null ✅
compare(features無し・point無し) → record=null（advice_unavailable） ✅
```

### P2-2 — 解消

`local-intent-router.js:98` が `available===true` **かつ** `finite(range_laps)!==null` を要求。

| malformed 入力 | 結果 |
|---|---|
| `range_laps` 欠損 | ✅ 例外なし・従来 fail-closed 回答へ |
| `range_laps: null` | ✅ 同上 |
| `available` 以外すべて欠損 | ✅ 同上 |

### ★自分の harness の不足を2回踏んだ（記録）

同時保留の再生で2回「実挙動の問題」に見える失敗を出したが、**どちらも私の harness の stub 不足**だった。

1. `lastSessionNum is not defined` — 自己反省記憶が identity に session key を使うようになった
2. `sel is not defined` — Decision 訂正ブロックがキャラクター変数を参照している

**製品ではどちらも定義済みで動く。** 失敗を見た時点で「実挙動の問題」と報告せず、
例外の有無で切り分けてから結論を出した。**誤報はしていない。**

### 6. Gate 0〜9

| Gate | 状態 |
|---|---|
| 0 変更範囲 | **合格** |
| 1 失敗の固定 | **合格** |
| 2 package 対象 | **保留**（`driving-style-v1.js` は未追跡。renderer 参照に入れば派生検査が自動で拾う） |
| 3 機械検証 | **合格**（preflight 出荷可・JS全緑・Python 308） |
| 4 P0/P1 | **合格 — P0 0件 / P1 0件 / 残 P2 0件** |
| 5 artifact | **未実施** |
| 6 Windows | **未実施** |
| 7 server | **未実施** |
| 8 iRacing 実走 | **未実施**（2026-08-27 は Yuji の走行なし） |
| 9 公開 | **未実施** |

### 7. push / deploy / 公開 / Windows / 実走の有無

| 操作 | 実施 |
|---|---|
| commit | **本報告のMD追記のみ** |
| push / private build / deploy / 公開 | **すべて なし** |
| Windows 実機確認 / iRacing 実走 | **なし** |

### 8. 未完了項目と次の担当・手順

| # | 項目 | 担当 | 手順 |
|---|---|---|---|
| 1 | **Build番号の採番** | **Codex** | 現在 287 のまま。公開中 287 と中身が違うので **288 へ上げないと Build 282 型の事故** |
| 2 | 実装の commit | Codex | 未コミットのため対象SHAが確定しない |
| 3 | Gate 5 artifact | Yuji の build GO 後 | `./verify-artifact.sh <run> <sha> 288` |
| 4 | Gate 6 Windows | Yuji | 新Build用に `BUILD286_GATE6_WINDOWS_HANDOFF.md` の差し替えが要る（module 9→10本、SHA 変更） |
| 5 | Gate 7 server | Yuji の deploy GO | `origin/main` への push が必要 → `./verify-deploy.sh` |
| 6 | Gate 8 実走 | Yuji | 8/29 耐久の確認項目は指示書に9点ある |

### 9. 到達段階（混同しない）

| 段階 | 状態 |
|---|---|
| 実装済み | ✅（Codex） |
| 内部テスト済み | ✅（P1/P2 全件解消を独立反証。preflight 出荷可） |
| artifact 確認済み | ❌ **未実施** |
| Windows 確認済み | ❌ **未実施** |
| 実走済み | ❌ **未実施**（8/27 は走行なし） |
| 公開済み | ❌ **未実施**（公開中は Build 287・本変更を含まない） |

**Gate 5・6・7・8・9 はいずれも未実施である。**
本報告は「ソースと内部テストが合格」までであり、**出荷可の宣言ではない。**

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-27 | `15ff5ea` | 燃料timing権威／運転スタイルV1 独立確認 | P1 1件・P2 2件 |
| 08-27 | 本節 | P1/P2修正の独立再確認 | 全件解消・同時保留3系統 11/11・自分のharness不足の記録 |

## 2026-08-27 Codex → Claude Code — Build 288 Gate 5 artifact独立確認指示

YujiのBuild 288 GO後、Codexは実装を `2ba8ce4a72c4034e6b4c6af20eb41ce0fc007a12` へcommitし、`build/288`へpushした。push eventのprivate Desktop workflow `33074707192` はsuccess、Publishはskipped。

Codexの `./verify-artifact.sh 33074707192 2ba8ce4a72c4034e6b4c6af20eb41ce0fc007a12 288` 実測：

- artifact: `OMORAY-PITWALL-Desktop-Build-288-20260827-1302` / 302,056,340 bytes
- installer 3本同一: 100,682,608 bytes / SHA-256 `b6be060b3c056c0455e85eebc07ac19ae219a5338480d7d8a61d834d31961dc4`
- app.asar: 4,283,002 bytes / SHA-256 `e2eeb10c19b5803b5d3a5e0ef04e037264f51b9edf8f6041ca6508a23b9d43c9`
- Desktop同梱Bridge: 17,028,403 bytes / SHA-256 `bc97f1ff76850935d78ecb603443247925ac7f20127897df905ab4d64db02b15`
- runtime module 10/10（`driving-style-v1.js`含む）、対象SHA一致、`buildNum=288`、BridgeにBuild 288実在・旧287不在、pygame 52件

Claude Codeは上記数値を転載せず、別作業ディレクトリで同runを独立取得・展開し、bytes / SHA-256 / Publish skipped / module 10/10 /対象SHA / Build 288 / Bridge系統を再計算してGate 5確認者署名を記録すること。CodexからClaude CLIを起動した試行はローカルClaude Codeが未ログイン（`Not logged in · Please run /login`）のため検査開始前に終了した。変更・外部公開は無い。

Gate 6 Windows、Gate 7 server（server変更なしのためN/A根拠確認）、Gate 8 iRacing、Gate 9公開は未実施。Gate 5も確認者署名前なので全体合格にしない。

- **次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`**

## 2026-08-27 JST — Claude Code 作業終了報告（Build 288 Gate 5 独立確認・**確認者署名**）

次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`

必須MD報告。**Codex の数値は転載せず、別作業ディレクトリで同 run を独立取得・展開して再計算した。**

### 1. 作業日時と担当

2026-08-27 JST。**確認担当 Claude Code**（実装・build は Codex）。

### 2. 対象

| 項目 | 値 |
|---|---|
| 対象SHA | `2ba8ce4a72c4034e6b4c6af20eb41ce0fc007a12` |
| ブランチ | `build/288`（`origin/main` は動かしていない） |
| Build番号 | **288**（`BUILD_VERSION = "Build 288 (fuel timing authority and confirmed driving-style coaching v1)"`） |
| workflow run | `33074707192`（push event / private） |

**私が前回未完了に挙げた「`BUILD_VERSION` が 287 のまま」は解消**（288 へ採番済み）。

### 3. 変更ファイル

**Claude は1ファイルも変更していない**（確認のみ）。
公開中 Build 287（`d05ea07`）との出荷経路の差分：

```
desktop/driving-style-v1.js          +55（新規）
desktop/local-intent-router.js       +14
desktop/renderer.html                +67
irsdk-bridge/bridge.py               +33 -1
irsdk-bridge/driving_style.py        +80（新規）
irsdk-bridge/plan_fuel_authority.py  +70
irsdk-bridge/tests_driving_style.py  +38（新規）
7 files changed, 356 insertions(+), 1 deletion(-)
```

### 4. 実行したテスト（件数・終了コード）

**対象SHA を隔離 worktree へ出して実行**（本作業ツリーには触っていない）。

| 項目 | 件数 | exit |
|---|---|---|
| JS 全スイープ（対象SHA） | **失敗0** | — |
| `tests-driving-style-v1.js` | 13/13 | 0 |
| `tests-fuel-timing-authority.js` | 4/4 | 0 |
| `tests-runtime-module-status.js` | **12/12**（module 10本＋基本2件） | 0 |
| Python discover | **308 tests** | 0 |
| `./preflight.sh`（対象SHA） | **出荷可** | 0 |

外部有料API呼出 **0件**。

### 5. artifact（すべて Claude が自分で再計算）

| 項目 | 実測値 |
|---|---|
| artifact | `OMORAY-PITWALL-Desktop-Build-288-20260827-1302` / 302,056,340 bytes |
| run headSha | `2ba8ce4a72c4034e6b4c6af20eb41ce0fc007a12`（**対象SHAと一致**） |
| Publish | **skipped**（private） |
| installer | 100,682,608 bytes / `b6be060b3c056c0455e85eebc07ac19ae219a5338480d7d8a61d834d31961dc4`（**3本すべて同一ハッシュ**） |
| app.asar | 4,283,002 bytes / `e2eeb10c19b5803b5d3a5e0ef04e037264f51b9edf8f6041ca6508a23b9d43c9` |
| Bridge | 17,028,403 bytes / `bc97f1ff76850935d78ecb603443247925ac7f20127897df905ab4d64db02b15` |
| **runtime module 欠落数** | **0**（10/10・`driving-style-v1.js` を含む） |
| build-info | `buildNum = 288` |
| Bridge 内 | `Build 288` 実在／**旧 `Build 287` は同じ箇所に無し**／`active_decision_id` 実在／`pygame` 52件（正しい系統） |
| 同梱物と対象SHA | **CRLF 正規化後に一致** |

**不合格 0 件。** Codex の申告値と独立再計算値は全項目一致した。

### ★Gate 7 が N/A である根拠を鵜呑みにせず実測した

Codex は「server変更なしのため N/A」としていた。**差分で確認した。**

```
git diff d05ea07..2ba8ce4 -- server.js auth.js prompts.js engineer-card.js
→ 差分ゼロ
```

**Gate 7 は N/A で正しい。** 出荷経路の変更は desktop / irsdk-bridge のみ。
（`./verify-deploy.sh` は本 Build では不要。ただし将来 server を触った Build では必須。）

### 6. Gate 0〜9

| Gate | 状態 |
|---|---|
| 0 変更範囲 | **合格** |
| 1 失敗の固定 | **合格** |
| 2 package 対象 | **合格**（renderer 参照10本すべて実物に同梱） |
| 3 機械検証 | **合格**（対象SHA で preflight 出荷可・失敗0） |
| 4 P0/P1 | **合格**（P1/P2 全件解消を `7c6c34e` で独立反証済み） |
| **5 artifact** | **合格 — 確認者署名: Claude Code**（実装・build は Codex＝作業者と確認者が別） |
| 6 Windows | **未実施** |
| 7 server | **N/A**（server 系に差分ゼロを実測。根拠は上記） |
| 8 iRacing 実走 | **未実施**（2026-08-27 は Yuji の走行なし） |
| 9 公開 | **未実施**（Build 288 は private。公開中は Build 287） |

### 7. push / deploy / 公開 / Windows / 実走の有無

| 操作 | 実施 |
|---|---|
| commit | **本報告のMD追記のみ** |
| push / private build | **なし**（Codex が実施済み） |
| server deploy / 公開 Release | **なし** |
| Windows 実機確認 / iRacing 実走 | **なし** |

### 8. 未完了項目と次の担当・手順

| # | 項目 | 担当 | 手順 |
|---|---|---|---|
| 1 | **Gate 6 Windows** | **Yuji** | Build 288 installer（SHA `b6be060b…`）を起動し、`RUNTIME_MODULE_STATUS` が **10本**・`missing:[]`・`status:"loaded"` を ACK |
| 2 | **Gate 6 handoff の差し替え** | Claude | `BUILD286_GATE6_WINDOWS_HANDOFF.md` は Build 286 向け（module 8本・旧SHA）。**288 用が要る** |
| 3 | Gate 8 実走 | **Yuji** | 8/29 耐久。指示書の確認項目9点 |
| 4 | Gate 9 公開 | **Yuji の別GO** | Gate 6/8 の後 |

### 9. 到達段階（混同しない）

| 段階 | 状態 |
|---|---|
| 実装済み | ✅（Codex） |
| 内部テスト済み | ✅（対象SHA で全緑・exit 0） |
| **artifact 確認済み** | ✅ **Codex 作成／Claude 独立再計算で全項目一致。確認者署名あり** |
| Windows 確認済み | ❌ **未実施** |
| 実走済み | ❌ **未実施**（8/27 は走行なし） |
| 公開済み | ❌ **未実施**（公開中は Build 287） |

**Gate 6・8・9 は未実施である。**
本報告は「artifact が対象SHAの中身を含む」までであり、**実走で動く証拠でも出荷可でもない。**

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-27 | `7c6c34e` | P1/P2修正の独立再確認 | 全件解消 |
| 08-27 | 本節 | Build 288 Gate 5 独立確認 | 確認者署名・独立再計算・Gate 7 N/A の根拠実測 |

## 2026-08-27 Claude Code — Gate 6 handoff を Build 288 用へ差し替え

前節 §8 で未完了に挙げた項目の解消。

`BUILD286_GATE6_WINDOWS_HANDOFF.md` は Build 286 向けで、**期待値が module 8本・旧SHA**のままだった。
これで合否を出すと **Build 287 を掴んでいても（9本）合格に見える**。
`BUILD288_GATE6_WINDOWS_HANDOFF.md` を新設し、286 側には supersede 注記を入れた。

### Build 288 用の期待値（実物 asar から取った）

| 項目 | 値 |
|---|---|
| installer | `OMORAY-PITWALL-Setup-20260827-1302.exe` / 100,682,608 bytes |
| SHA-256 | `B6BE060B3C056C0455E85EEBC07AC19AE219A5338480D7D8A61D834D31961DC4` |
| 対象SHA | `2ba8ce4a72c4034e6b4c6af20eb41ce0fc007a12` |
| **module** | **10本**（`driving-style-v1.js` を含む） |

**掴み違いが番号で分かる形にした。**

| 症状 | 意味 |
|---|---|
| 9本しか並ばない | Build 287 以前 |
| 8本しか並ばない | Build 286 以前 |
| `driving-style-v1.js` が `false` | package には入っているが評価に失敗 |

### 更新バナーの判定も実データで裏を取った

公開 latest の最新 versioned asset は **`20260826-1250`**、Build 288 は `20260827-1302`。
`remoteN > localN` は false なので **バナーが出ないのが正しい**。出たら不合格。

### 今回の新機能を触る場合の予行（Gate 8 の下見）

- 「走りを分析して」→ 助言が**1件だけ**、参照が無ければ**数字を含まない**
- 燃料質問で、完走に給油が必要でも**まだ入れる時は「今周ピット」と言わない**
- 確認が複数保留の時に「はい」だけ返すと**どれへの返事か聞き返す**

### 変更ファイル

| ファイル | 内容 |
|---|---|
| `review/BUILD288_GATE6_WINDOWS_HANDOFF.md` | **新規** |
| `review/BUILD286_GATE6_WINDOWS_HANDOFF.md` | supersede 注記 |

### Gate は変わらない

**Gate 6・8・9 は未実施。Gate 7 は N/A（server 差分ゼロを実測）。**
本追記は**手順であって結果ではない。**

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-27 | `20d22f1` | Build 288 Gate 5 独立確認 | 確認者署名 |
| 08-27 | 本節 | Gate 6 handoff を Build 288 用へ差し替え | module 10本の期待値・掴み違いの判別・更新バナー判定 |

## 2026-08-28 JST — Claude Code独立レビュー指示（実走会話/STT揺れ・Truth Gate修正）

### 役割と対象

Claude Codeは**独立レビュー担当**。Codex実装commit `ac518e6`（parent `58b272c`）を、自己申告やテスト名を鵜呑みにせず差分と実コードから反証すること。今回のレビューではファイルを修正せず、結果を本MD末尾へ追記する。修正が必要ならP0/P1/P2、対象ファイル・行、再現入力、期待結果を明記し、Codexが修正後に再確認する。

実走証拠:

- `/Users/yuji.s/Downloads/OMORAY-bridge-debug-20260827-2028.log`
- 20:59:02 `ルナ データいってる？` → LLMはライブ値で正答したが`TELEMETRY_TRUTH_GATE`が遮断 → `了解。`
- 20:59:19 `ベストラップ いくつ？` → LLMは`7:50.356`と正答したが同gateが遮断 → `了解。`
- 21:01:17 `ベストラップ わかります。` → 同じ正答を遮断 → `了解。`
- 21:01:32 `コースデータは空いてる？` → `入ってる`のSTT揺れと推定。ただし推定を権威値へ使ってはならない。
- 22:18:04 `のな セクター どっか 遅れてる？` → 崩れがあっても回答は成立。全STT揺れを一律失敗扱いしない。

### 必須反証項目

1. `desktop/local-intent-router.js`のbest lap回答が`live.best`以外の会話値・履歴値を使わず、欠損時に捏造しないこと。`470.356`が日本語で`7分50秒356`へ正しく丸められること。
2. `ベストラップ いくつ？`、質問符号が落ちた`ベストラップ わかります。`がLLMへ落ちず、Bridge権威から同じ回答へ到達すること。
3. `ルナ データいってる？`、`コースデータは空いてる？`だけを狭くdata-statusへ寄せ、`コースは空いてる？`、`このデータを解析して`、`than。`、通常のsetup相談を誤ルーティングしないこと。
4. local routerは`selMode==='race' && iracingLive && lastTelemetry`の既存ライブ境界を緩めず、セッション権威が無い時にコース名・車両名を作らないこと。
5. local routeを外した変異でも`telemetryTruthFallback()`がbest/dataを最新`live`から再構成し、未知の数値質問を無関係な`了解。`へ落とさないこと。一方、通常の目標・フィーリング・単なる了承を過剰に拒否しないこと。
6. `server.js`の追加STTヒントが日本語のみへ限定され、危険な一般語boostやintent確定をしていないこと。モデル変更・追加retry・追加API呼出が無いこと。
7. `parseGoogleSttResponse()`が複数segmentを順序どおり結合し、confidence欠損/nullを0へ偽装せず、最弱値を診断用に返すこと。confidenceを発話可否・戦略権威へ使用していないこと。
8. `PTT_STT_RESULT`が文字数・confidence・録音秒数・言語だけで、発話全文・生音声・個人別の癖を新規永続保存していないこと。既存のローカル`CONVO [USER]`ログとの境界も明記すること。
9. best/dataのlocal化でAnthropic呼出は減るが、Google STT回数・秒数とTTS経路は増えないこと。通常テストがAnthropic/Google STT/TTSの実APIを呼ばないこと。
10. 実走5入力をfixtureとして再生し、意図した3経路（local成功／LLM継続／unknown非推測）を確認すること。テストの文字列存在検査だけで合格せず、本番関数の実行結果を含めること。
11. `server.js`変更を含むため、旧Build 288のGate 7 N/Aを流用できないこと。次candidateはBuild 289採番とGate 7が必要で、Build 288 artifactに本修正が入っていないこと。
12. unrelated untracked filesを触らず、push / build / deploy / publish / 外部有料API呼出を行わないこと。

### 実行する最低限の確認

```bash
git diff 58b272c..ac518e6 -- desktop/local-intent-router.js desktop/renderer.html server.js tests-local-intent-router.js tests-telemetry-truth-gate.js tests-ptt-capture.js HANDOFF.md
node tests-local-intent-router.js
node tests-telemetry-truth-gate.js
node tests-ptt-capture.js
node tests-gap-answer-queue.js
node --check server.js
git diff 58b272c..ac518e6 --check
```

必要なら外部APIゼロの追加fixture/変異試験を行う。Windows、実Google STT品質、実iRacing、音声の自然さを自動テスト済みと主張しない。

### 報告形式

- `P0 / P1 / P2`の指摘一覧（無ければ各0件）
- 実走入力ごとの`STT text → intent → authority → output`表
- privacy / cost / Gate 7 / Build番号の判定
- 実行したテストと件数
- 最終判定を **合格 / 条件付き合格 / 差戻し** のいずれかで明記
- 本MDへ結果を追記してcommitし、commit SHAを報告する

**このレビュー合格だけではBuild 289 GO、Windows合格、実走合格、公開GOにはならない。**

## 2026-08-28 JST — Claude Code 独立レビュー結果（実走会話/STT揺れ・Truth Gate修正）**条件付き合格**

次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`

対象: Codex 実装 commit `ac518e6`（parent `58b272c`）。**ファイルは1つも修正していない。**

### 最終判定

**条件付き合格。** P0 0件 / P1 0件 / **P2 2件**。
差戻しではないが、下記2件は Build 289 採番前に判断がいる。

---

### P2-1 — STT ヒントに2文字語 `トー` `車高` が入っている（項目6）

`server.js` の日本語 `racingPhrases` へ15語追加された。うち **`トー`** は2文字で、
「とー」「塔」「等」など無関係な音へ**認識を偏らせうる**。`車高` も2文字。

**ヒントは intent を確定させないため実害は限定的**（誤認識しても router の狭い正規表現が受けない）。
ただし PITWALL は STT の揺れで既に実走障害を出しており、**認識そのものを歪める入力は増やす前に見合うか判断すべき**。

- 対象: `server.js` の `racingPhrases`（日本語分岐）
- 再現: 「とーぜん」等を含む発話での認識揺れ
- 期待: `トー` は `トー角` など3文字以上へ。`車高` は据え置き可（レース語として一意）

### P2-2 — `BUILD_VERSION` が **288 のまま**（項目11に関連）

`ac518e6` の `BUILD_VERSION` は `Build 288 (fuel timing authority and confirmed driving-style coaching v1)`。
**公開前の Build 288 artifact（`2ba8ce4`）と中身が違う。**
このままビルドすると **Build 282 型の事故**（同番号・中身違い）。

- 期待: **289 へ採番**（`server.js` を含むため Gate 7 も必須）

---

### 必須反証12項目の結果

| # | 項目 | 判定 |
|---|---|---|
| 1 | best lap が `live.best` のみ・欠損時に捏造しない・`470.356`→`7分50秒356` | ✅ |
| 2 | `ベストラップ いくつ？`／`わかります。` が LLM へ落ちず同回答 | ✅ |
| 3 | data-status が狭い（誤ルーティングなし） | ✅ |
| 4 | ライブ境界を緩めず、権威なしでコース名・車両名を作らない | ✅ |
| 5 | local route 変異でも fallback が再構成、過剰拒否なし | ✅ |
| 6 | STT ヒントが日本語限定・モデル/retry/API追加なし | ⚠ **P2-1** |
| 7 | `parseGoogleSttResponse` の結合・confidence 契約 | ✅ |
| 8 | `PTT_STT_RESULT` が全文・生音声・癖を保存しない | ✅ |
| 9 | Anthropic 減・Google STT/TTS 増なし | ✅ |
| 10 | 実走5入力の3経路 | ✅ |
| 11 | Gate 7 流用不可・Build 289 採番必要 | ⚠ **P2-2**（採番されていない） |
| 12 | 無関係ファイル不触・push/build/deploy/公開なし | ✅ |

#### 実測の要点

**項目1**（`formatLapTime` を直接実行）
`470.356`→`7分50秒356` / 英語 `7:50.356` / `60`→`1分0秒000` / `90.05`→`1分30秒050`（ミリ秒ゼロ埋め）。
`0`・負値・`null`・非数は**空文字**。`session_best`/`last_lap`/`bestLap` を混ぜても
**`live.best` の値しか出ない**。best 欠損時は数字を1つも含まない。

**項目3**（誤ルーティング）
寄る: `ルナ データいってる？` `コースデータは空いてる？` `データ入ってる？` `データ来てる？`
寄らない: **`コースは空いてる？`** `このデータを解析して` `than。` `アンダーが出る` `次のピットどうする？` `タイヤ持たない`

**項目4**（権威なしで名前を作らない）
権威なし → `テレメトリは来ている。セッション詳細は確認中。`（コース名・車両名を出さない）
**空の権威オブジェクト `{}` でも「確認済み」にしない**。

**項目5**（`telemetryTruthFallback` を vm で実行）
local route を通さずとも best/data を `live` から再構成。
未知の数値質問（`セクター2どうなってる？` `タイヤ内圧いくつ？` `平均速度は？`）は**「了解。」へ落ちない**。
`完走したい` `アンダーが出る` `了解` は**拒否文にならない**。

**項目7**（`parseGoogleSttResponse` を実行）8/8
複数 segment を順序どおり結合／**最弱 confidence を返す**／
**欠損・null を 0 へ偽装しない（null のまま）**／`confidence:0` は 0 として欠損と区別／
`results` 欠損でも壊れない。**confidence は診断ログ以外で使われていない**
（`sttConfidence` の参照箇所は log 生成の2行のみ。発話可否・戦略権威に未使用）。

**項目8**（privacy）
`PTT_STT_RESULT` の記録キーは **`chars` / `confidence` / `duration_s` / `language` の4つのみ**。
発話全文・生音声(base64)・個人別の癖は**含まれない**。
※初回検査で私の正規表現が `text.length` と `audioDurationSeconds` に誤反応し「含む」と出たが、
キーの実体を見て**誤りと判明**した。訂正して記録する。

**項目9**（cost）
差分に追加された課金API呼出は **0件**。モデル変更・retry 追加・新規 fetch なし。
best_lap / telemetry_status が local 化され **Anthropic 呼出は減る**。Google STT/TTS の経路は不変。

**項目10**（実走5入力の再生・本番関数の実行結果）

| 時刻 | STT text | intent | authority | output |
|---|---|---|---|---|
| 20:59:02 | ルナ データいってる？ | `telemetry_status` | sessionAuthority | データは来ている。コースと車両も確認済み。 |
| 20:59:19 | ベストラップ いくつ？ | `best_lap` | `live.best` | ベスト7分50秒356。 |
| 21:01:17 | ベストラップ わかります。 | `best_lap` | `live.best` | ベスト7分50秒356。 |
| 21:01:32 | コースデータは空いてる？ | `telemetry_status` | sessionAuthority | データは来ている。コースと車両も確認済み。 |
| 22:18:04 | のな セクター どっか 遅れてる？ | **(LLM継続)** | — | LLM→Truth Gate |

**意図した3経路（local成功／LLM継続／unknown非推測）が成立している。**
崩れた STT を一律失敗扱いにしていない。

### privacy / cost / Gate 7 / Build番号の判定

| 項目 | 判定 |
|---|---|
| privacy | **合格**。新規の永続保存なし。診断ログは文字数・confidence・秒数・言語のみ |
| cost | **合格**。課金API呼出の追加0件。Anthropic は減る方向 |
| **Gate 7** | **必須**。`server.js` に +19/-5 の変更があり、**Build 288 の N/A は流用できない** |
| **Build番号** | **未採番（P2-2）**。`BUILD_VERSION` は 288 のまま。**289 が必要** |

### 実行したテストと件数

| テスト | 件数 | exit |
|---|---|---|
| `tests-local-intent-router.js` | 46/46 | 0 |
| `tests-telemetry-truth-gate.js` | 60/60 | 0 |
| `tests-ptt-capture.js` | 14/14 | 0 |
| `tests-gap-answer-queue.js` | 49/49 | 0 |
| `node --check server.js` | — | 0 |
| `git diff 58b272c..ac518e6 --check` | — | 0 |
| Claude 独自反証（項目1〜4） | **25/25** | — |
| Claude 独自反証（項目7） | **8/8** | — |
| Claude 独自反証（項目5） | **10/10** | — |

**テストの文字列存在検査だけで合格にしていない。** 本番関数（`formatLapTime` /
`route` / `telemetryTruthFallback` / `parseGoogleSttResponse`）を実行した結果で判定した。
外部有料API呼出 **0件**。

### 未実施（自動テスト済みと主張しない）

**Windows 実機・実 Google STT 品質・実 iRacing・音声の自然さは未確認。**
`トー` のヒント追加が実際の認識に与える影響も、**実 STT でしか分からない**。

### 次の担当と手順

| # | 項目 | 担当 |
|---|---|---|
| 1 | P2-1 の判断（`トー` を残すか3文字以上へ） | Codex／Yuji |
| 2 | **Build 289 採番** | Codex |
| 3 | commit → build → Gate 5 | Codex（build は Yuji の GO 後） |
| 4 | **Gate 7 必須**（server 変更あり）→ `./verify-deploy.sh` | Yuji の deploy GO |
| 5 | Gate 6 Windows / Gate 8 実走 / Gate 9 公開 | Yuji |

**このレビュー合格だけでは Build 289 GO、Windows 合格、実走合格、公開GO にならない。**

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-27 | `52e784f` | Gate 6 handoff を Build 288 用へ差し替え | module 10本の期待値 |
| 08-28 | 本節 | 実走会話/STT揺れ・Truth Gate修正の独立レビュー | 条件付き合格・P2 2件・実走5入力の再生 |

## 2026-08-28 JST — Codex対応（Claude P2 2件）／Claude再確認指示

Claude独立レビューcommit `fe897fa`のP2 2件へ対応した。

### 修正

1. **P2-1**: `server.js`の日本語STTヒント`トー`を、短い一般音へ偏らせにくい`トー角`へ変更。`車高`はClaude判定どおり据え置き。
2. **P2-2**: `irsdk-bridge/bridge.py`の正本を`Build 289 (voice question resilience and STT diagnostics)`へ採番。Build 288 artifactと現在ソースを同番号にしない。
3. `tests-ptt-capture.js`へ、`トー角`が存在し単独`トー`が無いこと、およびBuild 289でBuild 288正本が残らないことの回帰を追加。
4. `HANDOFF.md`をBuild 289候補へ更新。Build / push / deploy / publishは行っていない。

### Claude Code再確認指示

前回の全項目を重複レビューせず、次の2点を実コードとテストで再確認すること。

- `server.js`の日本語`racingPhrases`に単独`'トー'`が残らず、`'トー角'`へ置換されている。英語分岐、モデル、retry、API呼出回数に別変更がない。
- `BUILD_VERSION`の製品番号が289で、Build 288 artifactと番号衝突しない。GitHub workflowがこの正本から`desktop/build-info.json.buildNum=289`を生成する既存契約も壊れていない。

最低限、`node tests-ptt-capture.js`、`node --check server.js`、`python3 -m py_compile irsdk-bridge/bridge.py`、`git diff --check`を実行する。P0/P1/P2件数と**合格／差戻し**を本MD末尾へ追記してcommitすること。ファイル修正、push、build、deploy、publish、外部有料API呼出は行わない。

## 2026-08-28 JST — Claude Code 再確認結果（P2 2件の対応）**合格**

次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`

対象: Codex commit `1ce9092`。指示どおり**前回の全項目は重複レビューせず、指定の2点に絞った**。
**ファイルは1つも修正していない。**

### 判定

**合格。P0 0件 / P1 0件 / P2 0件。**

---

### ① `トー` → `トー角`（P2-1 解消）

日本語 `racingPhrases` を列挙して確認した。

```
日本語ヒント語数 : 61
単独 'トー' が残る : false
'トー角' がある    : true
2文字以下の語     : 燃料, 内圧, 順位, 車高
```

残る2文字語（`燃料` `内圧` `順位` `車高`）はいずれも**レース語として一意**で、
`トー` のような一般音との衝突がない。**P2-1 は解消。**

#### 別変更が混ざっていないか

`ac518e6..1ce9092` の `server.js` 差分は **1行のみ**。

```
-         'アンチロールバー', 'キャンバー', 'トー', 'リアウイング', 'ブレーキバランス',
+         'アンチロールバー', 'キャンバー', 'トー角', 'リアウイング', 'ブレーキバランス',
```

**英語分岐・モデル・retry・API呼出回数に変更なし**（差分がこの1行だけである事実で確認）。

---

### ② Build 289 採番（P2-2 解消）

```
BUILD_VERSION = "Build 289 (voice question resilience and STT diagnostics)"
bridge.py に残る "Build 288" : 0 件
```

| | |
|---|---|
| Build 288 artifact の出所SHA | `2ba8ce4`（BUILD_VERSION=288） |
| 現在ソース | `1ce9092`（BUILD_VERSION=289） |
| 同番号・中身違いの衝突 | **解消** |

#### workflow の既存契約が壊れていないか（実際に当てて確認）

`.github/workflows/build-desktop.yml:57` の抽出パターンを、**実物の `BUILD_VERSION` 文字列へ当てた**。

```
パターン : BUILD_VERSION\s*=\s*"Build\s+(\d+)
マッチ   : 成功
productBuild : 289
→ desktop/build-info.json.buildNum : 289
→ artifact 名 : ...Build-289-...
```

**契約は壊れていない。** workflow は `throw 'BUILD_VERSION product number not found'` を持つので、
正本が読めなければ build 自体が止まる形も維持されている。

---

### 回帰テストが落ちるべき時に落ちるか（変異試験）

`tests-ptt-capture.js` の新規2項目を変異で検査した。

| 変異 | 結果 |
|---|---|
| Z1 単独 `トー` へ戻す | ✅ 検出 |
| Z2 `Build 288` へ戻す（番号衝突） | ✅ 検出 |
| Z3 `トー角` ごと削除する | ✅ 検出 |

**3件すべて検出。** 文字列の存在だけでなく、**非存在（`'トー',` が無いこと）**も見ているため、
戻す変異が素通りしない。

---

### 実行したテストと件数

| 検査 | 件数 | exit |
|---|---|---|
| `node tests-ptt-capture.js` | **15/15** | 0 |
| `node --check server.js` | — | 0 |
| `python3 -m py_compile irsdk-bridge/bridge.py` | — | 0 |
| `git diff --check` | — | 0 |
| JS 全スイープ | 失敗0 | — |
| Python discover | 308 tests | 0 |
| `./preflight.sh` | 出荷可 | 0 |
| Claude 変異試験 | **3/3 検出** | — |

外部有料API呼出 **0件**。**ファイル修正・push・build・deploy・公開は行っていない。**

---

### Gate の状態（変わっていない）

| Gate | 状態 |
|---|---|
| 0〜4 | **合格**（P0/P1/P2 すべて 0件） |
| 5 artifact | **未実施**（Build 289 は未ビルド） |
| 6 Windows | **未実施** |
| 7 server | **必須・未実施**（`server.js` 変更あり。Build 288 の N/A は流用不可） |
| 8 iRacing 実走 | **未実施** |
| 9 公開 | **未実施** |

### 次の担当と手順

| # | 項目 | 担当 |
|---|---|---|
| 1 | commit → build（Build 289 private candidate） | Codex（**Yuji の build GO 後**） |
| 2 | Gate 5 独立確認 | Claude（`./verify-artifact.sh <run> <sha> 289`） |
| 3 | **Gate 7**（server 変更あり）→ `./verify-deploy.sh` | **Yuji の deploy GO** |
| 4 | Gate 6 Windows | Yuji（handoff は 289 用に差し替えが要る） |
| 5 | Gate 8 実走 / Gate 9 公開 | Yuji |

**この再確認合格だけでは Build 289 GO、Windows 合格、実走合格、公開GO にならない。**
**Gate 5・6・7・8・9 はいずれも未実施である。**

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-28 | `fe897fa` | 実走会話/STT揺れ・Truth Gate修正の独立レビュー | 条件付き合格・P2 2件 |
| 08-28 | 本節 | P2 2件の対応の再確認 | 合格・変異3件検出・workflow契約の実測 |

## 2026-08-28 JST — Build 289 private artifact / Codex Gate 5実測・Claude独立確認指示

Yujiから`Build 289 GO`あり。Codexは対象SHA `5f9ef109fd10430bcee0764dd68633fb9e343c6c`をprivate branch `build/289`へpushし、push eventのDesktop workflowだけを実行した。公開・server deployは行っていない。

### Workflow

| 項目 | 値 |
|---|---|
| run | `33130906223` |
| URL | `https://github.com/eebei/english-voice-app/actions/runs/33130906223` |
| head SHA | `5f9ef109fd10430bcee0764dd68633fb9e343c6c` |
| conclusion | `success` |
| Publish to Release | `skipped` |
| artifact | `OMORAY-PITWALL-Desktop-Build-289-20260828-0049` |
| artifact bytes | `302,051,442` |

### Codex独立実測（Gate 5作業者側）

`./verify-artifact.sh 33130906223 5f9ef109fd10430bcee0764dd68633fb9e343c6c 289 --keep --dir /tmp/pw-build289-codex`を実行。CI manifestの転載ではなく、artifactを全量取得しinstallerを展開して再計算した。

| 対象 | bytes | SHA-256 |
|---|---:|---|
| installer 3本（同一） | `100,680,483` | `03a5f08158819cbbb69594d031f9b6bfa81a6b6603bfeb5c235ad6939a525c7a` |
| `app.asar` | `4,287,837` | `207a3fc96664bc3b3d0f2a2192810e638ae6e49ba6f08d69ccdbf2f7ee0e0b46` |
| 同梱Bridge | `17,025,547` | `ce6791affef8af92e37174dbd660effa0ad383f4c5c5dd00b8222a1893407a4b` |

- runtime moduleはartifact側rendererから派生して10/10、欠落なし。
- rendererと10 moduleは対象SHAとCRLF正規化後一致。
- `build-info.json.buildNum=289`。
- Bridge圧縮内部に`Build 289`と`active_decision_id`が実在し、同じ箇所に旧`Build 288`なし。pygame 52件。
- Codex側Gate 5検査は合格。ただし作業者自身の検査なので、Claude署名前はGate 5最終合格にしない。

### Claude Code独立確認指示

Codexの`/tmp/pw-build289-codex`、上記ハッシュ、CI manifestを証拠として流用せず、別ディレクトリで次を実行する。

```bash
./verify-artifact.sh 33130906223 5f9ef109fd10430bcee0764dd68633fb9e343c6c 289 --keep --dir /tmp/pw-build289-claude
```

run SHA、Publish skipped、artifact名/bytes、installer 3本同一、installer/app.asar/Bridgeのbytes・SHA、artifact renderer由来runtime module、対象SHAとの中身一致、build-info 289、Bridge内Build 289・旧288なし、pygameを独立再計算する。Codex値と一致したかを項目別に明記し、Gate 5確認者署名を本MD末尾へ追記してcommitする。

ファイル修正、push、再build、deploy、publish、外部有料API呼出は禁止。Gate 6 Windows、Gate 7 server、Gate 8 iRacing実走、Gate 9公開は未実施のままと明記する。

## 2026-08-28 JST — Claude Code 作業終了報告（Build 289 Gate 5 独立確認・**確認者署名**）

次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`

必須MD報告。**Codex の `/tmp/pw-build289-codex`・記載ハッシュ・CI manifest を証拠として流用せず、
別ディレクトリ `/tmp/pw-build289-claude` で全量取得・展開して再計算した。**

### 1. 作業日時と担当

2026-08-28 JST。**確認担当 Claude Code**（実装・build は Codex）。

### 2. 対象

| 項目 | 値 |
|---|---|
| 対象SHA | `5f9ef109fd10430bcee0764dd68633fb9e343c6c` |
| ブランチ | `build/289`（`origin/main` は動かしていない） |
| Build番号 | **289**（`BUILD_VERSION = "Build 289 (voice question resilience and STT diagnostics)"`） |
| workflow run | `33130906223`（push event / private） |

### 3. 変更ファイル

**Claude は1ファイルも変更していない**（確認のみ）。

### 4. 実行したテスト（件数・終了コード）

**対象SHA を隔離 worktree へ出して実行**（本作業ツリーに触っていない）。

| 項目 | 件数 | exit |
|---|---|---|
| JS 全スイープ（対象SHA） | **失敗0** | — |
| `tests-ptt-capture.js` | 15/15 | 0 |
| `tests-local-intent-router.js` | 46/46 | 0 |
| `tests-runtime-module-status.js` | 12/12 | 0 |
| Python discover | **308 tests** | 0 |
| `./preflight.sh`（対象SHA） | **出荷可** | 0 |

外部有料API呼出 **0件**。

### 5. artifact（すべて Claude が自分で再計算）／**Codex 値との項目別照合**

| 対象 | Claude 実測 | Codex 申告 | 一致 |
|---|---|---|---|
| run headSha | `5f9ef109fd10430bcee0764dd68633fb9e343c6c` | 同 | ✅ |
| run conclusion | `success` | 同 | ✅ |
| Publish to Release | **skipped** | 同 | ✅ |
| artifact 名 | `OMORAY-PITWALL-Desktop-Build-289-20260828-0049` | 同 | ✅ |
| artifact bytes | **302,051,442** | 302,051,442 | ✅ |
| installer 3本同一 | **同一ハッシュ（1種類）** | 同 | ✅ |
| installer bytes | **100,680,483** | 100,680,483 | ✅ |
| installer SHA-256 | `03a5f08158819cbbb69594d031f9b6bfa81a6b6603bfeb5c235ad6939a525c7a` | 同 | ✅ |
| app.asar bytes | **4,287,837** | 4,287,837 | ✅ |
| app.asar SHA-256 | `207a3fc96664bc3b3d0f2a2192810e638ae6e49ba6f08d69ccdbf2f7ee0e0b46` | 同 | ✅ |
| Bridge bytes | **17,025,547** | 17,025,547 | ✅ |
| Bridge SHA-256 | `ce6791affef8af92e37174dbd660effa0ad383f4c5c5dd00b8222a1893407a4b` | 同 | ✅ |
| runtime module（artifact 側 renderer から派生） | **10/10・欠落0** | 10/10 | ✅ |
| 対象SHA との中身一致（CRLF正規化後） | **一致** | 同 | ✅ |
| `build-info.json.buildNum` | **289** | 289 | ✅ |
| Bridge 内 `Build 289` | **実在** | 同 | ✅ |
| Bridge 内 旧 `Build 288` | **同じ箇所に無し** | 同 | ✅ |
| `active_decision_id` | **実在** | 同 | ✅ |
| pygame | **52件**（Electron同梱用の正しい系統） | 52件 | ✅ |

**全17項目一致。不合格 0 件。**

#### artifact とは別に、対象SHA 側でも確認した

| 確認 | 結果 |
|---|---|
| `BUILD_VERSION` | Build 289 |
| `bridge.py` の残留 `Build 288` | **0件** |
| `server.js` の `'トー角'` / 単独 `'トー'` | **1件 / 0件**（P2-1 の修正が対象SHAに入っている） |
| renderer が要求する module | **10本** |

### 6. Gate 0〜9

| Gate | 状態 |
|---|---|
| 0 変更範囲 | **合格** |
| 1 失敗の固定 | **合格** |
| 2 package 対象 | **合格**（renderer 参照10本すべて実物に同梱） |
| 3 機械検証 | **合格**（対象SHA で preflight 出荷可・失敗0） |
| 4 P0/P1 | **合格**（P0/P1/P2 すべて0件・`3648a76` で再確認済み） |
| **5 artifact** | **合格 — 確認者署名: Claude Code**（実装・build は Codex＝作業者と確認者が別） |
| 6 Windows | **未実施** |
| **7 server** | **必須・未実施**（`server.js` に +19/-5。Build 288 の N/A は流用不可） |
| 8 iRacing 実走 | **未実施** |
| 9 公開 | **未実施**（Build 289 は private） |

### 7. push / deploy / 公開 / Windows / 実走の有無

| 操作 | 実施 |
|---|---|
| commit | **本報告のMD追記のみ** |
| push / private build | **なし**（Codex が実施済み） |
| server deploy / 公開 Release | **なし** |
| Windows 実機確認 / iRacing 実走 | **なし** |

### 8. 未完了項目と次の担当・手順

| # | 項目 | 担当 | 手順 |
|---|---|---|---|
| 1 | **Gate 6 handoff を 289 用へ差し替え** | Claude | `BUILD288_GATE6_WINDOWS_HANDOFF.md` は Build 288 向け（SHA・run が違う）。module は 10本で同数だが**installer の SHA が違う**ため、そのまま渡すと照合が通らない |
| 2 | **Gate 6 Windows** | **Yuji** | Build 289 installer（SHA `03a5f081…`）を起動し、`RUNTIME_MODULE_STATUS` **10本**・`missing:[]`・`status:"loaded"` を ACK |
| 3 | **Gate 7 server** | **Yuji の deploy GO** | `origin/main` への push が必要 → `./verify-deploy.sh`（SHA一致だけでは合格にしない） |
| 4 | Gate 8 実走 | Yuji | 8/29 耐久。指示書の確認項目9点 |
| 5 | Gate 9 公開 | Yuji の別GO | Gate 6/7/8 の後 |

### 9. 到達段階（混同しない）

| 段階 | 状態 |
|---|---|
| 実装済み | ✅（Codex） |
| 内部テスト済み | ✅（対象SHA で全緑・exit 0） |
| **artifact 確認済み** | ✅ **Codex 作成／Claude 独立再計算で全17項目一致。確認者署名あり** |
| Windows 確認済み | ❌ **未実施** |
| 実走済み | ❌ **未実施** |
| 公開済み | ❌ **未実施**（公開中は Build 287） |

**Gate 6・7・8・9 はいずれも未実施である。**
本報告は「artifact が対象SHAの中身を含む」までであり、**実走で動く証拠でも出荷可でもない。**

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-28 | `3648a76` | P2 2件の対応の再確認 | 合格 |
| 08-28 | 本節 | Build 289 Gate 5 独立確認 | 確認者署名・Codex 値と全17項目一致・Gate 7 必須 |

## 2026-08-28 Claude Code — Gate 6 handoff を Build 289 用へ差し替え

前節 §8 の未完了項目の解消。

`BUILD288_GATE6_WINDOWS_HANDOFF.md` は Build 288 向けで、**installer SHA と run が違う**。
**module は同じ10本なので数では区別できず**、288 の SHA で照合すると必ず不一致になる。
`BUILD289_GATE6_WINDOWS_HANDOFF.md` を新設し、288 側には supersede 注記を入れた。

### Build 289 用の期待値（実物 artifact から取った）

| 項目 | 値 |
|---|---|
| installer | `OMORAY-PITWALL-Setup-20260828-0049.exe` / 100,680,483 bytes |
| SHA-256 | `03A5F08158819CBBB69594D031F9B6BFA81A6B6603BFEB5C235AD6939A525C7A` |
| 対象SHA | `5f9ef109fd10430bcee0764dd68633fb9e343c6c` |
| run | `33130906223` |
| module | **10本**（288 と同数） |

**288 との見分け方を明記した。** module 数が同じなので、`RUNTIME_MODULE_STATUS` だけでは
288 を掴んでいても合格に見える。**タイトルバー／Bridge ログの Build 番号で見る**。

### 更新バナーの判定を実データで裏取り

```
公開 latest の最新 versioned asset : 20260826-1250  → remoteN = 202608261250
Build 289                          : 20260828-0049  → localN  = 202608280049
remoteN > localN は false → バナーは出ないのが正しい
```

### Build 289 の新機能を触る場合の予行（Gate 8 の下見）

実走ログ由来の修正なので、**PTT で声に出して**確認するのが要点。

| 言うこと | 期待 |
|---|---|
| 「ベストラップ いくつ？」 | `ベスト7分50秒356。`（`了解。`にならない） |
| 「ルナ データいってる？」「コースデータは空いてる？」 | `データは来ている。…` |
| 「コースは空いてる？」 | **data-status に寄らない** |
| `PTT_STT_RESULT` | `chars`/`confidence`/`duration_s`/`language` のみ。**発話全文・音声は出ない** |

### ★Gate 7 が必須である旨を handoff にも明記した

Build 289 は `server.js` に +19/-5 を含むため、**Build 288 の「Gate 7 N/A」は流用できない**。
deploy 後の `./verify-deploy.sh` は必須で、**SHA 一致だけでは合格にしない**。

### 変更ファイル

| ファイル | 内容 |
|---|---|
| `review/BUILD289_GATE6_WINDOWS_HANDOFF.md` | **新規** |
| `review/BUILD288_GATE6_WINDOWS_HANDOFF.md` | supersede 注記 |

### Gate は変わらない

**Gate 6・7・8・9 は未実施。** 本追記は**手順であって結果ではない。**

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-28 | `0d39f73` | Build 289 Gate 5 独立確認 | 確認者署名・全17項目一致 |
| 08-28 | 本節 | Gate 6 handoff を Build 289 用へ差し替え | 288 との見分け方・更新バナー判定・Gate 7 必須の明記 |

## 2026-08-28 JST — Build 289 Gate 7 server deploy（Codex）

Yujiの明示的なDeploy GO後、`main`をpushし、Railway本番を機械検証した。
Desktop / Bridgeの公開Release操作は行っていない。

| 項目 | 実測結果 |
|---|---|
| deploy対象SHA | `a587940edd52af69cd09abbc75bafe909042b14f` |
| 本番 `/api/version` SHA | `a587940edd52af69cd09abbc75bafe909042b14f` — 一致 |
| 本番起動時刻 | `2026-08-28T01:51:27.799Z` |
| 保護経路 | `/api/memory/decisions` → **401**（未認証拒否＝経路・認証とも正常） |
| 検証 | `./verify-deploy.sh a587940edd52af69cd09abbc75bafe909042b14f` → exit 0 |
| 公開 | **未実施**（公開中はBuild 287） |

起動直後の初回probeではSHA一致後に503（DB初期化中）を観測したが、再確認で401へ復帰した。
SHA一致だけで合格にせず、経路復帰まで確認したため **Gate 7合格**。

残りは **Gate 6 Windows、Gate 8 iRacing実走、Gate 9公開**。

## 2026-08-28 JST — Build 289 public release（Codex）

Yujiの明示的な公開GO後、DesktopとBridge単体版を同じremote `main` SHAから公開した。
Windows実機・iRacing実走は未確認のままなので、その未確認事項は公開後も残す。

| 項目 | 実測結果 |
|---|---|
| 対象SHA | `a587940edd52af69cd09abbc75bafe909042b14f` |
| Desktop workflow | `33134346423` — success / Publish to Release success |
| Bridge workflow | `33134348071` — success / Publish to Release success |
| Desktop Release名 | `OMORAY PITWALL Desktop — Build 289` |
| 公開日付版 | `OMORAY-PITWALL-Setup-20260828-0156.exe` |
| 公開latest | `OMORAY-PITWALL-Setup-latest.exe` |
| 公開installer bytes | **100,681,743** |
| 公開installer SHA-256 | `b45a85411fab8801d430badcf048736b6f88cf1cc6d44bbf0487055e453137f5` |
| 3資産照合 | 日付版／latest／旧互換版が同一bytes・digest |
| workflow manifest | product_build 289 / runtime module 10本 / target SHA一致 |
| Bridge単体 | `OMORAY-PITWALL-Bridge-20260828.exe` — 10,392,797 bytes / SHA-256 `17beead3c12963df6cad47110eca01cb7d074229ef1dd25ff8aad338a1a11bcf` |
| 公開後server | SHA一致、保護経路401、`verify-deploy.sh` exit 0 |

公開latestを `/tmp/pw-public289.nRnG4D` へ全量取得し、ローカルSHA-256とGitHub Release digestの一致を確認した。
**公開版はBuild 289へ切替済み。残る未確認はGate 6 WindowsとGate 8 iRacing実走。**

## 2026-08-28 JST — Claude Code 作業終了報告（Build 289 公開後の独立確認）**P1 1件**

次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`

必須MD報告。Codex の Gate 7 / Gate 9 報告を受け、**申告値を転載せず独立に再計算した。**

### 1. 作業日時と担当

2026-08-28 JST。**確認担当 Claude Code**（deploy・公開は Codex）。

### 2. 対象

| 項目 | 値 |
|---|---|
| Gate 5 で署名した SHA | `5f9ef109fd10430bcee0764dd68633fb9e343c6c` |
| deploy / 公開した SHA | `a587940edd52af69cd09abbc75bafe909042b14f` |
| **現在の HEAD** | **`d377de0`（公開SHA より1コミット先行）** |
| Build番号 | 289（HEAD も公開も同じ） |

### 3. 変更ファイル

**Claude は1ファイルも変更していない**（確認のみ）。

### 4. 実行したテスト（件数・終了コード）

| 項目 | 結果 | exit |
|---|---|---|
| JS 全スイープ（現HEAD） | **失敗0** | — |
| Python discover | 308 tests | 0 |
| `./preflight.sh` | 出荷可 | 0 |
| Claude 独自反証（Spielberg 正規化） | 5/5 | — |

外部有料API呼出 **0件**。

### 5. 独立に再計算した値／Codex 申告との照合

#### ① Gate 5 署名SHA と 公開SHA の差

```
git diff 5f9ef10..a587940 -- desktop/ irsdk-bridge/
→ 差分ゼロ
```

変わったのは `HANDOFF.md` と `review/*.md` の**4ファイルのみ**。`BUILD_VERSION` も同一。
**私が Gate 5 で署名した中身が、そのまま公開されている。**

#### ② 公開 installer（Codex の値を見ずに全量取得して計算）

| 項目 | Claude 実測 | Codex 申告 | 一致 |
|---|---|---|---|
| Release 名 | `OMORAY PITWALL Desktop — Build 289` | 同 | ✅ |
| 公開 installer bytes | **100,681,743** | 100,681,743 | ✅ |
| 公開 installer SHA-256 | `b45a85411fab8801d430badcf048736b6f88cf1cc6d44bbf0487055e453137f5` | 同 | ✅ |
| 3資産（日付版／latest／旧互換）の同一性 | **3本とも 100,681,743 bytes** | 同 | ✅ |

**Gate 9（公開）の実物は Codex 申告と一致。**

---

## ★P1 — 公開後の未公開コミットが **Build 289 のまま**

現在の HEAD `d377de0`（`Fix RBR memory stats and debrief routing`）は
**公開SHA `a587940` の後ろに積まれており、出荷経路を変更している。**

```
desktop/local-intent-router.js  +33
desktop/memory-action-layer.js  +7
desktop/renderer.html           +56 -?
desktop/session-memory.js       +11
irsdk-bridge/bridge.py          +15
```

にもかかわらず `BUILD_VERSION` は **`Build 289 (voice question resilience and STT diagnostics)`** のまま。

**公開中の Build 289 と、この HEAD の Build 289 は中身が違う。**
このままビルドすると **Build 282 で証拠を無効化した事故と同じ形**になる。
また、テスターが「Build 289」と報告してきても、**どちらの 289 か区別できない。**

- 対象: `irsdk-bridge/bridge.py:58`
- 期待: **290 へ採番**（`desktop/**` と `irsdk-bridge/**` を触っている以上、番号据え置きは不可）
- 担当: **Codex**

※ `irsdk-bridge/bridge.py` は変わっているが `server.js` は無変更のため、
次候補の **Gate 7 は N/A になる見込み**（採番後に差分で再確認する）。

---

### 確認できた点（`d377de0` の中身）

Spielberg / Red Bull Ring の表記ゆれを吸収する `normTrack()` が入っている。
**実挙動で確認した。**

| 検証 | 結果 |
|---|---|
| `Red Bull Ring` / `Red Bull Ring GP` / `Spielberg` / `Spielberg GP` の全組合せで記録が引ける | ✅ |
| 無関係なコース（Monza）は混ざらない | ✅ |
| Okayama など従来のコースも従来どおり | ✅ |
| 空トラックでは引かない（identity 欠損で流用しない） | ✅ |
| 記号・大小の表記ゆれを吸収（`RED-BULL_RING` ↔ `red bull ring`） | ✅ |

**別コースの記録を引き込む緩和にはなっていない。** 対象は閉じた別名集合のみ。

### 6. Gate 0〜9

**公開済み Build 289（`a587940`）について:**

| Gate | 状態 |
|---|---|
| 0〜4 | **合格** |
| 5 artifact | **合格**（Claude 確認者署名済み。公開物も本日ハッシュ照合） |
| 6 Windows | **未実施** |
| 7 server | **合格**（Codex 実測。SHA 一致＋保護経路 401＋`verify-deploy.sh` exit 0） |
| 8 iRacing 実走 | **未実施** |
| 9 公開 | **実施済み**（実物ハッシュを独立確認） |

**現在の HEAD（`d377de0`）について:**

| Gate | 状態 |
|---|---|
| 3 機械検証 | **合格**（全緑・preflight 出荷可） |
| 4 P0/P1 | **不合格 — P1 1件**（Build番号未採番） |
| 5〜9 | **未実施**（未ビルド） |

### 7. push / deploy / 公開 / Windows / 実走の有無

| 操作 | 実施 |
|---|---|
| commit | **本報告のMD追記のみ** |
| push / build / deploy / 公開 | **なし**（Codex が実施済み） |
| Windows 実機確認 / iRacing 実走 | **なし** |

### 8. 未完了項目と次の担当・手順

| # | 項目 | 担当 |
|---|---|---|
| 1 | **Build 290 採番**（P1） | **Codex** |
| 2 | **Gate 6 Windows** | **Yuji** — 公開中の Build 289 で実施可。手順は `BUILD289_GATE6_WINDOWS_HANDOFF.md`（§1 の SHA は private artifact のもの。**公開版を使うなら `b45a8541…`**） |
| 3 | Gate 8 実走 | **Yuji** — 8/29 耐久。指示書の確認項目9点 |
| 4 | 次候補の Gate 5〜9 | 採番後 |

### 9. 到達段階（混同しない）

| 段階 | 公開済み Build 289 | 現HEAD `d377de0` |
|---|---|---|
| 実装済み | ✅ | ✅ |
| 内部テスト済み | ✅ | ✅ |
| artifact 確認済み | ✅ 署名あり | ❌ 未ビルド |
| server 反映済み | ✅ Gate 7 合格 | — |
| **Windows 確認済み** | ❌ **未実施** | ❌ |
| **実走済み** | ❌ **未実施** | ❌ |
| 公開済み | ✅ | ❌ |

**公開中の Build 289 は、Windows 実機起動も iRacing 実走も未確認のまま配布されている。**
**Gate 6 と Gate 8 はいずれも未実施である。**

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-28 | `15d1082` | Gate 6 handoff を Build 289 用へ差し替え | 288 との見分け方 |
| 08-28 | 本節 | Build 289 公開後の独立確認 | 公開物ハッシュ一致・P1（番号未採番）・Spielberg 正規化の実挙動確認 |

## 2026-08-28 JST — Codex差戻し対応（Build 290採番・Claude再確認依頼）

次のMDに指示書あり

- Claude指摘P1を受理。`irsdk-bridge/bridge.py`の正本を`Build 290 (RBR memory, personal stats, and debrief routing)`へ更新し、版番号回帰も公開289の残存を拒否するよう変更した。
- 採番後に`tests-ptt-capture.js` 15/15、Bridge compile、版番号全文検索、`git diff --check`、sandbox外`./preflight.sh`を実行し、全項目合格・`✅ 出荷可`。外部有料AI API呼出0件。
- Build／push／deploy／公開は未実施。`server.js`差分なしのためGate 7はN/A見込みだが、候補SHA確定後に公開289との差分で再判定する。
- **Claude再確認対象**: (1)本人`userId`不一致・identity欠損・件数不足で個人成績が漏洩／推測されない、(2)leader lapが残り周回とleader GAPより先に正しい対象へ配線される、(3)Lunaへの抗議は保存されず通常の走行回答は保存できる、(4)incident／pit／paceの事実から質問が一問だけ生成される、(5)製品番号がBuild 290で一意。各項目を実コードで反証し、P0/P1/P2件数と実行結果を本MD末尾へ追記すること。

## 2026-08-28 JST — Claude Code 再確認（Build 290・5項目）**4項目完了／1項目未完・次チャットへ引き継ぎ**

次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`

**コンテキスト上限のため中断。** 完了分と残りを明記する。**ファイルは1つも修正していない。**

### 対象

| 項目 | 値 |
|---|---|
| 対象 | 未コミット無し・HEAD `b2d93cc`（`Bump RBR memory candidate to Build 290`） |
| Build番号 | **290**（`Build 290 (RBR memory, personal stats, and debrief routing)`） |
| 公開中 | Build 289（`a587940`） |

### 判定（現時点）：**P0 0件 / P1 0件 / P2 0件。ただし (4) は未検証。**

| # | 再確認項目 | 結果 |
|---|---|---|
| (1) | 個人成績が漏洩／推測されない | ✅ **6/6** |
| (2) | leader lap の配線 | ✅ **5/5** |
| (3) | Lunaへの抗議は保存せず通常回答は保存 | ✅ **13/13** |
| (4) | incident/pit/pace から質問が一問だけ | ⏸ **未検証（次チャットへ）** |
| (5) | 製品番号 Build 290 で一意 | ✅ |

### (1) 個人成績（実挙動・6/6）

```
本人5件そろう          → 直近5レースは合計6、平均1.2インシデント。
userId 欠損            → 本人の成績記録を確認できない。ログイン状態を確認して。
★他人の記録しかない    → 本人記録は0レース分。（他人を本人成績にしない）
★本人3件＋他人2件      → 本人記録は3レース分。（他人を数に入れない）
本人3件（要求5件）      → 件数不足として推測しない
raceHistory 未指定      → 壊れない
```

**他人の記録が本人成績として出る経路は無い。**

### (2) leader lap（実挙動・5/5）

```
「トップは何周？」      → leader_lap        クラス首位は12周目。
「総合トップは何周目？」  → leader_lap        総合首位は14周目。
★「残り何周？」         → laps_remaining    残り5周。（leader_lap に食われない）
leader.lap 欠損         → 取得できない（数字を作らない）
「今の順位は？」        → current_position  現在P3。（live.class_pos フォールバックが効く）
```

### (3) 抗議 vs 走行回答（実挙動・13/13）

保存しない: `ルナ、それ違うだろ` / `前にも走ってる` / `初めてじゃない` / `君は覚えてないのか` /
`さっきの回答おかしい` / `記憶が通じてない` / `回答持っていない`
保存する: `ブレーキが奥まで残せなかった` / `タイヤが最後たれた` / `2コーナーでアンダーが出た` /
`燃料を気にして抑えた` / `スタートで出遅れた` / `リアが落ち着かなかった`

**Build 289 の「前にも走った」が走行記憶へ入る欠陥は塞がっている。過剰拒否もしていない。**

### (5) Build 290 採番

```
BUILD_VERSION = "Build 290 (RBR memory, personal stats, and debrief routing)"
bridge.py の残留 Build 289 : 0件 ／ リポジトリのコード内 Build 289 正本 : 0件
workflow 抽出 → productBuild 290 → artifact 名 Build-290-
回帰テスト（tests-ptt-capture.js:55-56）が公開289の残存を拒否する
```

**私が P1 として挙げた番号衝突は解消。**

---

### ★次チャットへの引き継ぎ

#### 未完了 (4)：incident/pit/pace から質問が一問だけ生成されるか

**検証できていない。製品の問題ではなく、私の検証 harness の依存不足で止まった。**

```
buildEvidenceQuestions() を vm で実行 → ReferenceError: EVIDENCE_COPY is not defined
```

`buildEvidenceQuestions` は `evidenceCopy()` を呼び、それが `EVIDENCE_COPY`（トップレベル const）
を参照する。関数だけ抽出する方式では届かない。

**次チャットでの進め方（推奨）**

`EVIDENCE_COPY` の定義を含めて抽出するか、`renderer.html` の該当 script を
より広い範囲で vm へ流す。確認する性質は次の3つ。

1. incident があれば incident の質問が **1問だけ**
2. pit / pace も同様に各1問
3. **事実が無ければその質問を作らない**（推測で質問を生成しない）

#### 追いかけ済み・再調査不要

「トップとのギャップは？」が `leader_gap` でなく `nearest_gap_unavailable` になる。
**公開中 Build 289 と現HEADで挙動が同じ**ことを実測で確認済み（`d377de0` の回帰ではない）。
`トップとの差は？` `トップまで何秒？` `クラス首位とのギャップ` は正しく `leader_gap`。
**既存の語彙の穴であり、今回の差戻し対象ではない。** 再調査しないこと。

### Gate 0〜9

| Gate | 状態 |
|---|---|
| 0〜3 | **合格** |
| 4 P0/P1 | **保留 — (4) 未検証のため署名しない** |
| 5〜9 | **未実施**（Build 290 は未ビルド） |

公開中の **Build 289 は Gate 6（Windows）と Gate 8（実走）が未実施のまま配布されている。**

### push / deploy / 公開 / Windows / 実走

すべて **なし**。commit は本報告のMD追記のみ。

### 次の担当

| # | 項目 | 担当 |
|---|---|---|
| 1 | **(4) の検証を完了** | **Claude（次チャット）** |
| 2 | Gate 6 Windows | Yuji（公開中 289 で実施可） |
| 3 | Gate 8 実走 | Yuji（8/29 耐久） |
| 4 | Build 290 の build 以降 | Yuji の GO 後 |

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-28 | `739959f` | Build 289 公開後の独立確認 | 公開物ハッシュ一致・P1（番号未採番） |
| 08-28 | 本節 | Build 290 5項目の再確認 | (1)(2)(3)(5) 合格・**(4) 未検証で次チャットへ** |

## 2026-08-28 JST — Claude Code 再確認 (4) 完了（Build 290・5項目すべて決着）

次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`

前チャットで harness の依存不足により未検証だった **(4) incident/pit/pace から質問が一問だけ生成されるか** を完了した。
**ファイルは1つも修正していない。** 検証専用スクリプトのみ（リポジトリ外・scratchpad）。

### 対象

| 項目 | 値 |
|---|---|
| 対象 | HEAD `cc89d1d`（`Record four of five re-checks, and hand off the fifth`）・追跡ファイルの未コミット差分なし |
| Build番号 | **290**（`Build 290 (RBR memory, personal stats, and debrief routing)`） |
| 公開中 | Build 289（`a587940`） |
| 検証対象コード | `desktop/renderer.html:5090` `buildEvidenceQuestions()` |

### 前チャットの停止原因（解消）

`buildEvidenceQuestions` だけを vm へ渡すと `EVIDENCE_COPY is not defined` で止まっていた。
`EVIDENCE_COPY` / `evidenceCopy` / `validFinishPosition` / `pickRotatingQuestion` /
`loadDebriefFollowupHistory` / `rememberDebriefFollowup` / `buildMemoryAwareDebriefFollowup`
を **renderer.html の実コードから波括弧対応で切り出して** 同一 vm コンテキストへ流し、
`localStorage` と `window.PitwallMemoryActionLayer` のみ stub 化した。
**質問生成ロジック自体は製品コードそのものを実行している。**

### 判定：**P0 0件 / P1 0件 / P2 0件。20/20 合格。**

#### 性質1 — 事実があれば各1問だけ（実挙動）

```
incident 2件のみ        → ["今回はインシデント2。…接触そのもの、避けた後のペース、それとも戦略変更のどれだった？"]
incident + pit          → 1問に統合（"インシデント2、その後9周目にピットへ入っている。…"）
incident + pit + pace   → やはり1問（多重発火なし）
pit のみ (lap 12)       → ["12周目のピットは、予定どおり、前倒し、それとも事故対応のどれだった？"]
pit 2件 (12/24)         → 12周目のみで1問（24 は混ざらない）
pace 劣化 1.5秒         → ["後半は前半より平均1.5秒落ちている。…"]
EN 言語                 → ["There were 2 incidents and a stop on lap 9. …"]
```

**戻り値は全ケースで length 1。incident > pit > pace の early-return で排他になっている。**

#### 性質2 — 事実が無ければその質問を作らない（推測で生成しない）

```
incidents = 0           → incident 質問を作らない（結果別プールへ）
incidents 欠損 / NaN     → 同上
pit_events = []          → pit 質問を作らない
entry_lap = 'x'（不正）  → pit 質問を作らない（周回数を捏造しない）
pit_events が配列でない  → 落ちずに結果別プールへ
pace 片方欠損            → pace 質問を作らない
pace 差 0.2秒（閾値未満） → pace 質問を作らない
data 空 {}               → 例外を出さず1問
```

**数字が無い時に数字入りの質問を組み立てる経路は無い。**

#### 性質3 — practice / qualifying の分離

```
practice + incidents 3  → 定型 practice 質問（race 用 incident 質問は出ない）
```

### 記録のみ（欠陥ではない・修正不要）

`incidents` と `pit_events` の分岐は `!practice && !qualify` で守られているが、
**`pace_first_half` / `pace_last_half` の分岐だけ session type ガードが無い**（`renderer.html:5109`）。
そのため practice でも「後半は前半より平均2.0秒落ちている」が出る。
実測に基づく事実であり、練習走行の振り返りとしても成立するため **P2 に上げない。**
仕様として意図したものか、次に触る担当が判断すればよい。

### (1)〜(5) 総括

| # | 再確認項目 | 結果 |
|---|---|---|
| (1) | 個人成績が漏洩／推測されない | ✅ 6/6（前チャット） |
| (2) | leader lap の配線 | ✅ 5/5（前チャット） |
| (3) | Lunaへの抗議は保存せず通常回答は保存 | ✅ 13/13（前チャット） |
| (4) | incident/pit/pace から質問が一問だけ | ✅ **20/20（本節）** |
| (5) | 製品番号 Build 290 で一意 | ✅（前チャット） |

**Codex 差戻し5項目はすべて合格。P0 0件 / P1 0件 / P2 0件。**

### Gate 0〜9

| Gate | 状態 |
|---|---|
| 0〜3 | **合格** |
| 4 P0/P1 | **合格 — 5項目完了により署名可（Claude Code）** |
| 5〜9 | **未実施**（Build 290 は未ビルド） |

公開中の **Build 289 は Gate 6（Windows）と Gate 8（実走）が未実施のまま配布されている。**
本節は **8/29 耐久に向けた実走証拠ではない。未実走を合格扱いしていない。**

### push / deploy / 公開 / Windows / 実走

| 操作 | 実施 |
|---|---|
| commit | **本報告のMD追記のみ** |
| push / build / deploy / 公開 | **なし** |
| Windows 実機確認 / iRacing 実走 | **なし** |
| 外部有料 API 呼出 | **0件** |

### 次の担当

| # | 項目 | 担当 |
|---|---|---|
| 1 | Build 290 の build 以降（Gate 5〜9） | **Yuji の GO 後** |
| 2 | Gate 6 Windows | Yuji（公開中 289 で実施可） |
| 3 | Gate 8 実走 | Yuji（8/29 耐久・指示書の確認項目9点） |
| 4 | 燃料判断の権威一本化／運転スタイル分析V1 | **Build 289に収録済み**。燃料guardは8/28実走でhold作動、運転スタイルV1はcapture不成立で実走未確認 |

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-28 | `cc89d1d` | Build 290 5項目の再確認 | (1)(2)(3)(5) 合格・(4) 未検証 |
| 08-28 | 本節 | (4) の完了 | 20/20 合格・5項目すべて決着・pace ガード非対称を記録のみ |

## 2026-08-28 JST — Codex最終確認（Build 290 Gate 4合格）

- Claudeの5項目再確認を受領。P0/P1/P2 0件、Gate 4合格をCodex側でも承認する。
- `b2d93cc`以降の追跡コード差分はゼロ（`cc89d1d`と本節はいずれもMDのみ）。Codex再実行はLocal Intent Router 53/53、Evidence Debrief 47/47、PTT 15/15、Bridge compile、`git diff --check`が全合格。
- Claude報告末尾の「燃料判断／運転スタイルV1 未着手」は旧指示書由来の誤記として上表で訂正。両機能は公開Build 289に収録済み。ただし運転スタイルV1の実データcaptureと助言有用性は未実走のまま。
- Build 290は実装・内部テスト・独立確認まで完了。Gate 5 artifact以降は未実施で、YujiのBuild GO待ち。push／build／deploy／公開は行っていない。

## 2026-08-28 JST — Build 290 private artifact・Codex Gate 5実測／Claude独立確認依頼

次のMDに指示書あり

YujiのBuild 290 GOを受け、対象SHA `a9988ec790f0b3ca569d5f7a067e81ef3e0e9b02`を`build/290`へpushした。Desktop workflow `33142893350`はsuccess、Publish to Releaseはskipped。server差分なし、公開・deployは行っていない。

Codexはartifact `OMORAY-PITWALL-Desktop-Build-290-20260828-0449`（302,061,490 bytes）を全量取得し、zip integrityと`./verify-artifact.sh 33142893350 a9988ec790f0b3ca569d5f7a067e81ef3e0e9b02 290`を完走した。実測値は次のとおり。

| 対象 | bytes | SHA-256 |
|---|---:|---|
| installer 3本（同一） | 100,684,282 | `3427273eafca6eccbca325384c91be7d6175dc56de2db8066fd403f765d28ce5` |
| `app.asar` | 4,292,914 | `96d3e1058daaffeb469d647c8159e9f805557f9892d56f4bbf0c779f36fb3c5d` |
| 同梱Bridge | 17,027,639 | `cc102c33e3a2b80d76e41c2cd0be3c3abafe588bf17d16af1cadbfbdd23b4616` |

renderer由来runtime moduleは10/10、app.asar内容は対象SHAとCRLF正規化後一致、`build-info.json buildNum=290`、Bridge内にBuild 290と`active_decision_id`が実在し同じstreamに旧Build 289なし、pygame 52件。CI manifestの3値とも一致した。

**Claude Code確認指示**: Codexの一時ディレクトリや上記申告値を証拠として流用せず、別作業ディレクトリへrun `33142893350`のartifactを独立取得すること。run SHA／Publish skipped／artifact名とbytes／installer 3本同一／installer・app.asar・BridgeのbytesとSHA／artifact側rendererから派生したruntime全件／対象SHAとの中身一致／build-info 290／Bridge内Build 290・旧289なし／pygameを再計算し、各項目が一致したかを列挙する。P0/P1/P2件数とGate 5確認者署名を本MD末尾へ追記する。Windows・iRacing・公開を実施済みと扱わない。

## 2026-08-28 JST — Build番号の通史（採番の正本と2つの時代）

次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`

「今まで何番から何回更新したか」を git 実測で確定した。**コード変更は一切していない。**

### 4つの時代

| 時代 | 期間 | 番号 | 正本 | 更新回数 |
|---|---|---|---|---|
| ① 日付連番 | 2026-06-17 〜 07-04 | `2026-06-19-001` 〜 `2026-07-04-039` | `irsdk-bridge/bridge.py` に手書き | **39** |
| ② 中間 | 07-07 / 07-30 | `2026-07-07-B` / `2026-07-30-TEST` | 同（番号なしの日付タグ） | **2** |
| ③ CI連番 | 07月中 〜 07-30 | **040 〜 237（概算）** | GitHub Actions `github.run_number` | **git に記録なし** |
| ④ 製品連番 | 07-30 〜 08-28 | **Build 238 〜 290** | `irsdk-bridge/bridge.py:58` | **53** |

### 数え方で答えが変わる（混同しない）

| 指標 | 値 |
|---|---|
| git で実証できる `BUILD_VERSION` の更新 | **55回**（② 2 + ④ 53） |
| ① も含めた手書き採番の更新 | **94回** |
| ユーザーに見えた「Build N」の通し番号 | **001 → 290** |

**94回と290は数えている対象が違う。** 外部（テスター・Discord・LP）へ数字を出す時に混ぜない。
③は run 番号なので、**ソースを変えずに再ビルドしただけの回も含まれる＝更新回数ではない。**

### ③の正体

`build-desktop.yml` は当時 `Build ${{ github.run_number }}` をそのまま表示していた。
記憶にある Build 166 / 168 / 170 / 175 / 216 はこの時代のもの。
07-30 に **「buildNumはGitHub run番号ではなく、bridgeと同じ製品Build番号を使う」** へ切り替え、
その時点の run 番号 238 を引き継いで ④ が始まっている。
現在は `build-desktop.yml:57` / `build-store-msix.yml:42` が
`BUILD_VERSION\s*=\s*"Build\s+(\d+)` を抽出し、**bridge.py が唯一の正本**になっている。

### 採番規律の実測

```
④ の 238〜290 = 53個ちょうど。飛びゼロ・重複ゼロ・再利用ゼロ。
```

今回 Claude が P1 として挙げた「289 据え置きのまま出荷経路を変更」も Codex が 290 へ採番して解消済み。
**Build 282 の証拠無効化事故以降、採番規律は破られていない。**

### 更新の密度

2026-06-17 〜 08-28 の **73日間で手書き94回＝1日あたり約1.3回**。
ただし均等ではなく、**実走ログやテスター報告が返ってきた日に集中**している
（6/18 だけで 002→012 の11回、7/4 も 030→039 の10回）。

### push / deploy / 公開 / Windows / 実走

すべて **なし**。commit は本報告のMD追記のみ。外部有料 API 呼出 **0件**。

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-28 | 本節 | Build番号の通史 | 4時代・手書き94回／通し番号290・③はrun番号でgit外・④は飛びゼロ |

## 2026-08-28 JST — Codex確認：Gate 5独立検査は未実施、指示先を修正

直前のClaude追記はBuild番号の通史であり、run `33142893350`のartifact取得・展開・hash再計算を行っていない。したがってBuild 290 Gate 5はまだ確認者未署名。

`review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`先頭を現在状態へ更新し、案件1／案件2の再実装や番号通史ではなく、Build 290 Gate 5独立artifact検査だけを最優先指示に固定した。次回Claudeは同指示の7項目を完了し、P0/P1/P2と署名を本MD末尾へ記録すること。Windows／iRacing／公開は行わない。

## 2026-08-28 JST — Gate 5 独立 artifact 確認（Build 290 private candidate）**合格・確認者署名**

次のMDに指示書あり: `review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`

指示書冒頭の最優先指示に従い、Gate 5 の確認のみを実施した。**コードは1行も変更していない。**
**Codex の一時ファイル・展開物・申告 hash は一切流用していない。** リポジトリ外の新規作業ディレクトリへ
artifact を独立取得し、全数値を自分で計算してから一致／不一致を記録している。
（作業ディレクトリ: session scratchpad 配下。リポジトリ内の `desktop/dist/` `artifacts/` には触れていない）

### 0. 対象

| 項目 | 値 | 独立確認 |
|---|---|---|
| run | `33142893350` | ✅ `conclusion=success` |
| workflow | Build OMORAY PITWALL Desktop (Windows EXE) | ✅ |
| head SHA | `a9988ec790f0b3ca569d5f7a067e81ef3e0e9b02` | ✅ run の headSha と一致 |
| commit | `Close Build 290 independent review`（2026-08-28 13:47:16 +0900） | ✅ |
| 製品Build | **290** | ✅ |

`a9988ec` → 現HEAD の差分は **`HANDOFF.md` と本MDのみ**。**出荷経路（`desktop/**` `irsdk-bridge/**`）に差分なし。**

### 1. Publish to Release が skipped であること

```
Upload private build artifact   success
Publish to Release              skipped   ←
```

**private candidate として正しい。** 加えて公開側も実測した。

| 公開 release `desktop-latest` の latest 3本 | 100,681,743 bytes（2026-08-28T01:57:59Z） |
|---|---|
| 今回の Build 290 installer | **100,684,282 bytes** |

**bytes が異なる＝ Build 290 は公開経路へ出ていない。公開中は Build 289 のまま。**

### 2. artifact（独立取得）

| 項目 | 独立計算値 |
|---|---|
| artifact 名 | `OMORAY-PITWALL-Desktop-Build-290-20260828-0449` |
| artifact zip bytes | **302,061,490** |
| artifact zip SHA-256 | `1606c78970b6477d04b309b4055894348bba45395d301c6d1e5661e825e416e2` |
| 収録 | installer 3本 + `BUILD-290-GATE5-MANIFEST.json` の4件のみ |

### 3. installer 3本の同一性（独立計算）

```
100684282  3427273eafca6eccbca325384c91be7d6175dc56de2db8066fd403f765d28ce5  OMORAY-PITWALL-Setup-20260828-0449.exe
100684282  3427273eafca6eccbca325384c91be7d6175dc56de2db8066fd403f765d28ce5  OMORAY-PITWALL-Setup-latest.exe
100684282  3427273eafca6eccbca325384c91be7d6175dc56de2db8066fd403f765d28ce5  OMORAY-PITWALL-Desktop-latest.exe
```

**3本とも bytes・SHA-256 完全一致。日付版／latest／旧互換の取り違えは起こらない。**

### 4. installer 内部（NSIS → app-64.7z を展開して独立計算）

| 対象 | bytes（独立） | SHA-256（独立） | CI manifest 申告との照合 |
|---|---|---|---|
| installer | 100,684,282 | `3427273eafca…d28ce5` | **一致** |
| `app.asar` | 4,292,914 | `96d3e1058daa…fb3c5d` | **一致** |
| 同梱 Bridge | 17,027,639 | `cc102c33e3a2…3b4616` | **一致** |

manifest の値は**照合相手として後から突き合わせただけ**で、上記は先に自分で計算した値である。

### 5. runtime module（artifact 側 renderer から派生 → 欠落0 → 対象SHAと内容一致）

`app.asar` を展開し、**artifact 内の `renderer.html` の `<script src>` から**一覧を派生させた
（CI の申告リストではなく artifact 実物から派生している）。

```
派生モジュール数 = 10   欠落 = 0   内容不一致 = 0
```

| module | SHA-256（改行正規化後・artifact = 対象SHA） |
|---|---|
| cost-meter.js | `458f41ff0eba1f1b63861de98e33ea00c07789ea38fa54daaf2917f81afc5bee` |
| decision-memory.js | `78e26182ad68d33f6d5b3b99d5194e701066d4515b0a88581a4cdf96063f58b5` |
| driving-style-v1.js | `78bec6e37e8c28fc8efd59230aa6f6ce2431655dd571d84fb493f886a97726be` |
| fuel-plan-guard.js | `06b57f4db99215f1ddfb978a1cd554af11840f57ce4d8e2975e58177d3a10a7e` |
| gap-freshness.js | `2267aa2efeec77441d50a5dabeb62a3352a56b71e5bdb363ff7a5a9cba178175` |
| local-intent-router.js | `f2a82f91a6ad6a06c9dd59e6da3dbdd5765c2335193e7e755c76b0b386328e11` |
| luna-self-memory.js | `457eb4d800cc79b3638cc60baf5e11fd559eff8338881599bc99517d03e642f3` |
| memory-action-layer.js | `79ae10127001f2dae8144b6c8cad1e18c38fcc7ae0a296456a979389955f3b4f` |
| session-memory.js | `b683ed6846f44722e67ebd4b84375437a8827eb119a5d0937e77db6cdf156b2b` |
| strategy-playbook.js | `9f7b203b37e2dd5f662b066c757d38b767dbb56e7da9eda35cca0c75c79434de` |

本体も同様に一致した。

```
renderer.html  806646a334f7f4d99a556cbf36a96a7acc3e091db592d9d8ba4a0d4b0f1c51ec
main.js        b12172a66f8f7231e53d09751b5f8818d7d266245aa2d6300c2715bb2b65c927
preload.js     08d7e4f98f0e22805be953a516043a841ba20a032d1b3f6f836360dcffadd5bb
overlay.html   b60b7d1e33df15ae4f9daabdfc34154034631b89fbd705376eaeb8256871bed3
```

**artifact 内のコードは対象SHAそのもの。ビルド時の差し替えは無い。**

※ 素の bytes は git blob と異なる（例 `cost-meter.js` 9,912 → 10,141）。
**Windows runner の checkout による CRLF 変換であり、内容差ではない。** 上表は CR 除去後の照合。

### 6. build-info / Bridge 内部

```
build-info.json : {"buildDate":"2026-08-28T04:49:45.1298365+00:00","buildTag":"20260828-0449","buildNum":290}
```

| 確認 | 結果 |
|---|---|
| `buildNum` = **290** | ✅ |
| `buildTag` = artifact 名の `20260828-0449` と一致 | ✅ |
| 同梱 Bridge 内の Build 文字列 | **`Build 290 (RBR memory, personal stats, and debrief routing)` のみ** |
| 旧 **Build 289 の残存** | **0件** |
| `active_decision_id` | ✅ 存在 |
| pygame 同梱 | ✅ `pygame` 本体 + SDL2 / SDL2_mixer / SDL2_ttf / SDL2_image DLL を同梱 |

Bridge は PyInstaller onefile（Python 3.12）のため、`strings` では中身が見えない。
**PyInstaller CArchive を展開して `bridge.pyc` を取り出し、その中で確認した。**

さらに同梱 Bridge が対象SHAの `bridge.py` 由来であることを文字列定数で裏取りした。

```
対象SHA bridge.py の文字列リテラル(16字以上・単一行) 459件
  → 同梱 bridge.pyc 内に存在 433件
  → 不在 26件はすべて %書式文字列。CPython 3.12 が %-formatting を分割定数へ最適化するため。
     分割後の断片は 26/26 すべて存在を確認。
実質 459/459 説明済み。未説明の欠落・混入なし。
```

### 7. 判定：**P0 0件 / P1 0件 / P2 0件**

記録のみ（欠陥ではない）:

- `app.asar` 内の `package.json` は対象SHAの `desktop/package.json` と異なる（`scripts` / `devDependencies` / `build` が無い）。
  **electron-builder が production 用に書き直す標準動作。** 実行に使う `main` / `name` / `version` は一致。

### 8. Gate 5 確認者署名

> **Gate 5（独立 artifact 確認）合格。**
> run `33142893350` / SHA `a9988ec790f0b3ca569d5f7a067e81ef3e0e9b02` / 製品Build 290 について、
> artifact を独立取得し、installer 3本の同一性、installer・`app.asar`・同梱 Bridge の bytes と SHA-256、
> runtime module 10件の欠落0と対象SHAとの内容一致、`buildNum=290`、Bridge 内 Build 290・旧289なし・
> `active_decision_id`・pygame 同梱を、**すべて自分で計算した値で**確認した。
> Publish to Release は skipped であり、公開経路は Build 289 のままである。
> **確認者: Claude Code（2026-08-28 JST）**

### 9. Gate 0〜9（Build 290 private candidate）

| Gate | 状態 |
|---|---|
| 0〜3 | **合格** |
| 4 P0/P1 | **合格**（5項目の再確認完了済み） |
| 5 artifact | **合格 — 本節で確認者署名** |
| 6 Windows | **未実施** |
| 7 server | **N/A 見込み**（`server.js` 差分なし。公開時に再判定） |
| 8 iRacing 実走 | **未実施** |
| 9 公開 | **未実施**（Publish to Release skipped を実測） |

**Build 290 は Windows 実機起動も iRacing 実走も未確認である。未実走を合格扱いしていない。**

### 10. push / deploy / 公開 / Windows / 実走

| 操作 | 実施 |
|---|---|
| commit | **本報告のMD追記のみ** |
| push / build / deploy / 公開 | **なし** |
| Windows 実機確認 / iRacing 実走 | **なし** |
| 外部有料 API 呼出 | **0件** |
| 環境変更 | **`brew install sevenzip` のみ**（installer 展開に必要。ローカル CLI。リポジトリ無変更） |

### 11. 次の担当

| # | 項目 | 担当 |
|---|---|---|
| 1 | Gate 6 Windows | **Yuji**（公開中 289 でも Build 290 でも可） |
| 2 | Gate 8 実走 | **Yuji**（8/29 耐久・指示書の確認項目9点） |
| 3 | Build 290 の公開判断（Gate 9） | **Yuji の GO 後** |

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-28 | 本節 | Gate 5 独立 artifact 確認 | 全数値を独立計算・installer3本同一・module 10件欠落0内容一致・Build 290一意・P0/P1/P2 0件・確認者署名 |

## 2026-08-28 JST — Codex Gate 5受領・Gate 6対象訂正

Claude Codeの独立artifact確認をCodex実測と照合し、全値一致・P0/P1/P2 0件としてGate 5署名を受領した。

直前報告の「Gate 6 Windowsは公開中289でもBuild 290でも可」は候補検証として不正確なため訂正する。**Gate 6の対象はrun `33142893350`から取得したBuild 290 installerだけ**とし、公開289やローカル`desktop/dist/`で代用しない。固有bytes／SHA-256と確認項目は`review/BUILD290_GATE6_WINDOWS_HANDOFF.md`を正本とする。公開中はBuild 289のまま。Gate 6／8／9は未実施で、Build 290を公開していない。

## 2026-08-28 JST — Build 290公開GO受領・必須ゲート待ち

YujiからBuild 290の公開GOを受領した。ただし`review/PITWALL_RELEASE_GATE.md`の絶対ルールに対し、Build 290 private candidate固有のGate 6 Windows実機確認とGate 8 iRacing実走スモークが未確認であるため、公開workflow・Release差し替え・Bridge公開は実行していない。公開中はBuild 289のまま。

公開承認は受領済みとして保持する。`review/BUILD290_GATE6_WINDOWS_HANDOFF.md`の同一installerでGate 6とGate 8の結果を記録し、停止条件が0件なら新たな公開GOを取り直さず、検査済みSHA `a9988ec790f0b3ca569d5f7a067e81ef3e0e9b02`をGate 9へ進める。

## 2026-08-28 JST — Build 290公開完了・公開後artifact照合

Yujiから「公開しないと実機テストできない」という恒久運用の再指摘を受け、Gate 5合格済みcandidateを公開し、その公開update経路でGate 6／8を行う順序へ正本を訂正した。

初回公開workflow `33151809626`（Desktop）／`33151816641`（Bridge）はSHA `a9988ec790f0b3ca569d5f7a067e81ef3e0e9b02`でsuccess。公開後照合により、Desktop同梱Bridgeにはpygameがある一方、Bridge単体workflowはpygameをinstall／hidden-importしておらずjoystick PTT機能が一致しないことをCodexが検出した。`.github/workflows/build-bridge.yml`をDesktop側と揃え、commit `7c1ad59facd98702bad648b378953e8c90ecd1b8`へmainと`build/290`を更新した。

最終公開workflowはDesktop `33152767207`、Bridge `33152765158`。ともにSHA `7c1ad59facd98702bad648b378953e8c90ecd1b8`、Publish stepを含めsuccess。

- Desktop Release: `OMORAY PITWALL Desktop — Build 290`
- Desktop日付版／latest／旧互換版: 各100,684,274 bytes、SHA-256 `5d6d343179bc2d4094ee09131aa0293b2860105ad71206eec64f1391211892ee`
- 公開installer実取得・展開: `buildNum=290`、runtime local script 10/10、package entries 27
- app.asar: 4,292,914 bytes、SHA-256 `431c94ffbbb1d7c7b0e5d7a22a6f395428b3d2367ecd277a0f9bbad201b8fcaf`
- Desktop同梱Bridge: 17,027,723 bytes、SHA-256 `d07e8fd1986d71ca6f73ca27daf3d4f975568cd0cf28a3d981071158ff81edf3`
- Bridge単体: 17,027,111 bytes、SHA-256 `80fdb41dbc79f563ef07d3e4e5db5b7014be1e0464b75a8b17f00cf42109bdf8`
- Bridge installer: 16,321,781 bytes、SHA-256 `d0c0b22101a345a77ade4ad941a5eea6a44b5b0a7b86ee1e757985bda56f2dd8`
- Bridge単体strings: pygame module群、SDL2／image／mixer／ttf DLL群を確認
- server差分なし: Gate 7 N/A、Railway deployなし
- 未確認: 公開Build 290でのGate 6 Windows、Gate 8 iRacing実走

公開URL実取得値はGitHub Release APIのsize／digestと全件一致。Build 290を公開済みfield-test candidateとし、Windows／実走結果にGate 10停止条件があれば直ちに新規配布停止を判断する。

## 2026-08-29 JST — Team Plan縦一機能（ブリーフィング合意→実測→交代→レース後）実装完了

`review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md`の指示に対し、実装・全テスト・commitまでを行った。**Build／署名／公開／push／deployは実行していない。**公開中はBuild 290のまま。

### 変更ファイルと、各配線がどこまで実到達するか

| ファイル | 変更 | 到達点 |
|---|---|---|
| `desktop/team-plan.js`（新規） | Team Plan台帳の純関数モジュール（UMD `PitwallTeamPlan`）。state／確認判定／実測比較／packet組立／受信適用／stint要約／レース後学習 | LLMを介さない決定論。renderer・auth・テストが同じ実物を使う |
| `desktop/renderer.html` | script追加、`pw_team_plan_v1`永続化、発話入口`handleTeamPlanUtterance`（LLMより前）、`evaluateTeamPlanLiveEvidence`／`captureTeamStintLap`をtelemetry_liveへ、交代時`buildTeamHandoffSection`→publish＋同内容をradioへ、受信側`applyReceivedTeamPlan`、session_summaryで`persistTeamRaceLearning`、デブリーフ`teamStintResultAnswer` | 発話→合意→実測→交代送信→**別PCの受信・再確認発話**→レース後の確定回答まで一本 |
| `auth.js` | `cleanChiefTeamPlan`を新設し`cleanChiefPacket`へ`team_plan`を追加。exportに両関数 | 中継サーバーがTeam Planを黙って捨てない。ホワイトリスト外は破棄 |
| `tests-team-plan.js`（新規） | 112ケース。モジュール実物＋renderer本番関数をvmで実行 | — |
| `tests-chief-cross-pc.js` | packet enrich後の送信確認へ更新＋relayスキーマ6件追加 | — |
| `preflight.sh` | Team Planスイートを恒久ゲートへ追加 | — |

### Team Plan state schemaと確認条件

`{schema:'team_plan_v1', revision, confirmed, candidate, briefing{active,step,asked,awaiting_confirmation}, pending_proposal, updated_at, log[]}`。
plan body は `{revision,status,source,updated_at,fields{}}`、fieldsは`driver_order／handover_intent／initial_pit_plan／fuel_policy／three_clean_lap_rule／review_conditions`の6項目のみ。各fieldは`{value, source:'human'|'bridge_evidence'|'team_handoff', at}`を持ち、**未入力の項目はキーごと存在しない（不明は不明のまま）**。

- ブリーフィングは明示開始（「作戦会議を開始」等）でのみ進み、一度に2〜3項目だけ聞く。
- `confirmed`へ昇格するのは明示確認のみ（「確定」「はい、確定」「confirm the plan」等）。**裸の「はい」「OK」「了解」「yes」はPlanの中身にも確定にもならない**。
- 「違う」「修正」だけでは確定Planを変えず、直す項目を短く聞き返す。
- 事実質問（`？`／何周／何リットル等）はTeam Planが飲み込まず、既存のlocal router／LLMへ通す。

### handoffに追加した実データと未取得時の挙動

`packet.team_plan` = 確定Planのrevision・確定時刻・6項目本文（**candidateは`candidate_pending`フラグだけで本文は渡さない**）、`evidence`（現在燃料／clean燃費／サンプル数／平均ラップ／予測残周／予測ピット窓／完走マージン／天候／4輪計測タイヤ／損傷）、`stint_summary`（identity・best・average・clean average・clean laps・燃費・incidents＋対象範囲・pit/repair events・plan revision）。

未取得は全て`null`。走行中はタイヤを`available:false`／`corners:{}`とし計測値扱いにしない。修理要否は`repair_required:null`。インシデント観測が無いstintは`incidents:null` + `incident_scope:'unknown'`で、0と断定しない。受信側は`plan_status!=='confirmed'`、未知schema、同一以下のrevisionを適用しない。対象ドライバー照合（`next_driver_index`）とstale破棄は既存のまま前段に維持。

### 永続化先と次回参照経路

- 確定Plan: `localStorage pw_team_plan_v1`（`PERSISTENT_SETTING_KEYS`に追加＝走行中クラッシュでも失わない）。
- レース後: `localStorage pw_team_race_learning_v1`（直近20レース）。driver別best/average/clean/燃費/incidents/pit・repair、確定Planと実際の差分（`planned_first_pit_lap` vs `actual_pit_events`／`first_pit_delta_laps`）。
- 参照: デブリーフの成績質問は`teamStintResultAnswer`→`answerFromRaceLearning`が確定構造から回答。該当ドライバーの記録が無ければ「推測では答えない」と返す。既存の個人成績（session-memory／decision-memory）には触れていない。

### 実行した全テストと結果

- `node tests-team-plan.js` … 112/112 合格
- `node tests-chief-cross-pc.js` … 19/19 合格
- `./preflight.sh` … Team Plan含む全スイート合格。**唯一の不合格は`tests-memory-action-layer.js`（"proactive briefing says that stored session history was used"）で、`a47bf21`を`git stash`で確認した結果、本変更前から失敗している既存不良**。
- 個別再確認: chief-engineer-mode／engineer-card／fuel-plan-authority／fuel-timing-authority／strategy-playbook／local-intent-router／gap-answer-queue／evidence-debrief／decision-memory(server,tunnel)／runtime-module-status／speak-priority／speak-async／radio-brevity／endurance-radio／desktop-state／`tests_driver_handoff.py` … 全PASS
- 外部APIは呼んでいない。テストfixtureに本番Team Link Codeを使っていないことをテスト自身が検査する。

### commit

`3e96cf1 Carry the confirmed Team Plan from briefing to handoff and results` — 変更は上表の6ファイルのみ。無関係な未追跡物（`artifacts/`、`desktop/dist/`等）はstageしていない。

### 未解決事項

- **P1**: `tests-memory-action-layer.js`の既存失敗（本変更の範囲外・耐久前に別途要調査）。
- **P2**: 実測との突き合わせによる小変更候補は現状「ピット窓の周回差>1周」と「Planに数値が無い」の2条件のみ。天候急変・タイヤ計測を起点にした候補生成は未実装。
- **P2**: タイヤ交換判断は材料（4輪計測・次スティント長・天候・修理時間）が揃うまで`insufficient_evidence`で止まる仕様。固定しきい値は持たない＝耐久本番でも「交換すべき」と断定はしない。
- **耐久前に使えない機能**: なし（Buildしていないため、exe側へ反映するにはBuild／公開が別途必要）。renderer変更のみでサーバー側は`auth.js`のみ＝本番反映にはpush＋deployが要る。**現状は交代のTeam Plan中継はローカル実装のみで本番サーバーには未到達。**

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-29 | `3e96cf1` / `5b7dec3` | 2026-08-29 Team Plan縦一機能 | 変更6ファイルと到達点・state schemaと確認条件・handoff追加データと未取得時挙動・永続化先と参照経路・全テスト結果（team-plan 112/112、cross-PC 19/19、preflight 79件合格・既存不良1件）・commit hash・未解決P1/P2 |

## 2026-08-29 JST — preflight既存不良（Memory Action Layer）解消・全緑

前節で「本変更前からの既存不良」として残した `tests-memory-action-layer.js` の失敗を潰した。

**原因**：Build 277 でグリッド無線を一文へ短縮した（長文版がRBRで38秒の発話キューを作った件）際、`desktop/strategy-playbook.js` の日本語 briefing は `保存履歴20セッション…` から短文へ変わったが、`tests-memory-action-layer.js` だけが旧文言のまま残っていた。`tests-strategy-playbook.js` は新文言で更新済みで、**同じ関数に対して2本のテストが別の文言を要求している状態**だった。コード側の不具合ではなく、Build 277 の取りこぼし。

**対応**：
- 短い一文（＝現行の意図した挙動・耐久ディレクティブの受入条件「ブリーフィングが音声キューを詰まらせない」にも一致）を正とし、旧文言のテストを更新した。
- 併せて文言を `履歴20件あり。` → `履歴20セッション。` へ訂正。`historical_session_count`（20）と `memory_record_count`（2）は別の事実で、「件」は後者と読める。長さは変えていない（グリッド無線は一文のまま）。
- テストは文言の写経ではなく**事実と簡潔さの両方**を検査する形にした（`履歴20セッション` を含む／40字以下かつ Plan B・Plan C・周目・給油設定を含まない）。

**結果**：`./preflight.sh` は **80スイート全合格・「✅ 出荷可」**。不合格0件。
実文言：`履歴20セッション。Plan Aで開始、クリーン3周で更新。`（実測後は `実測3.70L/周でPlan Aを更新。`）

変更ファイル：`desktop/strategy-playbook.js`、`tests-memory-action-layer.js`、`tests-strategy-playbook.js`。Build・公開・push・deployは未実行。

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-29 | `cd11d64` | preflight既存不良解消 | Build 277取りこぼしの特定・短文を正とした判断・件→セッションの訂正・preflight 80件全合格 |

## 2026-08-29 JST — ディレクティブ追記「Chief Engineer Mode は必須実行面」への対応

`review/NEXT_CHAT_20260827_UPDATE_DIRECTIVE.md` に追記された受入条件（Chief Engineer Mode の設定・交代・relay・受信画面を通って初めて有効／Chief 無効の単独走行では既存挙動を壊さない）へ対応した。

**元から満たしていた点**：stint identity は Chief の `roster[current_index]`、送信は Chief の relay（`/api/chief/handoff`）、受信は対象 Driver 照合の後に Chief の share status（次 Driver の UI）＋短い再確認発話。

**追加した点**：`teamModeActive()`（`chief-mode-enabled` かつ roster 2名以上）を新設し、`handleTeamPlanUtterance` / `evaluateTeamPlanLiveEvidence` / `captureTeamStintLap` / `buildTeamHandoffSection` / `persistTeamRaceLearning` の全入口を早期 return でゲートした。**Chief が無効な単独走行では Team Plan が一切作動せず、保存領域にも触らない**（テストで実挙動を確認）。

テスト追加：`tests-team-plan.js` に ⑥-b 節（Chief 前提の配線5件＋関数ごとのゲート5件）と、単独走行での実挙動6件。合計 **127/127 合格**。`./preflight.sh` は **80スイート全合格・「✅ 出荷可」**。Build・公開・push・deploy は未実行。

### MD更新台帳への追記

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-29 | `90ada56` | Chief Engineer Mode 実行面対応 | teamModeActive ゲート・Chief 前提配線の明示検査・単独走行を壊さない実挙動テスト・team-plan 127/127・preflight全緑 |

## 2026-08-29 JST — Phase F（Trackside Strategy Intelligence V1）実装完了

Codexの Phase F 開始許可を受け、F1〜F4を実装した。**Build・署名・公開・push・deployは未実行。公開中はBuild 290のまま。** 既存 Team Plan は作り直していない。会話の自由文を新しい事実源にしていない。

### authority の入力・鮮度条件・fail-closed 時の発話

**F1 相対ペース（`desktop/relative-pace.js` 新規 / `PitwallRelativePace`）**

| 項目 | 内容 |
|---|---|
| 入力 | `competitors[]`（同クラスのみ・`car_idx` / `class_pos` / `last_lap_s`）と自車の `last`＋`lap_valid_clean` |
| 対象固定 | 現在 snapshot の `class_pos±1` から **CarIdx を確定**。名前や順位表示で後から取り違えない |
| スコープ | 近傍10台（`nearest_10`）。全同クラスへ広げられる形。`fieldCoverage` は**クラス総数が渡されない限り `complete_field:false`**（`competitors` は F2Time 有効車だけで、クラス全エントリーではない） |
| 鮮度 | 標本は5分以内、1台5周まで保持、最小2周。10分見えない車は台帳から落とす。セッションが変われば全消去 |
| 比較 | 双方の中央値。回答に「相手・前後・比較周数・時間窓・差分」を持つ。0.15秒未満は互角 |
| fail-closed | `unconfirmed` + 理由（`no_target` / `no_rival_laps` / `no_own_laps` / `stale`）。発話は「後ろの相対ペースは未確認。相手の有効ラップがまだ足りない。」相手ペースを推測で作らない |
| 禁止 | 燃料・pit を語らない。燃料/ピット語を含む質問は受け取らない（`isRelativePaceQuestion`→false）。相手のペダル・舵角は取得不能＝走り方を主張しない |

**F2 GAP訂正の保留（`desktop/gap-freshness.js` に追加）**

`disputeGap()` は方向ごとに `{generation, target_car_idx, session_key, disputed_value_s, reason:'driver_disputed'}` を保留台帳へ置く。**ドライバー発話の数値は保存しない**（自由文を実測へ昇格させない）。`gapHoldStatus()` は generation か対象CarIdxが変わった時＝再観測でのみ解除する（時間経過では解けない）。保留中の発話は「後ろの車間は未確認。前の値は保留にした。次の観測で言い直す。」で、誤った旧値を繰り返さない。`local-intent-router` は `gapHeld` を受け、保留方向だけ `nearest_gap_held` を返し、もう一方は従来どおり答える。

**F3 単一 authority snapshot（`desktop/team-plan.js` に `strategyAuthoritySnapshot`）**

一つの `live` と確定Planから `snapshot_id`（session:lap:fuel:clean_laps）を作り、`compareLiveEvidence` と `buildHandoffTeamSection` の両方がその id と判定を名乗る。判定は `on_plan` / `minor_change_candidate` / `insufficient_evidence`（3クリーン周未満）/ `pit_now`。**`pit_now` は Bridge の `pit_timing_authority` の判定を映すだけで、Team Plan 側では決して生成しない**（`pit_required`＋`add_fuel_l` があっても `pit_now` にしない）。小変更は人の明示確認まで候補のままで、交代先へは confirmed revision だけが渡り、候補の存在は `candidate_pending` という事実として載る。

**F4 Chief 導線**：交代 packet は snapshot から作る。Chief 無効の単独走行は Team Plan 側の `teamModeActive()` ゲートで不作動のまま（`tests-team-plan.js` ⑥-b）。相対ペースは Chief に依存せずレースモード時のみ作動。タイヤ・天候・損傷の断定禁止と70%固定ルール禁止は既存のまま維持。

### 変更ファイル

`desktop/relative-pace.js`（新規）、`desktop/gap-freshness.js`、`desktop/local-intent-router.js`、`desktop/team-plan.js`、`desktop/renderer.html`、`tests-phase-f-trackside.js`（新規）、`preflight.sh`。

### 実行した全テスト

- `node tests-phase-f-trackside.js` … **64/64 合格**（F1固定再生：前後・欠損・古いデータ・別CarIdx・同クラス外／F1-b：燃料shortfall下でも相対ペース質問がpit nowにならない／F2：対象取り違え・世代・訂正・再観測・router保留／F3：4判定とsnapshot id一致・候補の非漏洩／F4：renderer本番関数をvmで実走）
- `./preflight.sh` … **81スイート全合格・「✅ 出荷可」**
- 個別再実行：Engineer Card／Plan Fuel Authority／Fuel Timing Authority／Strategy Playbook／Local Intent Router／Team Plan／Chief cross-PC／gap-freshness／gap-answer-queue／Build280 replay／named-rival／live-pace-repetition／`tests_plan_fuel_authority.py`／`tests_gap_authority.py` … 全PASS
- 外部API・本番Team Link Codeは不使用。

### 未解決

- **P1**：ライバルの標本源は `CarIdxLastLapTime`（完了ラップ1本）で、こちらにはクリーン判定が無い。相手の黄旗周・トラフィック周が中央値に混じり得る。中央値と最小2周で緩和しているが、相手側のラップ有効性は iRacing が出さない＝**実測の限界として残る**。回答は必ず「直近N周の中央値」と根拠付きで述べる。
- **P2**：`fieldCoverage` の `classEntryCount` は SessionInfo 側にある事実で、現状 renderer からは渡していない（常に `complete_field:false`＝安全側）。全同クラス分析を名乗るには配線が要る。
- **P2**：相対ペースは自発コールを出さない。質問への回答のみ。
- **未到達**：`auth.js` を含むサーバー側は push＋deploy が別途必要。exe反映にはBuildが必要。

### MD更新台帳への追記（Phase F）

| 日時(JST) | commit | 追記した節 | 中身 |
|---|---|---|---|
| 08-29 | `4a89cd4` | 2026-08-29 Phase F | F1相対ペースauthority（入力・対象固定・スコープ・鮮度・fail-closed・禁止事項）／F2 GAP訂正の保留と再観測解除／F3単一snapshotと4判定／F4 Chief導線・変更ファイル・phase F 64/64・preflight 81件全合格・P1/P2 |
