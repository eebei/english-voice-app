"""SessionInfo -> renderer -> system prompt authority wiring contract."""

import json
import os
import subprocess


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BRIDGE_PATH = os.path.join(HERE, 'bridge.py')
RENDERER_PATH = os.path.join(ROOT, 'desktop', 'renderer.html')
PROMPTS_PATH = os.path.join(ROOT, 'prompts.js')

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


def sources():
    with open(BRIDGE_PATH, encoding='utf-8') as f:
        bridge = f.read()
    with open(RENDERER_PATH, encoding='utf-8') as f:
        renderer = f.read()
    with open(PROMPTS_PATH, encoding='utf-8') as f:
        prompts = f.read()
    return bridge, renderer, prompts


def prompt_for(authority, mode='race'):
    script = (
        "const p=require('./prompts.js');"
        "const r=p.buildSystem({character:'Oishi',mode:"
        + json.dumps(mode) + ",level:'C2',"
        "sessionAuthority:" + json.dumps(authority) + "});"
        "process.stdout.write(JSON.stringify(r));"
    )
    result = subprocess.run(
        ['node', '-e', script],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def test_bridge_contract():
    print('\n══ bridge authority production path ══')
    bridge, _, _ = sources()
    checks = {
        'authority module imported':
            'import session_authority as session_authority_mod' in bridge,
        'CarScreenName parsed as model':
            "stripped.startswith('CarScreenName:')" in bridge
            and "current_driver['car_model']" in bridge,
        'player exact model exported':
            "result['player_car_model'] = player.get('car_model', '')" in bridge,
        'current SessionNum read from telemetry':
            "_authority_session_num = reader.read_int('SessionNum')" in bridge,
        'pure authority builder used':
            'session_authority_mod.build_session_authority(' in bridge,
        'structured authority sent':
            "info['current_session_authority'] = _session_authority" in bridge,
        'signature controls transition dispatch':
            'if sig != last_session_sig:' in bridge
            and 'last_session_sig = sig' in bridge,
        'sig reset consumes same-frame SessionNum transition':
            'last_session_num = _authority_session_num' in bridge,
        'slower authority refresh skips already-consumed SessionNum reset':
            'Session authority transition sent without duplicate reset'
            in bridge
            and 'sig[:2] == last_session_sig[:2]' in bridge
            and '_authority_session_num == last_session_num' in bridge,
        'model retained in summary and pit timing':
            bridge.count("'car_model': session_car_model") >= 3,
    }
    for name, value in checks.items():
        check(name, value)
    check('weekend EventType is not authority builder input',
          'build_session_authority(\n                        info, _authority_session_num)'
          in bridge)


def test_renderer_contract():
    print('\n══ renderer propagation and memory identity ══')
    _, renderer, _ = sources()
    checks = {
        'authority state exists': 'let lastSessionAuthority = null;' in renderer,
        'session type comes from authority':
            "lastSessionType=(a&&a.session_type" in renderer,
        'old EventType assignment removed':
            'lastSessionType=data.data.event_type' not in renderer,
        'track and model come from authority':
            'lastCarModel=a.car_model' in renderer
            and 'lastTrack=a.track' in renderer,
        'all API paths carry structured authority':
            renderer.count('sessionAuthority:lastSessionAuthority') >= 5,
        'driver insight cannot omit authority':
            "content:'[DRIVER_INSIGHT]" in renderer
            and 'sessionAuthority:lastSessionAuthority,\n      driverInsight:true'
            in renderer,
        'history stores model separately from class':
            'car:data.car_model||lastCarModel' in renderer
            and 'carClass:data.car_class||lastCarClass' in renderer,
        'pit memory prefers exact model':
            'data.car_model||lastCarModel||data.car_class' in renderer,
        'car-track memory key prefers model':
            'lastCarModel||lastCarClass' in renderer,
        'legacy class-key memory remains retrievable':
            'function findCarTrackMemory(' in renderer
            and "mem[carClass+'|'+track]" in renderer
            and renderer.count('findCarTrackMemory(') >= 4,
        'unknown class cannot poison fallback state':
            "trim().toLowerCase()!=='unknown') lastCarClass=" in renderer,
    }
    for name, value in checks.items():
        check(name, value)


def test_prompt_runtime_contract():
    print('\n══ system prompt authority precedence ══')
    authority = {
        'track': 'Road America',
        'car_model': 'McLaren 720S GT3 EVO',
        'session_type': 'Open Qualify',
    }
    built = prompt_for(authority)
    prefix = built['prefix']
    check('authority block is first byte',
          prefix.startswith('[CURRENT SESSION — AUTHORITATIVE iRACING DATA]'),
          prefix[:90])
    check('exact three current facts present',
          'Track: Road America' in prefix
          and 'Car: McLaren 720S GT3 EVO' in prefix
          and 'Session: Open Qualify' in prefix)
    check('explicitly overrides every stale source',
          all(word in prefix for word in (
              'profile notes', 'race history', 'car/track memory',
              'conversation history', 'assumptions')))
    check('no delayed-check promise instruction remains',
          'say you will check' not in prefix)

    unknown = prompt_for({})['prefix']
    check('missing values are structurally UNKNOWN',
          unknown.count('UNKNOWN') >= 4, unknown[:260])
    check('UNKNOWN forbids inference and stale replay',
          'do not infer, guess, repeat an old value' in unknown)
    strategy_unknown = prompt_for({}, mode='strategy')['prefix']
    check('strategy mode repeats authority-only current-fact rule',
          '【現在セッションの事実・最優先】' in strategy_unknown
          and '過去の記憶・会話・シリーズ知識から推測して' in strategy_unknown)


def test_mutation_detection():
    print('\n══ wiring mutation evidence ══')
    bridge, renderer, prompts = sources()
    mutations = {
        'M1 EventType restored in renderer':
            renderer.replace(
                "lastSessionType=(a&&a.session_type&&a.session_type!=='unknown')?a.session_type:null;",
                'lastSessionType=data.data.event_type;', 1),
        'M2 structured API payload removed':
            renderer.replace('sessionAuthority:lastSessionAuthority,', '', 1),
        'M3 model parser removed':
            bridge.replace("elif stripped.startswith('CarScreenName:'):", 'elif False:', 1),
        'M4 authority moved behind character base':
            prompts.replace(
                'const prefix = authorityBlock + base +',
                'const prefix = base + authorityBlock +', 1),
        'M5 same-frame reset marker removed':
            bridge.replace(
                'last_session_num = _authority_session_num',
                'last_session_num = last_session_num', 1),
        'M6 class fallback removed':
            renderer.replace(
                "if(carClass&&mem[carClass+'|'+track]) "
                "return mem[carClass+'|'+track];",
                '', 1),
        'M7 strategy authority reinforcement removed':
            prompts.replace(
                "modeNote += isJ\n"
                "        ? '\\n\\n【現在セッションの事実・最優先】",
                "modeNote += isJ\n        ? '\\n\\n", 1),
    }
    check('M1 detected',
          'lastSessionType=data.data.event_type' in mutations[
              'M1 EventType restored in renderer'])
    check('M2 detected by six-path count',
          mutations['M2 structured API payload removed'].count(
              'sessionAuthority:lastSessionAuthority') < 6)
    check('M3 detected by parser contract',
          "stripped.startswith('CarScreenName:')" not in mutations[
              'M3 model parser removed'])
    check('M4 detected by first-block source contract',
          'const prefix = authorityBlock + base +' not in mutations[
              'M4 authority moved behind character base'])
    check('M5 detected by no-double-reset contract',
          'last_session_num = _authority_session_num' not in mutations[
              'M5 same-frame reset marker removed'])
    check('M6 detected by legacy retrieval contract',
          "mem[carClass+'|'+track]" not in mutations[
              'M6 class fallback removed'])
    check('M7 detected by strategy UNKNOWN contract',
          '【現在セッションの事実・最優先】' not in mutations[
              'M7 strategy authority reinforcement removed'])


def run_all():
    test_bridge_contract()
    test_renderer_contract()
    test_prompt_runtime_contract()
    test_mutation_detection()
    print('\n[session_authority_wiring] 合格 %d / 不合格 %d'
          % (passed, failed))
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    run_all()
