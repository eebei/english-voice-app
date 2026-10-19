#!/usr/bin/env python3
"""Execute real Gate5 helpers and shell manifest propagation; no GitHub calls.

Archives below reproduce direct portable resources and the NSIS payload layout
($PLUGINSDIR/app-64.7z). They are archive-layout fixtures, not Windows installers.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile
import artifact_gate as gate

ROOT = Path(__file__).resolve().parents[1]
passed = 0

def check(name, cond):
    global passed
    if not cond:
        raise AssertionError(name)
    passed += 1

def rejected(name, fn):
    try:
        fn()
    except (ValueError, OSError, KeyError, TypeError):
        check(name, True)
    else:
        raise AssertionError(name + ': false GREEN')

row = {'id': 8, 'name': 'OMORAY-PITWALL-Desktop-Build-303-20261019-1200', 'size_in_bytes': 100, 'expired': False}
noise = {'id': 7, 'name': 'WO020-runtime-coverage', 'size_in_bytes': 10, 'expired': False}
check('coverage artifact first still selects installer', gate.select({'artifacts': [noise, row]}, 303)['id'] == 8)
check('pagination finds installer after first page', gate.select([{'artifacts': [noise]}, {'artifacts': [row]}], 303)['id'] == 8)
for name, data in [('missing', {'artifacts':[noise]}), ('wrong Build', {'artifacts':[row]}), ('ambiguous', {'artifacts':[row,row]})]:
    rejected('selection '+name, lambda d=data,b=302 if name=='wrong Build' else 303:gate.select(d,b))
for key, value in [('expired',True),('expired',None),('id',0),('size_in_bytes',0),('size_in_bytes',True)]:
    rejected('invalid metadata '+key+str(value), lambda k=key,v=value:gate.select({'artifacts':[{**row,k:v}]},303))

with tempfile.TemporaryDirectory(prefix='gate5-test-') as tmp:
    base=Path(tmp);res=base/'resources';res.mkdir();(res/'app.asar').write_bytes(b'asar fixture bytes');(res/'OMORAY-PITWALL-Bridge.exe').write_bytes(b'bridge fixture bytes');installer=base/'Setup.exe';installer.write_bytes(b'installer fixture bytes')
    manifest={'target_sha':'a'*40,'product_build':303,'build_tag':'20261019-1200'}
    for key,p in [('installer',installer),('app_asar',res/'app.asar'),('bridge',res/'OMORAY-PITWALL-Bridge.exe')]:
        manifest[key]={'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
    gate.verify_manifest(manifest,installer,res,'a'*40,303);check('measured manifest normal',True)
    for key in ['installer','app_asar','bridge']:
        for field,val in [('bytes',1),('sha256','0'*64)]:
            m=copy.deepcopy(manifest);m[key][field]=val
            rejected(key+' '+field+' mismatch',lambda m=m:gate.verify_manifest(m,installer,res,'a'*40,303))
    for key,value in [('target_sha','b'*40),('product_build',302),('product_build',True),('build_tag','dev')]:
        rejected('manifest '+key, lambda k=key,v=value:gate.verify_manifest({**manifest,k:v},installer,res,'a'*40,303))
    m=dict(manifest);del m['bridge'];rejected('manifest required member missing',lambda:gate.verify_manifest(m,installer,res,'a'*40,303))
    rejected('measured file missing',lambda:gate.verify_manifest(manifest,installer,base/'missing','a'*40,303))
    # Run the production shell block, including its || fail=1, not a copied checker.
    script=(ROOT/'verify-artifact.sh').read_text();start=script.index('MANI="$WORK/extracted/BUILD-');end=script.index('# ── 7.',start);block=script[start:end]
    work=base/'shell';(work/'extracted').mkdir(parents=True);mp=work/'extracted/BUILD-303-GATE5-MANIFEST.json'
    def shell(m):
        if m is None:
            if mp.exists():mp.unlink()
        else:mp.write_text(json.dumps(m),encoding='utf-8-sig')
        env=dict(os.environ,WORK=str(work),BUILD_NUM='303',HEAD_SHA='a'*40,INST=str(installer),R=str(res))
        return subprocess.run(['bash','-c','set -u; fail=0; bad(){ echo "BAD $1"; fail=1; };\n'+block+'\nexit "$fail"'],cwd=ROOT,env=env,capture_output=True,text=True).returncode
    check('production shell manifest positive',shell(manifest)==0)
    for key in ['installer','app_asar','bridge']:
        m=copy.deepcopy(manifest);m[key]['sha256']='0'*64;check('production shell propagates '+key+' mismatch',shell(m)!=0)
    check('production shell missing manifest RED',shell(None)!=0)
    other=work/'extracted/BUILD-302-GATE5-MANIFEST.json';other.write_text('{}');check('production shell multiple manifests RED',shell(manifest)!=0);other.unlink()
    # Real tools, real nested archives. Absence of 7z is a required checker failure.
    tool=shutil.which('7zz') or shutil.which('7z');check('required extraction test tool present',bool(tool))
    portable=base/'portable.exe'
    with zipfile.ZipFile(portable,'w') as z:
        for p in res.iterdir():z.write(p,'resources/'+p.name)
    out=base/'portable-out';gate.extract(portable,out);check('portable resources actual bytes', (out/'resources/app.asar').read_bytes()==(res/'app.asar').read_bytes())
    plugins=base/'nested'/'$PLUGINSDIR';plugins.mkdir(parents=True)
    archive=plugins/'app-64.7z';result=subprocess.run([tool,'a','-t7z',str(archive),'resources'],cwd=base,capture_output=True);check('7z fixture built',result.returncode==0)
    nested=base/'nested.exe'
    with zipfile.ZipFile(nested,'w') as z:z.write(archive,'$PLUGINSDIR/app-64.7z')
    out=base/'nested-out';gate.extract(nested,out);check('NSIS-layout nested payload bytes',(out/'resources/OMORAY-PITWALL-Bridge.exe').read_bytes()==(res/'OMORAY-PITWALL-Bridge.exe').read_bytes())
    unknown=base/'unknown.exe';unknown.write_bytes(b'not an archive');rejected('unrecognized installer fails closed',lambda:gate.extract(unknown,base/'unknown-out'))
    no_payload=base/'no-payload.exe'
    with zipfile.ZipFile(no_payload,'w') as z:z.writestr('$PLUGINSDIR/unrelated.7z',b'not app')
    rejected('missing NSIS app payload fails closed',lambda:gate.extract(no_payload,base/'no-payload-out'))
print('Artifact gate: %d checks PASS; no Windows/real candidate claim' % passed)
