// OMORAY PITWALL — Electron main process
// 最重要設定：backgroundThrottling:false
//   → iRacingがフルスクリーンで前面に来てウィンドウが裏に回っても、
//     タイマー・音声・JSが絞られず動き続ける（=ブラウザの「裏で死ぬ」問題の解決）
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let win;
let bridgeProc = null;

// ── テレメトリbridgeを自動起動（ユーザーが手動でexeを立ち上げる必要をなくす）──
// Windows: 同梱の OMORAY-PITWALL-Bridge.exe を起動
// 開発(Mac/Linux): bridge.py があれば python3 で起動（iRacing無しなので実データは出ないが配線確認用）
function startBridge() {
  try {
    const exeName = 'OMORAY-PITWALL-Bridge.exe';
    // 配布時は resources、開発時は app直下/隣の irsdk-bridge を探す
    const candidates = [
      path.join(process.resourcesPath || '', exeName),
      path.join(__dirname, exeName),
      path.join(__dirname, 'bridge', exeName),
    ];
    const exePath = candidates.find(p => p && fs.existsSync(p));

    if (process.platform === 'win32' && exePath) {
      bridgeProc = spawn(exePath, [], { windowsHide: true });
      log('bridge started (exe): ' + exePath);
    } else {
      // 開発フォールバック：bridge.py を探して python3 で起動
      const pyCandidates = [
        path.join(__dirname, 'bridge.py'),
        path.join(__dirname, '..', '..', 'irsdk-bridge', 'bridge.py'),
      ];
      const py = pyCandidates.find(p => fs.existsSync(p));
      if (py) {
        bridgeProc = spawn('python3', [py], {});
        log('bridge started (py dev): ' + py);
      } else {
        log('bridge not found — telemetry disabled (expected on Mac dev)');
        return;
      }
    }
    bridgeProc.on('exit', (code) => log('bridge exited code=' + code));
    bridgeProc.on('error', (e) => log('bridge spawn error: ' + e.message));
  } catch (e) {
    log('startBridge failed: ' + e.message);
  }
}

function stopBridge() {
  if (bridgeProc) { try { bridgeProc.kill(); } catch (e) {} bridgeProc = null; }
}

function log(msg) {
  console.log('[main] ' + msg);
}

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 900,
    title: 'OMORAY PITWALL',
    backgroundColor: '#07080f',
    webPreferences: {
      backgroundThrottling: false,   // ★ 裏に回っても止めない（このプロジェクトの肝）
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer.html'));

  // 開発中はDevToolsを開く（あとで消す）
  // win.webContents.openDevTools();
}

app.whenReady().then(() => {
  // マイク権限を自動許可（PTT用。Electronなので毎回ダイアログを出さない）
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media' ? true : true);
  });
  startBridge();      // アプリ起動と同時にテレメトリbridgeも起動
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopBridge();       // アプリ終了でbridgeも止める（ゾンビ防止）
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopBridge);
