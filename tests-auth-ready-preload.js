'use strict';

// HTTP route tests exercise response contracts, not Postgres.  Preload the
// real auth module and replace only its boundary methods in this child process.
const auth=require('./auth');
auth.init=async()=>true;
auth.isReady=()=>true;
auth.attachUser=(req,res,next)=>{ req.user={is_member:true}; next(); };

