const fs=require('fs'),vm=require('vm'),root=require('path').resolve(__dirname,'..');
const Store=require(root+'/desktop/critical-journal-store.js'),Client=require(root+'/desktop/critical-journal-client.js'),os=require('os'),path=require('path');
const store=Store.create(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'pitwall-wire-')),'journal.json'));store.load();const criticalJournal=Client.create({criticalJournalLoad:store.load,criticalJournalTransact:store.transact});
const router=require(root+'/desktop/local-intent-router.js'),src=fs.readFileSync(root+'/desktop/renderer.html','utf8');
function extract(n){let a=src.indexOf('function '+n+'('),i=src.indexOf('{',a),d=0;for(;i<src.length;i++){if(src[i]==='{')d++;else if(src[i]==='}'&&!--d)return src.slice(a,i+1);}throw n;}
const cacheModule=require(root+'/desktop/canonical-lifecycle-cache.js');
const live=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),sent=[];
const c={criticalJournal,performance:{now:()=>0},Date,Math,Number,String,crypto:{randomUUID:()=> 'wo008-vertical'},lastTelemetry:live,lastSessionNum:live.session_num,irBridge:{readyState:1,send:x=>sent.push(JSON.parse(x))},driverPlanCommandOutbox:new Map(),pendingDriverPlanFollowup:null,diagnosticLog:()=>{}};
c.canonicalLifecycleCache=cacheModule.create({now:()=>0});const gen=c.canonicalLifecycleCache.beginSocket();c.canonicalLifecycleCache.hello(gen,{type:'connected',schema_version:1,bridge_process_epoch:live.bridge_process_epoch});c.canonicalLifecycleCache.receive(live.canonical_lifecycle,gen);c.globalThis=c;vm.createContext(c);vm.runInContext(['newDriverPlanCommandId','currentDriverPlanAuthority','flushDriverPlanCommandOutbox','queueDriverPlanCommand'].map(extract).join('\n'),c);
const routed=router.route({text:'ピットを10周目に変更',lang:'ja',live});c.queueDriverPlanCommand(routed.action,'ピットを10周目に変更','u');process.stdout.write(JSON.stringify(sent[0]));
