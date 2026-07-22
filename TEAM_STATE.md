# PITWALL チーム共有台帳

**目的**：Yuji / Claude Code / Codex / ChatGPT が**同じ事実**を見るための唯一の台帳。
**分類の定義は Codex 設計**、**中身は Claude Code がコード・ログ・git 履歴から記入**。

## 出荷手順（2026-07-20 Yuji決定・必須）
**修正 → ①機械チェック → ②Codexの最終確認 → ③ビルド → ④実走**
1. **`./preflight.sh` を必ず通す**（未定義変数・構文・競合テスト）。通らないものは出荷しない
2. **Codexを最終の砦とし、差分を確認させる**（Yuji決定）。設計レビューだけでなく**出荷直前のコード確認**まで担わせる
3. その上でビルドし、実走で検証する

**なぜこの手順になったか**：2026-07-20、`msg` と書くべき所を `data` と書いた1行が websocket ハンドラを殺し、
Lunaが発話するたびに接続が切れて**ドライバーの問いかけに一切応答できなくなった**（予選が丸ごと無駄に）。
設計レビューでは見つからないが、**機械なら一瞬・コードを読めるCodexなら確実に見つかる**種類の誤りだった。
Yuji「これオフィシャルレースじゃないからまだ対応できるけどな」＝**本番なら許されない失敗**という認識。

## 運用ルール
1. **ビルドを動かす主張には出典を付ける**（ログ / テスターの言葉 / URL）。「良さそう」では着手しない。
2. **格上げは証拠が要る**：HYPOTHESIS → VERIFIED（ログ or テスト）→ SHIPPED（実購入 or 実走）。
3. **降格も正直に**：壊れたら BROKEN へ。古くなったら SUPERSEDED へ移し、現行へリンクする。
4. **書けるのは自分が確かめた領域だけ**。Codex は EXTERNAL FACT と分析、Claude Code はコード・ログの事実、Yuji は実車の検証。

最終更新：2026-07-20（Build 193 時点）

---

## SHIPPED
*実購入・本番・実走で確認済み*

- **Founding Driver Program（2026-07-11〜）**：**$29.99/月・Locked In＝永久固定**。Stripe 本番稼働。決済→会員化→exeコード発行→welcomeメール→解約まで**テスト決済で全経路実証**。**純粋な顧客購入は0件**（2026-07-22 Yuji確認）。テスター（まーぼー・ダート）は初月無料コードで招待、課金実績なし。
- **紹介システム**：33/66/100%OFF、コード自動発行・メール送信・失効処理まで**テスト決済で技術経路を実証**。顧客間の紹介実績は0件。Founding 加入者だけの永続特典。
- **ホームページ** omoraypitwall.com：Cloudflare 経由で apex/www 両方 HTTPS。Web Analytics 稼働（Cookie 不要）。Foundingは5日トライアル付き決済直行、開発テスターは申請制。
- **Desktop exe 配布**：GitHub Actions で自動ビルド→Release 公開。DLリンクは常に最新を指す（`OMORAY-PITWALL-Desktop-latest.exe`）。
- **exe 起動コード**：購入時に自動発行（`PITWALL-氏名-XXXXXX`）。1台LRU方式で共有を防止。
- **走行中UI**：レースオーバーレイ（無線チャット専用・非アクティブ窓でFFB喪失を回避）、常時最前面。
- **マイク受け皿**：デバイス選択UI＋レベルメーター＋テスト＋自動ゲイン。
- **Build 193（2026-07-20 10:30 出荷）**：後述の 2026-07-19〜20 修正群を全て含む。

---

## VERIFIED
*ログまたはテストで確認済み*

### テレメトリの実力（2026-07-06 実機ダンプ・SDK全334変数を確認）
- 取得できる：自車 Brake/Throttle/Steer、他車の位置/ラップ、3軸G、公式デルタ、`CarLeftRight`（iRacing公式スポッター値）、`CarIdxF2Time`（レース中は周回差の影響を受けず任意順位間ギャップに使える）。
- **取得できない**：他車のペダル入力。
- **タイヤ温度/摩耗はピット入庫時のみ**（走行中は全12ch同一のデフォルト値39.4＝偽データ）。Build 168 で確定。

### 2026-07-19〜20 のログ由来の発見（全て修正済み・Build 193）
- **停止車警告が構造的に一度も鳴れない状態だった**：`last_battle_global`(15秒)の抑制下にあり、Monza はマルチクラスが12秒毎に94回鳴って窓が永久に開かなかった。加えて「6秒圏外で一度武装」が必要なため、目の前でスピンした車は永久に鳴らない。→ 両方撤廃。
- **タイムが日付として読まれる**：秒部分が10秒未満の時に2桁ゼロ埋めされ「06.630」となり TTS が日付と解釈。→ 先頭ゼロ廃止。
- **燃料の完走可否計算が全周デタラメ**：`leaderLap=-1`（位置1が非走行車を指す）＋`lapsTot`誤読で `rem_est=0` に。→ リーダー検出を堅牢化・lapsTot にサニティ。**「あと何周分の燃料があるか」は堅牢で正しかった**（壊れていたのは「レースがあと何周あるか」）。
- **マルチクラス警告が12秒毎に94回**、しかもクロスクラスのギャップが不正確（実0.1秒を4-5秒と誤報）。
- **まーぼーの "didn't catch that" は STT 障害ではなくマイクのデバイス選択問題**（ログで空文字列を確認）。

### 体制上の事実
- **Codex はこのワークスペースの PITWALL コードを読める**（2026-07-20 に本人が確認）。変更せずにコードレビュー・構造確認・ログ分析が可能。**実装と統合の主担当は Claude Code のまま**、Codex は読める立場からの反対尋問・監査役。
  ※2026-07-12 の「Codex はコードを見られない」は**現在は誤り** → SUPERSEDED 参照。
- **ChatGPT（ブラウザ側）はコードを見られない**ため、技術コストに基づく主張は Claude Code か Codex の実測に依る。

---

## DECIDED
*決定済み。理由と変更禁止条件つき*

### 価格（変更禁止条件あり）
- **既存 Founding 会員の $29.99/月・永久固定は変更禁止。** 理由：**「Locked In」は明示的な約束であり、信用がこの製品の core。** 変更したい場合は**新規顧客向けの別プランとしてのみ**設計する。
- 低価格競争はしない（月980円案は不採用）。

### 発話アーキテクチャ（2026-07-19 確立）
- **Fast Lane（反射・LLMを通さない）＝衝突と手順のみ**：停止車両・サイドバイサイド・クラッシュ・インシデント・ピットリミッター・ピット入口/出口/ボックス。理由：0.1秒が命。
- **それ以外は全て LLM 判断（`NO_CALL`で黙れる）**。理由：**固定文は「言うか言わないか」しか選べないが、判断層は「黙る」を選べる。沈黙こそ一流のエンジニアの仕事。**
- **燃料・ペース・危険ドライバーは Fast Lane に置かない**（文脈が要る／誤警告の実害がログで確認済み）。
- **事実は固く、言葉はふんわり**：数値・安全は決め打ち、言い回しは LLM に委ねる。理由：捏造を防ぎつつ機械音を避ける。

### 配布（2026-07-20 決定）
- **当面はコード署名証明書を買わない**（OV 6万円/年・EV 7.8万円/年）。理由は**予算だけではない**：
  **EV でも SmartScreen を即座には通過しない**（＝金を払っても問題が解決しない）。効かない出費は優先度が最低。
- **再検討の条件**：①有料利用者が増えて年6〜8万円が誤差になる ②かつ評判蓄積の期間を許容できる
  ③または **Microsoft Store 配布**（SmartScreen 回避に最も確実・要調査）が現実的と分かった時。
- **それまでの現実解**：初回起動ガイドの導線を磨く（無料）。Founding 規模＝少人数・高接触なので手引きで越えられる。

### 優先順位
- **①リアルタイム精度を先に直し、③ビッグデータは後**。理由：**誤読は記憶に毒（汚れた蛇口）**。
- **オーバル対応はロードの完成後**（ただしテスターの実需要が出たため再検討中 → HYPOTHESIS 参照）。
- Go-to-market は**日本優先・ロード優先**、ただし**製品アーキテクチャは多言語**（日本限定製品にはしない）。

### ドライバー記憶（2026-07-19 実装）
- 数字（タイム/順位/燃料）と**人物理解を分離して保存**。人物側は**憶測禁止・既出反復禁止**（増やすのでなく濃くする）。理由：**走るほど理解が深まることが Crew Chief 等との差別化の核**。

---

## HYPOTHESIS
*まだ計測されていない仮説（＝根拠として使ってはいけない）*

- **API 実原価 / 利益率80%**：**未計測**。1セッションあたりの Claude・STT・TTS・Railway・決済手数料の実額が無い。**価格議論はここが埋まるまで推測。**（Codex の指摘は正しい）
- **PTT 遅延 1〜3秒の内訳**：**未計装**。どの区間で時間を使っているか不明。Codex 提示の計測点（ptt_release〜playback_started）を採用予定。
- **オーバル/ロードのシステム分割の価値**：テスター（まーぼー）の実需要はあるが、市場規模・実装コストとも未評価。
- **「40人・半年で自己資金化」**：事業計画上の仮定であり実績ではない。
- **Microsoft Store MSIX 試作の実機互換性**：公式要件と現行コードの静的確認では**実現可能性が高い**。ただし、Store用 AppX/MSIX から同梱 `OMORAY-PITWALL-Bridge.exe` の起動、`taskkill`、iRacing SDK共有メモリ、常時最前面オーバーレイ、グローバルホットキー、マイクを実機で未検証。次の判定点は「Store提出」ではなく「ローカル署名したMSIX試作で1レース完走」。**試作は Build 193 の実走検証後。**
  - **Claude Code によるコード側の裏取り（2026-07-20）**：Codex が挙げたリスク箇所は**全て実在**する。`desktop/main.js:207` で同梱Bridge exe を `spawn`、`:36` と `:238` で `taskkill /F /IM OMORAY-PITWALL-Bridge.exe /T` を実行、`:404` で **デバッグログを `app.getPath('desktop')` に直接書き出し**、`:12` に GitHub exe への更新ゲート URL。→ MSIX試作では**この4点を最優先で検証**する。
  - ⚠️**ログ保存先の変更は「軽微な検討事項」ではない**（Claude Code 判断）：**Desktop のデバッグログは我々の証拠エンジン**であり、2026-07-19〜20 の重大修正（停止車警告・日付読み・燃料の残り周回）は**全てこのログから発見**された。本台帳の「出典を付ける」規律も、テスター（まーぼー）のログ送付フローも、これに依存している。**MSIX へ進むなら、ログの保存先と受け渡し導線をセットで設計する**こと。ここを壊すと開発速度そのものが落ちる。
- **「走るほど理解する」で本当に差別化できるか**：CHIEF が横断記憶を明確に主張、RaceCrewAI も個人適応あり（EXTERNAL FACT 参照）。**「記憶がある」だけでは差別化にならない可能性**。差別化の芯を「記憶の深さ・日本語・現場インサイダーの声」に置き直す必要があるか要検討。

---

## BROKEN / KNOWN ISSUE
*再現条件と影響範囲*

| 問題 | 再現条件 | 影響 |
|---|---|---|
| **SmartScreen 警告** | 新しい exe を初回起動する全ユーザー | **50人展開の最大の摩擦。Yuji 自身も詰まった。** ⚠️**コード署名は即効薬ではない**（EVでも即通過しない＝EXTERNAL FACT）。現時点の方針は「買わない」（DECIDED 参照） |
| **マイク設定の躓き** | 既定マイクが SIM PC で意図しないデバイスの時 | **テスターの2/3が踏む構造的問題。** 受け皿UIは出荷済みだが根本摩擦は残る |
| `pit_box_stop` が日本語セッションで英語発話 | LunaJP でピット停止時 | 軽微だが没入を壊す。未修正 |
| ピットの**数字の秒読み**が無い | 常時 | 「Box here / Stop」の2段階のみ。要否は未決 |
| `ADMIN_SECRET` 未設定 | 常時 | 運用上の宿題（2026-07-11 から未着手） |
| bridge.py 単体変更が自動ビルドに乗らない場合がある | ワークフローのパスフィルタ次第 | 手動 dispatch が要る場合あり |

---

## EXTERNAL FACT
*URL・確認日・情報源*

### iRacing シリーズ規定（2026-07-19 調査 / **Yuji が実出場者として検証済み**）
- **IMSA iRacing Series Fixed**：**35分の時間制レース＋ピットストップ**。クラス速度順 **GTP > LMP2(Dallara P217) > GT3/GTD**。BoP で**小さめタンク**＝**中盤に最低1回の燃料ストップが基本**。**タイヤは全開でも最後まで持つ**（上位は無交換＝実質燃料のみのストップ）。ピットは **IMSA ルール＝ボックス最低滞在時間**あり（給油だけでも短縮不可）。8分予選→ローリングスタート。
  出典：[coachdaveacademy.com](https://coachdaveacademy.com/tutorials/iracing-guide-imsa-iracing-series/) / [iracing.com](https://www.iracing.com/series/imsa-iracing-series-fixed/) / [iracerhub.com](https://iracerhub.com/iracing-season-3-pit-stop-rules-by-series/)
- **GT3 Challenge Fixed（Fanatec）**：**約20分スプリント・無給油**（Yuji 検証済み）。固定セットアップ・単一クラス。
- **Porsche iRacing Cup**：911 Cup 992.2 ワンメイク、25〜30分スプリント、2026 から ABS 有効。**Yuji は未出走のため確度は上記2つより低い**（無給油スプリントの想定）。

### コード署名 / SmartScreen（Codex 調査・2026-07-20）
- **EV 証明書でも SmartScreen を即座には通過しない**（評判の蓄積が要る）。＝**「署名すれば解決」は誤り。**
- **OV**：GlobalSign 年 **60,000円**（税別）・最短 **3営業日**
- **EV**：年 **78,000円**（税別）・最短 **7営業日**
- **Microsoft Store 配布が SmartScreen 警告を最も確実に回避する**

### Microsoft Store 実現可能性（Codex 調査・コード静的確認・2026-07-20）
- **結論：MSIX/AppX経路なら実現可能性は高い。** 現行の portable EXE をそのままStoreへ登録する経路は全PEの有効なコード署名が必須なので、今回の「証明書を買わない」方針と両立しない。Storeへパッケージ本体を提出する MSIX/AppX 経路なら Microsoft が再署名・ホストし、証明書購入不要、Store管理更新とSmartScreen警告回避を得られる。
- `electron-builder` は `appx` ターゲットを正式サポートし、Electronに必要な `runFullTrust` を既定で付与できる。現行 `extraResources` のBridge EXE同梱も形式上は可能。
- **既存Stripe課金は維持可能。** PITWALLをPC向け非ゲーム製品として提出する限り、Store規約は安全な第三者課金APIと第三者の継続課金を認める。Partner Centerで第三者課金を申告し、Store説明にサブスク価格・トライアル条件を明示する。既存購入コードでの認証も禁止されていない。
- **Store版で変更が必要**：①`win.target`にStore専用`appx`ビルドを追加 ②Store版ではGitHub EXEへの強制更新ゲートを無効化しStore更新へ委譲 ③バージョンをStore用4区切り数値へ対応 ④`microphone`等のcapabilityと日英languageをmanifestへ宣言 ⑤iRacing必須をStore説明冒頭に明示 ⑥審査用の有効なデモコード／アカウントを提供 ⑦起動時にDesktopへ自動生成するデバッグログは、**証拠エンジンを維持したままStore互換の保存先へ移す設計が必須**（`userData`保存＋明示的Export等）。
- **最大の技術リスク**：Storeの制度ではなく、MSIXのPackage Identity下で `Bridge.exe`、共有メモリ、`taskkill`、オーバーレイ、ホットキーが現行通り動くか。`runFullTrust`により可能性は高いが、実走検証なしにSHIPPEDへ格上げしない。
- Microsoft Store開発者登録は新オンボーディング経由なら個人・会社とも無料。PITWALLは事業として販売するためCompanyアカウントが適切で、DUNSまたは法人・事業書類と独自ドメインのメールが必要。
  出典：[Windows配布経路](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path) / [Store MSI・EXE要件](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements) / [Store Policy 7.19](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies) / [Microsoft Electron MSIXガイド](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/guides/electron-packaging) / [electron-builder AppX](https://www.electron.build/appx/) / [開発者登録](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)

### Microsoft Store Company アカウント要件（Codex 調査・2026-07-20）
- PITWALLは事業として有料提供し、OMORAYという事業者名で公開するため、**Companyアカウントが適切**。IndividualからCompanyへ後日変更できないため、最初からCompanyで作る。
- 新オンボーディングは `storedeveloper.microsoft.com` から開始する。この経路ではCompany登録料は無料。個人MicrosoftアカウントまたはMicrosoft Entra IDの職場アカウントで開始できる。
- **事業確認は二択**：①有効な9桁D-U-N-S Number（Microsoft推奨・自動確認が速い） ②公式事業書類。DUNSなしの書類審査は手動になり、通常2〜5営業日。
- 公式事業書類の例：法人設立・登記書類、政府発行の事業登録／許可証、政府レジストリ記録、税務申告書。主書類が12か月より古く、現在の活動状態を確認できない場合は、直近12か月以内の税証明、金融機関・公共料金の書面、政府／商業登記の現行記録等を追加する。期限付き書類は申請時点で残存2か月以上必要。
- **照合一致が重要**：Partner Center、DUNS／事業書類、会社・屋号、所在地、Webサイト、ドメイン所有者、メールドメインを一致させる。主担当メールは個人に紐づく独自ドメインの職場メールを使い、Gmail/Yahoo、一般共有アドレス、グループalias、`+` addressingは避ける。
- メールドメインと事業ドメインが一致しない場合、ドメイン登録情報または購入・更新請求書など、事業者との関係を示す追加資料を要求される場合がある。
- Mandatory due diligenceが最初のブロッキング審査。その後Business verificationとEmployment verificationが進む。自動確認は数秒〜1分、手動審査は通常2〜5営業日。各審査の異議申立ては最大3回なので、名称・住所・メールを申請前に揃える。
- Publisher display name、アカウント種別、国／地域は登録後に容易に変更できない。**公開名をOMORAYにするなら、申請前に事業書類・DUNS・ドメインとの表記一致を確認する。** 顧客向け連絡先はStore商品ページで地域により公開される。
- D-U-N-Sは無料取得経路があるが、既存番号の有無を先に検索する。D&B公式では通常取得に最大30営業日、米加向け案内では有料迅速化で8営業日以内としているため、日本での実日数は確約しない。急ぐ場合は、手元の事業書類によるMicrosoftの2〜5営業日手動審査も比較する。
  出典：[Company開設手順](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account) / [Company確認要件](https://learn.microsoft.com/en-us/windows/apps/publish/store-business-verification-reqs) / [Store Policy 7.19](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies) / [アカウント管理FAQ](https://learn.microsoft.com/en-us/windows/apps/publish/faq/manage-your-account) / [D&B D-U-N-S](https://www.dnb.com/en-us/smb/duns/get-a-duns.html)

### 競合（Codex 提供・2026-07-20 / **Claude Code は未独立検証**）
- **PitWise**：€3.99 買い切り、4人格・29言語、AC/ACC/LMU/rF2/F1 23/iRacing、PTT双方向、ローカルSTT/TTS、自由会話は BYOK
- **RaceCrewAI**：現在 €10/月（通常予定 €24.99）、役割別AIチーム、Filipe Albuquerque 関与
- **GridFather**：ウェイトリスト中。人格・記憶・74言語を訴求（**ポジションが最も近い**）
- 他：iRCopilot / CHIEF / Apex Boss / trophi.ai / Crew Chief
- **セッション横断の個人記憶（＝我々の差別化主張）の状況**（Codex 調査・2026-07-20）：
  - **CHIEF**：横断記憶を**明確に主張**
  - **RaceCrewAI**：分析履歴・個人適応**あり**
  - **GridFather**：記憶を主張するが**未発売・未検証**
  - **PitWise**：横断記憶は**未確認**
- **ChatGPT Voice の音声出力は OpenAI 現行規約上、非商用限定**（録音して製品に組み込まない）

---

## SUPERSEDED
*過去の決定。現行へのリンク付き*

- ~~「7年 iRacing ベテラン」~~ → **誤り**。実際は元カートレーサー・サーキット運営8年・モタスポ輸入代理店8年（7年は eBay の話）。**現行の創業ストーリーはこちらが正**。
- ~~記憶「1階=コース×車種 / 2階=クセ」~~ → **1階=個人（a:事実 / b:クセ）、2階=集合知（Big Data）** に再定義。
- ~~マルチクラス接近を EstTime で判定~~ → LapDistPct へ（3e66594）→ **さらに数値を渡さない LLM 判断へ**（fa85c17）。理由：クロスクラスの秒数が不正確。
- ~~危険ドライバー閾値 SR≤2.5 / iR<1500~~ → **SR≤2.0 / iR≤1300・直前直後のみ・LLM判断**（2026-07-19）。理由：広すぎて鳴りすぎた。
- ~~毎周のタイム読み上げ（lap_time / lap_slow / lap_consistent）~~ → **廃止。3周平均 vs 前3周平均での判断＋単発タイムロスは「何かあった？」と尋ねる**（98cbc26）。理由：F1 でも読み上げはしない／まーぼー「毎回はうるさい」。
- ~~ベスト更新の定型文~~ → **言う事は確定・言い方は LLM**（98cbc26）。
- ~~「Codex / ChatGPT はコードを見られない」（2026-07-12 方針）~~ → **Codex は現在このワークスペースのコードを読める**（2026-07-20 確認）。役割は「外の地図だけ」から「**コードも読める監査役・反対尋問役**」へ更新。実装主担当は Claude Code のまま。
- ~~「SmartScreen の本命の解はコード署名」~~ → **EV でも即通過しないため誤り**（2026-07-20）。現行方針は DECIDED「当面は署名を買わない」。
- ~~Codex 提案「$29.99 一回払い ＋ 後に $12.99/月」~~ → **既に $29.99/月・永久固定で販売中のため不採用**。DECIDED の変更禁止条件を参照。**新規顧客向け別プランとしてなら再提案可**。
