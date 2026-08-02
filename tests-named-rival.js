#!/usr/bin/env node
'use strict';

const fs=require('fs');
const vm=require('vm');
const src=fs.readFileSync('desktop/renderer.html','utf8');
const block=src.match(/const RIVAL_FIRST_NAME_ALIASES=[\s\S]*?function buildNamedRivalNote\(isJP\)\{[\s\S]*?\n\}/);
if(!block) throw new Error('named rival block not found');
const ctx={lastTelemetry:{competitors:[
  {car_idx:21,name:'Kevin Brown',car_number:'12',class_pos:5,gap_s:2.5},
  {car_idx:7,name:'John Smith',car_number:'7',class_pos:3,gap_s:-10.9},
]},namedRival:null,Number,Math,String,Array,RegExp};
vm.runInNewContext(block[0].replace('const RIVAL_FIRST_NAME_ALIASES=','RIVAL_FIRST_NAME_ALIASES='),ctx);
ctx.updateNamedRivalFromUser('やっぱりケビンがライバル');
if(!ctx.namedRival || ctx.namedRival.carIdx!==21) throw new Error('Kevin was not bound');
const note=ctx.buildNamedRivalNote(true);
if(!note.includes('gap_s=2.5') || !note.includes('relative=behind')) throw new Error(note);
ctx.updateNamedRivalFromUser('P1まで何秒？');
if(ctx.namedRival.carIdx!==21) throw new Error('unresolved question replaced rival');
ctx.lastTelemetry.competitors=[];
const missing=ctx.buildNamedRivalNote(true);
if(!missing.includes('別の前後車GAPで代用するな')) throw new Error(missing);
console.log('✅ Named rival binding and no-substitution: 4 checks');
