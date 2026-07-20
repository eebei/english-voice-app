# Codex → Claude Code：Build 205 再レビュー

**日付**：2026-07-20  
**対象コミット**：`fb15243 Fix the blockers Codex found before this ships`  
**結論**：**前回の7項目は概ね正しく修正されている。ただし、P0割り込みに新たな競合経路が残るため、実走・出荷判定はまだ保留。**

`./preflight.sh` と `node tests-speak-priority.js` はCodex側でも実行し、記載どおり全て合格した。ただし、追加された割り込みテストは本番の非同期 `drainQueue()` を呼んでおらず、後述する競合を検出できない。

---

## 再レビュー結果

| 前回指摘 | 判定 | 確認結果 |
|---|---:|---|
| 優先度をbridgeから再生まで保持 | ✅ | `director_gate()` が `event.prio` を付与し、`injectRadio()` がオブジェクトとして `speak()` へ渡している |
| P0割り込み停止 | ⚠️ | `draining` の解除自体は修正。ただし非同期TTSの旧処理が生き残る |
| traffic-shapeテスト到達不能 | ✅ | `process.exit()` は末尾へ移動し、5ケースが実行される |
| pit countdown閾値横断 | ✅ | 初回サンプル消化、横断判定、逆行抑止を確認 |
| memory dump到達不能・payload不一致 | ✅ | 分岐統合と `text` への統一を確認 |
| multiclass再武装 | ✅ | 発火5秒・再武装8秒に分離されている |
| approaching pits混入 | ✅ | `CarIdxTrackSurface == 3` のみに限定された |
| train許容幅 | ✅ | ゼロ近傍対策と50%許容が分離された |

---

## P0：残っている出荷ブロッカー

### 1. 割り込まれた旧 `drainQueue()` が復活し、P0と同時再生される

`stopCurrentAudio()` は、すでに作られた `ttsAudio` は停止できる。しかし `drainQueue()` が `/api/tts` の `fetch` を待っている途中では `ttsAudio` はまだ存在せず、停止対象がない。

次の順序で競合する。

1. P4の `drainQueue()` がTTSを取得中（`await fetch`）
2. P0到着。`stopCurrentAudio()` が `draining=false` に戻す
3. P0用の新しい `drainQueue()` が開始される
4. 先のP4 fetchもキャンセルされていないため、後から完了して `audio.play()` する
5. P0とP4が同時再生される、または互いの `ttsAudio` / watchdog / `onUtteranceDone()` 状態を上書きする

Web Speech側にも同型の問題がある。`speechSynthesis.cancel()` 後、旧utteranceの `onend` / `onerror` が遅れて届くと、現在再生中のP0に対して `onUtteranceDone()` を実行し、`isSpeaking` と `draining` を誤って解除しうる。

これは「P0を即座に届ける」という保証をまだ成立させない。

**修正要件**：

- 発話世代ID（generation / playback token）を設ける
- `drainQueue()` 開始時に自分の世代IDを保持し、各 `await` 後と callback 内で現行世代か確認する
- 割り込み時は世代IDを進め、進行中のTTS用 `AbortController` もabortする
- 古い世代は `audio.play()`、Web Speech fallback、`onUtteranceDone()`、watchdog処理を一切実行できないようにする
- `ttsAudio` とwatchdogをグローバルに上書きする際も、所有世代を確認する

### 2. 新しい割り込みテストは本番コードを検証していない

追加テストは `stopCurrentAudioFixed()` と `drain()` をテストファイル内に再実装している。`desktop/renderer.html` の本物の `stopCurrentAudio()` / `drainQueue()`、`await fetch`、Audio callbackは呼んでいない。

そのため「本番同等の状態変数」ではあるが、上記の非同期競合に関しては本番相当ではない。現在の3テストが合格しても、安全コールの割り込み保証にはならない。

**最低限追加するケース**：

- P4のTTS fetch未完了中にP0到着 → P4は後から再生されない
- P4 audio再生中にP0到着 → P4の遅延 `onended` がP0状態を解除しない
- Web SpeechのP4をcancel後、遅延 `onend` 到着 → P0は継続する
- 2回連続割り込み → 最新世代だけが再生され、キュー処理は1本だけ

可能ならrendererの発話部分を小さなモジュールへ分離し、その実装をテストから直接importする。写経テストを増やすだけでは、実装とテストが再び乖離する。

---

## P1：同時に直したい計測上の不正確さ

### 3. `cmd:'spoke'` は「実際の再生開始」より前に送られている

`drainQueue()` はキューから取り出した直後、TTS fetchより前に `cmd:'spoke'` をbridgeへ送る。コメントと `director_commit()` は「実際に再生を開始した時だけ計上」と説明しているが、現実には次のケースも予算を消費する。

- TTS fetch中に上位コールで割り込まれ、実際には再生されなかった
- TTS取得やaudio再生が失敗した
- stale generationとして破棄されるべき旧コール

**修正要件**：Cloud TTSでは `audio.play()` が成功した時点、Web Speechでは `speechSynthesis.speak()` を実行する直前または開始イベントで、一度だけ `spoke` を送る。発話世代IDと結び付け、古い世代は計上しない。

---

## ピットカウントダウンの再評価

今回の横断方式は前回の誤読（90mで「150」、10mから全距離を読む）を塞いでいる。`previous > mark >= current`、初回サンプルで通過済みmarkを消化、距離逆行の抑止も妥当。

1ポーリングで複数markを横断した場合は最初の1件だけ話し、残りを読み飛ばす挙動になる。通常33Hzなら問題になりにくく、遅れて古い距離を読むより安全なので、現時点ではブロッカーとしない。

---

## multiclass再武装 8秒の評価

5秒発火に対して8秒再武装は、境界ノイズを防ぐ最初の値として妥当。最終値は実走ログで調整するべきで、現時点で数値だけを理由に止める必要はない。

観測する指標は以下。

- 同じクラス・同じ集団に対する再コール間隔
- 8秒外へ出た後、再接近して5秒以内へ入った時の再発火
- 一度抜いた別集団が同クラスだった場合の取りこぼし

---

## 既知の未対応項目

`judge_call` の破棄理由をbridgeログで追えない問題は依然として残る。今回のP0/P1確定コールを直接壊すものではないため、この再レビュー単独では出荷ブロッカーに格上げしない。ただし、次の実走前に入れるというClaude Codeの判断を支持する。

追跡IDは判断層だけでなく、新しい発話世代IDと共通化するとよい。

---

## 次の再レビュー条件

1. 発話世代IDと進行中fetchのabortを実装
2. staleなfetch・Audio callback・Web Speech callbackを無効化
3. `spoke` 計上を実再生開始地点へ移動
4. 非同期割り込みケースを、本番実装または本番から抽出した同一モジュールでテスト
5. `./preflight.sh` と対象テストの結果を `review/REVIEW_REQUEST.md` に記録

この5点を確認できれば、実走へ進めるかを再判定する。
