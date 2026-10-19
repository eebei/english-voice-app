#!/usr/bin/env node
'use strict';
/* WO020 — desktop/observability-trace.js unit contract (deterministic, no IO, no paid API).
 * The real-product path (renderer transition points -> recorder -> preload -> main.js Support
 * export, Bridge [TRACE] lines) is exercised by irsdk-bridge/tests_wo019_road_atlanta_e2e.py
 * W01-W06; this file pins the recorder's own failure paths.
 *   node tests-wo020-observability.js [--artifact FILE]   (writes a synthetic, labelled snapshot)
 */
const fs = require('fs');
const path = require('path');
const O = require('./desktop/observability-trace.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; console.log('❌ ' + name + ' ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 600)); }
}
function clockOf(values) { let i = 0; return () => values[Math.min(i++, values.length - 1)]; }
const SRC = { scope: { race_instance_id: 'sub:1', session_num: 0 }, epoch: 'ep1', decision_id: 'd1', revision: 2,
  publication_ref: { canonical_snapshot_id: 'ep1:5', canonical_snapshot_sequence: 5 },
  ref: { attempt_id: 'box-attempt:p1:1', proof_id: 'p1', driver_pit_sequence: 0 } };

// 1. Full lifecycle on one monotonic clock; waits measured from queued.
{
  const r = O.createRecorder({ clock: clockOf([0, 10, 40, 45, 1045]) });
  for (const st of ['generated', 'queued', 'tts_start', 'play_started', 'completed']) r.utterance('u1', st, { source: SRC, kind: 'strategy_plan_box_call', queueDepth: 2 });
  const s = r.snapshot();
  const ev = s.events.filter(e => e.uid === 'u1');
  ok('lifecycle waits from the monotonic clock', ev.find(e => e.state === 'tts_start').wait_ms === 30 && ev.find(e => e.state === 'play_started').wait_ms === 35
    && ev.find(e => e.state === 'completed').wait_ms === 1000 && s.queue.depth_ahead.max === 2, ev);
  ok('native ids copied, none minted', JSON.stringify(ev[0].ids) === JSON.stringify({ race_instance_id: 'sub:1', session_num: 0, bridge_process_epoch: 'ep1',
    decision_id: 'd1', revision: 2, canonical_snapshot_id: 'ep1:5', canonical_snapshot_sequence: 5, source_frame_sequence: null,
    activation_frame: null, driver_pit_sequence: 0, pit_event_id: null, box_attempt_id: 'box-attempt:p1:1', proof_id: 'p1' }), ev[0].ids);
  ok('completed counted once', s.terminal_outcomes.completed === 1 && s.counters.open_without_terminal === 0, s.terminal_outcomes);
  ok('per-event monotonic t_ms (one clock read per transition)', JSON.stringify(ev.map(e => e.t_ms)) === JSON.stringify([0, 10, 40, 45, 1045]) && s.clock === 'renderer_monotonic_ms', ev.map(e => e.t_ms));
  const clean = O.sanitizeRendererSnapshot(s);
  ok('sanitized Support events keep t_ms', clean.events.filter(e => e.uid === 'u1').map(e => e.t_ms).join(',') === '0,10,40,45,1045', clean.events.map(e => e.t_ms));
}
// 1b. Provenance: a Plan activation frame is never relabelled as the source frame.
{
  const r = O.createRecorder({ clock: () => 1 });
  r.utterance('u1b', 'queued', { source: { ref: { activation_frame: 16, proof_id: 'p9' }, publication_ref: { canonical_snapshot_id: 'ep:76', canonical_snapshot_sequence: 76 } } });
  const ids = r.snapshot().events[0].ids;
  ok('activation_frame kept separate; missing source_frame stays null', ids.activation_frame === 16 && ids.source_frame_sequence === null
    && ids.canonical_snapshot_sequence === 76, ids);
}
// 2. Missing source: every id null, race bucket "unknown" (no fake join).
{
  const r = O.createRecorder({ clock: clockOf([0, 1, 2]) });
  r.utterance('u2', 'generated', {}); r.utterance('u2', 'queued', {}); r.utterance('u2', 'dropped_before_audible', { reason: 'stale_precondition' });
  const s = r.snapshot();
  ok('missing ids stay null', Object.values(s.events[0].ids).every(v => v === null) && s.by_race[0].race === 'unknown', s.events[0].ids);
  ok('pre-start drop is not a completion', !s.terminal_outcomes.completed && s.terminal_outcomes.dropped_before_audible === 1
    && s.terminal_reasons['dropped_before_audible:stale_precondition'] === 1, s.terminal_outcomes);
}
// 3. Clock anomalies -> unknown, never 0.
{
  const r = O.createRecorder({ clock: clockOf([100, 50, NaN, Infinity]) });
  for (const st of ['queued', 'tts_start', 'play_started', 'completed']) r.utterance('u3', st, {});
  const s = r.snapshot();
  const waits = s.events.filter(e => e.wait_ms !== null);
  ok('backwards/NaN/Infinity clock -> unknown_clock, null waits', waits.length === 0 && s.counters.unknown_clock >= 3
    && s.queue.wait_ms.queued_to_tts_start.n === 0 && s.queue.wait_ms.queued_to_tts_start.p50 === null, { waits, c: s.counters });
}
// 4. generated/queued without terminal stays open; never reported as completed.
{
  const r = O.createRecorder({ clock: clockOf([0, 1]) });
  r.utterance('u4', 'generated', {}); r.utterance('u4', 'queued', {});
  const s = r.snapshot();
  ok('open_without_terminal, no outcome', s.counters.open_without_terminal === 1 && Object.keys(s.terminal_outcomes).length === 0
    && s.open_utterances[0].last_state === 'queued', s);
}
// 5. Duplicate terminal / states after terminal are counted, not re-counted.
{
  const r = O.createRecorder({ clock: clockOf([0, 1, 2, 3, 4, 5]) });
  for (const st of ['queued', 'tts_start', 'play_started', 'completed', 'completed', 'audible_interrupted']) r.utterance('u5', st, {});
  const s = r.snapshot();
  ok('duplicate terminal counted once', s.terminal_outcomes.completed === 1 && !s.terminal_outcomes.audible_interrupted && s.counters.duplicate_terminal === 2, s.counters);
}
// 6. A completion without any play start is flagged (forged completion is visible).
{
  const r = O.createRecorder({ clock: clockOf([0, 1]) });
  r.utterance('u6', 'queued', {}); r.utterance('u6', 'completed', {});
  ok('completed_without_play flagged', r.snapshot().counters.completed_without_play === 1);
}
// 7. Bounds: events, open, races, reason keys, commands.
{
  const r = O.createRecorder({ clock: () => 1, limits: { events: 10, open: 3, races: 2, reasonKeys: 4, commands: 2, waitSamples: 5 } });
  for (let i = 0; i < 8; i++) r.utterance('o' + i, 'queued', { source: { scope: { race_instance_id: 'r' + i, session_num: 0 } } });
  for (let i = 0; i < 6; i++) { r.utterance('t' + i, 'queued', {}); r.utterance('t' + i, 'dropped_before_audible', { reason: 'reason_' + i }); }
  for (let i = 0; i < 4; i++) r.command('sent', { command_id: 'c' + i });
  const s = r.snapshot();
  ok('events bounded with eviction count', s.events.length === 10 && s.counters.events_evicted === s.counters.events_observed - 10, s.counters);
  ok('open bounded with eviction count', s.open_utterances.length <= 3 && s.counters.open_evicted >= 5, s.counters);
  ok('races bounded', s.by_race.length <= 2 && s.counters.races_evicted > 0, s.by_race);
  ok('reason keys bounded into other', Object.keys(s.terminal_reasons).length <= 5 && s.terminal_reasons.other > 0, s.terminal_reasons);
  ok('commands bounded', s.commands.length === 2 && s.counters.commands_evicted === 2, s.counters);
}
// 8. Commands: send->ack latency, duplicate ACK, unmatched ACK, readback utterance.
{
  const r = O.createRecorder({ clock: clockOf([0, 250, 300, 400]) });
  r.command('sent', { command_id: 'cmd-1', intent: 'early_pit', utterance_id: 'u9', decision_id: 'd1', revision: 0, race_instance_id: 'sub:1', session_num: 0 });
  r.command('ack', { command_id: 'cmd-1', intent: 'early_pit', outcome: 'applied', result_revision: 1 });
  r.command('ack', { command_id: 'cmd-1', intent: 'early_pit', outcome: 'retry_no_op' });
  r.command('ack_unmatched', { command_id: 'cmd-zzz' });
  r.command('readback', { command_id: 'cmd-1', utterance_id: 'u10' });
  const s = r.snapshot(), c = s.commands[0];
  ok('command chain', c.send_to_ack_ms === 250 && c.ack_outcome === 'applied' && c.ack_count === 2 && c.readback === true
    && c.response_utterance_ids[0] === 'u10' && c.driver_utterance_id === 'u9' && s.counters.ack_duplicate === 1 && s.counters.ack_unmatched === 1, { c, k: s.counters });
}
// 9. Scope: same-epoch repeat is no boundary; reconnect epoch and race change are distinct.
{
  const r = O.createRecorder({ clock: () => 0 });
  r.observeScope({ race_instance_id: 'sub:1', session_num: 0, bridge_process_epoch: 'e1' });
  r.observeScope({ race_instance_id: 'sub:1', session_num: 0, bridge_process_epoch: 'e1' });
  const a = r.snapshot().counters;
  r.observeScope({ race_instance_id: 'sub:1', session_num: 0, bridge_process_epoch: 'e2' });
  r.observeScope({ race_instance_id: 'sub:2', session_num: 0, bridge_process_epoch: 'e2' });
  const b = r.snapshot().counters;
  ok('scope boundaries', a.scope_boundaries === 0 && b.reconnect_boundaries === 1 && b.race_boundaries === 1 && b.scope_boundaries === 2, { a, b });
}
// 10. Allowlist: text / credentials / unknown keys cannot pass the main-side sanitizer.
{
  const r = O.createRecorder({ clock: clockOf([0, 1, 2]) });
  r.utterance('u11', 'queued', { kind: 'reply', reason: 'has spaces so dropped', source: { scope: { race_instance_id: 'Bearer abc.def' } } });
  const snap = r.snapshot();
  snap.events.push({ k: 'utterance', uid: 'u12', state: 'queued', text: 'ボックス、ボックス', prompt: 'system prompt', token: 'Bearer xyz' });
  snap.counters.secret = 'PITWALL-ABCDEF-123';
  snap.commands.push({ command_id: 'c1', text: 'ピット入るぞ', ids: { race_instance_id: 'sub:1', password: 'x' } });
  const clean = O.sanitizeRendererSnapshot(snap);
  const blob = JSON.stringify(clean);
  ok('sanitizer drops text/credentials/unknown keys', !/ボックス|ピット入るぞ|system prompt|Bearer|PITWALL-ABCDEF|password|has spaces/.test(blob), blob.slice(0, 400));
  ok('unrecognized renderer snapshot -> available:false', O.sanitizeRendererSnapshot({ foo: 1 }).available === false && O.sanitizeRendererSnapshot(null).available === false);
}
// 11. Bridge [TRACE] extraction from the main.js session log shape.
{
  const good = JSON.stringify({ schema: 'pitwall.bridge_trace.v1', seq: 1, k: 'dispatch', type: 'driver_plan_command_ack', command_id: 'c1', outcome: 'applied', message: 'Box this lap' });
  const log = ['[10:00:00][main] [bridge] [10:00:00] [TRACE] ' + good,
    '[10:00:00][main] [bridge] [10:00:00] BOX AUTHORITY SNAPSHOT: {}',
    '[10:00:01] [TRACE] {not json',
    '[10:00:02] [TRACE] ' + JSON.stringify({ schema: 'other', k: 'x' }),
    '[10:00:03][main] [bridge] [10:00:03] line A\n[10:00:03] [TRACE] ' + good.replace('"seq":1', '"seq":2')].join('\n');
  const x = O.extractBridgeTrace(log, 1);
  ok('bridge trace parse/cap/unparsable', x.lines_seen === 4 && x.unparsable === 2 && x.kept === 1 && x.truncated === true
    && x.events[0].seq === 2 && !('message' in x.events[0]), x);
}
// 12. Support section: round trip, empty Bridge log still carries the renderer part.
{
  const r = O.createRecorder({ clock: clockOf([0, 5]) });
  r.utterance('u20', 'queued', {}); r.utterance('u20', 'suppressed', { reason: 'voice_off' });
  const sec = O.buildSupportSection({ renderer: r.snapshot(), bridgeLogText: '' });
  const parsed = O.parseSupportSection('header\n' + sec);
  ok('support section round trip without Bridge log', parsed && parsed.renderer.available === true && parsed.bridge.lines_seen === 0
    && parsed.renderer.terminal_outcomes.suppressed === 1, parsed);
}
// 13. CPU/memory proxy: 20k transitions stay bounded and fast (not a perf gate, recorded).
let proxy = null;
{
  let t = 0;
  const r = O.createRecorder({ clock: () => (t += 3) });
  const t0 = process.hrtime.bigint(), m0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < 5000; i++) for (const st of ['generated', 'queued', 'tts_start', 'play_started', 'completed']) r.utterance('p' + i, st, { source: SRC, kind: 'radio', queueDepth: i % 3 });
  const s = r.snapshot();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  proxy = { transitions: 25000, ms: Math.round(ms), heap_delta_kb: Math.round((process.memoryUsage().heapUsed - m0) / 1024),
    snapshot_bytes: JSON.stringify(s).length, events: s.events.length, open: s.open_utterances.length };
  ok('25k transitions bounded (events<=256, snapshot<=128KB)', s.events.length <= 256 && proxy.snapshot_bytes <= 128 * 1024 && s.counters.open_without_terminal === 0, proxy);
}

if (process.argv.includes('--artifact')) {
  const out = process.argv[process.argv.indexOf('--artifact') + 1];
  const r = O.createRecorder({ clock: clockOf([0, 2, 9, 11, 900, 901, 903]) });
  for (const st of ['generated', 'queued', 'tts_start', 'play_started', 'completed']) r.utterance('u1', st, { source: SRC, kind: 'strategy_plan_box_call' });
  r.utterance('u2', 'queued', {}); r.utterance('u2', 'dropped_before_audible', { reason: 'stale_precondition' });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ synthetic_fixture: true, note: 'deterministic recorder self-check; not product or field evidence',
    tests: { pass, fail }, proxy, section: JSON.parse(O.buildSupportSection({ renderer: r.snapshot(), bridgeLogText: '' }).split('\n')[2]) }, null, 1));
}
console.log(`WO020 observability unit: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
