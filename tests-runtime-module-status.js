#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════
// 2026-08-26 — 起動時の runtime module 診断（Gate 6 の受け皿）。
//
// `PITWALL_RELEASE_GATE.md` Gate 6:
//   「起動ログに必要moduleのloaded / missing状態が記録され、全てloadedである」
//
// 実測して分かった欠陥：`reportRuntimeModuleStatus()` は5本のハードコードで、
// renderer が8本を読み込むようになっても session-memory / decision-memory /
// gap-freshness を見ていなかった。**package から抜けても「全部loaded」と
// 報告する**状態＝Gate 6 が偽の安心を出す。Build 281（package漏れ）、
// Build 282 P1-2（CI検査の2本ハードコード）と同型。
//
// 写経しない：本番の関数を renderer.html から抽出して実行し、
// 1本ずつ欠けさせて missing が出ることを実挙動で確認する。
// ══════════════════════════════════════════════════════════════════════
const fs=require('fs'),vm=require('vm');
const html=fs.readFileSync('desktop/renderer.html','utf8');
const src=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).reduce((a,b)=>a.length>b.length?a:b);
const grab=n=>{const i=src.indexOf('function '+n+'(');const r=src.slice(i);const e=r.slice(1).search(/\n(?:async function |function |const |let |\/\/ )/);return r.slice(0,e>0?e+1:r.length);};
const code=[grab('runtimeModuleGlobalName'),grab('reportRuntimeModuleStatus')].join('\n');
const wanted=[...html.matchAll(/<script src="([a-z0-9-]+\.js)"><\/script>/g)].map(m=>m[1]);
let pass=0,fail=0;const ck=(l,o,d)=>{(o?console.log:console.error)('  '+(o?'✅ ':'❌ ')+l+(o?'':' -> '+(d||'')));o?pass++:fail++;};

const run=(present)=>{
  let logged=null;
  const box={console,JSON,Object,String,RegExp,
    document:{querySelectorAll:()=>wanted.map(s=>({getAttribute:()=>s}))},
    diagnosticLog:(t,b)=>{if(t==='RUNTIME_MODULE_STATUS')logged=JSON.parse(b);}};
  box.window=box; vm.createContext(box); vm.runInContext(code,box);
  present.forEach(g=>{box[g]={};});
  box.reportRuntimeModuleStatus();
  return logged;
};
const nameOf=s=>'Pitwall'+s.replace(/\.js$/,'').split('-').map(p=>p[0].toUpperCase()+p.slice(1)).join('');
const all=wanted.map(nameOf);

console.log('══ 起動時 module 診断が派生になっているか ══');
console.log('  renderer が読み込む: '+wanted.length+' 本');
const okAll=run(all);
ck('全部あれば loaded',okAll&&okAll.status==='loaded'&&okAll.missing.length===0,JSON.stringify(okAll));
ck('★8本すべてを検査対象にする（5本ハードコードでない）',
  okAll&&Object.keys(okAll.modules).length===wanted.length,
  okAll?Object.keys(okAll.modules).length+'本':'-');
wanted.forEach(f=>{
  const r=run(all.filter(g=>g!==nameOf(f)));
  ck('  '+f+' が欠けたら missing になる',
    r&&r.status==='missing'&&r.missing.includes(f),JSON.stringify(r&&r.missing));
});
console.log(`\nRuntime module status: ${pass}/${pass+fail}`);
if(fail)process.exit(1);
