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
//   ★Anthropic SDKはtests-auth-ready-preload.jsでローカル失敗stubへ置換する。
//     通常テストの外部API呼出はゼロ。フォールト注入時にもし誤ってLLM経路へ
//     流れたら、stubの401で500になる＝ネットワークなしで検出できる。
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
      ANTHROPIC_API_KEY: 'sk-test-local-stub',
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
    check('①stream: deterministic authority header', r.headers['x-pitwall-authority'] === 'deterministic', r.headers['x-pitwall-authority']);
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

  // ── ④p internal pace probe must not become a deterministic PACE/fuel card ──
  // The local Anthropic stub returns 401.  That failure is the expected proof
  // that this request reached the dedicated LLM judgement path; if the old
  // card misroute returns, status becomes 200 with deterministic authority.
  {
    const r = await post(port, {
      stream: false, character: 'LunaJP', mode: 'race', sessionType: 'Race',
      liveData: { fuel: 18.0, fuel_strategy: { pit_required: true, required_fuel_l: 24.0 } },
      paceCheck: { direction: 'slower', recent_deltas: [1.2, 1.4] },
      messages: [{ role: 'user', content: '[PACE_CHECK]' }],
    });
    check('④p internal PACE_CHECK bypasses deterministic conversation cards',
      r.status !== 200 && r.headers['x-pitwall-authority'] !== 'deterministic',
      `status=${r.status} authority=${r.headers['x-pitwall-authority'] || ''} body=${r.body}`);
  }

  // ── Race Plan / Fuel / Account は会話LLMでなく権威データから返す ──
  {
    const r = await post(port, {
      stream: false, character: 'LunaJP', mode: 'race', sessionType: 'Race',
      liveData: { fuel: 20.0, fuel_strategy: {
        avg_fuel_per_lap: 3.65, provisional_laps_to_time_expiry: 7,
        required_fuel_l: 25.55, margin_l: -5.55,
      } },
      messages: [{ role: 'user', content: '最後まで足りる？何リッター必要？' }],
    });
    const text = JSON.parse(r.body).content[0].text;
    check('④a timed provisional fuel plan is deterministic',
      /現在20\.0L.*ゴールまで25\.6L必要.*燃料は5\.6L不足.*給油設定6L/.test(text), text);
  }
  {
    const r = await post(port, {
      stream: true, character: 'LunaJP', mode: 'race', sessionType: 'Race',
      liveData: { fuel: 14.5, fuel_strategy: {
        estimated_crossings_to_finish: 8, required_fuel_l: 27.617,
        margin_l: -10.642, pit_required: true, add_fuel_l: 10.642,
      } },
      messages: [{ role: 'user', content: '何リットル不足する？ゴールまで。' }],
    });
    check('④a2 HTTP engineer card: current/required/add/set',
      /現在14\.5L.*ゴールまで27\.6L必要.*燃料は13\.1L不足.*給油設定14L/.test(r.body), r.body);
    check('④a2 HTTP engineer card: deterministic authority header',
      r.headers['x-pitwall-authority'] === 'deterministic', r.headers['x-pitwall-authority']);
    check('④a2 HTTP engineer card: intent trace header',
      r.headers['x-pitwall-intent'] === 'fuel_plan', r.headers['x-pitwall-intent']);
  }
  {
    const r = await post(port, {
      stream: true, character: 'LunaJP', mode: 'race', sessionType: 'Race',
      liveData: { fuel: 12.83, fuel_strategy: {
        estimated_crossings_to_finish: 4, required_fuel_l: 13.613,
        margin_l: -0.783, pit_required: true,
      } },
      messages: [{ role: 'user', content: '2リッター 足りないってこと？' }],
    });
    check('④a3 リッター follow-up: 不足量と設定量を区別して最新値で回答',
      /2L不足という意味ではない.*燃料は0\.8L不足.*給油設定1L/.test(r.body), r.body);
    check('④a3 リッター follow-up: deterministic fuel handler',
      r.headers['x-pitwall-intent'] === 'fuel_plan', r.headers['x-pitwall-intent']);
  }
  {
    const r = await post(port, {
      stream: true, character: 'LunaJP', mode: 'race', sessionType: 'Race',
      liveData: {
        fuel: 4.4,
        timed_finish_forecast: { confidence: 'model_valid',
          leader_time_to_checkered_s: 866, driver_time_to_next_sf_s: 107,
          driver_avg_lap_s: 108.24 },
        pit_loss_calibration: { observed_loss_median_s: 27.7 },
        fuel_strategy: { avg_fuel_per_lap: 3.678,
          estimated_crossings_to_finish: 9, required_fuel_l: 33.1,
          effective_capacity_l: 23.32, reserve_l: 0.5, pit_required: true },
      },
      messages: [{ role: 'user', content: 'チェッカー前にもう1回スプラッシュあるか？' }],
    });
    check('④a4 splash: 予定ピットロス後の燃料で直接回答',
      /スプラッシュ不要.*約0\.8L余る/.test(r.body) && !/S\/F|9回/.test(r.body), r.body);
    check('④a4 splash: deterministic fuel handler',
      r.headers['x-pitwall-intent'] === 'fuel_plan', r.headers['x-pitwall-intent']);
  }
  {
    const r = await post(port, {
      stream: false, character: 'LunaJP', mode: 'race',
      liveData: { session_time_remaining_s: 594, race_plan: {
        kind: 'timed', configured_duration_s: 1200, session_state: 4,
      } },
      messages: [{ role: 'user', content: 'このレース何分？何周？' }],
    });
    const text = JSON.parse(r.body).content[0].text;
    check('④b timed race rule comes from SessionInfo and formats the clock', /20分.*9分54秒/.test(text), text);
  }
  {
    const r = await post(port, {
      stream: false, character: 'LunaJP', mode: 'race', sessionType: 'Race',
      liveData: {
        session_type:'Race',class_pos: 8, fuel: 14.5,gap_ahead:0.8,
        battle_context:{player_pace_advantage_s:0.7},
        strategy_playbook:{available:true,selected_plan:'A',plans:{
          A:{available:true,first_pit_lap:5,pit_laps:[5,10]},
          B:{available:true,first_pit_lap:4,pit_laps:[4,9]},
          C:{available:true,first_pit_lap:6,pit_laps:[6,11],required_fuel_saving_pct:6.4},
        }},
        fuel_strategy: { estimated_crossings_to_finish: 8, required_fuel_l: 27.6, add_fuel_l: 13.1, pit_required: true },
        strategy_plan: { action: 'box', reason: 'fuel_shortfall', set_fuel_l: 14 },
        pit_exit_forecast: { available: true,
          likely:{position:17,traffic_state:'clear_air'}, best:{position:16}, worst:{position:18},
          pit_cycle:{if_pack_stops:{likely:{position:4,pack_car_count:14}}},
        },
      },
      messages: [{ role: 'user', content: 'この周でピットもいいと思う。アンダーカットにはどう思う？' }],
    });
    const text = JSON.parse(r.body).content[0].text;
    check('④b2 proposal uses verified undercut evidence, not fuel-only reasoning',
      /Plan B、アンダーカットを推奨.*こちらが0\.7秒速く詰まっている.*燃料不足ではなくトラフィック回避.*物理復帰P17/.test(text), text);
    check('④b2 strategy switch uses deterministic handler',
      r.headers['x-pitwall-intent'] === 'strategy_switch', r.headers['x-pitwall-intent']);
  }
  {
    const r = await post(port, {
      stream: false, character: 'LunaJP', mode: 'race',
      messages: [{ role: 'user', content: '契約解除だ！' }],
    });
    const text = JSON.parse(r.body).content[0].text;
    check('④c conversational cancellation cannot change entitlement',
      /ここでは変更できない/.test(text), text);
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

  // ── ⑨ STT「この週でbox」は履歴の数字を使わずこの周のBOXと返す ──
  {
    const r = await post(port, {
      stream: false, character: 'LunaJP', mode: 'race',
      liveData: { lap: 5 },
      messages: [{ role: 'user', content: 'この週でbox。' }],
    });
    const text = JSON.parse(r.body).content[0].text;
    check('⑨この周BOX: 過去の周回数を参照せず固定返答', /この周の終わりでボックス/.test(text), text);
  }

  // ── ⑩ ピットロスは差分推定でなく実測IN->OUTだけを返す ──
  {
    const r = await post(port, {
      stream: false, character: 'LunaJP', mode: 'race',
      liveData: { last_pit_service: { lane_total_s: 27.7, stall_s: 11.3, fuel_added_l: 8.8 } },
      messages: [{ role: 'user', content: 'ピットロス何秒？' }],
    });
    const text = JSON.parse(r.body).content[0].text;
    check('⑩ピットロス: 実測INからOUTを返す', /27.7秒.*8.8L.*11.3秒/.test(text), text);
  }

  // ── ⑪ デブリーフで保存した能動課題は、次レースの話し言葉の質問にも効く ──
  {
    const forecast = {
      available: true, snapshot_id: 'live:objective',
      best: { position: 2 }, worst: { position: 4 },
      likely: { position: 3, nearest_ahead: null, nearest_behind: null,
        traffic_state: 'clear_air', blend_conflicts: [] },
    };
    const r = await post(port, {
      stream: false, character: 'LunaJP', mode: 'race', sessionType: 'Race',
      strategyObjective: { kind: 'pit_total_race_outcome', status: 'active' },
      liveData: { pit_exit_forecast: forecast },
      messages: [{ role: 'user', content: 'これ第一スティント終わったら何番目ぐらいに戻るかな？' }],
    });
    const text = JSON.parse(r.body).content[0].text;
    check('⑪能動課題: ショートハンドを復帰予測として返す', /P3.*P2〜P4/.test(text), text);
  }

  // ── ⑫ Build 255 intent route: operational questions never need the LLM ──
  {
    const r = await post(port, {
      stream: true, character: 'LunaJP', mode: 'race',
      liveData: { weather: { track_temp_c: 41.2, air_temp_c: 28.4,
        humidity: 61, track_wetness_code: 1 } },
      messages: [{ role: 'user', content: '天候と路面は？' }],
    });
    check('⑫weather handler: SDK値だけで回答', /路面41\.2℃.*気温28\.4℃.*ドライ/.test(r.body), r.body);
    check('⑫weather handler: intent header', r.headers['x-pitwall-intent'] === 'weather_status', r.headers['x-pitwall-intent']);
  }
  {
    const r = await post(port, {
      stream: true, character: 'LunaJP', mode: 'race',
      liveData: {}, messages: [{ role: 'user', content: 'ピットの魔法を使える？' }],
    });
    check('⑫unknown operational: LLMへ流さず短い秘匿応答を返す',
      r.body === '今、ここでは伝えられない。', r.body);
    check('⑫unknown operational: unavailable intent header', r.headers['x-pitwall-intent'] === 'unresolved_operational', r.headers['x-pitwall-intent']);
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
//   ここではローカルAnthropic stubの401を発生させて検証する。ネットワークへは
//   一切出ない（guardが介入しない通常の雑談メッセージを送る）。
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

  const debrief = await post(port, {
    stream: false,
    character: 'LunaJP', mode: 'debrief',
    liveData: { fuel: 0.0, fuel_strategy: { required_fuel_l: 28.2, margin_l: -28.2 } },
    messages: [{ role: 'user', content: '1回目の給油で2リッターぐらい余った。' }],
  });
  check('デブリーフ燃料申告はライブhandlerへ誤接続しない',
    debrief.status !== 200
    && !/現在0\.0L|28\.2L必要|29L/.test(debrief.body), debrief.body);

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
