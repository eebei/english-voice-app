// ══════════════════════════════════════════════════════════════════════
// usageSessionId 初期化テスト（Codex再レビュー 2026-07-23 指摘 #1 への対応）
//   指摘：`let usageSessionId = newUsageSessionId();` は、newUsageSessionId()
//   内部で外側の usageSessionId(TDZ中・未初期化)へ代入するため、
//   起動直後に ReferenceError: Cannot access 'usageSessionId' before initialization
//   が発生する。node --check（構文パースのみ）では検出できないランタイムエラー。
//
//   対策：**desktop/renderer.html から本物の初期化コードを抽出して実際に実行する**。
//   TDZバグが再発すれば、このテストは例外で失敗する。
//   ⚠️Node vmの仕様：runInContext内のtop-level let/constはサンドボックスの
//     プロパティへ自動反映されない。同じcontextへ`this.__x = x;`を追加実行して
//     読み出す（このcontextの寿命内ではlet束縛が永続する）。
// ══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(__dirname + '/desktop/renderer.html', 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.reduce((a, b) => (a.length > b.length ? a : b));

const START = "let usageSessionId = '';";
const END_MARKER = '\nnewUsageSessionId();\n';

const startIdx = src.indexOf(START);
if (startIdx < 0) throw new Error('本番コードに usageSessionId の初期化ブロックが見つからない（実装が変わった可能性）');
const endIdx = src.indexOf(END_MARKER, startIdx);
if (endIdx < 0) throw new Error('本番コードに newUsageSessionId(); の初期化呼び出しが見つからない');
const block = src.slice(startIdx, endIdx + END_MARKER.length);

let fail = 0;
function check(label, cond) {
  if (cond) { console.log('   ✅ ' + label); }
  else { console.log('   ❌ ' + label); fail = 1; }
}
function readCurrent(ctx) {
  vm.runInContext('this.__usid = usageSessionId;', ctx);
  return ctx.__usid;
}

// ── ケース1：本番コードをそのまま実行し、TDZ由来のReferenceErrorが出ないことを確認 ──
const sentMessages = [];
const crypto1 = { randomUUID: () => 'fixed-uuid-1' };
const sandbox1 = {
  console,
  window: { crypto: crypto1 }, crypto: crypto1,   // ブラウザではwindow.crypto===crypto（グローバル）
  irBridge: { readyState: 1, send: (j) => sentMessages.push(JSON.parse(j)) },
};
vm.createContext(sandbox1);
let initError = null;
try {
  vm.runInContext(block, sandbox1);
} catch (e) {
  initError = e;
}
check('起動時の初期化がReferenceErrorを投げない', initError === null);
if (initError) console.log('      -> ' + initError.stack.split('\n').slice(0, 3).join('\n      '));

const afterInit1 = initError === null ? readCurrent(sandbox1) : null;
check('初期化後にusageSessionIdが空でない文字列', typeof afterInit1 === 'string' && afterInit1.length > 0);

// ── ケース2：irBridge接続済みなら、起動時の初期発行でもusage_sessionコマンドが送られる ──
const usageSessionMsgs = sentMessages.filter(m => m.cmd === 'usage_session');
check('起動時にirBridgeへusage_sessionコマンドが送られる', usageSessionMsgs.length >= 1);
if (usageSessionMsgs.length) {
  check('送られたsession_idがusageSessionIdと一致', usageSessionMsgs[usageSessionMsgs.length - 1].session_id === afterInit1);
}

// ── ケース3：irBridge未接続(readyState!==1)でも例外を投げず、空文字のままにならない ──
const crypto2 = { randomUUID: () => 'fixed-uuid-2' };
const sandbox2 = {
  console,
  window: { crypto: crypto2 }, crypto: crypto2,
  irBridge: null,
};
vm.createContext(sandbox2);
let initError2 = null;
try {
  vm.runInContext(block, sandbox2);
} catch (e) {
  initError2 = e;
}
check('irBridge未接続(null)でも初期化が例外を投げない', initError2 === null);
const afterInit2 = initError2 === null ? readCurrent(sandbox2) : null;
check('irBridge未接続でもusageSessionIdは発行される', typeof afterInit2 === 'string' && afterInit2.length > 0);

// ── ケース4：newUsageSessionId()を再度呼ぶと値が変わる（新しいiRacing接続の想定） ──
crypto1.randomUUID = () => 'fixed-uuid-3';
vm.runInContext('newUsageSessionId();', sandbox1);
const afterReissue = readCurrent(sandbox1);
check('newUsageSessionId()再呼び出しで値が変わる', afterReissue !== afterInit1 && afterReissue === 'fixed-uuid-3');

if (fail) { console.error('\n❌ usageSessionId初期化テスト不合格'); process.exit(1); }
console.log('\n✅ usageSessionId初期化テスト合格');
