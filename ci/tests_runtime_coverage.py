#!/usr/bin/env python3
"""WO020 — RED/GREEN proof for ci/runtime_coverage.py and the packaged renderer verifier.

Every RED case breaks a DISPOSABLE overlay copy (never this checkout) and must fail for the
named reason; the untouched overlay must pass. The modules to break are taken from the derived
inventory itself (no hand-written module list).

Evidence levels: source checkout, synthetic pyi-archive_viewer listings (format tolerant parser;
NOT a real PyInstaller artifact — PyInstaller is not installed locally), and a real asar built
with @electron/asar through the real verify-packaged-runtime.js CLI.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import runtime_coverage as rc  # noqa: E402

PASS = FAIL = 0


def ok(name, cond, detail=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('✅ ' + name)
    else:
        FAIL += 1
        print('❌ %s %s' % (name, json.dumps(detail, ensure_ascii=False, default=str)[:900]))


def overlay():
    dst = tempfile.mkdtemp(prefix='wo020-cov-')
    for sub in ('irsdk-bridge', 'desktop', 'ci', '.github/workflows'):
        os.makedirs(os.path.join(dst, sub), exist_ok=True)
        for name in os.listdir(os.path.join(REPO, sub)):
            p = os.path.join(REPO, sub, name)
            if os.path.isfile(p) and (sub != 'irsdk-bridge' or name.endswith('.py')):
                shutil.copy2(p, os.path.join(dst, sub, name))
    os.makedirs(os.path.join(dst, 'desktop', 'scripts'), exist_ok=True)
    shutil.copy2(os.path.join(REPO, 'desktop', 'scripts', 'verify-packaged-runtime.js'), os.path.join(dst, 'desktop', 'scripts'))
    return dst


def source(root):
    out = os.path.join(root, '_out')
    p = subprocess.run([sys.executable, os.path.join(root, 'ci', 'runtime_coverage.py'), 'source', '--repo', root,
                        '--out', out, '--require-workflows'], capture_output=True, text=True, timeout=600)
    res = json.load(open(os.path.join(out, 'runtime-coverage-source.json')))
    return p.returncode, res, p.stdout


def edit(path, old, new):
    s = open(path, encoding='utf-8').read()
    assert s.count(old) == 1, (path, old[:60], s.count(old))
    open(path, 'w', encoding='utf-8').write(s.replace(old, new))


inv = rc.bridge_inventory(REPO)
mods = sorted(m for m in inv['local_modules'] if m != 'bridge')

# 0. Inventory is derived and complete: superset of what a real `import bridge` loads locally.
probe = subprocess.run([sys.executable, '-c', 'import sys,os,json; sys.path.insert(0, %r); import bridge; d=%r; '
                        'print(json.dumps(sorted(n for n,m in list(sys.modules.items()) if getattr(m,"__file__",None) '
                        'and os.path.dirname(os.path.abspath(m.__file__))==d)))' % (os.path.join(REPO, 'irsdk-bridge'), os.path.join(REPO, 'irsdk-bridge'))],
                       cwd=os.path.join(REPO, 'irsdk-bridge'), capture_output=True, text=True, timeout=120)
loaded = set(json.loads(probe.stdout.strip().splitlines()[-1])) if probe.returncode == 0 else None
ok('inventory ⊇ modules a real `import bridge` loads', loaded is not None and loaded <= set(inv['local_modules']) and 'observability_trace' in inv['local_modules'],
   {'not_in_inventory': sorted(loaded - set(inv['local_modules'])) if loaded else probe.stderr[-400:]})
ok('no inventory problems on the real tree', not inv['problems'], inv['problems'])

# 1. GREEN: the untouched overlay.
base = overlay()
try:
    code, res, out = source(base)
    ok('GREEN untouched overlay', code == 0 and res['ok'], {'failures': res['failures'], 'out': out[-600:]})
finally:
    shutil.rmtree(base, ignore_errors=True)

# 2. RED: a local module the graph needs is deleted (picked from the derived inventory).
victim = mods[len(mods) // 2]
importer = inv['local_modules'][victim]['imported_by'][0]
o = overlay()
try:
    os.remove(os.path.join(o, 'irsdk-bridge', victim + '.py'))
    code, res, out = source(o)
    ext = res['inventory']['external'].get(victim) or {}
    ok('RED deleted local module %s -> missing_import (imported by %s)' % (victim, importer),
       code == 1 and 'missing_import' in res['failures'] and ext.get('status') == 'missing' and importer in ext.get('imported_by', []),
       {'failures': res['failures'], 'ext': ext})
finally:
    shutil.rmtree(o, ignore_errors=True)

# 3. RED: a function-level / try-guarded / importlib local import is still part of the graph.
o = overlay()
try:
    open(os.path.join(o, 'irsdk-bridge', 'zz_wo020_lazy.py'), 'w').write('X = 1\n')
    open(os.path.join(o, 'irsdk-bridge', 'zz_wo020_dyn.py'), 'w').write('Y = 2\n')
    with open(os.path.join(o, 'irsdk-bridge', 'bridge.py'), 'a', encoding='utf-8') as f:
        f.write('\n\ndef _wo020_lazy():\n    try:\n        import zz_wo020_lazy\n    except ImportError:\n        pass\n'
                '    import importlib\n    return importlib.import_module("zz_wo020_dyn")\n')
    inv2 = rc.bridge_inventory(o)
    ok('function-level/try/importlib literal imports are in the inventory',
       {'zz_wo020_lazy', 'zz_wo020_dyn'} <= set(inv2['local_modules']), sorted(inv2['local_modules'])[-6:])
    os.remove(os.path.join(o, 'irsdk-bridge', 'zz_wo020_lazy.py'))
    code, res, out = source(o)
    ok('RED try-guarded lazy local module deleted -> missing_import (guard does not hide it)',
       code == 1 and (res['inventory']['external'].get('zz_wo020_lazy') or {}).get('status') == 'missing', res['failures'])
finally:
    shutil.rmtree(o, ignore_errors=True)

# 4. RED: a module that exists but cannot be imported.
o = overlay()
try:
    with open(os.path.join(o, 'irsdk-bridge', victim + '.py'), 'a', encoding='utf-8') as f:
        f.write('\nraise ImportError("wo020 injected")\n')
    code, res, out = source(o)
    ok('RED unimportable module -> source_import_smoke', code == 1 and 'source_import_smoke' in res['failures']
       and res['import_smoke'][victim]['ok'] is False, res['failures'])
finally:
    shutil.rmtree(o, ignore_errors=True)

# 5. RED: renderer runtime script missing / not packaged by the desktop `files` globs.
o = overlay()
try:
    os.remove(os.path.join(o, 'desktop', 'observability-trace.js'))
    code, res, out = source(o)
    ok('RED renderer <script src> file missing', code == 1 and res['renderer_runtime']['missing'] == ['observability-trace.js'], res['renderer_runtime']['missing'])
finally:
    shutil.rmtree(o, ignore_errors=True)
o = overlay()
try:
    edit(os.path.join(o, 'desktop', 'package.json'), '"*.js",', '"main.js",')
    code, res, out = source(o)
    ok('RED renderer scripts excluded by package files globs', code == 1 and 'renderer_runtime_script' in res['failures']
       and 'observability-trace.js' in res['renderer_runtime']['not_packaged'], res['renderer_runtime']['not_packaged'][:5])
finally:
    shutil.rmtree(o, ignore_errors=True)

# 6. RED: workflow contract breaks (paths, step order, upload, desktop bundled Bridge).
wf = lambda root, name: os.path.join(root, '.github', 'workflows', name)
cases = [
    ('bridge paths back to the old 3-module list', 'build-bridge.yml',
     "      - 'irsdk-bridge/*.py'\n      - '!irsdk-bridge/tests_*.py'\n", "      - 'irsdk-bridge/bridge.py'\n", 'push_paths_miss_runtime_files'),
    ('desktop paths without Bridge modules', 'build-desktop.yml',
     "      - 'irsdk-bridge/*.py'\n      - '!irsdk-bridge/tests_*.py'\n", '', 'push_paths_miss_runtime_files'),
    ('a negation that excludes a runtime module', 'build-bridge.yml',
     "      - '!irsdk-bridge/tests_*.py'\n", "      - '!irsdk-bridge/tests_*.py'\n      - '!irsdk-bridge/%s.py'\n" % victim, 'push_paths_miss_runtime_files'),
    ('store: packaged check removed', 'build-store-msix.yml',
     '        run: python ci/runtime_coverage.py packaged --exe dist/OMORAY-PITWALL-Bridge.exe --label bridge-dist --out ci-artifacts\n',
     '        run: echo skipped\n', 'packaged_coverage_not_after_pyinstaller'),
    ('desktop: bundled Bridge check removed', 'build-desktop.yml',
     '--same-as dist/OMORAY-PITWALL-Bridge.exe --label desktop-resources', '--label desktop-resources-x', None),
    ('bridge: coverage upload not always()', 'build-bridge.yml',
     "      - name: Upload runtime coverage results\n        if: always()\n", "      - name: Upload runtime coverage results\n", 'coverage_artifact_upload_not_always'),
]
for label, name, old, new, want in cases:
    o = overlay()
    try:
        edit(wf(o, name), old, new)
        code, res, out = source(o)
        errs = res['workflow_contract']['workflows'][name]['errors']
        if want is None:   # same-as removal keeps the bundled step: must still be GREEN (control)
            ok('control: %s (bundled step still present) stays GREEN' % label, code == 0 and not errs, errs)
        else:
            ok('RED workflow: %s -> %s' % (label, want), code == 1 and want in errs, {'errs': errs, 'uncovered': res['workflow_contract']['workflows'][name].get('uncovered_paths')})
    finally:
        shutil.rmtree(o, ignore_errors=True)

# 6b. The required workflow checker cannot silently skip: yaml missing at runtime, or a workflow
#     that drops `--require-workflows` / does not install PyYAML.
o = overlay()
try:
    fake = os.path.join(o, '_noyaml')
    os.makedirs(fake)
    open(os.path.join(fake, 'yaml.py'), 'w').write('raise ImportError("WO020 test: PyYAML absent")\n')
    env = dict(os.environ, PYTHONPATH=fake)
    p = subprocess.run([sys.executable, os.path.join(o, 'ci', 'runtime_coverage.py'), 'source', '--repo', o, '--out', os.path.join(o, '_a'),
                        '--require-workflows'], capture_output=True, text=True, timeout=600, env=env)
    res = json.load(open(os.path.join(o, '_a', 'runtime-coverage-source.json')))
    ok('RED PyYAML absent + --require-workflows -> workflow_contract (never a silent pass)',
       p.returncode == 1 and res['workflow_contract']['ran'] is False and 'workflow_contract' in res['failures'], res['failures'])
    p = subprocess.run([sys.executable, os.path.join(o, 'ci', 'runtime_coverage.py'), 'source', '--repo', o, '--out', os.path.join(o, '_b')],
                       capture_output=True, text=True, timeout=600, env=env)
    res = json.load(open(os.path.join(o, '_b', 'runtime-coverage-source.json')))
    ok('control: without --require-workflows the skip is reported as not_run (ran=false), not ok=true',
       res['workflow_contract']['ran'] is False and res['workflow_contract']['ok'] is None, res['workflow_contract'])
finally:
    shutil.rmtree(o, ignore_errors=True)
for label, name, old, new, want in [
        ('source step without --require-workflows', 'build-desktop.yml', 'source --require-workflows --out', 'source --out',
         'source_check_may_skip_workflow_contract'),
        ('PyYAML not installed', 'build-store-msix.yml', 'pygame pyaudio pyyaml\n', 'pygame pyaudio\n', 'pyyaml_not_installed_for_workflow_contract')]:
    o = overlay()
    try:
        edit(wf(o, name), old, new)
        code, res, out = source(o)
        errs = res['workflow_contract']['workflows'][name]['errors']
        ok('RED workflow: %s -> %s' % (label, want), code == 1 and want in errs, errs)
    finally:
        shutil.rmtree(o, ignore_errors=True)

# 7. Path filter semantics (GitHub: last match wins, `!` negates, `*` within a segment).
ok('paths_match semantics', rc.paths_match(['irsdk-bridge/*.py', '!irsdk-bridge/tests_*.py'], 'irsdk-bridge/fuel_strategy.py')
   and not rc.paths_match(['irsdk-bridge/*.py', '!irsdk-bridge/tests_*.py'], 'irsdk-bridge/tests_x.py')
   and not rc.paths_match(['irsdk-bridge/*.py'], 'irsdk-bridge/sub/x.py') and rc.paths_match(['ci/**'], 'ci/a/b.py')
   and not rc.paths_match(['desktop/**'], 'irsdk-bridge/bridge.py'))

# 8. Packaged EXE listing: synthetic listings in two layouts; missing member / unrecognized / no EXE.
names = sorted(inv['local_modules'])
nested = '\n'.join(['OMORAY-PITWALL-Bridge.exe', ' pyiboot01_bootstrap', ' bridge', ' PYZ-00.pyz'] +
                   ['  PYZ-00.pyz/' + m for m in names + ['json', 'asyncio'] + sorted(inv['external'])])
flat = '\n'.join(names + ['json', 'json.decoder', 'asyncio'] + sorted(inv['external']))
for layout, text in (('nested', nested), ('flat', flat)):
    chk = rc.packaged_check(REPO, inv, text)
    ok('GREEN synthetic listing (%s layout)' % layout, chk['ok'] and chk['recognized'], chk)
gone = names[len(names) // 3]
chk = rc.packaged_check(REPO, inv, '\n'.join(l for l in nested.splitlines() if not l.endswith('/' + gone)))
ok('RED packaged member %s missing from listing' % gone, not chk['ok'] and chk['missing_local_modules'] == [gone], chk)
chk = rc.packaged_check(REPO, inv, 'usage: pyi-archive_viewer [-h] ...\nerror: unrecognized arguments')
ok('RED unrecognized listing never passes', not chk['ok'] and not chk['recognized'] and len(chk['missing_local_modules']) == len(names), chk['recognized'])
tmp = tempfile.mkdtemp(prefix='wo020-pkg-')
try:
    lst = os.path.join(tmp, 'listing.txt')
    open(lst, 'w').write(nested)
    p = subprocess.run([sys.executable, os.path.join(HERE, 'runtime_coverage.py'), 'packaged', '--listing', lst, '--label', 'synthetic', '--out', tmp],
                       capture_output=True, text=True, timeout=120)
    saved = json.load(open(os.path.join(tmp, 'runtime-coverage-packaged-synthetic.json')))
    ok('CLI packaged --listing GREEN writes artifact', p.returncode == 0 and saved['ok'] and saved['evidence_level'] == 'saved listing', p.stdout)
    p = subprocess.run([sys.executable, os.path.join(HERE, 'runtime_coverage.py'), 'packaged', '--exe', os.path.join(tmp, 'absent.exe'), '--label', 'absent', '--out', tmp],
                       capture_output=True, text=True, timeout=120)
    ok('CLI packaged with no EXE -> RED', p.returncode == 1 and json.load(open(os.path.join(tmp, 'runtime-coverage-packaged-absent.json')))['ok'] is False, p.stdout)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# 9. Renderer packaged member: a REAL asar (via @electron/asar) through the REAL verifier CLI.
NODE = r'''
const asar = require(process.argv[1] + '/desktop/node_modules/@electron/asar');
const fs = require('fs'), path = require('path');
const [root, src, out, drop] = process.argv.slice(1);
fs.mkdirSync(src, { recursive: true });
const html = fs.readFileSync(path.join(root, 'desktop/renderer.html'), 'utf8');
fs.writeFileSync(path.join(src, 'renderer.html'), html);
for (const m of html.matchAll(/<script\s+src="([^"]+\.js)"/g)) if (m[1] !== drop) fs.copyFileSync(path.join(root, 'desktop', m[1]), path.join(src, m[1]));
asar.createPackage(src, out).then(() => console.log('built'));
'''
tmp = tempfile.mkdtemp(prefix='wo020-asar-')
try:
    results = {}
    for label, drop in (('full', ''), ('missing', 'observability-trace.js'), ('missing_identity', 'build-identity.js')):
        a = os.path.join(tmp, label + '.asar')
        b = subprocess.run(['node', '-e', NODE, REPO, os.path.join(tmp, label), a, drop], capture_output=True, text=True, timeout=120)
        j = os.path.join(tmp, label + '.json')
        v = subprocess.run(['node', os.path.join(REPO, 'desktop/scripts/verify-packaged-runtime.js'), '--asar', a, '--json', j],
                           capture_output=True, text=True, timeout=120)
        results[label] = (b.returncode, v.returncode, json.load(open(j)) if os.path.isfile(j) else None, b.stderr[-300:])
    full, miss = results['full'], results['missing']
    ok('GREEN real asar with every renderer script', full[0] == 0 and full[1] == 0 and full[2] and full[2]['ok'] is True, full)
    ok('RED real asar missing observability-trace.js -> verifier exit!=0 + json ok:false',
       miss[0] == 0 and miss[1] != 0 and miss[2] and miss[2]['ok'] is False and 'observability-trace.js' in miss[2]['error'], miss)
    mi = results['missing_identity']
    ok('RED real asar missing build-identity.js (WO021) -> verifier exit!=0 + json ok:false',
       mi[0] == 0 and mi[1] != 0 and mi[2] and mi[2]['ok'] is False and 'build-identity.js' in mi[2]['error'], mi)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# 10. WO021 build identity + retired entries. The GREEN overlay above already carries the real
#     tracked build-info.json / reader / workflows; each RED breaks one link on a fresh overlay.
bi = lambda root: os.path.join(root, 'desktop', 'build-info.json')
real_info = json.load(open(bi(REPO)))
ok('real tree: tracked build-info == bridge.py Build, marked unbuilt',
   rc.build_identity(REPO)['ok'] and real_info['buildNum'] == rc.build_identity(REPO)['product_build'] and real_info['buildTag'] == 'dev',
   rc.build_identity(REPO))
ident_cases = [
    ('tracked build-info back to the old local-257 file', lambda o: open(bi(o), 'w').write('{"buildDate":"2026-08-08","buildNum":257,"buildTag":"local-257"}'),
     ['build_info_number_drift', 'tracked_build_info_not_marked_unbuilt']),
    ('tracked build-info claims a built tag', lambda o: open(bi(o), 'w').write(json.dumps({**real_info, 'buildTag': '20260921-0000'})),
     ['tracked_build_info_not_marked_unbuilt']),
    ('bridge.py Build number bumped without build-info', lambda o: edit(os.path.join(o, 'irsdk-bridge', 'bridge.py'), 'BUILD_VERSION = "Build %s' % real_info['buildNum'], 'BUILD_VERSION = "Build %s' % (real_info['buildNum'] + 1)),
     ['build_info_number_drift']),
    ('BUILD_VERSION format the workflows cannot parse', lambda o: edit(os.path.join(o, 'irsdk-bridge', 'bridge.py'), 'BUILD_VERSION = "Build %s' % real_info['buildNum'], 'BUILD_VERSION = "B%s' % real_info['buildNum']),
     ['bridge_build_version_not_found']),
    ('main title/Support label stops using the shared reader', lambda o: edit(os.path.join(o, 'desktop', 'main.js'),
     "    return require('./build-identity.js').describe(info).label;", "    return info.buildNum != null ? 'Build ' + info.buildNum : '';"),
     ['main_label_not_using_shared_reader']),
    ('renderer badge/usage stops using the shared reader', lambda o: edit(os.path.join(o, 'desktop', 'renderer.html'),
     '  const bi = PitwallBuildIdentity.describe(info);', "  const bi = {label:'Build '+info.buildNum,usage_build:String(info.buildNum)};"),
     ['renderer_not_using_shared_reader']),
    ('unbuilt marker changed in the reader but not in checkForUpdate', lambda o: edit(os.path.join(o, 'desktop', 'build-identity.js'),
     "const UNBUILT_TAG = 'dev';", "const UNBUILT_TAG = 'source';"),
     ['update_check_marker_drift', 'tracked_build_info_not_marked_unbuilt']),
    ('desktop workflow writes the unbuilt marker as buildTag', lambda o: edit(wf(o, 'build-desktop.yml'),
     '`"buildTag`": `"${{ steps.date.outputs.DATE }}`"', '`"buildTag`": `"dev`"'),
     ['workflow_identity:build-desktop.yml']),
    ('store workflow buildNum from run_number, not bridge.py', lambda o: edit(wf(o, 'build-store-msix.yml'),
     "$buildMatch = [regex]::Match($bridgeSource, 'BUILD_VERSION\\s*=\\s*\"Build\\s+(\\d+)')", "$buildMatch = $null"),
     ['workflow_identity:build-store-msix.yml']),
    # parent interim P1: regex/derivation still present but the WRITTEN buildNum is a literal
    ('desktop writes literal 257 while still deriving $productBuild', lambda o: edit(wf(o, 'build-desktop.yml'),
     '`"buildNum`": $productBuild}"', '`"buildNum`": 257}"'), ['workflow_identity:build-desktop.yml']),
    ('store writes literal 257 while still deriving $productBuild', lambda o: edit(wf(o, 'build-store-msix.yml'),
     '`"buildNum`": $productBuild, ', '`"buildNum`": 257, '), ['workflow_identity:build-store-msix.yml']),
    # parent interim P1: the writer targets another file -> packaging with no build-info writer
    ('desktop writer redirected to desktop/not-build-info.json', lambda o: edit(wf(o, 'build-desktop.yml'),
     'Set-Content -Path desktop/build-info.json', 'Set-Content -Path desktop/not-build-info.json'), ['workflow_identity:build-desktop.yml']),
    ('store writer step deleted', lambda o: edit(wf(o, 'build-store-msix.yml'),
     'Set-Content -Path desktop/build-info.json', '# removed'), ['workflow_identity:build-store-msix.yml']),
    ('desktop packages before the writer runs', lambda o: edit(wf(o, 'build-desktop.yml'),
     '      - name: Write build-info.json (for in-app update check)\n',
     '      - name: Early dist\n        working-directory: desktop\n        run: npm run dist\n\n      - name: Write build-info.json (for in-app update check)\n'),
     ['workflow_identity:build-desktop.yml']),
]
for label, mutate, want in ident_cases:
    o = overlay()
    try:
        mutate(o)
        code, res, out = source(o)
        errs = res['build_identity']['errors']
        ok('RED identity: %s -> %s' % (label, want), code == 1 and 'build_identity' in res['failures'] and all(w in errs for w in want), errs)
    finally:
        shutil.rmtree(o, ignore_errors=True)
for label, mutate in [
        ('old Node bridge file restored', lambda o: shutil.copy2(os.path.join(o, 'irsdk-bridge', 'bridge.py'), os.path.join(o, 'irsdk-bridge', 'bridge.js'))),
        ('a start script launches the old Node bridge', lambda o: open(os.path.join(o, 'package.json'), 'w').write('{"scripts":{"bridge":"node irsdk-bridge/bridge.js"}}')),
        ('a workflow launches the old Node bridge', lambda o: edit(wf(o, 'build-bridge.yml'), '      - name: Build bridge EXE\n',
                                                                    '      - name: Old bridge\n        run: node irsdk-bridge/bridge.js\n\n      - name: Build bridge EXE\n'))]:
    o = overlay()
    try:
        mutate(o)
        code, res, out = source(o)
        ok('RED retired entry: %s -> retired_entry' % label, code == 1 and 'retired_entry' in res['failures'], res['retired_entries'])
    finally:
        shutil.rmtree(o, ignore_errors=True)
o = overlay()
try:
    # control: the same dataflow under another variable name is still recognised (not literal text)
    p = wf(o, 'build-store-msix.yml')
    renamed = open(p, encoding='utf-8').read().replace('$productBuild', '$pb')
    open(p, 'w', encoding='utf-8').write(renamed)
    code, res, out = source(o)
    ok('control: store writer with $productBuild renamed to $pb stays GREEN', code == 0 and res['build_identity']['ok'], res['build_identity']['errors'])
finally:
    shutil.rmtree(o, ignore_errors=True)
o = overlay()
try:
    # control: a different file whose name ends in "-bridge.js" is not the retired entry
    open(os.path.join(o, 'package.json'), 'w').write('{"scripts":{"t":"node tests-proposal-agreement-bridge.js"}}')
    code, res, out = source(o)
    ok('control: tests-proposal-agreement-bridge.js reference is not the retired entry', code == 0 and res['retired_entries']['ok'], res['retired_entries'])
finally:
    shutil.rmtree(o, ignore_errors=True)

print('WO020 runtime coverage: %d passed / %d failed' % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
