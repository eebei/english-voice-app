(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallLunaSelfMemory = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Engineer corrections are driver-authored facts. Assistant text is never a
  // source: a model must not write a lesson and then approve its own lesson.
  const MAX_RECORDS = 24;
  const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  const MIN_REPEAT_MS = 10 * 60 * 1000;
  const norm = value => String(value == null ? '' : value).trim();
  const keyFor = identity => [identity && identity.userId, identity && identity.track,
    identity && (identity.car || identity.carClass)].map(norm).join('|').toLowerCase();

  function validIdentity(identity) {
    return !!(identity && identity.userId !== null && identity.userId !== undefined
      && norm(identity.track) && norm(identity.car || identity.carClass));
  }

  function correctionFromDriver(text) {
    const value = norm(text).replace(/\s+/g, ' ').slice(0, 180);
    if (!value) return null;
    const explicit = /(改善して|直して|訂正して|次(?:回|から).*(?:して|伝えて|使って)|もっと.*(?:正確|早く|明確)|please (?:improve|fix|correct)|next time|from now on)/i.test(value);
    if (!explicit) return null;
    let tag = null;
    if (/(GAP|ギャップ|gap)/i.test(value) && /(精度|正確|最新|accuracy|accurate|latest)/i.test(value)) tag = 'gap_accuracy';
    else if (/(給油|fuel)/i.test(value) && /(ウィンドウ|window|先に|早く|ahead|earlier|proactive)/i.test(value)) tag = 'fuel_window_proactive';
    else if (/(周回遅れ|青い文字|lapped|blue)/i.test(value) && /(説明|明確|区別|explain|clear|distinguish)/i.test(value)) tag = 'lapped_car_clarity';
    return tag ? { text: value, tag, source: 'driver_explicit_correction' } : null;
  }

  function observe(store, text, identity, nowMs) {
    const out = Array.isArray(store) ? store.slice() : [];
    const correction = correctionFromDriver(text);
    if (!correction) return { store: out, record: null, proposal: null, reason: 'not_explicit_correction' };
    if (!validIdentity(identity)) return { store: out, record: null, proposal: null, reason: 'identity_unavailable' };
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const terminal = out.filter(r => r && !r.deleted && keyFor(r) === keyFor(identity)
      && r.tags && r.tags[0] === correction.tag && (r.status === 'active' || r.status === 'rejected')).pop();
    if (terminal) return { store: out, record: terminal, proposal: null,
      reason: terminal.status === 'active' ? 'already_active' : 'previously_rejected' };
    const existing = out.filter(r => r && r.status === 'candidate' && !r.deleted
      && keyFor(r) === keyFor(identity) && r.tags && r.tags[0] === correction.tag).pop();
    const record = existing || { version: 2, memory_id: `luna-self|${keyFor(identity)}|${correction.tag}|${now}`,
      userId: identity.userId, track: identity.track, car: identity.car || identity.carClass,
      text: correction.text, tags: [correction.tag], source: correction.source,
      observed_count: 0, observed_session_key: norm(identity.sessionKey),
      recordedAt: new Date(now).toISOString(), status: 'candidate', deleted: false };
    if (existing) {
      const last = Date.parse(existing.lastObservedAt || existing.recordedAt);
      const sameSession = norm(existing.observed_session_key) === norm(identity.sessionKey);
      if (sameSession && Number.isFinite(last) && now - last < MIN_REPEAT_MS) {
        return { store: out, record: existing, proposal: null, reason: 'observation_too_close' };
      }
    }
    record.observed_count = Math.min(2, Number(record.observed_count || 0) + 1);
    record.observed_session_key = norm(identity.sessionKey);
    record.lastObservedAt = new Date(now).toISOString();
    if (!existing) out.push(record);
    while (out.length > MAX_RECORDS) {
      const removable = ['deleted', 'rejected', 'candidate'].map(status => out.findIndex(r => r && r.status === status))
        .find(index => index >= 0);
      out.splice(removable >= 0 ? removable : 0, 1);
    }
    return { store: out, record, proposal: record.observed_count >= 2 ? record : null,
      reason: record.observed_count >= 2 ? 'confirmation_required' : 'candidate_observed' };
  }

  function confirm(store, memoryId, accepted, nowMs) {
    const out = Array.isArray(store) ? store.map(r => r && r.memory_id === memoryId ? {...r} : r) : [];
    const record = out.find(r => r && r.memory_id === memoryId && r.status === 'candidate' && !r.deleted);
    if (!record || Number(record.observed_count) < 2) return { store: out, record: null, reason: 'candidate_unavailable' };
    record.status = accepted === true ? 'active' : 'rejected';
    record.confirmedAt = accepted === true ? new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString() : null;
    return { store: out, record, reason: accepted === true ? 'activated' : 'rejected' };
  }

  function remove(store, memoryId) {
    const out = Array.isArray(store) ? store.map(r => r && r.memory_id === memoryId
      ? {...r, deleted:true, status:'deleted'} : r) : [];
    return { store: out, removed: out.some(r => r && r.memory_id === memoryId && r.deleted) };
  }

  function latest(store, identity, nowMs) {
    if (!Array.isArray(store) || !validIdentity(identity)) return null;
    const wanted = keyFor(identity);
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    return store.filter(r => r && r.version === 2 && !r.deleted && r.status === 'active' &&
      r.source === 'driver_explicit_correction' && Number.isFinite(Date.parse(r.confirmedAt)) &&
      keyFor(r) === wanted && Number.isFinite(Date.parse(r.recordedAt)) &&
      now - Date.parse(r.recordedAt) >= 0 && now - Date.parse(r.recordedAt) <= MAX_AGE_MS)
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt)).pop() || null;
  }

  function briefingLine(record, lang) {
    if (!record || !record.text) return '';
    const ja = String(lang || '').toLowerCase().startsWith('ja');
    if (record.tags && record.tags.includes('gap_accuracy')) {
      return ja ? '前回の反省：GAP精度に課題があった。今回は最新値だけで判断する。'
        : 'My last correction: GAP accuracy was unstable. I will use the latest value only today.';
    }
    if (record.tags && record.tags.includes('fuel_window_proactive')) {
      return ja ? '前回の反省：給油ウィンドウの通知が遅れた。今回は開いた時点で先に伝える。'
        : 'My last correction: the fuel-window call came late. I will call it as soon as it opens.';
    }
    if (record.tags && record.tags.includes('lapped_car_clarity')) {
      return ja ? '前回の訂正：周回遅れと同一周回の車を明確に区別して伝える。'
        : 'My last correction: clearly distinguish lapped cars from same-lap traffic.';
    }
    return '';
  }

  return { correctionFromDriver, observe, confirm, remove, latest, briefingLine, keyFor, validIdentity };
}));
