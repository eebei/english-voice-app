(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallRaceMemoryScope = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // WO017：会話・判断記憶のrace-instance境界。
  //
  // 記憶のidentityはBridgeの検証済みcanonical snapshotだけで作る。
  //   race_instance_id … 同じ参加中はP/Q/R・Bridge再起動（epoch）を跨いでも同じ値
  //                      （SubSessionID/SessionID由来）。fallback:は区間ごとのuuidで再識別不能。
  //   driver_id        … stable_scope.driver_id（iRacing cust id）。不明ならnull。
  // epoch・frame・session_numは含めない：再接続や通常frame進行を別raceと決めつけない。
  // 同コース・同車・同SessionNumでもrace_instance_idが違えば別race。
  // 不明（canonical未受信）を既知raceへ推測昇格しない。

  const text = v => typeof v === 'string' && v.length > 0;
  const posInt = v => Number.isInteger(v) && v > 0;

  function scopeFromSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !text(snapshot.race_instance_id)) return null;
    const stable = snapshot.continuity && (snapshot.continuity.stable_scope||snapshot.continuity.custody_scope);
    const driver = stable && stable.race_instance_id === snapshot.race_instance_id && posInt(stable.driver_id)
      ? stable.driver_id : null;
    return { race_instance_id: snapshot.race_instance_id, driver_id: driver };
  }

  function scopeKey(scope) {
    return scope && text(scope.race_instance_id)
      ? scope.race_instance_id + '|' + (posInt(scope.driver_id) ? scope.driver_id : '-') : null;
  }

  // 別raceか。race_instance_idが違う、または両方既知のdriverが違う時だけtrue。
  // 同じraceでdriverが不明→既知になるのは補完であり別raceではない。
  function differentRace(a, b) {
    if (!a || !b) return false;
    if (a.race_instance_id !== b.race_instance_id) return true;
    return posInt(a.driver_id) && posInt(b.driver_id) && a.driver_id !== b.driver_id;
  }

  // 記録が「このrace」のものか。どちらかが不明なら一致と扱わない（fail closed）。
  function sameRace(record, scope) {
    if (!record || !scope || !text(record.race_instance_id) || !text(scope.race_instance_id)) return false;
    if (record.race_instance_id !== scope.race_instance_id) return false;
    const rd = record.driver_id, sd = scope.driver_id;
    return !(posInt(rd) && posInt(sd) && rd !== sd);
  }

  // 最後に検証済みのrace scopeを保持する。TTL切れ・切断ではnullへ戻さない
  // （一時的な欠測を別raceと誤認しない）。別raceが検証された時だけ世代を進める。
  function createTracker() {
    let current = null, generation = 0;
    function observe(snapshot) {
      const next = scopeFromSnapshot(snapshot);
      if (!next) return { changed: false, scope: current, generation };
      const changed = differentRace(current, next);
      if (changed) generation += 1;
      if (!current || changed || (!posInt(current.driver_id) && posInt(next.driver_id))) {
        current = { race_instance_id: next.race_instance_id, driver_id: next.driver_id };
      }
      return { changed, scope: current, generation };
    }
    return {
      observe,
      current: () => (current ? Object.assign({}, current) : null),
      key: () => scopeKey(current),
      generation: () => generation,
      // 会話turnへ付けるtag。誰の（認証本人）・どのraceの会話か。race未確定のturnはraceKey=null。
      tag: ownerRef => ({ ownerRef: text(ownerRef) ? ownerRef : null, raceKey: scopeKey(current), generation }),
    };
  }

  // 現在のLLM会話へ載せてよいturnか。
  //   本人      … 同じ認証本人のturnだけ。本人不明（現在・turnのどちらでも）は載せない
  //   既知raceのturn  … 同じraceの時だけ（A→B→Aで戻ればAの会話は戻る）
  //   race未確定のturn … その後に別raceへ切り替わっていない時だけ（race前の相談は最初のraceへ続く）
  // tag無し（旧形式）は載せない。
  function turnVisible(tag, tracker, ownerRef) {
    if (!tag || typeof tag !== 'object' || !tracker) return false;
    if (!text(ownerRef) || tag.ownerRef !== ownerRef) return false;
    if (tag.raceKey) {
      const key = tracker.key();
      return !!key && !differentRace(parseKey(tag.raceKey), parseKey(key));
    }
    return tag.generation === tracker.generation();
  }
  function parseKey(key) {
    if (!text(key)) return null;
    const [race, driver] = key.split('|');
    const d = Number(driver);
    return { race_instance_id: race, driver_id: posInt(d) ? d : null };
  }

  // 認証本人の比較tag。ログインはuser id、accessコードはSHA-256（先頭128bit）だけを持ち、
  // コード本文は記録しない。どちらも無ければnull（本人不明）。
  function ownerRefFrom(userId, accessCode) {
    if (userId !== null && userId !== undefined && userId !== '') return 'user:' + String(userId);
    if (!text(accessCode)) return null;
    return 'beta:' + sha256Hex(accessCode).slice(0, 32);
  }
  function sha256Hex(str) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const bytes = unescape(encodeURIComponent(String(str))).split('').map(c => c.charCodeAt(0));
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 0xff);
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    const W = new Array(64);
    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i++) {
        W[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  return { scopeFromSnapshot, scopeKey, differentRace, sameRace, createTracker, turnVisible, ownerRefFrom, sha256Hex };
}));
