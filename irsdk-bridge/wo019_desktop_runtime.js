#!/usr/bin/env node
'use strict';
/* WO019 — the whole real Desktop renderer, as ONE persistent process, for the Road Atlanta
 * one-thread E2E (irsdk-bridge/tests_wo019_road_atlanta_e2e.py).
 *
 * Unlike every earlier fixture (which extracted a hand-picked list of renderer functions and
 * neutral-stubbed the rest), this loads EVERY renderer script — the 27 `<script src>` modules in
 * document order plus the main inline script — into one VM context. Nothing in the product is
 * extracted, re-implemented or stubbed. Only the browser/Electron/IO boundary is replaced:
 *
 *   - DOM elements (inert objects), localStorage (in-memory), crypto.randomUUID (Node)
 *   - Date/performance/setTimeout/setInterval: a fake clock the Python driver advances in step
 *     with the Bridge replay clock (timers run only when the clock reaches them)
 *   - WebSocket: FakeWebSocket. Bridge broadcasts arrive through the real `irBridge.onmessage`
 *     created by the real `connectBridge()`; everything the renderer `send()`s is returned to
 *     the driver, which feeds it to the real `bridge.handler()` coroutine
 *   - fetch: `/api/tts` -> fake audio (Google TTS is not contracted); every other API_BASE path
 *     -> the real `server.js` child (Anthropic SDK replaced by the saved-response queue in
 *     tests-wo001-anthropic-stream-stub-preload.js). Any non-local URL is refused and recorded
 *   - Audio: plays for a text-length-proportional span of fake time, then fires the real onended
 *   - server.js child clock: re-based on the renderer's fake time per request
 *     (wo019_server_clock_preload.js), so raceContext freshness is judged on one clock
 *   - window.pitwall: the real preload.js API, wired to the real main.js critical-journal IPC
 *     (on-disk journal in a temp dir); other Electron channels are inert
 *
 * The session starts through the real UI functions (selectEng -> selectMode -> startSession ->
 * connectBridge), with a logged-in user already in localStorage (the login UI itself is not part
 * of this slice).
 *
 * IPC: one JSON object per line on stdin, one JSON reply per line on stdout. The renderer's own
 * console output is buffered (never written to stdout).
 */
const fs = require('fs'), vm = require('vm'), path = require('path'), os = require('os'), readline = require('readline');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const JournalStore = require(path.join(ROOT, 'desktop/critical-journal-store'));

const AUDIO_MS = 700, AUDIO_MS_PER_CHAR = 120, AUDIO_MAX_MS = 8000;
const html = fs.readFileSync(path.join(ROOT, 'desktop/renderer.html'), 'utf8');
const MODULES = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
const INLINE = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const MAIN = INLINE.reduce((a, b) => (a.length > b.length ? a : b));
const API_BASE_LINE = "const API_BASE = 'https://english-voice-app-production.up.railway.app';";
if (!MAIN.includes(API_BASE_LINE)) throw new Error('renderer API_BASE line changed; update the IO boundary');

// ── fake clock + timers ──────────────────────────────────────────────────────
let now = 0;
const timers = new Map();
let timerSeq = 0;
const timerErrors = [];
function setT(fn, ms, ...args) { const id = ++timerSeq; timers.set(id, { fn, args, due: now + Math.max(0, Number(ms) || 0), every: null }); return id; }
function setI(fn, ms, ...args) { const id = ++timerSeq; const every = Math.max(1, Number(ms) || 1); timers.set(id, { fn, args, due: now + every, every }); return id; }
function clearT(id) { timers.delete(id); }
function nextDue(limit) {
  let best = null;
  for (const [id, t] of timers) if (t.due <= limit && (!best || t.due < best[1].due || (t.due === best[1].due && id < best[0]))) best = [id, t];
  return best;
}
const realSleep = ms => new Promise(r => setTimeout(r, ms));
let inflight = 0;
async function runTimersUntil(limit) {
  for (let guard = 0; guard < 20000; guard++) {
    const n = nextDue(limit);
    if (!n) break;
    const [id, t] = n;
    now = Math.max(now, t.due);
    if (t.every) t.due = now + t.every; else timers.delete(id);
    harvestTrace();
    try { const r = typeof t.fn === 'function' ? t.fn(...t.args) : null; if (r && typeof r.then === 'function') await r.catch(e => timerErrors.push(String(e && e.stack || e))); }
    catch (e) { timerErrors.push(String(e && e.stack || e)); }
    await new Promise(r => setImmediate(r));
  }
}
// The product keeps only the newest UTTERANCE_TRACE_MAX trace entries; copy every entry once so
// the whole run stays traceable (read-only, entries are the product's own objects).
const traceAll = [];
const traceSeen = new WeakSet();
function harvestTrace() {
  if (!sb) return;
  let log; try { log = vm.runInContext('utteranceTraceLog', sb); } catch (_) { return; }
  for (const e of log) if (!traceSeen.has(e)) { traceSeen.add(e); traceAll.push(e); }
}
// Quiescent = no in-flight local HTTP, no timer due at the current fake time.
async function settle() {
  for (let i = 0; i < 2000; i++) {
    await runTimersUntil(now);
    harvestTrace();
    await realSleep(2);
    if (inflight === 0 && !nextDue(now)) { await realSleep(4); if (inflight === 0 && !nextDue(now)) return; }
  }
  throw new Error('desktop runtime did not settle (inflight=' + inflight + ')');
}
async function advanceTo(target) { await settle(); await runTimersUntil(target); now = Math.max(now, target); await settle(); }

// ── IO capture ───────────────────────────────────────────────────────────────
const consoleBuf = [];
const outbound = [];          // every renderer -> Bridge send, in order
const blockedFetches = [];
const localFileFetches = [];
const audios = [];
const sockets = [];
const apiRequests = [];        // every renderer -> local server request (route, size; /api/chat body kept)
let exportSeq = 0;
let holdNextChat = false, heldInflight = 0, pendingSay = null;
let apiBase = null;

class FakeWebSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.index = sockets.length; sockets.push(this); }
  send(raw) { if (this.readyState !== 1) throw new Error('InvalidStateError: socket not open'); outbound.push({ socket: this.index, raw: String(raw) }); }
  close() { if (this.readyState === 3) return; this.readyState = 3; const cb = this.onclose; if (typeof cb === 'function') setT(() => cb({ code: 1000 }), 0); }
}
// Playback length follows the spoken text (~120 ms per character, like real JA TTS), so
// overlapping speech queues the way it does on a real radio.
function audioMsFor() {
  let text = '';
  try { text = String(vm.runInContext('typeof currentSpeakItem!=="undefined"&&currentSpeakItem?currentSpeakItem.text:""', sb) || ''); } catch (_) {}
  return Math.min(AUDIO_MAX_MS, Math.max(AUDIO_MS, text.length * AUDIO_MS_PER_CHAR));
}
class FakeAudio {
  constructor(src) { this.src = src; this.volume = 1; this.paused = false; this.onended = null; this.onerror = null; audios.push(this); }
  play() { this.startedAt = now; this.durationMs = audioMsFor(); setT(() => { if (!this.paused && typeof this.onended === 'function') this.onended(); }, this.durationMs); return Promise.resolve(); }
  pause() { this.paused = true; }
}
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(now); }
  static now() { return now; }
}

function el(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', innerText: '', src: '', title: '', disabled: false, checked: false,
    style: {}, dataset: {}, children: [], options: [], selectedIndex: 0, scrollTop: 0, scrollHeight: 0, parentNode: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; }, removeChild() {}, insertBefore(c) { return c; }, replaceChildren() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => el('q'), querySelectorAll: () => [], focus() {}, blur() {}, click() {}, scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  };
}

function buildPitwallApi() {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'desktop/main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'desktop/preload.js'), 'utf8');
  const entry = mainSrc.match(/require\('\.\/critical-journal-store'\)\.setupIPC\([^;]+;/)[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-wo019-journal-'));
  const handlers = new Map();
  const sender = { mainFrame: {} };
  const win = { isDestroyed: () => false, webContents: sender };
  vm.runInNewContext(entry, { require: () => JournalStore, ipcMain: { on: (n, f) => handlers.set(n, f) }, app: { getPath: () => dir }, win });
  // WO020: the REAL main.js Support-log export handler (diagnosticFileStamp/redactDiagnosticText/
  // ipcDiagnosticsSetup source, unmodified) behind the real preload invoke. IO doubles only:
  // app.getPath -> temp dir, LOG_FILE -> a temp file holding the Bridge stdout lines exactly as
  // main.js ingests them ('[t][main] [bridge] ' + line), shell/log inert.
  // WO021: the header's "Build:" line comes from main.js's REAL currentBuildLabel() reading the
  // product tree's desktop/build-info.json (__dirname = <root>/desktop), not from a stub.
  const diagStart = mainSrc.indexOf('function diagnosticFileStamp()');
  const diagEnd = mainSrc.indexOf('function ipcPracticeProfileSetup()');
  if (diagStart < 0 || diagEnd < diagStart) throw new Error('main.js diagnostics export block not found');
  const labelStart = mainSrc.indexOf('function currentBuildLabel()');
  const labelEnd = mainSrc.indexOf('function createWindow()');
  if (labelStart < 0 || labelEnd < labelStart) throw new Error('main.js currentBuildLabel block not found');
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitwall-wo020-support-'));
  const invokeHandlers = new Map();
  const diagCtx = { require: rel => require(rel.startsWith('./') ? path.join(ROOT, 'desktop', rel) : rel), fs, path,
    __dirname: path.join(ROOT, 'desktop'),
    ipcMain: { handle: (n, f) => invokeHandlers.set(n, f) }, app: { getPath: () => exportDir },
    shell: { showItemInFolder() {} }, log() {}, LOG_FILE: '', Date, JSON, String, Number, Array };
  vm.runInNewContext(mainSrc.slice(labelStart, labelEnd) + mainSrc.slice(diagStart, diagEnd) + '\nipcDiagnosticsSetup();', diagCtx);
  diagnostics.ctx = diagCtx; diagnostics.dir = exportDir;
  let api;
  vm.runInNewContext(preloadSrc, {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_n, v) => { api = v; } },
      ipcRenderer: {
        sendSync: (name, op) => {
          if (!handlers.has(name)) return name === 'settings:getAll' ? {} : undefined;
          const e = { sender, senderFrame: sender.mainFrame }; handlers.get(name)(e, op); return e.returnValue;
        },
        send: () => {}, invoke: async (name, ...args) => (invokeHandlers.has(name) ? invokeHandlers.get(name)({ sender }, ...args) : null), on: () => {},
      },
    }),
  });
  return { api, dir };
}

const store = new Map();
const diagnostics = { ctx: null, dir: null };
let sb = null;
function buildRuntime(base) {
  apiBase = base;
  const els = new Map();
  const document = {
    getElementById: id => { if (!els.has(id)) els.set(id, el(id)); return els.get(id); },
    createElement: t => el(t), createTextNode: t => ({ textContent: t }), querySelector: () => el('q'), querySelectorAll: () => [],
    addEventListener() {}, body: el('body'), documentElement: el('html'), head: el('head'), hidden: false,
  };
  const quiet = (...a) => { consoleBuf.push(a.map(x => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ')); if (consoleBuf.length > 4000) consoleBuf.shift(); };
  const { api: pitwall, dir: journalDir } = buildPitwallApi();
  sb = {
    console: { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet },
    document, Math, JSON, Date: FakeDate, Promise, Map, Set, WeakMap, WeakSet, Array, Object, String, Number, Boolean, RegExp,
    Error, TypeError, RangeError, Symbol, Proxy, Reflect, Intl, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent,
    decodeURIComponent, encodeURI, decodeURI, escape, unescape, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, AbortSignal,
    Uint8Array, ArrayBuffer, DataView, structuredClone, queueMicrotask, Blob,
    atob: s => Buffer.from(s, 'base64').toString('binary'), btoa: s => Buffer.from(s, 'binary').toString('base64'),
    setTimeout: setT, clearTimeout: clearT, setInterval: setI, clearInterval: clearT, requestAnimationFrame: f => setT(f, 16),
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => { store.delete(k); }, key: i => [...store.keys()][i] ?? null, get length() { return store.size; }, clear: () => store.clear() },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { language: 'ja-JP', userAgent: 'wo019-desktop-runtime', mediaDevices: null, onLine: true },
    location: { href: 'file:///renderer.html', search: '', hash: '', protocol: 'file:' },
    fetch: (url, init) => sandboxFetch(url, init),
    WebSocket: FakeWebSocket, Audio: FakeAudio,
    speechSynthesis: { cancel() {}, speak() {}, getVoices: () => [] }, SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    performance: { now: () => now }, crypto: { randomUUID: () => require('crypto').randomUUID(), subtle: require('crypto').webcrypto.subtle, getRandomValues: a => require('crypto').webcrypto.getRandomValues(a) },
    addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
    getComputedStyle: () => ({}), alert() {}, confirm: () => true, prompt: () => null,
    pitwall,
  };
  sb.window = sb; sb.globalThis = sb; sb.self = sb;
  vm.createContext(sb);
  for (const s of MODULES) vm.runInContext(fs.readFileSync(path.join(ROOT, 'desktop', s), 'utf8'), sb, { filename: 'desktop/' + s });
  vm.runInContext(MAIN.replace(API_BASE_LINE, 'const API_BASE = ' + JSON.stringify(base) + ';'), sb, { filename: 'desktop/renderer.html' });
  return { journalDir };
}
const ev = expr => vm.runInContext(expr, sb);

async function sandboxFetch(url, init) {
  const u = String(url);
  // A relative URL is the packaged app's own local file. WO021: build-info.json is served from
  // the product tree's real desktop/build-info.json (what the app ships next to renderer.html);
  // any other local file is answered as absent. Anything else outside the local server is refused.
  if (!/^[a-z]+:/i.test(u)) {
    localFileFetches.push(u);
    const own = u === 'build-info.json' ? path.join(ROOT, 'desktop', 'build-info.json') : null;
    if (own && fs.existsSync(own)) return new Response(fs.readFileSync(own), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('', { status: 404 });
  }
  if (!apiBase || !u.startsWith(apiBase + '/')) { blockedFetches.push(u); throw new Error('WO019 runtime: non-local fetch refused ' + u); }
  const route = u.slice(apiBase.length).split('?')[0];
  apiRequests.push({ route, at: now, bytes: init && typeof init.body === 'string' ? init.body.length : 0,
    body: route === '/api/chat' && init && typeof init.body === 'string' ? init.body : null });
  if (u.startsWith(apiBase + '/api/tts')) return { ok: true, status: 200, json: async () => ({ audioContent: 'QUFBQQ==' }) };
  // Clock boundary: the server child shares the renderer's virtual time (wo019_server_clock_preload.js).
  const headers = new Headers((init && init.headers) || {});
  headers.set('x-wo019-clock-ms', String(now));
  init = { ...(init || {}), headers };
  // A /api/chat request started by `say_start` is HELD at the SDK boundary: it is counted
  // separately so the runtime keeps processing Bridge traffic while the reply is in flight.
  const held = holdNextChat && route === '/api/chat';
  if (held) { holdNextChat = false; heldInflight++; } else inflight++;
  let done = false;
  const finish = () => { if (!done) { done = true; if (held) heldInflight--; else inflight--; } };
  let res;
  try { res = await fetch(u, init); } catch (e) { finish(); throw e; }
  if (!res.body) { finish(); return res; }
  if (route !== '/api/chat') {
    // Non-streaming routes: read the whole real server response, then hand back an identical one
    // (a consumer that only checks res.ok must not keep the runtime "busy").
    let buf;
    try { buf = await res.arrayBuffer(); } finally { finish(); }
    return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  // /api/chat stays chunk-for-chunk (judge transport/NDJSON boundaries are product behaviour).
  const body = res.body.pipeThrough(new TransformStream({ flush() { finish(); } }));
  const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  // A consumer that abandons the body (abort/cancel) must not leave the runtime "busy" forever.
  if (init && init.signal) init.signal.addEventListener('abort', finish, { once: true });
  return out;
}

function spawnServer(port, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      ['-r', path.join(ROOT, 'tests-wo001-anthropic-stream-stub-preload.js'),
        '-r', path.join(__dirname, 'wo019_server_clock_preload.js'), path.join(ROOT, 'server.js')],
      { cwd: ROOT, env: { ...process.env, ...env, PORT: String(port), ANTHROPIC_API_KEY: 'sk-test-local-stub', DATABASE_URL: '', JWT_SECRET: '', STRIPE_SECRET_KEY: '', GOOGLE_API_KEY: '', GOOGLE_APPLICATION_CREDENTIALS: '' } });
    const timer = setTimeout(() => reject(new Error('server.js did not start in time')), 15000);
    child.stdout.on('data', d => { consoleBuf.push('[server] ' + d); if (d.toString().includes('is running')) { clearTimeout(timer); resolve(child); } });
    child.stderr.on('data', d => consoleBuf.push('[server] ' + d));
    child.on('exit', code => { clearTimeout(timer); reject(new Error('server.js exited early: code=' + code)); });
  });
}

// ── read-only observation helpers (never mutate product state) ─────────────────
// Utterances from the harvested full trace. `sinceIdx` is a traceAll index; an utterance whose
// first state was seen before it is still reported with only its later states.
function utterances(sinceIdx) {
  harvestTrace();
  const byUid = new Map();
  for (const e of traceAll.slice(sinceIdx || 0)) {
    const cur = byUid.get(e.uid) || { uid: e.uid, states: [], at: e.at };
    cur.states.push(e.state);
    if (e.text) cur.text = e.text;
    if (e.kind) cur.kind = e.kind;
    if (e.source) cur.source = e.source;
    if (e.reason) cur.reason = e.reason;
    byUid.set(e.uid, cur);
  }
  return [...byUid.values()];
}
function traceMark() { harvestTrace(); return traceAll.length; }
function socketNow() { return sockets[sockets.length - 1] || null; }
function drainOutbound() { return outbound.splice(0, outbound.length); }

(async () => {
  const port = Number(process.argv[2] || 0);
  const queueDir = process.argv[3];
  const captureFile = process.argv[4];
  if (!port || !queueDir || !captureFile) throw new Error('usage: wo019_desktop_runtime.js <port> <sdkQueueDir> <captureFile>');
  const server = await spawnServer(port, { WO019_SDK_QUEUE_DIR: queueDir, WO014_SYSTEM_CAPTURE_FILE: captureFile });
  const respond = (id, payload) => process.stdout.write(JSON.stringify({ id, ...payload }) + '\n');

  async function handle(msg) {
    const { cmd } = msg;
    if (Number.isFinite(msg.nowMs) && msg.nowMs > now) await advanceTo(msg.nowMs);
    switch (cmd) {
      case 'boot': {
        now = Number(msg.nowMs) || now;
        store.set('pw_auth_user', JSON.stringify(msg.user));
        store.set('pw_auth_token', 'wo019-local-token');
        store.set('pw_ui_lang', 'ja');
        const built = buildRuntime('http://127.0.0.1:' + port);
        ev('userName=' + JSON.stringify(msg.user.name) + ';selectEng("LunaJP");selectMode("race_weekend");startSession();');
        await settle();
        return { ok: true, journalDir: built.journalDir, sockets: sockets.length, sel: ev('sel'), selMode: ev('selMode') };
      }
      case 'ws_open': {
        const s = socketNow();
        if (!s || s.readyState !== 0) return { ok: false, error: 'no connecting socket' };
        s.readyState = 1; s.onopen && s.onopen();
        await settle();
        return { ok: true, socket: s.index, outbound: drainOutbound() };
      }
      case 'ws_deliver': {
        // Bridge -> renderer, through the real onmessage of the CURRENT socket only.
        const s = socketNow();
        const delivered = [];
        for (const raw of msg.messages || []) {
          if (!s || s.readyState !== 1) break;
          s.onmessage && s.onmessage({ data: raw });
          delivered.push(1);
          await new Promise(r => setImmediate(r));
        }
        await settle();
        return { ok: true, delivered: delivered.length, outbound: drainOutbound(), socket: s ? s.index : null };
      }
      case 'ws_drop': {
        // Bridge process / socket lost: the real onclose runs and the real reconnect timer is armed.
        const s = socketNow();
        if (s) s.close();
        await settle();
        return { ok: true, sockets: sockets.length };
      }
      case 'advance': {
        await advanceTo(Number(msg.toMs));
        return { ok: true, now, sockets: sockets.length, connecting: !!(socketNow() && socketNow().readyState === 0), outbound: drainOutbound() };
      }
      case 'say': {
        const fuelSnapshot=ev('canonicalLifecycleCache.current()');
        const fuelSource=fuelSnapshot?{snapshot_id:fuelSnapshot.snapshot_id,source_frame:fuelSnapshot.source_frame,
          current_facts:fuelSnapshot.current_facts,finish:fuelSnapshot.finish,
          fuel_calculation:fuelSnapshot.recommendations.fuel_strategy||null}:null;
        const before = traceMark();
        const msgsBefore = ev('messages.length');
        await ev('sendMsg')('typed', { text: msg.text });
        await settle();
        return { ok: true, fuelSource, outbound: drainOutbound(), utterances: utterances(before),
          assistant: ev('messages').slice(msgsBefore).filter(m => m.role === 'assistant').map(m => m.content) };
      }
      case 'say_start': {
        // Driver turn whose provider reply is held at the SDK file barrier (msg.gateDir):
        // returns once the real request reached the provider stub; the turn stays open.
        if (pendingSay) return { ok: false, error: 'a held turn is already open' };
        const before = traceMark(), msgsBefore = ev('messages.length');
        holdNextChat = true;
        const promise = ev('sendMsg')('typed', { text: msg.text });
        pendingSay = { promise, before, msgsBefore, error: null };
        promise.catch(e => { pendingSay && (pendingSay.error = String(e && e.stack || e)); });
        const arrived = path.join(msg.gateDir, 'arrived');
        for (let i = 0; i < 2500 && !fs.existsSync(arrived); i++) { await settle(); await realSleep(4); }
        if (!fs.existsSync(arrived)) { holdNextChat = false; return { ok: false, error: 'held request never reached the provider stub' }; }
        await settle();
        return { ok: true, outbound: drainOutbound(), heldInflight };
      }
      case 'say_finish': {
        if (!pendingSay) return { ok: false, error: 'no held turn' };
        fs.writeFileSync(path.join(msg.gateDir, 'release'), '1');
        const p = pendingSay; pendingSay = null;
        await p.promise.catch(() => {});
        for (let i = 0; i < 2500 && heldInflight > 0; i++) { await settle(); await realSleep(4); }
        await settle();
        return { ok: true, outbound: drainOutbound(), utterances: utterances(p.before), error: p.error,
          assistant: ev('messages').slice(p.msgsBefore).filter(m => m.role === 'assistant').map(m => m.content) };
      }
      case 'observe': {
        const st = ev('ensureStrategyState()');
        const snap = ev('canonicalLifecycleCache.current()');
        return { ok: true, now,
          strategyState: JSON.parse(JSON.stringify(st || null)),
          canonical: snap ? { snapshot_id: snap.snapshot_id, source_frame: snap.source_frame, race_instance_id: snap.race_instance_id, session_num: snap.session_num,
            bridge_process_epoch: snap.bridge_process_epoch, active: snap.lifecycle && snap.lifecycle.active,
            terminal_records: snap.lifecycle && snap.lifecycle.terminal_records, execution: snap.execution,
            recommendation_sources: Object.fromEntries(Object.entries(snap.recommendations || {}).map(([k, r]) => [k, r && r.calculation_source])),
            pit_events: snap.pit_ledger && snap.pit_ledger.events } : null,
          utterances: utterances(0),
          // null when the product has no recorder (e.g. a pre-WO020 tree): cases fail, harness does not.
          observability: msg.observability ? (() => { try { return JSON.parse(JSON.stringify(ev('observabilitySnapshot()'))); } catch (_) { return null; } })() : undefined,
          driverPlanOutbox: [...ev('driverPlanCommandOutbox').values()].map(e => ({ command_id: e.envelope && e.envelope.command_id, cmd: e.envelope && e.envelope.cmd, intent: e.envelope && e.envelope.intent, attempts: e.attempts })),
          pendingFollowup: JSON.parse(JSON.stringify(ev('pendingDriverPlanFollowup') || null)),
          lastSessionSummary: JSON.parse(JSON.stringify(ev('lastSessionSummary') || null)),
          evidenceDebrief: JSON.parse(JSON.stringify(ev('evidenceDebrief') || null)),
          selMode: ev('selMode'), iracingLive: ev('iracingLive'), bridgeConnected: ev('bridgeConnected'),
          storageKeys: [...store.keys()],
          storage: Object.fromEntries((msg.keys || []).map(k => [k, store.has(k) ? store.get(k) : null])),
          blockedFetches, localFileFetches, timerErrors: timerErrors.slice(), sockets: sockets.length,
          apiRequests: apiRequests.map(r => (msg.apiBodies ? r : { route: r.route, at: r.at, bytes: r.bytes })),
          // Read-only session identity globals (observation only; never assigned here).
          identity: Object.fromEntries(['userName', 'lastTrack', 'lastCarModel', 'lastCarClass', 'lastSessionType']
            .map(k => [k, ev('typeof ' + k + '!=="undefined"?' + k + ':null')])),
          // WO021: what the renderer itself shows/sends as its Build (usage telemetry + start gate).
          build: { usageBuild: ev('typeof usageBuild!=="undefined"?usageBuild:null'), gateBuild: ev('document.getElementById("gate-build").textContent') },
          console: msg.console ? consoleBuf.slice(-Number(msg.console)) : undefined };
      }
      case 'export_support': {
        // The Driver's "Support log" button: the real renderer exportDiagnostics() -> real preload
        // invoke -> real main.js handler. msg.bridgeLog = Bridge stdout lines (empty = no Bridge).
        const logFile = path.join(diagnostics.dir, 'session-' + (++exportSeq) + '.log');
        fs.writeFileSync(logFile, '=== OMORAY PITWALL debug log ===\n' + (msg.bridgeLog || []).map(l => '[00:00:00][main] [bridge] [00:00:00] ' + l).join('\n') + '\n');
        diagnostics.ctx.LOG_FILE = logFile;
        const before = new Set(fs.readdirSync(diagnostics.dir));
        await ev('exportDiagnostics')();
        await settle();
        const made = fs.readdirSync(diagnostics.dir).filter(f => !before.has(f) && f.startsWith('OMORAY-PITWALL-support-'));
        const file = made.length ? path.join(diagnostics.dir, made[0]) : null;
        const text = file ? fs.readFileSync(file, 'utf8') : null;
        if (file) fs.unlinkSync(file);
        return { ok: true, file: file ? path.basename(file) : null, text, outbound: drainOutbound() };
      }
      case 'history_store_write': {
        // Historical storage is an external I/O boundary. No canonical,
        // proposal, permission or execution state can be assigned here.
        const keys=new Set(['pw_raceHistory','pw_fuel_history','pw_fuel_deleted']);
        if(!keys.has(msg.key)||typeof msg.value!=='string'||!Array.isArray(JSON.parse(msg.value)))return {ok:false,error:'invalid historical storage input'};
        store.set(msg.key,msg.value);
        return {ok:true};
      }
      case 'call': {
        // Read-only product getter calls only (named, no arbitrary source): used for the
        // output -> source backtrack (e.g. the LLM debrief context the real builder produces).
        const allowed = new Set(['buildCurrentSessionFactNote', 'buildSessionEvidenceNote', 'buildActiveRaceFactsNote',
          'buildCurrentRaceContext', 'loadEvidenceRecords', 'loadDecisions', 'currentDriverPlanAuthority', 'localMemoryOwnerRef',
          'currentMemoryRaceScope', 'loadRaceHistory', 'currentMemoryBrainPrompt', 'currentCanonicalStrategyLive']);
        if (!allowed.has(msg.fn)) return { ok: false, error: 'not an allowed read-only getter: ' + msg.fn };
        const v = ev(msg.fn)(...(msg.args || []));
        return { ok: true, value: JSON.parse(JSON.stringify(v === undefined ? null : v)) };
      }
      case 'click': {
        // A Driver button press: only the real onclick handlers of renderer buttons.
        const buttons = new Set(['confirmEvidenceMemory', 'discardEvidenceMemory']);
        if (!buttons.has(msg.fn)) return { ok: false, error: 'not an allowed button handler: ' + msg.fn };
        const before = traceMark();
        ev(msg.fn)();
        await settle();
        return { ok: true, outbound: drainOutbound(), utterances: utterances(before) };
      }
      case 'shutdown': {
        server.kill('SIGTERM');
        return { ok: true, exit: true };
      }
      default:
        return { ok: false, error: 'unknown cmd ' + cmd };
    }
  }

  const rl = readline.createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on('line', line => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let msg; try { msg = JSON.parse(line); } catch (e) { respond(null, { ok: false, error: 'bad json' }); return; }
      try { const out = await handle(msg); respond(msg.id, out); if (out && out.exit) process.exit(0); }
      catch (e) { respond(msg.id, { ok: false, error: String(e && e.stack || e), console: consoleBuf.slice(-30) }); }
    });
  });
  process.stdout.write(JSON.stringify({ ready: true }) + '\n');
})().catch(e => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
