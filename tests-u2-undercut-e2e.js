#!/usr/bin/env node
'use strict';
// U2/U3 — 実入口の通し検査：鈴鹿決勝(sub:90078233 session_num=2)の実U1ログを、実 irBridge.onmessage(field_snapshot / telemetry_live)へ時間順に流し、
//   実 sendMsg → 実 local-intent-router → 実 callAPI → 実 server.js(子プロセス・実HTTP) → 実 buildSystem → (偽SDK=保存応答) → 実 Truth Gate → 実 speak まで通す。
//   確認すること：毎Lap計算 → 走行中のLUNA提案(決定論・LLM 0回) → 質問(LLM 1回) → 「じゃあ次周なら？」の再計算(新しい計算版) → 訂正 → 偽造/古いパケットの拒否。
// 実:    renderer.html全体、field-snapshot受信、undercut-forecast、pit-strategy-compare、router、callAPI、server.js、buildSystem、Truth Gate、speak
// 代替:  Anthropic SDK(保存応答)、Audio、WebSocket、window.pitwall、時計（標本の観測時刻に合わせて進める）
// 未検証: 実LLMの意味、実音声、実Bridge(python/iRacing)、実Electron、実Windows、実走。
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const H = require('./tests-fullrenderer-harness.js');
const R = require('./tools/u2-replay-suzuka.js');
const C = require('./desktop/pit-strategy-compare.js');
const U = require('./desktop/undercut-forecast.js');
const Fuji = require('./fixtures/u2/fuji-gt-sprint-synthetic.js');
const ROOT = __dirname;
let pass = 0, fail = 0;
const ck = (name, ok, detail) => { (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + name + (ok ? '' : ' -> ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 700))); ok ? pass++ : fail++; };

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u2e2e-')); const queue = path.join(dir, 'queue'); fs.mkdirSync(queue);
  const capture = path.join(dir, 'system.jsonl'); const port = 24000 + Math.floor(Math.random() * 3000);
  const child = spawn(process.execPath, ['-r', path.join(ROOT, 'tests-wo001-anthropic-stream-stub-preload.js'), 'server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: 'sk-test-local-stub', DATABASE_URL: '', JWT_SECRET: '', STRIPE_SECRET_KEY: '', WO019_SDK_QUEUE_DIR: queue, WO014_SYSTEM_CAPTURE_FILE: capture } });
  const logs = []; child.stdout.on('data', d => logs.push(String(d))); child.stderr.on('data', d => logs.push(String(d)));
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('server start timeout')), 20000); child.stdout.on('data', d => { if (String(d).includes('is running')) { clearTimeout(t); res(); } }); child.on('exit', c => rej(new Error('server exited ' + c))); });
  let seq = 0;
  const api = { url: 'http://127.0.0.1:' + port, logs, queueReply: (forUserText, text, options={}) => fs.writeFileSync(path.join(queue, String(++seq).padStart(3, '0') + '-r.json'), JSON.stringify({ forUserText, chunks: Array.isArray(text)?text:[text], ...options })),
    captured: () => (fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) };
  try { return await fn(api); } finally { child.kill('SIGTERM'); }
}
const slimFromSystem = sys => { const m = String(sys).match(/PIT STRATEGY COMPARE[\s\S]*?\n(\{.*\})\n/); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };
const speakText = h => h.diag(/LunaJP\]/).map(t => t.replace(/^\[LunaJP\]\s*/, ''));

(async () => {
  const L = R.loadSnapshots();
  if (!L) { console.log('⏭  実U1ログ(OMORAY-field-20261113-1039-p01..p03.jsonl)が ' + R.dirOf() + ' に無いため未実施（U2_FIELD_LOG_DIRで指定）'); console.log('\n=== U2 undercut e2e: 0 passed, 0 failed, 1 skipped(未実施) ==='); process.exit(0); }
  const OWN = R.OWN, RACE = OWN.race_instance_id, EPOCH=L.race[0].bridge_process_epoch;
  const own = lap => OWN.laps.find(r => r.lap === lap);
  const realNow = Date.now.bind(Date);
  await withServer(async srv => {
    const h = H.boot({ root: ROOT, chatForward: srv.url, localStorage: { pw_auth_user: { id: 'u1' }, pw_auth_token: 'tok-u1' }, user: { id: 'u1', isMember: true, displayName: 'T' } });
    await h.sleep(300);
    h.set('selMode', 'race'); h.set('sel', 'LunaJP'); h.set('iracingLive', true); h.set('bridgeConnected', true);
    const shiftClock = ms => { h.w.Date.now = () => realNow() + ms; }, restoreClock = () => { h.w.Date.now = realNow; };   // 鮮度検査(max_age)の確認だけで使う
    let ptr = 0;
    const tel = (snap, lap, row, pace) => ({ type: 'telemetry_live', lap, fuel: row.fuel_l, pos: row.pos || 40, class_pos: 35, last: row.last_lap_s, best: pace, driver_pace_median_s: pace, session_time_remaining_s: row.time_remaining_s,
      gap_ahead: null, gap_behind: null, competitors: [], cust_id: 7, session_type: 'Race', session_num: 2, track: 'Suzuka International Racing Course', car_model: 'GT3', car_class: 'GT3', on_track: true, on_pit_road: false,
      race_instance_id: snap.race_instance_id, bridge_process_epoch: snap.bridge_process_epoch, canonical_snapshot_id: snap.snapshot_id, canonical_snapshot_sequence: snap.snapshot_sequence, source_frame_sequence: snap.source_frame.sequence });
    const paceUpTo = lap => { const v = OWN.laps.filter(r => r.lap <= lap && r.last_lap_s).map(r => r.last_lap_s); const lo = Math.min(...v.slice(-6)); const ok = v.filter(x => x <= lo * 1.08).sort((a, b) => a - b); return ok[ok.length >> 1]; };
    // 標本を、そのLap先頭の最初の標本まで時間順に流す（実field_snapshotとして）。その時刻に時計を合わせ、続けてtelemetry_liveを流す。
    async function feedLap(lap, clearOwnPit) {
      let target = -1;
      for (let i = ptr; i < L.race.length; i++) { const me = L.race[i].cars.find(c => c.i === L.race[i].player_car_idx); if (me && me.st === 'ok' && me.l === lap && me.d <= 0.25) { target = i; break; } }
      if (target < 0) throw new Error('lap ' + lap + ' not found in log');
      for (; ptr <= target; ptr++) { let sn = L.race[ptr]; if (clearOwnPit && ptr === target) sn = Object.assign({}, sn, { cars: sn.cars.map(c => c.i === sn.player_car_idx ? Object.assign({}, c, { pit: 0, s: 3 }) : c) }); await h.bridge(Object.assign({}, sn, { observed_at: realNow() / 1000 })); }   // 観測時刻だけ受信時刻へ（鮮度検査のため）。中身・session時刻・seqは実ログのまま
      const s = L.race[target];
      const snap = h.raceSnap({ race: RACE, epoch:EPOCH, driver: 7, session: 2, lap, fuel: own(lap).fuel_l });
      await h.bridge(tel(snap, lap, own(lap), paceUpTo(lap)));
      return s;
    }
    // 開始燃料（満タン相当53L）を最初の観測として渡す（Montreal版と同じ手順）
    { const sn0 = h.raceSnap({ race: RACE, epoch:EPOCH, driver: 7, session: 2, lap: 0, fuel: 53 }); await h.bridge(Object.assign(tel(sn0, 0, { fuel_l: 53, last_lap_s: null, pos: 40, time_remaining_s: null }, null), { lap: 0 })); }
    for (let lap = 5; lap <= 8; lap++) await feedLap(lap);
    const S = h.w.eval;
    const diagUC = () => h.diag(/UNDERCUT_FORECAST\b(?!_)/).map(t => { try { return JSON.parse(t.slice(t.indexOf('{'))); } catch { return null; } }).filter(Boolean);
    const state = () => JSON.parse(h.ev('JSON.stringify({u:pitCompareState.packet&&pitCompareState.packet.undercut_forecast||null,pkt:pitCompareState.packet&&pitCompareState.packet.calc_id,comparable:pitCompareState.packet&&pitCompareState.packet.comparable,skips:undercutState.skips,fieldStats:fieldSnapshotStats()})'));
    let st = state();
    ck('F1 実field_snapshotを時間順に受信（Lap5〜8）。受信側で採用した標本は3件以上、拒否0・重複0', st.fieldStats.accepted > 300 && st.fieldStats.rejected_total === 0, st.fieldStats);
    ck('F2 毎Lap再計算：Lap8の計算にundercut_forecast（race/session一致・比較成立）が付く。STR-001側(比較)が成立しなくても、全車snapshotからの比較で相談に使える', !!st.u && st.u.comparable === true && st.u.race.race_instance_id === RACE && st.u.race.session_num === 2 && st.u.observed_at.lap === 8, st.u && { c: st.u.comparable, race: st.u.race, lap: st.u.observed_at });
    ck('F3 名簿50台に対し同時に観測できたのは21台、見えていない車がいる（clear_claim_allowed=false）', st.u.coverage.roster_competitors === 50 && st.u.coverage.observed_now === 21 && st.u.coverage.clear_claim_allowed === false, st.u.coverage);
    ck('F4 診断ログ UNDERCUT_FORECAST に計算版・Lap・coverage・推奨が残る（質問前に毎Lap）', diagUC().length >= 4 && diagUC().every(d => d.calc_id && d.coverage && d.coverage.roster === 50), diagUC().slice(-1));
    const calcLap8 = st.u.calc_id;

    // ── 走行中のLUNA提案（決定論・LLM 0回）──
    // 提案は「今入る案が最善」か「判断が目前」で、前回と変わった時だけ。Lap14は限界案と次周案が同じ周（15）で、判断が目前。
    const chats0 = h.state.chats.length;
    for (let lap = 9; lap <= 12; lap++) await feedLap(lap);
    const proposalsNow = () => speakText(h).filter(t => /ピット判断/.test(t));
    ck('P0 Lap9〜12：限界案が遠い(判断期限15周)間は提案を話さない（毎周の独り言にしない）。計算は毎Lap走り、見送りの理由が診断ログに残る', proposalsNow().length === 0 && h.diag(/UNDERCUT_PROPOSAL/).length >= 3 && h.diag(/UNDERCUT_PROPOSAL/).every(t => /"spoken":false/.test(t)), { spoken: proposalsNow(), diag: h.diag(/UNDERCUT_PROPOSAL/).slice(-2) });
    await feedLap(13);
    await feedLap(14);
    await h.sleep(60);
    const spoke = proposalsNow();
    st = state();
    ck('P1 Lap14：推奨が「次周(15周)」で判断が目前（完走燃料をチェッカー基準N−Pに直した後の結果）。走行中のLUNA提案が発話される（決定論の文面。判断期限・見えていない車・後続を評価できていない旨を含む）', spoke.length >= 1 && /次周\(15周\)/.test(spoke[spoke.length - 1]) && /判断は15周まで/.test(spoke[spoke.length - 1]) && /空いているとは言えない/.test(spoke[spoke.length - 1]) && /後続の位置が見えていない/.test(spoke[spoke.length - 1]), { spoke, rec: st.u && st.u.decision && st.u.decision.recommendation });
    ck('P2 提案の数値は同じ計算版のパケット由来（推奨周・判断期限）で、提案はLLMを呼ばない（chat送信0件）', st.u.decision.recommendation.pit_lap === 15 && st.u.decision.recommendation.decide_by_lap === 15 && h.state.chats.length === chats0, { chats: h.state.chats.length - chats0 });
    ck('P2b 提案は異なるLapに1回ずつ（同じ文面を同じLapで繰り返さない）', new Set(spoke).size === spoke.length, spoke);
    const propLog = h.diag(/UNDERCUT_PROPOSAL/).slice(-1)[0] || '';
    ck('P3 提案の診断ログに計算版が残り、同じLapの再計算では繰り返さない（1Lapに1回）', propLog.includes(st.u.calc_id) || /"spoken":true/.test(propLog), propLog);
    const nSpoke = proposalsNow().length;
    await h.w.eval("updatePitStrategyCompare(lastTelemetry,'field_pit_event')");
    ck('P4 同じLapで再計算(field_pit_event)しても提案は繰り返さない', proposalsNow().length === nSpoke, [nSpoke, proposalsNow().length]);

    // 提案の抑止：(a)同じLapでは、前回と文面が変わっても繰り返さない (b)Driverの質問・意見による再計算では話さない
    {
      const n0 = proposalsNow().length;
      await h.w.eval("undercutState.proposalKey='forced-different-key'");
      await h.w.eval("updatePitStrategyCompare(lastTelemetry,'field_pit_event')");
      ck('P4b 同じLapでは、提案の中身(key)が前回と違っても繰り返さない（1Lapに1回の上限）', proposalsNow().length === n0, [n0, proposalsNow().length]);
      await h.w.eval("undercutState.proposalKey=null;undercutState.proposalLapKey=''");
      await h.w.eval("updatePitStrategyCompare(lastTelemetry,'driver_opinion:undercut_focus')");
      ck('P5 Driverの質問・意見による再計算(driver_opinion)では、LUNAから話し始めない（提案はLap/ピット状態の更新の時だけ）', proposalsNow().length === n0, [n0, proposalsNow().length]);
      await h.w.eval("undercutState.proposalKey=null;undercutState.proposalLapKey=''");
      await h.w.eval("updatePitStrategyCompare(lastTelemetry,'field_pit_event')");   // 抑止を外した状態に戻す（以降の検査のため、話させた後の状態にする）
    }
    // ── 質問 → LUNA（LLM 1回/ターン）──
    // Lap9相当の質問は既に進んだので、いまの計算（Lap14）で質問する。質問文の保存応答は、サーバーが実際に渡したパケットの値から組み立てる。
    const Q1 = '今入るのと次周に入るのと、どっちが得？';
    srv.queueReply(Q1, '仮の返答。');
    const before = { chats: h.state.chats.length, route: h.state.router.route };
    await h.say(Q1);
    const routed = h.state.router.handled.slice(-1)[0];
    ck('Q1 戦略相談は固定応答で終端せず、LUNA(LLM)へ届く（実routerを通った）', h.state.router.route > before.route && routed === null && h.state.chats.length > before.chats, { routed, chats: h.state.chats.length - before.chats });
    const body1 = h.state.chats[h.state.chats.length - 1];
    const pk1 = body1.pitStrategyCompare, u1 = pk1 && pk1.undercut_forecast;
    ck('Q2 送信payloadの計算パケットに undercut_forecast（Lap14・比較成立・coverage・3案・判断期限）が入る', !!u1 && u1.comparable === true && u1.observed_at.lap === 14 && u1.coverage.clear_claim_allowed === false && ['now', 'next', 'limit'].every(id => u1.options.some(o => o.id === id)) && Number.isInteger(u1.decision.recommendation.decide_by_lap), u1 && { lap: u1.observed_at.lap, ids: u1.options.map(o => o.id) });
    const cap1 = srv.captured().slice(-1)[0], slim1 = slimFromSystem(cap1.system);
    ck('Q3 実server.jsが受理し(accepted undercut=)、systemのPIT STRATEGY COMPARE にuc(同じ計算版・coverage・各案・focus)と全車用の指示が入る', srv.logs.join('').includes('undercut=' + u1.calc_id) && slim1 && slim1.uc && slim1.uc.id === u1.calc_id && slim1.uc.coverage.observed === u1.coverage.observed_now && /uc＝全車の位置/.test(cap1.system), { has: !!slim1, ucid: slim1 && slim1.uc && slim1.uc.id });
    // 保存応答：パケット(uc)の値だけから組み立てる
    const rec1 = slim1.uc.rec, optNext = slim1.uc.options.find(o => o.id === 'next');
    const reply1 = '推奨は' + rec1.pit_lap + '周目、' + rec1.add_l + 'リットル。判断は' + rec1.decide_by_lap + '周までです。復帰先は見えていない車がいるので、観測できた車だけの下限です。';
    srv.queueReply('もう一度、' + Q1, reply1);
    await h.say('もう一度、' + Q1);
    const shown1 = speakText(h).slice(-1)[0] || '';
    const answerPacket=h.state.chats.at(-1).pitStrategyCompare.undercut_forecast;
    const answerOption=answerPacket.options.find(o=>o.id===answerPacket.action.option_id);
    ck('Q4 計算回答の周・給油量・再判断は同じ計算版の値に一致する', shown1.includes(answerOption.pit_lap + '周目')
      && shown1.includes((Math.round(answerOption.add_l*10)/10) + 'リットル') && /確認しよう|見直そう/.test(shown1), shown1);

    // ── 「じゃあ次周なら？」→ 再計算 → 新しい計算版 ──
    const Q2 = 'じゃあ次周なら？';
    srv.queueReply(Q2, '仮');
    const nb = h.state.chats.length;
    await h.say(Q2);
    const routed2 = h.state.router.handled.slice(-1)[0];
    const body2 = h.state.chats[h.state.chats.length - 1];
    const u2 = body2 && body2.pitStrategyCompare && body2.pitStrategyCompare.undercut_forecast;
    ck('R1 「じゃあ次周なら？」は固定応答で終端せずLLMへ届く（有効な計算パケットがあるので続きとして扱う）', h.state.chats.length > nb && routed2 === null, { routed2, n: h.state.chats.length - nb });
    ck('R2 再計算：焦点が次周案(15周)になり、新しい計算版(calc_id)で送られる。案の数値(vs・給油量)は同じ入力のまま変わらない', !!u2 && u2.focus && u2.focus.option_id === 'next' && u2.focus.pit_lap === 15 && u2.focus.evaluated === true && u2.calc_id !== u1.calc_id && JSON.stringify(u2.options.find(o => o.id === 'next').vs_rivals) === JSON.stringify(u1.options.find(o => o.id === 'next').vs_rivals) && u2.options.find(o => o.id === 'next').add_l === u1.options.find(o => o.id === 'next').add_l, u2 && u2.focus);
    const cap2 = srv.captured().slice(-1)[0], slim2 = slimFromSystem(cap2.system);
    ck('R3 サーバーのsystem promptにも新しい計算版と焦点(focus=next)が入る＝LUNAは次周案の内訳で答えられる', slim2 && slim2.uc && slim2.uc.id === u2.calc_id && slim2.uc.focus && slim2.uc.focus.option === 'next' && slim2.uc.focus.pit_lap === 15, slim2 && slim2.uc && slim2.uc.focus);
    const nx = slim2.uc.options.find(o => o.id === 'next') || slim2.uc.options.find(o => o.id === 'now');
    const reply2 = '次周なら' + (slim2.uc.focus.pit_lap) + '周目に入る案。給油は' + (nx.add_l) + 'リットル。判断は' + slim2.uc.rec.decide_by_lap + '周までです。';
    srv.queueReply('じゃあ次周なら？もう一度', reply2);
    await h.say('じゃあ次周なら？もう一度');
    const shown2 = speakText(h).slice(-1)[0] || '';
    ck('R4 再計算後の返答（次周案の周・給油量・判断期限）が、新しい計算版の値と一致して発話される', shown2.includes(slim2.uc.focus.pit_lap + '周目') && (nx.add_l === undefined || shown2.includes((Math.round(nx.add_l*10)/10) + 'リットル')), shown2);
    // 焦点は質問したLapの間だけ：Lapが進めば外れる（古い焦点を持ち越さない）
    const stFocus = state();
    ck('R5 焦点の質問をしたLapの計算では focus が付く（Lap14）', stFocus.u.focus && stFocus.u.focus.option_id === 'next', stFocus.u.focus);

    // ── Truth Gate（実flow）：パケットに無い数値・「空いている」断定は止まる ──
    const read = async (q, reply) => { srv.queueReply(q, reply); const n = speakText(h).length, nc = h.state.chats.length; await h.say(q); const t = speakText(h); return h.state.chats.length > nc && t.length > n ? t[t.length - 1] : null; };
    const fab = await read('ピットの交通、どう？', '復帰時の交通損失は47秒です。');
    ck('G1 パケットに無い数値（交通損失47秒）は止まり、そのまま発話されない', fab !== null && !/47秒/.test(fab), fab);
    const clear = await read('復帰の交通は？', 'ピットから戻っても復帰先は空いています。');
    ck('G2 見えていない車がいる（clear_claim_allowed=false）のに「復帰先は空いている」と言う返答は止まる', clear !== null && !/復帰先は空いています/.test(clear), clear);
    const okHonest = await read('復帰の交通は？', '復帰先は見えていない車がいるので、空いているとは言えません。観測できた車の分だけです。');
    ck('G3 観測できない車の説明と再判断を計算回答に含める', okHonest !== null && /空いているとは言えない/.test(okHonest) && /確認しよう|見直そう/.test(okHonest), okHonest);

    // ── 訂正（Driverの意見）→ 仮定として記録 → 再計算 ──
    const OP = '前に詰まってる、アンダーカットは厳しいかも';
    srv.queueReply(OP, '了解。交通を見込んで計算し直した。');
    await h.say(OP);
    const u3 = h.state.chats[h.state.chats.length - 1].pitStrategyCompare.undercut_forecast;
    ck('O1 意見は観測ではなく仮定(driver_declared)として入り、今入る案(アンダーカット側)にだけ交通3sが加わる（次周・限界案には入らない）', u3 && u3.options.find(o => o.id === 'now').rejoin.traffic_extra_declared_s === 3 && u3.options.find(o => o.id === 'next').rejoin.traffic_extra_declared_s === 0 && u3.calc_id !== u2.calc_id, u3 && u3.options.map(o => [o.id, o.rejoin && o.rejoin.traffic_extra_declared_s]));

    // ── 古い/別session：snapshotが古くなれば全車の計算は付かない（前の全車情報を使わない）──
    shiftClock(60000);
    await h.w.eval("updatePitStrategyCompare(lastTelemetry,'test_stale')");
    const stStale = state();
    restoreClock();
    ck('S1 標本が古い(60秒)と undercut_forecast は付かない（fail-closed）。理由はskipsに数える', !stStale.u && stStale.skips.no_current_field_snapshot >= 1, stStale.skips);

    await h.w.eval("updatePitStrategyCompare(Object.assign({},lastTelemetry,{lap:Number(lastTelemetry.lap)+3}),'test_lap_mismatch')");
    const stMis = state();
    ck('S2 標本の自車Lapと今のtelemetryのLapが2周以上ずれていれば、別物として使わない（undercutを付けない・skipsにlap_mismatch）', !stMis.u && stMis.skips.lap_mismatch >= 1, stMis.skips);
    await h.w.eval("updatePitStrategyCompare(lastTelemetry,'test_restore')");
    // ── サーバー検証：偽造/古い undercut を実HTTPで直接送っても拒否 ──
    const real = h.state.chats.slice().reverse().find(b => b.pitStrategyCompare && b.pitStrategyCompare.undercut_forecast);
    const post = async (mut) => { const b = JSON.parse(JSON.stringify(real)); mut(b); const { calc_id, ...rest } = b.pitStrategyCompare; b.pitStrategyCompare.calc_id = C.hashString(JSON.stringify(rest)); srv.queueReply('サーバー検証', 'ok'); b.messages = b.messages.concat([{ role: 'user', content: 'サーバー検証' }]); const r = await fetch(srv.url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); await r.text(); return srv.captured().slice(-1)[0]; };
    const ucOnly = await post(b => { const pk = b.pitStrategyCompare; pk.comparable = false; pk.blocking = ['test_str001_not_comparable']; pk.cases = []; pk.recommendation = null; });
    ck('V5 STR-001の比較が成立していなくても、全車snapshotからの比較(undercut)が成立していれば、サーバーは受理してsystemに入れる（packetUsable）', ucOnly && /PIT STRATEGY COMPARE/.test(ucOnly.system) && /"uc":/.test(ucOnly.system) && srv.logs.join('').includes(' undercut=' + real.pitStrategyCompare.undercut_forecast.calc_id), srv.logs.join('').split('\n').filter(l => /pit_compare/.test(l)).slice(-2));
    const bothOff = await post(b => { const pk = b.pitStrategyCompare; pk.comparable = false; pk.undercut_forecast.comparable = false; });
    ck('V6 どちらの比較も成立していないパケットはLUNAへ渡さない', bothOff && !/PIT STRATEGY COMPARE/.test(bothOff.system), null);
    const f1 = await post(b => { b.pitStrategyCompare.undercut_forecast.race.race_instance_id = 'sub:other'; });
    ck('V1 別raceのundercutは拒否される（undercut_race_mismatch・systemに入らない）', f1 && !/PIT STRATEGY COMPARE/.test(f1.system) && srv.logs.join('').includes('undercut_race_mismatch'), srv.logs.join('').split('\n').filter(l => /pit_compare/.test(l)).slice(-2));
    const f2 = await post(b => { b.pitStrategyCompare.undercut_forecast.expires.valid_until_lap = 1; });
    ck('V2 古いLapのundercut（valid_until_lap<現在Lap）は拒否される', f2 && !/PIT STRATEGY COMPARE/.test(f2.system) && srv.logs.join('').includes('undercut_stale_lap'), null);
    const f3 = await post(b => { for (const o of b.pitStrategyCompare.undercut_forecast.options) if (o.rejoin) o.rejoin.clear = true; });
    ck('V3 見えていない車がいるのに復帰先を「空いている(clear=true)」とするパケットは拒否される（undercut_clear_claim_with_unobserved）', f3 && !/PIT STRATEGY COMPARE/.test(f3.system) && srv.logs.join('').includes('undercut_clear_claim_with_unobserved'), null);
    const oldVersion = await post(b => { b.pitStrategyCompare.undercut_forecast.version='undercut-forecast-1.0.0'; });
    ck('V7 古い計算版は外側パケットのhashを再計算しても採用されない', oldVersion && !/PIT STRATEGY COMPARE/.test(oldVersion.system) && srv.logs.join('').includes('undercut_version'), null);
    const f4 = await post(b => { b.pitStrategyCompare.undercut_forecast.decision.recommendation.success_probability = 0.8; });
    ck('V4 校正前の成功確率を載せたパケットは拒否される', f4 && !/PIT STRATEGY COMPARE/.test(f4.system) && srv.logs.join('').includes('uncalibrated_probability'), null);
    // 費用：戦略相談でない雑談には載せない。周回・提案はLLMを呼ばない
    const ncs = h.state.chats.length;
    for (const t of ['この後も集中していくよ', '今日は調子いいな', 'ここから落ち着いて走るよ']) { srv.queueReply(t, 'うん。'); await h.say(t); }
    const sent = h.state.chats.slice(ncs);
    ck('C1 戦略相談でない雑談（相談の3発話目以降）には計算パケットを載せない（費用）', sent.length === 3 && sent[2].pitStrategyCompare === null, sent.map(b => !!b.pitStrategyCompare));
    ck('C2 LLM呼出しは質問の送信だけ：計算(毎Lap)・提案(決定論)・焦点の再計算の質問前の計算は0回', (() => { const llm = JSON.parse(h.ev('JSON.stringify(pitCompareState.llm.log)')); return llm.every(x => x.calls === 1); })(), null);
    // 焦点の質問をした後、Lapが進むと焦点は外れる（最後に確認：以降の検査はLap14の計算を使うため）
    await feedLap(15, true);   // Lap15は実ログで自車がピットレーン上（own_in_pit＝計算なし）。焦点の持ち越しを素通りで見逃さないよう、このLapだけ自車のピット表示を外して計算を成立させる
    const stNext = state();
    ck('R6a Lap15(ピット表示を外した)で計算が成立している（own_in_pitで素通りしていない）', !!(stNext.u && stNext.u.comparable), stNext.u && stNext.u.blocking);
    ck('R6 Lapが進むと焦点は外れる（質問したLapの間だけ。古い焦点を次のLapへ持ち越さない）', !stNext.u || !stNext.u.focus, stNext.u && stNext.u.focus);
    ck('E1 実renderer実行中にJSエラーなし', h.state.errors.length === 0, h.state.errors.slice(0, 3));

    // ═══ 富士 VRS GT Sprint（Driver報告に基づく再現用の仮定＝合成）を、同じ実入口で通す ═══
    //   合成のU1標本(本物の field-snapshot.check を通る形式)＋合成のtelemetry。実装の経路は鈴鹿と同じ。実測ではない。
    const FC = Fuji.CONST, cases = Fuji.build();
    async function runFuji(name, {fuel, missing=false}={}) {
      const hf = H.boot({ root: ROOT, chatForward: srv.url, localStorage: { pw_auth_user: { id: 'u1' }, pw_auth_token: 'tok-u1' }, user: { id: 'u1', isMember: true, displayName: 'T' } });
      await hf.sleep(300);
      hf.set('selMode', 'race'); hf.set('sel', 'LunaJP'); hf.set('iracingLive', true); hf.set('bridgeConnected', true);
      const input = cases[name].input, snap = input.snapshot, RID = snap.race_instance_id;
      const feedTel = async (lap, fuel, remaining) => { const sn = hf.raceSnap({ race: RID, epoch:snap.bridge_process_epoch, driver: 7, session: 2, lap, fuel }); await hf.bridge({ type: 'telemetry_live', lap, fuel, pos: 3, class_pos: 3, last: FC.L, best: FC.L, driver_pace_median_s: FC.L, session_time_remaining_s: remaining, gap_ahead: 20, gap_behind: 3, competitors: [],
        cust_id: 7, session_type: 'Race', session_num: 2, track: 'Fuji Speedway', car_model: 'GT3', car_class: 'GT3', on_track: true, on_pit_road: false, race_instance_id: sn.race_instance_id, bridge_process_epoch: sn.bridge_process_epoch,
        canonical_snapshot_id: sn.snapshot_id, canonical_snapshot_sequence: sn.snapshot_sequence, source_frame_sequence: sn.source_frame.sequence }); };
      await feedTel(0, FC.startFuel, null);
      for (let lap = 6; lap <= 8; lap++) await feedTel(lap, FC.startFuel - FC.burn * (lap - 1), (FC.totalLaps - lap) * FC.L - 40);
      const cars=missing?[...snap.cars.slice(0,2), ...snap.cars.slice(2).map(c=>({...c,st:'out',s:-1,p:null,cp:null,l:null,lc:null,d:null,f2:null,est:null,ll:null,pit:null}))]:snap.cars;
      const counts=missing?{...snap.counts, observed:2,departed:snap.cars.length-2}:snap.counts;
      await hf.bridge({...snap,cars,counts,observed_at:realNow()/1000});
      await feedTel(9, fuel ?? FC.startFuel - FC.burn * (FC.ownLap + FC.ownD - 1), 1500);
      return hf;
    }
    const fstate = hf => JSON.parse(hf.ev('JSON.stringify({u:pitCompareState.packet&&pitCompareState.packet.undercut_forecast||null})')).u;
    const opt = (u, id) => u.options.find(o => o.id === id);
    const hw = await runFuji('wait_loses');
    const uw = fstate(hw);
    const propW = speakText(hw).filter(t => /ピット判断/.test(t));
    ck('FW1 富士(待つと逆転)：実入口の計算で、後続#11が先に入る想定では次周案・限界案は相手が前(rival)、今入る案は自車が前(own)', !!uw && uw.comparable && uw.rivals.map(r => r.no).join() === '11,12' && opt(uw, 'next').vs_rivals.some(v => v.rival_no === '11' && v.scenario === 'pits_now' && v.leads_at_common_point === 'rival') && opt(uw, 'now').vs_rivals.every(v => v.leads_at_common_point === 'own'), uw && uw.options.map(o => [o.id, o.vs_rivals.map(v => v.rival_no + v.scenario + v.leads_at_common_point)]));
    ck('FW2 推奨は今入る案。見えていない車が無い(全16台を観測)ので復帰区間は「空いている」と言える(clear_claim_allowed=true)が、今案以外は遅い車で詰まる', uw.decision.recommendation.option_id === 'now' && uw.coverage.clear_claim_allowed === true && opt(uw, 'now').rejoin.clear === false /* 窓内に前走車(同ペース)が居るので空いてはいない */ || opt(uw, 'now').rejoin.traffic_loss_s.value === 0, { rec: uw.decision.recommendation, now: opt(uw, 'now').rejoin.traffic_loss_s });
    ck('FW3 走行中のLUNA提案：後続#11が先に入ると次周/限界案は負ける旨を、決定論の文面で話す（判断期限9周・LLM 0回）', propW.length === 1 && /後ろの11番/.test(propW[0]) && /判断は9周まで/.test(propW[0]) && /今周\(9周\)/.test(propW[0]) && hw.state.chats.length === 0, { propW, chats: hw.state.chats.length });
    srv.queueReply('じゃあ次周なら？', '仮');
    await hw.say('じゃあ次周なら？');
    const bw = hw.state.chats[hw.state.chats.length - 1], uw2 = bw && bw.pitStrategyCompare && bw.pitStrategyCompare.undercut_forecast;
    const capW = srv.captured().slice(-1)[0], slimW = slimFromSystem(capW.system);
    ck('FW4 「じゃあ次周なら？」：新しい計算版で焦点=次周案(10周)が送られ、サーバーのsystem promptにも入る。次周案は#11が先に入る想定で負ける数値(vs)を持つ', !!uw2 && uw2.focus.option_id === 'next' && uw2.focus.pit_lap === 10 && uw2.calc_id !== uw.calc_id && slimW && slimW.uc.id === uw2.calc_id && slimW.uc.focus.option === 'next' && slimW.uc.options.find(o => o.id === 'next').vs.some(v => v[0] === '11' && v[1] === 'pits_now' && v[3] === 'rival'), slimW && slimW.uc && slimW.uc.focus);
    const nW = slimW.uc.options.find(o => o.id === 'next'), vW = nW.vs.find(v => v[0] === '11' && v[1] === 'pits_now');
    const replyW = '次周は' + nW.pit_lap + '周目に入る案。11番が先に入ると約' + vW[2] + '秒遅れる。今入る方が前に出られる。';   // 診断ログは長い文を途中で切るので、文を短くして全文を照合する
    srv.queueReply('じゃあ次周なら？もう一度', replyW);
    await hw.say('じゃあ次周なら？もう一度');
    const shW = speakText(hw).slice(-3).join('');
    ck('FW5 次周案の周・合流GAPは同版の合流予測に一致する', shW.includes(nW.pit_lap + '周目')
      && (!nW.blend_gap.ahead || shW.includes('前車まで約'+Math.round(nW.blend_gap.ahead.gap_s*10)/10+'秒'))
      && (!nW.blend_gap.behind || shW.includes('後続まで約'+Math.round(nW.blend_gap.behind.gap_s*10)/10+'秒')), shW);

    const he = await runFuji('early_loses');
    const ue = fstate(he), propE = speakText(he).filter(t => /ピット判断/.test(t));
    ck('FE1 富士(早く入ると損)：実入口の計算で、今入る案は復帰先の遅い車3台(別クラス・観測)で交通損失が出て、次周案より給油後のGAPが悪い。推奨は今入る案ではない', !!ue && ue.decision.recommendation.option_id !== 'now' && opt(ue, 'now').rejoin.ahead.filter(c => c.basis === 'observed' && c.class_id === 2).length === 3 && opt(ue, 'now').rejoin.traffic_loss_s.value > opt(ue, 'next').rejoin.traffic_loss_s.value + 1 && opt(ue, 'now').vs_rivals.every(x => { const y = opt(ue, 'next').vs_rivals.find(z => z.rival_id === x.rival_id && z.scenario === x.scenario); return y && x.gap_s > y.gap_s; }), ue && opt(ue, 'now').rejoin);
    ck('FE2 今入る案は#11が今周先に入る想定で自車が後ろに回る(rival)＝「早く入れば安全」とは限らない条件も、packetのrival_first_threatsとして渡る', ue.decision.rival_first_threats.some(t => t.option_id === 'now' && t.rival_no === '11' && t.scenario === 'pits_now'), ue.decision.rival_first_threats);
    ck('FE3 「今入ったら？」の質問が焦点=今(9周)になり、新しい計算版で今案の内訳（交通損失・復帰先の車列）が送られる', await (async () => { srv.queueReply('今入ったら？', '仮'); await he.say('今入ったら？'); const b = he.state.chats[he.state.chats.length - 1], u = b && b.pitStrategyCompare && b.pitStrategyCompare.undercut_forecast; return !!u && u.focus.option_id === 'now' && u.focus.pit_lap === 9 && u.calc_id !== ue.calc_id && opt(u, 'now').rejoin.ahead.length >= 3; })(), null);
    ck('FW4 提案文の主語が明示される（R-U2-5）：「11番に約◯秒先に出られる（自車が後ろになる）」。誰が前に出るのかを読み違えない', !!propW[0] && /11番に約\d+(?:\.\d)?秒先に出られる（自車が後ろになる）/.test(propW[0]) && !/給油後に約\d+(?:\.\d)?秒前に出られる/.test(propW[0]), propW[0]);
    console.log('   富士の提案文(待つと逆転)：' + (propW[0] || '(なし)'));
    console.log('   富士の提案文(早く入ると損)：' + (propE[0] || '(提案なし＝推奨が限界案で判断が遠く、後続の先入れ脅威も今案だけ)'));
    const trace = h => JSON.parse(h.ev('JSON.stringify(utteranceTraceLog)'));
    const responses = [
      ['合流時の前後GAPは？', ['右へ寄せれば誰にも行く手を遮られません。','その窓ならずっと単独走行です。']],
      ['Any gaps at the pit exit?', ['You will slot into a pocket with the whole lane to yourself.','There is no one to negotiate with.']],
      ['復帰の交通は？', ['現時点で不明です。']],
    ];
    for (const [question,chunks] of responses) {
      const hc=await runFuji('early_loses',{missing:true});
      if(question.startsWith('Any'))hc.set('sel','Luna');
      const n=trace(hc).length;
      srv.queueReply(question,chunks);
      await hc.say(question);
      const joined=trace(hc).slice(n);
      const item=joined.find(t=>t.kind==='pit_calculated_reply'&&t.state==='queued');
      const body=hc.state.chats.at(-1)?.pitStrategyCompare?.undercut_forecast;
      const displayed=hc.w.document.querySelector('#chat-area .msg.ai:last-child')?.textContent;
      ck('SAFE '+question+' 保存応答の断定はキューに届かず、同版の行動案が表示とキューへ届く', !!item && body
        && item.source.ref.calc_id===body.calc_id && item.source.ref.calc_version===body.version && displayed===item.text
        && /見直そう|確認しよう|reassess|check/i.test(item.text)
        && !joined.some(t=>chunks.some(x=>t.text?.includes(x))), {item,displayed,calc:body?.calc_id});
      console.log('   '+(item?.text||'(no delivery)'));
    }
    for(const [missingSnapshot,q] of [[false,'出たら前は空いてる？'],[true,'出たら前は空いてる？'],[true,'合流したらどうなる？']]){
      const hc=await runFuji('early_loses');
      const opening='アンダーカットの合流は？';
      srv.queueReply(opening,'仮。');
      await hc.say(opening);
      if(missingSnapshot) hc.w.Date.now=()=>realNow()+60000;
      const n=trace(hc).length;
      srv.queueReply(q,['進路を遮る車は一台もありません。','安全に合流できます。']);
      await hc.say(q);
      const result=trace(hc).slice(n);
      const queued=result.find(t=>t.kind==='pit_calculated_reply'&&t.state==='queued');
      ck('相談直後の合流質問 ('+missingSnapshot+') は根拠ある回答だけキューに入る',
        !!queued && !result.some(t=>/遮る車|安全に合流/.test(t.text||''))
        && (missingSnapshot ? /残燃料とピット期限を今確認/.test(queued.text)
          : /前車まで約[\d.]+秒、後続まで約[\d.]+秒/.test(queued.text)),queued?.text);
    }
    for(const [q,reply,replace] of [
      ['出口に出たら誰かいる？','前方は開けています。',true],
      ['ブロックされそう？','問題なく合流できます。',true],
      ['じゃあ出た先はどんな感じ？','復帰先は走りやすいです。',true],
      ['Any problems once I get there?','You can merge without interference.',true],
      ['タイヤの使い方は？','タイヤをいたわろう。',false],
      ['前のピットのタイミング、悪くなかった？','早めに入った判断は筋が通っていた。',false],
    ]){
      const hc=await runFuji('early_loses',{missing:true});
      const opening='アンダーカットの合流は？';
      srv.queueReply(opening,'仮。');
      await hc.say(opening);
      const n=trace(hc).length;
      srv.queueReply(q,[reply]);
      await hc.say(q);
      const emitted=trace(hc).slice(n);
      const shown=hc.w.document.querySelector('#chat-area .msg.ai:last-child')?.textContent||'';
      ck('窓内の言い換え・対照 '+q,replace
        ? emitted.some(t=>t.kind==='pit_calculated_reply'&&t.state==='queued')
          && !emitted.some(t=>t.text?.includes(reply)) && !shown.includes(reply)
        : (q.startsWith('タイヤ') ? /タイヤ.*(?:摩耗|いたわ)/.test(shown) : shown.includes(reply))
          && !emitted.some(t=>t.kind==='pit_calculated_reply'),{shown,emitted:emitted.slice(-3)});
    }
    for(const [q,reply] of [
      ['出口に出たら誰かいる？','自由に走れます。'],
      ['出たところで詰まりそう？','問題ないよ、そのまま行こう。'],
      ['合流後すぐ全開でいけそう？','出てすぐ全開で行けます。'],
      ['Will I get stuck behind anyone when I come out?','Nothing in your way.'],
      ['Is the exit going to be busy?','You can go flat out.'],
    ]){
      const hc=await runFuji('early_loses',{missing:true});
      if(/^[A-Z]/.test(q))hc.set('sel','Luna');
      const opening='アンダーカットの合流は？';
      srv.queueReply(opening,'仮。');
      await hc.say(opening);
      const n=trace(hc).length;
      srv.queueReply(q,[reply]);
      await hc.say(q);
      const output=trace(hc).slice(n).filter(t=>t.state==='queued'&&t.text?.includes(reply));
      const shown=hc.w.document.querySelector('#chat-area .msg.ai:last-child')?.textContent||'';
      ck('留保付きの単一発話 '+q,output.length===1 && output[0].kind==='pit_reply_with_caveat'
        && output[0].text===shown && /復帰先が空いているとは言えない。$|cannot say the blend is clear\.$/.test(shown),shown);
    }
    for(const q of ['最後のピット、いつ入るのがいい？','最後のピットはいつ？','最後のピットインのタイミングは？','最後のピット、何周目に入る？']){
      const hc=await runFuji('early_loses');
      srv.queueReply(q,'仮。');
      await hc.say(q);
      ck('最後のピットの予定 '+q, !!hc.state.chats.at(-1)?.pitStrategyCompare?.undercut_forecast
        && trace(hc).some(t=>t.state==='queued'&&t.kind==='pit_calculated_reply'),hc.state.chatResponses.at(-1));
    }
    for(const q of ['最後のピットは何周目だった？','あのピットは何周目だった？','あのピットは何周目に入ってた？','前のピットは何周目にやった？','さっきのピットは何周目？']){
      const hc=await runFuji('early_loses',{missing:true});
      const opening='アンダーカットの合流は？';
      srv.queueReply(opening,'仮。');
      await hc.say(opening);
      const n=trace(hc).length, reply='最後のピットは5周目でした。';
      srv.queueReply(q,reply);
      await hc.say(q);
      const queued=trace(hc).slice(n).filter(t=>t.state==='queued');
      const shown=hc.w.document.querySelector('#chat-area .msg.ai:last-child')?.textContent||'';
      const expected=q.startsWith('前のピット')
        ? '直近の停止だけを照会できます。指定されたピットの周は確認できません。'
        : 'このレースの直近のピット周は、記録から確認できない。';
      ck('記録のない過去のピット周を尋ねる '+q,shown===expected && queued.map(t=>t.text).join('')===expected
        && !queued.some(t=>['pit_calculated_reply','pit_reply_with_caveat'].includes(t.kind)),{shown,queued});
    }
    const recorded=await runFuji('early_loses');
    await recorded.say('最後のピットは何周目だった？');
    const body=recorded.state.chats.at(-1), ctx=body.raceContext;
    const {race_instance_id,session_num}=ctx.race_identity;
    ctx.last_pit_event={lap:5,execution_relation:'normal',pit_event_id:'u2-recorded-pit',
      event_ref:{race_instance_id,session_num,pit_event_id:'u2-recorded-pit',driver_pit_sequence:1},
      service:null,source:'bridge_canonical'};
    const sendRecorded=async()=>{
      const res=await fetch(srv.url+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      return {intent:res.headers.get('x-pitwall-intent'),text:await res.text()};
    };
    const known=await sendRecorded();
    ck('過去のピット周は同じrace/sessionの実績値で答える',known.intent==='recorded_pit_lap'&&known.text.includes('5周目でした'),known);
    ctx.last_pit_event.event_ref.driver_pit_sequence=2;
    const lastQuestion=body.messages.at(-1);
    const askRecorded=async q=>{
      const original=lastQuestion.content;
      lastQuestion.content=q;
      try { return await sendRecorded(); } finally { lastQuestion.content=original; }
    };
    for(const q of ['1回目のピットは何周目だった？','最初のピットは何周目だった？',
      '初めてのピットは何周目だった？','1回目と2回目のピットは何周目だった？',
      '2回目と3回目のピットは何周目だった？']){
      const answer=await askRecorded(q);
      ck('最新の2回目を別の停止に流用しない '+q,answer.intent==='recorded_pit_lap'
        && answer.text.includes('指定されたピットの周は確認できません') && !answer.text.includes('5周目'),answer);
    }
    for(const q of ['2回目のピットは何周目だった？','２回目のピットは何周目だった？',
      '二回目のピットは何周目だった？']){
      const answer=await askRecorded(q);
      ck('序数が一致する場合だけ対象と周を答える '+q,answer.intent==='recorded_pit_lap'
        && answer.text.includes('2回目のピットは5周目'),answer);
    }
    for(const target of [
      '2つ目のピット','二つ目のピット','1つ目のピット','1本目のピット','2ピット目','第1ピット','第2回のピット',
      '初回のピット','初のピット','ファーストピット','セカンドピット','最初にピットに入ったの',
      '一つ前のピット','ひとつ前のピット','2つ前のピット','1回前のピット','前々回のピット','その前のピット',
      'もう一つ前のピット','最後の1つ前のピット','最後から2回目のピット','最後から2番目のピット',
      '今までのピット','何回ピットして','全部のピット','何回目のピット','2回目のピットとそれ以外のピット',
    ]){
      const answer=await askRecorded(target+'は何周目だった？');
      ck('対象が一意に一致しない停止は照会しない '+target,answer.intent==='recorded_pit_lap'
        && answer.text.includes('確認できません') && !answer.text.includes('5周目'),answer);
    }
    ctx.last_pit_event.event_ref.driver_pit_sequence='2';
    const nonInteger=await askRecorded('2回目のピットは何周目だった？');
    ck('文字列の停止順は数値の序数と一致しない',nonInteger.intent==='recorded_pit_lap'
      && nonInteger.text.includes('確認できません') && !nonInteger.text.includes('5周目'),nonInteger);
    const explicitLatest=await askRecorded('直近のピットは何周目だった？');
    ck('直近を明示した質問は直近の周を返す',explicitLatest.intent==='recorded_pit_lap'
      && explicitLatest.text.includes('直近のピットは5周目'),explicitLatest);
    ctx.last_pit_event.event_ref.driver_pit_sequence=1;
    const first=await askRecorded('最初のピットは何周目だった？');
    ck('直近が1回目なら1回目として答える',first.text.includes('1回目のピットは5周目'),first);
    ctx.last_pit_event.execution_relation='penalty';
    const penalty=await sendRecorded();
    ck('ペナルティ停止は区別して答える',penalty.text.includes('ペナルティ停止は5周目'),penalty);
    for(const lap of [0,ctx.current_facts.current_lap+1]){
      ctx.last_pit_event.lap=lap;
      const invalid=await sendRecorded();
      ck('現在周の範囲外のピット周は採用しない '+lap,invalid.text.includes('確認できない'),invalid);
    }
    ctx.last_pit_event.lap=5;
    ctx.last_pit_event.event_ref.race_instance_id='sub:other';
    const other=await sendRecorded();
    ck('別raceのピット周は採用しない', other.intent==='recorded_pit_lap'&&!other.text.includes('5周目')&&other.text.includes('確認できない'),other);
    const tight=await runFuji('wait_loses',{fuel:4});
    const tq='アンダーカットの合流は？';
    srv.queueReply(tq,'一周待ちましょう。');
    await tight.say(tq);
    const tightItem=trace(tight).find(t=>t.kind==='pit_calculated_reply'&&t.state==='queued');
    const tightU=tight.state.chats.at(-1)?.pitStrategyCompare?.undercut_forecast;
    ck('SAFE 次周に燃料が持たない時は今周の成立案を案内し、待たせない', !!tightItem && tightU?.action?.kind==='review_feasible_stop'
      && /9周目に.*完走できる案/.test(tightItem.text) && !/あと1周|一周待ち/.test(tightItem.text), {tightItem,action:tightU?.action});
    for (const change of ['calc_id','race','age']) {
      const ho=await runFuji('early_loses');
      const g=fs.mkdtempSync(path.join(os.tmpdir(),'u2-r4-barrier-'));
      const question='アンダーカットの合流はどう？';
      const invalid='ここなら行く手を横切る車は一切いません。';
      const n=trace(ho).length;
      srv.queueReply(question,[invalid,'追加の未確認情報です。'],{holdGateDir:g,holdAfterChunk:0});
      const turn=ho.say(question);
      try {
        for(let i=0;i<150 && !fs.existsSync(path.join(g,'arrived'));i++) await ho.sleep(10);
        const arrived=fs.existsSync(path.join(g,'arrived'));
        const leakedBefore=trace(ho).slice(n).some(t=>t.text?.includes(invalid));
        const old=fstate(ho);
        if(change==='calc_id') ho.ev("notePitCompareOpinion('前に詰まってる、アンダーカットは厳しいかも')");
        else if(change==='race') ho.ev("lastTelemetry={...lastTelemetry,race_instance_id:'sub:another'}");
        else ho.w.Date.now=()=>realNow()+60000;
        fs.writeFileSync(path.join(g,'release'),'');
        await turn;
        const result=trace(ho).slice(n);
        const item=result.find(t=>t.kind==='pit_calculated_reply'&&t.state==='queued');
        ck('FENCE '+change+' で待機中に失効。途中断定・旧版数値ともキューに流れない', arrived && !leakedBefore && old
          && (change!=='calc_id'||old.calc_id!==fstate(ho)?.calc_id)
          && !result.some(t=>t.text?.includes(invalid)||t.source?.ref?.calc_id===old.calc_id)
          && (change==='race'?!item:!!item && /残燃料とピット期限を今確認/.test(item.text)), {old:old?.calc_id,current:fstate(ho)?.calc_id,item});
      } finally {
        ho.w.Date.now=realNow;
        fs.writeFileSync(path.join(g,'release'),'');
      }
    }
    const queued=await runFuji('early_loses');
    queued.set('draining',true);
    const qq='通常ピットの合流は？';
    srv.queueReply(qq,'現時点で不明です。');
    await queued.say(qq);
    const beforeQueueDrop=trace(queued).find(t=>t.kind==='pit_calculated_reply'&&t.state==='queued');
    queued.ev("notePitCompareOpinion('前に詰まってる、アンダーカットは厳しいかも')");
    const ttsCount=queued.state.tts.length;
    queued.ev('draining=false;drainQueue()');
    await queued.sleep(80);
    const drop=trace(queued).find(t=>t.uid===beforeQueueDrop?.uid&&t.state==='dropped_before_audible');
    ck('FENCE 受理後に旧版となった計算回答は、キューから破棄されTTS・画面・履歴に残らない', !!drop && drop.reason==='stale_precondition'
      && queued.state.tts.length===ttsCount
      && !queued.w.document.querySelector('#chat-area .msg.ai:last-child')?.textContent?.includes('合流時')
      && !queued.ev("messages.some(m=>m.role==='assistant'&&m.content.includes('合流時'))"), {beforeQueueDrop,drop});
    ck('E2 富士の実行中にもJSエラーなし', hw.state.errors.length === 0 && he.state.errors.length === 0, hw.state.errors.concat(he.state.errors).slice(0, 3));
  });
  console.log('\n=== U2 undercut e2e: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS_ERROR', e); process.exit(2); });
