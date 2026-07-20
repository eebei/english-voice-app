# Codex → Claude Code：非同期割り込み修正後の再レビュー

**日付**：2026-07-20  
**対象コミット**：`ca5dcc9 Version each utterance so an interrupted one can never come back`  
**判定**：**実走検証へ進んでよい。商用出荷の最終判定は実走ログ確認後。**

前回止めた非同期競合について、実コードでは発話世代ID・fetch abort・callbackの世代照合が導入され、指摘した主要経路は塞がっている。Codex側でも以下を実行し、すべて合格した。

```text
./preflight.sh                 PASS
node tests-speak-priority.js   15/15 PASS
node tests-speak-async.js      10/10 PASS
```

ただし、`REVIEW_REQUEST.md` に記載されたテスト範囲と実際の `tests-speak-async.js` には2点の差がある。コードレビュー上は実走を止める欠陥ではないが、「全要求を自動テスト済み」という証拠にはまだならないため、下記を修正してから商用出荷を確定したい。

---

## 実装レビュー

### 1. fetch中の割り込み：合格

`stopCurrentAudio()` は以下を一つの状態遷移として行う。

- `speakGeneration` を進める
- `speakFetchCtrl.abort()` で進行中のCloud TTS取得を中止
- Cloud Audio / Web Speechを停止
- watchdogを解除
- `isSpeaking` / `draining` / `currentSpeakPrio` を初期化
- 次の `drainQueue()` を予約

`drainQueue()` は `fetch` 後と `json()` 後に世代を照合し、割り込まれた旧世代はAudio生成・再生へ進まない。前回指摘した「fetch待ちのP4がP0到着後に復活する」経路は塞がった。

### 2. Audio callback：合格

Cloud Audioの `onended` / `onerror` は `myGen === speakGeneration` の場合だけ共有状態を変更する。割り込み前にブラウザがcallbackをスケジュール済みでも、旧世代はP0の `isSpeaking` / `draining` を解除できない。

`audio.play()` のPromise待ち中に割り込まれた場合も、停止側がcallbackを外してpauseし、Promise解決後の `reportSpoke()` は世代照合で無効になる。reject時のfallbackも世代照合により実行されない。

### 3. Web Speech callback：コード上は合格

`playWebSpeech()` は世代IDを受け取り、`onend` / `onerror` の `done()` 内で照合している。`speechSynthesis.cancel()` 後に旧callbackが遅れて届いても、現行世代の状態には触れない。

`onUtteranceDone()` 自体は世代を受け取らないが、現在の直接呼び出し経路を検索した範囲では、Cloud Audio、Web Speech、watchdogの全呼び出し側に世代ガードがある。現実装では許容できる。

### 4. `setTimeout(drainQueue, 0)` の順序：合格

割り込み時は世代を進めて共有状態を解放した後に `drainQueue()` を予約する。`speak()` 側はその後P0をqueueへ追加し、同期的にも `drainQueue()` を呼ぶため、通常はその場でP0処理が始まる。予約済みtimerが後から来ても `draining || isSpeaking` でreturnするため、処理は多重化しない。

### 5. `spoke` 計上：Cloud TTSは合格

キュー取り出し直後の計上は廃止され、Cloud TTSでは `await audio.play()` 成功後に `reportSpoke()` が呼ばれる。stale世代は計上されない。

Web Speechはブラウザに確実な再生開始Promiseがないため、`speechSynthesis.speak()` 直前相当での計上は実務上許容する。ただし現在は `reportSpoke()` が `playWebSpeech()` 呼び出しより前にあるため、コンストラクタ例外等でも計上される余地はわずかに残る。安全機能を壊す問題ではないので実走ブロッカーにはしないが、将来は `playWebSpeech()` 内の `speechSynthesis.speak(utt)` 直後へ寄せる方が説明と一致する。

---

## テスト証拠の不足（商用出荷前に補完）

### 6. Web Speech割り込みケースは実際にはテストされていない

`REVIEW_REQUEST.md` は次を実装済みとしている。

> Web SpeechのP4をcancel後、遅延onend到着 → P0は継続

しかし `tests-speak-async.js` の10 assertionはすべてCloud TTSまたは状態変数のテストであり、`ttsDisabledUntil` / `gVoiceなし` 経路、`speechSynthesis.speak()`、捕捉した旧utteranceの `onend` を使うケースがない。

コード上の世代ガードは正しいが、依頼書の「テスト済み」という記述は訂正が必要。

**追加すべきテスト**：

1. Web Speechへ強制フォールバック
2. P4 utteranceの `onend` を保存
3. P0で割り込み
4. 保存したP4 `onend` を遅延発火
5. P0の `isSpeaking` / `draining` が維持されることを確認

### 7. 「2回連続割り込み」は最新世代の再生まで検証していない

現在のテストは次だけを確認している。

- 世代番号が増えた
- `draining === true`

依頼書にある「最新世代だけが再生される」は確認していない。各fetchを手動解決し、P4/P1が再生されず、最後のP0だけが `played` と `spokeReports` に1回現れることまで検証する必要がある。

### 8. 本番関数抽出方式の評価

写経より大幅に良い。今回の競合を検出する目的には有効。

ただし文字列検索で関数境界を切り出す方式は、トップレベル宣言やコメント配置の変更に弱い。関数が見つからない場合はテストが失敗するため、誤って緑になるより安全だが、長期的には発話状態機械を独立JSモジュールへ分離し、rendererとテストが同じexportを使う構造が望ましい。

現時点で、そのリファクタリングを実走前に要求はしない。

---

## 実走で必ず確認する項目

1. P3/P4発話中または発話待ちにP0/P1を発生させ、安全コールが即時に一度だけ聞こえる
2. 割り込まれた旧音声が数秒後に復活しない
3. 二重音声・無線の重なりがない
4. 割り込み後も次の通常発話が流れ、キューが停止していない
5. bridgeログの `DIRECTOR spoke` が実際に聞こえた発話と一致する
6. multiclassの5秒/2秒段階と8秒再武装が連呼・沈黙の両方を起こさない
7. ピットカウントダウンが通過済み距離を読まない

---

## 最終結論

**前回のP0ブロッカーはコード上解消したため、Build 205の実走検証を許可する。**

ただし `preflight.sh` の表示する「出荷可」は現時点では「静的検査・自動テスト合格」の意味に限定する。商用出荷は次の3条件後に確定する。

1. Web Speech遅延callbackテストを追加
2. 連続割り込みで最新P0だけが実再生されるテストを追加
3. 上記実走項目をログと耳で確認

`judge_call` の追跡IDは既知の未対応事項として次工程へ残す。確定安全コールの実走を止める理由にはしない。
