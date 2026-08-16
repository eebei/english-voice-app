# OMORAY PITWALL 引き継ぎ

最終更新: 2026-08-15 JST

## Build 272 公開完了

- 8/15 Yuji Monza 20 と八木さん12時間耐久の報告を同じ燃料権威へ統合した。
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

- 実装コミット: `94fe328`（`Build 272 harden endurance fuel and radio calls`）。
- GitHub Actions: push build `31874909906` 成功、公開workflow `31875015398` 成功。
- Release: `desktop-latest` は **OMORAY PITWALL Desktop — Build 272** を表示。
- 公開installer: `OMORAY-PITWALL-Setup-latest.exe` 100,602,321 bytes、SHA-256 `eb0b9f60806a3e44ceaeb8b0e156ce428bc68eed98eadb784f3f51b284be9b13`。GitHub Releaseから取得して照合済み。

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
- 公開済みビルド: **272** — コミット `94fe328`（`Build 272 harden endurance fuel and radio calls`）
- 公開インストーラー: `https://github.com/eebei/english-voice-app/releases/download/desktop-latest/OMORAY-PITWALL-Setup-latest.exe`
- GitHub Actions の公開Windowsビルド: `31875015398` 成功。
- 公開後の URL 取得を確認済み: 100,602,321 bytes、SHA-256 `eb0b9f60806a3e44ceaeb8b0e156ce428bc68eed98eadb784f3f51b284be9b13`。

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
- 販売・検証の第一市場を日本へ切り替える。日本語で導入と実走改善を集中し、次にブラジル等の熱量が高い地域を一地域ずつ展開する。広い英語圏へ同時に薄く売らない。
- 最大目的は「SIMドライバーが、リアルレースで人間のレースエンジニアと走る感覚を体験すること」。ピット側の診断画面は必要でも、ドライバー側へ別の分析ダッシュボードを増やすことを商品中心にしない。
- 中核: GT3 とロードコースのレース運用 — 実測燃費、ピットタイミング、レース文脈、安全コール、簡潔な無線、デブリーフ。
- GTP/プロトタイプ、Super Formula、INDYCAR、オーバル、ダート、深いセットアップ助言を、現在提供済みの機能として販売しない。
- 今回は料金、紹介、無料期間、利用権に触れていない。本番の料金・トライアル・紹介ロジックは変更していない。
- DREの現行公式機能・料金、PITWALLの8/9〜8/14実測原価、iRating別ターゲット仮説をまとめた日本語の正本は `docs/DRE_OMORAY_COMPARISON_20260815.md`。初期ICPはRoad iRating 1,800〜3,000を中心とするGT3・IMSA・耐久の本気層。差別化は記憶そのものではなく、画面を増やさず「今必要な一つの判断」に絞る品質で検証する。

## 次の作業

1. Windows 実機で、旧ビルドからの更新、表示 Build 番号、Bridge 自動開始を確認する。
2. iRacing 実走で、無線診断・デブリーフ継続質問を確認する。
3. 本当の無操作自動更新とストリーミング TTS は、別の安全確認付き設計として進める。
