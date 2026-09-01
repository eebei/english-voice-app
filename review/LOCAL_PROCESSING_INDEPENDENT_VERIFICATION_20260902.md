# ローカル事実処理 — 独立検証（Claude Code）

作成: 2026-09-02 JST
依頼: `review/LOCAL_FACT_PROCESSING_VS_CURRENT_PITWALL_INDEPENDENT_REVIEW.md`（Codex `8796d9a`）
対象: `39a4386` / 現行ローカルルーター `desktop/local-intent-router.js`（451行・29 intent）
再現テスト: `tests-local-confidence-contract.js`（新規・**実行して判定する**）

---

## 0. 検証方法を変えた（これが本題）

Yuji指摘：「できます」と言った機能が、実際には意図どおり動いていない。検証が70%だった。

**原因は特定できる。これまでの私の検証の中身が静的検査だった。**

| テスト | check総数 | うち文字列照合を含む行 |
|---|---:|---:|
| `tests-conversation-truth-p0.js` | 28 | **33** |

`renderer.includes('...')` は「そう書いてあるか」しか見ておらず、**動かしていない**。
コードが書かれていることと、意図どおり動くことは別である。ここが70%の正体。

今回は**routerを実際に呼び、返ってきた発話文と `confidence` の整合を機械的に突き合わせた**。
仕様の写経ではなく実挙動で判定する。結果、静的検査では一件も出なかった不整合が**7件**出た。

---

## 1. `39a4386` の独立確認 — P1 を1件、P2 を1件検出

### 実装の実体

14行。ローカル回答に `source:'local_authority'` と `confidence:'confirmed'|'unavailable'` を付け、
診断ログへ出す。**ルーティングも回答内容も変えていない。**

```js
confidence: /(?:unavailable|stale|held|measuring)/i.test(String(intent)) ? 'unavailable' : 'confirmed'
```

### P1 — `confidence` が**データではなく intent 名**から決まる

`confidence` は intent 名の正規表現マッチで決まる。**回答が「取得できない」と言っていても、
intent 名にその語が無ければ `confirmed` になる。**

実行して検出した不整合（`tests-local-confidence-contract.js`・空データで質問）:

| intent | 実際の発話 | 付いた confidence |
|---|---|---|
| `fuel_status` | 燃料の実測がまだ足りない。クリーンラップを待つ。 | **confirmed** |
| `laps_remaining` | 残り周回の権威データがない。 | **confirmed** |
| `leader_gap` | クラス首位とのGAPは取得できない。直前車のGAPでは代用しない。 | **confirmed** |
| `leader_lap` | クラス首位の周回数は取得できない。 | **confirmed** |
| `track_temperature` | 現在の路面温度は取得できない。 | **confirmed** |
| `weather_status` | 現在の天候テレメトリは取得できない。 | **confirmed** |
| `fuel_window_status` | まだ。燃費と完走距離を確認中。 | **confirmed** |

一方で正しく `unavailable` が付くのは、intent 名に語が入っている7件だけ
（`nearest_gap_unavailable` / `nearest_gap_stale` / `nearest_gap_held` /
`faster_class_unavailable` / `race_format_unavailable` / `historical_weather_unavailable` /
`incident_average_unavailable`）。

**これは依頼書 §「必ず検証する危険性」項目3「stale値、null、0、空文字が確定値へ化けないか」
そのものであり、それが今回のコミット自身で起きている。**

現状は診断ログにしか出ないため実害は限定的だが、**この `confirmed` を根拠に
「ローカル回答はLLMより優先」を実装した瞬間、「取得できない」が権威ある事実として固定される。**
V4でローカル処理へ寄せるなら、ここを直さずに進めてはならない。

**修正方針**: `confidence` を intent 名から導出しない。`answer()` の第3引数として
呼び出し側が明示するか、`answer()` を `fact()` / `unavailable()` の2種に分ける。
命名規約に依存する限り、intent を1つ足すたびに同じ穴が空く。

### P2 — コメントが実装より広いことを主張している

`39a4386` のコメントは以下を主張する。

> The renderer can use this contract to prevent an LLM response from replacing an authoritative local answer

実測: `renderer.html` 内の `localIntent.confidence` / `localIntent.source` の参照は**2箇所のみ、
どちらも `diagnosticLog` の中**。分岐に使われている箇所はゼロ。
「防げる」ではなく「防ぐ材料を置いた」が正確。将来の読み手が実装済みと誤読する。

---

## 2. ローカルルーターの全分岐（29 intent）

| # | intent | 種別 | 権威の出所 |
|---|---|---|---|
| 1 | `acknowledgement` | 応答 | — |
| 2 | `fuel_window_watch` | 監視起動 | Plan B window |
| 3 | `fuel_window_status` | 事実 | `fuelWindowStatus()` |
| 4 | `fuel_status` | 事実 | `live.fuel` / 燃費実測 |
| 5 | `best_lap` | 事実 | Bridge `best` |
| 6 | `telemetry_status` | 状態 | live 接続 |
| 7 | `race_format` | 事実 | session plan |
| 8 | `race_format_unavailable` | 不足 | — |
| 9 | `laps_remaining` | 事実 | `crossings` / remaining |
| 10 | `time_remaining` | 事実 | session |
| 11 | `historical_weather_unavailable` | 不足 | — |
| 12 | `track_temperature` | 事実 | `w.track` |
| 13 | `weather_status` | 事実 | weather |
| 14 | `faster_class_status` | 事実 | 実測 |
| 15 | `faster_class_unavailable` | 不足 | — |
| 16 | `measurement_disputed` | 訂正保留 | — |
| 17 | `gap_reply_acknowledgement` | 応答 | — |
| 18 | `incident_average` | 事実 | `pw_raceHistory` + userId |
| 19 | `incident_average_unavailable` | 不足 | — |
| 20 | `gap_reporting_acknowledgement` | 応答 | — |
| 21 | `nearest_gap_stale` | 不足 | 鮮度 |
| 22 | `nearest_gap_held` | 保留 | 訂正保留 |
| 23 | `nearest_gap_unavailable` | 不足 | — |
| 24 | （GAP 本体・`gapAnswer`） | 事実 | `gap_authority` + `gapIdentityFor` |
| 25 | `leader_lap` | 事実 | leaders |
| 26 | `leader_gap` | 事実 | class leader |
| 27 | `current_position` | 事実 | `class_pos` 系 |
| 28 | `pit_location_ack` | 応答 | — |
| 29 | `race_goal_ack` / `race_comment_ack` | 応答 | — |

**事実系14・不足系6・応答系7・監視1・保留1。**

---

## 3. 分岐ごとの権威性・鮮度・対象識別・出口

| 観点 | 状況 |
|---|---|
| **対象識別** | **GAPのみ実装が厚い。** `gapIdentityFor()` が direction / session_key / generation / source_kind / target_car_idx を返し、TTS開始直前に `gap-freshness.evaluateAnswer()` で再照合する。**他の28 intent にこの仕組みは無い。** |
| **鮮度** | `snapshotAgeMs` を受け取るが、**GAP以外はほぼ使っていない**。順位・燃料・天候は queue 待ちの間に古くなっても言い直されない |
| **権威** | Bridge live 値を直接読む。`class_pos` は `player_class_position ?? class_position ?? class_pos` の3段フォールバック＝**どれが答えたのか発話にもログにも残らない** |
| **出口** | すべて `speak(reply, {prio:P2_PROCEDURE, kind:'local_'+intent, dedupeKey:...})`。GAPだけ `gapIdentities` を渡して出口で再照合 |

**依頼書の項目1・2（`gap_behind` が本当に直後車両か、観測時刻・car_idx が発話時点と一致するか）は
GAPについては満たされている。それ以外の事実系13 intent については仕組みが存在しない。**

---

## 4. 現行より悪化しうる点（依頼どおり3点以上）

**① 「取得できない」が権威として固定される（上記P1の帰結）**
現行はLLMが「データが来てない」と自然に言い直したり、別の角度から答えたりする余地がある。
`confirmed` を優先する実装を入れると、**不足の断定が最優先で確定**し、Lunaが補う道が閉じる。

**② Bridgeの誤値が高速・断定的に増幅される**
依頼書§9そのもの。8/31夜の実例がある。`buildFallbackSessionSummary()` が
存在しないフィールド `lastTelemetry.incidents` を `|| 0` で読み、**公式3に対し「Incidents 0」と断定**した。
LLM経由なら「手元にない」と言えた可能性がある場面で、ローカル経路は**迷わず0と言い切った**。
ローカル処理は嘘を減らすが、**入力が誤っている時の断定を強める**。

**③ 定型文が会話を殺す（既に実走で起きている）**
8/31夜 `19:35:44`、ドライバーの相槌「大丈夫だよ。トップ2台とか上位入ってないもんね」に対し
`leader_gap` が誤発火し「クラス首位とのGAPは取得できない。直前車のGAPでは代用しない。」と返した。
**質問されていないのに内部規約を読み上げた。** ローカル分岐を増やすほど、
相槌・独り言を吸い込む面積が広がる。これは収束計画の型③（意図の取り違え）と型②（内部語の漏出）。

**④ フォールバックの多段化で「どの値が答えたか」が消える**
`player_class_position ?? class_position ?? class_pos` のように3段で拾う箇所があり、
どれが使われたかログにも残らない。誤答時の原因追跡ができない。

---

## 5. 分類 — 移すべき / Lunaに残すべき / 保留

| 分類 | 対象 | 理由 |
|---|---|---|
| **ローカルへ移してよい** | GAP（前後）、現在順位、ベストラップ、残り周回・時間、路面温度・天候、燃料残量 | 単一の権威値を読むだけ。ただし**GAP と同等の identity + 鮮度照合を全件に付けること**が条件 |
| **Lunaに残す** | 戦略判断（Plan A/B の選択と理由）、アンダーカット成否の解釈、デブリーフ、ドライバーの感想への応答、複数要因の比較 | 文脈と意味づけが要る。定型文にすると 8/31 の「内部規約の読み上げ」が増える |
| **保留（設計が足りない）** | 燃料ウィンドウの「あと何周で開く」、リジョイン予測、相対ペース | 計算そのものが未確立。8/31夜は「残り26分22秒」と軸違いを返し、リジョインは実測P7に対し予測P12（誤差-5・自身のbest/worst範囲外）。**ローカルへ移す前に計算を直す** |
| **移してはいけない** | ドライバーの決定に対する応答 | 「ボックス」に「ステイアウト」を返した件。定型判断がドライバーの判断を上書きする |

---

## 6. 受入条件に対する判定

依頼書の受入条件8件を、現時点の証拠で判定する。

| 受入条件 | 判定 | 根拠 |
|---|---|---|
| 事実質問の正答率90%以上 | **未測定** | 比較対象の実装が無く、正解セットも未整備 |
| 誤った数値を断定するケースがゼロ | **不合格** | 8/31夜「Incidents 0」（公式3）。Build 292 で経路は塞いだが実走未確認 |
| 入力誤りのソース・時刻・対象の不一致を検出できる | **部分合格** | GAPのみ。他13 intent は仕組み無し |
| LLM削減量とレイテンシ改善を実測提示 | **未測定** | — |
| ローカル回答が戦略相談を奪わない | **不合格** | 8/31夜 `leader_gap` 誤発火で相槌に規約を返した |
| 不足時に理由と次の行動を返す | **部分合格** | 「まだ。燃費と完走距離を確認中。」は理由のみで次の行動が無い |
| 現行より会話品質が悪化しない | **未測定** | 収束計画 §9-4 の6 KPI が未実装 |
| Windows実機・実走で同じ契約が再現 | **未確認** | Gate 6 / 8 未実施 |

### 結論

**現時点で「ローカル処理へ全面的に寄せる」は採用不可。**
合格2件・不合格3件・部分合格2件・未測定3件で、受入条件を満たしていない。

ただし**否定するのは「全面移行」であって、方向性ではない。** 段階案を出す。

---

## 7. 代替案（段階導入）

**第0段階（`39a4386` の前提修正・これ無しに先へ進めない）**
`confidence` を intent 名から導出するのをやめる。呼び出し側が明示する契約へ変える。
`answer()` を `fact()` / `unavailable()` に分割するのが確実（命名規約に依存しなくなる）。

**第1段階（identity の横展開）**
GAP にしかない「対象・セッション・世代・時刻」の identity と TTS 直前の再照合を、
事実系14 intent すべてへ広げる。**これがローカル処理の安全性の本体**であり、
`confidence` ラベルはその副産物にすぎない。

**第2段階（計測）**
収束計画 §9-4 の6 KPI（質問軸一致率・数値誤答率・echo率・訂正反映率・不要発話率・戦略回収率）を
実装し、**現行構成の基準線を先に取る**。比較対象が無い状態で「改善した」とは言えない。

**第3段階（限定移行）**
第2段階の実測で、現行より正答率が上がった intent **だけ**を移す。
戦略・デブリーフ・ドライバーの決定への応答は移さない。

---

## 8. 追加したテスト

`tests-local-confidence-contract.js`（新規）。**実行して判定する**形式。

- 空データで15種の質問を router へ通し、**発話が「取得できない」と言っているのに
  `confidence=confirmed` になる組み合わせ**を機械的に列挙する（現状7件検出）
- ローカル回答すべてに `source=local_authority` が付くか（合格）
- 実データで `confirmed` になるか＝過剰拒否の検出（合格）
- `confidence` が診断ログ以外の分岐で使われているか＝宣言と実装の乖離（現状不合格）

**このテストは現状で意図的に赤である。** 上記P1/P2を直すと緑になる。
「テストを緑にするために期待値を下げる」ことはしていない。

---

## 9. Build 292 との関係（先に片付けるべき事項）

- `39a4386` は Build 292 の対象SHA `2d1b7ae` より**後**であり、**Gate 5 合格 artifact に入っていない**。
- Build 292 を名乗る artifact が現在**4本**存在する。

| run | 対象SHA | artifact | 検査 |
|---|---|---|---|
| `33467780133` | `2d1b7ae` | Build-292-**20260901-0354** | **Gate 5 合格（Claude + Codex）** |
| `33500964892` | `aff1f44` | Build-292-20260901-1110 | 未検査 |
| `33564939745` | `aff1f44` | Build-292-20260901-2211 | 未検査 |
| `33566268659` | `aff1f44` | Build-292-20260901-2226 | 未検査 |

`2d1b7ae → aff1f44` は MD のみの差分で製品コードは同一だが、
**署名したのは `20260901-0354` の1本だけ**である。公開時はこの run を使う。
`39a4386` を入れるなら Build 293 として採番し直す。
