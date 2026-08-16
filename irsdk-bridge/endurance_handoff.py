"""Deterministic Chief Engineer v0 handoff packet for endurance races."""
import math


def _num(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def should_emit(config, *, previous_activity, new_activity, is_race):
    """Fail-closed gate for a driver-change handoff event."""
    config = config if isinstance(config, dict) else {}
    roster = [str(x).strip() for x in (config.get('roster') or []) if str(x).strip()][:3]
    return bool(
        config.get('enabled') is True
        and len(roster) >= 2
        and previous_activity == 'ACTIVE'
        and new_activity == 'DRIVER_HANDOFF'
        and is_race is True
    )


def build_packet(state, *, current_lap=None, class_position=None, gap_ahead_s=None,
                 roster=None, current_index=0, tire_report=None, endurance_plan=None):
    """Build a concise, evidence-only packet for the next stint/driver.

    Missing evidence remains None; callers must not turn it into a claim.
    """
    state = state if isinstance(state, dict) else {}
    options = state.get('active_plan_snapshot') or {}
    selected = state.get('active_plan') or options.get('selected_plan')
    plan = options.get('plan_' + str(selected).lower(), {}) if selected else {}
    recalc = state.get('last_recalculation') or {}
    damage = (state.get('damage_state') or {}).get('damage_observation')
    names = [str(x).strip() for x in (roster or []) if str(x).strip()][:3]
    idx = current_index if isinstance(current_index, int) and 0 <= current_index < len(names) else 0
    next_idx = (idx + 1) % len(names) if names else None
    tire_report = tire_report if isinstance(tire_report, dict) else {}
    tire_summary = str(tire_report.get('summary') or '').strip()[:180] or None
    tire_measured_at = tire_report.get('measured_at_session_s')
    endurance_plan = endurance_plan if isinstance(endurance_plan, dict) else {}
    splash = endurance_plan.get('splash_forecast') or {}
    splash_summary = None
    if (endurance_plan.get('available') is True
            and splash.get('planning_available') is True
            and splash.get('splash_candidate') is True):
        splash_summary = {
            'future_stop_count': endurance_plan.get('future_stop_count'),
            'projected_final_service_l': splash.get('projected_final_service_l'),
            'final_stint_window_in_laps': splash.get('final_stint_window_in_laps'),
            'final_stint_window_open': splash.get('final_stint_window_open') is True,
            'traffic_rejoin_check_required': splash.get('traffic_rejoin_check_required') is True,
        }
    return {
        'available': bool(selected and isinstance(plan, dict) and plan),
        'selected_plan': selected,
        'current_lap': int(current_lap) if _num(current_lap) else None,
        'class_position': int(class_position) if _num(class_position) else None,
        'next_pit_lap': plan.get('target_lap'),
        'fuel_set_l': plan.get('set_fuel_l'),
        'finish_margin_l': plan.get('projected_finish_margin_l'),
        'gap_ahead_s': round(gap_ahead_s, 2) if _num(gap_ahead_s) else None,
        'strategy_reason': options.get('decision_reason') or recalc.get('reason'),
        'damage_observed': bool(damage),
        'damage_seconds': damage.get('damage_s') if isinstance(damage, dict) else None,
        # A pit/garage measurement is evidence for the next driver.  Never
        # send a live estimate as if it were measured tyre wear.
        'tire_report': ({
            'summary': tire_summary,
            'measured_at_session_s': round(tire_measured_at, 1)
            if _num(tire_measured_at) else None,
        } if tire_summary else None),
        # Compact team horizon: it is a proposed final-service window, never
        # an immediate pit order.  The next driver revalidates it locally.
        'endurance_splash': splash_summary,
        'current_driver': names[idx] if names else None,
        'next_driver': names[next_idx] if next_idx is not None else None,
        'next_driver_index': next_idx,
    }
