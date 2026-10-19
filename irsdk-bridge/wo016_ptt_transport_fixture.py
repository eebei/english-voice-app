"""WO016 PTT transport fixture: emits the REAL Bridge PTT event stream for a scripted take
sequence, for the Desktop vertical test (tests-wo016-driver-input-ownership.js).

Real functions only: bridge._ptt_physical_edge() (the exact code the poll loop runs on the
physical button edge) and bridge._finish_ptt_capture() (the exact per-take terminal emission
of the recording thread). Only the microphone frames and broadcast() are substituted: frames
are synthetic PCM, and broadcast() appends the event to the output list (instead of a socket).

Script (argv[1] JSON): list of steps
  {"op":"down"} | {"op":"up"}
  {"op":"finish","take":<1-based take index>,"seconds":s,"amplitude":a}
  {"op":"redeliver","take":n}        -> re-send that take's already-emitted terminal verbatim
                                        (models a transport-level duplicate delivery)
  {"op":"marker","name":"..."}       -> passthrough marker for Desktop-side actions
Output (stdout JSON): {"epoch":..., "events":[...]} (mic_level omitted).
"""
import json
import os
import struct
import sys
import tempfile
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bridge  # noqa: E402


def pcm(seconds, amplitude):
    n = int(bridge.PTT_RATE * float(seconds))
    return [struct.pack('<%dh' % n, *([int(amplitude), -int(amplitude)] * (n // 2) + [0] * (n % 2)))]


def main():
    steps = json.loads(open(sys.argv[1]).read()) if os.path.exists(sys.argv[1]) else json.loads(sys.argv[1])
    events, takes, terminals = [], [], {}
    wav_dir = tempfile.mkdtemp(prefix='wo016-ptt-wav-')
    bridge.ptt_audio = object()
    bridge.ptt_recording = False
    bridge.ptt_discard_recording = False
    with mock.patch.object(bridge, 'broadcast', lambda e: events.append(dict(e))), \
            mock.patch.object(bridge, 'log', lambda *_: None):
        for step in steps:
            op = step['op']
            if op == 'down':
                ev = bridge._ptt_physical_edge(True)
                takes.append(ev['capture_id'])
            elif op == 'up':
                bridge._ptt_physical_edge(False)
            elif op == 'finish':
                cap = takes[step['take'] - 1]
                ev = bridge._finish_ptt_capture(cap, pcm(step.get('seconds', 1.0), step.get('amplitude', 9000)),
                                                None, 2, wav_dir=wav_dir)
                if ev is not None:
                    terminals[step['take']] = dict(ev)
            elif op == 'redeliver':
                events.append(dict(terminals[step['take']]))
            elif op == 'marker':
                events.append({'type': '__marker', 'name': step['name']})
            else:
                raise SystemExit('unknown op ' + op)
    print(json.dumps({'epoch': bridge.canonical_mod.PROCESS_EPOCH,
                      'events': [e for e in events if e.get('type') != 'mic_level']}))


if __name__ == '__main__':
    main()
