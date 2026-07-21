"""
OMORAY PITWALL - class_map.py テスト（R2・2026-07-21 Codex指示）
実行: python3 irsdk-bridge/tests_class_map.py
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import class_map as cm  # noqa: E402

pass_n, fail_n = 0, 0


def check(name, cond, detail=''):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print('  ✅ ' + name)
    else:
        fail_n += 1
        print('  ❌ ' + name + ('  → ' + str(detail) if detail else ''))


# ① 3クラス×複数台、ClassPosition 1..Nがクラスごとに重複 ─────────────────
#   class_positionはこの関数に一切渡さない＝重複していても影響しないことを確認する。
def test_multiclass_duplicate_positions():
    # car_idx: 0,1,2=GT3(class_id=10) / 3,4,5=GTP(class_id=20) / 6,7,8=LMP2(class_id=30)
    # 実際のCarIdxClassPositionはクラスごとに1,2,3...と重複するが、ここでは使わない。
    car_class_map = {0: 10, 1: 10, 2: 10, 3: 20, 4: 20, 5: 20, 6: 30, 7: 30, 8: 30}
    active = list(range(9))
    r = cm.evaluate_class_map(active, player_car_idx=1, car_class_map=car_class_map)
    check('①3クラス混在: available', r['available'], r)
    check('①自車(GT3)と同じクラスの車だけを返す', r['same_class_car_idxs'] == {0, 1, 2}, r['same_class_car_idxs'])


# ② 未知車種名だがClassIDは既知／同一 ────────────────────────────────
#   car_class_mapは元々class_idしか持たない設計なので、車名文字列がどうであれ結果は同じになる。
def test_unknown_car_name_same_class_id():
    car_class_map = {0: 99, 1: 99, 2: 41}  # 99="未知の新車種"のclass_idのつもりでも数値なら扱える
    r = cm.evaluate_class_map([0, 1, 2], player_car_idx=0, car_class_map=car_class_map)
    check('②未知車種でもclass_id一致なら同クラス扱い', r['same_class_car_idxs'] == {0, 1}, r)


# ③ rosterが自車1台だけでtelemetry上は40台 ───────────────────────────
def test_roster_only_player_but_40_active():
    car_class_map = {0: 10}  # 自車だけ
    active = list(range(40))
    r = cm.evaluate_class_map(active, player_car_idx=0, car_class_map=car_class_map)
    check('③roster不完全(1/40)はNO_CLASS_MAP', r['available'] is False and r['reason'] == cm.NO_CLASS_MAP, r)
    check('③missing_car_idxsが39件', len(r['missing_car_idxs']) == 39, len(r['missing_car_idxs']))


# ④ player class空 ───────────────────────────────────────────────
def test_player_class_unknown():
    car_class_map = {1: 10, 2: 10}  # car_idx=0(自車)が無い
    r = cm.evaluate_class_map([0, 1, 2], player_car_idx=0, car_class_map=car_class_map)
    check('④自車のClassID不明はNO_CLASS_MAP', r['available'] is False and r['reason'] == cm.NO_CLASS_MAP, r)

    r2 = cm.evaluate_class_map([0, 1, 2], player_car_idx=-1, car_class_map=car_class_map)
    check('④PlayerCarIdx自体が不明(-1)もNO_CLASS_MAP', r2['available'] is False and r2['reason'] == cm.NO_CLASS_MAP, r2)


# ⑤ 一部他車のみclass欠損 ─────────────────────────────────────────
def test_partial_missing_other_car():
    car_class_map = {0: 10, 1: 10, 2: 10}  # car_idx=3が欠けている
    r = cm.evaluate_class_map([0, 1, 2, 3], player_car_idx=0, car_class_map=car_class_map)
    check('⑤他車1台だけ欠損でもNO_CLASS_MAP(部分推測しない)', r['available'] is False and r['reason'] == cm.NO_CLASS_MAP, r)
    check('⑤missing_car_idxsに3が入る', r['missing_car_idxs'] == [3], r['missing_car_idxs'])


# ⑥ 完全なrosterでは同クラス集合だけを返す ─────────────────────────────
def test_complete_roster_returns_same_class_only():
    car_class_map = {0: 10, 1: 20, 2: 10, 3: 20, 4: 10}
    r = cm.evaluate_class_map([0, 1, 2, 3, 4], player_car_idx=4, car_class_map=car_class_map)
    check('⑥完全roster: available', r['available'])
    check('⑥同クラス(class_id=10)の車のみ', r['same_class_car_idxs'] == {0, 2, 4}, r['same_class_car_idxs'])
    check('⑥他クラス(class_id=20)の車を含まない', 1 not in r['same_class_car_idxs'] and 3 not in r['same_class_car_idxs'])


# ⑦ 不完全時は推測せずNO_CLASS_MAP（境界：activeが空集合でも壊れない） ──────
def test_no_guess_on_incomplete():
    r = cm.evaluate_class_map([], player_car_idx=0, car_class_map={})
    check('⑦active車が0台・car_class_mapも空 → NO_CLASS_MAP(自車classID不明)',
          r['available'] is False and r['reason'] == cm.NO_CLASS_MAP, r)


def run_all():
    print('══ class_map.py 通常テスト ══')
    test_multiclass_duplicate_positions()
    test_unknown_car_name_same_class_id()
    test_roster_only_player_but_40_active()
    test_player_class_unknown()
    test_partial_missing_other_car()
    test_complete_roster_returns_same_class_only()
    test_no_guess_on_incomplete()
    print(f"\n[class_map] 合格 {pass_n} / 不合格 {fail_n}")
    return fail_n == 0


if __name__ == '__main__':
    ok = run_all()
    sys.exit(0 if ok else 1)
