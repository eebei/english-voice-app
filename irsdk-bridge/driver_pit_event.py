"""
OMORAY PITWALL - Immutable DriverPitEvent / Execution Classification（WO-003 / REVISE 1）

review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md WO-003。一つの実ピット訪問を
一度だけ確定される不変の`DriverPitEvent`へ変換し、凍結Planと権威penalty証拠
だけで`normal / early / penalty / unresolved`を分類する純粋関数群。

【責務】
  Bridgeのpoll loop（`bridge.poll_iracing()`）が、OnPitRoad False->True で
  `freeze_plan_reference()`によりPlan参照を凍結し、訪問中の各frameで
  `observe_black_flag_frame()`によりWO-002権威snapshotのblack_flagを畳み込み、
  OnPitRoad True->False の確定退出で`finalize_driver_pit_event()`を一度だけ
  呼んでこのモジュールが唯一の分類・identity生成の権威になる。

【penalty evidence契約】
  訪問中に一度でも権威`black_flag.state=='true'`を観測すればpenalty=true
  （最初のtrue観測のraw値/時刻/frameを保持し、以後のfalse観測で上書きしない）。
  true観測が無く、unknown観測が一つでもあればpenalty=unknown。
  true/unknownが無く、既知false観測だけならpenalty=false。
  fuel_added_l・stall秒・repair・caution・発話からは絶対に補完しない
  （`observe_black_flag_frame()`はraw black_flag状態しか受け取らない）。
  `state`が'true'/'false'いずれとも読めない場合（'unknown'、キー欠落、
  black_flagがdictでない、想定外のmalformed値）はすべてunknown観測として
  畳み込む——falseへ縮退しない。訪問中にsustained reconnect（通信断復帰）が
  起きたgap区間も、`reconnect_gap_black_flag_evidence()`を介して同じ
  unknown畳み込みへ一度だけ合流させる（bridge.py側の責務）。

【分類優先順位】classify_execution_relation()
  1. penalty（penalty_evidence.state=='true'）
  2. unresolved/penalty_evidence_unknown（state=='unknown'）
  3. unresolved/no_frozen_plan（plan_referenceが無い、またはtarget_lap/entry_lap
     が無い・型不正）
  4. unresolved/plan_identity_mismatch（plan_referenceのdecision_id/session_num
     がこのeventのrace/session identityと結合できない）
  5. early/before_target_lap（entry_lap < target_lap）
  6. normal/at_target_lap（entry_lap == target_lap）
  7. unresolved/after_target_lap（entry_lap > target_lap。現行enumに`late`が
     無いためnormalと偽らない）

【不変性】
  `DriverPitEvent`とその全ネスト値は`frozen=True`のdataclass。JSON/broadcast/
  legacy view向けの辞書は`serialize_driver_pit_event()`が呼ばれるたびに新しい
  dictを返すので、consumer側の変更が正本eventへ波及しない。

【identity】
  `pit_event_id`の一意性の正本は`race_instance_id + session_num +
  driver_pit_sequence`。retryごとのUUIDにしない。`store_put()`は同一IDかつ
  同一内容ならno-op、同一IDで内容が異なれば`DriverPitEventCollisionError`。

【スコープ外（WO-004以降）】
  Plan terminal化・旧BOX call抑止・Driver intent・LLM/speech/memory/debrief
  はこのモジュールの責務ではない。
"""

from dataclasses import dataclass
from typing import Optional


SCHEMA_VERSION = 1


# ══════════════════════════════════════════════════════════════════════
# Frozen value objects
# ══════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class PitBoundaryFact:
    """一つの境界（entry or exit）で凍結する実測事実。"""
    lap: Optional[int]
    session_time_s: Optional[float]
    source_frame_sequence: Optional[int]
    class_position: Optional[int]
    lap_dist_pct: Optional[float]
    fuel_l: Optional[float]


@dataclass(frozen=True)
class PitServiceFact:
    """訪問全体を通じたサービス実測（給油・滞在・修理・タイヤ）。"""
    fuel_added_l: Optional[float]
    lane_total_s: Optional[float]
    stall_s: Optional[float]
    repair_s: Optional[float]
    tire_service: str


@dataclass(frozen=True)
class PenaltyEvidence:
    """訪問全体（entry〜exit）を通じた権威black-flag証拠。三値。"""
    state: str  # 'true' | 'false' | 'unknown'
    authority: Optional[str]
    raw_value: Optional[int]
    observed_session_time: Optional[float]
    source_frame_sequence: Optional[int]


@dataclass(frozen=True)
class FrozenPlanReference:
    """pit entry時点でdeep copyしたPlanの一部。exit時のlatest Planで後付けしない。"""
    decision_id: str
    selected_plan: str
    target_lap: Optional[int]
    session_num: int
    evidence_snapshot_id: Optional[str]


@dataclass(frozen=True)
class DriverPitEvent:
    schema_version: int
    pit_event_id: str
    race_instance_id: str
    session_num: int
    driver_pit_sequence: int
    entry: PitBoundaryFact
    exit: PitBoundaryFact
    service: PitServiceFact
    penalty_evidence: PenaltyEvidence
    plan_reference: Optional[FrozenPlanReference]
    execution_relation: str
    classification_reason: str


# ══════════════════════════════════════════════════════════════════════
# Identity
# ══════════════════════════════════════════════════════════════════════

def build_pit_event_id(race_instance_id, session_num, driver_pit_sequence):
    """`race_instance_id + session_num + driver_pit_sequence`だけから決定的に
    生成する。retryやbroadcastのたびに変わるUUIDにしない。"""
    return '%s:session-%s:pit-%s' % (race_instance_id, session_num, driver_pit_sequence)


# ══════════════════════════════════════════════════════════════════════
# Entry-time plan freeze
# ══════════════════════════════════════════════════════════════════════

def freeze_plan_reference(active_decision_plan, *, race_instance_id, session_num):
    """pit entryの瞬間、現在の`active_decision_plan`から`FrozenPlanReference`を
    作る。以下のいずれかに該当すれば`None`（凍結Planなし、として扱う）。

      - active_decision_planがdictでない（Planが存在しない）
      - decision_id / selected_plan / session_num が欠落・型不正
      - decision_idがこのframeのrace_instance_idを名乗っていない
        （decision_idは常に'<race_instance_id>:...'で始まる契約——
        bridge.pyのbuild_strategy_decision()参照）
      - Planのsession_numが、このframeのsession_numと一致しない

    exit時のlatest Planで後付けしないこと（呼び出し側はentry検出の瞬間にだけ
    これを呼ぶ）。
    """
    if not isinstance(active_decision_plan, dict):
        return None
    if not isinstance(race_instance_id, str) or not race_instance_id:
        return None
    decision_id = active_decision_plan.get('decision_id')
    selected_plan = active_decision_plan.get('selected_plan')
    plan_session_num = active_decision_plan.get('session_num')
    if not isinstance(decision_id, str) or not decision_id:
        return None
    if not isinstance(selected_plan, str) or not selected_plan:
        return None
    if not isinstance(plan_session_num, int):
        return None
    if not decision_id.startswith(race_instance_id + ':'):
        return None
    if plan_session_num != session_num:
        return None
    target_lap = active_decision_plan.get('target_lap')
    evidence_snapshot_id = active_decision_plan.get('evidence_snapshot_id')
    return FrozenPlanReference(
        decision_id=decision_id,
        selected_plan=selected_plan,
        target_lap=target_lap if isinstance(target_lap, int) else None,
        session_num=plan_session_num,
        evidence_snapshot_id=(
            evidence_snapshot_id if isinstance(evidence_snapshot_id, str) else None),
    )


# ══════════════════════════════════════════════════════════════════════
# Visit-wide penalty evidence accumulation
# ══════════════════════════════════════════════════════════════════════

def initial_visit_penalty_state():
    """訪問開始（pit entry検出）ごとに新しく作る、畳み込み用の作業状態。この
    dictそのものはDriverPitEventの一部にならない——`resolve_visit_penalty_
    evidence()`の戻り値だけがPenaltyEvidenceになる。"""
    return {
        'saw_true': False, 'saw_unknown': False, 'saw_false': False,
        'true_evidence': None, 'false_evidence': None, 'unknown_evidence': None,
    }


def observe_black_flag_frame(state, black_flag):
    """1frame分の権威`black_flag`（authoritative_race_facts.build_snapshot()の
    `black_flag`辞書そのもの、または`reconnect_gap_black_flag_evidence()`）を
    訪問中の畳み込み状態へ反映する。新しいstateを返す（入力を変更しない）。
    trueを一度観測したら、以後のfalse観測で上書きしない（最初のtrue観測を保持）。

    fail-closed契約：`state`が明示的に'true'または'false'と読めた場合だけその
    値を採用する。'unknown'はもちろん、`black_flag`がdictでない、'state'キーが
    無い、または'true'/'false'以外の想定外（malformed）値であっても、すべて
    unknownへ畳み込む——falseへ絶対に縮退しない。"""
    if state.get('saw_true'):
        return state
    new_state = dict(state)
    if not isinstance(black_flag, dict):
        black_flag = {
            'state': 'unknown', 'authority': None, 'raw_value': None,
            'observed_session_time': None, 'source_frame_sequence': None,
        }
    bf_state = black_flag.get('state')
    if bf_state == 'true':
        new_state['saw_true'] = True
        new_state['true_evidence'] = black_flag
    elif bf_state == 'false':
        new_state['saw_false'] = True
        new_state['false_evidence'] = black_flag
    else:
        new_state['saw_unknown'] = True
        new_state['unknown_evidence'] = black_flag
    return new_state


def reconnect_gap_black_flag_evidence():
    """visit tracker生存中にsustained reconnect（通信断復帰）が起きた時、その
    gap区間を「権威証拠が観測不能だった」こととして一度だけ畳み込むための
    合成black_flag値。gap中に実際はblack flagが出ていた可能性を否定できない
    ため、常にunknownとして`observe_black_flag_frame()`へ渡す（false扱いにしない）。
    """
    return {
        'state': 'unknown', 'authority': 'reconnect_gap', 'raw_value': None,
        'observed_session_time': None, 'source_frame_sequence': None,
    }


def resolve_lane_entry_time_s(*, legacy_pit_enter_time_s, entry_fact,
                               entry_race_instance_id, entry_session_num,
                               exit_race_instance_id, exit_session_num):
    """pitレーン所要時間（lane duration）計算に使う進入SessionTimeを解決する。

    通常はbridge側のlegacy `pit_enter_time`（`legacy_pit_enter_time_s`）を
    そのまま使う。pit滞在中のsustained reconnectで汎用`_sig_reset`経路が
    legacy値をNone化した場合だけ、凍結済み訪問entry fact（`entry_fact`、
    `_pit_visit_entry_fact`）の`session_time_s`をfallbackとして使う——
    ただしtrackerが生存しており（`entry_fact is not None`）、かつentry時に
    凍結したrace/session identityが今回のexit frameのidentityと一致する
    時だけ。tracker無し・identity不明・identity不一致では別訪問の時刻を
    誤って使わないよう、fail-closedで`None`を返す（呼び出し側はlane
    durationを計算できないものとして扱う）。"""
    if legacy_pit_enter_time_s is not None:
        return legacy_pit_enter_time_s
    if entry_fact is None:
        return None
    if entry_race_instance_id is None or entry_session_num is None:
        return None
    if (entry_race_instance_id != exit_race_instance_id
            or entry_session_num != exit_session_num):
        return None
    return entry_fact.session_time_s


def resolve_visit_penalty_evidence(state):
    """畳み込み済みの作業状態から、訪問全体の不変`PenaltyEvidence`を導く。

      - true観測が一度でもあれば'true'（最初のtrue観測のraw値/時刻/frameを保持）
      - true観測が無く、unknown観測が一つでもあれば'unknown'
      - true/unknown観測が無く、false観測だけがあれば'false'
      - 何も観測していない（訪問中一度もonPitフレームを畳み込んでいない）場合も
        安全側の'unknown'
    """
    if state.get('saw_true'):
        bf = state['true_evidence']
        return PenaltyEvidence(
            state='true', authority=bf.get('authority'), raw_value=bf.get('raw_value'),
            observed_session_time=bf.get('observed_session_time'),
            source_frame_sequence=bf.get('source_frame_sequence'))
    if state.get('saw_unknown') or not state.get('saw_false'):
        bf = state.get('unknown_evidence') or state.get('false_evidence')
        return PenaltyEvidence(
            state='unknown', authority=(bf or {}).get('authority'), raw_value=None,
            observed_session_time=(bf or {}).get('observed_session_time'),
            source_frame_sequence=(bf or {}).get('source_frame_sequence'))
    bf = state['false_evidence']
    return PenaltyEvidence(
        state='false', authority=bf.get('authority'), raw_value=bf.get('raw_value'),
        observed_session_time=bf.get('observed_session_time'),
        source_frame_sequence=bf.get('source_frame_sequence'))


# ══════════════════════════════════════════════════════════════════════
# Classification
# ══════════════════════════════════════════════════════════════════════

def classify_execution_relation(*, race_instance_id, session_num, entry_lap,
                                  plan_reference, penalty_evidence):
    """`(execution_relation, classification_reason)`を返す。fuel/stall/repair/
    cautionは一切参照しない——`penalty_evidence`（visit-wide black flag証拠）
    と`plan_reference`（entry凍結）だけで決める。"""
    if penalty_evidence.state == 'true':
        return 'penalty', 'authoritative_black_flag'
    if penalty_evidence.state == 'unknown':
        return 'unresolved', 'penalty_evidence_unknown'
    # ここから penalty_evidence.state == 'false'
    if plan_reference is None:
        return 'unresolved', 'no_frozen_plan'
    target_lap = plan_reference.target_lap
    if not isinstance(entry_lap, int) or not isinstance(target_lap, int):
        return 'unresolved', 'no_frozen_plan'
    if not (isinstance(plan_reference.decision_id, str)
            and plan_reference.decision_id.startswith(race_instance_id + ':')
            and plan_reference.session_num == session_num):
        return 'unresolved', 'plan_identity_mismatch'
    if entry_lap < target_lap:
        return 'early', 'before_target_lap'
    if entry_lap == target_lap:
        return 'normal', 'at_target_lap'
    return 'unresolved', 'after_target_lap'


# ══════════════════════════════════════════════════════════════════════
# Finalize
# ══════════════════════════════════════════════════════════════════════

def finalize_driver_pit_event(*, race_instance_id, session_num, driver_pit_sequence,
                               entry_fact, exit_fact, service_fact,
                               visit_penalty_state, plan_reference,
                               entry_race_instance_id=None, entry_session_num=None):
    """退出確定（OnPitRoad true->false）で一度だけ呼ぶ。entryとexitのrace/
    session identityが異なる場合は、別訪問を合成せず`unresolved/
    entry_exit_identity_mismatch`として実測factだけをfinalizeする。"""
    penalty_evidence = resolve_visit_penalty_evidence(visit_penalty_state)
    entry_exit_mismatch = (
        entry_race_instance_id is not None and entry_race_instance_id != race_instance_id
        or entry_session_num is not None and entry_session_num != session_num)
    if entry_exit_mismatch:
        relation, reason = 'unresolved', 'entry_exit_identity_mismatch'
    else:
        relation, reason = classify_execution_relation(
            race_instance_id=race_instance_id, session_num=session_num,
            entry_lap=entry_fact.lap, plan_reference=plan_reference,
            penalty_evidence=penalty_evidence)
    pit_event_id = build_pit_event_id(race_instance_id, session_num, driver_pit_sequence)
    return DriverPitEvent(
        schema_version=SCHEMA_VERSION,
        pit_event_id=pit_event_id,
        race_instance_id=race_instance_id,
        session_num=session_num,
        driver_pit_sequence=driver_pit_sequence,
        entry=entry_fact,
        exit=exit_fact,
        service=service_fact,
        penalty_evidence=penalty_evidence,
        plan_reference=plan_reference,
        execution_relation=relation,
        classification_reason=reason,
    )


# ══════════════════════════════════════════════════════════════════════
# Idempotent, collision-detecting canonical store
# ══════════════════════════════════════════════════════════════════════

class DriverPitEventCollisionError(Exception):
    """同一`pit_event_id`に異なる内容を二重に書き込もうとした。"""


def store_put(store, event):
    """`store`（`pit_event_id -> DriverPitEvent`のdict）へ1件挿入する。入力
    dictは変更せず、新しいdictを返す（他のconsumerの読み取り中viewを壊さない）。

    Returns:
      (new_store, inserted) — `inserted`は新規挿入ならTrue、同一ID・同一内容の
      no-opならFalse。同一IDで内容が異なれば`DriverPitEventCollisionError`。
    """
    existing = store.get(event.pit_event_id)
    if existing is None:
        new_store = dict(store)
        new_store[event.pit_event_id] = event
        return new_store, True
    if existing == event:
        return store, False
    raise DriverPitEventCollisionError(
        'pit_event_id %r already stored with different content' % event.pit_event_id)


# ══════════════════════════════════════════════════════════════════════
# Serialization (fresh dict every call — consumers cannot mutate the store)
# ══════════════════════════════════════════════════════════════════════

def serialize_pit_boundary_fact(fact):
    return {
        'lap': fact.lap, 'session_time_s': fact.session_time_s,
        'source_frame_sequence': fact.source_frame_sequence,
        'class_position': fact.class_position, 'lap_dist_pct': fact.lap_dist_pct,
        'fuel_l': fact.fuel_l,
    }


def serialize_service_fact(fact):
    return {
        'fuel_added_l': fact.fuel_added_l, 'lane_total_s': fact.lane_total_s,
        'stall_s': fact.stall_s, 'repair_s': fact.repair_s,
        'tire_service': fact.tire_service,
    }


def serialize_penalty_evidence(evidence):
    return {
        'state': evidence.state, 'authority': evidence.authority,
        'raw_value': evidence.raw_value,
        'observed_session_time': evidence.observed_session_time,
        'source_frame_sequence': evidence.source_frame_sequence,
    }


def serialize_plan_reference(plan_reference):
    if plan_reference is None:
        return None
    return {
        'decision_id': plan_reference.decision_id,
        'selected_plan': plan_reference.selected_plan,
        'target_lap': plan_reference.target_lap,
        'session_num': plan_reference.session_num,
        'evidence_snapshot_id': plan_reference.evidence_snapshot_id,
    }


def serialize_driver_pit_event(event):
    """唯一のserializer。呼ぶたびに新しいdictを返すので、consumerが返値を
    変更しても正本`DriverPitEvent`（frozen dataclass）には波及しない。"""
    return {
        'schema_version': event.schema_version,
        'pit_event_id': event.pit_event_id,
        'race_instance_id': event.race_instance_id,
        'session_num': event.session_num,
        'driver_pit_sequence': event.driver_pit_sequence,
        'entry': serialize_pit_boundary_fact(event.entry),
        'exit': serialize_pit_boundary_fact(event.exit),
        'service': serialize_service_fact(event.service),
        'penalty_evidence': serialize_penalty_evidence(event.penalty_evidence),
        'plan_reference': serialize_plan_reference(event.plan_reference),
        'execution_relation': event.execution_relation,
        'classification_reason': event.classification_reason,
    }


def legacy_pit_events_view(store):
    """canonical storeから、既存`pit_events`互換consumer向けのserialized
    view一覧を`driver_pit_sequence`昇順で再構成する。既存field（entry_lap /
    exit_lap / entry_class_position / exit_class_position / fuel_added_l /
    lane_total_s / stall_s）は、canonical eventのentry/exit/service facts
    から決定的に導けるためここでmergeする——storeにあるeventだけがsource。
    reconnectでcanonical storeが保持されていれば、このviewもreconnect前の
    訪問を含めて再構成される。identity変更でstoreがresetされればこのview
    もresetされる（呼び出し側が空のstoreを渡せば空listを返す）。"""
    events = sorted(store.values(), key=lambda e: e.driver_pit_sequence)
    views = []
    for event in events:
        serialized = serialize_driver_pit_event(event)
        views.append(dict(serialized, **{
            'entry_lap': event.entry.lap,
            'exit_lap': event.exit.lap,
            'entry_class_position': event.entry.class_position,
            'exit_class_position': event.exit.class_position,
            'fuel_added_l': event.service.fuel_added_l,
            'lane_total_s': event.service.lane_total_s,
            'stall_s': event.service.stall_s,
        }))
    return views
