"""
OMORAY PITWALL - 戦略エンジン用 時系列ロガー（Phase A2・2026-07-21）

【目的】
  単発ダンプでは「変数が存在するか・型・その瞬間の値」しか分からない。
  復帰順位の計算に使う CarIdxF2Time が、次の状況で**どう振る舞うか**を確定させる：
    ・通常走行
    ・周回遅れ／周回上げが混在
    ・他車がピット中
    ・S/Fライン通過の前後
  また、ピットサービスの状態遷移（設定前／開始／作業中／終了／退出後）を記録する。

【なぜ必要か】
  同クラスの「現在ギャップ」に使えていることと、「未来の復帰順位を全車比較で出せる」ことは
  別の保証である。ここを推測で実装すると、2026-07-20 に実際に起きた
  「LapDistPct の符号を物理から推測して出荷し、迫る車を捨てて抜かれた車を警告していた」
  のと同種の事故になる。**実測してから式を決める。**

【使い方】
  1. iRacing でレースセッションに出走する（他車が居ること。AIレースでよい）
  2. python log_strategy_timeseries.py
  3. Ctrl+C で終了。strategy_ts-<日時>.csv が出る
  4. ピットにも1回入ること（サービス状態遷移の記録に必要）

【2026-07-21 訂正】
  「変数が存在するか」は 2026-07-06 の実機ダンプで既に確定している
  （PitSvFuel / PitSvLFP等 / PitstopActive / SessionLapsRemainEx すべて存在）。
  よって本ツールの目的は実在確認ではなく、**挙動と状態遷移の観測**である：
    ・CarIdxF2Time が周回遅れ混在・ピット中・S/F通過でどう振る舞うか
    ・PitSvFuel がいつ確定し、PitstopActive がいつ立つか

※読み取り専用。iRacing には一切書き込まない（bridge.py / dump_all_vars.py と同じ方式）。
"""

import ctypes
import struct
import time
import csv
import os
import sys

IRSDK_MEMMAPFILE = "Local\\IRSDKMemMapFileName"
MEM_SIZE = 1164 * 1024
H_STATUS = 8
H_NUM_VARS = 20
H_VAR_HEADER_OFFSET = 24
H_BUF_COUNT = 28
H_BUF_LEN = 32
H_BUF_OFFSET = 52
VAR_HEADER_SIZE = 144
VAR_NAME_OFF = 16

# 型: 0=char 1=bool 2=int 3=bitField 4=float 5=double
FMT = {0: ('b', 1), 1: ('b', 1), 2: ('i', 4), 3: ('i', 4), 4: ('f', 4), 5: ('d', 8)}

# ★Yuji指示：同時刻に並べて記録する配列変数
CAR_ARRAYS = [
    'CarIdxF2Time',
    'CarIdxClassPosition',
    'CarIdxLap',
    'CarIdxLapDistPct',
    'CarIdxOnPitRoad',
    'CarIdxTrackSurface',
]
# 自車のピットサービス状態遷移を追うスカラー変数
SELF_SCALARS = [
    'SessionTime', 'SessionNum', 'Lap', 'LapDistPct', 'PlayerCarIdx',
    'OnPitRoad', 'PlayerTrackSurface', 'PlayerCarPitSvStatus',
    'PitRepairLeft', 'PitOptRepairLeft', 'PitsOpen', 'Speed', 'FuelLevel',
]
# ★2026-07-21 訂正：これらは 2026-07-06 の実機ダンプで**存在が既に確定済み**
#   （PitSvFuel=給油予定量 / PitSvLFP等=各輪注入圧＝タイヤ交換の判別 /
#     PitstopActive / SessionLapsRemainEx）。
#   よってここでの目的は「在るか」ではなく **いつ値が確定し、どう遷移するか** の観測。
#   起動時に一度スナップショットを表示し、以降は毎行CSVへ記録して遷移を追う。
PIT_SERVICE_VARS = [
    'PitSvFuel',                                    # 給油予定量（いつ確定するか）
    'PitSvLFP', 'PitSvRFP', 'PitSvLRP', 'PitSvRRP',  # 各輪注入圧（タイヤ交換の有無を示す）
    'PitSvFlags', 'PitstopActive',
    'SessionTimeRemain', 'SessionLapsRemain', 'SessionLapsRemainEx',
    'FuelUsePerHour',
]


def open_mem():
    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    k32.OpenFileMappingW.restype = ctypes.c_void_p
    k32.MapViewOfFile.restype = ctypes.c_void_p
    h = k32.OpenFileMappingW(0x0004, False, IRSDK_MEMMAPFILE)
    if not h:
        return k32, None, None
    ptr = k32.MapViewOfFile(ctypes.c_void_p(h), 0x0004, 0, 0, MEM_SIZE)
    return k32, h, ptr


def read_int_at(ptr, off):
    return struct.unpack('i', ctypes.string_at(ptr + off, 4))[0]


def get_buf_offset(ptr):
    n = read_int_at(ptr, H_BUF_COUNT)
    best_tick, best_off = -1, None
    for i in range(max(1, n)):
        base = H_BUF_OFFSET + i * 16
        tick = read_int_at(ptr, base)
        off = read_int_at(ptr, base + 4)
        if tick > best_tick:
            best_tick, best_off = tick, off
    return best_off


def build_index(ptr):
    """変数名 -> (type, offset, count) の索引を1回だけ作る。"""
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


def read_val(ptr, buf_off, info, i=0):
    vtype, voff, vcount = info
    f = FMT.get(vtype)
    if not f:
        return None
    fmt, size = f
    if i >= vcount:
        return None
    return struct.unpack(fmt, ctypes.string_at(ptr + buf_off + voff + i * size, size))[0]


def main():
    k32, h, ptr = open_mem()
    if not ptr:
        print("❌ iRacingが起動していません。")
        return
    if read_int_at(ptr, H_STATUS) != 1:
        print("⚠️ テレメトリ非アクティブ。コースに出走してから実行してください。")

    idx = build_index(ptr)
    print(f"✅ 接続。公開変数 {len(idx)} 個")

    # ── まず「存在するか」を1回だけ報告（提案書が前提にしている変数の実在確認）──
    print("\n── ピットサービス変数の起動時スナップショット（存在は7/6ダンプで確定済み）──")
    for nm in PIT_SERVICE_VARS:
        if nm in idx:
            t, o, c = idx[nm]
            print(f"  ✅ {nm:24} type={t} count={c}  値={read_val(ptr, get_buf_offset(ptr), idx[nm])}")
        else:
            print(f"  ❌ {nm:24} 存在しない")

    stamp = time.strftime('%Y%m%d-%H%M%S')
    label = (sys.argv[1] if len(sys.argv) > 1 else '').strip()
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        f'strategy_ts-{stamp}{("-" + label) if label else ""}.csv')

    cols = (['wall_clock'] + SELF_SCALARS + PIT_SERVICE_VARS
            + [f'{a}[{i}]' for a in CAR_ARRAYS for i in range(64)])
    n = 0
    print(f"\n記録開始 → {os.path.basename(path)}   （Ctrl+C で終了）")
    print("  ※ 周回遅れ混在・他車ピット中・S/F通過を含むよう、数周は走ってください")
    try:
        with open(path, 'w', encoding='utf-8', newline='') as fp:
            w = csv.writer(fp)
            w.writerow(cols)
            while True:
                buf_off = get_buf_offset(ptr)
                row = [time.strftime('%H:%M:%S') + f'.{int(time.time()*10)%10}']
                for nm in SELF_SCALARS + PIT_SERVICE_VARS:
                    row.append(read_val(ptr, buf_off, idx[nm]) if nm in idx else '')
                for arr in CAR_ARRAYS:
                    info = idx.get(arr)
                    for i in range(64):
                        row.append(read_val(ptr, buf_off, info, i) if info else '')
                w.writerow(row)
                n += 1
                if n % 50 == 0:
                    fp.flush()
                    print(f"  {n} 行  ({row[0]})", end='\r')
                time.sleep(0.2)          # 5Hz。F2Timeの不連続を捉えるには十分
    except KeyboardInterrupt:
        pass
    finally:
        print(f"\n✅ {n} 行を保存: {path}")
        try:
            k32.UnmapViewOfFile(ctypes.c_void_p(ptr))
            k32.CloseHandle(h)
        except Exception:
            pass


if __name__ == '__main__':
    main()
