// OMORAY PITWALL — preload (contextBridge)
// メイン窓(renderer.html)とオーバーレイ窓(overlay.html)を、main経由で繋ぐ最小IPC。
// 目的：無線コール(会話)だけをオーバーレイにミラーする／オーバーレイの表示・ロック・
//       透明度・スケールをメイン窓のコントロールから操作する。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pitwall', {
  // ── メイン窓 → オーバーレイ（会話1件を流す）──
  overlayPush: (line) => ipcRenderer.send('overlay:push', line),
  // ── メイン窓 → main（オーバーレイ窓の制御）──
  overlayShow:   (on)      => ipcRenderer.send('overlay:show', !!on),
  overlayLock:   (locked)  => ipcRenderer.send('overlay:lock', !!locked),
  overlayOpacity:(v)       => ipcRenderer.send('overlay:opacity', v),
  overlayScale:  (v)       => ipcRenderer.send('overlay:scale', v),
  overlayClear:  ()        => ipcRenderer.send('overlay:clear'),
  overlayGetState: ()      => ipcRenderer.invoke('overlay:getState'),
  // ── main → 窓（設定値の受信。overlay.html / renderer.html 両方が使う）──
  onOverlayConfig: (cb) => ipcRenderer.on('overlay:config', (_e, cfg) => cb(cfg)),
  onOverlayData:   (cb) => ipcRenderer.on('overlay:data',   (_e, line) => cb(line)),
});
