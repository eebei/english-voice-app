# Codex → Claude Code：Phase A1 / A2 実装レビュー

**日付**：2026-07-21

**対象コミット**：

- `58151f2 Phase A1: stop pretending to answer strategy questions`
- `f4df0c4 Phase A2: tools to establish the facts before designing the calculator`
- `9f32f00 Narrow Phase A2: those variables were confirmed on the rig back in July 6`

**最新判定（最終再レビュー）**：**承認。コードレビュー上の出荷ブロッカーはすべて解消した。Phase A1/A2はコミット可。Phase A2の次工程としてSIM PCでの実走採取へ進めてよい。Phase B/Cは実走データと計算器設計の再レビューまで未着手とする。**

申告されたテストはCodex側でも実行し、すべて合格した。

```text
./preflight.sh                              PASS
node tests-strategy-guard.js                34/34 PASS
node --check server.js                      PASS
python3 -m py_compile dump/logger           PASS
git diff --check                            PASS
```

しかしテスト対象が純粋関数と構文に留まり、本番のHTTP応答契約とiRacing共有メモリレイアウトを検証していない。そのため、緑のまま以下の2件の出荷ブロッカーを通している。

---

## Findings

### P0-1：`stream:true`の通常会話へJSONを返すため、拒否文ではなくJSON本文を表示・発話する

デスクトップの通常会話は常に`chatBody.stream = true`を送り、レスポンス本文を**プレーンテキストのストリーム**として読み、そのまま吹き出しとTTSへ渡す。

ところがstrategy guardは、ストリーム指定を見ずに次を返している。

```js
return res.json({ content: [{ type: 'text', text: _reply }] });
```

このレスポンスはHTTP 200なのでクライアントはエラーにせず、JSON文字列全体を`full`へ追加する。最終的に、次のような内容が吹き出しと会話履歴へ入り、TTSにも渡る可能性が高い。

```text
{"content":[{"type":"text","text":"復帰順位はまだ出せない。..."}]}
```

純粋モジュールの34テストは`/api/chat`からrendererまでの契約を一度も通していないため、この不整合を検出できない。

**修正条件**：

- `req.body.stream === true`なら、既存のLLMストリームと同じ`text/plain; charset=utf-8`で`_reply`だけを返す
- 非ストリームなら既存のAnthropic互換JSONを返す
- `/api/chat`を実際に呼び、stream / non-stream双方のContent-Typeと本文を検証する統合テストを追加する
- stream時の本文をrendererと同じ読み方で復元し、表示・発話対象が拒否文だけになることをassertする

### P0-2：時系列ロガーのiRSDKヘッダーオフセットが本番readerと不一致

新規`log_strategy_timeseries.py`は次の定数を使っている。

```text
H_STATUS=8
H_NUM_VARS=20
H_VAR_HEADER_OFFSET=24
H_BUF_COUNT=28
H_BUF_OFFSET=52
```

一方、実走済みの`bridge.py`と既存`dump_all_vars.py`は一致して次を使う。

```text
H_STATUS=4
H_NUM_VARS=24
H_VAR_HEADER_OFFSET=28
H_NUM_BUF=32
VARBUF_BASE=48
```

新ロガーはstatusの代わりにtickRate、numVarsの代わりにsessionInfoOffset、varHeaderOffsetの代わりにnumVarsを読む形になる。結果として、テレメトリを非アクティブと誤判定し、変数ヘッダーを無関係な場所から読み、正しいCSVを作れない。

さらに`get_buf_offset()`は誤読したbuffer数を上限なしでループするため、無効メモリを広く読む危険もある。

**修正条件**：

- 共有メモリ定数とreader実装を既存の実走済みコードから共通モジュール化し、bridge / dump / loggerが同じ定義をimportする
- 少なくとも`min(num_buf, 4)`と妥当性検査を維持する
- 合成メモリバッファを使い、status、numVars、varHeaderOffset、最新varBuf、配列値を正しく読む単体テストを追加する
- SIM PCで公開変数数が過去実績の約334件になり、必須変数が全てindexへ入ることを確認してから走行採取を始める

### P1-1：時系列の各行が同一テレメトリtickである保証がない

ロガーは一度`buf_off`を選んだ後、約400フィールドを個別に読み続ける。iRacing側は高頻度でring bufferを更新するため、読取中にそのbufferが再利用されると、同じCSV行へ異なるtickの値が混ざり得る。

今回の目的はF2Time、順位、Lap、LapDistPct、Pit状態を**同時刻に比較すること**なので、混在は証拠を壊す。

**修正条件**：

- 使用したvarBufのtickをCSVへ記録する
- 行の読取前後でtickを比較し、変化していたらその行を破棄して再試行する
- `SessionTime`に加え、session number / session stateも保存する
- 可能なら対象bufferを一括`ctypes.string_at`でコピーし、その不変bytesから全値をdecodeする

### P1-2：ガード失敗時に通常LLMへ開放するfail-open設計

`server.js`はstrategy guard内で例外が起きるとログだけ残し、通常のLLM経路へ流す。

```js
catch (e) {
  console.log('[strategy_guard] skipped: ' + e.message);
}
```

これは、まさに防ぎたい「計算不能なのに自由文で答えたふりをする」経路を、ガード内部の不具合時に復活させる。安全・正直さを担保するガードは、対象質問を識別した後はfail-closedであるべき。

**修正条件**：分類前の予期しない例外と、分類後の評価／返答生成失敗を分ける。対象戦略質問だと分かった後の失敗は、LLMへ流さず一般的な構造化拒否を返す。統合テストで`evaluateAvailability`または返答生成を故意にthrowさせ、LLMが呼ばれないことを証明する。

### P1-3：分類器は現在の実走例を捕まえるが、捕まえ漏れの方が現段階では有害

狭い二条件分類の方針自体には同意する。ただしPhase Aでは、誤爆すると「まだ計算できない」と正直に返すだけだが、捕まえ漏れると元の自由文LLMへ流れ、今回の嘘が再発する。したがって**現在は捕まえ漏れの方が有害**。

一方、`(今|いま)...入る`という一般表現は、ピット文脈がない発言にも誤爆し得る。コメントにある「コースに入ったら等は誤爆しない」は、正規表現上は保証されていない。

初版では次を推奨する。

- 1発言内に`pit / box / ピット / ボックス`が明示されるケースを確実に捕捉
- `ここで入ったらどこに出る？`、`ボックスしたらどの辺？`、`今入ると誰の後ろ？`等を追加
- ピット語を省略した追質問は、直前のドライバー／Luna発言にピット戦略文脈がある時だけ捕捉
- genericな`今入ったら`単独パターンは文脈なしで使わない
- 実際のSTT表記揺れをログからテストfixtureへ追加

この分類器はPhase Cで値を返すようになると誤爆の害が大きくなるため、precision / recallを実ログで計測すること。

### P1-4：`NO_PIT_LOSS_CALIBRATION`の返答が、一度のピットで次回から出せると約束している

日本語・英語とも、`一度ピットに入れば次から出せる`と断言している。しかし前回レビューで合意したとおり、1サンプルはlow confidenceであり、給油量、タイヤ、修理条件が異なれば比較できない。これは新しい「後でできる」という過剰な約束になる。

次のように、約束ではなく不足を述べる。

```text
この条件のピットロス実測が足りない。今は復帰順位を出せない。
```

### P1-5：`sessionType`を別フィールドで送っているのに`liveData.session_type`を参照している

rendererは`sessionType:lastSessionType`をトップレベルで送る。strategy guardのserver統合は`req.body.liveData.session_type`を読むため、通常は`undefined`になる。

Phase Aでは計算器なし判定が後に続くため表面化しにくいが、Practice/Qualifyで`NOT_RACE_SESSION`を返す分岐は実際には働かない。`req.body.sessionType`を正規化して使い、Race / Practice / Qualifyの統合テストを追加する。

### P2-1：生成物の`.pyc`がコミットされている

`irsdk-bridge/__pycache__/dump_all_vars.cpython-311.pyc`と`log_strategy_timeseries.cpython-311.pyc`が追跡対象になっている。環境依存の生成物であり、ソースレビューを汚し、将来のPython版差異も持ち込む。

追跡から外し、`.gitignore`で`__pycache__/`と`*.pyc`を除外する。既存の`bridge.cpython-311.pyc`も同じ扱いにする。

### P2-2：A2の実在確定に使った7/6ダンプを、今回参照できる証拠として残す

REVIEW_REQUESTは7/6ダンプで`PitSvFuel`等が存在確定済みと訂正しているが、その成果物は現リポジトリ内にない。TEAM_STATEの記述は台帳として有効でも、型・説明・単位を次工程で再確認できない。

生の334変数全量を製品リポジトリへ恒久コミットする必要はないが、戦略に必要な変数だけを抜粋した証拠ファイルへ、採取日、変数名、型、count、unit、SDK descriptionを残すこと。

---

## 確認事項への回答

### 1. 分類の狭さ

二条件方式は妥当。ただし現段階では捕まえ漏れの方が有害。明示的なピット語を持つ表現を広く捕捉し、省略表現は直近会話のピット文脈がある場合だけ捕捉する。

### 2. 構造化拒否文

`NO_CALCULATOR`は「何が無いか」を明示しており、目的を満たす。ただし無線としては三文で長い。例えば次で十分。

```text
復帰順位はまだ出せない。ピットロスの計算がまだ入ってない。
```

`NO_PIT_LOSS_CALIBRATION`は上記P1-4の約束を削除すること。

### 3. 時系列ロガーの記録項目

列の選択は概ね良い。追加・修正が必要なのは、

- 正しい共有メモリヘッダー定義
- varBuf tick
- `SessionState`
- 読取前後tick整合性
- サービス選択の判定根拠となる`PitSvFlags`のbit値
- CSVラベルのファイル名安全化

である。実走採取前に直すこと。

### 4. A2後、Phase B前の確認

A2実測により確定できるのは、主に前回着手条件の2と3。ただし、次もA2成果物から明示する。

- サービス作業が並行／直列に見えるか。分からなければ未確定のまま残す
- PitSvFuelとタイヤ選択値がいつ安定するか
- F2TimeとClassPositionがどの条件で不整合になるか
- ピット中車を復帰順位比較へどう扱うべきか
- 未取得／欠損／stale時にどの`unavailable_reason`へ落とすか

Phase B着手前には、二重計上のない総ロス定義、サンプル条件スキーマ、純粋計算モジュール境界を再度設計レビューへ出すこと。

---

## 再レビュー条件

1. strategy guardのstream / non-stream HTTP応答契約を修正
2. `/api/chat`からクライアント相当の読取まで通す統合テストを追加
3. guard対象判定後はfail-closedにする
4. `sessionType`の参照を修正
5. 時系列ロガーを実走済みreaderと同じ共有定義へ統一
6. 同一tickスナップショットを保証する
7. 1サンプルで次回から予測可能という約束を削除
8. `.pyc`を追跡対象から除外
9. 上記を検出する変異テストを提示
10. `preflight.sh`を再実行

**現状の`preflight.sh`が表示する「出荷可」は誤判定。A1は実機でJSONを喋る可能性があり、A2ロガーは共有メモリを誤読する。修正前にビルドまたはSIM PCでの採取へ進んではならない。**

---

## 2026-07-21 再レビュー結果

前回の再レビュー条件10件、およびその後の追加指摘4件は、実装差分・変異試験記録・Codex側の独立実行により合格とする。

```text
python3 irsdk-bridge/tests_irsdk_mem.py  18/18 PASS
node tests-chat-http.js                  23/23 PASS
```

確認できた改善：

- stream / non-streamのHTTP契約が分離され、生JSON発話経路が閉じた
- 対象質問識別後の評価・返答生成失敗が固定文へfail-closedする
- iRSDKの定数・FFI・readerが共通化され、fixtureも本番定数から独立した
- tick整合性、SessionState、過剰な将来約束、sessionType参照、pycache管理が修正された
- 3種の変異試験が、対応する欠陥を実際に検出する証拠が提示された

### 残る出荷ブロッカー：`/api/chat`の最終catchが元の例外を処理できない

`character`と`mode`は`try`ブロック内で`let`宣言されているが、最終`catch`から参照されている。

```js
try {
  let { ..., character, mode } = req.body;
  // ...
} catch (err) {
  console.error(`[/api/chat ERROR] char=${character}, mode=${mode}`);
}
```

JavaScriptのブロックスコープ上、外部API障害や入力処理の例外が発生すると、元の例外を返す前に`ReferenceError: character is not defined`となる。これは変異試験中だけの問題ではなく、本番の通常エラー経路にも存在する。したがって「本レビュー範囲外の別チップ」にはできない。

**修正条件**：ログでは`req.body?.character` / `req.body?.mode`を直接参照するか、両変数を`try`の外へ安全に初期化する。さらにAnthropicクライアント呼出し等を故意に失敗させ、`/api/chat`が想定したJSONエラーを返し、プロセスが生存するHTTP回帰テストを1件追加する。

この1件が通れば、今回のコードレビュー上のブロッカーは解除できる。Phase B/Cは従来どおり、A2実走データと計算器設計の再レビューまで未着手とする。

### 最終再レビュー：エラーハンドラ修正を承認

`server.js`の最終`catch`は、スコープ外変数ではなく`req.body?.character` / `req.body?.mode`を直接参照するよう修正された。追加されたHTTP回帰テストは、無効なAPIキーによる実際のAnthropic 401応答を通し、次を検証している。

- HTTPエラーが200として握り潰されない
- `application/json`で`error`フィールドが返る
- `ReferenceError`でソケットが切断されない
- 同一サーバープロセスが後続リクエストへ正常応答する

Codex側でも独立実行し、全27アサーションの合格を確認した。

```text
node tests-chat-http.js  27/27 PASS
```

修正を旧式の`character`参照へ戻す変異でプロセスクラッシュとテスト失敗が再現する記録も妥当であり、回帰テストが対象欠陥を検出できる証拠になっている。

**最終判定：承認。未コミットの現差分はコミットしてよい。A2はSIM PCでの実走採取へ進める。**
