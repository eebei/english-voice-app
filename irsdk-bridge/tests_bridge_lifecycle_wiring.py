"""
OMORAY PITWALL - bridge.py 本番配線の統合テスト（2026-07-21 Codex再指摘）
  race_lifecycle/class_map/f2time_contractは純粋モジュール単体では緑でも、bridge.py側の配線が
  無ければ本番で効かない（director_active()未使用・SessionNum変更で確実にresetされない等、
  今回まさにそう指摘された）。ここではbridge.pyを実際にimportし、本番の関数
  （director_gate / maybe_reset_on_session_num_change / check_final_lap_milestones）を
  直接呼んで検証する——別ロジックの再実装ではなく、poll_iracing()が呼ぶのと同じ関数。

  bridge.pyはWindows専用のctypes.windll呼び出しを含むが、いずれも try/except で保護されており
  Mac/Linuxでも import 自体は安全（このテストはWindows/iRacing不要で動く）。

実行: python3 irsdk-bridge/tests_bridge_lifecycle_wiring.py
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bridge  # noqa: E402  ★本番モジュールを直接import（写経しない）
import race_lifecycle  # noqa: E402

pass_n, fail_n = 0, 0


def check(name, cond, detail=''):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print('  ✅ ' + name)
    else:
        fail_n += 1
        print('  ❌ ' + name + ('  → ' + str(detail) if detail else ''))


# ══ P0-2: director_active()が本番のdirector_gate()で実際に使われているか ══
def test_director_gate_suppresses_debrief():
    print('\n══ director_gate(): DEBRIEFで走行中ラジオを抑止・許可リストは通す ══')
    _orig = bridge._lifecycle_state
    try:
        bridge._director['last_by_prio'] = {}
        bridge._director['recent'] = []

        bridge._lifecycle_state = race_lifecycle.DEBRIEF
        r1 = bridge.director_gate({'type': 'radio', 'trigger': 'position_up'})
        check('DEBRIEF中: 通常の走行中ラジオ(position_up)は抑止される', r1 is False, r1)

        r2 = bridge.director_gate({'type': 'radio', 'trigger': 'checker_out_notice'})
        check('DEBRIEF中でも許可リスト(checker_out_notice)は通る', r2 is True, r2)

        bridge._lifecycle_state = race_lifecycle.RACING
        r3 = bridge.director_gate({'type': 'radio', 'trigger': 'position_up'})
        check('RACING中は通常のラジオも通る(lifecycle起因では止まらない)', r3 is True, r3)

        bridge._lifecycle_state = race_lifecycle.CHECKER_OUT
        r4 = bridge.director_gate({'type': 'radio', 'trigger': 'position_up'})
        check('CHECKER_OUT中も通常のラジオは通る(director_activeはDEBRIEFのみ抑止)', r4 is True, r4)
    finally:
        bridge._lifecycle_state = _orig


# ══ P0（再々指摘）: pace_checkがdirector_gateを迂回していないか ══
def test_director_gate_covers_pace_check():
    print('\n══ director_gate(): pace_checkもDEBRIEFで抑止される（rendererのcheckPaceJudgment迂回の再発防止） ══')
    _orig = bridge._lifecycle_state
    try:
        bridge._director['last_by_prio'] = {}
        bridge._director['recent'] = []

        # pace_checkイベントはtrigger/kindを持たない（bridge.py実装のまま・下記参照）。
        # それでもtype自体がSPEECH_EVENT_TYPESに入っていれば、DEBRIEF中は抑止されなければならない。
        pace_event = {'type': 'pace_check', 'direction': 'degrading', 'recent_deltas': [0.3, 0.4],
                      'pos': 5, 'class_pos': 5, 'gap_ahead': 1.2}

        bridge._lifecycle_state = race_lifecycle.DEBRIEF
        r1 = bridge.director_gate(pace_event)
        check('DEBRIEF中: pace_checkは抑止される(旧実装では素通りしていた)', r1 is False, r1)

        bridge._lifecycle_state = race_lifecycle.RACING
        r2 = bridge.director_gate(pace_event)
        check('RACING中: pace_checkは通る', r2 is True, r2)
    finally:
        bridge._lifecycle_state = _orig


# ══ P0-1（再々指摘で拡張）: SessionNum変更で本番関数が「セッション限定状態を全部」resetするか ══
def test_session_num_change_resets_production():
    print('\n══ maybe_reset_on_session_num_change(): race_lifecycle + 燃料/ラップ計測 + 保留中radioを一括resetするか ══')
    fsm = race_lifecycle.RaceLifecycle()
    # RACING -> CHECKER_OUT -> PLAYER_FINISHED まで進める
    fsm.update(session_state=race_lifecycle.SS_RACING, lap_last_lap_time=90.0,
               telemetry_active=True, driver_state='track')
    fsm.update(session_state=race_lifecycle.SS_CHECKERED, lap_last_lap_time=90.0,
               telemetry_active=True, driver_state='track')
    fsm.update(session_state=race_lifecycle.SS_CHECKERED, lap_last_lap_time=92.3,
               telemetry_active=True, driver_state='track')
    check('前提: PLAYER_FINISHEDまで進めた', fsm.state == race_lifecycle.PLAYER_FINISHED, fsm.state)

    # ★Codex再々指摘：保留中(gate待ち)のradioが前セッションのものとして残っていないか
    bridge._gate_state['pending'] = {'type': 'radio', 'trigger': 'position_up', 'message': 'stale from race 1'}
    bridge._gate_state['since'] = 12345.0

    # event_type|trackのsigは変わらないが、SessionNumだけ変わるケース
    # （耐久のレース1→レース2、Practice→Qualify→Race等）
    changed, reset_values = bridge.maybe_reset_on_session_num_change(
        cur_snum=2, last_session_num=1, race_lifecycle_fsm=fsm)
    check('SessionNum変更(1→2)でchanged=True', changed is True, changed)
    check('本番関数呼び出し後、race_lifecycle_fsmが実際にRACINGへ戻る(sigが変わらなくても)',
          fsm.state == race_lifecycle.RACING, fsm.state)
    check('checker_out_notice_sentの初期値はFalse', reset_values['checker_out_notice_sent'] is False, reset_values)
    check('last_laps_remaining_estの初期値はNone', reset_values['last_laps_remaining_est'] is None, reset_values)
    check('final_lap_notice_sentが全てFalseにリセットされる',
          reset_values['final_lap_notice_sent'] == {5: False, 3: False, 1: False}, reset_values)
    # ★Codex再々指摘で追加された対象。前セッションの燃費履歴・警告済み状態が残っていないこと。
    check('fuel_strategy_warnedがFalseにリセットされる', reset_values['fuel_strategy_warned'] is False, reset_values)
    check('fuel_per_lap_histが空リストにリセットされる(前セッションの燃費実測を持ち越さない)',
          reset_values['fuel_per_lap_hist'] == [], reset_values)
    check('fuel_at_lap_startがNoneにリセットされる', reset_values['fuel_at_lap_start'] is None, reset_values)
    check('lap_time_histが空リストにリセットされる', reset_values['lap_time_hist'] == [], reset_values)
    check('fuel_strategyがNoneにリセットされる(前セッションの計算結果を持ち越さない)',
          reset_values['fuel_strategy'] is None, reset_values)
    check('pit_this_lapがFalseにリセットされる', reset_values['pit_this_lap'] is False, reset_values)
    check('保留中(gate待ち)のradioが破棄される(前セッションの内容を次セッションで喋らない)',
          bridge._gate_state['pending'] is None, bridge._gate_state)
    # ★2026-07-21 四度目の指摘で追加された対象。ペース履歴・リーダー周回履歴が持ち越されないこと。
    check('pace_check_last_lapが初期値(-99)にリセットされる', reset_values['pace_check_last_lap'] == -99, reset_values)
    check('lap_delta_histが空リストにリセットされる(前セッションのペース傾向を混入させない)',
          reset_values['lap_delta_hist'] == [], reset_values)
    check('leader_lap_time_histが空リストにリセットされる(前セッションのリーダー周回履歴を混入させない)',
          reset_values['leader_lap_time_hist'] == [], reset_values)
    check('leader_last_laptime_seenがNoneにリセットされる', reset_values['leader_last_laptime_seen'] is None, reset_values)
    check('prev_session_stateが初期値(0)にリセットされる', reset_values['prev_session_state'] == 0, reset_values)
    check('race_start_timeがNoneにリセットされる', reset_values['race_start_time'] is None, reset_values)
    check('pit_enter_timeがNoneにリセットされる', reset_values['pit_enter_time'] is None, reset_values)
    check('pit_enter_posがNoneにリセットされる', reset_values['pit_enter_pos'] is None, reset_values)
    check('summary_sentがFalseにリセットされる', reset_values['summary_sent'] is False, reset_values)
    check('checkered_pendingがFalseにリセットされる', reset_values['checkered_pending'] is False, reset_values)
    check('session_racing_startedがFalseにリセットされる', reset_values['session_racing_started'] is False, reset_values)
    check('session_lapsが空リストにリセットされる', reset_values['session_laps'] == [], reset_values)

    # SessionNumが変わらない時はresetしない（誤爆しないことの確認）
    changed2, reset_values2 = bridge.maybe_reset_on_session_num_change(
        cur_snum=2, last_session_num=2, race_lifecycle_fsm=fsm)
    check('SessionNum不変ならchanged=False(誤ってresetしない)', changed2 is False, changed2)
    check('SessionNum不変ならreset_valuesはNone', reset_values2 is None, reset_values2)

    # last_session_numがNone(初回観測)の時はresetしない（起動直後の誤爆防止）
    fsm2 = race_lifecycle.RaceLifecycle()
    fsm2.update(session_state=race_lifecycle.SS_CHECKERED, lap_last_lap_time=92.3,
                telemetry_active=True, driver_state='track')
    changed3, _ = bridge.maybe_reset_on_session_num_change(
        cur_snum=1, last_session_num=None, race_lifecycle_fsm=fsm2)
    check('初回観測(last_session_num=None)ではreset扱いにしない', changed3 is False, changed3)


# ══ P0（四度目の指摘）: 「本番呼び出し相当」で汚染されたローカル変数が実際に上書きされるか ══
#   Codex指摘：「返却辞書だけでなく、本番呼び出し相当で各状態が実際に上書きされることを検証する」
#   「前セッションで各値を汚染したfixtureからSessionNumだけを変更し、サマリー・pace・残り周回へ
#    持ち越されないことを検証する」。ここではbridge.py本体のunpack代入（poll_iracing内の
#    "checker_out_notice_sent = _reset['checker_out_notice_sent']"等）と**全く同じ代入列**を
#    このテスト内でも実行し、汚染済みのローカル変数が実際に初期値へ戻ることを確認する。
def test_contaminated_locals_actually_overwritten():
    print('\n══ 汚染されたローカル変数が、本番と同じunpack代入で実際に上書きされるか ══')

    # ① 前セッション（レース1）で全状態を汚染する——実走で起きたのと同じ形の「本物っぽい」汚染値
    fsm = race_lifecycle.RaceLifecycle()
    fsm.update(session_state=race_lifecycle.SS_RACING, lap_last_lap_time=90.0,
               telemetry_active=True, driver_state='track')
    fsm.update(session_state=race_lifecycle.SS_CHECKERED, lap_last_lap_time=90.0,
               telemetry_active=True, driver_state='track')
    fsm.update(session_state=race_lifecycle.SS_CHECKERED, lap_last_lap_time=95.0,
               telemetry_active=True, driver_state='track')
    check('前提: レース1でPLAYER_FINISHEDまで進んでいる', fsm.state == race_lifecycle.PLAYER_FINISHED)

    checker_out_notice_sent = True
    last_laps_remaining_est = 1
    final_lap_notice_sent = {5: True, 3: True, 1: True}
    fuel_strategy_warned = True
    fuel_per_lap_hist = [3.1, 3.0, 2.9, 3.05]
    fuel_at_lap_start = 42.0
    lap_time_hist = [88.1, 87.9, 88.4]
    fuel_strategy = {'laps_remaining_est': 1, 'margin_laps': -2.0, 'pit_required': True}
    pit_this_lap = True
    pace_check_last_lap = 37
    lap_delta_hist = [0.3, 0.4, 0.5, -0.2, 0.6, 0.7]
    leader_lap_time_hist = [86.2, 86.0, 85.9]
    leader_last_laptime_seen = 85.9
    prev_session_state = 4
    race_start_time = 555555.5
    pit_enter_time = 111.1
    pit_enter_pos = 4
    summary_sent = True
    checkered_pending = True
    session_racing_started = True
    session_laps = [{'lap': 1, 'time': 88.1}, {'lap': 2, 'time': 87.9}, {'lap': 3, 'time': 88.4}]
    bridge._gate_state['pending'] = {'type': 'radio', 'trigger': 'position_up', 'message': 'race1 stale'}
    bridge._gate_state['since'] = 999.0

    # ② SessionNumだけ変わる（レース1→レース2。sigは変わらない想定と同じシナリオ）
    _changed, _reset = bridge.maybe_reset_on_session_num_change(
        cur_snum=2, last_session_num=1, race_lifecycle_fsm=fsm)
    check('changed=True', _changed is True, _changed)

    # ③ bridge.py本体(poll_iracing)と全く同じunpack代入をこのテストでも行う
    if _changed:
        checker_out_notice_sent = _reset['checker_out_notice_sent']
        last_laps_remaining_est = _reset['last_laps_remaining_est']
        final_lap_notice_sent = _reset['final_lap_notice_sent']
        fuel_strategy_warned = _reset['fuel_strategy_warned']
        fuel_per_lap_hist = _reset['fuel_per_lap_hist']
        fuel_at_lap_start = _reset['fuel_at_lap_start']
        lap_time_hist = _reset['lap_time_hist']
        fuel_strategy = _reset['fuel_strategy']
        pit_this_lap = _reset['pit_this_lap']
        pace_check_last_lap = _reset['pace_check_last_lap']
        lap_delta_hist = _reset['lap_delta_hist']
        leader_lap_time_hist = _reset['leader_lap_time_hist']
        leader_last_laptime_seen = _reset['leader_last_laptime_seen']
        prev_session_state = _reset['prev_session_state']
        race_start_time = _reset['race_start_time']
        pit_enter_time = _reset['pit_enter_time']
        pit_enter_pos = _reset['pit_enter_pos']
        summary_sent = _reset['summary_sent']
        checkered_pending = _reset['checkered_pending']
        session_racing_started = _reset['session_racing_started']
        session_laps = _reset['session_laps']

    # ④ レース2にとって、レース1の汚染値が一つも残っていないことを確認する
    check('checker_out_notice_sent: 汚染(True)が残っていない', checker_out_notice_sent is False, checker_out_notice_sent)
    check('last_laps_remaining_est: 汚染(1)が残っていない(=残り周回推定へ混入しない)',
          last_laps_remaining_est is None, last_laps_remaining_est)
    check('final_lap_notice_sent: 汚染(全Trueで再発火不能)が残っていない',
          final_lap_notice_sent == {5: False, 3: False, 1: False}, final_lap_notice_sent)
    check('fuel_strategy_warned: 汚染(True)が残っていない', fuel_strategy_warned is False, fuel_strategy_warned)
    check('fuel_per_lap_hist: 汚染(前セッションの燃費実測)が残っていない(=サマリーへ混入しない)',
          fuel_per_lap_hist == [], fuel_per_lap_hist)
    check('fuel_at_lap_start: 汚染(42.0)が残っていない', fuel_at_lap_start is None, fuel_at_lap_start)
    check('lap_time_hist: 汚染(前セッションのラップタイム)が残っていない(=残り周回推定へ混入しない)',
          lap_time_hist == [], lap_time_hist)
    check('fuel_strategy: 汚染(前セッションのpit_required判定)が残っていない(=サマリーへ混入しない)',
          fuel_strategy is None, fuel_strategy)
    check('pit_this_lap: 汚染(True)が残っていない', pit_this_lap is False, pit_this_lap)
    check('pace_check_last_lap: 汚染(37)が残っていない(=pace判断の間引き基準が新セッションに正しく効く)',
          pace_check_last_lap == -99, pace_check_last_lap)
    check('lap_delta_hist: 汚染(前セッションのペース傾向)が残っていない(=paceへ混入しない)',
          lap_delta_hist == [], lap_delta_hist)
    check('leader_lap_time_hist: 汚染(前セッションのリーダー周回)が残っていない(=残り周回推定へ混入しない)',
          leader_lap_time_hist == [], leader_lap_time_hist)
    check('leader_last_laptime_seen: 汚染(85.9)が残っていない', leader_last_laptime_seen is None, leader_last_laptime_seen)
    check('prev_session_state: 汚染(4)が残っていない(=新セッションのrace_start_time検出を阻害しない)',
          prev_session_state == 0, prev_session_state)
    check('race_start_time: 汚染(555555.5)が残っていない', race_start_time is None, race_start_time)
    check('pit_enter_time: 汚染(111.1)が残っていない', pit_enter_time is None, pit_enter_time)
    check('pit_enter_pos: 汚染(4)が残っていない', pit_enter_pos is None, pit_enter_pos)
    check('summary_sent: 汚染(True)が残っていない(=レース2でサマリーが送れないバグを防ぐ)',
          summary_sent is False, summary_sent)
    check('checkered_pending: 汚染(True)が残っていない(=レース2で即サマリー発火しない)',
          checkered_pending is False, checkered_pending)
    check('session_racing_started: 汚染(True)が残っていない(=レース2でSS_RACINGを再度確認)',
          session_racing_started is False, session_racing_started)
    check('session_laps: 汚染(前セッションのラップ記録)が残っていない(=レース2のサマリーに混入しない)',
          session_laps == [], session_laps)
    check('保留中radio: レース1の内容("race1 stale")が破棄されている',
          bridge._gate_state['pending'] is None, bridge._gate_state)


# ══ P1（再々指摘で修正）: Last 5/3/1が同一フレームで複数発話しないか ══
def test_final_lap_milestones_production():
    print('\n══ check_final_lap_milestones(): 本番関数が同一フレームで1件しか発火しないか ══')

    # ① 通常遷移 6→5→4→3→2→1：各しきい値でちょうど1回ずつ、他は発火しない
    sent = {5: False, 3: False, 1: False}
    for laps, expect in [(6, None), (5, (5, '5 laps to go.')), (4, None),
                          (3, (3, '3 laps to go.')), (2, None), (1, (1, 'Final lap.'))]:
        fired, sent = bridge.check_final_lap_milestones(laps, race_lifecycle.RACING, sent)
        check(f'①通常遷移: 残り{laps}周 → {expect}', fired == expect, fired)
    fired, sent = bridge.check_final_lap_milestones(1, race_lifecycle.RACING, sent)
    check('①Final lap後、同じ1周のままでは再発火しない', fired is None, fired)

    # ② ジャンプ 6→1：5周・3周は"sent"扱いになるが、発話するのはFinal lapの1件だけ
    sent2 = {5: False, 3: False, 1: False}
    fired2a, sent2 = bridge.check_final_lap_milestones(6, race_lifecycle.RACING, sent2)
    check('②6周時点ではまだ何も発火しない', fired2a is None, fired2a)
    fired2b, sent2 = bridge.check_final_lap_milestones(1, race_lifecycle.RACING, sent2)
    check('②6→1へジャンプしても発火は1件だけ(Final lap)', fired2b == (1, 'Final lap.'), fired2b)
    check('②5周・3周も後から発話されないようsent済みになっている',
          sent2 == {5: True, 3: True, 1: True}, sent2)
    fired2c, _ = bridge.check_final_lap_milestones(1, race_lifecycle.RACING, sent2)
    check('②ジャンプ後、5周や3周の通知が遅れて発火することはない', fired2c is None, fired2c)

    # ③ 初回有効値が1（レース開始時点で既に残り1周＝短いレース）：Final lapだけを言う
    sent3 = {5: False, 3: False, 1: False}
    fired3, sent3 = bridge.check_final_lap_milestones(1, race_lifecycle.RACING, sent3)
    check('③初回有効値が1ならFinal lapだけ発火(5周・3周は言わない)', fired3 == (1, 'Final lap.'), fired3)
    check('③5周・3周もsent済みになっている(取り消し済みの過去として扱う)',
          sent3 == {5: True, 3: True, 1: True}, sent3)

    # ④ CHECKER_OUT/PLAYER_FINISHEDでは新規発火しない（既存の確認を維持）
    fired4, _ = bridge.check_final_lap_milestones(1, race_lifecycle.CHECKER_OUT,
                                                    {5: False, 3: False, 1: False})
    check('④CHECKER_OUTでは新規発火しない', fired4 is None, fired4)
    fired5, _ = bridge.check_final_lap_milestones(1, race_lifecycle.PLAYER_FINISHED,
                                                    {5: False, 3: False, 1: False})
    check('④PLAYER_FINISHEDでは発火しない(RACING限定)', fired5 is None, fired5)


def run_all():
    print('══ bridge.py 本番配線の統合テスト ══')
    test_director_gate_suppresses_debrief()
    test_director_gate_covers_pace_check()
    test_session_num_change_resets_production()
    test_contaminated_locals_actually_overwritten()
    test_final_lap_milestones_production()
    print(f"\n[bridge wiring] 合格 {pass_n} / 不合格 {fail_n}")
    return fail_n == 0


if __name__ == '__main__':
    ok = run_all()
    sys.exit(0 if ok else 1)
