# OMORAY PITWALL 引き継ぎ

## 10/25 Build306 公開済み（Desktop/Bridge・field-test candidate）：独立artifact確認なし・Owner判断で公開

**公開SHA `896f47d2d8eabb629c8de12ebc86f31be61a67d8`、Desktop/BridgeともBuild306**（両Release名306・両rolling tag=同SHA・prerelease/draftなし・desktop-latestがLatest）。Codexが5時間制限で独立artifact確認（Gate4/5）を取れず、Ownerが公開GO。**Gate4/5の独立署名は無い**＝Claude(release operator)の検査のみ（`operator-gate5-readback.json`）。私側検査：全preflight 147/0（exit0・offline guard・有料API0）、Desktop verify-artifact（installer/asar/bridge hashがmanifest一致・Build306がBridgeに実在・旧305なし）、全35 JS/HTMLがcommit一致、renderer script29/29、native32module（Desktop同梱=単体Bridge同一・compiled entry同一）、標準Bridgeのpackaged runtime coverage合格。`verify-artifact.sh`のasar展開工程は@electron/asar未導入で失敗、同等検査をPythonで代替した。
**昇格：** 検査済み原artifactを**再buildせず**そのままアップロード（Desktop3/Bridge4）。1回目はgh実行場所の誤り（gitリポジトリ外）でアップロード前に失敗し公開側は無変更、リポジトリ内で再実行して成功。公開URLから**認証なし**で全7fileを取得し、bytes/SHA256が昇格元と全一致（Desktop installer 101,135,386 bytes `fc6a66ad…2287`＝latest/日付版/旧Desktop互換名、Bridge exe 17,276,795 `57a2be92…ed488`、Bridge Setup 16,559,248 `3c6d4fc3…64f5`）。`verify-deploy.sh 896f47d…`：本番SHA一致・戦略API未認証401。ロールバック用に旧tag shaを`public-*-previous-tag.json`に保存（公開305=bada7b7へ戻せる）。保護scratch2件未変更・未stage。証拠＝`../pitwall-local-evidence/build306-oct25/`。
**未確認（Gate6/8）：** Windows installer上書き・起動・同梱Bridge・PTT/TTS/overlay、iRacing実走（昨日のレース質問、GAP/MC通知頻度）。**「Windows/iRacing/実音声確認済み」「独立確認済み」とは言わない。** 既知P2＝Driver申告のQA/会話二重引用。停止条件に該当すれば独断で差し替えずOwnerへ305戻し案を提示。

## 10/25 Build306 private候補2本完成：Codex独立artifact確認待ち（未公開）

対象SHA `896f47d2d8eabb629c8de12ebc86f31be61a67d8`（main fast-forward bada7b7→896f47d、server.js含むため本番も896f47d・`verify-deploy.sh`SHA一致/戦略API未認証401）。Desktop run **40184201403**／Bridge run **40184201405**、ともにsuccess・Publish skipped・push自動起動の各1本（重複なし）。保存先 `../pitwall-local-evidence/build306-oct25/`（`candidate.json`、`desktop-candidate/`、`bridge-candidate/`、`preflight-v1/`、`source-freeze-before-preflight.json`）。
Desktop installer `OMORAY-PITWALL-Setup-20261025-1019.exe` 101,135,386 bytes SHA256 `FC6A66ADCE5D424F9E8DFFB4F29B01BE3B37222AF4C9151C385B785AE0822287`（artifact ZIP 101,139,296 bytes digest `ad037417…2661`）。app.asar 5,199,991 bytes `6C9B9B18…58D1`、同梱Bridge 17,277,309 bytes `14A208C4…76EE`。Bridge単体artifact `OMORAY-PITWALL-Phase-BC-shadow-20261025`（ZIP 33,073,085 bytes）：Bridge exe `57a2be92…ed488`、Setup `3c6d4fc3…64f5`。runtime coverage artifact 2件（source import graph／packaged EXE）success。
**operator readback（Claude、独立確認ではない）：** installerのSHAはmanifestと一致、展開したapp.asar／同梱Bridgeもmanifest一致、`build-info.json` buildNum=306、rendererの参照localスクリプト29/29存在。PyInstaller圧縮のためcompiled Bridge本体の製品番号文字列は未確認＝Codex独立確認に残す。
**STOP：** Gate4/5はCodexの独立確認まで未承認。PASS後に、検査済み原artifactを再buildせず昇格（両Release名/rolling tagを306・同SHAへ、Desktop3/Bridge4の全公開fileを無認証取得しhash照合、verify-deploy再実行）。Windows/iRacing/実音声は公開後のGate6/8で未確認のまま。保護scratch2件未変更・未stage。

## 10/25 Build306 Claude担当：Gate0-3完了・Codex独立確認前（push/private候補は本commit後）

Owner停止は解除、Build/必要push/公開GOあり。**対象**＝修復e2657ad60a1eeec47ccfdd9864994c70954cbcda（fix/305-field-conversation、公開305 bada7b7からfast-forward可能）＋**番号同期のみ**（desktop/build-info.json buildNum 305→306、irsdk-bridge/bridge.py BUILD_VERSION=`Build 306 (field conversation continuity and saved-race recall)`）。機能追加なし。公開/本番は305のまま、Gate8 FAILED（実走sub89604371）を維持。

**Gate0：** 変更領域=Desktop/Bridge/server(server.js)。公開305との差32ファイル（+1347/-133）を独立レビュー済み（server.jsの履歴recall判定、bridge.pyのGAP/multiclass共有予算とscope/latch、renderer/memory/speech）。server routingが変わるためmain反映後にverify-deploy.sh必須。**Gate3：** 全preflightを新evidence `../pitwall-local-evidence/build306-oct25/preflight-v1/` で実行、exit0・841.88秒、147合格/0失敗、WO019 E2E 49/0（normal/AI、全Renderer）、runtime coverage 32 Bridge module/smoke32・Renderer script29・workflow3、WO018 122/0。fixture変更0/復元true、外部有料API接続試行0（offline-guard、external-attempts空）、source drift=実行log2(bridge_log.txt/irsdk-bridge/bridge_log.txt)のみ。raw.log SHA256 `d88d02a6da2f0d1a0b2c455148eff165faae348018f6cd20db30d387f5e16406`。実行前source freezeは`source-freeze-before-preflight.json`。保護scratch2件（_wo015_debug_extract.js `39283f42…2390`、irsdk-bridge/_wo015_probe_scratch.py `d97c589a…7ebe`）は未変更・未stage。**実行後のHANDOFF/共有log追記は文書のみで、preflight対象の製品/test差分ではない。**

**Source-onlyの限界：** Windows installer起動/実音声/iRacing実走は未確認。既知P2（同一Driver申告のQA/会話二重引用）、B/C順位利益計算・通常timed native BOX等の以前からの未達は維持。Claude CLIの通常環境認証・実LLM呼出なし、製品有料API attempt0。**次：** Codexへ本Gate0-3を回覧→main fast-forward push（Desktop/Bridge workflowはpush自動起動、publish=false）→private候補2本→完成artifactでCodex独立確認までSTOP。

## 10/25 Owner指示で停止：Build306 Claude担当は未起動・未Build／未公開

**ここで停止。Owner「一旦ここで停止してメモして！」。自動再開・監視予約なし。次回はOwnerの再開指示までBuild/公開/認証調査を進めない。** Ownerは5時間制限への懸念も表明した。

Build/公開GO自体は既にあり、担当希望はClaude。対象修復はe2657ad60a1eeec47ccfdd9864994c70954cbcda、次番号306。公開/本番は305のまま。Claudeの実作業・番号変更・private Build・push・公開は一切未着手。指示書 ../pitwall-local-evidence/build306-oct25/claude-build306-task.txt は準備済み。Codexがprivate完成artifactを独立確認後、同じ原bytesを公開するGateは維持。scratch2は保持・stage禁止。

**今回の起動調査と失敗を混同しない：**
- Ownerの指摘どおり、以前はターミナル経由のClaude Code運用に成功した記録がある（共有logの10/15・10/17等）。以前はsandboxの未認証を誤診し、通常環境の既存認証で起動できた。過去の成功を今回の成功と数えない。
- 今回は/usr/local/bin/claude（Claude Code2.1.285、実体npm配下claude.exe）、HOME=/Users/yuji.s、CLAUDE_CONFIG_DIRなし、auth環境変数なし。通常環境のauth statusもloggedIn=false。通常環境＋PTY＋非bare＋printの最小実応答確認もOAuth session expired/refresh失敗・exit1・費用0だった。アプリが開いていることをCLIの実起動成功と数えない。
- Claudeアプリのプロセスは存在。調査時点でターミナルのClaude Code processは見つからなかった。Keychainの既存Claude Code項目は存在/読取可能だが、観測時access/refresh tokenは空、expiresAt=0。秘密値をログ・チャットへ出していない。この状態の原因や過去と同じ復旧手順は未解決。
- CLI認証をChromeで何度もやり直すようOwnerへ案内したのは、既存成功経路の比較前に早合点した対応。Ownerはこの繰返しを明確に禁止。開始したauth login待ちはCtrl-Cで停止済み。次回勝手にChrome認証を再開しない。API従量契約への切替もしていない。
- 公式--desktopも確認。redirected output不可、prompt引数未対応、PTYで引数なし起動してもCLI sign-in requiredと返り、指示は渡らなかった。ClaudeアプリのCUA操作は2回timeoutで成功せず。--desktopを有効な引渡し方法と称しない。

**次回の始点：** AGENTS.mdへ今回の恒久ルールを追記済み。過去の成功したCLI経路と現在の違いを調べ、実応答/作業開始の証拠が取れるまで『Claude起動済み』と報告しない。Ownerへ同じChromeログイン操作を繰り返し依頼しない。起動手段は未解決なので推測で成功手順をメモしない。Ownerの停止中は追加調査しない。

今回停止時の未commitはAGENTS.md/HANDOFF.md/共有作業logの文書変更だけ。製品修復e2657adと全preflight-v4成功は維持。新規のBuild306 evidenceはrepo外。起動準備や指示書作成はBuild実行ではない。

次のMDに指示書あり

## 10/25 Build305実走修復：独立確認・全preflight・全Renderer完了（未Build／未公開）

**現状：** 公開/本番はBuild305・bada7b7のまま、実走sub89604371のGate8 FAILEDを維持。branch fix/305-field-conversation、base4274c6dからの修復を本commitに収録。今回GOのローカル修復/検査を完了し、Build・push・公開・本番更新は行っていない。304は昨日sub89577642の実記録参照だけ。

**今回できるようにした相談：**
- 普通の会話と保存レースの説明を、最初のsnapshotの5秒失効から分離。同race/本人/epoch、現cache、最大30秒を守り、現在数値の5秒制約・危険通知の割込・session切替での失効は維持。初期Plan Aは実target周と給油設定を発話。返答待ち中にPlanが変わる場合は、本文受信直後にも確認し表示・音声候補・履歴へ古いPlanを進めない。
- 昨日のレース→『何周目にピット？』『何回で何位？』を同じ保存記録へ結び、現在燃料への誤配送を修復。結果とdebriefの回答/会話を採用ボタンなしで自動保存。翌日起動後も本人・race/session・日付を照合し、Driver申告と実測を区別して取り出す。race削除の墓標、reviewだけの訂正/削除により待機/再生中/LLM応答の古い内容も失効。known sessionへの不明session混入、JST日付、現在話題への復帰、欠損日の別記録混入、owner上書きも閉じた。
- 通常GAPとMC準備通知に共通60秒予算、実socket送信時だけ消費。同じ車の接近の再通知を抑え、緊急MC stage2/P0は維持。同入力fixtureの実socket→Renderer比較は準備5回→1回、urgent1回とspotter完了。実走41件を1件へ減らした証拠ではない。

**最終検査：** field305-oct24/preflight-final-oct25-v4/ が820.05秒・exit0。normal49/AI49、全29Renderer/Bridge32module/3workflow、発話20場面の全個別、履歴27check、GAP6check、履歴pure38（日時指定なし91日拒否/89日採用）、WO018 after58＋guard cut計122/0、既存回帰すべてPASS。fixture変更0/復元true、外部有料API接続試行0、検査中のsource driftはruntime log2だけ。固定32pathとscratch2のSHAは親＋独立担当一致。

実走304由来の13/20周・pit2回・P20/22周の連続回答、実Bridge終了→summary/部分debrief自動保存→翌日起動→Driver申告取得、削除後の古cache復帰防止まで実経路で検証。公開305との同条件比較ではu8/u10の待機失効を再現、新版では保存応答6件を完了。実走の全切断原因を同定した意味ではなく、原音声はない。SDK/provider/TTS・DOM/audio I/Oは模擬、実LLMの意味品質や実音声の証明に使わない。

**独立確認：** root実装memory/server、repair_remaining実装speech、build304_review実装GAP。memory/speechは別担当、GAPは親が独立確認。最終追加P0/P1=0。証拠は同field305-oct24/のindependent-final-verification-oct25-v4.json、independent-memory-speech-final-review-oct25.json、parent-independent-gap-review-oct25.json、parent-final-verification-v4.json、final-source-freeze-oct25-v4.json。

**途中失敗も保全：** v1は既存test依存不足/旧文字列assertion、G01の受信時失効漏れ、test通信cancel計数で不合格。v2は前半の既知失敗を260.94秒で停止しfixture復元。v3は820.09秒でC44の検査入口衝突だけ不合格。製品を変えず旧general outcome expiryと新90日recallを分離、元のexpiry assertと独立負例を維持してv4で全完走。通信I/O修復も実HTTP status/body/chunk/cancelを保持することを独立反証済み。

**残件/次：** P2として同じDriver申告をQAとconversationから二度引用する箇所が残る。Windows/iRacing/実音声・実用性、実機の旧保存payloadの復元は未確認。B/C順位利益計算・通常timed native BOX等の以前からの未達を今回完了としない。新Build/公開へ進む場合はOwnerの明示GOを受け、release gateで候補を作成しWindows実走へ。公開305を無断差替えしない。

公式結果は22laps/class17/overall19/inc6。14L案/Owner Auto16L申告/後刻実測17.77Lは別値で、精度優位を断定しない。原本log/公式JSONはfield305-oct24/保全。

**費用/保護：** Claudeは通常環境でも未認証でreview0ドル、Owner指示で認証待ちCLIを中止しCodex独立確認へ戻した。製品paidAPI0・追加の実LLM呼出0。履歴のlocal回答と通常GAP削減は呼出削減を期待する一方、会話を完読する分の発話時間・TTS使用は増える可能性があり実運用CPU/費用は未計測。scratch2は元SHAを保って未追跡のまま保持しcommitへ含めない。

次のMDに指示書あり

## 10/24 Build305 公開・本番反映・全公開物照合完了（実走候補）

**公開製品SHA `bada7b776d10086d23e317f4cfaca1923d5f4584`、Desktop/BridgeともBuild305。** Owner「Build & 公開305 GO」で作成・push・公開を承認。main/両rolling tag/本番 `/api/version` は同SHA。`verify-deploy.sh`もSHA一致・戦略API未認証401拒否で合格。server/auth/payment/public pageコードの変更はなく、main反映に伴う本番反映も実観測した。

**何が入ったか：** 修復7075f48の質問候補8種、通常/under/overの実target周と物理復帰順位の比較回答、数字の意味を保った音声binding、較正保存データ欠損でのBridge停止修復。製品番号をBridge/build-infoの2pathで305へ同期。B/Cで実際に順位を上げる利益計算、通常timed native BOX、Driver申告の記憶/訂正、苦情/沈黙希望等は未達のまま（下記修復記録参照）。公開をPITWALL全体や実走の成功とは呼ばない。

**Gate3/4：** 305番号の全preflight748.32秒exit0、normal49/AI49、新実Bridge→全29Rendererの通常6/AI2、runtime32module/29script/3workflow、WO00142/WO018122等PASS。fixture変更0/復元true、有料製品APIattempt0。実行中変更は実行log2と回覧MD2だけ、候補20pathの現在SHA一致は独立確認済み。root作業、Owner承認済み別Codex build304_review独立Gate4 PASS/P0/P1追加0。ClaudeはOAuth期限切れで未実施を維持。

**Gate5実物：** Desktop CI40046550778、Bridge CI40046550903とも同SHA/success/Publish skipped。完成installer101124154 bytes、SHA256 `79109c78909989bb2f26bfb699b140576914e54a49c9b8e04e03db271415a189`。親verify-artifactと別担当が実installer/asarを検査、全35 JS/HTMLはcommit一致、全29script/32native欠落0。Desktop同梱とBridge単体のcompiled本体/32module一致、Build305/固有tag20261024-0046を確認（EXE container bytesは別生成のため異なる）。Windowsでの起動・installer実行を確認した意味ではない。

**Gate9：** 検査済み原CI artifactを再buildせず公開へ昇格。両Release名305・両rolling tag同SHA。公開URLから認証なしでDesktop3/Bridge4の全7fileを実取得し、すべてGate5実物bytes/SHAと一致。最新/日付版/旧Desktop互換名も同内容。証拠root `../pitwall-local-evidence/build305-oct24/` の `candidate.json`、`preflight/`、`independent-gate4.json`、`independent-gate5.json`、`parent-*-artifact-result.json`、`public-promotion-steps.json`、`public-final-verification.json`、独立公開照合JSON。installerは同root `desktop-candidate/extracted/`、認証なし取得物は `public-downloads/`。

**次はOwner Windows/iRacing実走 Gate6/8。** 公開 `desktop-latest/OMORAY-PITWALL-Setup-latest.exe` で上書きinstallし、画面/Bridgeログ305・起動/PTT/音声/overlayを確認。「通常ピットは？」「アンダーカットで順位を上げられる？」「オーバーカットは使える？」「何周目に入ると順位アップできる？」を、現在の同条件較正の有無とともに確認する。較正なしは不足理由を答え、数字を創作しない。質問で合意済みtarget/給油設定を変更しない。Gate8は305未確認、旧304の実走FAILEDを解消済みにしない。重大問題時はGate10で影響/回避/rollback候補を提示し、無断差替えしない。

検査有料API0、追加LLM検索なし、実運用CPU/TTS原価未計測。scratch2保持・stageなし。公開済みsourceはbada7b7に固定し、この後の引き継ぎcommitは既存MD2のみ。

次のMDに指示書あり

## 10/24 質問候補→戦略室→LUNA：比較回答の修復・独立確認・全preflight完了（未Build／未公開）

**現状態：** branch `build/304`、修復base `a3a3153`からのlocal変更。公開304/本番SHA `75cb056`と実走Gate8 FAILEDは維持。Owner 07:03続GOで再開。親rootが製品修復、repair_remainingは後半TEST ONLY、build304_reviewが製品diff/実artifactを独立確認。Claude CodeはOAuth期限切れでreview未実施（費用0）、Owner承認済みの別Codex分担で確認した。

**以前できなかった回答：** 共通catalog8種類を画面入力例と音声テキストへ接続。実走の「何週目に入ると順位アップできる？」を残り時間へ落とさず、通常/under/overの比較へ配送。SDK同frame＋同条件保存較正→各候補の実target周/物理復帰順位→canonical→projection→LUNAへ接続。整合した実Bridge再生では「通常7周/P3、under5周/P3、over8周/P3、順位を上げる根拠はなく通常維持」と最後まで発話する。これは当該SDK fixtureの値で実走結果ではない。候補クリックは入力欄へ入れるだけ、相談で既存合意/target/給油量/BOXは変更しない。

**今回閉じた欠陥：** 入口通過後のtarget1周ずれ、別々の復帰時刻の順位差をgainと誤認する比較、現在燃焼と旧残距離/凍結給油量の不整合を修復。比較専用copyを既存fixed_target_authorityのfull-current-lap幾何で計算しnative数量は保持。時刻や発話しない燃費閾値だけの更新で音声を切らない意味bindingを追加し、scope/epoch/closure/現在cache/10秒比較freshness/数値・条件変更の失効は維持。保存較正exit=nullで実pollがTypeError停止するP1も独立再現し、予測前に両座標のfinite/range/forwardsegmentを検証。不正時は全3案数値なしで「ピット入口・出口の実測位置が未確認」と発話完了する。

**検証済みの範囲：** source17path固定の全preflight `747.74秒 exit0`、通常49/AI49、新実Bridge→全29Renderer→発話completedは通常6/AI2すべてPASS。各plan名＋target周＋Pを同じ発話で照合し、質問前後native ID/target/set不変、操作送信0/timer error0、較正なし/実保存null負例を確認。別担当が実canonical/utterance/生outboundも独立照合。runtime32module/29script/3workflow、WO00142、WO018122、候補JS58/位置比較Python13等PASS。fixture変更0/復元true、source driftは実行log2のみ、外部有料APIattempt0。最終diff独立確認で新P0/P1なし。

**試験修復と限界：** synthetic positive B/Cは配送/同意検査専用。提案fixtureは容量38Lで起動無線と重ならない燃料窓へ移し、96frame観測・元の記録量上限を維持。P01は最初の中断試行と再送後完了試行を混同せず、同decision/dispatch/utteranceの発話完了→同意→native ACKを要求。W04は実dropをscenario＋uidで照合し、再生なし/terminal一致を維持。初回REDと修復履歴は証拠へ保持し、期待だけの緩和にしない。

**未達と次：** 同pace/同pit laneの共通Hモデルでは全案同値になる。**実際に順位を上げるB/Cの利益を計算・推薦できる能力は未実装。** 次は候補別の実測pace/交通/給油service差が生む利益を計算し、予測と実結果を照合できる対象スライスへ進む必要がある。通常timed native BOX、Driver22周申告の記憶/訂正、苦情応答/沈黙希望、純pit損失数値も未修復。今回の合格をPITWALL全体や実走の成功と呼ばない。Windows/iRacing/実音声/実用性は未検証。

**証拠/費用/保護：** `../pitwall-local-evidence/strategy-room-oct23/` の `preflight-final-oct24-v3/`、`final-source-freeze-oct24-v3.json`、`independent-final-diff-review-oct24-v3.json`、`parent-final-real-answers-oct24.json`。旧新誤配送4反例は `parent-field-routing-before-after.json`。10/23 Owner停止は `preflight-owner-stop-oct23/`、10/24途中REDは `preflight-resume-oct24/`、短時間停止v2は合格証拠から除外。製品比較はlocal計算・追加LLM検索なし。実運用CPU/発話長/TTS原価は未計測。scratch2保持/stage禁止。Build/push/deploy/公開は本GOへ含めず未実施。

次のMDに指示書あり

## 10/23 Build304 実走 Gate8 FAILED — 修復着手前の監査（残件は先頭参照）

Owner実走後「全く改善なし」と指摘。原本 `eventresult-89577642.json` と `OMORAY-bridge-debug-20261023-1838.log` を `../pitwall-local-evidence/field304-oct23/` へ保全しbytes/SHA記録。実304起動・全29runtime loaded、公式sub89577642/本人315555/車Mercedes GT3/Montrealを確認。今回は公式IDありで303のfallback問題の再発として説明しない。**現在304を実用的な戦略engineer合格とは判定しない。** 公開/本番75cb056は変更せず、無断rollback/再Build/公開/有料APIなし。

**公式結果：** 22周、総合24位/クラス20位（0-basedから換算）、0incident、best95.5426s。LUNAの22周/1:35.543自体は一致。実pit13周10.19L/32.6秒lane、20周5.79L/29.1秒lane。lane時間を純loss・結果全体をLUNAの因果損失と断定しない。

**確定破断：** (1) 順位upのpit相談2件→laps_remaining、pit損失→leader_gap/燃料、会話苦情→落ち着いて。実質問5件を旧303/304実UMDへ同条件入力し全5同一誤答。(2) Driver暫定22周をLLMは理解したがtruth gateが数字+周として遮断し了解へ置換。Driver申告/条件付き推定のroleが現在事実と混同。(3) 普通の当日clean3時間制planはactiveでもnative unsupported_finish_authority。race snapshots22,076中13,729が同理由、BOX許可0（操作要求件数ではない）。履歴専用timed例外だけを試験して普通の経路を残した。(4) 記憶無視の苦情をgap否定として直前3.1秒撤回、終了後も切断発言を誤撤回。(5) 次の週の正規化欠落でnative次周命令へ不達。(6) 内部18周予定を明示説明/合意と区別せずdebriefで早入り理由を問う。22周全体申告を22周pitとLLMが変質させた発話もあり。

**関連失敗：** アンダー/オーバーカット概念質問を現strategy照会へ誤変換、説明途中終了（raw stop_reasonなし、55token上限は原因候補）。沈黙希望後も非安全通知継続。GAP5秒後に8秒以上へ変化しているため初発捏造とは断定しないが訂正を解決しない。Driver不満をdebrief質問票が横取り、保存readbackはあっても判断改善の証拠なし。最後u124音声はrenderer error3で中断、completed扱い禁止。原音声なし、STT『この種box』は低confidence0.502で命令を推測実行せず確認が必要。

**試験見逃しと次：** 親/別担当build304_review双方が、履歴seed＋保存provider応答の専用成功経路、過去/現在の数値role、局所phraseへ偏った。接続/同梱のPASSは撤回しないがLUNAの意味理解・当日実測時間制・相談継続は証明していなかった。新語regexの追加だけで終えず、全32turnの目的/参照対象と申告/推定/提案/合意/実行を維持する経路、normal timed authorityとnative次周、結果訂正を一本で修復・旧新反証する。現turnは深掘り監査のみ、製品コード未編集。

証拠：`field304-deep-audit.txt`（全32件の評価）、`turn-audit-all32.json`、`conversation-all32.txt`、`race-result-comparison.json`、`actual-pit-events.json`、`router303-vs304.json`、`authority-gates.json`、`independent-field-audit.json`、独立実関数再現2JSON。rawログ時刻とISO記録は1時間差があるためsub/session/frame/lapで対応、雑なUTC換算をしない。

次のMDに指示書あり


## 10/23 Build304 本番反映・公開・公開物照合完了（実走候補）

Owner公開GOにより、検査済み候補SHA `75cb05643f03c475606897b24c980ff549924ce0` をmainへ反映。本番 `/api/version` と `verify-deploy.sh` が同SHAで合格。記憶/seed/chief関連の未認証経路は401拒否。Railway CLI OAuthは期限切れだったが、live本番version/起動時刻/経路応答で反映を確認した。

Desktop/Bridge両ReleaseをBuild304へ更新、両rolling tagも同SHA。Gate5独立検査済みCI原artifactを直接昇格し、再buildなし。公開URLから認証なしでDesktop3/Bridge4の全7fileを実取得し全bytes/SHA一致、別担当も再hashして独立PASS。Desktop installer101108415bytes、SHA256 `1976989c7023af853f0b1da16673a73c3d0e93011d15814548a9f19f7ba232d9`。証拠root `../pitwall-local-evidence/build304-oct23/` の `public-final-verification.json`、`independent-public-check.json`、`public-server-verification.json`、promotion manifest/steps/raw公開物。

**次はOwner Windows/iRacing実走 Gate6/8。** 公開 `desktop-latest/OMORAY-PITWALL-Setup-latest.exe` から上書きinstallし、表示/Bridgeログ304、起動/PTT/音声/overlay、同じAI raceの現在燃料＋周回・履歴燃料相談→訂正→同意→BOX→給油後→終了結果を確認。機械/実物/反映照合の合格であり、実機・実走成功やLUNA全体の完成とは呼ばない。完全同値LapLastLapTimeの計測欠落は未修復。製品有料API呼出/課金設定変更/追加購入0、scratch2保護。問題時はGate10に従って影響・回避/rollback候補を提示し、無断差替えしない。

次のMDに指示書あり

## 10/23 公開前履歴：Build304 private候補完成・Gate5独立確認PASS

**候補SHA `75cb05643f03c475606897b24c980ff549924ce0`、branch `build/304`。** Owner16:55 Build GO。修復c0f957fへBridge/build-infoの番号2pathを304へ同期。Claude OAuth期限切れに対しOwnerが別Codex確認担当を明示承認。親作業、build304_review独立確認。公開/deploy GOは未取得。

**source Gate3/4：** 304で全preflight exit0/586.84秒、normal49/AI49、新相談各15/負例各10、runtime32modules/29scripts、WO00142/WO018122等PASS。外部有料APIattempt0、fixture変更0。driftは実行log2と実行中追記した共有回覧MDだけ。別担当も実Bridge×全Renderer×server相談15条件を再走しGate4 PASS/P0/P1=0、commit内容との製品drift0。証拠 `../pitwall-local-evidence/build304-oct23/preflight/result.json`、`independent-gate4.json`。

**Windows private実物 Gate5：** Desktop CI39924967741、Bridge CI39924967816、ともsuccess・対象SHA一致・Publish skipped。Desktop installer `OMORAY-PITWALL-Setup-20261023-0830.exe` 101108415 bytes、SHA256 `1976989c7023af853f0b1da16673a73c3d0e93011d15814548a9f19f7ba232d9`。親verify-artifact exit0、別担当も取得installer/asar/Bridgeを実測manifest一致。main/preload/store含む35JS/HTMLがcommit一致、Renderer29script・native32module欠落0、Build304/固有tag確認。両Bridgeのcompiled本体/32module bytecode一致（EXE container hashは独立生成のため別）。`independent-gate5.json`、`parent-desktop-artifact-result.json`、`parent-bridge-artifact-result.json`、両CI raw logsを同証拠rootへ保持。ローカルinstallerは同root `desktop-candidate/extracted/`、単体は `bridge-candidate/`。artifact保持1日なので恒久公開URLではない。

**次：** Ownerが候補を確認して公開＋本番反映GOを出したら、server変更を含む同SHAをmain/Railwayへ反映しGate7/verify-deployを確認、合格後に検査済みartifactを再buildせず公開しGate9実取得照合。その後Ownerが公開update経路で上書きinstallしGate6/8実走確認。現公開Desktop/Bridge303・本番SHA a69544fは維持。今回のBuild GOだけで公開や本番反映へ進めない。

**限界/既知残件：** Windows起動/installer実行/実音声/実LLM意味/iRacing実走は未確認。完全同値LapLastLapTime連続時の既存計測欠落は未修復。製品source以外のscratch2はSHA保護・stageなし。有料製品API0、課金設定/追加購入なし。

次のMDに指示書あり

## 10/22 最終：時間制の燃料相談を全経路接続、独立確認・全preflight・全Renderer自動検証PASS（未Build／未公開）

**今回の完成単位は「履歴から始まる同一本の燃料相談」。** 履歴2件から4周目/追加約23.7L/設定24Lをnative候補として提示→3周目へ訂正→通常微減中に遅延した自然な複合同意を意味判定→Bridge durable commit/ACK後に確認音声→同IDのnative BOX24L→実補給24Lと同decisionを結合→「予定どおりではなかった」というDriver訂正をcanonical normalと並記して保存→別raceで根拠/予測/実績/訂正を実provider requestへ渡し、過去を振り返る回答の音声completedまで、親が独立再現した。旧sourceは同条件の同意に燃料の再計算だけを返しactiveなし、新sourceはactive＋ACK確認音声まで進む。件数だけを相談完成の代わりにしていない。

**最終source57pathをSHA固定してから、全preflight exit0／573.57秒。** 既存通常49/AI49（harness error0）、新相談はnormal/AI各15条件・負例各10、runtime coverage49/32modules・Renderer全29scripts、WO00142、WO018122等を最後までPASS。外部通信attempt0、fixture復元true、source driftは実行log2のみ。`../pitwall-local-evidence/field303-oct20/parent-full-preflight-final-oct22-v2/result.json` と同dir `raw.log`／`history/` が最終証拠。最初のexit1全走も前dirに保持し、旧検査の抽出/依存/出力先を修復して再走した。

**判断の更新も実証。** 当日3.68L実測の保存で合意を無関係に取消さず、4.2L悪化では旧24Lを勝手に増量せず新候補で再同意を要求。履歴115秒→当日90秒なら必要量を更新して旧24Lを拒否し35Lへ再提案、130秒では給油量を減らさない。親は通常/AIとも旧案の実際の4周目までSDK入力を伸ばし、fresh・同旧active・durableな状態で不足する24LのBOXが止まることを追加確認した。通常clean3/公式finish契約は不変、history専用の明示契約。給油後の残量＋周回回答も通常微減中に音声completed、気温単独は19.1℃のみ、timer error0。

**証拠と保護：** 最終manifest `parent-final-source-freeze-pace-oct22.json`、親承認 `parent-final-review-oct22.json`、相談完成matrix `parent-core-consultation-acceptance-final-oct22.json`、23発話の証明範囲 `parent-23-turn-audit-final-oct22.json`、旧新比較 `parent-consultation-comparison-oct22.json`。生成fixtureは保存コピーを証拠へ置き、この1pathだけHEAD bytesへ復元。既存scratch2はSHA照合して保持・stage禁止。source57＋本MD/共有logだけを正確にlocal commit対象とする。

**限界と次の境界：** 実SDK/DOM/音声/provider I/Oを模擬した製品経路の証明であり、実LLMの意味判定品質・Windows実音声/installer・iRacing実走成功は未証明。完全同値LapLastLapTimeが連続する既存計測欠落は未修復（確定周cursor/遅着保留/summary整合が必要）、今回の全lap集計再設計には混ぜていない。新相談以外を含むLUNA全体の実用完成とは呼ばない。公開303・本番・tagsはa69544f/Gate8 FAILEDのまま。Build/push/deploy/公開/有料APIは未実施、このGOへ自動で含めない。

**費用：** 複合同意は実際に意味判定streamへ通るため、そのturnはprovider 1call・出力上限100（既存race cap内）。通常race上限55は維持。検査はSDKstub/saved replyのみで外部有料provider呼出0、実際のtoken課金額は未計測。

次のMDに指示書あり

## 10/22 続GO：相談全経路を実証、全preflightの差戻しを修復中（未最終合格）

親独立の実Bridge×全Renderer×実server（SDK/音声/providerのみ模擬）で、履歴2件→4周目・追加約23.7L案→3周目へ訂正→遅延した自然複合同意→native commit/ACK読み上げ→BOX24L読み上げ→同decisionへ実補給24Lを結合→Driver「予定どおりじゃなかった」をcanonicalと並記して保存→別raceの実provider requestへ根拠/実績/訂正を取得し、その回答音声まで到達。`parent-history-whole-v8-oct22.json/.log`、AI側 `parent-history-whole-ai-oct22.json`。比較固定旧sourceは同意に再計算だけを返しactiveなし、新sourceは同条件でnative active＋確認音声completed（`parent-consultation-baseline-consent-oct22.json`／`parent-consultation-after-oct22.json`）。外部有料APIは呼んでいない。実LLM意味・実Windows音声・実走の証明ではない。

最初の固定source全preflightは **exit1／548.5秒**（`parent-full-preflight-final-oct22/result.json`）。通常49/AI49、runtime coverage49・32modules/29scripts、WO00142、WO018122はPASS。外部attempt0、fixture復元true、source driftはlog2のみ。REDは旧static anchor/旧prompt・server条件の期待、抽出VMへ新依存未接続、指定証拠directoryのmkdir不足。全体を最後まで走らせた後、開発担当がまとめて修復中。これを最終合格と扱わない。

実測3.68の保存・同active維持、実測4.2で旧24Lを変更せず新候補/再同意、旧BOX拒否はnormal/AIで親確認 (`parent-measured-negatives-*-final-oct22.json`)。旧固定115秒fixtureの「4.2反映PASS」は実測が発生しておらず証明から除外し、周ごと時刻を変え実pollのstrict1sampleも恒久確認した。history専用callerのmedian minimum=1へ修復、通常clean3は維持。

**現在の追加残件：** 当日paceが履歴115秒より速い90秒でも旧24Lをsafe扱いする反例（必要35L）を親/担当で確認。history専用でrate=max・pace=min、native/proof/recovery/保存契約を揃え、faster再同意とslower非減量のnormal/AI反証を追加中。`parent-pace-counterexample-before-oct22.json`。この後のsource freeze→全preflight再走（新相談・全負例を通常/AI両方）→最終独立証拠/差分/正確localcommitまで進める。

**既知の別残件：** 完全に同じLapLastLapTimeが連続すると既存lap_time_changed入口が新完了周を取りこぼす。即counter ORは遅着時刻を二重処理するため採用せず、scope付き確定周cursor/遅着保留とsummary整合が必要。今回の全lap集計再設計には混ぜず、未修復として残す。公開303・本番・tagsはa69544f/Gate8 FAILEDのまま、未Build/未公開、scratch2保護・生成fixtureは最終後1pathのみHEAD復元。

## 10/22 06:19 Owner続GO：核心の相談接続を再開（未合格）

停止manifestの44pathと保護scratch2のSHAを照合しdrift0。既存の開発担当repair_remainingを再開、親は独立確認を継続。Build/push/deploy/公開/有料APIは対象外。

親の実Bridge×全Renderer再走 `parent-core-smoke-wip-oct22.json` では、履歴2件→reference request→registered ACK→raw canonical frame2～31のnative awaiting→Renderer frame22のpending配列まで確認。一方、提案radio dispatchなし、pending_proposal=null、音声は起動3本だけで自然同意へ進まない。**昨日の「pendingなし」はaudible proposalなしを指し、canonical candidate自体の欠落ではなかった。** 各frame冒頭のawaiting再投影がpending dictを作るのに、新配送条件がpending is Noneを要求する不整合を開発担当へ返した。候補生成を相談成立と扱わない。

途中sourceの独立確認：reference純module19境界（timed形式明示、別本人/別layout/古いpublication/未commit/容量/不要pit等）、fuel-memory114、projection158、summary Python9＋JS17 PASS。給油後の通常燃料微減下で残量＋周回答completed・気温単独19.1℃・timer errors0を実全Rendererで確認 (`parent-renderer-postburn-oct22.json/.log`)。これらは新相談全経路／最終freezeの合格ではない。残件と完了順は直下の核心接続記録を継続する。

## 10/21 Owner指示で停止：明日、核心の相談接続から再開

Owner「ここでストップ！またあした！」により、製品編集・検査を停止。親が開発担当をinterruptし、保存状態の報告だけ依頼。未commit変更を保持。Build/push/deploy/公開/有料APIは未実施、公開303・本番・tagsはa69544f/Gate8 FAILEDのまま。

**再開位置：** 下記「核心の相談接続」の実装途中。Bridge純参照module `fuel_reference_planning.py` とnative awaiting/明示history authority入口、Renderer reference journal/outbox・候補訂正・semantic judge接続を追加中。最終freeze/独立承認/新全相談E2E/最終全preflightは未完。単なる旧49合格をこの新入口の合格にしない。

**親直近の実経路：** `/tmp/parent303-core-smoke.py`（保存コピーは停止source保全と別に外部証拠へ）で実Bridge×全Renderer×実serverを試走。履歴2件→`fuel_reference_request`送信→Bridge `fuel_reference_ack outcome=registered` とnative decision IDは確認。ただし22frame時点の観測でpending proposalが無く、自然同意の段へ進めず、proposal音声も確認できていない。途中sourceのWIP結果で、成功扱い禁止。`parent-core-smoke-wip-oct21.json/.log` に生データ。まずnative registration→canonical publication/cache/proposal配送を逆追跡する。

**残件の親レビュー：** 現在SDK raw/display trackの既存 `lastTrackId`/`memoryTrackCandidates()` を燃費履歴取得へ接続し旧保存履歴も取得する（新summaryにdisplayを足すだけで済ませない）。旧rawが別scopeへ残らないこと。候補4→3周訂正→自然複合同意→commit/ACK→BOX→実pit→根拠/予測と実績をdebrief/次raceへ保持。ref retry/ACKlost冪等、訂正削除直後の古い同意拒否、current-race新sampleで無関係取消をしないcohort version、現在燃費悪化時の再提案/再同意、モデルのACK前偽成功文の決定論的抑止を実製品経路で確認する。

前回全preflight exit0は `parent-full-preflight-before-postburn-fix-oct21/result.json`（364秒、normal49/AI49、外部0、fixture復元、log2以外drift0）。**その後の通常burn修復と核心接続sourceの最終合格ではない。** 生成fixture noiseは全検査後にこの1pathだけHEAD bytesへ戻す。scratch2は保護・stage禁止。停止source SHA/tarは `parent-owner-stop-oct21-*`、核心着手前の再現用製品は `baseline-before-core-oct21/`、破断証拠は `parent-consultation-gap-before-oct21.json`。

再開後はAGENTS→本先頭→共有log最新回覧→停止manifestを確認。担当の停止報告を読み、未完を閉じて独立確認→source freeze→全preflight（両既存49＋新相談）→全Renderer（初回・給油後とも通常微減）へ。Ownerへの再承認待ちを作らず、Build/公開の別境界は維持。

以下は停止直前までの作業記録。

## 10/21 Owner追加GO：核心の相談接続を修復中（未Build／未公開）

Ownerは「同様の部品修復を繰り返してもLUNAの仕事が変わっていない」「核心を改善していない」と指摘し、提案→訂正→同意→実行→結果→次回利用を完成させる修復へ追加GO。新設計MDの作成ではなく既存ownerへの実接続を行う。

親の実全Renderer反証：履歴から4周目・追加23.7Lを提案した後「じゃあその4周目の案で行こう。給油は23.7リッターね」へ再計算だけを返し、native登録要求0、canonical active/awaiting/local pending全空。`parent-consultation-gap-before-oct21.json`。既存49ケースはBridge既存Planから始まる別入口で、この欠落を検出しなかった。**従来49合格を履歴提案の相談完成と扱わない。**

Codex repair_remainingが実装、親Codexが独立反証。現在は履歴参照をBridge現在値で再計算しnative awaiting候補へ登録→既存提案配送/意味判定/同意/ACK/BOX→実pit→debrief保存/次raceへ接続する作業中。本人未確認device参考をnative権限へ昇格させず、明示provisional_history_v1 contractを既存clean3/lap-race契約と区別する。訂正/削除/古い応答/別scope/commit失敗/不足なし/容量不足の負例も必須。

先行残件は修復済み。全preflightは`parent-full-preflight-before-postburn-fix-oct21/result.json`でexit0/364秒・通常49/AI49・外部0・fixture復元、source driftはlog2のみ。ただし**その後に残量読み上げの通常微減中断を追加反証して修復し、現在は上記核心実装中なので最終sourceの全preflight合格ではない。** 残量は観測時概数/5秒/累積微減high0.25L・low0.1L、増加世代とscope世代で給油後旧回答復活を防ぐ。担当114checks、最終親Renderer再実行待ち。

公開303・本番・latest tagsはa69544fのままGate8 FAILED。Build/push/deploy/公開/有料APIへ自動拡張しない。既存scratch2とfixture保護を継続。証拠root `../pitwall-local-evidence/field303-oct20/`、核心着手前sourceはparent-pre-core-source-oct21.tar。次は核心の同一本相談E2Eと独立反証→source freeze→全preflight（既存両49＋新経路）→全Renderer（初回/給油後とも通常微減）→最終差分/証拠/回覧/正確localcommit。

以下の次チャット移動記録は今回着手時の履歴。現scopeは本項を優先する。

## 10/21 次チャットへ引継ぎ：Owner指示で保存・停止（未commit／未Build／未公開）

**次チャットは実走303失敗の修復を継続する。新WOへ進まず、途中sourceを完成・独立検証する。** Ownerは「過去データを拾って分析して答える」「全経路を見直しTeamとして機能」を指示、10/21続GO後、コンテキスト圧縮2回を理由に次チャットへの移動を指示。Codex開発担当 `/root/fuel_developer` は編集を保存して停止済み。親Codexが独立反証。公開303・本番・両latest tagは **a69544fd27225ee3812d2c0693e0f9cb38108c8a** のまま、Gate8 FAILED。branch `build/303`、修正はworking treeに保存、最終合格前。

### 実装と独立確認の現在地

|経路|現在の状態・証拠|
|---|---|
|履歴→燃料提案|複数レース同本人/車/コースの燃費分析→時間/paceによる残距離＋余裕1周＋予備2L→必要量/追加量/補給周案。厳格clean3周前は履歴、なければ少数clean/計測を暫定利用。当日clean3周後は更新。給油後に旧不足を引きずらない。本人不明の同車同コース端末数値は本人未確認参考tier、既知別本人は除外。履歴10件廃棄を撤去、rolling5更新、訂正/削除からの復活防止を接続|
|実製品経路比較|親全Renderer＋実server/preload/journal、実Bridge由来AI snapshot、I/Oのみ模擬。303は「現在燃料を確認できない」。修正phase2は19分/19L＋履歴3.6/3.8L・115秒から必要42.7L/追加23.7L/4周目補給案、通常燃料微減中も模擬読み上げcompleted。給油後16L/残3周/当日3.5Lなら必要12.5L、現在7周目併答、気温だけ19.1℃。phase3短文化後の再実行は未。Owner実データの初期19Lや履歴2件の確定ではない|
|現在factと作戦実行|fresh factと再起動復元を分離。AI fallbackはstable_scopeを偽装せずprocess_epoch限定custody_scope、当該process内native command→durable commit→ACK/BOX、新process/driver/sessionで旧作戦を再実行しない。親Python custody7件/JS14件PASS。旧raw telemetryと新canonicalの混合を遮断|
|誤会話経路|pitストップ内部のトップ誤認、「入らないと」の否定誤読、気温だけ、燃料＋周回、走りの測定評価、苦情を訂正/撤回と誤認する問題を修復。serverのACKなし偽BOXを撤去。集団pit報告と『pit後は集団の中？』の質問を区別。runtime診断は実29UMDの正負32checksへ|
|phase2広域検査|親phase1 normal E2E49/0/0。phase2 AI全49は46/3/0、3件はtestのsub固定/旧DECISIONログにscopeなしというharness期待不備。実canonicalからdecision_scopeを捕捉する修正後、AI対象M03/M14/M16は3/0/0。最終全49AI＋49normalは未。K29採番固定/K30anchor drift修正後、親cut2件は対象RED/controlGREEN|
|phase3結果集計・現在保存状態|BridgeでSDK completedとrecorded数、strict clean最速と計測最速を分離。最終lap遅着をbounded settle、固定4秒finish outbox。同scope active frameだけでcounter/laps/metrics更新、SDK inactive/garage/別sessionへ移っても凍結元scopeを一度配送、失敗はretry。Renderer表示/保存は完了/計測/クリーン最速/計測最速/申告ベストを区別。遅着別raceへ現在track/car/user/rules/race_plan補完禁止。fuel radio短文化、詳細はmetadata/FUEL_ESTIMATE。prompts.jsで現在unavailable≠過去未受信、診断なし原因断定禁止を接続。**phase3は親独立最終未確認**|
|phase3担当検査|新Python summary8件PASS、新JS実Renderer保存/label＋real prompt builder12checksPASS、phase_ab28/session-memory-tunnel126/fuel-memory-planning72PASS。停止直前py_compile/node--checkPASS。親は途中版Python summary4件PASSのみ。担当結果だけで最終承認しない|

### 次チャットの具体的な開始順（承認を聞き直さず進める）

1. AGENTS、本先頭、共有logの最新回覧とworking treeを読む。未commit変更は修復作業の本体。phase2 SHAは古い。`../pitwall-local-evidence/field303-oct20/parent-handoff-wip-sha-oct21.json` と保存source archiveを照合し、現在sourceを基準に独立確認を再開。
2. **残る実装を先に閉じる**：`preflight.sh`へ新 `irsdk-bridge/tests_summary_metric_boundary.py` と `tests-summary-metric-boundary.js` を接続（未）。explicit summary `race_format/configured_duration_s/total_laps_rule` 保存優先を確認（現data.race_plan優先、race_format単独未対応）。最終lap time先着→SDK completed counter遅着の対照を追加（counter先着＋time遅着、counter遅着＋time未着は担当済）。outbox単発/再送/別scope/遅着historyを親が逆向きに確認。
3. 関連 `tests-evidence-debrief.js`、`tests-wo018-debrief-outcome.js` 等を実行し、既存訂正/保存/次race取得の退行を修復。postrace promptはreal buildSystemまで担当検証、保存provider request捕捉による接続確認は未。実LLM意味は別限界。
4. sourceをfreeze＋SHA固定してから親が **全preflightを一回最後まで**。実行中に実行ファイルを編集しない。ローカルbindが必要なので `./preflight.sh` はsandbox拒否時に適切に昇格。providerはmock、外部有料API0。全49normal＋全49AIの両方が必要。失敗時stackを隠さない。
5. 親の全Renderer再現 `../pitwall-local-evidence/field303-oct20/fuel-product-review.py OUTPUT.json --burn` を現在sourceで再実行。今回はpostpit読み上げ待ち15tickを追加済み（script未実行）。初回/給油後completed、通常微減、fuel＋lap、気温だけ、pit相談を確認。fakeAudio最大8秒なので実Windows音声長/質の証明ではない。
6. 最終差分/証拠/23発話matrix/本MD・共有回覧を更新。関連検査後、exact filesでcoherent local commit可。Build/push/公開/有料APIへ自動拡張しない。公開候補を作る時はrelease gateを全文から再確認。

### 証拠・作業保護・判定の注意

- 全証拠のroot：`../pitwall-local-evidence/field303-oct20/`。実原ログは `OMORAY-bridge-debug-20261020-1904.log` 27,505,941bytes/74,471行。`race-results.json`、`turns.json`、`critical-spoken-traces.json`。`drive-log-download` はログでなくlogin HTMLで証拠に使わない。
- 実走厳格cleanは2周だけ（lap3/9）、旧fuel_strategy.clean_laps_sampled=5はpit除外計測数でstrictcleanではなかった。3clean待ちではこの短いレースで間に合わない。計測/strict provenanceを今回分離。
- 主要親証拠：`parent-full-renderer-custody-fuel-oct21.json`、`parent-ai-start-snapshot-oct21.json`、`parent-ai-scope-cases-oct21.json`、`parent-anchor-cuts-oct21.json`、`parent-23-turn-audit-oct21.json`（未final）。比較旧303は `fuel-full-renderer-baseline303-valid-speech.json`、`baseline303/`。最初の `fuel-full-renderer-after-speech.json` はblack_flag source更新漏れでcache拒否された**harness不備**、改善不成立の証拠から除外。
- `parent-preflight-final-oct21.log` はphase2 exit1。Build298静的1500char閾値のdriftは修正し171PASS、M03/M14/M16期待修正後AI3PASSだが**全preflight最終合格は未**。初回preflight途中編集EOFのrunも最終判定に使わない。
- tracked `fixtures/wo005-fuel-safety-override/fuel_safety_override_replay_v1.json` は開始時clean、回帰testがepoch/signatureを自動再生成したnoise。最終検査後に生成版を証拠保存して**このpathだけHEAD bytesへ戻す**（test実行中に戻さない）。scratch `_wo015_debug_extract.js` と `irsdk-bridge/_wo015_probe_scratch.py` は以前からの無関係変更、削除/stageしない。汎用reset/checkout禁止。
- 実LLM意味、原音声、Windows実TTS/installer、実走は未証明。累積燃費保存コードが元から存在した点を親が一度見落とし「直近値のみ」と説明した誤りは訂正済み。保存の存在と実回答への接続を区別。新sourceは未commit/未Build/未公開。

**次チャットへの開始文：**
> /Users/yuji.s/Desktop/Claude/english-voice-app/HANDOFF.md の「10/21 次チャットへ引継ぎ」を読んで、実走Build303失敗の修復を続けて。履歴燃費＋予備2L、AI process custody、終了結果と履歴のphase3はworking treeへ保存済み。残件を閉じ、独立確認→source freeze→全preflight（通常/AI両49）→全Renderer再現まで進めて。未commit変更と既存scratchを保護し、自己報告だけで合格にしない。Build/push/公開/有料APIはまだ行わない。続GO！

次のMDに指示書あり

## 10/20 実走監査：Build303 Gate8 FAILED／原因を製品コードで再現

**設計どおりに機能していない。実走成功・最終出荷とは判定しない。** Owner提供のMonza AI実走ログ（27,505,941bytes／74,471行、Bridge Build303起動確認）と結果JSONを取得。証拠は `../pitwall-local-evidence/field303-oct20/`。前回の機械・artifact照合の合格は維持するが、実用上の成功を裏付けない。Gate10対象。公開物・本番・tagは変更していない。以下は修正前の監査記録。最新修復状態は先頭を優先。

|破断点|実走・実コードの証拠|修復に必要な契約|
|---|---|---|
|現データと永続復元の混同|AI race `fallback:5ea2a4cbd247` はdurable_recovery.stable_scope対象外。Bridgeはfresh fuelを正規snapshotに保持するがstrategy-state-projection.js:74–79がstable_scope/durable_commitで全体を利用不能にし、renderer.html:6286がfuel/lapをnullにする。実Bridge16frame→実cache→実projection→実Rendererの比較でも、同一燃料18.4Lがfallbackならnull、SubSessionIDありなら18.4L。`real-bridge-to-renderer-comparison.json`|現在のfresh factとcross-restart復元可否を分離する。fallbackを永続ID扱いにして安全策を外す修正は不可。設計WO009の独立fuel/flags保持とWO011の全projection stable_scope条件も衝突している|
|相談を別の質問へ変換|20:06:34「ピットストップ？何周年ぐらいにするの？」→「クラス首位は3周目」。実routerでもleader_lap再現。「ピットストップ」内部の「トップ」と「何周」をleader regexが拾う。なお「ピットストップ、何周目にする？」はpit_plan_questionになるため、全pit質問で常時発生とは言わない|Driverの目的を保持し、音声表記揺れ・疑問符位置・訂正を含め相談単位で反証|
|serverの旧BOX返答がcommand/ACKを迂回|20:07:47「この週でピット 入らないと燃料切れちゃうよ。」を実Desktop classifierはnegated、実server classifierはpit_this_lap。server.js:1015/1259はliveData空でも「了解。この周の終わりでボックス」。実走u38もspoken/completed。全ログdriver_plan_command/同ACK文字列0。`server-bypass-repro.json`と`critical-spoken-traces.json`|必要条件「入らないと」と否定を区別。合意/実行を示す返答は同一native command→ACK→状態の経路に限定。単なる返事を実行成功に数えない|
|試験条件と診断の盲点|既存Renderer helperがstable_scope driver1を常に注入、E2E入力もSubSessionIDあり。現実のAI unsupported状態でfresh fuelを答える対照が欠落。runtime reporterは実UMDのPitwallCriticalJournalをPitwallCriticalJournalClientと誤推定しmissing表示、試験も同じ推定名のdummyを作りGREENになる。`actual-module-diagnostic-repro.json`|製品UMDを実行して配線を確認し、実Bridgeのunsupported identityと通常identityを同条件比較する。実走ログのmodule missingを真の欠落と断定しない|

実走Bridgeは20:07:18 fuel7.59L、20:09:13 fuel3.90L/critical、20:17:17 fuel12.76Lを記録。一方、Rendererはfuel警告をmissing_current_publicationで保留、質問には確認不能と返す。従って単純な「iRacingデータ未着」では説明できない。ただし原ログには質問瞬間の正規wire payload全体がなく、各発話時点の正確な残量まで復元したとの主張はしない。18.4Lは比較replayの入力、12.76Lは実走記録値で区別する。

23発話をturns.jsonへ抽出。上記以外にも「俺の走り」への訂正後の分析不成立、「気温だけ」の訂正無視、燃料＋周回の複合要求で周回無回答、終了後「順位も無い」とする返答と直前P13応答の矛盾を確認。これらの全原因をidentity問題だけに帰属させない。Memory matching_race_unavailableを確認したがsync optoutを故障扱いにしない。結果JSON9完了周/ベスト114.835秒とdebrief8周/114.548秒の相違は集計定義・同一結果対応を追加確認するまで断定保留。原音声なし、STT誤認識の元発話や実際の聴感は未検証。

優先順：fresh facts/永続復元/実行権限の契約分離 → Desktop/serverの相談・合意・実行経路統一 → 23発話の訂正・複合要求と別表現を含む製品経路回帰 → 独立確認 → 別候補Build/公開GO → 同じAI実走。今回の旧302rollbackで改善する証拠はなく、無断rollbackしない。現303を燃料判断・BOX実行の信頼できるengineerとして扱えないことをOwnerへ明示する。

次のMDに指示書あり

## 10/20 Build303公開済み／本番・公開取得物照合完了

**現在のDesktop/Bridge単体はBuild303。source・main・本番server・両latest tagは a69544fd27225ee3812d2c0693e0f9cb38108c8a。** Ownerは完成候補提示後、夜の「GO!」で本番反映→確認→合格時公開を承認。Railway deployment **172249ca-56b4-4df4-b8c6-a849a9e51df7 SUCCESS**、verify-deploy exit0、本番DB初期化ready。記憶decisions/import-seeds/chief handoffは未認証401、不正access codeも401。実Stripe決済/有料provider呼出は行っていない。

**Desktop最新版:** https://github.com/eebei/english-voice-app/releases/download/desktop-latest/OMORAY-PITWALL-Setup-latest.exe 。旧互換Desktop-latest.exe・日付版も同じinstaller。101071478bytes、SHA256 **aeca2d7f9f6de1ac7e837bd9d855842c63da327109ec05716002f4a22aaf9daf**。app.asar5096105bytes SHA704f77e2…、同梱Bridge17232481bytes SHA66c4a9f6…。単体exe17232899bytes SHA5c075e68…、単体installer16515145bytes SHAeb106a99…。Desktop利用者はBridge単体の追加導入不要。

Desktop CI **39330240891**／Bridge CI **39330240986**の検査済み原artifactをそのまま公開（再ビルド0）。既存dated履歴は保持、stable互換名を更新。両Release名Build303、両tagを同SHAへ更新。親が認証なしの公開URLから **Desktop3＋Bridge4＝7ファイルを実取得し全bytes/SHA一致**、本番SHAも再確認。Gate9完了。主証拠 **../pitwall-local-evidence/release-oct19/release303-final-record.json**、public-final-verification.json、public-promotion-steps.json、public-go-verify-deploy.log、各公開Release/tag JSON。

source独立検査：full preflight exit0、実Bridge×全Renderer×実server E2E49/0/0、K30/K31の故障復活は対象RED/正常control GREEN、fixture32file開始SHA維持。元10＋追加12失敗は修復。候補実物：NSIS展開、29script欠落0、main/preload/journal-store含む35JS/HTMLが対象commit一致、両Bridge各31local/必要external欠落0、native Build303/旧302なし、両系統の抽出compiled Bridge本体SHAも同一。詳細はparent-candidate-final-review.json／source回覧。175file commit、無関係scratch2は除外/保持。現在doc2fileの引継ぎ更新だけ未commit（候補SHA保持）。

改善した相談：『ピット中止、タイヤ交換はしない』を取消command→実Bridge ACK→取消記録→正しい読み返し完了へ接続。通常fuel/lap更新だけで取消読返しを中断しない。terminal内容/本人scope/epoch/TTL失効は拒否。取消した旧PlanからのBOXを出さない。実LLM/STT/TTS意味・音声品質を証明した結果ではない。

**以下は実走前の記録。10/20実走でGate8 FAILED（先頭監査を優先）。** 次の再検証時は 公開update経路で上書きinstall→画面/BridgeともBuild303→iRacing未起動/検出/live→PTT/音声/overlay/診断export→session切替・GAP/燃料質問・pit前後・終了後の短い実走を確認。現在は『機械/実artifact/公開取得物検証済みの実走用candidate』で、Windows起動・実走成功/最終出荷署名済みではない。Gate10該当時は影響/回避策/rollback候補を提示してOwner判断、無断差替えしない。

全車strategy DB・fuel-save/stint延長・過去天候/setup/Memory→Strategy追加統合の予約3scopeは維持し、今回公開だけで完成としない。新機能/有料製品API/購入/課金/予約へ拡張0。CIのUTC date tagは20261019-2148、作業/公開日はJST10/20。

次のMDに指示書あり

以下のWO完了記録は当時の履歴。現在のBuild/commit/公開状態は本先頭を正本とする。

## WO021 Revision1 完了／定義機械範囲APPROVE（10/19 親Codex独立判定）

旧Node Bridge `irsdk-bridge/bridge.js`（現行consumer0）を除去し、再追加/起動参照をCIで検出。開発用Build情報257とBridge302の食い違いを解消し、画面・Supportログ・usageを共通readerへ接続。現在のsourceは **Build 302 (unbuilt source)**／usage `302-unbuilt`、更新確認はdev扱い。欠損/型不正tagはunknown、明示devのみunbuilt。配布物の正規Build表示・更新先・package semverは維持。CIはDesktop/StoreのBuild情報生成・正本から実出力への値/生成順を検査し、artifactのdev印混入/情報欠落を拒否する。

Claude Code唯一実装、親Codex独立確認。親の同条件 **46PASS/1FAIL/0HARNESS→47/0/0（I01改善・既存46維持・後退0）**。新3cuts対象RED/正常GREEN、CI正負49/0、reader22/22、artifact検査55/55、文書/デプロイ検査28/28、source31/31・Renderer29・workflow3合格。最終source13パス（削除1含む）SHA一致・独立実行後drift0、fixtureは開始SHA復元済み。担当全29cuts/関連回帰最終108/118（開始107/117、共通117の終了結果後退0、既存10非0同一）を監査。初回6workerの追加2失敗は個別/3workerで非再現、初回rawも保持。

HANDOFFの旧履歴は開始source archiveへ保全して現行要点へ集約。TEAM_STATEは歴史資料と明示、Build手順の参照も更新。戦略/authority/priority/TTL/製品LLM契約に変更なし。既存Build302を新番号へ採番していない。**未commit、Build/公開/push/追加購入/課金変更/予約/製品有料API0**。

永続証拠 `../pitwall-local-evidence/wo021-oct19/parent-final-review.json`、親before/after/cuts/CI/最終SHAとarchive、担当claude/最終回覧・raw。実Windows CI/packaged EXE/Store/installer/Electron表示/実音声/実走/実LLM意味/DB、全preflight/全release gateは未確認。旧producer削除は任意の外部WS radioを防ぐ新しい接続認証を追加した証明ではない。writer検査は現在のPowerShell記法の保守契約で、任意コードの意味解析ではない。

**次**：一覧WO001–021の定義機械sliceはここで完了。新WOやBuildへ自動着手しない。次のGOで、既存失敗とWindows/package未実行を踏まえた次段階を確定する。実candidate採番/Build/公開はrelease gateと別の明示承認に従い、公開302と異なる中身を同番号の公開物として扱わない。

次のMDに指示書あり

## WO020 Revision1 完了／定義機械範囲APPROVE（10/18 親Codex独立判定）

**Supportログから、発話の生成→待機→再生→完了/中断/開始前破棄、Driver申告→実Bridge ACK→読み返し、Plan失効→実pitまで、製品のnative IDで逆追跡できるようになった。** Bridge切断中もRenderer側の観測を出力。新規sectionは許可field限定・時刻の時計系を区別・bounded（古いeventのevictを計数）。欠損ID/source_frameを別事実で埋めない。

Claude Code唯一実装、親Codex独立確認。親同条件比較 **39PASS/7FAIL/0HARNESS→46/0/0（7改善・39維持・後退0）**。開始565path復元SHA差0、最終変更18file全SHA一致。親WO020 cuts7種類は対象RED/正常GREEN、担当全26cutsも監査。親unit Renderer24/0・Bridge17/0・CI正負28/0、実local import31/31・Renderer scripts28・workflow3契約合格、bash -n preflight合格。実Bridge×全Renderer×実server、IOと保存provider応答のみ模擬。

3 Windows workflowへsource graph/実package同梱検査/機械可読artifactの接続を実装。**実Windows EXE・CI実行/upload・実機exportは未検証**（合成archive listingと実asar verifierの正負検査とは区別）。関連回帰は担当after100/110・before99/109、同じ10suiteが非0で新規後退なし、全preflight/全release gate合格ではない。

先行のopening Plan A限定修復も機械範囲APPROVE：同frame authorityで旧21/11→20/13、target20のBOX completedを独立再現。早いpitの戦略価値・B/C全戦略整合、既存5秒TTL/radio待ち・再提案配送疑い、実LLM意味/実音声/STT/TTS/Windows/iRacing/PostgreSQL/installerは残る限界。

証拠 **../pitwall-local-evidence/wo020-oct18/observability/parent-final-review.json**、親E2E/before/cuts/CI、担当claude/回覧表・全SHA・開始/最終source archive。製品追加API0、同条件cost proxy不変（chat3/translate33/TTS24）。未commit、Build/公開/push/追加購入/課金変更/予約0。

**次**：WO021は未着手。新しいGO後にprogramの次WO範囲を確認して開始。Windows/packageの未実行を合格へ読み替えない。以下のWO019/opening停止記録は履歴で、初期Plan不整合は上記の限定修復済み。

次のMDに指示書あり

## 現行製品と公開状態

- 製品は **OMORAY PITWALL**。会話を土台に、状況の説明→訂正→提案→合意→実行→評価→次回の記憶利用をつなぐ。Lunaを新規会話開発/評価の基準とし、他人格は既存互換を維持。日本のGT3/ロードレース運用を優先し、未提供の車種/全般setupを完成済みとして販売しない。
- 現行公開は **10/20 Build303／source a69544f**。Desktop/Bridge両Releaseと公開7取得物を照合済み、本番同SHA。Windows/iRacingは公開後確認待ち。詳細は先頭とrelease303-final-record.json。
- 旧公開302（9/21、installer SHA69e4f7c6…/100199099bytes、source e1a7963）は9/22 Road Atlanta実走でGate8不合格だった履歴。旧server/main ff180b8と旧Bridge301は今回303へ更新済み。repository publicのvisibilityは変更していない。無断rollback/差替えはしない。
- 保守対象はPython `irsdk-bridge/bridge.py`→Desktop canonical read-only projection→会話/音声配送/記憶。race truth/Planの唯一ownerはBridge。必要なcompatibility projectionと歴史証拠を死コードと混同しない。

## 検証の現在地

- WO001–021は各定義sliceの機械検証APPROVE。全製品/全series/実LLM意味/音声/Windows/iRacing/DB/商用品質の合格ではない。設計/受入範囲は `review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md`、各実装・独立判定は `review/PITWALL_SHARED_WORKING_LOG.md`。
- WO019で接続した相談：window質問→早期pit申告/理由→実ACK→pit15/penalty16→同epoch再接続→debrief訂正/保存→次raceで訂正付き参照。十分給油なら不要BOX0、不足給油ならfresh Plan/authorityから必要BOX。保存provider応答とIO模擬による実Bridge×全Renderer×実serverの検証。
- WO020の親最終E2E46/0/0・独立7cuts・unit24/17・CI正負28は上記。WO020時点の関連回帰は100/110exit0で10suiteが残った履歴。10/20出荷準備で元10＋全体検査の追加12を修復し、親full preflight exit0へ更新済み。最終証拠は先頭。
- 製品追加API0。同条件proxy chat3/translate33/TTS24（token/実費ではない）。原価証拠はrepository外 `../OMORAY-PITWALL/reports/daily-cost/`。料金/紹介/無料期間/権限/課金設定を今回変更しない。

## 残る限界と次の判断

- opening整合は候補以前の最遅安全周を選ぶ限定修復。早いpitの戦略価値・Plan B/C全体の幾何整合は未検証。
- 既存5秒binding TTLによるradio待機/長文の中断・破棄、再提案配送の不整合疑いはWO021で機能修復へ拡張しない。未知/未確定の疑いを解消済みとしない。
- 実LLM意味、実STT/TTS/マイク/PTT/最終音声、Windows起動/install/export/Overlay、iRacing/SubSessionID実測、Store packageは未確認。Desktop/Bridge Windows CI生成・実EXE/NSIS内容・artifact upload/取得・全preflight・本番初期化/経路・公開取得物は10/20に検証済み。本番の実ユーザー記憶保存/取得や実音声/実走は別の証拠が必要。
- WO021は先頭の定義範囲で完了。次段階は次のGOで確定する。新しい機能拡張（全車戦略DB、setup全般、動画比較等）をこの保守作業へ混ぜない。外部テスターの再開や商用施策は別判断。

## WO構造改革とは別に保持するOwner指示・予約scope

- **レース戦略データ基盤／継続学習ループ**：10/1共有logの将来要件と監査継続メモ。構造改革後に、取得可能な全車の動向→候補/判断/発話→Driver応答/実行→pit cycle/終了結果を同一時間軸・Decisionで保存し、replay評価を通じ次回判断へ還元する。見逃した提案機会も評価する。rival非公開値を事実にせず、保存だけを学習と呼ばない。WO001–021完了にはこの新データ層の完成を含めていない。正本：共有log「2026-10-01 監査Codex：将来要件メモ」、`review/IMSA_FIXED_RIVAL_STRATEGY_LEARNING_BRIEF.md`。
- **燃料セーブ／stint延長の更新提案**：9/14共有log「Codex最新指示：追加待ち解除」の次段予約scope。必要セーブ量・延長可能周回・成立条件と戦略価値を計算しLunaが更新発話する。既存fuel回答/Plan A/B/Cの存在だけで予約scope全体を完了としない。着手時に既存実装と受入条件の差分を確認する。
- **過去天候・setup進化・Memory→Strategyの統合要件**：`review/MEMORY_TO_STRATEGY_SHARED_UNDERSTANDING_V1.md` §17。既存実装を持つため全件未着手とはしないが、WO001–021承認だけでこの統合scopeの全出口/実走を完成済みとしない。source→保存→取得→次回提案→結果/訂正を別途照合する。

上記はOwnerの既存要望/予約scopeとして保持する。今回の確認質問を新データ層の実装GOやBuild/公開承認へ読み替えない。10/19追記：直前の「残るのは検証」の説明だけではこれらを省略していたため、現行引き継ぎへ復元。次のMDに指示書あり

## 作業・公開の境界

- 現scopeは先頭のOwner指示によりCodex開発担当が製品/恒久test実装、親Codexが独立確認。全preflight/独立review/候補検査後、10/20夜の別GOで本番反映・検証・公開まで実行完了。外部有料API/追加購入/課金設定/予約は承認対象外。既存dirty treeを保護、無関係な作業をcommitへ混ぜず、新MDを作らない。
- Build/公開の依頼時は `review/PITWALL_RELEASE_GATE.md` 全文からGate0–5/変更時7、公開後6/8、停止10を守る。source/合成artifact/実取得artifact/Windows実走を区別し、preflightのみで出荷合格にしない。今後のcandidateは現行公開303との識別を明確にしてから扱う。
- serverを反映する場合は `verify-deploy.sh --url <承認済み対象URL> <対象SHA>` と機能経路の結果を記録する。SHA一致だけでDB migration/API利用可を合格にしない。今回303はOwner承認により反映・経路検証済み。今後の未承認変更を自動deployしない。
- 開始順はAGENTS→本HANDOFF先頭→program該当WO→共有log最新回覧。最新表のSHAと入口出口の実証から独立確認し、担当の自己報告だけで承認しない。

## 履歴と証拠の所在

旧HANDOFFの中間停止/未公開記述は現在の指示から除去した。**旧履歴の原文は `../pitwall-local-evidence/wo021-oct19/start-source.tar` 内HANDOFF.md（開始SHAはstart-sha.json）に保全**、WO020最終版もobservability/parent-final-source.tar内にある。新しい履歴MDは増やさない。過去回覧は既存共有log、恒久方針はAGENTSと `review/FOUNDER_SCOPE_LOCK_MINIMUM_REAL_AI_ENGINEER_20260905.md` を参照する。

Road Atlantaの歴史的赤ケース（2026-09-22、公開302）：Driver申告を作戦変更として受理せず、pit15給油16.79L/penalty16給油0Lを旧Plan21へ誤結合。lap21で燃料18.14L/完走必要9.98L/余裕8.16Lにも旧BOX18Lを発話。これはWO001 fixtureの再現値であり現行sourceの出力ではない。修復の各機械証拠はWO019/20永続証拠へ分離している。

永続証拠：`../pitwall-local-evidence/wo019-oct18/`、`wo020-oct18/`（openingとobservability）、`wo021-oct19/`、`release-oct19/`（303出荷準備/本番/公開/実取得照合）。/tmp消失時に過去の結果を再実行済みとせず、この保全済みSHA/ソース/rawから再開する。
