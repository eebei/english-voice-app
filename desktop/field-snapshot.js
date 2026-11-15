'use strict';
// U1（STR-001／設計§24.14）：全車snapshotの受信側。Bridgeが送る `field_snapshot` を検証して保持する。
//   ・世代が混在（gen!=='consistent' / ok!==true）のsnapshotは「有効な観測」として採用しない（拒否理由を数える）。
//   ・許可リスト方式：知らないキー（個人名・認証値など）を含むsnapshotは丸ごと拒否（fail-closed）。
//   ・同じ (epoch, seq) の重複、同一レース内で古いseqの逆戻りは採用しない。レース/セッション/epochが変わったら保持を捨てる。
//   ・計算（U2〜U4）は別。ここは「受け取れた事実」と「採用してよいか」だけを持つ。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PitwallFieldSnapshot = factory()  // 命名規約: field-snapshot.js → PitwallFieldSnapshot（起動時module診断が見る名前）;
})(typeof self !== 'undefined' ? self : this, function () {
  const SCHEMA_VERSION = 1;
  const TOP_KEYS = ['type', 'schema_version', 'seq', 'race_instance_id', 'session_num', 'bridge_process_epoch', 'source_frame_sequence',
    'session_time_s', 'observed_at', 'player_car_idx', 'roster_session_num', 'roster_update', 'generation', 'gen', 'ok', 'sample_interval_s', 'counts', 'events', 'cars'];
  const CAR_KEYS = ['i', 'no', 'c', 'r', 'p', 'cp', 'l', 'lc', 'd', 'f2', 'est', 'll', 'pit', 's', 'st'];
  const ROLES = ['car', 'pace', 'spec'];
  const COUNT_KEYS = ['target', 'observed', 'departed', 'missing', 'other'];
  const EVENTS = ['start', 'lap', 'pit_in', 'pit_out', 'pit', 'car_join', 'car_leave', 'session_change', 'epoch_change'];
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const isInt = v => Number.isInteger(v);
  const numOrNull = v => v === null || isNum(v);
  const intOrNull = v => v === null || isInt(v);

  // 戻り値：null=有効 / 文字列=拒否理由
  function check(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not_object';
    if (s.type !== 'field_snapshot') return 'wrong_type';
    for (const k of Object.keys(s)) if (!TOP_KEYS.includes(k)) return 'unexpected_field';
    if (s.schema_version !== SCHEMA_VERSION) return 'schema_version';
    if (s.ok !== true || s.gen !== 'consistent') return s.gen === 'mixed' ? 'generation_mixed' : (s.gen === 'unverified' ? 'generation_unverified' : (s.gen === 'identity_stale' ? 'identity_stale' : 'not_ok'));
    if (!isInt(s.seq) || s.seq < 1) return 'bad_seq';
    if (typeof s.race_instance_id !== 'string' || !s.race_instance_id) return 'no_race_identity';
    if (!intOrNull(s.session_num)) return 'bad_session_num';
    if (typeof s.bridge_process_epoch !== 'string' || !s.bridge_process_epoch) return 'no_epoch';
    if (!isInt(s.source_frame_sequence)) return 'bad_frame';
    if (!numOrNull(s.session_time_s) || !isNum(s.observed_at)) return 'bad_time';
    if (!intOrNull(s.player_car_idx)) return 'bad_player';
    // 名簿(ゼッケン/クラス)が当該セッションのものと確認できないsnapshotは採用しない（Bridgeがidentity_staleにするが、受信側でも確かめる）
    if (!intOrNull(s.roster_update)) return 'bad_roster_update';
    if (!isInt(s.roster_session_num) || s.roster_session_num !== s.session_num) return 'identity_stale';
    if (!isNum(s.sample_interval_s) || s.sample_interval_s <= 0) return 'bad_interval';
    const c = s.counts;
    if (!c || typeof c !== 'object') return 'no_counts';
    for (const k of Object.keys(c)) if (!COUNT_KEYS.includes(k)) return 'unexpected_field';
    for (const k of COUNT_KEYS) if (!isInt(c[k]) || c[k] < 0) return 'bad_counts';
    if (!Array.isArray(s.events) || s.events.some(e => !EVENTS.includes(e))) return 'bad_events';
    if (!Array.isArray(s.cars)) return 'no_cars';
    if (s.cars.some(x => x && typeof x === 'object' && !ROLES.includes(x.r))) return 'bad_role';
    const competitors = s.cars.filter(x => x && x.r === 'car').length;
    if (c.target !== competitors || c.other !== s.cars.length - competitors || c.observed + c.departed + c.missing !== c.target) return 'counts_mismatch';
    const seen = new Set();
    let ob = 0, de = 0, mi = 0;
    for (const car of s.cars) {
      if (!car || typeof car !== 'object') return 'bad_car';
      for (const k of Object.keys(car)) if (!CAR_KEYS.includes(k)) return 'unexpected_field';
      if (!isInt(car.i) || car.i < 0 || car.i > 63 || seen.has(car.i)) return 'bad_car_idx';
      seen.add(car.i);
      if (!(car.no === null || typeof car.no === 'string') || !intOrNull(car.c)) return 'bad_car_id';
      if (!ROLES.includes(car.r)) return 'bad_role';
      if (!['ok', 'missing', 'out'].includes(car.st)) return 'bad_state';
      for (const k of ['p', 'cp', 'l', 'lc', 's']) if (!intOrNull(car[k])) return 'bad_car_value';
      for (const k of ['d', 'f2', 'est', 'll']) if (!numOrNull(car[k])) return 'bad_car_value';
      if (!(car.pit === null || car.pit === 0 || car.pit === 1)) return 'bad_car_value';
      if (car.d !== null && (car.d < 0 || car.d > 1)) return 'bad_car_value';
      if (car.st === 'out' && (car.p !== null || car.l !== null || car.d !== null || car.pit !== null)) return 'out_car_has_values';
      if (car.r === 'car') { if (car.st === 'out') de++; else if (car.st === 'missing') mi++; else ob++; }   // 件数は競技車だけ
    }
    if (ob !== c.observed || de !== c.departed || mi !== c.missing) return 'counts_mismatch';
    return null;
  }

  function createReceiver() {
    const st = { latest: null, identity: null, lastSeq: 0, received: 0, accepted: 0, rejected: {}, duplicates: 0, resets: 0, lastRejectReason: null };
    const idOf = s => [s.race_instance_id, s.session_num, s.bridge_process_epoch].join('|');
    function reject(reason) { st.rejected[reason] = (st.rejected[reason] || 0) + 1; st.lastRejectReason = reason; return { accepted: false, reason }; }
    return {
      receive(msg) {
        st.received++;
        let reason = null;
        try { reason = check(msg); } catch (_) { reason = 'check_failed'; }
        if (reason) return reject(reason);
        const id = idOf(msg);
        if (st.identity !== null && id !== st.identity) st.resets++;   // 別レース/セッション/epoch：seqは新しい系列（Bridge再起動でseqは1に戻る）
        if (msg.seq <= st.lastSeq && id === st.identity) { st.duplicates++; return reject(msg.seq === st.lastSeq ? 'duplicate_seq' : 'stale_seq'); }
        st.identity = id; st.lastSeq = msg.seq; st.latest = msg; st.accepted++;
        return { accepted: true, reason: null };
      },
      // expect を渡すと、保持中のsnapshotが「いま見ているレース/セッション」のものか・古すぎないかを確かめ、合わなければ null。
      //   （新しいセッションのsnapshotが全部拒否されている間に、前のセッションの全車情報を誤って使わないため）
      current(expect) {
        const s = st.latest; if (!s) return null;
        if (expect) {
          if (expect.race_instance_id !== undefined && s.race_instance_id !== expect.race_instance_id) return null;
          if (expect.session_num !== undefined && s.session_num !== expect.session_num) return null;
          if (isNum(expect.max_age_s) && isNum(expect.now_s) && expect.now_s - s.observed_at > expect.max_age_s) return null;
        }
        return s;
      },
      stats() { return { received: st.received, accepted: st.accepted, rejected: Object.assign({}, st.rejected), rejected_total: Object.values(st.rejected).reduce((a, b) => a + b, 0), duplicates: st.duplicates, resets: st.resets, last_reject_reason: st.lastRejectReason, last_seq: st.lastSeq }; },
    };
  }

  // JSONLログ（Bridgeが書いた記録）を読み戻す。ヘッダ/marker/snapshotを分ける。壊れた行は数えて飛ばす。
  function parseLog(text) {
    const out = { header: null, snapshots: [], markers: [], bad_lines: 0 };
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trim(); if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (_) { out.bad_lines++; continue; }
      if (o && o.type === 'field_log_header') out.header = o;
      else if (o && o.type === 'field_log_marker') out.markers.push(o);
      else if (o && o.type === 'field_snapshot') out.snapshots.push(o);
    }
    return out;
  }

  return { SCHEMA_VERSION, check, createReceiver, parseLog };
});
