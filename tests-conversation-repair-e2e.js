#!/usr/bin/env node
'use strict';
// Build 311 会話修復（監督 2026-11-22「160文字以内の完結回答」）の通し検査。
//   実 sendMsg → 実 dispute-detector／engineer-card／local-intent-router → 実 callAPI → 実 server.js(子プロセス・実HTTP) → 実 buildSystem
//   → (偽SDK=保存応答) → 実 emitCompleteSentences／limitReplyText → 実 speak(UTTERANCE_FINAL) まで通す。
//   固定コーパス：実走ログ OMORAY-bridge-debug-20261122-0839.log の 08:44:35〜08:47:20（FPS相談→話題訂正→設定質問→改善相談→「それから」→追質問）。
// 代替: Anthropic SDK（保存応答・外部API0件）、TTS/Audio、WebSocket。未検証: 実LLMの意味品質・実音声・実走。
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const H = require('./tests-fullrenderer-harness.js');
const ROOT = __dirname;
let pass = 0, fail = 0;
const ck = (n, ok, d) => { (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + n + (ok ? '' : ' -> ' + JSON.stringify(d === undefined ? null : d).slice(0, 800))); ok ? pass++ : fail++; };

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convrep-')); const queue = path.join(dir, 'queue'); fs.mkdirSync(queue);
  const port = 27000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['-r', path.join(ROOT, 'tests-wo001-anthropic-stream-stub-preload.js'), 'server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: 'sk-test-local-stub', DATABASE_URL: '', JWT_SECRET: '', STRIPE_SECRET_KEY: '', WO019_SDK_QUEUE_DIR: queue } });
  const logs = []; child.stdout.on('data', d => logs.push(String(d))); child.stderr.on('data', d => logs.push(String(d)));
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('server start timeout')), 20000); child.stdout.on('data', d => { if (String(d).includes('is running')) { clearTimeout(t); res(); } }); child.on('exit', c => rej(new Error('server exited ' + c))); });
  let seq = 0;
  const api = { url: 'http://127.0.0.1:' + port, logs, queueReply: (forUserText, chunks, extra = {}) => fs.writeFileSync(path.join(queue, String(++seq).padStart(3, '0') + '-r.json'), JSON.stringify({ forUserText, chunks: Array.isArray(chunks) ? chunks : [chunks], ...extra })),
    traces: () => logs.join('').split('\n').filter(l => l.startsWith('[reply_trace]')).map(l => JSON.parse(l.slice(13))) };
  try { return await fn(api); } finally { child.kill('SIGTERM'); }
}
const said = h => h.diag(/LunaJP\]/).map(t => t.replace(/^\[LunaJP\]\s*/, ''));
const finals = h => h.diag(/UTTERANCE_FINAL/).filter(t => /outcome=spoken/.test(t)).map(t => (t.match(/tts_text="([^"]*)"/) || [])[1]);
async function finishAudio(h, n = 4) { for (let i = 0; i < n; i++) { await h.sleep(60); for (const a of h.state.audios) { try { a.finish(); } catch (e) {} } } }
async function ask(h, text) { await finishAudio(h, 2); const n0 = said(h).length, f0 = finals(h).length; await h.say(text); await h.sleep(400); await finishAudio(h, 4); return { said: said(h).slice(n0), spoken: finals(h).slice(f0) }; }
const lastAssistant = h => { const c = JSON.parse(h.ev('JSON.stringify(currentRaceConversation())')); for (let i = c.length - 1; i >= 0; i--) if (c[i].role === 'assistant') return c[i].content; return null; };

(async () => {
  await withServer(async srv => {
    const h = H.boot({ root: ROOT, chatForward: srv.url, localStorage: { pw_auth_user: { id: 'u1' }, pw_auth_token: 'tok-u1' }, user: { id: 'u1', isMember: true, displayName: 'T' } });
    await h.sleep(300);
    h.enterRace({ race: 'sub:90286845', track: 'Silverstone Circuit', car: 'Mercedes-AMG GT3 2020' });
    // 直前のコールは停止車両（実走08:44前後と同じ状況）
    h.ev("addMsg('ai','前方に停止車両。注意。');pushMsg({role:'assistant',content:'前方に停止車両。注意。'})");

    // ── 1. FPS相談は「停止車両コールへの否定」にならない（誤撤回しない） ──
    srv.queueReply('fpsが', 'FPSが低いんだね。まずiRacingの解像度とターゲットFPSを確認しよう。');
    const t1 = await ask(h, 'Luna fpsが。  悪いんだけど、34とか40ぐらいしかないんだよ。全然運転できる状態じゃないね。');
    ck('1a FPS相談で「記録は撤回する」を言わない（誤った訂正判定をしない）', !t1.said.concat(t1.spoken).some(t => /撤回|記録|次の計測/.test(t)) && h.diag(/DISPUTE_DETECTED/).length === 0, { t1, d: h.diag(/DISPUTE/) });
    ck('1b 相談として会話（LLM）へ届き、保存応答の本文がそのまま話される', t1.spoken.some(t => /FPSが低いんだね/.test(t)), t1);

    // ── 2. 話題の訂正（「違う、iRacingの設定を聞きたい」）も撤回にしない ──
    srv.queueReply('設定を聞きたい', 'iRacingのグラフィック設定の話だね。解像度や影の品質で変わるよ。');
    const t2 = await ask(h, '違う アイ レーシングの設定を聞きたいんだ。グラフィックスか？  な全然あの？  画面がスムーズに流れない感じ。');
    ck('2a 話題の訂正で撤回しない・定型の記録文を話さない', !t2.said.concat(t2.spoken).some(t => /撤回|記録/.test(t)) && h.diag(/DISPUTE_DETECTED/).length === 0, { t2, d: h.diag(/DISPUTE/) });
    ck('2b 話題の訂正の後、設定の話として会話へ届く', t2.spoken.some(t => /グラフィック設定の話/.test(t)), t2);

    // ── 3. FPSの「セッティング」は足回り相談（handling_setup_advice）にならない ──
    srv.queueReply('基準を上げる', 'まず解像度とターゲットFPSを確認して、影と反射の品質を下げてみよう。');
    const routes0 = h.diag(/INTENT_ROUTE/).length;
    const t3 = await ask(h, 'このfpsの基準を上げるの？どうやってやる？セッティングで何か変わると思うかな？');
    const r3 = h.diag(/INTENT_ROUTE/).slice(routes0);
    ck('3a FPS／グラフィックの「セッティング」を足回りの相談にしない（intent≠handling_setup_advice）', !r3.some(t => /handling_setup_advice/.test(t)) && !t3.spoken.some(t => /アンダー|オーバー|基準を取る/.test(t)), { r3, t3 });
    ck('3b 内容のある回答が会話へ届く', t3.spoken.some(t => /解像度とターゲットFPS/.test(t)), t3);

    // ── 4. 長い完結回答：保存応答の本文＝画面＝履歴＝TTS。160字以内・文の途中で切れない ──
    const full4 = 'グラフィックの設定画面で、解像度を一段下げて、影と反射の品質を低にする。それでもFPSが伸びなければ、ミラーの描画とターゲットFPSを見直そう。';
    srv.queueReply('改善するには', full4);
    const t4 = await ask(h, 'グラフィックスのfpsの。  動きが悪いからそれを改善するにはどうしたらいい？');
    const body4 = h.state.chats[h.state.chats.length - 1];
    ck('4a Driverへの回答の予算：max_chars=160・max_tokens=260（旧35字・55トークン）', body4.max_chars === 160 && body4.max_tokens === 260, { mc: body4.max_chars, mt: body4.max_tokens });
    ck('4b 長い完結回答がそのまま（語途中で切れず）話される。画面＝TTS＝履歴が同じ確定本文', t4.spoken.join('') === full4 && lastAssistant(h) === full4 && Array.from(full4).length <= 160, { spoken: t4.spoken, hist: lastAssistant(h) });
    ck('4c 追跡ログ：終了理由・生成長・最終本文長・上限・破棄なし', srv.traces().some(x => x.stop_reason === 'end_turn' && x.generated_chars === Array.from(full4).length && x.final_chars === Array.from(full4).length && x.limit === 160 && x.dropped === null), srv.traces());

    // ── 5. 「それから」「ディスプレイをどうする？」：直前に実際に話した内容へ続く ──
    srv.queueReply('それから', 'それから、ディスプレイの解像度を下げて、垂直同期をオフにしてみよう。');
    const t5 = await ask(h, 'それから。');
    const sent5 = h.state.chats[h.state.chats.length - 1].messages.map(m => m.content);
    ck('5a 「それから」を受けた要求に、直前に実際に話した回答の本文が履歴として載る（話題がつながる）', sent5.some(c => String(c).includes('ミラーの描画とターゲットFPS')), sent5.map(c => String(c).slice(0, 40)));
    ck('5b 「それから」の返答が完結した文で話される', t5.spoken.some(t => /垂直同期をオフにしてみよう。$/.test(t)), t5);
    srv.queueReply('ディスプレイを', '解像度を一段下げて、ウィンドウではなく全画面にすると改善しやすい。');
    const t6 = await ask(h, 'ディスプレイをどうする？');
    const sent6 = h.state.chats[h.state.chats.length - 1].messages.map(m => m.content);
    ck('5c 「ディスプレイをどうする？」の追質問：直前の「それから」の回答が履歴に載り、完結回答が返る', sent6.some(c => String(c).includes('垂直同期をオフ')) && t6.spoken.some(t => /全画面にすると改善しやすい。$/.test(t)), { sent6: sent6.map(c => String(c).slice(0, 30)), t6 });

    // ── 6. 切断しない：max_tokens終了の尻切れ・上限超過の1文・最初から不完全 ──
    srv.queueReply('尻切れA', ['まず解像度を下げる。', '次にディスプ'], { stopReason: 'max_tokens' });
    const t7 = await ask(h, '尻切れA');
    ck('6a max_tokensで終わった尻切れの断片（「次にディスプ」）は読み上げない。完結した1文目だけ話す', t7.spoken.join('') === 'まず解像度を下げる。' && !t7.spoken.join('').includes('ディスプ'), t7);
    srv.queueReply('尻切れB', ['iRacingのグラフィック設定でFPS改善するには、まずディスプ'], { stopReason: 'max_tokens' });
    const t8 = await ask(h, '尻切れB');
    ck('6b 最初から不完全（文末なしでmax_tokens）：「まずディスプレ。」のような断片を作らず、短い完結した再質問を返す', t8.spoken.join('') === 'うまくまとめきれなかった。もう一度聞いて。' && !/ディスプ/.test(t8.spoken.join('')), t8);
    const longOne = '設定' + 'を見直して'.repeat(40) + '改善する。';
    srv.queueReply('超過', longOne);
    const t9 = await ask(h, '超過');
    ck('6c 160字を超える1文は、単語の途中で切らず、短い完結した再質問に置き換える', Array.from(longOne).length > 160 && t9.spoken.join('') === 'うまくまとめきれなかった。もう一度聞いて。', t9);
    ck('6d 追跡ログに終了理由と破棄理由が残る（max_tokens_incomplete／sentence_over_limit）', srv.traces().some(x => x.stop_reason === 'max_tokens' && x.dropped === 'max_tokens_incomplete') && srv.traces().some(x => x.dropped === 'sentence_over_limit'), srv.traces());

    // ── 7. 回帰：本物の訂正は取り消され、自然な短文で返す。短い相槌・安全割込みは影響を受けない ──
    h.ev("addMsg('ai','前方に停止車両。注意。');pushMsg({role:'assistant',content:'前方に停止車両。注意。'})");
    const t10 = await ask(h, 'いや、前方に停止車両なんかいないよ');
    ck('7a 実際の訂正（停止車両はいない）は取り消し、内部の記録処理の定型文を話さない：「了解、さっきの停止車両の呼びかけは取り消す。」', t10.spoken.join('').includes('了解、さっきの停止車両の呼びかけは取り消す。') && !/記録|次の計測/.test(t10.spoken.join('')), t10);
    // 検査 R-C312-1：「画面」「モニター」を含む本物の訂正（車が見えない）は取り消す。FPS・設定の話は取り消さない
    for (const t of ['画面には何も見えないよ', 'モニターには映ってない、違う']) {
      h.ev("addMsg('ai','前方に停止車両。注意。');pushMsg({role:'assistant',content:'前方に停止車両。注意。'})");
      const r = await ask(h, t);
      ck('7d 「' + t + '」は停止車両コールへの本物の訂正として取り消す（画面・モニターの語で取りこぼさない）', r.spoken.join('').includes('取り消す。') && !/記録|次の計測/.test(r.spoken.join('')), r);
    }
    srv.queueReply('画面がカクカク', 'カクつきならグラフィック設定の解像度を下げてみよう。');
    h.ev("addMsg('ai','前方に停止車両。注意。');pushMsg({role:'assistant',content:'前方に停止車両。注意。'})");
    const r7e = await ask(h, '画面がカクカクして違う設定にしたい');
    ck('7e 画面の設定の話（違う設定にしたい）は訂正にしない：取り消しを言わず、会話へ届く', !r7e.spoken.join('').includes('取り消す') && r7e.spoken.some(t => /グラフィック設定の解像度/.test(t)), r7e);
    // 監査 R-C312-3：表示装置そのものの故障・不調（主語が装置）は、停止車両コールの確定訂正にせず会話へ送る
    for (const t of ['ディスプレイが故障して映らない、違う', 'ディスプレイが映らない、違う']) {
      srv.queueReply('ディスプレイが', 'ディスプレイの接続とケーブルを確認して、別の入力へ切り替えてみよう。');
      h.ev("addMsg('ai','前方に停止車両。注意。');pushMsg({role:'assistant',content:'前方に停止車両。注意。'})");
      const n0 = h.diag(/DISPUTE_DETECTED/).length;
      const r = await ask(h, t);
      ck('7f 「' + t + '」は表示装置の不調：停止車両コールを取り消さず、確定訂正を記録せず、会話へ届く', !r.spoken.join('').includes('取り消す') && h.diag(/DISPUTE_DETECTED/).length === n0 && r.spoken.some(x => /接続とケーブル/.test(x)), { r, d: h.diag(/DISPUTE/).slice(n0) });
    }
    // 監査 R-C312-2：相槌だけ残して本題の文を落とさない
    const lead = 'FPSが低いんだね。';
    const body9 = 'まずiRacingのグラフィック設定を開いて、解像度とターゲットFPSを確認し、影と反射の品質を一段ずつ下げて、それでも改善しなければミラーの描画とレンダー設定も下げて、不要な描画の項目を順に切り、それでも足りなければ解像度のスケールを下げて、最後にターゲットFPSを固定して、バックグラウンドのアプリも閉じてみて。';
    srv.queueReply('何から直せばいい', lead + body9);
    const r9 = await ask(h, 'FPSが落ちている、何から直せばいい？');
    ck('9a 相槌（10字）＋160字超の1文：相槌だけで終わらず、明示の聞き直し誘導が付く（本文を途中で切らない）', Array.from(lead + body9).length > 160 && r9.spoken.join('') === lead + '詳しくは、もう一度聞いて。' && lastAssistant(h) === r9.spoken.join(''), { spoken: r9.spoken, hist: lastAssistant(h), len: Array.from(lead + body9).length });
    ck('9b 追跡ログに lead_in_followup が残る', srv.traces().some(x => /lead_in_followup/.test(String(x.dropped)) && x.final_chars === Array.from(lead + '詳しくは、もう一度聞いて。').length), srv.traces().slice(-2));
    srv.queueReply('小数点', '解像度の倍率は1.5倍から0.8倍へ下げて、影の品質を低にしよう。');
    const r10 = await ask(h, '小数点の話：倍率はいくつ？');
    ck('9c 小数点（1.5・0.8）を文の区切りにせず、完結した1文がそのまま話される。聞き直し誘導は付かない', r10.spoken.join('') === '解像度の倍率は1.5倍から0.8倍へ下げて、影の品質を低にしよう。', r10);
    srv.queueReply('短い手順', 'ターゲットFPSを60に固定して、影を低にして。');
    const r11 = await ask(h, '短い手順を教えて');
    ck('9d 最初から短い手順は従来どおり1つ話され、聞き直し誘導を足さない。画面＝TTS＝履歴が同一', r11.spoken.join('') === 'ターゲットFPSを60に固定して、影を低にして。' && lastAssistant(h) === r11.spoken.join(''), { r11, hist: lastAssistant(h) });
    ck('7b 追加のLLM呼出（有料API）は発生していない：Driver発話ごとの要求数＝会話に回した発話数', h.state.chats.length >= 7, h.state.chats.length);
    ck('7c 実行中に例外なし', h.state.errors.length === 0, h.state.errors.slice(0, 3));
  });
  // ── 8. 生成指示：実際に組み立てた system に、回答の予算（160字・完結）とFPS設定の扱いが載る（文字列の存在だけでなく、組み立て結果で確認） ──
  {
    const sys = require('./prompts').buildSystem({ character: 'LunaJP', mode: 'race', telemetry: 'live', liveData: {}, raceContext: null, raceContextModern: false, max_chars: 160 });
    const sysStr = typeof sys === 'string' ? sys : JSON.stringify(sys);
    ck('8a Lunaのレースmodeの組み立て結果に「質問への回答の予算：160文字以内の完結した文」と「車ではないシステム設定を車のセッティングと混同しない」が載る。旧「通常35文字以内。燃料・ピット・戦略への回答だけ60文字」は無い', /質問への回答の予算/.test(sysStr) && /160文字以内の完結した文/.test(sysStr) && /車ではないシステム設定/.test(sysStr) && !/燃料・ピット・戦略への回答だけ60文字以内/.test(sysStr), sysStr.length);
    // 監査 互換性：旧Desktop（max_chars=35）には、35字に合わせた完結回答の指示を出す（160字向けの指示を出さない）。上限値の指定が無い時も同じ
    for (const mc of [35, undefined]) {
      const old = JSON.stringify(require('./prompts').buildSystem({ character: 'LunaJP', mode: 'race', telemetry: 'live', liveData: {}, raceContext: null, raceContextModern: false, max_chars: mc }));
      ck('8b 旧Desktop(max_chars=' + mc + ')：「35文字以内の完結した文」と「最初の文に結論」を指示し、「160文字以内」を指示しない', /35文字以内の完結した文/.test(old) && /最初の文に結論か手順の要点/.test(old) && !/160文字以内/.test(old), old.length);
    }
    const mid = JSON.stringify(require('./prompts').buildSystem({ character: 'LunaJP', mode: 'race', telemetry: 'live', liveData: {}, raceContext: null, raceContextModern: false, max_chars: 160 }));
    ck('8c 新Desktop(160)：最初の文に結論・相槌だけで枠を使わない指示が載る', /最初の文に結論か手順の要点を入れ、「〜だね。」のような相槌だけの文で枠を使うな/.test(mid), mid.length);
  }
  console.log('\n=== conversation repair e2e: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS_ERROR', e); process.exit(2); });
