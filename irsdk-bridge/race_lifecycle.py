"""
OMORAY PITWALL - レース終了状態機械（R1・2026-07-21 Codex指示）

【なぜ必要か】
  2026-07-21のMonza実走（14:25:44 SessionState 4→5, 14:27:15 残り推定が7周へ跳ね燃料/ピット計画を
  誤発話, 14:28:19 Yujiが「レース終わってる」と訂正）で、リーダーへのチェッカー・自分のチェッカー・
  デブリーフの3つを区別できていないことが確定した。

  SessionState=5（Checkered）は**セッション全体で共有される値**——リーダーがチェッカーを受けた瞬間、
  まだ数周残っている自分も含めて全員が同時にこの値になる（2026-07-05実走 + 2026-07-13再指摘で
  bridge.py側は既に確認済み。1830行台の checkered_pending の実装コメント参照）。
  ここで即「自分は完走した」扱いにすると、まだ走っている最中に残り周回計算・燃料戦略・ピット計画を
  止めてしまう（または逆に発火させ続けてしまう）。

【状態】
  RACING           通常走行（レース開始前の待機も含む・以下の3状態のいずれでもない状態）
  CHECKER_OUT       セッション全体にチェッカーが出たが、自車はまだ完走していない
  PLAYER_FINISHED   自車がS/Fラインを実際に通過し、完走した
  DEBRIEF           ガレージへ戻った、またはtelemetryが非アクティブ

【自車の完走をどう検出するか】
  主判定：`LapLastLapTime`の値が変化した瞬間＝自車が今S/Fラインを通過した瞬間。
    これはbridge.pyの既存のラップ完了検知（1575行台）と同じ根拠を使う（実走で確認済みの検出法を流用、
    新しい未検証の検出法を持ち込まない）。
  補助判定（利用可能な場合のみ）：`CarIdxLapCompleted[PlayerCarIdx]`が増加した。
    ★2026-07-21時点でこの変数がこのSDKビルドに実在するか、生ダンプで確認できていない
    （Codex指示：「存在を記憶で断定せず、既存dumpまたは実コード索引で確認する」）。
    そのためこれは**任意の補強シグナル**として扱い、Noneなら無視する。主判定はLapLastLapTimeのみ。

  「同時/近接」ケース（自車がリーダー＝自分の完走とセッション全体のチェッカーがほぼ同フレーム）に
  対応するため、RACING→CHECKER_OUTへ遷移する判定と、S/F通過（LapLastLapTime変化）の判定は
  **同じupdate()呼び出し内で両方評価する**。baselineは「このフレームの直前に観測した値」を使うため、
  今フレームで両方の条件が真になれば同じ呼び出しでPLAYER_FINISHEDまで進む。

【iRSDK SessionStateの値（irsdk_defines.h・公開enum。2026-07-21実測CSVで0..6を確認）】
  0 = StateInvalid
  1 = StateGetInCar
  2 = StateWarmup
  3 = StateParadeLaps
  4 = StateRacing
  5 = StateCheckered
  6 = StateCoolDown

副作用なし。bridge.pyは`RaceLifecycle`インスタンスを保持し、毎フレーム`update()`を呼ぶだけ。
"""

RACING = 'RACING'
CHECKER_OUT = 'CHECKER_OUT'
PLAYER_FINISHED = 'PLAYER_FINISHED'
DEBRIEF = 'DEBRIEF'

SS_INVALID = 0
SS_GET_IN_CAR = 1
SS_WARMUP = 2
SS_PARADE_LAPS = 3
SS_RACING = 4
SS_CHECKERED = 5
SS_COOL_DOWN = 6


class RaceLifecycle:
    def __init__(self):
        self.state = RACING
        self._last_lap_last_lap_time = None   # 直前フレームで観測したLapLastLapTime（S/F通過検出の基準）
        self._last_car_idx_lap_completed = None      # 直前フレームで観測したCarIdxLapCompleted
        self._checker_baseline_lap_completed = None  # CHECKER_OUT突入時点のCarIdxLapCompleted（補助判定）

    def reset(self):
        """新しいセッション（SessionNum変更・telemetry再接続）で呼ぶ。RACINGへ初期化する。"""
        self.state = RACING
        self._last_lap_last_lap_time = None
        self._last_car_idx_lap_completed = None
        self._checker_baseline_lap_completed = None

    def update(self, session_state, lap_last_lap_time, telemetry_active, driver_state,
               car_idx_lap_completed=None):
        """
        毎フレーム呼ぶ。戻り値は更新後のstate（self.stateと同じ）。

        Args:
          session_state: int|None  iRSDKのSessionState（0..6）。Noneは不明扱い（何もしない）。
          lap_last_lap_time: float|None  自車のLapLastLapTime。
          telemetry_active: bool  iRacing接続中か。
          driver_state: str|None  'garage'/'track'/'pit'等。
          car_idx_lap_completed: int|None  利用可能ならCarIdxLapCompleted[PlayerCarIdx]。
                                            未確認の変数のため省略可（Noneなら判定に使わない）。
        """
        # 呼び出しの最後に必ずこれらを更新して戻る（早期returnを避けて漏れを防ぐ）
        def _finish(new_state):
            self.state = new_state
            self._last_lap_last_lap_time = lap_last_lap_time
            self._last_car_idx_lap_completed = car_idx_lap_completed
            return self.state

        # ── DEBRIEF：真の完走証拠がある場合のみ ──
        # ★2026-07-26 Unit E0 v3 (Codex P0-3)：telemetry_active=False で無条件に DEBRIEF へ進む
        #   実装は、短時間 telemetry 断（iRacing 一時的な処理遅延等）で DEBRIEF に永久 lock され、
        #   同一セッションで telemetry が復帰しても director_gate が全レース無線を落とす。
        #   修正：CHECKER_OUT は「総合首位にチェッカー」であり自車完走の証拠ではない。
        #        DEBRIEF は PLAYER_FINISHED 後の telemetry 断だけで許可。それ以外は現状態を保持し、
        #        短時間断→復帰で自動発話が回復する。
        if not telemetry_active:
            if self.state == PLAYER_FINISHED:
                return _finish(DEBRIEF)
            # 完走前の telemetry 断は現状態維持（RACING なら RACING のまま）→ 復帰で継続可
            return _finish(self.state)

        # ── S/F通過シグナル（このフレームで起きたか）を先に計算 ──
        #   baselineは「直前フレームまでに観測した値」＝今フレームの値とここで比較して初めて意味を持つ。
        finished_edge = (
            lap_last_lap_time is not None
            and self._last_lap_last_lap_time is not None
            and lap_last_lap_time != self._last_lap_last_lap_time
        )
        lap_completed_edge = (
            car_idx_lap_completed is not None
            and self._checker_baseline_lap_completed is not None
            and car_idx_lap_completed > self._checker_baseline_lap_completed
        )

        if session_state is None:
            return _finish(self.state)

        # ── ガレージ帰還＝レース終了後のみDEBRIEF（レース前の待機中ガレージは対象外） ──
        if driver_state == 'garage' and self.state == PLAYER_FINISHED:
            return _finish(DEBRIEF)

        if self.state == RACING:
            if session_state in (SS_CHECKERED, SS_COOL_DOWN):
                # ★CHECKER_OUT突入の瞬間、直前フレームまでのCarIdxLapCompletedをbaselineに固定する。
                self._checker_baseline_lap_completed = self._last_car_idx_lap_completed
                lap_completed_edge = (
                    car_idx_lap_completed is not None
                    and self._checker_baseline_lap_completed is not None
                    and car_idx_lap_completed > self._checker_baseline_lap_completed
                )
                new_state = CHECKER_OUT
                # ★同時/近接ケース：この遷移と同じフレームでS/F通過も起きていれば、続けて判定する。
                if finished_edge or lap_completed_edge:
                    new_state = PLAYER_FINISHED
                return _finish(new_state)
            return _finish(RACING)

        if self.state == CHECKER_OUT:
            new_state = PLAYER_FINISHED if (finished_edge or lap_completed_edge) else CHECKER_OUT
            return _finish(new_state)

        if self.state == PLAYER_FINISHED:
            # 完走後にsession_stateが4へ巻き戻っても（テレメトリの瞬断・再接続等）、
            # 完走の事実は覆さない。新セッションはbridge.py側でreset()を呼ぶ。
            return _finish(PLAYER_FINISHED)

        return _finish(self.state)


# ── 発話・計算ゲート（Codex指示 §3「発話・計算ゲート」） ──────────────────────
def fuel_strategy_allowed(state):
    """fuel_strategy_warning・新規ピット戦略はRACINGでのみ許可。"""
    return state == RACING


def new_pit_strategy_allowed(state):
    return state == RACING


def remaining_laps_may_increase(state):
    """State 5(チェッカー)以後、残り周回推定値を増加させない。"""
    return state == RACING


def director_active(state):
    """DEBRIEFでは走行中ディレクター（レース無線）を停止する。"""
    return state != DEBRIEF


def pit_plan_allowed(state):
    """PLAYER_FINISHEDではピット計画・残り周回計算を禁止。CHECKER_OUTでも新規戦略は禁止。"""
    return state == RACING


def checker_out_notice_allowed(state, already_notified):
    """CHECKER_OUTでは新規ピット戦略の代わりに、一度だけ「最終周／残量○L」を許可する。"""
    return state == CHECKER_OUT and not already_notified
