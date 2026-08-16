/* Cross-PC Chief Engineer contract checks.  These are source-level guards for
 * the three required links: separate-PC settings, authenticated server relay,
 * and next-driver-only consumption. */
const fs = require('fs');
let pass = 0, fail = 0;
function check(name, ok) { if (ok) { pass++; console.log('✅', name); } else { fail++; console.error('❌', name); } }

const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
const auth = fs.readFileSync('auth.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

check('Team Link Code is a settings field', renderer.includes('id="chief-team-code"'));
check('Each PC declares its own driver', renderer.includes('id="chief-this-driver"'));
check('Outgoing Bridge handoff is published', renderer.includes('publishChiefTeamHandoff(data.packet||{})'));
check('Receiver only consumes its named next-driver handoff', renderer.includes('packet.next_driver_index!==cfg.this_driver_index'));
check('Receiver de-duplicates a delivered handoff', renderer.includes('chiefLastReceivedHandoffId'));
check('Receiver polls the team relay', renderer.includes('setInterval(()=>pollChiefTeamHandoff(false),10000)'));
check('Team code is stored only as a SHA-256 key', auth.includes("crypto.createHash('sha256').update('pitwall-chief-team:v1:' + code)"));
check('Team handoff payload is compact and schema-checked', auth.includes('function cleanChiefPacket(raw)'));
check('Relay requires existing PITWALL entitlement', server.includes("app.post('/api/chief/handoff', chiefShareLimiter, express.json(), requirePitwallEntitlement"));
check('Relay read requires existing PITWALL entitlement', server.includes("app.get('/api/chief/handoff', chiefShareLimiter, requirePitwallEntitlement"));
check('No team code column is persisted', !auth.includes('team_code TEXT'));

console.log(`\n[chief cross-PC] ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
