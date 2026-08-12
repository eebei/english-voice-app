"""Build 266 Phase E — Session Race State unit tests."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import session_race_state as srs


class InitAndPlanRegistration(unittest.TestCase):
    def test_init_state_is_empty_and_open(self):
        s = srs.init_state()
        self.assertIsNone(s['active_plan'])
        self.assertIsNone(s['active_plan_snapshot'])
        self.assertEqual(s['plan_revision'], 0)
        self.assertFalse(s['closed'])
        self.assertEqual(s['strategy_assumptions_invalidated'], [])

    def test_register_active_plan_sets_all_fields(self):
        s = srs.init_state()
        snapshot = {'available': True, 'selected_plan': 'A', 'plans': {'A': {}}}
        s2 = srs.register_active_plan(
            s, plan_id='A', plan_snapshot=snapshot, snapshot_id='briefing:1', revision=1)
        self.assertEqual(s2['active_plan'], 'A')
        self.assertEqual(s2['active_plan_snapshot'], snapshot)
        self.assertEqual(s2['plan_snapshot_id'], 'briefing:1')
        self.assertEqual(s2['plan_revision'], 1)
        # Immutability: original state untouched.
        self.assertIsNone(s['active_plan'])

    def test_register_active_plan_auto_increments_revision(self):
        s = srs.init_state()
        s = srs.register_active_plan(s, plan_id='A', plan_snapshot={}, snapshot_id='x')
        self.assertEqual(s['plan_revision'], 1)
        s = srs.register_active_plan(s, plan_id='B', plan_snapshot={}, snapshot_id='y')
        self.assertEqual(s['plan_revision'], 2)
        self.assertEqual(s['active_plan'], 'B')


class DamageObservation(unittest.TestCase):
    def test_first_observation_is_snapshotted(self):
        s = srs.init_state()
        s = srs.record_damage_observation(
            s, mandatory_repair_s=0, optional_repair_s=12.5, damage_s=12.5,
            lap=6, session_time_s=400.0, incident_delta=2, on_pit_road=False)
        obs = s['damage_state']['damage_observation']
        self.assertEqual(obs['first_detected_at_lap'], 6)
        self.assertEqual(obs['optional_repair_s'], 12.5)

    def test_first_detected_lap_never_changes_on_later_updates(self):
        s = srs.init_state()
        s = srs.record_damage_observation(
            s, mandatory_repair_s=0, optional_repair_s=5.0, damage_s=5.0,
            lap=6, session_time_s=400.0, incident_delta=1, on_pit_road=False)
        s = srs.record_damage_observation(
            s, mandatory_repair_s=3.0, optional_repair_s=5.0, damage_s=8.0,
            lap=9, session_time_s=700.0, incident_delta=1, on_pit_road=False)
        obs = s['damage_state']['damage_observation']
        self.assertEqual(obs['first_detected_at_lap'], 6, 'first-seen lap must never change')
        self.assertEqual(obs['damage_s'], 8.0, 'running total does update')
        self.assertEqual(obs['last_updated_at_lap'], 9)

    def test_optional_repair_not_taken_flag_is_sticky(self):
        s = srs.init_state()
        s = srs.record_damage_observation(
            s, mandatory_repair_s=0, optional_repair_s=15.0, damage_s=15.0,
            lap=6, session_time_s=400.0, incident_delta=1, on_pit_road=True)
        s = srs.mark_optional_repair_not_taken(s, lap=7)
        self.assertTrue(s['damage_state']['optional_repair_observed_but_not_taken'])
        self.assertEqual(s['damage_state']['optional_repair_not_taken_at_lap'], 7)
        # Even if live PitOptRepairLeft resets to 0.0 later, the caller must
        # NOT call any "clear" mutator — there isn't one, by design.
        self.assertNotIn('clear_optional_repair', dir(srs))


class OptionalRepairObservation(unittest.TestCase):
    """Codex Build 266 rejection #1 — the optional-repair seconds must be
    tracked as a running maximum with a first-seen timestamp, updated during
    the pit visit, not snapshotted once at pit entry."""

    def test_first_observation_records_lap_time_and_pit_road(self):
        s = srs.init_state()
        s = srs.record_optional_repair_observation(
            s, optional_repair_s=14.0, lap=6, session_time_s=400.0, on_pit_road=True)
        d = s['damage_state']
        self.assertEqual(d['optional_repair_observed_max_s'], 14.0)
        self.assertEqual(d['optional_repair_first_seen_at_lap'], 6)
        self.assertEqual(d['optional_repair_first_seen_at_session_time_s'], 400.0)
        self.assertTrue(d['optional_repair_first_seen_on_pit_road'])

    def test_damage_appearing_after_pit_entry_is_captured(self):
        """The Monza 20 shape: OnPitRoad goes True with a clean car, contact
        happens by the box, PitOptRepairLeft only then becomes non-zero."""
        s = srs.init_state()
        # Pit entry frame — nothing to see yet.
        s = srs.record_optional_repair_observation(
            s, optional_repair_s=0.0, lap=6, session_time_s=400.0, on_pit_road=True)
        self.assertIsNone(s['damage_state'].get('optional_repair_observed_max_s'))
        # Contact by the box, three frames later.
        s = srs.record_optional_repair_observation(
            s, optional_repair_s=14.0, lap=6, session_time_s=403.0, on_pit_road=True)
        self.assertEqual(srs.optional_repair_observed_max(s), 14.0)
        self.assertEqual(s['damage_state']['optional_repair_first_seen_at_session_time_s'], 403.0)

    def test_running_maximum_never_drops(self):
        s = srs.init_state()
        s = srs.record_optional_repair_observation(
            s, optional_repair_s=14.0, lap=6, session_time_s=403.0, on_pit_road=True)
        # Live value falls back as the pit-out reset lands.
        s = srs.record_optional_repair_observation(
            s, optional_repair_s=2.0, lap=7, session_time_s=440.0, on_pit_road=False)
        s = srs.record_optional_repair_observation(
            s, optional_repair_s=0.0, lap=7, session_time_s=441.0, on_pit_road=False)
        self.assertEqual(srs.optional_repair_observed_max(s), 14.0,
                         'a live value dropping to 0.0 is not "it never happened"')
        self.assertEqual(s['damage_state']['optional_repair_first_seen_at_lap'], 6)

    def test_idempotent_when_value_does_not_grow(self):
        """Safe to call unconditionally from the poll loop."""
        s = srs.init_state()
        s = srs.record_optional_repair_observation(
            s, optional_repair_s=14.0, lap=6, session_time_s=403.0, on_pit_road=True)
        same = srs.record_optional_repair_observation(
            s, optional_repair_s=14.0, lap=6, session_time_s=403.5, on_pit_road=True)
        self.assertIs(same, s, 'no state churn when the maximum is unchanged')

    def test_not_taken_carries_the_observed_maximum(self):
        s = srs.init_state()
        s = srs.record_optional_repair_observation(
            s, optional_repair_s=14.0, lap=6, session_time_s=403.0, on_pit_road=True)
        s = srs.mark_optional_repair_not_taken(s, lap=6)
        self.assertTrue(s['damage_state']['optional_repair_observed_but_not_taken'])
        self.assertEqual(s['damage_state']['optional_repair_not_taken_s'], 14.0)

    def test_zero_and_none_are_ignored(self):
        s = srs.init_state()
        for value in (0.0, None, -1.0):
            s = srs.record_optional_repair_observation(
                s, optional_repair_s=value, lap=3, session_time_s=100.0, on_pit_road=False)
        self.assertEqual(srs.optional_repair_observed_max(s), 0.0)


class PitServiceCancelledVersusPerformed(unittest.TestCase):
    """Codex限定レビュー P1(#1) — `PitOptRepairLeft` はピットアウトで必ず 0 になる。
    実施と取消は退出時の値では区別できない。実時間に沿った消化だけが実施の証拠。

    `replay()` は poll loop と同じ順序でフレームを流し、そのピット訪問の判定を返す。
    """

    def replay(self, frames):
        """frames = [(session_time_s, PitOptRepairLeft), ...]"""
        tracker = srs.init_pit_service_tracker()
        for session_time_s, value in frames:
            tracker = srs.observe_pit_repair_frame(
                tracker, optional_repair_s=value, session_time_s=session_time_s)
        return tracker, srs.classify_optional_repair(tracker)

    def test_cancelled_repair_leaving_on_fuel_only(self):
        """Monza 20の形：ボックス付近で148秒の任意修理が見えたが、取り消して
        燃料だけでピットアウトした。ライブ値は退出時に0へ落ちる。"""
        frames = [(400.0, 0.0), (401.0, 148.0), (402.0, 148.0), (403.0, 148.0),
                  (404.0, 148.0),            # 給油だけ実施、修理は走らない
                  (405.0, 0.0)]              # ピットアウトでライブ値リセット
        tracker, outcome = self.replay(frames)
        self.assertEqual(outcome, 'not_taken')
        self.assertEqual(tracker['max_s'], 148.0)
        self.assertEqual(tracker['countdown_s'], 0.0,
                         'the pit-out reset must never count as service')

    def test_performed_repair_counts_down_in_real_time(self):
        frames = [(400.0, 0.0), (401.0, 148.0)]
        # 実サービス：経過秒と同じ速度で減っていく
        remaining, t = 148.0, 401.0
        while remaining > 0:
            step = min(4.0, remaining)
            t += step
            remaining -= step
            frames.append((t, remaining))
        frames.append((t + 1.0, 0.0))       # 退出
        tracker, outcome = self.replay(frames)
        self.assertEqual(outcome, 'taken')
        self.assertGreaterEqual(tracker['countdown_s'], 147.0)

    def test_cancelled_and_performed_are_distinguishable(self):
        """両者は退出時の値が同じ0でも、別の結論になること。"""
        _, cancelled = self.replay(
            [(400.0, 148.0), (404.0, 148.0), (405.0, 0.0)])
        _, performed = self.replay(
            [(400.0, 10.0), (404.0, 6.0), (408.0, 2.0), (410.0, 0.0), (411.0, 0.0)])
        self.assertEqual(cancelled, 'not_taken')
        self.assertEqual(performed, 'taken')
        self.assertNotEqual(cancelled, performed)

    def test_partial_service_then_cancelled(self):
        # 148秒のうち20秒だけ消化して打ち切った。
        frames = [(400.0, 148.0), (410.0, 138.0), (420.0, 128.0), (421.0, 0.0)]
        tracker, outcome = self.replay(frames)
        self.assertEqual(outcome, 'partial')
        self.assertAlmostEqual(tracker['countdown_s'], 20.0, places=1)

    def test_selection_change_is_not_service(self):
        """修理項目を選び直して秒数が一瞬で落ちるのは、消化ではない。"""
        frames = [(400.0, 148.0), (400.5, 40.0), (401.0, 40.0), (402.0, 0.0)]
        _, outcome = self.replay(frames)
        self.assertEqual(outcome, 'not_taken')

    def test_no_optional_repair_at_all(self):
        _, outcome = self.replay([(400.0, 0.0), (405.0, 0.0)])
        self.assertEqual(outcome, 'none')

    def test_outcome_recorded_into_state_and_flag_is_sticky(self):
        state = srs.init_state()
        tracker, _ = self.replay(
            [(400.0, 148.0), (404.0, 148.0), (405.0, 0.0)])
        state = srs.record_optional_repair_outcome(state, tracker=tracker, lap=6)
        damage = state['damage_state']
        self.assertEqual(damage['optional_repair_outcome'], 'not_taken')
        self.assertTrue(damage['optional_repair_observed_but_not_taken'])
        self.assertEqual(damage['optional_repair_visit_max_s'], 148.0)
        self.assertNotIn('clear_optional_repair', dir(srs))

    def test_performed_repair_does_not_set_not_taken(self):
        state = srs.init_state()
        tracker, _ = self.replay(
            [(400.0, 10.0), (404.0, 6.0), (408.0, 2.0), (410.0, 0.0)])
        state = srs.record_optional_repair_outcome(state, tracker=tracker, lap=6)
        damage = state['damage_state']
        self.assertEqual(damage['optional_repair_outcome'], 'taken')
        self.assertFalse(damage['optional_repair_observed_but_not_taken'])

    def test_visit_with_no_repair_leaves_state_untouched(self):
        state = srs.init_state()
        tracker, _ = self.replay([(400.0, 0.0), (405.0, 0.0)])
        self.assertIs(srs.record_optional_repair_outcome(state, tracker=tracker, lap=6),
                      state)


class CleanLapBaselineOrdering(unittest.TestCase):
    """Codex限定レビュー P1(#3a/#3b) — 基準は「同一の有効周集合」から、燃費と
    ペースが両方揃った時点で確定する。片方だけで確定しない。"""

    def latch(self, laps):
        """laps = [(valid_clean, fuel_used, lap_time), ...] を周ごとに流し、
        bridge と同じ順序で履歴を積んで baseline を確定した結果を返す。"""
        fuel_hist, pace_hist = [], []
        state = srs.init_state()
        latched_at = None
        for i, (valid, fuel_used, lap_time) in enumerate(laps, start=1):
            if valid and fuel_used is not None and lap_time is not None:
                fuel_hist.append(fuel_used)
                pace_hist.append(lap_time)
                fuel_hist[:] = fuel_hist[-5:]
                pace_hist[:] = pace_hist[-5:]
            if (len(fuel_hist) >= 3 and len(pace_hist) >= 3
                    and srs.should_recalculate(state, 'clean_3_laps_established')):
                state = srs.recalculate_strategy(
                    state, reason='clean_3_laps_established',
                    baseline_fuel_l_per_lap=srs.recent_median(fuel_hist),
                    recent_fuel_l_per_lap=srs.recent_median(fuel_hist),
                    baseline_pace_s=srs.recent_median(pace_hist),
                    recent_pace_s=srs.recent_median(pace_hist),
                    previous_plan='A', selected_plan='A', driver_message=None,
                    session_time_s=float(i) * 108.0, lap=i)
                latched_at = i
        return state, latched_at

    def test_pace_baseline_is_not_none_after_three_clean_laps(self):
        state, latched_at = self.latch([
            (True, 3.60, 108.4), (True, 3.62, 108.6), (True, 3.58, 108.2)])
        self.assertEqual(latched_at, 3)
        self.assertIsNotNone(state['baseline_pace_s'],
                             'this is the defect: pace baseline stuck at None')
        self.assertEqual(state['baseline_pace_s'], 108.4)
        self.assertEqual(state['baseline_fuel_l_per_lap'], 3.60)

    def test_dirty_laps_do_not_count_toward_the_three(self):
        state, latched_at = self.latch([
            (True, 3.60, 108.4),
            (False, 5.90, 145.0),   # ピット周
            (False, 3.20, 121.0),   # アウトラップ
            (True, 3.62, 108.6),
            (False, 3.70, 113.0),   # off-track
            (True, 3.58, 108.2),
        ])
        self.assertEqual(latched_at, 6, 'only clean laps may complete the set')
        self.assertEqual(state['baseline_pace_s'], 108.4,
                         'a pit lap must never enter the pace baseline')
        self.assertEqual(state['baseline_fuel_l_per_lap'], 3.60)

    def test_latch_happens_once(self):
        state, _ = self.latch([(True, 3.60, 108.4)] * 6)
        self.assertEqual(
            state['recalculation_consumed_triggers'].count('clean_3_laps_established'), 1)

    def test_pace_deviation_can_fire_after_the_latch(self):
        """基準が確定しない限り pace_deviation は永久に発火できない。"""
        state, _ = self.latch([
            (True, 3.60, 108.4), (True, 3.62, 108.6), (True, 3.58, 108.2)])
        should_fire, key, _ = srs.next_deviation_trigger(
            state, reason='pace_deviation',
            baseline=state['baseline_pace_s'], recent=109.4,
            threshold=srs.PACE_DEVIATION_S, episode=0)
        self.assertTrue(should_fire)
        self.assertIsNotNone(key)


class RecentMedianAndDeviationStep(unittest.TestCase):
    """Codex Build 266 rejection #3 — the inputs the frame loop compares."""

    def test_median_needs_three_valid_laps(self):
        self.assertIsNone(srs.recent_median([3.6, 3.7]))
        self.assertEqual(srs.recent_median([3.6, 3.7, 3.62]), 3.62)

    def test_median_ignores_a_single_outlier(self):
        # A traffic lap must not drag the running value the way a mean would.
        self.assertEqual(srs.recent_median([3.6, 3.62, 9.9]), 3.62)

    def test_median_uses_last_five_only(self):
        self.assertEqual(srs.recent_median([99.0, 99.0, 3.6, 3.6, 3.6, 3.6, 3.6]), 3.6)

    def test_median_of_even_window(self):
        self.assertEqual(srs.recent_median([3.6, 3.8, 3.6, 3.8]), 3.7)

    def test_deviation_step_zero_within_tolerance(self):
        self.assertEqual(
            srs.deviation_step(3.6, 3.7, srs.FUEL_DEVIATION_L_PER_LAP), 0)

    def test_deviation_step_one_at_threshold(self):
        self.assertEqual(
            srs.deviation_step(3.6, 3.85, srs.FUEL_DEVIATION_L_PER_LAP), 1)

    def test_deviation_step_grows_as_it_worsens(self):
        self.assertEqual(
            srs.deviation_step(3.6, 4.2, srs.FUEL_DEVIATION_L_PER_LAP), 2)

    def test_deviation_step_is_direction_agnostic(self):
        self.assertEqual(
            srs.deviation_step(108.4, 107.8, srs.PACE_DEVIATION_S), 1,
            'getting faster than baseline is also a changed assumption')

    def test_deviation_step_guards_bad_inputs(self):
        self.assertEqual(srs.deviation_step(None, 3.9, 0.25), 0)
        self.assertEqual(srs.deviation_step(3.6, None, 0.25), 0)
        self.assertEqual(srs.deviation_step(3.6, 3.9, 0), 0)


class DeviationTriggerSequence(unittest.TestCase):
    """Codex Build 266 rejection #3 — the per-lap firing rule, exercised as a
    lap sequence rather than asserted as source text.

    `replay()` drives the same decision the bridge poll loop drives, one call
    per completed lap, and returns which laps actually fired.
    """

    def replay(self, per_lap_values, *, baseline, reason='fuel_deviation',
               threshold=None):
        threshold = (srs.FUEL_DEVIATION_L_PER_LAP if threshold is None else threshold)
        state = srs.init_state()
        episode = 0
        fired = []
        for lap, recent in enumerate(per_lap_values, start=1):
            should_fire, key, episode = srs.next_deviation_trigger(
                state, reason=reason, baseline=baseline, recent=recent,
                threshold=threshold, episode=episode)
            if should_fire:
                state = srs.recalculate_strategy(
                    state, reason=reason,
                    baseline_fuel_l_per_lap=baseline, recent_fuel_l_per_lap=recent,
                    baseline_pace_s=None, recent_pace_s=None,
                    previous_plan='A', selected_plan='A', driver_message=None,
                    session_time_s=float(lap) * 108.0, lap=lap, dedupe_key=key)
                fired.append((lap, key))
        return fired

    def test_stable_fuel_never_fires(self):
        fired = self.replay([3.60, 3.62, 3.58, 3.61, 3.63], baseline=3.60)
        self.assertEqual(fired, [])

    def test_persistent_deviation_fires_once_not_every_lap(self):
        # Post-contact the car simply drinks more, lap after lap.
        fired = self.replay([3.90, 3.92, 3.91, 3.90, 3.93], baseline=3.60)
        self.assertEqual(len(fired), 1, 'a persistent deviation must not nag every lap')
        self.assertEqual(fired[0][0], 1)

    def test_worsening_deviation_fires_again(self):
        fired = self.replay([3.90, 3.91, 4.20, 4.22], baseline=3.60)
        self.assertEqual([lap for lap, _ in fired], [1, 3],
                         'a deviation that doubles is new information')

    def test_recovered_then_deviating_again_re_arms(self):
        fired = self.replay([3.90, 3.60, 3.61, 3.92], baseline=3.60)
        self.assertEqual([lap for lap, _ in fired], [1, 4],
                         'after recovering, a fresh deviation must speak again')

    def test_no_baseline_means_no_fire_and_no_rearm(self):
        state = srs.init_state()
        should_fire, key, episode = srs.next_deviation_trigger(
            state, reason='fuel_deviation', baseline=None, recent=3.9,
            threshold=srs.FUEL_DEVIATION_L_PER_LAP, episode=0)
        self.assertFalse(should_fire)
        self.assertIsNone(key)
        self.assertEqual(episode, 0, 'the re-arm counter must not run without a baseline')

    def test_no_recent_median_means_no_fire(self):
        state = srs.init_state()
        should_fire, _, _ = srs.next_deviation_trigger(
            state, reason='fuel_deviation', baseline=3.6, recent=None,
            threshold=srs.FUEL_DEVIATION_L_PER_LAP, episode=0)
        self.assertFalse(should_fire)

    def test_pace_deviation_uses_its_own_threshold(self):
        # 0.6s off a 108.4s baseline is significant; 0.3s is not.
        fired = self.replay([108.4, 109.0, 108.7], baseline=108.4,
                            reason='pace_deviation', threshold=srs.PACE_DEVIATION_S)
        self.assertEqual([lap for lap, _ in fired], [2])

    def test_unknown_reason_never_fires(self):
        state = srs.init_state()
        should_fire, _, _ = srs.next_deviation_trigger(
            state, reason='not_a_reason', baseline=3.6, recent=9.9,
            threshold=0.25, episode=0)
        self.assertFalse(should_fire)

    def test_fired_recalculation_lands_in_state(self):
        state = srs.init_state()
        should_fire, key, _ = srs.next_deviation_trigger(
            state, reason='fuel_deviation', baseline=3.6, recent=3.95,
            threshold=srs.FUEL_DEVIATION_L_PER_LAP, episode=0)
        self.assertTrue(should_fire)
        state = srs.recalculate_strategy(
            state, reason='fuel_deviation',
            baseline_fuel_l_per_lap=3.6, recent_fuel_l_per_lap=3.95,
            baseline_pace_s=None, recent_pace_s=None,
            previous_plan='A', selected_plan='A', driver_message=None,
            session_time_s=800.0, lap=8, dedupe_key=key)
        record = state['last_recalculation']
        self.assertEqual(record['reason'], 'fuel_deviation')
        self.assertEqual(record['recent_fuel_l_per_lap'], 3.95)
        self.assertIn('fuel_deviation:%s' % key, state['recalculation_consumed_triggers'])


class DriverReportedDamage(unittest.TestCase):
    def test_front_bumper_phrase_classified(self):
        self.assertEqual(srs.parse_driver_reported_damage('フロントバンパーが割れた'),
                         'front_aero_or_body')

    def test_steering_column_phrase_classified(self):
        self.assertEqual(
            srs.parse_driver_reported_damage('フロント ステアリングコラム 周辺にダメージ'),
            'steering_or_front_end')

    def test_alignment_phrase_classified(self):
        self.assertEqual(srs.parse_driver_reported_damage('アライメント狂ってる'),
                         'steering_alignment')

    def test_english_alignment_phrase_classified(self):
        self.assertEqual(srs.parse_driver_reported_damage('the alignment is off'),
                         'steering_alignment')

    def test_unrelated_speech_returns_none(self):
        self.assertIsNone(srs.parse_driver_reported_damage('燃料足りる？'))
        self.assertIsNone(srs.parse_driver_reported_damage(''))
        self.assertIsNone(srs.parse_driver_reported_damage(None))

    def test_record_driver_reported_damage_marks_source_as_report(self):
        s = srs.init_state()
        s = srs.record_driver_reported_damage(
            s, category='steering_alignment', raw_text='アライメント狂ってる',
            lap=7, session_time_s=430.0)
        reports = s['damage_state']['driver_reported_damage']
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0]['source'], 'driver_report')
        self.assertEqual(reports[0]['category'], 'steering_alignment')

    def test_driver_reports_never_merge_into_sdk_confirmed_field(self):
        s = srs.init_state()
        s = srs.record_driver_reported_damage(
            s, category='front_aero_or_body', raw_text='フロントバンパーが',
            lap=6, session_time_s=400.0)
        # damage_observation (SDK-confirmed) stays untouched by a driver report.
        self.assertIsNone(s['damage_state']['damage_observation'])

    def test_multiple_reports_accumulate(self):
        s = srs.init_state()
        s = srs.record_driver_reported_damage(
            s, category='front_aero_or_body', raw_text='a', lap=6, session_time_s=1)
        s = srs.record_driver_reported_damage(
            s, category='steering_alignment', raw_text='b', lap=8, session_time_s=2)
        self.assertEqual(len(s['damage_state']['driver_reported_damage']), 2)


class AssumptionInvalidation(unittest.TestCase):
    def test_invalidate_adds_reason(self):
        s = srs.init_state()
        s = srs.invalidate_assumptions(s, 'driver_reported_damage:steering_alignment')
        self.assertIn('driver_reported_damage:steering_alignment',
                      s['strategy_assumptions_invalidated'])

    def test_invalidate_is_idempotent(self):
        s = srs.init_state()
        s = srs.invalidate_assumptions(s, 'x')
        s = srs.invalidate_assumptions(s, 'x')
        self.assertEqual(s['strategy_assumptions_invalidated'], ['x'])


class RecalculationTriggers(unittest.TestCase):
    def test_should_recalculate_true_for_known_reason(self):
        s = srs.init_state()
        self.assertTrue(srs.should_recalculate(s, 'driver_reported_damage'))

    def test_should_recalculate_false_for_unknown_reason(self):
        s = srs.init_state()
        self.assertFalse(srs.should_recalculate(s, 'made_up_reason'))

    def test_trigger_fires_once_per_dedupe_key(self):
        s = srs.init_state()
        self.assertTrue(srs.should_recalculate(s, 'driver_reported_damage', dedupe_key='steering_alignment@lap7'))
        s = srs.consume_trigger(s, 'driver_reported_damage', dedupe_key='steering_alignment@lap7')
        self.assertFalse(srs.should_recalculate(s, 'driver_reported_damage', dedupe_key='steering_alignment@lap7'))
        # A DIFFERENT instance (new dedupe key) can still fire.
        self.assertTrue(srs.should_recalculate(s, 'driver_reported_damage', dedupe_key='front_aero@lap9'))

    def test_fuel_deviation_threshold(self):
        self.assertFalse(srs.evaluate_fuel_deviation(3.6, 3.7))
        self.assertTrue(srs.evaluate_fuel_deviation(3.6, 4.0))
        self.assertFalse(srs.evaluate_fuel_deviation(None, 4.0))

    def test_pace_deviation_threshold(self):
        self.assertFalse(srs.evaluate_pace_deviation(108.0, 108.3))
        self.assertTrue(srs.evaluate_pace_deviation(108.0, 109.0))

    def test_recalculate_strategy_records_and_consumes(self):
        s = srs.init_state()
        s = srs.recalculate_strategy(
            s, reason='driver_reported_damage',
            baseline_fuel_l_per_lap=3.6, recent_fuel_l_per_lap=3.6,
            baseline_pace_s=108.0, recent_pace_s=None,
            previous_plan='A', selected_plan='A',
            driver_message='操舵異常の申告あり。通常ペース前提を外した。',
            session_time_s=430.0, lap=7, dedupe_key='steering_alignment@lap7')
        self.assertEqual(s['last_recalculation']['reason'], 'driver_reported_damage')
        self.assertFalse(srs.should_recalculate(
            s, 'driver_reported_damage', dedupe_key='steering_alignment@lap7'))

    def test_format_trace_matches_required_fields(self):
        s = srs.init_state()
        s = srs.record_driver_reported_damage(
            s, category='steering_alignment', raw_text='x', lap=7, session_time_s=1)
        s = srs.recalculate_strategy(
            s, reason='driver_reported_damage',
            baseline_fuel_l_per_lap=3.6, recent_fuel_l_per_lap=3.6,
            baseline_pace_s=108.0, recent_pace_s=None,
            previous_plan='A', selected_plan='A',
            driver_message='msg', session_time_s=430.0, lap=7)
        trace = srs.format_recalculation_trace(s['last_recalculation'])
        for field in ('STRATEGY_RECALCULATION', 'reason=', 'baseline_fuel_l_per_lap=',
                     'recent_fuel_l_per_lap=', 'baseline_pace_s=', 'recent_pace_s=',
                     'damage_observed=', 'driver_reported_damage=', 'previous_plan=',
                     'selected_plan=', 'driver_message='):
            self.assertIn(field, trace)


class PushGate(unittest.TestCase):
    def test_push_allowed_when_no_damage(self):
        s = srs.init_state()
        self.assertTrue(srs.push_allowed(s))

    def test_push_blocked_after_damage_before_recalculation(self):
        s = srs.init_state()
        s = srs.record_driver_reported_damage(
            s, category='steering_alignment', raw_text='x', lap=7, session_time_s=1)
        self.assertFalse(srs.push_allowed(s),
                         'push must be withheld until the post-damage recalculation runs')

    def test_push_allowed_after_damage_recalculation_completes(self):
        s = srs.init_state()
        s = srs.record_driver_reported_damage(
            s, category='steering_alignment', raw_text='x', lap=7, session_time_s=1)
        s = srs.recalculate_strategy(
            s, reason='driver_reported_damage',
            baseline_fuel_l_per_lap=3.6, recent_fuel_l_per_lap=3.6,
            baseline_pace_s=108.0, recent_pace_s=108.5,
            previous_plan='A', selected_plan='A', driver_message='msg',
            session_time_s=500.0, lap=8)
        self.assertTrue(srs.push_allowed(s))

    def test_push_blocked_if_recalculation_was_for_unrelated_reason(self):
        s = srs.init_state()
        # Earlier unrelated recalculation (clean 3 laps) predates the damage.
        s = srs.recalculate_strategy(
            s, reason='clean_3_laps_established',
            baseline_fuel_l_per_lap=3.6, recent_fuel_l_per_lap=3.6,
            baseline_pace_s=None, recent_pace_s=None,
            previous_plan='A', selected_plan='A', driver_message='msg',
            session_time_s=200.0, lap=3)
        s = srs.record_driver_reported_damage(
            s, category='steering_alignment', raw_text='x', lap=7, session_time_s=400)
        self.assertFalse(srs.push_allowed(s),
                         'a stale unrelated recalculation must not authorise push after new damage')


class SessionLifecycle(unittest.TestCase):
    def test_close_session_marks_closed(self):
        s = srs.init_state()
        s = srs.close_session(s)
        self.assertTrue(s['closed'])


if __name__ == '__main__':
    result = unittest.main(verbosity=2, exit=False).result
    if not result.wasSuccessful():
        raise SystemExit(1)
