#!/usr/bin/env node
'use strict';

// Build 272: execute the production endurance announcement function with no
// network, TTS or browser.  This proves generation, dedupe and driver wording
// rather than merely checking that strings exist in renderer.html.

const fs = require('fs');
const vm = require('vm');

const renderer = fs.readFileSync(__dirname + '/desktop/renderer.html', 'utf8');
const bridge = fs.readFileSync(__dirname + '/irsdk-bridge/bridge.py', 'utf8');
const start = renderer.indexOf('function maybeAnnounceEnduranceFuelForecast(');
const end = renderer.indexOf('\nfunction captureConfirmedFuelCapacity(', start);
if (start < 0 || end < 0) throw new Error('production endurance radio function not found');
const fnSource = renderer.slice(start, end);

let checks = 0;
function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}: ${detail}`);
  checks++;
}

function harness() {
  const spoken = [];
  const traces = [];
  const context = {
    lastSessionType: 'Race',
    lastSessionNum: 4,
    enduranceForecastAnnouncedKey: '',
    enduranceFuelWindowAnnouncedKey: '',
    isSessionEndingLifecycle: () => false,
    isJapaneseEngineer: () => true,
    addMsg: () => {},
    pushMsg: () => {},
    speak: (text, meta) => spoken.push({ text, meta }),
    diagnosticLog: (kind, detail) => traces.push({ kind, detail }),
    SPEAK_PRIO: { P2_CRITICAL: 2, P3_STRATEGY: 3 },
    Number, String, Math, JSON,
  };
  vm.createContext(context);
  vm.runInContext(fnSource, context);
  return { context, spoken, traces };
}

const early = harness();
early.context.maybeAnnounceEnduranceFuelForecast({
  session_type: 'Race', lap: 5,
  endurance_fuel_plan: { available: true, multi_stop: true,
    next_fuel_stop_in_laps: 22, future_stop_count: 4,
    splash_forecast: { available: false } },
});
check('12h early stint stays silent', early.spoken.length === 0, JSON.stringify(early.spoken));

const window = harness();
const t1 = { session_type: 'Race', lap: 20,
  endurance_fuel_plan: { available: true, multi_stop: true,
    next_fuel_stop_in_laps: 1, future_stop_count: 4,
    splash_forecast: { available: false } } };
window.context.maybeAnnounceEnduranceFuelForecast(t1);
window.context.maybeAnnounceEnduranceFuelForecast(t1);
check('fuel window T-1 speaks once', window.spoken.length === 1, JSON.stringify(window.spoken));
check('fuel window call is concise', window.spoken[0].text === '次周ボックス。通常給油。', window.spoken[0].text);
check('fuel window uses critical priority', window.spoken[0].meta.prio === 2, JSON.stringify(window.spoken[0]));

const splash = harness();
const secondHalf = { session_type: 'Race', lap: 80,
  endurance_fuel_plan: { available: true, multi_stop: true,
    next_fuel_stop_in_laps: 8, future_stop_count: 2,
    splash_forecast: { available: true, splash_candidate: true,
      projected_final_service_l: 8.4,
      avoid_splash_save_l_per_lap: 0.14,
      avoid_splash_feasible: true } } };
splash.context.maybeAnnounceEnduranceFuelForecast(secondHalf);
splash.context.maybeAnnounceEnduranceFuelForecast(secondHalf);
check('second-half splash forecast speaks once', splash.spoken.length === 1, JSON.stringify(splash.spoken));
check('splash forecast gives service and per-lap target',
  splash.spoken[0].text === '終盤スプラッシュ約8.4L見込み。回避には毎周0.14Lセーブ。', splash.spoken[0].text);

check('Bridge imports endurance fuel authority', bridge.includes('import endurance_fuel as endurance_fuel_mod'));
check('Bridge passes current-stint verdict into P0 authority', bridge.includes('endurance_plan=_endurance_plan'));
check('Bridge telemetry exposes endurance plan', bridge.includes("'endurance_fuel_plan': ("));
check('Bridge radio never uses whole-race total for requested stop',
  bridge.includes("_warning_requested_add = max(") && bridge.includes("session_effective_fuel_capacity_l or 0.0"));

console.log(`✅ endurance radio and bridge wiring: ${checks} checks`);
