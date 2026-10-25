'use strict';
// Actual HTTP early-return chain; only the external provider is a saved I/O double.
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),assert=require('assert');
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'historical-http-')),p=await port();let child;
 const rows=[];let logs='';
 try{
  child=spawn(process.execPath,['-r','./tests-wo001-anthropic-stream-stub-preload.js','server.js'],{cwd:__dirname,
   env:{...process.env,PORT:String(p),ANTHROPIC_API_KEY:'sk-test-local-stub',DATABASE_URL:'',JWT_SECRET:'',STRIPE_SECRET_KEY:'',WO019_SDK_QUEUE_DIR:dir}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server startup timeout')),15000);child.stdout.on('data',b=>{logs+=b;if(logs.includes('is running')){clearTimeout(timer);resolve();}});child.stderr.on('data',b=>logs+=b);child.on('exit',code=>{clearTimeout(timer);reject(Error('server exit '+code));});});
  const past=['昨日のレースは何週目にピットインした？何回で何位？','違うよ。これからのレースじゃなくて、昨日のレースで何週目にピットインしたか？','昨日のレースの燃料残量は？','何周目にピットインした？'];
  for(let i=0;i<past.length;i++){
   const q=past[i],expected='保存記録では13周目と20周目にピット、2回。クラス20位。';
   fs.writeFileSync(path.join(dir,String(i).padStart(3,'0')+'-past.json'),JSON.stringify({forUserText:q,chunks:[expected]}));
   const messages=i===3?[{role:'user',content:'昨日のレースのデータを教えて。'},{role:'assistant',content:'昨日のレースの記録を確認する。'},{role:'user',content:q}]:[{role:'user',content:q}];
   const response=await fetch('http://127.0.0.1:'+p+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({character:'LunaJP',mode:'race',stream:true,messages,liveData:{fuel:48,race_plan:{kind:'timed',configured_duration_s:1800}}})});
   const body=await response.text(),consumed=fs.existsSync(path.join(dir,String(i).padStart(3,'0')+'-past.json.consumed'));
   const row={q,status:response.status,authority:response.headers.get('x-pitwall-authority'),body,provider_consumed:consumed};rows.push(row);
   assert(response.status===200&&consumed&&body.includes('13周目')&&!body.includes('Plan A'),'past query stolen by current authority: '+JSON.stringify(row));
  }
  for(const q of ['今のレースは何周？','昨日じゃなく今日のレースは何周？']){
   const response=await fetch('http://127.0.0.1:'+p+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({character:'LunaJP',mode:'race',stream:true,messages:[{role:'user',content:q}]})});
   const body=await response.text();rows.push({q,status:response.status,authority:response.headers.get('x-pitwall-authority'),body});
   assert(response.status===200&&response.headers.get('x-pitwall-authority')==='deterministic','present authority route regressed');
  }
  console.log('Historical HTTP: '+rows.length+' actual routes PASS; paid APIs 0');
 }finally{
  if(process.env.HISTORICAL_HTTP_OUTPUT)fs.writeFileSync(process.env.HISTORICAL_HTTP_OUTPUT,JSON.stringify({rows,logs},null,2));
  if(child)child.kill('SIGTERM');fs.rmSync(dir,{recursive:true,force:true});
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
