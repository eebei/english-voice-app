"""Deterministic, low-frequency proactive nearest-gap reports.

This module deliberately does not decide a battle or strategy.  It only
detects a material, sustained-enough change in an already-authoritative
nearest ahead/behind gap.  The Bridge owns the driving-workload gate and
speech queue; callers receive a small structured candidate or ``None``.
"""

from dataclasses import dataclass, field
from typing import Dict


MIN_SAMPLE_INTERVAL_S = 3.0
MIN_ABSOLUTE_CHANGE_S = 1.5
MIN_RELATIVE_CHANGE = 0.25
MIN_REPORT_GAP_S = 0.8
MAX_REPORT_GAP_S = 12.0
REPEAT_COOLDOWN_S = 20.0
INCIDENT_SILENCE_S = 8.0
POSITION_JUMP_SILENCE_S = 5.0


@dataclass
class GapCallPolicy:
    """Per-session state for bounded proactive gap reports."""

    session_key: object = None
    last_sample_at: float = 0.0
    baseline: Dict[str, dict] = field(default_factory=dict)
    last_report_at: Dict[str, float] = field(default_factory=dict)
    last_player_position: object = None
    last_incident_count: object = None
    silence_until: float = 0.0

    def reset(self, session_key=None):
        self.session_key = session_key
        self.last_sample_at = 0.0
        self.baseline.clear()
        self.last_report_at.clear()
        self.last_player_position = None
        self.last_incident_count = None
        self.silence_until = 0.0

    def suppress(self, now: float, seconds: float):
        """Invalidate old comparisons and keep quiet through an incident.

        Cooldowns are deliberately retained.  A hazard must not make the
        information channel more talkative when the car is already busy.
        """
        self.baseline.clear()
        self.last_sample_at = 0.0
        self.silence_until = max(self.silence_until, float(now) + float(seconds))

    def observe(self, session_key, now: float, ahead_s=None, behind_s=None,
                ahead_car_idx=None, behind_car_idx=None,
                player_position=None, incident_count=None):
        """Return at most one material-gap candidate, otherwise ``None``.

        A report needs two snapshots at least three seconds apart.  It is
        emitted only when the gap changed by both 25% and 1.5 seconds, remains
        within an actionable 0.8--12 second window, and is outside the
        direction-specific cooldown.  The newest value always becomes the
        next baseline, preventing a long gradual change from repeatedly
        replaying the same call.
        """
        if session_key != self.session_key:
            self.reset(session_key)

        # A contact/off-track increment invalidates the physical ordering that
        # produced the old gap.  Likewise, a multi-position jump is normally a
        # pit/incident/rejoin transition.  Do not compare either side of that
        # boundary and stay silent briefly while the field settles.
        if (self.last_incident_count is not None and incident_count is not None
                and incident_count != self.last_incident_count):
            self.suppress(now, INCIDENT_SILENCE_S)
        if (self.last_player_position is not None and player_position is not None):
            try:
                if abs(int(player_position) - int(self.last_player_position)) >= 2:
                    self.suppress(now, POSITION_JUMP_SILENCE_S)
            except (TypeError, ValueError):
                pass
        self.last_incident_count = incident_count
        self.last_player_position = player_position

        identities = {'ahead': ahead_car_idx, 'behind': behind_car_idx}
        # Identity changes are a hard comparison boundary even if the new car
        # happens to have a numerically similar gap.
        for direction, car_idx in identities.items():
            previous = self.baseline.get(direction)
            if previous is not None and previous.get('car_idx') != car_idx:
                self.baseline.pop(direction, None)

        if now < self.silence_until:
            return None
        # The first observation establishes a baseline immediately.  Only
        # subsequent observations are rate-limited.
        if self.baseline and now - self.last_sample_at < MIN_SAMPLE_INTERVAL_S:
            return None
        self.last_sample_at = now

        candidates = []
        for direction, value in (("ahead", ahead_s), ("behind", behind_s)):
            try:
                current = float(value)
            except (TypeError, ValueError):
                self.baseline.pop(direction, None)
                continue
            if current <= 0:
                self.baseline.pop(direction, None)
                continue
            previous_sample = self.baseline.get(direction)
            self.baseline[direction] = {
                'gap_s': current,
                'car_idx': identities.get(direction),
            }
            if previous_sample is None:
                continue
            previous = previous_sample['gap_s']
            change = current - previous
            material = (abs(change) >= MIN_ABSOLUTE_CHANGE_S
                        and abs(change) >= previous * MIN_RELATIVE_CHANGE)
            if not material or not (MIN_REPORT_GAP_S <= current <= MAX_REPORT_GAP_S):
                continue
            if now - self.last_report_at.get(direction, float('-inf')) < REPEAT_COOLDOWN_S:
                continue
            candidates.append({
                'direction': direction,
                'gap_s': round(current, 1),
                'change_s': round(abs(change), 1),
                'trend': 'closing' if change < 0 else 'opening',
                'car_idx': identities.get(direction),
                'observed_at': float(now),
                'player_position': player_position,
                'incident_count': incident_count,
            })
        if not candidates:
            return None
        # A closing gap is the more time-sensitive report.  Ties retain the
        # deterministic ahead-before-behind input order.
        candidates.sort(key=lambda c: (c['trend'] != 'closing', c['gap_s']))
        chosen = candidates[0]
        self.last_report_at[chosen['direction']] = now
        return chosen
