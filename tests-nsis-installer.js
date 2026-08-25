#!/usr/bin/env node
'use strict';

const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('desktop/package.json', 'utf8'));
const workflow = fs.readFileSync('.github/workflows/build-desktop.yml', 'utf8');
const main = fs.readFileSync('desktop/main.js', 'utf8');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
const runtimeVerifier = require('./desktop/scripts/verify-packaged-runtime.js');

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
const localScripts = [...renderer.matchAll(/<script\s+src="([^"]+\.js)"/g)].map(m => m[1]);
const futureScripts = runtimeVerifier.extractLocalScripts(`${renderer}\n<script src="future-runtime.js"></script>`);
const packagePatterns = pkg.build.files || [];
const packaged = file => packagePatterns.includes(file)
  || packagePatterns.includes('*.js') && /^[^/]+\.js$/.test(file);
const completeAsar = {
  listPackage: () => localScripts.map(src => `/${src}`),
};
const incompleteAsar = {
  listPackage: () => localScripts.slice(1).map(src => `/${src}`),
};
check('rendererのローカルJSを全てinstallerへ同梱',
  localScripts.length > 0 && localScripts.every(packaged));
check('GAPと燃料安全moduleをinstallerへ同梱',
  packaged('local-intent-router.js') && packaged('fuel-plan-guard.js'));
check('CIが完成asar内のrenderer参照moduleを全件検査',
  workflow.includes('Verify packaged runtime modules')
  && workflow.includes('node scripts/verify-packaged-runtime.js')
  && runtimeVerifier.extractLocalScripts(renderer).length === localScripts.length
  && runtimeVerifier.missingRuntimeScripts(localScripts, localScripts).length === 0
  && runtimeVerifier.missingRuntimeScripts(localScripts, localScripts.slice(1)).length === 1
  && runtimeVerifier.missingRuntimeScripts(futureScripts, localScripts)[0] === 'future-runtime.js');
let completeArtifactVerified = false;
try {
  const result = runtimeVerifier.verifyPackagedRuntime({
    rendererPath: 'desktop/renderer.html',
    asarPath: 'complete-test.asar',
    asar: completeAsar,
  });
  completeArtifactVerified = result.localScripts.length === localScripts.length
    && result.packageEntries === localScripts.length;
} catch (_) {
  completeArtifactVerified = false;
}
check('完成asarならartifact verifier本体が成功', completeArtifactVerified);
let incompleteArtifactRejected = false;
try {
  runtimeVerifier.verifyPackagedRuntime({
    rendererPath: 'desktop/renderer.html',
    asarPath: 'incomplete-test.asar',
    asar: incompleteAsar,
  });
} catch (error) {
  incompleteArtifactRejected = /missing packaged runtime modules:/.test(String(error && error.message));
}
check('欠落asarならartifact verifier本体がbuildを停止', incompleteArtifactRejected);
check('runtimeログがmodule欠落と通常の未処理を区別',
  renderer.includes("'router_missing':'unhandled'"));
check('起動時に全runtime moduleの搭載状態を診断ログへ出す',
  renderer.includes("diagnosticLog('RUNTIME_MODULE_STATUS'")
  && ['PitwallMemoryActionLayer','PitwallStrategyPlaybook','PitwallFuelPlanGuard','PitwallCostMeter','PitwallLocalIntentRouter']
    .every(name => renderer.includes(name)));
check('@electron/asarを明示的なbuild依存にする',
  typeof pkg.devDependencies['@electron/asar'] === 'string');

console.log(`\nNSIS Installer: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
