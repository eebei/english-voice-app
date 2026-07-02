// OMORAY PITWALL — Electron main process
// 最重要設定：backgroundThrottling:false
//   → iRacingがフルスクリーンで前面に来てウィンドウが裏に回っても、
//     タイマー・音声・JSが絞られず動き続ける（=ブラウザの「裏で死ぬ」問題の解決）
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

// ★音声の自動再生を常に許可：TTSはfetch後の非同期コールバックで鳴らすため、
//   デフォルト（ユーザー操作直後のみ許可）だとブロックされ無音になる。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 既にbridgeがport8765で動いているか確認（重複起動＝点滅の原因を防ぐ）
// 古い/ゾンビのbridgeを掃除（前回のアプリ実行残り・昔の手動起動・スケジューラ起動を一掃）
function killStaleBridges() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve();
    try {
      const k = spawn('taskkill', ['/F', '/IM', 'OMORAY-PITWALL-Bridge.exe', '/T'], { windowsHide: true });
      k.on('exit', () => { log('killed stale bridges (if any)'); setTimeout(resolve, 600); });
      k.on('error', () => resolve());
    } catch (e) { resolve(); }
  });
}

let win;
let bridgeProc = null;

// ── テレメトリbridgeを自動起動（ユーザーが手動でexeを立ち上げる必要をなくす）──
// 必ず「古いbridgeを掃除→最新の同梱bridgeを起動」する。古い壊れたbridgeを再利用しない。
async function startBridge() {
  try {
    await killStaleBridges();   // ★まず古いbridgeを全部消す（前回ゾンビ・旧バージョンの再利用を防ぐ）
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
    // bridgeの出力をデスクトップのログに書き出す（実態把握用・ユーザーがすぐ見つけられる場所）
    if (bridgeProc.stdout) bridgeProc.stdout.on('data', d => log('[bridge] ' + d.toString().trim()));
    if (bridgeProc.stderr) bridgeProc.stderr.on('data', d => log('[bridge-err] ' + d.toString().trim()));
    bridgeProc.on('exit', (code) => log('bridge exited code=' + code));
    bridgeProc.on('error', (e) => log('bridge spawn error: ' + e.message));
  } catch (e) {
    log('startBridge failed: ' + e.message);
  }
}

function stopBridge() {
  if (bridgeProc) { try { bridgeProc.kill(); } catch (e) {} bridgeProc = null; }
  // 念のためimage名でも掃除（ゾンビ残り防止）
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/F', '/IM', 'OMORAY-PITWALL-Bridge.exe', '/T'], { windowsHide: true }); } catch (e) {}
  }
}

// ログをデスクトップのファイルに残す（SIM PCで実態を確認するため）。app ready後にwhenReadyで設定。
let LOG_FILE = '';
function log(msg) {
  const line = '[' + new Date().toLocaleTimeString() + '][main] ' + msg;
  console.log(line);
  try { if (LOG_FILE) fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 900,
    title: 'OMORAY PITWALL',
    backgroundColor: '#07080f',
    webPreferences: {
      backgroundThrottling: false,   // ★ 裏に回っても止めない（このプロジェクトの肝）
      autoplayPolicy: 'no-user-gesture-required',  // ★ TTS音声を確実に再生
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
  // ログファイルを準備（毎回新規）
  try {
    LOG_FILE = path.join(app.getPath('desktop'), 'OMORAY-bridge-debug.log');
    fs.writeFileSync(LOG_FILE, '=== OMORAY PITWALL debug log ' + new Date().toISOString() + ' ===\n');
  } catch (e) {}
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
