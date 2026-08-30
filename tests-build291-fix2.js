#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════
// Build 291 修正2 — 会話成立と反射イベント統合
// 仕様：review/BUILD291_FIX2_SCOPE.md
// 回帰ケース：OMORAY-bridge-debug-20260830-1539.log（Road Atlanta IMSA）
//
// 仕様の「固定再生テスト」6項目を、実物のモジュール／本番 renderer 関数で確認する。
//   1. LLM由来の「左に車」が出ない
//   2. iRacing由来の side_by_side は残る
//   3. 「その数値は確認できない」がGAP質問の標準応答にならない
//   4. 黄旗・停止車両の両方が存在する場合、到着順がログで確認できる
//   5. 一度否定されたイベントは、そのイベントだけ停止し、新規イベントは復活する
//   6. 実測ピット判断が一つに決まり、相反する燃料コールが出ない
// ══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const vm = require('vm');
const RE = require('./desktop/reflex-events.js');
const router = require('./desktop/local-intent-router.js');
const cards = require('./engineer-card.js');

const html = fs.readFileSync('desktop/renderer.html', 'utf8');
const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');
let pass = 0, fail = 0;
function ck(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '  ✅ ' : '  ❌ ') + label + (ok ? '' : ' -> ' + (detail === undefined ? '' : String(detail))));
  ok ? pass++ : fail++;
}
const T0 = 1_700_000_000_000;

// ── ① LLM由来の反射コールを喋らない ─────────────────────────────────
console.log('══ ① LLMは安全コールを生成できない ══');
{
  // 実走 16:21:10 の返答そのもの
  const actual = '次のラップは白紙。リセットしよ。左に車。';
  ck('実走の捏造コールを検出する', RE.containsReflexClaim(actual) === true);
  const stripped = RE.stripReflexClaims(actual);
  ck('反射の文だけ落とし、会話は残す',
    stripped.text === '次のラップは白紙。リセットしよ。' && stripped.removed.length === 1, JSON.stringify(stripped));

  const actual2 = 'わかった。ピット前に確認する。今はドライビングに集中して。左に車。';
  ck('16:23:15 の同型も落とす',
    RE.stripReflexClaims(actual2).text === 'わかった。ピット前に確認する。今はドライビングに集中して。');

  ['右に車。', '両側に車。', 'イエローフラッグ。', '前方に停止車両。', '後ろから来てる。',
   'Car left.', 'Stopped car ahead.', 'Yellow flag.'].forEach(t =>
    ck(`「${t}」を反射コールとして検出`, RE.containsReflexClaim(t) === true));

  ['燃料は足りてる。ペースキープ。', 'ベスト更新。1分19秒130。', 'P10。ナイスパス。']
    .forEach(t => ck(`「${t}」は落とさない`, RE.stripReflexClaims(t).text === t));

  ck('source=llm の反射イベントは再生させない',
    RE.validateForSpeech({ event: Object.assign(RE.build({ kind: 'side_by_side', now: T0, payload: { side: 'left' } }), { source: 'llm' }), now: T0 }).reason === 'llm_generated_reflex_forbidden');

  // 本番 renderer 側の配線
  ck('renderer が LLM 出力から反射コールを剥がす',
    /containsReflexClaim\(full\.slice\(spokenLen\)\)/.test(html) && /stripReflexClaims\(full\)/.test(html));
  ck('無線を LLM 会話履歴へ入れない',
    /diagnosticLog\('RADIO_HISTORY_EXCLUDED'/.test(html)
    && !/addMsg\('ai',text\);\s*\n\s*pushMsg\(\{role:'assistant',content:text\}\);/.test(html));
}

// ── ② iRacing由来の side_by_side は残る ─────────────────────────────
console.log('══ ② 実測の反射は残す ══');
{
  const ev = RE.build({ kind: 'side_by_side', source: 'bridge_telemetry',
    source_timestamp: T0, session_time: 1200.5, now: T0, payload: { side: 'left' } });
  ck('bridge 由来イベントを構築できる', ev && ev.kind === 'side_by_side' && ev.source === 'bridge_telemetry');
  ck('必須フィールドを全て持つ',
    !!ev.event_id && ev.source_timestamp === T0 && ev.session_time === 1200.5
    && Number.isFinite(ev.valid_until), JSON.stringify(ev));
  const decision = RE.validateForSpeech({ event: ev, now: T0 + 500, latestByKind: { side_by_side: ev } });
  ck('期限内・最新なら喋る', decision.speak === true, JSON.stringify(decision));
  ck('決定論の文言を持つ', RE.describe(ev, 'ja') === '左に車。');
  ck('期限切れは喋らない',
    RE.validateForSpeech({ event: ev, now: T0 + 60000 }).reason === 'expired');
  const newer = RE.build({ kind: 'side_by_side', source_timestamp: T0 + 2000, now: T0 + 2000, payload: { side: 'right' } });
  ck('より新しい同種イベントが来たら古い方は喋らない',
    RE.validateForSpeech({ event: ev, now: T0 + 2100, latestByKind: { side_by_side: newer } }).reason === 'superseded_by_newer_event');

  ck('bridge が side_by_side に観測時刻を載せる',
    /'trigger': 'side_by_side'[\s\S]{0,220}'source_timestamp'/.test(bridge));
  ck('bridge が停止車両に car_idx と観測時刻を載せる',
    /'trigger': 'stopped_ahead'[\s\S]{0,420}'car_idx': idx[\s\S]{0,420}'stopped_timestamp'/.test(bridge));
  ck('存在しない track_side を作らない（SDKで取れないので送らない）',
    !/'track_side':/.test(bridge));
  ck('renderer が反射を共通モデルへ正規化する', /function toReflexEvent\(data\)/.test(html));
  ck('発話直前に再検証する', /function reflexSpeakDecision\(event\)/.test(html) && /REFLEX_SUPPRESSED/.test(html));
}

// ── ③ GAP質問が汎用拒否へ落ちない ───────────────────────────────────
console.log('══ ③ 「その数値は確認できない」を標準応答にしない ══');
{
  const live = { session_num: 2, class_pos: 12, gap_ahead: 1.4, gap_behind: 2.9,
    competitors: [{ car_idx: 5, car_number: '7', class_name: 'GTP', class_pos: 1, gap_s: 2.9 }],
    gap_authority: {} };
  // 実走で失敗した3つの発話
  const gdp1 = router.route({ text: 'ルナ 継続して gdpのコード教えて。', lang: 'ja', live, snapshotAgeMs: 0 });
  ck('「gdpのコード教えて」が GTP の照会として届く',
    gdp1.handled === true && gdp1.intent === 'faster_class_status', JSON.stringify(gdp1));
  ck('「わたしはレースエンジニア」で拒否しない', !/レースエンジニア/.test(gdp1.reply), gdp1.reply);
  const gdp2 = router.route({ text: '了解。gdp 来てる？', lang: 'ja', live, snapshotAgeMs: 0 });
  ck('「gdp 来てる？」も同じ intent へ',
    gdp2.handled === true && gdp2.intent === 'faster_class_status', JSON.stringify(gdp2));
  ck('相手を車番で名指しする', /#7/.test(gdp2.reply), gdp2.reply);
  const dispute = router.route({ text: 'まだ3秒以内にも入ってない。', lang: 'ja', live, snapshotAgeMs: 0 });
  ck('接近コールへの訂正を訂正として受ける',
    dispute.handled === true && dispute.intent === 'measurement_disputed', JSON.stringify(dispute));
  ck('訂正に「その数値は確認できない」を返さない', !/確認できない/.test(dispute.reply), dispute.reply);

  const gap = router.route({ text: '後ろとの差は？', lang: 'ja', live, snapshotAgeMs: 0 });
  ck('通常のGAP質問は実測で即答', gap.intent === 'nearest_gap' && /2\.9秒/.test(gap.reply), gap.reply);

  // 実測が無い時も、何が未確定かを言う（汎用拒否にしない）
  const grab = name => {
    const i = html.indexOf('function ' + name + '(');
    const rest = html.slice(i);
    const end = rest.slice(1).search(/\n(?:async function |function |const |let |\/\/ )/);
    return rest.slice(0, end > 0 ? end + 1 : rest.length);
  };
  const box = { console, JSON, Number, String, Math, RegExp, Object, Array,
    fmtDuration: () => '', lastWeekendAuthority: {} };
  vm.createContext(box);
  vm.runInContext(grab('telemetryTruthFallback'), box);
  const blind = { session_num: 2 };
  // 専用分岐が既に対象を名指しできる質問は、その文言で足りる。
  // 検査したいのは「対象が名指しされ、汎用拒否に落ちないこと」。
  [['GTPどこ？', /上位クラス/], ['後ろのギャップは？', /GAP|車間/],
   ['今の順位は？', /順位/], ['燃料どう？', /燃料|必要量/], ['タイヤ温度は？', /車両の状態/]]
    .forEach(([q, subjectRe]) => {
      const reply = box.telemetryTruthFallback(blind, q, true);
      ck(`未確定時も対象を名指しする（${q}）`,
        subjectRe.test(reply) && !/その数値は確認できない/.test(reply), reply);
    });
  const generic = (html.match(/その数値は確認できない/g) || []).length;
  ck('汎用の「その数値は確認できない」は説明コメント以外に残っていない',
    generic === 1 && /P0：汎用の「その数値は確認できない」を標準応答にしない/.test(html), generic);
}

// ── ④ 黄旗と停止車両の到着順 ────────────────────────────────────────
console.log('══ ④ 黄旗・停止車両の到着順 ══');
{
  const yellow = at => RE.build({ kind: 'yellow_flag', source_timestamp: at, now: at, payload: { flag_timestamp: at } });
  const stopped = (at, side) => RE.build({ kind: 'stopped_ahead', source_timestamp: at, now: at,
    payload: { stopped_timestamp: at, car_idx: 7, distance: 3.2, track_side: side || null } });

  const yFirst = RE.orderHazards({ yellow: yellow(T0), stopped: stopped(T0 + 5000), lang: 'ja' });
  ck('黄旗が先なら黄旗から', yFirst.order === 'yellow_first' && /イエロー/.test(yFirst.lines[0]), JSON.stringify(yFirst));
  const sFirst = RE.orderHazards({ yellow: yellow(T0 + 5000), stopped: stopped(T0), lang: 'ja' });
  ck('停止車両が先なら停止車両から', sFirst.order === 'stopped_first' && /停止車両/.test(sFirst.lines[0]), JSON.stringify(sFirst));
  const both = RE.orderHazards({ yellow: yellow(T0), stopped: stopped(T0 + 400, 'left'), lang: 'ja' });
  ck('ほぼ同時なら一文へ統合', both.order === 'simultaneous' && both.lines.length === 1, JSON.stringify(both));
  ck('統合文に側を含める（取れている時だけ）', /コース左側/.test(both.lines[0]), both.lines[0]);
  const noSide = RE.orderHazards({ yellow: yellow(T0), stopped: stopped(T0 + 400), lang: 'ja' });
  ck('側が取れなければ側を作らない', !/左|右/.test(noSide.lines[0]), noSide.lines[0]);
  const unknown = RE.orderHazards({
    yellow: RE.build({ kind: 'yellow_flag', now: T0, payload: {} }),
    stopped: RE.build({ kind: 'stopped_ahead', now: T0, payload: {} }), lang: 'ja' });
  ck('到着順不明なら順序を推測しない',
    unknown.order === 'unknown' && unknown.lines.length === 1 && /可能性/.test(unknown.lines[0]), JSON.stringify(unknown));
  ck('片方だけなら単独で喋る',
    RE.orderHazards({ yellow: yellow(T0), stopped: null, lang: 'ja' }).order === 'yellow_only');

  ck('bridge が黄旗イベントを持つ（従来は無線が存在しなかった）',
    /'trigger': 'yellow_flag'/.test(bridge) && /'flag_timestamp'/.test(bridge));
  ck('黄旗は立ち上がりだけ発火する', /if _yf_caution and not yellow_flag_active:/.test(bridge));
  ck('黄旗は安全直結として P0 に置く', /'yellow_flag': 0,/.test(bridge));
  ck('renderer が到着順をログへ残す', /REFLEX_HAZARD_ORDER/.test(html));
}

// ── ⑤ 訂正はそのイベントだけを止める ────────────────────────────────
console.log('══ ⑤ 訂正の範囲は1イベント ══');
{
  const first = RE.build({ kind: 'side_by_side', source_timestamp: T0, now: T0, payload: { side: 'left' } });
  let holds = RE.emptyHolds();
  ck('訂正前は喋れる', RE.validateForSpeech({ event: first, now: T0 + 100, holds }).speak === true);
  holds = RE.disputeEvent(holds, first, T0 + 200).holds;
  ck('訂正したイベントは止まる',
    RE.validateForSpeech({ event: first, now: T0 + 300, holds }).reason === 'driver_disputed_event');
  const later = RE.build({ kind: 'side_by_side', source_timestamp: T0 + 30000, now: T0 + 30000, payload: { side: 'left' } });
  ck('同じ種別の新しい実測イベントは復活する',
    RE.validateForSpeech({ event: later, now: T0 + 30100, holds,
      latestByKind: { side_by_side: later } }).speak === true);
  ck('種別ごと永久ミュートにしない', Object.keys(holds.events).length === 1);
  ck('renderer が訂正を1イベントに限定する',
    /function handleReflexDispute\(text\)/.test(html) && /scope:'single_event'/.test(html));
  ck('実走の否定文言を訂正として拾う',
    /左は\s*ウォールしかない/.test('左は ウォールしかないです') === true
    && /ウォールしかない|壁しかない/.test(html));
}

// ── ⑥ ピット判断が一つに決まる ─────────────────────────────────────
console.log('══ ⑥ 燃料警告と pit 判断の単一権威 ══');
{
  const holdLive = {
    session_type: 'Race', lap: 14, fuel: 16.1,
    race_plan: { kind: 'timed', configured_duration_s: 2400 },
    fuel_strategy: {
      required_fuel_l: 37.96, margin_l: -21.8, add_fuel_l: 22.3,
      estimated_crossings_to_finish: 14, pit_required: true,
      pit_timing_authority: { available: true, decision: 'hold', selected_plan: 'A',
        latest_safe_pit_lap: 19, laps_until_latest_safe_pit: 5 }
    },
    strategy_plan: { action: 'box', reason: 'fuel_shortfall', set_fuel_l: 23 }
  };
  const reply = cards.build(cards.classify('ピット 入る？'), holdLive, 'ja');
  ck('pit 回答は権威に従いステイアウト', /ステイアウト/.test(reply) && !/ピットを推奨/.test(reply), reply);
  ck('renderer 側の燃料警告も同じ権威で抑止する',
    /FUEL_PIT_AUTHORITY_UNIFIED/.test(html)
    && /_timing\.decision!=='pit_now'/.test(html));
  ck('pit_now の時は警告を止めない',
    /_timing\.available===true&&_timing\.decision&&_timing\.decision!=='pit_now'/.test(html));
  ck('曖昧な投げかけを禁止した', /曖昧な投げかけを新規に使うな/.test(fs.readFileSync('prompts.js', 'utf8')));
  ck('「次周ピット」の回収を義務づけた',
    /実行・変更・中止のどれかを必ず自分から回収/.test(fs.readFileSync('prompts.js', 'utf8')));
}

console.log(`\n[build291 fix2] 合格 ${pass} / 不合格 ${fail}`);
process.exit(fail ? 1 : 0);
