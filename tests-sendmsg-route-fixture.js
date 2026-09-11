#!/usr/bin/env node
/**
 * ★Codex差戻し残作業1：実 onmessage → 実 sendMsg → 実 route の入口証明
 * （2026-09-10続報3：無条件pass-through除去・次telemetry/別driver/切断/session境界を追加）
 *
 * 前回までの fixture は `live:{cust_id:..., track:'固定値', ...}` を試験内で
 * 手動再構成していた。Codex の変異試験（`lastTelemetry`からcust_idを剥がす
 * 変異を注入してもexit 0のまま）により、これが「入口の証明」になっていない
 * ことが実証された。
 *
 * ここでは renderer.html の実関数を4つ連結して実行する：
 *   実 irBridge.onmessage（websocketハンドラ本体）
 *     → 実 telemetry_live / session_info / session_summary 処理
 *   実 sendMsg（チャット送信ハンドラ本体）
 *     → 実 window.PitwallLocalIntentRouter.route() 呼び出し
 *     → 実 speak() 呼び出しまで
 *
 * ★Codex再指摘（2026-09-10続報3）：「未知識別子を全てpass-throughするProxy
 *   ではauthority処理も代替される」。実際に無条件pass-through版で実行すると、
 *   `if(activeStrategyPlaybook)` のような真偽判定に使われる変数までが
 *   「呼べば引数を返す関数オブジェクト」（=常にtruthy）にすり替わり、
 *   本来falseになるべき分岐がtrueに化けることを確認した。
 *   → 対応：sendMsg/onmessageが実際に参照する識別子を全て洗い出し、
 *     明示的なallow-listとして登録した。それ以外の識別子アクセスは
 *     Proxyがthrowする（想定外依存を無条件で見逃さない）。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const RENDERER_PATH = path.join(__dirname, 'desktop/renderer.html');
const ROUTER_PATH = path.join(__dirname, 'desktop/local-intent-router.js');
const SESSION_MEMORY_PATH = path.join(__dirname, 'desktop/session-memory.js');

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  let i = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`unbalanced braces: ${marker}`);
  return src.slice(start, end);
}

function extractArrowAssignment(src, marker) {
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error(`marker not found: ${marker}`);
  const start = idx + marker.length;
  let i = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`unbalanced braces: ${marker}`);
  return src.slice(start, end);
}

// srcMutator: (renderer.html の文字列) => 変異注入済み文字列。null なら無変異（baseline）。
function buildHarness(srcMutator) {
  let src = fs.readFileSync(RENDERER_PATH, 'utf8');
  if (srcMutator) src = srcMutator(src);

  const fnOnMessageSrc = extractArrowAssignment(src, 'irBridge.onmessage=');
  const fnSendMsgSrc = '(' + extractFunction(src, 'async function sendMsg(') + ')';
  const fnLoadRaceHistorySrc = extractFunction(src, 'function loadRaceHistory(');
  const fnSaveSessionSummarySrc = extractFunction(src, 'function saveSessionSummary(');
  const fnSanitizeSrc = extractFunction(src, 'function sanitizeSessionEvidence(');
  const fnValidFinishSrc = extractFunction(src, 'function validFinishPosition(');
  const fnCurrentMemoryUserIdSrc = extractFunction(src, 'function currentMemoryUserId(');
  // ★Codex差戻し（残件2）：applySessionFormatAuthority/markTelemetryStaleを
  //   pass-through/試験内直接代入で代用していた。実関数を抽出して使う。
  const fnSessionDurationSecondsSrc = extractFunction(src, 'function sessionDurationSeconds(');
  const fnApplySessionFormatAuthoritySrc = extractFunction(src, 'function applySessionFormatAuthority(');
  const fnMarkTelemetryStaleSrc = extractFunction(src, 'function markTelemetryStale(');

  const speakCalls = [];

  // ★route()に至る経路上で参照される全識別子を明示登録（無条件pass-through廃止）。
  //   分類ごとにコメントで理由を残す。
  const namedStubs = {
    // -- confirmation/dispute/team-plan 系：previous_fuel経路では常に不一致・
    //    未保留として通過させる（今回の質問応答フローに無関係と確認済み） --
    pendingConfirmationKinds: () => [],
    bareConfirmationAnswer: () => null,
    handleLunaSelfMemoryInput: () => null,
    handleReflexDispute: () => false,
    handleTeamPlanUtterance: () => false,
    handleGapDispute: () => false,
    handleRelativePaceQuestion: () => false,
    ensureConversationBox: () => null,
    ensureStrategyState: () => null,
    currentGapHeld: () => null,
    isExplicitMemoryRequest: () => false,
    isManualReviewCommand: () => false,
    answerHistoricalWeatherLocally: () => null,
    callAPI: async () => {},
    // -- utterance/表示系：本fixtureはspeak捕捉のみが目的（実描画はtests-previous-fuel-utterance-fixture.jsが担当） --
    nextUtteranceId: () => 'u_test',
    addMsg: (type, text) => ({ _mockEl: true, textContent: text }),
    pushMsg: () => 'mid_test',
    speak: (text, opts) => { speakCalls.push({ text, opts }); },
    // -- telemetry_live 内の副作用専用呼び出し（戻り値未使用・previous_fuel回答に無関係） --
    prepareMemoryBrain: () => {},
    captureConfirmedFuelCapacity: () => {},
    maybeQuietMode: () => {},
    diagnosticLog: () => {},
    saveMemory: () => {},
    announceActiveStrategyObjective: () => {},
    bridgeVoice: () => {},
    captureDrivingStyleProfile: () => {},
    captureTeamStintLap: () => {},
    evaluateLiveStrategySwitch: () => {},
    evaluateTeamPlanLiveEvidence: () => {},
    hydrateLegacyStrategyObjective: () => {},
    injectBriefing: () => {},
    maybeAnnounceEnduranceFuelForecast: () => {},
    maybeDeliverFuelWindowWatch: () => {},
    maybeRunOperationalFollowUp: () => {},
    observePitState: () => {},
    observeRelativePace: () => {},
    persistTeamRaceLearning: () => {},
    reconcileEvidenceSummary: () => {},
    recordDecisionStage: () => {},
    refreshStrategyPlaybook: () => {},
    rememberLiveFuelEvidence: () => {},
    scheduleAutoDebrief: () => {},
    syncDecisionsToServer: () => {},
    updateBridgeStatus: () => {},
    updatePracticeRun: () => {},
    updateStrategyPlaybookFromLive: () => {},
    applySessionFuelAuthority: () => {},
    resetSessionScopedReviewState: () => {},
    resetPitStateObservation: () => {},
    // -- 真偽判定に使われる「変数」。関数オブジェクトを返すpass-throughは常にtruthyになり
    //    誤動作する（本fixtureで実際に検出した問題）。明示的にプリミティブで初期化する。 --
    evidenceDebrief: null,
    memorySaveReceipt: '',
    pendingDecisionDispute: null,
    pendingDrivingStyleAdvice: null,
    strategyStartingFuelL: null,
    activeStrategyPlaybook: null,
  };

  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
  };

  const state = {
    console, JSON, Number, String, Array, Object, Date, Math, isNaN, parseFloat, RegExp, Boolean, Promise,
    localStorage,
    document: { getElementById: () => ({ value: '前回給油は？', style: {} }) },
    window: {
      // ★実 router / 実 sessionMemory を require（コピー禁止）
      PitwallLocalIntentRouter: require(ROUTER_PATH),
      PitwallSessionMemory: require(SESSION_MEMORY_PATH),
    },
    SPEAK_PRIO: { P0_SAFETY: 0, P1_HAZARD: 1, P2_PROCEDURE: 2, P3_STRATEGY: 3, P4_INFO: 4, P5_CHAT: 5 },
    lastTelemetry: null, lastTrack: '', lastCarModel: '', lastCarClass: '',
    lastSessionType: null, lastSessionAuthority: null, lastIrating: null, lastSr: null, lastSessionNum: null,
    currentSessionCustId: null,
    // ★実applySessionFormatAuthorityが参照する（0件のsession_detailsなら常にno-opでsnapshotをそのまま返す）
    lastWeekendAuthority: null,
    iracingDetected: false, iracingLive: false, usageIracingLive: false,
    iracingConnectedAt: 0, lastTelemetryAt: 0, telemetryStaleNotified: false, iracingConnectionSeen: false,
    lastSectors: null,
    bridgeConnected: false, TELEMETRY_STALE_MS: 10000,
    selMode: 'race', isBusy: false, turns: 0, sessionMsgCount: 0, sel: 'LunaJP',
    ...namedStubs,
  };
  const handler = {
    has() { return true; },
    get(target, key) {
      if (typeof key === 'symbol') return undefined;
      if (key in target) return target[key];
      // ★allow-list外の識別子アクセスは即座に例外を投げる（無条件pass-through廃止）。
      //   これにより「想定外の依存が呼ばれたことに気づけない」問題を塞ぐ。
      throw new ReferenceError(
        `[fixture guard] unlisted identifier "${String(key)}" was accessed. ` +
        `renderer.html now references something this fixture's allow-list doesn't know about. ` +
        `Add it to namedStubs explicitly (do not fall back to pass-through).`);
    },
    set(target, key, value) { target[key] = value; return true; },
  };
  const proxy = new Proxy(state, handler);
  vm.createContext(proxy);
  vm.runInContext(
    fnLoadRaceHistorySrc + ';' + fnValidFinishSrc + ';' + fnSanitizeSrc + ';' +
    fnCurrentMemoryUserIdSrc + ';' + fnSaveSessionSummarySrc + ';' +
    fnSessionDurationSecondsSrc + ';' + fnApplySessionFormatAuthoritySrc + ';' +
    fnMarkTelemetryStaleSrc, proxy);
  const onmessage = vm.runInContext(fnOnMessageSrc, proxy);
  const sendMsgFn = vm.runInContext(fnSendMsgSrc, proxy);

  return { state, localStorage, onmessage, sendMsgFn, speakCalls,
    markTelemetryStale: state.markTelemetryStale };
}

function sendWs(onmessage, payload) {
  onmessage({ data: JSON.stringify(payload) });
}

async function ask(sendMsgFn, document_getElementById_value, text) {
  await sendMsgFn('typed');
}

function answeredCorrectly(speakCalls) {
  return speakCalls.some(s => s.opts && s.opts.kind === 'local_previous_fuel_reference'
    && s.text.includes('26.83L'));
}

// ========================================
// シナリオ構築ヘルパー
// ========================================
function primeSpaRecord(onmessage, custId) {
  sendWs(onmessage, {
    type: 'session_info',
    data: {
      current_session_authority: { track: 'Spa-Francorchamps', car_model: 'Mercedes-AMG GT3 2020', session_num: 1, session_type: 'Race' },
      player_car_class: 'GT3',
    },
  });
  sendWs(onmessage, {
    type: 'session_summary', cust_id: custId, track: 'Spa-Francorchamps', car_class: 'GT3', car_model: 'Mercedes-AMG GT3 2020',
    pit_events: [{ entry_lap: 9, exit_lap: 10, fuel_added_l: 26.83 }], checker_fuel_l: 3.9, official_result_arrived: true, is_race: true,
  });
}

async function runScenario(srcMutator) {
  const { state, localStorage, onmessage, sendMsgFn, speakCalls } = buildHarness(srcMutator);
  primeSpaRecord(onmessage, 999999);
  sendWs(onmessage, { type: 'telemetry_live', cust_id: 999999, laps_total: 20 });
  await sendMsgFn('typed');
  return { state, localStorage, speakCalls };
}

// ★M6（切断）検証専用シナリオ：実markTelemetryStaleを呼んでから質問する。
//   baselineは切断によりidentityが失効し「拒否」が正しい結果（Test 4で確認済み）。
//
//   ★注記：sendMsgの`iracingLive`ガードが二重防御として機能するため、
//   markTelemetryStale内のcurrentSessionCustId/lastTelemetryリセットを
//   単体で消しても、iracingLive=falseのガードだけで質問自体がブロックされ、
//   リセット漏れの実害が表面化しない（実測済み）。そのため本シナリオでは
//   「切断→(Bridge再接続は検知したがtelemetryはまだ来ていない)」という
//   中間状態を模してiracingLiveを明示的に戻し、identityリセットの効果を
//   iracingLiveガードから独立して検証する。
async function runDisconnectScenario(srcMutator) {
  const { state, onmessage, sendMsgFn, speakCalls, markTelemetryStale } = buildHarness(srcMutator);
  primeSpaRecord(onmessage, 999999);
  sendWs(onmessage, { type: 'telemetry_live', cust_id: 999999, laps_total: 20 });
  state.iracingDetected = true;
  markTelemetryStale('test_disconnect');
  state.iracingLive = true;  // iracingLiveガードから独立してidentityリセットの効果を見る
  await sendMsgFn('typed');
  return { state, speakCalls };
}

// ★M5（session境界）検証専用シナリオ：SessionNum変更を跨いでから質問する。
//   単一セッションのrunScenario()では変更経路自体を通らず、M5のリセット
//   欠落を検出できないため、専用シナリオで変異検出する。
//   ★track/car_modelは同一のまま（同一コースでの耐久レース1→レース2を想定）にし、
//   track不一致による偶然の拒否でリセット欠落が隠れないようにする。
//   このシナリオが本当にcustIdリセットの効果だけを見ていることは、
//   Test 5（baseline）が「track一致・custId不明で拒否」になることで担保する。
async function runSessionBoundaryScenario(srcMutator) {
  const { state, localStorage, onmessage, sendMsgFn, speakCalls } = buildHarness(srcMutator);
  primeSpaRecord(onmessage, 999999);
  sendWs(onmessage, { type: 'telemetry_live', cust_id: 999999, laps_total: 20 });
  sendWs(onmessage, {
    type: 'session_info',
    data: {
      current_session_authority: { track: 'Spa-Francorchamps', car_model: 'Mercedes-AMG GT3 2020', session_num: 2, session_type: 'Race' },
      player_car_class: 'GT3',
    },
  });
  // 新セッションではまだ telemetry_live を一度も受けていない（=現在driver未確立のはず）
  await sendMsgFn('typed');
  return { state, localStorage, speakCalls };
}

// ========================================
// テスト実行
// ========================================
(async () => {
  console.log('\n━━ 実 onmessage → 実 sendMsg → 実 route → 実 speak の入口証明 ━━\n');

  console.log('Test 1: baseline（無変異）— 正答することを確認');
  const baseline = await runScenario(null);
  assert.strictEqual(answeredCorrectly(baseline.speakCalls), true, 'baseline は正答すべき');
  console.log('  ✓ 正答:', baseline.speakCalls[0].text);

  // ══════════════════════════════════════════════════════════════════
  console.log('\n━━ 境界ケース：次telemetry・別driver・切断・session境界 ━━\n');
  // ══════════════════════════════════════════════════════════════════

  console.log('Test 2: 次telemetry受信後も現在identityが保たれ、正答し続ける');
  {
    const { onmessage, sendMsgFn, speakCalls } = buildHarness(null);
    primeSpaRecord(onmessage, 999999);
    sendWs(onmessage, { type: 'telemetry_live', cust_id: 999999, laps_total: 20 });
    // 2フレーム目のtelemetry（周回・燃料が進んだだけ）でもidentityは維持されるべき
    sendWs(onmessage, { type: 'telemetry_live', cust_id: 999999, laps_total: 21 });
    await sendMsgFn('typed');
    assert.strictEqual(answeredCorrectly(speakCalls), true, '次telemetry受信後も正答すべき');
    console.log('  ✓ 次telemetry後も正答:', speakCalls[speakCalls.length - 1].text);
  }

  console.log('\nTest 3: 別driver（現在セッションが別人）は本人不明として拒否する');
  {
    const { onmessage, sendMsgFn, speakCalls } = buildHarness(null);
    primeSpaRecord(onmessage, 999999);            // 記録は999999のもの
    sendWs(onmessage, { type: 'telemetry_live', cust_id: 555555, laps_total: 20 });  // 現在driverは別人
    await sendMsgFn('typed');
    const unavailable = speakCalls.some(s => s.opts && s.opts.kind === 'local_previous_fuel_unavailable');
    assert.strictEqual(unavailable, true, '別driverなら unavailable を返すべき');
    assert.strictEqual(answeredCorrectly(speakCalls), false, '別driverの記録を正答として答えてはいけない');
    console.log('  ✓ 別driver拒否:', speakCalls[speakCalls.length - 1].text);
  }

  console.log('\nTest 4: 実markTelemetryStaleを呼んだ切断後は本人identityが失効し、再質問しても不正答');
  {
    const { state, onmessage, sendMsgFn, speakCalls, markTelemetryStale } = buildHarness(null);
    primeSpaRecord(onmessage, 999999);
    sendWs(onmessage, { type: 'telemetry_live', cust_id: 999999, laps_total: 20 });
    assert.strictEqual(state.currentSessionCustId, 999999, '切断前は現在identityが確立しているべき');
    // ★Codex差戻し（残件2）：試験側からstate.currentSessionCustId/lastTelemetryを直接null化
    //   していたのをやめ、実 markTelemetryStale() を呼ぶ。markTelemetryStaleのガード条件
    //   （iracingDetected必須・telemetryStaleNotified二重発火防止）も本物のまま通す。
    state.iracingDetected = true;  // 実装のガード条件を満たす（iracing_connectedイベント相当）
    markTelemetryStale('test_disconnect');
    assert.strictEqual(state.currentSessionCustId, null, '実markTelemetryStaleがcurrentSessionCustIdをリセットするべき');
    assert.strictEqual(state.lastTelemetry, null, '実markTelemetryStaleがlastTelemetryをクリアするべき');
    await sendMsgFn('typed');
    assert.strictEqual(answeredCorrectly(speakCalls), false, '切断後のidentity失効状態では正答してはいけない');
    console.log('  ✓ 実markTelemetryStale経由で切断後は不正答（identity失効を確認）:',
      speakCalls.length ? speakCalls[speakCalls.length - 1].text : '(speak未呼出=iracingLive条件で素通り)');
  }

  console.log('\nTest 5: session境界（SessionNum変更）で古いsummaryのcust_idが新セッションへ持ち越されない');
  console.log('        （同一track・同一車種の耐久レース1→レース2を想定。track不一致の偶然拒否で');
  console.log('         custIdリセットの効果が隠れないよう、trackは変えずSessionNumだけ変える）');
  {
    const result = await runSessionBoundaryScenario(null);
    assert.strictEqual(result.state.currentSessionCustId, null,
      'SessionNum変更でcurrentSessionCustIdがリセットされるべき（旧セッションのIDを持ち越さない）');
    assert.strictEqual(answeredCorrectly(result.speakCalls), false,
      'session境界を跨いだ直後、新telemetry未受信のまま前回記録に正答してはいけない（track一致でもcustId不明で拒否されるべき）');
    console.log('  ✓ session境界でidentity失効・不正答を確認:',
      result.speakCalls.length ? result.speakCalls[result.speakCalls.length - 1].text : '(no speak)');
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n━━ Mutation testing：配線が壊れたら fixture が検出できるか ━━\n');
  // ══════════════════════════════════════════════════════════════════

  const mutations = [
    ['M1: telemetry_live受信時にlastTelemetryからcust_idが剥がれる', runScenario,
      s => s.replace(
        'lastTelemetry=applySessionFormatAuthority(data);',
        'lastTelemetry=Object.assign({},applySessionFormatAuthority(data)); delete lastTelemetry.cust_id;')],
    ['M2: cust_id保持直後にlastTelemetryがnullへ潰される', runScenario,
      s => s.replace(
        "if(data&&typeof data.cust_id==='number'){\n          currentSessionCustId=data.cust_id;\n        }",
        "if(data&&typeof data.cust_id==='number'){\n          currentSessionCustId=data.cust_id;\n        }\n        lastTelemetry=null;")],
    ['M3: 同一参照のdataからcust_idがdeleteされる', runScenario,
      s => s.replace(
        'lastTelemetry=applySessionFormatAuthority(data);',
        'lastTelemetry=applySessionFormatAuthority(data); delete data.cust_id; delete lastTelemetry.cust_id;')],
    ['M4: sendMsgのlive構築でtrackが渡らなくなる（本セッション新規発見バグの回帰確認）', runScenario,
      s => s.replace('track:lastTelemetry.track||lastTrack||null,', 'track:null,')],
    // ★M5a/M5b：baseline（無変異）は runSessionBoundaryScenario で「不正答（拒否）」が
    //   正しい結果（Test 5で確認済み）。この2つの変異は逆方向＝「変異によって誤って
    //   "正答"してしまえば配線破壊の検出成功」というシナリオのため、expectRejectBaseline:true
    //   を付け、判定方向を反転させる。
    ['M5a: SessionNum変更でcurrentSessionCustId/lastTelemetryのリセットが両方とも消える（session境界専用シナリオで検証）', runSessionBoundaryScenario,
      s => s.replace('currentSessionCustId=null;\n            lastTelemetry=null;\n          }', '}'), true],
    ['M5b: SessionNum変更でlastTelemetryだけリセットされなくなる（currentSessionCustIdは残る＝本当の根本原因の回帰確認）', runSessionBoundaryScenario,
      s => s.replace('currentSessionCustId=null;\n            lastTelemetry=null;\n          }', 'currentSessionCustId=null;\n          }'), true],
    // ★M6：実markTelemetryStale自体からlastTelemetry/currentSessionCustIdのリセットが
    //   消える変異。Test 4が実関数を呼んでいることの証明（試験側の直接代入なら
    //   この変異は何にも影響しないはず）。
    ['M6: 実markTelemetryStaleからcurrentSessionCustId/lastTelemetryのリセットが消える', runDisconnectScenario,
      s => s.replace(
        "  iracingLive=false;usageIracingLive=false;lastTelemetry=null;lastSectors=null;\n  // ★P0-3修正：切断時に currentSessionCustId をリセット（古い ID の残留防止）\n  currentSessionCustId=null;\n",
        "  iracingLive=false;usageIracingLive=false;\n"), true],
  ];

  let allDetected = true;
  for (const [label, scenarioFn, mutator, expectRejectBaseline] of mutations) {
    let detected;
    let detail;
    try {
      const result = await scenarioFn(mutator);
      const ok = answeredCorrectly(result.speakCalls);
      if (expectRejectBaseline) {
        // baselineは「拒否」が正しい。変異で「正答」してしまえば検出成功。
        detected = ok === true;
        detail = ok ? '変異により誤って正答してしまった（＝配線破壊を検出）' : '変異後も正しく拒否のまま（未検出）';
      } else {
        // baselineは「正答」が正しい。変異で「不正答／例外」になれば検出成功。
        detected = !ok;
        detail = ok ? '変異後も正答してしまった（未検出）' : `変異後は不正答（${result.speakCalls[0] ? result.speakCalls[0].text : 'no speak'}）`;
      }
    } catch (e) {
      // M5系は「例外」ではなく「誤って正答する」ことを検出条件としているため、
      // 例外は検出失敗として扱う（想定シナリオと異なる壊れ方をしている）。
      detected = !expectRejectBaseline;
      detail = `例外: ${e.message}`;
    }
    console.log(`${label}\n  → ${detected ? '✓ DETECTED' : '✗ NOT DETECTED（fixtureの穴）'}: ${detail}`);
    if (!detected) allDetected = false;
  }

  if (!allDetected) {
    console.log('\n✗ 一部の変異が検出されなかった。fixture に穴が残っている。');
    process.exit(1);
  }
  console.log('\n✓ All mutations detected — fixture は配線破壊を検出できることを実証\n');
  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
