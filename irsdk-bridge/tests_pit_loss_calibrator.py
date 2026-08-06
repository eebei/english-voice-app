import json
import os
import tempfile
from pit_loss_calibrator import PitLossCalibrator, crossed_forward, summarize_record

passed = 0
def check(name, condition):
    global passed
    if not condition:
        raise AssertionError(name)
    passed += 1

check("crossing", crossed_forward(.97, .99, .98))
check("wrap crossing", crossed_forward(.99, .02, .01))
check("teleport rejected", not crossed_forward(.5, .2, .9))
summary = summarize_record({
    "pit_samples": [{"lane_total_s": x, "classification": "calibration",
                     "service_profile_version": 1}
                    for x in (31.3, 27.0, 33.3)]
                   + [{"lane_total_s": 90, "classification": "repair"},
                      {"lane_total_s": 35.9,
                       "classification": "full_refuel_reference",
                       "reference_only": True}],
    "normal_samples": [{"normal_segment_s": x} for x in (7.1, 7.3, 7.2)],
})
check("repair excluded", summary["pit_sample_count"] == 3)
check("full refuel reference excluded", summary["pit_sample_count"] == 3)
check("ready at three", summary["prediction_ready"])
check("median loss", summary["observed_loss_median_s"] == 24.1)

fuel_summary = summarize_record({
    "pit_samples": [
        {"lane_total_s": 27.9, "stall_s": 8.0, "fuel_added_l": 9.0,
         "classification": "calibration", "service_profile_version": 1},
        {"lane_total_s": 29.7, "stall_s": 10.0, "fuel_added_l": 13.0,
         "classification": "calibration", "service_profile_version": 1},
    ],
    "normal_samples": [],
})["fuel_service"]
check("fuel service fit produced", fuel_summary["available"])
check("fuel service rate positive", fuel_summary["fuel_rate_s_per_l"] > 0)

two_sample_summary = summarize_record({
    "pit_samples": [{"lane_total_s": x, "classification": "calibration",
                     "service_profile_version": 1}
                    for x in (31.3, 27.0)],
    "normal_samples": [{"normal_segment_s": x} for x in (7.1, 7.3)],
})
check("not ready at exactly two", not two_sample_summary["prediction_ready"])
check("exactly two stays low", two_sample_summary["confidence"] == "low")

with tempfile.TemporaryDirectory() as directory:
    path = os.path.join(directory, "pit-loss.json")
    c = PitLossCalibrator(path)
    for lane in (31.3, 27.0, 33.3):
        result = c.add_pit_sample({
            "track": "Monza", "car_model": "Mercedes-AMG GT3",
            "caution_state": "green", "pit_entry_pct": .9827,
            "pit_exit_pct": .0576, "lane_total_s": lane,
            "classification": "calibration", "stall_s": 7,
            "fuel_added_l": 13, "tire_service": "unknown", "repair_s": 0,
        })
    check("no prediction without normals", not result["prediction_ready"])
    for base in (100, 200, 300):
        previous = .97
        for pct, delta in ((.99, 0), (.02, 4), (.06, 7.2)):
            found = c.observe_normal_tick(
                track="Monza", car_model="Mercedes-AMG GT3",
                caution_state="green", session_time=base + delta,
                lap_dist_pct=pct, previous_lap_dist_pct=previous,
                on_pit_road=False, on_track=True, player_track_surface=3,
                session_num=2)
            result = found or result
            previous = pct
    check("normal samples captured", result["normal_sample_count"] == 3)
    check("prediction unlocked", result["prediction_ready"])
    for actual, likely in ((6, 8), (5, 7), (7, 8)):
        result = c.record_forecast_outcome("Monza", "Mercedes-AMG GT3", "green", {
            "actual_class_position": actual, "likely_position": likely,
            "inside_best_worst": True,
        })
    check("three forecast outcomes unlock learned correction",
          result["forecast_learning"]["bias_ready"])
    check("learned bias retains actual-minus-likely sign",
          result["forecast_learning"]["likely_bias_positions"] == -2.0)
    with open(path, encoding="utf-8") as handle:
        saved = json.load(handle)
        check("atomic persistence", saved["version"] == 1)
        sample = next(iter(saved["conditions"].values()))["pit_samples"][0]
        check("sample receives normal baseline", sample["normal_segment_s"] == 7.2)
        check("sample receives observed loss", sample["observed_loss_s"] == 24.1)
    c.path = directory  # os.replace(file, existing directory) must fail open
    check("disk failure does not escape", c._save() is False)

legacy_summary = summarize_record({
    "pit_samples": [{
        "lane_total_s": 35.9, "classification": "calibration",
        "stall_s": 21, "fuel_added_l": 30.1,
    }],
    "normal_samples": [{"normal_segment_s": 7.2}],
})
check("legacy sample excluded without service evidence",
      legacy_summary["pit_sample_count"] == 0)
check("legacy sample remains visible as excluded evidence",
      legacy_summary["excluded_pit_sample_count"] == 1)

with tempfile.TemporaryDirectory() as directory:
    c = PitLossCalibrator(os.path.join(directory, "pit-loss.json"))
    c.add_pit_sample({
        "track": "Monza", "car_model": "Mercedes-AMG GT3",
        "caution_state": "green", "pit_entry_pct": .9827,
        "pit_exit_pct": .0576, "lane_total_s": 31.3,
        "classification": "calibration",
    })
    c.observe_normal_tick(
        track="Monza", car_model="Mercedes-AMG GT3",
        caution_state="green", session_time=100,
        lap_dist_pct=.99, previous_lap_dist_pct=.97,
        on_pit_road=False, on_track=True, player_track_surface=3,
        session_num=2)
    c.observe_normal_tick(
        track="Monza", car_model="Mercedes-AMG GT3",
        caution_state="green", session_time=103,
        lap_dist_pct=.02, previous_lap_dist_pct=.99,
        on_pit_road=False, on_track=False, player_track_surface=0,
        session_num=2)
    result = c.observe_normal_tick(
        track="Monza", car_model="Mercedes-AMG GT3",
        caution_state="green", session_time=107.2,
        lap_dist_pct=.06, previous_lap_dist_pct=.02,
        on_pit_road=False, on_track=True, player_track_surface=3,
        session_num=2)
    record = next(iter(c.data["conditions"].values()))
    check("off-track segment discarded", result is None)
    check("off-track segment not persisted", record["normal_samples"] == [])

with tempfile.TemporaryDirectory() as directory:
    c = PitLossCalibrator(os.path.join(directory, "pit-loss.json"))
    c.add_pit_sample({
        "track": "Monza", "car_model": "Mercedes-AMG GT3",
        "caution_state": "green", "pit_entry_pct": .9827,
        "pit_exit_pct": .0576, "lane_total_s": 31.3,
        "classification": "calibration",
    })
    c.observe_normal_tick(
        track="Monza", car_model="Mercedes-AMG GT3",
        caution_state="green", session_time=100,
        lap_dist_pct=.99, previous_lap_dist_pct=.97,
        on_pit_road=False, on_track=True, player_track_surface=3,
        session_num=2)
    c.observe_normal_tick(
        track="Monza", car_model="Mercedes-AMG GT3",
        caution_state="green", session_time=103,
        lap_dist_pct=.02, previous_lap_dist_pct=.99,
        on_pit_road=False, on_track=True, player_track_surface=None,
        session_num=2)
    result = c.observe_normal_tick(
        track="Monza", car_model="Mercedes-AMG GT3",
        caution_state="green", session_time=107.2,
        lap_dist_pct=.06, previous_lap_dist_pct=.02,
        on_pit_road=False, on_track=True, player_track_surface=3,
        session_num=2)
    record = next(iter(c.data["conditions"].values()))
    check("unknown surface discards segment", result is None)
    check("unknown surface not persisted", record["normal_samples"] == [])
print("✅ pit loss calibrator: %d checks" % passed)
