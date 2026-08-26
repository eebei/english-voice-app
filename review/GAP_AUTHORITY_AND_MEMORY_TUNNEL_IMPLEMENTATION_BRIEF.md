# GAP数値権威＋Memory出口完成 実装指示書

作成: 2026-08-25 JST  
決定者: Yuji  
実装担当: Claude Code  
独立確認担当: Codex

## 0. 指示

YujiのGOにより、次の二本を同じ候補で進める。

1. 実走P0/P1: 前後GAPの対象車・方向・数値・鮮度を正す。
2. Phase前進: 既存の記憶入口を、Decision ID、サーバー正本、次回の自発発話、今回Planへの採用、採点、訂正・削除まで接続する。

入口だけ、保存だけ、handlerだけ、テスト用fixtureだけを作って完了としない。`AGENTS.md`のTunnel Completion Ruleと`review/MEMORY_TO_STRATEGY_SHARED_UNDERSTANDING_V1.md`を必須条件とする。

commitは変更単位ごとに可能。push / private build / deploy / 公開はYujiの別GOまで禁止する。

## 1. GAP不具合の実測証拠

対象ログ:

`/Users/yuji.s/Downloads/OMORAY-bridge-debug-20260823-1403.log`

- 19:11:59 Luna: `後ろ3.8秒。2.6秒開いた。`
- 19:12:00 Bridge DATA CHECK: `gapBehind:0.6`
- 19:14:16 GAP候補: `前5.5秒。5.3秒開いた。` をRenderer queueへ登録。
- 19:14:18 DATA CHECK: `gapAhead:10.5 gapBehind:3.0`
- 19:14:24 DATA CHECK: `gapAhead:0.7 gapBehind:8.2`
- 19:14:30 `gap_trend`がqueue 14,110ms後にTTS開始。
- 19:14:31 queue 14,742ms後に古い`前5.5秒`を再生。
- 同区間に`DIR FIX ... EstTime said behind, position says ahead`および逆方向のtraceがある。

これは許容できる表示更新差ではない。接近／離反、前／後ろ、対象車が変わった後に古い数字を発話する事実誤認である。

## 2. GAPの確認済み根本原因

### 2.1 二重の数値権威

`irsdk-bridge/bridge.py`は、一つのpoll内で次の二系統を使用している。

- 先に`CarIdxEstTime`で`nearest_ahead_gap / nearest_behind_gap`と対象car indexを作り、`gap_call_policy.observe()`へ渡す。
- その後Raceでは`CarIdxF2Time`＋隣接クラス順位でGAP値だけを上書きし、telemetry質問回答へ渡す。

自発コールと質問回答・DATA CHECKが別の数字になり得る。さらにF2上書き時に`nearest_ahead_idx / nearest_behind_idx`を同じ対象車へ更新していない。

### 2.2 Renderer queueでの陳腐化

Bridgeの`_gap_candidate_is_fresh()`はBridge pendingを検査するが、Rendererへdispatchした後のspeech queueはGAPを再検査しない。会話や他の発話に待たされると、今回のように14秒以上古い数字をそのまま再生する。

### 2.3 検査の穴

既存テストは完成済みの`gap_behind: 5.8`等をrouterへ与え、文面だけを確認している。SDK配列→対象車選択→方向→snapshot→dispatch→保留→TTS開始の一列を再生していない。

## 3. GAPの実装契約

### 3.1 意味の異なるGAPを分離する

一つの`gap_ahead / gap_behind`へ上書きしない。

- `same_class_battle_gap`: Raceの同クラス隣接順位。iRacing dashboard準拠のRace権威値。
- `physical_traffic_gap`: GTP / LMP2 / GT3等、異クラスを含む物理的な前後接近。危険・traffic用途。
- Practice / Qualifyingの物理位置GAPはRace順位GAPと混同しない。

各recordへ最低限次を持たせる。

```text
session_key
source_kind
direction
gap_s
target_car_idx
target_class
target_class_position
sampled_at
generation
```

質問と自発コールは、意図に対応するsourceを明示して読む。GTP接近を同クラスGAPで代用せず、その逆もしない。

### 3.2 同じpollで値と対象IDを確定する

- 値だけを後段で上書きしない。
- 前後方向を順位と物理位置の両方で検証し、矛盾時は発話しないで診断traceを残す。
- S/F跨ぎ、周回差、pit、順位変更、追越し、対象車交代、incident、session変更でgenerationを更新する。
- `abs()`で方向矛盾を隠さない。direction確定後に表示値だけ正数化する。

### 3.3 再生開始時の鮮度契約

- GAP候補を完成文だけでqueueへ入れず、上記record identityを保持する。
- TTS開始直前に最新snapshotと`session_key / generation / target_car_idx / direction`を照合する。
- 値が有効でも変化した場合は最新値で短文を再構築する。
- 対象車または方向が変わった場合は旧候補を破棄する。古い対象の数字を新しい対象として読まない。
- 最新値を同期取得できない場合は、古い数字を喋らず`discarded_stale`にする。
- 通常GAP候補を14秒保持しない。最大年齢をclosed constantにし、境界テストを作る。
- PTTの直接質問もsnapshot時刻を検査し、古い場合は同期更新要求または短い取得不可へfail-closedする。

### 3.4 発話内容

- 質問: `後ろ5.0秒。`のように聞かれた対象だけ答える。
- 自発: 値だけでなく変化の意味が成立する場合だけ、例`後ろ5.0秒、1.2秒詰めている。`
- 「開いた／詰めている」は同一target car・同一direction・十分な観測期間の差分だけで決める。
- 最終周、混走、安全コールとの優先順位は既存方針を維持し、P0/P1をGAPが妨げない。

## 4. GAP必須再生テスト

既存router単体テストだけでは不合格。保存SDK fixtureまたは等価なraw arraysから次を一列で再生する。

1. 同クラスの前後が安定し、dashboard権威値と発話値が同じ。
2. 異クラスGTPが後方から接近し、対象class・car index・方向・数値が一致する。
3. EstTimeと順位が矛盾し、誤った前後を発話しない。
4. S/F跨ぎで一時的に周回値が変わっても前後が逆転しない。
5. 追越しで対象車が前後を入れ替え、旧候補を破棄する。
6. pit in/out、順位jump、incident、session変更で旧候補を破棄する。
7. queue 0.5秒、境界値、境界値超過、14秒待機。14秒の旧数値は絶対に再生しない。
8. 候補生成後に5.5→0.7秒へ変化した場合、旧5.5を再生しない。
9. 候補生成後に3.8→0.6秒へ変化した場合、旧3.8を再生しない。
10. live値があるPTT質問はno-dataや`今ここでは伝えられない`へ落ちない。

traceには`sampled_at / queued_at / tts_start / played_at / age_ms / target_car_idx / generation / source_kind / fate`を残す。

## 5. 未搭載だったMemory出口を完成させる

Build 283のスライスA/B/Cは、ローカルの過去記録から短いブリーフィングを出す最初の一本であり、Memory Action Layer完成ではない。次を同じ共通契約で接続する。

### 5.1 Decision ID lifecycle

- 提案時にDecision ID、選択案、根拠、成立条件、不確実性、予測を保存。
- pit exit、blend安定、checkerまたは途中終了で同じIDへ事実を追記。
- 成功、traffic失敗、fuel失敗、実行不成立、事故・切断・不明をclosed enumで分類。
- 成功例だけでなく失敗例も次回条件判断へ使う。

### 5.2 サーバー正本＋ローカルcache

- 認証ユーザー単位のサーバー正本とし、全キャラクターで事実を共有する。
- localStorageはoffline cache。別ユーザー、重複event、retry、古いcache、削除後再同期を反証する。
- 送信するのは構造化した戦略・結果・setup/天候要約。生音声、会話全文、不要なraw telemetryは保存しない。
- privacy / terms / 事前明示 / opt-out / 表示 / 訂正 / 削除 / 保持期間を同じscopeで実装する。公開は別GOまで行わない。

### 5.3 次回の必須出口

- 同一driver / car / track / series / race format条件から過去1件を決定論的に選択。
- 成功例: 次回ブリーフィングで前回の事実と今日の適用条件を短く自発発話。
- 失敗例: 同じ失敗条件なら勧めない理由を短く提示。条件が変われば再候補にできる。
- 今日のfuel window、予選順位、rejoin/traffic条件が成立した時だけ当日Planの根拠へ接続。
- `注入した`では合格にしない。`memory_strategy_briefing`のqueue生成、保留、再生または理由付き破棄まで証明する。

### 5.4 setup・過去天候

- setup fingerprint/version、本人申告変更、変更前後のvalid lap、fuel、tyre/handling、天候を同じsession identityへ結合。
- 取得不能なsetup数値を推測しない。SDK実測と本人申告をsource labelで分離する。
- 過去天候質問へ現在値を代用しない。
- 次回Practiceで前回setup変更と結果を自発ブリーフィングまたは質問回答へ使う。

### 5.5 訂正・削除

- ドライバーが`それ違う`と述べた記憶をDecision IDで特定し、即`disputed`として利用停止。
- 一度だけ読み返して本人合意後に訂正を有効化。特定不能なら推測して保存しない。
- 訂正前recordを次回提案へ再利用しない。
- 表示、削除、session reset、保持期限、server/local同期まで接続する。

## 6. Memory必須E2E fixture

1. P8→Lap 6 undercut→予測rejoin→blend P4→採点→翌日自発発話→今日の条件成立後Plan採用。
2. undercut→trafficでP8悪化→同条件では非推奨→条件変更後は再候補。
3. 誤pit lap→本人異議→即disputed→読み返し合意→訂正後だけ次回利用。
4. setup変更→valid laps→評価→次回Practiceで比較→本人訂正。
5. 別driver / car / track / series / format、古いrecord、未来日時、根拠欠落、削除済み、古いcacheでは利用しない。
6. Bridge入力→Decision→server保存→次回取得→handler→queue→発話/破棄→今回採点→訂正/削除を一本のtraceで証明。

## 7. 原価・安全・出荷条件

- 数値判断は決定論層。LLMはGAP値、対象車、Decision ID、過去record、戦略採用を選ばない。
- 通常テストの外部有料API呼出は0件。
- GAPのローカル再計算・stale破棄は原価削減。生成後に破棄したTTS/LLM原価はcost traceへ分離する。
- GAPは`review/PITWALL_RELEASE_GATE.md` Gate 1/2/8/10を満たすまで完成扱いにしない。
- Memoryはserver/auth/privacy変更を含むためGate 7必須。
- 機械検証、package検証、Windows検証、iRacing実走、公開確認を混同しない。

## 8. Claude Codeの完了報告

共有ログへ次を記録する。

- 入口→出口マトリクスと空欄の有無
- 変更ファイルと完全diff
- GAP authority recordとDecision ID状態遷移
- 上記GAP 10本、Memory 6本のtrace結果
- 対象テスト、関連全回帰、preflight、外部有料API呼出0件
- packageへ追加したruntime moduleと検査結果
- server/auth/privacy/terms/UI変更
- 未確認のWindows、iRacing、server deploy、公開表示
- commit / push / build / deploy / 公開の実施有無

Claude Codeは実装後にCodexへ独立確認を依頼する。Codexは同じ変更を重複実装せず、実走ログの失敗時刻から出力→sourceへ逆引きして反証する。

---

## 9. 2026-08-25 JST — Yuji即時指示：Memory→Strategy v1 を先送りしない

### 指示の優先順位

Build 284のGAP P1を閉じた後に「次のPhase」として回さない。今回の作業単位は、**GAP P1修正とMemory→Strategy v1の出口実装を同時に完了させること**である。

現状の`pw_raceHistory`→`session-memory.js`→`memory_strategy_briefing`は、過去の順位・天候を短く読む**スライス1**である。これはMemory Action Layer v1の完成ではない。保存／注入／一度のブリーフィングを「記憶が使えた」と報告してはならない。

### ユーザーが求める完成動作

翌日の同一条件レースで、Lunaが自発的に次のような意味の会話をできること。

> 昨日はP8スタート。Lap 6で条件付きundercutを選び、blend後P4まで上がった。今日も予選順位、燃料window、復帰trafficが揃えば候補にする。まず今日の予選を決めよう。

失敗例では、成功例のように推奨してはならない。

> 前回は同じundercutを試したが、復帰先のtrafficで順位を落とした。今日も同条件なら早入りは勧めない。復帰先が空くなら再評価する。

数字・順位・pit周が確定していない時は作らない。今日の条件が未成立なら、過去結果を保証や決定として話さない。

### 実装する完全トンネル（空欄禁止）

| 段 | 必須実装 |
|---|---|
| 入口 | Bridgeの`strategy_plan_decision`、pit exit、blend安定、checker／途中終了、driver申告／訂正 |
| 権威 | Decision ID、同一frameのPlan根拠、実行pit周、給油量、順位。LLMは数字や記録を選ばない |
| 保存 | 認証ユーザー単位の**サーバー正本**。localStorageはoffline cache。成功・失敗・不成立・事故／切断を同じDecision IDへ追記 |
| 取得 | driver / car / track / series / race format / 記録年齢 / disputed / deletedを決定論的に絞る |
| 判断 | 今日のgrid、fuel window、rejoin／trafficの成立を確認してからPlan根拠へ条件付き採用 |
| 出力 | 次回strategy briefingで短い自発発話、当日のstrategy提案、質問への過去事実回答 |
| 採点 | blend後とchecker（または中断）でsuccess / traffic_failure / fuel_failure / not_executed / incident_or_disconnect / unknownを確定 |
| 訂正・削除 | 「それ違う」で即`disputed`、次回利用停止。本人確認後だけ訂正。削除済み・古いcacheは再利用しない |
| 証拠 | fixture→server→cache→次回handler→queue→TTS fateまでのtrace。外部有料API 0件 |

### 同時に直すBuild 284 GAP P1

PTTの`nearest_gap`回答が、質問時点だけでなく**TTS開始直前**にも同じ`gap_authority` identityで照合されるようにする。

1. PTT回答は対象車、direction、session、generation、sampled_atをspeech queueへ渡す。
2. queue待ちで対象／direction／session／generationが変われば破棄する。
3. 同じ対象で値だけ変われば最新値へ短く再構成する。
4. 前後同時質問では、片側だけが古いまま読まれない。
5. 「質問→先行発話で6秒待機→TTS開始」の統合再生で、旧数値が再生されないことを固定する。

### 必須E2E再生（実装者の完了条件）

1. 成功: P8→Lap 6 undercut→pit exit→blend P4→採点→翌日同条件で自発発話→今日の条件成立後にPlan根拠として採用。
2. 失敗: undercut→trafficでP8へ悪化→翌日は同条件で非推奨→traffic条件が変われば再評価。
3. 訂正: 誤pit周→本人異議→即disputed→利用停止→本人合意で訂正→訂正後だけ再利用。
4. setup: 本人申告のsetup変更＋valid laps＋評価→翌Practiceで比較に使う。SDK非取得値は申告として明示。
5. 拒否: 別user / car / track / series / format、90日超過、未来日時、削除済み、古いcache、根拠欠落では発話もPlan採用もしない。
6. GAP: PTTの前後／両方質問がqueue待ちで古くならず、最新の同一権威値だけを再生または理由つき破棄する。

### 禁止事項

- `pw_raceHistory`だけを増やして「v1完成」としない。
- LLM promptへの履歴注入だけで「自然に使う」としない。
- 成功ケースだけで採点・選択テストを通さない。
- UIや設定だけを作り、server保存・取得・訂正・次回出力を欠かさない。
- package／Windows／iRacing実走未確認を「Build完成」または「利用可能」と表現しない。
- push / private build / deploy / 公開はYujiの別GOまで行わない。

### Claude Codeの報告形式

完了報告は「実装済み」ではなく、上の各段について source→outputを示す。各E2E fixtureのDecision ID、queue fate、server/cacheの証拠、対象テスト、未確認Windows／iRacing／server deploymentを同じ共有ログへ記録し、Codex独立確認へ渡すこと。

## 10. 2026-08-25 JST — 全記憶ジャンル統合の即時実装指示

「記憶」をジャンルごとの片道機能として残してはならない。次のジャンルを、同じ`MemoryRecord`／`Decision ID`／identity契約で扱う。

- レース結果・順位・周回・インシデント
- 燃費・pit timing・pit loss・rejoin／blend結果
- Plan A／B／C、undercut、baseline、splashの予測と実行結果
- 成功だけでなく、traffic失敗、fuel失敗、未実行、事故、切断、不明
- 過去天候（現在値で代用禁止）
- setup fingerprint／version、本人申告の変更、valid lap、タイヤ／挙動評価
- ドライバーのフィーリング、訂正、発話方針、呼称、情報量の希望
- Chief Engineerのドライバー間引継ぎと、次ドライバーへの要点

各ジャンルについて、次の9段を一つのtraceで実装・検証すること。

`source/capture → authoritative validation → state/persistence → identity retrieval → decision/consumer → radio/UI/briefing output → outcome/scoring → correction/delete/reset → proof`

入口だけ、localStorage保存だけ、LLM prompt注入だけ、デブリーフ表示だけでは不合格。各ジャンルの出力は少なくとも以下のどれかへ到達しなければならない。

1. 次回の同一driver／car／track／series／formatブリーフィングで、自発的に短く話す。
2. 今日のgrid、fuel window、traffic、rejoin条件が成立した時だけ、Planの根拠として条件付き採用する。
3. Practiceではsetup／過去天候／ドライバー申告を比較材料として提示する。
4. レース後は予測と実結果を同じDecision IDで採点し、次回の成功／非推奨条件へ反映する。

記録が誤っている場合は、ドライバーの「それ違う」で即時`disputed`にし、その記録を次回の発話・Planから止める。本人確認後の訂正版だけを再利用する。削除、session変更、driver交代、古いcache、別ユーザーでは残留状態を再利用しない。

### 全ジャンル受入マトリクス

実装完了報告では、上記ジャンルを行、9段を列としたマトリクスを共有ログへ出し、空欄を残さない。空欄があるジャンルは「未接続」と明記する。fixtureは成功例だけでなく、失敗・訂正・削除・途中終了を含める。`spoken / not_applicable_current_conditions / deferred_unsafe_driving_window / discarded_stale / missing_required_evidence`のいずれかのfateを必ず残す。

この指示書の完了条件は「Memory V2がある」「過去記録が保存された」ではない。**全ジャンルで、次回Lunaの発話または条件付き戦略提案まで到達し、その根拠traceをCodexが逆向きに確認できること**である。
