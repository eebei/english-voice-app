"""WO016 REVISE: real judge consumer + urgent Driver command through the real Bridge and
back into the SAME Renderer VM.

Reuses the persistent `wo013_judge_bridge_fixture.js` process (the one WO013/WO015 owner
tests already share — real callAPI()/applyProposalJudgeTag()/handleStrategyDecisionAck(),
real on-disk critical journal, real spawned server.js with only the Anthropic SDK stubbed)
and the real single-process Bridge replays (`run_real_proposal_replay`, the WO008 Road
Atlanta replay).

1. Superseded judgment: a real Plan-B proposal is pending; a confirm-carrying reply is in
   flight on the real judge transport (held at the real server); the real WO016 cancel
   consumer supersedes the turn. The old judgment never reaches applyProposalJudgeTag(),
   no strategy_decision_response leaves the Renderer, the pending proposal keeps its
   revision, and the provider stream is aborted. Control in the same VM/replay: the same
   confirm without supersession produces a response that the real Bridge ACKs.
2. Urgent command while busy: an ordinary turn is in flight; the urgent declaration goes
   through the real sendMsg() admission → real router → real queueDriverPlanCommand()
   (real journal) → WS envelope → real bridge._queue_driver_plan_command() → real
   driver_plan_command_ack → same-VM handleDriverPlanCommandAck() → later real canonical
   snapshot → same-VM confirmCanonicalCommandReadbacks() speaks the readback once.

Run: cd irsdk-bridge && python3 -m unittest tests_wo016_judge_ack_roundtrip
"""
import json
import tempfile
import unittest

import bridge
import tests_wo001_road_atlanta_fixture as road
import tests_wo013_judge_bridge_roundtrip as h
import replay_harness as rh


class SupersededJudgmentRealConsumer(unittest.TestCase):
    def test_superseded_old_judgment_never_reaches_real_consumer_then_control_is_acked(self):
        fx = h.NodeFixture()
        try:
            injected = {}

            def on_ready(state, result):
                if injected.get('done'):
                    return
                injected['done'] = True
                h.drive_propose_and_audible(fx, state)
                decision_id = state['proposal']['decision_id']
                gate = tempfile.mkdtemp(prefix='wo016-judge-')
                injected['sup'] = fx.send('wo016_superseded_judge', classification='confirm',
                                          decisionId=decision_id, holdGateDir=gate)
                # control: identical confirm, no supersession, same VM and same replay
                start = fx.send('resolve_start', classification='confirm', decisionId=decision_id)
                out = fx.send('resolve_await', requestId=start['requestId'])
                response = next(m for m in out['wsSentSinceStart'] if m['cmd'] == 'strategy_decision_response')
                injected['control'] = response
                h.receive(response)

            result, state = h.run_real_proposal_replay(on_ready)
            self.assertTrue(injected.get('done'), 'real proposal replay never reached the pending proposal')
            decision_id = state['proposal']['decision_id']
            sup = injected['sup']
            self.assertTrue(sup['turnWasLive'] and sup['cancelledTurn'], sup)
            self.assertTrue(sup['primaryAborted'], 'the real cancel consumer aborts the turn controller')
            self.assertTrue(sup['abortedBeforeRelease'], 'real server must abort the provider stream on cancel (gate still held)')
            self.assertEqual(0, sup['applyCalls'], 'old judgment reached the real applyProposalJudgeTag consumer')
            self.assertFalse([m for m in sup['wsSentSinceStart'] if m.get('cmd') == 'strategy_decision_response'])
            pending = sup['afterState']['pending_proposal']
            self.assertIsNotNone(pending, 'superseded turn must not consume the pending proposal')
            self.assertEqual(decision_id, pending['decision_id'])
            self.assertEqual(sup['beforeRevision'], pending['base_revision'])
            self.assertFalse(sup['isBusy'])
            # control: the same confirm is applied and the real Bridge ACKs it
            self.assertTrue(injected['control']['accepted'])
            self.assertEqual(decision_id, injected['control']['decision_id'])
            self.assertTrue(h.ack_for(result, decision_id), 'control confirm was not ACKed by the real Bridge')
        finally:
            fx.close()


def _superseded_with_modes(modes):
    fx = h.NodeFixture()
    try:
        out = {}

        def on_ready(state, result):
            if out:
                return
            h.drive_propose_and_audible(fx, state)
            cut = fx.send('wo016_mutate', modes=modes)
            gate = tempfile.mkdtemp(prefix='wo016-judge-cut-')
            sup = fx.send('wo016_superseded_judge', classification='confirm',
                          decisionId=state['proposal']['decision_id'], holdGateDir=gate)
            out.update(cut=cut, sup=sup)

        h.run_real_proposal_replay(on_ready)
        return out
    finally:
        fx.close()


class SupersededJudgmentDefenseInDepthCuts(unittest.TestCase):
    """Two independent WO016 layers protect the real judge consumer: the turn controller
    abort (stream stops) and callAPI's turn-liveness guards. Cutting one keeps the old
    judgment out (the other holds); cutting both lets it reach the real consumer (RED)."""

    def test_abort_cut_alone_still_rejected_by_liveness_guards(self):
        out = _superseded_with_modes(['abort'])
        sup = out['sup']
        self.assertTrue(out['cut']['applied'])
        # primary cancel removed: the turn controller is NOT aborted at the cancel call
        self.assertFalse(sup['primaryAborted'], 'abort cut: the primary controller abort must be absent')
        # the liveness guard is what discarded the late frames
        self.assertTrue(sup['guardDiscarded'], 'the liveness guard must discard the late frames: %r' % (sup['turnDiag'],))
        # a provider abort is allowed only as a consequence of the guard's own reader.cancel()
        if sup['providerAborted'] and sup['abortedBeforeRelease']:
            self.assertTrue(sup['guardPrecededProviderAbort'],
                            'provider aborted without a preceding guard discard -> some other primary path exists')
        self.assertEqual(0, sup['applyCalls'], 'real consumer must stay at 0')
        self.assertFalse([m for m in sup['wsSentSinceStart'] if m.get('cmd') == 'strategy_decision_response'])

    def test_guards_cut_alone_still_rejected_by_abort(self):
        out = _superseded_with_modes(['guards'])
        sup = out['sup']
        self.assertTrue(out['cut']['applied'])
        self.assertTrue(sup['primaryAborted'], 'primary controller abort present (only the guards are cut)')
        self.assertTrue(sup['abortedBeforeRelease'], 'primary abort must reach the provider while the gate is still held')
        self.assertTrue(sup['cancelledCatch'], 'the aborted read must end in the cancelled-turn catch: %r' % (sup['turnDiag'],))
        self.assertEqual(0, sup['applyCalls'])

    def test_both_cut_old_judgment_reaches_real_consumer_red(self):
        out = _superseded_with_modes(['abort', 'guards'])
        self.assertTrue(out['cut']['applied'])
        self.assertEqual(1, out['sup']['applyCalls'], 'RED expected: old confirm reaches applyProposalJudgeTag')
        self.assertTrue([m for m in out['sup']['wsSentSinceStart'] if m.get('cmd') == 'strategy_decision_response'],
                        'RED expected: stale confirm leaves the Renderer as a decision response')


class UrgentCommandRealBridgeSameVmReadback(unittest.TestCase):
    def test_urgent_while_busy_journal_bridge_ack_and_same_vm_canonical_readback(self):
        fx = h.NodeFixture()
        bridge._pending_driver_plan_commands = []
        frames = road.clean_laps(12)[0]
        st = {'stage': 0}

        def hook(cursor, frame, r):
            if st['stage'] == 0:
                live = [b for b in r.broadcasts if b.get('type') == 'telemetry_live' and b.get('active_plan_decision_id')]
                canonical = h.last_canonical_snapshot(r)
                if not live or not canonical:
                    return
                t = live[-1]
                init = fx.send('init', canonicalSnapshot=canonical, sessionNum=canonical['session_num'], lastTelemetry=t)
                assert init['ok'], init
                gate = tempfile.mkdtemp(prefix='wo016-urgent-')
                out = fx.send('wo016_urgent_command_while_busy', text='ピットを10周目に変更', holdGateDir=gate)
                st['urgent'] = out
                if len(out['envelopes']) != 1:
                    st['stage'] = -1
                    return
                st['envelope'] = out['envelopes'][0]
                bridge._queue_driver_plan_command(st['envelope'])
                st['stage'] = 1
                return
            if st['stage'] == 1:
                acks = [b for b in r.broadcasts if b.get('type') == 'driver_plan_command_ack'
                        and b.get('command_id') == st['envelope']['command_id']]
                if acks:
                    st['ack'] = acks[0]
                    st['ack_index'] = r.broadcasts.index(acks[0])
                    st['ack_out'] = fx.send('driver_plan_ack', ack=acks[0])
                    st['stage'] = 2
                return
            if st['stage'] == 2:
                for idx in range(st.get('next_idx', st['ack_index'] + 1), len(r.broadcasts)):
                    b = r.broadcasts[idx]
                    st['next_idx'] = idx + 1
                    if b.get('type') != 'canonical_lifecycle_snapshot':
                        continue
                    out = fx.send('canonical_receive_confirm', snapshot=b)
                    if out['readbacksPending'] == 0 and out['spokenSince']:
                        st['readback'] = out
                        st['stage'] = 3
                        return

        try:
            rh.replay(frames, session_info=road.ROAD_ATLANTA_SESSION_INFO, on_frame_ready=hook)
            urgent = st.get('urgent')
            self.assertIsNotNone(urgent, 'replay never reached an active plan')
            self.assertTrue(urgent['busyBefore'], 'the ordinary turn was not in flight when the urgent input arrived')
            self.assertEqual(1, len(urgent['envelopes']), urgent)
            self.assertTrue(urgent['providerAborted'], 'superseded ordinary turn must abort the provider stream')
            self.assertFalse(urgent['oldBodyInHistory'])
            self.assertTrue(urgent['journalHealthy'])
            env = st['envelope']
            self.assertEqual(('driver_plan_command', 'amend', 10), (env['cmd'], env['intent'], env['requested_target_lap']))
            self.assertGreaterEqual(st['stage'], 2, 'real Bridge never ACKed the urgent command')
            self.assertEqual('applied', st['ack']['outcome'])
            self.assertEqual(0, st['ack_out']['outboxSize'], 'same-VM ACK consumer did not retire the outbox entry')
            self.assertEqual(3, st['stage'], 'same-VM canonical readback never confirmed the command')
            spoken = st['readback']['spokenSince']
            self.assertEqual(1, len([s for s in spoken if '10周目' in s]), spoken)
        finally:
            fx.close()


if __name__ == '__main__':
    unittest.main()
