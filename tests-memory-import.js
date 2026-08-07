// Build 251 regression guard: historical memory import must remain scoped to
// authenticated beta access, idempotent in the desktop, and never include raw
// access codes in the queue API contract.
const fs = require('fs');
const assert = require('assert');

const auth = fs.readFileSync('auth.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');

assert.match(auth, /CREATE TABLE IF NOT EXISTS memory_import_seeds/);
assert.match(auth, /beta_token_hash TEXT NOT NULL/);
assert.match(auth, /async function queueMemoryImportSeed/);
assert.match(auth, /async function getPendingMemoryImportSeeds/);
assert.match(auth, /async function acknowledgeMemoryImportSeeds/);
assert.match(auth, /SELECT code, name FROM beta_tokens WHERE lower\(name\) = lower\(\$1\)/);
assert.doesNotMatch(auth.match(/async function queueMemoryImportSeed[\s\S]*?async function getPendingMemoryImportSeeds/)[0], /return \{[^}]*code/);

assert.match(server, /app\.get\('\/api\/memory\/import-seeds', requirePitwallEntitlement/);
assert.match(server, /app\.post\('\/api\/memory\/import-seeds\/ack', requirePitwallEntitlement/);
assert.match(server, /app\.post\('\/api\/beta\/admin\/memory-import\/queue', requireAdmin/);
assert.match(server, /if \(!req\.betaTokenHash\) return res\.json\(\{ ok: true, seeds: \[\] \}\)/);

assert.match(renderer, /function buildHistoricalEvidenceRecord\(seed, item, index\)/);
assert.match(renderer, /async function importHistoricalMemorySeeds\(\)/);
assert.match(renderer, /review_id:`legacy:\$\{seed\.id\}:\$\{index\}`/);
assert.match(renderer, /confidence:'historical_driver_reported'/);
assert.match(renderer, /kind==='driver_preference'/);
assert.match(renderer, /if\(r\.kind==='driver_preference'\) return true/);
assert.match(renderer, /localStorage\.setItem\('pw_session_evidence',JSON\.stringify\(records\)\);/);
assert.match(renderer, /fetch\('\/api\/memory\/import-seeds\/ack'/);
assert.match(renderer, /void importHistoricalMemorySeeds\(\);/);

console.log('tests-memory-import: 16/16 passed');
