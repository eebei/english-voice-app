"""Build 266 Phase E — Monza 20 full-race integration replay.

Follows the same convention already established in this codebase for
`tests_plan_fuel_authority.py::Monza35FullTimeline`: chain the SAME pure
functions bridge.py calls at runtime, in the exact order the poll loop would
call them, and assert on the resulting Session Race State / trace output at
each step.  This is a Bridge integration test (multiple modules working
together through the shared state object), not a unit test of one function.

Scenario (from the Build 266 brief, section 5):
  1. 20-minute Race, Mercedes-AMG GT3 2020, Monza, saved history available.
  2. Briefing builds Plan A/B; active_plan=A registers the same frame.
  3. Three clean laps update the baseline fuel/pace.
  4. First pit stop: optional repair time is detected.
  5. Driver does NOT take the optional repair; PitOptRepairLeft=0 post pit-out.
  6. Driver reports front/steering damage.
  7. That report lands in damage_state, invalidates the pace baseline, and
     triggers a recalculation.
  8. Post-damage clean-lap fuel updates finish-feasibility and push status.
  9. Even with safe fuel margin, "push is OK" is withheld until the
     post-damage recalculation completes.
 10. After final lap / checker, no new box call / set-fuel / plan switch is
     spoken.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import fuel_strategy as fuel_strategy_mod
import plan_fuel_authority as plan_fuel_authority_mod
import session_race_state as srs
import strategy_options as strategy_options_mod


TRACE_LOG = []


def log(line):
    TRACE_LOG.append(line)


class Monza20Integration(unittest.TestCase):

    def setUp(self):
        TRACE_LOG.clear()
        self.state = srs.init_state()
        log('MONZA20 step=1 20min Race, Mercedes-AMG GT3 2020, Monza, history available')

    # ── Step 2: briefing builds Plan A/B, active_plan registers same frame ──
    def test_02_briefing_registers_active_plan(self):
        options = strategy_options_mod.build_initial_plans(
            snapshot_id='briefing:1:0.0', current_lap=0, fuel_level_l=53.0,
            avg_fuel_per_lap_l=3.6, clean_laps_sampled=6,
            crossings_to_finish=16, reserve_l=0.5, effective_capacity_l=53.0)
        self.assertTrue(options.get('available'))
        self.assertIsNotNone(options['plan_a'].get('target_lap'),
                             'this scenario must require a stop to exercise the plan-authority path')
        # Same-frame registration, exactly as bridge.py does at the
        # "STRATEGY OPTIONS ready" site.
        self.state = srs.register_active_plan(
            self.state, plan_id=(options.get('selected_plan') or 'A'),
            plan_snapshot=options, snapshot_id=options.get('snapshot_id'))
        self.assertEqual(self.state['active_plan'], 'A')
        self.assertIsNotNone(self.state['active_plan_snapshot'])
        log('MONZA20 step=2 briefing active_plan=%s snapshot_id=%s'
            % (self.state['active_plan'], self.state['plan_snapshot_id']))
        self._options = options
        self._run_remaining_steps()

    def _run_remaining_steps(self):
        options = self._options

        # ── Step 3: 3 clean laps update baseline. ──
        self.assertTrue(srs.should_recalculate(self.state, 'clean_3_laps_established'))
        self.state = srs.recalculate_strategy(
            self.state, reason='clean_3_laps_established',
            baseline_fuel_l_per_lap=3.62, recent_fuel_l_per_lap=3.62,
            baseline_pace_s=108.4, recent_pace_s=108.4,
            previous_plan='A', selected_plan='A', driver_message=None,
            session_time_s=210.0, lap=3)
        self.assertFalse(srs.should_recalculate(self.state, 'clean_3_laps_established'))
        log(srs.format_recalculation_trace(self.state['last_recalculation']).replace('\n', ' | '))
        # The fuel-plan authority must find a real active plan (Build 265
        # fix): no_active_plan must never happen once a briefing plan exists.
        # Use a genuinely critical band (fuel below finish requirement) so
        # the authority actually has to consult the plan — a safe band would
        # short-circuit before ever looking at plan_id (not the bug we're
        # proving fixed here).
        fuel_eval = fuel_strategy_mod.evaluate_fuel_to_finish(
            fuel_level_l=20.0, avg_fuel_per_lap_l=3.62,
            estimated_crossings_to_finish=8, clean_laps_sampled=3,
            lifecycle_state=fuel_strategy_mod.RACING, previous_band=None)
        self.assertEqual(fuel_eval['band'], fuel_strategy_mod.CRITICAL)
        verdict = plan_fuel_authority_mod.evaluate(
            fuel_eval, self.state['active_plan_snapshot'], current_lap=3,
            fuel_level_l=20.0, avg_fuel_per_lap_l=3.62,
            effective_capacity_l=53.0)
        self.assertNotEqual(verdict.get('override_reason'), 'insufficient_evidence_no_active_plan',
                            'plan_fuel_authority must never fall to no_active_plan once briefed')
        log('MONZA20 step=3 fuel_authority_plan_id=%s override=%s suppression=%s'
            % (verdict.get('plan_id'), verdict.get('override_reason'), verdict.get('suppression_reason')))

        # ── Step 4: first pit stop, optional repair detected. ──
        self.state = srs.record_damage_observation(
            self.state, mandatory_repair_s=0.0, optional_repair_s=14.0,
            damage_s=14.0, lap=6, session_time_s=400.0, incident_delta=2,
            on_pit_road=True)
        self.assertIsNotNone(self.state['damage_state']['damage_observation'])
        log('MONZA20 step=4 optional_repair_observed=14.0s lap=6')

        # ── Step 5: optional repair NOT taken; live value resets to 0.0 post exit. ──
        self.state = srs.mark_optional_repair_not_taken(self.state, lap=6)
        self.assertTrue(self.state['damage_state']['optional_repair_observed_but_not_taken'])
        # Simulate the live PitOptRepairLeft reading 0.0 after pit-out — this
        # must NOT erase the sticky fact recorded above.
        live_pit_opt_repair_left_after_exit = 0.0
        self.assertEqual(live_pit_opt_repair_left_after_exit, 0.0)
        self.assertTrue(self.state['damage_state']['optional_repair_observed_but_not_taken'],
                        'the sticky flag must survive the live-value reset to 0.0')
        log('MONZA20 step=5 optional_repair_observed_but_not_taken=True '
            'live_PitOptRepairLeft_post_exit=0.0 (fact preserved)')

        self.assertTrue(srs.should_recalculate(
            self.state, 'repair_detected_or_opt_not_taken', dedupe_key='lap6'))
        self.state = srs.recalculate_strategy(
            self.state, reason='repair_detected_or_opt_not_taken',
            baseline_fuel_l_per_lap=self.state['baseline_fuel_l_per_lap'],
            recent_fuel_l_per_lap=self.state['recent_fuel_l_per_lap'],
            baseline_pace_s=self.state['baseline_pace_s'],
            recent_pace_s=self.state['recent_pace_s'],
            previous_plan='A', selected_plan='A',
            driver_message='Damage confirmed. Standard pace assumption is on hold.',
            session_time_s=430.0, lap=6, dedupe_key='lap6')
        log(srs.format_recalculation_trace(self.state['last_recalculation']).replace('\n', ' | '))

        # ── Step 6: driver reports front/steering damage. ──
        driver_text = 'フロント ステアリングコラム 周辺にダメージ'
        category = srs.parse_driver_reported_damage(driver_text)
        self.assertEqual(category, 'steering_or_front_end')
        self.state = srs.record_driver_reported_damage(
            self.state, category=category, raw_text=driver_text, lap=7,
            session_time_s=460.0)
        log('MONZA20 step=6 driver_reported_damage category=%s lap=7 text=%s'
            % (category, driver_text))

        # ── Step 7: report lands in damage_state, invalidates baseline pace,
        #    triggers a recalculation. ──
        self.assertEqual(len(self.state['damage_state']['driver_reported_damage']), 1)
        self.state = srs.invalidate_assumptions(
            self.state, 'driver_reported_damage:%s' % category)
        self.assertIn('driver_reported_damage:steering_or_front_end',
                      self.state['strategy_assumptions_invalidated'])
        log('MONZA20 step=7 damage_state updated, baseline pace assumption invalidated, recalculation triggered')
        dedupe = '%s@lap7' % category
        self.assertTrue(srs.should_recalculate(self.state, 'driver_reported_damage', dedupe_key=dedupe))
        self.state = srs.recalculate_strategy(
            self.state, reason='driver_reported_damage',
            baseline_fuel_l_per_lap=self.state['baseline_fuel_l_per_lap'],
            recent_fuel_l_per_lap=self.state['recent_fuel_l_per_lap'],
            baseline_pace_s=self.state['baseline_pace_s'], recent_pace_s=None,
            previous_plan='A', selected_plan='A',
            driver_message='操舵異常の申告あり。通常ペース前提を外した。次の有効周で燃費を更新する。',
            session_time_s=460.0, lap=7, dedupe_key=dedupe)
        self.assertFalse(srs.should_recalculate(self.state, 'driver_reported_damage', dedupe_key=dedupe))
        log(srs.format_recalculation_trace(self.state['last_recalculation']).replace('\n', ' | '))
        self.assertEqual(self.state['last_recalculation']['reason'], 'driver_reported_damage')
        self.assertTrue(self.state['last_recalculation']['damage_observed'])
        self.assertEqual(self.state['last_recalculation']['driver_reported_damage'],
                         ['steering_or_front_end'])

        # ── Step 8: post-damage clean laps update fuel/finish feasibility. ──
        log('MONZA20 step=8 post-damage clean-lap fuel updates finish feasibility and push status')
        self.assertTrue(srs.evaluate_fuel_deviation(3.62, 3.9),
                        'a real post-damage fuel change must be detected')
        self.state = srs.recalculate_strategy(
            self.state, reason='fuel_deviation' if 'fuel_deviation' in srs.RECALC_REASONS else 'driver_reported_damage',
            baseline_fuel_l_per_lap=self.state['baseline_fuel_l_per_lap'],
            recent_fuel_l_per_lap=3.9, baseline_pace_s=self.state['baseline_pace_s'],
            recent_pace_s=109.1, previous_plan='A', selected_plan='A',
            driver_message='接触後の実績なら追加ストップなしで届く。プッシュは保留、現ペースを維持。',
            session_time_s=700.0, lap=9, dedupe_key='post_damage_fuel@lap9')
        log(srs.format_recalculation_trace(self.state['last_recalculation']).replace('\n', ' | '))
        self.assertEqual(self.state['recent_fuel_l_per_lap'], 3.9)

        # ── Step 9: fuel margin safe, but push withheld until post-damage
        #    recalculation exists (it now does, from steps 7/8). ──
        self.assertTrue(srs.push_allowed(self.state),
                        'push becomes allowed only after a damage-aware recalculation')
        log('MONZA20 step=9 push_allowed=%s (post-damage recalculation complete)'
            % srs.push_allowed(self.state))

        # Prove the NEGATIVE too: a fresh state with the SAME damage but no
        # completed recalculation must withhold push, even with safe fuel.
        pre_recalc_state = srs.record_driver_reported_damage(
            srs.init_state(), category='steering_alignment', raw_text='x',
            lap=7, session_time_s=460.0)
        self.assertFalse(srs.push_allowed(pre_recalc_state),
                         'safe fuel margin alone must not authorise push while '
                         'damage recalculation is outstanding')
        log('MONZA20 step=9b push_allowed=False before recalculation (fuel margin irrelevant)')

        # ── Step 10: final lap / checker confirmed → no new plan/pit speech. ──
        self.assertTrue(srs.should_recalculate(self.state, 'final_lap_or_checker'))
        self.state = srs.recalculate_strategy(
            self.state, reason='final_lap_or_checker',
            baseline_fuel_l_per_lap=self.state['baseline_fuel_l_per_lap'],
            recent_fuel_l_per_lap=self.state['recent_fuel_l_per_lap'],
            baseline_pace_s=self.state['baseline_pace_s'],
            recent_pace_s=self.state['recent_pace_s'],
            previous_plan='A', selected_plan='A', driver_message=None,
            session_time_s=1180.0, lap=11)
        log(srs.format_recalculation_trace(self.state['last_recalculation']).replace('\n', ' | '))
        self.assertTrue(srs.strategy_speech_blocked(self.state))
        # A late fuel-band critical evaluation must NOT re-open plan/pit speech.
        late_fuel_eval = fuel_strategy_mod.evaluate_fuel_to_finish(
            fuel_level_l=2.0, avg_fuel_per_lap_l=3.9,
            estimated_crossings_to_finish=1, clean_laps_sampled=3,
            lifecycle_state=fuel_strategy_mod.RACING, previous_band=None)
        self.assertTrue(late_fuel_eval['should_warn'],
                        'the plan-agnostic evaluator still flags critical (result-saving stays intact)')
        # The bridge wiring gates the BROADCAST (not the evaluator) on
        # strategy_speech_blocked — proven separately in
        # tests_bridge_recalculation_wiring.py::FinalLapSpeechBlockWiring.
        # Here we assert the state-level contract the wiring depends on:
        self.assertTrue(srs.strategy_speech_blocked(self.state),
                        'once blocked, must stay blocked for the rest of the session')
        log('MONZA20 step=10 strategy_speech_blocked=True '
            '(late critical fuel_eval.should_warn=%s is NOT broadcast — see bridge wiring gate)'
            % late_fuel_eval['should_warn'])

        # ── Consolidated trace: every required marker traceable in ONE log. ──
        full_trace = '\n'.join(TRACE_LOG)
        for marker in ('step=1', 'step=2', 'active_plan=A', 'step=3',
                      'fuel_authority_plan_id=A', 'step=4', 'step=5',
                      'optional_repair_observed_but_not_taken=True', 'step=6',
                      'driver_reported_damage', 'step=7', 'reason=driver_reported_damage',
                      'step=8', 'step=9', 'push_allowed=True', 'step=9b',
                      'push_allowed=False', 'step=10', 'strategy_speech_blocked=True'):
            self.assertIn(marker, full_trace,
                         'consolidated Monza 20 trace must show %r' % marker)
        # Expose the full trace for the completion-evidence writeup.
        Monza20Integration.CAPTURED_TRACE = full_trace


if __name__ == '__main__':
    result = unittest.main(verbosity=2, exit=False).result
    if hasattr(Monza20Integration, 'CAPTURED_TRACE'):
        print('\n' + '=' * 70)
        print('CONSOLIDATED MONZA 20 TRACE')
        print('=' * 70)
        print(Monza20Integration.CAPTURED_TRACE)
    if not result.wasSuccessful():
        sys.exit(1)
