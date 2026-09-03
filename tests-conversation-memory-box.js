#!/usr/bin/env node
'use strict';

// 会話記憶ボックス v2 — 実データ検証
//   設計: review/CONVERSATION_MEMORY_BOX_CODEX_DESIGN_20260902.md（Codex v2 §7 実装許可）
//
// **合格条件は Codex §7 のとおり。**
//   1) 訂正16件の `disputed()` 到達 = 16/16
//   2) 権威イベントを伴わない反射発話 = 0
//   3) 旧値の再利用 = 0 / 別session混入 = 0
//
// このテストは fixture を手で作らない。`review/corpus/` の実走ログと
// Yuji が正解を付けた `labels_v2.json` を入力にする。
// 期待値を下げて緑にすることはしない。

const fs = require('fs');
const path = require('path');
const box = require('./desktop/conversation-memory-box.js');
const det = require('./desktop/dispute-detector.js');

let pass = 0, fail = 0;
function check(label, ok, got) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : '  → ' + JSON.stringify(got)));
  ok ? pass++ : fail++;
}

const CORPUS = path.join(__dirname, 'review', 'corpus');
const rows = JSON.parse(fs.readFileSync(path.join(CORPUS, 'utterances_20260830_20260831.json'), 'utf8'));
const labels = JSON.parse(fs.readFileSync(path.join(CORPUS, 'labels_v2.json'), 'utf8'));
const CORRECTION_IDS = Object.keys(labels)
  .filter(k => labels[k].speech_act === '訂正').map(Number).sort((a, b) => a - b);

const REFLEX_RE = /^(左に車|右に車|3台並走)|前方に停止車両/;
function toMs(hhmmss) {
  const [h, m, s] = String(hhmmss).split(':').map(Number);
  return ((h * 60 + m) * 60 + s) * 1000;
}

// ── ① 訂正16件が disputed() へ到達するか（Codex §7 検証1） ───────────────
console.log('\n══ 訂正16件の disputed() 到達（実走ログ・Yuji正解セット） ══');
const missed = [];
for (const id of CORRECTION_IDS) {
  const r = rows[id - 1];
  const at = toMs(r.time);
  const lunaTurns = (r.luna_before || []).map((b, i) => ({
    turn_id: 'p' + i, text: b.text, at: toMs(b.t),
  }));
  // 直前のLuna発話が反射なら、reflex 文脈としても渡す（設計 §A の復帰）
  const reflexes = (r.luna_before || [])
    .filter(b => REFLEX_RE.test(b.text))
    .map((b, i) => ({
      event_id: 'e' + i,
      kind: /停止車両/.test(b.text) ? 'stopped_ahead' : 'side_by_side',
      direction: /左/.test(b.text) ? 'left' : /右/.test(b.text) ? 'right' : null,
      at: toMs(b.t), authoritative: true,
    }));
  const d = det.detect(r.question, { lunaTurns, reflexes, at });
  if (!d) missed.push({ id, q: r.question.slice(0, 40), prev: (lunaTurns.slice(-1)[0] || {}).text });
}
check(`訂正 ${CORRECTION_IDS.length}件すべてが disputed() へ到達する`,
  missed.length === 0, missed);
console.log(`   到達 ${CORRECTION_IDS.length - missed.length}/${CORRECTION_IDS.length}`);

// ── 過剰検出：訂正でない発話を訂正にしないか ─────────────────────────
console.log('\n══ 過剰検出（訂正でない52件） ══');
const falsePos = [];
for (let id = 1; id <= rows.length; id++) {
  if (CORRECTION_IDS.includes(id)) continue;
  const lab = labels[String(id)];
  // 「報告」は訂正と紙一重なので除外して数える（Yuji確定分を尊重）
  if (!lab || lab.speech_act === '報告') continue;
  const r = rows[id - 1];
  const lunaTurns = (r.luna_before || []).map((b, i) => ({ turn_id: 'p' + i, text: b.text, at: toMs(b.t) }));
  const d = det.detect(r.question, { lunaTurns, reflexes: [], at: toMs(r.time) });
  if (d && d.confidence === 'confirmed') {
    falsePos.push({ id, act: lab.speech_act, q: r.question.slice(0, 34), reason: d.reason });
  }
}
check('訂正でない発話を confirmed な訂正にしない', falsePos.length <= 3, falsePos);
console.log(`   誤検出 ${falsePos.length} 件（candidate は許容。confirmed のみ数える）`);

// ── ② 集約 → 上限 の順序（実装前最終反証 §4） ─────────────────────────
console.log('\n══ 反射コンテキスト：集約が上限より先に走るか ══');
{
  const b = box.emptyBox('test');
  const t0 = 1000000;
  // 実走 8/31朝の実パターン：左1・右5・3台1・右1 = 8件（120秒窓に9件入る例もある）
  const seq = ['left', 'right', 'right', 'right', 'right', 'right', 'multi', 'right'];
  seq.forEach((d, i) => box.addReflex(b, {
    kind: d === 'multi' ? 'multi_car_straight' : 'side_by_side',
    direction: d === 'multi' ? null : d, target: null,
    at: t0 + i * 6000, authoritative: true,
  }));
  const ctx = box.reflexContext(b, t0 + seq.length * 6000);
  check('集約後4件になり、上限5件で溢れない',
    ctx.length === 4, ctx.map(e => e.direction || e.kind));
  check('最古の「左に車」が残る（訂正の対象が押し出されない）',
    ctx[0] && ctx[0].direction === 'left', ctx[0]);
  // 上限を先に当てた場合との差（回帰の意味を残す）
  const naive = b.timeline.slice(-5).map(e => e.direction || e.kind);
  check('上限を先に当てると「左に車」が失われる（この順序でないと v1 の失敗へ戻る）',
    !naive.includes('left'), naive);
}

// ── ③ 旧値の撤回と再利用禁止（Codex §7 条件3） ──────────────────────
console.log('\n══ 旧値の撤回（8/31 の Incidents 0 を再現） ══');
{
  const b = box.emptyBox('Yuji|s1|Race|Red Bull Ring|AMG');
  box.addTurn(b, { who: 'luna', text: '今回はIncidents 0。', at: 1000 });
  box.addTurn(b, { who: 'driver', text: 'インシデント3ついてるんじゃないかな？', at: 2000 });
  const item = box.openDispute(b, {
    axis: 'incidents', source_turn_id: 't2',
    driver_observation: 'インシデント3ついてるんじゃないかな？',
    prior_claim_id: 't1', prior_claim_value: 0, at: 2000,
  });
  check('disputed が open で作られる', item && item.status === 'open', item && item.status);
  check('ドライバーの自由文を新しい値として自動採用しない',
    item.corrected_value === null, item.corrected_value);

  box.acknowledge(b, item.item_id, 2100);
  check('受領だけでは resolved にしない（受理と撤回は別）',
    item.status === 'acknowledged' && item.luna_value_retracted === false, item.status);
  check('撤回前は旧値がまだ使える扱い', box.isPriorClaimUsable(b, 'incidents') === true);

  box.retract(b, item.item_id, 2200);
  check('撤回すると旧値は再利用禁止になる',
    box.isPriorClaimUsable(b, 'incidents') === false);
  check('撤回済みの旧値は LLM 文脈へ出さない',
    box.buildContext(b, 2300).open_items[0].prior_claim_value === null,
    box.buildContext(b, 2300).open_items[0]);
  check('撤回だけでは長期記憶へ移さない', box.readyForLongTerm(item) === false);

  box.resolve(b, item.item_id, { corrected_value: 3, replacement_source: 'official_result', at: 2400 });
  check('resolved かつ撤回済みで初めて長期記憶へ移せる',
    box.readyForLongTerm(item) === true);
  check('置換値の出所が残る', item.replacement_source === 'official_result');
}

// 変異試験で判明：`readyForLongTerm` を常に true にしても既存assertionが全部通った。
// 「移してよい」ばかり確かめて「移してはいけない」を確かめていなかった。
// 未解決・受領のみ・撤回のみ・失効は、いずれも長期記憶へ移してはならない。
console.log('\n══ 長期記憶へ移してはいけない状態 ══');
{
  const b = box.emptyBox('s');
  const mk = () => box.openDispute(b, { axis: 'incidents', prior_claim_value: 0, at: 0 });
  const open = mk();
  check('open のままは移さない', box.readyForLongTerm(open) === false, open.status);
  const acked = mk(); box.acknowledge(b, acked.item_id, 1);
  check('acknowledged だけでは移さない', box.readyForLongTerm(acked) === false, acked.status);
  const held = mk(); box.hold(b, held.item_id, 1);
  check('held は移さない', box.readyForLongTerm(held) === false, held.status);
  const retracted = mk(); box.retract(b, retracted.item_id, 1);
  check('撤回しても resolved でなければ移さない',
    box.readyForLongTerm(retracted) === false, retracted.status);
  const resolvedOnly = mk(); box.resolve(b, resolvedOnly.item_id, { corrected_value: 3, at: 1 });
  check('resolved でも撤回していなければ移さない（旧値が生き残る）',
    box.readyForLongTerm(resolvedOnly) === false,
    { status: resolvedOnly.status, retracted: resolvedOnly.luna_value_retracted });
  const expired = mk(); box.expire(b, expired.item_id, 1);
  check('expired は移さない', box.readyForLongTerm(expired) === false, expired.status);
  check('null/undefined を移さない',
    box.readyForLongTerm(null) === false && box.readyForLongTerm(undefined) === false);
}

// ── 未解決訂正の再提出（8/31 の14分後・英語言い直し） ───────────────
console.log('\n══ 同一軸への再提出を新規報告にしない ══');
{
  const b = box.emptyBox('s');
  box.addTurn(b, { who: 'luna', text: '今回はIncidents 0。', at: 0 });
  const it = box.openDispute(b, { axis: 'incidents', prior_claim_value: 0, at: 1000 });
  box.acknowledge(b, it.item_id, 1100);          // 受領したが撤回していない = 未解決
  const again = box.findOpenByAxis(b, 'incidents');
  check('14分後の言い直しが同じ item に紐づく',
    again && again.item_id === it.item_id, again && again.item_id);
  box.retract(b, it.item_id, 2000);
  box.resolve(b, it.item_id, { corrected_value: 3, at: 2100 });
  check('resolved 後は同一軸で新しい訂正を開ける',
    box.findOpenByAxis(b, 'incidents') === null);
}

// ── ④ session 境界（Codex §7 条件3「別session混入0」） ───────────────
console.log('\n══ session 境界 ══');
{
  const a = box.emptyBox('Yuji|s1|Race|Le Mans|AMG');
  const c = box.emptyBox('Yuji|s2|Race|Le Mans|AMG');
  box.addTurn(a, { who: 'luna', text: '今回はIncidents 0。', at: 0 });
  box.openDispute(a, { axis: 'incidents', prior_claim_value: 0, at: 10 });
  check('別 session の box に前 session の訂正が漏れない',
    box.unresolved(c).length === 0 && box.turnContext(c, 100).length === 0);
  check('session_key が箱ごとに保持される',
    a.session_key !== c.session_key && box.buildContext(c, 100).session_key === c.session_key);
}

// ── ⑤ 数値の権威を持たない契約 ───────────────────────────────────
console.log('\n══ 箱は数値の権威を持たない ══');
{
  const b = box.emptyBox('s');
  box.addTurn(b, { who: 'luna', text: '後ろ0.0秒。', at: 0 });
  const ctx = box.buildContext(b, 100);
  check('LLM 文脈に「履歴の数字は現在値でない」契約が付く',
    ctx.contract === 'history_numbers_are_not_current_facts', ctx.contract);
}

// ── ⑥ 訂正と命令の競合（設計 v2 §E・実データ2件） ────────────────────
console.log('\n══ 訂正と driver command が同一ターンにある場合 ══');
{
  const card = require('./engineer-card.js');
  // 53「いや、もうこの周で入るよ」= 命令 かつ 直前の Plan A 継続への訂正
  const q = 'いや、もう この週で入るよ。';
  const prev = '現燃料で約9.6周。完走まで23.0L不足。Plan Aを継続、次のクリーン周で詰める。';
  const d = det.detect(q, { lunaTurns: [{ turn_id: 'p0', text: prev, at: 0 }], reflexes: [], at: 1000 });
  const c = card.classify(q);
  check('実データ53は訂正としても命令としても検出される',
    !!d && c && c.driverCommand === true, { dispute: d && d.reason, cmd: c && c.driverCommand });

  const pri = det.resolveTurnPriority({ dispute: d, driverCommand: c && c.driverCommand === true });
  check('訂正受領を先に発話し、命令は実行へ回す',
    pri.speak_first === 'dispute_ack' && pri.execute === 'driver_command', pri);
  check('1つの発話文へ連結しない', pri.concatenate === false);

  // 命令だけ（訂正なし）は従来どおり命令が先
  const only = det.resolveTurnPriority({ dispute: null, driverCommand: true });
  check('命令だけの時は従来どおり命令を実行する',
    only.speak_first === 'driver_command' && only.execute === 'driver_command', only);
}

// ── ⑦ 8/30ログ再生：権威イベントを伴わない反射発話 = 0（Codex §7 検証） ──
// 8/30 Road Atlanta で LLM がスポッターコールを捏造した。原因は履歴を積んだことだけでなく、
// **反射コールが Bridge の権威イベントを持たず、LLM が自由に生成できたこと**である。
// 会話履歴を戻す以上、この経路が塞がっていることを毎回機械で確かめる。
console.log('\n══ 8/30ログ再生：権威なし反射発話の検出 ══');
{
  const RAW = path.join(CORPUS, 'raw');
  const files = fs.existsSync(RAW) ? fs.readdirSync(RAW).filter(f => f.endsWith('.log')) : [];
  check('実走ログが corpus に存在する', files.length >= 4, files.length);
  const SPOKEN = /\[(\d\d:\d\d:\d\d)\] CONVO \[(?:LunaJP|Kanbe)\] (左に車。|右に車。)/;
  const EVENT = /\[(\d\d:\d\d:\d\d)\] CONVO \[REFLEX_EVENT\].*"kind":"(?:side_by_side|stopped_ahead)"/;
  const report = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(RAW, f), 'utf8').split('\n');
    const ev = [], sp = [];
    for (const l of lines) {
      let m = l.match(EVENT); if (m) { ev.push(toMs(m[1])); continue; }
      m = l.match(SPOKEN); if (m) sp.push(toMs(m[1]));
    }
    const orphan = sp.filter(t => !ev.some(e => Math.abs(t - e) <= 3000));
    report.push({ log: f.replace(/OMORAY-bridge-debug-|-redacted\.log/g, ''),
      events: ev.length, spoken: sp.length, orphan: orphan.length });
  }
  for (const r of report) {
    console.log(`   ${r.log}  REFLEX_EVENT=${r.events}  発話=${r.spoken}  権威なし=${r.orphan}`);
  }
  // 8/30 の2本は Build 291 修正2 より前で権威イベントが無い（既知）。
  // 8/31 以降は 0 でなければならない。ここが 0 でなくなったら捏造経路が開いている。
  const after = report.filter(r => r.log.startsWith('20260831') || r.log.startsWith('202609'));
  check('Build 291 修正2以降のログで、権威なし反射発話が0件',
    after.length > 0 && after.every(r => r.orphan === 0), after);
  const before = report.filter(r => r.log.startsWith('20260830'));
  check('8/30（修正前）は権威イベント0で全件が権威なし＝この検査が実際に効く',
    before.every(r => r.events === 0 && r.orphan === r.spoken), before);
}

// ── ⑧ renderer への実配線（Codex 差戻し §8-1） ────────────────────────
// 「同梱だけで未接続」を防ぐ。**存在検査ではなく、取り出して動かす。**
console.log('\n══ renderer 配線（読み込み・呼出し・順序） ══');
{
  const vm = require('vm');
  const renderer = fs.readFileSync(path.join(__dirname, 'desktop', 'renderer.html'), 'utf8');

  check('script src で両モジュールを読み込む',
    renderer.includes('<script src="conversation-memory-box.js"></script>')
    && renderer.includes('<script src="dispute-detector.js"></script>'));

  // ★順序が契約：dispute は localIntent（軸判定）より前に走る（設計 §B）
  const iDispute = renderer.indexOf('PitwallDisputeDetector.detect(');
  const iLocal = renderer.indexOf('PitwallLocalIntentRouter.route(');
  check('dispute 判定が軸判定（localIntent）より前にある',
    iDispute > 0 && iLocal > 0 && iDispute < iLocal, { iDispute, iLocal });

  check('検出したら受領と撤回を両方呼ぶ',
    renderer.includes('B.acknowledge(cmBox,item.item_id') && renderer.includes('B.retract(cmBox,item.item_id'));
  check('同一軸の未解決へ束ねる（再提出を新規にしない）',
    renderer.includes('B.findOpenByAxis(cmBox,disputeHit.axis)'));
  check('反射は timeline へ記録し turns へ入れない',
    renderer.includes('recordReflexEvent(_reflex)')
    && renderer.includes("addReflex(box,{kind:ev.kind"));
  check('反射の権威フラグを Bridge 由来かで決める',
    renderer.includes("authoritative:ev.source==='bridge_telemetry'"));
  check('箱を localStorage へ永続化する（再起動で消えない）',
    renderer.includes("localStorage.setItem(CONVO_BOX_KEY"));
  check('診断が残る（DISPUTE_DETECTED / DISPUTE_ACK / CONVO_BOX）',
    renderer.includes("'DISPUTE_DETECTED'") && renderer.includes("'DISPUTE_ACK'")
    && renderer.includes("'CONVO_BOX'"));

  // renderer の session key 関数を取り出して実行する（別 session 混入0の担保）
  const src = renderer.match(/function conversationSessionKey\(\)\{[\s\S]*?\n\}/);
  check('conversationSessionKey を取り出せる', !!src);
  if (src) {
    const ctx = {
      currentMemoryUserId: () => 'Yuji', userName: 'Yuji',
      lastSessionNum: 2, lastSessionType: 'Race',
      lastTrack: 'Le Mans', lastCarModel: 'AMG', lastCarClass: 'GT3',
    };
    vm.createContext(ctx);
    vm.runInContext(src[0] + '\nthis.f = conversationSessionKey;', ctx);
    const k1 = ctx.f();
    ctx.lastSessionNum = 3;
    const k2 = ctx.f();
    check('session が変われば key が変わる（前 session の訂正を持ち越さない）',
      k1 !== k2, { k1, k2 });
    check('key に driver / session / track / car が入る',
      k1.includes('Yuji') && k1.includes('Race') && k1.includes('Le Mans') && k1.includes('AMG'), k1);
  }
}

// ── ⑨ 実経路テスト（Codex差戻し②：Lunaの全出力が箱へ入るか） ──────────
// `recordLunaTurn()` は定義されていたが **41箇所ある addMsg('ai',…) のどこからも
// 呼ばれていなかった**。その状態では `lunaTurns` が常に空で、検出は本番で成立しない。
// ここでは renderer から addMsg / recordLunaTurn / ensureConversationBox を
// **取り出して実行**し、実際の1ターンの流れを通す。存在検査はしない。
console.log('\n══ 実経路：Luna の全出力が箱へ入り、次のターンで訂正が成立するか ══');
{
  const vm = require('vm');
  const renderer = fs.readFileSync(path.join(__dirname, 'desktop', 'renderer.html'), 'utf8');
  const grab = (name) => {
    const m = renderer.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}'));
    return m ? m[0] : null;
  };
  const parts = ['addMsg', 'recordLunaTurn', 'ensureConversationBox',
                 'saveConversationBox', 'conversationSessionKey', 'convoLog'].map(grab);
  check('renderer から実経路の関数群を取り出せる', parts.every(Boolean),
    parts.map((p, i) => p ? 'ok' : ['addMsg','recordLunaTurn','ensureConversationBox',
      'saveConversationBox','conversationSessionKey','convoLog'][i]));

  if (parts.every(Boolean)) {
    const store = {};
    const ctx = {
      window: { PitwallConversationMemoryBox: box, PitwallDisputeDetector: det },
      localStorage: {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
      },
      document: {
        getElementById: () => ({ appendChild(){}, scrollTop: 0, scrollHeight: 0 }),
        createElement: () => ({ className: '', textContent: '' }),
      },
      currentMemoryUserId: () => 'Yuji', userName: 'Yuji',
      lastSessionNum: 2, lastSessionType: 'Race', lastTrack: 'Red Bull Ring',
      lastCarModel: 'AMG', lastCarClass: 'GT3',
      irBridge: null, diagnosticLog: () => {}, mirrorToOverlay: () => {},
      console: { log: () => {} },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    // renderer のモジュールスコープ変数も同じ順で取り出す（関数だけでは動かない）
    const decls = (renderer.match(/const CONVO_BOX_KEY='[^']+';/) || [''])[0]
      + '\n' + (renderer.match(/let _convoBox=null;/) || [''])[0];
    check('箱のモジュール変数も renderer から取り出せる',
      decls.includes('CONVO_BOX_KEY') && decls.includes('_convoBox'), decls);
    vm.runInContext(decls + '\n' + parts.join('\n')
      + '\nthis.addMsg=addMsg; this.ensureConversationBox=ensureConversationBox;', ctx);

    // ── 実際の1ターン：Luna が値を言う → ドライバーが訂正する ──
    ctx.addMsg('ai', '後ろ0.0秒。');            // ← 製品と同じ出口を通す
    const b = ctx.ensureConversationBox();
    check('Luna の発話が addMsg 経由で箱へ入る',
      b && b.turns.length === 1 && b.turns[0].who === 'luna', b && b.turns);
    check('箱が localStorage へ書かれる',
      typeof store['pw_conversation_box_v1'] === 'string', Object.keys(store));

    // 次のターンで検出器へ渡る形になっているか（本番と同じ組み立て）
    const lunaTurns = box.turnContext(b, Date.now()).filter(t => t.who === 'luna');
    check('次ターンの lunaTurns が空でない（ここが空だと検出は永遠に成立しない）',
      lunaTurns.length === 1, lunaTurns.length);

    const hit = det.detect('後ろ2.0 だね。ギャップ。',
      { lunaTurns, reflexes: box.reflexContext(b, Date.now()), at: Date.now() });
    check('実経路で組んだ文脈から訂正が検出される',
      !!hit && hit.confidence === 'confirmed', hit);
    check('訂正の軸が直前の Luna 発話から決まる',
      hit && hit.axis === 'gap_behind', hit && hit.axis);

    // 41箇所すべてが addMsg を通ることの担保：個別呼び出しを足していない。
    // コメント行は数えない（`recordLunaTurn()` を説明で書いている箇所がある）。
    const codeLines = renderer.split('\n').filter(l => !/^\s*(\/\/|\*|#)/.test(l));
    const direct = codeLines.filter(l => /recordLunaTurn\(/.test(l)).length;
    // Codex §10 が挙げた Luna 出力の出口は3つ。
    //   ①ストリーミング完了 ②Truth Gate fallback（display 経由で①と同じ）③通信エラー
    // 実呼出し = 定義1 + addMsg1(定型応答) + stream1 + error1 = 4。
    // この数を固定するのは、出口が増えた時に**気づかず取りこぼす**のを防ぐため
    // （9/3 に addMsg だけで足りると決めつけて通常回答を丸ごと落とした）。
    check('recordLunaTurn の実呼出しは4箇所だけ（41箇所へ散らさない）',
      direct === 4, { direct, lines: codeLines.filter(l => /recordLunaTurn\(/.test(l)).map(l => l.trim().slice(0, 60)) });
  }
}

// ── ⑩ ストリーミング回答の保存（Codex差戻し③） ────────────────────────
// 通常の Luna 回答は `addMsg('ai','')` で **空文字**の吹き出しを先に作り、
// 中身をストリームで埋める。したがって addMsg 側の `if(text && ...)` では
// **通常回答が一度も保存されない**。保存されるのは定型応答だけだった。
console.log('\n══ ストリーミング回答が箱へ入るか ══');
{
  const vm = require('vm');
  const renderer = fs.readFileSync(path.join(__dirname, 'desktop', 'renderer.html'), 'utf8');

  // 空文字で呼ぶと保存されないこと自体を、実行で確かめる（差戻しの再現）
  const grab = (name) => {
    const m = renderer.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}'));
    return m ? m[0] : null;
  };
  const decls = (renderer.match(/const CONVO_BOX_KEY='[^']+';/) || [''])[0]
    + '\n' + (renderer.match(/let _convoBox=null;/) || [''])[0];
  const parts = ['addMsg', 'recordLunaTurn', 'ensureConversationBox',
                 'saveConversationBox', 'conversationSessionKey', 'convoLog'].map(grab);
  const store = {};
  const ctx = {
    window: { PitwallConversationMemoryBox: box, PitwallDisputeDetector: det },
    localStorage: { getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); } },
    document: { getElementById: () => ({ appendChild(){}, scrollTop: 0, scrollHeight: 0 }),
      createElement: () => ({ className: '', textContent: '' }) },
    currentMemoryUserId: () => 'Yuji', userName: 'Yuji',
    lastSessionNum: 7, lastSessionType: 'Race', lastTrack: 'Le Mans',
    lastCarModel: 'AMG', lastCarClass: 'GT3',
    irBridge: null, diagnosticLog: () => {}, mirrorToOverlay: () => {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(decls + '\n' + parts.join('\n')
    + '\nthis.addMsg=addMsg; this.recordLunaTurn=recordLunaTurn; this.ensureConversationBox=ensureConversationBox;', ctx);

  const bubble = ctx.addMsg('ai', '');     // ← ストリーミング開始（空文字）
  const afterEmpty = ctx.ensureConversationBox();
  check('空文字の吹き出しは箱へ入らない（差戻しの原因を再現）',
    afterEmpty.turns.length === 0, afterEmpty.turns.length);

  // ストリーム完了：本番と同じく recordLunaTurn(display,'streamed_reply') を呼ぶ
  ctx.recordLunaTurn('後ろ0.0秒。前とは1.2秒。', 'streamed_reply');
  const b = ctx.ensureConversationBox();
  check('ストリーム完了時に一度だけ箱へ入る',
    b.turns.length === 1 && b.turns[0].who === 'luna', b.turns);
  check('kind に streamed_reply が残る（定型応答と区別できる）',
    b.turns[0].kind === 'streamed_reply', b.turns[0].kind);

  // その文脈で次ターンの訂正が成立するか（差戻し③の本体）
  const lunaTurns = box.turnContext(b, Date.now()).filter(t => t.who === 'luna');
  const hit = det.detect('後ろ2.0 だね。ギャップ。',
    { lunaTurns, reflexes: box.reflexContext(b, Date.now()), at: Date.now() });
  check('ストリーミング回答を文脈に、次ターンの訂正が検出される',
    !!hit && hit.confidence === 'confirmed' && hit.axis === 'gap_behind', hit);

  // 配線側：完了出口に接続されているか（存在ではなく位置で見る）
  const iStream = renderer.indexOf("recordLunaTurn(display, 'streamed_reply')");
  const iConvo = renderer.indexOf("convoLog('ai', display)");
  check('ストリーム完了出口（convoLog と同じ場所）に接続されている',
    iStream > 0 && iConvo > 0 && Math.abs(iStream - iConvo) < 800, { iStream, iConvo });
  const codeLines = renderer.split('\n').filter(l => !/^\s*(\/\/|\*|#)/.test(l));
  const calls = codeLines.filter(l => /recordLunaTurn\(/.test(l)).length;
  check('実呼出しは 定義1＋addMsg1＋stream1＋error1 の計4箇所',
    calls === 4, { calls, lines: codeLines.filter(l => /recordLunaTurn\(/.test(l)).map(l => l.trim().slice(0, 56)) });
}

console.log(`\n[conversation memory box] 合格 ${pass} / 不合格 ${fail}`);
process.exit(fail ? 1 : 0);
