# PITWALL Internal Simulation & Cost-Gate Policy

Status: Canonical shared policy  
Owner: OMORAY PITWALL  
Applies to: Every update, regression review, build candidate, and release candidate

## Purpose

通常のアップデート検証で、Yujiやテスターの実走と本番Anthropic／Google APIを不必要に消費しない。
更新時は内部シミュレーションを標準とし、実API・実走は最後の限定確認だけに使う。

## Non-negotiable rules

1. 通常の自動テストではAnthropic、Google STT、Google TTSを呼ばない。
2. 外部APIは決定論的stub／fixtureへ置換し、呼出回数がゼロであることを検証する。
3. 実APIスモークテストはリリース候補でのみ実行し、件数と推定上限原価を事前に明示する。
4. Yujiの実走は、音声の自然さ、運転中の間合い、実テレメトリ接続など内部代替できない最終確認に限定する。
5. 「生成した」「キューへ入れた」「TTSを要求した」「再生を開始した」「完了した」「破棄した」を別イベントとして記録・検証する。
6. 生成済みだが未再生・破棄された回答にもAnthropic原価が発生する前提で、不可視の無駄生成を失敗扱いにする。

## Required simulation matrix

### 1. iRacing state

- 接続／切断／再接続
- Practice／Qualify／Race／終了後
- 直線、舵角あり、ブレーキング、低速／停止
- テレメトリ欠損・stale
- 燃料、ラップ、順位、ギャップ、ピット、損傷の状態変化

### 2. Speech window and queue

- 舵角・ブレーキ中は通常回答を保留する
- 安全窓が開いたら保留回答を1回だけ再生する
- P0/P1安全無線は通常ゲートを越えて開始できる
- 保留中の同義・同一回答は新規生成せず統合または抑止する
- 情報の有効期限を過ぎた回答は再生せず、破棄理由をtraceする
- キュー上限時は安全優先度を維持し、破棄対象と理由をtraceする
- 割込み、TTS失敗、timeout後も二重再生・二重計上しない

### 3. No-data and unavailable replies

- 回答に必要な権威データがない場合、LLMへ渡せるケースでも短い固定回答を優先する
- レース中のno-data回答は原則1文、20〜30文字程度を上限目安とする
- 例: `今はそのデータがない、ごめん。`
- データがないのに説明、言い訳、一般論を長く話さない
- 同じno-data回答を短時間に繰り返さない
- 呼びかけられた場合は沈黙せず、短く返す

### 4. Anthropic simulation

- 短文、長文、空回答、途中終了、token上限、401、429、5xx、timeout
- input／output／cache read／cache write token fixtureによる原価計算
- 発話待ち時間がAnthropic原価を増やさないこと
- 保留中に同一意図のAnthropic呼出を重ねないこと
- 未再生・期限切れ・破棄回答の生成数と推定原価を集計すること

### 5. Google STT/TTS simulation

- STT成功、空認識、失敗、timeout、実測秒数欠損
- TTS成功、空audio、失敗、timeout、再試行、fallback
- TTSは発話キューから実際に取り出す前に呼ばないこと
- 文字数／秒数の帰属と二重計上防止

### 6. Cost gate

各テスト結果に最低限、次を出す。

- 外部Anthropic呼出数（通常テストは0）
- 外部Google STT/TTS呼出数（通常テストは0）
- simulated API calls
- generated replies
- played replies
- deferred replies
- expired/discarded replies
- estimated Anthropic cost
- estimated Google cost
- wasted-generation cost（生成済み・未再生）

通常テスト中に実外部API呼出を検出した場合、そのBuild候補は失敗とする。

## Release sequence

1. Unit tests: fixtureのみ、外部APIゼロ
2. Integration replay: 保存済みテレメトリ／会話列、外部APIゼロ
3. Accelerated race simulation: 数時間相当を短時間再生、外部APIゼロ
4. Real-API smoke: 明示した少数ケースのみ
5. Short real drive: 音声の自然さと間合いだけ最終確認

## Completion evidence

アップデート完了報告には以下を含める。

- この仕様書の各該当項目に対するテスト名
- 外部API呼出ゼロの証拠
- simulated／played／discarded件数
- 原価ゲート結果
- 実APIを使った場合の件数、目的、実測または推定原価
- 実走でしか確認していない項目の明示

コードを書いただけ、テストが単独で通っただけ、実走で偶然一度成功しただけでは完了扱いにしない。

