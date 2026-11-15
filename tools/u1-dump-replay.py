#!/usr/bin/env python3
"""U1：実 bridge.poll_iracing()（replay_harness）に合成SDKフレームを流し、送信されたfield_snapshotと実ファイル記録を書き出す。
Node側の通し検査（tests-u1-field-snapshot-e2e.js）と計測（tools/u1-measure.py）が使う。
  python3 tools/u1-dump-replay.py <scenario> <outdir>
scenario: normal | faults | switch | big
出力: <outdir>/sent.json（送信されたfield_snapshot）, <outdir>/logs/*.jsonl（実記録）, <outdir>/meta.json
"""
import json, os, shutil, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'irsdk-bridge'))
import replay_harness as rh
import tests_u1_field_snapshot as T


def scenario_normal():
    return T.frames_with(8), T.session_info(classes=T.CLASSES8)


def scenario_faults():
    base = T.arrays8()
    fr = []
    for i in range(14):
        a = {k: list(v) for k, v in base.items()}
        a['CarIdxOnPitRoad'][2] = 1 if i in (4, 5) else 0
        a['CarIdxTrackSurface'][7] = -1 if i in (6, 7) else 3
        if i >= 8:
            a['CarIdxLap'][5] = 7
            a['CarIdxLapCompleted'][5] = 6
        extra = {}
        if i == 2:
            extra['_field_inconsistent'] = True
        if i == 3:
            extra['_field_missing'] = ['CarIdxLapDistPct']
        fr.append(rh.make_frame(SessionTime=100.0 + i, **dict(a, **extra)))
    return fr, T.session_info(classes=T.CLASSES8)


def scenario_switch(n=130, switch_at=5):
    """session切替：SessionNumは切替の瞬間に変わり、名簿(SessionInfo)は約100ループ後に新しくなる。車2・3が新セッションでは別車。"""
    info1 = T.session_info(n=4)
    info2 = T.session_info(n=4, classes={2: 200, 3: 200}, extra_sub=202000).replace('CarNumber: "3"', 'CarNumber: "77"').replace('CarNumber: "4"', 'CarNumber: "88"')
    fr = [rh.make_frame(SessionTime=100.0 + i, SessionNum=(0 if i < switch_at else 1), CarIdxLap=[3] * 4, CarIdxLapCompleted=[2] * 4, CarIdxLapDistPct=[0.1, 0.2, 0.3, 0.4],
                        CarIdxPosition=[1, 2, 3, 4], CarIdxClassPosition=[1, 2, 3, 4], CarIdxOnPitRoad=[0] * 4, CarIdxTrackSurface=[3] * 4, CarIdxEstTime=[1, 2, 3, 4],
                        CarIdxF2Time=[0, 1, 2, 3], CarIdxLastLapTime=[100] * 4) for i in range(n)]
    rh.FakeReader.read_session_info = lambda self_: info2 if self_.cursor >= switch_at else info1
    return fr, info1


def scenario_big(n_frames=600, n_cars=26, spf=1.0):
    classes = {i: (100 if i % 3 else 200) for i in range(n_cars)}
    fr = []
    for k in range(n_frames):
        def arr(fill):
            return [fill] * 64
        lap = [5 + k // 90] * 64
        dist = [((i * 0.037 + k * 0.011) % 1.0) for i in range(64)]
        a = {
            'CarIdxLap': [l + (1 if dist[i] < 0.5 else 0) for i, l in enumerate(lap)],
            'CarIdxLapCompleted': [l - 1 for l in lap],
            'CarIdxLapDistPct': dist,
            'CarIdxPosition': [(i + 1) if i < n_cars else 0 for i in range(64)],
            'CarIdxClassPosition': [(i // 3 + 1) if i < n_cars else 0 for i in range(64)],
            'CarIdxOnPitRoad': [1 if (i == 5 and 100 <= k < 130) else 0 for i in range(64)],
            'CarIdxTrackSurface': [3 if i < n_cars else -1 for i in range(64)],
            'CarIdxEstTime': [10.0 + i for i in range(64)],
            'CarIdxF2Time': [float(i) for i in range(64)],
            'CarIdxLastLapTime': [100.0 + i * 0.3 for i in range(64)],
        }
        fr.append(rh.make_frame(SessionTime=1000.0 + k * spf, **a))
    return fr, T.session_info(n=n_cars, classes=classes)


def main():
    name, out = sys.argv[1], sys.argv[2]
    kw = {}
    if name == 'normal':
        fr, info = scenario_normal()
    elif name == 'faults':
        fr, info = scenario_faults()
    elif name == 'switch':
        fr, info = scenario_switch()
    elif name == 'big':
        fr, info = scenario_big(int(os.environ.get('U1_FRAMES', '600')), int(os.environ.get('U1_CARS', '26')))
    else:
        raise SystemExit('unknown scenario')
    os.makedirs(out, exist_ok=True)
    t0 = time.perf_counter()
    r = rh.replay(fr, session_info=info, keep_field_logs=True)
    wall = time.perf_counter() - t0
    sent = [b for b in r.broadcasts if b.get('type') == 'field_snapshot']
    json.dump(sent, open(os.path.join(out, 'sent.json'), 'w'))
    logs = os.path.join(out, 'logs')
    shutil.rmtree(logs, ignore_errors=True)
    shutil.copytree(r.field_log_dir, logs)
    meta = {'scenario': name, 'frames': r.frames_served, 'sent': len(sent), 'broadcast_total': len(r.broadcasts), 'summary': r.field_summary,
            'files': sorted(os.listdir(logs)), 'replay_wall_s': round(wall, 3),
            'other_types': sorted({b.get('type') or b.get('trigger') or '?' for b in r.broadcasts if b.get('type') != 'field_snapshot'})}
    json.dump(meta, open(os.path.join(out, 'meta.json'), 'w'), indent=1)
    r.field_tmp.cleanup()
    print(json.dumps({k: meta[k] for k in ('scenario', 'frames', 'sent', 'files')}))


if __name__ == '__main__':
    main()
