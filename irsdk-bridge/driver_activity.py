"""
OMORAY PITWALL - Driver Handoff / Inactive Driver 認識（Unit E0 v3・2026-07-26 Codex差戻し対応）

【なぜ必要か】
  2026-07-25 IMSA Road America 6HR 耐久（八木/まーぼー/ダート 3人体制）で複数環境から
  以下の P0 問題が再現された：
    - 八木氏 19:30頃・26周目で誤 DEBRIEF。実際はレースが約3時間18分継続
    - まーぼー氏 18:34:31 summary → 18:34:51「レース終わったよ」。実際は継続中
    - ダート氏 ドライバー交代ごとに pit_entry が二重発火
    - Practice 中に Masao Takeda 氏運転・八木氏の官兵衛が limiter/Box 発話

【v3 設計方針（Codex 再差戻し反映）】
  P0-1: PTT を activity 判定から完全削除。非搭乗中も観戦者が PTT で会話するのは正常操作。
        PTT を再搭乗信号にするとチームメイト運転中の観戦者会話で誤活性する。
        実走ログではチームメイト運転中は driver_state='garage'、交代時だけ一時的に
        'pit' が見える。したがって HANDOFF/INACTIVE からの自動復帰は 'track' のみで確定し、
        'pit' は明示 CMD（resume_driving_support）がある場合だけ復帰を許す。
  P0-2: Practice/Qualify でも DRIVER_HANDOFF/INACTIVE_DRIVER で summary を発火しない。
        garage 単独を終了証拠にできない。SessionNum 変更/telemetry 長期断/明示終了操作でのみ。

【状態】
  ACTIVE           使用者本人が track/pit で走行中（通常発話許可）
  DRIVER_HANDOFF   garage 短時間滞在（<HANDOFF_TO_INACTIVE_SEC）＝交代中
  INACTIVE_DRIVER  garage 長期滞在＝チームメイトが走行中
  FINISHED         lifecycle=PLAYER_FINISHED（真の完走・不可逆）
  UNKNOWN          判定材料不足＝fail-closed

【CHECKER_OUT の扱い】
  CHECKER_OUT 中に本人が走行中なら activity=ACTIVE のまま → 自動発話継続。
  「CHECKER_OUT で使用者本人がまだ走ってる場合は停止しない」（Codex 特別指示）を満たす。

副作用なし。純粋関数として単体テスト可能。
"""

ACTIVE = 'ACTIVE'
DRIVER_HANDOFF = 'DRIVER_HANDOFF'
INACTIVE_DRIVER = 'INACTIVE_DRIVER'
FINISHED = 'FINISHED'
UNKNOWN = 'UNKNOWN'

# garage 滞在秒数の閾値。これを超えたら DRIVER_HANDOFF → INACTIVE_DRIVER。
# 状態ラベル用（発話抑止は HANDOFF 開始時から既に効いているのでこの閾値は抑止に影響しない）。
HANDOFF_TO_INACTIVE_SEC = 30.0


def evaluate_driver_activity(
    driver_state,
    prev_activity,
    lifecycle_state,
    handoff_start_time_s,
    current_time_s,
    manual_resume_signal,
):
    """使用者本人が今コックピットに座って走ってるかを判定する純粋関数。
    poll_iracing() から毎フレーム呼ばれる本番コード。単体テストからも直接呼べる。

    Args:
      driver_state: str|None  'garage'/'track'/'pit'/None（None=不明）
      prev_activity: str|None  前フレームの activity（初回は None）
      lifecycle_state: str  'RACING'/'CHECKER_OUT'/'PLAYER_FINISHED'/'DEBRIEF'
      handoff_start_time_s: float|None  前回 garage 遷移開始時刻（SessionTime基準）
      current_time_s: float|None  現在の SessionTime
      manual_resume_signal: bool  ★NEW v3：明示的な「運転支援再開」CMD 受信フラグ
                                   （PTT ではない・専用操作。通常 PTT との兼用不可）

    Returns:
      (new_activity: str, new_handoff_start: float|None, reason: str)

    契約:
      - FINISHED からは巻き戻さない（レース終了は不可逆）
      - lifecycle=PLAYER_FINISHED のみが FINISHED lock の源
        （DEBRIEF は源にしない・telemetry 短時間断で誤 lock を防ぐ）
      - driver_state=None は UNKNOWN（fail-closed）
      - ACTIVE→garage 遷移で DRIVER_HANDOFF 開始
      - HANDOFF 継続中、HANDOFF_TO_INACTIVE_SEC 経過で INACTIVE_DRIVER へ
      - HANDOFF/INACTIVE から ACTIVE 自動復帰は driver_state='track' のみ
        （3名の実走ログでチームメイト走行中は garage、交代時だけ pit が見えた事実に基づく）
      - driver_state='pit' からの復帰は manual_resume_signal=True 必須
        （交代先ドライバーの pit 状態による二重発話を防ぐ）
      - is_race_session による分岐は無し（Practice/Qualify でも交代あり）
    """
    # FINISHED lock（レース終了の不可逆性）
    if prev_activity == FINISHED:
        return (FINISHED, None, 'finished_locked')

    # ★v2 Codex P0-5：PLAYER_FINISHED のみが FINISHED lock 源
    if lifecycle_state == 'PLAYER_FINISHED':
        return (FINISHED, None, 'lifecycle_player_finished')

    # driver_state 不明は UNKNOWN（fail-closed で自動発話停止側へ）
    if driver_state is None:
        return (UNKNOWN, handoff_start_time_s, 'no_driver_state')

    # 初回 or ACTIVE から
    if prev_activity in (ACTIVE, None):
        if driver_state in ('track', 'pit'):
            return (ACTIVE, None, 'active_at_wheel')
        if driver_state == 'garage':
            return (DRIVER_HANDOFF, current_time_s, 'entered_garage')
        return (UNKNOWN, None, 'unknown_ds_from_active')

    # HANDOFF / INACTIVE から：
    # - track は本人向け IsOnTrack が真になった実測済みの再搭乗証拠として自動復帰
    # - pit は交代先ドライバーでも一時的に見えるため、明示 resume がある時だけ復帰
    if prev_activity in (DRIVER_HANDOFF, INACTIVE_DRIVER):
        if driver_state == 'track':
            return (ACTIVE, None, 'on_track_confirmed_reboard')
        if manual_resume_signal and driver_state == 'pit':
            return (ACTIVE, None, 'manual_resume_confirmed')
        # HANDOFF 継続中のタイマー判定
        if prev_activity == DRIVER_HANDOFF:
            if (handoff_start_time_s is not None
                    and current_time_s is not None
                    and (current_time_s - handoff_start_time_s) >= HANDOFF_TO_INACTIVE_SEC):
                return (INACTIVE_DRIVER, handoff_start_time_s,
                        'handoff_exceeded_threshold')
            return (DRIVER_HANDOFF, handoff_start_time_s, 'still_in_handoff')
        # INACTIVE 継続（明示再開 CMD が来るまで戻らない）
        return (INACTIVE_DRIVER, handoff_start_time_s, 'still_inactive_no_manual_resume')

    # UNKNOWN からも track は自動復帰、pit は明示 resume 必須。
    if prev_activity == UNKNOWN:
        if driver_state == 'track':
            return (ACTIVE, None, 'on_track_rearm_from_unknown')
        if manual_resume_signal and driver_state == 'pit':
            return (ACTIVE, None, 'manual_resume_from_unknown')
        if driver_state == 'garage':
            return (DRIVER_HANDOFF, current_time_s, 'unknown_to_garage')
        return (UNKNOWN, handoff_start_time_s, 'still_unknown_no_manual_resume')

    # 未定義 prev_activity（安全側）
    return (UNKNOWN, handoff_start_time_s, 'fallthrough')


def should_auto_fire(driver_activity):
    """自動発話（bridge.py の broadcast）を許可するか。ACTIVE のみ True。"""
    return driver_activity == ACTIVE


def should_fire_race_summary(driver_activity, lifecycle_state):
    """レース session_summary の発火許可判定。真の完走時のみ 1回。"""
    return (driver_activity == FINISHED
            and lifecycle_state == 'PLAYER_FINISHED')


def should_finalize_non_race_summary(
    session_num_changed,
    previous_is_race_session,
    has_laps,
    session_started,
    summary_sent,
):
    """Practice/Qualify summaryを確定してよいか。

    garageやactivity状態は使わず、iRacingのSessionNum変更だけを終了の権威にする。
    """
    return (
        bool(session_num_changed)
        and not bool(previous_is_race_session)
        and bool(has_laps)
        and bool(session_started)
        and not bool(summary_sent)
    )
