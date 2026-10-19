#!/usr/bin/env python3
"""WO020 — one runtime-coverage contract shared by all three Windows build workflows.

The Bridge runtime inventory is DERIVED from the real local import graph of
irsdk-bridge/bridge.py (AST walk of every module it reaches: module-level, function-level,
try/except and importlib/__import__ literal imports). No hand-written module list exists here.

  python ci/runtime_coverage.py source   [--repo DIR] [--out DIR]
      inventory + per-module source import smoke + missing-import detection + renderer
      <script src> list vs desktop package `files` + Bridge trace self-check + workflow contract
      + WO021 build identity (tracked build-info.json = bridge.py Build number, marked unbuilt;
      shared reader; workflow writers) + retired entries (old Node bridge absent, not launched).
  python ci/runtime_coverage.py packaged --exe PATH [--listing FILE] [--same-as PATH] [--label L] [--out DIR]
      every inventory module must be inside the built PyInstaller EXE. The archive is listed with
      `pyi-archive_viewer --list --recursive --brief PATH` (PyInstaller "Using pyi-archive_viewer";
      --listing reads a saved listing instead). A listing in which the stdlib sentinels cannot be
      found is treated as UNRECOGNIZED and fails (never a silent pass).
  python ci/runtime_coverage.py workflows [--repo DIR]
      only the workflow contract (needs PyYAML).

Exit 0 = every check passed, 1 = a check failed, 2 = usage/tool error. Results are written as
machine-readable JSON (bounded: names, SHA-256, counts; no source text) to --out.
"""
import argparse
import ast
import datetime
import fnmatch
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys

SCHEMA = 'pitwall.runtime_coverage.v1'
REPO_DEFAULT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
BRIDGE_ENTRY = 'irsdk-bridge/bridge.py'
WORKFLOWS = ('build-bridge.yml', 'build-desktop.yml', 'build-store-msix.yml')
STDLIB_SENTINELS = ('json', 'asyncio')   # always bundled by PyInstaller for this entry point
SELF_PATHS = ('ci/runtime_coverage.py', 'desktop/scripts/verify-packaged-runtime.js', 'desktop/observability-trace.js',
              'tests-wo020-observability.js', 'irsdk-bridge/observability_trace.py')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


def git_sha(repo):
    if os.environ.get('GITHUB_SHA'):
        return os.environ['GITHUB_SHA']
    try:
        return subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True, timeout=10).stdout.strip() or None
    except Exception:
        return None


# ── inventory ────────────────────────────────────────────────────────────────

def _imports(tree):
    """(top-level name, guarded, how) for every import in the module, wherever it appears."""
    out = []

    def visit(node, guarded):
        for child in ast.iter_child_nodes(node):
            g = guarded or isinstance(node, ast.Try) or (hasattr(ast, 'TryStar') and isinstance(node, ast.TryStar))
            if isinstance(child, ast.Import):
                out.extend((a.name.split('.')[0], g, 'import') for a in child.names)
            elif isinstance(child, ast.ImportFrom):
                if child.level:
                    out.append(('.' * child.level + (child.module or ''), g, 'relative'))
                elif child.module:
                    out.append((child.module.split('.')[0], g, 'from'))
            elif isinstance(child, ast.Call):
                fn = child.func
                name = fn.attr if isinstance(fn, ast.Attribute) else (fn.id if isinstance(fn, ast.Name) else None)
                if name in ('import_module', '__import__'):
                    arg = child.args[0] if child.args else None
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                        out.append((arg.value.split('.')[0], g, 'dynamic_literal'))
                    else:
                        out.append(('<non-literal>', g, 'dynamic_unresolved'))
            visit(child, g)
    visit(tree, False)
    return out


def bridge_inventory(repo):
    bridge_dir = os.path.join(repo, 'irsdk-bridge')
    entry = os.path.splitext(os.path.basename(BRIDGE_ENTRY))[0]
    stdlib = set(getattr(sys, 'stdlib_module_names', ())) | set(sys.builtin_module_names)
    local, external, problems = {}, {}, []
    todo = [(entry, None)]
    while todo:
        name, parent = todo.pop()
        if name in local:
            local[name]['imported_by'] = sorted(set(local[name]['imported_by'] + ([parent] if parent else [])))
            continue
        path = os.path.join(bridge_dir, name + '.py')
        try:
            src = open(path, encoding='utf-8').read()
            tree = ast.parse(src, filename=path)
        except (OSError, SyntaxError) as e:
            problems.append({'kind': 'unreadable_local_module', 'module': name, 'imported_by': parent, 'error': type(e).__name__})
            continue
        local[name] = {'path': 'irsdk-bridge/' + name + '.py', 'sha256': sha256(path), 'bytes': len(src.encode('utf-8')),
                       'imported_by': [parent] if parent else []}
        for dep, guarded, how in _imports(tree):
            if how == 'relative':
                problems.append({'kind': 'relative_import_unsupported', 'module': name, 'target': dep})
            elif how == 'dynamic_unresolved':
                problems.append({'kind': 'dynamic_import_unresolved', 'module': name})
            elif os.path.isfile(os.path.join(bridge_dir, dep + '.py')):
                todo.append((dep, name))
            elif os.path.isdir(os.path.join(bridge_dir, dep)):
                problems.append({'kind': 'local_package_unsupported', 'module': name, 'target': dep})
            elif dep in stdlib:
                continue
            else:
                rec = external.setdefault(dep, {'imported_by': [], 'guarded': True})
                rec['imported_by'] = sorted(set(rec['imported_by'] + [name]))
                rec['guarded'] = rec['guarded'] and guarded
    return {'entry': BRIDGE_ENTRY, 'local_modules': dict(sorted(local.items())), 'external': dict(sorted(external.items())),
            'problems': problems}


def _resolvable_outside(dep, bridge_dir):
    saved = list(sys.path)
    try:
        sys.path[:] = [p for p in saved if os.path.abspath(p or '.') != os.path.abspath(bridge_dir)]
        return importlib.util.find_spec(dep) is not None
    except (ImportError, ValueError):
        return False
    finally:
        sys.path[:] = saved


def workflow_pip_packages(repo):
    """Third-party packages every build workflow installs (union of `pip install` lines)."""
    pkgs = {}
    for wf in WORKFLOWS:
        p = os.path.join(repo, '.github', 'workflows', wf)
        if not os.path.isfile(p):
            continue
        for m in re.finditer(r'pip install (?!--upgrade pip)([^\n]+)', open(p, encoding='utf-8').read()):
            for tok in m.group(1).split():
                if not tok.startswith('-'):
                    pkgs.setdefault(wf, set()).add(tok.lower())
    return pkgs


def classify_external(inv, repo):
    bridge_dir = os.path.join(repo, 'irsdk-bridge')
    pip = workflow_pip_packages(repo)
    every = set.intersection(*pip.values()) if pip else set()
    out = {}
    for dep, rec in inv['external'].items():
        here = _resolvable_outside(dep, bridge_dir)
        in_all = dep.lower() in every
        status = 'installed_here' if here else ('installed_by_every_workflow' if in_all else 'missing')
        if here and not in_all:
            status = 'installed_here_but_not_by_every_workflow'
        out[dep] = dict(rec, status=status)
    return out


# ── source checks ────────────────────────────────────────────────────────────

def import_smoke(repo, modules, timeout=60):
    bridge_dir = os.path.join(repo, 'irsdk-bridge')
    results = {}
    for name in modules:
        code = 'import sys; sys.path.insert(0, %r); import %s' % (bridge_dir, name)
        try:
            p = subprocess.run([sys.executable, '-c', code], cwd=bridge_dir, capture_output=True, text=True, timeout=timeout,
                               env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
            err = (p.stderr.strip().splitlines() or [''])[-1][:200]
            results[name] = {'ok': p.returncode == 0, 'error': None if p.returncode == 0 else err}
        except subprocess.TimeoutExpired:
            results[name] = {'ok': False, 'error': 'timeout'}
    return results


def renderer_scripts(repo):
    html = open(os.path.join(repo, 'desktop', 'renderer.html'), encoding='utf-8').read()
    scripts = [s for s in re.findall(r'<script\s+src="([^"]+\.js)"', html) if not re.match(r'^(?:https?:)?//', s, re.I)]
    pkg = json.load(open(os.path.join(repo, 'desktop', 'package.json'), encoding='utf-8'))
    patterns = (pkg.get('build') or {}).get('files') or []
    rows = []
    for s in scripts:
        path = os.path.join(repo, 'desktop', s)
        rows.append({'src': s, 'exists': os.path.isfile(path), 'sha256': sha256(path) if os.path.isfile(path) else None,
                     'packaged_by_files_glob': any(fnmatch.fnmatch(s, p) for p in patterns if not p.startswith('!'))})
    return {'scripts': rows, 'files_patterns': patterns,
            'missing': [r['src'] for r in rows if not r['exists']],
            'not_packaged': [r['src'] for r in rows if not r['packaged_by_files_glob']]}


def bridge_trace_selfcheck(repo):
    sys.path.insert(0, os.path.join(repo, 'irsdk-bridge'))
    try:
        import observability_trace
        r = observability_trace.selfcheck()
        return {'ok': r['lifecycle_emitted'] == 2 and not r['text_leaked'] and r['events_kept'] <= 8, **r}
    except Exception as e:  # noqa: BLE001 - reported, fails the check
        return {'ok': False, 'error': repr(e)[:200]}
    finally:
        sys.path.pop(0)


# ── WO021: build identity and retired entry points ───────────────────────────

# The exact pattern the Desktop/Store workflows use to derive buildNum from bridge.py.
BUILD_VERSION_RE = r'BUILD_VERSION\s*=\s*"Build\s+(\d+)'
BUILD_INFO = 'desktop/build-info.json'
BUILD_READER = 'desktop/build-identity.js'
# Retired runtime entries: must stay absent and must not be launched from any build/start surface.
RETIRED_ENTRIES = {'irsdk-bridge/bridge.js': r'(?<![\w.-])bridge\.js\b'}
LAUNCH_SURFACES = ('package.json', 'desktop/package.json', 'preflight.sh', 'desktop/main.js', 'desktop/preload.js',
                   'irsdk-bridge/START-STRATEGY-LOGGER.bat', 'irsdk-bridge/installer.iss')


def _read(repo, rel):
    try:
        return open(os.path.join(repo, rel), encoding='utf-8').read()
    except (FileNotFoundError, UnicodeDecodeError):
        return None


WRITE_BUILD_INFO = 'Set-Content -Path ' + BUILD_INFO + ' -Value '
DESKTOP_PACKAGERS = ('build-desktop.yml', 'build-store-msix.yml')   # each must write build-info before packaging
PACKAGING = re.compile(r'\bnpm run dist(?::\w+)?\b')


def workflow_build_info_writer(text, marker):
    """None = the workflow neither packages the desktop app nor writes build-info.json.
    Otherwise the list of problems ([] = ok). A workflow that packages (`npm run dist*`) must have
    exactly one build-info writer step BEFORE packaging, and inside that step the written buildNum
    must be the value derived from bridge.py by BUILD_VERSION_RE (PowerShell dataflow:
    Get-Content bridge.py -> [regex]::Match -> [int] Groups[1] -> buildNum), with a build-specific
    (expression, not the unbuilt marker) buildTag."""
    pack = PACKAGING.search(text)
    n_writes = text.count(WRITE_BUILD_INFO)
    if not pack and not n_writes and BUILD_INFO not in text:
        return None
    wrong = []
    if n_writes != 1:
        wrong.append('build_info_writer_count_%d' % n_writes)
    at = text.find(WRITE_BUILD_INFO)
    if pack and (at < 0 or at > pack.start()):
        wrong.append('packaging_without_prior_build_info_writer')
    if at >= 0:
        starts = [m.start() for m in re.finditer(r'\n\s*- name:', text)]
        lo = max([s for s in starts if s < at] or [0])
        hi = min([s for s in starts if s > at] or [len(text)])
        step = text[lo:hi]
        src = re.search(r'\$(\w+)\s*=\s*Get-Content\b[^\n]*\birsdk-bridge/bridge\.py\b', step)
        mat = src and re.search(r'\$(\w+)\s*=\s*\[regex\]::Match\(\$%s,\s*\'%s\'\)' % (src.group(1), re.escape(BUILD_VERSION_RE)), step)
        num = mat and re.search(r'\$(\w+)\s*=\s*\[int\]\$%s\.Groups\[1\]\.Value' % mat.group(1), step)
        line = step[step.find(WRITE_BUILD_INFO):].split('\n', 1)[0]
        if not num or not re.search(r'buildNum`":\s*\$%s(?!\w)' % num.group(1), line):
            wrong.append('build_num_not_from_bridge_version')
        tags = re.findall(r'buildTag`":\s*`"([^`]*)`"', line)
        if len(tags) != 1 or tags[0] == marker or '${{' not in tags[0]:
            wrong.append('packaged_build_tag_not_build_specific')
    return wrong


def build_identity(repo):
    """Tracked source identity == bridge.py product number, explicitly unbuilt; every reader and
    every workflow that writes build-info.json follows the same number source and marker."""
    errors = []
    m = re.search(BUILD_VERSION_RE, _read(repo, BRIDGE_ENTRY) or '')
    product = int(m.group(1)) if m else None
    if product is None:
        errors.append('bridge_build_version_not_found')
    reader = _read(repo, BUILD_READER) or ''
    mk = re.search(r"UNBUILT_TAG\s*=\s*'([^']+)'", reader)
    marker = mk.group(1) if mk else None
    if marker is None:
        errors.append('unbuilt_marker_not_found')
    try:
        info = json.loads(_read(repo, BUILD_INFO) or 'null')
    except ValueError:
        info = None
    if not isinstance(info, dict):
        errors.append('build_info_unreadable')
        info = {}
    if info.get('buildNum') != product:
        errors.append('build_info_number_drift')
    if marker is not None and info.get('buildTag') != marker:
        errors.append('tracked_build_info_not_marked_unbuilt')
    main = _read(repo, 'desktop/main.js') or ''
    label_fn = re.search(r'function currentBuildLabel\(\) \{[\s\S]*?\n\}', main)
    if not label_fn or "require('./build-identity.js').describe(" not in label_fn.group(0):
        errors.append('main_label_not_using_shared_reader')
    if marker is not None and ("buildTag === '%s'" % marker) not in main:
        errors.append('update_check_marker_drift')
    html = _read(repo, 'desktop/renderer.html') or ''
    if '<script src="build-identity.js"></script>' not in html or 'PitwallBuildIdentity.describe(info)' not in html:
        errors.append('renderer_not_using_shared_reader')
    writers = {}
    for wf in WORKFLOWS:
        text = _read(repo, '.github/workflows/' + wf) or ''
        r = workflow_build_info_writer(text, marker)
        if r is None and wf in DESKTOP_PACKAGERS:
            r = ['desktop_packaging_workflow_without_build_info_writer']
        if r is None:
            continue
        writers[wf] = r
        if r:
            errors.append('workflow_identity:' + wf)
    return {'product_build': product, 'unbuilt_marker': marker,
            'tracked_build_info': {k: info.get(k) for k in ('buildNum', 'buildTag', 'channel')},
            'workflow_writers': writers, 'errors': errors, 'ok': not errors}


def retired_entries(repo):
    report, ok = {}, True
    for rel, pattern in RETIRED_ENTRIES.items():
        refs = []
        for surf in LAUNCH_SURFACES + tuple('.github/workflows/' + w for w in WORKFLOWS):
            text = _read(repo, surf)
            if text and re.search(pattern, text):
                refs.append(surf)
        present = os.path.exists(os.path.join(repo, rel))
        report[rel] = {'present': present, 'launch_references': refs}
        ok = ok and not present and not refs
    return {'entries': report, 'ok': ok}


# ── workflow contract ────────────────────────────────────────────────────────

def _glob_re(pattern):
    """GitHub Actions path filter glob -> regex (`*` within a segment, `**` across segments)."""
    out, i = '', 0
    while i < len(pattern):
        if pattern.startswith('**/', i):
            out += '(?:.*/)?'
            i += 3
        elif pattern.startswith('**', i):
            out += '.*'
            i += 2
        elif pattern[i] == '*':
            out += '[^/]*'
            i += 1
        elif pattern[i] == '?':
            out += '[^/]'
            i += 1
        else:
            out += re.escape(pattern[i])
            i += 1
    return re.compile('^' + out + '$')


def paths_match(patterns, path):
    """Last matching pattern wins; `!` negates (GitHub on.push.paths semantics)."""
    hit = False
    for p in patterns:
        neg = p.startswith('!')
        if _glob_re(p[1:] if neg else p).match(path):
            hit = not neg
    return hit


def _steps(doc):
    jobs = doc.get('jobs') or {}
    return [s for job in jobs.values() for s in (job.get('steps') or [])]


def _step_runs(step, needle):
    return needle in str(step.get('run') or '')


def workflow_contract(repo, inv):
    try:
        import yaml
    except ImportError:
        return {'ran': False, 'reason': 'pyyaml_not_installed', 'ok': None}
    must_trigger = sorted(set(m['path'] for m in inv['local_modules'].values()) | set(SELF_PATHS))
    report = {'ran': True, 'workflows': {}}
    all_ok = True
    for wf in WORKFLOWS:
        rel = '.github/workflows/' + wf
        path = os.path.join(repo, rel)
        if not os.path.isfile(path):
            report['workflows'][wf] = {'ok': False, 'errors': ['workflow_missing']}
            all_ok = False
            continue
        doc = yaml.safe_load(open(path, encoding='utf-8'))
        on = doc.get('on', doc.get(True)) or {}
        steps = _steps(doc)
        errors = []
        idx = {name: i for i, s in enumerate(steps) for name in [s.get('name')]}
        py_build = [i for i, s in enumerate(steps) if _step_runs(s, 'pyinstaller') and _step_runs(s, BRIDGE_ENTRY)]
        src_chk = [i for i, s in enumerate(steps) if _step_runs(s, 'ci/runtime_coverage.py source')]
        pkg_chk = [i for i, s in enumerate(steps) if _step_runs(s, 'ci/runtime_coverage.py packaged') and _step_runs(s, '--exe dist/OMORAY-PITWALL-Bridge.exe')]
        # The workflow contract is a required check in CI: its checker dependency must be
        # installed and the source step must refuse to skip it.
        if src_chk and not any(_step_runs(steps[i], '--require-workflows') for i in src_chk):
            errors.append('source_check_may_skip_workflow_contract')
        if not any(re.search(r'pip install [^\n]*\bpyyaml\b', str(s.get('run') or ''), re.I) for s in steps):
            errors.append('pyyaml_not_installed_for_workflow_contract')
        if not py_build:
            errors.append('no_pyinstaller_bridge_build_step')
        else:
            if not src_chk or min(src_chk) > py_build[0]:
                errors.append('source_coverage_not_before_pyinstaller')
            if not pkg_chk or max(pkg_chk) < py_build[0]:
                errors.append('packaged_coverage_not_after_pyinstaller')
        uploads = [s for s in steps if str(s.get('uses') or '').startswith('actions/upload-artifact')]
        cov_upload = [s for s in uploads if 'ci-artifacts' in str((s.get('with') or {}).get('path') or '')]
        if not cov_upload:
            errors.append('coverage_artifact_not_uploaded')
        elif str(cov_upload[0].get('if') or '') != 'always()':
            errors.append('coverage_artifact_upload_not_always')
        if any(_step_runs(s, 'npm run dist') for s in steps):
            bundled = [s for s in steps if _step_runs(s, 'ci/runtime_coverage.py packaged') and _step_runs(s, 'win-unpacked/resources/OMORAY-PITWALL-Bridge.exe')]
            renderer = [s for s in steps if _step_runs(s, 'verify-packaged-runtime.js') and _step_runs(s, '--json')]
            if not bundled:
                errors.append('desktop_bundled_bridge_not_verified')
            if not renderer:
                errors.append('desktop_renderer_runtime_json_not_saved')
            if not any(_step_runs(s, 'tests-wo020-observability.js') for s in steps):
                errors.append('observability_selfcheck_not_run')
        push = on.get('push') if isinstance(on, dict) else None
        paths_status = 'not_applicable_dispatch_only'
        uncovered = []
        if push is not None:
            pats = (push or {}).get('paths') or []
            uncovered = [p for p in must_trigger + [rel] if not paths_match(pats, p)]
            paths_status = 'covered' if not uncovered else 'uncovered'
            if uncovered:
                errors.append('push_paths_miss_runtime_files')
        report['workflows'][wf] = {'ok': not errors, 'errors': errors, 'paths': paths_status, 'uncovered_paths': uncovered[:40],
                                   'sha256': sha256(path)}
        all_ok = all_ok and not errors
    report['ok'] = all_ok
    return report


# ── packaged check ───────────────────────────────────────────────────────────

def parse_archive_listing(text):
    """Names in a `pyi-archive_viewer --list --recursive --brief` listing. Tolerant on layout
    (indentation, nested archive prefixes, path separators); the caller decides recognition."""
    names = set()
    for line in str(text or '').splitlines():
        for tok in line.split():
            tok = tok.strip().strip(',;\'"')
            if not tok:
                continue
            names.add(tok)
            for seg in re.split(r'[\\/]', tok):
                if seg:
                    names.add(seg)
                    names.add(re.sub(r'\.(pyc|py|pyo)$', '', seg))
    return names


def packaged_check(repo, inv, listing_text):
    names = parse_archive_listing(listing_text)
    recognized = all(s in names for s in STDLIB_SENTINELS)
    modules = sorted(inv['local_modules'])
    missing = [m for m in modules if m not in names]
    externals = sorted(d for d, r in inv['external'].items() if not r['guarded'])
    return {'recognized': recognized, 'names_seen': len(names), 'modules_expected': len(modules),
            'missing_local_modules': missing if recognized else modules,
            'missing_required_external': [d for d in externals if d not in names] if recognized else externals,
            'ok': recognized and not missing and all(d in names for d in externals)}


def list_archive(exe):
    cmd = ['pyi-archive_viewer', '--list', '--recursive', '--brief', exe]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL)
    return cmd, p.returncode, p.stdout, p.stderr[-2000:]


# ── main ─────────────────────────────────────────────────────────────────────

def write(out_dir, name, payload):
    if not out_dir:
        return None
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, name)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1, default=str)
    return path


def cmd_source(a):
    repo = os.path.abspath(a.repo)
    inv = bridge_inventory(repo)
    ext = classify_external(inv, repo)
    smoke = import_smoke(repo, list(inv['local_modules']))
    ren = renderer_scripts(repo)
    trace = bridge_trace_selfcheck(repo)
    wfs = workflow_contract(repo, inv)
    ident = build_identity(repo)
    retired = retired_entries(repo)
    failures = []
    if inv['problems']:
        failures.append('inventory_problems')
    if any(r['status'] == 'missing' for r in ext.values()):
        failures.append('missing_import')
    if any(r['status'] == 'installed_here_but_not_by_every_workflow' and not r['guarded'] for r in ext.values()):
        failures.append('external_dependency_not_installed_by_every_workflow')
    if not all(r['ok'] for r in smoke.values()):
        failures.append('source_import_smoke')
    if ren['missing'] or ren['not_packaged']:
        failures.append('renderer_runtime_script')
    if not trace.get('ok'):
        failures.append('bridge_trace_selfcheck')
    if wfs.get('ok') is False or (a.require_workflows and not wfs.get('ran')):
        failures.append('workflow_contract')
    if not ident['ok']:
        failures.append('build_identity')
    if not retired['ok']:
        failures.append('retired_entry')
    result = {'schema': SCHEMA, 'mode': 'source', 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'git_sha': git_sha(repo), 'python': sys.version.split()[0], 'platform': sys.platform,
              'inventory': {**inv, 'external': ext}, 'import_smoke': smoke, 'renderer_runtime': ren,
              'bridge_trace_selfcheck': {k: v for k, v in trace.items() if k != 'snapshot'},
              'bridge_trace_sample': trace.get('snapshot'), 'workflow_contract': wfs,
              'build_identity': ident, 'retired_entries': retired,
              'failures': failures, 'ok': not failures,
              'evidence_level': 'source checkout (not a packaged artifact)'}
    write(a.out, 'runtime-coverage-source.json', result)
    print('runtime coverage (source): %d local modules, %d external, smoke %d/%d, renderer scripts %d, workflows %s -> %s' % (
        len(inv['local_modules']), len(ext), sum(r['ok'] for r in smoke.values()), len(smoke), len(ren['scripts']),
        'ok' if wfs.get('ok') else ('not_run' if not wfs.get('ran') else 'FAIL'), 'OK' if not failures else 'FAIL ' + ','.join(failures)))
    for k, r in ext.items():
        if r['status'] == 'missing':
            print('  missing import: %s (imported by %s)' % (k, ', '.join(r['imported_by'])))
    for k, r in smoke.items():
        if not r['ok']:
            print('  import smoke failed: %s: %s' % (k, r['error']))
    for wf, r in (wfs.get('workflows') or {}).items():
        if not r['ok']:
            print('  workflow %s: %s %s' % (wf, r['errors'], r.get('uncovered_paths', [])[:5]))
    print('  build identity: Build %s, tracked %s -> %s' % (ident['product_build'], ident['tracked_build_info'],
                                                            'ok' if ident['ok'] else 'FAIL ' + ','.join(ident['errors'])))
    for rel, r in retired['entries'].items():
        if r['present'] or r['launch_references']:
            print('  retired entry %s: present=%s referenced_by=%s' % (rel, r['present'], r['launch_references']))
    return 0 if not failures else 1


def cmd_packaged(a):
    repo = os.path.abspath(a.repo)
    inv = bridge_inventory(repo)
    if a.listing:
        listing, tool = open(a.listing, encoding='utf-8', errors='replace').read(), {'source': 'saved_listing', 'path': a.listing}
        tool_ok = True
    else:
        if not os.path.isfile(a.exe):
            print('packaged EXE not found: ' + a.exe)
            write(a.out, 'runtime-coverage-packaged-%s.json' % a.label, {'schema': SCHEMA, 'mode': 'packaged', 'label': a.label, 'ok': False, 'error': 'exe_missing'})
            return 1
        cmd, code, listing, err = list_archive(a.exe)
        tool = {'source': 'pyi-archive_viewer', 'argv': cmd, 'exit': code, 'stderr_tail': err}
        tool_ok = code == 0
        if a.out:
            os.makedirs(a.out, exist_ok=True)
            with open(os.path.join(a.out, 'bridge-archive-listing-%s.txt' % a.label), 'w', encoding='utf-8') as f:
                f.write(listing)
    chk = packaged_check(repo, inv, listing)
    same = None
    if a.same_as:
        same = {'other': a.same_as, 'equal': os.path.isfile(a.exe) and os.path.isfile(a.same_as) and sha256(a.exe) == sha256(a.same_as)}
    ok = tool_ok and chk['ok'] and (same is None or same['equal'])
    result = {'schema': SCHEMA, 'mode': 'packaged', 'label': a.label, 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'git_sha': git_sha(repo), 'exe': a.exe, 'exe_sha256': sha256(a.exe) if a.exe and os.path.isfile(a.exe) else None,
              'tool': tool, 'check': chk, 'same_as': same, 'inventory_modules': sorted(inv['local_modules']),
              'ok': ok, 'evidence_level': 'saved listing' if a.listing else 'packaged artifact listing'}
    write(a.out, 'runtime-coverage-packaged-%s.json' % a.label, result)
    print('runtime coverage (packaged %s): recognized=%s missing=%s tool_ok=%s same=%s -> %s' % (
        a.label, chk['recognized'], chk['missing_local_modules'][:10], tool_ok, same and same['equal'], 'OK' if ok else 'FAIL'))
    return 0 if ok else 1


def cmd_workflows(a):
    repo = os.path.abspath(a.repo)
    r = workflow_contract(repo, bridge_inventory(repo))
    print(json.dumps(r, ensure_ascii=False, indent=1)[:4000])
    return 0 if r.get('ok') else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('source')
    s.add_argument('--repo', default=REPO_DEFAULT)
    s.add_argument('--out')
    s.add_argument('--require-workflows', action='store_true', help='fail if PyYAML is missing (local preflight)')
    p = sub.add_parser('packaged')
    p.add_argument('--repo', default=REPO_DEFAULT)
    p.add_argument('--exe', default='dist/OMORAY-PITWALL-Bridge.exe')
    p.add_argument('--listing')
    p.add_argument('--same-as')
    p.add_argument('--label', default='bridge')
    p.add_argument('--out')
    w = sub.add_parser('workflows')
    w.add_argument('--repo', default=REPO_DEFAULT)
    a = ap.parse_args(argv)
    return {'source': cmd_source, 'packaged': cmd_packaged, 'workflows': cmd_workflows}[a.cmd](a)


if __name__ == '__main__':
    sys.exit(main())
