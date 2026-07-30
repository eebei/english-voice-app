from pathlib import Path

source = (Path(__file__).parent / "bridge.py").read_text(encoding="utf-8")

checks = {
    "module imported": "import pit_exit_forecaster as pit_exit_forecaster_mod" in source,
    "genuine entry edge": "if onPit and prev['onPit'] is False:" in source,
    "calibration read": "pit_loss_calibrator.get_summary(" in source,
    "same class fail closed": "car_class_map.get(_pci) != player_class_id" in source,
    "snapshot forecast": "pit_exit_forecaster_mod.forecast_at_pit_entry(" in source,
    "shadow forecast logged": "PIT EXIT SHADOW forecast:" in source,
    "actual score": "pit_exit_forecaster_mod.score_actual(" in source,
    "actual score logged": "PIT EXIT SHADOW actual:" in source,
    "payload carries shadow": "'pit_exit_forecast_shadow': pit_exit_forecast_shadow" in source,
    "no shadow radio": "'trigger': 'pit_exit_forecast" not in source,
}

failed = [name for name, ok in checks.items() if not ok]
if failed:
    raise AssertionError("missing Phase C wiring: " + ", ".join(failed))
print("✅ pit exit forecaster wiring: %d checks" % len(checks))
