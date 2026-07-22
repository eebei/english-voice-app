// 【Test Clock経路】trial_started → 5日早送り → first_paid_invoice を検証する。
// これはLP・/api/founding/checkoutを一切通らない。auth.createFoundingCheckout()を直接呼ぶため、
// 「staging LPからの通常Checkout経路」（別テスト）とは別のanon_idになる、独立した統合テスト。
// 本番コードは変更しない。auth.jsのcreateFoundingCheckout({customer})はテスト専用引数。
//
// 使い方:
//   STRIPE_SECRET_KEY=sk_test_xxx STRIPE_FOUNDING_PRICE_ID=price_xxx \
//   BASE_URL=https://<staging-url> node scripts/stripe-test-flow.js
//
// 実行すると:
//   1. sk_test_ で始まるキーかどうかを確認（本番キーなら即終了）
//   2. BASE_URLが未設定 or 本番ドメインでないかを確認（未設定/本番なら即終了）
//   3. Priceの金額($29.99)・通貨(usd)・周期(month)を検証（不一致なら即終了）
//   4. Test Clockを作成
//   5. Test Clockに紐づく顧客を作成
//   6. その顧客でFounding Checkout Session URLを発行（5日トライアル）
//   7. 表示されたURLをブラウザで開き、テストカード 4242 4242 4242 4242 / 任意の未来の有効期限 / 任意のCVCで決済を完了する
//   8. 決済完了後、stripe-advance-clock.js で5日進めて invoice.paid（初回実課金）を発火できる

require('dotenv').config();
const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('STRIPE_SECRET_KEY が未設定です'); process.exit(1); }
if (!key.startsWith('sk_test_')) {
  console.error('本番キー(sk_live_)が検出されました。テストキー(sk_test_)のみ許可します。中断します。');
  process.exit(1);
}

// BASE_URL未設定だとauth.jsのデフォルト（本番ドメイン）にフォールバックし、
// テスト決済のsuccess_url/cancel_urlが本番サイトを指してしまう。stagingでは必ず明示指定させる。
const baseUrl = process.env.BASE_URL;
if (!baseUrl) {
  console.error('BASE_URL が未設定です。staging URLを明示してください（例: BASE_URL=https://xxx.up.railway.app）。');
  process.exit(1);
}
if (/omoraypitwall\.com/.test(baseUrl)) {
  console.error('BASE_URL が本番ドメイン(omoraypitwall.com)を指しています。stagingのURLを指定してください。中断します。');
  process.exit(1);
}

const Stripe = require('stripe');
const stripe = new Stripe(key);
const auth = require('../auth');

async function main() {
  const priceId = process.env.STRIPE_FOUNDING_PRICE_ID;
  if (!priceId) { console.error('STRIPE_FOUNDING_PRICE_ID が未設定です'); process.exit(1); }

  // Priceが本当に「$29.99・月額・recurring」かをStripe側で検証してから進める。
  // 別プロダクトのPrice IDを誤って渡した場合に、誤った金額で課金テストが進むのを防ぐ。
  const price = await stripe.prices.retrieve(priceId);
  const problems = [];
  if (price.unit_amount !== 2999) problems.push(`金額が$29.99でない（実際: ${price.unit_amount}）`);
  if (price.currency !== 'usd') problems.push(`通貨がUSDでない（実際: ${price.currency}）`);
  if (!price.recurring || price.recurring.interval !== 'month') problems.push('周期が月額recurringでない');
  if (problems.length) {
    console.error('STRIPE_FOUNDING_PRICE_ID の検証に失敗:', problems.join(' / '));
    process.exit(1);
  }
  console.log('[検証OK] Price:', priceId, '$29.99/month recurring');

  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: Math.floor(Date.now() / 1000),
    name: 'pitwall-founding-test',
  });
  console.log('[1/3] Test Clock作成:', clock.id);

  const customer = await stripe.customers.create({
    email: `pitwall-test-${Date.now()}@example.com`,
    test_clock: clock.id,
  });
  console.log('[2/3] Test Clock付き顧客作成:', customer.id);

  const anonId = 'testclock-anon-' + Date.now();
  const { url, session_id } = await auth.createFoundingCheckout({
    anon_id: anonId,
    lang: 'en',
    customer: customer.id,
  });
  console.log('[3/3] Checkout Session作成:', session_id);
  console.log('');
  console.log('anon_id:', anonId, '（このテストのみのID。LP経由テストとは別系統）');
  console.log('test_clock_id:', clock.id);
  console.log('');
  console.log('次の手順:');
  console.log('1. 下のURLをブラウザで開き、テストカードで決済を完了する');
  console.log('   カード番号: 4242 4242 4242 4242 / 有効期限: 任意の未来 / CVC: 任意3桁');
  console.log('   URL:', url);
  console.log('2. 決済完了後、5日進めるには:');
  console.log(`   BASE_URL=${baseUrl} node scripts/stripe-advance-clock.js ${clock.id}`);
}

main().catch((e) => { console.error('失敗:', e.message); process.exit(1); });
