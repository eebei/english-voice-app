#!/usr/bin/env python3
"""Build 255 wiring guard for owned plan and pit-loss telemetry."""
from pathlib import Path

SOURCE = Path(__file__).with_name("bridge.py").read_text(encoding="utf-8")

checks = {
    "plan state is session scoped": "strategy_plan_signature = None" in SOURCE,
    "plan revision changes on signature": "if _plan_signature != strategy_plan_signature:" in SOURCE,
    "plan records action and reason": "'action': _plan_action" in SOURCE and "'reason': _plan_reason" in SOURCE,
    "plan owns fuel setting": "'set_fuel_l': _plan_set_fuel" in SOURCE,
    "plan owns physical and conditional positions": "'physical_exit_position': _plan_physical" in SOURCE and "'conditional_cycle_position': _plan_cycle" in SOURCE,
    "telemetry exposes owned plan": "'strategy_plan': strategy_plan" in SOURCE,
    "telemetry exposes calibration": "'pit_loss_calibration': _pit_now_calibration" in SOURCE,
    "plan update is traceable": "STRATEGY PLAN update:" in SOURCE,
}

failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("✅ " if ok else "❌ ") + name)
if failed:
    raise SystemExit(1)
print(f"Strategy plan wiring: {len(checks)}/{len(checks)} passed")
