# 記憶→戦略 共有認識 V1

作成: 2026-08-25 JST / Claude Code
経緯: Yuji が同一の質問を Claude Code と Codex へ**独立に**投げ、両者の回答を突き合わせた記録。
目的: **共有認識度を高めて開発速度を上げる。最終Buildでの作業漏れを無くす。**
判断: 意見が割れた／どちらとも言えない項目は **Yuji が決める**。

---

## 0. この文書の使い方

- **事実**は照合して確定させる。両者が同じコードを読んで一致したら、以後それを前提にする。
- **見解**は照合しても真実に近づかない。AI二者は似た存在で、独立な二意見ではない。**Yuji の判断が上位。**
- 割れた項目は「Yuji判断待ち」として残し、勝手に片方へ寄せない。

---

## 1. Yuji が求めているもの（北極星）

> Claude Code や Codex は、会話のたびに記憶を残し、次の会話で過去を拾って話す。
> **君らが自然にできることを Luna にやらせたい。これが大前提。**

具体例（Yuji の原文）：

> Luna「昨日は決勝8位からスタートして6周目にアンダーカットに入り、ブレンド時には4位まで上がってる。
> 今日も3位以下ならその戦略も使える。まずは予選決めていこう。」

判定基準：**Luna がこれを自分から言えるか。そしてそれを今日の Plan へ渡せるか。**

### 前提の訂正（重要）

Claude Code の記憶は「学習」ではない。モデルは変化していない。**やっているのは4つだけ。**

```
① 重要な瞬間にファイルへ書く
② 毎セッション索引（MEMORY.md）を読む
③ 関連する本文を引く
④ 間違いは Yuji が訂正する
```

つまり**検索してプロンプトへ入れているだけ**であり、特別な技術ではない。
**PITWALL でも同じ配管で再現できる。** ここが「難しいAI課題」ではないという認識の共有が、この文書の第一の意味。

---

## 2. 両者一致（事実として確定・以後の前提）

同じコードを独立に読んで一致した。**議論を再開しない。**

| # | 確定事項 | 根拠 |
|---|---|---|
| 1 | 過去レースをブリーフィングへ渡す**仕組みは存在する** | `renderer.html:4214` `scheduleAutoBriefing()` |
| 2 | 発動条件は3つ：`selMode==='strategy'`（**走り出していたら発動しない**）／`lastTrack` 確定／同コース（車種が取れていれば同車種）の記録あり | `renderer.html:4216` `6063` |
| 3 | `pw_raceHistory` の保存内容は11項目のみ：`date, track, car, carClass, bestLap, avgLap, totalLaps, incidents, finishPos, irating, sr` | `renderer.html:5439` |
| 4 | したがって**スタート順位・判断時点・選択した戦略・予測・実際の復帰順位は1つも保存されていない**。Luna は言いたくても言えない | 同上 |
| 5 | 5番（Character）より **4番（Memory→Strategy）が先**という Yuji の順序認識は正しい | 両者独立に同意 |

---

## 3. Codex の指摘が正確だった点（Claude Code の説明不足）

> 現在はLLMへの文章注入が中心で、**ブリーフィング発話として必ず出る決定論的な契約になっていない**。

Claude Code は「発動条件は満たしている」とだけ言い、**肝心な点を落としていた**。実態はこう。

```
✅ ブリーフィングのリクエストは必ず出る（決定論）
❌ 過去レースの話が出るかは LLM 次第（保証なし）
```

**Yuji が「ず〜っと待っているが聞いたこともない」理由は合わせ技。**

1. 材料が薄い（Claude Code の指摘）
2. 出る保証が無い（Codex の指摘）

片方だけでは説明として不完全。**完成条件は「注入した」ではなく「発話された」でなければならない。**

---

## 4. Claude Code しか指摘していない点（実装量の見積もりに直結）

### 4-1. `score_execution()` は採点しているのに捨てている

`irsdk-bridge/bridge.py:5018`

```python
_strategy_option_score = strategy_options_mod.score_execution(
    strategy_options, actual_entry_lap=pit_enter_lap, actual_fuel_added_l=_fuel_added)
```

計画したピット周・給油量と実際の比較は**既に動いている**。broadcast されてデブリーフに出るだけで、
次のレースの Plan A/B/C には入らない。**新規実装ではなく出口を繋ぐ話。**

### 4-2. `pit_loss_calibrator` は既に学習・永続化している

`irsdk-bridge/bridge.py:5022`

```python
_pit_learning_summary = pit_loss_calibrator.record_forecast_outcome(
    session_track, session_car_model, _caution, _pit_exit_score)
```

**「実測 → 採点 → 次に効く」が完成している経路が既に1本ある。**
4番は新発明ではなく、**動いている型をもう1本増やす**作業。難易度の見積もりが変わる。

### 4-3. `pit_events` は Bridge 側に既にある

Build 281 で実装済み（`entry_lap` / `exit_lap` / `entry_class_position` / `exit_class_position` / `fuel_added_l`）。
**`pw_raceHistory` へ流れていないだけ。**

---

## 5. 食い違いに見えて、検証したら両方正しかった点

- Claude Code:「`engineer-card.js` のキャラクター参照は **0件**」
- Codex:「今は**声・言い回し・頻度**という通信スタイルが中心」

一見矛盾するが、**対象が違うだけだった**（Claude Code が実測）。

| 場所 | キャラ差 | 意味 |
|---|---|---|
| `prompts.js` | **26箇所** | LLM応答の人格はここで効いている |
| `engineer-card.js` | **0箇所** | 決定論カードは全キャラ同一 |
| `irsdk-bridge/bridge.py` | **0箇所** | 決定論無線も全キャラ同一 |

**結論：キャラクターは LLM が喋る時だけ効いている。**
ドライバーが一番よく聞く決定論経路（安全コール・GAP・燃料）は、James も Maple も Hajime も**一字一句同じ**。

Codex の「同じ事実を別のレース哲学で扱うところまで来ていない」という診断は、この構造から出ている。
**表現が違っただけで、見ているものは同じ。**

---

## 6. Codex の提案が優れている点

### 6-1. Decision ID

保存・採点・翌日の選択を**1本のIDで貫く**。

Claude Code は「`pit_events` を `pw_raceHistory` へ流す」と配管単位で言ったが、それでは
**どの判断がどの結果に対応するか後から辿れない**。Decision ID なら「6周目のアンダーカット判断」という
単位で追跡できる。**設計として上。**

### 6-2. 条件が揃わなければ再提案しない

> 過去戦略を再提案できるのは、今日の燃料ウインドウ・予選順位・リジョイン条件が揃う場合だけ。
> 揃わなければ「前回の条件は今回は未成立」と言う。

無条件の再提案を禁じる fail-closed。Claude Code が自己訂正記憶の設計で書いた
「記憶は Bridge の事実に従属する」と同じ思想だが、**Codex の方が具体的**。

---

## 7. 合意した実装方針（Memory Action Layer 実戦版 v1）

Codex 案に Claude Code の 4-1 / 4-2 / 4-3 を統合したもの。

1. **完走時に保存**：順位・スタート位置・**Decision ID**・pit周・予測復帰・実際のblend後順位・成立／不成立理由
   - **既存の `pit_events` と `score_execution` の出力を使う**（新規計測を作らない）
2. **次回選択**：同一シリーズ／コース／車種で条件一致する過去結果を**1件だけ**選ぶ
3. **自発発話**：予選前または Strategy モード接続時に**必ず短く**ブリーフィングする
4. **再提案の条件**：燃料ウインドウ・予選順位・リジョイン条件が揃う時のみ。揃わなければ**未成立と言う**
5. **traceテスト**：`保存 → 選択 → 発話 → 今回の結果採点` を**一本のtrace**で検証する
6. **手本**：`pit_loss_calibrator` の学習・永続化の形に倣う（既に動いている唯一の前例）

### 完成条件（ここを緩めない）

**「保存済み」では合格にしない。**
翌セッションでの**自発発話**と、その**根拠trace**までを完了条件とする。

---

## 8. なぜ今まで進まなかったのか（見解・照合対象外）

**事実ではなく解釈**なので、Yuji の判断が上位。両者の見解を併記する。

**Codex の見解**

> 私たちが保存・注入・デブリーフを"記憶がある"と扱い、**無線で役立つ最終動線を同じ完成条件にしていなかった**。

**Claude Code の見解**

1. **常に「今日の火事」を消していた** — Build 277（発話24秒）、281（package漏れ）、282（その検証）は全部実走障害への対応。正しい仕事だが、積んでも「壊れていない製品」以上には行かない。
2. **「実装済み」と言った内容が Yuji の期待とズレていた** — 1階記憶は実際に動いているが、Yuji が欲しかったのは戦略の記憶だった。**この食い違いを解消しなかったのは Claude Code の落ち度。**
3. **品質を上げるほど新機能の時間が減る** — 出荷ゲートは正しい判断で実際に本物の欠陥を捕まえたが、検証は時間を食う。**トレードオフの配分は Yuji が決めること。**

**両者に共通する結論**：昨日 Yuji が作った出荷確認表は、まさにこの穴を塞ぐためのもの。

---

## 9. 他社比較について（判断材料として弱い）

Claude Code は他社製品を試していないため、速度も精度も**比較できない**。推測で語れば根拠のない断定になる。

ただしコードから言えることが1つある。

**PITWALL には `pit_loss_calibrator` という「実測から学んで次に効いている」経路が既にある。**
これが他社に対して優位かどうかは不明だが、**社内に前例がある**ことは 4番の実現可能性を上げる事実。

---

## 10. 進め方の合意

**Build 282 の配布検査を通した次の最優先を、Memory Action Layer 実戦版 v1 に絞る。**（両者一致）

Build 282 は既に **Gate 4 まで通過・P0/P1 0件**。残るのは Gate 5〜9
（private candidate artifact / Windows / iRacing 実走 / server SHA）で、**Yuji の手が必要な部分**。

### Yuji 判断待ち

1. Build 282 を先に配布検査まで通すか、4番へ先に入るか
2. 品質検証と新機能開発の時間配分
3. 保存先（ローカル / サーバー）— [LUNA_SELF_CORRECTION_MEMORY_DESIGN_V1.md](LUNA_SELF_CORRECTION_MEMORY_DESIGN_V1.md) の判断待ちと共通

### 関連文書

- [PITWALL_RELEASE_GATE.md](PITWALL_RELEASE_GATE.md) — 出荷ゲート正本
- [LUNA_SELF_CORRECTION_MEMORY_DESIGN_V1.md](LUNA_SELF_CORRECTION_MEMORY_DESIGN_V1.md) — Luna 自己訂正記憶。**同じ「決定論的観測→集約→適用」の骨格を使うので、二重管理にしないこと**
- [BUILD282_CLAUDE_INDEPENDENT_VERIFICATION.md](BUILD282_CLAUDE_INDEPENDENT_VERIFICATION.md) — Build 282 独立確認結果

---

## 11. 突き合わせ運用の作法（今回確立したもの）

Yuji の指摘から確立した手順。**今後の質問でもこの順序を守る。**

1. **同じ質問を両者へ独立に投げる**（先に片方の回答を見せない）
2. 回答を受けたら、**事実の主張と見解を分ける**
3. **事実が食い違った点だけ**を相手に渡し、**コードで再検証**させる
4. 見解が割れた／どちらとも言えない場合は **Yuji が決める**

**理由**：先に相手の結論を読むと引きずられる。同意する方が抵抗が少ないため、
**根拠を先に固定してから照合する**必要がある。今回 Claude Code は Codex の回答を見る前に
9項目の検証可能な主張を確定させ、その後に照合した。

---

## 12. 2026-08-25 Codex 回覧所見

### 結論

北極星、現状診断、Memory Action Layer 実戦版 v1 の優先順位に**異論なし**。
特に「材料が薄い」ことと「発話が保証されていない」ことを別の欠陥として扱い、
完成条件を**翌セッションの自発発話**まで引き上げた点を採用する。

ただし、実装時に再び「保存したが次に効かない」を起こさないため、以下3点を完成条件へ追加する。

### 補強1 — 完走時だけ保存しない

判断記録は、次の段階で追記可能な一つのDecision IDとして持つ。

```text
提案時: decision_id / option / 根拠 / 条件 / 予測を保存
pit exit時: 実行pit周 / 給油量 / 暫定exit順位を追記
blend安定時: 実際のblend後順位 / trafficを追記・一次採点
checker・session終了時: 最終結果 / 成立・不成立理由を確定
```

クラッシュ、切断、途中終了でも提案とpit結果を失わない。完走だけを保存条件にすると、
失敗レースほど学習材料から消え、成功例だけに偏る。

### 補強2 — 事実記憶は全キャラクター・全PCで共有する

現在の`pw_raceHistory`はlocalStorageであり、そのPCにしか存在しない。
Yujiが求める「次の会話でも自然に思い出す」を商用品質で成立させるには、
戦略事実を**認証ユーザー単位のサーバー正本**へ保存し、ローカルはcacheとするのがCodex推奨。

- 共有する: レース事実、Decision ID、予測、実結果、採点
- キャラクター別にし得る: 話し方、情報量、励まし方、呼称
- キャラクターが変わっても曲げない: 燃料、順位、pit、GAP等のBridge事実

Jamesで走った成功戦略をLunaが知らない、別PCでは初対面に戻る、という状態は北極星に反する。

### 補強3 — 自発発話はLLMの自由選択にしない

次回選択された記憶は、決定論handlerが短い`memory_strategy_briefing`カードを生成し、
発話queueへ入れる。LLMは事実の選択や数字の補完をせず、許可されたキャラクター表現へ
整える場合だけ使う。発話しなかった場合は次のいずれかをtraceへ必ず残す。

- `spoken`
- `not_applicable_current_conditions`
- `deferred_unsafe_driving_window`
- `discarded_stale`
- `missing_required_evidence`

「プロンプトへ注入した」は合格証拠にしない。

### v1の追加受入条件

保存ログfixtureを使い、次を一本の再生で証明する。

1. 前回P8スタート、Lap 6で条件付きundercut提案をDecision IDつきで保存
2. pit exitとblend後P4を同じDecision IDへ追記・採点
3. 翌日の同一series / track / car / race formatでその1件だけを選択
4. 予選前に前回事実を短く自発発話
5. 今日の予選順位・fuel window・rejoin条件が未確定なら、再実行を断定しない
6. 条件成立後は、その過去結果を候補の根拠として今日のPlanへ渡す
7. 別コース、別車種、別race format、古い記憶、根拠欠落では発話しない
8. 発話queueの生成・保留・再生・破棄と、外部有料API呼出数を記録

### 意見が割れている項目

現時点でClaude CodeとCodexの間に、北極星またはv1の中心設計に関する対立はない。
次の2点は技術的事実ではなく製品判断なので、Yuji判断を上位とする。

1. **Build 282のprivate artifact検査を完了してからv1へ入るか**
   - Codex推奨: 先にBuild 282をGate 5まで閉じ、Build 281のpackage欠落再発を止めてからv1へ入る。
2. **サーバー正本をv1必須にするか**
   - Codex推奨: 商用品質と複数PC・全キャラクター共有のため必須。プライバシー表示、本人確認、削除機能も同じscopeに含める。

commit / build / deploy / 公開を指示する文書ではない。実装時は`PITWALL_RELEASE_GATE.md`を別途適用する。


---

## 13. 2026-08-25 Claude Code — Codex 補強への回覧所見

### 結論：補強1〜3すべて採用。対立なし。追加すべき欠落を2点だけ挙げる。

---

### 補強1（段階的Decision ID）— **採用。私が書いた v1 の欠陥を直している**

7節の私の記述「**完走時に保存**」は誤り。Codex の指摘どおり、完走を保存条件にすると
**失敗レースほど学習材料から消え、成功例だけに偏る**。

これは統計でいう生存者バイアスで、**学習系として最も避けるべき歪み**。
クラッシュ・切断・途中終了こそ「その戦略が成立しなかった」という一次証拠であり、
成功例より価値が高い場合すらある。

7節の記述は補強1で置き換える。提案時 → pit exit → blend安定 → session終了の4段階追記が正。

---

### 補強2（サーバー正本）— **Yuji判断。ただし決定的な制約を1つ提示する**

Codex は「商用品質のため必須」と推奨。私は賛否を述べない（製品判断）。
ただし**判断材料として見落とせない事実**があるので提示する。

#### 公開済みプライバシーポリシーと衝突する可能性

`public/privacy.html:44`（現在公開中・太字で明記）

> The Bridge runs entirely on your computer. It reads iRacing's live telemetry from local memory
> and sends it to your own browser over a local connection. **Telemetry never leaves your machine.**

同 `:52` では、サーバーへ送る対象を**明示的に限定**している。

> ...they **do not contain conversation text or raw iRacing telemetry**.

レース事実（決勝順位・スタート順位・pit周・ラップタイム・戦略判断）は、
**iRacing telemetry から導出したデータ**である。これをサーバー正本に置くなら、
上記の記述は**そのままでは維持できない**。

PITWALL は「元カートレーサー・運営8年のインサイダーが作った」という**信用**で売る製品であり、
**太字で公開した約束を後から静かに変える**のは、価格や機能の問題ではなく信用の問題になる。

したがってサーバー正本を選ぶ場合、**同じ scope に必ず含める**：

- プライバシーポリシーの改定（「telemetry never leaves」の書き換え／導出データの扱いを明記）
- 何を送るかの利用者への**事前明示**とオプトアウト
- 削除機能（Codex も挙げている）
- 既存利用者への告知

#### 参考：サーバー側の記憶インフラは部分的に存在する

`server.js:583` `/api/memory/import-seeds` ／ `:593` `/ack` が既にある。
ただしこれは**サーバー → 利用者へ配る**方向で、**利用者データを預かる**方向ではない。
ゼロからではないが、**方向が逆なので新規設計が要る**。

#### 参考：現在の端末制約

`MAX_DEVICES_PER_CODE=1`。1コード1台の椅子取りゲームであり、
「別PCでは初対面に戻る」は**現在の利用権設計とも関係する**。
複数PC共有を前提にするなら、利用権側の方針と整合を取る必要がある
（耐久チーム向けの Chief Engineer cross-PC relay は別経路で既に存在）。

---

### 補強3（決定論handler＋trace5状態）— **採用。3節の欠陥に対する正しい答え**

「プロンプトへ注入した」を合格証拠にしない、という原則に完全に同意する。
trace の5状態（`spoken` / `not_applicable_current_conditions` / `deferred_unsafe_driving_window` /
`discarded_stale` / `missing_required_evidence`）は、**黙った理由が必ず残る**ので
「なぜ喋らなかったのか分からない」が構造的に消える。

`memory_strategy_briefing` カードを決定論handlerが生成し、LLM は
**許可されたキャラクター表現へ整える場合だけ**使う、という分担も正しい。
これは 5節で確認した「決定論経路にキャラ差が0件」という現状に対する、
**5番（Character）への正しい入口**にもなっている。

---

## 14. Claude Code から追加する欠落 2点

Codex の受入条件1〜8は妥当だが、**次の2つが抜けている**。どちらも v1 の scope に入れるべき。

### 追加1 — 失敗した戦略の記憶を、失敗として使えること

受入条件は「前回P8→undercut→P4」という**成功例**だけを辿っている。
保存側は補強1で失敗も残るようになったが、**適用側が成功例しか想定していない**。

必要なのは：

> 「前回ここで同じundercutを試して、渋滞で復帰8番手まで落ちた。今日は条件が違う」

これが言えないと、**保存は偏らないのに適用が偏る**。生存者バイアスが出口側に残る。

**受入条件へ追加すべき項目**

9. 前回**不成立**だった判断が保存されている時、同条件で**再実行を勧めない**こと。
   かつ、その事実を短く伝えられること（黙殺しない）。

### 追加2 — ドライバーが記憶を訂正できること

保存された事実が誤っている場合（SDK取りこぼし、セッション跨ぎの混入、
Build 281 で実際に起きたピット周の取り違え等）、**訂正手段が無い**。

Luna が誤った過去を根拠に今日の戦略を提案し、ドライバーが「それ違う」と言っても、
記憶は変わらない。**次のレースでも同じ誤りを言う。**

これは [LUNA_SELF_CORRECTION_MEMORY_DESIGN_V1.md](LUNA_SELF_CORRECTION_MEMORY_DESIGN_V1.md) の
**③合意ループと同じ機構**であり、10節の「二重管理にしない」という注意はここにも効く。

**受入条件へ追加すべき項目**

10. 提示した過去事実をドライバーが否定した時、その記録に**疑義フラグ**が立ち、
    以後の自発発話で**根拠として使われない**こと。訂正は決定論的に記録し、LLM に判断させない。

---

## 15. 現時点の対立状況

**Claude Code と Codex の間に、北極星・v1中心設計・補強1〜3に関する対立は無い。**

Yuji 判断待ちは Codex が挙げた2点で変わらない。ただし2点目には上記13節の制約が付く。

| # | 判断項目 | Codex推奨 | Claude Code |
|---|---|---|---|
| 1 | Build 282 を Gate 5 まで閉じてから v1 へ入るか | 先に閉じる | **同意**（package欠落の再発防止が先） |
| 2 | サーバー正本を v1 必須にするか | 必須 | **賛否を述べない**。ただし公開済みプライバシーポリシーの改定が**同じ scope に必須**（13節） |

commit / build / deploy / 公開を指示する文書ではない。実装時は `PITWALL_RELEASE_GATE.md` を別途適用する。

---

## 16. 2026-08-25 Yuji決定・Claude Code作業指示・Codex確認契約

### Yuji決定

1. **Build 282をGate 5まで先に閉じる。** その合格後にMemory Action Layer 実戦版 v1へ入る。
2. **v1は認証ユーザー単位のサーバー正本を必須にする。** ローカルはcacheとする。
3. サーバーへ置くのは、構造化したDecision ID、根拠、条件、予測、実結果、採点、訂正履歴に限定する。生音声・会話全文・不要な生telemetryは原則保存しない。
4. privacy / terms / 利用者への事前明示・オプトアウト / 表示・訂正・削除 / 保持期間を**同じ実装scope**に含める。公開済みの`Telemetry never leaves your machine`を静かに変更しない。
5. **Claude Codeが作業者、Codexが独立確認者。** 作業者自身の報告だけで合格にしない。

### 作業順序A — Build 282 Gate 5

Claude Codeは`AGENTS.md`、`HANDOFF.md`、`PITWALL_RELEASE_GATE.md`、本書を全文確認してから着手する。

1. 現在のdirty worktreeと対象diffを列挙し、既存のYuji作業・無関係ファイルを混ぜない。
2. 製品Build番号を282へ揃える。Bridge、desktop表示、`build-info.json`の生成元を照合する。
3. Gate 0〜4の証拠が現worktreeでも有効か再確認する。P0/P1があればGate 5へ進まない。
4. **Yujiの明示private build GO後だけ**、`publish=false`でDesktop candidateを生成する。push / deploy / 公開は別GO。
5. 完成artifactを取得し、次を実物で検査する。
   - renderer参照の全ローカルJS
   - `memory-action-layer.js`
   - `strategy-playbook.js`
   - `fuel-plan-guard.js`
   - `cost-meter.js`
   - `local-intent-router.js`
   - 同梱Bridge exeの存在・非0 byte・対象SHA
   - installer bytes / SHA-256 / workflow SHA / Build番号
6. 作業報告を本書または共有ログへ追記し、Codexへartifactと証拠を渡す。
7. CodexがCIログ・完成asar・同梱Bridge・hashを独立確認する。Gate 5合格前にv1へ入らない。

### 作業順序B — Memory Action Layer 実戦版 v1

Gate 5合格後、Claude Codeが実装する。最小scopeは次の通り。

#### 1. Decision lifecycle

- 提案時にDecision IDを発行し、option / 根拠 / 成立条件 / 不確実性 / 予測を保存する。
- pit exit、blend安定、checker・session終了で同じIDへ追記する。
- DNF、切断、途中終了でも、そこまでに確定した判断と結果を失わない。
- Bridgeの生観測は改変しない。訂正・疑義・supersedeは別recordとして履歴を残す。

#### 2. 成功と失敗の両方を次へ使う

- 成功例だけでなく、不成立・悪化例も選択対象にする。
- `success / failed_traffic / failed_fuel / failed_execution / invalidated / unknown`等、根拠のある結果分類を持つ。名称は実装前にclosed enumとして確定する。
- 前回失敗しただけで永久禁止しない。現在条件と失敗条件を比較し、同条件なら勧めず、条件が変われば再候補にできる。

#### 3. 訂正・合意ループ

- Lunaが提示した記憶へドライバーが「違う」と述べた時、対象Decision IDを特定する。
- 直ちに`disputed`として次の戦略根拠から除外する。
- Lunaが訂正内容を一度だけ読み返し、本人合意後に`confirmed_correction`または`invalidated`へ更新する。
- LLMに事実の真偽や対象IDを推測させない。特定不能なら保存せず、どの記憶か一度だけ確認する。
- `LUNA_SELF_CORRECTION_MEMORY_DESIGN_V1.md`の合意ループを共用し、二重実装しない。

#### 4. サーバー正本

- 認証ユーザー以外は読めない・書けない・訂正できない・削除できない。
- 冪等性、別ユーザー分離、重複event、offline retry、古いcache、削除後再同期を検査する。
- 全キャラクターは同じ戦略事実を読む。キャラクター別なのは表現・頻度・呼称等だけ。
- privacy / terms / UI説明をコードと同時に更新する。ただしdeploy・公開はYujiの別GOまで行わない。

#### 5. 決定論的な自発発話

- 次回条件に一致した記憶を1件だけ選び、`memory_strategy_briefing`カードを作る。
- LLMは数字・事実・選択を行わない。許可されたキャラクター表現へ整える場合だけ使用する。
- `spoken / not_applicable_current_conditions / deferred_unsafe_driving_window / discarded_stale / missing_required_evidence`を必ずtraceする。
- 注入成功では合格にせず、queue生成→保留/破棄→実発話まで検査する。

### 必須fixture / 受入テスト

1. 成功例: P8スタート→Lap 6 undercut提案→blend後P4→翌日自発ブリーフィング→当日条件成立後Planへ採用。
2. 失敗例: 同じundercut→trafficでP8へ悪化→翌日同条件では勧めず理由を短く発話→traffic条件が変われば再候補。
3. 訂正例: 誤ったpit lapを提示→ドライバー異議→即`disputed`→根拠利用停止→読み返し合意→訂正後だけ次回利用。
4. 反証: 別series / track / car / race format / driver、古いrecord、根拠欠落、session切替、重複Decision ID。
5. E2E trace: Bridge入力→Decision→server保存→次回取得→handler→queue→発話/破棄→今回採点→更新。
6. 原価: 通常テストの外部有料API 0件。generated / deferred / played / discardedとwasted-generation costを分離する。

### Claude Codeの完了報告に必要なもの

- 変更ファイル一覧と完全diff
- schema / API / auth / privacy変更
- Decision IDの状態遷移表
- 成功・失敗・訂正の3本のtrace
- 対象テスト、全回帰、preflight、外部有料API 0件
- 未確認のWindows / iRacing / server / privacy表示
- commit / push / build / deploy / 公開の実施有無

### Codex確認範囲

Codexは作業報告を転載せず、コード・差分・テスト・traceを独立確認する。特に、成功例だけのテスト、
localStorageだけの保存、LLM任せの発話、異議recordの再利用、別ユーザー混入、privacy文言と実装の不一致を反証する。

---

## 17. Tunnel Completion Rule — 入口があるなら出口を必ず作る

2026-08-25 Yuji恒久指示。保存、handler、注入、traceの一部だけを実装して「完成」としない。以下のマトリクスを**一つの統合scope**として実装し、各行を出力側からsource側へ逆向きにも検証する。空欄または未接続が一つでもあれば未完成。

| 対象 | 入口 / source | 権威・保存 | 取得・判断 | 必須出口 | 結果・訂正 | 必須証拠 |
|---|---|---|---|---|---|---|
| Build 282回帰 | Bridgeのlive GAP・fuel・hazard・session state | Bridgeを権威とし、欠損時はfail-closed | packaged local router / deterministic handler | Race中の短いradio、queue fate trace | session切替・stale snapshot破棄 | source testだけでなく完成asar、Windows取得、実iRacing質問 |
| 過去天候 | live telemetry、import済みPractice Profile | driver / car / track / session / 日時を伴う実測要約。現在値の過去代用は禁止 | 同一条件の履歴だけを検索し、当日との差を判断 | 質問への過去値回答、次回briefingまたはsetup協議での根拠付き比較 | 誤記録の異議・訂正・削除 | 記録あり、記録なし、別track、現在値代用禁止、次回発話のE2E trace |
| setup進化 | importのsetup fingerprint/version、本人申告の変更 | 取得できた値と本人申告をsource labelで分離。得られない数値は推測禁止 | 変更前後のvalid lap、fuel、tyre/handling、天候を同一versionへ結合 | 次回Practice briefing、setup質問への比較、条件付き提案 | ドライバー確認、反証、supersede、削除 | setup変更→走行結果→次回提案→本人訂正を一本のfixtureで再生 |
| Memory→Strategy | Decision ID、option、根拠、条件、予測、pit cycle | 認証ユーザー単位server正本＋local cache。成功・失敗・途中終了を保存 | 現在のseries / format / track / car / driver / traffic条件と照合 | `memory_strategy_briefing`の自発発話、当日Planへの条件付き採用 | 今回結果を同じIDへ採点。異議で即`disputed`、合意後だけ訂正 | 保存→次回選択→queue→発話/破棄→Plan→今回採点→訂正のE2E trace |

### 統合実装の境界

- Build 282のpackage/GAP修正は捨てず、次候補の回帰基盤として全行に適用する。
- 過去天候だけの単独handler、setup fingerprintだけの保存、Decision IDだけのDB追加は禁止。共通のsession-memory identity、server canonical、retrieval、radio/briefing consumerへ接続する。
- LLMは数値、事実、対象record、戦略採用を選ばない。決定論層が選び、LLMは許可された表現だけを整える。
- 機械検証、package検証、Windows検証、実走確認は別証拠として記録する。source test合格をfield successと扱わない。
- この指示はbuild / push / deploy / 公開の許可ではない。各工程は`PITWALL_RELEASE_GATE.md`とYujiの明示GOに従う。

### 役割

- Claude Code: 上記4行を共通契約として実装し、完全diff、状態遷移、入口→出口trace、未確認項目を共有ログへ報告する。
- Codex: 同じ機能を重複実装せず、各出口からsourceまで逆引きし、欠損・stale・別identity・失敗例・訂正後の再利用・package欠落を独立確認する。
