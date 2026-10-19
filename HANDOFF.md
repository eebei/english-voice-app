# OMORAY PITWALL 引き継ぎ

## 10/20 出荷準備Phase A／親独立確認APPROVE

Codex開発担当の修復37sourceを固定し、親が全preflightを独立実行 **exit0（303.84秒）**。実Bridge×全Renderer×実server E2E **49/0/0**、元10失敗は10/10成功。fixture再生成0/開始状態維持、製品source drift0、外部接続attempt0。実行中変化は生成bridge_log2と担当回覧logのみ。新K30/K31は対象RED/正常control GREEN（2/0/0）、terminal28・static gate・artifact tool正負も親独立成功。37source全SHA一致、diff check0。証拠 `../pitwall-local-evidence/release-oct19/parent-phase-a-review.json`、raw/results、担当final-source-sha.json/archiveと共有log最終回覧。

改善：『ピット中止、タイヤ交換はしない』が取消command→Bridge ACK→取消記録→正しい読み返し完了へ接続。取消済Planの読み返しを通常fuel/lap更新で切らない。実記録内容/identity/epoch/TTL失効は拒否。古いowner/extractorのtest修復と、必須checker欠損/manifest不一致/誤artifact選択の偽GREENも修復。実LLM意味・実音声・Windows/iRacing/DB合格ではない。

**現在：Build303（source/dev、未Build）へ採番済み。親が番号のみの製品差2か所と関連test修復2か所を独立確認、identity22・static/diff成功、担当coverage49/0/source31/31・Renderer29/workflow3成功。local build/303 branchで未公開Windows候補のcommit/push/CI/完成artifact検査へ進む。候補作成/検査はOwner GO済み。公開/production deployは完成候補提示後に別承認。** 追加機能①②③へ拡張せず、実installer artifactの検査前にBuild完成と呼ばない。次のMDに指示書あり

## 出荷準備GO／担当切替（10/19、Owner明示指示）

Ownerが「既存失敗を解消→Windows候補作成/検査→承認後の実走用公開」の順をGO。続いてClaude制限のため **Codex開発担当へ切替**を明示。現scopeはCodex開発担当が製品/恒久testを修復、親Codexが独立確認。過去のClaude専任記録は今回の担当判断を上書きしない。Claude session359ae9c2を停止、製品変更は着手sourceと差0、既存10失敗のbefore再現はclaude/before.jsonへ取得済み。

証拠../pitwall-local-evidence/release-oct19/開始572SHA/source.tarを保全。まずGate3/4：既存10失敗と全preflightを修復・正負対照・独立確認。候補作成/検査まで今回GOの対象、公開/production deployは完成候補を示して別の承認後。10/19 remote読取でDesktop302（latest installer SHA69e4f7c6…/100199099bytes）・Bridge単体301・server/remote main ff180b8・repository publicを確認（変更なし、gate0-summary.json）。新candidateは公開302と区別して採番、追加機能①②③へ拡張しない。製品有料API/追加購入/課金変更/予約0。

次のMDに指示書あり

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
- 最後の取得物照合記録は **2026-09-21 Desktop Build302公開**（run35542509895、source e1a7963、installer100199099bytes、SHA256 `69e4f7c63e9d56fd2dde46b63d59ae3589986afc3bbec7c4c0f7057d3cd2c83c`）。9/22 Road Atlanta実走でGate8不合格。その後のWO修復は未commit/未Build/未公開で、公開済み302に含まれない。10/19にremoteを再照会し、Desktop302の上記installer bytes/SHA一致を確認した（release-oct19/gate0-summary.json）。
- 10/19 remote読取ではBridge単体301、Railway `/api/version` とremote mainは `ff180b8d62c903bbee3465889735bddfc39a53ea`。公開repositoryのvisibilityは変更していない。`desktop-latest` tag先はinstaller生成sourceの証明に使わない。独断のrollback/差替えはしない。
- 保守対象はPython `irsdk-bridge/bridge.py`→Desktop canonical read-only projection→会話/音声配送/記憶。race truth/Planの唯一ownerはBridge。必要なcompatibility projectionと歴史証拠を死コードと混同しない。

## 検証の現在地

- WO001–021は各定義sliceの機械検証APPROVE。全製品/全series/実LLM意味/音声/Windows/iRacing/DB/商用品質の合格ではない。設計/受入範囲は `review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md`、各実装・独立判定は `review/PITWALL_SHARED_WORKING_LOG.md`。
- WO019で接続した相談：window質問→早期pit申告/理由→実ACK→pit15/penalty16→同epoch再接続→debrief訂正/保存→次raceで訂正付き参照。十分給油なら不要BOX0、不足給油ならfresh Plan/authorityから必要BOX。保存provider応答とIO模擬による実Bridge×全Renderer×実serverの検証。
- WO020の親最終E2E46/0/0・独立7cuts・unit24/17・CI正負28は上記。関連回帰は100/110exit0、開始99/109、共通109に新規exit後退0。非0の10suite（JS5：engineer-card/proposal-roundtrip/gap-answer-queue/previous-fuel/outbox fixture、Python5：judge_llm_gate/phase_ab/pit_exit_forecaster_wiring/session_authority_wiring/strategy_reevaluation）は既存失敗として残る。
- 製品追加API0。同条件proxy chat3/translate33/TTS24（token/実費ではない）。原価証拠はrepository外 `../OMORAY-PITWALL/reports/daily-cost/`。料金/紹介/無料期間/権限/課金設定を今回変更しない。

## 残る限界と次の判断

- opening整合は候補以前の最遅安全周を選ぶ限定修復。早いpitの戦略価値・Plan B/C全体の幾何整合は未検証。
- 既存5秒binding TTLによるradio待機/長文の中断・破棄、再提案配送の不整合疑いはWO021で機能修復へ拡張しない。未知/未確定の疑いを解消済みとしない。
- 実LLM意味、実STT/TTS/マイク/PTT/最終音声とOverlay/会話記憶の一致、Windows/Electron export、PyInstaller EXE/Store packaging/CI artifact upload、iRacing/SubSessionID実測、PostgreSQL、installer、全preflight/release gateは未確認の範囲を残す。
- WO021は先頭の定義範囲で完了。次段階は次のGOで確定する。新しい機能拡張（全車戦略DB、setup全般、動画比較等）をこの保守作業へ混ぜない。外部テスターの再開や商用施策は別判断。

## WO構造改革とは別に保持するOwner指示・予約scope

- **レース戦略データ基盤／継続学習ループ**：10/1共有logの将来要件と監査継続メモ。構造改革後に、取得可能な全車の動向→候補/判断/発話→Driver応答/実行→pit cycle/終了結果を同一時間軸・Decisionで保存し、replay評価を通じ次回判断へ還元する。見逃した提案機会も評価する。rival非公開値を事実にせず、保存だけを学習と呼ばない。WO001–021完了にはこの新データ層の完成を含めていない。正本：共有log「2026-10-01 監査Codex：将来要件メモ」、`review/IMSA_FIXED_RIVAL_STRATEGY_LEARNING_BRIEF.md`。
- **燃料セーブ／stint延長の更新提案**：9/14共有log「Codex最新指示：追加待ち解除」の次段予約scope。必要セーブ量・延長可能周回・成立条件と戦略価値を計算しLunaが更新発話する。既存fuel回答/Plan A/B/Cの存在だけで予約scope全体を完了としない。着手時に既存実装と受入条件の差分を確認する。
- **過去天候・setup進化・Memory→Strategyの統合要件**：`review/MEMORY_TO_STRATEGY_SHARED_UNDERSTANDING_V1.md` §17。既存実装を持つため全件未着手とはしないが、WO001–021承認だけでこの統合scopeの全出口/実走を完成済みとしない。source→保存→取得→次回提案→結果/訂正を別途照合する。

上記はOwnerの既存要望/予約scopeとして保持する。今回の確認質問を新データ層の実装GOやBuild/公開承認へ読み替えない。10/19追記：直前の「残るのは検証」の説明だけではこれらを省略していたため、現行引き継ぎへ復元。次のMDに指示書あり

## 作業・公開の境界

- 現scopeは先頭のOwner指示によりCodex開発担当が製品/恒久test実装、親Codexが独立確認。全preflightと独立review後の未公開候補作成/検査まで今回GOの対象。公開/production deployは完成候補を示して別承認後。外部有料API/追加購入/課金設定/予約は承認対象外。既存dirty treeを保護、無関係な作業をcommitへ混ぜず、新MDを作らない。
- Build/公開の依頼時は `review/PITWALL_RELEASE_GATE.md` 全文からGate0–5/変更時7、公開後6/8、停止10を守る。source/合成artifact/実取得artifact/Windows実走を区別し、preflightのみで出荷合格にしない。新candidateは既存公開302との識別を明確にしてから扱う。
- serverを反映する場合は `verify-deploy.sh --url <承認済み対象URL> <対象SHA>` と機能経路の結果を記録する。SHA一致だけでDB migration/API利用可を合格にしない。実行承認のない現在は実行しない。
- 開始順はAGENTS→本HANDOFF先頭→program該当WO→共有log最新回覧。最新表のSHAと入口出口の実証から独立確認し、担当の自己報告だけで承認しない。

## 履歴と証拠の所在

旧HANDOFFの中間停止/未公開記述は現在の指示から除去した。**旧履歴の原文は `../pitwall-local-evidence/wo021-oct19/start-source.tar` 内HANDOFF.md（開始SHAはstart-sha.json）に保全**、WO020最終版もobservability/parent-final-source.tar内にある。新しい履歴MDは増やさない。過去回覧は既存共有log、恒久方針はAGENTSと `review/FOUNDER_SCOPE_LOCK_MINIMUM_REAL_AI_ENGINEER_20260905.md` を参照する。

Road Atlantaの歴史的赤ケース（2026-09-22、公開302）：Driver申告を作戦変更として受理せず、pit15給油16.79L/penalty16給油0Lを旧Plan21へ誤結合。lap21で燃料18.14L/完走必要9.98L/余裕8.16Lにも旧BOX18Lを発話。これはWO001 fixtureの再現値であり現行sourceの出力ではない。修復の各機械証拠はWO019/20永続証拠へ分離している。

永続証拠：`../pitwall-local-evidence/wo019-oct18/`、`wo020-oct18/`（openingとobservability）、`wo021-oct19/`（今回）。/tmp消失時に過去の結果を再実行済みとせず、この保全済みSHA/ソース/rawから再開する。
