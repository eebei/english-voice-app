"""Phase C shadow-mode pit-exit position and traffic forecast.

The first production stage is diagnostic only: bridge logs the forecast at a
genuine pit-entry edge and scores it against the actual class position at exit.
It does not speak or recommend strategy until replay/field accuracy is proven.
"""

MODEL_VERSION = 1
MIN_LAP_TIME_S = 20.0
MAX_LAP_TIME_S = 600.0
BLEND_WINDOW_S = 3.0


def _num(value):
    try:
        value = float(value)
        return value if value == value else None
    except (TypeError, ValueError):
        return None


def _unavailable(reason):
    return {
        "available": False,
        "unavailable_reason": reason,
        "shadow_mode": True,
        "model_version": MODEL_VERSION,
    }


def _valid_lap_time(value):
    value = _num(value)
    return value if value is not None and MIN_LAP_TIME_S < value < MAX_LAP_TIME_S else None


def _forward_progress(entry_pct, exit_pct):
    delta = (exit_pct - entry_pct) % 1.0
    return delta if 0.0 < delta < 0.5 else None


def _scenario(cars, player_exit_progress, lane_s, player_class_id):
    projected = []
    excluded = []
    for car in cars:
        idx = car.get("car_idx")
        if player_class_id is None or car.get("class_id") != player_class_id:
            excluded.append(idx)
            continue
        lap = _num(car.get("lap"))
        pct = _num(car.get("lap_dist_pct"))
        lap_time = _valid_lap_time(car.get("last_lap_time"))
        if lap is None or pct is None or not 0.0 <= pct < 1.0 or lap_time is None:
            excluded.append(idx)
            continue
        if car.get("on_pit_road") or car.get("track_surface") not in (2, 3):
            excluded.append(idx)
            continue
        progress = lap + pct + lane_s / lap_time
        projected.append({
            "car_idx": idx,
            "class_position": car.get("class_position"),
            "car_number": car.get("car_number"),
            "progress": progress,
            "lap_time": lap_time,
        })

    position = 1 + sum(1 for car in projected
                       if car["progress"] > player_exit_progress)
    ahead = [car for car in projected if car["progress"] > player_exit_progress]
    behind = [car for car in projected if car["progress"] <= player_exit_progress]
    nearest_ahead = min(ahead, key=lambda car: car["progress"] - player_exit_progress,
                        default=None)
    nearest_behind = min(behind, key=lambda car: player_exit_progress - car["progress"],
                         default=None)

    def relative(car, sign):
        if car is None:
            return None
        gap = abs(car["progress"] - player_exit_progress) * car["lap_time"]
        return {
            "car_idx": car["car_idx"],
            "car_number": car["car_number"],
            "class_position": car["class_position"],
            "gap_s": round(sign * gap, 3),
        }

    ahead_result = relative(nearest_ahead, 1)
    behind_result = relative(nearest_behind, -1)
    blend = [
        item for item in (ahead_result, behind_result)
        if item is not None and abs(item["gap_s"]) <= BLEND_WINDOW_S
    ]
    return {
        "position": position,
        "nearest_ahead": ahead_result,
        "nearest_behind": behind_result,
        "blend_conflicts": blend,
        "projected_car_count": len(projected),
        "excluded_car_idxs": excluded,
    }


def forecast_at_pit_entry(*, snapshot, calibration):
    """Forecast best/likely/worst class position from a pit-entry snapshot."""
    if not isinstance(calibration, dict) or not calibration.get("prediction_ready"):
        return _unavailable("calibration_not_ready")
    usable = _num(calibration.get("usable_sample_count"))
    if usable is None or usable < 3:
        return _unavailable("calibration_insufficient_samples")
    if not isinstance(snapshot, dict):
        return _unavailable("snapshot_missing")
    player_lap = _num(snapshot.get("player_lap"))
    entry_pct = _num(calibration.get("pit_entry_pct"))
    exit_pct = _num(calibration.get("pit_exit_pct"))
    normal_s = _num(calibration.get("normal_segment_median_s"))
    q1 = _num(calibration.get("observed_loss_q1_s"))
    median = _num(calibration.get("observed_loss_median_s"))
    q3 = _num(calibration.get("observed_loss_q3_s"))
    if None in (player_lap, entry_pct, exit_pct, normal_s, q1, median, q3):
        return _unavailable("calibration_fields_missing")
    progress_delta = _forward_progress(entry_pct, exit_pct)
    if progress_delta is None:
        return _unavailable("pit_coordinates_invalid")
    lane_times = {
        "best": normal_s + q1,
        "likely": normal_s + median,
        "worst": normal_s + q3,
    }
    if not (5.0 < lane_times["best"] <= lane_times["likely"]
            <= lane_times["worst"] < 300.0):
        return _unavailable("calibration_distribution_invalid")
    cars = snapshot.get("cars")
    if not isinstance(cars, list):
        return _unavailable("cars_missing")
    player_class_id = snapshot.get("player_class_id")
    if player_class_id is None:
        return _unavailable("player_class_missing")

    player_exit_progress = player_lap + entry_pct + progress_delta
    scenarios = {
        name: _scenario(cars, player_exit_progress, lane_s, player_class_id)
        for name, lane_s in lane_times.items()
    }
    if scenarios["likely"]["projected_car_count"] == 0:
        return _unavailable("no_projectable_same_class_cars")
    positions = [scenarios[name]["position"] for name in ("best", "likely", "worst")]
    if positions != sorted(positions):
        return _unavailable("position_range_invalid")
    return {
        "available": True,
        "unavailable_reason": None,
        "shadow_mode": True,
        "model_candidate": "B_lap_progress_projection",
        "model_version": MODEL_VERSION,
        "snapshot_id": snapshot.get("snapshot_id"),
        "best": scenarios["best"],
        "likely": scenarios["likely"],
        "worst": scenarios["worst"],
        "lane_time_s": {key: round(value, 3) for key, value in lane_times.items()},
        "evidence": {
            "pit_sample_count": calibration.get("pit_sample_count"),
            "normal_sample_count": calibration.get("normal_sample_count"),
            "usable_sample_count": calibration.get("usable_sample_count"),
        },
        "assumptions": {
            "other_car_pit_intent": "not_inferred",
            "cars_already_on_pit_road": "excluded",
        },
    }


def score_actual(forecast, actual_class_position):
    actual = _num(actual_class_position)
    if not isinstance(forecast, dict) or not forecast.get("available") or actual is None:
        return None
    actual = int(actual)
    best = int(forecast["best"]["position"])
    likely = int(forecast["likely"]["position"])
    worst = int(forecast["worst"]["position"])
    return {
        "actual_class_position": actual,
        "likely_error_positions": actual - likely,
        "inside_best_worst": best <= actual <= worst,
        "model_version": forecast.get("model_version"),
        "snapshot_id": forecast.get("snapshot_id"),
    }
