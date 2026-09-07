// SIGINT/SIGTERM 検査用。数秒かかる的テスト。
const fs = require('fs');
fs.appendFileSync(__dirname + '/fixtures/mutate-selftest/runs.log', 'slow\n');
const t = require('./fixtures/mutate-selftest/target.js');
const end = Date.now() + 6000;
while (Date.now() < end) { /* busy wait */ }
if (t.flag !== 'GOOD') process.exit(1);
console.log('[mutate selftest slow] OK');
