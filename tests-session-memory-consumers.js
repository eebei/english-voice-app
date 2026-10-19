#!/usr/bin/env node
'use strict';
// Execute both current memory consumers; the old fourth call was a retired
// inline strategy owner. Calls and a class-key substring cannot prove retrieval.
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('desktop/renderer.html','utf8');
const layerSource=fs.readFileSync('desktop/memory-action-layer.js','utf8');
function extract(name){const m=new RegExp('^function '+name+'\\(','m').exec(source);assert(m,name);const tail=source.slice(m.index);const end=tail.slice(1).search(/\n(?:async function |function |const |let |\/\/ ──)/);return tail.slice(0,end>0?end+1:tail.length);}
const names=['findCarTrackMemory','buildCarTrackMemory','normalizedEvidenceKey','medianFinite','matchingHistoricalAverageLap'];
function runtime(cut=false){const c={console,lastTrack:'Okayama',lastCarModel:'Audi R8 LMS GT3',lastCarClass:'GT3',sel:'LunaJP',userName:'Driver',loadEvidenceRecords:()=>[],localStorage:{getItem:k=>k==='pw_ctmem'?JSON.stringify(c.mem):'[]'},mem:{},module:{exports:{}}};c.window=c;c.globalThis=c;vm.createContext(c);const layer=cut?layerSource.replace("return id.track === wantedTrack && wantedClass && id.car === wantedClass;",'return false;'):layerSource;if(cut)assert.notEqual(layer,layerSource,'class fallback cut matched');vm.runInContext(layer,c);c.PitwallMemoryActionLayer=c.module.exports;vm.runInContext(names.map(extract).join('\n'),c);return c;}
let count=0;function check(ok){assert(ok);count++;}
const exact={car:'Audi R8 LMS GT3',track:'Okayama',sessions:2,avgLap:91,avgFuel:3.1};
const legacy={car:'GT3',track:'Okayama',sessions:1,avgLap:99,avgFuel:4.2};
const c=runtime();c.mem={'GT3|Okayama':legacy,'Audi R8 LMS GT3|Okayama':exact};
check(c.buildCarTrackMemory().includes('3.1L'));check(c.matchingHistoricalAverageLap()===91);
delete c.mem['Audi R8 LMS GT3|Okayama'];
check(c.buildCarTrackMemory().includes('4.2L'));check(c.matchingHistoricalAverageLap()===99);
c.lastTrack='Unknown track';check(c.buildCarTrackMemory()==='');check(c.matchingHistoricalAverageLap()===null);
c.lastTrack='Okayama';c.lastCarModel='';c.lastCarClass='';check(c.buildCarTrackMemory()==='');check(c.matchingHistoricalAverageLap()===null);
const cut=runtime(true);cut.mem={'GT3|Okayama':legacy,'Audi R8 LMS GT3|Okayama':exact};check(cut.matchingHistoricalAverageLap()===91);check(cut.buildCarTrackMemory().includes('3.1L'));
delete cut.mem['Audi R8 LMS GT3|Okayama'];check(cut.buildCarTrackMemory()==='');check(cut.matchingHistoricalAverageLap()===null);
console.log('Session memory consumers '+count+' PASS (real modules and callers; class-loss cut RED, exact-model control GREEN)');
