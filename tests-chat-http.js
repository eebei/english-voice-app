// ══════════════════════════════════════════════════════════════════════
// /api/chat HTTP統合テスト（2026-07-21・Codexレビュー P0-1 / P1-2 再レビュー条件）
//   純粋関数テスト(tests-strategy-guard.js)は /api/chat から renderer までの
//   契約を一度も通らないため、「stream:trueで拒否文がJSONのまま返る」事故を
//   検出できなかった（実機でJSONを喋る）。
//   ここでは実サーバーを起動し、strategy guard / judge_call の早期return経路が
//   stream / non-stream の両方で正しい Content-Type と本文を返すかを確認する。
//   さらに、strategy-guard.js のevaluateAvailability/buildUnavailableReplyを
//   意図的にthrowさせ、fail-closed（LLMへ絶対に流れず固定の安全文を返す）を
//   実際のHTTPレスポンスで確認する（P1-2再指摘）。
//   ★どの経路もAnthropic APIを一切呼ばない（guardが入口で止める）ため、
//     ダミーのAPIキーで安全にテストできる。フォールト注入時にもし誤って
//     LLM経路へ流れたら、ダミーキーでAnthropicが401を返し500になる＝検出できる。
// ══════════════════════════════════════════════════════════════════════
'use strict';
const { spawn } = require('child_process');
const http = require('http');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (cond ? '' : (detail ? '  → ' + detail : '')));
};

function post(port, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const req = http.request({
      hostname: 'localhost', port, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 15000);
    child.stdout.on('data', d => {
      if (d.toString().includes('is running')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', d => process.stderr.write('[server] ' + d));
    child.on('exit', code => { clearTimeout(timer); reject(new Error('server exited early: code=' + code)); });
  });
}

async function withServer(port, extraEnv, fn) {
  const child = spawn(process.execPath, ['-r', './tests-auth-ready-preload.js', 'server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      ANTHROPIC_API_KEY: 'sk-test-dummy-not-called',   // guard経路はAnthropicを呼ばないので実キー不要
      DATABASE_URL: '', JWT_SECRET: '', STRIPE_SECRET_KEY: '',
      ...extraEnv,
    },
  });
  try {
    await waitForServer(child);
    await fn(port);
  } finally {
    child.kill('SIGTERM');
  }
}

async function testBaseline(port) {
  console.log('\n══ 基本契約：strategy guard / judge_call の早期return ══');

  // ── ① strategy guard × stream:true → プレーンテキストのみ。JSONに包まれていない ──
  {
    const r = await post(port, {
      stream: true,
      character: 'LunaJP',
      messages: [{ role: 'user', content: '今ピットに入ったら何位で戻れる？' }],
    });
    check('①stream: HTTP 200', r.status === 200, 'status=' + r.status);
    check('①stream: Content-Typeがtext/plain', /text\/plain/.test(r.headers['content-type'] || ''), r.headers['content-type']);
    check('①stream: 本文がJSONに包まれていない（{"content"で始まらない）', !r.body.trim().startsWith('{'), r.body);
    check('①stream: 拒否文の中身を含む', /ピットロス|計算/.test(r.body), r.body);
  }

  // ── ② strategy guard × stream:false → 既存のAnthropic互換JSON形 ──
  {
    const r = await post(port, {
      stream: false,
      character: 'LunaJP',
      messages: [{ role: 'user', content: '今ピットに入ったら何位で戻れる？' }],
    });
    check('②non-stream: HTTP 200', r.status === 200, 'status=' + r.status);
    check('②non-stream: Content-Typeがapplication/json', /application\/json/.test(r.headers['content-type'] || ''), r.headers['content-type']);
    let parsed = null;
    try { parsed = JSON.parse(r.body); } catch (e) {}
    check('②non-stream: {content:[{type:"text",text}]}形式', !!(parsed && parsed.content && parsed.content[0] && typeof parsed.content[0].text === 'string'), r.body);
  }

  // ── ③ judge_call 早期return × stream:true → 'NO_CALL' がプレーンテキストで返る ──
  {
    const r = await post(port, {
      stream: true,
      messages: [{ role: 'user', content: 'x' }],
      judgeCall: { kind: 'best_lap' },   // 必須フィールド(best_kind, time)が欠落 → forced silence
    });
    check('③stream judge_call: Content-Typeがtext/plain', /text\/plain/.test(r.headers['content-type'] || ''), r.headers['content-type']);
    check('③stream judge_call: 本文がそのまま NO_CALL', r.body.trim() === 'NO_CALL', r.body);
  }

  // ── ④ judge_call 早期return × stream:false → 既存JSON形 ──
  {
    const r = await post(port, {
      stream: false,
      messages: [{ role: 'user', content: 'x' }],
      judgeCall: { kind: 'best_lap' },
    });
    let parsed = null;
    try { parsed = JSON.parse(r.body); } catch (e) {}
    check('④non-stream judge_call: JSON内のtextがNO_CALL', !!(parsed && parsed.content && parsed.content[0] && parsed.content[0].text === 'NO_CALL'), r.body);
  }

  // ── ⑤ P1-5: sessionType はトップレベル参照。Practice + 復帰順位質問 → NOT_RACE_SESSION ──
  {
    const r = await post(port, {
      stream: false,
      character: 'LunaJP',
      sessionType: 'Practice',
      messages: [{ role: 'user', content: '今ピットに入ったら何位で戻れる？' }],
    });
    let parsed = null;
    try { parsed = JSON.parse(r.body); } catch (e) {}
    const text = parsed && parsed.content && parsed.content[0] && parsed.content[0].text || '';
    check('⑤sessionType(トップレベル)がPracticeでNOT_RACE_SESSION文言になる', /レースじゃない/.test(text), text);
  }

  // ── ⑥ Phase C: live forecast はLLMを通さず6項目を数値で返す ──
  {
    const forecast = {
      available: true, snapshot_id: 'live:test',
      best: { position: 2 }, worst: { position: 4 },
      likely: {
        position: 3,
        nearest_ahead: { car_number: '15', gap_s: 4.9 },
        nearest_behind: { car_number: '67', gap_s: -2.6 },
        traffic_state: 'blend_risk',
        blend_conflicts: [{ car_number: '67', gap_s: -2.6 }],
      },
    };
    const r = await post(port, {
      stream: false, character: 'LunaJP', mode: 'race', sessionType: 'Race',
      liveData: { pit_exit_forecast: forecast },
      messages: [{ role: 'user', content: '今ピットに入ったら何位で戻れる？' }],
    });
    let parsed = null;
    try { parsed = JSON.parse(r.body); } catch (e) {}
    const text = parsed && parsed.content && parsed.content[0] && parsed.content[0].text || '';
    check('⑥Phase C: LikelyとBest/Worstを返す', /P3.*P2〜P4/.test(text), text);
    check('⑥Phase C: 前後車両を返す', /#15.*#67/.test(text), text);
    check('⑥Phase C: trafficとblend riskを返す', /トラフィック内.*合流注意/.test(text), text);
  }

  // ── ⑦ 個人calibration不足: 残り回数を明示する ──
  {
    const r = await post(port, {
      stream: false, character: 'LunaJP', mode: 'race', sessionType: 'Race',
      liveData: { pit_exit_forecast: {
        available: false, unavailable_reason: 'calibration_insufficient_samples',
        evidence: { usable_sample_count: 1, required_sample_count: 3, remaining_sample_count: 2 },
      } },
      messages: [{ role: 'user', content: '今ピットに入ったら何位で戻れる？' }],
    });
    let parsed = null;
    try { parsed = JSON.parse(r.body); } catch (e) {}
    const text = parsed && parsed.content && parsed.content[0] && parsed.content[0].text || '';
    check('⑦calibration: 個人実測1/3と残り2回を返す', /1\/3.*あと2回/.test(text), text);
  }

  // ── ⑧ 計算器はあるが瞬間データ不足: 古い「未実装」文言へ戻さない ──
  {
    const r = await post(port, {
      stream: false, character: 'LunaJP', mode: 'race', sessionType: 'Race',
      liveData: { pit_exit_forecast: {
        available: false, unavailable_reason: 'player_progress_missing',
      } },
      messages: [{ role: 'user', content: '今ピットに入ったら何位で戻れる？' }],
    });
    let parsed = null;
    try { parsed = JSON.parse(r.body); } catch (e) {}
    const text = parsed && parsed.content && parsed.content[0] && parsed.content[0].text || '';
    check('⑧live data不足: 未実装ではなくライブデータ不足を返す',
      /ライブデータ/.test(text) && !/入ってない/.test(text), text);
  }
}

// ★P1-2再指摘（Codexレビュー）：分類後にevaluateAvailability/buildUnavailableReplyが
//   例外を投げても、LLMへ流れず固定の安全文を返すこと（fail-closed）をHTTPで確認する。
//   もし誤ってfail-openになりLLM経路へ流れたら、ダミーAPIキーでAnthropicが401を返し
//   res.status(500)になる → HTTP 200 でないことで検出できる。
async function testFaultInjection(port, faultMode, label) {
  console.log(`\n══ fail-closed：strategy-guard.${faultMode}() が例外を投げても安全文で止まるか（${label}） ══`);

  // stream:true → 500にならず、固定の安全文（プレーンテキスト）が返る
  {
    const r = await post(port, {
      stream: true,
      character: 'LunaJP',
      messages: [{ role: 'user', content: '今ピットに入ったら何位で戻れる？' }],
    });
    check(`[${label}] stream: HTTP 200のまま（LLM経路へfail-openしていない）`, r.status === 200, 'status=' + r.status);
    check(`[${label}] stream: Content-Typeがtext/plain`, /text\/plain/.test(r.headers['content-type'] || ''), r.headers['content-type']);
    check(`[${label}] stream: 本文がJSONに包まれていない`, !r.body.trim().startsWith('{'), r.body);
    check(`[${label}] stream: 空文字列ではない（何かしらの安全文が返る）`, r.body.trim().length > 0, r.body);
  }

  // stream:false → 500にならず、固定の安全文がJSONで返る
  {
    const r = await post(port, {
      stream: false,
      character: 'LunaJP',
      messages: [{ role: 'user', content: '今ピットに入ったら何位で戻れる？' }],
    });
    check(`[${label}] non-stream: HTTP 200のまま（LLM経路へfail-openしていない）`, r.status === 200, 'status=' + r.status);
    let parsed = null;
    try { parsed = JSON.parse(r.body); } catch (e) {}
    const text = parsed && parsed.content && parsed.content[0] && parsed.content[0].text;
    check(`[${label}] non-stream: JSON形式で安全文を返す`, typeof text === 'string' && text.length > 0, r.body);
  }
}

// ★2026-07-21（Codexレビュー：変異テストで実証された本番エラー経路の欠陥）
//   非ガード経路（通常会話）でAnthropic API呼び出しが失敗すると、outer catchが
//   `character`/`mode`（tryブロック内let・catchのスコープ外）を参照してReferenceErrorを
//   投げ、意図したJSONエラーが返らずソケットが切断されていた。
//   ここでは実際に無効なAPIキーでAnthropicへ届かせ、本物の401を発生させて検証する
//   （guardが介入しない通常の雑談メッセージを送る＝strategy guard/judge_callの経路を通らない）。
async function testApiFailureRecovery(port) {
  console.log('\n══ 非ガード経路：Anthropic API失敗時にJSONエラーを返しプロセスが生存するか ══');

  const r1 = await post(port, {
    stream: false,
    character: 'LunaJP',
    messages: [{ role: 'user', content: 'こんにちは、調子どう？' }],   // guard非対象の通常会話
  });
  check('API失敗: HTTPエラーが伝播する(200ではない)', r1.status !== 200, 'status=' + r1.status);
  check('API失敗: Content-Typeがapplication/json', /application\/json/.test(r1.headers['content-type'] || ''), r1.headers['content-type']);
  let parsed = null;
  try { parsed = JSON.parse(r1.body); } catch (e) {}
  check('API失敗: JSON形式でerrorフィールドを返す（ReferenceErrorでクラッシュしない）',
    !!(parsed && typeof parsed.error === 'string'), r1.body);

  // プロセスが生存していることを、同じサーバーインスタンスへの後続リクエストで確認する
  const r2 = await post(port, {
    stream: false,
    character: 'LunaJP',
    messages: [{ role: 'user', content: '今ピットに入ったら何位で戻れる？' }],
  });
  check('API失敗後もサーバープロセスが生存している（後続リクエストに正常応答）', r2.status === 200, 'status=' + r2.status);
}

async function main() {
  await withServer(3901, {}, testBaseline);
  await withServer(3902, { STRATEGY_GUARD_TEST_FAULT: 'evaluate' },
    port => testFaultInjection(port, 'evaluate', 'evaluateAvailabilityがthrow'));
  await withServer(3903, { STRATEGY_GUARD_TEST_FAULT: 'reply' },
    port => testFaultInjection(port, 'reply', 'buildUnavailableReplyがthrow'));
  await withServer(3904, {}, testApiFailureRecovery);
}

main()
  .then(() => {
    console.log('\n[/api/chat HTTP統合] 合格 ' + pass + ' / 不合格 ' + fail);
    process.exit(fail ? 1 : 0);
  })
  .catch(err => {
    console.error('❌ テスト実行自体が失敗:', err.message);
    process.exit(1);
  });
