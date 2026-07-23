"""
OMORAY PITWALL - judge_call LLM間引きゲートのテスト（2026-07-23 Codex設計）
  「発話予算」でなく「LLMを呼ぶ前」を間引く_judge_llm_gate()を、bridge.pyから直接importして
  検証する（別ロジックの再実装ではなく、poll_iracing()が呼ぶのと同じ関数）。
  _director_allows(kind, prio, now)と同じくnowを引数で受け取る設計＝時刻を差し替えてテスト可能。

実行: python3 irsdk-bridge/tests_judge_llm_gate.py
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bridge  # noqa: E402  ★本番モジュールを直接import（写経しない）

pass_n, fail_n = 0, 0


def check(name, cond, detail=''):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print('  ✅ ' + name)
    else:
        fail_n += 1
        print('  ❌ ' + name + ('  → ' + str(detail) if detail else ''))


def test_budget_caps_throttled_kinds():
    print('\n══ 間引き対象kind(battle等)は直近60秒でJUDGE_LLM_BUDGET_MAX回までしか通さない ══')
    call_times = []
    t0 = 1000.0
    allowed = [bridge._judge_llm_gate('battle', call_times, t0 + i) for i in range(bridge.JUDGE_LLM_BUDGET_MAX)]
    check(f'最初の{bridge.JUDGE_LLM_BUDGET_MAX}回は全部True', all(allowed), allowed)
    over = bridge._judge_llm_gate('battle', call_times, t0 + bridge.JUDGE_LLM_BUDGET_MAX)
    check(f'{bridge.JUDGE_LLM_BUDGET_MAX + 1}回目はFalse(LLMを呼ばない)', over is False)


def test_budget_shared_across_different_kinds():
    print('\n══ battle/catchup/defend等、間引き対象の異なるkindは同じ予算を共有する(パックレース対策) ══')
    call_times = []
    t0 = 2000.0
    kinds = ['battle', 'catchup', 'defend', 'time_loss', 'towing', 'battle']  # 6件 = ちょうど上限
    results = [bridge._judge_llm_gate(k, call_times, t0 + i * 0.1) for i, k in enumerate(kinds)]
    check('異なるkindでも合計で予算を消費する(全部True・ちょうど上限)', all(results), results)
    seventh = bridge._judge_llm_gate('defend', call_times, t0 + 0.6)
    check('7件目(別kind)は予算切れでFalse', seventh is False)


def test_window_expiry_resets_budget():
    print('\n══ JUDGE_LLM_BUDGET_WINDOW秒より古い呼び出しは予算から外れる(ウィンドウ経過で復活) ══')
    call_times = []
    t0 = 3000.0
    for i in range(bridge.JUDGE_LLM_BUDGET_MAX):
        bridge._judge_llm_gate('battle', call_times, t0 + i)
    blocked = bridge._judge_llm_gate('battle', call_times, t0 + 5)
    check('ウィンドウ内はまだFalse', blocked is False)
    # スライディングウィンドウなので、最初の1件(t0)だけがJUDGE_LLM_BUDGET_WINDOW超過で掃除される。
    #   残りの5件(t0+1〜t0+4)はまだウィンドウ内＝これがまさに「間引きされている」状態の継続を意味する。
    oldest_before = call_times[0]
    t_after_window = t0 + bridge.JUDGE_LLM_BUDGET_WINDOW + 1
    revived = bridge._judge_llm_gate('battle', call_times, t_after_window)
    check('最古の1件がウィンドウ超過で掃除された後は再びTrueに戻る', revived is True)
    check('掃除後、最古だった時刻はcall_timesに残っていない(肥大せず前へ進む)',
          oldest_before not in call_times, call_times)


def test_danger_never_throttled():
    print('\n══ danger(安全直結)は予算を使い切っていても常にTrue ══')
    call_times = []
    t0 = 4000.0
    for i in range(bridge.JUDGE_LLM_BUDGET_MAX + 10):  # 予算を大幅に使い切らせる(battle等で埋める想定)
        bridge._judge_llm_gate('battle', call_times, t0 + i * 0.01)
    danger_allowed = bridge._judge_llm_gate('danger', call_times, t0 + 100)
    check('予算切れ状態でもdangerは常にTrue', danger_allowed is True)
    check('dangerの呼び出しはcall_times(間引き対象の予算)を消費しない',
          len(call_times) == bridge.JUDGE_LLM_BUDGET_MAX, call_times)


def test_no_random_throttling():
    print('\n══ 予算内であれば毎回必ずTrue(ランダム間引きでないことの確認) ══')
    call_times = []
    t0 = 5000.0
    results = [bridge._judge_llm_gate('catchup', call_times, t0 + i * (bridge.JUDGE_LLM_BUDGET_WINDOW * 2))
               for i in range(20)]  # 毎回ウィンドウの外まで時間を進める＝常に空き予算
    check('予算に空きがあれば常にTrue(確率的な間引きではない)', all(results), results)


def run_all():
    print('══ judge_call LLM間引きゲートのテスト ══')
    test_budget_caps_throttled_kinds()
    test_budget_shared_across_different_kinds()
    test_window_expiry_resets_budget()
    test_danger_never_throttled()
    test_no_random_throttling()
    print(f"\n[judge llm gate] 合格 {pass_n} / 不合格 {fail_n}")
    return fail_n == 0


if __name__ == '__main__':
    ok = run_all()
    sys.exit(0 if ok else 1)
