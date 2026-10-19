#!/usr/bin/env python3
"""Gate5 artifact selection, measured manifest comparison and installer extraction.

No network. The shell caller fetches run metadata; these checks fail closed.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def select(data, build):
    pages = data if isinstance(data, list) else [data]
    rows = [r for page in pages for r in page.get('artifacts', [])]
    pattern = re.compile(r'^OMORAY-PITWALL-Desktop-Build-' + re.escape(str(build)) + r'-[0-9]{8}-[0-9]{4}$')
    found = [r for r in rows if isinstance(r, dict) and pattern.fullmatch(str(r.get('name', '')))]
    if len(found) != 1:
        raise ValueError('target installer artifact missing or ambiguous: %d' % len(found))
    row = found[0]
    if row.get('expired') is not False:
        raise ValueError('target artifact expired or expiry status missing')
    for key in ('id', 'size_in_bytes'):
        if type(row.get(key)) is not int or row[key] <= 0:
            raise ValueError('artifact invalid ' + key)
    return row


def verify_manifest(manifest, installer, resources, sha, build):
    if manifest.get('target_sha') != sha:
        raise ValueError('manifest target_sha mismatch')
    if type(manifest.get('product_build')) is not int or manifest['product_build'] != int(build):
        raise ValueError('manifest product_build mismatch')
    tag = manifest.get('build_tag')
    if not isinstance(tag, str) or not tag.strip() or tag == 'dev':
        raise ValueError('manifest build_tag missing/unbuilt')
    failures = []
    for key, path in (('installer', Path(installer)), ('app_asar', Path(resources) / 'app.asar'),
                      ('bridge', Path(resources) / 'OMORAY-PITWALL-Bridge.exe')):
        expected = manifest.get(key)
        if not path.is_file() or path.stat().st_size <= 0:
            failures.append(key + ' missing/empty'); continue
        if not isinstance(expected, dict):
            failures.append(key + ' manifest missing'); continue
        actual_bytes = path.stat().st_size
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        match = type(expected.get('bytes')) is int and actual_bytes == expected['bytes'] and digest == str(expected.get('sha256', '')).lower()
        print(('OK ' if match else 'FAIL ') + '%s bytes=%s sha256=%s' % (key, actual_bytes, digest))
        if not match:
            failures.append(key + ' bytes/hash mismatch')
    if failures:
        raise ValueError('; '.join(failures))


def extract(installer, output):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    tool = shutil.which('7zz') or shutil.which('7z')
    with tempfile.TemporaryDirectory(prefix='gate5-extract-', dir=output) as tmp:
        root = Path(tmp)
        direct = root / 'direct'; direct.mkdir()
        tar = shutil.which('bsdtar')
        if tar:
            subprocess.run([tar, '-xf', str(Path(installer).resolve()), '-C', str(direct), 'resources'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def candidates(where):
            return [p.parent for p in where.rglob('app.asar') if p.parent.name == 'resources'
                    and p.is_file() and p.stat().st_size > 0 and (p.parent / 'OMORAY-PITWALL-Bridge.exe').is_file()
                    and (p.parent / 'OMORAY-PITWALL-Bridge.exe').stat().st_size > 0]
        dirs = candidates(direct)
        if not dirs:
            if not tool:
                raise ValueError('NSIS extraction requires 7zz/7z; checker unavailable')
            outer = root / 'outer'
            result = subprocess.run([tool, 'x', '-y', '-o' + str(outer), str(Path(installer).resolve())], capture_output=True, text=True)
            if result.returncode:
                raise ValueError('installer archive extraction failed')
            dirs = candidates(outer)
            if not dirs:
                payloads = list(outer.rglob('app-64.7z'))
                if len(payloads) != 1:
                    raise ValueError('NSIS app-64.7z missing or ambiguous')
                inner = root / 'inner'
                result = subprocess.run([tool, 'x', '-y', '-o' + str(inner), str(payloads[0])], capture_output=True, text=True)
                if result.returncode:
                    raise ValueError('NSIS application payload extraction failed')
                dirs = candidates(inner)
        if len(dirs) != 1:
            raise ValueError('resources missing or ambiguous')
        destination = output / 'resources'
        if destination.exists():
            raise ValueError('extraction destination already exists (use an empty directory)')
        shutil.copytree(dirs[0], destination)
        print('OK resources extracted from installer')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    p = sub.add_parser('select'); p.add_argument('--build', required=True); p.add_argument('--json', required=True)
    p = sub.add_parser('manifest'); p.add_argument('--manifest', required=True); p.add_argument('--installer', required=True); p.add_argument('--resources', required=True); p.add_argument('--sha', required=True); p.add_argument('--build', required=True)
    p = sub.add_parser('extract'); p.add_argument('--installer', required=True); p.add_argument('--out', required=True)
    args = parser.parse_args()
    try:
        if args.mode == 'select':
            data = json.loads(sys.stdin.read()) if args.json == '-' else json.loads(Path(args.json).read_text(encoding='utf-8-sig'))
            row = select(data, args.build)
            print('%s\t%s\t%s' % (row['id'], row['name'], row['size_in_bytes']))
        elif args.mode == 'manifest':
            verify_manifest(json.loads(Path(args.manifest).read_text(encoding='utf-8-sig')), args.installer, args.resources, args.sha, args.build)
        else:
            extract(args.installer, args.out)
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
        print('FAIL artifact gate: ' + str(exc), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
