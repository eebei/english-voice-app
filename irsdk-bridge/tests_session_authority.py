"""Session Authority pure contract."""

import importlib.util
import os


HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    'session_authority', os.path.join(HERE, 'session_authority.py'))
sa = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sa)

passed = 0
failed = 0


def check(name, condition, actual=None):
    global passed, failed
    if condition:
        passed += 1
        print('  ✅ ' + name)
    else:
        failed += 1
        print('  ❌ ' + name + (
            (' -> ' + repr(actual)) if actual is not None else ''))


def fixture():
    return {
        'track': 'roadamerica full',
        'track_display': 'Road America',
        'event_type': 'Race',
        'player_car_model': 'McLaren 720S GT3 EVO',
        'player_car_class': 'IMSA23',
        'sessions': {
            0: 'Practice',
            1: 'Open Qualify',
            2: 'Race',
        },
    }


def test_complete_authority():
    print('\n══ complete authority ══')
    payload, signature = sa.build_session_authority(fixture(), 0)
    check('display track preferred', payload['track'] == 'Road America', payload)
    check('exact car model', payload['car_model'] == 'McLaren 720S GT3 EVO', payload)
    check('Practice comes from SessionNum', payload['session_type'] == 'Practice', payload)
    check('weekend EventType Race does not overwrite Practice',
          payload['session_type'] != fixture()['event_type'], payload)
    check('source is explicit', payload['source'] == sa.SOURCE, payload)
    check('complete true', payload['complete'] is True, payload)
    check('missing empty', payload['missing'] == [], payload)
    check('signature covers all authority values',
          signature == ('Road America', 'McLaren 720S GT3 EVO', 'Practice', 0),
          signature)


def test_session_transition():
    print('\n══ Practice -> Qualify -> Race ══')
    _, practice = sa.build_session_authority(fixture(), 0)
    qualify_payload, qualify = sa.build_session_authority(fixture(), 1)
    race_payload, race = sa.build_session_authority(fixture(), 2)
    check('Qualify current type', qualify_payload['session_type'] == 'Open Qualify')
    check('Race current type', race_payload['session_type'] == 'Race')
    check('each SessionNum changes signature',
          len({practice, qualify, race}) == 3,
          (practice, qualify, race))


def test_fail_closed():
    print('\n══ missing/placeholder fail closed ══')
    payload, signature = sa.build_session_authority({}, None)
    check('missing fields represented as unknown',
          payload['track'] == sa.UNKNOWN
          and payload['car_model'] == sa.UNKNOWN
          and payload['session_type'] == sa.UNKNOWN, payload)
    check('incomplete', payload['complete'] is False, payload)
    check('all three missing listed',
          payload['missing'] == ['track', 'car_model', 'session_type'], payload)
    check('invalid SessionNum is None', payload['session_num'] is None, payload)

    bad = fixture()
    bad['track_display'] = 'unknown'
    bad['track'] = 'n/a'
    bad['player_car_model'] = 'car'
    payload2, _ = sa.build_session_authority(bad, 99)
    check('placeholders never become authority facts',
          payload2['track'] == sa.UNKNOWN
          and payload2['car_model'] == sa.UNKNOWN
          and payload2['session_type'] == sa.UNKNOWN, payload2)

    fallback = fixture()
    fallback['track_display'] = ''
    payload3, _ = sa.build_session_authority(fallback, 2)
    check('internal TrackName used only when display missing',
          payload3['track'] == 'roadamerica full', payload3)


def test_mutations():
    print('\n══ deterministic mutation evidence ══')
    source = open(
        os.path.join(HERE, 'session_authority.py'),
        encoding='utf-8').read()

    mutated = source.replace(
        "session_type = _clean(sessions.get(session_num)) if session_num is not None else None",
        "session_type = _clean(info.get('event_type'))", 1)
    ns = {}
    exec(mutated, ns)
    original, _ = sa.build_session_authority(fixture(), 0)
    changed, _ = ns['build_session_authority'](fixture(), 0)
    check('M1 EventType fallback mutation detected',
          original['session_type'] == 'Practice'
          and changed['session_type'] == 'Race',
          (original, changed))

    mutated2 = source.replace(
        "_clean(info.get('track_display')) or _clean(info.get('track'))",
        "_clean(info.get('track'))", 1)
    ns2 = {}
    exec(mutated2, ns2)
    changed2, _ = ns2['build_session_authority'](fixture(), 0)
    check('M2 display track removal detected',
          original['track'] == 'Road America'
          and changed2['track'] == 'roadamerica full',
          (original, changed2))

    mutated3 = source.replace(
        "car_model = _clean(info.get('player_car_model'))",
        "car_model = _clean(info.get('player_car_class'))", 1)
    ns3 = {}
    exec(mutated3, ns3)
    changed3, _ = ns3['build_session_authority'](fixture(), 0)
    check('M3 class-for-model mutation detected',
          original['car_model'] == 'McLaren 720S GT3 EVO'
          and changed3['car_model'] == 'IMSA23',
          (original, changed3))


def run_all():
    test_complete_authority()
    test_session_transition()
    test_fail_closed()
    test_mutations()
    print('\n[session_authority] 合格 %d / 不合格 %d'
          % (passed, failed))
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    run_all()
