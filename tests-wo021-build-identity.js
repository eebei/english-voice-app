#!/usr/bin/env node
'use strict';
// WO021 — one Build identity reader (desktop/build-identity.js) behind main.js's window title /
// Support log header and the renderer's badge / usage `build`. Runs the REAL main.js
// currentBuildLabel() source against temp build-info.json files; no network, no paid API.
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const B = require('./desktop/build-identity.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name + (detail !== undefined ? ' ' + JSON.stringify(detail) : '')); }
}

// The pre-WO021 label/usage logic (git history of main.js / renderer.html), for parity on packaged info.
const oldLabel = info => { const n = info.buildNum != null ? info.buildNum : info.buildTag; return (n != null && n !== 'dev') ? 'Build ' + n : ''; };
const oldUsage = info => { const n = info && (info.buildNum != null ? info.buildNum : info.buildTag); return String(n == null ? 'unknown' : n); };

const packaged = [{ buildDate: '2026-09-21T03:00:00Z', buildTag: '20260921-1200', buildNum: 302 },
  { buildDate: 'x', buildTag: 'store-41', buildNum: 302, channel: 'store' }];
for (const info of packaged) {
  const d = B.describe(info);
  check('packaged ' + info.buildTag + ': label/usage unchanged from pre-WO021', d.built && d.label === oldLabel(info) && d.usage_build === oldUsage(info), d);
}
const src = B.describe({ buildDate: null, buildNum: 302, buildTag: 'dev', channel: 'source' });
check('unbuilt source names the product Build but not as the released artifact',
  !src.built && src.product_build === 302 && src.label === 'Build 302 (unbuilt source)' && src.usage_build === '302-unbuilt', src);
check('unbuilt marker is the one checkForUpdate skips', B.UNBUILT_TAG === 'dev'
  && fs.readFileSync(path.join(__dirname, 'desktop/main.js'), 'utf8').includes("buildTag === '" + B.UNBUILT_TAG + "'"));
// Only an explicit marker is "unbuilt": a number with a missing/empty/non-string tag was never
// observed as source or as a Build, so it stays unknown (parent interim P2).
for (const [label, info] of [['null', null], ['empty', {}], ['string buildNum', { buildNum: '302', buildTag: 'dev' }],
  ['negative buildNum', { buildNum: -1, buildTag: 'dev' }], ['dev without number', { buildTag: 'dev' }],
  ['number, tag missing', { buildNum: 302 }], ['number, numeric tag', { buildNum: 302, buildTag: 4 }],
  ['number, empty tag', { buildNum: 302, buildTag: '' }], ['number, null tag', { buildNum: 302, buildTag: null }]]) {
  const d = B.describe(info);
  check('unknown stays unknown (' + label + ')', d.state === 'unknown' && d.built === null && d.product_build === null && d.label === '' && d.usage_build === 'unknown', d);
}
check('state is explicit for unbuilt and built', B.describe({ buildNum: 302, buildTag: 'dev' }).state === 'unbuilt'
  && B.describe(packaged[0]).state === 'built' && B.describe({ buildTag: '20250101-0000' }).state === 'built');
const tagOnly = B.describe({ buildTag: '20250101-0000' });
check('built tag without number keeps the old "Build <tag>" fallback', tagOnly.built && tagOnly.label === oldLabel({ buildTag: '20250101-0000' }), tagOnly);

// The REAL main.js currentBuildLabel() (window title + Support header) on temp build-info files.
const main = fs.readFileSync(path.join(__dirname, 'desktop/main.js'), 'utf8');
const fnSrc = main.slice(main.indexOf('function currentBuildLabel()'), main.indexOf('function createWindow()'));
function mainLabel(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wo021-bi-'));
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'build-info.json'), content);
  const ctx = { fs, path, __dirname: dir, JSON, require: rel => require(rel.startsWith('./') ? path.join(__dirname, 'desktop', rel) : rel) };
  const out = vm.runInNewContext(fnSrc + '\ncurrentBuildLabel();', ctx);
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
check('real main label: tracked source file', mainLabel(fs.readFileSync(path.join(__dirname, 'desktop/build-info.json'), 'utf8')) === 'Build ' + JSON.parse(fs.readFileSync(path.join(__dirname, 'desktop/build-info.json'), 'utf8')).buildNum + ' (unbuilt source)');
check('real main label: CI-packaged file', mainLabel(JSON.stringify(packaged[0])) === 'Build 302');
check('real main label: missing file -> empty (header shows unknown)', mainLabel(undefined) === '');
check('real main label: malformed file -> empty', mainLabel('{not json') === '');
check('real main label: number without a tag -> empty (not guessed unbuilt)', mainLabel('{"buildNum":302}') === '');
// The reader reports what the file says; a number that differs from bridge.py is caught by
// ci/runtime_coverage.py build_identity (RED cases in ci/tests_runtime_coverage.py), not hidden here.
check('real main label: a stale local-257 file is reported as-is (no silent rewrite)', mainLabel('{"buildNum":257,"buildTag":"local-257"}') === 'Build 257');

// Renderer consumer reads the same module (script tag) and uses it for badge + usage.
const html = fs.readFileSync(path.join(__dirname, 'desktop/renderer.html'), 'utf8');
check('renderer loads build-identity.js and uses it for usage + label',
  html.includes('<script src="build-identity.js"></script>') && /const bi = PitwallBuildIdentity\.describe\(info\);\n  usageBuild = bi\.usage_build;/.test(html)
  && html.includes("if(gb) gb.textContent = bi.label;") && html.includes('el.textContent = bi.label;'));

console.log(`\nWO021 build identity: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
