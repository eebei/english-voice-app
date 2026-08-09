#!/usr/bin/env python3
"""Turn OMORAY debug logs into an auditable Phase C/D evidence corpus."""

import argparse
import glob
import hashlib
import json
import os
import re
from collections import Counter, defaultdict


SESSION_RE = re.compile(
    r"Session info sent:\s*(?P<event>\S+)\s+SOF:(?P<sof>\S+)\s+class:(?P<class_name>.*?)"
    r"\s+drivers:(?P<drivers>\d+)\s+car:(?P<car>.*?)\s+currentSession:(?P<session>.*?)"
    r"\s+track:(?P<track>.*?)\s+iR:")
BUILD_RE = re.compile(r"OMORAY PITWALL Bridge\s+BUILD\s+(?P<build>Build[^\r\n]+?)\s+started")
TRANSITION_RE = re.compile(
    r"Session authority transition sent.*?->\s*\('(?P<track>[^']*)',\s*'(?P<car>[^']*)',\s*'(?P<session>[^']*)',\s*(?P<session_num>-?\d+)\)")
HEADER_RE = re.compile(r"debug log\s+(?P<created>[^=\s]+)")
LINE_TIME_RE = re.compile(r"^\[(?P<time>\d{2}:\d{2}:\d{2})\]")
DATA_RE = re.compile(
    r"DATA CHECK -> Lap:(?P<lap>-?\d+) Pos:(?P<pos>-?\d+) LastLap:(?P<last>[\d.]+) "
    r"Speed:(?P<speed>\S+) OnTrack:(?P<on_track>\S+) OnPit:(?P<on_pit>\S+) "
    r"SessState:(?P<state>-?\d+) DriverState:(?P<driver_state>\S+) Fuel:(?P<fuel>\S+)")
CLEAN_FUEL_RE = re.compile(r"平均\s*(?P<average>\d+(?:\.\d+)?)\s*L/周、クリーン\s*(?P<samples>\d+)周の実測")


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _json_after(line, marker):
    pos = line.find(marker)
    if pos < 0:
        return None
    raw = line[pos + len(marker):].strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _line_time(line):
    match = LINE_TIME_RE.match(line)
    return match.group('time') if match else None


def _context(current):
    return {
        key: current.get(key) for key in
        ('event', 'session', 'track', 'car', 'class_name', 'drivers')
    }


def parse_log(path):
    with open(path, 'rb') as handle:
        raw = handle.read()
    digest = hashlib.sha256(raw).hexdigest()
    text = raw.decode('utf-8', errors='replace')
    record = {
        'path': os.path.abspath(path),
        'sha256': digest,
        'bytes': len(raw),
        'created': None,
        'build': None,
        'mentions_monza': 'monza' in text.lower(),
        'sessions': [],
        'data_samples': [],
        'clean_fuel_evidence': [],
        'strategy_updates': [],
        'pit_forecasts': [],
        'pit_actuals': [],
        'pit_services': [],
        'pit_cycle_outcomes': [],
    }
    current = {}
    header = HEADER_RE.search(text[:300])
    if header:
        record['created'] = header.group('created')
    build = BUILD_RE.search(text)
    if build:
        record['build'] = build.group('build').strip()

    for line_number, line in enumerate(text.splitlines(), 1):
        session = SESSION_RE.search(line)
        if session:
            current = session.groupdict()
            current['drivers'] = int(current['drivers'])
            current['line'] = line_number
            current['time'] = _line_time(line)
            record['sessions'].append(dict(current))

        transition = TRANSITION_RE.search(line)
        if transition:
            changed = transition.groupdict()
            current['session'] = changed['session']
            current['car'] = changed['car'] or current.get('car')
            current['session_num'] = int(changed['session_num'])
            # Preserve the internal track config from SessionInfo when it is
            # already known; the transition tuple uses a display name.
            if not current.get('track'):
                current['track'] = changed['track']
            record['sessions'].append({
                **current, 'line': line_number, 'time': _line_time(line),
                'source': 'authority_transition',
            })

        data = DATA_RE.search(line)
        if data:
            sample = data.groupdict()
            for key in ('lap', 'pos', 'state'):
                sample[key] = int(sample[key])
            for key in ('last', 'speed', 'fuel'):
                sample[key] = _number(sample[key])
            sample['on_track'] = sample['on_track'] == 'True'
            sample['on_pit'] = sample['on_pit'] == 'True'
            sample.update({'line': line_number, 'time': _line_time(line), **_context(current)})
            record['data_samples'].append(sample)

        clean = CLEAN_FUEL_RE.search(line)
        if clean:
            evidence = {
                'average_l_per_lap': float(clean.group('average')),
                'clean_laps_sampled': int(clean.group('samples')),
                'source': 'deterministic_clean_lap_radio',
                'line': line_number,
                'time': _line_time(line),
                **_context(current),
            }
            record['clean_fuel_evidence'].append(evidence)

        for marker, key in (
            ('STRATEGY PLAN update:', 'strategy_updates'),
            ('PIT EXIT SHADOW forecast:', 'pit_forecasts'),
            ('PIT EXIT SHADOW actual:', 'pit_actuals'),
            ('PIT SERVICE sample:', 'pit_services'),
            ('PIT CYCLE outcome:', 'pit_cycle_outcomes'),
        ):
            payload = _json_after(line, marker)
            if payload is not None:
                record[key].append({
                    'payload': payload,
                    'line': line_number,
                    'time': _line_time(line),
                    **_context(current),
                })
    return record


def build_corpus(paths):
    parsed = [parse_log(path) for path in sorted(set(paths))]
    by_hash = defaultdict(list)
    for item in parsed:
        by_hash[item['sha256']].append(item['path'])
    canonical_paths = {group[0] for group in by_hash.values()}
    canonical = [item for item in parsed if item['path'] in canonical_paths]

    forecasts_by_id = defaultdict(list)
    actuals_by_id = defaultdict(list)
    for item in canonical:
        for event in item['pit_forecasts']:
            payload = event['payload']
            snapshot_id = payload.get('snapshot_id') if isinstance(payload, dict) else None
            if snapshot_id:
                forecasts_by_id[snapshot_id].append((item, event))
        for event in item['pit_actuals']:
            payload = event['payload']
            snapshot_id = payload.get('snapshot_id') if isinstance(payload, dict) else None
            if snapshot_id:
                actuals_by_id[snapshot_id].append((item, event))

    pairs = []
    for snapshot_id in sorted(set(forecasts_by_id) | set(actuals_by_id)):
        forecasts = forecasts_by_id.get(snapshot_id, [])
        actuals = actuals_by_id.get(snapshot_id, [])
        for item, actual in actuals:
            same_file = [candidate for candidate in forecasts if candidate[0]['path'] == item['path']]
            forecast_entry = same_file[-1] if same_file else (forecasts[-1] if forecasts else None)
            forecast = forecast_entry[1] if forecast_entry else None
            score = actual['payload'].get('score') if isinstance(actual['payload'], dict) else None
            pairs.append({
                'snapshot_id': snapshot_id,
                'created': item.get('created'),
                'forecast_path': forecast_entry[0]['path'] if forecast_entry else None,
                'forecast_line': forecast['line'] if forecast else None,
                'actual_path': item['path'],
                'actual_line': actual['line'],
                'track': actual.get('track') or (forecast or {}).get('track'),
                'car': actual.get('car') or (forecast or {}).get('car'),
                'session': actual.get('session') or (forecast or {}).get('session'),
                'available_forecast': bool(forecast and forecast['payload'].get('available')),
                'forecast': forecast['payload'] if forecast else None,
                'actual': actual['payload'],
                'score': score,
            })

    # Exported debug logs can overlap or contain the same run under a suffixed
    # filename.  De-duplicate scored events by race date, clock, snapshot and
    # actual outcome rather than by whole-file hash alone.
    unique_pairs = []
    seen_pair_keys = set()
    for pair in pairs:
        actual = pair.get('actual') or {}
        score = pair.get('score') or {}
        key = (
            str(pair.get('created') or '')[:10],
            str(pair.get('actual_path') or '').split('OMORAY-bridge-debug-')[-1][:13],
            pair.get('snapshot_id'),
            actual.get('actual_class_position'),
            score.get('likely_error_positions'),
        )
        if key in seen_pair_keys:
            continue
        seen_pair_keys.add(key)
        unique_pairs.append(pair)

    scored = [pair for pair in unique_pairs if isinstance(pair.get('score'), dict)]
    valid_race_scored = [pair for pair in scored
                         if pair.get('available_forecast')
                         and 'race' in str(pair.get('session') or '').lower()]
    errors = [abs(float(pair['score']['likely_error_positions'])) for pair in scored
              if _number(pair['score'].get('likely_error_positions')) is not None]
    inside = [pair for pair in scored if pair['score'].get('inside_best_worst') is True]
    valid_inside = [pair for pair in valid_race_scored
                    if pair['score'].get('inside_best_worst') is True]
    valid_errors = [abs(float(pair['score']['likely_error_positions']))
                    for pair in valid_race_scored
                    if _number(pair['score'].get('likely_error_positions')) is not None]
    track_counts = Counter()
    for item in canonical:
        for session in item['sessions']:
            if session.get('track'):
                track_counts[session['track']] += 1
    monza_files = [item for item in canonical if any(
        'monza' in str(session.get('track', '')).lower() for session in item['sessions'])]
    monza_fuel = [dict(evidence, path=item['path']) for item in monza_files
                  for evidence in item['clean_fuel_evidence']
                  if 'monza' in str(evidence.get('track', '')).lower()]
    pit_cycle_outcomes = [dict(event, path=item['path']) for item in canonical
                          for event in item['pit_cycle_outcomes']]
    cycle_payloads = [event['payload'] for event in pit_cycle_outcomes
                      if isinstance(event.get('payload'), dict)]
    conditional_errors = [_number(payload.get('conditional_error_positions'))
                          for payload in cycle_payloads]
    conditional_errors = [value for value in conditional_errors if value is not None]
    return {
        'summary': {
            'input_file_count': len(parsed),
            'unique_file_count': len(canonical),
            'duplicate_file_count': len(parsed) - len(canonical),
            'files_with_session_info': sum(bool(item['sessions']) for item in canonical),
            'unique_files_with_monza_session': len(monza_files),
            'unique_files_mentioning_monza': sum(
                item.get('mentions_monza') is True for item in canonical),
            'track_session_info_counts': dict(track_counts),
            'forecast_event_count': sum(len(item['pit_forecasts']) for item in canonical),
            'actual_event_count': sum(len(item['pit_actuals']) for item in canonical),
            'raw_matched_snapshot_count': len(pairs),
            'matched_snapshot_count': len(unique_pairs),
            'scored_snapshot_count': len(scored),
            'inside_range_count': len(inside),
            'inside_range_rate': round(len(inside) / len(scored), 4) if scored else None,
            'likely_mae_positions': round(sum(errors) / len(errors), 3) if errors else None,
            'valid_race_scored_count': len(valid_race_scored),
            'valid_race_inside_range_count': len(valid_inside),
            'valid_race_inside_range_rate': (
                round(len(valid_inside) / len(valid_race_scored), 4)
                if valid_race_scored else None),
            'valid_race_likely_mae_positions': (
                round(sum(valid_errors) / len(valid_errors), 3)
                if valid_errors else None),
            'monza_clean_fuel_evidence_count': len(monza_fuel),
            'pit_cycle_outcome_count': len(cycle_payloads),
            'pit_cycle_condition_met_count': sum(
                payload.get('condition_met') is True for payload in cycle_payloads),
            'pit_cycle_condition_not_met_count': sum(
                payload.get('condition_met') is False for payload in cycle_payloads),
            'pit_cycle_conditional_scored_count': len(conditional_errors),
            'pit_cycle_conditional_mae_positions': (
                round(sum(abs(value) for value in conditional_errors)
                      / len(conditional_errors), 3)
                if conditional_errors else None),
        },
        'duplicates': [paths for paths in by_hash.values() if len(paths) > 1],
        'phase_c_pairs': unique_pairs,
        'monza_clean_fuel_evidence': monza_fuel,
        'pit_cycle_outcomes': pit_cycle_outcomes,
        'files': canonical,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('paths', nargs='*')
    parser.add_argument('--glob', dest='patterns', action='append', default=[])
    parser.add_argument('--output')
    args = parser.parse_args()
    paths = list(args.paths)
    for pattern in args.patterns:
        paths.extend(glob.glob(pattern))
    corpus = build_corpus(paths)
    rendered = json.dumps(corpus, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as handle:
            handle.write(rendered + '\n')
    print(json.dumps(corpus['summary'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
