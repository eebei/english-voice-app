#!/usr/bin/env python3
"""Build 266 — Codex差戻し#6：Bridge poll loop の完全再生テスト。

差戻し#6：「純関数を手で順番に呼ぶだけでは不可。保存telemetry／event fixtureから、
Bridgeの実際の受信→状態→再計算→broadcast→queue fate までを通す再生テストにする。」

ここで回しているのは `bridge.poll_iracing()` そのものである。
純関数を手で並べた擬似パイプラインではない。差し替えているのは reader / broadcast /
log / sleep という外界の境界だけで、判断・状態遷移・発話の生成は全て本番コードが行う。

外部APIは呼ばない（内部シミュレーション正本 §Non-negotiable rules 1）。
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import replay_harness as rh


LAP_S = 108.0
FUEL_PER_LAP = 3.6


def clean_laps(count, *, start_lap=1, start_fuel=40.0, start_time=100.0,
               lap_time=LAP_S, burn=FUEL_PER_LAP, frames_per_lap=3):
    """Frames for `count` completed clean laps.

    A lap completes when `LapLastLapTime` changes to a new valid value, which
    is exactly how the production loop detects it.
    """
    frames = []
    fuel = start_fuel
    t = start_time
    for i in range(count):
        lap = start_lap + i
        # 周中のフレーム（まだ前周のタイムが載っている）
        for f in range(frames_per_lap):
            frames.append(rh.make_frame(
                SessionTime=t, Lap=lap, FuelLevel=fuel,
                LapDistPct=0.2 + 0.2 * f,
                LapLastLapTime=lap_time + i * 0.01 - 0.01 if i else 0.0))
            t += 1.0
        fuel -= burn
        # S/F 通過：新しいラップタイムが載る＝この瞬間に周回確定
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap + 1, FuelLevel=fuel, LapDistPct=0.01,
            LapLastLapTime=lap_time + i * 0.01))
        t += 1.0
    return frames, fuel, t, start_lap + count


class PollLoopReplayWorks(unittest.TestCase):
    """まずハーネス自体が本番ループを回せていることを確かめる。"""

    def test_the_real_poll_loop_runs_over_saved_frames(self):
        frames = [rh.make_frame(SessionTime=float(i)) for i in range(6)]
        result = rh.replay(frames)
        self.assertEqual(result.frames_served, 6)

    def test_connection_and_session_info_are_emitted_by_production_code(self):
        frames = [rh.make_frame(SessionTime=float(i)) for i in range(6)]
        result = rh.replay(frames)
        types = {b.get('type') for b in result.broadcasts}
        self.assertIn('iracing_connected', types)
        self.assertIn('session_info', types)
        self.assertIn('telemetry_live', types)

    def test_no_external_api_is_reachable_from_the_replay(self):
        """原価ゲート：この再生は外部APIを一切呼べない。"""
        import replay_harness
        with open(replay_harness.__file__, encoding='utf-8') as harness_file:
            source = harness_file.read()
        for forbidden in ('requests', 'urllib', 'http.client', 'socket',
                          'anthropic', 'texttospeech'):
            self.assertNotIn('import %s' % forbidden, source)


class Monza20PipelineReplay(unittest.TestCase):
    """Monza 20 の動線を、保存フレームから本番ループで再生する。

    `briefing → active_plan → damage_observation → driver_report →
     recalculation → driver call → final-lap block` が一本の再生で追えること。
    """

    @classmethod
    def setUpClass(cls):
        frames, fuel, t, lap = clean_laps(5)

        # ── ボックス付近で接触。任意修理が"進入後に"立ち上がる ──────────
        for i in range(3):
            frames.append(rh.make_frame(
                SessionTime=t, Lap=lap, FuelLevel=fuel, LapDistPct=0.95,
                OnPitRoad=True, Speed=12.0,
                PitOptRepairLeft=0.0, PlayerCarMyIncidentCount=0))
            t += 1.0
        for i in range(4):
            frames.append(rh.make_frame(
                SessionTime=t, Lap=lap, FuelLevel=fuel, LapDistPct=0.96,
                OnPitRoad=True, Speed=0.0,
                PitOptRepairLeft=14.0, PlayerCarMyIncidentCount=2))
            t += 1.0
        # 任意修理を取らずに燃料だけでピットアウト（ライブ値は0へ戻る）
        for i in range(3):
            frames.append(rh.make_frame(
                SessionTime=t, Lap=lap, FuelLevel=fuel + 20.0, LapDistPct=0.99,
                OnPitRoad=False, Speed=25.0,
                PitOptRepairLeft=0.0, PlayerCarMyIncidentCount=2))
            t += 1.0

        # ── 接触後のクリーン周（燃費が悪化している）────────────────
        more, fuel2, t2, lap2 = clean_laps(
            4, start_lap=lap, start_fuel=fuel + 20.0, start_time=t,
            lap_time=LAP_S + 1.2, burn=FUEL_PER_LAP + 0.4)
        frames.extend(more)

        cls.frames = frames
        cls.result = rh.replay(frames)

    # ── 動線の各段 ────────────────────────────────────────────────
    def test_damage_observation_recorded_from_real_frames(self):
        self.assertTrue(self.result.logs_containing('SESSION RACE STATE damage_observation'),
                        'SDK damage evidence must be recorded by the live loop')

    def test_optional_repair_seen_after_pit_entry(self):
        """進入時0 → ボックス内で14秒。進入時スナップショットでは取れない形。"""
        seen = self.result.logs_containing('optional_repair_observed:')
        self.assertTrue(seen)
        self.assertIn('on_pit_road=True', seen[0])
        self.assertIn('max=14.0s', seen[0])

    def test_optional_repair_not_taken_survives_the_pit_out_reset(self):
        outcome = self.result.logs_containing('optional_repair_outcome=')
        self.assertTrue(outcome, 'the pit visit must produce an outcome verdict')
        self.assertIn('optional_repair_outcome=not_taken', outcome[0])
        self.assertIn('countdown_s=0.0', outcome[0],
                      'the repair never counted down — it was declined')

    def test_clean_three_laps_latch_fires_in_the_live_loop(self):
        traces = self.result.logs_containing('reason=clean_3_laps_established')
        self.assertTrue(traces, 'the baseline latch must fire from real laps')

    def test_baseline_pace_is_not_none(self):
        """Codex P1(#3a) の回帰：基準ペースがNoneで固定されないこと。"""
        trace = self.result.first_log('reason=clean_3_laps_established')
        self.assertIsNotNone(trace)
        self.assertNotIn('baseline_pace_s=None', trace)

    def test_recalculation_reaches_a_plan_outcome(self):
        outcomes = self.result.logs_containing('STRATEGY RECALCULATION OUTCOME')
        self.assertTrue(outcomes,
                        'a recalculation must reach the plan engine, not stop at a trace')

    def test_recalculation_selects_a_plan(self):
        outcome = self.result.first_log('STRATEGY RECALCULATION OUTCOME')
        self.assertIsNotNone(outcome)
        self.assertIn('selected_plan=', outcome)
        self.assertNotIn('selected_plan=None', outcome)

    def test_pipeline_order_is_observable_in_one_log(self):
        """一つの再生ログで動線が順に追えること。"""
        def first_index(*needles):
            for i, line in enumerate(self.result.logs):
                if all(n in line for n in needles):
                    return i
            return None
        baseline = first_index('STRATEGY RECALCULATION OUTCOME',
                               'reason=clean_3_laps_established')
        damage = first_index('SESSION RACE STATE damage_observation')
        damage_recalc = first_index('STRATEGY RECALCULATION OUTCOME',
                                    'reason=repair_detected_or_opt_not_taken')
        for label, value in (('baseline latch', baseline),
                             ('damage observation', damage),
                             ('damage recalculation', damage_recalc)):
            self.assertIsNotNone(value, '%s missing from the replay log' % label)
        # 基準確定 → 損傷検出 → その損傷による再計算、の順で一本のログに出る。
        self.assertLess(baseline, damage)
        self.assertLess(damage, damage_recalc,
                        'damage evidence must precede the recalculation it causes')

    def test_broadcasts_are_produced_by_the_live_loop(self):
        self.assertTrue(self.result.broadcasts)
        types = {b.get('type') for b in self.result.broadcasts}
        self.assertIn('telemetry_live', types)


class DriverReportReplay(unittest.TestCase):
    """ドライバー申告（会話STT → CMD キュー）が、実ループで状態と再計算へ到達する。"""

    def setUp(self):
        import bridge
        self.bridge = bridge

    def test_driver_report_reaches_recalculation_and_radio(self):
        frames, fuel, t, lap = clean_laps(4)
        frames.extend(rh.make_frame(SessionTime=t + i, Lap=lap, FuelLevel=fuel)
                      for i in range(6))
        # 会話側と同じ入口でキューへ積む（写経せず本番の関数を使う）。
        self.bridge._queue_driver_damage_report('フロント ステアリングコラム 周辺にダメージ')
        result = rh.replay(frames)

        traces = result.logs_containing('reason=driver_reported_damage')
        self.assertTrue(traces, 'the driver report must reach a recalculation')
        radio = result.by_trigger('strategy_recalculation')
        self.assertTrue(radio, 'the driver must hear something back')
        self.assertEqual(radio[0].get('reason'), 'driver_reported_damage')
        self.assertEqual(radio[0].get('category'), 'steering_or_front_end')
        self.assertIn('selected_plan', radio[0],
                      'the radio must carry the plan the recalculation chose')

    def test_unclassified_report_does_not_vanish_silently(self):
        frames, fuel, t, lap = clean_laps(3)
        frames.extend(rh.make_frame(SessionTime=t + i, Lap=lap, FuelLevel=fuel)
                      for i in range(4))
        self.bridge._queue_driver_damage_report('今日は暑いね')
        result = rh.replay(frames)
        self.assertTrue(result.logs_containing('unclassified'),
                        'an unmatched report must still be traced')


class LimiterOffOncePerPitCycle(unittest.TestCase):
    """★八木さん実走ログ 7-4（2026-08-11 18:46:51 / 18:47:00）。

    同一ピットアウトで「リミッターオフ」が2回鳴った。静的検査では再現できないので、
    実際のフレーム列を本番ループへ流して回数を数える。
    """

    def pit_cycle(self, *, flicker_after_exit=False, dwell_frames=6):
        """進入 → 停止 → 退出 のフレーム列。"""
        frames, fuel, t, lap = clean_laps(3)
        # 進入（リミッター作動）
        for _ in range(2):
            frames.append(rh.make_frame(SessionTime=t, Lap=lap, FuelLevel=fuel,
                                        OnPitRoad=True, Speed=18.0,
                                        EngineWarnings=0x10, LapDistPct=0.95))
            t += 1.0
        # ボックス停止
        for _ in range(dwell_frames):
            frames.append(rh.make_frame(SessionTime=t, Lap=lap, FuelLevel=fuel,
                                        OnPitRoad=True, Speed=0.0,
                                        EngineWarnings=0x10, LapDistPct=0.96))
            t += 1.0
        # 退出：リミッタービットが落ちる & OnPitRoad が False へ
        frames.append(rh.make_frame(SessionTime=t, Lap=lap, FuelLevel=fuel + 20.0,
                                    OnPitRoad=False, Speed=22.0,
                                    EngineWarnings=0, LapDistPct=0.99))
        t += 1.0
        if flicker_after_exit:
            # 実走で二度目を許した形：退出直後に OnPitRoad が1フレームだけ True へ戻る。
            frames.append(rh.make_frame(SessionTime=t, Lap=lap, FuelLevel=fuel + 20.0,
                                        OnPitRoad=True, Speed=20.0,
                                        EngineWarnings=0x10, LapDistPct=0.995))
            t += 1.0
            frames.append(rh.make_frame(SessionTime=t, Lap=lap, FuelLevel=fuel + 20.0,
                                        OnPitRoad=False, Speed=24.0,
                                        EngineWarnings=0, LapDistPct=0.999))
            t += 1.0
        for _ in range(3):
            frames.append(rh.make_frame(SessionTime=t, Lap=lap + 1, FuelLevel=fuel + 19.0,
                                        OnPitRoad=False, Speed=55.0,
                                        EngineWarnings=0, LapDistPct=0.1))
            t += 1.0
        return frames

    def test_one_pit_cycle_announces_limiter_off_once(self):
        result = rh.replay(self.pit_cycle())
        self.assertEqual(len(result.by_trigger('limiter_off')), 1)

    def test_a_flicker_after_exit_does_not_re_announce(self):
        """これが実走の二重発火そのもの。ちらつきで再武装してはいけない。"""
        result = rh.replay(self.pit_cycle(flicker_after_exit=True))
        fired = result.by_trigger('limiter_off')
        self.assertEqual(len(fired), 1,
                         'a one-frame OnPitRoad flicker must not re-arm the call')

    def test_suppression_is_traced_not_silent(self):
        result = rh.replay(self.pit_cycle(flicker_after_exit=True))
        self.assertTrue(
            result.logs_containing('LIMITER_OFF_SUPPRESSED reason=already_announced_for_pit_cycle'),
            'the suppressed second call must leave a trace')

    def test_a_genuine_second_stop_announces_again(self):
        frames = self.pit_cycle() + self.pit_cycle()
        result = rh.replay(frames)
        self.assertEqual(len(result.by_trigger('limiter_off')), 2,
                         'a real second pit stop must still get its call')

    def test_limiter_bit_alone_never_speaks(self):
        """ビットが落ちてもピットロードを出ていなければ喋らない。"""
        frames, fuel, t, lap = clean_laps(2)
        frames.append(rh.make_frame(SessionTime=t, Lap=lap, FuelLevel=fuel,
                                    OnPitRoad=False, Speed=30.0, EngineWarnings=0x10))
        frames.append(rh.make_frame(SessionTime=t + 1, Lap=lap, FuelLevel=fuel,
                                    OnPitRoad=False, Speed=32.0, EngineWarnings=0))
        result = rh.replay(frames)
        self.assertEqual(len(result.by_trigger('limiter_off')), 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
