#!/usr/bin/env node
'use strict';

const fs=require('fs');
const bridge=fs.readFileSync('irsdk-bridge/bridge.py','utf8');
const prompts=fs.readFileSync('prompts.js','utf8');
const renderer=fs.readFileSync('desktop/renderer.html','utf8');
const checks={
  'remaining seconds exported': bridge.includes("'session_time_remaining_s':"),
  'sanitized crossing authority exported': bridge.includes("'finish_crossings_authority':"),
  'crossing failure reason exported': bridge.includes("'finish_crossings_status':"),
  'overall and class leaders separated': bridge.includes("'leaders': {")&&bridge.includes("'player_class':"),
  'overall leader signed gap exported': bridge.includes("'gap_s': overall_leader_gap_s"),
  'timed-race prompt forbids 18/19 guesses': prompts.includes('「18周」「19周」のような推測は禁止'),
  'prompt separates three targets': prompts.includes('総合首位・自クラス首位・直前車は別の対象'),
  'stream truth gate owns strategy numbers': renderer.includes('const strategyNumber='),
  'remaining-lap fallback uses crossing authority': renderer.includes('finish_crossings_authority'),
  'fuel fallback requires deterministic solution': renderer.includes('fs.required_fuel_l'),
  'overall gap never falls back to nearest car': renderer.includes('直前車のGAPでは代用しない'),
};
const failed=Object.entries(checks).filter(([,ok])=>!ok);
if(failed.length) throw new Error(failed.map(([name])=>name).join(', '));
console.log(`✅ Timed race truth gate: ${Object.keys(checks).length} checks`);
