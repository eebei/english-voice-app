"""WO-018: Plan outcomes for the debrief, taken from the canonical Lifecycle owner.

`session_summary` is the debrief's source.  It already carries the WO-003 pit events
(execution_relation / penalty evidence); this module adds what each Plan of the SAME
race/session became (executed / invalidated / cancelled, with the Lifecycle's own reason)
so the debrief can state "early stop invalidated Plan A" instead of asking the driver to
classify a stop the Bridge already classified.

Rules:
- Only the state whose scope equals the summary's race_instance_id/session_num is used.
  A missing or different-scope state yields available=False with a reason; nothing is
  inferred or carried over from another race/session.
- Phases and reasons are copied from the Lifecycle record, never re-derived here.
- Bounded: newest MAX_RECORDS by created frame.  Heavy basis/options stay in the owner.
"""
import plan_lifecycle as pl
import fuel_reference_planning as fuel_reference

MAX_RECORDS = 16


def _view(record):
    terminal = record.phase in pl.TERMINAL_PHASES
    return {
        'decision_id': record.decision_id,
        'race_instance_id': record.race_instance_id,
        'session_num': record.session_num,
        'revision': record.revision,
        'selected_plan': record.selected_plan,
        'target_lap': record.target_lap,
        'add_fuel_l': record.add_fuel_l,
        'set_fuel_l': record.set_fuel_l,
        'provisional_history': fuel_reference.public_reference(record),
        'phase': record.phase,
        'registered_phase': record.registered_phase,
        'terminal': terminal,
        # executed has no invalidated_reason; the Lifecycle's executed path is 'normal'.
        'reason': ('normal' if record.phase == 'executed' else record.invalidated_reason) if terminal else None,
        'execution_relation': record.execution_relation,
        'terminal_pit_event_id': record.terminal_pit_event_id,
        'resolved_pit_sequence': record.resolved_pit_sequence,
        'registered_driver_pit_sequence': record.registered_driver_pit_sequence,
        'created_source_frame_sequence': record.created_source_frame_sequence,
    }


def plan_outcomes(state, race_instance_id, session_num):
    if not isinstance(race_instance_id, str) or not race_instance_id \
            or not isinstance(session_num, int) or isinstance(session_num, bool):
        return {'available': False, 'reason': 'summary_identity_missing', 'records': []}
    if state is None:
        return {'available': False, 'reason': 'lifecycle_state_missing', 'records': []}
    if state.race_instance_id != race_instance_id or state.session_num != session_num:
        return {'available': False, 'reason': 'lifecycle_scope_mismatch', 'records': []}
    records = sorted(state.plan_records.values(),
                     key=lambda r: (r.created_source_frame_sequence, r.decision_id))
    return {'available': True, 'reason': None,
            'truncated': len(records) > MAX_RECORDS,
            'records': [_view(r) for r in records[-MAX_RECORDS:]]}


def refresh(summary, state):
    """Re-read outcomes for a held summary only while the state is still its own scope."""
    if not isinstance(summary, dict):
        return summary
    fresh = plan_outcomes(state, summary.get('race_instance_id'), summary.get('session_num'))
    if not fresh['available']:
        return summary
    return dict(summary, plan_outcomes=fresh)
