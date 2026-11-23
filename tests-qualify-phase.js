#!/usr/bin/env node
'use strict';
// 設計§24.16 予選フェーズ別無線：unit（判定・抑制規則・声かけ）＋ 実renderer（実speak／実telemetry入口の関数）通し。
// 代替：TTS/Audio/WebSocket（harness）。未検証：実機のLap増加タイミング、2周計測の本命周、実音声、実走。
const H = require('./tests-fullrenderer-harness.js');
const Q = require('./desktop/qualify-phase.js');
const { fixture } = require('./tests-canonical-lifecycle');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + n + (ok ? '' : ' -> ' + JSON.stringify(d === undefined ? null : d).slice(0, 600))); ok ? pass++ : fail++; };
const F = (o) => ({ on_pit_road: false, on_track: true, lap: 0, ...o });

// ── unit ──
{
  const t = Q.create(); const QS = 'Lone Qualify';
  const ph = (live) => t.update(live, QS);
  ck('U1 ピット内（走行前）＝準備', ph(F({ on_pit_road: true })) === 'prep');
  ck('U2 ピット出口を出た周＝アウトラップ（準備）。遷移理由outlap', ph(F({ lap: 0 })) === 'prep');
  ck('U3 ライン通過後の周＝アタック', ph(F({ lap: 1 })) === 'attack' && t.transition().reason === 'timed_lap');
  ck('U4 複数周回の予選：ライン通過後の2周目・3周目・5周目もアタックのまま（周回数ではアタックを終えない）。遷移なし', ph(F({ lap: 2 })) === 'attack' && t.transition() === null && ph(F({ lap: 3 })) === 'attack' && ph(F({ lap: 5 })) === 'attack' && t.transition() === null);
  ck('U4b スピン・コース外（on_track=false）や残り時間null・欠測でも、アタックのまま（抑制を外さない）', ph(F({ lap: 5, on_track: false })) === 'attack' && ph(F({ lap: 5, session_time_remaining_s: null })) === 'attack' && ph(F({ lap: 6, session_time_remaining_s: 300 })) === 'attack');
  ck('U5 ピットへ戻った時にアタック→終了後（pit_in）。再度出れば新しい走行でアウトラップ（準備）→次の周でアタック。ピット入出を繰り返しても同じ', ph(F({ on_pit_road: true, lap: 6 })) === 'post' && t.transition().from === 'attack' && t.transition().reason === 'pit_in' && ph(F({ lap: 6 })) === 'prep' && ph(F({ lap: 7 })) === 'attack' && ph(F({ on_pit_road: true, lap: 9 })) === 'post' && ph(F({ lap: 9 })) === 'prep');
  for (const st of ['Lone Qualify', 'Lone Qualifying', 'Qualify']) { const x = Q.create(); x.update(F({ on_pit_road: true }), st); x.update(F({ lap: 0 }), st); ck('U5b ' + st + '：単独予選の表記ゆれでも複数周回でアタックを維持し、ピット復帰で終了後', x.update(F({ lap: 1 }), st) === 'attack' && x.update(F({ lap: 4 }), st) === 'attack' && x.update(F({ lap: 4, on_pit_road: true }), st) === 'post'); }
  for (const st of ['Open Qualify', 'open qualifying', 'Practice', 'Offline Testing', 'Race', '', null]) { const x = Q.create(); x.update(F({ on_pit_road: true }), st); x.update(F({ lap: 0 }), st); const a = x.update(F({ lap: 1 }), st); ck('U5d 境界（誤適用防止）：「' + st + '」は単独予選ではない＝フェーズ判定せず（none）、発話も抑制しない', a === 'none' && x.transition() === null && !Q.quietDuring(a, 4, 'radio') && !Q.isSoloQualifying(st), a); }
  const mid = Q.create(); mid.update(F({ lap: 3 }), 'Lone Qualify');
  ck('U5c 途中から観測を始めた時（ピット出口を見ていない）は、アウトラップと断定せず声かけも出さない', mid.phase() === 'prep' && mid.transition() && mid.transition().reason === 'observe_start' && Q.lineFor(mid.transition(), {}, 'jp') === null, mid.transition());
  const r = Q.create(); ck('U6 Raceセッションでは判定しない（none）', r.update(F({ lap: 5 }), 'Race') === 'none');
  const e = Q.create(); e.update(F({ lap: 0 }), QS); e.update(F({ lap: 1 }), QS); ck('U7 セッション残り時間0＝終了後（アタック中でも）', e.update(F({ lap: 2, session_time_remaining_s: 0 }), QS) === 'post');
  const two = Q.create({ attackLaps: 2 }); two.update(F({ lap: 0 }), QS);
  ck('U8 周回数の上限を指定した時だけ：2周までアタック、3周目からpost（既定は上限なし）', two.update(F({ lap: 1 }), QS) === 'attack' && two.update(F({ lap: 2 }), QS) === 'attack' && two.update(F({ lap: 3 }), QS) === 'post');
  ck('U9 抑制規則：アタック中は自発のP3以降だけ捨て、安全P0・危険P1・手順P2・Driverへの返答は通す', Q.quietDuring('attack', 4, 'radio') && Q.quietDuring('attack', 3, 'radio') && !Q.quietDuring('attack', 0, 'radio') && !Q.quietDuring('attack', 1, 'radio') && !Q.quietDuring('attack', 2, 'radio') && !Q.quietDuring('attack', 5, 'reply') && !Q.quietDuring('prep', 4, 'radio') && !Q.quietDuring('post', 4, 'radio'));
  const l1 = Q.lineFor({ from: 'none', to: 'prep', reason: 'outlap' }, { trackTempC: 27.4 }, 'jp');
  const l2 = Q.lineFor({ from: 'none', to: 'prep', reason: 'outlap' }, {}, 'jp');
  ck('U10 アウトラップの声かけ：路面温度は実測がある時だけ。タイヤ温度などの実測できない値は言わない', /路面は27度/.test(l1) && !/路面/.test(l2) && !/タイヤ温度|\d+℃/.test(l1 + l2) && !/撤回|記録/.test(l1 + l2), { l1, l2 });
  ck('U11 走行終了（ピット復帰）の声かけ。「計測ラップ終了」「インラップ」と断定せず、タイム・順位・有効周回は言わない（鮮度・有効性が未確認）', /走行終了/.test(Q.lineFor({ from: 'attack', to: 'post', reason: 'pit_in' }, {}, 'jp')) && !/インラップ|計測ラップ終了|番手|位|\d/.test(Q.lineFor({ from: 'attack', to: 'post', reason: 'pit_in' }, {}, 'jp')));
}

// ── 実renderer ──
(async () => {
  const h = H.boot({ root: __dirname, localStorage: { pw_auth_user: { id: 'u1' }, pw_auth_token: 'tok-u1' }, user: { id: 'u1', isMember: true, displayName: 'T' } });
  await h.sleep(300);
  h.enterRace({ race: 'sub:90286845', track: 'Silverstone Circuit', car: 'Mercedes-AMG GT3 2020' });
  h.set('lastSessionType', 'Lone Qualify'); h.set('voiceOn', true);
  const finals = () => h.diag(/UTTERANCE_FINAL/).filter(t => /outcome=spoken/.test(t)).map(t => (t.match(/tts_text="([^"]*)"/) || [])[1]);
  const settle = async () => { for (let i = 0; i < 4; i++) { await h.sleep(60); for (const a of h.state.audios) { try { a.finish(); } catch (e) {} } } };
  const feed = (o) => h.ev('qualifyPhaseOnTelemetry(' + JSON.stringify({ on_pit_road: false, on_track: true, lap: 0, weather: { track_temp_c: 31.2 }, ...o }) + ')');
  feed({ on_pit_road: true }); await settle();
  feed({ lap: 0 }); await settle();
  ck('E1 アウトラップに入ると、実speak経由で準備の声かけが1回話される（路面温度は実測値）', finals().filter(t => /アウトラップ。路面は31度/.test(t)).length === 1, finals());
  feed({ lap: 1 }); await settle();
  ck('E2 アタックに入った', h.ev('qualifyPhaseNow') === 'attack', h.ev('qualifyPhaseNow'));
  const n0 = finals().length;
  h.ev("speak('ベスト更新。1分23秒456。', {prio: SPEAK_PRIO.P4_INFO, kind: 'radio'})");
  h.ev("speak('ペースダウン。状況は？', {prio: SPEAK_PRIO.P3_INFO, kind: 'radio'})");
  await settle();
  ck('E3 アタック中の非緊急の自発発話（ラップ報告・ペース）は捨てる。アタック後にまとめて流さない', finals().length === n0 && h.diag(/QUALIFY_PHASE.*quiet_drop/).length === 2, { f: finals().slice(n0), d: h.diag(/QUALIFY_PHASE/) });
  h.ev("speak('左に車。', {prio: SPEAK_PRIO.P0_SAFETY, kind: 'radio'})");
  h.ev("speak('いまの路面ならグリップは十分。', true)");
  await settle();
  const after = finals().slice(n0);
  ck('E4 アタック中でも安全コール(P0)とDriverへの返答は話される', after.some(t => /左に車/.test(t)) && after.some(t => /グリップは十分/.test(t)), after);
  feed({ lap: 2 }); await settle();
  ck('E4b 2周目に入っても誤った帰還指示を話さず、アタックの抑制は続く（複数周回）', h.ev('qualifyPhaseNow') === 'attack' && !finals().some(t => /インラップ|走行終了/.test(t)), finals());
  h.ev("speak('ペースダウン。状況は？', {prio: SPEAK_PRIO.P3_INFO, kind: 'radio'})"); await settle();
  ck('E4c 2周目でも非緊急の自発発話は捨てる', !finals().some(t => /ペースダウン/.test(t)), finals());
  feed({ on_pit_road: true, lap: 2 }); await settle();
  ck('E5 ピットへ戻ると「走行終了」の声かけ（終了後）。アタック中に捨てた発話は再生されない', finals().some(t => /走行終了。タイヤと路面を確認/.test(t)) && !finals().some(t => /ベスト更新|ペースダウン/.test(t)), finals());
  h.ev("speak('ベスト更新。1分23秒456。', {prio: SPEAK_PRIO.P4_INFO, kind: 'radio'})"); await settle();
  ck('E6 終了後（ピット内）は通常どおり自発発話を話す', finals().some(t => /ベスト更新/.test(t)), finals());
  // 実入口：Bridge の canonical snapshot と telemetry_live を実 irBridge.onmessage へ流し、実ingestion経由で判定が動く
  {
    const RID = 'sub:90286845'; let cseq = 1000; let connected = true;
    const tel = async ({ lap, pit }) => {
      const sock = h.state.sockets[h.state.sockets.length - 1]; const send = m => sock.onmessage({ data: JSON.stringify(m) });
      if (!connected) { send({ type: 'connected', schema_version: 1, bridge_process_epoch: 'epoch-a' }); connected = true; }
      const seq = ++cseq;
      const sn = fixture({ epoch: 'epoch-a', seq, frame: 500 + seq, race: RID, session: 2, decision: null, lap, proof: null, attempt: null, allowed: false });
      sn.current_facts.current_lap = lap; sn.current_facts.on_pit_road = pit; sn.current_facts.on_track = true;
      sn.continuity.stable_scope = { race_instance_id: RID, session_num: 2, driver_id: 7 };
      send(sn);
      await h.bridge({ type: 'telemetry_live', lap, cust_id: 7, session_type: 'Lone Qualify', session_num: 2, on_track: true, on_pit_road: pit, weather: { track_temp_c: 18 }, race_instance_id: sn.race_instance_id, bridge_process_epoch: sn.bridge_process_epoch,
        canonical_snapshot_id: sn.snapshot_id, canonical_snapshot_sequence: sn.snapshot_sequence, source_frame_sequence: sn.source_frame.sequence });
      await h.sleep(20);
    };
    await tel({ lap: 3, pit: true }); h.set('lastSessionType', 'Lone Qualify'); await tel({ lap: 3, pit: true }); await tel({ lap: 3, pit: false }); await tel({ lap: 4, pit: false });
    ck('E9 実のBridge telemetry入口（canonical＋telemetry_live）から、ピット出口→ライン通過でアタックと判定される', h.ev('qualifyPhaseNow') === 'attack', { ph: h.ev('qualifyPhaseNow'), q: h.diag(/QUALIFY_PHASE/) });
    await tel({ lap: 5, pit: false });
    ck('E10 次の周に入ってもアタックのまま（複数周回）。ピットへ戻ると終了後に変わる', h.ev('qualifyPhaseNow') === 'attack' && (await tel({ lap: 5, pit: true }), h.ev('qualifyPhaseNow') === 'post'), h.ev('qualifyPhaseNow'));
  }
  // 実Bridgeの識別契約：session_info の current_session_authority.session_type をそのまま渡す（名称固定でなく「qualifを含みopenを含まない」）
  {
    const sessionInfo = (num, type) => h.bridge({ type: 'session_info', data: { current_session_authority: { session_num: num, session_type: type, track: 'Silverstone Circuit', car_model: 'GT3' } } });
    await sessionInfo(3, 'Lone Qualifying');
    ck('E11 実session_info（Lone Qualifying）→ lastSessionType → 単独予選として判定が動く', h.ev('lastSessionType') === 'Lone Qualifying' && h.ev('PitwallQualifyPhase.isSoloQualifying(lastSessionType)') === true, h.ev('lastSessionType'));
    feed({ on_pit_road: true }); feed({ lap: 0 }); feed({ lap: 1 }); await settle();
    const nq = finals().length;
    h.ev("speak('ベスト更新。1分23秒456。', {prio: SPEAK_PRIO.P4_INFO, kind: 'radio'})"); await settle();
    ck('E11b 単独予選のアタック中は、非緊急の自発発話を捨てる（実session_info経由）', h.ev('qualifyPhaseNow') === 'attack' && finals().length === nq, { ph: h.ev('qualifyPhaseNow') });
    // セッション切替（単独→単独）：前の走行状態（attack）を持ち越さず、準備から始まる
    await sessionInfo(4, 'Lone Qualify');
    feed({ on_pit_road: true }); await settle();
    ck('E13 セッション切替後の単独予選は準備から始まる（前の走行のattack／postを持ち越さない）', h.ev('qualifyPhaseNow') === 'prep', h.ev('qualifyPhaseNow'));
    // セッション切替：別のセッション（Open予選）へ移ったら、前の走行状態も抑制も持ち越さない
    await sessionInfo(6, 'Open Qualify');
    feed({ lap: 2 }); await settle();
    h.ev("speak('ペースダウン。状況は？', {prio: SPEAK_PRIO.P4_INFO, kind: 'radio'})"); await settle();
    ck('E12 境界（誤適用防止）：明示的なOpen予選にはフェーズ案内も発話制御も適用しない。単独予選のアタック抑制は持ち越さず、通常どおり話す', h.ev('qualifyPhaseNow') === 'none' && finals().some(t => /ペースダウン/.test(t)), { ph: h.ev('qualifyPhaseNow'), f: finals().slice(-2) });
  }
  h.set('lastSessionType', 'Race'); feed({ lap: 5 });
  ck('E7 Raceセッションでは予選の抑制を一切かけない（none）', h.ev('qualifyPhaseNow') === 'none');
  ck('E8 実行中に例外なし', h.state.errors.length === 0, h.state.errors.slice(0, 3));
  console.log('\n=== qualify phase: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS_ERROR', e); process.exit(2); });
