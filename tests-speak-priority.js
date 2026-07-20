// 発話ディレクターの競合テスト（Codex P4）：実走なしで割り込み規則を証明する
const SPEAK_PRIO = {P0_SAFETY:0,P1_HAZARD:1,P2_PROCEDURE:2,P3_STRATEGY:3,P4_INFO:4,P5_CHAT:5};
const MAX_RADIO_QUEUE = 2;
let speakQueue=[], isSpeaking=false, currentSpeakPrio=9, interrupted=[];
function stopCurrentAudio(){ interrupted.push(currentSpeakPrio); isSpeaking=false; currentSpeakPrio=9; }
function speak(text, opts){
  let o=(opts===true)?{prio:SPEAK_PRIO.P2_PROCEDURE,kind:'reply'}
      :(opts&&typeof opts==='object')?opts:{prio:SPEAK_PRIO.P4_INFO,kind:'radio'};
  const prio=(typeof o.prio==='number')?o.prio:SPEAK_PRIO.P4_INFO;
  const item={text,prio,kind:o.kind||'radio',ts:Date.now(),dedupeKey:o.dedupeKey||null};
  if(item.dedupeKey && speakQueue.some(q=>q.dedupeKey===item.dedupeKey)) return 'deduped';
  if(prio<=SPEAK_PRIO.P1_HAZARD && isSpeaking && currentSpeakPrio>prio) stopCurrentAudio();
  speakQueue.push(item);
  if(speakQueue.length>MAX_RADIO_QUEUE+2){
    let worst=-1,wi=-1; speakQueue.forEach((q,i)=>{if(q.prio>worst){worst=q.prio;wi=i;}});
    if(wi>=0&&speakQueue[wi].prio>SPEAK_PRIO.P1_HAZARD) speakQueue.splice(wi,1);
  }
  speakQueue.sort((a,b)=>a.prio-b.prio||a.ts-b.ts);
  return 'queued';
}
function startPlaying(){ const it=speakQueue.shift(); if(!it) return null; isSpeaking=true; currentSpeakPrio=it.prio; return it; }
let pass=0,fail=0;
function check(name,cond){ (cond?pass++:fail++); console.log((cond?'  ✅ ':'  ❌ ')+name); }

console.log('══ 競合テスト：発話ディレクターの割り込み規則 ══\n');

// 1. P0再生中に会話の返事が来ても割り込まない（今日の最重要）
speakQueue=[];interrupted=[];isSpeaking=false;currentSpeakPrio=9;
speak('停止車両！',{prio:0,kind:'stopped_ahead'}); startPlaying();
speak('了解、燃料は20Lです', true);   // 会話＝旧仕様なら全消去+停止していた
check('P0再生中：会話の返事はP0を止めない', interrupted.length===0 && currentSpeakPrio===0);
check('P0再生中：会話はキューで待つ', speakQueue.length===1 && speakQueue[0].kind==='reply');

// 2. P0は再生中のP3を止めて割り込める（上位→下位は許可）
speakQueue=[];interrupted=[];isSpeaking=false;currentSpeakPrio=9;
speak('燃料の話',{prio:3,kind:'fuel'}); startPlaying();
speak('停止車両！',{prio:0,kind:'stopped_ahead'});
check('P3再生中：P0が割り込んで停止させる', interrupted.length===1 && interrupted[0]===3);

// 3. 溢れた時に捨てられるのは"低優先度"であって"古い安全"ではない
speakQueue=[];isSpeaking=false;
speak('速い車が後ろ',{prio:1,kind:'multiclass'});
speak('情報A',{prio:4}); speak('情報B',{prio:4}); speak('雑談',{prio:5}); speak('情報C',{prio:4});
check('溢れても安全(P1)は残る', speakQueue.some(q=>q.prio===1));
check('捨てられたのは最低優先度', !speakQueue.some(q=>q.prio===5));

// 4. 優先度順に再生される（到着順ではない）
speakQueue=[];isSpeaking=false;
speak('雑談',{prio:5}); speak('停止車両',{prio:0}); speak('情報',{prio:4});
check('再生順は優先度順（P0が先頭）', startPlaying().prio===0);

// 5. 同一ハザードの重複は捨てる（必ず届ける≠毎サンプル喋る）
speakQueue=[];isSpeaking=false;
speak('速い車',{prio:1,kind:'multiclass',dedupeKey:'multiclass38'});
const r=speak('速い車',{prio:1,kind:'multiclass',dedupeKey:'multiclass38'});
check('同一ハザードの重複は破棄される', r==='deduped' && speakQueue.length===1);

console.log('\n[優先度] 合格 '+pass+' / 不合格 '+fail);

// ── 後方集団の「形」判定（2026-07-20 Yuji要望・実走前の検証）──
const MC_PACK_SEC = 3.0;
function describeTraffic(gaps){
  const n = gaps.length;
  if(n <= 1) return ['single',[1]];
  let clusters=[], cur=1;
  for(let i=1;i<n;i++){ if(gaps[i]-gaps[i-1] <= MC_PACK_SEC) cur++; else { clusters.push(cur); cur=1; } }
  clusters.push(cur);
  if(n>=4 && clusters.length===1){
    const steps=[]; for(let i=1;i<n;i++) steps.push(gaps[i]-gaps[i-1]);
    const avg=steps.reduce((a,b)=>a+b,0)/steps.length;
    if(avg>0 && Math.max(...steps.map(x=>Math.abs(x-avg))) <= Math.max(1.0, avg*0.5)) return ['train',clusters];
  }
  return [clusters.length===1?'pack':'split', clusters];
}
console.log('\n══ 後方集団の形 ══');
let shapePass=0, shapeFail=0;
[[[4.5],'single'],[[2,3.5],'pack'],[[2,3,9.5],'split'],[[1.5,3.5,5.5,7.5,9.5,11.5,13.5],'train'],[[1,2,3,10,11],'split']]
 .forEach(([g,want])=>{ const [sh]=describeTraffic(g); const ok=(sh===want); ok?shapePass++:shapeFail++;
   console.log((ok?'  ✅ ':'  ❌ ')+JSON.stringify(g)+' → '+sh); });
console.log('\n[形] 合格 '+shapePass+' / 不合格 '+shapeFail);

// ── ★Codexレビュー P0-2 の検証：割り込み後にキューが止まらないこと ──
//   本番同等の状態変数(draining/isSpeaking/watchdog)を再現する。
//   旧実装は stopCurrentAudio() が draining を戻さず、pause()はonendedを出さないため
//   watchdog(最大40秒)まで安全コールが待たされていた。
console.log('\n══ 割り込み後のキュー継続（本番相当の状態） ══');
let dPass=0,dFail=0;
function dcheck(name,cond){ (cond?dPass++:dFail++); console.log((cond?'  ✅ ':'  ❌ ')+name); }
{
  let draining=false, isSpeaking=false, watchdog=null, playing=null, q=[];
  function stopCurrentAudioFixed(){
    if(watchdog){ clearTimeout(watchdog); watchdog=null; }
    playing=null; isSpeaking=false; draining=false;   // ★draining解除が肝
  }
  function drain(){
    if(draining||isSpeaking) return false;
    if(!q.length) return false;
    q.sort((a,b)=>a.prio-b.prio);
    playing=q.shift(); draining=true; isSpeaking=true;
    watchdog=setTimeout(()=>{},40000);
    return true;
  }
  q.push({text:'情報',prio:4}); drain();
  dcheck('P4が再生中', playing && playing.prio===4);
  // P0が到着 → 割り込み（onendedは来ない＝pause相当）
  q.push({text:'停止車両',prio:0}); stopCurrentAudioFixed();
  dcheck('割り込みでdrainingが解除される', draining===false);
  const started = drain();
  dcheck('P0が即座に再生される（40秒待たない）', started && playing.prio===0);
  if(watchdog) clearTimeout(watchdog);
}
console.log('\n[割り込み] 合格 '+dPass+' / 不合格 '+dFail);

console.log('\n══ 合計 合格 '+(pass+shapePass+dPass)+' / 不合格 '+(fail+shapeFail+dFail)+' ══');
process.exit((fail+shapeFail+dFail)?1:0);
