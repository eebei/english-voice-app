'use strict';
// WO017：Rendererの会話・記憶関数は、実際のrace／本人scope helperに依存する（製品側に
// 「helperが無ければ全履歴を使う」等のharness向けfallbackは置かない）。Renderer関数を抽出して
// 動かす各suiteは、ここで同じ実helperを入れる。guardをstubで常trueにするためのものではない。
const Scope = require('./desktop/race-memory-scope');

const FNS = ['memoryTurnTag', 'currentRaceConversation', 'localMemoryOwnerRef', 'loadConversationBoxes'];
const DECLS = [/const memoryRaceScope=[\s\S]*?:null;/, /const CONVO_BOX_SLOTS=\d+;/];

function grab(src, name) {
  for (const kw of ['async function ', 'function ']) {
    const i = src.indexOf('\n' + kw + name + '(');
    if (i < 0) continue;
    const rest = src.slice(i + 1);
    const end = rest.search(/\n\}\n/);
    if (end >= 0) return rest.slice(0, end + 2);
  }
  return null;
}

const MODULE_CODE = require('fs').readFileSync(require('path').join(__dirname, 'desktop/race-memory-scope.js'), 'utf8');

// src: Rendererのscript本文。返すのは、実moduleの原文（VM内のglobalThisへ載る）と、
// Rendererの実際の宣言・関数の原文だけ。
function source(src, { skip = [], decls: withDecls = true } = {}) {
  const decls = withDecls ? DECLS.map(re => (src.match(re) || [''])[0]).filter(Boolean) : [];
  const fns = FNS.filter(n => !skip.includes(n)).map(n => {
    const code = grab(src, n);
    if (!code) throw new Error('WO017 memory scope helper missing in renderer: ' + n);
    return code;
  });
  return MODULE_CODE + '\n' + decls.join('\n') + '\n' + fns.join('\n') + '\n';
}

// 製品では会話履歴へ入るturnは必ずpushMsg()を通り、その時点の本人・raceのtag（実memoryTurnTag）
// を持つ。履歴配列を直接組み立てる既存harnessでも同じ不変条件にするため、ctx.messagesへ代入・push
// された要素へ、その時点で実memoryTurnTag()のtagを付ける（tagの中身・可視判定はRendererの実関数）。
function install(ctx) {
  ctx.PitwallRaceMemoryScope = Scope;
  if (ctx.window && ctx.window !== ctx) ctx.window.PitwallRaceMemoryScope = Scope;
  if (ctx.globalThis && ctx.globalThis !== ctx) ctx.globalThis.PitwallRaceMemoryScope = Scope;
  const tag = m => {
    if (m && typeof m === 'object' && !m._race && typeof ctx.memoryTurnTag === 'function') {
      Object.defineProperty(m, '_race', { value: ctx.memoryTurnTag(), enumerable: false, writable: false, configurable: true });
    }
  };
  const tagged = list => {
    const arr = Array.isArray(list) ? list : [];
    const push = Array.prototype.push;
    Object.defineProperty(arr, 'push', { value(...items) { items.forEach(tag); return push.apply(this, items); },
      enumerable: false, configurable: true, writable: true });
    arr.forEach(tag);
    return arr;
  };
  let current = tagged(ctx.messages);
  Object.defineProperty(ctx, 'messages', { get: () => current, set: v => { current = tagged(v); },
    enumerable: true, configurable: true });
  return ctx;
}

module.exports = { FNS, DECLS, source, install, Scope };
