'use strict';
// Build 265 (Codex 差戻し 3): Lap Readout 最終 4 択と bridge 側クリーン周判定を
// 実 dispatch まで通す。
//   off              — 全部発話しない
//   best_only        — personal_best / session_best のみ
//   every_2_laps     — bridge が判定した「クリーン周」候補のうち 2 周ごと
//   every_clean_lap  — bridge が判定した「クリーン周」候補ごと
// Best 更新は best_only 以外の 3 択でも常に通す。

const fs = require('fs');
const vm = require('vm');

let pass = 0;
function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}: ${detail}`);
  pass++;
}

const html = fs.readFileSync(__dirname + '/desktop/renderer.html', 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.reduce((a, b) => (a.length > b.length ? a : b));

function extract(name, kind) {
  const head = kind === 'const' ? `const ${name} ` : (kind === 'let' ? `let ${name} ` : `function ${name}(`);
  const i = src.indexOf(head);
  if (i < 0) throw new Error('本番コードに ' + name + ' が見つからない');
  const rest = src.slice(i);
  const end = rest.search(/\n(?:async function |function |const |let |\/\/ ──)/);
  return rest.slice(0, end > 0 ? end : rest.length);
}

const parts = [
  extract('LAP_READOUT_KINDS', 'const'),
  extract('BEST_ONLY_KINDS',   'const'),
  extract('LAP_READOUT_POLICIES', 'const'),
  extract('lapReadoutCleanCount', 'let'),
  extract('lapReadoutLastCleanCountFromBridge', 'let'),
  extract('_hasCleanEvidenceFields', 'fn'),
  extract('_extractCleanEvidence', 'fn'),
  extract('_judgeCleanFromEvidence', 'fn'),
  extract('lapReadoutPolicyAllows', 'fn'),
  extract('resetLapReadoutCounter', 'fn'),
].join('\n');

function runInContext(contractRaw) {
  const store = { getItem: (k) => (k === 'pw_contract' && contractRaw !== null ? contractRaw : null) };
  const sandbox = {
    localStorage: store,
    console, Set, Array,
    Number, String, Math, JSON,
    lastTelemetry: null,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(parts
    + '\nglobalThis.gate = lapReadoutPolicyAllows;'
    + '\nglobalThis.resetCounter = resetLapReadoutCounter;', ctx);
  return { gate: sandbox.gate, reset: sandbox.resetCounter };
}

// --- Unsigned contract: enforcement off (backwards compatible). -------------
const unsigned = runInContext(JSON.stringify({ signed: false, pace: { readout: 'off' } }));
check('unsigned contract lets lap_time through (backwards compatible)',
  unsigned.gate('lap_time', { lap_valid_clean: true }).allow === true);
check('unsigned contract exposes the trace policy',
  unsigned.gate('lap_time', { lap_valid_clean: true }).policy === 'contract_unsigned');

// --- off: everything silenced (even best). ----------------------------------
const off = runInContext(JSON.stringify({ signed: true, pace: { readout: 'off' } }));
check('off silences lap_time',      off.gate('lap_time', { lap_valid_clean: true }).allow === false);
check('off silences personal_best', off.gate('personal_best', { lap_valid_clean: true }).allow === false);
check('off silences session_best',  off.gate('session_best', {}).allow === false);
check('off silences first_lap',     off.gate('first_lap', { lap_valid_clean: true }).allow === false);
check('off silences lap_slow',      off.gate('lap_slow', {}).allow === false);

// --- best_only: only PB/SB pass. --------------------------------------------
const bestOnly = runInContext(JSON.stringify({ signed: true, pace: { readout: 'best_only' } }));
check('best_only allows personal_best',  bestOnly.gate('personal_best', {}).allow === true);
check('best_only allows session_best',   bestOnly.gate('session_best', {}).allow === true);
check('best_only silences lap_time',     bestOnly.gate('lap_time', { lap_valid_clean: true }).allow === false);
check('best_only silences lap_consistent', bestOnly.gate('lap_consistent', {}).allow === false);
check('best_only silences first_lap',    bestOnly.gate('first_lap', {}).allow === false);
check('best_only silences lap_slow',     bestOnly.gate('lap_slow', {}).allow === false);

// --- every_clean_lap: uses bridge evidence. ---------------------------------
const clean = runInContext(JSON.stringify({ signed: true, pace: { readout: 'every_clean_lap' } }));
check('every_clean_lap: personal_best always speaks (celebrate)',
  clean.gate('personal_best', { lap_valid_clean: false }).allow === true);
check('every_clean_lap: session_best always speaks',
  clean.gate('session_best', { lap_valid_clean: false }).allow === true);
check('every_clean_lap: lap_time on clean lap speaks',
  clean.gate('lap_time', { lap_valid_clean: true, incidents_this_lap: 0 }).allow === true);
check('every_clean_lap: lap_time on lap flagged not-clean is silenced',
  clean.gate('lap_time', { lap_valid_clean: false }).allow === false);
check('every_clean_lap: lap_time with incidents_this_lap>0 (no flag) is silenced',
  clean.gate('lap_time', { incidents_this_lap: 2 }).allow === false);
check('every_clean_lap: lap_time on pit_in lap is silenced',
  clean.gate('lap_time', { pit_in_this_lap: true }).allow === false);
check('every_clean_lap: lap_time on pit_out lap is silenced',
  clean.gate('lap_time', { pit_out_this_lap: true }).allow === false);
check('every_clean_lap: lap_time on off_track lap is silenced',
  clean.gate('lap_time', { off_track_this_lap: true }).allow === false);
check('every_clean_lap: no bridge evidence at all → safe side (allow) with trace',
  clean.gate('lap_time', {}, null).allow === true
  && clean.gate('lap_time', {}, null).telemetry_missing === true);

// --- every_2_laps: 2nd of the clean lap candidates. -------------------------
const every2 = runInContext(JSON.stringify({ signed: true, pace: { readout: 'every_2_laps' } }));
check('every_2_laps: personal_best always speaks even on odd count',
  every2.gate('personal_best', { lap_valid_clean: true, clean_lap_candidate_count: 1 }).allow === true);
check('every_2_laps: session_best always speaks',
  every2.gate('session_best', { lap_valid_clean: false }).allow === true);
check('every_2_laps: 1st clean candidate is silenced (odd)',
  every2.gate('lap_time', { lap_valid_clean: true, clean_lap_candidate_count: 1 }).allow === false);
check('every_2_laps: 2nd clean candidate speaks (even)',
  every2.gate('lap_time', { lap_valid_clean: true, clean_lap_candidate_count: 2 }).allow === true);
check('every_2_laps: 3rd clean candidate silenced, 4th speaks',
  every2.gate('lap_time', { lap_valid_clean: true, clean_lap_candidate_count: 3 }).allow === false
  && every2.gate('lap_time', { lap_valid_clean: true, clean_lap_candidate_count: 4 }).allow === true);
check('every_2_laps: dirty lap is always silenced regardless of count',
  every2.gate('lap_time', { lap_valid_clean: false, clean_lap_candidate_count: 2 }).allow === false);
check('every_2_laps: falls back to local counter when bridge count absent',
  (() => {
    const g = runInContext(JSON.stringify({ signed: true, pace: { readout: 'every_2_laps' } }));
    g.reset();
    // First clean candidate (counter -> 1, odd → silenced)
    const r1 = g.gate('lap_time', { lap_valid_clean: true });
    // Second clean candidate (counter -> 2, even → speaks)
    const r2 = g.gate('lap_time', { lap_valid_clean: true });
    // Third clean candidate (counter -> 3, odd → silenced)
    const r3 = g.gate('lap_time', { lap_valid_clean: true });
    return r1.allow === false && r2.allow === true && r3.allow === false;
  })());

// --- Unknown legacy policy value falls back to allow with trace. ------------
const legacy = runInContext(JSON.stringify({ signed: true, pace: { readout: 'every_lap' } }));
check('legacy every_lap value falls back to allow with trace marker',
  legacy.gate('lap_time', { lap_valid_clean: true }).allow === true
  && legacy.gate('lap_time', { lap_valid_clean: true }).policy === 'unknown_falls_back_to_every_clean_lap');

// --- Non-lap-readout triggers are transparent. ------------------------------
check('non-lap-readout triggers pass regardless of policy',
  every2.gate('fuel_strategy_warning', {}).allow === true
  && every2.gate('fuel_strategy_warning', {}).policy === 'not_lap_readout');

// --- Renderer wiring & UI. --------------------------------------------------
check('renderer defines the final 4 policy names',
  html.includes("const LAP_READOUT_POLICIES = ['off','best_only','every_2_laps','every_clean_lap'];"));
check('renderer exposes _extractCleanEvidence and _judgeCleanFromEvidence',
  html.includes('function _extractCleanEvidence(data, telemetry)')
  && html.includes('function _judgeCleanFromEvidence(ev)'));
check('renderer tracks the clean-lap fallback counter',
  html.includes('let lapReadoutCleanCount = 0;'));
check('injectRadio passes lastTelemetry into the gate',
  html.includes('lapReadoutPolicyAllows(data.trigger, data, lastTelemetry)'));
check('session-num reset clears the clean-lap counter',
  html.includes('try{ resetLapReadoutCounter(); }catch(_){}'));

// --- Settings UI: final 4 options. ------------------------------------------
check('Settings has the final 4 options',
  html.includes('id="lap-readout-select"')
  && html.includes('value="off"')
  && html.includes('value="best_only"')
  && html.includes('value="every_2_laps"')
  && html.includes('value="every_clean_lap"'));
check('Settings does NOT expose the removed every_lap / none options',
  !html.includes('value="every_lap"')
  && !html.includes('value="none"'));
check('hydrateLapReadoutSelect uses the final 4-option whitelist',
  html.includes("const known = ['off','best_only','every_2_laps','every_clean_lap'];"));
check('onLapReadoutChanged resets the counter on policy change',
  /function onLapReadoutChanged\(\)\{[\s\S]*?resetLapReadoutCounter\(\)/.test(html));
check('DEFAULT_CONTRACT default is every_clean_lap (safe side)',
  html.includes("pace:     { readout: 'every_clean_lap'"));

console.log(`✅ lap readout policy: ${pass} checks`);
