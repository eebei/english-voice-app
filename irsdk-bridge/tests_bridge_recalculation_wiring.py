"""Build 266 Phase E — bridge.py wiring assertions for Session Race State.

Static source checks proving the 7 recalculation triggers, active_plan
registration (Build 265 fix), the push-gate on fuel_strategy_safe, and the
driver_damage_report CMD path are all actually wired into bridge.py — not
just present as unused pure functions in session_race_state.py.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_SRC = None


def bridge_src():
    global _SRC
    if _SRC is None:
        with open(os.path.join(HERE, 'bridge.py'), 'r', encoding='utf-8') as fh:
            _SRC = fh.read()
    return _SRC


def recalc_execution_block():
    """The whole pending-recalculation execution block.

    Sliced on its real boundaries rather than a fixed character window, so
    the assertions keep testing the block itself as it grows."""
    src = bridge_src()
    start = src.index('if _pending_recalculations:')
    end = src.index('# A selected Plan B creates', start)
    return src[start:end]


class ModuleImportAndStateInit(unittest.TestCase):
    def test_module_imported(self):
        self.assertIn('import session_race_state as session_race_state_mod', bridge_src())

    def test_state_initialised_at_module_scope(self):
        self.assertIn('_session_race_state = session_race_state_mod.init_state()', bridge_src())

    def test_state_is_session_scoped_reset(self):
        src = bridge_src()
        reset_def = src[src.index('def _session_scoped_reset_values'):
                        src.index('def derive_pit_phase')]
        self.assertIn("'_session_race_state': session_race_state_mod.init_state()", reset_def)

    def test_both_reset_paths_consume_session_race_state(self):
        src = bridge_src()
        self.assertIn("_session_race_state = _reset['_session_race_state']", src)
        self.assertIn("_session_race_state = _sig_reset['_session_race_state']", src)


class ActivePlanRegistration(unittest.TestCase):
    """Build 265 fix: active_plan must register in the SAME frame the plan
    is built or revised — never left to fall back to no_active_plan."""

    def test_initial_briefing_plan_registers_active_plan_same_frame(self):
        src = bridge_src()
        i = src.index("strategy_options = _candidate_options")
        window = src[i:i + 700]
        self.assertIn('session_race_state_mod.register_active_plan(', window,
                      'active_plan must be registered in the same block that builds the plan')

    def test_plan_decision_switch_re_registers_active_plan(self):
        src = bridge_src()
        i = src.index("strategy_options_decision_sent = True")
        window = src[i:i + 700]
        self.assertIn('session_race_state_mod.register_active_plan(', window)

    def test_fuel_authority_falls_back_to_session_state_plan_before_no_active_plan(self):
        src = bridge_src()
        i = src.index('_plan_options_for_authority = strategy_options')
        j = src.index("_plan_authority_verdict = plan_fuel_authority_mod.evaluate(")
        window = src[i:j]
        self.assertIn("_session_race_state.get('active_plan_snapshot')", window,
                      'fuel authority must fall back to the registered active plan '
                      'before ever evaluating against None')


class RecalculationTriggersWired(unittest.TestCase):
    def test_trigger_clean_3_laps(self):
        src = bridge_src()
        i = src.index('len(clean_fuel_per_lap_hist) >= 3')
        window = src[i:i + 1200]
        self.assertIn("reason='clean_3_laps_established'", window)

    def test_baseline_latch_requires_both_histories(self):
        """Codex limited review P1(#3a): latching on the fuel history alone
        left `baseline_pace_s` permanently None, so pace_deviation could never
        fire."""
        src = bridge_src()
        i = src.index('len(clean_fuel_per_lap_hist) >= 3')
        window = src[i:i + 200]
        self.assertIn('len(clean_lap_time_hist) >= 3', window,
                      'the pace baseline must be established from the same latch')
        # The old, order-dependent condition must be gone from live code.
        code_lines = [l for l in src.split('\n') if not l.strip().startswith('#')]
        self.assertNotIn('len(fuel_per_lap_hist) == 3', '\n'.join(code_lines))

    def test_baseline_uses_same_clean_lap_set_as_deviation(self):
        src = bridge_src()
        i = src.index('len(clean_fuel_per_lap_hist) >= 3')
        window = src[i:i + 1200]
        self.assertIn('recent_median(\n                    clean_fuel_per_lap_hist)', window)
        self.assertIn('recent_median(\n                    clean_lap_time_hist)', window)

    def test_trigger_driver_reported_damage(self):
        src = bridge_src()
        self.assertIn("reason='driver_reported_damage'", src)
        self.assertIn("'trigger': 'strategy_recalculation'", src)

    def test_trigger_repair_detected_or_opt_not_taken(self):
        self.assertIn("reason='repair_detected_or_opt_not_taken'", bridge_src())

    def test_trigger_rival_pit_or_rejoin_shift(self):
        src = bridge_src()
        self.assertIn("reason='rival_pit_or_rejoin_shift'", src)
        # 他のトリガーと同じ再計算経路を通ること（記録だけの別経路を残さない）。
        i = src.index("reason='rival_pit_or_rejoin_shift'")
        self.assertIn('queue_recalculation(', src[max(0, i - 300):i + 300])

    def test_trigger_final_lap_or_checker(self):
        self.assertIn("reason='final_lap_or_checker'", bridge_src())

    def test_trigger_fuel_and_pace_deviation(self):
        """Codex rejection #3: these two are no longer 'pure functions waiting
        for a caller' — the lap-completed block drives them from the real
        rolling medians (see DeviationAutoMonitorWiring)."""
        src = bridge_src()
        self.assertIn("('fuel_deviation',", src)
        self.assertIn("('pace_deviation',", src)
        self.assertIn('reason=_dev_kind', src)

    def test_all_seven_reasons_wired(self):
        src = bridge_src()
        for reason in ('clean_3_laps_established', 'driver_reported_damage',
                      'repair_detected_or_opt_not_taken', 'rival_pit_or_rejoin_shift',
                      'final_lap_or_checker'):
            self.assertIn("reason='%s'" % reason, src, '%s trigger not wired' % reason)
        # The two deviation reasons are dispatched through the shared loop
        # variable rather than a string literal.
        for reason in ('fuel_deviation', 'pace_deviation'):
            self.assertIn("('%s'," % reason, src, '%s trigger not wired' % reason)


class DamageObservationWiring(unittest.TestCase):
    def test_damage_observation_recorded_on_first_detection(self):
        src = bridge_src()
        i = src.index('if damage_s > prev_damage_s + 0.5:')
        window = src[i:i + 1200]
        self.assertIn('session_race_state_mod.record_damage_observation(', window)

    def test_optional_repair_seeded_at_entry(self):
        # The entry value is only a seed for the running maximum below.
        self.assertIn('_pit_repair_opt_observed_max = repair_opt or 0.0', bridge_src())

    def test_optional_repair_max_updated_during_pit_not_only_at_entry(self):
        """Codex Build 266 rejection #1 — damage taken near / inside the box
        raises PitOptRepairLeft AFTER OnPitRoad went True.  The bridge must
        keep updating the maximum for the whole pit visit."""
        src = bridge_src()
        self.assertIn('_pit_repair_opt_observed_max = max(_pit_repair_opt_observed_max or 0.0, repair_opt)',
                      src)
        self.assertIn('_pit_damage_s_max = max(_pit_damage_s_max or 0.0, damage_s)', src)
        # …and the update must be guarded by "we are on pit road", not by the
        # one-shot entry transition.
        i = src.index('_pit_repair_opt_observed_max = max(')
        window = src[max(0, i - 400):i]
        self.assertIn('if onPit:', window)
        self.assertNotIn("prev['onPit'] is False", window,
                         'the running max must not be gated on the entry transition')

    def test_optional_repair_observation_recorded_into_state_every_frame(self):
        src = bridge_src()
        self.assertIn('session_race_state_mod.record_optional_repair_observation(', src)
        i = src.index('session_race_state_mod.record_optional_repair_observation(')
        window = src[i:i + 500]
        self.assertIn('on_pit_road=bool(onPit)', window,
                      'first-seen must record whether it appeared on track or in the box')

    def test_optional_repair_outcome_decided_at_exit(self):
        src = bridge_src()
        i = src.index('_repair_done = round(max(0.0, _repair_basis_s - damage_s), 1)')
        window = src[i:i + 1600]
        self.assertIn('classify_optional_repair(', window)
        self.assertIn('record_optional_repair_outcome(', window)

    def test_not_taken_is_not_inferred_from_the_live_value_at_exit(self):
        """Codex limited review P1(#1): `_repair_done` (max observed minus the
        live value at pit-out) is the same number whether the repair was
        performed or cancelled — it must not decide the outcome."""
        src = bridge_src()
        i = src.index('_repair_done = round(max(0.0, _repair_basis_s - damage_s), 1)')
        window = src[i:i + 1600]
        self.assertNotIn('_repair_done < 1.0', window,
                         'the not-taken decision must come from the countdown evidence')

    def test_service_countdown_tracked_every_frame_on_pit_road(self):
        src = bridge_src()
        self.assertIn('session_race_state_mod.observe_pit_repair_frame(', src)
        i = src.index('session_race_state_mod.observe_pit_repair_frame(')
        window = src[max(0, i - 700):i]
        self.assertIn('if onPit:', window)

    def test_service_tracker_reset_per_pit_visit(self):
        src = bridge_src()
        i = src.index('_pit_repair_opt_observed_max = repair_opt or 0.0')
        window = src[i:i + 400]
        self.assertIn('init_pit_service_tracker()', window,
                      'each pit visit must start with a clean countdown record')

    def test_service_tracker_is_session_scoped(self):
        src = bridge_src()
        reset_def = src[src.index('def _session_scoped_reset_values'):
                        src.index('def derive_pit_phase')]
        self.assertIn("'_pit_service_tracker'", reset_def)
        self.assertIn("_pit_service_tracker = _reset['_pit_service_tracker']", src)
        self.assertIn("_pit_service_tracker = _sig_reset['_pit_service_tracker']", src)

    def test_repair_done_uses_max_damage_seen_in_pit(self):
        """If contact happens inside the box, damage_s at exit can exceed the
        entry value; the entry-based subtraction collapses to 0 and the
        not-taken detection silently dies."""
        src = bridge_src()
        self.assertIn('_repair_basis_s = max(', src)
        i = src.index('_repair_basis_s = max(')
        window = src[i:i + 400]
        self.assertIn('_pit_damage_s_max', window)


class DeviationAutoMonitorWiring(unittest.TestCase):
    """Codex Build 266 rejection #3 — fuel/pace deviation must be compared
    against the baseline inside the real frame loop, not merely exist as pure
    functions."""

    def test_deviation_loop_present_in_lap_block(self):
        src = bridge_src()
        self.assertIn("('fuel_deviation',", src)
        self.assertIn("('pace_deviation',", src)
        self.assertIn('session_race_state_mod.next_deviation_trigger(', src)

    def test_deviation_uses_recent_median_of_valid_laps(self):
        """Codex limited review P1(#3b): the median must come from laps that
        passed the clean-lap test, not from any lap between 20 and 600s."""
        src = bridge_src()
        i = src.index("('fuel_deviation',")
        window = src[i:i + 900]
        self.assertIn('session_race_state_mod.recent_median(clean_fuel_per_lap_hist)', window)
        self.assertIn('session_race_state_mod.recent_median(clean_lap_time_hist)', window)

    def test_clean_histories_appended_together_under_one_validity_test(self):
        src = bridge_src()
        i = src.index('clean_fuel_per_lap_hist.append(')
        window = src[max(0, i - 400):i + 300]
        self.assertIn('_lap_valid_clean', window)
        self.assertIn('clean_lap_time_hist.append(', window,
                      'both histories must be appended in the same branch, '
                      'or they stop describing the same set of laps')

    def test_lap_validity_determined_before_the_histories(self):
        src = bridge_src()
        self.assertLess(src.index('_lap_valid_clean = bool('),
                        src.index('clean_fuel_per_lap_hist.append('),
                        'validity must be known before the lap is recorded')

    def test_validity_is_not_computed_twice(self):
        """One completed lap must not have two independent definitions of
        'clean'.  (`_telemetry_lap_valid_clean` is deliberately separate: it is
        the live prediction for the lap still in progress, not the verdict on a
        finished one.)"""
        import re
        completed_lap_verdicts = re.findall(
            r'(?<![_A-Za-z])_lap_valid_clean = bool\(', bridge_src())
        self.assertEqual(len(completed_lap_verdicts), 1)

    def test_clean_histories_are_session_scoped(self):
        src = bridge_src()
        reset_def = src[src.index('def _session_scoped_reset_values'):
                        src.index('def derive_pit_phase')]
        self.assertIn("'clean_fuel_per_lap_hist': []", reset_def)
        self.assertIn("'clean_lap_time_hist': []", reset_def)
        self.assertIn("clean_lap_time_hist = _reset['clean_lap_time_hist']", src)
        self.assertIn("clean_lap_time_hist = _sig_reset['clean_lap_time_hist']", src)

    def test_deviation_fires_recalculation_with_dedupe(self):
        src = bridge_src()
        i = src.index("('fuel_deviation',")
        window = src[i:i + 3000]
        self.assertIn('next_deviation_trigger(', window)
        self.assertIn('queue_recalculation(', window,
                      'the deviation must reach the recalculation, not stop at a log')
        self.assertIn('dedupe_key=_dev_key', window,
                      'a persistent deviation must not re-fire every lap')

    def test_deviation_episode_counter_is_fed_back(self):
        """The re-arm counter returned by the pure decision must be stored,
        otherwise a deviation that recovers can never speak again."""
        src = bridge_src()
        self.assertIn('_fuel_dev_episode = _dev_next_episode', src)
        self.assertIn('_pace_dev_episode = _dev_next_episode', src)

    def test_deviation_evaluated_per_lap_not_per_frame(self):
        """The loop must be NESTED inside the lap-completed branch, not merely
        written after it.  Ordering alone is not evidence: dedenting the loop
        one level would leave the source order unchanged while turning it into
        a per-frame evaluation, which the brief forbids.
        """
        lines = bridge_src().split('\n')
        dev_line = next(i for i, l in enumerate(lines)
                        if "for _dev_kind, _dev_baseline, _dev_recent, _dev_threshold in (" in l)
        dev_indent = len(lines[dev_line]) - len(lines[dev_line].lstrip())
        # Walk back to the nearest enclosing statement (first code line with a
        # strictly smaller indent).
        enclosing = None
        for j in range(dev_line - 1, -1, -1):
            stripped = lines[j].strip()
            if not stripped or stripped.startswith('#'):
                continue
            indent = len(lines[j]) - len(lines[j].lstrip())
            if indent < dev_indent:
                enclosing = stripped
                break
        self.assertEqual(enclosing, 'if lap_time_changed and onTrack:',
                         'deviation monitoring must run once per completed lap, '
                         'not on every telemetry frame (got: %r)' % enclosing)

    def test_deviation_episode_counters_are_session_scoped(self):
        src = bridge_src()
        reset_def = src[src.index('def _session_scoped_reset_values'):
                        src.index('def derive_pit_phase')]
        self.assertIn("'_fuel_dev_episode': 0", reset_def)
        self.assertIn("'_pace_dev_episode': 0", reset_def)
        self.assertIn("_fuel_dev_episode = _reset['_fuel_dev_episode']", src)
        self.assertIn("_fuel_dev_episode = _sig_reset['_fuel_dev_episode']", src)

    def test_optional_repair_flag_survives_live_value_reset(self):
        # The live PitOptRepairLeft value resetting to 0.0 must NOT clear the
        # sticky flag — there is no "clear" mutator in session_race_state.py.
        import session_race_state as srs
        self.assertFalse(hasattr(srs, 'clear_optional_repair_not_taken'))


class RecalculationActuallyRecomputes(unittest.TestCase):
    """Codex差戻し#2 — トリガーが「記録」で終わらず、実際にPlanを組み直して
    active_plan を更新するところまで配線されていること。"""

    def test_every_trigger_goes_through_the_queue(self):
        """4つのトリガー（クリーン3周・燃費/ペース乖離・修理検出・ドライバー申告）
        が全て再計算へ到達すること。"""
        src = bridge_src()
        self.assertEqual(src.count('queue_recalculation('), 6,
                         'five trigger sites plus the helper definition')
        for reason in ("reason='clean_3_laps_established'",
                       "reason='repair_detected_or_opt_not_taken'",
                       "reason='driver_reported_damage'"):
            i = src.index(reason)
            window = src[max(0, i - 300):i + 300]
            self.assertIn('queue_recalculation(', window,
                          '%s does not reach the recalculation' % reason)
        # 乖離トリガーは共有ループ変数で渡すため、ブロック単位で確認する
        # （DeviationAutoMonitorWiring.test_deviation_fires_recalculation_with_dedupe）。
        i = src.index("('fuel_deviation',")
        self.assertIn('queue_recalculation(', src[i:i + 3000])

    def test_execution_rebuilds_plans_not_just_records(self):
        src = bridge_src()
        self.assertIn('def execute_recalculation(', src)
        i = src.index('def execute_recalculation(')
        window = src[i:i + 3000]
        self.assertIn('options_mod.reevaluate_plans(', window,
                      'the recalculation must rebuild Plan A/B/C')
        self.assertIn('srs_mod.register_active_plan(', window,
                      'the rebuilt plan must become the active plan')
        self.assertIn('srs_mod.recalculate_strategy(', window)

    def test_execution_runs_after_the_authoritative_inputs_are_fresh(self):
        """再計算はトリガー検出より後、権威データが今フレームの値に更新された
        後で実行されること（1周古い入力で組み直さない）。"""
        src = bridge_src()
        self.assertLess(src.index("reason='driver_reported_damage'"),
                        src.index('if _pending_recalculations:'))
        self.assertLess(src.index('_fuel_strategy_live = ('),
                        src.index('if _pending_recalculations:'))
        self.assertLess(src.index('_pit_now_forecast = None'),
                        src.index('if _pending_recalculations:'))

    def test_execution_feeds_measured_numbers(self):
        window = recalc_execution_block()
        self.assertIn('recent_median(\n                        clean_fuel_per_lap_hist)', window)
        self.assertIn('recent_median(\n                        clean_lap_time_hist)', window)
        self.assertIn("'fuel_level_l': fuel", window)

    def test_execution_does_not_depend_on_a_conditionally_defined_name(self):
        """`_option_crossings` はブリーフィング側の入れ子 if の中でしか定義
        されない。そこへ依存すると UnboundLocalError になり得る。"""
        window = recalc_execution_block()
        self.assertIn('_recalc_crossings', window)
        self.assertNotIn("'crossings_to_finish': _option_crossings", window)

    def test_queue_is_drained_once_per_frame(self):
        window = recalc_execution_block()
        self.assertIn('for _recalc_item in _pending_recalculations:', window)
        self.assertIn('_pending_recalculations = []', window)

    def test_outcome_is_traced(self):
        window = recalc_execution_block()
        self.assertIn('STRATEGY RECALCULATION OUTCOME', window)
        for field in ('previous_plan=%s', 'selected_plan=%s', 'plan_changed=%s'):
            self.assertIn(field, window)

    def test_queue_and_baselines_are_session_scoped(self):
        src = bridge_src()
        reset_def = src[src.index('def _session_scoped_reset_values'):
                        src.index('def derive_pit_phase')]
        self.assertIn("'_pending_recalculations': []", reset_def)
        self.assertIn("'_pending_recalc_baselines'", reset_def)
        for name in ('_pending_recalculations', '_pending_recalc_baselines'):
            self.assertIn("%s = _reset['%s']" % (name, name), src)
            self.assertIn("%s = _sig_reset['%s']" % (name, name), src)

    def test_same_trigger_is_not_queued_twice_in_one_frame(self):
        src = bridge_src()
        i = src.index('def queue_recalculation(')
        window = src[i:i + 900]
        self.assertIn('if any((item.get(\'reason\'), item.get(\'dedupe_key\')) == key', window)


class PlanCWiring(unittest.TestCase):
    """Codex差戻し#4 — Plan C が実配線されており、根拠なしでは提案されないこと。"""

    def test_plan_c_conditions_are_never_assumed_true(self):
        window = recalc_execution_block()
        # 条件は実測から導く。導けない時は None のまま＝未証明。
        for condition, expr in (
                ('rival_pitted_first', '_recalc_rival_pitted'),
                ('clean_air', '_recalc_clean_air'),
                ('rejoin_not_worse', '_recalc_rejoin_ok')):
            self.assertIn("'%s': %s," % (condition, expr), window)
            self.assertIn('%s = None' % expr, window,
                          '%s must default to unproven' % condition)

    def test_plan_c_evidence_is_traced(self):
        self.assertIn('plan_c_evidence', recalc_execution_block())

    def test_module_exposes_plan_c_contract(self):
        import strategy_options as so
        self.assertTrue(hasattr(so, 'decide_plan_c'))
        self.assertTrue(hasattr(so, 'reevaluate_plans'))
        self.assertIn('fuel_save_on_target', so.PLAN_C_CONDITIONS)

    def test_fuel_save_evidence_is_separate_from_the_planning_median(self):
        """目標値は計画側の燃費から導く。同じ中央値を条件判定へ戻すと自分自身と
        比べることになり、検証にならない。"""
        src = bridge_src()
        i = src.index('def execute_recalculation(')
        window = src[i:i + 3000]
        self.assertIn("fuel_save_recent_l_per_lap=inputs.get('fuel_save_recent_l_per_lap')",
                      window)
        self.assertNotIn(
            "fuel_save_recent_l_per_lap=inputs.get('recent_fuel_per_lap_l')", window)


class DriverDamageReportCmdWiring(unittest.TestCase):
    def test_cmd_handler_queues_report(self):
        src = bridge_src()
        self.assertIn("elif cmd == 'driver_damage_report':", src)
        i = src.index("elif cmd == 'driver_damage_report':")
        window = src[i:i + 600]
        self.assertIn('_queue_driver_damage_report(_text)', window)

    def test_poll_loop_consumes_queue(self):
        src = bridge_src()
        self.assertIn('for _dmg_text in _consume_driver_damage_reports():', src)

    def test_unclassified_text_does_not_silently_vanish(self):
        src = bridge_src()
        i = src.index('for _dmg_text in _consume_driver_damage_reports():')
        window = src[i:i + 500]
        self.assertIn('unclassified', window)

    def test_renderer_forwards_damage_related_speech(self):
        renderer_path = os.path.join(
            os.path.dirname(HERE), 'desktop', 'renderer.html')
        with open(renderer_path, 'r', encoding='utf-8') as fh:
            renderer = fh.read()
        self.assertIn('function forwardDriverDamageReport(text)', renderer)
        self.assertIn("cmd:'driver_damage_report'", renderer)
        self.assertIn('forwardDriverDamageReport(latestUserText);', renderer)


class FinalLapSpeechBlockWiring(unittest.TestCase):
    """Build 265 wiring fix 5 / Build 266 fix ⑤: no new pit-now / plan-switch
    speech after final lap or checker confirmed."""

    def test_fuel_p0_broadcast_gated_by_strategy_speech_blocked(self):
        src = bridge_src()
        i = src.index("_plan_authority_permits = (")
        window = src[i:i + 700]
        self.assertIn('_strategy_speech_blocked = session_race_state_mod.strategy_speech_blocked(',
                      window)
        self.assertIn('and not _strategy_speech_blocked', window)

    def test_dispatch_trace_shows_block_reason(self):
        self.assertIn("_fuel_dispatch_display = 'BLOCKED_BY_FINAL_LAP_OR_CHECKER'", bridge_src())

    def test_plan_decision_gated_by_strategy_speech_blocked(self):
        src = bridge_src()
        i = src.index("# rejoin for this lap versus one lap later from one live snapshot.")
        window = src[i:i + 700]
        self.assertIn('not session_race_state_mod.strategy_speech_blocked(_session_race_state)',
                      window)

    def test_box_call_gated_by_strategy_speech_blocked(self):
        src = bridge_src()
        i = src.index('# A selected Plan B creates a second, mandatory trigger')
        window = src[i:i + 900]
        self.assertIn('not session_race_state_mod.strategy_speech_blocked(_session_race_state)',
                      window)

    def test_strategy_speech_blocked_true_only_after_final_lap_trigger(self):
        import session_race_state as srs
        s = srs.init_state()
        self.assertFalse(srs.strategy_speech_blocked(s))
        s = srs.consume_trigger(s, 'final_lap_or_checker')
        self.assertTrue(srs.strategy_speech_blocked(s))


class SideBySideCooldownWiring(unittest.TestCase):
    """Build 265 wiring fix 2 / Build 266 Codex fix ⑥: cross-zone cooldown
    for the same side, so a long side-by-side battle doesn't re-fire every
    time the corner/braking zone re-arms."""

    def test_cooldown_state_declared(self):
        src = bridge_src()
        self.assertIn('side_by_side_last_fired = {}', src)
        self.assertIn('SIDE_BY_SIDE_COOLDOWN_S = 6.0', src)

    def test_dispatch_gated_by_cooldown(self):
        src = bridge_src()
        i = src.index("if in_side_zone and car_left_right is not None and car_left_right >= 2:")
        window = src[i:i + 900]
        self.assertIn('_cooldown_elapsed = (_now3 - _last_fired) >= SIDE_BY_SIDE_COOLDOWN_S', window)
        self.assertIn('if _side and _side not in corner_sides_announced and _cooldown_elapsed:', window)

    def test_cooldown_timestamp_recorded_on_fire(self):
        src = bridge_src()
        i = src.index('corner_sides_announced.add(_side)')
        window = src[i:i + 300]
        self.assertIn('side_by_side_last_fired[_side] = _now3', window)


class PushGateWiring(unittest.TestCase):
    def test_fuel_strategy_safe_consults_push_allowed(self):
        src = bridge_src()
        i = src.index("_fuel_eval.get('transition') == 'critical_to_safe'")
        window = src[i:i + 1400]
        self.assertIn('session_race_state_mod.push_allowed(_session_race_state)', window)
        self.assertIn("'push_allowed': _push_ok", window)

    def test_renderer_respects_push_allowed_false(self):
        renderer_path = os.path.join(
            os.path.dirname(HERE), 'desktop', 'renderer.html')
        with open(renderer_path, 'r', encoding='utf-8') as fh:
            renderer = fh.read()
        self.assertIn("d.push_allowed===false", renderer)
        self.assertIn('プッシュは損傷評価待ち', renderer)


if __name__ == '__main__':
    result = unittest.main(verbosity=2, exit=False).result
    if not result.wasSuccessful():
        sys.exit(1)
