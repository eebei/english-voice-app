'use strict';
const fs = require('fs');
const memoryLayer = require('./desktop/memory-action-layer');
const playbook = require('./desktop/strategy-playbook');

let pass = 0;
function check(name, condition, detail = '') {
  if (!condition) throw new Error(`${name}: ${detail}`);
  pass++;
}

const stored = {
  'Mercedes-AMG GT3 2020|monza full': {
    car: 'Mercedes-AMG GT3 2020', track: 'monza full', sessions: 19,
    bestLap: 107.684, avgLap: 108.3, avgLapSampleCount: 19,
  },
  'Mercedes-AMG GT3 2020|Autodromo Nazionale Monza': {
    car: 'Mercedes-AMG GT3 2020', track: 'Autodromo Nazionale Monza', sessions: 1,
    avgFuel: 3.678, fuelSampleCount: 6, fuelSampleTotal: 22.068,
    avgLap: 108.1, avgLapSampleCount: 1,
  },
  'Chevrolet Corvette Z06 GT3.R|monza full': {
    car: 'Chevrolet Corvette Z06 GT3.R', track: 'monza full', sessions: 3,
    avgFuel: 3.9, fuelSampleCount: 4,
  },
};

check('Monza display and iRacing short names have one identity',
  memoryLayer.normalizeTrack('Autodromo Nazionale Monza') === memoryLayer.normalizeTrack('monza full'));
const resolved = memoryLayer.resolve(stored, 'Autodromo Nazionale Monza', 'Mercedes-AMG GT3 2020', 'GT3');
check('split Monza records are both recovered', resolved && resolved.memoryRecordCount === 2, JSON.stringify(resolved));
check('historical session count survives the alias merge', resolved.sessions === 20, JSON.stringify(resolved));
check('fuel evidence from the new display-name key is recovered', resolved.avgFuel === 3.678 && resolved.fuelSampleCount === 6);
check('lap evidence from the old short-name key is recovered', Math.abs(resolved.avgLap - 108.29) < 0.001, String(resolved.avgLap));
check('different GT3 model cannot contaminate memory', !resolved.matchedKeys.some(key => key.includes('Corvette')));
check('Nürburgring layouts remain distinct',
  memoryLayer.normalizeTrack('Nürburgring Combined Short') !== memoryLayer.normalizeTrack('Nürburgring Nordschleife'));

// ★Build 265 fix D：Monza layouts must stay separate.  A "monza gpsecondchicane"
//   record (skip-first-chicane layout) is a DIFFERENT track from Monza Full GT
//   and its evidence must not be pooled into monza:full.
check('monza gpsecondchicane must not normalize to monza:full',
  memoryLayer.normalizeTrack('monza gpsecondchicane') !== memoryLayer.normalizeTrack('monza full'),
  `${memoryLayer.normalizeTrack('monza gpsecondchicane')} vs ${memoryLayer.normalizeTrack('monza full')}`);
check('monza gpsecondchicane keeps its own canonical key',
  memoryLayer.normalizeTrack('monza gpsecondchicane') === 'monza:gpsecondchicane',
  memoryLayer.normalizeTrack('monza gpsecondchicane'));
check('monza gp (bare) still resolves to monza:full',
  memoryLayer.normalizeTrack('monza gp') === 'monza:full');
check('autodromo nazionale monza still resolves to monza:full',
  memoryLayer.normalizeTrack('Autodromo Nazionale Monza') === 'monza:full');
// A regression pool that includes the second-chicane record must not
// contaminate a Monza Full lookup for the same car.
const contaminated = {
  ...stored,
  'Mercedes-AMG GT3 2020|monza gpsecondchicane': {
    car: 'Mercedes-AMG GT3 2020', track: 'monza gpsecondchicane', sessions: 4,
    avgFuel: 4.8, fuelSampleCount: 5,
  },
};
const monzaFullOnly = memoryLayer.resolve(contaminated, 'Autodromo Nazionale Monza', 'Mercedes-AMG GT3 2020', 'GT3');
check('Monza Full lookup ignores the second-chicane record',
  !monzaFullOnly.matchedKeys.some(k => k.includes('gpsecondchicane')),
  JSON.stringify(monzaFullOnly.matchedKeys));
check('stale unavailable profile statements are rejected',
  memoryLayer.isStaleUnavailableNote('現在の前後GAPは取得できない。') === true);
check('real driver preference remains actionable',
  memoryLayer.isStaleUnavailableNote('無線は要点だけ短くしてほしい。') === false);

const debriefRecords = [
  { review_id:'old-other-track', driver:'Yuji', updated_at:'2026-08-12T10:00:00Z',
    scope:{track:'Spa',car:'Mercedes-AMG GT3 2020'}, qa:[{question:'どこが課題？',answer:'ブレーキング'}] },
  { review_id:'monza-review', driver:'Yuji', updated_at:'2026-08-13T10:00:00Z',
    scope:{track:'Autodromo Nazionale Monza',car:'Mercedes-AMG GT3 2020'},
    qa:[
      {question:'今日いちばん良かった判断は？',answer:'ターン1で無理をしなかった'},
      {question:'製品への感想は？',answer:'無線が少し多い'}
    ] },
];
const followUp = memoryLayer.selectDebriefFollowUp(debriefRecords, {
  driver:'Yuji', track:'monza full', car:'Mercedes-AMG GT3 2020'
});
check('matching debrief evidence becomes one next-session follow-up',
  followUp && followUp.key === 'monza-review:0' && /ターン1/.test(followUp.answer), JSON.stringify(followUp));
check('product feedback is never repurposed as driving follow-up',
  followUp && !/製品/.test(followUp.question));
check('already used follow-up is not asked again',
  memoryLayer.selectDebriefFollowUp(debriefRecords, {
    driver:'Yuji', track:'monza full', car:'Mercedes-AMG GT3 2020', usedKeys:['monza-review:0']
  }) === null);
check('different car-or-track evidence never becomes a follow-up',
  memoryLayer.selectDebriefFollowUp(debriefRecords, {
    driver:'Yuji', track:'Spa', car:'BMW M4 GT3'
  }) === null);

const provisional = playbook.buildPlaybook({
  track: 'Autodromo Nazionale Monza', car: 'Mercedes-AMG GT3 2020',
  raceDetail: { session_type: 'Race', session_time: '1200 sec' },
  historicalFuelPerLapL: resolved.avgFuel, historicalFuelSamples: resolved.fuelSampleCount,
  historicalAverageLapS: resolved.avgLap, effectiveCapacityL: 23.32,
  qualifyingPosition: 15, classEntryCount: 20,
  memoryEvidence: { source: resolved.source, recordCount: resolved.memoryRecordCount,
    sessionCount: resolved.sessions, matchedKeys: resolved.matchedKeys,
    canonicalTrack: resolved.canonicalTrack, canonicalCar: resolved.canonicalCar },
});
check('resolved history produces a pre-start Plan A/B/C', provisional.available === true, JSON.stringify(provisional));
check('playbook trace identifies both recovered records',
  provisional.evidence.memory_record_count === 2 && provisional.evidence.historical_session_count === 20);
check('proactive briefing says that stored session history was used',
  /保存履歴20セッション/.test(playbook.briefing(provisional, 'ja')));

const revised = playbook.updateWithLive(provisional, {
  fuel_strategy: { clean_laps_sampled: 3, avg_fuel_per_lap: 3.7 },
});
check('three clean live laps replace the provisional memory value',
  revised.source === 'live_clean_laps' && revised.evidence.live_fuel_l_per_lap === 3.7);
check('memory provenance survives the three-lap live revision',
  revised.evidence.memory_record_count === 2 && revised.evidence.historical_session_count === 20);

const renderer = fs.readFileSync(__dirname + '/desktop/renderer.html', 'utf8');
check('desktop loads the Memory Action Layer before the strategy engine',
  renderer.indexOf('memory-action-layer.js') < renderer.indexOf('strategy-playbook.js'));
check('runtime traces all four required action phases',
  renderer.includes("phase:'history_resolved'")
  && renderer.includes("phase:'proactive_strategy_briefing'")
  && renderer.includes("phase:'three_lap_live_revision'")
  && renderer.includes("phase:'structured_evidence_correction'"));
check('session transition clears every proactive strategy latch',
  renderer.includes("strategyPlaybookRefreshKey=''")
  && renderer.includes('activeStrategyPlaybook=null'));

console.log(`✅ Memory Action Layer: ${pass} checks`);
