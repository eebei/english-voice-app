"""
OMORAY PITWALL - 同クラス判定のfail-closedゲート（R2・2026-07-21 Codex指示）

【なぜ必要か】
  2026-07-21のMonza AIレース(約40台)実走で、bridgeのSessionInfo解析結果が
  "drivers:1 / class空"と報告した（DriverInfo rosterがほぼ空、または自車のCarClassIDが取れて
  いない状態）。この状態のまま復帰順位や同クラス比較の計算を進めると、無関係な車を「同じクラス」
  として扱ったり、逆に本当の同クラス車を見落としたりする危険がある。

  この状態を**確実に検知して計算そのものを止める**のがこのモジュールの役目。
  Phase Bの復帰順位計算器はまだ存在しない（別スプリント）。このモジュールは、それに使う
  「安全な同クラス集合」を返すか、`NO_CLASS_MAP`で拒否するかだけを決める。

【設計原則（Codex指示）】
  - 同クラス判定は**数値のCarClassIDのみ**で行う。車名・カテゴリ表示文字列は一切見ない
    （未知の車種名でも、ClassIDが同じなら同クラス）。
  - `CarIdxClassPosition`の順位番号だけから同クラス集合を推測しない
    （クラスごとに1,2,3...と重複するため、順位だけでは何のクラスかわからない）。
  - アクティブな車（テレメトリ上に実在する車）に対してDriverInfo rosterが不完全、
    PlayerCarIdxが不明、自車のClassIDが不明、または比較対象車のClassIDが不明なら、
    **1台でも欠けていれば**計算全体を禁止する（部分的なrosterで推測しない＝fail-closed）。

副作用なし。bridge.py・テストが同じ関数をimportする。
"""

NO_CLASS_MAP = 'NO_CLASS_MAP'


def evaluate_class_map(active_car_idxs, player_car_idx, car_class_map):
    """
    復帰順位計算（Phase B）の前提となる「安全な同クラス集合」が求まるかを判定する。

    Args:
      active_car_idxs: Iterable[int]  現在アクティブな(テレメトリ上に実在する)car_idx集合。
                        例：CarIdxClassPosition[i] > 0 な i の一覧。ここでは順位の値そのものは使わない。
      player_car_idx: int|None  自車のcar_idx。DriverInfoから取れていなければ -1 や None を渡す。
      car_class_map: dict[int, int]  car_idx -> class_id（DriverInfoの数値CarClassID。文字列不可）。

    Returns:
      {
        'available': bool,
        'reason': str|None,                     # 不可なら NO_CLASS_MAP、可なら None
        'same_class_car_idxs': set[int]|None,    # 自車を含む同クラスのcar_idx集合（available時のみ）
        'missing_car_idxs': list[int],           # active だが car_class_map に無い car_idx（診断用・常に返す）
      }
    """
    active = set(int(i) for i in active_car_idxs)
    missing = sorted(i for i in active if i not in car_class_map)

    if player_car_idx is None or player_car_idx < 0:
        return {'available': False, 'reason': NO_CLASS_MAP,
                'same_class_car_idxs': None, 'missing_car_idxs': missing}

    if player_car_idx not in car_class_map:
        return {'available': False, 'reason': NO_CLASS_MAP,
                'same_class_car_idxs': None, 'missing_car_idxs': missing}

    if missing:
        # activeなのにclass_idが不明な車が1台でもいれば、安全側に倒して計算しない。
        return {'available': False, 'reason': NO_CLASS_MAP,
                'same_class_car_idxs': None, 'missing_car_idxs': missing}

    player_class_id = car_class_map[player_car_idx]
    same_class = {idx for idx in active if car_class_map.get(idx) == player_class_id}
    return {'available': True, 'reason': None,
            'same_class_car_idxs': same_class, 'missing_car_idxs': []}
