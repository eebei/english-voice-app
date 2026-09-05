// Overlay表示・会話ログ・会話Box と、実際に再生されたTTS本文を一致させる契約。
//
// なぜ要るか（2026-09-04 実走・Build 295）:
//   自発GAPコール13件のうち **11件**で表示と音声が食い違っていた。
//     fate=rebuild 10件 … 音声だけ最新値へ作り替え、表示は旧文のまま
//     fate=discard  1件 … **一度も再生していないのに表示と記録は残る**
//     fate=play     2件 … 一致
//   `addMsg()` は表示と同時に convoLog・会話Box へ原文を記録するが、
//   本文が確定するのは TTS 直前の `drainQueue()` である。
//
//   表示のズレより重いのは会話Boxの汚染である。ドライバーが耳で聞いた文ではなく
//   画面に出た文が撤回対象になり、**訂正検出が別の値を消す**。
//
// 検査は2層:
//   1) 配線 … `drainQueue` の rebuild/discard から実際に呼んでいるか（定義しただけを通さない）
//   2) 実経路 … renderer の関数を取り出して実行し、箱の中身が実際に変わるか

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

// ── 1. 配線検査 ───────────────────────────────────────────────
// 「関数を定義したがどこからも呼んでいない」を3回やっているので、呼出しを直接見る。
const drainSrc = (() => {
  const m = renderer.match(/function drainQueue\([^)]*\)\{[\s\S]*?\n\}/);
  return m ? m[0] : '';
})();

check('drainQueue を取り出せる', !!drainSrc);
check('discard で表示要素を取り除いている',
  /fate === 'discard'[\s\S]*?removeChild\(_it\.displayEl\)/.test(drainSrc), '呼出しが無い');
check('discard で会話Boxの発話も落としている',
  /fate === 'discard'[\s\S]*?dropLastLunaTurn\(/.test(drainSrc), '呼出しが無い');
check('rebuild で表示要素を最終本文へ更新している',
  /fate === 'rebuild'[\s\S]*?_it\.displayEl\.textContent = _rebuilt/.test(drainSrc), '呼出しが無い');
check('rebuild で会話Boxの発話も最終本文へ揃えている',
  /fate === 'rebuild'[\s\S]*?amendLastLunaTurn\(/.test(drainSrc), '呼出しが無い');
check('最終本文が診断へ残る（表示＝音声を後から照合できる）',
  /GAP_DISPLAY_SYNC/.test(drainSrc), 'GAP_DISPLAY_SYNC が無い');
check('speak() が表示要素を持ち歩く', /displayEl:o\.displayEl\|\|null/.test(renderer));
// ★走行中に実際に見ているのはチャット欄ではなく Race Overlay（別ウィンドウ）。
//   最初の実装はチャット欄しか直しておらず、テストがそれを暴いた。
check('Overlay の行IDを要素へ結びつけている', /div\._ovlId = convoLog\(type, text\)/.test(renderer));
check('rebuild で Overlay 本文も差し替える',
  /fate === 'rebuild'[\s\S]*?overlayPush\(\{ update:true, id:_it\.displayEl\._ovlId, text:_rebuilt \}\)/.test(drainSrc));
check('discard で Overlay の行を消す',
  /fate === 'discard'[\s\S]*?overlayPush\(\{ remove:true, id:_it\.displayEl\._ovlId \}\)/.test(drainSrc));
const overlayHtml = fs.readFileSync(path.join(__dirname, 'desktop', 'overlay.html'), 'utf8');
check('Overlay 側が本文差し替えを受け付ける',
  /if\(d && typeof line\.text === 'string' && line\.text\) d\.orig = line\.text/.test(overlayHtml));
check('Overlay 側が行削除を受け付ける', /if\(line\.remove\)/.test(overlayHtml));
check('injectRadio が表示要素を speak へ渡す',
  /const _radioEl = addMsg\('ai',text\)/.test(renderer) && /displayEl:_radioEl/.test(renderer));

// ── 2. 実経路（renderer の関数を実際に動かす）──────────────────
const grab = (name) => {
  const m = renderer.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}'));
  return m ? m[0] : null;
};
const names = ['addMsg', 'recordLunaTurn', 'amendLastLunaTurn', 'dropLastLunaTurn',
               'ensureConversationBox', 'saveConversationBox', 'conversationSessionKey', 'convoLog'];
const parts = names.map(grab);
check('実経路の関数群を renderer から取り出せる', parts.every(Boolean),
  names.filter((_, i) => !parts[i]).join(', '));

if (parts.every(Boolean)) {
  const store = {};
  const made = [];
  const ctxOverlay = [];
  const ctx = {
    window: { PitwallConversationMemoryBox: box,
              pitwall: { overlayPush: (l) => { ctxOverlay.push(l); } } },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    document: {
      getElementById: () => ({ appendChild(){}, scrollTop:0, scrollHeight:0 }),
      createElement: () => { const el={textContent:'',className:'',parentNode:null}; made.push(el); return el; },
    },
    lastTelemetry: null, lastTrack: 'le mans', lastCarModel: 'Mercedes-AMG GT3 2020',
    lastCarClass: 'GT3', lastSessionType: 'Race',
    currentMemoryUserId: () => 'u1', lastSessionNum: 1, irBridge: null, sel: 'LunaJP',
    diagnosticLog: () => {}, bridgeSend: () => {},
    // mirrorToOverlay 本体は Overlay 窓・翻訳・言語判定に依存するのでスタブ。
    // ここで確かめたいのは「返した行IDが要素へ結び付くか」である。
    mirrorToOverlay: (type, text) => { ctxOverlay.push({push:true,type,text}); return 'L'+ctxOverlay.length; },
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // renderer の module 変数（関数の外にあるので grab では取れない）を先に置く。
  vm.runInContext("var _convoBox = null; var CONVO_BOX_KEY = 'pw_conversation_box_v1';\n"
    + parts.join('\n'), ctx);

  const boxOf = () => JSON.parse(store[Object.keys(store).find(k => /conversation/i.test(k))] || 'null');
  const lunaTexts = () => {
    const b = boxOf();
    return b && Array.isArray(b.turns) ? b.turns.filter(t => t.who === 'luna').map(t => t.text) : [];
  };

  // rebuild：表示と箱の両方が最終本文になる
  vm.runInContext("var el1 = addMsg('ai','後ろ3.4秒。1.2秒縮んだ。');", ctx);
  check('原文が箱へ入る', lunaTexts().includes('後ろ3.4秒。1.2秒縮んだ。'), JSON.stringify(lunaTexts()));
  vm.runInContext("var r1 = amendLastLunaTurn('後ろ3.4秒。1.2秒縮んだ。','後ろ2.9秒。'); el1.textContent='後ろ2.9秒。';", ctx);
  check('rebuild：箱の発話が最終本文へ変わる',
    lunaTexts().includes('後ろ2.9秒。') && !lunaTexts().includes('後ろ3.4秒。1.2秒縮んだ。'),
    JSON.stringify(lunaTexts()));
  check('rebuild：表示も最終本文になる', ctx.el1.textContent === '後ろ2.9秒。', ctx.el1.textContent);
  check('Overlay の行IDが要素へ結び付く（後から更新・削除できる）',
    typeof ctx.el1._ovlId === 'string' && ctx.el1._ovlId.length > 0, String(ctx.el1._ovlId));

  // discard：一度も喋っていないので箱からも消える
  vm.runInContext("var el2 = addMsg('ai','後ろ5.0秒。');", ctx);
  check('discard 前は箱に居る', lunaTexts().includes('後ろ5.0秒。'));
  vm.runInContext("var d1 = dropLastLunaTurn('後ろ5.0秒。');", ctx);
  check('discard：喋らなかった発話が箱から消える',
    ctx.d1 === true && !lunaTexts().includes('後ろ5.0秒。'), JSON.stringify(lunaTexts()));

  // ★安全装置：間に別の発話が入っていたら触らない（取り違えて消す方が危険）
  vm.runInContext("addMsg('ai','ピット入口注意。'); var d2 = dropLastLunaTurn('後ろ9.9秒。');", ctx);
  check('別の発話が挟まっていたら取り消さない',
    ctx.d2 === false && lunaTexts().includes('ピット入口注意。'), JSON.stringify(lunaTexts()));
  vm.runInContext("var r2 = amendLastLunaTurn('後ろ9.9秒。','後ろ1.0秒。');", ctx);
  check('別の発話が挟まっていたら書き換えない',
    ctx.r2 === false && !lunaTexts().includes('後ろ1.0秒。'), JSON.stringify(lunaTexts()));
}

const total = pass + failures.length;
for (const f of failures) console.error('  ❌ ' + f);
console.log(`[gap display sync] 合格 ${pass} / 不合格 ${failures.length}（実行 ${total}）`);
if (failures.length) process.exit(1);
