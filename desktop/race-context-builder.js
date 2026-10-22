/* WO014: single canonical LLM race-context builder.
 * Connects to the existing WO009/WO011 canonical cache + projection
 * (desktop/canonical-lifecycle-cache.js, desktop/strategy-state-projection.js)
 * and produces ONE versioned, whitelist-only context object for every
 * current-race LLM caller (sendMessage/followUp/paceCheck/judgeCall/
 * autoBriefing). Current fuel/lap/finish/plan/pit/penalty are sourced only
 * from the canonical projection; reference calculations keep their original
 * scope/source/age and are never promoted to a current quantity or
 * execution directive. Unknown/unavailable fields are stated as such, never
 * defaulted to 0/false or silently dropped.
 */
(function(root){'use strict';
const SCHEMA = 'pitwall_race_context';
const SCHEMA_VERSION = 1;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const integer = v => typeof v === 'number' && Number.isInteger(v);
const text = v => typeof v === 'string' && v.length > 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function clone(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function immutable(v) { return freeze(clone(v)); }

// recommendation entries from strategyProjection.strategyEvaluation() already carry
// {role, age_s, source_valid, diagnostic, calculation_source} (see
// strategy-state-projection.js `recommendations()`/`calculationAge()`). The
// builder only re-shapes them; it never recomputes a calculation itself and
// never widens a reference into a current quantity. calculation_source is
// kept so a consumer/auditor can trace the value back to the exact
// source_frame_sequence/session_time_s it was computed from, not just trust
// the pre-computed age_s.
function calculationReference(rec) {
  if (!rec) return null;
  return { value: rec.source_valid ? clone(rec.value) : null, role: rec.role || 'reference',
    age_s: rec.age_s, source_valid: !!rec.source_valid, diagnostic: rec.diagnostic || null,
    calculation_source: rec.calculation_source ? clone(rec.calculation_source) : null };
}

function build(input) {
  const now = typeof input?.now === 'function' ? input.now : () => Date.now();
  const view = input && object(input.projectionView) ? input.projectionView : null;
  const snapshot = input && object(input.snapshot) ? input.snapshot : null;
  const evaluation = input && object(input.evaluation) ? input.evaluation : null;
  const unknowns = [];
  const available = !!(view && view.available);

  if (!view) unknowns.push('race_identity:projection_unavailable');
  else if (!available) unknowns.push('race_identity:' + (view.reason || 'canonical_unavailable'));

  const raceIdentity = (available && view.scope) ? immutable({
    race_instance_id: view.scope.race_instance_id, session_num: view.scope.session_num,
    driver_id: view.scope.driver_id, bridge_process_epoch: view.publication_ref?.bridge_process_epoch ?? null,
  }) : null;

  const freshness = immutable({
    available, reason: available ? null : (view ? view.reason : 'canonical_unavailable'),
    canonical_snapshot_id: available ? view.publication_ref?.canonical_snapshot_id ?? null : null,
    canonical_snapshot_sequence: available ? view.publication_ref?.canonical_snapshot_sequence ?? null : null,
    source_frame_sequence: available && snapshot ? snapshot.source_frame?.sequence ?? null : null,
    session_time_s: available && snapshot ? snapshot.source_frame?.session_time_s ?? null : null,
  });

  let currentFacts;
  if (available && view.current_facts) {
    const f = view.current_facts;
    currentFacts = immutable({
      available: true, fuel_level_l: f.fuel_level_l ?? null, current_lap: f.current_lap ?? null,
      on_pit_road: f.on_pit_road ?? null, on_track: f.on_track ?? null,
      finish: view.finish ? { available: !!view.finish.available, remaining_sf_crossings: view.finish.remaining_sf_crossings ?? null } : { available: false, remaining_sf_crossings: null },
    });
  } else {
    unknowns.push('current_facts:' + (view ? view.reason : 'canonical_unavailable'));
    currentFacts = immutable({ available: false, fuel_level_l: null, current_lap: null, on_pit_road: null, on_track: null, finish: { available: false, remaining_sf_crossings: null } });
  }

  // black_flag carries the derived state PLUS the raw SDK evidence it was
  // derived from (raw_value/observed_session_time/source_frame_sequence) so
  // a consumer never has to trust a bare "true/false/unknown" string without
  // the evidence behind it (penalty evidence requirement, WO014 residual scope).
  const bf = (available && view.black_flag) ? view.black_flag : null;
  const penaltyState = immutable({
    black_flag: bf ? {
      state: bf.state, freshness: bf.freshness, authority: bf.authority,
      raw_value: bf.raw_value ?? null, observed_session_time: bf.observed_session_time ?? null,
      source_frame_sequence: bf.source_frame_sequence ?? null,
    } : { state: 'unknown', freshness: 'unavailable', authority: null, raw_value: null, observed_session_time: null, source_frame_sequence: null },
  });
  if (!available || !view.black_flag) unknowns.push('penalty_state:' + (view ? view.reason : 'canonical_unavailable'));

  const activePlan = (available && view.active) ? immutable({
    phase: 'active', decision_id: view.active.decision_id, revision: view.active.revision,
    record_ref: view.active.record_ref, selected_plan: view.active.selected_plan,
    target_lap: view.active.target_lap ?? null, add_fuel_l: view.active.add_fuel_l ?? null, set_fuel_l: view.active.set_fuel_l ?? null,
  }) : null;
  if (available && !view.active) unknowns.push('active_plan:none_agreed');

  // Past decision records (executed/invalidated/cancelled) are canonical
  // history, never a current agreement. Each entry carries its own
  // record_ref (race/session/driver scope + decision/revision) so identity
  // is traceable per-item even when raceIdentity above is null.
  const historicalRelevantMemory = (view && Array.isArray(view.terminals) && view.terminals.length)
    ? immutable(view.terminals.map(t => ({
        role: 'canonical_observed_history', decision_id: t.decision_id, revision: t.revision,
        phase: t.phase, record_ref: t.record_ref, selected_plan: t.selected_plan ?? null,
        target_lap: t.target_lap ?? null,
      })))
    : [];

  const pendingProposal = available ? immutable({
    canonical_awaiting: Array.isArray(view.pending) && view.pending.length > 0,
    canonical_awaiting_records: (Array.isArray(view.pending) ? view.pending : []).map(r => ({ decision_id: r.decision_id, revision: r.revision, target_lap: r.target_lap, selected_plan: r.selected_plan })),
    local_judgment_pending: !!(view.pending_proposal && view.pending_proposal.awaiting_judgment),
    local_proposal: view.pending_proposal ? { decision_id: view.pending_proposal.decision_id, lap: view.pending_proposal.lap, plan_id: view.pending_proposal.plan_id } : null,
  }) : null;

  const lastDriverAction = (available && view.scope?.driver_id && snapshot && snapshot.last_driver_action && snapshot.last_driver_action.available)
    ? immutable(snapshot.last_driver_action.action) : null;

  const lastPitEvent = (available && view.pit_executed) ? immutable(view.pit_executed) : null;

  // constraint/proof give a consumer the raw execution-gate evidence behind
  // execution_allowed/execution_hold_reason, not just the derived boolean:
  // constraint = why execution might be structurally blocked (closed scope,
  // collision, open visit, gate_reason); proof = the box-delivery proof/
  // attempt this execution window is actually bound to.
  const execution = (available && snapshot && snapshot.execution) ? snapshot.execution : null;
  const boxDelivery = (available && snapshot && snapshot.box_delivery) ? snapshot.box_delivery : null;
  const allowedActions = immutable({
    execution_allowed: available ? !!view.execution_allowed : false,
    execution_hold_reason: available ? (view.execution_hold_reason || null) : 'canonical_unavailable',
    constraint: execution ? {
      scope_closed: !!execution.scope_closed, collision: !!execution.collision,
      visit_open: !!execution.visit_open, gate_reason: execution.gate_reason ?? null,
    } : null,
    proof: boxDelivery ? {
      allowed_proof_id: boxDelivery.allowed_proof_id ?? null,
      allowed_attempt_id: boxDelivery.allowed_attempt_id ?? null,
      valid_until_session_s: boxDelivery.valid_until_session_s ?? null,
    } : null,
  });

  const fuelRec = evaluation?.recommendations?.fuel_strategy ?? null;
  const optionsRec = evaluation?.recommendations?.strategy_options ?? null;
  const calculationReferences = immutable({
    fuel_strategy: calculationReference(fuelRec), strategy_options: calculationReference(optionsRec),
  });
  if (!fuelRec || !fuelRec.source_valid) unknowns.push('calculation_references.fuel_strategy:unavailable_or_stale');

  // Auxiliary observations (position/GAP) are not part of the canonical
  // lifecycle snapshot's own domains, so they are only trusted when the
  // Bridge project_telemetry refs (epoch/race/session/snapshot id+sequence/
  // source_frame sequence) tagged on the SAME wire message that carried them
  // match the CURRENT canonical snapshot's refs exactly. input.auxSourceRef
  // is that arrival-time tag (captured once, before any later canonical
  // advance); input.auxRaw is the position/GAP payload it was tagged with.
  // A stale/mismatched/missing tag falls to unknown -- it is never read
  // directly off raw telemetry without this correlation.
  const auxRef = input && object(input.auxSourceRef) ? input.auxSourceRef : null;
  const auxRaw = input && object(input.auxRaw) ? input.auxRaw : null;
  const auxCorrelated = !!(available && auxRef && auxRaw && raceIdentity && snapshot && snapshot.source_frame
    && auxRef.bridge_process_epoch === view.publication_ref?.bridge_process_epoch
    && auxRef.canonical_snapshot_id === view.publication_ref?.canonical_snapshot_id
    && auxRef.canonical_snapshot_sequence === view.publication_ref?.canonical_snapshot_sequence
    && auxRef.race_instance_id === raceIdentity.race_instance_id
    && auxRef.session_num === raceIdentity.session_num
    && integer(auxRef.source_frame_sequence) && auxRef.source_frame_sequence === snapshot.source_frame.sequence);
  const auxiliaryObservations = auxCorrelated ? immutable({
    role: 'verified_observation', source_ref: auxRef,
    gap_ahead: finite(auxRaw.gap_ahead) ? auxRaw.gap_ahead : null,
    gap_behind: finite(auxRaw.gap_behind) ? auxRaw.gap_behind : null,
    // position/class_position are kept as two DISTINCT fields (round3 fix):
    // the pre-round3 shape collapsed them into one "position" that silently
    // preferred overall over class, which lost information liveNote's
    // separate "クラス順位"/"総合" facts need and could not be told apart.
    position: integer(auxRaw.pos) ? auxRaw.pos : null,
    class_position: integer(auxRaw.class_pos) ? auxRaw.class_pos : null,
    // leaders/standings_gaps (round3 residual): the real caller
    // (buildCurrentRaceContext in desktop/renderer.html) has always sent
    // these shapes (leaders={overall,player_class} objects; standings_gaps=
    // a {position: gap} map), but this builder only ever declared a
    // (never-matching) Array.isArray(leaders) shape and no standings_gaps
    // field at all -- so liveNote's standings_gaps/leaders consumers had no
    // verified path and fell back to raw live.* unconditionally. Sanitized
    // here the same way gap_ahead/gap_behind already are: only the SAME
    // arrival-time-correlated payload, shape-checked, numeric/string bounded.
    leaders: sanitizeLeaders(auxRaw.leaders),
    standings_gaps: sanitizeStandingsGaps(auxRaw.standings_gaps),
  }) : null;
  if (!auxCorrelated) unknowns.push('auxiliary_observations:source_frame_correlation_unavailable');

  return immutable({
    schema: SCHEMA, schema_version: SCHEMA_VERSION, generated_at: now(),
    race_identity: raceIdentity, freshness, current_facts: currentFacts, penalty_state: penaltyState,
    active_plan: activePlan, pending_proposal: pendingProposal, last_driver_action: lastDriverAction,
    last_pit_event: lastPitEvent, allowed_actions: allowedActions, unknowns,
    calculation_references: calculationReferences, auxiliary_observations: auxiliaryObservations,
    historical_relevant_memory: historicalRelevantMemory,
  });
}

const MAX_FUEL_L = 300;      // generous upper bound across any current/future car class
const MAX_PIT_SERVICE_S = 600; // a 10-minute pit-lane/stationary sample is already far outside any real stop
const MAX_LAP = 20000;       // generous upper bound for even very long multi-day enduros
const MAX_SF_CROSSINGS = 20000; // remaining S/F crossings share the same magnitude domain as laps
const MAX_CALC_AGE_S = 1800; // a 30-minute-old calculation reference is never a live quantity
const MAX_GAP_S = 3600;      // a gap of over an hour is not a meaningful race gap, aux is reference-only
const MAX_POSITION = 200;    // generous upper bound across any current/future grid size
const MAX_STRING_LEN = 200;  // identity/ref strings are short IDs, never free text
const MAX_HISTORY_ITEMS = 200; // bounded array -- historical memory must not grow unbounded in a prompt
const CONTEXT_DEADLINE_MS = 20000; // built client-side, sent over HTTP: 20s covers normal queueing/latency
const nonNegFinite = v => finite(v) && v >= 0;
const posInt = v => integer(v) && v > 0;
const nonNegInt = v => integer(v) && v >= 0;
const boundedStr = v => typeof v === 'string' && v.length > 0 && v.length <= MAX_STRING_LEN;
const boundedCarNumber = v => v === null || v === undefined ? null
  : (typeof v === 'number' && finite(v)) ? v : (boundedStr(String(v)) ? String(v) : null);

// A leader entry is a single named/identified car (overall or player-class
// leader); sanitized the same way as every other aux field -- shape, string
// length and numeric bounds checked, never the raw object passed through.
function sanitizeLeaderEntry(o) {
  if (!object(o)) return null;
  return {
    name: boundedStr(o.name) ? o.name : null,
    car_number: boundedCarNumber(o.car_number),
    class_name: boundedStr(o.class_name) ? o.class_name : null,
    car_idx: (integer(o.car_idx) && o.car_idx >= 0 && o.car_idx <= MAX_POSITION) ? o.car_idx : null,
    gap_s: (finite(o.gap_s) && Math.abs(o.gap_s) <= MAX_GAP_S) ? o.gap_s : null,
  };
}
function sanitizeLeaders(raw) {
  if (!object(raw)) return null;
  const overall = sanitizeLeaderEntry(raw.overall);
  const player_class = sanitizeLeaderEntry(raw.player_class);
  if (!overall && !player_class) return null;
  return { overall, player_class };
}
// standings_gaps is a {classPosition: gapSeconds} map (gap to every OTHER
// class position, not just the immediate ahead/behind car). Bounded to the
// same bare numeric/position domain as every other aux gap/position field --
// a non-integer/out-of-range key or an out-of-range value is dropped, not
// coerced or passed through.
function sanitizeStandingsGaps(raw) {
  if (!object(raw)) return null;
  const out = {};
  let n = 0;
  for (const k of Object.keys(raw)) {
    if (n >= MAX_POSITION) break;
    const p = Number(k);
    if (!(Number.isInteger(p) && p > 0 && p <= MAX_POSITION && String(p) === k)) continue;
    const v = raw[k];
    if (!(finite(v) && Math.abs(v) <= MAX_GAP_S)) continue;
    out[k] = v;
    n++;
  }
  return n > 0 ? out : null;
}

// Every calculation reference traces back to a bridge_process_epoch/
// race_instance_id/session_num/source_frame_sequence calculation_source. A
// reference trusted as source_valid without that evidence (or without a
// bounded age) is exactly the "source_valid computed with a null source/age"
// gap the parent independent review found: age/source were allowed to be
// null even while source_valid claimed true.
function calcRefValid(r) {
  if (r === null || r === undefined) return true;
  if (!object(r) || typeof r.source_valid !== 'boolean') return false;
  if (r.source_valid) {
    if (!(nonNegFinite(r.age_s) && r.age_s <= MAX_CALC_AGE_S)) return false;
    if (!object(r.calculation_source)) return false;
  } else if (r.age_s !== null && !nonNegFinite(r.age_s)) return false;
  return true;
}

// record_ref is the bridge's own per-decision identity stamp (see
// irsdk-bridge/canonical_lifecycle_snapshot.py record_view():
// {bridge_process_epoch, race_instance_id, session_num, decision_id,
// revision}). A record_ref that does not match the SAME request's
// race_identity and active_plan decision_id/revision is a cross-scope leak
// (another race/session/epoch's plan, or a stale decision/revision pair)
// and must be rejected, not merely "present as an object".
function recordRefMatches(ref, raceIdentity, decisionId, revision) {
  if (!object(ref)) return false;
  if (!boundedStr(ref.race_instance_id) || !nonNegInt(ref.session_num) || !boundedStr(ref.decision_id)) return false;
  if (!nonNegInt(ref.revision) || typeof ref.bridge_process_epoch !== 'string' || !ref.bridge_process_epoch) return false;
  if (ref.race_instance_id !== raceIdentity.race_instance_id) return false;
  if (ref.session_num !== raceIdentity.session_num) return false;
  // round3 fix: raceIdentity.bridge_process_epoch===null used to SKIP the
  // epoch comparison entirely (ref could carry ANY epoch and still "match").
  // A record_ref's epoch can never be verified against an unknown current
  // epoch, so this must fail closed (reject), not silently pass -- the
  // parent-reported "available epoch:nullでrecord epoch照合bypass" gap.
  if (raceIdentity.bridge_process_epoch === null || ref.bridge_process_epoch !== raceIdentity.bridge_process_epoch) return false;
  if (ref.decision_id !== decisionId || ref.revision !== revision) return false;
  return true;
}

// Mirrors sanitizeLeaderEntry's shape but as a predicate for validate()
// (server-side input it never built itself, so it checks rather than clones).
function validLeaderEntry(e) {
  if (e === null) return true;
  if (!object(e)) return false;
  if (!(e.name === null || boundedStr(e.name))) return false;
  if (!(e.car_number === null || typeof e.car_number === 'number' || boundedStr(e.car_number))) return false;
  if (!(e.class_name === null || boundedStr(e.class_name))) return false;
  if (!(e.car_idx === null || (nonNegInt(e.car_idx) && e.car_idx <= MAX_POSITION))) return false;
  if (!(e.gap_s === null || (finite(e.gap_s) && Math.abs(e.gap_s) <= MAX_GAP_S))) return false;
  return true;
}
function validLeaders(l) {
  if (l === null) return true;
  if (!object(l) || !('overall' in l) || !('player_class' in l)) return false;
  return validLeaderEntry(l.overall) && validLeaderEntry(l.player_class);
}
function validStandingsGaps(g) {
  if (g === null) return true;
  if (!object(g)) return false;
  const keys = Object.keys(g);
  if (!keys.length || keys.length > MAX_POSITION) return false;
  return keys.every(k => {
    const p = Number(k);
    if (!(Number.isInteger(p) && p > 0 && p <= MAX_POSITION && String(p) === k)) return false;
    return finite(g[k]) && Math.abs(g[k]) <= MAX_GAP_S;
  });
}

// Server-side structural validation (schema/version/shape only -- the Server
// process has no canonical cache of its own, so it cannot re-derive truth,
// only reject a malformed/mismatched-version payload before it ever reaches
// prompts.js). Trust boundary: a client-sent object that fails this check is
// treated as unavailable, never patched or defaulted.
//
// `now` (ms, defaults to Date.now()) enforces a context deadline: a context
// built long before the request reached the Server (queueing, retry, replay)
// is rejected rather than trusted as if it were fresh.
function validate(ctx, now) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  if (!object(ctx) || ctx.schema !== SCHEMA || ctx.schema_version !== SCHEMA_VERSION) return false;
  if (!finite(ctx.generated_at) || !Array.isArray(ctx.unknowns)) return false;
  if (ctx.generated_at > nowMs + 2000 || nowMs - ctx.generated_at > CONTEXT_DEADLINE_MS) return false;
  if (!object(ctx.freshness) || typeof ctx.freshness.available !== 'boolean') return false;
  // freshness publication/source_frame refs are required (not merely present-
  // as-some-type) whenever available is true: a consumer must be able to
  // trace a "current" value back to the exact snapshot/source_frame it came
  // from, not trust a bare available:true with null provenance.
  if (ctx.freshness.available) {
    const fr = ctx.freshness;
    if (!boundedStr(fr.canonical_snapshot_id) || !posInt(fr.canonical_snapshot_sequence)) return false;
    if (!nonNegInt(fr.source_frame_sequence) || !nonNegFinite(fr.session_time_s)) return false;
  }
  if (!object(ctx.current_facts) || typeof ctx.current_facts.available !== 'boolean') return false;
  if (ctx.current_facts.available) {
    const f = ctx.current_facts;
    if (!(f.fuel_level_l === null || (nonNegFinite(f.fuel_level_l) && f.fuel_level_l <= MAX_FUEL_L))) return false;
    if (!(f.current_lap === null || (nonNegInt(f.current_lap) && f.current_lap <= MAX_LAP))) return false;
    if (!(f.on_pit_road === null || typeof f.on_pit_road === 'boolean') || !(f.on_track === null || typeof f.on_track === 'boolean')) return false;
    if (!object(f.finish) || typeof f.finish.available !== 'boolean') return false;
    if (f.finish.available) {
      if (!nonNegInt(f.finish.remaining_sf_crossings) || f.finish.remaining_sf_crossings > MAX_SF_CROSSINGS) return false;
    } else if (f.finish.remaining_sf_crossings !== null) return false;
  }
  if (!object(ctx.penalty_state) || !object(ctx.penalty_state.black_flag)) return false;
  if (!['true', 'false', 'unknown'].includes(ctx.penalty_state.black_flag.state)) return false;
  // Identity/ref/bounds: `available: true` with no (or malformed) scope identity,
  // or an active_plan that is an object but missing its required keys (e.g. `{}`),
  // must never pass -- this is the exact defect the parent prompt-probe reproduced
  // (modern available:true + race_identity:null + active_plan:{} accepted).
  if (ctx.freshness.available) {
    const ri = ctx.race_identity;
    if (!object(ri) || !boundedStr(ri.race_instance_id)) return false;
    if (!nonNegInt(ri.session_num)) return false;
    if (!posInt(ri.driver_id)) {
      // Process/session-scoped fresh observations remain usable without a
      // restart-safe driver identity. This scope can never carry an agreed
      // plan, pending proposal, driver action or execution authorization.
      const actions=ctx.allowed_actions;
      if(ri.driver_id!==null || ctx.active_plan!==null || ctx.last_driver_action!==null
          || !actions || actions.execution_allowed!==false
          || !['identity_unsupported','restore_pending','restore_failed','identity_unverified'].includes(actions.execution_hold_reason)
          || actions.proof?.allowed_proof_id!==null || actions.proof?.allowed_attempt_id!==null
          || ctx.pending_proposal?.canonical_awaiting || ctx.pending_proposal?.local_proposal) return false;
    }
    if (!(ri.bridge_process_epoch === null || boundedStr(ri.bridge_process_epoch))) return false;
    if (ctx.active_plan !== null) {
      const a = ctx.active_plan;
      // kept for shape/early-exit clarity even though recordRefMatches below
      // independently re-rejects any falsy/invalid decision_id too (a record_ref
      // can never equal an undefined decision_id) -- mutation-tested confirmed
      // this line is no longer independently load-bearing, see WO014 round2 notes.
      if (!object(a) || !boundedStr(a.decision_id)) return false;
      if (!nonNegInt(a.revision) || !['A', 'B', 'C'].includes(a.selected_plan)) return false;
      // record_ref must match THIS SAME request's race/session/epoch identity
      // and the active_plan's own decision_id/revision -- an object that is
      // merely present (old check) but points at another race/session/
      // decision/revision is a cross-scope leak and must be rejected.
      if (!recordRefMatches(a.record_ref, ri, a.decision_id, a.revision)) return false;
      if (!(a.target_lap === null || (nonNegInt(a.target_lap) && a.target_lap <= MAX_LAP))) return false;
      if (!(a.add_fuel_l === null || (nonNegFinite(a.add_fuel_l) && a.add_fuel_l <= MAX_FUEL_L))) return false;
      if (!(a.set_fuel_l === null || (nonNegFinite(a.set_fuel_l) && a.set_fuel_l <= MAX_FUEL_L))) return false;
    }
  } else if (ctx.race_identity !== null) return false;
  if (!ctx.freshness.available && ctx.active_plan !== null) return false;
  if (ctx.pending_proposal !== null && !object(ctx.pending_proposal)) return false;
  if (ctx.last_driver_action !== null && !object(ctx.last_driver_action)) return false;
  // round4 residual ("Server pit scope/bounds"): the projection-level
  // identity cross-check (strategy-state-projection.js, round4) only
  // protects the PRODUCT builder path -- a raceContext arriving over HTTP
  // from any caller could forge a last_pit_event claiming a different
  // race/session's service sample onto an otherwise-current context.
  // last_pit_event is THIS race/session's most recent pit (unlike
  // historical_relevant_memory, which legitimately spans past races), so
  // its own event_ref must structurally match ctx.race_identity exactly.
  // epoch is intentionally NOT required to match -- a pit from before a
  // Bridge process restart legitimately keeps its own original epoch
  // (same precedent as historical_relevant_memory's record_ref). A
  // malformed/inconsistent/out-of-bounds event fails the WHOLE context
  // closed (unknown), never a silent partial strip.
  if (ctx.last_pit_event !== null) {
    const e = ctx.last_pit_event;
    if (!object(e)) return false;
    if (!(e.lap === null || (nonNegInt(e.lap) && e.lap <= MAX_LAP))) return false;
    if (e.execution_relation !== null && typeof e.execution_relation !== 'string') return false;
    if (!boundedStr(e.pit_event_id)) return false;
    if (!object(e.event_ref)) return false;
    if (e.event_ref.pit_event_id !== e.pit_event_id) return false;
    if (!boundedStr(e.event_ref.race_instance_id)) return false;
    if (!nonNegInt(e.event_ref.session_num)) return false;
    if (!ctx.race_identity) return false;
    if (e.event_ref.race_instance_id !== ctx.race_identity.race_instance_id) return false;
    if (e.event_ref.session_num !== ctx.race_identity.session_num) return false;
    if (e.service !== null) {
      if (!object(e.service)) return false;
      if (!(e.service.lane_total_s === null || (finite(e.service.lane_total_s) && e.service.lane_total_s >= 0 && e.service.lane_total_s <= MAX_PIT_SERVICE_S))) return false;
      if (!(e.service.stall_s === null || (finite(e.service.stall_s) && e.service.stall_s >= 0 && e.service.stall_s <= MAX_PIT_SERVICE_S))) return false;
      if (!(e.service.fuel_added_l === null || (finite(e.service.fuel_added_l) && e.service.fuel_added_l >= 0 && e.service.fuel_added_l <= MAX_FUEL_L))) return false;
    }
  }
  if (!object(ctx.allowed_actions) || typeof ctx.allowed_actions.execution_allowed !== 'boolean') return false;
  if (ctx.allowed_actions.constraint != null && !object(ctx.allowed_actions.constraint)) return false;
  if (ctx.allowed_actions.proof != null && !object(ctx.allowed_actions.proof)) return false;
  if (!object(ctx.calculation_references)) return false;
  if (!calcRefValid(ctx.calculation_references.fuel_strategy) || !calcRefValid(ctx.calculation_references.strategy_options)) return false;
  if (ctx.auxiliary_observations !== null) {
    const aux = ctx.auxiliary_observations;
    if (!object(aux) || aux.role !== 'verified_observation') return false;
    if (!object(aux.source_ref)) return false;
    if (!(aux.gap_ahead === null || (finite(aux.gap_ahead) && Math.abs(aux.gap_ahead) <= MAX_GAP_S))) return false;
    if (!(aux.gap_behind === null || (finite(aux.gap_behind) && Math.abs(aux.gap_behind) <= MAX_GAP_S))) return false;
    if (!(aux.position === null || (posInt(aux.position) && aux.position <= MAX_POSITION))) return false;
    if (!(aux.class_position === null || (posInt(aux.class_position) && aux.class_position <= MAX_POSITION))) return false;
    if (!validLeaders(aux.leaders)) return false;
    if (!validStandingsGaps(aux.standings_gaps)) return false;
    // round3 fix: aux.source_ref previously only had to be "an object" --
    // it was never cross-checked against THIS SAME ctx's own freshness/
    // race_identity refs ("aux.source_refがobjectだけで現在ref一致未検査").
    // A source_ref describing a different snapshot/race/session/epoch than
    // the rest of this context must fail closed, not pass as verified.
    if (!ctx.freshness.available || !ctx.race_identity || ctx.race_identity.bridge_process_epoch === null) return false;
    const sr = aux.source_ref;
    if (sr.race_instance_id !== ctx.race_identity.race_instance_id) return false;
    if (sr.session_num !== ctx.race_identity.session_num) return false;
    if (sr.bridge_process_epoch !== ctx.race_identity.bridge_process_epoch) return false;
    if (sr.canonical_snapshot_id !== ctx.freshness.canonical_snapshot_id) return false;
    if (sr.canonical_snapshot_sequence !== ctx.freshness.canonical_snapshot_sequence) return false;
    if (sr.source_frame_sequence !== ctx.freshness.source_frame_sequence) return false;
  }
  // Each historical item is its own canonical fact, scoped by its OWN
  // record_ref (not the possibly-null current race_identity above). record_ref
  // must be internally consistent with the item's own decision_id/revision,
  // and -- whenever this request DOES have a current race_identity -- must
  // belong to the SAME race_instance_id, never another race's history
  // leaking into this one's prompt.
  if (!Array.isArray(ctx.historical_relevant_memory) || ctx.historical_relevant_memory.length > MAX_HISTORY_ITEMS
    || !ctx.historical_relevant_memory.every(h => {
      if (!object(h) || h.role !== 'canonical_observed_history' || !boundedStr(h.decision_id) || !nonNegInt(h.revision)) return false;
      if (!(h.target_lap === null || (nonNegInt(h.target_lap) && h.target_lap <= MAX_LAP))) return false;
      if (!(h.selected_plan === null || ['A', 'B', 'C'].includes(h.selected_plan))) return false;
      const ref = h.record_ref;
      if (!object(ref) || !boundedStr(ref.race_instance_id) || !nonNegInt(ref.session_num)) return false;
      if (!boundedStr(ref.decision_id) || !nonNegInt(ref.revision)) return false;
      if (ref.decision_id !== h.decision_id || ref.revision !== h.revision) return false;
      // round3 fix: only race_instance_id was checked against the current
      // scope ("history現在raceのみ一致でsession本人scope未検査") -- a
      // DIFFERENT session within the SAME race_instance_id passed. Add
      // session_num. Epoch is deliberately NOT required to match: a
      // legitimate past decision from before a process restart keeps its
      // own original epoch and must still be usable as scoped history, not
      // forced to match the current epoch.
      if (ctx.freshness.available && ctx.race_identity) {
        if (ref.race_instance_id !== ctx.race_identity.race_instance_id) return false;
        if (ref.session_num !== ctx.race_identity.session_num) return false;
      }
      return true;
    })) return false;
  // Current-authority fields must never be populated while canonical is
  // marked unavailable -- this is the exact WO014 "stale spread" defect
  // (currentCanonicalStrategyLive leaking old fuel/lap/epoch) restated as a
  // structural invariant, so a server-side regression fails closed too.
  if (!ctx.freshness.available) {
    if (ctx.current_facts.available !== false) return false;
    if (ctx.active_plan !== null || ctx.race_identity !== null) return false;
    if (ctx.allowed_actions.execution_allowed !== false) return false;
    if (ctx.auxiliary_observations !== null) return false;
  }
  return true;
}

const api = { SCHEMA, SCHEMA_VERSION, build, validate };
if (typeof module === 'object') module.exports = api;
root.PitwallRaceContextBuilder = api;
})(typeof globalThis === 'object' ? globalThis : this);
