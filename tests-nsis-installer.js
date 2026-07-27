#!/usr/bin/env node
'use strict';

const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('desktop/package.json', 'utf8'));
const workflow = fs.readFileSync('.github/workflows/build-desktop.yml', 'utf8');
const main = fs.readFileSync('desktop/main.js', 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok) {
  if (ok) { console.log(`✅ ${label}`); pass++; }
  else { console.error(`❌ ${label}`); fail++; }
}

check('portableではなくNSISをbuild', pkg.scripts.dist === 'electron-builder --win nsis'
  && pkg.build.win.target === 'nsis');
check('ユーザー単位one-click installer', pkg.build.nsis.oneClick === true
  && pkg.build.nsis.perMachine === false);
check('デスクトップ・スタートメニューshortcut', pkg.build.nsis.createDesktopShortcut === true
  && pkg.build.nsis.createStartMenuShortcut === true);
check('アンインストールで設定を消さない', pkg.build.nsis.deleteAppDataOnUninstall === false);
check('新旧download URLを同じinstallerへ公開',
  workflow.includes('OMORAY-PITWALL-Setup-latest.exe')
  && workflow.includes('OMORAY-PITWALL-Desktop-latest.exe'));
check('新buildの更新ゲートはinstallerを案内',
  main.includes('OMORAY-PITWALL-Setup-latest.exe'));

console.log(`\nNSIS Installer: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
