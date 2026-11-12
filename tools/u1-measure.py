#!/usr/bin/env python3
"""U1 計測：ログ量／WS量／CPU／イベント重複／安全コール配送（旧新比較）。実 bridge.poll_iracing() を replay_harness で回す。
  python3 tools/u1-measure.py [outfile.json]
各条件は別プロセスで走らせる（bridgeのモジュール状態を持ち越さない）。
  safety: tests_bridge_poll_replay.clean_laps(30) の全broadcast（field_snapshot除く）を、
          旧(Build306 tree)／新(記録OFF)／新(記録ON)／新(記録ON・書込み詰まり) で比較する。
"""
import json, os, subprocess, sys, time, statistics
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLD = os.environ.get('U1_OLD_ROOT', '/tmp/str001-b306')


def child(mode, tree, extra_env, out):
    env = dict(os.environ, **extra_env)
    subprocess.run([sys.executable, os.path.abspath(__file__), '--child', mode, tree, out], check=True, env=env)
    return json.load(open(out))


# STR-001のon_pit追加分と、実行ごとに変わる値（所要ms・乱数ID）だけを外して比較する。判断・発話・順序・本文は外さない。
NOISE = {'on_pit', 'on_pit_frame', 'on_pit_observed_at', 'write_ms', 'proof_id', 'attempt_id', 'allowed_attempt_id', 'allowed_proof_id'}


def strip(o):
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if k not in NOISE}
    if isinstance(o, list):
        return [strip(x) for x in o]
    return o


def run_child(mode, tree, out):
    sys.path.insert(0, os.path.join(tree, 'irsdk-bridge'))
    sys.path.insert(0, os.path.join(ROOT, 'irsdk-bridge')) if tree == ROOT else None
    import replay_harness as rh
    if mode == 'safety':
        import tests_bridge_poll_replay as P
        frames, *_ = P.clean_laps(30)
        if os.environ.get('U1_BLOCK_WRITER') == '1':
            import field_snapshot as fs
            import threading
            gate = threading.Event()
            orig = fs.FieldRecorder.__init__
            def patched(self, *a, **k):
                k['writer'] = lambda p, d: gate.wait(30)
                orig(self, *a, **k)
            fs.FieldRecorder.__init__ = patched
        stamps = []
        t0 = time.perf_counter()
        r = rh.replay(frames, on_frame_ready=lambda c, f, res: stamps.append(time.perf_counter()))
        wall_total = time.perf_counter() - t0
        poll_s = stamps[-1] - stamps[0] if len(stamps) > 1 else 0.0       # 最初〜最後のframe開始（終了時のflush待ちを含まない）
        gaps = sorted((b - a) * 1000 for a, b in zip(stamps, stamps[1:]))
        import canonical_lifecycle_snapshot as cm
        non = [strip(b) for b in r.broadcasts if b.get('type') != 'field_snapshot']
        text = json.dumps(non, default=str, sort_keys=True).replace(cm.PROCESS_EPOCH, 'EPOCH')   # プロセスごとに変わるepochだけ正規化
        fieldn = sum(1 for b in r.broadcasts if b.get('type') == 'field_snapshot')
        json.dump({'broadcasts': json.loads(text), 'field_snapshots': fieldn, 'wall_s': poll_s, 'wall_total_s': wall_total, 'frames': r.frames_served,
                   'frame_ms_median': round(gaps[len(gaps) // 2], 3), 'frame_ms_p99': round(gaps[int(len(gaps) * 0.99)], 3), 'frame_ms_max': round(max(gaps), 3)}, open(out, 'w'), default=str)
        if os.environ.get('U1_BLOCK_WRITER') == '1':
            os._exit(0)   # 詰まった書込みスレッドを待たずに終える
    elif mode == 'big':
        sys.path.insert(0, os.path.join(ROOT, 'tools'))
        import importlib.util
        spec = importlib.util.spec_from_file_location('dump', os.path.join(ROOT, 'tools', 'u1-dump-replay.py'))
        d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
        n_cars = int(os.environ.get('U1_CARS', '26')); n_frames = int(os.environ.get('U1_FRAMES', '600'))
        fr, info = d.scenario_big(n_frames, n_cars)
        t0 = time.perf_counter()
        r = rh.replay(fr, session_info=info, keep_field_logs=True)
        wall = time.perf_counter() - t0
        sent = [b for b in r.broadcasts if b.get('type') == 'field_snapshot']
        size = sum(os.path.getsize(os.path.join(r.field_log_dir, f)) for f in r.field_files) if r.field_files else 0
        ws_bytes = sum(len(json.dumps(b)) for b in sent)
        ev_rows = sum(1 for s in sent if s['events'])
        dup = 0
        for a, b in zip(sent, sent[1:]):
            if set(a['events']) & set(b['events']) - {'start'} and b['observed_at'] - a['observed_at'] < 1.0:
                dup += 1
        json.dump({'frames': r.frames_served, 'cars': n_cars, 'snapshots': len(sent), 'log_bytes': size, 'bytes_per_snapshot': round(size / max(1, len(sent)), 1),
                   'ws_bytes_total': ws_bytes, 'ws_bytes_per_snapshot': round(ws_bytes / max(1, len(sent)), 1), 'event_rows': ev_rows, 'dup_event_rows_within_1s': dup,
                   'replay_wall_s': wall, 'summary': r.field_summary}, open(out, 'w'), default=str)
        r.field_tmp.cleanup()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--child':
        run_child(sys.argv[2], sys.argv[3], sys.argv[4]); return
    res = {}
    tmp = os.environ.get('TMPDIR', '/tmp')
    # ── ログ量・WS量・イベント重複（26台/40台）──
    for cars, frames in ((26, 600), (26, 2700), (40, 600)):
        o = os.path.join(tmp, 'u1m_big_%d_%d.json' % (cars, frames))
        res['big_%dcars_%dframes' % (cars, frames)] = child('big', ROOT, {'U1_CARS': str(cars), 'U1_FRAMES': str(frames)}, o)
    # 1Hz の標本率換算（frames=秒）
    b = res['big_26cars_2700frames']
    res['projection'] = {'bytes_per_snapshot_26cars': b['bytes_per_snapshot'],
                         'MB_per_45min': round(b['bytes_per_snapshot'] * 2700 / 1e6, 1), 'MB_per_3h': round(b['bytes_per_snapshot'] * 10800 / 1e6, 1),
                         'ws_KB_per_s': round(b['ws_bytes_per_snapshot'] / 1000, 2)}
    # ── CPU：記録OFF／ON の1フレームあたり（3回の中央値）──
    walls = {}
    for label, env in (('off', {'PITWALL_FIELD_LOG': '0'}), ('on', {'PITWALL_FIELD_LOG': '1'})):
        ws = []
        for i in range(3):
            o = os.path.join(tmp, 'u1m_cpu_%s_%d.json' % (label, i))
            e = dict(env, U1_CARS='26', U1_FRAMES='600')
            ws.append(child('big', ROOT, e, o)['replay_wall_s'])
        walls[label] = ws
    res['cpu_replay_600frames_26cars_wall_s'] = {k: [round(x, 3) for x in v] for k, v in walls.items()}
    mo, mn = statistics.median(walls['off']), statistics.median(walls['on'])
    res['cpu_overhead_ms_per_frame_median'] = round((mn - mo) / 600 * 1000, 3)
    # ── 安全コール配送：旧／新OFF／新ON／新ON+書込み詰まり ──
    variants = {
        'old_build306': (OLD, {}),
        'new_log_off': (ROOT, {'PITWALL_FIELD_LOG': '0'}),
        'new_log_on': (ROOT, {'PITWALL_FIELD_LOG': '1'}),
        'new_log_on_writer_blocked': (ROOT, {'PITWALL_FIELD_LOG': '1', 'U1_BLOCK_WRITER': '1'}),
    }
    outs = {}
    for name, (tree, env) in variants.items():
        if not os.path.isdir(os.path.join(tree, 'irsdk-bridge')):
            outs[name] = None; continue
        outs[name] = child('safety', tree, env, os.path.join(tmp, 'u1m_safety_%s.json' % name))
    ref = outs['new_log_off']
    cmp = {}
    for name, o in outs.items():
        if o is None:
            cmp[name] = 'tree missing'; continue
        cmp[name] = {'non_field_broadcasts': len(o['broadcasts']), 'field_snapshots': o['field_snapshots'], 'poll_wall_s': round(o['wall_s'], 3), 'total_wall_incl_close_s': round(o['wall_total_s'], 3),
                     'frame_ms_median': o['frame_ms_median'], 'frame_ms_p99': o['frame_ms_p99'], 'frame_ms_max': o['frame_ms_max'],
                     'identical_to_new_log_off': o['broadcasts'] == ref['broadcasts'],
                     'triggers': sorted({(b.get('type'), b.get('trigger')) for b in o['broadcasts']}, key=str)[:12]}
    res['safety_delivery'] = cmp
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tmp, 'u1_measure.json')
    json.dump(res, open(out, 'w'), indent=1, default=str)
    print(json.dumps(res, indent=1, default=str))


if __name__ == '__main__':
    main()
