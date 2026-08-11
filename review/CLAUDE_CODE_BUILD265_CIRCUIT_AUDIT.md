# OMORAY PITWALL — Build 265 Circuit Audit and Wiring Repair

## English instructions for Claude Code

### Mission

Audit the entire live race-decision circuit and repair every confirmed disconnected or self-conflicting path exposed by the Build 264 Monza 35 GT3 one-make run. Do not make a partial patch. The acceptance condition is that each supported race-engineer call has one authoritative source of truth, a valid lifecycle gate, deterministic dispatch, renderer/handler handling, TTS/UI delivery, deduplication, and an executable test with trace evidence.

### Repository and evidence

- Repository: `/Users/yuji.s/Desktop/Claude/english-voice-app`
- Real-run evidence: `/Users/yuji.s/Downloads/OMORAY-bridge-debug-20260810-1838.log`
- Build under test: Build 264.
- Do not commit, push, package, publish, alter the public release, or claim a Windows update was delivered. Local implementation and local tests are in scope.

### Non-negotiable product rule

Do not let two subsystems make contradictory race calls. A race strategy is a stateful plan, not independent answers calculated in isolation. A critical safety/fuel call may override a plan only when it proves the driver cannot safely reach the selected plan's next decision point.

### Confirmed failures from the supplied log

1. **False early pit call conflicted with the selected strategy.**
   - At `18:55:02`, lap 5: fuel `37.63L`, live burn `3.641L/lap`, 16 crossings to finish, and the fuel-band system emitted P0 `fuel_strategy_warning`: `この周ボックス。21リットル。`
   - At `18:55:05`, the strategy engine selected Plan A with first pit lap 14, target in 9 laps, predicted entry fuel `4.75L`.
   - Fuel needed to reach lap 14 plus a 0.5L reserve was about `9 × 3.641 + 0.5 = 33.27L`, so `37.63L` was sufficient to reach the planned stop.
   - Root cause: the fuel-band circuit compared current fuel with fuel required to finish without stopping. It treated the total race deficit (`20.626L`) as an immediate "box this lap" condition, despite the planned one-stop strategy.

2. **Strategy update radio spam.**
   - `STRATEGY_PLAYBOOK_UPDATE` occurred 11 times.
   - The five-lap rolling burn changing by hundredths (for example 3.64 to 3.65) repeatedly spoke `当日クリーン5周、燃費…でPlan A・B・Cを更新した。`
   - It also spoke on final lap and after `PLAYER_FINISHED`.

3. **Unresolved-operation fallback spam.**
   - `今は確定のコールを出さない…` occurred 5 times.
   - `今は確認できる数値だけで答える…` occurred 7 times.
   - A pending follow-up must be one deliberate action with a resolution or expiry rule, not a phrase re-armed on repeated questions.

4. **Track-memory contamination.**
   - The memory action trace merged `Monza Full` and `monza gpsecondchicane` under canonical `monza:full`.
   - `monza gpsecondchicane` must not automatically merge into Monza Full. Preserve legitimate aliases only.

5. **Personal-best call must be audited end-to-end.**
   - The user did not hear the first expected best-time update in the run. The log contains the `personal_best` event at `18:55:02`, but that event was ducked by the P0 fuel warning. Audit telemetry detection, lifecycle gate, director priority/queue policy, renderer mapping, TTS, dedupe, and UI transcript. A P0 call must not silently erase a useful P2 personal-best call; it may defer it only if it remains timely and valid.

### Required circuit inventory

Create `review/BUILD265_CIRCUIT_AUDIT.md` with a row for every supported live call or user-facing response path. At minimum include:

- Session recognition and race format
- Fuel remaining / fuel-to-finish / fuel warning / planned pit call / post-stop fuel-safe call
- Plan A / Plan B / Plan C creation, live revision, switch proposal, and rejoin forecast
- Personal best, session best, and configured lap readout
- Pace monitor
- Same-class battle calls and multiclass safety calls
- Pit entry, pit service, pit exit forecast, and rejoin call
- Gap and position responses
- Tyre temperature, tyre condition/wear, track temperature, and vehicle-state responses
- Memory lookup, Memory Action Layer briefing, and live strategy use
- Operational follow-ups and "not yet confirmed" responses
- Final-lap, checker, player-finished, debrief, and session-transition suppression
- Explicit driver quiet/silence command, if implemented or currently claimed

For each row document:

`telemetry/input → normalizer/intent → authoritative decision owner → lifecycle gate → director priority → renderer/handler → TTS + transcript → dedupe/re-arm → trace key → test file`

Mark every missing edge as either repaired, intentionally unsupported, or blocked with a precise reason. Do not label a path complete merely because its code exists.

### Required implementation changes

#### A. Make fuel calls plan-aware

1. Introduce one authoritative fuel-decision contract shared by the bridge and renderer/strategy playbook. Do not allow the bridge's fuel-band warning to independently tell the driver to pit when an active selected plan has a reachable future pit window.
2. With an active plan, calculate:
   - fuel required to safely reach the selected plan's next pit window;
   - fuel required after that stop to finish;
   - whether the planned service amount fits capacity;
   - whether a new stop, fuel saving target, or immediate pit is truly necessary.
3. The immediate P0 pit call is allowed only when one of these is true:
   - current fuel cannot reach the selected pit window plus reserve;
   - the selected pit window has been reached or passed and the plan says to stop;
   - a verified capacity/finish projection proves the selected plan cannot finish and a new action is necessary;
   - a separate P0 safety condition applies.
4. While the selected pit window remains reachable, a total-finish fuel deficit must update the planned service amount internally. It must not emit `この周ボックス`.
5. A driver question may report the fuel projection, but it must distinguish `planned fuel to add` from `pit now`. Never infer an urgent pit solely from total remaining-race fuel.
6. Emit structured trace fields that make the decision auditable: selected plan, next pit lap, laps to pit, reach-pit margin, finish margin after planned service, capacity result, override reason, and whether speech was permitted.

#### B. Stop non-critical strategy speech spam

1. Speak the live-fuel strategy revision once when three valid clean laps first establish it.
2. Thereafter update the internal playbook silently unless a material driver-facing change occurs. Define material change deterministically, at least one of:
   - selected plan changes;
   - first pit lap changes by at least one lap;
   - stop count changes;
   - required fuel-saving target crosses a defined meaningful threshold;
   - a verified rejoin/traffic condition changes the recommendation.
3. Do not speak routine P3 strategy updates on final lap, after checker, `PLAYER_FINISHED`, debrief, or an inactive session.
4. Do not let a P0 warning permanently discard a still-timely personal-best/lap-readout call. Use a bounded deferred queue or explicit discard trace; never silently lose it.

#### C. Fix follow-up ownership and repetition

1. A generic unresolved reply may arm one follow-up only if a concrete future telemetry event can answer the question.
2. Key it by intent + session + relevant decision/lap. A repeated user question cannot create parallel copies.
3. On the next qualifying event, either deliver a new factual answer once or expire it with a trace reason. Do not repeat the same generic wording before new data exists.
4. Do not arm or deliver these follow-ups during final-lap/finished/debrief lifecycle states.

#### D. Correct track aliasing

1. Keep exact course configurations separate by default.
2. Merge only an explicitly maintained alias set that is demonstrably the same configuration.
3. Add a regression test proving `monza gpsecondchicane` and `monza full` do not combine, while valid known aliases still do.

#### E. Audit personal-best delivery

1. Prove with a test that a personal-best event generated during a P0 fuel call is either delivered once after the P0 call while timely, or logged as deliberately expired with a reason.
2. The default expected behavior for the supplied run is a deferred, once-only personal-best message, not silent loss.
3. Preserve priority for genuine P0 safety calls; do not solve this by making PB higher priority than safety.

#### F. Audit and wire every driver-selectable radio setting

The product cannot expose a choice that does not deterministically affect live behavior. Audit every setting that is currently visible, persisted, planned, or referred to in code. For each setting prove this complete circuit:

`exact UI label and selected value → persistence/default → session configuration sent to the bridge → decision/handler gate → director/TTS behavior → UI trace → automated test`

At minimum cover the following user choices:

1. **Race Radio Profile:** `Quiet`, `Race`, `Practice-Coach`, `Endurance`.
   - Define the permitted classes of calls for each profile.
   - A profile must suppress only the calls it promises to suppress; real P0 safety calls remain protected.
2. **Lap Readout:** `Off`, `Best only`, `Every 2 laps`, `Every clean lap`.
   - `Off` emits no routine lap-time radio.
   - `Best only` emits each valid PB/session-best event exactly once, subject to bounded P0 deferral.
   - `Every 2 laps` reads every second eligible completed lap, not arbitrary telemetry updates.
   - `Every clean lap` reads each eligible clean completed lap.
   - Define and test the eligibility rule for pit-in/out, invalid laps, and lifecycle state.
3. **Pace Monitor** and its threshold mode (`Auto` / `Custom seconds`).
   - The chosen threshold must reach the deterministic pace monitor; it must not remain a UI/LLM-only value.
4. **Radio Frequency**, **Fuel & Pit Timing**, and **Pit Call Strength**.
   - For every available value, define the concrete effect on frequency, timing, concision, and priority. Do not leave a cosmetic selector.
5. **Battle Calls:** `Off`, `Same Class`, `Multiclass`, `Both`; and **Call Timing:** `Close only`, `Closing`, `Active`.
   - The selection must gate the correct same-class strategy calls and multiclass safety calls separately.
   - In Japanese radio, speak the actual class name (`GTP`, `P2クラス`, `GT3`), never the settings label "Same Class".
6. **Race Overlay: ON/OFF** must remain a display control only. It must not silently change radio behavior.

Do not invent a UI label. If a control is not yet implemented, mark it explicitly as unavailable rather than presenting it as working. Add a concise settings-wiring matrix to the audit file and regression tests for every currently exposed selectable value. Include at least one test that proves changing Lap Readout changes actual radio dispatch behavior.

### Test requirements

Add focused automated tests before declaring work complete. At minimum:

1. **Monza 35 regression:** lap 5, fuel 37.63, burn 3.641, selected Plan A pit lap 14, 9 laps remaining to pit. Assert no immediate pit call; assert reach-pit margin is positive and planned fuel service is updated.
2. **True emergency:** fuel cannot reach selected pit window plus reserve. Assert one P0 concise pit call.
3. **Plan failure:** planned service cannot finish within capacity. Assert the correct changed strategy/extra-stop/fuel-save decision, with no misleading one-stop claim.
4. **Live revision latch:** initial 3 clean laps may speak once; 3.64 → 3.65 with unchanged plan must not speak; a material pit-lap or plan change may speak once.
5. **Lifecycle suppression:** no P3 strategy speech on final lap or after `PLAYER_FINISHED`.
6. **Follow-up idempotency:** repeated unresolved questions produce one pending follow-up and at most one resolved delivery.
7. **PB under P0:** verify deferred or explicitly expired behavior.
8. **Track alias separation:** second-chicane data does not pollute Monza Full strategy memory.
9. **Settings wiring:** changing each exposed Lap Readout mode changes real dispatch behavior; at least one profile, battle-call scope, and pace-threshold selection must also be verified end-to-end.
10. Run the existing relevant test suites as well; report exact commands and results.

### Required evidence and handoff

Before handoff, provide:

1. The completed circuit audit matrix.
2. A concise changed-file list.
3. Test commands and their actual results.
4. A synthetic trace for the Monza 35 regression showing no pit-now call at lap 5, the planned pit window retained, and one allowed call at the correct decision point.
5. A synthetic trace showing that a P0 call and PB do not silently conflict.
6. Any remaining unsupported paths or risks, stated plainly.

Do not say "fixed" unless the required automated evidence is present. Do not build or publish anything.

---

## 日本語指示（Yuji確認用）

### 目的

Build 264のMonza 35・GT3ワンメイク実走で露呈した、レース判断から無線までの全回路を監査し、未接続・二重判断・矛盾発火を直すこと。部分修正で終わらせない。各ライブコールについて、唯一の判断元、ライフサイクル判定、発火、UI／TTS到達、重複抑制、trace、実行可能テストまでを確認する。

### 対象と制約

- リポジトリ：`/Users/yuji.s/Desktop/Claude/english-voice-app`
- 実走ログ：`/Users/yuji.s/Downloads/OMORAY-bridge-debug-20260810-1838.log`
- 対象Build：264
- commit、push、package、公開、公開リリース変更、Windowsへの配布完了の主張はしない。ローカル実装とローカルテストまでは対象。

### 絶対原則

二つのサブシステムが、矛盾するレースコールを出してはならない。戦略は独立した回答の寄せ集めではなく状態を持つ計画である。安全上の緊急コールが戦略を上書きできるのは、選択中プランの次の判断点へ安全に到達できないことを証明できる場合だけ。

### 実走で確認済みの不具合

1. **予定戦略と矛盾する早期ピット指示**
   - 18:55:02、5周目、燃料37.63L、実測3.641L/周、残り16回S/Fで、fuel-bandがP0 `fuel_strategy_warning`を出し「この周ボックス。21リットル。」と発話。
   - その3秒後の18:55:05、戦略エンジンはPlan A＝14周目ピット、あと9周、想定入庫燃料4.75Lを選択。
   - 14周目までに必要なのは `9 × 3.641 + 0.5 = 約33.27L`。37.63Lあるため、予定ピットには到達可能。
   - 原因：fuel-bandが「無給油でゴールまで必要な燃料」と現在燃料を比べ、20.626L不足を即ピット条件にした。予定の1ストップ戦略を見ていない。

2. **戦略更新の連続発話**
   - `STRATEGY_PLAYBOOK_UPDATE`が11回。
   - 5周ローリング燃費の小さな変動だけで、同じ「Plan A・B・Cを更新した」を繰り返した。
   - Final Lapと`PLAYER_FINISHED`後にも発話。

3. **未確定回答の反復**
   - 「今は確定のコールを出さない…」5回。
   - 「今は確認できる数値だけで答える…」7回。
   - follow-upは、再質問で増殖させず、一度だけ予約し、回答可能時に一度だけ解決または期限切れにする。

4. **コース記憶の混入**
   - Memory Action Layerが`Monza Full`と`monza gpsecondchicane`を同じ`monza:full`に統合していた。
   - `monza gpsecondchicane`をMonza Fullへ自動統合してはならない。

5. **ベスト更新の到達性**
   - ユーザーが最初のベスト更新を聞けなかった。ログには18:55:02の`personal_best`イベントがあるが、P0燃料警告によりduckされている。
   - テレメトリ検知、ライフサイクル、director priority/queue、renderer、TTS、dedupe、UI transcriptまでを監査する。P0がPBを黙殺してはならず、タイムリーなら一度だけ後送り、期限切れなら理由をtraceする。

### 必須の回路一覧

`review/BUILD265_CIRCUIT_AUDIT.md`を作り、少なくとも以下すべてについて一行ずつ監査すること。

- セッション認識とレースフォーマット
- 燃料残量／完走燃料／燃料警告／予定ピット／給油後の燃料OK
- Plan A／B／C生成、実測更新、切替提案、復帰順位予測
- ベスト更新、セッションベスト、設定済みラップ読み上げ
- Pace Monitor
- 同一クラスのバトルコールとマルチクラス安全コール
- ピット進入、サービス、ピット出口予測、復帰コール
- GAPと順位応答
- タイヤ温度、タイヤ状態・摩耗、路面温度、車両状態応答
- Memory lookup、Memory Action Layerブリーフィング、ライブ戦略への記憶利用
- 運用follow-upと「未確定」回答
- Final Lap、チェッカー、PLAYER_FINISHED、デブリーフ、セッション遷移時の抑制
- 実装済みまたは主張済みなら、ドライバーの「黙って」指示

各行に必ず次を記載：

`telemetry/input → normalizer/intent → authoritative decision owner → lifecycle gate → director priority → renderer/handler → TTS + transcript → dedupe/re-arm → trace key → test file`

欠けた接続は、修正済み・意図的未対応・ブロック中（具体理由）のいずれかに分類する。コードがあるだけで完了扱いにしない。

### 実装必須事項

#### A. 燃料コールをプラン認識にする

1. Bridgeとrenderer／strategy playbookで共通の燃料判断contractを作る。選択中プランに到達可能な次ピットがある場合、Bridge単独のfuel-bandが「この周ピット」と言わない。
2. 選択中プランがある時は、次を計算する。
   - 次の予定ピットまで安全に届く燃料
   - そのピット後に完走する燃料
   - 予定給油が容量内か
   - 追加ピット、燃費セーブ、即ピットが本当に必要か
3. P0の即ピットは以下のみで許可。
   - 予定ピット＋リザーブまで届かない
   - 予定ピット周に到達または超過し、プランがstopを示す
   - 容量／完走予測が選択プラン不成立を実証し、新しいアクションが必要
   - 別のP0安全条件
4. 予定ピットが届く間、ゴールまでの総不足は内部で予定給油量を更新するだけ。`この周ボックス`を出さない。
5. ドライバーから聞かれた場合も、`予定給油量`と`今すぐピット`を分けて答える。
6. traceに、選択プラン、次ピット周、そこまでの周回数、予定ピット到達マージン、予定給油後の完走マージン、容量判定、上書き理由、発話可否を出す。

#### B. 非緊急の戦略発話を止める

1. 3周の有効ラップが初めて揃った時だけ、実測更新を一度発話。
2. 以降は内部だけ更新。最低でも以下の実質的変更がある時だけ一度発話する。
   - 選択プラン変更
   - 初回ピット周が1周以上変化
   - 停止回数変更
   - 燃費セーブ目標が意味のある閾値を越える
   - 検証済みの復帰／トラフィック条件で推奨が変わる
3. Final Lap、チェッカー、`PLAYER_FINISHED`、デブリーフ、非アクティブセッションではP3戦略発話を禁止。
4. P0によりPB／ラップ読み上げを無言で捨てない。時間制限つき後送り、または明示的な破棄traceを実装する。

#### C. follow-upの所有と反復を直す

1. 将来の具体的なテレメトリイベントで答えられる時だけ、一件のfollow-upを予約する。
2. intent＋session＋判断対象／lapでキー化し、再質問で並列増殖させない。
3. 次の該当イベントで新しい事実を一度だけ返すか、理由付きで期限切れにする。同じ一般文を、新情報なしに繰り返さない。
4. Final Lap／finished／debriefでは予約も配信もしない。

#### D. コースaliasを修正

1. コース構成はデフォルトで別扱い。
2. 同一構成と実証できる明示aliasだけ統合。
3. `monza gpsecondchicane`と`monza full`が混ざらない回帰テストを追加。正しいaliasは維持。

#### E. PB到達を検証

1. P0燃料発話と同時にPBが出た場合、時間内に一度後送りされるか、期限切れ理由付きで明示的に破棄されることをテスト。
2. この実走ケースの標準動作は、一度だけPBを後送り。無言消滅ではない。
3. 本当のP0安全発話よりPBを高優先にして解決してはならない。

#### F. ドライバー選択式の無線設定を全て監査・接続

選択肢をUIに出すなら、必ず実走動作へ決定論的に繋げること。現在表示中・保存中・実装予定・コード内で言及されている全設定を監査する。各設定について、次の回路を実証する。

`実在するUIラベルと選択値 → 保存／初期値 → Bridgeへ送るセッション設定 → decision/handler gate → director/TTS動作 → UI trace → 自動テスト`

最低限、次の選択を対象にする。

1. **Race Radio Profile：** `Quiet`、`Race`、`Practice-Coach`、`Endurance`
   - 各Profileで許す無線種別を定義する。
   - 抑制すると約束した種類だけを抑制し、本当のP0安全発話は保護する。
2. **Lap Readout：** `Off`、`Best only`、`Every 2 laps`、`Every clean lap`
   - `Off`は通常のラップ無線を出さない。
   - `Best only`は有効なPB／セッションベストを、P0による時間制限つき後送りを除き、一度だけ出す。
   - `Every 2 laps`は任意のテレメトリ更新でなく、条件を満たす完了ラップの二周ごとに読む。
   - `Every clean lap`は条件を満たす各完了ラップを読む。
   - pit in/out、無効ラップ、ライフサイクル状態の適格条件を定義してテストする。
3. **Pace Monitor**と閾値モード（`Auto`／`Custom seconds`）
   - 選択した閾値を決定論的なPace Monitorまで繋ぐ。UIだけ、またはLLMだけの値にしない。
4. **Radio Frequency**、**Fuel & Pit Timing**、**Pit Call Strength**
   - 利用可能な全値について、頻度・タイミング・簡潔さ・優先度への具体効果を定義する。見た目だけのselectorを残さない。
5. **Battle Calls：** `Off`、`Same Class`、`Multiclass`、`Both`。および**Call Timing：** `Close only`、`Closing`、`Active`
   - 同一クラス戦略コールとマルチクラス安全コールを別々に正しくgateする。
   - 日本語無線ではSettingsの`Same Class`を読まず、実クラス名（`GTP`、`P2クラス`、`GT3`）を発話する。
6. **Race Overlay: ON/OFF**は表示だけのcontrolとして維持する。無線動作を密かに変えてはならない。

UIラベルを創作しないこと。まだ実装していないcontrolは、動くように見せず未提供と明記する。監査ファイルにsettings-wiring matrixを追加し、現在公開中の選択肢すべてに回帰テストを足す。少なくともLap Readoutの選択変更で、実際の無線dispatchが変わることをテストで示す。

### テスト必須事項

1. **Monza 35回帰**：lap 5、fuel 37.63、burn 3.641、Plan A pit lap 14、ピットまで9周。即ピットなし、到達マージン正、予定サービス更新をassert。
2. **本当の緊急**：予定ピット＋リザーブまで届かない。P0の簡潔なピットコールが一度だけ出ること。
3. **プラン不成立**：予定給油が容量内で完走できない。追加ストップ／セーブ／プラン変更を正しく出し、誤った1ストップ完走主張をしないこと。
4. **実測更新latch**：3周初回は一度可、3.64→3.65でプラン不変なら無言、ピット周またはプラン変更時は一度可。
5. **ライフサイクル抑制**：Final Lapと`PLAYER_FINISHED`後にP3戦略発話なし。
6. **follow-up冪等性**：未確定の再質問は予約一件、解決発話も最大一回。
7. **P0下のPB**：後送りまたは明示期限切れを検証。
8. **コースalias分離**：second chicaneのデータがMonza Fullの戦略記憶に混ざらないこと。
9. **Settings wiring**：表示中のLap Readout全モードについて、選択変更が実際のdispatch動作を変えること。最低でも一つのProfile、Battle Calls scope、Pace Thresholdもend-to-endで検証。
10. 関連する既存テストも実行し、コマンドと実測結果を報告。

### 引き渡し時の必須証拠

1. 完成した回路監査表
2. 変更ファイル一覧
3. テストコマンドと実測結果
4. Monza 35回帰のsynthetic trace：5周目に即ピットが出ず、予定ピット維持、正しい判断点で一度だけコール
5. P0とPBが無言衝突しないsynthetic trace
6. 未対応・リスクは具体的に明記

必要な自動テストの証拠がなければ「修正済み」と報告しない。Buildや公開は絶対に行わない。
