# Build 266 — #6 / #7 / 八木さん5項目 再レビュー

作成: 2026-08-12 / Codex  
対象: `BUILD266_PHASE_E_COMPLETION_EVIDENCE_V2.md`  
正本: `PITWALL_INTERNAL_SIMULATION_TEST_POLICY.md`

## 判定

**差戻し。Build候補にはまだしない。**  
Bridge poll-loop再生、八木さん回帰、燃料権威の限定テストはCodex側でも通過した。しかし、#7の原価ゲートは実発話経路の会計として未成立であり、正本の必須条件を満たしていない。

Codexが再実行したもの:

- `node tests-cost-gate.js` — 35/35
- `node tests-fuel-authority.js` — 26/26
- `node tests-yagi-log-regressions.js` — 39/39
- `python3 irsdk-bridge/tests_bridge_poll_replay.py` — 19 tests OK

ただし、上の緑は下記欠陥を検出していない。

## P0 — 原価ゲートが実経路を正しく会計していない

### P0-1: 生成と再生が同一replyとして結び付かず、無駄生成を検出できない

- `desktop/renderer.html:2188` は `generated` を **idなし**で記録し、しかも `/api/chat` の応答前に記録している。
- `desktop/renderer.html:2512` / `:2563` は後段で別の `costReplyId()` を作り、`queued` / `played` / `discarded` をその別IDへ記録する。
- `desktop/cost-meter.js` は `id` があるイベントだけ `replies` Mapへ入れるため、実会話の `generated → queued → played / discarded` の帰結を追跡できない。

結果として、実走では「生成済みだが未再生」の原価が `wasted_generation` に上がらない。これは正本 §5/§6に反する。

**修正条件**

1. chat requestごとに一つのstable reply idを生成する。
2. `generated` は応答本文が得られた時点で、そのidと実usageを伴って一度だけ記録する（要求前ではない）。
3. ストリームを文に分割する場合は、親reply idとchunk idを関連付け、親replyのfateを「少なくとも一度played」またはexpired/discardedへ確定する。
4. operational follow-upも同じ契約にする。
5. 「生成→後送り→期限切れ」「生成→キュー溢れ」「生成→再生」の実renderer経路を、stubbed fetch/audioで実行して検証する。文字列走査だけでは不可。

### P0-2: STTと複数のchat発話経路が計装外

実在する外部経路に `costApiCall` が無い。

- `desktop/renderer.html:5748` の `/api/stt` は、Google STT外部呼出・秒数・retryを一切記録しない。
- `:3715` pace check、`:3833` judge call、`:3916` auto briefing、ほか `/api/chat` 経路はAnthropic呼出／生成を記録しない。
- `tests-cost-gate.js` はmoduleの模擬カウンタと文字列存在を確認しているだけで、これらの実経路を通していない。

「rendererの16箇所」は、全ての外部原価経路を覆う根拠になっていない。外部APIゼロの通常テストという合否は良いが、**本番経路を漏れなく計装する**条件が未達である。

**修正条件**

1. 全 `/api/chat`、`/api/tts`、`/api/stt` 呼出を一箇所の計装wrapperへ集約するか、全siteを計上する。
2. STTはattemptごとの外部呼出、実測 `audioDurationSeconds`、retry、成功／失敗を記録する。
3. fetch/audioをstubしたrenderer integration testで、chat・TTS・STT・自動無線の全経路について external=0 / simulated値 / generated-fate を検証する。
4. そのテストはネットワーク不可にし、実外部APIを検出したらfailする。

## P1 — 非Race燃料ハンドラのテスト主張は例外fallbackを覆えていない

`server.js:995-1001` に `mode === 'race'` のない `_directPitCommand` fallbackが残っている。通常はtry内のRace gateが先にreturnするが、tryの後半で例外が起きた場合、Practice/Debriefでも `この周でボックス` 等へ決定論replyを返し得る。

`tests-fuel-authority.js` は `isFuelQuestion` だけを静的に見ており、このfallbackを検出できない。「非raceで通すのはsetup相談だけ」の契約と一致させること。

## P1 — Yuji決定の短文化が未反映

`engineer-card.js:692-694` に、Yujiが廃止した長文がそのまま残る:

`今は確定のコールを出さない。次のS/F通過で燃料、残り、前後GAPを更新する。`

Yuji確定の標準固定返答を、次へ統一する:

`今、ここでは伝えられない。`

この返答の同一ターンでは、燃料・GAP・S/F・根拠・次回更新予定を追加しない。英語版も同じ秘密保持調の一文とし、無線／会話双方の回帰テストを追加する。

## P1 — 再生テストのResourceWarning

`tests_bridge_poll_replay.py:75` が `open(...).read()` の未close warningを出す。検証の結果はpassだが、テストを `with open(...)` へ直し、warningなしを確認すること。

## 承認済み／実走確認へ残す範囲

- #6の `poll_iracing()` 再生という方向は正しい。上記P1 warningを除く限定テストは通過。
- 八木さん5項目の限定回帰は通過。音声の自然さ・実SDK・相談の有用性・3秒dwell・Plan B/Cの実レース時機は、証拠文書どおり実走確認が必要。
- Plan A/B/Cの定義は先行の決定どおり。Plan BはFuel Window成立後、相対ペース優位とclear rejoinが揃う条件付きUndercutである。

commit / push / build / 公開はしない。
