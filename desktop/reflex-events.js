(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallReflexEvents = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ★2026-08-30 Build 291 修正2 — 反射イベントの統一モデル。
  //
  // Road Atlanta 実走で起きたこと：
  //   ・LLM が「左に車。」を自分で書き、reply_chunk(P2) として再生された。
  //     `CarLeftRight` 由来の side_by_side(P0) は同時刻に存在しない＝**捏造**。
  //     ドライバーは実在しない車を2度否定するためにPTTを押した。
  //   ・接近コールは同じ2値(5.7秒/2.9秒)を毎周繰り返し、相手も期限も持たない。
  //
  // ここが反射系（左右車・停止車両・黄旗・危険車両・重大インシデント・
  // 緊急燃料）の唯一の入口で、全イベントが同じ形を持つ：
  //
  //   event_id / source / source_timestamp / session_time / valid_until
  //
  // 規律：
  //   - 反射発話は決定論のみ。LLM に生成させない（文言はここが持つ）。
  //   - 発話直前に「最新イベントか」「期限内か」を再検証する。
  //   - ドライバーの訂正は**そのイベントだけ**を無効化する。同種の新しい
  //     実測イベントは再発話できる（種別ごと永久ミュートにしない）。
  //   - 到着順が分かる時だけ順序を語る。分からない時は保守的な一文にする。

  const SCHEMA = 'reflex_event_v1';

  // 反射イベントの閉じた集合。ここに無い kind は反射として扱わない。
  const KIND = Object.freeze({
    SIDE_BY_SIDE: 'side_by_side',
    STOPPED_AHEAD: 'stopped_ahead',
    YELLOW_FLAG: 'yellow_flag',
    DANGEROUS_CAR: 'dangerous_car',
    MAJOR_INCIDENT: 'major_incident',
    FUEL_EMERGENCY: 'fuel_emergency'
  });
  const KINDS = Object.freeze(Object.keys(KIND).map(k => KIND[k]));

  // 反射の寿命。ここを過ぎた事象は「今の事実」ではないので喋らない。
  // 並走は数秒で終わる／黄旗は区間が続く、という現実の持続時間に合わせる。
  const DEFAULT_TTL_MS = Object.freeze({
    side_by_side: 3000,
    stopped_ahead: 8000,
    yellow_flag: 20000,
    dangerous_car: 8000,
    major_incident: 10000,
    fuel_emergency: 15000
  });

  // 黄旗と停止車両を「ほぼ同時」とみなす窓。これ以内なら一文へ統合する。
  const SIMULTANEOUS_MS = 1500;

  const finite = value => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const intOrNull = value => {
    const n = finite(value);
    return n === null ? null : Math.trunc(n);
  };
  const isJa = lang => String(lang || '').toLowerCase().startsWith('ja');
  const text = value => String(value === null || value === undefined ? '' : value).trim();

  let counter = 0;
  function nextId(kind, at) {
    counter = (counter + 1) % 100000;
    return kind + ':' + Math.trunc(at) + ':' + counter;
  }

  /**
   * Bridge の radio イベントを反射イベントへ正規化する。
   * 反射でないものは null を返す（呼び出し側は従来経路へ流す）。
   */
  function build(input) {
    const i = input && typeof input === 'object' ? input : {};
    const kind = KINDS.indexOf(i.kind) >= 0 ? i.kind : null;
    if (!kind) return null;
    const now = finite(i.now) || Date.now();
    // source_timestamp は「事象が観測された時刻」。取れなければ受信時刻で代用し、
    // 代用したことを source_timestamp_estimated として残す（推測を隠さない）。
    const observed = finite(i.source_timestamp);
    const ttl = finite(i.ttlMs) || DEFAULT_TTL_MS[kind] || 5000;
    const payload = (i.payload && typeof i.payload === 'object') ? i.payload : {};
    return {
      schema: SCHEMA,
      event_id: text(i.event_id) || nextId(kind, now),
      kind,
      // 反射は必ず計測系から来る。LLM を source にできない。
      source: text(i.source) || 'bridge_telemetry',
      source_timestamp: observed === null ? now : observed,
      source_timestamp_estimated: observed === null,
      session_time: finite(i.session_time),
      received_at: now,
      valid_until: (observed === null ? now : observed) + ttl,
      payload
    };
  }

  function isExpired(event, now) {
    const at = finite(now) || Date.now();
    return !event || !(finite(event.valid_until) !== null && at <= event.valid_until);
  }

  /**
   * 発話直前の再検証。
   *   - 期限切れなら喋らない
   *   - 同じ種別のより新しいイベントが来ていれば、古い方は喋らない
   *   - 訂正で保留中のイベントは喋らない（同種の新しいものは通る）
   */
  function validateForSpeech(input) {
    const event = input && input.event;
    const now = finite(input && input.now) || Date.now();
    const latest = (input && input.latestByKind && typeof input.latestByKind === 'object')
      ? input.latestByKind : {};
    const holds = normalizeHolds(input && input.holds);
    if (!event || event.schema !== SCHEMA) return { speak: false, reason: 'not_a_reflex_event' };
    if (event.source === 'llm') return { speak: false, reason: 'llm_generated_reflex_forbidden' };
    if (isExpired(event, now)) return { speak: false, reason: 'expired' };
    const newest = latest[event.kind];
    if (newest && newest.event_id !== event.event_id
        && finite(newest.source_timestamp) > finite(event.source_timestamp)) {
      return { speak: false, reason: 'superseded_by_newer_event' };
    }
    if (isHeld(holds, event)) return { speak: false, reason: 'driver_disputed_event' };
    return { speak: true, reason: null };
  }

  // ── ドライバー訂正の台帳 ────────────────────────────────────────────
  // 「そのイベントだけ」を止める。種別ごと止めると、次に本当に来た車を
  // 警告できなくなる（安全機能を訂正で殺してはいけない）。
  function emptyHolds() { return { schema: 'reflex_hold_v1', events: {} }; }

  function normalizeHolds(holds) {
    if (!holds || typeof holds !== 'object' || holds.schema !== 'reflex_hold_v1') return emptyHolds();
    return { schema: 'reflex_hold_v1', events: (holds.events && typeof holds.events === 'object') ? holds.events : {} };
  }

  function disputeEvent(holds, event, now) {
    const state = normalizeHolds(holds);
    if (!event || event.schema !== SCHEMA) return { holds: state, held: false };
    state.events[event.event_id] = {
      kind: event.kind,
      source_timestamp: event.source_timestamp,
      at: finite(now) === null ? Date.now() : now,
      reason: 'driver_disputed'
    };
    return { holds: state, held: true };
  }

  function isHeld(holds, event) {
    const state = normalizeHolds(holds);
    if (!event) return false;
    return !!state.events[event.event_id];
  }

  // ── 黄旗と停止車両の到着順 ─────────────────────────────────────────
  /**
   * 同一ポーリングで記録された黄旗・停止車両を、到着順で1〜2件の発話へ変える。
   * 順序が確定できない時は順序を推測せず、保守的な一文にまとめる。
   */
  function orderHazards(input) {
    const yellow = (input && input.yellow) || null;
    const stopped = (input && input.stopped) || null;
    const lang = isJa(input && input.lang) ? 'ja' : 'en';
    if (!yellow && !stopped) return { order: 'none', lines: [], merged: false };
    if (yellow && !stopped) return { order: 'yellow_only', lines: [describe(yellow, lang)], merged: false };
    if (!yellow && stopped) return { order: 'stopped_only', lines: [describe(stopped, lang)], merged: false };

    const yellowAt = finite(yellow.payload && yellow.payload.flag_timestamp);
    const stoppedAt = finite(stopped.payload && stopped.payload.stopped_timestamp);
    // どちらかの観測時刻が無い＝到着順は不明。推測しない。
    if (yellowAt === null || stoppedAt === null) {
      return { order: 'unknown', merged: true, lines: [lang === 'ja'
        ? 'イエロー。前方に停止車両の可能性。ペース落として。'
        : 'Yellow. Possible stopped car ahead. Slow down.'] };
    }
    const delta = Math.abs(yellowAt - stoppedAt);
    if (delta <= SIMULTANEOUS_MS) {
      const side = hazardSide(stopped, lang);
      return { order: 'simultaneous', merged: true, lines: [lang === 'ja'
        ? `イエローフラッグ。前方に停止車両${side ? '、' + side : ''}。`
        : `Yellow flag. Stopped car ahead${side ? ', ' + side : ''}.`] };
    }
    const first = yellowAt < stoppedAt ? yellow : stopped;
    const second = yellowAt < stoppedAt ? stopped : yellow;
    return {
      order: yellowAt < stoppedAt ? 'yellow_first' : 'stopped_first',
      merged: false,
      lines: [describe(first, lang), describe(second, lang)]
    };
  }

  function hazardSide(event, lang) {
    const side = text(event && event.payload && event.payload.track_side).toLowerCase();
    if (!side) return '';   // 取れない時は側を作らない
    if (side === 'left') return isJa(lang) ? 'コース左側' : 'on the left';
    if (side === 'right') return isJa(lang) ? 'コース右側' : 'on the right';
    return '';
  }

  // ── 決定論の文言（LLM には絶対に書かせない）────────────────────────
  function describe(event, lang) {
    const ja = isJa(lang);
    if (!event || event.schema !== SCHEMA) return '';
    const p = event.payload || {};
    switch (event.kind) {
      case KIND.SIDE_BY_SIDE: {
        const side = text(p.side);
        if (side === 'both') return ja ? '両側に車。' : 'Cars both sides.';
        if (side === 'left') return ja ? '左に車。' : 'Car left.';
        if (side === 'right') return ja ? '右に車。' : 'Car right.';
        return '';
      }
      case KIND.STOPPED_AHEAD: {
        const side = hazardSide(event, lang);
        const distance = finite(p.distance);
        const where = side ? (ja ? '、' + side : ', ' + side) : '';
        return ja
          ? `前方に停止車両${where}${distance !== null ? `、${distance.toFixed(1)}秒` : ''}。`
          : `Stopped car ahead${where}${distance !== null ? `, ${distance.toFixed(1)} seconds` : ''}.`;
      }
      case KIND.YELLOW_FLAG:
        return ja ? 'イエローフラッグ。' : 'Yellow flag.';
      case KIND.DANGEROUS_CAR: {
        const number = text(p.car_number);
        return ja
          ? `危険な車${number ? `、${number}番` : ''}。距離取って。`
          : `Dangerous car${number ? ` number ${number}` : ''}. Keep your distance.`;
      }
      case KIND.MAJOR_INCIDENT:
        return ja ? '前方でクラッシュ。ペース落として。' : 'Crash ahead. Slow down.';
      case KIND.FUEL_EMERGENCY: {
        const laps = finite(p.range_laps);
        return ja
          ? `燃料が足りない${laps !== null ? `。残り約${laps.toFixed(1)}周` : ''}。`
          : `Fuel is short${laps !== null ? `; about ${laps.toFixed(1)} laps left` : ''}.`;
      }
      default:
        return '';
    }
  }

  // ── LLM 出力から反射コールを剥がす ─────────────────────────────────
  // 反射の発生源を1つにするには、LLM 側の出力からも安全コール語彙を
  // 落とす必要がある。返答全体は殺さず、その文だけ取り除く。
  const SPOTTER_SENTENCE_RE = new RegExp([
    '(?:左|右|両)側?に車',
    '(?:左|右)から(?:来て|きて)',
    '(?:イン|アウト)側に車',
    '[左右]側[、,]?\\s*注意',
    '後ろから(?:来て|きて|迫)',
    '前方に停止',
    '停止車両',
    'イエロー(?:フラッグ)?',
    '黄旗',
    'クラッシュ(?:あり|してる|してる)?',
    '\\bcars? (?:left|right|both sides)\\b',
    '\\bstopped car\\b',
    '\\byellow(?: flag)?\\b',
    '\\bcrash ahead\\b'
  ].join('|'), 'i');

  function containsReflexClaim(reply) {
    return SPOTTER_SENTENCE_RE.test(text(reply));
  }

  /** 反射コールの文だけを落とす。残りは返す。 */
  function stripReflexClaims(reply) {
    const src = text(reply);
    if (!src) return { text: '', removed: [] };
    const parts = src.split(/(?<=[。．！？!?])/);
    const kept = [], removed = [];
    parts.forEach(part => {
      if (part.trim() && SPOTTER_SENTENCE_RE.test(part)) removed.push(part.trim());
      else kept.push(part);
    });
    return { text: kept.join('').trim(), removed };
  }

  return {
    SCHEMA, KIND, KINDS, DEFAULT_TTL_MS, SIMULTANEOUS_MS,
    build, isExpired, validateForSpeech,
    emptyHolds, normalizeHolds, disputeEvent, isHeld,
    orderHazards, describe,
    containsReflexClaim, stripReflexClaims
  };
}));
