'use strict';
// Update Gate: renderer読込とGitHub APIの並列化、および起動直後の操作遮断契約。
const fs = require('fs');

const main = fs.readFileSync(__dirname + '/desktop/main.js', 'utf8');
const renderer = fs.readFileSync(__dirname + '/desktop/renderer.html', 'utf8');
let pass = 0;
let fail = 0;
function check(name, cond) {
  cond ? pass++ : fail++;
  console.log((cond ? '  ✅ ' : '  ❌ ') + name);
}

const readyListener = main.indexOf("win.webContents.once('did-finish-load', resolveRendererReady)");
const updateStart = main.indexOf('checkForUpdate(rendererReady)');
const rendererLoad = main.indexOf("win.loadFile(path.join(__dirname, 'renderer.html'))");

check('renderer ready listenerをloadFile前に登録', readyListener >= 0 && readyListener < rendererLoad);
check('更新確認をloadFile前に開始して並列化', updateStart >= 0 && updateStart < rendererLoad);
check('旧4秒固定タイマーを撤廃', !/setTimeout\(checkForUpdate,\s*4000\)/.test(main));
check('起動シールドをHTML最初の描画から配置',
  /<body>\s*<!--[\s\S]*?<div id="omoray-update-check-shield"/.test(renderer));
check('起動シールドが他ゲートより前面', /omoray-update-check-shield[^>]*z-index:200000/.test(renderer));
check('最新版なら起動シールドを除去', /else \{\s*await dismissUpdateCheckShield\(rendererReady\);\s*log\('up to date/.test(main));
check('dev buildなら起動シールドを除去',
  /buildTag === 'dev'[\s\S]*?await dismissUpdateCheckShield\(rendererReady\)/.test(main));
check('build-info欠損なら起動シールドを除去',
  /if \(!fs\.existsSync\(infoPath\)\) \{\s*await dismissUpdateCheckShield\(rendererReady\)/.test(main));
check('ネット切断時も起動シールドを除去',
  /catch \(e\) \{\s*try \{ await dismissUpdateCheckShield\(rendererReady\)/.test(main));
check('GitHub API hangを8秒で失敗へ確定',
  /timeout:\s*8000/.test(main)
  && /req\.on\('timeout', \(\) => req\.destroy\(new Error\('update check timeout'\)\)\)/.test(main));
check('更新必須ならDownloadゲート設置後に起動シールドを除去',
  /document\.body\.appendChild\(g\);[\s\S]*?omoray-update-check-shield[\s\S]*?s\.remove\(\)/.test(main));

console.log(`\nUpdate Gate Latency: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
