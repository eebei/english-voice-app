# OMORAY PITWALL 引き継ぎ

最終更新: 2026-09-22 JST（Build 302 Gate 8実走不合格・Gate 10停止判断が必要）

## 2026-09-22 追記：IMSA Fixed Road Atlanta 実走でBuild 302不合格

ログ`OMORAY-bridge-debug-20260922-0934.log`をCodexが確認。Build 302の主変更である
Bridge提案→Desktop発話→Driver合意/拒否→Bridge反映は、Plan B/Cが全区間`unavailable`で
`strategy_plan_proposal`／delivery／response／ackが**一度も発生せず、実走で未成立**。
動いたのは既存のPlan A自動決定だけだった。

11:21のDriver「ピット入るぞ」「前#25が遅いから先に」に対し、前者は`strategy_recommendation`
として通常Planを返し、後者はrelative paceを返すだけで、早期ピットを作戦変更として受け取らなかった。
実際のピットはlap 15で給油16.79L、Bridgeは`planned_entry_lap=21`との差`-6`を記録したが、
active Plan Aを取消/再計算しなかった。続くペナルティpit（lap 16、給油0L、93.5秒）まで同じPlan Aの
実行として記録した。lap 21には燃料18.14L・完走必要9.98L・余裕8.16L=`safe`にもかかわらず、
残った旧Planで「この周でピット、給油18L」を実発話した。これはGate 10の「ピット指示で事実と異なる断定」に該当する。

「ピットウィンド湧いてる？」はローカルrouterのfuel-window表現に`ピットウィンド`が無くunhandled→
`unresolved_operational`へ落ちた。ブラックフラッグはSDKの`SessionFlags` bit `0x00010000`で取得可能だが、
Bridgeは`0xC000`の黄旗だけを処理し、raw値の記録・black flagのstate化・Desktopへの配信・会話/Plan取消への接続が無い。
したがって「テレメトリに来ていない」は誤りで、未実装の経路をno-dataとして返した。exactのbit値はログへ出していないため、
当該瞬間のbit立上がりは後追い確認不能。

デブリーフは、incidentsがnullでない全レースで固定の「一番危なかった接触は…」を選ぶ`pddp.js`の分岐が、
通常の質問ローテーションより先に動く。今回の戦略失敗・ペナルティ・Driver訂正は選択対象にならず、同じテーマを繰り返す。

**Build 302はGate 8不合格、P0/P1未解消。公開物の差替えは独断で行わない。** YujiがGOするまで
`desktop-latest`のBuild 301再公開などのrollbackは実施しない。次の実装はMD #10を単独で進めず、
本ログの一本の経路（ウィンド質問→早期pit申告/理由→pit実行→penalty→旧Plan取消→訂正→debrief）を
入口から出力まで直して再生することを先にする。**Claude／Codexとも、個別patchより先にrace-scoped
plan lifecycleを正本として統合する方針へ合意した。** 次はCodexの状態分離・遷移表を共有MDで確定し、
コード変更・Buildへはその後に進む。詳細は`review/PITWALL_SHARED_WORKING_LOG.md`末尾。

## 2026-09-21 追記：Build 302 公開済み（Desktop）・公開後取得物の照合完了

Codex Gate 4「公開可（P0/P1=0）」＋Yuji公開GOで、`build-desktop.yml publish=true`（run `35542509895`、対象SHA `e1a7963`）を実行。
`desktop-latest`＝Build 302（Latest）。公開installer 100,199,099 bytes・SHA-256 `69E4F7C63E9D56FD2DDE46B63D59AE3589986AFC3BBEC7C4C0F7057D3CD2C83C`
を公開URLから取得して再計算し、manifest・release digest・日付版・Setup-latest・旧互換Desktop-latestの全てと一致。
公開installerを展開して`app.asar`（`8E4806A8…AC80`）・同梱Bridge（`F99E8805…EE4C`）もmanifest一致、必須18モジュール存在、
`e1a7963`ソースと一致、`buildNum 302`。公開は再ビルドのためcandidateとhashが異なる（`build-info.json`の時刻差）。
`bridge-latest`は未更新（Build 301と同じ運用）。GitHubはPrivate維持。Railway本番SHA `2522c7d`（server変更なし）。
**残り（公開後にYuji）**：Windows実機（Gate 6）、旧Buildからの更新動線、iRacing実走・SubSessionID実測（Gate 8）。
停止条件（Gate 10）に該当したら独断で差し替えず、Yujiへrollback案（Build 301再公開）を提示。詳細は共有ログ末尾。
次はMD #10（合意後の交通・燃料・rejoin安全条件崩壊に対するchange/cancel）。**以下の「公開はまだ実施していない」は古い記述（公開済み）**。

## 2026-09-20 追記：Build 302 Gate 4独立確認合格・公開はYuji判断待ち

Codexが対象SHA `e1a796369563bf9c932985bfacc26c1f5133f6c7`を独立確認し、**P0/P1=0、Gate 4は公開可**と判定した。
Desktop run `35510577284`・Bridge run `35510578616`は同一SHAで成功し、publish stepは両方skip。
取得したDesktop artifact ZIPのSHA-256は`1013A852AE34C90549B0159D164D90D0A7F4BD7B231364AB8233E4384CEEE212`、
installerは100,197,832 bytes・`4398FA3657A229298D9CC782A1E68717048B7923F4EBEC67956D4710727BC7F1`でmanifestと一致。
展開した`app.asar`と同梱Bridgeもmanifestと一致し、renderer参照ローカルJS 18/18を同梱、ソースと改行正規化後に一致した。
workflow差分はartifact縮小・保持1日の2ファイルだけで、Release添付3ファイルと公開条件は維持されている。

**Build 302の公開は未実施**。次はYujiの明示的な公開GOを受けてClaudeが`publish=true`を実行し、
公開後のGate 9（公開物の再取得・hash照合）を行う。Gate 6（Windows実機）とGate 8（iRacing実走）は公開後に確認する。
詳細な署名・検証値は`review/PITWALL_SHARED_WORKING_LOG.md`末尾「Codex Gate 4確認」を参照。

commit `2522c7d`（Build 302）・`e1a7963`（CI軽量化）push済み・Railway本番SHA一致・GitHubはPrivate維持。
`/api/chat`・`requireAdmin`・`verify-deploy`はYuji環境で全合格（Codex環境の不合格は`listen EPERM`）。
Windows Buildは、GitHub FreeのActions storage満杯＋Actions予算$0が原因で失敗していたため、Yujiがカード登録＋
予算$2（上限停止）へ変更、workflowはartifact1つ＋保持1日へ縮小して再実行し、**Desktop・Bridge両方success**。
installer 100,197,832 bytes・SHA-256 `4398FA36…C7F1`、manifest一致、必須module 18件同梱を確認。
**公開（Release更新）は未実施**。Yuji決定：**Codexの独立確認（Gate 4）を取ってから公開**。Codexへの依頼は`review/PITWALL_SHARED_WORKING_LOG.md`末尾「Claude → Codex：Build 302 Gate 4 独立確認依頼」（対象SHA・run ID・artifact・確認項目・署名欄）。**artifact保持は1日で期限は2026-09-21 12:28 UTC（JST 21:28）**。Windows実機の起動確認（Gate 6）は公開後にYuji。

## 新チャット開始指示

新しいチャットでは最初に`AGENTS.md`、本`HANDOFF.md`、
`review/PITWALL_SHARED_WORKING_LOG.md`の最新項目を確認する。Build 302はGate 4／5まで合格し、P0/P1=0。
**公開はまだ実施していない**。最初にYujiへ現在の状態を短く報告し、公開GOが明示された場合のみClaudeが
`publish=true`で公開する。公開後はGate 9で公開物のhashを照合し、その後YujiがGate 6／8を実機・実走確認する。
公開対応が終わった後、開発はMD #10（合意後の安全条件崩壊に対するchange/cancel）から再開する。

開始文：`MDチェック、引継ぎから開始。Build 302の公開判断から。`

現在の番号は固定する。

- MD #9：合格・完了。
- MD #10：次に着手。合意後の交通・燃料・rejoin安全条件崩壊に対するchange/cancel。
- 段階4：MD #10後。Position Gain・有効率。

新チャット開始だけではcommit・Build・公開を行わない。

## 次回開始点：MD #9合格。MD #10へ進む

Claudeのfallback修正をCodexが再確認し、MD #9の完成条件を満たした。

- `SubSessionID`優先、欠落時`SessionID`、両方欠落時はセッション境界で新規発行するfallbackを使用。
- 同一セッション内ではfallbackとdecision IDが安定し、別セッションでは同一signatureでも別IDになる。
- Python 62件、parser実関数、strategy wiring 34/34、playbook 45件、router 54/54、
  decision-memory 74/74、server 54/54、round-trip 85/85、提案合意134/134、`git diff --check`合格。
- Codex独立検査で異なるfallback IDの2提案をdecision memoryへ順に投入し、2件として保存された。
  一方を`success`、他方を`traffic_failure`へ採点しても結果は混在しなかった。

よってMD #9は完了。次はMD #10として、Driver合意後に交通・燃料・rejoin安全条件が崩れた際、
旧Planを黙って維持せず、別decision IDのchange/cancel提案としてLuna→Driverの合意経路へ戻す。
段階4（Position Gain・有効率）はMD #10後。commit・Build・公開GOなし。

## 次回開始点：MD #9はfallbackのレース境界1件だけ差戻し

Claudeのレース固有ID実装をCodexが確認した。次は合格。

- WeekendInfoの`SubSessionID`／`SessionID`をparseできる。
- `SubSessionID`優先、欠落時`SessionID`の順でsemantic decision IDへ含める。
- 同一公式race instance＋同一signatureは同じID、異なる公式race instanceでは別IDになる。
- Python 59件、parser実関数、strategy wiring 34/34、decision-memory 74/74、server 54/54、
  round-trip 85/85、提案合意134/134、`git diff --check`は合格。

ただし両方欠落した時の`_BRIDGE_PROCESS_INSTANCE_ID`はモジュールロード時に1回だけ生成され、
**レース境界で更新されない**。同じBridge起動中にrace A→race Bへ移って同じPlan条件が再現すると、
`resolve_race_instance_id({})`は両方で同じ`proc:<uuid>`を返し、decision IDも同一になることを本番関数で再現した。
現テストは「fallbackが同一プロセス内で安定する」ことだけを固定しており、別レース分離を検証していない。

**最後の修正条件**：fallbackをBridgeプロセス単位ではなく、検出可能なiRacing接続／週末の開始境界ごとに
発行する`race_instance_id`へ変更する。同じレース内の再計算・再配送では維持し、次のレース開始時には必ず
更新する。公式`SubSessionID`／`SessionID`経路は維持する。テストはID欠落状態でrace A→race B境界を通し、
同一signatureでも別decision ID、同一race内では同じdecision ID、decision memoryへ2件保存されoutcomeが
混ざらないところまで固定する。

`preflight.sh`は今回もローカル環境差により`/api/chat`、`requireAdmin`、`verify-deploy`で不合格。
今回変更した戦略ID関連の個別検査は上記のとおり合格しているが、出荷可とは判定しない。

MD #9のまま修正。MD #10、段階4、commit・Build・公開へは進まない。

## 次回開始点：MD #9は残り1件。内容hashは合格、別レース衝突を直す

Claudeの最新修正をCodexが本番helperと関連テストで再確認した。

- 同じsnapshot／lapでPlan Bのpace条件だけ0.8→0.35へ変えると、signatureとdecision IDは両方変わる。
- 同じ内容を再生成すると同じdecision IDを維持する。
- round-trip 85/85、Python 54/54、strategy wiring 34/34、提案合意134/134、playbook 45件、
  router 54/54、decision-memory tunnel 74/74、`git diff --check`は合格。

したがって、前回の直接差戻し「異なるcanonical actionable signatureへ異なるdecision ID」は合格。
ただし、semantic IDの永続利用を追ったところ、**別レースの同一内容が同じIDへ衝突するP1**が残る。

- 現在のIDは`<evidence_snapshot_id>:decision-lap:<lap>:sig-<hash12>`。
- `evidence_snapshot_id`は`recalc:<reason>:<session_num>:<lap>`で、`session_num`は週末内のPractice／Qualify／Race番号。
  別レースでも同じ値を取り得る。
- 内容hashも同条件なら同じなので、別レース・同じ周・同じPlan条件ではdecision ID全体が一致する。
- Desktop台帳は`find(... decision_id)`で既存レコードを`already_open`として新規作成せず、サーバー正本も
  `PRIMARY KEY (owner_key, decision_id)`＋upsertで同一レコードへ統合する。結果として後のレースの提案・実行・
  outcomeが過去レースと混ざるか、新しい判断が記録されない。

**最後の修正条件**：semantic decision IDへ、同一レース中は安定し別レースでは必ず異なる権威ある
`race_instance_id`を含める。第一候補はiRacing SessionInfoの`SubSessionID`（必要なら`SessionID`＋
`SessionNum`）。現parserはSubSessionIDをまだ取得していないため、WeekendInfoから取得してBridgeの
decision生成まで配線する。同一レース・同一signatureの再配送では同じdecision ID、別レース・同一signature
では異なるdecision IDでなければならない。`usageSessionId`はDesktop再接続で変わり得るコスト計測用IDなので
正本には使わない。

回帰テストに最低限、(1)同一race instance＋同一signature→同一ID、(2)異なるrace instance＋同一signature→
別ID、(3)両方をdecision memoryへ順に入れると2件保存され各outcomeが分離される、を追加する。

MD #9のまま修正。MD #10、段階4、commit・Build・公開へはまだ進まない。

## 次回開始点：MD #9は残り1件。dispatch修正は合格、semantic decision IDを直す

Claude修正後のround-trip 85/85、Python 52/52、提案合意134/134、playbook 45件、router 54/54、
`git diff --check`は合格。前回のDesktop出口2件は修正済みと判定する。

- dedupe Setとspeech `dedupeKey`は`dispatch_id`基準になり、新dispatchを受理する。
- 古いack／古いterminal outcomeは、現在trackingのdispatch IDが一致する場合だけMapを削除する。
- conditions照合とBridge側の古いattempt遮断も引き続き合格。

ただし、前回の完成条件1「canonical actionable signatureが変われば別decision ID」は未実装。
本番helperで同じreason／session／lap、Plan Bのpace条件だけ0.8→0.35へ変えた2提案を生成した結果：

- `decision_id`：両方とも`recalc:driver_recalc_request:1:7:decision-lap:7`（同一）
- `conditions`：0.8と0.35（異なる）
- `plan_actionable_signature()`：異なる

`dispatch_id`は各配送試行の識別子であり、同じrecommendationの再配送でも変わる。一方`decision_id`は
pit entry、pit cycle outcome、summary、学習記録を貫くsemantic結合キーである。異なる根拠の判断が同じ
decision IDになると、結果と学習が別判断へ混ざるため、dispatch IDでは代用できない。

**最後の修正条件**：Plan、target/add/set fuel、evidence、正規化conditionsを含むcanonical signatureから
安定したrecommendation IDを生成する。signatureが異なればdecision IDは必ず異なり、同一signatureの
再配送だけdecision IDを維持してdispatch IDを変える。Python本番helperで上記0.8／0.35が別decision ID、
同一signatureの再配送が同じdecision IDとなる検査を追加する。

MD #9のまま修正。MD #10、段階4、commit・Build・公開へはまだ進まない。

## 次回開始点：MD #9はあとDesktop identity出口2件。公称81件は合格

Claude修正後のround-trip 81/81、Python 52/52、提案合意134/134、playbook 45件、router 54/54、
`git diff --check`は合格。Plan別conditions照合と、Bridgeの`dispatch_id`による古いdelivery／responseの
fail-closed化は合格した。ただし、追加した製品順序の反例で次の2件を再現した。

1. **新しいrecommendationがDesktopで黙って消える。** 同じdecision ID・新しいdispatch IDでconditionsだけ
   変わった新提案#2を、旧提案#1がTTS待機中に受けると、`strategyPlaybookDecisionKeys.has(decisionId)`で
   即returnする。#2はqueueへ入らず、hold/delivery結果もBridgeへ返らない。旧#1は最新conditionsとの
   precheckで落ち、Bridgeでは#2が`inflight`のまま永久に固まる。
2. **古いresponse ackが現在の追跡を消す。** `handleStrategyDecisionAck()`はoutboxをdispatch IDで正しく
   削除した後、`bridgeStrategyDecisions.delete(decisionId)`を無条件実行する。追跡Mapが#2を指す時に
   遅延した#1 ackを受けると、#2の追跡まで消え、その後のDriver応答をBridgeへ返せない。

原因は、前回必須としたrecommendation identity一意化が未実装で、DesktopのSet／Mapもdecision IDキーの
ままなこと。snapshot IDは依然`recalc:<reason>:<session>:<lap>`、decision IDもそこから作るため、
同じ理由・同じ周の条件変更で衝突する。

**残る修正条件**：

- conditionsを含むcanonical actionable signatureが変われば必ず別decision IDとなるよう、snapshotへ
  monotonic recalculation revisionを入れるかsignature hashをdecision IDへ入れる。
- Desktopの配送dedupeは`dispatch_id`を単位にする。新dispatchをdecision ID一致だけで黙って捨てない。
- `handleStrategyDecisionAck()`は、現在のtracking entryの`dispatchId`がackのdispatch IDと一致する時だけ
  trackingを削除する。古いackは古いoutbox entryだけを終端させる。
- 上記2反例と、同一理由・同一周でconditionsが変わればdecision IDも変わる検査を追加する。

MD #9のまま修正。MD #10、段階4、commit・Build・公開へはまだ進まない。

## 次回開始点：MD #9再確認でもP1-1／P1-4を差戻し。IDを二層に分ける

Claude修正後の公称検査はround-trip 65/65、Python 48/48、提案合意134/134、playbook 45件、
router 54/54、`git diff --check`合格。しかし次の2反例が本番関数で再現した。

1. **古いdelivery失敗が、同じdecision IDで再配送された新しい提案を解除する。**
   `apply_proposal_delivery()`でattempt 1の`dropped_before_audible`を適用してreleaseした後、同じ
   session＋decision IDのattempt 2をpendingとして開き、attempt 1の報告を再送すると、attempt 2も
   `released`になった。現行outbox／pending／ackにはdelivery attempt IDがなく、両者を区別できない。
   「失敗後に同じdecision IDを再配送できる」というMD #9の契約と衝突する。
2. **Plan別`conditions`はまだ照合されていない。** `strategyOptionsSupportProposal()`が比較するのは
   selected plan、snapshot ID、target/add/set fuelだけ。Bのpace優位・fuel window・rejoin条件を
   変えても、他の値が同じなら古い音声が再生された。さらにsnapshot IDは現在
   `recalc:<reason>:<session>:<lap>`、decision IDはそれ＋decision lapなので、同じ理由・同じ周で
   再計算すると条件が変わってもIDが衝突し得る。snapshot一致だけではconditions一致の代用にならない。

**修正条件**：

- recommendation identity：Bridgeのcanonical actionable signature（Plan、target/add/set fuel、
  evidence snapshot、正規化conditions）が変われば必ず別decision IDになるよう、再計算revisionまたは
  signature hashをIDへ含める。同じdecision IDを使えるのは全signatureが同じ再配送だけ。
- delivery identity：同じrecommendationの再配送ごとに新しい`delivery_attempt_id`をBridgeで発行し、
  proposal event、Desktop outbox/report、Bridge pending照合、ackの全てで運ぶ。古いattemptのreport/ackは
  新attemptを解除せず、outboxから新attemptを削除しない。
- Desktop precheck：Bridgeの`plan_conditions_from_options()`と同じPlan別定義で`conditions`を正規化し、
  decision planとcurrent optionsを受信時・配信直前の両方でfail-closed比較する。
- 回帰反例：attempt 1 release→同じdecision IDのattempt 2→attempt 1再送でもattempt 2維持、および
  同じsnapshot/target/fuelでconditionsだけ変えた場合に発話しないことを本番関数で固定する。

delivery outbox＋ack自体、権威欠落・selected plan・snapshot driftのfail-closed化は合格。
MD #9のまま再修正し、MD #10へはまだ進まない。commit・Build・公開GOなし。

## 次回開始点：MD #9は部分合格。P1-1とP1-4を同じ番号のまま修正

CodexがClaudeの公称テストを再実行し、round-trip 49/49、Python 46/46、提案合意134/134、
playbook 45件、router 54/54、`git diff --check`合格を確認した。ただし追加した本番コード反例で、
次の4ケースがすべて再現したため、MD #9はまだ完了ではない。

1. socket切断中の`sendStrategyDecisionDelivery(..., 'audible_interrupted')`は送信も保存もされず、
   Bridgeを`inflight`のまま残す。
2. current telemetryに`strategy_options`が無くても`bridgeProposalStillCurrent()`が`true`を返し、
   提案を再生候補へ通す（fail-open）。
3. current `strategy_options.selected_plan='A'`でも、残っている`plan_b`のtarget/fuelが一致すれば
   古いB提案を通す。
4. `evidence_snapshot_id`が旧世代でもtarget/add/set fuelが同じなら通す。Bridge側がMD #6で
   signatureへ追加した`evidence_snapshot_id`とPlan別`conditions`をDesktopが照合していない。

**合格した項目**：P1-2の実中断順序、P1-3のdecision response outbox＋Bridge ack、P1-4のうち
JS独自発話・独自pending・独自decision IDの停止。

**差戻し2件**：

- P1-1：deliveryにも永続outboxとBridge ackを設ける。socket closed／send throw／ack消失でも
  `audible`またはterminal failureをsession＋decision ID付きで再送でき、Bridge側は重複を冪等処理する。
- P1-4：precheckをfail-closedにする。current `strategy_options`欠落時はholdし、少なくとも
  `selected_plan`、`snapshot_id == decision_plan.evidence_snapshot_id`、Plan別`conditions`、
  target/add/set fuelを同じcanonical signatureで照合する。受信時と配信直前の両方に反例テストを置く。

修正報告と再確認は**MD #9のまま**行う。MD #10（合意後のchange/cancel）へはまだ進まない。
wire型`type:'radio'`はDesktopで専用分岐され`injectRadio`へ流れないことを今回確認済みで、MD #9の
差戻しには含めない。commit・Build・公開GOなし。

## 次回開始点：MD #9再々差戻し（fallbackがBridgeプロセス単位）を修正完了。再確認待ち

`resolve_race_instance_id()`のフォールバック（SubSessionID/SessionID両方欠落時）が
**bridgeプロセスの起動ごとに一意な定数**だったため、同じプロセスを起動したまま別レースへ
移ってもフォールバック値が変わらず、decision_idが衝突する反例をCodexが再現した。

フォールバックの発行元を「プロセス起動時1回」から「`_session_scoped_reset_values()`が
セッション境界（SessionNum変更・signature変更）のたびに新しく発行」へ移した——
`active_decision_id`等の既存の他の全セッション限定状態と同じ規律。`resolve_race_instance_id()`
はモジュール定数の代わりに呼び出し側が渡す`fallback_id`を使う。

検査：Python 59→**62件**（fallback値の違いで別ID・`_session_scoped_reset_values()`が
呼ぶたび別fallbackを発行・同一プロセス内の別レース間でdecision_idが別になることをend-to-endで
固定）。`preflight.sh`✅出荷可、wiring-lint 45/45未配線0、`git diff --check`合格。**未commit**。

残件：①wire型は`type:'radio'`のまま ②MD #10未着手 ③実走での`SubSessionID`実測確認は未実施。
commit・Build・公開GOなし。

## 前回：MD #9最後の1件（レース固有ID未含有）を実装（上記のfallback欠陥を修正済み）

`decision_id`は内容（conditions等）を反映するようになったが、`evidence_snapshot_id`自体は
週末内のPractice/Qualify/Race番号でしかなく、**別レース**でも同じ値を取り得た。同じ周・同じ
Plan条件が別レースで再現すると台帳・サーバー正本が別レースの判断・結果を混ぜてしまう
（Codex実測で確認）。

`irsdk-bridge/bridge.py`：`parse_session_info()`にWeekendInfoの`SubSessionID`/`SessionID`抽出を
追加、新規`resolve_race_instance_id(info)`（SubSessionID優先→SessionIDフォールバック→
プロセス起動ID）を`build_strategy_decision()`へ渡し、`decision_id`の先頭に含めた：
`'<race_instance_id>:<evidence_snapshot_id>:decision-lap:<lap>:sig-<hash12>'`。

検査：`tests_session_info_parser.py`（実YAML形式でSubSessionID/SessionID抽出を固定）、
Python 54→**59件**（別レース同一内容→別ID／同一レース同一内容→同一IDの両方を固定）、
`preflight.sh`✅出荷可、wiring-lint 45/45未配線0、`git diff --check`合格。**未commit**。

残件：①wire型は`type:'radio'`のまま ②MD #10未着手 ③実走での`SubSessionID`実測確認は未実施
（フィールド名・位置はコミュニティ資料ベース）。commit・Build・公開GOなし。

## 前回：MD #9残件（decision_idが内容を見ない生成方法だった）を修正（上記でレース固有ID追加）

`dispatch_id`（配送試行）は前回直したが、`decision_id`自体の生成方法は直っていなかった。
`decide_at_plan_a()`は`<snapshot_id>:decision-lap:<lap>`という内容を見ない文字列を早期に
割り当てており、決定ロックが拒否済みsignature抑止で毎frame再実行される間、`battle_context`の
変化で`conditions`が変わってもsnapshot_id/lapが同じなら`decision_id`は同一のままだった
（Codex実測で確認）。

`build_strategy_decision()`が最終content（`plan_actionable_signature()`と同じ6要素）を
組み立てた後、そのSHA1ハッシュから`decision_id`を導出するよう変更——同じ内容なら同じID、
内容が変われば必ず別IDになる。`dispatch_id`（配送試行の識別）とは完全に独立した関心事として分離。

検査：Python 52→**54件**、wiring静的検査34/34（新生成コードへ更新）、`preflight.sh`✅出荷可、
wiring-lint 45/45未配線0、`git diff --check`合格。**未commit**。

残件：①wire型は`type:'radio'`のまま ②MD #10未着手。commit・Build・公開GOなし。

## 前回：MD #9再差戻し（dispatch_id未浸透）を修正（上記の残件を反映済み）

前回`dispatch_id`を新設した際、WS層（応答／配送outboxとBridge側照合）にしか通さず、**受信の入口
そのもの**（dedupe・speech dedupeKey・ack時の追跡Map削除）が`decision_id`基準のまま残っていた。
Codex指摘4件は全て正しかった。

`dispatch_id`（`<decision_id>#<連番>`、既に一意）をこの提案インスタンスの唯一の識別子とし、
dedupe／speech dedupeKey／ack時の追跡Map削除の3箇所を全て揃えた。ack削除は「現在の追跡値の
dispatch_idと一致する時だけ」に変更（旧dispatchへの遅延ackが新しいdispatchの追跡を消せないように）。

検査：round-trip 81→**85件**（旧掃除アサーションは形式不一致で実は無意味だったため`dispatch_id`
基準へ修正、加えて新規3反例）。`preflight.sh`✅出荷可、wiring-lint 45/45未配線0、
`git diff --check`合格。**未commit**。

残件：①wire型は`type:'radio'`のまま ②MD #10未着手。commit・Build・公開GOなし。

## 前回：MD #9チェック追加反例2件を修正（上記の再差戻しを反映済み）

1. **古い配送失敗通知が新しい提案まで解除する**（実際にローカル再現してから着手）——
   `decision_id`は再提案で同一になり得るため、Bridgeがdispatchごとに発行する`dispatch_id`
   （`<decision_id>#<連番>`）を新設。配送結果・Driver応答の両方でfail-closedに一致を要求し、
   outboxのキーにも使う。
2. **Plan別`conditions`が未照合**——`planConditionsFromOptions()`／`sameProposalConditions()`を
   新設し、Bridgeのsignatureが含むPlan別条件（B:fuel window・pace優位・rejoin／C:conditions_met）
   の一致もfail-closedで要求する。

検査：round-trip 65→**81件**、Python 48→**52件**、提案合意134/134、`preflight.sh`✅出荷可、
wiring-lint 45/45未配線0、`git diff --check`合格。**未commit**。

残件：①wire型は`type:'radio'`のまま ②MD #10未着手。commit・Build・公開GOなし。

## 前回：MD #9チェックの差戻し2件を修正（上記の追加反例2件を反映済み）

1. **配送結果が切断中に消失し、Bridgeが固まる**（前回こちらから申告した残件）——配送にも応答と
   同じoutbox規律を与えた。`strategyDeliveryOutbox`（`<session>|<decision_id>|<outcome>`）は
   audible→中断の二連も順序どおり保持し、`onopen`でflush、Bridgeの`strategy_delivery_ack`で初めて
   捨てる。Bridgeは報告outcomeをechoしてack（stale/no_matchでもack）。再送は冪等で、遅延報告は
   decision ID照合で新しい提案を壊さない。
2. **same-frame判定が不完全で古い提案を通す**——`strategyOptionsSupportProposal()`へ分離し全て
   fail-closedへ。①`strategy_options`欠落（旧実装はtrueを返していた）②選択Plan変更（B→A/C）
   ③根拠snapshot変更（`evidence_snapshot_id`未照合）をすべてholdにした。判定の出所も、受信時は
   **event同梱の`strategy_options`**（その frame の権威）、配信直前は**最新telemetry**に正した
   （Bridgeは提案broadcastの後にtelemetryを送るため、受信時の`lastTelemetry`は1frame古い）。

検査：round-trip 49→**65件**、Python 46→**48件**、提案合意134/134、`preflight.sh`✅出荷可、
wiring-lint 43/43未配線0、`git diff --check`合格。**未commit**。

残件：①Bridge→Desktopのwire型は`type:'radio'`のまま ②MD #10は未着手。commit・Build・公開GOなし。

## 前回：MD #9の4件を実装（上記の差戻し2件を反映済み）

下の「番号固定」で定義された4件をすべて実装した（詳細は`review/PITWALL_SHARED_WORKING_LOG.md`末尾）。

1. **配送ライフサイクル**：Bridgeに`apply_proposal_delivery()`と新cmd`strategy_decision_delivery`を
   新設。`DISPATCHED`は`inflight`止まりで、Desktopの`audible` ackで初めて提示済みを確定する。
   drop／中断／voice offではpending・sentを解除して再武装する（拒否記憶は汚さない）。Desktopは
   `finalizeUtterance()`に全終端で呼ばれる`onDelivery`を追加し、失敗時はdedupe Set／追跡Mapも掃除して
   同一IDを再配送可能にした。受信時点のhold（race modeでない・session不一致・根拠不一致）も必ず返す。
2. **中断テスト**：再生開始→`spoken`→`onSpoken`→`stopCurrentAudio()`→`audible_interrupted`→
   再配送可能、までを本番関数で1本実行する形へ作り替えた。発話前の反例（precheck stale・voice off・
   queue overflow）も別ケースで固定。
3. **応答のoutbox化**：`strategyResponseOutbox`（`<session>|<decision_id>`）へ保持し、送信成功ではなく
   Bridgeの`strategy_decision_ack`で捨てる。再接続（`onopen`）でflush、送信例外も保持。Bridgeは
   accepted/declined/stale/no_matchの全てでackを返し、重複応答は冪等にno_match。
4. **単一canonical＋same-frame precheck**：`evaluateLiveStrategySwitch()`から自前decision ID発行・発話・
   proposePlanを削除（死んだコードは削除）。`liveStrategyValidation`経由でBridge推薦をallow/hold/dropする
   検証だけにした。`bridgeProposalStillCurrent()`が受信時と配信直前の両方で同一frameの`strategy_options`と
   照合する。

検査：round-trip 13→**49件**、Python 36→**46件**、提案合意134/134、playbook 45件、
`preflight.sh`「✅出荷可」、wiring-lint 39/39未配線0、`git diff --check`合格。**未commit**。

**こちらから申告する残件**：①配送結果の送信はsocket断では届かない（outboxを持つのは応答側だけ。
同じ規律を配送にも与えるべきかは判断を仰ぐ）②Bridge→Desktopのwire型は`type:'radio'`のまま
（Desktopで`injectRadio`へ渡さない遮断は維持）③MD #10は未着手。commit・Build・公開GOなし。

## 番号固定：次の実装はMD #9、対象はDesktop失敗経路のP1 4件（上記で実装完了）

ClaudeとCodexで番号がずれたため、ここを正本として固定する。**Claudeが次に着手・報告する実装を
「MD #9」**と呼び、その後Yujiが依頼する独立確認も「MD #9チェック」とする。MD #9のscopeは次の4件だけ。

1. 発話前drop／precheck stale／voice off／発話後interruptをBridgeへ返し、Bridgeの
   `pending_strategy_proposal`／sent状態を解除または再武装する。lifecycleを
   `dispatched/inflight → audible → accepted|declined`として明示する。
2. 中断テストを実製品順序`spoken → onSpoken → stopCurrentAudio → audible_interrupted`で実行し、
   Desktop pending、dedupe Set、tracking Map、Bridge状態が片付いて同一IDを再配送できることを固定する。
3. `sendStrategyDecisionResponse()`をoutbox化する。socket closed／send throwでも結果を失わず、再接続後に
   session＋decision ID付きで一度だけ配送する。Bridge側は重複responseを冪等に扱う。
4. JS独自の`playbook:<session>:<lap>:B|C`提案生成を停止し、Bridge canonical decision IDだけを使う。
   JSは最新frameのtelemetry／recommendation signatureを照合するallow/hold/drop precheckに限定する。

**MD #9に含めないもの**：合意後に交通・燃料・rejoin安全条件が崩れた場合の別ID change/cancel機構。
これはMD #9の4件が独立確認で合格した後の**MD #10**とする。段階4（Position Gain・有効率）はさらに後。
commit・Build・公開GOなし。

## 次回開始点：MD #8は部分合格。正常往復は接続、失敗時のBridge再武装を差戻し

Codex独立確認で、MD #7の2件（新推薦側のevidence/conditions signature配線、session_num
fail-closed）は合格。Bridge提案をDesktopが`injectRadio`から分離し、`onSpoken`後だけDesktopの
pendingを作り、実router／LLM judgeの確定結果をsession＋decision ID付きでBridgeへ送る正常系も
接続された。36/36、round-trip 13/13、提案合意134/134、router 54/54、`git diff --check`は合格。

ただし、失敗時はまだBridgeとDesktopの状態が分裂する。

1. BridgeはeventのWebSocket `DISPATCHED`だけで`strategy_options_proposal_sent=True`にし、
   `pending_strategy_proposal`を開く。Desktopで発話前drop／stale precheck／voice off、または発話開始後
   `audible_interrupted`になってもBridgeへ結果を返さない。同じ根拠の再計算ではMD #7修正によりpendingを
   正しく維持するため、自然には解除されず、再提案もできない。
2. Desktopは`strategyPlaybookDecisionKeys`へ発話前にIDを追加し、drop／interruptで削除しない。
   `bridgeStrategyDecisions`も発話後中断で残る。Bridgeが同じIDを再送してもDesktopが無視する。
3. 新規round-tripテストの「中断」は`finalizeUtterance(item,'interrupted')`を発話成立前に呼ぶだけで、
   実製品の`spoken → stopCurrentAudio() → audible_interrupted → onAudibleInterrupted`を通していない。
   よって今回の固着を検出できないfalse green。
4. `sendStrategyDecisionResponse()`は追跡Mapを削除してからsocketを確認する。合意時にsocketが閉じていれば
   結果を永久に失い、Bridge pendingが残る。送信例外にも再送outbox／ackがない。
5. Bridge提案の再生前precheckはDesktop strategy revisionだけで、現在telemetryのsnapshot／根拠signatureを
   照合しない。並存する`evaluateLiveStrategySwitch()`は依然`playbook:*`という別IDを生成するため、
   Bridge canonical推薦のvalidation/hold専用にはなっていない。

次はBridge proposal lifecycleを`dispatched/inflight → audible → accepted|declined`として明示する。
Desktopは`onSpoken`、drop、interruptを同じdecision/sessionへ通知し、Bridgeはaudible前に「提示済み」と
確定しない。失敗時はpending／sentを解除して条件がまだ有効なら再送できるようにする。Desktop側のdedupe
ID／tracking Mapもterminal outcomeで必ず掃除する。decision responseはsocket不通時に削除せずoutboxへ保持し、
再接続後に同じIDを一度だけ届け、Bridge側で冪等に処理する。precheckは現在のcanonical recommendation
signatureまで照合し、JS側評価は別IDの提案生成をやめてBridge推薦のhold/allowだけを返す。

合意後の安全条件崩壊change/cancelも未実装。段階4は保留。commit・Build・公開GOなし。

**preflight環境差の切り分け済み**：Codex側で落ちた`/api/chat`と`requireAdmin`は、それぞれ
localhost:3901／4101の`listen EPERM`、`verify-deploy`は同じ制約でスタブサーバーを起動できなかった。
Codexサンドボックスのローカル待受禁止が原因で、製品コードの不合格ではない。Claude通常環境の全緑とは
矛盾しない。ただしCodex環境ではこの3ゲートを独立実行できない、という検証上の留保は残す。

## 次回開始点：MD #7の残るP1 2件を修正完了。次は最優先＝Desktop全経路の配線

Claudeが2件を修正した（`irsdk-bridge/bridge.py`）。

1. `sync_desktop_strategy_options()`の新推薦側signatureが`evidence_snapshot_id`と
   `conditions`を常にNoneのまま組み立てていたため、pending側の実signatureと必ず
   不一致になり、毎回の再計算でpendingが無条件破棄されていた欠陥を修正。
   `plan_conditions_from_options()`（既存・`build_strategy_decision()`と同じ組み立て）
   を新推薦側にも使い、同じ根拠なら必ず同じsignatureになるようにした。
2. `resolve_strategy_proposal()`のsession境界判定をfail-closed化。以前は
   pending／response どちらかが`session_num`を省略すると後方互換で
   decision_id一致だけで'accepted'まで通していたが、この提案→合意コマンドでは
   Desktop側実装が既にsession_numを運ぶ契約のため、欠落・型不正・不一致は
   すべて'stale'として拒否する（`isinstance(int)`かつ一致の時だけ次判定へ進む）。

**副産物（テスト自体の欠陥を発見・修正）**：`tests_bridge_strategy_options_recalc_sync.py`の
`test_same_target_and_fuel_but_different_evidence_snapshot_is_a_new_signature`は
`battle_context`を変えてPlan Bのpace優位証拠が動くことを期待していたが、
`battle_context`はPlan C専用（`derive_plan_c_live_conditions`）でPlan B/A経路
(`decide_at_plan_a`)は読まない——実際は`decide_plan_at_target()`の
`relative_pace_advantage_s`引数がBの証拠を決める。false greenのまま放置されていた
（この引数を変えず`battle_context`だけ変えていたため実質何も検証していなかった）。
検証対象の引数を差し替えて修正。

検査：`tests_bridge_strategy_options_recalc_sync.py` 35→**36件**（実行）。`preflight.sh`
「✅出荷可」、`wiring-lint`34/34未配線0。commit・Build・公開GOなし。

次は上記2件が直ったので、HANDOFFが繰り返し指摘してきた最優先＝**Desktop全経路
（JS側）**へ進む。Bridge推薦をcanonical data eventで渡し、Desktopの単一音声経路の
`onSpoken`でpending成立、明示yes/noとLLM judgeの適用結果だけをsession＋ID付きで
exactly once返す。drop/interrupted/staleでは返さない。合意後の交通・燃料・rejoin
崩壊は別IDのchange/cancel proposalとする。段階4は保留。

## 前回開始点：MD #7は部分合格。拡張signatureの比較側とsession fail-closedを修正する（上記で対応済み）

Codex独立確認で、提案時点の`options_snapshot`を`copy.deepcopy()`で凍結し、accepted時の
Session Race Stateをlive `strategy_options`ではなく凍結snapshotから登録する修正は合格。
`evidence_snapshot_id`とPlan別`conditions`がproposal record／signatureへ入ったこと、WebSocket
handlerとresponse queueが`session_num`を運ぶことも確認した。35/35、73/73、134/134、
`git diff --check`は合格。

ただし次のP1を差し戻す。

1. `sync_desktop_strategy_options()`の新推薦側signatureは依然としてPlan、target、add/set fuelだけで
   作られ、`evidence_snapshot_id`と`conditions`が常に`None`。一方、実際のpending側には両方があるため、
   **同じsnapshot・同じ条件でも再計算後に必ず不一致となりpendingが破棄される**。既存35テストは、
   拡張fieldを持つ実pendingをこの本番同期関数へ通していないため検出できていない。新推薦からも同じ
   canonical proposal/signatureを構築し、同一根拠なら維持、根拠変更ならstale化する実関数テストを追加する。
2. `resolve_strategy_proposal()`はpendingにsession_numがあってもresponse側が省略するとdecision IDだけで
   acceptedにする。完成条件はsession＋ID一致であり、Desktop未対応を通す後方互換はこの新しい戦略合意
   コマンドでは危険。session欠落・型不正・不一致をすべてstale/no_matchにするfail-closedへ変更する。
3. Desktop audible成功、Desktop→Bridge応答、合意後安全崩壊のchange/cancelは未着手のまま。

次は上記1・2を直したうえで、最優先のDesktop全経路へ進む。Bridge推薦をcanonical data eventで渡し、
Desktopの単一音声経路の`onSpoken`でpending成立、明示yes/noとLLM judgeの適用結果だけをsession＋ID付きで
exactly once返す。drop/interrupted/staleでは返さない。合意後の交通・燃料・rejoin崩壊は別IDの
change/cancel proposalとする。段階4は保留。commit・Build・公開GOなし。

## 次回開始点：MD#6のsignature/session境界は完了。次は最優先＝Desktop全経路の配線

Claudeが2件を修正した。①`plan_actionable_signature()`を`evidence_snapshot_id`＋Plan別主要条件
（B:pace優位・rejoin、C:rival_pitted_first・clean_air・fuel_save_on_target・rejoin_not_worse）まで
拡張——target/fuelが同じまま根拠だけ変わった場合も別signatureとして区別する。acceptedへ昇格する
`plan_snapshot`も、応答到着までに動くlive変数ではなく`build_strategy_decision()`が提案時点で
`copy.deepcopy()`凍結した`options_snapshot`を使うよう修正。②`resolve_strategy_proposal()`へ
`session_num`比較を追加、websocketハンドラ・queue関数も運ぶよう変更（session境界を跨いだ遅延応答を
拒否・後方互換維持）。新規`tests_bridge_strategy_options_recalc_sync.py` 29→**35件**（実行）。
`preflight.sh`「✅出荷可」、wiring-lint 32/32未配線0。

**次回最優先（3ラウンド連続でCodexが指摘）**：Bridge側はDesktopのTTS再生成功を確認せず
（`DISPATCHED`＝WebSocketキュー投入をaudible成功と混同）、Desktop側は`strategy_decision_response`の
送信実装が0件——B/Cが実際にacceptedへ昇格することはまだ無い。Codexの設計方針：Bridgeは推薦を
**データイベント**として渡すだけにし、Desktopがsame-frame precheck後の単一音声経路で発話、
`onSpoken`で成立・drop/interruptedで不成立にする。**JS自前の`evaluateSwitch()`は競合エンジンでなく
Bridge推薦を検証・holdする配信precheckへ作り替える**。これを解かない限りitem 6（Bridge→Desktop→
audible→Driver応答→Bridge active→box call→pit outcome/summaryの製品経路テスト）は書けない。

**未着手（次々段）**：合意後の実行安全条件崩壊（交通・燃料・rejoin）への対応——別IDのchange/cancel
提案でDriver再合意を経る機構。新規のproposal種別に近く未着手。

## 前回開始点：MD #6は部分合格。Desktop全経路と提案同一性を完成させる（signature/session境界は上記で対応済み）

Codex独立確認では、MD #5で差し戻したPython側3件のうち、`recommended_plan`と合意済み
`active_plan`の分離、同じPlanでもtarget/add/set fuelが変わった時のpending破棄、拒否した同一
signatureの反復抑止は本番poll loopに接続され、実行テストにも合格した。ただし、これで
段階1〜3完成とはしない。

**残るP1**：

1. Bridgeはまだ`strategy_plan_proposal`を`type:'radio'`で直接broadcastし、WebSocketキューへの
   `DISPATCHED`を発話成功として`strategy_options_proposal_sent=True`にする。Desktopの
   `onSpoken`／中断・drop結果を見ていない。
2. Desktopには`strategy_decision_response`送信実装が無い。Bridge受信側だけが存在するため、
   B/Cは実製品経路でaccepted activeへ昇格せず、box callへ到達しない。
3. `plan_actionable_signature()`はPlan、target lap、add/set fuelだけで、要求済みの証拠snapshot／
   主要条件を含まない。同じ実行値のまま交通、rejoin、pace、fuel-save根拠が変わっても古いpendingが
   生き残り、拒否記憶も必要な再提案を抑止する。accepted時の`register_active_plan()`も凍結した
   pending snapshotではなく、その時点の可変`strategy_options`を保存しており、decision IDと根拠が
   混ざり得る。
4. Desktop応答の完成条件で要求した`session_num`照合がBridge側に無い。受信handlerは
   `decision_id`と`accepted`だけをqueueし、session境界の古い応答を構造で拒否できない。
5. 合意済みactiveは推薦driftから凍結される一方、実行安全条件が崩れた時の別IDによる変更提案／
   cancelは未実装とコード自身が明記している。

次は、Bridge推薦を音声ではないcanonical data eventとしてDesktopへ渡し、same-frame precheck後の
単一音声経路で`onSpoken`成立させる。明示yes/noとLLM judgeの双方から、実際に状態遷移した結果だけを
`{cmd:'strategy_decision_response', session_num, decision_id, accepted}`として一度送る。Bridgeは
sessionとIDを照合し、accepted時は可変`strategy_options`ではなく凍結proposalのsnapshot／signatureを
active正本へ保存する。signatureには少なくともevidence snapshot IDとPlan別主要条件を含める。
Bridge推薦→Desktop発話→Driver応答→Bridge active→凍結box call→outcome/summaryを同一IDで追う
製品経路テストを追加する。段階4（Position Gain・有効率）は引き続き保留。commit・Build・公開GOなし。

## 次回開始点：MD#5の3件はBridge側で完了。残る2件はJS側の設計・実装

Claudeが3件を修正した。①`session_race_state.py`へ`recommended_plan`/`recommended_plan_snapshot`
（推薦専用）を新設、`execute_recalculation()`はこちらだけ更新——`active_plan`（合意済み）は
`build_strategy_decision()`のcommit(A)／`resolve_strategy_proposal()`のaccepted(B/C)だけが動かす。
②`plan_actionable_signature()`（Plan・対象周・給油量）でpending提案の無効化をPlan文字比較から
signature比較へ。合意済みで凍結された`active_decision_plan`はdrift対象外（凍結の意味そのもの）。
③`declined_plan_signatures`（session-scoped）で拒否済み内容を記憶し、decision-lockは提案前に
照合して沈黙する。内容が実際に変われば自動的に対象外になる。

新規`tests_bridge_strategy_options_recalc_sync.py` 21→**29件**（実行）。Codexの3反例を再現・修正確認、
回帰4件追加。既存静的検査1件も追随修正。`preflight.sh`「✅出荷可」、wiring-lint 32/32未配線0。

**未着手（次回ここから・JS側）**：Codexの指摘が設計方針を明確にした——Bridgeは推薦IDと証拠を
**データイベント**として渡すだけにし、DesktopがSame-frame precheck後に一つの音声経路で発話、
`onSpoken`で成立・dropped/interruptedで不成立にする。**JS自前の`evaluateSwitch()`は別Planを選ぶ
競合エンジンにせず、Bridge推薦を検証・holdする配信precheckへ作り替える**（前回開いていた
「JS二重決定エンジン」問題への回答）。状態機械が実際に適用した結果だけを`renderer.html`が
`strategy_decision_response`として一度だけWS送信する設計・実装がまだ無い。

## 前回開始点：MD #5差戻し — 合意前active化・同Plan drift・JS応答を修正する（3件は上記で対応済み）

ClaudeのPlan C現frame再検証、B/C pending化、合意済みPlanからのbox callは方向として合格。ただしPython側完了の
判定は差戻し。`execute_recalculation()`は今もB/C推薦だけでSession Race Stateの`active_plan`を更新する。
Codex実行反例でもDriver応答前に`state_active_before_accept='B'`を確認した。またpending Bがtarget 6／20L、
新しいB推薦がtarget 7へ変わっても、同期はPlan文字だけを比較して古いpendingを維持する。拒否を記憶しないため
同じ提案を次frameに再送できる。Bridgeの`broadcast()`成功をaudible成功としてproposal sentにしているが、
DesktopのTTS再生成功とは別である。JS側には`strategy_decision_response`送信が一件もなく、全経路は未接続。

ClaudeはSession Race Stateへrecommended snapshotとaccepted active snapshotを分け、再計算では前者だけ更新する。
pending／accepted／declinedの同一性はPlan文字ではなくdecision ID＋actionable signatureで判定し、拒否後は条件が
意味ある変化をするまで再提案しない。Bridgeはデータ推薦を一つだけDesktopへ渡し、Desktopの同一IDによる
発話成功でpendingを作る。実routerとLLM judge双方のaccepted/declined確定結果をrendererがWSへ一度だけ返し、
Bridgeが同一session／IDだけ昇格させる。発話失敗・曖昧・陳腐化・拒否ではbox callしない。段階4は保留。

## 前回開始点：MD#4のBridge側（Python）は完了・検証済み。次はDesktop側（JS）の配線

Claudeが実装した。①`derive_plan_c_live_conditions()`＋`decide_plan_at_target()`のCその場再検証
（1frame古い証拠を確定しない）②`build_strategy_decision()`（A即時commit／B・Cは`pending_strategy_proposal`
として保留）＋新設websocket cmd `strategy_decision_response`＋`resolve_strategy_proposal()`（decision_id
一致の'accepted'だけ昇格、陳腐化応答は無視）③box call blockが`strategy_options`ではなく凍結された
`active_decision_plan`を読む（pit timing/pit cycle outcomeは元々そうだった）。

新規`tests_bridge_strategy_options_recalc_sync.py` 12→**21件**（実行）。この変更でズレた既存静的検査
3件も追随修正。`preflight.sh`「✅出荷可」、wiring-lint 32/32未配線0。

**未着手（次回ここから）**：Desktop側（JS）——`session-strategy-state.js`の既存`pending_proposal`が
B/C提案を確定した時、`strategy_decision_response`をwebsocket経由でBridgeへ送り返す配線。
`local-intent-router.js`の`resolvePendingProposal`呼び出し2箇所（480・495行目）と
`renderer.html`の`applyProposalJudgeTag`は純粋な意思決定層でI/Oを持たないため、実送信は`renderer.html`
（I/Oを持つ層）側で行う必要がある——設計はまだ。

**追加で発見した設計課題（Yuji/Codex判断が必要）**：`evaluateLiveStrategySwitch`は現在**2つの独立した
決定エンジン**を持つ——JS自前の`evaluateSwitch()`（Bridgeのstrategy_optionsを読まない）が優先され、
それがnullの時だけBridgeの`authority.selected_plan`へフォールバックする。今回実装した提案→合意経路は
後者が動いた時しか機能しない。どちらを正とするかは製品判断——今回は変更せず明記に留めた。

## 前回開始点：MD #4差戻し — Cの現在証拠とdecision ID全経路を完成させる（Bridge側は上記で対応済み）

Plan Cが次frameでAへ上書きされる直接バグと、Cをbox call対象外にしていた欠陥は修正・検査合格。
しかし新`decide_plan_at_target()`は前frameの`plan_c.available=True`を現在証拠の再確認なしで確定する。
poll loopはdecision blockが再計算より先なので、コメントの「同一frameで証明済み」は誤り。clean air、
rejoin forecast、fuel-save条件が次frameで崩れてもCの無線とactive decisionを開き得る。また
`execute_recalculation()`は推薦段階でSession Race Stateの`active_plan`を更新し、Bridge radioは
Desktopのpending／Driver合意を経ず直接decisionを開く。全経路はClaude自身が未着手と明記している。

Claudeはスコープ確認を待たず、Founder確定済みの「最新判断をLunaが提案し、Driverと作戦を実行する」経路として
完成させる。Cも決定直前の現frame証拠で再検証し、推薦と合意済みPlanを分離する。同じA/B/C文字でもtarget lap、
set fuel、根拠snapshotが変われば別decisionとして扱う。Bridge発行IDをtelemetry→実router／自発提案→発話成功→
合意／不採用→Bridge active decision→box call→pit outcome/summaryまで維持し、拒否・保留・陳腐化時は実行しない。
段階4（Position Gain・有効率）はこの配線の合格後。

## 前回開始点：MD#3のCの1frame消失は修正・検証済み。Bridge↔Desktop確認往復は未着手・要スコープ確認

Claudeが修正した。decision-lock blockが毎frame`decide_at_plan_a()`（A/B専用）を無条件に呼んでいた
ことが原因で、Codex反例（after_sync=C→decision block result=A）を再現確認した上で、
`decide_plan_at_target()`という本番関数を新設。`plan_c.available is True`の時だけ既に証明済みのC証拠
をそのまま採用し、A/Bの毎frame再評価はそのまま維持。box call gateが`('A','B')`限定でCの正当なbox call
が一生出ない別欠陥も発見・修正（`('A','B','C')`へ拡張）。新規4件（計12件）を実行、修正前のロジックへ
戻すと実際に不合格になることも手動確認。この変更でズレた既存静的検査2件も追随修正。`preflight.sh`
「✅出荷可」、wiring-lint 32/32未配線0。

**未対応・要Yujiスコープ確認**：Codexが併せて要求した「recommended_plan と active/accepted_plan の分離、
BridgeのID発行→JS router/自発提案が読む→Driver合意／不採用がBridgeへ返る→box call/pit outcome/summary
は合意済みPlanだけを読む」という設計は、Bridge↔Desktop間に新しい確認往復（JSの提案→合意フローの結果を
Bridgeへ送り返す経路）を新設するsubstantialな機能追加。バグ修正の範囲を超えるため今回は着手していない
——単独で新しいクロスプロセス確認プロトコルを設計・実装するより、次にこの増分へ進む前にYujiの意向を
確認すべき規模と判断した。段階4（Position Gain・有効率）はこの一連の修正の独立確認が付くまで着手しない。

## 前々回開始点：MD #3差戻し — Cが次frameでAへ上書きされる経路を修正する（上記で対応済み）

本番共有関数`sync_desktop_strategy_options()`の抽出と、poll loop／テストが同じ関数を呼ぶ修正は合格。
ただしPlan所有は未修正。再計算A→C後、共有関数はCを反映してdecision/boxフラグをFalseへ戻すが、次frameの
decision-lockはA/B専用`decide_at_plan_a()`を再実行し、`strategy_options.selected_plan`をAへ上書きする。
Codex反例では同一のC成立入力に対して`after_sync:C`の直後、decision block resultは
`A / plan_b_undercut_conditions_unproven`になった。Cは1frameだけ見えて消え、提案・合意・実行・採点へ届かない。

Claudeは「計算推薦」と「合意済み実行Plan」を別フィールド／状態にし、box callは計算推薦ではなく合意済みPlanを
読むこと。Bridgeが生成した一つのrecommendation/decision IDをtelemetry→実router→自発提案またはDriver質問→
発話成功→Driver合意／不採用→Bridge active decision→box call→pit outcome/summaryまで保持する。CをA/B専用
decision blockへ戻さず、Cの提案「もう1周」・合意・次のbox callまで通す製品経路反例を追加する。段階4は保留。

## 前回開始点：MD#2 P1-1/P1-2は修正・検証済み、Codex確認待ち。JS側全経路トレースは未着手

Claudeが修正した。同期条件を`bridge.sync_desktop_strategy_options()`という本番の名前付き関数へ抽出し、
`poll_iracing()`とテストが同じ関数を呼ぶ（本番呼び出しを一時的に無効化してテストが実際に不合格に
なることを手動確認済み）。この関数は`strategy_options`の反映に加え、再計算後の`selected_plan`が
`active_decision_plan`の選択と異なる時だけ`strategy_options_decision_sent`/
`strategy_options_box_call_sent`をFalseへ戻し、旧Planの送信済み状態が新Planのbox call誤発火・
誤抑止を起こさないようにする。新規`tests_bridge_strategy_options_recalc_sync.py`8件
（A→B・A→C・入力不足に加え、旧decision送信済み→B、旧box call送信済み→C、同一Plan再計算での
無変化、本番配線ガードを実execute_recalculation実行で固定）。`preflight.sh`「✅出荷可」、
wiring-lint 32/32未配線0。

**未対応（Codexへ明記）**：MD#2が併せて要求した「telemetry payload→実`local-intent-router.route()`→
提案／合意状態→pit outcomeまたはsummary」というJS側を含む全経路のdecision_idトレースは未着手。
今回はbridge.py側（Python）の契約まで。次はこのJS側トレースか、Codex確認結果次第。
段階4（Position Gain・有効率）はこの修正の独立確認が付くまで着手しない。

## 前回開始点：MD #2差戻し — 本番同期を実行検査し、推薦と合意済みPlanを分離する（上記で対応済み）

MD #1の`strategy_options = _recalc_verdict['options']`という修正方向は正しい。しかし新規
`tests_bridge_strategy_options_recalc_sync.py`は本番のpoll loop／同期行を実行せず、テスト内の
`apply_fix()`で同じ代入条件を再実装している。本番の同期行を削除しても3件は合格するため、製品配線の
証明になっていない。また再計算で`strategy_options.selected_plan`だけA→B/Cへ変える一方、
`active_decision_id`、`active_decision_plan`、`strategy_options_decision_sent`、
`strategy_options_box_call_sent`は旧Planのまま残る。これにより新Bを未合意のまま旧Aの送信済み状態で
box callする、またはpit結果を旧Aとして採点する可能性がある。

Claudeは同期条件を本番関数へ抽出しpoll loopとテストが同じ関数を呼ぶようにする。さらに
「最新の計算推薦」と「Driverへ提示・合意済みの実行Plan」を別状態にすること。再計算だけで合意済みPlanや
box call対象を上書きせず、Lunaの提案が実際に発話され、必要な合意遷移を通った時だけ実行Planとdecision IDを
更新する。A→B、A→C、入力不足に加え、旧Aのbox call送信済み／未送信の各状態で誤発話・誤採点しない反例を、
本番同期関数→telemetry payload→実router→合意状態→pit outcomeの経路で固定する。段階4は引き続き保留。

## 前回開始点：MD#1差戻しは修正・検証済み、Codex独立確認待ち

Claudeが修正した。`bridge.py`の`_pending_recalculations`ループ内、`execute_recalculation()`直後で
`_recalc_verdict.get('available')`かつ`options`が辞書の時だけ`strategy_options = _recalc_verdict['options']`
を同一frameで反映（入力不足時は`reevaluate_plans()`が`previous`をそのまま返すため無変化＝更新した
ふりをしない）。新規`irsdk-bridge/tests_bridge_strategy_options_recalc_sync.py`が指定3反例
（A→B・A→C・入力不足で旧Plan維持）を実`execute_recalculation()`実行で固定し、修正適用前のロジックでは
失敗することも個別確認済み。静的検査だった`tests_bridge_recalculation_wiring.py`(75件)と合わせて
`preflight.sh`へ新規登録（従来未登録だった）。`preflight.sh`「✅出荷可」、wiring-lint 32/32未配線0、
strategy-call-routing 10/10・strategy-playbook 45/45・local-intent-router 54/54回帰なし。
Windows/iRacing実走での再計算タイミングは未検証。**Codexの独立確認待ち**——確認が付くまで段階4
（Position Gain・有効率の校正）へは進まない。詳細は`review/PITWALL_SHARED_WORKING_LOG.md`9/16末尾。

## 前々回開始点：MD #1差戻し — 再計算したA/B/CをDesktop権威へ同期する（上記で対応済み）

Claudeの「段階1〜3合格」は、Desktop内の単一推薦・質問配線・発話gateについては正しいが、Founder受入条件
「A/B/Cに必要なデータを裏で更新し続け、質問と自発提案が最新判断を読む」までは満たしていない。
`bridge.py`の`execute_recalculation()`は最新入力でA/B/Cを再構築し、`_session_race_state`の
`active_plan_snapshot`を更新する。しかし毎フレームtelemetryへ載る`strategy_options`は初回作成時にラッチされた
別オブジェクトのままで、再計算verdictの`options`が代入されない。Desktopの`evaluateStrategies()`はこの古い
`lastTelemetry.strategy_options`を権威として読むため、内部でB/Cへ変わってもAを推薦し続ける可能性がある。

Claudeは、再計算成功時に`strategy_options`を同じ新snapshotへ原子的に更新し、決定ID・box call対象・
telemetry payloadも新Planへ揃えること。Driverコールで別計算はせず、更新済みの同一権威snapshotを読む。
最低限「A→B」「A→C」「入力不足で旧Plan維持」の3反例をBridge→telemetry→実routerまで固定し、古い
`strategy_options`へ戻らないことを確認する。修正後にCodexが再確認する。未commit・未Build・未公開。

## 前回開始点：A/B/C戦略配線1〜3はClaude独立確認済み、段階4以降へ

Codex実装の段階1〜3をClaudeが独立確認した（`tests-strategy-call-routing.js`の再実行だけでなく、
`evaluateStrategies()`へ「authorityがBを選んだがdesktop側の証明が未達」という反例を自作して投入し、
①`recommended`状態の候補が同時に2つ以上出ないこと ②Bが不成立時にAへ黙って戻らず
`held_for_latest_evidence`のまま`recommendation:null`を返すこと、を実行結果で確認）。
`node tools/wiring-lint.js --base HEAD`は対象32/合格32/未配線0。`grep`で「有効率」「success_rate」
「viability」が新規コードに一つも無いことも確認——数値の捏造リスクを避ける設計どおり。
段階1〜3は独立確認合格。次は段階4（Position Gainレンジ、条件充足度の表現、結果蓄積からの校正）へ。

## 前回開始点：A/B/C戦略配線1〜3を独立確認後、数値効果と実走へ（Codex記載・上記で確認済み）

9/16、Yuji指示で戦略配線の段階1〜3を実装した。`strategy-playbook.js`が通常(A)・アンダーカット(B)・
オーバーカット(C)を同一telemetry snapshotで評価し、推薦を最大1案へ統括する。Driverの
「アンダー行ける？」「オーバーは？」「今ピット？」は`local-intent-router.js`からこの同じ評価を読み、
LLMへ再計算させず即答する。自発B/C提案も同じ統括結果を読む。BridgeがB/Cを選んでもdesktop側の
最新ペース・復帰位置の証明が揃わなければAへ勝手に戻さず、判定保留として答える。

これは未commit・未Build・未公開。新規`tests-strategy-call-routing.js` 10/10、strategy playbook 45/45、
local router 54/54、提案→合意134/134、GAP queue 71/71、実走コーパス149/149、Build 298 replay
170/170、通常環境で`./preflight.sh` **出荷可**。外部有料API呼出0。Windows/iRacing実走の発話時刻・
有用性は未確認。次はClaude独立確認後、段階4以降（Position Gainレンジ、条件充足度、結果蓄積からの
校正確率）へ進む。未校正の「有効率90%」はまだ発話しない。

## 前回開始点（9/14）：Discordのアップデートから（未着手のまま持ち越し）

Yuji指示により本日の作業はここで終了。次回は**Discordのアップデートから開始**する。
開始時に対象・現状・更新内容を確認し、その後PITWALL作業へ戻る。

本日最後に合意した未実装のスポッター仕様も保持する。レース開始後20秒間は左右コールの再発話debounceを
2秒、その後は5秒。ただし時間経過だけで同じ`Left/Right/Both`を再発話せず、`Clear`を含む状態遷移で
再武装する。異常反復を自動遮断し、ローカル合言葉「スポッター黙って」「スポッター戻して」および
状態表示`SPOTTER MUTED`を設ける。セッション切替では安全側として自動ONへ戻す。未実装・未検証。

## Codex実装：前方停止車両の警告を10秒圏へ拡大（未commit・未Build）

Yujiの実走認識どおり、前方停止車両の通常警告を5秒圏から10秒圏へ変更。単純な閾値置換では旧6秒の
再武装分岐が先に成立して10秒警告を妨げるため、警告`STOPPED_WARN_SEC=10.0`、再武装
`STOPPED_REARM_SEC=12.0`へ定数化した。初見が10秒以内なら従来どおり武装なしで発話できる。
起動直後でラップタイム未成立時の0.15%極近距離経路、2秒停止確認、同一車20秒抑止は今回は維持。
関連Bridge wiring 75/75、反射統合63/63合格、外部API呼出0。実iRacingで警告時刻・誤警告率を要確認。
高影響の安全ロジックなのでClaude独立確認待ち。commit・Build・公開なし。

## Founder確定：質問別の専門配線＋重要局面の自発戦略コール

PITWALLはAIドライビングコーチではない。「ブレーキポイントはここ」「このコーナーが遅い」と走行中に
逐一指導せず、Driverをレースへ集中させる。一方、走行データは裏で工学的に解析し続ける。

Driverから質問が来たら、まず質問の目的・対象を判定し、燃料、pit timing、ライバル比較、タイヤ、
車両状態、過去記憶など必要な専門処理だけへfan-outする。各処理が事実・確度・計算・候補を構造化し、
LLMには必要最小限の判断材料だけを渡す。複合質問は複数処理を呼び、LLMに生テレメトリ全体を読ませない。
数値計算・対象同定・合意・訂正は決定論側、LLMはDriverとの相談と簡潔な説明を担う。

Driverコールが無くても、戦略上重要な局面ではLunaが自発発話する。対象は給油成立条件／pit窓、後方車の
undercut動作、後方からの急接近、前車の逃げ切りpace up、合意済み戦略を崩す条件変化など。常時計算と
常時発話を分離し、重要度・確度・判断期限・戦略への影響・重複抑止・無線予算をgateにする。単なる
コーナー遅れや毎周の実況は発話しない。これは追加機能案ではなく「一生の参謀」を実現する中核受入条件。

## MD #6 Codex確認：e09代表ケースは通過、初回SDK欠損で永久保留を差戻し

Claudeのe09実装は、SDK 8周とDriver申告9周を区別し、両方の燃料過不足を答え、SDKが9または7へ
変わると新SDK値で解除する代表経路を確認。`tests-laps-dispute-hold.js` はCodex再実行35/35合格し、
既存34/170/134/126件も回帰なし。

ただし `disputeLapsRemaining(... laps_remaining:null)` で保留を立てた後、SDKが9、さらに8を取得しても
`lapsRemainingStatus()` は永久に `held:true` のままになる。解除条件が
`sdk_laps_at_dispute !== null && sdkNow !== sdk_laps_at_dispute` のため、初回欠損から有限値への回復を
一切解除できない。また契約は「次の観測」だが、現在は観測世代を持たず、数値変化を観測の代用にしている。
Claudeは同一snapshotの再質問では保持し、source timestamp／authority revision等が進んだ新観測なら
同じ数値でもSDK値で解除する。最低限、null→finiteは必ず解除する反例を製品router検査へ追加する。
この増分は差戻し。e03〜e08・e11、LLM履歴注入、再起動persistence、プロンプト比較も引き続き未完。
commit・Build・公開GOなし。GitHubリポジトリはCodexがPRIVATEへ変更・再確認済み。

## MD #5 Codex確認：履歴燃費の同条件fail-closed・確度契約は合格

Claudeの前回差戻し対応をCodexが独立確認。別series・Practice/sprint・燃料/タイヤ規則違いの履歴を
現在Race/enduranceへ混入させた反例は、現在「燃料の実測がまだ足りない」でfail-closedとなる。
主要条件が一致し、setupと路温だけ違う履歴は採用するが、本文へ差異を明記し、機械契約も
`confidence: estimate_low`、`basis: memory_previous`、警告2件となる。本文の「暫定」と確度が一致した。

Codex再実行は履歴燃費34/34、前回燃費発話16/16、build298 replay 170/170、proposal bridge 134/134、
session memory 126/126、callAPI memory 27/27、wiring 24/24。前回P1は解消し、この増分は合格。
ただしレース会話全体は未完成。Claudeは追加指示待ちで止まらず、e03〜e11通しハーネス、e09の
Driver訂正保留、LLM経路への履歴燃費注入、再起動後の再利用まで続行する。プロンプト肥大の比較評価も
11イベントの同一入力・同一モデル採点で行う。commit・Build・公開は別GO。

## MDチェック：履歴燃費入口は接続、同条件照合と確度表示を差戻し

Claudeの新規 `tests-fuel-history-fallback.js` はCodex再実行13/13合格。履歴なしで停止していた経路から、
本人・車・コース一致の前回4.28L/周を暫定値として回答する入口は接続された。ただし製品routerは
`strategyFuelEvidence()`へseriesId、sessionType、raceFormat、fuelRule、tyreRule、setup、路温を渡していない。
同じ本人・車・Spaでも、別series・Practice/sprint・燃料無制限・別setup・路温差30℃の履歴4.28を、
現在Race/endurance・燃料制限の暫定燃費として採用する反例を実行確認。さらに返答の`confidence`が
履歴推定でも`confirmed`となる。入口の接続は改善だが「同条件fail-closed」は未達。
Claudeは個別文字列を塞がず、現在取得できるidentity/contextを取得層へ渡し、差異は拒否または低確度・
差異明示へ統一する。その後e03〜e11の連続相談へ進む。詳細は共有MD末尾。完成・Build・公開GOなし。

Yuji指摘のプロンプト肥大も会話品質の原因候補として、11イベントの実回答比較で検証する。
現プロンプトと、役割→Driverの目的→事実→判断→訂正→合意の順へ整理した候補を同じ入力・モデル条件で比較し、
質問への直答、脱線、訂正反映、数値根拠、長さを採点する。禁止文を追加するだけの修正はしない。

## Yuji最新指示：レース会話を先に完成、燃料延長判断は次段へ固定

Claudeは追加指示待ちで停止しない。MD#2で局所2修正はCodex合格済み。次は既存11イベントfixtureと
9/11・9/12実ログ原文を現在の製品経路へ接続し、履歴燃費4.28L/周による暫定提案→当日実測4.6への更新→
残り9周への訂正→根拠説明→再提案→Driver合意→結果記録→アプリ再起動→次回相談で訂正後の値を再利用、
を一つの連続会話として実装・保存する。質問への直答、対象、数値根拠、pit_plan、最終発話、記憶を同時採点し、
global配送追跡・中断・別話題・データ欠損もこの統合受入で反証する。Claude実装、Codex独立確認。
commit・Build・公開は別GO。追加の局所指示を待つ必要はない。

その次の予約scopeとして、実測燃費・残り時間/周回・必要燃料から「毎周何L（何%）セーブすれば、
何分後に何周延長できるか」を計算し、成立状況と戦略価値を更新発話する機能を実装する。
単なる色表示ではなく、必要セーブ量、実績との差、pit/交通上の価値をLunaが簡潔に伝える。
現行のスプラッシュ回避量、Plan C必要燃費改善率、クリーン周燃費監視を再利用する。

## 9/14 Claude：履歴燃費フォールバックを配線（統合の第一段・未commit）

11イベントfixtureの統合実装に着手。**e01/e02の「履歴燃費4.28を暫定として使う」を実製品経路へ配線した**
（9/13独立調査で指摘済みだった `strategyFuelEvidence` の未接続を解消）。`answerFuel` に
`history_per_lap_l` を追加し、ライブ実測が無い時だけ履歴を採用、返答へ必ず`前回実績…（暫定）`と出典を
載せる。`local-intent-router.js` はpit前後どちらの経路でも履歴を渡すが、pit前は `fuelReply` の
`pit_timing_authority` 等より詳しい分岐を迂回せず、最弱catch-allに落ちた時だけ置き換える。
新規 `tests-fuel-history-fallback.js` 13件（ライブ優先・別driver/別車種のfail-closed・回帰含む）、
preflight「✅出荷可」、wiring-lint未配線0。

**次セッションの入口（未実装）**：①11イベント通し実行ハーネス未作成（e03〜e11未接続）
②**e09「あと9周だよ」のdriver訂正 vs SDK 8周の保留機構が未実装**（GAPの`gapHeld`に相当するものが
`laps_remaining`に無いことをgrep確認済み・ここが最大の未実装）③e02/e06/e11はLLM経路で、
`buildFuelAuthorityNote`へ履歴燃費が未注入 ④再起動後の記憶再利用の通し検証が未実施。
詳細は共有MD末尾「Claude：履歴燃費フォールバックを製品経路へ配線」。

## MD#2 Codex確認（2026-09-14）

ClaudeのMD#1対応を独立確認。proposal-agreement 134/134、callAPI記憶27/27、wiring 20/20が合格し、
前回と同じ実callAPI probeで、タグ接頭辞の表示漏れ解消、説明→same_topic→「はい」の14周合意、
同一decision_idへの新入力後に届く古いconfirmの拒否（12周維持）を確認した。今回の2修正は合格。
`preflight.sh`はサンドボックスがlocalhost listenをEPERMで拒否したため、HTTP/admin/deployの3検査だけ
実行不能でexit 1。他の検査は合格し、今回の変更起因の失敗は確認していない。
増分①全体は、global `lastQueuedSpeakItem`を含む実queue・中断・non-streamと、既存11イベントの
連続相談・再起動後の記憶再利用が未検証のため完成判定保留。局所差戻しは増やさず、この統合受入へ進む。
製品コード変更・commit・Build・公開・有料API呼出なし。詳細は共有MD末尾。

## MD#1 Codex確認（2026-09-14）

Claudeの122検査、callAPI記憶27、wiring20を独立再実行して合格。配送済みitemを模した実callAPI probeでは、
理由説明→same_topic→「はい」で14周への合意を確認。実queue全経路の配送結合は未確認。
タグは完全マーカー前の接頭辞がstream表示へ漏れる。「その提案への賛成は撤回したい」を応答read直前に
routerへ渡す元probeでは古いconfirmの14周確定を再現（通常UI到達性は未立証）。正確な入力・タイミングを
共有MD末尾へ返却済み。Claude実装継続／Codex再確認。完成合格・Build・公開GOなし。
証拠：`review/local-evidence/20260914/probe-md1.cjs`、`probe-md1-results.json`。有料API呼出0。

## 次チャットの開始点：既存実会話ログと「使える記憶」を完成基準にする

Yuji最終確認：外部の会話実例探しを次の主作業にしない。Yuji・八木さん・まーぼさん等の既存ログに残る
自然な言い回し、言い直し、反論、訂正、追質問を最優先の検証資産として使う。原文を整形した模範質問へ
置き換えず、質問への直答、対象識別、訂正後の計算・提案更新、追質問と合意の継続を一連の会話で採点する。
ログに当時の権威データが無い項目は、実ログだけで正答値を断定せず、会話理解の検証と、条件を明示した
再現テストを分離する。「何か返した」「intentが一致」「テスト全緑」は合格条件ではない。

現状、利用者が見える専用の記憶フォルダは未実装。Electron `localStorage` にレース履歴、短期会話、
一部訂正を保存し、回答前検索を行う部品はあるが、訂正学習は限定的で、全会話ログを改善へ変える閉ループは
完成していない。今後「記憶ができた」と報告できるのは、本人の訂正を保存→アプリ終了・再起動→同一本人の
次の相談で検索→回答・計算・提案へ反映→訂正前の古い内容が復活しない、を実出力で通した場合だけ。
フォルダ作成、保存成功、検索関数、プロンプト注入だけでは未完成と判定する。

次チャットは、新規競合調査や抽象設計から再開せず、既存ログの原文と同時刻の利用可能データを棚卸しし、
現在版へ再生した基準結果を保存するところから始める。最初の完成区間は従来どおり燃料・pit相談だが、
既存ログで露呈した話題すり替え、訂正無視、対象車混同も会話基盤の横断失敗として回帰評価へ含める。
Claudeが実装、Codexが実際の会話出力と再起動後の再利用を独立確認する。Build・公開GOとは別判定。

## 9/14 最新確認：Simulator Controller比較とClaude接続実装の独立反証

Yujiの比較検証GOに基づき、SCの英語動画1本の自動字幕と固定SHA `f3f025c2` の関連公開コードを確認。
追質問の継続例とpit相談の回答不能が同じ動画にある。最新SCの実走精度・応答速度は未検証。
推奨候補は、既存PITWALLの計算・記憶をLunaの継続相談から利用する構成。全面移植の採用判断ではない。
詳細は共有MD末尾「Simulator Controller比較検証／会話を成立させる構成の判断材料」。

Claude最新差分の103検査・wiring20件・callAPI記憶27検査を独立再実行して合格。ただし実callAPI＋state＋routerの
保存応答probeでは、理由説明のsame_topic後もawaiting_judgmentが残り、「はい」で14周提案へ合意できない。
提案保持とrequestへのdecision_id注入は確認できた。未知／途中タグが表示へ漏れる欠陥も再現。
同一提案の古いconfirmを新しい撤回後に適用できる境界probeも記録。ただし通常sendMsgのisBusy制限があり、
通常UIでの競合到達性は未立証。これらを全アプリ／実LLMの再現と混同しない。
証拠は `review/local-evidence/20260914/`。製品変更・commit・Build・公開・有料API呼出なし。
増分①の完成合格はまだ出していない。Claudeは既承認の接続区間を完成させ、Codexが再確認する。
SC比較自体はYujiへの判断材料として報告。全11イベントの製品比較、実LLM品質、実音声・Windowsは未完了。

Yujiの「家訓にしろ！メモ！」を受け、AGENTS.md「Yujiの恒久指示：Codexの家訓」に評価・作業原則を保存済み。
レース会話の完成区間、旧新版比較、訂正と記憶の再利用を成果基準とし、局所検査・差戻しの往復を成果の代用にしない。

## 9/14 Claude対応：same_topic固定・タグ表示漏れを修正、1件は再現できず

9/14 probeで反証された4項目のうち2件を修正（未commit）。①`same_topic`適用後もawaiting_judgmentが
解除されず永久に確定不能だった問題を修正——ただし単純即時解除ではなく、この判定の根拠になった説明の
**配送確認（onSpoken）を待ってから**解除する設計（未配送・中断の再発防止というCodexの懸念に対応）。
②未完成／未知classificationのタグが表示へ漏れる問題を修正——`stripProposalJudgeTag`をマーカー開始位置で
無条件に切り捨てる方式へ変更（表示防止と厳密パースを分離）。検査122件全合格・wiring-lint未配線0・
preflight「✅出荷可」。実装中に既存callAPI回帰テスト2本が新定数未定義で壊れているのを再度発見し修正。
残り2項目：③同一提案の古いconfirmが撤回後も適用される境界probeは、3パターンの再現を試したが
**現行のstale guardで正しく拒否され再現できなかった**——Codexの正確な再現条件（入力・タイミング）を
教えてほしいと依頼中。④stream/non-stream・実費用の実測は実LLM不在のため未着手。
詳細は共有MD末尾「Claude：9/14 probeの2件を修正、1件は再現できず情報提供を依頼」。

## 9/14 Claude対応（MD#1）：タグ接頭辞漏れと入力世代ガードを修正

Codex MD#1確認で③の正確な再現手順（`probe-sc-comparison.cjs`）を受領し、その手順どおりに再現・修正した
（未commit）。①1文字ずつ配信で`<<PW`等のタグ完成前の接頭辞が表示へ漏れる問題——`stripProposalJudgeTag`が
末尾の部分一致も検出して切り捨てるよう修正（`flushSentences`の独自実装も統一）。②同一提案decision_id=d1
への2回目の曖昧な発話（撤回）でbase_revisionが進んだ後、1回目の古いconfirm応答が遅れて届くと14周が
誤確定する問題——**実際に再現を確認**。`applyProposalClassification`へ`request_revision`（callAPI送信直前に
捕獲したbase_revision）を追加し、不一致なら`stale_request_generation`で拒否するよう修正。検査134件全合格・
wiring-lint未配線0・preflight「✅出荷可」。留保：global `lastQueuedSpeakItem`・単一revision比較への依存、
複数会話同時進行・non-stream・中断を含む実queue全経路は未検証。詳細は共有MD末尾
「Claude：MD#1確認の2件を修正（タグ接頭辞漏れ・入力世代ガード）」。

## 最優先：9月「レース会話成立」へ独立調査・構成比較（Yuji承認）

9/13最新合意：ClaudeとCodexがそれぞれF1意思決定／音声AI構成／PITWALL過去設計の失敗を徹底調査する。
まず調査と構成候補・比較検証方法をYujiへ報告し、相談後に採用・試作へ進む。以下の即時実装指示より優先。
Claude独立調査とno-refusal設計案をMDで受領済み。Codexの追加反証結果は共有MD末尾「no-refusal案の深掘り」。
公開301と現差分の実関数比較で、燃料部分回答の改善と、live計画再計算後の無発話分岐を確認。
9/11・9/12のUSER全12件を確認。値不足だけでなく、話題誤分類・訂正未処理が混在する。
9/13追加合意：Yujiが、代替値追加案と目的理解・訂正・作戦継続を接続した案の同条件比較に賛同。
継続観測を後回しにせず、推定を含む提案→状況変化／訂正→再提案→結果検証を今回の前進単位とする。
次はClaude実装担当が既存機能を活用した燃料・pit会話の比較試作を具体化し、Codexが独立検証する。
9/13 Yuji「作業開始GO」によりClaude着手。増分①は実装途中・独立確認未合格（最新判定は共有MD末尾）。
既存の strategy-playbook.js（暫定提案・3クリーン周実測更新・アンダーカット/オーバーカット判定・主案/代案）は
既にrenderer.htmlへ配線済みと判明。欠陥は「提案を発話しても session-strategy-state の pit_plan
（唯一の正本）が更新されない」こと。提案→保留→driver応答→正本反映を繋いだ。commit・Build・公開なし。
Codex独立確認：増分①は差戻し。24検査は再実行合格だが、保留提案の失効漏れ、追加pit合意後の旧実行済み回答、
未再生提案の合意可能化、報告された「はい」の経路未接続を追加反証。共有MD末尾の修正依頼を参照。
Claudeが4点修正済み（未commit）：revisionベースの提案失効・answerPitDecisionの優先順位反転・
proposePlanをfinalizeUtterance('spoken')確定点へ移動・「はい/うん/ええ」を相槌へ追加。
検査44件全合格・wiring-lint未配線0・preflight「✅出荷可」。詳細は共有MD末尾
「Claude：増分①差戻し4点を修正」。Codex第2回確認は44/44再実行合格、修正済み6条件を独立確認。
ただし音声待機中の訂正を古い提案が巻き戻す経路、および中断・別話題の相槌を合意する経路が残り、増分①は差戻し継続。
詳細・再現probeは共有MD末尾「Codex第2回確認」。製品全経路／実音声合格ではない。
Claudeが残り2系統も修正済み（未commit）：生成時点でrevisionを確定し配送時に照合（P1-A）、
audible_interrupted用の取消しフックと route()/routeInner() 分離による無関係話題での無効化（P1-B）。
旧P1-3の静的文字列検査はCodex指摘どおりvm実行検査へ置換。検査56件全合格・wiring-lint未配線0
（対象15）・preflight「✅出荷可」。詳細は共有MD末尾「Claude：残り2系統（P1-A/P1-B）を修正」。
Codex第3回確認：56/56再実行合格。正常合意、待機中の訂正後の誤合意防止、中断・別話題後の誤合意防止を独立確認。
残存は失効した提案がTTS開始地点まで進むことと、提案内容への確認質問まで別話題として捨てること。増分①の完成判定は保留、共有MD末尾に再現・修正依頼。
Claudeが両方修正済み（未commit）：GAP鮮度チェックと同形の`precheck`フックをspeak()/drainQueueへ追加し、
queue待機中に前提が変わった提案は再生前にdiscard（一度も喋らない）。pit/戦略ドメインのintent
（pit_plan_question等）を「別話題」無効化の対象から除外する許可リストへ集約し、answerPitDecisionへ
pendingProposalMention()を追加して確定Planと保留提案の両方を明示する応答にした。検査65件全合格・
wiring-lint未配線0（対象16）・preflight「✅出荷可」。詳細は共有MD末尾「Claude：残存P1（再生前チェック）と
会話継続（確認質問）を修正」。Codex第4回は65/65再実行合格。実drainQueueでqueue内失効の再生停止、実routerでpit周回確認→合意を確認。
残存：TTS応答待ち中の訂正後にもAudio.playへ進む／「なぜその案がいいの？」をLLMへ渡す前にpendingを削除。共有MD末尾の第4回確認を参照。増分①は差戻し継続。
Claudeが対応（未commit・1点は部分対応のみ）：①再生直前チェックは完了——`myGen`照合と同じ形で
`await audio.play()`直前とWebSpeechフォールバック先頭の2箇所へ`precheck`再照合を追加。②理由確認は
**未完了**——Codexが求める「LLM応答側での分類」は実装しておらず、暫定として発話自体のドメイン語彙
（ピット/プラン/その案等）で即時無効化を見送りTTL(90秒)に委ねる部分緩和のみ。次の増分でLLM応答分類に
着手する必要あり、と共有MDに明記。検査71件全合格・wiring-lint未配線0・preflight「✅出荷可」。
詳細は共有MD末尾「Claude：再生直前チェックを非同期区間へ拡張・理由確認を部分緩和」。Codex第5回：71/71再実行合格。
実drainQueueでqueue待機・TTS応答中の訂正ともAudio.play 0回を確認。前回のcloud再生競合は解消確認。
会話は未完成：「どうして？」では提案を消し、提案語彙を含む別用途の質問では次の相槌をpit承認にすることを実routerで再現。
次は語彙判定の追加を止め、提案文脈→意味理解→対象を特定した合意の経路を接続する。製品全体の合格・Build・公開GOではない。
Claudeが対応：語彙ヒューリスティック（STRATEGY_TOPIC_TEXT_RE）を撤回し、handled:falseはフェイルクローズ
（即時無効化）へ戻した（安全側優先の判断）。意味理解の接続層`applyProposalClassification()`を
session-strategy-state.jsへ追加（confirm/decline/same_topic/unrelated＋stale guard）——**ただし本番経路
からはまだ呼ばれておらず、`wiring-lint`が未配線1件として検出する（正直に開示、allow listで隠していない）**。
実LLM呼出はこの環境で検証できないため、接続層だけを用意して本番配線は止めた。LLM側の会話文脈へ
未合意の提案（plan_id・lap）を伝える一文を追加（グラウンディング改善、意味理解そのものではない）。
Codex第6回：79検査再実行合格、wiring-lintは未配線1でexit 1。理由質問でpending削除→新設の提案noteが空になる経路を再現。
再承認待ちは不要。既存会話呼出に分類メタデータを併載する試作を第一候補とし、mockで送信→応答解析→状態反映→出力まで接続する。実LLM品質・実費は未検証と分ける。
前回の「設計相談が必要」は作業停止の条件ではない。未配線のまま完了としない。Claude報告の検査79件全合格・
preflight「✅出荷可」。詳細は共有MD末尾「Claude：語彙ヒューリスティックを撤回、意味理解の接続層を用意」。
Claudeが5点の接続単位を実装（未commit）：①意味判定待ち状態(markAwaitingJudgment)を新設し、確定
（裸の相槌）だけをゲート ②会話文脈へ`<<PW_JUDGE decision_id="..." classification="...">>`を出させる指示を
awaiting_judgment時のみ注入 ③既存の会話呼出1本に相乗り（別呼出は増やさない）、`[JA:...]`と同じ形で
ストリーム/表示/最終replyの3箇所からタグを除去 ④decision_idを必須化 ⑤古い判定が新しい提案を
上書きしないstale guardを実行テストで確認。実装中に2件の配線バグ（markAwaitingJudgment自身の
revision書き戻し漏れ／判定待ち中の裸の相槌が別話題と誤認され無効化される）を発見・修正。
**wiring-lintが緑に**（`applyProposalClassification`の未配線が解消、対象20／合格20／未配線0）。
実装中に既存の`tests-callapi-stream-memory.js`/`tests-conversation-corpus-replay.js`（実callAPI()を
vm実行する回帰テスト）が新関数未定義で壊れているのを発見し、テスト側の土台も修正。検査103件全合格・
preflight「✅出荷可」。**未検証と正直に開示**：実LLMがタグを実際に指示どおり出すかはlive LLMが
無いため未検証（モデルの意味判定の質はCodexも別項目と明記）。詳細は共有MD末尾
「Claude：意味理解の接続を実装（同一呼出＋タグ方式）」。Codexの再反証待ち。
残る増分（driver主導のundercut要求への対応、燃料履歴fallback配線、
結果評価=outcome_capture_contractの消費者実装）は未着手。
Codexは比較入力 `review/fixtures/race-conversation-fuel-pit-v1.json` を作成済み（仮想11イベント）。
算術11項目・時系列・ID重複なしを確認。製品への接続と会話採点は未実施で、合格判定ではない。
戦略予測の誤差は検証・改善の材料。別対象への回答や架空の観測値を許容する意味ではない。構成の最終採用・精度は未確定。
Claudeの製品変更は未commitで存在する。Codexは製品を変更せず独立probeとMD更新のみ。Build・公開なし、外部有料API呼出なし。

9/13 Yuji再指示：症状別の修正を繰り返す開発にしない。共有MD末尾「症状別修正を開発の主軸にしない」が作業基準。
Driverの目的→対象・根拠・状態の共通定義→既存全経路への接続→会話区間実装→未使用場面での反証の順で進める。
過去ログは設計・検証の材料であり、単語別FAQや誤回答を固定する教師データにしない。
局所修正の件数やテスト全緑だけを完成根拠にしない。最初の完成区間は引き続き燃料・pit相談。

解析原本は `review/local-evidence/20260911/OMORAY-bridge-debug-20260911-1915.log` と
`review/local-evidence/20260911/eventresult-88593211.json`。Downloads原本とSHA-256一致のローカルコピー。
ログにはUSER／LunaJP／LOCAL_INTENT_ROUTE／INTENT_ROUTE／UTTERANCE_FINALが含まれる。
Claudeはこの2ファイルを直接読み、所在の質問を繰り返さず実装を継続する。原本コピーはGit管理対象外。

目的は「グラフィック相談のように意図を理解し、レースでは実データに基づいて判断と代案を返すLuna」。
Claude実装／Codex独立確認。まず燃料・pitの希望→根拠確認→提案→合意→継続・変更を完成させる。
単語別の固定回答を追加するだけでは合格にしない。既存実走質問と訂正・追質問を受入基準にする。
当日の燃費を継承し、履歴使用時は本人・条件・日付・暫定性を明示。希望が不成立なら根拠のある代案を返す。
Build 301のidentity／早すぎるfinal lap／topic継承の欠陥を土台から解消する。詳細は共有MD末尾。
今回のGOは実装着手。新Build・公開のGOとは扱わない。

## 9/13追加証拠：八木さんの鈴鹿6時間（配布Build 301）

原本は `review/local-evidence/20260912/OMORAY-bridge-debug-20260912-1403.log`（DownloadsとSHA-256一致）。
約10時間3分の収録にBridge再起動・Tracebackの記録なし。ただしUSERは3件で、会話Standard合格ではない。
「タイヤのデータ入ってる？」が一般接続確認へ誤分類。実routerでタイヤ値なしでもconfirmedとなることを再現。
非運転garageのFuel:0.0をchecker残燃料へ固定、debriefへ「?周」が出る。保存・実残燃料は未確認。
3質問ともidentity=null。これは配布版の観測で、Claude現未公開修正の検証ではない。
Codexはログ解析とMD更新のみ。詳細・再現条件・Claude修正指示は共有MD末尾。燃料・pit Standard本体の優先は継続。
追加反証：レースGAPは同クラス順位±1を選び、物理車間の概算を「後ろX秒」と発話する対象・意味の混同あり。
仮想46位／直後26位／順位相手47位で実関数が47位を選ぶことを再現。USER3件は全て非運転garage中。
長時間稼働・好意的所感をGAP精度や走行中対話の合格根拠にしない。共有MD末尾の訂正が優先。

## 現在地：Build 301公開済み・9/11 Spa実走は不合格

9/11夜の公式result `88593211` と実走ログ `OMORAY-bridge-debug-20260911-1915.log` をCodexが照合。
Build 301起動・18module loadedは確認できたが、前回ピット2質問はdriver不明、給油時期質問はno-data、
リアウイング損傷質問は前の復帰話題へ誤分類。final lapは1周早く、公式14周に対しdebriefは13周。
ファイナルラップは汚染された平均235.85秒で残り1周、実走相当139.133秒で残り2周となることを実関数で再現。
今回の実走Gate 8は不合格。機械検証・artifact合格を会話／実走合格へ拡張しない。
次はClaudeが共有MD末尾の失敗固定・入口→出口再生を実装し、Codexが再反証。新Build・公開へ進まない。
公開資産は変更していない。Gate 10の停止判断対象であり、rollback候補を安全確認済みとは扱わない。

本節が以下の過去記録より優先。9/11 Yujiの「OK! GO!」により、Build 301を実機テスト用候補として公開済み。
製品SHAは `4bad610981c931adb46ad596367714ff1b565bc0`。Desktop／単体Bridgeとも同SHA。
Desktop private run `34552511274`、Bridge private run `34552511197`。再Buildせず検査済み実物をReleaseへ昇格した。
製品実装はClaude Code、独立確認はCodex。旧記録への永続ID移行を含むレビュー差戻しは解消済み。
変更領域はDesktopと同梱／単体Bridge。server・認証・決済・公開ページの変更はない。
Gate 5：installer展開、18/18モジュール、全JS／rendererの対象SHA一致、同梱BridgeのBuild 301を確認。
公開URLからinstallerを再取得し、100754247 bytes／SHA-256 `cf06e3a9e38798b5406142cd0257f87b8b82d267a7355123e90662a8ff35d7be`で一致。
日付版・latest・旧互換版も同サイズ／digest。Windows/iRacing、実音声、installer実起動は未確認。
全体preflightは通常権限で最終exit 0。追加JS 5本・Python 2本もexit 0。
旧契約を前提としていた回帰テスト2本のみ追従修正（表示同期71/71、Build 298 replay170/170）。
製品動作ロジックへのCodex追加修正なし。結果とcandidate証拠は共有MD末尾へ記録する。
原価：過去給油回答はローカルで生成。通常のTTS経路は維持し、検証では外部有料API呼出なし。
次はYujiが公開更新経路でBuild 301を導入し、起動・PTT・前回給油回答・session切替・checker記録を実機確認する。
過去の未push中間commitには大型artifact追加→revertがあり、GitHubがpushを拒否したため、同一ツリーを公開中SHA上へまとめた。
元のローカル履歴 `73cabf7` は `archive/pre-build301-artifact-history` に保存。現mainは配布用履歴へ整合済み。強制push・履歴削除なし。

## 現在地（2026-09-06）：Build 298事後Gate 4系統 — ④③修正済み・①②赤

Codex 事後Gate（共有ログ `2026-09-05 17:38`）の不合格4系統に対し、実走ログ由来の replay
`tests-build298-race-replay.js`（58検査）を先に作り、Founder 固定順序 ④→③→①→② で修正中。
**①②③④すべて Codex 独立 Gate 4 合格。commit 済み（`6a7b638` Luna-only UI ／ `a34db15` Build 298修正）。
replay 123/123・preflight ✅出荷可。**Gate 5 合格**（run `34012416685` / head `4de36b8` / Build 298・Codex確認者署名）。
push 済み（`origin/main` = `4de36b8`）。公開step は skipped で公開asset不変。
**次は Windows Gate 6 → iRacing Gate 8。公開は NO GO。**
差戻しは計6ラウンド（④3・①2・②1）。いずれも「動くコードはあるが繋がっていない／値を検査していない」型。
④はCodex差戻し3ラウンド（実経路未接続P1 4件／初回true誤判定／切断配線漏れ）をいずれも closure。
pit観測は `unknown/off/on` の三値＋stale・切断・SessionNum境界の3箇所 reset。
①は母数10→5、`briefingEvidence()`／`stableIdentity()` 新設で採用根拠を trace 化。
発話は**平均Incidents 5以上かつ悪化**のときだけ（Founder数値基準）。
現在窓5＋比較窓5の**10件すべてが別レース**と証明できなければ沈黙し、比較窓の内訳も trace へ出す。
②は Build 297 の amend 方式を**構造ごと置換**した：候補時点では表示せず、`drainQueue` の
authority 確定点で `buildGapUtterance()` が最終本文を1回生成し、chat・Overlay・会話Box・TTSへ
同じ1本を fan-out する。終端は spoken/dropped のみで `rebuilt` は廃止。自発コールとPTT回答の両方。
詳細は `review/CODEX_HANDOFF_BUILD298_FIX_20260906.md`（追記1〜4）。
④の根本は **STTが「周」を「週」と書き起こしていた**ことで、「何週目にピットインする？」は
記憶以前に質問として認識されていなかった。詳細は `review/CODEX_HANDOFF_BUILD298_FIX_20260906.md`。
`preflight.sh` に本スイートを登録済み＝**全緑まで出荷不可**。commit・Build・公開はいずれも未実施。

## 次Phase決定：音声ピット設定

Founder決定により、現行のレース会話成立・GAP同期の実機確認後、次の主要Phaseへ**走行中の口頭指示によるiRacingブラックボックス設定**を追加する。共通command基盤は拡張可能に作るが、MVPは「タイヤ4本／交換なし」と「指定給油量／満タン／ゴール時3L残し」に限定。自然文→閉じたcommand→Luna復唱→Driver明示承認→実行→設定読み戻しを必須契約とする。ティアオフ、Fast Repair、左右タイヤ、全取消、画面切替はPhase 1.1、Brake Bias／TC／ABSは車種別安全契約後。全体進捗表と詳細は共有ログ末尾。中核差分と追加の実在テスター名修正はともにGate 4合格。実名修正は未commitで、commit／Build／公開は各GO待ち。

## 実在テスター名修正 Gate 4

PDDPブリーフィングの固定`八木さん`を保存`userName`／一般名fallbackへ変更した未commit差分は、Codex独立Gate 4合格。no-real-names 18/18、PDDP 57/57、構文・diff check合格。残存実在名はコメントのみ。Windowsの保存名と実音声はGate 6、artifactはGate 5で確認する。commit／Build 298／公開は各GO待ち。

## Build 297事後Gate 4（Codex独立確認）

**第7回Gate 4は合格。** Claudeの第6回対応で内部`_mid`を非列挙化し、client送信境界とserver stream/non-streamの両方を`role/content`へsanitize。Codex独立実行でcallAPI 26/26、GAP answer 68/68、GAP display 60/60、非同期割込み18/18、TTS失敗51/51、server構文、diff checkが合格した。PTT GAPの実`drainQueue` rebuild/drop、Overlay＝会話Box＝TTS raw、同文履歴分離、非再生終端を確認済み。未commitのためYujiのcommit GO待ち。commit後はSHA固定、private artifact Gate 5、Windows Gate 6、`server.js`変更のRailway Gate 7、iRacing Gate 8が必要。Build／公開は別GOまで不可。P2（永続uid、再翻訳、open_items参照整合、途中中断heard契約）は次スライスへ。

Claudeの第5回対応で本文一致の履歴取り違えはstable message IDにより閉じ、Codex独立実行もGAP answer 68/68等に合格。ただし**第6回Gate 4はP1 1件で不合格**。`pushMsg()`が列挙可能な`_mid`をmessageへ付け、`callAPI()`→server→Anthropic `messages.create()`へsanitize無しで送るため、未知フィールドでChat API全体がvalidation失敗し得る。内部IDを外部payloadから除外し、実callAPI送信キー検査と変異を追加する。詳細は共有ログ末尾。未commit、Build・公開不可。

Claudeの第4回対応により、必須synthetic replayは実`drainQueue`まで通り、Codex独立実行でもGAP answer 62/62等に合格。ただし**第5回Gate 4はP1 1件で不合格**。新しいLLM履歴同期が`messages`を本文一致で検索して全発話へ無条件適用されるため、履歴へ追加しないradioのdropでも、同文の別assistant履歴を削除できる。local intentが追加した特定messageのstable ID／参照をqueue itemへ渡し、その対象だけを更新／削除する必要がある。同文割込み反例と変異を追加後、再確認。詳細は共有ログ末尾。未commit、Build・公開不可。

Claudeの第3回差戻し対応で、PTT GAP回答のuid/displayEl受渡し、answer finalizer、製品trace uid、mode-switch終端はコード上修正された。ただし**第4回Gate 4はP1証拠未達で保留**。60/60のPTT検査は`addMsg→speak`後、rebuild/discardをfinalizer直接呼出しで確認しており、実`drainQueue→evaluateAnswer→TTS raw`を通していない。9/4最終TTS本文が無い代替として、このsynthetic integration replayは必須。またrebuild後の`pushMsg`会話履歴には古いGAP候補が残るため、後続回答等へ再利用されない契約の確認が必要。詳細は共有ログ末尾。未commit、Build・公開不可。

Claudeの第2回差戻し対応をCodexが再確認したが、**第3回Gate 4もP1不合格**。duplicate／TTS失敗等の個別配線は改善した一方、PTT local GAP回答は`addMsg()`の要素を捨てて`speak()`へ`displayEl/utteranceId`を渡さず、回答側discard/rebuildもfinalizerを呼ばない。このためYuji報告の中心であるGAP音声とOverlay／会話記憶の不一致が残る。製品`SPEECH_LATENCY`にもuidが無く、テストstubだけがuid traceを生成している。mode切替filterによる未終端除去も残存。詳細と次回受入条件は共有ログ末尾。未commitを維持し、Build・公開不可。

Claudeの第1回差戻し修正（未commit）をCodexが再確認したが、**第2回Gate 4もP1で不合格**。31/31等の新テストは緑だが、finalizerをhelperとして直接呼ぶ試験が中心で、製品のduplicate、`reportSpoke`、非emergency TTS失敗、defer cap／現在発話割込みから終端処理へ未接続。単一stable `utterance_id`もcandidate→queue→Overlay→memory→`play_started`を貫いていない。元実走の最終TTS本文が無い代替は、helper試験ではなく実製品分岐を通すsynthetic replayなら再判定する。詳細と受入条件は共有ログ末尾。未commitを維持し、Build・公開不可。

公開中Build 297／SHA `18668a95a54f4e34bbd9c10f1dc9ca36293dac10` の表示・音声同期修正は、対象テスト22/22等の回帰には合格したが、Codex事後Gate 4は**P1 3件で不合格**。異言語Overlayで旧翻訳が残る競合、GAP freshness以外の非再生出口で表示・会話記憶が残る問題、本文一致＋直近turn依存で割込み時に旧会話記憶が残る問題がある。現テストは実`drainQueue`→`play_started`を通していない。

実走の追加問題は、製品発話経路の`'八木さん'`リテラル、GAP conflict 14,190件のsource情報欠落と未集約、停止車両判定のreject理由欠落。次はClaudeが「実名修正＋実行コード限定検査 → GAP source/集約診断 → 停止車両状態/reject診断」を行い、表示同期P1も閉じて新SHAを回覧する。Codexが保存ログreplayと5境界を再確認するまでBuild／公開不可。詳細は共有ログ末尾。

## 現在地（2026-09-05・Luna Memory Brain 最初の完成スライス）

`review/NEXT_CHAT_HANDOFF_LUNA_MEMORY_BRAIN_20260904.md` を正本として、全ドライバー入力が
intent別処理より前に共通検索を通る `desktop/memory-brain.js` と製品配線を追加した。
2026-09-04 IMSA Le Mans固定sessionを使い、race/debrief検索、user/cust_id分離、根拠付き評価、
LLM prompt注入、実`callAPI()`ストリーム、TTS queue、使用memory ID trace、評価再保存、再起動・次ターン再取得まで接続した。

機械確認（外部有料API呼出なし）:

- Memory Brain 固定入力・必須変異: **19/19**
- 実`callAPI()`ストリーム（Memory Brain注入→実回答→TTS→復路）: **17/17**
- 会話コーパス: **149/149**
- runtime module 派生検査: **19/19**（`memory-brain.js`を自動検出）
- Build 295退行修正: GAP authority **44 tests**、停止車両実発話を含むreplay **43/43**、session memory **126/126**
- `git diff --check`、追加JS構文: 合格

まだ完了としない範囲:

- 固定8質問すべての意味別回答品質と、次戦ブリーフィング「一度だけ」の実行型検査は未完了。
- `cust_id/subsession_id` は保存schemaへ追加したが、Bridge/公式結果importから本番値が届く入口は未接続。
- Windows/iRacing/PTT/STT/TTS実機、完成asar、実走は未確認。
- commit / push / Build / deploy / 公開は未実施。既存dirty差分を保持中。
- 外部API呼出回数は増えないが、記憶一致ターンではprompt JSONが増える。現状は最大12件に制限したが、
  token/原価の実測・不要記憶の質問別絞り込みは未完了（テストは外部有料API呼出0）。

次の行動: 固定8質問の実回答オラクル、公式result/Bridgeからcust_id・subsession_idを通す入口、
次戦ブリーフィング一回制御を同じ往復テストへ追加する。その後に独立反証へ渡す。

## 現在地（2026-09-03・会話Box v2／**Gate 4 合格・Codex独立確認済み**）

**Gate 4 は合格した**（`review/CODEX_GATE4_REVIEW_20260903.md` 末尾「再確認」）。
Codex が**自環境で独立再実行**し、境界 15/15・Box 61/61・callAPI 14/14・コーパス 149/149・
`node --check`・`git diff --check` が全件合格。当方環境だけの証拠ではなくなった。

差戻しは3ラウンドあった。**Codex が挙げた反例4件は全部こちらの穴**で、対応の過程で
**当方が自分で見つけた欠陥がさらに4件**出た（詳細は共有ログ 2026-09-03 の各節）:

1. 変異試験を**基準が赤いまま**回して全変異を「検出」に見せていた（無効な試験）
2. 絶対鮮度の分離ケースが、別の修正に隠れて**実行されないまま緑**だった
3. `(negatesReflexWord && prevMentionsReflex)` が**どのテストも検出できない死んだ条件**だった
4. `resolved.target || prev` が、fail-close で null にした撤回対象を**復活させていた**

`AXIS_LOOKBACK_MS = 90000` は推測ではなく**実走分布**から決めた（訂正16件・最大38秒の約2.4倍）。
分布を測る過程で、185秒の外れ値が**分布の裾ではなく別の欠陥**（#64のフォールバック）と判明した。
**上限を185秒へ広げていたら間違えていた。**

### まだ終わっていないこと（Codex も明記）

Gate 4 は**コードと内部再生に対してのみ**。次は commit（**Yuji の GO 待ち**）、
Gate 5 artifact、Gate 7 Railway、そして **Gate 6 Windows実機 / Gate 8 iRacing実走**。
`EXTERNAL_USER_DISCOVERY_SAHIDE_20260902.md` の受入条件「**耳で確認できたときだけ合格**」には
まだ何も届いていない。**Build・push・公開は未実施。**

## 現在地（2026-09-03・詳細：訂正の「軸」まで一致）

公開中の製品版は **Build 294**。会話Box v2 は通常回答のストリーム完了出口まで接続済み。Codex の実走コーパス再生（`62cc17a`・再生器とpreflight登録を含む既存commit）で **149/149** 合格した。

**経路の正確な範囲**（越えて書かない）:
- **返信67件**を `callAPI()` で再生した
- **訂正16件の採点は検出器**に対して行った（実走の前後文脈を与えて）
- **`callAPI()` 経由の次ターン訂正は1ケース**

「訂正16/16が callAPI 経由」ではない。意味分類の修正は本節の**別commit**である。

その後、Codex が「到達はしたが**軸が違う**」欠陥（#14「後ろ2.0だね。ギャップ。」が `lap_time` 判定）を指摘。**到達だけでは不十分で、軸が違えば別の値を撤回する。** 3件を修正し、追加反例1件（明示Pit優先）も塞いだ。

| # | 症状 | 原因と修正 |
|---|---|---|
| 14 | GAPの訂正が `lap_time` | 直前1件しか見ておらず、1秒前に割り込んだ「ベスト更新」から軸を取っていた。`resolveAxis()` を新設し、**ドライバーが明示した軸を優先し、同じ軸の Luna 発話を遡って対象にする** |
| 30 | 「左全然車いない」が `pit` | 「ピット前に確認する…**左に車。**」から先頭一致で `pit` を拾っていた。**反射語を最優先**へ（1発話に複数話題がある時、対象は最後の反射） |
| 44 | デブリーフ中の訂正が `nearby_car` | **ずっと前のレース中の反射**を拾っていた。反射経路は反射が直前発話より新しい時だけに限定 |

副次的に **#54 の軸が `pit` → `fuel` に改善**した。

### 機械確認（当方環境・外部有料API呼出なし）

| 項目 | 結果 |
|---|---|
| 訂正16件の到達 | **16/16** |
| **軸が Yuji の正解ラベルと一致** | **16/16（今回追加した検査）** |
| 会話Box | **61/61**（旧 58/58） |
| callAPI 実行型 | **14/14**（旧 9/9） |
| コーパス再生 | **149/149** |
| 変異試験（今回の3修正） | **3/3 検出**（外すと #14 / #30 / #44 が再発） |
| 境界テスト（独立オラクル） | **15/15**（オラクル自己検査3件を含む） |
| `./preflight.sh` | **Claude環境では91スイート合格。Codex環境はHTTP系 bind EPERMで2件未確認**（したがって出荷可とは扱わない） |

### 残る candidate 3件は confirmed へ上げていない

`#24 / #25`（GTPの曖昧な否定・軸 null）と `#54`（soft_dispute）。**軸が確定しないまま撤回すると別の値を消す**ため、意図的に据え置いた。

### 未完了

実マイクPTT→STT→訂正→ACK→TTS、Windows実機、iRacing実走。**Gate 4はCodex独立再確認済み。変更は`a3d493d`へcommit・push済み。Build 294生成・公開済み。** `EXTERNAL_USER_DISCOVERY_SAHIDE_20260902.md` の受入条件「**耳で確認できたときだけ合格**」に、現在の証拠は届いていない（すべて内部計算）。

### 次の行動

1. Gate 5（公開Build 294 artifactのmodule実数・bytes・SHA-256）
2. Gate 7（Railway 反映）→ **Gate 6 / 8（Windows実機・実走＝耳の確認）**

## 現在地（2026-08-30 時点・次セッションはここから読む）

公開中は **Build 290**。ローカルは `origin/main` より **6コミット先行**（未push）。`./preflight.sh` は **84スイート全合格・出荷可**。作業ツリーはクリーン。**Build・署名・公開・push・deployは未実施。**

### 未pushの6コミット

| commit | 内容 |
|---|---|
| `ea1f4e2` / `9e12b43` | Road Atlanta 実走の無線失敗分析（`review/ROAD_ATLANTA_20260830_RADIO_FAILURE_ANALYSIS.md`） |
| `4c8c878` / `98b565d` | Build 291 修正2：会話成立・反射イベント統合（仕様 `review/BUILD291_FIX2_SCOPE.md`） |
| `b56190f` | PDDP v1 の仕様差分（Codex基盤 `b948427` の上に追補） |

Codex の Gate 4 独立確認は `309b749` までが対象で、**修正2 と PDDP には掛かっていない**。

### 実環境で未検証の3件（コードテストでは埋まらない）

1. **新規 runtime module が実バイナリに入り起動時 loaded になるか** — `reflex-events.js` / `pddp.js` を追加した。`package.json` の `files: ["*.js"]` と `renderer` の `<script src>` はソース上一致しているが、`app.asar` を展開して実数を数えていない。**Gate 5** で解消する（`verify-artifact.sh` §7 が module 欠落を検査する）。Build 281 のpackage漏れは「ソース上は正しい」まま起きた。
2. **黄旗イベントが実際に発火するか** — 修正2で `yellow_flag` を新設したが、**手元の実走ログ2本ともに黄旗ゼロ**（`20260830-0901` / `20260830-1539` とも `yellow_flag=0`、caution遷移も0）。停止車両との到着順テストは合成タイムスタンプでしか通っていない。**Gate 8（実走）でしか埋まらず、黄旗が出ないレースを何本走っても検証は進まない**。AIレースでコーションを作って先に潰すのが確実。
3. **`prompts.js` はサーバー側** — 修正2のP1（曖昧な投げかけ禁止・「次周ピット」の回収義務）は Railway へ deploy しない限り本番で効かない。exe の Build では届かない。**Gate 7**：push 後に `./verify-deploy.sh` で本番SHA一致を確認する。

`bridge.py`（黄旗・停止車両のidentity）は `build-desktop.yml` がジョブ内で `pyinstaller irsdk-bridge/bridge.py` を実行するため desktop installer に同梱される。単体Bridgeは `build-bridge.yml` が `irsdk-bridge/bridge.py` のpushで発火する。この経路は通っている。

### 作業時の必須手順（2026-08-30に2回踏みかけた）

**同じリポジトリで Codex が並行して commit している。** 8/30 に `desktop/pddp.js` と `tests-pddp.js` を、既存実装がある状態で気づかず上書きした（どちらも `git checkout` で復元し、Codex のコードとアサーションは失われていない）。**ファイルを新規作成する前に必ず `git log --oneline -- <path>` と `git fetch` を実行する。** 既存があれば上書きせず追補する。

### 次の行動

1. push（6コミット）— 可逆。Codex が修正2とPDDPに Gate 4 を掛けられる状態にする
2. Gate 4（Codex 独立確認）
3. Gate 5 — private artifact を作り module 実数を確認（上記①）
4. Gate 7 — Railway 反映と `./verify-deploy.sh`（上記③）
5. Gate 6 / 8 — Windows実機と実走。**黄旗は意図的に検証する**（上記②）

### 未着手（Road Atlanta 分析 §9 のうち仕様外）

マルチクラス接近の CarIdx キー化と周回予算（**GTP連呼29回の本体**）、サイドコールの局面束ね（33回）、順位コールのブレンド中抑制、crash_check の一問化、約束回収の機構（プロンプト規律のみ実装済み）。**発話回数そのものの削減（110回→30回）は未着手で、体感への効果は最大**。

## Build 291公開候補 — Team Plan / Chief Mode / Phase F（Build・公開GO受領）

- 公開中は **Build 290**。今回の製品番号は **Build 291**（`Build 291 (Team Plan, Chief Mode, and trackside authority)`）へ採番した。同じ番号で中身の違うinstallerを作らない。
- Team Plan は、明示開始→2〜3項目の確認→人の明示確定→3 clean laps実測による小変更候補→明示承認→Chief relay handoff→Driver別の構造化結果保存まで接続した。裸の「はい」はPlanを確定・変更しない。候補をhandoff確定事項にしない。
- Chief Engineer Mode 有効時だけTeam Planを動かす。各PCの`このPC: Driver N`／roster／現在担当を使用し、確定Plan・実測・stint summaryを次Driverへ渡す。Chief無効の単独走行は既存挙動と保存領域を触らない。
- Phase F は、前後相対ペースを同クラス・CarIdx固定・freshな有効ラップだけで回答し、燃料shortfallからpit nowを作らない。Gap訂正はドライバー数値を実測として保存せず、対象／世代が変わる再観測まで保留する。Plan・実測・handoffは同じauthority snapshotを使う。
- 機械確認（Codex独立再実行）: Phase F 64/64、Team Plan 127/127、Chief cross-PC 19/19、Memory Action 28、Strategy Playbook 39が合格。`preflight.sh`の製品内スイートは合格したが、この実行環境ではHTTP server bind（`EPERM 0.0.0.0:3901`）と外部deploy確認が不可。外部有料API呼出なし。
- Gate 7対象: `auth.js`変更あり。push後にRailway反映と`./verify-deploy.sh`で同一SHAを確認する。Gate 5 artifact確認、公開後のGate 6 WindowsとGate 8 iRacingは別証拠であり、未確認を合格扱いしない。

- RBR実走の「後ろの方がペース早いな」に、総燃料不足だけを根拠として「ピット優先」と返した。`engineer-card`は`pit_timing_authority.decision==='pit_now'`以外では早期ピットを言えないようにし、`hold/pit_later`では「前後の相対ペースは未確定、Planを維持」と返す。RBR値（28.7L / 必要50.4L / Plan A / 10周）を回帰化。
- 同実走の燃料質問で出た「最終目安0周目、あと0周」は、具体的な選択A/B/C windowよりgeneric endurance horizonを優先した誤り。選択済みの実行可能Planをtiming authorityの正本とし、真のmulti-stop（future stop 2以上）だけが代替する。
- スタート時の履歴／Plan A/B/C一括説明は161文字・約38秒で後続案内を約26秒滞留させた。gridでは一文だけに短縮し、詳細条件はクリーン3周後の実測更新で扱う。
- 機械確認済み: Engineer Card 113/113、Plan Fuel Authority 23/23、Strategy Playbook 39、Local Intent Router 53/53、Python compile、`git diff --check`。外部有料API呼出なし。未解決のまま作業継続: ドライバー証言と矛盾したRBRの後方GAP 0.1秒の入力正本、前後（将来は全同クラス）相対ペースauthority、実走結果と5レース平均の成績正本。Build／push／公開は未実施。

## Build 290公開完了 — 8/28 RBR実走会話・個人成績・デブリーフ修正

- RBR実走ログで、保存名`spielberg gp`と表示名`Red Bull Ring`が別コース扱いになり、過去走行があるのに「今回初めて」と案内した。GPレイアウトだけを明示alias `spielberg:gp`へ統合し、履歴あり／なしの双方でLLMが「初めて」を推測しないtruth instructionを追加した。別レイアウトを広く統合しない。
- レース中の「直近Nレースのインシデント平均」は、ログイン中の本人`userId`と一致する`pw_raceHistory`だけから最大10件を決定論集計する。指定件数不足または本人identity不明は推測せず不足を返す。Build 289実走の5レース質問は、5件あれば合計と平均を即答する。
- `class_pos`を現在順位のBridge権威として受け取り、首位車の`CarIdxLap`をBridge `leaders.*.lap`へ追加した。「トップは何周目」を広いleader GAP判定／残り周回判定より先に処理する。
- デブリーフは表彰台以外でも、結果値より先に短く労う。質問は最大1問とし、今回の実測incident、実pit entry lap、前後半pace差がある時は定型poolより優先して、そのレース固有の分岐を聞く。Lunaの誤案内への抗議（「初めてじゃない」「前にも走った」「回答を持っていない」等）は回答として保存せず、通常会話／訂正経路へ返す。
- 危険車両機能は削除されていない。現在も同クラス隣接車を`iRating <= 1300`または`1.0 <= SR <= 2.0`でsession動的判定する。`nyaji`氏の名前／IDを永続保存したGit履歴はなく、個人watch記憶は未実装。名前だけの永久ラベルは誤認・同名・訂正不能のため追加しない。実装する場合は本人申告→iRacing customer ID照合→確認→期限→訂正／削除まで一単位とする。
- 機械確認: Local Intent Router 53/53、Session Memory tunnel 121/121相当（RBR alias 2件と初走行truth gateを含む）、Memory Action Layer 27件、Evidence Debrief 47/47、GAP answer queue 49/49、Python compile、`git diff --check`、sandbox外の`./preflight.sh`は全項目合格して`✅ 出荷可`。外部有料AI API呼出なし。
- 明日の耐久について、Build 289実走では燃料pit-now guardがholdを維持したが、事故により予定戦略pitそのものは未検証。既存の耐久燃料／Chief handoff回帰はpreflight合格。ただし3宅3PCの実relay、実機音声、計画pit完遂は機械試験では保証できない。公開Build 290でWindows／iRacing実走確認する。
- Claude Code初回独立確認commit `739959f`はRBR aliasの閉じた集合を実挙動5/5で反証し、コード変更後もBuild 289表記のままだったP1を1件検出した。CodexはBridge正本を**Build 290**へ採番し、版番号テストも289残存を拒否するよう更新した。
- Claude Code再確認は、個人成績6/6、leader lap 5/5、抗議と通常回答13/13、事実ベース質問20/20、Build 290採番一意性に合格し、**P0/P1/P2 0件、Gate 4合格**。Codexも追跡コード差分が採番commit以降ゼロであること、Local Router 53/53、Evidence Debrief 47/47、PTT 15/15、Bridge compile、diff checkを再確認した。この時点ではartifact以降を未実施として停止し、その後のYujiのBuild GOを次項で記録する。
- private candidate `a9988ec790f0b3ca569d5f7a067e81ef3e0e9b02`はworkflow `33142893350`とClaude Code独立再取得でGate 5合格、P0/P1/P2 0件。公開後照合でBridge単体workflowだけpygame未同梱を検出し、Desktopと同じ依存・`--hidden-import pygame`へ修正したcommit `7c1ad59facd98702bad648b378953e8c90ecd1b8`を最終公開SHAとした。Desktop workflow `33152767207`、Bridge workflow `33152765158`は同SHAでsuccess。Desktop Releaseは**Build 290**、公開installer 3本は100,684,274 bytes / SHA-256 `5d6d343179bc2d4094ee09131aa0293b2860105ad71206eec64f1391211892ee`で一致。公開installerを実取得・展開し、`buildNum=290`、runtime 10/10、app.asar 4,292,914 bytes / `431c94ffbbb1d7c7b0e5d7a22a6f395428b3d2367ecd277a0f9bbad201b8fcaf`、同梱Bridge 17,027,723 bytes / `d07e8fd1986d71ca6f73ca27daf3d4f975568cd0cf28a3d981071158ff81edf3`を確認。Bridge単体は17,027,111 bytes / `80fdb41dbc79f563ef07d3e4e5db5b7014be1e0464b75a8b17f00cf42109bdf8`、installerは16,321,781 bytes / `d0c0b22101a345a77ade4ad941a5eea6a44b5b0a7b86ee1e757985bda56f2dd8`で、pygame／SDL DLL群を確認した。server差分なしでGate 7はN/A。Gate 6 WindowsとGate 8 iRacingは公開Build 290で確認待ち。

## Build 289公開完了 — 会話/STT揺れ・Truth Gate修正

- 八木さんのBuild 287実走ログを再生し、`ベストラップ いくつ？`ではGoogle STTとLLM回答が正しかったのに、rendererのTelemetry Truth Gateが`7:50.356`を遮断して`了解。`へ落としていたことを確定した。`ルナ データいってる？`も同型で、LLMの正しいライブ回答をgateが遮断していた。
- Bridge権威の`best`とライブ接続状態をlocal intentへ追加し、`ベストラップ わかります。`の質問符号欠落、`コースデータは空いてる？`の`入ってる→空いてる`揺れも同じ決定論経路で回答する。通常の`コースは空いてる？`やデータ分析依頼、`than。`は誤って運用intentへ寄せない。Truth Gateへ到達した場合もbest/dataを最新Bridge値から再構成し、未知の数値質問を無関係な`了解。`へ変えず短い再質問を返す。
- Google STTの日本語ヒントへベスト／データ状態／setup主要語を追加し、Googleが返したconfidence・文字数・録音秒数・言語だけを`PTT_STT_RESULT`へ記録する。新たな個人別発話全文・音声・癖は保存しない。confidence欠損は0と偽装せずnull。API呼出回数とSTT秒数は増えず、best/data即答はAnthropic呼出を削減、TTS経路は従来どおり。
- 機械確認: `tests-local-intent-router.js` 46/46、`tests-telemetry-truth-gate.js` 60/60、`tests-ptt-capture.js` 14/14、`tests-gap-answer-queue.js` 49/49、関連燃料/GAP/キャラクター回帰、`node --check server.js`、`git diff --check`は合格。変更途中の全`preflight.sh`も外部有料AI呼出なしで合格し、その後のSTT response parser分離は上記14/14と構文検査で再確認した。
- Claude Code独立レビューcommit `fe897fa`はP0/P1 0件、P2 2件で条件付き合格。P2-1の短いSTTヒント`トー`は`トー角`へ狭め、P2-2の番号衝突はBridge正本を`Build 289 (voice question resilience and STT diagnostics)`へ採番した。Claude再確認commit `3648a76`は変異3/3を含めP0/P1/P2 0件で合格。Codexも同commitがMD追記だけでコード差分ゼロ、PTT回帰15/15、server構文、Bridge compileを再確認した。`server.js`変更を含むためGate 7対象。Build 288 artifact（SHA `2ba8ce4...`）には本修正が入らず、同番号で再Buildしない。
- YujiのBuild 289 GO後、対象SHA `5f9ef109fd10430bcee0764dd68633fb9e343c6c`を`build/289`へpush。private workflow `33130906223`はsuccess、Publish skipped。artifact `OMORAY-PITWALL-Desktop-Build-289-20260828-0049`（302,051,442 bytes）をCodexが全量取得・展開し、installer 3本同一（100,680,483 bytes / SHA-256 `03a5f08158819cbbb69594d031f9b6bfa81a6b6603bfeb5c235ad6939a525c7a`）、asar 10/10・対象SHA一致・buildNum 289、Bridge Build 289・旧288なしを実測した。
- Claude Codeは別作業ディレクトリへartifactを独立取得し、Codex申告の全17項目を再計算して全一致、失敗0件でGate 5へ確認者署名した（commit `0d39f73`）。Windows引き渡しはBuild 289専用の`review/BUILD289_GATE6_WINDOWS_HANDOFF.md`へ差し替え済み（commit `15d1082`）。YujiのDeploy GO後、`main`の`a587940edd52af69cd09abbc75bafe909042b14f`をRailwayへ反映し、`./verify-deploy.sh`で本番SHA一致と保護経路の401を実測してGate 7合格。
- Yujiの公開GO後、Desktop workflow `33134346423`とBridge workflow `33134348071`を同じSHA `a587940...`で実行し成功。Desktop Releaseは**Build 289**へ更新。公開`OMORAY-PITWALL-Setup-latest.exe`を実取得し、100,681,743 bytes、SHA-256 `b45a85411fab8801d430badcf048736b6f88cf1cc6d44bbf0487055e453137f5`でRelease digestと一致。latest／日付版／旧互換版も同一。Bridge単体版`OMORAY-PITWALL-Bridge-20260828.exe`は10,392,797 bytes、SHA-256 `17beead3c12963df6cad47110eca01cb7d074229ef1dd25ff8aad338a1a11bcf`。公開後もserver SHA・保護経路を再確認して合格。残る未確認はGate 6 WindowsとGate 8 iRacing実走。

## Build 288候補 — 燃料timing権威／運転スタイルV1（未公開）

- 燃料はBridgeが毎telemetryで `pit_timing_authority` を生成する。現燃料の航続周回、完走必要量・不足量、選択Planの最終pit周、`pit_now / hold / pit_later`、A/B/C windowを同一契約に分離した。ローカル会話回答は総不足量を述べても、このtiming verdictが`hold`なら今周pitを勧めない。全キャラクター共通経路。
- 運転スタイルV1はBridgeで60Hz control値をクリーン周特徴量へ縮約し、raw sampleはrendererへ送らず保存もしない。invalid/pit/yellow/trafficをfail-closed除外し、本人best→本人安定周→本人確認基準→登録実測reference→一般傾向の順で出典を固定。一度に改善候補は1件、一般傾向では数値差を発話しない。
- rendererは認証ユーザー・track・car単位のcompact clean-lap profileだけを保持し、助言後の本人肯定時だけ `pw_driving_style_memory_v1` のactive条件へ保存する。否定、identity欠損は保存しない。Jamesを含む全キャラクターが同じanalyzerを通る。
- 内部確認: 新規JS 17/17、新規Python 3 tests、確認arbiter実挙動を含むGAP queue 49/49、燃料/戦略/router/runtime/記憶回帰は合格。Claude独立確認でP1（裸の肯定横取り）とP2 2件（空助言保存・range欠損例外）の解消を再生し、Gate 4はP0/P1/P2 0件で合格。外部有料API呼び出しなし。
- Build 288対象SHAは `2ba8ce4a72c4034e6b4c6af20eb41ce0fc007a12`、private workflow `33074707192` はsuccess、Publish skipped。CodexとClaude Codeが別作業ディレクトリでartifactを独立取得・再計算し、installer 3本同一、app.asar module 10/10、Build 288、同梱Bridge Build 288、対象SHA一致を確認。Gate 5は確認者署名済みで合格。
- 未確認: Gate 6 Windows、Gate 8 iRacing実走、Gate 9公開。Gate 7 serverは公開287との差分ゼロをClaudeが実測したためN/A。60Hz実機入力、yellow/traffic閾値、fuel/tyre条件差の妥当性、助言の有用性は未合格。Windows手順は `review/BUILD288_GATE6_WINDOWS_HANDOFF.md` を正本とする。

## 2026-08-26 Build 287 Luna自己反省記憶スライス（公開・更新導線反映済み）

- Build 286のRBRデブリーフを発端にした「訂正を次回へ返す」出口を追加。ただしLuna自身の発話を教訓として自動保存する初版は設計契約違反のため撤回した。`desktop/luna-self-memory.js` は、認証ユーザー・コース・車両が確定した時のドライバー本人による明示訂正だけを決定論的に候補化する。
- 別sessionまたは10分以上離れた同型訂正2回 → Lunaが一度だけ読み返し → 本人の肯定でversion 2の`active`へ昇格、否定なら`rejected`として再提案しない。同一場面の連続発言は2票に数えない。合意前candidate、旧assistant由来version 1、identity欠損、未来日時、90日超過、deletedは次回取得・戦略利用しない。「反省記憶を削除／元に戻す」で直近activeを削除できる。
- 自己反省記憶とDecision訂正の両方が確認待ちの時、裸の「はい／いいえ」を片方へ推測適用せず対象を聞き返す。保持上限ではdeleted → rejected → candidateをactiveより先に捨て、合意済み記憶を未確定候補で押し出さない。周回遅れタグも固定文だけを発話し、ドライバー自由文や数字をechoしない。
- 合意済み記憶だけを `pw_luna_self_memory_v1` read-back → 次回Strategy briefing冒頭の一回発話（`luna_self_memory`）へ接続。GAP精度、給油ウィンドウ先出し、周回遅れ説明を閉じたタグとして扱い、数字や自由文から戦略事実を作らない。
- 機械検証: `node tests-luna-self-memory.js` 18/18、renderer構文、`tests-evidence-debrief.js` 41/41、`tests-session-memory-tunnel.js` 118/118、runtime module status 11/11。外部有料API呼び出しなし。
- Claude Code独立再確認（`6fdf10d` / `2cf40d9`）でP0/P1/P2は0件、全JS・Python 305件・`preflight.sh`不合格0件。実装commit / 対象SHAは`717803478b6fac2c4eafd50613a9425692e13af4`。
- private workflow `32959088403`（push event）は成功、Publishはskipped。artifact `OMORAY-PITWALL-Desktop-Build-287-20260826-1037`（302,000,718 bytes）を全量取得し、installer 3本が同一SHAであることを確認。versioned installerは100,663,849 bytes / SHA-256 `88c7dbe8592b826fe732beafdf4401d2ebb07a52bf8b9d4b5e5be5da1479fd91`。
- 展開実測は`app.asar` 4,271,175 bytes / `51fcecf6e04b5aae5eec4f61ce0ffca1d4d2aa2926b14be0690b5ca1439124b6`、同梱Bridge 17,013,686 bytes / `61089b1a37fb05793f6ac3f98f46cabe1c330eac5aff8f260fca30ead075e633`。CI manifestと一致し、renderer由来runtime module 9/9（`luna-self-memory.js`含む）、`buildNum=287`、Bridge内Build 287、対象SHA正規化一致を確認した。
- Claude Codeがcommit `677a235`で同runを独立取得・展開し、installer / app.asar / Bridgeのbytes・SHA、Publish skipped、runtime module 9/9、Build 287、対象SHA一致をすべて再計算。Codex実測と全項目一致し、Gate 5は作業者・確認者分離で合格署名済み。
- 公開workflow `32970657576`（対象SHA `7178034`）は成功。`desktop-latest` Release名は`OMORAY PITWALL Desktop — Build 287`、versioned / Setup-latest / Desktop-latestの3資産は100,663,315 bytes / SHA-256 `ce9ae169444b7bb3eb1e39da80d9affe268fee3df9e32be4b9582da76b7053e0`で一致。公開artifactも`--published`実物検査で9/9 module、Build 287、対象SHA一致。
- 旧exeはRelease APIの最新日時版`20260826-1250`を検出し、`Current: Build ... → Latest: Build 287`の更新案内から`OMORAY-PITWALL-Setup-latest.exe`へ到達する。Windowsで旧exeを起動すれば更新して即テスト走行できる状態。server/auth/payment/public pageのコード変更は本Buildに含まない。

### 追加：反省記憶を戦略条件へ接続（未公開）

- `luna-self-memory.js` のタグを `strategy-playbook.js` のPlan B/Cへ渡す出口を追加。GAP精度の反省がある場合は `latest_gap_same_frame_required` を候補条件にし、BridgeがGAP・ペース・今周／次周復帰予測へ付けた同一 `snapshot_id` とGAP値の一致を実際の切替条件としてfail-closedで検証する。
- 給油ウィンドウの反省がある場合は `fuel_window_authority_required` を候補条件へ付与し、既存の決定論的 `fuelWindowStatus` 監視を次回Raceで自動起動する。ドライバー要求で起動した監視と自己反省起因をtraceで区別する。
- `renderer.html` は同一ユーザー・コース・車両の最新自己反省をプレイブック生成へ渡し、ID・タグ・適用条件を `MEMORY_ACTION` / `STRATEGY_PLAYBOOK` traceへ残す。既存のBridge権威・鮮度・復帰位置ゲートは緩めていない。
- 機械検証: `node tests-strategy-playbook.js` 39/39、`node tests-luna-self-memory.js` 18/18、`python3 irsdk-bridge/tests_pit_exit_forecaster_wiring.py` 14/14、`node tests-evidence-debrief.js` 41/41、`node tests-session-memory-tunnel.js` 118/118、`node tests-runtime-module-status.js` 11/11、構文／diff check 合格。外部有料API呼び出しなし。
- 未確認: Windows実機同梱、実iRacingでの次回自発発話、自己反省タグによる実戦Plan B/C再計算の有用性。まだcommit / push / build / 公開なし。

## ⚠️ 2026-08-25 Build 282 artifact の記録は無効（Gate 5 やり直し）

- 下記に記録した `OMORAY-PITWALL-Desktop-Build-282-20260825-0022` / SHA-256 `880a98b3...` は **`7bc5cb8` 由来**で、**スライス1（記憶→戦略）が入る前の版**。
- 実物を展開して確認した結果、その app.asar には **`session-memory.js` が存在しない**。現在のコード基準で検査すると `missing packaged runtime modules: session-memory.js` で失敗する。
- 起動もGAPも燃料も正常に動くため、**欠落は「Lunaが昨日の話をしない」という形でしか現れない**。出荷すると Yuji が1ヶ月待った症状と同じ見え方になる。
- **この artifact を Gate 5 合格の証拠として使わない。** HEAD（`bb5e9cf`）で作り直し、Gate 5 を再実施する。
- 判断待ち：Build番号を283へ上げるか282のまま作り直すか／push GO。



- 記憶→戦略の入口→出口が**初めて1本で閉じた**。`Bridge捕捉 → session_summary → pw_raceHistory → 決定論的取得 → 発話`。
- A スタート順位（`cur_ss 3→4` の一度だけ捕捉）、B 天候（毎フレーム保持しsummaryへ）、C setup_fingerprint / series_id（Bridgeが既に持っていた値をsummaryへ）。**新規計測はAだけ。**
- 新規 `desktop/session-memory.js` が取得層で、**数字を持つ唯一の場所**。LLMは記録も数字も選ばない。記録が無ければ空文字＝言わない。過去天候はLLMより先に答え、無ければ「無い」と言い現在値を代用しない。
- Codex独立確認で、認証ユーザー・車種・seriesの記録側欠損を「一致」と扱わず、90日超過・未来日時のrecordも除外した。過去の確定事実はLLM注入だけにせず、`memory_strategy_briefing`として字幕・speech queueへ先に直接投入し、LLMには同じ数字を言い直さないよう限定した。
- `tests-session-memory-tunnel.js` **72/72**（preflight収録）。変異試験にpackage欠落、queue未投入、暗黙P4化、別認証ユーザー、車種/series欠損、古いcache、未来日時を含む。外部有料API 0件。Windows実機・iRacing実走は未確認。
- **未確認**：Windows実機・iRacing実走。スタート順位はローリング／スタンディング／SC先導での実挙動が実走でしか確認できない。
- D（Decision ID）／E（サーバー正本）／F（訂正・削除）は**未着手**。commit / push / build / 公開すべて未実施。

## 2026-08-25 Memory→Strategy 製品判断

- 正本は`review/MEMORY_TO_STRATEGY_SHARED_UNDERSTANDING_V1.md`。Yuji決定により、Build 282をGate 5まで先に閉じ、その後Memory Action Layer実戦版v1へ入る。
- v1は認証ユーザー単位のサーバー正本＋ローカルcache。構造化Decision ID、条件、予測、実結果、採点、訂正履歴を保存し、生音声・会話全文・不要な生telemetryは原則保存しない。
- 成功戦略だけでなく失敗戦略も条件付きで次回利用する。誤った記憶は`disputed`で即時利用停止し、本人との読み返し合意後だけ訂正を有効化する。
- v1のセッション記憶は戦略結果だけに限定しない。同一ドライバー・車両・コース・日時へ、天候の実測要約、setup version/fingerprint、本人が申告した変更内容、変更前後の有効ラップ・燃費・タイヤ/挙動評価を同じ根拠鎖で結ぶ。iRacingまたは取込ファイルから得られないsetup数値は推測せず、本人申告として区別する。
- 保存だけで完了にしない。次回ブリーフィング、質問への過去値回答、戦略候補、Practiceのsetup協議、デブリーフ採点、訂正・削除までの各出口を受入条件に含める。過去天候については「現在値を代用しない」だけでは未完成であり、記録がある場合に同一条件の日時と根拠を伴って返すことを必須とする。
- 進行は二本立てに固定する。既定Phaseの完成スライスを毎候補で前進させつつ、実走P0/P1だけを同じ候補へ限定して修正する。バグ対応だけの連続BuildでPhaseを停止させない。局所修正がPhaseの共通データ契約へ属する場合は、単独moduleを増やさず共通契約へ統合する。
- privacy / terms / 事前明示・オプトアウト / 表示・訂正・削除 / 保持期間を同scopeに含める。Claude Codeが作業者、Codexが独立確認者。
- `AGENTS.md`の**Tunnel Completion Rule**を必須とする。Build 282のpackage/GAP修正を回帰基盤として保持し、Memory→Strategy、過去天候、setup進化を別々の片道patchにせず、source→権威判定→保存→取得→判断→発話/提案→実結果採点→訂正/削除まで同じ入口→出口マトリクスで接続する。空欄がある状態は実装済みと報告しない。

## 恒久出荷ゲート

- Build・出荷・公開の正本は`review/PITWALL_RELEASE_GATE.md`。作業者と確認者を分け、ソース、完成artifact、Windows、server、実走、公開取得物を別々に検査する。
- `preflight.sh`合格だけで出荷可としない。完成`app.asar`と同梱Bridgeを確認しないBuildは公開不可。
- **2026-08-25訂正**：Build 282 artifactの記録は無効。Gate 5は未通過として扱い、過去artifact、過去SHA、過去hashを次候補の証拠に流用しない。次のYuji Build GO後、現HEADから`publish=false`のprivate candidateを新規生成し、完成installer / `app.asar` / 同梱Bridge / bytes / SHA-256をゼロから検査する。

- **2026-08-25再訂正**：スライス1がBuild 282後に入っていたため、同じ製品番号のprivate artifactは配布不可。Build番号を**283**へ上げ、Build 283としてprivate candidateを新規生成・検査する。Build 282 artifact（run `32815638686`）は実体検査済みだが、番号衝突のためGate合格証拠には使わない。

- **Gate 5恒久化**：`build-desktop.yml` はprivate artifact作成時、完成installer・`app.asar`・同梱Bridgeのbytes/SHA-256、およびartifact内renderer runtime module照合を小さいmanifestとjob logへ必ず出す。巨大installer全量を毎回手で取得してから検査する待ちを出荷判定の前提にしない。

## Build 281 公開後実走で出荷欠陥を確認（2026-08-24）

- 8/24実走では、後方GAP質問直前のBridge telemetryに`gapBehind=33.8`、次の同質問時にも`gapBehind=52.2`が存在した。それでもrendererは`LOCAL_INTENT_BYPASS reason=unhandled`となり、サーバーのno-data回答へ落ちた。Lunaがデブリーフで「直前までデータが来ていた」と述べた内容はログと一致する。
- 根本原因は後方GAP計算ではなく、`desktop/renderer.html`が読む`local-intent-router.js`を`desktop/package.json`の`build.files`へ含めていなかったこと。公開Build 281のWindows installerにはローカル即答moduleが存在しない。さらに二重安全用の`fuel-plan-guard.js`も同じ理由で欠落していた。ソースを直接requireするテストだけではこの欠陥を検出できなかった。
- 修正候補ではDesktop直下のruntime JSをinstallerへ同梱し、テストでrendererの全ローカルscriptがpackage対象か検査する。Windows CIは完成した`app.asar`を直接列挙し、GAP routerと燃料guardが無ければBuildを失敗させる。実行時ログも`router_missing`と通常の`unhandled`を区別する。
- 同ログの「昨日の路面温度」は履歴値を取得しておらず、現在値23.3℃を昨日として返していた。履歴記録を確認できない時は現在値で代用しない決定論handlerへ変更する。
- 19:26:10の停止車両は`前方に停止車両。2.6秒。注意。`と実発話しており、この一件は成功。ただし全候補を網羅した証拠ではない。
- この修正候補は未commit・未build・未公開。次installerでは完成asarの証明とWindows実取得後の後方GAP即答を確認するまで完了扱いにしない。
- Claude独立再確認でGate 4通過、P0/P1は0件。完成asar検査はrenderer参照から全件派生、cost gateはpreflightへ追加、asar依存は明示、起動時module状態traceと過去天候の対象非依存fail-closedを追加した。Claudeの残P2-3も、`verifyPackagedRuntime()`本体を直接呼ぶ成功／欠落停止テストへ変更し、NSIS検査14/14、更新後`./preflight.sh`全項目で合格した。旧`desktop/dist`へ新検査を当てた`missing packaged runtime modules: fuel-plan-guard.js, cost-meter.js, local-intent-router.js`は、新candidateの失敗ではなくBuild 281以前の実欠陥を正しく捕捉した証拠。Gate 5以降のprivate artifact / Windows / iRacing / server / 公開確認は未実施。

## Build 281 公開時点の記録（2026-08-24、GAP・燃料・デブリーフ・危険車両ガード）

- 対象はBuild 280の8/24実走で再発した、GAP即答の不成立、微小燃料差による予定外P0ピット、デブリーフのピット周回創作、危険候補の優先度逆転。
- `review/BUILD281_GAP_FUEL_DEBRIEF_HAZARD_REVIEW_REQUEST.md` をレビュー正本とする。実走ログの事実、再生条件、反証すべき安全条件をそこへ固定した。
- 修正は、ライブRace PTTのローカルGAP回答をデブリーフより先に通すこと、Truth Gateで最新GAPを再構成すること、0.5L以内の予定ピット後不足を予定外P0にしないこと、実ピット事実だけをデブリーフへ渡すこと、危険候補をPBより優先すること。
- Claudeの初回差戻し（満タン補正／pit_events reset／境界／実書き戻し）へ対応済み。Memory Action v1はこのBuildに混ぜず次Buildへ分離した。
- 実装コミット: `de8980b`（`Build 281 harden gap fuel and debrief guards`）。GitHub `main` は同一SHA `de8980bfaef1ecaa20048eae82092eeb679c3007`。
- GitHub Actions: Desktop公開workflow `32708923554`、Bridge公開workflow `32708926810` はいずれも成功し、同一SHAを使用した。
- Desktop Release: `desktop-latest` の `OMORAY-PITWALL-Setup-latest.exe` を公開URLから実取得し、**100,623,735 bytes**、SHA-256 `393afb2474ebc6845eacb553ce6b3e8d469a6dc252adfcac19a76226791c22c7`でRelease資産と一致。
- Bridge Release: `bridge-latest` に `OMORAY-PITWALL-Bridge-20260824.exe`（10,372,811 bytes、SHA-256 `55341bb29e41e6cd32091fa7a063644838facab76f8b09073f686c84c37b811f`）およびSetup資産を公開。
- 残る実走確認: WindowsでBuild 281表示・自動更新取得、Race PTTの後方GAP即答、満タン容量時の小差燃料不足で予定外P0へ正しく移ること、停止車／危険車両がPBより優先されること。公開・機械試験とは混同しない。

## Starter Pass 商用導線（出荷候補・未公開）

- Stripe商品: `OMORAY PITWALL — Starter Pass`、一回払い **US$9.99**。Stripe Price ID は本番環境変数 `STRIPE_STARTER_PRICE_ID` に設定する予定。外部設定・公開は未実施。
- サーバー実装: `/api/starter/checkout` はサーバー固定の `mode: payment` だけを作る。決済成功Webhookはcheckout sessionを冪等キーに、30日権利とStarter専用のenforced利用量台帳をDBへ付与する。期限または利用量が尽きれば、既存の有料API認可で停止する。旧Founding会員の認可経路は変更しない。
- `/api/starter/status` は認証済みStarter本人だけに、失効日時と残利用量を返す。desktopはログイン後に残利用率・有効期限を表示する。権利判定は常にサーバー側。
- 公開ページのStarter Pass説明、welcome、terms、help、share、legacy subscription manageを一回払い／30日／自動更新なしへ更新。旧Founding価格セクションは非表示のレガシーHTMLとして残るが、イベントハンドラ対象外であり、Starter CTAは`/api/starter/checkout`だけを呼ぶ。
- 機械検証（外部AI／Stripe／Railway呼び出しなし）: `node tests-starter-pass-contract.js` 16/16、`node tests-five-day-access.js` 12/12、`node tests-stripe-entitlement-stop.js` 5/5、`node --check auth.js/server.js`、HTML parser、`git diff --check` 合格。
- 公開前に必要: Railwayに`STRIPE_STARTER_PRICE_ID`を設定、Stripe sandbox/liveでCheckout→Webhook→ログイン→期限／利用量停止を確認、Windows実機確認。commit/push/build/releaseはYujiの明示GO済み。

## デプロイ確認の手順（毎回やること・2026-08-19 新設）

PITWALL の更新は**2系統**あり、片方だけ確認していると「installer は新しいのに中身は古い」状態になる。

| 系統 | 中身 | 経路 | 確認方法 |
|---|---|---|---|
| exe側 | `bridge.py` / `desktop/**` | GitHub Actions → installer | workflow の成否・installer の bytes / SHA-256 |
| サーバー側 | `server.js` / `prompts.js` / `engineer-card.js` / `auth.js` | Railway 自動デプロイ | **`./verify-deploy.sh`** |

push した後、サーバー側に変更が含まれるなら必ず実行する：

```bash
./verify-deploy.sh
```

本番の `/api/version` が返す commit SHA とローカル HEAD を突合し、不一致なら失敗（exit≠0）する。
不一致だった場合は Railway の Deployments で最新デプロイの成否を見ること。**GitHub Actions が緑でも Railway は落ちうる。**

背景：Build 277 の発話短縮は `engineer-card.js`＝サーバー側にしか無く、Railway が反映していなければ exe を更新しても何も直らない。
それまで反映を確認する手段が存在せず、「push したから反映されているはず」だけで運用していた。

## Build 277 公開完了（2026-08-19）

- 実装コミット: `e108ba4`（Build 277）、デプロイ検証: `adf6efc`。
- サーバー側（発話短縮＝`engineer-card.js`）: **本番反映を実測確認**。`./verify-deploy.sh` で本番SHA `adf6efc` とHEADが一致。起動 `2026-08-19T02:14:23Z`。Railway障害の影響で反映まで約8分かかったが、失敗はしていなかった。
- exe側: GitHub Actions `32214106754` 成功（`publish=true`）。Bridge build `32202314408` 成功。
- 公開installer: `OMORAY-PITWALL-Setup-latest.exe` = **100,606,442 bytes** / SHA-256 `ca9f59a286143eb4afca60c024969d6ac9ddec6173841021aa6180c21255fbf8`。
  GitHubから実取得して照合済み。日付版 `OMORAY-PITWALL-Setup-20260819-0400.exe` と**ハッシュ一致**（latestが古い版を指したままでないことを確認）。
- **実走で残る確認**: 短縮後の発話が実際に3〜5秒で終わるか（7文字/秒の**推定**であり、TTS実測ではない）。他の決定論カード（燃料・順位・ピット等）の長さは未点検。

## Build 279 出荷候補: 前後GAP即答・条件付き能動GAP（未公開）

- 八木さんの8/22 St. Petersburgログで、`後ろとの差`の問い合わせ時にBridgeの`gapBehind=5.8`が存在したにもかかわらず、会話が`今、ここでは伝えられない。`へ落ちた。`desktop/local-intent-router.js`へ前・後ろ・前後GAPの決定論的回答を追加し、同じ音声認識揺れを含む`パンで後ろとの差。`も`後ろ5.8秒。`へ到達するテストを追加した。本当に無い時だけ、対象を明示して`後ろのGAPはまだ取れていない。`と返す。
- `irsdk-bridge/gap_call_policy.py`を新設。レース中の前後GAPが3秒以上隔たった二つの観測間で、25%以上かつ1.5秒以上変化し、0.8〜12秒の範囲にある場合だけ`gap_trend`候補を作る。Bridgeの既存舵角・ブレーキ発話ゲート、P4予算、4秒の鮮度破棄を必ず通すため、コーナー／ブレーキング中に新たに話し始めず、古くなった候補は捨てる。
- 機械検証: `node tests-local-intent-router.js` 19/19、`python3 -m unittest irsdk-bridge/tests_gap_call_policy.py irsdk-bridge/tests_gap_trend_wiring.py` 8/8、`python3 irsdk-bridge/tests_phase_ab_integration.py` 28/28、`python3 irsdk-bridge/tests_fuel_strategy_wiring.py` 25/25、Python compile、`git diff --check` 合格。外部API呼び出しなし。
- 未確認: Windows/iRacing実走で、質問の即答が低負荷区間まで保留されること、能動GAPが短いストリートコースで過剰にならず、変化した時だけ有用に聞こえること。

## Build 280 公開完了: 8/23アホ回答・古いGAPの再発防止

- Build 279実走で失敗した発話を、文言だけでなく経路で修正。Fuel Window将来コールはPC内の一回監視へ、`次のしゅ ピット`はピット判断へ、`ドライブする ペナルティ`は申告ACKへ接続した。完走目標、荒れたレースへの感想、ピット位置報告も古い会話履歴へ流さない。
- `今、ここでは伝えられない。`を製品handlerから撤去。未確認時は対象を明示し、Truth Gateの最後に聞かれていない燃料／GAP説明を加えない。
- 能動GAPは隣接`CarIdx`、incident、順位epoch、現在GAPを保有し、相手交代・接触・2順位以上の急変・停止車警告・発話直前の数値変化で破棄する。保留GAPは同一pollの最新スナップショット更新後にだけ再生判定する。
- 原価: 今回ローカル化したACK／Fuel Window経路はAnthropic会話APIを呼ばない。TTSは従来経路なので総原価ゼロとは扱わない。
- 機械検証: 8/23失敗固定再生10/10、Local Router 29/29、Engineer Card 110/110、Truth Gate 55/55、GAP 20/20、Python discovery 259/259、JavaScript全57 suite、HTTP 54/54、`./preflight.sh`出荷可、compile／`git diff --check`合格。
- 実装コミット: `70ea15d`（`Build 280 fix conversation routing and stale gap calls`）。Railway本番は`./verify-deploy.sh`でSHA `70ea15dc95cd28212db0e17e4096efdb63bc23e1`との一致を実測確認。
- GitHub Actions: Bridge公開workflow `32678561560`、Desktop公開workflow `32678563106`、いずれも同一実装SHAで成功。
- Release: `desktop-latest`は **OMORAY PITWALL Desktop — Build 280**。公開`OMORAY-PITWALL-Setup-latest.exe`を実取得し、**100,622,528 bytes**、SHA-256 `7a1c3a04096947f07ec9205c7fdd5854d273d2b18155785c2d3bc0b57f5a1382`でRelease資産と一致。日付版・旧互換版も同一ハッシュ。
- Bridge release: `OMORAY-PITWALL-Bridge-20260824.exe` 10,369,074 bytes / SHA-256 `cea0586adf10ad159bf6b429ba109d099d42eb5cd881c49efc3813f45e3d9e88`。
- 残るのはWindows起動後のBuild 280表示、実iRacingテレメトリ、Fuel Window一回コール、事故直後の古いGAP抑止、実音声の間合い。これらは公開済みと混同せず実走で確認する。

## Build 277 の中身

- 八木さん 8/18 実走（Build 276 / St Petersburg / Audi R8 LMS GT3）で、アンダー相談の回答が129文字・TTS4分割で**24秒**かかった。最初の声は665msで出ており、原因は遅延ではなく長さ。実測レート約7文字/秒、Yuji判断で許容は3〜5秒＝21〜35文字。
- `buildHandlingSetupAdvice()` を書き直し、5症状すべてを「最初の一手＋観測ひとつ」へ統一（understeer 18.4秒→4.9秒 / rear_grip 9.7→4.3 / oversteer 18.0→4.6 / tyre_degradation 18.7→4.7 / unspecified 15.4→4.9）。症状が特定できている時は聞き返さず、`unspecified` の時だけ絞る質問を1つ返す。部品名は略さない（「バー」→「アンチロールバー」）。
- `SESSION INFO DIAG` 警告が1セッション602回鳴っていた件：`si_len` は iRacing のバッファサイズ（524288固定）で実データ長ではなく、cap と比べれば常に真だった。**金銭コストはゼロ**（`log()` はstdoutとローカルファイルのみ）。判定を `cap_verdict == 'truncated_at_cap'` へ変更し、verdict変化時のみ記録。7/21 Monza・7/24 Road America から持ち越していた「切り詰めが起きているのでは」という疑問は、**起きていなかった**と確定。
- `tests-five-day-access.js` の既存失敗（HEAD時点で既発）を解決。原因は `applyPitwallAccess()` の**呼び出し回数が7**という壊れやすい検査で、実装が10に育ってズレていた。課金API fetch 9箇所はすべて認証済みで**実害なし**。回数比較を廃し、性質そのものを走査する検査へ書き換えた。
- **出荷ゲートの穴を塞いだ**：`tests-yagi-log-regressions.js` と `tests-five-day-access.js` は `preflight.sh` から呼ばれておらず、発話が18秒に戻る変更も認証が抜ける変更も素通りしていた。両方を preflight に追加。
- Codexレビュー: **P1修正後に承認**。P1（新設テストがリポジトリ直下実行で `FileNotFoundError`）は `__file__` 基準へ修正済み。P2（静的走査の限界・ブロックコメントや別記法）はBuildを止めず、**ASTベースまたは明示的経路表への強化を残タスク**として記録。
- 機械検証: `./preflight.sh` ✅ 出荷可 / JS 54 suites・Python 36 suites 全緑 / 変異試験11件すべて検出。外部AI APIは呼んでいない。
- レビュー文書: `review/BUILD277_SETUP_BREVITY_AND_AUTH_TEST_FOR_CODEX.md`
- **実走で残る確認**: 短縮後の発話が実際に3〜5秒で終わるか（現状は7文字/秒の**推定**で、TTS実測ではない）。他の決定論カード（燃料・順位・ピット等）の長さは未点検。

## Build 275 公開完了 / 次の耐久Chief候補は未公開

- Build 275 (`534b455`) は公開済み。交代時にピット実測タイヤを次担当PCへ渡し、グリーン後の左右安全コールを復帰。Build 275公開workflow `31944915278` 成功。公開installerは 100,605,844 bytes、SHA-256 `13d85a5165450c32d1c33af634cd72739fc338c010b88df01e39596d57d27e7e`。
- **現在の作業ツリー（未commit・未公開）:** クリーン3周後、3時間GT耐久の終盤スプラッシュ候補・最終給油ウインドーを前半から内部計画に持ち、Chief handoffへ共有する。最終スティントに入れる燃料量とウインドーだけを渡し、交通／復帰位置が実測されるまで前倒しピットを命令しない。Plan AもPlan BのFuel Window前から確立して共有する。
- 機械検証: endurance fuel 20、Plan Fuel Authority 17、Driver Handoff 156、Chief UI 20、cross-PC relay 13、endurance radio 10、fuel authority JS 24、strategy playbook 34、Python compile／JS syntax／`git diff --check` 合格。外部AI APIは呼んでいない。
- 次の実走確認: 3宅3PCで、(1) 3クリーン周後にPlan Aと終盤スプラッシュ候補が引き継がれる、(2) fuel window直前にのみ交通・復帰位置を使った判断になる、(3) 総必要燃料を即ピット根拠にしない、を確認する。

## Build 274 公開完了

- Chief Engineer Mode を同一PC限定のv0から、別PC・別宅の耐久チーム用 relay に拡張した。全員が同じ `Team Link Code`、同じ走行順、このPCの担当を設定する。交代したPCだけが確定済みの Plan／次ピット／給油量／燃料余裕／損傷根拠を共有し、指定された次ドライバーのPCだけが受信する。
- Team Link CodeはSHA-256 digestだけを保存し、共有データは最新1件・6時間で失効。各PCのライブ燃料を混ぜず、handoff packetの根拠付きスナップショットだけを渡す。
- 実装コミット: `2a27523`（cross-PC relay）、製品番号: `728ecf4`（Build 274）。GitHub Actions workflow `31930387769` 成功。
- Release: **OMORAY PITWALL Desktop — Build 274**。公開installer `OMORAY-PITWALL-Setup-latest.exe` は 100,604,106 bytes、SHA-256 `58d6ee0e607d598d4cd725c3619b3d5d6c4bafd4118b4fcbb2948981b6f9ff5e`。GitHubから実取得して照合済み。
- 機械検証: `tests-chief-cross-pc.js` 11/11、既存Chief 16/16、Driver Handoff 154/154、`./preflight.sh` 全合格（外部AI API呼び出しなし）。
- 実走で残る必須確認: 3宅・3PCで送信側の交代 → サーバーrelay → 次担当PCの一回だけの受信、同一handoff再生なし、誤った担当PCは受信しないこと。

## Build 273 公開完了

- Build 272の耐久燃料・無線修正を維持した上で、V3最初のLocal Intent Routerを追加した。Race中の燃料、レース形式、残時間/残周回、首位GAP、現在順位、短いACKは、最新Bridge telemetryがある時だけPC内で回答し、Anthropic往復を回避する。アンダーカット、ピット判断、自由相談はローカルで断定せずLunaへ残す。
- 長時間レースの総必要燃料（例: 約429L）は内部計画値として保持するが、それ自体を「この周Box」の根拠にしない。現在スティントの燃料レンジだけが即時ピット判断を所有する。
- 現在スティントのFuel Window T-1で「次周ボックス。通常給油。」、対象周で「この周ボックス。通常給油。」を一度だけ発話する。
- レース後半は、終盤スプラッシュ見込みと、回避可能な場合の1周あたりセーブ量を一度だけ提示する。レース前半はスプラッシュ判断を出さない。
- 「ゴールまでの数量が増えちゃってるぞ」を燃料handlerへ接続し、現在燃料と古いS/F時点の必要量を混ぜず、同じ時点へ補正して答える。
- 「Luna 今ポジション8位」は現在のチーム車両順位でACKまたは訂正する。完走後の順位変動コールは停止する。
- 一般的なno-data定型文を次のS/Fへ自動再登録しない。同じ「今、ここでは伝えられない。」の自動反復を止める。
- 八木さん12時間耐久のライブ速報で特定した `[PACE_CHECK]` の誤配線を修正。内部ペース監視を通常会話のPACE／燃料カードへ通さず、同じペース方向は1スティント1回だけ評価し、ピットコール成立中は無音にする。
- クリーン3周で実測燃費へ昇格した通知は1スティント1回に固定。以後のPlan B/C再計算は内部更新だけにし、成立条件が変わらない限り発話しない。
- 12時間などは「7時間45分」のように時分で話し、残り周回が10を超える場合は大きなS/F通過回数を無線へ出さない。
- `RACING → PLAYER_FINISHED` の直接遷移でも、自車チェッカー通知を保留・再試行して一度だけ届ける。
- `⚙ Settings` の `Lap Readout` 4択と `Chief Engineer Mode` に不足していた日本語／英語表示キーを追加した。

### 機械検証

- `./preflight.sh` — 全項目合格、`✅ 出荷可`。
- Python Bridge discovery — 237 tests合格。別形式の直接実行テストもFinal Lap 80/80、Bridge replay 19/19、Phase A/B統合28/28など全合格。
- Engineer cards — 105/105、耐久燃料純粋計算17/17、耐久無線・Bridge配線10/10、PACE反復抑止9/9、HTTP統合54/54。
- Cost Gate — 36/36。`external_anthropic_calls=0`、`external_google_stt_calls=0`、`external_google_tts_calls=0`。HTTP失敗試験もAnthropic SDKのローカルstubへ変更し、外部APIを呼ばない。
- `git diff --check`、Python compile、JavaScriptおよびrenderer抽出スクリプト構文を確認済み。

### 公開証拠

- 実装コミット: `402da66`（`Add V3 local race intent router`）、製品番号: `2f96eab`（`Bump desktop product build to 273`）。
- GitHub Actions公開workflow `31926883086` 成功。
- Release: `desktop-latest` は **OMORAY PITWALL Desktop — Build 273** を表示。
- 公開installer: `OMORAY-PITWALL-Setup-latest.exe` 100,604,097 bytes、SHA-256 `7a41ddea2b17a2c33e3e28db833d4cf2d479c23be7c048632aeaf04426d03ec8`。GitHub Releaseから取得して照合済み。

### Build後の実走確認

1. Monza 20で「ゴールまでの数量が増えている」に燃料handlerが最新値で短く返すこと。
2. 給油前にT-1、対象周、給油後の次スティント予測が各一度だけ発話されること。
3. 長時間耐久序盤で総必要燃料を「この周Box」の根拠にしないこと。
4. レース後半のスプラッシュ予測が実際のサービス回数・残量変化に追従すること。
5. 自車チェッカーを一度だけ発話し、その後に順位上下・燃料戦略を発話しないこと。
6. タイム読み上げ後に「今はペースアップよりピット優先」を周期的に繰り返さないこと。同一スティントでクリーン3周／Plan B/C再計算通知が繰り返されないこと。
7. 音声の自然さ、舵角／ブレーキ中の間合い、実iRacing SDK接続は機械テストで実証していないため実走で確認する。

次はBuild 272の実走確認。Windows側でBuild番号、Bridge自動開始、実iRacingテレメトリ、音声の間合いを確認する。

## Build 271 公開完了

- Chief Engineer Mode v0、Fuel Window T-1判断、Plan A/Bの対象周BOX callを実装。
- `⚙ Settings` で走行順3名・現在担当・ON/OFFを保存し、Race中の本人 `ACTIVE → DRIVER_HANDOFF` だけでローカル引き継ぎを発話する。
- Plan Bの旧「1周延長」をFuel Window起点の条件付きアンダーカットへ統一。
- 内部実測: Chief Engineer 16/16、Driver Handoff 154/154、Engineer Cards 94/94、Bridge再計算75/75、全`preflight.sh`合格・`出荷可`。
- 詳細証拠: `review/BUILD271_CHIEF_ENGINEER_AND_FUEL_WINDOW_EVIDENCE.md`。
- 別PCの次ドライバーへ送るチーム共有クラウドは未実装。v0は同じPC上のLunaによる引き継ぎ。
- 実装コミット: `db9ce61`（`Build 271 add Chief Engineer handoff and fuel window calls`）。
- 公開workflow: `31863165606` 成功。
- 公開installer: 100,595,692 bytes、SHA-256 `f01ba76c5d82b1701bcc5d62bba4a59777a7231e3cdebf49580c24fa6063751a`。

## 公開済みの基準点

- リポジトリ: `eebei/english-voice-app` / ブランチ: `main`
- 公開済みビルド: **273** — コミット `402da66` / `2f96eab`（V3 Local Intent Router / 製品番号273）
- 公開インストーラー: `https://github.com/eebei/english-voice-app/releases/download/desktop-latest/OMORAY-PITWALL-Setup-latest.exe`
- GitHub Actions の公開Windowsビルド: `31926883086` 成功。
- 公開後の URL 取得を確認済み: 100,604,097 bytes、SHA-256 `7a41ddea2b17a2c33e3e28db833d4cf2d479c23be7c048632aeaf04426d03ec8`。

Build 270 は、Build 269 のピット直後燃料余裕・短いピット追加入力・ピットサイクル中順位コールの修正を含む。その上で、デブリーフ継続質問、質問数の圧縮、発話診断、利用者向けの秘匿情報を伏せた診断ログを追加する。

これは Windows 側の更新受信確認、実 iRacing テレメトリ、音声の間合い、ドライバーにとっての有用性を実証するものではない。これらは実走で確認する。

## Build 270 の運用品質改善

既存の未追跡ファイルやレビュー成果物を、この変更群に混ぜない。意図した変更は以下。

- `desktop/memory-action-layer.js`, `desktop/renderer.html`
  - 同一ドライバー・コース・車両に一致するデブリーフ記録があれば、汎用的な聞き取りを繰り返さず、次回は過去の要点を一つだけ引き継いで尋ねる。
  - 選んだ聞き取りはローカルに記録し、同じ過去回答を繰り返し尋ねない。
  - 初回デブリーフは最大二問。製品へのフィードバックは従来の頻度を保ち、走行根拠として転用しない。
- `desktop/renderer.html`, `tests-speech-latency-trace.js`, `preflight.sh`
  - ドライバー向け発話ごとに、キュー投入、TTS 開始、再生開始、破棄の経路を、優先度・生成元とともにローカル診断ログへ残す。
  - これは計測の配線であり、`300ms` や `500ms` を未測定のまま約束するものではない。
- `desktop/main.js`, `desktop/preload.js`, `desktop/renderer.html`
  - `📦 診断ログ` は、現在セッションを秘匿情報を伏せた形でデスクトップへ保存する。保存先を開くだけで、外部送信はしない。
- `public/pitwall.html`
  - Super Formula、INDYCAR、GTP/プロトタイプ、言語別プログラムの公募および無料アクセス案内を公開ページから外す。
  - 現在の公開対象を GT3 / ロードコース、実測燃費・ピット・安全・デブリーフとし、今後のクラス対応やセットアップ助言は明確に分ける。
  - デスクトップ利用者が Bridge を別途ダウンロードするという旧案内を修正する。デスクトップアプリには Bridge が含まれ、起動時に開始する。

## 既存アーキテクチャの事実

- デスクトップアプリは起動時に同梱 Bridge を開始し、Bridge は iRacing を監視してライブテレメトリが可能になれば接続する。
- レンダラーには既に優先度キューがある。P0 安全、P1 危険、P2 手順、P3 戦略、P4 情報、P5 会話。高い優先度は低い優先度だけを中断できる。
- Memory V2 はドライバー・コース・車両に紐づくデブリーフ根拠を保存・再読込し、一致履歴を暫定燃費および Plan A/B/C に利用する。今回の変更は、その継続性をドライバーにも一問の形で見えるようにするもの。
- 現在の更新は「更新検知と、利用者が押すインストーラーリンク」であり、無操作の差分自動更新ではない。本当の自動更新は署名済み更新フィードと差分更新の設計を要し、セキュリティ確認を含む別プロジェクトとして扱う。

## この変更群で完了した検証

- `node tests-memory-action-layer.js` — 26 チェック成功。
- `node tests-evidence-debrief.js` — 41/41 成功。
- `node tests-speech-latency-trace.js` — 3/3 成功。
- `node tests-desktop-state.js` — 9/9 成功。
- `node --check desktop/main.js`、`node --check desktop/preload.js`、レンダラーの抽出スクリプト構文、`git diff --check` を確認済み。
- これらのテストは Anthropic、Google STT、Google TTS の実運用 API を呼び出していない。

## 実走で残る確認

1. ビルド / Windows: 旧ビルドへ上書きインストールし、表示 Build 番号と Bridge 自動開始を確認する。
2. iRacing: 実機で検出からライブテレメトリ状態へ変わることを確認する。
3. 無線: 停止車両または並走車両のコールと通常会話を一件ずつ採取し、`SPEECH_LATENCY` の優先度・生成元・経路を確認する。数値目標は実測前に断定しない。
4. デブリーフ: 同じ車両・コースを完走し、焦点を絞った一問に答える。次の同一条件セッションで、旧アンケートの繰り返しではなく別の継続質問になることを確認する。
5. 診断: `📦 診断ログ` を押し、デスクトップに `OMORAY-PITWALL-support-*.txt` ができること、外部共有前に秘匿情報が伏せられていることを確認する。
6. ホームページ: 所有者承認済みの別デプロイ後、PC とモバイルで表示確認する。

## 現在の商用・製品対象

- 2026-08-16以降の次期アーキテクチャを **OMO-PW V3** と呼ぶ。RaceLab型のローカル計算・再利用データ・低限界費用を取り入れ、クラウドAIは双方向の状況判断、相談、作戦変更に集中させる。V2実測との原価比較とKPIは `docs/OMO_PW_V3_COST_MODEL_20260816.md`。
- V2の現状、V3で変更する境界、RaceLabから取り込む候補と非採用候補は `docs/OMO_PW_V3_CHANGE_AND_RACELAB_BENCHMARK_20260816.md`。これは判断資料であり、V3実装・料金変更はまだ行っていない。
- 販売・検証の第一市場を日本へ切り替える。日本語で導入と実走改善を集中し、次にブラジル等の熱量が高い地域を一地域ずつ展開する。広い英語圏へ同時に薄く売らない。
- 最大目的は「SIMドライバーが、リアルレースで人間のレースエンジニアと走る感覚を体験すること」。ピット側の診断画面は必要でも、ドライバー側へ別の分析ダッシュボードを増やすことを商品中心にしない。
- 中核: GT3 とロードコースのレース運用 — 実測燃費、ピットタイミング、レース文脈、安全コール、簡潔な無線、デブリーフ。
- GTP/プロトタイプ、Super Formula、INDYCAR、オーバル、ダート、深いセットアップ助言を、現在提供済みの機能として販売しない。
- 今回は料金、紹介、無料期間、利用権に触れていない。本番の料金・トライアル・紹介ロジックは変更していない。
- DREの現行公式機能・料金、PITWALLの8/9〜8/14実測原価、iRating別ターゲット仮説をまとめた日本語の正本は `docs/DRE_OMORAY_COMPARISON_20260815.md`。初期ICPはRoad iRating 1,800〜3,000を中心とするGT3・IMSA・耐久の本気層。差別化は記憶そのものではなく、画面を増やさず「今必要な一つの判断」に絞る品質で検証する。

## 次の作業

1. V3の最初の実装スライスとして、Race中の **燃料・レース形式・残時間/残周回・首位GAP・現在順位・短いACK** をPC内 `Local Intent Router` で回答するようにした。曖昧なピット指示、アンダーカット等の作戦選択、自由相談はローカルで断定せず、従来どおりLunaへ渡す。これはAnthropicの往復を避けるが、通常音声はまだ既存TTS経路を使う。
2. `node tests-local-intent-router.js` — 14/14。燃料・形式・残時間/残周回・GAP・順位・ACKの権威値、未確定のfail-closed、作戦判断をLunaへ残すこと、rendererの実接続を確認。外部APIは呼ばない。
3. 次に、Windows/iRacing実走でローカル回答が数値・タイミングとも自然か、そして作戦相談が誤ってローカル化されずLunaへ渡ることを確認する。
4. 本当の無操作自動更新とストリーミング TTS は、別の安全確認付き設計として進める。

## V3: 2027年1月の公開判断へ向けた確定方針（2026-08-16）

- 2027年1月は「開発完了日」ではなく、日本市場への段階公開を判断できる水準に到達するゲートとする。8月末に仕様と評価基準、9月末にRace中体験、10月末にデブリーフ継続性、11月末にローカル機能、12月にクローズド実走・免責・料金・失効導線の検証を終える。
- **Race中の無線:** 長い説明を禁止する。`状況 → 短い提案 → Driverの短い回答 → 実行/確認` を基本単位とし、必要性・優先度・割込み可否を判定してから発話する。
- **デブリーフ:** 感想文を出さない。良かった一点は短く伝え、根拠のある弱点と次回試す一点を示す。Driverの反論・補足を記録し、同じ車・コース・条件で次回の問いと助言に反映する。
- **ドライバータグ:** RaceLabから採る最初の機能候補。公開の危険人物判定ではなく、Driver個人のローカル注意メモとして開始する。自動断定・他利用者への共有・評判スコア化はしない。
- **セッション自動認識・同時起動:** iRacing起動/セッション参加に合わせ、PITWALLと必要なBridgeを起動・準備する方向で設計する。RaceLab型のツール管理を参考にするが、複数アプリを制御する大型ランチャーを製品の中心にはしない。
- **RaceLabから採るもの:** セッション自動認識、レース前の注意事項、個人タグ、繰り返し処理のローカル化。採らないものは、情報量を増やすための大型ダッシュボードと常時クラウド分析。ドライバーの画面を増やさず、音声による判断支援を商品中心に保つ。
- **モデル最適化:** V3はモデル全交換を決めていない。Race中はHaiku 4.5を基準に、Grok 4.3（reasoning none）等と、実走ログの正確性・短さ・人格・遅延・実費で比較する。Brief/DebriefはSonnet 4.5を基準にGrok 4.3/4.5等を比較する。提供終了済みのGrok Fast系を単価比較や実装候補に使わない。料金・提供可否は必ず各社公式情報を確認する。
- **無線研究:** SFgoの日本語チーム無線を、状況・指示・復唱・次判断という会話構造の手本として観察する。契約コンテンツの録音、文字起こしの転載、固有表現・音声の流用、学習データ化はしない。
- **V3の評価軸:** 各機能は、レース前・中・後のどこでDriverの判断を良くするかを説明できる場合だけ採用する。毎月、実装量ではなく実走で判定できる成果物を残す。

### 2026-08-28 原価削減・V3方向性ゲート

- 8月28日までに、V3を完成させるのではなく、V2実測から「ローカルへ移す処理」「AIを残す双方向判断」「用途別モデル候補」「利用者1人・1レース・1時間あたりの原価」を比較し、実装方向を確定する。
- 対象証拠はYuji、八木さん、まーぼー、ダート君の既存・追加実走データ。テスターには新しい管理作業を求めず、可能な範囲で診断ログ一式と、長い/遅い/役立った/不要だった発話の短い所感だけを受け取る。
- 8/18〜20: V2のAPI・TTS/STT・サーバー原価と発話回数を利用者/セッション別に再集計し、未計測部分を特定する。
- 8/21〜23: DRE/RaceLab型のローカル化候補を処理単位で分類し、ローカル判定・キャッシュ・クラウドAIの境界案を作る。
- 8/24〜26: 保存ログを使って候補モデルとローカル処理のリプレイ比較を行う。正確性、短さ、人格、遅延、実費を同じ入力で測り、外部有料APIの無断テストはしない。
- 8/27: 実走所感と計測を統合し、品質を落とさず削減できる範囲、残る不確実性、9月実装順をまとめる。
- 8/28: Owner判断用に、V2実測、V3想定、削減率レンジ、品質リスク、採用/不採用案を一つの比較表で提示する。料金変更やモデル全交換は、このゲート前に行わない。
# 2026-09-05 午前 — Build 296実走からBuild 297へ

- Yujiは午前中に公開済みBuild 296でテストレースを実施する。
- 回収ログでGAP、Memory Brain、聞き返し、訂正、古い情報の撤回を解析し、その結果をBuild 297へ反映する。
- Build 297は「レース会話成立」を最優先とし、自然な日本語を閉じたEngineer Commandへ変換するピット音声操作を最初の縦切りにする。
- 初期候補はタイヤなし、4輪交換、Xリットル、満タン、ゴール時3L残し、設定確認、変更・取消。
- ゴール時3L残しは周回マージンへ丸投げせず、Bridgeの実測値を用いて決定論的に計算・検証する。
- 現在の記憶はPC内のElectron `localStorage`であり、ユーザー可視の専用フォルダ正本は未実装。
- 詳細指示は `review/PITWALL_SHARED_WORKING_LOG.md` の「2026-09-05 07:07 JST」、走行項目は `review/RACE_CHECKLIST_BUILD296_20260905.md` を参照。
- Build／公開は別GO。まずBuild 296実走ログを解析する。
- 追加申告: 9/4実走で自発GAPの音声とOverlayの数字が頻繁に不一致、数字も固定的に感じた。コード上、Overlay表示後にTTSキュー内だけGAP本文をrebuildしており表示へ反映しない欠陥を確認。最終TTS本文もログへ残らず個別照合不能。Build 297要件として同一発話IDで候補・Overlay・最終TTSを記録／一致させる。詳細は共有ログ末尾。

# 2026-09-05 夕 — 公開Build 298実走事後Gate不合格

- Build 298実走（Le Mans／Mercedes-AMG GT3）をログと公式resultで照合し、最優先のレース会話成立を不合格とした。公式結果はRace incidents 8、12 laps、overall 21位、class 8位。
- PDDPは過去10件から平均Incidents 1.7を発話したが、採用各レースのidentity・値・集計がtraceに無く独立検証不能。車・コースのMemory／Decision／Setupは同時に`no_matching_record`。次は直近5件を証拠化し、増悪時のみ事実＋一行動へ短縮する。
- GAPは12回中10回がTTS直前rebuild。うち8回で初期本文と最終値が0.6〜2.0秒変わり、Overlay／会話側の初期本文と音声最終本文が不一致。最終authority確定後に本文を一度だけ作り3出力へfan-outするまで未完。
- 残周回は自動「残り5周」が1回ある一方、直接質問2回は周回を返せず、確認表現はpit decisionへ誤分類。自動callと質問回答が同じauthorityを共有していない。
- MemoryはOFFではなく、燃費履歴・PDDP・Memory Brain・Decisionが分断。Plan未確定、Driverのpit申告後も旧Plan／誤った不足燃料を返し、debriefの戦略指摘には保存ACKだけを返した。
- 次はBuildを増やさず、保存ログreplayでPDDP・GAP・残周回・Plan継続の失敗を赤にしてから、Claude実装→Codex Gate 4。詳細指示と受入条件は`review/PITWALL_SHARED_WORKING_LOG.md`末尾。コード変更・commit・Build・公開なし。

# 2026-09-05 — 9月Luna-only会話完成モード

- 9月の新規会話開発、実走評価、記憶品質の基準キャラクターをLunaへ一本化する。他キャラクターは削除せず既存UI・設定・最低限の回帰を維持するが、性格別の新規調整は一時凍結。
- LunaでBefore／During／After／Next raceをつなぐ会話セッションを完成させる。数値authority、topic selector、Plan、memory identity、final utteranceはキャラクター非依存のEngineer Coreとして実装し、Luna固有層は口調・簡潔さ・関係性に限定する。
- Lunaの実走合格後、共通Coreを他人格へ展開し、人格層だけ再構築する。複数人格を中核品質より優先しない。詳細は共有ログの同日Founder方針。料金・公開・販売施策の実行承認ではない。
- Webサイトとデスクトップ内の選択画面もこの方針へ揃えた。Lunaだけを現在の開発・選択対象として表示し、他人格は削除せず、小さくグレー表示して「2027年登場予定」と明示し選択不能にした。料金欄の「All 4 engineers」表記もLuna日英対応へ修正。
- UI契約テスト `tests-luna-2027-ui.js` を追加し、`preflight.sh`へ登録。32項目合格、HTML内script構文・`git diff --check`合格。Webはローカル表示確認済み。Windows/Electron実機、exe作成、本番デプロイは未実施。

# 2026-09-05 Founder scope lock — minimum real AI Engineer

- 次の完成区間を **安全コール（反射）／GAP／燃料・ピットウィンドーの確認返答** に固定する。新しい広域機能を増やす指示ではない。
- 目的はスポッター化ではない。創業者の最終目標は変わらず、**リアルの担当エンジニアが行う動きをAIで再現すること**。この3領域を、事実取得から判断・発話・Plan維持・変化時の再判断まで貫通させる最初の縦切りとする。
- 反射層は決定論的・即時。GAP／燃料／ピット計算は権威値を決定論的に作る。AI Engineer層は数字を維持し、重要な証拠を選び、合意Planを保持し、状況変化がPlanへ与える影響だけを短く伝える。
- 実装順は `確認返答の成立 -> 合意Planの継続 -> 状況変化検出 -> Plan影響コール -> 複数案比較`。セットアップ全般、動画比較、レース全体戦略への拡張は、この縦切りの実走合格後。
- 第一完成条件は、安全割込み、正しい対象・値のGAP回答、燃料／ピットウィンドー回答、Plan合意、後続ターンでのPlan維持、変化時のみの理由付き更新、最終実音声＝Overlay＝会話記憶の一致。
- 外部テスター2名は一時休止。現段階の検証費を使わず、まずYuji本人の実走で信頼性を上げる。復帰時期は別途Founder判断。
- 詳細: `review/FOUNDER_SCOPE_LOCK_MINIMUM_REAL_AI_ENGINEER_20260905.md`。
