(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallDisputeDetector = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

// 訂正検出器 — 設計 v2 §B「`disputed()` を最初に判定する」
//
//   driver_turn → previous_turn / recent_reflex_context → dispute_detector
//                 → disputed() または通常intent → fact lookup → response
//
// **軸判定より前に走る。** 実走で 14 番（Luna「後ろ0.0秒」→ Yuji「後ろ2.0だね」）が
// `nearest_gap` として新しい質問に化け、3つ目の数字「1.9秒」を返した。
// 訂正を通常intentへ再分類してはならない。
//
// 判定の材料は **直前のLuna発話**（と直近の反射イベント）である。
// 発話単独では意図が決まらない。8/31 の26件の「要判断」が、文脈を戻したら5件へ減った。

// 否定・修正のシグナル。ドライバーが「今言われたことは違う」と示す形。
const NEGATION = /いや[、,]?|違う|ちがう|じゃない|ではない|ないよ|ないです|いない|来てない|来ていない|入ってない|入っていない|もうない|もう無い|足りる|足りない|そうじゃ|でなく/;
// 「〜んじゃないかな」「〜でしょ」＝ 断定を避けた訂正
const SOFT_DISPUTE = /んじゃないかな|じゃないかな|でしょ[うか]?|はず(?:だよ|です)?|と思う(?:けど)?/;
// ドライバーが値を言い直している形（数字＋助詞）
const RESTATE_VALUE = /[0-9０-９]+(?:\.[0-9]+)?\s*(?:秒|周|台|番|リッター|リットル|L|度|%)?\s*(?:だね|だよ|です|ある|ついてる|ついてます)/;

// ★実データ16件のうち5件は、上の3形のどれにも当たらなかった（2026-09-03）。
//   否定語を足していく方式では、列挙し忘れた言い回しが素通りする
//   （9/1 の pit command で同じ失敗をしている）。**型で捉える。**

// 型1: 欠落の指摘 — Lunaが言うべきだったのに言わなかった
//   [18]「車はコールしてなかったね」
const OMISSION = /(?:コール|call|言って|教えて|知らせて)\s*(?:して)?(?:な|無)かった|(?:言|教)わ(?:な|無)かった|(?:欲|ほ)しかった/;

// 型2: 別要因の提示 — Lunaの原因診断を否定して別の原因を出す
//   [29]「むしろクラッシュしてるね」
const ALT_CAUSE = /むしろ|そうじゃなくて|じゃなくて|ではなく|それより|原因は/;

// 型3: 方針・手順の不要宣言 — Lunaが続けると言った手順を止める
//   [55]「そのクリーンシューってもういらないんだよ」
const NO_LONGER_NEEDED = /(?:もう)?(?:いら|要ら)(?:な|ん)い|不要|必要ない|やめ(?:て|る|よう)|待た(?:な|ん)くて/;

// 型4: 既遂の申告 — Lunaの指示・予告に対し「もう済んでいる」
//   [57]「もうすぐ入る 入ってんだけど、もう」
const ALREADY_DONE = /(?:入|来|着|出)っ?て(?:ん|る|いる)(?:だけど|けど|よ|んだ)|もう.{0,6}(?:済|終わ|した|やった)|(?:して|やって)(?:ある|いる|る)から/;

// 型5: 値だけの言い直し — 否定語なしで、Lunaが述べた軸の値を別の値で述べる
//   [47]「incidents 4. off track.」（英語・日本語の助詞なし）
const BARE_VALUE = /^\s*(?:incidents?|inc|laps?|fuel|gap|position|p)\s*[:：]?\s*[0-9０-９]/i;

// 反射コールの種別 → 軸
const REFLEX_AXIS = {
  side_by_side: 'nearby_car',
  stopped_ahead: 'stopped_car',
  yellow_flag: 'yellow',
  multi_car_straight: 'nearby_car',
};

// Luna の直前発話から軸を推定する。**数値の権威ではなく、何について話していたか**だけ。
const LUNA_AXIS = [
  [/後ろ|背後|behind/, 'gap_behind'],
  [/前[のと]|直前車|ahead/, 'gap_ahead'],
  [/GAP|ギャップ/i, 'gap'],
  [/Incidents|インシデント/i, 'incidents'],
  [/燃料|給油|フューエル|L不足|リッター/, 'fuel'],
  [/ピット|ボックス|ステイアウト|pit|box/i, 'pit'],
  [/Plan\s*[ABC]|プラン|戦略/i, 'strategy'],
  [/左に車|右に車|3台並走/, 'nearby_car'],
  [/停止車両/, 'stopped_car'],
  [/キャンバー|荷重|温度|タイヤ/, 'car_state'],
  [/P[0-9]+|順位|ポジション/, 'position'],
  [/ベスト|ラップタイム|1:[0-9]/, 'lap_time'],
];

function axisOf(text) {
  const s = String(text || '');
  for (const [re, axis] of LUNA_AXIS) if (re.test(s)) return axis;
  return null;
}

function isReflexText(text) {
  return /^(左に車|右に車|3台並走)/.test(String(text || '').trim())
    || /前方に停止車両/.test(String(text || ''));
}

/**
 * ドライバー発話が「直前のLuna発話への訂正」かを判定する。
 *
 * @param driverText  ドライバーの発話
 * @param context     { lunaTurns: [{text, at, turn_id}], reflexes: [{kind, direction, at, authoritative}], at }
 * @returns {null | {axis, confidence, reason, prior_claim_id, prior_claim_text}}
 */
function detect(driverText, context = {}) {
  const text = String(driverText || '').trim();
  if (!text) return null;

  const lunaTurns = Array.isArray(context.lunaTurns) ? context.lunaTurns : [];
  const reflexes = Array.isArray(context.reflexes) ? context.reflexes : [];
  const prev = lunaTurns.length ? lunaTurns[lunaTurns.length - 1] : null;

  const negated = NEGATION.test(text) || ALT_CAUSE.test(text)
    || NO_LONGER_NEEDED.test(text) || OMISSION.test(text) || ALREADY_DONE.test(text);
  const soft = SOFT_DISPUTE.test(text);
  const restated = RESTATE_VALUE.test(text) || BARE_VALUE.test(text);
  if (!negated && !soft && !restated) return null;

  // ① 直前が反射コールなら、その軸への訂正として扱う。
  //    ★反射を文脈から外すと、この判定が原理的に不可能になる（v1 で3件落ちた理由）。
  const recentReflex = reflexes.length ? reflexes[reflexes.length - 1] : null;
  const prevIsReflex = prev && isReflexText(prev.text);
  if ((prevIsReflex || recentReflex) && (negated || soft)) {
    const kind = recentReflex ? recentReflex.kind : null;
    return {
      axis: (kind && REFLEX_AXIS[kind]) || axisOf(prev && prev.text) || 'nearby_car',
      confidence: 'confirmed',
      reason: 'negates_recent_reflex',
      prior_claim_id: prev ? prev.turn_id : (recentReflex ? recentReflex.event_id : null),
      prior_claim_text: prev ? prev.text : null,
    };
  }

  // ② 直前のLuna発話に軸があり、否定・言い直し・柔らかい否定のいずれかがある。
  const axis = axisOf(prev && prev.text);
  // 値だけの言い直し（型5）は、直前 Luna が同じ軸を述べていた時だけ訂正と見る。
  // そうでなければ単なる報告なので、下の candidate へ落とす。
  if (BARE_VALUE.test(text) && !NEGATION.test(text) && !axis) return null;
  if (axis && (negated || restated || soft)) {
    return {
      axis,
      confidence: (negated || restated) ? 'confirmed' : 'candidate',
      reason: negated ? 'negates_prior_claim'
        : restated ? 'restates_value' : 'soft_dispute',
      prior_claim_id: prev ? prev.turn_id : null,
      prior_claim_text: prev ? prev.text : null,
    };
  }

  // ③ 軸が特定できないが否定形。**黙って通常質問へ落とさない**（設計 v2 §B）。
  if (negated || soft) {
    return {
      axis: null,
      confidence: 'candidate',
      reason: 'conversation_dispute_candidate',
      prior_claim_id: prev ? prev.turn_id : null,
      prior_claim_text: prev ? prev.text : null,
    };
  }
  return null;
}

/**
 * 設計 v2 §E：同一ターンに訂正と命令が含まれる場合の優先順位。
 *
 *   1. P0安全反射  2. 訂正受領（短いack）  3. 明示された driver command  4. 通常会話
 *
 * 実データで該当したのは 53「いや、もうこの周で入るよ」と 54 の2件。
 * どちらも**命令として実行しつつ、訂正も受領する**必要がある。
 * **1つの発話文へ連結しない**（実走では定型文を再生して両方潰した）。
 *
 * @returns {{ order: string[], speak_first: string, execute: string|null }}
 */
function resolveTurnPriority({ dispute, driverCommand }) {
  const hasDispute = !!dispute;
  const hasCommand = driverCommand === true;
  if (hasDispute && hasCommand) {
    return {
      order: ['dispute_ack', 'driver_command'],
      speak_first: 'dispute_ack',     // 短い受領を先に返す
      execute: 'driver_command',      // 命令は実行状態へ保存し、握りつぶさない
      concatenate: false,             // 1文へ連結しない
    };
  }
  if (hasCommand) return { order: ['driver_command'], speak_first: 'driver_command', execute: 'driver_command', concatenate: false };
  if (hasDispute) return { order: ['dispute_ack'], speak_first: 'dispute_ack', execute: null, concatenate: false };
  return { order: ['normal'], speak_first: 'normal', execute: null, concatenate: false };
}

/** 訂正受領の最小応答（設計 v2 §C）：受領 → 旧値の撤回 → 新値を次から使う。 */
function acknowledgementLine(item, lang) {
  const ja = String(lang || 'ja').toLowerCase().startsWith('ja');
  const had = item && item.prior_claim_value !== null && item.prior_claim_value !== undefined;
  if (ja) {
    return had
      ? `わかった、私の${item.prior_claim_value}という記録は撤回する。次の計測から入れ替えるよ。`
      : 'わかった、今の値は保留にする。次の計測で言い直すよ。';
  }
  return had
    ? `Understood - I am retracting my ${item.prior_claim_value}. I will use yours from the next reading.`
    : 'Understood - I am holding that value and will re-state it at the next reading.';
}

return { detect, axisOf, isReflexText, acknowledgementLine, resolveTurnPriority, REFLEX_AXIS };
}));
