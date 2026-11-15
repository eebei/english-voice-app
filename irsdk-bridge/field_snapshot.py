"""U1 — 全車スナップショット（STR-001 / 設計§24.13-§24.14）。

目的：ピット復帰先の前後車列（全車の位置・クラス・周回・ペース・ピット状態）を、後から再計算・検証できる形で記録し、
同じ内容を Desktop(Renderer) へ送る。計算（U2〜U4）はここでは行わない。

契約（§24.14）
  * 1 snapshot = 1 frame 世代：CarIdx* 配列を同じ shared-memory バッファ(tick)から読む。読取中に世代が変わった／
    世代を保証できない reader の時は `ok:false`（`gen:'mixed'|'unverified'`）で記録し、有効観測としては送らない・使わない。
  * 未知値は null。離脱車（TrackSurface=-1 / NotInWorld）と欠測（配列が取れない・範囲外）を区別する。
  * race / session / Bridge epoch / frame 番号 / session 時刻 / 観測時刻 / 自車ID / 収録対象台数・観測台数・離脱・欠測 を持つ。
  * 個人名・認証値は入れない（car_idx・ゼッケン・class_id のみ）。
  * 記録頻度：1Hz ＋ イベント（新しいラップ／ピット状態変化／車の出入り／session境界）。時間精度は「標本間隔」であり、
    1Hz の標本から精密なピット停止時間を実測したとは言わない（`sample_interval_s` を各行に記録）。
  * 記録は別スレッド＋有界キュー。書込み失敗・容量不足・遅延で poll ループ（安全コール配送）を待たせない。
    上限：1ファイル FILE_MAX_BYTES、1実行 RUN_SOFT_BYTES 超で間引き、RUN_HARD_BYTES 超で停止（冒頭は消さない）。
"""
import json
import os
import queue
import threading
import time

SCHEMA = 'field_snapshot'
SCHEMA_VERSION = 1

FLOAT_ARRAYS = ('CarIdxLapDistPct', 'CarIdxF2Time', 'CarIdxEstTime', 'CarIdxLastLapTime')
INT_ARRAYS = ('CarIdxPosition', 'CarIdxClassPosition', 'CarIdxLap', 'CarIdxLapCompleted', 'CarIdxOnPitRoad', 'CarIdxTrackSurface')
ARRAY_NAMES = INT_ARRAYS + FLOAT_ARRAYS
MAX_CARS = 64

# 1行あたりの車レコードのキー（ヘッダ行に凡例を書く）
CAR_FIELDS = {
    'i': 'car_idx', 'no': 'car_number', 'c': 'class_id', 'p': 'overall_position', 'cp': 'class_position',
    'l': 'lap', 'lc': 'lap_completed', 'd': 'lap_dist_pct', 'f2': 'f2_time_s', 'est': 'est_time_s',
    'll': 'last_lap_s', 'pit': 'on_pit_road', 's': 'track_surface', 'st': 'state',
    'r': 'role(car=競技車/pace=ペースカー/spec=観戦者。counts.target等は競技車のみ)',
}
ROLES = ('car', 'pace', 'spec')
SURFACE_NOT_IN_WORLD = -1

INTERVAL_S = 1.0           # 周期記録
MIN_EVENT_GAP_S = 0.25     # イベント記録の最短間隔（同時発生は1行にまとめる）
FILE_MAX_BYTES = 8 * 1024 * 1024
RUN_SOFT_BYTES = 80 * 1024 * 1024   # 超えたら周期記録を間引く（イベントは残す）。実測: 26台1Hzで約3.5KB/行→3時間で約38MB
RUN_HARD_BYTES = 128 * 1024 * 1024  # 超えたら停止（冒頭は消さない）
DECIMATE_EVERY = 5
KEEP_RUNS = 30             # フォルダに残す過去ファイル数（古いものから削除。本機能が作ったファイルだけ）
QUEUE_MAX = 256


def _num(value, lo=None, hi=None, digits=None):
    """有限な数値だけを返す。範囲外・非数・未取得は None。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    v = float(value)
    if v != v or v in (float('inf'), float('-inf')):
        return None
    if lo is not None and v < lo:
        return None
    if hi is not None and v > hi:
        return None
    return round(v, digits) if digits is not None else v


def _int(value, lo=None, hi=None):
    v = _num(value, lo, hi)
    return None if v is None else int(v)


def roster_from_drivers(drivers):
    """SessionInfoの Drivers 配列から、この解析1回分の名簿を**作り直す**（前回のentryを引き継がない）。
    個人名・認証値は持たない。role は 競技車=car／ペースカー=pace／観戦者=spec。"""
    out = {}
    for d in drivers or []:
        i = d.get('car_idx')
        if not isinstance(i, int) or isinstance(i, bool) or not (0 <= i < MAX_CARS):
            continue
        role = 'pace' if d.get('pace_car') else ('spec' if d.get('spectator') == 1 else 'car')
        out[i] = {'number': d.get('car_number'), 'class_id': d.get('class_id'), 'role': role}
    return out


def build_snapshot(*, arrays, generation, consistent, roster, player_idx, ctx, seq, events=(), interval_s=INTERVAL_S, roster_session_num=None, roster_update=None, roster_confirmed=None):
    """CarIdx* 配列から1 snapshot を作る（純関数）。

    arrays: {name: list|None}
    generation: iRacing buffer tick（保証できない時は None）
    consistent: True=同一世代 / False=読取中に世代が変わった / None=世代を保証できないreader
    roster: {car_idx: {'number': str|None, 'class_id': int|None}}（SessionInfoの識別情報。個人名は入れない）
    ctx: {race_instance_id, session_num, epoch, frame_sequence, session_time_s, observed_at}
    roster_session_num: この名簿を解析した時点のSessionNum。いまのsession_numと違う/不明なら、車の識別(ゼッケン/クラス)を
        当該セッションのものと確認できないので `identity_stale`（ok=false）にする。
    roster_update: その名簿を読んだ時点の SessionInfo 更新番号（共有メモリheader）。読めなければ None。
    roster_confirmed: RosterTracker の判定。False なら（SessionNumが合っていても）名簿を現在のものと確認できない。None=従来のSessionNum規則のみ。
    """
    arrays = arrays or {}
    surf = arrays.get('CarIdxTrackSurface')
    target_idx = sorted(set(k for k in (roster or {}) if isinstance(k, int) and 0 <= k < MAX_CARS))
    # 名簿に無くても、世界にいる車（TrackSurface>=0）は記録対象に含める（名簿の取りこぼしで車を落とさない）
    if isinstance(surf, list):
        for i, s in enumerate(surf[:MAX_CARS]):
            if isinstance(s, (int, float)) and not isinstance(s, bool) and s >= 0 and i not in target_idx:
                target_idx.append(i)
        target_idx.sort()
    cars = []
    observed = departed = missing = 0
    for i in target_idx:
        def at(name, kind):
            arr = arrays.get(name)
            if not isinstance(arr, list) or i >= len(arr):
                return ('missing', None)
            return ('ok', arr[i])
        st_s, surface = at('CarIdxTrackSurface', int)
        surface = _int(surface) if st_s == 'ok' else None
        info = (roster or {}).get(i) or {}
        role = info.get('role') if info.get('role') in ROLES else 'car'
        rec = {'i': i, 'no': info.get('number'), 'c': info.get('class_id'), 'r': role}
        if surface == SURFACE_NOT_IN_WORLD:
            if role == 'car':
                departed += 1
            rec.update({'p': None, 'cp': None, 'l': None, 'lc': None, 'd': None, 'f2': None, 'est': None, 'll': None, 'pit': None, 's': surface, 'st': 'out'})
            cars.append(rec)
            continue
        needed = ('CarIdxPosition', 'CarIdxClassPosition', 'CarIdxLap', 'CarIdxLapCompleted', 'CarIdxLapDistPct', 'CarIdxOnPitRoad')
        absent = [n for n in needed if not isinstance(arrays.get(n), list) or i >= len(arrays[n])]
        def val(name):
            arr = arrays.get(name)
            return arr[i] if isinstance(arr, list) and i < len(arr) else None
        pit_raw = val('CarIdxOnPitRoad')
        rec.update({
            'p': _int(val('CarIdxPosition'), 1),                 # 0=未定義
            'cp': _int(val('CarIdxClassPosition'), 1),
            'l': _int(val('CarIdxLap'), 0),                      # -1=未取得
            'lc': _int(val('CarIdxLapCompleted'), 0),
            'd': _num(val('CarIdxLapDistPct'), 0.0, 1.0, 5),     # -1=未取得
            'f2': _num(val('CarIdxF2Time'), 0.0, None, 3),
            'est': _num(val('CarIdxEstTime'), 0.0, None, 3),
            'll': _num(val('CarIdxLastLapTime'), 1.0, 3600.0, 3),   # <=0 は未取得
            'pit': (1 if int(pit_raw) == 1 else 0) if (isinstance(pit_raw, (int, float)) and not isinstance(pit_raw, bool) and int(pit_raw) in (0, 1)) else None,
            's': surface,
        })
        if absent:
            if role == 'car':
                missing += 1
            rec['st'] = 'missing'
        else:
            if role == 'car':
                observed += 1
            rec['st'] = 'ok'
        cars.append(rec)
    identity_ok = isinstance(roster_session_num, int) and (ctx or {}).get('session_num') == roster_session_num and roster_confirmed is not False
    if consistent is True and not identity_ok:
        gen = 'identity_stale'      # 配列は同一世代だが、名簿(ゼッケン/クラス)が当該セッションのものと確認できない
    else:
        gen = 'consistent' if consistent is True else ('mixed' if consistent is False else 'unverified')
    ok = gen == 'consistent'
    snap = {
        'type': 'field_snapshot', 'schema_version': SCHEMA_VERSION, 'seq': seq,
        'race_instance_id': (ctx or {}).get('race_instance_id'), 'session_num': (ctx or {}).get('session_num'),
        'bridge_process_epoch': (ctx or {}).get('epoch'), 'source_frame_sequence': (ctx or {}).get('frame_sequence'),
        'session_time_s': _num((ctx or {}).get('session_time_s'), None, None, 3), 'observed_at': _num((ctx or {}).get('observed_at'), None, None, 3),
        'player_car_idx': player_idx if isinstance(player_idx, int) and player_idx >= 0 else None,
        'roster_session_num': roster_session_num if isinstance(roster_session_num, int) else None,
        'roster_update': roster_update if isinstance(roster_update, int) and not isinstance(roster_update, bool) else None,
        'generation': generation, 'gen': gen, 'ok': ok,
        'sample_interval_s': interval_s,
        'counts': {'target': observed + departed + missing, 'observed': observed, 'departed': departed, 'missing': missing,
                   'other': sum(1 for c in cars if c['r'] != 'car')},
        'events': list(events), 'cars': cars,
    }
    return snap


def hint_events(prev_laps, prev_pit, laps, pit):
    """安い比較：既に読んだ CarIdxLap／CarIdxOnPitRoad の変化（新しい周回・ピット状態変化）。snapshotを早めに作る合図。"""
    ev = []
    try:
        if isinstance(laps, list) and isinstance(prev_laps, list):
            for i in range(min(len(laps), len(prev_laps), MAX_CARS)):
                if isinstance(laps[i], int) and isinstance(prev_laps[i], int) and laps[i] > prev_laps[i] >= 0:
                    ev.append('lap')
                    break
        if isinstance(pit, list) and isinstance(prev_pit, list):
            for i in range(min(len(pit), len(prev_pit), MAX_CARS)):
                if pit[i] != prev_pit[i] and pit[i] in (0, 1) and prev_pit[i] in (0, 1):
                    ev.append('pit')
                    break
    except Exception:
        pass
    return ev


def diff_events(prev, snap):
    """作った snapshot どうしの差から、確定イベントを出す（session境界・車の出入り・ピットIN/OUT・周回）。"""
    ev = []
    if prev is None:
        return ['start']
    for key, name in (('race_instance_id', 'session_change'), ('session_num', 'session_change'), ('bridge_process_epoch', 'epoch_change')):
        if prev.get(key) != snap.get(key) and name not in ev:
            ev.append(name)
    pc = {c['i']: c for c in prev.get('cars', [])}
    for c in snap.get('cars', []):
        if c.get('r', 'car') != 'car':
            continue
        p = pc.get(c['i'])
        if p is None:
            if 'car_join' not in ev:
                ev.append('car_join')
            continue
        if p.get('st') == 'out' and c.get('st') != 'out' and 'car_join' not in ev:
            ev.append('car_join')
        if p.get('st') != 'out' and c.get('st') == 'out' and 'car_leave' not in ev:
            ev.append('car_leave')
        if p.get('pit') in (0, 1) and c.get('pit') in (0, 1) and p['pit'] != c['pit']:
            tag = 'pit_in' if c['pit'] == 1 else 'pit_out'
            if tag not in ev:
                ev.append(tag)
        if isinstance(p.get('lc'), int) and isinstance(c.get('lc'), int) and c['lc'] > p['lc'] and 'lap' not in ev:
            ev.append('lap')
    return ev


class RosterTracker:
    """名簿（ゼッケン/クラス/役割）と race_instance_id を、**同じSessionInfo解析1回分**として持ち、いまのものと確認できるかを判定する。

    確認の根拠（全て満たす時だけ confirmed）：
      1. 名簿を解析した時の SessionNum が、いまの SessionNum と同じ。
      2. SessionInfo更新番号（共有メモリheaderの `sessionInfoUpdate`）が読めるなら、名簿を読んだ時の番号がいまの番号と同じ。
         違えば**その場で名簿だけ読み直す**（refresh：番号→YAML→番号の2回読みが一致した時だけ採用）。読み直せなければ unconfirmed。
      3. SessionNum が変わった後は、**更新番号がその時点より進んだ後に読んだ名簿**だけを信用する（YAML更新がSessionNumより遅れても
         旧名簿を新セッションのものとして採らない）。番号が進まない場合は FAIL_OPEN_S 秒で打ち切り（番号が先に進んでいた場合や、
         headerのoffsetが更新を反映しない場合に、記録を止め続けないため）。その時はログに残す。
    更新番号が読めない（None）時は根拠2・3を使わず、根拠1（SessionNum規則）だけに縮退する。全車を unconfirmed にはしない。
    """
    FAIL_OPEN_S = 30.0
    RETRY_GAP_S = 1.0
    LOG_MIN_GAP_S = 60.0

    def __init__(self, log=None):
        self.log = log or (lambda m: None)
        self.roster = {}
        self.race_id = None
        self.session = None
        self.update = None
        self.prev_snum = None
        self.change_update = None
        self.change_at = None
        self.change_pending = False
        self.last_fail_at = None
        self.refreshes = 0
        self.refresh_failures = 0
        self.fail_open_count = 0
        self._counter_unreadable_logged = False
        self._last_sig = None
        self._last_log_at = None

    def set_from(self, drivers, race_id, session_num, update, via):
        self.roster = roster_from_drivers(drivers)
        self.race_id = race_id
        self.session = session_num if isinstance(session_num, int) and not isinstance(session_num, bool) else None
        self.update = update if isinstance(update, int) and not isinstance(update, bool) else None
        sig = (self.session, self.race_id, tuple(sorted((i, e.get('number'), e.get('class_id'), e.get('role')) for i, e in self.roster.items())))
        now_t = time.time()
        if sig != self._last_sig or self._last_log_at is None or now_t - self._last_log_at >= self.LOG_MIN_GAP_S:
            self.log("FIELD ROSTER: via=%s sessionInfoUpdate=%s session_num=%s race=%s cars=%d (changed=%s)" % (
                via, self.update, self.session, self.race_id, len(self.roster), sig != self._last_sig))
            self._last_sig = sig
            self._last_log_at = now_t

    def step(self, now, cur_snum, cur_update, refresh):
        """毎ループ1回。refresh() は {'drivers','race_id','session_num','update'} か None を返す関数。"""
        cur_update = cur_update if isinstance(cur_update, int) and not isinstance(cur_update, bool) else None
        if cur_update is None and not self._counter_unreadable_logged:
            self._counter_unreadable_logged = True
            self.log("FIELD ROSTER: sessionInfoUpdate を読めない → 名簿の確認は SessionNum 規則のみに縮退")
        if self.prev_snum is not None and cur_snum != self.prev_snum:
            self.change_pending = cur_update is not None
            self.change_update = cur_update
            self.change_at = now
        self.prev_snum = cur_snum
        if cur_update is not None and cur_update != self.update:
            if self.last_fail_at is None or now - self.last_fail_at >= self.RETRY_GAP_S:
                got = None
                try:
                    got = refresh()
                except Exception:
                    got = None
                if got:
                    self.set_from(got.get('drivers'), got.get('race_id'), got.get('session_num'), got.get('update'), 'refresh')
                    self.refreshes += 1
                    self.last_fail_at = None
                else:
                    self.refresh_failures += 1
                    self.last_fail_at = now
        if self.change_pending:
            if self.update is not None and self.change_update is not None and self.update > self.change_update:
                self.change_pending = False
            elif now - self.change_at >= self.FAIL_OPEN_S:
                self.change_pending = False
                self.fail_open_count += 1
                self.log("FIELD ROSTER: SessionNum変更後 %.0f秒たっても sessionInfoUpdate が進まない(now=%s, 変更時=%s) → 打ち切って名簿を採用。"
                         "offsetが更新を反映していない／番号が先に進んでいた可能性。実走で確認" % (self.FAIL_OPEN_S, cur_update, self.change_update))
        confirmed = isinstance(self.session, int) and self.session == cur_snum and not self.change_pending
        if cur_update is not None and confirmed:
            confirmed = self.update is not None and self.update == cur_update
        return {'roster': self.roster, 'race_id': self.race_id, 'roster_session_num': self.session, 'roster_update': self.update, 'confirmed': confirmed}


class FieldRecorder:
    """JSONL 記録。別スレッド＋有界キュー。poll ループは put() だけ（ブロックしない・例外を出さない）。"""

    def __init__(self, directory, stamp, *, file_max_bytes=FILE_MAX_BYTES, run_soft=RUN_SOFT_BYTES, run_hard=RUN_HARD_BYTES,
                 keep_runs=KEEP_RUNS, writer=None, queue_max=QUEUE_MAX, prune=True):
        self.directory = directory
        self.stamp = stamp
        self.file_max = file_max_bytes
        self.run_soft = run_soft
        self.run_hard = run_hard
        self.keep_runs = keep_runs
        self.q = queue.Queue(maxsize=queue_max)
        self.part = 0
        self.path = None
        self.fh = None
        self.file_bytes = 0
        self.run_bytes = 0
        self.lines = 0
        self.dropped_queue_full = 0
        self.dropped_decimated = 0
        self.write_failures = 0
        self.consecutive_failures = 0
        self.stopped_reason = None
        self.last_error = None
        self._writer_override = writer
        self._periodic_seen = 0
        self._stop = threading.Event()
        self.files = []
        self.header_extra = {}
        self.declared = None   # 配列ごとの宣言型・要素数（pipelineが最初の読取で設定。各ファイルのヘッダに残す）
        self._ready = False
        try:
            os.makedirs(directory, exist_ok=True)
            if prune:
                self._prune()
            self._ready = True
        except Exception as e:   # 作れなくても安全側（記録なしで走り続ける）
            self.stopped_reason = 'no_directory'
            self.last_error = repr(e)[:160]
        self.thread = threading.Thread(target=self._run, name='field-recorder', daemon=True)
        if self._ready:
            self.thread.start()

    # ── 公開 ──
    def put(self, snap, periodic=True):
        """キューへ入れるだけ。満杯・停止中は捨てて数える（書込みを待たない）。"""
        try:
            if self.stopped_reason or not self._ready:
                return False
            if periodic and self.run_bytes >= self.run_soft:
                self._periodic_seen += 1
                if self._periodic_seen % DECIMATE_EVERY != 0:
                    self.dropped_decimated += 1
                    return False
            self.q.put_nowait(snap)
            return True
        except queue.Full:
            self.dropped_queue_full += 1
            return False
        except Exception:
            self.write_failures += 1
            return False

    def set_declared(self, declared):
        self.declared = declared

    def set_header_extra(self, **kw):
        self.header_extra.update(kw)

    def stats(self):
        return {'path': self.path, 'files': list(self.files), 'lines': self.lines, 'run_bytes': self.run_bytes, 'queue': self.q.qsize(),
                'dropped_queue_full': self.dropped_queue_full, 'dropped_decimated': self.dropped_decimated, 'write_failures': self.write_failures,
                'stopped': self.stopped_reason, 'last_error': self.last_error}

    def close(self, timeout=2.0):
        self._stop.set()
        try:
            self.q.put_nowait(None)
        except Exception:
            pass
        if self.thread.is_alive():
            self.thread.join(timeout)
        self._close_file()

    def flush_wait(self, timeout=2.0):
        """テスト用：キューが空になるまで待つ。"""
        end = time.time() + timeout
        while time.time() < end and (not self.q.empty()):
            time.sleep(0.005)
        time.sleep(0.02)

    # ── 内部 ──
    def _filename(self):
        return os.path.join(self.directory, 'OMORAY-field-%s-p%02d.jsonl' % (self.stamp, self.part + 1))

    def _prune(self):
        names = sorted(n for n in os.listdir(self.directory) if n.startswith('OMORAY-field-') and n.endswith('.jsonl'))
        excess = len(names) - self.keep_runs
        for n in names[:max(0, excess)]:
            try:
                os.remove(os.path.join(self.directory, n))
            except Exception:
                pass

    def _open_next(self):
        self._close_file()
        # 同じstampで再起動しても既存ファイルへ追記しない（ヘッダ重複・seq再開・サイズ上限カウンタの0再開を避ける）
        while os.path.exists(self._filename()):
            self.part += 1
        self.path = self._filename()
        self.fh = open(self.path, 'a', encoding='utf-8')
        self.file_bytes = 0
        self.files.append(os.path.basename(self.path))
        self.part += 1
        header = {'type': 'field_log_header', 'schema': SCHEMA, 'schema_version': SCHEMA_VERSION, 'part': self.part, 'stamp': self.stamp,
                  'created_at': round(time.time(), 3), 'car_fields': CAR_FIELDS, 'declared_types': self.declared, **self.header_extra,
                  'note': '1Hz周期＋イベント。時間精度は標本間隔(sample_interval_s)。ok=false/gen!=consistent の行は有効観測として使わない。'}
        self._write_line(header, count=False)

    def _close_file(self):
        try:
            if self.fh:
                self.fh.flush()
                self.fh.close()
        except Exception:
            pass
        self.fh = None

    def _write_line(self, obj, count=True):
        line = json.dumps(obj, ensure_ascii=False, separators=(',', ':')) + '\n'
        data = line.encode('utf-8')
        if self._writer_override is not None:
            self._writer_override(self.path, data)
        else:
            self.fh.write(line)
        self.file_bytes += len(data)
        self.run_bytes += len(data)
        if count:
            self.lines += 1

    def _run(self):
        while not self._stop.is_set():
            try:
                snap = self.q.get(timeout=0.5)
            except queue.Empty:
                self._flush()
                continue
            if snap is None:
                break
            try:
                if self.run_bytes >= self.run_hard:
                    self.stopped_reason = 'run_cap'
                    self._write_marker('recording_stopped', 'run_cap')
                    break
                if self.fh is None or self.file_bytes >= self.file_max:
                    self._open_next()
                self._write_line(snap)
                self.consecutive_failures = 0
                if self.lines % 20 == 0:
                    self._flush()
            except Exception as e:   # 容量不足・権限など：記録をやめるだけで、poll は止めない
                self.write_failures += 1
                self.consecutive_failures += 1
                self.last_error = repr(e)[:160]
                self._close_file()
                self.fh = None
                if self.consecutive_failures >= 5:
                    self.stopped_reason = 'write_failed'
                    break
        self._flush()

    def _write_marker(self, kind, reason):
        try:
            if self.fh is None:
                self._open_next()
            self._write_line({'type': 'field_log_marker', 'marker': kind, 'reason': reason, 'at': round(time.time(), 3)}, count=False)
        except Exception:
            pass

    def _flush(self):
        try:
            if self.fh:
                self.fh.flush()
        except Exception:
            pass


class FieldPipeline:
    """poll ループから1回呼ぶだけの窓口（例外を外へ出さない）。"""

    def __init__(self, recorder, *, interval_s=INTERVAL_S, min_event_gap_s=MIN_EVENT_GAP_S, on_declared=None):
        self.recorder = recorder
        self.on_declared = on_declared
        self.declared = None
        self.interval_s = interval_s
        self.min_event_gap_s = min_event_gap_s
        self.seq = 0
        self.last_emit = None
        self.prev = None
        self.prev_laps = None
        self.prev_pit = None
        self.pending = []
        self.emitted = 0
        self.sent = 0
        self.skipped_invalid = 0
        self.errors = 0

    HINT_ARRAYS = ('CarIdxLap', 'CarIdxOnPitRoad')

    def step(self, reader, *, now, ctx, roster, player_idx, roster_session_num=None, roster_update=None, roster_confirmed=None, send=None):
        """必要な時だけ全車を1世代で読み、snapshotを作って 記録＋送信 する。作らなかった時は None。"""
        try:
            # 変化の合図（新しいラップ／ピット状態）は小さな同一世代読取で拾う（従来のint固定読取はbool配列を誤読するため使わない）
            laps_hint = pit_hint = None
            if hasattr(reader, 'read_field_arrays'):
                light = reader.read_field_arrays(self.HINT_ARRAYS, MAX_CARS)
                if light and light.get('consistent') is True:
                    laps_hint = (light.get('arrays') or {}).get('CarIdxLap')
                    pit_hint = (light.get('arrays') or {}).get('CarIdxOnPitRoad')
            hint = hint_events(self.prev_laps, self.prev_pit, laps_hint, pit_hint)
            self.prev_laps = list(laps_hint) if isinstance(laps_hint, list) else self.prev_laps
            self.prev_pit = list(pit_hint) if isinstance(pit_hint, list) else self.prev_pit
            for e in hint:
                if e not in self.pending:
                    self.pending.append(e)
            due_periodic = self.last_emit is None or (now - self.last_emit) >= self.interval_s
            due_event = bool(self.pending) and (self.last_emit is None or (now - self.last_emit) >= self.min_event_gap_s)
            if not (due_periodic or due_event):
                return None
            read = None
            if hasattr(reader, 'read_field_arrays'):
                read = reader.read_field_arrays(ARRAY_NAMES, MAX_CARS)
            if read is None:
                read = {'tick': None, 'arrays': {n: None for n in ARRAY_NAMES}, 'consistent': None}
            declared = read.get('declared')
            if declared and declared != self.declared:      # 宣言型・要素数を最初の読取（と変化時）に1回だけ残す
                self.declared = declared
                self.recorder.set_declared(declared)
                if self.on_declared:
                    try:
                        self.on_declared(declared)
                    except Exception:
                        pass
            self.seq += 1
            snap = build_snapshot(arrays=read.get('arrays'), generation=read.get('tick'), consistent=read.get('consistent'), roster=roster,
                                  player_idx=player_idx, ctx=dict(ctx, observed_at=now, session_time_s=read.get('session_time')), seq=self.seq, events=(), interval_s=self.interval_s, roster_session_num=roster_session_num, roster_update=roster_update, roster_confirmed=roster_confirmed)
            self.recorder.set_header_extra(roster_update=roster_update)
            events = list(self.pending) + [e for e in diff_events(self.prev if (self.prev and self.prev.get('ok')) else None, snap) if e not in self.pending] if snap['ok'] else list(self.pending)
            snap['events'] = events
            self.pending = []
            self.last_emit = now
            if snap['ok']:
                self.prev = snap
            else:
                self.skipped_invalid += 1
            self.emitted += 1
            self.recorder.put(snap, periodic=not events or events == ['start'])
            if snap['ok'] and send is not None:
                try:
                    send(snap)
                    self.sent += 1
                except Exception:
                    self.errors += 1
            return snap
        except Exception:
            self.errors += 1
            return None

    def summary(self):
        s = self.recorder.stats() if self.recorder else {}
        s.update({'emitted': self.emitted, 'sent': self.sent, 'invalid_not_used': self.skipped_invalid, 'pipeline_errors': self.errors})
        return s


def parse_log(path):
    """記録ファイルを読み戻す（受入の再読込・U2以降の入力用）。ヘッダ／marker／snapshotを分けて返す。"""
    header, snaps, markers, bad = None, [], [], 0
    with open(path, 'r', encoding='utf-8') as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except Exception:
                bad += 1
                continue
            t = obj.get('type')
            if t == 'field_log_header':
                header = obj
            elif t == 'field_log_marker':
                markers.append(obj)
            elif t == 'field_snapshot':
                snaps.append(obj)
    return {'header': header, 'snapshots': snaps, 'markers': markers, 'bad_lines': bad}
