#!/usr/bin/env python3
"""WO-019 — Road Atlanta red thread as ONE product E2E replay (one consultation, end to end).

review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md "WO-019 Revision1". One continuous real
`bridge.poll_iracing()` replay (Road Atlanta fixture frames, WO001 provenance) and ONE
persistent real Desktop renderer (irsdk-bridge/wo019_desktop_runtime.js: every renderer
script in one VM, real `server.js` child with the Anthropic SDK replaced by saved responses)
are joined by the real transport on both sides:

  Bridge -> Desktop : poll loop -> REAL `bridge.broadcast()` (activity/director/speech gates,
                      json.dumps) -> REAL `_broadcast_async()` -> fake socket -> renderer
                      `irBridge.onmessage` created by the REAL `connectBridge()`
  Desktop -> Bridge : renderer `irBridge.send()` -> fake socket -> REAL `bridge.handler()`
                      coroutine (cmd dispatch -> `_queue_*`) -> consumed by the SAME poll loop

Only iRacing SDK frames, sockets, clocks, DOM/storage, TTS audio, the PTT button edge and the
LLM provider are IO doubles. No paid API is reachable (the runtime refuses non-local fetch; the
SDK is stubbed). The Driver speaks only through the real `sendMsg` (same entry as STT text).

Harness correlation ids (`fixture-race-a/event-0NN`) and product ids (race_instance_id,
decision_id, command_id, pit_event_id, utterance_id, snapshot/source frame) are kept apart:
every product id asserted below is read from product output, never assigned by this file.

Modes (exit 0 = every expectation met, 1 = expectation failed, 2 = HARNESS_ERROR):
  (default)              all cases against WO019_PRODUCT_ROOT (default: this repo)
  --root DIR             same cases against another tree (must be a disposable overlay)
  --cuts                 guard cuts: each cut on a disposable overlay of this repo must turn
                         its target cases RED while the named controls stay GREEN
  --anchors              every cut anchor matches exactly once in the current source
  --scenario NAME        (internal) run one scenario, print its record
  --json FILE            write the machine-readable result

WO019_AI_RACE=1 runs the same cases with both SDK session IDs removed at
the reader boundary, and requires fallback canonical publications.

The proposal_unheard/interrupted/heard scenarios additionally use an explicitly
synthetic forecast-output seam solely to test delivery/consent. Their native
comparator/lifecycle/authority remain real. They do NOT demonstrate real undercut
profitability; tests_strategy_room_e2e.py leaves forecasting untouched.

LLM meaning is a SAVED response: these cases prove the machine connection (what reaches the
provider request and what is spoken), not the semantic quality of a real model.
"""
import asyncio
import concurrent.futures
import importlib.util
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time as _time
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
# WO019_PRODUCT_ROOT runs the SAME harness against another product tree (before/after/cut).
PRODUCT_ROOT = os.path.abspath(os.environ.get('WO019_PRODUCT_ROOT') or REPO)
PRODUCT_BRIDGE = os.path.join(PRODUCT_ROOT, 'irsdk-bridge')
for _p in (HERE, PRODUCT_BRIDGE):
    if _p in sys.path:
        sys.path.remove(_p)
sys.path.insert(0, PRODUCT_BRIDGE)  # product modules (bridge and everything it imports)

import bridge  # noqa: E402


def _load_harness(name):
    """Harness modules always come from THIS checkout (same IO doubles for every tree)."""
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


rh = _load_harness('replay_harness')
road = _load_harness('tests_wo001_road_atlanta_fixture')
wo018 = _load_harness('tests_wo018_debrief_outcomes')

RUNTIME_JS = os.path.join(HERE, 'wo019_desktop_runtime.js')
WO019_OVERLAY_MARKER = '.wo019-disposable-overlay'
OWNER = {'id': 'wo019-driver-1', 'name': 'Test Driver', 'email': 'wo019@example.invalid'}
NEXT_RACE_SUB_SESSION_ID = 992001178
REPLAY_CLOCK_BASE_MS = 1_700_000_000_000   # replay_harness._ReplayClock default base


def _free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class HarnessError(Exception):
    """Harness/IO failure — never counted as a finding reproduction or a pass."""


# ══════════════════════════════════════════════════════════════════════
# Bridge side of the socket: the real handler coroutine on a private loop
# ══════════════════════════════════════════════════════════════════════

class FakeServerSocket:
    """What `websockets` hands to `bridge.handler()`: async send + async iteration."""

    def __init__(self, wire):
        self.wire = wire
        self.sent = []
        self.queue = asyncio.Queue()
        self.pushed = 0
        self.returned = 0
        self.processed = 0
        self.closed = False
        self.listening = False
        self.cv = threading.Condition()

    async def send(self, raw):
        if self.closed:
            raise ConnectionError('closed')
        self.sent.append(raw)

    def __aiter__(self):
        return self

    async def __anext__(self):
        with self.cv:
            self.processed = self.returned   # the previous message finished its handler body
            self.listening = True
            self.cv.notify_all()
        raw = await self.queue.get()
        if raw is None:
            raise StopAsyncIteration
        self.returned += 1
        return raw

    def push(self, raws):
        for raw in raws:
            self.pushed += 1
            self.wire.loop.call_soon_threadsafe(self.queue.put_nowait, raw)
        deadline = _time.time() + 10
        with self.cv:
            while self.processed < self.pushed:
                if not self.cv.wait(timeout=max(0.0, deadline - _time.time())):
                    raise HarnessError('bridge.handler did not process %d pushed message(s)' % (self.pushed - self.processed))

    def take_sent(self):
        out, self.sent = self.sent, []
        return out

    def close(self):
        self.closed = True
        self.wire.loop.call_soon_threadsafe(self.queue.put_nowait, None)


class BridgeWire:
    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        bridge.loop = self.loop
        self.current = None
        self.tasks = []

    def barrier(self):
        for _ in range(3):
            asyncio.run_coroutine_threadsafe(asyncio.sleep(0), self.loop).result(5)

    def connect(self):
        ws = FakeServerSocket(self)
        self.tasks.append(asyncio.run_coroutine_threadsafe(bridge.handler(ws), self.loop))
        deadline = _time.time() + 10
        with ws.cv:
            while not ws.listening:
                ws.cv.wait(timeout=0.05)
                if _time.time() > deadline:
                    raise HarnessError('bridge.handler never sent its connection bootstrap')
        self.barrier()
        self.current = ws
        return ws

    def drop(self):
        lost = []
        if self.current:
            self.barrier()
            lost = self.current.take_sent()
            self.current.close()
            self.barrier()
        self.current = None
        return lost

    def shutdown(self):
        self.drop()
        bridge.loop = None
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)


# ══════════════════════════════════════════════════════════════════════
# Desktop side: the persistent real renderer runtime
# ══════════════════════════════════════════════════════════════════════

class DesktopRuntime:
    def __init__(self, product_root):
        self.tmp = tempfile.mkdtemp(prefix='wo019-e2e-')
        self.queue_dir = os.path.join(self.tmp, 'sdk-queue')
        os.mkdir(self.queue_dir)
        self.capture_file = os.path.join(self.tmp, 'sdk-capture.jsonl')
        self.queue_seq = 0
        runtime = RUNTIME_JS
        if product_root != REPO:
            # The runtime resolves the product through its own location; run a copy inside the
            # other tree so renderer/server/main/preload all come from that tree. Only a
            # DISPOSABLE overlay may be used here (it receives the current IO doubles).
            if not os.path.exists(os.path.join(product_root, WO019_OVERLAY_MARKER)):
                raise HarnessError('WO019_PRODUCT_ROOT is not a disposable overlay (missing %s)'
                                   % WO019_OVERLAY_MARKER)
            runtime = os.path.join(product_root, 'irsdk-bridge', '_wo019_desktop_runtime.js')
            shutil.copyfile(RUNTIME_JS, runtime)
            shutil.copyfile(os.path.join(HERE, 'wo019_server_clock_preload.js'),
                            os.path.join(product_root, 'irsdk-bridge', 'wo019_server_clock_preload.js'))
            shutil.copyfile(os.path.join(REPO, 'tests-wo001-anthropic-stream-stub-preload.js'),
                            os.path.join(product_root, 'tests-wo001-anthropic-stream-stub-preload.js'))
        self.proc = subprocess.Popen(['node', runtime, str(_free_port()), self.queue_dir, self.capture_file],
                                     cwd=product_root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, bufsize=1)
        line = self.proc.stdout.readline()
        if not line or not json.loads(line).get('ready'):
            raise HarnessError('desktop runtime failed to start: %r %s' % (line, self.proc.stderr.read()[-2000:]))
        self.seq = 0

    def send(self, cmd, **kw):
        self.seq += 1
        kw.update(id=self.seq, cmd=cmd)
        self.proc.stdin.write(json.dumps(kw, ensure_ascii=False) + '\n')
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise HarnessError('desktop runtime died: ' + self.proc.stderr.read()[-3000:])
        out = json.loads(line)
        if not out.get('ok'):
            raise HarnessError('desktop runtime %s failed: %s' % (cmd, out.get('error')))
        return out

    def script_llm(self, label, for_user_text, text, **hold):
        """Saved LLM response for the request whose last user message contains for_user_text.
        `hold` (holdGateDir/holdTimeoutMs) keeps the real HTTP stream open at the SDK barrier."""
        self.queue_seq += 1
        with open(os.path.join(self.queue_dir, '%03d-%s.json' % (self.queue_seq, label)), 'w', encoding='utf-8') as f:
            json.dump(dict({'forUserText': for_user_text, 'chunks': [text]}, **hold), f, ensure_ascii=False)

    def llm_requests(self):
        if not os.path.exists(self.capture_file):
            return []
        with open(self.capture_file, encoding='utf-8') as f:
            return [json.loads(l) for l in f if l.strip()]

    def close(self):
        try:
            self.send('shutdown')
        except Exception:
            pass
        try:
            self.proc.wait(5)
        except Exception:
            self.proc.kill()
        shutil.rmtree(self.tmp, ignore_errors=True)


# ══════════════════════════════════════════════════════════════════════
# The joined thread
# ══════════════════════════════════════════════════════════════════════

class Thread:
    """Joins the real Bridge replay and the real Desktop runtime frame by frame.

    A step is `fn(t, cursor, frame, result) -> bool` (True = done). Steps run after the frame's
    pending Bridge output was delivered; `pre` steps run before that delivery.
    """

    def __init__(self, product_root=PRODUCT_ROOT, steps=None, pre_steps=None):
        self.desktop = DesktopRuntime(product_root)
        self.wire = BridgeWire()
        self.ws = None
        self.desktop_socket = None
        self.steps = list(steps or [])
        self.pre_steps = list(pre_steps or [])
        self.notes = {}
        self.said = []
        self.to_bridge = []      # every raw renderer -> Bridge message, in order (with frame)
        self.lost = []           # Bridge -> Desktop messages lost with a dropped socket
        self.marks = []          # (frame cursor, broadcasts so far) for output -> frame backtrack
        self.result = None
        self.booted = False
        self.clock_ms = 0
        self.cursor = -1
        self.reconnecting = False
        self.offset_ms = 0
        self.log_archive = []    # Bridge log lines of earlier runs in this thread (WO020 export)

    # transport ----------------------------------------------------------
    def now_ms(self):
        # Inside the replay the Desktop clock follows the Bridge replay clock; afterwards it stays
        # on the last replay instant and only moves by explicit advance() (never wall time).
        if isinstance(bridge.time, rh._ReplayClock):
            self.clock_ms = max(self.clock_ms, int(bridge.time.time() * 1000) + self.offset_ms)
        return self.clock_ms

    def advance(self, ms):
        self.clock_ms = self.now_ms() + int(ms)
        r = self.desktop.send('advance', toMs=self.clock_ms)
        self.forward(r['outbound'])
        return r

    def forward(self, outbound):
        for item in outbound or []:
            self.to_bridge.append({'frame': self.cursor, 'raw': item['raw']})
            if self.ws is None or item['socket'] != self.desktop_socket:
                # A send on a socket the Bridge no longer owns never arrives (real transport).
                continue
            self.ws.push([item['raw']])

    def deliver(self):
        if self.ws is None:
            return None
        self.wire.barrier()
        raws = self.ws.take_sent()
        r = self.desktop.send('ws_deliver', messages=raws, nowMs=self.now_ms())
        self.forward(r['outbound'])
        return r

    def deliver_raw(self, raws):
        """Late/duplicate delivery of already-produced Bridge messages on the current socket."""
        r = self.desktop.send('ws_deliver', messages=list(raws), nowMs=self.now_ms())
        self.forward(r['outbound'])
        return r

    def open_socket(self):
        self.ws = self.wire.connect()
        r = self.desktop.send('ws_open', nowMs=self.now_ms())
        self.desktop_socket = r['socket']
        self.forward(r['outbound'])
        self.deliver()

    def lose_connection(self):
        """Bridge connection lost: queued Bridge output is lost, the renderer's real onclose runs."""
        self.lost.extend(self.wire.drop())
        self.ws = None
        self.desktop.send('ws_drop', nowMs=self.now_ms())
        self.reconnecting = True

    def reconnect(self, *, desktop_wait_ms=3100):
        """Bridge connection lost, then the renderer's own reconnect timer reconnects."""
        self.lose_connection()
        r = self.advance(desktop_wait_ms)
        if not r['connecting']:
            raise HarnessError('renderer did not start its own reconnect: %r' % r)
        self.open_socket()
        self.reconnecting = False

    def say(self, text, label=None, llm=None):
        if llm is not None:
            self.desktop.script_llm(label or 'say', text, llm)
        r = self.desktop.send('say', text=text, nowMs=self.now_ms())
        note = {'frame': self.cursor, 'text': text, 'assistant': r.get('assistant'), 'fuel_source': r.get('fuelSource'),
                'utterances': r.get('utterances'),
                'sent': [json.loads(o['raw']) for o in r.get('outbound', [])
                         if json.loads(o['raw']).get('cmd') != 'log_line']}
        self.said.append(note)
        if label:
            self.notes[label] = note
        self.forward(r['outbound'])
        return note

    def say_start(self, text, label, llm, hold_timeout_ms=120000):
        """Driver turn whose provider reply stays in flight until say_finish (real HTTP held)."""
        gate = tempfile.mkdtemp(prefix='wo019-gate-', dir=self.desktop.tmp)
        self.desktop.script_llm(label, text, llm, holdGateDir=gate, holdAfterChunk=-1, holdTimeoutMs=hold_timeout_ms)
        r = self.desktop.send('say_start', text=text, gateDir=gate, nowMs=self.now_ms())
        self.notes[label] = {'frame': self.cursor, 'text': text, 'gate': gate, 'started_frame': self.cursor}
        self.forward(r['outbound'])
        return r

    def say_finish(self, label):
        note = self.notes[label]
        r = self.desktop.send('say_finish', gateDir=note['gate'], nowMs=self.now_ms())
        note.update({'finished_frame': self.cursor, 'assistant': r.get('assistant'), 'utterances': r.get('utterances'),
                     'error': r.get('error'),
                     'sent': [json.loads(o['raw']) for o in r.get('outbound', []) if json.loads(o['raw']).get('cmd') != 'log_line']})
        self.forward(r['outbound'])
        return note

    def click(self, fn, label=None):
        r = self.desktop.send('click', fn=fn, nowMs=self.now_ms())
        self.forward(r['outbound'])
        if label:
            self.notes[label] = {'utterances': r.get('utterances')}
        return r

    # replay ------------------------------------------------------------
    def hook(self, cursor, frame, result):
        self.result = result
        self.cursor = cursor
        self.marks.append((cursor, len(result.broadcasts), frame.get('Lap'), bool(frame.get('OnPitRoad'))))
        if not self.booted:
            self.booted = True
            self.desktop.send('boot', user=OWNER, nowMs=self.now_ms())
            self.open_socket()
        if self.reconnecting and self.ws is None:
            r = self.desktop.send('advance', toMs=self.now_ms())
            self.forward(r['outbound'])
            if r['connecting']:
                self.open_socket()
                self.reconnecting = False
        for step in list(self.pre_steps):
            if step(self, cursor, frame, result):
                self.pre_steps.remove(step)
        self.deliver()
        for step in list(self.steps):
            if step(self, cursor, frame, result):
                self.steps.remove(step)
                self.deliver()

    def run(self, frames, session_info):
        if self.booted:
            # A later replay restarts the Bridge's virtual clock; the Desktop's keeps moving forward.
            self.offset_ms = max(0, self.clock_ms + 1000 - REPLAY_CLOCK_BASE_MS)
        if os.environ.get('WO019_AI_RACE') == '1':
            # Change only the SDK reader boundary. Apply on EVERY read so
            # later session-info changes cannot silently restore a stable ID.
            original_read = rh.FakeReader.read_session_info
            def read_ai_info(reader):
                info = original_read(reader)
                return re.sub(r'(SubSessionID|SessionID):\s*\d+', r'\1: 0', info) if isinstance(info, str) else info
            with patch.object(rh.FakeReader, 'read_session_info', read_ai_info):
                self.result = rh.replay(frames, session_info=session_info, on_frame_ready=self.hook,
                                        dispatch_result=bridge.broadcast)
            snapshots = [x for x in self.result.broadcasts if x.get('type') == 'canonical_lifecycle_snapshot']
            if not snapshots or any(not x['race_instance_id'].startswith('fallback:') for x in snapshots):
                raise HarnessError('AI reader mode did not reach fallback canonical publications')
        else:
            self.result = rh.replay(frames, session_info=session_info, on_frame_ready=self.hook,
                                    dispatch_result=bridge.broadcast)
        self.deliver()
        return self.result

    def observe(self, **kw):
        return self.desktop.send('observe', nowMs=self.now_ms(), **kw)

    def close(self):
        self.wire.shutdown()
        self.desktop.close()


def at(idx, fn):
    def step(t, cursor, frame, result):
        if cursor != idx:
            return False
        fn(t, frame)
        return True
    return step


# ══════════════════════════════════════════════════════════════════════
# Frames (WO001 Road Atlanta provenance; variants change only the named visit)
# ══════════════════════════════════════════════════════════════════════

def red_thread_frames():
    """WO001 fixture frames (e01, e05-e10) + the player's own finish (WO018 producer)."""
    frames, _times = road.build_red_thread_frames()
    return frames + wo018._finish_frames(frames[-1])


def dense_laps(count, *, start_lap, start_fuel, start_time, frames_per_lap=10):
    """Same lap/fuel model as road.clean_laps() but with denser, evenly spaced LapDistPct
    frames (1 s each), so a lap lasts long enough for a radio call to be heard in replay time."""
    frames, fuel, t = [], start_fuel, start_time
    for i in range(count):
        lap = start_lap + i
        for f in range(frames_per_lap):
            frames.append(rh.make_frame(
                SessionTime=t, Lap=lap, FuelLevel=fuel, LapDistPct=round((f + 1) / (frames_per_lap + 1), 3),
                SessionLapsRemain=road.LAPS_TOTAL - lap, SessionLapsTotal=road.LAPS_TOTAL,
                LapLastLapTime=road.LAP_S + i * 0.01 - 0.01 if i else 0.0))
            t += 1.0
        fuel -= road.FUEL_PER_LAP
        frames.append(rh.make_frame(
            SessionTime=t, Lap=lap + 1, FuelLevel=fuel, LapDistPct=0.01,
            SessionLapsRemain=road.LAPS_TOTAL - (lap + 1), SessionLapsTotal=road.LAPS_TOTAL,
            LapLastLapTime=road.LAP_S + i * 0.01))
        t += 1.0
    return frames, fuel, t


def no_penalty_frames(fuel_added=16.79, dense_after_pit=False):
    """Same lap-15 early stop, then clean racing to the finish (no second visit).
    16.79 L is the handoff fact (enough to finish); 2.0 L is a synthetic short-fuel variant."""
    frames, fuel, t, lap = road.clean_laps(14, start_fuel=60.0)
    pit1, fuel, t, _ = road.pit_visit(lap=15, fuel_before=fuel, fuel_added=fuel_added, start_time=t)
    frames += pit1
    if dense_after_pit:
        more, fuel, t = dense_laps(road.LAPS_TOTAL - 15, start_lap=15, start_fuel=fuel, start_time=t)
    else:
        more, fuel, t, lap = road.clean_laps(road.LAPS_TOTAL - 15, start_lap=15, start_fuel=fuel, start_time=t)
    frames += more
    return frames + wo018._finish_frames(frames[-1])


def unknown_flag_frames():
    """Same early stop; the second visit's SessionFlags are unreadable (black flag unknown)."""
    frames, fuel, t, lap = road.clean_laps(14, start_fuel=60.0)
    pit1, fuel, t, _ = road.pit_visit(lap=15, fuel_before=fuel, fuel_added=16.79, start_time=t)
    frames += pit1
    more, fuel, t, lap = road.clean_laps(1, start_lap=15, start_fuel=fuel, start_time=t)
    frames += more
    pit2, fuel, t, _ = road.unknown_flags_pit_visit(lap=16, fuel_before=fuel, fuel_added=0.0, start_time=t)
    frames += pit2
    more2, fuel, t, lap = road.clean_laps(8, start_lap=16, start_fuel=fuel, start_time=t)
    frames += more2
    return frames + wo018._finish_frames(frames[-1])


def next_race_session_info():
    return road.ROAD_ATLANTA_SESSION_INFO.replace('SubSessionID: %d' % road.ROAD_ATLANTA_SUB_SESSION_ID,
                                                  'SubSessionID: %d' % NEXT_RACE_SUB_SESSION_ID)


def pit_entry_index(frames, nth=1):
    seen = 0
    for i, f in enumerate(frames):
        if f.get('OnPitRoad') and (i == 0 or not frames[i - 1].get('OnPitRoad')):
            seen += 1
            if seen == nth:
                return i
    raise HarnessError('fixture has no pit entry #%d' % nth)


RED = red_thread_frames()
ENTRY1 = pit_entry_index(RED, 1)      # lap 15, first OnPitRoad frame
ENTRY2 = pit_entry_index(RED, 2)      # lap 16 (black flag visit)
AFTER_PITS = ENTRY2 + 17              # lap 18, both visits finalized
WINDOW_Q_FRAME = 41                   # lap 11, Plan A active, window open since lap 5

SHORT_FUEL_ADDED_L = 2.0              # synthetic short-fuel variant (not the 16.79 L handoff fact)
DECLARE = 'ピット入るぞ'
REASON = '前の25が遅いから先に入る'
RETRO_Q = 'さっきのピットの判断、どうだった？'
# Saved responses (not a real model). In race mode the product's telemetry truth gate blocks
# any LLM number+lap/litre claim, so these stay number-free like a compliant reply must.
RETRO_A = '前が詰まっていたから早めに入った判断は筋が通っていた。その次の停止はペナルティで、作戦とは別に扱っている。'
NEXT_Q = '前回のこのコース、ピットはどうだった？'
# One sentence inside the race radio length policy, carrying BOTH the canonical outcome and the
# Driver's dispute; the final spoken output is checked exactly (no prefix acceptance).
NEXT_A = '前回の次の停止はBridge記録ではペナルティ、君は違うと言っていた。'


# ══════════════════════════════════════════════════════════════════════
# Scenario records (one subprocess each; every value read from product output)
# ══════════════════════════════════════════════════════════════════════

def _parse_after(lines, marker):
    out = []
    for l in lines:
        if marker in l:
            try:
                out.append(json.loads(l.split(marker, 1)[1]))
            except ValueError:
                pass
    return out


SUPPORT_SECTION = re.compile(r'=== PITWALL OBSERVABILITY[^\n]*===\n(.*)\n=== END PITWALL OBSERVABILITY ===')


def support_export(t, bridge_log):
    """WO020: the Driver's Support-log button through the real renderer -> preload -> main.js
    handler. `bridge_log` = the Bridge's own log lines (what main.js ingests from its stdout);
    [] = no Bridge log at all. Returns the parsed allowlisted section and leak probes."""
    r = t.desktop.send('export_support', bridgeLog=list(bridge_log), nowMs=t.now_ms())
    t.forward(r['outbound'])
    text = r.get('text') or ''
    m = SUPPORT_SECTION.search(text)
    section_text = m.group(1) if m else ''
    probes = {x for x in [n.get('text') for n in t.said] + [a for n in t.said for a in (n.get('assistant') or [])]
              if isinstance(x, str) and len(x) >= 4}
    for u in (t.observe()['utterances'] or []):
        if isinstance(u.get('text'), str) and len(u['text']) >= 4:
            probes.add(u['text'])
    build = re.search(r'^Build: (.*)$', text, re.M)
    return {'file': r.get('file'), 'has_section': bool(m), 'bytes': len(text.encode('utf-8')),
            'build_line': build.group(1) if build else None,
            'section_bytes': len(section_text.encode('utf-8')),
            'section': json.loads(section_text) if m else None,
            'leaked_texts': sorted(x for x in probes if x in section_text)[:5],
            'leaked_credentials': [k for k in ('wo019-local-token', 'Bearer', 'sk-test') if k in section_text]}


def collect(t, extra_keys=(), export=True):
    r = t.result
    logs = r.logs
    o = t.observe(apiBodies=True, console=400, keys=['pw_session_evidence'] + list(extra_keys), observability=True)
    prio = {}
    for l in logs:
        if '[SPEECH_LATENCY]' in l:
            try:
                p = json.loads(l.split('[SPEECH_LATENCY] ', 1)[1])
                prio.setdefault(p.get('utterance_id'), p.get('prio'))
            except ValueError:
                pass
    keep_types = ('driver_plan_command_ack', 'strategy_decision_ack', 'strategy_delivery_ack', 'pit_timing',
                  'session_summary', 'historical_settlement_ack')
    keep_triggers = ('strategy_plan_decision', 'strategy_plan_proposal', 'initial_strategy_plans',
                     'strategy_plan_box_call', 'fuel_strategy_warning', 'fuel_warning')
    marks = t.marks
    def frame_of(i):
        f = None
        for cursor, n, _lap, _pit in marks:
            if n <= i:
                f = cursor
        return f
    bc = []
    for i, b in enumerate(r.broadcasts):
        if b.get('type') in keep_types or b.get('trigger') in keep_triggers:
            bc.append({'i': i, 'frame': frame_of(i), 'type': b.get('type'), 'trigger': b.get('trigger'),
                       'decision_id': b.get('decision_id'), 'outcome': b.get('outcome'), 'intent': b.get('intent'),
                       'command_id': b.get('command_id'), 'lifecycle_phase': b.get('lifecycle_phase'),
                       'reason': b.get('reason'), 'accepted': b.get('accepted'), 'message': b.get('message')})
    llm = t.desktop.llm_requests()
    return {
        'notes': t.notes, 'said': t.said,
        'decisions': _parse_after(logs, 'DECISION opened: '),
        'pit_events': _parse_after(logs, 'DRIVER PIT EVENT: '),
        'plan_pit': _parse_after(logs, 'PLAN LIFECYCLE PIT: '),
        'declared': _parse_after(logs, 'DRIVER EARLY PIT DECLARED: '),
        'cmd_outcomes': [l for l in logs if l.startswith('DRIVER PLAN COMMAND outcome=')],
        'options_invalidated': [l for l in logs if 'STRATEGY OPTIONS invalidated' in l],
        'post_service_aligned': _parse_after(logs, 'POST SERVICE TARGET ALIGNED: '),
        'opening_aligned': _parse_after(logs, 'OPENING TARGET ALIGNED: '),
        'holds': sorted({l.split('reason=')[-1] for l in logs if l.startswith('PLAN EXECUTION HOLD')}),
        'broadcasts': bc,
        'to_bridge': [{'frame': x['frame'], **json.loads(x['raw'])} for x in t.to_bridge
                      if json.loads(x['raw']).get('cmd') != 'log_line'],
        'lost': [json.loads(x) for x in t.lost],
        'prio': prio,
        'marks': marks,
        'desktop': {k: o.get(k) for k in ('utterances', 'canonical', 'driverPlanOutbox', 'pendingFollowup',
                                           'lastSessionSummary', 'evidenceDebrief', 'selMode', 'storage',
                                           'blockedFetches', 'timerErrors', 'sockets')},
        'api': [{k: a.get(k) for k in ('route', 'at', 'bytes')} for a in o.get('apiRequests') or []],
        'chat_bodies': [json.loads(a['body']) for a in o.get('apiRequests') or [] if a.get('body')],
        'llm': [{'system': q.get('system') or '', 'messages': q.get('messages') or [], 'stream': q.get('stream')} for q in llm],
        'server_log': [l for l in (o.get('console') or []) if l.startswith('[server]')
                       and ('INTENT_ROUTE' in l or 'race_context' in l)],
        # WO020 observability: renderer recorder snapshot, Bridge [TRACE] lines, Support export.
        'obs': o.get('observability'),
        'bridge_trace': _parse_after(logs, '[TRACE] '),
        'log_volume': {'frames': len(marks), 'log_lines': len(logs), 'trace_lines': sum(1 for l in logs if '[TRACE] ' in l),
                       'trace_bytes': sum(len(l) for l in logs if '[TRACE] ' in l)},
        'support': _collect_support(t, logs, export),
        'canonical_truth': _canonical_truth(r.broadcasts),
        'decision_scopes': {
            record['decision_id']: {'race_instance_id': snapshot['race_instance_id'],
                                    'session_num': snapshot['session_num'],
                                    'bridge_process_epoch': snapshot['bridge_process_epoch']}
            for snapshot in r.broadcasts if snapshot.get('type') == 'canonical_lifecycle_snapshot'
            for record in ([snapshot['lifecycle']['active']] if snapshot['lifecycle']['active'] else [])
                          + snapshot['lifecycle']['awaiting'] + snapshot['lifecycle']['terminal_records']
        },
        # WO021: the renderer's own Build output and the product Bridge's BUILD_VERSION constant.
        'build': o.get('build'),
        'bridge_build_version': getattr(bridge, 'BUILD_VERSION', None),
    }


def _canonical_truth(broadcasts):
    """Product truth for W07: every record/pit state the REAL Bridge published in its canonical
    snapshots (read from the broadcasts, not from the trace under test)."""
    terminal, awaiting, pits = set(), set(), set()
    for b in broadcasts:
        if not isinstance(b, dict) or b.get('type') != 'canonical_lifecycle_snapshot':
            continue
        life = b.get('lifecycle') or {}
        for r in life.get('terminal_records') or []:
            terminal.add((r.get('decision_id'), r.get('revision'), r.get('phase'), r.get('invalidated_reason'), r.get('terminal_pit_event_id')))
        for r in life.get('awaiting') or []:
            awaiting.add((r.get('decision_id'), r.get('phase')))
        for e in (b.get('pit_ledger') or {}).get('events') or []:
            pits.add((e.get('pit_event_id'), e.get('driver_pit_sequence'), e.get('execution_relation'),
                      (e.get('penalty_evidence') or {}).get('state'), (e.get('plan_reference') or {}).get('decision_id')))
    return {'terminal': sorted(map(list, terminal), key=str), 'awaiting': sorted(map(list, awaiting), key=str),
            'pit_events': sorted(map(list, pits), key=str)}


def _collect_support(t, logs, export):
    t.log_archive.extend(logs)
    return support_export(t, t.log_archive) if export else None


def scn_main(product_root, decl=ENTRY1 - 4, reason=ENTRY1 - 3):
    """The one consultation: window question -> early declaration + reason -> real pits ->
    current rationale -> same-epoch reconnect -> debrief question/correction/save -> next race."""
    steps = [
        at(WINDOW_Q_FRAME, lambda t, f: t.say('ピットウィンド湧いてる？', 'window')),
        at(decl, lambda t, f: t.say(DECLARE, 'declare')),
        at(reason, lambda t, f: t.say(REASON, 'reason')),
        at(AFTER_PITS, lambda t, f: t.say('燃料足りる？', 'fuel_q')),
        at(AFTER_PITS + 2, lambda t, f: t.say('今のプランは？', 'plan_q')),
        at(AFTER_PITS + 4, lambda t, f: t.say(RETRO_Q, 'retro_q', llm=RETRO_A)),
        at(AFTER_PITS + 8, lambda t, f: _reconnect_note(t)),
        at(AFTER_PITS + 9, lambda t, f: _reconnect_after(t)),
        at(AFTER_PITS + 10, lambda t, f: _late_duplicates(t)),
    ]
    t = Thread(product_root, steps=steps)
    try:
        t.run(RED, road.ROAD_ATLANTA_SESSION_INFO)
        _debrief(t)
        first = collect(t, export=False)
        # Next race: same Driver, same car/track, a new SubSessionID (another race).
        # Asked once the new race's connect/briefing radio has finished (an answer queued behind
        # it past the 5 s canonical binding TTL is dropped unheard — product freshness contract).
        t.steps = [at(10, lambda t, f: _next_race_question(t))]
        t.result = None
        t.marks = []
        t.run(road.clean_laps(6)[0], next_race_session_info())
        nxt = collect(t)
        first['next_race'] = {k: nxt[k] for k in ('notes', 'llm', 'chat_bodies', 'desktop', 'pit_events', 'decisions',
                                                   'obs', 'bridge_trace', 'support', 'log_volume', 'canonical_truth', 'decision_scopes')}
        return first
    finally:
        t.close()


def _next_race_question(t):
    t.say(NEXT_Q, 'next_q', llm=NEXT_A)
    getter = lambda fn, *a: t.desktop.send('call', fn=fn, args=list(a), nowMs=t.now_ms())['value']
    recs = getter('loadEvidenceRecords')
    t.notes['next_memory'] = {'evidence_note': getter('buildSessionEvidenceNote'),
                              'records': [{k: r.get(k) for k in ('driver', 'owner_ref', 'race_instance_id', 'created_at', 'scope')}
                                          for r in recs],
                              'owner': getter('localMemoryOwnerRef'), 'race_scope': getter('currentMemoryRaceScope'),
                              'identity': t.observe()['identity']}


def _reconnect_note(t):
    before = t.observe()
    t.reconnect()
    t.notes['reconnect'] = {'before_epoch': (before['canonical'] or {}).get('bridge_process_epoch'),
                            'terminal_before': (before['canonical'] or {}).get('terminal_records'),
                            'utterances_before': len(before['utterances'])}


def _reconnect_after(t):
    """One Bridge publication after the same-epoch reconnect (the bootstrap repeats the
    already-seen snapshot, which the cache deliberately does not re-accept as fresh)."""
    after = t.observe()
    t.notes['reconnect'].update({'after_epoch': (after['canonical'] or {}).get('bridge_process_epoch'),
                                 'sockets': after['sockets'],
                                 'terminal_after': (after['canonical'] or {}).get('terminal_records'),
                                 'active_after': (after['canonical'] or {}).get('active'),
                                 'outbox_after': after['driverPlanOutbox']})


def _late_duplicates(t):
    """Transport redelivery after reconnect: the old command again (Desktop->Bridge) and the old
    ACKs again (Bridge->Desktop). Neither may revive the Plan or speak a second readback."""
    cmds = [x for x in t.to_bridge if json.loads(x['raw']).get('cmd') == 'driver_plan_command']
    acks = [b for b in t.result.broadcasts if b.get('type') == 'driver_plan_command_ack']
    mark = t.observe()['utterances']
    if cmds:
        t.ws.push([cmds[0]['raw']])
    t.deliver_raw([json.dumps(a, ensure_ascii=False) for a in acks])
    t.notes['late'] = {'resent_command': bool(cmds), 'redelivered_acks': len(acks),
                       'utterances_before': len(mark)}


def _debrief(t):
    """Post-race: the real debrief starts from the real session_summary; the Driver answers."""
    t.advance(20000)                     # greeting + first question are spoken first
    t.say('16周目はペナルティじゃないよ', 'correction')
    t.advance(2000)
    t.say('ピット出口のラインを踏んだかもしれない', 'debrief_a1')
    t.advance(12000)
    t.say('後半はトラフィックでペースを落とした', 'debrief_a2')
    t.advance(12000)
    t.click('confirmEvidenceMemory', 'confirm')
    t.notes['records_after_confirm'] = t.desktop.send('call', fn='loadEvidenceRecords', nowMs=t.now_ms())['value']


def scn_declare_only(product_root, decl, frames=None):
    t = Thread(product_root, steps=([at(decl, lambda t, f: t.say(DECLARE, 'declare'))] if decl is not None else []))
    try:
        t.run(frames or RED, road.ROAD_ATLANTA_SESSION_INFO)
        return collect(t)
    finally:
        t.close()


def scn_compound_cancel(product_root, frame=WINDOW_Q_FRAME):
    t = Thread(product_root, steps=[at(frame, lambda t, f: t.say('ピット中止、タイヤ交換はしない。', 'compound_cancel'))])
    try:
        t.run(RED, road.ROAD_ATLANTA_SESSION_INFO)
        return collect(t)
    finally:
        t.close()


def scn_rephrase(product_root):
    t = Thread(product_root, steps=[at(ENTRY1 - 4, lambda t, f: t.say(DECLARE + '。' + REASON, 'declare'))])
    try:
        t.run(RED, road.ROAD_ATLANTA_SESSION_INFO)
        return collect(t)
    finally:
        t.close()


def scn_topic_switch(product_root):
    t = Thread(product_root, steps=[
        at(ENTRY1 - 4, lambda t, f: t.say(DECLARE, 'declare')),
        at(ENTRY1 - 3, lambda t, f: t.say('タイヤの温度どう？', 'other_topic')),
        at(ENTRY1 - 2, lambda t, f: t.say(REASON, 'late_reason')),
    ])
    try:
        t.run(RED, road.ROAD_ATLANTA_SESSION_INFO)
        return collect(t)
    finally:
        t.close()


def scn_no_identity(product_root):
    """Before any canonical Plan exists the declaration has no identity to bind: no wire command."""
    t = Thread(product_root, steps=[at(3, lambda t, f: t.say(DECLARE, 'declare'))])
    try:
        t.run(RED[:ENTRY1 - 10], road.ROAD_ATLANTA_SESSION_INFO)
        return collect(t)
    finally:
        t.close()


def scn_ack_lost(product_root):
    """The ACK for the declaration is lost with the socket; the renderer's own reconnect and
    outbox resend must settle it once (Bridge retry_no_op), and the late original ACK is inert."""
    decl = ENTRY1 - 4
    t = Thread(product_root,
               steps=[at(decl, lambda t, f: t.say(DECLARE, 'declare')),
                      at(decl + 8, lambda t, f: _late_original_ack(t))],
               pre_steps=[at(decl + 1, lambda t, f: t.lose_connection())])
    try:
        t.run(RED, road.ROAD_ATLANTA_SESSION_INFO)
        return collect(t)
    finally:
        t.close()


def _late_original_ack(t):
    lost_acks = [x for x in t.lost if '"driver_plan_command_ack"' in x]
    before = len(t.observe()['utterances'])
    t.deliver_raw(lost_acks)
    t.notes['late_original_ack'] = {'redelivered': len(lost_acks), 'utterances_before': before}


def scn_unknown_flag(product_root):
    t = Thread(product_root, steps=[at(ENTRY1 - 4, lambda t, f: t.say(DECLARE, 'declare'))])
    try:
        t.run(unknown_flag_frames(), road.ROAD_ATLANTA_SESSION_INFO)
        t.advance(9000)
        return collect(t)
    finally:
        t.close()


def scn_no_penalty(product_root, declare, fuel_added=16.79, dense_after_pit=False):
    steps = [at(ENTRY1 - 4, lambda t, f: t.say(DECLARE, 'declare'))] if declare else []
    steps.append(at(ENTRY1 + 30, lambda t, f: t.say('今のプランは？', 'plan_q')))
    t = Thread(product_root, steps=steps)
    try:
        t.run(no_penalty_frames(fuel_added, dense_after_pit), road.ROAD_ATLANTA_SESSION_INFO)
        return collect(t)
    finally:
        t.close()


AMEND = 'ピットを15周目に変更して'


def scn_amend(product_root, fuel_added):
    """Real sendMsg amend to lap 15 (driver-fixed target), then the real L15 stop adds
    `fuel_added`; the next plan may only come from the post-stop measured state."""
    t = Thread(product_root, steps=[at(WINDOW_Q_FRAME, lambda t, f: t.say(AMEND, 'amend'))])
    try:
        t.run(no_penalty_frames(fuel_added, dense_after_pit=True), road.ROAD_ATLANTA_SESSION_INFO)
        return collect(t)
    finally:
        t.close()


WAIT_Q = 'このレースの流れ、どう感じる？'
WAIT_A = 'Plan Aのまま、ペースは安定している。'   # one short sentence: heard within the binding TTL


def scn_llm_wait(product_root, start, finish):
    """A Driver question whose real provider reply is held in flight from `start` to `finish`
    while the Bridge keeps publishing (WO019 group 6). With start/finish around the real L15
    stop, the canonical Plan A it talks about is retired while the reply is still in flight."""
    t = Thread(product_root, steps=[at(start, lambda t, f: t.say_start(WAIT_Q, 'wait_q', WAIT_A)),
                                    at(finish, lambda t, f: t.say_finish('wait_q'))])
    try:
        t.run(RED[:max(finish + 6, ENTRY1 + 12)], road.ROAD_ATLANTA_SESSION_INFO)
        return collect(t)
    finally:
        t.close()


# ── Plan B proposal (WO005 Monza fixture: the real Bridge selects B and proposes it) ──

def _plan_bc():
    return _load_harness('tests_bridge_plan_lifecycle_wiring')


def _seeded_pit_loss(tmpdir):
    bc = _plan_bc()
    payload = json.load(open(bc.PLAN_BC_CALIBRATION_FIXTURE))
    for record in payload['conditions'].values():
        record['pit_samples'] = [x for x in record['pit_samples'] if 'timestamp' not in x]
        record['forecast_outcomes'] = []
    path = os.path.join(tmpdir, 'seed.json')
    json.dump(payload, open(path, 'w'))
    return path


def _proposal_pending(t):
    if t.ws is None:
        return False
    t.wire.barrier()          # the Bridge's broadcast is scheduled on its own loop
    return any('"strategy_plan_proposal"' in raw for raw in t.ws.sent)


def scn_proposal(product_root, mode):
    """mode 'unheard': Luna is mid-answer when the proposal arrives; the Driver's "はい" before it
    becomes audible is refused, and "はい" after it was heard is applied (normal control).
    mode 'interrupted': the proposal starts, the Driver presses PTT (real barge-in), "はい" refused."""
    from tests_strategy_position_comparison import synthetic_positive_b_forecast,assert_synthetic_b_targets
    # Explicit synthetic prediction output: delivery/consent only. This does
    # not establish a real undercut gain; untouched common-H model keeps A.
    bc = _plan_bc()
    forecast_evidence=[]
    state = {'done': False}

    def busy_then_yes(t, cursor, frame, result):
        if state['done'] or not _proposal_pending(t):
            return False
        t.say('ピットウィンド湧いてる？', 'busy_answer')          # long local answer still playing
        t.deliver()                                               # proposal arrives behind it
        t.say('はい', 'yes_unheard')
        state['done'] = True
        t.notes['proposal_frame'] = cursor
        return True

    def interrupt(t, cursor, frame, result):
        if state['done'] or not _proposal_pending(t):
            return False
        t.deliver()                                               # proposal starts playing
        bridge._ptt_physical_edge(True)                           # Driver presses PTT (hardware edge)
        t.deliver()
        bridge._ptt_physical_edge(False)
        t.deliver()
        t.say('はい', 'yes_interrupted')
        state['done'] = True
        t.notes['proposal_frame'] = cursor
        return True

    def note_arrival(t, cursor, frame, result):
        if state['done'] or not _proposal_pending(t):
            return False
        state['done'] = True
        t.notes['proposal_frame'] = cursor
        return True

    def yes_when_completed(t, cursor, frame, result):
        observed=t.observe()
        pending=(observed.get('strategyState') or {}).get('pending_proposal') or {}
        done={u['uid']:u for u in observed['utterances']
            if u.get('kind')=='bridge_strategy_proposal' and 'completed' in (u.get('states') or [])
            and 'audible_interrupted' not in (u.get('states') or [])}
        deliveries=[json.loads(x['raw']) for x in t.to_bridge]
        completed=next((x for x in reversed(deliveries) if x.get('cmd')=='strategy_decision_delivery'
            and x.get('outcome')=='audible_completed' and x.get('decision_id')==pending.get('decision_id')
            and x.get('dispatch_id')==pending.get('dispatch_id') and x.get('utterance_id') in done),None)
        if completed is None:return False
        # A retry's old interrupted utterance is not the speech the Driver
        # just heard. Bind this positive control to the CURRENT exact attempt.
        t.notes['heard_completion_before_consent']={'frame':cursor,'pending':pending,
            'delivery':completed,'utterance':done[completed['utterance_id']]}
        t.say('はい', 'yes_heard')
        return True

    pre = {'unheard': [busy_then_yes], 'interrupted': [interrupt], 'heard': [note_arrival]}[mode]
    steps = {'unheard': [], 'interrupted': [], 'heard': [yes_when_completed]}[mode]
    tmp = tempfile.mkdtemp(prefix='wo019-bc-')
    original = bridge.PIT_LOSS_PATH
    bridge.PIT_LOSS_PATH = _seeded_pit_loss(tmp)
    t = Thread(product_root, steps=steps, pre_steps=pre)
    try:
        # The 38 L session tank delays the genuine fuel window until after
        # opening speech. Hold the same valid lap long enough to observe all
        # delivery terminals; no trace-volume budget is changed.
        frames=bc._plan_bc_accept_clean_laps(8,start_fuel=26.)
        tail,_=bc._plan_bc_accept_hold_frames(64,lap=9,fuel=10.,start_time=132.)
        for frame in tail:frame['LapLastLapTime']=100.07
        frames+=tail
        for frame in frames:
            frame['SessionLapsTotal']=28
            frame['SessionLapsRemain']=28-frame['Lap']
        info=bc.PLAN_BC_ACCEPT_SESSION_INFO.replace('SessionLaps: %s' % bc.PLAN_BC_ACCEPT_LAPS_TOTAL,'SessionLaps: 28').replace('DriverCarFuelMaxLtr: 60.000','DriverCarFuelMaxLtr: 38.000')
        with synthetic_positive_b_forecast(evidence=forecast_evidence,capacity_l=38.):
            t.run(frames,info)
        completed=(t.notes.get('heard_completion_before_consent') or {}).get('delivery') or {}
        t.notes['heard_matching_owner_ack']=[b for b in t.result.broadcasts
            if b.get('type')=='strategy_decision_ack' and b.get('decision_id')==completed.get('decision_id')
            and b.get('dispatch_id')==completed.get('dispatch_id') and b.get('outcome')=='accepted']
        t.notes['synthetic_prediction_fixture']={'purpose':'delivery_consent_only_not_forecast_skill',
            'checked_targets':assert_synthetic_b_targets(t.result.broadcasts,forecast_evidence),
            'frames':len(forecast_evidence),'sdk_capacity_l':38.,'raw_frames':len(frames)}
        return collect(t)
    finally:
        bridge.PIT_LOSS_PATH = original
        t.close()
        shutil.rmtree(tmp, ignore_errors=True)


def scn_opening_no_pit(product_root):
    """WO-020 P0: the opening Plan A only, Driver never pits (no stop in the fixture), no
    question. The required BOX must be issued by the authority and heard on every Renderer."""
    t = Thread(product_root)
    try:
        frames, _fuel, _t, _lap = road.clean_laps(road.LAPS_TOTAL, start_fuel=60.0)
        t.run(frames, road.ROAD_ATLANTA_SESSION_INFO)
        t.advance(9000)
        return collect(t)
    finally:
        t.close()


def scn_offline_export(product_root):
    """WO020: the Bridge goes away (socket lost, no reconnect yet); the Driver asks once more and
    then presses Support log. The renderer's trace/metrics must still be exported, with and
    without any Bridge log in the session file."""
    t = Thread(product_root)
    try:
        t.run(RED[:ENTRY1 - 6], road.ROAD_ATLANTA_SESSION_INFO)
        t.lose_connection()
        t.notes['offline_mark'] = len(t.observe()['utterances'])
        t.say('燃料足りる？', 'offline_q')
        t.advance(6000)
        rec = collect(t, export=False)
        rec['support_no_bridge_log'] = support_export(t, [])
        rec['support_with_bridge_log'] = support_export(t, t.log_archive)
        rec['offline_connected'] = t.observe()['bridgeConnected']
        return rec
    finally:
        t.close()


SCENARIOS = {
    'main': lambda root: scn_main(root),
    'compound_cancel': scn_compound_cancel,
    'compound_cancel_near_pit': lambda root: scn_compound_cancel(root, ENTRY1 - 4),
    'offline_export': scn_offline_export,
    'opening_no_pit': scn_opening_no_pit,
    'decl_entry_frame': lambda root: scn_declare_only(root, ENTRY1),
    'decl_one_before': lambda root: scn_declare_only(root, ENTRY1 - 1),
    'decl_lapsed': lambda root: scn_declare_only(root, ENTRY1 - 8),
    'no_declaration': lambda root: scn_declare_only(root, None),
    'rephrase': scn_rephrase,
    'topic_switch': scn_topic_switch,
    'no_identity': scn_no_identity,
    'ack_lost': scn_ack_lost,
    'unknown_flag': scn_unknown_flag,
    'no_penalty_declared': lambda root: scn_no_penalty(root, True),
    'no_penalty_undeclared': lambda root: scn_no_penalty(root, False),
    'short_fuel': lambda root: scn_no_penalty(root, False, fuel_added=SHORT_FUEL_ADDED_L, dense_after_pit=True),
    # 7.1 L: the builder's target is reachable but its frozen amount is not (amount-only alignment).
    'short_fuel_7l': lambda root: scn_no_penalty(root, False, fuel_added=7.1, dense_after_pit=True),
    'sufficient_fuel_dense': lambda root: scn_no_penalty(root, False, dense_after_pit=True),
    'amend_short_fuel': lambda root: scn_amend(root, SHORT_FUEL_ADDED_L),
    'amend_sufficient_fuel': lambda root: scn_amend(root, 16.79),
    'proposal_unheard': lambda root: scn_proposal(root, 'unheard'),
    'proposal_interrupted': lambda root: scn_proposal(root, 'interrupted'),
    'proposal_heard': lambda root: scn_proposal(root, 'heard'),
    # Same 2-frame hold (inside the 5 s canonical binding TTL); only the first spans the
    # real L15 pit exit that retires Plan A.
    'llm_wait_canonical_change': lambda root: scn_llm_wait(root, ENTRY1 + 6, ENTRY1 + 8),
    'llm_wait_control': lambda root: scn_llm_wait(root, 30, 32),
    # A long wait with no Plan change: shows the existing TTL contract (observation, not a pass/fail of WO019 code).
    'llm_wait_long_no_change': lambda root: scn_llm_wait(root, 30, 37),
}


# ══════════════════════════════════════════════════════════════════════
# Cases (pure functions of scenario records)
# ══════════════════════════════════════════════════════════════════════

def _utts(rec, kind=None, prefix=None):
    out = rec['desktop']['utterances'] or []
    if kind:
        out = [u for u in out if u.get('kind') == kind]
    if prefix:
        out = [u for u in out if (u.get('kind') or '').startswith(prefix)]
    return out


def _plan_a(rec):
    plan = rec['decisions'][0] if rec['decisions'] else {}
    # Legacy DECISION logs omit identity. Read it from the Bridge's actual
    # canonical record, never invent it from a configured SubSessionID.
    scope = (rec.get('decision_scopes') or {}).get(plan.get('decision_id')) or {}
    return {**plan, **scope}


def _pit(rec, n):
    ids = [p for p in rec['pit_events'] if p.get('driver_pit_sequence') == n]
    return ids[-1] if ids else {}


def _cmds(rec, cmd):
    return [x for x in rec['to_bridge'] if x.get('cmd') == cmd]


def _acks(rec):
    return [b for b in rec['broadcasts'] if b['type'] == 'driver_plan_command_ack']


def _text(note):
    return ' '.join(note.get('assistant') or []) if note else ''


def _spoken(u):
    return any(s in ('completed', 'spoken', 'play_started', 'audible_interrupted') for s in u.get('states') or [])


def _ok(cond, detail):
    return {'pass': bool(cond), 'detail': detail}


def c_plan_a_real(R):
    m = R['main']
    a = _plan_a(m)
    spoken = [u for u in _utts(m, 'strategy_plan_decision') if (u.get('source') or {}).get('decision_id') == a.get('decision_id')]
    # WO-020 P0: the opening target/amount is the one the BOX authority accepted in the same frame
    # (logged alignment), not the builder's raw lap; never a constant.
    al = (m.get('opening_aligned') or [{}])[0]
    return _ok(a.get('selected_plan') == 'A' and isinstance(a.get('target_lap'), int)
               and str(al.get('snapshot_id', '')).startswith('initial:')
               and (a.get('target_lap'), a.get('set_fuel_l')) == (al.get('target_lap'), al.get('set_fuel_l'))
               and spoken and _spoken(spoken[0]),
               {'decision': {k: a.get(k) for k in ('decision_id', 'target_lap', 'add_fuel_l', 'set_fuel_l')},
                'opening_aligned': al, 'spoken': len(spoken)})


def c_window_answer(R):
    m = R['main']
    n = m['notes'].get('window') or {}
    txt = _text(n)
    a = _plan_a(m)
    u = [x for x in n.get('utterances') or [] if x.get('kind') == 'local_fuel_window_status']
    chat = [b for b in m['chat_bodies'] if b.get('messages') and b['messages'][-1].get('content') == 'ピットウィンド湧いてる？']
    return _ok('5周目から窓が開いている' in txt and ('合意中はPlan A、%s周目ピット' % a.get('target_lap')) in txt
               and not re.search(r'あと\d+周|今周ピット|今周入れる', txt)
               and u and (u[0].get('source') or {}).get('decision_id') == a.get('decision_id') and not chat,
               {'reply': txt, 'utterance_source': u and u[0].get('source'), 'llm_requests': len(chat)})


def c_declaration_command(R):
    m = R['main']
    a = _plan_a(m)
    sent = _cmds(m, 'driver_plan_command')
    env = sent[0] if sent else {}
    applied = [l for l in m['cmd_outcomes'] if 'outcome=applied' in l and env.get('command_id', '?') in l]
    acks = [b for b in _acks(m) if b['command_id'] == env.get('command_id') and b['outcome'] == 'applied']
    readback = [u for u in _utts(m, 'driver_plan_command_ack') if u.get('text') == '了解、今周ピットの申告を受けた。']
    return _ok(env.get('intent') == 'early_pit' and env.get('expected_decision_id') == a.get('decision_id')
               and env.get('text') == DECLARE and bool(a.get('race_instance_id'))
               and env.get('race_instance_id') == a.get('race_instance_id')
               and isinstance(env.get('canonical_snapshot_sequence'), int)
               and len(applied) == 1 and acks and acks[0]['lifecycle_phase'] == 'invalidated'
               and len(readback) == 1 and 'completed' in readback[0]['states'],
               {'envelope': {k: env.get(k) for k in ('intent', 'expected_decision_id', 'text')},
                'applied': len(applied), 'readback': [(u['text'], u['states'][-1]) for u in readback]})


def c_compound_cancel(R, scenario='compound_cancel', state='completed'):
    r = R[scenario]
    a = _plan_a(r)
    commands = _cmds(r, 'driver_plan_command')
    command = commands[0] if commands else {}
    acks = [x for x in _acks(r) if x.get('command_id') == command.get('command_id') and x.get('outcome') == 'applied']
    readbacks = _utts(r, 'driver_plan_command_ack')
    expected = '了解、%s周目のPlan Aを取り消した。' % a.get('target_lap')
    terminals = r.get('canonical_truth', {}).get('terminal', [])
    old_box = [b for b in r['broadcasts'] if b.get('trigger') == 'strategy_plan_box_call' and b.get('decision_id') == a.get('decision_id')]
    return _ok(command.get('intent') == 'cancel' and command.get('text') == 'ピット中止、タイヤ交換はしない。'
               and command.get('expected_decision_id') == a.get('decision_id')
               and len(acks) == 1 and acks[0].get('lifecycle_phase') == 'cancelled'
               and any(x[0] == a.get('decision_id') and x[2] == 'cancelled' for x in terminals)
               and any(u.get('text') == expected and state in u.get('states', [])
                       and (state != 'audible_interrupted' or 'completed' not in u.get('states', [])) for u in readbacks)
               and not old_box,
               {'command': command, 'acks': acks, 'readbacks': [(u.get('text'), u.get('states')) for u in readbacks], 'old_box': old_box})


def c_reason_linked(R):
    m = R['main']
    cmd = (_cmds(m, 'driver_plan_command') or [{}])[0]
    reasons = _cmds(m, 'driver_plan_reason')
    linked = [l for l in m['cmd_outcomes'] if 'outcome=linked' in l and cmd.get('command_id', '?') in l]
    return _ok(reasons and reasons[0].get('command_id') == cmd.get('command_id')
               and reasons[0].get('reason_text') == REASON and len(linked) == 1
               and not m['desktop']['driverPlanOutbox'],
               {'reason_sent': len(reasons), 'linked': len(linked), 'outbox': m['desktop']['driverPlanOutbox']})


def c_duplicate_idempotent(R):
    m = R['main']
    cmd = (_cmds(m, 'driver_plan_command') or [{}])[0]
    outs = [l.split('outcome=')[1].split()[0] for l in m['cmd_outcomes']
            if cmd.get('command_id', '?') in l and 'intent' not in l]
    readback = [u for u in _utts(m, 'driver_plan_command_ack')]
    return _ok(outs.count('applied') == 1 and len(outs) >= 2 and set(outs) <= {'applied', 'retry_no_op', 'linked'}
               and len(m['declared']) == 1 and len(readback) == 1,
               {'outcomes': outs, 'declared': len(m['declared']), 'readbacks': len(readback)})


def _early_bound(rec):
    a = _plan_a(rec)
    p1 = _pit(rec, 1)
    return (p1.get('entry', {}).get('lap') == 15 and p1.get('service', {}).get('fuel_added_l') == 16.79
            and p1.get('execution_relation') == 'early'
            and (p1.get('plan_reference') or {}).get('decision_id') == a.get('decision_id')), {
        'relation': p1.get('execution_relation'), 'reason': p1.get('classification_reason'),
        'plan_reference': (p1.get('plan_reference') or {}).get('decision_id'), 'plan_a': a.get('decision_id')}


def c_pits_bound(R):
    m = R['main']
    ok1, d1 = _early_bound(m)
    p2 = _pit(m, 2)
    return _ok(ok1 and p2.get('execution_relation') == 'penalty'
               and (p2.get('penalty_evidence') or {}).get('state') == 'true',
               {'pit1': d1, 'pit2': (p2.get('execution_relation'), (p2.get('penalty_evidence') or {}).get('state'))})


def _no_old_plan(rec, decl_frame):
    late_radio = [b for b in rec['broadcasts'] if b['trigger'] in ('strategy_plan_decision', 'initial_strategy_plans')
                  and b['frame'] is not None and decl_frame is not None and b['frame'] > decl_frame]
    box = [b for b in rec['broadcasts'] if b['trigger'] == 'strategy_plan_box_call']
    box_spoken = _utts(rec, 'strategy_plan_box_call')
    return (len(rec['decisions']) == 1 and not late_radio and not box and not box_spoken), {
        'decisions': [(d['decision_id'][-40:], d.get('target_lap'), d.get('decided_at_lap')) for d in rec['decisions']],
        'late_plan_radio': [(b['frame'], b['trigger']) for b in late_radio], 'box': len(box), 'box_spoken': len(box_spoken)}


def c_no_old_plan(R):
    ok, d = _no_old_plan(R['main'], ENTRY1 - 4)
    return _ok(ok and R['main']['options_invalidated'], dict(d, invalidated=R['main']['options_invalidated']))


def c_fresh_current_answers(R):
    m = R['main']
    fuel = _text(m['notes'].get('fuel_q'))
    plan = _text(m['notes'].get('plan_q'))
    disputes = [u for n in ('fuel_q', 'plan_q') for u in (m['notes'].get(n) or {}).get('utterances') or []
                if u.get('kind') == 'dispute_ack']
    rejected = [l for l in m['server_log'] if 'rejected' in l]
    # Derive the requirement from the actual canonical source captured at
    # question entry, not a prose fragment from the previous implementation.
    source = (m['notes'].get('fuel_q') or {}).get('fuel_source') or {}
    facts, finish = source.get('current_facts') or {}, source.get('finish') or {}
    calculation = source.get('fuel_calculation') or {}
    rate = (calculation.get('value') or {}).get('avg_fuel_per_lap')
    current, crossings = facts.get('fuel_level_l'), finish.get('remaining_sf_crossings')
    numeric = isinstance(current, (int, float)) and isinstance(rate, (int, float)) and isinstance(crossings, int)
    required = rate * crossings + 2 if numeric else None
    same_source = ((facts.get('source_frame') or {}).get('sequence') == (source.get('source_frame') or {}).get('sequence')
                   and (facts.get('source_frame') or {}).get('session_time_s') == (source.get('source_frame') or {}).get('session_time_s')
                   and finish.get('source_frame_sequence') == (source.get('source_frame') or {}).get('sequence'))
    useful = (numeric and same_source and finish.get('available') and current >= required
              and ('現在燃料%.1fL' % current) in fuel and ('約%.1fL' % required) in fuel
              and '予備2L' in fuel and 'この推定では完走できる' in fuel
              and 'クリーン' in fuel and '確認できない' not in fuel and '不足' not in fuel)
    return _ok(useful and not disputes
               and 'ステイアウト' in plan and '燃料余裕' in plan and 'クリーン実測がまだない' not in plan and not rejected,
               {'fuel': fuel, 'plan': plan, 'disputes': len(disputes), 'race_context_rejected': rejected,
                'snapshot_id': source.get('snapshot_id'), 'current_fuel': current, 'burn_per_lap': rate,
                'remaining_crossings': crossings, 'required_with_reserve': required, 'same_source': same_source})



def c_retrospective_reaches_llm(R):
    m = R['main']
    n = m['notes'].get('retro_q') or {}
    # Only the streaming conversation request; the subtitle translation of the same Driver
    # text (/api/translate, non-streaming) is a different use and never counted here.
    reqs = [q for q in m['llm'] if q.get('stream') and any(RETRO_Q in str(x.get('content')) for x in q['messages'][-1:])]
    sysmsg = reqs[0]['system'] if reqs else ''
    body = next((b for b in m['chat_bodies'] if b.get('messages') and b['messages'][-1].get('content') == RETRO_Q), {})
    rc = body.get('raceContext') or {}
    pit = (rc.get('last_pit_event') or {})
    facts = rc.get('current_facts') or {}
    return _ok(_text(n) == RETRO_A and len(reqs) == 1 and not [l for l in m['server_log'] if 'rejected' in l]
               and pit.get('execution_relation') == 'penalty' and isinstance(facts.get('fuel_level_l'), (int, float))
               and re.search(r'ペナルティ|penalty', sysmsg) and str(facts.get('current_lap')) in sysmsg,
               {'reply': _text(n), 'chat_requests': len(reqs), 'system_chars': len(sysmsg),
                'last_pit_event': {k: pit.get(k) for k in ('pit_event_id', 'execution_relation')},
                'current_lap': facts.get('current_lap'), 'fuel': facts.get('fuel_level_l')})


def c_reconnect_same_epoch(R):
    m = R['main']
    rc = m['notes'].get('reconnect') or {}
    term_b = sorted((r.get('decision_id'), r.get('phase'), r.get('revision')) for r in rc.get('terminal_before') or [])
    term_a = sorted((r.get('decision_id'), r.get('phase'), r.get('revision')) for r in rc.get('terminal_after') or [])
    return _ok(rc.get('before_epoch') and rc.get('before_epoch') == rc.get('after_epoch') and rc.get('sockets') == 2
               and term_b == term_a and term_a and rc.get('active_after') is None and not rc.get('outbox_after'),
               {'epoch_same': rc.get('before_epoch') == rc.get('after_epoch'), 'terminal': term_a, 'active': rc.get('active_after')})


def c_late_duplicate_inert(R):
    m = R['main']
    late = m['notes'].get('late') or {}
    readbacks = _utts(m, 'driver_plan_command_ack')
    last_out = [l for l in m['cmd_outcomes']][-1:] or ['']
    return _ok(late.get('resent_command') and late.get('redelivered_acks', 0) >= 1 and len(readbacks) == 1
               and 'outcome=retry_no_op' in last_out[0] and len(m['decisions']) == 1
               and not [b for b in m['broadcasts'] if b['trigger'] == 'strategy_plan_box_call'],
               {'late': late, 'readbacks': len(readbacks), 'last_bridge_outcome': last_out[0][:80]})


def c_debrief_question(R):
    m = R['main']
    ed = (m['notes'].get('correction') or {})
    qs = [u.get('text') for u in _utts(m, 'debrief_question')]
    summary = m['desktop']['lastSessionSummary'] or {}
    return _ok(qs and qs[0] == '16周目の停止はペナルティだった。何がきっかけでペナルティを受けた？'
               and not any('一番危なかった接触' in q for q in qs)
               and [p.get('execution_relation') for p in summary.get('pit_events') or []] == ['early', 'penalty'],
               {'questions': qs, 'summary_relations': [p.get('execution_relation') for p in summary.get('pit_events') or []]})


def c_correction_parallel(R):
    m = R['main']
    recs = m['notes'].get('records_after_confirm') or []
    rec = recs[-1] if recs else {}
    corr = rec.get('outcome_corrections') or []
    outcome = rec.get('race_outcome') or {}
    pens = [p for p in outcome.get('pits') or [] if p.get('relation') == 'penalty']
    return _ok(len(corr) == 1 and corr[0].get('driver_claim') == 'not_penalty'
               and corr[0].get('canonical_relation') == 'penalty' and corr[0].get('entry_lap') == 16
               and pens and pens[0].get('entry_lap') == 16,
               {'corrections': corr, 'canonical_penalty_kept': bool(pens)})


def c_save_readback(R):
    m = R['main']
    recs = m['notes'].get('records_after_confirm') or []
    rec = recs[-1] if recs else {}
    a = _plan_a(m)
    plans = (rec.get('race_outcome') or {}).get('plans') or []
    return _ok(len(recs) == 1 and rec.get('confidence') == 'confirmed_by_driver'
               and bool(a.get('race_instance_id')) and rec.get('race_instance_id') == a.get('race_instance_id')
               and any(p.get('decision_id') == a.get('decision_id') and p.get('reason') == 'driver_early_pit_declared' for p in plans)
               and len(rec.get('qa') or []) >= 2,
               {'records': len(recs), 'confidence': rec.get('confidence'),
                'plans': [(p.get('decision_id', '')[-30:], p.get('reason')) for p in plans]})


def c_next_race_reference(R):
    m = R['main']
    nr = m.get('next_race') or {}
    n = (nr.get('notes') or {}).get('next_q') or {}
    reqs = [q for q in nr.get('llm') or [] if q.get('stream') and any(NEXT_Q in str(x.get('content')) for x in q['messages'][-1:])]
    sysmsg = reqs[0]['system'] if reqs else ''
    canon = (nr.get('desktop') or {}).get('canonical') or {}
    line = next((l for l in sysmsg.split('\n') if 'Bridge確定のPlan結果・ピット分類' in l), '')
    reply = _text(n)
    spoken = [u for u in (nr.get('desktop') or {}).get('utterances') or [] if u.get('text') == NEXT_A]
    return _ok(reply == NEXT_A and 'ペナルティ' in reply and '違う' in reply and len(reqs) == 1
               and spoken and 'completed' in spoken[0]['states']
               and '15周目' in line and 'ペナルティ' in line and 'Driver訂正' in line
               and '早めピット宣言' in line,
               {'reply': _text(n), 'requests': len(reqs), 'outcome_line': line,
                'next_canonical_race': canon.get('race_instance_id'), 'next_pits': len(nr.get('pit_events') or [])})


def c_next_race_separation(R):
    m = R['main']
    nr = m.get('next_race') or {}
    canon = (nr.get('desktop') or {}).get('canonical') or {}
    next_plan = _plan_a(nr)
    old_race = _plan_a(m).get('race_instance_id')
    next_race = next_plan.get('race_instance_id')
    first_reqs = [q for q in m['llm'] if q.get('stream') and any(RETRO_Q in str(x.get('content')) for x in q['messages'][-1:])]
    first_sys = first_reqs[0]['system'] if first_reqs else ''
    return _ok(bool(old_race) and bool(next_race) and next_race != old_race
               and canon.get('race_instance_id') == next_race
               and not (canon.get('pit_events') or []) and not nr.get('pit_events')
               and 'Bridge確定のPlan結果・ピット分類' not in first_sys,
               {'next_race': canon.get('race_instance_id'), 'next_pits': len(canon.get('pit_events') or []),
                'same_race_not_previous': 'Bridge確定のPlan結果・ピット分類' not in first_sys})


def c_held_fact_language(R):
    m = R['main']
    english = [u.get('text') for u in m['desktop']['utterances'] or [] if 'Execution held' in (u.get('text') or '')]
    return _ok(not english, {'english_held_lines': english})


def c_timing(name):
    def case(R):
        r = R[name]
        ok, d = _early_bound(r)
        hist = [x for x in ((r['desktop']['canonical'] or {}).get('terminal_records') or [])
                if x.get('decision_id') == _plan_a(r).get('decision_id')]
        ok2, d2 = _no_old_plan(r, None)
        return _ok(ok and hist and hist[0].get('invalidated_reason') == 'driver_early_pit_declared' and ok2,
                   {'pit1': d, 'plan_a_terminal': hist and (hist[0].get('phase'), hist[0].get('invalidated_reason')), 'plans': d2})
    return case


def c_lapsed_declaration(R):
    r = R['decl_lapsed']
    p1 = _pit(r, 1)
    late = [b for b in r['broadcasts'] if b['trigger'] == 'strategy_plan_decision' and b['frame'] and ENTRY1 - 8 < b['frame'] < ENTRY1 - 1]
    return _ok(p1.get('execution_relation') in ('unresolved', 'early') and p1.get('execution_relation') != 'normal'
               and not late and 'driver_early_pit_declared' in r['holds'],
               {'pit1': (p1.get('execution_relation'), p1.get('classification_reason')), 'plan_radio_while_declared': late, 'holds': r['holds']})


def c_no_declaration_control(R):
    r = R['no_declaration']
    ok, d = _early_bound(r)
    return _ok(ok and not r['declared'] and not [b for b in r['broadcasts'] if b['trigger'] == 'strategy_plan_box_call'],
               {'pit1': d, 'declared': len(r['declared'])})


def c_rephrase(R):
    r = R['rephrase']
    cmds = _cmds(r, 'driver_plan_command')
    ok, d = _early_bound(r)
    return _ok(len(cmds) >= 1 and len({c['command_id'] for c in cmds}) == 1 and cmds[0].get('reason_text')
               and REASON in cmds[0]['reason_text'] and not _cmds(r, 'driver_plan_reason') and ok,
               {'commands': len({c['command_id'] for c in cmds}), 'reason_text': cmds and cmds[0].get('reason_text'), 'pit1': d})


def c_topic_switch(R):
    r = R['topic_switch']
    return _ok(len(_cmds(r, 'driver_plan_command')) >= 1 and not _cmds(r, 'driver_plan_reason')
               and not [l for l in r['cmd_outcomes'] if 'outcome=linked' in l],
               {'reasons_sent': len(_cmds(r, 'driver_plan_reason')), 'other_reply': _text(r['notes'].get('other_topic'))})


def c_no_identity(R):
    r = R['no_identity']
    n = r['notes'].get('declare') or {}
    return _ok(not _cmds(r, 'driver_plan_command') and '現在のプランを確認できない' in ' '.join(
        (u.get('text') or '') for u in n.get('utterances') or []) and not r['declared'],
               {'commands': len(_cmds(r, 'driver_plan_command')), 'utterances': [u.get('text') for u in n.get('utterances') or []]})


def c_ack_lost(R):
    r = R['ack_lost']
    cmd = (_cmds(r, 'driver_plan_command') or [{}])[0]
    sends = [c for c in _cmds(r, 'driver_plan_command') if c['command_id'] == cmd.get('command_id')]
    outs = [l.split('outcome=')[1].split()[0] for l in r['cmd_outcomes'] if cmd.get('command_id', '?') in l]
    readbacks = _utts(r, 'driver_plan_command_ack')
    lost_acks = [x for x in r['lost'] if x.get('type') == 'driver_plan_command_ack']
    ok, d = _early_bound(r)
    return _ok(lost_acks and len(sends) >= 2 and outs.count('applied') == 1 and 'retry_no_op' in outs
               and len(readbacks) == 1 and not r['desktop']['driverPlanOutbox'] and ok
               and (r['notes'].get('late_original_ack') or {}).get('redelivered', 0) >= 1,
               {'lost_acks': len(lost_acks), 'sends': len(sends), 'outcomes': outs, 'readbacks': len(readbacks), 'pit1': d})


def c_unknown_flag(R):
    r = R['unknown_flag']
    p2 = _pit(r, 2)
    qs = [u.get('text') for u in _utts(r, 'debrief_question')]
    return _ok(p2.get('execution_relation') == 'unresolved' and (p2.get('penalty_evidence') or {}).get('state') == 'unknown'
               and not any('ペナルティだった' in (q or '') for q in qs),
               {'pit2': (p2.get('execution_relation'), (p2.get('penalty_evidence') or {}).get('state')), 'questions': qs})


def c_no_penalty_no_box(name):
    def case(R):
        r = R[name]
        plan = _text(r['notes'].get('plan_q'))
        ok, d = _no_old_plan(r, None)
        return _ok(ok and 'ボックス' not in plan and 'ピットを推奨' not in plan,
                   dict(d, plan_answer=plan))
    return case


def c_short_fuel_fresh_box(R, name='short_fuel'):
    """2.0 L at L15 is not enough: the next stop is planned from the post-stop measured state
    (never the lap-5 snapshot's target/amount) and its BOX is spoken by the real renderer.
    Pair: N07 (16.79 L) must speak no BOX at all."""
    r = R[name]
    a = _plan_a(r)
    post = [d for d in r['decisions'] if ':recalc:post_service:' in d['decision_id']]
    box = [b for b in r['broadcasts'] if b['trigger'] == 'strategy_plan_box_call']
    spoken = _utts(r, 'strategy_plan_box_call')
    p = post[0] if post else {}
    al = (r.get('post_service_aligned') or [{}])[0]
    exit_frame = max((c for c, _n, _lap, pit in r['marks'] if pit), default=None)
    want = 'ボックス、ボックス。%sリットル追加。' % p.get('set_fuel_l')
    # Provenance, not a value comparison: the fresh plan may legitimately land on the same lap.
    return _ok(post and len(post) == 1 and p.get('decided_at_lap', 0) >= 15
               and str(p.get('evidence_snapshot_id', '')).startswith('recalc:post_service:')
               and al.get('source_frame_sequence') and exit_frame is not None and al['source_frame_sequence'] > exit_frame
               and p.get('add_fuel_l') == al.get('add_fuel_l') != a.get('add_fuel_l')
               and p.get('set_fuel_l') == al.get('set_fuel_l')
               and box and all(b['decision_id'] == p['decision_id'] for b in box)
               and spoken and spoken[0].get('text') == want and 'completed' in spoken[0]['states']
               and (spoken[0].get('source') or {}).get('decision_id') == p['decision_id'],
               {'plan_a': (a.get('target_lap'), a.get('set_fuel_l')),
                'post_service': (p.get('decision_id', '')[-60:], p.get('decided_at_lap'), p.get('target_lap'), p.get('set_fuel_l')),
                'aligned': r.get('post_service_aligned'), 'box': [(b['frame'], b['decision_id'][-40:]) for b in box],
                'spoken': [(u.get('text'), u['states'][-1]) for u in spoken]})


def c_opening_box_spoken(R):
    """WO-020 P0: the automatically generated opening Plan A is registered at a target/frozen set
    the BOX authority accepts from the same frame, so a Driver following it gets the BOX on that
    lap, heard to completion; the fuel fact is not reported as a held pit instruction."""
    r = R['opening_no_pit']
    a = _plan_a(r)
    al = (r.get('opening_aligned') or [{}])[0]
    box = [b for b in r['broadcasts'] if b['trigger'] == 'strategy_plan_box_call']
    spoken = _utts(r, 'strategy_plan_box_call')
    lap_of = {c: lap for c, _n, lap, _pit in r['marks']}
    want = 'ボックス、ボックス。%sリットル追加。' % a.get('set_fuel_l')
    held = [u.get('text') for u in r['desktop']['utterances'] or [] if '保留' in (u.get('text') or '')]
    return _ok(len(r['decisions']) == 1 and ':initial:' in a.get('decision_id', '')
               and str(al.get('snapshot_id', '')).startswith('initial:')
               and (a.get('target_lap'), a.get('set_fuel_l')) == (al.get('target_lap'), al.get('set_fuel_l'))
               and box and all(b['decision_id'] == a['decision_id'] for b in box)
               and lap_of.get(box[0]['frame']) == a.get('target_lap')
               and ('Set %s liters' % a.get('set_fuel_l')) in (box[0].get('message') or '')
               and spoken and spoken[0].get('text') == want and 'completed' in spoken[0]['states']
               and (spoken[0].get('source') or {}).get('decision_id') == a['decision_id']
               and not held,
               {'plan_a': (a.get('decision_id', '')[-50:], a.get('target_lap'), a.get('set_fuel_l')),
                'opening_aligned': al, 'box': [(b['frame'], lap_of.get(b['frame']), b.get('message')) for b in box],
                'spoken': [(u.get('text'), u['states'][-1]) for u in spoken], 'held_utterances': held,
                'holds': r['holds']})


def _wait_reqs(r):
    return [q for q in r['llm'] if q.get('stream') and any(WAIT_Q in str(x.get('content')) for x in q['messages'][-1:])]


def c_llm_wait_canonical_change(R):
    """The provider reply is genuinely in flight (held before any text) while the real L15 pit
    exit retires Plan A: the reply about Plan A is neither spoken nor kept as an assistant turn.
    Control: the same 2-frame hold with no Plan change is spoken to completion."""
    ch, co = R['llm_wait_canonical_change'], R['llm_wait_control']
    nch, nco = ch['notes'].get('wait_q') or {}, co['notes'].get('wait_q') or {}
    exits = [c for c, _n, _lap, pit in ch['marks'] if not pit and any(
        c2 == c - 1 and p2 for c2, _n2, _l2, p2 in ch['marks'])]
    changed = any(nch.get('started_frame', 0) < e <= nch.get('finished_frame', 0) for e in exits)
    spoken_ch = [u for u in ch['desktop']['utterances'] if u.get('text') and WAIT_A.startswith(u['text'])]
    spoken_co = [u for u in co['desktop']['utterances'] if u.get('text') and WAIT_A.startswith(u['text'])]
    return _ok(len(_wait_reqs(ch)) == 1 and len(_wait_reqs(co)) == 1 and changed
               and not nch.get('assistant') and not spoken_ch
               and nco.get('assistant') == [WAIT_A] and spoken_co and 'completed' in spoken_co[0]['states'],
               {'change_window': (nch.get('started_frame'), nch.get('finished_frame'), exits), 'change_spoken': spoken_ch,
                'control_assistant': nco.get('assistant'), 'control_states': spoken_co and spoken_co[0]['states']})


def c_llm_wait_ttl_contract(R):
    """Existing freshness contract (WO011/WO014): a reply bound to canonical expires 5 s after the
    snapshot it was built on, even with no change. Recorded so a change to it is visible."""
    r = R['llm_wait_long_no_change']
    n = r['notes'].get('wait_q') or {}
    return _ok(len(_wait_reqs(r)) == 1 and not n.get('assistant'),
               {'held_frames': (n.get('started_frame'), n.get('finished_frame')), 'assistant': n.get('assistant')})


def c_short_fuel_7l_amount_aligned(R):
    """7.1 L: target kept, frozen amount raised to what the authority accepts, BOX heard."""
    base = c_short_fuel_fresh_box(R, 'short_fuel_7l')
    al = (R['short_fuel_7l'].get('post_service_aligned') or [{}])[0]
    ok_amount = al.get('target_lap') == al.get('from_target_lap') and (al.get('set_fuel_l') or 0) > (al.get('from_set_fuel_l') or 99)
    return _ok(base['pass'] and ok_amount, {'box_case': base['detail'], 'aligned': al})


def c_plan_question_states_active_plan(R):
    """While the fresh post-stop Plan is active (execution not yet allowed), "今のプランは？" states
    that Plan's lap and frozen amount; the fuel reference is never promoted into a box order."""
    r = R['short_fuel']
    n = r['notes'].get('plan_q') or {}
    reply = _text(n)
    post = [d for d in r['decisions'] if ':recalc:post_service:' in d['decision_id']]
    p = post[0] if post else {}
    body = next((b for b in r['chat_bodies'] if b.get('messages') and b['messages'][-1].get('content') == '今のプランは？'), {})
    active = (body.get('raceContext') or {}).get('active_plan') or {}
    want = '%s周目にピット予定' % p.get('target_lap')
    return _ok(p and active.get('decision_id') == p.get('decision_id') and want in reply
               and ('給油設定%sL' % p.get('set_fuel_l')) in reply
               and not re.search(r'でボックス|ボックス。|Box for fuel', reply),
               {'reply': reply, 'active': {k: active.get(k) for k in ('decision_id', 'target_lap', 'set_fuel_l')},
                'post_service': (p.get('target_lap'), p.get('set_fuel_l'))})


def c_amend_partial_refuel(R):
    """Real sendMsg amend to lap 15 -> driver-fixed target executed as a normal L15 stop with 2.0 L:
    the next stop comes from the post-stop state and its BOX is heard; 16.79 L control: none."""
    s, ok16 = R['amend_short_fuel'], R['amend_sufficient_fuel']
    applied = [l for l in s['cmd_outcomes'] if 'outcome=applied' in l]
    readback = [u.get('text') for u in _utts(s, 'driver_plan_command_ack')]
    post = [d for d in s['decisions'] if ':recalc:post_service:' in d['decision_id']]
    spoken = _utts(s, 'strategy_plan_box_call')
    p1 = _pit(s, 1)
    return _ok(len(applied) == 1 and '了解、15周目のピットへ変更した。' in readback
               and p1.get('execution_relation') == 'normal' and p1.get('entry', {}).get('lap') == 15
               and len(post) == 1 and spoken and 'completed' in spoken[0]['states']
               and (spoken[0].get('source') or {}).get('decision_id') == post[0]['decision_id']
               and len(ok16['decisions']) == 1 and not _utts(ok16, 'strategy_plan_box_call')
               and not [b for b in ok16['broadcasts'] if b['trigger'] == 'strategy_plan_box_call'],
               {'readback': readback, 'pit1': (p1.get('execution_relation'), p1.get('entry', {}).get('lap')),
                'post_service': [(d['target_lap'], d['set_fuel_l']) for d in post],
                'spoken': [(u.get('text'), u['states'][-1]) for u in spoken], 'control_decisions': len(ok16['decisions'])})


def c_proposal_unheard(R):
    """The same real Bridge Plan B proposal: "はい" while it is still queued behind Luna's
    answer is never sent as agreement; in the undisturbed run, "はい" after it was heard to the
    end is sent and the Bridge accepts it (normal control)."""
    u, h = R['proposal_unheard'], R['proposal_heard']
    yes_u = (u['notes'].get('yes_unheard') or {})
    unheard_sent = [x for x in yes_u.get('sent') or [] if x.get('cmd') == 'strategy_decision_response']
    unheard_accepts = [x for x in _cmds(u, 'strategy_decision_response') if x.get('accepted') is True]
    yes_h = (h['notes'].get('yes_heard') or {})
    heard_sent = [x for x in yes_h.get('sent') or [] if x.get('cmd') == 'strategy_decision_response']
    acks = [b for b in h['broadcasts'] if b['type'] == 'strategy_decision_ack']
    pu = _utts(h, 'bridge_strategy_proposal')
    prios = {h['prio'].get(x['uid']) for x in pu}
    completion=h['notes'].get('heard_completion_before_consent') or {}
    delivery=completion.get('delivery') or {}
    heard=next((x for x in pu if x['uid']==delivery.get('utterance_id')),{})
    exact_response=any(x.get('accepted') is True and x.get('decision_id')==delivery.get('decision_id')
        and x.get('dispatch_id')==delivery.get('dispatch_id') for x in heard_sent)
    interrupted_dispatches={x.get('dispatch_id') for x in _cmds(h,'strategy_decision_delivery')
        if x.get('outcome')=='audible_interrupted'}
    accepted_interrupted=[x for x in _cmds(h,'strategy_decision_response')
        if x.get('accepted') is True and x.get('dispatch_id') in interrupted_dispatches]
    return _ok(u['notes'].get('proposal_frame') is not None and not unheard_sent and not unheard_accepts
               and 'completed' in heard.get('states',[]) and 'audible_interrupted' not in heard.get('states',[])
               and exact_response and h['notes'].get('heard_matching_owner_ack')
               and not accepted_interrupted and prios == {2},
               {'unheard_reply': _text(yes_u), 'unheard_sent': unheard_sent, 'unheard_accepts': len(unheard_accepts),
                'heard_states': heard.get('states'), 'heard_sent': heard_sent,
                'completed_attempt':delivery,'accepted_interrupted':accepted_interrupted,
                'decision_acks': [b['outcome'] for b in acks], 'proposal_prio': sorted(map(str, prios))})


def c_proposal_interrupted(R):
    r = R['proposal_interrupted']
    pu = _utts(r, 'bridge_strategy_proposal')
    f0 = r['notes'].get('proposal_frame')
    accepted = [x for x in _cmds(r, 'strategy_decision_response') if x.get('accepted') is True and x['frame'] == f0]
    ptt = [x for x in _cmds(r, 'ptt_start') if x['frame'] == f0]      # the real pttStart() ran
    started = pu and 'play_started' in (pu[0].get('states') or [])
    return _ok(pu and started and 'audible_interrupted' in (pu[0].get('states') or []) and ptt and not accepted,
               {'proposal_states': pu and pu[0].get('states'), 'accepted_same_turn': accepted, 'ptt_start_sent': len(ptt),
                'reply': _text(r['notes'].get('yes_interrupted'))})


# ── WO020: trace / queue metrics / Support export (read from product output only) ─────────

def _sec(support):
    return (support or {}).get('section') or {}


def _ren_events(support, uid=None):
    ev = (_sec(support).get('renderer') or {}).get('events') or []
    return [e for e in ev if e.get('k') == 'utterance' and (uid is None or e.get('uid') == uid)]


def _bridge_events(support, k=None):
    ev = (_sec(support).get('bridge') or {}).get('events') or []
    return [e for e in ev if k is None or e.get('k') == k]


TERMINAL_STATES = ('completed', 'audible_interrupted', 'dropped_before_audible', 'suppressed', 'suppressed_by_user')


def _product_terminals(rec_desktop):
    out = {}
    for u in rec_desktop.get('utterances') or []:
        for st in u.get('states') or []:
            if st in TERMINAL_STATES:
                out[st] = out.get(st, 0) + 1
    return out


def c_w01_box_call_backtrack(R):
    """Output (heard BOX call) -> renderer trace -> native ids -> Bridge dispatch -> lifecycle."""
    rec = R['opening_no_pit']
    sup = rec['support']
    done = [e for e in _ren_events(sup) if e.get('kind') == 'strategy_plan_box_call' and e.get('state') == 'completed']
    if not done:
        return _ok(False, {'why': 'no completed BOX call in the exported renderer trace'})
    uid = done[-1]['uid']
    ids = done[-1].get('ids') or {}
    chain = [e['state'] for e in _ren_events(sup, uid)]
    waits = {e['state']: e.get('wait_ms') for e in _ren_events(sup, uid)}
    product = [u for u in rec['desktop']['utterances'] if u.get('uid') == uid]
    disp = [e for e in _bridge_events(sup, 'dispatch') if e.get('trigger') == 'strategy_plan_box_call'
            and e.get('box_attempt_id') == ids.get('box_attempt_id') and e.get('result') == 'DISPATCHED']
    life = [e for e in _bridge_events(sup, 'lifecycle') if e.get('decision_id') == ids.get('decision_id')
            and e.get('race_instance_id') == ids.get('race_instance_id')]
    want = ['generated', 'queued', 'tts_start', 'play_started', 'completed']
    src = (product[0].get('source') if product else None) or {}
    ref, pub = src.get('ref') or {}, src.get('publication_ref') or {}
    # Every exported id equals the field the product's own source carries (absent -> None);
    # the Plan activation frame is never relabelled as a source frame.
    prov = {'source_frame_sequence': (ids.get('source_frame_sequence'), ref.get('source_frame_sequence')),
            'activation_frame': (ids.get('activation_frame'), ref.get('activation_frame')),
            'proof_id': (ids.get('proof_id'), ref.get('proof_id')), 'box_attempt_id': (ids.get('box_attempt_id'), ref.get('attempt_id')),
            'canonical_snapshot_sequence': (ids.get('canonical_snapshot_sequence'), pub.get('canonical_snapshot_sequence', ref.get('canonical_snapshot_sequence')))}
    times = [e.get('t_ms') for e in _ren_events(sup, uid) if e['state'] in want]
    return _ok(all(a == b for a, b in prov.values()) and ids.get('activation_frame') is not None
               and all(isinstance(x, int) for x in times) and times == sorted(times)
               and all(ids.get(k) is not None for k in ('race_instance_id', 'session_num', 'decision_id', 'box_attempt_id', 'proof_id'))
               and [st for st in chain if st in want] == want
               and isinstance(waits.get('play_started'), int) and waits['play_started'] >= 0
               and bool(product) and 'ボックス' in (product[0].get('text') or '')
               and bool(disp) and disp[-1].get('decision_id') == ids['decision_id'] and disp[-1].get('proof_id') == ids['proof_id']
               and bool(life),
               {'uid': uid, 'ids': ids, 'provenance': prov, 't_ms': times, 'chain': chain, 'waits': waits, 'bridge_dispatch': disp[-1:], 'lifecycle': life[-1:],
                'product_text': product[0].get('text') if product else None})


def c_w02_command_ack_chain(R):
    """Driver turn id -> wire command -> Bridge applied ACK -> renderer ACK -> heard readback."""
    rec = R['main']
    sup = rec['next_race']['support']
    cmds = [c for c in (_sec(sup).get('renderer') or {}).get('commands') or [] if c.get('intent') == 'early_pit']
    if not cmds:
        return _ok(False, {'why': 'no early_pit command in the exported renderer metrics'})
    c = cmds[0]
    wire = [x for x in _cmds(rec, 'driver_plan_command') if x.get('command_id') == c['command_id']]
    acks = [e for e in _bridge_events(sup, 'dispatch') if e.get('type') == 'driver_plan_command_ack'
            and e.get('command_id') == c['command_id'] and e.get('outcome') == 'applied']
    reason = [e for e in _bridge_events(sup, 'dispatch') if e.get('type') == 'driver_plan_command_ack'
              and e.get('command_id') == c['command_id'] and e.get('intent') == 'reason']
    rb = (c.get('response_utterance_ids') or [None])[0]
    heard = [u for u in rec['desktop']['utterances'] if u.get('uid') == rb]
    ids = c.get('ids') or {}
    rev = (_sec(sup).get('renderer') or {}).get('events') or []
    t_of = lambda pred: next((e.get('t_ms') for e in rev if pred(e)), None)
    timeline = [('sent', t_of(lambda e: e.get('k') == 'command' and e.get('phase') == 'sent' and e.get('command_id') == c['command_id'])),
                ('ack', t_of(lambda e: e.get('k') == 'command' and e.get('phase') == 'ack' and e.get('command_id') == c['command_id'])),
                ('readback', t_of(lambda e: e.get('k') == 'command' and e.get('phase') == 'readback' and e.get('command_id') == c['command_id']))] + \
               [(st, t_of(lambda e, st=st: e.get('uid') == rb and e.get('state') == st)) for st in ('queued', 'play_started', 'completed')]
    tl = [v for _k, v in timeline]
    a0 = acks[-1] if acks else {}
    refs_ok = (a0.get('event_canonical_snapshot_id') == ids.get('canonical_snapshot_id')
               and a0.get('event_canonical_snapshot_sequence') == ids.get('canonical_snapshot_sequence')
               and str(a0.get('publication_snapshot_id') or '').endswith(':' + str(a0.get('publication_snapshot_sequence'))))
    return _ok(c.get('ack_outcome') == 'applied' and c.get('ack_count') == 1 and c.get('readback') is True
               and isinstance(c.get('send_to_ack_ms'), int) and c['send_to_ack_ms'] >= 0
               and bool(ids.get('decision_id')) and bool(ids.get('race_instance_id'))
               and bool(c.get('driver_utterance_id')) and bool(wire) and wire[0].get('utterance_id') == c['driver_utterance_id']
               and bool(acks) and acks[-1].get('decision_id') == ids['decision_id'] and acks[-1].get('result') == 'DISPATCHED'
               and acks[-1].get('result_revision') == c.get('result_revision')
               and c.get('reason_outcome') == 'linked' and bool(reason)
               and all(isinstance(v, int) for v in tl) and tl == sorted(tl) and refs_ok
               and bool(heard) and 'completed' in (heard[0].get('states') or []) and '了解' in (heard[0].get('text') or ''),
               {'command': c, 'timeline_t_ms': timeline, 'refs_ok': refs_ok, 'wire_utterance_id': wire[0].get('utterance_id') if wire else None, 'bridge_ack': acks[-1:],
                'reason_ack': reason[-1:], 'readback': {k: heard[0].get(k) for k in ('uid', 'states', 'text')} if heard else None})


def c_w03_duplicates_reconnect_race(R):
    m, lost = R['main'], R['ack_lost']
    o1, o2, ol = m['obs'], m['next_race']['obs'], lost['obs']
    late = m['notes'].get('late') or {}
    scope_ev = [e for e in o2['events'] if e.get('k') == 'scope']
    races = {r['race'] for r in o2['by_race']}
    lost_cmd = [c for c in ol['commands'] if c.get('intent') == 'early_pit']
    return _ok(late.get('redelivered_acks', 0) > 0 and o1['counters']['ack_unmatched'] >= late['redelivered_acks']
               and all(c['ack_count'] == 1 for c in o1['commands']) and o1['counters']['ack_duplicate'] == 0
               and o1['counters']['duplicate_terminal'] == 0
               # a same-epoch reconnect is not a race/epoch boundary (no fabricated boundary)
               and o1['counters']['reconnect_boundaries'] == 0 and o1['counters']['race_boundaries'] == 0
               # the next race is one boundary, with both races kept apart
               and o2['counters']['race_boundaries'] >= 1 and bool(scope_ev)
               and scope_ev[-1]['from']['race_instance_id'] != scope_ev[-1]['to']['race_instance_id']
               and len([r for r in races if r != 'unknown']) >= 2
               # lost ACK + outbox resend + late original ACK: one settled ACK, the extra one unmatched
               and bool(lost_cmd) and lost_cmd[0]['ack_count'] == 1 and ol['counters']['ack_unmatched'] >= 1,
               {'main_counters': {k: o1['counters'][k] for k in ('ack_unmatched', 'ack_duplicate', 'reconnect_boundaries', 'race_boundaries')},
                'late': late, 'next_scope': scope_ev[-1:], 'races': sorted(races),
                'ack_lost': {'command': lost_cmd[:1], 'ack_unmatched': ol['counters']['ack_unmatched']}})


def c_w04_terminal_truth(R):
    """Recorder terminals == product trace terminals; generated/queued never complete."""
    bad, detail = [], {}
    for name in ('proposal_interrupted', 'proposal_unheard', 'main', 'opening_no_pit', 'offline_export'):
        rec = R[name]
        o = rec['obs']
        prod = _product_terminals(rec['desktop'])
        detail[name] = {'recorder': o['terminal_outcomes'], 'product': prod, 'open': o['counters']['open_without_terminal'],
                        'completed_without_play': o['counters']['completed_without_play'], 'unknown_clock': o['counters']['unknown_clock']}
        if o['terminal_outcomes'] != prod or o['counters']['completed_without_play'] or o['counters']['unknown_clock']:
            bad.append(name)
        if any(k not in TERMINAL_STATES for k in o['terminal_outcomes']):
            bad.append(name + ':non_terminal_counted_as_outcome')
    # Per utterance (not only totals): every proposal's recorded terminal equals the product's.
    pi = R['proposal_interrupted']
    prop = [u for u in pi['desktop']['utterances'] if u.get('kind') == 'bridge_strategy_proposal']
    rec_term = {e['uid']: e['state'] for e in pi['obs']['events'] if e.get('k') == 'utterance' and e.get('state') in TERMINAL_STATES}
    per_uid = {u['uid']: ([st for st in u.get('states') or [] if st in TERMINAL_STATES][-1:] or [None])[0] for u in prop}
    # A queue drop is an invariant across the existing replay records, not
    # an incidental timing requirement of the proposal-interruption fixture.
    # Renderer uid counters restart per scenario: never join different runs.
    drops, drop_played = [], []
    for name in detail:
        events=R[name]['obs']['events']
        for event in events:
            if event.get('state')!='dropped_before_audible':continue
            dropped={'scenario':name,'uid':event.get('uid')}
            drops.append(dropped)
            if any(x.get('uid')==event.get('uid') and x.get('state')=='play_started' for x in events):
                drop_played.append(dropped)
    off = R['offline_export']['obs']
    return _ok(not bad and bool(per_uid) and all(rec_term.get(uid) == st for uid, st in per_uid.items())
               and 'audible_interrupted' in per_uid.values()
               and bool(drops) and not drop_played
               and off['counters']['open_without_terminal'] == len(off['open_utterances']),
               {'bad': bad, 'per_record': detail, 'proposal_terminal_product': per_uid,
                'proposal_terminal_recorder': {u: rec_term.get(u) for u in per_uid}, 'drops': drops[:3], 'dropped_with_play':drop_played})


def c_w05_bounded_text_free(R):
    bad, detail = [], {}
    for name, rec in R.items():
        sups = [('support', rec.get('support'))] + [(k, rec.get(k)) for k in ('support_no_bridge_log', 'support_with_bridge_log')]
        if rec.get('next_race'):
            sups.append(('next_race', rec['next_race'].get('support')))
        for label, sup in sups:
            if not sup:
                continue
            sec = _sec(sup)
            ren, br = sec.get('renderer') or {}, sec.get('bridge') or {}
            ok = (sup['has_section'] and not sup['leaked_texts'] and not sup['leaked_credentials']
                  and sup['section_bytes'] <= 96 * 1024 and len(ren.get('events') or []) <= 256 and len(br.get('events') or []) <= 200)
            detail[name + ':' + label] = {'section_bytes': sup['section_bytes'], 'leaks': sup['leaked_texts'] + sup['leaked_credentials'],
                                          'renderer_events': len(ren.get('events') or []), 'bridge_kept': br.get('kept')}
            if not ok:
                bad.append(name + ':' + label)
        lv = rec.get('log_volume') or {}
        if lv.get('frames') and lv['trace_lines'] > lv['frames'] * 0.5:
            bad.append(name + ':trace_volume')
    return _ok(not bad and bool(detail), {'bad': bad, 'exports': detail,
                                          'trace_volume': {k: v.get('log_volume') for k, v in R.items()}})


def c_w06_offline_export(R):
    rec = R['offline_export']
    no, withb = rec['support_no_bridge_log'], rec['support_with_bridge_log']
    asked = (rec['notes'].get('offline_q') or {}).get('utterances') or []
    uids = {u['uid'] for u in asked}
    ren = _sec(no).get('renderer') or {}
    seen = [e for e in ren.get('events') or [] if e.get('uid') in uids]
    nb, wb = _sec(no).get('bridge') or {}, _sec(withb).get('bridge') or {}
    return _ok(rec['offline_connected'] is False and no['has_section'] and ren.get('available') is True
               and nb.get('lines_seen') == 0 and bool(uids) and bool(seen)
               and withb['has_section'] and (wb.get('kept') or 0) > 0,
               {'connected': rec['offline_connected'], 'offline_uids': sorted(uids), 'seen_states': [(e['uid'], e['state']) for e in seen],
                'bridge_no_log': nb.get('lines_seen'), 'bridge_with_log': wb.get('kept')})


def c_w07_record_transitions_match_product(R):
    """Every Bridge record / pit row in the Support export equals a state the real Bridge published
    (and vice versa for the races covered): real phase, reason, pit ref — nothing inferred."""
    bad, detail = [], {}
    for name, sup_key in (('main', 'next_race'), ('proposal_unheard', None), ('ack_lost', None)):
        rec = R[name]
        sup = rec['next_race']['support'] if sup_key else rec['support']
        truth = {'terminal': set(map(tuple, rec['canonical_truth']['terminal'])), 'awaiting': set(map(tuple, rec['canonical_truth']['awaiting'])),
                 'pit_events': set(map(tuple, rec['canonical_truth']['pit_events']))}
        if sup_key:
            for k in truth:
                truth[k] |= set(map(tuple, rec['next_race']['canonical_truth'][k]))
        br = _sec(sup).get('bridge') or {}
        rows = br.get('events') or []
        term = {(e.get('decision_id'), e.get('revision'), e.get('phase'), e.get('invalidated_reason'), e.get('terminal_pit_event_id'))
                for e in rows if e.get('k') == 'record' and e.get('slot') == 'terminal'}
        awaiting = {(e.get('decision_id'), e.get('phase')) for e in rows if e.get('k') == 'record' and e.get('slot') == 'awaiting'}
        pits = {(e.get('pit_event_id'), e.get('driver_pit_sequence'), e.get('execution_relation'), e.get('penalty_state'), e.get('plan_decision_id'))
                for e in rows if e.get('k') == 'pit_event'}
        complete = not br.get('truncated')
        ok = (term <= truth['terminal'] and awaiting <= truth['awaiting'] and pits <= truth['pit_events']
              and (not complete or (term == truth['terminal'] and pits == truth['pit_events'] and awaiting == truth['awaiting'])))
        detail[name] = {'complete_export': complete, 'terminal_rows': sorted(map(list, term), key=str)[:6],
                        'terminal_truth': sorted(map(list, truth['terminal']), key=str)[:6], 'awaiting_rows': sorted(map(list, awaiting), key=str),
                        'awaiting_truth': sorted(map(list, truth['awaiting']), key=str), 'pit_rows': sorted(map(list, pits), key=str),
                        'pit_truth': sorted(map(list, truth['pit_events']), key=str)}
        if not ok:
            bad.append(name)
    m = detail['main']
    plan_a = [t for t in m['terminal_rows'] if t[2] == 'invalidated']
    linked = [p for p in m['pit_rows'] if p[2] == 'early' and plan_a and p[4] == plan_a[0][0]]
    penalty = [p for p in m['pit_rows'] if p[2] == 'penalty' and p[3] == 'true']
    return _ok(not bad and bool(plan_a) and bool(linked) and bool(penalty) and bool(detail['proposal_unheard']['awaiting_rows']),
               {'bad': bad, 'plan_a_terminal': plan_a, 'early_pit_linked': linked, 'penalty_pit': penalty, 'per_record': detail})


def c_i01_build_identity(R):
    """WO021: Support export header, start-gate label and usage `build` all name the product Build
    of the Bridge being run (BUILD_VERSION, parsed with the workflows' regex) and say it is unbuilt
    source — never another Build number and never the released artifact's bare "Build N"."""
    bad, detail = [], {}
    for name, rec in R.items():
        m = re.search(r'BUILD_VERSION\s*=\s*"Build\s+(\d+)', 'BUILD_VERSION = "%s"' % (rec.get('bridge_build_version') or ''))
        n = int(m.group(1)) if m else None
        want_label, want_usage = ('Build %d (unbuilt source)' % n, '%d-unbuilt' % n) if n else (None, None)
        sups = [rec.get(k) for k in ('support', 'support_no_bridge_log', 'support_with_bridge_log') if rec.get(k)]
        if rec.get('next_race'):
            sups.append(rec['next_race'].get('support'))
        lines = [s.get('build_line') for s in sups if s]
        b = rec.get('build') or {}
        detail[name] = {'bridge_build': n, 'support_build_lines': lines, 'gate_build': b.get('gateBuild'), 'usage_build': b.get('usageBuild')}
        if not n or not lines or any(l != want_label for l in lines) or b.get('gateBuild') != want_label or b.get('usageBuild') != want_usage:
            bad.append(name)
    return _ok(not bad, {'bad': bad, 'per_scenario': detail})


def c_no_paid_api(R):
    bad = {k: v['desktop']['blockedFetches'] for k, v in R.items() if v['desktop']['blockedFetches']}
    return _ok(not bad, {'blocked': bad})


CASES = {
    'R01_compound_tyre_negation_cancel_ack_readback': (['compound_cancel'], c_compound_cancel),
    'R02_cancel_near_pit_readback_matches_terminal': (['compound_cancel_near_pit'], lambda R: c_compound_cancel(R, 'compound_cancel_near_pit')),
    'M01_plan_a_real_and_spoken': (['main'], c_plan_a_real),
    'M02_window_answer_meaning': (['main'], c_window_answer),
    'M03_declaration_real_command_ack_readback': (['main'], c_declaration_command),
    'M04_reason_linked_by_handler': (['main'], c_reason_linked),
    'M05_resend_idempotent': (['main'], c_duplicate_idempotent),
    'M06_pit15_early_bound_pit16_penalty': (['main'], c_pits_bound),
    'M07_no_old_plan_no_box': (['main'], c_no_old_plan),
    'M08_fresh_current_answers': (['main'], c_fresh_current_answers),
    'M09_retrospective_reaches_llm_with_current_facts': (['main'], c_retrospective_reaches_llm),
    'M10_same_epoch_reconnect_keeps_terminal': (['main'], c_reconnect_same_epoch),
    'M11_late_duplicate_command_and_ack_inert': (['main'], c_late_duplicate_inert),
    'M12_debrief_canonical_question_first': (['main'], c_debrief_question),
    'M13_correction_parallel_not_overwrite': (['main'], c_correction_parallel),
    'M14_save_readback': (['main'], c_save_readback),
    'M15_next_race_reference': (['main'], c_next_race_reference),
    'M16_next_race_separation': (['main'], c_next_race_separation),
    'M17_held_fact_in_session_language': (['main'], c_held_fact_language),
    'T01_declared_on_entry_frame': (['decl_entry_frame'], c_timing('decl_entry_frame')),
    'T02_declared_one_frame_before': (['decl_one_before'], c_timing('decl_one_before')),
    'T03_declaration_lapsed_not_attributed': (['decl_lapsed'], c_lapsed_declaration),
    'T04_no_declaration_control': (['no_declaration'], c_no_declaration_control),
    'N01_rephrase_single_utterance': (['rephrase'], c_rephrase),
    'N02_topic_switch_drops_reason': (['topic_switch'], c_topic_switch),
    'N03_no_identity_no_command': (['no_identity'], c_no_identity),
    'N04_ack_lost_reconnect_resend': (['ack_lost'], c_ack_lost),
    'N05_black_flag_unknown_not_penalty': (['unknown_flag'], c_unknown_flag),
    'N06_no_penalty_declared_no_box': (['no_penalty_declared'], c_no_penalty_no_box('no_penalty_declared')),
    'N07_no_penalty_undeclared_no_box': (['no_penalty_undeclared'], c_no_penalty_no_box('no_penalty_undeclared')),
    'N08_short_fuel_fresh_next_stop_box_spoken': (['short_fuel'], c_short_fuel_fresh_box),
    'N09_sufficient_fuel_dense_no_box_control': (['sufficient_fuel_dense'], c_no_penalty_no_box('sufficient_fuel_dense')),
    'N12_short_fuel_7l_frozen_amount_aligned_box_spoken': (['short_fuel_7l'], c_short_fuel_7l_amount_aligned),
    'N10_plan_question_states_active_plan_not_reference_box': (['short_fuel'], c_plan_question_states_active_plan),
    'N11_amend_then_partial_refuel_fresh_next_stop': (['amend_short_fuel', 'amend_sufficient_fuel'], c_amend_partial_refuel),
    'P01_unheard_proposal_refused_heard_applied': (['proposal_unheard', 'proposal_heard'], c_proposal_unheard),
    'P02_interrupted_proposal_refused': (['proposal_interrupted'], c_proposal_interrupted),
    'G01_llm_reply_in_flight_canonical_change': (['llm_wait_canonical_change', 'llm_wait_control'], c_llm_wait_canonical_change),
    'G02_llm_reply_binding_ttl_contract': (['llm_wait_long_no_change'], c_llm_wait_ttl_contract),
    'O01_opening_plan_authority_aligned_box_spoken': (['opening_no_pit'], c_opening_box_spoken),
    'W01_box_call_output_to_native_source': (['opening_no_pit'], c_w01_box_call_backtrack),
    'W02_driver_command_ack_readback_chain': (['main'], c_w02_command_ack_chain),
    'W03_duplicate_ack_reconnect_race_boundary': (['main', 'ack_lost'], c_w03_duplicates_reconnect_race),
    'W04_terminal_truth_no_queued_completion': (['proposal_interrupted', 'proposal_unheard', 'main', 'opening_no_pit', 'offline_export'], c_w04_terminal_truth),
    'W05_bounded_allowlisted_support_export': (['main', 'opening_no_pit', 'proposal_interrupted', 'offline_export', 'ack_lost'], c_w05_bounded_text_free),
    'W06_offline_export_keeps_renderer_trace': (['offline_export'], c_w06_offline_export),
    'W07_bridge_record_transitions_match_product': (['main', 'proposal_unheard', 'ack_lost'], c_w07_record_transitions_match_product),
    'I01_build_identity_matches_bridge_unbuilt_source': (['main', 'offline_export'], c_i01_build_identity),
    'Z01_no_external_fetch': (list(SCENARIOS), c_no_paid_api),
}


# ══════════════════════════════════════════════════════════════════════
# Guard cuts (each on a disposable overlay of this checkout) and anchors
# ══════════════════════════════════════════════════════════════════════

CUTS = [
    {'id': 'K01_declaration_binding', 'file': 'irsdk-bridge/bridge.py',
     'edits': [("    if not isinstance(declaration, dict) or state is None:\n        return None\n    if (declaration.get('race_instance_id')",
                "    if True:\n        return None\n    if (declaration.get('race_instance_id')")],
     'red': ['T02_declared_one_frame_before', 'M06_pit15_early_bound_pit16_penalty'],
     'green': ['T01_declared_on_entry_frame', 'T04_no_declaration_control']},
    {'id': 'K02_post_service_snapshot_invalidation', 'file': 'irsdk-bridge/bridge.py',
     'edits': [("        if _post_event_active is None and _pit_exit_finalized_this_frame:\n",
                "        if False and _post_event_active is None and _pit_exit_finalized_this_frame:\n")],
     'red': ['N07_no_penalty_undeclared_no_box', 'M07_no_old_plan_no_box', 'N08_short_fuel_fresh_next_stop_box_spoken',
             'N11_amend_then_partial_refuel_fresh_next_stop'],
     'green': ['M06_pit15_early_bound_pit16_penalty']},
    {'id': 'K03_declared_execution_gate', 'file': 'irsdk-bridge/bridge.py',
     'edits': [("            'driver_early_pit_declared' if _declared_early_pit_record is not None else None)",
                "            None)"),
               ("            'driver_early_pit_declared' if early_pit_declaration_outstanding(",
                "            None if early_pit_declaration_outstanding(")],
     'red': ['M07_no_old_plan_no_box'],
     'green': ['T01_declared_on_entry_frame']},
    {'id': 'K04_held_fact_language', 'file': 'desktop/renderer.html',
     'edits': [("    text=(sel==='Kanbe'||sel==='Oishi'||sel==='HajimeJP'||sel==='LunaJP')&&Number.isFinite(_heldFuel)",
                "    text=false&&Number.isFinite(_heldFuel)")],
     'red': ['M17_held_fact_in_session_language'], 'green': ['M02_window_answer_meaning']},
    {'id': 'K05_window_reference_answer', 'file': 'desktop/local-intent-router.js',
     'edits': [("      if(!sameFrame){\n",
                "      if(!sameFrame){return {state:'reference',reply:isJP(lang)?`燃料ウィンドウは${age}秒前の比較計算。現在の成立条件は再確認が必要。`:''};\n")],
     'red': ['M02_window_answer_meaning'], 'green': ['M03_declaration_real_command_ack_readback']},
    {'id': 'K06_sufficiency_question_not_dispute', 'file': 'desktop/dispute-detector.js',
     'edits': [("  const negationText = SUFFICIENCY_QUESTION.test(text) ?", "  const negationText = false ?")],
     'red': ['M08_fresh_current_answers'], 'green': ['M02_window_answer_meaning']},
    {'id': 'K07_retrospective_not_current_card', 'file': 'engineer-card.js',
     'edits': [("  if (isRetro(t)) {\n", "  if (false) {\n")],
     'red': ['M09_retrospective_reaches_llm_with_current_facts', 'M15_next_race_reference'],
     'green': ['M08_fresh_current_answers']},
    {'id': 'K08_canonical_debrief_question_first', 'file': 'desktop/renderer.html',
     'edits': [("        if(questions[0]&&questions[0]===outcomeFirstQuestion(safeData)) questions.splice(1,0,q.line);",
                "        if(false) questions.splice(1,0,q.line);")],
     'red': ['M12_debrief_canonical_question_first', 'M13_correction_parallel_not_overwrite'],
     'green': ['M06_pit15_early_bound_pit16_penalty']},
    {'id': 'K09_proposal_priority_defined', 'file': 'desktop/renderer.html',
     'edits': [("P2_PROCEDURE:2, P2_CRITICAL:2,", "P2_PROCEDURE:2,")],
     'red': ['P01_unheard_proposal_refused_heard_applied'], 'green': ['P02_interrupted_proposal_refused']},
    {'id': 'K10_interrupted_proposal_invalidated', 'file': 'desktop/renderer.html',
     'edits': [("        _S.invalidatePendingProposal(_st,{at:Date.now(),decision_id:decisionId,reason:'audible_interrupted'});",
                "        void 0;"),
               ("      if(_trackedNow && _trackedNow.dispatchId===_dispatchId) bridgeStrategyDecisions.delete(decisionId);\n", "")],
     'red': ['P02_interrupted_proposal_refused'], 'green': ['M03_declaration_real_command_ack_readback']},
    {'id': 'K11_command_retry_idempotent', 'file': 'irsdk-bridge/bridge.py',
     'edits': [("        elif ack.get('outcome') in ('applied', 'retry_no_op'):\n            ack['outcome'] = 'retry_no_op'",
                "        elif ack.get('outcome') in ('applied', 'retry_no_op'):\n            ack['outcome'] = ack['outcome']")],
     'red': ['M05_resend_idempotent'], 'green': ['M06_pit15_early_bound_pit16_penalty']},
    {'id': 'K12_unknown_flag_not_penalty', 'file': 'irsdk-bridge/driver_pit_event.py',
     'edits': [("    if penalty_evidence.state == 'unknown':\n        return 'unresolved', 'penalty_evidence_unknown'",
                "    if penalty_evidence.state == 'unknown':\n        return 'penalty', 'authoritative_black_flag'")],
     'red': ['N05_black_flag_unknown_not_penalty'], 'green': ['T04_no_declaration_control']},
]


CUTS += [
    {'id': 'K13_post_service_frozen_amount_aligned', 'file': 'irsdk-bridge/bridge.py',
     'edits': [("        if not (check.get('available') and fixed_target_authority_mod.evaluate(\n"
                "                authority_inputs, candidate, frozen_set=check['set_fuel_l']).get('available')):\n",
                "        if not check.get('available'):\n"),
               ("        if candidate == target and plan_a.get('set_fuel_l') == check['set_fuel_l'] \\\n"
                "                and fixed_target_authority_mod.evaluate(authority_inputs, target,\n"
                "                                                        frozen_set=plan_a.get('set_fuel_l')).get('available'):\n",
                "        if candidate == target:\n")],
     'red': ['N12_short_fuel_7l_frozen_amount_aligned_box_spoken'], 'green': ['N08_short_fuel_fresh_next_stop_box_spoken']},
    {'id': 'K14_server_passes_canonical_active_plan', 'file': 'server.js',
     'edits': [("    active_plan: raceContext && raceContext.active_plan && raceContext.active_plan.phase === 'active'\n",
                "    active_plan: false && raceContext && raceContext.active_plan && raceContext.active_plan.phase === 'active'\n")],
     'red': ['N10_plan_question_states_active_plan_not_reference_box'], 'green': ['M08_fresh_current_answers']},
    {'id': 'K15_reference_never_promoted_to_box', 'file': 'engineer-card.js',
     'edits': [("  if (active && finite(active.target_lap) != null) {\n", "  if (false) {\n"),
               ("  if (modern && p.action === 'box') {\n", "  if (false) {\n")],
     'red': ['N10_plan_question_states_active_plan_not_reference_box'], 'green': ['M08_fresh_current_answers']},
    {'id': 'K16_memory_track_identity_both_names', 'file': 'desktop/renderer.html',
     'edits': [("  return [lastTrack,lastTrackId].filter(Boolean);\n", "  return [lastTrack].filter(Boolean);\n")],
     'red': ['M15_next_race_reference'], 'green': ['M14_save_readback']},
    {'id': 'K18_held_fuel_fact_never_preempts_box', 'file': 'desktop/renderer.html',
     'edits': [("    if(typeof data.prio==='number'&&data.prio<SPEAK_PRIO.P2_PROCEDURE) data={...data,prio:SPEAK_PRIO.P2_PROCEDURE};\n", "")],
     'red': ['N12_short_fuel_7l_frozen_amount_aligned_box_spoken'], 'green': ['N09_sufficient_fuel_dense_no_box_control']},
    {'id': 'K17_reason_ack_echoes_event_id', 'file': 'irsdk-bridge/bridge.py',
     'edits': [("               'reason_event_id': command.get('reason_event_id'),\n", "")],
     'red': ['M04_reason_linked_by_handler'], 'green': ['M03_declaration_real_command_ack_readback']},
    # WO-020 P0: only the opening registration call is cut; post-service alignment stays.
    {'id': 'K19_opening_plan_authority_aligned', 'file': 'irsdk-bridge/bridge.py',
     'edits': [("                    _candidate_options, _opening_clamp = align_post_service_target(\n",
                "                    _opening_clamp = None and align_post_service_target(\n")],
     'red': ['O01_opening_plan_authority_aligned_box_spoken'],
     'green': ['N12_short_fuel_7l_frozen_amount_aligned_box_spoken', 'N09_sufficient_fuel_dense_no_box_control',
               'N11_amend_then_partial_refuel_fresh_next_stop']},
]


# WO020 guard cuts: each removes one observation hook (or forges a completion) on the overlay.
CUTS += [
    {'id': 'K20_renderer_utterance_trace_hook', 'file': 'desktop/renderer.html',
     'edits': [("  typeof observabilityUtterance==='function'&&observabilityUtterance(uid,state,",
                "  false&&observabilityUtterance(uid,state,")],
     'red': ['W01_box_call_output_to_native_source', 'W04_terminal_truth_no_queued_completion'],
     'green': ['M03_declaration_real_command_ack_readback', 'O01_opening_plan_authority_aligned_box_spoken']},
    {'id': 'K21_renderer_command_ack_hook', 'file': 'desktop/renderer.html',
     'edits': [("  typeof observabilityCommand==='function'&&observabilityCommand('ack',{command_id:data.command_id,",
                "  false&&observabilityCommand('ack',{command_id:data.command_id,")],
     'red': ['W02_driver_command_ack_readback_chain'],
     'green': ['M03_declaration_real_command_ack_readback', 'W01_box_call_output_to_native_source']},
    {'id': 'K22_bridge_dispatch_trace', 'file': 'irsdk-bridge/bridge.py',
     'edits': [("            BRIDGE_TRACE.dispatch(_staged_event,_actual_dispatch,_canonical_wire)\n", "            pass\n")],
     'red': ['W02_driver_command_ack_readback_chain'],
     'green': ['W01_box_call_output_to_native_source', 'M03_declaration_real_command_ack_readback']},
    {'id': 'K23_main_support_section', 'file': 'desktop/main.js',
     'edits': [("      fs.writeFileSync(destination, header + redactDiagnosticText(raw) + redactDiagnosticText(observabilitySection));",
                "      fs.writeFileSync(destination, header + redactDiagnosticText(raw));")],
     'red': ['W06_offline_export_keeps_renderer_trace', 'W01_box_call_output_to_native_source'],
     'green': ['M03_declaration_real_command_ack_readback', 'W04_terminal_truth_no_queued_completion']},
    {'id': 'K25_bridge_record_transitions', 'file': 'irsdk-bridge/observability_trace.py',
     'edits': [("        self._records(life, observed)\n        self._pit_events(ledger, observed)\n", "")],
     'red': ['W07_bridge_record_transitions_match_product'],
     'green': ['W02_driver_command_ack_readback_chain', 'M06_pit15_early_bound_pit16_penalty']},
    {'id': 'K26_activation_frame_relabelled_as_source_frame', 'file': 'desktop/observability-trace.js',
     'edits': [("      source_frame_sequence: ref.source_frame_sequence,\n", "      source_frame_sequence: ref.source_frame_sequence ?? ref.activation_frame,\n")],
     'red': ['W01_box_call_output_to_native_source'],
     'green': ['W02_driver_command_ack_readback_chain', 'O01_opening_plan_authority_aligned_box_spoken']},
    {'id': 'K24_queued_counted_as_completed', 'file': 'desktop/observability-trace.js',
     # forge: a completion is counted the moment an utterance is queued (never played)
     'edits': [("      if (st === 'queued') {\n", "      if (st === 'queued') { boundedInc(terminals, 'completed', 16);\n")],
     'red': ['W04_terminal_truth_no_queued_completion'],
     'green': ['M03_declaration_real_command_ack_readback']},
]


# WO021 guard cuts: each breaks one Build-identity link (reader use or the tracked source file).
CUTS += [
    {'id': 'K27_main_label_bypasses_shared_reader', 'file': 'desktop/main.js',
     'edits': [("    return require('./build-identity.js').describe(info).label;\n",
                "    return info.buildNum != null ? 'Build ' + info.buildNum : '';\n")],
     'red': ['I01_build_identity_matches_bridge_unbuilt_source'],
     'green': ['W06_offline_export_keeps_renderer_trace', 'M03_declaration_real_command_ack_readback']},
    {'id': 'K28_renderer_usage_build_ignores_unbuilt', 'file': 'desktop/renderer.html',
     'edits': [("  usageBuild = bi.usage_build;\n", "  usageBuild = String(info.buildNum);\n")],
     'red': ['I01_build_identity_matches_bridge_unbuilt_source'],
     'green': ['W01_box_call_output_to_native_source']},
    {'id': 'K29_tracked_build_info_stale_257', 'file': 'desktop/build-info.json',
     'edits': [(open(os.path.join(REPO, 'desktop', 'build-info.json'), encoding='utf-8').read().strip(),
                '{"buildDate":"2026-08-08","buildNum":257,"buildTag":"local-257"}')],
     'red': ['I01_build_identity_matches_bridge_unbuilt_source'],
     'green': ['M03_declaration_real_command_ack_readback', 'W06_offline_export_keeps_renderer_trace']},
]


# Release regressions: grammar loss and the former unrelated-facts ACK fence.
CUTS += [
    {'id': 'K30_whole_turn_negation_swallows_cancel', 'file': 'desktop/local-intent-router.js',
     'edits': [("/i.test(necessity?negationText.replace(/入らないと|入んないと|入らなければ|入らなきゃ|行かないと/g,'入る必要がある'):negationText);", '/i.test(text);')],
     'red': ['R01_compound_tyre_negation_cancel_ack_readback'],
     'green': ['M03_declaration_real_command_ack_readback']},
    {'id': 'K31_terminal_readback_uses_unrelated_fuel_facts', 'file': 'desktop/renderer.html',
     'edits': [("const binding=e.intent==='amend'?strategyProjection.binding()\n      :strategyProjection.binding({kind:'terminal',decision_id:record.decision_id});",
                "const binding=strategyProjection.binding()||strategyProjection.binding('facts');")],
     'red': ['R01_compound_tyre_negation_cancel_ack_readback', 'R02_cancel_near_pit_readback_matches_terminal'],
     'green': ['M03_declaration_real_command_ack_readback']},
]


def check_anchors(root=REPO):
    out = []
    for cut in CUTS:
        src = open(os.path.join(root, cut['file']), encoding='utf-8').read()
        counts = [src.count(old) for old, _new in cut['edits']]
        out.append({'id': cut['id'], 'file': cut['file'], 'counts': counts, 'ok': all(c == 1 for c in counts)})
    return out


def make_overlay(dst, source=REPO, edits=None):
    """Disposable copy of the product files this harness executes; dependencies are symlinked."""
    if os.path.exists(dst):
        shutil.rmtree(dst)
    os.makedirs(dst)
    for name in os.listdir(source):
        p = os.path.join(source, name)
        if os.path.isfile(p):
            shutil.copy2(p, os.path.join(dst, name))
    for sub in ('desktop', 'irsdk-bridge'):
        os.makedirs(os.path.join(dst, sub))
        for name in os.listdir(os.path.join(source, sub)):
            p = os.path.join(source, sub, name)
            if os.path.isfile(p):
                shutil.copy2(p, os.path.join(dst, sub, name))
    shutil.copytree(os.path.join(source, 'fixtures'), os.path.join(dst, 'fixtures'))
    for link in ('node_modules', 'public'):
        if os.path.exists(os.path.join(source, link)):
            os.symlink(os.path.join(source, link), os.path.join(dst, link))
    open(os.path.join(dst, WO019_OVERLAY_MARKER), 'w').write('disposable WO019 overlay\n')
    for rel, old, new in edits or []:
        path = os.path.join(dst, rel)
        src = open(path, encoding='utf-8').read()
        if src.count(old) != 1:
            raise HarnessError('cut anchor drift in %s (%d matches)' % (rel, src.count(old)))
        open(path, 'w', encoding='utf-8').write(src.replace(old, new))
    return dst


# ══════════════════════════════════════════════════════════════════════
# Runner
# ══════════════════════════════════════════════════════════════════════

def run_scenario_subprocess(name, root):
    env = dict(os.environ, WO019_PRODUCT_ROOT=root)
    p = subprocess.run([sys.executable, os.path.abspath(__file__), '--scenario', name],
                       cwd=REPO, env=env, capture_output=True, text=True, timeout=900)
    for line in p.stdout.splitlines():
        if line.startswith('WO019_RECORD '):
            return json.loads(line[len('WO019_RECORD '):])
    raise HarnessError('scenario %s on %s produced no record (exit %s): %s' % (
        name, root, p.returncode, (p.stdout[-1500:] + p.stderr[-2500:])))


def run_cases(root, case_ids=None, workers=4):
    case_ids = case_ids or list(CASES)
    needed = sorted({s for cid in case_ids for s in CASES[cid][0]})
    records, harness = {}, {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(run_scenario_subprocess, s, root): s for s in needed}
        for fut in concurrent.futures.as_completed(futs):
            s = futs[fut]
            try:
                records[s] = fut.result()
            except Exception as e:  # noqa: BLE001 - harness boundary
                harness[s] = str(e)[-3000:]
    results = {}
    for cid in case_ids:
        deps, fn = CASES[cid]
        missing = [s for s in deps if s not in records]
        if missing:
            results[cid] = {'pass': None, 'harness_error': {s: harness.get(s) for s in missing}}
            continue
        try:
            results[cid] = fn({s: records[s] for s in deps})
        except Exception as e:  # noqa: BLE001 - a crashing assertion is a failed expectation
            results[cid] = {'pass': False, 'detail': 'case raised: %r' % e}
    return results, records, harness


def cost_proxy(records):
    m = records.get('main')
    if not m:
        return None
    chat = [q for q in m['llm'] if q.get('stream')]
    translate = [q for q in m['llm'] if not q.get('stream')]
    routes = {}
    for a in m['api']:
        routes[a['route']] = routes.get(a['route'], 0) + 1
    return {'renderer_requests_by_route': routes,
            'provider_requests_chat_like': len(chat),
            'provider_requests_translate_like': len(translate),
            'chat_system_chars': [len(q['system']) for q in chat],
            'chat_message_chars': [sum(len(str(x.get('content'))) for x in q['messages']) for q in chat],
            'note': 'proxy from the stubbed SDK request capture; not tokens or billed cost'}


def main(argv):
    if '--scenario' in argv:
        name = argv[argv.index('--scenario') + 1]
        try:
            rec = SCENARIOS[name](PRODUCT_ROOT)
        except HarnessError as e:
            print('WO019_HARNESS_ERROR ' + str(e))
            return 2
        print('WO019_RECORD ' + json.dumps(rec, ensure_ascii=False, default=str))
        return 0
    out_json = argv[argv.index('--json') + 1] if '--json' in argv else None
    if '--anchors' in argv:
        res = check_anchors()
        for r in res:
            print(('✅' if r['ok'] else '❌') + ' anchor %s %s %s' % (r['id'], r['file'], r['counts']))
        if out_json:
            json.dump(res, open(out_json, 'w'), ensure_ascii=False, indent=1)
        return 0 if all(r['ok'] for r in res) else 1
    if '--cuts' in argv:
        report, failed, harness = [], 0, 0
        only_cuts = argv[argv.index('--cut-ids') + 1].split(',') if '--cut-ids' in argv else None
        for cut in [c for c in CUTS if not only_cuts or c['id'] in only_cuts]:
            tmp = tempfile.mkdtemp(prefix='wo019-cut-')
            try:
                make_overlay(tmp, edits=[(cut['file'], o, n) for o, n in cut['edits']])
                res, _rec, herr = run_cases(tmp, cut['red'] + cut['green'])
            except HarnessError as e:
                res, herr = {}, {'overlay': str(e)}
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
            red_ok = all(res.get(c, {}).get('pass') is False for c in cut['red'])
            green_ok = all(res.get(c, {}).get('pass') is True for c in cut['green'])
            if herr or any(res.get(c, {}).get('pass') is None for c in cut['red'] + cut['green']):
                harness += 1
                status = 'HARNESS_ERROR'
            elif red_ok and green_ok:
                status = 'OK'
            else:
                failed += 1
                status = 'UNEXPECTED'
            report.append({'cut': cut['id'], 'status': status, 'red': {c: res.get(c, {}).get('pass') for c in cut['red']},
                           'green': {c: res.get(c, {}).get('pass') for c in cut['green']}, 'harness': herr})
            print(('✅' if status == 'OK' else '❌') + ' cut %s %s red=%s green=%s' % (
                cut['id'], status, report[-1]['red'], report[-1]['green']))
        if out_json:
            json.dump(report, open(out_json, 'w'), ensure_ascii=False, indent=1)
        print('WO019 cuts: %d ok / %d unexpected / %d harness_error' % (len(report) - failed - harness, failed, harness))
        return 2 if harness else (1 if failed else 0)
    root = os.path.abspath(argv[argv.index('--root') + 1]) if '--root' in argv else PRODUCT_ROOT
    if root != REPO and not os.path.exists(os.path.join(root, WO019_OVERLAY_MARKER)):
        print('HARNESS_ERROR: --root must be a disposable overlay (%s missing)' % WO019_OVERLAY_MARKER)
        return 2
    only = argv[argv.index('--cases') + 1].split(',') if '--cases' in argv else None
    results, records, harness = run_cases(root, only)
    passed = sum(1 for r in results.values() if r.get('pass') is True)
    failed = sum(1 for r in results.values() if r.get('pass') is False)
    herr = sum(1 for r in results.values() if r.get('pass') is None)
    for cid, r in results.items():
        mark = '✅' if r.get('pass') is True else ('❌' if r.get('pass') is False else 'HARNESS_ERROR')
        print('%s %s %s' % (mark, cid, '' if r.get('pass') else json.dumps(r.get('detail') or r.get('harness_error'),
                                                                         ensure_ascii=False, default=str)[:1500]))
    proxy = cost_proxy(records)
    print('COST_PROXY ' + json.dumps(proxy, ensure_ascii=False))
    if out_json:
        json.dump({'root': root, 'reader_identity_mode': 'ai_fallback' if os.environ.get('WO019_AI_RACE') == '1' else 'stable',
                   'results': results, 'harness': harness, 'cost_proxy': proxy},
                  open(out_json, 'w'), ensure_ascii=False, indent=1, default=str)
    print('WO019 Road Atlanta E2E (%s): %d passed / %d failed / %d harness_error' % (root, passed, failed, herr))
    return 2 if herr else (1 if failed else 0)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
