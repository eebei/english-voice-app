"""WO016: Bridge PTT take identity from the physical start edge through every terminal.

Exercises the REAL bridge.start_ptt_record()/stop_ptt_record()/_finish_ptt_capture()
with only the microphone (frames) and broadcast() captured. Each take gets one
capture_id that embeds the Bridge process epoch, and exactly one terminal carrying
that same capture_id (audio / diagnostic / error); a repeated terminal for the same
take is suppressed at the source.

Run: cd irsdk-bridge && python3 -m unittest tests_wo016_ptt_capture_identity
"""
import struct
import tempfile
import unittest
from unittest import mock

import bridge


def _pcm(seconds, amplitude):
    n = int(bridge.PTT_RATE * seconds)
    return [struct.pack('<%dh' % n, *([amplitude, -amplitude] * (n // 2) + [0] * (n % 2)))]


class _PttBridgeState(unittest.TestCase):
    """Saves/restores the real bridge PTT globals; broadcast()/log() captured."""

    def setUp(self):
        self.sent = []
        self.saved = (bridge.ptt_audio, bridge.ptt_recording, bridge.ptt_discard_recording,
                      bridge.ptt_capture_seq, bridge.ptt_current_capture_id, set(bridge._ptt_terminated_captures))
        bridge.ptt_audio = object()
        bridge.ptt_recording = False
        bridge.ptt_discard_recording = False
        self.p_broadcast = mock.patch.object(bridge, 'broadcast', lambda e: self.sent.append(dict(e)))
        self.p_log = mock.patch.object(bridge, 'log', lambda *_: None)
        self.p_broadcast.start(); self.p_log.start()
        self.tmp = tempfile.mkdtemp(prefix='wo016-ptt-')

    def tearDown(self):
        self.p_broadcast.stop(); self.p_log.stop()
        (bridge.ptt_audio, bridge.ptt_recording, bridge.ptt_discard_recording,
         bridge.ptt_capture_seq, bridge.ptt_current_capture_id, terminated) = self.saved
        bridge._ptt_terminated_captures.clear(); bridge._ptt_terminated_captures.update(terminated)


class PttCaptureIdentity(_PttBridgeState):
    def test_each_take_gets_a_unique_epoch_scoped_id(self):
        self.assertTrue(bridge.start_ptt_record())
        first = bridge.ptt_current_capture_id
        self.assertFalse(bridge.start_ptt_record(), 'duplicate start keeps the same take')
        self.assertEqual(first, bridge.ptt_current_capture_id)
        bridge.stop_ptt_record()
        bridge.start_ptt_record()
        second = bridge.ptt_current_capture_id
        self.assertNotEqual(first, second)
        epoch = bridge.canonical_mod.PROCESS_EPOCH
        self.assertTrue(first.startswith(epoch + ':ptt:') and second.startswith(epoch + ':ptt:'))

    def test_audio_terminal_carries_the_original_take_id_even_after_a_later_take_started(self):
        bridge.start_ptt_record(); cap1 = bridge.ptt_current_capture_id; bridge.stop_ptt_record()
        bridge.start_ptt_record(); cap2 = bridge.ptt_current_capture_id
        ev = bridge._finish_ptt_capture(cap1, _pcm(1.0, 9000), None, 2, wav_dir=self.tmp)
        self.assertEqual('ptt_audio', ev['type'])
        self.assertEqual(cap1, ev['capture_id'], 'terminal belongs to take 1, not the live take 2')
        self.assertNotEqual(cap2, ev['capture_id'])
        self.assertEqual(bridge.canonical_mod.PROCESS_EPOCH, ev['bridge_process_epoch'])

    def test_one_terminal_per_take_duplicate_suppressed_at_source(self):
        bridge.start_ptt_record(); cap = bridge.ptt_current_capture_id; bridge.stop_ptt_record()
        self.assertIsNotNone(bridge._finish_ptt_capture(cap, _pcm(1.0, 9000), None, 2, wav_dir=self.tmp))
        self.assertIsNone(bridge._finish_ptt_capture(cap, _pcm(1.0, 9000), None, 2, wav_dir=self.tmp))
        self.assertEqual(1, len([e for e in self.sent if e.get('capture_id') == cap]))

    def test_diagnostic_and_error_terminals_are_identified(self):
        cases = []
        for frames, expect in ((_pcm(0.1, 9000), 'too_short'), (_pcm(1.0, 50), 'no_signal'), ([], 'no_frames')):
            bridge.start_ptt_record(); cap = bridge.ptt_current_capture_id; bridge.stop_ptt_record()
            ev = bridge._finish_ptt_capture(cap, frames, None, 2, wav_dir=self.tmp)
            cases.append((ev['type'], ev['reason'], ev['capture_id'] == cap))
        self.assertEqual([('ptt_diagnostic', 'too_short', True), ('ptt_diagnostic', 'no_signal', True),
                          ('ptt_diagnostic', 'no_frames', True)], cases)
        bridge.start_ptt_record(); cap = bridge.ptt_current_capture_id; bridge.stop_ptt_record()
        ev = bridge._finish_ptt_capture(cap, _pcm(1.0, 9000), None, 2, wav_dir='/nonexistent-wo016-dir')
        self.assertEqual(('ptt_error', 'wav_error', cap), (ev['type'], ev['reason'], ev['capture_id']),
                         'wav failure used to be silent; now it closes the take explicitly')

    def test_aborted_take_still_returns_an_identified_terminal(self):
        bridge.start_ptt_record(); cap = bridge.ptt_current_capture_id
        bridge.abort_ptt_record()
        ev = bridge._finish_ptt_capture(cap, _pcm(1.0, 9000), None, 2, wav_dir=self.tmp)
        self.assertEqual(('ptt_diagnostic', 'aborted', cap), (ev['type'], ev['reason'], ev['capture_id']))


def _handler_receive(message):
    """Feed one websocket message into the REAL bridge.handler() (socket adapter only)."""
    import asyncio
    import json

    class Socket:
        async def send(self, data):
            pass

        def __aiter__(self):
            return self

        async def __anext__(self):
            if hasattr(self, 'done'):
                raise StopAsyncIteration
            self.done = True
            return json.dumps(message)
    with mock.patch.object(bridge, 'list_input_devices', lambda: []):
        asyncio.run(bridge.handler(Socket()))


class PttCommandHandlerIdentity(_PttBridgeState):
    """Parent counterexample (10/16): delayed renderer ptt_start/ptt_stop carrying an OLD
    capture_id must not start a phantom take or stop the newer take."""

    def test_delayed_start_for_old_take_does_not_start_a_phantom_take(self):
        bridge._ptt_physical_edge(True); cap1 = bridge.ptt_current_capture_id
        bridge._ptt_physical_edge(False)
        _handler_receive({'cmd': 'ptt_start', 'lang': 'ja-JP', 'capture_id': cap1})
        self.assertFalse(bridge.ptt_recording, 'old ptt_start started a new take after the physical up')
        self.assertEqual(cap1, bridge.ptt_current_capture_id)

    def test_matching_start_is_a_noop_confirmation(self):
        bridge._ptt_physical_edge(True); cap = bridge.ptt_current_capture_id
        _handler_receive({'cmd': 'ptt_start', 'lang': 'ja-JP', 'capture_id': cap})
        self.assertTrue(bridge.ptt_recording)
        self.assertEqual(cap, bridge.ptt_current_capture_id, 'confirmation must not mint a new take')

    def test_stale_stop_for_old_take_does_not_stop_the_new_take_control_stops(self):
        bridge._ptt_physical_edge(True); cap3 = bridge.ptt_current_capture_id
        bridge._ptt_physical_edge(False)
        bridge._ptt_physical_edge(True); cap4 = bridge.ptt_current_capture_id
        _handler_receive({'cmd': 'ptt_stop', 'capture_id': cap3})
        self.assertTrue(bridge.ptt_recording, 'stale ptt_stop for take 3 stopped take 4')
        self.assertEqual(cap4, bridge.ptt_current_capture_id)
        _handler_receive({'cmd': 'ptt_stop', 'capture_id': cap4})
        self.assertFalse(bridge.ptt_recording, 'control: ptt_stop for the current take stops it')


class PttNoActivitySignal(_PttBridgeState):
    """Same meaning as tests_driver_handoff P0-1 (PTT is never an activity/resume source),
    executed against the REAL edge helpers and websocket handler after the WO016 refactor."""

    def test_physical_edges_and_renderer_cmds_never_mark_resume_or_change_activity(self):
        import driver_activity as da
        saved = (bridge._manual_resume_pending, bridge._driver_activity)
        calls = []
        real_mark = bridge._mark_manual_resume_signal
        try:
            bridge._manual_resume_pending = False
            bridge._set_driver_activity(da.INACTIVE_DRIVER)
            with mock.patch.object(bridge, '_mark_manual_resume_signal', lambda *a, **k: (calls.append(1), real_mark())):
                bridge._ptt_physical_edge(True); cap = bridge.ptt_current_capture_id
                _handler_receive({'cmd': 'ptt_start', 'lang': 'ja-JP', 'capture_id': cap})
                _handler_receive({'cmd': 'ptt_stop', 'capture_id': cap})
                bridge._ptt_physical_edge(False)
                _handler_receive({'cmd': 'ptt_start', 'lang': 'ja-JP'})   # legacy renderer
                _handler_receive({'cmd': 'ptt_stop'})
            self.assertEqual([], calls)
            self.assertFalse(bridge._manual_resume_pending)
            self.assertEqual(da.INACTIVE_DRIVER, bridge._driver_activity)
            # control: the explicit resume command still sets the signal
            _handler_receive({'cmd': 'resume_driving_support'})
            self.assertTrue(bridge._manual_resume_pending)
        finally:
            bridge._manual_resume_pending, act = saved
            bridge._set_driver_activity(act)


class PttCommandHandlerIdentityCuts(_PttBridgeState):
    """Isolated cut: the handler's capture-id check replaced by the old unconditional
    start/stop. The same scenarios turn RED, proving the check is load-bearing."""

    def test_cut_start_check_phantom_take_red(self):
        bridge._ptt_physical_edge(True); cap1 = bridge.ptt_current_capture_id
        bridge._ptt_physical_edge(False)
        with mock.patch.object(bridge, '_ptt_renderer_start', lambda cid: bridge.start_ptt_record()):
            _handler_receive({'cmd': 'ptt_start', 'lang': 'ja-JP', 'capture_id': cap1})
        self.assertTrue(bridge.ptt_recording and bridge.ptt_current_capture_id != cap1, 'RED expected: phantom take')

    def test_cut_stop_check_stale_stop_kills_new_take_red(self):
        bridge._ptt_physical_edge(True); cap3 = bridge.ptt_current_capture_id
        bridge._ptt_physical_edge(False)
        bridge._ptt_physical_edge(True)
        with mock.patch.object(bridge, '_ptt_renderer_stop', lambda cid: bridge.stop_ptt_record()):
            _handler_receive({'cmd': 'ptt_stop', 'capture_id': cap3})
        self.assertFalse(bridge.ptt_recording, 'RED expected: stale stop kills the new take')


class PttWorkerTakeIdentity(_PttBridgeState):
    """Parent counterexample (10/16): the recording worker fixes its take before the mic
    open; an open failure or the first frame after a re-press never lands on the new take."""

    class _Audio:
        def __init__(self, on_open=None, on_read=None):
            self.on_open, self.on_read = on_open, on_read

        def get_sample_size(self, fmt):
            return 2

        def open(self, **kw):
            if self.on_open:
                self.on_open()
            outer = self

            class S:
                def read(self, n, exception_on_overflow=False):
                    if outer.on_read:
                        cb, outer.on_read = outer.on_read, None
                        cb()
                    return b'\x00\x00' * n

                def stop_stream(self):
                    pass

                def close(self):
                    pass
            return S()

    def _repress(self):
        bridge._ptt_physical_edge(False)
        bridge._ptt_physical_edge(True)
        self.cap2 = bridge.ptt_current_capture_id

    def test_open_failure_after_repress_is_attributed_to_the_old_take_and_new_take_keeps_recording(self):
        bridge._ptt_physical_edge(True); cap1 = bridge.ptt_current_capture_id

        def fail_after_repress():
            self._repress()
            raise OSError('old stream open failed after repress')
        bridge.ptt_audio = self._Audio(on_open=fail_after_repress)
        self.assertEqual('open_failed', bridge._ptt_record_one_stream(8, 1024))
        errors = [e for e in self.sent if e.get('type') == 'mic_error']
        self.assertEqual([cap1], [e.get('capture_id') for e in errors], errors)
        self.assertTrue(bridge.ptt_recording, 'the new take must keep recording')
        self.assertEqual(self.cap2, bridge.ptt_current_capture_id)

    def test_open_failure_without_repress_closes_its_own_take_control(self):
        bridge._ptt_physical_edge(True); cap1 = bridge.ptt_current_capture_id

        def fail():
            raise OSError('mic busy')
        bridge.ptt_audio = self._Audio(on_open=fail)
        bridge._ptt_record_one_stream(8, 1024)
        self.assertEqual([cap1], [e.get('capture_id') for e in self.sent if e.get('type') == 'mic_error'])
        self.assertFalse(bridge.ptt_recording)

    def test_repress_during_first_read_gives_the_old_take_its_own_terminal_not_the_new_takes_frames(self):
        bridge._ptt_physical_edge(True); cap1 = bridge.ptt_current_capture_id
        bridge.ptt_audio = self._Audio(on_read=self._repress)
        with mock.patch.object(bridge, '_base', self.tmp):
            bridge._ptt_record_one_stream(8, 1024)
        terminals = [e for e in self.sent if e.get('type') in ('ptt_audio', 'ptt_diagnostic', 'ptt_error')]
        self.assertEqual(1, len(terminals), terminals)
        self.assertEqual(cap1, terminals[0]['capture_id'], 'first frame after re-press was given to the old take id')
        self.assertTrue(bridge.ptt_recording)
        self.assertEqual(self.cap2, bridge.ptt_current_capture_id)


if __name__ == '__main__':
    unittest.main()
