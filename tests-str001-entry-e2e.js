#!/usr/bin/env node
'use strict';
// STR-001 — 実入口の通し検査：保存レース(Montreal sub:89653165)のLapごとの入力を実 irBridge.onmessage(telemetry_live)へ流し、
//   実 sendMsg → 実 local-intent-router → 実 callAPI → 実 server.js(子プロセス・実HTTP) → 実 buildSystem → (偽SDK) → 実 speak/finalizeUtterance まで通す。
//   質問 → 計算版(calc_id) → 送信payload → サーバが作ったsystem prompt → 返答 → 訂正 → 新しい計算版 を追う。
// 実:    renderer.html全体、全module、sendMsg、router、callAPI、server.js、buildSystem、speak/finalize、pit-strategy-compare
// 代替:  Anthropic SDK(保存応答)、Audio、WebSocket(Bridgeのpython本体は動かさない)、window.pitwall
// 未検証: 実LLMの意味、実音声、実Bridge(python/iRacing)、実Electron、実Windows。STR001_ROOT=<旧tree>で旧版(Build306)を同入力で実行できる。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./tests-fullrenderer-harness.js');
const R = require('./fixtures/str001/replay-inputs.js');
const C = require('./desktop/pit-strategy-compare.js');
const ROOT = process.env.STR001_ROOT || __dirname;
const FIXROOT = __dirname;

let pass = 0, fail = 0;
const ck = (name, ok, detail) => { (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + name + (ok ? '' : ' -> ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 500))); ok ? pass++ : fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isOld = !fs.existsSync(path.join(ROOT, 'desktop', 'pit-strategy-compare.js'));

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'str001-'));
  const queue = path.join(dir, 'queue'); fs.mkdirSync(queue);
  const capture = path.join(dir, 'system.jsonl');
  const port = 21000 + Math.floor(Math.random() * 3000);
  const child = spawn(process.execPath, ['-r', path.join(FIXROOT, 'tests-wo001-anthropic-stream-stub-preload.js'), 'server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: 'sk-test-local-stub', DATABASE_URL: '', JWT_SECRET: '', STRIPE_SECRET_KEY: '',
      WO019_SDK_QUEUE_DIR: queue, WO014_SYSTEM_CAPTURE_FILE: capture } });
  const logs = [];
  child.stdout.on('data', d => logs.push(String(d))); child.stderr.on('data', d => logs.push(String(d)));
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('server start timeout')), 20000); child.stdout.on('data', d => { if (String(d).includes('is running')) { clearTimeout(t); res(); } }); child.on('exit', c => { clearTimeout(t); rej(new Error('server exited ' + c)); }); });
  let seq = 0;
  const api = {
    url: 'http://127.0.0.1:' + port, logs,
    queueReply: (forUserText, text) => fs.writeFileSync(path.join(queue, String(++seq).padStart(3, '0') + '-r.json'), JSON.stringify({ forUserText, chunks: [text] })),
    captured: () => (fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
  };
  try { return await fn(api); } finally { child.kill('SIGTERM'); }
}

const fx = R.load();
const bridgeMsg = (h, snap, row, input) => {
  const comps = [];
  if (row.gap_ahead_s != null && row.gap_ahead_s > 0) comps.push({ car_idx: 11, car_number: '11', class_pos: Math.max(1, (row.pos || 2) - 1), gap_s: -row.gap_ahead_s, lap: row.lap, last_lap_s: null });
  if (row.gap_behind_s != null && row.gap_behind_s > 0) comps.push({ car_idx: 12, car_number: '12', class_pos: (row.pos || 1) + 1, gap_s: row.gap_behind_s, lap: row.lap, last_lap_s: null });
  return { type: 'telemetry_live', lap: row.lap, fuel: row.fuel_l, pos: row.pos, class_pos: row.pos, last: row.last_lap_s, best: input && input.own.best_clean_lap_s ? input.own.best_clean_lap_s.value : null,
    driver_pace_median_s: input && input.own.lap_time_s ? input.own.lap_time_s.value : null, session_time_remaining_s: row.time_remaining_s,
    gap_ahead: row.gap_ahead_s, gap_behind: row.gap_behind_s, competitors: comps, cust_id: 7, session_type: 'Race', session_num: snap.session_num,
    track: 'Circuit Gilles Villeneuve', car_model: 'Mercedes-AMG GT3 2020', car_class: 'GT3', on_track: true, on_pit_road: false,
    race_instance_id: snap.race_instance_id, bridge_process_epoch: snap.bridge_process_epoch, canonical_snapshot_id: snap.snapshot_id,
    canonical_snapshot_sequence: snap.snapshot_sequence, source_frame_sequence: snap.source_frame.sequence };
};
async function feedLaps(h, upTo) {
  // 練習走行中の最初の観測(満タン53L)から、各Lapの観測を実 telemetry_live として流す
  const warm = { lap: 0, fuel_l: 53.0, pos: 24, last_lap_s: null, gap_ahead_s: null, gap_behind_s: null, time_remaining_s: null };
  let snap = h.raceSnap({ race: fx.race_instance_id, driver: 7, session: 0, lap: 0, fuel: 53.0 });
  await h.bridge(bridgeMsg(h, snap, warm, null));
  for (let lap = 1; lap <= upTo; lap++) {
    const row = fx.rows.find(r => r.lap === lap);
    if (!row || row.fuel_l == null) continue;
    const input = R.replayInputAt(fx, lap);
    snap = h.raceSnap({ race: fx.race_instance_id, driver: 7, session: 0, lap, fuel: row.fuel_l });
    await h.bridge(bridgeMsg(h, snap, row, input));
  }
  return snap;
}
const packetFromSystem = sysText => { const m = String(sysText).match(/PIT STRATEGY COMPARE[\s\S]*?\n(\{.*\})\n/); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };
const speakText = h => h.diag(/LunaJP\]/).map(t => t.replace(/^\[LunaJP\]\s*/, ''));

(async () => {
  console.log('tree: ' + ROOT + (isOld ? '  (旧版 Build306：pit-strategy-compare 無し)' : ''));
  const QUESTION = '今ピットに入るのと、アンダーカットはどっちが得？';
  await withServer(async srv => {
    const h = H.boot({ root: ROOT, chatForward: srv.url, localStorage: { pw_auth_user: { id: 'u1' }, pw_auth_token: 'tok-u1' }, user: { id: 'u1', isMember: true, displayName: 'T' } });
    await h.sleep(300);
    h.set('selMode', 'race'); h.set('sel', 'LunaJP'); h.set('iracingLive', true); h.set('bridgeConnected', true);
    h.set('fuelWindowMarginL', 0.5);   // このMontreal入力の期待値は予備0.5L前提（旧：固定0.5L）。燃料余裕を既定の1周分(約3L)にすると早い案が『1回の給油で完走できない』で除外されるため、直接L指定で従来の0.5Lへ固定する（余裕の接続自体は tests-race-rules-e2e 5a〜5e）
    await feedLaps(h, 8);
    const lapNow = h.ev('lastTelemetry && lastTelemetry.lap');
    ck('E0 前提：実telemetry_liveの受信で、現在Lap=8・保存レースのraceが実rendererの状態に入る', lapNow === 8 && h.ev('lastTelemetry.race_instance_id') === fx.race_instance_id, { lapNow });
    if (!isOld) {
      const st = h.ev('JSON.stringify({calc:pitCompareState.packet&&pitCompareState.packet.calc_id,lap:pitCompareState.packet&&pitCompareState.packet.observed_at.lap,comparable:pitCompareState.packet&&pitCompareState.packet.comparable,hist:pitCompareState.history.length})');
      const s = JSON.parse(st);
      ck('E1 毎Lap再計算：Lap1〜8の各Lapで計算版が更新され（履歴≥6件）、現在はLap8の比較が成立している', s.comparable === true && s.lap === 8 && s.hist >= 6, s);
    }
    // ── 質問 ──
    const before = { chats: h.state.chats.length, route: h.state.router.route };
    srv.queueReply(QUESTION, '仮の返答。');   // 先に保存応答を置く（forUserText一致）。中身は次で差し替えず、まず到達を見る
    await h.say(QUESTION);
    const routed = h.state.router.handled.slice(-1)[0];
    const reached = h.state.chats.length > before.chats;
    ck('E2 実routerを通った（router.routeが呼ばれた＝迂回していない）', h.state.router.route > before.route, h.state.router.route);
    if (isOld) {
      ck('E3(旧版) 旧版では戦略相談がrouterの固定応答で終端する（LLMへ届かない）＝新方針の前提が成立していない', routed !== null && !reached, { routed, reached });
      console.log('[旧版の固定応答] ' + (speakText(h).slice(-1)[0] || '').slice(0, 120));
      return;
    }
    ck('E3 戦略相談は固定応答で終端せず、LUNA(LLM)へ届く', routed === null && reached, { routed, reached });
    const body = h.state.chats[h.state.chats.length - 1];
    const pkt = body && body.pitStrategyCompare;
    ck('E4 送信payloadに有効な計算パケット（計算版・Lap8・race一致・comparable）が入る', !!pkt && pkt.comparable === true && pkt.observed_at.lap === 8 && pkt.race.race_instance_id === fx.race_instance_id && C.validatePacket(pkt, { race_instance_id: fx.race_instance_id, session_num: 0, lap: 8 }).ok, pkt && { lap: pkt.observed_at.lap, v: C.validatePacket(pkt, {}) });
    ck('E5 パケットは3案（通常・アンダーカット・オーバーカット）と出所ラベル付き入力・暫定の幅・判断期限を持つ', pkt && ['normal', 'undercut', 'overcut'].every(k => pkt.cases.some(c => c.kind === k))
      && pkt.inputs.every(r => C.SOURCES.includes(r.source)) && pkt.inputs.some(r => r.source === 'assumed') && pkt.inputs.some(r => r.source === 'observed') && pkt.recommendation && Number.isInteger(pkt.recommendation.decide_by_lap));
    // サーバーが実際に組んだsystem promptに、同じ計算版が入っている
    const cap = srv.captured();
    const sys = cap.length ? cap[cap.length - 1].system : '';
    const sysPkt = packetFromSystem(sys);
    ck('E6 実server.jsのsystem promptに、payloadと同じ計算版(calc_id)のパケットとLUNA向け指示が入る', !!sysPkt && sysPkt.id === pkt.calc_id && /推奨案と基準案の差、必要ペース、判断期限/.test(sys) && /数値を創作しない/.test(sys), { sysPkt: sysPkt && sysPkt.id, pkt: pkt.calc_id });
    ck('E7 サーバーの応答は決定論ではなくLLM経路（authority≠deterministic）', h.state.chatResponses.length > 0 && h.state.chatResponses[h.state.chatResponses.length - 1].authority !== 'deterministic', h.state.chatResponses.slice(-1));
    ck('E8 サーバーのログに受理(accepted)と、戦略質問をLLMへ渡した記録がある（固定の復帰/校正応答が出ていない）', srv.logs.join('').includes('[pit_compare] accepted calc_id=' + pkt.calc_id) && !/-> calibration reply|-> live-data reply|-> Phase C reply/.test(srv.logs.join('')), srv.logs.join('').split('\n').filter(l => /pit_compare|strategy_guard/.test(l)).slice(-4));
    // 保存応答を、サーバーが実際に渡したパケットの値から組み立てる（LLMの意味品質ではなく、値の受け渡しを追う）
    const rec = sysPkt.rec;
    const reply1 = `基準は${sysPkt.baseline.pit_lap}周目。いまの推奨は${rec.kind === 'normal' ? '通常案' : rec.case}で${rec.pit_lap}周目、${rec.add_l}L。差は交通次第。判断は${rec.decide_by_lap}周まで。`;
    // 先に置いた「仮の返答」は消費済みのため、同じ質問への2回目の質問で検証する
    srv.queueReply('もう一度、', reply1);
    await h.say('もう一度、' + QUESTION);
    const shown = speakText(h).slice(-1)[0] || '';
    if (process.env.STR001_DEBUG) console.log(h.diag(/LunaJP\]|LOCAL_INTENT|USER\]|INTENT_ROUTE|PIT_COMPARE/).slice(-12).join('\n'));
    const body2 = h.state.chats[h.state.chats.length - 1];
    ck('E9 返答の数値(基準周・推奨周・給油量・判断期限)は、同じ計算版のパケットの値と一致して画面/発話に出る', shown.includes(String(sysPkt.baseline.pit_lap) + '周目') && shown.includes(rec.add_l + 'L') && shown.includes(String(rec.decide_by_lap) + '周'), shown);
    ck('E10 同じLapの再質問では計算版が変わらない（同じ入力→同じ計算版）', body2.pitStrategyCompare && body2.pitStrategyCompare.calc_id === pkt.calc_id, [body2.pitStrategyCompare && body2.pitStrategyCompare.calc_id, pkt.calc_id]);

    // 従来はサーバーの固定の復帰/校正応答が終端していた質問（今ピットに入ると何番手で復帰する？）でも、有効な計算パケットがあればLLMへ渡る
    const nBefore = h.state.chatResponses.length;
    srv.queueReply('何番手で復帰', 'ok復帰');
    await h.say('今ピットに入ると何番手で復帰する？');
    const rr = h.state.chatResponses[h.state.chatResponses.length - 1];
    ck('E23 サーバーの固定の復帰/校正応答で終端していた質問も、有効な計算パケットがあればLLM経路（authority≠deterministic）で、パケットがsystemに入る',
      h.state.chatResponses.length > nBefore && rr.authority !== 'deterministic' && /PIT STRATEGY COMPARE/.test(srv.captured().slice(-1)[0].system) && srv.logs.join('').includes('strategy question passes to LLM'),
      { rr, logs: srv.logs.join('').split('\n').filter(l => /pit_compare|strategy_guard/.test(l)).slice(-3) });
    // ── Driverの意見 → 再計算 → 再提案 ──
    const OPINION = '前に詰まってる、アンダーカットは厳しいかも';
    srv.queueReply(OPINION, '了解。前の交通を3秒見込んで計算し直した。');
    await h.say(OPINION);
    const body3 = h.state.chats[h.state.chats.length - 1];
    const p3 = body3.pitStrategyCompare;
    ck('E11 意見の発話で計算版が更新され(calc_idが変わる)、意見は観測ではなく仮定(driver_declared)として記録される',
      p3 && p3.calc_id !== pkt.calc_id && p3.driver_assumptions.some(a => a.kind === 'traffic' && a.source === 'driver_declared') && p3.inputs.some(r => r.key === 'traffic.extra_s' && r.source === 'driver_declared'), p3 && p3.driver_assumptions);
    const sys3 = packetFromSystem(srv.captured().slice(-1)[0].system);
    ck('E12 サーバーのsystem promptにも、更新後の計算版(新しいcalc_id)が入る＝LUNAは更新後の数値で再提案できる', sys3 && sys3.id === p3.calc_id, [sys3 && sys3.id, p3 && p3.calc_id]);
    const u3 = p3.cases.find(c => c.id === 'under1');
    ck('E13 追加された交通損失はアンダーカット案にだけ入る（通常案には入らない）', u3 && u3.rejoin.traffic_extra_declared_s > 0 && (((p3.cases.find(c => c.id === 'normal') || {}).rejoin || {}).traffic_extra_declared_s ?? 0) === 0, u3 && u3.rejoin);
    // ── 古い計算版・別race/sessionの提案は渡さない ──
    const snap9 = h.raceSnap({ race: fx.race_instance_id, driver: 7, session: 0, lap: 9, fuel: fx.rows.find(r => r.lap === 9).fuel_l });
    await h.bridge(bridgeMsg(h, snap9, fx.rows.find(r => r.lap === 9), R.replayInputAt(fx, 9)));
    if (process.env.STR001_DEBUG) console.log('after lap9 feed: lap=' + h.ev('lastTelemetry.lap') + ' ' + h.diag(/PIT_COMPARE/).slice(-2).join(' | ') + ' errs=' + JSON.stringify(h.state.errors));
    srv.queueReply('オーバーカット', '次の計算で答える。');
    await h.say('アンダーカットとオーバーカット、どっちが得？');
    if (process.env.STR001_DEBUG) console.log(h.diag(/USER\]|LOCAL_INTENT|INTENT_ROUTE|LunaJP\]/).slice(-5).join('\n'));
    const p4 = h.state.chats[h.state.chats.length - 1].pitStrategyCompare;
    ck('E14 Lapが進むと計算が更新され、Lap9のパケットが送られる（Lap8の計算版は送られない）。Driverの意見は同じraceの間だけ引き継ぐ', p4 && p4.observed_at.lap === 9 && p4.calc_id !== p3.calc_id && p4.driver_assumptions.length >= 1, p4 && { lap: p4.observed_at.lap });
    // サーバー側の検証：偽造/古いパケットを実HTTPで直接送っても、systemへ入れずに拒否する
    const real = h.state.chats.find(b => b.pitStrategyCompare && b.pitStrategyCompare.observed_at.lap === 9) || h.state.chats.find(b => b.pitStrategyCompare);
    // rehash=true：改ざん後にcalc_idを内容のhashで付け直す（＝calc_id検査ではなく、race/Lap/計算版の検査を単独で試す）
    const post = async (mut, rehash = true) => { const b = JSON.parse(JSON.stringify(real)); mut(b); if (rehash) { const { calc_id, ...rest } = b.pitStrategyCompare; b.pitStrategyCompare.calc_id = C.hashString(JSON.stringify(rest)); } srv.queueReply('サーバー検証', 'ok'); b.messages = b.messages.concat([{ role: 'user', content: 'サーバー検証' }]); const r = await fetch(srv.url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); await r.text(); return srv.captured().slice(-1)[0]; };
    const forged = await post(b => { b.pitStrategyCompare.race.race_instance_id = 'sub:other'; });
    if (process.env.STR001_DEBUG) console.log('forged logs: ' + srv.logs.join('').split('\n').filter(l => /pit_compare/.test(l)).join(' | '));
    ck('E20 別raceのパケットをサーバーへ直接送っても拒否される（race_mismatch・systemに入らない）', forged && !/PIT STRATEGY COMPARE/.test(forged.system) && srv.logs.join('').includes('[pit_compare] rejected: race_mismatch'), srv.logs.join('').split('\n').filter(l => /pit_compare/.test(l)).slice(-2));
    const oldVer = await post(b => { b.pitStrategyCompare.calc_version = 'str001-compare-0.0.1'; });
    ck('E21 計算版が違うパケットも拒否される（calc_version）', oldVer && !/PIT STRATEGY COMPARE/.test(oldVer.system) && srv.logs.join('').includes('rejected: calc_version'));
    const staleLap = await post(b => { b.pitStrategyCompare.expires.valid_until_lap = (b.raceContext.current_facts.current_lap || 9) - 1; });
    ck('E24 古いLapのパケット（valid_until_lap < 現在Lap）をサーバーへ直接送ると stale_lap で拒否される（systemに入らない）', staleLap && !/PIT STRATEGY COMPARE/.test(staleLap.system) && srv.logs.join('').includes('rejected: stale_lap'), srv.logs.join('').split('\n').filter(l => /pit_compare/.test(l)).slice(-2));
    const noLap = await post(b => { b.raceContext.current_facts = { available: false, reason: 'test_unavailable', source_frame: null, scope_ref: null, current_lap: null, fuel_level_l: null, lap_dist_pct: null, on_pit_road: null, on_track: null, finish: { available: false, remaining_sf_crossings: null } }; });
    ck('E26 現在周が不明（current_factsが使えない）時は、他の条件が全て正しいパケットでも拒否される（no_current_lap・systemに入らない）', noLap && !/PIT STRATEGY COMPARE/.test(noLap.system) && srv.logs.join('').includes('rejected: no_current_lap'), srv.logs.join('').split('\n').filter(l => /pit_compare/.test(l)).slice(-2));
    const tampered = await post(b => { b.pitStrategyCompare.recommendation.add_l = 1; }, false);
    ck('E25 内容を書き換えたパケット（calc_idと内容が不一致）は calc_id_mismatch で拒否される', tampered && !/PIT STRATEGY COMPARE/.test(tampered.system) && srv.logs.join('').includes('rejected: calc_id_mismatch'));
    const nocomp = await post(b => { b.pitStrategyCompare.comparable = false; });
    ck('E22 比較が成立していない(comparable=false)パケットはLUNAへ渡さない', nocomp && !/PIT STRATEGY COMPARE/.test(nocomp.system));
    // ── キャッシュ対象のprefixに毎Lap変わる塊を入れない／戦略相談でないchatには載せない（費用）──
    {
      const caps = srv.captured();
      const withPkt = caps.filter(c => /PIT STRATEGY COMPARE/.test(c.system));
      const lastWith = withPkt[withPkt.length - 1];
      ck('C1 計算パケットは非キャッシュの別ブロックで末尾に付き、cache_control付きのprefixには入らない', !!lastWith && lastWith.system_blocks.length >= 2 && lastWith.system_blocks.filter(b => /PIT STRATEGY COMPARE/.test(b.text)).every(b => b.cached === false) && lastWith.system_blocks.filter(b => b.cached).every(b => !/PIT STRATEGY COMPARE/.test(b.text)), lastWith && lastWith.system_blocks.map(b => [b.cached, b.text.length, /PIT STRATEGY/.test(b.text)]));
      // 戦略相談でない雑談を続ける：相談の直後2発話までは続き（「なんで？」等）として載り得るが、その後は載らない。LLMへ実際に届いた送信で確認する。
      const nb = h.state.chats.length;
      for (const t of ['この後も集中していくよ', '今日は調子いいな', 'ここから落ち着いて走るよ']) { srv.queueReply(t, 'うん。'); await h.say(t); }
      const sentNon = h.state.chats.slice(nb);
      const capNon = srv.captured().slice(-1)[0];
      ck('C2 戦略相談でない雑談がLLMへ届いた送信（' + sentNon.length + '件）の、相談から3発話目以降には計算パケットを載せず、systemにも入らない', sentNon.length === 3 && sentNon[2].pitStrategyCompare === null && !/PIT STRATEGY COMPARE/.test(capNon.system), sentNon.map(b => !!b.pitStrategyCompare));
      ck('C3 戦略相談1回あたりの増分：塊は約' + (C.promptBlock(pkt).length) + '字（旧設計 約4.8k字）。LLM呼出しは固定応答だった戦略質問が1回ずつ増える', C.promptBlock(pkt).length < 3500);
    }
    // ── Truth Gate（実flow）：パケットと偶然一致し得る捏造は止まり、パケット由来の正しい返答は通る ──
    {
      const sayAndRead = async (q, reply) => { srv.queueReply(q, reply); const n = speakText(h).length, nc = h.state.chats.length; await h.say(q); const t = speakText(h); return h.state.chats.length > nc && t.length > n ? t[t.length - 1] : null; };   // LLMへ届いた時だけ読む
      const q1 = 'ピットに入るタイミング、燃料の面でどう？';
      const shown1 = await sayAndRead(q1, '燃料は14Lあります。');
      ck('T-flow1 戦略相談への返答でも、パケットに無い／役割違いの燃料数値（14L）は止まり、そのまま発話されない', shown1 !== null && !/14L/.test(shown1), shown1);
      const q2 = '今ピットに入ったら復帰は何番手になりそう？';
      const shown2 = await sayAndRead(q2, '入っても2位まで上がれます。');
      if (process.env.STR001_DEBUG) console.log('shown2=' + shown2 + ' consulting=' + h.ev('pitCompareState.consultTurnsLeft') + ' valid=' + h.ev('currentPitStrategyCompare().valid') + ' reply-chat-packet=' + !!h.state.chats[h.state.chats.length-1].pitStrategyCompare);
      ck('T-flow2 パケットに無い順位claim（2位）は止まる', shown2 !== null && !/2位/.test(shown2), shown2);
    }
    // ── 実応答→発話：項目ごとに照合（現燃料／追加給油／GAP／ピットロス）。正しい文は通り、数値が同じ別項目の文は止まる ──
    {
      const lastPkt = h.state.chats.slice().reverse().find(b => b.pitStrategyCompare).pitStrategyCompare;
      const f1 = x => (Math.round(x * 10) / 10).toString();
      const add = lastPkt.baseline.add_l, nowFuel = lastPkt.inputs.find(r => r.key === 'own.fuel_l').value;
      const loss = lastPkt.cases.find(c => c.id === 'normal').pit_loss_s.value;
      const gapNow = Math.abs(lastPkt.inputs.find(r => /^field\..*\.gap_s$/.test(r.key)).value);
      const read = async (q, reply) => { srv.queueReply(q, reply); const n = speakText(h).length, nc = h.state.chats.length; await h.say(q); const t = speakText(h); return h.state.chats.length > nc && t.length > n ? t[t.length - 1] : null; };
      const qs = ['今ピットに入ると何番手で復帰する？', 'ピットに入るタイミング、どう？', 'いつピットに入ればいい？', 'アンダーカットとオーバーカット、どっちが得？'];
      const okAdd = await read(qs[0], '追加給油は' + f1(add) + 'リットルです。');
      ck('T-flow3 正しい項目（追加給油量）はそのまま発話される', okAdd !== null && okAdd.includes(f1(add)), okAdd);
      const wrongFuel = await read(qs[1], '残り燃料は' + f1(add) + 'リットルです。');
      ck('T-flow4 同じ数値でも項目が違う「残り燃料は(追加給油量)リットル」は止まる（実応答→発話）', wrongFuel !== null && !wrongFuel.includes(f1(add) + 'リットル'), wrongFuel);
      const okNow = await read(qs[2], '残り燃料は' + f1(nowFuel) + 'リットルです。');
      ck('T-flow5 現在の燃料量を「残り燃料」として言う正しい文は通る', okNow !== null && okNow.includes(f1(nowFuel)), okNow);
      const wrongLoss = await read(qs[3], 'ピットロスは' + f1(gapNow) + '秒です。');
      ck('T-flow6 GAPの値を「ピットロス」として言う取り違えは止まる（監査の例）', wrongLoss !== null && !wrongLoss.includes('ピットロスは' + f1(gapNow)), wrongLoss);
      const okLoss = await read(qs[0], 'ピットロスは約' + Math.round(loss) + '秒です。');
      ck('T-flow7 正しいピットロスの文は通る', okLoss !== null && okLoss.includes(String(Math.round(loss))), okLoss);
    }
    // ── 実入口：延長が成立する例と燃料で除外される例（Lap9・同じ送信パケットの中）／基準は暫定基準で燃料の限界周ではない ──
    {
      const lp = h.state.chats.slice().reverse().find(b => b.pitStrategyCompare).pitStrategyCompare;
      const o1 = lp.cases.find(c => c.id === 'over1'), o2 = lp.cases.find(c => c.id === 'over2');
      ck('X1 実入口の送信パケット：1周延ばす案は成立（燃料制約を満たす）、2周延ばす案は燃料で除外される。基準は暫定基準（燃料の限界周ではない）', o1 && o1.excluded === null && o2 && o2.excluded === 'fuel_insufficient_to_reach_pit' && /provisional_even_split/.test(lp.baseline.derived_from) && lp.baseline.pit_lap < o1.pit_lap, { o1: o1 && o1.excluded, o2: o2 && o2.excluded, base: lp.baseline });
      ck('X1b 燃料重量係数の感度（k=0/中央/上限）がパケットに入り、推奨が反転するなら条件付き(conditional_on_fuel_weight)で出る', Array.isArray(lp.sensitivity.fuel_weight) && lp.sensitivity.fuel_weight.length === 3 && typeof lp.recommendation.conditional_on_fuel_weight === 'boolean');
      const planFn = h.ev("(() => { const live = Object.assign({}, lastTelemetry, { strategy_options: { available: true, plan_a: { available: true, target_lap: 14 } } }); const i = pitCompareInputFromLive(live); const j = pitCompareInputFromLive(Object.assign({}, lastTelemetry, { strategy_options: { available: true, plan_a: { available: false, target_lap: 14 } } })); const k = pitCompareInputFromLive(Object.assign({}, lastTelemetry, { strategy_options: { available: true, plan_a: { available: true, target_lap: 3 } } })); return JSON.stringify([i.baseline_pit_lap, i.baseline_source, j.baseline_source, k.baseline_source]); })()");
      const pf = JSON.parse(planFn);
      ck('X2 実rendererの入力組立：現行の燃料計画(plan_a・有効)の周を基準にする。無効/過去周のplan_aは使わず暫定基準に落とす', pf[0] === 14 && /plan_a/.test(pf[1]) && /provisional/.test(pf[2]) && /provisional/.test(pf[3]), pf);
    }
    // ── LLM実行は1ターン1回（初版の暫定上限）と、呼出し回数・応答時間・token記録 ──
    {
      const q = 'アンダーカットは使える？';
      srv.queueReply(q, 'ok1'); const c0 = h.state.chats.length;
      await h.say(q);
      const turnNow = h.ev('turns');
      srv.queueReply(q, 'ok2');
      await h.w.callAPI('typed');                       // 同じDriverターンの2回目のLLM実行
      const two = h.state.chats.slice(c0);
      ck('L1 同じDriverターンの2回目のLLM実行には計算パケットを載せない（1ターン1回の暫定上限）。1回目は載る', two.length === 2 && !!two[0].pitStrategyCompare && two[1].pitStrategyCompare === null && h.diag(/PIT_COMPARE_LLM_CAP/).length >= 1, two.map(b => !!b.pitStrategyCompare));
      const rec = JSON.parse(h.ev('JSON.stringify(pitCompareState.llm.log.slice(-1)[0])'));
      ck('L2 戦略相談のLLM実行ごとに、turn・calc_id・呼出し回数・応答時間(ms)・返答長を記録する（周回更新はローカル計算でLLMを呼ばない）', rec && rec.turn === turnNow && /^[0-9a-f]{8}$/.test(rec.calc_id) && rec.calls === 1 && Number.isFinite(rec.ms) && rec.reply_chars > 0 && h.diag(/PIT_COMPARE_LLM\] \{/).length >= 1, rec);
      ck('L3 サーバーが入力/出力token・キャッシュ・応答時間を記録する（[pit_compare] usage）', /\[pit_compare\] usage calc_id=[0-9a-f]{8} in=\d+ out=\d+ cache_read=\d+ cache_write=\d+ ms=\d+/.test(srv.logs.join('')), srv.logs.join('').split('\n').filter(l => /pit_compare\] usage/.test(l)).slice(-1));
      const lapCalls0 = h.state.chats.length;
      const sn = h.ev('canonicalLifecycleCache.current()');
      const lapRow = fx.rows.find(r => r.lap === 9);
      await h.bridge(Object.assign(bridgeMsg(h, sn, lapRow, R.replayInputAt(fx, 9)), { competitors: [] }));
      ck('L4 テレメトリ（周回・顔ぶれの更新）だけではLLMを呼ばない（ローカル計算のみ）', h.state.chats.length === lapCalls0);
    }
    // ── 符号と対象車を値で固定：前の車は3.0秒先（Bridgeのgap_s=−3.0）、後ろの車は2.0秒後ろ（+2.0）。顔ぶれが変われば同Lapでも再計算される ──
    {
      const snapNow = h.ev('canonicalLifecycleCache.current()');
      const row9 = fx.rows.find(r => r.lap === 9);
      const mk = comps => Object.assign(bridgeMsg(h, snapNow, row9, R.replayInputAt(fx, 9)), { competitors: comps });
      const hist0 = h.ev('pitCompareState.history.length');
      await h.bridge(mk([{ car_idx: 21, car_number: '21', class_pos: 17, gap_s: -3.0, last_lap_s: 96.4 }, { car_idx: 22, car_number: '22', class_pos: 19, gap_s: 2.0, last_lap_s: 96.9 }]));
      const w = JSON.parse(h.ev('JSON.stringify(pitCompareState.packet)'));
      const inp = k => (w.inputs.find(r => r.key === k) || {}).value;
      ck('W1 顔ぶれが変わると同じLapでも再計算される（履歴が増え、reason=neighbors_changed）', h.ev('pitCompareState.history.length') > hist0 && h.ev('pitCompareState.history.slice(-1)[0].reason') === 'neighbors_changed', h.ev('pitCompareState.history.slice(-1)[0]'));
      ck('W2 対象車（比べる相手）は「前の車」car21、そのGAPは+3.0（自車の到達が3.0秒遅い＝相手が先）', w.target && w.target.id === 'car21' && w.target.gap_now_s === 3, w.target);
      ck('W3 後ろの車car22のGAPは−2.0（自車が先）。前の車と符号が逆', inp('field.car21.gap_s') === 3 && inp('field.car22.gap_s') === -2, [inp('field.car21.gap_s'), inp('field.car22.gap_s')]);
      ck('W4 相手の前Lapタイム（96.4/96.9）は観測として入る', w.inputs.find(r => r.key === 'field.car21.lap_time_s').source === 'observed' && inp('field.car21.lap_time_s') === 96.4);
      // on_pitの契約：車ID・同一frame（観測時刻）に紐付くtrueだけを「観測」とする。frameが無い／古い／null/欠測は「不明」（観測にも「入っていない」にもしない）。
      const fseq = snapNow.source_frame.sequence;
      const compsWith = extra => [Object.assign({ car_idx: 21, car_number: '21', class_pos: 17, gap_s: -3.0, last_lap_s: 96.4 }, extra), { car_idx: 22, car_number: '22', class_pos: 19, gap_s: 2.0, last_lap_s: 96.9 }];
      const scen = pk => pk.cases.find(c => c.comparisons.length).comparisons.filter(x => x.rival_id === 'car21').map(x => x.scenario + ':' + x.scenario_basis);
      for (const [label, extra] of [['frame無しのon_pit=true', { on_pit: true }], ['古いframeのon_pit=true', { on_pit: true, on_pit_frame: fseq - 5 }], ['on_pit=null（取得不能）', { on_pit: null, on_pit_frame: fseq }]]) {
        await h.bridge(mk(compsWith(extra)));
        h.ev("updatePitStrategyCompare(lastTelemetry, 'test_force')");   // 顔ぶれ再計算の契機に依らず、受信した値そのものから再計算して判定する
        const wu = JSON.parse(h.ev('JSON.stringify(pitCompareState.packet)'));
        ck('W5u ' + label + ' は「不明」：相手の停止は観測にならず、早い/遅いの条件別のまま', scen(wu).every(x => /rival_stops_(early|late):assumed/.test(x)) && !scen(wu).some(x => /in_pit_now/.test(x)), scen(wu));
      }
      await h.bridge(mk(compsWith({ on_pit: true, on_pit_frame: fseq })));
      const w2 = JSON.parse(h.ev('JSON.stringify(pitCompareState.packet)'));
      ck('W5 相手が入った（Bridgeが同一frameのon_pit=trueを出した）と再計算され、その相手の想定は「rival_in_pit_now（観測）」になる', scen(w2).some(x => x === 'rival_in_pit_now:observed'), scen(w2));
      // Driver申告は別経路：同じ「相手が入った」でも basis は driver_declared のまま（観測へ昇格しない）
      await h.bridge(mk(compsWith({})));
      await h.say('前の車ピットに入った');
      const wd = JSON.parse(h.ev('JSON.stringify(pitCompareState.packet)'));
      ck('W6 Driver申告「前の車がピットに入った」は rival_pitted_declared（driver_declared）。観測(rival_in_pit_now:observed)にならない', scen(wd).some(x => x === 'rival_pitted_declared:driver_declared') && !scen(wd).some(x => /:observed/.test(x)), scen(wd));
    }
    // 別race(別session)に入ったら、前の意見・計算版を持ち越さない
    const other = h.raceSnap({ race: 'sub:99999999', driver: 7, session: 0, lap: 3, fuel: 40 });
    await h.bridge(Object.assign(bridgeMsg(h, other, { lap: 3, fuel_l: 40, pos: 5, last_lap_s: 96, gap_ahead_s: 3, gap_behind_s: 4, time_remaining_s: 2000 }, null), { driver_pace_median_s: 96 }));
    const stale = h.ev('JSON.stringify(currentPitStrategyCompare())');
    const so = JSON.parse(stale);
    ck('E15 別raceへ移ると、前のraceの計算パケットは有効扱いにならず(valid=false)、Driverの意見も持ち越さない',
      !(so.valid === true && so.packet && so.packet.race.race_instance_id === fx.race_instance_id) && h.ev('pitCompareState.opinions.length') === 0, so.reasons);
    // 古い計算パケットが状態に残っていても（再計算の取りこぼしを模擬）、別raceの今は送らない（従来の経路で答える）
    h.ev('pitCompareState.packet = ' + JSON.stringify(p3));   // 旧race(Lap8・意見つき)のパケットを状態へ戻す
    const n19 = h.state.chats.length;
    await h.say('今ピットに入ると何番手で復帰する？');
    const sent19 = h.state.chats.slice(n19);
    ck('E19 状態に残った古い(別race)パケットは、送信時の検証で落ちて、どのrequestにも載らない（固定応答で従来どおり答える場合は送信自体が無い）', sent19.every(b => b.pitStrategyCompare === null), sent19.map(b => b.pitStrategyCompare && b.pitStrategyCompare.race));
    // 提案とDriver採用の区別：提案は既存Planを上書きしない
    ck('E16 提案は実行指示ではない：計算パケットの提案は既存Plan（active_plan）を書き換えず、採用は既存のPlan/ACK経路（本検査では未実行）', h.ev('lastTelemetry.active_plan_decision_id') == null && !/pit_plan_amend|amend/.test(h.diag(/COMMAND|PLAN/).join('\n')));
    // 配送：実speak/finalizeUtteranceまで届いている
    ck('E17 返答は実speak経路で発話キューに入り、終端(UTTERANCE_FINAL)まで記録される（Audioは偽）', h.diag(/UTTERANCE_FINAL/).length >= 1 && h.diag(/SPEECH_LATENCY/).length >= 1);
    ck('E18 jsdomエラー0', h.state.errors.length === 0, h.state.errors.slice(0, 3));
  });
  console.log(`\nSTR-001 entry e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
