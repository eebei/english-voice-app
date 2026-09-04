"""GAP の数値と対象車を一つの権威レコードにする（G1・2026-08-25）。

実走欠陥（`OMORAY-bridge-debug-20260823-1403.log`）:

    19:11:59  Luna「後ろ3.8秒。2.6秒開いた。」
    19:12:00  Bridge DATA CHECK gapBehind:0.6

自発コールと質問回答が**別の数字**を使っていた。原因は一つの poll 内で
二系統の権威が動いていたこと。

    EstTime  → nearest_ahead_gap / nearest_behind_gap と **対象車 idx** を決める
             → gap_call_policy.observe()（自発コール）はこれを読む
    F2Time   → 隣接クラス順位から **gap 値だけ** を上書きする
             → telemetry snapshot（質問回答）はこれを読む
             → **idx は EstTime 時点のまま取り残される**
             → さらに abs() で方向を潰していた

したがって「値」「方向」「対象車」がバラバラになりうる。

このモジュールは値と対象車を**同時に**確定し、方向を順位と物理位置の
両方で検証する。矛盾したら発話させない（fail-closed）。数値の意味が
違う GAP を一つの変数へ上書きしないため、種別も分ける。

決定論のみ。SDK にも I/O にも依存しない。
"""

# GAP の意味が違うものを一つの値へ混ぜない。
SOURCE_SAME_CLASS_BATTLE = 'same_class_battle_gap'   # Race の同クラス隣接順位（iRacing dashboard 準拠）
SOURCE_PHYSICAL_TRAFFIC = 'physical_traffic_gap'     # 異クラス含む物理的な前後接近（危険・traffic 用途）

DIRECTION_AHEAD = 'ahead'
DIRECTION_BEHIND = 'behind'

# 方向が確定できない時の理由。黙る場合も必ず理由を残す。
CONFLICT_RANK_VS_PHYSICAL = 'direction_conflict_rank_vs_physical'
CONFLICT_NO_TARGET = 'no_target_car'
CONFLICT_NO_VALUE = 'no_gap_value'


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def signed_gap_direction(signed_gap_s):
    """符号付き GAP（rival - player）から方向を出す。

    負 = 相手がリーダーに近い = 前。正 = 後ろ。
    **abs() を先に取らない。** 方向を確定してから表示値だけ正数化する。
    """
    if not _finite(signed_gap_s):
        return None
    if signed_gap_s < 0:
        return DIRECTION_AHEAD
    if signed_gap_s > 0:
        return DIRECTION_BEHIND
    return None


def rank_direction(target_class_position, player_class_position):
    """クラス順位から方向を出す。順位は曖昧さが無い（前は必ず番号が小さい）。"""
    if not isinstance(target_class_position, int) or not isinstance(player_class_position, int):
        return None
    if target_class_position <= 0 or player_class_position <= 0:
        return None
    if target_class_position < player_class_position:
        return DIRECTION_AHEAD
    if target_class_position > player_class_position:
        return DIRECTION_BEHIND
    return None


def resolve_direction(from_rank, from_physical):
    """順位と物理位置の両方で方向を検証する。

    片方しか無ければそれを採用する。両方あって食い違う場合は
    **どちらも採用しない**。EstTime は S/F ライン跨ぎで符号が反転しうるので、
    黙る方が誤った前後を言うより安全（実走で `DIR FIX ... EstTime said behind,
    position says ahead` が出ていた区間がこれ）。
    """
    if from_rank and from_physical:
        if from_rank == from_physical:
            return from_rank, None
        return None, CONFLICT_RANK_VS_PHYSICAL
    return (from_rank or from_physical or None), None


def _identity(record):
    if not isinstance(record, dict):
        return None
    return (record.get('session_key'), record.get('source_kind'),
            record.get('direction'), record.get('target_car_idx'))


def next_generation(previous, session_key, source_kind, direction, target_car_idx):
    """対象車・方向・セッションが変われば世代を進める。

    世代が変われば、queue に残っている旧候補は「別物」になる。
    G2（再生直前の鮮度照合）がこの値で旧候補を破棄する。
    """
    want = (session_key, source_kind, direction, target_car_idx)
    if not isinstance(previous, dict) or _identity(previous) != want:
        prev_gen = previous.get('generation') if isinstance(previous, dict) else None
        return (prev_gen + 1) if isinstance(prev_gen, int) else 1
    return previous.get('generation') or 1


def build_record(*, session_key, source_kind, signed_gap_s, target_car_idx,
                 target_class=None, target_class_position=None,
                 player_class_position=None, sampled_at, previous=None):
    """値・方向・対象車を**同時に**確定した1件を返す。

    speakable=False の時は理由が入る。呼び出し側は黙るか、
    診断 trace を残すかを選べる。値だけ使って喋ってはいけない。
    """
    base = {
        'session_key': session_key,
        'source_kind': source_kind,
        'direction': None,
        'gap_s': None,
        'signed_gap_s': signed_gap_s if _finite(signed_gap_s) else None,
        'target_car_idx': target_car_idx if isinstance(target_car_idx, int) else None,
        'target_class': target_class,
        'target_class_position': target_class_position,
        'sampled_at': sampled_at,
        'generation': None,
        'speakable': False,
        'reason': None,
    }
    if base['target_car_idx'] is None:
        base['reason'] = CONFLICT_NO_TARGET
        return base
    if not _finite(signed_gap_s):
        base['reason'] = CONFLICT_NO_VALUE
        return base

    direction, conflict = resolve_direction(
        rank_direction(target_class_position, player_class_position),
        signed_gap_direction(signed_gap_s))
    if conflict or not direction:
        base['reason'] = conflict or CONFLICT_NO_VALUE
        return base

    base['direction'] = direction
    base['gap_s'] = round(abs(signed_gap_s), 2)   # 方向確定後にだけ正数化する
    base['generation'] = next_generation(previous, session_key, source_kind,
                                         direction, base['target_car_idx'])
    base['speakable'] = True
    return base


def build_same_class_records(*, session_key, sampled_at, standings_by_pos,
                             player_class_position, player_class=None, previous=None,
                             source_kind=SOURCE_SAME_CLASS_BATTLE):
    """Race の同クラス隣接順位から前後を作る。

    `standings_by_pos` は {class_position: {'car_idx': int, 'signed_gap_s': float}}。
    **値と car_idx を同じ場所から取る**ので、対象車が取り残されない。
    """
    previous = previous if isinstance(previous, dict) else {}
    out = {DIRECTION_AHEAD: None, DIRECTION_BEHIND: None}
    if not isinstance(standings_by_pos, dict) or not isinstance(player_class_position, int):
        return out
    if player_class_position <= 0:
        return out
    for direction, pos in ((DIRECTION_AHEAD, player_class_position - 1),
                           (DIRECTION_BEHIND, player_class_position + 1)):
        entry = standings_by_pos.get(pos) or standings_by_pos.get(str(pos))
        if not isinstance(entry, dict):
            continue
        out[direction] = build_record(
            session_key=session_key,
            source_kind=(entry.get('source_kind') or source_kind),
            signed_gap_s=entry.get('signed_gap_s'),
            target_car_idx=entry.get('car_idx'),
            target_class=player_class,
            target_class_position=pos,
            player_class_position=player_class_position,
            sampled_at=sampled_at,
            previous=previous.get(direction))
    return out


def apply_same_class_records(*, session_key, sampled_at, standings_by_pos,
                             player_class_position, player_class=None, previous=None,
                             source_kind=SOURCE_SAME_CLASS_BATTLE):
    """bridge が使う唯一の入口。値・対象車・診断traceをまとめて返す。

    bridge 側へロジックを置くと文字列検査でしか守れず、実際に壊れても
    テストが通ってしまう（G1f 変異で実証）。判断はすべてここで行い、
    bridge は結果を代入するだけにする。

    returns (records, applied, traces)
        applied: {'ahead_gap','ahead_idx','behind_gap','behind_idx'}
                 speakable でない方向は None のまま＝古い値を残さない。
        traces:  喋らなかった方向とその理由（必ず記録する）
    """
    records = build_same_class_records(
        session_key=session_key, sampled_at=sampled_at,
        standings_by_pos=standings_by_pos,
        player_class_position=player_class_position,
        player_class=player_class, previous=previous, source_kind=source_kind)
    # ★G4（2026-08-25）S/F 跨ぎ対策。
    #   Race で standings が取れているなら、**権威がこの poll の唯一の出所**。
    #   確認できなかった方向は EstTime の残り値を使わず None にする。
    #   EstTime は S/F ラインを跨ぐ瞬間に符号が反転しうる（実走ログの
    #   `DIR FIX ... EstTime said behind, position says ahead`）。
    #   権威が黙った方向で旧値が生き残ると、その反転値がそのまま喋られる。
    authoritative = bool(isinstance(standings_by_pos, dict) and standings_by_pos
                         and isinstance(player_class_position, int)
                         and player_class_position > 0)
    applied = {'ahead_gap': None, 'ahead_idx': None,
               'behind_gap': None, 'behind_idx': None,
               'authoritative': authoritative}
    traces = []
    for direction, prefix in ((DIRECTION_AHEAD, 'ahead'), (DIRECTION_BEHIND, 'behind')):
        record = records.get(direction)
        value = speakable_value(record)
        if value is None:
            if isinstance(record, dict) and record.get('reason'):
                traces.append({'direction': direction, 'reason': record['reason'],
                               'target_car_idx': record.get('target_car_idx')})
            continue
        applied[prefix + '_gap'] = value
        applied[prefix + '_idx'] = record['target_car_idx']
    return records, applied, traces


def speakable_value(record):
    """喋ってよい値だけを返す。speakable でなければ None。

    「値はあるが方向が確定していない」時に値だけ使われるのを防ぐ。
    """
    if isinstance(record, dict) and record.get('speakable'):
        return record.get('gap_s')
    return None
