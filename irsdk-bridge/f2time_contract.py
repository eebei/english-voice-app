"""
OMORAY PITWALL - F2Time入力契約（R3・2026-07-21 Codex指示）

【このスプリントでやること／やらないこと】
  復帰順位の**数値計算は作らない**（Phase B・別スプリント）。ここでは「この瞬間のF2Time値は
  入力として使えるか」の有効／無効判定だけを純粋モジュールとして定義する。予測式・confidence・
  発話文生成には着手しない。

【なぜ必要か（2026-07-21 Monza実走の実測・strategy_ts-20260721-134043-ai-race.csv）】
  - `CarIdxF2Time[0]`は有効レース約31分で約15回しか変化せず、主に計時点で段階更新され、
    ピット停止中も凍結する。「値がある」ことは「今この瞬間の位置を表す」ことを意味しない。
  - `-1`は無効値のセンチネル。CSV実測でセッション開始直後にも観測されている。
  - `0`にも「まだ未確定」「先頭」等の複数の意味があり得るため、0自体は無効扱いにしないが
    単独では信用しない（他フィールドと突き合わせる）。
  - CSVでは同時に約40台が走行している一方、bridgeログ側は"drivers:1 / class空"という不完全な
    ロスターを報告していた。同クラスmapが無効な入力は、そもそも比較対象として使えない
    （class_map.py・R2と連動）。

【設計原則】
  - F2Time単独で現在位置を表現しない。`CarIdxLap`・`CarIdxLapDistPct`・`CarIdxOnPitRoad`・
    `CarIdxTrackSurface`を必須入力候補として要求し、揃っていなければ無効とする。
  - 更新時刻（SessionTime）を車ごとに保持し、値が変化しないまま時間が経ちすぎていればstale。
  - 欠損理由は文字列定数として構造化する（LLMに自由文で言わせない・既存のstrategy-guard.jsと
    同じ思想）。

【2026-07-21 Codex再指摘：stale閾値の実測根拠が無かった】
  初版は`MAX_AGE_SEC = 5.0`を固定値で持っていたが、実測（上記CSV）ではF2Timeが約2分に1回
  しか更新されない。5秒固定だとほぼ全周がstale判定になり、staleの意味が失われる。
  **正しい閾値はまだ分かっていない**（次のPhase Bで実走データを積み上げて校正する）ため、
  ここでは固定値を持たず、呼び出し側が`max_age_sec`を明示的に注入する契約にする。
  `max_age_sec`が渡されなければ「校正されていない」ことを構造化理由として返す
  （＝黙って古い値を有効扱いすることも、根拠のない閾値で無効にすることもしない）。

副作用は`F2TimeFreshnessTracker`インスタンス内に閉じる。`evaluate_f2time_input`自体は純粋関数。
"""

REASON_INVALID_VALUE = 'invalid_value'       # -1などのセンチネル
REASON_STALE = 'stale'                        # 最終更新から時間が経ちすぎている（校正済みmax_age_sec超過）
REASON_UNCALIBRATED = 'uncalibrated_staleness_threshold'  # max_age_secが未注入＝stale判定できない
REASON_MISSING_FIELD = 'missing_field'        # Lap/LapDistPct/OnPitRoad/TrackSurface等が欠けている
REASON_NO_CLASS_MAP = 'no_class_map'          # 同クラスmapが無効（class_map.NO_CLASS_MAPと連動）
REASON_NOT_SAME_CLASS = 'not_same_class'      # 有効だが比較対象外（別クラス）


def evaluate_f2time_input(f2time, session_time, last_update_session_time,
                           lap, lap_dist_pct, on_pit_road, track_surface,
                           class_map_available, is_same_class, max_age_sec=None):
    """
    ある1台のF2Time値が、この瞬間の入力として使える状態かどうかを判定する。

    Args:
      f2time: float|None                     CarIdxF2Time[car_idx]
      session_time: float|None               現在のSessionTime
      last_update_session_time: float|None   この車のF2Timeが最後に変化したSessionTime
                                              （呼び出し側がF2TimeFreshnessTrackerで保持）
      lap: int|None                          CarIdxLap[car_idx]
      lap_dist_pct: float|None               CarIdxLapDistPct[car_idx]
      on_pit_road: bool|None                 CarIdxOnPitRoad[car_idx]
      track_surface: int|None                CarIdxTrackSurface[car_idx]
      class_map_available: bool              class_map.evaluate_class_map()の'available'
      is_same_class: bool                    比較対象車がsame_class_car_idxsに含まれるか
                                              （class_map_availableがFalseの時は無視してよい）
      max_age_sec: float|None                stale判定の閾値（秒）。呼び出し側が実測から校正して
                                              明示的に注入する。Noneなら「未校正」として無効を返す
                                              （固定のデフォルト値は持たない・Codex指示）。

    Returns:
      {'valid': bool, 'reason': str|None, 'ageSec': float|None, 'sourceFields': dict}
    """
    source_fields = {
        'f2time': f2time, 'lap': lap, 'lap_dist_pct': lap_dist_pct,
        'on_pit_road': on_pit_road, 'track_surface': track_surface,
    }

    if not class_map_available:
        return {'valid': False, 'reason': REASON_NO_CLASS_MAP, 'ageSec': None, 'sourceFields': source_fields}

    if not is_same_class:
        return {'valid': False, 'reason': REASON_NOT_SAME_CLASS, 'ageSec': None, 'sourceFields': source_fields}

    if f2time is None or f2time < 0:
        return {'valid': False, 'reason': REASON_INVALID_VALUE, 'ageSec': None, 'sourceFields': source_fields}

    if lap is None or lap_dist_pct is None or on_pit_road is None or track_surface is None:
        return {'valid': False, 'reason': REASON_MISSING_FIELD, 'ageSec': None, 'sourceFields': source_fields}

    age_sec = None
    if session_time is not None and last_update_session_time is not None:
        age_sec = max(0.0, session_time - last_update_session_time)

    # ★Codex指示：校正済みの閾値が無ければ、staleかどうかを判定できない＝無効として扱う。
    #   ここを「閾値が無ければ通す」にすると、根拠のない値をそのまま使う元の欠陥に戻る。
    if max_age_sec is None:
        return {'valid': False, 'reason': REASON_UNCALIBRATED, 'ageSec': age_sec, 'sourceFields': source_fields}

    if age_sec is not None and age_sec > max_age_sec:
        return {'valid': False, 'reason': REASON_STALE, 'ageSec': age_sec, 'sourceFields': source_fields}

    return {'valid': True, 'reason': None, 'ageSec': age_sec, 'sourceFields': source_fields}


class F2TimeFreshnessTracker:
    """
    車ごとにF2Timeの最終更新SessionTimeを保持する。副作用はこのインスタンス内に閉じる。
    実測（strategy_ts-20260721-134043-ai-race.csv）でF2Timeは高頻度更新ではなく段階更新
    （約31分で約15回）なので、「毎フレームの値」ではなく「値が変わった瞬間」を更新時刻とする
    （race_lifecycle.pyのLapLastLapTime変化検出と同じ考え方）。
    """
    def __init__(self):
        self._last_value = {}         # car_idx -> 直近観測したF2Time
        self._last_update_time = {}   # car_idx -> その値が変わった時のSessionTime

    def observe(self, car_idx, f2time, session_time):
        """毎フレーム呼ぶ。値が変わった時だけ更新時刻を進める。最終更新SessionTimeを返す。"""
        prev = self._last_value.get(car_idx)
        if f2time is not None and f2time != prev:
            self._last_value[car_idx] = f2time
            self._last_update_time[car_idx] = session_time
        return self._last_update_time.get(car_idx)

    def reset(self):
        """新しいセッション（SessionNum変更・telemetry再接続）で呼ぶ。"""
        self._last_value.clear()
        self._last_update_time.clear()
