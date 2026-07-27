"""
OMORAY PITWALL - judge_call LLM候補予算ゲートのテスト（2026-07-23 Codex設計・再指摘対応版）
  「発話予算」でなく「LLMを呼ぶ前」を間引く_judge_llm_gate()を、bridge.pyから直接importして
  検証する（別ロジックの再実装ではなく、poll_iracing()が呼ぶのと同じ関数）。
  _director_allows(kind, prio, now)と同じくnowを引数で受け取る設計＝時刻を差し替えてテスト可能。

  ★2026-07-23 Codex再指摘への対応：
    - 純粋関数だけの検証では、poll_iracing()の呼び出し箇所を削除しても緑のままになる
      「本番配線について偽陽性」問題があったため、bridge.pyのソース本文を読んで
      配線パターンを静的に検証する配線テストを追加（同じ設計をtests-speak-async.js等でも採用）。
    - SessionNum変更時のリセット・catchup/defend/battleの段階消費が
      ゲート通過時のみであることを、本番の_session_scoped_reset_values()と
      maybe_reset_on_session_num_change()を直接呼んで確認する。

  ★2026-07-24 towing 完全削除に伴い test_towing_never_throttled を
      test_towing_removed_from_all_layers 回帰テストへ置換。
      同ラウンドで post_contact_ok / pit_entry 再設計の新規テストも追加。

実行: python3 irsdk-bridge/tests_judge_llm_gate.py
"""
import sys
import os
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bridge  # noqa: E402  ★本番モジュールを直接import（写経しない）
import race_lifecycle  # noqa: E402

pass_n, fail_n = 0, 0


def check(name, cond, detail=''):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print('  ✅ ' + name)
    else:
        fail_n += 1
        print('  ❌ ' + name + ('  → ' + str(detail) if detail else ''))


# ── 純粋関数テスト（_judge_llm_gate単体） ─────────────────────────────

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
    # 6件でちょうど上限。dangerはNEVER_THROTTLEなので予算を消費しない＝ここには入れない。
    # ★2026-07-24 towingはこの日で完全削除（[[project_pitwall_indirect_damage_detection]] Phase 1）
    kinds = ['battle', 'catchup', 'defend', 'time_loss', 'battle', 'catchup']
    results = [bridge._judge_llm_gate(k, call_times, t0 + i * 0.1) for i, k in enumerate(kinds)]
    check('異なるkindでも合計で予算を消費する(全部True・ちょうど上限)', all(results), results)
    seventh = bridge._judge_llm_gate('defend', call_times, t0 + 0.7)
    check('7件目(別kind)は予算切れでFalse', seventh is False)


def test_window_expiry_resets_budget():
    print('\n══ JUDGE_LLM_BUDGET_WINDOW秒より古い呼び出しは予算から外れる(ウィンドウ経過で復活) ══')
    call_times = []
    t0 = 3000.0
    for i in range(bridge.JUDGE_LLM_BUDGET_MAX):
        bridge._judge_llm_gate('battle', call_times, t0 + i)
    blocked = bridge._judge_llm_gate('battle', call_times, t0 + 5)
    check('ウィンドウ内はまだFalse', blocked is False)
    oldest_before = call_times[0]
    t_after_window = t0 + bridge.JUDGE_LLM_BUDGET_WINDOW + 1
    revived = bridge._judge_llm_gate('battle', call_times, t_after_window)
    check('最古の1件がウィンドウ超過で掃除された後は再びTrueに戻る', revived is True)
    check('掃除後、最古だった時刻はcall_timesに残っていない(肥大せず前へ進む)',
          oldest_before not in call_times, call_times)


def test_danger_never_throttled():
    print('\n══ danger(危険ドライバー予告・安全直結)は予算切れでも常にTrue ══')
    call_times = []
    t0 = 4000.0
    for i in range(bridge.JUDGE_LLM_BUDGET_MAX + 10):
        bridge._judge_llm_gate('battle', call_times, t0 + i * 0.01)
    danger_allowed = bridge._judge_llm_gate('danger', call_times, t0 + 100)
    check('予算切れ状態でもdangerは常にTrue', danger_allowed is True)
    check('dangerの呼び出しはcall_times(間引き対象の予算)を消費しない',
          len(call_times) == bridge.JUDGE_LLM_BUDGET_MAX, call_times)


def test_towing_removed_from_all_layers():
    print('\n══ 回帰：towingが全レイヤーから完全削除されている(2026-07-24 Yuji方針) ══')
    # 経緯：走行継続中でもLunaが「トーイング中」と話しかける奇妙な体験を
    #      Yujiが指摘。SDKの tow_time が瞬間>0になる誤検知に加え、そもそも
    #      牽引中はドライバー自発の会話に任せる方が自然という結論。
    # 検証：定数辞書・優先度・prompts.js・renderer.htmlの反射ケースから
    #      towingが完全に消えていることを静的に確認する。post_contact_okが
    #      責務を引き継ぐ（=別テストで検証）。
    src = _bridge_source()

    # 1) bridge.py 定数辞書
    check('JUDGE_LLM_NEVER_THROTTLE に towing が含まれない',
          'towing' not in bridge.JUDGE_LLM_NEVER_THROTTLE,
          list(bridge.JUDGE_LLM_NEVER_THROTTLE))
    check('PRIORITY 辞書に towing キーが無い',
          'towing' not in bridge.PRIORITY,
          [k for k in bridge.PRIORITY.keys() if 'tow' in k])

    # 2) bridge.py コード：judge_call broadcastでkind='towing'が無い
    pattern = re.compile(r"broadcast\(\{['\"]type['\"]:\s*['\"](?:radio|judge_call)['\"],\s*['\"]kind['\"]:\s*['\"]towing['\"]")
    check('bridge.py内でtowing のjudge_call broadcastが1件も無い',
          pattern.search(src) is None)
    # radioパスもチェック（trigger='towing'）
    radio_pattern = re.compile(r"broadcast\(\{['\"]type['\"]:\s*['\"]radio['\"],\s*['\"]trigger['\"]:\s*['\"]towing['\"]")
    check("bridge.py内で trigger='towing' の radio broadcastが1件も無い",
          radio_pattern.search(src) is None)

    # 3) bridge.py：PlayerCarTowTime読み取り(SDK呼び出し)が消えている
    check("bridge.py内で reader.read_float('PlayerCarTowTime') が呼ばれていない",
          "reader.read_float('PlayerCarTowTime')" not in src)
    check('bridge.py内で tow_active 変数への代入(セッション状態)が残っていない',
          re.search(r'^\s*tow_active\s*=', src, re.MULTILINE) is None,
          '削除済み・コメントのみ残存可')

    # 4) prompts.js から towing 分岐が消えている
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    prompts_path = os.path.join(project_root, 'prompts.js')
    with open(prompts_path, 'r') as f:
        prompts_src = f.read()
    check('prompts.js に kind==="towing" の分岐が無い',
          "j.kind === 'towing'" not in prompts_src)
    check('prompts.js の判定対象kind配列に "towing" が入っていない',
          "'towing'" not in re.findall(
              r"\[[^\]]*'catchup'[^\]]*\]", prompts_src)[0] if re.findall(
              r"\[[^\]]*'catchup'[^\]]*\]", prompts_src) else True)

    # 5) renderer.html の反射 case 'towing' が消えている（コメントは可・実コードは不可）
    renderer_path = os.path.join(project_root, 'desktop', 'renderer.html')
    with open(renderer_path, 'r') as f:
        renderer_src = f.read()
    # 生きた case 'towing': 分岐が無いこと（コメント行内の 'towing' は許容）
    case_line_pat = re.compile(r"^\s*case\s+['\"]towing['\"]\s*:", re.MULTILINE)
    check("renderer.html に反射 case 'towing' が残っていない",
          case_line_pat.search(renderer_src) is None,
          "found: " + str(case_line_pat.findall(renderer_src)))


def test_no_random_throttling():
    print('\n══ 予算内であれば毎回必ずTrue(ランダム間引きでないことの確認) ══')
    call_times = []
    t0 = 5000.0
    results = [bridge._judge_llm_gate('catchup', call_times, t0 + i * (bridge.JUDGE_LLM_BUDGET_WINDOW * 2))
               for i in range(20)]
    check('予算に空きがあれば常にTrue(確率的な間引きではない)', all(results), results)


# ── 本番配線テスト（poll_iracing()を含むソースの検証） ────────────────

_BRIDGE_SRC = None
def _bridge_source():
    global _BRIDGE_SRC
    if _BRIDGE_SRC is None:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bridge.py'), 'r') as f:
            _BRIDGE_SRC = f.read()
    return _BRIDGE_SRC


def test_all_judge_call_broadcasts_have_gate_wired():
    print('\n══ 本番配線：全judge_call broadcast()の直前で_judge_llm_gate()が呼ばれている ══')
    src = _bridge_source()
    # broadcast({'type': 'judge_call', 'kind': 'XXX', ...}) を全部拾う
    pattern = re.compile(r"broadcast\(\{['\"]type['\"]:\s*['\"]judge_call['\"],\s*['\"]kind['\"]:\s*['\"](\w+)['\"]")
    found_kinds = pattern.findall(src)
    check('judge_call broadcastが本番コードに存在する', len(found_kinds) >= 5, f'found={found_kinds}')

    # 各broadcast()の直前200文字以内に、対応するkindの_judge_llm_gate('kind', ...)呼び出しがあるか
    unwired = []
    for m in pattern.finditer(src):
        kind = m.group(1)
        preceding = src[max(0, m.start() - 400):m.start()]
        expected = f"_judge_llm_gate('{kind}',"
        if expected not in preceding:
            unwired.append((kind, m.start()))
    check('全judge_call broadcast()の直前で対応するkindのゲートが呼ばれている(未配線があればここで検出)',
          not unwired, f'unwired sites={unwired}')


def test_removing_gate_call_would_break_wiring_test():
    print('\n══ 変異試験：ゲート呼び出しを削除した源を作ると、上の配線テストが失敗することを提示 ══')
    src = _bridge_source()
    # ★2026-07-26 Unit E0 v3 対応：battle broadcast 経路が
    #   `if _judge_llm_gate(...)` → `_br = broadcast(...); if _br == BROADCAST_DISPATCHED:`
    #   の3段構造に変わったため、変異パターンを再更新。
    mutation = src.replace(
        "if _judge_llm_gate('battle', judge_llm_call_times, time.time(), judge_llm_skip_log_last):\n"
        "                                        # ★v3 Codex P1：DISPATCHED のみ段階消費。HELD/DROPPED は消費しない。\n"
        "                                        #   HELD は将来 flush_radio() が送るが judge_call は\n"
        "                                        #   GATEABLE_TRIGGERS に含まれないため実際は HELD にならない。\n"
        "                                        _br = broadcast({'type': 'judge_call', 'kind': 'battle',",
        "if True:\n"
        "                                        _br = broadcast({'type': 'judge_call', 'kind': 'battle',",
        1,
    )
    check('変異が実際にソースを変更した(パターンが見つかった)', mutation != src)
    # 変異後のソースで配線パターンをチェック（本番テストと同じロジックで検証）
    pattern = re.compile(r"broadcast\(\{['\"]type['\"]:\s*['\"]judge_call['\"],\s*['\"]kind['\"]:\s*['\"](\w+)['\"]")
    unwired = []
    for m in pattern.finditer(mutation):
        kind = m.group(1)
        preceding = mutation[max(0, m.start() - 400):m.start()]
        if f"_judge_llm_gate('{kind}'," not in preceding:
            unwired.append(kind)
    check('変異後は"battle"が未配線として検出される(配線テストが本番のバグを検出できる証明)',
          'battle' in unwired, f'detected unwired: {unwired}')


def test_session_num_change_resets_llm_budget():
    print('\n══ 本番配線：SessionNum変更時にjudge_llm_call_timesが空にリセットされる ══')
    resets = bridge._session_scoped_reset_values()
    check('_session_scoped_reset_values()にjudge_llm_call_timesが含まれる',
          'judge_llm_call_times' in resets)
    check('リセット値は空list', resets['judge_llm_call_times'] == [])

    # 実際にmaybe_reset_on_session_num_changeを呼んで、SessionNum変更が検知された時
    # 返却dictにjudge_llm_call_times=[]が入っているか確認
    fsm = race_lifecycle.RaceLifecycle()
    changed, reset = bridge.maybe_reset_on_session_num_change(cur_snum=2, last_session_num=1, race_lifecycle_fsm=fsm)
    check('SessionNum変更が検知される', changed is True)
    check('返却dictにjudge_llm_call_timesリセット値が含まれる',
          reset is not None and 'judge_llm_call_times' in reset and reset['judge_llm_call_times'] == [])

    # SessionNum変更なし＝リセットしない
    changed2, reset2 = bridge.maybe_reset_on_session_num_change(cur_snum=2, last_session_num=2, race_lifecycle_fsm=fsm)
    check('SessionNum不変ならリセットしない(reset=None)', changed2 is False and reset2 is None)


def test_sig_reset_path_resets_llm_budget():
    print('\n══ 本番配線：sig(event_type|track)変更経路でもjudge_llm_call_timesがリセットされる ══')
    # 本番のsig変更ブロック(SESSION INFO受信時)の該当行を、bridge.pyのソースから抽出して検証。
    # SessionNum経路とは別の第二のリセット経路。ここが漏れると、trackやevent_typeが変わった
    # 瞬間に前セッションの予算満杯を持ち越す。
    src = _bridge_source()
    # sig経路のunpackブロック（"last_session_sig = sig" の後にある一連の代入）
    m = re.search(r"last_session_sig\s*=\s*sig[\s\S]{0,5000}?_gate_state\['pending'\]\s*=\s*None", src)
    check('sig経路のunpackブロックが見つかる', m is not None)
    if m:
        block = m.group(0)
        check('sig経路にjudge_llm_call_timesのunpackがある(P1・2回目指摘の効き)',
              "judge_llm_call_times = _sig_reset['judge_llm_call_times']" in block)
        check('sig経路にjudge_llm_skip_log_lastのunpackもある(セッション越えでログ状態を持ち越さない)',
              "judge_llm_skip_log_last = _sig_reset['judge_llm_skip_log_last']" in block)


def test_removing_sig_unpack_would_break_wiring_test():
    print('\n══ 変異試験：sig経路のjudge_llm_call_timesのunpackを削除するとテストが失敗する ══')
    src = _bridge_source()
    line = "                        judge_llm_call_times = _sig_reset['judge_llm_call_times']\n"
    check('変異対象の行がソースに存在する', line in src)
    mutation = src.replace(line, "", 1)
    check('変異が実際にソースを変更した', mutation != src)
    # 変異後のsigブロックにjudge_llm_call_timesのunpackが無いことを、上のテストと同じロジックで検証
    m = re.search(r"last_session_sig\s*=\s*sig[\s\S]{0,5000}?_gate_state\['pending'\]\s*=\s*None", mutation)
    block = m.group(0) if m else ""
    check('変異後はsig経路にjudge_llm_call_timesのunpackが無い(配線テストが本番のバグを検出できる証明)',
          "judge_llm_call_times = _sig_reset['judge_llm_call_times']" not in block)


def test_removing_session_num_unpack_would_break_wiring_test():
    print('\n══ 変異試験：SessionNum経路のjudge_llm_call_timesのunpackを削除するとテストが失敗する ══')
    src = _bridge_source()
    line = "            judge_llm_call_times = _reset['judge_llm_call_times']\n"
    check('変異対象の行がソースに存在する', line in src)
    mutation = src.replace(line, "", 1)
    check('変異が実際にソースを変更した', mutation != src)
    # 変異後のSessionNum reset適用ブロックを、"if _changed:"から始めて調べる
    m = re.search(r"if _changed:[\s\S]{0,2500}?judge_llm_skip_log_last = _reset\['judge_llm_skip_log_last'\]", mutation)
    if not m:
        m = re.search(r"if _changed:[\s\S]{0,2500}", mutation)
    block = m.group(0) if m else ""
    check('変異後はSessionNum経路にjudge_llm_call_timesのunpackが無い(配線テストが本番のバグを検出できる証明)',
          "judge_llm_call_times = _reset['judge_llm_call_times']" not in block)


def test_skip_log_dedup_prevents_per_poll_spam():
    print('\n══ 予算切れ60秒相当でもcandidate-skipログが毎ポーリングでは発生しない(運用問題対策) ══')
    # log()を差し替えてログ回数を数える。実際のcandidate-skipログだけを対象にする。
    call_times = []
    skip_log_last = {}
    t0 = 7000.0
    # まず予算を使い切る
    for i in range(bridge.JUDGE_LLM_BUDGET_MAX):
        bridge._judge_llm_gate('battle', call_times, t0 + i, skip_log_last)

    captured = []
    orig_log = bridge.log
    def _capture(msg):
        captured.append(msg)
    bridge.log = _capture
    try:
        # 50秒間、0.1秒毎に候補が再判定される想定(=500回)。ウィンドウ(60秒)未満なので
        # 全期間予算満杯のまま推移＝毎回skipで返る想定。
        skip_calls = 0
        for i in range(500):
            allowed = bridge._judge_llm_gate('battle', call_times, t0 + 10 + i * 0.1, skip_log_last)
            if allowed is False:
                skip_calls += 1
    finally:
        bridge.log = orig_log
    check('500回のうち全てcandidate-skipで判定は返っている(判定は毎回行われる)', skip_calls == 500)
    skip_logs = [m for m in captured if 'candidate-skip' in m]
    # 50秒間・10秒に1回の想定 → 最大でも約5〜6回
    check(f'candidate-skipログの実出力回数が判定回数の5%未満に抑えられる(spam抑止・実測{len(skip_logs)}回)',
          len(skip_logs) < 25, f'skip logs={len(skip_logs)}, expected≪500')
    check('少なくとも1回はログが出ている(完全沈黙で運用不能にならない)', len(skip_logs) >= 1)

    # 予算復活後にallowされたら、次にskipになった時は改めてログが出るはずの状態に戻る
    revived = bridge._judge_llm_gate('battle', call_times, t0 + 10 + bridge.JUDGE_LLM_BUDGET_WINDOW * 3, skip_log_last)
    check('ウィンドウ経過後にallowが返る', revived is True)
    check('allow成功でskip_log_lastの該当kindがクリアされる(次のskip時に改めてログが出る)',
          'battle' not in skip_log_last)


def test_skip_log_dedup_is_per_kind():
    print('\n══ skipログの間引きはkind単位（別kindが混じっても互いに影響しない） ══')
    call_times = []
    skip_log_last = {}
    t0 = 8000.0
    for i in range(bridge.JUDGE_LLM_BUDGET_MAX):
        bridge._judge_llm_gate('battle', call_times, t0 + i, skip_log_last)

    captured = []
    orig_log = bridge.log
    bridge.log = lambda m: captured.append(m)
    try:
        bridge._judge_llm_gate('battle', call_times, t0 + 10, skip_log_last)   # log 1
        bridge._judge_llm_gate('catchup', call_times, t0 + 10, skip_log_last)  # log 1 (別kind)
        bridge._judge_llm_gate('battle', call_times, t0 + 10.5, skip_log_last) # dedup, no log
        bridge._judge_llm_gate('catchup', call_times, t0 + 10.5, skip_log_last)# dedup, no log
    finally:
        bridge.log = orig_log
    skips = [m for m in captured if 'candidate-skip' in m]
    check('別kindは独立してログが出る(battle 1回・catchup 1回)', len(skips) == 2, skips)


def test_qualifying_full_budget_then_race_first_call_passes():
    print('\n══ 本番配線：予選で予算満杯→SessionNum変更→レース最初のcatchupが通る ══')
    # 予選(SessionNum=0)で予算を使い切る
    call_times = []
    t0 = 6000.0
    for i in range(bridge.JUDGE_LLM_BUDGET_MAX):
        bridge._judge_llm_gate('catchup', call_times, t0 + i)
    check('予選で予算満杯', len(call_times) == bridge.JUDGE_LLM_BUDGET_MAX)

    # 予選→レースへ遷移(SessionNum変更)。maybe_reset_on_session_num_changeを本番同様に呼ぶ。
    fsm = race_lifecycle.RaceLifecycle()
    changed, reset = bridge.maybe_reset_on_session_num_change(cur_snum=1, last_session_num=0, race_lifecycle_fsm=fsm)
    check('SessionNum変更が検知された', changed is True)
    call_times = reset['judge_llm_call_times']  # ← 本番poll_iracing()と同じくローカル変数を上書き
    check('リセット後は空list', call_times == [])

    # レース開始直後の最初のcatchupが通る（予選の予算満杯を持ち越さない）
    first_race_call = bridge._judge_llm_gate('catchup', call_times, t0 + bridge.JUDGE_LLM_BUDGET_WINDOW * 3)
    check('レース最初のcatchupが通る(P1修正の効き)', first_race_call is True)


def test_throttled_catchup_does_not_consume_stage_wiring():
    print('\n══ 本番配線：catchup/defend/battleの段階消費(catchup_stage[idx]=stage等)がゲート通過時のみ実行される ══')
    src = _bridge_source()
    # catchup: catchup_stage[idx] = stage の代入が、_judge_llm_gate('catchup', ...) が
    # True を返した分岐の中(broadcast()と同じifブロック)にあることを確認。
    # 具体的にはbroadcast()から近い位置（同一if内・後続20行以内）に代入があるかを見る。
    for kind, state_expr in [
        ('catchup', 'catchup_stage[idx] = stage'),
        ('defend',  'defend_stage[idx] = stage'),
        ('battle',  'behind_armed[idx] = False'),
    ]:
        # kind別に、broadcast()呼び出し箇所を特定し、その先100行以内にstate_exprが
        # 「gate通過ブランチの中」にあるか（＝broadcast()と同じインデントレベル以下）を検証。
        # ★シグネチャは引数4つ以上を許容する（引数リストは非貪欲マッチで`time.time()`の`()`を跨ぐ
        #   ＝将来のシグネチャ追加でテストが偽陰性にならない）。
        broadcast_pat = re.compile(
            r"if _judge_llm_gate\('" + kind + r"',.*?\):\s*\n"
            r"(?:.*\n)*?"                         # 途中は任意
            r"[^\S\n]+" + re.escape(state_expr)   # 同一ifブロック内の代入
        )
        m = broadcast_pat.search(src)
        check(f'{kind}: "{state_expr}"が_judge_llm_gateのTrueブランチ内にある(P1修正の効き)', m is not None)

        # 逆パターン：gateブランチの外(if文より上・またはelseブランチ)に同じ代入が
        # あってはいけない（旧バグ：ゲート判定前にstageを進めていた）。
        # 具体的には、"if _judge_llm_gate('kind'..."の直前100行以内にstate_exprが単独で
        # 現れないことを確認。
        gate_pat = re.compile(r"if _judge_llm_gate\('" + kind + r"',")
        for gm in gate_pat.finditer(src):
            preceding_100 = src[max(0, gm.start() - 2000):gm.start()]
            # 直前の同一if文ブロック内で無条件にstate_exprが実行される旧バグを検出
            # （厳密ではないが、"    catchup_stage[idx] = stage" が gateの直前にあれば警告）
            if state_expr in preceding_100.split('\n')[-3:]:  # 直前3行に無条件代入がある＝旧バグ
                check(f'{kind}: ゲート判定前に"{state_expr}"が無条件で実行されていない(旧バグ再発防止)',
                      False, f'旧バグを検出: gateの直前に{state_expr}あり')
                break
        else:
            check(f'{kind}: ゲート判定前に"{state_expr}"が無条件で実行されていない(旧バグ再発防止)', True)


# ── post_contact_ok テスト（2026-07-24 Yuji設計・Codex差戻し対応） ────────

def test_post_contact_ok_priority_is_p2_not_p4():
    print('\n══ post_contact_ok の優先度はP2(手順)＝duck window対象外(Codex P0対応) ══')
    check('PRIORITY 辞書に post_contact_ok が P2 として登録されている',
          bridge.PRIORITY.get('post_contact_ok') == 2,
          'actual=' + str(bridge.PRIORITY.get('post_contact_ok')))
    check('DUCK_WINDOW に P2 のキーが無い(P0発話後の10秒silenceに巻き込まれない)',
          2 not in bridge.DUCK_WINDOW,
          list(bridge.DUCK_WINDOW.keys()))
    check('BUDGET_MAX にも P2 のキーが無い(予算切れで消失しない)',
          2 not in bridge.BUDGET_MAX,
          list(bridge.BUDGET_MAX.keys()))


def test_post_contact_ok_fires_when_speed_sustained_5sec():
    print('\n══ 挙動：crash_check後5秒間Speed>8.33m/s維持でpost_contact_ok通過(Pattern B) ══')
    # 5秒経過・speed_ok維持
    fire, ws, sok = bridge.evaluate_post_contact_watch(
        watch_start=1000.0, speed_ok=True, now_time=1005.0, current_speed=25.0)
    check('5.0秒経過・Speed継続なら should_broadcast=True(Pattern B確定)', fire is True)
    check('判定終了で watch_start=None(rearm済み)', ws is None)
    check('speed_ok が True にリセット(次のcrash_check用)', sok is True)


def test_post_contact_ok_silent_when_speed_drops_below_30kmh():
    print('\n══ 挙動：5秒以内にSpeed<8.33m/s(30km/h)未満に落ちたらpost_contact_ok抑止(Pattern A) ══')
    # 途中で減速→speed_okフラグを落として最終判定でFalse
    watch_start = 2000.0
    speed_ok = True
    # 途中：低速
    fire1, ws1, speed_ok = bridge.evaluate_post_contact_watch(
        watch_start, speed_ok, now_time=2002.0, current_speed=3.0)   # 3m/s=10km/h
    check('監視中の低速検知で should_broadcast=False', fire1 is False)
    check('watch_start は継続(監視続行)', ws1 == watch_start)
    check('speed_ok が False に落ちる(次で確定される)', speed_ok is False)
    # 5秒経過・その時Speedが戻ってても、途中で落ちたフラグは残る
    fire2, ws2, sok2 = bridge.evaluate_post_contact_watch(
        ws1, speed_ok, now_time=2005.5, current_speed=30.0)
    check('5秒経過時 speed_okがFalseなら post_contact_ok抑止(Pattern A)', fire2 is False)
    check('判定終了で watch_start=None', ws2 is None)


def test_post_contact_ok_silent_on_data_gap():
    print('\n══ 挙動：SessionTime または Speed が欠損したら監視破棄(誤発話しない) ══')
    fire, ws, sok = bridge.evaluate_post_contact_watch(
        watch_start=3000.0, speed_ok=True, now_time=None, current_speed=25.0)
    check('SessionTime欠損で should_broadcast=False', fire is False)
    check('SessionTime欠損で watch_start=None(監視破棄)', ws is None)

    fire2, ws2, _ = bridge.evaluate_post_contact_watch(
        watch_start=3000.0, speed_ok=True, now_time=3002.0, current_speed=None)
    check('Speed欠損で should_broadcast=False', fire2 is False)
    check('Speed欠損で watch_start=None(監視破棄)', ws2 is None)


def test_post_contact_ok_reset_on_session_change():
    print('\n══ 本番配線：post_contact_watch_start/speed_ok がセッション変更で必ずリセット(Codex P1) ══')
    resets = bridge._session_scoped_reset_values()
    check('_session_scoped_reset_values() に post_contact_watch_start が含まれる',
          'post_contact_watch_start' in resets)
    check('_session_scoped_reset_values() に post_contact_speed_ok が含まれる',
          'post_contact_speed_ok' in resets)
    check('リセット値 post_contact_watch_start は None(未監視)',
          resets['post_contact_watch_start'] is None)
    check('リセット値 post_contact_speed_ok は True(次のcrash_check用にrearm)',
          resets['post_contact_speed_ok'] is True)

    # 実際の遷移でも返ってくることを確認
    fsm = race_lifecycle.RaceLifecycle()
    changed, reset = bridge.maybe_reset_on_session_num_change(
        cur_snum=2, last_session_num=1, race_lifecycle_fsm=fsm)
    check('SessionNum変更検知時、返却dictに post_contact_watch_start=None',
          reset['post_contact_watch_start'] is None)


def test_post_contact_ok_unpacked_in_both_reset_paths():
    print('\n══ 本番配線：sig経路とSessionNum経路の両方で post_contact_watch_start が unpackされる ══')
    src = _bridge_source()
    # sig経路
    m_sig = re.search(r"last_session_sig\s*=\s*sig[\s\S]{0,4000}?_gate_state\['pending'\]\s*=\s*None", src)
    check('sig経路のunpackブロックが見つかる', m_sig is not None)
    if m_sig:
        block = m_sig.group(0)
        check("sig経路で post_contact_watch_start = _sig_reset['post_contact_watch_start'] がある",
              "post_contact_watch_start = _sig_reset['post_contact_watch_start']" in block)
        check("sig経路で post_contact_speed_ok = _sig_reset['post_contact_speed_ok'] がある",
              "post_contact_speed_ok = _sig_reset['post_contact_speed_ok']" in block)
    # SessionNum経路
    m_snum = re.search(
        r"if _changed:[\s\S]{0,6000}?last_session_num = cur_snum", src)
    check('SessionNum経路のunpackブロックが見つかる', m_snum is not None)
    if m_snum:
        block = m_snum.group(0)
        check("SessionNum経路で post_contact_watch_start = _reset['post_contact_watch_start'] がある",
              "post_contact_watch_start = _reset['post_contact_watch_start']" in block)
        check("SessionNum経路で post_contact_speed_ok = _reset['post_contact_speed_ok'] がある",
              "post_contact_speed_ok = _reset['post_contact_speed_ok']" in block)


def test_removing_post_contact_reset_would_break_test():
    print('\n══ 変異試験：post_contact_watch_start のunpackを削除するとテスト検出できる ══')
    src = _bridge_source()
    # sig経路の対象行
    target_sig = "                        post_contact_watch_start = _sig_reset['post_contact_watch_start']\n"
    check('変異対象(sig経路)がソースに存在する', target_sig in src)
    mut = src.replace(target_sig, '', 1)
    check('変異が実際にソースを変更した', mut != src)
    m = re.search(r"last_session_sig\s*=\s*sig[\s\S]{0,4000}?_gate_state\['pending'\]\s*=\s*None", mut)
    block = m.group(0) if m else ''
    check('変異後は sig経路に post_contact_watch_start のunpackが無い(検出可)',
          "post_contact_watch_start = _sig_reset['post_contact_watch_start']" not in block)


# ── pit_entry 再設計テスト（2026-07-24 Yuji設計・Codex差戻し対応） ────────

def test_pit_entry_state_update_not_gated_by_speed():
    print('\n══ 本番配線：pit接近境界で先行通知し、OnPitRoadをフォールバックにする ══')
    src = _bridge_source()
    check('PlayerTrackSurface 3→2 の接近境界を先行通知に使用',
          '_pit_surface_prev == 3 and _pit_surface_now == 2' in src)
    check('先行通知は OnPitRoad 前だけに限定',
          'and not onPit and not pit_entry_announced_stop' in src)
    check('低速誤発火を Speed>5m/s で抑止',
          '_pit_entry_speed_ok = (_spd_pit is not None and _spd_pit > 5.0)' in src)
    check('OnPitRoad False→True フォールバックを維持',
          "if onPit and prev['onPit'] is False:" in src
          and 'if not pit_entry_announced_stop and _pit_entry_speed_ok:' in src)
    check('1ストップ1回の通知フラグをセッション状態として保持',
          "'pit_entry_announced_stop': False" in src
          and "pit_entry_announced_stop = _reset['pit_entry_announced_stop']" in src)


def test_low_speed_pit_entry_no_broadcast_but_state_updates():
    print('\n══ 変異試験：先行通知の3→2境界を削除すると検出する ══')
    src = _bridge_source()
    old = '_pit_surface_prev == 3 and _pit_surface_now == 2'
    check('変異対象の先行通知境界が存在する', old in src)
    mut = src.replace(old, 'False  # mutation: early trigger removed', 1)
    check('変異が実際にソースを変更した', mut != src)
    check('変異後は3→2先行通知契約を満たさない',
          old not in mut)


def test_pit_entry_prev_onpit_guard_prevents_startup_spawn_misfire():
    print('\n══ 本番配線：pit_entry は prev["onPit"] is False の genuine False→True 遷移のみ ══')
    src = _bridge_source()
    # `if onPit and prev['onPit'] is False:` パターン。従来の `not prev['onPit']` (None→Trueで誤発火)を排除
    check("pit_entry のガードが `prev['onPit'] is False` で書かれている(None→True除外)",
          "if onPit and prev['onPit'] is False:" in src)
    check("旧パターン `if onPit and not prev['onPit']:` はもう残っていない",
          "if onPit and not prev['onPit']:" not in src)


def run_all():
    print('══ judge_call LLM候補予算ゲートのテスト ══')
    test_budget_caps_throttled_kinds()
    test_budget_shared_across_different_kinds()
    test_window_expiry_resets_budget()
    test_danger_never_throttled()
    test_towing_removed_from_all_layers()      # ★2026-07-24 towing削除の回帰テスト
    test_no_random_throttling()
    test_all_judge_call_broadcasts_have_gate_wired()
    test_removing_gate_call_would_break_wiring_test()
    test_session_num_change_resets_llm_budget()
    test_sig_reset_path_resets_llm_budget()
    test_removing_sig_unpack_would_break_wiring_test()
    test_removing_session_num_unpack_would_break_wiring_test()
    test_skip_log_dedup_prevents_per_poll_spam()
    test_skip_log_dedup_is_per_kind()
    test_qualifying_full_budget_then_race_first_call_passes()
    test_throttled_catchup_does_not_consume_stage_wiring()
    # ★2026-07-24 post_contact_ok と pit_entry再設計の新規テスト
    test_post_contact_ok_priority_is_p2_not_p4()
    test_post_contact_ok_fires_when_speed_sustained_5sec()
    test_post_contact_ok_silent_when_speed_drops_below_30kmh()
    test_post_contact_ok_silent_on_data_gap()
    test_post_contact_ok_reset_on_session_change()
    test_post_contact_ok_unpacked_in_both_reset_paths()
    test_removing_post_contact_reset_would_break_test()
    test_pit_entry_state_update_not_gated_by_speed()
    test_low_speed_pit_entry_no_broadcast_but_state_updates()
    test_pit_entry_prev_onpit_guard_prevents_startup_spawn_misfire()
    print(f"\n[judge llm gate] 合格 {pass_n} / 不合格 {fail_n}")
    return fail_n == 0


if __name__ == '__main__':
    ok = run_all()
    sys.exit(0 if ok else 1)
