const fs=require('fs');
const r=fs.readFileSync('desktop/renderer.html','utf8');
const p=fs.readFileSync('prompts.js','utf8');
let n=0;
function ok(cond,msg){ if(!cond) throw new Error(msg); n++; }
ok(r.includes('buildWeekendAuthorityNote(_isJP_pre)'), 'main chat missing weekend authority');
ok(r.includes('+buildWeekendAuthorityNote(sel==='), 'briefing missing weekend authority');
ok(r.includes('ライブ順位・iRating・エントリー順から予選順位やグリッドを作るな'), 'grid fail-close missing');
ok(r.includes('function isDebriefAnalysisQuestion'), 'debrief analysis interrupt missing');
ok(r.includes("if(isDebriefAnalysisQuestion(text))"), 'guided review question route missing');
ok(!r.includes('/[?？]$|どう'), 'bare question mark must not consume guided-review routing');
ok(r.includes(".replace(/その通りだ[。！]?/g, 'その通りね。')"), 'Luna deterministic tone guard missing');
ok(r.includes('function fmtDuration'), 'duration formatter missing');
ok(r.includes('fmtDuration(d.repair_mand,true)'), 'radio repair duration not formatted');
ok(p.includes("Math.floor(totalRepairSeconds / 60) + '分'"), 'LLM repair duration not formatted');
ok(p.includes('「その通りだ」「P12スタートだ」「必要だ」「あ、待てよ」'), 'Luna prompt examples missing');
console.log(`✅ weekend authority ${n}/11`);
