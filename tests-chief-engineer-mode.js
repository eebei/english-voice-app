#!/usr/bin/env node
'use strict';

// Chief Engineer Mode v0: UI -> Bridge config -> ACTIVE/HANDOFF event ->
// renderer radio + next-driver persistence. External APIs are never called.
const fs = require('fs');
const vm = require('vm');

const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');
let pass = 0, fail = 0;
function check(label, ok) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label);
  ok ? pass++ : fail++;
}

check('Settings に Chief Engineer Mode toggle がある', /id="chief-mode-enabled"/.test(renderer));
check('走行順3名と現在担当を入力できる',
  [1,2,3].every(n => renderer.includes(`id="chief-driver-${n}"`)) &&
  renderer.includes('id="chief-current-driver"'));
check('Bridge接続時に設定を同期', /irBridge\.onopen=[\s\S]*?sendChiefEngineerSettings\(\)/.test(renderer));
check('Bridgeは設定を3名以内へ正規化',
  /cmd == 'chief_engineer_config'/.test(bridge) && /\[:3\]/.test(bridge));

check('ACTIVE→DRIVER_HANDOFF条件を純粋gateへ渡す',
  /endurance_handoff_mod\.should_emit\(/.test(bridge) &&
  /previous_activity=_activity_before/.test(bridge) &&
  /new_activity=_new_activity/.test(bridge) &&
  /is_race=is_race_session/.test(bridge));
check('2名未満を含む発火条件は純粋gateが担当',
  /def should_emit/.test(fs.readFileSync('irsdk-bridge/endurance_handoff.py', 'utf8')));
check('専用イベントが非搭乗allow-listを通る',
  /ACTIVITY_ALLOWED_META_TYPES[\s\S]*?'chief_engineer_handoff'/.test(bridge));
check('handoffを通常radioとしてBridge送信しない',
  !/'type': 'radio', 'trigger': 'chief_engineer_handoff'/.test(bridge));

check('rendererが専用イベントをradioへ一度だけ変換',
  /data\.type==='chief_engineer_handoff'[\s\S]*?injectRadio\(\{type:'radio',trigger:'chief_engineer_handoff'/.test(renderer));
check('受信した次ドライバーindexを永続化',
  /pw_chief_current_driver',String\(next\)/.test(renderer));

const fnSrc = renderer.match(/function oishiRadio\(d, forSpeech=false\)\{[\s\S]*?\n\}/);
check('日本語radio formatterを抽出', !!fnSrc);
if (fnSrc) {
  const context = { lapTimeSpeechJP: t => String(t || '') };
  vm.runInNewContext(fnSrc[0], context);
  const spoken = context.oishiRadio({
    trigger:'chief_engineer_handoff',
    packet:{available:true,next_driver:'まーぼーさん',selected_plan:'B',
      next_pit_lap:31,fuel_set_l:72,finish_margin_l:1.4,damage_observed:false,
      tire_report:{summary:'右フロントの最小残量78.0%。次スティントは負担を確認。'},
      endurance_splash:{projected_final_service_l:8.4,final_stint_window_in_laps:11}}
  }, true);
  check('次担当・Plan・次pit・給油・余裕を含む',
    /まーぼーさんへ/.test(spoken) && /Plan B/.test(spoken) &&
    /31周/.test(spoken) && /72L/.test(spoken) && /1\.4L/.test(spoken));
  check('引き継ぎ無線は短い', spoken.length <= 90);
  check('ピット実測タイヤを次ドライバーへ含める', /タイヤ.*右フロント/.test(spoken), spoken);
  check('終盤スプラッシュの計画窓を次ドライバーへ含める', /終盤スプラッシュ8\.4L.*あと11周/.test(spoken), spoken);
}

check('グリーン後のサイドコールはstart rushで抑止しない',
  /if steering_angle is not None and is_race_session and session_racing_started:/.test(bridge));
check('戦略バトルだけはstart rushで抑止を維持',
  /is_race_session and idx in _same_class_main and not in_start_rush/.test(bridge));

check('Fuel Windowの一周前に戦略決定',
  /int\(lap\) >= max\(0, _decision_target - 1\)/.test(bridge));
check('決定後の対象周だけ短いBOX call',
  /int\(lap\) >= _box_target/.test(bridge) && /Box this lap\. Set %s liters\./.test(bridge));
check('事前判断とBOX callは別trigger',
  /'trigger': 'strategy_plan_decision'/.test(bridge) &&
  /'trigger': 'strategy_plan_box_call'/.test(bridge));

console.log(`\n[chief engineer mode] 合格 ${pass} / 不合格 ${fail}`);
process.exit(fail ? 1 : 0);
