#!/usr/bin/env node
'use strict';

const fs=require('fs');
const vm=require('vm');
const renderer=fs.readFileSync('desktop/renderer.html','utf8');
const bridge=fs.readFileSync('irsdk-bridge/bridge.py','utf8');

let pass=0,fail=0;
function check(label,ok){
  (ok?console.log:console.error)((ok?'✅ ':'❌ ')+label);
  ok?pass++:fail++;
}

const languageStart=renderer.indexOf('function evidenceLanguage(){');
const questionsEnd=renderer.indexOf('function beginEvidenceDebrief(data){',languageStart);
const source=renderer.slice(languageStart,questionsEnd);
const storage=new Map();
const context={sel:'James',lastSessionType:'Race',usageBuild:'240',Date,Math,
  localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
  usageCount:()=>{},loadEvidenceRecords:()=>[],
  validFinishPosition:v=>Number.isInteger(Number(v))&&Number(v)>0?Number(v):null};
vm.createContext(context);
vm.runInContext(source,context);

const characters={
  James:'en',Luna:'en',Hajime:'en',
  Kanbe:'ja',Oishi:'ja',HajimeJP:'ja',LunaJP:'ja',
  Matthias:'de',Camila:'pt'
};
for(const [character,language] of Object.entries(characters)){
  context.sel=character;
  check(`${character}: debrief language=${language}`,context.evidenceLanguage()===language);
  const copy=context.evidenceCopy();
  check(`${character}: complete localized Q&A controls`,
    Array.isArray(copy.race)&&copy.race.length===3&&copy.save&&copy.discard&&copy.cancel&&copy.ready&&copy.saved);
  const questions=context.buildEvidenceQuestions({event_type:'Race',finish_pos:5,avg_fuel_per_lap:3.8});
  check(`${character}: localized contextual evidence structure`,questions.length>=3&&questions.length<=4);
}

const evidenceNote=renderer.slice(
  renderer.indexOf('function buildSessionEvidenceNote(){'),
  renderer.indexOf('// 今日と同じコース',renderer.indexOf('function buildSessionEvidenceNote(){')));
check('memory selection has no Luna-only capability gate',
  !evidenceNote.includes("sel==='LunaJP'")&&!evidenceNote.includes("sel === 'LunaJP'"));
check('all characters use the same evidence-memory injection',
  renderer.includes('buildProfileNote(profile) + buildCarTrackMemory() + buildFuelAuthorityNote(_isJP_pre)') &&
  renderer.includes('+ buildSessionEvidenceNote()'));
check('driver/track/car fail-close is shared',
  evidenceNote.includes("if(!userName || !track || !car) return '';"));
check('90-day expiry is shared',
  evidenceNote.includes('const maxAgeMs=90*24*60*60*1000;'));
check('speech safety gate is character-independent',
  bridge.includes('_set_speak_gate(speak_window_ok, _speech_gate_active)')
  && !bridge.includes('LunaJP'));
check('confirmed storage schema is character-independent',
  renderer.includes("buildEvidenceRecord('confirmed_by_driver')")
  && renderer.includes('driver:userName'));

console.log(`\nCharacter capability parity: ${pass}/${pass+fail}`);
if(fail) process.exit(1);
