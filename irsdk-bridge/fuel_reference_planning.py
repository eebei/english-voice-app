"""Provisional personal-history proposals; Bridge owns all live calculations.

History is dated reference evidence, never a fabricated current clean sample.
Only explicitly registered provisional_history_v1 records use this contract.
"""
import hashlib
import json
import math
import re
from collections.abc import Mapping
from datetime import datetime

CONTRACT = 'provisional_history_v1'
RESERVE_L = 2.0


def finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def integer(v):
    return isinstance(v, int) and not isinstance(v, bool)


def norm(v):
    return re.sub(r'[^a-z0-9]', '', str(v or '').lower())


def track_key(v):
    value = re.sub(r'[^a-z0-9]+', ' ', str(v or '').strip().lower()).strip()
    if value in ('autodromo nazionale monza', 'monza grand prix', 'monza full'):
        return 'monza:gp'
    if value in ('red bull ring', 'red bull ring gp', 'spielberg', 'spielberg gp'):
        return 'spielberg:gp'
    return value


def personal_evidence(records, identity, now_unix):
    if not isinstance(records, list) or not 0 < len(records) <= 500:
        return None
    rows = {}
    for row in records:
        if not isinstance(row, dict) or row.get('deleted') or row.get('disputed') or row.get('unverified_owner'):
            continue
        if (str(row.get('custId', row.get('cust_id'))) != str(identity.get('cust_id'))
                or norm(row.get('car') or row.get('carClass')) != norm(identity.get('car_model'))
                or track_key(row.get('track')) not in (track_key(identity.get('track')),track_key(identity.get('track_raw')))):
            continue
        try:
            dated = datetime.fromisoformat(str(row.get('recordedAt') or row.get('date')).replace('Z', '+00:00')).timestamp()
        except (ValueError, TypeError, OverflowError):
            continue
        rate, pace = row.get('avgFuelPerLap'), row.get('avgLap')
        if not (dated <= now_unix + 300 and finite(rate) and 0 < rate < 50 ):
            continue
        race = row.get('race_instance_id')
        key = str(race) + '|' + str(row.get('sessionNum', '')) if race else str(row.get('raceRecordId') or '')
        if not key:
            continue
        count = row.get('fuelSampleCount') or row.get('totalLaps') or 1
        weight = max(1, min(50, count)) if finite(count) else 1
        quality = 1 if row.get('fuelSampleBasis') == 'strict_clean' else 0
        candidate = dict(id=key, rate=rate, pace=pace, weight=weight, recorded_at=dated, quality=quality)
        prior = rows.get(key)
        if prior is None or (quality, weight, dated) > (prior['quality'], prior['weight'], prior['recorded_at']):
            rows[key] = candidate
    rows = list(rows.values())
    if not rows:
        return None
    weight = sum(r['weight'] for r in rows)
    low, high = min(r['rate'] for r in rows), max(r['rate'] for r in rows)
    pace_rows=[r for r in rows if finite(r['pace']) and 20<r['pace']<2000]
    pace_weight=sum(r['weight'] for r in pace_rows)
    return dict(rate_l_per_lap=high if high > low * 1.2 else sum(r['rate'] * r['weight'] for r in rows) / weight,
                pace_s=sum(r['pace'] * r['weight'] for r in pace_rows) / pace_weight if pace_weight else None,
                record_ids=[r['id'] for r in rows], record_count=len(rows), role='dated_personal_reference')


def current_error(current):
    if not isinstance(current, Mapping):
        return 'current_unavailable'
    if current.get('race_format') != 'timed' or not finite(current.get('configured_duration_s')) or current['configured_duration_s'] <= 0:
        return 'reference_timed_format_unavailable'
    if current.get('scope_closed') or current.get('collision') or current.get('session_finished'):
        return 'reference_scope_closed'
    if current.get('telemetry_available') is not True or current.get('source_available') is not True:
        return 'reference_live_source_unavailable'
    if current.get('black_flag') != 'false':
        return 'black_flag_unavailable_or_active'
    if current.get('on_track') is not True or current.get('on_pit_road') is not False:
        return 'not_current_track_running'
    if not (integer(current.get('current_lap')) and current['current_lap'] > 0
            and finite(current.get('lap_dist_pct')) and 0 <= current['lap_dist_pct'] <= 1
            and finite(current.get('fuel_level_l')) and current['fuel_level_l'] >= 0
            and finite(current.get('effective_capacity_l')) and current['effective_capacity_l'] > 0
            and current['fuel_level_l'] <= current['effective_capacity_l']):
        return 'current_fuel_geometry_or_capacity_unavailable'
    return None


def reference_error(request, publication, current):
    if not isinstance(request, dict) or not isinstance(publication, dict) or not isinstance(current, Mapping):
        return 'reference_unavailable'
    if any(not isinstance(request.get(k), str) or not request[k] or len(request[k]) > 512
           for k in ('command_id', 'evidence_version', 'bridge_process_epoch', 'snapshot_id')):
        return 'reference_identity_unavailable'
    if any(request.get(k) != publication.get(k) for k in ('bridge_process_epoch', 'snapshot_id', 'snapshot_sequence')):
        return 'reference_publication_mismatch'
    if any(request.get(k) != current.get(k) or publication.get(k) != current.get(k) for k in ('race_instance_id', 'session_num')):
        return 'reference_publication_scope_mismatch'
    if any(request.get(k) != current.get(k) for k in ('cust_id',)):
        return 'reference_driver_scope_mismatch'
    if norm(request.get('car_model')) != norm(current.get('car_model')) or track_key(request.get('track')) != track_key(current.get('track')):
        return 'reference_car_track_mismatch'
    continuity = publication.get('continuity')
    execution = publication.get('execution')
    if not isinstance(continuity, Mapping) or not isinstance(execution, Mapping):
        return 'reference_publication_contract_unavailable'
    source = publication.get('source_frame') or {}
    if not isinstance(source, Mapping) or source.get('available') is not True or not finite(source.get('session_time_s')) or not finite(current.get('session_time_s')):
        return 'reference_source_unavailable'
    elapsed = current['session_time_s'] - source['session_time_s']
    if (not finite(elapsed) or not 0 <= elapsed < 5 or publication.get('telemetry_available') is not True
            or continuity.get('durable_commit') is not True
            or execution.get('scope_closed') is not False or execution.get('collision') is not False):
        return 'reference_stale_or_uncommitted'
    scope = continuity.get('stable_scope') or continuity.get('custody_scope') or {}
    if not isinstance(scope, Mapping) or scope.get('driver_id') != current.get('cust_id'):
        return 'reference_owner_unavailable'
    # Withdrawing matching same-scope authority cannot authorize execution.
    # Unknown flags or pit entry must not prevent a driver from withdrawing it.
    return None if request.get('mode') == 'invalidate' else current_error(current)


def planning_values(current, evidence):
    rate, pace = evidence.get('rate_l_per_lap'), evidence.get('pace_s')
    measured = current.get('current_measured_rate_l_per_lap')
    if finite(rate) and finite(measured) and measured > rate and integer(current.get('current_measured_samples')) and current['current_measured_samples'] > 0:
        rate = measured
    measured_pace = current.get('current_measured_pace_s')
    if (finite(pace) and finite(measured_pace) and 20 < measured_pace < 2000
            and integer(current.get('current_measured_pace_samples')) and current['current_measured_pace_samples'] > 0):
        pace = min(pace, measured_pace)
    return rate, pace


def geometry(current, evidence, target=None, frozen_set=None):
    error = current_error(current)
    if error:
        return dict(available=False, reason=error)
    if not isinstance(evidence, Mapping):
        return dict(available=False, reason='reference_evidence_unavailable')
    rate, pace = planning_values(current, evidence)
    seconds = current.get('time_remaining_s')
    if not (finite(rate) and rate > 0 and finite(pace) and pace > 20 and finite(seconds) and seconds > 0):
        return dict(available=False, reason='timed_distance_unavailable')
    crossings = math.ceil(seconds / pace) + 1  # include a conservative extra crossing
    lap, q, fuel, capacity = (current[k] for k in ('current_lap', 'lap_dist_pct', 'fuel_level_l', 'effective_capacity_l'))
    if target is None:
        target = lap + max(0, math.floor((fuel - RESERVE_L) / rate) - 1)
    if not integer(target) or not lap <= target < lap + crossings:
        return dict(available=False, reason='invalid_reference_target')
    distance = target - lap
    entry = fuel - rate * (distance + 1 - q)
    need = rate * (crossings - q) + RESERVE_L
    post_need = rate * (crossings - distance) + RESERVE_L
    additional = max(0.0, need - fuel)
    if additional <= 0:
        return dict(available=False, reason='reference_stop_not_required')
    setting = math.ceil(additional) if frozen_set is None else frozen_set
    if entry < RESERVE_L:
        return dict(available=False, reason='reference_target_unreachable')
    if post_need > capacity or not integer(setting) or not 0 <= setting <= math.floor(capacity):
        return dict(available=False, reason='reference_service_capacity_insufficient')
    if fuel + setting + 1e-9 < need:
        return dict(available=False, reason='reference_frozen_service_insufficient')
    return dict(available=True, reason=CONTRACT, target_lap=target, target_in_laps=distance,
                add_fuel_l=additional, set_fuel_l=setting, entry_fuel_lower_bound_l=entry,
                post_stop_need_upper_bound_l=post_need, total_need_l=need,
                current_lap=lap, crossings_to_finish=crossings,
                geometry_contract='provisional_history_running_lap', planning_rate_l_per_lap=rate, planning_pace_s=pace)


def request_digest(request):
    """Bounded exact-payload retry identity; never trust only a command UUID."""
    try:
        encoded = json.dumps(request, sort_keys=True, allow_nan=False).encode()
        return hashlib.sha256(encoded).hexdigest() if len(encoded) <= 512000 else None
    except (TypeError, ValueError, OverflowError):
        return None


def proposal(request, publication, current, now_unix):
    error = reference_error(request, publication, current)
    if error:
        return dict(available=False, reason=error)
    evidence = personal_evidence(request.get('records'), current, now_unix)
    if evidence is None:
        return dict(available=False, reason='matching_personal_reference_unavailable')
    result = geometry(current, evidence, request.get('requested_target_lap'))
    if not result['available']:
        return result
    try:
        encoded = json.dumps(request, sort_keys=True, allow_nan=False).encode()
        if len(encoded) > 512000:
            return dict(available=False, reason='reference_payload_too_large')
        digest = hashlib.sha256(encoded).hexdigest()[:24]
    except (TypeError, ValueError, OverflowError):
        return dict(available=False, reason='reference_payload_invalid')
    result.update(decision_id=current['race_instance_id'] + ':fuel-reference:' + digest, evidence=evidence,
                  reference=dict(contract=CONTRACT, command_id=request['command_id'],
                                 evidence_version=request['evidence_version'], planning_rate_l_per_lap=result['planning_rate_l_per_lap'], planning_pace_s=result['planning_pace_s'], identity={k: current.get(k) for k in ('cust_id', 'car_model', 'track')},
                                 evidence=evidence, source_snapshot_id=request['snapshot_id'],
                                 process_epoch=request['bridge_process_epoch'], created_session_time_s=current['session_time_s']))
    if not reference_valid(result['reference']):
        return dict(available=False, reason='reference_schema_invalid')
    return result


def reference_valid(ref):
    if not isinstance(ref, Mapping) or ref.get('contract') != CONTRACT:
        return False
    if any(not isinstance(ref.get(k), str) or not ref[k] or len(ref[k]) > 512 for k in ('process_epoch', 'command_id', 'evidence_version', 'source_snapshot_id')):
        return False
    identity, evidence = ref.get('identity'), ref.get('evidence')
    return (isinstance(identity, Mapping) and integer(identity.get('cust_id')) and identity['cust_id'] > 0
            and bool(norm(identity.get('car_model'))) and bool(track_key(identity.get('track')))
            and isinstance(evidence, Mapping) and finite(evidence.get('rate_l_per_lap')) and 0 < evidence['rate_l_per_lap'] < 50
            and finite(evidence.get('pace_s')) and 20 < evidence['pace_s'] < 2000
            and isinstance(evidence.get('record_ids'), (list, tuple)) and 0 < len(evidence['record_ids']) <= 500
            and all(isinstance(v, str) and 0 < len(v) <= 512 for v in evidence['record_ids'])
            and integer(evidence.get('record_count')) and evidence['record_count'] == len(evidence['record_ids'])
            and len(set(evidence['record_ids'])) == len(evidence['record_ids'])
            and finite(ref.get('created_session_time_s'))
            and finite(ref.get('planning_rate_l_per_lap',evidence['rate_l_per_lap']))
            and evidence['rate_l_per_lap']<=ref.get('planning_rate_l_per_lap',evidence['rate_l_per_lap'])<50
            and finite(ref.get('planning_pace_s',evidence['pace_s']))
            and 20 < ref.get('planning_pace_s',evidence['pace_s']) <= evidence['pace_s'])


def public_reference(record):
    ref = reference_of(record)
    if ref is None:
        return None
    evidence = ref['evidence']
    return dict(contract=CONTRACT, command_id=ref['command_id'], evidence_version=ref['evidence_version'],
                source_snapshot_id=ref['source_snapshot_id'], rate_l_per_lap=evidence['rate_l_per_lap'], pace_s=evidence['pace_s'],
                planning_rate_l_per_lap=ref.get('planning_rate_l_per_lap',evidence['rate_l_per_lap']),
                planning_pace_s=ref.get('planning_pace_s',evidence['pace_s']),
                record_count=evidence['record_count'], record_ids=list(evidence['record_ids'])[:32],
                record_ids_truncated=len(evidence['record_ids']) > 32,
                expires_session_time_s=ref['created_session_time_s']+30,
                predicted_add_fuel_l=record.add_fuel_l, set_fuel_l=record.set_fuel_l)


def reference_of(record):
    basis = record.plan_basis if record is not None else None
    ref = basis.get(CONTRACT) if isinstance(basis, Mapping) else None
    return ref if reference_valid(ref) else None


def plain(value):
    """Cross the immutable Lifecycle -> calculation/JSON boundary recursively."""
    if isinstance(value, Mapping):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    return value


def inputs_for_record(record, base, current, process_epoch):
    ref = reference_of(record)
    if ref is None:
        return base
    result = dict(base, finish_kind=CONTRACT, provisional_history=plain(ref),
                  time_remaining_s=current.get('time_remaining_s'),
                  black_flag=current.get('black_flag'), on_track=current.get('on_track'), on_pit_road=current.get('on_pit_road'),
                  telemetry_available=current.get('telemetry_available'), source_available=current.get('source_available'),
                  scope_closed=current.get('scope_closed'), collision=current.get('collision'), session_finished=current.get('session_finished'), race_format=current.get('race_format'),
                  configured_duration_s=current.get('configured_duration_s'),
                  cust_id=current.get('cust_id'), car_model=current.get('car_model'), track=current.get('track'), track_raw=current.get('track_raw'),
                  process_epoch=process_epoch, reserve_l=RESERVE_L,
                  current_measured_rate_l_per_lap=current.get('current_measured_rate_l_per_lap'),
                  current_measured_samples=current.get('current_measured_samples', 0),
                  current_measured_pace_s=current.get('current_measured_pace_s'),
                  current_measured_pace_samples=current.get('current_measured_pace_samples', 0),
                  avg_fuel_per_lap_l=ref['evidence']['rate_l_per_lap'], multi_stop=False)
    rate,pace=planning_values(current,ref['evidence'])
    result['avg_fuel_per_lap_l']=rate
    result['planning_pace_s']=pace
    seconds=current.get('time_remaining_s')
    result['crossings_to_finish']=math.ceil(seconds/pace)+1 if finite(seconds) and seconds>0 else None
    result['total_laps']=None
    return result


def evaluate_inputs(inputs, target, frozen_set=None):
    ref = inputs.get('provisional_history')
    if not reference_valid(ref) or ref.get('process_epoch') != inputs.get('process_epoch'):
        return dict(available=False, reason='reference_contract_unavailable')
    identity = ref.get('identity') or {}
    if (identity.get('cust_id') != inputs.get('cust_id')
            or norm(identity.get('car_model')) != norm(inputs.get('car_model'))
            or track_key(identity.get('track')) != track_key(inputs.get('track'))):
        return dict(available=False, reason='reference_current_identity_mismatch')
    return geometry(inputs, ref['evidence'], target, frozen_set)


def replan(record, current):
    ref = reference_of(record)
    if ref is None:
        return dict(available=False, reason='reference_contract_unavailable')
    result = geometry(current, ref['evidence'], record.target_lap)
    if not result['available']:
        return result
    digest=hashlib.sha256(json.dumps([record.decision_id,current.get('snapshot_id'),current.get('source_frame_sequence'),result['target_lap'],result['set_fuel_l']],sort_keys=True).encode()).hexdigest()[:24]
    updated = {**plain(ref), 'planning_rate_l_per_lap':result['planning_rate_l_per_lap'], 'planning_pace_s':result['planning_pace_s'], 'created_session_time_s': current['session_time_s'],
               'source_snapshot_id': current.get('snapshot_id'),
               'command_id': 'fuel-replan:' + digest}
    result.update(decision_id=current['race_instance_id']+':fuel-reference:'+digest, reference=updated,
                  evidence=ref['evidence'])
    return result
