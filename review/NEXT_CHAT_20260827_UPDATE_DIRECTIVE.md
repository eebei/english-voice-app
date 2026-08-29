# Claude Code 作業指示 — 2026-08-29 JST

## 今回の到達点

公開済みの Build 290 を基準に、明日のニュルブルクリンク北コース 4 時間耐久で使う**「ブリーフィングで人が合意した Team Plan が、実走行の判定・ドライバー交代・レース後の学習まで途切れず反映される」**完成した縦の一機能を実装してください。

これは文言だけの会話機能ではありません。Luna が訂正を「了解」と言うだけで、実際の戦略・引き継ぎ・次回利用に反映されない状態を終わらせる作業です。現ローカル先頭は `a47bf21 Harden RBR pace and fuel response authority`。Build 290 はすでに公開済みです。

## 絶対条件

- **Build、署名、公開、push、deploy はしない。** 実装・テスト・コミットまで行い、完成品を Codex に返す。
- 無関係な既存変更は触らない。新しい計画 MD は増やさず、完了報告は `review/PITWALL_SHARED_WORKING_LOG.md` の末尾に追記する。
- LLM の推測を燃料・順位・Gap・タイヤ・天候・損傷などの実測事実にしない。事実は Bridge/構造化データを正とする。
- 生の音声、会話全文、Team Link Code をログやサーバーへ保存しない。既存のコスト・プライバシー方針を維持する。

## 実戦設定（設計確認用）

- Driver 1: 八木さん / Driver 2: まーぼさん / Driver 3: ダートさん
- 各 PC は自分の `このPC: Driver N` を選ぶ。走行者の自動認識を偽装しない。
- 本番 Team Link Code は `109876-PW-NUR4-8Q7K`。**テスト fixture にはこの値を使わない。**
- `現在担当` は交代順の現在スロット。通常走行中に各 PC が頻繁に手で切り替える設計にしない。交代確定時に正しく次へ渡ること。

## 実装対象：Briefing → Team Plan → Live evidence → Handoff → Result memory

### Chief Engineer Mode は本案件の必須実行面

本案件の Team Plan は、単体の会話台帳やローカル画面だけでは完成ではありません。**Chief Engineer Mode の設定・交代・relay・受信画面を通って初めて有効**です。

- Chief Engineer Mode を有効にした各 PC の `このPC: Driver N`、roster、`現在担当` を正しく使うこと。
- ここで保存・確定した Plan、実測、stint summary が、Chief の handoff packet を通って次 Driver の Chief UI／短い再確認発話へ届くこと。
- Chief Mode が無効な通常の単独走行では、既存の通常会話・戦略・個人成績を壊さないこと。

これは新しい別Phaseではなく、上記「Briefing → Team Plan → Live evidence → Handoff → Result memory」を成立させる現行案件の受入条件です。

### 1. 人間主導の初期 Team Plan と段階ブリーフィング

初めての 4 時間ニュル北耐久で、Luna が根拠なく完成戦略を発明してはならない。

1. 人間が初期方針を入力／発話する。
2. Luna は一度に 2～3 項目だけ短く確認する。
3. 人間の訂正・追加を構造化した Team Plan の**候補**へ反映する。
4. 明示的な確認（例:「その内容で確定」「はい、確定」）でのみ `confirmed` revision にする。
5. 「違う」「修正」だけ、または曖昧な発話では以前の confirmed plan を変えず、必要情報を短く聞く。

自由文だけで終わらせず、以下を revision・更新時刻・根拠種別（human / bridge evidence）付きで保持してください。

- ドライバー順と交代の意図
- 初期ピット／燃料方針（不明は不明のまま）
- 最初の 3 clean laps で実測燃料を確定して再判定する方針
- タイヤ・損傷・天候変化時の見直し条件
- 人間の確認状態

レース開始時の読み上げは既存の短い grid line を保ち、一気に長文をキュー投入しないこと。段階ブリーフィングは明示的な開始操作／発話から進め、通常レース中の無関係な「はい」を捕まえて Plan を変更しないこと。

### 2. 実測による小変更だけを提案する Live authority

3 clean laps が揃った時点で、Bridge 実測値から下記を初期 Plan と比較して提示してください。

- 現在燃料、clean fuel burn、サンプル数
- ドライバー平均ラップ、残時間からの予測周回数、予測ピット窓／完走マージン
- track/air/wetness 等、取得できる天候値（未取得なら「未取得」）
- 4 輪の計測済みタイヤ値、損傷と修理要否／履歴（未取得なら推測しない）

許されるのは根拠値付きの「Plan 維持」または**小変更候補**です。変更は人間の明示確認でのみ confirmed Plan に昇格させること。確認されない限り燃料目標・pit now・タイヤ交換指示を勝手に上書きしないこと。

「北コースで残り 70% なら交換不要」を固定ルールにしない。必要ならユーザー確認可能な review threshold として扱い、4 輪値、次スティント、路面／天候、損傷・修理時間が揃わない時は正しく判断保留にすること。

### 3. Driver handoff に完全な作戦文脈を載せる

交代 packet と受信 UI に、既存の fuel/next pit/gap/damage/tire summary を壊さず以下を追加してください。

- confirmed Team Plan の revision と内容（候補・未確認の内容は確定事項として渡さない）
- 直近の実測燃料・clean sample 数・平均ラップ・予測周回／完走マージン
- 天候、損傷、修理／ピットサービス履歴、4 輪タイヤ計測値（存在する範囲のみ）
- 送信ドライバーの stint summary: identity、best lap、average lap、valid/clean laps、fuel burn、incidents、pit/repair events
- 次ドライバーが受信後に短く再確認できる表示／発話導線

同じ Link Code の既存 relay で、対象ドライバー照合と stale packet 拒否を維持してください。別 driver 向け packet を適用しないこと。手元表示だけではなく交代先まで到達する配線を完成させること。

### 4. レース後に使えるチーム学習データ

各 driver stint の構造化サマリーを次回 PITWALL が参照できる形で保存してください。最低限、driver 別の best/average、clean laps、燃料、incidents、pit/repair、確定 Plan と実際の差分を持たせること。

既存個人成績を壊さないこと。incident の対象範囲を明示し、存在しないデータを「0」と断定しないこと。race debrief の成績・incident は LLM 要約ではなく確定した構造化ソースで回答できる配線にしてください。

## 既存不具合を再発させない受入条件

- 「後ろの方がペース早い」等の相対ペース質問が、総燃料不足だけを理由に `pit now` と誤答しないこと。`a47bf21` の authority 修正を保持する。
- Gap は同一対象・時点の物理値を検証し、ドライバーの訂正を単なる文言記憶にせず、誤った値を確定事実として再利用しないこと。
- Plan window があるのに stale/誤分類 generic horizon が勝って「今すぐ pit」にならないこと。
- 冒頭記憶・ブリーフィングが音声キューを詰まらせず、重要な終盤が切れないこと。
- 実測のないライバル pace は「未確認」。60 Hz の自車運転スタイル信号をライバル pace と混同しないこと。

## 必須テスト

実装箇所に合わせて既存テストを拡張し、少なくとも以下を自動テストしてください。

1. 初期 Plan → 2～3項目確認 → 訂正 → 明示確定の state/revision 遷移。
2. 曖昧な「はい」や通常会話では Plan が変わらないこと。
3. 3 clean laps の実測で「維持」と「小変更候補」を区別し、確認なしでは live authority が変わらないこと。
4. fuel / lap / weather / tyre / damage の欠損値が推測値やゼロに化けないこと。
5. handoff の serialize/deserialize、対象 Driver、stale packet、Plan revision、stint summary。
6. 次 Driver の受信画面／会話導線まで実際に配線されること。
7. race debrief が構造化 stint/result から確定値を出し、対象範囲不明時に断定しないこと。
8. 既存 Engineer Card、Plan Fuel Authority、Strategy Playbook、Local Intent Router と新規テスト一式。

可能ならブラウザ相当の一往復を含む end-to-end 寄りのテストを追加してください。外部 API や本番 Link Code を使うテストは禁止です。

## 完了時の返却形式

実装完了後、`review/PITWALL_SHARED_WORKING_LOG.md` 末尾へ次を記録して返してください。

- 変更ファイルと、各配線がどこまで実到達するか
- Team Plan state schema と確認条件
- handoff に追加した実データと未取得時の挙動
- 永続化先と次回参照経路
- 実行した全テストと結果
- commit hash
- 未解決事項があれば P0/P1/P2 と、耐久前に使えない機能を明記

Codex が独立再確認します。テスト未実行、片側だけの UI、会話文言だけの実装は完成として返さないでください。

---

## 追指示 — Codex独立再実行で判明した完成ゲートの是正（Phaseはまだ開始しない）

上記 Team Plan 実装の完了報告は受領したが、Codex の独立再実行で `./preflight.sh` が成功終了していないことを確認した。**新しいPhaseの実装には入らず、この是正だけを完了させること。**

### A. `tests-memory-action-layer.js` を赤のまま残さない

現在の失敗は次です。

`proactive briefing says that stored session history was used`

1. `a47bf21` を含む実装前基準でも同じ失敗か、同じコマンド・出力で再現して記録する。
2. 既存不良であっても、公開候補を赤のまま返さない。期待値が古いのか、本番の briefing から履歴利用の根拠が脱落したのかを調べ、正しい製品契約を実装とテストで一致させる。
3. assertion の削除、常時true化、単なるskipで通すことは禁止。履歴未取得時に「使った」と言わない fail-closed も維持する。

### B. HTTP統合テストとdeploy確認を、コード失敗と実行環境制約に分離する

Codex環境では `node tests-chat-http.js` が `listen EPERM 0.0.0.0:3901` で止まった。この環境固有のポート制限を、`auth.js`変更によるサーバー起動失敗と混同しないこと。

- bindできる通常ローカル環境で HTTP統合テストを実行し、Team Plan relay schema追加後も server起動・既存API契約が通る証拠を出す。
- bind不能環境では、無断で本番ポート・外部サービスへ逃がさない。テスト用の安全な設定注入／明確な環境skipの扱いが既存方針に合うかを確認し、必要な最小修正とそのテストを追加する。
- deploy確認は実deployをしない。資格情報やネットワークが無い場合、コードテスト失敗として偽装せず、何が未実行かを明記する。

### C. 完了条件

- Team Plan 112/112、chief cross-PC 19/19だけでなく、`preflight.sh`がコード／テスト起因の赤を残さず完走すること。
- どうしても外部環境が必要なものは、ローカル製品テストと分離した上で、未実行理由・再現手順・P番号を正確に報告すること。既存不良の「報告だけ」は不可。
- 修正後に全関連テストを再実行し、実行できた／できないものを分けて共有ログ末尾へ追記する。
- 実装はcommitする。Build、署名、公開、push、deployは引き続き禁止。

この是正がCodex確認で合格するまで、Phase Fを受け取ったものとして作業を始めないこと。

---

## Phase F — Trackside Strategy Intelligence V1（開始許可）

上記の Team Plan／Chief Engineer Mode／preflight是正をCodexが独立再実行し合格と確認した。ここからは、耐久中の Luna が**実測に基づく短い判断を正しく返し、確定Planを壊さずに使える**ための Phase F を実装する。

Build、署名、公開、push、deployは禁止のまま。実装・テスト・commit・共有ログ報告までで返すこと。既存 Team Plan を作り直したり、自由文の会話記憶を新しい事実源にしないこと。

### F1. 前後相対ペースの専用 authority

「前の方がペースが速い」「後ろが迫っている」への回答は、燃料不足・自車の60 Hz運転スタイル・古いGapを代理根拠にしてはならない。

- 同一クラスの前後ドライバーを、CarIdx／時点／freshnessを固定して実測比較する dedicated authority を作る。
- 可能な限り近傍10台、将来全同クラスへ拡張できるデータ形を採用する。ただしデータ欠損時に全車分析を装わない。
- 回答は「相手・前後・比較した有効周／時間窓・差分」を根拠として短く返す。材料不足なら `未確認` と返す。
- 燃料／pit回答は既存の Plan Fuel Authority へ任せる。相対ペース質問から total fuel shortfall を理由に `pit now` を出さない。

### F2. Gap truth とドライバー訂正の扱い

`F2Time`等のGap入力は、対象CarIdx・観測時点・鮮度・値の連続性を検査してから応答へ使うこと。別車両や古い0.1秒を、現在の後方車間として言わない。

ドライバーが「実際は1秒以上後ろ」と訂正した場合、自由文記憶を新しい実測値に昇格させない。一方で、誤った既存値を以後の確定事実として繰り返さず、該当ソースを保留／再観測へ戻す導線を作ること。

### F3. 燃料・Plan・live小変更の一元化

初期Plan、3 clean lapsの実測、燃料質問、pit推奨、Chief handoffで、異なるpit窓や燃料目標を発話しないこと。

- 確定Team PlanとBridge実測を同じ authority snapshot から参照する。
- 計画どおり／小変更候補／pit now の条件を明確に分ける。
- 小変更は人の明示確認まで候補のまま。交代先にはconfirmed revisionだけを引き継ぐ。
- 最初の3 clean lapsは燃費と平均ラップを同じ有効周集合で使い、残時間→予測周回→必要燃料／pit窓を再計算する既存契約を壊さない。

### F4. Chief Engineer Modeでの耐久実戦導線

Chief Modeでは、F1〜F3の確定／未確認状態と根拠が、次Driverへのhandoffと短い再確認に届くこと。Chief無効の単独走行を壊さないこと。

タイヤ・天候・損傷は、計測値と必要材料が揃わない限り「交換不要」「修理不要」と断定しない。70%固定ルールは禁止のまま。

### 必須受入テスト

1. 前後それぞれの相対ペース、欠損、古いデータ、別CarIdx、同クラス外を固定再生する。
2. 相対ペース質問が燃料shortfall由来のpit nowにならないこと。
3. Gapの対象取り違え・古い値・ドライバー訂正後の再観測を固定再生する。
4. Team Plan／Bridge／fuel質問／handoffで同じauthority snapshotを使い、未確認候補がconfirmedへ漏れないこと。
5. Chief有効のPC間handoffとChief無効の単独走行を実経路で検査する。
6. 既存 Engineer Card、Plan Fuel Authority、Fuel Timing Authority、Strategy Playbook、Local Intent Router、Team Plan、Chief cross-PC、preflight全体を再実行する。

完了報告には、authorityの入力・鮮度条件・fail-closed時の発話、変更ファイル、全テスト、commit、P0/P1/P2を `review/PITWALL_SHARED_WORKING_LOG.md` 末尾へ記録すること。Codexが独立確認する。
