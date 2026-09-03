// 訂正検出の境界 — **独立オラクル**
//
// 出典: review/CODEX_GATE4_REVIEW_20260903.md（Codex Gate 4 独立反証）
//
// なぜ別ファイルか（Codex §4）:
//   `tests-conversation-memory-box.js` の `AXIS_MAP` は GAP に3軸、戦略に pit/fuel、
//   ダメージに car_state/pit を許す。**実装に合わせて期待値を緩められる。**
//   ここは labels / AXIS_MAP と**別系列**で、軸・confidence・**撤回対象 turn_id** を
//   すべて**単一値**で固定する。許容配列を使わない。
//
// 自己検査（下部）: 期待値を入れ替える／nearby_car へ置換する変異でこのテストが
//   赤くなることを、テスト自身が確認する。オラクルが効いていない状態で緑にしない。

const d = require('./desktop/dispute-detector.js');

let pass = 0;
const failures = [];

/** 単一値で固定する。1件目で止めず全件を見る。 */
function fix(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return true; }
  failures.push(`${name}\n     期待 ${w}\n     実際 ${g}`);
  return false;
}

/** 軸・confidence・撤回対象 turn_id の3点を同時に固定する。 */
const shape = (r) => r ? [r.axis, r.confidence, r.prior_claim_id] : null;

// ── Codex §1 遡り探索の時間上限 ────────────────────────────────
// 10分前の同軸を現在の撤回対象にしない。上限外は撤回対象を持たせない。
fix('§1 10分前の同軸は撤回対象にしない',
  shape(d.detect('後ろ2秒、違うよ。', {
    lunaTurns: [{ turn_id: 'old', text: '後ろ5.8秒。', at: 0 },
                { turn_id: 'new', text: '了解。', at: 600000 }],
    reflexes: [], at: 601000 })),
  ['gap_behind', 'candidate', null]);

// ── Codex §2 明示Pit訂正を反射語が食わない ──────────────────────
// 明示軸と反射否定が同一ターンに混在＝1軸へ決め打ちせず candidate。
fix('§2 明示Pitと反射否定の混在は1軸へ決め打ちしない',
  shape(d.detect('ピット判断が違う。左に車は関係ない。', {
    lunaTurns: [{ turn_id: 't0', text: '今周ピットを確認する。左に車。', at: 1000 }],
    reflexes: [], at: 2000 })),
  [null, 'candidate', 't0']);

// 反射の否定が無く、明示軸だけを訂正している場合は反射経路へ入れない。
// 直前が反射語で「始まる」だけで nearby_car にしていた（実装の穴だった）。
fix('§2-a 反射を否定していない明示Pit訂正は pit として確定する',
  shape(d.detect('ピット判断が違う。', {
    lunaTurns: [{ turn_id: 't0', text: '左に車。今周ピットを確認する。', at: 1000 }],
    reflexes: [], at: 2000 })),
  ['pit', 'confirmed', 't0']);

// ── Codex §3 反射の絶対鮮度・同時刻境界 ─────────────────────────
// 撤回してよい対象が直前発話に無いのに、古い反射を根拠に確定させない。
fix('§3 同時刻の古い反射で無関係な発話を撤回しない',
  shape(d.detect('左に車はいない。', {
    lunaTurns: [{ turn_id: 't1', text: 'インシデント3件。', at: 2000 }],
    reflexes: [{ event_id: 'e1', kind: 'side_by_side', at: 2000, authoritative: true }],
    at: 100000 })),
  [null, 'candidate', null]);

// 呼出し側の120秒窓に依存せず、検出器単体で絶対鮮度を見る。
fix('§3-a 絶対鮮度の外の反射を軸に使わない',
  shape(d.detect('違うよ、インシデントは1件。', {
    lunaTurns: [{ turn_id: 't1', text: 'インシデント3件。', at: 2000 }],
    reflexes: [{ event_id: 'e1', kind: 'side_by_side', at: 3000, authoritative: true }],
    at: 500000 })),
  ['incidents', 'candidate', null]);

// 遡り上限の内側（131秒前）だが反射は鮮度外（121秒前）。
// **ドライバーが軸を明示しない**発話にしてある。明示すると §2-a の経路が先に効き、
// 絶対鮮度が実行されないまま緑になる（最初に書いた版がそれで、変異を検出できなかった）。
fix('§3-b 軸を明示しない訂正でも、鮮度外の反射を軸に使わない',
  shape(d.detect('違うよ、それ。', {
    lunaTurns: [{ turn_id: 't1', text: 'インシデント3件。', at: 0 }],
    reflexes: [{ event_id: 'e1', kind: 'side_by_side', at: 10000, authoritative: true }],
    at: 131000 })),
  ['incidents', 'confirmed', 't1']);

// ── 退行防止：正当な反射否定は confirmed のまま ──────────────────
fix('退行 直前が反射なら反射への訂正として確定する',
  shape(d.detect('左に車はいない。', {
    lunaTurns: [{ turn_id: 't1', text: '左に車。', at: 2000 }],
    reflexes: [{ event_id: 'e1', kind: 'side_by_side', at: 2000, authoritative: true }],
    at: 3000 })),
  ['nearby_car', 'confirmed', 't1']);

// ── 実走の境界3件（Codex §4：期待軸を単一値で固定する）─────────────
// #14 直前に「ベスト更新」が割り込んでも、撤回対象は2つ前の「後ろ0.0秒。」
fix('#14 撤回対象は割り込みの前の同軸発話',
  shape(d.detect('後ろ2.0だね。ギャップ。', {
    lunaTurns: [{ turn_id: 'a', text: '後ろ0.0秒。', at: 1000 },
                { turn_id: 'b', text: 'ベスト更新。1:31.495。', at: 2000 }],
    reflexes: [], at: 3000 })),
  ['gap_behind', 'confirmed', 'a']);

// #30 1発話にピットと反射が混在し、ドライバーは反射だけを否定している
fix('#30 複合発話でも否定された反射が撤回対象',
  shape(d.detect('左全然車いないです', {
    lunaTurns: [{ turn_id: 'c',
      text: 'わかった。ピット前に確認する。今はドライビングに集中して。左に車。', at: 1000 }],
    reflexes: [], at: 2000 })),
  ['nearby_car', 'confirmed', 'c']);

// #44 デブリーフ中の Incidents 訂正。レース中の古い反射を持ち込まない
fix('#44 デブリーフの訂正に古い反射を持ち込まない',
  shape(d.detect('インシデントは4件じゃない。', {
    lunaTurns: [{ turn_id: 'e', text: 'インシデント4件でした。', at: 1000000 }],
    reflexes: [{ event_id: 'r1', kind: 'side_by_side', at: 200000, authoritative: true }],
    at: 1001000 })),
  ['incidents', 'confirmed', 'e']);

// ── 上限値の根拠（実走分布）─────────────────────────────────
// 母集団は labels_v2.json の `speech_act === '訂正'` の**16件**。最大38秒（中央値25／90%tile 32）。
// 90秒はその約2.4倍。
// 上限内（38秒）は対象を持ち、上限外（185秒・#64の実データ）は持たない。
fix('上限内38秒の同軸は撤回対象を持つ',
  shape(d.detect('後ろ2.0だね。ギャップ。', {
    lunaTurns: [{ turn_id: 'a', text: '後ろ0.0秒。', at: 0 }],
    reflexes: [], at: 38000 })),
  ['gap_behind', 'confirmed', 'a']);

// #64 実データ。**`speech_act='報告'`（#62 の再提出）で、上の16件の母集団には入らない。**
// 上限値の根拠ではなく、「同軸が無い時に古い無関係な発話を撤回対象にしない」ことの境界として置く。
fix('#64 同軸が無ければ古い直前発話を撤回対象にしない',
  shape(d.detect('incidents 3, All off track.', {
    lunaTurns: [{ turn_id: 'z', text: 'iRacingが切れちゃった。', at: 0 }],
    reflexes: [], at: 185000 })),
  ['incidents', 'confirmed', null]);

// ── オラクル自己検査 ───────────────────────────────────────
// 期待値を歪めた時に、このテストが実際に赤くなるか。緩い許容で緑を作らない。
(function oracleMutation() {
  const probe = (want) => {
    const got = shape(d.detect('後ろ2.0だね。ギャップ。', {
      lunaTurns: [{ turn_id: 'a', text: '後ろ0.0秒。', at: 1000 },
                  { turn_id: 'b', text: 'ベスト更新。1:31.495。', at: 2000 }],
      reflexes: [], at: 3000 }));
    return JSON.stringify(got) === JSON.stringify(want);
  };
  const checks = [
    ['期待軸を nearby_car へ置換', probe(['nearby_car', 'confirmed', 'a'])],
    ['#14 の撤回対象を隣の turn へ差し替え', probe(['gap_behind', 'confirmed', 'b'])],
    ['confidence を candidate へ緩める', probe(['gap_behind', 'candidate', 'a'])],
  ];
  for (const [name, stillGreen] of checks) {
    if (stillGreen) failures.push(`オラクル自己検査：${name} でも緑のままになった`);
    else pass++;
  }
})();

const total = pass + failures.length;
for (const f of failures) console.error('  ❌ ' + f);
console.log(`[dispute boundaries] 合格 ${pass} / 不合格 ${failures.length}（実行 ${total}）`);
if (failures.length) process.exit(1);
