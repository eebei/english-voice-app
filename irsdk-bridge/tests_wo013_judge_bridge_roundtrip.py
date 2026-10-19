"""WO013 r7 — the single unbroken full route the parent REVISE (review/
PITWALL_SHARED_WORKING_LOG.md "WO013 r5全routefixture読取監査") demanded,
closing every gap that audit found in r5/r6:

  real natural Plan B proposal (NO poisoned decider -- reuses the existing
  `tests_bridge_plan_lifecycle_wiring.ProposalAcceptedFullPollReplayTests`
  PLAN_BC seed/calibration fixture, which makes the real `decide_at_plan_a()`
  choose Plan B on its own)
    -> real `bridge.poll_iracing()` broadcasts `strategy_plan_proposal` +
       matching `canonical_lifecycle_snapshot` (awaiting)
    -> real Renderer `handleStrategyPlanProposal()` -> real `speak()`/TTS
       queue -> real `onSpoken` -> real `sendStrategyDecisionDelivery()`
       ('audible') -> fed into the REAL `bridge.handler()` (same
       `_queue_strategy_delivery_report()` the real websocket server calls)
    -> classification is injected ONLY into the Anthropic SDK stub consumed
       by a REAL spawned `server.js` child process (SDK-only stub, no real
       Anthropic/Google call) -> real extracted `callAPI()` does a REAL
       network round trip to that child, negotiates judgeTransport:'v1',
       parses the REAL NDJSON judgment frame, and calls the REAL
       `applyProposalJudgeTag()` -> (confirm/decline only) REAL
       `sendStrategyDecisionResponse()`/`irBridge.send()` wire
    -> fed into the REAL `bridge.handler()`/`poll_iracing()` (same
       continuous `replay_harness.replay()` call, still running) ->
       REAL `strategy_decision_ack` + REAL follow-up
       `canonical_lifecycle_snapshot` broadcasts
    -> fed back into the SAME persistent Node renderer process/VM (NOT a
       second separate `node` subprocess restoring a JSON Map dump, which
       was r5's defect) -> REAL `handleStrategyDecisionAck()` (outbox/
       tracking Map) + REAL `canonicalLifecycleCache.receive()` ->
       REAL `ensureStrategyState()` canonical readback (lifecycle.active /
       terminal_records), independently assertable from the Bridge's own
       broadcast.

r5's three disclosed defects and their fixes here:
  1. `input.classification` was handed directly to `applyProposalJudgeTag()`
     -- no Server/callAPI/NDJSON involved at all. Fixed: classification is
     injected only into the SDK stub; `wo013_judge_bridge_fixture.js`'s
     `doResolve()` always drives the real `callAPI()`.
  2. `mode=readback` was a SEPARATE `node` subprocess restoring a JSON dump
     of `strategyResponseOutbox`/`bridgeStrategyDecisions` into a BRAND NEW
     sandbox/cache -- "canonical readback" was really "ACK-only, on a copy".
     Fixed: `wo013_judge_bridge_fixture.js` is now a persistent process (see
     its module docstring); one `NodeFixture` instance drives propose,
     resolve, ack and canonical receive against the SAME `cache`/sandbox
     for a given test.
  3. The real-Bridge-consumed 'audible' delivery report and the real-Bridge
     canonical readback after ack were both missing. Fixed below (`drive_
     propose_and_resolve()` feeds the real audible wire to `bridge.handler()`
     before the response wire; every scenario reads back `ensure_state()`
     after an explicit `canonical_receive` of the Bridge's own subsequent
     snapshot).

Reused as directed (review/PITWALL_SHARED_WORKING_LOG.md "r6 seedの実関数
維持補足"): `tests_bridge_plan_lifecycle_wiring`'s PLAN_BC seed/calibration
fixture and `_plan_bc_seed_replay()` -- `bridge.decide_plan_at_target` is
never monkey-patched here.

Disclosed simplifications (kept from r5, both still real production-function
exercises of a real fail-closed branch, not synthetic invention):
  - the dispatch-mismatch "stale" scenario mutates a real captured wire
    message's `dispatch_id` rather than waiting for a genuine Bridge-side
    re-dispatch (`resolve_strategy_proposal()`'s session/dispatch mismatch
    branch is still the real one exercised).
  - the in-flight canonical-staleness scenario advances the Node fixture's
    simulated clock (`set_clock`) past the request-time binding's own
    frozen deadline while refreshing the canonical cache with a sequence-
    bumped, content-identical snapshot (exactly the technique already used
    by `tests-wo011-desktop-projection.js` scenarios E/I) -- this proves the
    real `strategyProjection.validBinding()` re-check inside the real
    `applyProposalJudgeTag()`'s `doApply()`, not a hand-rolled staleness
    check.
"""
import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import bridge
import replay_harness as rh
import tests_bridge_plan_lifecycle_wiring as planbc

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT / 'wo013_judge_bridge_fixture.js'


def _next_port():
    """Ask the OS for a free ephemeral port instead of guessing a fixed
    range -- avoids EADDRINUSE flakiness across repeated test/debug runs
    that each spawn their own real server.js child."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def receive(message):
    """Feeds `message` into the REAL `bridge.handler()` via a Socket test
    adapter (same technique as tests_wo011_projection_wiring.py's `receive()`
    and tests_wo013_judge_bridge_roundtrip.py's prior rounds)."""
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
    import asyncio
    with patch.object(bridge, 'log', lambda x: None), \
            patch.object(bridge, 'list_input_devices', lambda: []):
        asyncio.run(bridge.handler(Socket()))


class NodeFixture:
    """One persistent `wo013_judge_bridge_fixture.js` process (own spawned
    `server.js` child, own Renderer VM/sandbox) for the lifetime of a single
    test. Every command after `init` operates on the SAME sandbox -- this is
    the fix for r5's "mode=readback is a separate subprocess" defect."""

    def __init__(self):
        self.port = _next_port()
        self.proc = subprocess.Popen(
            [sys.executable and 'node' or 'node', str(FIXTURE), str(self.port)],
            cwd=str(ROOT), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1)
        self._seq = 0
        ready_line = self.proc.stdout.readline()
        if not ready_line:
            raise AssertionError('node fixture produced no output: stderr=%r'
                                  % (self.proc.stderr.read(),))
        ready = json.loads(ready_line)
        if not ready.get('ready'):
            raise AssertionError('node fixture did not report ready: %r' % (ready,))

    def send(self, cmd, **payload):
        self._seq += 1
        req_id = 'p%d' % self._seq
        try:
            self.proc.stdin.write(json.dumps({'id': req_id, 'cmd': cmd, **payload}) + '\n')
            self.proc.stdin.flush()
        except BrokenPipeError:
            # WO016: surface why the persistent fixture died instead of a bare broken pipe.
            raise AssertionError('node fixture exited before cmd=%s: exit=%r stderr=%r'
                                 % (cmd, self.proc.poll(), self.proc.stderr.read()[-4000:]))
        line = self.proc.stdout.readline()
        if not line:
            raise AssertionError('node fixture closed stdout during cmd=%s: stderr=%r'
                                  % (cmd, self.proc.stderr.read()))
        msg = json.loads(line)
        if msg.get('id') != req_id:
            raise AssertionError('response id mismatch for cmd=%s: expected %s got %r'
                                  % (cmd, req_id, msg))
        if not msg.get('ok', True):
            raise AssertionError('node fixture cmd=%s failed: %r' % (cmd, msg))
        return msg

    def close(self):
        try:
            self.send('shutdown')
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
            self.proc.wait(timeout=5)
        finally:
            for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
                try:
                    stream.close()
                except Exception:
                    pass


def run_real_proposal_replay(on_ready):
    """Replays the REAL `_plan_bc_accept_build_frames()` telemetry through
    the REAL `bridge.poll_iracing()` loop (PLAN_BC seed/calibration fixture
    pointed at via `bridge.PIT_LOSS_PATH`, same as `ProposalAcceptedFull
    PollReplayTests`) -- `decide_at_plan_a()`/`decide_plan_at_target` are
    NEVER monkey-patched; the real fuel window + rival pace deficit +
    seeded pit-loss calibration make the real decision logic choose Plan B
    on its own. `on_ready(state, result)` runs on every frame boundary once
    the real proposal + matching canonical snapshot (Plan A active, Plan B
    awaiting) have been captured into `state`.
    """
    state = {}

    def hook(cursor, frame, result):
        if 'proposal' not in state:
            for b in reversed(result.broadcasts):
                if b.get('trigger') == 'strategy_plan_proposal':
                    state['proposal'] = b
                    break
        if 'proposal' in state and 'snapshot' not in state:
            decision_id = state['proposal']['decision_id']
            for b in reversed(result.broadcasts):
                if b.get('type') == 'canonical_lifecycle_snapshot' and any(
                        a.get('decision_id') == decision_id
                        for a in b.get('lifecycle', {}).get('awaiting', [])):
                    state['snapshot'] = b
                    break
        if 'snapshot' in state:
            on_ready(state, result)

    frames = planbc._plan_bc_accept_build_frames()
    original_pit_loss_path = bridge.PIT_LOSS_PATH
    bridge.PIT_LOSS_PATH = planbc.PLAN_BC_CALIBRATION_FIXTURE
    try:
        result = planbc._plan_bc_seed_replay(
            frames, session_info=planbc.PLAN_BC_ACCEPT_SESSION_INFO,
            on_frame_ready=hook)
    finally:
        bridge.PIT_LOSS_PATH = original_pit_loss_path
    return result, state


def ack_for(result, decision_id, dispatch_id=None):
    acks = [b for b in result.broadcasts if b.get('type') == 'strategy_decision_ack'
            and b.get('decision_id') == decision_id]
    if dispatch_id is not None:
        acks = [a for a in acks if a.get('dispatch_id') == dispatch_id]
    return acks


def last_canonical_snapshot(result):
    for b in reversed(result.broadcasts):
        if b.get('type') == 'canonical_lifecycle_snapshot':
            return b
    return None


def canonical_snapshot_with_active(result, decision_id):
    for b in result.broadcasts:
        if (b.get('type') == 'canonical_lifecycle_snapshot'
                and b.get('lifecycle', {}).get('active')
                and b['lifecycle']['active'].get('decision_id') == decision_id):
            return b
    return None


def canonical_snapshot_with_terminal(result, decision_id, phase):
    for b in result.broadcasts:
        if b.get('type') != 'canonical_lifecycle_snapshot':
            continue
        for rec in b.get('lifecycle', {}).get('terminal_records', []):
            if rec.get('decision_id') == decision_id and rec.get('phase') == phase:
                return b
    return None


def bump_sequence(snapshot):
    """Content-identical copy with only snapshot_sequence/snapshot_id
    advanced -- refreshes the Node fixture's canonical cache `receivedAt`
    without changing any awaiting/active record content (same technique as
    tests-wo011-desktop-projection.js's scenario E/I 'refreshed' snapshots)."""
    mutated = copy.deepcopy(snapshot)
    mutated['snapshot_sequence'] += 1
    mutated['snapshot_id'] = mutated['bridge_process_epoch'] + ':' + str(mutated['snapshot_sequence'])
    return mutated


GATE_POLL_INTERVAL_S = 0.01
GATE_ARRIVE_TIMEOUT_S = 3.0


def wait_for_gate_arrival(gate_dir):
    """Blocks until the stub (inside the real spawned server.js child) has
    reached its file-based HTTP barrier -- see tests-wo001-anthropic-stream-
    stub-preload.js's waitForGateRelease(). Deterministic in OUTCOME (the
    caller only proceeds once genuinely arrived); the bounded poll is just
    how a cross-process filesystem signal is observed, not a guess about
    how long the real HTTP round trip takes."""
    deadline = time.time() + GATE_ARRIVE_TIMEOUT_S
    arrived = os.path.join(gate_dir, 'arrived')
    while not os.path.exists(arrived):
        if time.time() > deadline:
            raise AssertionError(
                'real HTTP barrier never reported arrival within %.1fs (gate_dir=%s) -- '
                'the in-flight mutation would otherwise race the real network response '
                'instead of genuinely happening while it is unresolved'
                % (GATE_ARRIVE_TIMEOUT_S, gate_dir))
        time.sleep(GATE_POLL_INTERVAL_S)


def release_gate(gate_dir):
    with open(os.path.join(gate_dir, 'release'), 'w') as f:
        f.write('1')


def relabel_epoch(snapshot, new_epoch):
    """Renames bridge_process_epoch (and every nested ref/snapshot_id that
    embeds it) throughout a REAL captured canonical snapshot -- same
    structural technique as bump_sequence(), just relabeling the opaque
    epoch token instead of the sequence counter. PROCESS_EPOCH is a
    uuid4().hex (canonical_lifecycle_snapshot.py), so a raw substring
    replace cannot collide with unrelated fields."""
    old_epoch = snapshot['bridge_process_epoch']
    raw = json.dumps(snapshot)
    if raw.count(old_epoch) < 1:
        raise AssertionError('bridge_process_epoch %r not found in snapshot JSON' % (old_epoch,))
    return json.loads(raw.replace(old_epoch, new_epoch))


def bump_awaiting_revision(snapshot, decision_id):
    """Content-DIFFERENT copy (unlike bump_sequence()'s content-identical
    refresh): the awaiting record for decision_id gets a genuinely bumped
    revision, simulating a real Bridge-side recalculation of the same
    pending call while a judgment on the OLD revision is in flight."""
    mutated = copy.deepcopy(snapshot)
    rec = next((r for r in mutated['lifecycle']['awaiting'] if r['decision_id'] == decision_id), None)
    if rec is None:
        raise AssertionError('decision_id %r not found in awaiting records' % (decision_id,))
    rec['revision'] += 1
    rec['record_ref']['revision'] = rec['revision']
    # current_custody_ref must track record_ref exactly (canonical-lifecycle-
    # cache.js's validate(): stable(current_custody_ref)===stable(record_ref));
    # origin_record_ref may legitimately lag behind (its own revision<=ref's).
    if rec.get('current_custody_ref') is not None:
        rec['current_custody_ref'] = dict(rec['record_ref'])
    mutated['snapshot_sequence'] += 1
    mutated['snapshot_id'] = mutated['bridge_process_epoch'] + ':' + str(mutated['snapshot_sequence'])
    return mutated, rec['revision']


def drive_propose_and_audible(fx, state):
    """init + real propose leg; feeds the REAL 'audible' delivery wire into
    the REAL bridge.handler() (closing r5's gap (4): the audible delivery
    report never reached Bridge at all before)."""
    fx.send('init', canonicalSnapshot=state['snapshot'],
            sessionNum=state['snapshot']['session_num'],
            lastTelemetry={'strategy_options': state['proposal']['strategy_options']})
    propose_out = fx.send('propose', proposal=state['proposal'])
    pending = propose_out['pendingBefore']
    if not pending or pending['decision_id'] != state['proposal']['decision_id']:
        raise AssertionError('real proposal never reached pending: %r' % (propose_out,))
    audible = next(m for m in propose_out['wsSent']
                    if m['cmd'] == 'strategy_decision_delivery' and m['outcome'] == 'audible'
                    and m['decision_id'] == state['proposal']['decision_id'])
    receive(audible)
    return propose_out


class ActualJudgeBridgeFullRouteTests(unittest.TestCase):
    """Each test drives ONE unbroken route end to end, on the SAME
    decision_id/dispatch_id/session_num throughout, with a single persistent
    Node renderer process (`NodeFixture`) and the SAME continuous real
    `replay_harness.replay()` call on the Python/Bridge side."""

    def test_confirm_full_route_canonical_active_same_decision_id(self):
        fx = NodeFixture()
        try:
            injected = {}

            def on_ready(state, result):
                if injected.get('done'):
                    return
                injected['done'] = True
                drive_propose_and_audible(fx, state)
                start = fx.send('resolve_start', classification='confirm',
                                 decisionId=state['proposal']['decision_id'])
                injected['await_out'] = fx.send('resolve_await', requestId=start['requestId'])
                response = next(m for m in injected['await_out']['wsSentSinceStart']
                                 if m['cmd'] == 'strategy_decision_response')
                injected['response'] = response
                receive(response)

            result, state = run_real_proposal_replay(on_ready)
            self.assertTrue(injected.get('done'), 'real propose/resolve never reached')
            decision_id = state['proposal']['decision_id']
            dispatch_id = state['proposal']['dispatch_id']
            response = injected['response']
            self.assertTrue(response['accepted'])
            self.assertEqual(decision_id, response['decision_id'])
            self.assertEqual(dispatch_id, response['dispatch_id'])

            # ★WO013 r7独立読取差戻し point2：reply直後・ACK/canonical反映より前。
            #   同VMで、送った応答がまだ1件outboxに残っていること、かつ
            #   pit_plan がまだ「直前の正本（Plan A）」のままであることを
            #   明示assertする——ACK前に既にB化していないかを反証する。
            pre_ack = fx.send('ensure_state')
            self.assertEqual(1, pre_ack['outboxSize'], pre_ack)
            self.assertEqual('A', pre_ack['state']['pit_plan']['plan_id'],
                              'before Bridge ack, pit_plan must still be the PRIOR canonical (A), '
                              'not already B')

            acks = ack_for(result, decision_id, dispatch_id)
            self.assertEqual(1, len(acks), result.broadcasts)
            self.assertEqual('accepted', acks[0]['outcome'])

            active_snapshot = canonical_snapshot_with_active(result, decision_id)
            self.assertIsNotNone(active_snapshot, 'Bridge never broadcast B as canonical active')
            self.assertEqual('B', active_snapshot['lifecycle']['active']['selected_plan'])

            # Real ACK into the SAME Node VM (not a second subprocess with a
            # JSON-restored Map -- r5's defect (2)).
            ack_out = fx.send('bridge_ack', ack=acks[0])
            self.assertEqual(0, ack_out['outboxSizeAfter'], ack_out)
            self.assertFalse(ack_out['bridgeDecisionsHasAfter'], ack_out)
            # Real canonical readback into the SAME VM/cache.
            readback = fx.send('canonical_receive', snapshot=active_snapshot)
            self.assertTrue(readback['ok'])
            self.assertIsNotNone(readback['state']['active'])
            self.assertEqual(decision_id, readback['state']['active']['decision_id'])
            self.assertEqual('active', readback['state']['active']['phase'])
            self.assertIsNotNone(readback['state']['pit_plan'])
            self.assertEqual('B', readback['state']['pit_plan']['plan_id'])
        finally:
            fx.close()

    def test_decline_full_route_canonical_cancelled_terminal_a_remains_active(self):
        fx = NodeFixture()
        try:
            injected = {}

            def on_ready(state, result):
                if injected.get('done'):
                    return
                injected['done'] = True
                injected['plan_a_decision_id'] = state['snapshot']['lifecycle']['active']['decision_id']
                drive_propose_and_audible(fx, state)
                start = fx.send('resolve_start', classification='decline',
                                 decisionId=state['proposal']['decision_id'])
                injected['await_out'] = fx.send('resolve_await', requestId=start['requestId'])
                response = next(m for m in injected['await_out']['wsSentSinceStart']
                                 if m['cmd'] == 'strategy_decision_response')
                injected['response'] = response
                receive(response)

            result, state = run_real_proposal_replay(on_ready)
            self.assertTrue(injected.get('done'))
            decision_id = state['proposal']['decision_id']
            response = injected['response']
            self.assertFalse(response['accepted'])

            # ★WO013 r7独立読取差戻し point2：declineも同様に、ACK前は
            #   outbox1件・pit_plan はまだ直前の正本（Plan A、そもそも
            #   declineなのでACK後も変わらない）であることを明示assertする。
            pre_ack = fx.send('ensure_state')
            self.assertEqual(1, pre_ack['outboxSize'], pre_ack)
            self.assertEqual('A', pre_ack['state']['pit_plan']['plan_id'],
                              'before Bridge ack, pit_plan must still be the PRIOR canonical (A)')

            acks = ack_for(result, decision_id, state['proposal']['dispatch_id'])
            self.assertEqual(1, len(acks), result.broadcasts)
            self.assertEqual('declined', acks[0]['outcome'])

            cancelled_snapshot = canonical_snapshot_with_terminal(result, decision_id, 'cancelled')
            self.assertIsNotNone(cancelled_snapshot, 'Bridge never terminal-cancelled the declined B record')
            plan_a_id = injected['plan_a_decision_id']
            self.assertEqual(plan_a_id, cancelled_snapshot['lifecycle']['active']['decision_id'],
                              'Plan A must remain the untouched active record after a B decline')

            ack_out = fx.send('bridge_ack', ack=acks[0])
            self.assertEqual(0, ack_out['outboxSizeAfter'], ack_out)
            readback = fx.send('canonical_receive', snapshot=cancelled_snapshot)
            self.assertEqual(plan_a_id, readback['state']['active']['decision_id'])
            cancelled_terminal = next(
                t for t in readback['state']['terminals'] if t['decision_id'] == decision_id)
            self.assertEqual('cancelled', cancelled_terminal['phase'])
            self.assertEqual('A', readback['state']['pit_plan']['plan_id'],
                              'pit_plan must reflect the still-active Plan A, never the declined B')
        finally:
            fx.close()

    def test_duplicate_response_and_duplicate_ack_are_idempotent(self):
        fx = NodeFixture()
        try:
            stage = {'n': 0}

            def on_ready(state, result):
                decision_id = state['proposal']['decision_id']
                if stage['n'] == 0:
                    stage['n'] = 1
                    drive_propose_and_audible(fx, state)
                    start = fx.send('resolve_start', classification='confirm', decisionId=decision_id)
                    await_out = fx.send('resolve_await', requestId=start['requestId'])
                    stage['response'] = next(m for m in await_out['wsSentSinceStart']
                                              if m['cmd'] == 'strategy_decision_response')
                    receive(stage['response'])
                    return
                if stage['n'] == 1 and ack_for(result, decision_id):
                    stage['n'] = 2
                    receive(stage['response'])

            result, state = run_real_proposal_replay(on_ready)
            self.assertEqual(2, stage['n'], 'duplicate injection never reached')
            decision_id, dispatch_id = state['proposal']['decision_id'], state['proposal']['dispatch_id']
            acks = ack_for(result, decision_id, dispatch_id)
            self.assertEqual(2, len(acks), result.broadcasts)
            self.assertEqual('accepted', acks[0]['outcome'])
            self.assertIn(acks[1]['outcome'], ('no_match', 'stale'))

            ack_out1 = fx.send('bridge_ack', ack=acks[0])
            self.assertEqual(0, ack_out1['outboxSizeAfter'])
            self.assertFalse(ack_out1['bridgeDecisionsHasAfter'])
            ack_out2 = fx.send('bridge_ack', ack=acks[1])
            self.assertEqual(0, ack_out2['outboxSizeAfter'])
            self.assertFalse(ack_out2['bridgeDecisionsHasAfter'])
            self.assertEqual([], ack_out2['wsSentDuringAck'])
        finally:
            fx.close()

    def test_stale_dispatch_mismatch_does_not_advance_either_side(self):
        fx = NodeFixture()
        try:
            injected = {}

            def on_ready(state, result):
                if injected.get('done'):
                    return
                injected['done'] = True
                drive_propose_and_audible(fx, state)
                decision_id = state['proposal']['decision_id']
                start = fx.send('resolve_start', classification='confirm', decisionId=decision_id)
                await_out = fx.send('resolve_await', requestId=start['requestId'])
                real_response = next(m for m in await_out['wsSentSinceStart']
                                      if m['cmd'] == 'strategy_decision_response')
                stale_response = dict(real_response, dispatch_id=real_response['dispatch_id'] + '-stale-retry')
                injected['real_response'] = real_response
                injected['stale_response'] = stale_response
                receive(stale_response)

            result, state = run_real_proposal_replay(on_ready)
            self.assertTrue(injected.get('done'))
            decision_id = state['proposal']['decision_id']
            real_dispatch = injected['real_response']['dispatch_id']
            stale_dispatch = injected['stale_response']['dispatch_id']

            stale_acks = ack_for(result, decision_id, stale_dispatch)
            self.assertEqual(1, len(stale_acks), result.broadcasts)
            self.assertEqual('stale', stale_acks[0]['outcome'])
            self.assertEqual([], ack_for(result, decision_id, real_dispatch))

            ack_out = fx.send('bridge_ack', ack=stale_acks[0])
            self.assertEqual(1, ack_out['outboxSizeAfter'],
                              'a mismatched/stale ack must not clear the real pending response')
            self.assertTrue(ack_out['bridgeDecisionsHasAfter'])
            self.assertEqual([], ack_out['wsSentDuringAck'])
        finally:
            fx.close()

    def test_same_topic_kept_pending_advances_generation_sends_zero_wire(self):
        fx = NodeFixture()
        try:
            injected = {}

            def on_ready(state, result):
                if injected.get('done'):
                    return
                injected['done'] = True
                decision_id = state['proposal']['decision_id']
                drive_propose_and_audible(fx, state)
                # ★WO013 r7独立読取差戻し point1：callAPI直呼びだけでは
                #   pending_proposal.awaiting_judgment は初期falseのまま
                #   （proposePlanがawaiting_judgment:falseで作るため）、revision
                #   が進んだこと**だけ**では「判定待ちゲートが本当に効いていた」
                #   ことの証明にならない。実production経路（desktop/local-
                #   intent-router.jsのrouteLegacy()がhandled:falseの発話で
                #   呼ぶのと同じ実関数）currentStrategyStateAPI().
                #   markAwaitingJudgment()を先に駆動し、true→(spoken後)false
                #   の遷移そのものをassertする。
                mark_out = fx.send('mark_awaiting_judgment')
                injected['mark_out'] = mark_out
                self.assertTrue(mark_out['pending']['awaiting_judgment'],
                                 'real markAwaitingJudgment() must set awaiting_judgment=true '
                                 'before any judgment has been classified')
                start = fx.send('resolve_start', classification='same_topic', decisionId=decision_id)
                injected['await_out'] = fx.send('resolve_await', requestId=start['requestId'])
                # Still true: the judgment has been classified as same_topic
                # but doApply() is deferred until the reply is actually
                # spoken -- the gate must not release early just because the
                # network round trip completed.
                injected['still_awaiting_before_spoken'] = injected['await_out']['afterState']['pending_proposal']['awaiting_judgment']
                # applyProposalJudgeTag's same_topic path defers doApply()
                # until the chat reply's own queued speech item is marked
                # 'spoken' -- drive that explicitly (see drain_speak_queue
                # in the Node fixture).
                injected['drain_out'] = fx.send('drain_speak_queue')

            result, state = run_real_proposal_replay(on_ready)
            self.assertTrue(injected.get('done'))
            decision_id = state['proposal']['decision_id']
            await_out = injected['await_out']
            drain_out = injected['drain_out']
            self.assertEqual(
                [], [m for m in await_out['wsSentSinceStart'] + drain_out['wsSentDuringDrain']
                     if m['cmd'] == 'strategy_decision_response'],
                'same_topic must never send a decision wire to Bridge')
            self.assertTrue(injected['still_awaiting_before_spoken'],
                             'awaiting_judgment must remain true until the OWN reply is spoken')
            before = injected['mark_out']['pending']['base_revision']
            after_pending = drain_out['state']['pending_proposal']
            self.assertIsNotNone(after_pending, 'same_topic must keep the proposal pending (kept_pending)')
            self.assertEqual(decision_id, after_pending['decision_id'])
            self.assertNotEqual(before, after_pending['base_revision'],
                                 'kept_pending must still advance the projection generation '
                                 '(proves applyProposalClassification actually ran)')
            self.assertFalse(after_pending['awaiting_judgment'],
                              'once the own reply has actually been spoken, the real '
                              'applyProposalClassification(same_topic) must clear '
                              'awaiting_judgment=false (the driver can now say a bare '
                              '"yes" and have it apply)')

            # Bridge-side: nothing was ever sent, so the awaiting B record
            # Bridge itself continues to broadcast must be untouched (not
            # cancelled, not promoted to active).
            last_snapshot = last_canonical_snapshot(result)
            self.assertTrue(any(a['decision_id'] == decision_id
                                 for a in last_snapshot['lifecycle']['awaiting']),
                             'Bridge canonical awaiting must not be cancelled by a local same_topic')
        finally:
            fx.close()

    def test_same_topic_dropped_before_audible_keeps_awaiting_judgment_true(self):
        """The counterpart negative case to the kept_pending test above:
        when the OWN reply is never actually heard (voice off, same real
        voiceOn gate speak() itself checks), doApply() must never run --
        awaiting_judgment set by the real markAwaitingJudgment() must stay
        true forever (not silently resolve on an unheard explanation)."""
        fx = NodeFixture()
        try:
            injected = {}

            def on_ready(state, result):
                if injected.get('done'):
                    return
                injected['done'] = True
                decision_id = state['proposal']['decision_id']
                drive_propose_and_audible(fx, state)
                mark_out = fx.send('mark_awaiting_judgment')
                self.assertTrue(mark_out['pending']['awaiting_judgment'])
                injected['before_revision'] = mark_out['pending']['base_revision']
                fx.send('set_voice_on', value=False)
                start = fx.send('resolve_start', classification='same_topic', decisionId=decision_id)
                injected['await_out'] = fx.send('resolve_await', requestId=start['requestId'])
                # Nothing left to drain: speak() returned before ever
                # queueing an item, so drain_speak_queue would be a no-op --
                # the real applyProposalJudgeTag() already hit its
                # 'no_target' fail-closed branch synchronously inside
                # callAPI() above (no deferred hook was ever attached).
                injected['drain_out'] = fx.send('drain_speak_queue')
                fx.send('set_voice_on', value=True)

            result, state = run_real_proposal_replay(on_ready)
            self.assertTrue(injected.get('done'))
            decision_id = state['proposal']['decision_id']
            await_out = injected['await_out']
            drain_out = injected['drain_out']
            self.assertEqual(
                [], [m for m in await_out['wsSentSinceStart'] + drain_out['wsSentDuringDrain']
                     if m['cmd'] == 'strategy_decision_response'],
                'a same_topic reply that was never heard must never send a decision wire')
            after_pending = drain_out['state']['pending_proposal']
            self.assertIsNotNone(after_pending,
                                  'an unheard same_topic reply must still keep the proposal pending')
            self.assertEqual(decision_id, after_pending['decision_id'])
            self.assertTrue(after_pending['awaiting_judgment'],
                             'awaiting_judgment must remain true when the reply explaining it '
                             'was never actually delivered (voice off) -- a bare "yes" later '
                             'must still be gated, not silently treated as already judged')
            self.assertEqual(injected['before_revision'], after_pending['base_revision'],
                              'an unheard reply must not advance the generation either -- '
                              'applyProposalClassification(same_topic) never ran at all')
        finally:
            fx.close()

    def _run_inflight_stale_same_topic(self, fx, state, mutated):
        """Shared sequence for the genuine in-flight staleness scenario and
        its RED/GREEN mutation counterpart below. `mutated` selects whether
        `applyProposalJudgeTag`'s own binding re-check has been cut on this
        fixture's VM (see `mutate_cut_binding_check` in the Node fixture)."""
        decision_id = state['proposal']['decision_id']
        fx.send('set_clock', value=0)
        drive_propose_and_audible(fx, state)
        # ★WO013 r7独立読取差戻し point1の調査で判明（point5修正の前提）：
        #   ここで実markAwaitingJudgment()を先に呼ぶと、
        #   currentPlanReplyDependsOn()のpending.awaiting_judgment===true
        #   フォールバックが真になり、このreply自身にも
        #   _replyStrategyBinding付きのSPEAK層precheckが付く——このテストが
        #   対象にしているdoApply()自身のjudgmentBinding再照合より**先に**
        #   そのSPEAK precheckが同じdeadlineで先に落ちてしまい
        #   （実測：SPEAK_PRECHECK fate=discard reason=
        #   stale_precondition_pre_play）、onSpoken自体が発火しなくなる
        #   ——doApply()の対象ガードを隠してしまうため、ここでは**意図的に**
        #   markAwaitingJudgmentを呼ばない（真のawaiting_judgment true→false
        #   遷移はtest_same_topic_kept_pending_...とtest_same_topic_dropped_
        #   before_audible_...が別途、実markAwaitingJudgmentで直接検証する）。
        if mutated:
            fx.send('mutate_cut_binding_check')
        start = fx.send('resolve_start', classification='same_topic', decisionId=decision_id)
        # The network/NDJSON leg completes here: callAPI() validates the
        # proposal binding was fresh AT PARSE TIME (a separate, earlier
        # fail-closed gate than the one below) and -- since same_topic is
        # deferred -- applyProposalJudgeTag() attaches its onSpoken hook
        # without applying anything yet.
        await_out = fx.send('resolve_await', requestId=start['requestId'])
        # ONLY NOW, during the same_topic DEFERRAL window (after the judgment
        # was validated fresh, before the reply is actually spoken) -- a
        # genuinely different, schema-valid snapshot lands, simulating a
        # live Bridge-side recalculation that advanced canonical state while
        # this reply was still queued to be heard. This is the specific
        # staleness window `doApply()`'s own `strategyProjection.
        # validBinding(judgmentBinding)` re-check exists for (WO013 r2
        # differed-apply fix) -- distinct from callAPI()'s own earlier,
        # already-covered request-time freshness gate.
        fx.send('set_clock', value=4000)
        fx.send('canonical_receive', snapshot=bump_sequence(state['snapshot']))
        fx.send('set_clock', value=5100)  # past the request-time binding's own 5000ms deadline
        # ★WO014 GO再開「WO013残1件の証拠接続修復」：このシナリオが実際に
        #   doApply()へ到達するより前にdiscardされることを、推測ではなく
        #   diagLogで直接観測できるようにする（下のcontrol testでonSpoken=0/
        #   upstream fenceの発火そのものをassertするため）。
        diag_before = fx.send('debug_diag')
        drain_out = fx.send('drain_speak_queue')
        diag_after = fx.send('debug_diag')
        if mutated:
            fx.send('mutate_restore')
        return {
            'wsSentSinceStart': await_out['wsSentSinceStart'] + drain_out['wsSentDuringDrain'],
            'wsSentDuringDrain': drain_out['wsSentDuringDrain'],
            'beforeRevision': await_out['beforeRevision'],
            'afterState': drain_out['state'],
            'newDiag': diag_after['diagLog'][len(diag_before['diagLog']):],
        }

    def test_same_topic_deferred_apply_blocked_by_inflight_canonical_staleness(self):
        """This is the "upstream precheck intact" FULL-ROUTE control demanded
        by the parent GO再開 note ("WO013残1件の証拠接続修復"): the whole
        route is blocked, proven here to be via the upstream SPEAK_PRECHECK
        fence (onSpoken never fires -- no 'spoke' wire, a real
        'stale_precondition' SPEAK_PRECHECK diag entry), NOT via doApply()'s
        own judgmentBinding recheck (which, per the sibling mutation test
        below, is never even reached on this exact TTL-expiry path). Do not
        read this test's PASS as proof of the downstream guard -- see
        `test_same_topic_isolated_delivery_item_blocked_by_judgment_binding_recheck`
        for that, specifically."""
        fx = NodeFixture()
        try:
            injected = {}

            def on_ready(state, result):
                if injected.get('done'):
                    return
                injected['done'] = True
                injected['await_out'] = self._run_inflight_stale_same_topic(fx, state, mutated=False)

            result, state = run_real_proposal_replay(on_ready)
            self.assertTrue(injected.get('done'))
            decision_id = state['proposal']['decision_id']
            await_out = injected['await_out']
            self.assertEqual(
                [], [m for m in await_out['wsSentSinceStart'] if m['cmd'] == 'strategy_decision_response'])
            # onSpoken=0: the item was never actually heard (no real 'spoke'
            # wire during the drain that would follow a successful play()).
            self.assertFalse(
                any(m.get('cmd') == 'spoke' for m in await_out['wsSentDuringDrain']),
                'the full-route control must never reach onSpoken on this TTL-expiry path')
            # the cut is the upstream SPEAK_PRECHECK fence specifically, not
            # a silent no-op -- observed directly, not inferred.
            self.assertTrue(
                any(d['tag'] == 'SPEAK_PRECHECK' and 'stale_precondition' in d['body']
                    for d in await_out['newDiag']),
                'expected a real SPEAK_PRECHECK stale-precondition discard on this path, '
                'new diag=%r' % (await_out['newDiag'],))
            before = await_out['beforeRevision']
            after_pending = await_out['afterState']['pending_proposal']
            # ★WO013 r7独立読取差戻し point5：`if after_pending is not None`
            #   だけのガードは、もしproposalが消えていても（Noneになっても）
            #   何もassertせずvacuous PASSしてしまう——このsame_topicシナリオ
            #   は有効な設定（提案がまだ存在するはず）なので、まず存在を
            #   必須にする。
            self.assertIsNotNone(after_pending,
                                  'in-flight canonical staleness must still leave the proposal '
                                  'pending (blocked apply), not wipe it out entirely -- this is a '
                                  'valid configuration where the proposal must still exist')
            self.assertEqual(decision_id, after_pending['decision_id'])
            self.assertEqual(before, after_pending['base_revision'],
                              'in-flight canonical staleness must block the deferred '
                              'same_topic apply, not let it land late')
        finally:
            fx.close()

    def test_mutation_cut_binding_recheck_has_no_effect_under_dominant_upstream_ttl_fence(self):
        """★WO014 GO再開「WO013残1件の証拠接続修復」新規発見（independently
        confirmed by reading desktop/strategy-state-projection.js binding()/
        validBinding() -- not a guess): this test used to be named
        `test_mutation_removing_binding_recheck_breaks_inflight_stale_guard`
        and asserted `assertNotEqual` (RED must land). It failed (2==2)
        because, on THIS exact scenario, the real
        `applyProposalJudgeTag()`'s own `doApply()` judgmentBinding recheck
        is structurally unreachable -- not because the guard is broken, but
        because `binding()` bakes `deadline_ms` from the SAME
        `canonical.expiresAt()` call for every kind, so the outer queued
        reply item's own SPEAK_PRECHECK (critical_context, captured at the
        same instant as the inner judgmentBinding) shares the identical TTL
        deadline. Once the fixture's clock passes that deadline, the real
        `drainQueue()` SPEAK_PRECHECK (line ~4131 `stale_precondition`)
        ALWAYS discards the item before 'spoken' -- onSpoken never fires --
        so `doApply()` (only reachable via onSpoken for a deferred
        same_topic judgment) is never even called. Cutting its recheck is
        therefore unobservable here: this is a genuinely negative result
        (the mutation really has zero effect on this path), not a
        vacuous-pass bug in the test. Flipping to `assertEqual` documents
        this finding instead of hiding a persistently failing assertion --
        this does NOT claim the downstream guard is dead in general: see
        `test_same_topic_isolated_delivery_item_blocked_by_judgment_binding_recheck`
        / `test_mutation_removing_binding_recheck_breaks_isolated_same_topic_guard`
        immediately below, which reach and exercise the SAME real recheck on
        this SAME TTL-expiry condition, by locally isolating just the one
        target delivery item's own SPEAK_PRECHECK (not disabling it, not
        changing the condition) so onSpoken genuinely fires."""
        fx = NodeFixture()
        try:
            captured = {}

            def on_ready(state, result):
                if captured.get('done'):
                    return
                captured['done'] = True
                captured['mutated'] = self._run_inflight_stale_same_topic(fx, state, mutated=True)

            result, state = run_real_proposal_replay(on_ready)
            self.assertTrue(captured.get('done'))
            mutated_out = captured['mutated']
            mutated_before = mutated_out['beforeRevision']
            mutated_after = mutated_out['afterState']['pending_proposal']
            self.assertIsNotNone(mutated_after, 'mutated run unexpectedly lost the pending proposal entirely')
            self.assertEqual(
                mutated_before, mutated_after['base_revision'],
                'documented dead path: cutting doApply()\'s judgmentBinding recheck must '
                'have NO observable effect here, because the dominant upstream '
                'SPEAK_PRECHECK (same shared TTL deadline) already discards this item '
                'before onSpoken/doApply() can ever run -- if this now fails, the '
                'upstream fence itself changed and this finding needs re-verifying')
            self.assertFalse(
                any(m.get('cmd') == 'spoke' for m in mutated_out['wsSentDuringDrain']),
                'onSpoken must still never fire even with the recheck cut -- confirms '
                'the cut guard was never the thing blocking this path')
        finally:
            fx.close()

    def _run_inflight_stale_same_topic_isolated(self, fx, state, mutated):
        """★WO014 GO再開差戻し「WO013後段証拠の途中設計照合」: a prior attempt
        tried swapping in `bump_awaiting_revision()` (a content-DIFFERENT
        mid-flight canonical change) to dodge the TTL-expiry dead path below
        -- an independent read confirmed that trips a SEPARATE, equally real
        guard instead: `pending()` (strategy-state-projection.js lines
        88-89) invalidates the LOCAL proposal the instant the canonical
        awaiting record's revision/content no longer matches what was
        captured at `proposePlan()` time, so `applyProposalClassification()`
        then fails closed on `no_pending_proposal` -- never reaching
        doApply()'s own judgmentBinding recheck either, for a different
        legitimate reason. Cutting the target guard under THAT scenario
        still can't make `kept_pending` advance (a different real guard
        blocks it first), so it is not a valid RED for this specific guard.

        Corrected design: go back to `_run_inflight_stale_same_topic`'s
        EXACT original condition (clock 0 -> propose/audible -> same_topic
        resolve -> clock 4000 -> content-IDENTICAL `bump_sequence()` refresh
        (`pending()`'s own revision/record-content check and its 90s
        `expires_at` both stay satisfied -- only the cache's `receivedAt`
        moves) -> clock 5100, past the request-time binding's 5000ms
        deadline) and isolate ONLY the one target delivery item's own
        SPEAK_PRECHECK via `isolate_target_delivery_precheck` (a fixture-
        only override of that single queued item's `.precheck` closure --
        not the drainQueue mechanism, not any other item, not any core
        validBinding/doApply function). That lets this exact item reach
        'spoken'/onSpoken for real, so the REAL, un-mocked
        `strategyProjection.validBinding(judgmentBinding)` recheck inside
        doApply() is what decides the outcome -- GREEN blocks (recheck
        correctly sees its own captured binding past its deadline), RED (the
        binding recheck cut) wrongly lets `kept_pending` land, restored
        GREEN confirms."""
        decision_id = state['proposal']['decision_id']
        fx.send('set_clock', value=0)
        drive_propose_and_audible(fx, state)
        if mutated:
            fx.send('mutate_cut_binding_check')
        start = fx.send('resolve_start', classification='same_topic', decisionId=decision_id)
        await_out = fx.send('resolve_await', requestId=start['requestId'])
        fx.send('set_clock', value=4000)
        fx.send('canonical_receive', snapshot=bump_sequence(state['snapshot']))
        fx.send('set_clock', value=5100)  # past the request-time binding's own 5000ms deadline
        isolate_out = fx.send('isolate_target_delivery_precheck')
        diag_before = fx.send('debug_diag')
        drain_out = fx.send('drain_speak_queue')
        diag_after = fx.send('debug_diag')
        if mutated:
            fx.send('mutate_restore')
        return {
            'wsSentSinceStart': await_out['wsSentSinceStart'] + drain_out['wsSentDuringDrain'],
            'wsSentDuringDrain': drain_out['wsSentDuringDrain'],
            'beforeRevision': await_out['beforeRevision'],
            'afterState': drain_out['state'],
            'isolateOut': isolate_out,
            'newDiag': diag_after['diagLog'][len(diag_before['diagLog']):],
        }

    def test_same_topic_isolated_delivery_item_blocked_by_judgment_binding_recheck(self):
        """GREEN: on the ORIGINAL in-flight TTL-staleness condition (see
        `_run_inflight_stale_same_topic_isolated` docstring), isolating just
        the one target delivery item's own SPEAK_PRECHECK lets it genuinely
        reach 'spoken'/onSpoken (proven directly, not inferred), and the
        real doApply() judgmentBinding recheck genuinely fires and blocks
        the stale same_topic apply."""
        fx = NodeFixture()
        try:
            injected = {}

            def on_ready(state, result):
                if injected.get('done'):
                    return
                injected['done'] = True
                injected['run'] = self._run_inflight_stale_same_topic_isolated(fx, state, mutated=False)

            result, state = run_real_proposal_replay(on_ready)
            self.assertTrue(injected.get('done'))
            run = injected['run']

            # upstream precheck existence (before the local cut): this item
            # really had a real precheck function attached, and was not
            # already finalized/dropped by anything else beforehand.
            self.assertTrue(run['isolateOut']['hadPrecheck'],
                             'the target delivery item must have had a real SPEAK_PRECHECK '
                             'precheck function attached before the local isolation cut it')
            self.assertIsNone(run['isolateOut']['alreadyFinalized'],
                               'the target delivery item must not already be finalized/dropped '
                               'before the isolation -- otherwise onSpoken could never fire '
                               'regardless of the cut')

            # (a) the item genuinely reached 'spoken' (a real 'spoke' wire
            # was sent during THIS drain) -- the isolation only bypassed
            # THIS item's own precheck, proving onSpoken is reachable.
            self.assertTrue(
                any(m.get('cmd') == 'spoke' for m in run['wsSentDuringDrain']),
                'isolated item must actually reach spoken (onSpoken hook reachable)')

            # (b) the downstream guard itself firing: doApply()'s own
            # diagnosticLog branch for a stale judgmentBinding at the moment
            # of apply -- and NOT the upstream SPEAK_PRECHECK fence (proves
            # this is downstream-guard proof specifically, not upstream).
            self.assertTrue(
                any(d['tag'] == 'STRATEGY_STATE'
                    and 'proposal_judgment_stale_binding_at_apply' in d['body']
                    for d in run['newDiag']),
                'GREEN expected: doApply() must actually reach and trip its own '
                'judgmentBinding recheck for this isolated item -- new diag=%r'
                % (run['newDiag'],))
            self.assertFalse(
                any(d['tag'] == 'SPEAK_PRECHECK' for d in run['newDiag']),
                'this item must not be the one discarded by the upstream fence during '
                'this drain -- otherwise this is not proof of the downstream guard '
                'specifically, new diag=%r' % (run['newDiag'],))

            # (c) the same_topic apply was genuinely blocked (not a vacuous
            # pass): the local projection generation stayed put.
            after_pending = run['afterState']['pending_proposal']
            self.assertIsNotNone(after_pending,
                                  'in-flight canonical staleness must still leave the proposal '
                                  'pending (blocked apply), not wipe it out entirely')
            self.assertEqual(state['proposal']['decision_id'], after_pending['decision_id'])
            self.assertEqual(run['beforeRevision'], after_pending['base_revision'],
                              'GREEN expected: the stale same_topic apply must still be blocked')
        finally:
            fx.close()

    def test_mutation_removing_binding_recheck_breaks_isolated_same_topic_guard(self):
        """Route-cut mutation RED -> restored GREEN (AGENTS.md Tunnel
        Completion Rule #6), on the SAME isolated delivery-item scenario as
        the GREEN test above -- proves that test's assertion actually
        depends on doApply()'s own judgmentBinding recheck, not a vacuous
        pass. This is the guardcut/restore pair the parent GO再開 note
        demanded in place of the now-documented-dead
        `test_mutation_cut_binding_recheck_has_no_effect_under_dominant_upstream_ttl_fence`
        above (that one stays as its own, separately-labelled finding about
        the NON-isolated path)."""
        fx_mutated = NodeFixture()
        fx_control = NodeFixture()
        try:
            captured = {}

            def on_ready(state, result):
                if captured.get('done'):
                    return
                captured['done'] = True
                captured['mutated'] = self._run_inflight_stale_same_topic_isolated(
                    fx_mutated, state, mutated=True)

            result, state = run_real_proposal_replay(on_ready)
            self.assertTrue(captured.get('done'))
            mutated_out = captured['mutated']
            mutated_after = mutated_out['afterState']['pending_proposal']
            self.assertIsNotNone(mutated_after, 'mutated run unexpectedly lost the pending proposal entirely')
            self.assertTrue(
                any(m.get('cmd') == 'spoke' for m in mutated_out['wsSentDuringDrain']),
                'the isolation itself (item reaching spoken) must hold under the '
                'mutated run too, otherwise RED is not comparable to GREEN')
            self.assertNotEqual(
                mutated_out['beforeRevision'], mutated_after['base_revision'],
                'RED expected: with the binding re-check cut, the isolated stale '
                'same_topic apply must incorrectly land (if this assertion fails, the '
                'mutation had no effect and the guard is not actually being exercised)')

            captured2 = {}

            def on_ready2(state2, result2):
                if captured2.get('done'):
                    return
                captured2['done'] = True
                captured2['control'] = self._run_inflight_stale_same_topic_isolated(
                    fx_control, state2, mutated=False)

            result2, state2 = run_real_proposal_replay(on_ready2)
            self.assertTrue(captured2.get('done'))
            control_out = captured2['control']
            control_after = control_out['afterState']['pending_proposal']
            self.assertIsNotNone(control_after,
                                  'restored-GREEN control run unexpectedly lost the pending '
                                  'proposal entirely -- this is a valid configuration where '
                                  'it must still exist')
            self.assertEqual(
                control_out['beforeRevision'], control_after['base_revision'],
                'restored GREEN expected: with the real (unmutated) binding re-check, the '
                'same isolated in-flight-stale sequence must still be blocked on a fresh '
                'fixture')
        finally:
            fx_mutated.close()
            fx_control.close()

    def test_unrelated_invalidates_locally_without_cancelling_bridge_canonical_awaiting(self):
        fx = NodeFixture()
        try:
            injected = {}

            def on_ready(state, result):
                if injected.get('done'):
                    return
                injected['done'] = True
                decision_id = state['proposal']['decision_id']
                drive_propose_and_audible(fx, state)
                start = fx.send('resolve_start', classification='unrelated', decisionId=decision_id)
                injected['await_out'] = fx.send('resolve_await', requestId=start['requestId'])

            result, state = run_real_proposal_replay(on_ready)
            self.assertTrue(injected.get('done'))
            decision_id = state['proposal']['decision_id']
            await_out = injected['await_out']
            self.assertEqual(
                [], [m for m in await_out['wsSentSinceStart'] if m['cmd'] == 'strategy_decision_response'],
                'unrelated must never send a decision wire to Bridge')
            self.assertIsNone(await_out['afterState']['pending_proposal'],
                               'unrelated must invalidate the LOCAL pending proposal')

            last_snapshot = last_canonical_snapshot(result)
            self.assertTrue(any(a['decision_id'] == decision_id
                                 for a in last_snapshot['lifecycle']['awaiting']),
                             'Bridge canonical awaiting must NOT be cancelled by a local-only unrelated')
            readback = fx.send('canonical_receive', snapshot=last_snapshot)
            self.assertTrue(any(p['decision_id'] == decision_id for p in readback['state']['pending']),
                             'same VM canonical readback must still show B awaiting, untouched by Bridge')
        finally:
            fx.close()

    # ── WO013 r7独立読取の一括補足 point3 ──────────────────────────────
    # 既存のTTL/staleness検査（_run_inflight_stale_same_topic等）は、実HTTP
    # 往復が**完了した後**の配送待ち窓（onSpokenまでの遅延）しか作れていな
    # かった。ここからの3テストは、`holdGateDir`（tests-wo001-anthropic-
    # stream-stub-preload.jsのファイルベースbarrier）で実HTTPレスポンスその
    # ものを「本当に未完了」の状態に止め、その間に3種類の負例（入力世代変更
    # ／本人scope・epoch変更／awaiting記録のrevision変更）を実production関数
    # だけで発生させ、解放後に届く古いconfirmが0件配送・現在の（新しい）
    # canonical状態を壊さないことを確認する。sender/handler/poll/cacheの
    # authority判定そのものは一切stubしない——stubされるのはAnthropic SDKの
    # 応答タイミングだけ。

    def test_inflight_http_wait_generation_change_blocks_stale_confirm_wire(self):
        fx = NodeFixture()
        gate_dir = tempfile.mkdtemp(prefix='wo013-gate-')
        try:
            injected = {}

            def on_ready(state, result):
                if injected.get('done'):
                    return
                injected['done'] = True
                drive_propose_and_audible(fx, state)
                decision_id = state['proposal']['decision_id']
                start = fx.send('resolve_start', classification='confirm',
                                 decisionId=decision_id, holdGateDir=gate_dir)
                wait_for_gate_arrival(gate_dir)
                # Genuinely mid-flight: the real HTTP response for this
                # confirm has NOT returned yet (held at the stub's file
                # barrier). A second ambiguous driver utterance arrives for
                # the SAME proposal before the first judgment comes back --
                # the exact Codex MD#1 scenario (desktop/renderer.html's
                # callAPI() comment), driven here by the real production
                # markAwaitingJudgment(), not a hand-rolled revision bump.
                mark_out = fx.send('mark_awaiting_judgment')
                injected['bumped_revision'] = mark_out['pending']['base_revision']
                release_gate(gate_dir)
                injected['await_out'] = fx.send('resolve_await', requestId=start['requestId'])

            result, state = run_real_proposal_replay(on_ready)
            self.assertTrue(injected.get('done'))
            decision_id = state['proposal']['decision_id']
            await_out = injected['await_out']
            self.assertEqual(
                [], [m for m in await_out['wsSentSinceStart'] if m['cmd'] == 'strategy_decision_response'],
                'a confirm whose request-time revision was superseded mid-flight (while the '
                'real HTTP response was still genuinely unresolved) by a real '
                'markAwaitingJudgment() must never reach Bridge as a decision wire')
            after_pending = await_out['afterState']['pending_proposal']
            self.assertIsNotNone(after_pending, 'the newer (bumped) pending proposal must still be tracked')
            self.assertEqual(decision_id, after_pending['decision_id'])
            self.assertEqual(injected['bumped_revision'], after_pending['base_revision'],
                              'the stale confirm must not roll back the newer base_revision')
            self.assertTrue(after_pending['awaiting_judgment'],
                             'the newer markAwaitingJudgment()-true state must survive the stale confirm')
            # Bridge-side canonical truth is untouched: no wire was ever
            # sent, so there is nothing for Bridge to have acked either.
            self.assertEqual([], ack_for(result, decision_id))
        finally:
            shutil.rmtree(gate_dir, ignore_errors=True)
            fx.close()

    def test_inflight_http_wait_bridge_reconnect_new_epoch_blocks_stale_confirm_wire(self):
        fx = NodeFixture()
        gate_dir = tempfile.mkdtemp(prefix='wo013-gate-')
        try:
            injected = {}

            def on_ready(state, result):
                if injected.get('done'):
                    return
                injected['done'] = True
                drive_propose_and_audible(fx, state)
                decision_id = state['proposal']['decision_id']
                start = fx.send('resolve_start', classification='confirm',
                                 decisionId=decision_id, holdGateDir=gate_dir)
                wait_for_gate_arrival(gate_dir)
                # Genuinely mid-flight: the Bridge process itself reconnects
                # (a new bridge_process_epoch) while the confirm's real HTTP
                # round trip is still unresolved -- same real
                # beginSocket()/hello()/receive() sequence 'init' uses (see
                # the Node fixture's 'reconnect' command), not a hand-rolled
                # epoch swap or a decider substitution.
                reconnected = relabel_epoch(state['snapshot'],
                                             state['snapshot']['bridge_process_epoch'] + '-RECONNECT')
                injected['reconnect_out'] = fx.send('reconnect', snapshot=reconnected)
                release_gate(gate_dir)
                injected['await_out'] = fx.send('resolve_await', requestId=start['requestId'])

            result, state = run_real_proposal_replay(on_ready)
            self.assertTrue(injected.get('done'))
            decision_id = state['proposal']['decision_id']
            self.assertTrue(injected['reconnect_out']['ok'], injected['reconnect_out'])
            await_out = injected['await_out']
            self.assertEqual(
                [], [m for m in await_out['wsSentSinceStart'] if m['cmd'] == 'strategy_decision_response'],
                'a confirm whose request-time identity (bridge_process_epoch) was superseded '
                'mid-flight by a real reconnect must never reach Bridge as a decision wire')
            readback = fx.send('ensure_state')
            self.assertEqual('A', readback['state']['pit_plan']['plan_id'],
                              'post-reconnect canonical truth (still Plan A active under the new '
                              'epoch) must not be disturbed by the discarded stale confirm')
            self.assertEqual([], ack_for(result, decision_id))
        finally:
            shutil.rmtree(gate_dir, ignore_errors=True)
            fx.close()

    def test_inflight_http_wait_awaiting_record_revision_change_blocks_stale_confirm_wire(self):
        fx = NodeFixture()
        gate_dir = tempfile.mkdtemp(prefix='wo013-gate-')
        try:
            injected = {}

            def on_ready(state, result):
                if injected.get('done'):
                    return
                injected['done'] = True
                drive_propose_and_audible(fx, state)
                decision_id = state['proposal']['decision_id']
                start = fx.send('resolve_start', classification='confirm',
                                 decisionId=decision_id, holdGateDir=gate_dir)
                wait_for_gate_arrival(gate_dir)
                # Genuinely mid-flight: the Bridge recalculates and
                # republishes the SAME awaiting decision_id under a bumped
                # record revision (a real content change, not the content-
                # identical bump_sequence() refresh used elsewhere) while
                # the confirm's real HTTP round trip is still unresolved.
                revised, new_revision = bump_awaiting_revision(state['snapshot'], decision_id)
                injected['new_revision'] = new_revision
                fx.send('canonical_receive', snapshot=revised)
                release_gate(gate_dir)
                injected['await_out'] = fx.send('resolve_await', requestId=start['requestId'])

            result, state = run_real_proposal_replay(on_ready)
            self.assertTrue(injected.get('done'))
            decision_id = state['proposal']['decision_id']
            await_out = injected['await_out']
            self.assertEqual(
                [], [m for m in await_out['wsSentSinceStart'] if m['cmd'] == 'strategy_decision_response'],
                'a confirm whose awaiting record revision was superseded mid-flight by a real '
                'Bridge recalculation must never reach Bridge as a decision wire')
            self.assertIsNone(await_out['afterState']['pending_proposal'],
                               'the locally tracked pending proposal must be invalidated once its '
                               'own canonical record revision moved out from under it (fail closed)')
            readback = fx.send('ensure_state')
            self.assertTrue(
                any(p['decision_id'] == decision_id and p['revision'] == injected['new_revision']
                    for p in readback['state']['pending']),
                'the Bridge-published revision-bumped awaiting record must still be visible, '
                'untouched by the discarded stale confirm')
            self.assertEqual([], ack_for(result, decision_id))
        finally:
            shutil.rmtree(gate_dir, ignore_errors=True)
            fx.close()


if __name__ == '__main__':
    unittest.main()
