// ══════════════════════════════════════════════════════════════════════════
// 戦略質問ガード（Phase A1・2026-07-21）
//
// 【なぜ作るか】
//   オフィシャルレースでP11走行中に「今ピットへ入ると何番手で復帰するか」と聞かれ、
//   Lunaは「確認する」「リアルタイムで見ないとな」「取り返せる」と返して、
//   復帰順位も判断根拠も出せなかった。原因は2つ：
//     ① 復帰順位を計算する機構が存在しない
//     ② プロンプトに「確認すると言え」と「確認するな」が併存している
//
// 【このモジュールの責務】
//   計算器が無い／入力が足りない戦略質問を**入口で識別し、自由文LLMに渡さず**、
//   構造化された理由から**正直な返答を組み立てる**。
//   ＝「答えられないのに答えたふりをする」経路を、プロンプトでなくコードで塞ぐ。
//
// 【Phase C の約束（Yuji指示）】
//   **復帰順位を計算したふりをしない。** 実測calibrationとライブ予測が揃った時だけ
//   serverが数値を返す。足りない時は理由付きで止め、自由文LLMへ流さない。
//
// 【意図的にやらないこと】
//   - 通常会話全体を禁止語フィルタで置換すること（誤爆で会話を壊す）
//   - 分類を広く取ること（普通の雑談を戦略質問と誤認する方が有害）
//   副作用なし・純粋関数のみ。bridge/server とテストが同じ関数を使う。
// ══════════════════════════════════════════════════════════════════════════

'use strict';

/** 戦略の話題。証拠付き計算器が使える時だけ available にする。 */
const TOPIC = {
  REJOIN_POSITION: 'rejoin_position',   // 「今入ったら何位で戻れる？」
};

/** 計算できない理由。LLMに渡さず、この理由から定型文を組む。 */
const REASON = {
  NO_CALCULATOR: 'no_calculator',           // その計算器がまだ存在しない（Phase A）
  NO_PIT_LOSS_CALIBRATION: 'no_pit_loss',   // このコースのピットロス実測が無い（Phase B以降）
  NOT_RACE_SESSION: 'not_race',             // レースでないので復帰順位に意味がない
};

// ── 分類：狭く・確実に ────────────────────────────────────────────────
// 「ピットに入る意図」×「順位を問う」の**両方**が揃った時だけ戦略質問とみなす。
// 片方だけ（例「今何位？」）は通常の順位質問なので、ここでは捕まえない。
const PIT_INTENT = [
  /今\s*(から|すぐ)?\s*(ピット|ボックス|box|pit)/i,
  // 「いま入ったら何番手？」のようにピット語を省く言い方（実テストで発覚）。
  // 順位を問う条件と必ずAND評価されるので、「コースに入ったら」等は誤爆しない。
  /(今|いま)\s*(すぐ)?\s*入(っ|る|れ)/,
  /(ピット|ボックス|box|pit)\s*(に|へ)?\s*(入っ|はい|inn?|in\b)/i,
  /if\s+(i|we)\s+(pit|box)/i,
  /(pit|box)(ting)?\s+now/i,
];
const POSITION_ASK = [
  /何\s*(位|番手|番目)/,
  /どこ(まで|くらい)?\s*(落ち|下が|戻)/,
  /(what|which)\s+(position|place)/i,
  /where\s+(would|will|do)\s+(i|we)\s+(come|rejoin|end)/i,
  /rejoin/i,
];

/**
 * 直近のドライバー発言が「復帰順位の質問」かを判定する。
 * @param {string} text ドライバーの発言
 * @returns {{topic:string}|null} 該当しなければ null（＝通常会話としてLLMへ流す）
 */
function classifyStrategyQuestion(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  const hasPit = PIT_INTENT.some(re => re.test(t));
  const hasPos = POSITION_ASK.some(re => re.test(t));
  if (hasPit && hasPos) return { topic: TOPIC.REJOIN_POSITION };
  return null;
}

/**
 * その話題に今答えられるかを判定する。
 * @param {string} topic
 * @param {{hasRejoinCalculator?:boolean, isRaceSession?:boolean}} ctx
 * @returns {{available:boolean, reason:string|null}}
 */
// ★テスト専用のフォールト注入（2026-07-21・Codexレビュー再指摘）。
//   server.jsのfail-closed経路（対象質問と分かった後にevaluate/replyが例外を投げても
//   自由文LLMへ絶対に流れないこと）をHTTP統合テストで実際に確認するためのフック。
//   STRATEGY_GUARD_TEST_FAULT環境変数を明示的に設定した時だけ有効。本番では未設定＝無効。
const _TEST_FAULT = process.env.STRATEGY_GUARD_TEST_FAULT;

function evaluateAvailability(topic, ctx) {
  if (_TEST_FAULT === 'evaluate') {
    throw new Error('TEST_FAULT_INJECTION: evaluateAvailability');
  }
  const c = ctx || {};
  if (topic === TOPIC.REJOIN_POSITION) {
    if (c.isRaceSession === false) return { available: false, reason: REASON.NOT_RACE_SESSION };
    // Phase C：serverが証拠付きlive forecastを持つ時だけtrue。
    if (!c.hasRejoinCalculator) return { available: false, reason: REASON.NO_CALCULATOR };
    return { available: true, reason: null };
  }
  return { available: true, reason: null };
}

// ── 返答文（LLMに書かせない。理由から機械的に組む）────────────────────
// 「確認する」「後で見る」「折り返す」は**一切使わない**。
// 何が無いのかを言って終える。これが今回の設計の核。
const REPLY = {
  ja: {
    [REASON.NO_CALCULATOR]:
      '復帰順位はまだ出せない。ピットロスの計算がこっちに入ってないんだ。今わかるのは現在の順位と燃料だけ。',
    [REASON.NO_PIT_LOSS_CALIBRATION]:
      // ★P1-4（Codexレビュー）：「一度入れば次から出せる」は過剰な約束。
      //   1サンプルはlow confidence（給油量・タイヤ・修理条件が異なれば比較できない）。
      //   約束ではなく、今何が足りないかだけを述べる。
      'この条件のピットロス実測が足りない。今は復帰順位を出せない。',
    [REASON.NOT_RACE_SESSION]:
      '今はレースじゃないから、復帰順位は意味がないな。',
  },
  en: {
    [REASON.NO_CALCULATOR]:
      "I can't give you a rejoin position — the pit loss maths isn't wired up on my side yet. What I do have is your current position and fuel.",
    [REASON.NO_PIT_LOSS_CALIBRATION]:
      "I can't give you a rejoin position — I don't have enough pit loss data for this condition yet.",
    [REASON.NOT_RACE_SESSION]:
      "We're not racing, so a rejoin position wouldn't mean anything.",
  },
};

/**
 * 構造化された理由から、正直な返答文を作る。
 * @param {string} reason
 * @param {string} lang 'ja' | 'en'
 * @returns {string|null} 理由が未知なら null（＝呼び出し側は通常経路へ）
 */
function buildUnavailableReply(reason, lang) {
  if (_TEST_FAULT === 'reply') {
    throw new Error('TEST_FAULT_INJECTION: buildUnavailableReply');
  }
  const table = REPLY[lang === 'ja' ? 'ja' : 'en'];
  return table[reason] || null;
}

/** 返答が禁止表現を含んでいないかの自己検査（テスト用・出荷経路でも使える） */
const FORBIDDEN = [
  /確認する/, /確認中/, /折り返/, /出てから見/, /後で(見|調べ)/,
  /let me check/i, /i'?ll get back/i, /checking (the )?data/i, /stand ?by/i,
];
function containsForbiddenHedge(text) {
  if (!text) return false;
  return FORBIDDEN.some(re => re.test(text));
}

module.exports = {
  TOPIC, REASON,
  classifyStrategyQuestion,
  evaluateAvailability,
  buildUnavailableReply,
  containsForbiddenHedge,
};
