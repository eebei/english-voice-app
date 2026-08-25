(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallGapFreshness = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ★G2（2026-08-25）queue に残った GAP 候補を、再生の直前に照合する。
  //
  // 実走欠陥（`OMORAY-bridge-debug-20260823-1403.log`）:
  //
  //   19:14:16  「前5.5秒。5.3秒開いた。」を Renderer queue へ登録
  //   19:14:18  DATA CHECK gapAhead:10.5
  //   19:14:24  DATA CHECK gapAhead:0.7   ← 5.5 は既に事実ではない
  //   19:14:31  queue 14,742ms 後に **古い「前5.5秒」を再生**
  //
  // Bridge 側の `_gap_candidate_is_fresh()` は Bridge の pending しか見ておらず、
  // Renderer へ渡した後の speech queue は誰も再検査していなかった。
  //
  // 契約：
  //   - 対象車・方向・セッション・世代が変わったら **破棄**（別の車の数字を読まない）
  //   - 値だけ変わったら **最新値で作り直す**（黙るより正しい数字を言う方がよい）
  //   - 古すぎる候補は **破棄**（14秒保持しない）
  //   - 現在値が取れないなら **破棄**（古い数字を喋るより黙る）

  // GAP は数秒で意味が変わる。closed constant にして境界をテストで固定する。
  const MAX_AGE_MS = 5000;

  const FATE_PLAY = 'play';           // そのまま再生してよい
  const FATE_REBUILD = 'rebuild';     // 同じ対象・方向のまま値だけ更新して再生
  const FATE_DISCARD = 'discard';     // 再生しない

  const REASON_NOT_GAP = 'not_a_gap_candidate';
  const REASON_NO_LIVE = 'no_live_authority';
  const REASON_SESSION = 'session_changed';
  const REASON_TARGET = 'target_car_changed';
  const REASON_DIRECTION = 'direction_changed';
  const REASON_GENERATION = 'generation_changed';
  const REASON_STALE = 'age_exceeded';
  const REASON_VALUE = 'value_changed';

  const finite = value => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  function liveRecordFor(identity, live) {
    const table = live && live.gap_authority;
    if (!table || !identity || !identity.direction) return null;
    const record = table[identity.direction];
    return (record && typeof record === 'object') ? record : null;
  }

  /**
   * 再生直前の判定。identity を持たない発話には触れない（GAP以外は素通り）。
   *
   * @returns {{fate:string, reason:string, gapS:(number|null)}}
   */
  function evaluate(identity, live, nowMs, options) {
    const maxAge = (options && finite(options.maxAgeMs) !== null) ? Number(options.maxAgeMs) : MAX_AGE_MS;
    if (!identity || typeof identity !== 'object' || !identity.direction) {
      return { fate: FATE_PLAY, reason: REASON_NOT_GAP, gapS: null };
    }

    const record = liveRecordFor(identity, live);
    if (!record) {
      // 現在の権威が無い＝比べる相手がいない。古い数字は喋らない。
      return { fate: FATE_DISCARD, reason: REASON_NO_LIVE, gapS: null };
    }
    if (identity.session_key !== undefined && record.session_key !== undefined
        && String(identity.session_key) !== String(record.session_key)) {
      return { fate: FATE_DISCARD, reason: REASON_SESSION, gapS: null };
    }
    if (record.direction && identity.direction !== record.direction) {
      return { fate: FATE_DISCARD, reason: REASON_DIRECTION, gapS: null };
    }
    if (identity.target_car_idx !== null && identity.target_car_idx !== undefined
        && record.target_car_idx !== null && record.target_car_idx !== undefined
        && identity.target_car_idx !== record.target_car_idx) {
      // 追越しで前後が入れ替わった。旧候補は別の車の話になっている。
      return { fate: FATE_DISCARD, reason: REASON_TARGET, gapS: null };
    }
    if (Number.isInteger(identity.generation) && Number.isInteger(record.generation)
        && identity.generation !== record.generation) {
      return { fate: FATE_DISCARD, reason: REASON_GENERATION, gapS: null };
    }

    const sampledAtMs = finite(identity.sampled_at) !== null
      ? Number(identity.sampled_at) * 1000 : null;
    const now = finite(nowMs) !== null ? Number(nowMs) : Date.now();
    if (sampledAtMs !== null && now - sampledAtMs > maxAge) {
      // 14秒待たされた候補をそのまま読まない。
      return { fate: FATE_DISCARD, reason: REASON_STALE, gapS: null };
    }

    const liveGap = finite(record.gap_s);
    if (liveGap === null) {
      return { fate: FATE_DISCARD, reason: REASON_NO_LIVE, gapS: null };
    }
    const candidateGap = finite(identity.gap_s);
    if (candidateGap === null || Math.abs(liveGap - candidateGap) >= 0.1) {
      // 同じ車・同じ方向のまま値だけ動いた。黙るのではなく最新値で言い直す。
      return { fate: FATE_REBUILD, reason: REASON_VALUE, gapS: liveGap };
    }
    return { fate: FATE_PLAY, reason: null, gapS: liveGap };
  }

  /** 最新値の短文。変化の意味づけ（開いた/詰めている）は付けない。 */
  function rebuildText(direction, gapS, lang) {
    const value = finite(gapS);
    if (value === null || !direction) return null;
    const ja = String(lang || '').toLowerCase().startsWith('ja');
    if (ja) return (direction === 'ahead' ? '前' : '後ろ') + value.toFixed(1) + '秒。';
    return value.toFixed(1) + ' seconds ' + (direction === 'ahead' ? 'ahead' : 'behind') + '.';
  }

  return {
    MAX_AGE_MS, FATE_PLAY, FATE_REBUILD, FATE_DISCARD,
    REASON_NOT_GAP, REASON_NO_LIVE, REASON_SESSION, REASON_TARGET,
    REASON_DIRECTION, REASON_GENERATION, REASON_STALE, REASON_VALUE,
    evaluate, rebuildText,
  };
}));
