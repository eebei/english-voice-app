(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallSessionMemory = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ★スライス1（2026-08-25）記憶→戦略の取得層。
  //
  // Tunnel Completion Rule：入口（Bridge）→保存（pw_raceHistory）→**取得**→出口（発話）を
  // 一本で閉じるための中間層。ここが決定論であることが要点で、
  // 「どの記録を使うか」「何を事実として言うか」をLLMに選ばせない。
  //
  // 原則：
  //   - 記録が無ければ「無い」と言う。現在値で代用しない（Build 281 の実走欠陥）。
  //   - 同一条件でなければ使わない。別トラック・別車種の記録を流用しない。
  //   - 推測しない。欠けている項目は欠けたまま返す。

  const finite = value => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const norm = value => String(value == null ? '' : value).trim().toLowerCase();
  const SPIELBERG_GP_ALIASES = new Set([
    'red bull ring', 'red bull ring gp', 'spielberg', 'spielberg gp'
  ]);
  function normTrack(value) {
    const text = norm(value).replace(/[^a-z0-9]+/g, ' ').trim();
    return SPIELBERG_GP_ALIASES.has(text) ? 'spielberg:gp' : text;
  }
  const isJP = lang => String(lang || '').toLowerCase().startsWith('ja');
  const MAX_RECORD_AGE_MS = 90 * 24 * 60 * 60 * 1000;

  function isFreshRecord(record, nowMs) {
    const raw = record && (record.recordedAt || record.date);
    const at = Date.parse(String(raw || ''));
    if (!Number.isFinite(at)) return false;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    // Future-dated cache or records older than the evidence window cannot
    // become today's strategy/weather fact.
    return at <= now + 5 * 60 * 1000 && now - at <= MAX_RECORD_AGE_MS;
  }

  // 同一条件の判定。現在側で分かっているidentityは、記録側にも同じ値が
  // なければならない。古いrecordの空欄を「何でも一致」と扱うと、別車種・
  // 別series・別アカウントの過去を今回の事実として喋る事故になる。
  function matchesIdentity(record, identity, nowMs) {
    if (!record || !identity) return false;
    // ★スライス4c：ドライバーが「それ違う」と言った記録は、本人合意で訂正される
    //   まで一切使わない。天候・順位・setup・pit すべて同じ規律にする。
    if (record.disputed === true) return false;
    if (!isFreshRecord(record, nowMs)) return false;
    if (!normTrack(identity.track)) return false;
    if (normTrack(record.track) !== normTrack(identity.track)) return false;
    const wantUser = identity.userId;
    if (wantUser !== null && wantUser !== undefined && wantUser !== '') {
      if (String(record.userId ?? '') !== String(wantUser)) return false;
    }
    const wantCar = norm(identity.car || identity.carClass);
    if (wantCar) {
      const gotCar = norm(record.car || record.carClass);
      if (gotCar !== wantCar) return false;
    }
    if (Number.isInteger(identity.seriesId)) {
      if (!Number.isInteger(record.seriesId) || identity.seriesId !== record.seriesId) return false;
    }
    return true;
  }

  // 同一条件のうち最新の1件だけを選ぶ。複数を混ぜると、どの日の事実か言えなくなる。
  function selectPrevious(history, identity, nowMs) {
    if (!Array.isArray(history)) return null;
    const matches = history.filter(record => matchesIdentity(record, identity, nowMs));
    return matches.length ? matches[matches.length - 1] : null;
  }

  function hasWeather(record) {
    return !!record && (finite(record.trackTempC) !== null || finite(record.airTempC) !== null);
  }

  function sameSetup(record, identity) {
    const a = norm(record && record.setupFingerprint);
    const b = norm(identity && identity.setupFingerprint);
    if (!a || !b) return 'unknown';
    return a === b ? 'matched' : 'mismatch';
  }

  // 「昨日の路面温度は？」への決定論回答。
  // 記録が無い時に現在値を返さないことが、この関数の存在理由。
  function answerHistoricalWeather(history, identity, lang, nowMs) {
    const ja = isJP(lang);
    const record = selectPrevious(history, identity, nowMs);
    if (!record || !hasWeather(record)) {
      return {
        handled: true,
        intent: 'historical_weather_unavailable',
        reply: ja ? '同じ条件の過去記録がない。現在値では代用しない。'
                  : 'There is no past record for these conditions. I will not substitute the current value.',
        record: null,
      };
    }
    const track = finite(record.trackTempC);
    const air = finite(record.airTempC);
    const when = String(record.date || '').trim();
    const parts = [];
    if (track !== null) parts.push(ja ? `路面${track.toFixed(1)}℃` : `track ${track.toFixed(1)}C`);
    if (air !== null) parts.push(ja ? `気温${air.toFixed(1)}℃` : `air ${air.toFixed(1)}C`);
    const body = parts.join(ja ? '、' : ', ');
    return {
      handled: true,
      intent: 'historical_weather',
      reply: ja ? `${when}の${record.track}は${body}。` : `On ${when} at ${record.track}: ${body}.`,
      record,
    };
  }

  // 次回ブリーフィング用の確定事実。文章にはせず、事実だけを返す。
  // 文面を作るのは呼び出し側で、ここが数字を持つ唯一の場所。
  function briefingFacts(history, identity, nowMs) {
    const record = selectPrevious(history, identity, nowMs);
    if (!record) return { available: false, reason: 'no_matching_record' };
    const start = Number.isInteger(record.startPos) && record.startPos > 0 ? record.startPos : null;
    const finish = Number.isInteger(record.finishPos) && record.finishPos > 0 ? record.finishPos : null;
    return {
      available: true,
      date: String(record.date || '') || null,
      track: record.track || null,
      car: record.car || record.carClass || null,
      startPos: start,
      finishPos: finish,
      positionsGained: (start !== null && finish !== null) ? start - finish : null,
      trackTempC: finite(record.trackTempC),
      airTempC: finite(record.airTempC),
      setupMatch: sameSetup(record, identity),
      pitCount: Array.isArray(record.pitEvents) ? record.pitEvents.length : null,
      avgFuelPerLap: finite(record.avgFuelPerLap),
    };
  }

  // ブリーフィングで読み上げる短い一文。数字は briefingFacts が持つものだけを使う。
  // 事実が無ければ空文字を返し、呼び出し側は「言わない」を選べる。
  function briefingLine(facts, lang) {
    if (!facts || !facts.available) return '';
    const ja = isJP(lang);
    const bits = [];
    if (facts.startPos !== null && facts.finishPos !== null) {
      bits.push(ja ? `${facts.startPos}番手スタートで${facts.finishPos}位`
                   : `started P${facts.startPos}, finished P${facts.finishPos}`);
    } else if (facts.finishPos !== null) {
      bits.push(ja ? `${facts.finishPos}位` : `finished P${facts.finishPos}`);
    }
    if (facts.trackTempC !== null) {
      bits.push(ja ? `路面${facts.trackTempC.toFixed(1)}℃` : `track ${facts.trackTempC.toFixed(1)}C`);
    }
    // ★スライス4：pit 回数と燃費も Bridge 実測なので同じ規律で述べる。
    //   記録が無ければ足さない（0回と「記録なし」を混同しない）。
    if (Number.isInteger(facts.pitCount)) {
      bits.push(ja ? `ピット${facts.pitCount}回` : `${facts.pitCount} stop${facts.pitCount === 1 ? '' : 's'}`);
    }
    if (facts.avgFuelPerLap !== null) {
      bits.push(ja ? `平均${facts.avgFuelPerLap.toFixed(2)}L/周`
                   : `${facts.avgFuelPerLap.toFixed(2)}L per lap`);
    }
    if (!bits.length) return '';
    const head = ja ? `前回${facts.date ? facts.date + 'の' : ''}${facts.track || ''}は`
                    : `Last time at ${facts.track || 'this track'}${facts.date ? ' on ' + facts.date : ''}: `;
    const tail = ja ? '。' : '.';
    const setup = facts.setupMatch === 'mismatch'
      ? (ja ? ' セットアップは前回と別。' : ' Setup differs from that run.')
      : '';
    return `${head}${bits.join(ja ? '、' : ', ')}${tail}${setup}`;
  }

  // ★スライス4（2026-08-25）setup の前後比較（正本 §5.4）。
  //
  // 実測すると、比較に必要な材料は**既に全部 pw_raceHistory にある**。
  // `setupFingerprint`（Bridge の SHA-256 先頭16桁）も `bestLap` も入っている。
  // 足りなかったのは「同一 track / car で fingerprint が違う2件を突き合わせて、
  // 次回 Practice で提示する」出口だけだった。
  //
  // 原則：
  //   - 数値は Bridge 実測（`bestLap`）だけ。SDK が出さない setup の中身は推測しない。
  //   - 本人申告は `source:'declared'` として**ラベルとしてのみ**持つ。
  //     申告文から数値を作らない（「1段柔らかく」を量として解釈しない）。
  //   - fingerprint が同じ2件は「別のsetup」ではないので比較しない。

  function setupComparison(history, identity, nowMs) {
    if (!Array.isArray(history) || !identity) return { available: false, reason: 'no_history' };
    const current = norm(identity.setupFingerprint);
    if (!current) return { available: false, reason: 'no_current_setup_fingerprint' };
    // identity 一致（track / car / series / user / 鮮度）は既存規約をそのまま使う。
    const matches = history.filter(record => matchesIdentity(record, identity, nowMs)
      && finite(record.bestLap) !== null && norm(record.setupFingerprint));
    if (!matches.length) return { available: false, reason: 'no_matching_record' };
    const same = matches.filter(r => norm(r.setupFingerprint) === current);
    const other = matches.filter(r => norm(r.setupFingerprint) !== current);
    if (!same.length || !other.length) {
      return { available: false, reason: 'no_setup_change_to_compare' };
    }
    const now = same[same.length - 1];
    const before = other[other.length - 1];
    const declared = now.setupDeclared || before.setupDeclared || null;
    return {
      available: true, reason: null,
      track: now.track || null,
      currentBestLap: finite(now.bestLap),
      previousBestLap: finite(before.bestLap),
      deltaS: finite(now.bestLap) - finite(before.bestLap),
      previousDate: String(before.date || '') || null,
      // 申告は出所を明示して持つ。SDK 実測と混ぜない。
      declaredLabel: declared && declared.label ? String(declared.label) : null,
      declaredSource: declared ? 'declared' : null,
      measuredSource: 'sdk',
    };
  }

  function setupComparisonLine(comparison, lang) {
    if (!comparison || !comparison.available) return '';
    const ja = isJP(lang);
    const delta = finite(comparison.deltaS);
    if (delta === null) return '';
    const abs = Math.abs(delta).toFixed(3);
    const better = delta < 0;
    const label = comparison.declaredLabel
      ? (ja ? `${comparison.declaredLabel}の申告のあと、` : `After your reported change (${comparison.declaredLabel}), `)
      : (ja ? 'セットアップを変えたあと、' : 'After the setup change, ');
    const body = ja
      ? `ベストは${abs}秒${better ? '速く' : '遅く'}なった。`
      : `your best lap was ${abs}s ${better ? 'quicker' : 'slower'}.`;
    return label + body;
  }

  // 本人申告を最新の記録へラベルとして貼る。数値は作らない。
  function attachSetupDeclaration(history, label, nowMs) {
    const out = Array.isArray(history) ? history.slice() : [];
    if (!out.length || !String(label || '').trim()) return { history: out, attached: false };
    const record = out[out.length - 1];
    record.setupDeclared = {
      label: String(label).trim().slice(0, 60),
      at: new Date(nowOrMs(nowMs)).toISOString(),
      source: 'declared',
    };
    return { history: out, attached: true };
  }
  function nowOrMs(ms) { return Number.isFinite(ms) ? ms : Date.now(); }

  return { matchesIdentity, selectPrevious, answerHistoricalWeather, briefingFacts, briefingLine, isFreshRecord,
    setupComparison, setupComparisonLine, attachSetupDeclaration };
}));
