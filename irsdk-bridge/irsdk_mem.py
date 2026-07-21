"""
OMORAY PITWALL - iRacing SDK 共有メモリ ヘッダー定数・reader（実走確認済み・単一の真実源）

【なぜ作るか（2026-07-21 Codexレビュー P0-2）】
  log_strategy_timeseries.py が独自にヘッダーオフセットを定義し直した結果、
  実走済みの bridge.py / dump_all_vars.py と値がずれていた（H_STATUS=8 vs 4 等）。
  テレメトリを非アクティブと誤判定し、変数ヘッダーを無関係な場所から読む欠陥だった。

【2026-07-21 追加（Codexレビュー再指摘）】
  定数だけ揃えても、log_strategy_timeseries.py は共有メモリを開くWindows FFI
  （OpenFileMappingW / MapViewOfFile）を独自実装しており、bridge.py にある
  argtypes/restype 指定を欠いていた。ctypesはargtypesが無いとポインタ/HANDLE引数を
  既定の c_int としてマーシャリングするため、64bit環境でハンドルやアドレスの値が
  壊れうる（実走で低確率のクラッシュ・誤読につながる）。
  bridge.py の実走確認済みFFI呼び出しをここへ一本化し、bridge / dump / logger が
  同じ open_shared_mem() / close_shared_mem() を使う。

  この事故を再発させないため、bridge / dump / logger は必ずこのモジュールの定数と
  reader関数を import する。値をここ以外の場所に書き直さないこと。
"""

import ctypes
try:
    from ctypes import wintypes
except (ImportError, ValueError):
    wintypes = None  # 非Windows環境（例: Mac開発機でのテスト実行）
import struct

IRSDK_MEMMAPFILE = "Local\\IRSDKMemMapFileName"
MEM_SIZE = 1164 * 1024
FILE_MAP_READ = 0x0004

# ── Windows FFI: OpenFileMappingW / MapViewOfFile（bridge.pyの実走確認済み実装）──
try:
    _k32 = ctypes.windll.kernel32
    _k32.OpenFileMappingW.restype = wintypes.HANDLE
    _k32.OpenFileMappingW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    _k32.MapViewOfFile.restype = ctypes.c_void_p
    _k32.MapViewOfFile.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_size_t]
    _k32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
except Exception:
    _k32 = None  # 非Windows、またはkernel32が無い環境


def open_shared_mem():
    """iRacingが作った既存の共有メモリに接続する（自分で作らない＝空マップ誤作成を防ぐ）。
    Returns: (k32, handle, ptr)。失敗時は ptr が None（iRacing未起動 / 非Windows等）。
    """
    if _k32 is None:
        return None, None, None
    h = _k32.OpenFileMappingW(FILE_MAP_READ, False, IRSDK_MEMMAPFILE)
    if not h:
        return _k32, None, None  # iRacing未起動
    ptr = _k32.MapViewOfFile(h, FILE_MAP_READ, 0, 0, 0)
    if not ptr:
        _k32.CloseHandle(h)
        return _k32, None, None
    return _k32, h, ptr


def close_shared_mem(k32, handle, ptr):
    """open_shared_mem() で得たハンドルを解放する。"""
    if k32 is None:
        return
    try:
        if ptr:
            k32.UnmapViewOfFile(ctypes.c_void_p(ptr))
        if handle:
            k32.CloseHandle(handle)
    except Exception:
        pass

# ── iRSDKヘッダー（バイトオフセット） ──
H_STATUS = 4
H_NUM_VARS = 24
H_VAR_HEADER_OFFSET = 28
H_NUM_BUF = 32
VARBUF_BASE = 48
VARBUF_STRIDE = 16
VAR_HEADER_SIZE = 144
VAR_NAME_OFF = 16   # name(32) の開始位置
VAR_DESC_OFF = 48   # desc(64) の開始位置 = name_off(16) + 32
VAR_UNIT_OFF = 112  # unit(32) の開始位置 = desc_off(48) + 64

# 変数の型番号 → 読み方（0=char,1=bool,2=int,3=bitField,4=float,5=double）
TYPE_NAMES = {0: 'char', 1: 'bool', 2: 'int', 3: 'bitField', 4: 'float', 5: 'double'}
TYPE_SIZE = {0: 1, 1: 1, 2: 4, 3: 4, 4: 4, 5: 8}
TYPE_FMT = {0: 'b', 1: '?', 2: 'i', 3: 'I', 4: 'f', 5: 'd'}


def read_int_at(ptr, off):
    return struct.unpack('i', ctypes.string_at(ptr + off, 4))[0]


def get_buf_offset(ptr):
    """最新tickのvarBufオフセットとそのtickを返す。

    numBufの誤読による無制限ループを避けるため常に min(num_buf, 4) に丸める
    （varBufスロットはiRSDK仕様上4本まで）。
    Returns: (best_off, best_tick)
    """
    num_buf = read_int_at(ptr, H_NUM_BUF)
    best_tick, best_off = -1, 0
    for i in range(min(max(num_buf, 0), 4)):
        base = VARBUF_BASE + i * VARBUF_STRIDE
        tick = read_int_at(ptr, base)
        off = read_int_at(ptr, base + 4)
        if tick > best_tick:
            best_tick, best_off = tick, off
    return best_off, best_tick


def build_index(ptr):
    """変数名 -> (type, offset, count) の索引を作る。"""
    idx = {}
    num_vars = read_int_at(ptr, H_NUM_VARS)
    hdr = read_int_at(ptr, H_VAR_HEADER_OFFSET)
    for i in range(num_vars):
        base = hdr + i * VAR_HEADER_SIZE
        vh = ctypes.string_at(ptr + base, VAR_HEADER_SIZE)
        if len(vh) < VAR_HEADER_SIZE:
            break
        vtype = struct.unpack_from('i', vh, 0)[0]
        voff = struct.unpack_from('i', vh, 4)[0]
        vcount = struct.unpack_from('i', vh, 8)[0]
        name = vh[VAR_NAME_OFF:VAR_NAME_OFF + 32].split(b'\x00')[0].decode('utf-8', 'ignore')
        if name:
            idx[name] = (vtype, voff, vcount)
    return idx
