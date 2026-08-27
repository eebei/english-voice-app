"""Local 60 Hz -> clean-lap driving-style feature aggregation.

Only compact lap features leave this module. Raw samples are never persisted.
"""
import math
import statistics


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


class DrivingStyleAggregator:
    def __init__(self):
        self.session_key = None
        self.lap = None
        self.samples = []
        self.completed = []
        self.latest = None

    def reset(self, session_key=None):
        self.session_key, self.lap = session_key, None
        self.samples, self.completed, self.latest = [], [], None

    def update(self, *, session_key, lap, lap_dist_pct, speed_mps, brake,
               throttle, steering_rad, valid_clean, on_pit_road, yellow,
               traffic, fuel_l, tyre_temp_c, last_lap_time_s=None):
        if session_key != self.session_key:
            self.reset(session_key)
        if not isinstance(lap, int) or lap < 0:
            return self.latest
        if self.lap is not None and lap != self.lap:
            self._finish_lap(last_lap_time_s)
            self.samples = []
        self.lap = lap
        if all(_finite(x) for x in (lap_dist_pct, speed_mps, brake, throttle, steering_rad)):
            self.samples.append({'p': float(lap_dist_pct), 'v': float(speed_mps),
                'b': float(brake), 't': float(throttle), 's': float(steering_rad),
                'clean': valid_clean is True, 'pit': bool(on_pit_road),
                'yellow': bool(yellow), 'traffic': bool(traffic),
                'fuel': float(fuel_l) if _finite(fuel_l) else None,
                'tyre': float(tyre_temp_c) if _finite(tyre_temp_c) else None})
        return self.latest

    def _finish_lap(self, last_lap_time_s=None):
        s = self.samples
        exclusions = []
        if len(s) < 20: exclusions.append('insufficient_samples')
        if any(not x['clean'] for x in s): exclusions.append('invalid_lap')
        if any(x['pit'] for x in s): exclusions.append('pit_lap')
        if any(x['yellow'] for x in s): exclusions.append('yellow')
        if any(x['traffic'] for x in s): exclusions.append('traffic')
        if exclusions:
            self.latest = {'available': False, 'lap': self.lap,
                           'excluded_reasons': exclusions, 'source': 'iracing_local_60hz'}
            return
        braking = [x for x in s if x['b'] >= .1]
        throttle = [x for x in s if x['t'] >= .1]
        full = [x for x in s if x['t'] >= .95]
        corrections = sum(1 for a, b in zip(s, s[1:])
                          if a['s'] * b['s'] < 0 and abs(a['s'] - b['s']) >= .08)
        f = {'lap': self.lap, 'brake_start_pct': braking[0]['p'] if braking else None,
             'brake_release_pct': braking[-1]['p'] if braking else None,
             'minimum_speed_mps': min(x['v'] for x in s),
             'throttle_start_pct': throttle[0]['p'] if throttle else None,
             'full_throttle_pct': full[0]['p'] if full else None,
             'steering_corrections': corrections,
             'fuel_start_l': s[0]['fuel'], 'tyre_mean_c': statistics.fmean(
                 [x['tyre'] for x in s if x['tyre'] is not None]) if any(
                     x['tyre'] is not None for x in s) else None}
        f['lap_time_s'] = (round(float(last_lap_time_s), 3)
                           if _finite(last_lap_time_s) and last_lap_time_s > 0 else None)
        self.completed.append(f); self.completed = self.completed[-8:]
        mins = [x['minimum_speed_mps'] for x in self.completed]
        f['lap_to_lap_reproducibility'] = (round(statistics.pstdev(mins), 3)
                                            if len(mins) >= 2 else None)
        self.latest = {'available': True, 'source': 'iracing_local_60hz',
                       'confidence': 'high' if len(self.completed) >= 3 else 'medium',
                       'clean_laps': len(self.completed), 'features': f,
                       'excluded_reasons': []}
