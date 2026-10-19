#!/usr/bin/env node
'use strict';
// WO015 Revision1 — Speech Lifecycle／数値発話の配送境界。
// 実renderer core（speak/drainQueue/finalizeUtterance/playWebSpeech/
// strategyNumericFactBinding）＋realcanonical-lifecycle-cache／
// strategy-state-projectionだけをSDK/音声IOでstubした常設縦断。
// 外部有料API呼び出し0（fetchはmockのみ、Audio/SpeechSynthesisはneutral stub）。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const root = __dirname;
const C = require(root + '/desktop/canonical-lifecycle-cache');
const P = require(root + '/desktop/strategy-state-projection');
const { fixture } = require('./tests-canonical-lifecycle');
const renderer = fs.readFileSync(root + '/desktop/renderer.html', 'utf8');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : ' -> ' + (detail || '')));
  ok ? pass++ : fail++;
}

// ★WO015残条件A「fixture正当性」修復：旧`function NAME\([^]*?\n\}`は一行
// 関数（例：utteranceTraceFor）だと本体内に`\n}`が無く、最初にマッチする
// 次の`\n}`——別の後続関数の末尾——まで読み進めてしまう（意図せず次の関数
// 宣言まで取り込み、context側のno-op stubを静かに上書きし得る）。文字列/
// テンプレート/コメント内の`{`/`}`を無視しながら開始直後の最初の`{`から
// 深さ0まで数える、1関数だけを境界で止める抽出へ置き換える。
function extract(n) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + n + '\\s*\\(');
  const m = re.exec(renderer);
  if (!m) throw new Error('Missing ' + n);
  const start = m.index;
  // m[0] ends right after the parameter list's opening '('. Default
  // parameter values can themselves contain '{}' (e.g. `extra={}`), so the
  // body's real opening brace is only found AFTER the matching ')' of the
  // parameter list — naive indexOf('{', ...) would stop inside `extra={}`.
  let pi = m.index + m[0].length, parenDepth = 1, pInStr = null;
  for (; pi < renderer.length; pi++) {
    const ch = renderer[pi];
    if (pInStr) { if (ch === '\\') { pi++; continue; } if (ch === pInStr) pInStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { pInStr = ch; continue; }
    if (ch === '(') parenDepth++;
    else if (ch === ')') { parenDepth--; if (parenDepth === 0) { pi++; break; } }
  }
  const braceStart = renderer.indexOf('{', pi);
  if (braceStart < 0) throw new Error('Missing body for ' + n);
  let depth = 0, inStr = null, inLineComment = false, inBlockComment = false, prev = '';
  for (let i = braceStart; i < renderer.length; i++) {
    const ch = renderer[i];
    if (inLineComment) { if (ch === '\n') inLineComment = false; prev = ch; continue; }
    if (inBlockComment) { if (prev === '*' && ch === '/') inBlockComment = false; prev = ch; continue; }
    if (inStr) {
      if (ch === '\\') { i++; prev = ''; continue; }
      if (ch === inStr) inStr = null;
      prev = ch; continue;
    }
    if (ch === '/' && renderer[i + 1] === '/') { inLineComment = true; prev = ch; continue; }
    if (ch === '/' && renderer[i + 1] === '*') { inBlockComment = true; prev = ch; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; prev = ch; continue; }
    if (ch === '{') { depth++; prev = ch; continue; }
    if (ch === '}') { depth--; prev = ch; if (depth === 0) return renderer.slice(start, i + 1); continue; }
    prev = ch;
  }
  throw new Error('Unterminated body for ' + n);
}

function audioVM(snap) {
  let clock = 0, fetchResolve, plays = 0, fallbacks = 0, fetches = 0;
  const cache = C.create({ now: () => clock });
  const g = cache.beginSocket();
  cache.hello(g, { type: 'connected', schema_version: 1, bridge_process_epoch: snap.bridge_process_epoch });
  assert(cache.receive(snap, g));
  const projection = P.create({ canonical: cache, now: () => clock });
  const costs = [];
  const c = {
    console, Date, Math, Map, Set, AbortController, performance: { now: () => clock },
    canonicalLifecycleCache: cache, strategyProjection: projection, boxAuthorityTransport: {},
    selMode: 'race', voiceOn: true, nextUtteranceId: () => 'wo015-u', speakQueue: [], lastQueuedSpeakItem: null,
    SPEAK_PRIO: { P0_SAFETY: 0, P1_HAZARD: 1, P2_PROCEDURE: 2, P3_STRATEGY: 3, P4_INFO: 4 },
    IMMEDIATE_PIT_KINDS: new Set(), MAX_RADIO_QUEUE: 2, MAX_SPEAK_QUEUE: 20,
    currentSpeakPrio: 9, currentSpeakItem: null, isSpeaking: false, draining: false,
    speakGateActive: false, speakWindowOk: true, speakGeneration: 0,
    CHARS: { x: { gVoice: 'mock', gLang: 'en', voiceLang: 'en' } }, sel: 'x', autoMicActive: false,
    speechLatencyTrace() {}, diagnosticLog() {}, shouldDeferSpeak: () => false, deferSpeakItem: () => false,
    currentGapAuthority: () => null, ttsAudio: null, speakFetchCtrl: null, speakWatchdog: null, ttsDisabledUntil: 0,
    phonetify: x => x, normalizeLunaSpeech: x => x, stripMarkdown: x => x, stripParens: x => x, stripEmoji: x => x,
    ttsFailLog() {}, ttsEventLog() {}, pwVolume: 1, usageSessionId: 's', API_BASE: 'mock',
    localStorage: { getItem: () => null }, getDeviceId: () => 'test', setTimeout: () => 1, clearTimeout() {},
    finalizeUtterance() {}, playWebSpeech: (text, char, gen, done, start) => { fallbacks++; start(); done(); },
    onUtteranceDone: () => { c.draining = false; c.isSpeaking = false; },
    Audio: class { constructor() { this.volume = 1; } async play() { plays++; } },
    fetch: () => { fetches++; return new Promise(r => fetchResolve = r); },
    costRecord: (outcome, detail) => costs.push({ outcome, detail }),
    utteranceTraceLog: [], UTTERANCE_TRACE_MAX: 200,
    irBridge: null,
  };
  c.window = c;
  vm.createContext(c);
  // ★WO015残条件A「fixture正当性」：従来は`speechLatencyTrace(){}`（上のno-op
  // stub）のまま、`utteranceTraceFor`抽出の正規表現バグが偶発的に実
  // speechLatencyTraceも取り込んでstubを上書きしていた（queued/tts_start/
  // play_startedがbounded traceへ記録されていたのはこの事故に依存していた）。
  // 抽出バグを修復した今、同じ実体を明示的に注入する——偶発依存ではなく、
  // G1続（170行）が検査する「queued→completedの逆追跡」が実際にload-bearing
  // であることを宣言する。
  for (const n of ['deriveUtteranceSource', 'stableTextHash', 'utteranceTrace', 'utteranceTraceFor', 'speechLatencyTrace', 'speak', 'drainQueue']) vm.runInContext(extract(n), c);
  return {
    ctx: c, cache, projection, costs,
    clock: n => clock = n,
    plays: () => plays, fallbacks: () => fallbacks, fetches: () => fetches,
    resolve: r => fetchResolve(r),
  };
}

function actualAudio(snap) {
  const a = audioVM(snap), c = a.ctx, receipts = [];
  c.jamesAutoMicEnabled = false; c.jamesMuted = false; c.ttsAudio = null;
  c.speechSynthesis = { cancel() {}, speak() {} };
  for (const n of ['finalizeUtterance', 'onUtteranceDone', 'stopCurrentAudio']) vm.runInContext(extract(n), c);
  c.Audio = class { constructor() { c.testAudio = this; this.volume = 1; } async play() {} pause() {} };
  return { a, c, receipts };
}
async function settle() { await new Promise(r => setImmediate(r)); }

const snap = fixture();
snap.continuity.stable_scope = { race_instance_id: snap.race_instance_id, session_num: snap.session_num, driver_id: 7 };

// ── Group 1: falsecompletedcost — queueunlockとcost会計の分離 ─────────
(async () => {
  {
    const { a, c, receipts } = actualAudio(snap);
    c.speak('A harmless explanation.', { prio: 2, kind: 'reply', onDelivery: o => receipts.push(o) });
    a.resolve({ ok: false, status: 500 });
    await settle(); await settle();
    const outcomes = a.costs.map(x => x.outcome);
    check('G1: 開始前HTTP失敗はcost上もcompletedにならない',
      !outcomes.includes('completed') && outcomes.includes('discarded'), outcomes.join(','));
    check('G1: receiptsもdropped_before_audibleで確定する', receipts.includes('dropped_before_audible'), receipts.join(','));
  }
  {
    const { a, c, receipts } = actualAudio(snap);
    c.IMMEDIATE_PIT_KINDS.add('reply');
    c.speak('Immediate instruction.', { prio: 1, kind: 'reply', onDelivery: o => receipts.push(o) });
    vm.runInContext(extract('playWebSpeech'), c);
    c.pickVoice = () => null;
    c.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    c.speechSynthesis.speak = u => { c.testUtt = u; };
    a.resolve({ ok: false, status: 500 });
    await settle(); await settle();
    c.testUtt.onstart();
    c.testUtt.onerror({ error: 'synthesis-failed' });
    const outcomes = a.costs.map(x => x.outcome);
    check('G1: 開始後WebSpeechエラーはcost上もcompletedにならない（audible_interrupted側）',
      !outcomes.includes('completed') && outcomes.includes('discarded'), outcomes.join(','));
    check('G1: receiptsはspoken→audible_interruptedで確定する',
      JSON.stringify(receipts) === JSON.stringify(['spoken', 'audible_interrupted']), receipts.join(','));
  }
  {
    // ★WO015残条件B「WebSpeech helper fallback — normalonend」：実providerIO
    // だけstubし、onstart→onend（エラー無し）の正常経路をproviderIOStubで
    // 実測する。従来はpost-start error（上のG1）とonstart前onend（下のG2）
    // しか無く、WebSpeech経路の成功終端（completed）とbounded trace（text/
    // kind/role）が実際に記録される直接証明が無かった。
    const { a, c, receipts } = actualAudio(snap);
    c.IMMEDIATE_PIT_KINDS.add('reply');
    const binding = { kind: 'facts', decision_id: 'd-ws1', revision: 1 };
    c.speak('Box this lap.', { prio: 1, kind: 'reply', strategyBinding: binding, onDelivery: o => receipts.push(o) });
    const uid = c.lastQueuedSpeakItem.utteranceId;
    vm.runInContext(extract('playWebSpeech'), c);
    c.pickVoice = () => null;
    c.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    c.speechSynthesis.speak = u => { c.testUtt = u; };
    const sentWire = [];
    c.irBridge = { readyState: 1, send: s => sentWire.push(JSON.parse(s)) };
    a.resolve({ ok: false, status: 500 });
    await settle(); await settle();
    c.testUtt.onstart();
    c.testUtt.onend();
    const outcomes = a.costs.map(x => x.outcome);
    check('G1(WebSpeech) success: 正常onstart→onendはcostRecord completedを打つ',
      outcomes.includes('completed'), outcomes.join(','));
    check('G1(WebSpeech) success: receiptsはspoken→completedで確定する',
      JSON.stringify(receipts) === JSON.stringify(['spoken', 'completed']), receipts.join(','));
    check('G1(WebSpeech) success: 無線spokeは1回だけ送られる', sentWire.filter(m => m.cmd === 'spoke').length === 1);
    const trace = c.utteranceTraceFor(uid);
    check('G1(WebSpeech) success: bounded traceがgenerated→queued→tts_start→completedまで同一uidで逆追跡でき、終端entryが実際のkind/role/本文を保持する',
      trace.some(e => e.state === 'generated') && trace.some(e => e.state === 'queued')
      && trace.some(e => e.state === 'tts_start') && trace.some(e => e.state === 'completed')
      && trace[trace.length - 1].state === 'completed'
      && trace[trace.length - 1].text === 'Box this lap.'
      && trace[trace.length - 1].kind === 'reply'
      && trace[trace.length - 1].role === 'canonical',
      trace);
  }
  {
    // ★WO015残条件B「WebSpeech helper fallback — startfailure」：onstartが
    // 一度も来ないままonerrorが来る場合（実機の音声未ロード・OS拒否等）は、
    // reportSpoke/'spoken'へ一度も到達していないため'audible_interrupted'
    // ではなく'dropped_before_audible'として確定し、無線'spoke'も一度も
    // 送られない——開始の証拠が無い完了をownerへ偽装しない（上のpost-start
    // errorケースとは異なる終端）。
    const { a, c, receipts } = actualAudio(snap);
    c.IMMEDIATE_PIT_KINDS.add('reply');
    c.speak('Box this lap.', { prio: 1, kind: 'reply', onDelivery: o => receipts.push(o) });
    vm.runInContext(extract('playWebSpeech'), c);
    c.pickVoice = () => null;
    c.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    c.speechSynthesis.speak = u => { c.testUtt = u; };
    const sentWire = [];
    c.irBridge = { readyState: 1, send: s => sentWire.push(JSON.parse(s)) };
    a.resolve({ ok: false, status: 500 });
    await settle(); await settle();
    c.testUtt.onerror({ error: 'synthesis-failed' });   // onstartは一度も来ない
    const outcomes = a.costs.map(x => x.outcome);
    check('G1(WebSpeech) startfailure: onstart前のonerrorはcompletedにならない', !outcomes.includes('completed'), outcomes.join(','));
    check('G1(WebSpeech) startfailure: receiptsはdropped_before_audible単独（spokenへ到達していない）',
      JSON.stringify(receipts) === JSON.stringify(['dropped_before_audible']), receipts.join(','));
    check('G1(WebSpeech) startfailure: 無線spokeは一度も送られない（開始の証拠が無い完了をownerへ偽装しない）',
      sentWire.filter(m => m.cmd === 'spoke').length === 0);
  }
  {
    // ★WO015残条件B「WebSpeech prestartsource再照合」：playWebSpeech自身が
    // speechSynthesis.speak()直前にitem.precheck()を**独立して再度**呼ぶ
    // （呼出し元_fallbackOnceの事前precheckとは別の最終関門）ことを、呼出し
    // ごとに異なる値を返すstateful precheck mockで直接証明する——drainQueue
    // 冒頭／_fallbackOnce事前チェックの2回はtrueで通過し、playWebSpeech内部
    // の3回目だけfalseに変わればspeechSynthesis.speak()へ一度も到達せず
    // dropped_before_audibleとして確定する。
    const { a, c, receipts } = actualAudio(snap);
    c.IMMEDIATE_PIT_KINDS.add('reply');
    let precheckCalls = 0;
    c.speak('Box this lap.', { prio: 1, kind: 'reply', precheck: () => (++precheckCalls) < 3, onDelivery: o => receipts.push(o) });
    vm.runInContext(extract('playWebSpeech'), c);
    c.pickVoice = () => null;
    c.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    let spoke = false;
    c.speechSynthesis.speak = u => { spoke = true; c.testUtt = u; };
    a.resolve({ ok: false, status: 500 });
    await settle(); await settle();
    check('G1(WebSpeech) prestartsource: playWebSpeech内部のprecheck再照合がfalseなら一度もspeechSynthesis.speak()しない',
      !spoke, precheckCalls);
    check('G1(WebSpeech) prestartsource: dropped_before_audibleとして確定する（completedへ昇格しない）',
      JSON.stringify(receipts) === JSON.stringify(['dropped_before_audible']), receipts.join(','));
  }
  {
    // 正常系がこの修復で壊れていないことを確認する（regression guard）。
    const { a, c, receipts } = actualAudio(snap);
    c.speak('A harmless explanation.', { prio: 2, kind: 'reply', onDelivery: o => receipts.push(o) });
    a.resolve({ ok: true, json: async () => ({ audioContent: 'fake' }) });
    await settle(); await settle();
    c.testAudio.onended();
    const outcomes = a.costs.map(x => x.outcome);
    check('G1: 正常completeは依然costRecord completedを打つ（regression）',
      outcomes.includes('completed'), outcomes.join(','));
    check('G1: 正常completeのreceiptsはspoken→completed（regression）',
      JSON.stringify(receipts) === JSON.stringify(['spoken', 'completed']), receipts.join(','));
  }

  // ── Group 1続（残条件「ID/source/state trace、voiceOff receipt」修復）：
  //    utteranceId/sourceIdの区別、凍結本文hash、bounded既diagnosticの
  //    generated→completed逆追跡、voiceOffでもID/suppressed記録を作り
  //    API0であることを確認する。────────────────────────────────────
  {
    const { a, c } = actualAudio(snap);
    const binding = { kind: 'facts', decision_id: 'd-1', revision: 2, bridge_process_epoch: 'e1', deadline_ms: 999999999999 };
    c.speak('現在の燃料は5L。', { prio: 2, kind: 'reply', strategyBinding: binding });
    const uid = c.lastQueuedSpeakItem.utteranceId;
    check('G1続: itemはsourceId/decision_id/revisionをbindingから保持する（opaque closureだけに頼らない）',
      c.lastQueuedSpeakItem.source && c.lastQueuedSpeakItem.source.sourceId === 'd-1'
      && c.lastQueuedSpeakItem.source.decision_id === 'd-1' && c.lastQueuedSpeakItem.source.revision === 2);
    check('G1続: 本文の凍結hash(textHash)が付与される', typeof c.lastQueuedSpeakItem.textHash === 'string' && c.lastQueuedSpeakItem.textHash.length > 0);
    a.resolve({ ok: true, json: async () => ({ audioContent: 'fake' }) });
    await settle(); await settle();
    c.testAudio.onended();
    const trace = c.utteranceTraceFor(uid);
    check('G1続: bounded traceが同じutteranceIdでqueued→completedまで逆追跡できる（generated/completed role）',
      trace.some(e => e.state === 'queued') && trace.some(e => e.state === 'completed'));
    check('G1続: trace各entryがsourceId/textHashも保持する（opaque closure無しで検査可能）',
      trace.every(e => !e.source || e.source.sourceId === 'd-1') && trace.some(e => e.textHash));
  }
  {
    // voiceOffは以前lastQueuedSpeakItemをnullにして無言returnしており、
    // ID/traceが一切残らなかった（generated事実自体が消えていた）。
    const { a, c } = actualAudio(snap);
    c.voiceOn = false;
    c.speak('現在の燃料は5L。', { prio: 2, kind: 'reply' });
    check('G1続voiceOff: queue投入もAPI呼出も発生しない（suppressed_by_userは常にTTS/Audioより前で確定）',
      c.speakQueue.length === 0 && a.fetches() === 0);
    const outcomes = a.costs.map(x => x.outcome);
    const reasons = a.costs.map(x => x.detail && x.detail.reason);
    check('G1続voiceOff: costRecordはdiscarded(suppressed_by_user)として計上される（無言で消えない）',
      outcomes.includes('discarded') && reasons.includes('suppressed_by_user'));
    check('G1続voiceOff: bounded traceにもsuppressedとして記録が残る（IDが無いまま消えない）',
      c.utteranceTraceLog.some(e => e.state === 'suppressed' && e.reason === 'voice_off'));
  }

  // ── Group 2: end後lateplaystart復活防止 ──────────────────────────
  {
    const premature = actualAudio(snap);
    premature.c.Audio = class {
      constructor() { premature.c.testAudio = this; this.volume = 1; }
      play() { return new Promise(r => premature.c.playResolve = r); }
      pause() {}
    };
    premature.c.speak('A harmless explanation.', { prio: 2, kind: 'reply', onDelivery: o => premature.receipts.push(o) });
    premature.a.resolve({ ok: true, json: async () => ({ audioContent: 'fake' }) });
    await settle(); await settle();
    premature.c.testAudio.onended();
    check('G2: reportSpoke前にonendedが来た場合はdropped_before_audibleとして確定する（放棄されない）',
      premature.receipts.includes('dropped_before_audible'), premature.receipts.join(','));
    const lateWire = [];
    premature.c.irBridge = { readyState: 1, send: t => lateWire.push(JSON.parse(t)) };
    premature.c.playResolve();
    await settle(); await settle();
    check('G2: 遅延play()解決は無線spokeを再送しない（復活禁止）', lateWire.length === 0, JSON.stringify(lateWire));
    check('G2: 遅延play()解決後もreceiptsはdropped_before_audible単独のまま（spoken復活禁止）',
      JSON.stringify(premature.receipts) === JSON.stringify(['dropped_before_audible']), premature.receipts.join(','));
  }
  {
    // WebSpeech側でも同じ順序異常（onend が onstart より先）を防ぐ。
    const { a, c, receipts } = actualAudio(snap);
    c.IMMEDIATE_PIT_KINDS.add('reply');
    c.speak('Immediate instruction.', { prio: 1, kind: 'reply', onDelivery: o => receipts.push(o) });
    vm.runInContext(extract('playWebSpeech'), c);
    c.pickVoice = () => null;
    c.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    c.speechSynthesis.speak = u => { c.testUtt = u; };
    a.resolve({ ok: false, status: 500 });
    await settle(); await settle();
    c.testUtt.onend();            // onstartより先にonendが来る異常系
    check('G2(WebSpeech): onstart前にonendが来てもdropped_before_audibleで確定する',
      receipts.includes('dropped_before_audible') && !receipts.includes('spoken'), receipts.join(','));
    const lateWire = [];
    c.irBridge = { readyState: 1, send: t => lateWire.push(JSON.parse(t)) };
    c.testUtt.onstart();           // 遅延onstart
    check('G2(WebSpeech): 遅延onstartは無線spokeを送らない', lateWire.length === 0, JSON.stringify(lateWire));
  }

  // ── Group 2続（独立反証「Audio.play() pending中のdrift」修復）：play()が
  //    解決するまでの区間でprecheckがfalseへ変わった場合、reportSpoke
  //    （machine開始proxy成立）前にもう一度再照合し、spoken/completedへ
  //    昇格させない——以前はplay()呼出からの区間に再照合が無く、pending中
  //    のdriftを無視してspoken/completedへ到達していた。────────────────
  {
    const premature2 = actualAudio(snap);
    let _preplayFresh = true;
    premature2.c.Audio = class {
      constructor() { premature2.c.testAudio = this; this.volume = 1; }
      play() { return new Promise(r => premature2.c.playResolve = r); }
      pause() { this.paused = true; }
    };
    premature2.c.speak('現在の前とのギャップは2.4秒。',
      { prio: 2, kind: 'reply', onDelivery: o => premature2.receipts.push(o), precheck: () => _preplayFresh });
    premature2.a.resolve({ ok: true, json: async () => ({ audioContent: 'fake' }) });
    await settle(); await settle();
    // play()がまだpendingの間にprecheckをfalseへ反転させる（aux/numeric
    // staleness相当、request前は有効だったが待機中に無効化された状態）。
    _preplayFresh = false;
    premature2.c.playResolve();
    await settle(); await settle();
    check('G2続: play()解決前にprecheckが無効化されればreportSpoke(spoken)を送らない',
      !premature2.receipts.includes('spoken'), premature2.receipts.join(','));
    check('G2続: dropped_before_audibleとして確定する（completedへ昇格しない）',
      premature2.receipts.includes('dropped_before_audible') && !premature2.receipts.includes('completed'),
      premature2.receipts.join(','));
    check('G2続: costRecordもdiscarded（stale_precondition）として計上、completedは計上しない',
      premature2.a.costs.some(x => x.outcome === 'discarded' && x.detail && x.detail.reason === 'stale_precondition')
      && !premature2.a.costs.some(x => x.outcome === 'completed'),
      JSON.stringify(premature2.a.costs));
    // 対照：play()解決時点まで有効なら、従来どおりspoken/completedへ到達する
    // （この修復が正常系を壊していないことの確認）。
    const control2 = actualAudio(snap);
    let _preplayFreshControl = true;
    control2.c.Audio = class {
      constructor() { control2.c.testAudio = this; this.volume = 1; }
      play() { return new Promise(r => control2.c.playResolve = r); }
      pause() {}
    };
    control2.c.speak('A harmless explanation.',
      { prio: 2, kind: 'reply', onDelivery: o => control2.receipts.push(o), precheck: () => _preplayFreshControl });
    control2.a.resolve({ ok: true, json: async () => ({ audioContent: 'fake' }) });
    await settle(); await settle();
    control2.c.playResolve();
    await settle(); await settle();
    check('G2続control: play()解決時点まで有効ならreportSpoke(spoken)へ到達する（正常系を壊さない）',
      control2.receipts.includes('spoken'), control2.receipts.join(','));
    control2.c.testAudio.onended();
    check('G2続control: 正常にcompletedまで到達する', control2.a.costs.some(x => x.outcome === 'completed'), JSON.stringify(control2.a.costs));
  }

  // ── Group 3: actual current numeric producer→domain/source/TTL→待機後失効 ──
  // strategyNumericFactBindingは本番renderer.htmlの実関数（抽出・実行）。
  // critical_context単独では燃料/周回の数値進行を無視する設計(round3〜4)を
  // 壊さず、本文が具体的な数値を主張する時だけ既存'facts'をANDする。
  {
    const cache = C.create({ now: () => 0 });
    const g = cache.beginSocket();
    cache.hello(g, { type: 'connected', schema_version: 1, bridge_process_epoch: snap.bridge_process_epoch });
    assert(cache.receive(snap, g));
    const projection = P.create({ canonical: cache, now: () => 0 });
    const ctx = { strategyProjection: projection };
    vm.createContext(ctx);
    // strategyNumericFactBinding() now calls the shared
    // _hasUnqualifiedCurrentNumericMention() sentence classifier (defined
    // immediately before it in renderer.html) -- extract both.
    vm.runInContext(extract('_hasUnqualifiedCurrentNumericMention') + '\n' + extract('strategyNumericFactBinding'), ctx);

    check('G3: 燃料/周回に言及しない純過去文はnullを返す（既存critical_context単独維持）',
      ctx.strategyNumericFactBinding('前回のレースを振り返ろう。') === null);
    const numericBinding = ctx.strategyNumericFactBinding('現在の燃料は5L。');
    check('G3: 燃料へ言及する文は実際のfacts bindingを返す',
      !!numericBinding && numericBinding.kind === 'facts');

    // G3続（独立反証「GAP-only文が無関係fuel driftで破棄される」修復により
    // 更新）：以前はヘルパーのregexが「順位/ポジション/ギャップ」語も検知し
    // 'facts'binding（factContent()=fuel_level_l/current_lap/finish/
    // pit_events/fuel_calculation）をANDしていた。この'facts'はGAP/position
    // の値そのものは一切追わないため、GAP/positionだけを主張する文が
    // **無関係な燃料/周回drift**だけでfactContent()比較に失敗し、誤って
    // 破棄され得た（独立反証で実HTTP確認）。GAP/position語をこのkeyword
    // 集合から除外し、GAP/position文は'facts'を経由しない（strategyNumeric
    // FactBindingはnullを返す）——鮮度は専用のverifiedAuxFieldsStillFresh/
    // captureVerifiedAuxBinding（下のG3続aux節）が正しく追う。
    const gapBinding = ctx.strategyNumericFactBinding('現在の順位は3番手、ギャップは2秒。');
    check('G3続: GAP/position のみの文はfuel/lap専用factsBindingを経由しない（null、無関係fuel driftで破棄されない）',
      gapBinding === null);
    const mixedFuelGapBinding = ctx.strategyNumericFactBinding('現在の燃料は5L、順位は3番手。');
    check('G3続: fuel/lap語と共存する文は依然factsBindingを返す（GAP語の除外はfuel側の既存保護を壊さない）',
      !!mixedFuelGapBinding && mixedFuelGapBinding.kind === 'facts'
      && JSON.stringify(mixedFuelGapBinding) === JSON.stringify(numericBinding));

    const criticalBinding = projection.binding('critical_context');
    const combined = projection.bindAll([numericBinding, criticalBinding]);
    check('G3: combinedは直後は有効', projection.validBinding(combined));

    // 燃料だけが変わる（Plan revision/pit_events/awaiting/execution/proofは不変）
    // ordinary frame progression -- critical_context単独は元々これを無効化しない。
    const next = JSON.parse(JSON.stringify(snap));
    next.snapshot_sequence++;
    next.snapshot_id = next.bridge_process_epoch + ':' + next.snapshot_sequence;
    next.current_facts.fuel_level_l = 4.2;
    assert(cache.receive(next), 'valid fuel progression accepted');

    check('G3: critical_context単独は燃料drift後も有効のまま（既存ordinary sequence契約を壊さない）',
      projection.validBinding(criticalBinding));
    check('G3: combined(facts AND critical_context)は燃料drift後に失効する（WO015の修復対象そのもの）',
      !projection.validBinding(combined));

    // G3続（残条件「現在finish文の裸周unitも漏れる」修復）：「残り3周です」
    // のような finish/remaining-laps 主張は 周目/周回/\blap\bのどれにも
    // マッチせず、修復前はnullのまま（facts binding未AND）だった。
    // factContent()はfinish.remaining_sf_crossingsを追うので、このbindingが
    // 正しくANDされればfinish driftでも無効化されるはず。
    const finishBinding = ctx.strategyNumericFactBinding('現在の残りは3周です。');
    check('G3続: finish文言（残り3周）もfactsBindingを返す（周目/周回/lapキーワードが無くても漏れない）',
      !!finishBinding && finishBinding.kind === 'facts');
    const finishCritical = projection.binding('critical_context');
    const finishCombined = projection.bindAll([finishBinding, finishCritical]);
    check('G3続: finish combinedは直後は有効', projection.validBinding(finishCombined));
    const nextFinish = JSON.parse(JSON.stringify(next));
    nextFinish.snapshot_sequence++;
    nextFinish.snapshot_id = nextFinish.bridge_process_epoch + ':' + nextFinish.snapshot_sequence;
    nextFinish.finish.remaining_sf_crossings = 5;
    nextFinish.finish.remaining_after_current = 4;
    assert(cache.receive(nextFinish), 'valid finish progression accepted');
    check('G3続: finish combined(facts AND critical_context)はfinish drift後に失効する（旧「残り3周」の漏れ修復対象そのもの）',
      !projection.validBinding(finishCombined));
    check('G3続: critical_context単独はfinish driftでも無効化しない（criticalContentはfinishを追わない、既知の設計）',
      projection.validBinding(finishCritical));

    // G3続（独立反証「数値role補強packet」修復）：
    // 1. 混在文「前回は燃料5Lだった。燃料は5L。」は全文単位のhistorical判定
    //    では全体がnullになり、後半の未修飾current主張まで歴史扱いにして
    //    しまっていた（独立実HTTP反証で再現）。文分解で個別判定し、1文でも
    //    未修飾current数値主張があれば全体をfenceする。
    const mixedBinding = ctx.strategyNumericFactBinding('前回は燃料5Lだった。燃料は5L。');
    check('G3続: 混在文（前回は5L。燃料は5L。）は後半の未修飾current主張によりnullにならない',
      mixedBinding !== null && mixedBinding.kind === 'facts');
    // 対照：全文が歴史修飾付きの数値主張だけなら、依然nullのまま
    // （item1の既存保護を壊さない）。
    check('G3続: 全文が歴史修飾付きの数値主張だけ（前回は5Lだった。前回は4Lだった。）ならnullのまま',
      ctx.strategyNumericFactBinding('前回は燃料5Lだった。前回は燃料4Lだった。') === null);

    // 2. bare keywordだけの一般論「燃料管理は早めの相談が大事だ。」は具体的な
    //    数値を主張していない——ordinary fuel driftだけでこの手の一般論を
    //    破棄してはならない（独立実HTTP反証で退行を確認）。
    check('G3続: 数字を含まない一般論（燃料管理は早めの相談が大事だ）はnullを返す（bare keyword単独でbindingを作らない）',
      ctx.strategyNumericFactBinding('燃料管理は早めの相談が大事だ。') === null);
    // 対照：同じ語彙でも具体的な数字が共存すればfenceする。
    check('G3続: 同じ語彙でも具体的な数字が共存すればfactsBindingを返す',
      ctx.strategyNumericFactBinding('燃料は残り5Lだ。') !== null);

    // 3. missing proof fail-closed: request前captureが明示的にnull（canonical
    //    unavailable等で証拠を取れなかった）という結果は、未呼出時の
    //    `undefined`後方互換fallbackとは別物——証拠が無いままcurrent数値
    //    主張を無guardで通してはならない。常に無効なsentinelを返す。
    const missingProofBinding = ctx.strategyNumericFactBinding('現在の燃料は5L。', null);
    check('G3続: request前captureがnull（証拠無し）の時は常に無効なsentinelを返す（undefinedの後方互換fallbackとは別扱い）',
      missingProofBinding !== null && missingProofBinding.kind === 'facts'
      && !projection.validBinding(missingProofBinding));
    // 対照：純過去文はmissing proofでもnull（証拠が無いことと歴史roleは別軸、
    // 歴史文を無用にfail-closedへ倒さない）。
    check('G3続: missing proofでも純過去文は依然nullのまま（歴史roleとproof欠測は別軸）',
      ctx.strategyNumericFactBinding('前回レースでは燃料5Lで終えた。', null) === null);

    // 4. 独立反証「missingproof補強」actualunknown: 実際に一度もhello/receive
    //    していない（＝実cache.disconnect相当）projectionでbinding('facts')
    //    がnullを返す経路でも、同じ常に無効なsentinelが生まれ、current数値
    //    主張全体（facts AND critical_contextのunavailable sentinel）が
    //    validBinding=falseになることを、ヘルパー単独ではなく実canonical
    //    cache/projectionの'facts'/'critical_context'呼び出しそのもので
    //    確認する（nullを手で渡すのではなく、本物のunusable状態から
    //    binding()自身がnullを返す経路）。
    const disconnectedCache = C.create({ now: () => 0 });
    const disconnectedProjection = P.create({ canonical: disconnectedCache, now: () => 0 });
    const disconnectedFactsAtRequest = disconnectedProjection.binding('facts');
    check('G3続: 実際に未接続のcanonicalではbinding(\'facts\')自身がnullを返す（before前提の確認）',
      disconnectedFactsAtRequest === null);
    const disconnectedNumericBinding = ctx.strategyNumericFactBinding('現在の燃料は5L。', disconnectedFactsAtRequest);
    const disconnectedCriticalBinding = disconnectedProjection.binding('critical_context');
    const disconnectedCombined = disconnectedProjection.bindAll([disconnectedNumericBinding, disconnectedCriticalBinding]);
    check('G3続: actualunknown（実際に未接続のcanonical）でも現在数値主張はvalidBinding=falseでfail-closed（本物のcache/projection経路で確認、helper単独の代用ではない）',
      !disconnectedProjection.validBinding(disconnectedCombined));
  }

  // ── Group 3続（残条件「verifiedaux GAP/position」修復、独立反証で検出された
  //    4欠陥）：strategyNumericFactBinding/binding('facts')はGAP/position自体
  //    の値を追わない（known boundary）。captureVerifiedAuxBinding/
  //    verifiedAuxFieldsStillFreshは本番renderer.htmlの実関数（抽出・実行）。
  {
    let liveCtx = null;
    const ctx2 = { strategyProjection: { validBinding: () => true }, buildCurrentRaceContext: () => liveCtx };
    vm.createContext(ctx2);
    vm.runInContext(
      extract('_hasUnqualifiedCurrentNumericMention') + '\n'
      + extract('captureVerifiedAuxBinding') + '\n'
      + extract('verifiedAuxFieldsStillFresh'), ctx2);

    const freshAux = { gap_ahead: 2.4, gap_behind: 1.2, position: 9, class_position: 3, leaders: null, standings_gaps: null };
    liveCtx = { auxiliary_observations: freshAux };
    const gapAtRequest = ctx2.captureVerifiedAuxBinding(liveCtx);
    check('G3続aux: source_ref/roleもcapture側に保持される（trace逆追跡、値だけに平坦化しない）',
      gapAtRequest.available === true && 'source_ref' in gapAtRequest && 'role' in gapAtRequest);
    check('G3続aux: GAP言及文は直後有効',
      ctx2.verifiedAuxFieldsStillFresh('現在の前とのギャップは2.4秒。', gapAtRequest));

    // 独立反証1: GAPだけを主張する文は、無関係なposition/leader/fuel更新
    // だけでは破棄してはならない（全fieldを1つのJSON文字列へ平坦化して
    // 比較していた旧実装の欠陥）。
    liveCtx = { auxiliary_observations: { ...freshAux, position: 8 } };
    check('G3続aux: GAPだけの文は無関係なposition単独driftで破棄しない',
      ctx2.verifiedAuxFieldsStillFresh('現在の前とのギャップは2.4秒。', gapAtRequest));
    // 対照：GAP自体が変化すれば当然失効する。
    liveCtx = { auxiliary_observations: { ...freshAux, gap_ahead: 1.1 } };
    check('G3続aux: GAP自体が変化すれば失効する（修復対象を壊さない）',
      !ctx2.verifiedAuxFieldsStillFresh('現在の前とのギャップは2.4秒。', gapAtRequest));

    // 独立反証2: 純過去「前回のギャップは2.4秒だった」は、現在GAPが変化
    // しても破棄してはならない（historical&&!current判定が抜けていた欠陥）。
    liveCtx = { auxiliary_observations: { ...freshAux, gap_ahead: 1.1 } };
    check('G3続aux: 純過去のGAP主張は現在GAP変化だけで破棄しない',
      ctx2.verifiedAuxFieldsStillFresh('前回のギャップは2.4秒だった。', gapAtRequest));

    // 独立反証3: 数字の無いGAP一般論「ギャップ管理は大事だ」も、現在GAP
    // 変化だけで破棄してはならない（keyword単独でassertedGroupにしていた欠陥）。
    check('G3続aux: 数字の無いGAP一般論は現在GAP変化だけで破棄しない',
      ctx2.verifiedAuxFieldsStillFresh('ギャップ管理は早めの判断が大事だ。', gapAtRequest));

    // 独立反証4: request時点でgap_ahead自体がnull（全体はcorrelated=available
    // でも、この特定fieldだけ証拠が無い）なら、後で同じnullが続いても
    // 「変化していない」として素通りしてはならない——常にfail-closed。
    const partialProofAux = ctx2.captureVerifiedAuxBinding({ auxiliary_observations: { ...freshAux, gap_ahead: null } });
    liveCtx = { auxiliary_observations: { ...freshAux, gap_ahead: null } };  // 値は「変化していない」
    check('G3続aux: request時点でgap_ahead自体がnull（missing proof）なら、後で同じnullでもfail-closed',
      !ctx2.verifiedAuxFieldsStillFresh('現在の前とのギャップは2.4秒。', partialProofAux));

    // 対照：request時点で未相関（aux全体が無い）なら常にfail-closed（既存契約）。
    const disconnectedAux = ctx2.captureVerifiedAuxBinding(null);
    check('G3続aux: request時点でcorrelation自体が無ければavailable=falseでfail-closed',
      disconnectedAux.available === false
      && !ctx2.verifiedAuxFieldsStillFresh('現在の前とのギャップは2.4秒。', disconnectedAux));

    // 対照：GAP/position言及が無い文は常に有効（非依存の普通会話を壊さない）。
    check('G3続aux: GAP/position言及の無い文は常に有効',
      ctx2.verifiedAuxFieldsStillFresh('燃料は残り5Lだ。', partialProofAux));

    // 独立反証A（親source読取）: explicit「前とのギャップ」はgap_behindの
    // 欠測/更新**だけ**では破棄してはならない（gap_ahead/gap_behindを1つの
    // groupにまとめていた旧実装の欠陥）。
    liveCtx = { auxiliary_observations: { ...freshAux, gap_behind: null } };
    check('G3続aux: explicit前とのGAPは後GAPの欠測だけで破棄しない',
      ctx2.verifiedAuxFieldsStillFresh('現在の前とのギャップは2.4秒。', gapAtRequest));
    liveCtx = { auxiliary_observations: { ...freshAux, gap_behind: 9.9 } };
    check('G3続aux: explicit前とのGAPは後GAPの更新だけで破棄しない',
      ctx2.verifiedAuxFieldsStillFresh('現在の前とのギャップは2.4秒。', gapAtRequest));
    // 対照：explicit「後ろとのギャップ」はgap_behind自体が変化すれば失効する。
    const behindAtRequest = ctx2.captureVerifiedAuxBinding({ auxiliary_observations: freshAux });
    liveCtx = { auxiliary_observations: { ...freshAux, gap_behind: 9.9 } };
    check('G3続aux: explicit後ろとのGAPはgap_behind自体の変化で失効する',
      !ctx2.verifiedAuxFieldsStillFresh('現在の後ろとのギャップは1.2秒。', behindAtRequest));

    // 独立反証A続: explicit「総合」順位はclass_positionの欠測/更新**だけ**
    // では破棄してはならない（position/class_positionを1つのgroupに
    // まとめていた旧実装の欠陥）。
    liveCtx = { auxiliary_observations: { ...freshAux, class_position: null } };
    check('G3続aux: explicit総合順位はclass順位の欠測だけで破棄しない',
      ctx2.verifiedAuxFieldsStillFresh('現在の総合順位は9番手。', gapAtRequest));
    liveCtx = { auxiliary_observations: { ...freshAux, class_position: 2 } };
    check('G3続aux: explicit総合順位はclass順位の更新だけで破棄しない',
      ctx2.verifiedAuxFieldsStillFresh('現在の総合は9番手。', gapAtRequest));
    // 対照：explicit「クラス順位」はclass_position自体が変化すれば失効する。
    liveCtx = { auxiliary_observations: { ...freshAux, class_position: 2 } };
    check('G3続aux: explicitクラス順位はclass_position自体の変化で失効する',
      !ctx2.verifiedAuxFieldsStillFresh('現在のクラス順位は3番手。', gapAtRequest));

    // 対照：修飾の無い未修飾「順位」は両field（position/class_position）を
    // 保守的に見る——class driftだけでも失効する（generic/mixedは必要field
    // を保守的に選ぶ、という既定を維持）。
    liveCtx = { auxiliary_observations: { ...freshAux, class_position: 2 } };
    check('G3続aux: 未修飾の順位はclass driftだけでも保守的に失効する（generic保守選択）',
      !ctx2.verifiedAuxFieldsStillFresh('現在の順位は9番手。', gapAtRequest));

    // 独立反証（追加反証packet「generic+specific同一domain混在」）：
    // 「現在の前とのギャップは2.4秒で、ギャップは1.2秒です。」は同じ文の中で
    // 1回目explicit(前との)・2回目無修飾という2つの独立したGAP主張を含む。
    // 以前は文全体に1回でもspecific修飾があるとgeneric fallbackを丸ごと
    // 止めていたため、2回目の無修飾主張（gap_behind想定）のdriftが見逃され
    // ていた（実HTTP反証で確認：behind 1.2→3でもplay/completed・旧全文
    // historyが残存）。出現ごとの直前修飾だけを見る設計でこれを拾う。
    const mixedText = '現在の前とのギャップは2.4秒で、ギャップは1.2秒です。';
    liveCtx = { auxiliary_observations: { ...freshAux, gap_behind: 3 } };
    check('G3続aux: 混在文(前との+無修飾)はgap_behind driftでも失効する(2回目の無修飾主張を見逃さない)',
      !ctx2.verifiedAuxFieldsStillFresh(mixedText, gapAtRequest));
    // 対照：gap_ahead自体が変化しても当然失効する（1回目のexplicit主張）。
    liveCtx = { auxiliary_observations: { ...freshAux, gap_ahead: 1.1 } };
    check('G3続aux: 混在文は1回目のexplicit gap_ahead driftでも失効する',
      !ctx2.verifiedAuxFieldsStillFresh(mixedText, gapAtRequest));
    // 対照：両方不変なら直後は有効のまま。
    liveCtx = { auxiliary_observations: { ...freshAux } };
    check('G3続aux: 混在文は両field不変なら直後は有効',
      ctx2.verifiedAuxFieldsStillFresh(mixedText, gapAtRequest));
  }

  console.log(`\nWO015 Speech Lifecycle: ${pass}/${pass + fail}`);
  if (fail > 0) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
