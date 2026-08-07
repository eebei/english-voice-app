"""Phase C pit-exit position and traffic forecast.

The entry-edge path remains the scoring reference.  The driver-facing path
projects from the current lap position so a pre-pit question can be answered
with the same evidence families and then scored against the actual exit.
"""

MODEL_VERSION = 1
DRIVER_MODEL_VERSION = 3
MIN_LAP_TIME_S = 20.0
MAX_LAP_TIME_S = 600.0
BLEND_WINDOW_S = 3.0


def _num(value):
    try:
        value = float(value)
        return value if value == value else None
    except (TypeError, ValueError):
        return None


def _unavailable(reason, evidence=None):
    result = {
        "available": False,
        "unavailable_reason": reason,
        "shadow_mode": True,
        "model_version": MODEL_VERSION,
    }
    if isinstance(evidence, dict):
        result["evidence"] = evidence
    return result


def _valid_lap_time(value):
    value = _num(value)
    return value if value is not None and MIN_LAP_TIME_S < value < MAX_LAP_TIME_S else None


def _forward_progress(entry_pct, exit_pct):
    delta = (exit_pct - entry_pct) % 1.0
    return delta if 0.0 < delta < 0.5 else None


def _scenario(cars, player_exit_progress, projection_s, player_class_id):
    projected = []
    excluded = []
    invalid_same_class_positions = []
    for car in cars:
        idx = car.get("car_idx")
        if player_class_id is None or car.get("class_id") != player_class_id:
            excluded.append(idx)
            continue
        class_position = _num(car.get("class_position"))
        # A zero/missing class position is not an innocent omission: it means
        # this field cannot be ordered reliably (common in AI/race joins).
        # Returning a precise P-number while such cars exist created the P17
        # -> actual P8/P2 failures in the Monza Phase C run.
        if class_position is None or class_position < 1:
            invalid_same_class_positions.append(idx)
            excluded.append(idx)
            continue
        lap = _num(car.get("lap"))
        pct = _num(car.get("lap_dist_pct"))
        lap_time = _valid_lap_time(car.get("last_lap_time"))
        if lap is None or pct is None or not 0.0 <= pct < 1.0 or lap_time is None:
            excluded.append(idx)
            continue
        # AI cars may leave TrackSurface unavailable while lap progress and
        # class position keep updating.  The explicit pit flag is decisive;
        # otherwise valid progress is stronger than this weak surface field.
        if car.get("on_pit_road"):
            excluded.append(idx)
            continue
        progress = lap + pct + projection_s / lap_time
        projected.append({
            "car_idx": idx,
            "class_position": int(class_position),
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
    nearest_gap = min(
        (abs(item["gap_s"]) for item in (ahead_result, behind_result)
         if item is not None),
        default=None)
    return {
        "position": position,
        "nearest_ahead": ahead_result,
        "nearest_behind": behind_result,
        "blend_conflicts": blend,
        "traffic_state": (
            "blend_risk" if blend else
            "traffic" if nearest_gap is not None and nearest_gap <= 5.0 else
            "clear_air"),
        "projected_car_count": len(projected),
        "excluded_car_idxs": excluded,
        "invalid_same_class_position_car_idxs": invalid_same_class_positions,
    }


def _forecast_learning_status(calibration):
    """Apply a persisted, observed rejoin bias after three scored exits.

    The sign is actual position minus predicted position.  Negative means the
    prior model predicted a worse rejoin than reality; positive means it was
    optimistic.  Until three outcomes exist, every forecast is still emitted
    and scored but no arbitrary correction is invented.
    """
    learning = calibration.get("forecast_learning") if isinstance(calibration, dict) else None
    if not isinstance(learning, dict) or not learning.get("bias_ready"):
        return learning or {"outcome_count": 0, "required_outcome_count": 3, "bias_ready": False}
    q1 = _num(learning.get("error_q1_positions"))
    median = _num(learning.get("likely_bias_positions"))
    q3 = _num(learning.get("error_q3_positions"))
    if None in (q1, median, q3):
        return learning
    return learning


def forecast_at_pit_entry(*, snapshot, calibration):
    """Forecast best/likely/worst class position from a pit-entry snapshot."""
    if not isinstance(calibration, dict) or not calibration.get("prediction_ready"):
        usable = int(_num(calibration.get("usable_sample_count")) or 0) \
            if isinstance(calibration, dict) else 0
        return _unavailable("calibration_not_ready", {
            "usable_sample_count": usable,
            "required_sample_count": 3,
            "remaining_sample_count": max(0, 3 - usable),
        })
    usable = _num(calibration.get("usable_sample_count"))
    if usable is None or usable < 3:
        usable = int(usable or 0)
        return _unavailable("calibration_insufficient_samples", {
            "usable_sample_count": usable,
            "required_sample_count": 3,
            "remaining_sample_count": max(0, 3 - usable),
        })
    if not isinstance(snapshot, dict):
        return _unavailable("snapshot_missing")
    player_lap = _num(snapshot.get("player_lap"))
    entry_pct = _num(calibration.get("pit_entry_pct"))
    exit_pct = _num(calibration.get("pit_exit_pct"))
    q1 = _num(calibration.get("lane_total_q1_s"))
    median = _num(calibration.get("lane_total_median_s"))
    q3 = _num(calibration.get("lane_total_q3_s"))
    if None in (player_lap, entry_pct, exit_pct, q1, median, q3):
        return _unavailable("calibration_fields_missing")
    progress_delta = _forward_progress(entry_pct, exit_pct)
    if progress_delta is None:
        return _unavailable("pit_coordinates_invalid")
    lane_times = {"best": q1, "likely": median, "worst": q3}
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
    if any(scenario["invalid_same_class_position_car_idxs"]
           for scenario in scenarios.values()):
        return _unavailable("class_standings_unreliable", {
            "invalid_same_class_position_car_idxs": sorted(set(
                idx for scenario in scenarios.values()
                for idx in scenario["invalid_same_class_position_car_idxs"])),
        })
    # Field evidence (Monza AI Race, 2026-08-07) proved that a raw position
    # bias combines incompatible worlds: simultaneous AI stops made one
    # forecast look 10 places pessimistic, while a later normal stop looked
    # 11 places optimistic. Preserve outcomes for evaluation, but never apply
    # their aggregate as a driver-facing correction until pit intent is an
    # explicit model input.
    learning = _forecast_learning_status(calibration)
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
            "forecast_learning": learning,
        },
        "assumptions": {
            "other_car_pit_intent": "not_inferred",
            "cars_already_on_pit_road": "excluded",
        },
    }


def forecast_pit_now(*, snapshot, calibration):
    """Forecast a stop requested while the player is still on track.

    Other cars advance for the player's remaining time to pit entry plus the
    measured pit-lane time.  This is the driver-facing Phase C calculation;
    ``forecast_at_pit_entry`` remains the zero-horizon scoring reference.
    """
    if not isinstance(snapshot, dict):
        return _unavailable("snapshot_missing")
    player_lap = _num(snapshot.get("player_lap"))
    player_pct = _num(snapshot.get("player_lap_dist_pct"))
    player_lap_time = _valid_lap_time(snapshot.get("player_last_lap_time"))
    if None in (player_lap, player_pct, player_lap_time):
        return _unavailable("player_progress_missing")
    if not 0.0 <= player_pct < 1.0:
        return _unavailable("player_progress_invalid")

    base = forecast_at_pit_entry(snapshot=snapshot, calibration=calibration)
    if not base.get("available"):
        return base
    entry_pct = _num(calibration.get("pit_entry_pct"))
    exit_pct = _num(calibration.get("pit_exit_pct"))
    progress_delta = _forward_progress(entry_pct, exit_pct)
    if progress_delta is None:
        return _unavailable("pit_coordinates_invalid")
    entry_lap = player_lap if player_pct <= entry_pct else player_lap + 1.0
    entry_progress = entry_lap + entry_pct
    time_to_entry_s = (entry_progress - (player_lap + player_pct)) * player_lap_time
    player_exit_progress = entry_progress + progress_delta
    cars = snapshot.get("cars")
    player_class_id = snapshot.get("player_class_id")
    scenarios = {
        name: _scenario(cars, player_exit_progress,
                        time_to_entry_s + base["lane_time_s"][name],
                        player_class_id)
        for name in ("best", "likely", "worst")
    }
    if scenarios["likely"]["projected_car_count"] == 0:
        return _unavailable("no_projectable_same_class_cars")
    if any(scenario["invalid_same_class_position_car_idxs"]
           for scenario in scenarios.values()):
        return _unavailable("class_standings_unreliable")
    learning = _forecast_learning_status(calibration)
    positions = [scenarios[name]["position"] for name in ("best", "likely", "worst")]
    if positions != sorted(positions):
        return _unavailable("position_range_invalid")
    result = dict(base)
    result.update({
        "shadow_mode": False,
        "driver_facing": True,
        "model_candidate": "C_pit_now_projection",
        "model_version": DRIVER_MODEL_VERSION,
        "time_to_entry_s": round(time_to_entry_s, 3),
        "forecast_learning": learning,
        "best": scenarios["best"],
        "likely": scenarios["likely"],
        "worst": scenarios["worst"],
    })
    return result


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
        "likely_position": likely,
        "likely_error_positions": actual - likely,
        "inside_best_worst": best <= actual <= worst,
        "model_version": forecast.get("model_version"),
        "snapshot_id": forecast.get("snapshot_id"),
    }
