# Build 266 — Plan B定義の判断

判断日: 2026-08-12  
対象: `BUILD266_REJECTION_2_4_REVIEW_REQUEST.md` の「Plan Bの意味」だけ  
対象外: #2 / #4全体の合否、#6 / #7、八木さんログ由来の項目

## 決定

**Plan Bはbriefどおり、条件付きのアンダーカットとして定義し直す。**

現行Build 265由来の `plan_b = extend_one_lap` は、Plan Bとして維持しない。Plan Aより遅く入る「1周延長」は、今回定義した条件付きのPlan C（overcut / fuel-save）側の概念である。

## 根拠

- 正本 `PITWALL_SHARED_WORKING_LOG.md:50` と brief `BUILD266_PHASE_E_ADAPTIVE_RACE_INTELLIGENCE_BRIEF.md:73-75` は、Plan Bを `undercut` と明示している。
- Yujiの実戦方針も、アンダーカットは固定の-1周ではなく、最初に成立する燃料ウインドウ、前走車より速い相対ペース、遅い後方集団を避ける復帰位置で決めるものとしている。
- 現実装 `strategy_options.py:56-61,116-153` は Plan Aの1周後をPlan Bとしており、actionも `extend_one_lap`。これは上の定義と正反対である。
- 現実装 `strategy_options.py:174-183` はPlan Cをさらに1周延長としている。そのため、現在のA/B/Cは「基準／延長／さらに延長」であり、「基準／アンダーカット／条件付きオーバーカット」ではない。

この不一致を残すと、Lunaが「Plan B」と言うだけで早入れなのか延長なのかが逆転する。レース中の戦略語として許容できないため、**P0の設計契約不一致**として先に統一する。

## 採用するA/B/C契約

| Plan | 役割 | 成立条件 | 常設性 |
|---|---|---|---|
| A | 基準戦略 | 通常ペースで成立する基準のpit window | ブリーフィングで提示可 |
| B | アンダーカット | 最初に成立する早いfuel window、stop後の容量・完走成立、前走車への相対ペース優位、遅い後方集団を避けるphysical rejoin | 条件が揃う時だけ提示・選択 |
| C | オーバーカット／fuel-save | 相手先ピット、クリーンエア、達成済みfuel-save目標、悪化しないrejoin | ブリーフィングではunavailable、ライブ証拠時だけ提示・選択 |

重要: Bは**単なる-1 lapではない**。現在の`latest_safe_in - 1`を機械的にBと呼ぶ実装も不可である。候補のpit lapは「最初に燃料・容量・完走が成立するウインドウ」から作り、相対ペースと復帰予測が揃った場合だけBをavailableにする。

## 必要な修正

1. `strategy_options.py` のPlan Bを `extend_one_lap` から `undercut` へ置換する。Plan B選択には、fuel / capacity / finish、relative pace advantage、physical rejoin clearの全証拠を要求する。
2. `decide_at_plan_a()`、`reevaluate_plans()`、BridgeのPlan B box callを新しいB契約へ更新する。B選択時のbox callは「予定どおりこの周でピット」であり、`1周延長`という文言を使わない。
3. `desktop/renderer.html` の既存文面（`1周延長案`、選択中は`延長`、Plan Bの`もう1周走って`）を、A/B/Cの意味に合わせて全置換する。発話で未証明の相対ペース・復帰を断定しない。
4. Plan Cは「Plan Bのさらに1周先」として計算しない。Plan Aを基準に、fuel-save目標を満たした上で延長可能な最初の候補を作り、4条件が揃った時だけavailableにする。
5. 次の再生テストを追加する。
   - B: 早いfuel windowだが相対ペース優位なし → unavailable。
   - B: 相対ペース優位ありだが遅い集団へblend → unavailable。
   - B: fuel / capacity / finish / pace / rejoin全成立 → selected=B、早いpit lap。
   - C: Plan Aより後の候補でも、4条件欠落 → unavailable。
   - radio: Bに`延長`、Cに`アンダーカット`が混ざらない。

## 公開済みBuildとの関係

公開Build 265の「Plan B = 1周延長」表現は、8/31公開前のBuild 266で置換する。互換維持のために戦略用語を誤ったまま残さない。テスター向けには、Build 266の確認事項として「Plan Bはアンダーカット、Plan Cは根拠が揃ったfuel-save／overcut」と明示する。

## 次のレビュー境界

この判断に合わせて再実装されるまで、#2 / #4は承認しない。Build 266全体も引き続き候補不可。commit / push / build / 公開はしない。
