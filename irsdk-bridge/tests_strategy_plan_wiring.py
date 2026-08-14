#!/usr/bin/env python3
"""Build 255/256 wiring guard for owned plan, pit state and pit-loss telemetry."""
import sys
from pathlib import Path

SOURCE = Path(__file__).with_name("bridge.py").read_text(encoding="utf-8")
sys.path.insert(0, str(Path(__file__).parent))
import bridge

checks = {
    "Plan A/B module imported": "import strategy_options as strategy_options_mod" in SOURCE,
    "Plan A/B is session scoped": "strategy_options = None" in SOURCE,
    "initial options use one snapshot": "strategy_options_mod.build_initial_plans(" in SOURCE,
    "initial options have proactive radio": "'trigger': 'initial_strategy_plans'" in SOURCE,
    "Plan A target has an automatic decision event": "'trigger': 'strategy_plan_decision'" in SOURCE,
    "Plan A/B compares this-lap and next-lap physical rejoin":
        "strategy_options_mod.decide_at_plan_a(" in SOURCE
        and "pit_next_lap_forecast=_pit_next_forecast" in SOURCE,
    "conditional pit-cycle is excluded by comparator unit":
        "pit_cycle_position_used" in Path(__file__).with_name("strategy_options.py").read_text(encoding="utf-8"),
    "Plan B has a mandatory next-lap box trigger":
        "'trigger': 'strategy_plan_box_call'" in SOURCE,
    "Plan A/B decision is traced by decision id":
        "'decision_id': _option_decision.get('decision_id')" in SOURCE,
    "options are exposed to telemetry": "'strategy_options': strategy_options" in SOURCE,
    "pit exit scores announced options": "strategy_options_mod.score_execution(" in SOURCE,
    "option outcome is traceable": "STRATEGY OPTIONS outcome:" in SOURCE,
    "plan state is session scoped": "strategy_plan_signature = None" in SOURCE,
    "plan revision changes on signature": "if _plan_signature != strategy_plan_signature:" in SOURCE,
    "plan records action and reason": "'action': _plan_action" in SOURCE and "'reason': _plan_reason" in SOURCE,
    "plan owns fuel setting": "'set_fuel_l': _plan_set_fuel" in SOURCE,
    "plan owns physical and conditional positions": "'physical_exit_position': _plan_physical" in SOURCE and "'conditional_cycle_position': _plan_cycle" in SOURCE,
    "telemetry exposes owned plan": "'strategy_plan': strategy_plan" in SOURCE,
    "telemetry exposes calibration": "'pit_loss_calibration': _pit_now_calibration" in SOURCE,
    "plan update is traceable": "STRATEGY PLAN update:" in SOURCE,
    "same-lap fuel burn is not double-counted after S/F":
        "recomputing required-current here" in SOURCE
        and "fuel - _fuel_strategy_live['required_fuel_l']" not in SOURCE,
    "post-stop fuel recalculates from the authoritative checker projection":
        "FUEL POST-PIT RECALC crossings=%s" in SOURCE
        and "'live_post_pit_recalculation': True" in SOURCE,
    "fuel setting is capped by effective tank capacity":
        "_set_fuel = min(_set_fuel, _max_setting)" in SOURCE
        and "'one_stop_shortfall_l'" in SOURCE,
    "live switch inputs are exposed":
        "'battle_context': _battle_context" in SOURCE
        and "'pit_next_lap_forecast': _pit_next_forecast" in SOURCE
        and "'session_num': cur_snum" in SOURCE,
    "new drivers expose three-lap pace for first live playbook":
        "'driver_pace_median_s':" in SOURCE
        and "'driver_pace_sample_count':" in SOURCE,
    "fuel tenths and volatile forecast positions do not create plan revisions":
        "cur_snum, _plan_action, _plan_reason, _plan_set_fuel)" in SOURCE
        and "round(_plan_margin, 2)" not in SOURCE,
    "telemetry exposes lifecycle and pit phase":
        "'lifecycle_state': lifecycle_state" in SOURCE
        and "'pit_phase_state': _pit_phase_state" in SOURCE,
    "finished race gates the pit plan":
        "race_lifecycle.pit_plan_allowed(lifecycle_state)" in SOURCE,
    "SDK pit road owns pit-lane phase":
        bridge.derive_pit_phase('RACING', True, 6, None) == 'pit_lane',
    "pit exit owns out-lap until next S/F":
        bridge.derive_pit_phase('RACING', False, 6, 6) == 'out_lap',
    "next S/F returns normal racing phase":
        bridge.derive_pit_phase('RACING', False, 7, 6) == 'racing',
    "finish state overrides pit/out-lap state":
        bridge.derive_pit_phase('PLAYER_FINISHED', False, 7, 7) == 'finished',
}

failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("✅ " if ok else "❌ ") + name)
if failed:
    raise SystemExit(1)
print(f"Strategy plan wiring: {len(checks)}/{len(checks)} passed")
