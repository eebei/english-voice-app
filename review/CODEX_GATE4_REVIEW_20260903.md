# 会話記憶Box v2 — Codex Gate 4 独立反証（2026-09-03 JST）

対象依頼: `review/CONVERSATION_MEMORY_BOX_GATE4_REQUEST_20260903.md`

## 判定

**Gate 4 は保留（条件付き差戻し）。署名しない。**

実走コーパスの到達・軸一致は確認できたが、境界条件を実行で潰し切っていない。特に `resolveAxis()` と反射経路は、文脈が曖昧な時に古い値または別の話題を撤回し得る。

## §2 への独立回答

### 1. `resolveAxis()` の遡り探索

**現状は無制限に近く、上限が必要。** `turnContext()` の既定30分／60件内で、ドライバーが軸語を含むと同軸のLuna発話を最後まで遡る。10分前のGAPを現在の訂正対象にする反例は成立する。

```js
det.detect('後ろ2秒、違うよ。', {
  lunaTurns: [
    {turn_id:'old', text:'後ろ5.8秒。', at:0},
    {turn_id:'new', text:'了解。', at:600000},
  ],
  reflexes: [], at:601000
})
// => confirmed / gap_behind / prior_claim_id='old'
```

提案: 訂正対象の探索は、明示軸がある場合でも「直近の同軸発話がレース文脈の許容時間内」に限定する。少なくとも時間上限を定数化し、上限外は `candidate` または `axis=null` へfail-closedする。上限値は実走分布で決め、決まるまでGate 4署名しない。

### 2. 反射語最優先がPit訂正を食う反例

**反例あり。** 1つのLuna発話にピットと反射が混在し、ドライバーがピットだけを訂正すると、反射経路が先に返る。

```js
det.detect('ピット判断が違う。左に車は関係ない。', {
  lunaTurns: [{
    turn_id:'t0', text:'今周ピットを確認する。左に車。', at:1000
  }],
  reflexes: [], at:2000
})
// 現状 => confirmed / nearby_car
// 期待 => pit または axis=null/candidate
```

提案: ドライバー発話に明示軸（ここでは「ピット」）がある場合は、反射経路より先に軸を解決する。ただし「左に車はいない」のような反射否定は従来どおり反射経路を優先する。明示軸と反射否定が同一ターンに混在する場合は、1軸へ決め打ちせずcandidateに落とす。

### 2-a 追加反例（現修正後も残る）

前節の修正は「混在時に反射語を否定している」場合だけを扱う。Luna発話が反射語から始まるケースでは、ドライバーがPitを明示しても反射分岐が先に返る。

```js
det.detect('ピット判断が違う。', {
  lunaTurns: [{
    turn_id:'t0', text:'左に車。今周ピットを確認する。', at:1000
  }],
  reflexes: [], at:2000
})
// 現状 => confirmed / nearby_car
// 期待 => pit または axis=null/candidate
```

反射語の否定が発話内に無くても、ドライバーの明示軸（Pit）を反射分岐より先に評価する必要がある。反射を優先できるのは、ドライバー側にも反射軸の否定がある場合に限定する。

### 3. `reflexIsFresh` の基準

**`lastReflex.at >= prev.at` だけでは不十分。** `conversation-memory-box.js` の120秒窓が通常呼出し側で先に効くが、検出器単体は絶対時間を確認していない。同時刻の古い反射もfresh扱いになる。

```js
det.detect('左に車はいない。', {
  lunaTurns: [{turn_id:'t1', text:'インシデント3件。', at:2000}],
  reflexes: [{event_id:'e1', kind:'side_by_side', at:2000, authoritative:true}],
  at:100000
})
// 現状 => confirmed / nearby_car（同時刻でもfresh）
```

提案: `0 < driver_at - reflex_at <= REFLEX_WINDOW_MS` を検出器側でも検査し、同時刻は原則除外する。呼出し側の窓に依存せず、単体契約としてfail-closedにする。

### 4. 軸検査のオラクル汚染

**現状の16/16は有効な回帰証拠だが、独立オラクルとしては弱い。** `tests-conversation-memory-box.js` の`AXIS_MAP`は、`GAP`に3軸、`戦略`にpit/fuel、`ダメージ`にcar_state/pitを許しており、別話題への誤撤回を通してしまう余地がある。またlabelsと対応表が同じ変更系列にあり、実装に合わせて期待値を緩められる。

提案:

- 軸だけでなく各訂正の**撤回対象turn_id／本文**を独立fixtureに固定する。
- #14/#30/#44のような境界例は、期待軸を単一値で固定する。
- 期待軸をnearby_carへ置換する変異、#14と#30の期待値交換、許容配列の拡張を行い、テストが赤くなることを確認する。
- labelsは採点用、独立fixtureは受入用に分離する。実装者が同時に編集できる同一表だけを正本にしない。

## 再確認後の合格条件

1. 時間上限を含む古い同軸の反例がfail-closedになる。
2. 明示Pit訂正と反射語混在の反例で、nearby_carへ誤分類しない。
3. 反射の絶対鮮度・同時刻境界がテストで固定される。
4. 独立turn単位オラクルとオラクル変異試験を追加し、軸・撤回対象の両方が一致する。
5. 既存の61/61、14/14、149/149、軸16/16を再実行する。

上記を満たした再提出まで、Gate 4署名・Build・公開へ進めない。Gate 6/8（実マイク、Windows、iRacing実走）も別途未完了である。

## 追加確認（2026-09-03 JST）

Claudeの分布記載は「訂正17件」だが、`review/corpus/labels_v2.json` の`正答`ラベルは16件である。17件目は実走コーパス#64（`incidents 3, All off track.`）で、訂正として扱う根拠と`fact_axis`がlabels側に登録されていない。90秒上限の根拠に#64（185秒）を含めるなら、#64を独立オラクルへ明示追加すること。含めないなら、分布・対象件数を16件に統一すること。

また、境界テストの現行実測は**15/15**（オラクル自己検査3件を含む）であり、`HANDOFF.md`および`preflight.sh`の13件表記は更新が必要である。

## 再確認（2026-09-03 JST）

Claudeの追加対応（訂正母集団16件への統一、#64の独立境界オラクル化、13→15表記の整理）を確認した。
Codex環境で以下を独立再実行し、すべて合格した。

| 検査 | 結果 |
|---|---:|
| `tests-dispute-boundaries.js` | **15/15** |
| `tests-conversation-memory-box.js` | **61/61** |
| `tests-callapi-stream-memory.js` | **14/14** |
| `tests-conversation-corpus-replay.js` | **149/149** |
| `node --check desktop/dispute-detector.js` | 合格 |
| `git diff --check` | 合格 |

訂正16件の軸一致、90秒の時間上限、#64（185秒・報告）の撤回対象null、13→15表記の正本化を確認した。
これにより、当初のGate 4差戻し条件は解消したため、**Gate 4：合格（Codex独立確認済み）**とする。

ただし、これはコード／内部再生に対するGate 4のみであり、Gate 5 artifact、Gate 6 Windows実機、Gate 8 iRacing実走、commit・Build・公開の完了を意味しない。
