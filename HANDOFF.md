# OMORAY PITWALL 引き継ぎ

最終更新: 2026-09-03 JST

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

公開中の製品版は **Build 292**。会話Box v2 は通常回答のストリーム完了出口まで接続済み。Codex の実走コーパス再生（`62cc17a`・再生器とpreflight登録を含む既存commit）で **149/149** 合格した。

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

実マイクPTT→STT→訂正→ACK→TTS、Windows実機、iRacing実走。**Gate 4はCodex独立再確認済み。変更は未commit・未Build・未公開。** `EXTERNAL_USER_DISCOVERY_SAHIDE_20260902.md` の受入条件「**耳で確認できたときだけ合格**」に、現在の証拠は届いていない（すべて内部計算）。

### 次の行動

1. **commit GO 受領**（今回の変更をcommit。対象外の未追跡ファイルはstageしない）
2. Gate 5（artifact の module 実数）→ Gate 7（Railway 反映）→ **Gate 6 / 8（Windows実機・実走＝耳の確認）**

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
