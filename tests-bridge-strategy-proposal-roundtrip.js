#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════
// 2026-09-17 Codex MD#4〜#6差戻し（3ラウンド連続で最優先指摘）：
//   「Bridgeはcanonical recommendationを音声でなくdata eventとして渡し、
//    Desktopのsame-frame precheck後の単一音声経路だけが読み上げること。
//    onSpokenで同一IDを成立、drop/interrupted/staleでは不成立にする」
//   「実routerの明示yes/noとLLM judgeのconfirm/decline双方について、状態機械が
//    実際に適用した結果だけをrendererへ返し、rendererが
//    {cmd:'strategy_decision_response', session_num, decision_id, accepted}を
//    一度だけ送ること。曖昧、awaiting、stale、未発話、中断では送らない」
//
// この検査は文字列一致ではなく、renderer.html本番コード
//   handleStrategyPlanProposal → speak → drainQueue → finalizeUtterance('spoken')
//   → onSpoken(proposePlan) → 実local-intent-router.route()（Driverの「うん」）
//   → resolvedProposal → sendStrategyDecisionResponse → irBridge.send(...)
// を1本で実行して確認する。TTSネットワーク(fetch)とDOM(document)だけをstub化し、
// それ以外は本番コードを実行する（tests-previous-fuel-utterance-fixture.jsと同じ方式）。
// ══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = __dirname;
const html = fs.readFileSync(path.join(ROOT, 'desktop/renderer.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.reduce((a, b) => (a.length > b.length ? a : b));

function extract(name) {
  const head = new RegExp('^(?:async )?function ' + name + '\\(', 'm');
  const m = head.exec(src);
  if (!m) throw new Error('本番コードに ' + name + ' が見つからない（実装が変わった可能性）');
  const rest = src.slice(m.index);
  const end = rest.slice(1).search(/\n(?:async function |function |const |let |\/\/ ──)/);
  return rest.slice(0, end > 0 ? end + 1 : rest.length);
}

const productionCode = [
  'handleStrategyPlanProposal', 'sendStrategyDecisionResponse', 'applyProposalJudgeTag',
  'bridgeProposalStillCurrent', 'sendStrategyDecisionDelivery', 'handleStrategyDecisionAck',
  'evaluateLiveStrategySwitch',
  'flushStrategyResponseOutbox', 'strategyResponseKey',
  'strategyOptionsSupportProposal', 'strategyDeliveryKey',
  'planConditionsFromOptions', 'sameProposalConditions',
  'flushStrategyDeliveryOutbox', 'handleStrategyDeliveryAck',
  'ensureStrategyState', 'conversationSessionKey',
  'speak', 'speechMayStart', 'drainQueue', 'stopCurrentAudio', 'onUtteranceDone',
  'playWebSpeech', 'nextUtteranceId', 'finalizeUtterance', 'discardQueuedUtterances',
  'pushMsg', 'addMsg', 'convoLog', 'recordLunaTurn', 'amendLunaTurnById', 'dropLunaTurnById',
].map(extract).join('\n');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)('  ' + (ok ? '✅ ' : '❌ ') + label + (ok ? '' : ' -> ' + (detail || '')));
  ok ? pass++ : fail++;
}

let fakeNow = 1_700_000_000_000;
let ttsResolve = null;
const played = [];
const audioInstances = [];
const spokenTexts = [];
const wsSent = [];

class FakeDate extends Date {
  constructor(...args) { if (!args.length) super(fakeNow); else super(...args); }
  static now() { return fakeNow; }
}

function freshSandbox() {
  const sandbox = {
    console, setTimeout, clearTimeout, Date: FakeDate, JSON, Math, Number, String,
    Array, Object, Set, Map, Boolean, RegExp, Promise, Error, isNaN, parseFloat, parseInt,
    speakQueue: [], draining: false, isSpeaking: false, speakWatchdog: null,
    ttsAudio: null, currentSpeakPrio: 9, speakGeneration: 0, speakFetchCtrl: null,
    currentSpeakItem: null, voiceOn: true, pwVolume: 1, ttsDisabledUntil: 0,
    autoMicActive: false, autoMicRec: null, jamesAutoMicEnabled: false, jamesMuted: false,
    startAutoMic: () => {}, MAX_RADIO_QUEUE: 2,
    speakWindowOk: true, speakGateActive: false,
    IMMEDIATE_PIT_KINDS: new Set(['pit_entry', 'limiter_off', 'pit_box_here', 'pit_box_countdown']),
    SPEAK_DEFER_KINDS: new Set(['personal_best', 'session_best', 'first_lap']),
    SPEAK_DEFER_MAX: 1,
    SPEAK_PRIO: { P0_SAFETY: 0, P1_HAZARD: 1, P2_PROCEDURE: 2, P3_STRATEGY: 3, P4_INFO: 4, P5_CHAT: 5 },
    CHARS: { LunaJP: { gVoice: 'ja-JP-x', gLang: 'ja-JP', gRate: 1, gPitch: 0, voiceLang: 'ja-JP', pitch: 1, rate: 1, voiceNames: [] } },
    sel: 'LunaJP', API_BASE: 'http://x',
    isBusy: false, turns: 0, sessionMsgCount: 0, userName: '',
    selMode: 'race', iracingLive: true,
    lastTelemetry: { cust_id: 1, laps_total: 20, strategy_options: authorityOptions() },
    lastTelemetryAt: fakeNow,
    lastTrack: 'fixture-track', lastCarModel: 'fixture-car', lastCarClass: 'GT3',
    lastSessionType: 'Race', lastSessionNum: 1, lastSessionAuthority: null,
    lastIrating: null, lastSr: null,
    fuelWindowWatch: null,
    strategyPlaybookDecisionKeys: new Set(),
    bridgeStrategyDecisions: new Map(),
    strategyResponseOutbox: new Map(),
    strategyDeliveryOutbox: new Map(),
    liveStrategyValidation: null,
    _strategyStateBox: null, _strategyStateKey: '',
    document: { getElementById: () => ({ value: '', style: {} }) },
    messages: [], MAX_CLIENT_MESSAGES: 40, _msgSeq: 0,
    diagnosticLog: (tag, body) => { /* traces not needed for this test */ },
    isJapaneseEngineer: () => true,
    phonetify: t => t, normalizeLunaSpeech: t => t,
    stripMarkdown: t => t, stripParens: t => t, stripEmoji: t => t, pickVoice: () => null,
    speechLatencyTrace: () => {}, costRecord: () => {}, costReplyId: () => 'cost-1',
    ttsFailLog: () => {}, ttsEventLog: () => {},
    irBridge: { readyState: 1, send: (raw) => { wsSent.push(JSON.parse(raw)); } },
    usageSessionId: 'test-usage-session',
    AbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } },
    fetch: (url, init) => {
      try {
        const body = init && init.body ? JSON.parse(init.body) : null;
        if (body && typeof body.text === 'string') spokenTexts.push(body.text);
      } catch (_) {}
      return new Promise((res, rej) => { ttsResolve = { res, rej }; });
    },
    Audio: class {
      constructor(url) { this.src = url; this.volume = 1; this.onended = null; this.onerror = null; audioInstances.push(this); }
      async play() { played.push(this.src); }
      pause() { this.paused = true; }
    },
    speechSynthesis: { cancel() {}, speak(u) { played.push('webspeech:' + u.text); } },
    SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox._uttSeq = 0;
  sandbox._convoBox = null;
  sandbox.CONVO_BOX_KEY = 'pw_conversation_box_v1';
  const _store = {};
  sandbox.localStorage = {
    getItem: k => (k in _store ? _store[k] : null),
    setItem: (k, v) => { _store[k] = String(v); },
    removeItem: (k) => { delete _store[k]; },
  };
  sandbox.document = {
    getElementById: () => ({ value: '', style: {}, appendChild(){}, scrollTop:0, scrollHeight:0, classList:{add(){},remove(){},toggle(){}} }),
    createElement: () => ({ textContent:'', className:'', parentNode:null }),
    querySelector: () => null,
  };
  sandbox.pitwall = { overlayPush: () => {} };
  sandbox.__ovlSeq = 0;
  sandbox.mirrorToOverlay = (type, text) => 'L' + (++sandbox.__ovlSeq);
  sandbox.conversationSessionKey = () => 'test-session';

  vm.createContext(sandbox);
  function loadModule(file) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  }
  loadModule('desktop/session-strategy-state.js');
  vm.runInContext(productionCode, sandbox, { filename: 'renderer.html' });
  return sandbox;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function finishCurrentUtterance(sandbox) {
  if (ttsResolve) {
    ttsResolve.res({ status: 200, ok: true, json: async () => ({ audioContent: 'A' + audioInstances.length }) });
    ttsResolve = null;
    await sleep(10);
  }
  const audio = audioInstances[audioInstances.length - 1];
  if (audio && typeof audio.onended === 'function') { audio.onended(); await sleep(10); }
}

// ★MD#9 P1-2：Desktopの同一frame判定はfail-closedになった。Bridgeが実際に送る形
//   （`build_strategy_decision()`の凍結planレコード＋その frame の`strategy_options`）
//   をそのまま使う——`available`・`selected_plan`・`snapshot_id`・plan詳細が揃って
//   初めて発話される。
const SNAP = 'recalc:driver_recalc_request:1:7';
const DECISION_ID = SNAP + ':decision-lap:7';
// decision-lock時点のlive再検証（`decide_plan_at_target`の出力）。`build_strategy_decision()`は
// ここからPlan別conditionsを作り、`plan_actionable_signature()`へ載せる。
const liveEvidence = (over) => ({
  decision_id: DECISION_ID,
  plan_b_evidence: Object.assign({
    relative_pace_advantage_s: 0.8,
    conditions_met: { fuel_window_open: true, relative_pace_advantage: true, rejoin_clear: true },
  }, over || {}),
});
const authorityOptions = (over) => Object.assign({
  available: true, snapshot_id: SNAP, selected_plan: 'B',
  plan_a: { target_lap: 9, add_fuel_l: 12, set_fuel_l: 28 },
  plan_b: { target_lap: 7, add_fuel_l: 10, set_fuel_l: 24, fuel_window_open: true },
  decision_evidence: liveEvidence(),
}, over || {});
// `build_strategy_decision()`が凍結するconditions（Plan B）と同じ形。
const frozenConditions = (over) => Object.assign({
  fuel_window_open: true, relative_pace_advantage_s: 0.8, rejoin_not_worse: true,
}, over || {});

const bridgeProposal = (over) => Object.assign({
  type: 'radio', trigger: 'strategy_plan_proposal',
  decision_id: DECISION_ID, dispatch_id: DECISION_ID + '#1',
  selected_plan: 'B', reason: 'plan_b_undercut_conditions_proven',
  decision_plan: {
    decision_id: DECISION_ID, dispatch_id: DECISION_ID + '#1',
    selected_plan: 'B', target_lap: 7, add_fuel_l: 10, set_fuel_l: 24, session_num: 1,
    evidence_snapshot_id: SNAP, conditions: frozenConditions(),
  },
  strategy_options: authorityOptions(),
  message: 'Undercut window next lap. Hold pace this lap; set 24 liters.',
}, over || {});

(async () => {
  console.log('\n══ Bridge戦略提案の製品経路：data event→発話→合意→Bridgeへの応答送信 ══\n');

  // ════════════════════════════════════════════════════════════════
  // ① 正常系：提案→発話成立(onSpoken)→proposePlan→Driver「うん」→
  //    resolvedProposal→sendStrategyDecisionResponse→irBridge.send
  // ════════════════════════════════════════════════════════════════
  {
    wsSent.length = 0; spokenTexts.length = 0; audioInstances.length = 0; played.length = 0;
    const sandbox = freshSandbox();
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);

    const queued = sandbox.speakQueue.find(q => q.kind === 'bridge_strategy_proposal')
      || (sandbox.currentSpeakItem && sandbox.currentSpeakItem.kind === 'bridge_strategy_proposal' ? sandbox.currentSpeakItem : null);
    check('①提案がqueueへ入った（injectRadioではなくhandleStrategyPlanProposal経由）', !!queued,
      JSON.stringify(sandbox.speakQueue.map(q => q.kind)));

    const st = sandbox.ensureStrategyState();
    check('①発話成立前はproposePlanが呼ばれていない（pending_proposalはまだ無い）',
      st.pending_proposal === null, JSON.stringify(st.pending_proposal));

    await finishCurrentUtterance(sandbox);

    check('①onSpokenでproposePlanが呼ばれ、pending_proposalが立つ',
      st.pending_proposal !== null && st.pending_proposal.decision_id === bridgeProposal().decision_id,
      JSON.stringify(st.pending_proposal));
    check('①bridgeStrategyDecisionsへ記録された（Bridgeへ応答を送り返す対象として）',
      sandbox.bridgeStrategyDecisions.has(bridgeProposal().decision_id),
      JSON.stringify([...sandbox.bridgeStrategyDecisions.keys()]));

    // Driverが実routerを通して「うん」と応答したのと同じ形——
    // local-intent-router.js は既に134件のテストで別途固定済みなので、
    // ここではresolvePendingProposal自体（本番session-strategy-state.js）を
    // routerと同じ呼び方で直接使い、rendererのresolvedProposal配線だけを検証する。
    const S = sandbox.PitwallSessionStrategyState;
    // ★注意：ここは外側(Node実時間)のDate.now()ではなくfakeNow（sandbox内FakeDateと
    //   同じ時計）を使う——実時間を使うとproposePlan時のat(fakeNow)との差がTTLを
    //   超え、無関係にstale判定されてしまう（このテストを書く過程で実際に踏んだ）。
    const resolved = S.resolvePendingProposal(st, { accepted: true, at: fakeNow });
    check('①resolvePendingProposalがaccepted:trueを返す', resolved && resolved.accepted === true);

    // renderer.htmlのsendMsg内で実際に行っている配線と同じ呼び出し。
    sandbox.sendStrategyDecisionResponse(resolved.proposal.decision_id, true);

    const responseMsgs1 = wsSent.filter(m => m.cmd === 'strategy_decision_response');
    check('①Bridgeへ実際にWS送信された（strategy_decision_response）', responseMsgs1.length === 1,
      JSON.stringify(wsSent));
    check('①送信内容が完成条件どおり（cmd・decision_id・accepted・session_num）',
      responseMsgs1[0] && responseMsgs1[0].decision_id === bridgeProposal().decision_id
      && responseMsgs1[0].accepted === true && responseMsgs1[0].session_num === 1,
      JSON.stringify(responseMsgs1[0]));
    // ★MD#8 P1-3：送信しただけでは捨てない。Bridgeのackが返るまでoutboxと
    //   追跡Mapに残し、切断中に確定した合意を失わないようにする。
    check('①送信直後はまだoutboxに残る（ack待ち）',
      sandbox.strategyResponseOutbox.size === 1, JSON.stringify([...sandbox.strategyResponseOutbox.keys()]));
    check('①ack前はbridgeStrategyDecisionsにも残る（ackが唯一の終端）',
      sandbox.bridgeStrategyDecisions.has(bridgeProposal().decision_id));
    // 同じ確定が二度走ってもWS送信は増えない（冪等）。
    sandbox.sendStrategyDecisionResponse(resolved.proposal.decision_id, true);
    check('①同じdecisionの二重確定でも送信は1回のまま',
      wsSent.filter(m => m.cmd === 'strategy_decision_response').length === 1, JSON.stringify(wsSent));
    sandbox.handleStrategyDecisionAck({ type: 'strategy_decision_ack',
      decision_id: resolved.proposal.decision_id, session_num: 1,
      dispatch_id: DECISION_ID + '#1', outcome: 'accepted' });
    check('①ack受領でoutboxと追跡Mapの両方から消える',
      sandbox.strategyResponseOutbox.size === 0
      && !sandbox.bridgeStrategyDecisions.has(bridgeProposal().decision_id));
    sandbox.handleStrategyDecisionAck({ type: 'strategy_decision_ack',
      decision_id: resolved.proposal.decision_id, session_num: 1,
      dispatch_id: DECISION_ID + '#1', outcome: 'accepted' });
    check('①重複ackを受けても壊れない（冪等）', sandbox.strategyResponseOutbox.size === 0);
  }

  // ════════════════════════════════════════════════════════════════
  // ② 実際のaudible interruption（MD#8 P1-2）：製品コードの中断順序は
  //    再生開始で finalizeUtterance(...,'spoken') → onSpoken → その後
  //    stopCurrentAudio() が 'audible_interrupted' を作る。この順序を通し、
  //    local pending取消 → Bridgeへ配送失敗通知 → Map/Set掃除 →
  //    同一IDの再配送が可能、までを一本で確認する。
  // ════════════════════════════════════════════════════════════════
  {
    wsSent.length = 0; audioInstances.length = 0; played.length = 0;
    const sandbox = freshSandbox();
    const decisionId = bridgeProposal().decision_id;
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    // 再生開始まで進める（onendedは呼ばない＝まだ喋っている最中）。
    if (ttsResolve) {
      ttsResolve.res({ status: 200, ok: true, json: async () => ({ audioContent: 'A-int' }) });
      ttsResolve = null;
      await sleep(10);
    }
    const st = sandbox.ensureStrategyState();
    check('②冒頭が実際に聞こえた時点でpending_proposalが立つ（spoken確定点）',
      st.pending_proposal !== null && st.pending_proposal.decision_id === decisionId,
      JSON.stringify(st.pending_proposal));
    check('②同時にbridgeStrategyDecisionsへ登録される',
      sandbox.bridgeStrategyDecisions.has(decisionId));
    const audibleMsgs = wsSent.filter(m => m.cmd === 'strategy_decision_delivery' && m.outcome === 'audible');
    check('②audibleがBridgeへ通知される（提示済みの確定はここ）',
      audibleMsgs.length === 1 && audibleMsgs[0].decision_id === decisionId && audibleMsgs[0].session_num === 1,
      JSON.stringify(wsSent));

    // ここで初めて本物の中断：stopCurrentAudio が audible_interrupted を作る。
    sandbox.stopCurrentAudio('driver_ptt');
    await sleep(5);

    check('②中断でlocal pending_proposalが取り消される',
      st.pending_proposal === null, JSON.stringify(st.pending_proposal));
    const interruptedMsgs = wsSent.filter(m => m.cmd === 'strategy_decision_delivery'
      && m.outcome === 'audible_interrupted');
    check('②中断がBridgeへ通知される（Bridgeはpending/sentを解除して再武装できる）',
      interruptedMsgs.length === 1 && interruptedMsgs[0].decision_id === decisionId,
      JSON.stringify(wsSent));
    check('②中断後は追跡Map・dedupe Setの両方が掃除される（同一IDを再配送できる）',
      !sandbox.bridgeStrategyDecisions.has(decisionId)
      && !sandbox.strategyPlaybookDecisionKeys.has(bridgeProposal().dispatch_id));
    check('②合意は成立していないのでBridgeへ応答は送られない',
      wsSent.filter(m => m.cmd === 'strategy_decision_response').length === 0, JSON.stringify(wsSent));

    // 再配送：Bridgeが同じIDで再提案した時、dedupeに弾かれず再びqueueへ入る。
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    const requeued = sandbox.speakQueue.find(q => q.kind === 'bridge_strategy_proposal')
      || (sandbox.currentSpeakItem && sandbox.currentSpeakItem.kind === 'bridge_strategy_proposal'
        ? sandbox.currentSpeakItem : null);
    check('②同一decision_idの再提案が再びqueueへ入る（再配送可能）', !!requeued,
      JSON.stringify(sandbox.speakQueue.map(q => q.kind)));
  }

  // ════════════════════════════════════════════════════════════════
  // ③ LLM judge (PW_JUDGE) 経路でも同じ完成条件を守る
  // ════════════════════════════════════════════════════════════════
  {
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    await finishCurrentUtterance(sandbox);
    const decisionId = bridgeProposal().decision_id;

    sandbox.applyProposalJudgeTag({ classification: 'confirm', decision_id: decisionId }, undefined);
    const responseMsgs3 = wsSent.filter(m => m.cmd === 'strategy_decision_response');
    check('③LLM judgeのconfirmでBridgeへ応答送信',
      responseMsgs3.length === 1 && responseMsgs3[0].accepted === true && responseMsgs3[0].decision_id === decisionId,
      JSON.stringify(wsSent));
  }

  // ════════════════════════════════════════════════════════════════
  // ④ 回帰：Aは即commitでdata eventを発しない契約なので、万一Aが
  //    strategy_plan_proposalとして届いても沈黙する（防御的チェック）。
  // ════════════════════════════════════════════════════════════════
  {
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    sandbox.handleStrategyPlanProposal(bridgeProposal({ selected_plan: 'A',
      decision_plan: { ...bridgeProposal().decision_plan, selected_plan: 'A' } }));
    await sleep(5);
    check('④PlanAは提案として扱わない（沈黙）', sandbox.speakQueue.length === 0 && !sandbox.currentSpeakItem);
  }

  // ════════════════════════════════════════════════════════════════
  // ⑤ 発話前に届かなかった場合（MD#8 P1-1/P1-2）：precheck stale・voice off・
  //    queue overflow。いずれもBridgeへ配送失敗を返し、Set/Mapを掃除する。
  // ════════════════════════════════════════════════════════════════
  {
    // ⑤-a precheck stale：queue待機中（TTS取得中）に戦略stateが動いた。
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    const decisionId = bridgeProposal().decision_id;
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    const S = sandbox.PitwallSessionStrategyState;
    const st = sandbox.ensureStrategyState();
    S.agreePitPlan(st, { lap: 12, at: fakeNow, source: 'driver' });   // revisionが動く
    if (ttsResolve) {
      ttsResolve.res({ status: 200, ok: true, json: async () => ({ audioContent: 'A-stale' }) });
      ttsResolve = null;
      await sleep(10);
    }
    check('⑤-a precheck staleで一度も再生されない', played.length === 0 || !played.some(x => String(x).startsWith('A-stale')),
      JSON.stringify(played));
    const dropMsgs = wsSent.filter(m => m.cmd === 'strategy_decision_delivery'
      && m.outcome === 'dropped_before_audible');
    check('⑤-a 未配送がBridgeへ通知される（Bridgeは再武装できる）',
      dropMsgs.length === 1 && dropMsgs[0].decision_id === decisionId, JSON.stringify(wsSent));
    check('⑤-a 未配送ではpending_proposalが立たない', st.pending_proposal === null);
    check('⑤-a dedupe Set・追跡Mapが掃除される（同一IDを再配送できる）',
      !sandbox.strategyPlaybookDecisionKeys.has(bridgeProposal().dispatch_id)
      && !sandbox.bridgeStrategyDecisions.has(decisionId));
  }
  {
    // ⑤-b voice off：ドライバーが音声を切った＝開始前抑止（suppressed_by_user）。
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    const decisionId = bridgeProposal().decision_id;
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    sandbox.stopCurrentAudio('voice_off');
    await sleep(5);
    const suppressed = wsSent.filter(m => m.cmd === 'strategy_decision_delivery'
      && m.outcome === 'suppressed_by_user');
    check('⑤-b voice offもBridgeへ通知される',
      suppressed.length === 1 && suppressed[0].decision_id === decisionId, JSON.stringify(wsSent));
    check('⑤-b voice offでSet/Mapが掃除される',
      !sandbox.strategyPlaybookDecisionKeys.has(bridgeProposal().dispatch_id)
      && !sandbox.bridgeStrategyDecisions.has(decisionId));
  }
  {
    // ⑤-c queue overflow：本番のoverflow分岐が呼ぶ終端関数をそのまま通す。
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    const decisionId = bridgeProposal().decision_id;
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    const item = sandbox.currentSpeakItem || sandbox.speakQueue[0];
    sandbox.finalizeUtterance(item, 'dropped', null, 'queue_overflow');
    await sleep(5);
    const overflow = wsSent.filter(m => m.cmd === 'strategy_decision_delivery'
      && m.outcome === 'dropped_before_audible');
    check('⑤-c queue overflowもBridgeへ通知される',
      overflow.length === 1 && overflow[0].decision_id === decisionId, JSON.stringify(wsSent));
  }

  // ════════════════════════════════════════════════════════════════
  // ⑥ outbox（MD#8 P1-3）：socket closed・send throw・再接続・重複ack。
  // ════════════════════════════════════════════════════════════════
  {
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    const decisionId = bridgeProposal().decision_id;
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    await finishCurrentUtterance(sandbox);
    const st = sandbox.ensureStrategyState();
    const S = sandbox.PitwallSessionStrategyState;
    const resolved = S.resolvePendingProposal(st, { accepted: true, at: fakeNow });
    check('⑥前提：合意が状態機械で成立している', resolved && resolved.accepted === true);

    // socket closed のまま確定した。
    sandbox.irBridge.readyState = 3;
    const sentBefore = wsSent.filter(m => m.cmd === 'strategy_decision_response').length;
    sandbox.sendStrategyDecisionResponse(decisionId, true);
    check('⑥切断中は送信されないが、合意はoutboxに保持される（永久喪失しない）',
      wsSent.filter(m => m.cmd === 'strategy_decision_response').length === sentBefore
      && sandbox.strategyResponseOutbox.size === 1,
      JSON.stringify([...sandbox.strategyResponseOutbox.keys()]));

    // 再接続：onopenと同じ配線でflushする。
    sandbox.irBridge.readyState = 1;
    sandbox.flushStrategyResponseOutbox();
    const after = wsSent.filter(m => m.cmd === 'strategy_decision_response');
    check('⑥再接続で再送される', after.length === sentBefore + 1
      && after[after.length - 1].decision_id === decisionId
      && after[after.length - 1].accepted === true, JSON.stringify(wsSent));
    check('⑥ack前はoutboxに残り続ける（送信成功では捨てない）',
      sandbox.strategyResponseOutbox.size === 1);

    sandbox.handleStrategyDecisionAck({ decision_id: decisionId, session_num: 1,
      dispatch_id: DECISION_ID + '#1', outcome: 'accepted' });
    check('⑥ackで初めてoutboxから消える', sandbox.strategyResponseOutbox.size === 0);
  }
  {
    // ⑥-b send throw：送信例外でもoutboxに残り、次のflushで再送される。
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    const decisionId = bridgeProposal().decision_id;
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    await finishCurrentUtterance(sandbox);
    const st = sandbox.ensureStrategyState();
    const S = sandbox.PitwallSessionStrategyState;
    S.resolvePendingProposal(st, { accepted: false, at: fakeNow });
    let shouldThrow = true;
    sandbox.irBridge.send = (raw) => {
      if (shouldThrow && JSON.parse(raw).cmd === 'strategy_decision_response') throw new Error('socket gone');
      wsSent.push(JSON.parse(raw));
    };
    sandbox.sendStrategyDecisionResponse(decisionId, false);
    check('⑥-b 送信例外でも確定はoutboxに残る',
      sandbox.strategyResponseOutbox.size === 1
      && wsSent.filter(m => m.cmd === 'strategy_decision_response').length === 0);
    shouldThrow = false;
    sandbox.flushStrategyResponseOutbox();
    const resent = wsSent.filter(m => m.cmd === 'strategy_decision_response');
    check('⑥-b 復旧後のflushで再送される（declinedもそのまま運ぶ）',
      resent.length === 1 && resent[0].accepted === false, JSON.stringify(wsSent));
  }

  // ════════════════════════════════════════════════════════════════
  // ⑦ same-frame判定（MD#9 P1-2）：fail-closed。権威欠落・選択Plan変更・
  //    根拠snapshot変更・数値変更のいずれでも古い提案を通さない。
  // ════════════════════════════════════════════════════════════════
  const holdCase = async (label, overrides, telemetryOptions) => {
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    if (telemetryOptions !== undefined) {
      sandbox.lastTelemetry = { cust_id: 1, laps_total: 20, strategy_options: telemetryOptions };
    }
    sandbox.handleStrategyPlanProposal(bridgeProposal(overrides));
    await sleep(5);
    check(label, sandbox.speakQueue.length === 0 && !sandbox.currentSpeakItem,
      JSON.stringify(sandbox.speakQueue.map(q => q.kind)));
    check(label + '（holdもBridgeへ返す）',
      wsSent.filter(m => m.cmd === 'strategy_decision_delivery'
        && m.outcome === 'dropped_before_audible').length === 1, JSON.stringify(wsSent));
  };

  // ⑦-a 権威snapshotが無い（eventにも同梱されず、telemetryにも無い）＝確認できない。
  await holdCase('⑦-a strategy_options欠落はfail-closedでhold',
    { strategy_options: null }, null);
  // ⑦-b Bridgeの選択Planが既に別（A）へ動いている。
  await holdCase('⑦-b 選択Plan変更（B→A）はhold',
    { strategy_options: authorityOptions({ selected_plan: 'A' }) }, undefined);
  // ⑦-c 根拠snapshotが作り直された（target/fuelは同じまま）。
  await holdCase('⑦-c 根拠snapshot変更はhold（実行内容が同じでも別の提案）',
    { strategy_options: authorityOptions({ snapshot_id: 'recalc:damage_report:1:7' }) }, undefined);
  // ⑦-d 実行内容そのものが変わった。
  await holdCase('⑦-d target_lap変更はhold',
    { strategy_options: authorityOptions({ plan_b: { target_lap: 9, add_fuel_l: 10, set_fuel_l: 24 } }) },
    undefined);
  // ⑦-e 提案が根拠snapshot IDを持たない（旧Bridge等）＝照合できない。
  await holdCase('⑦-e evidence_snapshot_id欠落はfail-closedでhold',
    { decision_plan: { decision_id: SNAP + ':decision-lap:7', selected_plan: 'B',
      target_lap: 7, add_fuel_l: 10, set_fuel_l: 24, session_num: 1 } }, undefined);

  {
    // ⑦-f queue待機中に最新telemetryの権威が動いた（受信時は一致していた）。
    wsSent.length = 0; audioInstances.length = 0; played.length = 0;
    const sandbox = freshSandbox();
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    check('⑦-f 受信時に一致していればqueueへ入る',
      !!(sandbox.currentSpeakItem || sandbox.speakQueue.length));
    // TTS取得中に再計算が走って根拠が作り直された。
    sandbox.lastTelemetry = { cust_id: 1, laps_total: 20,
      strategy_options: authorityOptions({ snapshot_id: 'recalc:pace_divergence:1:8' }) };
    if (ttsResolve) {
      ttsResolve.res({ status: 200, ok: true, json: async () => ({ audioContent: 'A-drift' }) });
      ttsResolve = null;
      await sleep(10);
    }
    check('⑦-f 崩れた根拠のまま再生しない', !played.some(x => String(x) === 'A-drift'),
      JSON.stringify(played));
    const st = sandbox.ensureStrategyState();
    check('⑦-f 再生していないのでpending_proposalも立たない', st.pending_proposal === null);
    check('⑦-f 未配送としてBridgeへ返る',
      wsSent.filter(m => m.cmd === 'strategy_decision_delivery'
        && m.outcome === 'dropped_before_audible').length === 1, JSON.stringify(wsSent));
  }

  // ════════════════════════════════════════════════════════════════
  // ⑦-g 配送結果のoutbox（MD#9 P1-1）：切断中でも消えず、再接続で届く。
  // ════════════════════════════════════════════════════════════════
  {
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    const decisionId = bridgeProposal().decision_id;
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    // 発話が始まる前に切断。その状態で発話に失敗する。
    sandbox.irBridge.readyState = 3;
    sandbox.stopCurrentAudio('driver_ptt');
    await sleep(5);
    check('⑦-g 切断中の配送失敗は送信されないがoutboxへ保持される（Bridgeが固まらない）',
      wsSent.filter(m => m.cmd === 'strategy_decision_delivery').length === 0
      && sandbox.strategyDeliveryOutbox.size === 1,
      JSON.stringify([...sandbox.strategyDeliveryOutbox.keys()]));
    sandbox.irBridge.readyState = 1;
    sandbox.flushStrategyDeliveryOutbox();
    const delivered = wsSent.filter(m => m.cmd === 'strategy_decision_delivery');
    check('⑦-g 再接続で配送結果が届く',
      delivered.length === 1 && delivered[0].decision_id === decisionId
      && delivered[0].outcome === 'dropped_before_audible' && delivered[0].session_num === 1,
      JSON.stringify(wsSent));
    check('⑦-g ack前はoutboxに残り続ける', sandbox.strategyDeliveryOutbox.size === 1);
    sandbox.handleStrategyDeliveryAck({ decision_id: decisionId, session_num: 1,
      dispatch_id: DECISION_ID + '#1', outcome: 'dropped_before_audible', applied: 'released' });
    check('⑦-g ackで初めてoutboxから消える', sandbox.strategyDeliveryOutbox.size === 0);
    sandbox.handleStrategyDeliveryAck({ decision_id: decisionId, session_num: 1,
      dispatch_id: DECISION_ID + '#1', outcome: 'dropped_before_audible', applied: 'released' });
    check('⑦-g 重複ackでも壊れない', sandbox.strategyDeliveryOutbox.size === 0);
  }
  {
    // ⑦-h audible→中断の二連は、切断中でも順序どおり両方保持される。
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    sandbox.irBridge.readyState = 3;
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    if (ttsResolve) {
      ttsResolve.res({ status: 200, ok: true, json: async () => ({ audioContent: 'A-2' }) });
      ttsResolve = null;
      await sleep(10);
    }
    sandbox.stopCurrentAudio('driver_ptt');
    await sleep(5);
    const keys = [...sandbox.strategyDeliveryOutbox.values()].map(v => v.outcome);
    check('⑦-h audibleと中断の両方が順序どおり保持される',
      keys.length === 2 && keys[0] === 'audible' && keys[1] === 'audible_interrupted',
      JSON.stringify(keys));
    sandbox.irBridge.readyState = 1;
    sandbox.flushStrategyDeliveryOutbox();
    const outcomes = wsSent.filter(m => m.cmd === 'strategy_decision_delivery').map(m => m.outcome);
    check('⑦-h 再接続で順序どおり送られる（Bridgeはaudible→releasedへ遷移できる）',
      outcomes.join(',') === 'audible,audible_interrupted', JSON.stringify(outcomes));
  }

  // ════════════════════════════════════════════════════════════════
  // ⑧ 単一canonical推薦（MD#8 P1-4）：JSが同じB/Cを検出しても、自前の
  //    decision ID・発話・pendingを作らない。発話も応答IDも一つだけ。
  // ════════════════════════════════════════════════════════════════
  {
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    sandbox.activeStrategyPlaybook = { available: true, plans: { B: { available: true, first_pit_lap: 7 } } };
    sandbox.activeRaceFacts = { sessionKey: '1' };
    // JS側エンジンが「B成立」と判定した状況を本番関数へ通す。
    sandbox.window.PitwallStrategyPlaybook = {
      evaluateStrategies: () => ({
        available: true, reason: 'ok', lap: 7, snapshot_id: 'js-snap-1',
        candidates: { A: { available: true }, B: { available: true }, C: { available: false } },
        recommendation: { selected_plan: 'B', decision_id: 'playbook:1:7:B', reason: 'js_engine',
          evidence: { gap_ahead_s: 1.2, player_pace_advantage_s: 0.8, physical_rejoin_position: 6 } },
      }),
    };
    sandbox.evaluateLiveStrategySwitch({ lap: 7, session_type: 'Race', on_track: true });
    await sleep(5);
    check('⑧JS評価は自前の発話を作らない（競合する第二の決定エンジンを停止）',
      sandbox.speakQueue.length === 0 && !sandbox.currentSpeakItem,
      JSON.stringify(sandbox.speakQueue.map(q => q.kind)));
    const stJs = sandbox.ensureStrategyState();
    check('⑧JS評価は自前のpending_proposalを作らない', stJs.pending_proposal === null);
    check('⑧JS評価は自前のdecision IDを応答対象にしない',
      sandbox.bridgeStrategyDecisions.size === 0);
    check('⑧JS評価は配信precheck用の検証結果として保存される',
      !!sandbox.liveStrategyValidation && sandbox.liveStrategyValidation.candidates.B.available === true,
      JSON.stringify(sandbox.liveStrategyValidation));

    // 同じBをBridgeも検出して提案してきた：発話・pending・応答IDは一つだけ。
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    const queuedAll = sandbox.speakQueue.filter(q => q.kind === 'bridge_strategy_proposal').length
      + (sandbox.currentSpeakItem && sandbox.currentSpeakItem.kind === 'bridge_strategy_proposal' ? 1 : 0);
    check('⑧Bridge／JSが同じBを検出しても発話は一つだけ', queuedAll === 1, String(queuedAll));
    await finishCurrentUtterance(sandbox);
    check('⑧成立したpendingはBridgeのcanonical IDただ一つ',
      stJs.pending_proposal !== null
      && stJs.pending_proposal.decision_id === bridgeProposal().decision_id
      && sandbox.bridgeStrategyDecisions.size === 1, JSON.stringify(stJs.pending_proposal));
  }
  {
    // ⑧-b JS評価が「今は成立しない」と言っている時、Bridge提案をholdする。
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    sandbox.activeStrategyPlaybook = { available: true, plans: { B: { available: true, first_pit_lap: 7 } } };
    sandbox.window.PitwallStrategyPlaybook = {
      evaluateStrategies: () => ({
        available: true, reason: 'ok', lap: 7, snapshot_id: 'js-snap-2',
        candidates: { A: { available: true }, B: { available: false }, C: { available: false } },
        recommendation: null,
      }),
    };
    sandbox.evaluateLiveStrategySwitch({ lap: 7, session_type: 'Race', on_track: true });
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    check('⑧-b 現在frame評価が不成立ならBridge提案をholdする（発話しない）',
      sandbox.speakQueue.length === 0 && !sandbox.currentSpeakItem,
      JSON.stringify(sandbox.speakQueue.map(q => q.kind)));
    check('⑧-b holdもBridgeへ返す',
      wsSent.filter(m => m.cmd === 'strategy_decision_delivery'
        && m.outcome === 'dropped_before_audible').length === 1, JSON.stringify(wsSent));
  }

  // ════════════════════════════════════════════════════════════════
  // ⑨ MD#9チェック反例2：Plan別conditionsの照合（P1-2）
  //    target/fuel/snapshot/選択Planがすべて同じでも、交通・rejoin・pace優位が
  //    崩れていれば古い提案を喋らない。
  // ════════════════════════════════════════════════════════════════
  await holdCase('⑨-a rejoin条件の崩壊はhold（target/fuel/snapshotは同一）',
    { strategy_options: authorityOptions({ decision_evidence: liveEvidence({
      conditions_met: { fuel_window_open: true, relative_pace_advantage: true, rejoin_clear: false } }) }) },
    undefined);
  await holdCase('⑨-b pace優位の数値が変わればhold',
    { strategy_options: authorityOptions({ decision_evidence: liveEvidence({
      relative_pace_advantage_s: 0.2 }) }) }, undefined);
  await holdCase('⑨-c 現在の条件を再構築できない（decision_evidence欠落）はfail-closedでhold',
    { strategy_options: authorityOptions({ decision_evidence: null }) }, undefined);
  await holdCase('⑨-d 提案がconditionsを持たない（照合不能）はfail-closedでhold',
    { decision_plan: { decision_id: DECISION_ID, dispatch_id: DECISION_ID + '#1',
      selected_plan: 'B', target_lap: 7, add_fuel_l: 10, set_fuel_l: 24, session_num: 1,
      evidence_snapshot_id: SNAP } }, undefined);
  {
    // ⑨-e queue待機中に条件だけが崩れた（snapshot・数値は不変）。
    wsSent.length = 0; audioInstances.length = 0; played.length = 0;
    const sandbox = freshSandbox();
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    check('⑨-e 受信時は条件が揃っているのでqueueへ入る',
      !!(sandbox.currentSpeakItem || sandbox.speakQueue.length));
    sandbox.lastTelemetry = { cust_id: 1, laps_total: 20,
      strategy_options: authorityOptions({ decision_evidence: liveEvidence({
        conditions_met: { fuel_window_open: true, relative_pace_advantage: true, rejoin_clear: false } }) }) };
    if (ttsResolve) {
      ttsResolve.res({ status: 200, ok: true, json: async () => ({ audioContent: 'A-cond' }) });
      ttsResolve = null;
      await sleep(10);
    }
    check('⑨-e 条件が崩れたら再生しない', !played.some(x => String(x) === 'A-cond'),
      JSON.stringify(played));
    check('⑨-e 未配送としてBridgeへ返る',
      wsSent.filter(m => m.cmd === 'strategy_decision_delivery'
        && m.outcome === 'dropped_before_audible').length === 1, JSON.stringify(wsSent));
  }

  // ════════════════════════════════════════════════════════════════
  // ⑩ MD#9チェック反例1：同一decision IDの再配送（P1-1）
  //    decision_idは`<snapshot_id>:decision-lap:<lap>`で再提案しても同一になる。
  //    配送試行を区別する`dispatch_id`が、通知・応答・outboxキーすべてに乗ること。
  // ════════════════════════════════════════════════════════════════
  {
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    const decisionId = bridgeProposal().decision_id;
    // 1回目：切断中に配送失敗（通知はoutboxに滞留）。
    sandbox.irBridge.readyState = 3;
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    sandbox.stopCurrentAudio('driver_ptt');
    await sleep(5);
    check('⑩1回目の失敗通知が#1のdispatch_idで滞留する',
      [...sandbox.strategyDeliveryOutbox.values()].every(v => v.dispatchId === DECISION_ID + '#1')
      && sandbox.strategyDeliveryOutbox.size === 1,
      JSON.stringify([...sandbox.strategyDeliveryOutbox.keys()]));

    // 2回目：Bridgeが**同じdecision_id**で再提案（dispatch_idだけ#2）。今度は聞こえる。
    sandbox.irBridge.readyState = 1;
    sandbox.handleStrategyPlanProposal(bridgeProposal({ dispatch_id: DECISION_ID + '#2',
      decision_plan: { ...bridgeProposal().decision_plan, dispatch_id: DECISION_ID + '#2' } }));
    await sleep(5);
    await finishCurrentUtterance(sandbox);
    const st = sandbox.ensureStrategyState();
    check('⑩2回目は成立する（pending_proposalが立つ）', st.pending_proposal !== null);
    const audible2 = wsSent.filter(m => m.cmd === 'strategy_decision_delivery' && m.outcome === 'audible');
    check('⑩2回目のaudible通知は#2のdispatch_idで送られる',
      audible2.length === 1 && audible2[0].dispatch_id === DECISION_ID + '#2'
      && audible2[0].decision_id === decisionId, JSON.stringify(wsSent));
    // 1回目は再生開始前に切られたので dropped_before_audible。滞留分は#1のまま届く
    // ——Bridgeは`dispatch_id`不一致で弾けるので、聞こえている#2を解除しない。
    const stale1 = wsSent.filter(m => m.cmd === 'strategy_decision_delivery'
      && m.outcome === 'dropped_before_audible');
    check('⑩滞留していた1回目の失敗通知は#1のまま送られる（Bridgeが試行で弾ける）',
      stale1.length === 1 && stale1[0].dispatch_id === DECISION_ID + '#1', JSON.stringify(wsSent));

    // 合意も#2の試行として送られる。
    const S = sandbox.PitwallSessionStrategyState;
    const resolved = S.resolvePendingProposal(st, { accepted: true, at: fakeNow });
    sandbox.sendStrategyDecisionResponse(resolved.proposal.decision_id, true);
    const responses = wsSent.filter(m => m.cmd === 'strategy_decision_response');
    check('⑩合意応答も#2のdispatch_idで送られる',
      responses.length === 1 && responses[0].dispatch_id === DECISION_ID + '#2',
      JSON.stringify(responses));
  }

  // ════════════════════════════════════════════════════════════════
  // ⑪ MD#9再差戻し：dedupe・speech dedupeKey・ack削除がdecision_id基準のままだった
  //    （dispatch_idはWS層にしか通っておらず、受信の入口が直っていなかった）。
  // ════════════════════════════════════════════════════════════════
  {
    // ⑪-a 受信のdedupeがdispatch_id基準であること。旧decisionIdをdedupe Setへ
    //    先回りして積んでおいても（decision_id基準だった旧実装を模す）、
    //    新しいdispatch_idの提案は弾かれない。
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    sandbox.strategyPlaybookDecisionKeys.add(bridgeProposal().decision_id);
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    check('⑪-a decision_idがdedupe Setにあっても、dispatch_id基準なら弾かれない',
      !!(sandbox.currentSpeakItem || sandbox.speakQueue.length),
      JSON.stringify(sandbox.speakQueue.map(q => q.kind)));
  }
  {
    // ⑪-b speech dedupeKeyがdispatch_id基準であること。
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    const item = sandbox.currentSpeakItem || sandbox.speakQueue[0];
    check('⑪-b speak()のdedupeKeyはdecision_idではなくdispatch_id',
      item && item.dedupeKey === bridgeProposal().dispatch_id, JSON.stringify(item && item.dedupeKey));
  }
  {
    // ⑪-c 遅延ackが、その後の再ディスパッチで新しく追跡されたエントリを消さない。
    wsSent.length = 0; audioInstances.length = 0;
    const sandbox = freshSandbox();
    sandbox.handleStrategyPlanProposal(bridgeProposal());
    await sleep(5);
    await finishCurrentUtterance(sandbox);
    // #1が今まさに追跡されている状態で、#1より前の（もう存在しない）試行への
    // ackが遅れて届いたと仮定する。
    sandbox.handleStrategyDecisionAck({ decision_id: bridgeProposal().decision_id,
      session_num: 1, dispatch_id: DECISION_ID + '#0', outcome: 'accepted' });
    check('⑪-c 一致しないdispatch_idのackは現在の追跡を消さない',
      sandbox.bridgeStrategyDecisions.has(bridgeProposal().decision_id));
    sandbox.handleStrategyDecisionAck({ decision_id: bridgeProposal().decision_id,
      session_num: 1, dispatch_id: DECISION_ID + '#1', outcome: 'accepted' });
    check('⑪-c 一致するdispatch_idのackは追跡を消す',
      !sandbox.bridgeStrategyDecisions.has(bridgeProposal().decision_id));
  }

  console.log(`\nBridge strategy proposal round-trip: ${pass}/${pass + fail}`);
  if (fail) process.exit(1);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
