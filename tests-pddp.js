'use strict';
const assert = require('assert');
const { analyze, nextFocus, briefingLine } = require('./desktop/pddp');

const rows = [
  { finishPos: 12, incidents: 2, irating: 1800 },
  { finishPos: 18, incidents: 9, irating: 1700 },
  { finishPos: 15, incidents: 8, irating: 1750 },
];
const s = analyze(rows);
assert.strictEqual(s.sample_size, 3);
assert.strictEqual(s.primary_focus, 'incident_control');
assert.strictEqual(Math.round(s.average_incidents * 10) / 10, 6.3);
assert.strictEqual(nextFocus(s).key, 'incident_control');
assert.match(briefingLine(s, '八木さん'), /平均Incidents 6\.3/);
assert.doesNotMatch(briefingLine(s), /2500|3000/);
assert.strictEqual(analyze([{ incidents: null, irating: null }]).average_incidents, null);
console.log('[PDDP] 合格 6 / 不合格 0');

