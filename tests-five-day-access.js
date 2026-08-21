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
check('member, paid Starter Pass, and tester are the only accepted identities',
  server.includes('req.user && await auth.hasPitwallEntitlement(req.user)') &&
  auth.includes('async function hasPitwallEntitlement') &&
  server.includes("req.headers['x-pitwall-access-code']") &&
  server.includes('auth.verifyBetaToken(code, deviceId)'));
// ★8/19 書き換え：ここは applyPitwallAccess() の呼び出し**回数が7**であることを
//   見ていた。その後の実装で呼び出しが10へ増え、認証は全経路で効いているのに
//   テストだけが落ちる状態になっていた（回数はコードが育てば必ずズレる）。
//   守りたい性質は回数ではなく「課金APIを叩く fetch はすべて認証されている」。
//   その性質を直接見る形へ変更する。緩めたのではなく、より強い検査にしている。
{
  // コメントアウトされたコードを認証の証拠と誤認しないよう、行コメントを落とす。
  const strip = t => t.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const lines = strip(renderer).split('\n');
  const src = lines.join('\n');
  const unauthenticated = [];
  let costFetches = 0;
  const re = /fetch\(API_BASE\+'\/api\/(?:chat|translate|tts|stt)'\s*,\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    costFetches++;
    const lineNo = src.slice(0, m.index).split('\n').length;
    // fetch の第2引数オブジェクトだけを、波括弧の対応を取って切り出す。
    // 行数で切ると隣の fetch を巻き込み、無認証の呼び出しを見逃す。
    let depth = 1, j = re.lastIndex;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    const opts = src.slice(re.lastIndex, j);
    // `headers: chatHeaders` と、ES6短縮記法の `{method:'POST',headers,body:…}` の両方。
    const ident = (opts.match(/headers\s*:\s*([A-Za-z_$][\w$]*)/) || [])[1]
      || (/(^|[,{\s])headers\s*(,|$|\})/.test(opts) ? 'headers' : null);
    // 直前80行に、その headers 変数へ認証を載せた形跡があること。
    const back = lines.slice(Math.max(0, lineNo - 81), lineNo - 1).join('\n');
    const viaHelper = ident && new RegExp('applyPitwallAccess\\(\\s*' + ident + '\\b').test(back);
    const viaManual = ident && new RegExp(ident + "\\['X-Pitwall-Access-Code'\\]\\s*=").test(back);
    if (!ident || !(viaHelper || viaManual)) unauthenticated.push(lineNo + ':' + (ident || '?'));
  }
  check('desktop authenticates every cost API request (' + costFetches + ' fetch sites)',
    costFetches >= 9 && unauthenticated.length === 0);
}
check('expired local code is cleared and cannot silently reopen',
  renderer.includes("res.reason==='expired'") && renderer.includes("expired:t('err_expired')"));
check('admin list exposes activation, expiry and remaining time',
  auth.includes('activated_at, expires_at') && auth.includes('seconds_remaining'));
check('admin can trigger immediate expiry without changing the five-day policy',
  auth.includes('async function expireBetaToken') &&
  auth.includes("expires_at = now() - interval '1 second'") &&
  server.includes("app.post('/api/beta/admin/expire'"));

console.log(`\n${passed} checks passed`);
