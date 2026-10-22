#!/usr/bin/env node
'use strict';
// WO018：Plan結果・penalty・Driver訂正を、同じ本人／race／decision／pit identityでdebriefへ。
//
// 入力は実Bridge producer（irsdk-bridge/tests_wo018_debrief_outcomes.py --emit：実poll replayが
// broadcastしたsession_summaryとcanonical snapshot）。Desktop側はRendererの実関数原文と実module
// （debrief-outcome / decision-memory / race-memory-scope / memory-action-layer）をVMへ載せ、
// DOM・localStorage・音声・usage等のIOだけをstubにする。製品判断をtest内で再実装しない。
//
//   node tests-wo018-debrief-outcome.js            after全case＋before比較＋guard cut
//   WO018_BEFORE_ROOT=<dir>                         着手前tree（既定 /tmp/wo018-before-files）
//   WO018_MATRIX=<path>                             結果JSON（既定 /tmp/wo018-matrix.json）
//
// 製品有料API・実STT/TTS/LLM 0。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const AFTER = __dirname;
const BEFORE = process.env.WO018_BEFORE_ROOT || '/tmp/wo018-before-files';
const MATRIX = process.env.WO018_MATRIX || '/tmp/wo018-matrix.json';
const PRODUCER = path.join(AFTER, 'irsdk-bridge', 'tests_wo018_debrief_outcomes.py');

// ── 実Bridge producer ─────────────────────────────────────────────
const produced = {};
function produce(root, scenario) {
  const key = root + '|' + scenario;
  if (produced[key]) return produced[key];
  const r = spawnSync('python3', [PRODUCER, '--emit', scenario], {
    cwd: path.join(AFTER, 'irsdk-bridge'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: Object.assign({}, process.env, { WO018_BRIDGE_ROOT: path.join(root, 'irsdk-bridge') }),
  });
  if (r.status !== 0) throw new Error('producer failed ' + key + '\n' + (r.stderr || '').slice(-2000));
  const out = JSON.parse(r.stdout);
  if (!out.summaries || out.summaries.length !== 1) throw new Error('expected one session_summary from ' + key);
  produced[key] = out;
  return out;
}

// ── Renderer実関数の抽出 ─────────────────────────────────────────
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
const FNS = ['memoryTrackCandidates', 'validFinishPosition', 'sanitizeSessionEvidence', 'fmtLap', 'isJapaneseEngineer', 'evidenceLanguage',
  'evidenceCopy', 'evidenceLines', 'pickRotatingQuestion', 'loadDebriefFollowupHistory', 'rememberDebriefFollowup',
  'sanitizeOwnFollowupQuestion', 'buildMemoryAwareDebriefFollowup', 'buildEvidenceQuestions', 'beginEvidenceDebrief',
  'reconcileEvidenceSummary', 'askEvidenceQuestion', 'parseExplicitLapTime', 'applyEvidenceCorrection',
  'isEvidenceAnswerCandidate', 'recordEvidenceAnswer', 'restartEvidenceDebrief', 'dismissEvidenceDebrief',
  'loadEvidenceRecords', 'evidenceReviewId', 'buildEvidenceRecord', 'upsertEvidenceRecord', 'autoSaveEvidenceMemory',
  'discardEvidenceMemory', 'buildCurrentSessionFactNote', 'buildSessionEvidenceNote', 'currentMemoryIdentity',
  'currentMemoryUserId', 'localMemoryOwnerRef', 'currentMemoryRaceScope', 'decisionModule', 'loadDecisions',
  'saveDecisions', 'currentDecisionIdentity', 'decisionRaceScopeOf', 'knownOwnerGeneration',
  'syncCanonicalDecisionHistory', 'buildFallbackSessionSummary',
  // WO018で追加（着手前treeには無い＝before worldでは欠落のまま動かす）
  'currentDebriefSourceIdentity', 'debriefSummaryAdmissible', 'debriefOutcomeModule', 'debriefOutcomeLines',
  'decisionCorrectionsFor', 'refreshDebriefOutcome', 'outcomeFirstQuestion', 'applyOutcomeCorrection',
  'updateDebriefEvidencePanel', 'debriefOutcomeContext',
  // REVISE1：実listener・本人/race binding・判断台帳の実操作・MemoryBrain次request
  'evidenceReviewBound', 'handleSessionSummaryMessage', 'noteMemoryRaceScope', 'confirmEvidenceMemory',
  'saveSessionSummary', 'loadRaceHistory', 'recordDecisionStage', 'scheduleAutoDebrief', 'loadDecisionTombstones',
  'saveDecisionTombstones', 'deleteDecision', 'decisionSyncEnabled', 'memoryBindingKey', 'prepareMemoryBrain',
  'currentMemoryBrainPrompt', 'loadMemoryBrainEvaluations', 'buildWeekendAuthorityNote', 'ownedSessionSummary'];
const DECLS = [/const memoryRaceScope=[\s\S]*?:null;/, /const EVIDENCE_COPY=\{[\s\S]*?\n\};/,
  /const DEBRIEF_QUESTION_HISTORY_KEY=.*;/, /const DEBRIEF_FOLLOWUP_HISTORY_KEY=.*;/,
  /const PRODUCT_FEEDBACK_CADENCE_KEY=.*;/, /const DECISION_STORE_KEY=.*;/, /const DECISION_OWNER_GEN_KEY=.*;/,
  /const SPEAK_PRIO = .*;/, /const DECISION_TOMBSTONE_KEY=.*;/, /const DECISION_SYNC_OPTIN_KEY=.*;/,
  /const MEMORY_BRAIN_EVALUATIONS_KEY=.*;/];
const MODULES = [['race-memory-scope.js', 'PitwallRaceMemoryScope'], ['decision-memory.js', 'PitwallDecisionMemory'],
  ['memory-action-layer.js', 'PitwallMemoryActionLayer'], ['debrief-outcome.js', 'PitwallDebriefOutcome'],
  ['memory-brain.js', 'PitwallMemoryBrain']];

function makeWorld(root, cut) {
  let renderer = fs.readFileSync(path.join(root, 'desktop', 'renderer.html'), 'utf8');
  const modules = {};
  for (const [file] of MODULES) {
    const p = path.join(root, 'desktop', file);
    modules[file] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  if (cut) {
    const target = cut.file === 'renderer' ? renderer : modules[cut.file];
    if (!target || !target.includes(cut.from)) throw new Error('cut anchor missing: ' + cut.id);
    if (cut.file === 'renderer') renderer = renderer.replace(cut.from, cut.to);
    else modules[cut.file] = modules[cut.file].replace(cut.from, cut.to);
  }
  const store = new Map();
  const elements = {};
  const el = id => (elements[id] = elements[id] || { id, textContent: '', style: {}, dataset: {}, appendChild() {}, set onclick(v) {} });
  const log = { msgs: [], spoken: [], diag: [], timers: [] };
  const ctx = {
    console, JSON, Date, Math, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error, Promise,
    crypto: require('crypto').webcrypto,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    document: { getElementById: el, createElement: () => ({ style: {}, appendChild() {} }), querySelectorAll: () => [] },
    addMsg: (role, text) => log.msgs.push([role, String(text)]), pushMsg: () => {},
    speak: text => log.spoken.push(String(text)), usageCount: () => {}, switchMode: () => {},
    diagnosticLog: (tag, text) => log.diag.push([tag, String(text)]),
    saveStrategyObjectiveFromDebrief: () => null, currentStrategyStateAPI: () => null, ensureStrategyState: () => null,
    strategyProjection: { trace: () => null }, canonicalLifecycleCache: { current: () => ctx.__snap || null },
    __snap: null,
    // 対象外IO：server同期・team学習・自由会話保存・practice/qualify任意カード（呼ばれた事実だけ記録）
    syncDecisionsToServer: () => { log.diag.push(['IO', 'syncDecisionsToServer']); },
    persistTeamRaceLearning: () => {}, saveMemory: () => Promise.resolve(false),
    handlePracticeSessionSummary: d => log.diag.push(['IO', 'practice_summary']),
    offerSessionReview: d => log.diag.push(['IO', 'offer_review']),
    setTimeout: (fn) => { log.timers.push(fn); return log.timers.length; }, clearTimeout: () => {},
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const [file, name] of MODULES) {
    if (!modules[file]) continue;
    vm.runInContext(modules[file], ctx, { filename: file });
    if (!ctx[name]) throw new Error('module did not register ' + name);
  }
  const decls = DECLS.map(re => (renderer.match(re) || [''])[0]).filter(Boolean);
  const present = [], missing = [];
  const fns = FNS.map(n => { const c = grab(renderer, n); (c ? present : missing).push(n); return c || ''; });
  // 実request：sendMsgはprepareMemoryBrain(text)の後にcallAPIを呼び、callAPIはprofileNote文で全memory blockを
  //   連結してserverへ送る。そのprofileNote文の実原文をcallAPIから抜いて評価する。
  {
    const call = grab(renderer, 'callAPI');
    const st = call && call.match(/const profileNote = [\s\S]*?;\n/);
    if (st) fns.push('function __requestMemory(question){ prepareMemoryBrain(question);\n'
      + "const profile=null,memoryStatus='';const _isJP_pre=(sel==='Kanbe'||sel==='Oishi'||sel==='HajimeJP'||sel==='LunaJP');\n"
      + st[0] + 'return profileNote; }');
  }
  // 着手前treeのsession_summary listenerはWS onmessage内のinline block。その実原文を関数として載せる。
  if (missing.includes('handleSessionSummaryMessage')) {
    const m = renderer.match(/if\(data\.type==='session_summary'\)\{([\s\S]*?)\n      \}\n/);
    if (m) fns.push('function handleSessionSummaryMessage(data){' + m[1] + '\n}');
  }
  const prelude = `var sel='LunaJP',userName='Yuji',lastTrackId='',lastTrack='Road Atlanta',lastCarModel='Porsche 911 GT3 R (992)',
    lastCarClass='GT3',lastSessionType='Race',lastSessionNum=0,sessionPurpose='race',selMode='debrief',usageSessionId='u1',
    usageBuild='t',isSpeaking=false,speakQueue=[],lastTelemetry=null,lastSessionAuthority=null,sessionBestLapSeconds=null,
    sessionBestLapStr='',evidenceDebrief=null,autoDebriefData=null,autoDebriefStarted=false,autoDebriefTimer=null,
    lastSessionSummary=null,canonicalHistoryPending=new Map(),lastIrating=null,lastSr=null,_convoBox=null,
    lastMemoryUtterance=null,pendingDecisionDispute=null,activeMemoryBrainTurn=null,lastSessionSummaryOwner=null,
    lastWeekendAuthority=null;
    // 実callAPIのprofileNote文が呼ぶ非対象builder（profile・燃料・契約・live facts・保存状態）はIO扱いで空。
    function buildProfileNote(){return '';} function buildCarTrackMemory(){return '';} function buildPracticeProfileNote(){return '';}
    function buildFuelAuthorityNote(){return '';} function buildContractNote(){return '';} function buildActiveRaceFactsNote(){return '';}
    function buildMemoryStatusNote(){return '';}`;
  vm.runInContext(prelude + '\n' + decls.join('\n') + '\nvar __memoryRaceScope=memoryRaceScope;\n' + fns.join('\n'), ctx, { filename: 'renderer-extract.js' });
  const world = {
    ctx, log, store, root, present, missing,
    panel: () => el('debrief-guide-evidence').textContent,
    setOwner: id => store.set('pw_auth_user', JSON.stringify({ id })),
    // race変更は実noteMemoryRaceScope（canonical受信の唯一の入口）を通す
    observeRace: (race, driver) => {
      // Model the canonical telemetry receiver as well as its scope observer.
      // The production saver may attach the current account only when the
      // arriving summary actually matches this current telemetry scope.
      ctx.lastTelemetry={race_instance_id:race,session_num:0,cust_id:driver||10101};
      const snap = { race_instance_id: race, continuity: { stable_scope: { race_instance_id: race, driver_id: driver || 10101 } } };
      return ctx.noteMemoryRaceScope ? ctx.noteMemoryRaceScope(snap) : ctx.__memoryRaceScope.observe(snap);
    },
    records: () => JSON.parse(store.get('pw_session_evidence') || '[]'),
    has: n => present.includes(n),
  };
  world.setOwner(7);
  return world;
}

// ── 入力（実producer出力と、そこから作る反証variant） ─────────────────
const clone = v => JSON.parse(JSON.stringify(v));
function summaryOf(root, scenario) { return clone(produce(root, scenario).summaries[0]); }
function otherRace(s, race) {
  const o = clone(s); o.race_instance_id = race;
  (o.pit_events || []).forEach(p => { p.race_instance_id = race; });
  ((o.plan_outcomes || {}).records || []).forEach(r => { r.race_instance_id = race; });
  return o;
}
function startDebrief(w, s) {
  // 現在sessionの車・コースはBridgeのsession_infoと同じ（実producerのsummaryから取る）
  if (s.track) { w.ctx.lastTrack = s.track_display || s.track; w.ctx.lastTrackId = s.track; }
  if (s.car_model) w.ctx.lastCarModel = s.car_model;
  if (s.car_class) w.ctx.lastCarClass = s.car_class;
  w.observeRace(s.race_instance_id);
  w.ctx.lastSessionSummary = w.ctx.sanitizeSessionEvidence(s);
  // 実listenerと同じく、受け入れた時の本人を記録する
  w.ctx.lastSessionSummaryOwner = w.ctx.localMemoryOwnerRef();
  w.ctx.beginEvidenceDebrief(s);
}
const firstQ = w => (w.log.msgs.find(m => m[0] === 'ai') || [null, ''])[1];
function answerAll(w, text) {
  let guard = 0;
  while (w.ctx.evidenceDebrief && w.ctx.evidenceDebrief.active && guard++ < 6) {
    w.ctx.evidenceDebrief.acceptAfter = 0;
    w.ctx.recordEvidenceAnswer(text);
  }
}
const ok = (pass, detail) => ({ pass: !!pass, detail });
// WO-019: the original red thread (16.79 L at L15) needs no further stop, so it no longer
// carries the stale "recalculated" Plan A that the L16 penalty used to invalidate. Every
// case that exercises a penalty-invalidated post-stop Plan (debrief panel/question,
// correction, save, next-race reference, ledger, MemoryBrain) now reads the synthetic
// short-fuel variant (2.0 L at L15 -> fresh post-stop Plan -> L16 penalty). The original
// red thread keeps its own no-stop cases (C00a/C00b). No assertion was removed or weakened.
const PENALTY_PLAN_SCN = 'short_fuel_penalty';
// The pre-WO018 Bridge tree (/tmp/wo018-before-files) is no longer available; the legacy
// shape it produced (pit_events without plan_outcomes) is reproduced from the current
// producer output by omitting that one field. Recorded as a fixture limit.
function legacySummaryWithoutPlanOutcomes(root) {
  const s = summaryOf(root, PENALTY_PLAN_SCN); delete s.plan_outcomes; return s;
}

// WO-020 P0: the opening Plan A lap is the producer's authority-aligned target (Python WO018
// binds it to the Bridge's OPENING TARGET ALIGNED trace); never a constant here.
function openingLap(s) {
  const e = ((s.plan_outcomes && s.plan_outcomes.records) || []).find(r => r.reason === 'driver_early_pit');
  return e && Number.isInteger(e.target_lap) ? e.target_lap : NaN;
}

// ── Cases（観測できる出力だけで判定。before treeでも同じ判定を走らせる） ──
const CASES = {
  C00a_red_thread_no_stop_penalty_fact_only: { run: root => {
    const s = summaryOf(root, 'red_thread');
    const recs = (s.plan_outcomes && s.plan_outcomes.records) || [];
    const pits = Object.fromEntries((s.pit_events || []).map(p => [p.pit_event_id, p]));
    const early = recs.find(r => r.reason === 'driver_early_pit');
    const pen = (s.pit_events || []).find(p => p.execution_relation === 'penalty');
    return ok(early && pits[early.terminal_pit_event_id] && pits[early.terminal_pit_event_id].entry_lap === 15
      && !recs.some(r => r.reason === 'penalty_pit') && !recs.some(r => r.registered_driver_pit_sequence === 1)
      && pen && pen.entry_lap === 16 && pen.plan_reference == null,
    { reasons: recs.map(r => r.reason), pen: pen && pen.entry_lap });
  } },
  C00b_red_thread_debrief_panel_and_question: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, 'red_thread');
    startDebrief(w, s);
    const panel = w.panel(), q = firstQ(w);
    const L = openingLap(s);
    return ok(panel.includes(`Pit 1 · 15周目 · 早めのピット（予定Plan Aは${L}周目）`) && /Pit 2 · 16周目 · ペナルティ/.test(panel)
      && panel.includes(`Plan A（${L}周目） → 失効：早めのピット (Pit 1)`) && !/Pit 1後に再計算/.test(panel)
      && /16周目の停止はペナルティだった/.test(q), { panel, question: q });
  } },
  C01_producer_plan_outcomes: { red_before: true, run: root => {
    const s = summaryOf(root, PENALTY_PLAN_SCN);
    const recs = (s.plan_outcomes && s.plan_outcomes.records) || [];
    const pits = Object.fromEntries((s.pit_events || []).map(p => [p.pit_event_id, p]));
    const early = recs.find(r => r.reason === 'driver_early_pit'), pen = recs.find(r => r.reason === 'penalty_pit');
    return ok(early && pen && pits[early.terminal_pit_event_id] && pits[early.terminal_pit_event_id].entry_lap === 15
      && pits[pen.terminal_pit_event_id].execution_relation === 'penalty'
      && recs.every(r => r.race_instance_id === s.race_instance_id && r.session_num === s.session_num),
    { has_plan_outcomes: !!s.plan_outcomes, reasons: recs.map(r => r.reason) });
  } },
  C02_debrief_panel_and_question: { red_before: true, run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s);
    const panel = w.panel(), q = firstQ(w);
    const L = openingLap(s);
    return ok(panel.includes(`Pit 1 · 15周目 · 早めのピット（予定Plan Aは${L}周目）`)
      && /Pit 2 · 16周目 · ペナルティ/.test(panel)
      && panel.includes(`Plan A（${L}周目） → 失効：早めのピット (Pit 1)`)
      && /Plan A（21周目）［Pit 1後に再計算］ → 失効：ペナルティピット \(Pit 2\)/.test(panel)
      && /16周目の停止はペナルティだった/.test(q) && !/予定どおり、前倒し/.test(q), { panel, question: q });
  } },
  C03_llm_debrief_context: { red_before: true, run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s);
    const note = w.ctx.buildCurrentSessionFactNote(true);
    return ok(/ペナルティ/.test(note) && /失効：早めのピット/.test(note) && /再計算/.test(note), { note: note.slice(0, 900), chars: note.length });
  } },
  C04_driver_correction_kept_beside_canonical: { red_before: true, run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0;
    const r = w.ctx.recordEvidenceAnswer('16周目はペナルティじゃないよ');
    const d = w.ctx.evidenceDebrief;
    const pit2 = d.outcome && d.outcome.pits.find(p => p.entry_lap === 16);
    return ok(r === 'correction' && d.index === 0 && d.answers.length === 0 && (d.outcomeCorrections || []).length === 1
      && pit2 && pit2.relation === 'penalty' && /Driver訂正：ペナルティではない（Bridge記録は維持）/.test(w.panel()),
    { result: r, index: d.index, answers: d.answers, panel: w.panel() });
  } },
  C05_ambiguous_correction_not_saved: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    s.pit_events[0].execution_relation = 'penalty';            // 2件ともpenaltyのvariant（曖昧性の反証入力）
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0;
    const r1 = w.ctx.recordEvidenceAnswer('ペナルティじゃない');
    const n1 = (w.ctx.evidenceDebrief.outcomeCorrections || []).length;
    const r2 = w.ctx.recordEvidenceAnswer('16周目はペナルティじゃない');
    const c = w.ctx.evidenceDebrief.outcomeCorrections || [];
    return ok(r1 === 'correction_ambiguous' && n1 === 0 && r2 === 'correction' && c.length === 1 && c[0].entry_lap === 16, { r1, n1, r2, c });
  } },
  C06_withdraw_correction: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0;
    w.ctx.recordEvidenceAnswer('16周目はペナルティじゃないよ');
    const r = w.ctx.recordEvidenceAnswer('さっきの訂正取り消し');
    return ok(r === 'correction_withdrawn' && w.ctx.evidenceDebrief.outcomeCorrections.length === 0 && !/Driver訂正/.test(w.panel()), { r });
  } },
  C07_save_readback: { red_before: true, run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0;
    w.ctx.recordEvidenceAnswer('16周目はペナルティじゃないよ');
    answerAll(w, '前の車に引っかかって焦った');
    const rec = w.records()[0] || {};
    const back = w.ctx.PitwallDebriefOutcome ? w.ctx.PitwallDebriefOutcome.revalidate(rec.race_outcome) : null;
    return ok(rec.owner_ref && rec.race_instance_id === s.race_instance_id && rec.session_num === s.session_num
      && back && back.plans.some(p => p.reason === 'penalty_pit' && p.pit_event_id)
      && back.pits.map(p => p.relation).join() === 'early,penalty'
      && (rec.outcome_corrections || []).length === 1 && rec.outcome_corrections[0].driver_claim === 'not_penalty',
    { keys: Object.keys(rec), corrections: rec.outcome_corrections });
  } },
  C08_next_race_reference: { red_before: true, run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0;
    w.ctx.recordEvidenceAnswer('16周目はペナルティじゃないよ');
    answerAll(w, '前の車に引っかかって焦った');
    w.ctx.evidenceDebrief = null; w.observeRace('sub:next-race');
    const note = w.ctx.buildSessionEvidenceNote();
    return ok(/Bridge確定のPlan結果・ピット分類: .*ペナルティ.*Driver訂正：ペナルティではない/.test(note)
      && /失効：早めのピット/.test(note), { note: note.slice(0, 1200), chars: note.length });
  } },
  C09_same_race_not_previous: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0; answerAll(w, '前の車に引っかかって焦った');
    w.ctx.evidenceDebrief = null;                              // 同じraceのまま
    const note = w.ctx.buildSessionEvidenceNote();
    return ok(note.length > 0 && !/Bridge確定のPlan結果/.test(note), { note: note.slice(0, 400) });
  } },
  C10_other_owner_same_name: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0; answerAll(w, '前の車に引っかかって焦った');
    w.ctx.evidenceDebrief = null; w.observeRace('sub:next-race');
    // 本人の無い旧形式copy（owner_ref欠落）を、今の本人の記録として黙って結び付けない
    const rows = w.records(); delete rows[0].owner_ref; w.store.set('pw_session_evidence', JSON.stringify(rows));
    const legacy = w.ctx.buildSessionEvidenceNote();
    return ok(!/Bridge確定のPlan結果/.test(legacy), { note: legacy.slice(0, 400) });
  } },
  C11_delete_removes_reference: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0; answerAll(w, '前の車に引っかかって焦った');
    w.ctx.discardEvidenceMemory();
    w.observeRace('sub:next-race');
    return ok(w.records().length === 0 && !/Bridge確定のPlan結果/.test(w.ctx.buildSessionEvidenceNote()), {});
  } },
  C12_expired_not_referenced: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0; answerAll(w, '前の車に引っかかって焦った');
    const rows = w.records(); rows[0].created_at = new Date(Date.now() - 91 * 86400000).toISOString();
    w.store.set('pw_session_evidence', JSON.stringify(rows));
    w.ctx.evidenceDebrief = null; w.observeRace('sub:next-race');
    return ok(!/Bridge確定のPlan結果/.test(w.ctx.buildSessionEvidenceNote()), {});
  } },
  C13_late_other_race_summary_rejected: { red_before: true, run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s);
    const late = otherRace(s, s.race_instance_id);                 // 同race_instance・別sessionのsummaryが後着
    late.session_num = s.session_num + 1; late.pit_events.forEach(p => { p.session_num = late.session_num; });
    late.plan_outcomes.records.forEach(r => { r.session_num = late.session_num; });
    w.ctx.reconcileEvidenceSummary(late);
    const d = w.ctx.evidenceDebrief.data;
    return ok(d.session_num === s.session_num && (!w.ctx.autoDebriefData || w.ctx.autoDebriefData.session_num === s.session_num),
      { now: d.session_num });
  } },
  C14_owner_switch_mid_debrief_not_saved: { red_before: true, run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.answers = ['前の車に引っかかって焦った'];
    w.setOwner(8);
    const saved = w.ctx.autoSaveEvidenceMemory();                  // 保存caller自身の本人照合（前段の回答guardを経ない）
    return ok(!saved && w.records().length === 0, { saved: w.records().map(r => r.owner_ref) });
  } },
  C15_identity_missing_fails_closed: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    delete s.race_instance_id;
    w.ctx.lastSessionSummary = s; w.ctx.beginEvidenceDebrief(s);
    return ok(!/Pit 1 ·/.test(w.panel()) && !/Plan A（/.test(w.panel()) && !/ペナルティだった/.test(firstQ(w)),
      { panel: w.panel(), q: firstQ(w) });
  } },
  C15b_legacy_bridge_without_plan_outcomes: { run: root => {
    const w = makeWorld(root); const s = legacySummaryWithoutPlanOutcomes(root);   // 旧Bridge形（plan_outcomes欠落）
    startDebrief(w, s);
    return ok(/Pit 2 · 16周目 · ペナルティ/.test(w.panel()) && /Plan結果：Bridge記録なし（推測しない）/.test(w.panel())
      && !/→ 失効/.test(w.panel()), { panel: w.panel() });
  } },
  C16_foreign_race_pit_and_plan_rejected: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    const foreign = clone(s.pit_events[1]);
    Object.assign(foreign, { pit_event_id: 'foreign-pit', race_instance_id: 'sub:foreign', entry_lap: 3, driver_pit_sequence: 3 });
    s.pit_events.push(foreign);
    const fp = clone(s.plan_outcomes.records[1]); Object.assign(fp, { decision_id: 'foreign-plan', session_num: 9, target_lap: 3 });
    s.plan_outcomes.records.push(fp);
    startDebrief(w, s);
    const o = w.ctx.evidenceDebrief.outcome;
    return ok(!/3周目/.test(w.panel()) && !/Plan A（3周目）/.test(w.panel()) && o && o.rejected.pits === 1 && o.rejected.plans === 1,
      { panel: w.panel(), rejected: o && o.rejected });
  } },
  C16b_plan_pit_link_requires_same_relation: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    const early = s.plan_outcomes.records.find(r => r.reason === 'driver_early_pit');
    early.terminal_pit_event_id = s.pit_events[1].pit_event_id;     // relation不一致のpitを指すvariant
    s.pit_events[1].plan_reference = Object.assign({}, s.pit_events[1].plan_reference, { decision_id: early.decision_id }); // decision参照は一致させrelationだけ違える
    startDebrief(w, s);
    return ok(new RegExp(`Plan A（${early.target_lap}周目） → 失効：早めのピット(?! \\(Pit)`).test(w.panel()) && Number.isInteger(early.target_lap), { panel: w.panel() });
  } },
  C17_unknown_black_flag_not_penalty: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, 'unknown_flags');
    startDebrief(w, s);
    return ok(/Pit 2 · 16周目 · 分類不明/.test(w.panel()) && !/ペナルティ/.test(w.panel()) && !/ペナルティ/.test(firstQ(w))
      && /早く入った/.test(firstQ(w)), { panel: w.panel(), q: firstQ(w) });
  } },
  C18_duplicate_summary_idempotent: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0;
    w.ctx.recordEvidenceAnswer('16周目はペナルティじゃないよ');
    w.ctx.reconcileEvidenceSummary(clone(s));
    return ok(w.ctx.evidenceDebrief.outcomeCorrections.length === 1 && /Driver訂正/.test(w.panel()), {});
  } },
  C19_decision_ledger_keeps_invalidated_reason: { red_before: true, run: root => {
    const w = makeWorld(root); const out = produce(root, PENALTY_PLAN_SCN);
    w.ctx.__snap = clone(out.last_snapshot);
    w.observeRace(out.last_snapshot.race_instance_id);
    w.ctx.syncCanonicalDecisionHistory();
    const rows = w.ctx.loadDecisions();
    const reasons = rows.map(r => r.canonical_lifecycle && r.canonical_lifecycle.invalidated_reason);
    return ok(reasons.includes('driver_early_pit') && reasons.includes('penalty_pit'), { reasons, n: rows.length });
  } },
  C20_decision_dispute_shown_same_owner_only: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    const early = s.plan_outcomes.records.find(r => r.reason === 'driver_early_pit');
    const owner = w.ctx.localMemoryOwnerRef();
    const row = { decision_id: early.decision_id, race_instance_id: s.race_instance_id, owner_ref: owner, status: 'disputed' };
    const pen = s.plan_outcomes.records.find(r => r.reason === 'penalty_pit');
    const other = { decision_id: pen.decision_id, race_instance_id: s.race_instance_id, owner_ref: 'user:8', status: 'disputed' };
    w.store.set('pw_decisions', JSON.stringify([row, other]));
    startDebrief(w, s);
    const p = w.panel();
    return ok(/失効：早めのピット \(Pit 1\) ／ Driver訂正：この判断記録は保留中/.test(p)
      && !/ペナルティピット \(Pit 2\) ／ Driver訂正/.test(p), { panel: p });
  } },
  C21_restart_keeps_corrections: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0;
    w.ctx.recordEvidenceAnswer('16周目はペナルティじゃないよ');
    w.ctx.restartEvidenceDebrief();
    return ok(w.ctx.evidenceDebrief.outcomeCorrections.length === 1, {});
  } },
  C22_normal_control: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, 'normal');
    startDebrief(w, s);
    return ok(/· 予定どおり/.test(w.panel()) && /→ 実行 \(Pit 1\)/.test(w.panel()) && /予定どおり実行できた/.test(firstQ(w)),
      { panel: w.panel(), q: firstQ(w) });
  } },
  C23_foreign_correction_not_carried: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0; answerAll(w, '前の車に引っかかって焦った');
    const rows = w.records();
    rows[0].outcome_corrections = [{ kind: 'pit_relation', race_instance_id: 'sub:other', session_num: s.session_num,
      pit_event_id: s.pit_events[1].pit_event_id, entry_lap: 16, canonical_relation: 'penalty', driver_claim: 'not_penalty',
      status: 'driver_disputed', note: 'x', at: new Date().toISOString() }];
    w.store.set('pw_session_evidence', JSON.stringify(rows));
    w.ctx.evidenceDebrief = null; w.observeRace('sub:next-race');
    const note = w.ctx.buildSessionEvidenceNote();
    return ok(/Bridge確定のPlan結果/.test(note) && !/Driver訂正/.test(note), { note: note.slice(0, 600) });
  } },
  // ═════ REVISE1 群1：Plan↔pit exact identity ═════
  C24_cross_decision_pit_not_linked: { run: root => {
    const w = makeWorld(root);
    const s = { race_instance_id: 'race-A', session_num: 2, pit_events: [{ schema_version: 1, race_instance_id: 'race-A',
      session_num: 2, pit_event_id: 'pit-2', driver_pit_sequence: 2, entry_lap: 16, execution_relation: 'penalty',
      penalty_evidence: { state: 'true' }, plan_reference: { decision_id: 'D2', selected_plan: 'B', target_lap: 20 } }],
      plan_outcomes: { available: true, records: [{ decision_id: 'D1', race_instance_id: 'race-A', session_num: 2,
        phase: 'invalidated', reason: 'penalty_pit', execution_relation: 'penalty', terminal_pit_event_id: 'pit-2',
        resolved_pit_sequence: 1, selected_plan: 'A', target_lap: 21 }] } };     // 親反例と同じ入力
    const M = w.ctx.PitwallDebriefOutcome; const o = M ? M.fromSummary(s) : null;
    const real = clone(s); real.plan_outcomes.records[0].resolved_pit_sequence = null;   // 実Lifecycleのinvalidatedは解決sequence無し
    const o2 = M ? M.fromSummary(real) : null;
    return ok(o && o2 && [o, o2].every(x => x.plans[0].pit_link === 'missing' && x.plans[0].pit_event_id === null
      && !/\(Pit 2\)/.test(M.lines(x, [], [], 'ja').join('\n'))), { plan: o && o.plans[0], real: o2 && o2.plans[0] });
  } },
  C24b_indirect_binding_control: { run: root => {
    const w = makeWorld(root);
    const s = { race_instance_id: 'race-A', session_num: 2, pit_events: [{ schema_version: 1, race_instance_id: 'race-A',
      session_num: 2, pit_event_id: 'pit-1', driver_pit_sequence: 1, entry_lap: 21, execution_relation: 'normal',
      penalty_evidence: { state: 'false' }, plan_reference: { decision_id: 'DA', selected_plan: 'A', target_lap: 21 } }],
      plan_outcomes: { available: true, records: [
        { decision_id: 'DA', race_instance_id: 'race-A', session_num: 2, phase: 'executed', reason: 'normal',
          execution_relation: 'normal', terminal_pit_event_id: 'pit-1', resolved_pit_sequence: 1, selected_plan: 'A', target_lap: 21 },
        { decision_id: 'DB', race_instance_id: 'race-A', session_num: 2, phase: 'invalidated', reason: 'pit_before_plan_activation',
          execution_relation: 'normal', terminal_pit_event_id: 'pit-1', resolved_pit_sequence: null, selected_plan: 'B', target_lap: 25 }] } };
    const o = w.ctx.PitwallDebriefOutcome.fromSummary(s);
    return ok(o.plans.every(p => p.pit_link === 'linked'), { plans: o.plans.map(p => [p.decision_id, p.pit_link]) });
  } },
  C24c_executed_sequence_must_match: { run: root => {
    const w = makeWorld(root);
    const s = { race_instance_id: 'race-A', session_num: 2, pit_events: [{ schema_version: 1, race_instance_id: 'race-A',
      session_num: 2, pit_event_id: 'pit-2', driver_pit_sequence: 2, entry_lap: 30, execution_relation: 'normal',
      penalty_evidence: { state: 'false' }, plan_reference: { decision_id: 'DA', selected_plan: 'A', target_lap: 30 } }],
      plan_outcomes: { available: true, records: [{ decision_id: 'DA', race_instance_id: 'race-A', session_num: 2,
        phase: 'executed', reason: 'normal', execution_relation: 'normal', terminal_pit_event_id: 'pit-2',
        resolved_pit_sequence: 1, selected_plan: 'A', target_lap: 30 }] } };
    const o = w.ctx.PitwallDebriefOutcome.fromSummary(s);
    return ok(o.plans[0].pit_link === 'missing', { plan: o.plans[0] });
  } },
  // ═════ 群2：判断台帳のdispute/correction/deleteをfresh正本から ═════
  C25_live_dispute_reaches_open_context: { run: root => {
    const w = makeWorld(root); const out = produce(root, PENALTY_PLAN_SCN); const s = clone(out.summaries[0]);
    w.ctx.__snap = clone(out.last_snapshot); startDebrief(w, s);
    w.ctx.syncCanonicalDecisionHistory();                                   // 実canonical→判断台帳
    const early = s.plan_outcomes.records.find(r => r.reason === 'driver_early_pit');
    const before = w.ctx.buildCurrentSessionFactNote(true);
    const m = w.ctx.PitwallDecisionMemory;
    w.ctx.saveDecisions(m.dispute(w.ctx.loadDecisions(), early.decision_id, null, Date.now(),
      { race_instance_id: s.race_instance_id, driver_id: null }).store);    // 実decision-memory dispute
    const after = w.ctx.buildCurrentSessionFactNote(true);
    return ok(!/保留中/.test(before) && /失効：早めのピット \(Pit 1\) ／ Driver訂正：この判断記録は保留中/.test(after), { after });
  } },
  C26_delete_and_dispute_reach_next_reference: { run: root => {
    const w = makeWorld(root); const out = produce(root, PENALTY_PLAN_SCN); const s = clone(out.summaries[0]);
    w.ctx.__snap = clone(out.last_snapshot); startDebrief(w, s);
    w.ctx.syncCanonicalDecisionHistory();
    answerAll(w, '前の車に引っかかって焦った');
    const early = s.plan_outcomes.records.find(r => r.reason === 'driver_early_pit');
    const pen = s.plan_outcomes.records.find(r => r.reason === 'penalty_pit');
    const m = w.ctx.PitwallDecisionMemory;
    w.ctx.saveDecisions(m.dispute(w.ctx.loadDecisions(), pen.decision_id, null, Date.now(),
      { race_instance_id: s.race_instance_id, driver_id: null }).store);
    const deleted = w.ctx.deleteDecision(early.decision_id, s.race_instance_id);   // 実deleteDecision（墓標）
    w.ctx.evidenceDebrief = null; w.ctx.__snap = null; w.observeRace('sub:next-race');
    const note = w.ctx.buildSessionEvidenceNote();
    return ok(deleted === true && !/失効：早めのピット/.test(note) && /Pit 1 · 15周目 · 早めのピット/.test(note)
      && /失効：ペナルティピット \(Pit 2\) ／ Driver訂正：この判断記録は保留中/.test(note), { note: note.slice(0, 900) });
  } },
  C27_confirmed_correction_reaches_next_reference: { run: root => {
    const w = makeWorld(root); const out = produce(root, PENALTY_PLAN_SCN); const s = clone(out.summaries[0]);
    w.ctx.__snap = clone(out.last_snapshot); startDebrief(w, s);
    w.ctx.syncCanonicalDecisionHistory(); answerAll(w, '前の車に引っかかって焦った');
    const pen = s.plan_outcomes.records.find(r => r.reason === 'penalty_pit');
    const m = w.ctx.PitwallDecisionMemory, race = { race_instance_id: s.race_instance_id, driver_id: null };
    let st = m.dispute(w.ctx.loadDecisions(), pen.decision_id, null, Date.now(), race).store;
    st = m.confirmCorrection(st, pen.decision_id, { outcome: 'incident_or_disconnect' }, Date.now(), race).store;
    w.ctx.saveDecisions(st);
    w.ctx.evidenceDebrief = null; w.ctx.__snap = null; w.observeRace('sub:next-race');
    const note = w.ctx.buildSessionEvidenceNote();
    return ok(/失効：ペナルティピット \(Pit 2\) ／ Driver訂正済み：incident_or_disconnect/.test(note)
      && /ペナルティ（black flag確認）/.test(note), { note: note.slice(0, 900) });
  } },
  // ═════ 群3：本人切替・race変更のconsumer ═════
  C28_owner_switch_hides_old_owner_correction: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0;
    w.ctx.recordEvidenceAnswer('16周目はペナルティじゃないよ');
    w.setOwner(8);
    const note = w.ctx.buildCurrentSessionFactNote(true);
    // U1の訂正もU1が受けたsession記録（pit分類）もU2のcontextへ出ない
    return ok(!/ペナルティ/.test(note) && !/Driver訂正：/.test(note) && !/Driver訂正：/.test(w.ctx.evidenceLines(s).join(' ')),
      { note: note.slice(0, 600) });
  } },
  C29_owner_switch_answer_goes_to_normal_conversation: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0; w.setOwner(8);
    const r = w.ctx.recordEvidenceAnswer('前の車に引っかかって焦った');
    return ok(r === 'not_answer' && w.ctx.evidenceDebrief === null && w.records().length === 0, { r });
  } },
  C30_other_owner_cannot_discard: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); answerAll(w, '前の車に引っかかって焦った');
    const first = clone(w.records()[0] || {});
    w.setOwner(8); w.ctx.discardEvidenceMemory();                 // U1のreviewをU2が削除 → 拒否
    const afterOldReview = w.records().filter(r => r.owner_ref === 'user:7').length;
    startDebrief(w, s); answerAll(w, '別アカウントの回答');          // 同じ表示名のU2が同じraceを振り返る
    w.ctx.confirmEvidenceMemory();
    startDebrief(w, s); w.ctx.discardEvidenceMemory();            // U2が自分の記録を削除
    const u1 = w.records().find(r => r.owner_ref === 'user:7');
    return ok(first.owner_ref === 'user:7' && afterOldReview === 1 && u1 && JSON.stringify(u1.qa) === JSON.stringify(first.qa),
      { owners: w.records().map(r => [r.owner_ref, r.review_id]) });
  } },
  C31_race_change_closes_review_and_context: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0;
    w.ctx.recordEvidenceAnswer('16周目はペナルティじゃないよ');
    w.observeRace('sub:next-race');
    const note = w.ctx.buildCurrentSessionFactNote(true);
    return ok(w.ctx.evidenceDebrief === null && w.ctx.lastSessionSummary === null && !/ペナルティ/.test(note), { note: note.slice(0, 300) });
  } },
  // ═════ 群4：後着summaryの実listener ═════
  C32_first_late_other_race_summary_history_only: { red_before: true, run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    if (s.track) { w.ctx.lastTrack = s.track_display || s.track; w.ctx.lastTrackId = s.track; }
    w.observeRace('sub:B');                                        // 今はrace B、A summaryが後着（初回）
    w.ctx.handleSessionSummaryMessage(clone(s));
    const hist = w.ctx.loadRaceHistory();
    const fact = w.ctx.buildCurrentSessionFactNote(true);
    return ok(w.ctx.lastSessionSummary === null && w.ctx.autoDebriefData === null && w.log.timers.length === 0 && !w.ctx.evidenceDebrief
      && hist.some(h => h.race_instance_id === s.race_instance_id) && !/ペナルティ|entry_lap=15/.test(fact),
    { last: w.ctx.lastSessionSummary && w.ctx.lastSessionSummary.race_instance_id, timers: w.log.timers.length, hist: hist.length });
  } },
  C33_fresh_same_race_summary_admitted: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    w.observeRace(s.race_instance_id);
    w.ctx.handleSessionSummaryMessage(clone(s));
    // debrief modeでは即開始、それ以外は8秒timer（どちらも同raceのsummaryで振り返りへ進む）
    return ok(w.ctx.lastSessionSummary && w.ctx.lastSessionSummary.race_instance_id === s.race_instance_id
      && w.ctx.autoDebriefData && (w.log.timers.length === 1 || (w.ctx.evidenceDebrief && w.ctx.evidenceDebrief.data.race_instance_id === s.race_instance_id)), {});
  } },
  C34_same_race_full_summary_upgrades_saved_record: { run: root => {
    const w = makeWorld(root); const out = produce(root, PENALTY_PLAN_SCN); const s = clone(out.summaries[0]);
    w.ctx.__snap = clone(out.last_snapshot); w.observeRace(s.race_instance_id);
    if (s.track) { w.ctx.lastTrack = s.track_display || s.track; w.ctx.lastTrackId = s.track; } if (s.car_model) w.ctx.lastCarModel = s.car_model;
    const fallback = w.ctx.buildFallbackSessionSummary();              // FINISHED暫定（canonical race/session付き）
    w.ctx.beginEvidenceDebrief(fallback);
    answerAll(w, '前の車に引っかかって焦った');
    const n0 = w.records().length, qa0 = JSON.stringify(w.records()[0] && w.records()[0].qa);
    w.ctx.handleSessionSummaryMessage(clone(s));                       // 同raceの完全summaryが後着
    const rec = w.records()[0] || {};
    return ok(fallback.race_instance_id === s.race_instance_id && n0 === 1 && w.records().length === 1
      && JSON.stringify(rec.qa) === qa0 && rec.race_outcome && rec.race_outcome.pits.length === 2, { n0, n: w.records().length });
  } },
  // ═════ 群5：MemoryBrain次requestの整合 ═════
  C35_memory_brain_not_success_after_penalty: { red_before: true, run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    // Bridgeがplan名・確定順位を送ったvariant（順位改善＋plan＋pitで旧推測がsuccessになる条件）
    Object.assign(s, { plan_name: 'A', start_class_position: 8, finish_pos: 4, finish_pos_confirmed: true });
    w.observeRace(s.race_instance_id); if (s.track) { w.ctx.lastTrack = s.track_display || s.track; w.ctx.lastTrackId = s.track; } if (s.car_model) w.ctx.lastCarModel = s.car_model;
    w.ctx.handleSessionSummaryMessage(clone(s));
    w.ctx.evidenceDebrief = null; w.observeRace('sub:next-race');
    w.ctx.prepareMemoryBrain('前回のレースどうだった？');
    const prompt = w.ctx.currentMemoryBrainPrompt();
    const facts = (JSON.parse((prompt.split('\n').find(l => l.startsWith('{')) || '{}')).facts) || {};
    return ok(prompt && facts.plan_success === null && facts.plan_success_basis === 'no_authoritative_score'
      && JSON.stringify(facts.penalty_pit_laps) === '[16]'
      && (facts.plan_outcomes || []).some(p => p.reason === 'penalty_pit' && p.pit_lap === 16), { facts });
  } },
  C36_memory_brain_executed_control: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, 'normal');
    Object.assign(s, { plan_name: 'A', start_class_position: 8, finish_pos: 6, finish_pos_confirmed: true });
    w.observeRace(s.race_instance_id); if (s.track) { w.ctx.lastTrack = s.track_display || s.track; w.ctx.lastTrackId = s.track; } if (s.car_model) w.ctx.lastCarModel = s.car_model;
    w.ctx.handleSessionSummaryMessage(clone(s));
    w.ctx.evidenceDebrief = null; w.observeRace('sub:next-race');
    w.ctx.prepareMemoryBrain('前回は？');
    const facts = (JSON.parse((w.ctx.currentMemoryBrainPrompt().split('\n').find(l => l.startsWith('{')) || '{}')).facts) || {};
    // 実行＋順位維持は戦略成功の証明ではない：既存の採点が無ければnull（成功にも失敗にも変換しない）
    return ok(facts.plan_success === null && facts.plan_success_basis === 'no_authoritative_score'
      && (facts.plan_outcomes || []).some(p => p.phase === 'executed'), { facts });
  } },
  C37_memory_brain_disputed_decision_not_success: { run: root => {
    const w = makeWorld(root); const out = produce(root, 'normal'); const s = clone(out.summaries[0]);
    Object.assign(s, { plan_name: 'A', start_class_position: 8, finish_pos: 6, finish_pos_confirmed: true });
    w.ctx.__snap = clone(out.last_snapshot); w.observeRace(s.race_instance_id);
    if (s.track) { w.ctx.lastTrack = s.track_display || s.track; w.ctx.lastTrackId = s.track; } if (s.car_model) w.ctx.lastCarModel = s.car_model;
    w.ctx.syncCanonicalDecisionHistory();
    w.ctx.handleSessionSummaryMessage(clone(s));
    const ex = s.plan_outcomes.records.find(r => r.phase === 'executed');
    const m = w.ctx.PitwallDecisionMemory;
    w.ctx.saveDecisions(m.dispute(w.ctx.loadDecisions(), ex.decision_id, null, Date.now(),
      { race_instance_id: s.race_instance_id, driver_id: null }).store);
    w.ctx.evidenceDebrief = null; w.ctx.__snap = null; w.observeRace('sub:next-race');
    w.ctx.prepareMemoryBrain('前回は？');
    const facts = (JSON.parse((w.ctx.currentMemoryBrainPrompt().split('\n').find(l => l.startsWith('{')) || '{}')).facts) || {};
    return ok(facts.plan_success === null && facts.plan_success_basis === 'driver_disputed', { facts });
  } },
  // ═════ 群6：Bridgeと一致する普通の回答はQAを進める ═════
  C38_matching_answer_progresses_qa: { run: root => {
    const res = [];
    for (const [sel, text] of [['LunaJP', '予定どおり。復帰の感触も良かった。'], ['Luna', 'It was planned and the rejoin felt good.'],
      ['LunaJP', 'ペナルティなんか無かったよ、普通のストップで復帰も良かった']]) {
      const w = makeWorld(root); w.ctx.sel = sel; const s = summaryOf(root, 'normal');
      startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0;
      const r = w.ctx.recordEvidenceAnswer(text);
      res.push({ sel, r, answers: w.ctx.evidenceDebrief.answers, saved: w.records().length });
    }
    return ok(res.every(x => (x.r === 'saved' || x.r === 'recorded') && x.answers[0] && x.saved === 1), res);
  } },
  C39_penalty_agreement_is_an_answer: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0;
    const r = w.ctx.recordEvidenceAnswer('ペナルティだったのはピットレーンの速度違反だと思う');
    return ok((r === 'saved' || r === 'recorded') && (w.ctx.evidenceDebrief.outcomeCorrections || []).length === 0
      && w.ctx.evidenceDebrief.answers.length === 1, { r, c: w.ctx.evidenceDebrief.outcomeCorrections });
  } },
  C40_conflicting_claim_is_a_correction: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0;
    const r = w.ctx.recordEvidenceAnswer('15周目は予定どおりだった');
    const c = w.ctx.evidenceDebrief.outcomeCorrections || [];
    return ok(r === 'correction' && c.length === 1 && c[0].entry_lap === 15 && c[0].canonical_relation === 'early'
      && w.ctx.evidenceDebrief.answers.length === 0, { r, c });
  } },
  // ═════ REVISE2 群5：新しい成功/失敗採点をしない／既存採点は使う ═════
  C42_no_new_failure_scoring: { run: root => {
    const res = {};
    { // early失効したが好結果のrace（penalty無し）
      const w = makeWorld(root); const s = summaryOf(root, 'unknown_flags');
      Object.assign(s, { plan_name: 'A', start_class_position: 8, finish_pos: 4, finish_pos_confirmed: true });
      w.observeRace(s.race_instance_id); if (s.track) { w.ctx.lastTrack = s.track_display || s.track; w.ctx.lastTrackId = s.track; } if (s.car_model) w.ctx.lastCarModel = s.car_model;
      w.ctx.handleSessionSummaryMessage(clone(s)); w.ctx.evidenceDebrief = null; w.observeRace('sub:next-race');
      w.ctx.prepareMemoryBrain('前回は？');
      res.early = (JSON.parse((w.ctx.currentMemoryBrainPrompt().split('\n').find(l => l.startsWith('{')) || '{}')).facts) || {};
    }
    { // 実行済みAの後に無関係なpenalty（variant：normal raceへpenalty pitを追加）
      const w = makeWorld(root); const s = summaryOf(root, 'normal');
      const pen = clone(s.pit_events[0]);
      Object.assign(pen, { pit_event_id: s.pit_events[0].pit_event_id + ':pen', driver_pit_sequence: 2, entry_lap: 23, exit_lap: 23,
        execution_relation: 'penalty', penalty_evidence: Object.assign({}, pen.penalty_evidence, { state: 'true' }), plan_reference: null });
      s.pit_events.push(pen);
      Object.assign(s, { plan_name: 'A', start_class_position: 8, finish_pos: 4, finish_pos_confirmed: true });
      w.observeRace(s.race_instance_id); if (s.track) { w.ctx.lastTrack = s.track_display || s.track; w.ctx.lastTrackId = s.track; } if (s.car_model) w.ctx.lastCarModel = s.car_model;
      w.ctx.handleSessionSummaryMessage(clone(s)); w.ctx.evidenceDebrief = null; w.observeRace('sub:next-race');
      w.ctx.prepareMemoryBrain('前回は？');
      res.penalty = (JSON.parse((w.ctx.currentMemoryBrainPrompt().split('\n').find(l => l.startsWith('{')) || '{}')).facts) || {};
    }
    return ok(res.early.plan_success === null && res.early.plan_success_basis === 'no_authoritative_score'
      && (res.early.plan_outcomes || []).some(p => p.reason === 'driver_early_pit')
      && res.penalty.plan_success === null && JSON.stringify(res.penalty.penalty_pit_laps) === '[23]', res);
  } },
  C42b_existing_decision_score_is_used: { run: root => {
    const w = makeWorld(root); const out = produce(root, 'normal'); const s = clone(out.summaries[0]);
    Object.assign(s, { start_class_position: 8, finish_pos: 6, finish_pos_confirmed: true });
    w.ctx.__snap = clone(out.last_snapshot); w.observeRace(s.race_instance_id);
    if (s.track) { w.ctx.lastTrack = s.track_display || s.track; w.ctx.lastTrackId = s.track; } if (s.car_model) w.ctx.lastCarModel = s.car_model;
    w.ctx.syncCanonicalDecisionHistory();
    const ex = s.plan_outcomes.records.find(r => r.phase === 'executed');
    const m = w.ctx.PitwallDecisionMemory, race = { race_instance_id: s.race_instance_id, driver_id: null };
    let st = m.appendExecution(w.ctx.loadDecisions(), { decision_id: ex.decision_id, pos_in: 8,
      strategy_option_score: { executed_plan: 'A' } }, Date.now(), race).store;        // 既存の判断台帳採点（実module）
    st = m.appendBlend(st, { decision_id: ex.decision_id, outcome: { condition_met: true, post_cycle_actual_position: 6 } }, Date.now(), race).store;
    w.ctx.saveDecisions(st);
    w.ctx.handleSessionSummaryMessage(clone(s)); w.ctx.evidenceDebrief = null; w.ctx.__snap = null; w.observeRace('sub:next-race');
    w.ctx.prepareMemoryBrain('前回は？');
    const facts = (JSON.parse((w.ctx.currentMemoryBrainPrompt().split('\n').find(l => l.startsWith('{')) || '{}')).facts) || {};
    return ok(facts.plan_success === true && facts.plan_success_basis === 'decision_memory_outcome:success', { facts });
  } },
  // ═════ REVISE2 群2：MemoryBrain側も同じfresh正本（削除・訂正・90日） ═════
  C43_deleted_decision_not_reoutput_by_memory_brain: { run: root => {
    const w = makeWorld(root); const out = produce(root, PENALTY_PLAN_SCN); const s = clone(out.summaries[0]);
    w.ctx.__snap = clone(out.last_snapshot); startDebrief(w, s);
    w.ctx.syncCanonicalDecisionHistory();
    w.ctx.handleSessionSummaryMessage(clone(s)); answerAll(w, '前の車に引っかかって焦った');
    const early = s.plan_outcomes.records.find(r => r.reason === 'driver_early_pit');
    const deleted = w.ctx.deleteDecision(early.decision_id, s.race_instance_id);
    w.ctx.evidenceDebrief = null; w.ctx.__snap = null; w.observeRace('sub:next-race');
    const note = w.ctx.__requestMemory('前回のレースどうだった？');
    const facts = (JSON.parse((note.split('\n').find(l => l.startsWith('{')) || '{}')).facts) || {};
    return ok(deleted && facts.plan_outcomes && !facts.plan_outcomes.some(p => p.reason === 'driver_early_pit')
      && facts.plan_outcomes.some(p => p.reason === 'penalty_pit') && JSON.stringify(facts.penalty_pit_laps) === '[16]'
      && !/失効：早めのピット/.test(note) && /Pit 1 · 15周目 · 早めのピット/.test(note), { plan_outcomes: facts.plan_outcomes });
  } },
  C44_expired_outcome_copy_not_used: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    Object.assign(s, { plan_name: 'A', start_class_position: 8, finish_pos: 4, finish_pos_confirmed: true });
    w.observeRace(s.race_instance_id); if (s.track) { w.ctx.lastTrack = s.track_display || s.track; w.ctx.lastTrackId = s.track; } if (s.car_model) w.ctx.lastCarModel = s.car_model;
    w.ctx.handleSessionSummaryMessage(clone(s));
    const h = w.ctx.loadRaceHistory(); h[h.length - 1].recordedAt = new Date(Date.now() - 91 * 86400000).toISOString();
    w.store.set('pw_raceHistory', JSON.stringify(h));
    w.ctx.evidenceDebrief = null; w.observeRace('sub:next-race');
    w.ctx.prepareMemoryBrain('前回は？');
    const facts = (JSON.parse((w.ctx.currentMemoryBrainPrompt().split('\n').find(l => l.startsWith('{')) || '{}')).facts) || {};
    return ok(facts.plan_outcomes === null && facts.plan_success === null && facts.plan_success_basis === 'outcome_expired', { facts });
  } },
  C45_corrected_decision_annotated_in_memory_brain: { run: root => {
    const w = makeWorld(root); const out = produce(root, PENALTY_PLAN_SCN); const s = clone(out.summaries[0]);
    w.ctx.__snap = clone(out.last_snapshot); w.observeRace(s.race_instance_id);
    if (s.track) { w.ctx.lastTrack = s.track_display || s.track; w.ctx.lastTrackId = s.track; } if (s.car_model) w.ctx.lastCarModel = s.car_model;
    w.ctx.syncCanonicalDecisionHistory(); w.ctx.handleSessionSummaryMessage(clone(s));
    const pen = s.plan_outcomes.records.find(r => r.reason === 'penalty_pit');
    const m = w.ctx.PitwallDecisionMemory, race = { race_instance_id: s.race_instance_id, driver_id: null };
    let st = m.dispute(w.ctx.loadDecisions(), pen.decision_id, null, Date.now(), race).store;
    st = m.confirmCorrection(st, pen.decision_id, { outcome: 'incident_or_disconnect' }, Date.now(), race).store;
    w.ctx.saveDecisions(st);
    w.ctx.evidenceDebrief = null; w.ctx.__snap = null; w.observeRace('sub:next-race');
    w.ctx.prepareMemoryBrain('前回は？');
    const facts = (JSON.parse((w.ctx.currentMemoryBrainPrompt().split('\n').find(l => l.startsWith('{')) || '{}')).facts) || {};
    const p = (facts.plan_outcomes || []).find(x => x.reason === 'penalty_pit') || {};
    return ok(p.driver_note === 'driver_corrected' && p.driver_corrected_outcome === 'incident_or_disconnect' && p.phase === 'invalidated', { p });
  } },
  // ═════ REVISE2 群3：旧本人のsession記録を新本人の実requestへ出さない ═════
  C46_owner_switch_request_has_no_old_owner_session: { red_before: true, run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    w.observeRace(s.race_instance_id); if (s.track) { w.ctx.lastTrack = s.track_display || s.track; w.ctx.lastTrackId = s.track; } if (s.car_model) w.ctx.lastCarModel = s.car_model;
    w.ctx.handleSessionSummaryMessage(clone(s));                    // U1が受けたsummary・振り返り
    answerAll(w, '前の車に引っかかって焦った');
    const u1 = w.ctx.__requestMemory('直前の振り返りを教えて');
    w.setOwner(8);                                                   // 同じ表示名・同じrace・同じPCでU2へ
    const u2 = w.ctx.__requestMemory('直前の振り返りを教えて');
    const leak = /entry_lap=15|ペナルティ|16周目|早めのピット|前の車に引っかかって/.test(u2);
    return ok(/entry_lap=15/.test(u1) && /ペナルティ/.test(u1) && !leak, { u2: u2.slice(0, 900) });
  } },
  C47_unowned_summary_not_bound_to_later_owner: { run: root => {
    const w = makeWorld(root); const s = summaryOf(root, PENALTY_PLAN_SCN);
    w.store.delete('pw_auth_user');                                  // 本人不明の時に受けたsummary
    w.observeRace(s.race_instance_id); w.ctx.handleSessionSummaryMessage(clone(s));
    w.setOwner(7);
    const note = w.ctx.buildCurrentSessionFactNote(true);
    return ok(note === '' && w.ctx.ownedSessionSummary() === null, { note: note.slice(0, 200) });
  } },
  // ═════ REVISE2 群6：明確な否定・複数pitの対象未確定 ═════
  C48_negated_planned_is_not_agreement: { run: root => {
    const res = [];
    for (const [sel, pos, neg] of [['LunaJP', '予定どおりだった', '予定どおりじゃなかった'], ['Luna', 'It was planned', 'It was not planned']]) {
      const wp = makeWorld(root); wp.ctx.sel = sel; const s = summaryOf(root, 'normal');
      startDebrief(wp, s); wp.ctx.evidenceDebrief.acceptAfter = 0;
      const rp = wp.ctx.recordEvidenceAnswer(pos);
      const wn = makeWorld(root); wn.ctx.sel = sel; startDebrief(wn, s); wn.ctx.evidenceDebrief.acceptAfter = 0;
      const rn = wn.ctx.recordEvidenceAnswer(neg);
      const c = wn.ctx.evidenceDebrief.outcomeCorrections || [];
      res.push({ sel, rp, rn, claim: c[0] && c[0].driver_claim, answersNeg: wn.ctx.evidenceDebrief.answers.length });
    }
    return ok(res.every(x => (x.rp === 'saved' || x.rp === 'recorded') && x.rn === 'correction' && x.claim === 'not_planned' && x.answersNeg === 0), res);
  } },
  C49_mixed_pits_ask_instead_of_dropping: { run: root => {
    // 2停止がnormalとpenalty。周回も今の質問の対象も無い「予定どおりだった」は、片方へ同意・片方へ訂正し得る→聞き返す
    const w = makeWorld(root); const s = summaryOf(root, 'normal');
    const pen = clone(s.pit_events[0]);
    Object.assign(pen, { pit_event_id: s.pit_events[0].pit_event_id + ':pen', driver_pit_sequence: 2, entry_lap: 23, exit_lap: 23,
      execution_relation: 'penalty', penalty_evidence: Object.assign({}, pen.penalty_evidence, { state: 'true' }), plan_reference: null });
    s.pit_events.push(pen);
    startDebrief(w, s); w.ctx.evidenceDebrief.acceptAfter = 0;
    w.ctx.evidenceDebrief.index = 1; w.ctx.evidenceDebrief.questions.push('次は？');   // canonical質問の後（対象pit無し）
    const r1 = w.ctx.recordEvidenceAnswer('予定どおりだった');
    const n1 = (w.ctx.evidenceDebrief.outcomeCorrections || []).length;
    const r2 = w.ctx.recordEvidenceAnswer('23周目は予定どおりだった');               // 周回指定→penalty停止への訂正
    const c = w.ctx.evidenceDebrief.outcomeCorrections || [];
    return ok(r1 === 'correction_ambiguous' && n1 === 0 && r2 === 'correction' && c.length === 1 && c[0].entry_lap === 23, { r1, n1, r2, c });
  } },
  // ═════ 最終identity：同本人・同接続・同course/car/SessionNumの別race保存 ═════
  C50_two_races_same_session_two_records: { red_before: true, run: root => {
    const w = makeWorld(root); const a = summaryOf(root, 'normal');
    const b = otherRace(a, 'sub:race-B');                          // race IDだけ別（同owner・usageSessionId・course・car・SessionNum）
    startDebrief(w, a); answerAll(w, 'Aの回答');
    startDebrief(w, b); answerAll(w, 'Bの回答');                   // 実noteMemoryRaceScope→begin→answer→保存
    const rows = w.records();
    const ra = rows.find(r => r.race_instance_id === a.race_instance_id), rb = rows.find(r => r.race_instance_id === 'sub:race-B');
    return ok(rows.length === 2 && ra && rb && ra.review_id !== rb.review_id && ra.qa[0].answer === 'Aの回答' && rb.qa[0].answer === 'Bの回答',
      { ids: rows.map(r => [r.race_instance_id, r.review_id, r.qa && r.qa[0] && r.qa[0].answer]) });
  } },
  C51_same_race_resend_idempotent: { run: root => {
    const w = makeWorld(root); const a = summaryOf(root, 'normal');
    startDebrief(w, a); answerAll(w, 'Aの回答');
    const id = w.records()[0] && w.records()[0].review_id;
    w.ctx.handleSessionSummaryMessage(clone(a));                     // 同raceのsummary再送
    // 再接続（usageSessionId更新）・表示名変更・現在SessionNum/車名表示が変わっても、summaryの本人/race/sessionが同じなら同じ記録
    Object.assign(w.ctx, { usageSessionId: 'reconnected', userName: 'Yuji (renamed)', lastSessionNum: 5, lastCarModel: 'other display' });
    w.ctx.evidenceDebrief = null; startDebrief(w, Object.assign(clone(a), { car_model: undefined }));
    w.ctx.lastCarModel = 'other display'; answerAll(w, 'Aの回答（再）');   // 同raceを再度振り返る
    const same = w.records();
    // 対照：別raceは別記録
    w.ctx.evidenceDebrief = null; startDebrief(w, otherRace(a, 'sub:race-C')); answerAll(w, 'Cの回答');
    const rows = w.records();
    return ok(same.length === 1 && same[0].review_id === id && same[0].qa[0].answer === 'Aの回答（再）' && /race:/.test(id)
      && rows.length === 2 && rows.some(r => r.race_instance_id === 'sub:race-C'), { same: same.map(r => r.review_id), ids: rows.map(r => r.review_id) });
  } },
  C52_explicit_record_id_edit_and_legacy_review: { run: root => {
    const w = makeWorld(root); const a = summaryOf(root, 'normal');
    startDebrief(w, a); answerAll(w, '最初の回答');
    const id = w.records()[0].review_id;
    w.ctx.restartEvidenceDebrief(); answerAll(w, '修正した回答');   // 既存recordIdを指定した編集
    const edited = w.records();
    // identity無しの旧形式optional review（practice）は従来形式idで保存される
    const w2 = makeWorld(root);
    const practice = { type: 'session_summary', event_type: 'Practice', is_race: false, track: a.track, car_model: a.car_model,
      car_class: a.car_class, total_laps: 6, best_lap: 100.1 };
    w2.ctx.sessionPurpose = 'practice'; w2.ctx.lastSessionType = 'Practice'; startDebrief(w2, practice); answerAll(w2, '練習の回答');
    const pr = w2.records()[0] || {};
    return ok(edited.length === 1 && edited[0].review_id === id && edited[0].qa[0].answer === '修正した回答'
      && pr.review_id && !/race:/.test(pr.review_id) && pr.qa[0].answer === '練習の回答', { id, legacy: pr.review_id });
  } },
};

// ── isolated guard cuts（after sourceの1箇所だけを外す） ────────────
const CUTS = [
  { id: 'K01_pit_race_session_check', file: 'debrief-outcome.js', expect: ['C16_foreign_race_pit_and_plan_rejected'],
    from: 'if (e.race_instance_id !== race || e.session_num !== session || !int(e.driver_pit_sequence)) return null;',
    to: 'if (!int(e.driver_pit_sequence)) return null;' },
  { id: 'K02_plan_pit_relation_link', file: 'debrief-outcome.js', expect: ['C16b_plan_pit_link_requires_same_relation'],
    from: 'if (!p || p.relation !== r.execution_relation) return false;', to: 'if (!p) return false;' },
  { id: 'K03_summary_source_admission', file: 'renderer', expect: ['C13_late_other_race_summary_rejected'],
    from: 'if(a&&b) return a===b;', to: 'if(a&&b) return true;' },
  { id: 'K04_owner_switch_save', file: 'renderer', expect: ['C14_owner_switch_mid_debrief_not_saved'],
    from: 'if(evidenceDebrief.ownerRef!==undefined&&evidenceDebrief.ownerRef!==localMemoryOwnerRef()){', to: 'if(false){' },
  { id: 'K05_correction_uniqueness', file: 'debrief-outcome.js', expect: ['C05_ambiguous_correction_not_saved'],
    from: "if (candidates.length > 1) return { status: 'ambiguous'", to: "if (false) return { status: 'ambiguous'" },
  { id: 'K06_next_reference_same_race', file: 'debrief-outcome.js', expect: ['C09_same_race_not_previous'],
    from: "outcome.race_instance_id === currentRace.race_instance_id) return '';", to: "false) return '';" },
  { id: 'K07_next_reference_owner', file: 'debrief-outcome.js', expect: ['C10_other_owner_same_name'],
    from: '|| record.owner_ref !== ownerRef', to: '' },
  { id: 'K08_canonical_first_question', file: 'renderer', expect: ['C00b_red_thread_debrief_panel_and_question', 'C02_debrief_panel_and_question', 'C17_unknown_black_flag_not_penalty', 'C22_normal_control', 'C39_penalty_agreement_is_an_answer'],
    from: 'if(canonicalQuestion) return [canonicalQuestion];', to: '' },
  { id: 'K09_correction_race_binding', file: 'debrief-outcome.js', expect: ['C23_foreign_correction_not_carried'],
    from: '&& c.race_instance_id === outcome.race_instance_id && c.session_num === outcome.session_num', to: '' },
  { id: 'K10_decision_correction_owner', file: 'renderer', expect: ['C20_decision_dispute_shown_same_owner_only'],
    from: '&&m.ownerRefOf(r)===owner', to: '' },
  { id: 'K11_ledger_invalidated_reason', file: 'renderer', expect: ['C19_decision_ledger_keeps_invalidated_reason'],
    from: 'invalidated_reason:record.invalidated_reason||null,', to: 'invalidated_reason:record.terminal_reason||null,' },
  { id: 'K12_direct_reason_requires_same_decision', file: 'debrief-outcome.js', expect: ['C24_cross_decision_pit_not_linked'],
    from: 'return INDIRECT_REASONS.indexOf(r.reason) >= 0;', to: 'return true;' },
  { id: 'K13_resolved_sequence_match', file: 'debrief-outcome.js', expect: ['C24c_executed_sequence_must_match'],
    from: 'if (int(r.resolved_pit_sequence) && r.resolved_pit_sequence !== p.driver_pit_sequence) return false;', to: '' },
  { id: 'K14_ledger_tombstone_view', file: 'renderer', expect: ['C26_delete_and_dispute_reach_next_reference', 'C43_deleted_decision_not_reoutput_by_memory_brain'],
    from: 'for(const t of loadDecisionTombstones()){', to: 'for(const t of []){' },
  { id: 'K15_historical_fresh_ledger', file: 'debrief-outcome.js',
    expect: ['C26_delete_and_dispute_reach_next_reference', 'C27_confirmed_correction_reaches_next_reference', 'C43_deleted_decision_not_reoutput_by_memory_brain'],
    from: 'const body = lines(outcome, corr, decisionNotes || [], lang)', to: 'const body = lines(outcome, corr, [], lang)' },
  { id: 'K16_review_owner_binding', file: 'renderer',
    expect: ['C28_owner_switch_hides_old_owner_correction', 'C29_owner_switch_answer_goes_to_normal_conversation'],
    from: 'if(r.ownerRef!==localMemoryOwnerRef()) return false;', to: '' },
  { id: 'K17_review_race_binding', file: 'renderer', expect: ['C31_race_change_closes_review_and_context'],
    from: "return !(race&&typeof rid==='string'&&rid&&race.race_instance_id!==rid);", to: 'return true;' },
  { id: 'K18_first_summary_live_race_check', file: 'renderer', expect: ['C32_first_late_other_race_summary_history_only'],
    from: 'if(b&&race&&race.race_instance_id!==incoming.race_instance_id) return false;', to: '' },
  { id: 'K19_memory_brain_canonical_verdict', file: 'memory-brain.js',
    expect: ['C35_memory_brain_not_success_after_penalty', 'C42_no_new_failure_scoring', 'C43_deleted_decision_not_reoutput_by_memory_brain',
      'C44_expired_outcome_copy_not_used', 'C45_corrected_decision_annotated_in_memory_brain', 'C36_memory_brain_executed_control', 'C42b_existing_decision_score_is_used',
      'C37_memory_brain_disputed_decision_not_success'],
    from: "return (o && o.available === true && o.schema === 1 && String(o.race_instance_id) === String(raceIdOf(race))) ? o : null;", to: 'return null;' },
  { id: 'K22_review_id_owner_tag', file: 'renderer', expect: ['C30_other_owner_cannot_discard'],
    from: "return (owner?owner+'#':'')+'race:'+data.race_instance_id", to: "return 'race:'+data.race_instance_id" },
  { id: 'K32_review_id_canonical_race', file: 'renderer', expect: ['C50_two_races_same_session_two_records', 'C51_same_race_resend_idempotent'],
    from: "    return (owner?owner+'#':'')+'race:'+data.race_instance_id+'#'+data.session_num;\n", to: "    ;\n" },
  { id: 'K33_stable_key_excludes_usage_session', file: 'renderer', expect: ['C51_same_race_resend_idempotent'],
    from: "return (owner?owner+'#':'')+'race:'+data.race_instance_id+'#'+data.session_num;",
    to: "return (owner?owner+'#':'')+'race:'+data.race_instance_id+'#'+data.session_num+'#'+usageSessionId;" },
  { id: 'K23_no_conflict_is_not_correction', file: 'debrief-outcome.js', expect: ['C38_matching_answer_progresses_qa', 'C39_penalty_agreement_is_an_answer', 'C48_negated_planned_is_not_agreement'],
    from: 'if (!candidates.length) return null;', to: "if (!candidates.length) return { status: 'no_target', claim };" },
  { id: 'K24_summary_owner_binding', file: 'renderer',
    expect: ['C46_owner_switch_request_has_no_old_owner_session', 'C47_unowned_summary_not_bound_to_later_owner', 'C28_owner_switch_hides_old_owner_correction'],
    from: 'return lastSessionSummary&&lastSessionSummaryOwner===localMemoryOwnerRef()?lastSessionSummary:null;', to: 'return lastSessionSummary;' },
  { id: 'K25_evidence_note_owner', file: 'renderer', expect: ['C46_owner_switch_request_has_no_old_owner_session'],
    from: 'if(r.owner_ref&&r.owner_ref!==owner) return false;', to: '' },
  { id: 'K26_memory_brain_tombstones', file: 'memory-brain.js', expect: ['C43_deleted_decision_not_reoutput_by_memory_brain'],
    from: "&& !deleted.has(String(p.decision_id)));", to: ');' },
  { id: 'K27_memory_brain_outcome_freshness', file: 'memory-brain.js', expect: ['C44_expired_outcome_copy_not_used'],
    from: 'return Number.isFinite(at) && nowMs - at <= OUTCOME_MAX_AGE_MS && at <= nowMs + CLOCK_SKEW_MS;', to: 'return true;' },
  { id: 'K28_memory_brain_existing_score_only', file: 'memory-brain.js', expect: ['C42b_existing_decision_score_is_used'],
    from: 'if (scored) {', to: 'if (false) {' },
  { id: 'K29_negated_planned_claim', file: 'debrief-outcome.js', expect: ['C48_negated_planned_is_not_agreement'],
    from: "test(s)) return 'not_planned';", to: "test(s)) return 'planned';" },
  { id: 'K30_mixed_agree_conflict_asks', file: 'debrief-outcome.js', expect: ['C49_mixed_pits_ask_instead_of_dropping'],
    from: "if (agrees.length) return { status: 'ambiguous', claim, laps: scoped.map(p => p.entry_lap) };",
    to: 'if (agrees.length) return null;' },
  { id: 'K31_question_focus_scope', file: 'renderer', expect: ['C39_penalty_agreement_is_an_answer'],
    from: 'const focus=evidenceDebrief.index===evidenceDebrief.focusIndex?evidenceDebrief.focusPitId:null;', to: 'const focus=null;' },
  { id: 'K21_same_race_saved_record_upgrade', file: 'renderer', expect: ['C34_same_race_full_summary_upgrades_saved_record'],
    from: 'if(saved&&evidenceReviewBound()){', to: 'if(false){' },
];

// ── 実行 ─────────────────────────────────────────────────────────
function runCase(name, root, cut) {
  const c = CASES[name];
  try {
    if (!cut) return c.run(root);
    // cut runではmakeWorldにcutを渡すため、case内のmakeWorld呼出しを差し替える
    const original = makeWorld;
    makeWorld = (r) => original(r, cut);             // eslint-disable-line no-func-assign
    try { return c.run(root); } finally { makeWorld = original; } // eslint-disable-line no-func-assign
  } catch (e) {
    return { pass: false, error: String(e && e.stack || e).slice(0, 600) };
  }
}

module.exports = { makeWorld: (...a) => makeWorld(...a), produce, summaryOf, startDebrief, answerAll, CASES, CUTS };
if (require.main === module) main();
function main() {
let pass = 0, fail = 0;
const matrix = { generated_at: new Date().toISOString(), after: {}, before: {}, cuts: {}, cost_proxy: {} };
function check(label, cond, detail) {
  (cond ? console.log : console.error)((cond ? '✅ ' : '❌ ') + label + (cond || !detail ? '' : '\n   ' + JSON.stringify(detail).slice(0, 700)));
  cond ? pass++ : fail++;
}

console.log('— after（現tree）—');
for (const name of Object.keys(CASES)) {
  const r = runCase(name, AFTER);
  matrix.after[name] = r;
  check('after ' + name, r.pass, r);
}

console.log('— before（着手前tree：' + BEFORE + '）—');
const beforeAvailable = fs.existsSync(path.join(BEFORE, 'desktop', 'renderer.html'));
if (beforeAvailable && process.env.WO018_BEFORE_KIND === 'wo019_start') {
  // WO-019: BEFORE is the 10/18 WO019 start tree (post-WO018), not the pre-WO018 tree, so the
  // red_before expectations do not apply. Record every case on the same FINAL fixtures/IO as a
  // same-condition comparison; a missing helper/scenario there is a HARNESS line, not a RED.
  const cmp = {};
  for (const name of Object.keys(CASES)) {
    const r = runCase(name, BEFORE);
    cmp[name] = r.error && /is not defined|has already been declared|producer failed|Cannot find/.test(r.error)
      ? 'harness' : (r.pass ? 'pass' : 'fail');
  }
  matrix.before = { kind: 'wo019_start', root: BEFORE, cases: cmp };
  const count = k => Object.values(cmp).filter(v => v === k).length;
  console.log('before(wo019 start tree) pass=' + count('pass') + ' fail=' + count('fail') + ' harness=' + count('harness')
    + ' （比較記録、PASS/FAIL判定に数えない）');
  for (const [n, v] of Object.entries(cmp)) if (v !== 'pass') console.log('   before ' + v + ': ' + n);
} else if (!beforeAvailable) {
  console.log('⚠️ before tree unavailable — 比較不能（PASSに数えない）');
  matrix.before = { unavailable: true };
} else {
  for (const name of Object.keys(CASES).filter(n => CASES[n].red_before)) {
    const r = runCase(name, BEFORE);
    matrix.before[name] = r;
    check('before ' + name + ' は欠陥どおりRED', !r.pass, r);
  }
}

console.log('— guard cut（対象caseだけRED、他はGREENのまま）—');
for (const cut of CUTS) {
  const res = {};
  for (const name of Object.keys(CASES)) res[name] = runCase(name, AFTER, cut).pass;
  const red = Object.keys(res).filter(n => !res[n]);
  matrix.cuts[cut.id] = { expect: cut.expect, red };
  check(cut.id + ' → RED ' + cut.expect.join(','), cut.expect.every(n => !res[n]), { red });
  check(cut.id + ' 他caseはGREEN', red.every(n => cut.expect.includes(n)), { unexpected_red: red.filter(n => !cut.expect.includes(n)) });
}

// ── 費用proxy：LLMへ渡すdebrief contextの文字数（新しいLLM callは無い） ──
{
  const w = makeWorld(AFTER); const s = summaryOf(AFTER, 'red_thread');
  startDebrief(w, s);
  const withOutcome = w.ctx.buildCurrentSessionFactNote(true).length;
  const w0 = makeWorld(AFTER, { id: 'cost', file: 'renderer', from: 'const outcome=debriefOutcomeContext(summary,isJP);', to: "const outcome='';" });
  startDebrief(w0, s);
  const without = w0.ctx.buildCurrentSessionFactNote(true).length;
  matrix.cost_proxy = { current_session_fact_note_chars: { with_outcome: withOutcome, without_outcome_counterfactual: without,
    delta: withOutcome - without }, llm_calls_added: 0,
    note: 'counterfactual on current source (outcome context removed), not a measured token/price delta' };
  console.log('費用proxy: debrief fact note ' + without + ' → ' + withOutcome + ' chars (+' + (withOutcome - without) + ')、追加LLM call 0');
}

try { fs.writeFileSync(MATRIX, JSON.stringify(matrix, null, 2)); console.log('matrix → ' + MATRIX); } catch (e) { console.log('matrix write failed: ' + e.message); }
console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
}
