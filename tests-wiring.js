// 配線 lint（tools/wiring-lint.js）の自己検査 — 受入条件 B-6・B-7
//
// ★B-6：正常系＋未配線function＋未load module＋test-only call の fixture を持ち、
//        **各々が期待どおりの件数と exit code になる**ことを確認する。
//        偽陽性を隠すための fixture 削除は禁止。
// ★B-7：決定的であること（同じ入力で同じ結果）。exit 0/1 を契約化する。
//        fixture は Build 298 の実欠陥（実切断 reset・未load module・未配線function）を使う。
//
// fixture は `fixtures/wiring/<case>/{base,head}`。git を使わず `--fs-base` で比較する
// （lint 自身の git 依存を検査から外し、決定的にするため）。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const LINT = path.join(ROOT, 'tools/wiring-lint.js');
const CASES = path.join(ROOT, 'fixtures/wiring');

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; return true; }
  failures.push(name + (detail ? '\n     ' + detail : ''));
  return false;
}

function runCase(name) {
  const head = path.join(CASES, name, 'head');
  const base = path.join(CASES, name, 'base');
  const out = path.join(CASES, name, 'head', 'out.json');
  const r = spawnSync(process.execPath, [LINT, '--fs-base', base, '--json', 'out.json'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, WIRING_ROOT: head } });
  let report = null;
  try { report = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) {}
  return { status: r.status, out: String(r.stdout || '') + String(r.stderr || ''), report };
}

// ── 期待値。**件数まで固定する**（「赤になった」だけでは中身を証明しない）───────
const EXPECT = [
  // ★対象件数の根拠：fixture では renderer.html の `handleTelemetry` 行に呼出しを足しているため、
  //   **その行が変更行になり `handleTelemetry` も新規/変更 symbol として対象に入る**。
  //   これは仕様どおり（変更した配線を検査する道具なので、変更行の関数は対象）。
  { name: 'ok-wired',          status: 0, symbols: 4, findings: 0,
    why: 'observeThing・helperThing・handleTelemetry・module が全て到達可能' },
  { name: 'unwired-function',  status: 1, symbols: 4, findings: 1,
    why: '定義だけで誰も呼ばない neverCalled が1件' },
  { name: 'unloaded-module',   status: 1, symbols: 2, findings: 2,
    why: 'renderer は無変更なので対象は module と observeThing の2件。<script src> が無く両方赤' },
  { name: 'test-only-call',    status: 1, symbols: 4, findings: 1,
    why: 'onlyFromTest はテストからしか呼ばれない＝配線と数えない' },
  { name: 'disconnect-reset',  status: 1, symbols: 4, findings: 1,
    why: 'Build 298 の実欠陥：resetPitStateObservation を定義したが製品から呼んでいない' },
];

for (const e of EXPECT) {
  const r = runCase(e.name);
  check(`${e.name}: exit ${e.status}（${e.why}）`, r.status === e.status,
    `exit=${r.status} out=${r.out.slice(0, 200)}`);
  check(`${e.name}: 対象 ${e.symbols} 件`, r.report && r.report.symbols === e.symbols,
    `symbols=${r.report && r.report.symbols}`);
  check(`${e.name}: 未配線 ${e.findings} 件`, r.report && r.report.findings.length === e.findings,
    JSON.stringify(r.report && r.report.findings.map(f => f.name + ':' + f.why)));
}

// ── B-7 決定性：同じ入力を3回。結果が一致すること ─────────────────────
{
  const runs = [runCase('unwired-function'), runCase('unwired-function'), runCase('unwired-function')];
  const key = r => `${r.status}|${r.report && r.report.symbols}|${r.report && r.report.findings.length}`;
  check('決定的：同じ入力で3回とも同じ結果', new Set(runs.map(key)).size === 1,
    JSON.stringify(runs.map(key)));
}

// ── allow list の規律（B-5）────────────────────────────────────────
{
  const allowPath = path.join(ROOT, 'fixtures/wiring/unwired-function/head/wiring-allow.json');
  const write = v => fs.writeFileSync(allowPath, JSON.stringify(v, null, 2));
  const cases = [
    ['理由が legacy だけ', [{ symbol: 'neverCalled', reason: 'legacy', owner: 'x', kind: 'future', evidence: 'e', expires: '2099-01-01' }]],
    ['glob', [{ symbol: 'never*', reason: 'r', owner: 'x', kind: 'future', evidence: 'e', expires: '2099-01-01' }]],
    ['期限も再評価条件も無い', [{ symbol: 'neverCalled', reason: 'r', owner: 'x', kind: 'future', evidence: 'e' }]],
    ['期限切れ', [{ symbol: 'neverCalled', reason: 'r', owner: 'x', kind: 'future', evidence: 'e', expires: '2020-01-01' }]],
    ['owner 欠落', [{ symbol: 'neverCalled', reason: 'r', kind: 'future', evidence: 'e', expires: '2099-01-01' }]],
  ];
  for (const [label, v] of cases) {
    write(v);
    const r = runCase('unwired-function');
    check(`allow 不備を拒否：${label}`, r.status === 1
      && r.report && r.report.allow_errors.length > 0,
      JSON.stringify(r.report && r.report.allow_errors));
  }
  // 正しい allow は通る（ただし対象は除外され、findings が減る）
  write([{ symbol: 'neverCalled', reason: '2027年の別機能で使う予定', owner: 'Claude Code',
    kind: 'future', evidence: 'review/… の設計節', expires: '2099-01-01' }]);
  const okRun = runCase('unwired-function');
  check('正しい allow は受け付けて対象から外す',
    okRun.status === 0 && okRun.report && okRun.report.findings.length === 0
    && okRun.report.allow_errors.length === 0,
    `exit=${okRun.status} findings=${JSON.stringify(okRun.report && okRun.report.findings)}`);
  fs.unlinkSync(allowPath);
}

// ── 静的検査外の記録（B-7）────────────────────────────────────────
{
  const r = runCase('ok-wired');
  const limits = (r.report && r.report.static_analysis_limits) || [];
  check('静的検査外の限界を記録している', limits.length >= 3, JSON.stringify(limits));
  check('限界の記載が実装（呼出しグラフ）と整合している',
    limits.some(l => /囲む名前つき関数/.test(l)) && !limits.some(l => /80行/.test(l)),
    JSON.stringify(limits));
}

// 後片付け
for (const e of EXPECT) {
  const out = path.join(CASES, e.name, 'head', 'out.json');
  try { fs.unlinkSync(out); } catch (err) {}
}

const total = pass + failures.length;
for (const f of failures) console.error('  ❌ ' + f);
console.log(`[wiring lint selftest] 合格 ${pass} / 不合格 ${failures.length}（実行 ${total}）`);
if (failures.length) process.exit(1);
