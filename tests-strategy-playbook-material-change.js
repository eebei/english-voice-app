'use strict';
// Build 265 fix B regression: strategy speech spam control.
//
// Once the playbook is live-latched, only material change may speak:
//   - selected plan changes
//   - first pit lap changes by ≥1
//   - stop count changes
//   - required fuel-saving crosses a defined threshold (1%)
// A 5-lap rolling burn change from 3.64 → 3.65 that leaves the plan
// unchanged must be silent.  Lifecycle-ending states (final lap / checker /
// finished / debrief) must never emit a P3 strategy update.

const fs = require('fs');
const playbook = require('./desktop/strategy-playbook');

let pass = 0;
function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}: ${detail}`);
  pass++;
}

const monza = playbook.buildPlaybook({
  track: 'monza full', car: 'Mercedes-AMG GT3 2020',
  raceDetail: { session_type: 'Race', session_time: '2100 sec' },
  historicalFuelPerLapL: 3.64, historicalFuelSamples: 3,
  historicalAverageLapS: 108.7, effectiveCapacityL: 53,
  pitLaneS: 18.3, qualifyingPosition: 3, classEntryCount: 20,
});
const monzaLive = playbook.updateWithLive(monza, {
  fuel_strategy: { clean_laps_sampled: 3, avg_fuel_per_lap: 3.64 },
});
check('base playbook was promoted to live', monzaLive.source === 'live_clean_laps');
const monzaLive2 = playbook.updateWithLive(monzaLive, {
  fuel_strategy: { clean_laps_sampled: 4, avg_fuel_per_lap: 3.65 },
});
check('burn 3.64 → 3.65 without plan change still returns a distinct object',
  monzaLive2 !== monzaLive);
check('first pit lap survives the small burn revision',
  monzaLive2.plans.A.first_pit_lap === monzaLive.plans.A.first_pit_lap,
  `${monzaLive.plans.A.first_pit_lap} -> ${monzaLive2.plans.A.first_pit_lap}`);
check('stop count survives the small burn revision',
  monzaLive2.plans.A.stop_count === monzaLive.plans.A.stop_count);
check('selected plan survives the small burn revision',
  monzaLive2.selected_plan === monzaLive.selected_plan);
const saveDelta = Math.abs((monzaLive2.plans.C.required_fuel_saving_pct || 0)
                         - (monzaLive.plans.C.required_fuel_saving_pct || 0));
check('required fuel saving delta is under the 1% material threshold',
  saveDelta < 1.0, `delta = ${saveDelta}`);

// A large burn increase that pushes plan A's first pit lap by 2 is material.
const heavyBurn = playbook.updateWithLive(monzaLive, {
  fuel_strategy: { clean_laps_sampled: 3, avg_fuel_per_lap: 5.0 },
});
check('a materially-heavier burn changes at least the first pit lap',
  heavyBurn.plans.A.first_pit_lap !== monzaLive.plans.A.first_pit_lap,
  `${monzaLive.plans.A.first_pit_lap} -> ${heavyBurn.plans.A.first_pit_lap}`);

const renderer = fs.readFileSync(__dirname + '/desktop/renderer.html', 'utf8');
check('renderer defines the material-change helper',
  renderer.includes('function playbookMaterialSignature(pb)')
  && renderer.includes('function playbookMaterialChanged(prev, next)'));
check('read-only live update does not create local promotion speech',
  /function updateStrategyPlaybookFromLive\(live\)\{[^]*?return currentStrategyPlaybook\(\);\n\}/.test(renderer)
  && !renderer.includes('const promotedToLive ='));
check('canonical announcement binds immutable current record',
  renderer.includes('const key=JSON.stringify(st.pit_plan.record_ref||st.pit_plan);')
  && renderer.includes('strategyBinding:binding,precheck:()=>strategyProjection.validBinding(binding)'));
check('canonical announcement dedupes repeated publication of the same record',
  renderer.includes('if(strategyPlaybookBriefedKey===key) return;'));

console.log(`✅ strategy playbook material change: ${pass} checks`);
