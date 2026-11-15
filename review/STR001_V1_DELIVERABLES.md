# STR-001 v1 成果物（作業メインClaude／設計§24.11）

基点：公開Build306の対象SHA `896f47d2d8eabb629c8de12ebc86f31be61a67d8`（公開記録 `a4ccaa6` で照合）から、隔離worktree `english-voice-app-str001`（branch `str001-work`、未commit）を作成。旧P1-001aの未commit差分は元checkout（`english-voice-app`）に保全され、ここへは持ち込んでいない。

## 0. 先に読むこと：この版の「3案の比較」が何で差を出すか（検査Claude差戻し#2への回答・前版の記述の訂正）

- 前版は「3案が出る」と書いたが、**給油のみ・同ペースの世界では、停止周を変えても総所要時間は変わらない**ため、交通以外で差が出ない構造だった（Montreal再生で3案が同点になったのはデータ不足だけでなく構造）。
- 今版は差を生む項を足した：①**燃料重量による遅れ**（補給後は重い。早く入るほど重い時間が長い＝オーバーカット側に効く。係数は暫定 0.03 s/L/Lap [0〜0.045]、**assumed**・実測なし）②復帰時の**交通**（観測できた車だけ）③**相手の停止時期**（早い/遅いの条件別）。**入っていない**もの：タイヤ、インラップ/アウトラップのペース差。
- したがって Montreal再生の推奨は「燃料重量が効く分、できるだけ遅く入る基準案が最良、交通が無ければ変更理由なし」になる。**係数が暫定値なので、この結論は仮定に依存する**（packetの`inputs`と`unmeasured`に明記）。
- §24.11-5 の「早ピット案が自車99秒」を `compute()` が生み出せるか：**絶対所要時間 99/102 そのものは出さない**（所要時間は 周回数×ペース＋損失 で決まる）。同じ**GAPの値（+2→−1、交通4秒で+3・反転）を `compute()` 経由で導く入力**は作り、テストH1c/H2cで固定した（相手Rの現GAP−1、通常案だけが遅い車Wの直後に復帰＝3秒、早ピット案へDriver申告で+4秒）。絶対時間の対応は未達として扱う。
- **§24.12 での変更（round4）**：①通常案＝現行の燃料計画(canonicalの`strategy_options.plan_a`の有効な周)。使えない時は出所つき暫定基準（総周回の半分・`provisional_even_split`・assumed）。基準も総周回も無ければ比較を**保留**する。**燃料の限界周は通常案の定義に使わない**（参考情報として`safe_candidates`に出すだけ）。②全想定停止後の共通ラインが完走までに成立しない時は**比較不可**（完走周への切り詰めをやめた）。③相手の停止シナリオ（早い/遅い・観測・申告）に応じて復帰車列と交通を更新（窓への出入りで優劣が変わる例あり）。④Driver申告の相手停止は`rival_pitted_declared`（driver_declared）で、観測(`rival_in_pit_now`)へ昇格させない。⑤燃料重量係数は未校正：k=0／0.03／0.045で推奨を比べ、反転するなら`conditional_on_fuel_weight`と`flips_when`で条件付きに示す。⑥Truth Gateは項目別・現況/予測別（現燃料／追加給油／入口の燃料／余裕／燃費、現GAP／予測GAP／ピットロス／交通／ペース、基準周／判断期限／周数）。⑦再生入力は観測時刻とsession時刻で切り、別raceの保存入力は拒否。⑧戦略相談は1 Driverターンにつきパケット付きLLM実行1回（暫定上限）。⑨Bridgeの`competitors[].on_pit`を追加（契約は§9）。
- 比較時点・モデル範囲（給油のみ／各車最大1停止／同クラス隣接4台まで）は監督/監査の判断事項。

## 1. 対象ログと取得項目
- 入力：`pitwall-local-evidence/field306-oct26/OMORAY-bridge-debug-20261026-1931.log`（sha256先頭16桁 `e239d8fc95044ed5`、67,315行）。対象race＝`sub:89653165`（BOX AUTHORITY snapshotの `race_instance_id` が現れる行範囲 14518〜67282）。同ログ内の他session（`sub:89652138`）は除外。
- 抽出：`tools/str001-extract-montreal.js` → `fixtures/str001/montreal-sub89653165-inputs.json`（29 Lap行＋ピット実測サンプル3＋校正snapshot13）。終了後の実績は別ファイル `…-outcome-verification-only.json`（検証側だけ。計算は読まない＝テストで確認）。
- 計算の入力は、観測時刻より前に観測できたものだけ（`fixtures/str001/replay-inputs.js`）。未来のLap行・未来の校正を壊してもLap8の計算版が変わらないことをテストで固定（R5）。

| 項目 | ログにある | 使い方（出所ラベル） |
|---|---|---|
| 自車の周回・総合順位・前Lapタイム・残燃料 | ○（約5秒間隔 `DATA CHECK`、Lap頭の最初のピット外行を採用） | observed |
| 隣接2台へのGAP（自車基準） | ○（前走車・後続車の2台のみ） | observed。相手の絶対位置・車番・クラスは無い |
| 残り時間（時間制） | ○（Lap単位 `FINAL LAP DIAG timeRem`）。Lap14〜16は欠測 | observed／欠測は直前観測からの経過差で derived |
| 総周回 | × | 残り時間÷最近ペース（assumed、±1周の幅） |
| タンク容量 | ○（`fuelPhysicalL=106 × fuelLimitRatio=0.5`=53L） | observed |
| 予備燃料 | × | assumed（0.5L） |
| ピット作業の実測（給油率・固定停止時間・レーン通過） | △ 練習の停止1件（`PIT SERVICE sample` 19:34）が race前。レース中のサンプル・校正は Lap13以降 | race前は observed（n小）。本線同区間の通過時間は未観測→ assumed（8s[4,12]）。レース中のサンプルは**そのLapより後は使わない** |
| 他車の周回・ペース・ピット状態・停止予定・燃料・タイヤ | × | 相手ペースは自車の最近ペースを仮定（assumed、±0.5s）。停止時期は 早い/遅い の条件別。**全車の連続データは無い** |
| クラス別順位 | × | 絶対順位は出さない（`absolute_rank.value=null, basis=field_incomplete`） |

合成について：保存レース再生には合成値を入れていない（欠測は assumed と明示）。合成が入るのは手計算対照・交通反転の単体テスト（`tests-str001-compare.js`の冒頭に「合成」と明記）。

## 2. 基準案と比較時点の定義
- 基準案（通常案）＝**現行の燃料計画（plan_a）の有効な通常ピット周**。使えない時は出所つき暫定基準（総周回の半分、assumed）。どちらも無ければ比較を保留。燃料の限界周は通常案にしない。plan_aが過去周・無効な時は使わない。
- 候補周＝基準の −3〜+2 周（既定）を同じ燃料制約で評価。**早い側＝アンダーカット、遅い側＝オーバーカット**。タンク容量で1停止完走できない、予備燃料を切る、は理由付きで候補外（保存レースLap8：1周延ばす案は成立、2周延ばす案は燃料で除外）（`cannot_finish_with_one_stop`／`fuel_insufficient_to_reach_pit`）。
- 比較時点＝自車の全候補と相手の全想定停止が終わった後の、最初の共通のスタート/フィニッシュライン通過（`comparison_point.lap`）。**完走までに成立しない時は比較不可**（`blocking: comparison_line_after_finish`）。「後で入る相手の前に一時的に立つ」だけは利益にしない。
- GAPの符号＝**自車の到達時刻 − 相手の到達時刻**。負＝自車が先。通常案との差（`vs_baseline_s`）は負なら通常案より自車が前。
- 相手の停止＝未観測は「早い（全候補より1周前）／遅い（全候補より1周後）」の条件別。観測・Driver申告があればその事実。各車最大1停止、給油のみ、相手の給油量は通常案と同じと仮定。
- 同点（0.1秒以内）は通常案を維持。校正前の成功確率は出さない（`success_probability=null`）。
- 注意：案の差を生む項は §0 のとおり（燃料重量[assumed]・復帰交通・相手の停止時期）。Montreal再生は観測できる車が隣接2台だけで交通がほぼ無いため、差は燃料重量だけになる。

## 3. 計算パケットの項目（`pit_strategy_compare`）
`calc_version`／`calc_id`（入力から決定的に作る）／`race{race_instance_id,session_num}`／`observed_at{lap,wall,position}`／`gap_sign`／`comparable`／`blocking`／`safe_candidates`／`required_conditions`／`comparison_point{lap,laps_from_now}`／`target`／`baseline`／`inputs[{key,value,low,high,unit,source,note}]`／`cases[{id,kind,pit_lap,add_l,service_s,pit_loss_s{value,low,high},fuel_margin_l,fuel_margin_laps_after_l,excluded,rejoin{ahead,behind,traffic_loss_s,traffic_extra_declared_s},comparisons[{rival_id,scenario,scenario_basis,gap_s,gap_range_s,vs_baseline_s,vs_baseline_range_s,required_pace{faster_per_lap_s,required_avg_lap_s,vs_best_clean_s,exceeds_declared_limit}}]}]`／`excluded[{case_id,reason}]`／`recommendation{case_id,pit_lap,add_l,decide_by_lap,worst_case_gap_s,improves_on_baseline_s,next_best,flips_when[],success_probability:null}`／`absolute_rank`／`driver_assumptions[]`／`expires{valid_until_lap,decide_by_lap}`／`unmeasured[]`。

## 4. 旧相談入口から提案までの配線（Build306 → 新）
| 段 | 旧（Build306） | 新（STR-001） |
|---|---|---|
| 入力 | `telemetry_live` を受信 | 同じ。加えて `maybeUpdatePitStrategyCompare` が **Lap更新ごと**に再計算（毎frameではない） |
| 質問 | `sendMsg` → `local-intent-router`：`strategyCallAnswer` が**固定応答で終端**（実測：「現在の戦略候補の計算根拠を確認できない。」） | 有効な計算パケットがあれば `{handled:false,passthrough:'pit_strategy_compare'}` で**LLMへ渡す** |
| 送信 | `chatBody` に計算パケット無し | `pitStrategyCompare`（race/session/Lap/計算版が今と合う時だけ） |
| サーバ | 戦略質問は固定の復帰/校正応答（`sendGuardReply`）で終端 | `validatePacket`（canonicalな `raceContext.race_identity` と照合、fail-closed）→ 通れば固定応答を見送り、`buildSystem` の `profileNote` へ `PIT STRATEGY COMPARE` ブロック（§24.10の指示文＋パケット）を追加 |
| 返答 | LLMが数値を作ると Truth Gate が止める | Truth Gate は**送ったパケットに載る数値だけ**を許す（`numberSet`/`maskPacketNumbers`）。パケットに無い数値は従来どおり止める |
| 訂正 | なし | `notePitCompareOpinion`：「前に詰まってる」「ペースが厳しい」「前の車が入った」「アンダーカットは嫌」を **driver_declared の仮定**として記録→再計算→新しい計算版。Plan操作の発話（command）は仮定にしない |
| 採用 | 既存のPlan/ACK | 変更なし（提案は既存Planを上書きしない。採用は既存経路） |

## 5. 手計算対照（`tests-str001-compare.js` H1〜H4、合成）
1. 通常案 自車102秒・相手100秒・現GAP0 → GAP **+2**。早ピット案 自車99秒 → **−1**（通常案より3秒良い）。
2. 早ピット案だけに復帰交通4秒 → 103秒、GAP **+3**。通常案が優位へ反転（推奨：早ピット→通常）。
3. 延長案の停止前残燃料0.6L、次周消費1.0L＋予備0.2L → 余裕 **−0.6L** → 候補外（`fuel_insufficient_to_reach_pit`）。
4. 逆転に2秒必要・比較まで2周 → 基準平均より **1.0秒/Lap** 速い（基準100なら99.0）。
加えて合成の交通反転（T3〜T6：車Vの直後に復帰＝rel 2.5秒・交通損失1.5秒、通常案だけが交通を受けると推奨は under1、under1にも車列が増えると通常案へ戻る）。

## 6. 保存レース再生（Lap4〜13）
各Lapの結果（`tools`で生成、raw=`pitwall-local-evidence/str001-v1-20261104/round4/replay-table.md`）：

| Lap | 観測(燃料L/順位/前GAP/後GAP) | 基準案(出所) | 推奨(基準比の改善秒) | 感度 k=0/0.03/0.045 | 条件付き | 判断期限 | 除外 |
|---|---|---|---|---|---|---|---|
| 4 | 42.2/23/5.36/11.66 | 14周/41.5L(provisional_even_split) | over2(2.49) | normal/over2/over2 | true | 15 | under3:1停止で完走不可 under2:1停止で完走不可 |
| 5 | 39.2/19/1.33/5.64 | 14周/41.3L(provisional_even_split) | over2(2.478) | normal/over2/over2 | true | 15 | under3:1停止で完走不可 under2:1停止で完走不可 |
| 6 | 36.1/19/0.7/5.87 | 15周/44.4L(provisional_even_split) | over1(1.332) | normal/over1/over1 | true | 15 | under3:1停止で完走不可 under2:1停止で完走不可 over2:燃料不足 |
| 7 | 33/19/0.49/6.46 | 15周/44.3L(provisional_even_split) | over1(1.329) | normal/over1/over1 | true | 15 | under3:1停止で完走不可 under2:1停止で完走不可 over2:燃料不足 |
| 8 | 29.9/18/6.81/3.53 | 15周/44.2L(provisional_even_split) | over1(1.326) | normal/over1/over1 | true | 15 | under3:1停止で完走不可 under2:1停止で完走不可 over2:燃料不足 |
| 9 | 26.9/18/6.08/4.3 | 15周/44L(provisional_even_split) | over1(1.32) | normal/over1/over1 | true | 15 | under3:1停止で完走不可 under2:1停止で完走不可 over2:燃料不足 |
| 10 | 23.7/18/9.1/5.65 | 15周/44L(provisional_even_split) | over1(1.32) | normal/over1/over1 | true | 15 | under3:1停止で完走不可 under2:1停止で完走不可 over2:燃料不足 |
| 11 | 20.6/17/4.48/6 | 15周/43.9L(provisional_even_split) | over1(1.317) | normal/over1/over1 | true | 15 | under3:1停止で完走不可 under2:1停止で完走不可 over2:燃料不足 |
| 12 | 17.5/17/5.08/6.2 | 15周/43.8L(provisional_even_split) | over1(1.314) | normal/over1/over1 | true | 15 | under3:1停止で完走不可 under2:1停止で完走不可 over2:燃料不足 |
| 13 | 14.4/16/7.86/0.36 | 15周/43.7L(provisional_even_split) | over1(1.311) | normal/over1/over1 | true | 15 | under3:過去周 under2:1停止で完走不可 over2:燃料不足 |

Lap4〜13で比較成立（Lap2〜3は総周回・ペースが未観測で比較不成立と返す）、基準案16周（予備燃料を切らない最終周。燃料重量[assumed]が効くため、交通が無ければ基準案が最良＝推奨は通常案・改善0）、over系は燃料不足、under3は1停止で完走不可（タンク53L）。**実際のドライバーは13周でピット**（検証側のみ・合否に使わない）。

## 7. 未修復・未検証
- **相手のピット観測**：Bridgeの`competitors[].on_pit`（＋`on_pit_frame`＝`telemetry_live.source_frame_sequence`と同じ式、`on_pit_observed_at`、車IDは`car_idx`）を追加した（§9）。**実Bridge/実iRacingでの値は未検証**（偽の配列で式を評価しただけ）。実走までは相手の停止はDriver申告（別経路）でしか入らない可能性が高い。
- **交通急変での再計算**：しきい値なしの代理として「前後の最も近い車の顔ぶれが変わった／相手のピット状態が変わった」時に同Lapでも再計算する（W1）。ギャップの大きさの急変は閾値が要るため実測まで置いていない。
- **能動提案トリガー**（推奨が変わった時にLUNAから話し始める）、IN/OUTラップ即応、ピットなしスプリントは未実装。
- 異クラス/周回遅れ：`class_rel`は常に`same`で、速いクラスの接近は計算に入らない。
- 実LLMの意味（Truth Gateは「数値が役割別にパケットにあるか」まで。その数値をその条件で言っているかは保証しない）、実音声、実Bridge、実Electron、Windows、実走は未検証。
- **Truth Gateは「同じ役割内の取り違え」を止めない**：例「残り燃料は14.5リットル」（14.5は追加給油量）、「ピットロスは2秒」（2はGAPの値）はpassする（litre／秒の集合が項目別に分かれていないため。文脈語＝残燃料／追加給油／ピットロス／GAP と項目別集合の対応づけで狭められるが未実装）。全角数字（「１４周」）は旧gateからある既存の穴で今回の後退ではない。
- サーバー検証の限界：`calc_id`は内容hashと照合する（改ざん/手書きは拒否）が、パケット内の自由文（`driver_assumptions[].text`等）はクライアント由来でsystem promptに入る。`profileNote`自体が元々クライアント由来なので新種の危険ではないが検証の限界。`current_facts`が無い（Lap不明）時はパケットを受け付けない（fail-closed）。
- 予備燃料・本線同区間通過時間・相手ペース・燃料重量係数・交通の窓3秒/抜き去り1.5秒・同点0.1秒は assumed（実測まで確定値にしない）。

## 8. 費用への影響（AGENTS費用規則：実装前に効果を特定、残る未測定を記録）
- **LLM呼出しの増加と上限**：従来、戦略相談はrouter/serverの決定論応答で**LLMを呼ばなかった**。今版は計算パケットが有効な戦略相談が**1 Driverターンにつきパケット付きLLM 1回**（初版の暫定上限。同じターンの2回目以降はパケットを載せない＝テストL1）。周回・顔ぶれの更新はローカル計算でLLMを呼ばない（L4）。Driverの訂正は新しいDriverターンとして再計算し、そのターンで1回。**記録**：rendererが`PIT_COMPARE_LLM`（turn・calc_id・呼出し回数・応答時間ms・返答長、L2）、serverが`[pit_compare] usage`（入力/出力token・cache read/write・ms、L3）。実API費用（円/ドル）は未測定で、実API評価の費用承認は別途。
- **1回あたりの増分**：計算パケットの塊は約2.7k字（前版 約4.8k字から削減。日本語主体で概算 約1.5〜2k token）。戦略相談でないchatには載せない（テストC2）。
- **キャッシュ**：塊は`cache_control`付きのprefix（キャラ固定部分）ではなく、**非キャッシュの別systemブロックとして末尾**に付ける（テストC1）。毎Lap・毎訂正で変わってもprefixのキャッシュ書込みを増やさない。ただし`profileNote`自体が元々prefixに入っており毎回変わるか（既存のキャッシュ有効性）は**未測定**。
- 実API費用の実測は未実施（有料APIは使っていない）。実運用の1相談あたり費用は、実LLMでの連続相談検査（補佐Codex・予算承認後）で測る。

## 9. Bridge `competitors[].on_pit` の契約と出荷への反映
- **契約**：`on_pit`＝true（ピットレーン上）／false（コース上）／**null（不明＝配列が取れない・範囲外・想定外の値）**。`on_pit_frame`＝同じ`telemetry_live`の`source_frame_sequence`（同一frame・同一session）、`on_pit_observed_at`＝観測時刻（epoch秒）、車ID＝`car_idx`。**不明はfalse（入っていない）にしない**。Driver申告はBridgeに入れない（Desktop側の別経路`declared_pit`）。
- **Desktopの使い方**：`on_pit===true`かつ`on_pit_frame`が現在のtelemetry frameと一致する時だけ「観測」。frame欠落・古いframe・null・欠測は「不明」で、観測にも「入っていない」にもしない（テストW5u）。観測が来れば前後の顔ぶれと同様に再計算の契機（W5）。
- **検査**：`irsdk-bridge/tests_str001_competitor_on_pit.py`（実ソースの式を偽の配列で評価：true/false/不明・範囲外・想定外の値、frame式が`telemetry_live`と同一、申告をBridgeに入れない）。変異で `int(..) in (0,1)` を外すとRED、`on_pit_frame`を外すとRED。
- **出荷対象への反映（既存workflowの発火を前提にしない）**：
  - `bridge.py`の変更は**Bridge exeのbuild対象**（`build-bridge.yml` pathsは`irsdk-bridge/*.py`を含むが、publishは`workflow_dispatch`の`publish=true`のみ）。Desktop側の`renderer.html`・`pit-strategy-compare.js`・server.jsの変更と**同じ出荷単位で揃える**必要がある（Desktopだけ出すとon_pitは常に欠測＝不明、Bridgeだけ出すと無害）。
  - `bridge.py`の`BUILD_VERSION`（現在 "Build 306 …"）とdesktopのbuild番号の更新、公開は**出荷ゲート（Gate 0–5/9）とOwnerのBuild/公開GO**のあとで行う。今回は行っていない。
  - `ci/runtime_coverage.py source/workflows` は新moduleを含めて通る（renderer scripts 30、smoke 32/32、workflows ok）。server.jsは`desktop/pit-strategy-compare.js`をrequireするため、**サーバ（Railway）の出荷にもこのmoduleが必要**（リポジトリ丸ごと配備のため同梱される。`verify-deploy.sh`のSHA一致で確認する）。
  - preflightに追加済み（py_compile＋上記Pythonテスト）。

## 10. U1 全車snapshot（設計§24.14）— 記録・受信（計算はしない）

**目的**：ピット復帰先の前後車列（全車の位置・クラス・周回・ペース・ピット状態）を、後から再計算・検証できる形で記録し、同じ内容をRendererにも送る。U2以降（復帰位置・燃料・ペース推定）の入力になる。

**足したもの**
| 層 | ファイル | 内容 |
|---|---|---|
| Bridge | `irsdk-bridge/field_snapshot.py`（新規） | `build_snapshot`（純関数）／`diff_events`／`FieldRecorder`（別スレッド＋有界キュー・回転・間引き・硬上限）／`FieldPipeline.step`／`parse_log` |
| Bridge | `irsdk-bridge/irsdk_mem.py` | `get_buf_slot`（最新スロットとそのtick位置） |
| Bridge | `irsdk-bridge/bridge.py` | `IRacingReader.read_field_arrays`（**1スロットから宣言型どおりに全配列を読み、最後にtick再確認**。変わっていたら再試行→3回失敗で`consistent=False`）／pipeline生成／pollへ1回の`step`呼出（try/exceptで囲み、失敗しても以降の処理は続く）／`ACTIVITY_ALLOWED_META_TYPES`へ`field_snapshot` |
| Bridge検査用 | `irsdk-bridge/replay_harness.py` | `FakeReader.read_field_arrays`、保存先は一時フォルダ |
| Desktop | `desktop/field-snapshot.js`（新規・`PitwallFieldSnapshot`） | 検証`check`／受信`createReceiver`（許可リスト・重複/逆戻り・期待セッション照合・古さ）／`parseLog` |
| Desktop | `desktop/renderer.html` | `type==='field_snapshot'`を検証・保持するだけ（会話・音声・戦略計算には渡さない）。`currentFieldSnapshot(expect)` |
| Desktop | `desktop/main.js` | Bridge起動時に環境変数`PITWALL_FIELD_LOG_DIR`(=Desktop/OMORAY-field-logs)・`PITWALL_FIELD_LOG_STAMP`を渡す。診断エクスポートに記録ファイルの名前と大きさを載せる（本文は載せない） |

**契約**
- 1 snapshot＝1世代。世代が混在／保証できない時は`ok:false`（`gen:'mixed'|'unverified'`）で**記録はするが、送信せず、受信側も採用しない**。
- 未知値は`null`。**離脱車**（TrackSurface=-1）は`st:'out'`で値を持たず、**欠測**（配列が取れない・範囲外）は`st:'missing'`。件数`counts{target,observed,departed,missing}`で区別。
- 個人名・認証値は入れない（car_idx・ゼッケン・class_idのみ）。許可リスト外のキーを含むメッセージは受信側が丸ごと拒否。
- 頻度：1Hz＋イベント（新しい周回・ピットIN/OUT・車の出入り・session/epoch境界）。各行に`sample_interval_s`。**1Hzの標本から精密なピット停止時間を実測したとは言わない**（精度＝標本間隔）。
- 記録先：`Desktop/OMORAY-field-logs/OMORAY-field-<起動stamp>-pNN.jsonl`（Desktopデバッグログと同じstamp）。1ファイル8MB回転・1実行80MBで周期記録を間引き（イベントは残す）・128MBで停止（**冒頭は消さない**）・過去30ファイルまで保持。診断エクスポートは名前と大きさの一覧を載せる（本文はファイルを回収）。standalone起動時は`%APPDATA%/OMORAY-PITWALL/field_logs`。`PITWALL_FIELD_LOG=0`で無効。
- 記録失敗・容量不足・書込み詰まりは**poll（安全コール）を待たせない**（有界キュー`put_nowait`、満杯は捨てて数える／書込み5連続失敗で記録だけ停止／送信は記録と独立）。

**検査（実行した範囲）**
- Python `tests_u1_field_snapshot.py` 28件（実`IRacingReader.read_field_arrays`＋独立に書いた共有メモリ画像／実`poll_iracing`再生／実ファイル記録／上限・回転・失敗・詰まり）
- Node `tests-u1-field-snapshot-e2e.js` 39件（実bridge→実ファイル→**実renderer(jsdom)の実`irBridge.onmessage`**→`parseLog`読み戻し一致、偽造13種拒否、重複/逆戻り、Bridge再起動(seq=1)、期待セッション/古さ、旧renderer無害）
- 変異試験 `tools/u1-mutate.py`：初回20件中2件生存（検査の穴）→検査を足して全件検出。最終 **22/22検出**
- 測定 `tools/u1-measure.py`（合成26台/40台）：
  - ログ量：26台 **3.5KB/行**（1Hz）→45分 **9.6MB**／3時間 **38MB**（イベントは同じ行に合流。重複行0）。40台 5.2KB/行。WS **4.3KB/秒**（26台）
  - CPU：記録ON−OFFで**1フレーム +0.84ms**（replay、FakeReader。実reader/実機は未測定）
  - 安全コール配送：`clean_laps(30)`の全broadcast（field_snapshot除く）が **旧Build306／新OFF／新ON／新ON＋書込み詰まり で4者とも同一**（所要msと乱数IDだけ除外して比較）。poll所要は書込みが詰まっても変わらない（1.201s vs 1.224s）。旧treeの最大フレーム51msは初回の外れ値で、新の方が悪化した値ではない。

**未検証・既知の限界（実走前に消えない）**
1. **実iRacing・Windows exe・実Electron(main.js)の値は未検証**。`read_field_arrays`の世代検証は「コピー後に同スロットのtick再確認」というiRSDKの一般的な読み方に倣ったもの（公式仕様書ではなくコミュニティ資料ベース）で、独立に書いた共有メモリ画像でのみ確認。main.jsの環境変数受け渡し・診断エクスポートは構文確認のみ（Electronを起動していない）。
2. **既存の`read_int_array('CarIdxOnPitRoad')`は、SDKの宣言型(bool=1バイト/要素)を無視して4バイト/要素で読む**（検査で再現：車3だけピットでも車0の値が非0）。STR-001で足した`competitors[].on_pit`（同じ読取を使用）は**実走で誤りうる**。U1のsnapshotは宣言型どおり読むため影響しない。実走ログで`on_pit`とsnapshotの`pit`を突き合わせて確認する。
3. 実走の車数・配列長（64）・`CarIdxF2Time`のレース中の意味（0.0の扱い）は未確認。F2Time/EstTimeは**rawのまま記録**し、意味づけはU2以降。
4. 強制終了時は、直近の最大0.5秒分（20行）が未flushで失われうる。記録停止（`write_failed`/`run_cap`）後は再起動まで再開しない。
5. 時間精度は1Hz標本間隔。ピット停止時間・周回境界の通過時刻はこのままでは±1秒。イベント行で周回変化は検知するが、実測の精度は別途。
6. 本機能は**Bridge＋Desktopの両方**が入って初めて受信まで通る（旧Desktop＋新Bridge＝無害に無視／新Desktop＋旧Bridge＝受信なし）。サーバ(Railway)は変更なし。

**出荷単位（計測用候補はU1のみ）**
- U1だけを基準(Build306 `896f47d`)へ移植した候補を `tools/u1-make-candidate.py` で作れる（STR-001の戦略変更・server.js・router・on_pitを含まない）。出荷対象：`irsdk-bridge/{field_snapshot.py,bridge.py,irsdk_mem.py}`＋`desktop/{field-snapshot.js,renderer.html,main.js}`。Bridge exeとDesktopを**同じ出荷単位**で揃える（`build-bridge.yml`/`build-desktop.yml`は`workflow_dispatch publish=true`のみで公開）。Build番号更新・公開はOwnerの個別GOのあと。**今回Build・公開は行っていない。**

### 10.1 検査Claude差戻し（R1〜R3・R5）への対応（2026-11-08・再回覧版。上の§10の数値は初版、最終はここ）
| 指摘 | 対応 |
|---|---|
| R1 session切替直後に旧名簿・旧race idが付く | 名簿はSessionInfo解析のたびに**作り直し**（`roster_from_drivers`）、解析時の`SessionNum`を`roster_session_num`として各snapshotに載せる。`session_num≠roster_session_num`（または名簿未取得）の間は`gen:'identity_stale'`・`ok:false`＝**記録のみ・送信せず・受信側も拒否**（受信側は`roster_session_num`と`session_num`の不一致を、genを偽装されても独立に拒否）。sessionInfo再読込のタイミング（約10秒ごと）は既存挙動のため**変えていない**（再読込を早めると既存の状態リセットの時期が変わる）。切替後、名簿が新しくなるまでの行は有効観測として出ない |
| R2 ペースカー・観戦者が競技車と区別できない | 各車に`r`（`car`/`pace`/`spec`）。`counts.target/observed/departed/missing`は**競技車のみ**、`counts.other`が競技車以外。イベント（car_join/leave・pit等）も競技車だけ。受信側は`r`と件数を検証 |
| R3 宣言型・要素数 | ①最初の読取で`SDK TYPE DIAG(field): CarIdxOnPitRoad=type1/count64, …`を既存デバッグログへ1回、各ファイルのヘッダ行に`declared_types`。②変数ヘッダの要素数が64未満ならその分だけ読み、残りは欠測(null)。隣の変数は読まない |
| R5 同stampで再起動 | 既存ファイルへ追記せず、次の空き`pNN`から開く |
| R4（記録・引継ぎ） | 既存`read_int_array('CarIdxOnPitRoad')`の読取修正は**U1に混ぜていない**（別単位・旧新replay比較つきで監督判断）。STR-001側`on_pit`は修復残件のまま |
| R6（注記） | 60台超・3時間超ではソフト上限(80MB)で**終盤の周期記録が1/5に間引かれる**（イベント行は残る）。40台3時間で約58MB |

**再検査結果**：Python 38件／Node E2E 51件／変異**33件中33件検出**／独立検査t1・t6・t8・t9・t10（検査Claudeの道具を新契約に合わせて再実行）全合格／source preflight全合格（worktree最終・U1のみの候補treeの2本とも exit 0）。候補差分 `u1-only-r2.patch` `cfd446ddfd5ae3fe`（15ファイル、STR-001の戦略変更なし）。
**新たな未検証**：名簿の旧新判定は`SessionNum`で行う。同じ`SessionNum`のまま参加者だけが入れ替わる場合（SessionInfo再読込まで）は検出できない（`race_instance_id`も再読込まで同じ）。実走で名簿更新の遅れ（実測の秒数）を`SESSION INFO DIAG`と突き合わせる。

### 10.2 検査Claude再検査の差戻しR7（同SessionNumで名簿/raceが変わる・YAML更新の遅れ）への対応
**仕組み（`RosterTracker`、`field_snapshot.py`）**：名簿・`race_instance_id`・解析時の`SessionNum`・SessionInfo更新番号（共有メモリheader offset 12）を**同じ解析1回分**として持ち、いまのものと確認できる時だけsnapshotを有効にする（`identity_stale`は記録のみ・送信せず・受信側も拒否）。
1. 名簿のSessionNumがいまのSessionNumと同じ。
2. 更新番号が読めるなら、名簿を読んだ時の番号＝いまの番号。違えば**その場で名簿とrace idだけを読み直す**（番号→YAML→番号の2回読みが一致した時だけ採用。既存の約10秒ごとのSessionInfo解析・状態リセットには触れない）。読み直せなければ未確認（1秒おきに再試行）。**snapshotのrace idも名簿と同じ解析から取る**（以前は別経路で旧いまま残り得た）。
3. SessionNumが変わった後は、**更新番号がその時点より進んだ後に読んだ名簿だけ**を信用する（YAML更新がSessionNumより遅れても、旧YAML＋新SessionNum印を新セッションとして採らない）。番号が進まなければ30秒で打ち切り、診断ログを1回出す（番号が先に進んでいた／offset 12が更新を反映していない場合に、記録を止め続けないため）。
4. **更新番号が読めない（None）場合は2・3を使わず、SessionNum規則だけに縮退**（全車staleにはしない）。ログに1回出す。
- 診断：`FIELD ROSTER: via=parse|refresh sessionInfoUpdate=… session_num=… race=… cars=…`（内容が変わった時と60秒ごと）、ヘッダ行と各行に`roster_update`。

**検査**：Python 56件（`RosterTracker`純ロジック9・2回読み補助3・実reader header offset 12・実`poll_iracing`の統合6）／Node E2E 52件／変異**44件中44件検出**（R7追加：番号不一致の読み直し・番号前進待ち・打ち切り・縮退・2回読み・再試行間隔・race id・roster_update・offset位置・confirmed）／検査Claude道具 `insp_u1_r2.py` 全合格／source preflight全合格（worktree最終・U1のみ候補tree）。候補差分 `u1-only-r3.patch` `1f702690c97e5640`。

**B2・Cの結果（検査Claudeの再現条件）**：Cは**旧名簿の有効行0**（SessionNum不変でも、番号が増えた同じステップで名簿とrace idが新しくなる）。B2は、YAML（と更新番号）がSessionNumより**実時間で約22秒遅れ**て再解析がその区間に当たる条件で**旧名簿の有効行0**。

**残る限界（隠さない）**：①YAML更新の遅れが**打ち切り30秒を超える**場合は検出手段がなく旧名簿の行が有効として出る（再現：遅れ約160秒相当で50行。診断ログは出る）。これは「YAMLもその更新番号もまだ変わっていない間」を観測する手段が現状のSDK情報に無いため。②更新番号が**SessionNum変更の観測より先に進んでいた**場合、新セッションの最初の最大30秒はstale扱いで記録のみになる（名簿は正しいが確認できないため。レース直前の切替では実害小）。③**offset 12が更新番号であること自体は実走未確認**。実走の`FIELD ROSTER`ログ（番号が変化するか、SessionNum変更後に進むか）で確定する。④番号が結果更新などで頻繁に増える場合、増えるたびに名簿を読み直す（合成で1回約2〜5ms。実機の負荷は未測定）。

**10.2 追記（検査Claude U1-only-r3 限定合格の条件1・3を反映。パッチ`1f702690c97e5640`は変更なし）**
- ⑤ **H1（更新番号は「名簿が新しい」ことの証明ではない）**：SessionNumがテレメトリで先に切り替わり、YAML（名簿）の更新が遅れている区間に、**名簿と無関係なSessionInfo更新**（結果表の更新など）で番号が1つ増えると、旧名簿が「番号が進んだ後に読んだ名簿」と扱われ、**旧名簿の行が有効（ok:true）で送信・記録されうる**（検査Claude再現：10行）。更新番号は「YAMLが変わった」ことの証拠であり、「名簿が新しくなった」ことの証拠ではないため、現状の仕組みでは区別できない。影響は、YAMLの遅れが実際に数秒以上あり、その間に無関係な更新が入る場合に限る（遅れの実長は未確認）。閉じる候補：YAML自身が持つ現在のセッション番号を名簿の印に使う（実YAMLにあるか未確認。実走の`FIELD ROSTER`ログにYAML側の値とテレメトリのSessionNumを並べれば確定できる）。**未修正のまま出荷判断に出す。**
- ⑥ **縮退中（更新番号が読めない）**：SessionNum変更後、既存の約10秒ごとのSessionInfo解析が来るまで最大約10秒は、記録のみで送信されない（保守側の挙動）。
- 推奨（次にコードを触る時にまとめる。今回のブロックにしない）：60秒ごとの`FIELD LOG stats`に`RosterTracker`の`refreshes`・`refresh_failures`・`fail_open_count`を足す（現状はどこにも出ず、実走で番号の増加頻度と再読込の負荷を確定する手段がない）。検査Claudeが挙げた「10秒解析経路の2回読み一致」を検出するPythonテストの追加も同時に行う。

### Build前確認（U1-only候補・Build 306基点）— 作業メインClaude 2026-11-12
監督Codexの依頼（対象SHA／同梱Bridgeと単体Bridgeの範囲／パッケージ設定とworkflow／R4の波及）への作業者側の回答。**Build・push・commit・公開はしていない**。独立確認（Gate 4）はまだ揃っていない。

| 項目 | 確認結果 |
|---|---|
| 基点 | `896f47d`（Build 306 field conversation continuity候補）。`bridge.py` `BUILD_VERSION`＝Build 306、`desktop/build-info.json`＝buildNum 306 |
| 候補の中身 | 基点＋`u1-only-r3.patch`（ファイルsha256先頭16桁 `1f702690c97e5640`）。`tools/u1-make-candidate.py`で作り直した木が「基点＋同パッチ」と**全ファイル一致**（`diff -rq`差分なし）。STR-001の戦略変更（`server.js`・`local-intent-router.js`・`pit-strategy-compare.js`・`on_pit`修正）は**含まれない** |
| 主要ファイル（sha256先頭16桁） | `field_snapshot.py` `6b598766713c44e0`／`bridge.py` `dc868128f0f12bbb`／`field-snapshot.js` `7a2b63e6ac4a419d`／`renderer.html` `69c105fc23ce3d99`／`main.js` `374e89f4ce4db363` |
| 既存コードへの変更量 | `bridge.py` +130 −0／`irsdk_mem.py` +14 −0／`renderer.html` +7 −0／`main.js` +20 −2（Bridge起動の2行に環境変数を足しただけ）／`replay_harness.py` +62 −1（検査用）／`preflight.sh` +5 −1／`ci/tests_preflight_gates.py` +1 −1。製品コードで**消した行は`main.js`のspawn 2行のみ** |
| **対象SHAの不在** | 候補は**未commit**（作業木の差分から作った木）。CIは`github.sha`をcheckoutするため、Build前に「`896f47d`から切った専用ブランチへU1ファイルだけを1 commit」が必要。これはcommit／pushのGOが要る。作業木`str001-work`にはSTR-001差分も同居しているので、作業木をそのままcommitしてはいけない |
| Build番号 | 候補は**Build 306のまま**（番号を上げていない）。private検査には支障ないが、利用者への更新判定は`buildNum`比較なので、公開するなら307以上が必要。番号を上げるかは監督／Owner判断（`bridge.py` `BUILD_VERSION`と`build-info.json`の一致検査は`ci/runtime_coverage.py`が行う） |

#### Desktop同梱Bridgeと単体Bridgeの範囲
- **同じソース**：どちらも`pyinstaller --onefile ... irsdk-bridge/bridge.py`で作る。`field_snapshot`は`bridge.py`の静的importなので同梱される。`ci/runtime_coverage.py source --require-workflows`は候補木で合格（ローカルモジュール33個に`field_snapshot`を含む、renderer script 30、workflow契約ok）。**packaged EXEの検査（同梱EXEが実際に`field_snapshot`を含むか）はWindows CIでしか確認できない**。
- **Desktop版**：`main.js`が`PITWALL_FIELD_LOG_DIR`＝`デスクトップ/OMORAY-field-logs`をBridgeへ渡す。Bridgeが記録し、WebSocketで`field_snapshot`を送り、rendererが`field-snapshot.js`で検証して保持する。記録の出口と受信の出口の両方が動く。
- **単体Bridge版**：環境変数が無いため既定保存先は`<設定フォルダ>/field_logs`。**記録は既定で有効**（`PITWALL_FIELD_LOG=0`で無効化可）。受信するrendererが無いので、WebSocketへ送る分は誰も使わない。`installer.iss`は変更していない。
- **U1の計測にはDesktop版だけで足りる**。単体Bridgeの再ビルドは必須ではない（`bridge-latest`は`publish=true`にしない限り触れない）。単体版も候補に含めるかはOwner／監督判断。

#### パッケージ設定とworkflow
- `desktop/package.json`は**変更なし**。`build.files`が`"*.js"`で`field-snapshot.js`を取り込む。renderer.htmlが参照するローカルJS 30本は`desktop/`に全て存在（欠落なし）。
- `.github/workflows/*`は**変更なし**。`build-desktop.yml`／`build-bridge.yml`は`desktop/**`・`irsdk-bridge/*.py`・`ci/**`のpushで**自動起動**する（ブランチ指定なし）。公開はどちらも`workflow_dispatch`かつ`publish=true`のときだけで、push起動はartifact保存のみ（保持1日）。**候補ブランチのpushは、事実上privateビルドの起動でもある**ので、push GOとBuild GOは同時にOwnerへ確認する必要がある。`build-store-msix.yml`は手動のみ。
- 候補木の`./preflight.sh`を再実行：**rc=0、✅150／❌0**（Python 56件OK、U1 E2E 52件＝旧Build 306木を`FIELD_OLD_ROOT`で指定したD1を含む。旧木が無いとD1は「未実施」と表示される）。実asarの検査（renderer全script在中・故意欠落RED）も合格。証跡：`pitwall-local-evidence/str001-v1-20261104/u1/candidate-r3-preflight-recheck-20261112.txt`、`runtime-coverage-source-20261112/`。

#### R4（`CarIdxOnPitRoad`のint読み）の波及
- 既存の呼び出し2か所（基点`bridge.py` 5574行・7896行→候補 5689行・8032行）と`read_int_array`本体は**1行も変えていない**。U1は別メソッド`read_field_arrays`で宣言された型（boolは1バイト）で読む。**候補は既存の読み方を、バグも含めてそのまま保つ**（R4は別単位）。
- 旧Build 306／新（記録なし）／新（記録あり）／新（記録あり・書込み詰まり）の再生比較：安全コール側の**非field送出324件・トリガー12件が4条件で同一**（`measure.json`の`safety_delivery`）。フレーム時間中央値11.0／10.5／10.7／10.5 ms。
- R4が影響する既存機能（変えていない）：`rival_pitted_first`、リーダーピットのguard、近接車の`on_pit_road`、停止車のピット除外、STR-001の`competitors[].on_pit`。

#### 未確認／要判断
- 実iRacing・実Windows・実Electron・実WS・PyInstaller同梱の実物は**未検証**。offset 12（SessionInfo更新番号）が実SDKで正しいかも実走で確定。
- **作業木のgit参照が壊れている**：Desktopフォルダ移動で`.git`ファイルが旧パス`/Users/yuji.s/Desktop/Claude/...`を指す。commit前に`git worktree repair`が必要（.git内部の書換えなので、実行はGO待ち）。作業木の`node_modules`も不完全（メイン側の`node_modules`へ向けて検査した）。
- 判断を仰ぐ点：(a)候補ブランチ作成＋1 commit（commit GO）、(b)Build番号を上げるか、(c)単体Bridgeを候補に含めるか、(d)push＝Build起動を含めたGO。

## 11. U2/U3 後続のアンダーカット予測（設計§24.13）— 全車の復帰交通＋完走燃料＋給油後の共通地点

**作業メインClaude 2026-11-13。ローカル実装・offline検証のみ。Build・push・commit・有料API・公開はしていない。** 基点＝Build 307のU1記録（`a7e322e`）の内容＋STR-001試作（作業木`str001-work`）。実走（実iRacing・Windows）は未検証。

### 11.1 何を作ったか（Driverがまだピット周を選べるうちに、後続のアンダーカットを予測して提案する）
毎周、自車の「**今入る（この周の終わり）／次周に入る／燃料の限界まで待つ**」を比較する。**同クラスの後ろ2台が先に入る場合**（今周先／次周先／入らず引っ張る）も試算し、**復帰先の交通**と**完走燃料**を入れたうえで、**給油後の共通地点でどちらが前に出そうか**を案ごとに返す。相手の給油予定は仮定として扱い、**優劣が条件で変わる場合はその条件をLUNAに渡す**（`flips_when`／`rival_first_threats`／感度）。

| 層 | ファイル | 内容 |
|---|---|---|
| 計算（新規） | `desktop/undercut-forecast.js`（`PitwallUndercutForecast`） | `createTracker`（U1標本を時間順に受け、各車の最後に見えた位置・ラップタイム・ピットレーン通過を保持）／`buildView`／`compute`／`parseFocus`／`promptSlim`／`proposal` |
| 計算（既存を拡張） | `desktop/pit-strategy-compare.js` | `attachUndercut`（結果をSTR-001のパケットへ付け、calc_idを付け替え）／`packetUsable`／`validatePacket`（undercut節の検証：race/session/版/古いLap/出所ラベル/校正前の確率/見えていない車がいるのに「空いている」）／`numberSets`（undercutの数値を項目別に許可）／`hasUnobservedClearClaim`（返答の「空いている」断定を止める）／`promptBlock`（LUNAへのuc＋指示）／`parseDriverOpinion`（「じゃあ次周なら？」等＝焦点） |
| 入力・提案（renderer） | `desktop/renderer.html` | `onFieldSnapshotAccepted`（採用したU1標本をtrackerへ。ピットIN/OUTで同Lapでも再計算）／`buildUndercutSection`（U1の最新標本＋既存の燃料・燃費・ピット校正・総周回の入力＝`pitCompareInputFromLive`を再利用）／`maybeProposeUndercut`（走行中のLUNA提案：決定論の文面・LLM 0回・1Lapに1回）／Truth Gateに「空いている」断定の検査を追加 |
| サーバー | `server.js` | undercutだけが成立したパケット（`packetUsable`）も受理 |
| 検査 | `tests-u2-undercut-forecast.js`（49件）／`tests-u2-undercut-e2e.js`（46件）／`tools/u2-replay-suzuka.js`／`tools/u2-extract-suzuka-own.py`／`tools/u2-mutate.js`（変異26件）／`fixtures/u2/suzuka-own-inputs.json`／`fixtures/u2/fuji-gt-sprint-synthetic.js` | preflightへ2ステップ追加 |

### 11.2 計算の定義（手計算できる形）
- **進行量** `progress = Lap + LapDistPct`（周）。**GAPの符号＝自車の到達時刻 − 相手の到達時刻**（負＝自車が先）。
- **自車の3案**：停止は「Pの終わり」（ピット入口＝スタート/フィニッシュライン、実ログで確認：鈴鹿のピットレーン進入は進行量の小数が.99）。`now`＝この周の終わり、`next`＝次周、`limit`＝予備燃料(0.5L・仮定)を切らずに入れる最も遅い周（燃費の高い側で数える）。同じ周になる案は`same_lap_as`で畳む。指定周（「12周目に入ったら」）も評価できる。
- **完走燃料**：停止後に走る周数（総周回の高い側）×燃費(高い側)＋予備−入口の燃料＝給油量。入口に予備を残して届かない案は`fuel_insufficient_to_reach_pit`、給油してもタンクに入らない（追加停止が要る）案は`needs_extra_stop`で除外（追加停止のロスを足して比較する案は今回は作らず除外に統一）。燃料だけで完走できる時は`stop_required_for_fuel=false`（義務ピット規則は未確認と明記し、停止を促す提案は出さない）。
- **相手**：同クラスで自車より後ろ・同じ周内（0.5周以内。周回遅れは脅威にしない）の近い2台（観測または直近まで見えていた車）。想定は`stays_out`（入らず引っ張る＝Owner現場知見、後ろ最後の想定）／`pits_now`／`pits_next`（いずれも**assumed**）。**観測できるのは「今ピットレーンにいる」「ピットレーンに入って出た回数」だけ**。相手の給油量は自車「次周」案の量の0.7〜1.3倍（自車の量を一律に適用した仮定。assumptionsに明記）。
- **共通地点**：全候補と相手の想定停止が終わった後の最初のライン通過（候補間で共通）。`ownT=(C−p0)×L+停止損失+燃料重量k×給油量×(C−停止周−1)+復帰交通`、`rivT`も同じ形（**相手の復帰交通も同じ方法で入れる**）。k=0.03 s/L/周は未校正の暫定値（範囲0〜0.045）。
- **復帰交通**：復帰時刻・位置に、全車（観測した車／直近まで見えていた推測位置の車／見えていない車）を進めて前後±3.0sの車列を作る。遅い車・周回遅れ・遅いクラスの前に出れば通過コスト1.5s[0.5〜3.0]、速いクラスが後ろなら0.7s。**見えていない車は位置不明(一様分布を仮定)として期待値に入れ、観測した車だけの値を下限、期待値を中央、上限（期待+2σ）を範囲で返す。1台でも見えていなければ`clear_claim_allowed=false`＝「空いている」と言わない**（返答にその断定があればTruth Gateが止め、サーバーもclear=trueの偽造を拒否）。
- **判断**：相手が居れば「最悪の想定でのGAPが最小の案」、後続が見えない時は自車だけの共通地点までの所要時間（交通・燃料重量込み）。`flips_when`＝相手の想定ごとに最良案が変わる条件＋感度（燃料重量0／上限、通過コスト下限／上限）で結論が変わる条件。`rival_first_threats`＝後続が先に入る想定で自車が後ろへ回る案。**後続が見えない時は`rival_threat_assessed=false`と注意文**。成功確率は校正前のため出さない（null）。
- **LUNAへの渡し方**：STR-001のパケット(`pit_strategy_compare`)に`undercut_forecast`を付けて同じ経路（renderer→chat payload→server検証→system prompt末尾の非キャッシュ塊→Truth Gate）で渡す。Driverの「じゃあ次周なら？」「今入ったら？」「限界まで待つと？」「12周目に入ったら」「後ろが先に入ったら？」は`focus`（質問したLapの間だけ）として再計算し、新しい計算版(calc_id)で返す。走行中の提案は決定論の文面（LLM 0回、1Lapに1回、Driverの質問による再計算では話さない）。

### 11.3 入口→出口マトリクス（Tunnel Completion Rule）
|段|内容|状態|
|---|---|---|
|1 source|U1の全車標本（実Bridge→WS→`field-snapshot`受信）＋自車の燃料・燃費・ピット校正・総周回（既存）|接続済み。実U1ログ(鈴鹿)で検査。実Bridge/実iRacingは未検証|
|2 authority|採用した標本だけ（世代混在・別race/session・古い(8秒超)・時刻が戻る標本は不採用）。相手の給油予定は仮定、観測は「ピットレーンにいる/出入りの回数」だけ|接続済み（`tracker.update`／`currentFieldSnapshot(max_age)`）|
|3 state|`pitCompareState.packet`（calc_id付き）＋`undercutTracker`。別race/sessionで捨てる|接続済み|
|4 identity|race_instance_id・session_num・calc_id・car_idx/ゼッケン・標本のsession時刻|接続済み（サーバーが再照合）|
|5 decision|`undercut-forecast.compute`（毎Lap＋ピットIN/OUT）|接続済み|
|6 output|①走行中の提案（決定論・`speak` P3）②質問への返答（LLM 1回/ターン、Truth Gate）③「じゃあ次周なら？」の再計算|接続済み（保存応答で検査。実LLMの意味・実音声は未検証）|
|7 outcome/scoring|**未実装**：相手が実際に入った周・自車の実復帰位置と予測の差を比べる処理は作っていない（`PIT_COMPARE`/`UNDERCUT_FORECAST`の診断ログに予測だけ残る）|空欄＝未完成（U4〜U6）|
|8 correction|Driverの意見（交通・案の拒否）→仮定として再計算、焦点は質問したLapだけ、別session/古い標本は不使用|接続済み。**相手の停止申告（後ろが入った）はundercutの相手には未接続**（STR-001の相手用の経路のみ）|
|9 proof|手計算・実U1ログ再生・富士再現・実renderer/実server通し・変異試験|11.6参照|

### 11.4 鈴鹿 IMSA Fixed 決勝（実U1ログ `OMORAY-field-20261113-1039-p01〜p03.jsonl`、`sub:90078233` `session_num=2`）
- **入力**：実ログ3ファイルを実`field-snapshot.check`で読み戻し（決勝の標本2516件、不正行0、検証で弾いたのは`identity_stale`の1件）。自車(#15・車番idx22)の各Lap先頭の残燃料と残り時間は同日のBridge debug logから`tools/u2-extract-suzuka-own.py`で抜いた小さなfixture（`fixtures/u2/suzuka-own-inputs.json`。元ログsha256先頭16桁 `7b88a0a5ce3c39a6`）。**終了結果(eventresult)は計算に使っていない**。ピット作業は校正が無いので出所付きの暫定値（通過12s[8〜16]・固定10s[6〜14]・0.4s/L[0.3〜0.5]、assumed）。各Lapの計算は、そのLap先頭の標本までのU1標本だけをtrackerへ入れる（未来を使わない：C8/C9）。
- **見えた事実（実ログから）**：名簿50台（GTP 4029=10台、4011=40台）に対し、**同時に位置が取れたのは最大21台**（19〜21台が1916/2517標本）。決勝の間に50台全部が一度は見えたが、見える顔ぶれが入れ替わる（`car_join`317回・`car_leave`310回）。観測できた車は自車の**前方（進行量+0〜0.4周）に集中**し、自車の後ろはほとんど見えない（自車は総合38〜50位）。この理由（iRacingの`CarIdxTrackSurface=-1`の意味）は未確認で、**仮説にとどめる**。
- **帰結**：自車がピットで約24秒失って復帰する位置に居る車は「いま自車の約24秒後ろにいた車」だが、**そこがほとんど見えていない**。全Lap・全案で、復帰先の車列は**観測できた車0台分／推測位置37台分**。したがって**復帰区間を「空いている」とは一度も判定していない**（clear=false、`clear_basis=unobserved_cars_exist`）。交通損失は「観測だけの下限／期待値／上限」で返る（下表）。**後続（同クラス・同じ周内）は全Lapで観測できず、後続のアンダーカットは評価していない**と明示（`rival_threat_assessed=false`）。
- **Lap別の結果**（交通損失は 下限/期待/上限 [s]）：

|Lap|観測（推測・不明）|後続|推奨|今案|次周案|限界案|結論が変わる条件|
|---|---|---|---|---|---|---|---|
|5|21/50（推測位置3・不明26）|0|limit(15周)|0.0/0.8/5.8|0.0/0.8/5.8|0.0/1.6/5.8|燃料重量=0のとき→next/通過コスト=上限3のとき→next|
|6|21/50（推測位置4・不明25）|0|limit(15周)|0.0/0.8/5.5|0.0/0.8/5.5|0.5/1.2/5.6|燃料重量=0のとき→next|
|7|21/50（推測位置8・不明21）|0|limit(15周)|0.0/1.2/5.1|0.0/0.9/7.8|0.5/1.2/4.8|燃料重量=0のとき→next|
|8|21/50（推測位置4・不明25）|0|limit(15周)|0.0/0.9/7.0|0.0/0.9/7.1|0.0/1.1/5.9|燃料重量=0のとき→next|
|9|21/50（推測位置2・不明27）|0|limit(15周)|0.0/0.8/5.4|0.0/0.8/6.2|0.0/0.8/5.4|燃料重量=0のとき→next|
|10|21/50（推測位置4・不明25）|0|limit(15周)|0.0/1.3/5.0|0.5/1.2/5.2|0.0/1.5/5.5|燃料重量=0のとき→next|
|11|21/50（推測位置8・不明21）|0|limit(15周)|0.0/1.0/5.3|0.0/1.2/6.0|0.0/1.0/6.0|—|
|12|21/50（推測位置6・不明23）|0|limit(15周)|0.0/0.7/5.1|0.0/0.7/5.1|0.0/0.7/5.1|燃料重量=0のとき→next|
|13|21/50（推測位置9・不明20）|0|limit(15周)|0.0/0.6/4.6|0.5/0.6/4.6|0.5/0.6/4.6|燃料重量=0のとき→next|
|14|21/50（推測位置6・不明23）|0|now(14周)|0.0/0.7/5.1|0.5/1.1/5.1|-|通過コスト=下限0.5のとき→next|
|15|20/50（推測位置9・不明21）|0|now(15周)|0.0/0.7/4.9|-|-|—|
|16|21/50（推測位置14・不明15）|0|-|-|-|-|—|

  （推奨が`limit(15周)`になるのは、後続を評価できていない中で燃料重量(k=0.03 s/L/周・未校正)が「遅く入る方が軽い時間が長い」と効くため。ほぼ全Lapで「燃料重量=0なら次周案」という条件が付く＝**結論は未校正の係数に依存する**。Lap14は限界案と次周案が同じ15周になり「今(14周)」が推奨、判断期限14周。**実際のDriverは14周の終わりでピットに入った**（検証側の事実で、合否には使っていない）。Lap15は既に給油済みで燃料上は停止不要、Lap16は残り周が足りず除外。）
- **E2E（実renderer＋実server＋保存応答）**：この実ログを実`irBridge.onmessage`へ流し、毎Lap計算→Lap14の走行中提案（「ピット判断。いまの比較では今周(14周)に入る案が最もきつくない。後続の位置が見えていないので、後続のアンダーカットは評価できていない。復帰先は見えていない車がいるので空いているとは言えない。判断は14周まで。」、LLM 0回）→質問→「じゃあ次周なら？」（焦点=次周案15周・新しい計算版）→返答の数値がパケットと一致→「47秒」「復帰先は空いています」はTruth Gateが止める→偽造/古いパケットをサーバーが拒否、まで通した。

### 11.5 富士VRS GT Sprint（**Driver報告に基づく再現用の仮定＝合成**。実測ではない）
- **条件**（`fixtures/u2/fuji-gt-sprint-synthetic.js`の`ASSUMPTIONS`に全て記録）：40分・周回97s・燃費2.6L/周・満タン60L・総周回25（暫定）、自車は9周目頭の上位走行、後ろに#11が3.0s・#12が7.0s、前に20s/40sの車、同クラス後続集団8台は20〜50s後ろ。ピット＝通過12s＋固定10s＋0.4s/L、燃料重量0.03s/L/周。復帰先の「遅い車」はペース101sの別クラス（競争相手ではなく交通）。**全16台を観測できている前提**（見えていない車を足すと「空いている」と言えなくなることを別に検査）。
  - ⚠ Driver報告の具体値（実際のギャップ・周回・燃料）は指示書に無かったため、上の数値は再現用に私が置いた。**実報告があれば`CONST`/`ASSUMPTIONS`を差し替えて同じ検査で再確認する**。
- **ケースA「待つと逆転される」**（`wait_loses`）：遅い車の列が、次周案(4台)と限界案(6台)の復帰位置に居る。結果：推奨=今(9周)。後続#11が先に入る想定（今周／次周）では、**次周案は給油後に#11が約2.8〜3.0s前**、限界案も約3.9〜4.0s前で逆転される。今案は#11・#12のどの想定でも自車が前（−2.8〜−7.0s）。

|案|給油|交通損失 下限/期待/上限[s]|共通地点でのGAP（負＝自車が先）|
|---|---|---|---|
|今(9周)|給油5.5L|0.0/0.0/0.0|#11 入らず:-6.69▲自車<br>#11 今周先:-3▲自車<br>#11 次周先:-2.835▲自車<br>#12 入らず:-4.69▲自車<br>#12 今周先:-7▲自車<br>#12 次周先:-6.835▲自車|
|次周(10周)|給油5.5L|2.0/6.0/12.0|#11 入らず:-0.855▲自車<br>#11 今周先:2.835▼相手<br>#11 次周先:3▼相手<br>#12 入らず:1.145▼相手<br>#12 今周先:-1.165▲自車<br>#12 次周先:-1▲自車|
|限界(22周)|給油5.5L|3.0/9.0/18.0|#11 入らず:0.165▼相手<br>#11 今周先:3.855▼相手<br>#11 次周先:4.02▼相手<br>#12 入らず:2.165▼相手<br>#12 今周先:-0.145▲自車<br>#12 次周先:0.02▼相手|

  走行中の提案文（renderer実入口で発話）：「ピット判断。いまの比較では今周(9周)に入る案が最もきつくない。ただし後ろの11番が次周先に入ると、燃料の限界案だと給油後に約4秒前に出られる。判断は9周まで。」
- **ケースB「早く入ると交通で損をする」**（`early_loses`）：同じ遅い車の列(3台)が今案の復帰位置に居る。結果：今案は交通損失4.5s(1.5〜9.0)で、#11が入らない/今周先に入る想定で相手が前(+3.8/+1.5s)。次周案・限界案は交通なしで全想定で自車が前。推奨=限界(22周)。**ただし「燃料重量=0のとき次周案」と結論が変わる条件が付く**（未校正の係数に依存）。#11が今周先に入る想定では今案が相手に抜かれる（`rival_first_threats`）。

|案|給油|交通損失 下限/期待/上限[s]|共通地点でのGAP（負＝自車が先）|
|---|---|---|---|
|今(9周)|給油5.5L|1.5/4.5/9.0|#11 入らず:3.81▼相手<br>#11 今周先:1.5▼相手<br>#11 次周先:-2.835▲自車<br>#12 入らず:-0.19▲自車<br>#12 今周先:-2.5▲自車<br>#12 次周先:-2.335▲自車|
|次周(10周)|給油5.5L|0.0/0.0/0.0|#11 入らず:-0.855▲自車<br>#11 今周先:-3.165▲自車<br>#11 次周先:-7.5▲自車<br>#12 入らず:-4.855▲自車<br>#12 今周先:-7.165▲自車<br>#12 次周先:-7▲自車|
|限界(22周)|給油5.5L|0.0/0.0/0.0|#11 入らず:-2.835▲自車<br>#11 今周先:-5.145▲自車<br>#11 次周先:-9.48▲自車<br>#12 入らず:-6.835▲自車<br>#12 今周先:-9.145▲自車<br>#12 次周先:-8.98▲自車|

  この場面では提案を話さない（推奨が限界案で判断が遠く、先入れ脅威も今案だけ）。Driverが「今入ったら？」と聞けば、焦点=今(9周)で今案の内訳（遅い3台・交通損失・復帰先の車列）が新しい計算版で返る。

### 11.6 検査（実行した結果。実API・Build・Windows・実走は含まない）
|検査|結果|
|---|---|
|`tests-u2-undercut-forecast.js`（手計算A1〜A11・交通B1〜B8・鈴鹿実ログC0〜C10・富士D0〜D9・拒否/焦点E1〜E8b）|**49/49**。手計算＝次周案の給油14.0L・ピットロス27.6s・完走余裕0.5L、同時停止ならGAPは現GAPのまま(−5.0)、k=0.03で−5.42、相手が4s前なら+4.0（必要ペース4/9=0.444s/Lap）、相手の復帰交通で−5.0→−6.5、タンク25Lで今案は除外、残4Lで次周案は除外、0.6周後ろは脅威にしない|
|`tests-u2-undercut-e2e.js`（実renderer＋実server子プロセス＋保存応答。鈴鹿F/P/Q/R/G/O/S/V/C、富士FW/FE）|**46/46**。毎Lap計算・Lap14の走行中提案(LLM 0回)・質問・「じゃあ次周なら？」・「今入ったら？」・訂正・Truth Gate・古い標本・Lapずれ・サーバーの偽造拒否|
|変異試験 `tools/u2-mutate.js`（製品コードを1か所ずつ壊す25件）|**25/25を検査の❌で検出**。1回目は18件検出・6件生存で、検査の穴（空いている断定の止め方が他のgateと重なっていた／同じLapの提案抑止／Driverの質問での提案抑止／サーバーの受理条件／Lapずれ標本）を見つけて検査を足し、不要だったルーター変更（元から`handled:false`でLLMへ届く）は戻した。例外で止まっただけの検出は0件|
|既存の回帰 `tests-str001-compare.js`|72/72（STR-001の3案・手計算H1〜H4・交通反転は変わらない）|
|変異試験の最終（`tools/u2-mutate.js`・26件）|**26/26を検査の❌で検出**（焦点の判定を絞った後に再実行。例外で止まっただけの検出は0件）。証跡 `pitwall-local-evidence/str001-v1-20261104/u2/mutation-26.txt`|
|`./preflight.sh`（作業木 `str001-work`、基点896f47d＋STR-001＋U1＋U2・未commit）|**rc=0、✅157／❌0**。U2の2ステップ（49件・46件）と、WO020 runtime coverage（実asarに全renderer scriptが在る・故意欠落RED）を含む。環境の注意：作業木の`node_modules`が不完全なため、メイン側のnode_modules/desktop/node_modulesを指して実行した（検査後に作業木へ作ったsymlinkは削除）。証跡 `u2/preflight-worktree.txt`|
|既存回帰（個別に再実行）|`tests-str001-compare.js` 72/72、`tests-str001-entry-e2e.js` 53/53（E10＝同じLapの再質問で計算版が変わらない、を含む）|

### 11.7 費用（実装前の見積りと残る未測定）
- **LLM呼出し**：増えるのは「戦略相談(質問・「じゃあ次周なら？」・訂正)の1 Driverターンあたり、パケット付きLLM 1回」だけ（STR-001から変わらない上限）。毎Lap計算・ピットIN/OUTでの再計算・走行中の提案は**ローカル計算でLLMを呼ばない**（C2・P2で確認）。
- **1回あたりの増分**：undercutの塊は、鈴鹿Lap14で約1.75k字（slim JSON 1.33k字＋指示）、富士で約2.3k字（slim JSON）。日本語主体の概算で約1.2〜1.6k token。非キャッシュの別systemブロックの末尾に付く（prefixのキャッシュを増やさない。STR-001と同じ）。
- **CPU**：`compute`は鈴鹿で1回数ms〜十数ms（感度の再計算4回を含む）。毎Lapとピット状態変化時（2秒に1回まで）。実測のフレーム時間への影響は未測定（Windows実機）。
- 実API費用は未測定（有料APIは使っていない）。実運用1相談あたりの費用は、実LLMの連続相談検査（補佐Codex・予算承認後）で測る。

### 11.8 未検証・未実装・要判断（隠さず列挙）
1. **実iRacing・実Windows・実Electron・実音声・実LLMの意味**は未検証。Truth Gateは「数値が項目別にパケットにあるか」と「空いている断定」までで、その数値をその条件で言っているかの意味は保証しない。
2. **鈴鹿の結果の限界**：後続が見えないため、**後続のアンダーカット(今回の主機能)は鈴鹿の実ログでは評価できていない**。鈴鹿で検証できたのは「未観測車を空きと判定しない」「推測位置の扱い」「燃料・時間・交通の入力経路」まで。後続が見える実走ログ（自車が上位で、後ろが観測できる場面）が得られれば同じ計算で評価できる。見える顔ぶれが前方に偏る理由（iRacingの`CarIdxTrackSurface=-1`の意味）は**未確認の仮説**。実走で、見えない車が「コースに居るが報告されない」のか「実際に離脱」なのかを確かめる必要がある。
3. **富士の数値は私が置いた再現用の仮定**（Driver報告の具体値が指示書に無かった）。実報告の値が分かれば差し替えて同じ検査で再確認する。
4. **推奨が未校正の仮定に依存する**：燃料重量k(0.03 s/L/周)・通過コスト(1.5s)・相手の給油量(自車の量の0.7〜1.3倍)・ピット作業（暫定）。鈴鹿のほぼ全Lapで「燃料重量=0なら次周案」と結論が変わる（`conditional_on_assumed_costs=true`で明示）。校正はU4〜U6（実走で得たピット作業・ペース・停止周の実測）。
5. **相手の観測**：U1の1Hz標本から分かるのは「ピットレーンにいる」と「入って出た回数」だけで、**給油の有無・停止時間・給油量は分からない**（ドライブスルー・修理も区別できない）。相手の停止申告（Driver）をundercutの相手に反映する経路は未接続。
6. **タイヤ交換・インラップ/アウトラップの差・相手側の渋滞の完全な再現**は入っていない（相手の復帰交通は同じ方法で入れたが、相手の復帰後の追い抜きは入れていない）。ピット出口の位置は「スタート/フィニッシュライン直後」の仮定（コース別に未確認。ピット入口は鈴鹿の実ログで進行量.99＝ライン手前を確認）。
7. **出口側の未完**：outcome/scoring（予測と実結果の比較・次回補正）は未実装。`success_probability`は校正前なのでnull。
8. **義務ピットの規則**は未確認。燃料だけで完走できる時は`stop_required_for_fuel=false`と注意文を返し、停止を促さない。
9. **R4（`CarIdxOnPitRoad`のint読み）は触っていない**。U2は新しい宣言型の読み（U1）だけを使う。STR-001の`competitors[].on_pit`（Bridge側、R4の影響を受ける旧経路）とは独立。
10. 作業木のgit参照が壊れたまま（Desktopフォルダ移動）。今回の成果は**未commit**で、固定差分とhashを共有ログへ置く。Build・push・公開は個別GO。
11. **既存挙動への影響（監督判断を要する）**：全車snapshot(U1)が有効で`undercut_forecast`が成立していると、`currentPitStrategyCompare().valid`が真になり、**戦略相談は旧のlocal固定回答（Bridgeの`position_comparison`による「戦略室」回答）で終端せずLUNAへ渡る**（STR-001が成立している時と同じ方針＝§24.11-4）。そのため既存の「戦略室」e2e2件（`tests_strategy_room_e2e.py`）は、U1を無効にした条件(`PITWALL_FIELD_LOG=0`)で旧経路を固定して実行するようpreflightを変えた（U1有効時の経路はU2のE2Eが検査）。旧のlocal回答を優先したい場面があるなら、渡す/渡さないの規則を別途決める必要がある。
12. **焦点（「じゃあ次周なら？」）の判定は「〜なら？／〜たら？」の仮定の形だけ**（`parseFocus`、E8）。最初は広すぎて「今ピットに入るのと、アンダーカットはどっちが得？」まで焦点にし、STR-001のE10（同じLapの再質問で計算版が変わる）とpreflightの戦略室e2eを壊した。焦点はSTR-001の入力・仮定を変えない形に直した。言い回しの網羅は実会話で調整が要る。
13. **出荷単位（Build/公開の個別GOの前提・今回は未実施）**：変更は **Desktop（renderer・新module）＋server.js（受理・prompt）＋Bridge（U1＝Build 307）** にまたがる。**Desktopだけ出してもserverが旧版だと、LUNAのsystem promptに`uc`が載らない**（旧serverは`promptBlock`を知らず、STR-001が不成立ならundercutだけのパケットは拒否する）。サーバー（Railway）の出荷とSHA照合（`verify-deploy.sh`、Gate 7）が要る。`desktop/package.json`の`files`は`*.js`なので新moduleは自動で同梱される（実asarの検査はpreflightのWO020 runtime coverage）。

### 11.9 検査Claudeの差戻し（2026-11-13）への対応 — R-U2-1〜5

| 指摘 | 対応 | 検査 |
|---|---|---|
|**R-U2-1** 周回数制で停止後の周数が1周短い（給油0.5L・実際は2.5L必要）|`undercut-forecast.js` `mk()`：`after = N.high − P`（チェッカー＝進行量N+1、停止＝P+1。STR-001の`total.high − P`と同じ）。`fuelFinishNoStop`はもともと同定義で、`mk()`と整合した|F1〜F5b：総20周・10.0周・20L・2.0L/周で今案の給油**2.5L**（停止前18.0L・総20.5L）、STR-001（同入力）の`add_l`と一致、時間制(19〜21)は高い側で数える(4.5L)、総20周の20周終わり（チェッカー）は除外。A1/A2/A5/A7/A8、B1/B3の手計算期待値と、富士合成の車列配置（`trainFor`の必要量）も同じ定義へ直した|
|**R-U2-2** Truth Gateの誤検知と漏れ|`hasUnobservedClearClaim`：文→節（、）に分け、肯定の断定パターン（詰まらない／クリア(です)／ガラ空き／車はいない／渋滞はない／混んでいない／トラフィックは少ない／引っかからない／clean air／no traffic／rejoin is clear 等）を、**同じ節（または直後の短い節）に否定・留保（とは言えない／断定できない／不明／分からない／言い切れない／とは限らない／can't say 等）が無い時だけ**止める。パターン照合で意味の保証ではない注記は維持|F6（正しい説明12例を止めない）、F7（断定16例を止める）、F8（全車観測時は止めない）。検査Claude挙げの誤検知5例・漏れ9例を全て含む|
|**R-U2-3** 自車がピットレーン上|`compute`：`own.on_pit_now`なら`blocking:['own_in_pit']`・案/推奨なし（packetUsable=false）。**鈴鹿の実ログLap15は自車がピット中で、推奨が出なくなった**|F9、F9b、M29|
|**R-U2-4** テストの穴|①別session/race追跡リセット(F10/F10b) ②推測位置の車を「見えていない」に数える(F11) ③相手の給油量仮定幅がGAP範囲に出る(F12)を追加|M32・M33・M34で検出|
|**R-U2-5** 提案文の主語|「…と、燃料の限界案だと給油後に**11番に約3.1秒先に出られる（自車が後ろになる）**。」|e2e FW4、M35|

**数値の変化（隠さず）**
- 鈴鹿（実U1ログ）：周回数が不明（時間制の幅）でも停止後が1周増え、Lap14の推奨は「今(14周)」→「**次周(15周)**・判断は15周まで」になり、提案の発話もこの内容。Lap5〜13は従来どおり限界(15周)。**Lap15は自車がピット中のため計算しない**（以前はここで第二の停止を推奨していた）。観測は最大21/50、後続は見えず、「空いている」と言ったLapは0のまま。
- 富士（再現用の仮定）：結論は変わらない。待つと逆転ケース＝推奨**今(9周)**（#11が先に入ると次周案+2.8〜3.0s・限界案+2.8〜3.1s逆転、今案は全想定で自車が前）。早く入ると損ケース＝今案の交通損失4.5s（1.5〜9s）で推奨**限界(22周)**・「燃料重量0なら次周案」。給油量は各案8.1L。⚠値は私の仮定でDriver報告ではない。
- **周回数制の給油量が1周ぶん増える**ので、これまでの§11.4・§11.5の秒数・給油量の表は、この節の数値が優先する（上の通り）。

**検査（再実行・実API0件）**：unit 64/64（49→64）、e2e 48/48（46→48）、STR-001 compare 72/72、STR-001 entry e2e 53/53、変異34件すべて検出（M28〜M35を追加。1件(M18)が一度生き残ったが、実ログのLap15が`own_in_pit`になって「Lapが進むと焦点が外れる」検査が素通りしていたのが原因で、そのLapだけ自車のピット表示を外して計算を成立させる形に直し、検出）、`./preflight.sh`は下記。

**この修正で変わらない未検証**：§11.8の1〜13。特に鈴鹿は後続が見えず本機能を評価できない／富士の値は仮定／k・通過コスト・相手の給油量は未校正／実iRacing・Windows・実LLM・実音声は未検証。

**検査Claudeへの注意**：Truth Gateの関数本体を書き換えたため、`_mut_u2.py`のM15の置換元（`return CLEAR_CLAIMS.some(re => re.test(t));`）は無くなった。新しい置換元は`if (!CLEAR_CLAIMS.some(re => re.test(cl))) continue;`（`tools/u2-mutate.js`のM15・M30・M31を参照）。

### 11.10 再検査（検査Claude限定合格）の残課題①〜③への対応

- **①語彙の追加**：`CLEAR_CLAIMS`に「前は空いて(い)ます」「空いてますよ」「誰もいません」「巻き込まれません」「トラフィック/渋滞は気にしなくて／気にせず」「自分のペースで走れます」「障害物がなく」「他の車と絡みません」「前後は空白です」「問題なく空いたところに出ます」を追加。検査Claudeが挙げた漏れ9例はすべて止まる（F7に9例を追加）。
- **②誤検知の解消**：`CLEAR_HEDGE_NEXT`で節頭の「現時点では／現状では／今のところ／今は」を許容。「復帰先は空いているのか、現時点では不明です。」は通る（F6に4例を追加）。
- **③限界（明記）**：Truth Gateは**パターン照合で、語彙に無い断定は止められない**。今回の再検査で見つかった漏れの例は、「前は空いてますよ」「出た先は誰もいません」「渋滞に巻き込まれません」「トラフィックは気にしなくて大丈夫」「自分のペースで走れます」「障害物がなく」「他の車と絡みません」「前後は空白です」「問題なく空いたところに出ます」（①で塞いだ）。**言い回しは無限にあり、今後も漏れうる**。実際の防御は、プロンプト（`PROMPT_RULES_UC`）と、提案文を決定論で作る側（LLMを呼ばない）で、Gateは最後の網。漏れが見つかるたびに語彙を足す運用で、完全な保証ではない。
- 変異M36（「巻き込まれません」を通す）・M37（「現時点では不明です」を誤検知する）を追加し、いずれも検出。
