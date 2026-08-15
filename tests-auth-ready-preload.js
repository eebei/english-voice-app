'use strict';

// HTTP route tests exercise response contracts, not Postgres.  Preload the
// real auth module and replace only its boundary methods in this child process.
const auth=require('./auth');
auth.init=async()=>true;
auth.isReady=()=>true;
auth.attachUser=(req,res,next)=>{ req.user={is_member:true}; next(); };

// Canonical internal-simulation policy: normal tests must make zero live
// Anthropic calls.  Replace the SDK constructor in this child process with a
// local failure stub.  Guarded routes prove they never reach create(); the
// API-failure test still receives a deterministic 401-shaped exception and
// can verify the server's catch path without opening a network connection.
const anthropicPath=require.resolve('@anthropic-ai/sdk');
class TestAnthropic {
  constructor(){
    this.messages={create:async()=>{
      const err=new Error('simulated Anthropic 401 (external calls disabled)');
      err.status=401;
      throw err;
    }};
  }
}
TestAnthropic.defaultHttpClient={};
require.cache[anthropicPath]={
  id:anthropicPath,filename:anthropicPath,loaded:true,exports:TestAnthropic,
};
