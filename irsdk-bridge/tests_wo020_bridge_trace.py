#!/usr/bin/env python3
"""WO020 — irsdk-bridge/observability_trace.py unit contract (deterministic, no IO).

The real poll-loop hooks (canonical publication / staged event dispatch / BOX dispatch) are
exercised end to end by tests_wo019_road_atlanta_e2e.py W01-W03/W05 and cut K22."""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import observability_trace as ot  # noqa: E402

PASS = FAIL = 0


def ok(name, cond, detail=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('✅ ' + name)
    else:
        FAIL += 1
        print('❌ %s %s' % (name, json.dumps(detail, ensure_ascii=False, default=str)[:600]))


def wire(seq=1, rev=0, phase='active', race='sub:1', epoch='ep1', pit=None, t=10.0):
    return {'race_instance_id': race, 'session_num': 0, 'bridge_process_epoch': epoch, 'snapshot_id': epoch + ':' + str(seq),
            'snapshot_sequence': seq, 'source_frame': {'sequence': seq, 'session_time_s': t},
            'lifecycle': {'active': {'decision_id': 'sub:1:initial:0:115.0:origin-x:decision-lap:5:sig-abc', 'revision': rev, 'phase': phase}},
            'pit_ledger': {'last_event': {'pit_event_id': pit} if pit else None, 'recorded_event_count': 1 if pit else 0},
            'box_delivery': {}, 'execution': {'gate_reason': None}, 'race_facts': {'driver_pit_sequence': 1 if pit else 0}}


lines = []
t = ot.BridgeTrace(emit=lines.append, max_events=5)
for i in range(30):
    t.lifecycle(wire(seq=i + 1))
LC = lambda: [json.loads(l[len('[TRACE] '):]) for l in lines if '"k":"lifecycle"' in l]
ok('identity unchanged across frames -> one lifecycle line + one record line', len(LC()) == 1 and len(lines) == 2
   and t.counters['lifecycle_unchanged'] == 29, (t.counters, lines))
t.lifecycle(wire(seq=31, rev=1))
t.lifecycle(wire(seq=32, rev=1, pit='pit:sub:1:1'))
t.lifecycle(wire(seq=33, rev=1, pit='pit:sub:1:1', race='sub:2'))
rows = LC()
ok('transitions emitted with changed keys', [r['changed'] for r in rows[1:]] == [['revision'], ['pit_event_id', 'driver_pit_sequence'], ['race_instance_id']], [r['changed'] for r in rows])
ok('long native decision id kept verbatim', rows[0]['decision_id'] == 'sub:1:initial:0:115.0:origin-x:decision-lap:5:sig-abc', rows[0])
ok('session time is an observation only (no latency fields)', 'session_time_s' in rows[0] and not any('latency' in k or k.endswith('_ms') for k in rows[0]), rows[0])

# Records: terminal phase/reason/pit ref come from the terminal record itself; awaiting traced;
# an active Plan that merely disappears (no terminal record) is NOT reported as any terminal.
lines.clear()
r = ot.BridgeTrace(emit=lines.append)
w1 = wire(seq=1)
w1['lifecycle']['awaiting'] = [{'decision_id': 'd-b', 'revision': 0, 'phase': 'awaiting_driver', 'selected_plan': 'B'}]
r.lifecycle(w1)
w2 = wire(seq=2)
did = w2['lifecycle']['active']['decision_id']
w2['lifecycle'] = {'active': None, 'awaiting': [], 'terminal_records': [
    {'decision_id': did, 'revision': 1, 'phase': 'invalidated', 'invalidated_reason': 'driver_early_pit', 'execution_relation': 'early',
     'terminal_pit_event_id': 'pit:sub:1:1', 'resolved_pit_sequence': 1, 'terminal_event_ref': {'pit_event_id': 'pit:sub:1:1', 'driver_pit_sequence': 1}}]}
w2['pit_ledger'] = {'events': [{'pit_event_id': 'pit:sub:1:1', 'driver_pit_sequence': 1, 'execution_relation': 'early',
    'classification_reason': 'declared_early', 'penalty_evidence': {'state': 'true', 'source_frame_sequence': 2},
    'plan_reference': {'decision_id': did, 'selected_plan': 'A'}}], 'last_event': {'pit_event_id': 'pit:sub:1:1'}, 'recorded_event_count': 1}
for i in range(5):
    r.lifecycle(w2)
w3 = wire(seq=3)
w3['lifecycle'] = {'active': None, 'awaiting': [], 'terminal_records': []}   # d-b vanished without a terminal record
r.lifecycle(w3)
rows = [json.loads(l[len('[TRACE] '):]) for l in lines]
rec = [x for x in rows if x['k'] == 'record']
term = [x for x in rec if x['slot'] == 'terminal']
pit = [x for x in rows if x['k'] == 'pit_event']
ok('terminal record traced with its own phase/reason/pit ref (once)', len(term) == 1 and term[0]['phase'] == 'invalidated'
   and term[0]['invalidated_reason'] == 'driver_early_pit' and term[0]['terminal_event_pit_event_id'] == 'pit:sub:1:1'
   and term[0]['terminal_event_driver_pit_sequence'] == 1 and term[0]['snapshot_sequence'] == 2, term)
ok('awaiting proposal traced', any(x['slot'] == 'awaiting' and x['decision_id'] == 'd-b' and x['phase'] == 'awaiting_driver' for x in rec), rec)
ok('pit event traced once with its plan reference and penalty evidence', len(pit) == 1 and pit[0]['plan_decision_id'] == did
   and pit[0]['penalty_state'] == 'true' and pit[0]['execution_relation'] == 'early', pit)
ok('vanished record is not reported as terminal (no inference)', not any(x['decision_id'] == 'd-b' and x['slot'] == 'terminal' for x in rec)
   and not any(x['decision_id'] == 'd-b' and x.get('phase') in ('invalidated', 'cancelled', 'executed') for x in rec), rec)
small = ot.BridgeTrace(emit=None, max_tracked=2)
for i in range(5):
    w = wire(seq=i + 1)
    w['lifecycle']['active']['decision_id'] = 'dec-%d' % i
    small.lifecycle(w)
ok('tracked record state bounded', len(small._record_state) == 2 and small.counters['tracked_evicted'] == 3, dict(small.counters))

# Dispatch refs: the echoed request ref and the current publication are separate pairs.
lines.clear()
d = ot.BridgeTrace(emit=lines.append)
cur = wire(seq=53)
row = d.dispatch({'type': 'driver_plan_command_ack', 'command_id': 'c-9', 'canonical_snapshot_id': 'ep1:52', 'canonical_snapshot_sequence': 52}, 'DISPATCHED', cur)
ok('publication vs echoed request refs kept as separate matching pairs', row['publication_snapshot_id'] == 'ep1:53' and row['publication_snapshot_sequence'] == 53
   and row['event_canonical_snapshot_id'] == 'ep1:52' and row['event_canonical_snapshot_sequence'] == 52 and 'snapshot_id' not in row, row)

lines.clear()
t.dispatch({'type': 'driver_plan_command_ack', 'command_id': 'c-1', 'intent': 'early_pit', 'outcome': 'applied', 'expected_revision': 0,
            'result_revision': 1, 'decision_id': 'd1', 'text': 'ピット入るぞ', 'reason_text': '燃費が苦しい'}, 'DISPATCHED', wire())
t.dispatch({'type': 'radio', 'trigger': 'strategy_plan_box_call', 'decision_id': 'd1', 'message': 'Box this lap. Set 13 liters.',
            'box_attempt': {'attempt_id': 'box-attempt:p1:1', 'proof_id': 'p1', 'plan_revision': 0, 'driver_pit_sequence': 0}}, 'DISPATCHED', wire())
t.dispatch({'type': 'driver_plan_command_ack', 'command_id': 'c-2'}, 'HELD_UNCOMMITTED', wire())
blob = '\n'.join(lines) + json.dumps(t.snapshot())
ok('no text fields leak', not any(x in blob for x in ('ピット入るぞ', '燃費が苦しい', 'Box this lap')), blob[-400:])
box = json.loads(lines[-2][len('[TRACE] '):])
ok('box dispatch native ids', box['box_attempt_id'] == 'box-attempt:p1:1' and box['proof_id'] == 'p1' and box['revision'] == 0 and box['result'] == 'DISPATCHED', box)
ok('held ACK recorded as held, not dispatched', json.loads(lines[-1][len('[TRACE] '):])['result'] == 'HELD_UNCOMMITTED')
ok('ring bounded with eviction count', len(t.snapshot()['events']) == 5 and t.counters['events_evicted'] == t.counters['emitted'] - 5, dict(t.counters))

bad = ot.BridgeTrace(emit=None)
bad.lifecycle(None)
bad.dispatch('x', 'DISPATCHED')
w = wire()
w['source_frame']['session_time_s'] = math.nan
w['race_instance_id'] = 'has spaces not an id'
r = bad.lifecycle(w)
ok('invalid input counted; NaN/free text -> None', bad.counters['lifecycle_invalid'] == 1 and bad.counters['dispatch_invalid'] == 1
   and r['session_time_s'] is None and r['race_instance_id'] is None, (dict(bad.counters), r))


def boom(_line):
    raise IOError('stdout closed')


b = ot.BridgeTrace(emit=boom)
b.lifecycle(wire())
ok('emit failure never raises, every failed emit counted', b.counters['emit_failed'] == b.counters['emitted'] >= 2, dict(b.counters))

sc = ot.selfcheck()
ok('selfcheck synthetic fixture', sc['synthetic_fixture'] and sc['lifecycle_emitted'] == 2 and not sc['text_leaked'] and sc['events_kept'] <= 8, {k: v for k, v in sc.items() if k != 'snapshot'})
print('WO020 bridge trace unit: %d passed / %d failed' % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
