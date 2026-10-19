"""
OMORAY PITWALL - Authoritative Race Facts Snapshot（WO-002 / R1）

review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md WO-002。raw `SessionFlags`、
black-flagの三値状態、source frame、Driverのpit visit順序を、iRacingの同一
telemetry frameから権威化するための純粋関数群。

【責務】
  Bridgeのpoll loop（`bridge.poll_iracing()`）が1poll iterationにつき一度だけ
  `SessionFlags`/`SessionTime`を読み、ここへ渡して単一のsnapshotを組み立てる。
  以後そのframeを扱う全consumer（現状はpit exitのblack flag evidence投影）は
  再読込せずこのsnapshotをそのまま使う。

【unknown契約】
  raw_valueが整数でなければ`state='unknown'`。`raw_value=0`（実際に0と読めた）
  と`raw_value=None`（SDK変数自体が読めなかった）を混同しない——`or 0`で
  丸めない。black flag bitは`0x00010000`で、yellow/caution bits(`0xC000`)とは
  無関係。

【不変性】
  `build_snapshot()`が返すdictはconsumerが変更しないこと。broadcast/pit sample
  へは`project_black_flag_evidence()`でcopyしてから載せ、後続frameのsnapshot
  更新が過去に発行済みの値を書き換えないようにする。

【スコープ外（WO-003以降）】
  `DriverPitEvent`のnormal/early/penalty/unresolved分類、Plan lifecycle、
  Driver command、LLM context、speech、memoryはこのモジュールの責務ではない。
"""

import math

def _raw_flags(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 0xffffffff

def _raw_time(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0

BLACK_FLAG_BIT = 0x00010000
SESSION_FLAGS_AUTHORITY = 'iRacing SessionFlags'


def classify_black_flag(raw_session_flags):
    """1frame分の生`SessionFlags`から black flag の三値状態を導く。

    Args:
      raw_session_flags: `reader.read_int('SessionFlags')`の戻り値そのもの。
        int（0を含む）なら実際の読み取り、Noneなら SDK 変数自体が読めなかった
        （unavailable）。

    Returns:
      {'state': 'true'|'false'|'unknown', 'authority': ..., 'raw_value': ...,
       'freshness': 'fresh'|'unavailable'}
      fuel delta・stall時間・repair・cautionからは絶対に補完しない。
    """
    if not _raw_flags(raw_session_flags):
        return {
            'state': 'unknown',
            'authority': SESSION_FLAGS_AUTHORITY,
            'raw_value': None,
            'freshness': 'unavailable',
        }
    return {
        'state': 'true' if (raw_session_flags & BLACK_FLAG_BIT) else 'false',
        'authority': SESSION_FLAGS_AUTHORITY,
        'raw_value': raw_session_flags,
        'freshness': 'fresh',
    }


def build_snapshot(*, race_instance_id, session_num, source_frame_sequence,
                    session_time_s, raw_session_flags, driver_pit_sequence):
    """1poll iteration分の権威snapshotを組み立てる（読取専用・副作用なし）。

    `raw_session_flags`と`session_time_s`は呼び出し側が同じpoll iteration内で
    連続して読んだ値であること（同一frameの根拠であるための前提）。

    Args:
      race_instance_id: 既存`resolve_race_instance_id()`の戻り値をそのまま渡す
        （ここで再計算しない）。
      session_num: このframeの`SessionNum`（PracticeやQualifyを跨いでは同一
        raceでも別値になり得る。race_instance_idの代用にしない）。
      source_frame_sequence: Bridge内で正常受理したpoll frameの単調増加連番。
      session_time_s: 同じpoll iterationで読んだ`SessionTime`（`None`もあり得る）。
      raw_session_flags: 同じpoll iterationで読んだ`SessionFlags`（`None`もあり得る）。
      driver_pit_sequence: 直近までに確定したpit exit回数（このframe時点の値。
        このframe自体がpit exitなら、呼び出し側がincrement後の値を渡すこと）。
    """
    session_time_s = session_time_s if _raw_time(session_time_s) else None
    black_flag = classify_black_flag(raw_session_flags)
    black_flag = dict(
        black_flag,
        observed_session_time=session_time_s,
        source_frame_sequence=source_frame_sequence,
    )
    return {
        'race_instance_id': race_instance_id,
        'session_num': session_num,
        'source_frame': {
            'sequence': source_frame_sequence,
            'session_time_s': session_time_s,
        },
        'session_flags': {
            'authority': SESSION_FLAGS_AUTHORITY,
            'available': _raw_flags(raw_session_flags),
            'raw_value': raw_session_flags if _raw_flags(raw_session_flags) else None,
        },
        'black_flag': black_flag,
        'driver_pit_sequence': driver_pit_sequence,
    }


def reset_pit_sequence_if_identity_changed(current_sequence, *, race_instance_id,
                                            session_num, prev_race_instance_id,
                                            prev_session_num):
    """Call once per poll iteration, BEFORE build_snapshot() and before any
    pit-exit increment for that same iteration.

    Returns 0 if `race_instance_id` or `session_num` differs from the
    PREVIOUS iteration's own values (a real race/session boundary); otherwise
    returns `current_sequence` unchanged.

    This is intentionally independent of *why* bridge.py is re-deriving
    identity this frame. A sustained reconnect currently forces bridge.py to
    re-parse SessionInfo and, when no authoritative SubSessionID/
    WeekendSessionID is available, mint a fresh race_instance_id fallback —
    in that case identity genuinely changed and this must reset. But when a
    reconnect happens to occur on a race that DOES have a stable
    SubSessionID, race_instance_id itself does not change, and this must NOT
    reset merely because some other unrelated bridge.py state got cleared by
    the reconnect path. Comparing the actual identity values (not the
    reconnect event) is what keeps those two cases apart.
    """
    if race_instance_id != prev_race_instance_id or session_num != prev_session_num:
        return 0
    return current_sequence


def with_incremented_pit_sequence(snapshot):
    """The SINGLE place a confirmed pit exit advances `driver_pit_sequence`.

    Returns a NEW snapshot (the input is left unmodified — any projection
    already copied from it via project_black_flag_evidence() is unaffected)
    whose `driver_pit_sequence` is the input's own value + 1. Every other
    field — race_instance_id, session_num, source_frame, session_flags,
    black_flag — is carried over UNCHANGED from the already-built `snapshot`;
    this must never re-derive them or re-read raw SessionFlags/SessionTime.

    Call this exactly once per confirmed OnPitRoad true->false transition,
    using the SAME snapshot already built for that poll iteration. The
    caller must then source BOTH the pit_timing.sample's own
    `driver_pit_sequence` field AND the carry-forward value for the next
    poll iteration's build_snapshot() call from this function's return value
    — never from an independently-incremented local counter — so the
    snapshot stays the single owner instead of drifting from whatever a
    consumer increments on the side.
    """
    return dict(snapshot, driver_pit_sequence=snapshot['driver_pit_sequence'] + 1)


def project_black_flag_evidence(snapshot, source_visit_fuel_added_l):
    """`snapshot`のblack-flag facetを、`pit_timing.sample`へ載せる不変copyへ
    投影する。`source_visit_fuel_added_l`は同じpit sampleの`fuel_added_l`を
    そのままcopyした相関fieldであり、black flag判定の根拠には使わない
    （black flag authorityは常にraw SessionFlagsのみ）。

    参照ではなくcopyを返すため、後続frameが`snapshot`を更新しても、既に
    broadcastへ渡した投影は書き変わらない。
    """
    bf = snapshot['black_flag']
    return {
        'state': bf['state'],
        'source_visit_fuel_added_l': source_visit_fuel_added_l,
        'freshness': bf['freshness'],
        'authority': bf['authority'],
        'raw_value': bf['raw_value'],
        'observed_session_time': bf['observed_session_time'],
        'source_frame_sequence': bf['source_frame_sequence'],
    }
