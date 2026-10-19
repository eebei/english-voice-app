#!/usr/bin/env node
'use strict';
// WO015 残条件「owner/protocol/journal/Bridge/ACK sameVM」完成単位。
//
// 独立反証「scalarACK completion not sameIDreceipt」「transportreports lack
// utterance/source/hash」「Existing G1 artificialsinglebinding fixedUID
// speechLatencyTrace stub insufficient actualallstates/source/multichunk
// proof」への修復を、実speak/drainQueue/finalizeUtterance/
// deriveUtteranceSource/stableTextHash（renderer.htmlから実抽出）+ 実
// BOX transport（desktop/box-authority-transport.js）+ 実critical journal
// （desktop/critical-journal-store.js/client.js）+ 実session-strategy-state.js
// で縦断する。nextUtteranceIdは固定'u'ではなく実採番（連番）にし、同一本文
// でも別attemptは別utterance_idになることを証明する。外部有料API呼び出し0。

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const ROOT = __dirname;

const Box = require('./desktop/box-authority-transport');
const Store = require('./desktop/critical-journal-store');
const Client = require('./desktop/critical-journal-client');
const CF = require('./tests-canonical-lifecycle');
const S = require('./desktop/session-strategy-state.js');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : ' -> ' + JSON.stringify(detail)));
  ok ? pass++ : fail++;
}

const renderer = fs.readFileSync(path.join(ROOT, 'desktop/renderer.html'), 'utf8');
// ★WO015残条件A「fixture正当性」修復：旧`function NAME\([^]*?\n\}`は
// 一行関数（例：utteranceTraceFor）だと、本体内に`\n}`が無いため最初に
// マッチする次の`\n}`——別の後続関数の末尾——まで読み進めてしまい、意図せず
// 次の関数（speechLatencyTrace）まで取り込んでいた（取り込んだ関数宣言が
// context側のno-op stubを上書きし、test-localに見えない形で実装が入れ替わる
// 副作用があった）。文字列/テンプレート/コメント内の`{`/`}`を無視しながら
// 開始`function NAME(`直後の最初の`{`から深さ0まで数える、1関数だけを
// 確実に境界で止める抽出へ置き換える。
function extractFn(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index;
  // m[0] ends right after the parameter list's opening '('. Default
  // parameter values can themselves contain '{}' (e.g. `extra={}`), so the
  // body's real opening brace is only found AFTER the matching ')' of the
  // parameter list — naive indexOf('{', ...) would stop inside `extra={}`.
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
function grabFn(name) { return extractFn(renderer, name); }

// ════════════════════════════════════════════════════════════════════
// Part A — BOX: accept → attachUtterance → 実speak/drainQueue/
// finalizeUtterance → onSpoken/onDelivery → report() → outbox。
// ════════════════════════════════════════════════════════════════════
function boxFixture(over) {
  const o = Object.assign({ epoch: 'epoch-a', race: 'r', session: 1, decision: 'd',
    frame: 10, lap: 20, pit: 0, proof: 'p', attempt: 'a', setFuel: 7 }, over || {});
  const s = CF.fixture({ epoch: o.epoch, race: o.race, session: o.session, decision: o.decision,
    frame: o.frame, lap: o.lap, pit: o.pit, proof: o.proof, attempt: o.attempt });
  const refs = CF.refs(s);
  const fuel = { schema_version: 1, race_instance_id: o.race, session_num: o.session,
    source_frame_sequence: o.frame, session_time_s: 100, current_lap: o.lap, total_laps: 25,
    lap_dist_pct: .5, crossings_to_finish: 6, finish_kind: 'lap_race', fuel_level_l: 5,
    avg_fuel_per_lap_l: 2, clean_laps_sampled: 3, reserve_l: 1, effective_capacity_l: 20,
    max_set_fuel_l: 20, driver_pit_sequence: o.pit, multi_stop: false };
  const proof = { schema_version: 1, proof_id: o.proof, race_instance_id: o.race, session_num: o.session,
    decision_id: o.decision, plan_revision: 0, activation_frame: 5, issued_source_frame: o.frame,
    issued_session_time: 100, driver_pit_sequence: o.pit, expected_pit_sequence: o.pit + 1,
    selected_plan: 'A', target_lap: o.lap, add_fuel_l: o.setFuel, set_fuel_l: o.setFuel, constraint_id: 'c',
    validation: { available: true, geometry_contract: 'coupled_current_running_lap', target_lap: o.lap,
      target_in_laps: 0, set_fuel_l: o.setFuel },
    fuel_inputs: fuel, validity_contract: { ttl_seconds: 5, window: 'same_target_lap' } };
  const attempt = { attempt_id: o.attempt, proof_id: o.proof, race_instance_id: o.race, session_num: o.session,
    decision_id: o.decision, plan_revision: 0, activation_frame: 5, driver_pit_sequence: o.pit, dispatch_sequence: 1 };
  return {
    canonical: s,
    candidate: { type: 'radio', trigger: 'strategy_plan_box_call', ...refs, authority_proof: proof, box_attempt: attempt },
    snapshot: { type: 'box_authority_snapshot', schema_version: 1, ...refs, race_instance_id: o.race,
      session_num: o.session, source_frame_sequence: o.frame, session_time_s: 100, active_decision_id: o.decision,
      active_phase: 'active', plan_revision: 0, activation_frame: 5, driver_pit_sequence: o.pit, current_lap: o.lap,
      execution_gate: null, closed: false, collision: false, allowed_proof_id: o.proof, allowed_attempt_id: o.attempt,
      valid_until_session_s: 105 },
  };
}

function makeBoxVM(journalApi, fixture, voiceOn) {
  const j = Client.create(journalApi);
  const canonical = CF.initialized(() => 0, fixture.canonical);
  const transport = Box.create({ canonical, journal: j, now: () => 0, send: () => {}, revoke: () => {} });
  transport.setEpoch(fixture.canonical.bridge_process_epoch);
  transport.setConnected(true);
  assert(transport.receiveSnapshot(fixture.snapshot));
  let uttSeq = 0;
  let play = 0, fetches = 0, resolve = null;
  const c = {
    console, Date, Math, Map, Set, AbortController, performance: { now: () => 0 },
    boxAuthorityTransport: transport, selMode: 'race', voiceOn: voiceOn !== false,
    isJapaneseEngineer: () => false, addMsg: () => null,
    // ★実採番：固定'u'だとG1反例（複数attemptのID衝突を見逃す）を再現してしまう。
    nextUtteranceId: () => 'u' + (++uttSeq),
    speakQueue: [], lastQueuedSpeakItem: null,
    SPEAK_PRIO: { P0_SAFETY: 0, P1_HAZARD: 1, P2_PROCEDURE: 2, P4_INFO: 4 },
    IMMEDIATE_PIT_KINDS: new Set(), MAX_RADIO_QUEUE: 2, MAX_SPEAK_QUEUE: 20, currentSpeakPrio: 9,
    currentSpeakItem: null, isSpeaking: false, draining: false, speakGateActive: false,
    speakWindowOk: true, speakGeneration: 0,
    CHARS: { x: { gVoice: 'voice', gLang: 'en', voiceLang: 'en' } }, sel: 'x', autoMicActive: false,
    speechLatencyTrace: () => {}, diagnosticLog: () => {}, shouldDeferSpeak: () => false, deferSpeakItem: () => false,
    // ★WO015 supervisor checkpoint修復：以前はutteranceTraceを自前のtest-local
    //   no-op stubで置き換えており、同じ出口（handleStrategyDeliveryAck等）が
    //   実際に呼ぶutteranceTraceFor()を一度も検査できなかった（別fixtureで
    //   ReferenceErrorとして露呈）。実utteranceTrace/utteranceTraceForを
    //   renderer.htmlから抽出し、保持する状態（utteranceTraceLog/
    //   UTTERANCE_TRACE_MAX）も実物と同じ初期値で持たせる——test-local再実装
    //   はしない。
    utteranceTraceLog: [], UTTERANCE_TRACE_MAX: 200,
    currentGapAuthority: () => null, ttsAudio: null, speakFetchCtrl: null, speakWatchdog: null, ttsDisabledUntil: 0,
    phonetify: x => x, normalizeLunaSpeech: x => x, stripMarkdown: x => x, stripParens: x => x, stripEmoji: x => x,
    ttsFailLog: () => {}, ttsEventLog: () => {}, pwVolume: 1, usageSessionId: 's', API_BASE: 'mock',
    localStorage: { getItem: () => null }, getDeviceId: () => 'test', setTimeout: () => 1, clearTimeout: () => {},
    playWebSpeech: (text, char, gen, done, start) => { play++; start(); done(); },
    onUtteranceDone: () => { c.draining = false; c.isSpeaking = false; },
    Audio: class { constructor() { this.volume = 1; this.onended = null; this.onerror = null; } async play() { play++; } pause() {} },
    fetch: () => { fetches++; return new Promise(r => { resolve = r; }); },
    speechSynthesis: { cancel() {} },
  };
  c.globalThis = c; c.window = c;
  vm.createContext(c);
  for (const n of ['deriveUtteranceSource', 'stableTextHash', 'utteranceTrace', 'utteranceTraceFor', 'speak', 'drainQueue', 'finalizeUtterance',
    'handleStrategyPlanBoxCall', 'stopCurrentAudio'])
    vm.runInContext(extractFn(renderer, n), c);
  return { ctx: c, journal: j, transport, trace: c.utteranceTraceLog, play: () => play, fetches: () => fetches, resolve: r => resolve(r) };
}

// ★実main.js/preload.jsのIPC配線をそのまま動かす（tests-critical-journal.js
//   のdedicated()と同じ手法）——Store/Clientを直接手組みしない。
const mainSrc = fs.readFileSync(path.join(ROOT, 'desktop/main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'desktop/preload.js'), 'utf8');
const mainEntry = mainSrc.match(/require\('\.\/critical-journal-store'\)\.setupIPC\([^;]+;/)[0];
function dedicated(dir) {
  const map = new Map(), who = { mainFrame: {} }, host = { isDestroyed: () => false, webContents: who };
  vm.runInNewContext(mainEntry, { require: () => Store, ipcMain: { on: (n, f) => map.set(n, f) }, app: { getPath: () => dir }, win: host });
  let exposed;
  vm.runInNewContext(preloadSrc, { require: () => ({ contextBridge: { exposeInMainWorld: (_, v) => exposed = v },
    ipcRenderer: { sendSync: (n, o) => { const e = { sender: who, senderFrame: who.mainFrame }; map.get(n)(e, o); return e.returnValue; }, send: () => {}, invoke: () => {}, on: () => {} } }) });
  return exposed;
}

// 各サブケースは独立した実disk journal（実main.js/preload.js経由）を持つ
// ——本番の「1プロセス=1journal」契約をそのまま保ち、A6のhistoricalAck件数
// 検査が他サブケースの累積entryで汚染されないようにする。
function freshApi() {
  return dedicated(fs.mkdtempSync(path.join(require('os').tmpdir(), 'pitwall-wo015-owner-')));
}

async function boxVertical() {
  // ── A1: 正常系 completed。utterance_id/text_hashが実itemと一致 ──
  {
    const fx = boxFixture({ decision: 'd1', proof: 'p1', attempt: 'a1' });
    const vm1 = makeBoxVM(freshApi(), fx, true);
    vm1.ctx.handleStrategyPlanBoxCall(fx.candidate);
    check('A1: 実fetchが1回発生する', vm1.fetches() === 1);
    const spokenUid = vm1.ctx.currentSpeakItem && vm1.ctx.currentSpeakItem.utteranceId;
    const spokenHash = vm1.ctx.currentSpeakItem && vm1.ctx.currentSpeakItem.textHash;
    check('A1: 実itemにutteranceId/textHashが付与されている', !!spokenUid && !!spokenHash);
    vm1.resolve({ ok: true, status: 200, json: async () => ({ audioContent: 'A' }) });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    const audio = vm1.ctx.ttsAudio;
    check('A1: 実Audioが開始しonendedを持つ', vm1.play() === 1 && audio && typeof audio.onended === 'function');
    audio.onended();
    check('A1: finalizeUtteranceがcompletedへ到達する', vm1.ctx.currentSpeakItem._finalized === 'completed');
    const report = [...vm1.transport.outbox.values()].find(r => r.outcome === 'audible_completed');
    check('A1: Bridge宛reportのutterance_idが実itemと同一', !!report && report.utterance_id === spokenUid);
    check('A1: Bridge宛reportのtext_hashが実itemと同一', !!report && report.text_hash === spokenHash);
    check('A1: 実journalにもutterance_id/text_hash付きで永続化される',
      vm1.journal.entries('box_delivery_report').some(e => e.payload.outcome === 'audible_completed'
        && e.payload.utterance_id === spokenUid && e.payload.text_hash === spokenHash));

    // ★独立review「BOX owner receipt frozenbody/source/role/
    //   firstconfirmedtime retention/getter afterrealACK SAMEVM (not trace
    //   getter alone)」：既存A1は出力(report)とbounded trace/journalだけを
    //   検査していたが、実際にACKを適用した後にRenderer側が本文/role/scope
    //   を保持するownerreceipt専用getter（utteranceTraceForとは別の実体）
    //   を持つかは未確認だった。実ackを同VMへ適用し、新設
    //   boxAuthorityTransport.receiptFor()が実本文/kind/role/scope/
    //   firstConfirmedAtを返すことを直接確認する。
    const spokenText = vm1.ctx.currentSpeakItem.text;
    const spokenKind = vm1.ctx.currentSpeakItem.kind;
    // ★独立root audit「NEW MEMORY LEAK」：ACK前はpending bodyがbodyReceipts
    //   に存在していること（早期損失していない）を、既存outbox/attemptsと
    //   同じ露出パターンのbodyReceiptsで直接確認する（test専用の新規
    //   診断APIではない）。
    const bodyKey = report.bridge_process_epoch + '|' + report.report_event_id;
    check('A1 pre-ACK: pending bodyはACK前からbodyReceiptsに存在する（早期損失していない）',
      vm1.transport.bodyReceipts.has(bodyKey));
    const ack = { ...report, type: 'box_delivery_ack', applied: 'applied' };
    check('A1: 実ACKがownerACK consumerへ適用される', vm1.transport.ack(ack));
    const receipt = vm1.transport.receiptFor(report.bridge_process_epoch, report.report_event_id);
    check('A1: 実ACK後、BOX owner receipt getterが実本文/kind/role/scopeをtrace getterとは別に保持する',
      !!receipt && receipt.text === spokenText && receipt.kind === spokenKind
      && receipt.role === 'box_authority_call' && !!receipt.scope, receipt);
    // ★独立root audit「BOX SOURCE PACKET missing」：primitiveなscope/
    //   lookupkeyだけでなく、実speak()が使ったのと同一のEXACT original
    //   source packet（refs=publication/epoch、proof=proof_id/decision_id/
    //   validity_contract、attempt=attempt_id/dispatch_sequence）を保持する
    //   ことを、fixtureが実際にacceptへ渡した候補自身と比較して確認する
    //   （live canonicalからのACK時再構築ではない）。
    check('A1: receipt.sourceが実proofのproof_id/decision_id/validity_contractを保持する',
      !!receipt.source && !!receipt.source.proof
      && receipt.source.proof.proof_id === fx.candidate.authority_proof.proof_id
      && receipt.source.proof.decision_id === fx.candidate.authority_proof.decision_id
      && JSON.stringify(receipt.source.proof.validity_contract) === JSON.stringify(fx.candidate.authority_proof.validity_contract),
      receipt.source);
    check('A1: receipt.sourceが実attemptのattempt_id/dispatch_sequenceを保持する',
      !!receipt.source.attempt && receipt.source.attempt.attempt_id === fx.candidate.box_attempt.attempt_id
      && receipt.source.attempt.dispatch_sequence === fx.candidate.box_attempt.dispatch_sequence);
    check('A1: receipt.sourceが実refsのpublication/epoch identityを保持する',
      !!receipt.source.refs && receipt.source.refs.bridge_process_epoch === fx.canonical.bridge_process_epoch);
    // ★独立root audit「NEW MEMORY LEAK」：ACK成功後、pending bodyは
    //   receipts（上限50）へ転記済みなのでbodyReceiptsから退役している
    //   ——無期限に増え続けない。
    check('A1 post-ACK: pending bodyはACK成功後にbodyReceiptsから退役する（無期限増加しない）',
      !vm1.transport.bodyReceipts.has(bodyKey));
    check('A1: receiptのutterance_id/text_hashも実itemと同一', receipt.utterance_id === spokenUid && receipt.text_hash === spokenHash);
    check('A1: receiptのfirstConfirmedAtは数値で、frozenである', typeof receipt.firstConfirmedAt === 'number' && Object.isFrozen(receipt));

    // retire後の重複ACK（再送）はoutboxに既に存在しないため再処理されず、
    // receiptのfirstConfirmedAtも書き換えない（既存strategyDeliveryReceipts
    // の規律と同じ、BOX側はoutbox自体がgateになる）。
    const firstAt = receipt.firstConfirmedAt;
    check('A1: retire後の重複ACK(再送)はfalseを返し再処理しない',
      vm1.transport.ack(ack) === false);
    check('A1: 重複ACK後もreceiptのfirstConfirmedAtは不変（owner確定時刻を書き換えない）',
      vm1.transport.receiptFor(report.bridge_process_epoch, report.report_event_id).firstConfirmedAt === firstAt);
  }

  // ── A1b（独立review「actualspeak/drainQueue→_fallbackOnce→REALplayWebSpeech
  //    with ONLYproviderIOstub」）：既存A1と同じ実BOX proof/cache/attempt
  //    plumbingのまま、cloud TTSをHTTP失敗させる。BOXはP1_HAZARD優先度の
  //    emergencyFallback対象（既存policy、ここで変更・stubforcingしない）
  //    なので、実_fallbackOnce→実playWebSpeech（providerIO=SpeechSynthesis
  //    Utterance/speechSynthesis.speakだけstub）へ正当に到達する。
  //    started(onstart)→normalend(onend)で実際にcompletedへ届き、
  //    bounded traceの終端entryが実本文/kind/roleを保持することを確認する。
  // ════════════════════════════════════════════════════════════════════
  {
    const fx = boxFixture({ decision: 'd1b', proof: 'p1b', attempt: 'a1b' });
    const vm1b = makeBoxVM(freshApi(), fx, true);
    vm.runInContext(extractFn(renderer, 'playWebSpeech'), vm1b.ctx);
    vm1b.ctx.pickVoice = () => null;
    vm1b.ctx.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    let spoke = false;
    vm1b.ctx.speechSynthesis.speak = u => { spoke = true; vm1b.ctx.testUtt = u; };
    vm1b.ctx.handleStrategyPlanBoxCall(fx.candidate);
    check('A1b: 実fetchが1回発生する', vm1b.fetches() === 1);
    const spokenUid = vm1b.ctx.currentSpeakItem && vm1b.ctx.currentSpeakItem.utteranceId;
    vm1b.resolve({ ok: false, status: 500 });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    check('A1b: cloud TTS失敗で実_fallbackOnceが実playWebSpeechへ到達する（既存policyのまま、stubforcing無し）', spoke);
    vm1b.ctx.testUtt.onstart();
    vm1b.ctx.testUtt.onend();
    check('A1b: started(onstart)→normalend(onend)で実際にcompletedへ到達する',
      vm1b.ctx.currentSpeakItem._finalized === 'completed');
    const report = [...vm1b.transport.outbox.values()].find(r => r.outcome === 'audible_completed');
    check('A1b: フォールバック経由でもBridge宛reportは実itemと同一utterance_id/text_hashを運ぶ',
      !!report && report.utterance_id === spokenUid);
    const trace = vm1b.trace.filter(t => t.uid === spokenUid);
    check('A1b: bounded traceの終端entryがフォールバック経由でも実本文/kind/roleを保持する（source body逆追跡）',
      trace.length > 0 && trace[trace.length - 1].state === 'completed'
      && !!trace[trace.length - 1].text && trace[trace.length - 1].kind === 'strategy_plan_box_call'
      && trace[trace.length - 1].role === 'box_authority_call', trace);
  }

  // ── A1c（独立root audit「FINAL BODY LOST ON LATE ACK」: actual BOX
  //    representative sameVM ACK proof should survive trace clear where
  //    practical）：BOXのreceiptはbodyReceipts/report()経由で送信直前に
  //    即時captureされ、ACK到達時にbounded utteranceTraceLogを一度も読まない
  //    （PROPOSAL側のeviction-proof fallbackとは異なる、構造的に最初から
  //    trace依存がない設計）。これを実際にtraceを本当に追い出した状態で
  //    証明する——completed reportが積まれた後、無関係な250件のtraceで
  //    bounded logから元entryを追い出してから実ACKを適用する。
  // ════════════════════════════════════════════════════════════════════
  {
    const fx = boxFixture({ decision: 'd1c', proof: 'p1c', attempt: 'a1c' });
    const vm1c = makeBoxVM(freshApi(), fx, true);
    vm1c.ctx.handleStrategyPlanBoxCall(fx.candidate);
    const spokenUid = vm1c.ctx.currentSpeakItem.utteranceId;
    const spokenText = vm1c.ctx.currentSpeakItem.text;
    vm1c.resolve({ ok: true, status: 200, json: async () => ({ audioContent: 'A' }) });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    vm1c.ctx.ttsAudio.onended();
    const report = [...vm1c.transport.outbox.values()].find(r => r.outcome === 'audible_completed');
    // 無関係な250件のutteranceでbounded utteranceTraceLog（上限200）から
    // 元entryを本当に追い出す。
    for (let i = 0; i < 250; i++) vm1c.ctx.utteranceTrace('u-unrelated-' + i, 'generated', { text: 'x' + i, kind: 'radio', textHash: 'h' + i });
    check('A1c: eviction後、bounded traceは本当にこのutteranceを失っている（trace getter単独では逆追跡不能）',
      vm1c.ctx.utteranceTraceFor(spokenUid).length === 0);
    const ack = { ...report, type: 'box_delivery_ack', applied: 'applied' };
    check('A1c: trace eviction後でも実ACKは正しく適用される', vm1c.transport.ack(ack));
    const receipt = vm1c.transport.receiptFor(report.bridge_process_epoch, report.report_event_id);
    check('A1c: BOX owner receiptはtrace evictionの影響を受けず、実本文/source/firstConfirmedAtを保持する（最初からbodyReceipts/report()経由でtrace非依存の設計）',
      !!receipt && receipt.text === spokenText && !!receipt.source && !!receipt.source.proof
      && receipt.source.proof.proof_id === fx.candidate.authority_proof.proof_id
      && typeof receipt.firstConfirmedAt === 'number', receipt);
  }

  // ── A2: 開始後に中断。audible_interruptedもutterance_idを運ぶ ──
  {
    const fx = boxFixture({ decision: 'd2', proof: 'p2', attempt: 'a2' });
    const vm2 = makeBoxVM(freshApi(), fx, true);
    vm2.ctx.handleStrategyPlanBoxCall(fx.candidate);
    const spokenUid = vm2.ctx.currentSpeakItem.utteranceId;
    vm2.resolve({ ok: true, status: 200, json: async () => ({ audioContent: 'A' }) });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    check('A2: 実Audioが開始した', vm2.play() === 1);
    vm2.ctx.stopCurrentAudio('driver_interrupt');
    const report = [...vm2.transport.outbox.values()].find(r => r.outcome === 'audible_interrupted');
    check('A2: 中断reportもutterance_idを運ぶ（開始の事実は中断後も残る）',
      !!report && report.utterance_id === spokenUid);
  }

  // ── A3: voiceOff。以前はspeak()を迂回しtrace/uidが一切残らなかった ──
  {
    const fx = boxFixture({ decision: 'd3', proof: 'p3', attempt: 'a3' });
    const vm3 = makeBoxVM(freshApi(), fx, false);
    vm3.ctx.handleStrategyPlanBoxCall(fx.candidate);
    check('A3: voiceOffはfetchを一切発生させない', vm3.fetches() === 0);
    const report = [...vm3.transport.outbox.values()].find(r => r.outcome === 'suppressed_by_user');
    check('A3: suppressed_by_userのreportがownerへ届く', !!report);
    check('A3: suppressed reportもutterance_id/text_hashを持つ（以前はspeak()迂回でID自体が無かった）',
      !!report && !!report.utterance_id && !!report.text_hash);
    check('A3: bounded utteranceTraceにsuppressedが実記録される（出力からsourceへ逆追跡できる）',
      vm3.trace.some(t => t.uid === report.utterance_id && t.state === 'suppressed'));
  }

  // ── A4: consumer RED/control — attachUtteranceを外すとreportのID欄がnullに
  //    戻ることを示し（load-bearing証明）、復元後はGREENに戻ることを示す。
  // ════════════════════════════════════════════════════════════════════
  {
    const fx = boxFixture({ decision: 'd4', proof: 'p4', attempt: 'a4' });
    const vm4 = makeBoxVM(freshApi(), fx, true);
    const realAttach = vm4.transport.attachUtterance;
    vm4.transport.attachUtterance = () => false; // RED: 接続を外す
    vm4.ctx.boxAuthorityTransport = vm4.transport;
    vm4.ctx.handleStrategyPlanBoxCall(fx.candidate);
    vm4.resolve({ ok: true, status: 200, json: async () => ({ audioContent: 'A' }) });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    vm4.ctx.ttsAudio.onended();
    const redReport = [...vm4.transport.outbox.values()].find(r => r.outcome === 'audible_completed');
    check('A4 RED: attachUtterance除去でreportのutterance_idはnull（この接続がload-bearing）',
      !!redReport && redReport.utterance_id === null);

    const fx2 = boxFixture({ decision: 'd4b', proof: 'p4b', attempt: 'a4b' });
    const vm4b = makeBoxVM(freshApi(), fx2, true); // GREEN: 実attachUtterance（復元後と同じ経路）
    vm4b.ctx.handleStrategyPlanBoxCall(fx2.candidate);
    const uid4b = vm4b.ctx.currentSpeakItem.utteranceId;
    vm4b.resolve({ ok: true, status: 200, json: async () => ({ audioContent: 'A' }) });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    vm4b.ctx.ttsAudio.onended();
    const greenReport = [...vm4b.transport.outbox.values()].find(r => r.outcome === 'audible_completed');
    check('A4 GREEN: 復元後は同じ経路でutterance_idが実IDを運ぶ',
      !!greenReport && greenReport.utterance_id === uid4b);
    void realAttach;
  }

  // ── A5: 同じ本文(同set_fuel_l)の2つの別attemptは別utterance_idになる
  //    （Existing G1 fixedUIDではこの衝突を検出できなかった反例の修復証明）。
  // ════════════════════════════════════════════════════════════════════
  {
    const fxA = boxFixture({ decision: 'd5a', proof: 'p5a', attempt: 'a5a' });
    const fxB = boxFixture({ decision: 'd5b', proof: 'p5b', attempt: 'a5b' });
    // ★同一レンダラーVM（同じnextUtteranceIdカウンタ/speakQueue）で2回配信する
    //   ——別VMだと各々の採番が0から始まり直すため「同じ本文でも別IDになる」
    //   という実際に証明したい性質自体を検査できない（固定UID stub G1反例と
    //   同じ落とし穴）。2つ目のBOX transportだけ差し替えて同一ctxで2回呼ぶ。
    const vmA = makeBoxVM(freshApi(), fxA, true);
    vmA.ctx.handleStrategyPlanBoxCall(fxA.candidate);
    const uidA = vmA.ctx.currentSpeakItem.utteranceId;
    const hashA = vmA.ctx.currentSpeakItem.textHash;
    // 1件目を鳴り終えるまで進めてqueue/draining状態を解放する——未解決のまま
    // 2件目を投げると、2件目はspeakQueueへ積まれるだけでcurrentSpeakItemは
    // まだ1件目を指したままになる（drainQueueはawait中）。
    vmA.resolve({ ok: true, status: 200, json: async () => ({ audioContent: 'A' }) });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    vmA.ctx.ttsAudio.onended();

    const jB = Client.create(freshApi());
    const canonicalB = CF.initialized(() => 0, fxB.canonical);
    const transportB = Box.create({ canonical: canonicalB, journal: jB, now: () => 0, send: () => {}, revoke: () => {} });
    transportB.setEpoch(fxB.canonical.bridge_process_epoch);
    transportB.setConnected(true);
    assert(transportB.receiveSnapshot(fxB.snapshot));
    vmA.ctx.boxAuthorityTransport = transportB;
    vmA.ctx.handleStrategyPlanBoxCall(fxB.candidate);
    const uidB = vmA.ctx.currentSpeakItem.utteranceId;
    const hashB = vmA.ctx.currentSpeakItem.textHash;
    check('A5: 同じ本文（同textHash）でも別attemptは別utterance_id',
      hashA === hashB && uidA !== uidB, { hashA, hashB, uidA, uidB });
  }

  // ── A6: legacy/reorder — 古いepochのreportをhistorical_settlementとして
  //    再送し、新フィールド(utterance_id/text_hash)付きでも既存ACK照合が
  //    壊れないことを示す（WO010互換、Bridgeの実payload echo-back契約）。
  // ════════════════════════════════════════════════════════════════════
  {
    const fx = boxFixture({ epoch: 'epoch-old', decision: 'd6', proof: 'p6', attempt: 'a6' });
    const vm6 = makeBoxVM(freshApi(), fx, true);
    vm6.ctx.handleStrategyPlanBoxCall(fx.candidate);
    vm6.resolve({ ok: true, status: 200, json: async () => ({ audioContent: 'A' }) });
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    vm6.ctx.ttsAudio.onended();
    const original = [...vm6.transport.outbox.values()].find(r => r.outcome === 'audible_completed');

    const fresh = CF.fixture({ epoch: 'epoch-new', decision: 'd7', frame: 1 });
    const freshCanonical = CF.initialized(() => 0, fresh);
    const freshTransport = Box.create({ canonical: freshCanonical, journal: vm6.journal, now: () => 0, send: () => {}, revoke: () => {} });
    freshTransport.setEpoch('epoch-new'); freshTransport.setConnected(true);
    // Bridge echoes the full original payload verbatim inside historical_settlement_ack,
    // AND merges apply_report()'s BINDINGS-key ack fields onto the top level
    // (see irsdk-bridge/bridge.py: _history_ack.update(_original_ack) for the
    // box_delivery_report branch) -- historicalAck()'s own bindings check reads
    // those top-level fields, not payload.*.
    const historical = { ...original, type: 'historical_settlement_ack', kind: 'box_delivery_report',
      historical_only: true, current_bridge_process_epoch: 'epoch-new', payload: original, applied: 'applied' };
    check('A6: 新フィールド付きreportも旧epoch historicalAckとしてそのまま適用できる',
      freshTransport.historicalAck(historical));
    // onSpoken('audible_started')とonDelivery('completed')はそれぞれ別
    // report_event_idで永続化される（両方とも正しい事実）。ここで適用したのは
    // 'audible_completed'のreportだけなので、そのentryだけが消えたことを
    // 確認する（他方のentryまで誤って巻き込んで消していないことも併せて示す）。
    check('A6: 適用したaudible_completed entryだけがoutboxから消える',
      !freshTransport.outbox.has('epoch-old|' + original.report_event_id)
      && freshTransport.outbox.has('epoch-old|a6:audible_started'));
  }

  console.log(`[WO015 owner roundtrip — BOX] 合格 ${pass} / 不合格 ${fail}（この時点まで）`);
}

// ════════════════════════════════════════════════════════════════════
// Part B — Proposal: handleStrategyPlanProposal → 実speak/drainQueue/
// finalizeUtterance → onSpoken/onDelivery → sendStrategyDecisionDelivery
// → wire → handleStrategyDeliveryAck → owner確定readback（同VM）。
// tests-proposal-agreement-bridge.jsと同じcurrentStrategyStateAPI/
// strategyProjectionシム（提案→合意の正本契約自体はそちらで既に検証済み）
// だが、ここはspeak()を fake せず実extractionで動かし、実uid/hashが
// Bridge宛wireへ運ばれ、同VMのACK readbackへ戻ることを証明する。
// ════════════════════════════════════════════════════════════════════
function makeProposalVM(st) {
  let uttSeq = 0;
  let play = 0, fetches = 0, resolve = null;
  const sent = [];
  const c = {
    console, Date, Math, Map, Set, AbortController, performance: { now: () => 0 },
    selMode: 'race', lastSessionNum: 1, voiceOn: true,
    ensureStrategyState: () => ({ available: true }),
    currentStrategyStateAPI: () => ({
      proposePlan: (_ignoredSt, opts) => S.proposePlan(st, opts),
      revision: (_ignoredSt) => S.revision(st),
      invalidatePendingProposal: (_ignoredSt, opts) => S.invalidatePendingProposal(st, opts),
    }),
    strategyProjection: { binding: () => ({ __opaque_test_binding: true }), validBinding: () => true },
    bridgeProposalStillCurrent: () => true,
    bridgeStrategyDecisions: new Map(), strategyDeliveryOutbox: new Map(), strategyDeliveryReceipts: new Map(), strategyPlaybookDecisionKeys: new Set(),
    isJapaneseEngineer: () => true, addMsg: () => null, pushMsg: () => null,
    diagnosticLog: () => {}, SPEAK_PRIO: { P2_CRITICAL: 2 },
    nextUtteranceId: () => 'u' + (++uttSeq),
    // ★WO015 supervisor checkpoint修復：handleStrategyDeliveryAckが実際に
    //   呼ぶutteranceTraceFor()を、test-local no-op stubではなく実
    //   utteranceTrace/utteranceTraceFor（renderer.htmlから抽出）＋実
    //   utteranceTraceLog/UTTERANCE_TRACE_MAXで検査する（makeBoxVMと同じ修復）。
    utteranceTraceLog: [], UTTERANCE_TRACE_MAX: 200,
    speechLatencyTrace: () => {}, shouldDeferSpeak: () => false, deferSpeakItem: () => false,
    speakQueue: [], lastQueuedSpeakItem: null, IMMEDIATE_PIT_KINDS: new Set(),
    MAX_RADIO_QUEUE: 2, MAX_SPEAK_QUEUE: 20, currentSpeakPrio: 9, currentSpeakItem: null,
    isSpeaking: false, draining: false, speakGateActive: false, speakWindowOk: true, speakGeneration: 0,
    CHARS: { x: { gVoice: 'voice', gLang: 'en', voiceLang: 'en' } }, sel: 'x', autoMicActive: false,
    currentGapAuthority: () => null, ttsAudio: null, speakFetchCtrl: null, speakWatchdog: null, ttsDisabledUntil: 0,
    phonetify: x => x, normalizeLunaSpeech: x => x, stripMarkdown: x => x, stripParens: x => x, stripEmoji: x => x,
    ttsFailLog: () => {}, ttsEventLog: () => {}, pwVolume: 1, usageSessionId: 's', API_BASE: 'mock',
    localStorage: { getItem: () => null }, getDeviceId: () => 'test', setTimeout: () => 1, clearTimeout: () => {},
    playWebSpeech: (text, char, gen, done, start) => { play++; start(); done(); },
    onUtteranceDone: () => { c.draining = false; c.isSpeaking = false; },
    Audio: class { constructor() { this.volume = 1; this.onended = null; this.onerror = null; } async play() { play++; } pause() {} },
    fetch: () => { fetches++; return new Promise(r => { resolve = r; }); },
    irBridge: { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) },
    speechSynthesis: { cancel() {} },
  };
  c.globalThis = c; c.window = c;
  vm.createContext(c);
  for (const n of ['deriveUtteranceSource', 'stableTextHash', 'utteranceTrace', 'utteranceTraceFor', 'speak', 'drainQueue', 'finalizeUtterance',
    'stopCurrentAudio', 'strategyResponseKey', 'strategyDeliveryKey', 'sendStrategyDecisionDelivery', 'flushStrategyDeliveryOutbox',
    'handleStrategyDeliveryAck', 'strategyProposalAudibleCompletedAt', 'handleStrategyPlanProposal'])
    vm.runInContext(extractFn(renderer, n), c);
  return { ctx: c, sent, trace: c.utteranceTraceLog, play: () => play, fetches: () => fetches, resolve: r => resolve(r) };
}

const SNAP = 'recalc:test:1:7';
function bridgeProposal(over) {
  return Object.assign({
    type: 'radio', trigger: 'strategy_plan_proposal',
    decision_id: 'dX', dispatch_id: 'dX#1', selected_plan: 'B', reason: 'plan_b_undercut',
    decision_plan: { decision_id: 'dX', dispatch_id: 'dX#1', selected_plan: 'B', target_lap: 7,
      add_fuel_l: 10, set_fuel_l: 24, session_num: 1 },
    strategy_options: { available: true, snapshot_id: SNAP, selected_plan: 'B' },
    message: 'Undercut window next lap.',
  }, over || {});
}

async function proposalVertical() {
  // ── B1: 正常系。audible→completedがそれぞれ同じ実utterance_id/textHashで
  //    Bridgeへ送られ、ACK後に同VMのowner確定readbackが成立する。
  // ════════════════════════════════════════════════════════════════════
  {
    const st = S.create({ session_key: 'b1' });
    const vmB = makeProposalVM(st);
    vmB.ctx.handleStrategyPlanProposal(bridgeProposal({ decision_id: 'b1d', dispatch_id: 'b1d#1' }));
    const item = vmB.ctx.currentSpeakItem;
    check('B1: 実itemが積まれuid/textHashを持つ', !!item && !!item.utteranceId && !!item.textHash);
    vmB.resolve({ ok: true, status: 200, json: async () => ({ audioContent: 'A' }) });
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    check('B1: 実Audioが開始した', vmB.play() === 1);
    vmB.ctx.ttsAudio.onended();
    check('B1: finalizeUtteranceがcompletedへ到達', item._finalized === 'completed');
    const audibleWire = vmB.sent.find(m => m.cmd === 'strategy_decision_delivery' && m.outcome === 'audible');
    const completedWire = vmB.sent.find(m => m.cmd === 'strategy_decision_delivery' && m.outcome === 'audible_completed');
    check('B1: audible配送に実utterance_id/text_hashが乗る',
      !!audibleWire && audibleWire.utterance_id === item.utteranceId && audibleWire.text_hash === item.textHash);
    check('B1: audible_completed配送にも同じ実utterance_id/text_hashが乗る',
      !!completedWire && completedWire.utterance_id === item.utteranceId && completedWire.text_hash === item.textHash);

    // Bridgeが同じ識別子を返すACK -> 同VMのowner確定readbackが成立する
    // （単なるACKのecho受理ではなく、readback関数が実際に真値を返すことまで確認）。
    vmB.ctx.handleStrategyDeliveryAck({ decision_id: 'b1d', session_num: 1, dispatch_id: 'b1d#1',
      outcome: 'audible_completed', applied: 'audible_completed',
      utterance_id: completedWire.utterance_id, text_hash: completedWire.text_hash });
    check('B1: owner確定readback（strategyProposalAudibleCompletedAt）が実際に真値を返す',
      typeof vmB.ctx.strategyProposalAudibleCompletedAt('b1d') === 'number');
  }

  // ── B2: 開始後に中断。audible_interruptedが配送され、completedは送られない ──
  {
    const st = S.create({ session_key: 'b2' });
    const vmB2 = makeProposalVM(st);
    vmB2.ctx.handleStrategyPlanProposal(bridgeProposal({ decision_id: 'b2d', dispatch_id: 'b2d#1' }));
    vmB2.resolve({ ok: true, status: 200, json: async () => ({ audioContent: 'A' }) });
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    check('B2: 実Audioが開始した', vmB2.play() === 1);
    vmB2.ctx.stopCurrentAudio('driver_interrupt');
    const interruptedWire = vmB2.sent.find(m => m.cmd === 'strategy_decision_delivery' && m.outcome === 'audible_interrupted');
    check('B2: 中断配送にも実utterance_idが乗る', !!interruptedWire && !!interruptedWire.utterance_id);
    check('B2: completedは配送されない（鳴り終えていない）',
      !vmB2.sent.some(m => m.outcome === 'audible_completed'));
  }

  // ── B3: consumer RED/control — speak()へutteranceIdを明示せず渡さない
  //    （本修復前の状態を再現）とBridge宛配送のutterance_idが実itemと
  //    食い違う（または一致を主張できない）ことを示し、本番コードでは
  //    一致する（GREEN）ことと対比する。
  // ════════════════════════════════════════════════════════════════════
  {
    const st = S.create({ session_key: 'b3' });
    const vmB3 = makeProposalVM(st);
    const originalProposalSrc = extractFn(renderer, 'handleStrategyPlanProposal');
    const redSrc = originalProposalSrc
      .replace('speak(msg,{prio:SPEAK_PRIO.P2_CRITICAL,kind:\'bridge_strategy_proposal\',dedupeKey:_dispatchId,utteranceId:_uid,',
                'speak(msg,{prio:SPEAK_PRIO.P2_CRITICAL,kind:\'bridge_strategy_proposal\',dedupeKey:_dispatchId,');
    check('B3 RED setup: utteranceId明示配線を対象1箇所だけ除去できる（本番側は無改変）',
      redSrc !== originalProposalSrc
      && !redSrc.includes('utteranceId:_uid,'));
    vm.runInContext(redSrc, vmB3.ctx);
    vmB3.ctx.handleStrategyPlanProposal(bridgeProposal({ decision_id: 'b3d', dispatch_id: 'b3d#1' }));
    const itemRed = vmB3.ctx.currentSpeakItem;
    vmB3.resolve({ ok: true, status: 200, json: async () => ({ audioContent: 'A' }) });
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    vmB3.ctx.ttsAudio.onended();
    const redWire = vmB3.sent.find(m => m.cmd === 'strategy_decision_delivery' && m.outcome === 'audible_completed');
    // speak()はutteranceId省略時 nextUtteranceId() を自前で呼ぶため、_uid（配送へ
    // 渡した値）とitem.utteranceId（実際に鳴った値）が別カウンタ値に分岐する。
    check('B3 RED: utteranceId明示配線を外すと配送IDと実itemのIDが一致しなくなる（この配線はload-bearing）',
      !!redWire && redWire.utterance_id !== itemRed.utteranceId);

    const st2 = S.create({ session_key: 'b3g' });
    const vmB3g = makeProposalVM(st2); // GREEN: 本番コードのまま
    vmB3g.ctx.handleStrategyPlanProposal(bridgeProposal({ decision_id: 'b3g', dispatch_id: 'b3g#1' }));
    const itemGreen = vmB3g.ctx.currentSpeakItem;
    vmB3g.resolve({ ok: true, status: 200, json: async () => ({ audioContent: 'A' }) });
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    vmB3g.ctx.ttsAudio.onended();
    const greenWire = vmB3g.sent.find(m => m.cmd === 'strategy_decision_delivery' && m.outcome === 'audible_completed');
    check('B3 GREEN: 本番コードのままなら配送IDは実itemのIDと一致する',
      !!greenWire && greenWire.utterance_id === itemGreen.utteranceId);
  }

  console.log(`[WO015 owner roundtrip — total] 合格 ${pass} / 不合格 ${fail}`);
}

(async () => {
  try {
    await boxVertical();
    await proposalVertical();
    console.log(`\n[tests-wo015-owner-roundtrip] 合格 ${pass} / 不合格 ${fail}。実speak/drainQueue/finalizeUtterance/BOX transport/critical journal/session-strategy-state、AudioIO・WebSocket送信のみneutral stub。外部有料API呼び出し0。`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
