"""Bridge-owned observed pit-loss calibration."""
import json
import os
import statistics
from datetime import datetime, timezone

CALCULATOR_VERSION = 1
SERVICE_PROFILE_VERSION = 1
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


def _fuel_service_summary(record):
    """Estimate stationary fuel-service time without assuming tyre status.

    The driver-facing pit loss is IN limit line -> OUT limit line.  Fuel flow
    itself happens while stationary, therefore this diagnostic fit uses
    ``stall_s``.  It is not strategy authority until tyre-service telemetry is
    explicitly verified.
    """
    samples = []
    for sample in (record or {}).get("pit_samples", []):
        litres = _num(sample.get("fuel_added_l"))
        stall_s = _num(sample.get("stall_s"))
        repair_s = _num(sample.get("repair_s")) or 0.0
        if (litres is None or litres < 0.2 or stall_s is None or stall_s < 1.0
                or repair_s > 0.5
                or sample.get("classification") in ("repair", "long_stop", "drive_through")):
            continue
        samples.append((litres, stall_s))
    if len(samples) < 2:
        return {
            "available": False,
            "sample_count": len(samples),
            "required_sample_count": 2,
            "remaining_sample_count": max(0, 2 - len(samples)),
            "reason": "insufficient_fuel_service_samples",
        }

    mean_l = sum(litres for litres, _ in samples) / len(samples)
    mean_s = sum(stall_s for _, stall_s in samples) / len(samples)
    denominator = sum((litres - mean_l) ** 2 for litres, _ in samples)
    if denominator <= 0.0001:
        return {
            "available": False,
            "sample_count": len(samples),
            "required_sample_count": 2,
            "remaining_sample_count": 0,
            "reason": "fuel_amounts_not_varied",
        }
    rate = sum((litres - mean_l) * (stall_s - mean_s)
               for litres, stall_s in samples) / denominator
    fixed_s = mean_s - rate * mean_l
    # A negative or implausibly high coefficient signals another unobserved
    # service (normally tyres).  Retain the samples but never invent a number.
    if rate <= 0.0 or rate > 5.0 or fixed_s < -1.0:
        return {
            "available": False,
            "sample_count": len(samples),
            "required_sample_count": 2,
            "remaining_sample_count": 0,
            "reason": "service_mix_not_clean",
        }
    residuals = [abs(stall_s - (fixed_s + rate * litres))
                 for litres, stall_s in samples]
    return {
        "available": True,
        "sample_count": len(samples),
        "fuel_rate_s_per_l": round(rate, 3),
        "fixed_stall_s": round(max(0.0, fixed_s), 3),
        "median_abs_error_s": _median(residuals),
        "service_mix": "tyre_status_unverified",
    }


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
            if s.get("classification") == "calibration"
            and not s.get("reference_only", False)
            and s.get("service_profile_version") == SERVICE_PROFILE_VERSION]
    normals = record.get("normal_samples", [])
    lane = [s.get("lane_total_s") for s in pits]
    normal = [s.get("normal_segment_s") for s in normals]
    normal_median = _median(normal)
    losses = ([round(float(v) - normal_median, 3) for v in lane
               if _num(v) is not None] if normal_median is not None else [])
    usable = min(len(pits), len(normals))
    return {
        "pit_sample_count": len(pits),
        "excluded_pit_sample_count": max(
            0, len(record.get("pit_samples", [])) - len(pits)),
        "normal_sample_count": len(normals),
        "usable_sample_count": usable,
        "confidence": "medium" if usable >= 3 else "low",
        "prediction_ready": usable >= 3,
        "lane_total_median_s": _median(lane),
        # The driver-facing Phase C calculation must use the directly
        # observed IN-limit-line -> OUT-limit-line time.  ``observed_loss``
        # is a diagnostic comparison against a moving on-track baseline and
        # must never become the source of a radio prediction.
        "lane_total_q1_s": _quartile(lane, 0.25),
        "lane_total_q3_s": _quartile(lane, 0.75),
        "normal_segment_median_s": normal_median,
        "observed_loss_median_s": _median(losses),
        "observed_loss_q1_s": _quartile(losses, 0.25),
        "observed_loss_q3_s": _quartile(losses, 0.75),
        "fuel_service": _fuel_service_summary(record),
        "calculator_version": CALCULATOR_VERSION,
    }


def _reconcile_observed_losses(record):
    """Attach the current same-segment baseline without inventing one early."""
    normal_median = _median(
        s.get("normal_segment_s") for s in record.get("normal_samples", []))
    for sample in record.get("pit_samples", []):
        if (sample.get("classification") != "calibration"
                or sample.get("reference_only", False)
                or sample.get("service_profile_version")
                    != SERVICE_PROFILE_VERSION
                or normal_median is None):
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
            "service_profile_version": SERVICE_PROFILE_VERSION,
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
