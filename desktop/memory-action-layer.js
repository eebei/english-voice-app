(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallMemoryActionLayer = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const finite = value => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  function plain(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // ★Build 265 fix D：明示ホワイトリストのみが `monza:full` へ集約される。
  //   `monza gpsecondchicane` のような別レイアウトは自らのキーを維持する
  //   (＝過去戦略記憶に混入して誤ったプランを生まないため)。
  const MONZA_FULL_ALIASES = new Set([
    'monza',
    'monza full',
    'monza gp',
    'monza grand prix',
    'autodromo nazionale monza',
    'autodromo nazionale monza gp',
    'autodromo nazionale monza grand prix',
    'autodromo nazionale monza full',
  ]);
  const SPIELBERG_GP_ALIASES = new Set([
    'red bull ring',
    'red bull ring gp',
    'spielberg',
    'spielberg gp',
  ]);
  function normalizeTrack(value) {
    const text = plain(value);
    if (!text) return '';
    if (SPIELBERG_GP_ALIASES.has(text)) return 'spielberg:gp';
    if (/\bmonza\b/.test(text)) {
      if (MONZA_FULL_ALIASES.has(text)) return 'monza:full';
      // 追加サフィックス(gpsecondchicane / nochicane / oval / junior など)を残す。
      // 過去に "monza:<full-form>" として保存されたキーとの互換性のため、`monza:` プレフィックスを付ける。
      const suffix = text.replace(/^(?:autodromo\s+nazionale\s+)?monza\s*/, '').trim();
      return suffix ? `monza:${suffix}` : 'monza:full';
    }
    if (/nurburgring|nuerburgring/.test(text)) {
      if (/combined short|gesamtstrecke.*short/.test(text)) return 'nurburgring:combined-short';
      if (/combined|gesamtstrecke|nordschleife/.test(text)) return `nurburgring:${text.replace(/.*?(combined|gesamtstrecke|nordschleife)/, '$1')}`;
    }
    return text;
  }

  function normalizeCar(value) {
    return plain(value).replace(/\bmercedes benz\b/g, 'mercedes').replace(/\bmercedes amg\b/g, 'mercedes amg');
  }

  function recordIdentity(storageKey, record) {
    const split = String(storageKey || '').split('|');
    return {
      track: normalizeTrack(record && record.track ? record.track : split.slice(1).join('|')),
      car: normalizeCar(record && record.car ? record.car : split[0]),
    };
  }

  function matchingEntries(memory, track, carModel, carClass) {
    if (!memory || typeof memory !== 'object') return [];
    const wantedTrack = normalizeTrack(track);
    const wantedModel = normalizeCar(carModel);
    const wantedClass = normalizeCar(carClass);
    if (!wantedTrack || (!wantedModel && !wantedClass)) return [];
    const all = Object.entries(memory).filter(([, record]) => record && typeof record === 'object');
    const exact = all.filter(([key, record]) => {
      const id = recordIdentity(key, record);
      return id.track === wantedTrack && wantedModel && id.car === wantedModel;
    });
    if (exact.length) return exact;
    return all.filter(([key, record]) => {
      const id = recordIdentity(key, record);
      return id.track === wantedTrack && wantedClass && id.car === wantedClass;
    });
  }

  function weighted(records, valueName, countName, fallbackWeight = 1) {
    let total = 0, weightTotal = 0;
    for (const record of records) {
      const value = finite(record && record[valueName]);
      if (!(value > 0)) continue;
      const count = finite(record && record[countName]);
      const weight = count > 0 ? count : fallbackWeight;
      total += value * weight;
      weightTotal += weight;
    }
    return weightTotal > 0 ? total / weightTotal : null;
  }

  function resolve(memory, track, carModel, carClass) {
    const entries = matchingEntries(memory, track, carModel, carClass);
    if (!entries.length) return null;
    const records = entries.map(([, record]) => record);
    const best = records.map(record => finite(record.bestLap)).filter(value => value > 20 && value < 900);
    const fuel = weighted(records, 'avgFuel', 'fuelSampleCount');
    const avgLap = weighted(records, 'avgLap', 'avgLapSampleCount');
    const pitLane = weighted(records, 'pitLaneSec', 'pitLaneSampleCount');
    const fuelSamples = records.reduce((sum, record) => sum + Math.max(0, Math.trunc(finite(record.fuelSampleCount) || (finite(record.avgFuel) > 0 ? 1 : 0))), 0);
    const sessions = records.reduce((sum, record) => sum + Math.max(0, Math.trunc(finite(record.sessions) || 0)), 0);
    const latest = records.slice().sort((a, b) => String(a.lastDate || '').localeCompare(String(b.lastDate || ''))).pop() || {};
    return {
      ...latest,
      car: carModel || carClass || latest.car || '', track: track || latest.track || '',
      canonicalTrack: normalizeTrack(track), canonicalCar: normalizeCar(carModel || carClass),
      bestLap: best.length ? Math.min(...best) : null,
      avgFuel: fuel == null ? null : Math.round(fuel * 1000) / 1000,
      fuelSampleCount: fuelSamples,
      fuelSampleTotal: fuel == null ? null : fuel * fuelSamples,
      avgLap: avgLap == null ? null : Math.round(avgLap * 1000) / 1000,
      avgLapSampleCount: records.reduce((sum, record) => sum + Math.max(0, Math.trunc(finite(record.avgLapSampleCount) || (finite(record.avgLap) > 0 ? 1 : 0))), 0),
      pitLaneSec: pitLane == null ? null : Math.round(pitLane * 10) / 10,
      sessions,
      memoryRecordCount: entries.length,
      matchedKeys: entries.map(([key]) => key).sort(),
      source: entries.length > 1 ? 'normalized_car_track_merge' : 'exact_car_track_memory',
    };
  }

  function matches(trackA, carA, trackB, carB) {
    return normalizeTrack(trackA) === normalizeTrack(trackB)
      && normalizeCar(carA) === normalizeCar(carB);
  }

  function isStaleUnavailableNote(value) {
    const text = String(value || '');
    return /(?:取得できない|実測.*揃っていない|まだ確定できない|データを受信中|完走目標が確定していない|unavailable|not (?:yet )?(?:available|confirmed)|awaiting .*data)/i.test(text);
  }

  // デブリーフは毎回同じ質問票を消化する場ではない。保存済みの同条件申告から、
  // 次回に「変わったか」だけを確認する一点を選ぶ。数値や結論は作らず、
  // driver/track/car が揃わない記憶は絶対に拾わない。
  function isProductFeedbackQuestion(value) {
    return /(?:製品|プロダクト|サポート.*(?:役|邪魔)|product|support.*(?:help|hinder)|feedback)/i.test(String(value || ''));
  }

  function selectDebriefFollowUp(records, context = {}) {
    const wantedDriver = String(context.driver || '').trim();
    const wantedTrack = String(context.track || '').trim();
    const wantedCar = String(context.car || '').trim();
    const used = new Set(Array.isArray(context.usedKeys) ? context.usedKeys.map(String) : []);
    if (!wantedDriver || !wantedTrack || !wantedCar || !Array.isArray(records)) return null;

    const rows = records.slice().filter(record => {
      if (!record || record.driver !== wantedDriver || record.kind === 'driver_preference') return false;
      const scope = record.scope && typeof record.scope === 'object' ? record.scope : {};
      const storedCar = scope.car || scope.car_class || '';
      return matches(wantedTrack, wantedCar, scope.track || '', storedCar);
    }).sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));

    for (const record of rows) {
      const qa = Array.isArray(record.qa) ? record.qa : [];
      for (let i = qa.length - 1; i >= 0; i--) {
        const pair = qa[i] || {};
        const answer = String(pair.answer || '').trim().replace(/\s+/g, ' ');
        const question = String(pair.question || '').trim().replace(/\s+/g, ' ');
        const key = `${String(record.review_id || record.created_at || 'record')}:${i}`;
        if (!answer || !question || answer.length < 2 || used.has(key) || isProductFeedbackQuestion(question)) continue;
        return {
          key,
          reviewId: String(record.review_id || ''),
          question,
          answer: answer.slice(0, 180),
          confidence: String(record.confidence || 'driver_reported'),
        };
      }
    }
    return null;
  }

  return { normalizeTrack, normalizeCar, matchingEntries, resolve, matches, isStaleUnavailableNote,
    selectDebriefFollowUp };
}));
