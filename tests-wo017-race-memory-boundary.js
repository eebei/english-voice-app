#!/usr/bin/env node
'use strict';
// WO017 — race-instanceを使うconversation/decision memory境界。
//
// 同じscenarioを複数のsourceで実行する：
//   before  … /tmp/wo017-before-files（WO017着手前の保全tree）：旧版の赤（RED）を再現
//   packet1 … /tmp/wo017-packet1-files（WO017初回packet。独立反証REVISEの対象。保全diffから再構成し
//             renderer 2c38490…／auth 11fd753…と一致した時だけ使う）：独立反証10件の赤を再現
//   after   … 現在のtree：全caseが緑（GREEN）
//   cut     … 現在のtreeから境界guardを1つだけ外した変異：そのguardが守るcaseだけRED、正常対照はGREEN
// 実renderer関数（renderer.htmlから抽出）・実module（decision/session/conversation/race-scope/
// memory-brain）・実auth.js・実server.js（SDKだけstub）を使う。stubはIO（localStorage・fetch・
// Postgres・Anthropic SDK・profile保存）と、記憶境界の外のUI/音声helperだけ。製品の有料APIは呼ばない。
//
// Postgresはfake（FakePg）。実DBではない。transaction（BEGIN/COMMIT/ROLLBACKでsnapshot復元）、
// pg_advisory_xact_lock（本人単位の待ち合わせmutex）、一意制約、ON CONFLICT DO NOTHING、
// UPDATE ... WHERE version=$n RETURNING を、製品SQLの意味どおりに1文ずつ原子的に実行する。
// 実Postgresの分離レベル・行lock・planの挙動そのものは検証していない。
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const Module = require('module');
const { spawn } = require('child_process');
const ROOT = __dirname;
// 旧比較（着手前551 baseline・packet1再構成）は一時保全物で、無ければ「比較不能」と表示する（PASSに数えない）。
const BEFORE = process.env.WO017_BEFORE_ROOT || '/tmp/wo017-before-files';
const PACKET1 = process.env.WO017_PACKET1_ROOT || '/tmp/wo017-packet1-files';
// 10/17再開時の停止tree（auth 399c73…／renderer d221824…）。残欠陥（S14）の当日baseline。
const OCT17 = process.env.WO017_OCT17_ROOT || '/tmp/wo017-oct17-before-files';
const OCT17_SHA = { 'auth.js': '399c73e006ea7ae2cd08c61509a0758f4b93377d5f2919dfd48f1aeae830e4e5',
  'desktop/renderer.html': 'd221824a1168bffd95087e6e3dd63d1a0d16e630d0e24a65f3cd203ebf414667' };
const PACKET1_SHA = { 'desktop/renderer.html': '2c38490bf5f9636f47dfd541bc9472bc8e58cec808d12afb3f438c61a865f79b',
  'auth.js': '11fd753f50fb7abf580c78a67f1bf7e002d7f9910bc77f46ec73bd4556858bdb' };
const CanonicalCache = require('./desktop/canonical-lifecycle-cache');
const StrategyProjection = require('./desktop/strategy-state-projection');
const RaceContextBuilder = require('./desktop/race-context-builder');
const { fixture } = require('./tests-canonical-lifecycle');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '  ✅ ' : '  ❌ ') + label + (ok ? '' : (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')));
  ok ? pass++ : fail++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ── variant loading ─────────────────────────────────────────────────────
const MODULE_FILES = { box: 'conversation-memory-box.js', det: 'dispute-detector.js',
  dm: 'decision-memory.js', sm: 'session-memory.js', scope: 'race-memory-scope.js', brain: 'memory-brain.js' };
function evalUmd(code) {
  const m = { exports: {} };
  new Function('module', 'exports', 'globalThis', code)(m, m.exports, {});
  return m.exports;
}
function applyCut(text, cut, label) {
  const n = text.split(cut.from).length - 1;
  if (n !== 1) throw new Error('cut ' + label + ' anchor count=' + n + ': ' + cut.from.slice(0, 80));
  return text.replace(cut.from, cut.to);
}
function loadVariant(root, cuts = [], name = 'variant') {
  const html = fs.readFileSync(path.join(root, 'desktop/renderer.html'), 'utf8');
  let src = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).reduce((a, b) => (a.length > b.length ? a : b));
  const codes = {};
  for (const [k, f] of Object.entries(MODULE_FILES)) {
    const p = path.join(root, 'desktop', f);
    codes[k] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  let authCode = fs.readFileSync(path.join(root, 'auth.js'), 'utf8');
  for (const cut of cuts) {
    if (cut.target === 'renderer') src = applyCut(src, cut, name);
    else if (cut.target === 'auth') authCode = applyCut(authCode, cut, name);
    else codes[cut.target] = applyCut(codes[cut.target], cut, name);
  }
  const mods = {};
  for (const k of Object.keys(codes)) mods[k] = codes[k] ? evalUmd(codes[k]) : null;
  return { name, root, src, mods, authCode };
}

function grab(src, name) {
  for (const kw of ['async function ', 'function ']) {
    const i = src.indexOf('\n' + kw + name + '(');
    if (i < 0) continue;
    const rest = src.slice(i + 1);
    const end = rest.search(/\n\}\n/);
    if (end >= 0) return rest.slice(0, end + 2);
  }
  return null;
}
const RENDERER_FNS = ['pushMsg', 'memoryTurnTag', 'currentRaceConversation', 'conversationSessionKey', 'loadConversationBoxes',
  'ensureConversationBox', 'saveConversationBox', 'recordLunaTurn', 'noteDriverInputIdentity', 'noteMemoryRaceScope',
  'currentMemoryRaceScope', 'memoryBindingKey', 'onDriverInputCanonicalEvent', 'currentMemoryIdentity', 'currentMemoryUserId',
  'currentDecisionIdentity', 'localMemoryOwnerRef', 'decisionRaceScopeOf', 'decisionModule', 'loadDecisions',
  'saveDecisions', 'recordDecisionStage', 'syncCanonicalDecisionHistory', 'decisionBriefingSelection',
  'noteMemoryUtterance', 'currentMemoryUtterance', 'disputeRaceRecord', 'loadRaceHistory', 'disputeLatestDecision',
  'pendingDecisionDisputeLive', 'confirmDecisionCorrection', 'decisionSyncEnabled', 'mergeDecisionStores',
  'loadDecisionTombstones', 'saveDecisionTombstones', 'knownOwnerGeneration', 'noteOwnerGeneration',
  'adoptDecisionServerVersion', 'ownerFetch', 'sendDecisionDelete', 'flushDecisionDeletes',
  'syncDecisionsToServer', 'pullDecisionsFromServer', 'listDecisionsForDisplay', 'deleteDecision', 'applyPitwallAccess',
  'loadEvidenceRecords', 'loadMemoryBrainEvaluations', 'prepareMemoryBrain', 'currentMemoryBrainPrompt', 'saveMemory',
  // WO018：race変更時に前raceの振り返り・完走summaryも外す（noteMemoryRaceScopeの実依存）
  'evidenceReviewBound', 'dismissEvidenceDebrief'];
const DECL_RES = [/const MAX_CLIENT_MESSAGES = \d+;/, /const memoryRaceScope=[\s\S]*?:null;/, /const CONVO_BOX_KEY='[^']+';/,
  /const CONVO_BOX_SLOTS=\d+;/, /let _convoBox=null;/, /let driverInputIdentity=null;/,
  /let lastMemoryUtterance=null;/, /let pendingDecisionDispute=null;/,
  /const RACE_DISPUTE_KEY='[^']+';/, /const DECISION_STORE_KEY='[^']+';/, /const DECISION_SYNC_OPTIN_KEY='[^']+';/,
  /const DECISION_TOMBSTONE_KEY='[^']+';/, /const DECISION_OWNER_GEN_KEY='[^']+';/,
  /const MEMORY_BRAIN_EVALUATIONS_KEY='[^']+';/, /let activeMemoryBrainTurn=null;/,
  /let lastSessionSummary = null, autoDebriefTimer = null, autoDebriefStarted = false, autoDebriefData = null;/,
  /let evidenceDebrief = null;/];

// 実際のcallAPI本体から「LLMへ送る会話」の1文を抜き、そのまま評価する（consumerの実コード）。
function outboundStmt(src) {
  const call = grab(src, 'callAPI');
  const m = call && call.match(/const outboundMessages = [\s\S]*?;\n/);
  if (!m) throw new Error('outboundMessages statement not found');
  return 'function __outbound(){\n' + m[0] + 'return outboundMessages;\n}';
}
// sendMsg内の「それ違う」→記録訂正の実分岐（出所選択→dispute）をそのまま抜く。
function disputeEntryStmt(src) {
  const a = src.indexOf('      const _src=');
  const b = src.indexOf('      const _reply=_d&&_d.readback', a);
  if (a < 0 || b < 0) throw new Error('dispute entry not found');
  return 'function __disputeEntry(_lang){\n' + src.slice(a, b) + 'return _d;\n}';
}
// briefingで記憶を喋った時に出所を記録する実際の呼び出し式。
function raceUtteranceStmt(src) {
  const m = src.match(/noteMemoryUtterance\('race',memoryFacts\.[A-Za-z]+\);/);
  if (!m) throw new Error('race utterance call not found');
  return 'function __noteRaceBriefing(memoryFacts){ ' + m[0] + ' }';
}
function decisionUtteranceStmt(src) {
  const m = src.match(/noteMemoryUtterance\('decision',_decSel\.record\.decision_id[^;]*;/);
  if (!m) throw new Error('decision utterance call not found');
  return 'function __noteDecisionBriefing(_decSel){ ' + m[0] + ' }';
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } };
}

function makeRenderer(v) {
  const store = {};
  const logs = [];
  const fetchLog = [];
  const profiles = [];
  const ctx = {
    console, Date, JSON, Math, Map, Set, Promise, Object, Array, String, Number, Error, RegExp,
    AbortController, setTimeout, clearTimeout,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, val) => { store[k] = String(val); },
      removeItem: k => { delete store[k]; } },
    diagnosticLog: (tag, text) => logs.push(String(tag) + ' ' + String(text)),
    enforceDriverInputScope() {}, getDeviceId: () => 'device-1', API_BASE: '',
    canonicalHistoryPending: new Map(),
    strategyProjection: { trace: () => null },
    lastTelemetry: {}, lastTrack: 'Okayama', lastCarModel: 'Audi R8 LMS GT3', lastCarClass: 'GT3',
    lastSessionNum: 2, lastSessionType: 'Race', selMode: 'race', sessionPurpose: null, sel: 'LunaJP',
    lastSessionAuthority: { series_id: 419 }, userName: '', messages: [], _msgSeq: 0,
    driverActivity: 'ACTIVE', usageSessionId: 's',
    // profile（人格メモ）の保存はIO：ここでは記録するだけ（記憶境界の外のneutral stub）
    canPersistMemory: () => true, usageCount() {}, buildProfileNote: () => '',
    loadProfile: () => (profiles.length ? JSON.parse(JSON.stringify(profiles[profiles.length - 1])) : { name: '', notes: [] }),
    saveProfileVerified: p => { profiles.push(JSON.parse(JSON.stringify(p))); return true; },
    memorySaveInFlight: null, lastMemorySignature: '', memorySavedThisSession: false,
    __now: 0,
    PitwallConversationMemoryBox: v.mods.box, PitwallDisputeDetector: v.mods.det,
    PitwallDecisionMemory: v.mods.dm, PitwallSessionMemory: v.mods.sm, PitwallMemoryBrain: v.mods.brain,
  };
  if (v.mods.scope) ctx.PitwallRaceMemoryScope = v.mods.scope;
  ctx.fetchImpl = async () => response(200, { ok: true });
  ctx.fetch = (url, init) => { fetchLog.push({ url, init }); return ctx.fetchImpl(url, init); };
  ctx.window = ctx; ctx.globalThis = ctx;
  ctx.canonicalLifecycleCache = CanonicalCache.create({ now: () => ctx.__now });
  vm.createContext(ctx);
  const decls = DECL_RES.map(re => (v.src.match(re) || [''])[0]).filter(Boolean).join('\n');
  const fns = RENDERER_FNS.map(n => grab(v.src, n)).filter(Boolean).join('\n');
  vm.runInContext(decls + '\n' + fns + '\n' + outboundStmt(v.src) + '\n' + disputeEntryStmt(v.src) + '\n'
    + raceUtteranceStmt(v.src) + '\n' + decisionUtteranceStmt(v.src) + '\n'
    + 'this.__get=(n)=>eval(n);this.__set=(n,x)=>eval(n+"=__x")', Object.assign(ctx, { __x: null }));
  ctx.setVar = (n, x) => { ctx.__x = x; ctx.__set(n); };
  ctx.store = store; ctx.logs = logs; ctx.fetchLog = fetchLog; ctx.profiles = profiles;
  ctx.__epoch = null; ctx.__seq = {};
  return ctx;
}

// 実canonical cacheへ検証済みsnapshotを入れ、Rendererの唯一の受信入口へ渡す。
function raceSnap(ctx, { race, driver = 7, epoch = 'epoch-a', frame = 10, decision = null, session = 2 }) {
  const seq = (ctx.__seq[epoch] || 0) + 1; ctx.__seq[epoch] = seq;
  const s = decision ? fixture({ epoch, seq, frame, race, session, decision, lap: 20 })
    : fixture({ epoch, seq, frame, race, session, decision: null, lap: 20, proof: null, attempt: null, allowed: false });
  if (driver !== null) s.continuity.stable_scope = { race_instance_id: race, session_num: session, driver_id: driver };
  if (ctx.__epoch !== epoch) {
    ctx.__g = ctx.canonicalLifecycleCache.beginSocket();
    if (!ctx.canonicalLifecycleCache.hello(ctx.__g, { type: 'connected', schema_version: 1, bridge_process_epoch: epoch })) throw new Error('hello rejected');
    ctx.__epoch = epoch;
  }
  if (!ctx.canonicalLifecycleCache.receive(s, ctx.__g)) throw new Error('fixture snapshot rejected');
  ctx.onDriverInputCanonicalEvent('receive', s);
  return s;
}
const login = (ctx, id) => { ctx.localStorage.removeItem('pw_beta_code'); ctx.localStorage.setItem('pw_auth_user', JSON.stringify({ id }));
  ctx.localStorage.setItem('pw_auth_token', 'tok-' + id); };
const betaLogin = (ctx, code) => { ctx.localStorage.removeItem('pw_auth_user'); ctx.localStorage.removeItem('pw_auth_token');
  ctx.localStorage.setItem('pw_beta_code', code); };
const logout = ctx => { ctx.localStorage.removeItem('pw_auth_user'); ctx.localStorage.removeItem('pw_auth_token'); ctx.localStorage.removeItem('pw_beta_code'); };
const decisions = ctx => JSON.parse(ctx.store.pw_decisions || '[]');
const iso = ms => new Date(ms).toISOString();
const DAY = 86400000;

// 過去raceで実際に採点まで済んだ判断記録（永続化済みの入力＝IO）。
function pastRecord(over) {
  const at = iso(Date.now() - DAY);
  return Object.assign({
    decision_id: 'sub:900:recalc:pace:2:6:decision-lap:6', race_instance_id: 'sub:900', driver_id: 7, custId: 7,
    owner_ref: 'user:u1', userId: 'u1', track: 'Okayama', car: 'Audi R8 LMS GT3', carClass: 'GT3', seriesId: 419,
    raceFormat: 'race', sessionNum: 2, date: at.slice(0, 10), recordedAt: at, updatedAt: at,
    status: 'closed', outcome: 'success', deleted: false,
    proposal: { selected_plan: 'B', reason: 'undercut', decided_at_lap: 6, entry_class_position: 8, target_lap: 6, add_fuel_l: 34,
      conditions: { fuel_window_open: true, relative_pace_advantage_s: 0.4, rejoin_not_worse: true } },
    execution: { executed_plan: 'B', actual_entry_lap: 6, pos_in: 8, pos_out: 12, fuel_add_error_l: 0.1 },
    blend: { post_cycle_actual_position: 4, condition_met: true }, closure: { finish_pos: 4, reason: 'session_ended' },
    dispute: null, authority_role: 'historical_reference',
  }, over || {});
}
// Bridgeのstrategy_plan_decision無線（同じcanonical publicationに紐づく）。
function proposalEvent(s, id) {
  return { type: 'radio', trigger: 'strategy_plan_decision', decision_id: id,
    bridge_process_epoch: s.bridge_process_epoch, canonical_snapshot_id: s.snapshot_id, canonical_snapshot_sequence: s.snapshot_sequence,
    decision_plan: { decision_id: id, selected_plan: 'A', reason: 'baseline', decided_at_lap: 6, entry_class_position: 8,
      target_lap: 20, add_fuel_l: 7, session_num: 2, conditions: { fuel_window_open: true, relative_pace_advantage_s: 0.2, rejoin_not_worse: true } } };
}
// Bridge（WO017）のpit_cycle_outcome：発生frameのrace/sessionを持つ。race=nullは旧形式（identity無し）。
const blendEvent = (id, race, pos = 4) => Object.assign({ type: 'pit_cycle_outcome', decision_id: id,
  outcome: { condition_met: true, post_cycle_actual_position: pos } },
  race ? { race_instance_id: race, session_num: 2, bridge_process_epoch: 'epoch-a' } : {});
const LEGACY_ID = 'recalc:pace:2:6:decision-lap:6'; // 旧形式：race接頭辞の無いdecision_id（別raceで同じ値になり得る）

// ── cases ───────────────────────────────────────────────────────────────
// 各caseは {ok, detail}。control:true は全source・全cutでGREENであるべき正常対照。
const CASES = [];
const def = (id, title, fn, opts = {}) => CASES.push(Object.assign({ id, title, fn }, opts));

function convoSetup(v) {
  const ctx = makeRenderer(v); login(ctx, 'u1');
  raceSnap(ctx, { race: 'sub:1001' });
  ctx.pushMsg({ role: 'user', content: 'A-Q：ピットはいつ？' });
  ctx.pushMsg({ role: 'assistant', content: 'A-R：12周目にBOX。' });
  ctx.recordLunaTurn('前のクルマとの差は1.2秒。', null);
  const B = v.mods.box; const box = ctx.ensureConversationBox();
  B.openDispute(box, { axis: 'gap_ahead', driver_observation: '差はもっとある', prior_claim_value: '1.2', at: Date.now() });
  ctx.saveConversationBox(box);
  return ctx;
}
const outText = ctx => ctx.__outbound().map(m => m.content).join('\n');
const boxText = ctx => JSON.stringify(ctx.ensureConversationBox());
function resetBoxCache(ctx) { ctx.setVar('_convoBox', null); }

def('C1', '別race（同コース・同車・同SessionNum・同種別）で前raceの会話箱（Luna発話・未解決訂正）を復元しない', v => {
  const ctx = convoSetup(v);
  raceSnap(ctx, { race: 'sub:2002' });
  const box = ctx.ensureConversationBox();
  const lunaTurns = v.mods.box.turnContext(box, Date.now()).filter(t => t.who === 'luna');
  const hit = v.mods.det.detect('違う、差はもっとある', { lunaTurns, reflexes: [], at: Date.now() });
  const ok = !boxText(ctx).includes('1.2秒') && box.open_items.length === 0 && !JSON.stringify(hit || {}).includes('1.2');
  return { ok, detail: { turns: box.turns.length, open: box.open_items.length, hit } };
});
def('C2', '別raceのLLM会話へ前raceのturnを「今の相談」として送らない（実callAPIの送信文）', v => {
  const ctx = convoSetup(v);
  raceSnap(ctx, { race: 'sub:2002' });
  ctx.pushMsg({ role: 'user', content: 'B-Q：燃料足りる？' });
  const t = outText(ctx);
  return { ok: !t.includes('A-Q') && !t.includes('A-R') && t.includes('B-Q'), detail: t };
});
def('C3', '同race再接続（Bridge epoch変更）は別raceと決めつけず会話・箱を復元する', v => {
  const ctx = convoSetup(v);
  raceSnap(ctx, { race: 'sub:1001', epoch: 'epoch-b' });
  resetBoxCache(ctx);
  const ok = outText(ctx).includes('A-Q') && boxText(ctx).includes('1.2秒') && ctx.ensureConversationBox().open_items.length === 1;
  return { ok, detail: outText(ctx) };
}, { control: true });
def('C4', '通常frame進行では会話・箱を捨てない', v => {
  const ctx = convoSetup(v);
  raceSnap(ctx, { race: 'sub:1001', frame: 11 }); raceSnap(ctx, { race: 'sub:1001', frame: 12 });
  return { ok: outText(ctx).includes('A-R') && boxText(ctx).includes('1.2秒'), detail: outText(ctx) };
}, { control: true });
def('C5', 'race A→B→A：Aへ戻るとAの会話・Aの箱（Luna発話・未解決訂正）だけが戻る（Bは混ざらない）', v => {
  const ctx = convoSetup(v);
  raceSnap(ctx, { race: 'sub:2002' });
  ctx.pushMsg({ role: 'user', content: 'B-Q：燃料足りる？' });
  ctx.recordLunaTurn('B-L：あと3周で給油。', null);
  raceSnap(ctx, { race: 'sub:1001', epoch: 'epoch-b' });
  const t = outText(ctx);
  const box = ctx.ensureConversationBox();
  const ok = t.includes('A-Q') && !t.includes('B-Q') && !boxText(ctx).includes('B-L')
    && boxText(ctx).includes('1.2秒') && box.open_items.length === 1;
  return { ok, detail: { out: t, turns: box.turns.length, open: box.open_items.length } };
});
def('C6', 'race前（race未確定）の相談は最初のraceへ続き、別raceへ移ると外れる', v => {
  const ctx = makeRenderer(v); login(ctx, 'u1');
  ctx.pushMsg({ role: 'user', content: 'PRE：今日は燃費重視で' });
  raceSnap(ctx, { race: 'sub:3003' });
  const first = outText(ctx).includes('PRE');
  raceSnap(ctx, { race: 'sub:4004' });
  const second = !outText(ctx).includes('PRE');
  return { ok: first && second, detail: { first, second } };
});
def('C7', '同raceでaccessコード本人が切り替わったら、前の本人の会話・箱を次の本人へ渡さない', v => {
  const ctx = makeRenderer(v); betaLogin(ctx, 'BETA-A');
  raceSnap(ctx, { race: 'sub:1001' });
  ctx.pushMsg({ role: 'user', content: 'OWNER_A_SECRET' });
  ctx.recordLunaTurn('OWNER_A_LUNA', null);
  betaLogin(ctx, 'BETA-B');
  ctx.pushMsg({ role: 'user', content: 'OWNER_B_Q' });
  const t = outText(ctx);
  const ok = !t.includes('OWNER_A_SECRET') && t.includes('OWNER_B_Q') && !boxText(ctx).includes('OWNER_A_LUNA')
    && !JSON.stringify(ctx.store).includes('BETA-A');
  return { ok, detail: { out: t, box: boxText(ctx).slice(0, 160) } };
});
def('C7c', '同じ本人へ戻れば、その本人の同raceの会話は続く（A→B→Aの本人切替）', v => {
  const ctx = makeRenderer(v); login(ctx, 'u1');
  raceSnap(ctx, { race: 'sub:1001' });
  ctx.pushMsg({ role: 'user', content: 'U1_Q' });
  login(ctx, 'u2'); ctx.pushMsg({ role: 'user', content: 'U2_Q' });
  login(ctx, 'u1');
  return { ok: outText(ctx).includes('U1_Q'), detail: outText(ctx) };
}, { control: true });
def('C8', '本人不明（未ログイン・コード無し）では会話履歴を送らず、箱も保存しない', v => {
  const ctx = makeRenderer(v); logout(ctx);
  raceSnap(ctx, { race: 'sub:1001' });
  ctx.pushMsg({ role: 'user', content: 'UNKNOWN_Q' });
  ctx.recordLunaTurn('UNKNOWN_LUNA', null);
  const persisted = Object.values(ctx.store).some(x => String(x).includes('UNKNOWN_LUNA'));
  return { ok: outText(ctx) === '' && !persisted, detail: { out: outText(ctx), persisted } };
});

// 人格メモ（DRIVER_INSIGHT）の遅延保存
async function insightRun(v, switchOwner) {
  const ctx = makeRenderer(v); login(ctx, 'u1');
  raceSnap(ctx, { race: 'sub:1001' });
  ctx.pushMsg({ role: 'user', content: 'RACE_A_SECRET' }); ctx.pushMsg({ role: 'assistant', content: 'A answer' });
  raceSnap(ctx, { race: 'sub:2002' });
  ctx.pushMsg({ role: 'user', content: 'RACE_B_Q' }); ctx.pushMsg({ role: 'assistant', content: 'B answer' });
  let sent = null, release;
  ctx.fetchImpl = (url, init) => { sent = JSON.parse(init.body); return new Promise(r => { release = () => r(response(200, { content: [{ text: 'insight note from conversation' }] })); }); };
  const p = ctx.saveMemory({ force: true, reason: 'test' });
  for (let i = 0; i < 20 && !release; i++) await sleep(1);
  if (switchOwner) login(ctx, 'u2');
  if (release) release();
  const saved = await p;
  return { ctx, sent, saved };
}
def('I1', '人格メモへ渡す会話は今の本人・今のraceだけ（前raceのturnを混ぜない）', async v => {
  const { sent } = await insightRun(v, false);
  const text = sent ? sent.messages[0].content : '';
  return { ok: text.includes('RACE_B_Q') && !text.includes('RACE_A_SECRET'), detail: text };
});
def('I2', '人格メモの応答待ち中に本人が変わったら、前の本人の会話由来のメモを保存しない', async v => {
  const { ctx } = await insightRun(v, true);
  return { ok: ctx.profiles.length === 0, detail: ctx.profiles };
});
def('I2c', '同じ本人のままなら人格メモは従来どおり保存される', async v => {
  const { ctx, saved } = await insightRun(v, false);
  return { ok: saved === true && ctx.profiles.length === 1, detail: { saved, profiles: ctx.profiles.length } };
}, { control: true });

// decision memory
function decisionRace(v, owner = 'u1') {
  const ctx = makeRenderer(v); login(ctx, owner);
  ctx.localStorage.setItem('pw_decision_sync_optin', '1');
  return ctx;
}
def('D1', '同じdecision_idが別raceに出ても提案は別記録。Bの結果（発生raceB）はBの記録へだけ付く', v => {
  const ctx = decisionRace(v);
  const a = raceSnap(ctx, { race: 'sub:1001', decision: LEGACY_ID });
  ctx.recordDecisionStage('proposal', proposalEvent(a, LEGACY_ID));
  const b = raceSnap(ctx, { race: 'sub:2002', decision: LEGACY_ID });
  ctx.recordDecisionStage('proposal', proposalEvent(b, LEGACY_ID));
  ctx.recordDecisionStage('blend', blendEvent(LEGACY_ID, 'sub:2002'));
  ctx.recordDecisionStage('closure', { type: 'session_summary', active_decision_id: LEGACY_ID, finish_pos: 5,
    closure_reason: 'session_ended', race_instance_id: 'sub:2002', session_num: 2 });
  const rows = decisions(ctx);
  const recA = rows.find(r => r.race_instance_id === 'sub:1001') || rows[0];
  const recB = rows.find(r => r.race_instance_id === 'sub:2002');
  const ok = rows.length === 2 && recA && recA.blend === null && recA.status === 'open' && recB && recB.blend && recB.status === 'closed';
  return { ok, detail: rows.map(r => ({ race: r.race_instance_id, blend: !!r.blend, status: r.status })) };
});
def('D11', 'race Bへ移った後に届いたrace A発生の遅延結果は、到着時のBではなく発生元Aの記録へ付く', v => {
  const ctx = decisionRace(v);
  const a = raceSnap(ctx, { race: 'sub:1001', decision: LEGACY_ID });
  ctx.recordDecisionStage('proposal', proposalEvent(a, LEGACY_ID));
  const b = raceSnap(ctx, { race: 'sub:2002', decision: LEGACY_ID });
  ctx.recordDecisionStage('proposal', proposalEvent(b, LEGACY_ID));
  ctx.recordDecisionStage('blend', blendEvent(LEGACY_ID, 'sub:1001', 2));
  const rows = decisions(ctx);
  const recA = rows.find(r => r.race_instance_id === 'sub:1001'), recB = rows.find(r => r.race_instance_id === 'sub:2002');
  return { ok: rows.length === 2 && !!(recA && recA.blend) && !!recB && recB.blend === null,
    detail: rows.map(r => ({ race: r.race_instance_id, blend: !!r.blend })) };
});
def('D1u', '発生race identityを持たない旧形式の結果は、現在raceへも推測で結合しない', v => {
  const ctx = decisionRace(v);
  const b = raceSnap(ctx, { race: 'sub:2002', decision: LEGACY_ID });
  ctx.recordDecisionStage('proposal', proposalEvent(b, LEGACY_ID));
  ctx.recordDecisionStage('blend', blendEvent(LEGACY_ID, null, 2));
  const rows = decisions(ctx);
  return { ok: rows.length === 1 && rows[0].blend === null, detail: rows.map(r => ({ race: r.race_instance_id, blend: !!r.blend })) };
});
def('H1', '過去raceの判断は出所付きhistorical referenceとして別raceのbriefingで使える', v => {
  const ctx = decisionRace(v);
  ctx.store.pw_decisions = JSON.stringify([pastRecord()]);
  raceSnap(ctx, { race: 'sub:3003' });
  const sel = ctx.decisionBriefingSelection();
  const line = v.mods.dm.briefingLine(sel, 'ja');
  const provenanceOk = !sel.provenance || (sel.provenance.race_instance_id === 'sub:900' && sel.provenance.role === 'historical_reference');
  return { ok: sel.available && sel.record.decision_id === pastRecord().decision_id && /前回/.test(line) && provenanceOk, detail: { sel, line } };
}, { control: true });
def('H2', '今のraceの記録を「前回」として喋らない（過去raceの記録を選ぶ）', v => {
  const ctx = decisionRace(v);
  const now = iso(Date.now());
  ctx.store.pw_decisions = JSON.stringify([pastRecord(),
    pastRecord({ decision_id: 'sub:3003:cur', race_instance_id: 'sub:3003', recordedAt: now, updatedAt: now, blend: { post_cycle_actual_position: 2, condition_met: true } })]);
  raceSnap(ctx, { race: 'sub:3003' });
  const sel = ctx.decisionBriefingSelection();
  return { ok: sel.available && sel.record.race_instance_id === 'sub:900', detail: sel.record && sel.record.decision_id };
});
def('D2', '本人不明（accessコード・別本人）の時、同じPCに残る別本人の記録を今日の根拠にしない', v => {
  const ctx = decisionRace(v);
  ctx.store.pw_decisions = JSON.stringify([pastRecord()]);
  betaLogin(ctx, 'BETA-OTHER');
  raceSnap(ctx, { race: 'sub:3003', driver: 8 });
  const otherDriver = ctx.decisionBriefingSelection();
  // Driver不明（SubSessionIDの無いfallback race：stable_scope無し）では本人照合だけが境界
  const ctx2 = decisionRace(v);
  ctx2.store.pw_decisions = JSON.stringify([pastRecord()]);
  betaLogin(ctx2, 'BETA-OTHER');
  raceSnap(ctx2, { race: 'fallback:abc123', driver: null });
  const unknownDriver = ctx2.decisionBriefingSelection();
  return { ok: !otherDriver.available && !unknownDriver.available, detail: { otherDriver: otherDriver.available, unknownDriver: unknownDriver.available } };
});
def('D3', '同期で送るのは今の本人の記録だけ（別本人のcacheを他人の正本へ上げない）', async v => {
  const ctx = decisionRace(v);
  betaLogin(ctx, 'BETA-ME');
  const s = raceSnap(ctx, { race: 'sub:5005', decision: 'sub:5005:mine', driver: 8 });
  ctx.store.pw_decisions = JSON.stringify([pastRecord()]);
  ctx.recordDecisionStage('proposal', proposalEvent(s, 'sub:5005:mine'));
  let body = null;
  ctx.fetchImpl = async (url, init) => { if (init && init.method === 'PUT') body = JSON.parse(init.body); return response(200, { ok: true, stored: 1, results: [] }); };
  await ctx.syncDecisionsToServer();
  const ids = body ? body.decisions.map(r => r.decision_id) : [];
  return { ok: ids.length === 1 && ids[0] === 'sub:5005:mine', detail: ids };
});
def('D4', '削除後、正本DELETEが失敗・遅延しても、後から届いた取得結果で復活しない（次回同期でDELETE再送）', async v => {
  const ctx = decisionRace(v);
  const rec = pastRecord({ server_version: 1 });
  ctx.store.pw_decisions = JSON.stringify([rec]);
  raceSnap(ctx, { race: 'sub:3003' });
  ctx.fetchImpl = async (url, init) => { if (init && init.method === 'DELETE') throw new Error('offline'); return response(200, {}); };
  ctx.deleteDecision(rec.decision_id, rec.race_instance_id);
  await sleep(0);
  const deletes = [];
  ctx.fetchImpl = async (url, init) => {
    if (init && init.method === 'DELETE') { deletes.push(JSON.parse(init.body).decisionId); return response(200, { ok: true }); }
    return response(200, { ok: true, ownerGeneration: 0, decisions: [Object.assign({}, rec, { owner_ref: undefined })] });
  };
  await ctx.pullDecisionsFromServer();
  const sel = ctx.decisionBriefingSelection();
  const resurrected = decisions(ctx).some(r => r.decision_id === rec.decision_id);
  return { ok: !resurrected && !sel.available && deletes.includes(rec.decision_id), detail: { resurrected, deletes, sel: sel.available } };
});
def('D5', '取得の応答待ち中に本人が変わったら、前の本人の正本を今の本人のcacheへ混ぜない', async v => {
  const ctx = decisionRace(v);
  raceSnap(ctx, { race: 'sub:3003', driver: 8 });
  let release;
  ctx.fetchImpl = (url, init) => {
    if (init && init.method && init.method !== 'GET') return Promise.resolve(response(200, { ok: true }));
    return new Promise(res => { release = () => res(response(200, { ok: true, ownerGeneration: 0,
      decisions: [pastRecord({ owner_ref: undefined, userId: null, custId: null, driver_id: null, server_version: 1 })] })); });
  };
  const p = ctx.pullDecisionsFromServer();
  for (let i = 0; i < 20 && !release; i++) await sleep(1);
  betaLogin(ctx, 'BETA-NEXT');
  if (release) release(); await p;
  const sel = ctx.decisionBriefingSelection();
  const leaked = decisions(ctx).some(r => r.decision_id === pastRecord().decision_id);
  return { ok: !leaked && !sel.available, detail: { leaked, sel: sel.available } };
});
def('D10', '削除再送・同期の途中で本人が変わったら、前の本人の削除・記録を次の本人の認証で送らず、未完了のまま残す', async v => {
  const ctx = decisionRace(v, 'A');
  ctx.store.pw_decision_tombstones = JSON.stringify([
    { decision_id: 'd1', race_instance_id: 'sub:1', owner_ref: 'user:A', server_pending: true },
    { decision_id: 'd2', race_instance_id: 'sub:1', owner_ref: 'user:A', server_pending: true }]);
  ctx.store.pw_decisions = JSON.stringify([pastRecord({ decision_id: 'A-secret', owner_ref: 'user:A', userId: 'A' })]);
  const calls = []; let release;
  ctx.fetchImpl = (url, init) => {
    calls.push({ method: init.method, auth: init.headers && init.headers.Authorization });
    if (calls.length === 1) return new Promise(r => { release = () => r(response(200, { ok: true })); });
    return Promise.resolve(response(200, { ok: true, results: [] }));
  };
  const p = ctx.syncDecisionsToServer();
  for (let i = 0; i < 20 && !release; i++) await sleep(1);
  login(ctx, 'B');
  if (release) release();
  await p;
  const tombs = JSON.parse(ctx.store.pw_decision_tombstones || '[]');
  const ok = !calls.some(c => c.auth === 'Bearer tok-B') && tombs.every(t => t.server_pending === true);
  return { ok, detail: { calls, tombs } };
});
def('D12', '取得の結合は正本の版で決める（client時刻に権威を与えない）。同期済みで正本から消えた記録は手元からも消す', async v => {
  const ctx = decisionRace(v);
  const newer = iso(Date.now() - 1000), older = iso(Date.now() - 5 * DAY);
  ctx.store.pw_decisions = JSON.stringify([
    pastRecord({ decision_id: 'L1', server_version: 2, outcome: 'traffic_failure', updatedAt: newer }),
    pastRecord({ decision_id: 'L2', server_version: 3, outcome: 'fuel_failure', updatedAt: newer }),
    pastRecord({ decision_id: 'L3', server_version: 1, updatedAt: newer })]);
  raceSnap(ctx, { race: 'sub:3003' });
  ctx.fetchImpl = async () => response(200, { ok: true, ownerGeneration: 0, decisions: [
    pastRecord({ decision_id: 'L1', server_version: 3, outcome: 'success', updatedAt: older, owner_ref: undefined }),
    pastRecord({ decision_id: 'L2', server_version: 3, outcome: 'unknown', updatedAt: older, owner_ref: undefined })] });
  await ctx.pullDecisionsFromServer();
  const rows = decisions(ctx);
  const g = id => rows.find(r => r.decision_id === id);
  const ok = g('L1') && g('L1').outcome === 'success' && g('L2') && g('L2').outcome === 'fuel_failure' && !g('L3');
  return { ok, detail: rows.map(r => [r.decision_id, r.outcome, r.server_version]) };
});
def('D7', '訂正待ち（それ違う→読み返し）は、別raceへ移った後の「はい」で確定しない', v => {
  const ctx = decisionRace(v);
  const rec = pastRecord();
  ctx.store.pw_decisions = JSON.stringify([rec]);
  raceSnap(ctx, { race: 'sub:3003' });
  ctx.__noteDecisionBriefing(ctx.decisionBriefingSelection());
  const d = ctx.__disputeEntry('ja');
  raceSnap(ctx, { race: 'sub:4004' });
  const out = ctx.confirmDecisionCorrection({}, 'ja');
  const r = decisions(ctx).find(x => x.decision_id === rec.decision_id);
  return { ok: !!d && !out && r.status === 'disputed', detail: { disputed: !!d, confirmed: !!out, status: r.status } };
});
def('D7o', '訂正待ちは、本人が変わった後の「はい」で確定しない（同じrace）', v => {
  const ctx = decisionRace(v);
  const rec = pastRecord();
  ctx.store.pw_decisions = JSON.stringify([rec]);
  raceSnap(ctx, { race: 'sub:3003' });
  ctx.__noteDecisionBriefing(ctx.decisionBriefingSelection());
  const d = ctx.__disputeEntry('ja');
  login(ctx, 'u2');
  const out = ctx.confirmDecisionCorrection({}, 'ja');
  const r = decisions(ctx).find(x => x.decision_id === rec.decision_id);
  return { ok: !!d && !out && r.status === 'disputed', detail: { disputed: !!d, confirmed: !!out, status: r.status } };
});
def('D7c', '同じ本人・同じraceでの「はい」は訂正を確定し、訂正後の記録は再取得できる', v => {
  const ctx = decisionRace(v);
  ctx.localStorage.setItem('pw_decision_sync_optin', '0');
  const rec = pastRecord();
  ctx.store.pw_decisions = JSON.stringify([rec]);
  raceSnap(ctx, { race: 'sub:3003' });
  ctx.__noteDecisionBriefing(ctx.decisionBriefingSelection());
  ctx.__disputeEntry('ja');
  const during = ctx.decisionBriefingSelection().available;
  const out = ctx.confirmDecisionCorrection({}, 'ja');
  const after = ctx.decisionBriefingSelection();
  return { ok: !during && !!out && out.status === 'corrected' && after.available, detail: { during, status: out && out.status, after: after.available } };
}, { control: true });
def('D8', '「それ違う」は直前に喋った記録を止める（後から増えた最新記録を巻き添えにしない）', v => {
  const ctx = decisionRace(v);
  ctx.localStorage.setItem('pw_decision_sync_optin', '0');
  const spoken = pastRecord();
  ctx.store.pw_decisions = JSON.stringify([spoken]);
  raceSnap(ctx, { race: 'sub:3003' });
  ctx.__noteDecisionBriefing(ctx.decisionBriefingSelection());
  const later = pastRecord({ decision_id: 'sub:950:later', race_instance_id: 'sub:950', updatedAt: iso(Date.now() - 1000), recordedAt: iso(Date.now() - 1000) });
  ctx.store.pw_decisions = JSON.stringify([spoken, later]);
  ctx.__disputeEntry('ja');
  const rows = decisions(ctx);
  const s = rows.find(r => r.decision_id === spoken.decision_id), l = rows.find(r => r.decision_id === later.decision_id);
  return { ok: s.status === 'disputed' && l.status !== 'disputed', detail: { spoken: s.status, later: l.status } };
});
def('D9', '前raceで喋った記録への「それ違う」は、別raceへ移った後は推測で止めず聞き返す', v => {
  const ctx = decisionRace(v);
  const rec = pastRecord();
  ctx.store.pw_decisions = JSON.stringify([rec]);
  raceSnap(ctx, { race: 'sub:3003' });
  ctx.__noteDecisionBriefing(ctx.decisionBriefingSelection());
  raceSnap(ctx, { race: 'sub:4004' });
  const d = ctx.__disputeEntry('ja');
  const r = decisions(ctx)[0];
  return { ok: !d && r.status !== 'disputed', detail: { d, status: r.status } };
});
def('R1', 'race記録の「それ違う」は、喋った記録だけを止める（同日の別raceを巻き添えにしない）', v => {
  const ctx = decisionRace(v);
  ctx.setVar('lastSessionAuthority', null);
  const at = iso(Date.now() - DAY);
  const base = { date: at.slice(0, 10), recordedAt: at, userId: 'u1', car: 'Audi R8 LMS GT3', trackTempC: 30, airTempC: 20, startPos: 8, finishPos: 4 };
  ctx.store.pw_raceHistory = JSON.stringify([Object.assign({ raceRecordId: 'rr-1', track: 'Okayama' }, base),
    Object.assign({ raceRecordId: 'rr-2', track: 'Fuji' }, base)]);
  raceSnap(ctx, { race: 'sub:3003' });
  const facts = v.mods.sm.briefingFacts(ctx.loadRaceHistory(), ctx.currentMemoryIdentity(), Date.now());
  ctx.__noteRaceBriefing(facts);
  ctx.__disputeEntry('ja');
  const h = JSON.parse(ctx.store.pw_raceHistory);
  return { ok: facts.available && h[0].disputed === true && h[1].disputed !== true, detail: h.map(r => [r.raceRecordId, !!r.disputed]) };
});

// MemoryBrain（回答前検索→prompt consumer）
function brainRun(v, setup) {
  const ctx = decisionRace(v);
  raceSnap(ctx, { race: 'sub:3003' });
  setup(ctx);
  ctx.prepareMemoryBrain('前回どうだった？');
  return ctx.currentMemoryBrainPrompt();
}
const raceRow = over => Object.assign({ raceRecordId: 'rr-a', recordedAt: iso(Date.now() - DAY), date: iso(Date.now() - DAY).slice(0, 10),
  owner_ref: 'user:u1', userId: 'u1', race_instance_id: 'sub:1001', sessionNum: 2, track: 'Okayama', car: 'Audi R8 LMS GT3',
  startPos: 8, finishPos: 3, incidents: 0 }, over || {});
const debriefRow = over => Object.assign({ review_id: 'rv', owner_ref: 'user:u1', userId: 'u1', race_instance_id: 'sub:2002', session_num: 2,
  track: 'Okayama', car: 'Audi R8 LMS GT3', scope: { track: 'Okayama', car: 'Audi R8 LMS GT3' }, created_at: iso(Date.now() - DAY),
  driverStatement: 'avoid only in B' }, over || {});
def('M1', '記憶検索は結果（race記録）と別raceの振り返りを混成して「確定事実」としてpromptへ出さない', v => {
  const prompt = brainRun(v, ctx => {
    ctx.store.pw_raceHistory = JSON.stringify([raceRow()]);
    ctx.store.pw_session_evidence = JSON.stringify([debriefRow()]);
  });
  return { ok: prompt.includes('"finish_class_pos":3') && !prompt.includes('avoid only in B'), detail: prompt.slice(0, 300) };
});
def('M1c', '同じ発生raceの振り返りは、結果と一緒に記憶として使える', v => {
  const prompt = brainRun(v, ctx => {
    ctx.store.pw_raceHistory = JSON.stringify([raceRow()]);
    ctx.store.pw_session_evidence = JSON.stringify([debriefRow({ race_instance_id: 'sub:1001', driverStatement: 'avoid in A' })]);
  });
  return { ok: prompt.includes('avoid in A'), detail: prompt.slice(0, 300) };
}, { control: true });
def('M2', '記憶検索は別のaccessコード本人の記録を、同じiRacing Driverでも使わない', v => {
  const prompt = brainRun(v, ctx => {
    betaLogin(ctx, 'BETA-ME');
    ctx.setVar('lastTelemetry', { cust_id: 7 });
    ctx.store.pw_raceHistory = JSON.stringify([raceRow({ owner_ref: 'beta:someone-else', userId: null, custId: 7 })]);
  });
  return { ok: prompt === '', detail: prompt.slice(0, 200) };
});

// ── server (real auth.js, FakePg storage) ───────────────────────────────
class FakePg {
  constructor() { this.rows = new Map(); this.tombs = new Set(); this.owners = new Map(); this.locks = new Map();
    this.gates = []; this.tick = 0; this.clients = 0; this.tx = new Map(); this.clockMs = Date.now(); }
  stamp(r) { r.updated = ++this.tick; r.at = this.clockMs; return r; }
  k(o, d, r) { return o + '\u0000' + d + '\u0000' + (r || ''); }
  gate(re, after = false) { const g = { re, after, used: false }; g.arrived = new Promise(r => { g.arrive = r; }); g.wait = new Promise(r => { g.release = r; }); this.gates.push(g); return g; }
  PoolClass() { const db = this; return class { constructor() {} query(sql, p) { return db.exec(sql, p, 0); }
    async connect() { const id = ++db.clients; return { query: (sql, p) => db.exec(sql, p, id), release: () => db.unlock(id) }; } }; }
  async lock(owner, id) {
    for (;;) { const l = this.locks.get(owner); if (!l || l.id === id) break; await l.p; }
    if (!this.locks.has(owner)) { let rel; const p = new Promise(r => { rel = r; }); this.locks.set(owner, { id, p, rel }); }
  }
  unlock(id) { for (const [o, l] of [...this.locks]) if (l.id === id) { this.locks.delete(o); l.rel(); } }
  // transaction：BEGIN時に全stateを複製せず、書込み直前に「その行の元の状態」だけをundo logへ残す
  //   （1書込みO(1)）。ROLLBACKはundo logから元へ戻す。lockで本人単位に直列化されるので行は衝突しない。
  save(id, key) { const t = this.tx.get(id); if (t && !t.rows.has(key)) t.rows.set(key, this.rows.has(key) ? JSON.parse(JSON.stringify(this.rows.get(key))) : undefined); }
  saveOwner(id, owner) { const t = this.tx.get(id); if (t && !t.owners.has(owner)) t.owners.set(owner, this.owners.get(owner)); }
  // IO preload（検査準備だけ）：本人の墓標行を直接置く。上限処理そのものは実authのSQLで1回通す。
  preloadTombstones(owner, n, prefix) {
    for (let i = 0; i < n; i++) this.rows.set(this.k(owner, prefix + i, 'sub:900'), { owner, id: prefix + i, race: 'sub:900', record: {},
      outcome: 'unknown', status: 'open', version: 2, deleted_at: ++this.tick, updated: this.tick, at: this.clockMs });
  }
  live(owner) { return [...this.rows.values()].filter(r => r.owner === owner); }
  async exec(sql, p = [], id) {
    const q = sql.replace(/\s+/g, ' ').trim();
    const gate = this.gates.find(g => !g.used && g.re.test(q));
    if (gate) gate.used = true;
    if (gate && !gate.after) { gate.arrive(); await gate.wait; }
    const out = await this.run(q, p, id);
    if (gate && gate.after) { gate.arrive(); await gate.wait; }
    return out;
  }
  async run(q, p, id) {
    const R = (rows = [], rowCount = rows.length) => ({ rows, rowCount });
    if (q === 'BEGIN') { this.tx.set(id, { rows: new Map(), owners: new Map() }); return R(); }
    if (q === 'COMMIT') { this.tx.delete(id); this.unlock(id); return R(); }
    if (q === 'ROLLBACK') {
      const t = this.tx.get(id);
      if (t) {
        for (const [k, v] of t.rows) { if (v === undefined) this.rows.delete(k); else this.rows.set(k, v); }
        for (const [o, g] of t.owners) { if (g === undefined) this.owners.delete(o); else this.owners.set(o, g); }
      }
      this.tx.delete(id); this.unlock(id); return R();
    }
    if (/^SELECT pg_advisory_xact_lock/.test(q)) { await this.lock(p[0], id); return R(); }
    if (/^SELECT purge_generation FROM strategy_decision_owners/.test(q)) {
      return this.owners.has(p[0]) ? R([{ purge_generation: this.owners.get(p[0]) }]) : R(); }
    if (/^INSERT INTO strategy_decision_owners/.test(q)) {
      this.saveOwner(id, p[0]); const g = (this.owners.get(p[0]) || 0) + 1; this.owners.set(p[0], g); return R([{ purge_generation: g }]); }
    const row = (o, d, r) => this.rows.get(this.k(o, d, r));
    if (/^UPDATE strategy_decisions SET identity=\$4/.test(q)) {
      const r = row(p[0], p[1], p[2]);
      if (!r) return R();
      if (/deleted_at IS NULL/.test(q) && r.deleted_at) return R();
      if (/version=\$8/.test(q) && r.version !== p[7]) return R();
      if (/\$8::bigint IS NOT NULL/.test(q) && (p[7] === null || p[7] === undefined)) return R();
      this.save(id, this.k(p[0], p[1], p[2]));
      Object.assign(r, { record: JSON.parse(p[4]), outcome: p[5], status: p[6], version: r.version + 1, updated: ++this.tick, at: this.clockMs });
      return R([{ version: r.version }]);
    }
    if (/^INSERT INTO strategy_decisions \(owner_key,decision_id,race_key,identity,record,outcome,status,version,created_at,updated_at\)/.test(q)) {
      const key = this.k(p[0], p[1], p[2]);
      if (this.rows.has(key)) {
        if (!/DO NOTHING/.test(q)) {   // 版付き上書きを1文で行う旧中間形（WHERE version=$8）
          const r = this.rows.get(key);
          if (/deleted_at IS NULL/.test(q) && r.deleted_at) return R();
          if (/version = \$8/.test(q) && r.version !== p[7]) return R();
          this.save(id, key);
          Object.assign(r, { record: JSON.parse(p[4]), outcome: p[5], status: p[6], version: r.version + 1, updated: ++this.tick, at: this.clockMs });
          return R([{ version: r.version }]);
        }
        return R();
      }
      this.save(id, key);
      this.rows.set(key, { owner: p[0], id: p[1], race: p[2], record: JSON.parse(p[4]), outcome: p[5], status: p[6], version: 1, deleted_at: null, updated: ++this.tick, at: this.clockMs });
      return R([{ version: 1 }]);
    }
    if (/^INSERT INTO strategy_decisions \(owner_key,decision_id,race_key,identity,record,outcome,status,version,deleted_at/.test(q)) {
      const key = this.k(p[0], p[1], p[2]); const r = this.rows.get(key);
      this.save(id, key);
      const wiped = { owner: p[0], id: p[1], race: p[2], record: {}, outcome: 'unknown', status: 'open', deleted_at: ++this.tick, updated: this.tick, at: this.clockMs };
      this.rows.set(key, Object.assign(wiped, { version: r ? r.version + 1 : 1 }));
      return R([{ version: this.rows.get(key).version }]);
    }
    if (/^UPDATE strategy_decisions SET identity='\{\}'::jsonb/.test(q)) {
      let n = 0; for (const r of this.live(p[0])) if (!r.deleted_at) { this.save(id, this.k(r.owner, r.id, r.race)); Object.assign(r, { record: {}, outcome: 'unknown', status: 'open', version: r.version + 1, deleted_at: ++this.tick, updated: this.tick, at: this.clockMs }); n++; }
      return R([], n);
    }
    if (/^UPDATE strategy_decisions SET status='disputed'/.test(q)) {
      const targets = /race_key=\$3/.test(q) ? [row(p[0], p[1], p[2])].filter(Boolean) : this.live(p[0]).filter(r => r.id === p[1]);
      const hit = targets.filter(r => !r.deleted_at);
      for (const r of hit) { this.save(id, this.k(r.owner, r.id, r.race)); r.status = 'disputed'; r.record = Object.assign({}, r.record, { status: 'disputed' }); r.version += 1; r.updated = ++this.tick; r.at = this.clockMs; }
      return R(/RETURNING/.test(q) ? hit.map(r => ({ version: r.version })) : [], hit.length);
    }
    if (/^SELECT version, deleted_at FROM strategy_decisions/.test(q)) {
      const r = row(p[0], p[1], p[2]); return r ? R([{ version: r.version, deleted_at: r.deleted_at }]) : R(); }
    if (/^SELECT record, ?(version|updated_at) FROM strategy_decisions/.test(q)) {
      return R(this.live(p[0]).filter(r => !r.deleted_at).sort((a, b) => a.updated - b.updated).map(r => ({ record: r.record, version: r.version }))); }
    if (/^INSERT INTO strategy_decisions \(owner_key,decision_id,identity,record/.test(q)) {   // 旧PK(owner,decision_id)形
      const key = this.k(p[0], p[1], ''); const r = this.rows.get(key);
      this.save(id, key);
      const rec = JSON.parse(p[3]);
      this.rows.set(key, { owner: p[0], id: p[1], race: '', record: rec, outcome: p[4], status: p[5], version: r ? r.version + 1 : 1, deleted_at: null, updated: ++this.tick, at: this.clockMs });
      return R([], 1);
    }
    if (/^SELECT decision_id FROM strategy_decision_tombstones/.test(q)) {
      return R([...this.tombs].filter(t => t.startsWith(p[0] + '\u0000')).map(t => ({ decision_id: t.split('\u0000')[1] }))); }
    if (/^INSERT INTO strategy_decision_tombstones .* SELECT/.test(q)) {
      for (const r of this.live(p[0])) this.tombs.add(p[0] + '\u0000' + r.id); return R(); }
    if (/^INSERT INTO strategy_decision_tombstones/.test(q)) { this.tombs.add(p[0] + '\u0000' + p[1]); return R([], 1); }
    if (/^DELETE FROM strategy_decision_tombstones/.test(q)) return R();
    if (/^DELETE FROM strategy_decisions WHERE owner_key=\$1 AND updated_at </.test(q)) {
      let n = 0; for (const r of this.live(p[0])) if ((r.at ?? this.clockMs) < this.clockMs - p[1]) { this.save(id, this.k(r.owner, r.id, r.race)); this.rows.delete(this.k(r.owner, r.id, r.race)); n++; }
      return R([], n);
    }
    if (/^WITH gone AS \( DELETE FROM strategy_decisions .* deleted_at IS NOT NULL ORDER BY updated_at DESC OFFSET \$2\)/.test(q)) {
      const sorted = this.live(p[0]).filter(r => r.deleted_at).sort((a, b) => b.updated - a.updated);
      let n = 0; for (const r of sorted.slice(p[1])) { this.save(id, this.k(r.owner, r.id, r.race)); this.rows.delete(this.k(r.owner, r.id, r.race)); n++; }
      return R([{ n }]);
    }
    if (/^DELETE FROM strategy_decisions WHERE owner_key=\$1 AND (\(decision_id, race_key\)|decision_id) IN/.test(q)) {
      const sorted = this.live(p[0]).filter(r => !/deleted_at IS NULL ORDER BY/.test(q) || !r.deleted_at).sort((a, b) => b.updated - a.updated);
      let n = 0; for (const r of sorted.slice(p[1])) { this.save(id, this.k(r.owner, r.id, r.race)); this.rows.delete(this.k(r.owner, r.id, r.race)); n++; }
      return R([], n);
    }
    if (/^DELETE FROM strategy_decisions WHERE owner_key=\$1 AND decision_id=\$2$/.test(q)) {
      let n = 0; for (const r of this.live(p[0]).filter(r => r.id === p[1])) { this.save(id, this.k(r.owner, r.id, r.race)); this.rows.delete(this.k(r.owner, r.id, r.race)); n++; }
      return R([], n);
    }
    if (/^DELETE FROM strategy_decisions WHERE owner_key=\$1$/.test(q)) {
      let n = 0; for (const r of this.live(p[0])) { this.save(id, this.k(r.owner, r.id, r.race)); this.rows.delete(this.k(r.owner, r.id, r.race)); n++; } return R([], n); }
    // 判断記憶のSQLで未対応の文は黙って成功させない（fakeが製品SQLの変化に追従していない時は赤）。
    if (/strategy_decision/.test(q) && !/^(CREATE|ALTER)/.test(q)) throw new Error('FakePg: unhandled SQL ' + q.slice(0, 100));
    return R();
  }
}
async function loadAuth(v) {
  const db = new FakePg();
  const prev = { DATABASE_URL: process.env.DATABASE_URL, JWT_SECRET: process.env.JWT_SECRET };
  process.env.DATABASE_URL = 'postgres://fake'; process.env.JWT_SECRET = 'wo017-test-secret';
  const origLoad = Module._load;
  const Pool = db.PoolClass();
  Module._load = function (request) {
    if (request === 'pg') return { Pool };
    return origLoad.apply(this, arguments);
  };
  try {
    const filename = path.join(ROOT, '.wo017-auth-' + v.name.replace(/[^a-z0-9]/gi, '_') + '.js');
    const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(ROOT);
    m._compile(v.authCode, filename);
    const log = console.log, warn = console.warn; console.log = () => {}; console.warn = () => {};
    try { await m.exports.init(); } finally { console.log = log; console.warn = warn; }
    return { auth: m.exports, db };
  } finally {
    Module._load = origLoad;
    for (const [k, val] of Object.entries(prev)) { if (val === undefined) delete process.env[k]; else process.env[k] = val; }
  }
}
const U = { userId: 'u1' };
const listed = async (auth, owner = U) => (await auth.listStrategyDecisions(owner)).decisions;
const verOf = (rows, id, race) => { const r = rows.find(x => x.decision_id === id && (!race || x.race_instance_id === race)); return r ? r.server_version : undefined; };
async function withGate(db, re, after, first, second) {
  const g = db.gate(re, after);
  const p1 = first();
  await Promise.race([g.arrived, sleep(300)]);
  const p2 = second();
  await sleep(20);
  g.release();
  return Promise.all([p1, p2]);
}
def('S1', '正本sanitizerはrace／Driver identityを残し、本人はclient値ではなく認証主体から付ける', async v => {
  const { auth } = await loadAuth(v);
  await auth.saveStrategyDecisions({ ...U, decisions: [pastRecord({ userId: 'evil' })] });
  const got = (await listed(auth))[0];
  const other = await listed(auth, { userId: 'u2' });
  return { ok: !!got && got.race_instance_id === 'sub:900' && got.driver_id === 7 && String(got.userId) === 'u1' && other.length === 0,
    detail: got && { race: got.race_instance_id, driver: got.driver_id, user: got.userId, other: other.length } };
});
def('S2', '正本で削除したIDは、古いcache／別PCの遅れたPUT（版あり・版無し）で復活しない', async v => {
  const { auth } = await loadAuth(v);
  const rec = pastRecord();
  await auth.saveStrategyDecisions({ ...U, decisions: [rec] });
  const v1 = verOf(await listed(auth), rec.decision_id);
  await auth.deleteStrategyDecision({ ...U, decisionId: rec.decision_id, raceInstanceId: rec.race_instance_id });
  await auth.saveStrategyDecisions({ ...U, decisions: [Object.assign({}, rec, { server_version: v1 })] });
  await auth.saveStrategyDecisions({ ...U, decisions: [rec] });
  const rows = await listed(auth);
  return { ok: !rows.some(r => r.decision_id === rec.decision_id), detail: rows.map(r => r.decision_id) };
});
def('S3', '正本：削除していない別IDの保存・取得は従来どおり', async v => {
  const { auth } = await loadAuth(v);
  await auth.saveStrategyDecisions({ ...U, decisions: [pastRecord(), pastRecord({ decision_id: 'sub:901:x', race_instance_id: 'sub:901' })] });
  await auth.deleteStrategyDecision({ ...U, decisionId: pastRecord().decision_id, raceInstanceId: 'sub:900' });
  const ids = (await listed(auth)).map(r => r.decision_id);
  return { ok: ids.length === 1 && ids[0] === 'sub:901:x', detail: ids };
}, { control: true });
def('S4', '正本：同じdecision_idの別raceは別行。片raceの削除が他raceへ及ばない', async v => {
  const { auth } = await loadAuth(v);
  await auth.saveStrategyDecisions({ ...U, decisions: [pastRecord({ decision_id: LEGACY_ID, race_instance_id: 'sub:1001' }),
    pastRecord({ decision_id: LEGACY_ID, race_instance_id: 'sub:2002' })] });
  const both = (await listed(auth)).filter(r => r.decision_id === LEGACY_ID).map(r => r.race_instance_id);
  await auth.deleteStrategyDecision({ ...U, decisionId: LEGACY_ID, raceInstanceId: 'sub:1001' });
  const left = (await listed(auth)).filter(r => r.decision_id === LEGACY_ID).map(r => r.race_instance_id);
  return { ok: both.length === 2 && left.length === 1 && left[0] === 'sub:2002', detail: { both, left } };
});
def('S5', '正本：訂正（dispute）後に遅れた旧PUTが届いても、訂正前の状態へ戻らない', async v => {
  const { auth } = await loadAuth(v);
  const rec = pastRecord();
  await auth.saveStrategyDecisions({ ...U, decisions: [rec] });
  const v1 = verOf(await listed(auth), rec.decision_id);
  await auth.markStrategyDecisionDisputed({ ...U, decisionId: rec.decision_id, raceInstanceId: rec.race_instance_id });
  await auth.saveStrategyDecisions({ ...U, decisions: [Object.assign({}, rec, { status: 'closed', server_version: v1 })] });
  const r = (await listed(auth)).find(x => x.decision_id === rec.decision_id);
  return { ok: !!r && r.status === 'disputed', detail: r && { status: r.status, v: r.server_version } };
});
def('S5c', '正本：訂正後の版を基にした本人合意の訂正PUTは受理される', async v => {
  const { auth } = await loadAuth(v);
  const rec = pastRecord();
  await auth.saveStrategyDecisions({ ...U, decisions: [rec] });
  await auth.markStrategyDecisionDisputed({ ...U, decisionId: rec.decision_id, raceInstanceId: rec.race_instance_id });
  const v2 = verOf(await listed(auth), rec.decision_id);
  await auth.saveStrategyDecisions({ ...U, decisions: [Object.assign({}, rec, { status: 'corrected', server_version: v2 })] });
  const r = (await listed(auth)).find(x => x.decision_id === rec.decision_id);
  return { ok: !!r && r.status === 'corrected', detail: r && r.status };
}, { control: true });
def('S6a', '正本：全削除と並行した旧世代PUTは、本人lockで直列化され、全削除後に本文が残らない', async v => {
  const { auth, db } = await loadAuth(v);
  await auth.saveStrategyDecisions({ ...U, decisions: [pastRecord()] });
  await withGate(db, /^SELECT purge_generation FROM strategy_decision_owners/, true,
    () => auth.saveStrategyDecisions({ ...U, ownerGeneration: 0, decisions: [pastRecord({ decision_id: 'new-during-purge', race_instance_id: 'sub:950' })] }),
    () => auth.deleteStrategyDecision({ ...U, decisionId: null }));
  const rows = await listed(auth);
  return { ok: rows.length === 0, detail: rows.map(r => r.decision_id) };
});
def('S6b', '正本：保存と削除が並行しても（保存の照合直後に削除が割り込んでも）削除内容が復活しない', async v => {
  const { auth, db } = await loadAuth(v);
  const rec = pastRecord();
  await auth.saveStrategyDecisions({ ...U, decisions: [rec] });
  const v1 = verOf(await listed(auth), rec.decision_id);
  await withGate(db, /^SELECT decision_id FROM strategy_decision_tombstones|^UPDATE strategy_decisions SET identity=\$4/, true,
    () => auth.saveStrategyDecisions({ ...U, ownerGeneration: 0, decisions: [Object.assign({}, rec, { status: 'closed', server_version: v1 })] }),
    () => auth.deleteStrategyDecision({ ...U, decisionId: rec.decision_id, raceInstanceId: rec.race_instance_id }));
  const rows = await listed(auth);
  return { ok: !rows.some(r => r.decision_id === rec.decision_id), detail: rows.map(r => r.decision_id) };
});
def('S7', '正本：まだ届いていないIDを先に削除すると、後から届いたPUTでも作られない', async v => {
  const { auth } = await loadAuth(v);
  await auth.deleteStrategyDecision({ ...U, decisionId: 'late-id', raceInstanceId: 'sub:900' });
  await auth.saveStrategyDecisions({ ...U, decisions: [pastRecord({ decision_id: 'late-id' })] });
  return { ok: !(await listed(auth)).some(r => r.decision_id === 'late-id'), detail: (await listed(auth)).map(r => r.decision_id) };
});
def('S8', '正本：全削除の後、全削除前の世代しか知らない端末のPUTは本文を保存しない（未着IDも）', async v => {
  const { auth } = await loadAuth(v);
  await auth.saveStrategyDecisions({ ...U, decisions: [pastRecord()] });
  await auth.deleteStrategyDecision({ ...U, decisionId: null });
  await auth.saveStrategyDecisions({ ...U, ownerGeneration: 0, decisions: [pastRecord({ decision_id: 'stale-device-new' })] });
  return { ok: (await listed(auth)).length === 0, detail: (await listed(auth)).map(r => r.decision_id) };
});
def('S8c', '正本：全削除後の世代を知る端末の新規保存は通常どおり受理される', async v => {
  const { auth } = await loadAuth(v);
  await auth.saveStrategyDecisions({ ...U, decisions: [pastRecord()] });
  const gen = (await auth.deleteStrategyDecision({ ...U, decisionId: null })).ownerGeneration;
  await auth.saveStrategyDecisions({ ...U, ownerGeneration: Number.isInteger(gen) ? gen : 0, decisions: [pastRecord({ decision_id: 'fresh-after-purge' })] });
  return { ok: (await listed(auth)).some(r => r.decision_id === 'fresh-after-purge'), detail: (await listed(auth)).map(r => r.decision_id) };
}, { control: true });
def('S9', '正本：削除墓標が件数上限（200）で消えた後でも、版を基にした旧PUTで削除内容が復活しない', async v => {
  const { auth } = await loadAuth(v);
  const rec = pastRecord({ decision_id: 'deleted-then-evicted' });
  await auth.saveStrategyDecisions({ ...U, decisions: [rec] });
  const v1 = verOf(await listed(auth), rec.decision_id);
  await auth.deleteStrategyDecision({ ...U, decisionId: rec.decision_id, raceInstanceId: rec.race_instance_id });
  for (let b = 0; b < 4; b++) {
    await auth.saveStrategyDecisions({ ...U, decisions: Array.from({ length: 50 }, (_, i) => pastRecord({ decision_id: 'filler-' + b + '-' + i })) });
  }
  await auth.saveStrategyDecisions({ ...U, decisions: [Object.assign({}, rec, { server_version: v1 === undefined ? 1 : v1 })] });
  const rows = await listed(auth);
  return { ok: !rows.some(r => r.decision_id === rec.decision_id) && rows.length === 200, detail: { count: rows.length, resurrected: rows.some(r => r.decision_id === rec.decision_id) } };
});
def('S9c', '正本：上限の範囲で通常の新規・更新（版一致）は受理され続ける', async v => {
  const { auth } = await loadAuth(v);
  for (let b = 0; b < 4; b++) {
    await auth.saveStrategyDecisions({ ...U, decisions: Array.from({ length: 50 }, (_, i) => pastRecord({ decision_id: 'n-' + b + '-' + i })) });
  }
  const rows = await listed(auth);
  const last = rows.find(r => r.decision_id === 'n-3-49');
  await auth.saveStrategyDecisions({ ...U, decisions: [Object.assign({}, last, { outcome: 'traffic_failure' })] });
  const updated = (await listed(auth)).find(r => r.decision_id === 'n-3-49');
  return { ok: rows.length === 200 && updated && updated.outcome === 'traffic_failure', detail: { count: rows.length, outcome: updated && updated.outcome } };
}, { control: true });
def('S10', '正本：正本に無い未来の世代を名乗るPUTは受理しない', async v => {
  const { auth } = await loadAuth(v);
  await auth.saveStrategyDecisions({ ...U, ownerGeneration: 5, decisions: [pastRecord({ decision_id: 'future' })] });
  return { ok: !(await listed(auth)).some(r => r.decision_id === 'future'), detail: (await listed(auth)).map(r => r.decision_id) };
});

def('S11', '正本：初回PUTのACKを失った端末（版無し）が、別端末の削除と200件の新規の後に再送しても復活しない', async v => {
  const { auth } = await loadAuth(v);
  const rec = pastRecord({ decision_id: 'unacked-then-deleted' });
  await auth.saveStrategyDecisions({ ...U, decisions: [rec] });       // 正本はcommit、端末はACKを失った（版無しのまま）
  await auth.deleteStrategyDecision({ ...U, decisionId: rec.decision_id, raceInstanceId: rec.race_instance_id });
  for (let b = 0; b < 4; b++) {
    await auth.saveStrategyDecisions({ ...U, decisions: Array.from({ length: 50 }, (_, i) => pastRecord({ decision_id: 'fill-' + b + '-' + i })) });
  }
  await auth.saveStrategyDecisions({ ...U, decisions: [rec] });       // 同じ端末の再送（版無し）
  const rows = await listed(auth);
  return { ok: !rows.some(r => r.decision_id === rec.decision_id) && rows.length === 200, detail: { count: rows.length } };
});
def('S12', '正本：削除墓標が保持期間で消えた後も、版を基にした旧PUTでは作られない', async v => {
  const { auth, db } = await loadAuth(v);
  const rec = pastRecord({ decision_id: 'deleted-then-expired' });
  await auth.saveStrategyDecisions({ ...U, decisions: [rec] });
  const v1 = verOf(await listed(auth), rec.decision_id);
  await auth.deleteStrategyDecision({ ...U, decisionId: rec.decision_id, raceInstanceId: rec.race_instance_id });
  db.clockMs += 91 * DAY;
  await auth.listStrategyDecisions(U);                                 // 保持期間の掃除を走らせる
  await auth.saveStrategyDecisions({ ...U, decisions: [Object.assign({}, rec, { server_version: v1 === undefined ? 1 : v1 })] });
  return { ok: !(await listed(auth)).some(r => r.decision_id === rec.decision_id), detail: (await listed(auth)).map(r => r.decision_id) };
});
def('S13', '正本：墓標が上限を超えて古い墓標を消した時は本人の世代を進め、古い世代の端末の書込みを拒否する', async v => {
  const { auth, db } = await loadAuth(v);
  // 製品の上限値（5000）はそのまま。上限直前までの墓標はIO preloadで置き、上限を超える1件の削除だけ
  //   実authの経路（transaction・lock・墓標化・上限処理・世代更新）を通す。
  const max = Number.isInteger(auth.DECISION_MAX_TOMBSTONES_PER_OWNER) ? auth.DECISION_MAX_TOMBSTONES_PER_OWNER : 5000;
  const first = pastRecord({ decision_id: 'oldest-deleted' });
  await auth.saveStrategyDecisions({ ...U, decisions: [first] });
  await auth.deleteStrategyDecision({ ...U, decisionId: first.decision_id, raceInstanceId: first.race_instance_id });
  db.preloadTombstones('user:u1', max - 1, 'preloaded-gone-');
  const last = await auth.deleteStrategyDecision({ ...U, decisionId: 'gone-over-bound', raceInstanceId: 'sub:900' });
  const tombs = db.live('user:u1').filter(r => r.deleted_at).length;
  const gen = last && Number.isInteger(last.ownerGeneration) ? last.ownerGeneration : 0;
  await auth.saveStrategyDecisions({ ...U, ownerGeneration: 0, decisions: [first] });
  const resurrected = (await listed(auth)).some(r => r.decision_id === first.decision_id);
  await auth.saveStrategyDecisions({ ...U, ownerGeneration: gen, decisions: [pastRecord({ decision_id: 'fresh-after-bound' })] });
  const freshOk = (await listed(auth)).some(r => r.decision_id === 'fresh-after-bound');
  return { ok: gen >= 1 && tombs <= max && !resurrected && freshOk, detail: { gen, tombs, resurrected, freshOk } };
});
// 正本の時計（Date.now／DBのnow）を保持期間の後へ進める。時計はIOとして扱う。
async function withServerClock(db, offsetMs, fn) {
  const realNow = Date.now;
  db.clockMs += offsetMs;
  Date.now = () => realNow() + offsetMs;
  try { return await fn(); } finally { Date.now = realNow; }
}
def('S14', '正本：ACKを失った版無し記録は、削除墓標が保持期間で物理削除された後に再送されても保存しない', async v => {
  const { auth, db } = await loadAuth(v);
  const rec = pastRecord({ decision_id: 'never-acked-then-deleted', recordedAt: iso(Date.now() - DAY) });
  await auth.saveStrategyDecisions({ ...U, decisions: [rec] });       // 正本はcommit、端末はACKを失い版無しのまま
  await auth.deleteStrategyDecision({ ...U, decisionId: rec.decision_id, raceInstanceId: rec.race_instance_id });
  return withServerClock(db, 91 * DAY, async () => {
    await auth.listStrategyDecisions(U);                               // 保持期間の掃除で墓標を物理削除
    const tombPurged = !db.live('user:u1').some(r => r.id === rec.decision_id);
    await auth.saveStrategyDecisions({ ...U, decisions: [rec] });     // 旧端末・旧clientが版無しで再送
    const resurrected = (await listed(auth)).some(r => r.decision_id === rec.decision_id);
    return { ok: tombPurged && !resurrected, detail: { tombPurged, resurrected } };
  });
});
def('S14c', '正本：保持期間後でも、作成されたばかりの版無し新規記録は通常どおり保存される', async v => {
  const { auth, db } = await loadAuth(v);
  return withServerClock(db, 91 * DAY, async () => {
    await auth.saveStrategyDecisions({ ...U, decisions: [pastRecord({ decision_id: 'fresh-after-retention', recordedAt: iso(Date.now()) })] });
    return { ok: (await listed(auth)).some(r => r.decision_id === 'fresh-after-retention'), detail: (await listed(auth)).map(r => r.decision_id) };
  });
}, { control: true });
def('S15', '正本：墓標の保持期限後、作成時刻を未来（+365日）と申告する版無し再送も保存しない', async v => {
  const { auth, db } = await loadAuth(v);
  const rec = pastRecord({ decision_id: 'never-acked-future-clock', recordedAt: iso(Date.now() - DAY) });
  await auth.saveStrategyDecisions({ ...U, decisions: [rec] });
  await auth.deleteStrategyDecision({ ...U, decisionId: rec.decision_id, raceInstanceId: rec.race_instance_id });
  return withServerClock(db, 91 * DAY, async () => {
    await auth.listStrategyDecisions(U);
    const tombPurged = !db.live('user:u1').some(r => r.id === rec.decision_id);
    const future = Object.assign({}, rec, { recordedAt: iso(Date.now() + 365 * DAY) });
    const res = await auth.saveStrategyDecisions({ ...U, decisions: [future] });
    const resurrected = (await listed(auth)).some(r => r.decision_id === rec.decision_id);
    return { ok: tombPurged && !resurrected, detail: { tombPurged, resurrected, status: res && res.results && res.results[0] && res.results[0].status } };
  });
});
def('S15c', '正本：時計ずれ上限（5分）以内の未来の作成時刻・現在時刻の版無し新規は保存される', async v => {
  const { auth, db } = await loadAuth(v);
  return withServerClock(db, 91 * DAY, async () => {
    await auth.saveStrategyDecisions({ ...U, decisions: [
      pastRecord({ decision_id: 'fresh-now', recordedAt: iso(Date.now()) }),
      pastRecord({ decision_id: 'fresh-skew-4min', recordedAt: iso(Date.now() + 4 * 60 * 1000) })] });
    const ids = (await listed(auth)).map(r => r.decision_id);
    return { ok: ids.includes('fresh-now') && ids.includes('fresh-skew-4min'), detail: ids };
  });
}, { control: true });
def('D13', '同期で送るのは作成から保持期間内の記録だけ（墓標の期限後に古い未ACK記録を再送しない）', async v => {
  const ctx = decisionRace(v);
  const old = iso(Date.now() - 91 * DAY);
  ctx.store.pw_decisions = JSON.stringify([pastRecord({ decision_id: 'too-old', recordedAt: old, updatedAt: iso(Date.now()) }),
    pastRecord({ decision_id: 'recent' })]);
  let body = null;
  ctx.fetchImpl = async (url, init) => { if (init && init.method === 'PUT') body = JSON.parse(init.body); return response(200, { ok: true, results: [] }); };
  await ctx.syncDecisionsToServer();
  const ids = body ? body.decisions.map(r => r.decision_id) : [];
  return { ok: ids.includes('recent') && !ids.includes('too-old'), detail: ids };
});
def('I3', '先行する人格メモ保存を待つ間に本人が変わったら、旧会話を新しい本人の認証で送らない', async v => {
  const ctx = makeRenderer(v); login(ctx, 'u1');
  raceSnap(ctx, { race: 'sub:1001' });
  ['A1', 'A2', 'A3', 'A4'].forEach((t, i) => ctx.pushMsg({ role: i % 2 ? 'assistant' : 'user', content: 'U1_' + t }));
  const calls = []; let release1;
  ctx.fetchImpl = (url, init) => {
    calls.push({ auth: init.headers && init.headers.Authorization, body: init.body });
    if (calls.length === 1) return new Promise(r => { release1 = () => r(response(200, { content: [{ text: 'first note' }] })); });
    return Promise.resolve(response(200, { content: [{ text: 'second note' }] }));
  };
  const p1 = ctx.saveMemory({ force: true });
  for (let i = 0; i < 20 && !release1; i++) await sleep(1);
  ctx.pushMsg({ role: 'user', content: 'U1_A5' });
  const p2 = ctx.saveMemory({ force: true });                        // 先行保存の完了を待つ
  await sleep(1);
  login(ctx, 'u2');
  if (release1) release1();
  await p1; await p2;
  const leaked = calls.some(c => c.auth === 'Bearer tok-u2' && String(c.body).includes('U1_'));
  return { ok: !leaked && ctx.profiles.length === 0, detail: { calls: calls.map(c => c.auth), profiles: ctx.profiles.length } };
});

// ── expectations ─────────────────────────────────────────────────────────
// before＝WO017着手前の旧版、packet1＝初回packet（独立反証REVISEの対象）。
const BEFORE_RED = ['C1', 'C2', 'C5', 'C6', 'C7', 'C8', 'I1', 'I2', 'I3', 'D1', 'D11', 'D1u', 'D2', 'D3', 'D4', 'D5', 'D7', 'D7o',
  'D8', 'D9', 'D12', 'D13', 'H2', 'R1', 'M1', 'M2', 'S1', 'S2', 'S4', 'S5', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13'];
const OCT17_RED = ['S14', 'S15'];
const PACKET1_RED = ['C5', 'C7', 'C8', 'I1', 'I2', 'I3', 'D10', 'D11', 'D1u', 'D12', 'D13', 'M1', 'M2', 'S4', 'S5', 'S6b', 'S8', 'S10', 'S13'];
const CUTS = [
  { name: 'K1 scope.differentRace常false', red: ['C1', 'C2', 'C6'], cuts: [{ target: 'scope',
    from: '    if (!a || !b) return false;\n    if (a.race_instance_id !== b.race_instance_id) return true;', to: '    if (!a || !b) return false;\n    if (false) return true;' }] },
  { name: 'K2 LLM会話の本人/race filter除去', red: ['C2', 'C6', 'C7'], cuts: [{ target: 'renderer',
    from: 'filter(m=>S.turnVisible(m&&m._race,memoryRaceScope,owner))', to: 'slice()' }] },
  { name: 'K3 会話箱keyからrace除去', red: ['C1'], cuts: [{ target: 'renderer',
    from: "  return [owner,race,sn,String(lastSessionType||''),String(lastTrack||''),", to: "  return [owner,sn,String(lastSessionType||''),String(lastTrack||''),"}] },
  { name: 'K4 decision find のrace照合除去', red: ['D1', 'D11'], cuts: [{ target: 'dm',
    from: '      && (raceScope === undefined || sameRace(r, raceScope))) || null;', to: ') || null;' }] },
  { name: 'K5 usable の本人照合除去', red: ['D2'], cuts: [{ target: 'dm',
    from: '    if (!want || ownerRefOf(record) !== want) return false;', to: '' }] },
  { name: 'K6 briefing の現race除外除去', red: ['H2'], cuts: [{ target: 'dm',
    from: '!(current && sameRace(r, current))', to: 'true' }] },
  { name: 'K7 merge のtombstone除外除去', red: ['D4'], cuts: [{ target: 'renderer',
    from: '    if(dead.has(k)) continue;\n', to: '' }] },
  { name: 'K8 pull の本人変更検査除去', red: ['D5'], cuts: [{ target: 'renderer',
    from: "    if(localMemoryOwnerRef()!==owner){ diagnosticLog('DECISION_SYNC','pull discarded=owner_changed'); return false; }\n", to: '' }] },
  { name: 'K9 正本更新の版一致条件除去', red: ['S5'], cuts: [{ target: 'auth',
    from: '             AND deleted_at IS NULL AND version=$8', to: '             AND deleted_at IS NULL AND $8::bigint IS NOT NULL' }] },
  { name: 'K9b 版付きPUTが行無しなら挿入へfallback（再挿入禁止を除去）', red: ['S12'], cuts: [{ target: 'auth',
    from: '      if (rows && rows[0]) {',
    to: '      if (base !== null && !(rows && rows[0])) { const ins = await db.query(`INSERT INTO strategy_decisions (owner_key,decision_id,race_key,identity,record,outcome,status,version,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,now(),now()) ON CONFLICT (owner_key,decision_id,race_key) DO NOTHING RETURNING version`, [ownerKey, record.decision_id, raceKey, identity, JSON.stringify(record), record.outcome, record.status]); rows.push(...ins.rows); }\n      if (rows && rows[0]) {' }] },
  { name: 'K23 生きた記録の件数上限が墓標も追い出す', red: ['S11'], cuts: [{ target: 'auth',
    from: '         SELECT decision_id, race_key FROM strategy_decisions WHERE owner_key=$1 AND deleted_at IS NULL\n         ORDER BY updated_at DESC OFFSET $2)`,\n      [ownerKey, DECISION_MAX_PER_OWNER]);',
    to: '         SELECT decision_id, race_key FROM strategy_decisions WHERE owner_key=$1\n         ORDER BY updated_at DESC OFFSET $2)`,\n      [ownerKey, DECISION_MAX_PER_OWNER]);' }] },
  { name: 'K27 正本の版無し記録の過去側（保持期間）検査を除去', red: ['S14'], green: ['S15'], cuts: [{ target: 'auth',
    from: "          : createdAt < now - DECISION_RETENTION_MS ? 'expired'", to: "          : false ? 'expired'" }] },
  { name: 'K28 正本の版無し記録の未来側（時計ずれ上限）検査だけを除去', red: ['S15'], green: ['S14'], cuts: [{ target: 'auth',
    from: "          : createdAt > now + DECISION_CLOCK_SKEW_MS ? 'future_created_at' : null;", to: '          : null;' }] },
  { name: 'K24 墓標上限超過時の世代更新を除去', red: ['S13'], cuts: [{ target: 'auth',
    from: '  if (!(rows && rows[0] && rows[0].n > 0)) return null;', to: '  return null;' }] },
  { name: 'K25 同期送信の作成日保持期間filter除去', red: ['D13'], cuts: [{ target: 'renderer',
    from: '\n      &&Number.isFinite(created(r))&&Date.now()-created(r)<=maxAge);', to: ');' }] },
  { name: 'K26 人格メモ送信直前のbinding照合除去', red: ['I3'], cuts: [{ target: 'renderer',
    from: "      if(memoryBindingKey()!==insightBinding){ diagnosticLog('MEMORY_COMMIT','send skipped=binding_changed'); return false; }\n", to: '' }] },
  { name: 'K10 訂正待ちbinding照合除去', red: ['D7o'], cuts: [{ target: 'renderer',
    from: '  if(p.binding!==memoryBindingKey()){', to: '  if(false){' }] },
  { name: 'K11 push の本人filter除去', red: ['D3'], cuts: [{ target: 'renderer',
    from: '    const store=loadDecisions().filter(r=>r&&m&&m.ownerRefOf(r)===owner\n', to: '    const store=loadDecisions().filter(r=>r&&m\n' }] },
  { name: 'K12 「それ違う」の出所照合を最新記録へ戻す', red: ['D8'], cuts: [{ target: 'renderer',
    from: "  const target=(spoken&&spoken.id)\n    ? store.find(r=>r&&String(r.decision_id)===String(spoken.id)\n        &&String(r.race_instance_id||'')===String(spoken.raceInstanceId||'')&&m.usable(r,identity,now))||null\n    : null;",
    to: "  const _s=m.selectForBriefing(store,identity,now);const target=_s.available?_s.record:null;" }] },
  { name: 'K13 正本の本人lock除去', red: ['S6a'], cuts: [{ target: 'auth',
    from: "    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ownerKey]);\n", to: '' }] },
  { name: 'K14 正本の世代一致検査除去', red: ['S8', 'S10'], cuts: [{ target: 'auth',
    from: '    if (known !== generation) {', to: '    if (false) {' }] },
  { name: 'K15 削除再送の送信直前本人検査除去', red: ['D10'], cuts: [
    { target: 'renderer', from: "    if(localMemoryOwnerRef()!==owner){ diagnosticLog('DECISION_SYNC','delete stopped=owner_changed'); return false; }\n    let ok=false;",
      to: '    let ok=false;' },
    { target: 'renderer', from: "    if(localMemoryOwnerRef()!==owner){ diagnosticLog('DECISION_SYNC','delete stopped=owner_changed'); return false; }\n    if(ok){",
      to: '    if(ok){' },
    { target: 'renderer', from: "  if(!owner||localMemoryOwnerRef()!==owner) throw new Error('owner_changed');", to: '' }] },
  { name: 'K16 結果の発生race→到着時scopeへ戻す', red: ['D11', 'D1u'], cuts: [{ target: 'renderer',
    from: "    const source=(typeof data?.race_instance_id==='string'&&data.race_instance_id)\n      ?{race_instance_id:data.race_instance_id,driver_id:null}:null;",
    to: '    const source=currentMemoryRaceScope();' }] },
  { name: 'K17 記憶検索の同一発生race結合を除去', red: ['M1'], cuts: [{ target: 'brain',
    from: "    const debriefs = matches.filter(x => x.kind === 'debrief' && sameSourceRace(x.row, r));", to: "    const debriefs = matches.filter(x => x.kind === 'debrief');" }] },
  { name: 'K18 人格メモ保存前の本人再検査除去', red: ['I2'], cuts: [{ target: 'renderer',
    from: "    if(localMemoryOwnerRef()!==insightOwner){ diagnosticLog('MEMORY_COMMIT','discarded=owner_changed'); return false; }\n", to: '' }] },
  { name: 'K19 会話turnの本人照合除去', red: ['C7'], cuts: [{ target: 'scope',
    from: "    if (!text(ownerRef) || tag.ownerRef !== ownerRef) return false;\n", to: '' }] },
  { name: 'K20 会話箱のrace別archiveを1枠へ縮める', red: ['C5'], cuts: [{ target: 'renderer',
    from: 'boxes.slice(-CONVO_BOX_SLOTS)', to: 'boxes.slice(-1)' }] },
  { name: 'K21 取得結合の正本版規則をclient優先へ', red: ['D12'], cuts: [{ target: 'renderer',
    from: '    if(!mine||version(r)>version(mine)) byKey.set(k,r);', to: '    if(!mine) byKey.set(k,r);' }] },
  { name: 'K22 記憶検索の本人照合除去', red: ['M2'], cuts: [{ target: 'brain',
    from: "      if (!identity.ownerRef || ownerOf(record) !== String(identity.ownerRef)) return false;", to: '' }] },
];

async function runVariant(v) {
  const result = {};
  for (const c of CASES) {
    try { const r = await c.fn(v); result[c.id] = { ok: !!r.ok, detail: r.detail }; }
    catch (e) { result[c.id] = { ok: false, detail: 'threw: ' + e.message }; }
  }
  return result;
}

// ── actual vertical: real Renderer callAPI -> real server.js -> SDK stub capture ──
const stubPath = path.join(ROOT, 'tests-wo001-anthropic-stream-stub-preload.js');
function spawnServer(port, captureFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-r', stubPath, path.join(ROOT, 'server.js')],
      { cwd: ROOT, env: { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: 'sk-test-local-stub',
        DATABASE_URL: '', JWT_SECRET: '', STRIPE_SECRET_KEY: '', WO014_SYSTEM_CAPTURE_FILE: captureFile } });
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    child.stdout.on('data', d => { if (d.toString().includes('is running')) { clearTimeout(timer); resolve(child); } });
    child.stderr.on('data', () => {});
    child.on('exit', code => { clearTimeout(timer); reject(new Error('server exited early: ' + code)); });
  });
}
async function verticalCallApi(v, port, captureFile) {
  const ctx = makeRenderer(v); login(ctx, 'u1');
  const src = v.src;
  const auxStart = src.indexOf('function _hasUnqualifiedCurrentNumericMention(text,keywordRe){');
  const auxEnd = src.indexOf('\nasync function callAPI', auxStart);
  const extra = ['currentCanonicalStrategyLive', 'buildCurrentRaceContext', 'stripProposalJudgeTag', 'currentPlanReplyDependsOn',
    'addMsg', 'convoLog', 'callAPI'].map(n => grab(src, n));
  if (extra.some(x => !x) || auxStart < 0 || auxEnd < 0) throw new Error('callAPI extraction failed');
  const judgeConst = (src.match(/const PW_JUDGE_TAG_START = [\s\S]*?;/) || [''])[0] + '\n' + (src.match(/const PW_JUDGE_TAG_RE = [\s\S]*?;/) || [''])[0];
  const stub = require(stubPath);
  const spoken = [];
  Object.assign(ctx, {
    fetch: (url, init) => fetch('http://localhost:' + port + url, init),
    TextDecoder, TextEncoder,
    document: { getElementById: () => ({ value: '', style: {}, appendChild() {}, scrollTop: 0, scrollHeight: 0, classList: { add() {}, remove() {}, toggle() {} } }),
      createElement: () => ({ className: '', textContent: '' }) },
    costApiCall() {}, costRecord() {}, mirrorToOverlay() {}, flushSentences() {}, t: k => String(k),
    forwardDriverDamageReport() {}, hydrateLegacyStrategyObjective: () => ({}),
    buildPracticeProfileNote: () => '', buildFuelAuthorityNote: () => '', buildCarTrackMemory: () => '',
    buildWeekendAuthorityNote: () => '', buildCurrentSessionFactNote: () => '', buildSessionEvidenceNote: () => '',
    buildContractNote: () => '', buildActiveRaceFactsNote: () => '', buildMemoryStatusNote: () => '',
    completeMemoryBrainTurn: () => null, buildRaceHistoryContext: () => '',
    buildNamedRivalNote: () => '', hasTelemetryOwnedVehicleClaim: () => false, normalizeLunaSpeech: t => t,
    speak: t => spoken.push(t), applyProposalJudgeTag: () => {}, currentStrategyStateAPI: () => null,
    lastTelemetryAuxRef: null, PitwallRaceContextBuilder: RaceContextBuilder, lastQueuedSpeakItem: null,
    turns: 0, sessionMsgCount: 0, isBusy: false, iracingLive: true, bridgeConnected: true,
    lastTelemetryAt: Date.now(), driverState: 'track', usageBuild: 'test',
    evidenceDebrief: null, responseIntent: null, responseAuthority: 'llm',
    SPEAK_PRIO: { P0_SAFETY: 0, P1_URGENT: 1, P2_PROCEDURE: 2, P3_INFO: 3, P4_INFO: 4 },
    updateNamedRivalFromUser: () => null, lastSectors: () => null, speakReplyChunk: t => spoken.push(t),
    jamesAutoMicEnabled: undefined,
  });
  ctx.__now = Date.now(); ctx.canonicalLifecycleCache = CanonicalCache.create({ now: () => Date.now() });
  ctx.strategyProjection = StrategyProjection.create({ canonical: ctx.canonicalLifecycleCache, now: () => Date.now() });
  vm.runInContext(judgeConst + '\n' + src.slice(auxStart, auxEnd) + '\n' + extra.join('\n') + '\nthis.callAPI=callAPI;', ctx);
  raceSnap(ctx, { race: 'sub:1001' });
  ctx.pushMsg({ role: 'user', content: 'A-Q：ピットはいつ？' });
  ctx.pushMsg({ role: 'assistant', content: 'A-R：12周目にBOX。' });
  raceSnap(ctx, { race: 'sub:2002' });
  ctx.pushMsg({ role: 'user', content: 'B-Q：ここまでの走り、どう思う？ ' + stub.MARKER + Buffer.from(JSON.stringify({ chunks: ['了解。'] })).toString('base64') });
  const before = fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean).length;
  await ctx.callAPI('typed');
  const lines = fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean);
  const cap = lines.length > before ? JSON.parse(lines[lines.length - 1]) : null;
  const sent = cap ? JSON.stringify(cap.messages) : '';
  return { ok: !!cap && sent.includes('B-Q') && !sent.includes('A-Q') && !sent.includes('A-R') && spoken.length > 0,
    detail: { captured: !!cap, sentA: sent.includes('A-Q'), sentB: sent.includes('B-Q'), spoken,
      sentMessages: cap ? cap.messages.length : null, sentMessageChars: cap ? cap.messages.reduce((n, m) => n + String(m.content || '').length, 0) : null,
      systemChars: cap ? String(cap.system || '').length : null } };
}

// --shard i/n：isolated cutをn分割して並行実行する（i=0がafter・旧比較・当日比較・縦断も実行）。
//   既定（指定無し）は全部を1回で実行。分割しても各cut・各caseの中身と期待は同じ。
const shardArg = process.argv.indexOf('--shard');
const [SHARD, SHARDS] = shardArg > 0 ? process.argv[shardArg + 1].split('/').map(Number) : [0, 1];
if (!(Number.isInteger(SHARD) && Number.isInteger(SHARDS) && SHARDS >= 1 && SHARD >= 0 && SHARD < SHARDS)) throw new Error('bad --shard');
(async () => {
  const after = loadVariant(ROOT, [], 'after');
  const primary = SHARD === 0;
  const matrix = { shard: SHARD + '/' + SHARDS, after: null, before: null, packet1: null, oct17: null, cuts: {} };
  const hasBefore = fs.existsSync(path.join(BEFORE, 'desktop/renderer.html'));
  const hasPacket1 = fs.existsSync(path.join(PACKET1, 'desktop/renderer.html'))
    && Object.entries(PACKET1_SHA).every(([f, h]) => sha(path.join(PACKET1, f)) === h);
  if (primary) {
  console.log('\n══ after（現在のtree）：全case GREEN ══');
    const afterRes = await runVariant(after);
  for (const c of CASES) check(c.id + ' ' + c.title, afterRes[c.id].ok, afterRes[c.id].detail);
  matrix.after = afterRes;
  const compare = (label, res, reds) => {
    for (const c of CASES) {
      if (c.control) check(label + ' control ' + c.id + ' GREEN', res[c.id].ok, res[c.id].detail);
      else if (reds.includes(c.id)) check(label + ' ' + c.id + ' RED（欠陥を再現）', !res[c.id].ok, res[c.id].detail);
    }
  };
  const unavailable = label => { console.log('\n══ ' + label + '：比較不能（保全物が無い／SHA不一致）。PASSには数えない ══'); return 'unavailable'; };
  if (hasBefore) {
    console.log('\n══ before（WO017着手前の保全tree）：同じfixtureで旧版の赤を再現 ══');
    matrix.before = await runVariant(loadVariant(BEFORE, [], 'before'));
    compare('before', matrix.before, BEFORE_RED);
  } else matrix.before = unavailable('before（着手前551 baseline ' + BEFORE + '）');
  if (hasPacket1) {
    console.log('\n══ packet1（初回packet・独立反証の対象、SHA一致を確認済み）：独立反証の赤を再現 ══');
    matrix.packet1 = await runVariant(loadVariant(PACKET1, [], 'packet1'));
    compare('packet1', matrix.packet1, PACKET1_RED);
  } else matrix.packet1 = unavailable('packet1（' + PACKET1 + '、renderer 2c38490…／auth 11fd753…）');
  const hasOct17 = fs.existsSync(path.join(OCT17, 'desktop/renderer.html'))
    && Object.entries(OCT17_SHA).every(([f, h]) => sha(path.join(OCT17, f)) === h);
  if (hasOct17) {
    console.log('\n══ oct17（10/17再開時の停止tree、SHA一致）：保持期限の残欠陥の赤を再現、既修復は緑のまま ══');
    matrix.oct17 = await runVariant(loadVariant(OCT17, [], 'oct17'));
    compare('oct17', matrix.oct17, OCT17_RED);
    for (const c of CASES) if (!c.control && !OCT17_RED.includes(c.id)) check('oct17 既修復 ' + c.id + ' GREEN', matrix.oct17[c.id].ok, matrix.oct17[c.id].detail);
  } else matrix.oct17 = unavailable('oct17（' + OCT17 + '）');
  }

  console.log('\n══ isolated cut（shard ' + SHARD + '/' + SHARDS + '）：境界guardを1つ外すと、そのguardのcaseだけRED（controlはGREEN） ══');
  for (const [ki, k] of CUTS.entries()) {
    if (ki % SHARDS !== SHARD) continue;
    const res = await runVariant(loadVariant(ROOT, k.cuts, k.name));
    matrix.cuts[k.name] = res;
    for (const id of k.red) check(k.name + ' → ' + id + ' RED', !res[id].ok, res[id].detail);
    // 片側だけを外したcutで、もう片側のguardが守るcaseは緑のまま（guardの独立性）
    for (const id of (k.green || [])) check(k.name + ' → ' + id + ' GREEN（別guardは維持）', res[id].ok, res[id].detail);
    for (const c of CASES.filter(x => x.control)) check(k.name + ' control ' + c.id + ' GREEN', res[c.id].ok, res[c.id].detail);
  }

  if (primary) {
  console.log('\n══ 縦断：実Renderer callAPI → 実server.js → SDK stub capture（送信messages） ══');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo017-vertical-'));
  const captureFile = path.join(tmp, 'capture.jsonl'); fs.writeFileSync(captureFile, '');
  const port = 39000 + Math.floor(Math.random() * 2000);
  let child = null;
  try {
    child = await spawnServer(port, captureFile);
    const va = await verticalCallApi(after, port, captureFile);
    check('after: race Bの実送信messagesにrace Aのturnが無く、B-Qが届き、返答を発話', va.ok, va.detail);
    matrix.vertical = { after: va };
    if (hasBefore) {
      const vb = await verticalCallApi(loadVariant(BEFORE, [], 'before'), port, captureFile);
      check('before: 同じ縦断でrace Aのturnが実送信messagesへ混入（旧版RED）', !vb.ok && vb.detail.sentA, vb.detail);
      matrix.vertical.before = vb;
    }
    const vc = await verticalCallApi(loadVariant(ROOT, CUTS[1].cuts, 'cutK2'), port, captureFile);
    check('cut K2: 同じ縦断でrace Aのturnが混入（RED）', !vc.ok && vc.detail.sentA, vc.detail);
  } finally { if (child) child.kill(); }
  }

  const outArg = process.argv.indexOf('--matrix-out');
  const matrixOut = process.env.WO017_MATRIX_OUT || (outArg > 0 ? process.argv[outArg + 1] : null);
  if (matrixOut) fs.writeFileSync(matrixOut, JSON.stringify(matrix, null, 2));
  console.log('\nWO017 race memory boundary: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
