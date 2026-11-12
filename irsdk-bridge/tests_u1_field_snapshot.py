"""U1（STR-001／設計§24.14）全車snapshot：Bridge側の検査。

実物を通す範囲
  * 実 IRacingReader.read_field_arrays を、独立に書いた共有メモリ画像（絶対オフセット固定）に対して実行（型どおり読む／世代検証）
  * 実 bridge.poll_iracing() を replay_harness（FakeReader）で回し、実際の broadcast と実ファイル記録を取る
  * 記録ファイルを parse_log で読み戻し、送信内容と一致することを確認
実走のiRacing・Windows・実Rendererは別（Node側 tests-u1-field-snapshot-e2e.js）。
実行: python3 irsdk-bridge/tests_u1_field_snapshot.py
"""
import ctypes
import json
import os
import struct
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import replay_harness as rh  # noqa: E402
import field_snapshot as fs  # noqa: E402

N_CARS = 8
HEAD = rh.SESSION_INFO.split('DriverInfo:')[0]


def session_info(n=N_CARS, classes=None, extra_sub=None):
    classes = classes or {}
    head = HEAD
    if extra_sub is not None:
        head = head.replace('SubSessionID: 101000', 'SubSessionID: %d' % extra_sub)
    out = [head, 'DriverInfo:', ' DriverCarIdx: 0', ' DriverCarFuelMaxLtr: 60.000', ' DriverCarMaxFuelPct: 1.000', ' Drivers:']
    for i in range(n):
        cid = classes.get(i, 100)
        out += [' - CarIdx: %d' % i, '   UserID: %d' % (10100 + i), '   UserName: Name%d Secret' % i, '   CarNumber: "%d"' % (i + 1),
                '   CarScreenName: Car', '   CarClassID: %d' % cid, '   CarClassShortName: C%d' % cid, '   IRating: 2000', '   LicSubLevel: 300']
    return '\n'.join(out) + '\n'


def arrays8(**kw):
    base = {
        'CarIdxLap': [5, 5, 5, 4, 5, 6, 5, 5],
        'CarIdxLapCompleted': [4, 4, 4, 3, 4, 5, 4, 4],
        'CarIdxLapDistPct': [0.10, 0.30, 0.60, 0.95, 0.20, 0.40, 0.70, 0.85],
        'CarIdxPosition': [4, 1, 6, 8, 5, 2, 3, 7],
        'CarIdxClassPosition': [2, 1, 4, 5, 3, 1, 2, 4],
        'CarIdxOnPitRoad': [0, 0, 0, 1, 0, 0, 0, 0],
        'CarIdxTrackSurface': [3, 3, 3, 1, 3, 3, 3, 3],
        'CarIdxEstTime': [10.0, 12.0, 30.0, 50.0, 15.0, 20.0, 40.0, 44.0],
        'CarIdxF2Time': [20.0, 0.0, 25.0, 60.0, 12.0, 5.0, 15.0, 30.0],
        'CarIdxLastLapTime': [108.0, 107.5, 109.0, -1.0, 108.8, 98.0, 99.1, 110.2],
    }
    base.update(kw)
    return base


CLASSES8 = {0: 100, 1: 100, 2: 100, 3: 100, 4: 100, 5: 200, 6: 200, 7: 100}


def frames_with(n, **fr):
    return [rh.make_frame(SessionTime=100.0 + i, **dict(arrays8(), **fr)) for i in range(n)]


def run(frames, info=None, **kw):
    return rh.replay(frames, session_info=info or session_info(classes=CLASSES8), keep_field_logs=True, **kw)


def snaps_of(r):
    return [b for b in r.broadcasts if b.get('type') == 'field_snapshot']


def file_snaps(r):
    out = []
    for f in r.field_files:
        out += fs.parse_log(os.path.join(r.field_log_dir, f))['snapshots']
    return out


class FieldReaderMemory(unittest.TestCase):
    """実 IRacingReader.read_field_arrays ＋ 独立に書いた共有メモリ画像（irsdk_mem の定数を参照しない）。"""

    def make(self, n_buf=3, ticks=(10, 11, 12)):
        import bridge
        mem = ctypes.create_string_buffer(65536)
        struct.pack_into('i', mem, 4, 1)          # status
        struct.pack_into('i', mem, 24, 4)         # numVars
        struct.pack_into('i', mem, 28, 512)       # varHeaderOffset
        struct.pack_into('i', mem, 32, n_buf)     # numBuf
        specs = [('CarIdxLap', 2, 0), ('CarIdxOnPitRoad', 1, 256), ('CarIdxLapDistPct', 4, 320), ('SessionTime', 5, 576)]
        for i, (name, vt, off) in enumerate(specs):
            base = 512 + i * 144
            struct.pack_into('i', mem, base, vt)
            struct.pack_into('i', mem, base + 4, off)
            struct.pack_into('i', mem, base + 8, 64 if name != 'SessionTime' else 1)
            mem[base + 16:base + 16 + len(name)] = name.encode()
        for i in range(n_buf):
            struct.pack_into('i', mem, 48 + i * 16, ticks[i])
            struct.pack_into('i', mem, 48 + i * 16 + 4, 4096 + i * 1024)
        self.fill(mem, 2, laps=[7] * 64, pit={3: 1}, dist=0.25, st=555.5)
        r = bridge.IRacingReader()
        r._ptr = ctypes.addressof(mem)
        self.mem = mem
        return r

    def fill(self, mem, slot, laps, pit, dist, st):
        base = 4096 + slot * 1024
        struct.pack_into('64i', mem, base, *laps)
        for i in range(64):
            mem[base + 256 + i] = bytes([pit.get(i, 0)])
        struct.pack_into('64f', mem, base + 320, *([dist] * 64))
        struct.pack_into('d', mem, base + 576, st)

    def test_typed_read_and_latest_slot(self):
        r = self.make()
        out = r.read_field_arrays(('CarIdxLap', 'CarIdxOnPitRoad', 'CarIdxLapDistPct'), 64)
        self.assertIs(out['consistent'], True)
        self.assertEqual(out['tick'], 12)                 # 最新tickのスロット(index2)を選ぶ
        self.assertEqual(out['arrays']['CarIdxLap'][:3], [7, 7, 7])
        pit = out['arrays']['CarIdxOnPitRoad']
        self.assertEqual(len(pit), 64)
        self.assertEqual([i for i, v in enumerate(pit) if v == 1], [3])   # bool配列は1バイト/要素で読む
        self.assertAlmostEqual(out['arrays']['CarIdxLapDistPct'][0], 0.25, places=5)
        self.assertEqual(out['session_time'], 555.5)

    def test_legacy_int_read_of_bool_array_is_wrong(self):
        """従来の read_int_array は bool 配列を4バイト/要素で読むため、車3だけがピットでも車0の値が非0になる（型どおり読む理由）。"""
        r = self.make()
        legacy = r.read_int_array('CarIdxOnPitRoad', 64)
        self.assertNotEqual(legacy[0], 0)

    def test_overwritten_during_read_is_mixed(self):
        r = self.make()
        orig = r._bytes
        state = {'n': 0}

        def tampering(offset, size):
            state['n'] += 1
            data = orig(offset, size)
            if state['n'] == 2:   # 配列を1つ読んだ後でスロットのtickが進む（上書き開始）
                struct.pack_into('i', self.mem, 48 + 2 * 16, 99)
            return data
        r._bytes = tampering
        out = r.read_field_arrays(('CarIdxLap', 'CarIdxOnPitRoad'), 64)
        # 1回目は混在→再試行で別スロット(tick99)を読み直し、安定していれば consistent=True・attempts=2
        self.assertIs(out['consistent'], True)
        self.assertEqual(out['attempts'], 2)
        self.assertEqual(out['tick'], 99)

    def test_always_overwritten_gives_consistent_false(self):
        r = self.make()
        orig = r._bytes
        counter = {'t': 100}

        def always(offset, size):
            data = orig(offset, size)
            counter['t'] += 1
            # いま最新のスロットのtickを毎回進める
            best = max(range(3), key=lambda i: struct.unpack_from('i', self.mem, 48 + i * 16)[0])
            struct.pack_into('i', self.mem, 48 + best * 16, counter['t'])
            return data
        r._bytes = always
        out = r.read_field_arrays(('CarIdxLap', 'CarIdxOnPitRoad'), 64)
        self.assertIs(out['consistent'], False)
        snap = fs.build_snapshot(arrays=out['arrays'], generation=out['tick'], consistent=out['consistent'],
                                 roster={}, player_idx=0, ctx={}, seq=1)
        self.assertFalse(snap['ok'])
        self.assertEqual(snap['gen'], 'mixed')

    def test_declared_count_is_respected_and_reported(self):
        """R3②：変数ヘッダの要素数が64未満なら、その分だけ読む（隣の変数を読まない）。宣言(vtype,count)を返す。"""
        r = self.make()
        struct.pack_into('i', self.mem, 512 + 8, 32)               # CarIdxLap の count を32へ
        base = 4096 + 2 * 1024
        struct.pack_into('64i', self.mem, base, *([7] * 32 + [99999] * 32))   # 33個目以降は「隣の変数」のつもりの値
        out = r.read_field_arrays(('CarIdxLap', 'CarIdxOnPitRoad'), 64)
        self.assertEqual(len(out['arrays']['CarIdxLap']), 32)
        self.assertNotIn(99999, out['arrays']['CarIdxLap'])
        self.assertEqual(out['declared']['CarIdxLap'], [2, 32])
        self.assertEqual(out['declared']['CarIdxOnPitRoad'], [1, 64])
        self.assertEqual(out['declared']['SessionTime'], [5, 1])
        snap = fs.build_snapshot(arrays=out['arrays'], generation=1, consistent=True, roster_session_num=0,
                                 roster={i: {'number': str(i), 'class_id': 1, 'role': 'car'} for i in range(40)}, player_idx=0, ctx={'session_num': 0}, seq=1)
        c = {x['i']: x for x in snap['cars']}
        self.assertEqual(c[5]['l'], 7)
        self.assertIsNone(c[40 - 1]['l'])                           # 要素数の外は欠測(null)

    def test_unknown_var_is_none(self):
        r = self.make()
        out = r.read_field_arrays(('CarIdxLap', 'CarIdxF2Time'), 64)
        self.assertIsNone(out['arrays']['CarIdxF2Time'])
        self.assertIsNotNone(out['arrays']['CarIdxLap'])


class BuildSnapshot(unittest.TestCase):
    def build(self, arrays, consistent=True, roster=None, roster_session_num=0):
        return fs.build_snapshot(arrays=arrays, generation=5, consistent=consistent, roster_session_num=roster_session_num,
                                 roster=roster if roster is not None else {i: {'number': str(i + 1), 'class_id': CLASSES8[i]} for i in range(N_CARS)},
                                 player_idx=0, ctx={'race_instance_id': 'sub:1', 'session_num': 0, 'epoch': 'e', 'frame_sequence': 9, 'session_time_s': 10.0, 'observed_at': 11.0}, seq=1)

    def test_values_null_and_departed(self):
        a = arrays8()
        a['CarIdxTrackSurface'][6] = -1
        a['CarIdxLastLapTime'][3] = -1.0
        a['CarIdxLapDistPct'][4] = -1.0
        s = self.build(a)
        c = {x['i']: x for x in s['cars']}
        self.assertEqual(s['counts'], {'target': 8, 'observed': 7, 'departed': 1, 'missing': 0, 'other': 0})
        self.assertEqual(c[6]['st'], 'out')
        self.assertIsNone(c[6]['p'])           # 離脱車は値を持たない（欠測と区別）
        self.assertIsNone(c[3]['ll'])          # 未取得(-1)は null
        self.assertIsNone(c[4]['d'])           # -1 は null
        self.assertEqual(c[3]['pit'], 1)
        self.assertEqual(c[5]['c'], 200)
        self.assertEqual(c[1]['f2'], 0.0)      # 0.0 はそのまま記録（意味づけは受け手）

    def test_missing_array_vs_departed(self):
        a = arrays8()
        a['CarIdxLapDistPct'] = None
        s = self.build(a)
        self.assertEqual(s['counts']['missing'], 8)
        self.assertEqual(s['counts']['departed'], 0)
        self.assertTrue(all(x['st'] == 'missing' and x['d'] is None for x in s['cars']))
        self.assertTrue(s['ok'])               # 世代は一貫。値が無いだけ

    def test_short_array_is_missing_for_tail_cars(self):
        a = arrays8()
        a['CarIdxPosition'] = a['CarIdxPosition'][:5]
        s = self.build(a)
        self.assertEqual([x['i'] for x in s['cars'] if x['st'] == 'missing'], [5, 6, 7])

    def test_no_personal_data(self):
        s = self.build(arrays8())
        text = json.dumps(s)
        self.assertNotIn('Secret', text)
        self.assertNotIn('Name', text)
        self.assertNotIn('UserID', text)

    def test_identity_stale_when_roster_session_differs_or_unknown(self):
        for rs in (1, None):
            s = self.build(arrays8(), roster_session_num=rs)
            self.assertEqual(s['gen'], 'identity_stale')
            self.assertFalse(s['ok'])
        self.assertTrue(self.build(arrays8(), roster_session_num=0)['ok'])
        # mixedは identity_stale より優先して mixed と記録する
        self.assertEqual(self.build(arrays8(), consistent=False, roster_session_num=1)['gen'], 'mixed')

    def test_roster_from_drivers_rebuilds_and_assigns_roles(self):
        a = fs.roster_from_drivers([{'car_idx': 0, 'car_number': '1', 'class_id': 100}, {'car_idx': 1, 'car_number': '0', 'class_id': 11, 'pace_car': True},
                                    {'car_idx': 2, 'car_number': '9', 'class_id': 100, 'spectator': 1, 'name': 'Secret'}, {'car_idx': 99}, {'car_idx': True}])
        self.assertEqual(sorted(a), [0, 1, 2])
        self.assertEqual([a[i]['role'] for i in (0, 1, 2)], ['car', 'pace', 'spec'])
        self.assertNotIn('Secret', json.dumps(a))
        b = fs.roster_from_drivers([{'car_idx': 5, 'car_number': '5', 'class_id': 1}])
        self.assertEqual(sorted(b), [5])                    # 前回のentryを引き継がない

    def test_counts_exclude_non_competitors(self):
        roster = {i: {'number': str(i + 1), 'class_id': 100, 'role': ('pace' if i == 2 else ('spec' if i == 3 else 'car'))} for i in range(4)}
        a = {k: v[:4] for k, v in arrays8().items()}
        a['CarIdxTrackSurface'] = [3, 3, 3, -1]
        s = self.build(a, roster=roster)
        self.assertEqual(s['counts'], {'target': 2, 'observed': 2, 'departed': 0, 'missing': 0, 'other': 2})
        self.assertEqual(len(s['cars']), 4)

    def test_unverified_and_mixed_flags(self):
        self.assertEqual(self.build(arrays8(), consistent=None)['gen'], 'unverified')
        self.assertFalse(self.build(arrays8(), consistent=None)['ok'])
        self.assertEqual(self.build(arrays8(), consistent=False)['gen'], 'mixed')

    def test_out_of_range_values_become_null(self):
        a = arrays8()
        a['CarIdxLapDistPct'][0] = 7.5
        a['CarIdxF2Time'][1] = float('nan')
        a['CarIdxLastLapTime'][2] = 99999.0
        a['CarIdxOnPitRoad'][4] = 9
        s = self.build(a)
        c = {x['i']: x for x in s['cars']}
        self.assertIsNone(c[0]['d'])
        self.assertIsNone(c[1]['f2'])
        self.assertIsNone(c[2]['ll'])
        self.assertIsNone(c[4]['pit'])


class RealBridgeReplay(unittest.TestCase):
    """実 poll_iracing を通す。全車（非隣接・別クラス・周回遅れ含む）が、送信と実ファイルの両方に同じ値で出る。"""

    def test_all_cars_sent_and_logged_identically(self):
        r = run(frames_with(6))
        try:
            sent = snaps_of(r)
            logged = file_snaps(r)
            self.assertEqual(len(sent), 6)
            self.assertEqual(len(logged), 6)
            for a, b in zip(sent, logged):
                self.assertEqual(a, b)                      # 送信と記録は同一内容
            s = sent[0]
            self.assertEqual(s['counts'], {'target': 8, 'observed': 8, 'departed': 0, 'missing': 0, 'other': 0})
            cars = {c['i']: c for c in s['cars']}
            self.assertEqual(sorted(cars), list(range(8)))
            self.assertEqual(cars[5]['c'], 200)             # 別クラス
            self.assertEqual(cars[3]['l'], 4)               # 周回遅れ（他は5）
            self.assertEqual(cars[7]['no'], '8')            # プレイヤー(0)から非隣接の車も入る
            self.assertEqual(cars[3]['pit'], 1)
            self.assertIsNone(cars[3]['ll'])
            self.assertEqual(s['player_car_idx'], 0)
            self.assertEqual(s['race_instance_id'], 'sub:101000')
            self.assertEqual(s['session_time_s'], 100.0)
            self.assertEqual(s['gen'], 'consistent')
            self.assertEqual(s['sample_interval_s'], 1.0)
            # 記録のヘッダ
            parsed = fs.parse_log(os.path.join(r.field_log_dir, r.field_files[0]))
            self.assertEqual(parsed['header']['schema_version'], 1)
            self.assertEqual(parsed['bad_lines'], 0)
            # seq は 1..6 の連番・重複なし
            self.assertEqual([x['seq'] for x in logged], [1, 2, 3, 4, 5, 6])
            # 個人名なし
            with open(os.path.join(r.field_log_dir, r.field_files[0]), encoding='utf-8') as fh:
                blob = fh.read()
            self.assertNotIn('Secret', blob)
        finally:
            r.field_tmp.cleanup()

    def test_logs_exist_without_receiving_client_and_broadcast_gate(self):
        """非搭乗(activity非ACTIVE)でも field_snapshot は allow-list で落とさない。"""
        import bridge
        self.assertIn('field_snapshot', bridge.ACTIVITY_ALLOWED_META_TYPES)

    def test_new_lap_event_triggers_early_snapshot(self):
        frames = []
        for i in range(8):
            lap = [5] * 8 if i < 2 else [6] + [5] * 7
            frames.append(rh.make_frame(SessionTime=100.0 + i * 0.3, **dict(arrays8(), CarIdxLap=lap, CarIdxLapCompleted=[l - 1 for l in lap])))
        r = run(frames, seconds_per_frame=0.3)
        try:
            sent = snaps_of(r)
            laps = [s for s in sent if 'lap' in s['events']]
            self.assertTrue(laps, [s['events'] for s in sent])
            # 1Hz 周期だけなら 2.4s で3本。イベントで早く作られた分、周期より多い
            first_lap = laps[0]
            # 周期(1Hz)より前＝イベントで作られた（周期だけなら最初の追加snapshotは1.0秒後以降）
            self.assertLess(first_lap['observed_at'] - sent[0]['observed_at'], 1.0)
            self.assertEqual(first_lap['source_frame_sequence'], 3)   # 周回が変わったframe(3本目)そのもの
        finally:
            r.field_tmp.cleanup()

    def test_pit_in_out_and_car_join_leave_events(self):
        base = arrays8()
        f = []
        pit_seq = [0, 0, 1, 1, 0, 0]
        surf_seq = [3, 3, 3, 3, 3, 3]
        for i in range(6):
            pit = list(base['CarIdxOnPitRoad'])
            pit[2] = pit_seq[i]
            surf = list(base['CarIdxTrackSurface'])
            surf[7] = -1 if i in (2, 3) else 3     # 車7 が i=2 で離脱し i=4 で復帰
            f.append(rh.make_frame(SessionTime=100.0 + i, **dict(base, CarIdxOnPitRoad=pit, CarIdxTrackSurface=surf)))
        r = run(f)
        try:
            ev = [s['events'] for s in snaps_of(r)]
            flat = [e for x in ev for e in x]
            for want in ('start', 'pit_in', 'pit_out', 'car_leave', 'car_join'):
                self.assertIn(want, flat, ev)
            leaving = [s for s in snaps_of(r) if 'car_leave' in s['events']][0]
            self.assertEqual({c['i']: c['st'] for c in leaving['cars']}[7], 'out')
            self.assertEqual(leaving['counts']['departed'], 1)
        finally:
            r.field_tmp.cleanup()

    def _switch_run(self, n=130, switch_at=5):
        d1 = {i: (100, str(i + 1)) for i in range(4)}
        info1 = session_info(n=4)
        info2 = session_info(n=4, classes={2: 200, 3: 200}, extra_sub=202000).replace('CarNumber: "3"', 'CarNumber: "77"').replace('CarNumber: "4"', 'CarNumber: "88"')
        orig = rh.FakeReader.read_session_info
        rh.FakeReader.read_session_info = lambda self_: info2 if self_.cursor >= switch_at else info1
        try:
            fr = [rh.make_frame(SessionTime=100.0 + i, SessionNum=(0 if i < switch_at else 1), CarIdxLap=[3] * 4, CarIdxLapCompleted=[2] * 4, CarIdxLapDistPct=[0.1, 0.2, 0.3, 0.4],
                                CarIdxPosition=[1, 2, 3, 4], CarIdxClassPosition=[1, 2, 3, 4], CarIdxOnPitRoad=[0] * 4, CarIdxTrackSurface=[3] * 4, CarIdxEstTime=[1, 2, 3, 4],
                                CarIdxF2Time=[0, 1, 2, 3], CarIdxLastLapTime=[100] * 4) for i in range(n)]
            return rh.replay(fr, session_info=info1, keep_field_logs=True)
        finally:
            rh.FakeReader.read_session_info = orig

    def test_session_switch_stale_roster_is_not_sent_or_used(self):
        """R1：SessionNumは切替の瞬間に変わるが名簿の再解析は約100ループ後。その間は旧名簿の行を有効として送らない。"""
        r = self._switch_run()
        try:
            sent = snaps_of(r)
            logged = file_snaps(r)
            stale = [s for s in logged if s['gen'] == 'identity_stale']
            self.assertTrue(stale, 'identity_stale の記録行が無い')
            self.assertTrue(all(not s['ok'] and s['session_num'] == 1 for s in stale))
            self.assertTrue(all(s['ok'] for s in sent))
            # 送信されたsession_num=1の行は、全て新名簿（ゼッケン77/88・クラス200）で、旧idを持たない
            new_rows = [s for s in sent if s['session_num'] == 1]
            self.assertTrue(new_rows)
            for s in new_rows:
                c = {x['i']: x for x in s['cars']}
                self.assertEqual((c[2]['no'], c[2]['c'], c[3]['no'], c[3]['c']), ('77', 200, '88', 200), s['seq'])
                self.assertEqual(s['race_instance_id'], 'sub:202000')
                self.assertEqual(s['roster_session_num'], 1)
            # 旧名簿のままsession_num=1を名乗る有効行は0
            self.assertFalse([s for s in sent if s['session_num'] == 1 and s['race_instance_id'] == 'sub:101000'])
            self.assertGreaterEqual(r.field_summary['invalid_not_used'], len(stale))
        finally:
            r.field_tmp.cleanup()

    def test_session_switch_event(self):
        r = self._switch_run()
        try:
            sw = [s for s in snaps_of(r) if 'session_change' in s['events']]
            self.assertTrue(sw, [(s['session_num'], s['events']) for s in snaps_of(r)])
            self.assertEqual(sw[0]['session_num'], 1)
        finally:
            r.field_tmp.cleanup()

    def test_pace_car_and_spectator_are_not_competitors(self):
        """R2"""
        drivers = [(0, '1', 100, ''), (1, '2', 100, ''), (2, '0', 11, 'pace'), (3, '9', 100, 'spec')]
        head = HEAD
        out = [head, 'DriverInfo:', ' DriverCarIdx: 0', ' DriverCarFuelMaxLtr: 60.000', ' DriverCarMaxFuelPct: 1.000', ' Drivers:']
        for i, no, c, kind in drivers:
            out += [' - CarIdx: %d' % i, '   UserName: N%d' % i, '   CarNumber: "%s"' % no, '   CarScreenName: Car', '   CarClassID: %d' % c, '   CarClassShortName: C']
            if kind == 'pace':
                out.append('   CarIsPaceCar: 1')
            if kind == 'spec':
                out.append('   IsSpectator: 1')
            out += ['   IRating: 2000', '   LicSubLevel: 300']
        fr = [rh.make_frame(SessionTime=100.0 + i, CarIdxLap=[3, 3, 3, -1], CarIdxLapCompleted=[2, 2, 2, -1], CarIdxLapDistPct=[0.1, 0.2, 0.3, -1.0], CarIdxPosition=[1, 2, 0, 0],
                            CarIdxClassPosition=[1, 2, 0, 0], CarIdxOnPitRoad=[0] * 4, CarIdxTrackSurface=[3, 3, 3, -1], CarIdxEstTime=[1, 2, 3, 0], CarIdxF2Time=[0, 1, 2, 0],
                            CarIdxLastLapTime=[100, 101, 90, -1]) for i in range(3)]
        r = rh.replay(fr, session_info='\n'.join(out) + '\n', keep_field_logs=True)
        try:
            s = snaps_of(r)[0]
            c = {x['i']: x for x in s['cars']}
            self.assertEqual([c[i]['r'] for i in range(4)], ['car', 'car', 'pace', 'spec'])
            self.assertEqual(s['counts'], {'target': 2, 'observed': 2, 'departed': 0, 'missing': 0, 'other': 2})
            self.assertEqual(c[2]['c'], 11)
        finally:
            r.field_tmp.cleanup()

    def test_declared_types_in_header_and_debug_log(self):
        """R3①"""
        r = run(frames_with(3))
        try:
            hdr = fs.parse_log(os.path.join(r.field_log_dir, r.field_files[0]))['header']
            self.assertEqual(hdr['declared_types']['CarIdxOnPitRoad'], [1, 64])
            self.assertEqual(hdr['declared_types']['CarIdxLap'], [2, 64])
            diag = [l for l in r.logs if l.startswith('SDK TYPE DIAG(field):')]
            self.assertEqual(len(diag), 1, diag)               # 1回だけ
            self.assertIn('CarIdxOnPitRoad=type1/count64', diag[0])
        finally:
            r.field_tmp.cleanup()

    def test_mixed_generation_recorded_but_not_sent_or_adopted(self):
        f = frames_with(5)
        f[2]['_field_inconsistent'] = True
        r = run(f)
        try:
            sent = snaps_of(r)
            logged = file_snaps(r)
            self.assertEqual(len(logged), 5)
            self.assertEqual(len(sent), 4)                   # 混在1本は送らない
            bad = [s for s in logged if not s['ok']]
            self.assertEqual(len(bad), 1)
            self.assertEqual(bad[0]['gen'], 'mixed')
            self.assertEqual(r.field_summary['invalid_not_used'], 1)
        finally:
            r.field_tmp.cleanup()

    def test_unverified_reader_not_sent(self):
        f = frames_with(3)
        for x in f:
            x['_field_unverified'] = True
        r = run(f)
        try:
            self.assertEqual(len(snaps_of(r)), 0)
            self.assertEqual([s['gen'] for s in file_snaps(r)], ['unverified'] * 3)
        finally:
            r.field_tmp.cleanup()

    def test_read_failure_is_flagged_not_crash(self):
        f = frames_with(4)
        f[1]['_field_read_none'] = True
        r = run(f)
        try:
            logged = file_snaps(r)
            self.assertEqual(len(logged), 4)
            self.assertEqual(sum(1 for s in logged if not s['ok']), 1)
            self.assertEqual(r.frames_served, 4)             # poll は止まらない
        finally:
            r.field_tmp.cleanup()

    def test_missing_arrays_flagged_per_car(self):
        f = frames_with(3)
        f[1]['_field_missing'] = ['CarIdxLapDistPct']
        r = run(f)
        try:
            s = file_snaps(r)[1]
            self.assertTrue(s['ok'])
            self.assertEqual(s['counts']['missing'], 8)
            self.assertTrue(all(c['d'] is None and c['st'] == 'missing' for c in s['cars']))
        finally:
            r.field_tmp.cleanup()

    def test_write_failure_does_not_stop_poll_or_send(self):
        blocker = tempfile.NamedTemporaryFile(delete=False)
        blocker.close()
        os.environ['PITWALL_FIELD_LOG_DIR'] = os.path.join(blocker.name, 'sub')   # ファイルの下にはフォルダを作れない
        try:
            r = rh.replay(frames_with(5), session_info=session_info(classes=CLASSES8), keep_field_logs=True)
            self.assertEqual(r.frames_served, 5)
            self.assertEqual(len(snaps_of(r)), 5)            # 記録できなくても送信は続く
            self.assertEqual(r.field_summary['stopped'], 'no_directory')
        finally:
            os.environ.pop('PITWALL_FIELD_LOG_DIR', None)
            os.unlink(blocker.name)

    def test_health_line_goes_to_existing_debug_log(self):
        r = run(frames_with(130))
        try:
            lines = [l for l in r.logs if l.startswith('FIELD LOG stats:')]
            self.assertGreaterEqual(len(lines), 2, [l for l in r.logs if 'FIELD' in l])
            self.assertIn('write_failures=0', lines[-1])
            self.assertIn('stopped=None', lines[-1])
        finally:
            r.field_tmp.cleanup()

    def test_health_line_shows_stopped_recording(self):
        blocker = tempfile.NamedTemporaryFile(delete=False)
        blocker.close()
        os.environ['PITWALL_FIELD_LOG_DIR'] = os.path.join(blocker.name, 'sub')
        try:
            r = rh.replay(frames_with(70), session_info=session_info(classes=CLASSES8), keep_field_logs=True)
            lines = [l for l in r.logs if l.startswith('FIELD LOG stats:')]
            self.assertTrue(lines and 'stopped=no_directory' in lines[-1], lines)
        finally:
            os.environ.pop('PITWALL_FIELD_LOG_DIR', None)
            os.unlink(blocker.name)

    def test_disabled_by_env(self):
        os.environ['PITWALL_FIELD_LOG'] = '0'
        try:
            r = rh.replay(frames_with(3), session_info=session_info(classes=CLASSES8), keep_field_logs=True)
            self.assertEqual(snaps_of(r), [])
        finally:
            os.environ.pop('PITWALL_FIELD_LOG', None)
            if r.field_tmp:
                r.field_tmp.cleanup()


class RosterTrackerUnit(unittest.TestCase):
    """R7：名簿の世代確認（SessionInfo更新番号）。純ロジック。"""

    def mk(self):
        logs = []
        t = fs.RosterTracker(log=logs.append)
        return t, logs

    def got(self, update, session=0, race='sub:1', drivers=None):
        return {'drivers': drivers if drivers is not None else [{'car_idx': 0, 'car_number': '1', 'class_id': 100}], 'race_id': race, 'session_num': session, 'update': update}

    def test_counter_unreadable_falls_back_to_session_rule_not_all_stale(self):
        t, logs = self.mk()
        t.set_from([{'car_idx': 0, 'car_number': '1', 'class_id': 1}], 'sub:1', 0, None, 'parse')
        r = t.step(0.0, 0, None, lambda: self.fail('更新番号が読めない時にrefreshを呼ばない'))
        self.assertTrue(r['confirmed'])                      # SessionNum規則だけで確認＝全車staleにはしない
        r = t.step(1.0, 1, None, lambda: self.fail('refreshしない'))   # SessionNumが変わる
        self.assertFalse(r['confirmed'])                     # 名簿のSessionNum(0)≠いま(1)
        t.set_from([{'car_idx': 0, 'car_number': '9', 'class_id': 1}], 'sub:1', 1, None, 'parse')
        self.assertTrue(t.step(2.0, 1, None, None)['confirmed'])      # 再読込後は確認できる
        self.assertEqual(sum(1 for l in logs if '読めない' in l), 1)   # 縮退のログは1回だけ

    def test_set_from_rebuilds_roster_without_keeping_old_entries(self):
        t, _ = self.mk()
        t.set_from([{'car_idx': 0, 'car_number': '1', 'class_id': 1}, {'car_idx': 1, 'car_number': '2', 'class_id': 1}], 'sub:1', 0, 5, 'parse')
        t.set_from([{'car_idx': 5, 'car_number': '55', 'class_id': 2}], 'sub:2', 1, 6, 'refresh')
        self.assertEqual(sorted(t.roster), [5])
        self.assertEqual((t.race_id, t.session, t.update), ('sub:2', 1, 6))

    def test_counter_mismatch_triggers_immediate_refresh(self):
        t, _ = self.mk()
        t.set_from([{'car_idx': 0, 'car_number': '1', 'class_id': 1}], 'sub:1', 0, 5, 'parse')
        self.assertTrue(t.step(0.0, 0, 5, None)['confirmed'])
        calls = []
        r = t.step(1.0, 0, 6, lambda: calls.append(1) or self.got(6, session=0, race='sub:2', drivers=[{'car_idx': 0, 'car_number': '7', 'class_id': 2}]))
        self.assertEqual(len(calls), 1)
        self.assertTrue(r['confirmed'])                      # 同じステップ内で名簿が新しくなる（stale行を作らない）
        self.assertEqual((r['race_id'], r['roster'][0]['number'], r['roster_update']), ('sub:2', '7', 6))

    def test_refresh_failure_is_unconfirmed_and_retries_after_gap(self):
        t, _ = self.mk()
        t.set_from([{'car_idx': 0, 'car_number': '1', 'class_id': 1}], 'sub:1', 0, 5, 'parse')
        n = {'c': 0}
        def failing():
            n['c'] += 1
            return None
        self.assertFalse(t.step(1.0, 0, 6, failing)['confirmed'])
        self.assertFalse(t.step(1.5, 0, 6, failing)['confirmed'])   # 1秒未満は再試行しない
        self.assertEqual(n['c'], 1)
        self.assertFalse(t.step(2.1, 0, 6, failing)['confirmed'])
        self.assertEqual(n['c'], 2)
        self.assertTrue(t.step(3.2, 0, 6, lambda: self.got(6))['confirmed'])   # 読めたら確認

    def test_after_session_change_only_a_roster_read_after_counter_advanced_is_trusted(self):
        t, _ = self.mk()
        t.set_from([{'car_idx': 0, 'car_number': '1', 'class_id': 1}], 'sub:1', 0, 5, 'parse')
        t.step(0.0, 0, 5, None)
        # SessionNumが1へ。YAML(=更新番号)はまだ旧い（遅れ）。再読込がこの区間に当たり、旧YAMLを「session 1」の印で読んでしまう
        t.step(1.0, 1, 5, None)
        t.set_from([{'car_idx': 0, 'car_number': '1', 'class_id': 1}], 'sub:1', 1, 5, 'parse')   # 旧YAML・新SessionNum印
        self.assertFalse(t.step(2.0, 1, 5, None)['confirmed'])        # 番号が進んでいない＝旧名簿を新セッションとして信用しない
        r = t.step(3.0, 1, 6, lambda: self.got(6, session=1, drivers=[{'car_idx': 0, 'car_number': '77', 'class_id': 2}]))
        self.assertTrue(r['confirmed'])                              # 番号が進み、その後に読んだ名簿＝信用
        self.assertEqual(r['roster'][0]['number'], '77')

    def test_fail_open_when_counter_never_advances_is_logged_not_stuck(self):
        t, logs = self.mk()
        t.set_from([{'car_idx': 0, 'car_number': '1', 'class_id': 1}], 'sub:1', 0, 5, 'parse')
        t.step(0.0, 0, 5, None)
        t.step(1.0, 1, 5, None)
        t.set_from([{'car_idx': 0, 'car_number': '1', 'class_id': 1}], 'sub:1', 1, 5, 'parse')
        self.assertFalse(t.step(2.0, 1, 5, None)['confirmed'])
        self.assertFalse(t.step(1.0 + fs.RosterTracker.FAIL_OPEN_S - 0.1, 1, 5, None)['confirmed'])
        self.assertTrue(t.step(1.0 + fs.RosterTracker.FAIL_OPEN_S + 0.1, 1, 5, None)['confirmed'])   # 打ち切り（記録を止め続けない）
        self.assertEqual(t.fail_open_count, 1)
        self.assertEqual(sum(1 for l in logs if '進まない' in l), 1)

    def test_counter_bumped_before_session_change_observed_is_fail_open_not_permanent(self):
        t, _ = self.mk()
        t.set_from([{'car_idx': 0, 'car_number': '1', 'class_id': 1}], 'sub:1', 0, 5, 'parse')
        t.step(0.0, 0, 5, None)
        r = t.step(1.0, 1, 6, lambda: self.got(6, session=1))        # 番号は先に進んでいた：refreshで新名簿を得るが「変更時の番号」と同じ
        self.assertFalse(r['confirmed'])
        self.assertTrue(t.step(1.0 + fs.RosterTracker.FAIL_OPEN_S + 0.1, 1, 6, None)['confirmed'])

    def test_unrelated_counter_bumps_in_steady_state_keep_confirmed(self):
        """結果更新などで番号が増え続けても、名簿は同じステップで読み直され、確認が途切れない。"""
        t, _ = self.mk()
        t.set_from([{'car_idx': 0, 'car_number': '1', 'class_id': 1}], 'sub:1', 0, 5, 'parse')
        for k in range(1, 50):
            r = t.step(float(k), 0, 5 + k, lambda k=k: self.got(5 + k))
            self.assertTrue(r['confirmed'], k)
        self.assertEqual(t.refreshes, 49)


class RefreshHelper(unittest.TestCase):
    def reader(self, u0, u1, yaml):
        class R:
            def __init__(s):
                s.calls = 0
            def session_info_update(s):
                s.calls += 1
                return u0 if s.calls == 1 else u1
            def read_session_info(s):
                return yaml
            def read_int(s, name):
                return 3
        return R()

    def test_double_read_mismatch_returns_none(self):
        import bridge
        self.assertIsNone(bridge._field_roster_refresh(self.reader(10, 11, session_info(n=2)), 'fb'))

    def test_matching_reads_return_roster_and_update(self):
        import bridge
        got = bridge._field_roster_refresh(self.reader(10, 10, session_info(n=2)), 'fb')
        self.assertEqual((got['update'], got['session_num']), (10, 3))
        self.assertEqual(len(got['drivers']), 2)
        self.assertEqual(got['race_id'], 'sub:101000')

    def test_unreadable_update_still_refreshes_and_empty_yaml_is_none(self):
        import bridge
        got = bridge._field_roster_refresh(self.reader(None, None, session_info(n=2)), 'fb')
        self.assertIsNotNone(got)
        self.assertIsNone(got['update'])
        self.assertIsNone(bridge._field_roster_refresh(self.reader(1, 1, ''), 'fb'))


class SessionInfoUpdateRealReader(unittest.TestCase):
    def test_reads_header_offset_12_from_independent_image(self):
        import bridge
        mem = ctypes.create_string_buffer(256)
        struct.pack_into('i', mem, 12, 4242)      # 公開ヘッダ構造：sessionInfoUpdate は offset 12
        struct.pack_into('i', mem, 16, 524288)
        r = bridge.IRacingReader()
        self.assertIsNone(r.session_info_update())            # 未接続はNone
        r._ptr = ctypes.addressof(mem)
        self.assertEqual(r.session_info_update(), 4242)
        struct.pack_into('i', mem, 12, 4243)
        self.assertEqual(r.session_info_update(), 4243)


class RealBridgeRosterGeneration(unittest.TestCase):
    """R7：実 poll_iracing を通す。名簿(とSubSessionID)だけが変わるケース、YAML更新がSessionNumより遅れるケース、更新番号が読めないケース。"""
    D1 = None

    def _run(self, *, n, info_at, sess_at, sub2=202000, spf=1.0, frame_extra=None, same_session=False):
        info1 = session_info(n=4)
        info2 = session_info(n=4, classes={2: 200, 3: 200}, extra_sub=sub2).replace('CarNumber: "3"', 'CarNumber: "77"').replace('CarNumber: "4"', 'CarNumber: "88"')
        orig = rh.FakeReader.read_session_info
        rh.FakeReader.read_session_info = lambda self_: info2 if self_.cursor >= info_at else info1
        try:
            fr = []
            for i in range(n):
                sn = 0 if (same_session or i < sess_at) else 1
                f = rh.make_frame(SessionTime=100.0 + i, SessionNum=sn, CarIdxLap=[3] * 4, CarIdxLapCompleted=[2] * 4, CarIdxLapDistPct=[0.1, 0.2, 0.3, 0.4],
                                  CarIdxPosition=[1, 2, 3, 4], CarIdxClassPosition=[1, 2, 3, 4], CarIdxOnPitRoad=[0] * 4, CarIdxTrackSurface=[3] * 4, CarIdxEstTime=[1, 2, 3, 4],
                                  CarIdxF2Time=[0, 1, 2, 3], CarIdxLastLapTime=[100] * 4)
                if frame_extra:
                    f.update(frame_extra(i))
                fr.append(f)
            return rh.replay(fr, session_info=info1, keep_field_logs=True, seconds_per_frame=spf)
        finally:
            rh.FakeReader.read_session_info = orig

    @staticmethod
    def wrong_valid(sent, after_seq=0):
        """切替(after_seq)より後なのに、旧名簿(ゼッケン3/4)または旧race idを持つ有効行。"""
        return [s for s in sent if s['seq'] > after_seq and (any(c['no'] in ('3', '4') for c in s['cars'] if c['i'] in (2, 3)) or s['race_instance_id'] == 'sub:101000')]

    def test_C_same_session_num_roster_and_race_change(self):
        r = self._run(n=130, info_at=5, sess_at=0, same_session=True)
        try:
            sent = snaps_of(r)
            after = [s for s in sent if s['seq'] > 5]
            self.assertTrue(after)
            self.assertFalse([s for s in after if any(c['no'] in ('3', '4') for c in s['cars'] if c['i'] in (2, 3))], 'SessionNum不変でも旧名簿の有効行が出る')
            self.assertFalse([s for s in after if s['race_instance_id'] == 'sub:101000'])
            self.assertTrue(any(s['race_instance_id'] == 'sub:202000' and s['cars'][2]['no'] == '77' for s in after))
            self.assertTrue(any('FIELD ROSTER: via=refresh' in l for l in r.logs))
        finally:
            r.field_tmp.cleanup()

    def test_B2_yaml_lags_session_num_within_fail_open(self):
        """YAML(と更新番号)がSessionNumより約15秒遅れ、約10秒ごとの再解析がその遅れの区間に当たっても、旧名簿の有効行は0。"""
        r = self._run(n=260, info_at=105, sess_at=5, spf=0.05)
        try:
            sent = snaps_of(r)
            wv = self.wrong_valid(sent, after_seq=5)
            self.assertFalse(wv, [(s['seq'], s['session_num'], s['race_instance_id']) for s in wv][:3])
            # 再解析が遅れの区間(101ループ目)に当たっていること＝このテストが穴を突いている証拠
            self.assertTrue(any(l.startswith('FIELD ROSTER: via=parse') for l in r.logs))
            self.assertTrue([s for s in sent if s['session_num'] == 1], '新セッションの有効行が出ていない')
            logged = file_snaps(r)
            self.assertTrue([s for s in logged if s['gen'] == 'identity_stale'])
        finally:
            r.field_tmp.cleanup()

    def test_counter_unreadable_degrades_to_session_rule_and_keeps_recording(self):
        r = self._run(n=130, info_at=5, sess_at=5, frame_extra=lambda i: {'_si_update_none': True})
        try:
            sent = snaps_of(r)
            self.assertTrue(sent)                                  # 全車staleにして止めない
            self.assertFalse(self.wrong_valid(sent, after_seq=5))  # SessionNum規則は効いている（再解析まで旧名簿の行を出さない）
            self.assertEqual(sum(1 for l in r.logs if '読めない' in l and 'FIELD ROSTER' in l), 1)
            self.assertTrue(all(s['roster_update'] is None for s in sent))
        finally:
            r.field_tmp.cleanup()

    def test_counter_never_changes_logs_suspicion_and_does_not_stall(self):
        """offset 12 が更新を反映していない場合：SessionNum変更後に打ち切り、診断ログを1回出す。記録は止まらない。"""
        r = self._run(n=200, info_at=5, sess_at=5, spf=0.5, frame_extra=lambda i: {'_si_update': 7})
        try:
            self.assertEqual(sum(1 for l in r.logs if 'FIELD ROSTER: SessionNum変更後' in l), 1)
            sent = snaps_of(r)
            self.assertTrue([s for s in sent if s['session_num'] == 1])
        finally:
            r.field_tmp.cleanup()

    def test_steady_state_with_bumping_counter_never_goes_stale(self):
        r = self._run(n=60, info_at=10**9, sess_at=10**9, same_session=True, frame_extra=lambda i: {'_si_update': 100 + i})
        try:
            logged = file_snaps(r)
            self.assertEqual(len(logged), 60)
            self.assertTrue(all(s['ok'] for s in logged))          # 結果更新で番号が毎フレーム増えても確認が途切れない
            self.assertLess(sum(1 for l in r.logs if 'FIELD ROSTER' in l), 5)   # 番号が毎回増えても、名簿ログは内容が変わった時と60秒ごとだけ
        finally:
            r.field_tmp.cleanup()

    def test_header_records_roster_update(self):
        r = self._run(n=5, info_at=10**9, sess_at=10**9, same_session=True)
        try:
            hdr = fs.parse_log(os.path.join(r.field_log_dir, r.field_files[0]))['header']
            self.assertEqual(hdr['roster_update'], 1)
            self.assertTrue(all(s['roster_update'] == 1 for s in snaps_of(r)))
        finally:
            r.field_tmp.cleanup()


class RecorderCaps(unittest.TestCase):
    def snap(self, i):
        return {'type': 'field_snapshot', 'seq': i, 'ok': True, 'cars': [{'i': k, 'p': k} for k in range(26)], 'events': []}

    def test_rotation_keeps_beginning(self):
        with tempfile.TemporaryDirectory() as d:
            rec = fs.FieldRecorder(d, 'T', file_max_bytes=2000, run_soft=10**9, run_hard=10**9)
            for i in range(1, 40):
                rec.put(self.snap(i), periodic=False)
                rec.flush_wait()
            rec.close()
            names = sorted(os.listdir(d))
            self.assertGreater(len(names), 2)
            first = fs.parse_log(os.path.join(d, names[0]))
            self.assertEqual(first['snapshots'][0]['seq'], 1)          # 冒頭が残る
            allseq = [s['seq'] for n in names for s in fs.parse_log(os.path.join(d, n))['snapshots']]
            self.assertEqual(allseq, list(range(1, 40)))              # 欠けなし
            self.assertTrue(all(fs.parse_log(os.path.join(d, n))['header'] for n in names))

    def test_soft_cap_decimates_periodic_but_keeps_events(self):
        with tempfile.TemporaryDirectory() as d:
            rec = fs.FieldRecorder(d, 'T', run_soft=1500, run_hard=10**9)
            for i in range(1, 12):
                rec.put(self.snap(i), periodic=False); rec.flush_wait()
            before = rec.stats()['lines']
            for i in range(100, 150):
                rec.put(self.snap(i), periodic=True)
            rec.flush_wait()
            ev_ok = rec.put(self.snap(999), periodic=False)
            rec.flush_wait(); rec.close()
            st = rec.stats()
            self.assertTrue(ev_ok)
            self.assertGreater(st['dropped_decimated'], 30)
            self.assertLess(st['lines'] - before, 20)

    def test_hard_cap_stops_with_marker_and_keeps_head(self):
        with tempfile.TemporaryDirectory() as d:
            rec = fs.FieldRecorder(d, 'T', run_soft=10**9, run_hard=3000)
            for i in range(1, 60):
                rec.put(self.snap(i), periodic=False); rec.flush_wait(0.3)
            rec.close()
            self.assertEqual(rec.stats()['stopped'], 'run_cap')
            parsed = [fs.parse_log(os.path.join(d, n)) for n in sorted(os.listdir(d))]
            self.assertEqual(parsed[0]['snapshots'][0]['seq'], 1)
            self.assertTrue(any(m.get('reason') == 'run_cap' for p in parsed for m in p['markers']))

    def test_same_stamp_restart_opens_next_free_part(self):
        """R5：同じstampで再起動しても既存ファイルへ追記しない。"""
        with tempfile.TemporaryDirectory() as d:
            for epoch in ('A', 'B'):
                rec = fs.FieldRecorder(d, 'SAME')
                for i in range(1, 4):
                    rec.put({'type': 'field_snapshot', 'seq': i, 'ok': True, 'bridge_process_epoch': epoch, 'cars': [], 'events': []}, periodic=False)
                rec.flush_wait(); rec.close()
            names = sorted(os.listdir(d))
            self.assertEqual(names, ['OMORAY-field-SAME-p01.jsonl', 'OMORAY-field-SAME-p02.jsonl'])
            for n, ep in zip(names, 'AB'):
                p = fs.parse_log(os.path.join(d, n))
                self.assertEqual({x['bridge_process_epoch'] for x in p['snapshots']}, {ep})
                self.assertEqual(p['header']['part'], int(n[-8:-6]))

    def test_write_error_stops_after_repeats_without_raising(self):
        calls = {'n': 0}

        def boom(path, data):
            calls['n'] += 1
            raise OSError(28, 'No space left on device')
        with tempfile.TemporaryDirectory() as d:
            rec = fs.FieldRecorder(d, 'T', writer=boom)
            for i in range(1, 12):
                rec.put(self.snap(i), periodic=False); rec.flush_wait(0.3)
            rec.close()
            st = rec.stats()
            self.assertEqual(st['stopped'], 'write_failed')
            self.assertGreaterEqual(st['write_failures'], 5)
            self.assertIn('No space', st['last_error'])

    def test_blocked_writer_never_blocks_caller(self):
        gate = threading.Event()

        def slow(path, data):
            gate.wait(5)
        with tempfile.TemporaryDirectory() as d:
            rec = fs.FieldRecorder(d, 'T', writer=slow, queue_max=32)
            t0 = time.perf_counter()
            for i in range(1, 2001):
                rec.put(self.snap(i), periodic=False)
            elapsed = time.perf_counter() - t0
            st = rec.stats()
            gate.set()
            rec.close(1.0)
            self.assertLess(elapsed, 0.5)                      # 書込みが詰まっても呼び出し側は待たない
            self.assertGreater(st['dropped_queue_full'], 1900)  # 溢れは数えて捨てる


class PipelineLatency(unittest.TestCase):
    def test_step_cost_is_small_with_26_cars(self):
        n = 26
        roster = {i: {'number': str(i), 'class_id': 100 + (i % 3)} for i in range(n)}

        class R:
            def read_field_arrays(self, names, count=64):
                return {'tick': 1, 'consistent': True, 'session_time': 1.0, 'arrays': {k: ([1] * 64 if k not in fs.FLOAT_ARRAYS else [0.5] * 64) for k in names}}
        with tempfile.TemporaryDirectory() as d:
            rec = fs.FieldRecorder(d, 'T')
            pipe = fs.FieldPipeline(rec)
            t0 = time.perf_counter()
            for i in range(300):
                pipe.step(R(), now=float(i), ctx={'race_instance_id': 'x', 'session_num': 0, 'epoch': 'e', 'frame_sequence': i}, roster=roster, player_idx=0)
            per = (time.perf_counter() - t0) / 300
            rec.flush_wait(); rec.close()
            self.assertLess(per, 0.005)                          # 1回あたり 5ms 未満（実測は別途）


if __name__ == '__main__':
    unittest.main(verbosity=2)
