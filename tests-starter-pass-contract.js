#!/usr/bin/env node
'use strict';

// Contract checks for the one-time $9.99 Starter Pass.  These are static on
// purpose: no Stripe, Railway, database, or paid AI API is contacted.
const fs = require('fs');
const auth = fs.readFileSync('auth.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
let pass = 0, fail = 0;
function check(label, ok) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label);
  if (ok) pass++; else fail++;
}

check('Starter Pass価格IDはFounding価格IDと別名である',
  /STRIPE_STARTER_PRICE_ID/.test(auth) && /STRIPE_FOUNDING_PRICE_ID/.test(auth));
check('Starter Checkoutは一回払いである',
  /async function createStarterCheckout[\s\S]{0,900}mode:\s*'payment'/.test(auth));
check('Starter Checkoutにsubscription_dataを持たない',
  !/async function createStarterCheckout[\s\S]{0,900}subscription_data/.test(auth));
check('Starter Checkoutにtrial_period_daysを持たない',
  !/async function createStarterCheckout[\s\S]{0,900}trial_period_days/.test(auth));
check('クライアントが価格IDや期間を渡せない',
  /app\.post\('\/api\/starter\/checkout'[\s\S]{0,500}const \{ anon_id, lang \}/.test(server));
check('webhookはpayment成功かつstarter metadataだけをStarterとして扱う',
  /s\.mode === 'payment' && s\.payment_status === 'paid'[\s\S]{0,180}s\.metadata\.product === 'starter'/.test(server));
check('webhookはcheckout sessionを冪等キーにしてStarter権利を付与する',
  /grantStarterPass\([\s\S]{0,500}checkoutSessionId: s\.id/.test(server));
check('30日権利はサーバーDBに保存される',
  /starter_expires_at TIMESTAMPTZ/.test(auth) &&
  /STARTER_PASS_DAYS = 30/.test(auth) &&
  /\$4::int \* interval '1 day'/.test(auth));
check('Starter権利はclient clockではなくDBのexpires_atで判定する',
  /hasActiveStarterPass[\s\S]{0,500}expires_at > now\(\)/.test(auth));
check('旧Founding会員はStarter期限経路へ落とさない',
  /if \(user\.plan !== 'starter'\) return true/.test(auth));
check('付与済みcheckout sessionを二重付与しない',
  /existing_session[\s\S]{0,180}alreadyGranted: true/.test(auth));
check('Starterにのみenforced利用量台帳を付与する',
  /enrollEnforcedCreditAccount[\s\S]{0,900}mode='enforced'/.test(auth));
check('Starter利用量は正の台帳残高だけを許可する',
  /async function hasStarterCredits[\s\S]{0,600}Number\(row\.balance\) > 0/.test(auth));
check('Starter権利は期限と利用量の両方を満たす必要がある',
  /hasActiveStarterPass\(user\.id\)\) && \(await hasStarterCredits\(user\.id\)\)/.test(auth));
check('利用量インジケーターは認証済みStarter本人にだけ渡す',
  /app\.get\('\/api\/starter\/status'/.test(server) &&
  /!req\.user \|\| req\.user\.plan !== 'starter'/.test(server) &&
  /getStarterPassStatus\(req\.user\.id\)/.test(server));
check('ログイン状態も期限切れStarterを会員表示しない',
  /starter_passes s[\s\S]{0,260}AS access_active/.test(auth) && /isMember: typeof u\.access_active === 'boolean' \? u\.access_active : u\.is_member/.test(auth));

console.log(`Starter Pass contract: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
