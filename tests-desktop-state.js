#!/usr/bin/env node
'use strict';

const fs = require('fs');
const main = fs.readFileSync('desktop/main.js', 'utf8');
const preload = fs.readFileSync('desktop/preload.js', 'utf8');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
const preflight = fs.readFileSync('preflight.sh', 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok) {
  if (ok) { console.log(`✅ ${label}`); pass++; }
  else { console.error(`❌ ${label}`); fail++; }
}

check('設定をuserData配下のJSONへ保存',
  main.includes("path.join(app.getPath('userData'), 'desktop-settings.json')")
  && main.includes('fs.writeFileSync(SETTINGS_FILE'));
check('起動時読込のみ同期、書込は非同期IPC',
  preload.includes("settingsGetAll: () => ipcRenderer.sendSync('settings:getAll')")
  && preload.includes("settingsSet: (key, value) => ipcRenderer.send('settings:set'"));
check('連続入力のdisk書込を150ms集約',
  main.includes('function scheduleDesktopSettingsSave()')
  && main.includes('}, 150);')
  && main.includes('scheduleDesktopSettingsSave();'));
check('アクセスコード・認証・音量・Voiceを永続対象に含む',
  renderer.includes("'pw_beta_code','pw_auth_token','pw_auth_user','pw_username','pw_device_id'")
  && renderer.includes("'pw_ui_lang','pw_volume','pw_voice_on'"));
check('旧localStorageから初回移行',
  renderer.includes('const legacy=localStorage.getItem(key)')
  && renderer.includes('window.pitwall.settingsSet(key,legacy)'));
check('音量未設定は100%、Voice未設定はON',
  renderer.includes('isNaN(v)?1.0')
  && renderer.includes("voiceOn=localStorage.getItem('pw_voice_on')!=='0'"));
check('会話中に設定へ移動して戻れる',
  renderer.includes('onclick="openSessionSettings()"')
  && renderer.includes('id="btn-return-session"')
  && renderer.includes('function returnToSession(){ if(sessionActive)'));
check('preflightへ追加済み', preflight.includes('tests-desktop-state.js'));

console.log(`\nDesktop Persistent State / Navigation: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
