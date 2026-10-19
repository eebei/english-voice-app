/* WO020 — bounded, allowlisted observability for the real speech queue and Driver plan commands.
 *
 * One pure module used by the renderer (window.PitwallObservabilityTrace, fed from the product's
 * own transition points: utteranceTrace / finalizeUtterance / driver_plan_command send/ACK /
 * canonical snapshot receipt) and by main.js (require, to re-sanitize what the renderer hands to
 * the Support log export and to pick the Bridge's `[TRACE]` lines out of the session log).
 *
 * Contract:
 *   - Observation only. Nothing here is read by priority, authority, delivery or LLM code.
 *   - Native identities only (race_instance_id, session_num, bridge_process_epoch, decision_id,
 *     revision, canonical snapshot ref, source_frame_sequence, driver_pit_sequence, pit_event_id,
 *     box attempt/proof, command_id, utterance_id). Missing values stay null; this module never
 *     mints an id to join two records.
 *   - Latency uses ONE monotonic renderer clock (performance.now). Wall clock and Bridge
 *     session time are never subtracted from each other. Non-finite/negative spans are counted
 *     as `unknown_clock` and reported as null, never as 0.
 *   - generated / queued / tts_start / play_started are not outcomes. Only completed,
 *     audible_interrupted, dropped_before_audible, suppressed(_by_user) are terminal; anything
 *     else at snapshot time is `open_without_terminal`.
 *   - Every structure is bounded (events, open utterances, wait samples, commands, races,
 *     reason keys). Evictions are counted, not hidden.
 *   - No text: utterance/Driver text, prompts and credentials have no field to land in. Strings
 *     are length-capped id/enum tokens; anything else is dropped by the allowlist.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PitwallObservabilityTrace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SCHEMA = 'pitwall.observability.v1';
  const LIMITS = Object.freeze({ events: 256, open: 64, waitSamples: 128, commands: 64, races: 4, reasonKeys: 32, bridgeEvents: 200 });
  const TERMINAL = new Set(['completed', 'audible_interrupted', 'dropped_before_audible', 'suppressed', 'suppressed_by_user']);
  const STATES = new Set(['generated', 'queued', 'tts_start', 'play_started', 'spoken', 'discarded', ...TERMINAL]);
  const ID_KEYS = ['race_instance_id', 'session_num', 'bridge_process_epoch', 'decision_id', 'revision',
    'canonical_snapshot_id', 'canonical_snapshot_sequence', 'source_frame_sequence', 'activation_frame', 'driver_pit_sequence',
    'pit_event_id', 'box_attempt_id', 'proof_id'];
  const INT_KEYS = new Set(['session_num', 'revision', 'canonical_snapshot_sequence', 'source_frame_sequence', 'activation_frame', 'driver_pit_sequence']);
  // id/enum token: no spaces, bounded. Free text cannot pass.
  const TOKEN = /^[A-Za-z0-9_.:|#\-]{1,192}$/;
  const tok = v => (typeof v === 'string' && TOKEN.test(v)) ? v : null;
  const int = v => (Number.isInteger(v) && Math.abs(v) < 1e12) ? v : null;
  const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

  function pickIds(src) {
    const out = {};
    for (const k of ID_KEYS) {
      const v = src ? src[k] : undefined;
      out[k] = INT_KEYS.has(k) ? int(v) : tok(v);
    }
    return out;
  }
  // Native identities carried by the product's own deriveUtteranceSource() result. Only values the
  // source actually holds are copied; a missing one stays null.
  function idsFromSource(source) {
    const s = source && typeof source === 'object' ? source : null;
    const ref = s && s.ref && typeof s.ref === 'object' ? s.ref : {};
    const pub = s && s.publication_ref && typeof s.publication_ref === 'object' ? s.publication_ref : {};
    const scope = s && s.scope && typeof s.scope === 'object' ? s.scope : {};
    return pickIds({
      race_instance_id: scope.race_instance_id ?? ref.race_instance_id,
      session_num: scope.session_num ?? ref.session_num,
      bridge_process_epoch: s && s.epoch,
      decision_id: (s && s.decision_id) ?? ref.decision_id,
      revision: (s && s.revision) ?? ref.revision,
      canonical_snapshot_id: pub.canonical_snapshot_id ?? ref.canonical_snapshot_id,
      canonical_snapshot_sequence: pub.canonical_snapshot_sequence ?? ref.canonical_snapshot_sequence,
      // Plan activation frame and source frame are different facts: never substitute one for the other.
      source_frame_sequence: ref.source_frame_sequence,
      activation_frame: ref.activation_frame,
      driver_pit_sequence: ref.driver_pit_sequence,
      pit_event_id: ref.pit_event_id,
      box_attempt_id: ref.attempt_id,
      proof_id: ref.proof_id,
    });
  }
  function raceKey(ids) {
    return ids && ids.race_instance_id ? ids.race_instance_id + '#' + (ids.session_num ?? '?') : 'unknown';
  }
  function stats(samples) {
    const v = samples.filter(x => typeof x === 'number' && Number.isFinite(x)).slice().sort((a, b) => a - b);
    if (!v.length) return { n: 0, min: null, p50: null, p95: null, max: null };
    const q = p => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))];
    return { n: v.length, min: v[0], p50: q(0.5), p95: q(0.95), max: v[v.length - 1] };
  }
  function boundedInc(map, key, limit) {
    const k = tok(key) || 'other';
    if (!map.has(k) && map.size >= limit) { map.set('other', (map.get('other') || 0) + 1); return; }
    map.set(k, (map.get(k) || 0) + 1);
  }

  function createRecorder(options = {}) {
    const clock = typeof options.clock === 'function' ? options.clock : () => NaN;
    const L = Object.assign({}, LIMITS, options.limits || {});
    let seq = 0;
    const events = [];
    const open = new Map();          // uid -> {t:{generated,queued,tts_start,play_started}, ids, kind, terminal}
    const closed = new Map();        // uid -> terminal (bounded, for duplicate-terminal detection)
    const waits = { generated_to_queued: [], queued_to_tts_start: [], queued_to_play_started: [], play_started_to_terminal: [] };
    const commands = new Map();      // command_id -> record
    const races = new Map();         // raceKey -> {terminal:{outcome:n}, utterances:n}
    const states = new Map(), terminals = new Map(), reasons = new Map(), commandOutcomes = new Map();
    const depth = [];
    const counters = { events_observed: 0, events_evicted: 0, open_evicted: 0, unknown_clock: 0,
      duplicate_terminal: 0, terminal_without_queue: 0, completed_without_play: 0, missing_uid: 0,
      unknown_state: 0, races_evicted: 0, commands_evicted: 0, ack_unmatched: 0, ack_ignored: 0,
      ack_duplicate: 0, command_retry_exhausted: 0, scope_boundaries: 0, reconnect_boundaries: 0, race_boundaries: 0 };
    let scope = null;

    const nowT = () => { const t = clock(); return (typeof t === 'number' && Number.isFinite(t)) ? t : null; };
    function span(a, b) {
      if (a == null || b == null) { counters.unknown_clock++; return null; }
      const d = b - a;
      if (!Number.isFinite(d) || d < 0) { counters.unknown_clock++; return null; }
      return Math.round(d);
    }
    function pushSample(arr, v) { if (v == null) return; arr.push(v); if (arr.length > L.waitSamples) arr.splice(0, arr.length - L.waitSamples); }
    function pushEvent(e) {
      counters.events_observed++;
      e.seq = ++seq;
      // Per-event timestamp on the one renderer monotonic clock (null when unusable). Callers
      // that already read the clock for this transition pass it, so one transition = one read.
      if (!('t_ms' in e)) { const t = nowT(); e.t_ms = t == null ? null : Math.round(t); }
      events.push(e);
      if (events.length > L.events) { counters.events_evicted += events.length - L.events; events.splice(0, events.length - L.events); }
    }
    function raceBucket(ids) {
      const k = raceKey(ids);
      if (!races.has(k)) {
        if (races.size >= L.races) { races.delete(races.keys().next().value); counters.races_evicted++; }
        races.set(k, { utterances: 0, terminal: {} });
      }
      return races.get(k);
    }

    function utterance(uid, state, extra = {}) {
      const st = String(state || '');
      const id = tok(uid);
      if (!id) { counters.missing_uid++; return; }
      if (!STATES.has(st)) { counters.unknown_state++; return; }
      boundedInc(states, st, 32);
      const t = nowT();
      let rec = open.get(id);
      if (closed.has(id)) {
        if (TERMINAL.has(st)) counters.duplicate_terminal++;
        pushEvent({ k: 'utterance', uid: id, state: st, duplicate_after_terminal: true, reason: tok(extra.reason), t_ms: t == null ? null : Math.round(t) });
        return;
      }
      const first = !rec;
      if (!rec) {
        rec = { t: {}, ids: idsFromSource(extra.source), kind: tok(extra.kind) };
        if (open.size >= L.open) { open.delete(open.keys().next().value); counters.open_evicted++; }
        open.set(id, rec);
        raceBucket(rec.ids).utterances++;
      } else if (!rec.kind) rec.kind = tok(extra.kind);
      // Presence (`st in rec.t`) and timestamp are separate facts: a state that arrived while the
      // clock was unusable is still "seen" (its span becomes unknown_clock, never 0 or "absent").
      if (!(st in rec.t)) rec.t[st] = t;
      const seen = k => k in rec.t;
      const from = k => (seen(k) ? span(rec.t[k], t) : null);
      // ids ride on the utterance's first event and on its terminal event (the output -> source
      // anchor); intermediate states join by uid. Keeps the bounded ring small with long native ids.
      const ev = { k: 'utterance', uid: id, state: st, kind: rec.kind, reason: tok(extra.reason), wait_ms: null, queue_depth_ahead: null,
        t_ms: t == null ? null : Math.round(t) };
      if (first || TERMINAL.has(st)) ev.ids = rec.ids;
      if (st === 'queued') {
        const d = int(extra.queueDepth);
        ev.queue_depth_ahead = d;
        if (d != null) { depth.push(d); if (depth.length > L.waitSamples) depth.shift(); }
        pushSample(waits.generated_to_queued, from('generated'));
      } else if (st === 'tts_start') {
        ev.wait_ms = from('queued');
        pushSample(waits.queued_to_tts_start, ev.wait_ms);
      } else if (st === 'play_started') {
        ev.wait_ms = from('queued');
        pushSample(waits.queued_to_play_started, ev.wait_ms);
      } else if (TERMINAL.has(st)) {
        if (!seen('queued')) counters.terminal_without_queue++;
        const played = seen('play_started') || seen('spoken');
        if (st === 'completed' && !played) counters.completed_without_play++;
        if (played) {
          ev.wait_ms = from(seen('play_started') ? 'play_started' : 'spoken');
          pushSample(waits.play_started_to_terminal, ev.wait_ms);
        }
        boundedInc(terminals, st, 16);
        boundedInc(reasons, st + ':' + (tok(extra.reason) || 'none'), L.reasonKeys);
        const b = raceBucket(rec.ids); b.terminal[st] = (b.terminal[st] || 0) + 1;
        open.delete(id);
        closed.set(id, st);
        if (closed.size > L.open * 4) closed.delete(closed.keys().next().value);
      }
      pushEvent(ev);
    }

    const CMD_KEYS = ['command_id', 'reason_event_id', 'intent', 'outcome', 'race_instance_id', 'bridge_process_epoch',
      'decision_id', 'successor_decision_id', 'canonical_snapshot_id', 'lifecycle_phase', 'reason', 'utterance_id', 'role'];
    const CMD_INT = ['session_num', 'revision', 'result_revision', 'successor_revision', 'canonical_snapshot_sequence', 'source_frame_sequence', 'driver_pit_sequence', 'attempts'];
    function cmdFields(f) {
      const o = {};
      for (const k of CMD_KEYS) o[k] = tok(f && f[k]);
      for (const k of CMD_INT) o[k] = int(f && f[k]);
      return o;
    }
    // phase: sent | ack | ack_ignored | ack_unmatched | readback | retry_exhausted | utterance
    function command(phase, fields = {}) {
      const p = tok(phase) || 'unknown';
      const f = cmdFields(fields);
      const t = nowT();
      const id = f.command_id;
      let rec = id ? commands.get(id) : null;
      if (p === 'sent') {
        if (!id) return;
        if (!rec) {
          if (commands.size >= L.commands) { commands.delete(commands.keys().next().value); counters.commands_evicted++; }
          rec = { command_id: id, intent: f.intent, ids: pickIds(f), driver_utterance_id: f.utterance_id, t_sent: t,
            ack_outcome: null, reason_outcome: null, ack_count: 0, send_to_ack_ms: null, readback: false, response_utterance_ids: [], reason_event_id: f.reason_event_id };
          commands.set(id, rec);
        }
      } else if (p === 'ack_unmatched') counters.ack_unmatched++;
      else if (p === 'ack_ignored') counters.ack_ignored++;
      else if (p === 'retry_exhausted') counters.command_retry_exhausted++;
      else if (p === 'ack' && rec) {
        rec.ack_count++;
        if (rec.ack_count > 1) counters.ack_duplicate++;
        else { rec.ack_outcome = f.outcome; rec.result_revision = f.result_revision; rec.send_to_ack_ms = span(rec.t_sent, t); }
        boundedInc(commandOutcomes, (f.intent || 'unknown') + ':' + (f.outcome || 'none'), L.reasonKeys);
      } else if (p === 'readback' && rec) rec.readback = true;
      else if (p === 'reason_ack' && rec) rec.reason_outcome = f.outcome;
      if ((p === 'readback' || p === 'utterance') && rec && f.utterance_id && rec.response_utterance_ids.length < 4)
        rec.response_utterance_ids.push(f.utterance_id);
      pushEvent({ k: 'command', phase: p, ...f, t_ms: t == null ? null : Math.round(t) });
    }

    // Canonical snapshot receipt: race / session / Bridge-process-epoch boundaries.
    function observeScope(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return;
      const next = { race_instance_id: tok(snapshot.race_instance_id), session_num: int(snapshot.session_num), bridge_process_epoch: tok(snapshot.bridge_process_epoch) };
      if (!scope) { scope = next; return; }
      const raceChanged = next.race_instance_id !== scope.race_instance_id || next.session_num !== scope.session_num;
      const epochChanged = next.bridge_process_epoch !== scope.bridge_process_epoch;
      if (!raceChanged && !epochChanged) return;
      counters.scope_boundaries++;
      if (raceChanged) counters.race_boundaries++;
      if (epochChanged) counters.reconnect_boundaries++;
      pushEvent({ k: 'scope', from: scope, to: next, race_changed: raceChanged, epoch_changed: epochChanged });
      scope = next;
    }

    function snapshot() {
      const mapObj = m => Object.fromEntries(m);
      return {
        schema: SCHEMA, available: true, clock: 'renderer_monotonic_ms',
        limits: L,
        counters: Object.assign({}, counters, { open_without_terminal: open.size, commands_tracked: commands.size }),
        observed_states: mapObj(states),
        terminal_outcomes: mapObj(terminals),
        terminal_reasons: mapObj(reasons),
        queue: { depth_ahead: stats(depth), wait_ms: Object.fromEntries(Object.entries(waits).map(([k, v]) => [k, stats(v)])) },
        open_utterances: [...open.entries()].map(([uid, r]) => ({ uid, kind: r.kind, last_state: Object.keys(r.t).pop() || null, ids: r.ids })),
        by_race: [...races.entries()].map(([k, v]) => ({ race: k, utterances: v.utterances, terminal: Object.assign({}, v.terminal) })),
        commands: [...commands.values()].map(r => ({ command_id: r.command_id, intent: r.intent, ids: r.ids, driver_utterance_id: r.driver_utterance_id,
          reason_event_id: r.reason_event_id, ack_outcome: r.ack_outcome, reason_outcome: r.reason_outcome, ack_count: r.ack_count, result_revision: r.result_revision ?? null,
          send_to_ack_ms: r.send_to_ack_ms, readback: r.readback, response_utterance_ids: r.response_utterance_ids.slice() })),
        command_outcomes: mapObj(commandOutcomes),
        scope,
        events: events.map(e => JSON.parse(JSON.stringify(e))),
      };
    }
    return { utterance, command, observeScope, snapshot, limits: L };
  }

  // ── main-process side: re-sanitize the renderer snapshot (never trust shape) ─────────────
  function cleanIds(o) { return o && typeof o === 'object' ? pickIds(o) : pickIds({}); }
  function cleanCounts(o, maxKeys = 64) {
    const out = {};
    if (!o || typeof o !== 'object') return out;
    for (const [k, v] of Object.entries(o).slice(0, maxKeys)) if (tok(k) && int(v) != null) out[k] = int(v);
    return out;
  }
  function cleanStats(s) {
    const o = {}; for (const k of ['n', 'min', 'p50', 'p95', 'max']) o[k] = num(s && s[k]); return o;
  }
  function sanitizeRendererSnapshot(s) {
    if (!s || typeof s !== 'object' || s.schema !== SCHEMA) return { schema: SCHEMA, available: false, reason: 'renderer_snapshot_missing_or_unrecognized' };
    const arr = (a, n) => (Array.isArray(a) ? a.slice(-n) : []);
    const evt = e => {
      if (!e || typeof e !== 'object') return null;
      const o = { seq: int(e.seq), k: tok(e.k) };
      for (const key of ['uid', 'state', 'kind', 'reason', 'phase', 'command_id', 'reason_event_id', 'intent', 'outcome', 'utterance_id',
        'decision_id', 'successor_decision_id', 'race_instance_id', 'bridge_process_epoch', 'canonical_snapshot_id', 'lifecycle_phase', 'role']) if (e[key] != null) o[key] = tok(e[key]);
      for (const key of ['wait_ms', 'queue_depth_ahead', 'session_num', 'revision', 'result_revision', 'successor_revision',
        'canonical_snapshot_sequence', 'source_frame_sequence', 'driver_pit_sequence', 'attempts']) if (e[key] != null) o[key] = int(e[key]);
      // own bound: a monotonic origin can be large; non-integer/negative/absent -> null
      o.t_ms = (Number.isInteger(e.t_ms) && e.t_ms >= 0 && e.t_ms < 1e15) ? e.t_ms : null;
      if (e.ids) o.ids = cleanIds(e.ids);
      if (e.duplicate_after_terminal === true) o.duplicate_after_terminal = true;
      if (e.k === 'scope') { o.from = cleanIds(e.from); o.to = cleanIds(e.to); o.race_changed = e.race_changed === true; o.epoch_changed = e.epoch_changed === true; }
      return o;
    };
    return {
      schema: SCHEMA, available: s.available === true, clock: 'renderer_monotonic_ms',
      counters: cleanCounts(s.counters), observed_states: cleanCounts(s.observed_states),
      terminal_outcomes: cleanCounts(s.terminal_outcomes), terminal_reasons: cleanCounts(s.terminal_reasons),
      command_outcomes: cleanCounts(s.command_outcomes),
      queue: { depth_ahead: cleanStats(s.queue && s.queue.depth_ahead),
        wait_ms: Object.fromEntries(['generated_to_queued', 'queued_to_tts_start', 'queued_to_play_started', 'play_started_to_terminal']
          .map(k => [k, cleanStats(s.queue && s.queue.wait_ms && s.queue.wait_ms[k])])) },
      open_utterances: arr(s.open_utterances, LIMITS.open).map(u => ({ uid: tok(u && u.uid), kind: tok(u && u.kind), last_state: tok(u && u.last_state), ids: cleanIds(u && u.ids) })),
      by_race: arr(s.by_race, LIMITS.races).map(r => ({ race: tok(r && r.race), utterances: int(r && r.utterances), terminal: cleanCounts(r && r.terminal) })),
      commands: arr(s.commands, LIMITS.commands).map(c => ({ command_id: tok(c && c.command_id), intent: tok(c && c.intent), ids: cleanIds(c && c.ids),
        driver_utterance_id: tok(c && c.driver_utterance_id), reason_event_id: tok(c && c.reason_event_id), ack_outcome: tok(c && c.ack_outcome), reason_outcome: tok(c && c.reason_outcome),
        ack_count: int(c && c.ack_count), result_revision: int(c && c.result_revision), send_to_ack_ms: int(c && c.send_to_ack_ms),
        readback: !!(c && c.readback === true), response_utterance_ids: arr(c && c.response_utterance_ids, 4).map(tok) })),
      scope: s.scope ? cleanIds(s.scope) : null,
      events: arr(s.events, LIMITS.events).map(evt).filter(Boolean),
    };
  }

  // Bridge `[TRACE] {json}` lines (irsdk-bridge/observability_trace.py) inside the session log.
  const BRIDGE_KEYS_TOK = ['k', 'type', 'trigger', 'result', 'race_instance_id', 'bridge_process_epoch', 'snapshot_id', 'decision_id',
    'phase', 'pit_event_id', 'command_id', 'intent', 'outcome', 'lifecycle_phase', 'successor_decision_id', 'box_attempt_id',
    'proof_id', 'gate_reason', 'reason_event_id', 'utterance_id', 'cmd', 'slot', 'selected_plan', 'invalidated_reason',
    'execution_relation', 'terminal_pit_event_id', 'terminal_event_pit_event_id', 'classification_reason', 'penalty_state',
    'plan_decision_id', 'plan_selected', 'publication_snapshot_id', 'event_canonical_snapshot_id'];
  const BRIDGE_KEYS_INT = ['seq', 'session_num', 'snapshot_sequence', 'source_frame_sequence', 'revision', 'driver_pit_sequence',
    'result_revision', 'successor_revision', 'expected_revision', 'recorded_event_count', 'terminal_event_driver_pit_sequence',
    'expected_pit_sequence', 'resolved_pit_sequence', 'activation_frame', 'target_lap', 'penalty_source_frame_sequence',
    'publication_snapshot_sequence', 'event_canonical_snapshot_sequence'];
  function sanitizeBridgeEvent(e) {
    if (!e || typeof e !== 'object' || e.schema !== 'pitwall.bridge_trace.v1') return null;
    const o = {};
    for (const k of BRIDGE_KEYS_TOK) if (e[k] != null) o[k] = tok(e[k]);
    for (const k of BRIDGE_KEYS_INT) if (e[k] != null) o[k] = int(e[k]);
    if (typeof e.session_time_s === 'number' && Number.isFinite(e.session_time_s)) o.session_time_s = e.session_time_s;
    if (Array.isArray(e.changed)) o.changed = e.changed.slice(0, 16).map(tok).filter(Boolean);
    return o;
  }
  function extractBridgeTrace(logText, max = LIMITS.bridgeEvents) {
    const out = [];
    let unparsable = 0, seen = 0;
    for (const line of String(logText || '').split(/\r?\n/)) {
      const i = line.indexOf('[TRACE] ');
      if (i < 0) continue;
      seen++;
      let e = null;
      try { e = sanitizeBridgeEvent(JSON.parse(line.slice(i + 8).trim())); } catch (_) { e = null; }
      if (!e) { unparsable++; continue; }
      out.push(e);
      if (out.length > max) out.shift();
    }
    return { schema: 'pitwall.bridge_trace.v1', clock: 'bridge_session_time_s (observation only; never subtracted from renderer time)', lines_seen: seen, unparsable, kept: out.length, truncated: seen - unparsable > out.length, events: out };
  }
  // The allowlisted section appended to the existing Support log package.
  function buildSupportSection({ renderer, bridgeLogText }) {
    const section = { schema: 'pitwall.support_observability.v1', renderer: sanitizeRendererSnapshot(renderer), bridge: extractBridgeTrace(bridgeLogText) };
    return '\n=== PITWALL OBSERVABILITY (allowlisted, bounded; no conversation text) ===\n' + JSON.stringify(section) + '\n=== END PITWALL OBSERVABILITY ===\n';
  }
  function parseSupportSection(text) {
    const m = String(text || '').match(/=== PITWALL OBSERVABILITY[^\n]*===\n(.*)\n=== END PITWALL OBSERVABILITY ===/);
    return m ? JSON.parse(m[1]) : null;
  }

  return { SCHEMA, LIMITS, TERMINAL: [...TERMINAL], createRecorder, idsFromSource, sanitizeRendererSnapshot, sanitizeBridgeEvent,
    extractBridgeTrace, buildSupportSection, parseSupportSection };
});
