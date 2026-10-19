"""WO020 — bounded, allowlisted Bridge trace for canonical lifecycle publications and the
staged critical events/ACKs that follow them.

Observation only: the poll loop calls `lifecycle()` after a canonical snapshot was broadcast and
`dispatch()` after each staged event's real broadcast result is known. Nothing in strategy,
authority or delivery reads this object.

- Native ids only (race_instance_id, session_num, bridge_process_epoch, snapshot id/sequence,
  source_frame_sequence, decision_id, revision, phase, pit_event_id, driver_pit_sequence,
  command_id, box attempt/proof). Missing stays None; nothing is minted to join records.
- A lifecycle line is emitted only when its identity tuple changes (not every 0.1 s frame), so
  the log volume follows real transitions.
- No wall-clock/session-time latency is computed here. session_time_s is reported as the
  Bridge's own observation only.
- Bounded ring (`max_events`), counters for everything dropped/suppressed.
- No text: radio messages, Driver reason text, and command text have no field to land in.

The emitted line is `[TRACE] <compact json>` through the Bridge's normal `log()`, which Desktop
main.js already appends to the session log that the Support log export reads.
"""
import collections
import json
import re

SCHEMA = 'pitwall.bridge_trace.v1'
_TOKEN = re.compile(r'^[A-Za-z0-9_.:|#\-]{1,192}$')


def _tok(v):
    return v if isinstance(v, str) and _TOKEN.match(v) else None


def _int(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and abs(v) < 10 ** 12 else None


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float('inf') else None


class BridgeTrace:
    LIFECYCLE_KEYS = ('race_instance_id', 'session_num', 'bridge_process_epoch', 'decision_id', 'revision', 'phase',
                      'pit_event_id', 'driver_pit_sequence', 'box_attempt_id', 'gate_reason')

    def __init__(self, emit=None, max_events=256, max_tracked=128):
        self._emit = emit
        self.events = collections.deque(maxlen=max_events)
        self._seq = 0
        self._last_lifecycle = None
        self.max_tracked = max_tracked
        self._record_state = collections.OrderedDict()   # decision_id -> last traced state (bounded)
        self._pit_state = collections.OrderedDict()      # pit_event_id -> last traced state (bounded)
        self.counters = collections.Counter()

    def _push(self, event):
        self._seq += 1
        event['schema'] = SCHEMA
        event['seq'] = self._seq
        if len(self.events) == self.events.maxlen:
            self.counters['events_evicted'] += 1
        self.events.append(event)
        self.counters['emitted'] += 1
        if self._emit is not None:
            try:
                self._emit('[TRACE] ' + json.dumps(event, separators=(',', ':'), sort_keys=True, ensure_ascii=True))
            except Exception:
                self.counters['emit_failed'] += 1

    def lifecycle(self, wire):
        """Canonical snapshot wire (already broadcast). Emits on identity change only."""
        if not isinstance(wire, dict):
            self.counters['lifecycle_invalid'] += 1
            return None
        life = wire.get('lifecycle') or {}
        active = life.get('active') or {}
        ledger = wire.get('pit_ledger') or {}
        last_event = ledger.get('last_event') or {}
        box = wire.get('box_delivery') or {}
        execution = wire.get('execution') or {}
        facts = wire.get('race_facts') or {}
        frame = wire.get('source_frame') or {}
        row = {
            'k': 'lifecycle',
            'race_instance_id': _tok(wire.get('race_instance_id')),
            'session_num': _int(wire.get('session_num')),
            'bridge_process_epoch': _tok(wire.get('bridge_process_epoch')),
            'snapshot_id': _tok(wire.get('snapshot_id')),
            'snapshot_sequence': _int(wire.get('snapshot_sequence')),
            'source_frame_sequence': _int(frame.get('sequence')),
            'session_time_s': _num(frame.get('session_time_s')),
            'decision_id': _tok(active.get('decision_id')),
            'revision': _int(active.get('revision')),
            'phase': _tok(active.get('phase')),
            'pit_event_id': _tok(last_event.get('pit_event_id')),
            'driver_pit_sequence': _int(facts.get('driver_pit_sequence')),
            'recorded_event_count': _int(ledger.get('recorded_event_count')),
            'box_attempt_id': _tok(box.get('allowed_attempt_id')),
            'gate_reason': _tok(execution.get('gate_reason')),
        }
        observed = {k: row[k] for k in ('race_instance_id', 'session_num', 'bridge_process_epoch', 'snapshot_id',
                                        'snapshot_sequence', 'source_frame_sequence', 'session_time_s')}
        # Per-record / per-pit-event transitions are traced from the records themselves (active,
        # awaiting and terminal views with their own phase / reason / pit ref), never inferred from
        # "active disappeared".
        self._records(life, observed)
        self._pit_events(ledger, observed)
        key = tuple(row[k] for k in self.LIFECYCLE_KEYS)
        if key == self._last_lifecycle:
            self.counters['lifecycle_unchanged'] += 1
            return None
        prev = self._last_lifecycle
        row['changed'] = [k for i, k in enumerate(self.LIFECYCLE_KEYS) if prev is None or prev[i] != key[i]]
        self._last_lifecycle = key
        self._push(row)
        return row

    def _remember(self, store, key, value):
        """Bounded change detector: True when `value` is new for `key`."""
        if store.get(key) == value:
            return False
        if key not in store and len(store) >= self.max_tracked:
            store.popitem(last=False)
            self.counters['tracked_evicted'] += 1
        store[key] = value
        store.move_to_end(key)
        return True

    def _records(self, life, observed):
        views = []
        if isinstance(life.get('active'), dict):
            views.append(('active', life['active']))
        views += [('awaiting', r) for r in (life.get('awaiting') or []) if isinstance(r, dict)]
        views += [('terminal', r) for r in (life.get('terminal_records') or []) if isinstance(r, dict)]
        for slot, r in views:
            ref = r.get('terminal_event_ref') if isinstance(r.get('terminal_event_ref'), dict) else {}
            row = {
                'k': 'record', 'slot': slot,
                'decision_id': _tok(r.get('decision_id')), 'revision': _int(r.get('revision')),
                'phase': _tok(r.get('phase')), 'selected_plan': _tok(r.get('selected_plan')),
                'invalidated_reason': _tok(r.get('invalidated_reason')), 'execution_relation': _tok(r.get('execution_relation')),
                'terminal_pit_event_id': _tok(r.get('terminal_pit_event_id')),
                'terminal_event_pit_event_id': _tok(ref.get('pit_event_id')),
                'terminal_event_driver_pit_sequence': _int(ref.get('driver_pit_sequence')),
                'expected_pit_sequence': _int(r.get('expected_pit_sequence')),
                'resolved_pit_sequence': _int(r.get('resolved_pit_sequence')),
                'activation_frame': _int(r.get('activated_source_frame_sequence')),
                'target_lap': _int(r.get('target_lap')),
            }
            if row['decision_id'] is None:
                self.counters['record_without_decision_id'] += 1
                continue
            value = tuple(row[k] for k in ('revision', 'phase', 'invalidated_reason', 'execution_relation',
                                           'terminal_pit_event_id', 'resolved_pit_sequence', 'target_lap', 'slot'))
            if self._remember(self._record_state, row['decision_id'], value):
                row.update(observed)
                self._push(row)

    def _pit_events(self, ledger, observed):
        for e in ledger.get('events') or []:
            if not isinstance(e, dict):
                continue
            pen = e.get('penalty_evidence') if isinstance(e.get('penalty_evidence'), dict) else {}
            plan = e.get('plan_reference') if isinstance(e.get('plan_reference'), dict) else {}
            row = {
                'k': 'pit_event', 'pit_event_id': _tok(e.get('pit_event_id')),
                'driver_pit_sequence': _int(e.get('driver_pit_sequence')),
                'execution_relation': _tok(e.get('execution_relation')),
                'classification_reason': _tok(e.get('classification_reason')),
                'penalty_state': _tok(pen.get('state')), 'penalty_source_frame_sequence': _int(pen.get('source_frame_sequence')),
                'plan_decision_id': _tok(plan.get('decision_id')), 'plan_selected': _tok(plan.get('selected_plan')),
            }
            if row['pit_event_id'] is None:
                self.counters['pit_event_without_id'] += 1
                continue
            value = tuple(row[k] for k in ('driver_pit_sequence', 'execution_relation', 'classification_reason',
                                           'penalty_state', 'plan_decision_id'))
            if self._remember(self._pit_state, row['pit_event_id'], value):
                row.update(observed)
                self._push(row)

    def dispatch(self, event, result, wire=None):
        """A staged critical event (radio/ACK) after its real broadcast/drop/hold result."""
        if not isinstance(event, dict):
            self.counters['dispatch_invalid'] += 1
            return None
        origin = event.get('origin_record_ref') or {}
        box = event.get('box_attempt') if isinstance(event.get('box_attempt'), dict) else {}
        w = wire if isinstance(wire, dict) else {}
        revision = event.get('expected_revision')
        if revision is None:
            revision = origin.get('revision') if origin.get('revision') is not None else box.get('plan_revision')
        row = {
            'k': 'dispatch',
            'type': _tok(event.get('type')),
            'trigger': _tok(event.get('trigger')),
            'result': _tok(result if isinstance(result, str) else str(result)),
            'race_instance_id': _tok(event.get('race_instance_id') or w.get('race_instance_id')),
            'session_num': _int(event.get('session_num') if event.get('session_num') is not None else w.get('session_num')),
            'bridge_process_epoch': _tok(event.get('bridge_process_epoch') or w.get('bridge_process_epoch')),
            # Two different references, never paired across: the publication this dispatch went
            # out with (current wire) and the canonical ref the event itself carries (an ACK
            # echoes its request's ref; a radio carries its own publication ref).
            'publication_snapshot_id': _tok(w.get('snapshot_id')),
            'publication_snapshot_sequence': _int(w.get('snapshot_sequence')),
            'event_canonical_snapshot_id': _tok(event.get('canonical_snapshot_id')),
            'event_canonical_snapshot_sequence': _int(event.get('canonical_snapshot_sequence')),
            'session_time_s': _num((w.get('source_frame') or {}).get('session_time_s')),
            'decision_id': _tok(event.get('decision_id') or origin.get('decision_id')),
            'revision': _int(revision),
            'command_id': _tok(event.get('command_id')),
            'reason_event_id': _tok(event.get('reason_event_id')),
            'intent': _tok(event.get('intent')),
            'outcome': _tok(event.get('outcome')),
            'lifecycle_phase': _tok(event.get('lifecycle_phase')),
            'result_revision': _int(event.get('result_revision')),
            'successor_decision_id': _tok(event.get('successor_decision_id')),
            'successor_revision': _int(event.get('successor_revision')),
            'box_attempt_id': _tok(box.get('attempt_id')),
            'proof_id': _tok(box.get('proof_id')),
            'driver_pit_sequence': _int(event.get('driver_pit_sequence') if event.get('driver_pit_sequence') is not None else box.get('driver_pit_sequence')),
            'source_frame_sequence': _int(event.get('source_frame_sequence')),
        }
        self.counters['dispatch:' + str(row['type']) + ':' + str(row['result'])] += 1
        self._push(row)
        return row

    def snapshot(self):
        return {'schema': SCHEMA, 'limits': {'events': self.events.maxlen}, 'counters': dict(self.counters),
                'events': [dict(e) for e in self.events]}


def selfcheck():
    """Deterministic synthetic fixture (labelled as such) for the CI artifact: proves the bound,
    change-only emission and the allowlist without any product state."""
    lines = []
    t = BridgeTrace(emit=lines.append, max_events=8)
    base = {'race_instance_id': 'synthetic-race', 'session_num': 2, 'bridge_process_epoch': 'synthetic-epoch',
            'snapshot_id': 'synthetic-epoch:1', 'snapshot_sequence': 1, 'source_frame': {'sequence': 10, 'session_time_s': 100.0},
            'lifecycle': {'active': {'decision_id': 'd1', 'revision': 0, 'phase': 'active'}}, 'pit_ledger': {}, 'box_delivery': {},
            'execution': {'gate_reason': None}, 'race_facts': {'driver_pit_sequence': 0}}
    for i in range(20):
        w = json.loads(json.dumps(base))
        w['snapshot_sequence'] = i + 1
        w['source_frame']['sequence'] = 10 + i
        if i >= 10:
            w['lifecycle']['active']['revision'] = 1
        t.lifecycle(w)
    t.dispatch({'type': 'driver_plan_command_ack', 'command_id': 'c1', 'intent': 'pit_now', 'outcome': 'applied',
                'text': 'must not appear', 'reason_text': 'must not appear'}, 'DISPATCHED', base)
    for i in range(10):
        t.dispatch({'type': 'radio', 'trigger': 'fuel_warning', 'message': 'must not appear'}, 'DISPATCHED', base)
    snap = t.snapshot()
    blob = json.dumps(snap) + '\n'.join(lines)
    return {'synthetic_fixture': True, 'lifecycle_emitted': sum(1 for l in lines if '"k":"lifecycle"' in l),
            'lifecycle_unchanged': snap['counters'].get('lifecycle_unchanged', 0), 'events_kept': len(snap['events']),
            'events_evicted': snap['counters'].get('events_evicted', 0), 'text_leaked': 'must not appear' in blob,
            'snapshot': snap}
