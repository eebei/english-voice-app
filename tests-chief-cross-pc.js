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
// The Bridge packet is enriched with the confirmed Team Plan before it leaves
// this PC; the publish itself must still happen on every driver change.
check('Outgoing Bridge handoff is published',
  renderer.includes('const outgoingPacket={...(data.packet||{}),team_plan:teamSection};')
  && renderer.includes('publishChiefTeamHandoff(outgoingPacket)'));
check('Receiver only consumes its named next-driver handoff', renderer.includes('packet.next_driver_index!==cfg.this_driver_index'));
check('Receiver de-duplicates a delivered handoff', renderer.includes('chiefLastReceivedHandoffId'));
check('Receiver polls the team relay', renderer.includes('setInterval(()=>pollChiefTeamHandoff(false),10000)'));
check('Team code is stored only as a SHA-256 key', auth.includes("crypto.createHash('sha256').update('pitwall-chief-team:v1:' + code)"));
check('Team handoff payload is compact and schema-checked', auth.includes('function cleanChiefPacket(raw)'));
check('Measured tyre handoff is schema-checked', auth.includes('tire_report: tireSummary'));
check('Final-service splash horizon is schema-checked', auth.includes('endurance_splash: enduranceSplash'));
check('Relay requires existing PITWALL entitlement', server.includes("app.post('/api/chief/handoff', chiefShareLimiter, express.json(), requirePitwallEntitlement"));
check('Relay read requires existing PITWALL entitlement', server.includes("app.get('/api/chief/handoff', chiefShareLimiter, requirePitwallEntitlement"));
check('No team code column is persisted', !auth.includes('team_code TEXT'));

// ── 2026-08-29: the relay must not silently drop the Team Plan section ──
// A whitelist that forgets a new field turns a completed tunnel back into a
// one-sided UI.  Exercise the real sanitiser, not a copy of it.
{
  const authMod = require('./auth.js');
  const TP = require('./desktop/team-plan.js');
  let plan = TP.confirmCandidate({
    state: TP.ingestHumanInput({
      state: TP.startBriefing({ state: TP.emptyState(), lang: 'ja', now: '2026-08-29T00:00:00.000Z' }).state,
      text: 'ピットは30周で入る', lang: 'ja', now: '2026-08-29T00:00:00.000Z'
    }).state, lang: 'ja', now: '2026-08-29T00:00:00.000Z'
  }).state;
  const section = TP.buildHandoffTeamSection({
    state: plan,
    evidence: TP.evidenceSnapshot({
      fuel: 60.2, fuel_strategy: { avg_fuel_per_lap: 6.1, clean_laps_sampled: 4 },
      weather: { track_temp_c: 24.0 }, tire_measurement: { available: false }
    }),
    stintSummary: TP.summarizeStint({
      driver_name: 'Driver One', driver_index: 0,
      laps: [{ lap: 1, lap_time_s: 505.0, valid_clean: true, incidents: 0, fuel_used_l: 6.1 }],
      pit_events: [{ entry_lap: 30, repair: false }]
    })
  });
  const relayed = authMod.cleanChiefPacket({
    handoff_id: 'ch-testfixture-0001', roster: ['Driver One', 'Driver Two'],
    selected_plan: 'A', next_driver_index: 1, team_plan: section
  });
  check('Relay keeps the confirmed Team Plan revision',
    !!relayed && relayed.team_plan && relayed.team_plan.plan_revision === 1
    && !!relayed.team_plan.plan_fields.initial_pit_plan);
  check('Relay keeps measured evidence and the outgoing stint summary',
    !!relayed && relayed.team_plan.evidence.clean_laps_sampled === 4
    && relayed.team_plan.stint_summary.driver_name === 'Driver One');
  check('Relay keeps unmeasured tyres unmeasured',
    !!relayed && relayed.team_plan.evidence.tires.available === false
    && Object.keys(relayed.team_plan.evidence.tires.corners).length === 0);
  check('Relay never promotes an unconfirmed plan',
    authMod.cleanChiefTeamPlan({ schema: 'team_plan_v1', plan_status: 'none',
      plan_fields: { fuel_policy: { value: 'full tank' } },
      stint_summary: { driver_name: 'x' } }).plan_status === 'none');
  check('Relay rejects an unknown plan schema',
    authMod.cleanChiefTeamPlan({ schema: 'something_else', plan_status: 'confirmed' }) === null);
  check('Relay does not invent an incident count',
    authMod.cleanChiefTeamPlan({ schema: 'team_plan_v1', plan_status: 'none',
      stint_summary: { driver_name: 'x', incidents: null } }).stint_summary.incidents === null);
}

console.log(`\n[chief cross-PC] ${pass} passed / ${fail} failed`);
process.exitCode = fail ? 1 : 0;
