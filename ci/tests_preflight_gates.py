#!/usr/bin/env python3
"""Required checkers and the real shell syntax blocks must fail closed."""
from pathlib import Path
import os
import subprocess
import sys
import tempfile
ROOT=Path(__file__).resolve().parents[1]
checks=0

def check(label, ok):
    global checks
    if not ok: raise AssertionError(label)
    checks+=1

def run(args, **kw):
    return subprocess.run(args,capture_output=True,text=True,**kw)

with tempfile.TemporaryDirectory(prefix='preflight-gates-') as tmp:
    work=Path(tmp)
    for name,body,expected in [('valid.py','x=1\nprint(x)\n',0),('undefined.py','print(missing_symbol)\n',1),('syntax.py','if :\n',1)]:
        p=work/name;p.write_text(body)
        check(name,run([sys.executable,str(ROOT/'ci/preflight_static.py'),str(p)]).returncode==expected)
    check('missing source',run([sys.executable,str(ROOT/'ci/preflight_static.py'),str(work/'missing.py')]).returncode==1)
    package=work/'pyflakes';package.mkdir();(package/'__init__.py').write_text("raise ImportError('intentional missing required checker')\n")
    check('required pyflakes unavailable returns 2',run([sys.executable,str(ROOT/'ci/preflight_static.py')],env={**os.environ,'PYTHONPATH':str(work)}).returncode==2)
    src=(ROOT/'preflight.sh').read_text()
    start=src.index('for f in prompts.js');end=src.index('echo "── renderer.html',start);block=src[start:end]
    (work/'desktop').mkdir()
    for f in ['prompts.js','server.js','engineer-card.js','desktop/memory-action-layer.js','desktop/strategy-playbook.js']:
        (work/f).write_text('const valid=1;\n')
    def shell(block):
        return run(['bash','-c','set -uo pipefail; fail=0;\n'+block+'\nexit "$fail"'],cwd=work).returncode
    check('real JS syntax shell block positive',shell(block)==0)
    (work/'prompts.js').write_text('function ( broken\n')
    check('node syntax failure survives head pipeline',shell(block)!=0)
    start=src.index('PREFLIGHT_WORK=');end=src.index('echo "── preflight検査器',start);renderer_block=src[start:end]
    (work/'desktop/renderer.html').write_text('<script>const x=1;</script>')
    check('renderer all-inline extraction positive',shell(renderer_block)==0)
    (work/'desktop/renderer.html').write_text('<script>const x=1;</script><script>function ( invalid</script>')
    check('second inline syntax error detected',shell(renderer_block)!=0)
    (work/'desktop/renderer.html').write_text('<html>no script</html>')
    check('renderer extraction failure does not pass empty stale file',shell(renderer_block)!=0)
print('Preflight checker gates: %d checks PASS' % checks)
