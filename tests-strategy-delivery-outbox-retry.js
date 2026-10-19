#!/usr/bin/env node
'use strict';
// WO015（独立反証「owner同dispatch順序」）：strategyDeliveryOutboxの実送信/ACK
// 経路を実関数（renderer.htmlから抽出、neutral stubはWebSocket/diagnosticLog
// だけ）で検証する。外部有料API呼び出し0。
//
// 1. Bridgeが同dispatchの'audible'をまだ確認していない間に届いた
//    'audible_completed'をfail-closedで'stale'とACKした時、Desktopはこの
//    確証的事実の再送を諦めない（他の恒久的stale原因とは区別する）。
// 2. 接続復帰（'connected'メッセージ）がstrategyResponseOutbox/
//    strategyDeliveryOutboxを実際に再送する——既存コメントが主張していた
//    挙動が実配線として存在することを証明する（以前は主張のみで配線無し）。

const fs = require('fs');
const vm = require('vm');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : ' -> ' + JSON.stringify(detail)));
  ok ? pass++ : fail++;
}

// ★WO015残条件A「fixture正当性」修復：旧`\n\}\n`探索は一行関数（例：
// utteranceTraceFor）だと本体内に`\n}`が無く、次の関数の末尾まで意図せず
// 読み進めてしまう。文字列/コメント内の`{`/`}`を無視し、パラメータリストの
// 既定値が持つ`{}`（例：`extra={}`）にも惑わされない、1関数だけを境界で
// 止める抽出へ置き換える。
function extractFromSrc(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index;
  let pi = m.index + m[0].length, parenDepth = 1, pInStr = null;
  for (; pi < src.length; pi++) {
    const ch = src[pi];
    if (pInStr) { if (ch === '\\') { pi++; continue; } if (ch === pInStr) pInStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { pInStr = ch; continue; }
    if (ch === '(') parenDepth++;
    else if (ch === ')') { parenDepth--; if (parenDepth === 0) { pi++; break; } }
  }
  const braceStart = src.indexOf('{', pi);
  if (braceStart < 0) return null;
  let depth = 0, inStr = null, inLineComment = false, inBlockComment = false, prev = '';
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (inLineComment) { if (ch === '\n') inLineComment = false; prev = ch; continue; }
    if (inBlockComment) { if (prev === '*' && ch === '/') inBlockComment = false; prev = ch; continue; }
    if (inStr) {
      if (ch === '\\') { i++; prev = ''; continue; }
      if (ch === inStr) inStr = null;
      prev = ch; continue;
    }
    if (ch === '/' && src[i + 1] === '/') { inLineComment = true; prev = ch; continue; }
    if (ch === '/' && src[i + 1] === '*') { inBlockComment = true; prev = ch; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; prev = ch; continue; }
    if (ch === '{') { depth++; prev = ch; continue; }
    if (ch === '}') { depth--; prev = ch; if (depth === 0) return src.slice(start, i + 1); continue; }
    prev = ch;
  }
  return null;
}
function grabFn(name) { return extractFromSrc(renderer, name); }

const names = ['strategyResponseKey', 'strategyDeliveryKey', 'flushStrategyDeliveryOutbox',
  'sendStrategyDecisionDelivery', 'handleStrategyDeliveryAck', 'strategyProposalAudibleCompletedAt',
  'strategyDeliveryReceiptFor',
  // ★WO015残条件A：handleStrategyDeliveryAckが実際に呼ぶutteranceTraceFor()を
  // 未定義のまま放置すると、utteranceIdを持つentryのACK経路でReferenceErrorに
  // なる（以前はこの分岐へ到達するテストが無く露見しなかった）。
  'utteranceTrace', 'utteranceTraceFor'];
const srcs = names.map(grabFn);
check('全対象関数がrenderer.htmlから抽出できる', srcs.every(Boolean), names.filter((n, i) => !srcs[i]));
if (!srcs.every(Boolean)) { console.log(`\n[strategy-delivery-outbox-retry] 合格 ${pass} / 不合格 ${fail}`); process.exit(fail ? 1 : 0); }

function makeCtx() {
  const sent = [];
  const logs = [];
  // Controllable fake clock: Date.now()-granularity real-time can make two
  // handleStrategyDeliveryAck() calls land in the SAME millisecond, hiding a
  // bug where a later call wrongly re-advances the owner-confirmed timestamp
  // (the assertion would pass by coincidence either way). advanceClock()
  // lets a test prove the timestamp is genuinely preserved, not just equal
  // by millisecond luck.
  let _now = 1_700_000_000_000;
  class FakeDate extends Date {
    constructor(...a) { if (!a.length) super(_now); else super(...a); }
    static now() { return _now; }
  }
  const ctx = {
    strategyDeliveryOutbox: new Map(),
    strategyDeliveryReceipts: new Map(),
    // handleStrategyDeliveryAck now also records owner-ack confirmation onto
    // the SAME tracked-proposal map sendStrategyDecisionResponse() reads.
    bridgeStrategyDecisions: new Map(),
    diagnosticLog: (kind, msg) => logs.push(kind + ' ' + msg),
    irBridge: { readyState: 1, send: (s) => sent.push(JSON.parse(s)) },
    Date: FakeDate,
    // ★WO015残条件A：実utteranceTrace/utteranceTraceForと同じbounded state
    // （utteranceTraceLog/UTTERANCE_TRACE_MAX）を実物と同じ初期値で持たせる。
    utteranceTraceLog: [], UTTERANCE_TRACE_MAX: 200,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(srcs.join('\n'), ctx);
  ctx.__advanceClock = (ms) => { _now += ms; };
  return { ctx, sent, logs };
}

// ── 1. Codex実測反例そのもの: completedのstale ACKは再送を諦めない ──
{
  const { ctx, sent } = makeCtx();
  ctx.sendStrategyDecisionDelivery('d1', 1, 'audible_completed', 'd1#1');
  check('completedは即座に1回送信される', sent.length === 1 && sent[0].outcome === 'audible_completed');

  // Bridgeがまだ'audible'を確認していない間に届いたという想定のfail-closed ACK。
  ctx.handleStrategyDeliveryAck({ decision_id: 'd1', session_num: 1, dispatch_id: 'd1#1',
    outcome: 'audible_completed', applied: 'stale' });
  check('stale(completed)後もoutboxにcompleted entryが残る（再送を諦めない）',
    ctx.strategyDeliveryOutbox.has('1|d1#1|audible_completed'));

  // 接続復帰：Bridge側で後からaudibleが適用され、今回はcompletedが本当に適用される。
  ctx.flushStrategyDeliveryOutbox();
  check('接続復帰のflushで同じcompletedが再送される', sent.length === 2 && sent[1].outcome === 'audible_completed');
  ctx.handleStrategyDeliveryAck({ decision_id: 'd1', session_num: 1, dispatch_id: 'd1#1',
    outcome: 'audible_completed', applied: 'audible_completed' });
  check('適用成功ACKで今度こそoutboxから消える',
    !ctx.strategyDeliveryOutbox.has('1|d1#1|audible_completed'));
}

// ── 2. 恒久的stale（提案自体が無関係化）は他のoutcomeと同様に即削除される ──
{
  const { ctx, sent } = makeCtx();
  ctx.sendStrategyDecisionDelivery('d2', 1, 'dropped_before_audible', 'd2#1');
  check('droppedは即座に1回送信される', sent.length === 1);
  ctx.handleStrategyDeliveryAck({ decision_id: 'd2', session_num: 1, dispatch_id: 'd2#1',
    outcome: 'dropped_before_audible', applied: 'stale' });
  check('dropped+staleは即削除される（completed専用の保持ルールを他outcomeへ広げない）',
    !ctx.strategyDeliveryOutbox.has('1|d2#1|dropped_before_audible'));
}
{
  const { ctx } = makeCtx();
  ctx.sendStrategyDecisionDelivery('d3', 1, 'audible_completed', 'd3#1');
  ctx.handleStrategyDeliveryAck({ decision_id: 'd3', session_num: 1, dispatch_id: 'd3#1',
    outcome: 'audible_completed', applied: 'no_match' });
  check('completed+no_match（提案自体が無い）は保持せず削除される（stale専用の保持ルール）',
    !ctx.strategyDeliveryOutbox.has('1|d3#1|audible_completed'));
}

// ── 3. 接続復帰('connected')が実際にflushStrategyResponseOutbox/
//      flushStrategyDeliveryOutboxを呼ぶ配線そのものを、renderer.htmlの
//      ソーステキストで直接確認する（複数の既存コメントが主張していた挙動に
//      実配線が無かった欠陥そのもの）。
{
  const connectedBlockStart = renderer.indexOf("if(data.type==='connected'){");
  const connectedBlockEnd = renderer.indexOf('\n      }', connectedBlockStart);
  const block = renderer.slice(connectedBlockStart, connectedBlockEnd);
  check('connectedハンドラがflushStrategyResponseOutbox()を呼ぶ', block.includes('flushStrategyResponseOutbox()'));
  check('connectedハンドラがflushStrategyDeliveryOutbox()を呼ぶ', block.includes('flushStrategyDeliveryOutbox()'));
}

// ── 3続（独立反証「接続維持中stale completed ACK後の再送出口は未接続」）：
//    on-reconnectだけでなく、接続が切れずに繋がり続けている間も
//    canonical_lifecycle_snapshot（接続中は毎poll届く）がdriverPlanCommand/
//    boxAuthorityTransportと同じ「生きている間ずっと再送」出口を
//    strategyResponseOutbox/strategyDeliveryOutboxにも提供することを、
//    renderer.htmlのソーステキストで直接確認する。
{
  const snapLineStart = renderer.indexOf("if(data.type==='canonical_lifecycle_snapshot')");
  const snapLineEnd = renderer.indexOf("return;}", snapLineStart) + 'return;}'.length;
  const block = renderer.slice(snapLineStart, snapLineEnd);
  check('canonical_lifecycle_snapshotハンドラ（接続中は毎poll）がflushStrategyResponseOutbox()を呼ぶ',
    block.includes('flushStrategyResponseOutbox()'));
  check('canonical_lifecycle_snapshotハンドラ（接続中は毎poll）がflushStrategyDeliveryOutbox()を呼ぶ',
    block.includes('flushStrategyDeliveryOutbox()'));
}

// ── 4. 独立反証「local strategyProposalAudibleCompletedAtはaudio callback
//      時刻でownerACK結果ではない」: ローカルの音声終了観測
//      (audibleCompletedLocallyAt、onDeliveryの'completed'分岐が付記する)
//      だけでは owner readback口は何も返さない。Bridgeの実ACK
//      (applied==='audible_completed') を受けた後だけ、readbackが初めて
//      真の値を返す——「owner完了scalar→ACK receipt→sameVM readback」。
{
  const { ctx } = makeCtx();
  // onSpoken相当：提案が追跡開始される（production同形、dispatchId一致）。
  ctx.bridgeStrategyDecisions.set('d4', { sessionNum: 1, dispatchId: 'd4#1' });
  // ★独立反証「complete absence is UNKNOWN, never legacy」：owner確定を
  // readbackできる前提として、実際に配送をqueueしたentry（この場合は
  // legacy形=utterance_id無し）が存在しなければならない——entry/receipt
  // が一度も無いACKはunknownとしてfail-closed（別test群で確認）。
  ctx.sendStrategyDecisionDelivery('d4', 1, 'audible_completed', 'd4#1');
  check('ACK前：owner readbackはnull（まだ何も確定していない）',
    ctx.strategyProposalAudibleCompletedAt('d4') === null);

  // onDelivery('completed')相当：ローカル音声終了のみ記録（production同形の
  // フィールド名・形）。owner確定フィールドではない。
  const _localOnly = ctx.bridgeStrategyDecisions.get('d4');
  ctx.bridgeStrategyDecisions.set('d4', { ..._localOnly, audibleCompletedLocallyAt: Date.now() });
  check('ローカル音声終了だけではowner readbackはまだnull（audio callback時刻をownerACKと取り違えない）',
    ctx.strategyProposalAudibleCompletedAt('d4') === null);

  // Bridgeの実ACK: applied==='audible_completed'。
  ctx.handleStrategyDeliveryAck({ decision_id: 'd4', session_num: 1, dispatch_id: 'd4#1',
    outcome: 'audible_completed', applied: 'audible_completed' });
  check('Bridge ACK後：owner readbackが真の値を返す（同VM readback成立）',
    typeof ctx.strategyProposalAudibleCompletedAt('d4') === 'number');

  // stale ACK（順序不整合）は owner確定を作らない。
  const { ctx: ctx2 } = makeCtx();
  ctx2.bridgeStrategyDecisions.set('d5', { sessionNum: 1, dispatchId: 'd5#1' });
  ctx2.handleStrategyDeliveryAck({ decision_id: 'd5', session_num: 1, dispatch_id: 'd5#1',
    outcome: 'audible_completed', applied: 'stale' });
  check('staleとACKされた場合はowner readbackが立たない（fail-closed、誤った確定を作らない）',
    ctx2.strategyProposalAudibleCompletedAt('d5') === null);
}

// ── 5. WO015反例修復「scalarACK completion not sameIDreceipt」:
//    sendStrategyDecisionDeliveryが実際にspeak()へ渡ったutterance_id/
//    text_hashをwireへ運び、Bridgeが同じ識別子を返したACKだけがowner確定
//    readbackへ昇格する。decision/session/dispatch/outcome/appliedの
//    scalarが一致してもutterance_idが別物の遅延ACKは確定へ昇格させない
//    （fail-closed）。古いBridge/checkpoint互換（ackにutterance_id自体が
//    無い）では従来通りscalar一致だけで確定する——新フィールドを必須化して
//    legacy ACKを壊さない。
{
  const { ctx, sent } = makeCtx();
  ctx.sendStrategyDecisionDelivery('d6', 1, 'audible', 'd6#1', 'u-real', 'hash-real');
  check('utterance_id/text_hashが実送信wireへ乗る',
    sent[0].utterance_id === 'u-real' && sent[0].text_hash === 'hash-real');
  check('outbox entryにもutterance_id/text_hashが残る（再送時も同じ識別子を運ぶ）',
    ctx.strategyDeliveryOutbox.get('1|d6#1|audible').utteranceId === 'u-real'
    && ctx.strategyDeliveryOutbox.get('1|d6#1|audible').textHash === 'hash-real');

  ctx.bridgeStrategyDecisions.set('d6', { sessionNum: 1, dispatchId: 'd6#1' });
  ctx.sendStrategyDecisionDelivery('d6', 1, 'audible_completed', 'd6#1', 'u-real', 'hash-real');
  // 同一utterance_id/text_hashで一致するACK -> owner確定readbackへ昇格する。
  ctx.handleStrategyDeliveryAck({ decision_id: 'd6', session_num: 1, dispatch_id: 'd6#1',
    outcome: 'audible_completed', applied: 'audible_completed', utterance_id: 'u-real', text_hash: 'hash-real' });
  check('utterance_id/text_hashが一致するACKはowner確定readbackへ昇格する',
    typeof ctx.strategyProposalAudibleCompletedAt('d6') === 'number');
}
{
  const { ctx } = makeCtx();
  ctx.bridgeStrategyDecisions.set('d7', { sessionNum: 1, dispatchId: 'd7#1' });
  ctx.sendStrategyDecisionDelivery('d7', 1, 'audible_completed', 'd7#1', 'u-real', 'hash-real');
  // scalar(decision/session/dispatch/outcome/applied)は一致するが、utterance_id
  // が別物の遅延ACK（別本文/別attemptの取り違え）は確定へ昇格させない。
  ctx.handleStrategyDeliveryAck({ decision_id: 'd7', session_num: 1, dispatch_id: 'd7#1',
    outcome: 'audible_completed', applied: 'audible_completed', utterance_id: 'u-other', text_hash: 'hash-real' });
  check('utterance_idが不一致のACKはscalarが揃っていてもowner確定へ昇格しない（fail-closed）',
    ctx.strategyProposalAudibleCompletedAt('d7') === null);
  // ★WO015反例修復（独立quota-stop review「outbox removed even metadata
  //   mismatch」）：以前はここでoutcome/appliedのscalar一致だけでoutboxから
  //   削除していた（このtestが以前主張していた「二重送信にはしない」）。
  //   しかしBOX側ack()と非対称で、再送自体はBridge apply_report()の既存
  //   report_event_id冪等性（同一本文ならretry_no_op）で元々安全——
  //   utterance不一致を「このACKはこのentryの確証ではない」まで判定した
  //   以上、削除してentryの再送機会を失わせる必要がない。保持して次flush
  //   で再送し、本当に一致するACKが来るまでscalar確定を遅らせる。
  check('utterance不一致のACKはowner確定もoutbox削除もしない（fail-closed、別utteranceの誤配線で再送機会を失わない）',
    ctx.strategyDeliveryOutbox.has('1|d7#1|audible_completed'));
}
{
  // ★WO015再反例修復（独立quota-stop review「_bothHaveUtterance is false
  //   because modern local entry has UID but ACK omits it -> permissive
  //   fallback」）：以前の_bothHaveUtterance（entry側とACK側の両方が
  //   utterance_idを持つ時だけ厳密比較）は、ACK側がutterance_id自体を省略
  //   するだけでentry側の実identityチェックを回避できた——legacy Bridge
  //   互換の意図を、たまたまACKがIDを欠いた現代のentryにまで誤って適用して
  //   いた。legacy/scalar-only資格は「entry自身が最初からutterance_idを
  //   持たない」場合だけに限定する（_localHasUtterance）。
  const { ctx } = makeCtx();
  ctx.bridgeStrategyDecisions.set('d8', { sessionNum: 1, dispatchId: 'd8#1' });
  // modern entry（送信時に実utterance_id/text_hashを持つ）に対し、ACK側が
  // それらのfieldを欠いたまま返ってきた（legacy Bridgeか単なる欠落かは
  // ここで区別できない）——scalar一致だけでこのentryのidentityを事後的に
  // 発明してはならない。
  ctx.sendStrategyDecisionDelivery('d8', 1, 'audible_completed', 'd8#1', 'u-real', 'hash-real');
  ctx.handleStrategyDeliveryAck({ decision_id: 'd8', session_num: 1, dispatch_id: 'd8#1',
    outcome: 'audible_completed', applied: 'audible_completed' });
  check('modern entry（実utterance_id保持）宛にACK側がmetadataを欠いたまま返ってきた場合、owner確定へ昇格しない（fail-closed）',
    ctx.strategyProposalAudibleCompletedAt('d8') === null);
  check('同ケースでoutboxからも削除しない（再送機会を失わせない）',
    ctx.strategyDeliveryOutbox.has('1|d8#1|audible_completed'));
}
{
  // 本当のlegacy（entry自身が最初からutterance_id/text_hashを持たない――
  // この機能より前にenqueueされたpendingか、送信元がIDを渡さなかった場合）
  // だけがscalar一致のみでowner確定する後方互換パス。
  const { ctx } = makeCtx();
  ctx.bridgeStrategyDecisions.set('d9', { sessionNum: 1, dispatchId: 'd9#1' });
  ctx.sendStrategyDecisionDelivery('d9', 1, 'audible_completed', 'd9#1');
  check('entry自身がutterance_idを持たないことの確認',
    ctx.strategyDeliveryOutbox.get('1|d9#1|audible_completed').utteranceId === null);
  ctx.handleStrategyDeliveryAck({ decision_id: 'd9', session_num: 1, dispatch_id: 'd9#1',
    outcome: 'audible_completed', applied: 'audible_completed' });
  check('entry自身がutterance_idを持たないoriginal legacyケースは従来どおりscalar一致だけでowner確定する（後方互換）',
    typeof ctx.strategyProposalAudibleCompletedAt('d9') === 'number');
  check('legacyケースはoutboxから正しく削除される',
    !ctx.strategyDeliveryOutbox.has('1|d9#1|audible_completed'));
  // ★WO015残条件A「metadata-less legacy honest unknown」：entry自身が
  // utterance_idを持たない本当のlegacyは、trace照合対象自体が存在しない
  // ——存在しないsource/本文を発明せず、originalText/finalText/role/
  // scope/kindは全てnullのまま（textHash/outcome/applied等のscalarは
  // 従来通り保持する）。
  const legacyReceipt = ctx.strategyDeliveryReceiptFor(1, 'd9#1', 'audible_completed');
  check('legacyケースのreceiptはoriginalText/finalText/role/scope/kindを発明せず全てnull（honest unknown）',
    legacyReceipt && legacyReceipt.originalText === null && legacyReceipt.finalText === null
    && legacyReceipt.originalTextHash === null && legacyReceipt.finalTextHash === null
    && legacyReceipt.role === null && legacyReceipt.scope === null && legacyReceipt.kind === null);
}
{
  // ★WO015反例修復（独立quota-stop review「duplicate/unsolicited ACK:
  //   explicit priorreceipt idempotence identity not stored」）：entryが
  //   既に正しくretireされた後、同じkeyへ別utteranceの重複/誤配線ACKが
  //   届いても、保持したreceiptのidentityと照合してscalarだけでの
  //   再確定をしない（entry自体はもう無いので「保持」はできないが、
  //   少なくとも誤ったowner確定timestampの上書きはしない）。
  const { ctx, logs } = makeCtx();
  ctx.bridgeStrategyDecisions.set('d10', { sessionNum: 1, dispatchId: 'd10#1' });
  // ★WO015残条件A「GAP candidate→finalrebuild coherent」：実speak()/
  // drainQueueと同じ契約を直接trace呼出しで再現する——'generated'は
  // speak()時点の元候補本文（GAP authority rebuild前）、終端stateは実際に
  // TTS/historyへ渡った最終本文（rebuild後）。両者は意図的に別本文にして
  // おり、receiptが混同しないことを証明する。
  ctx.utteranceTrace('u-real', 'generated',
    { source: { role: 'canonical', scope: 's-d10' }, textHash: 'hash-candidate',
      text: 'Undercut candidate. Pit next lap, set 10 liters.', kind: 'bridge_strategy_proposal' });
  ctx.utteranceTrace('u-real', 'audible_completed',
    { source: { role: 'canonical', scope: 's-d10' }, textHash: 'hash-real',
      text: 'Undercut candidate. Pit next lap, set 24 liters.', kind: 'bridge_strategy_proposal' });
  ctx.sendStrategyDecisionDelivery('d10', 1, 'audible_completed', 'd10#1', 'u-real', 'hash-real');
  ctx.handleStrategyDeliveryAck({ decision_id: 'd10', session_num: 1, dispatch_id: 'd10#1',
    outcome: 'audible_completed', applied: 'audible_completed', utterance_id: 'u-real', text_hash: 'hash-real' });
  const firstAt = ctx.strategyProposalAudibleCompletedAt('d10');
  check('正しい最初のACKでowner確定する', typeof firstAt === 'number');
  check('retire直後、保持receiptに実identityが残る',
    ctx.strategyDeliveryReceipts.get('1|d10#1|audible_completed').utteranceId === 'u-real');
  // ★独立反証「No source/scope/outcome/applied/firstconfirmedtime/receipt
  //   getter」：bounded receiptをkey形式を知らずに検査できるexplicit accessor。
  const receipt = ctx.strategyDeliveryReceiptFor(1, 'd10#1', 'audible_completed');
  check('explicit getterが元のdecisionId/sessionNum/dispatchId/outcome/appliedをfrozenで返す',
    receipt && receipt.decisionId === 'd10' && receipt.sessionNum === 1 && receipt.dispatchId === 'd10#1'
    && receipt.outcome === 'audible_completed' && receipt.applied === 'audible_completed'
    && Object.isFrozen(receipt));
  check('explicit getterが実際にTTS/historyへ渡った最終本文(finalText)をexact readbackできる',
    receipt.finalText === 'Undercut candidate. Pit next lap, set 24 liters.'
    && receipt.finalTextHash === 'hash-real' && receipt.scope === 's-d10' && receipt.role === 'canonical'
    && receipt.kind === 'bridge_strategy_proposal' && typeof receipt.firstConfirmedAt === 'number');
  check('元候補本文(originalText)は最終本文と別々に保持され、新しいproofを古いLLM本文へ付け替えない',
    receipt.originalText === 'Undercut candidate. Pit next lap, set 10 liters.'
    && receipt.originalTextHash === 'hash-candidate' && receipt.originalText !== receipt.finalText);

  // 同じkey・同じscalar(outcome/applied/dispatch_id)だが別utteranceの
  // 遅延/誤配線ACKが後から届く——entryはもう無いのでoutboxでは検出できない、
  // 保持receiptとの照合だけがこれを捉える（timer精度に頼らずdiagnosticLogの
  // same_utterance判定文字列そのものを見る）。
  logs.length = 0;
  ctx.handleStrategyDeliveryAck({ decision_id: 'd10', session_num: 1, dispatch_id: 'd10#1',
    outcome: 'audible_completed', applied: 'audible_completed', utterance_id: 'u-other', text_hash: 'hash-real' });
  check('retire後の別utterance重複ACKはsame_utterance=falseとfail-closed判定される（保持receiptとの照合）',
    logs.some(l => l.includes('same_utterance=false')));

  // 本当に同一（genuinely idempotent）な重複ACKは無害——保持receiptと一致。
  // ★独立反証「duplicate exact receipt no-op preserve first timestamp」：
  //   この重複が最初の確定時刻を新しいDate.now()で上書きしないことまで
  //   確認する（same_utterance=trueだけでは上書きの有無を区別できない）。
  //   fake clockを進めてから重複ACKを送る——real-time Date.now()では同じ
  //   ミリ秒に収まり偶然passする可能性があった。
  ctx.__advanceClock(5000);
  logs.length = 0;
  ctx.handleStrategyDeliveryAck({ decision_id: 'd10', session_num: 1, dispatch_id: 'd10#1',
    outcome: 'audible_completed', applied: 'audible_completed', utterance_id: 'u-real', text_hash: 'hash-real' });
  check('完全に同一な重複ACKはsame_utterance=trueのままidempotent（害が無い）',
    logs.some(l => l.includes('same_utterance=true')));
  check('完全に同一な重複ACKは最初の確定時刻を上書きしない（preserve first timestamp）',
    ctx.strategyProposalAudibleCompletedAt('d10') === firstAt);
}
{
  // ★独立反証「Unknown entry+receipt still _localHasUtterance false ->
  //   _sameUtterance true; tracked matching dispatch can promote completed
  //   timestamp without any actual local report for this outcome」：
  //   entry/receiptのどちらも一度も存在しないACK（本当に未知）は、たとえ
  //   bridgeStrategyDecisionsの追跡dispatchIdがscalar一致しても、owner確定
  //   へ昇格してはならない——「entry自身がutterance_idを持たない正当な
  //   legacy」とは全く別のケース。
  const { ctx } = makeCtx();
  ctx.bridgeStrategyDecisions.set('d11', { sessionNum: 1, dispatchId: 'd11#1' });
  // 'd11'宛のaudible_completedは一度もsendStrategyDecisionDelivery()で
  // queueされていない（entryも無い）し、過去にretireされてreceiptが残って
  // いるわけでもない——完全に未知のACK。
  ctx.handleStrategyDeliveryAck({ decision_id: 'd11', session_num: 1, dispatch_id: 'd11#1',
    outcome: 'audible_completed', applied: 'audible_completed' });
  check('entry/receiptのどちらも無い完全に未知のACKはowner確定へ昇格しない（fail-closed、scalar一致だけでは発明しない）',
    ctx.strategyProposalAudibleCompletedAt('d11') === null);
  check('未知ACKに対するexplicit getterはnullを返す（何も保持していない）',
    ctx.strategyDeliveryReceiptFor(1, 'd11#1', 'audible_completed') === null);
}
{
  // ★独立review「Modernpacket mustretain necessaryoriginalbody/source
  //   acrossdelayedACK/trace200-entryeviction (freeze/send intoexisting
  //   outbox rather than re-derivecurrentproof)」：ownerACKが遅れる間に、
  //   bounded utteranceTraceLog（上限200件）が別の全く無関係なutterance群に
  //   よって元'generated'entryを本当に追い出した後でも、
  //   sendStrategyDecisionDelivery()が送信直後（eviction影響0の時点）に
  //   outbox entry自身へ既にfreezeしておいたoriginalTextがreceiptへ正しく
  //   残ることを証明する。
  // ★独立root audit「FINAL BODY LOST ON LATE ACK」修復：finalTextも
  //   honestにnullへ縮小するのではなく、GAP rebuild非対応caller
  //   （bridge_strategy_proposal/strategy_plan_box_call）向けのeviction-proof
  //   fallback（original snapshotをfinalとして使う——新しいproofの発明
  //   ではない）で正しく残ることまで確認する。
  const { ctx } = makeCtx();
  ctx.bridgeStrategyDecisions.set('d12', { sessionNum: 1, dispatchId: 'd12#1' });
  ctx.utteranceTrace('u-evict', 'generated',
    { source: { role: 'canonical', scope: 's-evict' }, textHash: 'hash-evict-orig',
      text: 'Original candidate before eviction.', kind: 'bridge_strategy_proposal' });
  // この時点ではまだevictionされていない——送信直後に実際にcaptureできる。
  ctx.sendStrategyDecisionDelivery('d12', 1, 'audible_completed', 'd12#1', 'u-evict', 'hash-evict-orig');
  check('eviction前：outbox entry自身がoriginalText/roleを既にfreezeしている',
    ctx.strategyDeliveryOutbox.get('1|d12#1|audible_completed').originalText === 'Original candidate before eviction.');
  // 全く無関係な250件のutteranceが、bounded utteranceTraceLog（上限200件）
  // から'u-evict'の'generated'entryを本当に追い出す（splice(0,length-MAX)は
  // 先頭=古い順から削る）。
  for (let i = 0; i < 250; i++) {
    ctx.utteranceTrace('u-unrelated-' + i, 'generated', { text: 'unrelated ' + i, kind: 'radio', textHash: 'h' + i });
  }
  check('eviction後：bounded utteranceTraceLogは本当にu-evictのentryを失っている（trace getter単独では逆追跡不能）',
    ctx.utteranceTraceFor('u-evict').length === 0);
  ctx.handleStrategyDeliveryAck({ decision_id: 'd12', session_num: 1, dispatch_id: 'd12#1',
    outcome: 'audible_completed', applied: 'audible_completed', utterance_id: 'u-evict', text_hash: 'hash-evict-orig' });
  const receipt = ctx.strategyDeliveryReceiptFor(1, 'd12#1', 'audible_completed');
  check('eviction後でもreceiptのoriginalText/originalTextHash/role/kindはoutbox由来のeviction-proof fallbackで正しく残る',
    receipt.originalText === 'Original candidate before eviction.' && receipt.originalTextHash === 'hash-evict-orig'
    && receipt.role === 'canonical' && receipt.kind === 'bridge_strategy_proposal', receipt);
  check('finalText/finalTextHashも同じeviction-proof fallbackでoriginalと同一値を返す（GAP rebuild非対応callerではfinal===original、honestなnullへ縮小しない）',
    receipt.finalText === 'Original candidate before eviction.' && receipt.finalTextHash === 'hash-evict-orig');
}
{
  // Permanent fault control: remove only text/kind from the current trace,
  // keeping the actual receipt/ACK implementation and upstream identity.
  // This is a synthetic cut, not historical source bytes or a before-tree run.
  const oldUttTraceSrc = grabFn('utteranceTrace')
    .replace("text:(typeof extra.text==='string')?extra.text:null", 'text:null')
    .replace('kind:extra.kind||null', 'kind:null');
  const oldUttTraceForSrc = grabFn('utteranceTraceFor');
  check('isolated text/kind loss cut actually changes production trace source',
    oldUttTraceSrc !== grabFn('utteranceTrace'));

  function cutScenario(ctx) {
    ctx.bridgeStrategyDecisions.set('d13', { sessionNum: 1, dispatchId: 'd13#1' });
    ctx.utteranceTrace('u-cut', 'generated',
      { source: { role: 'canonical', scope: 's-cut' }, textHash: 'hash-cut',
        text: 'Cut isolation candidate text.', kind: 'bridge_strategy_proposal' });
    ctx.sendStrategyDecisionDelivery('d13', 1, 'audible_completed', 'd13#1', 'u-cut', 'hash-cut');
    ctx.handleStrategyDeliveryAck({ decision_id: 'd13', session_num: 1, dispatch_id: 'd13#1',
      outcome: 'audible_completed', applied: 'audible_completed', utterance_id: 'u-cut', text_hash: 'hash-cut' });
    return ctx.strategyDeliveryReceiptFor(1, 'd13#1', 'audible_completed');
  }

  // RED: text/kind loss mutantだけを注入する（他の全関数は
  // このctxがmakeCtx()で既に受け取っているCURRENT/real実装のまま）。
  const { ctx: redCtx } = makeCtx();
  vm.runInContext(oldUttTraceSrc + '\n' + oldUttTraceForSrc, redCtx);
  const redReceipt = cutScenario(redCtx);
  check('RED upstream intact control: text/kind loss cut注入時でもownerACK自体のscalar/hash/outcome確定は無傷のまま（cutが孤立している証拠、例外ではない）',
    redReceipt && redReceipt.utteranceId === 'u-cut' && redReceipt.textHash === 'hash-cut'
    && redReceipt.outcome === 'audible_completed' && redReceipt.applied === 'audible_completed');
  // ★実測で判明：text/kind loss mutantでも`source`オブジェクト自体（role/scope
  //   を内包するnested値）は常に保持されていた——receiptのrole/scopeは
  //   _retainedSource.role経由でreceipt構築側が常に導出できていたため、
  //   正例・cut双方で非null。cutが失わせるのはtext（本文）とkindだけで、
  //   このfixtureでは両方nullとなる（古いsource bytesの再現ではない）。
  check('RED: text/kind loss mutantは本文(originalText)とkindを一切保持しない（setup例外ではない、純粋な機能欠落）',
    redReceipt.originalText == null && redReceipt.kind == null, redReceipt);
  check('RED control: roleはnested sourceオブジェクト経由で元から保持されていた（今回のtext/kind欠落とは別軸、cutの影響範囲を正確に示す）',
    redReceipt.role === 'canonical');

  // GREEN: 同じscenarioを、makeCtx()が標準で注入するCURRENT/real
  // utteranceTrace/utteranceTraceForのまま（上書き無し）再実行する。
  const { ctx: greenCtx } = makeCtx();
  const greenReceipt = cutScenario(greenCtx);
  check('GREEN: unaltered current utteranceTraceでは同じscenarioがoriginalText/role/kindを正しく保持する（この修復がload-bearingの直接証明）',
    greenReceipt.originalText === 'Cut isolation candidate text.' && greenReceipt.role === 'canonical'
    && greenReceipt.kind === 'bridge_strategy_proposal', greenReceipt);
  check('GREEN control: upstreamのscalar/hash/outcomeもRED同様に正しいまま（cutの影響がbody/role欄だけに留まることの確認）',
    greenReceipt.utteranceId === 'u-cut' && greenReceipt.textHash === 'hash-cut' && greenReceipt.outcome === 'audible_completed');
}

console.log(`\n[strategy-delivery-outbox-retry] 合格 ${pass} / 不合格 ${fail}`);
console.log('※ 実WebSocket/Bridge/Windows実機は対象外。handleStrategyDeliveryAck/flushは実関数、irBridgeのみstub。');
process.exit(fail ? 1 : 0);
