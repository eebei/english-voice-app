from pathlib import Path

source = (Path(__file__).parent / "bridge.py").read_text(encoding="utf-8")

checks = {
    "module imported": "import pit_loss_calibrator as pit_loss_calibrator_mod" in source,
    "APPDATA persistence": 'PIT_LOSS_PATH = os.path.join(_config_dir, "pit_loss_calibration.json")' in source,
    "calibrator constructed": "PitLossCalibrator(PIT_LOSS_PATH)" in source,
    "entry coordinate captured": "pit_enter_pct = reader.read_float('LapDistPct')" in source,
    "exit coordinate captured": "'pit_exit_pct': _exit_pct" in source,
    "normal ticks wired": "observe_normal_tick(" in source,
    "on-track filter wired": "on_track=bool(onTrack)" in source,
    "track-surface filter wired": "player_track_surface=reader.read_int('PlayerTrackSurface')" in source,
    "repair separated": "_classification = 'repair'" in source,
    "long stop separated": "_classification = 'long_stop'" in source,
    "drive through separated": "_classification = 'drive_through'" in source,
    "full refuel reference separated": "_classification = 'full_refuel_reference'" in source,
    "full refuel capacity evidence": "'effective_fuel_capacity_l': session_effective_fuel_capacity_l" in source,
    "full refuel reference flag": "'reference_only': _classification in (" in source,
    "unknown capacity fail closed": "_classification = 'fuel_capacity_unknown_reference'" in source,
    "unknown fuel delta fail closed": "_classification = 'fuel_delta_unknown_reference'" in source,
    "result broadcast allowed": "'pit_loss_calibration'," in source,
}
failed = [name for name, ok in checks.items() if not ok]
if failed:
    raise AssertionError("missing wiring: " + ", ".join(failed))
print("✅ pit loss wiring: %d checks" % len(checks))
