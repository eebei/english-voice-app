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
  const REASON_LIVE_STALE = 'live_snapshot_stale';   // 回答側：現在値そのものが古い
  const REASON_DROPPED = 'direction_dropped';        // 回答側：片方向の値が消えた

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

  // ★G5（2026-08-25）PTT質問の回答も、TTS開始直前に照合する。
  //
  // Codex Build 284 P1：`localIntent` は `speak()` へ identity を渡しておらず、
  // 質問時点で5秒以内でも、先行発話で queue 待ちになった後に古い数値のまま
  // 再生され得た。回答生成時だけ 5 秒契約を満たし、出口では満たしていなかった。
  //
  // 自発コールと **意図的に契約を分ける**：
  //
  //   自発 `gap_trend`  「あの車に対して5.3秒開いた」＝特定の対象車への時間差分の主張。
  //                     対象車が変われば主張ごと無効 → 破棄。基準は候補の sampled_at。
  //   質問 `nearest_gap` 「今、前は何秒」＝時点の事実。対象車が入れ替わっていても、
  //                     いま前にいる車の秒数が答え → 最新値で作り直す。
  //                     基準は **現在 snapshot の年齢**（今の値が新しければ答えられる）。
  //
  // 質問側で対象車交代を破棄にすると、Build 281 の「値があるのに答えない」を再発させる。
  //
  // 値の出所は `live['gap_'+direction]`（router が答えに使うのと同じ値）に固定する。
  // 別々の出所から取ると、作り直した文が「router がいま言う答え」と食い違う。

  function liveGapFor(direction, live) {
    if (!live || !direction) return null;
    return finite(live['gap_' + direction]);
  }

  function authorityFor(direction, live) {
    const table = live && live.gap_authority;
    if (!table || !direction) return null;
    const record = table[direction];
    return (record && typeof record === 'object') ? record : null;
  }

  /**
   * PTT 回答（1方向でも前後同時でも）の再生直前判定。
   *
   * @param {Array} identities 回答が述べた方向の配列（router が積んだ順）
   * @param {Object} live      現在の telemetry snapshot
   * @param {number} nowMs
   * @param {Object} options   {liveAgeMs} = snapshot 自体の年齢。{maxAgeMs} 上書き用
   * @returns {{fate:string, reason:(string|null), entries:Array}}
   */
  function evaluateAnswer(identities, live, nowMs, options) {
    const maxAge = (options && finite(options.maxAgeMs) !== null) ? Number(options.maxAgeMs) : MAX_AGE_MS;
    const list = Array.isArray(identities) ? identities.filter(i => i && typeof i === 'object' && i.direction) : [];
    if (!list.length) return { fate: FATE_PLAY, reason: REASON_NOT_GAP, entries: [] };

    // 現在値そのものが古いなら、どの方向も答えの材料にならない。
    const liveAge = finite(options && options.liveAgeMs);
    if (liveAge !== null && liveAge > maxAge) {
      return { fate: FATE_DISCARD, reason: REASON_LIVE_STALE, entries: [] };
    }

    const entries = [];
    let changed = false;
    for (const identity of list) {
      const record = authorityFor(identity.direction, live);
      // セッションが変わったら何も引き継がない。片方向の話ではないので即破棄。
      if (identity.session_key !== undefined && identity.session_key !== null
          && record && record.session_key !== undefined
          && String(identity.session_key) !== String(record.session_key)) {
        return { fate: FATE_DISCARD, reason: REASON_SESSION, entries: [] };
      }
      const current = liveGapFor(identity.direction, live);
      if (current === null) { changed = true; continue; }   // その方向は落とす（旧値は残さない）
      const spoken = finite(identity.gap_s);
      if (spoken === null || Math.abs(current - spoken) >= 0.1) changed = true;
      if (record && Number.isInteger(identity.generation) && Number.isInteger(record.generation)
          && identity.generation !== record.generation) changed = true;
      if (record && identity.target_car_idx !== null && identity.target_car_idx !== undefined
          && record.target_car_idx !== null && record.target_car_idx !== undefined
          && identity.target_car_idx !== record.target_car_idx) changed = true;
      entries.push({ direction: identity.direction, gapS: current });
    }

    if (!entries.length) return { fate: FATE_DISCARD, reason: REASON_NO_LIVE, entries: [] };
    if (entries.length !== list.length) return { fate: FATE_REBUILD, reason: REASON_DROPPED, entries };
    if (changed) return { fate: FATE_REBUILD, reason: REASON_VALUE, entries };
    return { fate: FATE_PLAY, reason: null, entries };
  }

  /** 回答文の作り直し。router の言い回しと同じ形にする（別の文体を持ち込まない）。 */
  function rebuildAnswerText(entries, lang) {
    const list = Array.isArray(entries) ? entries : [];
    const ja = String(lang || '').toLowerCase().startsWith('ja');
    const parts = [];
    for (const entry of list) {
      const value = finite(entry && entry.gapS);
      if (value === null || !entry.direction) continue;
      parts.push(ja
        ? (entry.direction === 'ahead' ? '前' : '後ろ') + value.toFixed(1) + '秒'
        : value.toFixed(1) + ' seconds ' + (entry.direction === 'ahead' ? 'ahead' : 'behind'));
    }
    if (!parts.length) return null;
    return ja ? parts.join('、') + '。' : parts.join(', ') + '.';
  }

  // ══ Phase F2（2026-08-29）ドライバー訂正後の保留台帳 ══
  //
  // 実走の形：後方1秒以上あるのに 0.1 秒と言い、ドライバーが「実際はもっと
  // 後ろ」と訂正した。ここで壊れやすいのは二方向で、両方やってはいけない。
  //   ① 訂正の自由文（「1秒以上」）を新しい実測値へ昇格させる
  //   ② 誤った既存値を、そのまま確定事実として言い続ける
  // 取るべきは第三の道＝**その方向のソースを保留し、再観測まで未確認と言う**。
  const HOLD_SCHEMA = 'gap_hold_v1';

  function emptyHolds() { return { schema: HOLD_SCHEMA, ahead: null, behind: null }; }

  function normalizeHolds(holds) {
    if (!holds || typeof holds !== 'object' || holds.schema !== HOLD_SCHEMA) return emptyHolds();
    const one = record => (record && typeof record === 'object') ? record : null;
    return { schema: HOLD_SCHEMA, ahead: one(holds.ahead), behind: one(holds.behind) };
  }

  /**
   * ドライバー訂正を受けて、その方向のGAPソースを再観測待ちにする。
   * 訂正の中の数値は保存しない（発話は実測ではない）。
   */
  function disputeGap(holds, direction, live, nowMs) {
    const next = normalizeHolds(holds);
    if (direction !== 'ahead' && direction !== 'behind') return { holds: next, held: false };
    const record = authorityFor(direction, live);
    next[direction] = {
      // 「この世代・この対象の値」を保留する。次の世代が来れば自動で解ける。
      generation: record ? record.generation : null,
      target_car_idx: record ? record.target_car_idx : null,
      session_key: record ? record.session_key : null,
      disputed_value_s: liveGapFor(direction, live),
      at: finite(nowMs) === null ? Date.now() : nowMs,
      reason: 'driver_disputed'
    };
    return { holds: next, held: true };
  }

  /**
   * 保留中か。新しい観測（generation か対象車の変化）が来ていれば解除する。
   * 解除は「観測が更新された」時だけで、時間経過だけでは解かない。
   */
  function gapHoldStatus(holds, direction, live) {
    const state = normalizeHolds(holds);
    const record = state[direction];
    if (!record) return { held: false, released: false, holds: state };
    const current = authorityFor(direction, live);
    const generation = current ? current.generation : null;
    const target = current ? current.target_car_idx : null;
    const reobserved = (generation !== null && generation !== undefined && generation !== record.generation)
      || (target !== null && target !== undefined && target !== record.target_car_idx);
    if (reobserved) {
      const released = normalizeHolds(state);
      released[direction] = null;
      return { held: false, released: true, holds: released };
    }
    return { held: true, released: false, holds: state };
  }

  function holdReply(direction, lang) {
    const ja = String(lang || '').toLowerCase().startsWith('ja');
    const side = direction === 'ahead' ? (ja ? '前' : 'ahead') : (ja ? '後ろ' : 'behind');
    return ja
      ? `${side}の車間は未確認。前の値は保留にした。次の観測で言い直す。`
      : `The gap ${side} is unconfirmed; the previous value is on hold until the next observation.`;
  }

  return {
    MAX_AGE_MS, FATE_PLAY, FATE_REBUILD, FATE_DISCARD,
    HOLD_SCHEMA, emptyHolds, normalizeHolds, disputeGap, gapHoldStatus, holdReply,
    REASON_NOT_GAP, REASON_NO_LIVE, REASON_SESSION, REASON_TARGET,
    REASON_DIRECTION, REASON_GENERATION, REASON_STALE, REASON_VALUE,
    REASON_LIVE_STALE, REASON_DROPPED,
    evaluate, rebuildText, evaluateAnswer, rebuildAnswerText,
  };
}));
