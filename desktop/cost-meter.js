// Build 266 — 原価ゲート計装（Codex差戻し#7 / 内部シミュレーション正本 §Cost gate）.
//
// 正本の要求：
//   「生成した」「キューへ入れた」「TTSを要求した」「再生を開始した」「完了した」
//   「破棄した」を **別イベント** として記録・検証する。
//   生成済みだが未再生・破棄された回答にも Anthropic 原価が発生する前提で、
//   不可視の無駄生成を失敗扱いにする。
//
// この module は会計だけを行う。発話するかどうかの判断も、APIを呼ぶかどうかの判断も
// ここではしない。呼び出し側（renderer）が各 seam で事実を報告し、ここが集計する。
//
// 「外部APIを呼んでいない」ことは、この module が external カウンタを持ち、
// テストがそれを 0 と突き合わせることで証明する。

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallCostMeter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 単価。実測が取れるまでの見積もり用で、原価の断定には使わない。
  // 変更時は必ず出典を添えること（推測値を既成事実にしない）。
  const RATES = {
    anthropic_input_per_mtok: 3.0,
    anthropic_output_per_mtok: 15.0,
    anthropic_cache_read_per_mtok: 0.3,
    anthropic_cache_write_per_mtok: 3.75,
    google_tts_per_million_chars: 16.0,
    google_stt_per_15s: 0.006,
  };

  // 生成〜破棄までの各段。正本が「別eventとして」記録せよと指定した粒度。
  const EVENTS = [
    'generated',   // LLM 応答を作った（この時点で原価が発生している）
    'queued',      // 発話キューへ入れた
    'tts_requested', // TTS を要求した
    'deferred',    // 上位割り込みで後送りにした
    'played',      // 再生を開始した
    'completed',   // 最後まで再生した
    'expired',     // 情報の有効期限切れで再生しなかった
    'discarded',   // キュー溢れ・重複・取消で捨てた
  ];

  function emptyCounts() {
    const counts = {};
    EVENTS.forEach(function (name) { counts[name] = 0; });
    return counts;
  }

  function createMeter(options) {
    const opts = options || {};
    const rates = Object.assign({}, RATES, opts.rates || {});
    const state = {
      counts: emptyCounts(),
      events: [],
      // 外部API実呼び出し数。通常テストでは 0 でなければならない。
      external: { anthropic: 0, google_stt: 0, google_tts: 0 },
      // stub / fixture 経由の模擬呼び出し数。
      simulated: { anthropic: 0, google_stt: 0, google_tts: 0 },
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      google: { tts_chars: 0, stt_seconds: 0 },
      // 生成した回答ごとの帰結。未再生のまま終わったものが無駄生成。
      replies: new Map(),
    };

    function record(event, detail) {
      if (EVENTS.indexOf(event) === -1) {
        throw new Error('unknown cost-meter event: ' + event);
      }
      const d = detail || {};
      state.counts[event] += 1;
      state.events.push({ event: event, id: d.id || null, kind: d.kind || null,
                          reason: d.reason || null, at: state.events.length });
      if (d.id) {
        const reply = state.replies.get(d.id) || { id: d.id, kind: d.kind || null,
                                                   generated: false, played: false,
                                                   fate: null, tokens: null };
        if (event === 'generated') {
          reply.generated = true;
          reply.tokens = d.tokens || null;
        }
        if (event === 'played') reply.played = true;
        if (event === 'completed' || event === 'expired' || event === 'discarded') {
          reply.fate = event;
        }
        if (d.kind && !reply.kind) reply.kind = d.kind;
        state.replies.set(d.id, reply);
      }
      return state.counts[event];
    }

    // ── API 呼び出しの記録 ────────────────────────────────────────
    // `simulated` は stub/fixture 経由。`external` は本物のネットワーク越え。
    // 通常テストで external が 1 でも立ったら、その Build 候補は失敗である。
    function recordApiCall(provider, opts2) {
      const o = opts2 || {};
      const bucket = o.external ? state.external : state.simulated;
      if (!(provider in bucket)) {
        throw new Error('unknown provider: ' + provider);
      }
      bucket[provider] += 1;
      if (provider === 'anthropic' && o.tokens) {
        state.tokens.input += o.tokens.input || 0;
        state.tokens.output += o.tokens.output || 0;
        state.tokens.cache_read += o.tokens.cache_read || 0;
        state.tokens.cache_write += o.tokens.cache_write || 0;
      }
      if (provider === 'google_tts') state.google.tts_chars += o.chars || 0;
      if (provider === 'google_stt') state.google.stt_seconds += o.seconds || 0;
      return bucket[provider];
    }

    function anthropicCost(tokens) {
      const t = tokens || state.tokens;
      return ((t.input || 0) * rates.anthropic_input_per_mtok
            + (t.output || 0) * rates.anthropic_output_per_mtok
            + (t.cache_read || 0) * rates.anthropic_cache_read_per_mtok
            + (t.cache_write || 0) * rates.anthropic_cache_write_per_mtok) / 1e6;
    }

    function googleCost() {
      return (state.google.tts_chars / 1e6) * rates.google_tts_per_million_chars
           + (state.google.stt_seconds / 15) * rates.google_stt_per_15s;
    }

    // 生成したのに一度も再生されなかった回答＝不可視の無駄生成。
    function wastedReplies() {
      const wasted = [];
      state.replies.forEach(function (reply) {
        if (reply.generated && !reply.played) wasted.push(reply);
      });
      return wasted;
    }

    function wastedCost() {
      return wastedReplies().reduce(function (total, reply) {
        return total + (reply.tokens ? anthropicCost(reply.tokens) : 0);
      }, 0);
    }

    function report() {
      const wasted = wastedReplies();
      return {
        external_anthropic_calls: state.external.anthropic,
        external_google_stt_calls: state.external.google_stt,
        external_google_tts_calls: state.external.google_tts,
        simulated_api_calls: state.simulated.anthropic
                           + state.simulated.google_stt
                           + state.simulated.google_tts,
        generated_replies: state.counts.generated,
        played_replies: state.counts.played,
        deferred_replies: state.counts.deferred,
        expired_or_discarded_replies: state.counts.expired + state.counts.discarded,
        estimated_anthropic_cost_usd: round6(anthropicCost()),
        estimated_google_cost_usd: round6(googleCost()),
        wasted_generation_count: wasted.length,
        wasted_generation_cost_usd: round6(wastedCost()),
        counts: Object.assign({}, state.counts),
      };
    }

    // 正本の合否。外部API 0 が絶対条件。無駄生成は失敗扱いにできる。
    function verdict(expectations) {
      const e = expectations || {};
      const r = report();
      const failures = [];
      if (r.external_anthropic_calls > 0) failures.push('external_anthropic_calls');
      if (r.external_google_stt_calls > 0) failures.push('external_google_stt_calls');
      if (r.external_google_tts_calls > 0) failures.push('external_google_tts_calls');
      if (e.maxWastedGenerations != null
          && r.wasted_generation_count > e.maxWastedGenerations) {
        failures.push('wasted_generation_count');
      }
      if (e.maxWastedCostUsd != null
          && r.wasted_generation_cost_usd > e.maxWastedCostUsd) {
        failures.push('wasted_generation_cost_usd');
      }
      return { pass: failures.length === 0, failures: failures, report: r };
    }

    function formatReport() {
      const r = report();
      return [
        'COST GATE',
        'external_anthropic_calls=' + r.external_anthropic_calls,
        'external_google_stt_calls=' + r.external_google_stt_calls,
        'external_google_tts_calls=' + r.external_google_tts_calls,
        'simulated_api_calls=' + r.simulated_api_calls,
        'generated_replies=' + r.generated_replies,
        'played_replies=' + r.played_replies,
        'deferred_replies=' + r.deferred_replies,
        'expired_or_discarded_replies=' + r.expired_or_discarded_replies,
        'estimated_anthropic_cost_usd=' + r.estimated_anthropic_cost_usd,
        'estimated_google_cost_usd=' + r.estimated_google_cost_usd,
        'wasted_generation_count=' + r.wasted_generation_count,
        'wasted_generation_cost_usd=' + r.wasted_generation_cost_usd,
      ].join('\n');
    }

    function reset() {
      state.counts = emptyCounts();
      state.events = [];
      state.external = { anthropic: 0, google_stt: 0, google_tts: 0 };
      state.simulated = { anthropic: 0, google_stt: 0, google_tts: 0 };
      state.tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
      state.google = { tts_chars: 0, stt_seconds: 0 };
      state.replies = new Map();
    }

    return {
      EVENTS: EVENTS.slice(),
      record: record,
      recordApiCall: recordApiCall,
      report: report,
      verdict: verdict,
      formatReport: formatReport,
      wastedReplies: wastedReplies,
      events: function () { return state.events.slice(); },
      reset: reset,
    };
  }

  function round6(value) {
    return Math.round(value * 1e6) / 1e6;
  }

  return { createMeter: createMeter, EVENTS: EVENTS.slice(), RATES: RATES };
}));
