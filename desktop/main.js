// OMORAY PITWALL — Electron main process
// 最重要設定：backgroundThrottling:false
//   → iRacingがフルスクリーンで前面に来てウィンドウが裏に回っても、
//     タイマー・音声・JSが絞られず動き続ける（=ブラウザの「裏で死ぬ」問題の解決）
const { app, BrowserWindow, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const https = require('https');
const { spawn } = require('child_process');

const LATEST_EXE_URL = 'https://github.com/eebei/english-voice-app/releases/download/desktop-latest/OMORAY-PITWALL-Desktop-latest.exe';
const RELEASE_API_URL = 'https://api.github.com/repos/eebei/english-voice-app/releases/tags/desktop-latest';

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

  // 外部リンク（更新通知バナー等）はOSの既定ブラウザで開く。アプリ内に新ウィンドウを作らない。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'renderer.html'));

  // 開発中はDevToolsを開く（あとで消す）
  // win.webContents.openDevTools();
}

// ── 軽量アップデート通知（自動インストールはしない。CIが焼き込むbuild-info.jsonの日時 vs GitHub最新版）──
// electron-updaterのような裏側での自動差し替えではなく、「新しいのがあるよ」とバナーで知らせるだけ。
// ダウンロード・再起動はユーザーの手動操作（今の配布形式=portableではここが現実的な落とし所）。
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'omoray-pitwall-updatecheck' } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function checkForUpdate() {
  try {
    const infoPath = path.join(__dirname, 'build-info.json');
    if (!fs.existsSync(infoPath)) return;
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    const buildTag = info.buildTag;
    if (!buildTag || buildTag === 'dev') return log('update check skipped (dev build)');

    const release = await fetchJson(RELEASE_API_URL);
    // 最新ビルドのタグを「バージョン付きexe名 (…-YYYYMMDD-HHmm.exe)」から取得して、自分のタグと比較する。
    // ⚠️latest.exe の updated_at(アップロード時刻)はビルド時刻より必ず後になるため、時刻比較だと
    //    最新版exeでも毎回「古い」と誤判定して無限ループになる。だから“タグ同士”で厳密比較する。
    const re = /OMORAY-PITWALL-Desktop-(\d{8}-\d{4})\.exe$/;
    let latestTag = null;
    for (const a of (release.assets || [])) {
      const m = a && a.name && a.name.match(re);
      if (m && (!latestTag || m[1] > latestTag)) latestTag = m[1];
    }
    if (!latestTag) return log('update check: no versioned asset found');

    const localN = parseInt(buildTag.replace('-', ''), 10);
    const remoteN = parseInt(latestTag.replace('-', ''), 10);
    if (remoteN > localN) {
      log('update required (blocking): local=' + buildTag + ' remote=' + latestTag);
      // 閉じるボタンなし＝強制ゲート。理由：PITWALLはテレメトリ解釈がバージョン依存なので、
      // 古いクライアントのまま使うと燃料/ギャップ等を「静かに」誤読するリスクがある（＝捏造と同じ害）。
      // iRacing自体が採用してる「更新しないと入れない」方式に合わせる。
      if (win) win.webContents.executeJavaScript(`
        (function(){
          if (document.getElementById('omoray-update-gate')) return;
          var g = document.createElement('div');
          g.id = 'omoray-update-gate';
          g.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(7,8,15,.97);color:#eee;' +
            'font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;' +
            'justify-content:center;text-align:center;padding:40px';
          g.innerHTML =
            '<div style="font-size:15px;letter-spacing:2px;color:#9D4EDD;font-weight:700;margin-bottom:14px">UPDATE REQUIRED</div>' +
            '<div style="font-size:20px;font-weight:700;margin-bottom:10px">A new version is required</div>' +
            '<div style="font-size:14px;color:#aaa;max-width:440px;margin-bottom:26px;line-height:1.6">' +
            'An older build may misread telemetry like fuel and gaps. Please update before you drive.' +
            '<br><span style="color:#777;font-size:13px">古いバージョンのままだと燃料・ギャップ等を正しく読めない場合があります。更新してからご利用ください。</span></div>' +
            '<a href="${LATEST_EXE_URL}" target="_blank" style="display:inline-block;background:#9D4EDD;color:#fff;' +
            'font-weight:700;padding:14px 32px;border-radius:10px;text-decoration:none;font-size:15px">' +
            '⬇ Download the latest version</a>' +
            '<div style="font-size:12px;color:#666;margin-top:20px">After downloading, close this app and launch the new .exe. ／ DL後、このアプリを閉じて新しいexeを起動してください。</div>';
          document.body.appendChild(g);
        })();
      `).catch((e) => log('update gate inject failed: ' + e.message));
    } else {
      log('up to date (local=' + buildTag + ')');
    }
  } catch (e) {
    log('checkForUpdate failed: ' + e.message);
  }
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
  setTimeout(checkForUpdate, 4000);   // 起動直後の輻輳を避けて少し待ってからチェック
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopBridge();       // アプリ終了でbridgeも止める（ゾンビ防止）
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopBridge);
