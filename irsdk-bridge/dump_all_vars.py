"""
OMORAY PITWALL - iRacing SDK 全変数ダンプツール
目的: iRacingが実際に公開している全テレメトリ変数を現物で確認する。
      特に他車データ(CarIdx*)にブレーキ/スロットルがあるか、
      自車のBrake/Throttle/Steeringが取れるかを事実で確定させる。

使い方:
  1. iRacingでテストドライブ等に出走し、コース上を走行する(OnTrack状態にする)
  2. このスクリプトを実行: python dump_all_vars.py
  3. 同じフォルダに all_vars_dump-<日時>[-ラベル].txt / .csv が出る（過去分を上書きしない）
     ラベル付き実行例: python dump_all_vars.py before-service
  4. そのテキストをClaudeに渡せば全変数が読める

※読み取り専用。iRacingには一切書き込まない(bridge.pyと同じ方式)。
"""

import ctypes
import struct
import time
import csv
import re
import os
import sys

# ★2026-07-21（Codexレビュー P0-2）：ヘッダー定数・共有メモリreaderは irsdk_mem.py が唯一の真実源。
#   独自のOpenFileMappingW/MapViewOfFile実装はargtypes欠落によるFFI破損の危険があるため使わない。
from irsdk_mem import (
    H_STATUS, H_NUM_VARS, H_VAR_HEADER_OFFSET,
    VAR_HEADER_SIZE,
    VAR_NAME_OFF, VAR_DESC_OFF, VAR_UNIT_OFF,
    TYPE_NAMES, TYPE_SIZE, TYPE_FMT,
    read_int_at,
    open_shared_mem,
    close_shared_mem,
    get_buf_offset as _shared_get_buf_offset,
)


def open_mem():
    """後方互換のラッパー。実体は irsdk_mem.open_shared_mem()。"""
    return open_shared_mem()


def get_buf_offset(ptr):
    off, _tick = _shared_get_buf_offset(ptr)
    return off


def decode_str(raw):
    return raw.split(b'\x00')[0].decode('utf-8', errors='ignore')


def dump():
    k32, h, ptr = open_mem()
    if not ptr:
        print("❌ iRacingが起動していません。iRacingを起動してコースに出てから実行してください。")
        return

    status = read_int_at(ptr, H_STATUS)
    if status != 1:
        print(f"⚠️ iRacingは起動中だがテレメトリ非アクティブ(status={status})。コースに出走してから実行してください。")
        # それでも変数リストは取れるので続行

    num_vars = read_int_at(ptr, H_NUM_VARS)
    var_hdr_off = read_int_at(ptr, H_VAR_HEADER_OFFSET)
    buf_off = get_buf_offset(ptr)

    print(f"✅ iRacing接続。公開変数数: {num_vars}")
    print(f"   全変数をダンプ中...\n")

    rows = []
    for i in range(num_vars):
        base = var_hdr_off + i * VAR_HEADER_SIZE
        vh = ctypes.string_at(ptr + base, VAR_HEADER_SIZE)
        if len(vh) < VAR_HEADER_SIZE:
            break
        vtype = struct.unpack_from('i', vh, 0)[0]
        voffset = struct.unpack_from('i', vh, 4)[0]
        vcount = struct.unpack_from('i', vh, 8)[0]
        name = decode_str(vh[VAR_NAME_OFF:VAR_NAME_OFF + 32])
        desc = decode_str(vh[VAR_DESC_OFF:VAR_DESC_OFF + 64])
        unit = decode_str(vh[VAR_UNIT_OFF:VAR_UNIT_OFF + 32])
        if not name:
            continue

        # 現在値を読む(配列なら先頭の数個)
        val_str = ''
        try:
            fmt = TYPE_FMT.get(vtype)
            size = TYPE_SIZE.get(vtype, 4)
            if fmt:
                n_read = min(vcount, 4)  # 配列は先頭4つだけプレビュー
                data = ctypes.string_at(ptr + buf_off + voffset, size * n_read)
                vals = struct.unpack(fmt * n_read, data)
                if vcount > 4:
                    val_str = ', '.join(str(round(v, 3) if isinstance(v, float) else v) for v in vals) + f', ...({vcount} total)'
                else:
                    val_str = ', '.join(str(round(v, 3) if isinstance(v, float) else v) for v in vals)
        except Exception as e:
            val_str = f'<read error: {e}>'

        rows.append({
            'name': name,
            'type': TYPE_NAMES.get(vtype, f'?{vtype}'),
            'count': vcount,
            'unit': unit,
            'value': val_str,
            'desc': desc,
        })

    rows.sort(key=lambda r: r['name'].lower())

    base_dir = os.path.dirname(os.path.abspath(sys.argv[0])) or '.'
    # ★2026-07-21 上書き防止：実行のたびに日時入りで保存する。
    #   戦略エンジンの設計根拠として「いつ・どの状態で採った値か」が証拠になるため、
    #   過去のダンプを失ってはいけない（Yuji指示）。
    _stamp = time.strftime('%Y%m%d-%H%M%S')
    _label = (sys.argv[1] if len(sys.argv) > 1 else '').strip()
    _suffix = ('-' + re.sub(r'[^A-Za-z0-9_-]', '', _label)) if _label else ''
    txt_path = os.path.join(base_dir, f'all_vars_dump-{_stamp}{_suffix}.txt')
    csv_path = os.path.join(base_dir, f'all_vars_dump-{_stamp}{_suffix}.csv')

    # テキスト出力(Claudeに貼りやすい)
    with open(txt_path, 'w', encoding='utf-8') as f:
        f.write(f"=== iRacing SDK 全公開変数ダンプ ({len(rows)}個) ===\n")
        f.write(f"生成: {time.strftime('%Y-%m-%d %H:%M:%S')}\n\n")

        # ★ドライビング解析に重要な変数を先頭にハイライト
        key_names = ['Brake', 'BrakeRaw', 'Throttle', 'ThrottleRaw', 'Clutch',
                     'SteeringWheelAngle', 'Gear', 'RPM', 'Speed', 'LapDistPct',
                     'CarIdxBrake', 'CarIdxThrottle', 'CarIdxSteer', 'CarIdxGear',
                     'CarIdxRPM', 'CarIdxLapDistPct', 'CarIdxLastLapTime', 'CarIdxF2Time']
        f.write("──────────────────────────────────────────\n")
        f.write("【ドライビング解析キー変数の有無チェック】\n")
        f.write("──────────────────────────────────────────\n")
        found_names = {r['name'] for r in rows}
        for kn in key_names:
            mark = '✅ある' if kn in found_names else '❌ない'
            f.write(f"  {mark:8} {kn}\n")
        f.write("\n\n")

        f.write("──────────────────────────────────────────\n")
        f.write("【全変数リスト(アルファベット順)】\n")
        f.write("──────────────────────────────────────────\n")
        for r in rows:
            arr = f"[{r['count']}]" if r['count'] > 1 else ''
            f.write(f"{r['name']}{arr}  ({r['type']}, {r['unit']})\n")
            f.write(f"    値: {r['value']}\n")
            if r['desc']:
                f.write(f"    説明: {r['desc']}\n")
            f.write("\n")

    # CSV出力
    with open(csv_path, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['name', 'type', 'count', 'unit', 'value', 'desc'])
        w.writeheader()
        w.writerows(rows)

    print(f"✅ 完了！ {len(rows)}個の変数をダンプしました。")
    print(f"   → {txt_path}")
    print(f"   → {csv_path}")
    print(f"\n   {os.path.basename(txt_path)} をClaudeに渡してください。")

    # コンソールにもキー変数チェックを即表示
    print("\n【ドライビング解析キー変数の有無】")
    found_names = {r['name'] for r in rows}
    for kn in ['Brake', 'Throttle', 'SteeringWheelAngle',
               'CarIdxBrake', 'CarIdxThrottle', 'CarIdxLapDistPct', 'CarIdxLastLapTime']:
        mark = '✅ある' if kn in found_names else '❌ない'
        print(f"  {mark:8} {kn}")

    close_shared_mem(k32, h, ptr)


if __name__ == '__main__':
    dump()
