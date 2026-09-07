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

    total_ok, timed, remaining = bridge.classify_race_clock(False, 0, 17, 7200.0)
    check("finite Practice lap target is not a finish authority",
          (total_ok, timed, remaining) == (False, False, None))

    total_ok, timed, remaining = bridge.classify_race_clock(True, 1, 20, 1800.0)
    check("lap-count race first poll", (total_ok, timed, remaining) == (True, False, 19))

    total_ok, timed, remaining = bridge.classify_race_clock(True, 1, 32767, 3599.0)
    check("timed race first poll", (total_ok, timed, remaining) == (False, True, None))

    # ★Codex P1（2026-09-07 第4回差戻し）：`laps_total > lap + 1` という旧margin条件は
    #   30周レースの29/30周目で `laps_total_ok` を False へ反転させ、
    #   Final Lap・残周回・pit Planの上限判定を無認可のまま時間制経路へ誤配線していた。
    #   終盤（total と同じか、その1周前）でも失効しないことを固定する。
    total_ok, timed, remaining = bridge.classify_race_clock(True, 28, 30, 1800.0)
    check("30-lap race, lap 28: total authority holds (2 to go)",
          (total_ok, timed, remaining) == (True, False, 2))
    total_ok, timed, remaining = bridge.classify_race_clock(True, 29, 30, 1800.0)
    check("30-lap race, lap 29: total authority holds through the penultimate lap (1 to go)",
          (total_ok, timed, remaining) == (True, False, 1))
    total_ok, timed, remaining = bridge.classify_race_clock(True, 30, 30, 1800.0)
    check("30-lap race, lap 30 (the final lap): total authority holds (0 to go)",
          (total_ok, timed, remaining) == (True, False, 0))

    # センチネル（32767等）は終盤の緩和後も timed/unknown のまま：<3000 の上限が別途弾く。
    total_ok, timed, remaining = bridge.classify_race_clock(True, 29, 32767, 1800.0)
    check("sentinel laps_total stays rejected even near a plausible lap number",
          (total_ok, timed, remaining) == (False, True, None))

    formation_plan = bridge.derive_race_plan(True, {'session_time': '20 min'}, 32767, -1.0)
    check("known timed format survives formation without live remaining clock",
          formation_plan == {'kind': 'timed', 'configured_duration_s': 1200.0})
    seconds_plan = bridge.derive_race_plan(True, {'session_time': '1200 sec'}, 32767, -1.0)
    check("SessionInfo seconds format survives formation without live remaining clock",
          seconds_plan == {'kind': 'timed', 'configured_duration_s': 1200.0})

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
