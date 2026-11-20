#!/usr/bin/env node
'use strict';
// レース設定の e2e（実renderer＋jsdom）：Owner指定「60分以内のショート耐久・給油1回」を、観測したレース形式に適用して、
//   確認・訂正（そのレース限り）→給油回数の数え方（進入・ドライブスルーでは消費しない）→給油後の返答・提案→別raceへ持ち越さない、を通す。
//   併せて、認識範囲の説明（評価できた車と評価外の車）と、U2の給油回数入力。
// 実: renderer全体、race-rules、fuel-window、undercut-forecast、speak。代替: TTS(偽audio)・WebSocket。未検証: 実iRacing・実音声・実LLM。
const H = require('./tests-fullrenderer-harness.js');
const F = require('./desktop/field-snapshot.js');
const { fixture } = require('./tests-canonical-lifecycle');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + n + (ok ? '' : ' -> ' + JSON.stringify(d === undefined ? null : d).slice(0, 700))); ok ? pass++ : fail++; };
let cseq = 0;
async function boot() {
  const h = H.boot({ root: H.ROOT, localStorage: { pw_auth_user: { id: 'u1' }, pw_auth_token: 'tok-u1' }, user: { id: 'u1', isMember: true, displayName: 'T' }, chat: async () => ({ text: 'REPLY。' }) });
  await h.sleep(300);
  h.set('selMode', 'race'); h.set('sel', 'LunaJP'); h.set('iracingLive', true); h.set('bridgeConnected', true); h.set('lastSessionNum', 2); h.set('lastSessionType', 'Race');
  h.set('lastFuelCapacityContext', { effective_fuel_capacity_l: 53, physical_tank_capacity_l: 53 });
  return h;
}
// racePlan: {kind, configured_duration_s}。pit: on_pit_road。race: race_instance_id
async function tel(h, { lap, fuel, pit = false, race = 'sub:RR-1', plan = { kind: 'timed', configured_duration_s: 2400 }, crossings = 12, burn = 2.7 }) {
  const sock = h.state.sockets[h.state.sockets.length - 1], send = m => sock.onmessage({ data: JSON.stringify(m) });
  if (!h.__c) { send({ type: 'connected', schema_version: 1, bridge_process_epoch: 'epoch-a' }); h.__c = true; }
  const q = ++cseq, s = fixture({ epoch: 'epoch-a', seq: q, frame: 100 + q, race, session: 2, decision: null, lap, proof: null, attempt: null, allowed: false });
  s.current_facts.current_lap = lap; s.current_facts.fuel_level_l = fuel; s.current_facts.on_pit_road = pit; s.current_facts.lap_dist_pct = 0.05;
  s.finish.remaining_after_current = crossings - 1; s.finish.remaining_sf_crossings = crossings; s.continuity.stable_scope = { race_instance_id: race, session_num: 2, driver_id: 7 };
  send(s);
  await h.bridge({ type: 'telemetry_live', lap, fuel, lap_dist_pct: 0.05, pos: 3, class_pos: 3, last: 100, best: 99, driver_pace_median_s: 100, session_time_remaining_s: 1500, gap_ahead: 20, gap_behind: 3, competitors: [], cust_id: 7, session_type: 'Race', session_num: 2,
    race_plan: plan, track: 'Fuji', car_model: 'GT3', car_class: 'GT3', on_track: true, on_pit_road: pit, race_instance_id: race, bridge_process_epoch: s.bridge_process_epoch, canonical_snapshot_id: s.snapshot_id, canonical_snapshot_sequence: s.snapshot_sequence, source_frame_sequence: s.source_frame.sequence });
  await h.sleep(20);
}
const said = h => h.diag(/LunaJP\]/).map(t => t.replace(/^\[LunaJP\]\s*/, ''));
async function finishAudio(h, n = 4) { for (let i = 0; i < n; i++) { await h.sleep(50); for (const a of h.state.audios) { try { a.finish(); } catch (e) {} } } }
async function ask(h, text) { await finishAudio(h, 2); const n0 = said(h).length; await h.say(text); await finishAudio(h, 3); return said(h).slice(n0); }
const rules = h => JSON.parse(h.ev('JSON.stringify(currentRaceRules(lastTelemetry))'));

(async () => {
  // ═══ 1. 設定の確認・訂正（そのレース限り） ═══
  {
    const h = await boot(); await tel(h, { lap: 5, fuel: 40 });
    ck('1a 40分のタイムレース（11/15富士と同じ形式）：Owner設定「給油1回」が適用される（出所=owner_directive）', rules(h).applies === true && rules(h).refuels_required === 1 && rules(h).source === 'owner_directive', rules(h));
    const a = await ask(h, 'このレース、給油は何回の設定？');
    ck('1b Driverの確認の質問に、設定・出所・形式・済み回数を結論から答える。そのターンは閉じる（LLMへ回さない）', a.length >= 1 && a[a.length - 1] === '給油は1回の設定（Owner設定、40分のタイムレース）。済んだのは0回。違えば言って。' && h.state.chats.length === 0, { a, chats: h.state.chats.length });
    const b = await ask(h, 'このレースは給油は2回だよ');
    ck('1c Driverの「給油は2回」は設定を変えない（Owner指定の給油1回を保持）。返答は「給油1回の設定のまま、言い直しでは変えない。足りない時は不足量と追加の停止が要る条件を伝える」', b.some(t => /^このレースは給油1回の設定のまま、言い直しでは変えない。足りない時は、不足量と追加の停止が要る条件を伝える。$/.test(t)) && rules(h).refuels_required === 1 && rules(h).source === 'owner_directive' && h.state.chats.length === 0, { b, r: rules(h) });
    const c = await ask(h, '給油は何回？');
    ck('1d 言い直しの後の確認でも「Owner設定・給油1回」のまま答える（会話で形式を上書きしない）', /1回の設定（Owner設定/.test(c[c.length - 1] || '') && !/あなたの訂正/.test(c[c.length - 1] || ''), c);
    const nb = said(h).length;
    for (const t of ['次のピットは2回目になる', 'ピットあと2回入る']) { await finishAudio(h, 2); await h.say(t); }
    ck('1d2 序数（次のピットは2回目）・残り回数（ピットあと2回入る）は給油回数の言い直しとして扱わない：設定の返答が出ず、設定も不変', !said(h).slice(nb).some(t => /給油\d回の設定のまま|給油\d回で見る/.test(t)) && rules(h).refuels_required === 1, { said: said(h).slice(nb), r: rules(h) });
    await tel(h, { lap: 1, fuel: 52, race: 'sub:RR-2' });
    ck('1e 別raceに入っても設定は不変（Owner設定のまま）。別raceへ状態を持ち越さない', rules(h).refuels_required === 1 && rules(h).source === 'owner_directive' && h.diag(/RACE_SCOPED_RESET/).length === 1, { r: rules(h), log: h.diag(/RACE_SCOPED/) });
  }
  // ═══ 2. 範囲外・未確認は適用しない（全レースへ固定値を埋め込まない） ═══
  {
    const h = await boot(); await tel(h, { lap: 5, fuel: 40, plan: { kind: 'timed', configured_duration_s: 10800 } });
    const a = await ask(h, '給油は何回の設定？');
    ck('2a 3時間のタイムレースには「給油1回」を適用せず、理由を言い、回数の指定を促す', rules(h).applies === false && rules(h).reason === 'outside_rule_scope' && /60分以内のショート耐久ではないので/.test(a[a.length - 1] || ''), { r: rules(h), a });
    const h2 = await boot(); await tel(h2, { lap: 5, fuel: 40, plan: {} });
    const a2 = await ask(h2, '給油は何回の設定？');
    ck('2b レース形式が未確認なら適用せず「形式がまだ確認できていない」と言う（確認できた範囲を伝える）', rules(h2).reason === 'race_format_unconfirmed' && /形式がまだ確認できていない/.test(a2[a2.length - 1] || ''), { r: rules(h2), a2 });
  }
  // ═══ 3. 給油の数え方：進入・ドライブスルー・ノイズで消費しない／確認した給油だけ ═══
  {
    const h = await boot(); await tel(h, { lap: 5, fuel: 30 });
    for (const f of [29.9, 29.8, 29.7]) await tel(h, { lap: 6, fuel: f, pit: true });   // 3標本以上いたが残量は増えない（ドライブスルー／ペナルティ）
    await tel(h, { lap: 6, fuel: 29.6 });
    const a = await ask(h, '給油は何回？');
    ck('3a ドライブスルー（ピット進入のみ・残量増えず）では給油回数を消費しない：済んだのは0回', /済んだのは0回/.test(a[a.length - 1] || '') && h.ev('ownPitObserver.passes') === 1, { a, passes: h.ev('ownPitObserver.passes') });
    for (const f of [29.5, 29.5, 45]) await tel(h, { lap: 7, fuel: f, pit: true });   // 実給油（+15.5L）
    await tel(h, { lap: 7, fuel: 44.8 });
    const b = await ask(h, '給油は何回？');
    ck('3b 給油を確認したピット（残量+15.5L）で初めて1回と数える：済んだのは1回', /済んだのは1回/.test(b[b.length - 1] || '') && h.ev('ownPitObserver.completions') === 1, { b });
  }
  // ═══ 4. 給油後：足りていれば再提案しない／設定の回数を済ませても足りなければ衝突を明示 ═══
  {
    const h = await boot(); await tel(h, { lap: 3, fuel: 19.4, crossings: 14 }); await tel(h, { lap: 4, fuel: 16.7, crossings: 13 }); await tel(h, { lap: 5, fuel: 14, crossings: 12 });   // 燃費2.7L/周を観測させる
    for (const f of [13.5, 13.4, 40]) await tel(h, { lap: 6, fuel: f, pit: true, crossings: 12 });
    await tel(h, { lap: 6, fuel: 39.8, crossings: 11 }); await finishAudio(h);
    ck('4a 給油後に足りる(39.8L・必要2.7×11=29.7L)：「給油完了、このままゴールまで足りる（余裕約10.1L）。」と一度だけ。再給油の提案は出ない', said(h).filter(t => /給油完了/.test(t)).length === 1 && said(h).some(t => /給油完了、このままゴールまで足りる（余裕約10\.1L）。/.test(t)) && !said(h).some(t => /に入るのがいい/.test(t)), said(h));
    const h2 = await boot(); await tel(h2, { lap: 3, fuel: 19.4, crossings: 22 }); await tel(h2, { lap: 4, fuel: 16.7, crossings: 21 }); await tel(h2, { lap: 5, fuel: 14, crossings: 20 });
    for (const f of [13.5, 13.4, 30]) await tel(h2, { lap: 6, fuel: f, pit: true, crossings: 20 });
    await tel(h2, { lap: 6, fuel: 29.8, crossings: 20 }); await finishAudio(h2);   // 必要2.7×20=54Lに対し29.8L＝約24.2L不足
    ck('4b 設定の給油1回を済ませても足りない時は、設定との衝突を明示：「設定の給油1回は済んだが、約24.2L足りない、もう一度入る必要がある。」', said(h2).some(t => /^設定の給油1回は済んだが、約24\.2L足りない、もう一度入る必要がある。$/.test(t)), said(h2));
  }
  // ═══ 5. 余裕の接続：同じ実入力で、窓／燃料回答／STR-001／U2が同じ余裕(周数×燃費)を使う（監査Codex 11/19）。優先順＝Driverの周数訂正 ＞ 直接L指定 ＞ 既定1周 ═══
  {
    const h = await boot();
    await tel(h, { lap: 3, fuel: 20.8, crossings: 14, burn: 2.6 }); await tel(h, { lap: 4, fuel: 18.2, crossings: 13 }); await tel(h, { lap: 5, fuel: 15.6, crossings: 12 });   // 燃費2.6L/周を観測
    const margins = () => ({ win: JSON.parse(h.ev('JSON.stringify(currentFuelWindowResult(lastTelemetry))')).margin_l, str001: h.ev('pitCompareInputFromLive(lastTelemetry).own.reserve_l.value'), policy: h.ev('currentMarginPolicy().laps') });
    let m = margins();
    ck('5a 既定は1周分＝2.6L：窓の余裕・STR-001/U2の入力(reserve_l)が同じ2.6L（旧：STR-001は固定0.5L）', Math.abs(m.win - 2.6) < 0.01 && Math.abs(m.str001 - 2.6) < 0.01 && m.policy === 1, m);
    await ask(h, '余裕は半周でいい');
    m = margins();
    ck('5b Driverの「余裕は半周」で、窓もSTR-001/U2の入力も同時に1.3Lへ変わる（必要給油量・作業時間が変わる）', Math.abs(m.win - 1.3) < 0.01 && Math.abs(m.str001 - 1.3) < 0.01 && m.policy === 0.5, m);
    h.set('fuelWindowMarginL', 3);
    m = margins();
    ck('5c 直接L指定(旧localStorageの設定相当)が残っていても、Driverの周数訂正を上書きしない：1.3Lのまま', Math.abs(m.win - 1.3) < 0.01 && Math.abs(m.str001 - 1.3) < 0.01, m);
    const live = JSON.parse(h.ev("JSON.stringify(currentCanonicalStrategyLive({...lastTelemetry,fuel_margin_policy:currentMarginPolicy()}).fuel_margin_policy)"));
    ck('5d 燃料回答（router）へ渡る余裕の設定も同じ0.5周分（回答の文面・L換算は tests-fuel-memory-planning：「余裕半周分(約X L)」・固定の予備2Lを使わない）', live && live.laps === 0.5 && live.source === 'driver_setting', live);
    await tel(h, { lap: 1, fuel: 52, race: 'sub:RR-9' });
    m = margins();
    ck('5e 別raceに入ると、周数訂正も直接L指定も初期化され、既定の1周分へ戻る（窓・STR-001とも）', m.policy === 1 && h.ev('fuelWindowMarginL') === null, m);
  }
  console.log('\n=== race rules e2e: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS_ERROR', e); process.exit(2); });
