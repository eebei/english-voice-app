# F1意思決定構造と音声AI会話製品からのPITWALL独立調査（Claude）

作成日：2026-09-13 JST／担当：Claude Code（独立調査）
本書は調査レポートである。製品コード・commit・Build・公開は一切変更していない。採用提言ではない。

Codexの同名調査（共有MD末尾「F1の意思決定とPITWALLのレース会話構成：Codex独立調査」）を先に読み、その参照資料11本と重複しない資料を中心に独立調査した。以下で【事実】は出典に明記がある内容、【推論】は私が資料から導いた解釈、【不明】は確認できなかったものを指す。

---

## 1. 参照した一次資料一覧（Codex未使用のもの中心）

### F1・耐久（モータースポーツ）

| # | 出典 | 発行日 | 種別・読了範囲 |
|---|---|---|---|
| 1 | Ruth Buscombe（元Ferrari/Alfa Romeo/Haas 戦略担当）[When is going backwards the best way forward?](https://ruthbuscombe.substack.com/p/when-is-going-backwards-the-best) | 2026-07-17 | 本人執筆・一次／本文取得 |
| 2 | 同 [How we go racing at a new track, part 1](https://ruthbuscombe.substack.com/p/how-we-go-racing-at-a-new-track-part) | 2026-09-10 | 同上 |
| 3 | 同 [part 2](https://ruthbuscombe.substack.com/p/how-we-go-racing-at-a-new-track-part-dad) | 2026-09-12 | 同上 |
| 4 | 同 [part 2.5: the error that haunts me](https://ruthbuscombe.substack.com/p/how-we-go-racing-at-a-new-track-part-9b8) | 2026-09-12 | 同上 |
| 5 | Aston Martin F1公式 [INSIDER: How AMCF1 make strategy calls, at HQ & on track](https://www.astonmartinf1.com/en-GB/news/feature/insider-how-amcf1-make-strategy-calls-at-hq-and-on-track) | 2021-10-28 | チーム公式／本文取得 |
| 6 | Aston Martin F1公式 [INSIDER: Formula One race strategy special](https://www.astonmartinf1.com/en-GB/news/feature/insider-formula-one-race-strategy-special) | 2021-08-05 | チーム公式／記述は薄い |
| 7 | Williams F1公式 [Strategy, Structure and Strong Futures](https://www.williamsf1.com/posts/63b01af9-d006-4233-9c13-6ee8d60ec38f/williams-in-the-news-strategy-structure-and-strong-futures) | 2025-09-10 | チーム公式／本文取得 |
| 8 | Formula1.com公式 [F1 EXPLAINS: inside an F1 pit lane – Bernie Collins](https://www.formula1.com/en/latest/article/f1-explains-what-goes-on-inside-an-f1-pit-lane-with-strategy-guru-bernie.6w7WwASefNkk5nZ2IIDqLG) | 2024-11-15 | 公式／**音声本体は未聴取**、記事側のみ |
| 9 | 24 Heures du Mans公式 [Pit stop tactics](https://www.24h-lemans.com/en/news/pit-stop-tactics-a-major-factor-at-the-24-hours-of-le-mans-60740) | 表記10/06/2026（DD/MM解釈で2026-06-10、**書式未確定**） | 主催者公式／本文取得 |
| 10 | Genesis Magma Racing公式 [2026 WEC Season Guide Part 3: Pit Stops](https://newsroom.genesis.com/genesis-magma-racings-2026-wec-season-guide-part-3-pit-stops/) | 2026-08-18 | チーム公式／本文取得 |

### 音声AI・エージェント構成（Speak以外）

| # | 出典 | 発行日 | 種別・読了範囲 |
|---|---|---|---|
| 11 | Sierra [Constellation of models](https://sierra.ai/blog/constellation-of-models)（著者 Thiaga Rajan） | 2025-12-03 | ベンダー技術ブログ（自社宣伝含む）／本文取得 |
| 12 | ElevenLabs [Unpacking ElevenAgent's Orchestration Engine](https://elevenlabs.io/blog/unpacking-elevenagents-orchestration-engine) | 2026-02-27（最終更新2026-09-11） | 同上 |
| 13 | LiveKit [Voice agent architecture: STT, LLM, and TTS pipelines explained](https://livekit.com/blog/voice-agent-architecture-stt-llm-tts-pipelines-explained)（著者 Jesse Hall） | 2026-02-21 | 同上 |
| 14 | LiveKit公式docs [Turns overview](https://docs.livekit.io/agents/build/turns/) | 日付表記なし | 製品ドキュメント／本文取得 |
| 15 | arXiv 2606.30531 [Entity Binding Failures in Tool-Augmented Agents](https://arxiv.org/abs/2606.30531)（Babu, Indukuri） | 2026-06-29 | プレプリント／**要旨まで**、査読状況未確認 |
| 16 | arXiv 2403.20329 [ReALM: Reference Resolution As Language Modeling](https://arxiv.org/abs/2403.20329)（Moniz ら, Apple） | 2024-03-29（SIGDIAL 2024採択） | 学術／要旨まで |
| 17 | arXiv 2607.14275 [AI Agents Do Not Fail Alone: The Context Fails First](https://arxiv.org/html/2607.14275v1)（Bousetouane） | 2026-07-15 | プレプリント／本文の骨子まで |
| 18 | arXiv 2605.13841 [EVA-Bench](https://arxiv.org/pdf/2605.13841) | 2026（v3） | プレプリント／要旨まで |

---

## 2. F1意思決定構造からの追加知見

**(a) 判断を「利得」でなく「可逆性」で分類する【事実】**
Buscombeは grid penalty を取る判断を Bezos の「2-way doors（引き返せる扉）」で説明する。下振れが限定されるなら期待値が中立でも取りに行く「free option」になる。単一予測ではなく、penaltyを取る世界／取らない世界の両方をMonte Carlo（1シナリオ8,000回）で回す。[1]
Codexが引いたMcLaren 2023英国GPの「実行期限」と同じ軸を、別系統の一次資料が独立に支持している。**追認が取れた数少ない点**。

**(b) 「いつロックされるか」が判断より先に定義されている【事実】**
FP3前に「土曜サーキットか日曜サーキットか」を決める必要があり、その選択は「車がFP3でコースに出た瞬間にロックされる」。[3] 判断の設計が、締切ではなく**不可逆点**を先に置いている。

**(c) 基礎→詳細→小技の順序【事実】**
「Basics, details, tricks」。周長・コーナー数・勾配などの基礎は、誤りが週末全体へ波及するため執拗に検算する。[2]
【推論】PITWALLにおける「基礎」はdriver identity・現在lap・session種別・対象車の同定である。ここが壊れたまま戦略提案（=tricks）を足すのは順序が逆で、Gate 8の失敗の並びはこの逆順と整合して見える。

**(d) 誤りの帰属は「どの前提が外れたか」まで割る【事実】**
Baku 2019、彼女はsoftの早期劣化を正しく読んで5周目にpitしたが、mediumも同様に劣化すると一般化したのが誤りだった。総括は「タイヤが直ったのではなく路面が直った」。Ferrari時代の規範として「間違えてよい、ただし同じ間違いを二度はしない」を挙げる。[4]
Codexの「失敗を一括りにするな」と同方向だが、**原因帰属の粒度**（単一セッションのデータを他コンパウンドへ一般化した、という前提レベルの誤り）まで踏み込む点が追加知見。

**(e) 予測できないときは観測を設計する【事実】**
新コースでは「2台・2コンパウンドで開始し、8周目にどちらが不利かを知る」ように戦略をあえて割る。[2]
【推論】1台のPITWALLへ翻訳するなら「最初のstintで燃費実測を確定させ、以後の提案の前提を実測へ差し替える」形になる。

**(f) tracksideとfactoryの分業は、役割でなく締切で切れている可能性【事実＋推論】**
Aston MartinのMission Control（Silverstone）は、pit時期の助言、天候の警告、ライバル無線の解釈を担う。記事中の動詞は一貫して advise / alert / explain であり、決定はtracksideに残る書き方になっている。最終権限の明示は【不明】。[5][6]
【推論】これは「重い解析を別の場所に置く」設計であって、「判断者を増やす」設計ではない。分けているのは専門分野ではなく**許容レイテンシ**である。

**(g) 耐久では「誰が乗っているか」が一次状態である【事実】**
WECのstintは概ね45分〜1時間、Le Mansでは1人が3〜4時間連続で乗ることもある。track engineerのArthur Trouttetは「テレメトリで機械データを監視してpit時期を決める」と述べる。[9][10]
【推論】F1の一次資料はdriver identityを状態として扱わない（常に1人だから）。鈴鹿6時間のidentity欠損・交代後チェッカー燃料の問題は、**F1構造の単純移植では埋まらない領域**である。

**(h) driverが異議を唱えた時の再判断プロセス【不明】**
「戦略決定はstrategistに残す、driverは全体像を持たない」という言説は複数の二次資料に現れるが、**チーム公式の一次資料では確認できなかった**。Williams公式のMonza事例は、Albonが交代に乗り気でなかったがチームは実行した、という行動の記述にとどまる。[7] 依頼された焦点のうち、この一点は回答できていない。

---

## 3. 音声AI会話製品構成からの追加知見

**(i) 「正しいツールを呼んだが対象を間違える」は独立した失敗クラスであり、値段が付いている【事実】**
60タスク・複数モデルで、**wrong-tool誤りは0.0%、それでもwrong-entity行動が24.0〜26.0%**発生した。対策4種（entity-resolution precondition／confidence-gated binding／曖昧時のclarification／provenance追跡）でwrong-entityは消えたが、**曖昧時に判断を保留するため直接のタスク完了率が下がった**。[15]
これはPITWALLのGAP対象混同と構造が一致する。同時に「対象を厳密にすると答えない回数が増える」というトレードオフが定量で提示されており、Yujiの「no-dataを減らせ」という製品方針と正面から衝突しうる論点になる。

**(j) 参照解決は、候補を列挙してから選ばせる問題として解かれている【事実】**
ReALMは画面上の実体を**相対位置を保ったテキスト表現**に並べてLLMへ渡し、「下のやつ」「その番号」の解決を小型モデルでGPT-4級にした。[16]
【推論】PITWALLの「後ろの車」も同型の問題。現行は`player_class_position±1`で入口の時点で1台へ潰しているが、ReALM型は逆に**候補集合を保ったまま渡す**。

**(k) 文脈の正本は「実際に聞こえた分」である【事実】**
LiveKitは割り込み時にTTSを止め、会話履歴を**ユーザーが実際に聞いた部分まで切り詰める**。「音は検知したが転写が空」のfalse interruptionを別イベントとして扱い、再開できる（既定2.0秒）。[14]
【推論】PITWALLは「発話した」と「ドライバーに届いた」を分けていないと見られる。

**(l) レイテンシは段ごとに予算配分される【事実】**
転送<50ms／STT初回部分100–200ms／LLM TTFT 200–400ms／TTS TTFA 100–300ms、体感1秒未満。最大のレバーは推論とメディアのco-location。[13] ElevenLabsはorchestratorの上乗せを<100msと主張（自己申告）。[12]
【推論】「専門計算を足す」提案は、**この予算表のどの段にいくら入るか**を言えなければ評価できない。

**(m) 遅い処理は「重さ」でなく「可逆性」で3モードに割り振られている【事実】**
ElevenLabsのツール実行は Immediate（高速参照）／Post-Tool Speech（実世界への行動の前に人が止められる）／Async（背景）の3モード。加えてpre-tool speechで「確認しますね」を先に鳴らして間を埋める。[12]
【推論】これはF1の(a)(b)——可逆な判断は早く、不可逆な判断は確認を挟む——と同じ形をしている。分野の違う2系統が同じ構造に着地している点は注目に値する。

**(n) 実運用の「複数モデル」は合議ではなく検閲層である【事実】**
Sierraは15以上のモデルを用途別に使い分けるが、その上に**応答前に**scopeとpolicyへ照合するsupervisorを置く。明示的に「推論に強いモデルは速い応答を強いると著しく劣化する」と書かれている。[11]
【推論】これはCodexの候補Cとは形が違う。専門家が意見を出し合う構成ではない。PITWALLには既にtruth gate（9/12ログで「Practice、7200秒。」をblock）というsupervisor相当が存在する。不足しているのはgateではなく、gate通過後に**対象と根拠が同伴していない**ことに見える。

**(o) 文脈の失敗は7面に分けて監査される【事実】**
role clarity／guardrail／instruction consistency／tool schema／**grounding sufficiency**／injection／token efficiency。grounding不足（根拠がないのに答える）が独立した面として置かれる。「弱い検索agentが悪い証拠を起案agentへ渡す」連鎖も明記。[17]
【推論】タイヤ質問が一般接続確認で返った件（実routerに`live={}`を入れても同じconfirmed文が返る）は、intent分類の失敗ではなく**grounding sufficiencyの失敗**として扱うほうが再発しにくい。intent側だけを直すと、別の質問語で同じ穴が開く。

**(p) 「曖昧なら聞き返す」は無料ではない【事実＋不明】**
複数の業界資料が「推測せず確認」を推すが、効果の具体数値（誤り27%減など）は二次資料の要約経由で、**一次確認できていない**。(i)の定量結果と合わせると、聞き返しは完了率を犠牲にして安全を買う取引である。

---

## 4. PITWALL既知failureへの対応表

| 既知failure | 業界事例からの示唆 | 構造原則（症状別修正ではなく） |
|---|---|---|
| **GAP対象混同**（順位隣接±1で選び、物理直後と混ぜ、発話は「後ろX秒」だけ） | wrong-toolは0%でもwrong-entityが24〜26%出る[15]／候補集合を相対位置つきで保持して解く[16] | 対象を入口で1台へ潰さない。候補集合＋relation（物理直後／順位争い）＋gap_basis＋sample時刻を最終発話まで同伴させ、**発話本文に対象の同定子を必ず載せる**。同定子を言えないなら発話しない |
| **identity欠損**（user_id=null / cust_id=null → matching_race_unavailable） | F1一次資料に前例なし（常に1人）[7]／耐久はstintとdriverが一次状態[9][10]／context失敗7面のうちgrounding sufficiency[17] | identityは「取れたら使う属性」ではなく**前提条件（precondition）**。未確定なら履歴照合を実行しない、ではなく実行させない。耐久のdriver交代は自前で設計するしかない領域と認める |
| **ファイナルラップ判定の1周ずれ**（公式14 / debrief 13、`?周`が発話本文へ） | 基礎の誤りは週末全体に波及するので執拗に検算する[2]／「?周」のようなプレースホルダは欠損の表明であって値ではない | lap counterは「基礎」層。team結果と個人stintを別集計とし、**欠損は欠損として省略する**（プレースホルダを文字列化して発話経路へ流さない）。1周ずれは計算式でなく権威ソースの選択問題として扱う |
| **燃料相談のno-data/誤分類**（前回pit・給油時期が誰のものか不明、garage状態のFuel 0.0をチェッカー値に固定） | 単一予測でなく複数世界を回す[1]／予測が外れたら「どの前提が外れたか」まで割る[4]／stale contextが下流を汚染する[17] | 「値がない」と「値が無効」と「値が古い」を別状態にする。**非運転状態の観測を確定値へ昇格させない**。答えられないときは無音ではなく、前提と幅を付けた推定を返す（Yuji方針）——ただし(i)のトレードオフを承知の上で |
| **タイヤ質問が一般接続確認へ誤分類** | grounding sufficiencyの失敗として扱う[17]／supervisorは応答前にscope照合する[11] | intentの粒度を増やすのではなく、**返答テンプレートに「対象データの取得時刻・有効性」を必須引数にする**。引数が埋まらなければそのテンプレートは発火しない。対象別regexの追加で閉じない |

### Codexの構成候補A/B/Cへの私の評価

- **A（会話中心＋共通ツール）：条件付き賛成。** Codexは「簡潔だが弱いかもしれない」と置いたが、今回調べたSierra・ElevenLabs・LiveKitはいずれも**出口が単一の会話ループ**で、専門性はツールとsupervisorで足している。「会話が主、計算はツール」はむしろ業界の既定形である【事実】。Aの弱点とされた「質問時しか再計算しない」は、Asyncツールモード[12]とper-session stateful worker[13]で塞げる形が公開されている【推論】。Aを「単純だから弱い」と先に外すのは根拠が弱い。
- **B（専門計算＋Luna集約）：条件付き、ただし「先に採る」ことには反対。** F1のtrackside/factory分業[5]とは整合する。しかしBの失敗様式を今回の学術資料が名指ししている——「弱いagentが悪い証拠を下流へ渡す」「要約が重要な警告を圧縮で消す」「持続メモリが誤情報を保存する」[17]。Codexが挙げた懸念（古い専門結果、版違いの共有状態）は、**追加調査によって弱まるどころか強まった**。Bを選ぶなら、専門結果に取得時刻・対象・有効性の同伴を必須とし、欠けたら集約側が使わない契約が先。契約なしのBは7月案の反復になるリスクがある【推論】。
- **C（複数LLM専門家＋統括）：反対寄り。** Sierraの構成は一見Cに似るが、実体は「タスク別モデル＋出力検閲supervisor」であって、専門家の合議ではない[11]。合議はレイテンシ予算[13]と正面から衝突する。そしてPITWALLの5つのfailureは、どれも**推論力の不足ではなく、対象・状態・根拠の欠落**に見える。LLMの人数を増やしても欠落した根拠は生成されない【推論】。
- **横断する所見【推論】：** 5つのうち少なくとも4つ（GAP対象、identity、final lap、燃料）は、A/B/Cのどれを選んでも同じように残りうる。これらは構成の選択ではなく**状態契約の選択**で決まる。構成比較の前に、共通の観測レコード契約（対象ID／relation／取得時刻／有効性／由来）を1本定め、**現行Build 301のままそれを通して何件消えるか**を測るのが、最も安い反証実験になる。

---

## 5. 未確認事項・調査の限界

- podcast音声2本（Bernie Collins [8]、Ruth Buscombeの公式F1 podcast）は**未聴取**。記事側の要約のみで本人の発言は確認していない。
- Aston Martin公式[5][6]は2021年。2026年の体制と一致する保証はなく、名指し人物の現職も未確認。
- arXiv 4本[15]〜[18]のうち本文まで読んだのは[17]の骨子のみ。[15]の数値（24.0〜26.0%）はタスク設計・モデル構成を未検証のまま引いている。査読状況は[16]（SIGDIAL 2024採択）以外**未確認**でプレプリントの可能性。
- ベンダーブログ[11][12][13]は自社宣伝を含む。<100ms等の数値は**自己申告**で独立検証していない。
- 24h-lemans記事[9]の発行日は 10/06/2026 表記。DD/MM解釈で2026-06-10としたが書式は未確定。
- **「driverが異議を唱えた時の再判断プロセス」の一次資料は見つけられなかった。** 依頼の焦点の1つに答えていない。
- PITWALL側は9/12ログとCodex記述の範囲で照合した。7,042,252バイトのログ全体は再解析しておらず、Spa（9/11）側は未読。
- 候補A/B/Cの実装も計測も行っていない。第4節の評価はすべて資料からの推論であり、測定による反証ではない。

---

## 6. 結論：次にYujiと相談すべき論点

実装着手の可否を判断できる材料は、本調査では揃っていない。以下は結論ではなく、判断の前に決めるべき論点である。

1. **構成（A/B/C）より先に「観測レコードの契約」を決めるべきか。** 5failureのうち4つが構成非依存に見える。契約だけを現行Build 301へ通す反証実験は、構成比較より安く早い可能性がある。
2. **「対象を厳密にすると答えない回数が増える」をどう引き受けるか。** [15]はwrong-entityを0にする代わりに完了率を落とした。Yujiの「予測は外れても提案する」方針と、対象取り違えの防止は同じ方向を向いていない。**どこまでのno-data・聞き返しを許容するか**の数値を、測定前に決める必要がある。
3. **発話を可逆性で3分類するか。** F1の不可逆点[3]と音声AIの3モード[12]が同じ形に着地している。PITWALLの発話にも「即時に言ってよい／確認を挟む／背景で更新する」の区別を入れるかは設計判断であり、私は決められない。
4. **耐久（driver交代）はF1に前例がないという認識を共有するか。** identity・stint・交代後のチェッカー値は、F1の一次資料からは設計を借りられない。ここだけは自前設計であるという前提をYujiと揃えたい。
5. **truth gateは強化対象か、それとも設置場所の問題か。** 既にsupervisor相当が働いている[11]形と照らすと、不足はgateの厳しさではなく、gate以前に根拠が同伴していないことに見える。どちらへ投資するかは未決定。
6. **Codexとの相違点を先に潰すか。** 私はA（会話中心）をCodexより高く、C（複数LLM）をCodexより低く評価した。Bへの慎重論は両者一致した。この差を、測定で決めるのか議論で決めるのかを先に決めたい。

以上。本調査の記録は実装GOではない。
