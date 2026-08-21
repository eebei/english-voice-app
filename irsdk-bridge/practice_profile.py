"""Read a driver's own iRacing IBT session into a small, local practice profile.

This module intentionally does not upload raw telemetry or access VRS.  It reads
only a user-selected file and returns coarse, reviewable facts needed by PITWALL:
session identity, a setup fingerprint, temperature range, and lap-time band.
"""

import argparse
import hashlib
import json
import math
import os
import statistics
import struct
import sys

MAX_FILE_BYTES = 1024 * 1024 * 1024
HEADER_SIZE = 112
VAR_HEADER_SIZE = 144
H_SESSION_INFO_LEN = 16
H_SESSION_INFO_OFFSET = 20
H_NUM_VARS = 24
H_VAR_HEADER_OFFSET = 28
H_BUF_LEN = 36
VARBUF_BASE = 48
VAR_NAME_OFF = 16
TYPE_SIZE = {0: 1, 1: 1, 2: 4, 3: 4, 4: 4, 5: 8}
TYPE_FMT = {0: 'b', 1: '?', 2: 'i', 3: 'I', 4: 'f', 5: 'd'}


class ProfileImportError(ValueError):
    pass


def _i32(raw, offset):
    if offset < 0 or offset + 4 > len(raw):
        raise ProfileImportError('invalid_ibt_header')
    return struct.unpack_from('<i', raw, offset)[0]


def _clean(value):
    return str(value or '').strip().strip('"').strip("'")


def _canonical(value):
    return ' '.join(_clean(value).lower().split())


def _fingerprint(value):
    if not value:
        return None
    serialized = value if isinstance(value, str) else json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
    return hashlib.sha256(serialized.encode('utf-8')).hexdigest()[:16]


def _identity_from_yaml_text(text):
    lines = text.splitlines()
    def first_value(key):
        for line in lines:
            if line.strip().startswith(key + ':'):
                return _clean(line.split(':', 1)[1])
        return ''
    try:
        player_idx = int(first_value('DriverCarIdx'))
    except Exception:
        player_idx = -1
    player, active = {}, False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('- CarIdx:'):
            if active:
                break
            try:
                active = int(stripped.split(':', 1)[1]) == player_idx
            except Exception:
                active = False
            continue
        if active and stripped.startswith('CarScreenName:'):
            player['car_model'] = _clean(stripped.split(':', 1)[1])
        if active and stripped.startswith('CarClassShortName:'):
            player['car_class'] = _clean(stripped.split(':', 1)[1])
    setup_lines, in_setup = [], False
    for line in lines:
        if line.strip().startswith('CarSetup:'):
            in_setup = True
        if in_setup:
            if line and not line[0].isspace() and ':' in line and not line.strip().startswith('CarSetup:'):
                break
            setup_lines.append(line.rstrip())
    return {
        'track': first_value('TrackDisplayName') or first_value('TrackName'),
        'car_model': player.get('car_model', ''), 'car_class': player.get('car_class', ''),
        'session_type': first_value('SessionType') or 'unknown',
        'setup_fingerprint': _fingerprint('\n'.join(setup_lines)) if len(setup_lines) > 1 else None,
        'setup_available': len(setup_lines) > 1,
    }


def _read_variables(raw):
    num_vars = _i32(raw, H_NUM_VARS)
    var_off = _i32(raw, H_VAR_HEADER_OFFSET)
    if not 0 < num_vars <= 4096 or not HEADER_SIZE <= var_off < len(raw):
        raise ProfileImportError('invalid_ibt_variables')
    result = {}
    for index in range(num_vars):
        start = var_off + index * VAR_HEADER_SIZE
        if start + VAR_HEADER_SIZE > len(raw):
            break
        kind, offset, count = struct.unpack_from('<iii', raw, start)
        if kind not in TYPE_SIZE or offset < 0 or count < 1 or count > 65536:
            continue
        name = raw[start + VAR_NAME_OFF:start + VAR_NAME_OFF + 32].split(b'\0')[0].decode('utf-8', 'replace')
        if name:
            result[name] = (kind, offset, count)
    return result


def _series_values(raw, variables, data_offset, row_size, name, max_points=720):
    descriptor = variables.get(name)
    if not descriptor or row_size <= 0:
        return []
    kind, offset, count = descriptor
    if count != 1 or offset + TYPE_SIZE[kind] > row_size:
        return []
    records = max(0, (len(raw) - data_offset) // row_size)
    if records <= 0:
        return []
    stride = max(1, math.ceil(records / max_points))
    values = []
    for row in range(0, records, stride):
        pos = data_offset + row * row_size + offset
        if pos + TYPE_SIZE[kind] > len(raw):
            break
        value = struct.unpack_from('<' + TYPE_FMT[kind], raw, pos)[0]
        if isinstance(value, (int, float)) and math.isfinite(value):
            values.append(float(value))
    return values


def _summary(values, minimum=0.0, maximum=100000.0):
    kept = [v for v in values if minimum <= v <= maximum]
    if not kept:
        return {'available': False}
    return {
        'available': True,
        'sample_count': len(kept),
        'min': round(min(kept), 3),
        'median': round(statistics.median(kept), 3),
        'max': round(max(kept), 3),
    }


def read_ibt_profile(path, setup_path=None):
    if not isinstance(path, str) or not path.lower().endswith('.ibt'):
        raise ProfileImportError('select_an_ibt_file')
    if not os.path.isfile(path) or os.path.getsize(path) > MAX_FILE_BYTES:
        raise ProfileImportError('invalid_ibt_file')
    with open(path, 'rb') as handle:
        raw = handle.read()
    if len(raw) < HEADER_SIZE:
        raise ProfileImportError('invalid_ibt_file')
    si_len, si_off = _i32(raw, H_SESSION_INFO_LEN), _i32(raw, H_SESSION_INFO_OFFSET)
    if si_len <= 0 or si_off < HEADER_SIZE or si_off + si_len > len(raw):
        raise ProfileImportError('missing_session_info')
    session_text = raw[si_off:si_off + si_len].decode('utf-8', 'replace')
    identity = _identity_from_yaml_text(session_text)
    if setup_path:
        if not isinstance(setup_path, str) or not setup_path.lower().endswith('.sto') or not os.path.isfile(setup_path):
            raise ProfileImportError('invalid_sto_file')
        try:
            with open(setup_path, 'r', encoding='utf-8-sig') as handle:
                setup = handle.read().strip()
        except Exception as exc:
            raise ProfileImportError('invalid_sto_file') from exc
        if not setup:
            raise ProfileImportError('invalid_sto_file')
        identity['setup_fingerprint'] = _fingerprint(setup)
        identity['setup_available'] = True
        identity['setup_source'] = 'selected_sto'
    else:
        identity['setup_source'] = 'ibt_session_info' if identity['setup_available'] else 'unavailable'

    variables = _read_variables(raw)
    row_size = _i32(raw, H_BUF_LEN)
    data_offset = _i32(raw, VARBUF_BASE + 4)
    if data_offset < HEADER_SIZE or data_offset >= len(raw) or row_size <= 0 or row_size > 1024 * 1024:
        data_offset, row_size = 0, 0
    temperatures = _series_values(raw, variables, data_offset, row_size, 'TrackTempCrew')
    if not temperatures:
        temperatures = _series_values(raw, variables, data_offset, row_size, 'TrackTemp')
    laps = _series_values(raw, variables, data_offset, row_size, 'LapLastLapTime')
    lap_summary = _summary(laps, minimum=20.0, maximum=1000.0)
    return {
        'schema_version': 1,
        'source': {'kind': 'user_selected_ibt', 'file_name': os.path.basename(path)},
        'identity': identity,
        'practice_track_temp_c': _summary(temperatures, minimum=-30.0, maximum=100.0),
        'practice_lap_time_s': lap_summary,
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--setup')
    parser.add_argument('ibt_path')
    args = parser.parse_args(argv)
    try:
        result = read_ibt_profile(args.ibt_path, args.setup)
        print(json.dumps({'ok': True, 'profile': result}, ensure_ascii=False))
        return 0
    except ProfileImportError as exc:
        print(json.dumps({'ok': False, 'reason': str(exc)}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
