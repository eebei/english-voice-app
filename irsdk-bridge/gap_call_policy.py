"""Deterministic, low-frequency proactive nearest-gap reports.

This module deliberately does not decide a battle or strategy.  It only
detects a material, sustained-enough change in an already-authoritative
nearest ahead/behind gap.  The Bridge owns the driving-workload gate and
speech queue; callers receive a small structured candidate or ``None``.
"""

from dataclasses import dataclass, field
from typing import Dict, Optional


MIN_SAMPLE_INTERVAL_S = 3.0
MIN_ABSOLUTE_CHANGE_S = 1.5
MIN_RELATIVE_CHANGE = 0.25
MIN_REPORT_GAP_S = 0.8
MAX_REPORT_GAP_S = 12.0
REPEAT_COOLDOWN_S = 20.0


@dataclass
class GapCallPolicy:
    """Per-session state for bounded proactive gap reports."""

    session_key: object = None
    last_sample_at: float = 0.0
    baseline: Dict[str, float] = field(default_factory=dict)
    last_report_at: Dict[str, float] = field(default_factory=dict)

    def reset(self, session_key=None):
        self.session_key = session_key
        self.last_sample_at = 0.0
        self.baseline.clear()
        self.last_report_at.clear()

    def observe(self, session_key, now: float, ahead_s=None, behind_s=None):
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
            previous = self.baseline.get(direction)
            self.baseline[direction] = current
            if previous is None:
                continue
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
            })
        if not candidates:
            return None
        # A closing gap is the more time-sensitive report.  Ties retain the
        # deterministic ahead-before-behind input order.
        candidates.sort(key=lambda c: (c['trend'] != 'closing', c['gap_s']))
        chosen = candidates[0]
        self.last_report_at[chosen['direction']] = now
        return chosen
