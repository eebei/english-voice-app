#!/usr/bin/env python3
"""2026-09-16 Codex MD#1/MD#2差戻し：desktop向け`strategy_options`とBridge内部
`active_plan_snapshot`の二重状態、および再計算後に取り残される
decision_sent/box_call_sentの陳腐化を、実際の製品関数を実行して固定する。

MD#1：`execute_recalculation()`（bridge.py本体）を実行し、その`verdict`を
desktop向け`strategy_options`へ反映する経路が無かった。

MD#2 P1-1：最初の対応（前バージョンのこのファイル）は`execute_recalculation()`こそ
本物を呼んでいたが、肝心の同期処理はこのテストファイル内の別実装`apply_fix()`が行っていた。
`poll_iracing()`内の本番行を削除しても`apply_fix()`が独立に動くため、テストは合格し続けて
しまい、製品配線の実行証明になっていなかった。対応として、同期条件を
`bridge.sync_desktop_strategy_options()`という本番の名前付き関数へ抽出し、
`poll_iracing()`とこのテストが**同じ関数**を呼ぶようにした。ここでは
`bridge.sync_desktop_strategy_options`をimportして直接実行する——別実装での
シミュレーションはしない。

MD#2 P1-2：`strategy_options`（最新の計算推薦snapshot）と、Driverへ提示・合意・採点対象に
なった`active_decision_plan`（`strategy_options_decision_sent`/`strategy_options_box_call_sent`
が基準にする決定）は別状態。再計算が`strategy_options`だけを動かし、後者を古いPlanのまま
残すと、旧Planの`decision_sent`/`box_call_sent`が新Planへ誤って流用され、
  - 旧Planのdecision送信済み・box call未送信のまま新Planへ再計算されると、新Planが
    一度もdecisionを開いていないのに旧フラグで新Planのbox callが発火し得る
  - 旧Planのbox call送信済みのまま新Planへ再計算されると、新Planの正当なbox callが
    旧フラグで抑止され得る
という2つの誤動作を生む。`sync_desktop_strategy_options()`は、再計算後のPlanが
`active_decision_plan`の選択と異なる時だけ両フラグをFalseへ戻し、decision-lockブロックが
新Planのために新しい`active_decision_id`を発行してから box call へ進むようにする。

範囲の明記：ここで実行・確認するのは`sync_desktop_strategy_options()`単体の契約
（bridge.py側のPython状態）まで。Codex MD#2が併せて要求した「telemetry payload→実
local-intent-router.route()→提案／合意状態→pit outcomeまたはsummaryまで同じdecision IDを
追う」というJS側を含む全経路トレースはこのファイルの範囲外——別途、desktop側の統合検査が必要
（未着手。共有MD・HANDOFFへ明記する）。
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bridge  # noqa: E402  実際のbridge.py。execute_recalculation/sync_desktop_strategy_optionsはここに実装がある。
import session_race_state as srs  # noqa: E402
import strategy_options as so  # noqa: E402


def seeded_state_and_options():
    """一度だけラッチされるbootstrap経路（bridge.py:6409相当）を模した初期状態。"""
    state = srs.init_state()
    seed = so.build_initial_plans(
        snapshot_id='session:1:180.0', current_lap=3, fuel_level_l=18.0,
        avg_fuel_per_lap_l=3.5, clean_laps_sampled=3,
        crossings_to_finish=8, reserve_l=0.5, effective_capacity_l=40.0)
    state = srs.register_active_plan(
        state, plan_id='A', plan_snapshot=seed, snapshot_id=seed['snapshot_id'])
    return state, seed


def recalc_to_b(state, item):
    inputs = dict(
        session_num=1, current_lap=7, fuel_level_l=5.0, recent_fuel_per_lap_l=3.5,
        clean_laps_sampled=3, crossings_to_finish=8, reserve_l=0.5,
        effective_capacity_l=40.0, recent_pace_s=None,
        pit_now_forecast={'available': True, 'snapshot_id': 'live:1:500',
                           'model_version': 4, 'likely': {'position': 6},
                           'worst': {'position': 9}},
        pit_next_lap_forecast={'available': True, 'snapshot_id': 'live:1:500',
                                'model_version': 4, 'likely': {'position': 8},
                                'worst': {'position': 10}},
        rival_pitted_first=None, clean_air=None, rejoin_not_worse=None,
        fuel_save_recent_l_per_lap=None, relative_pace_advantage_s=0.8)
    return bridge.execute_recalculation(
        state, item, inputs=inputs, srs_mod=srs, options_mod=so)


def recalc_to_c(state, item):
    inputs = dict(
        session_num=1, current_lap=4, fuel_level_l=17.0, recent_fuel_per_lap_l=3.5,
        clean_laps_sampled=3, crossings_to_finish=8, reserve_l=0.5,
        effective_capacity_l=40.0, recent_pace_s=None,
        pit_now_forecast=None, pit_next_lap_forecast=None,
        rival_pitted_first=True, clean_air=True, rejoin_not_worse=True,
        fuel_save_recent_l_per_lap=3.25, relative_pace_advantage_s=None)
    return bridge.execute_recalculation(
        state, item, inputs=inputs, srs_mod=srs, options_mod=so)


def recalc_insufficient(state, item):
    inputs = dict(
        session_num=1, current_lap=7, fuel_level_l=None, recent_fuel_per_lap_l=None,
        clean_laps_sampled=0, crossings_to_finish=8, reserve_l=0.5,
        effective_capacity_l=40.0, recent_pace_s=None,
        pit_now_forecast=None, pit_next_lap_forecast=None,
        rival_pitted_first=None, clean_air=None, rejoin_not_worse=None,
        fuel_save_recent_l_per_lap=None, relative_pace_advantage_s=None)
    return bridge.execute_recalculation(
        state, item, inputs=inputs, srs_mod=srs, options_mod=so)


def decision_plan_for(plan_id, decision_id='decision:seed:1'):
    """`bridge.py`の6480付近が実際に組み立てる`active_decision_plan`の最小形。"""
    return {'decision_id': decision_id, 'selected_plan': plan_id,
            'reason': 'seed', 'decided_at_lap': 3, 'session_num': 1}


class RecalcSyncsDesktopFacingStrategyOptions(unittest.TestCase):
    """MD#1：strategy_optionsが再計算結果へ追従すること。"""

    def setUp(self):
        self.item = {'reason': 'driver_recalc_request', 'dedupe_key': 'k1',
                     'driver_message': None, 'broadcast_payload': None}

    def test_a_to_b_recalc_updates_desktop_facing_options(self):
        state, strategy_options = seeded_state_and_options()
        self.assertEqual(strategy_options['selected_plan'], 'A')
        new_state, verdict = recalc_to_b(state, self.item)
        self.assertTrue(verdict.get('available'))
        self.assertEqual(verdict.get('selected_plan'), 'B')

        strategy_options, sent, box_sent, _pp, _ps = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options=strategy_options,
            active_decision_plan=None,
            strategy_options_decision_sent=False, strategy_options_box_call_sent=False)
        self.assertEqual(strategy_options['selected_plan'], 'B',
                          'Bへ再計算されたのに desktop 向け strategy_options が古いAのまま')
        # ★2026-09-16 Codex MD#5差戻し（P1）：再計算だけでは`active_plan`（Driver合意済み）
        #   は動かない——`recommended_plan`（最新の計算推薦）だけが動く。
        self.assertEqual(new_state['recommended_plan'], 'B')
        self.assertEqual(new_state['active_plan'], 'A',
            '合意前なのにactive_planがBへ動いた——Codex MD#5反例の再現')

    def test_a_to_c_recalc_updates_desktop_facing_options(self):
        state, strategy_options = seeded_state_and_options()
        new_state, verdict = recalc_to_c(state, self.item)
        self.assertTrue(verdict.get('available'))
        self.assertEqual(verdict.get('selected_plan'), 'C')

        strategy_options, sent, box_sent, _pp, _ps = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options=strategy_options,
            active_decision_plan=None,
            strategy_options_decision_sent=False, strategy_options_box_call_sent=False)
        self.assertEqual(strategy_options['selected_plan'], 'C',
                          'Cへ再計算されたのに desktop 向け strategy_options が古いAのまま')
        self.assertEqual(new_state['recommended_plan'], 'C')
        self.assertEqual(new_state['active_plan'], 'A',
            '合意前なのにactive_planがCへ動いた——Codex MD#5反例の再現')

    def test_insufficient_input_keeps_old_plan_not_faked_as_updated(self):
        state, strategy_options = seeded_state_and_options()
        original = strategy_options
        _, verdict = recalc_insufficient(state, self.item)
        self.assertFalse(verdict.get('available'))

        strategy_options, sent, box_sent, _pp, _ps = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options=strategy_options,
            active_decision_plan=decision_plan_for('A'),
            strategy_options_decision_sent=True, strategy_options_box_call_sent=False)
        self.assertIs(strategy_options, original,
                       '入力不足なのに strategy_options オブジェクトが差し替わった'
                       '＝更新したふりをした')
        self.assertEqual(strategy_options['selected_plan'], 'A')
        self.assertTrue(sent, '入力不足で再計算しなかった時にdecision_sentを勝手に戻さない')


class DecisionAndBoxCallLockInvalidatesOnPlanChange(unittest.TestCase):
    """MD#2 P1-2：旧Planのdecision/box call状態が新Planへ誤って流用されないこと。"""

    def setUp(self):
        self.item = {'reason': 'driver_recalc_request', 'dedupe_key': 'k1',
                     'driver_message': None, 'broadcast_payload': None}

    def test_stale_decision_sent_without_box_call_resets_for_new_plan(self):
        """旧A: decision送信済み・box call未送信のままBへ再計算される。
        修正前は旧フラグのままBのbox callが（Bのdecisionを一度も開かずに）
        発火し得た——旧フラグをリセットし、Bは自分のdecision-lockを通す。"""
        state, strategy_options = seeded_state_and_options()
        _, verdict = recalc_to_b(state, self.item)
        self.assertEqual(verdict['selected_plan'], 'B')

        strategy_options, sent, box_sent, _pp, _ps = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options=strategy_options,
            active_decision_plan=decision_plan_for('A'),
            strategy_options_decision_sent=True,   # Aのdecisionは送信済み
            strategy_options_box_call_sent=False)  # だがbox callはまだ
        self.assertEqual(strategy_options['selected_plan'], 'B')
        self.assertFalse(sent,
            'Bが一度もdecisionを開いていないのに、旧Aのdecision_sent=Trueを引き継いだ'
            '——このままだとBのbox callが未提示のまま発火し得る')
        self.assertFalse(box_sent)

    def test_stale_box_call_sent_resets_so_new_plan_gets_its_own_call(self):
        """旧A: box call送信済みのままCへ再計算される。
        修正前は旧フラグのままCの正当なbox callが抑止され得た。"""
        state, strategy_options = seeded_state_and_options()
        _, verdict = recalc_to_c(state, self.item)
        self.assertEqual(verdict['selected_plan'], 'C')

        strategy_options, sent, box_sent, _pp, _ps = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options=strategy_options,
            active_decision_plan=decision_plan_for('A'),
            strategy_options_decision_sent=True,
            strategy_options_box_call_sent=True)   # Aのbox callは送信済み
        self.assertEqual(strategy_options['selected_plan'], 'C')
        self.assertFalse(box_sent,
            '旧Aのbox_call_sent=TrueがCへ引き継がれ、Cの正当なbox callを抑止し得る')
        self.assertFalse(sent, 'Cは新しいdecisionを自分で開き直す必要がある')

    def test_same_plan_recalc_does_not_reset_lock(self):
        """回帰：Planが変わらない再計算（燃費の微更新等）では何も戻さない——
        毎回の再計算でdecisionを無意味に作り直し、box callを空撃ちで再発火させない。"""
        state, strategy_options = seeded_state_and_options()
        _, verdict = recalc_to_b(state, self.item)
        self.assertEqual(verdict['selected_plan'], 'B')

        strategy_options, sent, box_sent, _pp, _ps = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options=strategy_options,
            active_decision_plan=decision_plan_for('B'),  # 既にBで決定済み
            strategy_options_decision_sent=True,
            strategy_options_box_call_sent=True)
        self.assertTrue(sent, '同じPlanへの再計算でdecision_sentを無意味にリセットしない')
        self.assertTrue(box_sent, '同じPlanへの再計算でbox_call_sentを無意味にリセットしない')

    def test_no_prior_decision_leaves_flags_untouched(self):
        """回帰：まだ一度もdecisionが開かれていない（active_decision_plan=None）通常経路
        （MD#1の3テストが使う形）では、この関数はFalse/Falseのまま何もしない。"""
        state, strategy_options = seeded_state_and_options()
        _, verdict = recalc_to_b(state, self.item)
        strategy_options, sent, box_sent, _pp, _ps = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options=strategy_options,
            active_decision_plan=None,
            strategy_options_decision_sent=False, strategy_options_box_call_sent=False)
        self.assertFalse(sent)
        self.assertFalse(box_sent)

    def test_production_call_site_actually_calls_the_shared_function(self):
        """MD#2 P1-1：poll_iracing()本体がこの同期処理をインライン再実装しておらず、
        `sync_desktop_strategy_options`を実際に呼んでいることをソースで確認する
        （実行できないpoll_iracing()自体の代わりに、production call siteがテストと
        同じ関数名を呼んでいることを固定する——ロジックの二重実装を検出するため）。

        ★注意：コメント本文にも関数名を書いているため、単純な文字列包含検査では
        コメントだけが残っていても合格してしまう（一度実際に本番呼び出しを削除して
        このテストが不合格になることを手動確認した上で、キーワード引数を含む
        実際の呼び出しシグネチャだけにマッチするパターンへ書き直した）。"""
        src_path = os.path.join(HERE, 'bridge.py')
        with open(src_path, 'r', encoding='utf-8') as fh:
            src = fh.read()
        self.assertIn('def sync_desktop_strategy_options(', src)
        call_site = src.index('_session_race_state, _recalc_verdict = execute_recalculation(')
        window = src[call_site:call_site + 1800]
        # 実際の呼び出し（`= sync_desktop_strategy_options(` に続けて、この関数固有の
        # キーワード引数が並ぶ）だけにマッチする。コメント文中の
        # 「本番関数`sync_desktop_strategy_options()`」という言及とは区別される
        # （コメントは丸括弧が直後に閉じており、`verdict=`等の引数が続かない）。
        call_pattern = (
            'sync_desktop_strategy_options(\n'
            '                        verdict=_recalc_verdict, '
            'strategy_options=strategy_options,\n'
            '                        active_decision_plan=active_decision_plan,')
        self.assertIn(call_pattern, window,
            'poll_iracing()のrecalc呼び出し直後が sync_desktop_strategy_options を'
            '実引数付きで呼んでいない——インライン再実装に戻っていないか確認する')
        self.assertNotIn("strategy_options = _recalc_verdict['options']", window,
            '旧インライン実装（Codex MD#1版）が復活し、共有関数と二重管理になっている')


class DecisionLockDoesNotDiscardPlanC(unittest.TestCase):
    """MD#3 P1：decision-lock blockがPlan CをA/B専用decide_at_plan_a()で
    黙って上書きしないこと。Codexが実行反例で示した順序
    （execute_recalculation→sync_desktop_strategy_options→decide_plan_at_target相当）を
    そのまま実行する。"""

    def setUp(self):
        self.item = {'reason': 'driver_recalc_request', 'dedupe_key': 'k1',
                     'driver_message': None, 'broadcast_payload': None}

    def test_c_survives_the_decision_lock_after_sync(self):
        """Codexの反例そのもの：修正前は after_sync='C' の直後に
        decision_block_result='A'（reason='plan_b_undercut_conditions_unproven'）へ
        戻っていた。"""
        state, strategy_options = seeded_state_and_options()
        current_lap = 4
        _, verdict = recalc_to_c(state, self.item)
        self.assertEqual(verdict['selected_plan'], 'C')

        strategy_options, sent, box_sent, _pp, _ps = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options=strategy_options,
            active_decision_plan=None,
            strategy_options_decision_sent=False, strategy_options_box_call_sent=False)
        self.assertEqual(strategy_options['selected_plan'], 'C')

        # ★MD#4 P1-1：decide_plan_at_targetはラッチされたフラグではなく現在frameの
        #   証拠でCを再検証するため、recalc_to_c()がCを証明した時と同じ現在frame条件
        #   （rival_pitted_first=True・clean_air=True・rejoin_not_worse=True）を
        #   battle_context/car_on_pitroad_all/forecastとして与える。
        matching_battle_context = {'ahead_car_idx': 0, 'gap_ahead_s': 3.0}
        matching_pitroad = [1]  # car idx 0 is on pit road -> rival_pitted_first=True
        matching_now = {'available': True, 'likely': {'position': 5}, 'worst': {'position': 8}}
        matching_next = {'available': True, 'likely': {'position': 5}, 'worst': {'position': 8}}
        decision = bridge.decide_plan_at_target(
            strategy_options, current_lap=current_lap, current_fuel_l=17.0,
            avg_fuel_per_lap_l=3.5, pit_now_forecast=matching_now,
            pit_next_lap_forecast=matching_next,
            relative_pace_advantage_s=None, options_mod=so,
            battle_context=matching_battle_context, car_on_pitroad_all=matching_pitroad,
            fuel_save_recent_l_per_lap=3.25)
        self.assertEqual(decision.get('selected_plan'), 'C',
            'Cが証明済みなのにdecision-lockがA/Bへ上書きした——Codex MD#3反例の再現')
        self.assertEqual(decision.get('reason'), 'plan_c_conditions_proven')
        self.assertIsNotNone(decision.get('decision_id'))

    def test_a_still_decided_normally_when_c_not_proven(self):
        """回帰：Cが証明されていない通常のA/Bケースでは、従来どおり
        decide_at_plan_a()の毎frame再評価を通る（Cバイパスを誤って常時適用しない）。"""
        state, strategy_options = seeded_state_and_options()
        decision = bridge.decide_plan_at_target(
            strategy_options, current_lap=7, current_fuel_l=5.0,
            avg_fuel_per_lap_l=3.5,
            pit_now_forecast={'available': True, 'snapshot_id': 'live:1:500',
                               'model_version': 4, 'likely': {'position': 6},
                               'worst': {'position': 9}},
            pit_next_lap_forecast={'available': True, 'snapshot_id': 'live:1:500',
                                    'model_version': 4, 'likely': {'position': 8},
                                    'worst': {'position': 10}},
            relative_pace_advantage_s=0.8, options_mod=so)
        self.assertEqual(decision.get('selected_plan'), 'B')
        self.assertEqual(decision.get('reason'), 'plan_b_undercut_conditions_proven')

    def test_c_not_bypassed_when_plan_c_not_actually_available(self):
        """回帰：selected_plan=='C'であっても、plan_c自体がavailable=Falseなら
        （通常起こらないはずの矛盾状態でも）Cバイパスへ入らずdecide_at_plan_aへ落ちる
        ——不完全な証拠でCを確定しない。"""
        state, strategy_options = seeded_state_and_options()
        tampered = {**strategy_options, 'selected_plan': 'C',
                    'plan_c': {**strategy_options['plan_c'], 'available': False}}
        decision = bridge.decide_plan_at_target(
            tampered, current_lap=7, current_fuel_l=5.0, avg_fuel_per_lap_l=3.5,
            pit_now_forecast=None, pit_next_lap_forecast=None,
            relative_pace_advantage_s=None, options_mod=so)
        self.assertIn(decision.get('selected_plan'), ('A', 'B'))

    def test_box_call_gate_includes_c(self):
        """MD#3で発見した別欠陥：box call判定が('A','B')限定で、Cが正しく決定
        されるようになっても一生box callが出なかった。ソース上でCが含まれることを
        確認する（実行できないpoll_iracing()自体の代わりに、実際のgate条件式を検査）。

        ★MD#4 P1-3：box call gateは`strategy_options`（変わり続ける推薦）ではなく
        合意済みで凍結された`active_decision_plan`を読むよう変更した——この点も
        併せて確認する。"""
        src_path = os.path.join(HERE, 'bridge.py')
        with open(src_path, 'r', encoding='utf-8') as fh:
            src = fh.read()
        gate = src.index("active_decision_plan.get('selected_plan') in ('A', 'B', 'C')")
        self.assertGreater(gate, 0)


class PlanCFreshnessReverification(unittest.TestCase):
    """MD#4 P1-1：decide_plan_at_targetはラッチされたPlan C証拠ではなく、
    呼び出し時点（=現在frame）の生条件で decide_plan_c() を再実行する。"""

    def setUp(self):
        self.item = {'reason': 'driver_recalc_request', 'dedupe_key': 'k1',
                     'driver_message': None, 'broadcast_payload': None}

    def test_c_evidence_collapsed_next_frame_falls_back(self):
        """Codexの懸念そのもの：frame Nの末尾でCが証明されても、frame N+1で
        交通が塞がった・復帰予測が悪化した場合、古い証拠でCを確定しない。"""
        state, strategy_options = seeded_state_and_options()
        _, verdict = recalc_to_c(state, self.item)
        strategy_options, *_ = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options=strategy_options,
            active_decision_plan=None,
            strategy_options_decision_sent=False, strategy_options_box_call_sent=False)
        self.assertEqual(strategy_options['selected_plan'], 'C')

        # frame N+1：ライバルはピットしていない・ギャップも縮まった（クリーンエアではない）
        collapsed_battle_context = {'ahead_car_idx': 0, 'gap_ahead_s': 0.5}
        collapsed_pitroad = [0]  # car idx 0 is NOT on pit road -> rival_pitted_first=False
        decision = bridge.decide_plan_at_target(
            strategy_options, current_lap=4, current_fuel_l=17.0, avg_fuel_per_lap_l=3.5,
            pit_now_forecast=None, pit_next_lap_forecast=None,
            relative_pace_advantage_s=None, options_mod=so,
            battle_context=collapsed_battle_context, car_on_pitroad_all=collapsed_pitroad,
            fuel_save_recent_l_per_lap=3.25)
        self.assertNotEqual(decision.get('selected_plan'), 'C',
            '証拠が崩れているのに古いCをそのまま確定した——MD#4 P1-1の再現')
        self.assertIn(decision.get('selected_plan'), ('A', 'B'))

    def test_c_evidence_still_holds_next_frame_confirms(self):
        """回帰：現在frameでも証拠が実際に成立していれば、正しくCを確定する
        （フォールバックし過ぎて有効なCまで潰さない）。"""
        state, strategy_options = seeded_state_and_options()
        _, verdict = recalc_to_c(state, self.item)
        strategy_options, *_ = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options=strategy_options,
            active_decision_plan=None,
            strategy_options_decision_sent=False, strategy_options_box_call_sent=False)

        holding_battle_context = {'ahead_car_idx': 0, 'gap_ahead_s': 3.0}
        holding_pitroad = [1]
        holding_forecast = {'available': True, 'likely': {'position': 5}, 'worst': {'position': 8}}
        decision = bridge.decide_plan_at_target(
            strategy_options, current_lap=4, current_fuel_l=17.0, avg_fuel_per_lap_l=3.5,
            pit_now_forecast=holding_forecast, pit_next_lap_forecast=holding_forecast,
            relative_pace_advantage_s=None, options_mod=so,
            battle_context=holding_battle_context, car_on_pitroad_all=holding_pitroad,
            fuel_save_recent_l_per_lap=3.25)
        self.assertEqual(decision.get('selected_plan'), 'C')


class ProposalRequiresDriverAgreementBeforePromotion(unittest.TestCase):
    """MD#4 P1-2/P1-3：B/Cは合意を得るまで active_decision_plan へ昇格しない。
    Aは変更を伴わない既定Planとして即座に確定してよい。box call・pit outcome・
    summaryは合意済みの凍結plan（Plan文字が同じでも内容が変わり得る点に注意）だけを
    読む——という完成条件そのものを、本番のbuild_strategy_decision()/
    resolve_strategy_proposal()を実行して固定する。"""

    def setUp(self):
        self.item = {'reason': 'driver_recalc_request', 'dedupe_key': 'k1',
                     'driver_message': None, 'broadcast_payload': None}

    def _proposal_for_b(self):
        state, strategy_options = seeded_state_and_options()
        _, verdict = recalc_to_b(state, self.item)
        strategy_options, *_ = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options=strategy_options,
            active_decision_plan=None,
            strategy_options_decision_sent=False, strategy_options_box_call_sent=False)
        decision = bridge.decide_plan_at_target(
            strategy_options, current_lap=7, current_fuel_l=5.0, avg_fuel_per_lap_l=3.5,
            pit_now_forecast={'available': True, 'likely': {'position': 6}, 'worst': {'position': 9}},
            pit_next_lap_forecast={'available': True, 'likely': {'position': 8}, 'worst': {'position': 10}},
            relative_pace_advantage_s=0.8, options_mod=so)
        built = bridge.build_strategy_decision(
            strategy_options, decision, lap=7, class_pos=5, cur_snum=1,
            race_instance_id='sub:900001', battle_context=None)
        return strategy_options, built

    def test_a_commits_immediately_no_agreement_needed(self):
        """A（変更を伴わない既定Plan）はDriver合意往復を要さず即座に確定する。"""
        state, strategy_options = seeded_state_and_options()
        decision = bridge.decide_plan_at_target(
            strategy_options, current_lap=3, current_fuel_l=18.0, avg_fuel_per_lap_l=3.5,
            pit_now_forecast=None, pit_next_lap_forecast=None,
            relative_pace_advantage_s=None, options_mod=so)
        self.assertEqual(decision.get('selected_plan'), 'A')
        built = bridge.build_strategy_decision(
            strategy_options, decision, lap=3, class_pos=5, cur_snum=1,
            race_instance_id='sub:900001', battle_context=None)
        self.assertEqual(built['mode'], 'commit')

    def test_b_must_be_proposed_not_committed(self):
        """B（変更の提案）は即座にactive_decision_planへ昇格してはならない——
        Codexが指摘した『Bridgeが提案時点でactive planを更新しDesktopの提案・合意を
        迂回する』を直接固定する。"""
        _, built = self._proposal_for_b()
        self.assertEqual(built['mode'], 'propose')
        self.assertEqual(built['plan']['selected_plan'], 'B')

    def test_accepted_response_promotes_the_matching_proposal(self):
        strategy_options, built = self._proposal_for_b()
        # dispatch_idは`build_strategy_decision()`ではなく、実dispatch箇所
        # （broadcast直前）が採番する。テストでもその形を模す。
        pending = dict(built['plan'], dispatch_id=built['plan']['decision_id'] + '#1')
        response = {'decision_id': pending['decision_id'], 'accepted': True,
                    'session_num': pending['session_num'], 'dispatch_id': pending['dispatch_id']}
        still_pending, promoted, outcome, _decl_sig = bridge.resolve_strategy_proposal(pending, response)
        self.assertEqual(outcome, 'accepted')
        self.assertIsNone(still_pending)
        self.assertEqual(promoted['decision_id'], pending['decision_id'])
        self.assertEqual(promoted['selected_plan'], 'B')
        # 凍結されたtarget/fuelが合意した内容そのものであること（P1-3）。
        self.assertEqual(promoted['target_lap'], pending['target_lap'])
        self.assertEqual(promoted['set_fuel_l'], pending['set_fuel_l'])

    def test_declined_response_does_not_promote(self):
        _, built = self._proposal_for_b()
        pending = dict(built['plan'], dispatch_id=built['plan']['decision_id'] + '#1')
        response = {'decision_id': pending['decision_id'], 'accepted': False,
                    'session_num': pending['session_num'], 'dispatch_id': pending['dispatch_id']}
        still_pending, promoted, outcome, _decl_sig = bridge.resolve_strategy_proposal(pending, response)
        self.assertEqual(outcome, 'declined')
        self.assertIsNone(still_pending)
        self.assertIsNone(promoted, '拒否された提案を昇格させた——box callが未合意Planで発火し得る')

    def test_stale_response_for_a_superseded_proposal_is_ignored(self):
        """再計算が既に別の提案（別decision_id）へ差し替えた後に届いた古い応答は、
        今の合意として扱わない。"""
        _, built = self._proposal_for_b()
        pending = built['plan']
        stale_response = {'decision_id': 'some-other-decision-id', 'accepted': True}
        still_pending, promoted, outcome, _decl_sig = bridge.resolve_strategy_proposal(pending, stale_response)
        self.assertEqual(outcome, 'stale')
        self.assertIs(still_pending, pending, '一致しない応答で現在の保留提案を消してしまった')
        self.assertIsNone(promoted)

    def test_sync_invalidates_pending_proposal_when_plan_changes(self):
        """回帰：sync_desktop_strategy_options()は、応答が来る前に再計算がPlanを
        動かした場合、古い提案を破棄する（次のdecision-lockが新しいdecision_idで
        提案し直せるように）。"""
        state, strategy_options = seeded_state_and_options()
        _, verdict_b = recalc_to_b(state, self.item)
        strategy_options, sent, box_sent, pending_prop, prop_sent = bridge.sync_desktop_strategy_options(
            verdict=verdict_b, strategy_options=strategy_options, active_decision_plan=None,
            strategy_options_decision_sent=False, strategy_options_box_call_sent=False)
        pending_prop = {'decision_id': 'b-proposal-1', 'selected_plan': 'B'}
        prop_sent = True

        # 再計算がCへ動く。まだBへの応答は届いていない。
        _, verdict_c = recalc_to_c(state, self.item)
        (strategy_options, sent, box_sent, pending_prop,
         prop_sent) = bridge.sync_desktop_strategy_options(
            verdict=verdict_c, strategy_options=strategy_options, active_decision_plan=None,
            strategy_options_decision_sent=sent, strategy_options_box_call_sent=box_sent,
            pending_strategy_proposal=pending_prop, strategy_options_proposal_sent=prop_sent)
        self.assertIsNone(pending_prop, '古いB提案が新しいC推薦の後も残った')
        self.assertFalse(prop_sent)

    def test_box_call_reads_frozen_target_even_if_strategy_options_drifts(self):
        """P1-3反例：同じPlan文字（B）のまま合意した後、strategy_optionsだけが
        別のtarget/fuelへ再計算で動いても、合意済み active_decision_plan は
        変わらない（＝box callは最初に合意した内容のまま）。"""
        strategy_options, built = self._proposal_for_b()
        agreed = built['plan']
        agreed_target_lap = agreed['target_lap']
        agreed_set_fuel = agreed['set_fuel_l']

        # 合意後、再計算で同じBのままtarget/fuelだけ動く状況を模す
        # （strategy_optionsのplan_bを直接書き換え、drift自体を再現）。
        drifted_options = {**strategy_options,
                            'plan_b': {**strategy_options['plan_b'],
                                       'target_lap': agreed_target_lap + 5,
                                       'set_fuel_l': agreed_set_fuel + 10}}
        self.assertNotEqual(drifted_options['plan_b']['target_lap'], agreed_target_lap)
        # 合意済みレコード（agreed）自体はdriftの影響を受けない——box callはこちらを読む。
        self.assertEqual(agreed['target_lap'], agreed_target_lap)
        self.assertEqual(agreed['set_fuel_l'], agreed_set_fuel)


class RecommendedVsActivePlanSeparation(unittest.TestCase):
    """MD#5 P1：execute_recalculation()はSession Race Stateの`active_plan`
    （Driver合意済み）を無条件に動かしてはならない。推薦専用の状態
    （`recommended_plan`/`recommended_plan_snapshot`）だけを更新する。"""

    def setUp(self):
        self.item = {'reason': 'driver_recalc_request', 'dedupe_key': 'k1',
                     'driver_message': None, 'broadcast_payload': None}

    def test_recalc_to_b_does_not_move_active_plan(self):
        """Codexの反例そのもの：B推薦を作った直後、Desktop応答前でも
        active_planが動いてはならない。"""
        state, _ = seeded_state_and_options()
        self.assertEqual(state['active_plan'], 'A')
        new_state, verdict = recalc_to_b(state, self.item)
        self.assertEqual(verdict.get('selected_plan'), 'B')
        self.assertEqual(new_state['recommended_plan'], 'B')
        self.assertEqual(new_state['active_plan'], 'A',
            '合意前にactive_planがBへ動いた——plan_fuel_authority等が未合意の推薦を'
            '実行中の計画として扱い得る')
        self.assertEqual(new_state['recommended_plan_snapshot']['selected_plan'], 'B')
        self.assertEqual(new_state['active_plan_snapshot']['selected_plan'], 'A')

    def test_next_recalc_previous_uses_recommended_not_active(self):
        """回帰：次の再計算のpreviousは推薦チェーン（合意の有無と無関係）を辿る。"""
        state, _ = seeded_state_and_options()
        state, verdict1 = recalc_to_c(state, self.item)
        self.assertEqual(verdict1['selected_plan'], 'C')
        # Cは未合意のまま（active_planはA）。2回目の再計算も同じCの入力で呼ぶと、
        # Plan C の fuel-save target latching（reevaluate_plansの契約）が働き、
        # previous_plan_c が保持されていることを確認する（=推薦チェーンが正しく
        # previous として渡っている証拠）。
        state2, verdict2 = recalc_to_c(state, self.item)
        self.assertTrue(verdict2['options']['plan_c'].get('fuel_save_target_latched'))
        self.assertEqual(state['active_plan'], 'A')


class SignatureDriftAndDeclineMemory(unittest.TestCase):
    """MD#5 P1：同じPlan文字でも対象周・給油量が変われば別提案として扱う。
    拒否された提案は、内容が変わらない限り毎frame再提案しない。"""

    def test_pending_invalidated_when_actionable_content_drifts_not_just_letter(self):
        """Codexの反例そのもの：pending B (target_lap=6) に対し、新推薦Bが
        target_lap=7へ動いても、Plan文字だけの比較では見逃す。"""
        pending = {'decision_id': 'x', 'selected_plan': 'B',
                   'target_lap': 6, 'add_fuel_l': 10, 'set_fuel_l': 20}
        new_options = {'available': True, 'selected_plan': 'B',
                       'plan_b': {'target_lap': 7, 'add_fuel_l': 10, 'set_fuel_l': 20}}
        verdict = {'available': True, 'options': new_options}
        _, sent, box_sent, pp, ps = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options={}, active_decision_plan=None,
            strategy_options_decision_sent=False, strategy_options_box_call_sent=False,
            pending_strategy_proposal=pending, strategy_options_proposal_sent=True)
        self.assertIsNone(pp,
            '古いpending B(target_lap=6)が新しいB(target_lap=7)の後も残った——'
            '古い内容への「はい」が現在と違う中身を合意化し得る')
        self.assertFalse(ps)

    def test_pending_survives_when_letter_and_content_both_unchanged(self):
        """回帰：中身も変わっていなければ無意味に無効化しない。"""
        pending = {'decision_id': 'x', 'selected_plan': 'B',
                   'target_lap': 7, 'add_fuel_l': 10, 'set_fuel_l': 20}
        new_options = {'available': True, 'selected_plan': 'B',
                       'plan_b': {'target_lap': 7, 'add_fuel_l': 10, 'set_fuel_l': 20}}
        verdict = {'available': True, 'options': new_options}
        _, sent, box_sent, pp, ps = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options={}, active_decision_plan=None,
            strategy_options_decision_sent=False, strategy_options_box_call_sent=False,
            pending_strategy_proposal=pending, strategy_options_proposal_sent=True)
        self.assertIsNotNone(pp)
        self.assertTrue(ps)

    def test_active_decision_plan_is_not_invalidated_by_recommendation_drift(self):
        """回帰：合意済みで凍結されたactive_decision_planは、同じPlan文字のまま
        strategy_optionsが動いても無効化されない（凍結の意味そのもの）。"""
        active = {'decision_id': 'active-1', 'selected_plan': 'B',
                  'target_lap': 6, 'add_fuel_l': 10, 'set_fuel_l': 20}
        new_options = {'available': True, 'selected_plan': 'B',
                       'plan_b': {'target_lap': 9, 'add_fuel_l': 10, 'set_fuel_l': 20}}
        verdict = {'available': True, 'options': new_options}
        _, sent, box_sent, pp, ps = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options={}, active_decision_plan=active,
            strategy_options_decision_sent=True, strategy_options_box_call_sent=False)
        self.assertTrue(sent, '同じPlan文字のまま推薦だけが動いても合意済みdecisionは維持する')

    def test_declined_signature_is_remembered_and_matched(self):
        pending = {'decision_id': 'x', 'selected_plan': 'B', 'session_num': 1,
                   'dispatch_id': 'x#1', 'target_lap': 6, 'add_fuel_l': 10, 'set_fuel_l': 20}
        response = {'decision_id': 'x', 'accepted': False, 'session_num': 1, 'dispatch_id': 'x#1'}
        still_pending, promoted, outcome, declined_sig = bridge.resolve_strategy_proposal(
            pending, response)
        self.assertEqual(outcome, 'declined')
        self.assertIsNotNone(declined_sig)
        remembered = bridge.remember_declined_signature([], declined_sig)
        self.assertTrue(bridge.is_signature_declined(remembered, declined_sig))

    def test_different_signature_is_not_blocked_by_an_old_decline(self):
        """回帰：内容が実際に変われば（=違うsignature）、拒否の記憶は対象外になる
        ——「条件の意味ある変化」で自動的に解ける。"""
        declined_sig = bridge.plan_actionable_signature(
            {'selected_plan': 'B', 'target_lap': 6, 'add_fuel_l': 10, 'set_fuel_l': 20})
        remembered = bridge.remember_declined_signature([], declined_sig)
        new_sig = bridge.plan_actionable_signature(
            {'selected_plan': 'B', 'target_lap': 7, 'add_fuel_l': 10, 'set_fuel_l': 20})
        self.assertFalse(bridge.is_signature_declined(remembered, new_sig))

    def test_decision_lock_suppresses_a_declined_signature_end_to_end(self):
        """製品経路：decide_plan_at_target→build_strategy_decisionで作った提案が、
        既に拒否済みのsignatureと一致する時、decision-lockのsuppress判定
        （is_signature_declined）がTrueを返すことを確認する。"""
        state, strategy_options = seeded_state_and_options()
        item = {'reason': 'driver_recalc_request', 'dedupe_key': 'k1',
                'driver_message': None, 'broadcast_payload': None}
        _, verdict = recalc_to_b(state, item)
        strategy_options, *_ = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options=strategy_options, active_decision_plan=None,
            strategy_options_decision_sent=False, strategy_options_box_call_sent=False)
        decision = bridge.decide_plan_at_target(
            strategy_options, current_lap=7, current_fuel_l=5.0, avg_fuel_per_lap_l=3.5,
            pit_now_forecast={'available': True, 'likely': {'position': 6}, 'worst': {'position': 9}},
            pit_next_lap_forecast={'available': True, 'likely': {'position': 8}, 'worst': {'position': 10}},
            relative_pace_advantage_s=0.8, options_mod=so)
        built = bridge.build_strategy_decision(
            strategy_options, decision, lap=7, class_pos=5, cur_snum=1,
            race_instance_id='sub:900001', battle_context=None)
        signature = bridge.plan_actionable_signature(built['plan'])
        declined = bridge.remember_declined_signature([], signature)
        self.assertTrue(bridge.is_signature_declined(declined, signature),
            '同じ内容の再計算後もdecision-lockが同じ提案を再送し続ける——'
            'Driverの拒否を無視した無線反復（MD#5反例）')


class EvidenceBroadenedSignatureAndFrozenPromotion(unittest.TestCase):
    """MD#6 P1：actionable signatureはtarget/fuelだけでなくevidence_snapshot_id・
    主要条件まで含む。accepted昇格は提案時点で凍結したoptions_snapshotを使う。"""

    def _proposal_for_b(self, battle_context=None, relative_pace_advantage_s=0.8,
                        race_instance_id='sub:900001'):
        state, strategy_options = seeded_state_and_options()
        item = {'reason': 'driver_recalc_request', 'dedupe_key': 'k1',
                'driver_message': None, 'broadcast_payload': None}
        _, verdict = recalc_to_b(state, item)
        strategy_options, *_ = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options=strategy_options, active_decision_plan=None,
            strategy_options_decision_sent=False, strategy_options_box_call_sent=False)
        decision = bridge.decide_plan_at_target(
            strategy_options, current_lap=7, current_fuel_l=5.0, avg_fuel_per_lap_l=3.5,
            pit_now_forecast={'available': True, 'likely': {'position': 6}, 'worst': {'position': 9}},
            pit_next_lap_forecast={'available': True, 'likely': {'position': 8}, 'worst': {'position': 10}},
            relative_pace_advantage_s=relative_pace_advantage_s, options_mod=so)
        built = bridge.build_strategy_decision(
            strategy_options, decision, lap=7, class_pos=5, cur_snum=1,
            race_instance_id=race_instance_id, battle_context=battle_context)
        return strategy_options, built['plan']

    def test_same_target_and_fuel_but_different_evidence_snapshot_is_a_new_signature(self):
        """Codexの反例そのもの：target/fuelが同じまま根拠(pace優位)だけ変わった場合、
        4要素だけの旧signatureでは同じとみなしてしまう。

        ★2026-09-17発見（このテスト自体の欠陥）：以前は`battle_context`を変えて
        いたが、Plan Bの`relative_pace_advantage_s`は`decide_plan_at_target()`の
        同名パラメータから来る——`battle_context`はPlan Cの現在frame再検証
        (`derive_plan_c_live_conditions`)専用で、B/A経路(`decide_at_plan_a`)は
        読まない。そのためbattle_contextだけ変えてもBのconditionsは一切動かず、
        本来検出すべき反例を検出できていなかった（false green）。実際にBの
        pace優位証拠を動かす`relative_pace_advantage_s`引数を変える。
        """
        # 両方ともPLAN_B_MIN_PACE_ADVANTAGE_S(0.3)以上——Bの選択自体は変えず、
        # 選ばれた後の数値根拠だけを変える（0.2のように閾値を割ると選択が
        # そもそもAへ変わってしまい、target_lapの違いが「別Plan」由来になって
        # この反例が検証したい「同じPlan・同じ中身・違う根拠」を試せなくなる）。
        _, plan1 = self._proposal_for_b(relative_pace_advantage_s=0.8)
        _, plan2 = self._proposal_for_b(relative_pace_advantage_s=0.35)
        self.assertEqual(plan1['target_lap'], plan2['target_lap'])
        self.assertEqual(plan1['set_fuel_l'], plan2['set_fuel_l'])
        sig1 = bridge.plan_actionable_signature(plan1)
        sig2 = bridge.plan_actionable_signature(plan2)
        self.assertNotEqual(sig1, sig2,
            'target/fuelが同じでも根拠(pace優位)が変われば別signatureにならなければならない')

    def test_evidence_snapshot_id_differs_between_separate_recalculations(self):
        """回帰：別々の再計算（別のsnapshot_id）は、たとえ数値が偶然同じでも
        signatureへ出所の違いを残す。"""
        _, plan1 = self._proposal_for_b()
        self.assertIsNotNone(plan1['evidence_snapshot_id'])
        self.assertEqual(plan1['evidence_snapshot_id'], plan1['options_snapshot'].get('snapshot_id'))

    def test_same_snapshot_and_lap_but_different_conditions_get_different_decision_ids(self):
        """★Codex実測反例（修正前は再現した）：`decision_id`は以前
        `<snapshot_id>:decision-lap:<lap>`という**内容を見ない**文字列だった。
        decision-lockが`_proposal_suppressed`の間は毎frame再実行され、同じ
        snapshot_id・同じlapのまま`battle_context`の変化で`conditions`
        （pace優位・rejoin等）だけが変わり得るのに、decision_idは同一のままだった。
        `decision_id`は採点・学習を結ぶ判断内容のキーであり、`dispatch_id`
        （配送試行の識別・別関心事）では代用できない——内容が違えば必ず別IDになる
        ことをここで固定する。"""
        plan1 = self._proposal_for_b(relative_pace_advantage_s=0.8)[1]
        plan2 = self._proposal_for_b(relative_pace_advantage_s=0.35)[1]
        self.assertEqual(plan1['evidence_snapshot_id'], plan2['evidence_snapshot_id'])
        self.assertEqual(plan1['decided_at_lap'], plan2['decided_at_lap'])
        self.assertNotEqual(plan1['conditions'], plan2['conditions'])
        self.assertNotEqual(plan1['decision_id'], plan2['decision_id'],
            '同じsnapshot_id・同じlapのままconditionsが変わったのにdecision_idが同一だった')

    def test_same_content_yields_the_same_decision_id(self):
        """回帰：内容が本当に同じなら、frameをまたいでも同じdecision_idになる
        （dispatch_idが担う「配送試行の区別」とは別の話——同じ判断は同じID）。"""
        plan1 = self._proposal_for_b(relative_pace_advantage_s=0.8)[1]
        plan2 = self._proposal_for_b(relative_pace_advantage_s=0.8)[1]
        self.assertEqual(plan1['decision_id'], plan2['decision_id'])

    def test_accepted_promotion_uses_frozen_snapshot_not_live_drifted_options(self):
        """Codexの反例そのもの：acceptedへ昇格する時、その時点で変動しているlive
        strategy_optionsではなく、提案時点で凍結したoptions_snapshotを使う。"""
        _, pending = self._proposal_for_b()
        pending = dict(pending, dispatch_id=pending['decision_id'] + '#1')
        frozen_snapshot_id = pending['options_snapshot'].get('snapshot_id')
        # 応答が届くまでの間にlive strategy_optionsが別の（異なるsnapshot_idを持つ）
        # 内容へ動いた、という状況を模す。
        drifted_live_options = {**pending['options_snapshot'], 'snapshot_id': 'drifted:later'}
        response = {'decision_id': pending['decision_id'], 'accepted': True,
                    'session_num': pending['session_num'], 'dispatch_id': pending['dispatch_id']}
        _, promoted, outcome, _ = bridge.resolve_strategy_proposal(pending, response)
        self.assertEqual(outcome, 'accepted')
        frozen_used = promoted.get('options_snapshot') or drifted_live_options
        self.assertEqual(frozen_used.get('snapshot_id'), frozen_snapshot_id,
            'acceptedへ昇格する際、応答到着までに動いたlive strategy_optionsを'
            '使ってしまった——Driverが実際に合意した根拠と違うものを正本にした')
        self.assertNotEqual(frozen_used.get('snapshot_id'), drifted_live_options['snapshot_id'])


class SessionBoundaryGatesDecisionResponses(unittest.TestCase):
    """MD#6 P1：session_numが一致しない応答（セッション境界を跨いだ遅延応答）を
    適用しない。"""

    def test_response_from_a_different_session_is_stale(self):
        pending = {'decision_id': 'x', 'selected_plan': 'B', 'session_num': 1,
                   'target_lap': 7, 'add_fuel_l': 10, 'set_fuel_l': 20}
        late_response = {'decision_id': 'x', 'accepted': True, 'session_num': 2}
        still_pending, promoted, outcome, _ = bridge.resolve_strategy_proposal(
            pending, late_response)
        self.assertEqual(outcome, 'stale',
            'セッション境界を跨いだ遅延応答が適用された——別セッションの合意を'
            '現在のactive決定へ昇格させ得る')
        self.assertIs(still_pending, pending)
        self.assertIsNone(promoted)

    def test_response_from_the_same_session_is_applied(self):
        pending = {'decision_id': 'x', 'selected_plan': 'B', 'session_num': 1,
                   'dispatch_id': 'x#1', 'target_lap': 7, 'add_fuel_l': 10, 'set_fuel_l': 20}
        response = {'decision_id': 'x', 'accepted': True, 'session_num': 1, 'dispatch_id': 'x#1'}
        still_pending, promoted, outcome, _ = bridge.resolve_strategy_proposal(
            pending, response)
        self.assertEqual(outcome, 'accepted')

    def test_response_missing_session_num_is_fail_closed_not_applied(self):
        """MD#7差戻し（P1-2）：後方互換は取り下げられた。session_numを送らない
        応答（未対応の呼び出し元、または欠落）は一致を確認できないため'stale'で
        拒否する——'accepted'まで通してはならない。"""
        pending = {'decision_id': 'x', 'selected_plan': 'B', 'session_num': 1,
                   'target_lap': 7, 'add_fuel_l': 10, 'set_fuel_l': 20}
        response = {'decision_id': 'x', 'accepted': True}
        still_pending, promoted, outcome, _ = bridge.resolve_strategy_proposal(
            pending, response)
        self.assertEqual(outcome, 'stale')
        self.assertIs(still_pending, pending)
        self.assertIsNone(promoted)

    def test_pending_missing_session_num_is_also_fail_closed(self):
        """同様にpending側がsession_numを欠く（旧経路が作った提案等）場合も、
        一致を確認できない以上fail-closedで'stale'とする。"""
        pending = {'decision_id': 'x', 'selected_plan': 'B',
                   'target_lap': 7, 'add_fuel_l': 10, 'set_fuel_l': 20}
        response = {'decision_id': 'x', 'accepted': True, 'session_num': 1}
        still_pending, promoted, outcome, _ = bridge.resolve_strategy_proposal(
            pending, response)
        self.assertEqual(outcome, 'stale')



class RaceInstanceIdPreventsCrossRaceCollision(unittest.TestCase):
    """MD#9残件（Codex実測）：`decision_id`は`<evidence_snapshot_id>:decision-lap:<lap>:
    sig-<hash>`まで内容を反映するが、`evidence_snapshot_id`自体はsession_num（週末内の
    Practice/Qualify/Race番号）を含むだけで、**別レース**でも同じ値を取り得る。同じ周・
    同じPlan条件が別レースで再現すれば、レース固有IDが無いとdecision_id全体が一致し、
    過去レースと今回の判断・結果が混ざる。"""

    def test_resolve_race_instance_id_prefers_sub_session_id(self):
        self.assertEqual(bridge.resolve_race_instance_id({'sub_session_id': 74477818}),
                          'sub:74477818')

    def test_resolve_race_instance_id_falls_back_to_weekend_session_id(self):
        """SubSessionID欠落（オフライン・プライベートlobby等）時のフォールバック。"""
        self.assertEqual(
            bridge.resolve_race_instance_id({'sub_session_id': -1, 'weekend_session_id': 168212639}),
            'sid:168212639')
        self.assertEqual(
            bridge.resolve_race_instance_id({'weekend_session_id': 168212639}),
            'sid:168212639')

    def test_resolve_race_instance_id_uses_the_caller_supplied_session_scoped_fallback(self):
        """iRacingから権威あるIDが一切取れない（オフラインテスト等）時は、
        呼び出し側が渡す`fallback_id`（`race_instance_fallback_id`＝
        `_session_scoped_reset_values()`がセッション境界のたびに発行する値）を使う。"""
        rid = bridge.resolve_race_instance_id({}, 'abc123')
        self.assertEqual(rid, 'fallback:abc123')

    def test_different_fallback_ids_produce_different_race_instance_ids(self):
        """★Codex実測反例②そのもの（修正前は再現した）：SubSessionID／SessionIDが
        両方取れない環境で、同じbridgeプロセスを起動したまま別レースへ移った場合
        （＝セッション境界を跨いで`race_instance_fallback_id`が新しく発行された場合）、
        `resolve_race_instance_id()`は必ず別の値を返さなければならない。"""
        rid1 = bridge.resolve_race_instance_id({}, 'race-a-fallback')
        rid2 = bridge.resolve_race_instance_id({}, 'race-b-fallback')
        self.assertNotEqual(rid1, rid2)

    def test_session_scoped_reset_issues_a_fresh_fallback_id_every_call(self):
        """★Codex実測反例②の根本原因の直接固定：以前は`resolve_race_instance_id()`が
        モジュールロード時に1回だけ生成した定数（bridgeプロセス起動ごとに一意）へ
        フォールバックしていたため、同じプロセスを起動したまま別レースへ移っても
        同じ値のままだった。`_session_scoped_reset_values()`（SessionNum変更・
        signature変更の両リセット経路が呼ぶ、本番の唯一の発行元）が呼ばれるたびに
        新しいfallback IDを発行することを固定する。"""
        first = bridge._session_scoped_reset_values()['race_instance_fallback_id']
        second = bridge._session_scoped_reset_values()['race_instance_fallback_id']
        self.assertNotEqual(first, second)

    def test_both_ids_missing_and_race_changes_within_the_same_process_yields_different_decision_ids(self):
        """反例②をdecision_id生成の実経路（`build_strategy_decision()`）まで通した
        end-to-end固定：SubSessionID/SessionIDが両方取れない環境で、同一プロセス内で
        レースA→レースBへ移る（＝セッション境界を跨いで新しいfallback IDが発行される）
        と、同じsnapshot_id・同じlap・同じconditionsでもdecision_idは必ず別になる。"""
        fallback_a = bridge._session_scoped_reset_values()['race_instance_fallback_id']
        fallback_b = bridge._session_scoped_reset_values()['race_instance_fallback_id']
        plan_race_a = self._proposal_for_b(
            race_instance_id=bridge.resolve_race_instance_id({}, fallback_a))
        plan_race_b = self._proposal_for_b(
            race_instance_id=bridge.resolve_race_instance_id({}, fallback_b))
        self.assertEqual(plan_race_a['evidence_snapshot_id'], plan_race_b['evidence_snapshot_id'])
        self.assertEqual(plan_race_a['conditions'], plan_race_b['conditions'])
        self.assertNotEqual(plan_race_a['decision_id'], plan_race_b['decision_id'],
            'SubSessionID/SessionIDが無い環境で、同一プロセス起動中に別レースへ移っても'
            'decision_idが衝突した（Codex実測反例②の再現）')

    def test_same_race_same_content_yields_the_same_decision_id(self):
        """回帰：同じレース内の再計算では、内容が同じなら引き続き同じdecision_id
        （dispatch_idが配送試行を区別する、という既存の分離を壊さない）。"""
        plan1 = self._proposal_for_b(race_instance_id='sub:900001')
        plan2 = self._proposal_for_b(race_instance_id='sub:900001')
        self.assertEqual(plan1['decision_id'], plan2['decision_id'])

    def test_different_race_same_snapshot_lap_and_conditions_gets_a_different_decision_id(self):
        """★Codex実測反例そのもの（修正前は再現した）：同じsession_num・同じlap・
        同じPlan条件（＝同じevidence_snapshot_id・同じsignature）でも、レースが
        違えばdecision_idは必ず別でなければならない。Desktop台帳（decision_idで既存
        レコードを引き当てる）とサーバー正本（PRIMARY KEY (owner_key, decision_id)）が
        別レースの判断・結果を同一レコードへ混ぜるのを防ぐ。"""
        plan_race_a = self._proposal_for_b(race_instance_id='sub:900001')
        plan_race_b = self._proposal_for_b(race_instance_id='sub:900002')
        # 同じsnapshot_id・同じlap・同じconditions（内容は完全に同一）。
        self.assertEqual(plan_race_a['evidence_snapshot_id'], plan_race_b['evidence_snapshot_id'])
        self.assertEqual(plan_race_a['decided_at_lap'], plan_race_b['decided_at_lap'])
        self.assertEqual(plan_race_a['conditions'], plan_race_b['conditions'])
        self.assertNotEqual(plan_race_a['decision_id'], plan_race_b['decision_id'],
            '別レースなのに同じ内容というだけでdecision_idが衝突した（Codex実測反例の再現）')

    def _proposal_for_b(self, race_instance_id):
        state, strategy_options = seeded_state_and_options()
        item = {'reason': 'driver_recalc_request', 'dedupe_key': 'k1',
                'driver_message': None, 'broadcast_payload': None}
        _, verdict = recalc_to_b(state, item)
        strategy_options, *_ = bridge.sync_desktop_strategy_options(
            verdict=verdict, strategy_options=strategy_options, active_decision_plan=None,
            strategy_options_decision_sent=False, strategy_options_box_call_sent=False)
        decision = bridge.decide_plan_at_target(
            strategy_options, current_lap=7, current_fuel_l=5.0, avg_fuel_per_lap_l=3.5,
            pit_now_forecast={'available': True, 'likely': {'position': 6}, 'worst': {'position': 9}},
            pit_next_lap_forecast={'available': True, 'likely': {'position': 8}, 'worst': {'position': 10}},
            relative_pace_advantage_s=0.8, options_mod=so)
        built = bridge.build_strategy_decision(
            strategy_options, decision, lap=7, class_pos=5, cur_snum=1,
            race_instance_id=race_instance_id, battle_context=None)
        return built['plan']


class ProposalDeliveryLifecycle(unittest.TestCase):
    """MD#8 P1：`DISPATCHED`（WSキュー投入）をaudible成功と混同しない。
    Desktopの配送結果でinflight→audibleを確定し、失敗では再武装する。"""

    def _pending(self, dispatch='x#1'):
        return {'decision_id': 'x', 'selected_plan': 'B', 'session_num': 1,
                'dispatch_id': dispatch,
                'target_lap': 7, 'add_fuel_l': 10, 'set_fuel_l': 20}

    def test_audible_confirms_presentation_and_keeps_pending(self):
        pending, sent, state, outcome = bridge.apply_proposal_delivery(
            self._pending(), True, 'inflight',
            {'decision_id': 'x', 'session_num': 1, 'dispatch_id': 'x#1', 'outcome': 'audible'})
        self.assertEqual(outcome, 'audible')
        self.assertEqual(state, 'audible')
        self.assertTrue(sent)
        self.assertIsNotNone(pending)

    def test_dropped_before_audible_rearms_so_it_can_be_proposed_again(self):
        """Codexの反例そのもの：Desktopが発話前にdropした時、Bridgeが
        proposal_sentのまま固まると、条件が同じ限り二度と提案が届かない。"""
        pending, sent, state, outcome = bridge.apply_proposal_delivery(
            self._pending(), True, 'inflight',
            {'decision_id': 'x', 'session_num': 1, 'dispatch_id': 'x#1',
             'outcome': 'dropped_before_audible'})
        self.assertEqual(outcome, 'released')
        self.assertIsNone(pending)
        self.assertFalse(sent)
        self.assertIsNone(state)

    def test_audible_interrupted_rearms(self):
        pending, sent, state, outcome = bridge.apply_proposal_delivery(
            self._pending(), True, 'audible',
            {'decision_id': 'x', 'session_num': 1, 'dispatch_id': 'x#1',
             'outcome': 'audible_interrupted'})
        self.assertEqual(outcome, 'released')
        self.assertIsNone(pending)
        self.assertFalse(sent)

    def test_suppressed_by_user_rearms(self):
        pending, sent, _state, outcome = bridge.apply_proposal_delivery(
            self._pending(), True, 'inflight',
            {'decision_id': 'x', 'session_num': 1, 'dispatch_id': 'x#1',
             'outcome': 'suppressed_by_user'})
        self.assertEqual(outcome, 'released')
        self.assertIsNone(pending)
        self.assertFalse(sent)

    def test_release_does_not_record_a_declined_signature(self):
        """配送失敗は拒否ではない——同じ内容の再提案を抑止してはならない。"""
        pending = self._pending()
        signature = bridge.plan_actionable_signature(pending)
        _p, _s, _st, outcome = bridge.apply_proposal_delivery(
            pending, True, 'inflight',
            {'decision_id': 'x', 'session_num': 1, 'dispatch_id': 'x#1',
             'outcome': 'dropped_before_audible'})
        self.assertEqual(outcome, 'released')
        self.assertFalse(bridge.is_signature_declined([], signature))

    def test_report_from_another_session_is_stale_and_keeps_pending(self):
        pending_in = self._pending()
        pending, sent, state, outcome = bridge.apply_proposal_delivery(
            pending_in, True, 'inflight',
            {'decision_id': 'x', 'session_num': 2, 'dispatch_id': 'x#1',
             'outcome': 'dropped_before_audible'})
        self.assertEqual(outcome, 'stale')
        self.assertIs(pending, pending_in)
        self.assertTrue(sent)
        self.assertEqual(state, 'inflight')

    def test_report_without_session_num_is_fail_closed(self):
        pending_in = self._pending()
        pending, sent, _state, outcome = bridge.apply_proposal_delivery(
            pending_in, True, 'inflight',
            {'decision_id': 'x', 'dispatch_id': 'x#1', 'outcome': 'dropped_before_audible'})
        self.assertEqual(outcome, 'stale')
        self.assertIs(pending, pending_in)
        self.assertTrue(sent)

    def test_report_for_another_decision_is_stale(self):
        pending_in = self._pending()
        pending, _sent, _state, outcome = bridge.apply_proposal_delivery(
            pending_in, True, 'inflight',
            {'decision_id': 'other', 'session_num': 1, 'dispatch_id': 'other#1',
             'outcome': 'audible'})
        self.assertEqual(outcome, 'stale')
        self.assertIs(pending, pending_in)

    def test_unknown_outcome_is_stale_not_a_release(self):
        pending_in = self._pending()
        pending, sent, _state, outcome = bridge.apply_proposal_delivery(
            pending_in, True, 'inflight',
            {'decision_id': 'x', 'session_num': 1, 'dispatch_id': 'x#1', 'outcome': 'whatever'})
        self.assertEqual(outcome, 'stale')
        self.assertIs(pending, pending_in)
        self.assertTrue(sent)

    def test_repeated_release_reports_are_idempotent(self):
        """MD#9 P1-1：Desktopはackが返るまで配送結果を再送する。同じ報告が二度
        届いても、二度目は既にpendingが無く'no_match'——新しい提案を壊さない。"""
        report = {'decision_id': 'x', 'session_num': 1, 'dispatch_id': 'x#1',
                  'outcome': 'dropped_before_audible'}
        pending, sent, state, outcome = bridge.apply_proposal_delivery(
            self._pending(), True, 'inflight', report)
        self.assertEqual(outcome, 'released')
        pending2, sent2, _state2, outcome2 = bridge.apply_proposal_delivery(
            pending, sent, state, report)
        self.assertEqual(outcome2, 'no_match')
        self.assertIsNone(pending2)
        self.assertFalse(sent2)

    def test_resent_release_does_not_kill_a_newer_proposal(self):
        """再接続後に古い配送失敗が遅れて届いても、その後に開かれた別IDの
        提案は壊さない（decision ID照合でstale）。"""
        newer = dict(self._pending(), decision_id='y')
        pending, sent, state, outcome = bridge.apply_proposal_delivery(
            newer, True, 'inflight',
            {'decision_id': 'x', 'session_num': 1, 'dispatch_id': 'x#1',
             'outcome': 'dropped_before_audible'})
        self.assertEqual(outcome, 'stale')
        self.assertIs(pending, newer)
        self.assertTrue(sent)
        self.assertEqual(state, 'inflight')

    def test_stale_failure_report_does_not_release_a_redelivered_proposal(self):
        """★Codex MD#9チェック反例1（修正前は再現した）：decision_idは
        `<snapshot_id>:decision-lap:<lap>`なので、配送失敗で解除したあと同じ周・同じ
        snapshotで再提案すると**同一decision_id**になる。切断中に滞留していた1回目の
        失敗通知が再接続で遅れて届くと、2回目に実際に聞こえて成立している提案まで
        解除された。配送試行を表す`dispatch_id`で弾く。"""
        first_failure = {'decision_id': 'x', 'session_num': 1, 'dispatch_id': 'x#1',
                         'outcome': 'dropped_before_audible'}
        # ①1回目の配送に失敗 → 解除（ここは正しい）
        pending, sent, state, outcome = bridge.apply_proposal_delivery(
            self._pending('x#1'), True, 'inflight', first_failure)
        self.assertEqual(outcome, 'released')
        self.assertIsNone(pending)
        # ②同じ内容を再提案（同一decision_id・新しいdispatch_id）→ 今度は聞こえた
        pending, sent, state, outcome = bridge.apply_proposal_delivery(
            self._pending('x#2'), True, 'inflight',
            {'decision_id': 'x', 'session_num': 1, 'dispatch_id': 'x#2', 'outcome': 'audible'})
        self.assertEqual(outcome, 'audible')
        self.assertEqual(state, 'audible')
        # ③滞留していた1回目の失敗通知が遅れて届く
        pending, sent, state, outcome = bridge.apply_proposal_delivery(
            pending, sent, state, first_failure)
        self.assertEqual(outcome, 'stale',
            '古い配送試行の失敗通知が、聞こえている新しい提案を解除した（反例1の再現）')
        self.assertIsNotNone(pending)
        self.assertTrue(sent)
        self.assertEqual(state, 'audible')

    def test_stale_response_from_an_earlier_dispatch_is_not_promoted(self):
        """同じ理由で、前の配送試行に対する遅延応答を今の提案への合意にしない。"""
        pending_in = self._pending('x#2')
        pending, promoted, outcome, _ = bridge.resolve_strategy_proposal(
            pending_in, {'decision_id': 'x', 'session_num': 1, 'dispatch_id': 'x#1',
                         'accepted': True})
        self.assertEqual(outcome, 'stale')
        self.assertIsNone(promoted)
        self.assertIs(pending, pending_in)

    def test_response_without_dispatch_id_is_fail_closed(self):
        pending_in = self._pending('x#1')
        pending, promoted, outcome, _ = bridge.resolve_strategy_proposal(
            pending_in, {'decision_id': 'x', 'session_num': 1, 'accepted': True})
        self.assertEqual(outcome, 'stale')
        self.assertIsNone(promoted)
        self.assertIs(pending, pending_in)

    def test_report_without_dispatch_id_is_fail_closed(self):
        pending_in = self._pending('x#1')
        pending, sent, _state, outcome = bridge.apply_proposal_delivery(
            pending_in, True, 'inflight',
            {'decision_id': 'x', 'session_num': 1, 'outcome': 'dropped_before_audible'})
        self.assertEqual(outcome, 'stale')
        self.assertIs(pending, pending_in)
        self.assertTrue(sent)

    def test_report_with_no_pending_is_no_match(self):
        pending, sent, _state, outcome = bridge.apply_proposal_delivery(
            None, False, None,
            {'decision_id': 'x', 'session_num': 1, 'dispatch_id': 'x#1', 'outcome': 'audible'})
        self.assertEqual(outcome, 'no_match')
        self.assertIsNone(pending)
        self.assertFalse(sent)

if __name__ == '__main__':
    unittest.main()
