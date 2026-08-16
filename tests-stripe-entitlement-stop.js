#!/usr/bin/env node
'use strict';

// 一般会員の課金失敗時の利用権契約。外部Stripe/API/DBは呼ばない。
const fs = require('fs');
const server = fs.readFileSync('server.js', 'utf8');
const auth = fs.readFileSync('auth.js', 'utf8');
let pass = 0, fail = 0;
function check(label, ok) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label);
  if (ok) pass++; else fail++;
}

check('past_dueで一般会員を即停止する',
  /\['canceled', 'past_due', 'unpaid', 'incomplete_expired'\]\.includes\(sub\.status\)/.test(server));
check('Stripe解約でも従来どおり停止する',
  /customer\.subscription\.deleted[\s\S]{0,180}unsetMemberByCustomer\(event\.data\.object\.customer, 'canceled'\)/.test(server));
check('再請求成功時はcustomer idでだけ復帰する',
  /invoice\.paid[\s\S]{0,900}restoreMemberByCustomer\(inv\.customer, 'active'\)/.test(server));
check('復帰はStripe customer idで限定したDB更新である',
  /async function restoreMemberByCustomer[\s\S]{0,700}WHERE stripe_customer_id = \$1/.test(auth));
check('テスターコード台帳を変更しない',
  !/restoreMemberByCustomer[\s\S]{0,500}beta_tokens/.test(auth));

console.log(`Stripe entitlement stop: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
