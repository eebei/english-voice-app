'use strict';const assert=require('assert'),router=require('./desktop/local-intent-router.js'),fs=require('fs');let n=0;function t(s,f){f();n++;console.log('ok',n,'-',s)}
const live={fuel:20,fuel_strategy:{pit_timing_authority:{available:true,range_laps:5,shortfall_to_finish_l:12,decision:'hold',latest_safe_pit_lap:9,laps_until_latest_safe_pit:4}}};
t('total shortfall does not become pit now',()=>{const x=router.route({text:'燃料足りる？',lang:'ja',live});assert.match(x.reply,/12\.0L不足/);assert.match(x.reply,/今は待てる/);assert.doesNotMatch(x.reply,/今周ピット/)});
t('pit-now only comes from timing decision',()=>{const x=router.route({text:'fuel status',lang:'en',live:{...live,fuel_strategy:{pit_timing_authority:{...live.fuel_strategy.pit_timing_authority,decision:'pit_now'}}}});assert.match(x.reply,/Pit this lap/)});
t('bridge attaches authority every live frame',()=>{const b=fs.readFileSync('./irsdk-bridge/bridge.py','utf8');assert.match(b,/\['pit_timing_authority'\]/);assert.match(b,/build_timing_authority/)});
t('malformed available timing without range fails back without throwing',()=>{assert.doesNotThrow(()=>router.route({text:'fuel?',lang:'en',live:{fuel:10,fuel_strategy:{pit_timing_authority:{available:true,range_laps:null}}}}))});
console.log(`${n}/${n} passed`);
