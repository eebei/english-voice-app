'use strict';
// Cost Telemetry: 累積チェックポイント、再送、利用文脈分類の回帰テスト。
const fs = require('fs');
const vm = require('vm');

let pass=0, fail=0;
function check(name, cond){ cond?pass++:fail++; console.log((cond?'  ✅ ':'  ❌ ')+name); }

const server = fs.readFileSync(__dirname+'/server.js','utf8');
const authSrc = fs.readFileSync(__dirname+'/auth.js','utf8');
const renderer = fs.readFileSync(__dirname+'/desktop/renderer.html','utf8');
const bridge = fs.readFileSync(__dirname+'/irsdk-bridge/bridge.py','utf8');

// 本番の純粋分類関数を直接抽出して実行する。
const contextFn = server.match(/function deriveUsageContext\(body, source\) \{[\s\S]*?\n\}/);
check('deriveUsageContext本番関数を抽出できる', !!contextFn);
const ctx={}; vm.createContext(ctx);
vm.runInContext(contextFn[0]+'\nthis.f=deriveUsageContext;',ctx);
check('E0 INACTIVE_DRIVER PTTはteam_engineer',ctx.f({driverActivity:'INACTIVE_DRIVER',driverState:'track'},'ptt')==='team_engineer');
check('E0 DRIVER_HANDOFF typedもteam_engineer',ctx.f({driverActivity:'DRIVER_HANDOFF',driverState:'pit'},'typed')==='team_engineer');
check('旧build garage PTTもteam_engineer',ctx.f({driverState:'garage'},'ptt')==='team_engineer');
check('track PTTはdriver_support',ctx.f({driverState:'track'},'ptt')==='driver_support');
check('自動judgeはauto_driver_support',ctx.f({},'auto_judge')==='auto_driver_support');
check('自動paceはauto_driver_support',ctx.f({},'auto_pace')==='auto_driver_support');
check('その他はother',ctx.f({},'other')==='other');

check('チェックポイント表はsession_id主キー',/CREATE TABLE IF NOT EXISTS usage_session_checkpoints[\s\S]*?session_id\s+TEXT PRIMARY KEY/.test(authSrc));
check('古いsequenceが新しい累積値を巻き戻さない',/WHERE EXCLUDED\.sequence >= usage_session_checkpoints\.sequence/.test(authSrc));
check('betaコード生値カラムを持たない',!/usage_session_checkpoints[\s\S]*?beta_code\s+TEXT/.test(authSrc));
check('betaコードはSHA-256化して保存',/createHash\('sha256'\)\.update\(betaCode\.trim\(\)\.toUpperCase\(\)\)/.test(server));
check('匿名の無認証投稿を拒否',/else if \(!req\.user\)[\s\S]*?identity_required/.test(server));
check('管理APIでsession原価と音声量を結合',/app\.get\('\/api\/usage\/session-stats'/.test(server)&&/LEFT JOIN api USING\(session_id\) LEFT JOIN google USING\(session_id\)/.test(authSrc));

check('60秒チェックポイント',/setInterval\(\(\)=>flushUsageTelemetry\('periodic',false,false\),60000\)/.test(renderer));
check('終了時keepalive送信',/beforeunload[\s\S]*?flushUsageTelemetry\('app_exit',true,true\)/.test(renderer));
check('iRacing切断時送信',/flushUsageTelemetry\('iracing_disconnected',false,false\)/.test(renderer));
check('失敗分をlocalStorageへ保持',/USAGE_QUEUE_KEY = 'pw_usage_checkpoint_queue_v1'/.test(renderer)&&/usageSaveQueued\(current\)/.test(renderer));
check('成功済みsequenceだけqueueから除去',/x\.sequence<=record\.sequence/.test(renderer));
check('queueを20セッションに制限',/q\.slice\(-20\)/.test(renderer));
check('重複flushを単一in-flightへ合流',/if\(usageFlushInFlight\) return usageFlushInFlight/.test(renderer));
check('429で再送ループを即時中断',/if\(r\.status===429\) return/.test(renderer));
check('接続直後にdriver_activityを強制通知',
  /broadcast\(\{'type': 'iracing_connected'\}\)[\s\S]*?_force_driver_activity_broadcast = True/.test(bridge)
  && /if _force_driver_activity_broadcast:[\s\S]*?broadcast\(\{'type': 'driver_activity'/.test(bridge));
check('PTTとtypedを別カウント',/usageCount\(inputSource==='ptt'\?'ptt':'typed'\)/.test(renderer));
check('judge/pace/briefing/insightを個別カウント',
  ['auto_judge','auto_pace','briefing','insight'].every(k=>renderer.includes(`usageCount('${k}')`)));

// 重要変異を戻すと、対応する契約検査が落ちることを確認。
const noSeqGuard=authSrc.replace('WHERE EXCLUDED.sequence >= usage_session_checkpoints.sequence','');
check('変異: sequenceガード削除を検出',!/WHERE EXCLUDED\.sequence >= usage_session_checkpoints\.sequence/.test(noSeqGuard));
const noExit=renderer.replace("flushUsageTelemetry('app_exit',true,true)",'');
check('変異: 終了送信削除を検出',!/beforeunload[\s\S]*?flushUsageTelemetry\('app_exit',true,true\)/.test(noExit));
const noRateLimitBreak=renderer.replace('if(r.status===429) return;','');
check('変異: 429中断削除を検出',!/if\(r\.status===429\) return/.test(noRateLimitBreak));
const contextMutation=contextFn[0].replace("activity === 'INACTIVE_DRIVER'","activity === 'NEVER'");
const ctx2={}; vm.createContext(ctx2); vm.runInContext(contextMutation+'\nthis.f=deriveUsageContext;',ctx2);
check('変異: E0非搭乗分類破壊を動的検出',ctx2.f({driverActivity:'INACTIVE_DRIVER',driverState:'track'},'ptt')!=='team_engineer');

console.log(`\nCost Telemetry: ${pass}/${pass+fail}`);
if(fail) process.exit(1);
