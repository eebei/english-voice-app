// 変異ランナー自己検査の「的」テスト。fixtures/mutate-selftest/target.js の flag だけを見る。
// ★実行のたびに runs.log へ1行足す。「テストを一切実行していない」ことを
//   呼び出し側（tests-mutate-runner.js）が数えられるようにするため。
const fs = require('fs');
fs.appendFileSync(__dirname + '/fixtures/mutate-selftest/runs.log', 'run\n');
const t = require('./fixtures/mutate-selftest/target.js');
if (t.flag !== 'GOOD') { console.error('❌ flag=' + t.flag); process.exit(1); }
console.log('[mutate selftest] flag OK');
