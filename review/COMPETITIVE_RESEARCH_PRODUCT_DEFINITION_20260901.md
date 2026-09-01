# PITWALL 競合深掘りと製品定義 — 2026-09-01

## 結論

競合から最も学ぶべきなのは、機能数でも価格でもなく、**必要な答えを短く、速く、競合する無線に負けずに届ける設計**である。

PITWALL の長期差別化は、ドライバー自身のテレメトリ読上げではなく、同一クラスの有効順位、ライバルのピットサイクル、相対ペース、復帰トラフィック、判断結果を継続して結ぶことにある。ただし、現時点でこの全体像を完成・公開済みと扱ってはならない。

## 0. 状態を混ぜないための基準線

### 現在のローカルソース／private candidate

- Build 292 の private artifact は Gate 0〜5 と Gate 7 が合格している。
- ローカルには、固定 intent の決定論ルーター、Bridge-fact の直接回答、Plan A/B/C、条件付き undercut、Decision ID による提案→実行→結果→session closure、無線優先度、近傍ライバル観測の Phase F が存在する。
- これは「コードに存在する」「機械テストを通った」という意味であり、Windows 実機・iRacing 実走で有用な回答が届いた証明ではない。

### 公開状態

- 2026-09-01 の共有台帳では公開中は Build 291。
- Build 292 は公開 GO 前の candidate であり、公開済みと書かない。
- Build 291 の 8/30〜8/31 実走では、rejoin 質問の誤分類、ドライバーの pit 決定への不適切な上書き、stale fact の再放送、race result が debrief に届かない問題が確認されている。

### 実走未確認

- Build 292 の `driverCommand` が自然にドライバー決定へ従うこと。
- `RACE SUMMARY GATE` と `INCIDENTS DIAG` が実データを捕捉し、必要な debrief へ届くこと。
- Phase F の近傍ライバル観測、field coverage、戦略候補が実戦で正しい相手を追うこと。
- 正しい回答が別無線に負けず、遅延・切断・誤配信なしで聞こえること。

### 将来像

- 全同一クラスを継続観測し、effective order と pit cycle を推定する。
- 戦略候補を比較し、証拠と不確実性つきで最善案を勧める。
- 結果を採点し、同条件・異条件を区別して次のレースへ学習を持ち越す。
- これは Founder 評価でまだ「片足の小指」の段階であり、現在能力として広告しない。

## 1. 軽量化・高速化・コストダウンの実装候補

### 1-1. fixed intent は local fast path を正本にする

PitWise は fuel、laps、tyres、pace、pit、position などを telemetry から offline で即答し、free-form chat だけを任意の外部 AI key に分離している。DRE と Crew Chief も大量の定型 command を local recognition／command routing で扱う。

PITWALL への適用:

- gap、position、fuel、laps、pit setting、weather、damage、repeat は LLM を通さない。
- intent 分類だけでなく、**answer construction と delivery acknowledgement まで** local fast path に含める。
- unknown は local の構造化 unavailable で返し、LLM に推測させない。
- 成功条件は handler が値を返したことではなく、`request_id → answer_id → speech_started → speech_completed/aborted` が閉じたこと。

期待効果: 低遅延、API費削減、矛盾削減、障害時も回答継続。

### 1-2. STT/TTS を能力別に分離し、local fallback を測定する

PitWise は Whisper と音声を PC 上で動かし、外部 AI/TTS は optional key にしている。DRE は classic local Windows Speech Recognition と local TTS を提供する。

PITWALL への適用候補:

- 頻出コマンド用の小型 local ASR／grammar recognizer を cloud STT の前段または fallback として比較試験する。
- Cloud TTS failure 時の local voice fallback は維持するが、声質より first-audio latency、認識率、CPU/GPU/RAM、install size を優先して評価する。
- ユーザー PC へ処理を移す判断は、費用移転ではなく、低遅延・可用性の測定結果で行う。

採用ゲート: 日本語の実走発話 corpus で intent 到達率、p50/p95 latency、CPU/GPU peak、誤発火率、更新失敗率を cloud 経路と比較する。

### 1-3. radio scheduler を独立した deterministic subsystem にする

DRE は team mate が話している時に新規発話を始めない Busy Detection を持つ。Crew Chief は spotter だけが chief を interrupt する既定挙動、priority queue、repeat last message を持つ。これは生成AIより直接的に「届くか」を改善する。

PITWALL への適用:

- P0 safety、driver-request answer、pit decision、strategy update、pace/PB、social の順序を明文化する。
- 新着の高優先度発話で何を中断し、何を再開し、何を破棄するかを kind ごとに固定する。
- driver answer は unrelated radio に置換されない専用 slot を持つ。
- `repeat last answer` を固定 intent として追加し、直前の「完了した回答」と「中断された回答」を区別する。
- duck/drop/abort の理由をログ化し、答えが消えた時に handler、queue、TTS のどこで失われたか分かるようにする。

### 1-4. LLM は option comparison と短文化だけに限定する

authoritative engine が evidence と viable options を JSON で出し、LLM は以下だけを担当する。

- 競合する選択肢の文脈比較。
- 不確実性の説明。
- ドライバー状態に合わせた短文化。

LLM が fuel、gap、position、pit lap を再計算・修正することは禁止する。期限内に返らなければ deterministic recommendation をそのまま話す。

## 2. リアル担当エンジニアを AI で実現するために不足する能力

### 2-1. field-wide rival model

競合の多くは「前後」「指定 opponent」「rival names」までである。DRE は opponent exiting pits と player の merge point rendezvous、competitor time loss、striking distance を公開している。PITWALL の目標はこれを超え、全同一クラスを戦略単位で扱うこと。

不足:

- class entry count と観測済み台数を結ぶ field coverage。
- stale／missing／別 class を除外した opponent identity。
- on-track order、effective order、pit-cycle order の分離。
- 各 rival の pit timestamp、stint age、relative pace、traffic exposure、予測 rejoin range。
- 「誰を undercut するか」「誰を cover するか」を decision の対象として固定する opponent binding。

### 2-2. 状況の継続理解と plan revision

固定計算の集合だけでは担当エンジニアにならない。必要なのは、現在の plan、成立条件、破棄条件、次に見る証拠を一つの状態として保つこと。

不足:

- Plan A/B/C の成立条件と expiry。
- driver が決めた pit call を最上位の実行状態へ昇格する仕組み。
- SC、damage、traffic、rival stop、fuel deviation による明示的な再評価。
- 変更時に「何が変わったため、何を変えるか」を一文で伝える能力。

### 2-3. decision-outcome learning の field validation

Decision ID の local 実装は存在するが、製品価値は翌レースの正しい発話まで届いて初めて成立する。

不足:

- predicted rejoin と actual pit exit／blend後位置の自動照合。
- undercut 成功を rival pit timestamp なしで認定しない因果基準。
- success／failure／unknown を同じ強さで保存すること。
- track×car×format×temperature×traffic 条件を比較し、前回結果を過剰一般化しないこと。
- driver correction を受けた記録の訂正と、次回 briefing での反映確認。

### 2-4. delivery assurance

これは補助品質ではなく、中核能力である。

不足:

- すべての質問／自発介入に end-to-end delivery state を持つこと。
- latency budget: telemetry age、intent、reasoning、TTS fetch、queue wait、audio duration の分解。
- deadline を過ぎた strategy answer を stale として再生しないこと。
- safety interrupt 後に driver answer を再開／要約再送すること。
- セッション後に missed answer、misroute、late answer、ducked answer を自動集計すること。

製品 KPI は intent accuracy 単独ではなく、`useful answer heard within deadline / answer-required situations` とする。

## 3. 追わない機能・価格競争

### 3-1. 追わない機能

- 「500／800 command」など command 数の競争。必要な engineer task の成功率を優先する。
- 29／59 languages の数競争。まず日本語・英語の実走認識とdeliveryを完成させる。
- 多 sim 対応。iRacing の rival/pit-cycle understanding を浅くするなら追わない。
- telemetry overlay、track map、G-meter、30秒trace の総合ダッシュボード化。radio decision に必要な表示だけに絞る。
- ACC setup file 自動書込み、巨大 setup database、generic corner coach。別カテゴリであり、PITWALL の「担当エンジニアがレース全体を見る」進路を遅らせる。
- personality、roast、称賛の量産。人間味は重要だが、正答・timing・silence を壊してまで増やさない。

### 3-2. 追わない価格競争

- PitWise の €3.99 買い切り、Crew Chief の無料、DRE の free tier を基準に値下げしない。scope、cloud cost、継続的判断、memory、founder support が異なる。
- optional API key で顧客へ費用を移すことを「同じ原価」とみなさない。setup friction、失敗時support、予算超過、privacy も user-side cost に含める。
- 2026年末までは売上最適化より、少人数での first-race success と repeat use を優先する。

## 4. 競合別の使い方

### PitWise

学ぶ: offline STT/TTS、deterministic telemetry answers、optional AI、one-file/no-admin、低コスト構成。

追わない: 多sim、overlay、setup writing、言語数、買い切り価格。

公開情報で未証明: field-wide effective order、rival pit-cycle intelligence、decision outcome learning。

### DRE

学ぶ: priority-aware audio、team comm silence、repeat、pit-exit rendezvous、local command path、auto-fuel execution。

追わない: command／alert 数、audio signal の網羅競争、tier ごとの声質競争。

PITWALL が超えるべき点: 個別 alert ではなく、誰と何を争い、今の判断が最終結果へどう効くかを一つの plan として説明すること。

### Crew Chief

学ぶ: 成熟した event-driven reflection、priority queue、spotter interrupt 規律、repeat last message、local voice recognition、広い fallback。

追わない: 無料 spotter と同じカテゴリでの機能網羅。

### RaceCrewAI

学ぶ: cockpit を離れず contextual answer を得るという体験表現、real racing logic を構造化trainingへ変える見せ方。

注意: 公式ページの real-time／contextual／adapts 等は marketing claim。field-wide rival strategy や delivery reliability の公開証拠とは区別する。

## 5. 次に試す実装順

1. **Answer Delivery Ledger**: request、source fact、route、queue、speech start/end、drop reason を一つの ID で記録する。
2. **Repeat/Recover**: `もう一度` で直前の完了回答を再生し、中断回答は短縮して再送する。
3. **Deadline policy**: safety、gap、pit、strategy ごとに最大 telemetry age と answer deadline を定義する。
4. **Radio collision replay test**: driver gap question、PB、stopped car、strategy update を同時投入し、期待順序と再開を固定する。
5. **Field coverage wiring**: SessionInfo の class entry count を Phase F へ通し、`observed/eligible/stale/unknown` を出す。
6. **Opponent-bound decision**: strategy decision に対象 rival と根拠 snapshot を必須化する。
7. **2本連続 field convergence**: missed／misroute／late／stale／fabricated が新型0・既知型再発0になるまで完成扱いしない。

## 6. 受入基準

各 feature は次を全部満たすまで「製品能力」と数えない。

1. 状況が発生した。
2. authoritative evidence が存在した。
3. 正しい consumer／handler が受け取った。
4. 話す／黙る判断が正しかった。
5. deadline 内に driver が聞いた。
6. 無関係な発話に置換されなかった。
7. 内容が理解可能だった。
8. 結果が採点・訂正できた。

## 外部一次資料

- PitWise official: https://pitwise.net/
- DRE official pricing/features: https://www.thedigitalraceengineer.com/pricing/
- DRE official product page: https://www.thedigitalraceengineer.com/
- Crew Chief official repository: https://github.com/mrbelowski/CrewChiefV4
- RaceCrewAI official: https://racecrewai.com/

