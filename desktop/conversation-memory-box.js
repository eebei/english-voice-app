(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  // desktop は <script src> + グローバルで runtime module を読む（renderer に require は無い）
  else root.PitwallConversationMemoryBox = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

// 会話記憶ボックス v2
//   設計: review/CONVERSATION_MEMORY_BOX_CODEX_DESIGN_20260902.md（Codex v2 + §7 実装許可）
//   反証: 同MD「Claude Code 再反証 v2」「実装前最終反証（2026-09-03）」
//
// なぜ要るか（Yuji の指摘・2026-09-02）:
//   「Lunaはその都度回答している。会話の連動性がない」
//   実測で、ドライバー発話68件のうち **訂正16件の正答率が0%**。
//   `measurement_disputed` は実走4本で発火0件。訂正が別の質問へ化けるか、会話へ流れていた。
//
// 中核の分担:
//   turns      … 誰が何をいつ言ったか（会話の連続性）
//   timeline   … 反射イベント（権威つき）。全件保持するがLLM文脈へは絞って渡す
//   open_items … 訂正・約束の状態。**訂正状態の正本はここ**（設計 v2 §D）
//
// 数値の権威は Bridge / local fact engine に残る。**この箱は数値を決めない。**
// 箱の中の数字は「そう言った記録」であって「今の値」ではない。

const REFLEX_WINDOW_MS = 120000;   // 設計 v2 §A：直近120秒
const REFLEX_MAX = 5;              // 設計 v2 §A：最大5件
const TURN_WINDOW_MS = 30 * 60000; // 設計 v2 §5：直近30分
const TURN_MAX = 60;               // 設計 v2 §2：直近60 turn

function nowMs(clock) { return typeof clock === 'number' ? clock : Date.now(); }
function str(v) { return v === null || v === undefined ? '' : String(v); }

function emptyBox(sessionKey) {
  return { session_key: str(sessionKey), turns: [], timeline: [], open_items: [], seq: 0 };
}

/** 会話ターンを1件足す。反射コールは turns へ入れない（timeline 側へ）。 */
function addTurn(box, { who, text, at, kind }) {
  if (!box || !text) return box;
  box.seq += 1;
  box.turns.push({
    turn_id: 't' + box.seq,
    who: who === 'driver' ? 'driver' : 'luna',
    text: str(text),
    at: nowMs(at),
    kind: kind ? str(kind) : null,
  });
  return box;
}

/**
 * ★2026-09-05 Codex Gate 4 P1-3：本文一致で最後の1件を探す方式では、
 *   表示してからTTSが始まるまでの間に別の Luna 発話が入ると対象を見失う。
 *   実走5件が成功したのは**その5件で割込みが無かった**だけで、境界を踏んでいない。
 *   turn_id で名指しする。存在しなければ何もしない（取り違えて消す方が危険）。
 */
function amendTurn(box, turnId, newText) {
  if (!box || !turnId || !Array.isArray(box.turns)) return false;
  const t = box.turns.find(x => x.turn_id === String(turnId));
  if (!t) return false;
  t.text = str(newText);
  return true;
}

function dropTurn(box, turnId) {
  if (!box || !turnId || !Array.isArray(box.turns)) return false;
  const i = box.turns.findIndex(x => x.turn_id === String(turnId));
  if (i < 0) return false;
  box.turns.splice(i, 1);
  return true;
}

/** 反射イベントを timeline へ足す。権威イベント（Bridge由来）かどうかを必ず持つ。 */
function addReflex(box, { kind, direction, target, at, spoken, authoritative }) {
  if (!box || !kind) return box;
  box.seq += 1;
  box.timeline.push({
    event_id: 'r' + box.seq,
    kind: str(kind),
    direction: direction ? str(direction) : null,
    target: target === null || target === undefined ? null : target,
    at: nowMs(at),
    spoken: spoken !== false,
    // ★LLM生成の反射を許可しない（設計 §7-5）。権威イベントを伴わないものは false。
    authoritative: authoritative === true,
  });
  return box;
}

/**
 * LLM 文脈へ渡す反射イベント。
 *
 * ★順序が契約である（実装前最終反証 §4）。
 *   実走の120秒窓には最大 **9件** 入る。上限5件を先に当てると古い反射が押し出され、
 *   「左に車」→「左は壁しかない」の訂正が検出不能になる（v1 で落ちた3件がこれ）。
 *   集約後は最大4件なので、**集約 → 上限** の順なら5件で足りる。
 */
function reflexContext(box, at, opts = {}) {
  if (!box) return [];
  const t = nowMs(at);
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : REFLEX_WINDOW_MS;
  const max = Number.isFinite(opts.max) ? opts.max : REFLEX_MAX;
  const inWindow = box.timeline.filter(e => e.at >= t - windowMs && e.at <= t);
  // 1) 集約：同一種別・同一方向・同一対象の**連続**を1件へ畳む
  const collapsed = [];
  for (const e of inWindow) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.kind === e.kind && prev.direction === e.direction
        && prev.target === e.target) {
      prev.repeat = (prev.repeat || 1) + 1;
      prev.at = e.at;                     // 最後に鳴った時刻を持つ
      prev.event_id = e.event_id;
      continue;
    }
    collapsed.push(Object.assign({ repeat: 1 }, e));
  }
  // 2) 上限：集約した結果から直近 max 件
  return collapsed.slice(-max);
}

/** LLM 文脈へ渡す会話ターン。直近30分かつ直近60件。 */
function turnContext(box, at, opts = {}) {
  if (!box) return [];
  const t = nowMs(at);
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : TURN_WINDOW_MS;
  const max = Number.isFinite(opts.max) ? opts.max : TURN_MAX;
  return box.turns.filter(x => x.at >= t - windowMs && x.at <= t).slice(-max);
}

// ── open_items（訂正の状態機械・設計 v2 §C/§D） ────────────────────────
//   open → acknowledged → (corrected) → resolved
//   open → held → resolved
//   open → expired

const OPEN = 'open', ACK = 'acknowledged', HELD = 'held',
      CORRECTED = 'corrected', RESOLVED = 'resolved', EXPIRED = 'expired';

/**
 * 訂正を1件開く。**ドライバーの自由文を新しい数値として自動採用しない。**
 * `prior_claim_*` は Luna が直前に述べた値で、撤回の対象になる。
 */
function openDispute(box, { axis, source_turn_id, driver_observation,
                            prior_claim_id, prior_claim_value, at }) {
  if (!box || !axis) return null;
  box.seq += 1;
  const item = {
    item_id: 'd' + box.seq,
    axis: str(axis),
    source_turn_id: source_turn_id ? str(source_turn_id) : null,
    driver_observation: str(driver_observation),
    prior_claim_id: prior_claim_id ? str(prior_claim_id) : null,
    prior_claim_value: prior_claim_value === undefined ? null : prior_claim_value,
    observed_value: null,
    corrected_value: null,
    replacement_source: null,
    luna_value_retracted: false,
    status: OPEN,
    opened_at: nowMs(at),
    updated_at: nowMs(at),
  };
  box.open_items.push(item);
  return item;
}

function findItem(box, itemId) {
  return (box && box.open_items || []).find(i => i.item_id === itemId) || null;
}

/** 未解決の訂正を軸で探す。**同一軸への再提出は新規報告にしない**（14分後の言い直し対策）。 */
function findOpenByAxis(box, axis) {
  const live = [OPEN, ACK, HELD, CORRECTED];
  return (box && box.open_items || [])
    .filter(i => i.axis === str(axis) && live.includes(i.status))
    .slice(-1)[0] || null;
}

/** 受領。**これだけでは resolved にしない**（受理と撤回は別の動作）。 */
function acknowledge(box, itemId, at) {
  const it = findItem(box, itemId);
  if (!it || it.status === RESOLVED || it.status === EXPIRED) return null;
  it.status = ACK;
  it.updated_at = nowMs(at);
  return it;
}

/** ★Luna の旧値を撤回する。撤回前の旧値は回答・要約・戦略計算へ使ってはならない。 */
function retract(box, itemId, at) {
  const it = findItem(box, itemId);
  if (!it || it.status === EXPIRED) return null;
  it.luna_value_retracted = true;
  it.updated_at = nowMs(at);
  return it;
}

/** 再観測で確定した値を入れる。ドライバーの自由文ではなく、権威ある観測だけを受ける。 */
function resolve(box, itemId, { corrected_value, replacement_source, at } = {}) {
  const it = findItem(box, itemId);
  if (!it || it.status === EXPIRED) return null;
  if (corrected_value !== undefined) it.corrected_value = corrected_value;
  if (replacement_source) it.replacement_source = str(replacement_source);
  it.status = RESOLVED;
  it.updated_at = nowMs(at);
  return it;
}

function hold(box, itemId, at) {
  const it = findItem(box, itemId);
  if (!it || it.status === RESOLVED || it.status === EXPIRED) return null;
  it.status = HELD;
  it.updated_at = nowMs(at);
  return it;
}

/** セッション終了・対象失効で以後の利用を禁じる。 */
function expire(box, itemId, at) {
  const it = findItem(box, itemId);
  if (!it) return null;
  it.status = EXPIRED;
  it.updated_at = nowMs(at);
  return it;
}

/** 撤回されていない旧値だけが「使ってよい」。撤回済みは再利用禁止。 */
function isPriorClaimUsable(box, axis) {
  const it = findOpenByAxis(box, axis);
  if (!it) return true;
  return !it.luna_value_retracted;
}

/** 未解決の訂正（LLM文脈と、次の発話判断へ渡す）。 */
function unresolved(box) {
  const live = [OPEN, ACK, HELD, CORRECTED];
  return (box && box.open_items || []).filter(i => live.includes(i.status));
}

/**
 * 長期記憶へ移してよいか（設計 v2 §D）。
 * `resolved` かつ `luna_value_retracted` の後だけ。合意前を恒久的事実にしない。
 */
function readyForLongTerm(item) {
  return !!item && item.status === RESOLVED && item.luna_value_retracted === true;
}

/** LLM へ渡す1個のコンテキスト。**数値の権威は持たない**ことを明示して渡す。 */
function buildContext(box, at, opts = {}) {
  return {
    session_key: box ? box.session_key : '',
    turns: turnContext(box, at, opts.turns || {}),
    recent_reflex: reflexContext(box, at, opts.reflex || {}),
    open_items: unresolved(box).map(i => ({
      item_id: i.item_id, axis: i.axis, status: i.status,
      driver_observation: i.driver_observation,
      prior_claim_value: i.luna_value_retracted ? null : i.prior_claim_value,
      luna_value_retracted: i.luna_value_retracted,
    })),
    // 読み手（プロンプト）への契約。履歴の数字を現在値として使わせない。
    contract: 'history_numbers_are_not_current_facts',
  };
}

return {
  emptyBox, addTurn, amendTurn, dropTurn, addReflex,
  reflexContext, turnContext, buildContext,
  openDispute, findItem, findOpenByAxis,
  acknowledge, retract, resolve, hold, expire,
  isPriorClaimUsable, unresolved, readyForLongTerm,
  STATUS: { OPEN, ACK, HELD, CORRECTED, RESOLVED, EXPIRED },
  LIMITS: { REFLEX_WINDOW_MS, REFLEX_MAX, TURN_WINDOW_MS, TURN_MAX },
};
}));
