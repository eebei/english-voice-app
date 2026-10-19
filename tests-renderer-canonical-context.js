'use strict';
// Test IO setup: real canonical cache + real read projection. All current facts
// remain explicit fixture inputs; absent facts stay null, never a legacy fallback.
const fs=require('fs'),vm=require('vm'),CF=require('./tests-canonical-lifecycle');
const html=fs.readFileSync(__dirname+'/desktop/renderer.html','utf8');
function extract(name){const m=new RegExp('^(?:async )?function '+name+'\\(','m').exec(html);if(!m)throw Error(name);const rest=html.slice(m.index);const end=rest.slice(1).search(/\n(?:async function |function |const |let |\/\/ ──)/);return rest.slice(0,end>0?end+1:rest.length);}
function install(context,live={},recommendations={}){
 const s=CF.fixture({race:'test-race',session:live.session_num??1,decision:null,proof:null,attempt:null,allowed:false});
 s.continuity.stable_scope={race_instance_id:s.race_instance_id,session_num:s.session_num,driver_id:1};
 s.current_facts.current_lap=live.lap??null;s.current_facts.fuel_level_l=live.fuel??null;
 s.current_facts.on_pit_road=live.on_pit_road??null;s.current_facts.on_track=live.on_track??null;
 const crossings=Number.isInteger(live.finish_crossings_authority)?live.finish_crossings_authority:null;
 s.finish={kind:crossings===null?null:'lap_race',available:crossings!==null,remaining_sf_crossings:crossings,remaining_after_current:crossings===null?null:Math.max(0,crossings-1),source_frame_sequence:s.source_frame.sequence};
 s.recommendations=recommendations;
 context.canonicalLifecycleCache=CF.initialized(()=>0,s);
 context.strategyProjection=require('./desktop/strategy-state-projection').create({canonical:context.canonicalLifecycleCache,now:()=>0});
 if(!vm.isContext(context))vm.createContext(context);
 vm.runInContext(['currentCanonicalStrategyLive','ensureStrategyState','currentStrategyStateAPI'].map(extract).join('\n'),context);
 return s;
}
module.exports={extract,install};
