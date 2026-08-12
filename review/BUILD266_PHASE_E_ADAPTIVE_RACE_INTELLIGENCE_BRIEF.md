# Build 266 実装指示書 — Phase E: Adaptive Race Intelligence

## 目的

Lunaを「残量を読むだけの助手」から、状況変化を検知した時に前提を更新し、燃費・ペース・ピット戦略を再計算して短く提案するレースエンジニアへ進める。

原則は一つだけである。

> 状況が変われば、前提を捨て、根拠を更新して再計算・再考する。

今回のMonza 20実走を再現対象にする。ピットボックス付近の接触、任意修理を選ばないピットアウト、ドライバー申告によるフロントバンパー／操舵異常、接触後のペース変化、燃料残量での完走を、同じ一本の戦略状態として扱うこと。

## 絶対条件

- commit / push / build / 公開は行わない。
- 既存の公開Build 265を変更完了扱いにしない。実装、ローカルテスト、Windows取得、実走は別の証拠である。
- LLMに燃料量・残り周回・損傷部位・復帰順位を推測させない。数値と発話の最終権威はBridgeの決定論的handlerとする。
- 会話の保存だけで完了にしない。申告が当該セッションの戦略状態へ入り、Plan判定と発話へ到達するtraceを必須とする。
- 既存の未関連ファイル、ユーザーの未コミット変更を触らない。

## 1. Session Race State（新設または明確化）

セッションごとに、次の権威状態を一つだけ持つ。Bridge側を権威にし、rendererは表示・無線policyの実行側に限定する。

### 必須フィールド

- `active_plan`：A / B / C。ブリーフィングで作成した有効Planを必ず登録する。
- `plan_snapshot_id` と `plan_revision`：いつ、どの根拠で更新されたか。
- `baseline_fuel_l_per_lap`：開始前の過去実測または当日クリーン周の基準。
- `recent_fuel_l_per_lap`：直近3〜5周の有効周中央値または明示された安全な推定値。
- `baseline_pace_s` と `recent_pace_s`：同じ定義の有効周で比較する。
- `damage_state`：下記の損傷証拠を保持する。
- `strategy_assumptions_invalidated`：損傷・雨・SC等により古い前提を使えないことを示す理由一覧。
- `last_recalculation`：再計算の原因、時刻／ラップ、入力値、出力Plan、運転者向け結論。

状態はセッション終了時に閉じる。次セッションへ無条件に持ち越さない。

## 2. 損傷・ドライバー申告の配線

### 2-1. iRacingの権威データ

既存の `PitRepairLeft` と `PitOptRepairLeft` を読む。以下を追加する。

- 接触または修理秒数を初めて検出した瞬間に `damage_observation` をスナップショット保存する。
- `mandatory_repair_s`、`optional_repair_s`、`damage_s`、lap、session time、incident delta、OnPitRoadを保存する。
- 任意修理を選ばずにピットアウトし、ライブ値が0.0秒になっても、検出済みの任意修理秒数を消さない。
- `repair_observed` と `repair_completed` を混同しない。任意修理が検出されたが未実施なら、`optional_repair_observed_but_not_taken` として残す。

iRacingから部位名を確定できない場合、部位をSDK確定として発話しない。

### 2-2. ドライバー申告

次のような発話は、そのレース中だけ有効な構造化申告へ変換する。

- 「フロントバンパーが」→ `driver_reported_damage: front_aero_or_body`
- 「フロント ステアリングコラム 周辺にダメージ」→ `driver_reported_damage: steering_or_front_end`
- 「アライメント狂ってる」→ `driver_reported_damage: steering_alignment`

申告はSDKの部位確定ではない。`source: driver_report` とし、確定値と混ぜない。

### 2-3. 戦略への接続

`damage_observation` または `driver_reported_damage` が入ったら、必ず `strategy_assumptions_invalidated` に理由を追加し、燃費・ペース・Plan A/B/Cを再計算する。

損傷を受けた直後の最初の結論は、根拠不足なら保守側に倒す。

- 良い例：`修理秒は0だが、操舵異常の申告あり。通常ペース前提を保留。次の有効3周で燃費を更新する。`
- 悪い例：`空力損傷なし`、`2分28秒修理`のように、確定できない内容を断定する。

## 3. Plan A / B / C の正しい作り方

### 3-1. レース前ブリーフィング

レースフォーマット、燃料容量、過去の同一車両／コース実測、想定チェッカー周回、予選順位、既知のピットロスからPlanを作る。開始時に一度だけ、短く提示する。

- **Plan A（baseline）**：通常ペース・通常のピット回数による基準戦略。
- **Plan B（undercut）**：単なる `-1 lap` ではない。最初に「必要給油量が容量内に収まり、チェッカーまで成立する」燃料ウインドウを起点にする。さらに、前走車への相対ペース優位と、遅い後方集団へ落ちない物理リジョインが必要。
- **Plan C（overcut / fuel-save alternative）**：単なる `+1 lap` ではない。前が先にピット、こちらにクリーンエア、燃費目標達成、次周リジョインが悪化しない等の条件がそろう時だけ成立させる。

オフィシャルレースでは、オーバーカットを常設の同格案として扱わない。根拠がないなら unavailable とする。

### 3-2. active_planの配線（Build 265の最優先不具合）

ブリーフィングで生成・提示したPlan A/B/Cは、必ず同じframeで `active_plan` と `plan_snapshot_id` に登録する。

`plan_fuel_authority.py` が `no_active_plan` を返す時、実際には有効なブリーフィングPlanが存在するなら接続不良である。燃料P0を出す前に、同一frameのPlan snapshotを読むこと。

予定ピット以前の燃料P0抑止は、次の全証拠がある時のみ行う。

- 現在燃料で予定ピットへ到達可能
- 予定給油量が容量内
- 予定サービス後、チェッカーまでの燃料余裕が0以上

いずれかが不明なら、保守側としてP0を許可してよい。ただし、Planが存在するのに `no_active_plan` へ落ちることは禁止する。

## 4. 再計算トリガーと出力

以下のいずれかで `recalculate_strategy()` を一度だけ呼ぶ。毎telemetry frameで再計算・発話しない。

1. 当日クリーン3周が揃った
2. driver_reported_damage が新規登録された
3. 修理秒数が新規検出された、または任意修理未実施でピットアウトした
4. 直近有効周の燃費中央値が基準から有意に乖離した
5. 直近有効周のペース中央値が基準から有意に乖離した
6. 前走車との相対ペース、相手のピット、リジョイン予測がPlan B/Cの成立条件を変えた
7. 終盤入り／ファイナルラップ確定

各回、traceに最低限次を残す。

```text
STRATEGY_RECALCULATION
reason=driver_reported_damage
baseline_fuel_l_per_lap=...
recent_fuel_l_per_lap=...
baseline_pace_s=...
recent_pace_s=...
damage_observed=...
driver_reported_damage=...
previous_plan=A
selected_plan=A
driver_message=...
```

ドライバーへの発話は一文、必要なら二文までにする。内部の全数値を読み上げない。

## 5. Monza 20の再現テスト

次のイベント列をPythonのBridge統合テストで再生する。unit testだけで終わらせない。

1. 20分Race、Mercedes-AMG GT3 2020、Monza、開始前の保存実測あり。
2. ブリーフィングがPlan A/B/Cを作り、`active_plan=A` が登録される。
3. 当日クリーン3周で燃費を更新する。
4. 最初のピットで任意修理秒を検出する。
5. 任意修理を選択せず、ピットアウト後の `PitOptRepairLeft=0` を受ける。
6. ドライバーがフロント／操舵異常を申告する。
7. その申告が `damage_state` に残り、基準ペース前提を無効化して再計算される。
8. 接触後の直近有効周燃費で、完走可否とプッシュ可否を更新する。
9. 実際の残量が安全域にあっても、損傷後の再計算が未完なら `ペースを上げていい` を出さない。
10. ファイナルラップ／チェッカー確定後に、`この周でピット`、給油設定、Plan変更を一切発話しない。

期待する短い無線例：

```text
操舵異常の申告あり。通常ペース前提を外した。次の有効周で燃費を更新する。
接触後の実績なら追加ストップなしで届く。プッシュは保留、現ペースを維持。
```

これらは数値・状態が揃った時だけ発話する。根拠がない場合は「確認中」と短く言い、GAPやS/Fを無関係に付け足さない。

## 6. Build 265から同時に直す配線不良

以下は今回の実走で確認済みのため、Phase Eへ入る前提条件として修正する。

1. `TELEMETRY_TRUTH_GATE` の定型文を廃止する。質問と無関係な「次のS/Fで燃料、残り、前後GAPを更新する」を出さない。
2. `side_by_side` は同じ相手・同じ側で短時間に連発させない。安全優先は維持しつつ再武装を設ける。
3. ラップ無線は候補、policy抑止、P0による延期、発話、意図的破棄をすべてtraceする。候補だけ作って無言で消えることを禁止する。
4. `PlayerTrackSurface=0` の単発値を永久のoff-track扱いにする前に、実走ログで判定妥当性を検証する。
5. ファイナルラップまたはチェッカー確定後は、燃料Plan選択・ピット指示・給油量コールをblockする。結果の保存は許可する。
6. 燃料が安全と確定済みなら、会話handlerは未確定と矛盾する回答を返さない。会話側も同じ権威状態を読む。

## 7. 八木さん実走ログ（2026-08-11 17:09〜）からの追加必須修正

このログはBuild 264時点のPractice/Testであり、Build 265のLap Readout 4択の可否を判定するためのログではない。ただし、以下の不具合は実走で確認されており、Build 266で修正対象にする。

### 7-1. Setup相談をweather_statusへ誤ルーティングしない

実測事実：Barcelona / Ferrari 296 GT3 / Practice、路面約50.6℃、気温約30.7℃の時、ドライバーは二度、次を質問した。

```text
路面温度が高すぎてタイヤが持たない。セットアップの方向、何かある？
路面温度が高いからセットアップを変えたい。何か意見ある？
```

どちらも `intent=weather_status` になり、気温・路面温度だけを返した。これは誤りである。

`setup_advice` または `handling_setup_advice` を明示intentとして作る。文中に `セットアップ`、`方向`、`変えたい`、`タイヤが持たない`、`アンダーステア`、`オーバーステア` がある場合、weather_statusより優先する。

回答は次の順にする。

1. 実測の環境値を短く根拠として確認する。
2. ドライバーが述べた症状と、低速／中速／高速のどこで強いかを確認する。
3. 車種固有の未検証な数値を断定せず、試す変更方向を最大二つ提案する。
4. 次の走行で比較する一つの観測項目を指定する。

路面温度を聞かれているだけならweather_statusでよい。setup相談を温度読み上げだけで終わらせない。

### 7-2. 文脈を失った曖昧質問にも直前の症状を引き継ぐ

実測事実：アンダーステア相談直後の「どうしたらいいですか？」に対し、Lunaは

```text
アンダーステアを減らすには、走行中は変えられないから、次のピットで内。
```

と文が途中で切れた形で発話した。直前2〜3ターンの相談対象（高路温＋アンダーステア＋setup）を会話状態に保持し、曖昧なフォローアップでも対象を失わないこと。発話は途中で切れない一文にする。

### 7-3. デブリーフ質問を技術相談へ割り込ませない

実測事実：高路温・アンダーステア・setupの相談中に、Lunaが

```text
実測タイムの変化と体感が一致した区間、または一致しなかった区間を教えて。
```

というデブリーフ質問へ逸れた。相談turnが継続中なら、デブリーフpromptは出さない。明示的な `End Session` またはレース／走行終了の確認後だけデブリーフへ入る。

### 7-4. limiter_offを一回だけにする

実測事実：18:46:51と18:47:00に、同一のピットアウトで `リミッターオフ。アウトラップ、ペースキープ。` が二度発話された。

OnPitRoadの `true → false` を一意の発火条件とし、同一pit exitの再武装は次回のOnPitRoad `false → true` を確認するまで禁止する。二重発火があれば `LIMITER_OFF_SUPPRESSED reason=already_announced_for_pit_cycle` を残す。

### 7-5. 八木さんログの回帰テスト

次の会話列をテスト化する。

```text
路面温度が高すぎてタイヤが持たない。セットアップの方向は？
→ intent=handling_setup_advice。温度だけで終了しない。

アンダーステアがひどい。何か解決策ある？
→ setup相談として症状を保持する。

どうしたらいいですか？
→ 直前のアンダーステア相談を引き継いだ、完結した回答になる。
```

さらに、同一pit cycleでlimiter_offが一回だけ発話されるevent-sequenceテストを追加する。

## 8. 完了条件

以下をすべて証拠で提出すること。

- 変更ファイル一覧と、各ファイルが担う動線
- 新規／更新テスト一覧と実行コマンド
- JavaScriptとPython Bridge関連の全結果
- Monza 20統合trace。`briefing → active_plan → damage_observation → driver_report → recalculation → driver call → final-lap block` が一つのログで追えること
- 任意修理が未実施でも損傷証拠が消えないテスト
- 予定ピット前P0抑止と、本当の燃料不足P0の両テスト
- ラップ読み上げの発話／延期／破棄trace
- commit / push / build / 公開をしていないこと

この文書の要件を満たして初めてCodexレビューへ渡す。テスト結果だけで完成扱いにしない。Codexが動線とtraceを確認するまで、Build 266候補とする。
# Shared test and cost policy

Build 266候補の内部シミュレーション、外部API呼出制限、no-data短文化、発話キュー原価検査は、次の正本を必須条件として参照する。

- `review/PITWALL_INTERNAL_SIMULATION_TEST_POLICY.md`
