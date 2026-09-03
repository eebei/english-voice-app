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
  // ★反射語を最優先。9/3 のコーパス再生で #30 が
  //   「わかった。ピット前に確認する。…左に車。」から `pit` を拾い、
  //   ドライバーの「左全然車いないです」を **ピットの訂正**にしていた。
  //   1発話に複数の話題が混ざる時、**最後に言った反射**が訂正の対象である。
  [/(左に車|右に車|3台並走|前方に停止車両)[^]*$/, 'nearby_car'],
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

// ★Gate 4 §2：反射語最優先は **Luna 発話**の話題判定のための規則で、
//   ドライバーの「ピット判断が違う。左に車は関係ない。」に当てると
//   ドライバーが明示した `pit` を反射語が食う。ドライバー側は反射規則を外して見る。
function driverAxisOf(text) {
  const s = String(text || '');
  for (const [re, axis] of LUNA_AXIS.slice(1)) if (re.test(s)) return axis;
  return null;
}

function axisOf(text) {
  const s = String(text || '');
  for (const [re, axis] of LUNA_AXIS) if (re.test(s)) return axis;
  return null;
}

/**
 * ★2026-09-03 Codex コーパス再生の指摘：#14「後ろ2.0だね。ギャップ。」の軸が
 * `lap_time` になった。訂正の1秒前に「ベスト更新。1:31.495。」が割り込んでおり、
 * **直前1件しか見ていなかった**ため、訂正の対象でない発話から軸を取っていた。
 *
 *   09:24:23 前5.9秒。
 *   09:25:01 後ろ0.0秒。          ← 訂正の対象はこれ
 *   09:25:02 ベスト更新。1:31.495。 ← 直前だが無関係
 *   09:25:11 「後ろ2.0だね。ギャップ。」
 *
 * ドライバー自身が「後ろ」「ギャップ」と軸を言っている。**まずそれを見る。**
 * 一致する軸を述べた Luna 発話を、直近から遡って探す。
 * 見つからなければ従来どおり直前発話の軸を使う。
 */
// ★2026-09-03 Codex Gate 4 §1：遡り探索に上限が無く、**10分前の GAP 発話**を
//   現在の訂正対象にできた。レース中の値は数十秒で古くなる。上限外は fail-closed。
//
// ★上限値は実走分布から決めた（Codex「上限値は実走分布で決め、決まるまで署名しない」）。
//   母集団は `review/corpus/labels_v2.json` の **`speech_act === '訂正'` の16件**
//   （#14,17,18,24,25,27,29,30,44,47,54,55,57,59,61,62）。16件とも撤回対象を持つ。
//   `review/corpus/utterances_20260830_20260831.json` で測った実時間差（秒）:
//     1, 8, 9, 12, 15, 21, 22, 25, 26, 28, 28, 30, 30, 32, 35, 38
//     中央値 25 ／ 90 パーセンタイル 32 ／ **最大 38**
//   実測最大 38 秒に対し **90 秒**（約2.4倍）を上限に置く。4セッション16件の標本なので、
//   実走が増えたら測り直す。
//   ※ #64（185秒）は `speech_act === '報告'`（Codex が訂正→報告へ再判定した #62 の再提出）。
//     **母集団に入れていない。** 上限の根拠には使わないが、同軸が無い時に古い無関係な発話を
//     撤回対象にしないことの境界として `tests-dispute-boundaries.js` に登録している。
const AXIS_LOOKBACK_MS = 90000;

function resolveAxis(driverText, lunaTurns, at) {
  const turns = Array.isArray(lunaTurns) ? lunaTurns : [];
  const now = typeof at === 'number' ? at : null;
  const tooOld = (t) => now !== null && typeof t.at === 'number'
    && (now - t.at) > AXIS_LOOKBACK_MS;
  const prev = turns.length ? turns[turns.length - 1] : null;
  const spoken = driverAxisOf(driverText);     // ドライバーが明示した軸
  if (spoken) {
    // 同じ軸を述べた Luna 発話を新しい順に探す（無ければ軸だけ採用）
    for (let i = turns.length - 1; i >= 0; i--) {
      if (axisOf(turns[i].text) !== spoken) continue;
      // 上限外の同軸は撤回対象にしない。軸だけ残し candidate へ落とす。
      if (tooOld(turns[i])) {
        return { axis: spoken, target: null, source: 'driver_stated_axis_expired',
                 expired: true };
      }
      return { axis: spoken, target: turns[i], source: 'driver_stated_axis' };
    }
    // 同軸の発話が無い時、直前発話を撤回対象にしてよいのは上限内だけ。
    // #64「incidents 3, All off track.」は 185 秒前の「iRacingが切れちゃった。」を
    // 撤回対象にしていた。軸は残し、撤回対象は持たせない。
    if (prev && tooOld(prev)) {
      return { axis: spoken, target: null, source: 'driver_stated_axis_no_target' };
    }
    return { axis: spoken, target: prev, source: 'driver_stated_axis_no_match' };
  }
  return { axis: axisOf(prev && prev.text), target: prev, source: 'previous_turn_axis' };
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
  // ★反射経路へ入れるのは「直前発話が反射」か「反射が直前発話より新しい」時だけ。
  //   9/3 のコーパス再生で #44（デブリーフ中の Incidents 訂正）が、
  //   ずっと前のレース中の反射を拾って `nearby_car` になっていた。
  //   反射の鮮度を見ないと、セッションを跨いで誤った軸を付ける。
  const lastReflex = reflexes.length ? reflexes[reflexes.length - 1] : null;
  const prevIsReflex = prev && isReflexText(prev.text);
  // ★Gate 4 §3：`>=` は同時刻を fresh 扱いし、検出器単体に絶対鮮度の検査が無かった。
  //   呼出し側の120秒窓に依存せず、単体契約として fail-closed にする。
  const REFLEX_FRESH_MS = 120000;
  const at = typeof context.at === 'number' ? context.at : null;
  const reflexAbsFresh = !!(lastReflex && (at === null
    || (at - lastReflex.at > 0 && at - lastReflex.at <= REFLEX_FRESH_MS)));
  const reflexIsFresh = !!(lastReflex && prev && lastReflex.at > prev.at && reflexAbsFresh);

  // ★Gate 4 §2：1発話にピットと反射が混在し、ドライバーが**ピットだけ**を訂正すると
  //   反射経路が先に返って `nearby_car` になった。明示軸と反射否定が同一ターンに
  //   混ざる時は、1軸へ決め打ちせず candidate へ落とす。
  const spokenAxis = driverAxisOf(text);
  const negatesReflexWord = /(左|右|3台|停止車両).{0,6}(いない|関係ない|ない)/.test(text);
  // 直前の Luna 発話がその反射語を実際に含むか。#30（実走）の
  // 「わかった。ピット前に確認する。…左に車。」はここが true で、撤回対象が実在する。
  // Codex §3 反例の「インシデント3件。」は false ＝ 撤回してよい対象が無い。
  const prevMentionsReflex = !!(prev
    && /左に車|右に車|3台並走|停止車両/.test(String(prev.text || '')));
  const mixedAxisConflict = !!(spokenAxis && spokenAxis !== 'nearby_car'
    && spokenAxis !== 'stopped_car' && negatesReflexWord && prevMentionsReflex);
  const recentReflex = (prevIsReflex || reflexIsFresh) ? (reflexAbsFresh ? lastReflex : null) : null;
  // ★Gate 4 §3：反射語を否定しているのに、直前が反射でもなく鮮度ある反射も無い。
  //   古い反射を根拠に無関係な発話（例「インシデント3件。」）を撤回してはならない。
  if (negatesReflexWord && !prevIsReflex && !reflexIsFresh && !prevMentionsReflex) {
    return { axis: null, confidence: 'candidate', reason: 'stale_reflex_negation',
             prior_claim_id: null, prior_claim_text: null };
  }
  if (mixedAxisConflict) {
    return { axis: null, confidence: 'candidate', reason: 'mixed_axis_conflict',
             prior_claim_id: prev ? prev.turn_id : null,
             prior_claim_text: prev ? prev.text : null };
  }
  // ★Gate 4 §2-a：ドライバーが明示軸だけを訂正し、反射を一切否定していない時
  //   （「ピット判断が違う。」／直前「左に車。今周ピットを確認する。」）は、
  //   直前が反射語で始まるというだけで反射経路へ入れてはならない。明示軸を先に解決する。
  const explicitNonReflexAxis = !!(spokenAxis && !negatesReflexWord);
  if (!explicitNonReflexAxis && (prevIsReflex || reflexIsFresh) && (negated || soft)) {
    const kind = recentReflex ? recentReflex.kind : null;
    return {
      axis: (kind && REFLEX_AXIS[kind]) || axisOf(prev && prev.text) || 'nearby_car',
      confidence: 'confirmed',
      reason: 'negates_recent_reflex',
      prior_claim_id: prev ? prev.turn_id : (recentReflex ? recentReflex.event_id : null),
      prior_claim_text: prev ? prev.text : null,
    };
  }

  // ② 軸を決める。ドライバーが明示した軸を優先し、その軸を述べた発話を遡って探す。
  const resolved = resolveAxis(text, lunaTurns, at);
  const axis = resolved.axis;
  // ★`|| prev` を書くと、上限外として意図的に null にした撤回対象が復活する。
  //   `resolveAxis()` が対象を出さなかった時は、対象なしのまま扱う。
  const target = resolved.source ? resolved.target
    : (resolved.target || prev);
  // 値だけの言い直し（型5）は、Luna が同じ軸を述べていた時だけ訂正と見る。
  // そうでなければ単なる報告なので、下の candidate へ落とす。
  if (BARE_VALUE.test(text) && !NEGATION.test(text) && !axis) return null;
  if (axis && (negated || restated || soft)) {
    return {
      axis,
      confidence: resolved.expired ? 'candidate'
        : ((negated || restated) ? 'confirmed' : 'candidate'),
      // 上限外は撤回対象を持たせない。別の発話を誤って撤回させない。
      reason: negated ? 'negates_prior_claim'
        : restated ? 'restates_value' : 'soft_dispute',
      axis_source: resolved.source,
      prior_claim_id: (resolved.expired || !target) ? null : target.turn_id,
      prior_claim_text: target ? target.text : null,
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

return { detect, axisOf, resolveAxis, isReflexText, acknowledgementLine, resolveTurnPriority, REFLEX_AXIS };
}));
