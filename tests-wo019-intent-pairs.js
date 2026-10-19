#!/usr/bin/env node
'use strict';
// WO-019 module pairs (real engineer-card.js): plan status never promotes a fuel REFERENCE into a
// box order when the caller is canonical; past-evaluation sentences leave the current card, while
// a separate current question in the same turn is classified exactly as if asked alone.
const ec = require('./engineer-card');
let pass = 0, fail = 0;
const ck = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('❌ ' + name + ' -> ' + JSON.stringify(detail)); } };
const card = { topic: ec.TOPIC.PLAN_STATUS };
const ref = { estimated_crossings_to_finish: 8, margin_l: -7.6, pit_required: true, add_fuel_l: 7.6, set_fuel_l: 8, avg_fuel_per_lap: 2.9, clean_laps_sampled: 5 };
const active = { phase: 'active', selected_plan: 'A', target_lap: 21, set_fuel_l: 10, decision_id: 'd1' };

const withPlan = ec.build(card, { lap: 18, session_type: 'Race', finish_crossings_authority: 8, laps_total: 25, fuel_strategy: ref, fuel_strategy_age_s: 1, active_plan: active }, 'ja');
ck('active Plan: states its lap and frozen amount', /21周目にピット予定（あと3周）/.test(withPlan) && /給油設定10L/.test(withPlan), withPlan);
ck('active Plan: no reference box order', !/でボックス|ボックス。|給油8L/.test(withPlan), withPlan);
const noPlan = ec.build(card, { lap: 18, session_type: 'Race', finish_crossings_authority: 8, laps_total: 25, fuel_strategy: ref, fuel_strategy_age_s: 1, active_plan: null }, 'ja');
ck('no Plan + short reference: not an instruction', /合意中のPlanは無い/.test(noPlan) && /実行指示ではない/.test(noPlan) && !/でボックス/.test(noPlan), noPlan);
const legacy = ec.build(card, { lap: 18, session_type: 'Race', finish_crossings_authority: 8, laps_total: 25, fuel_strategy: ref }, 'ja');
ck('legacy caller (no canonical context) keeps its old reply', /燃料不足でボックス/.test(legacy), legacy);
const en = ec.build(card, { lap: 21, fuel_strategy: ref, fuel_strategy_age_s: 1, active_plan: active }, 'en');
ck('EN active Plan on its lap', /pit on lap 21 \(this lap\)/.test(en) && !/Box for fuel/.test(en), en);

const topics = (t, recent = '') => ec.classifyAll(t, { race: true, recentText: recent }).map(c => c.topic);
for (const [t, recent] of [['さっきのピットの判断、どうだった？', 'ピット入るぞ'], ['さっきピット入る判断は正しかった？', ''],
  ['前回のこのコース、ピットはどうだった？', '']]) {
  ck('past evaluation is not a current card: ' + t, topics(t, recent).length === 0, topics(t, recent));
}
for (const [mixed, alone] of [['さっきのピットは良かった。今のプランは？', '今のプランは？'],
  ['さっきのピットは良かった。今は何周目に入る？', '今は何周目に入る？']]) {
  ck('mixed turn keeps the current question: ' + mixed, JSON.stringify(topics(mixed)) === JSON.stringify(topics(alone)), [topics(mixed), topics(alone)]);
}
ck('current pit decision still a card', topics('ピット入る判断して').includes('pit_decision'), topics('ピット入る判断して'));
ck('previous fuel use still answered', topics('前回の燃費は？').includes('fuel_use'), topics('前回の燃費は？'));

// Release regression: a separate tyre clause must not swallow a pit cancel.
const router=require('./desktop/local-intent-router');
const positives=['ピット中止、タイヤ交換はしない。','タイヤ交換はしない、ピット中止。','cancel pit, do not change tires.'];
const negatives=['ピットキャンセルはしない。','タイヤ交換なしでピット中止はしない。',
  'ピット中止、タイヤ交換はしないで給油も中止しない。','ピット中止、やっぱりキャンセルはしない。',
  'もし必要ならピット中止、タイヤ交換はしない。','昨日「ピット中止、タイヤ交換はしない」と言った。',
  'ピット中止、タイヤ交換はしない？'];
const operation=(R,t)=>R.route({text:t,lang:'ja',live:{lap:9}})?.action?.operation;
for(const t of positives)ck('separate tyre negation keeps cancel request: '+t,operation(router,t)==='cancel',router.classifyDriverIntent(t));
for(const t of negatives)ck('pit negation/history/condition/question never promoted: '+t,operation(router,t)!=='cancel',router.classifyDriverIntent(t));
const fs=require('fs'),vm=require('vm');
const original=fs.readFileSync(__dirname+'/desktop/local-intent-router.js','utf8');
const fault=original.replace('/i.test(negationText);','/i.test(text);');
ck('whole-utterance negation fault anchor matched',fault!==original);
const ctx={module:{exports:{}}};vm.createContext(ctx);vm.runInContext(fault,ctx);
ck('fault loses the same compound cancel, plain cancel control still works',operation(ctx.module.exports,positives[0])!=='cancel'&&operation(ctx.module.exports,'ピット中止。')==='cancel');
for(const t of negatives)ck('fault control preserves nearby negative: '+t,operation(ctx.module.exports,t)!=='cancel');

console.log(`[WO019 intent pairs] 合格 ${pass} / 不合格 ${fail}`);
process.exit(fail ? 1 : 0);
