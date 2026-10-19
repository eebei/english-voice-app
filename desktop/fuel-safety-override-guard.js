// WO-005 REVISE 1 R3/R4 substrate: pure verification for the Bridge-attached
// `fuel_strategy_warning.safety_override`.
//
// Bridge freezes an active Plan's decision (decision_id + revision) and the
// source frame at which it was activated (activated_source_frame_sequence,
// stable while the record is active — NOT the ever-incrementing live frame
// counter). This module is the SINGLE place that decides whether a given
// `safety_override` object actually refers to the SAME active decision the
// renderer's own `telemetry_live` currently believes is active, on all three
// axes (decision id, revision, activated frame). Any mismatch or missing
// value fails closed (verified=false) — the caller must then run the normal
// two-stage fuel guard unchanged.
//
// renderer.html and this file's own test both call `verifyFuelSafetyOverride`
// directly, so no behavior is duplicated or re-implemented for testing.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallFuelSafetyOverrideGuard = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function verifyFuelSafetyOverride({ trigger, safetyOverride, refDecisionId, refRevision,
                                       refActivatedSourceFrameSequence } = {}) {
    if (trigger !== 'fuel_strategy_warning' || !safetyOverride
        || typeof safetyOverride !== 'object') {
      return { verified: false, reason: 'no_override_object' };
    }
    if (safetyOverride.diagnostic !== 'authority_requires_new_decision') {
      return { verified: false, reason: 'wrong_diagnostic' };
    }
    if (typeof safetyOverride.decision_id !== 'string'
        || safetyOverride.decision_id !== refDecisionId) {
      return { verified: false, reason: 'decision_id_mismatch' };
    }
    if (safetyOverride.revision !== refRevision) {
      return { verified: false, reason: 'revision_mismatch' };
    }
    const frameFinite = Number.isFinite(safetyOverride.activated_source_frame_sequence)
      && Number.isFinite(refActivatedSourceFrameSequence);
    if (!frameFinite) {
      return { verified: false, reason: 'frame_not_comparable' };
    }
    if (safetyOverride.activated_source_frame_sequence !== refActivatedSourceFrameSequence) {
      return { verified: false, reason: 'frame_mismatch' };
    }
    return { verified: true, reason: 'matched', override_reason: safetyOverride.override_reason || null };
  }

  function isHeldFuelFact(data = {}) {
    return ['fuel_strategy_warning', 'fuel_warning'].includes(data.trigger) && data.fact_only === true
      && typeof data.execution_hold === 'string' && data.execution_hold.length > 0
      && data.set_fuel_l === null && data.pit_required !== true
      && (data.safety_override === null || (typeof data.safety_override === 'object' && !Array.isArray(data.safety_override)))
      && (data.trigger === 'fuel_warning' ? Number.isFinite(data.fuel) : Number.isFinite(data.margin_l))
      && typeof data.message === 'string';
  }
  return { verifyFuelSafetyOverride, isHeldFuelFact };
}));
