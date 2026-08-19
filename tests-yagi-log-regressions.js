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

  // ★8/19 契約変更：ここは以前「根拠を述べ・速度域を聞き返し・2案出し・
  //   次の観測を指定する」長文契約だった。八木さん 8/18 実走で24秒かかった
  //   ため、Yuji判断で「最初の一手＋観測1つを3〜5秒で」へ**仕様を変えた**。
  //   実装に合わせて緩めたのではなく、契約側を意図的に置き換えている。
  //   長さ・症状別の網羅検証は下の SETUP_CASES ループが担う。
  const reply = cards.route(asked[0], LIVE, 'ja').reply;
  check('温度の読み上げだけで終わらない', !/^路面[\d.]+℃、気温[\d.]+℃。$/.test(reply), reply);
  check('温度を復唱しない（読み上げは無線の無駄）', !/[0-9]+\.[0-9]℃/.test(reply), reply);
  check('最初の一手を1つだけ出す', /^まず/.test(reply) && !/か、/.test(reply), reply);
  check('次に比べる観測を1つ指定する', /3周/.test(reply), reply);
  check('車種固有の数値を断定しない', !/\d+\s*(?:クリック|ノッチ|psi|bar)/i.test(reply), reply);

  // 8/16 St Petersburg 実走: 「リアの踏ん張りが欲しい。スプリングの
  // セッティングで何かおすすめある？」に、温度の復唱や速度域の聞き返しで
  // 終わらず、指定された部品の最初の一手を短く返す。
  const rearGrip = cards.route('リアの踏ん張りが欲しい。スプリングのセッティングで何かおすすめある？', LIVE, 'ja');
  check('リアの踏ん張り＋スプリング相談をセットアップ相談に分類',
    rearGrip.card && rearGrip.card.topic === 'handling_setup_advice', rearGrip.card && rearGrip.card.topic);
  check('リアスプリングの最初の一手を短く返す',
    /リアスプリングを1段柔らかく/.test(rearGrip.reply) && rearGrip.reply.length <= 70, rearGrip.reply);
  check('同じ条件で3周比較する観測を指定する', /低速出口を3周だけ比べて/.test(rearGrip.reply), rearGrip.reply);

  // ── 8/18 St Petersburg 実走（Build 276 → 277）─────────────────────
  // アンダー相談の回答が129文字あり、TTSが4分割されて全部言い終わるまで24秒
  // かかった（22:44:42 質問 → 22:45:06 完了）。最初の声は665msで出ていたので、
  // 問題は長さそのもの。実測レートは約7文字/秒（chars=35 のチャンクが5秒）。
  // Yuji判断：許容できる間合いは3〜5秒＝21〜35文字。全症状に適用する。
  const SPEECH_CHARS_PER_SEC = 7.0;
  const SETUP_MAX_SEC = 5.0;
  const SETUP_CASES = [
    ['rear_grip',        'リアの踏ん張りが欲しい。スプリングのセッティングで何かおすすめある？'],
    ['understeer',       'アンダーステアがひどい。何か解決策ある？'],
    ['oversteer',        'オーバーステアで怖い、どうしたらいい？'],
    ['tyre_degradation', '路面温度が高すぎてタイヤが持たない。セットアップの方向、何かある？'],
    ['unspecified',      'セットアップの方向、何かある？'],
  ];
  SETUP_CASES.forEach(([sym, q]) => {
    const r = cards.route(q, LIVE, 'ja');
    const sec = r.reply.length / SPEECH_CHARS_PER_SEC;
    check(`${sym}: ${SETUP_MAX_SEC}秒以内（${r.reply.length}字 ≈ ${sec.toFixed(1)}秒）`,
      sec <= SETUP_MAX_SEC, r.reply);
    check(`${sym}: 温度を復唱しない`, !/[0-9]+\.[0-9]℃/.test(r.reply), r.reply);
    check(`${sym}: 終端記号で終わる`, /[。？！]$/.test(r.reply), r.reply);
    check(`${sym}: 助詞で途切れていない`,
      !/(?:で|に|を|が|は|の|へ|と)$/.test(r.reply.replace(/[。？！]$/, '')), r.reply);
  });

  // 症状が特定できている時は聞き返さない（一往復増やさない）。
  ['rear_grip', 'understeer', 'oversteer', 'tyre_degradation'].forEach(sym => {
    const q = SETUP_CASES.find(c => c[0] === sym)[1];
    const r = cards.route(q, LIVE, 'ja');
    check(`${sym}: 速度域を聞き返さない`, !/どこが強い/.test(r.reply), r.reply);
    check(`${sym}: 最初の一手を出す`, /^まず/.test(r.reply), r.reply);
  });
  // 症状が分からない時だけは聞き返してよい（どこを直すか決められないため）。
  check('unspecified: 症状を絞る質問をする',
    /どっちが強い/.test(cards.route(SETUP_CASES[4][1], LIVE, 'ja').reply));

  // 部品名は略さず正式名称で言う（Yuji指示・8/19）。
  const underReply = cards.route(SETUP_CASES[1][1], LIVE, 'ja').reply;
  check('部品名を正式名称で伝える（「バー」と略さない）',
    /アンチロールバー/.test(underReply) && !/フロントのバー/.test(underReply), underReply);

  // 続けて聞かれた時は、同じ答えを繰り返さず次の一手へ進む。
  const underAgain = cards.route('ほかに何かある？', LIVE, 'ja',
    { recentText: SETUP_CASES[1][1] });
  check('追撃質問で同じ回答を繰り返さない', underAgain.reply !== underReply, underAgain.reply);
  check('追撃回答は二手目を出す', /^次は/.test(underAgain.reply), underAgain.reply);
  // 「次は」の枕だけ替えて中身が一手目のままだと、ドライバーには同じ指示に
  // 聞こえる。手そのもの（枕を剥いだ本文）が変わっていることを見る。
  const strip = t => t.replace(/^(?:まず|次は)/, '');
  check('追撃回答は一手目と別の手を出す（枕だけの差し替えを禁止）',
    strip(underAgain.reply) !== strip(underReply), underAgain.reply);
  check('追撃回答も5秒以内',
    (underAgain.reply.length / SPEECH_CHARS_PER_SEC) <= SETUP_MAX_SEC, underAgain.reply);

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
