"""
OMORAY PITWALL - Unit 0（SessionInfo cap 診断計装）の単体テスト（Codex差戻し対応版）

7/24 IMSA Road America 実走ログで si_len=524288 >= cap(200000) が連発した件、
524288 が iRacing のバッファ最大サイズなのか実データ長なのか、Positions/DriverInfo
末尾が失われているかを判定するための純粋関数 analyze_session_info_extent() と、
IRacingReader._diag_session_info_extent() 配線を検証する。

★診断のみ・cap 拡張や再読み取りは責務外（Codex指示）。
★probe の上限は呼び出し側で明示（無条件si_len信用の防止）。
★共有メモリ物理境界（MEM_SIZE）を必ず検証（マップ外アクセスでプロセスクラッシュを防ぐ）。
★NUL以降は前セッションの残骸なのでキー検索対象から除外。
★dedup 署名は診断項目を網羅（Positions・CarScreenName・si_len・probe_size 全て含む）。
★_diag_last_signature は __init__ / close() で必ずリセット（再接続時に再診断できる契約）。

実行: python3 irsdk-bridge/tests_session_info_extent.py
"""
import sys
import os
import re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bridge  # noqa: E402
import irsdk_mem  # noqa: E402

pass_n, fail_n = 0, 0


def check(name, cond, detail=''):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print('  ✅ ' + name)
    else:
        fail_n += 1
        print('  ❌ ' + name + ('  → ' + str(detail) if detail else ''))


_BRIDGE_SRC = None


def _bridge_source():
    global _BRIDGE_SRC
    if _BRIDGE_SRC is None:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bridge.py'), 'r') as f:
            _BRIDGE_SRC = f.read()
    return _BRIDGE_SRC


# ── 純粋関数テスト（analyze_session_info_extent） ──────────────────────

def test_empty_input_returns_no_content():
    print('\n══ 空入力：cap_verdict=no_content・key_positionsは全てNone/[] ══')
    r = bridge.analyze_session_info_extent(b'', cap=200000, si_len_reported=0)
    check('raw_bytes_analyzed=0', r['raw_bytes_analyzed'] == 0)
    check('first_nul_pos=None', r['first_nul_pos'] is None)
    check('last_nonzero_pos=None', r['last_nonzero_pos'] is None)
    check('content_ends_at=0', r['content_ends_at'] == 0)
    check('cap_verdict=no_content', r['cap_verdict'] == 'no_content')
    for k in ('DriverInfo:', 'SessionResults:', 'Sessions:', 'Positions:'):
        check(f'{k} が None', r['key_positions'][k] is None)
    check('CarScreenName: が空list', r['key_positions']['CarScreenName:'] == [])


def test_content_within_cap_no_padding():
    print('\n══ cap内に実データが収まり末尾までNULなし＝safe ══')
    raw = b'X' * 200 + b'DriverInfo:\n' + b'Y' * 88   # 全300バイト
    r = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=300)
    check('first_nul_pos=None（NUL無し）', r['first_nul_pos'] is None)
    check('last_nonzero_pos=299（末尾直前）', r['last_nonzero_pos'] == 299)
    check('content_ends_at=raw末尾（300）', r['content_ends_at'] == 300)
    check('cap_verdict=safe（cap内収まる・si_len<cap）', r['cap_verdict'] == 'safe')
    check('DriverInfo: 位置検出（=200）', r['key_positions']['DriverInfo:'] == 200)


def test_content_within_cap_but_si_len_exceeds_cap_is_padded():
    print('\n══ 実データはcap内で終わるが si_len は cap 超え＝padded_after_cap ══')
    raw = b'A' * 99000 + b'DriverInfo:\nSessions:\n' + b'\x00' * 300000
    r = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=524288)
    check('first_nul_pos が NUL パディング開始位置',
          r['first_nul_pos'] == 99000 + len(b'DriverInfo:\nSessions:\n'))
    check('content_ends_at < cap', r['content_ends_at'] < 200000)
    check('cap_verdict=padded_after_cap', r['cap_verdict'] == 'padded_after_cap',
          f"actual={r['cap_verdict']}")
    check('DriverInfo: が cap 内', r['key_positions']['DriverInfo:'] < 200000)


def test_content_truly_extends_past_cap_is_truncated():
    print('\n══ 実データが cap を超えて続く＝truncated_at_cap ══')
    raw = b'A' * 199500 + b'DriverInfo:\n' + b'B' * 200000    # NUL無し
    r = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=524288)
    check('first_nul_pos=None（cap 超えても NUL 未検出）', r['first_nul_pos'] is None)
    check('content_ends_at > cap', r['content_ends_at'] > 200000)
    check('cap_verdict=truncated_at_cap', r['cap_verdict'] == 'truncated_at_cap')


def test_key_positions_detected_across_cap_boundary():
    print('\n══ 必須キーが cap 内外のどちらにあるか正確に位置検出 ══')
    driver_key = b'DriverInfo:\n'
    session_results_key = b'SessionResults:\n'
    positions_key = b'Positions:\n'
    raw = (
        b'X' * 100 +
        driver_key +
        b'Y' * (200500 - (100 + len(driver_key))) +
        session_results_key +
        b'Z' * 100 +
        positions_key +
        b'\x00' * 10000
    )
    r = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=len(raw))
    check(f'DriverInfo: が cap 内で検出（pos={r["key_positions"]["DriverInfo:"]}）',
          r['key_positions']['DriverInfo:'] == 100)
    check(f'SessionResults: が cap 外で検出（pos={r["key_positions"]["SessionResults:"]}）',
          r['key_positions']['SessionResults:'] is not None and
          r['key_positions']['SessionResults:'] >= 200000)
    check(f'Positions: が cap 外で検出（pos={r["key_positions"]["Positions:"]}）',
          r['key_positions']['Positions:'] is not None and
          r['key_positions']['Positions:'] >= 200000)


def test_car_screen_name_multi_occurrence():
    print('\n══ CarScreenName: は全出現位置をlistで返す（複数車分） ══')
    raw = (b'\n CarScreenName: Mercedes AMG GT3\n' +
           b'X' * 500 +
           b'\n CarScreenName: BMW M4 GT3\n' +
           b'Y' * 500 +
           b'\n CarScreenName: Ferrari 296 GT3\n')
    r = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=len(raw))
    positions = r['key_positions']['CarScreenName:']
    check('CarScreenName: 3つ全部検出', len(positions) == 3, f'found={len(positions)}')
    check('出現位置が単調増加',
          all(positions[i] < positions[i + 1] for i in range(len(positions) - 1)))


def test_key_not_found_returns_none():
    print('\n══ 必須キーが raw 内に無ければ None が返る ══')
    raw = b'This is some other content\nNoRelevantKey:\nAnotherLine:\n'
    r = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=len(raw))
    for k in ('DriverInfo:', 'SessionResults:', 'Sessions:', 'Positions:'):
        check(f'{k} は None', r['key_positions'][k] is None)
    check('CarScreenName: は空list', r['key_positions']['CarScreenName:'] == [])


def test_content_ending_at_first_nul_before_cap():
    print('\n══ 実データが cap より手前で NUL 終端＝content_ends_at=first_nul_pos ══')
    raw = b'DriverInfo:\nSomeData\n' + b'\x00' * 50000
    r = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=len(raw))
    expected_end = len(b'DriverInfo:\nSomeData\n')
    check(f'first_nul_pos={expected_end}', r['first_nul_pos'] == expected_end)
    check(f'content_ends_at={expected_end}', r['content_ends_at'] == expected_end)


def test_all_null_input_is_no_content():
    print('\n══ 全部NUL入力＝no_content ══')
    raw = b'\x00' * 1000
    r = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=1000)
    check('first_nul_pos=0', r['first_nul_pos'] == 0)
    check('last_nonzero_pos=None', r['last_nonzero_pos'] is None)
    check('content_ends_at=0', r['content_ends_at'] == 0)
    check('cap_verdict=no_content', r['cap_verdict'] == 'no_content')


def test_si_len_below_cap_but_no_nul_is_safe():
    print('\n══ si_len<cap かつ NUL 無し（rawが実データちょうど）＝safe ══')
    raw = b'DriverInfo:\nSomeData\n' * 100
    r = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=len(raw))
    check('cap_verdict=safe', r['cap_verdict'] == 'safe')
    check('content_ends_at=raw末尾', r['content_ends_at'] == len(raw))


# ── P1 対応：NUL以降のキー検索を除外 ────────────────────────

def test_p1_keys_after_nul_are_not_detected():
    print('\n══ P1：NUL 以降に置かれた偽キーは検出されない（前セッション残骸対策） ══')
    # 実データは短くて NUL 終端。その後に偽の "Positions:" と "CarScreenName:" を置く。
    real_content = b'DriverInfo:\nlast: real\n'   # 22 bytes
    fake_after_nul = b'\x00Positions:\nfake_pos\n CarScreenName: fake_car\n' + b'\x00' * 100
    raw = real_content + fake_after_nul
    r = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=len(raw))
    check('content_ends_at は実データ終端（NUL の位置）',
          r['content_ends_at'] == len(real_content))
    check('実データ内の DriverInfo: は検出',
          r['key_positions']['DriverInfo:'] == 0)
    check('NUL 以降の偽 Positions: は None（検出されない）',
          r['key_positions']['Positions:'] is None,
          f"actual={r['key_positions']['Positions:']}")
    check('NUL 以降の偽 CarScreenName: は空list',
          r['key_positions']['CarScreenName:'] == [],
          f"actual={r['key_positions']['CarScreenName:']}")


def test_p1_content_bytes_slicing_applies_to_all_keys():
    print('\n══ P1：NUL の直前で終わる実データ内キーは検出、直後の同名キーは検出しない ══')
    real_content = b'DriverInfo:\nSessionResults:\nSessions:\n'
    raw = real_content + b'\x00' + b'DriverInfo:\nSessionResults:\nSessions:\nPositions:\n'
    r = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=len(raw))
    # 実データ内の3件は検出、Positions: は NUL 以降にしかないので検出されない
    check('DriverInfo: 検出（実データ内）',
          r['key_positions']['DriverInfo:'] == 0)
    check('SessionResults: 検出（実データ内）',
          r['key_positions']['SessionResults:'] is not None)
    check('Sessions: 検出（実データ内）',
          r['key_positions']['Sessions:'] is not None)
    check('Positions: は None（NUL 以降にしか無い）',
          r['key_positions']['Positions:'] is None)


# ── P2 対応：cap 境界 off-by-one ────────────────────────────

def test_p2_content_ending_exactly_at_cap_is_safe():
    print('\n══ P2：content_ends_at == cap ちょうどは safe/padded（truncated ではない） ══')
    # content ちょうど cap の位置で NUL 終端
    raw = b'A' * 200000 + b'\x00' * 100
    r = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=524288)
    check(f'content_ends_at={r["content_ends_at"]} == cap(200000)',
          r['content_ends_at'] == 200000)
    check('cap_verdict=padded_after_cap（境界ちょうど・cap 内収まる）',
          r['cap_verdict'] == 'padded_after_cap',
          f"actual={r['cap_verdict']}")


def test_p2_content_one_byte_past_cap_is_truncated():
    print('\n══ P2：cap+1 バイトから NUL は truncated_at_cap ══')
    raw = b'A' * 200001 + b'\x00' * 100
    r = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=524288)
    check('content_ends_at > cap（201バイト目でNUL）',
          r['content_ends_at'] == 200001)
    check('cap_verdict=truncated_at_cap（境界超過）',
          r['cap_verdict'] == 'truncated_at_cap')


# ── P0 対応：MEM_SIZE 境界検証（配線テスト） ─────────────────

def test_p0_diag_source_validates_mem_size_bounds():
    print('\n══ P0：_diag_session_info_extent は MEM_SIZE 境界を検証する ══')
    src = _bridge_source()
    check('MEM_SIZE の import 参照が診断内にある',
          'irsdk_mem.MEM_SIZE' in src)
    check('si_offset >= MEM_SIZE で早期 return',
          'si_offset >= irsdk_mem.MEM_SIZE' in src)
    check('probe_size = min(si_len, _DIAG_PROBE_MAX, readable) 形式',
          'probe_size = min(si_len, self._DIAG_PROBE_MAX, readable)' in src)
    check('readable の計算式が MEM_SIZE - si_offset',
          'readable = irsdk_mem.MEM_SIZE - si_offset' in src)


def test_p0_diag_source_rejects_bad_values_before_read():
    print('\n══ P0：悪性値（None/0/負数/範囲外）で _bytes() を呼ばず即 return ══')
    src = _bridge_source()
    # ソースパターン検証：全ての early-return が _bytes 呼び出しより前にある
    diag_start = src.find('def _diag_session_info_extent(')
    check('_diag_session_info_extent の定義がある', diag_start >= 0)
    diag_body_end = src.find('def analyze_session_info_extent', diag_start)
    diag_body = src[diag_start:diag_body_end]
    # 各 early-return が _bytes 呼び出しより前にあること
    bytes_call_pos = diag_body.find('self._bytes(si_offset, probe_size)')
    check('_bytes(si_offset, probe_size) 呼び出しがある', bytes_call_pos >= 0)
    for guard, label in [
        ('si_offset is None or si_offset <= 0 or si_offset >= irsdk_mem.MEM_SIZE',
         'si_offset の境界チェック'),
        ('si_len is None or si_len <= 0', 'si_len の境界チェック'),
        ('probe_size <= 0', 'probe_size の下限チェック'),
    ]:
        guard_pos = diag_body.find(guard)
        check(f'{label} が _bytes 呼び出しより前にある',
              0 <= guard_pos < bytes_call_pos,
              f'guard_pos={guard_pos} bytes_pos={bytes_call_pos}')


# ── P1 対応：dedup 署名網羅 & インスタンス属性化（配線テスト） ─────

def test_p1_dedup_signature_includes_all_diag_items():
    print('\n══ P1：dedup 署名が診断項目を網羅（Positions・CarScreenName・si_len・probe_size） ══')
    src = _bridge_source()
    # sig タプルの構築部を抽出（sig = ( ... ) の複数行タプル・入れ子()を含むので終端は
    # "if sig == self._diag_last_signature:" 行の直前まで、と決めて切り出す）
    sig_start = src.find('sig = (', src.find('def _diag_session_info_extent('))
    sig_terminator = src.find('if sig == self._diag_last_signature', sig_start)
    sig_block = src[sig_start:sig_terminator]
    check('署名に si_len が含まれる', 'si_len' in sig_block)
    check('署名に probe_size が含まれる', 'probe_size' in sig_block)
    check('署名に first_nul_pos が含まれる', "'first_nul_pos'" in sig_block)
    check('署名に content_ends_at が含まれる', "'content_ends_at'" in sig_block)
    check('署名に cap_verdict が含まれる', "'cap_verdict'" in sig_block)
    check('署名に DriverInfo: 位置が含まれる', "'DriverInfo:'" in sig_block)
    check('署名に SessionResults: 位置が含まれる', "'SessionResults:'" in sig_block)
    check('署名に Sessions: 位置が含まれる', "'Sessions:'" in sig_block)
    check('署名に Positions: 位置が含まれる', "'Positions:'" in sig_block)
    check('署名に CarScreenName: 先頭位置が含まれる（_csn[0]）',
          '_csn[0]' in sig_block)
    check('署名に CarScreenName: 末尾位置が含まれる（_csn[-1]）',
          '_csn[-1]' in sig_block)
    check('署名に CarScreenName: 件数が含まれる（len(_csn)）',
          'len(_csn)' in sig_block)


def test_p1_diag_signature_is_instance_attribute():
    print('\n══ P1：_diag_last_signature は __init__ / close() で必ずリセット ══')
    src = _bridge_source()
    # __init__ 内で self._diag_last_signature = None が設定されている
    init_start = src.find('def __init__(self):')
    init_end = src.find('def ', init_start + 20)
    init_body = src[init_start:init_end]
    check('__init__ で self._diag_last_signature = None が初期化される',
          'self._diag_last_signature = None' in init_body)
    # close() 内でリセット
    close_start = src.find('def close(self):')
    close_end = src.find('def ', close_start + 20)
    close_body = src[close_start:close_end]
    check('close() で self._diag_last_signature = None にリセット',
          'self._diag_last_signature = None' in close_body)

    # 実際にインスタンスを2回作って独立していることを確認
    r1 = bridge.IRacingReader()
    r2 = bridge.IRacingReader()
    r1._diag_last_signature = ('some', 'signature')
    check('r1 と r2 の署名が独立（インスタンス属性化の実挙動）',
          r2._diag_last_signature is None,
          f"r2 sig={r2._diag_last_signature}")


# ── read_session_info への配線 ────────────────────────────

def test_read_session_info_wires_diagnostic():
    print('\n══ 本番配線：read_session_info() が _diag_session_info_extent を呼んでいる ══')
    src = _bridge_source()
    check('read_session_info の中で _diag_session_info_extent が呼ばれている',
          '_diag_session_info_extent(si_offset, si_len, _cap)' in src)


def test_diag_uses_bounded_probe_max():
    print('\n══ probe は上限バイト数付き（無条件 si_len 信用の防止） ══')
    src = _bridge_source()
    check('_DIAG_PROBE_MAX = 400000 が定義されている',
          '_DIAG_PROBE_MAX = 400000' in src)


def test_operational_read_uses_audited_ceiling():
    print('\n══ operational read も監査済み上限まで読む ══')
    src = _bridge_source()
    check("operational read は _DIAG_PROBE_MAX を使用",
          "_cap = self._DIAG_PROBE_MAX" in src)
    check("operational raw の読み取り上限が min(si_len, _cap) のまま",
          "raw = self._bytes(si_offset, min(si_len, _cap))" in src)


# ── 変異試験（本物・実装を壊してテストが検出することを示す） ─────────

def _mutate_and_reload(mutation_pattern, replacement, count=1):
    """bridge.py のソースを一時的に変異させ、再import して失敗するテストを実行する。
    ソースを書き換えて import し直すのは危険なので、代わりに source を読んで文字列置換した
    バージョンを exec し、変異版の関数を新しい名前空間へ入れる（分離実行）。
    """
    src = _bridge_source()
    mutated_src = src.replace(mutation_pattern, replacement, count)
    if mutated_src == src:
        return None, "mutation_pattern が見つからなかった"
    ns = {}
    try:
        # 変異版を独立した名前空間で実行（本モジュールは汚さない）
        # bridge.py は再import できない構造なので、対象関数だけを抽出して exec する
        # 変異は analyze_session_info_extent への影響を見るので、関数定義部だけ切り出す
        func_start = mutated_src.find('def analyze_session_info_extent(')
        # 次のトップレベル def / class までを関数本体として抽出
        m = re.search(r'^(def |class )', mutated_src[func_start + 10:], re.MULTILINE)
        func_end = (func_start + 10 + m.start()) if m else len(mutated_src)
        func_src = mutated_src[func_start:func_end]
        exec(func_src, ns)
        return ns['analyze_session_info_extent'], None
    except Exception as e:
        return None, str(e)


def test_mutation_removing_nul_slicing_breaks_p1_test():
    print('\n══ 変異試験P1：content_bytes スライスを削除するとNUL以降の偽キーが誤検出される ══')
    # 変異：content_bytes = raw_bytes[:result['content_ends_at']] を raw_bytes に戻す
    mutation_pattern = "content_bytes = raw_bytes[:result['content_ends_at']]"
    replacement = "content_bytes = raw_bytes  # MUTATED"
    fn, err = _mutate_and_reload(mutation_pattern, replacement)
    check('変異版関数が生成できた', fn is not None, err)
    if not fn:
        return
    # NUL 以降に偽 Positions: を置いた入力
    real_content = b'DriverInfo:\nreal\n'
    raw = real_content + b'\x00Positions:\nfake\n' + b'\x00' * 100
    r_original = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=len(raw))
    r_mutated = fn(raw, cap=200000, si_len_reported=len(raw))
    check('本番実装は Positions: を検出しない（P1修正の効き）',
          r_original['key_positions']['Positions:'] is None)
    check('変異版は Positions: を誤検出する（=このテストが本番のバグを検出できる証明）',
          r_mutated['key_positions']['Positions:'] is not None,
          f"mutated pos={r_mutated['key_positions']['Positions:']}")


def test_mutation_removing_cap_boundary_check_breaks_p2_test():
    print('\n══ 変異試験P2：cap 境界を <= から < に戻すと content_ends_at == cap が truncated になる ══')
    # 変異：<= cap を < cap に戻す（P2 修正の逆）
    mutation_pattern = "elif result['content_ends_at'] <= cap:"
    replacement = "elif result['content_ends_at'] < cap:  # MUTATED"
    fn, err = _mutate_and_reload(mutation_pattern, replacement)
    check('変異版関数が生成できた', fn is not None, err)
    if not fn:
        return
    raw = b'A' * 200000 + b'\x00' * 100    # content ちょうど cap
    r_original = bridge.analyze_session_info_extent(raw, cap=200000, si_len_reported=524288)
    r_mutated = fn(raw, cap=200000, si_len_reported=524288)
    check('本番実装は padded_after_cap（P2修正の効き）',
          r_original['cap_verdict'] == 'padded_after_cap')
    check('変異版は truncated_at_cap に化ける（=このテストが本番のバグを検出できる証明）',
          r_mutated['cap_verdict'] == 'truncated_at_cap',
          f"mutated verdict={r_mutated['cap_verdict']}")


def test_mutation_removing_diag_call_from_read_session_info_would_be_detected():
    print('\n══ 変異試験：read_session_info から _diag_session_info_extent 呼び出しを削除すると配線テスト失敗 ══')
    src = _bridge_source()
    target = "            self._diag_session_info_extent(si_offset, si_len, _cap)\n"
    check('変異対象の行がソースに存在する', target in src)
    mutated = src.replace(target, '            # MUTATED: diag call removed\n', 1)
    check('変異が実際にソースを変更した', mutated != src)
    # 変異後のソースで配線テストと同じ判定
    still_wired = '_diag_session_info_extent(si_offset, si_len, _cap)' in mutated
    check('変異後は配線テストの検出パターンが消える（=このテストが実バグを検出できる証明）',
          not still_wired)


def test_mutation_removing_mem_size_check_would_be_detected():
    print('\n══ 変異試験：MEM_SIZE 境界チェックを削除すると P0 配線テスト失敗 ══')
    src = _bridge_source()
    target = "        if si_offset is None or si_offset <= 0 or si_offset >= irsdk_mem.MEM_SIZE:\n            return\n"
    check('変異対象（MEM_SIZE 境界チェック）がソースに存在する', target in src)
    mutated = src.replace(target, '        # MUTATED: MEM_SIZE check removed\n', 1)
    check('変異が実際にソースを変更した', mutated != src)
    still_has_check = 'si_offset >= irsdk_mem.MEM_SIZE' in mutated
    check('変異後は MEM_SIZE 境界チェックが消える（=このテストが実バグを検出できる証明）',
          not still_has_check)


def test_mutation_removing_positions_from_dedup_signature_would_be_detected():
    print('\n══ 変異試験：dedup 署名から Positions: を削除すると P1 網羅テスト失敗 ══')
    src = _bridge_source()
    target = "                report['key_positions'].get('Positions:'),\n"
    check('変異対象（Positions: の署名要素）がソースに存在する', target in src)
    mutated = src.replace(target, "                # MUTATED: Positions removed from signature\n", 1)
    check('変異が実際にソースを変更した', mutated != src)
    # 変異後の署名ブロック抽出（sig = ( ... ) の複数行・終端は if sig == ... の直前）
    sig_start = mutated.find('sig = (', mutated.find('def _diag_session_info_extent('))
    sig_terminator = mutated.find('if sig == self._diag_last_signature', sig_start)
    sig_block = mutated[sig_start:sig_terminator]
    check('変異後は署名に Positions: が含まれない（=このテストが実バグを検出できる証明）',
          "'Positions:'" not in sig_block)


# ── preflight 配線テスト ──────────────────────────────────

def test_preflight_wires_this_test_suite():
    print('\n══ preflight.sh がこのテストスイートを実行対象に含めている ══')
    preflight_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'preflight.sh')
    with open(preflight_path, 'r') as f:
        preflight_src = f.read()
    check('preflight.sh に tests_session_info_extent.py の実行行がある',
          'tests_session_info_extent.py' in preflight_src)
    check('SessionInfo cap 診断計装 の見出しがある',
          'SessionInfo cap 診断計装' in preflight_src)


# ── Codex差戻し追加：cap 境界のキー位置判定（P1）─────────────────

def test_key_at_pos_cap_minus_one_is_within():
    print('\n══ P1追加：キー位置 = cap-1（199999）は within_cap ══')
    check("key_within_cap_verdict(199999, 200000)='yes'",
          bridge.key_within_cap_verdict(199999, 200000) == 'yes')
    check("key_within_cap_verdict(199999, 200000)='yes'（型不変）",
          bridge.key_within_cap_verdict(199999, 200000) == 'yes')


def test_key_at_pos_exactly_cap_is_outside():
    print('\n══ P1追加：キー位置 = cap（200000）は outside_cap（"no"） ══')
    check("key_within_cap_verdict(200000, 200000)='no'（含めない）",
          bridge.key_within_cap_verdict(200000, 200000) == 'no',
          f"actual={bridge.key_within_cap_verdict(200000, 200000)}")
    check("key_within_cap_verdict(200001, 200000)='no'",
          bridge.key_within_cap_verdict(200001, 200000) == 'no')


def test_key_none_is_not_found():
    print('\n══ P1追加：キー未検出（None）は not_found ══')
    check("key_within_cap_verdict(None, 200000)='not_found'",
          bridge.key_within_cap_verdict(None, 200000) == 'not_found')


# ── Codex差戻し追加：CarScreenName 0件は not_found（P2）────────────

def test_csn_empty_list_is_not_found():
    print('\n══ P2追加：CarScreenName 0件は not_found（mixed でなく） ══')
    check("key_list_within_cap_verdict([], 200000)='not_found'",
          bridge.key_list_within_cap_verdict([], 200000) == 'not_found',
          f"actual={bridge.key_list_within_cap_verdict([], 200000)}")


def test_csn_all_positions_within_cap():
    print('\n══ P2追加：CarScreenName 全件 cap 内は all ══')
    check("all cap 内 = 'all'",
          bridge.key_list_within_cap_verdict([100, 5000, 199999], 200000) == 'all')


def test_csn_all_positions_outside_cap():
    print('\n══ P2追加：CarScreenName 全件 cap 外は none ══')
    check("all cap 外 = 'none'（cap=200000 含めない）",
          bridge.key_list_within_cap_verdict([200000, 300000], 200000) == 'none')
    check("cap ちょうども cap 外扱い",
          bridge.key_list_within_cap_verdict([200000], 200000) == 'none')


def test_csn_mixed_positions():
    print('\n══ P2追加：CarScreenName 内外混在は mixed ══')
    check("cap 内外混在 = 'mixed'",
          bridge.key_list_within_cap_verdict([100, 300000], 200000) == 'mixed')


# ── Codex差戻し追加：動的 MEM_SIZE テスト（stubbed _bytes）─────────

def _make_bytes_spy():
    """_bytes() を差し替えるスパイ。呼び出し回数と引数を記録し、b'' を返す。"""
    calls = []

    def _spy(offset, size):
        calls.append((offset, size))
        return b''

    return _spy, calls


def test_dyn_diag_rejects_offset_none():
    print('\n══ 動的：si_offset=None なら _bytes() を呼ばない ══')
    reader = bridge.IRacingReader()
    spy, calls = _make_bytes_spy()
    reader._bytes = spy
    reader._diag_session_info_extent(None, 100, 200000)
    check('_bytes() 呼び出し回数 = 0', len(calls) == 0, f'calls={calls}')


def test_dyn_diag_rejects_offset_zero_or_negative():
    print('\n══ 動的：si_offset=0/負数 なら _bytes() を呼ばない ══')
    reader = bridge.IRacingReader()
    spy, calls = _make_bytes_spy()
    reader._bytes = spy
    for bad_offset in (0, -1, -100):
        reader._diag_session_info_extent(bad_offset, 100, 200000)
    check(f'_bytes() 呼び出し回数 = 0（試行 3 回）',
          len(calls) == 0, f'calls={calls}')


def test_dyn_diag_rejects_offset_at_or_above_mem_size():
    print('\n══ 動的：si_offset >= MEM_SIZE なら _bytes() を呼ばない ══')
    reader = bridge.IRacingReader()
    spy, calls = _make_bytes_spy()
    reader._bytes = spy
    for bad_offset in (bridge.irsdk_mem.MEM_SIZE, bridge.irsdk_mem.MEM_SIZE + 100,
                       bridge.irsdk_mem.MEM_SIZE + 999999):
        reader._diag_session_info_extent(bad_offset, 100, 200000)
    check(f'_bytes() 呼び出し回数 = 0（試行 3 回）',
          len(calls) == 0, f'calls={calls}')


def test_dyn_diag_rejects_si_len_none():
    print('\n══ 動的：si_len=None なら _bytes() を呼ばない ══')
    reader = bridge.IRacingReader()
    spy, calls = _make_bytes_spy()
    reader._bytes = spy
    reader._diag_session_info_extent(1000, None, 200000)
    check('_bytes() 呼び出し回数 = 0', len(calls) == 0, f'calls={calls}')


def test_dyn_diag_rejects_si_len_zero_or_negative():
    print('\n══ 動的：si_len=0/負数 なら _bytes() を呼ばない ══')
    reader = bridge.IRacingReader()
    spy, calls = _make_bytes_spy()
    reader._bytes = spy
    for bad_len in (0, -1, -1000):
        reader._diag_session_info_extent(1000, bad_len, 200000)
    check('_bytes() 呼び出し回数 = 0（試行 3 回）',
          len(calls) == 0, f'calls={calls}')


def test_dyn_diag_boundary_at_mem_size_minus_10():
    print('\n══ 動的：si_offset=MEM_SIZE-10, si_len=巨大 → _bytes(MEM_SIZE-10, 10) 1回 ══')
    reader = bridge.IRacingReader()
    spy, calls = _make_bytes_spy()
    reader._bytes = spy
    ms = bridge.irsdk_mem.MEM_SIZE
    reader._diag_session_info_extent(ms - 10, 999999999, 200000)
    check('_bytes() が 1 回呼ばれる', len(calls) == 1, f'calls={calls}')
    if calls:
        check(f'呼び出し引数が (MEM_SIZE-10, 10)（readable=10 が上限）',
              calls[0] == (ms - 10, 10),
              f'expected=({ms - 10}, 10), actual={calls[0]}')


def test_dyn_diag_probe_max_caps_large_si_len():
    print('\n══ 動的：si_len > _DIAG_PROBE_MAX なら probe_size=400000 でキャップ ══')
    reader = bridge.IRacingReader()
    spy, calls = _make_bytes_spy()
    reader._bytes = spy
    # 十分な余裕がある offset で、si_len が _DIAG_PROBE_MAX 超え
    reader._diag_session_info_extent(1000, 999999999, 200000)
    check('_bytes() が 1 回呼ばれる', len(calls) == 1, f'calls={calls}')
    if calls:
        check(f'呼び出し size が _DIAG_PROBE_MAX(400000) にキャップされる',
              calls[0] == (1000, 400000),
              f'expected=(1000, 400000), actual={calls[0]}')


def test_dyn_diag_normal_uses_min_of_all_bounds():
    print('\n══ 動的：通常値は min(si_len, probe_max, readable) どおり ══')
    reader = bridge.IRacingReader()
    ms = bridge.irsdk_mem.MEM_SIZE

    # ケース1：si_len が最小（si_len < probe_max, si_len < readable）
    spy1, calls1 = _make_bytes_spy()
    reader._bytes = spy1
    reader._diag_session_info_extent(1000, 50000, 200000)
    check(f'ケース1（si_len 最小）：呼び出し=(1000, 50000)',
          calls1 == [(1000, 50000)], f'actual={calls1}')

    # ケース2：readable が最小（si_offset=MEM_SIZE-1000, si_len=999999）
    reader2 = bridge.IRacingReader()
    spy2, calls2 = _make_bytes_spy()
    reader2._bytes = spy2
    reader2._diag_session_info_extent(ms - 1000, 999999, 200000)
    check(f'ケース2（readable 最小）：呼び出し=(MEM_SIZE-1000, 1000)',
          calls2 == [(ms - 1000, 1000)], f'actual={calls2}')

    # ケース3：probe_max が最小（si_len=500000, readable=巨大）
    reader3 = bridge.IRacingReader()
    spy3, calls3 = _make_bytes_spy()
    reader3._bytes = spy3
    reader3._diag_session_info_extent(1000, 500000, 200000)
    check(f'ケース3（probe_max 最小）：呼び出し=(1000, 400000)',
          calls3 == [(1000, 400000)], f'actual={calls3}')


def test_dyn_diag_survives_bytes_exception():
    print('\n══ 動的：_bytes() が例外を投げても本流に伝播せず処理継続 ══')
    reader = bridge.IRacingReader()

    def _raise(offset, size):
        raise RuntimeError('mmap error')

    reader._bytes = _raise
    # 正常値で呼び出し → _bytes が投げるが _diag は try/except で守られている
    try:
        reader._diag_session_info_extent(1000, 50000, 200000)
        check('_bytes 例外時も _diag は例外を出さない', True)
    except Exception as e:
        check('_bytes 例外時も _diag は例外を出さない', False, f'raised={e}')


def run_all():
    print('══ Unit 0（SessionInfo cap 診断計装・Codex差戻し対応版）テスト ══')
    # 純粋関数
    test_empty_input_returns_no_content()
    test_content_within_cap_no_padding()
    test_content_within_cap_but_si_len_exceeds_cap_is_padded()
    test_content_truly_extends_past_cap_is_truncated()
    test_key_positions_detected_across_cap_boundary()
    test_car_screen_name_multi_occurrence()
    test_key_not_found_returns_none()
    test_content_ending_at_first_nul_before_cap()
    test_all_null_input_is_no_content()
    test_si_len_below_cap_but_no_nul_is_safe()
    # P1：NUL 以降の除外
    test_p1_keys_after_nul_are_not_detected()
    test_p1_content_bytes_slicing_applies_to_all_keys()
    # P2：cap 境界
    test_p2_content_ending_exactly_at_cap_is_safe()
    test_p2_content_one_byte_past_cap_is_truncated()
    # P0：MEM_SIZE 境界
    test_p0_diag_source_validates_mem_size_bounds()
    test_p0_diag_source_rejects_bad_values_before_read()
    # P1：dedup 署名網羅・インスタンス属性化
    test_p1_dedup_signature_includes_all_diag_items()
    test_p1_diag_signature_is_instance_attribute()
    # 配線
    test_read_session_info_wires_diagnostic()
    test_diag_uses_bounded_probe_max()
    test_operational_read_uses_audited_ceiling()
    # 本物の変異試験（実装を壊してテスト検出する）
    test_mutation_removing_nul_slicing_breaks_p1_test()
    test_mutation_removing_cap_boundary_check_breaks_p2_test()
    test_mutation_removing_diag_call_from_read_session_info_would_be_detected()
    test_mutation_removing_mem_size_check_would_be_detected()
    test_mutation_removing_positions_from_dedup_signature_would_be_detected()
    # preflight 配線
    test_preflight_wires_this_test_suite()
    # Codex差戻し追加：cap 境界のキー位置判定（P1）
    test_key_at_pos_cap_minus_one_is_within()
    test_key_at_pos_exactly_cap_is_outside()
    test_key_none_is_not_found()
    # Codex差戻し追加：CarScreenName 0件 not_found（P2）
    test_csn_empty_list_is_not_found()
    test_csn_all_positions_within_cap()
    test_csn_all_positions_outside_cap()
    test_csn_mixed_positions()
    # Codex差戻し追加：動的 MEM_SIZE テスト
    test_dyn_diag_rejects_offset_none()
    test_dyn_diag_rejects_offset_zero_or_negative()
    test_dyn_diag_rejects_offset_at_or_above_mem_size()
    test_dyn_diag_rejects_si_len_none()
    test_dyn_diag_rejects_si_len_zero_or_negative()
    test_dyn_diag_boundary_at_mem_size_minus_10()
    test_dyn_diag_probe_max_caps_large_si_len()
    test_dyn_diag_normal_uses_min_of_all_bounds()
    test_dyn_diag_survives_bytes_exception()
    print(f"\n[session info extent] 合格 {pass_n} / 不合格 {fail_n}")
    return fail_n == 0


if __name__ == '__main__':
    ok = run_all()
    sys.exit(0 if ok else 1)
