#!/usr/bin/env node
'use strict';

// Build 266 — Codex差戻し#5：strategy_recalculation の日本語無線が配線されていること。
//
// 差戻しの内容：bridge.py は英語の driver_message を載せて broadcast する。
// renderer の日本語キャラクター（LunaJP / Oishi / Kanbe / HajimeJP）は
// `oishiRadio(data) || data.message` の順で文面を決めるため、case が無いと
// 英語がそのまま日本語音声で読み上げられる。実走では pit_box_here で同じ事故が
// 起きている（renderer.html の該当コメント参照）。
//
// 外部APIは呼ばない（内部シミュレーション正本 §Non-negotiable rules 1）。

const fs = require('fs');
const vm = require('vm');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');

let pass = 0, fail = 0;
function check(label, ok) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label);
  ok ? pass++ : fail++;
}

const fnSrc = renderer.match(/function oishiRadio\(d, forSpeech=false\)\{[\s\S]*?\n\}/);
check('oishiRadio を抽出', !!fnSrc);

if (fnSrc) {
  const context = { lapTimeSpeechJP: (t) => String(t || '') };
  vm.runInNewContext(fnSrc[0], context);
  const jp = (d) => context.oishiRadio(Object.assign({ trigger: 'strategy_recalculation' }, d), false);

  const hasAscii = (s) => /[A-Za-z]{3,}/.test(String(s || ''));

  // ── 1. reason ごとの日本語文面 ──────────────────────────────────
  const driverReport = jp({ reason: 'driver_reported_damage', category: 'steering_or_front_end' });
  check('driver_reported_damage が日本語になる', /操舵異常の申告あり/.test(driverReport));
  check('driver_reported_damage が前提を外したと言う', /通常ペース前提を外した/.test(driverReport));
  check('driver_reported_damage に英単語が混ざらない', !hasAscii(driverReport));

  check('front_aero_or_body の部位名が日本語',
    /フロントの損傷の申告あり/.test(jp({ reason: 'driver_reported_damage', category: 'front_aero_or_body' })));
  check('steering_alignment の部位名が日本語',
    /アライメント異常の申告あり/.test(jp({ reason: 'driver_reported_damage', category: 'steering_alignment' })));

  const repair = jp({ reason: 'repair_detected_or_opt_not_taken' });
  check('repair_detected_or_opt_not_taken が日本語になる', /損傷を確認/.test(repair));
  check('repair 側も保守表現（保留）を使う', /保留/.test(repair));

  check('fuel_deviation が日本語になる', /燃費が基準から変わった/.test(jp({ reason: 'fuel_deviation' })));
  check('pace_deviation が日本語になる', /ペースが基準から変わった/.test(jp({ reason: 'pace_deviation' })));

  // ── 2. 英語フォールバックへ落ちないこと ────────────────────────
  // 未知 reason／reason 欠落でも空文字を返してはいけない。空を返すと
  // injectRadio が data.message（英語）を採用する。
  const unknown = jp({ reason: 'some_future_reason' });
  check('未知の reason でも空文字を返さない', !!unknown && unknown.length > 0);
  check('未知の reason でも日本語', !hasAscii(unknown));
  const noReason = jp({});
  check('reason 欠落でも空文字を返さない', !!noReason && noReason.length > 0);
  check('category 欠落でも日本語で成立する',
    !hasAscii(jp({ reason: 'driver_reported_damage' })));

  // ── 3. 英語 message を読まないこと ─────────────────────────────
  const withEnglish = jp({
    reason: 'driver_reported_damage', category: 'steering_or_front_end',
    message: 'Driver-reported steering_or_front_end. Standard pace assumption is on hold.',
  });
  check('bridge の英語 message を素通しさせない', !/Driver-reported/.test(withEnglish));
  check('英語 message があっても日本語のまま', !hasAscii(withEnglish));

  // ── 4. 発話の長さ（内部シミュレーション正本 §3・brief §4）────────
  // 走行中の無線は一文、必要なら二文まで。内部の全数値を読み上げない。
  ['driver_reported_damage', 'repair_detected_or_opt_not_taken',
   'fuel_deviation', 'pace_deviation'].forEach((reason) => {
    const text = jp({ reason, category: 'steering_or_front_end' });
    const sentences = text.split('。').filter((s) => s.trim().length > 0).length;
    check(`${reason} は三文以内`, sentences <= 3);
    check(`${reason} は数値を読み上げない`, !/[0-9]/.test(text));
  });
}

// ── 4b. Plan A/B/C の戦略無線が新契約に揃っていること ──────────────
// ★Plan B定義の判断（2026-08-12）：B=アンダーカット（Aより前）／C=オーバーカット。
//   「1周延長」を B に使わない。B と C の語を取り違えない。
if (fnSrc) {
  const context = { lapTimeSpeechJP: (t) => String(t || '') };
  vm.runInNewContext(fnSrc[0], context);
  const jp = (d) => context.oishiRadio(d, false);

  const planOptions = {
    plan_a: { available: true, target_in_laps: 8, set_fuel_l: 22 },
    plan_b: { available: true, fuel_window_open: true, target_in_laps: 2, set_fuel_l: 22 },
    plan_c: { available: true, target_in_laps: 9, set_fuel_l: 19 },
  };

  const decisionB = jp({ trigger: 'strategy_plan_decision', selected_plan: 'B',
                         strategy_options: planOptions });
  check('Plan B の決定はアンダーカットと言う', /アンダーカット/.test(decisionB));
  check('Plan B の決定に「延長」が混ざらない', !/延長/.test(decisionB));

  const decisionC = jp({ trigger: 'strategy_plan_decision', selected_plan: 'C',
                         strategy_options: planOptions });
  check('Plan C の決定は延長と言う', /延長/.test(decisionC));
  check('Plan C の決定に「アンダーカット」が混ざらない', !/アンダーカット/.test(decisionC));

  const decisionA = jp({ trigger: 'strategy_plan_decision', selected_plan: 'A',
                         strategy_options: planOptions });
  check('Plan A の決定は基準と言う', /基準/.test(decisionA));
  check('Plan A の決定に B/C の語が混ざらない',
    !/アンダーカット/.test(decisionA) && !/延長/.test(decisionA));

  const briefing = jp({ trigger: 'initial_strategy_plans', strategy_options: planOptions });
  check('ブリーフィングに「1周延長案」が残っていない', !/1周延長/.test(briefing));
  check('ブリーフィングはBを候補として述べる（断定しない）',
    /アンダーカット/.test(briefing) && /揃えば/.test(briefing));

  const briefingNoWindow = jp({ trigger: 'initial_strategy_plans', strategy_options: {
    plan_a: planOptions.plan_a, plan_b: { fuel_window_open: false } } });
  check('ウインドウが開いていなければBに触れない',
    !!briefingNoWindow && !/アンダーカット/.test(briefingNoWindow));

  const boxCall = jp({ trigger: 'strategy_plan_box_call', selected_plan: 'B',
                       strategy_options: planOptions });
  check('box call に「延長案」が残っていない', !/延長案/.test(boxCall));
  check('box call はこの周のピットを指示する', /この周でピット/.test(boxCall));
}

// ── 5. bridge 側が構造化フィールドを送っていること ────────────────
// 文面を renderer で組み立てられるのは、reason / category が payload に
// 載っているからである。載っていなければ日本語ケースは機能しない。
const broadcastIdx = bridge.indexOf("'trigger': 'strategy_recalculation'");
check('bridge が strategy_recalculation を broadcast する', broadcastIdx > -1);
if (broadcastIdx > -1) {
  const window = bridge.slice(broadcastIdx, broadcastIdx + 400);
  check('broadcast に reason が載る', /'reason':/.test(window));
  check('broadcast に category が載る', /'category':/.test(window));
}

// ── 6. 日本語キャラクターが oishiRadio を経由すること ──────────────
const dispatch = renderer.match(/if\(sel==='Kanbe'\|\|sel==='Oishi'\|\|sel==='HajimeJP'\|\|sel==='LunaJP'\)\{[\s\S]{0,200}/);
check('LunaJP が oishiRadio 経由で文面を決める', !!dispatch && /oishiRadio\(data,false\)/.test(dispatch[0]));

console.log(`\nStrategy Recalculation JP Radio: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
