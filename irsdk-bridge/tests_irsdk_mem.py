"""
OMORAY PITWALL - irsdk_mem.py 単体テスト（2026-07-21・Codexレビュー P0-2 再レビュー条件）

【なぜ必要か】
  log_strategy_timeseries.py が独自のヘッダーオフセットを使い、共有メモリを誤読していた
  （P0-2）。今後もこの種の「実走せずに構造を書き直す」事故を機械的に検出するため、
  合成メモリバッファ（Windows不要・iRacing不要）で status / numVars / varHeaderOffset /
  最新varBuf選択 / 配列値読み取りを検証する。

【2026-07-21 再指摘（Codexレビュー）への対応】
  初版は fixture を irsdk_mem.py の定数（irsdk_mem.H_STATUS 等）で書き込んでいたため
  自己参照だった。H_STATUS を 4→8 に書き換えても、書込位置と読取位置が一緒に動くので、
  元の欠陥（独自定義がズレて共有メモリを誤読する）を検出できなかった。
  この版では：
    ① fixture は irsdk_mem を一切参照しない、独立したハードコードの絶対オフセットで書く
       （＝実際のiRSDKレイアウトを表す「正解」を、テストコード自身が知っている）。
    ② irsdk_mem.py が公開する各定数の値そのものを、その絶対オフセットに対して個別assertする。
  これにより、誰かが irsdk_mem.py の定数を書き換えると②が即座に落ち、
  fixtureとreader実装がズレると①のread系アサーションが落ちる。どちらの事故も検出できる。

実行: python3 irsdk-bridge/tests_irsdk_mem.py
"""
import ctypes
import struct
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
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


# ══════════════════════════════════════════════════════════════════════
# ① irsdk_mem.py が公開する定数が、iRSDK実仕様の絶対値と一致しているか。
#    ここは irsdk_mem からimportした値ではなく、レビューで確認された「正解」を
#    このテストファイル自身がハードコードして比較する（自己参照を避ける）。
# ══════════════════════════════════════════════════════════════════════
EXPECTED_CONSTANTS = {
    'H_STATUS': 4,
    'H_NUM_VARS': 24,
    'H_VAR_HEADER_OFFSET': 28,
    'H_NUM_BUF': 32,
    'VARBUF_BASE': 48,
    'VARBUF_STRIDE': 16,
    'VAR_HEADER_SIZE': 144,
    'VAR_NAME_OFF': 16,
}


def check_constants():
    print('══ ① irsdk_mem.py の公開定数が実仕様の絶対値と一致するか ══')
    for name, expected in EXPECTED_CONSTANTS.items():
        actual = getattr(irsdk_mem, name, None)
        check(f'{name} == {expected}', actual == expected, f'actual={actual}')


# ══════════════════════════════════════════════════════════════════════
# ② 合成メモリ：ハードコードした絶対オフセットにだけ書く。irsdk_mem の定数は一切使わない。
#    もし irsdk_mem.py 側のオフセット定義がここと食い違えば、build_index/get_buf_offset は
#    このfixtureが置いた場所とは別の場所を読みに行き、後段のassertが落ちる。
# ══════════════════════════════════════════════════════════════════════
_ABS_H_STATUS = 4
_ABS_H_NUM_VARS = 24
_ABS_H_VAR_HEADER_OFFSET = 28
_ABS_H_NUM_BUF = 32
_ABS_VARBUF_BASE = 48
_ABS_VARBUF_STRIDE = 16
_ABS_VAR_HEADER_SIZE = 144
_ABS_VAR_NAME_OFF = 16


def build_synthetic_mem():
    """iRSDK共有メモリと同じバイトレイアウトを、独立したハードコード絶対オフセットで作る。"""
    SIZE = 2048
    buf = ctypes.create_string_buffer(SIZE)

    VAR_HDR_OFFSET = 200   # H_VAR_HEADER_OFFSET が指す先（fixture側で決める値）
    NUM_VARS = 2
    BUF0_DATA = 600        # 古いtickのvarBufデータ領域（罠：これを選んだら誤り）
    BUF1_DATA = 700        # 新しいtickのvarBufデータ領域（正解はこちら）

    def put_i32(off, val):
        struct.pack_into('i', buf, off, val)

    def put_f32(off, val):
        struct.pack_into('f', buf, off, val)

    # ── ヘッダー（絶対オフセットに直接書く。irsdk_mem.* は参照しない） ──
    put_i32(_ABS_H_STATUS, 1)                       # テレメトリアクティブ
    put_i32(_ABS_H_NUM_VARS, NUM_VARS)
    put_i32(_ABS_H_VAR_HEADER_OFFSET, VAR_HDR_OFFSET)
    put_i32(_ABS_H_NUM_BUF, 2)

    # ── varBuf テーブル（tick, offset）× 2本。tickが大きい方(buf1)を選ぶのが正解 ──
    base0 = _ABS_VARBUF_BASE + 0 * _ABS_VARBUF_STRIDE
    base1 = _ABS_VARBUF_BASE + 1 * _ABS_VARBUF_STRIDE
    put_i32(base0, 5); put_i32(base0 + 4, BUF0_DATA)      # tick=5（古い）
    put_i32(base1, 9); put_i32(base1 + 4, BUF1_DATA)      # tick=9（最新）

    # ── 変数ヘッダー（type, offset, count, ..., name@16） ──
    # 0: TestInt (int, count=1, データはvarBuf先頭+0)
    h0 = VAR_HDR_OFFSET + 0 * _ABS_VAR_HEADER_SIZE
    put_i32(h0 + 0, 2)   # type=int
    put_i32(h0 + 4, 0)   # offset within varBuf
    put_i32(h0 + 8, 1)   # count
    buf[h0 + _ABS_VAR_NAME_OFF: h0 + _ABS_VAR_NAME_OFF + 7] = b'TestInt'

    # 1: TestArr (float[3], データはvarBuf先頭+4)
    h1 = VAR_HDR_OFFSET + 1 * _ABS_VAR_HEADER_SIZE
    put_i32(h1 + 0, 4)   # type=float
    put_i32(h1 + 4, 4)   # offset within varBuf
    put_i32(h1 + 8, 3)   # count
    buf[h1 + _ABS_VAR_NAME_OFF: h1 + _ABS_VAR_NAME_OFF + 7] = b'TestArr'

    # ── 実データ：古いtick(buf0)には罠の値、新しいtick(buf1)には正解の値 ──
    put_i32(BUF0_DATA + 0, -999)
    put_f32(BUF0_DATA + 4, -9.9); put_f32(BUF0_DATA + 8, -9.9); put_f32(BUF0_DATA + 12, -9.9)

    put_i32(BUF1_DATA + 0, 42)
    put_f32(BUF1_DATA + 4, 1.5); put_f32(BUF1_DATA + 8, 2.5); put_f32(BUF1_DATA + 12, 3.5)

    return buf, ctypes.addressof(buf)


def check_reader():
    buf, ptr = build_synthetic_mem()   # keep `buf` alive — GC'ing it invalidates `ptr`

    print('\n══ ② irsdk_mem.py の reader関数が、独立fixtureの絶対オフセットを正しく読むか ══')

    check('H_STATUS: アクティブ(1)と読める', irsdk_mem.read_int_at(ptr, irsdk_mem.H_STATUS) == 1)
    check('H_NUM_VARS: 2と読める', irsdk_mem.read_int_at(ptr, irsdk_mem.H_NUM_VARS) == 2)
    check('H_VAR_HEADER_OFFSET: 200と読める', irsdk_mem.read_int_at(ptr, irsdk_mem.H_VAR_HEADER_OFFSET) == 200)

    off, tick = irsdk_mem.get_buf_offset(ptr)
    check('get_buf_offset: 最新tick(9)を選ぶ（古い方(5)を選ばない）', tick == 9, f'tick={tick}')
    check('get_buf_offset: 最新tickのoffset(700)を選ぶ', off == 700, f'off={off}')

    idx = irsdk_mem.build_index(ptr)
    check('build_index: TestIntを索引する', idx.get('TestInt') == (2, 0, 1), idx.get('TestInt'))
    check('build_index: TestArrを索引する', idx.get('TestArr') == (4, 4, 3), idx.get('TestArr'))

    # 最新tickのbufOffsetから正しい値を読む（罠の古いtick値(-999/-9.9)を読んでいないこと）
    int_val = struct.unpack('i', ctypes.string_at(ptr + off + 0, 4))[0]
    check('最新varBufからTestIntの正しい値(42)を読む（罠の-999でない）', int_val == 42, int_val)

    arr_vals = [struct.unpack('f', ctypes.string_at(ptr + off + 4 + i * 4, 4))[0] for i in range(3)]
    check('最新varBufからTestArrの正しい値([1.5,2.5,3.5])を読む',
          all(abs(a - b) < 1e-6 for a, b in zip(arr_vals, [1.5, 2.5, 3.5])), arr_vals)

    # ── get_buf_offsetの安全策：H_NUM_BUFが暴走(誤読で巨大値)しても4本の上限で止まる ──
    struct.pack_into('i', buf, _ABS_H_NUM_BUF, 999999)
    off2, tick2 = irsdk_mem.get_buf_offset(ptr)
    check('H_NUM_BUFが暴走してもmin(n,4)で無効メモリを広く読まない（クラッシュしない）',
          tick2 == 9 and off2 == 700, (off2, tick2))


def main():
    check_constants()
    check_reader()
    print(f"\n[irsdk_mem] 合格 {pass_n} / 不合格 {fail_n}")
    return 0 if fail_n == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
