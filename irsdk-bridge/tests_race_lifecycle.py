"""
OMORAY PITWALL - race_lifecycle.py テスト（R1・2026-07-21 Codex指示）
実行: python3 irsdk-bridge/tests_race_lifecycle.py
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import race_lifecycle as rl  # noqa: E402

pass_n, fail_n = 0, 0


def check(name, cond, detail=''):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print('  ✅ ' + name)
    else:
        fail_n += 1
        print('  ❌ ' + name + ('  → ' + str(detail) if detail else ''))


# ① 通常のState 4継続 ────────────────────────────────────────────
def test_normal_racing():
    m = rl.RaceLifecycle()
    for t in [90.0, 90.0, 90.0, 91.5]:
        s = m.update(session_state=rl.SS_RACING, lap_last_lap_time=t,
                     telemetry_active=True, driver_state='track')
    check('①通常のState4継続: RACINGのまま', s == rl.RACING, s)
    check('①RACING中はfuel_strategy許可', rl.fuel_strategy_allowed(s))
    check('①RACING中は新規ピット戦略許可', rl.new_pit_strategy_allowed(s))
    check('①RACING中は残り周回が増加してよい', rl.remaining_laps_may_increase(s))


# ② State 4→5、他車／リーダーのみチェッカー（自分はまだ） ──────────────────
def test_checker_out_others_only():
    m = rl.RaceLifecycle()
    m.update(session_state=rl.SS_RACING, lap_last_lap_time=90.0,
              telemetry_active=True, driver_state='track')
    # チェッカーは出たが、自分のLapLastLapTimeはまだ変わっていない（＝まだ完走していない）
    s = m.update(session_state=rl.SS_CHECKERED, lap_last_lap_time=90.0,
                 telemetry_active=True, driver_state='track')
    check('②他車のみチェッカー: CHECKER_OUTへ', s == rl.CHECKER_OUT, s)
    check('②CHECKER_OUT: fuel_strategy禁止', not rl.fuel_strategy_allowed(s))
    check('②CHECKER_OUT: 新規ピット戦略禁止', not rl.new_pit_strategy_allowed(s))
    check('②CHECKER_OUT: 残り周回は増加禁止', not rl.remaining_laps_may_increase(s))
    check('②CHECKER_OUT: 一度だけの最終通知は許可', rl.checker_out_notice_allowed(s, already_notified=False))
    check('②CHECKER_OUT: 通知済みなら再許可しない', not rl.checker_out_notice_allowed(s, already_notified=True))
    # まだ走り続ける
    s = m.update(session_state=rl.SS_CHECKERED, lap_last_lap_time=90.0,
                 telemetry_active=True, driver_state='track')
    check('②走行継続中もCHECKER_OUTのまま', s == rl.CHECKER_OUT, s)


# ③ State 5中に自車がS/F通過 ──────────────────────────────────────
def test_player_crosses_sf_during_checkered():
    m = rl.RaceLifecycle()
    m.update(session_state=rl.SS_RACING, lap_last_lap_time=90.0,
              telemetry_active=True, driver_state='track')
    m.update(session_state=rl.SS_CHECKERED, lap_last_lap_time=90.0,
              telemetry_active=True, driver_state='track')
    # 自分もついにS/Fを通過＝LapLastLapTimeが更新される
    s = m.update(session_state=rl.SS_CHECKERED, lap_last_lap_time=92.3,
                 telemetry_active=True, driver_state='track')
    check('③自車のS/F通過でPLAYER_FINISHEDへ', s == rl.PLAYER_FINISHED, s)
    check('③PLAYER_FINISHED: ピット計画禁止', not rl.pit_plan_allowed(s))


# ④ 自車がリーダーでState変化と完走が近接／同時 ───────────────────────
def test_leader_simultaneous_finish():
    m = rl.RaceLifecycle()
    m.update(session_state=rl.SS_RACING, lap_last_lap_time=90.0,
              telemetry_active=True, driver_state='track')
    # 自分がリーダー＝自分のS/F通過とセッションのチェッカーが同じフレームで届く
    s = m.update(session_state=rl.SS_CHECKERED, lap_last_lap_time=91.8,
                 telemetry_active=True, driver_state='track')
    check('④同フレームでチェッカー+自車S/F通過→即PLAYER_FINISHED', s == rl.PLAYER_FINISHED, s)

    # 補助シグナル（CarIdxLapCompleted）だけで同時検出できるケースも確認
    m2 = rl.RaceLifecycle()
    m2.update(session_state=rl.SS_RACING, lap_last_lap_time=90.0,
               telemetry_active=True, driver_state='track', car_idx_lap_completed=9)
    # CHECKER_OUT突入時にbaseline=9が記録されるはずなので、次のフレームで10に増えれば検出
    s2a = m2.update(session_state=rl.SS_CHECKERED, lap_last_lap_time=90.0,
                    telemetry_active=True, driver_state='track', car_idx_lap_completed=9)
    check('④-補助: CHECKER_OUT突入直後はまだCHECKER_OUT', s2a == rl.CHECKER_OUT, s2a)
    s2b = m2.update(session_state=rl.SS_CHECKERED, lap_last_lap_time=90.0,
                    telemetry_active=True, driver_state='track', car_idx_lap_completed=10)
    check('④-補助: CarIdxLapCompleted増加でPLAYER_FINISHED', s2b == rl.PLAYER_FINISHED, s2b)


# ⑤ State 5で残り時間値が増えても燃料戦略が発火しない ────────────────────
def test_remaining_time_increase_no_fuel_strategy():
    m = rl.RaceLifecycle()
    m.update(session_state=rl.SS_RACING, lap_last_lap_time=90.0,
              telemetry_active=True, driver_state='track')
    s = m.update(session_state=rl.SS_CHECKERED, lap_last_lap_time=90.0,
                 telemetry_active=True, driver_state='track')
    # 「残り推定が7周へ跳ね」のような外部データの揺れがあっても、ゲートはstateだけで判定する
    check('⑤CHECKER_OUT中は残り推定の値に関わらずfuel_strategy禁止', not rl.fuel_strategy_allowed(s))
    check('⑤CHECKER_OUT中は残り周回を増加させない', not rl.remaining_laps_may_increase(s))


# ⑥ PLAYER_FINISHED後にfuel/pit directorが発火しない ─────────────────
def test_no_director_after_finished():
    m = rl.RaceLifecycle()
    m.update(session_state=rl.SS_RACING, lap_last_lap_time=90.0,
              telemetry_active=True, driver_state='track')
    m.update(session_state=rl.SS_CHECKERED, lap_last_lap_time=90.0,
              telemetry_active=True, driver_state='track')
    s = m.update(session_state=rl.SS_CHECKERED, lap_last_lap_time=92.3,
                 telemetry_active=True, driver_state='track')
    check('⑥PLAYER_FINISHED: fuel_strategy禁止', not rl.fuel_strategy_allowed(s))
    check('⑥PLAYER_FINISHED: 新規ピット戦略禁止', not rl.new_pit_strategy_allowed(s))
    check('⑥PLAYER_FINISHED: directorはまだ有効(デブリーフではない)', rl.director_active(s))


# ⑦ garageでDEBRIEF ──────────────────────────────────────────────
def test_garage_after_finish_is_debrief():
    m = rl.RaceLifecycle()
    m.update(session_state=rl.SS_RACING, lap_last_lap_time=90.0,
              telemetry_active=True, driver_state='track')
    m.update(session_state=rl.SS_CHECKERED, lap_last_lap_time=90.0,
              telemetry_active=True, driver_state='track')
    m.update(session_state=rl.SS_CHECKERED, lap_last_lap_time=92.3,
              telemetry_active=True, driver_state='track')
    s = m.update(session_state=rl.SS_COOL_DOWN, lap_last_lap_time=92.3,
                 telemetry_active=True, driver_state='garage')
    check('⑦完走後ガレージ帰還でDEBRIEF', s == rl.DEBRIEF, s)
    check('⑦DEBRIEFではdirector停止', not rl.director_active(s))

    # レース前（まだ完走していない）ガレージ待機はDEBRIEFにしない
    m2 = rl.RaceLifecycle()
    s2 = m2.update(session_state=rl.SS_GET_IN_CAR, lap_last_lap_time=None,
                  telemetry_active=True, driver_state='garage')
    check('⑦レース前ガレージ待機はDEBRIEFにしない(誤爆防止)', s2 != rl.DEBRIEF, s2)


# ⑧ 状態巻き戻り、sessionNum変更、telemetry再接続 ─────────────────────
def test_rollback_sessionnum_reconnect():
    m = rl.RaceLifecycle()
    m.update(session_state=rl.SS_RACING, lap_last_lap_time=90.0,
              telemetry_active=True, driver_state='track')
    m.update(session_state=rl.SS_CHECKERED, lap_last_lap_time=90.0,
              telemetry_active=True, driver_state='track')
    s_finished = m.update(session_state=rl.SS_CHECKERED, lap_last_lap_time=92.3,
                          telemetry_active=True, driver_state='track')
    check('⑧完走確定', s_finished == rl.PLAYER_FINISHED, s_finished)
    # telemetryが瞬断してSessionStateが4に巻き戻って見えても、完走の事実は覆さない
    s_blip = m.update(session_state=rl.SS_RACING, lap_last_lap_time=92.3,
                      telemetry_active=True, driver_state='track')
    check('⑧巻き戻りでPLAYER_FINISHEDを覆さない', s_blip == rl.PLAYER_FINISHED, s_blip)
    # telemetry再接続(非アクティブ→アクティブ)を跨いでもクラッシュしない
    m.update(session_state=None, lap_last_lap_time=None, telemetry_active=False, driver_state=None)
    s_reconnect = m.update(session_state=rl.SS_RACING, lap_last_lap_time=92.3,
                           telemetry_active=True, driver_state='track')
    check('⑧telemetry再接続後もクラッシュしない(何らかの状態を返す)', s_reconnect in
          (rl.RACING, rl.CHECKER_OUT, rl.PLAYER_FINISHED, rl.DEBRIEF), s_reconnect)
    # sessionNum変更＝bridge.py側がreset()を呼ぶ想定
    m.reset()
    s_new = m.update(session_state=rl.SS_RACING, lap_last_lap_time=10.0,
                     telemetry_active=True, driver_state='track')
    check('⑧reset()後の新セッションはRACINGから再開', s_new == rl.RACING, s_new)


def run_all():
    print('══ race_lifecycle.py 通常テスト ══')
    test_normal_racing()
    test_checker_out_others_only()
    test_player_crosses_sf_during_checkered()
    test_leader_simultaneous_finish()
    test_remaining_time_increase_no_fuel_strategy()
    test_no_director_after_finished()
    test_garage_after_finish_is_debrief()
    test_rollback_sessionnum_reconnect()
    print(f"\n[race_lifecycle] 合格 {pass_n} / 不合格 {fail_n}")
    return fail_n == 0


if __name__ == '__main__':
    ok = run_all()
    sys.exit(0 if ok else 1)
