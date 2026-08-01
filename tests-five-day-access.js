#!/usr/bin/env node
'use strict';

const fs = require('fs');
const auth = fs.readFileSync('auth.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');

let passed = 0;
function check(label, condition) {
  if (!condition) throw new Error(label);
  console.log('✅ ' + label);
  passed++;
}

check('activation and expiry live in the server database',
  auth.includes('ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ') &&
  auth.includes('ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ'));
check('five-day window is set atomically once',
  auth.includes("expires_at = now() + interval '5 days'") &&
  auth.includes('activated_at IS NULL'));
check('server clock rejects expiry',
  auth.includes('new Date(expiresAt).getTime() <= Date.now()'));
check('expired code returns a dedicated reason',
  auth.includes("reason: 'expired'"));
check('new tester codes default to five days',
  auth.includes("tier = 'trial_5day'"));
check('all cost APIs share one entitlement middleware',
  server.includes("app.use(['/api/chat', '/api/translate', '/api/tts', '/api/stt'], requirePitwallEntitlement)"));
check('client product flag cannot bypass the gate',
  !server.includes("if (product !== 'pitwall') return next()"));
check('member and tester are the only accepted identities',
  server.includes('req.user && req.user.is_member') &&
  server.includes("req.headers['x-pitwall-access-code']") &&
  server.includes('auth.verifyBetaToken(code, deviceId)'));
check('desktop authenticates every cost API request',
  (renderer.match(/applyPitwallAccess\([^\n]+\);/g) || []).length === 7 &&
  renderer.includes("ttsHeaders['X-Pitwall-Access-Code']=ttsAccessCode"));
check('expired local code is cleared and cannot silently reopen',
  renderer.includes("res.reason==='expired'") && renderer.includes("expired:t('err_expired')"));
check('admin list exposes activation, expiry and remaining time',
  auth.includes('activated_at, expires_at') && auth.includes('seconds_remaining'));
check('admin can trigger immediate expiry without changing the five-day policy',
  auth.includes('async function expireBetaToken') &&
  auth.includes("expires_at = now() - interval '1 second'") &&
  server.includes("app.post('/api/beta/admin/expire'"));

console.log(`\n${passed} checks passed`);
