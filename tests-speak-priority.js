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

console.log('\n合格 '+pass+' / 不合格 '+fail);
process.exit(fail?1:0);
