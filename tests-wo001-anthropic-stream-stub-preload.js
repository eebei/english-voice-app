'use strict';

// WO-001 (review/PITWALL_ARCHITECTURE_REPAIR_PROGRAM.md) — test-only Anthropic
// SDK stub for the Server-stream slice of the Road Atlanta red-thread fixture
// (F02: a trailing <<PW_JUDGE ...>> tag with no sentence punctuation is
// silently dropped by server.js's emitCompleteSentences()).
//
// This preload boots the REAL server.js (child process, exactly like
// tests-chat-http.js's `withServer()` pattern) and replaces only the
// external I/O boundary: the Anthropic SDK constructor. No other server.js
// behaviour is touched, and no network call is ever made.
//
// Reused as-is from tests-auth-ready-preload.js: auth stubbing, so the
// server boots without Postgres.
require('./tests-auth-ready-preload.js');

// The Anthropic cache entry was just set by the require above. Replace it
// again with a controllable streaming stub. A request selects its scripted
// response by embedding a marker in the LAST user message's content:
//
//   __WO001_STREAM__:<base64 JSON { chunks: string[] }>
//
// The stub yields one content_block_delta per array entry, in order, with
// no punctuation-normalizing or reformatting of its own — the caller
// controls chunk boundaries exactly, so both "one big chunk" and "many
// small chunks" scenarios exercise the exact same server.js code path.
// Any request without the marker falls back to the original 401 stub
// (fail-closed default preserved for any other route this process serves).
//
// ★2026-10-08 WO013途中レビュー対応：server.jsのjudgeTransport:'v1'完了判定は
// 実SDKのmessage_stopイベントと正常stop_reason（end_turn/stop_sequence）を
// 要求する。この stub もその2点を再現可能にする——既定は正常完了（互換維持、
// 既存の{chunks:[...]}だけのpayloadも何も変えずに動く）。stopReason/
// omitMessageStopを明示した時だけ異常完了（max_tokens・message_stop欠落）を
// 再現できる。
// ★2026-10-08 WO013 r7独立読取差戻し：既存のTTL/staleness検査は「実HTTPが
//   完了した後」の配送待ち窓しか作れていなかった（親差戻しの指摘）。holdGateDir
//   を指定すると、全contentチャンクを送った後・message_delta/message_stopの
//   直前で、実HTTPレスポンスそのものをファイルベースの決定的barrierで止める
//   ——sleep固定時間の推測待ちではなく、呼び出し側（テスト）が明示的に
//   `release`ファイルを作るまで本当にHTTP応答が完了しない。これにより
//   「実ネットワーク往復が本当に未完了の間」に入力世代／scope・epoch／
//   awaiting記録のrevisionを変える負例を作れる。
const MARKER = '__WO001_STREAM__:';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD_GATE_POLL_MS = 10;
const HOLD_GATE_TIMEOUT_MS = 5000;

// ★WO016: server.js now passes {signal} (provider abort on client disconnect)
// as the SDK's 2nd create() argument. The stub honours it like the real SDK:
// once aborted, the hold/stream stops with an AbortError and -- only when a
// holdGateDir exists -- writes a `provider_aborted` marker so a test can
// observe the abort deterministically (a non-cancelled control never gets it).
function abortError() {
  const e = new Error('Request was aborted.');
  e.name = 'AbortError';
  return e;
}
function markProviderAborted(gateDir) {
  if (!gateDir) return;
  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(gateDir, 'provider_aborted'), String(Date.now()));
}

// ★WO016 (fixture wait contract): a scenario whose observer may legitimately wait longer than
// the default hold can pass `holdTimeoutMs` so the stub's auto-release never fires before the
// observer's own deadline. Default (5s) is unchanged for every other caller.
async function waitForGateRelease(gateDir, signal, holdTimeoutMs) {
  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(gateDir, 'arrived'), String(Date.now()));
  const deadline = Date.now() + (Number.isFinite(holdTimeoutMs) && holdTimeoutMs > 0 ? holdTimeoutMs : HOLD_GATE_TIMEOUT_MS);
  while (!fs.existsSync(path.join(gateDir, 'release'))) {
    if (signal && signal.aborted) { markProviderAborted(gateDir); throw abortError(); }
    if (Date.now() > deadline) {
      throw new Error('WO001 stub: holdGateDir release never arrived within '
        + HOLD_GATE_TIMEOUT_MS + 'ms (gateDir=' + gateDir + ')');
    }
    await sleep(HOLD_GATE_POLL_MS);
  }
}

function decodeChunks(messages, req) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    const content = typeof m.content === 'string' ? m.content : '';
    const idx = content.indexOf(MARKER);
    if (idx < 0) continue;
    // ★WO014 round4 (actual-vertical, scheduleAutoBriefing case): some
    // real callers (scheduleAutoBriefing) interpolate a helper's return
    // value into the MIDDLE of a larger fixed template, not at the string's
    // end -- a bare `.slice(...).trim()` would swallow whatever fixed text
    // follows the marker too, corrupting the JSON. Stop at the first
    // character outside the base64 alphabet instead; identical result when
    // the marker IS at the end (every existing caller), strictly more
    // permissive otherwise.
    const b64 = (content.slice(idx + MARKER.length).match(/^[A-Za-z0-9+/=]+/) || [''])[0];
    const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (!Array.isArray(decoded.chunks)) throw new Error('WO001 stub: chunks must be an array');
    return {
      chunks: decoded.chunks,
      stopReason: typeof decoded.stopReason === 'string' ? decoded.stopReason : 'end_turn',
      omitMessageStop: decoded.omitMessageStop === true,
      throwMidStream: decoded.throwMidStream === true,
      holdGateDir: typeof decoded.holdGateDir === 'string' ? decoded.holdGateDir : null,
      // ★WO014 round3 (priority 3, actual-vertical fixture): the pre-round3
      // holdGateDir always paused AFTER every content chunk, before message_
      // delta/message_stop -- that only proves a discard for a mutation
      // happening after the FULL reply text already reached the client. To
      // prove a mutation occurring WHILE a reply is still streaming (the
      // mid-loop fence at the Renderer's `while(true){reader.read()...}` --
      // every chunk BEFORE this index is sent, then the gate holds, so a
      // caller can mutate canonical state strictly between two chunks.
      holdAfterChunk: Number.isInteger(decoded.holdAfterChunk) ? decoded.holdAfterChunk : null,
      holdTimeoutMs: Number.isFinite(decoded.holdTimeoutMs) ? decoded.holdTimeoutMs : null,
    };
  }
  return queuedScenario(list, req);
}

// ★WO019 (one-thread E2E): real Driver utterances must reach the real router/server
// unmodified, so the marker cannot ride inside the user text. Opt-in only: when
// WO019_SDK_QUEUE_DIR is set, a request WITHOUT a marker consumes the oldest saved
// response file (`NNN-*.json`, same {chunks,...} shape) from that directory. An empty
// queue keeps the fail-closed 401 default, so an unscripted LLM call is visible.
// A saved response is bound to the Driver turn it answers (`forUserText` must appear in the
// last user message), so an unrelated concurrent request never consumes it. Only the streaming
// conversation request (/api/chat) consumes it: the overlay subtitle translation of the same
// Driver text (/api/translate, non-streaming) stays on the fail-closed 401 default.
function queuedScenario(messages, req) {
  const dir = process.env.WO019_SDK_QUEUE_DIR;
  if (!dir || !req || req.stream !== true) return null;
  const fs = require('fs');
  const path = require('path');
  let lastUser = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') { lastUser = typeof m.content === 'string' ? m.content : JSON.stringify(m.content); break; }
  }
  const next = fs.readdirSync(dir).filter(f => /^\d+-.*\.json$/.test(f)).sort()
    .find(f => { const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return typeof d.forUserText === 'string' && lastUser.includes(d.forUserText); });
  if (!next) return null;
  const file = path.join(dir, next);
  const decoded = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.renameSync(file, file + '.consumed');
  if (!Array.isArray(decoded.chunks)) throw new Error('WO019 stub queue: chunks must be an array');
  // WO019: a saved response may hold the real HTTP stream at the same file barrier as the
  // marker path (holdGateDir/holdAfterChunk/holdTimeoutMs), so canonical updates can land
  // while the provider reply is genuinely still in flight.
  return { chunks: decoded.chunks, stopReason: 'end_turn', omitMessageStop: false, throwMidStream: false,
    holdGateDir: typeof decoded.holdGateDir === 'string' ? decoded.holdGateDir : null,
    holdAfterChunk: Number.isInteger(decoded.holdAfterChunk) ? decoded.holdAfterChunk : null,
    holdTimeoutMs: Number.isFinite(decoded.holdTimeoutMs) ? decoded.holdTimeoutMs : null };
}

function makeStream(scenario, signal) {
  const { chunks, stopReason, omitMessageStop, throwMidStream, holdGateDir, holdAfterChunk, holdTimeoutMs } = scenario;
  const checkAbort = () => { if (signal && signal.aborted) { markProviderAborted(holdGateDir); throw abortError(); } };
  return (async function* gen() {
    yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } };
    // WO019: holdAfterChunk === -1 holds BEFORE any text, so nothing of the reply exists yet
    // while canonical state changes underneath the in-flight request.
    if (holdGateDir && holdAfterChunk === -1) await waitForGateRelease(holdGateDir, signal, holdTimeoutMs);
    for (let i = 0; i < chunks.length; i++) {
      checkAbort();
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: chunks[i] } };
      if (holdGateDir && holdAfterChunk === i) await waitForGateRelease(holdGateDir, signal, holdTimeoutMs);
    }
    if (throwMidStream) throw new Error('WO001 stub: simulated abnormal mid-stream failure');
    if (holdGateDir && holdAfterChunk === null) await waitForGateRelease(holdGateDir, signal, holdTimeoutMs);
    checkAbort();
    yield { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: chunks.join('').length } };
    if (!omitMessageStop) yield { type: 'message_stop' };
  })();
}

// ★WO014 round3 (priority 3): "actual Server SDKstub capture" -- every other
// WO013/WO014 fixture proved the request/reply ROUND TRIP through a real
// server.js child process, but never captured what the real buildSystem()
// actually sent as `system` to the (stubbed) SDK call, so no fixture could
// assert the FINAL normalized prompt text an invalid/unavailable raceContext
// produces end-to-end through real HTTP. Opt-in only (env var), appends one
// JSON line per request -- never touches the scenario/stream logic above.
function captureSystemIfRequested(req) {
  const file = process.env.WO014_SYSTEM_CAPTURE_FILE;
  if (!file) return;
  const sys = req && req.system;
  const text = Array.isArray(sys) ? sys.map(b => (b && typeof b.text === 'string') ? b.text : '').join('')
    : (typeof sys === 'string' ? sys : '');
  const fs = require('fs');
  fs.appendFileSync(file, JSON.stringify({ system: text, messages: (req && req.messages) || [],
    stream: !!(req && req.stream) }) + '\n');
}

const anthropicPath = require.resolve('@anthropic-ai/sdk');
class Wo001TestAnthropic {
  constructor() {
    this.messages = {
      create: async (req, options) => {
        captureSystemIfRequested(req);
        const scenario = decodeChunks(req && req.messages, req);
        if (scenario === null) {
          const err = new Error('simulated Anthropic 401 (external calls disabled, no WO001 marker)');
          err.status = 401;
          throw err;
        }
        if (req && req.stream) return makeStream(scenario, options && options.signal);
        // ★WO014 round4 (actual-vertical, scheduleAutoBriefing case): the
        // non-stream path (server.js's own non-streaming client.messages.
        // create() call, used by callers that never send body.stream:true)
        // had no real-network-hold support at all, so a mid-flight canonical
        // mutation test (the SAME holdGateDir technique already proven on
        // the streaming path) could only ever exercise streaming callers.
        // Hold here too when requested -- identical no-op when unset.
        if (scenario.holdGateDir) await waitForGateRelease(scenario.holdGateDir, null, scenario.holdTimeoutMs);
        return { content: [{ type: 'text', text: scenario.chunks.join('') }], usage: {} };
      },
    };
  }
}
Wo001TestAnthropic.defaultHttpClient = {};
require.cache[anthropicPath] = {
  id: anthropicPath, filename: anthropicPath, loaded: true, exports: Wo001TestAnthropic,
};

module.exports = { MARKER, decodeChunks };
