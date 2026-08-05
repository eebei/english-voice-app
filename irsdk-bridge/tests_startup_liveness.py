#!/usr/bin/env python3
"""Build 244 regression: first telemetry poll must have timing authority."""

import ast
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import bridge  # noqa: E402


def check(label, condition):
    if not condition:
        raise AssertionError(label)
    print("PASS", label)


def assigned_names_before_first_loop():
    tree = ast.parse((ROOT / "bridge.py").read_text(encoding="utf-8"))
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "poll_iracing")
    first_loop = next(i for i, n in enumerate(fn.body) if isinstance(n, ast.While))
    names = set()
    for node in fn.body[:first_loop]:
        for child in ast.walk(node):
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
                names.add(child.id)
    return names


def main():
    total_ok, timed, remaining = bridge.classify_race_clock(False, 0, 32767, 1800.0)
    check("Practice first poll is safe", (total_ok, timed, remaining) == (False, False, None))

    total_ok, timed, remaining = bridge.classify_race_clock(True, 1, 20, 1800.0)
    check("lap-count race first poll", (total_ok, timed, remaining) == (True, False, 19))

    total_ok, timed, remaining = bridge.classify_race_clock(True, 1, 32767, 3599.0)
    check("timed race first poll", (total_ok, timed, remaining) == (False, True, None))

    initialized = assigned_names_before_first_loop()
    required = {"_is_time_race", "_legacy_laps_remaining", "_timed_final_eval", "_milestone_laps"}
    check("all snapshot variables initialized before polling", required <= initialized)

    source = (ROOT / "bridge.py").read_text(encoding="utf-8")
    poll = source[source.index("def poll_iracing():"):source.index("def poll_joystick():")]
    check("per-poll classification precedes telemetry_live",
          poll.index("classify_race_clock(") < poll.index("'type': 'telemetry_live'"))
    check("dead telemetry thread is monitored", "monitor_poll_thread" in source)
    allowed = source[source.index("ACTIVITY_ALLOWED_META_TYPES"):source.index("def _activity_allows_broadcast")]
    check("telemetry failure bypasses activity gate", "'telemetry_error'" in allowed)
    check("live telemetry bypasses inactive-driver gate", "'telemetry_live'" in allowed)


if __name__ == "__main__":
    main()
