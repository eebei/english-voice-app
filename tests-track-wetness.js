#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {buildSystem, formatTrackWetness} = require('./prompts');

let pass = 0;
function check(label, ok) {
  if (!ok) throw new Error(label);
  console.log('✅ ' + label);
  pass++;
}

const expectedJP = [
  'ドライ', 'ほぼドライ', 'ごくわずかに濡れている', 'わずかに濡れている',
  '適度に濡れている', 'かなり濡れている', '極めて濡れている'
];
expectedJP.forEach((label, index) =>
  check(`enum ${index + 1} -> ${label}`, formatTrackWetness(index + 1, true) === label));

[null, undefined, 0, 8, -1, 1.5, '2'].forEach(value =>
  check(`invalid value fails closed: ${String(value)}`, formatTrackWetness(value, true) === null));

const jp = buildSystem({
  character: 'LunaJP', mode: 'race', telemetry: 'live',
  liveData: {weather: {track_temp_c: 25, track_wetness_code: 2}}
});
check('code 2 is rendered as mostly dry', jp.suffix.includes('路面状態：ほぼドライ'));
check('wetness is never rendered as a percentage',
  !jp.suffix.includes('ウェット率') && !jp.suffix.includes('200%'));

const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');
check('bridge reads TrackWetness as an integer enum',
  bridge.includes("track_wet_code = reader.read_int('TrackWetness')"));
check('bridge rejects unknown and out-of-range enum values',
  bridge.includes('if track_wet_code not in range(1, 8):'));
check('old ratio contract is absent',
  !bridge.includes("reader.read_float('TrackWetness')") &&
  !bridge.includes("'track_wetness': round(track_wet"));

console.log(`\n${pass} checks passed`);
