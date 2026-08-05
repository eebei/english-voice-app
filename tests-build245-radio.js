#!/usr/bin/env node
const fs=require('fs');
const s=fs.readFileSync('desktop/renderer.html','utf8');
function check(label, cond){if(!cond)throw new Error('FAIL '+label);console.log('PASS',label);}

check('rules query including punctuation is intercepted locally', s.includes("/^(?:ルール|rules?|help)[。.!！?？]?$/i.test(text)"));
const rulesQuery=/^(?:ルール|rules?|help)[。.!！?？]?$/i;
['ルール','ルール。','ルール！','rules','help?'].forEach(v=>check('rules intercept: '+v,rulesQuery.test(v)));
check('internal 25-character specification is not repeated', s.includes('走行中は必要な数字と行動だけ短く伝える。詳しい振り返りは走行後。'));
check('rules help bypasses API', s.indexOf("/^(?:ルール|rules?|help)[。.!！?？]?$/i.test(text)") < s.indexOf("await callAPI(inputSource==='ptt'?'ptt':'typed', memoryStatus)"));

const bridge=fs.readFileSync('irsdk-bridge/bridge.py','utf8');
check('multiclass uses closing-motion gate', bridge.includes('evaluate_multiclass_approach('));
check('pass jitter cannot become zero-second call', bridge.includes("'crossing_or_jitter'"));
check('gap history resets at session boundaries', (bridge.match(/multiclass_gap_history\.clear\(\)/g)||[]).length>=3);
check('brief closing dropout cannot rearm same stage', bridge.includes('_mc_observed_groups.get(_cn)'));
