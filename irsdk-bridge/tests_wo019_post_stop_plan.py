#!/usr/bin/env python3
"""WO-019: the plan after a pit visit comes only from the post-stop measured state.

Real poll replay (replay_harness) of the synthetic Road Atlanta early stop (L15) with a given
fuel amount; values are asserted from the real DECISION/BOX output, never injected.
  - 16.79 L (handoff fact, enough to finish): no further Plan, no BOX
  - 2.0 L / 7.1 L (synthetic short): one post-stop Plan from `recalc:post_service`, whose
    target AND frozen set are accepted by the BOX authority -> a real BOX broadcast
  - 2.0 L then a 0 L black-flag visit: the next Plan is recalculated from the lap-16 state,
    not re-issued from the lap-15 options
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bridge  # noqa: E402
import fixed_target_authority as fta  # noqa: E402
import replay_harness as rh  # noqa: E402
import strategy_options as so  # noqa: E402
import tests_wo001_road_atlanta_fixture as road  # noqa: E402


def frames(fuel_added, penalty=False):
    out, fuel, t, lap = road.clean_laps(14, start_fuel=60.0)
    pit1, fuel, t, _ = road.pit_visit(lap=15, fuel_before=fuel, fuel_added=fuel_added, start_time=t)
    out += pit1
    start = 15
    if penalty:
        more, fuel, t, lap = road.clean_laps(1, start_lap=15, start_fuel=fuel, start_time=t)
        out += more
        pit2, fuel, t, _ = road.pit_visit(lap=16, fuel_before=fuel, fuel_added=0.0, start_time=t, black_flag=True)
        out += pit2
        start = 16
    more, fuel, t, lap = road.clean_laps(road.LAPS_TOTAL - start, start_lap=start, start_fuel=fuel, start_time=t)
    return out + more


_CACHE = {}


def run(fuel_added, penalty=False):
    key = (fuel_added, penalty)
    if key not in _CACHE:
        _CACHE[key] = rh.replay(frames(fuel_added, penalty), session_info=road.ROAD_ATLANTA_SESSION_INFO)
    return _CACHE[key]


def decisions(r):
    return [json.loads(l.split('DECISION opened: ', 1)[1]) for l in r.logs_containing('DECISION opened: ')]


def post(r):
    return [d for d in decisions(r) if ':recalc:post_service:' in d['decision_id']]


class PostStopPlan(unittest.TestCase):
    def test_sufficient_fuel_no_further_plan_or_box(self):
        r = run(16.79)
        self.assertEqual(len(decisions(r)), 1)
        self.assertEqual(post(r), [])
        self.assertEqual(r.by_trigger('strategy_plan_box_call'), [])

    def _fresh_box(self, litres):
        r = run(litres)
        p = post(r)
        self.assertEqual(len(p), 1, decisions(r))
        snap = p[0]['options_snapshot']
        self.assertEqual((snap['current_lap'], round(snap['fuel_level_l'], 2)), (15, round(19.4 + litres, 2)))
        box = r.by_trigger('strategy_plan_box_call')
        self.assertEqual(len(box), 1)
        self.assertEqual(box[0]['decision_id'], p[0]['decision_id'])
        self.assertIn('Set %d liters' % p[0]['set_fuel_l'], box[0]['message'])
        return r, p[0]

    def test_short_2l_fresh_plan_and_box(self):
        r, p = self._fresh_box(2.0)
        self.assertNotEqual(p['add_fuel_l'], 10.1, 'the pre-stop amount is never reused')

    def test_short_7l_frozen_amount_aligned_with_authority(self):
        r, p = self._fresh_box(7.1)
        aligned = [json.loads(l.split(': ', 1)[1]) for l in r.logs_containing('POST SERVICE TARGET ALIGNED:')]
        self.assertTrue(aligned)
        self.assertGreater(aligned[0]['set_fuel_l'], aligned[0]['from_set_fuel_l'],
                           'builder set raised to the authority-accepted frozen amount')

    def test_penalty_after_short_stop_recalculates_from_lap16_state(self):
        r = run(2.0, penalty=True)
        p = post(r)
        self.assertEqual(len(p), 2, [d['decision_id'] for d in decisions(r)])
        second = p[1]['options_snapshot']
        self.assertTrue(p[1]['evidence_snapshot_id'].startswith('recalc:post_service:0:16'))
        self.assertEqual((second['current_lap'], round(second['fuel_level_l'], 2)), (16, 18.5))
        self.assertTrue(all(':recalc:post_service:' in d['decision_id'] or ':initial:' in d['decision_id']
                            for d in decisions(r)), 'no Plan is re-issued from a pre-visit recalc snapshot')
        box = r.by_trigger('strategy_plan_box_call')
        self.assertEqual([b['decision_id'] for b in box], [p[1]['decision_id']])


class AlignUnit(unittest.TestCase):
    def inputs(self, *, lap=15, q=0.99, fuel=26.5):
        return fta.build_inputs(race_instance_id='sub:1', session_num=0, source_frame_sequence=10,
                                session_time_s=100.0, current_lap=lap, total_laps=25, lap_dist_pct=q,
                                fuel_level_l=fuel, avg_fuel_per_lap_l=2.9, clean_laps_sampled=5,
                                effective_capacity_l=60.0, driver_pit_sequence=1, is_lap_race=True)

    def options(self, target, set_l, snap='recalc:post_service:0:15'):
        return {'snapshot_id': snap, 'plan_a': {'target_lap': target, 'add_fuel_l': float(set_l), 'set_fuel_l': set_l}}

    def test_reachable_target_with_insufficient_frozen_set_is_raised(self):
        inp = self.inputs()
        self.assertTrue(fta.evaluate(inp, 23)['available'])
        self.assertFalse(fta.evaluate(inp, 23, frozen_set=3)['available'])
        out, detail = bridge.align_post_service_target(self.options(23, 3), inp, current_lap=15)
        self.assertEqual((out['plan_a']['target_lap'], out['plan_a']['set_fuel_l']), (23, fta.evaluate(inp, 23)['set_fuel_l']))
        self.assertTrue(fta.evaluate(inp, 23, frozen_set=out['plan_a']['set_fuel_l'])['available'])
        self.assertEqual(detail['from_set_fuel_l'], 3)

    def test_already_valid_candidate_unchanged_and_other_snapshots_untouched(self):
        inp = self.inputs()
        need = fta.evaluate(inp, 23)['set_fuel_l']
        opts = self.options(23, need)
        self.assertIs(bridge.align_post_service_target(opts, inp, current_lap=15)[0], opts)
        other = self.options(23, 3, snap='recalc:rival_pit_or_rejoin_shift:0:15')
        self.assertIs(bridge.align_post_service_target(other, inp, current_lap=15)[0], other)

    def test_unreachable_target_moves_earlier_never_later(self):
        inp = self.inputs(lap=16, q=0.2, fuel=18.5)
        out, detail = bridge.align_post_service_target(self.options(22, 9), inp, current_lap=16)
        self.assertLess(out['plan_a']['target_lap'], 22)
        self.assertTrue(fta.evaluate(inp, out['plan_a']['target_lap'], frozen_set=out['plan_a']['set_fuel_l'])['available'])


class OpeningAlignUnit(unittest.TestCase):
    """WO-020 P0: the real opening builder output, aligned from one authority frame."""

    def _frame(self, fuel):
        inp = fta.build_inputs(race_instance_id='sub:1', session_num=0, source_frame_sequence=16,
                               session_time_s=115.0, current_lap=5, total_laps=25, lap_dist_pct=0.01,
                               fuel_level_l=fuel, avg_fuel_per_lap_l=2.9, clean_laps_sampled=3,
                               effective_capacity_l=60.0, driver_pit_sequence=0, is_lap_race=True)
        opts = so.build_initial_plans(snapshot_id='initial:0:115.0', current_lap=5, fuel_level_l=fuel,
                                      avg_fuel_per_lap_l=2.9, clean_laps_sampled=3,
                                      crossings_to_finish=inp['crossings_to_finish'], effective_capacity_l=60.0)
        return inp, opts

    def test_builder_target_rejected_then_aligned_to_authority(self):
        inp, opts = self._frame(48.4)
        a = opts['plan_a']
        raw = fta.evaluate(inp, a['target_lap'], frozen_set=a['set_fuel_l'])
        self.assertFalse(raw['available'], 'premise: the raw opening Plan A is not executable')
        self.assertIs(bridge.align_post_service_target(opts, inp, current_lap=5)[0], opts,
                      'the decision-commit (post-service) call never re-targets an opening Plan')
        out, detail = bridge.align_post_service_target(opts, inp, current_lap=5, snapshot_prefix='initial:')
        b = out['plan_a']
        self.assertLessEqual(b['target_lap'], a['target_lap'], 'never moved later')
        self.assertGreater(b['target_lap'], 5)
        self.assertTrue(fta.evaluate(inp, b['target_lap'], frozen_set=b['set_fuel_l'])['available'])
        self.assertEqual(b['set_fuel_l'], fta.evaluate(inp, b['target_lap'])['set_fuel_l'])
        self.assertEqual(out['plan_b'], opts['plan_b'], 'Plan B untouched')
        self.assertEqual(out.get('plan_c'), opts.get('plan_c'), 'Plan C untouched')
        self.assertEqual((detail['from_target_lap'], detail['from_set_fuel_l']), (a['target_lap'], a['set_fuel_l']))

    def test_unprovable_frame_keeps_builder_output(self):
        inp, opts = self._frame(48.4)
        bad = dict(inp, clean_laps_sampled=2)
        self.assertIs(bridge.align_post_service_target(opts, bad, current_lap=5, snapshot_prefix='initial:')[0], opts)
        self.assertIs(bridge.align_post_service_target(opts, None, current_lap=5, snapshot_prefix='initial:')[0], opts)


if __name__ == '__main__':
    unittest.main(verbosity=2)
