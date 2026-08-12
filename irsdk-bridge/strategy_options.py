"""Deterministic Plan A / B / C fuel strategy.

A = baseline, the last fuel-safe stop at normal pace.
B = conditional undercut, from the first lap the fuel window allows.
C = conditional overcut / fuel-save, extending beyond A.

This module creates an early race contract once fuel consumption and finish
distance are authoritative.  It does not predict future traffic or tyre gain;
those remain unavailable until the Phase D comparator has measured evidence.
B and C are never available on fuel arithmetic alone — each carries live
conditions that must be proven by measurement before it can be offered.
"""

import math


MIN_CLEAN_LAPS = 3
DEFAULT_RESERVE_L = 0.5

# ── Plan B: 条件付きアンダーカット（Codex Plan B定義の判断・2026-08-12）────
#
# 「単なる -1 lap」ではない。候補となるピット周は **Fuel Window が開いた周** から作る。
#
# Fuel Window の最低条件（Yuji補足）：
#   その周でピットして、満タン容量を超えずにチェッカーまで必要な燃料を積めること。
#   早すぎて必要給油が容量に収まらない周は、そもそもアンダーカット候補ではない。
#
# ウインドウが開いた最初の周を起点に、前走車への相対ペース優位と、遅い後方集団を
# 避ける physical rejoin が揃った時だけ Plan B を available にする。
PLAN_B_CONDITIONS = (
    'fuel_window_open',          # 容量内で完走分を積める最初の周が Plan A より前にある
    'relative_pace_advantage',   # 前走車より実測で速い
    'rejoin_clear',              # 早入れ後の復帰が遅い集団に沈まない
)

# アンダーカットが機能するために必要な、前走車に対する最低の1周あたり優位。
# これ未満は「速い」と言わない（誤差でアンダーカットを勧めない）。
PLAN_B_MIN_PACE_ADVANTAGE_S = 0.3


# ── Plan C: overcut / fuel-save alternative（Codex差戻し#4）────────────────
#
# brief 3-1：「単なる +1 lap ではない。前が先にピット、こちらにクリーンエア、
# 燃費目標達成、次周リジョインが悪化しない等の条件がそろう時だけ成立させる。
# オフィシャルレースでは、オーバーカットを常設の同格案として扱わない。
# 根拠がないなら unavailable とする。」
#
# したがって Plan C は二段構えにする。
#   1. ブリーフィング時：燃料計算だけで「そもそも届くのか」を出す（fuel_feasible）。
#      届いてもこの時点では available=False。根拠が無いからである。
#   2. ライブ：下の条件が全て実測で揃った時にだけ available=True になる。
PLAN_C_CONDITIONS = (
    'rival_pitted_first',       # 前走車が先にピットした
    'clean_air',                # 自車の前がクリア（前走車に詰まっていない）
    'fuel_save_on_target',      # 直近有効周の燃費が目標を満たしている
    'rejoin_not_worse',         # 延長後のリジョインが悪化しない
)

# 現実的に維持できるリフト＆コーストの上限。これを超える節約が必要なら、
# 「やれば届く」ではなく「届かない」として扱う（捏造した希望を出さない）。
PLAN_C_MAX_SAVE_FRACTION = 0.08


def _finite(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


def unavailable(reason):
    return {
        'available': False,
        'reason': reason,
        'selected_plan': None,
        'plan_a': None,
        'plan_b': None,
    }


def build_initial_plans(*, snapshot_id, current_lap, fuel_level_l,
                        avg_fuel_per_lap_l, clean_laps_sampled,
                        crossings_to_finish, reserve_l=DEFAULT_RESERVE_L,
                        effective_capacity_l=None):
    """Return the baseline plus its conditional alternatives.

    Plan A stops at the latest fuel-safe lap.  Plan B is the undercut from the
    first lap the fuel window opens, and Plan C the fuel-save extension past
    A.  All three share one finish-distance and fuel snapshot, so the
    comparison is auditable.  When no stop is required, Plan A is a no-stop
    finish and both alternatives are explicitly unavailable.
    """
    if not isinstance(snapshot_id, str) or not snapshot_id:
        return unavailable('invalid_snapshot')
    if not isinstance(current_lap, int) or isinstance(current_lap, bool) or current_lap < 0:
        return unavailable('invalid_current_lap')
    if not _finite(fuel_level_l) or fuel_level_l < 0:
        return unavailable('invalid_fuel')
    if not _finite(avg_fuel_per_lap_l) or avg_fuel_per_lap_l <= 0:
        return unavailable('invalid_average')
    if (not isinstance(clean_laps_sampled, int)
            or isinstance(clean_laps_sampled, bool)
            or clean_laps_sampled < MIN_CLEAN_LAPS):
        return unavailable('insufficient_clean_laps')
    if (not isinstance(crossings_to_finish, int)
            or isinstance(crossings_to_finish, bool)
            or crossings_to_finish < 1):
        return unavailable('invalid_finish_distance')
    if not _finite(reserve_l) or reserve_l < 0:
        return unavailable('invalid_reserve')

    average = float(avg_fuel_per_lap_l)
    fuel = float(fuel_level_l)
    reserve = float(reserve_l)
    total_required = average * crossings_to_finish + reserve
    shortage = max(0.0, total_required - fuel)
    base = {
        'snapshot_id': snapshot_id,
        'current_lap': current_lap,
        'fuel_level_l': round(fuel, 3),
        'avg_fuel_per_lap_l': round(average, 3),
        'clean_laps_sampled': clean_laps_sampled,
        'crossings_to_finish': crossings_to_finish,
        'reserve_l': round(reserve, 3),
        'total_required_l': round(total_required, 3),
    }

    if shortage <= 0.001:
        margin = fuel - average * crossings_to_finish
        return {
            **base,
            'available': True,
            'reason': 'no_stop_required',
            'selected_plan': 'A',
            'plan_a': {
                'available': True, 'action': 'stay_out',
                'target_lap': None, 'target_in_laps': None,
                'add_fuel_l': 0.0, 'projected_finish_margin_l': round(margin, 3),
            },
            'plan_b': {
                'available': False, 'reason': 'no_viable_alternative_needed',
                'fuel_window_open': False,
            },
            'plan_c': {
                'available': False, 'reason': 'no_viable_alternative_needed',
                'fuel_feasible': False,
            },
            'switch_conditions': [],
        }

    latest_safe_in = int(math.floor(max(0.0, fuel - reserve) / average))
    latest_safe_in = min(latest_safe_in, max(0, crossings_to_finish - 1))
    # ★Plan B定義の判断（2026-08-12）：
    #   Plan A は基準＝通常ペースで成立する最後の燃料安全周。
    #   Plan B はそれより「前」の条件付きアンダーカット。
    #   Plan C は Plan A を基準にした fuel-save 延長。
    #   旧実装は A=latest_safe-1 / B=latest_safe（＝Bが延長）で、意味が逆だった。
    plan_a_in = latest_safe_in
    plan_b_in = _fuel_window_open_in(
        average=average, reserve=reserve, crossings_to_finish=crossings_to_finish,
        fuel=fuel, effective_capacity_l=effective_capacity_l,
        latest_safe_in=latest_safe_in)

    def stop_plan(action, delay):
        fuel_at_stop = max(0.0, fuel - average * delay)
        remaining = max(1, crossings_to_finish - delay)
        needed_after = average * remaining + reserve
        add = max(0.0, needed_after - fuel_at_stop)
        capacity_ok = (not _finite(effective_capacity_l)
                       or needed_after <= float(effective_capacity_l) + 0.001)
        if not capacity_ok:
            return {
                'available': False,
                'reason': 'effective_capacity_insufficient',
                'target_lap': current_lap + delay,
                'target_in_laps': delay,
            }
        return {
            'available': True,
            'action': action,
            'target_lap': current_lap + delay,
            'target_in_laps': delay,
            'fuel_at_stop_l': round(fuel_at_stop, 3),
            'add_fuel_l': round(add, 3),
            'set_fuel_l': int(math.ceil(add)),
            'remaining_crossings_after_stop': remaining,
            'projected_finish_margin_l': round(reserve, 3),
        }

    plan_a = stop_plan('baseline_stop', plan_a_in)
    plan_b = _build_plan_b(
        current_lap=current_lap, plan_a_in=plan_a_in, window_open_in=plan_b_in,
        stop_plan=stop_plan)
    plan_c = _build_plan_c(
        current_lap=current_lap, fuel=fuel, average=average, reserve=reserve,
        crossings_to_finish=crossings_to_finish, plan_a_in=plan_a_in,
        effective_capacity_l=effective_capacity_l, stop_plan=stop_plan)
    return {
        **base,
        'available': bool(plan_a.get('available')),
        'reason': 'initial_fuel_strategy' if plan_a.get('available') else plan_a.get('reason'),
        'selected_plan': 'A' if plan_a.get('available') else None,
        'fuel_window_open_in_laps': plan_b_in,
        'plan_a': plan_a,
        'plan_b': plan_b,
        'plan_c': plan_c,
        'switch_conditions': (list(PLAN_B_CONDITIONS)
                              if plan_b.get('fuel_window_open') else []),
    }


def _fuel_window_open_in(*, average, reserve, crossings_to_finish, fuel,
                         effective_capacity_l, latest_safe_in):
    """The earliest lap-delay at which stopping still works.

    Stopping too early means the tank cannot hold what is needed to reach the
    flag; such a lap is not an undercut candidate at all (Yuji, 2026-08-12).
    With no known capacity there is nothing to violate, so the window is open
    immediately.
    """
    if not _finite(effective_capacity_l) or effective_capacity_l <= 0:
        return 0
    for delay in range(0, latest_safe_in + 1):
        remaining = max(1, crossings_to_finish - delay)
        needed_after = average * remaining + reserve
        reachable = (fuel - average * delay) >= 0.0
        if reachable and needed_after <= float(effective_capacity_l) + 0.001:
            return delay
    return latest_safe_in


def _build_plan_b(*, current_lap, plan_a_in, window_open_in, stop_plan):
    """Conditional undercut: the first lap the fuel window allows, provided it
    is genuinely earlier than the baseline.

    Fuel evidence alone never makes B available — relative pace and a clear
    rejoin are live conditions checked by `decide_plan_b()`.  An undercut with
    no pace advantage is just a shorter stint.
    """
    if window_open_in >= plan_a_in:
        return {
            'available': False, 'reason': 'no_undercut_room',
            'fuel_window_open': False,
            'action': 'undercut',
            'target_lap': current_lap + window_open_in,
            'target_in_laps': window_open_in,
            'conditions_required': list(PLAN_B_CONDITIONS),
        }
    service = stop_plan('undercut', window_open_in)
    if not service.get('available'):
        return {
            'available': False,
            'reason': service.get('reason') or 'effective_capacity_insufficient',
            'fuel_window_open': False,
            'action': 'undercut',
            'target_lap': current_lap + window_open_in,
            'target_in_laps': window_open_in,
            'conditions_required': list(PLAN_B_CONDITIONS),
        }
    return {
        **service,
        'action': 'undercut',
        'laps_earlier_than_plan_a': plan_a_in - window_open_in,
        'conditions_required': list(PLAN_B_CONDITIONS),
        # 燃料はウインドウ内。ただし相対ペースと復帰が実測で揃うまで提案しない。
        'available': False,
        'fuel_window_open': True,
        'reason': 'conditions_unproven',
    }


def decide_plan_b(options, *, relative_pace_advantage_s=None, rejoin_clear=None):
    """Promote Plan B only when the undercut has a reason to work.

    `relative_pace_advantage_s` is positive when our measured clean pace is
    faster than the car ahead.  Unknown (`None`) is never satisfied.
    """
    if not isinstance(options, dict):
        return {'available': False, 'reason': 'options_unavailable',
                'conditions_met': {}, 'conditions_failed': list(PLAN_B_CONDITIONS)}
    plan_b = options.get('plan_b') or {}
    if not plan_b.get('fuel_window_open'):
        return {'available': False,
                'reason': plan_b.get('reason') or 'fuel_window_not_open',
                'conditions_met': {}, 'conditions_failed': list(PLAN_B_CONDITIONS)}
    met = {
        'fuel_window_open': True,
        'relative_pace_advantage': bool(
            _finite(relative_pace_advantage_s)
            and relative_pace_advantage_s >= PLAN_B_MIN_PACE_ADVANTAGE_S),
        'rejoin_clear': rejoin_clear is True,
    }
    failed = [name for name in PLAN_B_CONDITIONS if not met[name]]
    evidence = {
        'conditions_met': met,
        'conditions_failed': failed,
        'relative_pace_advantage_s': (round(float(relative_pace_advantage_s), 3)
                                      if _finite(relative_pace_advantage_s) else None),
        'required_pace_advantage_s': PLAN_B_MIN_PACE_ADVANTAGE_S,
        'target_in_laps': plan_b.get('target_in_laps'),
    }
    if failed:
        return {**evidence, 'available': False, 'reason': 'conditions_unproven'}
    return {**evidence, 'available': True, 'reason': 'plan_b_conditions_proven'}


def _build_plan_c(*, current_lap, fuel, average, reserve, crossings_to_finish,
                  plan_a_in, effective_capacity_l, stop_plan):
    """Fuel-save extension measured from Plan A, the baseline.

    ★Plan B定義の判断（2026-08-12）：Plan C を「Plan B のさらに1周先」として
    計算しない。Plan B はアンダーカット（Aより前）なので、その先を足しても
    延長にならない。基準は常に Plan A である。

    At briefing time this only answers "could the fuel ever reach there".
    `available` stays False until the live conditions in `PLAN_C_CONDITIONS`
    are proven — an overcut with no evidence behind it is `unavailable`, not a
    co-equal option.
    """
    target_in = plan_a_in + 1
    if target_in > max(0, crossings_to_finish - 1):
        return {
            'available': False, 'reason': 'no_room_to_extend',
            'fuel_feasible': False,
            'target_lap': current_lap + target_in, 'target_in_laps': target_in,
            'conditions_required': list(PLAN_C_CONDITIONS),
        }
    # 目標ラップまで持たせるために必要な1周あたり燃費。
    required_per_lap = (fuel - reserve) / target_in if target_in > 0 else None
    if not _finite(required_per_lap) or required_per_lap <= 0:
        return {
            'available': False, 'reason': 'fuel_save_target_unreachable',
            'fuel_feasible': False,
            'target_lap': current_lap + target_in, 'target_in_laps': target_in,
            'conditions_required': list(PLAN_C_CONDITIONS),
        }
    save_per_lap = average - required_per_lap
    save_fraction = save_per_lap / average if average > 0 else None
    detail = {
        'action': 'fuel_save_extend',
        'target_lap': current_lap + target_in,
        'target_in_laps': target_in,
        'required_fuel_per_lap_l': round(required_per_lap, 3),
        'fuel_save_per_lap_l': round(max(0.0, save_per_lap), 3),
        'fuel_save_fraction': round(max(0.0, save_fraction), 4) if _finite(save_fraction) else None,
        'conditions_required': list(PLAN_C_CONDITIONS),
    }
    if save_per_lap > average * PLAN_C_MAX_SAVE_FRACTION:
        # これだけ削らないと届かない＝リフト＆コーストの現実的範囲を超えている。
        return {**detail, 'available': False, 'fuel_feasible': False,
                'reason': 'fuel_save_target_unrealistic'}
    service = stop_plan('fuel_save_extend', target_in)
    if not service.get('available'):
        return {**detail, 'available': False, 'fuel_feasible': False,
                'reason': service.get('reason') or 'effective_capacity_insufficient'}
    return {
        **detail,
        'add_fuel_l': service.get('add_fuel_l'),
        'set_fuel_l': service.get('set_fuel_l'),
        'fuel_at_stop_l': service.get('fuel_at_stop_l'),
        'remaining_crossings_after_stop': service.get('remaining_crossings_after_stop'),
        'projected_finish_margin_l': service.get('projected_finish_margin_l'),
        # 燃料は届く。しかし根拠（相手の先ピット・クリーンエア・燃費目標・リジョイン）
        # が実測で揃うまでは提案しない。
        'available': False,
        'fuel_feasible': True,
        'reason': 'conditions_unproven',
    }


def decide_plan_c(options, *, fuel_save_recent_l_per_lap=None,
                  rival_pitted_first=None, clean_air=None, rejoin_not_worse=None):
    """Promote Plan C to available only when every condition is proven.

    Unknown (`None`) is never treated as satisfied.  A missing condition is a
    missing reason, and a missing reason means the overcut stays unavailable.

    `fuel_save_recent_l_per_lap` must be a measurement taken while the driver
    is actually saving — it is NOT the same median that built the plan.  The
    target is derived from the planning consumption, so feeding the planning
    number back in would compare a value against itself and could never be a
    real test of "the saving is happening".  Until saving has been measured,
    this stays None and the overcut stays unavailable.
    """
    if not isinstance(options, dict):
        return {'available': False, 'reason': 'options_unavailable',
                'conditions_met': {}, 'conditions_failed': list(PLAN_C_CONDITIONS)}
    plan_c = options.get('plan_c') or {}
    if not plan_c.get('fuel_feasible'):
        return {'available': False,
                'reason': plan_c.get('reason') or 'plan_c_not_fuel_feasible',
                'conditions_met': {}, 'conditions_failed': list(PLAN_C_CONDITIONS)}
    target = plan_c.get('required_fuel_per_lap_l')
    fuel_save_on_target = (
        bool(_finite(fuel_save_recent_l_per_lap) and _finite(target)
             and fuel_save_recent_l_per_lap <= target))
    met = {
        'rival_pitted_first': rival_pitted_first is True,
        'clean_air': clean_air is True,
        'fuel_save_on_target': fuel_save_on_target,
        'rejoin_not_worse': rejoin_not_worse is True,
    }
    failed = [name for name in PLAN_C_CONDITIONS if not met[name]]
    if failed:
        return {'available': False, 'reason': 'conditions_unproven',
                'conditions_met': met, 'conditions_failed': failed,
                'fuel_save_recent_l_per_lap': (
                    round(float(fuel_save_recent_l_per_lap), 3)
                    if _finite(fuel_save_recent_l_per_lap) else None),
                'required_fuel_per_lap_l': target}
    return {'available': True, 'reason': 'plan_c_conditions_proven',
            'conditions_met': met, 'conditions_failed': [],
            'fuel_save_recent_l_per_lap': round(float(fuel_save_recent_l_per_lap), 3),
            'required_fuel_per_lap_l': target}


def reevaluate_plans(*, previous, snapshot_id, trigger_reason, current_lap,
                     fuel_level_l, recent_fuel_per_lap_l, clean_laps_sampled,
                     crossings_to_finish, reserve_l=DEFAULT_RESERVE_L,
                     effective_capacity_l=None, recent_pace_s=None,
                     baseline_pace_s=None, pit_now_forecast=None,
                     pit_next_lap_forecast=None, rival_pitted_first=None,
                     clean_air=None, rejoin_not_worse=None,
                     fuel_save_recent_l_per_lap=None,
                     relative_pace_advantage_s=None):
    """Rebuild Plan A / B / C from the CURRENT measured numbers and choose one.

    Codex Build 266 差戻し#2：`recalculate_strategy()` に既存Planを渡して trace
    するだけでは再計算ではない。損傷・燃費・ペース変化のたびに、そのとき実測
    されている燃費と残り周回でプランを組み直し、選択し直し、`active_plan` を
    更新しなければならない。この関数がその再計算そのものである。

    入力は全て呼び出し側（bridge）が権威データから渡す。ここでは推測しない。
    証拠が足りない時は「前のPlanを維持し、理由を返す」——黙って古い前提を
    使い続けることも、根拠なく乗り換えることもしない。
    """
    previous_plan = (previous or {}).get('selected_plan') if isinstance(previous, dict) else None
    rebuilt = build_initial_plans(
        snapshot_id=snapshot_id, current_lap=current_lap,
        fuel_level_l=fuel_level_l, avg_fuel_per_lap_l=recent_fuel_per_lap_l,
        clean_laps_sampled=clean_laps_sampled,
        crossings_to_finish=crossings_to_finish, reserve_l=reserve_l,
        effective_capacity_l=effective_capacity_l)
    if not rebuilt.get('available'):
        return {
            'available': False,
            'reason': rebuilt.get('reason') or 'recalculation_inputs_insufficient',
            'trigger_reason': trigger_reason,
            'previous_plan': previous_plan,
            'selected_plan': previous_plan,   # 根拠が無い時は乗り換えない
            'plan_changed': False,
            'options': previous if isinstance(previous, dict) else None,
        }

    # ★Plan C の燃費目標はラッチする。
    #   目標値は「今の燃費なら latest_safe+1 まで届かせるのに必要な燃費」であり、
    #   計算に使った燃費より必ず小さい。節約して燃費が下がるたびに組み直すと目標も
    #   一緒に下がるため、目標が逃げ続けて永久に達成できない（本番でPlan Cが死ぬ）。
    #   最初に提案した時の目標を保持し、その後の実測がそれを下回った時に達成とする。
    previous_plan_c = (previous or {}).get('plan_c') if isinstance(previous, dict) else None
    if (isinstance(previous_plan_c, dict) and previous_plan_c.get('fuel_feasible')
            and (rebuilt.get('plan_c') or {}).get('fuel_feasible')
            and _finite(previous_plan_c.get('required_fuel_per_lap_l'))):
        rebuilt['plan_c'] = {
            **rebuilt['plan_c'],
            'required_fuel_per_lap_l': previous_plan_c['required_fuel_per_lap_l'],
            'target_lap': previous_plan_c.get('target_lap'),
            'target_in_laps': previous_plan_c.get('target_in_laps'),
            'fuel_save_target_latched': True,
        }

    plan_c_verdict = decide_plan_c(
        rebuilt, fuel_save_recent_l_per_lap=fuel_save_recent_l_per_lap,
        rival_pitted_first=rival_pitted_first, clean_air=clean_air,
        rejoin_not_worse=rejoin_not_worse)
    if plan_c_verdict.get('available'):
        rebuilt['plan_c'] = {**rebuilt['plan_c'], 'available': True,
                             'reason': 'plan_c_conditions_proven'}
    rebuilt['plan_c_evidence'] = plan_c_verdict

    ab_decision = decide_at_plan_a(
        rebuilt, current_lap=current_lap, current_fuel_l=fuel_level_l,
        avg_fuel_per_lap_l=recent_fuel_per_lap_l,
        pit_now_forecast=pit_now_forecast,
        pit_next_lap_forecast=pit_next_lap_forecast,
        relative_pace_advantage_s=relative_pace_advantage_s)
    if (ab_decision.get('selected_plan') == 'B'
            and isinstance(rebuilt.get('plan_b'), dict)):
        rebuilt['plan_b'] = {**rebuilt['plan_b'], 'available': True,
                             'reason': 'plan_b_conditions_proven'}
    rebuilt['plan_b_evidence'] = ab_decision.get('plan_b_evidence')

    if plan_c_verdict.get('available'):
        selected, reason = 'C', 'plan_c_conditions_proven'
    elif ab_decision.get('available'):
        selected = ab_decision.get('selected_plan') or 'A'
        reason = ab_decision.get('reason') or 'plan_ab_decision'
    else:
        # A/B の比較材料が無い＝保守側。基準戦略に留まる。
        selected, reason = 'A', ab_decision.get('reason') or 'plan_ab_comparison_unavailable'

    rebuilt['selected_plan'] = selected
    rebuilt['decision_reason'] = reason
    rebuilt['decision_evidence'] = ab_decision
    return {
        'available': True,
        'reason': reason,
        'trigger_reason': trigger_reason,
        'plan_b_evidence': ab_decision.get('plan_b_evidence'),
        'previous_plan': previous_plan,
        'selected_plan': selected,
        'plan_changed': bool(previous_plan is not None and previous_plan != selected),
        'options': rebuilt,
        'inputs': {
            'fuel_level_l': round(float(fuel_level_l), 3) if _finite(fuel_level_l) else None,
            'recent_fuel_per_lap_l': (round(float(recent_fuel_per_lap_l), 3)
                                      if _finite(recent_fuel_per_lap_l) else None),
            'baseline_pace_s': baseline_pace_s,
            'recent_pace_s': recent_pace_s,
            'crossings_to_finish': crossings_to_finish,
        },
        'plan_c_evidence': plan_c_verdict,
    }


def score_execution(options, *, actual_entry_lap, actual_fuel_added_l):
    """Grade which announced plan the driver executed and its fuel error."""
    if not isinstance(options, dict) or not options.get('available'):
        return {'available': False, 'reason': 'options_unavailable'}
    if not isinstance(actual_entry_lap, int) or actual_entry_lap < 0:
        return {'available': False, 'reason': 'invalid_entry_lap'}
    candidates = []
    for label in ('A', 'B'):
        plan = options.get('plan_' + label.lower()) or {}
        target = plan.get('target_lap')
        if plan.get('available') and isinstance(target, int):
            candidates.append((abs(actual_entry_lap - target), label, plan))
    if not candidates:
        return {'available': False, 'reason': 'no_pit_plan_to_score'}
    _, label, plan = sorted(candidates, key=lambda item: (item[0], item[1]))[0]
    planned_add = plan.get('add_fuel_l')
    fuel_error = (float(actual_fuel_added_l) - float(planned_add)
                  if _finite(actual_fuel_added_l) and _finite(planned_add) else None)
    return {
        'available': True,
        'snapshot_id': options.get('snapshot_id'),
        'executed_plan': label,
        'planned_entry_lap': plan.get('target_lap'),
        'actual_entry_lap': actual_entry_lap,
        'entry_lap_error': actual_entry_lap - plan.get('target_lap'),
        'planned_add_fuel_l': planned_add,
        'actual_fuel_added_l': (round(float(actual_fuel_added_l), 3)
                                if _finite(actual_fuel_added_l) else None),
        'fuel_add_error_l': round(fuel_error, 3) if fuel_error is not None else None,
    }


def decide_at_plan_a(options, *, current_lap, current_fuel_l,
                     avg_fuel_per_lap_l, pit_now_forecast,
                     pit_next_lap_forecast, relative_pace_advantage_s=None):
    """Choose A or B — where B is now the conditional undercut.

    ★Plan B定義の判断（2026-08-12）：B は「Aの1周後」ではなく「Aより前の早入れ」。
    したがって判断材料も変わる。燃料が持つかどうかではなく、
      ・燃料ウインドウが開いていること（Aより前に成立する周があること）
      ・前走車より実測で速いこと（アンダーカットが機能する理由）
      ・早入れ後の復帰が遅い集団に沈まないこと
    の3つが揃った時だけ B を選ぶ。1つでも欠ければ A のままにする。

    Historical Monza outcomes show that conditional post-cycle position can
    move in either direction depending on rival stops.  It is therefore
    retained for scoring, but deliberately excluded from this choice.
    """
    if not isinstance(options, dict) or not options.get('available'):
        return {'available': False, 'reason': 'options_unavailable'}
    plan_a = options.get('plan_a') or {}
    plan_b = options.get('plan_b') or {}
    if not plan_a.get('available'):
        return {'available': False, 'reason': 'baseline_plan_not_available'}
    if not isinstance(current_lap, int) or isinstance(current_lap, bool):
        return {'available': False, 'reason': 'invalid_current_lap'}
    if not _finite(current_fuel_l) or not _finite(avg_fuel_per_lap_l):
        return {'available': False, 'reason': 'live_fuel_evidence_missing'}

    decision_id = '%s:decision-lap:%s' % (options.get('snapshot_id'), current_lap)
    evidence = {
        'decision_id': decision_id,
        'current_lap': current_lap,
        'current_fuel_l': round(float(current_fuel_l), 3),
        'avg_fuel_per_lap_l': round(float(avg_fuel_per_lap_l), 3),
        'fuel_window_open_in_laps': options.get('fuel_window_open_in_laps'),
        'pit_cycle_position_used': False,
    }
    if not plan_b.get('fuel_window_open'):
        return {**evidence, 'available': True, 'selected_plan': 'A',
                'reason': plan_b.get('reason') or 'fuel_window_not_open',
                'plan_b_evidence': decide_plan_b(options)}

    def positions(forecast):
        if not isinstance(forecast, dict) or not forecast.get('available'):
            return None
        try:
            likely = int(forecast['likely']['position'])
            worst = int(forecast['worst']['position'])
        except (KeyError, TypeError, ValueError):
            return None
        if likely < 1 or worst < likely:
            return None
        return {'likely': likely, 'worst': worst,
                'snapshot_id': forecast.get('snapshot_id'),
                'model_version': forecast.get('model_version')}

    # 早入れ側（=いま入る）と基準側（=もう1周待つ）の復帰比較。
    # 早入れが遅い集団へ沈むなら rejoin_clear は成立しない。
    undercut = positions(pit_now_forecast)
    baseline = positions(pit_next_lap_forecast)
    evidence['physical_rejoin'] = {'plan_b': undercut, 'plan_a': baseline}
    rejoin_clear = None
    if undercut is not None and baseline is not None:
        rejoin_clear = bool(undercut['likely'] <= baseline['likely']
                            and undercut['worst'] <= baseline['worst'])

    verdict = decide_plan_b(
        options, relative_pace_advantage_s=relative_pace_advantage_s,
        rejoin_clear=rejoin_clear)
    evidence['plan_b_evidence'] = verdict
    if verdict.get('available'):
        return {**evidence, 'available': True, 'selected_plan': 'B',
                'reason': 'plan_b_undercut_conditions_proven'}
    return {**evidence, 'available': True, 'selected_plan': 'A',
            'reason': 'plan_b_undercut_conditions_unproven'}
