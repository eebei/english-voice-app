from pit_exit_forecaster import forecast_at_pit_entry, forecast_pit_now, score_actual

passed = 0


def check(name, condition):
    global passed
    if not condition:
        raise AssertionError(name)
    passed += 1


calibration = {
    "prediction_ready": True,
    "pit_entry_pct": .98,
    "pit_exit_pct": .06,
    "lane_total_q1_s": 28.0,
    "lane_total_median_s": 32.0,
    "lane_total_q3_s": 36.0,
    "pit_sample_count": 4,
    "normal_sample_count": 5,
    "usable_sample_count": 4,
}
snapshot = {
    "snapshot_id": "s-1",
    "player_lap": 10,
    "player_class_id": 101,
    "cars": [
        {"car_idx": 1, "class_position": 1, "car_number": "11",
         "class_id": 101,
         "lap": 11, "lap_dist_pct": .10, "last_lap_time": 100,
         "on_pit_road": False, "track_surface": 3},
        {"car_idx": 2, "class_position": 2, "car_number": "22",
         "class_id": 101,
         "lap": 10, "lap_dist_pct": .90, "last_lap_time": 100,
         "on_pit_road": False, "track_surface": 3},
        {"car_idx": 3, "class_position": 4, "car_number": "33",
         "class_id": 101,
         "lap": 10, "lap_dist_pct": .70, "last_lap_time": 100,
         "on_pit_road": False, "track_surface": 3},
        {"car_idx": 4, "class_position": 5, "car_number": "44",
         "class_id": 101,
         "lap": 10, "lap_dist_pct": .50, "last_lap_time": 100,
         "on_pit_road": True, "track_surface": 2},
        {"car_idx": 5, "class_position": 6, "car_number": "55",
         "class_id": 101,
         "lap": 10, "lap_dist_pct": .40, "last_lap_time": -1,
         "on_pit_road": False, "track_surface": 3},
        {"car_idx": 6, "class_position": 1, "car_number": "66",
         "class_id": 202,
         "lap": 12, "lap_dist_pct": .90, "last_lap_time": 80,
         "on_pit_road": False, "track_surface": 3},
    ],
}

result = forecast_at_pit_entry(snapshot=snapshot, calibration=calibration)
check("available", result["available"])
check("shadow only", result["shadow_mode"])
check("position worsens with longer stop",
      result["best"]["position"] <= result["likely"]["position"]
      <= result["worst"]["position"])
check("pit car excluded", 4 in result["likely"]["excluded_car_idxs"])
check("invalid pace excluded", 5 in result["likely"]["excluded_car_idxs"])
check("other class excluded", 6 in result["likely"]["excluded_car_idxs"])
check("intent not inferred",
      result["assumptions"]["other_car_pit_intent"] == "not_inferred")
check("blend evidence present", isinstance(result["likely"]["blend_conflicts"], list))
check("loss sign produces lane time", result["lane_time_s"]["likely"] == 32.0)

not_ready = dict(calibration, prediction_ready=False)
check("not ready unavailable",
      forecast_at_pit_entry(snapshot=snapshot, calibration=not_ready)
      ["unavailable_reason"] == "calibration_not_ready")

two_samples = dict(calibration, usable_sample_count=2)
check("two samples unavailable",
      forecast_at_pit_entry(snapshot=snapshot, calibration=two_samples)
      ["unavailable_reason"] == "calibration_insufficient_samples")
two_sample_result = forecast_at_pit_entry(snapshot=snapshot, calibration=two_samples)
check("remaining calibration samples exposed",
      two_sample_result["evidence"]["remaining_sample_count"] == 1)

bad_distribution = dict(calibration, lane_total_q1_s=36,
                        lane_total_q3_s=28)
check("bad distribution unavailable",
      forecast_at_pit_entry(snapshot=snapshot, calibration=bad_distribution)
      ["unavailable_reason"] == "calibration_distribution_invalid")

scored = score_actual(result, result["likely"]["position"])
check("actual score", scored["likely_error_positions"] == 0)
check("range hit", scored["inside_best_worst"])
check("unavailable score omitted",
      score_actual({"available": False}, 4) is None)

pit_now_snapshot = dict(snapshot, player_lap_dist_pct=.50,
                        player_last_lap_time=100)
pit_now = forecast_pit_now(snapshot=pit_now_snapshot, calibration=calibration)
check("pit-now forecast available", pit_now["available"])
check("pit-now is driver facing", pit_now["driver_facing"]
      and not pit_now["shadow_mode"] and pit_now["model_version"] == 3)
check("pit-now includes time to entry", pit_now["time_to_entry_s"] == 48.0)
check("pit-now exposes all six evidence families",
      all(k in pit_now for k in ("best", "likely", "worst"))
      and "nearest_ahead" in pit_now["likely"]
      and "nearest_behind" in pit_now["likely"]
      and "blend_conflicts" in pit_now["likely"])
check("pit-now classifies traffic state",
      pit_now["likely"]["traffic_state"] in
      ("clear_air", "traffic", "blend_risk"))

learned = dict(calibration, forecast_learning={
    "outcome_count": 3, "required_outcome_count": 3, "bias_ready": True,
    "likely_bias_positions": -2, "error_q1_positions": -3, "error_q3_positions": 1,
})
learned_result = forecast_at_pit_entry(snapshot=snapshot, calibration=learned)
check("three scored exits apply learned likely correction",
      learned_result["likely"]["position"] == result["likely"]["position"] - 2)
check("learned correction remains ordered range",
      learned_result["best"]["position"] <= learned_result["likely"]["position"]
      <= learned_result["worst"]["position"])

unreliable_snapshot = dict(snapshot, cars=snapshot["cars"] + [{
    "car_idx": 7, "class_position": 0, "car_number": "77", "class_id": 101,
    "lap": 10, "lap_dist_pct": .65, "last_lap_time": 100, "on_pit_road": False,
}])
check("invalid same-class standings fail closed",
      forecast_at_pit_entry(snapshot=unreliable_snapshot, calibration=calibration)
      ["unavailable_reason"] == "class_standings_unreliable")

print("✅ pit exit forecaster: %d checks" % passed)
