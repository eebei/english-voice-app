#!/usr/bin/env python3
"""WO-006 real poll-loop transport replay (no helper-only completion proof)."""

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bridge
import replay_harness as rh
import tests_wo001_road_atlanta_fixture as road
import tests_bridge_plan_lifecycle_wiring as bc
import plan_lifecycle as pl
import driver_plan_command as dpc


class ProductionConsumerNegativeTests(unittest.TestCase):
    def state(self):
        state = pl.new_race_strategy_state('race-x', 2)
        state, _ = pl.register_plan(
            state, decision_id='active-x', race_instance_id='race-x', session_num=2,
            selected_plan='A', phase='active', current_driver_pit_sequence=4,
            created_source_frame_sequence=90, activation_source_frame_sequence=100,
            target_lap=30)
        return state

    def command(self, **changes):
        value = {'command_id': 'negative-1', 'intent': 'early_pit', 'text': 'ピット入るぞ',
                 'reason_text': None, 'race_instance_id': 'race-x', 'session_num': 2,
                 'expected_decision_id': 'active-x', 'expected_revision': 0,
                 'expected_activation_source_frame_sequence': 100,
                 'source_frame_sequence': 110, 'driver_pit_sequence': 4,
                 'requested_target_lap': None, 'utterance_id': 'u-x'}
        value.update(changes)
        return value

    def apply(self, command, state=None):
        state = self.state() if state is None else state
        return bridge.apply_driver_plan_command(
            state, dpc.new_ledger('race-x', 2), command,
            race_facts_snapshot={'race_instance_id': 'race-x', 'session_num': 2,
                                 'source_frame': {'sequence': 120},
                                 'driver_pit_sequence': 4},
            current_lap=20, laps_total=40)

    def test_wrong_scope_decision_revision_activation_frame_pit_sequence_fail_closed(self):
        cases = ({'race_instance_id': 'old-race'}, {'session_num': 1},
                 {'expected_decision_id': 'old-plan'}, {'expected_revision': 9},
                 {'expected_activation_source_frame_sequence': 99},
                 {'driver_pit_sequence': 3}, {'source_frame_sequence': 999})
        for change in cases:
            with self.subTest(change=change):
                before = self.state()
                after, _ledger, ack, recalc = self.apply(self.command(**change), before)
                self.assertNotEqual('applied', ack['outcome'])
                self.assertEqual('active', after.plan_records['active-x'].phase)
                self.assertFalse(recalc)

    def test_no_active_and_terminal_target_are_not_applied(self):
        empty = pl.new_race_strategy_state('race-x', 2)
        after, _ledger, ack, recalc = self.apply(self.command(), empty)
        self.assertEqual('no_active_plan', ack['outcome'])
        self.assertIsNone(after.active_plan_id)
        self.assertFalse(recalc)

    def test_amend_requires_future_in_race_integer(self):
        for target in (None, 20, 41):
            command = self.command(command_id='amend-%s' % target,
                                   intent='amend', requested_target_lap=target)
            _state, _ledger, ack, recalc = self.apply(command)
            self.assertEqual('rejected', ack['outcome'])
            self.assertFalse(recalc)

    def test_valid_amend_is_explicitly_rejected_until_authority_consumes_constraint(self):
        before = self.state()
        after, _ledger, ack, recalc = self.apply(self.command(
            command_id='amend-valid', intent='amend', requested_target_lap=23), before)
        self.assertEqual('rejected', ack['outcome'])
        self.assertEqual('amend_constraint_not_supported', ack['reason'])
        self.assertEqual('active', after.plan_records['active-x'].phase)
        self.assertEqual('active-x', after.active_plan_id)
        self.assertFalse(recalc)

    def test_cancel_uses_cancelled_phase_and_one_recalculation_request(self):
        state, _ledger, ack, recalc = self.apply(
            self.command(command_id='cancel-1', intent='cancel'))
        self.assertEqual('applied', ack['outcome'])
        self.assertEqual('cancelled', state.plan_records['active-x'].phase)
        self.assertTrue(recalc)

    def test_reason_production_consumer_is_success_only_immutable_and_idempotent(self):
        state = self.state()
        ledger = dpc.new_ledger('race-x', 2)
        # A reason arriving before its command has no target.
        reason = {'_reason_only': True, 'command_id': 'reason-main',
                  'reason_event_id': 'reason-event-1', 'race_instance_id': 'race-x',
                  'session_num': 2, 'expected_decision_id': 'active-x',
                  'expected_revision': 0, 'reason_text': 'traffic'}
        state, ledger, ack, _ = bridge.apply_driver_plan_command(
            state, ledger, reason,
            race_facts_snapshot={'race_instance_id': 'race-x', 'session_num': 2})
        self.assertEqual('no_matching_command', ack['outcome'])

        rejected = self.command(command_id='rejected-main', intent='amend',
                                requested_target_lap=23)
        _state, rejected_ledger, ack, _ = bridge.apply_driver_plan_command(
            state, dpc.new_ledger('race-x', 2), rejected,
            race_facts_snapshot={'race_instance_id': 'race-x', 'session_num': 2,
                                 'source_frame': {'sequence': 120}},
            current_lap=20, laps_total=40)
        self.assertEqual('rejected', ack['outcome'])
        rejected_reason = dict(reason, command_id='rejected-main')
        _state, rejected_ledger, ack, _ = bridge.apply_driver_plan_command(
            state, rejected_ledger, rejected_reason,
            race_facts_snapshot={'race_instance_id': 'race-x', 'session_num': 2})
        self.assertEqual('command_not_applied', ack['outcome'])
        self.assertEqual({}, dict(rejected_ledger.reasons))

        command = self.command(command_id='reason-main')
        state, ledger, ack, _ = bridge.apply_driver_plan_command(
            state, ledger, command,
            race_facts_snapshot={'race_instance_id': 'race-x', 'session_num': 2,
                                 'source_frame': {'sequence': 120}},
            current_lap=20, laps_total=40)
        self.assertEqual('applied', ack['outcome'])
        state, ledger, ack, _ = bridge.apply_driver_plan_command(
            state, ledger, reason,
            race_facts_snapshot={'race_instance_id': 'race-x', 'session_num': 2})
        self.assertEqual('linked', ack['outcome'])
        _state, same, ack, _ = bridge.apply_driver_plan_command(
            state, ledger, reason,
            race_facts_snapshot={'race_instance_id': 'race-x', 'session_num': 2})
        self.assertEqual('retry_no_op', ack['outcome'])
        self.assertEqual(ledger.reasons, same.reasons)
        changed = dict(reason, reason_text='fuel')
        _state, collision, ack, _ = bridge.apply_driver_plan_command(
            state, ledger, changed,
            race_facts_snapshot={'race_instance_id': 'race-x', 'session_num': 2})
        self.assertEqual('collision', ack['outcome'])
        self.assertEqual(ledger.reasons, collision.reasons)
        later = dict(reason, reason_event_id='reason-event-2', reason_text='fuel')
        _state, unchanged, ack, _ = bridge.apply_driver_plan_command(
            state, ledger, later,
            race_facts_snapshot={'race_instance_id': 'race-x', 'session_num': 2})
        self.assertEqual('reason_already_linked', ack['outcome'])
        self.assertEqual('traffic', unchanged.reasons['reason-main']['reason_text'])


class ZAmendFailClosedFullPollReplay(unittest.TestCase):
    def test_valid_target_is_not_lost_or_falsely_applied_in_real_poll(self):
        frames, _ = road.build_red_thread_frames()
        last = frames[-1]
        for i in range(4):
            frames.append(rh.make_frame(
                SessionTime=float(last.get('SessionTime', 900)) + i + 1,
                Lap=last.get('Lap', 24), FuelLevel=last.get('FuelLevel', 20.0),
                SessionLapsTotal=road.LAPS_TOTAL,
                SessionLapsRemain=max(0, road.LAPS_TOTAL - int(last.get('Lap', 24)))))
        bridge._pending_driver_plan_commands = []
        captured = {}

        def hook(_cursor, _frame, result):
            if captured.get('sent'):
                return
            live = [b for b in result.broadcasts if b.get('type') == 'telemetry_live'
                    and b.get('active_plan_decision_id')]
            if not live:
                return
            t = live[-1]
            captured.update(sent=True, decision=t['active_plan_decision_id'])
            bridge._queue_driver_plan_command({
                **{k:t[k] for k in ('bridge_process_epoch','canonical_snapshot_id','canonical_snapshot_sequence')},
                'cmd': 'driver_plan_command', 'command_id': 'amend-poll-r1',
                'intent': 'amend', 'text': 'ピットを25周目に変更', 'reason_text': None,
                'race_instance_id': t['race_instance_id'], 'session_num': t['session_num'],
                'expected_decision_id': t['active_plan_decision_id'],
                'expected_revision': t['active_plan_revision'],
                'expected_activation_source_frame_sequence':
                    t['active_plan_activated_source_frame_sequence'],
                'source_frame_sequence': t['source_frame_sequence'],
                'driver_pit_sequence': t['driver_pit_sequence'],
                'requested_target_lap': 25, 'utterance_id': 'amend-r1'})

        result = rh.replay(frames, session_info=road.ROAD_ATLANTA_SESSION_INFO,
                           on_frame_ready=hook)
        acks = [b for b in result.broadcasts
                if b.get('type') == 'driver_plan_command_ack'
                and b.get('command_id') == 'amend-poll-r1']
        self.assertEqual(1, len(acks), acks)
        self.assertEqual('rejected', acks[0]['outcome'])
        self.assertEqual('cannot_reach_requested_target', acks[0]['reason'])
        self.assertIsNone(acks[0]['result_revision'])
        self.assertEqual([], result.logs_containing(
            'DRIVER PLAN COMMAND outcome=applied command_id=amend-poll-r1'))
        later = [b for b in result.broadcasts if b.get('type') == 'telemetry_live']
        self.assertTrue(any(b.get('active_plan_decision_id') == captured['decision']
                            for b in later))


class DriverPlanCommandFullPollReplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        frames, _ = road.build_red_thread_frames()
        # Quiet tail guarantees duplicate/collision/reason inputs are consumed
        # after the first matching ACK.
        last = frames[-1]
        for i in range(12):
            frames.append(rh.make_frame(
                SessionTime=float(last.get('SessionTime', 900)) + i + 1,
                Lap=last.get('Lap', 24), FuelLevel=last.get('FuelLevel', 20.0),
                SessionLapsTotal=road.LAPS_TOTAL,
                SessionLapsRemain=max(0, road.LAPS_TOTAL - int(last.get('Lap', 24)))))
        bridge._pending_driver_plan_commands = []
        cls.injection = {'sent': False, 'retry': False, 'collision': False,
                         'reason': False, 'envelope': None}

        def on_frame_ready(cursor, frame, result):
            state = cls.injection
            telemetry = [b for b in result.broadcasts
                         if b.get('type') == 'telemetry_live'
                         and b.get('active_plan_decision_id')]
            if not state['sent'] and telemetry:
                live = telemetry[-1]
                env = {
                    'cmd': 'driver_plan_command', 'command_id': 'wo006-replay-command-1',
                    'intent': 'early_pit', 'text': 'ピット入るぞ', 'reason_text': None,
                    'race_instance_id': live['race_instance_id'],
                    'session_num': live['session_num'],
                    'expected_decision_id': live['active_plan_decision_id'],
                    'expected_revision': live['active_plan_revision'],
                    'expected_activation_source_frame_sequence':
                        live['active_plan_activated_source_frame_sequence'],
                    'source_frame_sequence': live['source_frame_sequence'],
                    'driver_pit_sequence': live['driver_pit_sequence'],
                    'requested_target_lap': None, 'utterance_id': 'e03'}
                env.update({k:live[k] for k in ('bridge_process_epoch','canonical_snapshot_id','canonical_snapshot_sequence')})
                bridge._queue_driver_plan_command(env)
                state['envelope'] = env
                state['sent'] = True
                return
            acks = [b for b in result.broadcasts
                    if b.get('type') == 'driver_plan_command_ack'
                    and b.get('command_id') == 'wo006-replay-command-1']
            if state['sent'] and not state['retry'] and any(
                    a.get('outcome') == 'applied' for a in acks):
                bridge._queue_driver_plan_command(dict(state['envelope']))
                state['retry'] = True
                return
            if state['retry'] and not state['collision'] and any(
                    a.get('outcome') == 'retry_no_op' for a in acks):
                collision = dict(state['envelope'])
                collision['text'] = 'different content'
                bridge._queue_driver_plan_command(collision)
                state['collision'] = True
                return
            if state['collision'] and not state['reason'] and any(
                    a.get('outcome') == 'collision' for a in acks):
                bridge._queue_driver_plan_command({
                    'cmd': 'driver_plan_reason', '_reason_only': True,
                    **{k:state['envelope'][k] for k in ('bridge_process_epoch','canonical_snapshot_id','canonical_snapshot_sequence')},
                    'reason_event_id': 'wo006-reason-event-1',
                    'command_id': 'wo006-replay-command-1',
                    'race_instance_id': state['envelope']['race_instance_id'],
                    'session_num': state['envelope']['session_num'],
                    'expected_decision_id': state['envelope']['expected_decision_id'],
                    'expected_revision': state['envelope']['expected_revision'],
                    'reason_text': '前の25が遅いから先に入る。penalty 黒旗'})
                state['reason'] = True

        cls.result = rh.replay(
            frames, session_info=road.ROAD_ATLANTA_SESSION_INFO,
            on_frame_ready=on_frame_ready)

    def acks(self):
        return [b for b in self.result.broadcasts
                if b.get('type') == 'driver_plan_command_ack'
                and b.get('command_id') == 'wo006-replay-command-1']

    def test_real_poll_applies_once_then_retry_and_collision_fail_closed(self):
        outcomes = [a.get('outcome') for a in self.acks()]
        self.assertIn('applied', outcomes)
        self.assertIn('retry_no_op', outcomes)
        self.assertIn('collision', outcomes)
        transitions = self.result.logs_containing('DRIVER PLAN COMMAND outcome=applied')
        self.assertEqual(1, len(transitions), transitions)

    def test_ack_carries_same_race_decision_revision_and_terminal_not_executed(self):
        applied = next(a for a in self.acks() if a.get('outcome') == 'applied')
        env = self.injection['envelope']
        self.assertEqual(env['race_instance_id'], applied['race_instance_id'])
        self.assertEqual(env['expected_decision_id'], applied['decision_id'])
        self.assertEqual(env['expected_revision'], applied['expected_revision'])
        self.assertEqual('invalidated', applied['lifecycle_phase'])
        self.assertEqual('driver_early_pit_declared', applied['reason'])
        self.assertNotEqual('executed', applied['lifecycle_phase'])

    def test_old_plan_box_call_is_zero_after_driver_command(self):
        target = self.injection['envelope']['expected_decision_id']
        calls = [b for b in self.result.by_trigger('strategy_plan_box_call')
                 if b.get('decision_id') == target]
        self.assertEqual([], calls)

    def test_old_projection_cannot_reappear_after_ack(self):
        applied_index = next(i for i, b in enumerate(self.result.broadcasts)
                             if b.get('type') == 'driver_plan_command_ack'
                             and b.get('outcome') == 'applied')
        later = [b for b in self.result.broadcasts[applied_index + 1:]
                 if b.get('type') == 'telemetry_live']
        self.assertTrue(later)
        old = self.injection['envelope']['expected_decision_id']
        self.assertNotEqual(old, later[0].get('active_plan_decision_id'))

    def test_reason_links_after_ack_without_second_plan_revision(self):
        reason_acks = [a for a in self.acks() if a.get('intent') == 'reason']
        self.assertEqual(1, len(reason_acks), reason_acks)
        self.assertEqual('linked', reason_acks[0]['outcome'])
        applied = next(a for a in self.acks() if a.get('outcome') == 'applied')
        self.assertIsNone(reason_acks[0]['result_revision'])
        self.assertEqual(1, applied['result_revision'])
        # Reason words do not become penalty/black-flag authority.
        self.assertNotIn('penalty', str(reason_acks[0].get('reason')))
        self.assertNotIn('black', str(reason_acks[0].get('reason')))


class AwaitingProposalKilledInRealPollReplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Synthetic prediction-output positive for transport coverage; real
        # same-horizon forecasting correctly retains A in its own tests.
        from tests_strategy_position_comparison import synthetic_positive_b_forecast,assert_synthetic_b_targets
        frames = bc._plan_bc_accept_clean_laps(8,start_fuel=26.)
        for frame in frames:
            frame['SessionLapsTotal']=28
            frame['SessionLapsRemain']=28-frame['Lap']
        hold, _ = bc._plan_bc_accept_hold_frames(12, lap=9, fuel=10.0, start_time=132.0)
        for frame in hold:
            frame['SessionLapsTotal']=28
            frame['SessionLapsRemain']=28-frame['Lap']
        info=bc.PLAN_BC_ACCEPT_SESSION_INFO.replace('SessionLaps: %s' % bc.PLAN_BC_ACCEPT_LAPS_TOTAL,'SessionLaps: 28')
        forecast_evidence=[]
        frames += hold
        bridge._pending_driver_plan_commands = []
        bridge._pending_strategy_decision_responses = []
        bridge._pending_strategy_delivery_reports = []
        cls.captured = {}

        def hook(cursor, frame, result):
            if cls.captured.get('sent'):
                return
            proposals = result.by_trigger('strategy_plan_proposal')
            live = [b for b in result.broadcasts
                    if b.get('type') == 'telemetry_live'
                    and b.get('active_plan_decision_id')]
            if not proposals or not live:
                return
            proposal, telem = proposals[-1], live[-1]
            cls.captured.update(sent=True, proposal=proposal, active=telem)
            bridge._queue_driver_plan_command({
                **{k:telem[k] for k in ('bridge_process_epoch','canonical_snapshot_id','canonical_snapshot_sequence')},
                'cmd': 'driver_plan_command', 'command_id': 'wo006-kill-awaiting',
                'intent': 'early_pit', 'text': 'ピット入るぞ', 'reason_text': None,
                'race_instance_id': telem['race_instance_id'],
                'session_num': telem['session_num'],
                'expected_decision_id': telem['active_plan_decision_id'],
                'expected_revision': telem['active_plan_revision'],
                'expected_activation_source_frame_sequence':
                    telem['active_plan_activated_source_frame_sequence'],
                'source_frame_sequence': telem['source_frame_sequence'],
                'driver_pit_sequence': telem['driver_pit_sequence'],
                'requested_target_lap': None, 'utterance_id': 'e03-bc'})
            # Real websocket queue functions: delayed audible+yes arrive in
            # the same frame after the canonical Driver command.
            bridge._queue_strategy_delivery_report(
                proposal['decision_id'], 'audible',
                session_num=bc.PLAN_BC_ACCEPT_SESSION_NUM,
                dispatch_id=proposal['dispatch_id'])
            bridge._queue_strategy_decision_response(
                proposal['decision_id'], True,
                session_num=bc.PLAN_BC_ACCEPT_SESSION_NUM,
                dispatch_id=proposal['dispatch_id'])

        # The production calibrator appends observations to its configured
        # file.  Never point this replay at the repository seed itself: doing
        # so makes repeated test runs alter later Plan-B selection.
        with open(bc.PLAN_BC_CALIBRATION_FIXTURE, encoding='utf-8') as fh:
            seed = json.load(fh)
        for record in seed.get('conditions', {}).values():
            record['pit_samples'] = list(record.get('pit_samples') or [])[:3]
            record['normal_samples'] = list(record.get('normal_samples') or [])[:3]
            record['forecast_outcomes'] = []
        with tempfile.TemporaryDirectory(prefix='wo006-plan-bc-') as tmp:
            fixture = os.path.join(tmp, 'pit_loss_calibration.json')
            with open(fixture, 'w', encoding='utf-8') as fh:
                json.dump(seed, fh)
            original = bridge.PIT_LOSS_PATH
            bridge.PIT_LOSS_PATH = fixture
            try:
                with synthetic_positive_b_forecast(evidence=forecast_evidence):
                    cls.result = rh.replay(frames,session_info=info,on_frame_ready=hook)
                cls.synthetic_checked_targets=assert_synthetic_b_targets(cls.result.broadcasts,forecast_evidence)
            finally:
                bridge.PIT_LOSS_PATH = original

    def test_command_applies_and_old_proposal_transport_becomes_no_match_or_stale(self):
        self.assertTrue(self.captured.get('sent'))
        command_acks = [b for b in self.result.broadcasts
                        if b.get('type') == 'driver_plan_command_ack'
                        and b.get('command_id') == 'wo006-kill-awaiting']
        self.assertEqual('applied', command_acks[0]['outcome'])
        proposal = self.captured['proposal']
        delayed = [b for b in self.result.broadcasts
                   if b.get('type') == 'strategy_decision_ack'
                   and b.get('decision_id') == proposal['decision_id']
                   and b.get('dispatch_id') == proposal['dispatch_id']]
        self.assertEqual(1, len(delayed), delayed)
        self.assertIn(delayed[0]['outcome'], ('no_match', 'stale'))
        self.assertEqual([], self.result.logs_containing('PLAN LIFECYCLE ACCEPT REPLACED:'))

    def test_old_active_and_awaiting_never_box_or_reactivate(self):
        old_active = self.captured['active']['active_plan_decision_id']
        old_awaiting = self.captured['proposal']['decision_id']
        calls = self.result.by_trigger('strategy_plan_box_call')
        self.assertFalse(any(c.get('decision_id') in (old_active, old_awaiting) for c in calls), calls)
        after = [b for b in self.result.broadcasts
                 if b.get('type') == 'telemetry_live']
        self.assertFalse(any(b.get('active_plan_decision_id') == old_awaiting for b in after))


if __name__ == '__main__':
    unittest.main()
