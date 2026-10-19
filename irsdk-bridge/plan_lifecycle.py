"""
OMORAY PITWALL - Pure PlanLifecycleRecord State Machine / Terminal Rules (WO-004)

review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md WO-004 (Revision 2). Fixes the
generation of Plan `active_decision_plan` / `active_decision_id` / assorted
booleans scattered across `bridge.py.poll_iracing()` into a single pure state
machine that owns Plan lifetime and terminal rules.

【責務】
  This module knows nothing about telemetry, `bridge.py`, BOX calls, or
  Driver speech. It consumes the real, already-classified, immutable
  `driver_pit_event.DriverPitEvent` (WO-003) as the sole input describing
  what actually happened at a pit visit, and moves a `PlanLifecycleRecord`
  through `awaiting_driver -> active -> {executed | invalidated | cancelled}`
  without ever re-deriving `execution_relation` from fuel, laps, or flags.

【スコープ外（WO-005以降）】
  `bridge.py`の旧7state変数の移行・配線、`poll_iracing()`からactual pit /
  penaltyでこのmoduleを呼ぶ配線、旧BOX call遮断、Driver発話Intent、fresh fuel
  authority / `AuthorityProof` / BOX call配送、Desktop / Server / speech /
  memory / debrief、Road Atlanta acceptance F01を緑にすること。この module
  はproduct wiringが0の未接続modelである。

【不変性】
  `PlanLifecycleRecord` / `RaceStrategyState`とその履歴・診断エントリは
  すべて`frozen=True`のdataclass。遷移関数は入力recordやstateを一切
  mutationせず、常に新しいオブジェクトを返す。`dataclass(frozen=True)`は
  トップレベルの属性再代入だけを禁止し、`state.plan_records.clear()`や
  `record.conditions['x']=...`のような**内部dict/listへの直接mutation**は
  防げない（2026-09-24 監査Codex REVISE 1 P1-1）。このため`RaceStrategyState`の
  `plan_records` / `applied_pit_events`は`types.MappingProxyType`で保持し、
  `PlanLifecycleRecord`の`conditions` / `validity_contract` / `options_snapshot` /
  `plan_basis`と`LifecycleDiagnostic.detail`は`_deep_freeze()`でdict->
  `MappingProxyType`・list/tuple->`tuple`・set->`frozenset`へ再帰的に変換して
  から格納する。`plan_records`/`applied_pit_events`の更新はcopy-on-write
  （`driver_pit_event.py`の`store_put()`と同じ規律）で新しいimmutable mapping
  を作り直す。serializerは`_deep_thaw()`で呼ぶたびに新しい可変dict/listを
  返すので、consumerがそれを変更しても正本stateへは波及しない。

  2026-09-24 監査Codex REVISE 2：上記の凍結は`register_plan()` /
  `_with_diagnostic()` / `_store_record()`だけでなく、`PlanLifecycleRecord` /
  `LifecycleDiagnostic` / `RaceStrategyState`各`__post_init__()`自身も行う。
  公開dataclass constructorを直接呼んでこれらのmodule関数を迂回しても、
  凍結・active record不変条件は迂回できない。

【terminal規則】
  `executed / invalidated / cancelled`はterminalであり、後続のいかなる
  eventやACKでも`active`へ復帰しない。terminal recordは物理削除せず
  `RaceStrategyState.plan_records`に残り続け、`history`にも1度だけ遷移が
  記録される。`active_plan_view()`は`active_plan_id`が指すrecordの
  `phase == 'active'`の時だけそのrecordを返す。
"""

import types
from dataclasses import dataclass, replace
from typing import Any, Mapping, Optional, Tuple

import driver_pit_event as dpe


SCHEMA_VERSION = 1

TERMINAL_PHASES = ('executed', 'invalidated', 'cancelled')
NON_TERMINAL_PHASES = ('awaiting_driver', 'active')


@dataclass(frozen=True)
class DriverPlanIntent:
    """Immutable, already-classified Driver command (WO-006).

    Natural-language classification remains a Desktop responsibility.  This
    value object is only the identity/authority envelope consumed by the
    canonical lifecycle owner.
    """
    command_id: str
    operation: str
    race_instance_id: str
    session_num: int
    target_decision_id: str
    expected_revision: int
    expected_activation_source_frame_sequence: int
    received_source_frame_sequence: int
    driver_pit_sequence: int
    utterance_id: Optional[str] = None
    requested_target_lap: Optional[int] = None
    reason_text: Optional[str] = None

# 登録時に凍結し、以後の遷移では絶対に書き換えない「登録時content」field。
# register_plan()のretry/collision判定はこの集合を比較する——phase / revision /
# resolved_pit_sequence等の*動的*lifecycle fieldは含めない。`registered_phase`
# （register_plan()へ渡されたphase引数そのものを永久凍結した値）を含めることで、
# 現在のlifecycle phaseがどれだけ進行していても「登録時に何を要求したか」だけで
# retry/collisionを判定する（2026-09-24 監査Codex REVISE 1 P1-3）。
_REGISTRATION_CONTENT_FIELDS = (
    'registered_phase', 'selected_plan', 'plan_basis', 'target_lap', 'add_fuel_l', 'set_fuel_l',
    'conditions', 'validity_contract', 'evidence_snapshot_id', 'options_snapshot',
    'created_source_frame_sequence', 'registered_driver_pit_sequence',
)
# `activated_source_frame_sequence` / `expected_pit_sequence` /
# `activation_record_revision`は、`registered_phase == 'active'`のrecordだけ
# 登録と同時に永久凍結され二度と変わらない。`registered_phase ==
# 'awaiting_driver'`のrecordではこれらが後続の`activate_plan()`でNone以外へ
# 変化するため、「登録時に何を要求したか」の比較に含めると、進行後の同一内容
# retryが誤ってcollision扱いになる——含めるのは`registered_phase == 'active'`
# の時だけ。
_ACTIVE_ONLY_REGISTRATION_CONTENT_FIELDS = (
    'activated_source_frame_sequence', 'expected_pit_sequence', 'activation_record_revision',
)


# ══════════════════════════════════════════════════════════════════════
# Deep immutability helpers (2026-09-24 監査Codex REVISE 1 P1-1)
# ══════════════════════════════════════════════════════════════════════

def _deep_freeze(value):
    """任意のJSON互換opaque payload（`conditions` / `validity_contract` /
    `options_snapshot` / `plan_basis` / `LifecycleDiagnostic.detail`）を、
    dict->`types.MappingProxyType`、list/tuple->`tuple`、set->`frozenset`へ
    再帰的に変換する。呼び出し側がのちに元のdict/listを書き換えても、
    格納済みの値には一切波及しない。スカラー値・`None`・dataclass instance等は
    そのまま返す。"""
    if isinstance(value, dict):
        return types.MappingProxyType({k: _deep_freeze(v) for k, v in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_deep_freeze(v) for v in value)
    if isinstance(value, (set, frozenset)):
        return frozenset(_deep_freeze(v) for v in value)
    return value


def _deep_thaw(value):
    """`_deep_freeze()`の逆変換。serializerが呼ぶたびに新しい可変dict/list/
    setを返すので、consumerがその戻り値を変更しても正本state/recordには
    波及しない。"""
    if isinstance(value, types.MappingProxyType):
        return {k: _deep_thaw(v) for k, v in value.items()}
    if isinstance(value, tuple):
        return [_deep_thaw(v) for v in value]
    if isinstance(value, frozenset):
        return {_deep_thaw(v) for v in value}
    return value


# ══════════════════════════════════════════════════════════════════════
# Frozen value objects
# ══════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class PlanLifecycleRecord:
    decision_id: str
    race_instance_id: str
    session_num: int
    revision: int
    selected_plan: str
    plan_basis: Any
    target_lap: Optional[int]
    add_fuel_l: Optional[float]
    set_fuel_l: Optional[float]
    conditions: Any
    validity_contract: Any
    evidence_snapshot_id: Optional[str]
    options_snapshot: Any
    phase: str
    registered_phase: str
    expected_pit_sequence: Optional[int]
    resolved_pit_sequence: Optional[int]
    invalidated_reason: Optional[str]
    execution_relation: Optional[str]
    terminal_pit_event_id: Optional[str]
    created_source_frame_sequence: int
    registered_driver_pit_sequence: int
    activated_source_frame_sequence: Optional[int]
    activation_record_revision: Optional[int]

    def __post_init__(self):
        # 2026-09-24 監査Codex REVISE 2：`register_plan()`はこれらを事前に
        # `_deep_freeze()`してから渡すが、公開constructor（`PlanLifecycleRecord(...)`）を
        # `register_plan()`を経由せず直接呼んでも不変であるべき——凍結は
        # constructor自身の責務とする（`_deep_freeze()`は既に凍結済みの値には
        # 冪等なので、`register_plan()`経由の二重凍結は無害）。
        object.__setattr__(self, 'plan_basis', _deep_freeze(self.plan_basis))
        object.__setattr__(self, 'conditions', _deep_freeze(self.conditions))
        object.__setattr__(self, 'validity_contract', _deep_freeze(self.validity_contract))
        object.__setattr__(self, 'options_snapshot', _deep_freeze(self.options_snapshot))
        if self.phase not in NON_TERMINAL_PHASES + TERMINAL_PHASES:
            raise ValueError('invalid PlanLifecycleRecord.phase: %r' % (self.phase,))
        if self.registered_phase not in ('awaiting_driver', 'active'):
            raise ValueError(
                'invalid PlanLifecycleRecord.registered_phase: %r' % (self.registered_phase,))
        if self.phase == 'awaiting_driver':
            if self.activated_source_frame_sequence is not None:
                raise ValueError(
                    'awaiting_driver record must not have activated_source_frame_sequence set')
            if self.expected_pit_sequence is not None:
                raise ValueError('awaiting_driver record must not have expected_pit_sequence frozen')
            if self.activation_record_revision is not None:
                raise ValueError('awaiting_driver record must not have activation_record_revision set')
        elif self.phase == 'active':
            # REVISE 2 item 5：`phase='active'`を直接constructorへ渡す経路も、
            # activation frame / expected sequence / activation revisionの
            # 必須組合せを迂回できない。
            if self.activated_source_frame_sequence is None:
                raise ValueError('active record must have activated_source_frame_sequence frozen')
            if self.expected_pit_sequence is None:
                raise ValueError('active record must have expected_pit_sequence frozen')
            if self.activation_record_revision is None:
                raise ValueError('active record must have activation_record_revision frozen')


@dataclass(frozen=True)
class LifecycleHistoryEntry:
    """コピーしたPlan本文ではなく、decision / event / transition / reason /
    revisionを指す不変の監査entry。"""
    decision_id: str
    race_instance_id: str
    session_num: int
    revision: int
    phase: str
    reason: str
    pit_event_id: Optional[str]


@dataclass(frozen=True)
class LifecycleDiagnostic:
    """active Planがない、identity不一致、未知event等を無言で握り潰さない
    ための構造化ログ。Plan state / historyには一切影響しない。`detail`は
    constructor自身が`_deep_freeze()`する（2026-09-24 監査Codex REVISE 2）ので、
    `_with_diagnostic()`を経由せず直接構築しても外部から
    `diagnostic.detail[...] = ...`を実行できない。"""
    code: str
    decision_id: Optional[str]
    pit_event_id: Optional[str]
    race_instance_id: Optional[str]
    session_num: Optional[int]
    detail: Any

    def __post_init__(self):
        object.__setattr__(
            self, 'detail',
            _deep_freeze(self.detail) if self.detail is not None else types.MappingProxyType({}))


@dataclass(frozen=True)
class LifecycleOutcome:
    """全ての遷移APIが返す構造化outcome。`status`は粗い分類
    （registered/retry_no_op/collision/activated/executed/invalidated/
    cancelled/diagnostic）、`reason`はより具体的なcode。"""
    status: str
    decision_id: Optional[str] = None
    pit_event_id: Optional[str] = None
    reason: Optional[str] = None
    detail: Optional[dict] = None


@dataclass(frozen=True)
class RaceStrategyState:
    """`plan_records` / `applied_pit_events`は常に`types.MappingProxyType`
    （2026-09-24 監査Codex REVISE 1 P1-1）——`state.plan_records.clear()`や
    `state.applied_pit_events[...] = ...`は`AttributeError`/`TypeError`に
    なる。唯一の書込み経路はcopy-on-writeで新しいmappingを作り直す
    `_store_record()`/`apply_pit_event()`。"""
    race_instance_id: str
    session_num: int
    plan_records: Mapping[str, PlanLifecycleRecord]
    active_plan_id: Optional[str]
    applied_pit_events: Mapping[str, Any]
    history: Tuple[LifecycleHistoryEntry, ...]
    diagnostics: Tuple[LifecycleDiagnostic, ...]

    def __post_init__(self):
        # 2026-09-24 監査Codex REVISE 2：公開constructor
        # （`RaceStrategyState(...)`）を内部のcopy-on-write経路
        # （`_store_record()`等）を経由せず直接呼んでも、`plan_records` /
        # `applied_pit_events`は必ず独立した新規immutable mappingへ、
        # `history` / `diagnostics`は必ずtupleへ正規化してから保持する。
        # 呼び出し側が渡した元のdict/listを後から書き換えても、検査より前に
        # コピー済みのため、このstateには一切波及しない。
        object.__setattr__(self, 'plan_records', types.MappingProxyType(dict(self.plan_records)))
        object.__setattr__(
            self, 'applied_pit_events', types.MappingProxyType(dict(self.applied_pit_events)))
        object.__setattr__(self, 'history', tuple(self.history))
        object.__setattr__(self, 'diagnostics', tuple(self.diagnostics))

        # P1-2（2026-09-24 監査Codex REVISE 1）：active recordは高々1件。
        # 1件あるなら`active_plan_id`は必ずそれを指し、0件ならpointerは必ず
        # `None`——複数active、active無しpointer有り、active有りpointer無しを
        # 全てここで拒否する。awaiting_driver + active各1件の共存は許容する。
        active_decision_ids = tuple(
            decision_id for decision_id, record in self.plan_records.items()
            if record.phase == 'active')
        if len(active_decision_ids) > 1:
            raise ValueError(
                'at most one phase==active record is allowed, found %r'
                % (active_decision_ids,))
        if self.active_plan_id is None:
            if active_decision_ids:
                raise ValueError(
                    'a phase==active record exists (%r) but active_plan_id is None'
                    % (active_decision_ids,))
        else:
            record = self.plan_records.get(self.active_plan_id)
            if record is None or record.phase != 'active':
                raise ValueError(
                    'active_plan_id %r must reference a phase==active record'
                    % (self.active_plan_id,))
        for decision_id, record in self.plan_records.items():
            if record.race_instance_id != self.race_instance_id \
                    or record.session_num != self.session_num:
                raise ValueError(
                    'plan record %r scope does not match state scope' % (decision_id,))


# ══════════════════════════════════════════════════════════════════════
# Small internal helpers
# ══════════════════════════════════════════════════════════════════════

def _is_nonempty_str(value):
    return isinstance(value, str) and value != ''


def _with_diagnostic(state, code, *, decision_id=None, pit_event_id=None, detail=None):
    entry = LifecycleDiagnostic(
        code=code, decision_id=decision_id, pit_event_id=pit_event_id,
        race_instance_id=state.race_instance_id, session_num=state.session_num,
        detail=_deep_freeze(detail) if detail is not None else types.MappingProxyType({}))
    return replace(state, diagnostics=state.diagnostics + (entry,))


def _diagnostic_result(state, status, code, *, decision_id=None, pit_event_id=None, detail=None):
    new_state = _with_diagnostic(
        state, code, decision_id=decision_id, pit_event_id=pit_event_id, detail=detail)
    outcome = LifecycleOutcome(
        status=status, decision_id=decision_id, pit_event_id=pit_event_id, reason=code,
        detail=_deep_thaw(_deep_freeze(detail)) if detail is not None else None)
    return new_state, outcome


def _bump_record(record, *, phase, reason, pit_event_id=None, **field_updates):
    """recordをterminal/active遷移させ、revision+1と対応するhistory entryを
    同じatomic操作で作る。呼び出し側がstateへ書き戻す。"""
    new_revision = record.revision + 1
    new_record = replace(record, phase=phase, revision=new_revision, **field_updates)
    history_entry = LifecycleHistoryEntry(
        decision_id=record.decision_id, race_instance_id=record.race_instance_id,
        session_num=record.session_num, revision=new_revision, phase=phase, reason=reason,
        pit_event_id=pit_event_id)
    return new_record, history_entry


def _store_record(state, new_record, history_entry, *, clear_active=False, set_active=None):
    new_records = dict(state.plan_records)
    new_records[new_record.decision_id] = new_record
    new_active = state.active_plan_id
    if clear_active and state.active_plan_id == new_record.decision_id:
        new_active = None
    if set_active is not None:
        new_active = set_active
    return replace(
        state, plan_records=types.MappingProxyType(new_records), active_plan_id=new_active,
        history=state.history + (history_entry,))


# ══════════════════════════════════════════════════════════════════════
# Scope construction
# ══════════════════════════════════════════════════════════════════════

def new_race_strategy_state(race_instance_id, session_num):
    """新しいrace/session scopeを開始する唯一のconstructor。空文字/型不正な
    identityは拒否し`None`を返す（呼び出し側は生成失敗として扱う）。"""
    if not _is_nonempty_str(race_instance_id) or not isinstance(session_num, int):
        return None
    return RaceStrategyState(
        race_instance_id=race_instance_id, session_num=session_num,
        plan_records=types.MappingProxyType({}), active_plan_id=None,
        applied_pit_events=types.MappingProxyType({}),
        history=(), diagnostics=())


def active_plan_view(state):
    """`active_plan_id`のrecordが`phase == 'active'`の時だけそれを返す。
    `executed`をactive viewに含めない。"""
    if state.active_plan_id is None:
        return None
    record = state.plan_records.get(state.active_plan_id)
    if record is None or record.phase != 'active':
        return None
    return record


# ══════════════════════════════════════════════════════════════════════
# 4.1 Plan registration
# ══════════════════════════════════════════════════════════════════════

def register_plan(state, *, decision_id, race_instance_id, session_num, selected_plan,
                   phase, current_driver_pit_sequence, created_source_frame_sequence,
                   activation_source_frame_sequence=None, plan_basis=None,
                   target_lap=None, add_fuel_l=None, set_fuel_l=None,
                   conditions=None, validity_contract=None, evidence_snapshot_id=None,
                   options_snapshot=None):
    """`awaiting_driver`または`active`のPlan recordを新規作成する唯一の入口。
    Returns `(new_state, LifecycleOutcome)`. 入力dict/list（`plan_basis`,
    `conditions`, `validity_contract`, `options_snapshot`）は`_deep_freeze()`
    してから格納するため、呼び出し側の以後の変更は保存済みrecordへ波及せず、
    consumerが戻り値のnested dict/listを書き換えることもできない。
    """
    if phase not in ('awaiting_driver', 'active'):
        return _diagnostic_result(
            state, 'diagnostic', 'invalid_phase', decision_id=decision_id,
            detail={'phase': phase})
    if not (_is_nonempty_str(decision_id) and _is_nonempty_str(race_instance_id)
            and isinstance(session_num, int) and _is_nonempty_str(selected_plan)):
        return _diagnostic_result(state, 'rejected', 'invalid_identity', decision_id=decision_id)
    if race_instance_id != state.race_instance_id or session_num != state.session_num:
        return _diagnostic_result(
            state, 'rejected', 'scope_mismatch', decision_id=decision_id,
            detail={'state_scope': (state.race_instance_id, state.session_num),
                    'record_scope': (race_instance_id, session_num)})
    if not isinstance(current_driver_pit_sequence, int):
        return _diagnostic_result(
            state, 'rejected', 'missing_current_driver_pit_sequence', decision_id=decision_id)
    if not isinstance(created_source_frame_sequence, int):
        return _diagnostic_result(
            state, 'rejected', 'missing_created_source_frame_sequence', decision_id=decision_id)

    if phase == 'active':
        if not isinstance(activation_source_frame_sequence, int):
            return _diagnostic_result(
                state, 'rejected', 'missing_activation_source_frame_sequence',
                decision_id=decision_id)
        if state.active_plan_id is not None and state.active_plan_id != decision_id:
            return _diagnostic_result(
                state, 'rejected', 'active_owner_conflict', decision_id=decision_id,
                detail={'current_active_plan_id': state.active_plan_id})

    frozen_plan_basis = _deep_freeze(plan_basis)
    frozen_conditions = _deep_freeze(conditions)
    frozen_validity_contract = _deep_freeze(validity_contract)
    frozen_options_snapshot = _deep_freeze(options_snapshot)
    if phase == 'active':
        expected_pit_sequence = current_driver_pit_sequence + 1
        activated_source_frame_sequence = activation_source_frame_sequence
        activation_record_revision = 0
    else:
        expected_pit_sequence = None
        activated_source_frame_sequence = None
        activation_record_revision = None

    candidate = {
        'registered_phase': phase,
        'selected_plan': selected_plan, 'plan_basis': frozen_plan_basis,
        'target_lap': target_lap, 'add_fuel_l': add_fuel_l, 'set_fuel_l': set_fuel_l,
        'conditions': frozen_conditions, 'validity_contract': frozen_validity_contract,
        'evidence_snapshot_id': evidence_snapshot_id, 'options_snapshot': frozen_options_snapshot,
        'created_source_frame_sequence': created_source_frame_sequence,
        'registered_driver_pit_sequence': current_driver_pit_sequence,
        'activated_source_frame_sequence': activated_source_frame_sequence,
        'expected_pit_sequence': expected_pit_sequence,
        'activation_record_revision': activation_record_revision,
    }

    existing = state.plan_records.get(decision_id)
    if existing is not None:
        # P1-3（2026-09-24 監査Codex REVISE 1）：現在のlifecycle phaseが
        # どれだけ進行していても（awaiting_driverからactivate_plan()で
        # activeへ、あるいはterminalへ）、「登録時に何を要求したか」
        # （`registered_phase`＋固定content）だけをsame content判定に使う。
        # `activated_source_frame_sequence`等はregistered_phase=='active'の
        # 時だけ登録と同時に永久凍結されるため、その時だけ比較に含める
        # （awaiting_driver登録がその後activate_plan()で書き換わった値を
        # 誤って「別内容」と判定しないため）。
        same_content = all(
            getattr(existing, field) == candidate[field]
            for field in _REGISTRATION_CONTENT_FIELDS)
        if same_content and existing.registered_phase == 'active':
            same_content = all(
                getattr(existing, field) == candidate[field]
                for field in _ACTIVE_ONLY_REGISTRATION_CONTENT_FIELDS)
        if same_content:
            return state, LifecycleOutcome(
                status='retry_no_op', decision_id=decision_id, reason='same_content')
        return _diagnostic_result(state, 'collision', 'register_collision', decision_id=decision_id)

    record = PlanLifecycleRecord(
        decision_id=decision_id, race_instance_id=race_instance_id, session_num=session_num,
        revision=0, selected_plan=selected_plan, plan_basis=frozen_plan_basis,
        target_lap=target_lap, add_fuel_l=add_fuel_l, set_fuel_l=set_fuel_l,
        conditions=frozen_conditions, validity_contract=frozen_validity_contract,
        evidence_snapshot_id=evidence_snapshot_id, options_snapshot=frozen_options_snapshot,
        phase=phase, registered_phase=phase, expected_pit_sequence=expected_pit_sequence,
        resolved_pit_sequence=None,
        invalidated_reason=None, execution_relation=None, terminal_pit_event_id=None,
        created_source_frame_sequence=created_source_frame_sequence,
        registered_driver_pit_sequence=current_driver_pit_sequence,
        activated_source_frame_sequence=activated_source_frame_sequence,
        activation_record_revision=activation_record_revision)
    history_entry = LifecycleHistoryEntry(
        decision_id=decision_id, race_instance_id=race_instance_id, session_num=session_num,
        revision=0, phase=phase,
        reason=('register_active' if phase == 'active' else 'register_awaiting_driver'),
        pit_event_id=None)
    new_state = _store_record(
        state, record, history_entry,
        set_active=(decision_id if phase == 'active' else None))
    return new_state, LifecycleOutcome(
        status='registered', decision_id=decision_id, reason=history_entry.reason)


# ══════════════════════════════════════════════════════════════════════
# 4.1.1 awaiting_driver -> active
# ══════════════════════════════════════════════════════════════════════

def activate_plan(state, *, decision_id, expected_record_revision,
                   current_driver_pit_sequence, activation_source_frame_sequence):
    """`awaiting_driver -> active`の唯一の昇格入口。Returns
    `(new_state, LifecycleOutcome)`。"""
    record = state.plan_records.get(decision_id)
    if record is None:
        return _diagnostic_result(state, 'rejected', 'unknown_decision', decision_id=decision_id)
    if (record.race_instance_id != state.race_instance_id
            or record.session_num != state.session_num):
        return _diagnostic_result(
            state, 'rejected', 'scope_mismatch', decision_id=decision_id)

    if record.phase != 'awaiting_driver':
        # Terminal-late ACK / already-active retry / stale-phase ACK: never mutate.
        is_retry = (
            record.phase == 'active'
            and record.activated_source_frame_sequence == activation_source_frame_sequence
            and record.registered_driver_pit_sequence == current_driver_pit_sequence
            and record.activation_record_revision == record.revision
            and expected_record_revision == record.revision - 1)
        if is_retry:
            return state, LifecycleOutcome(
                status='retry_no_op', decision_id=decision_id, reason='already_active')
        return _diagnostic_result(
            state, 'diagnostic', 'terminal_or_active_late_ack', decision_id=decision_id,
            detail={'current_phase': record.phase})

    if not isinstance(activation_source_frame_sequence, int):
        return _diagnostic_result(
            state, 'rejected', 'missing_activation_source_frame_sequence',
            decision_id=decision_id)
    if not isinstance(current_driver_pit_sequence, int):
        return _diagnostic_result(
            state, 'rejected', 'missing_current_driver_pit_sequence', decision_id=decision_id)
    if state.active_plan_id is not None and state.active_plan_id != decision_id:
        return _diagnostic_result(
            state, 'diagnostic', 'active_owner_conflict', decision_id=decision_id,
            detail={'current_active_plan_id': state.active_plan_id})
    if expected_record_revision != record.revision:
        return _diagnostic_result(
            state, 'diagnostic', 'stale_activation_revision', decision_id=decision_id,
            detail={'expected': expected_record_revision, 'actual': record.revision})
    if activation_source_frame_sequence < record.created_source_frame_sequence:
        return _diagnostic_result(
            state, 'diagnostic', 'activation_before_creation', decision_id=decision_id,
            detail={'activation_source_frame_sequence': activation_source_frame_sequence,
                    'created_source_frame_sequence': record.created_source_frame_sequence})

    if current_driver_pit_sequence != record.registered_driver_pit_sequence:
        # An actual pit happened while this Plan was awaiting Driver agreement.
        # Terminal-invalidate once; do not activate a proposal whose premise is gone.
        new_record, history_entry = _bump_record(
            record, phase='invalidated', reason='pit_before_plan_activation',
            invalidated_reason='pit_before_plan_activation')
        new_state = _store_record(state, new_record, history_entry, clear_active=True)
        return new_state, LifecycleOutcome(
            status='invalidated', decision_id=decision_id, reason='pit_before_plan_activation')

    new_expected_pit_sequence = current_driver_pit_sequence + 1
    new_record, history_entry = _bump_record(
        record, phase='active', reason='activated',
        expected_pit_sequence=new_expected_pit_sequence,
        activated_source_frame_sequence=activation_source_frame_sequence,
        activation_record_revision=record.revision + 1)
    new_state = _store_record(state, new_record, history_entry, set_active=decision_id)
    return new_state, LifecycleOutcome(status='activated', decision_id=decision_id, reason='activated')


# ══════════════════════════════════════════════════════════════════════
# 4.1.2 WO-005 §4.5: active predecessor -> successor atomic replacement
# ══════════════════════════════════════════════════════════════════════

def activate_replacing_plan(state, *, predecessor_decision_id, expected_predecessor_revision,
                             successor_decision_id, expected_successor_revision,
                             current_driver_pit_sequence, activation_source_frame_sequence):
    """WO-005 §4.5, entry 1: atomically replace an active predecessor with an
    already-registered `awaiting_driver` successor (the B/C-accepted-while-A-
    is-active path). Returns `(new_state, LifecycleOutcome)`.

    `activate_plan()` intentionally refuses to promote a successor while a
    DIFFERENT Plan is active (`active_owner_conflict`) — that refusal must
    stay in place for callers that never intend a replacement. This is the
    separate, explicit, single-transaction entry point for a replacement:
    predecessor -> `cancelled` (`superseded_by:<successor_decision_id>`),
    successor -> `active`, `active_plan_id` pointer moves — all in one
    `replace()` call. No caller can observe an intermediate state with zero
    or two active records, and a stale/late call never disturbs a DIFFERENT
    record that is current active (diagnostic only, no mutation).
    """
    predecessor = state.plan_records.get(predecessor_decision_id)
    successor = state.plan_records.get(successor_decision_id)
    if predecessor is None or successor is None:
        return _diagnostic_result(
            state, 'rejected', 'unknown_decision', decision_id=successor_decision_id,
            detail={'predecessor_decision_id': predecessor_decision_id,
                    'successor_decision_id': successor_decision_id})
    if (predecessor.race_instance_id != state.race_instance_id
            or predecessor.session_num != state.session_num
            or successor.race_instance_id != state.race_instance_id
            or successor.session_num != state.session_num):
        return _diagnostic_result(state, 'rejected', 'scope_mismatch', decision_id=successor_decision_id)
    # A stale/late replacement ACK must never disturb a DIFFERENT record that
    # is current active — diagnostic only, never mutate.
    if state.active_plan_id != predecessor_decision_id or predecessor.phase != 'active':
        return _diagnostic_result(
            state, 'diagnostic', 'replacement_predecessor_not_current_active',
            decision_id=predecessor_decision_id,
            detail={'current_active_plan_id': state.active_plan_id,
                    'predecessor_phase': predecessor.phase})
    if successor.phase != 'awaiting_driver':
        return _diagnostic_result(
            state, 'diagnostic', 'terminal_or_active_late_ack', decision_id=successor_decision_id,
            detail={'current_phase': successor.phase})
    if expected_predecessor_revision != predecessor.revision:
        return _diagnostic_result(
            state, 'diagnostic', 'stale_predecessor_revision', decision_id=predecessor_decision_id,
            detail={'expected': expected_predecessor_revision, 'actual': predecessor.revision})
    if expected_successor_revision != successor.revision:
        return _diagnostic_result(
            state, 'diagnostic', 'stale_successor_revision', decision_id=successor_decision_id,
            detail={'expected': expected_successor_revision, 'actual': successor.revision})
    if not isinstance(activation_source_frame_sequence, int):
        return _diagnostic_result(
            state, 'rejected', 'missing_activation_source_frame_sequence',
            decision_id=successor_decision_id)
    if not isinstance(current_driver_pit_sequence, int):
        return _diagnostic_result(
            state, 'rejected', 'missing_current_driver_pit_sequence', decision_id=successor_decision_id)
    if activation_source_frame_sequence < successor.created_source_frame_sequence:
        return _diagnostic_result(
            state, 'diagnostic', 'activation_before_creation', decision_id=successor_decision_id,
            detail={'activation_source_frame_sequence': activation_source_frame_sequence,
                    'created_source_frame_sequence': successor.created_source_frame_sequence})

    if current_driver_pit_sequence != successor.registered_driver_pit_sequence:
        # WO-005 §4.5: an actual pit happened while this successor was
        # awaiting Driver agreement. This is an explicit transition distinct
        # from a generic validation failure — ONLY the successor terminal-
        # invalidates; the predecessor stays active and the pointer is
        # untouched (the lost premise belongs to the successor alone).
        new_successor, successor_history = _bump_record(
            successor, phase='invalidated', reason='pit_before_plan_activation',
            invalidated_reason='pit_before_plan_activation')
        new_state = _store_record(state, new_successor, successor_history)
        return new_state, LifecycleOutcome(
            status='invalidated', decision_id=successor_decision_id,
            reason='pit_before_plan_activation')

    new_expected_pit_sequence = current_driver_pit_sequence + 1
    new_successor, successor_history = _bump_record(
        successor, phase='active', reason='activated_replacing_predecessor',
        expected_pit_sequence=new_expected_pit_sequence,
        activated_source_frame_sequence=activation_source_frame_sequence,
        activation_record_revision=successor.revision + 1)
    new_predecessor, predecessor_history = _bump_record(
        predecessor, phase='cancelled', reason='superseded_by:%s' % successor_decision_id,
        invalidated_reason='superseded_by:%s' % successor_decision_id)
    new_records = dict(state.plan_records)
    new_records[new_successor.decision_id] = new_successor
    new_records[new_predecessor.decision_id] = new_predecessor
    new_state = replace(
        state, plan_records=types.MappingProxyType(new_records),
        active_plan_id=new_successor.decision_id,
        history=state.history + (predecessor_history, successor_history))
    return new_state, LifecycleOutcome(
        status='activated', decision_id=successor_decision_id,
        reason='activated_replacing_predecessor')


def register_active_replacing_plan(state, *, decision_id, race_instance_id, session_num,
                                    selected_plan, current_driver_pit_sequence,
                                    created_source_frame_sequence,
                                    activation_source_frame_sequence,
                                    expected_predecessor_decision_id,
                                    expected_predecessor_revision,
                                    plan_basis=None, target_lap=None, add_fuel_l=None,
                                    set_fuel_l=None, conditions=None, validity_contract=None,
                                    evidence_snapshot_id=None, options_snapshot=None):
    """WO-005 §4.5, entry 2: register a brand-new `active` record for
    MATERIALLY DIFFERENT content and atomically replace the current active
    predecessor in the same transaction — the "new Plan A commit replaces an
    existing active Plan A" path. Never call this when a successor already
    exists as `awaiting_driver`; use `activate_replacing_plan()` for that.

    A stale/late call (predecessor no longer current active, or revision
    mismatch) never disturbs whatever IS current active — diagnostic only.
    `decision_id` collision (this exact id already registered) is a normal
    `register_plan()`-style collision/retry decision for the CALLER to make
    before invoking this — this function always registers fresh content.
    """
    if state.plan_records.get(decision_id) is not None:
        return _diagnostic_result(state, 'collision', 'register_collision', decision_id=decision_id)
    if not (_is_nonempty_str(decision_id) and _is_nonempty_str(race_instance_id)
            and isinstance(session_num, int) and _is_nonempty_str(selected_plan)):
        return _diagnostic_result(state, 'rejected', 'invalid_identity', decision_id=decision_id)
    if race_instance_id != state.race_instance_id or session_num != state.session_num:
        return _diagnostic_result(state, 'rejected', 'scope_mismatch', decision_id=decision_id)
    predecessor = state.plan_records.get(expected_predecessor_decision_id)
    if predecessor is None:
        return _diagnostic_result(
            state, 'rejected', 'unknown_decision', decision_id=expected_predecessor_decision_id)
    if (predecessor.race_instance_id != state.race_instance_id
            or predecessor.session_num != state.session_num):
        return _diagnostic_result(
            state, 'rejected', 'scope_mismatch', decision_id=expected_predecessor_decision_id)
    if state.active_plan_id != expected_predecessor_decision_id or predecessor.phase != 'active':
        return _diagnostic_result(
            state, 'diagnostic', 'replacement_predecessor_not_current_active',
            decision_id=expected_predecessor_decision_id,
            detail={'current_active_plan_id': state.active_plan_id,
                    'predecessor_phase': predecessor.phase})
    if expected_predecessor_revision != predecessor.revision:
        return _diagnostic_result(
            state, 'diagnostic', 'stale_predecessor_revision',
            decision_id=expected_predecessor_decision_id,
            detail={'expected': expected_predecessor_revision, 'actual': predecessor.revision})
    if not isinstance(current_driver_pit_sequence, int):
        return _diagnostic_result(
            state, 'rejected', 'missing_current_driver_pit_sequence', decision_id=decision_id)
    if not isinstance(created_source_frame_sequence, int):
        return _diagnostic_result(
            state, 'rejected', 'missing_created_source_frame_sequence', decision_id=decision_id)
    if not isinstance(activation_source_frame_sequence, int):
        return _diagnostic_result(
            state, 'rejected', 'missing_activation_source_frame_sequence', decision_id=decision_id)

    frozen_plan_basis = _deep_freeze(plan_basis)
    frozen_conditions = _deep_freeze(conditions)
    frozen_validity_contract = _deep_freeze(validity_contract)
    frozen_options_snapshot = _deep_freeze(options_snapshot)
    expected_pit_sequence = current_driver_pit_sequence + 1
    successor = PlanLifecycleRecord(
        decision_id=decision_id, race_instance_id=race_instance_id, session_num=session_num,
        revision=0, selected_plan=selected_plan, plan_basis=frozen_plan_basis,
        target_lap=target_lap, add_fuel_l=add_fuel_l, set_fuel_l=set_fuel_l,
        conditions=frozen_conditions, validity_contract=frozen_validity_contract,
        evidence_snapshot_id=evidence_snapshot_id, options_snapshot=frozen_options_snapshot,
        phase='active', registered_phase='active', expected_pit_sequence=expected_pit_sequence,
        resolved_pit_sequence=None, invalidated_reason=None, execution_relation=None,
        terminal_pit_event_id=None, created_source_frame_sequence=created_source_frame_sequence,
        registered_driver_pit_sequence=current_driver_pit_sequence,
        activated_source_frame_sequence=activation_source_frame_sequence,
        activation_record_revision=0)
    successor_history = LifecycleHistoryEntry(
        decision_id=decision_id, race_instance_id=race_instance_id, session_num=session_num,
        revision=0, phase='active', reason='register_active_replacing_predecessor',
        pit_event_id=None)
    new_predecessor, predecessor_history = _bump_record(
        predecessor, phase='cancelled', reason='superseded_by:%s' % decision_id,
        invalidated_reason='superseded_by:%s' % decision_id)
    new_records = dict(state.plan_records)
    new_records[decision_id] = successor
    new_records[new_predecessor.decision_id] = new_predecessor
    new_state = replace(
        state, plan_records=types.MappingProxyType(new_records), active_plan_id=decision_id,
        history=state.history + (predecessor_history, successor_history))
    return new_state, LifecycleOutcome(
        status='registered', decision_id=decision_id, reason='register_active_replacing_predecessor')


# ══════════════════════════════════════════════════════════════════════
# 4.2 DriverPitEvent application
# ══════════════════════════════════════════════════════════════════════

def _direct_table_transition(record, event):
    """plan_reference.decision_id == record.decision_idの直接一致経路。
    WO-003の`execution_relation`をそのまま消費し、このmodule内で再分類しない。
    `None`はterminal recordで変化なし（呼び出し側はそのままevent登録だけ行う）。
    """
    relation = event.execution_relation
    if relation == 'penalty':
        return 'invalidated', 'penalty_pit'
    if relation == 'early':
        return 'invalidated', 'driver_early_pit'
    if relation == 'unresolved':
        return 'invalidated', 'pit_relation_unresolved'
    if relation == 'normal':
        if record.phase == 'active':
            if event.driver_pit_sequence == record.expected_pit_sequence:
                return 'executed', 'normal'
            return 'invalidated', 'pit_sequence_mismatch'
        return 'invalidated', 'pit_before_plan_activation'
    # 2026-09-24 監査Codex REVISE 1 不安点5：WO-003は
    # normal/early/penalty/unresolved以外を発行しないはずだが、万一の
    # 契約違反を実際の`unresolved`分類（`pit_relation_unresolved`）と
    # 混同すると、WO-003側の欠陥を隠したままこのmoduleが「正しく
    # unresolvedと判定した」ように見えてしまう。専用reasonでfail-closed
    # invalidateし、WO-003の正常なrelation classificationは一切再分類しない。
    return 'invalidated', 'pit_relation_invalid'


def _indirect_binding(record, event):
    """`plan_reference`がこのrecordを参照していない（無し、または別Plan）
    場合の、frame/sequence証拠だけによるfail-closed結合判定。

    Returns one of:
      ('bind', phase, reason) — このrecordをinvalidateする。
      ('diagnostic', code)    — 証拠不足/古いeventとしてPlanは変えない。
      (None, None)            — このrecordには一切関係しない（診断も不要）。
    """
    if record.phase == 'active':
        anchor_frame = record.activated_source_frame_sequence
        threshold = record.expected_pit_sequence
        bound_reason = 'pit_relation_unbound'
    else:
        anchor_frame = record.created_source_frame_sequence
        threshold = record.registered_driver_pit_sequence + 1
        bound_reason = 'pit_before_plan_activation'

    entry_frame = event.entry.source_frame_sequence
    sequence = event.driver_pit_sequence
    if entry_frame is None or anchor_frame is None:
        return 'diagnostic', 'pit_relation_evidence_missing'
    if not isinstance(sequence, int) or sequence < threshold:
        return 'diagnostic', 'pit_relation_too_old'
    if entry_frame > anchor_frame:
        return 'bind', 'invalidated', bound_reason
    if entry_frame == anchor_frame:
        return 'bind', 'invalidated', 'pit_order_ambiguous'
    return 'diagnostic', 'pit_relation_too_old'


def apply_pit_event(state, event):
    """WO-003の実`DriverPitEvent`を1件適用する。`execution_relation`を
    唯一の分類入力として信頼し、fuel/flag/lapからこのmodule内で再推定しない。
    Returns `(new_state, LifecycleOutcome)`."""
    if (event.race_instance_id != state.race_instance_id
            or event.session_num != state.session_num):
        return _diagnostic_result(
            state, 'diagnostic', 'event_scope_mismatch', pit_event_id=event.pit_event_id,
            detail={'state_scope': (state.race_instance_id, state.session_num),
                    'event_scope': (event.race_instance_id, event.session_num)})

    existing_event = state.applied_pit_events.get(event.pit_event_id)
    if existing_event is not None:
        if existing_event == event:
            return state, LifecycleOutcome(
                status='retry_no_op', pit_event_id=event.pit_event_id, reason='same_content')
        return _diagnostic_result(
            state, 'collision', 'pit_event_collision', pit_event_id=event.pit_event_id)

    reference_decision_id = event.plan_reference.decision_id if event.plan_reference else None

    working_state = state
    consumed = False
    touched_any_record = False

    for decision_id in sorted(state.plan_records.keys()):
        record = working_state.plan_records[decision_id]
        if decision_id == reference_decision_id:
            touched_any_record = True
            if record.phase not in NON_TERMINAL_PHASES:
                consumed = True
                continue
            new_phase, reason = _direct_table_transition(record, event)
            consumed = True
            field_updates = {}
            if new_phase == 'executed':
                field_updates = {
                    'resolved_pit_sequence': event.driver_pit_sequence,
                    'terminal_pit_event_id': event.pit_event_id,
                    'execution_relation': event.execution_relation,
                }
            else:
                field_updates = {
                    'invalidated_reason': reason,
                    'terminal_pit_event_id': event.pit_event_id,
                    'execution_relation': event.execution_relation,
                }
            new_record, history_entry = _bump_record(
                record, phase=new_phase, reason=reason, pit_event_id=event.pit_event_id,
                **field_updates)
            working_state = _store_record(
                working_state, new_record, history_entry, clear_active=True)
            continue

        if record.phase not in NON_TERMINAL_PHASES:
            continue

        outcome = _indirect_binding(record, event)
        if outcome[0] == 'bind':
            _, new_phase, reason = outcome
            consumed = True
            touched_any_record = True
            new_record, history_entry = _bump_record(
                record, phase=new_phase, reason=reason, pit_event_id=event.pit_event_id,
                invalidated_reason=reason, terminal_pit_event_id=event.pit_event_id,
                execution_relation=event.execution_relation)
            working_state = _store_record(
                working_state, new_record, history_entry, clear_active=True)
        elif outcome[0] == 'diagnostic':
            working_state = _with_diagnostic(
                working_state, outcome[1], decision_id=decision_id,
                pit_event_id=event.pit_event_id)
        # (None, None): unrelated record, nothing to log.

    if not touched_any_record and reference_decision_id is not None:
        working_state = _with_diagnostic(
            working_state, 'pit_relation_unknown_decision', decision_id=reference_decision_id,
            pit_event_id=event.pit_event_id)

    if not consumed:
        working_state = _with_diagnostic(
            working_state, 'no_plan_for_pit_event', pit_event_id=event.pit_event_id)

    # P1-4（2026-09-24 監査Codex REVISE 1）：race/session scopeが一致し、
    # canonical ID/content collision検査を通過した初回eventは、いずれかの
    # Planへ結合できたか（`consumed`）に関わらず必ず一度だけledgerへ記録する。
    # そうしないと証拠不足/too-old/no-planのeventは`applied_pit_events`に
    # 残らず、同じeventの再送のたびに同じ診断が積み増され、後から作られた
    # 新Planへ再評価され得る——retryの一度性が構造で保証されない。
    new_events = dict(working_state.applied_pit_events)
    new_events[event.pit_event_id] = event
    working_state = replace(
        working_state, applied_pit_events=types.MappingProxyType(new_events))

    if not consumed:
        return working_state, LifecycleOutcome(
            status='diagnostic', pit_event_id=event.pit_event_id, reason='no_plan_for_pit_event')
    return working_state, LifecycleOutcome(
        status='applied', pit_event_id=event.pit_event_id, reason=event.execution_relation)


# ══════════════════════════════════════════════════════════════════════
# 4.3 Cancel / close boundary
# ══════════════════════════════════════════════════════════════════════

def apply_driver_plan_intent(state, intent):
    """Atomically terminalize active + awaiting records for WO-006.

    The target active record is mandatory.  Every validation happens before
    the copy-on-write commit, so stale commands cannot expose a partially
    cancelled scope.  An early/amend declaration invalidates the active plan;
    explicit cancel cancels it.  Co-existing awaiting proposals are always
    cancelled as ``superseded_by_driver_intent``.  No executed phase is
    produced: actual pit observation remains the responsibility of WO-007.
    """
    if not isinstance(intent, DriverPlanIntent):
        return _diagnostic_result(state, 'rejected', 'invalid_driver_plan_intent')
    if intent.operation not in ('early_pit', 'amend', 'cancel'):
        return _diagnostic_result(
            state, 'rejected', 'invalid_driver_plan_operation',
            decision_id=intent.target_decision_id)
    if (intent.race_instance_id != state.race_instance_id
            or intent.session_num != state.session_num):
        return _diagnostic_result(
            state, 'rejected', 'scope_mismatch', decision_id=intent.target_decision_id)
    active = active_plan_view(state)
    if active is None:
        return _diagnostic_result(
            state, 'rejected', 'no_active_plan', decision_id=intent.target_decision_id)
    if active.decision_id != intent.target_decision_id:
        return _diagnostic_result(
            state, 'diagnostic', 'stale_decision', decision_id=intent.target_decision_id,
            detail={'actual_decision_id': active.decision_id})
    if active.revision != intent.expected_revision:
        return _diagnostic_result(
            state, 'diagnostic', 'stale_revision', decision_id=active.decision_id,
            detail={'expected': intent.expected_revision, 'actual': active.revision})
    if active.activated_source_frame_sequence != \
            intent.expected_activation_source_frame_sequence:
        return _diagnostic_result(
            state, 'diagnostic', 'stale_activation_source_frame',
            decision_id=active.decision_id,
            detail={'expected': intent.expected_activation_source_frame_sequence,
                    'actual': active.activated_source_frame_sequence})
    if intent.driver_pit_sequence != active.expected_pit_sequence - 1:
        return _diagnostic_result(
            state, 'diagnostic', 'stale_driver_pit_sequence',
            decision_id=active.decision_id,
            detail={'expected': active.expected_pit_sequence - 1,
                    'actual': intent.driver_pit_sequence})
    if (not isinstance(intent.received_source_frame_sequence, int)
            or intent.received_source_frame_sequence
            < active.activated_source_frame_sequence):
        return _diagnostic_result(
            state, 'diagnostic', 'stale_source_frame', decision_id=active.decision_id)

    if intent.operation == 'cancel':
        active_phase, active_reason = 'cancelled', 'driver_cancel'
    elif intent.operation == 'amend':
        active_phase, active_reason = 'invalidated', 'driver_plan_amended'
    else:
        active_phase, active_reason = 'invalidated', 'driver_early_pit_declared'

    records = dict(state.plan_records)
    history = list(state.history)
    for decision_id in sorted(records):
        record = records[decision_id]
        if record.phase not in NON_TERMINAL_PHASES:
            continue
        if decision_id == active.decision_id:
            phase, reason = active_phase, active_reason
        elif record.phase == 'awaiting_driver':
            phase, reason = 'cancelled', 'superseded_by_driver_intent'
        else:
            # Constructor invariants make a second active impossible.
            continue
        new_record, entry = _bump_record(
            record, phase=phase, reason=reason, invalidated_reason=reason)
        records[decision_id] = new_record
        history.append(entry)
    new_state = replace(
        state, plan_records=types.MappingProxyType(records), active_plan_id=None,
        history=tuple(history))
    return new_state, LifecycleOutcome(
        status='applied', decision_id=active.decision_id, reason=active_reason,
        detail={'command_id': intent.command_id, 'operation': intent.operation})

def cancel_plan(state, *, decision_id, reason):
    """明示cancelだけが`awaiting_driver | active -> cancelled`へ遷移できる。"""
    if not _is_nonempty_str(reason):
        return _diagnostic_result(
            state, 'rejected', 'missing_cancel_reason', decision_id=decision_id)
    record = state.plan_records.get(decision_id)
    if record is None:
        return _diagnostic_result(state, 'rejected', 'unknown_decision', decision_id=decision_id)
    if (record.race_instance_id != state.race_instance_id
            or record.session_num != state.session_num):
        return _diagnostic_result(state, 'rejected', 'scope_mismatch', decision_id=decision_id)
    if record.phase not in NON_TERMINAL_PHASES:
        return _diagnostic_result(
            state, 'diagnostic', 'already_terminal', decision_id=decision_id,
            detail={'current_phase': record.phase})

    new_record, history_entry = _bump_record(
        record, phase='cancelled', reason=reason, invalidated_reason=reason)
    new_state = _store_record(state, new_record, history_entry, clear_active=True)
    return new_state, LifecycleOutcome(status='cancelled', decision_id=decision_id, reason=reason)


def close_scope(state, *, reason):
    """state scopeと同じnon-terminal Planだけを`cancelled`にする。terminal
    recordは不変のまま保持する。identity変更後の別scopeは
    `new_race_strategy_state()`で別途開始する（このmoduleはmergeしない）。"""
    if reason not in ('session_end', 'race_identity_changed'):
        return _diagnostic_result(state, 'rejected', 'invalid_close_reason', detail={'reason': reason})

    working_state = state
    cancelled_any = False
    for decision_id in sorted(state.plan_records.keys()):
        record = working_state.plan_records[decision_id]
        if record.phase not in NON_TERMINAL_PHASES:
            continue
        new_record, history_entry = _bump_record(
            record, phase='cancelled', reason=reason, invalidated_reason=reason)
        working_state = _store_record(working_state, new_record, history_entry, clear_active=True)
        cancelled_any = True

    status = 'closed' if cancelled_any else 'no_op'
    return working_state, LifecycleOutcome(status=status, reason=reason)


# ══════════════════════════════════════════════════════════════════════
# Serialization (fresh dict every call — consumers cannot mutate the store)
# ══════════════════════════════════════════════════════════════════════

def serialize_plan_lifecycle_record(record):
    return {
        'decision_id': record.decision_id, 'race_instance_id': record.race_instance_id,
        'session_num': record.session_num, 'revision': record.revision,
        'selected_plan': record.selected_plan, 'plan_basis': _deep_thaw(record.plan_basis),
        'target_lap': record.target_lap, 'add_fuel_l': record.add_fuel_l,
        'set_fuel_l': record.set_fuel_l, 'conditions': _deep_thaw(record.conditions),
        'validity_contract': _deep_thaw(record.validity_contract),
        'evidence_snapshot_id': record.evidence_snapshot_id,
        'options_snapshot': _deep_thaw(record.options_snapshot),
        'phase': record.phase, 'registered_phase': record.registered_phase,
        'expected_pit_sequence': record.expected_pit_sequence,
        'resolved_pit_sequence': record.resolved_pit_sequence,
        'invalidated_reason': record.invalidated_reason,
        'execution_relation': record.execution_relation,
        'terminal_pit_event_id': record.terminal_pit_event_id,
        'created_source_frame_sequence': record.created_source_frame_sequence,
        'registered_driver_pit_sequence': record.registered_driver_pit_sequence,
        'activated_source_frame_sequence': record.activated_source_frame_sequence,
        'activation_record_revision': record.activation_record_revision,
    }


def serialize_history_entry(entry):
    return {
        'decision_id': entry.decision_id, 'race_instance_id': entry.race_instance_id,
        'session_num': entry.session_num, 'revision': entry.revision, 'phase': entry.phase,
        'reason': entry.reason, 'pit_event_id': entry.pit_event_id,
    }


def serialize_diagnostic(entry):
    return {
        'code': entry.code, 'decision_id': entry.decision_id,
        'pit_event_id': entry.pit_event_id, 'race_instance_id': entry.race_instance_id,
        'session_num': entry.session_num, 'detail': _deep_thaw(entry.detail),
    }


def serialize_race_strategy_state(state):
    return {
        'race_instance_id': state.race_instance_id, 'session_num': state.session_num,
        'active_plan_id': state.active_plan_id,
        'plan_records': {
            decision_id: serialize_plan_lifecycle_record(record)
            for decision_id, record in state.plan_records.items()
        },
        'applied_pit_events': {
            pit_event_id: dpe.serialize_driver_pit_event(event)
            for pit_event_id, event in state.applied_pit_events.items()
        },
        'history': [serialize_history_entry(entry) for entry in state.history],
        'diagnostics': [serialize_diagnostic(entry) for entry in state.diagnostics],
    }


def amend_active_plan(state, intent, *, calculation, authority_inputs, decision_generation=None):
    """WO-008 atomic candidate: validate old identity, terminalize old/awaiting,
    register frozen successor, publish only after every step succeeded.
    Failures return the original state including its diagnostics/history.
    """
    if intent.operation!='amend' or calculation.get('available') is not True:
        return state,LifecycleOutcome(status='rejected',reason='amend_authority_unavailable')
    working,outcome=apply_driver_plan_intent(state,intent)
    if outcome.status!='applied':return state,outcome
    if calculation.get('target_lap')!=intent.requested_target_lap:
        return state,LifecycleOutcome(status='rejected',reason='amend_target_mismatch')
    successor_id='%s:session-%s:driver-amend:%s'%(state.race_instance_id,state.session_num,intent.command_id)
    if decision_generation is not None:successor_id+=':origin:'+decision_generation
    constraint_id=successor_id+':constraint'
    constraint={'constraint_id':constraint_id,'command_id':intent.command_id,
                'race_instance_id':intent.race_instance_id,'session_num':intent.session_num,
                'predecessor_decision_id':intent.target_decision_id,
                'predecessor_revision':intent.expected_revision,
                'predecessor_activation_frame':intent.expected_activation_source_frame_sequence,
                'source_frame_sequence':intent.received_source_frame_sequence,
                'driver_pit_sequence':intent.driver_pit_sequence,'target_lap':intent.requested_target_lap}
    snapshot_id='%s:source-%s'%(constraint_id,authority_inputs['source_frame_sequence'])
    options={'available':True,'selected_plan':'A','reason':'driver_fixed_target',
             'snapshot_id':snapshot_id,'current_lap':authority_inputs['current_lap'],
             'fuel_level_l':authority_inputs['fuel_level_l'],'avg_fuel_per_lap_l':authority_inputs['avg_fuel_per_lap_l'],
             'crossings_to_finish':authority_inputs['crossings_to_finish'],
             'reserve_l':authority_inputs['reserve_l'],
             'plan_a':{**calculation,'action':'driver_fixed_target'},
             'plan_b':{'available':False,'reason':'driver_fixed_target_constraint'},
             'plan_c':{'available':False,'reason':'driver_fixed_target_constraint'}}
    candidate,registration=register_plan(working,decision_id=successor_id,race_instance_id=state.race_instance_id,
        session_num=state.session_num,selected_plan='A',phase='active',
        current_driver_pit_sequence=authority_inputs['driver_pit_sequence'],
        created_source_frame_sequence=authority_inputs['source_frame_sequence'],
        activation_source_frame_sequence=authority_inputs['source_frame_sequence'],
        plan_basis={'reason':'driver_plan_amended','driver_target_constraint':constraint,
                    'authority_inputs':authority_inputs,'command_id':intent.command_id},
        target_lap=calculation['target_lap'],add_fuel_l=calculation['add_fuel_l'],set_fuel_l=calculation['set_fuel_l'],
        evidence_snapshot_id=snapshot_id,options_snapshot=options)
    if registration.status!='registered':return state,registration
    record=active_plan_view(candidate)
    if record is None or record.decision_id!=successor_id or record.target_lap!=intent.requested_target_lap:
        return state,LifecycleOutcome(status='rejected',reason='amend_successor_invariant')
    return candidate,LifecycleOutcome(status='applied',decision_id=intent.target_decision_id,
        reason='driver_plan_amended',detail={'successor_decision_id':successor_id,'constraint_id':constraint_id})
