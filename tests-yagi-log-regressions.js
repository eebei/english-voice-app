#!/usr/bin/env node
'use strict';

// Build 266 — 八木さん実走ログ（2026-08-11 17:09〜 / Build 264）由来の5項目。
//
// 共有ログの指示：
//   1. 高路温・タイヤが持たない・セットアップ相談を `weather_status` に誤ルーティング
//      しない。`handling_setup_advice` を優先する。
//   2. アンダーステア相談直後の「どうしたらいい？」は直前文脈を引き継ぐ。
//   3. 途中で切れる発話（例: `次のピットで内。`）を禁止する。
//   4. 技術相談中にデブリーフ質問を割り込ませない。
//   5. 同一pit cycleの `limiter_off` を一回だけにする。
//
// 外部APIは呼ばない。

const fs = require('fs');
const cards = require('./engineer-card');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : ' -> ' + (detail || '')));
  ok ? pass++ : fail++;
}

// 実測環境値（八木さんログ：Barcelona / Ferrari 296 GT3 / Practice）
const LIVE = { weather: { track_temp_c: 50.6, air_temp_c: 30.7 }, session_type: 'Practice' };

// ── 7-1. セットアップ相談を weather_status へ誤ルーティングしない ──────
{
  console.log('\n══ 7-1 セットアップ相談のルーティング ══');
  const asked = [
    '路面温度が高すぎてタイヤが持たない。セットアップの方向、何かある？',
    '路面温度が高いからセットアップを変えたい。何か意見ある？',
  ];
  asked.forEach(text => {
    const card = cards.classify(text);
    check('相談が handling_setup_advice になる: ' + text.slice(0, 18) + '…',
      card && card.topic === 'handling_setup_advice', card && card.topic);
  });

  const reply = cards.route(asked[0], LIVE, 'ja').reply;
  check('温度の読み上げだけで終わらない', reply.length > 40 && !/^路面[\d.]+℃、気温[\d.]+℃。$/.test(reply));
  check('実測の環境値を根拠として述べる', /50\.6/.test(reply) && /30\.7/.test(reply));
  check('低速・中速・高速のどこかを確認する', /低速|中速|高速/.test(reply));
  check('試す方向を提案する', /試すなら/.test(reply));
  check('提案は最大2つ', (reply.match(/か、/g) || []).length <= 1);
  check('次に比べる観測項目を1つ指定する', /次の走行では/.test(reply));
  check('車種固有の数値を断定しない', /断定できない/.test(reply) && !/\d+\s*(?:クリック|ノッチ|psi|bar)/i.test(reply));

  // 8/16 St Petersburg 実走: 「リアの踏ん張りが欲しい。スプリングの
  // セッティングで何かおすすめある？」に、温度の復唱や速度域の聞き返しで
  // 終わらず、指定された部品の最初の一手を短く返す。
  const rearGrip = cards.route('リアの踏ん張りが欲しい。スプリングのセッティングで何かおすすめある？', LIVE, 'ja');
  check('リアの踏ん張り＋スプリング相談をセットアップ相談に分類',
    rearGrip.card && rearGrip.card.topic === 'handling_setup_advice', rearGrip.card && rearGrip.card.topic);
  check('リアスプリングの最初の一手を短く返す',
    /リアスプリングを1段柔らかく/.test(rearGrip.reply) && rearGrip.reply.length <= 70, rearGrip.reply);
  check('同じ条件で3周比較する観測を指定する', /低速出口を3周だけ比べて/.test(rearGrip.reply), rearGrip.reply);

  // 温度そのものの質問は従来どおり weather のまま
  ['路面温度は？', '今の気温教えて', '雨降ってきた？'].forEach(text => {
    check('温度・天候の質問は weather_status のまま: ' + text,
      (cards.classify(text) || {}).topic === 'weather_status');
  });
}

// ── 7-2. 曖昧なフォローアップが直前の相談を引き継ぐ ────────────────
{
  console.log('\n══ 7-2 文脈の引き継ぎ ══');
  const prior = 'アンダーステアがひどい。何か解決策ある？';
  ['どうしたらいいですか？', 'どうすればいい？', '他に何かある？', '何か対策は？'].forEach(text => {
    const card = cards.classify(text, { recentText: prior });
    check('直前の相談を引き継ぐ: ' + text,
      card && card.topic === 'handling_setup_advice' && card.inherited === true,
      card && card.topic);
    check('  症状も引き継ぐ（アンダー）', card && card.symptom === 'understeer');
  });

  // 文脈が無ければ引き継がない（勝手に相談へ寄せない）
  check('直前が無関係なら引き継がない',
    !(cards.classify('どうしたらいいですか？', { recentText: '今の順位は？' }) || {}).inherited);
  check('長い新規質問は奪わない',
    (cards.classify('どうしたらいいか分からないけど今のタイヤの状態を詳しく教えて',
                    { recentText: prior }) || {}).topic === 'tyre_status');
}

// ── 7-3. 発話が途中で切れない ───────────────────────────────────
{
  console.log('\n══ 7-3 途中で切れる発話の禁止 ══');
  const reply = cards.route('アンダーステアがひどい。何か解決策ある？', LIVE, 'ja').reply;
  check('文が終端記号で終わる', /[。？！]$/.test(reply), JSON.stringify(reply.slice(-12)));
  check('助詞で途切れていない', !/(?:で|に|を|が|は|の|へ|と)$/.test(reply.replace(/[。？！]$/, '')));
  // 実走で出た壊れ方（「次のピットで内。」）そのものを弾く
  check('実走で出た破断パターンを再現しない', !/ピットで内/.test(reply));

  const en = cards.route('understeer is bad, what should I do?', LIVE, 'en').reply;
  check('英語も終端記号で終わる', /[.?!]$/.test(en), JSON.stringify(en.slice(-12)));
}

// ── 7-4. 技術相談中にデブリーフを割り込ませない ─────────────────
{
  console.log('\n══ 7-4 デブリーフの割り込み禁止 ══');
  const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
  check('相談turnを記録する', /function markConsultationTurn\(/.test(renderer));
  check('相談継続の判定がある', /function consultationInProgress\(/.test(renderer));
  check('デブリーフ開始が相談でゲートされる',
    /function startPracticeRunReview\([\s\S]{0,220}consultationInProgress\(\)/.test(renderer));
  check('デブリーフの誘い自体も抑止される', /DEBRIEF_OFFER_SUPPRESSED/.test(renderer));
  check('抑止理由をtraceする', /reason=consultation_in_progress/.test(renderer));
  check('相談turnが実際に記録される（定義だけで終わらない）',
    /markConsultationTurn\(responseIntent\)/.test(renderer));
  check('記録の根拠はサーバの確定intent（推測しない）',
    /const responseIntent = res\.headers\.get\('X-Pitwall-Intent'\)[\s\S]{0,220}markConsultationTurn\(responseIntent\)/.test(renderer));
}

// ── 7-5. 同一 pit cycle の limiter_off は一回だけ ────────────────
{
  console.log('\n══ 7-5 limiter_off の二重発火 ══');
  const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');
  const speakSites = (bridge.match(/'trigger': 'limiter_off'/g) || []).length;
  check('発話箇所は1つだけ（ビット経路とフォールバックの二重を解消）',
    speakSites === 1, String(speakSites));
  check('リミッタービット経路は発話しない', /LIMITER BIT DIAG/.test(bridge));
  check('抑止時に理由をtraceする',
    /LIMITER_OFF_SUPPRESSED reason=already_announced_for_pit_cycle/.test(bridge));
  check('進入では再武装しない',
    !/limiter_off_announced_stop = False   # 新しいピットストップ/.test(bridge));
  check('確定したピット訪問だけが再武装する',
    /_onpit_dwell_s >= LIMITER_OFF_MIN_PIT_DWELL_S/.test(bridge)
    && /limiter_off_announced_stop = False\n\s*_limiter_cycle_armed = True/.test(bridge));
  check('滞在時間はセッションを跨がない',
    /'_onpit_dwell_s': 0\.0/.test(bridge)
    && /_onpit_dwell_s = _reset\['_onpit_dwell_s'\]/.test(bridge)
    && /_onpit_dwell_s = _sig_reset\['_onpit_dwell_s'\]/.test(bridge));
}

console.log(`\nYagi log regressions: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
