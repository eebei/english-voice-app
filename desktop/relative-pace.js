(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallRelativePace = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ★2026-08-29 Phase F1 — 前後相対ペースの専用 authority。
  //
  // 実走で起きた失敗：「後ろの方がペース速い？」に対し、総燃料不足を根拠に
  // pit now を返した（RBR）。相対ペースの問いに、燃料でも 60Hz の自車運転
  // スタイルでもない **実測ラップの比較** を返す場所がどこにも無かった。
  //
  // 規律：
  //   - 対象は CarIdx で固定する。順位表示や名前で後から取り違えない。
  //   - 比較は「どの車の・いつの・何周分か」を必ず添える。
  //   - 材料が足りなければ `unconfirmed`。相手のペースを推測で作らない。
  //   - ここは燃料も pit も語らない。pit now は Plan Fuel Authority の専権。
  //   - 近傍10台を既定スコープとし、全同クラスへ広げられる形で持つ。
  //     取れていない車があるのに「全車を見た」とは言わない。

  const NEAREST_SCOPE = 10;         // 既定の観測スコープ（前後合わせた同クラス台数）
  const MAX_LAPS_PER_CAR = 5;       // 1台あたり保持するラップ標本
  const MIN_SAMPLES = 2;            // 相手ペースを述べるのに要る最小標本
  const SAMPLE_MAX_AGE_MS = 300000; // 5分より古い標本は比較に使わない
  const CAR_PRUNE_MS = 600000;      // 10分見えない車は台帳から落とす
  const EVEN_BAND_S = 0.15;         // これ未満は「互角」

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
  const plausibleLap = value => {
    const n = finite(value);
    return (n !== null && n > 20 && n < 900) ? n : null;
  };
  const median = list => {
    const sorted = list.slice().sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  function emptyStore() {
    return { schema: 'relative_pace_v1', session_key: null, cars: {}, self: null };
  }

  function normalize(store) {
    if (!store || typeof store !== 'object' || store.schema !== 'relative_pace_v1') return emptyStore();
    return {
      schema: 'relative_pace_v1',
      session_key: store.session_key === undefined ? null : store.session_key,
      cars: (store.cars && typeof store.cars === 'object') ? store.cars : {},
      self: (store.self && typeof store.self === 'object') ? store.self : null
    };
  }

  function sessionKey(live) {
    const num = intOrNull(live && live.session_num);
    return num === null ? 'unknown' : String(num);
  }

  function pushSample(entry, lapTimeS, lap, now) {
    const last = entry.samples[entry.samples.length - 1];
    // 同じ完了ラップを毎 snapshot 積まない。ラップ番号か値が変わった時だけ。
    if (last && last.lap_time_s === lapTimeS && (lap === null || last.lap === lap)) return false;
    entry.samples.push({ lap_time_s: lapTimeS, lap, at: now });
    if (entry.samples.length > MAX_LAPS_PER_CAR) entry.samples.shift();
    return true;
  }

  /**
   * telemetry snapshot から同クラス近傍の実測ラップを積む。
   * 自車は clean 周だけを採り、相手は iRacing が出す完了ラップを採る
   * （相手のペダル/舵角は取得できない＝走り方の主張には決して使わない）。
   */
  function observe(input) {
    const store = normalize(input && input.store);
    const live = (input && input.live && typeof input.live === 'object') ? input.live : null;
    const now = finite(input && input.now) || Date.now();
    if (!live) return { store, observed: 0 };

    const key = sessionKey(live);
    if (store.session_key !== key) {
      // セッションが変われば前のラップは他人の事実。持ち越さない。
      store.session_key = key;
      store.cars = {};
      store.self = null;
    }

    const selfPos = intOrNull(live.class_pos);
    let observed = 0;

    // 自車：有効周だけを標本にする（黄旗・コースオフ・ピット周を混ぜない）。
    const own = plausibleLap(live.last);
    if (own !== null && live.lap_valid_clean === true) {
      if (!store.self) store.self = { samples: [] };
      if (pushSample(store.self, own, intOrNull(live.lap), now)) observed++;
    }

    const competitors = Array.isArray(live.competitors) ? live.competitors : [];
    competitors.forEach(car => {
      const idx = intOrNull(car && car.car_idx);
      const pos = intOrNull(car && car.class_pos);
      if (idx === null || pos === null) return;
      // 既定スコープ＝近傍10台。将来の全同クラス化は scope を広げるだけで済む。
      if (selfPos !== null && Math.abs(pos - selfPos) > NEAREST_SCOPE) return;
      const id = String(idx);
      const entry = store.cars[id] || { car_idx: idx, samples: [] };
      entry.name = car.name || entry.name || null;
      entry.car_number = car.car_number || entry.car_number || null;
      entry.class_pos = pos;
      entry.gap_s = finite(car.gap_s);
      entry.seen_at = now;
      const lapTime = plausibleLap(car.last_lap_s);
      if (lapTime !== null && pushSample(entry, lapTime, intOrNull(car.lap), now)) observed++;
      store.cars[id] = entry;
    });

    Object.keys(store.cars).forEach(id => {
      if (now - (store.cars[id].seen_at || 0) > CAR_PRUNE_MS) delete store.cars[id];
    });
    return { store, observed };
  }

  function freshSamples(entry, now) {
    if (!entry || !Array.isArray(entry.samples)) return [];
    return entry.samples.filter(s => finite(s.lap_time_s) !== null && (now - (s.at || 0)) <= SAMPLE_MAX_AGE_MS);
  }

  // 現在の snapshot から、同クラスの真の前／真の後ろを CarIdx ごと確定する。
  function adjacentTarget(live, direction) {
    const selfPos = intOrNull(live && live.class_pos);
    if (selfPos === null) return null;
    const wanted = direction === 'ahead' ? selfPos - 1 : selfPos + 1;
    if (wanted < 1) return null;
    const competitors = Array.isArray(live.competitors) ? live.competitors : [];
    const match = competitors.find(c => intOrNull(c && c.class_pos) === wanted);
    if (!match || intOrNull(match.car_idx) === null) return null;
    return {
      car_idx: intOrNull(match.car_idx),
      name: match.name || null,
      car_number: match.car_number || null,
      class_pos: wanted,
      gap_s: finite(match.gap_s)
    };
  }

  function unconfirmed(reason, direction, lang, detail) {
    const ja = isJa(lang);
    const side = direction === 'ahead' ? (ja ? '前' : 'the car ahead') : (ja ? '後ろ' : 'the car behind');
    const why = {
      no_target: ja ? '同クラスで隣接する車を確定できない' : 'I cannot fix the adjacent same-class car',
      no_rival_laps: ja ? '相手の有効ラップがまだ足りない' : 'I do not have enough of their laps yet',
      no_own_laps: ja ? '自分のクリーン周がまだ足りない' : 'I do not have enough of your clean laps yet',
      stale: ja ? '比較できる新しさのデータが無い' : 'the data is not fresh enough'
    }[reason] || (ja ? '材料が足りない' : 'the evidence is incomplete');
    return {
      available: false, verdict: 'unconfirmed', reason, direction,
      target: (detail && detail.target) || null,
      own_samples: (detail && detail.own_samples) || 0,
      target_samples: (detail && detail.target_samples) || 0,
      delta_s: null, window_s: null,
      reply: ja
        ? `${side}の相対ペースは未確認。${why}。`
        : `Relative pace to ${side} is unconfirmed: ${why}.`
    };
  }

  /**
   * 同クラス前後との実測ペース比較。
   * 返すのは比較結果だけ。燃料・pit・戦略の指示はここからは出さない。
   */
  function compare(input) {
    const store = normalize(input && input.store);
    const live = (input && input.live && typeof input.live === 'object') ? input.live : null;
    const direction = input && input.direction === 'ahead' ? 'ahead' : 'behind';
    const lang = isJa(input && input.lang) ? 'ja' : 'en';
    const now = finite(input && input.now) || Date.now();
    if (!live) return unconfirmed('stale', direction, lang);

    // セッションが変わった台帳は使わない（別セッションの周回で比較しない）。
    if (store.session_key !== null && store.session_key !== sessionKey(live)) {
      return unconfirmed('stale', direction, lang);
    }
    const target = adjacentTarget(live, direction);
    if (!target) return unconfirmed('no_target', direction, lang);

    const ownSamples = freshSamples(store.self, now);
    const targetSamples = freshSamples(store.cars[String(target.car_idx)], now);
    const detail = { target, own_samples: ownSamples.length, target_samples: targetSamples.length };
    if (ownSamples.length < MIN_SAMPLES) return unconfirmed('no_own_laps', direction, lang, detail);
    if (targetSamples.length < MIN_SAMPLES) return unconfirmed('no_rival_laps', direction, lang, detail);

    const ownMedian = median(ownSamples.map(s => s.lap_time_s));
    const targetMedian = median(targetSamples.map(s => s.lap_time_s));
    const delta = Number((targetMedian - ownMedian).toFixed(3));   // 正 = 相手が遅い
    const oldest = Math.min.apply(null, ownSamples.concat(targetSamples).map(s => s.at || now));
    const windowS = Math.round((now - oldest) / 1000);
    const verdict = Math.abs(delta) < EVEN_BAND_S ? 'even' : (delta < 0 ? 'target_faster' : 'target_slower');
    const ja = lang === 'ja';
    const side = direction === 'ahead' ? (ja ? '前' : 'ahead') : (ja ? '後ろ' : 'behind');
    const who = target.car_number ? `#${target.car_number}` : `P${target.class_pos}`;
    const laps = Math.min(ownSamples.length, targetSamples.length);
    const magnitude = Math.abs(delta).toFixed(2);
    const body = ja
      ? (verdict === 'even'
        ? `${side}${who}とはほぼ互角。`
        : `${side}${who}が${magnitude}秒${verdict === 'target_faster' ? '速い' : '遅い'}。`)
      : (verdict === 'even'
        ? `${who} ${side} is on your pace.`
        : `${who} ${side} is ${magnitude}s ${verdict === 'target_faster' ? 'faster' : 'slower'}.`);
    return {
      available: true, verdict, direction, target,
      own_median_s: Number(ownMedian.toFixed(3)),
      target_median_s: Number(targetMedian.toFixed(3)),
      delta_s: delta,
      own_samples: ownSamples.length,
      target_samples: targetSamples.length,
      compared_laps: laps,
      window_s: windowS,
      reply: body + (ja ? `直近${laps}周の中央値。` : ` Median of the last ${laps} laps.`)
    };
  }

  // 「全同クラスを見た」と言わないための被覆率。将来の全車拡張の受け皿。
  //
  // `competitors` は「F2Timeが有効な同クラス車」であって、クラスの全エントリー
  // ではない。ここを母数にすると、映っている車を全部見た瞬間に「全車分析済み」
  // を名乗ってしまう。クラス総数は SessionInfo 側の事実なので、渡されない限り
  // complete_field は false のままにする（未確認を確認済みへ格上げしない）。
  function fieldCoverage(input) {
    const store = normalize(input && input.store);
    const live = (input && input.live && typeof input.live === 'object') ? input.live : {};
    const now = finite(input && input.now) || Date.now();
    const competitors = Array.isArray(live.competitors) ? live.competitors : [];
    const visible = competitors.length;
    const sampled = competitors.filter(c => {
      const idx = intOrNull(c && c.car_idx);
      return idx !== null && freshSamples(store.cars[String(idx)], now).length >= MIN_SAMPLES;
    }).length;
    const entryCount = intOrNull(input && input.classEntryCount);
    const rivalsInClass = entryCount === null ? null : Math.max(0, entryCount - 1);
    return {
      scope: 'nearest_' + NEAREST_SCOPE,
      visible_same_class_cars: visible,
      sampled_cars: sampled,
      class_entry_count: entryCount,
      // クラス総数が分からない、または取れていない車がある限り名乗らない。
      complete_field: rivalsInClass !== null && rivalsInClass > 0
        && sampled >= rivalsInClass && visible >= rivalsInClass
    };
  }

  const QUESTION_RE = /(?:前|後ろ|後方|相手|ライバル).{0,10}(?:ペース|速い|はやい|遅い|おそい|詰め|迫っ|追いつ|離れ)|(?:ペース).{0,10}(?:前|後ろ|後方)|(?:car |driver )?(?:ahead|behind).{0,16}(?:pace|faster|quicker|slower|catching|closing)|(?:pace).{0,16}(?:ahead|behind)/i;
  const AHEAD_RE = /前|ahead|in front/i;
  const BEHIND_RE = /後ろ|後方|behind|catching/i;

  function isRelativePaceQuestion(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    // 燃料・ピットの話はここでは扱わない（Plan Fuel Authority の担当）。
    if (/燃料|給油|リットル|ピット|ボックス|fuel|pit\b|box\b/i.test(t)) return false;
    return QUESTION_RE.test(t);
  }

  /** 質問→回答。相対ペース以外は handled:false で通常経路へ返す。 */
  function answerQuestion(input) {
    const text = String(input && input.text || '').trim();
    const lang = isJa(input && input.lang) ? 'ja' : 'en';
    if (!isRelativePaceQuestion(text)) return { handled: false };
    const wantsAhead = AHEAD_RE.test(text);
    const wantsBehind = BEHIND_RE.test(text);
    const directions = (wantsAhead && wantsBehind) ? ['ahead', 'behind']
      : wantsAhead ? ['ahead'] : ['behind'];
    const results = directions.map(direction => compare({
      store: input && input.store, live: input && input.live,
      direction, lang, now: input && input.now
    }));
    return {
      handled: true,
      intent: 'relative_pace',
      // 相対ペースの回答は相対ペースだけ。ここから pit now は絶対に出さない。
      contains_pit_instruction: false,
      results,
      coverage: fieldCoverage({ store: input && input.store, live: input && input.live,
        now: input && input.now, classEntryCount: input && input.classEntryCount }),
      reply: results.map(r => r.reply).join(lang === 'ja' ? '' : ' ')
    };
  }

  return {
    NEAREST_SCOPE, MIN_SAMPLES, MAX_LAPS_PER_CAR, SAMPLE_MAX_AGE_MS, EVEN_BAND_S,
    emptyStore, normalize, observe, compare, adjacentTarget, fieldCoverage,
    isRelativePaceQuestion, answerQuestion
  };
}));
