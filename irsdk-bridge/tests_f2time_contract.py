"""
OMORAY PITWALL - f2time_contract.py テスト（R3・2026-07-21 Codex指示）
実行: python3 irsdk-bridge/tests_f2time_contract.py
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import f2time_contract as fc  # noqa: E402

pass_n, fail_n = 0, 0


def check(name, cond, detail=''):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print('  ✅ ' + name)
    else:
        fail_n += 1
        print('  ❌ ' + name + ('  → ' + str(detail) if detail else ''))


GOOD = dict(lap=10, lap_dist_pct=0.42, on_pit_road=False, track_surface=3,
            class_map_available=True, is_same_class=True)


# ① -1はinvalid ──────────────────────────────────────────────────
def test_negative_one_invalid():
    r = fc.evaluate_f2time_input(f2time=-1.0, session_time=100.0, last_update_session_time=99.0,
                                  max_age_sec=120.0, **GOOD)
    check('①F2Time=-1はinvalid_value', r['valid'] is False and r['reason'] == fc.REASON_INVALID_VALUE, r)


# ② 0は単独では無効扱いにしないが、他フィールド欠損なら別理由で無効 ─────────
def test_zero_not_auto_invalid():
    r = fc.evaluate_f2time_input(f2time=0.0, session_time=100.0, last_update_session_time=99.0,
                                  max_age_sec=120.0, **GOOD)
    check('②F2Time=0はそれ単独ではinvalid_valueにならない(他が揃っていればvalid)', r['valid'] is True, r)


# ③ 必須フィールド欠損はmissing_field ─────────────────────────────────
def test_missing_field():
    base = dict(GOOD)
    base['lap'] = None
    r = fc.evaluate_f2time_input(f2time=50.0, session_time=100.0, last_update_session_time=99.0,
                                  max_age_sec=120.0, **base)
    check('③Lap欠損はmissing_field', r['valid'] is False and r['reason'] == fc.REASON_MISSING_FIELD, r)

    for field in ('lap_dist_pct', 'on_pit_road', 'track_surface'):
        base2 = dict(GOOD)
        base2[field] = None
        r2 = fc.evaluate_f2time_input(f2time=50.0, session_time=100.0, last_update_session_time=99.0,
                                       max_age_sec=120.0, **base2)
        check(f'③{field}欠損もmissing_field', r2['valid'] is False and r2['reason'] == fc.REASON_MISSING_FIELD, r2)


# ④ stale判定：校正済み閾値を超えた更新はstale ────────────────────────
def test_stale():
    # 実測(strategy_ts CSV)ではF2Timeは約2分に1回更新。120秒を仮の校正値として使う。
    r = fc.evaluate_f2time_input(f2time=50.0, session_time=300.0, last_update_session_time=100.0,
                                  max_age_sec=120.0, **GOOD)
    check('④更新から200秒経過(閾値120秒超)はstale', r['valid'] is False and r['reason'] == fc.REASON_STALE, r)
    check('④staleでもageSecは返す', r['ageSec'] == 200.0, r['ageSec'])

    r2 = fc.evaluate_f2time_input(f2time=50.0, session_time=150.0, last_update_session_time=100.0,
                                   max_age_sec=120.0, **GOOD)
    check('④更新から50秒(閾値内)ならvalid', r2['valid'] is True, r2)


# ④' 2026-07-21 Codex再指摘：閾値が未注入(uncalibrated)なら無効・固定デフォルトを使わない ──
def test_uncalibrated_threshold():
    # 更新1秒後という「本来ならstaleでないはず」の状況でも、max_age_secを渡さなければ無効。
    r = fc.evaluate_f2time_input(f2time=50.0, session_time=101.0, last_update_session_time=100.0, **GOOD)
    check('④\'max_age_sec未指定はuncalibrated(勝手に有効判定しない)',
          r['valid'] is False and r['reason'] == fc.REASON_UNCALIBRATED, r)
    check('④\'uncalibratedでもageSecは計算できていれば返す', r['ageSec'] == 1.0, r['ageSec'])
    # 固定の"5秒"のような暗黙デフォルトが復活していないことも確認（更新0.1秒後でもuncalibrated）
    r2 = fc.evaluate_f2time_input(f2time=50.0, session_time=100.1, last_update_session_time=100.0, **GOOD)
    check('④\'極めて新しい更新でもmax_age_sec未指定ならuncalibrated',
          r2['valid'] is False and r2['reason'] == fc.REASON_UNCALIBRATED, r2)


# ⑤ 同クラスmapが無効ならno_class_map ─────────────────────────────────
def test_no_class_map():
    base = dict(GOOD)
    base['class_map_available'] = False
    r = fc.evaluate_f2time_input(f2time=50.0, session_time=100.0, last_update_session_time=99.0,
                                  max_age_sec=120.0, **base)
    check('⑤class_map_available=Falseはno_class_map', r['valid'] is False and r['reason'] == fc.REASON_NO_CLASS_MAP, r)


# ⑥ 同クラスmapは有効だが対象車が別クラスならnot_same_class ────────────────
def test_not_same_class():
    base = dict(GOOD)
    base['is_same_class'] = False
    r = fc.evaluate_f2time_input(f2time=50.0, session_time=100.0, last_update_session_time=99.0,
                                  max_age_sec=120.0, **base)
    check('⑥別クラスはnot_same_class', r['valid'] is False and r['reason'] == fc.REASON_NOT_SAME_CLASS, r)


# ⑦ sourceFieldsが常に返る ────────────────────────────────────────
def test_source_fields_always_present():
    r = fc.evaluate_f2time_input(f2time=-1.0, session_time=None, last_update_session_time=None,
                                  max_age_sec=120.0, **GOOD)
    check('⑦invalid時もsourceFieldsを返す', 'sourceFields' in r and r['sourceFields']['f2time'] == -1.0, r)


# ⑧ F2TimeFreshnessTracker：値が変わった時だけ更新時刻が進む ────────────────
def test_freshness_tracker():
    t = fc.F2TimeFreshnessTracker()
    check('⑧初回observeはNoneでなく現在時刻を返す', t.observe(0, 50.0, 10.0) == 10.0)
    check('⑧同じ値のままなら更新時刻は進まない', t.observe(0, 50.0, 20.0) == 10.0)
    check('⑧値が変われば更新時刻も進む', t.observe(0, 55.0, 25.0) == 25.0)
    t.reset()
    check('⑧reset後は再びNoneから', t.observe(0, 55.0, 30.0) == 30.0)


def run_all():
    print('══ f2time_contract.py 通常テスト ══')
    test_negative_one_invalid()
    test_zero_not_auto_invalid()
    test_missing_field()
    test_stale()
    test_uncalibrated_threshold()
    test_no_class_map()
    test_not_same_class()
    test_source_fields_always_present()
    test_freshness_tracker()
    print(f"\n[f2time_contract] 合格 {pass_n} / 不合格 {fail_n}")
    return fail_n == 0


if __name__ == '__main__':
    ok = run_all()
    sys.exit(0 if ok else 1)
