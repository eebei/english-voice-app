#!/usr/bin/env node
'use strict';

const fs=require('fs');
const bridge=fs.readFileSync('irsdk-bridge/bridge.py','utf8');
const prompts=fs.readFileSync('prompts.js','utf8');
const renderer=fs.readFileSync('desktop/renderer.html','utf8');
const router=fs.readFileSync('desktop/local-intent-router.js','utf8');
const checks={
  'remaining seconds exported': bridge.includes("'session_time_remaining_s':"),
  'sanitized crossing authority exported': bridge.includes("'finish_crossings_authority':"),
  'crossing failure reason exported': bridge.includes("'finish_crossings_status':"),
  'overall and class leaders separated': bridge.includes("'leaders': {")&&bridge.includes("'player_class':"),
  'overall leader signed gap exported': bridge.includes("'gap_s': overall_leader_gap_s"),
  'timed-race prompt forbids 18/19 guesses': prompts.includes('「18周」「19周」のような推測は禁止'),
  'prompt separates three targets': prompts.includes('総合首位・自クラス首位・直前車は別の対象'),
  'stream truth gate owns strategy numbers': renderer.includes('const strategyNumber='),
  // 2026-09-06: 残り周回の回答は renderer.html と local-intent-router.js へ
  // **同じ正規表現ごと複製**されており、同じレースで三通りの答えが出た
  // （実走 18:30「残り5周。」／18:36「まだ確定できない」／18:42 時間だけ）。
  // renderer 側の複製を削除し、router を唯一の権威にした。契約は移動しただけで
  // 弱まっていないので、**両側**を検査する。
  'remaining-lap fallback delegates to the single router authority':
    renderer.includes('PitwallLocalIntentRouter')
    && /_laps\.intent==='laps_remaining'/.test(renderer),
  'router owns crossing authority for remaining laps':
    router.includes('finish_crossings_authority'),
  'fuel fallback requires deterministic solution': renderer.includes('fs.required_fuel_l'),
  'overall gap never falls back to nearest car': renderer.includes('直前車のGAPでは代用しない'),
};
const failed=Object.entries(checks).filter(([,ok])=>!ok);
if(failed.length) throw new Error(failed.map(([name])=>name).join(', '));
console.log(`✅ Timed race truth gate: ${Object.keys(checks).length} checks`);
