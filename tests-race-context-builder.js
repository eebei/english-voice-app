#!/usr/bin/env node
'use strict';
// WO014: canonical LLM race-context builder — permanent regression suite.
//
// Proves the residual-scope items closed in this revise pass:
//  1. strict schema identity/ref/bounds (reject available:true+race_identity:
//     null+active_plan:{}, the exact parent prompt-probe repro).
//  2. calculation_references carry calculation_source; black_flag carries its
//     raw SDK evidence; allowed_actions carries constraint/proof;
//     historical_relevant_memory carries real canonical terminal records
//     (not an always-empty array).
//  3. auxiliary_observations is only populated when the arrival-time ref tag
//     (race/session/epoch/snapshot id+sequence/source_frame sequence) matches
//     the CURRENT canonical snapshot exactly — a stale/mismatched tag falls
//     to unknown, never a raw position/GAP read.
//  4. prompts.js never falls back to legacy live.fuel/live.lap for a modern
//     caller whose context is invalid/unavailable (the actual leak the
//     parent reproduced with poisoned fuel=777.25/lap=888), while a genuinely
//     legacy caller (no raceContext at all) keeps the old fallback.
//  5. active_plan/pending_proposal/penalty_state/last_pit_event/
//     allowed_actions/unknowns reach the actual LLM system prompt
//     (previously built but never serialized — "promptconsumer未接続").
//
// Uses the REAL canonical-lifecycle-cache + strategy-state-projection modules
// (via tests-canonical-lifecycle.js's fixture()) rather than a hand-rolled
// projectionView mock, so the builder is exercised through its actual
// source->consumer path, not just a pure-function echo of fabricated input.

const fs = require('fs');
const WO017Scope = require('./tests-wo017-memory-scope-harness');
const vm = require('vm');
const RaceContextBuilder = require('./desktop/race-context-builder');
const CanonicalCache = require('./desktop/canonical-lifecycle-cache');
const StrategyProjection = require('./desktop/strategy-state-projection');
const { fixture: canonicalFixture } = require('./tests-canonical-lifecycle');
const { buildSystem } = require('./prompts');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
// WO015: every current-race caller below (follow-up/main/pace/judge/auto)
// now also calls strategyNumericFactBinding() -- a pure top-level helper
// defined far above any of their own extracted source slices -- to fence a
// reply that itself asserts a stale numeric fuel/lap/position/gap value.
// It must be injected alongside every one of those slices or the call
// throws ReferenceError inside each caller's own try/catch, which silently
// drops the reply instead of speaking it (no stack trace surfaces).
// WO015 residual ("verifiedaux GAP/position"): all 5 callers also call
// strategyReplyBindingValid() (which calls
// verifiedAuxFieldsStillFresh()/captureVerifiedAuxBinding()), and
// strategyNumericFactBinding() itself now calls the shared
// _hasUnqualifiedCurrentNumericMention() sentence classifier (defined
// immediately before it). All five are pure top-level helpers co-located
// contiguously from _hasUnqualifiedCurrentNumericMention through
// strategyReplyBindingValid, up to (not including) `async function
// callAPI` -- sliced as one block and kept under the SAME variable name so
// every existing injection site below picks up the fix automatically.
const numericFactBindingSrc = (() => {
  const start = renderer.indexOf('function _hasUnqualifiedCurrentNumericMention(text,keywordRe){');
  const end = renderer.indexOf('\nasync function callAPI', start);
  return (start >= 0 && end > start) ? renderer.slice(start, end) : null;
})();

let pass = 0, fail = 0;
check('actual strategyNumericFactBinding() extracted from renderer.html', !!numericFactBindingSrc);
function check(label, ok) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label);
  ok ? pass++ : fail++;
}

// ── real canonical plumbing: available + rich-evidence scenario ──────────
function buildAvailableProjection() {
  const snap = canonicalFixture({ frame: 10, decision: 'd-active' });
  snap.continuity.stable_scope = { race_instance_id: snap.race_instance_id, session_num: snap.session_num, driver_id: 7 };
  snap.recommendations = { fuel_strategy: { value: { avg_fuel_per_lap: 3.4 }, role: 'reference',
    calculation_source: { session_time_s: 90, source_frame_sequence: 9 } } };
  snap.lifecycle.terminal_records = [{
    decision_id: 'd-old', race_instance_id: snap.race_instance_id, session_num: snap.session_num, revision: 0,
    record_ref: { bridge_process_epoch: snap.bridge_process_epoch, race_instance_id: snap.race_instance_id, session_num: snap.session_num, decision_id: 'd-old', revision: 0 },
    selected_plan: 'B', target_lap: 5, add_fuel_l: null, set_fuel_l: null,
    expected_pit_sequence: null, resolved_pit_sequence: null, activated_source_frame_sequence: null, phase: 'cancelled',
  }];
  const cache = CanonicalCache.create({ now: () => 0 });
  const g = cache.beginSocket();
  cache.hello(g, { type: 'connected', schema_version: 1, bridge_process_epoch: snap.bridge_process_epoch });
  if (!cache.receive(snap, g)) throw new Error('fixture_invalid');
  return { cache, snap, projection: StrategyProjection.create({ canonical: cache, now: () => 0 }) };
}

const { cache: availCache, snap: availSnap, projection: availProjection } = buildAvailableProjection();
const freshAuxRef = { bridge_process_epoch: availSnap.bridge_process_epoch, canonical_snapshot_id: availSnap.snapshot_id,
  canonical_snapshot_sequence: availSnap.snapshot_sequence, race_instance_id: availSnap.race_instance_id,
  session_num: availSnap.session_num, source_frame_sequence: availSnap.source_frame.sequence };
const freshAuxRaw = { gap_ahead: 1.7, gap_behind: 0.6, leaders: { overall: { name: 'Rival' } }, pos: 5 };

function buildCtx(extra) {
  return RaceContextBuilder.build(Object.assign({
    projectionView: availProjection.current(), snapshot: availCache.current(),
    evaluation: availProjection.strategyEvaluation(), now: () => 1000,
  }, extra || {}));
}

// ── 1. available scenario: identity/active_plan/calc refs/penalty/proof ──
{
  const ctx = buildCtx();
  check('available ctx validates', RaceContextBuilder.validate(ctx, 1000));
  check('race_identity has real scope', ctx.race_identity.race_instance_id === availSnap.race_instance_id
    && ctx.race_identity.driver_id === 7);
  check('active_plan carries decision/revision/record_ref', ctx.active_plan
    && ctx.active_plan.decision_id === 'd-active' && ctx.active_plan.record_ref
    && ctx.active_plan.selected_plan === 'A');
  check('calculation_references.fuel_strategy carries calculation_source',
    ctx.calculation_references.fuel_strategy && ctx.calculation_references.fuel_strategy.source_valid
    && ctx.calculation_references.fuel_strategy.calculation_source
    && ctx.calculation_references.fuel_strategy.calculation_source.source_frame_sequence === 9);
  check('penalty_state.black_flag carries raw SDK evidence',
    ctx.penalty_state.black_flag.state === 'false'
    && ctx.penalty_state.black_flag.raw_value === 0
    && ctx.penalty_state.black_flag.source_frame_sequence === 10);
  check('allowed_actions carries constraint (execution gate evidence)',
    ctx.allowed_actions.constraint && ctx.allowed_actions.constraint.scope_closed === false
    && ctx.allowed_actions.constraint.collision === false);
  check('allowed_actions carries proof (box-delivery binding)',
    ctx.allowed_actions.proof && ctx.allowed_actions.proof.allowed_proof_id === 'p'
    && ctx.allowed_actions.proof.allowed_attempt_id === 'a');
  check('historical_relevant_memory carries real canonical terminal records, not an always-empty array',
    Array.isArray(ctx.historical_relevant_memory) && ctx.historical_relevant_memory.length === 1
    && ctx.historical_relevant_memory[0].role === 'canonical_observed_history'
    && ctx.historical_relevant_memory[0].decision_id === 'd-old'
    && ctx.historical_relevant_memory[0].phase === 'cancelled');
}

// ── 2. auxiliary_observations: verified only on exact ref correlation ────
{
  const noAux = buildCtx();
  check('no aux tag -> auxiliary_observations null + unknown listed',
    noAux.auxiliary_observations === null
    && noAux.unknowns.includes('auxiliary_observations:source_frame_correlation_unavailable'));

  const matched = buildCtx({ auxSourceRef: freshAuxRef, auxRaw: freshAuxRaw });
  check('matching arrival-time ref tag -> verified_observation with real gap/position',
    matched.auxiliary_observations && matched.auxiliary_observations.role === 'verified_observation'
    && matched.auxiliary_observations.gap_ahead === 1.7 && matched.auxiliary_observations.position === 5
    && !matched.unknowns.includes('auxiliary_observations:source_frame_correlation_unavailable'));

  const staleRef = Object.assign({}, freshAuxRef, { canonical_snapshot_sequence: freshAuxRef.canonical_snapshot_sequence + 1 });
  const stale = buildCtx({ auxSourceRef: staleRef, auxRaw: freshAuxRaw });
  check('mismatched snapshot_sequence (canonical advanced since capture) -> aux falls to unknown, not a stale read',
    stale.auxiliary_observations === null
    && stale.unknowns.includes('auxiliary_observations:source_frame_correlation_unavailable'));

  const wrongFrame = Object.assign({}, freshAuxRef, { source_frame_sequence: freshAuxRef.source_frame_sequence + 1 });
  const staleFrame = buildCtx({ auxSourceRef: wrongFrame, auxRaw: freshAuxRaw });
  check('mismatched source_frame sequence -> aux falls to unknown',
    staleFrame.auxiliary_observations === null);
}

// ── 3. unavailable scenario (no canonical connected) ──────────────────────
{
  const unavailCache = CanonicalCache.create({ now: () => 0 });
  const unavailProjection = StrategyProjection.create({ canonical: unavailCache, now: () => 0 });
  const ctx = RaceContextBuilder.build({ projectionView: unavailProjection.current(), snapshot: unavailCache.current(),
    evaluation: unavailProjection.strategyEvaluation(), auxSourceRef: freshAuxRef, auxRaw: freshAuxRaw, now: () => 1000 });
  check('unavailable ctx validates (fail-closed invariants hold)', RaceContextBuilder.validate(ctx, 1000));
  check('unavailable: current_facts/active_plan/race_identity/execution/aux all closed',
    ctx.current_facts.available === false && ctx.active_plan === null && ctx.race_identity === null
    && ctx.allowed_actions.execution_allowed === false && ctx.auxiliary_observations === null);
}

// ── 4. validate() rejects the exact parent prompt-probe repro ────────────
{
  const hostile = {
    schema: 'pitwall_race_context', schema_version: 1, generated_at: 1000, unknowns: [],
    race_identity: null,
    // freshness publication/source_frame refs are valid here on purpose: the
    // round2 freshness-requiredness check (desktop/race-context-builder.js)
    // would otherwise reject every object below for that UNRELATED reason,
    // masking whether the race_identity/active_plan/fuel-bounds check under
    // test is actually the one doing the rejecting (mutation-isolation).
    freshness: { available: true, reason: null, canonical_snapshot_id: 's1', canonical_snapshot_sequence: 1, source_frame_sequence: 1, session_time_s: 10 },
    current_facts: { available: true, fuel_level_l: 777.25, current_lap: 888, on_pit_road: null, on_track: null, finish: { available: false, remaining_sf_crossings: null } },
    penalty_state: { black_flag: { state: 'unknown', freshness: 'unavailable', authority: null, raw_value: null, observed_session_time: null, source_frame_sequence: null } },
    active_plan: {}, pending_proposal: null, last_driver_action: null, last_pit_event: null,
    allowed_actions: { execution_allowed: true, execution_hold_reason: null },
    calculation_references: {}, auxiliary_observations: null, historical_relevant_memory: [],
  };
  check('REJECT available:true + race_identity:null + active_plan:{} (parent repro)', !RaceContextBuilder.validate(hostile, 1000));

  const validIdentity = { race_instance_id: 'r', session_num: 1, driver_id: 1, bridge_process_epoch: null };
  const emptyPlan = Object.assign({}, hostile, { race_identity: validIdentity, active_plan: {} });
  check('REJECT active_plan:{} even with a valid race_identity (missing decision_id/record_ref/selected_plan)',
    !RaceContextBuilder.validate(emptyPlan, 1000));

  // Isolated: in-bounds current_facts + active_plan:null (no active_plan or
  // fuel/lap-bounds check involved at all) so only the race_identity check
  // can be responsible for the rejection -- otherwise a mutation that
  // disables just the identity check could "survive" by hiding behind the
  // fuel-bounds or active_plan check firing for its own unrelated reason
  // (the hostile object above also carries fuel=777.25/lap=888).
  const cleanFacts = { available: true, fuel_level_l: 50, current_lap: 10, on_pit_road: false, on_track: true, finish: { available: false, remaining_sf_crossings: null } };
  const identityOnly = Object.assign({}, hostile, { race_identity: null, active_plan: null, current_facts: cleanFacts });
  check('REJECT available:true + race_identity:null in isolation (clean facts, active_plan:null, no other trigger)',
    !RaceContextBuilder.validate(identityOnly, 1000));

  // Isolated: active_plan has revision/record_ref/selected_plan (so the
  // SECOND active_plan check would pass) but is missing decision_id, so
  // only the FIRST active_plan check (decision_id) can be responsible.
  const missingDecisionId = Object.assign({}, hostile, { race_identity: validIdentity, current_facts: cleanFacts,
    active_plan: { revision: 0, record_ref: { bridge_process_epoch: 'e', race_instance_id: 'r', session_num: 1, decision_id: 'd', revision: 0 }, selected_plan: 'A' } });
  check('REJECT active_plan missing decision_id in isolation (clean facts, revision/record_ref/selected_plan otherwise valid)',
    !RaceContextBuilder.validate(missingDecisionId, 1000));

  const poisonFuel = Object.assign({}, hostile, { race_identity: validIdentity, active_plan: null,
    current_facts: Object.assign({}, hostile.current_facts, { fuel_level_l: 777.25, current_lap: 10 }) });
  check('REJECT fuel_level_l=777.25 (out-of-bounds raw poison value)', !RaceContextBuilder.validate(poisonFuel, 1000));

  const poisonLap = Object.assign({}, hostile, { race_identity: validIdentity, active_plan: null,
    current_facts: Object.assign({}, hostile.current_facts, { fuel_level_l: 50, current_lap: 888888 }) });
  check('REJECT current_lap=888888 (out-of-bounds raw poison value)', !RaceContextBuilder.validate(poisonLap, 1000));

  const staleGenerated = Object.assign({}, hostile, { race_identity: validIdentity, active_plan: null,
    current_facts: { available: false, fuel_level_l: null, current_lap: null, on_pit_road: null, on_track: null, finish: { available: false, remaining_sf_crossings: null } },
    freshness: { available: false, reason: 'canonical_unavailable', canonical_snapshot_id: null, canonical_snapshot_sequence: null, source_frame_sequence: null, session_time_s: null },
    race_identity: null, allowed_actions: { execution_allowed: false, execution_hold_reason: 'canonical_unavailable' },
    generated_at: 1000 });
  check('context built just now (within deadline) validates', RaceContextBuilder.validate(staleGenerated, 1000));
  const reallyStale = Object.assign({}, staleGenerated, { generated_at: 1000 - 25000 });
  check('REJECT a context whose generated_at is older than the 20s deadline', !RaceContextBuilder.validate(reallyStale, 1000));

  const badAge = Object.assign({}, staleGenerated, { calculation_references: { fuel_strategy: { value: null, role: 'reference', age_s: 999999, source_valid: true, diagnostic: null, calculation_source: null } } });
  check('REJECT a source_valid calculation_reference with an absurd age_s', !RaceContextBuilder.validate(badAge, 1000));
}

// ── 4b. round2 residual scope: identity/ref/bounds the parent independent
// review found still missing after round1 (record_ref cross-scope match,
// finish/active_plan/aux numeric bounds, freshness publication/source_frame
// requiredness, historical_relevant_memory per-item ref/bounds, and the
// source_valid:true+age/calculation_source:null gap in calcRefValid) ──────
{
  const base = JSON.parse(JSON.stringify(buildCtx()));
  check('sanity: cloned real ctx (active_plan+finish+history) still validates', RaceContextBuilder.validate(base, base.generated_at));

  const crossRace = JSON.parse(JSON.stringify(base));
  crossRace.active_plan.record_ref.race_instance_id = 'other-race';
  check('REJECT active_plan.record_ref pointing at a different race_instance_id', !RaceContextBuilder.validate(crossRace, crossRace.generated_at));

  const crossSession = JSON.parse(JSON.stringify(base));
  crossSession.active_plan.record_ref.session_num = 99;
  check('REJECT active_plan.record_ref pointing at a different session_num', !RaceContextBuilder.validate(crossSession, crossSession.generated_at));

  const staleRevision = JSON.parse(JSON.stringify(base));
  staleRevision.active_plan.record_ref.revision = 7;
  check('REJECT active_plan.record_ref revision mismatching active_plan.revision (stale ref)', !RaceContextBuilder.validate(staleRevision, staleRevision.generated_at));

  const wrongDecision = JSON.parse(JSON.stringify(base));
  wrongDecision.active_plan.record_ref.decision_id = 'd-other';
  check('REJECT active_plan.record_ref decision_id mismatching active_plan.decision_id', !RaceContextBuilder.validate(wrongDecision, wrongDecision.generated_at));

  const wrongEpoch = JSON.parse(JSON.stringify(base));
  wrongEpoch.active_plan.record_ref.bridge_process_epoch = 'epoch-rogue';
  check('REJECT active_plan.record_ref bridge_process_epoch mismatching race_identity epoch', !RaceContextBuilder.validate(wrongEpoch, wrongEpoch.generated_at));

  const hugeLap = JSON.parse(JSON.stringify(base));
  hugeLap.active_plan.target_lap = 999999;
  check('REJECT active_plan.target_lap out of bounds', !RaceContextBuilder.validate(hugeLap, hugeLap.generated_at));

  const hugeFuel = JSON.parse(JSON.stringify(base));
  hugeFuel.active_plan.add_fuel_l = 9999;
  check('REJECT active_plan.add_fuel_l out of bounds', !RaceContextBuilder.validate(hugeFuel, hugeFuel.generated_at));

  const negFinish = JSON.parse(JSON.stringify(base));
  negFinish.current_facts.finish.remaining_sf_crossings = -1;
  check('REJECT current_facts.finish.remaining_sf_crossings negative', !RaceContextBuilder.validate(negFinish, negFinish.generated_at));

  const availableFinishNullCrossings = JSON.parse(JSON.stringify(base));
  availableFinishNullCrossings.current_facts.finish.remaining_sf_crossings = null;
  check('REJECT current_facts.finish.available:true with remaining_sf_crossings:null', !RaceContextBuilder.validate(availableFinishNullCrossings, availableFinishNullCrossings.generated_at));

  const noSnapshotId = JSON.parse(JSON.stringify(base));
  noSnapshotId.freshness.canonical_snapshot_id = null;
  check('REJECT freshness.available:true with canonical_snapshot_id:null', !RaceContextBuilder.validate(noSnapshotId, noSnapshotId.generated_at));

  const noSourceFrame = JSON.parse(JSON.stringify(base));
  noSourceFrame.freshness.source_frame_sequence = null;
  check('REJECT freshness.available:true with source_frame_sequence:null', !RaceContextBuilder.validate(noSourceFrame, noSourceFrame.generated_at));

  const auxBase = JSON.parse(JSON.stringify(base));
  // round3: aux.source_ref must now match THIS SAME ctx's own race_identity/
  // freshness refs (previously "an object" like {a:1} was accepted) -- build
  // a source_ref that actually correlates with `base`'s real identity, the
  // same way the real builder's auxCorrelated check would have produced.
  auxBase.auxiliary_observations = {
    role: 'verified_observation',
    source_ref: {
      race_instance_id: base.race_identity.race_instance_id, session_num: base.race_identity.session_num,
      bridge_process_epoch: base.race_identity.bridge_process_epoch,
      canonical_snapshot_id: base.freshness.canonical_snapshot_id,
      canonical_snapshot_sequence: base.freshness.canonical_snapshot_sequence,
      source_frame_sequence: base.freshness.source_frame_sequence,
    },
    gap_ahead: 1, gap_behind: 1, position: 5, class_position: 3,
    leaders: { overall: { name: 'Rival', car_number: '12', class_name: 'GT3', car_idx: 4, gap_s: 20 }, player_class: null },
    standings_gaps: { 3: 1.2, 7: -2.5 },
  };
  check('sanity: in-bounds auxiliary_observations validates', RaceContextBuilder.validate(auxBase, auxBase.generated_at));

  const auxBadSourceRef = JSON.parse(JSON.stringify(auxBase));
  auxBadSourceRef.auxiliary_observations.source_ref = { a: 1 };
  check('REJECT auxiliary_observations.source_ref not correlated with this ctx\'s own identity/freshness',
    !RaceContextBuilder.validate(auxBadSourceRef, auxBadSourceRef.generated_at));

  const auxBadLeaders = JSON.parse(JSON.stringify(auxBase));
  auxBadLeaders.auxiliary_observations.leaders = { overall: { gap_s: 99999 }, player_class: null };
  check('REJECT auxiliary_observations.leaders.overall.gap_s out of bounds', !RaceContextBuilder.validate(auxBadLeaders, auxBadLeaders.generated_at));

  const auxBadStandingsGaps = JSON.parse(JSON.stringify(auxBase));
  auxBadStandingsGaps.auxiliary_observations.standings_gaps = { notAnInt: 1 };
  check('REJECT auxiliary_observations.standings_gaps with a non-position key', !RaceContextBuilder.validate(auxBadStandingsGaps, auxBadStandingsGaps.generated_at));

  const auxHugeGap = JSON.parse(JSON.stringify(auxBase));
  auxHugeGap.auxiliary_observations.gap_ahead = 999999;
  check('REJECT auxiliary_observations.gap_ahead out of bounds', !RaceContextBuilder.validate(auxHugeGap, auxHugeGap.generated_at));

  const auxHugePosition = JSON.parse(JSON.stringify(auxBase));
  auxHugePosition.auxiliary_observations.position = 99999;
  check('REJECT auxiliary_observations.position out of bounds', !RaceContextBuilder.validate(auxHugePosition, auxHugePosition.generated_at));

  const auxHugeLeaders = JSON.parse(JSON.stringify(auxBase));
  auxHugeLeaders.auxiliary_observations.leaders = new Array(500).fill({ name: 'x' });
  check('REJECT auxiliary_observations.leaders array too large', !RaceContextBuilder.validate(auxHugeLeaders, auxHugeLeaders.generated_at));

  const histBase = JSON.parse(JSON.stringify(base));
  histBase.historical_relevant_memory = [{ role: 'canonical_observed_history', decision_id: 'd-old', revision: 0, phase: 'cancelled',
    record_ref: { bridge_process_epoch: base.race_identity.bridge_process_epoch, race_instance_id: base.race_identity.race_instance_id, session_num: base.race_identity.session_num, decision_id: 'd-old', revision: 0 },
    selected_plan: 'B', target_lap: 5 }];
  check('sanity: in-bounds historical_relevant_memory with matching record_ref validates', RaceContextBuilder.validate(histBase, histBase.generated_at));

  const histMissingRevision = JSON.parse(JSON.stringify(histBase));
  delete histMissingRevision.historical_relevant_memory[0].revision;
  check('REJECT historical_relevant_memory item missing revision', !RaceContextBuilder.validate(histMissingRevision, histMissingRevision.generated_at));

  const histHugeLap = JSON.parse(JSON.stringify(histBase));
  histHugeLap.historical_relevant_memory[0].target_lap = 999999;
  check('REJECT historical_relevant_memory item target_lap out of bounds', !RaceContextBuilder.validate(histHugeLap, histHugeLap.generated_at));

  const histCrossRace = JSON.parse(JSON.stringify(histBase));
  histCrossRace.historical_relevant_memory[0].record_ref.race_instance_id = 'other-race';
  check('REJECT historical_relevant_memory item record_ref from a different race_instance_id', !RaceContextBuilder.validate(histCrossRace, histCrossRace.generated_at));

  const histRefRevisionMismatch = JSON.parse(JSON.stringify(histBase));
  histRefRevisionMismatch.historical_relevant_memory[0].record_ref.revision = 3;
  check('REJECT historical_relevant_memory item record_ref.revision mismatching its own revision', !RaceContextBuilder.validate(histRefRevisionMismatch, histRefRevisionMismatch.generated_at));

  const histTooMany = JSON.parse(JSON.stringify(histBase));
  histTooMany.historical_relevant_memory = new Array(500).fill(histBase.historical_relevant_memory[0]);
  check('REJECT historical_relevant_memory with more than the bounded-array limit', !RaceContextBuilder.validate(histTooMany, histTooMany.generated_at));

  // round3: only race_instance_id was cross-checked against the current
  // scope -- a record_ref from a DIFFERENT session_num within the SAME
  // race_instance_id previously passed ("history現在raceのみ一致でsession
  // 本人scope未検査").
  const histCrossSession = JSON.parse(JSON.stringify(histBase));
  histCrossSession.historical_relevant_memory[0].record_ref.session_num = base.race_identity.session_num + 1;
  check('REJECT historical_relevant_memory item record_ref from a different session_num (same race_instance_id)',
    !RaceContextBuilder.validate(histCrossSession, histCrossSession.generated_at));

  // A past decision from BEFORE a process restart legitimately keeps its own
  // original epoch -- epoch is intentionally NOT required to match the
  // current one, only race_instance_id/session_num/its own decision_id+rev.
  const histDifferentEpochOk = JSON.parse(JSON.stringify(histBase));
  histDifferentEpochOk.historical_relevant_memory[0].record_ref.bridge_process_epoch = 'an-earlier-process-epoch';
  check('historical_relevant_memory item with a DIFFERENT epoch (legitimate pre-restart history) still validates',
    RaceContextBuilder.validate(histDifferentEpochOk, histDifferentEpochOk.generated_at));

  // round3: raceIdentity.bridge_process_epoch===null used to SKIP the
  // active_plan.record_ref epoch comparison entirely (any ref epoch
  // "matched"). Must fail closed instead ("available epoch:nullでrecord
  // epoch照合bypass").
  const nullEpochIdentity = JSON.parse(JSON.stringify(base));
  nullEpochIdentity.race_identity.bridge_process_epoch = null;
  check('REJECT active_plan.record_ref when race_identity.bridge_process_epoch is null (cannot verify, must not bypass)',
    !RaceContextBuilder.validate(nullEpochIdentity, nullEpochIdentity.generated_at));

  // calcRefValid: source_valid:true previously allowed age_s/calculation_source
  // to be null -- a stale/untraceable calculation could claim "trust me".
  const calcNoAge = JSON.parse(JSON.stringify(base));
  calcNoAge.calculation_references.fuel_strategy = { value: { x: 1 }, role: 'reference', age_s: null, source_valid: true, diagnostic: null, calculation_source: { source_frame_sequence: 1 } };
  check('REJECT calculation_references source_valid:true with age_s:null', !RaceContextBuilder.validate(calcNoAge, calcNoAge.generated_at));

  const calcNoSource = JSON.parse(JSON.stringify(base));
  calcNoSource.calculation_references.fuel_strategy = { value: { x: 1 }, role: 'reference', age_s: 10, source_valid: true, diagnostic: null, calculation_source: null };
  check('REJECT calculation_references source_valid:true with calculation_source:null', !RaceContextBuilder.validate(calcNoSource, calcNoSource.generated_at));

  // round4 residual ("Server pit scope/bounds"): last_pit_event previously
  // only had to be "an object" -- its own event_ref race/session/event-id
  // consistency and service numeric bounds were never checked by validate(),
  // so an HTTP caller could forge a different-race/session pit service onto
  // an otherwise-current context. epoch is intentionally NOT required to
  // match (same precedent as historical_relevant_memory: a pit from before a
  // Bridge restart legitimately keeps its own original epoch).
  const pitBase = JSON.parse(JSON.stringify(base));
  pitBase.last_pit_event = {
    lap: 9, execution_relation: 'normal', pit_event_id: 'svc-validate',
    event_ref: { bridge_process_epoch: 'an-earlier-process-epoch', race_instance_id: base.race_identity.race_instance_id,
      session_num: base.race_identity.session_num, pit_event_id: 'svc-validate', driver_pit_sequence: 1 },
    service: { lane_total_s: 33.3, stall_s: 21.0, fuel_added_l: 44.4 }, source: 'bridge_canonical',
  };
  check('sanity: in-bounds last_pit_event (with a legitimately pre-restart epoch) validates',
    RaceContextBuilder.validate(pitBase, pitBase.generated_at));

  const pitCrossRace = JSON.parse(JSON.stringify(pitBase));
  pitCrossRace.last_pit_event.event_ref.race_instance_id = 'a-different-race';
  check('REJECT last_pit_event.event_ref pointing at a different race_instance_id',
    !RaceContextBuilder.validate(pitCrossRace, pitCrossRace.generated_at));

  const pitCrossSession = JSON.parse(JSON.stringify(pitBase));
  pitCrossSession.last_pit_event.event_ref.session_num = 99;
  check('REJECT last_pit_event.event_ref pointing at a different session_num',
    !RaceContextBuilder.validate(pitCrossSession, pitCrossSession.generated_at));

  const pitWrongId = JSON.parse(JSON.stringify(pitBase));
  pitWrongId.last_pit_event.event_ref.pit_event_id = 'some-other-event';
  check('REJECT last_pit_event.event_ref.pit_event_id mismatching last_pit_event.pit_event_id',
    !RaceContextBuilder.validate(pitWrongId, pitWrongId.generated_at));

  const pitHugeService = JSON.parse(JSON.stringify(pitBase));
  pitHugeService.last_pit_event.service.lane_total_s = 999999;
  check('REJECT last_pit_event.service.lane_total_s out of bounds',
    !RaceContextBuilder.validate(pitHugeService, pitHugeService.generated_at));

  const pitHugeFuel = JSON.parse(JSON.stringify(pitBase));
  pitHugeFuel.last_pit_event.service.fuel_added_l = 999999;
  check('REJECT last_pit_event.service.fuel_added_l out of bounds',
    !RaceContextBuilder.validate(pitHugeFuel, pitHugeFuel.generated_at));

  const pitNullService = JSON.parse(JSON.stringify(pitBase));
  pitNullService.last_pit_event.service = null;
  check('sanity: last_pit_event.service:null (event happened, no measured sample) still validates',
    RaceContextBuilder.validate(pitNullService, pitNullService.generated_at));

  const pitNoEventRef = JSON.parse(JSON.stringify(pitBase));
  pitNoEventRef.last_pit_event.event_ref = { a: 1 };
  check('REJECT last_pit_event.event_ref missing required identity fields',
    !RaceContextBuilder.validate(pitNoEventRef, pitNoEventRef.generated_at));
}

// ── 5. prompts.js: modern invalid/unavailable context never leaks raw live.* ──
{
  const authority = { track: 'monza', car_model: 'GT3', session_type: 'Race' };
  const poisonLive = { fuel: 777.25, lap: 888 };

  // Server-equivalent: a modern caller sent a context, but it failed
  // validate() (e.g. the parent's available:true+race_identity:null case) ->
  // server.js passes raceContext:null, raceContextModern:true.
  const rejected = buildSystem({ character: 'James', mode: 'race', telemetry: 'live', sessionAuthority: authority,
    liveData: poisonLive, raceContext: null, raceContextModern: true });
  check('modern caller + invalid/unavailable context: poisoned raw fuel never reaches the prompt',
    !rejected.suffix.includes('777.25'));
  check('modern caller + invalid/unavailable context: poisoned raw lap never reaches the prompt',
    !rejected.suffix.includes('Lap 888') && !rejected.suffix.includes('周回 888'));

  // Control: a genuinely legacy caller (never sent raceContext at all) keeps
  // the pre-WO014 fallback -- this is NOT the defect, and must not regress.
  const legacy = buildSystem({ character: 'James', mode: 'race', telemetry: 'live', sessionAuthority: authority,
    liveData: poisonLive });
  check('CONTROL: a truly legacy caller (no raceContext field at all) keeps the old live.* fallback',
    legacy.suffix.includes('777.25'));
}

// ── 6. prompts.js: active_plan/penalty/pit/allowed_actions/unknowns reach the prompt ──
{
  const authority = { track: 'monza', car_model: 'GT3', session_type: 'Race' };
  const ctx = buildCtx();
  const built = buildSystem({ character: 'James', mode: 'race', telemetry: 'live', sessionAuthority: authority,
    liveData: {}, raceContext: ctx, raceContextModern: true });
  check('active_plan reaches the prompt with its decision_id/revision (not current_facts/calc refs alone)',
    built.suffix.includes('d-active') && built.suffix.includes('[CANONICAL RACE STATE]'));
  check('execution authority (allowed_actions) reaches the prompt as its own fact',
    /Execution: (allowed|held)/.test(built.suffix));

  const held = Object.assign({}, ctx, { allowed_actions: Object.assign({}, ctx.allowed_actions, { execution_allowed: false, execution_hold_reason: 'box_authority_unavailable' }) });
  const builtHeld = buildSystem({ character: 'James', mode: 'race', telemetry: 'live', sessionAuthority: authority,
    liveData: {}, raceContext: held, raceContextModern: true });
  check('execution_hold_reason reaches the prompt verbatim when execution is held',
    builtHeld.suffix.includes('box_authority_unavailable'));

  const unavailCache = CanonicalCache.create({ now: () => 0 });
  const unavailProjection = StrategyProjection.create({ canonical: unavailCache, now: () => 0 });
  const unavailCtx = RaceContextBuilder.build({ projectionView: unavailProjection.current(), snapshot: unavailCache.current(),
    evaluation: unavailProjection.strategyEvaluation(), now: () => 1000 });
  const builtUnavail = buildSystem({ character: 'James', mode: 'race', telemetry: 'live', sessionAuthority: authority,
    liveData: { fuel: 777.25, lap: 888 }, raceContext: unavailCtx, raceContextModern: true });
  check('unavailable modern context: prompt states authority unavailable, no poisoned fuel/lap leak',
    builtUnavail.suffix.includes('Current strategy authority is unavailable') && !builtUnavail.suffix.includes('777.25'));

  // ── 6b. round2 residual scope: last_driver_action/Plan-fuel/proof/
  // strategy_options reference/historical_relevant_memory actually reach the
  // prompt (previously built by the race-context-builder but never
  // serialized -- "主要...を用途に沿って実promptへ接続") ──────────────────
  check('active_plan.add_fuel_l/set_fuel_l (Plan fuel) reaches the prompt',
    built.suffix.includes('7L') || /add 7L|追加7L/.test(built.suffix));
  check('allowed_actions.proof (box-delivery binding) reaches the prompt when execution is allowed',
    built.suffix.includes(' p ') || built.suffix.includes('proof p') || /proof p\b/.test(built.suffix));
  check('allowed_actions.proof.valid_until_session_s reaches the prompt',
    built.suffix.includes('105'));
  check('historical_relevant_memory (canonical observed past decision) reaches the prompt',
    built.suffix.includes('d-old') && built.suffix.includes('cancelled'));

  const heldWithConstraint = Object.assign({}, ctx, { allowed_actions: Object.assign({}, ctx.allowed_actions,
    { execution_allowed: false, execution_hold_reason: 'scope_closed', constraint: { scope_closed: true, collision: false, visit_open: false, gate_reason: null } }) });
  const builtHeldConstraint = buildSystem({ character: 'James', mode: 'race', telemetry: 'live', sessionAuthority: authority,
    liveData: {}, raceContext: heldWithConstraint, raceContextModern: true });
  check('allowed_actions.constraint evidence (why execution is held) reaches the prompt',
    /scope closed|スコープ終了/.test(builtHeldConstraint.suffix));

  const withOptRef = Object.assign({}, ctx, { calculation_references: Object.assign({}, ctx.calculation_references,
    { strategy_options: { value: { x: 1 }, role: 'reference', age_s: 12.5, source_valid: true, diagnostic: null, calculation_source: { source_frame_sequence: 1 } } }) });
  const builtOptRef = buildSystem({ character: 'James', mode: 'race', telemetry: 'live', sessionAuthority: authority,
    liveData: {}, raceContext: withOptRef, raceContextModern: true });
  check('calculation_references.strategy_options reference reaches the prompt (previously had zero consumer)',
    builtOptRef.suffix.includes('strategy_options') && builtOptRef.suffix.includes('12.5'));

  // last_driver_action needs a fixture where it is actually available --
  // the shared availCache fixture leaves it {available:false} by design.
  const ldaSnap = canonicalFixture({ frame: 10, decision: 'd-active' });
  ldaSnap.continuity.stable_scope = { race_instance_id: ldaSnap.race_instance_id, session_num: ldaSnap.session_num, driver_id: 7 };
  ldaSnap.last_driver_action = { available: true, action: { command_id: 'cmd-1', outcome: 'applied', reason: 'driver_confirmed', decision_id: 'd-active',
    bridge_process_epoch: ldaSnap.bridge_process_epoch, race_instance_id: ldaSnap.race_instance_id, session_num: ldaSnap.session_num,
    canonical_snapshot_id: ldaSnap.snapshot_id, canonical_snapshot_sequence: ldaSnap.snapshot_sequence } };
  const ldaCache = CanonicalCache.create({ now: () => 0 });
  const ldaG = ldaCache.beginSocket();
  ldaCache.hello(ldaG, { type: 'connected', schema_version: 1, bridge_process_epoch: ldaSnap.bridge_process_epoch });
  ldaCache.receive(ldaSnap, ldaG);
  const ldaProjection = StrategyProjection.create({ canonical: ldaCache, now: () => 0 });
  const ldaCtx = RaceContextBuilder.build({ projectionView: ldaProjection.current(), snapshot: ldaCache.current(),
    evaluation: ldaProjection.strategyEvaluation(), now: () => 1000 });
  check('sanity: last_driver_action fixture carries an available action', !!ldaCtx.last_driver_action && ldaCtx.last_driver_action.outcome === 'applied');
  const builtLda = buildSystem({ character: 'James', mode: 'race', telemetry: 'live', sessionAuthority: authority,
    liveData: {}, raceContext: ldaCtx, raceContextModern: true });
  check('last_driver_action (most recent driver command outcome) reaches the prompt',
    builtLda.suffix.includes('applied') && builtLda.suffix.includes('driver_confirmed'));
}

// ── 7. renderer.html wiring: all 5 current-race callers + aux plumbing ───
{
  const raceContextCallSites = renderer.match(/raceContext\s*:\s*buildCurrentRaceContext\(\)/g) || [];
  check('all 5 current-race callers (sendMessage/followUp/paceCheck/judgeCall/autoBriefing) pass raceContext',
    raceContextCallSites.length === 5);
  check('buildCurrentRaceContext feeds auxSourceRef from the arrival-time tag',
    /auxSourceRef:\s*lastTelemetryAuxRef/.test(renderer));
  check('buildCurrentRaceContext feeds auxRaw from the live gap/leaders/position fields',
    /auxRaw:\s*lastTelemetry\s*\?\s*\{gap_ahead:lastTelemetry\.gap_ahead/.test(renderer));
  check('telemetry_live handler captures the arrival-time ref BEFORE currentCanonicalStrategyLive overwrites it',
    /lastTelemetryAuxRef=\(typeof data\.bridge_process_epoch/.test(renderer)
    && renderer.indexOf('lastTelemetryAuxRef=(typeof data.bridge_process_epoch')
      < renderer.indexOf("lastTelemetry=currentCanonicalStrategyLive(applySessionFormatAuthority(data));"));
  check('session-boundary reset also clears lastTelemetryAuxRef (no stale tag survives a driver/session change)',
    /lastTelemetry=null;lastTelemetryAuxRef=null;/.test(renderer));
}

// ── 8. actual caller execution: real buildCurrentRaceContext -> actual
//      fetch payload -> actual reply/discard. deliverOperationalFollowUp is
//      one of the 5 current-race callers (the "followUp" caller), executed
//      here exactly as renderer.html defines it (only fetch/DOM/storage are
//      mocked) with a REAL race-context-builder output, not a hand-written
//      payload the test asserts against itself.
{
  const fuSrc = (renderer.match(/async function deliverOperationalFollowUp\(\)\{[\s\S]*?\n\}/) || [null])[0];
  check('actual deliverOperationalFollowUp() extracted from renderer.html', !!fuSrc);
  const src = fuSrc && numericFactBindingSrc ? numericFactBindingSrc + '\n' + fuSrc : fuSrc;
  if (src) {
    const realCtx = buildCtx({ auxSourceRef: freshAuxRef, auxRaw: freshAuxRaw });
    function makeCallerContext() {
      const requests = [];
      const spoken = [];
      const display = [];
      const ctx = {
        pendingOperationalFollowUp: { running: false, originalText: '燃料足りる？', intent: 'fuel', key: 'k1' },
        lastTelemetry: { fuel: 50 }, selMode: 'race', sel: 'James', userName: 'Yuji',
        iracingLive: true, bridgeConnected: true, lastSessionType: 'Race', lastSessionAuthority: null,
        driverState: 'track', driverActivity: 'driving', lastCarClass: 'GT3', usageSessionId: 'u1',
        isSessionEndingLifecycle: () => false,
        localStorage: { getItem: () => null },
        currentCanonicalStrategyLive: (live) => live,
        buildCurrentRaceContext: () => realCtx,
        // WO014 round3: deliverOperationalFollowUp now captures
        // strategyProjection.binding('facts') alongside raceContext and
        // re-validates it after the reply arrives (previously this was the
        // one caller of the 5 with NO post-reply freshness fence at all).
        strategyProjection: availProjection,
        applyPitwallAccess: () => {}, costApiCall: () => {}, costRecord: () => {},
        normalizeLunaSpeech: (t) => t,
        API_BASE: '', SPEAK_PRIO: { P3_STRATEGY: 3 },
        addMsg: (who, text) => { display.push(text); }, pushMsg: () => null,
        speak: (text) => { spoken.push(text); },
        diagnosticLog: () => {},
        fetch: async (_url, req) => {
          requests.push(JSON.parse(req.body));
          return { ok: true, json: async () => ({ content: [{ text: '燃料は十分、このまま継続。' }] }) };
        },
      };
      ctx.window = ctx; ctx.globalThis = ctx;
      WO017Scope.install(ctx); vm.createContext(ctx);
      return { ctx, requests, spoken, display };
    }

    const { ctx, requests, spoken } = makeCallerContext();
    vm.runInContext(src, ctx);
    ctx.deliverOperationalFollowUp().then(() => {
      check('actual caller sent exactly one request to /api/chat', requests.length === 1);
      check('actual sent payload.raceContext deep-equals the real builder output (no re-shaping/loss in transit)',
        requests.length === 1 && JSON.stringify(requests[0].raceContext) === JSON.stringify(realCtx));
      check('actual sent payload carries the real active_plan decision_id', requests.length === 1
        && requests[0].raceContext.active_plan && requests[0].raceContext.active_plan.decision_id === 'd-active');
      check('actual Server reply was spoken (not discarded) for a normal in-progress follow-up',
        spoken.length === 1 && spoken[0].includes('継続'));

      // Negative/discard case: a session-ending lifecycle transition between
      // arming the follow-up and this delivery attempt must discard it --
      // no stale reply about an old race state should ever be sent or spoken.
      const { ctx: ctx2, requests: requests2, spoken: spoken2 } = makeCallerContext();
      ctx2.isSessionEndingLifecycle = () => true;
      vm.runInContext(src, ctx2);
      ctx2.deliverOperationalFollowUp().then(() => {
        check('session-ending lifecycle discards the pending follow-up before ever sending a request',
          requests2.length === 0 && spoken2.length === 0);

        // Mid-flight fence (round3): deliverOperationalFollowUp previously had
        // NO post-reply freshness re-check at all (unlike the other 4
        // current-race callers). A canonical change arriving strictly between
        // binding-capture (request build) and reply-processing must discard
        // the stale reply, same fence shape as paceCheck/judgeCall/autoBriefing.
        const fuBase = canonicalFixture({ frame: 20, decision: 'd-active' });
        fuBase.continuity.stable_scope = { race_instance_id: fuBase.race_instance_id, session_num: fuBase.session_num, driver_id: 7 };
        const fuCache = CanonicalCache.create({ now: () => 0 });
        const fuG = fuCache.beginSocket();
        fuCache.hello(fuG, { type: 'connected', schema_version: 1, bridge_process_epoch: fuBase.bridge_process_epoch });
        fuCache.receive(fuBase, fuG);
        const fuProjection = StrategyProjection.create({ canonical: fuCache, now: () => 0 });
        const fuRealCtx = RaceContextBuilder.build({ projectionView: fuProjection.current(), snapshot: fuCache.current(),
          evaluation: fuProjection.strategyEvaluation(), now: () => 1000 });
        const { ctx: ctx3, requests: requests3, spoken: spoken3 } = makeCallerContext();
        ctx3.strategyProjection = fuProjection;
        ctx3.buildCurrentRaceContext = () => fuRealCtx;
        ctx3.fetch = async (_url, req) => {
          requests3.push(JSON.parse(req.body));
          const fuSnap2 = canonicalFixture({ frame: 21, decision: 'd-active', session: 2 });
          fuSnap2.continuity.stable_scope = { race_instance_id: fuSnap2.race_instance_id, session_num: 2, driver_id: 7 };
          fuCache.receive(fuSnap2, fuG);
          return { ok: true, json: async () => ({ content: [{ text: '燃料は十分、このまま継続。' }] }) };
        };
        vm.runInContext(src, ctx3);
        ctx3.deliverOperationalFollowUp().then(() => {
          check('mid-flight canonical change discards the follow-up reply (stale-binding fence, previously absent)',
            requests3.length === 1 && spoken3.length === 0);
          runCallApiCase();
        }).catch(e => { console.error(e); process.exitCode = 1; });
      }).catch(e => { console.error(e); process.exitCode = 1; });
    }).catch(e => { console.error(e); process.exitCode = 1; });
  } else {
    runCallApiCase();
  }
}

// ── 9. actual main callAPI() caller: same proof, for the "通常callAPI"
//      (main) current-race caller, reusing the same real-module/streaming-
//      fetch harness tests-callapi-stream-memory.js already validates for
//      callAPI()'s memory-box path -- here pointed at a REAL
//      buildCurrentRaceContext output instead of its memory-focused null stub.
function runCallApiCase() {
  const box = require('./desktop/conversation-memory-box.js');
  const det = require('./desktop/dispute-detector.js');
  function grabFn(name, isAsync) {
    const kw = isAsync ? 'async function ' : 'function ';
    const i = renderer.indexOf(kw + name + '(');
    if (i < 0) return null;
    const rest = renderer.slice(i);
    const end = rest.search(/\n\}\n/);
    return end < 0 ? null : rest.slice(0, end + 3);
  }
  const rawCallApiSrc = grabFn('callAPI', true);
  check('actual callAPI() extracted from renderer.html', !!rawCallApiSrc);
  if (!rawCallApiSrc) { finish(); return; }
  const callApiSrc = numericFactBindingSrc ? numericFactBindingSrc + '\n' + rawCallApiSrc : rawCallApiSrc;
  const memSrc = ['recordLunaTurn', 'ensureConversationBox', 'saveConversationBox',
    'conversationSessionKey', 'addMsg', 'convoLog'].map(n => grabFn(n, false));
  const judgeTagSrc = grabFn('stripProposalJudgeTag', false);
  // ★WO014 round3: the harness used to stub currentPlanReplyDependsOn() to
  // an unconditional `() => false` ("前testのfalse currentPlanReplyDependsOn
  // ...対象guardstubを禁止") instead of running callAPI()'s REAL text
  // heuristic. Extract and load the actual function, same technique as
  // every other callAPI() dependency here.
  const planDependsSrc = grabFn('currentPlanReplyDependsOn', false);
  check('actual currentPlanReplyDependsOn() extracted from renderer.html (not stubbed)', !!planDependsSrc);
  const judgeConstDecl = (renderer.match(/const PW_JUDGE_TAG_START = [\s\S]*?;/) || [''])[0]
    + '\n' + (renderer.match(/const PW_JUDGE_TAG_RE = [\s\S]*?;/) || [''])[0];
  const decls = (renderer.match(/const CONVO_BOX_KEY='[^']+';/) || [''])[0]
    + '\n' + (renderer.match(/let _convoBox=null;/) || [''])[0];
  check('callAPI memory-path dependencies extracted from renderer.html', memSrc.every(Boolean) && !!judgeTagSrc && !!planDependsSrc);
  if (!memSrc.every(Boolean) || !judgeTagSrc || !planDependsSrc) { finish(); return; }

  const realCtx = buildCtx({ auxSourceRef: freshAuxRef, auxRaw: freshAuxRaw });
  const requests = []; const spoken = []; const store = {};
  const enc = new TextEncoder();
  const REPLY = '燃料十分、このまま継続。';
  let idx = 0;
  const chunks = [REPLY];
  const ctx = {
    fetch: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return { ok: true, headers: { get: () => 'llm' },
        body: { getReader: () => ({ read: async () => (idx < chunks.length
          ? { done: false, value: enc.encode(chunks[idx++]) } : { done: true, value: undefined }) }) } };
    },
    TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout,
    Date, JSON, Math, String, Number, Error, RegExp, Promise, console,
    window: { PitwallConversationMemoryBox: box, PitwallDisputeDetector: det, PitwallReflexEvents: null },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { getElementById: () => ({ classList: { add(){}, remove(){} }, appendChild(){}, scrollTop: 0, scrollHeight: 0, value: '', style: {} }),
      createElement: () => ({ className: '', textContent: '' }) },
    usageCount(){}, applyPitwallAccess(){}, costApiCall(){}, costRecord(){},
    diagnosticLog(){}, mirrorToOverlay(){}, flushSentences(){}, t: (k) => String(k),
    forwardDriverDamageReport(){}, hydrateLegacyStrategyObjective: () => ({}),
    loadProfile: () => ({}), buildProfileNote: () => '', buildCarTrackMemory: () => '',
    buildPracticeProfileNote: () => '', buildFuelAuthorityNote: () => '',
    buildWeekendAuthorityNote: () => '', buildCurrentSessionFactNote: () => '',
    buildSessionEvidenceNote: () => '', buildContractNote: () => '',
    buildActiveRaceFactsNote: () => '', buildMemoryStatusNote: () => '',
    currentMemoryBrainPrompt: () => '', completeMemoryBrainTurn: () => null,
    buildRaceHistoryContext: () => '', buildNamedRivalNote: () => '',
    hasTelemetryOwnedVehicleClaim: () => false, normalizeLunaSpeech: (t) => t,
    speak: (t) => { spoken.push(t); }, applyProposalJudgeTag: () => {},
    currentStrategyStateAPI: () => null,
    currentCanonicalStrategyLive: (live) => live,
    // The one line that differs from tests-callapi-stream-memory.js: a REAL
    // race-context-builder output, not a null stub -- this is the point of
    // this section.
    buildCurrentRaceContext: () => realCtx,
    // WO014 round3: callAPI()'s _replyStrategyBinding now always captures
    // strategyProjection.binding('facts') (the raceContext reply fence),
    // even on the branch where currentPlanReplyDependsOn() returns false.
    strategyProjection: availProjection,canonicalLifecycleCache:availCache,performance:{now:()=>0},
    lastQueuedSpeakItem: null, _msgSeq: 0,
    pushMsg(m){ if(m && typeof m==='object' && !m._mid){ Object.defineProperty(m,'_mid',{value:'m'+(++ctx._msgSeq),enumerable:false,writable:true,configurable:true}); } ctx.messages.push(m); return m && m._mid ? m._mid : null; },
    sel: 'LunaJP', selMode: 'race', userName: 'Yuji', messages: [],
    turns: 0, sessionMsgCount: 0, isBusy: false,
    iracingLive: true, bridgeConnected: true, lastTelemetry: {}, lastTelemetryAt: Date.now(),
    lastSessionType: 'Race', lastSessionAuthority: null, lastCarClass: 'GT3',
    lastCarModel: 'AMG', lastTrack: 'Le Mans', lastSessionNum: 9,
    driverState: 'track', driverActivity: 'ACTIVE',
    API_BASE: '', usageBuild: 'test', usageSessionId: 's',
    currentMemoryUserId: () => 'Yuji', memorySavedThisSession: true, evidenceDebrief: null,
    responseIntent: null, responseAuthority: 'llm',
    SPEAK_PRIO: { P0_SAFETY: 0, P1_URGENT: 1, P2_PROCEDURE: 2, P3_INFO: 3, P4_INFO: 4 },
    jamesAutoMicEnabled: undefined, updateNamedRivalFromUser: () => null, lastSectors: () => null,
    speakReplyChunk: t => { spoken.push(t); },
  };
  ctx.globalThis = ctx; ctx.window.localStorage = ctx.localStorage;
  WO017Scope.install(ctx); vm.createContext(ctx);

  try {
    vm.runInContext(decls + '\n' + judgeConstDecl + '\n' + judgeTagSrc + '\n' + planDependsSrc + '\n' + WO017Scope.source(renderer) + memSrc.join('\n') + '\n' + callApiSrc
      + '\nthis.callAPI = callAPI;', ctx);
  } catch (e) {
    check('actual callAPI() loads into the harness context', false);
    console.error(e);
    finish(); return;
  }
  check('actual callAPI() loads into the harness context', true);

  ctx.callAPI('typed').then(() => {
    check('actual main callAPI() sent exactly one request to /api/chat', requests.length === 1);
    check('actual main-caller payload.raceContext deep-equals the real builder output',
      requests.length === 1 && JSON.stringify(requests[0].raceContext) === JSON.stringify(realCtx));
    check('actual main-caller payload carries the real active_plan decision_id', requests.length === 1
      && requests[0].raceContext.active_plan && requests[0].raceContext.active_plan.decision_id === 'd-active');
    check('actual Server reply (streamed) was spoken by the main caller',
      spoken.some(t => String(t).includes('継続')));

    // Mid-flight fence (round3 "callAPI/followup現在contextのfenceも接続"):
    // previously _replyStrategyBinding was null whenever
    // currentPlanReplyDependsOn() returned false (e.g. ordinary chat, no
    // plan/fuel keywords) -- ANY canonical change during such a reply's
    // streaming window was never checked at all. Now every main-caller reply
    // captures binding('facts') unconditionally; a canonical change arriving
    // between the first and second streamed chunk must still discard it.
    const caBase = canonicalFixture({ frame: 30, decision: 'd-active' });
    caBase.continuity.stable_scope = { race_instance_id: caBase.race_instance_id, session_num: caBase.session_num, driver_id: 7 };
    const caCache = CanonicalCache.create({ now: () => 0 });
    const caG = caCache.beginSocket();
    caCache.hello(caG, { type: 'connected', schema_version: 1, bridge_process_epoch: caBase.bridge_process_epoch });
    caCache.receive(caBase, caG);
    const caProjection = StrategyProjection.create({ canonical: caCache, now: () => 0 });
    const caRealCtx = RaceContextBuilder.build({ projectionView: caProjection.current(), snapshot: caCache.current(),
      evaluation: caProjection.strategyEvaluation(), now: () => 1000 });
    const requests2 = []; const spoken2 = []; const store2 = {};
    let idx2 = 0;
    const chunks2 = ['了解、', REPLY];
    const ctx2 = Object.assign({}, ctx, {
      strategyProjection: caProjection,canonicalLifecycleCache:caCache, buildCurrentRaceContext: () => caRealCtx,
      localStorage: { getItem: k => (k in store2 ? store2[k] : null), setItem: (k, v) => { store2[k] = String(v); } },
      messages: [], _msgSeq: 0,
      pushMsg(m){ if(m && typeof m==='object' && !m._mid){ Object.defineProperty(m,'_mid',{value:'m'+(++ctx2._msgSeq),enumerable:false,writable:true,configurable:true}); } ctx2.messages.push(m); return m && m._mid ? m._mid : null; },
      speak: (t) => { spoken2.push(t); }, speakReplyChunk: t => { spoken2.push(t); },
      fetch: async (_url, request) => {
        requests2.push(JSON.parse(request.body));
        return { ok: true, headers: { get: () => 'llm' },
          body: { getReader: () => ({ read: async () => {
            if (idx2 < chunks2.length) {
              if (idx2 === 1) {
                const caSnap2 = canonicalFixture({ frame: 31, decision: 'd-active', session: 2 });
                caSnap2.continuity.stable_scope = { race_instance_id: caSnap2.race_instance_id, session_num: 2, driver_id: 7 };
                caCache.receive(caSnap2, caG);
              }
              return { done: false, value: enc.encode(chunks2[idx2++]) };
            }
            return { done: true, value: undefined };
          } }) } };
      },
    });
    // Preserve the nested window.PitwallConversationMemoryBox/DisputeDetector
    // refs from the original ctx (do not collapse window into ctx2 itself).
    ctx2.window = Object.assign({}, ctx.window, { localStorage: ctx2.localStorage });
    ctx2.globalThis = ctx2;
    WO017Scope.install(ctx2); vm.createContext(ctx2);
    vm.runInContext(decls + '\n' + judgeConstDecl + '\n' + judgeTagSrc + '\n' + planDependsSrc + '\n' + WO017Scope.source(renderer) + memSrc.join('\n') + '\n' + callApiSrc
      + '\nthis.callAPI = callAPI;', ctx2);
    ctx2.callAPI('typed').then(() => {
      check('mid-flight (mid-stream) canonical change discards the main-caller reply (unconditional context fence, previously absent for ordinary chat)',
        requests2.length === 1 && spoken2.length === 0);
      runMainPlanFuelShadowCase();
    }).catch(e => { console.error(e); process.exitCode = 1; runMainPlanFuelShadowCase(); });
  }).catch(e => { console.error(e); process.exitCode = 1; runMainPlanFuelShadowCase(); });

  // ── Codex独立反証「Plan質問のnumeric facts shadow」: the INPUT QUESTION
  //    depends on Plan/pit vocabulary but NOT fuel vocabulary (_replyDomainBinding
  //    becomes the 'plan' binding alone, via the OR branch in callAPI()), yet the
  //    REPLY text itself asserts a concrete current fuel number. A fuel-only
  //    canonical drift (decision/session/lap all unchanged) must still discard
  //    this reply -- before the fix, the 'plan' binding alone stayed valid and
  //    the stale fuel number was spoken and saved to history (Codex実測:
  //    request5L→応答待ち中4.2L→旧「現在の燃料は5L。」がspeech/historyへ残存).
  function runMainPlanFuelShadowCase() {
    const pfBase = canonicalFixture({ frame: 40, decision: 'd-active' });
    pfBase.continuity.stable_scope = { race_instance_id: pfBase.race_instance_id, session_num: pfBase.session_num, driver_id: 7 };
    const pfCache = CanonicalCache.create({ now: () => 0 });
    const pfG = pfCache.beginSocket();
    pfCache.hello(pfG, { type: 'connected', schema_version: 1, bridge_process_epoch: pfBase.bridge_process_epoch });
    pfCache.receive(pfBase, pfG);
    const pfProjection = StrategyProjection.create({ canonical: pfCache, now: () => 0 });
    const pfRealCtx = RaceContextBuilder.build({ projectionView: pfProjection.current(), snapshot: pfCache.current(),
      evaluation: pfProjection.strategyEvaluation(), now: () => 1000 });
    const requests3 = []; const spoken3 = []; const store3 = {};
    let idx3 = 0;
    const FUEL_REPLY = '現在の燃料は5L。';
    const chunks3 = [FUEL_REPLY];
    const ctx3 = Object.assign({}, ctx, {
      strategyProjection: pfProjection,canonicalLifecycleCache:pfCache, buildCurrentRaceContext: () => pfRealCtx,
      localStorage: { getItem: k => (k in store3 ? store3[k] : null), setItem: (k, v) => { store3[k] = String(v); } },
      // ★独立反証補足：ctxはselMode='race'を継承していたため、FUEL_REPLYの
      // 燃料主張がhasTelemetryOwnedVehicleClaim経由のTelemetry Truth Gate
      // （selMode==='race'限定、全く別のdeterministic fallback経路）へ迂回
      // し得た——この反証の対象はcallAPI()の_replyBindingFor/numeric fact
      // shadowそのもので、Truth Gateの別経路ではない。'strategy'へ切替えて
      // そのdeterministic分岐自体を回避する（独立実HTTP反証で確認済みの
      // 構成と揃える）。
      selMode: 'strategy',
      // Plan/pit vocabulary WITHOUT fuel vocabulary: currentPlanReplyDependsOn()
      // matches (true), but _replyDependsOnFuel's narrower fuel-only regex does
      // not -- this is exactly the branch that picks the 'plan' binding alone.
      messages: [{ role: 'user', content: 'ピット作戦を教えて' }], _msgSeq: 0,
      pushMsg(m){ if(m && typeof m==='object' && !m._mid){ Object.defineProperty(m,'_mid',{value:'m'+(++ctx3._msgSeq),enumerable:false,writable:true,configurable:true}); } ctx3.messages.push(m); return m && m._mid ? m._mid : null; },
      // Unlike every other case in this file (a dumb push-regardless stub),
      // this scenario is specifically about CONTENT-only (fact binding)
      // invalidation under an UNCHANGED identity/session -- the mid-loop
      // early-abort (identity/epoch check) never fires for that case (by
      // design, it is not identity-based), so only the real per-item
      // precheck -- the SAME function drainQueue() calls in production --
      // actually catches it at the single-chunk granularity this harness
      // reads. A dumb stub would report false life-shaped "spoken" evidence.
      // ★独立反証補足：ここはNode側（vmサンドボックスの外）のarrow function
      // なので、裸の`strategyProjection`はこのファイルのモジュールscopeに
      // 解決される（存在しないか、無関係な別物）——サンドボックス内の
      // ctx3.strategyProjection（pfProjection）を明示的に参照しなければ
      // ならない。speak側のopts.precheckはサンドボックス内のクロージャ
      // （_b?()=>strategyProjection.validBinding(_b):null、ctx3内で定義）
      // なので元から正しくpfProjectionへ閉じている。
      speak: (t, opts) => { if (!opts || typeof opts.precheck !== 'function' || opts.precheck()) spoken3.push(t); },
      speakReplyChunk: (t, binding) => { if (!binding || pfProjection.validBinding(binding)) spoken3.push(t); },
      fetch: async (_url, request) => {
        requests3.push(JSON.parse(request.body));
        return { ok: true, headers: { get: () => 'llm' },
          body: { getReader: () => ({ read: async () => {
            if (idx3 < chunks3.length) {
              // Fuel-only drift: same decision/session/lap, only
              // current_facts.fuel_level_l moves (5 -> 4.2), proving the AND
              // fix -- not some coarser scope/session invalidation.
              const pfSnap2 = JSON.parse(JSON.stringify(pfCache.current()));
              pfSnap2.snapshot_sequence++;
              pfSnap2.snapshot_id = pfSnap2.bridge_process_epoch + ':' + pfSnap2.snapshot_sequence;
              pfSnap2.current_facts.fuel_level_l = 4.2;
              const _received = pfCache.receive(pfSnap2, pfG);
              if (!_received) throw new Error('fuel-only mutation rejected by canonicalLifecycleCache.receive()');
              return { done: false, value: enc.encode(chunks3[idx3++]) };
            }
            return { done: true, value: undefined };
          } }) } };
      },
    });
    ctx3.window = Object.assign({}, ctx.window, { localStorage: ctx3.localStorage });
    ctx3.globalThis = ctx3;
    WO017Scope.install(ctx3); vm.createContext(ctx3);
    vm.runInContext(decls + '\n' + judgeConstDecl + '\n' + judgeTagSrc + '\n' + planDependsSrc + '\n' + WO017Scope.source(renderer) + memSrc.join('\n') + '\n' + callApiSrc
      + '\nthis.callAPI = callAPI;', ctx3);
    ctx3.callAPI('typed').then(() => {
      check('Plan-dependent question + fuel-only mid-flight drift discards the reply (domain binding ANDed with numeric-fact binding, not shadowed)',
        requests3.length === 1 && spoken3.length === 0, { spoken3 });
      check('discarded reply leaves zero assistant-history entries',
        ctx3.messages.filter(m => m.role === 'assistant').length === 0);
      runPaceCheckCase();
    }).catch(e => { console.error(e); process.exitCode = 1; runPaceCheckCase(); });
  }
}

// ── 10. actual paceCheck caller (checkPaceJudgment): same real-payload proof
//      as followUp/callAPI above, PLUS the round2-added stale-binding fence
//      (a mid-flight session change between binding-capture and reply must
//      discard the pace-check reply, not just the followUp/callAPI callers).
function runPaceCheckCase() {
  const pcSrc = (renderer.match(/async function checkPaceJudgment\(data\)\{[\s\S]*?\n\}/) || [null])[0];
  check('actual checkPaceJudgment() extracted from renderer.html', !!pcSrc);
  const src = pcSrc && numericFactBindingSrc ? numericFactBindingSrc + '\n' + pcSrc : pcSrc;
  if (!src) { runJudgeCallCase(); return; }

  const pcSnap = canonicalFixture({ frame: 10, decision: 'd-active' });
  pcSnap.continuity.stable_scope = { race_instance_id: pcSnap.race_instance_id, session_num: pcSnap.session_num, driver_id: 7 };
  const pcCache = CanonicalCache.create({ now: () => 0 });
  const pcG = pcCache.beginSocket();
  pcCache.hello(pcG, { type: 'connected', schema_version: 1, bridge_process_epoch: pcSnap.bridge_process_epoch });
  pcCache.receive(pcSnap, pcG);
  const pcProjection = StrategyProjection.create({ canonical: pcCache, now: () => 0 });
  const pcRealCtx = RaceContextBuilder.build({ projectionView: pcProjection.current(), snapshot: pcCache.current(),
    evaluation: pcProjection.strategyEvaluation(), now: () => 1000 });

  function makePaceContext(onFetch) {
    const requests = []; const spoken = [];
    const ctx = {
      selMode: 'race', sel: 'James', userName: 'Yuji', iracingLive: true, bridgeConnected: true,
      lastTelemetry: {}, lastSessionType: 'Race', lastSessionAuthority: null,
      driverState: 'track', driverActivity: 'driving', usageSessionId: 'u1',
      paceJudgmentHandledDirections: new Set(), paceJudgmentPendingDirections: new Set(),
      localStorage: { getItem: () => null }, applyPitwallAccess: () => {}, usageCount: () => {},
      diagnosticLog: () => {}, addMsg: () => {}, speak: (text, opts) => { spoken.push({ text, opts }); },
      SPEAK_PRIO: { P4_INFO: 4 }, AbortController, setTimeout, clearTimeout, API_BASE: '',
      currentCanonicalStrategyLive: (live) => live, buildCurrentRaceContext: () => pcRealCtx,
      strategyProjection: pcProjection,
      fetch: async (_url, req) => {
        requests.push(JSON.parse(req.body));
        if (onFetch) onFetch();
        return { json: async () => ({ content: [{ text: 'ペースいいぞ、このまま。' }] }) };
      },
    };
    WO017Scope.install(ctx); vm.createContext(ctx);
    return { ctx, requests, spoken };
  }

  const { ctx, requests, spoken } = makePaceContext(null);
  vm.runInContext(src, ctx);
  ctx.checkPaceJudgment({ direction: 'improving', recent_deltas: [-0.2, -0.3] }).then(() => {
    check('actual checkPaceJudgment() sent exactly one request to /api/chat', requests.length === 1);
    check('actual paceCheck payload.raceContext deep-equals the real builder output',
      requests.length === 1 && JSON.stringify(requests[0].raceContext) === JSON.stringify(pcRealCtx));
    check('actual paceCheck payload carries the real active_plan decision_id', requests.length === 1
      && requests[0].raceContext.active_plan && requests[0].raceContext.active_plan.decision_id === 'd-active');
    check('actual Server reply was spoken for a normal in-stint pace judgement',
      spoken.length === 1 && spoken[0].text.includes('このまま'));

    // Negative/discard case: a NEW session arrives on the SAME cache WHILE
    // the fetch is in flight (simulated inside the fetch mock, i.e. strictly
    // after binding-capture but before the reply is applied). The fence
    // (strategyProjection.binding() captured pre-fetch, re-validated via
    // validBinding() post-fetch) must discard the reply -- this is the exact
    // "fresh捕捉後...session...変化時に旧current返信を適用しない" requirement,
    // and previously checkPaceJudgment had NO such fence at all.
    const { ctx: ctx2, spoken: spoken2 } = makePaceContext(() => {
      const pcSnap2 = canonicalFixture({ frame: 11, decision: 'd-active', session: 2 });
      pcSnap2.continuity.stable_scope = { race_instance_id: pcSnap2.race_instance_id, session_num: 2, driver_id: 7 };
      pcCache.receive(pcSnap2, pcG);
    });
    vm.runInContext(src, ctx2);
    ctx2.checkPaceJudgment({ direction: 'improving', recent_deltas: [-0.2, -0.3] }).then(() => {
      check('mid-flight session change discards the pace-check reply (stale-binding fence)', spoken2.length === 0);
      runJudgeCallCase();
    }).catch(e => { console.error(e); process.exitCode = 1; runJudgeCallCase(); });
  }).catch(e => { console.error(e); process.exitCode = 1; runJudgeCallCase(); });
}

// ── 11. actual judgeCall caller (runJudgeCall): same real-payload proof +
//      the same round2-added stale-binding fence, for the judge_call path
//      (best_lap/danger/battle/etc). extractJudgeSpeech/JUDGE_BANNED are
//      extracted alongside runJudgeCall since they are part of the actual
//      caller's own speech-filtering logic, not a neutral UI/helper stub.
function runJudgeCallCase() {
  const banned = (renderer.match(/const JUDGE_BANNED = [\s\S]*?;/) || [''])[0];
  const extractSrc = (renderer.match(/function extractJudgeSpeech\(reply, kind\)\{[\s\S]*?\n\}/) || [null])[0];
  const rawJudgeSrc = (renderer.match(/async function runJudgeCall\(data\)\{[\s\S]*?\n\}/) || [null])[0];
  check('actual runJudgeCall()/extractJudgeSpeech() extracted from renderer.html', !!banned && !!extractSrc && !!rawJudgeSrc);
  const judgeSrc = rawJudgeSrc && numericFactBindingSrc ? numericFactBindingSrc + '\n' + rawJudgeSrc : rawJudgeSrc;
  if (!banned || !extractSrc || !judgeSrc) { finish(); return; }

  const jcSnap = canonicalFixture({ frame: 10, decision: 'd-active' });
  jcSnap.continuity.stable_scope = { race_instance_id: jcSnap.race_instance_id, session_num: jcSnap.session_num, driver_id: 7 };
  const jcCache = CanonicalCache.create({ now: () => 0 });
  const jcG = jcCache.beginSocket();
  jcCache.hello(jcG, { type: 'connected', schema_version: 1, bridge_process_epoch: jcSnap.bridge_process_epoch });
  jcCache.receive(jcSnap, jcG);
  const jcProjection = StrategyProjection.create({ canonical: jcCache, now: () => 0 });
  const jcRealCtx = RaceContextBuilder.build({ projectionView: jcProjection.current(), snapshot: jcCache.current(),
    evaluation: jcProjection.strategyEvaluation(), now: () => 1000 });

  function makeJudgeContext(onFetch) {
    const requests = []; const spoken = [];
    const ctx = {
      selMode: 'race', sel: 'James', userName: 'Yuji', iracingLive: true, bridgeConnected: true,
      lastTelemetry: {}, lastSessionType: 'Race', lastSessionAuthority: null,
      driverState: 'track', driverActivity: 'driving', lastCarClass: 'GT3', usageSessionId: 'u1',
      finalLapNoticeSeen: false, recentCallSummary: () => [], pushRecentCall: () => {},
      localStorage: { getItem: () => null }, applyPitwallAccess: () => {}, usageCount: () => {},
      diagnosticLog: () => {}, addMsg: () => {}, speak: (text, opts) => { spoken.push({ text, opts }); },
      SPEAK_PRIO: { P1_HAZARD: 1, P3_STRATEGY: 3, P4_INFO: 4 }, AbortController, setTimeout, clearTimeout, console, API_BASE: '',
      currentCanonicalStrategyLive: (live) => live, buildCurrentRaceContext: () => jcRealCtx,
      strategyProjection: jcProjection,
      fetch: async (_url, req) => {
        requests.push(JSON.parse(req.body));
        if (onFetch) onFetch();
        return { json: async () => ({ content: [{ text: 'SAY: 自己ベスト更新、ナイス！' }] }) };
      },
    };
    WO017Scope.install(ctx); vm.createContext(ctx);
    return { ctx, requests, spoken };
  }

  const { ctx, requests, spoken } = makeJudgeContext(null);
  vm.runInContext(banned + '\n' + extractSrc + '\n' + judgeSrc, ctx);
  ctx.runJudgeCall({ kind: 'best_lap', best_kind: 'personal', time: '1:42.300', gain: 0.4 }).then(() => {
    check('actual runJudgeCall() sent exactly one request to /api/chat', requests.length === 1);
    check('actual judgeCall payload.raceContext deep-equals the real builder output',
      requests.length === 1 && JSON.stringify(requests[0].raceContext) === JSON.stringify(jcRealCtx));
    check('actual judgeCall payload carries the real active_plan decision_id', requests.length === 1
      && requests[0].raceContext.active_plan && requests[0].raceContext.active_plan.decision_id === 'd-active');
    check('actual Server reply was spoken for a normal judge-call event',
      spoken.length === 1 && spoken[0].text.includes('ベスト更新'));

    // Negative/discard case: same mid-flight session-change fence as paceCheck.
    const { ctx: ctx2, spoken: spoken2 } = makeJudgeContext(() => {
      const jcSnap2 = canonicalFixture({ frame: 11, decision: 'd-active', session: 2 });
      jcSnap2.continuity.stable_scope = { race_instance_id: jcSnap2.race_instance_id, session_num: 2, driver_id: 7 };
      jcCache.receive(jcSnap2, jcG);
    });
    vm.runInContext(banned + '\n' + extractSrc + '\n' + judgeSrc, ctx2);
    ctx2.runJudgeCall({ kind: 'best_lap', best_kind: 'personal', time: '1:42.300', gain: 0.4 }).then(() => {
      check('mid-flight session change discards the judge-call reply (stale-binding fence)', spoken2.length === 0);
      runAutoBriefingCase();
    }).catch(e => { console.error(e); process.exitCode = 1; runAutoBriefingCase(); });
  }).catch(e => { console.error(e); process.exitCode = 1; runAutoBriefingCase(); });
}

// ── 12. actual autoBriefing caller (scheduleAutoBriefing): the "auto代表"
//      full vertical slice -- real builder output -> actual sent payload ->
//      actual Server reply -> actual existing stale-briefing fence
//      (strategyProjection.binding()/validBinding() at line ~5929, the
//      SAME mechanism paceCheck/judgeCall now also use). Everything that is
//      genuinely a neutral UI/self-memory/decision-memory/pddp helper is
//      stubbed per the authorized scope; the caller/builder/fetch
//      payload/fence are all the real extracted renderer.html code.
function runAutoBriefingCase() {
  const abSrc = (renderer.match(/async function scheduleAutoBriefing\(\)\{[\s\S]*?\n\}/) || [null])[0];
  check('actual scheduleAutoBriefing() extracted from renderer.html', !!abSrc);
  const src = abSrc && numericFactBindingSrc ? numericFactBindingSrc + '\n' + abSrc : abSrc;
  if (!src) { finish(); return; }

  const abSnap = canonicalFixture({ frame: 10, decision: 'd-active' });
  abSnap.continuity.stable_scope = { race_instance_id: abSnap.race_instance_id, session_num: abSnap.session_num, driver_id: 7 };
  const abCache = CanonicalCache.create({ now: () => 0 });
  const abG = abCache.beginSocket();
  abCache.hello(abG, { type: 'connected', schema_version: 1, bridge_process_epoch: abSnap.bridge_process_epoch });
  abCache.receive(abSnap, abG);
  const abProjection = StrategyProjection.create({ canonical: abCache, now: () => 0 });
  const abRealCtx = RaceContextBuilder.build({ projectionView: abProjection.current(), snapshot: abCache.current(),
    evaluation: abProjection.strategyEvaluation(), now: () => 1000 });

  function makeBriefingContext(onFetch) {
    const requests = []; const spoken = []; const display = [];
    const ctx = {
      selMode: 'strategy', sel: 'James', userName: 'Yuji', iracingLive: true, bridgeConnected: true,
      lastTelemetry: {}, lastSessionType: 'Race', lastSessionAuthority: null,
      driverState: 'track', driverActivity: 'driving', lastCarClass: 'GT3', lastCarModel: 'AMG', usageSessionId: 'u1',
      localStorage: { getItem: () => null }, applyPitwallAccess: () => {}, usageCount: () => {},
      diagnosticLog: () => {}, addMsg: (who, text) => { display.push(text); }, pushMsg: () => null,
      speak: (text, opts) => { spoken.push({ text, opts }); },
      SPEAK_PRIO: { P2_PROCEDURE: 2, P3_STRATEGY: 3 }, AbortController, API_BASE: '',
      // setTimeout is overridden to fire immediately (ignoring the 6s delay /
      // 30s abort timer) -- this is timer plumbing, not the caller/fence
      // logic under test, which runs unmodified.
      setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {},
      currentCanonicalStrategyLive: (live) => live, buildCurrentRaceContext: () => abRealCtx,
      strategyProjection: abProjection,
      // Neutral stubs: self/decision/pddp memory and profile-note builders
      // are UI/helper concerns outside this WO's scope, not the caller or
      // the race-context fence being proven here.
      loadProfile: () => ({}), buildPreviousRaceBriefingNote: () => '',
      currentMemoryIdentity: () => ({}), loadRaceHistory: () => [], noteMemoryUtterance: () => {},
      pullDecisionsFromServer: async () => {}, decisionBriefingSelection: () => ({ available: false }),
      decisionPlanAdvice: () => ({ action: 'none', fate: 'skip', reply: null }),
      setupComparisonForBriefing: () => ({ available: false }), driverAddressName: () => 'Driver',
      buildProfileNote: () => '', buildCarTrackMemory: () => '', buildFuelAuthorityNote: () => '',
      buildWeekendAuthorityNote: () => '', buildContractNote: () => '', buildActiveRaceFactsNote: () => '',
      buildRaceHistoryContext: () => '',
      fetch: async (_url, req) => {
        requests.push(JSON.parse(req.body));
        if (onFetch) onFetch();
        return { json: async () => ({ content: [{ text: '今日は調子良さそうだね。目標は？' }] }) };
      },
    };
    ctx.window = ctx; ctx.globalThis = ctx;
    WO017Scope.install(ctx); vm.createContext(ctx);
    return { ctx, requests, spoken, display };
  }

  const { ctx, requests, spoken } = makeBriefingContext(null);
  vm.runInContext(src, ctx);
  ctx.scheduleAutoBriefing().then(async () => {
    // the 6s setTimeout body is itself async; give its microtasks a tick.
    await new Promise(r => setImmediate(r));
    check('actual scheduleAutoBriefing() sent exactly one request to /api/chat', requests.length === 1);
    check('actual autoBriefing payload.raceContext deep-equals the real builder output',
      requests.length === 1 && JSON.stringify(requests[0].raceContext) === JSON.stringify(abRealCtx));
    check('actual autoBriefing payload carries the real active_plan decision_id', requests.length === 1
      && requests[0].raceContext.active_plan && requests[0].raceContext.active_plan.decision_id === 'd-active');
    check('actual Server reply was spoken for a normal briefing kickoff',
      spoken.some(s => s.text.includes('目標')));

    // Negative/discard case: the EXISTING stale_briefing_discarded fence
    // (strategyProjection.binding() captured pre-fetch, validBinding()
    // re-checked post-fetch) must still discard a reply when the session
    // changes mid-flight -- independently re-proven here, not assumed from
    // the fact that the code exists.
    const { ctx: ctx2, spoken: spoken2 } = makeBriefingContext(() => {
      const abSnap2 = canonicalFixture({ frame: 11, decision: 'd-active', session: 2 });
      abSnap2.continuity.stable_scope = { race_instance_id: abSnap2.race_instance_id, session_num: 2, driver_id: 7 };
      abCache.receive(abSnap2, abG);
    });
    vm.runInContext(src, ctx2);
    await ctx2.scheduleAutoBriefing();
    await new Promise(r => setImmediate(r));
    check('mid-flight session change discards the auto-briefing reply (existing stale-binding fence, independently re-proven)',
      spoken2.length === 0);
    finish();
  }).catch(e => { console.error(e); process.exitCode = 1; finish(); });
}

function finish() {
  console.log(`\n[race-context-builder] 合格 ${pass} / 不合格 ${fail}`);
  console.log('※ 実Server HTTP route・実LLM意味品質・実Windows/iRacingはこのテストの対象外。');
  const missingCases=pass+fail!==118;
  if(missingCases)console.error('Required 118 checks did not execute: '+(pass+fail));
  process.exitCode = fail||missingCases||process.exitCode ? 1 : 0;
}
