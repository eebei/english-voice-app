#!/usr/bin/env node
'use strict';
// U1（STR-001／設計§24.14）全車snapshot — 通し検査。
//   合成SDKフレーム → 実 bridge.poll_iracing()（python・replay_harness）→ 実broadcast内容と実ファイル記録
//   → 実 renderer.html(jsdom) の実 irBridge.onmessage へ同じメッセージを流す → 受信採否
//   → 実ファイルを Node の parseLog で読み戻し、送信・受信・記録の件数／ID／値／null／時刻／世代が一致するか。
// 実: bridge.py本体の処理・実ファイル書込み・renderer全体・field-snapshot.js
// 代替: iRacing共有メモリ（FakeReader／独立に書いた画像）、WebSocket（renderer側は socket.onmessage 直呼び）
// 未検証: 実iRacingの値、Windows、実Electron(main.js)、実WS経路の遅延。FIELD_OLD_ROOT=<旧tree>で旧rendererへの無害性も確認する。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./tests-fullrenderer-harness.js');
const FS = require('./desktop/field-snapshot.js');

let pass = 0, fail = 0;
const ck = (name, ok, detail) => { (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + name + (ok ? '' : ' -> ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 600))); ok ? pass++ : fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u1-e2e-'));
function dump(scn) {
  const out = path.join(tmp, scn);
  execFileSync('python3', [path.join(__dirname, 'tools', 'u1-dump-replay.py'), scn, out], { stdio: ['ignore', 'pipe', 'inherit'] });
  const sent = JSON.parse(fs.readFileSync(path.join(out, 'sent.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
  const logDir = path.join(out, 'logs');
  const parsed = fs.readdirSync(logDir).sort().map(f => FS.parseLog(fs.readFileSync(path.join(logDir, f), 'utf8')));
  const logged = parsed.flatMap(p => p.snapshots);
  return { sent, meta, parsed, logged };
}
const stats = h => h.w.eval('JSON.stringify(fieldSnapshotStats())');
const cur = h => JSON.parse(h.w.eval('JSON.stringify(currentFieldSnapshot())'));

(async () => {
  // ───────── A. 通常（全車・非隣接・別クラス・周回遅れ）─────────
  {
    const d = dump('normal');
    const h = H.boot({});
    await sleep(50);
    for (const m of d.sent) await h.bridge(m);
    const st = JSON.parse(stats(h));
    ck('A1 送信8本＝記録8本（実ファイル）', d.sent.length === 8 && d.logged.length === 8, [d.sent.length, d.logged.length]);
    ck('A2 rendererが8本とも採用（拒否0）', st.received === 8 && st.accepted === 8 && st.rejected_total === 0, st);
    ck('A3 送信・記録・読み戻しが完全一致（件数/ID/値/null/時刻/世代）', JSON.stringify(d.sent) === JSON.stringify(d.logged), null);
    const c = cur(h);
    ck('A4 rendererの現在値＝最後の記録', JSON.stringify(c) === JSON.stringify(d.logged[d.logged.length - 1]), null);
    ck('A5 全8台（プレイヤーから非隣接・別クラス200・周回遅れ・ピット中）がrendererに載る',
      c.cars.length === 8 && c.cars.find(x => x.i === 5).c === 200 && c.cars.find(x => x.i === 3).l === 4 && c.cars.find(x => x.i === 3).pit === 1 && c.cars.find(x => x.i === 7).no === '8', c.cars.map(x => [x.i, x.c, x.l, x.pit]));
    ck('A6 未取得ラップは null', c.cars.find(x => x.i === 3).ll === null, c.cars.find(x => x.i === 3));
    ck('A7 個人名・認証値は記録にも受信にも無い', !JSON.stringify(d.logged).includes('Secret') && !JSON.stringify(c).includes('Name'), null);
    ck('A8 ヘッダに schema_version と car_fields 凡例', d.parsed[0].header && d.parsed[0].header.schema_version === 1 && d.parsed[0].header.car_fields.i === 'car_idx', d.parsed[0].header);
    ck('A9 field_snapshot は会話・音声を一切起こさない（chat 0 / tts 0 / 描画エラー0）', h.state.chats.length === 0 && h.state.tts.length === 0 && h.state.errors.length === 0, [h.state.chats.length, h.state.tts.length, h.state.errors]);
    h.dom.window.close();
  }

  // ───────── B. 障害・遷移（世代混在／欠測／ピット／離脱復帰／セッション切替）─────────
  {
    const d = dump('faults');
    const h = H.boot({});
    await sleep(50);
    for (const m of d.sent) await h.bridge(m);
    const st = JSON.parse(stats(h));
    const bad = d.logged.filter(s => !s.ok);
    ck('B1 世代混在は記録される(1本・gen=mixed)が、送信にも受信にも出ない', bad.length === 1 && bad[0].gen === 'mixed' && d.sent.every(s => s.ok) && !d.sent.some(s => s.seq === bad[0].seq), { bad: bad.map(b => [b.seq, b.gen]) });
    ck('B2 記録14本＝送信13本＋混在1本', d.logged.length === 14 && d.sent.length === 13, [d.logged.length, d.sent.length]);
    ck('B3 renderer採用13・拒否0（混在はそもそも届かない）', st.accepted === 13 && st.rejected_total === 0, st);
    const miss = d.logged.find(s => s.counts.missing === 8);
    ck('B4 配列欠測は「欠測」として記録され、離脱(out)と区別される', miss && miss.ok && miss.cars.every(c => c.st === 'missing' && c.d === null) && miss.counts.departed === 0, miss && miss.counts);
    const flat = d.logged.flatMap(s => s.events);
    ck('B5 イベント: start/pit_in/pit_out/car_leave/car_join/lap が出る', ['start', 'pit_in', 'pit_out', 'car_leave', 'car_join', 'lap'].every(e => flat.includes(e)), flat);
    const leave = d.logged.find(s => s.events.includes('car_leave'));
    ck('B6 離脱車は st=out・値null・departed=1', leave && leave.counts.departed === 1 && leave.cars.find(c => c.i === 7).st === 'out' && leave.cars.find(c => c.i === 7).p === null, leave && leave.counts);
    ck('B8 seqは単調増加・重複なし', d.logged.every((s, i) => i === 0 || s.seq === d.logged[i - 1].seq + 1), d.logged.map(s => s.seq));
    ck('B9 記録の observed_at / source_frame_sequence が単調', d.logged.every((s, i) => i === 0 || (s.observed_at >= d.logged[i - 1].observed_at && s.source_frame_sequence > d.logged[i - 1].source_frame_sequence)), null);
    h.dom.window.close();
  }

  // ───────── C. 偽造・壊れたメッセージ（rendererは採用しない・現在値は変わらない）─────────
  {
    const d = dump('normal');
    const h = H.boot({});
    await sleep(50);
    const good = d.sent[0];
    await h.bridge(good);
    const base = JSON.stringify(cur(h));
    const clone = o => JSON.parse(JSON.stringify(o));
    const cases = {
      unexpected_field_top: s => { s.driver_name = 'Alice'; },
      unexpected_field_car: s => { s.cars[0].name = 'Alice Secret'; },
      generation_mixed: s => { s.gen = 'mixed'; s.ok = false; },
      generation_unverified: s => { s.gen = 'unverified'; s.ok = false; },
      counts_mismatch: s => { s.counts.observed = 1; },
      bad_car_idx: s => { s.cars[1].i = s.cars[0].i; },
      no_race_identity: s => { s.race_instance_id = ''; },
      no_epoch: s => { delete s.bridge_process_epoch; },
      bad_car_value: s => { s.cars[0].d = 3.2; },
      out_car_has_values: s => { s.cars[3].st = 'out'; s.counts.observed--; s.counts.departed++; },
      counts_target: s => { s.counts.target = 9; },
      identity_stale_field: s => { s.roster_session_num = 5; },
      identity_stale_gen: s => { s.gen = 'identity_stale'; s.ok = false; },
      bad_role: s => { s.cars[0].r = 'driver'; },
      counts_other: s => { s.counts.other = 3; },
      bad_roster_update: s => { s.roster_update = 'x'; },
      bad_events: s => { s.events = ['teleport']; },
      schema_version: s => { s.schema_version = 99; },
    };
    let n = 0;
    for (const [reason, mut] of Object.entries(cases)) {
      const s = clone(d.sent[1]); mut(s); s.seq = 100 + (++n);
      const before = JSON.parse(stats(h));
      await h.bridge(s);
      const after = JSON.parse(stats(h));
      const gotReason = after.last_reject_reason;
      const want = reason === 'counts_target' || reason === 'counts_other' ? 'counts_mismatch' : reason.startsWith('identity_stale') ? 'identity_stale' : reason.replace(/_top$|_car$/, '');
      ck('C ' + reason + ' は拒否される(' + want + ')・現在値不変', after.accepted === before.accepted && after.received === before.received + 1 && gotReason === want && JSON.stringify(cur(h)) === base, { gotReason, want });
    }
    await h.bridge(clone(good));   // 同じseq
    ck('C dup 同じseqは採用しない', JSON.parse(stats(h)).last_reject_reason === 'duplicate_seq', JSON.parse(stats(h)));
    await h.bridge(d.sent[3]); await h.bridge(d.sent[2]);   // 逆戻り
    ck('C stale 古いseqへ戻さない', JSON.parse(stats(h)).last_reject_reason === 'stale_seq' && cur(h).seq === d.sent[3].seq, JSON.parse(stats(h)));
    // 新しいセッション/Bridge再起動：seqが1に戻っても採用される。新しい系列の全snapshotが拒否されている間は、旧セッションの値を「現在」として返さない。
    const restarted = clone(d.sent[0]); restarted.bridge_process_epoch = 'epoch-restarted'; restarted.seq = 1;
    await h.bridge(restarted);
    ck('C restart Bridge再起動(別epoch・seq=1)は採用される', cur(h).bridge_process_epoch === 'epoch-restarted' && cur(h).seq === 1, cur(h).bridge_process_epoch);
    const nextSession = clone(d.sent[0]); nextSession.session_num = 1; nextSession.seq = 2; nextSession.bridge_process_epoch = 'epoch-restarted'; nextSession.gen = 'mixed'; nextSession.ok = false;
    await h.bridge(nextSession);   // 新セッションの最初が混在で拒否された
    const expectNew = JSON.stringify({ race_instance_id: restarted.race_instance_id, session_num: 1 });
    ck('C guard 期待セッションと違う保持値は null（旧セッションの全車情報を使わない）', h.w.eval('JSON.stringify(currentFieldSnapshot(' + expectNew + '))') === 'null' && cur(h) !== null, null);
    ck('C guard 期待が合えば返す', h.w.eval('currentFieldSnapshot({race_instance_id:' + JSON.stringify(restarted.race_instance_id) + ',session_num:' + restarted.session_num + '})') !== null, null);
    const ageNow = restarted.observed_at + 100;
    ck('C age 古すぎる保持値は null', h.w.eval('currentFieldSnapshot({max_age_s:5,now_s:' + ageNow + '})') === null && h.w.eval('currentFieldSnapshot({max_age_s:500,now_s:' + ageNow + '})') !== null, null);
    ck('C 偽造を送っても会話・音声は起きない', h.state.chats.length === 0 && h.state.tts.length === 0 && h.state.errors.length === 0, h.state.errors);
    h.dom.window.close();
  }

  // ───────── C2. 競技車以外（ペースカー）を含むsnapshotは、役割つきなら採用される ─────────
  {
    const d = dump('normal');
    const h = H.boot({});
    await sleep(50);
    const s = JSON.parse(JSON.stringify(d.sent[0]));
    s.cars[2].r = 'pace'; s.counts = { target: 7, observed: 7, departed: 0, missing: 0, other: 1 };
    await h.bridge(s);
    ck('C2a ペースカーを役割(pace)つきで含むsnapshotは採用され、counts.targetは競技車のみ', cur(h) && cur(h).cars[2].r === 'pace' && cur(h).counts.target === 7 && cur(h).counts.other === 1, JSON.parse(stats(h)));
    const t = JSON.parse(JSON.stringify(s)); t.seq = 2; t.counts = { target: 8, observed: 8, departed: 0, missing: 0, other: 0 };
    await h.bridge(t);
    ck('C2b ペースカーを競技車として数えた件数は拒否', JSON.parse(stats(h)).last_reject_reason === 'counts_mismatch', JSON.parse(stats(h)));
    h.dom.window.close();
  }

  // ───────── S. session切替（名簿が新しくなる前の行は有効にしない）─────────
  {
    const d = dump('switch');
    const h = H.boot({});
    await sleep(50);
    for (const m of d.sent) await h.bridge(m);
    const st = JSON.parse(stats(h));
    const stale = d.logged.filter(x => x.gen === 'identity_stale');
    ck('S1 名簿が旧い行(identity_stale)は記録に残るが、送信にも受信にも出ない', stale.length >= 5 && d.sent.every(x => x.ok) && !d.sent.some(x => x.gen === 'identity_stale'), { stale: stale.length, sent: d.sent.length });
    ck('S2 renderer採用=送信数・拒否0', st.accepted === d.sent.length && st.rejected_total === 0, st);
    const after = d.sent.filter(x => x.session_num === 1);
    ck('S3 新セッションの有効行は全て新名簿（77/88・クラス200）・新race id', after.length > 0 && after.every(x => x.race_instance_id === 'sub:202000' && x.cars.find(c => c.i === 2).no === '77' && x.cars.find(c => c.i === 3).c === 200), after.length);
    const c7 = cur(h);
    ck('S7 切替後の最初の有効行に session_change が付き、rendererは新セッションへ切り替わる(resets>=1・session_num=1)', d.sent.some(x => x.events.includes('session_change') && x.session_num === 1) && st.resets >= 1 && c7.session_num === 1, [st.resets, c7.session_num]);
    ck('S4 旧race idのまま session_num=1 を名乗る有効行は0', !d.sent.some(x => x.session_num === 1 && x.race_instance_id === 'sub:101000'), null);
    // 記録に残った旧名簿の行をrendererへ流しても全て拒否される（受信側の独立した防壁）
    const before = JSON.parse(stats(h));
    for (const m of stale.slice(0, 20)) await h.bridge(m);
    const aft = JSON.parse(stats(h));
    ck('S5 identity_staleの行を直接流しても全件拒否・現在値不変', aft.accepted === before.accepted && aft.rejected.identity_stale === 20, aft);
    // 同じ行のgenだけ偽って consistent/ok にしても、roster_session_num≠session_num で拒否
    const forged = JSON.parse(JSON.stringify(stale[0])); forged.gen = 'consistent'; forged.ok = true; forged.seq = 9999; forged.roster_session_num = 0;   // 旧セッションの名簿を新セッションの行へ偽装
    await h.bridge(forged);
    ck('S6 genを偽装した旧名簿の行も拒否(roster_session_num≠session_num)', JSON.parse(stats(h)).last_reject_reason === 'identity_stale' && cur(h).seq !== 9999, JSON.parse(stats(h)));
    h.dom.window.close();
  }

  // ───────── D. 旧renderer（Build306）に新Bridgeのfield_snapshotが届いても無害 ─────────
  {
    const oldRoot = process.env.FIELD_OLD_ROOT || '/tmp/str001-b306';
    if (fs.existsSync(path.join(oldRoot, 'desktop', 'renderer.html'))) {
      const d = dump('normal');
      const h = H.boot({ root: oldRoot });
      await sleep(50);
      for (const m of d.sent) await h.bridge(m);
      ck('D1 旧rendererはfield_snapshotを無視し、エラー・会話・音声を起こさない', h.state.errors.length === 0 && h.state.chats.length === 0 && h.state.tts.length === 0, h.state.errors);
      h.dom.window.close();
    } else {
      console.log('⏭  D1 旧tree(' + oldRoot + ')が無いためスキップ（未実施として報告）');
    }
  }

  console.log(`\n=== U1 field snapshot E2E: ${pass} passed, ${fail} failed ===`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E error', e); process.exit(2); });
