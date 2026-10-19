"""WO015 actual Bridge owner metadata (utterance_id/text_hash) +
origin_record_ref completion unit -- the SAME persistent Node VM slice, for
both BOX and the strategy PROPOSAL delivery path.

Counterexamples this closes:
  - `tests-wo015-owner-roundtrip.js` hand-builds the Bridge ACK -- a Desktop
    transport/ACK-consumer unit test, NOT the actual Bridge owner vertical.
    `box_authority_delivery.py.apply_report()` previously dropped
    utterance_id/text_hash entirely (never echoed on the ack, never
    persisted, never validated against the readback); `durable_recovery.py`'s
    report-receipt binding rejected metadata-bearing reports outright
    (exact-key check); `desktop/box-authority-transport.js`'s `ack()`/
    `historicalAck()` never checked them either -- a scalar time/outcome
    match was accepted as identity proof.
  - `bridge.py`'s `_publish_or_stage()` attached the globally ACTIVE plan's
    `origin_record_ref` to every ack-type event (box_delivery_ack/
    strategy_decision_ack/strategy_delivery_ack/driver_plan_command_ack),
    instead of the record the ack is actually about -- confirmed by the
    independent probe's `origin_record_ref` pointing at an unrelated
    initial Plan A while the ack concerned a Plan B proposal.
  - `desktop/renderer.html`'s `handleStrategyDeliveryAck()` retired the
    strategyDeliveryOutbox entry on outcome/applied scalar match ALONE, even
    when the ack's utterance_id genuinely mismatched the locally-sent one --
    a misrouted/stale ack could consume the only retry opportunity for a
    still-unconfirmed delivery (independent quota-stop source review,
    "outbox removed even metadata mismatch").
  - A first attempt at this file (now superseded) used a two-process
    restart/checkpoint chain and hand-built unit calls for
    normal/interrupted/suppressed instead of a persistent same-VM fixture,
    and was correctly rejected by the independent reviewer as "valid
    restart/metadata evidence, NOT SAME VM" (restart continuity itself
    already has its own extensive proof in tests_wo010_durable_recovery.py
    and is not duplicated here).

This file drives the REAL vertical end to end through ONE persistent Node
process per test (the same `wo013_judge_bridge_fixture.js` process
`tests_wo013_judge_bridge_roundtrip.py`'s 14 existing tests already share,
now extended -- not a parallel fixture): real BOX call candidate / real
strategy proposal (`tests_wo008_fixed_target`'s real single-process replay,
`tests_bridge_plan_lifecycle_wiring`'s real Plan-B replay) -> real Desktop
`handleStrategyPlanBoxCall()`/`handleStrategyPlanProposal()` -> real
`boxAuthorityTransport`/`strategyDeliveryOutbox` -> real `speak()`/
`drainQueue()`/`stopCurrentAudio()` (only the TTS fetch and `Audio` are
stubbed) -> real wire -> fed into the SAME live `bridge.poll_iracing()` ->
real `box_authority_delivery.apply_report()`/`durable_recovery` -> real ack
broadcast -> fed back into the SAME persistent Node process's real
`boxAuthorityTransport.ack()`/`handleStrategyDeliveryAck()` readback.
"""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import box_authority_delivery as bd
import durable_recovery as dr
import tests_wo001_road_atlanta_fixture as road
import tests_wo010_durable_recovery as wo010
import tests_wo013_judge_bridge_roundtrip as h
import bridge
import replay_harness as rh


def _run_real_box_vertical(fx, *, interrupt=False, suppressed=False):
    """ONE continuous real `bridge.poll_iracing()` replay (the SAME scenario
    `tests_wo008_fixed_target.ActualPoll` already drives: a real driver amend
    command built by the real intent router, then a real
    `strategy_plan_box_call` candidate) that, inside the SAME `on_frame_ready`
    hook, also drives the given persistent NodeFixture's real `init`/
    `box_receive_snapshot`/`box_call` (real `accept()`/`attachUtterance()`/
    `speak()`), queues the resulting real report(s) into the SAME live
    `bridge._pending_box_delivery_reports`, and lets the SAME replay's
    remaining frames continue polling so `apply_report()` runs and the real
    `box_delivery_ack`(s) land in `result.broadcasts` -- a second, separate
    `rh.replay()` call would start a brand new Bridge process-local ledger
    and never find the attempt (confirmed by running it that way first)."""
    bridge._pending_driver_plan_commands = []
    bridge._pending_box_delivery_reports = []
    frames = road.clean_laps(12)[0]
    state = {}

    def hook(cursor, frame, r):
        live = [b for b in r.broadcasts if b.get('type') == 'telemetry_live' and b.get('active_plan_decision_id')]
        if live and not state.get('command'):
            t = live[-1]
            with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as wire:
                json.dump(t, wire)
                wire.flush()
                command = json.loads(subprocess.check_output(
                    ['node', str(Path(__file__).parent / 'wo008_desktop_command_fixture.js'), wire.name]))
            state['command'] = True
            bridge._queue_driver_plan_command(command)
        boxes = r.by_trigger('strategy_plan_box_call')
        if boxes and not state.get('candidate'):
            b = boxes[-1]
            idx = r.broadcasts.index(b)
            snapshot = r.broadcasts[idx - 1]
            canonical = next(x for x in r.broadcasts if x.get('snapshot_id') == b['canonical_snapshot_id'])
            init = fx.send('init', canonicalSnapshot=canonical,
                            lastTelemetry={'strategy_options': canonical.get('recommendations', {}).get('strategy_options')})
            assert init['ok'], init
            rs = fx.send('box_receive_snapshot', snapshot=snapshot)
            assert rs['ok'], rs
            if suppressed:
                fx.send('set_voice_on', value=False)
            bc = fx.send('box_call', candidate=b, interrupt=interrupt)
            state['candidate'] = b
            state['reports'] = bc['reports']
            for wire_msg in bc['reports']:
                bridge._queue_box_delivery_report(wire_msg)

    result = rh.replay(frames, session_info=road.ROAD_ATLANTA_SESSION_INFO, on_frame_ready=hook)
    assert state.get('candidate'), 'real single-process replay never reached a real BOX call candidate'
    acks = [a for a in result.broadcasts if a.get('type') == 'box_delivery_ack']
    return state['candidate'], state['reports'], acks, result


class SameVmBoxOwnerVertical(unittest.TestCase):
    """Real BOX candidate -> real Desktop accept()/attachUtterance()/speak()
    -> real report wire -> real Bridge apply_report() -> real ack -> back
    into the SAME persistent Node process's real ack() readback."""

    def test_normal_started_then_completed_metadata_and_origin_round_trip(self):
        fx = h.NodeFixture()
        try:
            candidate, reports, acks, _result = _run_real_box_vertical(fx)
            self.assertTrue(any(r['outcome'] == 'audible_started' for r in reports))
            self.assertTrue(any(r['outcome'] == 'audible_completed' for r in reports))
            for r in reports:
                self.assertTrue(r['utterance_id'])
                self.assertTrue(r['text_hash'])

            self.assertTrue(acks)
            completed_ack = next(a for a in acks if a['outcome'] == 'audible_completed')
            self.assertEqual(completed_ack['applied'], 'applied')
            completed_report = next(r for r in reports if r['outcome'] == 'audible_completed')
            self.assertEqual(completed_ack['utterance_id'], completed_report['utterance_id'])
            self.assertEqual(completed_ack['text_hash'], completed_report['text_hash'])
            # bridge.py _publish_or_stage() origin_record_ref bug: must
            # reference the ack's OWN decision, never an unrelated active Plan.
            self.assertEqual(completed_ack['origin_record_ref']['decision_id'], completed_ack['decision_id'])

            # Same persistent VM readback: apply both real acks, outbox fully retires.
            completed_probe = None
            for ack in acks:
                probe = fx.send('box_ack_probe', ack=ack)
                self.assertTrue(probe['applied'])
                if ack['outcome'] == 'audible_completed':
                    completed_probe = probe
            final = fx.send('box_ack_probe', ack=acks[-1])
            self.assertEqual(final['outboxSizeAfter'], 0)

            # Independent review ("BOX owner receipt frozen body/source/
            # role/firstconfirmedtime retention/getter after real ACK SAME
            # VM, not trace getter alone"): the real
            # boxAuthorityTransport.receiptFor() getter must return the
            # exact body/kind/role this real ACK actually confirmed --
            # retrieved through the SAME real ack() consumer, not derived
            # from the bounded trace a second time.
            receipt = completed_probe['receipt']
            self.assertIsNotNone(receipt, completed_probe)
            self.assertEqual(receipt['utterance_id'], completed_report['utterance_id'])
            self.assertEqual(receipt['text_hash'], completed_report['text_hash'])
            self.assertEqual(receipt['outcome'], 'audible_completed')
            self.assertEqual(receipt['kind'], 'strategy_plan_box_call')
            self.assertEqual(receipt['role'], 'box_authority_call')
            self.assertIsNotNone(receipt['scope'], receipt)
            self.assertTrue(receipt['text'])
            self.assertIsInstance(receipt['firstConfirmedAt'], (int, float))

            # Independent root audit ("BOX SOURCE PACKET missing"): the
            # retained receipt must carry the EXACT original proof/attempt/
            # refs identity this real candidate used -- not just a
            # primitive scope -- and that identity must match the real
            # candidate's own authority_proof/box_attempt (never rebuilt
            # from live canonical at ACK time).
            self.assertEqual(receipt['source']['proof']['proof_id'], candidate['authority_proof']['proof_id'])
            self.assertEqual(receipt['source']['proof']['decision_id'], candidate['authority_proof']['decision_id'])
            self.assertEqual(receipt['source']['attempt']['attempt_id'], candidate['box_attempt']['attempt_id'])
            self.assertEqual(receipt['source']['refs']['bridge_process_epoch'], completed_ack['bridge_process_epoch'])

            # `final` above re-sent the SAME completed ack a second time
            # (acks[-1] is the completed ack already applied in the loop) --
            # a genuine duplicate. The retained receipt's firstConfirmedAt
            # must not have been overwritten by this second delivery.
            self.assertEqual(final['receipt']['firstConfirmedAt'], receipt['firstConfirmedAt'],
                              'duplicate exact ACK must preserve the first-confirmed timestamp')

            # Full lifecycle trace (independent review "speechLatencyTrace
            # stillstub ... all-state actualtrace not proven here"): the
            # REAL speechLatencyTrace()/utteranceTrace() (not a no-op stub)
            # must show the actual normal-completion state sequence under
            # the SAME stable utterance_id/textHash, not just the final
            # outcome asserted above.
            trace = fx.send('trace_probe', utteranceId=completed_report['utterance_id'])['trace']
            states = [e['state'] for e in trace]
            self.assertEqual(states, ['generated', 'queued', 'tts_start', 'spoken', 'play_started', 'completed'], trace)
            self.assertTrue(all(e['textHash'] == completed_report['text_hash'] for e in trace))
            # structured schema_version:2 sources (BOX proof/attempt/scope)
            # survive the full trace, not just the initial attachUtterance.
            self.assertTrue(all(e['source']['sources'][0]['ref']['attempt_id'] for e in trace))
            # Independent review ("ACTUAL OWNER RECEIPT BODY ... BOX
            # criticaljournal/transport must correlate final body original
            # source sameID even if body retainedRendereronly and
            # wireminimalUIDhash"): BOX never sends the actual body text over
            # the wire (box_delivery_report only carries utterance_id/
            # text_hash) -- the body only ever lives in this SAME Renderer
            # VM's bounded utteranceTrace. Prove that reverse retrieval works
            # through the REAL speak()/attachUtterance() path (not a
            # hand-built trace entry): every entry under this utterance_id
            # carries the real delivery role/kind (deriveUtteranceSource's
            # auxAtRequest.role / item.kind, not a fabricated value), and
            # since this BOX call has no gapIdentity (no authority-rebuild
            # trigger), the original candidate body ('generated') and the
            # actually-emitted final body (the terminal entry) must be the
            # SAME text -- not silently diverging.
            self.assertTrue(all(e['role'] == 'box_authority_call' for e in trace), trace)
            self.assertTrue(all(e['kind'] == 'strategy_plan_box_call' for e in trace), trace)
            self.assertTrue(all(e['text'] for e in trace), trace)
            self.assertEqual(trace[0]['text'], trace[-1]['text'],
                              'no GAP rebuild trigger here -- original candidate body and final emitted '
                              'body must be identical, not merely hash-equal')
        finally:
            fx.close()

    def test_interrupted_representative(self):
        fx = h.NodeFixture()
        try:
            candidate, reports, acks, _result = _run_real_box_vertical(fx, interrupt=True)
            self.assertTrue(any(r['outcome'] == 'audible_started' for r in reports))
            interrupted = next(r for r in reports if r['outcome'] == 'audible_interrupted')
            started = next(r for r in reports if r['outcome'] == 'audible_started')
            self.assertEqual(interrupted['utterance_id'], started['utterance_id'])
            self.assertFalse(any(r['outcome'] == 'audible_completed' for r in reports))

            interrupted_ack = next(a for a in acks if a['outcome'] == 'audible_interrupted')
            self.assertEqual(interrupted_ack['applied'], 'applied')
            self.assertEqual(interrupted_ack['utterance_id'], interrupted['utterance_id'])

            # SAME persistent VM ack() readback for BOTH real acks (started +
            # interrupted), with the real on-disk journal retiring each
            # box_delivery_report in turn -- not just asserted at the wire.
            for ack in acks:
                probe = fx.send('box_ack_probe', ack=ack)
                self.assertTrue(probe['applied'], ack)
                self.assertFalse(any(e['payload']['report_event_id'] == ack['report_event_id']
                                      for e in probe['journalPendingReports']),
                                  'real journal must retire this exact report_event_id, not just the in-memory outbox')
            final = fx.send('box_ack_probe', ack=acks[-1])
            self.assertEqual(final['outboxSizeAfter'], 0)
            self.assertFalse(final['journalPendingReports'])

            trace = fx.send('trace_probe', utteranceId=interrupted['utterance_id'])['trace']
            self.assertEqual([e['state'] for e in trace],
                              ['generated', 'queued', 'tts_start', 'spoken', 'play_started', 'audible_interrupted'], trace)
        finally:
            fx.close()

    def test_suppressed_representative(self):
        fx = h.NodeFixture()
        try:
            candidate, reports, acks, _result = _run_real_box_vertical(fx, suppressed=True)
            self.assertEqual(len(reports), 1)
            self.assertEqual(reports[0]['outcome'], 'suppressed_by_user')
            # attachUtterance() runs before speak()'s !voiceOn check, so a
            # suppressed report still carries the real identifiers.
            self.assertTrue(reports[0]['utterance_id'])
            self.assertTrue(reports[0]['text_hash'])

            self.assertTrue(acks)
            self.assertEqual(acks[0]['applied'], 'applied')
            self.assertEqual(acks[0]['utterance_id'], reports[0]['utterance_id'])

            # SAME persistent VM ack() readback + real journal retirement.
            probe = fx.send('box_ack_probe', ack=acks[0])
            self.assertTrue(probe['applied'])
            self.assertEqual(probe['outboxSizeAfter'], 0)
            self.assertFalse(probe['journalPendingReports'])

            # suppressed_by_user is synchronous (fires before any TTS fetch/
            # queue), so only ONE real trace entry -- no invented
            # queued/tts_start states for a delivery that never reached them.
            trace = fx.send('trace_probe', utteranceId=reports[0]['utterance_id'])['trace']
            self.assertEqual([e['state'] for e in trace], ['generated', 'suppressed'], trace)
        finally:
            fx.close()

    def test_owner_consumer_ack_readback_rejects_mismatched_metadata_red_then_accepts_control(self):
        fx = h.NodeFixture()
        try:
            candidate, reports, acks, _result = _run_real_box_vertical(fx)
            ack = next(a for a in acks if a['outcome'] == 'audible_started')
            self.assertEqual(ack['applied'], 'applied')

            red = fx.send('box_ack_probe', ack=dict(ack, utterance_id='tampered-by-red-case'))
            self.assertFalse(red['applied'],
                              'owner consumer ack() must REJECT a Bridge ack whose utterance_id does not '
                              'match the originally reported one, not accept it on a scalar/time match alone')
            self.assertEqual(red['outboxSizeAfter'], red['outboxSizeBefore'])

            control = fx.send('box_ack_probe', ack=ack)
            self.assertTrue(control['applied'])
            self.assertEqual(control['outboxSizeAfter'], control['outboxSizeBefore'] - 1)
        finally:
            fx.close()


class SameVmProposalOwnerVertical(unittest.TestCase):
    """Real strategy proposal delivery -> real Desktop
    `handleStrategyPlanProposal()`/speak() -> real
    `strategy_decision_delivery` wire -> real Bridge
    `handle_strategy_decision_delivery()` -> real `strategy_delivery_ack` ->
    back into the SAME persistent Node process's real
    `handleStrategyDeliveryAck()` readback."""

    def _propose(self, fx, **kw):
        captured = {}

        def ready(state, result):
            if captured:
                return
            fx.send('init', canonicalSnapshot=state['snapshot'],
                    lastTelemetry={'strategy_options': state['proposal']['strategy_options']})
            q = fx.send('propose', proposal=state['proposal'], **kw)
            captured.update(proposal=state['proposal'], desktop=q, result=result, snapshot=state['snapshot'])
            for wire in [w for w in q['wsSent'] if w.get('cmd') == 'strategy_decision_delivery']:
                h.receive(wire)

        result, state = h.run_real_proposal_replay(ready)
        return captured

    def test_normal_completed_metadata_and_origin_round_trip(self):
        fx = h.NodeFixture()
        try:
            c = self._propose(fx)
            wires = [w for w in c['desktop']['wsSent'] if w.get('cmd') == 'strategy_decision_delivery']
            completed_wire = next(w for w in wires if w['outcome'] == 'audible_completed')
            self.assertTrue(completed_wire['utterance_id'])
            self.assertTrue(completed_wire['text_hash'])

            acks = [a for a in c['result'].broadcasts if a.get('type') == 'strategy_delivery_ack'
                    and a.get('dispatch_id') == c['proposal']['dispatch_id']]
            completed_ack = next(a for a in acks if a['outcome'] == 'audible_completed')
            self.assertEqual(completed_ack['applied'], 'audible_completed')
            self.assertEqual(completed_ack['utterance_id'], completed_wire['utterance_id'])
            self.assertEqual(completed_ack['text_hash'], completed_wire['text_hash'])
            self.assertEqual(completed_ack['origin_record_ref']['decision_id'], completed_ack['decision_id'])

            readback = fx.send('delivery_ack_probe', ack=completed_ack)
            self.assertIsNone(readback['pre'])
            self.assertIsNotNone(readback['post'])

            # Full lifecycle trace via the REAL speechLatencyTrace()/
            # utteranceTrace() (not a no-op stub) under the SAME stable id.
            trace = fx.send('trace_probe', utteranceId=completed_wire['utterance_id'])['trace']
            self.assertEqual([e['state'] for e in trace], ['generated', 'queued', 'tts_start', 'spoken', 'play_started', 'completed'], trace)
            self.assertTrue(all(e['textHash'] == completed_wire['text_hash'] for e in trace))

            # Independent review ("ACTUAL OWNER RECEIPT BODY ... add
            # bodyreceipt getter case BOTH normalrepresentatives"): the
            # explicit strategyDeliveryReceiptFor() getter (not a
            # hand-constructed trace/ACK) must return the SAME exact final
            # body/hash/role/scope/kind/first-confirmed-time this real
            # delivery actually produced, retrieved through the REAL
            # handleStrategyDeliveryAck() consumer in the SAME persistent
            # VM -- not a second, independently re-derived value.
            receipt = readback['receipt']
            self.assertIsNotNone(receipt)
            self.assertEqual(receipt['schema_version'], 2)
            self.assertEqual(receipt['utteranceId'], completed_wire['utterance_id'])
            self.assertEqual(receipt['textHash'], completed_wire['text_hash'])
            self.assertEqual(receipt['finalText'], trace[-1]['text'], receipt)
            self.assertEqual(receipt['finalTextHash'], completed_wire['text_hash'])
            self.assertEqual(receipt['originalText'], trace[0]['text'], receipt)
            self.assertEqual(receipt['originalTextHash'], trace[0]['textHash'])
            self.assertEqual(receipt['role'], 'canonical')
            self.assertIsNotNone(receipt['scope'], receipt)
            self.assertTrue(receipt['kind'])
            self.assertIsInstance(receipt['firstConfirmedAt'], (int, float))

            # Independent review ("Proposal exact source equality with
            # capturedoriginal components/epoch/publication identity ...
            # not just body/scope"): the receipt's NESTED source object
            # must carry the SAME decision_id/epoch/publication identity
            # this proposal was actually captured against at generation
            # time -- not merely a non-null placeholder.
            src = receipt['source']
            self.assertEqual(src['decision_id'], c['proposal']['decision_id'])
            self.assertEqual(src['epoch'], c['snapshot']['bridge_process_epoch'])
            self.assertEqual(src['publication_ref']['canonical_snapshot_id'], c['snapshot']['snapshot_id'])
            self.assertEqual(src['publication_ref']['canonical_snapshot_sequence'], c['snapshot']['snapshot_sequence'])
            self.assertEqual(src['publication_ref']['bridge_process_epoch'], c['snapshot']['bridge_process_epoch'])

            # A genuinely duplicate/retried exact ACK (same session/dispatch/
            # outcome/applied/utterance_id/text_hash) must be idempotent: the
            # SAME persistent VM's receipt keeps its ORIGINAL firstConfirmedAt,
            # not a fresh Date.now() from this second delivery of the same ack.
            readback2 = fx.send('delivery_ack_probe', ack=completed_ack)
            receipt2 = readback2['receipt']
            self.assertEqual(receipt2['firstConfirmedAt'], receipt['firstConfirmedAt'],
                              'duplicate exact ACK must preserve the first-confirmed timestamp, not overwrite it')
            self.assertEqual(receipt2['finalText'], receipt['finalText'])
        finally:
            fx.close()

    def test_interrupted_representative(self):
        fx = h.NodeFixture()
        try:
            c = self._propose(fx, interrupt=True)
            wires = [w for w in c['desktop']['wsSent'] if w.get('cmd') == 'strategy_decision_delivery']
            self.assertTrue(any(w['outcome'] == 'audible_interrupted' for w in wires))
            self.assertFalse(any(w['outcome'] == 'audible_completed' for w in wires))
            interrupted = next(w for w in wires if w['outcome'] == 'audible_interrupted')
            self.assertTrue(interrupted['utterance_id'])

            acks = [a for a in c['result'].broadcasts if a.get('type') == 'strategy_delivery_ack'
                    and a.get('dispatch_id') == c['proposal']['dispatch_id']]
            interrupted_ack = next(a for a in acks if a['outcome'] == 'audible_interrupted')
            # apply_proposal_delivery() releases the proposal slot (re-propose
            # allowed) rather than confirming it as a distinct terminal
            # outcome -- 'released' is the real production mapping here.
            self.assertEqual(interrupted_ack['applied'], 'released')
            self.assertEqual(interrupted_ack['utterance_id'], interrupted['utterance_id'])

            # SAME persistent VM readback: real outbox entry for THIS outcome
            # actually retires once the real matching ack is applied.
            key_outcomes = {a['outcome'] for a in acks}
            for ack in acks:
                readback = fx.send('delivery_ack_probe', ack=ack)
                self.assertFalse(any(o['outcome'] == ack['outcome'] for o in readback['outbox']),
                                  'matching ack must retire its own outcome-keyed outbox entry')
            self.assertIn('audible_interrupted', key_outcomes)

            trace = fx.send('trace_probe', utteranceId=interrupted['utterance_id'])['trace']
            self.assertEqual([e['state'] for e in trace],
                              ['generated', 'queued', 'tts_start', 'spoken', 'play_started', 'audible_interrupted'], trace)
        finally:
            fx.close()

    def test_suppressed_representative(self):
        fx = h.NodeFixture()
        try:
            c = self._propose(fx, voiceOff=True)
            wires = [w for w in c['desktop']['wsSent'] if w.get('cmd') == 'strategy_decision_delivery']
            self.assertEqual(len(wires), 1)
            self.assertEqual(wires[0]['outcome'], 'suppressed_by_user')
            self.assertTrue(wires[0]['utterance_id'])
            self.assertTrue(wires[0]['text_hash'])

            acks = [a for a in c['result'].broadcasts if a.get('type') == 'strategy_delivery_ack'
                    and a.get('dispatch_id') == c['proposal']['dispatch_id']]
            suppressed_ack = next(a for a in acks if a['outcome'] == 'suppressed_by_user')
            self.assertEqual(suppressed_ack['utterance_id'], wires[0]['utterance_id'])

            readback = fx.send('delivery_ack_probe', ack=suppressed_ack)
            self.assertFalse(any(o['outcome'] == 'suppressed_by_user' for o in readback['outbox']))

            trace = fx.send('trace_probe', utteranceId=wires[0]['utterance_id'])['trace']
            self.assertEqual([e['state'] for e in trace], ['generated', 'suppressed'], trace)
        finally:
            fx.close()

    def test_input_tampered_ack_rejected_not_consumer_cut_proof(self):
        """Input-level negative: a mismatched-utterance ack value is
        rejected by the REAL (unmutated) handleStrategyDeliveryAck(). This is
        necessary but NOT sufficient evidence that the guard itself is
        load-bearing -- see test_isolated_consumer_cut_mutation_... below for
        the actual code-path mutation proof the independent review required."""
        fx = h.NodeFixture()
        try:
            c = self._propose(fx)
            acks = [a for a in c['result'].broadcasts if a.get('type') == 'strategy_delivery_ack'
                    and a.get('dispatch_id') == c['proposal']['dispatch_id']]
            ack = next(a for a in acks if a['outcome'] == 'audible_completed')

            red = fx.send('delivery_ack_probe', ack=dict(ack, utterance_id='tampered-by-red-case'))
            self.assertIsNone(red['post'],
                               'handleStrategyDeliveryAck() must not promote a mismatched-utterance ack '
                               'to owner-confirmed completion')
            self.assertTrue(any(o['outcome'] == 'audible_completed' for o in red['outbox']),
                             'a mismatched ack must not retire the real outbox entry either '
                             '(fail-closed, keeps the retry opportunity)')

            control = fx.send('delivery_ack_probe', ack=ack)
            self.assertIsNotNone(control['post'])
            self.assertFalse(any(o['outcome'] == 'audible_completed' for o in control['outbox']))
        finally:
            fx.close()

    def test_isolated_consumer_cut_mutation_red_then_restored_green_with_upstream_intact_control(self):
        """The actual isolated consumer-cut proof the independent review
        required: mutate ONLY the real extracted handleStrategyDeliveryAck()
        source (one line, the _sameUtterance guard added for this unit) back
        to the pre-fix unconditional-true behavior, prove the SAME
        mismatched ack that test_input_tampered_ack_rejected_not_consumer_
        cut_proof correctly rejects now WRONGLY promotes under the mutation
        (RED), that a genuinely-matching ack is unaffected by the mutation
        (upstream intact control -- the cut is isolated to the mismatch
        branch, not a blanket outage), then restores the real function and
        reconfirms the mismatched ack is rejected again (GREEN). Each phase
        uses its OWN persistent NodeFixture process: the real fixture scenario
        is deterministic (same seed/decision_id every `_propose()` call), so
        `bridgeStrategyDecisions`'s owner-ack timestamp for that decision_id
        would otherwise leak forward across phases within one shared VM --
        this keeps each phase's same-VM speak->ack->readback loop isolated
        from the OTHER phases, not from itself."""
        def phase(mutate):
            fx = h.NodeFixture()
            try:
                c = self._propose(fx)
                acks = [a for a in c['result'].broadcasts if a.get('type') == 'strategy_delivery_ack'
                        and a.get('dispatch_id') == c['proposal']['dispatch_id']]
                ack = next(a for a in acks if a['outcome'] == 'audible_completed')
                if mutate:
                    cut = fx.send('mutate_cut_delivery_ack_metadata_check')
                    self.assertTrue(cut['ok'], cut)
                return fx.send('delivery_ack_probe', ack=dict(ack, utterance_id='tampered-by-mutation-case'))
            finally:
                fx.close()

        red = phase(mutate=True)
        self.assertIsNotNone(red['post'],
                              'with the real guard cut, a mismatched ack WRONGLY promotes to '
                              'owner-confirmed completion -- proves the guard is load-bearing')
        self.assertFalse(any(o['outcome'] == 'audible_completed' for o in red['outbox']),
                          'with the guard cut, the mismatched ack also wrongly retires the outbox entry')

        green = phase(mutate=False)
        self.assertIsNone(green['post'], 'the real (unmutated) function must reject the mismatched ack')
        self.assertTrue(any(o['outcome'] == 'audible_completed' for o in green['outbox']))

        # Upstream intact control: under the SAME mutation, a genuinely
        # matching ack (fresh phase/decision, fresh VM) still promotes --
        # proves the cut is isolated to the mismatch branch, not a blanket
        # outage of handleStrategyDeliveryAck() entirely.
        fx = h.NodeFixture()
        try:
            c = self._propose(fx)
            acks = [a for a in c['result'].broadcasts if a.get('type') == 'strategy_delivery_ack'
                    and a.get('dispatch_id') == c['proposal']['dispatch_id']]
            ack = next(a for a in acks if a['outcome'] == 'audible_completed')
            cut = fx.send('mutate_cut_delivery_ack_metadata_check')
            self.assertTrue(cut['ok'], cut)
            control = fx.send('delivery_ack_probe', ack=ack)
            self.assertIsNotNone(control['post'], 'a genuinely matching ack must still promote under the mutation')
            self.assertFalse(any(o['outcome'] == 'audible_completed' for o in control['outbox']))
        finally:
            fx.close()


def _synthetic_ledger_with_attempt(**overrides):
    attempt = dict(attempt_id='a1', proof_id='p1', race_instance_id='r', session_num=0,
                    decision_id='d1', plan_revision=0, activation_frame=1, driver_pit_sequence=0,
                    dispatch_sequence=1, status='dispatched',
                    history=[{'status': 'dispatched', 'session_time_s': 0.0}],
                    confirmed_started=False, confirmed_completed=False, confirmed_interrupted=False,
                    issued_session_time=0.0, material_key=(0, 0), authority_proof={},
                    canonical_dispatch_ref=None)
    attempt.update(overrides)
    return bd._put(bd.new_ledger(), attempt)


def _report(**overrides):
    report = dict(attempt_id='a1', proof_id='p1', race_instance_id='r', session_num=0,
                   decision_id='d1', plan_revision=0, activation_frame=1, driver_pit_sequence=0,
                   dispatch_sequence=1, outcome='audible_started',
                   report_event_id='a1:audible_started', utterance_id='utt-1', text_hash='hash-1')
    report.update(overrides)
    return report


class BoxAuthorityDeliveryMetadataSupplementary(unittest.TestCase):
    """Supplementary unit-level coverage of `apply_report()`'s dedup/collision
    policy directly against the real production function -- NOT a substitute
    for `SameVmBoxOwnerVertical` above, which is the actual speak()/handler/
    poll proof. Covers duplicate/reorder and malformed-metadata-type, which
    are awkward to provoke deterministically through a live TTS/Audio race."""

    def test_duplicate_retry_is_idempotent_then_mismatched_resend_is_explicit_collision(self):
        ledger = _synthetic_ledger_with_attempt()
        report = _report()
        ledger, ack1 = bd.apply_report(ledger, report)
        self.assertEqual(ack1['applied'], 'applied')
        self.assertEqual((ack1['utterance_id'], ack1['text_hash']), ('utt-1', 'hash-1'))

        ledger, ack2 = bd.apply_report(ledger, report)
        self.assertEqual(ack2['applied'], 'retry_no_op')
        self.assertEqual((ack2['utterance_id'], ack2['text_hash']), ('utt-1', 'hash-1'))

        ledger, ack3 = bd.apply_report(ledger, _report(text_hash='different-hash'))
        self.assertEqual(ack3['applied'], 'collision')

    def test_malformed_metadata_type_is_rejected_not_silently_coerced(self):
        ledger = _synthetic_ledger_with_attempt()
        ledger, ack = bd.apply_report(ledger, _report(utterance_id=123))
        self.assertEqual(ack['applied'], 'rejected')
        self.assertNotIn('a1:audible_started', ledger.reports)


class LegacyCheckpointMetadataMigration(unittest.TestCase):
    """Legacy VERSION1 bytes written before utterance_id/text_hash existed
    must be accepted as explicitly-legacy None, never invented, and the
    strict exact-key receipt check must actually reject them first (not a
    permissive no-op) -- both against a REAL committed checkpoint."""

    def test_legacy_report_missing_metadata_keys_migrates_to_none_and_strict_check_was_load_bearing(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'recovery.json'
            exchange = Path(td) / 'frames.json'
            wo010.run('first_box', path, exchange)
            wo010.run('restart_vertical', path, exchange)
            store = dr.Store(str(path))
            bundle = store.loaded
            domains = bundle['decoded']
            box = domains['box']
            self.assertTrue(box.reports, 'expected at least one real persisted box_delivery_report')
            rid, report = next(iter(box.reports.items()))
            self.assertIn('utterance_id', report)
            self.assertIn('text_hash', report)

            legacy_report = {k: v for k, v in report.items() if k not in bd.REPORT_METADATA}
            legacy_reports = dict(box.reports)
            legacy_reports[rid] = legacy_report
            legacy_box = bd.BoxLedger(dict(box.attempts), legacy_reports, box.sequence)
            legacy_domains = dict(domains, box=legacy_box)

            with self.assertRaises(dr.RecoveryError):
                dr.validate_domains(legacy_domains, bundle['scope'])

            migrated, changed = dr.migrate_legacy_domains(legacy_domains)
            self.assertTrue(changed)
            migrated_report = migrated['box'].reports[rid]
            self.assertIsNone(migrated_report['utterance_id'])
            self.assertIsNone(migrated_report['text_hash'])

            validated = dr.validate_domains(migrated, bundle['scope'])
            self.assertIsNone(validated['box'].reports[rid]['utterance_id'])
            self.assertIsNone(validated['box'].reports[rid]['text_hash'])


class GapFinalBodyHashSameVm(unittest.TestCase):
    """Counterexample #1 ("GAP finalauthority in drainQueue rewrites
    item.text ... but textHash still candidate-time"): inspected and found
    ALREADY fixed in the current tree (renderer.html's buildGapUtterance()
    authority-rebuild step recomputes textHash from the REBUILT final body,
    not the candidate) -- the prior manifest's "not addressed" claim was
    itself stale. This demonstrates it through the real production
    `speak()`/`drainQueue()`/`buildGapUtterance()`/real
    `desktop/gap-freshness.js` path in the SAME persistent Node VM used
    above, not a hand-built assertion."""

    def test_final_hash_tracks_rebuilt_body_not_stale_candidate(self):
        fx = h.NodeFixture()
        try:
            live = {'gap_authority': {'ahead': {
                'session_key': 'sk', 'generation': 3, 'direction': 'ahead',
                'target_car_idx': 12, 'gap_s': 0.7, 'source_kind': 'same_class_battle_gap'}}}
            gap_identity = {'session_key': 'sk', 'generation': 3, 'source_kind': 'same_class_battle_gap',
                            'direction': 'ahead', 'target_car_idx': 12, 'gap_s': 5.5, 'sampled_at': 1700000000}
            r = fx.send('gap_rebuild_probe', text='前5.5秒。', gapIdentity=gap_identity, liveTelemetry=live)
            self.assertNotEqual(r['finalText'], '前5.5秒。',
                                 'the live gap genuinely differs (5.5 vs 0.7) -- authority must rebuild, not play the candidate')
            self.assertNotEqual(r['finalTextHash'], r['candidateTextHash'],
                                 'textHash must track the REBUILT final body, not the stale candidate-time one')
        finally:
            fx.close()

    def test_two_candidates_rebuilding_to_the_same_final_body_get_distinct_utterance_ids(self):
        """'reasonable two chunks/same body distinct IDs': two independently
        queued GAP items that happen to authority-rebuild to the IDENTICAL
        final text (same live gap value) must still be tracked as two
        distinct utterances, not deduplicated by body content."""
        fx = h.NodeFixture()
        try:
            live = {'gap_authority': {'ahead': {
                'session_key': 'sk', 'generation': 3, 'direction': 'ahead',
                'target_car_idx': 12, 'gap_s': 0.7, 'source_kind': 'same_class_battle_gap'}}}
            identity_a = {'session_key': 'sk', 'generation': 3, 'source_kind': 'same_class_battle_gap',
                          'direction': 'ahead', 'target_car_idx': 12, 'gap_s': 5.5, 'sampled_at': 1700000000}
            identity_b = dict(identity_a, gap_s=9.9)
            r1 = fx.send('gap_rebuild_probe', text='前5.5秒。', gapIdentity=identity_a, liveTelemetry=live)
            r2 = fx.send('gap_rebuild_probe', text='前9.9秒。', gapIdentity=identity_b, liveTelemetry=live)
            self.assertEqual(r1['finalText'], r2['finalText'], 'both authority-rebuild to the SAME live value')
            self.assertEqual(r1['finalTextHash'], r2['finalTextHash'])
            self.assertNotEqual(r1['utteranceId'], r2['utteranceId'],
                                 'same final body must not collapse two distinct queued attempts into one ID')
        finally:
            fx.close()


if __name__ == '__main__':
    unittest.main()
