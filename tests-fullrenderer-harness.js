'use strict';
// 実renderer全体（desktop/renderer.html＋<script src>の全module）をjsdomで起動する検査用harness。
// 抽出した関数だけを動かす既存harnessと違い、sendMsg・local-intent-router・callAPI・speak/finalizeUtterance・
// persistentSet/hydrate・deleteDecision等を「製品のまま」通す。stubするのはIO境界だけ：
//   fetch（/api/chat・/api/tts等）、WebSocket、Audio、window.pitwall（Electron preload）、時刻は実時計。
// 実LLM・実音声・実Electron再起動・実Postgresは検証しない（呼ばない）。
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { fixture } = require('./tests-canonical-lifecycle');

const ROOT = process.env.P1001B_ROOT || __dirname;

function inlinedHtml(root) {
  const dir = path.join(root, 'desktop');
  let html = fs.readFileSync(path.join(dir, 'renderer.html'), 'utf8');
  const missing = [];
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, f) => {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) { missing.push(f); return ''; }
    return '<script>' + fs.readFileSync(p, 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>';
  });
  return { html, missing };
}

// opts.localStorage: 起動前に入れるlocalStorage / opts.native: window.pitwall.settingsGetAll() が返す永続設定
// opts.chat(body, call) → { text, authority?, intent?, hold? } を返す（/api/chatの偽応答）
function boot(opts = {}) {
  const { html, missing } = inlinedHtml(opts.root || ROOT);
  const state = { chatResponses: [], sockets: [], ws: [], fetches: [], chats: [], tts: [], errors: [], audios: [], nativeSet: [], missing };
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { const m = String(e.detail && e.detail.message || e.message); if (!/Not implemented/.test(m)) state.errors.push(m); });
  const native = opts.native || {};
  const dom = new JSDOM(html, {
    url: 'http://localhost/renderer.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      for (const [k, v] of Object.entries(opts.localStorage || {})) w.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      w.pitwall = new Proxy({
        settingsGetAll: () => native,
        settingsSet: (k, v) => { native[k] = v; state.nativeSet.push(k); },
        overlayPush() {}, overlayShow() {}, overlayLock() {}, overlayOpacity() {}, overlayScale() {},
        overlayGetState: () => Promise.resolve(null), onOverlayConfig() {}, onOverlayLockState() {},
      }, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /^on[A-Z]/.test(k) ? () => {} : undefined)) });
      w.fetch = async (u, init) => {
        const url = String(u); state.fetches.push({ url, init });
        const enc = new w.TextEncoder();
        const resp = (status, headers, text) => {
          let sent = false;
          return { ok: status < 400, status, headers: { get: k => headers[String(k).toLowerCase()] ?? null },
            body: { getReader() { return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: enc.encode(text) })), cancel() {} }; }, cancel() {} },
            json: async () => JSON.parse(text || '{}'), text: async () => text, arrayBuffer: async () => new ArrayBuffer(8), blob: async () => new w.Blob(['x']) };
        };
        if (url.includes('/api/auth/me')) return resp(200, {}, JSON.stringify({ user: opts.user || null }));
        if (url.includes('/api/memory/decisions') && (!init || !init.method || init.method === 'GET')) return resp(200, {}, JSON.stringify({ decisions: state.syncDecisions || [], ownerGeneration: 0 }));
        if (url.includes('/api/chat') && opts.chatForward) {
          // 実server.js(子プロセス)へ実HTTPで転送する。signalはjsdom由来で非互換なので渡さない。
          const body = JSON.parse(init.body); state.chats.push(body);
          const r = await fetch(opts.chatForward + '/api/chat', { method: 'POST', headers: init.headers, body: init.body });
          state.chatResponses.push({ status: r.status, authority: r.headers.get('x-pitwall-authority'), intent: r.headers.get('x-pitwall-intent') });
          return r;
        }
        if (url.includes('/api/chat')) {
          const body = JSON.parse(init.body); state.chats.push(body);
          const r = await (opts.chat ? opts.chat(body, state.chats.length, state) : { text: 'REPLY-' + state.chats.length + '。' });
          const h = {};
          if (r.authority !== undefined) h['x-pitwall-authority'] = r.authority;
          if (r.intent) h['x-pitwall-intent'] = r.intent;
          if (r.status && r.status >= 400) return resp(r.status, h, '');
          return resp(200, h, r.text);
        }
        if (url.includes('/api/tts')) { state.tts.push({ url, init }); return opts.tts ? opts.tts(url, init, state, resp) : resp(200, { 'content-type': 'application/json' }, JSON.stringify({ audioContent: 'AAAA' })); }
        return resp(200, {}, '{}');
      };
      w.WebSocket = function () { this.readyState = 1; this.send = m => { state.ws.push(String(m)); }; this.close = () => {}; state.sockets.push(this); };
      w.Audio = function () {
        const a = this; state.audios.push(a); a.listeners = {};
        a.play = () => (opts.audioPlay ? opts.audioPlay(a, state) : Promise.resolve());
        a.pause = () => {}; a.load = () => {};
        a.addEventListener = (n, f) => { (a.listeners[n] = a.listeners[n] || []).push(f); };
        a.removeEventListener = () => {};
        a.finish = () => { if (typeof a.onended === 'function') a.onended(); (a.listeners.ended || []).forEach(f => f()); };
        a.fail = () => { if (typeof a.onerror === 'function') a.onerror(new Error('audio')); (a.listeners.error || []).forEach(f => f()); };
      };
      w.AudioContext = function () {};
      w.speechSynthesis = { cancel() {}, speak() {}, pause() {}, resume() {}, getVoices: () => [], addEventListener() {}, onvoiceschanged: null };
      w.SpeechSynthesisUtterance = function (t) { this.text = t; };
      w.HTMLMediaElement.prototype.play = () => Promise.resolve();
      w.HTMLMediaElement.prototype.pause = () => {};
      w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
    },
  });
  const w = dom.window;
  const ev = code => w.eval(code);
  // routerの実行証拠：実関数を呼び通すspy。呼ばれたか／何を返したかを記録する（routerを迂回した検査を「未実行」と判定するため）。
  state.router = { route: 0, handled: [] };
  const R = w.PitwallLocalIntentRouter;
  if (R && typeof R.route === 'function') {
    const orig = R.route;
    R.route = function (...a) { state.router.route++; const r = orig.apply(this, a); state.router.handled.push(r && r.handled ? r.intent : null); return r; };
  }
  const api = {
    w, state, dom, ev,
    store: () => w.localStorage,
    json: k => { try { return JSON.parse(w.localStorage.getItem(k) || 'null'); } catch { return null; } },
    set: (name, value) => { w.__x = value; w.eval(name + '=__x'); },
    diag: (re) => state.ws.map(m => { try { return JSON.parse(m).text; } catch { return m; } }).filter(t => t && (!re || re.test(t))),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  };
  // 実wire：Bridgeの 'connected' と 'canonical_lifecycle_snapshot' を、実 irBridge.onmessage へそのまま渡す（cacheの世代もrenderer自身が管理）。
  const seqs = {}; let curEpoch = null;
  api.raceSnap = ({ race, driver = 7, epoch = 'epoch-a', frame = 10, session = 2, decision = null, lap = 20, fuel = null }) => {
    const sock = state.sockets[state.sockets.length - 1];
    const send = msg => sock.onmessage({ data: JSON.stringify(msg) });
    const seq = (seqs[epoch] || 0) + 1; seqs[epoch] = seq;
    const s = decision ? fixture({ epoch, seq, frame, race, session, decision, lap })
      : fixture({ epoch, seq, frame, race, session, decision: null, lap, proof: null, attempt: null, allowed: false });
    s.current_facts.current_lap = lap;
    if (fuel !== null) s.current_facts.fuel_level_l = fuel;
    if (driver !== null) s.continuity.stable_scope = { race_instance_id: race, session_num: session, driver_id: driver };
    if (curEpoch !== epoch) { send({ type: 'connected', schema_version: 1, bridge_process_epoch: epoch }); curEpoch = epoch; }
    send(s);
    return s;
  };
  // 走行中のレース会話の状態（Bridge権威の値はlet変数へ。canonical受信と同じ値を入れる）。
  api.enterRace = ({ race = 'sub:2002', cust = 7, track = 'Okayama', car = 'Audi R8 LMS GT3', carClass = 'GT3', live = true } = {}) => {
    api.set('selMode', 'race'); api.set('sel', 'LunaJP'); api.set('iracingLive', live); api.set('bridgeConnected', true);
    api.set('lastTrack', track); api.set('lastCarModel', car); api.set('lastCarClass', carClass);
    api.set('lastSessionNum', 2); api.set('lastSessionType', 'Race');
    api.set('lastTelemetry', { cust_id: cust, race_instance_id: race, session_num: 2 });
    api.set('lastTelemetryAt', Date.now());
    api.raceSnap({ race });
  };
  // Bridgeからのwebsocketメッセージを、実 irBridge.onmessage へそのまま渡す。
  api.bridge = async (msg) => { const sock = state.sockets[state.sockets.length - 1]; if (!sock || typeof sock.onmessage !== 'function') throw new Error('no bridge onmessage'); await sock.onmessage({ data: JSON.stringify(msg) }); };
  api.say = async (text, source = 'typed') => {
    w.document.getElementById('chat-input').value = text;
    await w.sendMsg(source);
    await api.sleep(30);
  };
  return api;
}

module.exports = { boot, ROOT, inlinedHtml };
