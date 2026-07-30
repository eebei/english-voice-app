"""Bridge-owned observed pit-loss calibration."""
import json
import os
import statistics
from datetime import datetime, timezone

CALCULATOR_VERSION = 1
MAX_SAMPLES = 40


def _num(value):
    try:
        value = float(value)
        return value if value == value else None
    except (TypeError, ValueError):
        return None


def _median(values):
    values = [_num(v) for v in values]
    values = [v for v in values if v is not None]
    return round(statistics.median(values), 3) if values else None


def _quartile(values, fraction):
    values = sorted(v for v in (_num(x) for x in values) if v is not None)
    if not values:
        return None
    if len(values) == 1:
        return round(values[0], 3)
    pos = (len(values) - 1) * fraction
    lo = int(pos)
    hi = min(lo + 1, len(values) - 1)
    return round(values[lo] + (values[hi] - values[lo]) * (pos - lo), 3)


def crossed_forward(previous_pct, current_pct, target_pct, max_step=0.08):
    """Reject reverse movement/teleports; accept a forward crossing including S/F wrap."""
    previous_pct, current_pct, target_pct = (
        _num(previous_pct), _num(current_pct), _num(target_pct))
    if previous_pct is None or current_pct is None or target_pct is None:
        return False
    step = (current_pct - previous_pct) % 1.0
    target = (target_pct - previous_pct) % 1.0
    return 0.0 < step <= max_step and 0.0 < target <= step


def condition_key(track, car_model, caution_state="green"):
    return "|".join(str(x or "unknown").strip().lower()
                    for x in (track, car_model, caution_state))


def summarize_record(record):
    record = record or {}
    pits = [s for s in record.get("pit_samples", [])
            if s.get("classification") == "calibration"]
    normals = record.get("normal_samples", [])
    lane = [s.get("lane_total_s") for s in pits]
    normal = [s.get("normal_segment_s") for s in normals]
    normal_median = _median(normal)
    losses = ([round(float(v) - normal_median, 3) for v in lane
               if _num(v) is not None] if normal_median is not None else [])
    usable = min(len(pits), len(normals))
    return {
        "pit_sample_count": len(pits),
        "normal_sample_count": len(normals),
        "usable_sample_count": usable,
        "confidence": "medium" if usable >= 3 else "low",
        "prediction_ready": usable >= 3,
        "lane_total_median_s": _median(lane),
        "normal_segment_median_s": normal_median,
        "observed_loss_median_s": _median(losses),
        "observed_loss_q1_s": _quartile(losses, 0.25),
        "observed_loss_q3_s": _quartile(losses, 0.75),
        "calculator_version": CALCULATOR_VERSION,
    }


def _reconcile_observed_losses(record):
    """Attach the current same-segment baseline without inventing one early."""
    normal_median = _median(
        s.get("normal_segment_s") for s in record.get("normal_samples", []))
    for sample in record.get("pit_samples", []):
        if sample.get("classification") != "calibration" or normal_median is None:
            sample["normal_segment_s"] = None
            sample["observed_loss_s"] = None
            continue
        sample["normal_segment_s"] = normal_median
        sample["observed_loss_s"] = round(
            float(sample["lane_total_s"]) - normal_median, 3)


class PitLossCalibrator:
    def __init__(self, path):
        self.path = path
        self.data = {"version": CALCULATOR_VERSION, "conditions": {}}
        self._normal_start = None
        try:
            with open(path, "r", encoding="utf-8") as handle:
                loaded = json.load(handle)
            if isinstance(loaded.get("conditions"), dict):
                self.data = loaded
        except Exception:
            pass

    def _save(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            temporary = self.path + ".tmp"
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(self.data, handle, ensure_ascii=False, indent=2)
            os.replace(temporary, self.path)
            return True
        except Exception:
            # Telemetry and radio must keep running even if the local disk is
            # read-only/full. The in-memory sample remains usable this session.
            return False

    def reset_session(self):
        self._normal_start = None

    def get_summary(self, track, car_model, caution_state="green"):
        """Return the persisted condition summary plus learned coordinates."""
        record = self.data.get("conditions", {}).get(
            condition_key(track, car_model, caution_state))
        if not isinstance(record, dict):
            return None
        summary = summarize_record(record)
        summary["pit_entry_pct"] = _num(record.get("pit_entry_pct"))
        summary["pit_exit_pct"] = _num(record.get("pit_exit_pct"))
        return summary

    def _record(self, track, car_model, caution):
        key = condition_key(track, car_model, caution)
        return self.data["conditions"].setdefault(key, {
            "track": track, "car_model": car_model, "caution_state": caution,
            "pit_entry_pct": None, "pit_exit_pct": None,
            "pit_samples": [], "normal_samples": [],
        })

    def add_pit_sample(self, sample):
        track, car = sample.get("track"), sample.get("car_model")
        caution = sample.get("caution_state") or "unknown"
        entry, exit_pct, lane = (_num(sample.get(k)) for k in
                                 ("pit_entry_pct", "pit_exit_pct", "lane_total_s"))
        if not track or not car or entry is None or exit_pct is None or not lane or not 5 < lane < 300:
            return None
        record = self._record(track, car, caution)
        record["pit_entry_pct"], record["pit_exit_pct"] = (
            round(entry % 1.0, 6), round(exit_pct % 1.0, 6))
        normalized = dict(sample)
        normalized.update({
            "pit_entry_pct": record["pit_entry_pct"],
            "pit_exit_pct": record["pit_exit_pct"],
            "lane_total_s": round(lane, 3),
            "timestamp": sample.get("timestamp") or datetime.now(timezone.utc).isoformat(),
            "calculator_version": CALCULATOR_VERSION,
        })
        record["pit_samples"] = (record["pit_samples"] + [normalized])[-MAX_SAMPLES:]
        _reconcile_observed_losses(record)
        self._save()
        return summarize_record(record)

    def observe_normal_tick(self, *, track, car_model, caution_state, session_time,
                            lap_dist_pct, previous_lap_dist_pct, on_pit_road,
                            on_track, player_track_surface, session_num):
        if not track or not car_model:
            self._normal_start = None
            return None
        caution = caution_state or "unknown"
        record = self._record(track, car_model, caution)
        entry, exit_pct, now = (record.get("pit_entry_pct"),
                                record.get("pit_exit_pct"), _num(session_time))
        if entry is None or exit_pct is None or now is None:
            return None
        # Calibration is fail-closed: IsOnTrack alone may not distinguish every
        # four-wheels-off excursion, so require the SDK surface enum's OnTrack
        # value (3) as independent confirmation.
        if on_pit_road or not on_track or player_track_surface != 3:
            self._normal_start = None
            return None
        key = condition_key(track, car_model, caution)
        if crossed_forward(previous_lap_dist_pct, lap_dist_pct, entry):
            self._normal_start = {"time": now, "session_num": session_num, "key": key}
        start = self._normal_start
        if (start and start["key"] == key and start["session_num"] == session_num
                and crossed_forward(previous_lap_dist_pct, lap_dist_pct, exit_pct)):
            elapsed = now - start["time"]
            self._normal_start = None
            if not 1.0 < elapsed < 180.0:
                return None
            record["normal_samples"] = (record["normal_samples"] + [{
                "normal_segment_s": round(elapsed, 3),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "session_num": session_num,
                "calculator_version": CALCULATOR_VERSION,
            }])[-MAX_SAMPLES:]
            _reconcile_observed_losses(record)
            self._save()
            return summarize_record(record)
        return None
