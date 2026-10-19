#!/usr/bin/env node
'use strict';
// WO014 round3 priority 3: "actual Server SDKstub capture -> actualRenderer
// 主/auto縦断常設（fetchmock返事だけ禁止）".
//
// tests-race-context-builder.js's "actual X caller" tests already prove the
// Renderer side (real extracted callAPI/checkPaceJudgment/runJudgeCall/
// scheduleAutoBriefing/deliverOperationalFollowUp -> real fetch call ->
// real stale-binding fence), but every one of those fetches is answered by
// a HAND-WRITTEN mock response body -- the round3 parent judgment was
// explicit that this does NOT prove the real server.js (validate ->
// canonicalizeLiveData -> buildSystem -> prompts.js) ever actually ran on
// that request, nor that the FINAL text handed to the (stubbed) Anthropic
// SDK excludes the modern-alias poison this WO exists to close.
//
// This file closes that gap for the 主 (callAPI/sendMessage) and one 自動
// (judgeCall) current-race caller: spawn the REAL server.js as a child
// process with ONLY the Anthropic SDK replaced (tests-wo001-anthropic-
// stream-stub-preload.js, same technique as irsdk-bridge/
// wo013_judge_bridge_fixture.js and tests-chat-http.js), point the
// Renderer's `fetch` at that real child's real HTTP port (not a mock), and
// read back what the stub actually captured as `req.system` -- the exact
// text server.js's real buildSystem() sent.
'use strict';
const fs = require('fs');
const WO017Scope = require('./tests-wo017-memory-scope-harness');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { spawn } = require('child_process');
const ROOT = __dirname;
const CanonicalCache = require('./desktop/canonical-lifecycle-cache');
const StrategyProjection = require('./desktop/strategy-state-projection');
const RaceContextBuilder = require('./desktop/race-context-builder');
const { fixture: canonicalFixture } = require('./tests-canonical-lifecycle');
const stub = require('./tests-wo001-anthropic-stream-stub-preload.js');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : (detail ? '  -> ' + JSON.stringify(detail) : '')));
  ok ? pass++ : fail++;
}

const renderer = fs.readFileSync(path.join(ROOT, 'desktop/renderer.html'), 'utf8');
const scripts = [...renderer.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.reduce((a, b) => (a.length > b.length ? a : b));
function grabFn(name, isAsync) {
  const kw = isAsync ? 'async function ' : 'function ';
  const i = src.indexOf(kw + name + '(');
  if (i < 0) return null;
  const rest = src.slice(i);
  const end = rest.search(/\n\}\n/);
  return end < 0 ? null : rest.slice(0, end + 3);
}

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-actual-vertical-'));
const CAPTURE_FILE = path.join(TEMP, 'system-capture.jsonl');
fs.writeFileSync(CAPTURE_FILE, '');

function readCapturedSystems() {
  return fs.readFileSync(CAPTURE_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function spawnServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      ['-r', path.join(ROOT, 'tests-wo001-anthropic-stream-stub-preload.js'), path.join(ROOT, 'server.js')],
      { cwd: ROOT, env: { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: 'sk-test-local-stub',
        DATABASE_URL: '', JWT_SECRET: '', STRIPE_SECRET_KEY: '', WO014_SYSTEM_CAPTURE_FILE: CAPTURE_FILE } });
    const timer = setTimeout(() => reject(new Error('actual server did not start in time')), 15000);
    child.stdout.on('data', d => { if (d.toString().includes('is running')) { clearTimeout(timer); resolve(child); } });
    child.stderr.on('data', () => {});
    child.on('exit', code => { clearTimeout(timer); reject(new Error('actual server exited early: code=' + code)); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + file);
    await sleep(10);
  }
}

// ── real canonical plumbing: one fresh, self-consistent scenario reused by
//    every sub-case below ───────────────────────────────────────────────
function buildScenario() {
  const snap = canonicalFixture({ frame: 10, decision: 'd-active', lap: 20 });
  snap.continuity.stable_scope = { race_instance_id: snap.race_instance_id, session_num: snap.session_num, driver_id: 7 };
  const cache = CanonicalCache.create({ now: () => 0 });
  const g = cache.beginSocket();
  cache.hello(g, { type: 'connected', schema_version: 1, bridge_process_epoch: snap.bridge_process_epoch });
  if (!cache.receive(snap, g)) throw new Error('fixture rejected');
  const projection = StrategyProjection.create({ canonical: cache, now: () => 0 });
  const auxSourceRef = { bridge_process_epoch: snap.bridge_process_epoch, canonical_snapshot_id: snap.snapshot_id,
    canonical_snapshot_sequence: snap.snapshot_sequence, race_instance_id: snap.race_instance_id,
    session_num: snap.session_num, source_frame_sequence: snap.source_frame.sequence };
  const auxRaw = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
  const realCtx = RaceContextBuilder.build({ projectionView: projection.current(), snapshot: cache.current(),
    // ★実server.jsはraceContextBuilder.validate(ctx, Date.now())で現実の
    //   壁時計時刻と照合する（CONTEXT_DEADLINE_MS=20秒）。固定fake clockで
    //   generated_atを作ると、実サーバー側では常に「20秒以上古い」扱いで
    //   REJECTされる——このvertical fixtureでは本物のDate.now()を使う。
    evaluation: projection.strategyEvaluation(), auxSourceRef, auxRaw, now: () => Date.now() });
  return { snap, cache, g, projection, realCtx };
}

const POISON = { fuel: 777.25, lap: 888, pos: 8765, class_pos: 7654, standings_gaps: { 3: 9999.9 },
  leaders: { overall: { name: 'PoisonLeader', car_number: '666' }, player_class: { name: 'PoisonClass', car_number: '667', gap_s: 999 } },
  fuel_strategy: { avg_fuel_per_lap: 13.37, required_fuel_l: 999.9, margin_l: -999.9, estimated_crossings_to_finish: 3 } };
const POISON_TOKENS = ['777.25', '888', '8765', '7654', '9999.9', 'PoisonLeader', '666', 'PoisonClass', '667', '13.37', '999.9'];

// ── main caller (callAPI) harness: real extraction, real fetch to the real
//    server port, real SDK-stub capture ───────────────────────────────────
// WO014 round5 (共有log「核心実builder主auto縦断」残条件): the prior harness
// stubbed currentCanonicalStrategyLive as a bare identity shim and
// buildCurrentRaceContext as a fixed `() => realCtx` closure -- neither the
// real Renderer function ever ran. Both are now extracted via grabFn like
// callAPI itself and wired to the REAL global names the real
// buildCurrentRaceContext() body reads (desktop/renderer.html
// canonicalLifecycleCache/strategyProjection/lastTelemetryAuxRef/
// lastTelemetry/globalThis.PitwallRaceContextBuilder) -- only
// UI/profile/audio helpers stay neutral stubs, never the builder/caller/
// fence under test.
function makeCallApiContext(cache, port, extraLiveData) {
  const box = require('./desktop/conversation-memory-box.js');
  const det = require('./desktop/dispute-detector.js');
  const callApiSrc = grabFn('callAPI', true);
  const liveSrc = grabFn('currentCanonicalStrategyLive', false);
  const buildCtxSrc = grabFn('buildCurrentRaceContext', false);
  const memSrc = ['recordLunaTurn', 'ensureConversationBox', 'saveConversationBox',
    'conversationSessionKey', 'addMsg', 'convoLog'].map(n => grabFn(n, false));
  const judgeTagSrc = grabFn('stripProposalJudgeTag', false);
  const planDependsSrc = grabFn('currentPlanReplyDependsOn', false);
  // ★WO015：callAPI()の_replyBindingForはstrategyNumericFactBinding()を呼ぶ
  //   （本文が燃料/周回の具体的数値を主張する時だけ既存'facts'binding追加AND）。
  //   callAPIだけをgrabFnで抽出するこのharnessにも実関数を注入する必要がある
  //   （未定義のまま呼ぶとReferenceErrorがcatchへ落ち、偽の接続エラー応答に
  //   化ける）。
  // ★WO015残条件「verifiedaux GAP/position」：callAPI()は送信前に
  //   captureVerifiedAuxBinding(buildCurrentRaceContext())を無条件に
  //   capture/callし、本文がGAP/position数値を主張するgroupだけ
  //   strategyReplyBindingValid()で追加fail-closedする。strategyNumericFact
  //   Binding自身も共有の_hasUnqualifiedCurrentNumericMention()文分類器を
  //   呼ぶ（その関数より前に定義）。これらは全て
  //   _hasUnqualifiedCurrentNumericMentionからcallAPI定義の直前まで連続して
  //   いるので、grabFnの単一\n}\n境界ではなくブロック全体を一括sliceする
  //   （一部は1行関数でgrabFnの境界に合わない）。
  const auxBlockStart = src.indexOf('function _hasUnqualifiedCurrentNumericMention(text,keywordRe){');
  const auxBlockEnd = src.indexOf('\nasync function callAPI', auxBlockStart);
  const auxBlockSrc = (auxBlockStart >= 0 && auxBlockEnd > auxBlockStart) ? src.slice(auxBlockStart, auxBlockEnd) : null;
  if (!callApiSrc || !liveSrc || !buildCtxSrc || !memSrc.every(Boolean) || !judgeTagSrc || !planDependsSrc || !auxBlockSrc) {
    throw new Error('extraction failed: ' + JSON.stringify({ callApiSrc: !!callApiSrc, liveSrc: !!liveSrc, buildCtxSrc: !!buildCtxSrc, memSrc: memSrc.map(Boolean), judgeTagSrc: !!judgeTagSrc, planDependsSrc: !!planDependsSrc, auxBlockSrc: !!auxBlockSrc }));
  }
  const judgeConstDecl = (src.match(/const PW_JUDGE_TAG_START = [\s\S]*?;/) || [''])[0]
    + '\n' + (src.match(/const PW_JUDGE_TAG_RE = [\s\S]*?;/) || [''])[0];
  const decls = (src.match(/const CONVO_BOX_KEY='[^']+';/) || [''])[0]
    + '\n' + (src.match(/let _convoBox=null;/) || [''])[0];
  const store = {};
  const spoken = [];
  const ctx = {
    fetch: (url, init) => fetch('http://localhost:' + port + url, init),
    TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout,
    Date, JSON, Math, String, Number, Error, RegExp, Promise, console,
    window: { PitwallConversationMemoryBox: box, PitwallDisputeDetector: det, PitwallReflexEvents: null },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { getElementById: () => ({ value: '', style: {}, appendChild(){}, scrollTop:0, scrollHeight:0, classList:{add(){},remove(){},toggle(){}} }),
      createElement: () => ({ className: '', textContent: '' }) },
    usageCount(){}, applyPitwallAccess(){}, costApiCall(){}, costRecord(){},
    diagnosticLog(){}, mirrorToOverlay(){}, flushSentences(){}, t: (k) => String(k),
    forwardDriverDamageReport(){}, hydrateLegacyStrategyObjective: () => ({}),
    loadProfile: () => ({}), buildProfileNote: () => '', buildCarTrackMemory: () => '',
    buildPracticeProfileNote: () => '', buildFuelAuthorityNote: () => '',
    buildWeekendAuthorityNote: () => '', buildCurrentSessionFactNote: () => '',
    buildSessionEvidenceNote: () => '', buildContractNote: () => '',
    buildActiveRaceFactsNote: () => '', buildMemoryStatusNote: () => '',
    currentMemoryBrainPrompt: () => '', completeMemoryBrainTurn: () => null,
    buildRaceHistoryContext: () => '', buildNamedRivalNote: () => '',
    hasTelemetryOwnedVehicleClaim: () => false, normalizeLunaSpeech: (t) => t,
    speak: (t) => { spoken.push(t); }, applyProposalJudgeTag: () => {},
    currentStrategyStateAPI: () => null,
    // The REAL globals currentCanonicalStrategyLive()/buildCurrentRaceContext()
    // (injected below via vm.runInContext, not stubbed) read directly.
    canonicalLifecycleCache: cache,
    strategyProjection: null,   // set by caller after construction
    lastTelemetryAuxRef: null,
    PitwallRaceContextBuilder: RaceContextBuilder,
    lastQueuedSpeakItem: null, _msgSeq: 0,
    pushMsg(m){ if(m && typeof m==='object' && !m._mid){ Object.defineProperty(m,'_mid',{value:'m'+(++ctx._msgSeq),enumerable:false,writable:true,configurable:true}); } ctx.messages.push(m); return m && m._mid ? m._mid : null; },
    sel: 'LunaJP', selMode: 'race', userName: 'Yuji', messages: [],
    turns: 0, sessionMsgCount: 0, isBusy: false,
    iracingLive: true, bridgeConnected: true, lastTelemetry: Object.assign({}, POISON, extraLiveData || {}), lastTelemetryAt: Date.now(),
    lastSessionType: 'Race', lastSessionAuthority: null, lastCarClass: 'GT3',
    lastCarModel: 'AMG', lastTrack: 'Le Mans', lastSessionNum: 9,
    driverState: 'track', driverActivity: 'ACTIVE',
    API_BASE: '', usageBuild: 'test', usageSessionId: 's',
    currentMemoryUserId: () => 'Yuji', memorySavedThisSession: true, evidenceDebrief: null,
    responseIntent: null, responseAuthority: 'llm',
    SPEAK_PRIO: { P0_SAFETY: 0, P1_URGENT: 1, P2_PROCEDURE: 2, P3_INFO: 3, P4_INFO: 4 },
    jamesAutoMicEnabled: undefined, updateNamedRivalFromUser: () => null, lastSectors: () => null,
    speakReplyChunk: t => { spoken.push(t); },
  };
  ctx.globalThis = ctx; ctx.window.localStorage = ctx.localStorage;
  WO017Scope.install(ctx); vm.createContext(ctx);
  vm.runInContext(decls + '\n' + judgeConstDecl + '\n' + judgeTagSrc + '\n' + planDependsSrc + '\n' + auxBlockSrc + '\n' + liveSrc + '\n' + buildCtxSrc + '\n' + WO017Scope.source(src) + memSrc.join('\n') + '\n' + callApiSrc
    + '\nthis.callAPI = callAPI;', ctx);
  return { ctx, spoken };
}

// ── scheduleAutoBriefing (自動 representative) harness: real extraction,
//    real fetch to the real server port, real SDK-stub capture -- mirrors
//    makeCallApiContext above but for the auto/proactive caller. Neutral
//    UI/self-memory/decision-memory/profile helpers are stubbed (authorized
//    scope: not the caller, builder, or fence under test). setTimeout is
//    overridden to fire immediately -- timer plumbing only, not the fence
//    logic itself, which runs unmodified.
function makeBriefingContext(cache, port, projection) {
  const src = (renderer.match(/async function scheduleAutoBriefing\(\)\{[\s\S]*?\n\}/) || [null])[0];
  if (!src) throw new Error('scheduleAutoBriefing extraction failed');
  const liveSrc = grabFn('currentCanonicalStrategyLive', false);
  const buildCtxSrc = grabFn('buildCurrentRaceContext', false);
  // ★WO015：scheduleAutoBriefing内のbriefingFinalBindingもstrategyNumeric
  //   FactBinding()とstrategyReplyBindingValid()を呼ぶ（makeCallApiContext
  //   と同じ理由）。両方＋依存する_hasUnqualifiedCurrentNumericMention/
  //   captureVerifiedAuxBinding/verifiedAuxFieldsStillFreshは連続blockで一括
  //   sliceする。
  const auxBlockStart = renderer.indexOf('function _hasUnqualifiedCurrentNumericMention(text,keywordRe){');
  const auxBlockEnd = renderer.indexOf('\nasync function callAPI', auxBlockStart);
  const auxBlockSrc = (auxBlockStart >= 0 && auxBlockEnd > auxBlockStart) ? renderer.slice(auxBlockStart, auxBlockEnd) : null;
  if (!liveSrc || !buildCtxSrc || !auxBlockSrc) throw new Error('currentCanonicalStrategyLive/buildCurrentRaceContext/aux extraction failed');
  const spoken = [];
  const ctx = {
    selMode: 'strategy', sel: 'LunaJP', userName: 'Yuji', iracingLive: true, bridgeConnected: true,
    lastTelemetry: {}, lastSessionType: 'Race', lastSessionAuthority: null,
    driverState: 'track', driverActivity: 'driving', lastCarClass: 'GT3', lastCarModel: 'AMG', usageSessionId: 'u1',
    localStorage: { getItem: () => null }, applyPitwallAccess: () => {}, usageCount: () => {},
    diagnosticLog: () => {}, addMsg: () => {}, pushMsg: () => null,
    speak: (text) => { spoken.push(text); },
    SPEAK_PRIO: { P2_PROCEDURE: 2, P3_STRATEGY: 3 }, AbortController, API_BASE: '',
    // setTimeout is overridden to fire the OUTER 6s kickoff delay
    // immediately -- timer plumbing only, not the caller/fence logic under
    // test. The inner async callback's promise is captured so the test can
    // await actual completion of the real fetch round-trip (scheduleAuto
    // Briefing itself does not await its own setTimeout callback). The
    // SAME function also sets the real 30s fetch-abort timer -- that one
    // must stay a REAL timer, not fire immediately (which would abort the
    // real in-flight request before it ever completes).
    setTimeout: (fn, delay) => {
      if (delay === 6000) { ctx._briefingDone = fn(); return 0; }
      return global.setTimeout(fn, delay);
    },
    clearTimeout: (id) => global.clearTimeout(id),
    // The REAL globals currentCanonicalStrategyLive()/buildCurrentRaceContext()
    // (injected below via vm.runInContext, not stubbed) read directly.
    canonicalLifecycleCache: cache,
    lastTelemetryAuxRef: null,
    PitwallRaceContextBuilder: RaceContextBuilder,
    strategyProjection: projection,
    loadProfile: () => ({}), buildPreviousRaceBriefingNote: () => '',
    currentMemoryIdentity: () => ({}), loadRaceHistory: () => [], noteMemoryUtterance: () => {},
    pullDecisionsFromServer: async () => {}, decisionBriefingSelection: () => ({ available: false }),
    decisionPlanAdvice: () => ({ action: 'none', fate: 'skip', reply: null }),
    setupComparisonForBriefing: () => ({ available: false }), driverAddressName: () => 'Driver',
    buildProfileNote: () => '', buildCarTrackMemory: () => '', buildFuelAuthorityNote: () => '',
    buildWeekendAuthorityNote: () => '', buildContractNote: () => '', buildActiveRaceFactsNote: () => '',
    buildRaceHistoryContext: () => '',
    fetch: (url, init) => fetch('http://localhost:' + port + url, init),
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  WO017Scope.install(ctx); vm.createContext(ctx);
  vm.runInContext(liveSrc + '\n' + buildCtxSrc + '\n' + auxBlockSrc + '\n' + src + '\nthis.scheduleAutoBriefing = scheduleAutoBriefing;', ctx);
  return { ctx, spoken };
}

async function main() {
  const port = 34300 + Math.floor(Math.random() * 500);
  const server = await spawnServer(port);
  try {
    // ── Case 1: valid/normal modern context -- real canonical values must
    //    reach the actual server's final prompt; all poisoned raw liveData
    //    must not ─────────────────────────────────────────────────────────
    {
      const { cache, g, projection } = buildScenario();
      const { ctx, spoken } = makeCallApiContext(cache, port, {});
      ctx.strategyProjection = projection;
      ctx.messages = [{ role: 'user', content: '今の状況を教えて ' + stub.MARKER
        + Buffer.from(JSON.stringify({ chunks: ['了解した。'] })).toString('base64') }];
      await ctx.callAPI('typed');
      const captured = readCapturedSystems();
      const last = captured[captured.length - 1];
      check('case1 (valid context): actual Server captured a system prompt', !!last && typeof last.system === 'string');
      for (const token of POISON_TOKENS) {
        check('case1: actual Server final prompt excludes poison ' + token, !last.system.includes(token));
      }
      check('case1: actual Server final prompt carries the REAL canonical lap (周回 20)', last.system.includes('周回 20'));
      check('case1: actual Server final prompt carries the REAL canonical fuel (燃料 5L)', last.system.includes('燃料 5L'));
      // real value, not a fixed `true` -- the actual Renderer speech queue
      // must have actually received the actual Server's streamed reply text.
      check('case1: actual Renderer spoke the real (non-poisoned) reply', spoken.length > 0, spoken);
      check('case1: actual Renderer spoke the ACTUAL scripted reply text (round-trip proof, not assumed)',
        spoken.some(s => s.includes('了解した')), spoken);
      void g;
    }

    // ── Case 2: modern caller, canonical GENUINELY unavailable (never once
    //    usable -- WO014 round5: the prior forced-null realCtx argument on
    //    top of a VALID projection is retracted now that buildCurrentRace
    //    Context() is the real function; a fresh/never-connected cache is
    //    the real way to reach an unavailable raceContext) -- same poison
    //    must still be excluded, AND the prompt must say unavailable/
    //    unknown rather than silently showing nothing ───────────────────
    {
      const freshCache = CanonicalCache.create({ now: () => Date.now() });
      const freshProjection = StrategyProjection.create({ canonical: freshCache, now: () => Date.now() });
      const { ctx, spoken } = makeCallApiContext(freshCache, port, {});
      ctx.strategyProjection = freshProjection;
      ctx.messages = [{ role: 'user', content: '今の状況を教えて ' + stub.MARKER
        + Buffer.from(JSON.stringify({ chunks: ['現在のPlanは確認できない。'] })).toString('base64') }];
      await ctx.callAPI('typed');
      const captured = readCapturedSystems();
      const last = captured[captured.length - 1];
      check('case2 (raceContext:null, modern): actual Server captured a system prompt', !!last && typeof last.system === 'string');
      for (const token of POISON_TOKENS) {
        check('case2: actual Server final prompt excludes poison ' + token, !last.system.includes(token));
      }
      check('case2: actual Server final prompt states unavailable/unknown (no silent current-authority leak)',
        /unavailable|unknown/i.test(last.system));
      // real value, not assumed -- the actual Renderer must have actually
      // spoken this honest "cannot confirm" reply (round4: an unknown/
      // unavailable reply is NOT inherently something to silently suppress).
      check('case2: actual Renderer spoke the real unknown-state reply',
        spoken.some(s => s.includes('確認できない')), spoken);
    }

    // ── Case 2b (round4, audit-corrected): scheduleAutoBriefing (the auto
    //    representative) with canonical GENUINELY unavailable (never once
    //    usable, not merely a forced-null raceContext argument on top of a
    //    valid projection as in case2) -- the fixed stale_briefing_discarded
    //    fence (desktop/renderer.html ~line 6005) must SPEAK this honest
    //    initial-unknown reply, not discard it unconditionally the way the
    //    pre-round4 code's retracted "briefingBinding.unavailable" branch
    //    did. Then, STAYING unavailable but under a DIFFERENT scope
    //    (captured_scope mismatch, strategy-state-projection.js round4),
    //    the SAME still-pending reply must be discarded. ──────────────────
    {
      const cache = CanonicalCache.create({ now: () => Date.now() });
      const projection = StrategyProjection.create({ canonical: cache, now: () => Date.now() });
      const { ctx, spoken } = makeBriefingContext(cache, port, projection);
      // scheduleAutoBriefing() builds its OWN fixed internal message text
      // (never reads ctx.messages) -- but it interpolates
      // buildPreviousRaceBriefingNote()'s return value directly into that
      // message, so the scenario marker travels through there instead.
      ctx.buildPreviousRaceBriefingNote = () => stub.MARKER
        + Buffer.from(JSON.stringify({ chunks: ['現在のセッション情報はまだ確認できていない。'] })).toString('base64');
      await ctx.scheduleAutoBriefing();
      await ctx._briefingDone;
      check('case2b GREEN: scheduleAutoBriefing SPEAKS a genuine initial-unknown reply (same identity, never discarded)',
        spoken.some(s => s.includes('まだ確認できていない')), spoken);
    }
    {
      // RED: canonical.current() stays null THE WHOLE TIME (never once
      // usable, both before and after) -- but a genuine reconnect attempt
      // (cache.beginSocket(), the SAME real primitive a real WebSocket
      // reconnect drives) happens strictly between the request being sent
      // and the real HTTP response completing (holdGateDir, same real-
      // network-hold technique as case4/case5). connectionGeneration()
      // (round4-added) must make this detectable even though current()
      // itself never changes.
      const cache = CanonicalCache.create({ now: () => Date.now() });
      const projection = StrategyProjection.create({ canonical: cache, now: () => Date.now() });
      const { ctx, spoken } = makeBriefingContext(cache, port, projection);
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-briefing-'));
      ctx.buildPreviousRaceBriefingNote = () => stub.MARKER
        + Buffer.from(JSON.stringify({ chunks: ['現在のセッション情報はまだ確認できていない。'], holdGateDir: gateDir, holdAfterChunk: null })).toString('base64');
      await ctx.scheduleAutoBriefing();
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      cache.beginSocket();   // a genuine reconnect attempt -- current() is STILL null throughout
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await ctx._briefingDone;
      check('case2b RED: scheduleAutoBriefing DISCARDS a still-unknown reply once a genuine reconnect happened underneath it',
        spoken.length === 0, spoken);
    }

    // ── Case 3 (auto代表): judgeCall battle kind. Poisoned gap/car_number
    //    must not reach the actual Server's final prompt; the verified
    //    aux gap_behind (1.2s, from buildScenario's auxRaw) must. ─────────
    {
      const { cache, projection } = buildScenario();
      const banned = (src.match(/const JUDGE_BANNED = [\s\S]*?;/) || [''])[0];
      const extractSrc = (src.match(/function extractJudgeSpeech\(reply, kind\)\{[\s\S]*?\n\}/) || [null])[0];
      const judgeSrc = (src.match(/async function runJudgeCall\(data\)\{[\s\S]*?\n\}/) || [null])[0];
      const liveSrc = grabFn('currentCanonicalStrategyLive', false);
      const buildCtxSrc = grabFn('buildCurrentRaceContext', false);
      // ★WO015残条件「verifiedaux GAP/position」：runJudgeCall()も他4callerと
      //   同じくstrategyNumericFactBinding()/strategyReplyBindingValid()を
      //   request前capture→precheck再評価で呼ぶ。両方＋依存する
      //   _hasUnqualifiedCurrentNumericMention/captureVerifiedAuxBinding/
      //   verifiedAuxFieldsStillFreshは連続blockで一括sliceする。
      const judgeAuxBlockStart = src.indexOf('function _hasUnqualifiedCurrentNumericMention(text,keywordRe){');
      const judgeAuxBlockEnd = src.indexOf('\nasync function callAPI', judgeAuxBlockStart);
      const judgeAuxBlockSrc = (judgeAuxBlockStart >= 0 && judgeAuxBlockEnd > judgeAuxBlockStart) ? src.slice(judgeAuxBlockStart, judgeAuxBlockEnd) : null;
      check('case3: actual runJudgeCall()/extractJudgeSpeech()/currentCanonicalStrategyLive/buildCurrentRaceContext/aux extracted',
        !!banned && !!extractSrc && !!judgeSrc && !!liveSrc && !!buildCtxSrc && !!judgeAuxBlockSrc);
      const ctx = {
        selMode: 'race', sel: 'James', userName: 'Yuji', iracingLive: true, bridgeConnected: true,
        lastTelemetry: {}, lastSessionType: 'Race', lastSessionAuthority: null,
        driverState: 'track', driverActivity: 'driving', lastCarClass: 'GT3', usageSessionId: 'u1',
        finalLapNoticeSeen: false, recentCallSummary: () => [], pushRecentCall: () => {},
        localStorage: { getItem: () => null }, applyPitwallAccess: () => {}, usageCount: () => {},
        diagnosticLog: () => {}, addMsg: () => {}, speak: () => {},
        SPEAK_PRIO: { P1_HAZARD: 1, P3_STRATEGY: 3, P4_INFO: 4 }, AbortController, setTimeout, clearTimeout, console,
        API_BASE: 'http://localhost:' + port,
        // The REAL globals currentCanonicalStrategyLive()/buildCurrentRaceContext()
        // (injected below via vm.runInContext, not stubbed) read directly.
        canonicalLifecycleCache: cache, strategyProjection: projection,
        lastTelemetryAuxRef: null, PitwallRaceContextBuilder: RaceContextBuilder,
        fetch: (url, init) => fetch(url, init),
      };
      ctx.globalThis = ctx;
      WO017Scope.install(ctx); vm.createContext(ctx);
      vm.runInContext(liveSrc + '\n' + buildCtxSrc + '\n' + judgeAuxBlockSrc + '\n' + banned + '\n' + extractSrc + '\n' + judgeSrc, ctx);
      // runJudgeCall()'s own message content is a FIXED internal-event
      // string (never driver text, never carries our scenario marker), so
      // the Anthropic stub has no scripted chunk and throws its simulated
      // 401 -- that is fine: captureSystemIfRequested() runs unconditionally
      // at the top of the stub's create(), BEFORE the marker/401 check, so
      // the real server-side system prompt is still captured either way.
      await ctx.runJudgeCall({ kind: 'battle', gap: 9999.99, car_number: '666poison', faster: true, repeat: false, recent: [] });
      const captured = readCapturedSystems();
      const last = captured[captured.length - 1];
      if (last) {
        check('case3: actual Server final prompt excludes poisoned judgeCall gap 9999.99', !last.system.includes('9999.99'));
        check('case3: actual Server final prompt excludes poisoned judgeCall car_number 666poison', !last.system.includes('666poison'));
      } else {
        check('case3: actual Server captured a system prompt for the judgeCall request', false, 'no capture (request likely hit a deterministic guard before buildSystem)');
      }
    }

    // ── Case 4: mid-flight critical change via REAL network hold -- not a
    //    simulated-inside-a-mock-fetch mutation, but a genuine pause in the
    //    real server's real HTTP stream (holdGateDir), proving the
    //    discard survives actual async/network timing, then a guard-removal
    //    mutation RED/control GREEN on the SAME real path. ────────────────
    {
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-'));
      const { ctx, spoken } = makeCallApiContext(cache, port, {});
      ctx.strategyProjection = projection;
      // Split the reply so the sentence-terminal punctuation ("。") is in a
      // SECOND chunk, held back until AFTER the mutation+release below. The
      // first chunk ("了解、") has no sentence terminator, so flushSentences
      // never speaks it -- only the second chunk (processed under the
      // MUTATED state) ever completes and reaches the mid-loop fence check.
      const scenario = Buffer.from(JSON.stringify({ chunks: ['了解、', '継続する。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '状況教えて ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      // Genuinely mutate the SAME canonical cache the request's raceContext
      // was built from -- a critical Plan revision change, strictly AFTER
      // the request was sent (and the actual Server already streamed its
      // first, sentence-incomplete chunk) but BEFORE the completing chunk.
      const mutated = JSON.parse(JSON.stringify(cache.current()));
      mutated.snapshot_sequence++; mutated.snapshot_id = mutated.bridge_process_epoch + ':' + mutated.snapshot_sequence;
      mutated.lifecycle.active.revision++; mutated.lifecycle.active.record_ref.revision++;
      // ★WO014 round6回覧の証拠修復：plan_revisionだけをbumpし
      //   box_delivery.attempts[].plan_revision（とcurrent_custody_ref、
      //   case16-19と同じ同期）を揃えないと、canonical-lifecycle-cache.js
      //   validate()のattempt一貫性チェック（attempt.plan_revision!==a.revision）
      //   に違反してcache.receive()が静かにfalseを返し、cacheが丸ごと
      //   null化（totally unavailable）する副作用でdiscardされていた——
      //   意図した「revisionは変わるがcanonicalはavailableのまま」という
      //   GREEN/RED双方の前提が、実は検査されていなかった。
      for (const a of mutated.box_delivery.attempts) a.plan_revision++;
      if (mutated.lifecycle.active.current_custody_ref) mutated.lifecycle.active.current_custody_ref.revision++;
      check('case4 GREEN setup: same-continued-available Plan-revision mutation accepted (not silently rejected/nulled) by the real canonical cache',
        cache.receive(mutated, g));
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case4 GREEN: mid-flight (real network hold) critical change discards the main-caller reply',
        spoken.length === 0, spoken);
    }
    {
      // RED: same scenario, but with the fence line removed from the
      // extracted source -- proves the control actually depends on the
      // guard, not on some unrelated reason the reply never arrived.
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-red-'));
      const { ctx, spoken } = makeCallApiContext(cache, port, {});
      ctx.strategyProjection = projection;
      const callApiSrc = grabFn('callAPI', true);
      // WO016: the busy release moved out of this line into callAPI's owner-guarded
      // finally; the fence itself (validity check -> cancel -> discard -> return) is unchanged.
      const mutatedSrc = callApiSrc.replace(
        /if\(!strategyReplyBindingValid\(_replyStrategyBinding,full,_replyAuxAtRequest\)\)\{reader\.cancel\?\.\(\);diagnosticLog\('STRATEGY_PROJECTION','stale_reply_discarded'\);(?:isBusy=false;document\.getElementById\('busy-ind'\)\.classList\.remove\('show'\);)?return;\}/,
        'if(false){}');
      check('case4 RED setup: fence line pattern found and removed from extracted source', mutatedSrc !== callApiSrc);
      vm.runInContext(mutatedSrc + '\nthis.callAPI = callAPI;', ctx);
      const scenario = Buffer.from(JSON.stringify({ chunks: ['了解、', '継続する。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '状況教えて ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const mutated = JSON.parse(JSON.stringify(cache.current()));
      mutated.snapshot_sequence++; mutated.snapshot_id = mutated.bridge_process_epoch + ':' + mutated.snapshot_sequence;
      mutated.lifecycle.active.revision++; mutated.lifecycle.active.record_ref.revision++;
      // Same same-continued-available sync as the GREEN block above (and
      // case16-19) -- the RED control must fail for the SAME reason (the
      // fence line removed), not because the mutation itself got silently
      // rejected by validate() on both sides.
      for (const a of mutated.box_delivery.attempts) a.plan_revision++;
      if (mutated.lifecycle.active.current_custody_ref) mutated.lifecycle.active.current_custody_ref.revision++;
      check('case4 RED setup: same-continued-available Plan-revision mutation accepted (not silently rejected/nulled) by the real canonical cache',
        cache.receive(mutated, g));
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case4 RED: with the fence removed, the stale reply IS spoken (proves the control is load-bearing)',
        spoken.length === 1, spoken);
    }

    // ── Case 5 (WO014 round4): mid-flight ORDINARY poll advance via the SAME
    //    real network hold as case4 -- source_frame.sequence/session_time_s,
    //    current_facts.fuel_level_l, AND race_facts.black_flag's own
    //    observed_session_time/source_frame_sequence stamps all move
    //    together (a REAL next poll frame), but no critical fact (Plan/pit/
    //    penalty/awaiting) actually changes. Unlike case4, the reply must
    //    SURVIVE -- proving the real criticalContent() fence does not
    //    mistake black_flag's per-frame re-stamping (authoritative_race_
    //    facts.build_snapshot()) for a critical change on the actual
    //    end-to-end caller path. (current_lap deliberately stays put: see
    //    inline note below on the box_delivery target-lap invariant.) ────
    {
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-ordinary-'));
      const { ctx, spoken } = makeCallApiContext(cache, port, {});
      ctx.strategyProjection = projection;
      const scenario = Buffer.from(JSON.stringify({ chunks: ['了解、', '継続する。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '状況教えて ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const ordinary = JSON.parse(JSON.stringify(cache.current()));
      ordinary.snapshot_sequence++; ordinary.snapshot_id = ordinary.bridge_process_epoch + ':' + ordinary.snapshot_sequence;
      ordinary.source_frame.sequence += 1; ordinary.source_frame.session_time_s += 1;
      ordinary.race_facts.source_frame.sequence = ordinary.source_frame.sequence;
      ordinary.race_facts.source_frame.session_time_s = ordinary.source_frame.session_time_s;
      ordinary.race_facts.black_flag.observed_session_time = ordinary.source_frame.session_time_s;
      ordinary.race_facts.black_flag.source_frame_sequence = ordinary.source_frame.sequence;
      ordinary.current_facts.source_frame.sequence = ordinary.source_frame.sequence;
      ordinary.current_facts.source_frame.session_time_s = ordinary.source_frame.session_time_s;
      // current_lap stays put here: box_delivery.attempts[].driver_pit_sequence
      // notwithstanding, the fixture's execution-allowed attempt requires
      // current_facts.current_lap === lifecycle.active.target_lap (a real
      // production invariant for "allowed to execute"), so bumping the lap
      // without also moving the target would make this an invalid snapshot
      // for an unrelated reason. Fuel burning down is enough to prove the
      // "ordinary progression" shape; lap-ticking is already covered at the
      // unit level in desktop/tests-strategy-state-projection.js.
      ordinary.current_facts.fuel_level_l = 4.2;
      ordinary.finish.source_frame_sequence = ordinary.source_frame.sequence;
      check('case5 setup: ordinary next-poll-frame mutation accepted by the real canonical cache',
        cache.receive(ordinary, g));
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case5 GREEN: mid-flight ORDINARY poll advance (frame+time+fuel+bf stamps) does NOT discard the main-caller reply',
        spoken.length === 1, spoken);
    }

    // ── Case 6 (round4 residual, "unknown主Plan/fuel"): a Plan/fuel-
    //    dependent question asked while canonical is genuinely unavailable
    //    (never once usable, not merely a forced-null realCtx argument on
    //    top of an available projection like case2) was previously
    //    UNFENCED entirely -- binding('facts') also returns null when
    //    unavailable, so the old chain's _replyStrategyBinding fell all
    //    the way to null and the mid-flight check
    //    (`_replyStrategyBinding&&!validBinding(...)`) short-circuited
    //    false no matter what happened afterward. The round4 fix falls
    //    back to binding('critical_context') (the same unavailable
    //    sentinel scheduleAutoBriefing's fence already uses) whenever the
    //    Plan/fuel-specific chain resolves to null. ─────────────────────
    {
      const freshCache = CanonicalCache.create({ now: () => Date.now() });
      const freshProjection = StrategyProjection.create({ canonical: freshCache, now: () => Date.now() });
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-unknown-fuel-green-'));
      const { ctx, spoken } = makeCallApiContext(freshCache, port, {});
      ctx.strategyProjection = freshProjection;
      // mode:'strategy' (not 'race') -- the deterministic fuel guard
      // (isFuelQuestion) only fires for mode==='race'; the renderer's own
      // currentPlanReplyDependsOn()/_replyDependsOnFuel text classification
      // is mode-agnostic, so this still exercises the SAME binding('facts')
      // fallback chain without a deterministic guard intercepting the
      // request before it ever reaches the LLM path.
      ctx.selMode = 'strategy';
      const scenario = Buffer.from(JSON.stringify({ chunks: ['燃料はまだ確認できない、', '少し待って。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '燃料足りる？ ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      // Nothing changes -- canonical stays genuinely unavailable, same scope.
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case6 GREEN: initial-unknown fuel-dependent reply SURVIVES mid-flight when the unavailable scope does not change',
        spoken.length === 1, spoken);
    }
    {
      const freshCache = CanonicalCache.create({ now: () => Date.now() });
      const freshProjection = StrategyProjection.create({ canonical: freshCache, now: () => Date.now() });
      const g2 = freshCache.beginSocket();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-unknown-fuel-red-'));
      const { ctx, spoken } = makeCallApiContext(freshCache, port, {});
      ctx.strategyProjection = freshProjection;
      ctx.selMode = 'strategy';
      const scenario = Buffer.from(JSON.stringify({ chunks: ['燃料はまだ確認できない、', '少し待って。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '燃料足りる？ ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      // Canonical becomes available mid-flight under a real identity --
      // the scope genuinely changed (unknown -> known) while the request
      // was in-flight.
      const snap = canonicalFixture({ frame: 10, decision: 'd-active', lap: 20 });
      snap.continuity.stable_scope = { race_instance_id: snap.race_instance_id, session_num: snap.session_num, driver_id: 7 };
      freshCache.hello(g2, { type: 'connected', schema_version: 1, bridge_process_epoch: snap.bridge_process_epoch });
      freshCache.receive(snap, g2);
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case6 RED: initial-unknown fuel-dependent reply is DISCARDED once canonical becomes available mid-flight (scope changed)',
        spoken.length === 0, spoken);
    }

    // ── Case 7 (round4 residual, "execution/proof semantics"): the SAME
    //    Plan whose execution.allowed/gate_reason or box-authority proof
    //    identity materially changes mid-flight must discard the reply --
    //    criticalContent() previously only tracked active/pit_events/
    //    black_flag/awaiting, so this was invisible to the real end-to-end
    //    fence even though case4 already proved the mechanism itself is
    //    load-bearing for Plan-revision changes. ─────────────────────────
    {
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-execproof-'));
      const { ctx, spoken } = makeCallApiContext(cache, port, {});
      ctx.strategyProjection = projection;
      const scenario = Buffer.from(JSON.stringify({ chunks: ['了解、', '継続する。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '状況教えて ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      // Execution newly HELD (allowed:true->false, a real gate_reason set)
      // on the SAME Plan/pit/penalty/awaiting state -- no revision bump, no
      // new pit event, no black_flag change.
      const mutated = JSON.parse(JSON.stringify(cache.current()));
      mutated.snapshot_sequence++; mutated.snapshot_id = mutated.bridge_process_epoch + ':' + mutated.snapshot_sequence;
      // execution.allowed:false requires box_delivery's allowed_proof_id/
      // allowed_attempt_id to ALSO clear (canonical-lifecycle-cache.js
      // validate() consistency: an allowed_attempt_id requires e.allowed).
      mutated.execution.allowed = false; mutated.execution.gate_reason = 'restart_continuity_unverified';
      mutated.box_delivery.allowed_proof_id = null; mutated.box_delivery.allowed_attempt_id = null;
      check('case7 setup: execution-held mutation accepted by the real canonical cache', cache.receive(mutated, g));
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case7 GREEN: mid-flight execution.allowed/gate_reason change discards the main-caller reply',
        spoken.length === 0, spoken);
    }

    // ── Case 8 (WO014 round5, 共有log「main複合fence」残条件#1 --
    //    mainfuel依存+penalty/execproof): a FUEL-dependent reply's domain
    //    binding is 'facts', which does NOT track execution.allowed/
    //    gate_reason/box-authority proof (criticalContent()-only fields --
    //    see case7). Execution newly HELD mid-flight leaves factContent
    //    byte-identical (fuel/lap/pit_events/active untouched) -- the
    //    domain binding ALONE would stay valid (the pre-round5 gap). The
    //    AND fence (strategyProjection.bindAll([domain,critical_context]))
    //    must still discard this reply because critical_context changed.
    //    Old reply count must be exactly 0 over the REAL HTTP round-trip
    //    (常設, no mock fetch). ───────────────────────────────────────────
    {
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-fuel-execproof-'));
      const { ctx, spoken } = makeCallApiContext(cache, port, {});
      ctx.strategyProjection = projection;
      ctx.selMode = 'strategy';   // same isFuelQuestion-guard dodge as case6
      const scenario = Buffer.from(JSON.stringify({ chunks: ['燃料は、', '足りる見込み。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '燃料足りる？ ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const mutated = JSON.parse(JSON.stringify(cache.current()));
      mutated.snapshot_sequence++; mutated.snapshot_id = mutated.bridge_process_epoch + ':' + mutated.snapshot_sequence;
      mutated.execution.allowed = false; mutated.execution.gate_reason = 'restart_continuity_unverified';
      mutated.box_delivery.allowed_proof_id = null; mutated.box_delivery.allowed_attempt_id = null;
      check('case8 setup: execution-held mutation (fuel-dependent reply, facts byte-identical) accepted by the real canonical cache',
        cache.receive(mutated, g));
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case8 GREEN: mid-flight execution/proof change discards a FUEL-dependent reply (AND fence catches what facts-only domain binding misses; old reply = 0)',
        spoken.length === 0, spoken);
    }
    {
      // RED: same scenario, but with the AND narrowed back to domain-
      // binding-only (the exact pre-round5 gap) -- proves the AND is
      // load-bearing, not some unrelated reason the reply never arrived.
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-fuel-execproof-red-'));
      const { ctx, spoken } = makeCallApiContext(cache, port, {});
      ctx.strategyProjection = projection;
      ctx.selMode = 'strategy';
      const callApiSrc = grabFn('callAPI', true);
      // ★WO015：_replyBindingFor()はround5の_replyDomainBindingに加え、本文が
      //   燃料/周回の具体的数値を主張する時用のchunk単位domain binding
      //   (_chunkDomainBinding、strategyNumericFactBindingのrequest時capture
      //   経由)もANDする。AND-fence自体の文字列はこの変数名へ変わった。
      const mutatedSrc = callApiSrc.replace(
        'strategyProjection.bindAll([_chunkDomainBinding,_replyCriticalBinding])',
        '_chunkDomainBinding');
      check('case8 RED setup: AND-fence pattern found and narrowed to domain-only', mutatedSrc !== callApiSrc);
      vm.runInContext(mutatedSrc + '\nthis.callAPI = callAPI;', ctx);
      const scenario = Buffer.from(JSON.stringify({ chunks: ['燃料は、', '足りる見込み。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '燃料足りる？ ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const mutated = JSON.parse(JSON.stringify(cache.current()));
      mutated.snapshot_sequence++; mutated.snapshot_id = mutated.bridge_process_epoch + ':' + mutated.snapshot_sequence;
      mutated.execution.allowed = false; mutated.execution.gate_reason = 'restart_continuity_unverified';
      mutated.box_delivery.allowed_proof_id = null; mutated.box_delivery.allowed_attempt_id = null;
      cache.receive(mutated, g);
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case8 RED: with the AND narrowed to domain-only, the stale fuel reply IS spoken (old reply != 0 -- proves the AND is load-bearing)',
        spoken.length === 1, spoken);
    }

    // ── Case 9 (WO014 round5, 共有log「main複合fence」残条件#1 --
    //    mainPlan依存+pit/pending): a PLAN-dependent reply's domain
    //    binding is 'plan' (kind 'active'), which tracks ONLY
    //    s.lifecycle.active's own record -- NOT a brand-new pending
    //    proposal appearing in s.lifecycle.awaiting (a criticalContent()
    //    -only field, see strategy-state-projection.js criticalContent()).
    //    The active record itself stays byte-identical -- the domain
    //    binding ALONE would stay valid (the pre-round5 gap). The AND
    //    fence must still discard this reply because critical_context's
    //    awaiting array changed. Old reply count must be exactly 0 over
    //    the REAL HTTP round-trip (常設, no mock fetch). ─────────────────
    {
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-plan-pending-'));
      const { ctx, spoken } = makeCallApiContext(cache, port, {});
      ctx.strategyProjection = projection;
      ctx.selMode = 'strategy';   // dodge the mode==='race'-only engineerCard/_strategyQ guards
      const scenario = Buffer.from(JSON.stringify({ chunks: ['ピット計画は、', '維持する。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: 'ピット計画は？ ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const mutated = JSON.parse(JSON.stringify(cache.current()));
      mutated.snapshot_sequence++; mutated.snapshot_id = mutated.bridge_process_epoch + ':' + mutated.snapshot_sequence;
      mutated.lifecycle.awaiting.push({
        decision_id: 'd-new-awaiting', race_instance_id: mutated.race_instance_id, session_num: mutated.session_num,
        revision: 0, phase: 'awaiting_driver', selected_plan: 'B', target_lap: null, add_fuel_l: null, set_fuel_l: null,
        expected_pit_sequence: null, resolved_pit_sequence: null, activated_source_frame_sequence: null,
        record_ref: { bridge_process_epoch: mutated.bridge_process_epoch, race_instance_id: mutated.race_instance_id, session_num: mutated.session_num, decision_id: 'd-new-awaiting', revision: 0 },
      });
      check('case9 setup: new pending-proposal (awaiting) mutation, active Plan record untouched, accepted by the real canonical cache',
        cache.receive(mutated, g));
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case9 GREEN: mid-flight new pending proposal discards a PLAN-dependent reply (AND fence catches what active-only domain binding misses; old reply = 0)',
        spoken.length === 0, spoken);
    }
    {
      // RED: same scenario, AND narrowed back to domain-binding-only.
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-plan-pending-red-'));
      const { ctx, spoken } = makeCallApiContext(cache, port, {});
      ctx.strategyProjection = projection;
      ctx.selMode = 'strategy';
      const callApiSrc = grabFn('callAPI', true);
      const mutatedSrc = callApiSrc.replace(
        'strategyProjection.bindAll([_chunkDomainBinding,_replyCriticalBinding])',
        '_chunkDomainBinding');
      check('case9 RED setup: AND-fence pattern found and narrowed to domain-only', mutatedSrc !== callApiSrc);
      vm.runInContext(mutatedSrc + '\nthis.callAPI = callAPI;', ctx);
      const scenario = Buffer.from(JSON.stringify({ chunks: ['ピット計画は、', '維持する。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: 'ピット計画は？ ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const mutated = JSON.parse(JSON.stringify(cache.current()));
      mutated.snapshot_sequence++; mutated.snapshot_id = mutated.bridge_process_epoch + ':' + mutated.snapshot_sequence;
      mutated.lifecycle.awaiting.push({
        decision_id: 'd-new-awaiting', race_instance_id: mutated.race_instance_id, session_num: mutated.session_num,
        revision: 0, phase: 'awaiting_driver', selected_plan: 'B', target_lap: null, add_fuel_l: null, set_fuel_l: null,
        expected_pit_sequence: null, resolved_pit_sequence: null, activated_source_frame_sequence: null,
        record_ref: { bridge_process_epoch: mutated.bridge_process_epoch, race_instance_id: mutated.race_instance_id, session_num: mutated.session_num, decision_id: 'd-new-awaiting', revision: 0 },
      });
      cache.receive(mutated, g);
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case9 RED: with the AND narrowed to domain-only, the stale plan reply IS spoken (old reply != 0 -- proves the AND is load-bearing)',
        spoken.length === 1, spoken);
    }

    // ── Case 10-15 (WO014 round5, 共有log「12:20仕上げの全路case最小表」):
    //    group3 requires the AUTO representative (scheduleAutoBriefing) --
    //    not just the main caller already covered by case1-9 -- to show
    //    available-normal+verified-aux, ordinary survival, and epoch/
    //    closure/TTL discard, over the REAL server.js HTTP round-trip.
    //    addMsg()/UI remain neutral no-op stubs in makeBriefingContext
    //    (UI rendering itself is NOT proven here); only the `spoken` array
    //    (the real captured TTS-queue text) and the real SDK-stub-captured
    //    system prompt are asserted as actual values. ───────────────────

    // ── Case 10 (item A, available+normal+verified aux): the auto caller's
    //    real system prompt must carry the REAL canonical Plan/fuel facts
    //    (not poison, not absent) AND a verified_observation-sourced aux
    //    label+value (position/class_position/gap_ahead/gap_behind) when
    //    lastTelemetryAuxRef genuinely correlates with the current
    //    snapshot -- a label+value assert (e.g. "クラス順位 3番手"), not a
    //    weak "contains some digit" assert, so a mismatched/unknown aux
    //    fallback could not accidentally satisfy it. ─────────────────────
    {
      const { snap, cache, projection } = buildScenario();
      const auxSourceRef = { bridge_process_epoch: snap.bridge_process_epoch, canonical_snapshot_id: snap.snapshot_id,
        canonical_snapshot_sequence: snap.snapshot_sequence, race_instance_id: snap.race_instance_id,
        session_num: snap.session_num, source_frame_sequence: snap.source_frame.sequence };
      const { ctx, spoken } = makeBriefingContext(cache, port, projection);
      ctx.lastTelemetryAuxRef = auxSourceRef;
      ctx.lastTelemetry = { gap_ahead: 2.4, gap_behind: 1.2, pos: 9, class_pos: 3 };
      ctx.buildPreviousRaceBriefingNote = () => stub.MARKER
        + Buffer.from(JSON.stringify({ chunks: ['今日は集中していこう。'] })).toString('base64');
      await ctx.scheduleAutoBriefing();
      await ctx._briefingDone;
      const captured = readCapturedSystems();
      const last = captured[captured.length - 1];
      check('case10 (auto available): actual Server captured a system prompt', !!last && typeof last.system === 'string');
      check('case10: actual Server final prompt carries the REAL canonical lap (周回 20)', !!last && last.system.includes('周回 20'));
      check('case10: actual Server final prompt carries the REAL canonical fuel (燃料 5L)', !!last && last.system.includes('燃料 5L'));
      check('case10: actual Server final prompt carries the verified aux class-position label+value (クラス順位 3番手)',
        !!last && last.system.includes('クラス順位 3番手'));
      check('case10: actual Server final prompt carries the verified aux overall-position label+value (総合 9番手)',
        !!last && last.system.includes('総合 9番手'));
      check('case10: actual Server final prompt carries the verified aux gap-ahead label+value (前とのギャップ 2.4秒)',
        !!last && last.system.includes('前とのギャップ 2.4秒'));
      check('case10: actual Server final prompt carries the verified aux gap-behind label+value (後ろとのギャップ 1.2秒)',
        !!last && last.system.includes('後ろとのギャップ 1.2秒'));
      // UI (addMsg) is a neutral no-op stub here -- NOT proof of UI
      // rendering. The actual mock-speech VALUE (not a boolean) is the
      // proof that the real pipeline delivered this exact reply text.
      check('case10: actual auto briefing caller spoke the ACTUAL scripted reply text (round-trip proof, not assumed)',
        spoken.some(s => s.includes('集中していこう')), spoken);
    }

    // ── Case 11 (item A, auto ordinary progression GREEN): mirrors case5
    //    (main caller) for the auto caller -- a genuine next-poll-frame
    //    advance (frame+time+fuel+black-flag stamps) must NOT discard the
    //    briefing reply. ───────────────────────────────────────────────
    {
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-auto-ordinary-'));
      const { ctx, spoken } = makeBriefingContext(cache, port, projection);
      const scenario = Buffer.from(JSON.stringify({ chunks: ['今日は絶好調だ。'], holdGateDir: gateDir, holdAfterChunk: null })).toString('base64');
      ctx.buildPreviousRaceBriefingNote = () => stub.MARKER + scenario;
      await ctx.scheduleAutoBriefing();
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const ordinary = JSON.parse(JSON.stringify(cache.current()));
      ordinary.snapshot_sequence++; ordinary.snapshot_id = ordinary.bridge_process_epoch + ':' + ordinary.snapshot_sequence;
      ordinary.source_frame.sequence += 1; ordinary.source_frame.session_time_s += 1;
      ordinary.race_facts.source_frame.sequence = ordinary.source_frame.sequence;
      ordinary.race_facts.source_frame.session_time_s = ordinary.source_frame.session_time_s;
      ordinary.race_facts.black_flag.observed_session_time = ordinary.source_frame.session_time_s;
      ordinary.race_facts.black_flag.source_frame_sequence = ordinary.source_frame.sequence;
      ordinary.current_facts.source_frame.sequence = ordinary.source_frame.sequence;
      ordinary.current_facts.source_frame.session_time_s = ordinary.source_frame.session_time_s;
      ordinary.current_facts.fuel_level_l = 4.2;
      ordinary.finish.source_frame_sequence = ordinary.source_frame.sequence;
      check('case11 setup: ordinary next-poll-frame mutation (auto) accepted by the real canonical cache',
        cache.receive(ordinary, g));
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await ctx._briefingDone;
      check('case11 GREEN: mid-flight ORDINARY poll advance does NOT discard the auto briefing reply',
        spoken.some(s => s.includes('絶好調')), spoken);
    }

    // ── Case 12 (item B, auto epoch-change discard GREEN): a genuine
    //    reconnect under a NEW bridge_process_epoch with a fresh valid
    //    snapshot (actual beginSocket/hello/receive, accepted=true) must
    //    discard the in-flight briefing reply. ───────────────────────────
    {
      const { cache, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-auto-epoch-'));
      const { ctx, spoken } = makeBriefingContext(cache, port, projection);
      const scenario = Buffer.from(JSON.stringify({ chunks: ['エポック変更前の返信。'], holdGateDir: gateDir, holdAfterChunk: null })).toString('base64');
      ctx.buildPreviousRaceBriefingNote = () => stub.MARKER + scenario;
      await ctx.scheduleAutoBriefing();
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const g2 = cache.beginSocket();
      check('case12 setup: new-epoch hello accepted by the real canonical cache',
        cache.hello(g2, { type: 'connected', schema_version: 1, bridge_process_epoch: 'epoch-b' }));
      const newEpochSnap = canonicalFixture({ epoch: 'epoch-b', frame: 11, decision: 'd-active', lap: 20 });
      newEpochSnap.continuity.stable_scope = { race_instance_id: newEpochSnap.race_instance_id, session_num: newEpochSnap.session_num, driver_id: 7 };
      check('case12 setup: new-epoch valid snapshot accepted by the real canonical cache',
        cache.receive(newEpochSnap, g2));
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await ctx._briefingDone;
      check('case12 GREEN: mid-flight bridge_process_epoch change discards the auto briefing reply (old reply = 0)',
        spoken.length === 0, spoken);
    }

    // ── Case 13 (item B, auto closure/scope_closed discard GREEN): a real
    //    canonical mutation to execution.scope_closed=true (with
    //    execution.allowed=false and box_delivery proof/attempt ids
    //    cleared, the SAME internal-consistency the real cache validate()
    //    requires) must discard the in-flight briefing reply. ───────────
    {
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-auto-closure-'));
      const { ctx, spoken } = makeBriefingContext(cache, port, projection);
      const scenario = Buffer.from(JSON.stringify({ chunks: ['クローズ前の返信。'], holdGateDir: gateDir, holdAfterChunk: null })).toString('base64');
      ctx.buildPreviousRaceBriefingNote = () => stub.MARKER + scenario;
      await ctx.scheduleAutoBriefing();
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const mutated = JSON.parse(JSON.stringify(cache.current()));
      mutated.snapshot_sequence++; mutated.snapshot_id = mutated.bridge_process_epoch + ':' + mutated.snapshot_sequence;
      mutated.execution.allowed = false; mutated.execution.scope_closed = true;
      mutated.box_delivery.allowed_proof_id = null; mutated.box_delivery.allowed_attempt_id = null;
      check('case13 setup: scope_closed closure mutation (allowed=false, proof ids cleared) accepted by the real canonical cache',
        cache.receive(mutated, g));
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await ctx._briefingDone;
      check('case13 GREEN: mid-flight execution.scope_closed change discards the auto briefing reply (old reply = 0)',
        spoken.length === 0, spoken);
    }

    // ── Case 14 (item B, auto TTL/deadline_ms expiry discard GREEN): a
    //    mutable clock injected into BOTH the real CanonicalCache and the
    //    real StrategyProjection's `now()` is advanced past the real
    //    TTL_MS (desktop/canonical-lifecycle-cache.js, 5000ms) -- the
    //    source-level time judgment (cache.current() TTL check AND
    //    validBinding's now()>=deadline_ms check) is the REAL code, only
    //    the clock input is test-controlled. ─────────────────────────────
    {
      const clock = { value: 0 };
      const snap = canonicalFixture({ frame: 10, decision: 'd-active', lap: 20 });
      snap.continuity.stable_scope = { race_instance_id: snap.race_instance_id, session_num: snap.session_num, driver_id: 7 };
      const cache = CanonicalCache.create({ now: () => clock.value });
      const g = cache.beginSocket();
      cache.hello(g, { type: 'connected', schema_version: 1, bridge_process_epoch: snap.bridge_process_epoch });
      check('case14 setup: mutable-clock fixture accepted by the real canonical cache', cache.receive(snap, g));
      const projection = StrategyProjection.create({ canonical: cache, now: () => clock.value });
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-auto-ttl-'));
      const { ctx, spoken } = makeBriefingContext(cache, port, projection);
      const scenario = Buffer.from(JSON.stringify({ chunks: ['TTL前の返信。'], holdGateDir: gateDir, holdAfterChunk: null })).toString('base64');
      ctx.buildPreviousRaceBriefingNote = () => stub.MARKER + scenario;
      await ctx.scheduleAutoBriefing();
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      clock.value += 6000;   // past the real 5000ms TTL_MS, using the SAME injected clock cache/projection.now() reads
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await ctx._briefingDone;
      check('case14 GREEN: mid-flight TTL (deadline_ms) expiry discards the auto briefing reply (old reply = 0)',
        spoken.length === 0, spoken);
    }

    // ── Case 15 (item C, auto guard-removal RED/control for case13's
    //    closure scenario): same scope_closed scenario as case13, but with
    //    ONLY the auto caller's own stale-reply fence line removed from
    //    the extracted scheduleAutoBriefing source (not a fabricated
    //    always-false stand-in for some unrelated guard) -- proves THIS
    //    guard, not some other reason, is why case13 discards. Case8/9's
    //    existing main-caller AND-domain RED controls are unchanged. ────
    {
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-auto-closure-red-'));
      const { ctx, spoken } = makeBriefingContext(cache, port, projection);
      const autoSrc = (renderer.match(/async function scheduleAutoBriefing\(\)\{[\s\S]*?\n\}/) || [null])[0];
      const mutatedAutoSrc = autoSrc.replace(
        "if(!briefingBinding||!strategyProjection.validBinding(briefingBinding)){diagnosticLog('STRATEGY_PROJECTION','stale_briefing_discarded');return;}",
        'if(false){}');
      check('case15 RED setup: auto briefing fence line pattern found and removed from extracted source', mutatedAutoSrc !== autoSrc);
      vm.runInContext(mutatedAutoSrc + '\nthis.scheduleAutoBriefing = scheduleAutoBriefing;', ctx);
      const scenario = Buffer.from(JSON.stringify({ chunks: ['クローズ後でも喋ってしまう返信。'], holdGateDir: gateDir, holdAfterChunk: null })).toString('base64');
      ctx.buildPreviousRaceBriefingNote = () => stub.MARKER + scenario;
      await ctx.scheduleAutoBriefing();
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const mutated = JSON.parse(JSON.stringify(cache.current()));
      mutated.snapshot_sequence++; mutated.snapshot_id = mutated.bridge_process_epoch + ':' + mutated.snapshot_sequence;
      mutated.execution.allowed = false; mutated.execution.scope_closed = true;
      mutated.box_delivery.allowed_proof_id = null; mutated.box_delivery.allowed_attempt_id = null;
      cache.receive(mutated, g);
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await ctx._briefingDone;
      check('case15 RED: with the auto fence line removed, the stale closure reply IS spoken (old reply != 0 -- proves the guard is load-bearing)',
        spoken.length === 1, spoken);
    }

    // ── Case 16-19 (WO014 round6 REVISE, 共有log「会話維持修復の途中独立
    //    差戻し」「返信依存途中修復の三欠陥一括」「返信依存のcurrentfacts
    //    漏れ」): a pure-past/setup question's reply must be classified by
    //    its OWN text, sentence by sentence, not by the question alone --
    //    a historically-framed sentence keeps its lenient scope_continuity
    //    role even after an unrelated mid-flight Plan revision (case16);
    //    but the MOMENT a sentence from that SAME reply asserts anything
    //    about the current Plan (case17) or a bare current race fact such
    //    as position/lap/gap with no Plan/fuel keyword at all (case18), it
    //    must fence on domain+critical (or critical alone) like any other
    //    current-dependent reply -- speech AND assistant history both go
    //    to zero, not just speech. ctx.speak/ctx.speakReplyChunk are
    //    overridden here (not the default no-op push stub used by case1-15)
    //    to actually honor precheck()/validBinding() -- the real
    //    production speak()/speakReplyChunk() do exactly this at dequeue
    //    time; case1-15's discard proof relies on the mid-loop early-
    //    cancel instead, which case16-18's single-sentence-per-chunk shape
    //    does not reach before the first sentence is already queued. ─────
    {
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-history-role-'));
      const { ctx, spoken } = makeCallApiContext(cache, port, {});
      ctx.strategyProjection = projection;
      ctx.selMode = 'strategy';   // dodge mode==='race'-only deterministic guards (「戦略」keyword etc.), same as case6/8/9
      ctx.speak = (t, o) => { if (!o || !o.precheck || o.precheck()) spoken.push(t); };
      ctx.speakReplyChunk = (t, b) => { if (!b || strategyProjection.validBinding(b)) spoken.push(t); };
      const scenario = Buffer.from(JSON.stringify({ chunks: ['前回のレースでは20周で', 'ピットに入った。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '前回の戦略を振り返ろう ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const mutated = JSON.parse(JSON.stringify(cache.current()));
      mutated.snapshot_sequence++; mutated.snapshot_id = mutated.bridge_process_epoch + ':' + mutated.snapshot_sequence;
      mutated.lifecycle.active.revision++; mutated.lifecycle.active.record_ref.revision++;
      for (const a of mutated.box_delivery.attempts) a.plan_revision++;
      if (mutated.lifecycle.active.current_custody_ref) mutated.lifecycle.active.current_custody_ref.revision++;
      check('case16 setup: Plan-revision-only mutation (unrelated to a pure-past reply) accepted by the real canonical cache', cache.receive(mutated, g));
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case16 GREEN: a pure-past reply keeps its role (speech survives) across a mid-flight Plan-revision change it never claimed anything about',
        spoken.some(s => s.includes('前回のレースでは20周でピットに入った')), spoken);
      check('case16: assistant history also retains the maintained pure-past reply',
        ctx.messages.some(m => m.role === 'assistant' && String(m.content).includes('前回のレースでは20周でピットに入った')), ctx.messages);
    }
    {
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-history-leak-plan-'));
      const { ctx, spoken } = makeCallApiContext(cache, port, {});
      ctx.strategyProjection = projection;
      ctx.selMode = 'strategy';   // dodge mode==='race'-only deterministic guards (「戦略」keyword etc.), same as case6/8/9
      ctx.speak = (t, o) => { if (!o || !o.precheck || o.precheck()) spoken.push(t); };
      ctx.speakReplyChunk = (t, b) => { if (!b || strategyProjection.validBinding(b)) spoken.push(t); };
      const scenario = Buffer.from(JSON.stringify({ chunks: ['現在のプランは20周で', 'ボックス。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '前回の戦略を振り返ろう ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const mutated = JSON.parse(JSON.stringify(cache.current()));
      mutated.snapshot_sequence++; mutated.snapshot_id = mutated.bridge_process_epoch + ':' + mutated.snapshot_sequence;
      mutated.lifecycle.active.revision++; mutated.lifecycle.active.record_ref.revision++;
      for (const a of mutated.box_delivery.attempts) a.plan_revision++;
      if (mutated.lifecycle.active.current_custody_ref) mutated.lifecycle.active.current_custody_ref.revision++;
      check('case17 setup: Plan-revision mutation accepted by the real canonical cache', cache.receive(mutated, g));
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case17 GREEN: a reply sentence that asserts the CURRENT Plan is discarded (speech = 0) even though the ORIGINAL question was pure-past',
        spoken.length === 0, spoken);
      check('case17: assistant history has zero entries for the discarded current-Plan claim (not just speech)',
        !ctx.messages.some(m => m.role === 'assistant'), ctx.messages);
    }
    {
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-history-leak-facts-'));
      const { ctx, spoken } = makeCallApiContext(cache, port, {});
      ctx.strategyProjection = projection;
      ctx.selMode = 'strategy';   // dodge mode==='race'-only deterministic guards (「戦略」keyword etc.), same as case6/8/9
      ctx.speak = (t, o) => { if (!o || !o.precheck || o.precheck()) spoken.push(t); };
      ctx.speakReplyChunk = (t, b) => { if (!b || strategyProjection.validBinding(b)) spoken.push(t); };
      // ★「現在の順位は3番手。」には戦略語彙(ピット/ボックス/燃料/プラン等)
      //   が一つも無い——bare current race fact (position) だけでの反証。
      const scenario = Buffer.from(JSON.stringify({ chunks: ['現在の順位は', '3番手。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '前回の戦略を振り返ろう ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const mutated = JSON.parse(JSON.stringify(cache.current()));
      mutated.snapshot_sequence++; mutated.snapshot_id = mutated.bridge_process_epoch + ':' + mutated.snapshot_sequence;
      mutated.lifecycle.active.revision++; mutated.lifecycle.active.record_ref.revision++;
      for (const a of mutated.box_delivery.attempts) a.plan_revision++;
      if (mutated.lifecycle.active.current_custody_ref) mutated.lifecycle.active.current_custody_ref.revision++;
      check('case18 setup: Plan-revision mutation accepted by the real canonical cache', cache.receive(mutated, g));
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case18 GREEN: a reply sentence asserting a bare CURRENT race fact (position, no Plan/fuel keyword at all) is discarded (speech = 0)',
        spoken.length === 0, spoken);
      check('case18: assistant history has zero entries for the discarded current-fact claim',
        !ctx.messages.some(m => m.role === 'assistant'), ctx.messages);
    }
    {
      // RED: same scenario as case17, but with the per-sentence escalation
      // check (_chunkRequiresCriticalFence) neutralized to always false --
      // reproduces the EXACT leak this round's fix closes (a current-Plan
      // claim surviving because only the QUESTION, never the reply
      // sentence itself, was ever classified). Proves the escalation
      // check is load-bearing, not the gate alone (case4/8/9's existing
      // RED controls already cover the gate/AND side and are untouched).
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-history-leak-red-'));
      const { ctx, spoken } = makeCallApiContext(cache, port, {});
      ctx.strategyProjection = projection;
      ctx.selMode = 'strategy';   // dodge mode==='race'-only deterministic guards (「戦略」keyword etc.), same as case6/8/9
      ctx.speak = (t, o) => { if (!o || !o.precheck || o.precheck()) spoken.push(t); };
      ctx.speakReplyChunk = (t, b) => { if (!b || strategyProjection.validBinding(b)) spoken.push(t); };
      const callApiSrc = grabFn('callAPI', true);
      const mutatedSrc = callApiSrc.replace('_chunkRequiresCriticalFence(String(text))', 'false');
      check('case19 RED setup: per-sentence escalation call found and neutralized to always-false', mutatedSrc !== callApiSrc);
      vm.runInContext(mutatedSrc + '\nthis.callAPI = callAPI;', ctx);
      const scenario = Buffer.from(JSON.stringify({ chunks: ['現在のプランは20周で', 'ボックス。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '前回の戦略を振り返ろう ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const mutated = JSON.parse(JSON.stringify(cache.current()));
      mutated.snapshot_sequence++; mutated.snapshot_id = mutated.bridge_process_epoch + ':' + mutated.snapshot_sequence;
      mutated.lifecycle.active.revision++; mutated.lifecycle.active.record_ref.revision++;
      for (const a of mutated.box_delivery.attempts) a.plan_revision++;
      if (mutated.lifecycle.active.current_custody_ref) mutated.lifecycle.active.current_custody_ref.revision++;
      check('case19 RED setup: Plan-revision mutation accepted by the real canonical cache', cache.receive(mutated, g));
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case19 RED: with per-sentence escalation neutralized, the stale current-Plan reply IS spoken (old reply != 0 -- proves the escalation check is load-bearing)',
        spoken.length === 1, spoken);
    }
    {
      // Case 20 (WO014 round6回覧「round6回覧の証拠修復と未分類racefacts
      // 境界」の bounded representative implicit-fact actual-HTTP case):
      // unlike case18 ("現在の順位は3番手。", an EXPLICIT current-tense
      // cue), this reply omits ANY tense cue at all -- no 今/現在, no
      // strategy vocabulary, no historical marker of its own. It is the
      // exact shape that leaked in /tmp/wo014-independent-implicit-facts-
      // role-probe.js: a role-unclear bare race fact riding along on a
      // purely historical QUESTION. It must still be discarded once the
      // canonical Plan revision genuinely changes -- a historical question
      // does not retroactively make an undated reply "past".
      const { cache, g, projection } = buildScenario();
      const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo014-gate-implicit-facts-'));
      const { ctx, spoken } = makeCallApiContext(cache, port, {});
      ctx.strategyProjection = projection;
      ctx.selMode = 'strategy';   // dodge mode==='race'-only deterministic guards (「戦略」keyword etc.), same as case6/8/9
      ctx.speak = (t, o) => { if (!o || !o.precheck || o.precheck()) spoken.push(t); };
      ctx.speakReplyChunk = (t, b) => { if (!b || strategyProjection.validBinding(b)) spoken.push(t); };
      const scenario = Buffer.from(JSON.stringify({ chunks: ['順位は', '3番手。'], holdGateDir: gateDir, holdAfterChunk: 0 })).toString('base64');
      ctx.messages = [{ role: 'user', content: '前回の戦略を振り返ろう ' + stub.MARKER + scenario }];
      const pending = ctx.callAPI('typed');
      await waitForFile(path.join(gateDir, 'arrived'), 8000);
      const mutated = JSON.parse(JSON.stringify(cache.current()));
      mutated.snapshot_sequence++; mutated.snapshot_id = mutated.bridge_process_epoch + ':' + mutated.snapshot_sequence;
      mutated.lifecycle.active.revision++; mutated.lifecycle.active.record_ref.revision++;
      for (const a of mutated.box_delivery.attempts) a.plan_revision++;
      if (mutated.lifecycle.active.current_custody_ref) mutated.lifecycle.active.current_custody_ref.revision++;
      check('case20 setup: Plan-revision mutation accepted by the real canonical cache', cache.receive(mutated, g));
      fs.writeFileSync(path.join(gateDir, 'release'), '1');
      await pending;
      check('case20 GREEN: a reply with NO tense cue at all ("順位は3番手。", no 今/現在, no strategy vocabulary) is still discarded (speech = 0) once the Plan revision actually changes',
        spoken.length === 0, spoken);
      check('case20: assistant history has zero entries for the discarded role-unclear implicit-fact claim',
        !ctx.messages.some(m => m.role === 'assistant'), ctx.messages);
    }
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
  console.log(`\n[wo014-actual-vertical] 合格 ${pass} / 不合格 ${fail}`);
  console.log('※ 実Server/実Renderer/実SDKstub capture。実LLM意味品質・実Windows/iRacingは対象外。');
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
