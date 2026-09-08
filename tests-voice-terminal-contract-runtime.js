#!/usr/bin/env node
/*
 * Voice terminal contract fixture.
 *
 * A: execute four functions dynamically extracted from desktop/renderer.html
 *    in a Node vm with explicit, observable stubs.
 * B: statically inspect the seven RECORD call sites using the same lexical
 *    scanner used for source extraction. It does not execute briefing code.
 *
 * Default mode is the contract gate and exits 1 while any violation remains.
 * `--baseline` is available only to characterize an older checkout that still
 * contains the known violations.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rendererPath = path.join(__dirname, 'desktop', 'renderer.html');
const baselineMode = process.argv.includes('--baseline');
const source = fs.readFileSync(rendererPath, 'utf8');

function fail(message) {
  throw new Error(message);
}

function isIdentStart(ch) { return /[A-Za-z_$]/.test(ch || ''); }
function isIdentPart(ch) { return /[A-Za-z0-9_$]/.test(ch || ''); }

// Skip a quoted string or template literal. Template interpolations are parsed
// as code, including nested braces, strings, comments, and regex literals.
function skipQuoted(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      const end = findMatching(text, i + 1, '{', '}');
      i = end + 1;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  fail(`unterminated ${quote === '`' ? 'template literal' : 'string'} at offset ${start}`);
}

function skipLineComment(text, start) {
  const end = text.indexOf('\n', start + 2);
  return end < 0 ? text.length : end + 1;
}

function skipBlockComment(text, start) {
  const end = text.indexOf('*/', start + 2);
  if (end < 0) fail(`unterminated block comment at offset ${start}`);
  return end + 2;
}

// A conservative regex-literal recognizer. The target code does not use a
// regex literal in these blocks, but this prevents a regex body from changing
// delimiter depth if it appears in a future edit.
function isRegexStart(text, slash) {
  let i = slash - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true;
  return '([{:;,=!?&|+-*%^~<>'.includes(text[i]);
}

function skipRegex(text, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '[') { inClass = true; i++; continue; }
    if (ch === ']') { inClass = false; i++; continue; }
    if (ch === '/' && !inClass) {
      i++;
      while (/[A-Za-z]/.test(text[i] || '')) i++;
      return i;
    }
    if (ch === '\n') fail(`unterminated regex literal at offset ${start}`);
    i++;
  }
  fail(`unterminated regex literal at offset ${start}`);
}

// Finds a matching close delimiter while treating JS lexical constructs as
// opaque. The same scanner serves function, if-block, call, object, and array
// boundaries; it never relies on a `[^}]*` shortcut.
function findMatching(text, start, open, close) {
  if (text[start] !== open) fail(`expected ${open} at offset ${start}`);
  let depth = 0;
  for (let i = start; i < text.length;) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipQuoted(text, i); continue; }
    if (ch === '/' && next === '/') { i = skipLineComment(text, i); continue; }
    if (ch === '/' && next === '*') { i = skipBlockComment(text, i); continue; }
    if (ch === '/' && isRegexStart(text, i)) { i = skipRegex(text, i); continue; }
    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) fail(`unexpected ${close} at offset ${i}`);
    }
    i++;
  }
  fail(`no matching ${close} for ${open} at offset ${start}`);
}

function lineAt(offset) {
  return source.slice(0, offset).split('\n').length;
}

function findUniqueFunction(name) {
  const pattern = new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g');
  const hits = [...source.matchAll(pattern)];
  if (hits.length !== 1) fail(`${name}: expected one declaration, found ${hits.length}`);
  const start = hits[0].index;
  const open = source.indexOf('{', start);
  if (open < 0) fail(`${name}: opening brace not found`);
  const end = findMatching(source, open, '{', '}');
  const code = source.slice(start, end + 1);
  new vm.Script(code, { filename: `${name}.extracted.js` });
  return { name, start, end, startLine: lineAt(start), endLine: lineAt(end), code,
    sha256: crypto.createHash('sha256').update(code).digest('hex') };
}

function findUniqueAnchor(pattern, label) {
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const matches = [...source.matchAll(globalPattern)];
  if (matches.length !== 1) fail(`${label}: expected one anchor, found ${matches.length}`);
  const start = matches[0].index;
  const open = source.indexOf('{', start + matches[0][0].length - 1);
  if (open < 0) fail(`${label}: opening brace not found`);
  const end = findMatching(source, open, '{', '}');
  return { start, open, end, code: source.slice(start, end + 1) };
}

function findNamedCalls(text, name) {
  const calls = [];
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipQuoted(text, i); continue; }
    if (ch === '/' && next === '/') { i = skipLineComment(text, i); continue; }
    if (ch === '/' && next === '*') { i = skipBlockComment(text, i); continue; }
    if (ch === '/' && isRegexStart(text, i)) { i = skipRegex(text, i); continue; }
    if (text.startsWith(name, i) && !isIdentPart(text[i - 1]) && !isIdentPart(text[i + name.length])) {
      let p = i + name.length;
      while (/\s/.test(text[p] || '')) p++;
      if (text[p] === '(') {
        const end = findMatching(text, p, '(', ')');
        calls.push({ start: i, open: p, end, text: text.slice(i, end + 1) });
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return calls;
}

function splitTopLevel(text, separator) {
  const result = [];
  let last = 0;
  const pairs = { '(': ')', '{': '}', '[': ']' };
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipQuoted(text, i); continue; }
    if (ch === '/' && next === '/') { i = skipLineComment(text, i); continue; }
    if (ch === '/' && next === '*') { i = skipBlockComment(text, i); continue; }
    if (ch === '/' && isRegexStart(text, i)) { i = skipRegex(text, i); continue; }
    if (pairs[ch]) { i = findMatching(text, i, ch, pairs[ch]) + 1; continue; }
    if (ch === separator) { result.push(text.slice(last, i).trim()); last = i + 1; }
    i++;
  }
  result.push(text.slice(last).trim());
  return result;
}

function topLevelColon(text) {
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipQuoted(text, i); continue; }
    if (ch === ':' ) return i;
    if (ch === '(') { i = findMatching(text, i, '(', ')') + 1; continue; }
    if (ch === '{') { i = findMatching(text, i, '{', '}') + 1; continue; }
    if (ch === '[') { i = findMatching(text, i, '[', ']') + 1; continue; }
    i++;
  }
  return -1;
}

function expressionOfObjectProperty(objectText, property) {
  const trimmed = objectText.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  const inner = trimmed.slice(1, -1);
  for (const part of splitTopLevel(inner, ',')) {
    const colon = topLevelColon(part);
    if (colon < 0) {
      // JavaScript object shorthand: { messageId } is equivalent to
      // { messageId: messageId } and is the preferred production form.
      if (part.trim() === property) return property;
      continue;
    }
    const key = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    if (key === property) return part.slice(colon + 1).trim();
  }
  return null;
}

function normalizeExpression(expr) { return String(expr || '').replace(/\s+/g, ''); }

function bindingBefore(block, callStart) {
  const prefix = block.slice(0, callStart);
  const statementStart = Math.max(prefix.lastIndexOf(';'), prefix.lastIndexOf('{'), prefix.lastIndexOf('}')) + 1;
  const statement = prefix.slice(statementStart).trim();
  const match = statement.match(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
  return match ? match[1] : null;
}

const ROUTES = [
  ['bridge_status', /if\s*\(\s*msg\s*\)\s*\{/, 'msg'],
  ['luna_self_memory', /if\s*\(\s*selfLine\s*\)\s*\{/, 'selfLine'],
  ['memory_strategy', /if\s*\(\s*memoryLine\s*\)\s*\{/, 'memoryLine'],
  ['decision_strategy', /if\s*\(\s*_decLine\s*\)\s*\{/, '_decLine'],
  ['setup_comparison', /if\s*\(\s*_setupLine\s*\)\s*\{/, '_setupLine'],
  ['pddp_briefing', /if\s*\(\s*_pddpLine\s*\)\s*\{/, '_pddpLine'],
  ['decision_plan_advice', /if\s*\(\s*_decAdvice\.reply\s*\)\s*\{/, '_decAdvice.reply']
];

function inspectRoute(route, anchor, expression) {
  const block = findUniqueAnchor(anchor, route);
  const pushCalls = findNamedCalls(block.code, 'pushMsg');
  const speakCalls = findNamedCalls(block.code, 'speak');
  if (pushCalls.length !== 1 || speakCalls.length !== 1) {
    fail(`${route}: expected exactly one pushMsg and one speak in anchor block; found ${pushCalls.length}/${speakCalls.length}`);
  }
  const push = pushCalls[0];
  const speak = speakCalls[0];
  const pushArgs = splitTopLevel(block.code.slice(push.open + 1, push.end), ',');
  const speakArgs = splitTopLevel(block.code.slice(speak.open + 1, speak.end), ',');
  if (pushArgs.length !== 1) fail(`${route}: pushMsg must have one argument`);
  if (speakArgs.length < 1 || speakArgs.length > 2) fail(`${route}: speak must have one text argument or text plus options`);
  const contentExpression = expressionOfObjectProperty(pushArgs[0], 'content');
  if (contentExpression === null) fail(`${route}: pushMsg first argument lacks content property`);
  const messageIdExpression = speakArgs.length === 2 ? expressionOfObjectProperty(speakArgs[1], 'messageId') : null;
  const idVar = bindingBefore(block.code, push.start);
  const contentMatches = normalizeExpression(contentExpression) === normalizeExpression(expression);
  const textMatches = normalizeExpression(speakArgs[0]) === normalizeExpression(expression);
  const idMatches = !!idVar && normalizeExpression(messageIdExpression) === normalizeExpression(idVar);
  return {
    route,
    startLine: lineAt(block.start),
    endLine: lineAt(block.end),
    contentMatches,
    textMatches,
    idVar,
    idMatches,
    pushEvidence: push.text,
    speakEvidence: speak.text,
    verdict: contentMatches && textMatches && idVar && idMatches ? 'PASS' : 'RED'
  };
}

function makeParent() {
  return {
    removed: [],
    removeChild(el) { this.removed.push(el); el.parentNode = null; }
  };
}

function makeDisplay(parent, { overlayId = 'ovl', turnId = 'turn', text = 'test' } = {}) {
  return { parentNode: parent, _uid: `u_${turnId}`, _ovlId: overlayId, _turnId: turnId,
    _ovlText: text, textContent: text };
}

function loadRuntime() {
  const extracted = ['finalizeUtterance', 'discardQueuedUtterances', 'stopCurrentAudio', 'toggleVoice']
    .map(findUniqueFunction);
  const calls = { overlay: [], droppedTurns: [], removedMessages: [], cancelled: 0, paused: 0,
    timeouts: [], logs: [], persistent: [], drain: 0 };
  const messages = [];
  const turns = new Map();
  const context = {
    messages,
    window: { pitwall: { overlayPush: event => calls.overlay.push(event) },
      speechSynthesis: { cancel: () => { calls.cancelled++; } } },
    removeMessageById: mid => {
      const index = messages.findIndex(message => message && message._mid === mid);
      if (index >= 0) { messages.splice(index, 1); calls.removedMessages.push(mid); return true; }
      return false;
    },
    dropLunaTurnById: turnId => { calls.droppedTurns.push(turnId); return turns.delete(turnId); },
    lunaTurnTextById: turnId => turns.has(turnId) ? turns.get(turnId) : null,
    diagnosticLog: (...args) => calls.logs.push(args),
    document: { getElementById: () => ({ textContent: '', classList: { toggle: () => {} } }) },
    t: key => key,
    persistentSet: (...args) => calls.persistent.push(args),
    speechSynthesis: undefined,
    speakGeneration: 0,
    speakFetchCtrl: null,
    ttsAudio: { onended: null, onerror: null, pause: () => { calls.paused++; } },
    speakWatchdog: null,
    isSpeaking: false,
    draining: false,
    currentSpeakPrio: 0,
    currentSpeakItem: null,
    speakQueue: [],
    voiceOn: true,
    clearTimeout: () => {},
    setTimeout: (fn, ms) => { calls.timeouts.push(ms); if (fn === context.drainQueue) calls.drain++; return 1; },
    drainQueue: () => { calls.drain++; },
    console,
    String,
    Array
  };
  const sandbox = vm.createContext(context);
  vm.runInContext(extracted.map(item => item.code).join('\n\n'), sandbox,
    { filename: 'renderer-terminal-extract.vm.js' });
  return { context: sandbox, calls, messages, turns, extracted };
}

function observation(name, actual, expected) {
  return { name, actual, expected, pass: actual === expected };
}

function runRuntimeCases() {
  const results = [];

  { // visible pending
    const rt = loadRuntime();
    const parent = makeParent();
    const el = makeDisplay(parent, { overlayId: 'ovl_visible', turnId: 'turn_visible' });
    rt.turns.set('turn_visible', 'visible');
    rt.messages.push({ _mid: 'm_visible', role: 'assistant', content: 'visible' }, { _mid: 'm_other', role: 'assistant', content: 'other' });
    const item = { messageId: 'm_visible', displayEl: el, text: 'visible', kind: 'test' };
    rt.context.speakQueue = [item];
    rt.context.toggleVoice();
    results.push({ name: 'VOICE_OFF_VISIBLE_PENDING', observations: [
      observation('chat_dom', el.parentNode !== null, true),
      observation('overlay', rt.calls.overlay.length === 0, true),
      observation('conversation_box', rt.turns.has('turn_visible'), true),
      observation('llm_history', rt.messages.some(m => m._mid === 'm_visible'), true),
      observation('tts_queue', rt.context.speakQueue.length === 0, true),
      observation('audio_cancelled', rt.calls.cancelled > 0, true),
      observation('outcome', item._finalized, 'suppressed_by_user')
    ] });
  }

  { // deferred pending: history exists but fan-out was deliberately not created
    const rt = loadRuntime();
    rt.messages.push({ _mid: 'm_deferred', role: 'assistant', content: 'deferred' });
    const item = { messageId: 'm_deferred', text: 'deferred', kind: 'test' };
    rt.context.speakQueue = [item];
    rt.context.toggleVoice();
    results.push({ name: 'VOICE_OFF_DEFERRED_PENDING', observations: [
      observation('chat_dom_not_created', item.displayEl === undefined, true),
      observation('overlay_not_created', rt.calls.overlay.length === 0, true),
      observation('conversation_box_not_created', rt.calls.droppedTurns.length === 0, true),
      observation('llm_history', rt.messages.some(m => m._mid === 'm_deferred'), true),
      observation('tts_queue', rt.context.speakQueue.length === 0, true),
      observation('audio_cancelled', rt.calls.cancelled > 0, true),
      observation('outcome', item._finalized, 'suppressed_by_user')
    ] });
  }

  { // after start
    const rt = loadRuntime();
    const parent = makeParent();
    const el = makeDisplay(parent, { overlayId: 'ovl_started', turnId: 'turn_started' });
    rt.turns.set('turn_started', 'started');
    rt.messages.push({ _mid: 'm_started', role: 'assistant', content: 'started' });
    // The product marks an item spoken at the real playback-start boundary.
    // An interruption after that boundary must retain the four visible/history
    // outputs while changing only the terminal outcome.
    const item = { messageId: 'm_started', displayEl: el, text: 'started', kind: 'test', _finalized: 'spoken' };
    rt.context.currentSpeakItem = item;
    rt.context.isSpeaking = true;
    rt.context.speakQueue = [];
    rt.context.toggleVoice();
    results.push({ name: 'VOICE_OFF_AFTER_START', observations: [
      observation('chat_dom', el.parentNode !== null, true),
      observation('overlay', rt.calls.overlay.length === 0, true),
      observation('conversation_box', rt.turns.has('turn_started'), true),
      observation('llm_history', rt.messages.some(m => m._mid === 'm_started'), true),
      observation('tts_queue', rt.context.speakQueue.length === 0, true),
      observation('audio_stopped', rt.calls.cancelled > 0 && rt.calls.paused > 0, true),
      observation('outcome', item._finalized, 'audible_interrupted')
    ] });
  }

  { // technical pre-start failure: direct finalizer must not splice its queue
    const rt = loadRuntime();
    const parent = makeParent();
    const el = makeDisplay(parent, { overlayId: 'ovl_fail', turnId: 'turn_fail' });
    rt.turns.set('turn_fail', 'failure');
    rt.messages.push({ _mid: 'm_fail', role: 'assistant', content: 'fail' },
      { _mid: 'm_other2', role: 'assistant', content: 'other2' },
      { _mid: 'm_other3', role: 'assistant', content: 'other3' });
    const item1 = { messageId: 'm_fail', displayEl: el, text: 'fail', kind: 'test' };
    const item2 = { messageId: 'm_other2', text: 'other2', kind: 'test' };
    rt.context.speakQueue = [item1, item2];
    const initialQueue = rt.context.speakQueue;
    rt.context.finalizeUtterance(item1, 'dropped', null, 'api_error');
    results.push({ name: 'TECHNICAL_FAILURE_BEFORE_START', observations: [
      observation('affected_dom_deleted', el.parentNode === null, true),
      observation('affected_overlay_deleted', rt.calls.overlay.length === 1, true),
      observation('affected_box_deleted', !rt.turns.has('turn_fail'), true),
      observation('affected_history_deleted', !rt.messages.some(m => m._mid === 'm_fail'), true),
      observation('other_history_retained', rt.messages.some(m => m._mid === 'm_other2') && rt.messages.some(m => m._mid === 'm_other3'), true),
      observation('queue_reference_unchanged', rt.context.speakQueue === initialQueue, true),
      observation('queue_contents_unchanged', rt.context.speakQueue.length === 2 && rt.context.speakQueue[0] === item1, true),
      observation('outcome', item1._finalized, 'dropped_before_audible')
    ] });
  }
  return results;
}

const extracted = ['finalizeUtterance', 'discardQueuedUtterances', 'stopCurrentAudio', 'toggleVoice'].map(findUniqueFunction);
const routeResults = ROUTES.map(([route, anchor, expression]) => inspectRoute(route, anchor, expression));
const runtimeResults = runRuntimeCases();
const runtimeViolations = runtimeResults.flatMap(test => test.observations.filter(item => !item.pass).map(item => `${test.name}:${item.name}`));
const routeViolations = routeResults.filter(result => result.verdict === 'RED').map(result => result.route);

console.log('VOICE TERMINAL CONTRACT FIXTURE');
console.log(`renderer_sha256=${crypto.createHash('sha256').update(source).digest('hex')}`);
console.log('A: extracted original functions');
for (const item of extracted) console.log(`  ${item.name} lines=${item.startLine}-${item.endLine} sha256=${item.sha256.slice(0, 16)}`);
console.log('B: messageId propagation audit (static)');
for (const result of routeResults) {
  console.log(`  ${result.route} lines=${result.startLine}-${result.endLine} content=${result.contentMatches} text=${result.textMatches} binding=${result.idVar || '-'} id_pass=${result.idMatches} => ${result.verdict}`);
  console.log(`    push: ${result.pushEvidence.replace(/\s+/g, ' ')}`);
  console.log(`    speak: ${result.speakEvidence.replace(/\s+/g, ' ')}`);
}
console.log('A: terminal outcomes (runtime)');
for (const test of runtimeResults) {
  console.log(`  ${test.name}`);
  for (const item of test.observations) console.log(`    ${item.name}: actual=${JSON.stringify(item.actual)} expected=${JSON.stringify(item.expected)} => ${item.pass ? 'PASS' : 'RED'}`);
}
console.log(`SUMMARY static_red=${routeViolations.length}/7 runtime_red=${runtimeViolations.length} observations=${runtimeResults.reduce((n, test) => n + test.observations.length, 0)}`);

if (baselineMode) {
  assert.strictEqual(routeViolations.length, 7, 'baseline must expose all seven missing messageId propagations');
  assert(runtimeViolations.length > 0, 'baseline must expose terminal contract violations');
} else {
  assert.strictEqual(routeViolations.length, 0, `messageId contract violations: ${routeViolations.join(', ')}`);
  assert.strictEqual(runtimeViolations.length, 0, `terminal contract violations: ${runtimeViolations.join(', ')}`);
}
