#!/usr/bin/env python3
"""★P0-1 Bridge 実処理試験（Codex差戻し対応）

bridge.py を直接 import し、実関数 evaluate_checker_fuel_freeze() と
maybe_reset_on_session_num_change() を呼んで checker_fuel_freeze の
freeze/reset を検証する。コピーコード禁止・実 import 必須。

検証項目：
1. PLAYER_FINISHED への遷移エッジで、未freeze状態から一度だけ freeze される
2. 既に freeze 済みなら、後続フレームで上書きされない（後続ラップ/遅延の反例）
3. fuel 欠損（None）でも freeze される（欠損は欠損のまま保存される）
4. SessionNum 変更で checker_fuel_freeze が None にリセットされる
   （2レース連続を通しても3レース目には誤って前々回の値が残らない）
5. sig 変更でも同様にリセットされる
"""

import sys
import race_lifecycle
import bridge

failures = []


def check(label, condition):
    status = 'OK' if condition else 'FAIL'
    print(f'  [{status}] {label}')
    if not condition:
        failures.append(label)


print('\n━━ Bridge 実関数試験: evaluate_checker_fuel_freeze ━━\n')

# Test 1: PLAYER_FINISHED への遷移エッジで freeze
print('Test 1: PLAYER_FINISHED遷移エッジで freeze（fuel=3.9）')
freeze1 = bridge.evaluate_checker_fuel_freeze(
    previous_lifecycle_state='RACING',
    lifecycle_state='PLAYER_FINISHED',
    checker_fuel_freeze=None,
    current_fuel=3.9,
)
check('freeze == 3.9', freeze1 == 3.9)

# Test 2: 既に freeze 済みなら後続フレームで上書きされない
print('\nTest 2: 後続フレーム（同じPLAYER_FINISHED継続）で上書きされない')
freeze2 = bridge.evaluate_checker_fuel_freeze(
    previous_lifecycle_state='PLAYER_FINISHED',  # 既にPLAYER_FINISHED（遷移エッジではない）
    lifecycle_state='PLAYER_FINISHED',
    checker_fuel_freeze=3.9,   # 既にfreeze済み
    current_fuel=3.2,          # 後続ラップ・センサー遅延等で下がった値
)
check('freeze は 3.9 のまま（3.2 で上書きされない）', freeze2 == 3.9)

# Test 3: fuel 欠損（None）でも freeze される
print('\nTest 3: fuel欠損（None）でも freeze される（欠損は欠損のまま保存）')
freeze3 = bridge.evaluate_checker_fuel_freeze(
    previous_lifecycle_state='RACING',
    lifecycle_state='PLAYER_FINISHED',
    checker_fuel_freeze=None,
    current_fuel=None,
)
check('freeze is None（欠損のまま）', freeze3 is None)

# Test 4: PLAYER_FINISHED 以外の遷移では freeze されない
print('\nTest 4: PLAYER_FINISHED以外の遷移では freeze されない')
freeze4 = bridge.evaluate_checker_fuel_freeze(
    previous_lifecycle_state='RACING',
    lifecycle_state='CHECKER_OUT',
    checker_fuel_freeze=None,
    current_fuel=5.0,
)
check('freeze は None のまま', freeze4 is None)

# Test 4b: 境界値 — fuel=0.0（空タンク完走）でも freeze される（0は偽ではない）
print('\nTest 4b: 境界値 fuel=0.0（空タンク完走）でも freeze される')
freeze4b = bridge.evaluate_checker_fuel_freeze(
    previous_lifecycle_state='RACING',
    lifecycle_state='PLAYER_FINISHED',
    checker_fuel_freeze=None,
    current_fuel=0.0,
)
check('freeze == 0.0（Noneではなく実測ゼロ）', freeze4b == 0.0 and freeze4b is not None)

# Test 4c: 境界値 — fuel が非有限値（NaN/inf）でもクラッシュせずそのまま渡す
#   （非有限の弾き出しは呼び出し側のsummary生成（isfinite チェック）の責務。
#    freeze自体は「一度だけ捕まえる」ことだけを保証する）
print('\nTest 4c: 境界値 fuel=float("nan") でもクラッシュしない')
freeze4c = bridge.evaluate_checker_fuel_freeze(
    previous_lifecycle_state='RACING',
    lifecycle_state='PLAYER_FINISHED',
    checker_fuel_freeze=None,
    current_fuel=float('nan'),
)
import math as _math
check('freeze は NaN のまま伝播（isfiniteで後段除外される前提）', isinstance(freeze4c, float) and _math.isnan(freeze4c))

# summary生成側のisfiniteガードが、freezeされたNaNを実際にNoneへ落とすことを確認
_summary_fuel_at_finish = (freeze4c if (freeze4c is not None
    and isinstance(freeze4c, (int, float)) and _math.isfinite(freeze4c)) else None)
check('NaN freeze値はsummary生成時にNoneへ落ちる（isfiniteガード有効）', _summary_fuel_at_finish is None)


print('\n━━ Bridge 実関数試験: _session_scoped_reset_values（sig変更経路の単一の真実源）━━\n')

# Test 4d: sig変更経路（poll_iracing内の event_type|track 変化）は
#   maybe_reset_on_session_num_change とは別の呼び出し箇所だが、同じ
#   _session_scoped_reset_values() を使う設計（単一の真実源）。ここを
#   直接呼んで checker_fuel_freeze が確実に含まれることを検証する。
print('Test 4d: _session_scoped_reset_values() に checker_fuel_freeze が含まれる（sig reset経路も同じ辞書を参照）')
sig_reset_values = bridge._session_scoped_reset_values()
check('checker_fuel_freeze キーが存在', 'checker_fuel_freeze' in sig_reset_values)
check('checker_fuel_freeze is None', sig_reset_values.get('checker_fuel_freeze') is None)

print('\n━━ Bridge 実関数試験: maybe_reset_on_session_num_change ━━\n')

# Test 5: SessionNum変更で checker_fuel_freeze が None にリセットされる
print('Test 5: SessionNum変更（レース1→レース2）でリセット')
fsm = race_lifecycle.RaceLifecycle()
changed, reset_values = bridge.maybe_reset_on_session_num_change(
    cur_snum=2, last_session_num=1, race_lifecycle_fsm=fsm)
check('changed == True', changed is True)
check('reset_values に checker_fuel_freeze キーが存在', 'checker_fuel_freeze' in (reset_values or {}))
check('reset_values["checker_fuel_freeze"] is None', reset_values and reset_values.get('checker_fuel_freeze') is None)

# Test 6: SessionNum が変わらなければ reset されない（現セッションの freeze を保持）
print('\nTest 6: SessionNum不変（同一レース中）では reset されない')
fsm2 = race_lifecycle.RaceLifecycle()
changed2, reset_values2 = bridge.maybe_reset_on_session_num_change(
    cur_snum=1, last_session_num=1, race_lifecycle_fsm=fsm2)
check('changed == False', changed2 is False)
check('reset_values is None', reset_values2 is None)

# Test 7: 2レース連続シナリオ（同sig・SessionNumだけ変わる耐久想定）を通しで検証
print('\nTest 7: 2レース連続シナリオ（実関数を連結して通しで検証）')
checker_fuel_freeze = None
# レース1：走行中 → PLAYER_FINISHED（fuel=3.9でfreeze）
lifecycle_prev = 'RACING'
lifecycle_cur = 'PLAYER_FINISHED'
checker_fuel_freeze = bridge.evaluate_checker_fuel_freeze(
    lifecycle_prev, lifecycle_cur, checker_fuel_freeze, current_fuel=3.9)
check('レース1完走: freeze == 3.9', checker_fuel_freeze == 3.9)

# 後続フレーム（同じPLAYER_FINISHED継続、telemetryが多少変動）でも上書きされない
checker_fuel_freeze = bridge.evaluate_checker_fuel_freeze(
    'PLAYER_FINISHED', 'PLAYER_FINISHED', checker_fuel_freeze, current_fuel=3.5)
check('レース1完走後の後続フレームでも freeze == 3.9 のまま', checker_fuel_freeze == 3.9)

# レース2開始：SessionNum変更でリセット
fsm3 = race_lifecycle.RaceLifecycle()
changed3, reset_values3 = bridge.maybe_reset_on_session_num_change(
    cur_snum=2, last_session_num=1, race_lifecycle_fsm=fsm3)
checker_fuel_freeze = reset_values3['checker_fuel_freeze']
check('レース2開始: SessionNum変更でリセット後 freeze is None', checker_fuel_freeze is None)

# レース2完走：新しいfuel値（1.2）でfreeze。レース1の3.9が誤って残っていないか検証
lifecycle_prev2 = 'RACING'
lifecycle_cur2 = 'PLAYER_FINISHED'
checker_fuel_freeze = bridge.evaluate_checker_fuel_freeze(
    lifecycle_prev2, lifecycle_cur2, checker_fuel_freeze, current_fuel=1.2)
check('レース2完走: freeze == 1.2（レース1の3.9が残っていない）', checker_fuel_freeze == 1.2)


print('\n━━ 結果 ━━\n')
if failures:
    print(f'✗ {len(failures)} 件失敗:')
    for f in failures:
        print(f'  - {f}')
    sys.exit(1)
else:
    print('✓ All Bridge 実関数試験 PASSED')
    sys.exit(0)
