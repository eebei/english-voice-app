"""
OMORAY PITWALL - bridge.py <-> plan_lifecycle adapter (WO-005)

review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md WO-005 Revision 7 §4.2/§4.5/§4.6.
Pure helper functions that translate between `bridge.py`'s existing legacy
Plan record shape (the dict `build_strategy_decision()` / the initial
playbook already build — `selected_plan` / `target_lap` / `add_fuel_l` /
`set_fuel_l` / `conditions` / `evidence_snapshot_id` / `options_snapshot` /
`decision_id`) and `plan_lifecycle.py`'s canonical `PlanLifecycleRecord`.

【責務】
  `bridge.py.poll_iracing()`が「今のcontentは今のLifecycle active/awaiting
  recordと同じか（reuse／same_content retry）」「新規registerか」
  「register-active+replaceか（新content Plan Aが既存activeを置換）」を
  一箇所の判定関数（`classify_active_registration()`）へ委ね、legacy
  consumer（box call payload・fuel authority入力・`active_decision_plan`等）
  へ渡す互換dictを`legacy_decision_projection()`/
  `legacy_strategy_options_projection()`で作る。

【不変性】
  ここはLifecycle stateを一切mutationしない。`plan_lifecycle`の遷移APIへの
  引数を組み立てる／その戻り値のrecordから読取専用projectionを作るだけの
  pure関数群。
"""

import hashlib
import types

import plan_lifecycle as pl
import fuel_reference_planning as reference_planning


_CONTENT_FIELDS = (
    'selected_plan', 'target_lap', 'add_fuel_l', 'set_fuel_l',
    'conditions', 'evidence_snapshot_id', 'options_snapshot',
)


def _conditions_key(conditions):
    if isinstance(conditions, dict):
        return tuple(sorted(conditions.items()))
    return conditions


def registration_content_matches(record, *, selected_plan, target_lap, add_fuel_l,
                                  set_fuel_l, conditions, evidence_snapshot_id,
                                  options_snapshot):
    """True если `record`（Lifecycle canonical, phase-neutral）が渡された
    candidate contentと同じ「何を実行するか」を表す。`decision_id`や
    revision/phase/pit sequence等の*動的*fieldは比較しない——WO-005 §4.2の
    「後のdecision-lockが同じcontentのPlan Aを扱う時は、このactive recordを
    再利用する」判定に使う。`plan_lifecycle.serialize_plan_lifecycle_record()`
    （公開API）が返す thaw 済みdictと比較するので、内部の`_deep_freeze()`
    表現（`MappingProxyType`/`tuple`）に依存しない。
    """
    serialized = pl.serialize_plan_lifecycle_record(record)
    candidate = {
        'selected_plan': selected_plan, 'target_lap': target_lap,
        'add_fuel_l': add_fuel_l, 'set_fuel_l': set_fuel_l,
        'conditions': conditions, 'evidence_snapshot_id': evidence_snapshot_id,
        'options_snapshot': options_snapshot,
    }
    if _conditions_key(serialized.get('conditions')) != _conditions_key(candidate['conditions']):
        return False
    for field in ('selected_plan', 'target_lap', 'add_fuel_l', 'set_fuel_l',
                  'evidence_snapshot_id', 'options_snapshot'):
        if serialized.get(field) != candidate[field]:
            return False
    return True


def content_signature_hash(*, selected_plan, target_lap, add_fuel_l, set_fuel_l,
                            conditions, evidence_snapshot_id):
    sig = (selected_plan, target_lap, add_fuel_l, set_fuel_l,
           _conditions_key(conditions), evidence_snapshot_id)
    return hashlib.sha1(repr(sig).encode('utf-8')).hexdigest()[:12]


def initial_plan_a_decision_id(race_instance_id, snapshot_id, *, selected_plan,
                                target_lap, add_fuel_l, set_fuel_l, conditions,
                                evidence_snapshot_id, options_snapshot=None):
    """Deterministic decision_id for the pre-decision-lock initial-playbook
    registration. Always starts with `<race_instance_id>:` — required by
    `driver_pit_event.freeze_plan_reference()`'s existing contract.
    `options_snapshot` is accepted (callers naturally pass the same kwargs
    dict used for registration) but not hashed — the other six fields are
    already sufficient content identity.
    """
    sig_hash = content_signature_hash(
        selected_plan=selected_plan, target_lap=target_lap, add_fuel_l=add_fuel_l,
        set_fuel_l=set_fuel_l, conditions=conditions,
        evidence_snapshot_id=evidence_snapshot_id)
    return '%s:%s:initial:sig-%s' % (race_instance_id, snapshot_id, sig_hash)


def plan_basis_from_decision(decision_plan):
    """Extract the judgement-basis fields (WO-005 §4.2: `reason`等の判断根拠は
    `plan_basis`へ) out of the legacy decision-plan dict that
    `build_strategy_decision()` / the initial playbook already build.
    """
    if not isinstance(decision_plan, dict):
        return None
    return {
        'reason': decision_plan.get('reason'),
        'decided_at_lap': decision_plan.get('decided_at_lap'),
        'entry_class_position': decision_plan.get('entry_class_position'),
    }


def legacy_decision_projection(record, *, dispatch_id=None):
    """Read-only compatibility dict shaped like the legacy `active_decision_plan`
    / `pending_strategy_proposal` — built fresh from the canonical
    `PlanLifecycleRecord` every call (WO-005 §4.6). Consumers may read this;
    mutating it never writes back to Lifecycle. `dispatch_id` is bridge-local
    transport state (WO-005 §3.2) merged in by the caller, not part of the
    canonical record.
    """
    serialized = pl.serialize_plan_lifecycle_record(record)
    basis = serialized.get('plan_basis') or {}
    projection = {
        'decision_id': serialized['decision_id'],
        'provisional_history': reference_planning.public_reference(record),
        'selected_plan': serialized['selected_plan'],
        'reason': basis.get('reason'),
        'decided_at_lap': basis.get('decided_at_lap'),
        'entry_class_position': basis.get('entry_class_position'),
        'target_lap': serialized['target_lap'],
        'add_fuel_l': serialized['add_fuel_l'],
        'set_fuel_l': serialized['set_fuel_l'],
        'session_num': serialized['session_num'],
        'conditions': serialized['conditions'],
        'evidence_snapshot_id': serialized['evidence_snapshot_id'],
        'options_snapshot': serialized['options_snapshot'],
    }
    if dispatch_id is not None:
        projection['dispatch_id'] = dispatch_id
    return projection


def legacy_strategy_options_projection(record):
    """Read-only `strategy_options`-shaped dict built from the canonical
    active record's FROZEN `options_snapshot` (WO-005 §4.6): "decision/BOX
    radio payload内の`strategy_options`も、当該Lifecycle active recordの
    凍結`options_snapshot`から作るcompatibility projectionとする。live
    recommended snapshotを同じPlan名で混入させない。" `selected_plan` is
    overridden to the record's own (frozen at registration) selection —
    never re-read from a live/changing source.
    """
    serialized = pl.serialize_plan_lifecycle_record(record)
    snapshot = serialized.get('options_snapshot')
    if not isinstance(snapshot, dict):
        return {'available': False, 'selected_plan': serialized['selected_plan']}
    projection = dict(snapshot)
    projection['selected_plan'] = serialized['selected_plan']
    return projection


class ActiveRegistrationPlan(object):
    """Outcome of `classify_active_registration()` — tells the caller exactly
    ONE of three things to do next. Never touches Lifecycle state itself."""

    __slots__ = ('action', 'decision_id')

    def __init__(self, action, decision_id=None):
        self.action = action  # 'reuse' | 'register_new' | 'register_replacing'
        self.decision_id = decision_id


def classify_active_registration(state, *, selected_plan, target_lap, add_fuel_l,
                                  set_fuel_l, conditions, evidence_snapshot_id,
                                  options_snapshot):
    """WO-005 §4.2/§4.3: decide whether a Plan-A-shaped active candidate
    should REUSE the current active record (same content, keep its
    decision_id — no new record, no replacement), REGISTER_NEW (no active
    record exists yet), or REGISTER_REPLACING (an active record exists with
    DIFFERENT content — the caller must go through
    `plan_lifecycle.register_active_replacing_plan()`).

    Never mutates `state`. Returns an `ActiveRegistrationPlan`.
    """
    active = pl.active_plan_view(state)
    if active is None:
        return ActiveRegistrationPlan('register_new')
    if registration_content_matches(
            active, selected_plan=selected_plan, target_lap=target_lap,
            add_fuel_l=add_fuel_l, set_fuel_l=set_fuel_l, conditions=conditions,
            evidence_snapshot_id=evidence_snapshot_id, options_snapshot=options_snapshot):
        return ActiveRegistrationPlan('reuse', decision_id=active.decision_id)
    return ActiveRegistrationPlan('register_replacing', decision_id=active.decision_id)


def find_awaiting_record_for_signature(state, *, selected_plan, target_lap, add_fuel_l,
                                        set_fuel_l, conditions, evidence_snapshot_id,
                                        options_snapshot):
    """Return the current `awaiting_driver` record whose content matches the
    given candidate, or `None`. Used to detect a same-content proposal retry
    (WO-005 §4.4) without relying on decision_id equality (a fresh proposal
    built by `build_strategy_decision()` gets a new decision_id every call).
    """
    for record in state.plan_records.values():
        if record.phase != 'awaiting_driver':
            continue
        if registration_content_matches(
                record, selected_plan=selected_plan, target_lap=target_lap,
                add_fuel_l=add_fuel_l, set_fuel_l=set_fuel_l, conditions=conditions,
                evidence_snapshot_id=evidence_snapshot_id, options_snapshot=options_snapshot):
            return record
    return None


def current_awaiting_record(state):
    """Return the sole `awaiting_driver` record in `state`, or `None`. A
    Plan A commit path never creates one, and WO-005 keeps at most one
    awaiting proposal at a time (a new decision-lock only runs once the
    prior proposal resolved), so this lookup is unambiguous."""
    for record in state.plan_records.values():
        if record.phase == 'awaiting_driver':
            return record
    return None
