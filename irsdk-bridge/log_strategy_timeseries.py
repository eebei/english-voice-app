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

# ★2026-07-21（Codexレビュー P0-2）：このファイルは独自のヘッダーオフセットと独自のWindows FFI
#   （OpenFileMappingW/MapViewOfFile、argtypes未指定）を使っており、
#   ①実走済みの bridge.py / dump_all_vars.py とオフセット値がズレていた（H_STATUS=8 vs 4 等）
#   ②argtypes未指定はctypesがポインタ/HANDLE引数を既定のc_intとしてマーシャリングし、
#     64bit環境で値が壊れうる欠陥だった。
#   共有モジュール irsdk_mem.py を単一の真実源として import する。
from irsdk_mem import (
    H_STATUS,
    read_int_at,
    get_buf_offset,
    build_index,
    open_shared_mem,
    close_shared_mem,
)

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
# ★P1-1（Codexレビュー）：SessionState も保存する（セッション遷移の切り分けに使う）。
SELF_SCALARS = [
    'SessionTime', 'SessionNum', 'SessionState', 'Lap', 'LapDistPct', 'PlayerCarIdx',
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


def read_val(ptr, buf_off, info, i=0):
    vtype, voff, vcount = info
    f = FMT.get(vtype)
    if not f:
        return None
    fmt, size = f
    if i >= vcount:
        return None
    return struct.unpack(fmt, ctypes.string_at(ptr + buf_off + voff + i * size, size))[0]


# ★P1-1（Codexレビュー）：ring bufferは高頻度で書き換わる。読取前後でtickが変われば、
#   その行はtickをまたいで混ざった値（＝異なる時刻のF2Time/順位/LapDistPctの混在）なので破棄する。
#   同一tickで読み切れた行だけをCSVへ書く。
MAX_TICK_RETRY = 5


def read_row(ptr, idx):
    """1行分を同一tickスナップショットから読む。読取中にbufferが切り替わったら再試行する。
    Returns: (self_vals: dict, car_vals: dict, tick:int) または、既定回数とも不整合なら None。
    """
    for _attempt in range(MAX_TICK_RETRY):
        buf_off, tick_before = get_buf_offset(ptr)
        self_vals = {nm: (read_val(ptr, buf_off, idx[nm]) if nm in idx else '')
                     for nm in SELF_SCALARS + PIT_SERVICE_VARS}
        car_vals = {arr: [read_val(ptr, buf_off, idx.get(arr), i) if arr in idx else '' for i in range(64)]
                    for arr in CAR_ARRAYS}
        _, tick_after = get_buf_offset(ptr)
        if tick_after == tick_before:
            return self_vals, car_vals, tick_before
    return None


def main():
    k32, h, ptr = open_shared_mem()
    if not ptr:
        print("❌ iRacingが起動していません。")
        return
    if read_int_at(ptr, H_STATUS) != 1:
        print("⚠️ テレメトリ非アクティブ。コースに出走してから実行してください。")

    idx = build_index(ptr)
    print(f"✅ 接続。公開変数 {len(idx)} 個")

    # ── まず「存在するか」を1回だけ報告（提案書が前提にしている変数の実在確認）──
    print("\n── ピットサービス変数の起動時スナップショット（存在は7/6ダンプで確定済み）──")
    _snap_off, _snap_tick = get_buf_offset(ptr)
    for nm in PIT_SERVICE_VARS:
        if nm in idx:
            t, o, c = idx[nm]
            print(f"  ✅ {nm:24} type={t} count={c}  値={read_val(ptr, _snap_off, idx[nm])}")
        else:
            print(f"  ❌ {nm:24} 存在しない")

    stamp = time.strftime('%Y%m%d-%H%M%S')
    label = (sys.argv[1] if len(sys.argv) > 1 else '').strip()
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        f'strategy_ts-{stamp}{("-" + label) if label else ""}.csv')

    # tickを列頭に置く。読取前後で不変だったスナップショットの識別子（同一tick保証の証拠）。
    # ★P2（Codex指示・2026-07-21）：event列を追加。SessionNum変更／tick巻き戻りを区間イベントとして
    #   その行にだけ記録する（通常行はevent=''）。
    cols = (['wall_clock', 'tick', 'event'] + SELF_SCALARS + PIT_SERVICE_VARS
            + [f'{a}[{i}]' for a in CAR_ARRAYS for i in range(64)])
    n = 0                # 書き込んだ行数
    dropped = 0          # tick不整合(読取前後でtickが変わった)で破棄した行数
    inactive_skipped = 0  # telemetry非アクティブでCSVへ書かなかった回数
    duplicate_skipped = 0  # 直前と同一tickだったため書かなかった回数
    last_written_tick = None
    last_session_num = None
    print(f"\n記録開始 → {os.path.basename(path)}   （Ctrl+C で終了）")
    print("  ※ 周回遅れ混在・他車ピット中・S/F通過を含むよう、数周は走ってください")
    try:
        with open(path, 'w', encoding='utf-8', newline='') as fp:
            w = csv.writer(fp)
            w.writerow(cols)
            while True:
                # ★P2：telemetry非アクティブなら書かない（ガレージ待機中の無意味な固定値行を防ぐ）。
                if read_int_at(ptr, H_STATUS) != 1:
                    inactive_skipped += 1
                    time.sleep(0.2)
                    continue

                result = read_row(ptr, idx)
                if result is None:
                    dropped += 1
                    time.sleep(0.2)
                    continue
                self_vals, car_vals, tick = result

                # ★P2：直前と同一tickなら重複行として書かない（iRacingが同じフレームをまだ
                #   更新していないだけ・DEBRIEF直後のガレージ待機等で頻発する）。
                if last_written_tick is not None and tick == last_written_tick:
                    duplicate_skipped += 1
                    time.sleep(0.2)
                    continue

                # ★P2：SessionNum変更／tick巻き戻りは区間イベントとして「その行にだけ」記録する。
                event = ''
                cur_session_num = self_vals.get('SessionNum')
                if last_session_num is not None and cur_session_num != last_session_num:
                    event = 'session_num_change'
                elif last_written_tick is not None and tick < last_written_tick:
                    event = 'tick_rollback'
                last_session_num = cur_session_num
                last_written_tick = tick

                row = [time.strftime('%H:%M:%S') + f'.{int(time.time()*10)%10}', tick, event]
                row += [self_vals[nm] for nm in SELF_SCALARS + PIT_SERVICE_VARS]
                for arr in CAR_ARRAYS:
                    row += car_vals[arr]
                w.writerow(row)
                n += 1
                if n % 50 == 0:
                    fp.flush()
                    print(f"  {n} 行  ({row[0]}, tick={tick}, 破棄={dropped}, 非アクティブ省略={inactive_skipped}, 重複省略={duplicate_skipped})", end='\r')
                time.sleep(0.2)          # 5Hz。F2Timeの不連続を捉えるには十分
    except KeyboardInterrupt:
        pass
    finally:
        print(f"\n✅ 書込={n}行  tick不整合破棄={dropped}行  非アクティブ省略={inactive_skipped}行  重複tick省略={duplicate_skipped}行")
        print(f"   保存先: {path}")
        close_shared_mem(k32, h, ptr)


if __name__ == '__main__':
    main()
