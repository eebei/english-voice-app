#!/usr/bin/env node
'use strict';
// 給油ウィンドウの監視 e2e（実renderer.html＋jsdom）。Build 308実走の再現：
//   「ウィンドウが開いたら教えて」→受領→（監視登録）→戦略案が更新されても保持→条件成立→一度だけ発話→再生確定(spoken)。
//   待機中に破棄されたら有効な間だけ再配送／ピット完了で旧提案・待機音声を失効し、実残量から再計算。
// 実: renderer全体、local-intent-router、speak/drainQueue/finalizeUtterance、fuel-window、undercut-forecast（own_stop_done）
// 代替: TTS(偽audio)、WebSocket、時計。未検証: 実iRacing・実Bridge・実Electron・実音声・実LLM。
const H = require('./tests-fullrenderer-harness.js');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + n + (ok ? '' : ' -> ' + JSON.stringify(d === undefined ? null : d).slice(0, 700))); ok ? pass++ : fail++; };
const RID = 'sub:FW-1';
async function boot(warm = true, holdFirstAudio = false, cap = 25) {
  const h = H.boot({ audioPlay: holdFirstAudio ? ((a, st) => (st.audios.length === 1 ? new Promise(() => {}) : Promise.resolve())) : undefined, root: H.ROOT, localStorage: { pw_auth_user: { id: 'u1' }, pw_auth_token: 'tok-u1' }, user: { id: 'u1', isMember: true, displayName: 'T' }, chat: async () => ({ text: 'REPLY。' }) });
  await h.sleep(300);
  h.set('selMode', 'race'); h.set('sel', 'LunaJP'); h.set('iracingLive', true); h.set('bridgeConnected', true);
  h.set('lastSessionNum', 2); h.set('lastSessionType', 'Race');
  h.set('lastFuelCapacityContext', { effective_fuel_capacity_l: cap, physical_tank_capacity_l: cap });
  h.set('fuelWindowMarginL', 3);   // 手計算の数値を固定するため、余裕はLで直接設定（既定=1周分の換算はシナリオ10で検査）
  if (warm) { await tel(h, { lap: 3, fuel: 18, crossings: 14, pct: 0.1 }); await tel(h, { lap: 4, fuel: 16, crossings: 13, pct: 0.1 }); }   // 燃費(Lapごとの残燃料の減少2.0L)を観測させる
  return h;
}
const { fixture } = require('./tests-canonical-lifecycle');
let cseq = 0;
// Bridge権威の現在値(canonical)を、実 irBridge.onmessage へ流す：lap・残燃料・周回内位置・S/F通過回数・ピット状態。続けて同じ値のtelemetry_live。
async function tel(h, { lap, fuel, pct = 0.5, burn = 2.0, crossings, pit = false, race = RID, last = 90 }) {
  const sock = h.state.sockets[h.state.sockets.length - 1];
  const send = m => sock.onmessage({ data: JSON.stringify(m) });
  if (!h.__connected) { send({ type: 'connected', schema_version: 1, bridge_process_epoch: 'epoch-a' }); h.__connected = true; }
  const seq = ++cseq;
  const s = fixture({ epoch: 'epoch-a', seq, frame: 100 + seq, race, session: 2, decision: null, lap, proof: null, attempt: null, allowed: false });
  s.current_facts.current_lap = lap; s.current_facts.fuel_level_l = fuel; s.current_facts.lap_dist_pct = pct; s.current_facts.on_pit_road = pit;
  s.finish.remaining_after_current = crossings - 1; s.finish.remaining_sf_crossings = crossings;
  s.continuity.stable_scope = { race_instance_id: race, session_num: 2, driver_id: 7 };
  send(s);
  await h.bridge({ type: 'telemetry_live', lap, fuel, lap_dist_pct: pct, pos: 3, class_pos: 3, last, best: 89, driver_pace_median_s: 90, session_time_remaining_s: 1500, gap_ahead: 20, gap_behind: 3, competitors: [],
    cust_id: 7, session_type: 'Race', session_num: 2, track: 'Suzuka', car_model: 'GT3', car_class: 'GT3', on_track: true, on_pit_road: pit, race_instance_id: s.race_instance_id, bridge_process_epoch: s.bridge_process_epoch,
    canonical_snapshot_id: s.snapshot_id, canonical_snapshot_sequence: s.snapshot_sequence, source_frame_sequence: s.source_frame.sequence });
  await h.sleep(20);
}
const spoken = h => h.diag(/LunaJP\]/).map(t => t.replace(/^\[LunaJP\]\s*/, ''));
const watchLog = h => h.diag(/FUEL_WINDOW_WATCH/);
async function finishAudio(h, n = 6) { for (let i = 0; i < n; i++) { await h.sleep(60); for (const a of h.state.audios) { try { a.finish(); } catch (e) {} } } }
const state = h => JSON.parse(h.ev('JSON.stringify({armed:fuelWindowWatch.armed,announced:fuelWindowWatch.announced,delivery:fuelWindowWatch.delivery||null,released:fuelWindowWatch.releasedReason||null,race:fuelWindowWatch.raceKey||null,pit:ownPitObserver.completions})'));

(async () => {
  // ═══ 1. 閉じている間に依頼 → 受領 → 戦略案が更新されても保持 → 成立 → 一度だけ発話 → spoken ═══
  {
    const h = await boot();
    await tel(h, { lap: 5, fuel: 14, crossings: 12 });          // 目標=2×12+3=27L > 容量25L → あと1周で開く
    await h.say('給油ウィンドウが開いたら教えて');
    const st0 = state(h), ack = spoken(h).join('');
    ck('1a 閉じている間の依頼：受領は「あと約N周で開く。開いたら一度だけ呼ぶ」。監視が実際に登録されている', st0.armed === true && /あと約1周で開く/.test(ack) && /一度だけ呼ぶ/.test(ack) && st0.race === RID + '|2', { st0, ack });
    // 戦略案(canonical)の識別子・revisionが毎frame変わる＝Build 308で監視が黙って解除された条件
    for (let k = 0; k < 4; k++) { h.raceSnap({ race: RID, driver: 7, frame: 20 + k, lap: 5, fuel: 14, decision: null }); }
    await tel(h, { lap: 5, fuel: 13, crossings: 12 });
    ck('1b 戦略案のrevision・frameが更新されても監視は保持される（旧実装は黙って解除した）', state(h).armed === true && !state(h).released, state(h));
    await tel(h, { lap: 6, fuel: 11, crossings: 11, pct: 0.1 });   // 目標=2×11+3=25L ≦ 容量25L → 開く
    await h.sleep(150);
    const st1 = state(h);
    ck('1c 条件成立で発話が決定される（decided attempt=1。追加量つき）。確定は再生確定(spoken)で行う', st1.delivery && st1.delivery.attempts === 1 && watchLog(h).some(t => /decided attempt=1 add_l=\d+\.\d required_l=22 margin_l=3/.test(t)), { st1, log: watchLog(h) });
    await finishAudio(h);
    const st2 = state(h), said2 = spoken(h).filter(t => /給油ウィンドウが開いた/.test(t));
    ck('1d 実再生が確定して初めて通知済み(announced)になり、監視は閉じる。発話は一度だけ・一文・追加量つき', st2.announced === true && st2.armed === false && said2.length === 1 && /追加約\d+\.\dLで完走できる/.test(said2[0]) && watchLog(h).some(t => /delivered\(spoken\)/.test(t)), { st2, said2, log: watchLog(h) });
    await tel(h, { lap: 7, fuel: 9, crossings: 10, pct: 0.1 }); await finishAudio(h);
    ck('1e 通知後は繰り返さない（次のLapでも同じ通知を出さない）', spoken(h).filter(t => /給油ウィンドウが開いた/.test(t)).length === 1, spoken(h));
    ck('1f JSエラーなし', h.state.errors.length === 0, h.state.errors.slice(0, 3));
  }
  // ═══ 2. 既に開いている時の依頼 → その場で回答（監視は登録しない）／登録できない時に「呼ぶ」と言わない ═══
  {
    const h = await boot();
    await tel(h, { lap: 5, fuel: 14, crossings: 12 }); await tel(h, { lap: 6, fuel: 11, crossings: 11, pct: 0.1 });
    await h.say('ウィンドウが開いたら教えて');
    const say = spoken(h).join(''), st = state(h);
    ck('2a 既に開いている：その場で「もう開いている。いま入れば完走できる。追加は…（必要＋余裕）」と答え、監視は登録しない', /もう開いている/.test(say) && /追加は約\d+\.\dL/.test(say) && /必要\d+\.\dL＋余裕\d\.\dL/.test(say) && st.armed === false, { say, st });
    const h2 = await boot(false);
    await h2.say('ウィンドウが開いたら教えて');
    ck('2b 走行データが無い時は監視を登録せず、「呼ぶ」とも言わない（登録できないのに受領しない）', state(h2).armed === false && !/一度だけ呼ぶ/.test(spoken(h2).join('')), { say: spoken(h2), st: state(h2) });
  }
  // ═══ 3. 発話待ちで破棄されたら、有効な間は再配送（announced=trueを先に立てない）。警告(P1)の再生中に待たされる＝「警告に譲った」場合 ═══
  {
    const h = await boot(true, true);
    h.ev("speak('危険。右に車。',{prio:SPEAK_PRIO.P1_HAZARD,kind:'hazard'})");   // 最初のaudioを再生中のまま保持＝以降の発話は待機行列に積まれる
    await h.sleep(80);
    await tel(h, { lap: 5, fuel: 14, crossings: 12 });
    await h.say('ウィンドウが開いたら教えて');
    await tel(h, { lap: 6, fuel: 11, crossings: 11, pct: 0.1 });
    const q1 = h.ev("speakQueue.filter(q=>q.kind==='fuel_window_watch').length");
    ck('3-0 警告の再生中は通知が待機行列で待つ（P1に譲る）。この時点では通知済みにしない', q1 === 1 && state(h).announced === false && state(h).delivery.state === 'pending', { q1, st: state(h) });
    h.ev("invalidateQueuedSpeech(['fuel_window_watch'],'test_drop')");   // 待機中に破棄された（別話題・中断・古さによる取りこぼしの代表）
    await h.sleep(60);
    const s1 = state(h);
    ck('3a 待機中に破棄された：通知済みにならず(announced=false)、監視は有効のまま（発話確定前に立てない）', s1.announced === false && s1.armed === true && s1.delivery.state === 'idle' && watchLog(h).some(t => /not_delivered outcome=dropped_before_audible/.test(t)), { s1, log: watchLog(h) });
    await h.sleep(4300); await tel(h, { lap: 6, fuel: 10.5, crossings: 11, pct: 0.3 });
    ck('3b 有効なうちに再配送される（attempt=2・また待機行列で警告に譲って待つ）', state(h).delivery.attempts === 2 && state(h).delivery.state === 'pending', state(h));
    h.state.audios[0].finish(); await finishAudio(h);   // 警告の再生が終わる→待っていた通知が再生される
    const s2 = state(h);
    ck('3c 警告が終わった後、有効なうちに配送され、再生確定で通知済みになる。通知は一度だけ', s2.announced === true && s2.armed === false && spoken(h).filter(t => /給油ウィンドウが開いた/.test(t)).length === 1, { s2, say: spoken(h) });
  }
  // ═══ 4. 待機中に条件が古くなったら、再生直前の確認(precheck)が最新の燃料条件で false を返す ═══
  {
    const h = await boot();
    await tel(h, { lap: 5, fuel: 14, crossings: 12 });
    await h.say('ウィンドウが開いたら教えて');
    await tel(h, { lap: 6, fuel: 11, crossings: 11, pct: 0.1 });   // 成立（このharnessの偽audioは即再生確定するので、確定後に有効性関数だけを確かめる）
    h.set('fuelWindowWatch', Object.assign({}, h.w.eval('fuelWindowWatch'), { armed: true, announced: false }));
    ck('4a 有効性の確認は現在の燃料条件で行う：成立中はtrue', h.ev('fuelWindowWatchStillValid()') === true, null);
    h.set('lastFuelCapacityContext', { effective_fuel_capacity_l: 20 });
    ck('4b 条件が古くなった（容量20Lでは目標25Lが収まらない）ら false＝再生直前に破棄され、古い「開いた」を耳に届けない', h.ev('fuelWindowWatchStillValid()') === false, null);
    h.set('lastFuelCapacityContext', { effective_fuel_capacity_l: 25 });
    h.ev("fuelWindowWatch.pitCompletions=-1");
    ck('4c ピット完了後(完了回数が変わった)は、成立していても false', h.ev('fuelWindowWatchStillValid()') === false, null);
  }
  // ═══ 5. 取消し／別race／セッション終了で解除 ═══
  {
    const h = await boot();
    await tel(h, { lap: 5, fuel: 14, crossings: 12 });
    await h.say('ウィンドウが開いたら教えて');
    await h.say('ウィンドウのコールはやめて');
    ck('5a Driverの取消しで解除される（取消しの受領も返る）', state(h).armed === false && /取り消した/.test(spoken(h).join('')), { st: state(h), say: spoken(h) });
    const h2 = await boot();
    await tel(h2, { lap: 5, fuel: 14, crossings: 12 }); await h2.say('開いたら教えて');
    await tel(h2, { lap: 1, fuel: 24, crossings: 12, race: 'sub:OTHER' });
    ck('5b 別raceに入ったら監視は失効する（前のraceの監視が別のレースで鳴らない）', state(h2).armed === false && !spoken(h2).some(t => /給油ウィンドウが開いた/.test(t)), state(h2));
  }
  // ═══ 6. 給油（ピット完了）：監視解除・旧提案/待機音声の失効・実残量で再計算・同じ提案を繰り返さない ═══
  {
    const h = await boot(true, true);
    await tel(h, { lap: 5, fuel: 14, crossings: 12 });
    await h.say('ウィンドウが開いたら教えて');
    h.ev("speak('危険。右に車。',{prio:SPEAK_PRIO.P1_HAZARD,kind:'hazard'})"); await h.sleep(80);     // 再生を保持＝以降は待機行列
    h.ev("speak('旧い給油提案。追加約3.2L',{prio:SPEAK_PRIO.P3_STRATEGY,kind:'pit_undercut_proposal',dedupeKey:'old-proposal'})");
    await tel(h, { lap: 5, fuel: 13.5, crossings: 12, pct: 0.8 });                // 閉じたまま（目標27L＞容量25L）
    await tel(h, { lap: 5, fuel: 13.3, crossings: 12, pct: 0.97, pit: true });    // ピット入り
    await tel(h, { lap: 5, fuel: 13.3, crossings: 12, pct: 0.99, pit: true });    // ピットレーン滞在（3標本以上でノイズではない）
    await tel(h, { lap: 6, fuel: 25, crossings: 11, pct: 0.02, pit: true });      // 給油して満タン
    const before = state(h);
    await tel(h, { lap: 6, fuel: 24.8, crossings: 11, pct: 0.05, pit: false });   // ピット出口：完了
    await h.sleep(100);
    const st = state(h), qd = h.diag(/OWN_PIT_COMPLETED/);
    ck('6a ピット完了(on→off)を数え、閉じたまま待っていた監視は pit_completed で解除される', before.pit === 0 && before.armed === true && st.pit === 1 && st.armed === false && st.released === 'pit_completed', { before, st });
    ck('6b ピット完了で、待機中の旧提案の音声が失効する（queued_dropped≧1）', qd.some(t => /queued_dropped=[1-9]/.test(t)) && h.ev("speakQueue.filter(q=>q.kind==='pit_undercut_proposal').length") === 0, qd);
    h.state.audios[0].finish(); await tel(h, { lap: 6, fuel: 24.6, crossings: 11, pct: 0.1 }); await finishAudio(h);
    const post = spoken(h).filter(t => /給油完了|足りない/.test(t));
    ck('6c 出口の最初の標本の実残量(24.8L・消費2.0L/周×11)から計算し直し、新しい結論を一文で伝える：「給油完了、このままゴールまで足りる（余裕約2.8L）」', post.length === 1 && /給油完了、このままゴールまで足りる（余裕約2\.8L）/.test(post[0]) && (post[0].match(/。/g) || []).length === 1, post);
    ck('6d 旧い提案文（追加約3.2L）は再生されない', !spoken(h).some(t => /旧い給油提案/.test(t)), spoken(h));
    await tel(h, { lap: 7, fuel: 22.6, crossings: 10, pct: 0.1 }); await tel(h, { lap: 8, fuel: 20.6, crossings: 9, pct: 0.1 }); await finishAudio(h);
    ck('6e 給油後は同じ結論を繰り返さない（変化が無い間は黙る）', spoken(h).filter(t => /給油完了|足りない/.test(t)).length === 1, spoken(h));
  }
  {
    const h = await boot();
    await tel(h, { lap: 5, fuel: 14, crossings: 12, pct: 0.1 }); await tel(h, { lap: 6, fuel: 12, crossings: 11, pct: 0.1 });
    await tel(h, { lap: 6, fuel: 3, crossings: 11, pct: 0.97, pit: true });
    await tel(h, { lap: 6, fuel: 3, crossings: 11, pct: 0.99, pit: true });
    await tel(h, { lap: 7, fuel: 14, crossings: 10, pct: 0.02, pit: true });
    await tel(h, { lap: 7, fuel: 14, crossings: 10, pct: 0.05, pit: false });
    await tel(h, { lap: 7, fuel: 13.8, crossings: 10, pct: 0.1, pit: false }); await finishAudio(h);
    const t = spoken(h).filter(x => /給油完了|足りない/.test(x));
    ck('6f 給油しても足りない時（出口の最初の標本14L・消費2.0×10＝20L）：「給油後でも約6.0L足りない、もう一度入る必要がある」と新しい不足根拠で伝える', t.length === 1 && /約6\.0L足りない/.test(t[0]) && /もう一度入る/.test(t[0]), t);
  }
  // ═══ 7. 発進（ピットボックスからのスタート）を完了と数えない ═══
  {
    const h = await boot();
    await tel(h, { lap: 1, fuel: 25, crossings: 12, pct: 0.0, pit: true });
    await tel(h, { lap: 1, fuel: 25, crossings: 12, pct: 0.01, pit: false });
    ck('7a 最初の観測がpit=true（ピットボックスからのスタート）の発進は、給油を伴うピット完了として数えない（1標本・給油なし＝ノイズ/通過）', state(h).pit === 0 && h.diag(/OWN_PIT_NOISE/).length === 1, { st: state(h), log: h.diag(/OWN_PIT/) });
  }
  // ═══ 7b. 給油の事実を確かめてから「給油完了」（検査Claude R-FW-4）：ノイズ・ドライブスルー・給油なしの通過 ═══
  {
    const mk = async () => { const h = await boot(); await tel(h, 5, 14, { crossings: 12 }); await h.say('ウィンドウが開いたら教えて'); return h; };
    const hN = await mk();
    await tel(hN, { lap: 5, fuel: 13.5, crossings: 12, pct: 0.9, pit: true }); await tel(hN, { lap: 5, fuel: 13.4, crossings: 12, pct: 0.91, pit: false }); await finishAudio(hN);
    ck('7b 1標本だけの on_pit_road=true（ノイズ）は完了と数えない：監視は保持・失効なし・「給油完了」を言わない（OWN_PIT_NOISE）', state(hN).pit === 0 && state(hN).armed === true && hN.diag(/OWN_PIT_NOISE/).length === 1 && !spoken(hN).some(t => /給油完了|足りない、もう一度/.test(t)), { st: state(hN), say: spoken(hN) });
    const hD = await mk();
    for (const f of [13.3, 13.2, 13.1]) await tel(hD, { lap: 5, fuel: f, crossings: 12, pct: 0.97, pit: true });   // 3標本以上いたが残量は増えない（ドライブスルー／ペナルティ等）
    await tel(hD, { lap: 6, fuel: 13.0, crossings: 11, pct: 0.05, pit: false }); await finishAudio(hD);
    ck('7c 給油を確認できない通過（残量が増えない）は「給油」とは扱わない：完了回数0・通過1。監視・見込みは保持。「給油完了」を言わない（OWN_PIT_PASSED）', state(hD).pit === 0 && hD.ev('ownPitObserver.passes') === 1 && state(hD).armed === true && hD.diag(/OWN_PIT_PASSED/).length === 1 && !spoken(hD).some(t => /給油完了|足りない、もう一度/.test(t)), { st: state(hD), pass: hD.ev('ownPitObserver.passes'), say: spoken(hD) });
    const hS = await mk();
    for (const f of [13.3, 13.5, 13.6]) await tel(hS, { lap: 5, fuel: f, crossings: 12, pct: 0.97, pit: true });   // 増加が0.5L未満(0.3L)＝給油とは言えない
    await tel(hS, { lap: 6, fuel: 13.6, crossings: 11, pct: 0.05, pit: false });
    ck('7d 入庫→出庫の増加が0.5L未満(0.3L)なら給油と扱わない（境界）。0.5L以上なら給油（上のシナリオ6）', hS.ev('ownPitObserver.completions') === 0 && hS.ev('ownPitObserver.passes') === 1, { c: hS.ev('ownPitObserver.completions'), p: hS.ev('ownPitObserver.passes') });
  }
  // ═══ 8. 4周目の見込み：予告→見込み不変で無音→判断が変わる移動で更新→開通時に給油量つきで一度通知 ═══
  {
    const h = await boot(false, false, 36);   // 容量36L・燃費1.0L/周・チェッカーまで通過 40−Lap 回（4周目で36回）
    const fcSay = () => spoken(h).filter(t => /見込み/.test(t));
    const T = (lap, fuel, crossings, extra) => tel(h, Object.assign({ lap, fuel, crossings, pct: 0.05, last: 90 }, extra || {}));
    await T(1, 36, 39, { last: null }); await T(2, 35, 38); await T(3, 34, 37);
    ck('8a 3周目まで（安定3周が揃う前）は見込みを言わない', fcSay().length === 0, spoken(h));
    await T(4, 33, 36); await finishAudio(h);
    const f1 = fcSay();
    ck('8b 4周目の入口で、燃費の出所つきの一文で「7周目に開く見込み」を一度伝える（目標=1.0×36+3=39L＞容量36L→あと3周）', f1.length === 1 && f1[0] === '燃費の実測3周から給油ウィンドウは7周目に開く見込み。', f1);
    await h.say('ウィンドウが開いたら教えて');
    await T(5, 32, 37);   // 通過回数が+2に跳ねる（時間制のペース低下で完走周回が増えた想定）：あと4周→9周目に変わる見込み（1回目＝まだ伝えない）
    ck('8c 判断が変わりそうな移動でも、1回だけ(一時的なぶれ)では伝えない', fcSay().length === 1, spoken(h));
    await T(6, 31, 36); await finishAudio(h);
    const f2 = fcSay();
    ck('8d 2回続けて同じ新しい値(9周目)になった周で、Driverの判断が変わる移動として一度伝える：「見込み更新、9周目に後ろ倒し」', f2.length === 2 && f2[1] === '見込み更新、給油ウィンドウは9周目に後ろ倒し。', f2);
    await T(7, 30, 35); await T(8, 29, 34); await finishAudio(h);
    ck('8e 見込みが変わらない周(7・8周目)は無音（同じ結論を繰り返さない）', fcSay().length === 2, fcSay());
    await T(9, 28, 33); await finishAudio(h);
    const op = spoken(h).filter(t => /給油ウィンドウが開いた/.test(t));
    ck('8f 実際に開いた時(9周目＝見込みどおり)は、その時点の追加給油量つきで一度だけ通知（事前見込みとは別の発話）', op.length === 1 && /追加約\d+\.\dLで完走できる/.test(op[0]) && state(h).announced === true, { op, st: state(h) });
    ck('8g 事前見込みはBOX指示・給油設定にしない：見込みの発話は戦略bindingを持たず、Plan・給油設定は変更されない', h.ev("JSON.stringify(typeof driverPlanCommandOutbox!=='undefined'?driverPlanCommandOutbox.size:0)") === '0' && h.diag(/FUEL_FORECAST/).every(t => !/set_fuel|box_call/.test(t)), null);
    const logs = h.diag(/FUEL_FORECAST/);
    ck('8h 採否理由が毎周ログに残る（採用Lap・除外Lap:理由・燃費・見込み周）', logs.some(t => /"accepted":\[1,2,3\]/.test(t) && /"open_lap":7/.test(t)), logs.slice(0, 3));
    const nF = fcSay().length;
    await T(9, 27.5, 33, { pct: 0.97, pit: true }); await T(9, 27.5, 33, { pct: 0.99, pit: true }); await T(10, 36, 32, { pit: true }); await T(10, 35.9, 32, { pit: false });   // 給油（ピット完了）
    await T(11, 34.9, 45); await T(12, 33.9, 44); await finishAudio(h);                                                        // 給油後に、もし旧い仕組みなら「開く見込み」が出る条件(通過回数が多い＝閉じている)
    ck('8j 給油後は旧い見込みを音声まで失効させ、新しい見込みを出さない（給油後は実残量からの再計算だけ）', fcSay().length === nF, fcSay());
    ck('8i JSエラーなし', h.state.errors.length === 0, h.state.errors.slice(0, 3));
  }
  // ═══ 9. 減速・黄旗の周が混ざっても、誤って早く開く見込みを出さない ═══
  {
    const h = await boot(false, false, 36);
    const T = (lap, fuel, crossings, extra) => tel(h, Object.assign({ lap, fuel, crossings, pct: 0.05, last: 90 }, extra || {}));
    await T(1, 36, 39, { last: null }); await T(2, 35.0, 38, { last: 90 }); await T(3, 34.7, 37, { last: 170 }); await T(4, 34.4, 36, { last: 172 }); await finishAudio(h);
    const lg = h.diag(/FUEL_FORECAST/).map(t => { try { return JSON.parse(t.replace(/^\[FUEL_FORECAST\]\s*/, '')); } catch { return null; } }).filter(Boolean);
    const l4 = lg.find(x => x.lap === 4);
    ck('9a 長い減速の周(消費0.3L・周回170s前後)は slow_lap として除外され、採用は1周だけ。0.3L/周を燃費にして「もう開いている」と誤判定しない（state≠open）。安定3周が無いので「暫定」と明示し、Bridgeの燃費(1.0L)で7周目と見込む', l4 && l4.rejected.some(r => /^2:slow_lap/.test(r)) && l4.rejected.some(r => /^3:slow_lap/.test(r)) && l4.accepted.length === 1 && l4.state === 'waiting' && l4.provisional === true && l4.burn_source === 'bridge_average' && spoken(h).some(t => /^暫定、給油ウィンドウは7周目に開く見込み。$/.test(t)) && !spoken(h).some(t => /給油ウィンドウが開いた/.test(t)), { l4, say: spoken(h) });
  }
  // ═══ 10. 余裕の既定＝1周分（周数×燃費でLへ換算）。Driverの「余裕は半周」で0.5周分へ変更。別raceへ持ち越さない（監督 2026-11-18）═══
  {
    const h = await boot(true, false, 25); h.set('fuelWindowMarginL', null);   // 余裕をLで直接設定していない＝既定の周数換算
    await tel(h, { lap: 5, fuel: 14, crossings: 12 });   // 燃費2.0L/周
    let r = JSON.parse(h.ev('JSON.stringify(currentFuelWindowResult(lastTelemetry))'));
    ck('10a 余裕の既定は1周分＝1周の燃費(2.0L)：必要24L＋余裕2.0L＝目標26L（容量25L超＝まだ閉じている）', r.margin_l === 2 && Math.abs(r.target_tank_l - 26) < 0.01 && r.state === 'waiting', r);
    await h.say('余裕は半周でいい');
    r = JSON.parse(h.ev('JSON.stringify(currentFuelWindowResult(lastTelemetry))'));
    ck('10b Driverの訂正「余裕は半周」で0.5周分(1.0L)になり、窓の判定へ反映される：目標25.0L≦容量25Lで開く。返答は1回で、そのターンを閉じる', r.margin_l === 1 && Math.abs(r.target_tank_l - 25) < 0.01 && r.state === 'open' && spoken(h).some(t => /^了解、燃料の余裕は半周分で見る（約1\.0L）。$/.test(t)), { r, say: spoken(h) });
    await tel(h, { lap: 1, fuel: 24, crossings: 12, race: 'sub:OTHER-FW' });
    ck('10c 別raceに入ると余裕の訂正は引き継がれず、既定の1周分に戻る', JSON.parse(h.ev('JSON.stringify(currentMarginPolicy())')).laps === 1 && h.diag(/RACE_SCOPED_RESET/).length === 1, h.diag(/RACE_SCOPED/));
  }
  console.log('\n=== fuel-window e2e: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS_ERROR', e); process.exit(2); });
