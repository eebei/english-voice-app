#!/usr/bin/env python3
"""Build 245: faster-class calls require measured closing motion."""

from bridge import evaluate_multiclass_approach


def check(label, condition):
    if not condition:
        raise AssertionError(label)
    print('PASS', label)


def main():
    approaching, state, reason = evaluate_multiclass_approach(None, 4.9, 10.0)
    check('first sighting only warms history', not approaching and reason == 'warming')

    approaching, state, reason = evaluate_multiclass_approach(state, 4.5, 10.6)
    check('shrinking behind gap is approaching', approaching and reason == 'closing')

    approaching, state, reason = evaluate_multiclass_approach((1.0, 20.0), 1.4, 20.6)
    check('slowing or stopped car is not approaching', not approaching and reason == 'not_closing')

    approaching, state, reason = evaluate_multiclass_approach((0.4, 30.0), 0.1, 30.6)
    check('zero-gap pass jitter is suppressed', not approaching and reason == 'crossing_or_jitter')

    approaching, state, reason = evaluate_multiclass_approach((3.0, 40.0), 2.95, 40.2)
    check('single-frame noise cannot fire', not approaching and reason == 'warming')

    approaching, state, reason = evaluate_multiclass_approach((5.0, 50.0), 3.0, 53.0)
    check('stale sample cannot prove approach', not approaching and reason == 'stale_previous')


if __name__ == '__main__':
    main()
