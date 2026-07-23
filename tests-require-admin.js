// ══════════════════════════════════════════════════════════════════════
// requireAdmin テスト（Codexレビュー 2026-07-23：URLクエリ?secret=廃止・timingSafeEqual）
//   実サーバーを起動し、実際のHTTPリクエストで検証する（ロジックの写経ではない）。
//   /api/beta/admin/list を代表として使う（他の管理APIも同じrequireAdminを通る）。
// ══════════════════════════════════════════════════════════════════════
'use strict';
const { spawn } = require('child_process');
const http = require('http');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (cond ? '' : (detail ? '  → ' + detail : '')));
};

function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port, path, method: 'GET', headers: headers || {} }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 15000);
    child.stdout.on('data', d => { if (d.toString().includes('is running')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', d => process.stderr.write('[server] ' + d));
    child.on('exit', code => { clearTimeout(timer); reject(new Error('server exited early: code=' + code)); });
  });
}

async function withServer(port, extraEnv, fn) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      ANTHROPIC_API_KEY: 'sk-test-dummy-not-called',
      DATABASE_URL: '', JWT_SECRET: '', STRIPE_SECRET_KEY: '',
      ...extraEnv,
    },
  });
  try {
    await waitForServer(child);
    await fn(port);
  } finally {
    child.kill('SIGTERM');
  }
}

(async () => {
  const SECRET = 'test-admin-secret-xyz';
  const PATH = '/api/beta/admin/list';

  // ── ケース1: ADMIN_SECRET未設定 → 503 ──
  await withServer(4101, { ADMIN_SECRET: '' }, async (port) => {
    const r = await get(port, PATH);
    check('ADMIN_SECRET未設定 → 503', r.status === 503);
    check('未設定時のレスポンスに秘密値が含まれない', !r.body.includes(SECRET));
  });

  // ── ケース2〜6: ADMIN_SECRET設定済み ──
  await withServer(4102, { ADMIN_SECRET: SECRET }, async (port) => {
    // ケース2: ヘッダーなし → 401
    const r2 = await get(port, PATH);
    check('設定済み・ヘッダーなし → 401', r2.status === 401);

    // ケース3: ?secret=正解値のみ(クエリ経路は廃止済み) → 401
    const r3 = await get(port, PATH + '?secret=' + encodeURIComponent(SECRET));
    check('設定済み・?secret=正解値のみ → 401(クエリ認証は廃止)', r3.status === 401);

    // ケース4: x-admin-secret不一致 → 401
    const r4 = await get(port, PATH, { 'x-admin-secret': 'wrong-value' });
    check('設定済み・x-admin-secret不一致 → 401', r4.status === 401);

    // ケース4b: 長さの違う値でも例外にならず401(timingSafeEqualの長さ不一致ガード)
    const r4b = await get(port, PATH, { 'x-admin-secret': 'short' });
    check('長さが違うx-admin-secretでも500にならず401', r4b.status === 401);

    // ケース4c: 空文字ヘッダーも401
    const r4c = await get(port, PATH, { 'x-admin-secret': '' });
    check('空文字のx-admin-secretは401', r4c.status === 401);

    // ケース5: x-admin-secret一致 → 200(またはnext()到達。DB未設定なので実処理は500になりうるが、
    //   少なくとも401/503(=認証で弾かれた状態)ではないことを見ればnext()まで到達した証拠)
    const r5 = await get(port, PATH, { 'x-admin-secret': SECRET });
    check('設定済み・x-admin-secret一致 → 認証を通過する(401/503でない)', r5.status !== 401 && r5.status !== 503, 'status=' + r5.status);

    // ケース6: どのレスポンスにも秘密値そのものが含まれない
    check('401/200いずれのレスポンスにも秘密値が含まれない',
      !r2.body.includes(SECRET) && !r3.body.includes(SECRET) && !r4.body.includes(SECRET) && !r5.body.includes(SECRET));
  });

  console.log(`\n${fail === 0 ? '✅' : '❌'} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
