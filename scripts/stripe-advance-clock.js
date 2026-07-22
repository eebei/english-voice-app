// Test Clockを5日+1時間進め、5日トライアル明けの初回invoice.paidを発火させる。
// 使い方: node scripts/stripe-advance-clock.js <test_clock_id>
require('dotenv').config();
const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('STRIPE_SECRET_KEY が未設定です'); process.exit(1); }
if (!key.startsWith('sk_test_')) {
  console.error('本番キー(sk_live_)が検出されました。テストキー(sk_test_)のみ許可します。中断します。');
  process.exit(1);
}
const Stripe = require('stripe');
const stripe = new Stripe(key);

const clockId = process.argv[2];
if (!clockId) { console.error('使い方: node scripts/stripe-advance-clock.js <test_clock_id>'); process.exit(1); }

async function main() {
  const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
  const advanced = Math.floor(Date.now() / 1000) > clock.frozen_time
    ? Math.floor(Date.now() / 1000) + 5 * 86400 + 3600
    : clock.frozen_time + 5 * 86400 + 3600;
  console.log('Test Clockを5日+1時間進めます...');
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: advanced });

  // advance()は非同期。ready状態になるまで待つ。
  let status = 'advancing';
  while (status === 'advancing') {
    await new Promise((r) => setTimeout(r, 2000));
    const c = await stripe.testHelpers.testClocks.retrieve(clockId);
    status = c.status;
    console.log('status:', status);
  }
  console.log('完了。Stripe CLIのwebhook転送ログで invoice.paid / trial_started 相当のイベントを確認してください。');
}

main().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
