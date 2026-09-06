'use strict';

const fs = require('fs');
const assert = require('assert');

const desktop = fs.readFileSync('desktop/renderer.html', 'utf8');
const website = fs.readFileSync('public/pitwall.html', 'utf8');
let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed += 1;
}

for (const id of ['James', 'Hajime', 'Kanbe', 'Oishi', 'Matthias', 'Camila']) {
  const card = new RegExp(`<div class="eng-sel-card planned-2027" id="card-${id}"[^>]*>`);
  check(`desktop ${id} is disabled and planned for 2027`, card.test(desktop));
  check(`desktop ${id} card has no click handler`, !new RegExp(`<div class="eng-sel-card planned-2027" id="card-${id}"[^>]*onclick=`).test(desktop));
}
check('desktop Luna remains selectable', /class="eng-sel-card luna-current" id="card-Luna" onclick="selectEng\('Luna'\)"/.test(desktop));
check('desktop selection guard allows only Luna/LunaJP', /function selectEng\(name\)\{\s*if\(name!==\'Luna\'&&name!==\'LunaJP\'\) return;/.test(desktop));
check('desktop planned cards block pointer input', /\.eng-sel-card\.planned-2027\{[^}]*pointer-events:none/.test(desktop));
check('desktop landing states Luna is active', /Luna is the active development engineer/.test(desktop));
check('desktop landing states 2027 plan', /Additional personalities are planned for 2027/.test(desktop));
check('desktop landing has six planned cards', (desktop.match(/class="eng-card planned-2027"/g)||[]).length===6);
check('desktop landing has one current Luna card', (desktop.match(/class="eng-card luna-current"/g)||[]).length===1);

for (const id of ['James', 'Hajime', 'Kanbe', 'Oishi']) {
  check(`website app ${id} is disabled`, new RegExp(`<div class="eng-sel-card planned-2027" id="card-${id}"[^>]*>`).test(website));
  check(`website app ${id} has no click handler`, !new RegExp(`<div class="eng-sel-card planned-2027" id="card-${id}"[^>]*onclick=`).test(website));
}
check('website app Luna remains selectable', /id="card-Luna" onclick="selectEng\('Luna'\)"/.test(website));
check('website selection guard allows only Luna', /function selectEng\(name\)\{\s*if\(name!==\'Luna\'\) return;/.test(website));
check('website planned cards block pointer input', /\.eng-sel-card\.planned-2027\{[^}]*pointer-events:none/.test(website));
check('website English copy states 2027 plan', /Additional engineer personalities are planned for 2027/.test(website));
check('website Japanese copy states 2027 plan', /ほかのエンジニアは2027年登場予定/.test(website));
check('pricing no longer promises all engineers', !/All 4 engineers/.test(website));
check('pricing names Luna availability', /Luna in Japanese and English/.test(website));

console.log(`[tests-luna-2027-ui] ${passed} checks passed`);
