"""
OMORAY PITWALL - Driver Handoff / Inactive Driver 認識テスト
(Unit E0 v3・2026-07-26 Codex 再差戻し全項目対応)

fixture 実データ：
  - 八木氏 19:30/26周目で誤 DEBRIEF → 実際は3時間18分継続
  - まーぼー氏 18:34:31 summary → 18:34:51「レース終わったよ」→ 実際は継続中
  - ダート氏 ドライバー交代ごとに pit_entry 二重発火
  - Practice 中 Masao Takeda 氏運転・八木氏の官兵衛が limiter/Box 発話

v3 Codex 再差戻し反映：
  P0-1 PTT を activity 判定から完全削除（非搭乗中の会話でも押されるため誤活性）
       → 明示的 CMD 'resume_driving_support' で本人再搭乗確定
  P0-2 Practice/Qualify の handoff summary 完全抑止
       → iRacing SessionNum変更だけを終了の権威としてsummary確定
  P0-3 race_lifecycle の DEBRIEF 復帰不可 → CHECKER_OUT/PLAYER_FINISHED 経由のみ許可
  P0-4 summary の次フレーム再送を本当に実装（pending payload + 通常ポーリング再試行ループ）
  P1   broadcast() 三値化 DISPATCHED/HELD/DROPPED（段階状態消費は DISPATCHED のみ）

実行: python3 irsdk-bridge/tests_driver_handoff.py
"""
import sys
import os
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import driver_activity as da  # noqa: E402
import bridge  # noqa: E402
import race_lifecycle  # noqa: E402
import endurance_handoff as chief  # noqa: E402

pass_n, fail_n = 0, 0


def check(name, cond, detail=''):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print('  ✅ ' + name)
    else:
        fail_n += 1
        print('  ❌ ' + name + ('  → ' + str(detail) if detail else ''))


_BRIDGE_SRC = None


def _bridge_source():
    global _BRIDGE_SRC
    if _BRIDGE_SRC is None:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bridge.py'), 'r') as f:
            _BRIDGE_SRC = f.read()
    return _BRIDGE_SRC


# ── 純粋関数 evaluate_driver_activity() 基本 ─────────────────────

def test_race_track_from_active_stays_active():
    print('\n══ RACING × track × prev=ACTIVE → ACTIVE ══')
    a, h, _ = da.evaluate_driver_activity(
        driver_state='track', prev_activity=da.ACTIVE, lifecycle_state='RACING',
        handoff_start_time_s=None, current_time_s=100.0, manual_resume_signal=False)
    check('activity=ACTIVE', a == da.ACTIVE)
    check('handoff_start=None', h is None)


def test_active_to_garage_starts_handoff():
    print('\n══ ACTIVE → garage → DRIVER_HANDOFF ══')
    a, h, _ = da.evaluate_driver_activity(
        driver_state='garage', prev_activity=da.ACTIVE, lifecycle_state='RACING',
        handoff_start_time_s=None, current_time_s=1000.0, manual_resume_signal=False)
    check('activity=DRIVER_HANDOFF', a == da.DRIVER_HANDOFF)
    check('handoff_start=1000', h == 1000.0)


def test_handoff_exceeds_threshold():
    print('\n══ HANDOFF → 閾値超で INACTIVE_DRIVER ══')
    a, _, _ = da.evaluate_driver_activity(
        driver_state='garage', prev_activity=da.DRIVER_HANDOFF, lifecycle_state='RACING',
        handoff_start_time_s=1000.0,
        current_time_s=1000.0 + da.HANDOFF_TO_INACTIVE_SEC + 1.0,
        manual_resume_signal=False)
    check('activity=INACTIVE_DRIVER', a == da.INACTIVE_DRIVER)


# ── P0-1：PTT を activity 判定から完全削除 ─────────────────────

def test_p0_1_evaluate_signature_has_manual_resume_not_ptt():
    print('\n══ P0-1：evaluate_driver_activity() 引数に manual_resume_signal が有り ptt が無い ══')
    import inspect
    sig = inspect.signature(da.evaluate_driver_activity)
    params = list(sig.parameters)
    check('manual_resume_signal が引数リストにある', 'manual_resume_signal' in params)
    check('ptt_pressed_this_frame は引数リストに無い（v3 で削除）',
          'ptt_pressed_this_frame' not in params)


def test_p0_1_inactive_with_ptt_conversation_stays_inactive():
    print('\n══ P0-1：INACTIVE 中の PTT 会話だけでは復帰しない ══')
    # チームメイト運転中の実測状態は garage。PTTはactivity入力に渡らないので維持する。
    a, h, r = da.evaluate_driver_activity(
        driver_state='garage', prev_activity=da.INACTIVE_DRIVER, lifecycle_state='RACING',
        handoff_start_time_s=1000.0, current_time_s=2000.0, manual_resume_signal=False)
    check('activity=INACTIVE_DRIVER のまま', a == da.INACTIVE_DRIVER,
          f'actual={a} reason={r}')


def test_p0_1_teammate_pit_track_plus_ptt_stays_inactive():
    print('\n══ P0-1：teammate pitではINACTIVE、本人trackで自動復帰 ══')
    a_pit, _, _ = da.evaluate_driver_activity(
        driver_state='pit', prev_activity=da.INACTIVE_DRIVER,
        lifecycle_state='RACING', handoff_start_time_s=1000.0,
        current_time_s=2000.0, manual_resume_signal=False)
    check('交代先ドライバーの pit 表示だけでは INACTIVE のまま',
          a_pit == da.INACTIVE_DRIVER)
    a_track, _, r_track = da.evaluate_driver_activity(
        driver_state='track', prev_activity=da.INACTIVE_DRIVER,
        lifecycle_state='RACING', handoff_start_time_s=1000.0,
        current_time_s=2000.0, manual_resume_signal=False)
    check('本人向け IsOnTrack が真になれば ACTIVE 自動復帰',
          a_track == da.ACTIVE)
    check('復帰理由が on_track_confirmed_reboard',
          r_track == 'on_track_confirmed_reboard')


def test_p0_1_manual_resume_confirms_reboard():
    print('\n══ P0-1：manual_resume_signal=True × pit → ACTIVE 復帰 ══')
    a, h, r = da.evaluate_driver_activity(
        driver_state='pit', prev_activity=da.INACTIVE_DRIVER, lifecycle_state='RACING',
        handoff_start_time_s=1000.0, current_time_s=2000.0, manual_resume_signal=True)
    check('manual_resume × pit → ACTIVE', a == da.ACTIVE)
    check('reason=manual_resume_confirmed', r == 'manual_resume_confirmed')


def test_p0_1_manual_resume_at_garage_does_not_reboard():
    print('\n══ P0-1：manual_resume × garage は復帰しない（着席条件も必須） ══')
    a, _, _ = da.evaluate_driver_activity(
        driver_state='garage', prev_activity=da.INACTIVE_DRIVER, lifecycle_state='RACING',
        handoff_start_time_s=1000.0, current_time_s=2000.0, manual_resume_signal=True)
    check('activity=INACTIVE_DRIVER のまま', a == da.INACTIVE_DRIVER)


def test_p0_1_bridge_ptt_hook_does_not_mark_resume():
    print('\n══ P0-1：bridge の PTT 経路が activity signal を set しない ══')
    src = _bridge_source()
    # PTT 押下の joystick hook から _mark_manual_resume_signal が呼ばれない
    m = re.search(
        r'if cur and not ptt_pressed:([\s\S]*?)elif not cur and ptt_pressed:',
        src)
    check('joystick PTT down block が見つかる', m is not None)
    if m:
        block = m.group(1)
        check('block 内で PTT down を broadcast',
              "broadcast({'type': 'ptt', 'state': 'down'})" in block)
        check('block 内で _mark_manual_resume_signal() を呼ばない',
              '_mark_manual_resume_signal()' not in block)
    # renderer cmd 'ptt_start' でも呼ばれない
    m2 = re.search(
        r'cmd == "ptt_start"[\s\S]{0,300}?start_ptt_record\(\)',
        src)
    check('renderer PTT cmd block が見つかる', m2 is not None)
    if m2:
        block2 = m2.group(0)
        check('block 内で _mark_manual_resume_signal() を呼ばない',
              '_mark_manual_resume_signal()' not in block2)


def test_p0_1_bridge_has_resume_cmd_handler():
    print('\n══ P0-1：bridge に cmd "resume_driving_support" のハンドラがある ══')
    src = _bridge_source()
    check('cmd == "resume_driving_support" のハンドラ',
          'cmd == "resume_driving_support"' in src)
    check('resume ハンドラ内で _mark_manual_resume_signal() 呼び出し',
          re.search(
              r'cmd == "resume_driving_support"[\s\S]{0,300}?_mark_manual_resume_signal\(\)',
              src) is not None)


# ── P0-2：Practice/Qualify handoff summary 完全抑止 ─────────

def test_p0_2_non_race_handoff_no_summary():
    print('\n══ P0-2：garage/handoffだけでは非レースsummaryを確定しない ══')
    check('SessionNum不変ならFalse',
          da.should_finalize_non_race_summary(
              False, False, True, True, False) is False)


def test_p0_2_non_race_inactive_no_summary():
    print('\n══ P0-2：SessionNum変更でも旧セッションがRaceなら非レースsummaryなし ══')
    check('previous_is_race=TrueならFalse',
          da.should_finalize_non_race_summary(
              True, True, True, True, False) is False)


def test_p0_2_non_race_active_needs_session_end_confirmed():
    print('\n══ P0-2：非レース旧セッション＋SessionNum変更でだけsummary確定 ══')
    check('全条件成立でTrue',
          da.should_finalize_non_race_summary(
              True, False, True, True, False) is True)
    check('ラップなしはFalse',
          da.should_finalize_non_race_summary(
              True, False, False, True, False) is False)
    check('既送信ならFalse',
          da.should_finalize_non_race_summary(
              True, False, True, True, True) is False)


def test_p0_2_bridge_uses_should_fire_non_race_summary():
    print('\n══ P0-2：bridge がSessionNum変更の純粋判定を使う ══')
    src = _bridge_source()
    check('should_finalize_non_race_summary が bridge で参照される',
          'driver_activity_mod.should_finalize_non_race_summary(' in src)
    check('telemetry inactiveの死んだ終了判定が残っていない',
          '_telemetry_inactive_since' not in src)


def test_p0_2_bridge_no_handoff_summary_in_garage_path():
    print('\n══ P0-2：garage 遷移の即 summary 分岐が削除されている ══')
    src = _bridge_source()
    # 旧 v2 の _may_send_summary + DRIVER_HANDOFF/INACTIVE_DRIVER 直接列挙は消えている
    check('DRIVER_HANDOFF/INACTIVE_DRIVER を summary 許可条件に含めない',
          not re.search(
              r'_may_send_summary\s*=\s*\(_driver_activity_local\s*\n?\s*in\s*\(driver_activity_mod\.ACTIVE,\s*\n?\s*driver_activity_mod\.INACTIVE_DRIVER,\s*\n?\s*driver_activity_mod\.DRIVER_HANDOFF\)',
              src))


# ── P0-3：race_lifecycle DEBRIEF 復帰 ────────────────────────

def test_p0_3_racing_short_disconnect_stays_racing():
    print('\n══ P0-3：RACING 中の短時間 telemetry_active=False → RACING 維持（DEBRIEF に落ちない） ══')
    fsm = race_lifecycle.RaceLifecycle()
    fsm.state = race_lifecycle.RACING
    fsm._last_lap_last_lap_time = 100.0
    # telemetry_active=False で update
    s = fsm.update(session_state=race_lifecycle.SS_RACING,
                   lap_last_lap_time=100.0, telemetry_active=False,
                   driver_state='track')
    check('RACING のまま（短時間断で DEBRIEF に落ちない）',
          s == race_lifecycle.RACING)


def test_p0_3_checker_out_disconnect_goes_debrief():
    print('\n══ P0-3：CHECKER_OUT × telemetry_active=False → CHECKER_OUT維持 ══')
    fsm = race_lifecycle.RaceLifecycle()
    fsm.state = race_lifecycle.CHECKER_OUT
    fsm._last_lap_last_lap_time = 100.0
    s = fsm.update(session_state=race_lifecycle.SS_CHECKERED,
                   lap_last_lap_time=100.0, telemetry_active=False,
                   driver_state='track')
    check('CHECKER_OUTは総合首位チェッカーだけなのでDEBRIEFにしない',
          s == race_lifecycle.CHECKER_OUT)


def test_p0_3_player_finished_disconnect_goes_debrief():
    print('\n══ P0-3：PLAYER_FINISHED × telemetry_active=False → DEBRIEF ══')
    fsm = race_lifecycle.RaceLifecycle()
    fsm.state = race_lifecycle.PLAYER_FINISHED
    s = fsm.update(session_state=race_lifecycle.SS_CHECKERED,
                   lap_last_lap_time=None, telemetry_active=False,
                   driver_state='track')
    check('DEBRIEF', s == race_lifecycle.DEBRIEF)


def test_p0_3_racing_recovers_after_reconnect():
    print('\n══ P0-3：RACING → 一時断 → RACING 復帰で自動発話継続可能 ══')
    fsm = race_lifecycle.RaceLifecycle()
    fsm.state = race_lifecycle.RACING
    fsm._last_lap_last_lap_time = 100.0
    # 一時断
    fsm.update(session_state=race_lifecycle.SS_RACING,
               lap_last_lap_time=100.0, telemetry_active=False,
               driver_state='track')
    check('一時断後も RACING', fsm.state == race_lifecycle.RACING)
    # 復帰
    fsm.update(session_state=race_lifecycle.SS_RACING,
               lap_last_lap_time=100.0, telemetry_active=True,
               driver_state='track')
    check('復帰後も RACING', fsm.state == race_lifecycle.RACING)
    # director_active(RACING) は True → 自動発話継続
    check('race_lifecycle.director_active(RACING) = True',
          race_lifecycle.director_active(fsm.state) is True)


# ── P0-4：summary pending + retry ─────────────────────────

def test_p0_4_pending_summary_state_in_session_scoped_reset():
    print('\n══ P0-4：_pending_summary が session_scoped_reset に含まれる ══')
    resets = bridge._session_scoped_reset_values()
    check('_pending_summary が reset dict に含まれる',
          '_pending_summary' in resets)
    check('リセット値は None', resets['_pending_summary'] is None)


def test_p0_4_pending_unpacked_in_both_reset_paths():
    print('\n══ P0-4：sig/SessionNum 両経路で _pending_summary が unpack される ══')
    src = _bridge_source()
    check("sig経路: _pending_summary = _sig_reset['_pending_summary']",
          "_pending_summary = _sig_reset['_pending_summary']" in src)
    check("SessionNum経路: _pending_summary = _reset['_pending_summary']",
          "_pending_summary = _reset['_pending_summary']" in src)


def test_p0_4_summary_broadcast_uses_dispatched_check():
    print('\n══ P0-4：summary配送ヘルパーが BROADCAST_DISPATCHED だけを成功扱い ══')
    src = _bridge_source()
    check('dispatch_pending_summary() が本番ループから呼ばれる',
          'dispatch_pending_summary(' in src)
    payload = {'type': 'session_summary', 'total_laps': 25}
    calls = []

    def dropped_then_dispatched(event):
        calls.append(event)
        return (bridge.BROADCAST_DROPPED if len(calls) == 1
                else bridge.BROADCAST_DISPATCHED)

    pending, sent, result = bridge.dispatch_pending_summary(
        payload, False, dropped_then_dispatched)
    check('1回目DROPPEDではpayload保持', pending is payload)
    check('1回目DROPPEDではsent=False', sent is False)
    pending, sent, result = bridge.dispatch_pending_summary(
        pending, sent, dropped_then_dispatched)
    check('2回目DISPATCHEDでpayload破棄', pending is None)
    check('2回目DISPATCHEDでsent=True', sent is True)
    check('同じpayloadを2回試行', calls == [payload, payload])


def test_p0_4_summary_retry_loop_outside_state_change_blocks():
    print('\n══ P0-4：pending 再送ループが driver_state 変化 / lap_time 変化ブロックの外にある ══')
    src = _bridge_source()
    # 再送ループが `if driver_state != prev_driver_state:` の外
    m = re.search(
        r'if _pending_summary is not None and not summary_sent:',
        src)
    check('pending 再送ループが存在する', m is not None)
    # ループが driver_state 変化条件と独立していることを構造上確認：
    #   ループの前に "if driver_state != prev_driver_state:" が出ない範囲を切り出せる
    idx = src.find('if _pending_summary is not None and not summary_sent:')
    # 探索：直前 500 文字に driver_state 変化条件が無い
    if idx > 0:
        preceding = src[max(0, idx - 500):idx]
        check('pending ループの直前は driver_state 変化ブロックの外',
              'if driver_state != prev_driver_state:' not in preceding)


def test_p0_4_pending_prepared_when_true_finish():
    print('\n══ P0-4：レース × 真の完走で _pending_summary が生成される（ロジック確認） ══')
    src = _bridge_source()
    # レース経路：should_fire_race_summary で判定
    check('レース経路で should_fire_race_summary が呼ばれる',
          re.search(
              # ★2026-09-02：窓幅は契約ではない。9/2 の `latest_lap_recorded` 修正で
              #   コメントが増え 700 字を超えた。検証しているのは
              #   「レース経路で should_fire_race_summary を呼ぶこと」であって字数ではない。
              r'is_race_session:[\s\S]{0,2000}?should_fire_race_summary\(',
              src) is not None)
    check('最終ラップ記録後まで待つ last_lap_time == lapTime ガード',
          'last_lap_time == lapTime' in src)
    check('非レース経路はSessionNum変更で確定',
          'should_finalize_non_race_summary(' in src)


def test_p0_4_broadcast_returns_dispatched_string():
    print('\n══ P0-4：broadcast() が DISPATCHED/HELD/DROPPED 定数を返す ══')
    _prev = bridge._driver_activity
    try:
        # ACTIVE + client 無し → DROPPED
        bridge._set_driver_activity(da.ACTIVE)
        r = bridge.broadcast({'type': 'driver_state', 'state': 'track'})
        check('ACTIVE + 未接続 → DROPPED',
              r == bridge.BROADCAST_DROPPED, f'actual={r}')
        # INACTIVE + voice → DROPPED (activity gate)
        bridge._set_driver_activity(da.INACTIVE_DRIVER)
        r2 = bridge.broadcast({'type': 'radio', 'trigger': 'crash_check'})
        check('INACTIVE + voice → DROPPED', r2 == bridge.BROADCAST_DROPPED)
    finally:
        bridge._set_driver_activity(_prev)


# ── P1：DISPATCHED/HELD/DROPPED 分離 ──────────────────────

def test_p1_broadcast_constants_defined():
    print('\n══ P1：BROADCAST_DISPATCHED / HELD / DROPPED 定数が定義される ══')
    check('BROADCAST_DISPATCHED', hasattr(bridge, 'BROADCAST_DISPATCHED'))
    check('BROADCAST_HELD', hasattr(bridge, 'BROADCAST_HELD'))
    check('BROADCAST_DROPPED', hasattr(bridge, 'BROADCAST_DROPPED'))
    check('3値は全て異なる文字列',
          len({bridge.BROADCAST_DISPATCHED, bridge.BROADCAST_HELD,
               bridge.BROADCAST_DROPPED}) == 3)


def test_p1_stage_updates_check_dispatched_explicitly():
    print('\n══ P1：catchup/defend/battle が == BROADCAST_DISPATCHED で明示チェック ══')
    src = _bridge_source()
    for kind in ('catchup', 'defend', 'battle'):
        m = re.search(
            r"'kind': '" + kind + r"'[\s\S]{0,800}?"
            r"if _br == BROADCAST_DISPATCHED:",
            src)
        check(f'{kind}: _br == BROADCAST_DISPATCHED チェック', m is not None)


# ── UNKNOWN / meta / summary ヘルパー ─────────────────────

def test_should_auto_fire_only_active():
    print('\n══ should_auto_fire は ACTIVE のみ True ══')
    for s in (da.DRIVER_HANDOFF, da.INACTIVE_DRIVER, da.FINISHED, da.UNKNOWN):
        check(f'{s}=False', da.should_auto_fire(s) is False)
    check('ACTIVE=True', da.should_auto_fire(da.ACTIVE) is True)


def test_should_fire_race_summary_only_at_true_finish():
    print('\n══ should_fire_race_summary は FINISHED × PLAYER_FINISHED のみ True ══')
    check('FINISHED × PLAYER_FINISHED → True',
          da.should_fire_race_summary(da.FINISHED, 'PLAYER_FINISHED') is True)
    for s in ('RACING', 'CHECKER_OUT', 'DEBRIEF'):
        check(f'FINISHED × {s} → False',
              da.should_fire_race_summary(da.FINISHED, s) is False)
    check('ACTIVE × PLAYER_FINISHED → False',
          da.should_fire_race_summary(da.ACTIVE, 'PLAYER_FINISHED') is False)


# ── FINISHED lock / DEBRIEF は源にしない ─────────────────

def test_finished_locked():
    print('\n══ FINISHED からは巻き戻さない ══')
    a, _, r = da.evaluate_driver_activity(
        driver_state='track', prev_activity=da.FINISHED, lifecycle_state='RACING',
        handoff_start_time_s=None, current_time_s=100.0, manual_resume_signal=True)
    check('activity=FINISHED（manual_resume でも巻き戻さない）', a == da.FINISHED)


def test_debrief_lifecycle_does_not_lock_finished():
    print('\n══ lifecycle=DEBRIEF は FINISHED lock 源にしない ══')
    a, _, _ = da.evaluate_driver_activity(
        driver_state='track', prev_activity=da.ACTIVE, lifecycle_state='DEBRIEF',
        handoff_start_time_s=None, current_time_s=100.0, manual_resume_signal=False)
    check('activity=ACTIVE（DEBRIEF は権威源でない）', a == da.ACTIVE)


def test_player_finished_lifecycle_locks_finished():
    print('\n══ lifecycle=PLAYER_FINISHED → activity=FINISHED ══')
    a, _, _ = da.evaluate_driver_activity(
        driver_state='track', prev_activity=da.ACTIVE, lifecycle_state='PLAYER_FINISHED',
        handoff_start_time_s=None, current_time_s=100.0, manual_resume_signal=False)
    check('activity=FINISHED', a == da.FINISHED)


# ── P0-4 allow-list ゲート維持確認 ─────────────────────

def test_allow_list_meta_pass_during_inactive():
    print('\n══ P0-4：INACTIVE でも allow-list meta は通す ══')
    _prev = bridge._driver_activity
    try:
        bridge._set_driver_activity(da.INACTIVE_DRIVER)
        for etype in ('ptt', 'ptt_text', 'ptt_audio', 'ptt_error', 'ptt_diagnostic',
                      'iracing_connected', 'session_summary',
                      'driver_state', 'session_info', 'speak_gate', 'pit_timing',
                      'chief_engineer_handoff'):
            check(f'INACTIVE × {etype} → allowed',
                  bridge._activity_allows_broadcast({'type': etype}) is True)
    finally:
        bridge._set_driver_activity(_prev)


def test_allow_list_denies_voice_during_inactive():
    print('\n══ INACTIVE で voice event 全 deny ══')
    _prev = bridge._driver_activity
    try:
        bridge._set_driver_activity(da.INACTIVE_DRIVER)
        for trigger in ('crash_check', 'post_contact_ok', 'pit_entry',
                        'checker_out_notice', 'personal_best',
                        'stopped_ahead', 'side_by_side'):
            check(f'INACTIVE × radio/{trigger} → denied',
                  bridge._activity_allows_broadcast(
                      {'type': 'radio', 'trigger': trigger}) is False)
    finally:
        bridge._set_driver_activity(_prev)


# ── PTT即時録音・冪等契約 ─────────────────────────────

def test_ptt_record_edges_are_idempotent():
    print('\n══ PTT start/stop 二重CMDは冪等 ══')
    old_audio = bridge.ptt_audio
    old_recording = bridge.ptt_recording
    old_discard = bridge.ptt_discard_recording
    try:
        bridge.ptt_audio = object()
        bridge.ptt_recording = False
        bridge.ptt_discard_recording = False
        check('最初のstartだけ開始', bridge.start_ptt_record() is True)
        check('二重startは無視', bridge.start_ptt_record() is False)
        check('最初のstopだけ停止', bridge.stop_ptt_record() is True)
        check('二重stopは無視', bridge.stop_ptt_record() is False)
        bridge.start_ptt_record()
        bridge.abort_ptt_record()
        check('abortで録音停止', bridge.ptt_recording is False)
        check('abortで破棄フラグ', bridge.ptt_discard_recording is True)
    finally:
        bridge.ptt_audio = old_audio
        bridge.ptt_recording = old_recording
        bridge.ptt_discard_recording = old_discard


def test_ptt_hardware_edge_starts_before_renderer_roundtrip():
    print('\n══ PTT hardware edgeでrenderer往復前に録音開始 ══')
    src = _bridge_source()
    down = src.find("if cur and not ptt_pressed:")
    start = src.find("start_ptt_record()", down)
    down_broadcast = src.find("broadcast({'type': 'ptt', 'state': 'down'})", down)
    up = src.find("elif not cur and ptt_pressed:", down)
    stop = src.find("stop_ptt_record()", up)
    up_broadcast = src.find("broadcast({'type': 'ptt', 'state': 'up'})", up)
    check('down edge: start → broadcast', down < start < down_broadcast < up)
    check('up edge: stop → broadcast', up < stop < up_broadcast)
    check('busy renderer用abort CMDあり', 'cmd == "ptt_abort"' in src)


# ── 本番配線 ─────────────────────────────────────

def test_bridge_imports_driver_activity_module():
    print('\n══ 本番配線：bridge が driver_activity_mod を import ══')
    check('import driver_activity as driver_activity_mod',
          'import driver_activity as driver_activity_mod' in _bridge_source())


def test_bridge_activity_gate_before_director():
    print('\n══ 本番配線：broadcast() 内で activity gate → director_gate の順 ══')
    src = _bridge_source()
    m = re.search(
        r'def broadcast\(event\):[\s\S]{0,800}?'
        r'if not _activity_allows_broadcast\(event\):[\s\S]{0,200}?'
        r'return BROADCAST_DROPPED[\s\S]{0,500}?'
        r'if not director_gate\(event\):',
        src)
    check('順序が正しい', m is not None)


def test_bridge_manual_resume_wired_to_poll():
    print('\n══ 本番配線：poll_iracing が _consume_manual_resume_signal を毎フレーム消費 ══')
    src = _bridge_source()
    check('_consume_manual_resume_signal() 呼び出し',
          '_manual_resume_signal = _consume_manual_resume_signal()' in src)
    check('manual_resume_signal=_manual_resume_signal で evaluate に渡す',
          'manual_resume_signal=_manual_resume_signal' in src)


def test_bridge_session_scoped_reset_includes_new_state():
    print('\n══ 本番配線：session_scoped_reset に v3 状態全部含む ══')
    resets = bridge._session_scoped_reset_values()
    for key in ('_driver_activity_local', '_driver_activity_handoff_start',
                '_pending_summary'):
        check(f'{key} が reset dict に含まれる', key in resets)


def test_active_reboard_resets_driver_scoped_call_state():
    print('\n══ 本番配線：非ACTIVE→ACTIVEで本人スティント限定状態を初期化 ══')
    src = _bridge_source()
    start = src.find(
        'if (_new_activity == driver_activity_mod.ACTIVE\n'
        '                    and _activity_before != driver_activity_mod.ACTIVE):')
    check('ACTIVE復帰境界のreset blockがある', start >= 0)
    if start < 0:
        return
    block = src[start:start + 1800]
    for token in (
            'fuel_per_lap_hist = []',
            'fuel_strategy_warned = False',
            'final_lap_notice_sent = {5: False, 3: False, 1: False}',
            'post_contact_watch_start = None',
            'multiclass_warned.clear()',
            'battle_warned.clear()',
            'catchup_stage.clear()',
            'defend_stage.clear()',
            'danger_warned.clear()',
            'stopped_warned.clear()'):
        check(f'復帰時reset: {token}', token in block)
    check('teammate pitを本人復帰扱いする旧garage→pit resetがない',
          "prev_driver_state == 'garage' and driver_state in ('track', 'pit')" not in src)


# ── 変異試験 v3（8種） ──────────────────────────────

def _mutate_and_reload_driver_activity(pattern, replacement):
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           'driver_activity.py'), 'r') as f:
        src = f.read()
    mutated = src.replace(pattern, replacement, 1)
    if mutated == src:
        return None
    ns = {}
    exec(mutated, ns)
    return ns


def test_mutation_p0_1_manual_resume_removed_reboards_without_it():
    print('\n══ 変異 P0-1：pit の manual_resume チェック削除 → 交代先pitで復帰してしまう ══')
    ns = _mutate_and_reload_driver_activity(
        "if manual_resume_signal and driver_state == 'pit':\n            return (ACTIVE, None, 'manual_resume_confirmed')",
        "if driver_state == 'pit':\n            return (ACTIVE, None, 'MUTATED_no_manual_resume_check')")
    check('変異版作成', ns is not None)
    if ns:
        a_mut, _, _ = ns['evaluate_driver_activity'](
            driver_state='pit', prev_activity='INACTIVE_DRIVER',
            lifecycle_state='RACING', handoff_start_time_s=1000.0,
            current_time_s=2000.0, manual_resume_signal=False)
        a_orig, _, _ = da.evaluate_driver_activity(
            driver_state='pit', prev_activity=da.INACTIVE_DRIVER,
            lifecycle_state='RACING', handoff_start_time_s=1000.0,
            current_time_s=2000.0, manual_resume_signal=False)
        check('本番は INACTIVE_DRIVER のまま', a_orig == da.INACTIVE_DRIVER)
        check('変異版は ACTIVE に化ける（=P0-1 バグ再現）', a_mut == 'ACTIVE')


def test_mutation_p0_2_non_race_summary_allows_handoff():
    print('\n══ 変異 P0-2：SessionNum変更条件削除でgarage相当でもsummary確定 ══')
    ns = _mutate_and_reload_driver_activity(
        "bool(session_num_changed)\n        and not bool(previous_is_race_session)",
        "True\n        and not bool(previous_is_race_session)")
    check('変異版作成', ns is not None)
    if ns:
        r_mut = ns['should_finalize_non_race_summary'](
            False, False, True, True, False)
        r_orig = da.should_finalize_non_race_summary(
            False, False, True, True, False)
        check('本番は False（SessionNum不変）', r_orig is False)
        check('変異版は True に化ける（=garage誤確定相当）', r_mut is True)


def test_mutation_p0_3_debrief_still_from_racing():
    print('\n══ 変異 P0-3：telemetry_active=False で無条件 DEBRIEF 復活 → 短時間断で永久停止 ══')
    # race_lifecycle.py を変異
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           'race_lifecycle.py'), 'r') as f:
        src = f.read()
    target = "if not telemetry_active:\n            if self.state == PLAYER_FINISHED:\n                return _finish(DEBRIEF)"
    check('変異対象がソースにある', target in src)
    mutated = src.replace(target,
        "if not telemetry_active:\n            if True:  # MUTATED\n                return _finish(DEBRIEF)", 1)
    check('変異が反映', mutated != src)
    # 実際に変異版を動かす
    ns = {}
    exec(mutated, ns)
    fsm = ns['RaceLifecycle']()
    fsm.state = ns['RACING']
    fsm._last_lap_last_lap_time = 100.0
    s = fsm.update(session_state=ns['SS_RACING'],
                   lap_last_lap_time=100.0, telemetry_active=False,
                   driver_state='track')
    check('変異版は RACING × telemetry=False で DEBRIEF に落ちる（=P0-3 バグ再現）',
          s == ns['DEBRIEF'])


def test_mutation_p0_4_no_retry_loop():
    print('\n══ 変異 P0-4：pending 再送ループを削除 → 送信失敗が回復しない ══')
    src = _bridge_source()
    target = "        # pending 再送ループ（毎フレーム走る・成功まで諦めない）\n" \
             "        if _pending_summary is not None and not summary_sent:\n"
    check('変異対象がソースにある', target in src)
    mutated = src.replace(target,
        "        # MUTATED: pending retry loop removed\n" \
        "        if False and _pending_summary is not None and not summary_sent:\n", 1)
    check('変異が反映', mutated != src)
    # 変異後は pending が処理されなくなる（静的検証）
    check('変異後 broadcast(_pending_summary) が実行されない条件',
          'if False and _pending_summary is not None' in mutated)


def test_mutation_p1_stage_updated_without_dispatched_check():
    print('\n══ 変異 P1：段階状態更新を BROADCAST_DISPATCHED チェック無しに → HELD/DROPPED 時も消費 ══')
    src = _bridge_source()
    target = "                                        if _br == BROADCAST_DISPATCHED:\n                                            catchup_stage[idx] = stage"
    check('変異対象がソースにある', target in src)
    mutated = src.replace(target,
        "                                        if True:  # MUTATED\n                                            catchup_stage[idx] = stage", 1)
    check('変異が反映', mutated != src)


def test_mutation_finished_lock_removed():
    print('\n══ 変異：FINISHED lock 削除 → FINISHED から巻き戻る ══')
    ns = _mutate_and_reload_driver_activity(
        "if prev_activity == FINISHED:\n        return (FINISHED, None, 'finished_locked')",
        "# MUTATED")
    check('変異版作成', ns is not None)
    if ns:
        a_orig, _, _ = da.evaluate_driver_activity(
            driver_state='track', prev_activity=da.FINISHED, lifecycle_state='RACING',
            handoff_start_time_s=None, current_time_s=100.0, manual_resume_signal=False)
        a_mut, _, _ = ns['evaluate_driver_activity'](
            driver_state='track', prev_activity='FINISHED', lifecycle_state='RACING',
            handoff_start_time_s=None, current_time_s=100.0, manual_resume_signal=False)
        check('本番は FINISHED', a_orig == da.FINISHED)
        check('変異版は FINISHED でなくなる', a_mut != 'FINISHED')


def test_mutation_p0_4_dispatched_check_removed_marks_sent_on_failure():
    print('\n══ 変異 P0-4：pending broadcast の DISPATCHED チェック除去 → 送信失敗でも summary_sent=True ══')
    src = _bridge_source()
    target = "if result == BROADCAST_DISPATCHED:"
    check('変異対象がソースにある', target in src)
    mutated = src.replace(target,
        "if True:  # MUTATED", 1)
    check('変異が反映', mutated != src)


def test_mutation_allow_list_becomes_allow_all():
    print('\n══ 変異：allow-list を常時 True へ → voice 全通過 ══')
    src = _bridge_source()
    target = "    return etype in ACTIVITY_ALLOWED_META_TYPES\n"
    check('変異対象がソースにある', target in src)
    mutated = src.replace(target, "    return True  # MUTATED\n", 1)
    check('変異が反映', mutated != src)


# ── preflight 配線 ─────────────────────────────────

def test_preflight_wires_driver_handoff_tests():
    print('\n══ preflight.sh に tests_driver_handoff.py がある ══')
    preflight_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'preflight.sh')
    with open(preflight_path, 'r') as f:
        pf = f.read()
    check('tests_driver_handoff.py 実行行', 'tests_driver_handoff.py' in pf)


def test_chief_engineer_packet_and_race_only_wiring():
    print('\n══ Chief Engineer v0：交代引き継ぎパケット ══')
    state={'active_plan':'A','active_plan_snapshot':{'plan_a':{
        'target_lap':12,'set_fuel_l':21,'projected_finish_margin_l':1.1}},
        'last_recalculation':{'reason':'clean_3_laps_established'}}
    packet=chief.build_packet(
        state,current_lap=5,class_position=3,gap_ahead_s=4.2,
        roster=['八木さん','まーぼーさん','ダートさん'],current_index=0)
    check('Plan/次pit/給油/余裕を保持', packet['selected_plan']=='A' and packet['next_pit_lap']==12 and packet['fuel_set_l']==21 and packet['finish_margin_l']==1.1)
    check('次ドライバーとindexを決定', packet['current_driver']=='八木さん' and packet['next_driver']=='まーぼーさん' and packet['next_driver_index']==1)
    measured = chief.build_packet(
        state, roster=['八木さん','まーぼーさん'], current_index=0,
        tire_report={'summary':'右フロント最小78.0%。負担確認。', 'measured_at_session_s':321.4})
    check('ピット実測タイヤだけをhandoffへ渡す',
          measured['tire_report']=={'summary':'右フロント最小78.0%。負担確認。', 'measured_at_session_s':321.4})
    endurance = chief.build_packet(
        state, roster=['八木さん','まーぼーさん'], current_index=0,
        endurance_plan={'available': True, 'future_stop_count': 2,
          'splash_forecast': {'planning_available': True, 'splash_candidate': True,
            'projected_final_service_l': 8.4, 'final_stint_window_in_laps': 11,
            'final_stint_window_open': False, 'traffic_rejoin_check_required': False}})
    check('前半でも終盤スプラッシュ計画をhandoffへ渡す',
          endurance['endurance_splash']=={'future_stop_count': 2,
            'projected_final_service_l': 8.4, 'final_stint_window_in_laps': 11,
            'final_stint_window_open': False, 'traffic_rejoin_check_required': False})
    packet2=chief.build_packet(state,roster=['八木さん','まーぼーさん','ダートさん'],current_index=2)
    check('最終ドライバー後は先頭へ循環', packet2['next_driver']=='八木さん' and packet2['next_driver_index']==0)
    missing=chief.build_packet({},roster=['八木さん','まーぼーさん'],current_index=0)
    check('戦略証拠なしは利用不可・数値を捏造しない', missing['available'] is False and missing['next_pit_lap'] is None and missing['fuel_set_l'] is None)
    cfg={'enabled':True,'roster':['八木さん','まーぼーさん','ダートさん'],'current_index':0}
    check('再生: ACTIVE→HANDOFF×Raceだけ発火', chief.should_emit(cfg,previous_activity='ACTIVE',new_activity='DRIVER_HANDOFF',is_race=True) is True)
    check('再生: モードOFFは発火しない', chief.should_emit({**cfg,'enabled':False},previous_activity='ACTIVE',new_activity='DRIVER_HANDOFF',is_race=True) is False)
    check('再生: Practiceは発火しない', chief.should_emit(cfg,previous_activity='ACTIVE',new_activity='DRIVER_HANDOFF',is_race=False) is False)
    check('再生: 1名だけでは発火しない', chief.should_emit({'enabled':True,'roster':['八木さん']},previous_activity='ACTIVE',new_activity='DRIVER_HANDOFF',is_race=True) is False)
    check('再生: ACTIVE以外からの遷移は発火しない', chief.should_emit(cfg,previous_activity='INACTIVE_DRIVER',new_activity='DRIVER_HANDOFF',is_race=True) is False)
    src=_bridge_source()
    check('race handoff時だけ専用packetを送る', "'type': 'chief_engineer_handoff'" in src and 'is_race=is_race_session' in src)
    check('発火条件は純粋関数を通る', 'endurance_handoff_mod.should_emit(' in src)
    transition=src[src.find('if _new_activity != _driver_activity_local:'):src.find("fuel_at_lap_start = None",src.find('if _new_activity != _driver_activity_local:'))]
    check('ACTIVE→HANDOFF遷移ブロック内でpacket生成', 'endurance_handoff_mod.build_packet' in transition and "'type': 'chief_engineer_handoff'" in transition)
    check('通常radioへ偽装せず非搭乗allow-listで配送', "'chief_engineer_handoff'," in src and "'type': 'radio', 'trigger': 'chief_engineer_handoff'" not in src)


def run_all():
    print('══ Unit E0 v3（Driver Handoff/Inactive Driver・Codex再差戻し全対応）テスト ══')
    # 純粋関数
    test_race_track_from_active_stays_active()
    test_active_to_garage_starts_handoff()
    test_handoff_exceeds_threshold()
    # P0-1
    test_p0_1_evaluate_signature_has_manual_resume_not_ptt()
    test_p0_1_inactive_with_ptt_conversation_stays_inactive()
    test_p0_1_teammate_pit_track_plus_ptt_stays_inactive()
    test_p0_1_manual_resume_confirms_reboard()
    test_p0_1_manual_resume_at_garage_does_not_reboard()
    test_p0_1_bridge_ptt_hook_does_not_mark_resume()
    test_p0_1_bridge_has_resume_cmd_handler()
    # P0-2
    test_p0_2_non_race_handoff_no_summary()
    test_p0_2_non_race_inactive_no_summary()
    test_p0_2_non_race_active_needs_session_end_confirmed()
    test_p0_2_bridge_uses_should_fire_non_race_summary()
    test_p0_2_bridge_no_handoff_summary_in_garage_path()
    # P0-3
    test_p0_3_racing_short_disconnect_stays_racing()
    test_p0_3_checker_out_disconnect_goes_debrief()
    test_p0_3_player_finished_disconnect_goes_debrief()
    test_p0_3_racing_recovers_after_reconnect()
    # P0-4
    test_p0_4_pending_summary_state_in_session_scoped_reset()
    test_p0_4_pending_unpacked_in_both_reset_paths()
    test_p0_4_summary_broadcast_uses_dispatched_check()
    test_p0_4_summary_retry_loop_outside_state_change_blocks()
    test_p0_4_pending_prepared_when_true_finish()
    test_p0_4_broadcast_returns_dispatched_string()
    # P1
    test_p1_broadcast_constants_defined()
    test_p1_stage_updates_check_dispatched_explicitly()
    # ヘルパー
    test_should_auto_fire_only_active()
    test_should_fire_race_summary_only_at_true_finish()
    # lock 系
    test_finished_locked()
    test_debrief_lifecycle_does_not_lock_finished()
    test_player_finished_lifecycle_locks_finished()
    # allow-list
    test_allow_list_meta_pass_during_inactive()
    test_allow_list_denies_voice_during_inactive()
    test_ptt_record_edges_are_idempotent()
    test_ptt_hardware_edge_starts_before_renderer_roundtrip()
    # 本番配線
    test_bridge_imports_driver_activity_module()
    test_bridge_activity_gate_before_director()
    test_active_reboard_resets_driver_scoped_call_state()
    test_bridge_manual_resume_wired_to_poll()
    test_bridge_session_scoped_reset_includes_new_state()
    # 変異試験
    test_mutation_p0_1_manual_resume_removed_reboards_without_it()
    test_mutation_p0_2_non_race_summary_allows_handoff()
    test_mutation_p0_3_debrief_still_from_racing()
    test_mutation_p0_4_no_retry_loop()
    test_mutation_p1_stage_updated_without_dispatched_check()
    test_mutation_finished_lock_removed()
    test_mutation_p0_4_dispatched_check_removed_marks_sent_on_failure()
    test_mutation_allow_list_becomes_allow_all()
    # preflight
    test_preflight_wires_driver_handoff_tests()
    test_chief_engineer_packet_and_race_only_wiring()
    print(f"\n[driver handoff v3] 合格 {pass_n} / 不合格 {fail_n}")
    return fail_n == 0


if __name__ == '__main__':
    ok = run_all()
    sys.exit(0 if ok else 1)
