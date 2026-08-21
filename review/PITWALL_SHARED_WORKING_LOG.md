# PITWALL Shared Working Log

Status: Yuji ↔ Codex ↔ Claude Code の作業共有用正本  
更新者: Yuji またはCodex  
運用開始: 2026-08-12

## 使い方

YujiはClaudeへ長文を転記しない。次の一文だけ伝える。

```text
2026-08-12 08:21 JST。review/PITWALL_SHARED_WORKING_LOG.md を更新した。作業前に必ず全文を確認して、現行の指示と差戻しを反映して。
```

Claude Codeは作業前に必ず、この文書と次を全文確認する。

- `review/PITWALL_INTERNAL_SIMULATION_TEST_POLICY.md`（内部シミュレーション・原価ゲートの正本）
- 該当Buildのbrief／completion evidence

Claude Codeは実装後、この文書を勝手に「完了」へ書き換えない。変更ファイル、テスト、未完了、commit/build/publicの未実施を `Claude Code 実装報告` に追記し、Codexレビューを待つ。

## 絶対ルール

- commit / push / build / 公開はYujiの明示GOまでしない。
- 実装、ローカルテスト、配布、Windows取得、実走は別の証拠として扱う。
- LLMに燃料、残周回、損傷部位、復帰順位を推測させない。Bridgeの決定論的状態を権威とする。
- 通常テストでAnthropic、Google STT、Google TTSの実APIを呼ばない。詳細は内部シミュレーション正本に従う。
- 保存だけでは学習完了ではない。`申告 → 状態 → Plan → handler → 無線 → 結果保存` のtraceを要求する。

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
