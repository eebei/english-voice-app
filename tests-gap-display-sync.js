// Overlay表示・会話Box・実際に再生されたTTS本文を一致させる契約。
//
// 出典: `review/PITWALL_SHARED_WORKING_LOG.md` 2026-09-05「Codex独立レビュー：Build 297事後Gate 4」
//
// 初版は Gate 4 不合格（P1 3件）。差戻し理由:
//   P1-1 異言語Overlayで**旧翻訳が原文より優先**され、rebuild後も古い訳が残る
//   P1-2 非再生の出口は drainQueue の discard だけではない（session終了/voice off/
//        overflow/キャラ未選択/PTT押下）。そこを通ると耳で聞いていない発話が残る
//   P1-3 本文一致＋直近Luna1件では、割込みがあると対象を見失う。turn_id で名指しする
//   テスト  「実経路」と称して helper しか動かしておらず、契約を証明していなかった
//
// Codex 指定の実行型5反例:
//   ① 翻訳前後の rebuild 競合   ② queued GAP の duplicate discard
//   ③ 別Luna発話を挟んだ rebuild ④ 全TTS失敗   ⑤ play_started 時の同一発話ID

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const box = require('./desktop/conversation-memory-box.js');

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; return true; }
  failures.push(name + (detail ? '\n     ' + detail : ''));
  return false;
}

const renderer = fs.readFileSync(path.join(__dirname, 'desktop', 'renderer.html'), 'utf8');
const overlayHtml = fs.readFileSync(path.join(__dirname, 'desktop', 'overlay.html'), 'utf8');

// ── 1. 配線検査（定義しただけを通さない）─────────────────────────
const drainSrc = (renderer.match(/async function drainQueue\([^)]*\)\{[\s\S]*?\n\}/)
  || renderer.match(/function drainQueue\([^)]*\)\{[\s\S]*?\n\}/) || [''])[0];

check('drainQueue を取り出せる', !!drainSrc);
check('drainQueue の discard が finalizer を通る',
  /fate === 'discard'[\s\S]*?finalizeUtterance\(_it,'dropped'/.test(drainSrc));
check('drainQueue の rebuild が finalizer を通る',
  /finalizeUtterance\(_it,'rebuilt'/.test(drainSrc));
check('speak() が表示要素を持ち歩く', /displayEl:o\.displayEl\|\|null/.test(renderer));
check('addMsg が Overlay行IDを結び付ける', /div\._ovlId = convoLog\(type, text\)/.test(renderer));
check('addMsg が turn_id を結び付ける（P1-3）',
  /div\._turnId = recordLunaTurn\(text, null\)/.test(renderer));
check('recordLunaTurn が turn_id を返す（P1-3）',
  /return _last\?_last\.turn_id:null/.test(renderer));

// ★受入条件1・5：製品の**全分岐**が明示した終端へ到達するか。
//   dedupe と overflow を一つの検査名／正規表現で代用しない（Codex 指定）。
for (const [name, re] of [
  ['duplicate（dedupeKey重複）', /finalizeUtterance\(item,'dropped',null,'duplicate_dedupe_key'\)/],
  ['overflow（キュー溢れ）', /finalizeUtterance\(speakQueue\[wi\],'dropped',null,'queue_overflow'\)/],
  ['defer cap', /finalizeUtterance\(displaced,'dropped',null,'defer_cap_reached'\)/],
  ['session終了', /discardQueuedUtterances\(speakQueue,'session_end'\)/],
  ['voice off', /discardQueuedUtterances\(speakQueue,'voice_off'\)/],
  ['PTT全消去', /discardQueuedUtterances\(speakQueue,'ptt_pressed'\)/],
  ['character無し', /discardQueuedUtterances\(speakQueue,'no_character'\)/],
  ['GAP stale（自発コール）', /finalizeUtterance\(_it,'dropped',null,'gap_'\+_fresh\.reason\)/],
  ['GAP stale（**PTT回答**）', /finalizeUtterance\(_it,'dropped',null,'gap_answer_'\+_ans\.reason\)/],
  ['GAP rebuild（**PTT回答**）', /finalizeUtterance\(_it,'rebuilt',_rebuiltAns\)/],
  ['mode切替のfilter除去', /discardQueuedUtterances\(speakQueue\.filter\(q=>!_keep\(q\)\),'mode_switch'\)/],
  ['非emergency text-only（TTS停止中）', /finalizeUtterance\(_it,'dropped',null,'cloud_tts_disabled_text_only'\)/],
  ['TTS失敗 text-only', /finalizeUtterance\(_it,'dropped',null,'tts_failed_text_only'\)/],
  ['WebSpeech onerror', /finalizeUtterance\(currentSpeakItem,'dropped',null,'webspeech_onerror'\)/],
  ['WebSpeech throw', /finalizeUtterance\(currentSpeakItem,'dropped',null,'webspeech_throw'\)/],
  ['現在発話の割込み', /finalizeUtterance\(currentSpeakItem,'dropped',null,'interrupted_before_start'\)/],
  ['実再生開始→spoken', /finalizeUtterance\(_it,'spoken'\)/],
]) check('受入①分岐が終端へ到達：' + name, re.test(renderer));

// ★受入条件2：stable utterance_id が candidate→queue→表示→trace を貫く
check('受入② candidate で採番する', /const _uid = nextUtteranceId\(\);/.test(renderer));
check('受入② 表示要素へ持たせる', /div\._uid = opts\.uid/.test(renderer));
check('受入② queue item へ持たせる', /utteranceId:o\.utteranceId\|\|\(o\.displayEl&&o\.displayEl\._uid\)/.test(renderer));
check('受入② final trace に uid が出る', /UTTERANCE_FINAL','uid='\+_uid/.test(renderer));
// ★第3回P1-3：**製品の** speechLatencyTrace に utterance_id があること。
//   旧テストは stub 側へ uid を入れて「貫いた」と判定していた＝オラクル汚染。
check('受入② SPEECH_LATENCY に utterance_id が入る（製品側）',
  /utterance_id:\(item&&item\.utteranceId\)\|\|null/.test(renderer));
// ★第3回P1-1：PTT回答の出口が displayEl と uid を渡すこと
check('受入① PTT回答が採番して同じ要素を speak へ渡す',
  /const _ansUid = nextUtteranceId\(\);/.test(renderer)
  && /const _ansEl = addMsg\('ai',reply,\{uid:_ansUid\}\);/.test(renderer)
  && /displayEl:_ansEl, utteranceId:_ansUid,/.test(renderer));

// ★受入条件3：WebSpeech は実開始境界でだけ spoken
check('受入③ WebSpeech は onstart で報告', /utt\.onstart=\(\)=>\{[\s\S]{0,120}onStart\(\)/.test(renderer));
check('受入③ 再生前 reportSpoke を残していない',
  !/reportSpoke\(\);\s*\n\s*playWebSpeech/.test(renderer), '再生前報告が残っている');

// 出口の数え上げ：finalizer を通らない speakQueue 全消去が残っていないか
{
  const lines = renderer.split('\n');
  const clears = lines
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(x => /speakQueue\s*=\s*\[\]/.test(x.l)
                 && !/^let speakQueue/.test(x.l.trim())
                 && !/^\s*\/\//.test(x.l));
  const guarded = clears.filter(x =>
    /discardQueuedUtterances/.test(lines[x.i - 2] || '') ||
    /discardQueuedUtterances/.test(x.l));
  // ★第3回P1-4：`=[]` だけでなく filter/splice も数える。
  //   ただし「再生するために取り出す」1箇所（`const _it = speakQueue.splice(...)`）は
  //   除去ではなく正常経路なので除く。ここを drop 扱いにすると何も喋らなくなる。
  const removals = lines
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(x => /speakQueue\s*=\s*speakQueue\.filter\(|speakQueue\.splice\(/.test(x.l)
                 && !/^\s*\/\//.test(x.l)
                 && !/=\s*speakQueue\.splice\([^)]*\)\[0\]/.test(x.l));
  const removalsGuarded = removals.filter(x => {
    const ctx = lines.slice(Math.max(0, x.i - 4), x.i + 1).join('\n');
    return /discardQueuedUtterances|finalizeUtterance/.test(ctx);
  });
  check('speakQueue の filter/splice 除去も finalizer を伴う',
    removals.length > 0 && removals.length === removalsGuarded.length,
    `全${removals.length}件中 ${removalsGuarded.length}件。未対応行=${
      removals.filter(r => !removalsGuarded.includes(r)).map(r => r.i).join(',') || 'なし'}`);
  check('speakQueue の全消去が全部 finalizer を伴う',
    clears.length > 0 && clears.length === guarded.length,
    `全${clears.length}件中 ${guarded.length}件。未対応行=${
      clears.filter(c => !guarded.includes(c)).map(c => c.i).join(',') || 'なし'}`);
}

// ★P1-1：翻訳の扱い
check('P1-1 rebuild で訳を無効化して渡す',
  /overlayPush\(\{ update:true, id:el\._ovlId, text:finalText, tr:'', trLang:'' \}\)/.test(renderer));
check('P1-1 翻訳promiseに世代を載せる', /gen:_genAtRequest/.test(renderer));
check('P1-1 overlay が本文差替時に訳を捨てる',
  /d\.orig = line\.text; d\.tr = ''; d\.trLang = ''; d\.gen = \(d\.gen\|\|0\) \+ 1;/.test(overlayHtml));
check('P1-1 overlay が古い世代の訳を弾く',
  /if\(line\.gen === undefined \|\| line\.gen === d\.gen\)/.test(overlayHtml));
check('overlay が行削除を受け付ける', /if\(line\.remove\)/.test(overlayHtml));

// ── 2. 実経路（renderer / overlay 窓の関数を実際に動かす）─────────
// 波括弧を数えて関数を丸ごと取り出す。正規表現の非貪欲一致は try/catch や
// ネストした関数で途中終了し、構文エラーの断片を渡してしまう。
const grab = (src, name) => {
  const head = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = head.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1;
  let inS = null, esc = false, inLine = false, inBlock = false;
  while (i < src.length && depth > 0) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; }
    else if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } }
    else if (inS) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inS) inS = null;
    }
    else if (c === '/' && n === '/') { inLine = true; i++; }
    else if (c === '/' && n === '*') { inBlock = true; i++; }
    else if (c === '"' || c === "'" || c === '`') inS = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return depth === 0 ? src.slice(m.index, i) : null;
};
const names = ['addMsg', 'recordLunaTurn', 'amendLunaTurnById', 'dropLunaTurnById',
               'finalizeUtterance', 'discardQueuedUtterances', 'nextUtteranceId', 'speak',
               'ensureConversationBox', 'saveConversationBox', 'conversationSessionKey', 'convoLog'];
const parts = names.map(n => grab(renderer, n));
check('実経路の関数群を renderer から取り出せる', parts.every(Boolean),
  names.filter((_, i) => !parts[i]).join(', '));

// ★P1-1 の本体は overlay 窓側の textFor。実物を動かす。
const ovlNames = ['pushLine', 'textFor'];
const ovlParts = ovlNames.map(n => grab(overlayHtml, n));
check('Overlay 窓の関数を取り出せる', ovlParts.every(Boolean),
  ovlNames.filter((_, i) => !ovlParts[i]).join(', '));

if (parts.every(Boolean) && ovlParts.every(Boolean)) {
  // ── Overlay 窓のミニ実装（実物の pushLine / textFor を動かす）──
  const rows = [];
  const ovlCtx = {
    byId: {}, dispLang: 'en',
    wrap: {
      querySelector(sel) {
        const m = /data-id="([^"]+)"/.exec(sel);
        return rows.find(r => r.dataset.id === m[1]) || null;
      },
      querySelectorAll() { return rows; },
      appendChild(el) {
        el.parentNode = { removeChild: (x) => { const i = rows.indexOf(x); if (i >= 0) rows.splice(i, 1); } };
        rows.push(el);
      },
    },
    reflow: () => {},
    document: {
      createElement: () => ({
        className: '', dataset: {}, textContent: '', _kids: [], parentNode: null,
        appendChild(c) { this._kids.push(c); },
        querySelector(sel) { return this._kids.find(k => k.className === sel.replace('.', '')) || null; },
      }),
    },
    console,
  };
  ovlCtx.globalThis = ovlCtx;
  vm.createContext(ovlCtx);
  vm.runInContext(ovlParts.join('\n'), ovlCtx);

  const overlayPush = (line) => { ovlCtx.__line = line; vm.runInContext('pushLine(__line);', ovlCtx); };
  const ovlTextOf = (id) => {
    const row = rows.find(r => r.dataset.id === id);
    if (!row) return null;
    const tx = row._kids.find(k => k.className === 'tx');
    return tx ? tx.textContent : null;
  };

  // ── renderer 側 ──
  const store = {};
  let ovlSeq = 0;
  const ctx = {
    window: { PitwallConversationMemoryBox: box, pitwall: { overlayPush } },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    document: {
      getElementById: () => ({ appendChild(){}, scrollTop:0, scrollHeight:0 }),
      createElement: () => ({ textContent:'', className:'', parentNode:null }),
    },
    lastTelemetry: null, lastTrack: 'le mans', lastCarModel: 'Mercedes-AMG GT3 2020',
    lastCarClass: 'GT3', lastSessionType: 'Race',
    currentMemoryUserId: () => 'u1', lastSessionNum: 1, irBridge: null, sel: 'LunaJP',
    // 実物の mirrorToOverlay は言語判定・翻訳に依存するため、ここでは
    // 「Overlay へ push して行IDを返す」役割だけを与える（行IDの結合を実行で確かめる）。
    mirrorToOverlay: (type, text) => {
      const id = 'L' + (++ovlSeq);
      overlayPush({ id, type: type === 'ai' ? 'ai' : 'drv', name: 'ENG', text, lang: 'ja' });
      return id;
    },
    diagnosticLog: () => {}, console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // renderer の module 変数（関数外なので grab では取れない）を先に置く。
  vm.runInContext("var _convoBox = null; var CONVO_BOX_KEY = 'pw_conversation_box_v1';"
    + " var _uttSeq = 0; var currentSpeakItem = null; var speakGeneration = 0;"
    + " var voiceOn = true; var currentSpeakPrio = 9; var draining = false; var isSpeaking = false;"
    + " var MAX_RADIO_QUEUE = 8; var MAX_DEFER = 2;\n"
    + parts.join('\n'), ctx);

  const boxOf = () => {
    const k = Object.keys(store).find(x => /conversation/i.test(x));
    return k ? JSON.parse(store[k]) : null;
  };
  const lunaTexts = () => {
    const b = boxOf();
    return b && Array.isArray(b.turns) ? b.turns.filter(t => t.who === 'luna').map(t => t.text) : [];
  };

  // ── ③ 別Luna発話を挟んだ rebuild（P1-3 の本体）────────────────
  vm.runInContext("var elA = addMsg('ai','後ろ3.4秒。1.2秒縮んだ。');", ctx);
  vm.runInContext("var elMid = addMsg('ai','左に車。');", ctx);   // ★割込み
  vm.runInContext("finalizeUtterance({text:'後ろ3.4秒。1.2秒縮んだ。',kind:'gap_trend',displayEl:elA},"
    + "'rebuilt','後ろ2.9秒。');", ctx);
  check('③ 割込みがあっても正しい turn を訂正する（P1-3）',
    lunaTexts().includes('後ろ2.9秒。') && !lunaTexts().includes('後ろ3.4秒。1.2秒縮んだ。'),
    JSON.stringify(lunaTexts()));
  check('③ 割込み発話は消していない', lunaTexts().includes('左に車。'), JSON.stringify(lunaTexts()));
  check('③ Overlay も最終本文になる', ovlTextOf(ctx.elA._ovlId) === '後ろ2.9秒。',
    String(ovlTextOf(ctx.elA._ovlId)));

  // ── ① 翻訳前後の rebuild 競合（P1-1）──────────────────────────
  vm.runInContext("var elT = addMsg('ai','後ろ5.0秒。');", ctx);
  const idT = ctx.elT._ovlId;
  overlayPush({ update:true, id:idT, tr:'5.0 seconds behind.', trLang:'en', gen:0 });  // 訳が先に到着
  check('① 訳が到着すると訳を表示する（前提）',
    ovlTextOf(idT) === '5.0 seconds behind.', String(ovlTextOf(idT)));
  vm.runInContext("finalizeUtterance({text:'後ろ5.0秒。',kind:'gap_trend',displayEl:elT},"
    + "'rebuilt','後ろ7.1秒。');", ctx);
  check('① rebuild 後に旧訳が残らない（P1-1）',
    ovlTextOf(idT) === '後ろ7.1秒。', String(ovlTextOf(idT)));
  overlayPush({ update:true, id:idT, tr:'5.0 seconds behind.', trLang:'en', gen:0 });  // 遅れて届く旧訳
  check('① 遅れて届いた旧世代の訳を弾く（P1-1）',
    ovlTextOf(idT) === '後ろ7.1秒。', String(ovlTextOf(idT)));

  // ── ② queued GAP の duplicate discard ─────────────────────────
  vm.runInContext("var elD = addMsg('ai','後ろ4.0秒。');"
    + "var itD = {text:'後ろ4.0秒。',kind:'gap_trend',displayEl:elD};"
    + "finalizeUtterance(itD,'dropped',null,'gap_stale');"
    + "finalizeUtterance(itD,'dropped',null,'queue_overflow');", ctx);
  check('② 二重 discard でも壊れない（idempotent）',
    !lunaTexts().includes('後ろ4.0秒。') && ovlTextOf(ctx.elD._ovlId) === null,
    JSON.stringify(lunaTexts()));

  // ── ②-b rebuild した後にキューが消えたら drop される ────────────
  //   'rebuilt' を終端扱いにすると drop が阻止され、耳で聞いていない文が記憶に残る。
  vm.runInContext("var elR = addMsg('ai','後ろ8.0秒。');"
    + "var itR = {text:'後ろ8.0秒。',kind:'gap_trend',displayEl:elR};"
    + "finalizeUtterance(itR,'rebuilt','後ろ6.5秒。');"
    + "discardQueuedUtterances([itR],'voice_off');", ctx);
  check('②-b rebuild 後にキューが消えたら記憶からも消える',
    !lunaTexts().includes('後ろ6.5秒。') && !lunaTexts().includes('後ろ8.0秒。')
      && ovlTextOf(ctx.elR._ovlId) === null,
    JSON.stringify(lunaTexts()));

  // ── ④ 全TTS失敗＝キュー全消去（P1-2）─────────────────────────
  vm.runInContext("var elQ1 = addMsg('ai','前2.0秒。'); var elQ2 = addMsg('ai','前3.0秒。');"
    + "discardQueuedUtterances(["
    + "{text:'前2.0秒。',kind:'gap_trend',displayEl:elQ1},"
    + "{text:'前3.0秒。',kind:'gap_trend',displayEl:elQ2}],'voice_off');", ctx);
  check('④ キュー全消去で表示・記憶が残らない（P1-2）',
    !lunaTexts().includes('前2.0秒。') && !lunaTexts().includes('前3.0秒。')
      && ovlTextOf(ctx.elQ1._ovlId) === null && ovlTextOf(ctx.elQ2._ovlId) === null,
    JSON.stringify(lunaTexts()));

  // ── 受入④⑥ 製品の実 speak() を通し、同一 utterance_id で三者一致を証明する ──
  //   helper を直接叩くのではなく、**製品関数**へ候補を投入して終端まで動かす。
  vm.runInContext(
    "var speakQueue=[]; var SPEAK_PRIO={P0_SAFETY:0,P1_HAZARD:1,P2_PROCEDURE:2,P3_STRATEGY:3,P4_INFO:4};"
    + "var IMMEDIATE_PIT_KINDS=new Set(); var costReplyId=function(){return null;};"
    + "var costRecord=function(){}; var speechLatencyTrace=function(st,it){ (globalThis.__traces=globalThis.__traces||[]).push({st:st,uid:it&&it.utteranceId}); };"
    + "var drainQueue=function(){};"
    + "var elS = addMsg('ai','後ろ2.2秒。',{uid:nextUtteranceId()});"
    + "speak('後ろ2.2秒。',{displayEl:elS, utteranceId:elS._uid, kind:'gap_trend', prio:4});"
    + "var itemS = speakQueue[0];", ctx);
  check('受入④ 実 speak() がキューへ載せ、uid を引き継ぐ',
    !!ctx.itemS && ctx.itemS.utteranceId === ctx.elS._uid,
    `item=${ctx.itemS && ctx.itemS.utteranceId} el=${ctx.elS && ctx.elS._uid}`);
  vm.runInContext("finalizeUtterance(itemS,'spoken');", ctx);
  const uidTurn = (boxOf().turns.find(t => t.turn_id === ctx.elS._turnId) || {}).text;
  check('受入⑥ 同一uidで Overlay＝会話Box＝発話本文',
    ovlTextOf(ctx.elS._ovlId) === '後ろ2.2秒。' && uidTurn === '後ろ2.2秒。'
      && ctx.itemS.utteranceId === ctx.elS._uid,
    `overlay=${ovlTextOf(ctx.elS._ovlId)} box=${uidTurn} uid=${ctx.itemS.utteranceId}`);

  // ── 受入④ 実 speak() の duplicate 分岐が終端へ到達する ─────────
  vm.runInContext(
    "var elDup = addMsg('ai','右に車。',{uid:nextUtteranceId()});"
    + "speak('右に車。',{displayEl:elDup, utteranceId:elDup._uid, kind:'reflex', prio:0, dedupeKey:'k1'});"
    + "var elDup2 = addMsg('ai','右に車。',{uid:nextUtteranceId()});"
    + "speak('右に車。',{displayEl:elDup2, utteranceId:elDup2._uid, kind:'reflex', prio:0, dedupeKey:'k1'});", ctx);
  check('受入④ 実 speak() の duplicate は表示・記憶から消える',
    ovlTextOf(ctx.elDup2._ovlId) === null
      && !(boxOf().turns || []).some(t => t.turn_id === ctx.elDup2._turnId),
    `overlay=${ovlTextOf(ctx.elDup2._ovlId)}`);
  check('受入④ 先に入った方は残る',
    ovlTextOf(ctx.elDup._ovlId) === '右に車。', String(ovlTextOf(ctx.elDup._ovlId)));

  // ── ★第3回受入④：PTT回答経路（Yuji が報告した本体）を実行で通す ──
  //   ここで動かすのは **local intent 出口 → addMsg(uid) → speak(displayEl,uid)** までと、
  //   finalizer の到達結果である。
  //   ★実 `drainQueue` を通した統合replay は `tests-gap-answer-queue.js` が持つ
  //     （Codex 第4回 Gate 4 の要求）。ここでコメントと実行内容を食い違わせない。
  vm.runInContext(
    "var uidQ = nextUtteranceId();"
    + "var elQ = addMsg('ai','前5.5秒。',{uid:uidQ});"
    + "speak('前5.5秒。',{displayEl:elQ, utteranceId:uidQ, kind:'local_nearest_gap', prio:2,"
    + "  gapIdentities:[{direction:'ahead',target_car_idx:7,gap_s:5.5}]});"
    + "var itQ = speakQueue.filter(function(q){return q.utteranceId===uidQ;})[0];", ctx);
  check('受入④ PTT回答が表示要素と uid を queue item へ渡す',
    !!ctx.itQ && ctx.itQ.utteranceId === ctx.elQ._uid && ctx.itQ.displayEl === ctx.elQ,
    `item.uid=${ctx.itQ && ctx.itQ.utteranceId} el.uid=${ctx.elQ && ctx.elQ._uid}`);

  // rebuild：Overlay と会話Box が最終本文になる
  vm.runInContext("finalizeUtterance(itQ,'rebuilt','前7.3秒。');", ctx);
  const qTurn = () => (boxOf().turns.find(t => t.turn_id === ctx.elQ._turnId) || {}).text;
  check('受入④ PTT回答の rebuild が Overlay を直す',
    ovlTextOf(ctx.elQ._ovlId) === '前7.3秒。', String(ovlTextOf(ctx.elQ._ovlId)));
  check('受入④ PTT回答の rebuild が会話Boxを直す', qTurn() === '前7.3秒。', String(qTurn()));

  // stale discard：表示・Overlay・会話Boxから消える
  vm.runInContext(
    "var uidS = nextUtteranceId();"
    + "var elS2 = addMsg('ai','後ろ0.4秒。',{uid:uidS});"
    + "speak('後ろ0.4秒。',{displayEl:elS2, utteranceId:uidS, kind:'local_nearest_gap', prio:2,"
    + "  gapIdentities:[{direction:'behind',target_car_idx:9,gap_s:0.4}]});"
    + "var itS2 = speakQueue.filter(function(q){return q.utteranceId===uidS;})[0];"
    + "finalizeUtterance(itS2,'dropped',null,'gap_answer_stale');", ctx);
  check('受入④ PTT回答の stale discard が表示・記憶から消える',
    ovlTextOf(ctx.elS2._ovlId) === null
      && !(boxOf().turns || []).some(t => t.turn_id === ctx.elS2._turnId),
    `overlay=${ovlTextOf(ctx.elS2._ovlId)}`);

  // ── ⑤ play_started：再生された発話は表示＝記憶＝音声本文 ────────
  vm.runInContext("var elP = addMsg('ai','後ろ1.5秒。');"
    + "finalizeUtterance({text:'後ろ1.5秒。',kind:'gap_trend',displayEl:elP},'spoken');", ctx);
  const spokenTurn = (boxOf().turns.find(t => t.turn_id === ctx.elP._turnId) || {}).text;
  check('⑤ 再生された発話は表示も記憶も残る',
    lunaTexts().includes('後ろ1.5秒。') && ovlTextOf(ctx.elP._ovlId) === '後ろ1.5秒。',
    JSON.stringify(lunaTexts()));
  check('⑤ 同一発話IDで Overlay＝会話Box＝音声本文',
    ovlTextOf(ctx.elP._ovlId) === '後ろ1.5秒。' && spokenTurn === '後ろ1.5秒。',
    `overlay=${ovlTextOf(ctx.elP._ovlId)} box=${spokenTurn}`);
}

const total = pass + failures.length;
for (const f of failures) console.error('  ❌ ' + f);
console.log(`[gap display sync] 合格 ${pass} / 不合格 ${failures.length}（実行 ${total}）`);
if (failures.length) process.exit(1);
