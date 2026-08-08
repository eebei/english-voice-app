#!/usr/bin/env node
'use strict';

const fs=require('fs');
const html=fs.readFileSync('desktop/renderer.html','utf8');
const bridge=fs.readFileSync('irsdk-bridge/bridge.py','utf8');
let passed=0;
function ok(condition,name){
  if(!condition){ console.error('FAIL:',name); process.exitCode=1; return; }
  console.log('PASS:',name); passed++;
}

ok(html.includes("localStorage.getItem('pw_fuel_capacity_bop')"),
  'BoP tank capacity uses persistent shared storage');
ok(html.includes('applySessionFuelAuthority(data.data)'),
  'every car receives automatic SessionInfo fuel authority');
ok(bridge.includes("line.startswith('DriverCarFuelMaxLtr:')")
  && bridge.includes("line.startswith('DriverCarMaxFuelPct:')"),
  'bridge parses iRacing physical capacity and allowed fuel ratio');
ok(bridge.includes("result['effective_fuel_capacity_l']")
  && bridge.includes('float(_physical_l) * _ratio'),
  'bridge calculates effective session fuel capacity');
ok(html.includes("source:'iracing_session_info'"),
  'automatic capacity is marked as iRacing authority');
ok(html.includes("c.series_id??'series-unknown'")
  && html.includes("c.race_week??'week-unknown'"),
  'capacity memory is scoped by series season and week');
ok(html.includes('confirmed_bop_tank_capacity_l'),
  'confirmed tank capacity is separated from current fuel');
ok(html.includes('physical_tank_capacity_l')
  && html.includes('session_fuel_limit_ratio'),
  'physical tank and effective session limit remain separated');
ok(html.includes('effective_session_fuel_capacity_lを最優先')
  && !html.includes('「53Lスタート。'),
  'race-start fuel wording uses session authority and has no fixed 53L example');
ok(html.includes('authoritative_laps_to_finish'),
  'LLM receives authoritative laps-to-finish field');
ok(html.includes('残り周回の権威データ待ち'),
  'unknown finish distance fails closed');
ok(html.includes('一般的なGT3容量'),
  'generic GT3 tank assumptions are forbidden');
ok(html.includes('計算器との矛盾は禁止'),
  'calculator has authority over LLM guesses');
ok(html.includes('桁落ち・小数点脱落を推測補正しない')
  && !html.includes('value=value/10'),
  'ambiguous STT capacity fails closed instead of guessing a decimal');
ok(html.includes('会話/STT値で権威データを上書きしない'),
  'driver speech cannot overwrite SessionInfo fuel authority');
ok(html.includes('function validFinishPosition(value)')
  && html.includes('data=sanitizeSessionEvidence(data);'),
  'invalid finish positions such as P-1 fail closed at shared ingress');
ok(html.includes('finish_pos:validFinishPosition(evidenceDebrief.data.finish_pos)'),
  'invalid finish position cannot persist in confirmed evidence');
ok(html.includes('finishPos:validFinishPosition(data.finish_pos)'),
  'invalid finish position cannot persist in race history');
ok(html.includes('validFinishPosition(r.evidence?.finish_pos)'),
  'legacy invalid finish position cannot enter LLM evidence');
ok(html.includes("if(autoDebriefStarted || (evidenceDebrief && evidenceDebrief.active)) return;"),
  'late summary cannot launch a second debrief');
ok(html.includes('女性の自然な標準語を徹底する'),
  'Luna female standard-language contract is reinforced');
ok(html.includes('見えていない事故やスピンを「把握していた」と言わない'),
  'unobserved incident claims are forbidden');
ok(html.includes('まず状態確認と安全な継続可否を尋ねる'),
  'vehicle trouble prioritizes safety over pace recovery');
ok(html.includes('全キャラクター共通安全契約')
  && html.includes('Shared safety contract for every engineer'),
  'safety and observability contract applies to all engineers');

if(!process.exitCode) console.log(`Fuel authority tests: ${passed}/${passed} passed`);
