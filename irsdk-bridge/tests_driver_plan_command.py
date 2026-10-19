import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import driver_plan_command as dpc
import plan_lifecycle as lifecycle


def state_with_active_and_awaiting():
    state = lifecycle.new_race_strategy_state('race-1', 0)
    state, _ = lifecycle.register_plan(
        state, decision_id='A-1', race_instance_id='race-1', session_num=0,
        selected_plan='A', phase='active', current_driver_pit_sequence=3,
        created_source_frame_sequence=10, activation_source_frame_sequence=12,
        target_lap=25)
    state, _ = lifecycle.register_plan(
        state, decision_id='B-1', race_instance_id='race-1', session_num=0,
        selected_plan='B', phase='awaiting_driver', current_driver_pit_sequence=3,
        created_source_frame_sequence=15, target_lap=23)
    return state


def intent(operation='early_pit', **overrides):
    values = dict(command_id='cmd-1', operation=operation, race_instance_id='race-1',
                  session_num=0, target_decision_id='A-1', expected_revision=0,
                  expected_activation_source_frame_sequence=12,
                  received_source_frame_sequence=20, driver_pit_sequence=3,
                  utterance_id='utt-1', requested_target_lap=None, reason_text=None)
    values.update(overrides)
    return lifecycle.DriverPlanIntent(**values)


class LifecycleAtomicTests(unittest.TestCase):
    def test_early_invalidates_active_and_cancels_awaiting_atomically(self):
        before = state_with_active_and_awaiting()
        after, outcome = lifecycle.apply_driver_plan_intent(before, intent())
        self.assertEqual('applied', outcome.status)
        self.assertEqual('invalidated', after.plan_records['A-1'].phase)
        self.assertEqual('driver_early_pit_declared', after.plan_records['A-1'].invalidated_reason)
        self.assertEqual('cancelled', after.plan_records['B-1'].phase)
        self.assertEqual('superseded_by_driver_intent', after.plan_records['B-1'].invalidated_reason)
        self.assertIsNone(after.active_plan_id)
        self.assertEqual('active', before.plan_records['A-1'].phase)
        self.assertNotIn('executed', [h.phase for h in after.history])

    def test_cancel_and_amend_have_distinct_terminal_reason(self):
        for operation, phase, reason in (
                ('cancel', 'cancelled', 'driver_cancel'),
                ('amend', 'invalidated', 'driver_plan_amended')):
            after, outcome = lifecycle.apply_driver_plan_intent(
                state_with_active_and_awaiting(), intent(operation))
            self.assertEqual('applied', outcome.status)
            self.assertEqual(phase, after.plan_records['A-1'].phase)
            self.assertEqual(reason, after.plan_records['A-1'].invalidated_reason)

    def test_stale_inputs_are_total_no_op(self):
        for changed in (
                {'target_decision_id': 'old'}, {'expected_revision': 9},
                {'expected_activation_source_frame_sequence': 11},
                {'driver_pit_sequence': 2}, {'received_source_frame_sequence': 9},
                {'race_instance_id': 'race-2'}):
            before = state_with_active_and_awaiting()
            after, outcome = lifecycle.apply_driver_plan_intent(before, intent(**changed))
            self.assertNotEqual('applied', outcome.status)
            self.assertEqual('active', after.plan_records['A-1'].phase)
            self.assertEqual('awaiting_driver', after.plan_records['B-1'].phase)
            self.assertEqual(before.history, after.history)


class LedgerTests(unittest.TestCase):
    def command(self, **overrides):
        value = dict(command_id='cmd-1', intent='early_pit', text='ピット入るぞ',
                     reason_text=None, race_instance_id='race-1', session_num=0,
                     expected_decision_id='A-1', expected_revision=0,
                     expected_activation_source_frame_sequence=12,
                     source_frame_sequence=20, driver_pit_sequence=3,
                     requested_target_lap=None, utterance_id='utt-1')
        value.update(overrides)
        return value

    def test_same_content_retry_and_collision(self):
        ledger = dpc.new_ledger('race-1', 0)
        normalized, status, content = dpc.classify_delivery(ledger, self.command())
        self.assertEqual('new', status)
        ack = {'command_id': 'cmd-1', 'outcome': 'applied'}
        ledger = dpc.record_ack(ledger, normalized, content, ack)
        self.assertEqual('retry', dpc.classify_delivery(ledger, self.command())[1])
        self.assertEqual('collision', dpc.classify_delivery(
            ledger, self.command(expected_revision=1))[1])

    def test_reason_links_only_same_command_scope_and_does_not_change_ack(self):
        ledger = dpc.new_ledger('race-1', 0)
        normalized, _, content = dpc.classify_delivery(ledger, self.command())
        ack = {'command_id': 'cmd-1', 'race_instance_id': 'race-1',
               'session_num': 0, 'decision_id': 'A-1',
               'expected_revision': 0, 'outcome': 'applied'}
        ledger = dpc.record_ack(ledger, normalized, content, ack)
        linked, outcome = dpc.link_reason(
            ledger, command_id='cmd-1', race_instance_id='race-1', session_num=0,
            decision_id='A-1', expected_revision=0, reason_event_id='reason-1',
            reason_text='前が遅いから')
        self.assertEqual('linked', outcome)
        self.assertEqual('前が遅いから', linked.reasons['cmd-1']['reason_text'])
        self.assertEqual('applied', linked.acknowledgements['cmd-1']['outcome'])
        retry, outcome = dpc.link_reason(
            linked, command_id='cmd-1', race_instance_id='race-1', session_num=0,
            decision_id='A-1', expected_revision=0, reason_event_id='reason-1',
            reason_text='前が遅いから')
        self.assertEqual('retry_no_op', outcome)
        self.assertEqual(linked.reasons, retry.reasons)
        unchanged, outcome = dpc.link_reason(
            linked, command_id='cmd-1', race_instance_id='race-2', session_num=0,
            decision_id='A-1', expected_revision=0, reason_event_id='reason-2',
            reason_text='penalty 黒旗')
        self.assertEqual('scope_mismatch', outcome)
        self.assertEqual(linked.reasons, unchanged.reasons)

    def test_reason_rejects_unsuccessful_prior_collision_and_overwrite(self):
        for prior_outcome in ('rejected', 'stale', 'collision', 'no_active_plan'):
            ledger = dpc.new_ledger('race-1', 0)
            normalized, _, content = dpc.classify_delivery(ledger, self.command())
            ledger = dpc.record_ack(ledger, normalized, content, {
                'command_id': 'cmd-1', 'race_instance_id': 'race-1',
                'session_num': 0, 'decision_id': 'A-1',
                'expected_revision': 0, 'outcome': prior_outcome})
            unchanged, outcome = dpc.link_reason(
                ledger, command_id='cmd-1', race_instance_id='race-1', session_num=0,
                decision_id='A-1', expected_revision=0, reason_event_id='reason-1',
                reason_text='traffic')
            self.assertEqual('command_not_applied', outcome)
            self.assertEqual({}, dict(unchanged.reasons))

        ledger = dpc.new_ledger('race-1', 0)
        normalized, _, content = dpc.classify_delivery(ledger, self.command())
        ledger = dpc.record_ack(ledger, normalized, content, {
            'command_id': 'cmd-1', 'race_instance_id': 'race-1',
            'session_num': 0, 'decision_id': 'A-1',
            'expected_revision': 0, 'outcome': 'applied'})
        first, outcome = dpc.link_reason(
            ledger, command_id='cmd-1', race_instance_id='race-1', session_num=0,
            decision_id='A-1', expected_revision=0, reason_event_id='reason-1',
            reason_text='traffic')
        self.assertEqual('linked', outcome)
        collision, outcome = dpc.link_reason(
            first, command_id='cmd-1', race_instance_id='race-1', session_num=0,
            decision_id='A-1', expected_revision=0, reason_event_id='reason-1',
            reason_text='fuel')
        self.assertEqual('collision', outcome)
        self.assertEqual(first.reasons, collision.reasons)
        later, outcome = dpc.link_reason(
            first, command_id='cmd-1', race_instance_id='race-1', session_num=0,
            decision_id='A-1', expected_revision=0, reason_event_id='reason-2',
            reason_text='fuel')
        self.assertEqual('reason_already_linked', outcome)
        self.assertEqual('traffic', later.reasons['cmd-1']['reason_text'])


if __name__ == '__main__':
    unittest.main()
