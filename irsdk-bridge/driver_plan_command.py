"""Pure WO-006 Driver plan-command envelope and idempotency ledger."""

import json
import types
from dataclasses import dataclass, replace
from typing import Any, Mapping, Optional, Tuple


ALLOWED_INTENTS = ('early_pit', 'amend', 'cancel')


def _canonical_content(command):
    return json.dumps(command, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


@dataclass(frozen=True)
class DriverPlanCommandLedger:
    race_instance_id: Optional[str]
    session_num: Optional[int]
    commands: Mapping[str, str]
    acknowledgements: Mapping[str, Any]
    reasons: Mapping[str, str]

    def __post_init__(self):
        object.__setattr__(self, 'commands', types.MappingProxyType(dict(self.commands)))
        object.__setattr__(self, 'acknowledgements',
                           types.MappingProxyType(dict(self.acknowledgements)))
        object.__setattr__(self, 'reasons', types.MappingProxyType(dict(self.reasons)))


def new_ledger(race_instance_id=None, session_num=None):
    return DriverPlanCommandLedger(race_instance_id, session_num, {}, {}, {})


def ensure_scope(ledger, race_instance_id, session_num):
    if (ledger.race_instance_id == race_instance_id
            and ledger.session_num == session_num):
        return ledger
    return new_ledger(race_instance_id, session_num)


def validate_envelope(command):
    """Return ``(normalized, None)`` or ``(None, diagnostic)``."""
    if not isinstance(command, dict):
        return None, 'invalid_envelope'
    required_strings = ('command_id', 'intent', 'race_instance_id',
                        'expected_decision_id')
    for field in required_strings:
        if not isinstance(command.get(field), str) or not command[field]:
            return None, 'missing_' + field
    if command['intent'] not in ALLOWED_INTENTS:
        return None, 'invalid_intent'
    for field in ('session_num', 'expected_revision',
                  'expected_activation_source_frame_sequence',
                  'source_frame_sequence', 'driver_pit_sequence'):
        if not isinstance(command.get(field), int) or isinstance(command.get(field), bool):
            return None, 'missing_' + field
    target = command.get('requested_target_lap')
    if command['intent'] == 'amend' and (
            not isinstance(target, int) or isinstance(target, bool)):
        return None, 'missing_requested_target_lap'
    normalized = {
        'command_id': command['command_id'], 'intent': command['intent'],
        'text': str(command.get('text') or ''),
        'reason_text': (str(command['reason_text'])
                        if command.get('reason_text') is not None else None),
        'race_instance_id': command['race_instance_id'],
        'session_num': command['session_num'],
        'expected_decision_id': command['expected_decision_id'],
        'expected_revision': command['expected_revision'],
        'expected_activation_source_frame_sequence':
            command['expected_activation_source_frame_sequence'],
        'source_frame_sequence': command['source_frame_sequence'],
        'driver_pit_sequence': command['driver_pit_sequence'],
        'requested_target_lap': target,
        'utterance_id': (str(command['utterance_id'])
                         if command.get('utterance_id') is not None else None),
    }
    for field in ('bridge_process_epoch','canonical_snapshot_id','canonical_snapshot_sequence'):
        if field in command:normalized[field]=command[field]
    return normalized, None


def classify_delivery(ledger, command):
    """Classify first delivery / retry / collision without mutating ledger."""
    normalized, error = validate_envelope(command)
    if error:
        return None, error, None
    command_id = normalized['command_id']
    content = _canonical_content(normalized)
    previous = ledger.commands.get(command_id)
    if previous is None:
        return normalized, 'new', content
    if previous == content:
        return normalized, 'retry', content
    return normalized, 'collision', content


def record_ack(ledger, normalized, content, acknowledgement):
    commands = dict(ledger.commands)
    acknowledgements = dict(ledger.acknowledgements)
    commands[normalized['command_id']] = content
    acknowledgements[normalized['command_id']] = dict(acknowledgement)
    return replace(ledger, commands=commands, acknowledgements=acknowledgements)


def prior_ack(ledger, command_id):
    value = ledger.acknowledgements.get(command_id)
    return dict(value) if isinstance(value, Mapping) else None


def link_reason(ledger, *, command_id, race_instance_id, session_num,
                decision_id, expected_revision, reason_event_id, reason_text):
    """Attach one immutable evidence event to a successful command.

    ``reasons`` is keyed by command id because the WO-006 contract permits one
    immediate explanatory turn.  The stored event id/content makes transport
    retry idempotent and prevents a later utterance from replacing that turn.
    """
    ack = ledger.acknowledgements.get(command_id)
    if not isinstance(ack, Mapping):
        return ledger, 'no_matching_command'
    if ack.get('outcome') != 'applied':
        return ledger, 'command_not_applied'
    if (ack.get('race_instance_id') != race_instance_id
            or ack.get('session_num') != session_num
            or ack.get('decision_id') != decision_id
            or ack.get('expected_revision') != expected_revision):
        return ledger, 'scope_mismatch'
    if not isinstance(reason_event_id, str) or not reason_event_id:
        return ledger, 'missing_reason_event_id'
    if not isinstance(reason_text, str) or not reason_text.strip():
        return ledger, 'missing_reason_text'
    event = {
        'reason_event_id': reason_event_id,
        'command_id': command_id,
        'race_instance_id': race_instance_id,
        'session_num': session_num,
        'decision_id': decision_id,
        'expected_revision': expected_revision,
        'reason_text': reason_text.strip(),
    }
    content = _canonical_content(event)
    previous = ledger.reasons.get(command_id)
    if isinstance(previous, Mapping):
        if previous.get('reason_event_id') != reason_event_id:
            return ledger, 'reason_already_linked'
        if previous.get('content') == content:
            return ledger, 'retry_no_op'
        return ledger, 'collision'
    reasons = dict(ledger.reasons)
    reasons[command_id] = {'reason_event_id': reason_event_id,
                           'content': content, 'reason_text': reason_text.strip()}
    return replace(ledger, reasons=reasons), 'linked'
