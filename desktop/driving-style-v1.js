(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PitwallDrivingStyleV1=api;}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const finite=v=>Number.isFinite(Number(v))?Number(v):null;
  function compare(current,references={}){
    const cur=current&&current.available===true?current:null;
    if(!cur||!cur.features)return {available:false,reason:'no_clean_lap_features'};
    const candidates=[
      ['self_best',references.self_best],
      ['self_consistent',references.self_consistent],
      ['driver_confirmed',references.driver_confirmed],
      ['measured_reference',references.measured_reference]
    ];
    let source='general_tendency', ref=null;
    const excluded=[];
    for(const [kind,value] of candidates){
      if(!value||!value.features)continue;
      const fuelA=finite(cur.features.fuel_start_l),fuelB=finite(value.features.fuel_start_l);
      const tyreA=finite(cur.features.tyre_mean_c),tyreB=finite(value.features.tyre_mean_c);
      if(fuelA!==null&&fuelB!==null&&Math.abs(fuelA-fuelB)>10){excluded.push(`${kind}:fuel_condition`);continue;}
      if(tyreA!==null&&tyreB!==null&&Math.abs(tyreA-tyreB)>15){excluded.push(`${kind}:tyre_condition`);continue;}
      source=kind;ref=value;break;
    }
    const keys=['brake_start_pct','brake_release_pct','minimum_speed_mps','throttle_start_pct','full_throttle_pct','steering_corrections','lap_to_lap_reproducibility'];
    const deltas=[];
    if(ref){for(const key of keys){const a=finite(cur.features[key]),b=finite(ref.features[key]);if(a!==null&&b!==null)deltas.push({feature:key,delta:a-b});}}
    // One coaching point only. Numeric deltas are legal only against measured
    // or personal telemetry, never against general tendency.
    const preferred=references.confirmed_condition&&references.confirmed_condition.feature;
    const strongest=(preferred&&deltas.find(x=>x.feature===preferred))
      ||deltas.sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta))[0]||null;
    return {available:true,source,confidence:ref?(deltas.length>=3?'high':'medium'):'low',
      evidence_kind:ref?'measured_features':'general_tendency',point:strongest,
      numeric_allowed:!!ref,features:cur.features,excluded_references:excluded};
  }
  function format(result,lang='ja'){
    if(!result||!result.available)return lang==='ja'?'比較できるクリーンラップがまだない。':'I do not have a comparable clean lap yet.';
    const prefix={self_best:['あなたのベスト時と比べると','Compared with your best lap'],self_consistent:['安定して速かった周と比べると','Compared with your consistently quick laps'],driver_confirmed:['あなたが登録した基準周と比べると','Compared with your confirmed reference lap'],measured_reference:['登録されたリファレンスドライバーと比べると','Compared with the registered reference driver'],general_tendency:['一般的な傾向としては','As a general tendency']}[result.source];
    if(!result.point)return lang==='ja'?`${prefix[0]}、今は一つに絞れる明確な差がない。`:`${prefix[1]}, there is no clear single priority yet.`;
    const labels={brake_start_pct:'ブレーキ開始',brake_release_pct:'ブレーキリリース',minimum_speed_mps:'最低速度',throttle_start_pct:'アクセル開始',full_throttle_pct:'全開開始',steering_corrections:'操舵修正',lap_to_lap_reproducibility:'ラップ間再現性'};
    const label=labels[result.point.feature]||result.point.feature;
    if(lang==='ja')return `${prefix[0]}、まず${label}を改善候補にしよう。役に立ったか走行後に確認したい。`;
    return `${prefix[1]}, make ${label.replaceAll('_',' ')} the single improvement focus. Confirm after the run whether it helped.`;
  }
  function confirm(store,result,accepted,identity,now=Date.now()){
    const rows=Array.isArray(store)?store.slice():[];
    if(!accepted)return {store:rows,record:null,reason:'rejected'};
    if(!result||result.available!==true||!result.point||!result.point.feature)return {store:rows,record:null,reason:'advice_unavailable'};
    if(!identity||!identity.userId||!identity.track||!identity.car)return {store:rows,record:null,reason:'identity_unavailable'};
    const record={id:`style:${identity.userId}:${now}`,status:'active',confirmed_at:now,
      user_id:identity.userId,track:identity.track,car:identity.car,source:result.source,
      condition:{feature:result.point&&result.point.feature},evidence_kind:result.evidence_kind};
    rows.push(record);return {store:rows.slice(-50),record,reason:'confirmed'};
  }
  return {compare,format,confirm};
}));
