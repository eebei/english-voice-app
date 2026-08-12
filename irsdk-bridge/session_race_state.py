"""Build 266 Phase E — Session Race State (bridge-authoritative).

One state object per race session.  The bridge is the sole owner; the
renderer only displays and executes radio policy.  Every mutator is a pure
function: `new_state = mutator(state, ...)`.  Nothing here reads iRacing
telemetry directly — the bridge poll loop supplies inputs.

Closed at session end.  The bridge must call `init_state()` fresh at every
SessionNum / sig transition — nothing here persists across sessions on its
own.
"""

import math
import time


def _finite(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


def init_state():
    """A brand-new, empty Session Race State."""
    return {
        'active_plan': None,               # 'A' | 'B' | 'C' | None
        'active_plan_snapshot': None,       # {available, selected_plan, plans:{...}}
        'plan_snapshot_id': None,
        'plan_revision': 0,
        'baseline_fuel_l_per_lap': None,
        'recent_fuel_l_per_lap': None,
        'baseline_pace_s': None,
        'recent_pace_s': None,
        'damage_state': {
            'damage_observation': None,     # first-detected snapshot, never cleared
            'driver_reported_damage': None, # list of reports this session
            'optional_repair_observed_but_not_taken': False,
        },
        'strategy_assumptions_invalidated': [],   # list of reason strings, deduped
        'last_recalculation': None,
        'recalculation_consumed_triggers': [],    # dedupe keys already fired this session
        'closed': False,
    }


# ── Plan registration ────────────────────────────────────────────────────

def register_active_plan(state, *, plan_id, plan_snapshot, snapshot_id, revision=None):
    """Register (or update) the active plan.  Called from the SAME frame that
    builds or revises a plan — briefing playbook, live strategy_options build,
    or a plan-A/B switch decision.  This is the fix for the Build 265 defect
    where `plan_fuel_authority` fell back to `no_active_plan` despite a
    briefing plan existing: as long as this has ever been called this
    session, `active_plan_snapshot` stays populated.
    """
    if not isinstance(state, dict):
        return state
    next_revision = (
        revision if isinstance(revision, int)
        else (state.get('plan_revision') or 0) + 1)
    return {
        **state,
        'active_plan': plan_id,
        'active_plan_snapshot': plan_snapshot,
        'plan_snapshot_id': snapshot_id,
        'plan_revision': next_revision,
    }


# ── Damage observation (SDK-confirmed) ───────────────────────────────────

def record_damage_observation(state, *, mandatory_repair_s, optional_repair_s,
                              damage_s, lap, session_time_s, incident_delta,
                              on_pit_road):
    """Snapshot the FIRST damage detection this session.  Subsequent calls
    with a larger damage_s update the running totals but never erase the
    first-seen snapshot's existence — `damage_observation` is a fact, once
    True it stays True for the session (Codex: 'never cleared').
    """
    if not isinstance(state, dict):
        return state
    existing = state['damage_state'].get('damage_observation')
    snapshot = {
        'first_detected_at_lap': (existing or {}).get('first_detected_at_lap', lap),
        'first_detected_at_session_time_s': (
            (existing or {}).get('first_detected_at_session_time_s', session_time_s)),
        'mandatory_repair_s': round(mandatory_repair_s or 0.0, 1),
        'optional_repair_s': round(optional_repair_s or 0.0, 1),
        'damage_s': round(damage_s or 0.0, 1),
        'last_updated_at_lap': lap,
        'last_updated_at_session_time_s': session_time_s,
        'incident_delta': incident_delta,
        'on_pit_road': bool(on_pit_road),
    }
    return {
        **state,
        'damage_state': {
            **state['damage_state'],
            'damage_observation': snapshot,
        },
    }


def record_optional_repair_observation(state, *, optional_repair_s, lap,
                                       session_time_s, on_pit_road=None):
    """Track optional-repair seconds as a running MAXIMUM, plus the moment it
    was first seen non-zero.

    Codex Build 266 rejection #1: snapshotting only at pit entry loses damage
    taken near or inside the box, where `PitOptRepairLeft` only becomes
    non-zero AFTER OnPitRoad already went True.  The maximum ever observed —
    on track or in the box — is the authority for "optional repair was
    available", and it is never lowered when the live value drops back (either
    because service was taken, or because pit-out reset it to 0.0).

    Idempotent: calling this every frame with the same or a smaller value
    returns the state unchanged, so the poll loop can call it unconditionally.
    """
    if not isinstance(state, dict):
        return state
    if not _finite(optional_repair_s) or optional_repair_s <= 0:
        return state
    damage = state['damage_state']
    previous_max = damage.get('optional_repair_observed_max_s')
    if _finite(previous_max) and optional_repair_s <= previous_max:
        return state
    first_seen_lap = damage.get('optional_repair_first_seen_at_lap', None)
    first_seen_time = damage.get('optional_repair_first_seen_at_session_time_s', None)
    first_seen_on_pit = damage.get('optional_repair_first_seen_on_pit_road', None)
    is_first = not _finite(previous_max)
    return {
        **state,
        'damage_state': {
            **damage,
            'optional_repair_observed_max_s': round(float(optional_repair_s), 1),
            'optional_repair_first_seen_at_lap': lap if is_first else first_seen_lap,
            'optional_repair_first_seen_at_session_time_s': (
                session_time_s if is_first else first_seen_time),
            'optional_repair_first_seen_on_pit_road': (
                bool(on_pit_road) if is_first else first_seen_on_pit),
        },
    }


# ── Pit service observation (cancelled vs actually performed) ────────────
#
# Codex Build 266 限定レビュー P1(#1)：`PitOptRepairLeft` はピットアウト時に 0 へ戻る。
# 「修理を実施して 0 になった」と「修理を取り消して 0 になった」は、退出時の残秒だけ
# では区別できない。最大観測値との差分を実施の証拠にすると、取消して燃料だけで出た
# ケースを「修理完了」と誤認する（Monza 20 の形）。
#
# 実施の唯一の証拠は「実時間に沿って減り続けたこと」である。サービス中の
# `PitOptRepairLeft` は経過秒とほぼ同じ速度で減る。取消・選択変更・ピットアウトの
# リセットは、経過時間に対して不釣り合いな瞬間的な落ち方をする。両者はこの差で分かれる。

# 1フレームの減少が「実時間の消化」と認められる許容誤差（poll間隔のばらつき分）。
REPAIR_COUNTDOWN_TOLERANCE_S = 0.5
# これ未満の累積消化は「サービスは走らなかった」とみなす。
REPAIR_SERVICE_MIN_S = 1.0


def init_pit_service_tracker():
    """Fresh tracker for one pit visit.  Reset at every pit entry."""
    return {
        'max_s': 0.0,
        'countdown_s': 0.0,      # 実時間に沿って消化された秒の累計
        'last_value': None,
        'last_time': None,
    }


def observe_pit_repair_frame(tracker, *, optional_repair_s, session_time_s):
    """One poll frame of optional-repair observation, during a pit visit.

    A decrease counts as real service only when it is consistent with wall
    clock: `drop <= elapsed + tolerance`.  An instant drop that no amount of
    elapsed time can explain (repair cancelled, selection changed, pit-out
    reset to 0.0) is not service and is not counted.
    """
    if not isinstance(tracker, dict):
        tracker = init_pit_service_tracker()
    if not _finite(optional_repair_s) or optional_repair_s < 0:
        return tracker
    previous_value = tracker.get('last_value')
    previous_time = tracker.get('last_time')
    countdown = tracker.get('countdown_s') or 0.0
    if (_finite(previous_value) and previous_value > optional_repair_s
            and _finite(previous_time) and _finite(session_time_s)):
        drop = previous_value - optional_repair_s
        elapsed = session_time_s - previous_time
        if elapsed >= 0 and drop <= elapsed + REPAIR_COUNTDOWN_TOLERANCE_S:
            countdown += drop
    return {
        'max_s': max(tracker.get('max_s') or 0.0, float(optional_repair_s)),
        'countdown_s': round(countdown, 2),
        'last_value': float(optional_repair_s),
        'last_time': session_time_s if _finite(session_time_s) else previous_time,
    }


def classify_optional_repair(tracker):
    """`none` / `not_taken` / `partial` / `taken` for one pit visit.

    `not_taken` is the fact the brief cares about: optional repair was visible
    and the driver left without it.  It is asserted only when the countdown
    never ran — never inferred from the live value being 0 at pit exit.
    """
    if not isinstance(tracker, dict):
        return 'none'
    max_s = tracker.get('max_s') or 0.0
    countdown = tracker.get('countdown_s') or 0.0
    if max_s <= 0.5:
        return 'none'
    if countdown < REPAIR_SERVICE_MIN_S:
        return 'not_taken'
    if countdown < max_s - REPAIR_SERVICE_MIN_S:
        return 'partial'
    return 'taken'


def optional_repair_observed_max(state):
    """The largest optional-repair seconds ever seen this session, or 0.0."""
    if not isinstance(state, dict):
        return 0.0
    value = (state.get('damage_state') or {}).get('optional_repair_observed_max_s')
    return float(value) if _finite(value) else 0.0


def mark_optional_repair_not_taken(state, *, lap, observed_optional_repair_s=None):
    """Called at pit exit when the observed optional-repair time was NOT
    actually spent in service (repair_done << the maximum optional-repair
    seconds observed across the whole pit visit).  This flag must survive the
    live PitOptRepairLeft value resetting to 0.0 after pit-out — that reset
    means "no longer pending", not "never happened".
    """
    if not isinstance(state, dict):
        return state
    observed = (observed_optional_repair_s if _finite(observed_optional_repair_s)
                else optional_repair_observed_max(state))
    return {
        **state,
        'damage_state': {
            **state['damage_state'],
            'optional_repair_observed_but_not_taken': True,
            'optional_repair_not_taken_at_lap': lap,
            'optional_repair_not_taken_s': round(float(observed), 1) if _finite(observed) else None,
        },
    }


def record_optional_repair_outcome(state, *, tracker, lap):
    """Close out one pit visit: store what the countdown evidence says, and set
    the sticky not-taken flag only when the service demonstrably never ran.

    The outcome is recorded for every visit — including `taken` — so a later
    reader can tell "we checked and the repair was performed" apart from "we
    never looked".
    """
    if not isinstance(state, dict):
        return state
    classification = classify_optional_repair(tracker)
    if classification == 'none':
        return state
    tracker = tracker if isinstance(tracker, dict) else {}
    next_state = {
        **state,
        'damage_state': {
            **state['damage_state'],
            'optional_repair_outcome': classification,
            'optional_repair_outcome_at_lap': lap,
            'optional_repair_countdown_s': tracker.get('countdown_s'),
            'optional_repair_visit_max_s': tracker.get('max_s'),
        },
    }
    if classification == 'not_taken':
        next_state = mark_optional_repair_not_taken(
            next_state, lap=lap, observed_optional_repair_s=tracker.get('max_s'))
    return next_state


# ── Driver-reported damage (never SDK-confirmed) ─────────────────────────

_DAMAGE_PHRASES = (
    (r'フロント\s*バンパー|front\s*bumper', 'front_aero_or_body'),
    (r'ステアリング\s*コラム|steering\s*column', 'steering_or_front_end'),
    (r'アライメント|alignment', 'steering_alignment'),
    (r'ハンドル.{0,6}(?:取られ|流れ|曲が)|steering.{0,10}(?:pull|off)', 'steering_alignment'),
    (r'フロント.{0,10}(?:壊れ|破損|傷ん)|front.{0,10}damag', 'front_aero_or_body'),
)

import re as _re
_DAMAGE_PATTERNS = [(_re.compile(p, _re.IGNORECASE), cat) for p, cat in _DAMAGE_PHRASES]


def parse_driver_reported_damage(text):
    """Classify a driver utterance into a structured damage category, or
    return None if it does not match a known damage phrase.  Pure function —
    no state, no SDK confirmation.  Category is NEVER treated as an SDK part
    confirmation (`source` stays 'driver_report' downstream).
    """
    t = str(text or '')
    if not t:
        return None
    for pattern, category in _DAMAGE_PATTERNS:
        if pattern.search(t):
            return category
    return None


def record_driver_reported_damage(state, *, category, raw_text, lap, session_time_s):
    if not isinstance(state, dict) or not category:
        return state
    report = {
        'category': category,
        'source': 'driver_report',
        'raw_text': str(raw_text or ''),
        'lap': lap,
        'session_time_s': session_time_s,
    }
    existing = list(state['damage_state'].get('driver_reported_damage') or [])
    existing.append(report)
    return {
        **state,
        'damage_state': {
            **state['damage_state'],
            'driver_reported_damage': existing,
        },
    }


# ── Assumption invalidation ──────────────────────────────────────────────

def invalidate_assumptions(state, reason):
    if not isinstance(state, dict) or not reason:
        return state
    existing = list(state.get('strategy_assumptions_invalidated') or [])
    if reason in existing:
        return state
    existing.append(reason)
    return {**state, 'strategy_assumptions_invalidated': existing}


# ── Recalculation triggers ────────────────────────────────────────────────

RECALC_REASONS = (
    'clean_3_laps_established',
    'driver_reported_damage',
    'repair_detected_or_opt_not_taken',
    'fuel_deviation',
    'pace_deviation',
    'rival_pit_or_rejoin_shift',
    'final_lap_or_checker',
)

# Deviation thresholds.  A "significant" deviation is a real signal, not
# rounding noise — mirrors the existing 0.3s pace-trend threshold used
# elsewhere in the bridge (checkPaceJudgment / lap_delta_hist logic).
FUEL_DEVIATION_L_PER_LAP = 0.25
PACE_DEVIATION_S = 0.5


def should_recalculate(state, reason, *, dedupe_key=None):
    """A trigger fires `recalculate_strategy()` at most once per
    (reason, dedupe_key) this session.  `dedupe_key` distinguishes repeat
    instances of the same reason class (e.g. a second, later damage report is
    still `driver_reported_damage` but a NEW instance and must fire again).
    """
    if not isinstance(state, dict) or reason not in RECALC_REASONS:
        return False
    key = reason if dedupe_key is None else '%s:%s' % (reason, dedupe_key)
    return key not in (state.get('recalculation_consumed_triggers') or [])


def consume_trigger(state, reason, *, dedupe_key=None):
    if not isinstance(state, dict):
        return state
    key = reason if dedupe_key is None else '%s:%s' % (reason, dedupe_key)
    existing = list(state.get('recalculation_consumed_triggers') or [])
    if key in existing:
        return state
    existing.append(key)
    return {**state, 'recalculation_consumed_triggers': existing}


def evaluate_fuel_deviation(baseline_l_per_lap, recent_l_per_lap):
    if not _finite(baseline_l_per_lap) or not _finite(recent_l_per_lap):
        return False
    return abs(recent_l_per_lap - baseline_l_per_lap) >= FUEL_DEVIATION_L_PER_LAP


def evaluate_pace_deviation(baseline_pace_s, recent_pace_s):
    if not _finite(baseline_pace_s) or not _finite(recent_pace_s):
        return False
    return abs(recent_pace_s - baseline_pace_s) >= PACE_DEVIATION_S


def recent_median(values, *, window=5, minimum=3):
    """Median of the last `window` valid laps, or None until `minimum` laps
    exist.  Median (not mean) so a single traffic lap or an off does not drag
    the running value — the brief asks for the median of the last 3–5 valid
    laps.
    """
    if not isinstance(values, (list, tuple)):
        return None
    usable = [v for v in values[-window:] if _finite(v)]
    if len(usable) < minimum:
        return None
    ordered = sorted(usable)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return round(float(ordered[mid]), 3)
    return round((float(ordered[mid - 1]) + float(ordered[mid])) / 2.0, 3)


def next_deviation_trigger(state, *, reason, baseline, recent, threshold, episode):
    """One lap's worth of deviation decision, as a pure function.

    Returns `(should_fire, dedupe_key, next_episode)`.

    The bridge calls this once per completed lap for fuel and for pace.  It
    lives here rather than inline in the poll loop so the firing rule can be
    tested on real sequences instead of only asserted as source text.

    Firing rule:
      * within tolerance  → never fires, and re-arms (episode + 1), so a
        deviation that comes back later is a NEW episode and speaks again.
      * beyond tolerance  → fires once per (episode, step).  A deviation that
        merely persists is silent; one that worsens by another whole
        threshold fires again.
      * baseline not established yet → nothing to deviate from, no fire, and
        no re-arm (the episode counter must not run while we have no basis).
    """
    if not isinstance(state, dict) or reason not in RECALC_REASONS:
        return (False, None, episode)
    if not _finite(baseline) or not _finite(recent):
        return (False, None, episode)
    step = deviation_step(baseline, recent, threshold)
    if step == 0:
        return (False, None, episode + 1)
    key = 'ep%d:step%d' % (episode, step)
    return (should_recalculate(state, reason, dedupe_key=key), key, episode)


def deviation_step(baseline, recent, threshold):
    """How many whole thresholds the recent value sits away from baseline.

    0 = within tolerance.  1 = first significant deviation, 2 = it has since
    doubled, and so on.  The bridge fires one recalculation per (episode,
    step) pair, so a persistent deviation does not re-fire every lap, but a
    materially worsening one does.
    """
    if not _finite(baseline) or not _finite(recent) or not _finite(threshold) or threshold <= 0:
        return 0
    return int(abs(recent - baseline) / threshold)


def recalculate_strategy(state, *, reason, baseline_fuel_l_per_lap, recent_fuel_l_per_lap,
                         baseline_pace_s, recent_pace_s, previous_plan, selected_plan,
                         driver_message, session_time_s, lap, dedupe_key=None):
    """Apply one recalculation, updating the trace-bearing fields.  Caller is
    responsible for actually recomputing selected_plan/fuel numbers (this
    module holds state, not the plan-selection arithmetic itself — that
    remains strategy_options.py / plan_fuel_authority.py's job).
    """
    if not isinstance(state, dict):
        return state
    damage = state.get('damage_state') or {}
    record = {
        'reason': reason,
        'lap': lap,
        'session_time_s': session_time_s,
        'baseline_fuel_l_per_lap': baseline_fuel_l_per_lap,
        'recent_fuel_l_per_lap': recent_fuel_l_per_lap,
        'baseline_pace_s': baseline_pace_s,
        'recent_pace_s': recent_pace_s,
        'damage_observed': bool(damage.get('damage_observation')),
        'driver_reported_damage': [
            r.get('category') for r in (damage.get('driver_reported_damage') or [])
        ],
        'previous_plan': previous_plan,
        'selected_plan': selected_plan,
        'driver_message': driver_message,
    }
    next_state = {
        **state,
        'baseline_fuel_l_per_lap': (
            baseline_fuel_l_per_lap if baseline_fuel_l_per_lap is not None
            else state.get('baseline_fuel_l_per_lap')),
        'recent_fuel_l_per_lap': recent_fuel_l_per_lap,
        'baseline_pace_s': (
            baseline_pace_s if baseline_pace_s is not None
            else state.get('baseline_pace_s')),
        'recent_pace_s': recent_pace_s,
        'last_recalculation': record,
    }
    return consume_trigger(next_state, reason, dedupe_key=dedupe_key)


def format_recalculation_trace(record):
    """Render the STRATEGY_RECALCULATION trace block exactly as specified."""
    if not isinstance(record, dict):
        return 'STRATEGY_RECALCULATION\nreason=unavailable'
    lines = ['STRATEGY_RECALCULATION']
    lines.append('reason=%s' % record.get('reason'))
    lines.append('baseline_fuel_l_per_lap=%s' % record.get('baseline_fuel_l_per_lap'))
    lines.append('recent_fuel_l_per_lap=%s' % record.get('recent_fuel_l_per_lap'))
    lines.append('baseline_pace_s=%s' % record.get('baseline_pace_s'))
    lines.append('recent_pace_s=%s' % record.get('recent_pace_s'))
    lines.append('damage_observed=%s' % record.get('damage_observed'))
    lines.append('driver_reported_damage=%s' % record.get('driver_reported_damage'))
    lines.append('previous_plan=%s' % record.get('previous_plan'))
    lines.append('selected_plan=%s' % record.get('selected_plan'))
    lines.append('driver_message=%s' % record.get('driver_message'))
    return '\n'.join(lines)


# ── Push/pace conservatism gate ──────────────────────────────────────────

def _earliest_damage_lap(damage_state):
    laps = []
    obs = damage_state.get('damage_observation')
    if isinstance(obs, dict) and isinstance(obs.get('first_detected_at_lap'), int):
        laps.append(obs['first_detected_at_lap'])
    for report in (damage_state.get('driver_reported_damage') or []):
        if isinstance(report.get('lap'), int):
            laps.append(report['lap'])
    not_taken_lap = damage_state.get('optional_repair_not_taken_at_lap')
    if isinstance(not_taken_lap, int):
        laps.append(not_taken_lap)
    return min(laps) if laps else None


def push_allowed(state):
    """Deterministic gate: once damage evidence exists (SDK or driver-report)
    but no recalculation has happened AT OR AFTER the lap that evidence first
    appeared, 'push' / 'pace increase' calls must be withheld.  This is the
    guard behind Codex's requirement #9: never say push-ok while a
    post-damage recalculation is outstanding.

    Any recalculation reason counts, as long as it happened at/after the
    damage lap — by the time a later recalculation runs (e.g. a routine
    fuel-deviation update), its fuel/pace inputs already reflect the
    post-damage reality.  A recalculation that predates the damage (e.g. the
    initial clean-3-laps latch) does NOT count, even if it is still the most
    recent record when damage was observed with no lap number available.
    """
    if not isinstance(state, dict):
        return True
    damage = state.get('damage_state') or {}
    has_damage_evidence = bool(
        damage.get('damage_observation')
        or damage.get('driver_reported_damage')
        or damage.get('optional_repair_observed_but_not_taken'))
    if not has_damage_evidence:
        return True
    last = state.get('last_recalculation')
    if not isinstance(last, dict):
        return False
    damage_lap = _earliest_damage_lap(damage)
    last_lap = last.get('lap')
    if isinstance(damage_lap, int) and isinstance(last_lap, int):
        return last_lap >= damage_lap
    # No lap numbers to compare — fall back to the conservative reason
    # allowlist so uncertainty never grants push.
    return last.get('reason') in ('driver_reported_damage',
                                  'repair_detected_or_opt_not_taken')


def strategy_speech_blocked(state):
    """True once the `final_lap_or_checker` trigger has fired this session.
    Callers must not speak a new pit-now call, fuel set-amount, or Plan
    switch after this — only save/report results.
    """
    if not isinstance(state, dict):
        return False
    consumed = state.get('recalculation_consumed_triggers') or []
    return any(key == 'final_lap_or_checker' or key.startswith('final_lap_or_checker:')
              for key in consumed)


# ── Lifecycle gates ────────────────────────────────────────────────────────

def close_session(state):
    if not isinstance(state, dict):
        return state
    return {**state, 'closed': True}
