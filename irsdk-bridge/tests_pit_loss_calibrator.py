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
    "pit_samples": [{"lane_total_s": x, "classification": "calibration"}
                    for x in (31.3, 27.0, 33.3)]
                   + [{"lane_total_s": 90, "classification": "repair"}],
    "normal_samples": [{"normal_segment_s": x} for x in (7.1, 7.3, 7.2)],
})
check("repair excluded", summary["pit_sample_count"] == 3)
check("ready at three", summary["prediction_ready"])
check("median loss", summary["observed_loss_median_s"] == 24.1)

two_sample_summary = summarize_record({
    "pit_samples": [{"lane_total_s": x, "classification": "calibration"}
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
    with open(path, encoding="utf-8") as handle:
        saved = json.load(handle)
        check("atomic persistence", saved["version"] == 1)
        sample = next(iter(saved["conditions"].values()))["pit_samples"][0]
        check("sample receives normal baseline", sample["normal_segment_s"] == 7.2)
        check("sample receives observed loss", sample["observed_loss_s"] == 24.1)
    c.path = directory  # os.replace(file, existing directory) must fail open
    check("disk failure does not escape", c._save() is False)

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
