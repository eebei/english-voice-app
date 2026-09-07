// 変異試験ランナー（tools/mutate.js）の独立反例 — A-8 ＋ 2026-09-06 Codex 差戻し条件
//
// ★このテストの要点は「ランナーが緑を出すこと」ではなく、
//   **壊れた使い方をした時に、黙って通さず、必ず元へ戻すこと**である。
//
// ★2026-09-06 第2次差戻し：当方は「同期ループの中で非同期の事象を待つ」を**4回**やった。
//     1. ランナー本体が `spawnSync` で event loop を塞ぎ、シグナル復元経路を通していなかった
//     2. ハーネスが busy-wait で子の `'exit'` を受け取れず「終了しない」と誤判定した
//     3. SIGKILL 後の lock 残留を「ゾンビ判定」で解けると仮定し、終了遷移との race を待たなかった
//     4. `execSync('sleep')` / `spawnSync('ps')` の busy polling を残し、**独立実行で 56/60・55/60**
//        と件数まで揺れた（当方環境では 60/60 に見えていた）
//   したがってこのファイルは**全体を async にし、子は必ず `close` を待ってから**
//   hash・lock・journal・backup を判定する。**終了前の瞬間値を合否に使わない。**

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { once } = require('events');

const ROOT = __dirname;
const TARGET = 'fixtures/mutate-selftest/target.js';
const TARGET_ABS = path.join(ROOT, TARGET);
const TMP = path.join(ROOT, 'fixtures', 'mutate-selftest');
const RUNS = path.join(TMP, 'runs.log');
const LOCK = path.join(ROOT, '.mutate.selftest.lock');
const JOURNAL = path.join(ROOT, '.mutate.selftest.journal.json');
const BACKUP = path.join(ROOT, '.mutate.selftest.backup');

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; return true; }
  failures.push(name + (detail ? '\n     ' + detail : ''));
  return false;
}
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const delay = ms => new Promise(r => setTimeout(r, ms));
const backupCount = () => (fs.existsSync(BACKUP) ? fs.readdirSync(BACKUP).length : 0);
const residueClean = () => !fs.existsSync(LOCK) && !fs.existsSync(JOURNAL) && backupCount() === 0;

const CANON = "// 変異ランナー自己検査用の的。製品コードではない。\n"
  + "module.exports = { flag: 'GOOD', unchecked: 'IGNORED', twice_a: 'DUP', twice_b: 'DUP' };\n";
function resetWorld() {
  fs.writeFileSync(TARGET_ABS, CANON);
  for (const p of [LOCK, JOURNAL]) { try { fs.unlinkSync(p); } catch (e) {} }
  try { fs.rmSync(BACKUP, { recursive: true, force: true }); } catch (e) {}
  fs.writeFileSync(RUNS, '');
}
resetWorld();
const GOOD = sha(TARGET_ABS);
const runCount = () => (fs.existsSync(RUNS)
  ? fs.readFileSync(RUNS, 'utf8').split('\n').filter(Boolean).length : 0);

function writeDefs(name, defs) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, JSON.stringify(defs, null, 2));
  return path.relative(ROOT, p);
}
const ENV = { ...process.env, MUTATE_LOCK_FILE: '.mutate.selftest.lock' };

/** ランナーを起動し、**close を待って**から結果を返す。 */
async function run(defsRel, extra) {
  const args = [path.join(ROOT, 'tools/mutate.js'), defsRel];
  if (extra) args.push(...extra);
  else args.push('--json', 'fixtures/mutate-selftest/out.json');
  const child = spawn(process.execPath, args,
    { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', b => { out += b; });
  child.stderr.on('data', b => { out += b; });
  const [status] = await once(child, 'close');
  let report = null;
  try { report = JSON.parse(fs.readFileSync(path.join(TMP, 'out.json'), 'utf8')); } catch (e) {}
  return { status, out, report };
}

/** 変異が当たる（flag が BAD になる）まで**非同期で**待つ。 */
async function waitMutated(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    let cur = ''; try { cur = fs.readFileSync(TARGET_ABS, 'utf8'); } catch (e) {}
    if (cur.includes("flag: 'BAD'")) return true;
    await delay(40);
  }
  return false;
}

function startSlow(defsRel) {
  return spawn(process.execPath, [path.join(ROOT, 'tools/mutate.js'), defsRel],
    { cwd: ROOT, env: ENV, stdio: 'ignore' });
}

const ok = (id, why, from, to, tests) => ({ id, why, file: TARGET, from, to, expect_red: tests });
const FAST = ['tests-mutate-selftest.js'];
const SLOW = ['tests-mutate-selftest-slow.js'];

async function main() {
  // ── 1. 正しい変異は検出され、残差を残さない ─────────────────────────
  {
    const r = await run(writeDefs('d-detect.json',
      [ok('D1', '的の flag を壊す', "flag: 'GOOD'", "flag: 'BAD'", FAST)]));
    check('正しい変異を検出する', r.status === 0 && r.report
      && r.report.summary.detected === 1 && r.report.summary.survived === 0,
      JSON.stringify(r.report && r.report.summary));
    check('検出後もファイルは byte 一致で戻る', sha(TARGET_ABS) === GOOD);
    check('正常終了後に lock / journal / backup の残差が無い', residueClean(),
      `lock=${fs.existsSync(LOCK)} journal=${fs.existsSync(JOURNAL)} backup=${backupCount()}`);
  }

  // ── 2. ★P1-2：壊れた定義は**テストを1回も実行せず**に停止する ──────────
  for (const [label, defs] of [
    ['有効変異 → 0件変異', [
      ok('V1', '有効', "flag: 'GOOD'", "flag: 'BAD'", FAST),
      ok('Z1', '存在しない文字列', "flag: 'NOPE'", "flag: 'BAD'", FAST)]],
    ['0件変異 → 有効変異', [
      ok('Z2', '存在しない文字列', "flag: 'NOPE'", "flag: 'BAD'", FAST),
      ok('V2', '有効', "flag: 'GOOD'", "flag: 'BAD'", FAST)]],
    ['有効変異 → 複数件変異', [
      ok('V3', '有効', "flag: 'GOOD'", "flag: 'BAD'", FAST),
      ok('M1', '2箇所に一致', "'DUP'", "'CHANGED'", FAST)]],
  ]) {
    fs.writeFileSync(RUNS, '');
    const before = sha(TARGET_ABS);
    const r = await run(writeDefs('d-pre.json', defs));
    check(`事前検証で停止する：${label}`, r.status === 1 && /一致が \d+ 件/.test(r.out),
      r.out.slice(0, 200));
    check(`テストを1回も実行していない：${label}`, runCount() === 0, `実行回数=${runCount()}`);
    check(`ファイル無傷：${label}`, sha(TARGET_ABS) === before);
  }

  // ── 3. 生存変異 ────────────────────────────────────────────────────
  {
    const r = await run(writeDefs('d-survive.json',
      [ok('S1', 'テストが見ていない値を変える', "unchecked: 'IGNORED'", "unchecked: 'CHANGED'", FAST)]));
    check('生存変異は exit 1', r.status === 1 && r.report && r.report.summary.survived === 1,
      JSON.stringify(r.report && r.report.summary));
    check('生存でもファイルは無傷', sha(TARGET_ABS) === GOOD);
  }

  // ── 4. 起動不能を「検出」と数えない ────────────────────────────────
  {
    const r = await run(writeDefs('d-broken.json',
      [ok('B1', '起動できないテストを指定', "flag: 'GOOD'", "flag: 'BAD'",
        ['tests-mutate-selftest-broken.js'])]));
    check('起動不能なテストでは基準確認で止まる', r.status === 1 && /実行できない/.test(r.out),
      r.out.slice(0, 200));
    check('起動不能でもファイルは無傷', sha(TARGET_ABS) === GOOD);
  }

  // ── 5. 基準が赤いまま変異を回さない ─────────────────────────────────
  {
    fs.writeFileSync(TARGET_ABS, CANON.replace("flag: 'GOOD'", "flag: 'BROKEN'"));
    const r = await run(writeDefs('d-redbase.json',
      [ok('R1', '基準が赤い状態', "unchecked: 'IGNORED'", "unchecked: 'X'", FAST)]));
    check('基準が赤なら変異を実行しない', r.status === 1 && /変異前から赤/.test(r.out),
      r.out.slice(0, 200));
    fs.writeFileSync(TARGET_ABS, CANON);
    check('基準赤の後もファイルを壊さない', sha(TARGET_ABS) === GOOD);
  }

  // ── 6. 競合定義・定義不正 ─────────────────────────────────────────
  {
    const r = await run(writeDefs('d-conflict.json', [
      ok('C1', '広い範囲', "flag: 'GOOD', unchecked", "flag: 'BAD', unchecked", FAST),
      ok('C2', 'その内側', "flag: 'GOOD'", "flag: 'BAD'", FAST),
    ]));
    check('競合定義は適用前に拒否する', r.status === 1 && /競合/.test(r.out), r.out.slice(0, 200));

    for (const [label, def, want] of [
      ['to が from と同一', ok('X1', 'w', "flag: 'GOOD'", "flag: 'GOOD'", FAST), /変異になっていない/],
      ['from が空', ok('X2', 'w', '', 'x', FAST), /from が空/],
      ['expect_red が空', { id: 'X3', why: 'w', file: TARGET, from: "flag: 'GOOD'", to: 'x', expect_red: [] }, /expect_red/],
      ['repo外パス', { id: 'X4', why: 'w', file: '../../etc/hosts', from: 'a', to: 'b', expect_red: FAST }, /repo 外/],
      ['許可されていないテスト', { id: 'X5', why: 'w', file: TARGET, from: "flag: 'GOOD'", to: 'x', expect_red: ['rm-rf.js'] }, /許可されていない/],
      ['why が無い', { id: 'X6', file: TARGET, from: "flag: 'GOOD'", to: 'x', expect_red: FAST }, /why/],
    ]) {
      const r2 = await run(writeDefs('d-invalid.json', [def]));
      check(`不正な定義を拒否：${label}`, r2.status === 1 && want.test(r2.out), r2.out.slice(0, 160));
    }
    check('不正定義の後もファイルは無傷', sha(TARGET_ABS) === GOOD);
  }

  // ── 7. `--json` の出力先を repo 外にできない ───────────────────────
  {
    const r = await run(writeDefs('d-json.json', [ok('J1', 'w', "flag: 'GOOD'", "flag: 'BAD'", FAST)]),
      ['--json', '../../tmp/evil.json']);
    check('--json の repo 外書き込みを拒否する', r.status === 1 && /repo 外/.test(r.out),
      r.out.slice(0, 160));
    check('拒否後もファイルは無傷', sha(TARGET_ABS) === GOOD);
  }

  // ── 8. dirty file（未commit差分を保持する）─────────────────────────
  {
    const dirty = CANON.replace("unchecked: 'IGNORED'", "unchecked: 'DIRTY'");
    fs.writeFileSync(TARGET_ABS, dirty);
    const dirtySha = sha(TARGET_ABS);
    const r = await run(writeDefs('d-dirty.json',
      [ok('DD1', 'dirty のまま変異', "flag: 'GOOD'", "flag: 'BAD'", FAST)]));
    check('dirty file でも動く', r.status === 0 && r.report && r.report.summary.detected === 1,
      JSON.stringify(r.report && r.report.summary));
    check('未commit差分をそのまま戻す（git restore していない）', sha(TARGET_ABS) === dirtySha);
    fs.writeFileSync(TARGET_ABS, CANON);
  }

  // ── 9. ★P1-1a：SIGINT / SIGTERM / SIGHUP は**次回起動なしで**復元する ──
  //   **close を待ってから**判定する。終了前の瞬間値は合否に使わない。
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    resetWorld();
    const child = startSlow(writeDefs('d-sig.json',
      [ok('SG1', '長いテストの最中に ' + sig, "flag: 'GOOD'", "flag: 'BAD'", SLOW)]));
    const closed = once(child, 'close');
    const sent = await waitMutated(20000);
    check(`${sig}: 送信前に変異が当たっていた（前提）`, sent, '変異を観測できなかった');
    child.kill(sig);
    const res = await Promise.race([closed.then(() => 'closed'), delay(15000).then(() => 'timeout')]);
    check(`${sig}: 規定時間内に終了する`, res === 'closed', '終了しない＝event loop が塞がれている');
    if (res === 'closed') {
      check(`${sig}: 次回起動なしで byte 一致に戻る`, sha(TARGET_ABS) === GOOD,
        fs.readFileSync(TARGET_ABS, 'utf8'));
      check(`${sig}: lock / journal / backup の残差なし`, residueClean(),
        `lock=${fs.existsSync(LOCK)} journal=${fs.existsSync(JOURNAL)} backup=${backupCount()}`);
    } else {
      try { child.kill('SIGKILL'); await closed; } catch (e) {}
      failures.push(`${sig}: 終了しなかったため残差検査を実施できない`);
      failures.push(`${sig}: 同上（byte一致を判定できない）`);
    }
  }

  // ── 10. ★P1-1b：SIGKILL は journal 復旧。3地点を検査する ─────────────
  {
    resetWorld();
    const child = startSlow(writeDefs('d-kill.json',
      [ok('K1', '長いテストの最中に強制終了', "flag: 'GOOD'", "flag: 'BAD'", SLOW)]));
    const closed = once(child, 'close');
    const killed = await waitMutated(20000);
    check('SIGKILL: 送信前に変異が当たっていた（前提）', killed);
    child.kill('SIGKILL');

    // 地点①：強制終了直後。「変異が残る」という前提の確認のみ。
    check('地点① 強制終了直後は変異が残る（journal が要る理由）',
      fs.readFileSync(TARGET_ABS, 'utf8').includes("flag: 'BAD'"));

    // ★race 反例：終了遷移中に**即**再起動する。busy を返すか、死亡確認のうえ引き継ぐ。
    const race = await run(writeDefs('d-race.json',
      [ok('RC1', 'race', "flag: 'GOOD'", "flag: 'BAD'", FAST)]));
    const wasBusy = race.status === 1 && /実行中/.test(race.out);
    check('race: 生きて見える lock を奪わないか、奪うなら死亡確認を伴う',
      wasBusy || /死んだ lock|前回の中断を復旧/.test(race.out), race.out.slice(0, 200));

    // ★元 child の close を待ってから、**新しいプロセスで再試行**する（Codex 条件2）
    await closed;
    check('SIGKILL: 子の close を待てた', true);
    check('地点② close 後に復旧材料（journal か復旧済み）が揃っている',
      fs.existsSync(JOURNAL) || sha(TARGET_ABS) === GOOD,
      `journal=${fs.existsSync(JOURNAL)} sha一致=${sha(TARGET_ABS) === GOOD}`);

    const after = await run(writeDefs('d-after-kill.json',
      [ok('K2', '復旧後に普通の変異', "flag: 'GOOD'", "flag: 'BAD'", FAST)]));
    check('地点② 復旧するか、既に復旧済みで正常動作する',
      /前回の中断を復旧/.test(after.out) || after.status === 0, after.out.slice(0, 200));
    check('地点③ 再実行後は byte 一致', sha(TARGET_ABS) === GOOD,
      fs.readFileSync(TARGET_ABS, 'utf8'));
    check('地点③ 残差0', residueClean(),
      `lock=${fs.existsSync(LOCK)} journal=${fs.existsSync(JOURNAL)} backup=${backupCount()}`);
    check('地点③ その回の変異も正しく検出する',
      after.status === 0 && after.report && after.report.summary.detected === 1,
      JSON.stringify(after.report && after.report.summary));
  }

  // ── 11. lock：生きている holder からは奪わない ─────────────────────
  {
    resetWorld();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: 'now' }));
    const r = await run(writeDefs('d-lock.json', [ok('L1', 'w', "flag: 'GOOD'", "flag: 'BAD'", FAST)]));
    check('生きている lock 中は起動を拒否する', r.status === 1 && /実行中/.test(r.out),
      r.out.slice(0, 160));
    check('拒否時に他プロセスの lock を消さない', fs.existsSync(LOCK));
    check('拒否時はファイルも無傷', sha(TARGET_ABS) === GOOD);

    // ★実行中に lock を横取りされても、他プロセスの lock を消して帰らない。
    resetWorld();
    const child = startSlow(writeDefs('d-steal.json',
      [ok('ST1', '実行中に lock を横取りされる', "flag: 'GOOD'", "flag: 'BAD'", SLOW)]));
    const closed = once(child, 'close');
    const swapped = await waitMutated(20000);
    check('横取り: 変異中に差し替える瞬間を捉えた（前提）', swapped);
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: 'stolen' }));
    await closed;                                  // ★close を待ってから判定する
    check('横取り: 他プロセスの lock を消さずに終わる', fs.existsSync(LOCK),
      '自分のものでない lock を削除した');
    let held = null;
    try { held = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch (e) {}
    check('横取り: lock の中身も書き換えない', held && held.pid === process.pid,
      JSON.stringify(held));
    check('横取り: それでも対象ファイルは復元されている', sha(TARGET_ABS) === GOOD,
      fs.readFileSync(TARGET_ABS, 'utf8'));

    resetWorld();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, at: 'now' }));
    const r2 = await run(writeDefs('d-deadlock.json', [ok('L2', 'w', "flag: 'GOOD'", "flag: 'BAD'", FAST)]));
    check('死んだ lock は引き継いで実行する', r2.status === 0 && /死んだ lock/.test(r2.out),
      r2.out.slice(0, 200));
    check('引き継ぎ後も残差なし', residueClean());
  }

  // 後片付け（★判定は全て上で終わっている。ここで赤を隠さない）
  resetWorld();
  for (const f of fs.readdirSync(TMP)) {
    if (/^d-.*\.json$|^out\.json$|^runs\.log$/.test(f)) {
      try { fs.unlinkSync(path.join(TMP, f)); } catch (e) {}
    }
  }

  const total = pass + failures.length;
  for (const f of failures) console.error('  ❌ ' + f);
  console.log(`[mutate runner selftest] 合格 ${pass} / 不合格 ${failures.length}（実行 ${total}）`);
  if (failures.length) process.exit(1);
}

main().catch(e => { console.error('❌ ハーネス例外: ' + (e && e.stack || e)); process.exit(2); });
