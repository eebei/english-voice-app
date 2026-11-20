#!/usr/bin/env node
'use strict';
// 戦略の自発コール e2e（実renderer＋jsdom）。Build 308実走(11/15 富士)の再現：
//   ・Driverの「黙っとけ／もうそれ喋らなくていい」で戦略の自発コールが止まる（質問・安全・依頼した通知は止めない）
//   ・提案で「◯番が先に入ると」と仮定を話した相手が、実際に入った（観測／見えなかった間の遅れからの推定）時は、実測の前後と差を短く一度だけ知らせる（確度を区別）
//   ・欠測のまま前後を言わない／別の相手・半周以上離れた相手・既に知らせた相手では言わない
// 実: renderer全体、field_snapshot受信、undercut tracker、speak/finalize。代替: TTS(偽audio)・WebSocket。未検証: 実iRacing・実音声・実LLM。
const H = require('./tests-fullrenderer-harness.js');
const F = require('./desktop/field-snapshot.js');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + n + (ok ? '' : ' -> ' + JSON.stringify(d === undefined ? null : d).slice(0, 700))); ok ? pass++ : fail++; };
const RID = 'sub:PC-1';
let seq = 5000;
function snap(t, cars) {
  const rows = cars.map(c => c.st === 'out' ? { i: c.i, no: c.no, c: 1, r: 'car', p: null, cp: null, l: null, lc: null, d: null, f2: null, est: null, ll: null, pit: null, s: -1, st: 'out' }
    : { i: c.i, no: c.no, c: 1, r: 'car', p: null, cp: null, l: Math.floor(c.prog), lc: Math.floor(c.prog) - 1, d: Math.round((c.prog - Math.floor(c.prog)) * 1e5) / 1e5, f2: 0, est: 0, ll: 100, pit: c.pit ? 1 : 0, s: c.pit ? 1 : 3, st: 'ok' });
  const ob = rows.filter(r => r.st === 'ok').length;
  const s = { type: 'field_snapshot', schema_version: 1, seq: ++seq, race_instance_id: RID, session_num: 2, bridge_process_epoch: 'epoch-a', source_frame_sequence: seq, session_time_s: t, observed_at: Date.now() / 1000,
    player_car_idx: 0, roster_session_num: 2, roster_update: 1, generation: 1, gen: 'consistent', ok: true, sample_interval_s: 1.0, counts: { target: rows.length, observed: ob, departed: rows.length - ob, missing: 0, other: 0 }, events: [], cars: rows };
  const why = F.check(s); if (why) throw new Error('invalid snapshot ' + why);
  return s;
}
const { fixture } = require('./tests-canonical-lifecycle');
let cseq = 0;
async function boot() {
  const h = H.boot({ root: H.ROOT, localStorage: { pw_auth_user: { id: 'u1' }, pw_auth_token: 'tok-u1' }, user: { id: 'u1', isMember: true, displayName: 'T' }, chat: async () => ({ text: 'REPLY。' }) });
  await h.sleep(300);
  h.set('selMode', 'race'); h.set('sel', 'LunaJP'); h.set('iracingLive', true); h.set('bridgeConnected', true); h.set('lastSessionNum', 2); h.set('lastSessionType', 'Race');
  h.set('lastFuelCapacityContext', { effective_fuel_capacity_l: 53, physical_tank_capacity_l: 53 });
  return h;
}
async function tel(h, lap, fuel, pit = false, race = RID) {
  const sock = h.state.sockets[h.state.sockets.length - 1], send = m => sock.onmessage({ data: JSON.stringify(m) });
  if (!h.__c) { send({ type: 'connected', schema_version: 1, bridge_process_epoch: 'epoch-a' }); h.__c = true; }
  const q = ++cseq, s = fixture({ epoch: 'epoch-a', seq: q, frame: 100 + q, race, session: 2, decision: null, lap, proof: null, attempt: null, allowed: false });
  s.current_facts.current_lap = lap; s.current_facts.fuel_level_l = fuel; s.current_facts.on_pit_road = pit; s.continuity.stable_scope = { race_instance_id: race, session_num: 2, driver_id: 7 };
  send(s);
  await h.bridge({ type: 'telemetry_live', lap, fuel, lap_dist_pct: 0.5, pos: 3, class_pos: 3, last: 100, best: 99, driver_pace_median_s: 100, session_time_remaining_s: 1500, gap_ahead: 20, gap_behind: 3, competitors: [], cust_id: 7, session_type: 'Race', session_num: 2,
    track: 'Fuji', car_model: 'GT3', car_class: 'GT3', on_track: true, on_pit_road: pit, race_instance_id: race, bridge_process_epoch: s.bridge_process_epoch, canonical_snapshot_id: s.snapshot_id, canonical_snapshot_sequence: s.snapshot_sequence, source_frame_sequence: s.source_frame.sequence });
  await h.sleep(20);
}
const field = async (h, t, cars) => { await h.bridge(snap(t, cars)); await h.sleep(15); };
const said = h => h.diag(/LunaJP\]/).map(t => t.replace(/^\[LunaJP\]\s*/, ''));
async function finishAudio(h, n = 5) { for (let i = 0; i < n; i++) { await h.sleep(50); for (const a of h.state.audios) { try { a.finish(); } catch (e) {} } } }

(async () => {
  // ═══ 1. Driverの停止依頼 ═══
  {
    const h = await boot();
    await tel(h, 5, 30);
    h.ev("undercutState.proposalKey=null");
    h.ev("speak('次の周に入るのがいい。',{prio:SPEAK_PRIO.P3_STRATEGY,kind:'pit_undercut_proposal',dedupeKey:'x'})");
    ck('1a 通常の発話では停止していない', h.ev('spontaneousMuted()') === false, null);
    await h.say('黙っとけよ。もうピット ないんだよ。');
    ck('1b 「黙っとけよ。もうピットないんだよ」で戦略の自発コールが止まる（DRIVER_MUTEが記録される）', h.ev('spontaneousMuted()') === true && h.diag(/DRIVER_MUTE\] set/).length === 1, h.diag(/DRIVER_MUTE/));
    h.ev("undercutState.proposalLapKey='';undercutState.proposalKey=null");
    h.ev("maybeProposeUndercut({undercut_forecast:{calc_id:'c1',version:1,race:{race_instance_id:'" + RID + "',session_num:2},observed_at:{lap:5},comparable:true,decision:{recommendation:{option_id:'now',pit_lap:5,decide_by_lap:5,stop_required_for_fuel:true},rival_first_threats:[],flips_when:[]},rivals:[],coverage:{clear_claim_allowed:true}}},'lap')");
    ck('1c 停止中はU2の自発提案を話さない（理由=driver_mute が診断に残る）', h.diag(/UNDERCUT_PROPOSAL/).some(t => /driver_mute/.test(t)) && !said(h).some(t => /に入るのがいい/.test(t)), h.diag(/UNDERCUT_PROPOSAL/));
    await finishAudio(h);   // 停止の受領の再生が終わってから次の発話（再生中の入力は待機に回る）
    const u0 = h.diag(/UTTERANCE_FINAL/).length, c0 = h.state.chats.length;
    await h.say('ピットハンター いらないからちょっと黙ってていいよ。燃料 足りるかどうか教え。');   // Ownerの実発話(19:42:03)：停止依頼と質問が一緒
    await finishAudio(h);
    const reply = h.diag(/UTTERANCE_FINAL/).slice(u0).filter(t => !/kind=driver_mute_ack/.test(t));
    ck('1d 停止依頼と質問が一緒でも、質問には何かしら返事が出る（ローカル回答／確認の返事／LLMへ送信のいずれかが、停止の受領とは別に起きる）＝質問を巻き込んで握りつぶさない', reply.length >= 1 || h.state.chats.length > c0, { reply: reply.map(t => t.slice(0, 90)), chats: h.state.chats.length - c0 });
    ck('1d2 停止したことを短く返す（期限と再開の案内つき）：「了解、戦略の提案は止める。また聞きたい時に言って。」', said(h).some(t => /^了解、戦略の提案は止める。また聞きたい時に言って。$/.test(t)) && h.diag(/DRIVER_MUTE\] set/).length >= 1, { said: said(h).slice(-4), log: h.diag(/DRIVER_MUTE/) });
    await finishAudio(h);
    await h.say('また戦略の提案を教えて');
    ck('1e Driverが再開を頼めば解除される', h.ev('spontaneousMuted()') === false && h.diag(/DRIVER_MUTE\] cleared/).length === 1, h.diag(/DRIVER_MUTE/));
    ck('1f JSエラーなし', h.state.errors.length === 0, h.state.errors.slice(0, 3));
  }
  // ═══ 1b. 誤作動の反例（戦略と無関係な「うるさい」「もういい」で止めない）／期限 ═══
  {
    const h = await boot(); await tel(h, 5, 30);
    const bad = ['エンジン音がうるさいな', '周りの車がうるさい', 'タイヤの音がうるさい', '今日は風がうるさいくらい強い', 'ピットの出口は狭いからもういい', 'ここは右コーナーで曲がりやすいのでもういいか', 'ピットの出口はどこ？'];
    const wrong = []; for (const t of bad) { await finishAudio(h, 2); await h.say(t); if (h.ev('spontaneousMuted()')) { wrong.push(t); h.ev('driverMute.active=false'); } }
    ck('1g 戦略と無関係な発話（騒音の「うるさい」・ピット出口の「もういい」・ピット位置の質問）では自発コールを止めない', wrong.length === 0, wrong);
    const good = ['うるさい', 'それもういい', 'その話はもういいよ', 'ピットの話はいらない', '提案はもういい', '喋らなくていいよ', '静かにして', '黙れ'];
    const missed = []; for (const t of good) { await finishAudio(h, 2); await h.say(t); if (!h.ev('spontaneousMuted()')) missed.push(t); h.ev('driverMute.active=false'); }
    ck('1h LUNAの発話に向けた停止依頼（短い「うるさい」・「それもういい」・「ピットの話はいらない」・「静かにして」等）は止まる', missed.length === 0, missed);
    await h.say('黙れ');
    h.set('lastTelemetry', Object.assign({}, h.w.eval('lastTelemetry'), { lap: 60 }));
    ck('1i 期限なし：何周経っても、Driverの再開依頼まで止まったまま（12周自動再開は廃止。12周はピット期限ではない）', h.ev('spontaneousMuted()') === true && h.diag(/DRIVER_MUTE\] cleared expired/).length === 0, h.diag(/DRIVER_MUTE/));
    await finishAudio(h, 2); await h.say('また戦略の提案を教えて');
    ck('1j Driverの再開依頼で解除される', h.ev('spontaneousMuted()') === false && h.diag(/DRIVER_MUTE\] cleared by driver/).length >= 1, h.diag(/DRIVER_MUTE/));
  }
  // ═══ 1c. 停止だけの発話は、受領1回でターンを閉じる（検査Claude R-FW-6）／別raceへ持ち越さない（G9） ═══
  {
    for (const phrase of ['提案はいらない', 'ピットの話はいらない', '黙っとけ', '静かにして', 'もうそれ喋らなくていいからさ']) {
      const h = await boot(); await tel(h, 5, 30); await finishAudio(h, 2);
      const u0 = h.diag(/UTTERANCE_FINAL/).length, k0 = h.diag(/UTTERANCE_FINAL.*outcome=completed/).length, c0 = h.state.chats.length;
      await h.say(phrase); await finishAudio(h, 4);
      const fin = h.diag(/UTTERANCE_FINAL.*outcome=completed/).slice(k0).map(t => (t.match(/kind=(\S+)/) || [])[1]);
      const all = h.diag(/UTTERANCE_FINAL/).slice(u0).map(t => t.match(/tts_text="(.*?)" overlay/)).filter(Boolean).map(m => m[1]);
      ck('1k 「' + phrase + '」：受領は1回だけで、撤回文・LLMの返答・自己記憶の訂正処理が続かない（そのターンを閉じる）', fin.filter(k => k === 'driver_mute_ack').length === 1 && !fin.some(k => k !== 'driver_mute_ack') && h.state.chats.length === c0 && !all.some(t => /撤回|記録は/.test(t)), { fin, chats: h.state.chats.length - c0, all });
    }
    const h = await boot(); await tel(h, 5, 30); await h.say('黙っとけ'); await finishAudio(h, 3);
    ck('1l 停止中に別raceのtelemetryが来たら、停止は引き継がれず解除される（別raceへ持ち越さない）', h.ev('spontaneousMuted()') === true, null);
    await tel(h, 1, 30, false, 'sub:PC-2');
    ck('1m 別raceに入った時点で解除され、DRIVER_MUTEに記録される', h.ev('spontaneousMuted()') === false && h.diag(/DRIVER_MUTE\] cleared race_changed/).length === 1, h.diag(/DRIVER_MUTE/));
  }
  // ═══ 2. 仮定を話した相手が実際に入った時の短い知らせ ═══
  const own = (t, base) => base + (t - 100) / 100;
  async function scenario(kind) {
    const h = await boot(); await tel(h, 9, 30); const base = 9.0;
    // 相手#12(idx1)は自車の0.25周前。ほか#5(idx2)は半周以上前(対象外)
    const cars = (t, r1) => [{ i: 0, no: '27', prog: own(t, base) }, r1, { i: 2, no: '5', prog: base + 0.9 + (t - 100) / 100 }];
    for (let t = 100; t < 110; t++) await field(h, t, cars(t, { i: 1, no: '12', prog: own(t, base) + 0.25 }));
    h.ev("undercutState.proposals.push({lap:9,calc_id:'seed',text:'seed',refs:[{rival_no:'12',car_idx:1,stops_done:0},{rival_no:'5',car_idx:2,stops_done:0}]})");   // 「12番が先に入ると…」と話した直後の状態
    if (kind === 'inferred') {
      for (let t = 110; t < 144; t++) await field(h, t, cars(t, { i: 1, no: '12', st: 'out' }));   // 34秒見えない（ピットレーン上で欠測）
      var mid = said(h).filter(x => /12番/.test(x)).length;
      await field(h, 144, cars(144, { i: 1, no: '12', prog: own(144, base) - 0.015 }));            // 再び見えた：自車の0.015周(≒1.5秒)後ろ。推測位置より約0.27周遅れ
    } else {
      for (let t = 110; t < 116; t++) await field(h, t, cars(t, { i: 1, no: '12', prog: own(t, base) + 0.25, pit: t >= 112 }));   // ピットレーンに入る(観測)
      for (let t = 116; t < 144; t++) await field(h, t, cars(t, { i: 1, no: '12', prog: own(t, base) + 0.25 - (t - 116) * 0.265 / 24, pit: t < 140 }));
      var mid = said(h).filter(x => /12番/.test(x)).length;
      await field(h, 144, cars(144, { i: 1, no: '12', prog: own(144, base) - 0.015 }));
    }
    await finishAudio(h);
    return { h, mid, n: said(h).filter(x => /12番は/.test(x)), others: said(h).filter(x => /5番は/.test(x)) };
  }
  {
    const r = await scenario('inferred');
    ck('2a 見えなくなっている間(欠測)は、前後も「入った」も言わない（欠測のみで停止を断定しない）', r.mid === 0, said(r.h));
    ck('2b 再び見えたら、推定の停止は「入ったようだ」＋実測の前後と差を一文で一度だけ（確度を区別：観測した停止の「入った」とは言わない）', r.n.length === 1 && /^12番は入ったようだ、いま約1\.5秒後ろ。$/.test(r.n[0]), r.n);
    ck('2c 半周以上離れた相手(#5)や、仮定を話していない相手については言わない', r.others.length === 0, r.others);
    ck('2d 診断ログに根拠(basis=inferred・差・前後)が残る', r.h.diag(/PIT_RIVAL_UPDATE\]/).some(t => /"basis":"inferred"/.test(t) && /"side":"後ろ"/.test(t)), r.h.diag(/PIT_RIVAL_UPDATE/));
    await field(r.h, 145, [{ i: 0, no: '27', prog: own(145, 9) }, { i: 1, no: '12', prog: own(145, 9) - 0.015 }, { i: 2, no: '5', prog: 9.9 + 0.45 }]);
    await finishAudio(r.h);
    ck('2e 同じ相手は一度しか知らせない', said(r.h).filter(x => /12番は/.test(x)).length === 1, said(r.h));
    ck('2f JSエラーなし', r.h.state.errors.length === 0, r.h.state.errors.slice(0, 3));
  }
  {
    const r = await scenario('observed');
    ck('2g ピットレーン上を観測した停止は「入った」（「入ったようだ」と推定の言い方にしない）＋実測の前後と差', r.n.length === 1 && /^12番は入った、いま約1\.5秒後ろ。$/.test(r.n[0]), r.n);
  }
  // ═══ 3. 提案を作った時と、音声を始める時の状態を分ける（検査Claude R-FW-5）：待機中に状態が変わったら再生せず、理由を残す ═══
  async function queuedProposal(variant) {
    const h = await boot(); await tel(h, 5, 30);
    h.ev("speak('危険。右に車。',{prio:SPEAK_PRIO.P1_HAZARD,kind:'hazard'})"); await h.sleep(80);   // 最初のaudioを保持＝以降の発話は待機行列
    for (let t = 100; t < 104; t++) await field(h, t, [{ i: 0, no: '27', prog: 5.0 + (t - 100) / 100 }, { i: 1, no: '12', prog: 5.0 - 0.03 + (t - 100) / 100 }]);
    const pkt = "{undercut_forecast:{calc_id:'c9',version:1,race:{race_instance_id:'" + RID + "',session_num:2},observed_at:{lap:5},comparable:true,coverage:{clear_claim_allowed:true},rivals:[{id:'car1',car_idx:1,no:'12',stops_done:0}],decision:{recommendation:{option_id:'now',pit_lap:5,decide_by_lap:5,stop_required_for_fuel:true},rival_first_threats:[{option_id:'next',rival_id:'car1',rival_no:'12',scenario:'pits_now',behind_by_s:1.3}],flips_when:[]}}}";
    h.ev("undercutState.proposalLapKey='';undercutState.proposalKey=null");
    h.ev("maybeProposeUndercut(" + pkt + ",'lap')");
    const queued = h.ev("speakQueue.filter(q=>q.kind==='pit_undercut_proposal').length");
    if (variant === 'rival_stopped') { for (let t = 104; t < 108; t++) await field(h, t, [{ i: 0, no: '27', prog: 5.0 + (t - 100) / 100 }, { i: 1, no: '12', prog: 5.0 + (t - 100) / 100, pit: t < 106 }]); }   // 待機中に#12がピットIN→OUTを観測
    if (variant === 'muted') h.ev("driverMute.active=true;driverMute.raceKey='" + RID + "|2';driverMute.untilLap=99");
    h.state.audios[0].finish(); await finishAudio(h);
    const fin = h.diag(/UTTERANCE_FINAL.*kind=pit_undercut_proposal/).map(t => (t.match(/outcome=(\S+)/) || [])[1]);
    return { h, queued, text: fin.filter(o => o === 'spoken' || o === 'completed'), fin, dropped: h.diag(/UNDERCUT_PROPOSAL_DROPPED/) };
  }
  {
    const a = await queuedProposal('rival_stopped'), b = await queuedProposal('muted'), c = await queuedProposal('stale');
    ck('3a 提案が待機に積まれる（警告の再生中）。話した相手(#12)が待機中に入った(ピットIN→OUT観測)と、音声開始時に破棄され「rival_stopped_since rival=12」が残る（古い「12番が先に入ると」を耳に届けない）', a.queued === 1 && a.text.length === 0 && a.fin.includes('dropped_before_audible') && a.dropped.some(t => /rival_stopped_since rival=12/.test(t)), { queued: a.queued, fin: a.fin, dropped: a.dropped });
    ck('3b 待機中にDriverが停止を頼んだ状態(キューは消さず状態だけ)でも、音声開始時の確認で破棄され「driver_mute」が残る', b.queued === 1 && b.text.length === 0 && b.fin.includes('dropped_before_audible') && b.dropped.some(t => /driver_mute/.test(t)), { queued: b.queued, fin: b.fin, dropped: b.dropped });
    ck('3c どちらでもなくても、計算が更新・古くなっていれば音声開始時に破棄され「stale_calculation」が残る（作った時の状態のまま話さない）', c.queued === 1 && c.text.length === 0 && c.fin.includes('dropped_before_audible') && c.dropped.some(t => /stale_calculation/.test(t)), { queued: c.queued, fin: c.fin, dropped: c.dropped });
  }
  // ═══ 4. 認識範囲の説明（誰を評価していて、誰が見えていないか）：決定論の返答・順位は総合/クラスを区別・連続範囲は言わない ═══
  {
    const h = await boot(); await tel(h, 5, 30); await finishAudio(h, 2);
    const n0 = said(h).length;
    await h.say('誰が見えてないの？'); await finishAudio(h, 3);
    ck('4a 計算結果が無い間は「評価の対象はまだ確認できていない」と答える（捏造しない）。LLMへ回さない', said(h).slice(n0).some(t => /評価の対象はまだ確認できていない/.test(t)) && h.state.chats.length === 0, { said: said(h).slice(n0), chats: h.state.chats.length });
    h.ev("pitCompareState.packet={undercut_forecast:{comparable:true,coverage_detail:{own_position:{overall:15,class:12},evaluated_rivals:[{no:'12',state:'observed',overall:16,class:13},{no:'10',state:'observed',overall:18,class:null}],unassessed_same_class:[{no:'16',state:'unknown',last_seen_age_s:null,overall:null,class:null},{no:'22',state:'dead_reckoned',last_seen_age_s:21,overall:20,class:15}],unassessed_count:2,note:'x'}}}");
    const n1 = said(h).length;
    await finishAudio(h, 2); await h.say('どの車を評価してる？'); await finishAudio(h, 3);
    const r = said(h).slice(n1).join('');
    ck('4b 評価できた相手と評価外を答える：自車=クラス12位、#12(クラス13位)・#10(総合18位＝クラス順位が標本に無い)、評価外は#16(見えていない)・#22(見えていない・21秒前はクラス15位＝最後に見えた時点の順位と何秒前かを添える)。連続範囲は言わない', /自車はクラス12位。/.test(r) && /評価できているのは#12（クラス13位）、#10（総合18位）。/.test(r) && /評価外は#16（見えていない）、#22（見えていない、21秒前はクラス15位）。/.test(r) && /順位の連続範囲は言えない。/.test(r) && !/位まで/.test(r) && h.state.chats.length === 0, { r, chats: h.state.chats.length });
  }
  console.log('\n=== pit calls e2e: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS_ERROR', e); process.exit(2); });
