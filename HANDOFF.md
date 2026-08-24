# OMORAY PITWALL 引き継ぎ

最終更新: 2026-08-24 JST

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
