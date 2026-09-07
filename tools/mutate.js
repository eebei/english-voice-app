#!/usr/bin/env node
'use strict';
// 変異試験ランナー
//
// なぜ要るか（2026-09-06）:
//   当方は変異を手で置換していた。**置換が当たらなくても「検出できず」に見える**。
//   Build 298 の作業中に2回起きた。9/3 には**基準が赤いまま変異を回して全検出に見せた**。
//   受入条件は共有MDの Codex 記載（A-1〜A-8 ＋ 2026-09-06 の差戻し条件）を正本とする。
//
// ★2026-09-06 Codex 差戻しを反映した設計:
//   - テストは **spawn（非同期）** で回す。`spawnSync` は event loop を塞ぎ、
//     シグナルハンドラがその場で動かない＝「SIGINT で復元」が成立していなかった。
//   - 定義の**事前一括検証**。1件でも壊れていたら baseline もテストも一切実行しない。
//   - 生きている lock は**奪わない**。journal があるだけでは奪取の理由にしない。
//   - 正常終了後に lock / journal / backup の残差を残さない。
//
// 使い方: node tools/mutate.js mutations/<slice>.json [--json <out>]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOCK = path.join(ROOT, process.env.MUTATE_LOCK_FILE || '.mutate.lock');
const JOURNAL = LOCK.replace(/\.lock$/, '') + '.journal.json';
const BACKUP_DIR = LOCK.replace(/\.lock$/, '') + '.backup';

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// ── 復元台帳 ──────────────────────────────────────────────────────
const backups = new Map();          // absPath -> Buffer
let restoreFailures = [];
let lockOwned = false;
let activeChild = null;
let finished = false;

function snapshot(abs) { if (!backups.has(abs)) backups.set(abs, fs.readFileSync(abs)); }

function restoreAll() {
  for (const [abs, buf] of backups) {
    try {
      fs.writeFileSync(abs, buf);
      if (sha256(fs.readFileSync(abs)) !== sha256(buf)) restoreFailures.push(abs);
    } catch (e) { restoreFailures.push(abs + ': ' + e.message); }
  }
}

// lock は**自分が所有していると確認できた時だけ**消す。
// 獲得前の例外やシグナルで他プロセスの lock を消さない。
function releaseLock() {
  if (!lockOwned) return;
  try {
    const held = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (held && held.pid === process.pid) fs.unlinkSync(LOCK);
  } catch (e) { /* 既に無い／壊れている場合は触らない */ }
  lockOwned = false;
}

function bailout(reason, code) {
  if (finished) return;
  finished = true;
  if (activeChild) { try { activeChild.kill('SIGKILL'); } catch (e) {} }
  restoreAll();
  journalEnd();
  releaseLock();
  if (restoreFailures.length) {
    process.stderr.write('❌ 復元失敗: ' + restoreFailures.join(', ') + '\n');
    process.exit(2);
  }
  if (reason) process.stderr.write(reason + '\n');
  process.exit(code === undefined ? 1 : code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => bailout('中断されました。対象ファイルは復元済みです。', 130));
}
process.on('uncaughtException', e => bailout('例外: ' + (e && e.stack || e), 2));
process.on('unhandledRejection', e => bailout('未処理のreject: ' + e, 2));

// ── 復旧ジャーナル（SIGKILL・電源断で handler が動かない場合の保険）──────
function journalBegin(abs, buf) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const bak = path.join(BACKUP_DIR, sha256(buf) + '.bak');
  fs.writeFileSync(bak, buf);
  fs.writeFileSync(JOURNAL, JSON.stringify({ file: abs, backup: bak, sha: sha256(buf) }));
}
function journalEnd() {
  let bak = null;
  try { bak = JSON.parse(fs.readFileSync(JOURNAL, 'utf8')).backup; } catch (e) {}
  try { fs.unlinkSync(JOURNAL); } catch (e) {}
  // P2：backup を残し続けない。journal を消した後の bak は誰も参照しない。
  if (bak) { try { fs.unlinkSync(bak); } catch (e) {} }
  try { if (!fs.readdirSync(BACKUP_DIR).length) fs.rmdirSync(BACKUP_DIR); } catch (e) {}
}
function recoverFromJournal() {
  let j;
  try { j = JSON.parse(fs.readFileSync(JOURNAL, 'utf8')); } catch (e) { return null; }
  try {
    const buf = fs.readFileSync(j.backup);
    if (sha256(buf) !== j.sha) return { file: j.file, ok: false, why: 'backup 破損' };
    fs.writeFileSync(j.file, buf);
    const ok = sha256(fs.readFileSync(j.file)) === j.sha;
    if (ok) journalEnd();
    return { file: j.file, ok };
  } catch (e) { return { file: j.file, ok: false, why: e.message }; }
}

// ── lock ──────────────────────────────────────────────────────────
function holderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
  if (!alive) return false;
  // ゾンビは lock を保持し続けられない。ただし**終了遷移中との race** があるので、
  // 「ゾンビと確認できた時だけ」死と扱う。判定できなければ生存側へ倒す（奪わない）。
  try {
    const st = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout || '';
    if (/^\s*Z/.test(st)) return false;
  } catch (e) { /* ps が無ければ生存扱い */ }
  return true;
}

function acquireLock() {
  const mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  try { fs.writeFileSync(LOCK, mine, { flag: 'wx' }); lockOwned = true; return { ok: true }; }
  catch (e) { /* 既にある */ }
  let held = null;
  try { held = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch (e) {}
  const pid = held && held.pid;
  if (holderAlive(pid)) return { ok: false, busy: true, pid };
  // 死んでいると**確認できた**時だけ引き継ぐ。journal の有無は理由にしない。
  try { fs.writeFileSync(LOCK, mine); lockOwned = true; return { ok: true, tookOver: pid }; }
  catch (e) { return { ok: false, busy: true, pid }; }
}

// ── 検証 ──────────────────────────────────────────────────────────
function insideRepo(rel) {
  const abs = path.resolve(ROOT, rel);
  const r = path.relative(ROOT, abs);
  return (!r.startsWith('..') && !path.isAbsolute(r) && !r.split(path.sep).includes('.git'))
    ? abs : null;
}
const TEST_NAME = /^tests-[A-Za-z0-9._-]+\.js$/;

/** 定義を**全件**検証する。1件でも壊れていたら何も実行しない（A-1・P1-2）。 */
function validateAll(defs) {
  const errors = [];
  const seen = new Set();
  const byFile = new Map();
  for (const d of defs) {
    const id = (d && d.id) || '(id無し)';
    if (!d || typeof d.id !== 'string' || !d.id) { errors.push('id が無い定義がある'); continue; }
    if (seen.has(d.id)) errors.push(`${id}: id が重複している`);
    seen.add(d.id);
    if (!d.why || typeof d.why !== 'string') errors.push(`${id}: why が無い`);
    if (typeof d.from !== 'string' || d.from === '') { errors.push(`${id}: from が空`); continue; }
    if (typeof d.to !== 'string') { errors.push(`${id}: to が文字列でない`); continue; }
    if (d.to === d.from) errors.push(`${id}: to が from と同一＝変異になっていない`);
    if (/^\/.*\/[gimsuy]*$/.test(d.from)) errors.push(`${id}: from は literal のみ。正規表現は禁止`);
    const abs = insideRepo(d.file || '');
    if (!abs) { errors.push(`${id}: file が repo 外か .git 配下: ${d.file}`); continue; }
    if (!fs.existsSync(abs)) { errors.push(`${id}: file が存在しない: ${d.file}`); continue; }
    d._abs = abs;
    d._tests = [];
    if (!Array.isArray(d.expect_red) || !d.expect_red.length) {
      errors.push(`${id}: expect_red は1件以上必須`);
    } else {
      for (const t of d.expect_red) {
        if (typeof t !== 'string' || !TEST_NAME.test(t) || !fs.existsSync(path.join(ROOT, t)))
          errors.push(`${id}: expect_red に許可されていないテスト: ${t}`);
        else d._tests.push(t);
      }
    }
    // ★出現件数は**ここで**数える。適用ループまで遅らせると、壊れた定義より前にある
    //   変異とテストを実行してしまい「変異未実行のまま停止」にならない（Codex P1-2）。
    const src = fs.readFileSync(abs, 'utf8');
    const count = src.split(d.from).length - 1;
    d._count = count;
    if (count !== 1) errors.push(`${id}: from の一致が ${count} 件（1件でなければ実行しない）`);
    const list = byFile.get(abs) || [];
    for (const prev of list) {
      if (prev.from === d.from) errors.push(`${id}: ${prev.id} と同一の from を指している`);
      else if (prev.from.includes(d.from) || d.from.includes(prev.from))
        errors.push(`${id}: ${prev.id} と適用範囲が競合している（from が包含関係）`);
    }
    list.push({ id: d.id, from: d.from });
    byFile.set(abs, list);
  }
  return errors;
}

// ── テスト実行（非同期。シグナルを塞がない）────────────────────────────
function runTest(name) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, name)],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    let out = '';
    child.stdout.on('data', b => { out += b; });
    child.stderr.on('data', b => { out += b; });
    child.on('error', e => {
      activeChild = null;
      resolve({ ok: false, usable: false, why: 'spawn: ' + e.message, out });
    });
    child.on('close', (code, signal) => {
      activeChild = null;
      if (signal) return resolve({ ok: false, usable: false, why: 'signal ' + signal, out });
      if (/Cannot find module|SyntaxError|MODULE_NOT_FOUND/.test(out) && code !== 0)
        return resolve({ ok: false, usable: false, why: 'runner 起動不能', out });
      resolve({ ok: code === 0, usable: true, status: code, out });
    });
  });
}

// ── 本体 ────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const defPath = args[0];
  if (!defPath) {
    process.stderr.write('使い方: node tools/mutate.js mutations/<slice>.json [--json <out>]\n');
    process.exit(1);
  }
  const jsonIdx = args.indexOf('--json');
  let jsonOut = null;
  if (jsonIdx >= 0) {
    jsonOut = insideRepo(args[jsonIdx + 1] || '');
    if (!jsonOut) { process.stderr.write('❌ --json の出力先が repo 外\n'); process.exit(1); }
  }

  const lock = acquireLock();
  if (!lock.ok) {
    process.stderr.write(`❌ 別の mutate が実行中（pid ${lock.pid}）\n`);
    process.exit(1);
  }
  if (lock.tookOver) console.log(`  ↩ 死んだ lock を引き継ぐ（pid ${lock.tookOver}）`);

  const recovered = recoverFromJournal();
  if (recovered) {
    console.log(`  ↩ 前回の中断を復旧: ${path.relative(ROOT, recovered.file)}`
      + (recovered.ok ? '' : ` ❌ ${recovered.why || '復元失敗'}`));
    if (!recovered.ok) { releaseLock(); process.exit(2); }
  }

  let defs;
  const defAbs = insideRepo(defPath);
  if (!defAbs) bailout('❌ 定義ファイルが repo 外', 1);
  try { defs = JSON.parse(fs.readFileSync(defAbs, 'utf8')); }
  catch (e) { bailout('❌ 定義ファイルを読めない/JSONでない: ' + e.message, 1); }
  if (!Array.isArray(defs) || !defs.length) bailout('❌ 定義は1件以上の配列であること', 1);

  // ★事前一括検証。ここで落ちたら baseline も変異もテストも**一切実行しない**。
  const errors = validateAll(defs);
  if (errors.length) {
    for (const e of errors) process.stderr.write('❌ ' + e + '\n');
    process.stderr.write('  変異は1件も実行していない（ファイルは無傷）\n');
    releaseLock();
    process.exit(1);
  }

  const baselineTests = [...new Set(defs.flatMap(d => d._tests))];
  const baseline = {};
  for (const t of baselineTests) {
    const r = await runTest(t);
    baseline[t] = { ok: r.ok, usable: r.usable };
    if (!r.usable) bailout(`❌ 基準確認: ${t} を実行できない（${r.why}）`, 1);
    if (!r.ok) bailout(`❌ 基準確認: ${t} が変異前から赤。先に直すこと`, 1);
  }

  const results = [];
  for (const d of defs) {
    const abs = d._abs;
    snapshot(abs);
    const before = fs.readFileSync(abs);
    const src = before.toString('utf8');
    journalBegin(abs, before);
    fs.writeFileSync(abs, Buffer.from(src.replace(d.from, d.to), 'utf8'));
    const after = fs.readFileSync(abs);

    const perTest = [];
    let detected = false, unusable = null;
    for (const t of d._tests) {
      const r = await runTest(t);
      if (!r.usable) { unusable = `${t}: ${r.why}`; break; }
      perTest.push({ test: t, red: !r.ok });
      if (!r.ok) detected = true;
    }

    fs.writeFileSync(abs, before);
    const restored = sha256(fs.readFileSync(abs)) === sha256(before);
    if (restored) journalEnd(); else restoreFailures.push(abs);

    results.push({
      id: d.id, file: d.file, why: d.why, applied: true, occurrences: d._count,
      bytes_before: before.length, bytes_after: after.length,
      sha_before: sha256(before), sha_after: sha256(after),
      tests: perTest,
      outcome: unusable ? 'unusable' : (detected ? 'detected' : 'survived'),
      unusable_reason: unusable || undefined,
      restored,
    });
  }

  restoreAll();
  const recheck = {};
  let recheckOk = true;
  for (const t of baselineTests) {
    const r = await runTest(t);
    recheck[t] = { ok: r.ok, usable: r.usable };
    if (!r.ok || !r.usable) recheckOk = false;
  }

  journalEnd();
  const residue = {
    journal: fs.existsSync(JOURNAL),
    backup_files: fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).length : 0,
  };

  const summary = {
    defined: defs.length,
    applied: results.filter(r => r.applied).length,
    detected: results.filter(r => r.outcome === 'detected').length,
    survived: results.filter(r => r.outcome === 'survived').length,
    unusable: results.filter(r => r.outcome === 'unusable').length,
    restore_failures: restoreFailures.length,
    baseline_green: Object.values(baseline).every(b => b.ok),
    recheck_green: recheckOk,
    residue_backup_files: residue.backup_files,
    residue_journal: residue.journal,
  };
  const report = { summary, baseline, results, recheck, residue };
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));

  for (const r of results) {
    const mark = r.outcome === 'detected' ? '✅'
      : r.outcome === 'survived' ? '❌ 生存' : '❌ 実行不能';
    console.log(`  ${mark}  ${r.id}  ${r.why}`);
    if (r.outcome === 'unusable') console.log(`         ${r.unusable_reason}`);
  }
  console.log(`[mutate] 定義 ${summary.defined} / 適用 ${summary.applied} / 検出 ${summary.detected}`
    + ` / 生存 ${summary.survived} / 実行不能 ${summary.unusable}`
    + ` / 復元失敗 ${summary.restore_failures} / backup残差 ${summary.residue_backup_files}`);
  if (!summary.recheck_green) process.stderr.write('❌ 復元後に対象テストが緑へ戻らない\n');

  finished = true;
  releaseLock();
  const bad = summary.survived || summary.unusable || summary.restore_failures
    || !summary.recheck_green || residue.backup_files || residue.journal;
  process.exit(bad ? 1 : 0);
}

main();
