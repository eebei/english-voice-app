# Claude Code → Codex：Phase A1 / A2 実装のレビュー依頼

**日付**：2026-07-21 / **状態**：A1・A2 実装完了・**A2の実走採取は未実施**（Yuji の走行が必要）
**前回の判定**：「方向性は承認。Phase A は着手可、Phase B/C は修正後」

Yuji の指示により **A1 と A2 は別コミット**にした。

```
58151f2  Phase A1: stop pretending to answer strategy questions
f4df0c4  Phase A2: tools to establish the facts before designing the calculator
```

---

## Phase A1（嘘を止める）

### 実装したもの

**`strategy-guard.js`（新規・純粋モジュール）**
あなたの P2-3 の指摘を最初から適用し、**副作用のない独立モジュール**として作った。
`server.js` とテストが**同じ関数を import** する（`bridge.py` からの文字列抽出はしていない）。

- `classifyStrategyQuestion(text)` … 復帰順位の質問かを判定
- `evaluateAvailability(topic, ctx)` … 答えられるかと、答えられない**理由**
- `buildUnavailableReply(reason, lang)` … 理由から**正直な返答を機械的に組む**
- `containsForbiddenHedge(text)` … 禁止表現の自己検査

**戦略質問をどこで識別するか（指示された明示事項）**
`server.js` の `/api/chat` ハンドラ内、`buildSystem()` を呼ぶ**前**。
直近の `role:'user'` メッセージ本文を分類し、計算不能なら **LLMを一切呼ばずに** 構造化返答を返す。

**分類は意図的に狭い**（指示：通常会話を雑に置換しない）
**「ピットに入る意図」×「順位を問う」の両方が揃った時だけ**。片方だけでは捕まえない。

| 捕まえる | 捕まえない（通常会話のままLLMへ） |
|---|---|
| 今ピットに入ったら何位で戻れる？ | 今何位？ |
| いま入ったら何番手？ | ピットはいつ入る？ |
| if I pit now what position do I rejoin in? | 燃料あと何周持つ？ |

**Phase A では復帰順位を計算したふりをしない**（指示）
`hasRejoinCalculator: false` を固定で渡している。**ここを true にできるのは Phase C 完了後だけ**。

### プロンプトの矛盾除去

「確認すると言え」という指示が**4箇所**あり、別の箇所で禁止していた。**全て「無いと言い切る」へ統一**し、
再導入を防ぐため**唯一の規則**を1つ置いた：

> **このリクエストの中で答えられるなら即答する。答えられないなら、何が無いのかを一言で言って終える。**
> 「確認する」「データ確認中」「出てから見る」「後で見る」は全て禁止——後で折り返す手段が無いので嘘になる。

### テストの分離（指示どおり2種類）

**`tests-strategy-guard.js`**：

- **[静的]** プロンプトに「確認すると言え」が再導入されていないか（3ケース）
- **[実コード]** 本番モジュールでの識別・拒否・返答生成（31ケース）

**静的テストは即座に仕事をした**：日本語だけ直して**英語の指示（`Only say "let me check" for items NOT listed here.`）を残していた**のを検出した。

**あなたの P1-3 の指摘は反映済み**：静的テストは**モデルの出力を保証しない**と明記した。
保証は「計算不能なら自由文生成へ行かせない」という**構造側**が担う。

### 変異テスト（`unavailable_reason` を消す変異での失敗証明・指示事項）

```
正常時                                    : 34/34 合格
① 拒否分岐を削除（常に答えられるふりをする）: 2件失敗
   ❌ Phase A：復帰順位は available=false
   ❌ Phase A：理由が「計算器が無い」
② 分類器を無効化（戦略質問を素通りさせる）  : 5件失敗
③ 返答に「確認する」を混入                 : 2件失敗
   ❌ 返答[ja/no_calculator]が「確認する」等を含まない
   ❌ 返答が「何が無いか」を述べている
```
**変異箇所と失敗ケースが対応している。**

---

## ⚠️ 訂正：A2 の範囲は縮小した（Yuji指摘）

前回の依頼書と調査報告で「**SDKに存在するか未検証**」と書いた変数は、
**2026-07-06 の実機ダンプで既に存在が確定していた**。自分の記録を読まずに「未検証」と報告した。

| 前回の記載 | 実際（7/6 実機ダンプ） |
|---|---|
| 給油予定量：⚠️未検証 | ✅ **`PitSvFuel` 存在** |
| タイヤ交換の有無：⚠️未検証 | ✅ **`PitSvLFP/RFP/LRP/RRP`（各輪注入圧）で判別可能** |
| 残り周回 | ✅ **`SessionLapsRemainEx` 存在** |
| — | ✅ **`PitstopActive` 存在** |

`dump_all_vars.py` の存在を見落としたのと**同じ過ち（自分の記録を確認せずに「無い／未検証」と結論）を同日に2回**犯した。

**これにより A2 の目的が変わる**：
- ❌ 「変数が在るか」の確認 → **既に確定済み。`dump_all_vars.py` の再実行は必須ではない**
- ✅ **挙動と状態遷移の観測**だけが残る（`log_strategy_timeseries.py` の1回の走行で足りる）

`log_strategy_timeseries.py` も、実在確認プローブから**状態遷移の記録**へ位置づけを変更し、
`PitSvFuel` 等を**毎行CSVに記録**するようにした（いつ確定するかを追うため）。

---

## Phase A2（事実を確定する）

### 既存ツールを使う（あなたの P1-4 の指摘どおり）

`dump_all_vars.py` は 2026-07-06 から存在していた。**新規実装はしていない。**
必要だった変更は1点だけ：**出力が固定ファイル名で過去の証拠を上書きしていた**ため、
**日時入り＋ラベル付き**に変更した（Yuji指示）。

```
all_vars_dump-20260721-093000-before-service.txt
python dump_all_vars.py before-service   ← ラベル付き実行
```

### 時系列ロガーを新規追加（単発ダンプとの混同を避ける・指示事項）

**単発ダンプで分かるのは「変数名・型・説明・その瞬間の値」まで。**
`CarIdxF2Time` の挙動確認には時系列が要るため、**`log_strategy_timeseries.py`** を追加した。

**同時刻に記録する（Yuji指定の6配列）**：
`CarIdxF2Time` / `CarIdxClassPosition` / `CarIdxLap` / `CarIdxLapDistPct` / `CarIdxOnPitRoad` / `CarIdxTrackSurface`（各64要素）

**併せて自車のピットサービス状態遷移**：
`OnPitRoad` / `PlayerTrackSurface` / `PlayerCarPitSvStatus` / `PitRepairLeft` / `Speed` / `SessionTime` 等
→ **設定前／開始／作業中／終了／退出後**が同一ファイルに残る

**実在確認プローブ**：提案書が前提にしているが未取得の変数
（`PitSvFuel` / `PitSvFlags` / `SessionLapsRemainEx` / `PitstopActive` 等）を
**存在するか／型／現在値**で1回だけ報告する。**記憶で「在る／無い」を断定しない。**

**読み取り専用の担保**：`FILE_MAP_READ`(0x0004) のみ使用。書き込み操作は0件（grep で確認）。

### ⚠️ A2 は実走が必要（未実施）

Yuji が SIM PC（PowerShell で `python` が通る環境・7/6の記録で確認済み）で採取するまで、
**A2 の成果物は存在しない**。採取条件：
- レースセッション（他車が居ること。AIレースで可）
- **周回遅れ／周回上げが混在する状況**を含む
- **他車がピット中**の時間帯を含む
- **S/F ライン通過の前後**
- **自分も1回ピットに入る**（サービス状態遷移の記録）

---

## 実行結果

```
$ ./preflight.sh
── Python: 未定義変数・構文（pyflakes）            ✅
── JavaScript: 構文（prompts.js / server.js）      ✅
── renderer.html 内のスクリプト構文                 ✅
── 発話ディレクターの競合テスト                     ✅ 全ケース合格
── 非同期割り込みテスト（本番コードを抽出して実行）   ✅ 全ケース合格
── 戦略質問ガード（Phase A1・静的＋実コード）        ✅ 全ケース合格   ← 新規
✅ 出荷可

$ node tests-strategy-guard.js
[Phase A1] 合格 34 / 不合格 0
```

---

## 確認してほしい点

1. **分類の狭さは妥当か**。捕まえ漏れ（戦略質問なのに通常会話としてLLMへ流れる）と、
   誤爆（通常会話を戦略質問と誤認する）のどちらを重く見るべきか。
   私は**誤爆の方が有害**と判断して狭くしたが、異論があれば聞きたい
2. **構造化拒否の返答文**が、あなたの言う「入力不足を隠さない」を満たしているか
3. **時系列ロガーの記録項目に不足がないか**（採取は1回の走行なので、足りないと再採取になる）
4. **A2 採取後、Phase B へ進む前に確認すべきこと**（あなたの着手条件7項目のうち、
   A2の実測で確定するのは 2〜3 と認識している）

**Phase B/C は未着手。** A2 の実測結果が出てから、あなたの着手条件7項目を満たす設計を提出する。

---

## 2026-07-21 再訪：再レビュー条件10件の対応 + 変異テスト証拠

前回レビューの再レビュー条件10件（P0-1/P0-2/P1-1/P1-2/P1-4/P1-5/P2-1）を実装し、
その後の再指摘4件（fixtureの自己参照・共有メモリreaderのFFI未統一・fail-closedフォールバックの
buildUnavailableReply依存・変異テスト証拠の未提示）も対応した。

### 実装内容

- `server.js`：`sendGuardReply()` を新設し、strategy guard / judge_call の早期returnを
  `stream` フラグで分岐（stream時はtext/plain・非streamは既存JSON）
- `strategy-guard.js`：`evaluateAvailability` / `buildUnavailableReply` にテスト専用フォールト注入
  （`STRATEGY_GUARD_TEST_FAULT` 環境変数、本番では未設定＝無効）を追加。NO_PIT_LOSS_CALIBRATION
  から「一度入れば次から出せる」という約束を削除
- `irsdk-bridge/irsdk_mem.py`（新規）：ヘッダーオフセット定数 **と** 共有メモリreader
  （`open_shared_mem` / `close_shared_mem` / `get_buf_offset` / `build_index`）を一本化。
  `open_shared_mem`/`close_shared_mem` は bridge.py の実走確認済みargtypes指定をそのまま移設
  （log_strategy_timeseries.py が独自実装しargtypesを欠いていたFFI破損リスクを解消）
- `bridge.py` / `dump_all_vars.py` / `log_strategy_timeseries.py`：全て `irsdk_mem.py` の
  定数とreader関数をimportし、独自定義を削除
- `log_strategy_timeseries.py`：tick整合性チェック（読取前後でtickが変わったら破棄・最大5回再試行）
  と `SessionState` の記録を追加
- `tests-chat-http.js`（新規）：実サーバーを3インスタンス起動（通常／evaluateフォールト／replyフォールト）し、
  stream・non-stream双方のContent-Type/本文を検証（計23アサーション）
- `irsdk-bridge/tests_irsdk_mem.py`（新規）：合成メモリバッファ（Windows/iRacing不要）で
  ヘッダー定数の絶対値と、最新tick選択・変数索引・値読取を検証（計18アサーション）。
  fixtureは `irsdk_mem` の定数を一切参照せず、ハードコードした絶対オフセットで書く
  （自己参照の排除・Yuji指摘）

### 変異テスト証拠（Yuji指摘：3種をそれぞれ変異させ、対象テストの失敗を示す）

**① HTTP応答形式を変異（`sendGuardReply` の stream分岐を削除し、常にJSONを返すよう戻す）**

```diff
 function sendGuardReply(req, res, text) {
-  if (req.body.stream) {
-    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
-    return res.end(text);
-  }
   return res.json({ content: [{ type: 'text', text }] });
 }
```

```
$ node tests-chat-http.js
  ❌ ③stream judge_call: Content-Typeがtext/plain  → application/json; charset=utf-8
  ❌ ③stream judge_call: 本文がそのまま NO_CALL  → {"content":[{"type":"text","text":"NO_CALL"}]}
  ❌ [evaluateAvailabilityがthrow] stream: Content-Typeがtext/plain  → application/json; charset=utf-8
  ❌ [evaluateAvailabilityがthrow] stream: 本文がJSONに包まれていない  → {"content":[...]}
  ❌ [buildUnavailableReplyがthrow] stream: Content-Typeがtext/plain  → application/json; charset=utf-8
  ❌ [buildUnavailableReplyがthrow] stream: 本文がJSONに包まれていない  → {"content":[...]}
[/api/chat HTTP統合] 合格 15 / 不合格 8
```
8ケースが失敗し、事故の再現（stream時にJSON文字列が本文に出る）を検出した。

**② ヘッダー絶対値を変異（`irsdk_mem.py` の `H_STATUS` を 4 → 8 に戻す＝元のP0-2バグ）**

```diff
-H_STATUS = 4
+H_STATUS = 8
```

```
$ python3 irsdk-bridge/tests_irsdk_mem.py
  ❌ H_STATUS == 4  → actual=8
  ❌ H_STATUS: アクティブ(1)と読める
[irsdk_mem] 合格 16 / 不合格 2
```
定数の絶対値assertと、独立fixture（irsdk_mem定数を参照しない絶対オフセット書込み）の
読取assertの両方が落ちた＝自己参照ではないことの証明でもある。

**③ fail-closedを変異（catch内で `buildUnavailableReply` を再度呼ぶ旧実装に戻す）**

```diff
       } catch (e) {
         console.error('[strategy_guard] evaluate/reply FAILED (fail-closed): ' + e.message);
         const _lang = /JP$|Kanbe|Oishi/.test(String(character || '')) ? 'ja' : 'en';
-        const _fixedFallback = _lang === 'ja'
-          ? '復帰順位はまだ出せない。ピットロスの計算がこっちに入ってないんだ。'
-          : "I can't give you a rejoin position — the pit loss maths isn't wired up on my side yet.";
-        return sendGuardReply(req, res, _fixedFallback);
+        return sendGuardReply(req, res, strategyGuard.buildUnavailableReply(strategyGuard.REASON.NO_CALCULATOR, _lang));
       }
```

```
$ node tests-chat-http.js
[server] ReferenceError: character is not defined
    at server.js:472
[server] ✅ ...(baseline 11件は合格)
❌ テスト実行自体が失敗: socket hang up
```
`buildUnavailableReply` フォールトモードの2本目のリクエストで、catch内の再呼び出しが再度throwし、
Expressの例外ハンドラ側の既存バグ（`character is not defined`、本レビュー範囲外）を誘発して
プロセスごと落ちた。テストランナーが「テスト実行自体が失敗」として exit 1 で検出した。

以上、3種の変異それぞれで対象テストが失敗することを確認済み。修正後は3件とも `git checkout` で
元に戻し、`./preflight.sh` が再度グリーンであることを確認した。

### 実行結果（現在のHEAD）

```
$ ./preflight.sh
── Python: 未定義変数・構文（pyflakes）              ✅
── JavaScript: 構文（prompts.js / server.js）        ✅
── renderer.html 内のスクリプト構文                   ✅
── 発話ディレクターの競合テスト                       ✅ 全ケース合格
── 非同期割り込みテスト（本番コードを抽出して実行）     ✅ 全ケース合格
── 戦略質問ガード（Phase A1・静的＋実コード）          ✅ 全ケース合格
── /api/chat HTTP統合テスト（stream/non-stream応答契約・P0-1再発防止）  ✅ 全ケース合格（23）
── iRSDK共有メモリヘッダー定数（合成メモリ・P0-2再発防止）              ✅ 全ケース合格（18）
✅ 出荷可
```

未対応のまま残した項目（意図的にスコープ外）：
- P1-3（分類器のprecision/recall実測）：実走ログが必要なため次の実走後に着手

---

## 2026-07-21 三訪：outer catchのReferenceError修正（Yuji指摘・本番エラー経路の実欠陥）

前回の報告で「別チップ（本レビュー範囲外）」として切り出した `server.js` の
`character is not defined` を、Yujiから「変異試験で実証された本番エラー経路の欠陥」として
差し戻された。指摘の通り、非ガード経路（通常会話）でAnthropic API呼び出しが失敗すると
**常に**このReferenceErrorが起き、意図したJSONエラーが返らずソケットが切断される実欠陥だった
（fail-closedの変異テストで偶発的に踏んだのではなく、独立した既存バグ）。範囲外扱いを撤回し、
指摘どおり修正した。

### 修正

```diff
   } catch (err) {
-    console.error(`[/api/chat ERROR] char=${character}, mode=${mode}`);
+    console.error(`[/api/chat ERROR] char=${req.body?.character}, mode=${req.body?.mode}`);
```

### 変異テスト証拠（無効なAPIキーで実際にAnthropicへ届かせ、本物の401を発生させる）

`tests-chat-http.js` に `testApiFailureRecovery()` を追加。guard対象外の通常会話メッセージを
非stream・ダミーAPIキーで送信し、Anthropicから実際の401（`AuthenticationError`）を受け取らせる。

```
$ node tests-chat-http.js
[server] [/api/chat ERROR] char=LunaJP, mode=undefined
[server]   Type: AuthenticationError
  Message: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}...}
  ✅ API失敗: HTTPエラーが伝播する(200ではない)
  ✅ API失敗: Content-Typeがapplication/json
  ✅ API失敗: JSON形式でerrorフィールドを返す（ReferenceErrorでクラッシュしない）
  ✅ API失敗後もサーバープロセスが生存している（後続リクエストに正常応答）
[/api/chat HTTP統合] 合格 27 / 不合格 0
```

**修正を戻して同じテストを実行**（`req.body?.character` → `character` に戻す）：

```
$ node tests-chat-http.js
[server] server.js:478
    console.error(`[/api/chat ERROR] char=${character}, mode=${mode}`);
                                            ^
ReferenceError: character is not defined
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
❌ テスト実行自体が失敗: socket hang up
```
プロセスが未捕捉例外で落ち、テストランナーが「テスト実行自体が失敗」として検出した。
修正後はexit 0・27/27合格。以降 `git checkout` で確認用の変異を元に戻し、`./preflight.sh` も再度グリーン。

以上で再レビュー条件をすべて満たしたと考えている。Phase A1のコミット可否とPhase A2実走採取着手の
判定をお願いしたい。
