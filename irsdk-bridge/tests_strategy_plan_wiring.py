#!/usr/bin/env python3
"""Build 255/256 wiring guard for owned plan, pit state and pit-loss telemetry."""
import sys
from pathlib import Path

SOURCE = Path(__file__).with_name("bridge.py").read_text(encoding="utf-8")
sys.path.insert(0, str(Path(__file__).parent))
import bridge

checks = {
    "plan state is session scoped": "strategy_plan_signature = None" in SOURCE,
    "plan revision changes on signature": "if _plan_signature != strategy_plan_signature:" in SOURCE,
    "plan records action and reason": "'action': _plan_action" in SOURCE and "'reason': _plan_reason" in SOURCE,
    "plan owns fuel setting": "'set_fuel_l': _plan_set_fuel" in SOURCE,
    "plan owns physical and conditional positions": "'physical_exit_position': _plan_physical" in SOURCE and "'conditional_cycle_position': _plan_cycle" in SOURCE,
    "telemetry exposes owned plan": "'strategy_plan': strategy_plan" in SOURCE,
    "telemetry exposes calibration": "'pit_loss_calibration': _pit_now_calibration" in SOURCE,
    "plan update is traceable": "STRATEGY PLAN update:" in SOURCE,
    "post-stop fuel margin is recomputed from current fuel":
        "fuel - _fuel_strategy_live['required_fuel_l']" in SOURCE,
    "post-stop pit requirement is recomputed":
        "_fuel_strategy_live['pit_required'] = _live_add > 0.05" in SOURCE,
    "volatile forecast positions do not create plan revisions":
        "round(_plan_margin, 2) if isinstance(_plan_margin, (int, float)) else None)" in SOURCE,
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
