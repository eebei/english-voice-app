#!/usr/bin/env node
'use strict';
// 配線 lint（B）
//
// なぜ要るか（2026-09-06）:
//   Build 298 の Gate 4 差戻し6件のうち3件は**「動くコードを書いたが、製品から呼ばれていない」**だった。
//     - `answerFuel()` / `restateDriverStrategy()` … 製品呼出し 0件
//     - `observePitState()` … 関数はあるが telemetry 受信経路から呼ばれていない
//     - 実切断分岐の reset … `markTelemetryStale()` にだけ繋ぎ、`iracing_disconnected` は未配線
//     - `session-strategy-state.js` … `<script src>` が無ければ実機で読み込まれない
//   当方はそのたびに個別の配線検査を**後付け**しており、次の新規関数でまた同じ穴が空く。
//
// 何をする道具か（Codex 受入条件 B-1〜B-7）:
//   全 JS の完全な静的解析ではない。**差分で増えた配線の取りこぼしを機械的に止める Gate** である。
//   動的 dispatch・文字列経由の呼出しは静的には追えない。**allow list へ逃がさず「静的検査外」と記録する。**
//
// 使い方: node tools/wiring-lint.js --base <sha> [--json <out>]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ★fixture 用に対象ツリーを差し替えられる。既定は repo ルート。
const ROOT = path.resolve(process.env.WIRING_ROOT || path.join(__dirname, '..'));
const ALLOW = path.join(ROOT, 'wiring-allow.json');

// 製品 runtime。テスト・fixture・review・tools は対象外（B-1）。
const PRODUCT_FILES = [
  'desktop/renderer.html', 'desktop/overlay.html',
  'server.js', 'prompts.js', 'engineer-card.js', 'auth.js',
];
const PRODUCT_DIRS = ['desktop/'];
const isProductJs = rel => PRODUCT_DIRS.some(d => rel.startsWith(d)) && rel.endsWith('.js')
  && !path.basename(rel).startsWith('tests-');
const isProduct = rel => PRODUCT_FILES.includes(rel) || isProductJs(rel);
const isExcluded = rel => rel.startsWith('tests-') || rel.startsWith('fixtures/')
  || rel.startsWith('review/') || rel.startsWith('tools/') || rel.startsWith('mutations/');

// ── コメント・文字列を落とした「実行行」だけを返す ────────────────────
//   B-2：**定義名の文字列出現だけでは合格にしない。** コメント・docs・test の一致を呼出しに数えない。
function codeLines(src) {
  const out = [];
  let inBlock = false;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) { out.push({ n: i + 1, text: '' }); continue; }
      line = line.slice(end + 2); inBlock = false;
    }
    for (;;) {
      const st = line.indexOf('/*');
      if (st < 0) break;
      const en = line.indexOf('*/', st + 2);
      if (en < 0) { line = line.slice(0, st); inBlock = true; break; }
      line = line.slice(0, st) + line.slice(en + 2);
    }
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('<!--')) { out.push({ n: i + 1, text: '' }); continue; }
    const li = line.search(/(^|[^:])\/\//);
    if (li >= 0) line = line.slice(0, line.indexOf('//', li));
    // 文字列リテラルの中身は呼出しではない
    line = line.replace(/'(?:[^'\\]|\\.)*'/g, "''")
               .replace(/"(?:[^"\\]|\\.)*"/g, '""')
               // ★テンプレートリテラルは**丸ごと捨ててはいけない**。`${…}` の中身はコードであり、
               //   そこにある呼出しを消すと、実際に配線されている関数を未配線と誤判定する。
               //   （`formatDuration` が実際にそれで偽陽性になった。router 側の呼出しは全て `${…}` 内）
               //   リテラル部分だけを落とし、補間部分は残す。
               .replace(/`(?:[^`\\]|\\.)*`/g, m => {
                 const parts = [...m.matchAll(/\$\{([^{}]*)\}/g)].map(x => x[1]);
                 return parts.length ? '`' + parts.join(';') + '`' : '``';
               });
    out.push({ n: i + 1, text: line });
  }
  return out;
}

function git(args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }); }
  catch (e) { return null; }
}

/** base..作業ツリー で増えた製品ファイルと追加行を集める（B-1）。
 *  ★未追跡（git add していない）製品ファイルも対象にする。
 *    これが無いと、**実装そのものが未追跡の間は「対象0・exit 0」で緑になる**
 *    （Codex 独立実行で `--base HEAD` が 対象0/合格0/未配線0 を返した）。 */
function changedProduct(base) {
  const names = git(['diff', '--name-only', base, '--']);
  if (names === null) return null;
  const tracked = names.split('\n').map(s => s.trim()).filter(Boolean);
  const untrackedOut = git(['ls-files', '--others', '--exclude-standard']) || '';
  const untracked = untrackedOut.split('\n').map(s => s.trim()).filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])]
    .filter(f => isProduct(f) && !isExcluded(f));
  const added = new Map();          // rel -> Set(追加行の本文)
  const newFiles = [];
  for (const f of files) {
    const isUntracked = untracked.includes(f);
    const set = new Set();
    if (isUntracked) {
      // 未追跡＝全行が追加行。新規 module として扱う。
      for (const l of fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')) set.add(l);
      newFiles.push(f);
    } else {
      const d = git(['diff', '-U0', base, '--', f]) || '';
      for (const l of d.split('\n')) if (l.startsWith('+') && !l.startsWith('+++')) set.add(l.slice(1));
      if (/^new file mode/m.test(git(['diff', base, '--', f]) || '')) newFiles.push(f);
    }
    added.set(f, set);
  }
  return { files, added, newFiles };
}

/** 追加された top-level function / export / module を列挙（B-1）。 */
/** git を使わず、base ディレクトリとの差で対象を決める（fixture 用）。 */
function changedProductFs(baseDir) {
  const files = [], added = new Map(), newFiles = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (isProduct(r) && !isExcluded(r)) files.push(r);
    }
  };
  walk('.', '');
  for (const f of files) {
    const cur = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    const basePath = path.join(baseDir, f);
    if (!fs.existsSync(basePath)) {
      added.set(f, new Set(cur));
      newFiles.push(f);
    } else {
      const old = new Set(fs.readFileSync(basePath, 'utf8').split('\n'));
      added.set(f, new Set(cur.filter(l => !old.has(l))));
    }
  }
  return { files, added, newFiles };
}

function collectSymbols(diff) {
  const symbols = [];
  for (const [rel, addedLines] of diff.added) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // ★追加行も**同じ前処理（コメント・文字列除去）**を通してから比較する。
    //   片側だけ文字列を潰していたため、`function f(){ x = 'lit'; }` のような
    //   1行関数が「追加行に無い」と判定され、対象から落ちた（fixture で発覚）。
    const addedNorm = new Set(codeLines([...addedLines].join('\n')).map(x => x.text.trim()));
    for (const { n, text } of codeLines(src)) {
      if (!addedNorm.has(text.trim())) continue;
      const m = text.match(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (m) symbols.push({ kind: 'function', name: m[1], file: rel, line: n });
    }
  }
  // ★export も対象（B-1）。UMD の `return { a, b, c };` に載る名前のうち、
  //   top-level function として既に拾っていないもの（アロー・const 等）を追加する。
  for (const [rel, addedLines] of diff.added) {
    if (!isProductJs(rel)) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const m = src.match(/return\s*\{([^}]*)\}\s*;?\s*\}\)\)/);
    if (!m) continue;
    for (const raw of m[1].split(',')) {
      const nm = raw.split(':')[0].trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(nm)) continue;
      if (symbols.some(x => x.name === nm && x.file === rel)) continue;
      let isNew = false;
      for (const a of addedLines) if (a.includes(nm)) { isNew = true; break; }
      if (!isNew) continue;
      symbols.push({ kind: 'export', name: nm, file: rel, line: 1 });
    }
  }
  for (const f of diff.newFiles) {
    if (isProductJs(f)) symbols.push({ kind: 'module', name: path.basename(f), file: f, line: 1 });
  }
  return symbols;
}

/** 製品 runtime 内の呼出しを探す（B-2）。定義行は除く。 */
function findCalls(name, defFile, defLine) {
  const hits = [];
  const targets = new Set([...PRODUCT_FILES]);
  for (const f of fs.readdirSync(path.join(ROOT, 'desktop'))) {
    const rel = 'desktop/' + f;
    if (isProductJs(rel)) targets.add(rel);
  }
  // ★UMD モジュールの関数は製品から `S.answerFuel(...)` のように**プロパティ経由**で呼ばれる。
  //   `[^\w$.]` で `.` を除くと、実際に配線されている関数を未配線と誤判定する（初版で14件）。
  //   直呼び出しとプロパティ経由の両方を拾う。
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(^|[^\\w$])\\.?' + esc + '\\s*\\(');
  for (const rel of targets) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    for (const { n, text } of codeLines(src)) {
      if (!text || !re.test(text)) continue;
      if (rel === defFile && n === defLine) continue;                       // 定義行
      // ★「function 宣言行はスキップ」を広く取ると、**同じ行に呼出しがある場合**まで捨てる
      //   （fixture で `function handleTelemetry(...){ ... observeThing(data); }` が1行に入り、
      //     実際に配線されている関数を未配線と誤判定した）。**探している名前の定義行だけ**除く。
      const defHere = new RegExp('^\\s*(?:async\\s+)?function\\s+' + esc + '\\s*\\(').test(text);
      if (defHere && !new RegExp('[^\\w$.]' + esc + '\\s*\\(').test(text.replace(/^\s*(?:async\s+)?function\s+/, ''))) continue;
      hits.push({ file: rel, line: n, text: text.trim().slice(0, 100) });
    }
  }
  return hits;
}

/** module が製品から読み込まれているか（B-3）。 */
function moduleLoaded(basename) {
  const evidence = [];
  const renderer = fs.readFileSync(path.join(ROOT, 'desktop/renderer.html'), 'utf8');
  if (new RegExp('<script src="' + basename.replace('.', '\\.') + '"').test(renderer))
    evidence.push('desktop/renderer.html <script src>');
  for (const rel of PRODUCT_FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    for (const { n, text } of codeLines(src)) {
      if (text && text.includes("require(") && text.includes(basename.replace('.js', '')))
        evidence.push(`${rel}:${n} require`);
    }
  }
  return evidence;
}

/** 製品入口からの到達根拠（B-4）。
 *
 *  ★初版は「呼出し位置から上方向80行に入口パターンがあるか」という当てずっぽうで、
 *    `create` を「HTTPルート」と誤判定した。**呼出しグラフの推移到達**へ作り直す。
 *
 *  定義：呼出し位置を囲む**最も近い名前つき関数**を辿る。
 *    - 囲む名前つき関数が無い（top-level・ハンドラ内の無名関数・アロー関数）→ **入口**
 *    - 囲む関数がある → その関数自身が入口へ到達するかを再帰で見る（循環は未到達扱い）
 *  これで内部ヘルパー（`bump` 等）も、呼び元が入口へ繋がっていれば合格になる。
 */
function indexFunctions() {
  const idx = [];                      // {file,name,start,end}
  const targets = new Set([...PRODUCT_FILES]);
  for (const f of fs.readdirSync(path.join(ROOT, 'desktop'))) {
    const rel = 'desktop/' + f;
    if (isProductJs(rel)) targets.add(rel);
  }
  for (const rel of targets) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      // `function f(`／`const f = (…) =>`／`const f = function(` を索引する。
      const m = lines[i].match(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/)
        || lines[i].match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/)
        || lines[i].match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\(/);
      if (!m) continue;
      let depth = 0, started = false, end = i;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}') depth--;
        }
        if (started && depth <= 0) { end = j; break; }
        end = j;
      }
      idx.push({ file: rel, name: m[1], start: i + 1, end: end + 1 });
    }
  }
  return idx;
}

function enclosing(idx, file, line) {
  let best = null;
  for (const f of idx) {
    if (f.file !== file || line < f.start || line > f.end) continue;
    if (!best || f.start > best.start) best = f;      // 最も内側
  }
  return best;
}

/** name が入口へ到達するか。到達根拠（経路）も返す。 */
function reachable(idx, name, defFile, defLine, seen) {
  seen = seen || new Set();
  if (seen.has(name)) return null;                    // 循環＝根拠にしない
  seen.add(name);
  const calls = findCalls(name, defFile, defLine);
  if (!calls.length) return null;
  for (const c of calls) {
    const enc = enclosing(idx, c.file, c.line);
    if (!enc) return { entry: `${c.file}:${c.line}（名前つき関数の外＝ハンドラ／top-level）`, path: [name] };
    // ★名前つき関数の中でも、その内側の**無名関数／アロー関数がハンドラとして登録**されていれば
    //   そこが実行の入口である（`irBridge.onmessage=(ev)=>{ … }` など）。
    //   囲む関数の開始〜呼出し位置の間にハンドラ登録があるかを見る。
    {
      const lines = fs.readFileSync(path.join(ROOT, c.file), 'utf8').split('\n');
      for (let i = enc.start - 1; i < c.line; i++) {
        if (/\.on\w+\s*=|addEventListener\s*\(|setInterval\s*\(|setTimeout\s*\(/.test(lines[i] || ''))
          return { entry: `${c.file}:${i + 1}（ハンドラ登録）`, path: [name] };
      }
    }
    if (enc.name === name) continue;                  // 自己再帰は根拠にしない
    const up = reachable(idx, enc.name, enc.file, enc.start, seen);
    if (up) return { entry: up.entry, path: [name, ...up.path] };
  }
  return null;
}

function loadAllow() {
  if (!fs.existsSync(ALLOW)) return { entries: [], errors: [] };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(ALLOW, 'utf8')); }
  catch (e) { return { entries: [], errors: ['wiring-allow.json が JSON でない: ' + e.message] }; }
  const errors = [];
  const entries = Array.isArray(raw) ? raw : [];
  if (!Array.isArray(raw)) errors.push('wiring-allow.json は配列であること');
  for (const e of entries) {
    const id = (e && e.symbol) || '(symbol無し)';
    if (!e || !e.symbol) { errors.push('symbol が無い項目がある'); continue; }
    if (/[*?]/.test(e.symbol)) errors.push(`${id}: glob は禁止。symbol 単位で書くこと`);
    for (const k of ['reason', 'owner', 'kind', 'evidence']) {
      if (!e[k] || typeof e[k] !== 'string' || !e[k].trim()) errors.push(`${id}: ${k} が無い`);
    }
    if (e.reason && /^legacy$/i.test(e.reason.trim())) errors.push(`${id}: 理由が "legacy" だけでは不可`);
    if (!e.expires && !e.recheck) errors.push(`${id}: expires か recheck（再評価条件）が必須`);
    if (e.expires) {
      const t = Date.parse(e.expires);
      if (Number.isNaN(t)) errors.push(`${id}: expires が日付として読めない`);
      else if (t < Date.now()) errors.push(`${id}: expires 切れ（${e.expires}）`);
    }
  }
  return { entries, errors };
}

function main() {
  const args = process.argv.slice(2);
  const bi = args.indexOf('--base');
  const base = bi >= 0 ? args[bi + 1] : null;
  const ji = args.indexOf('--json');
  const jsonOut = ji >= 0 ? args[ji + 1] : null;
  if (!base && args.indexOf('--fs-base') < 0) {
    console.error('使い方: node tools/wiring-lint.js --base <sha> | --fs-base <dir> [--json <out>]');
    process.exit(1);
  }

  const fi = args.indexOf('--fs-base');
  const fsBase = fi >= 0 ? path.resolve(args[fi + 1]) : null;
  const allow = loadAllow();
  const diff = fsBase ? changedProductFs(fsBase) : changedProduct(base);
  if (!diff) { console.error('❌ git diff できない（base が不正）: ' + base); process.exit(1); }

  const FUNC_INDEX = indexFunctions();
  const symbols = collectSymbols(diff);
  const allowed = new Map(allow.entries.map(e => [e.symbol, e]));
  const findings = [];
  const passed = [];

  for (const s of symbols) {
    if (allowed.has(s.name)) { passed.push({ ...s, verdict: 'allowed' }); continue; }
    if (s.kind === 'module') {
      const ev = moduleLoaded(s.name);
      if (!ev.length) findings.push({ ...s, why: '製品から読み込まれていない（<script src> も require も無い）' });
      else passed.push({ ...s, verdict: 'loaded', evidence: ev });
      continue;
    }
    const calls = findCalls(s.name, s.file, s.line);
    if (!calls.length) {
      findings.push({ ...s, why: '製品runtimeからの呼出しが1件も無い' });
      continue;
    }
    const reach = reachable(FUNC_INDEX, s.name, s.file, s.line);
    if (!reach) {
      findings.push({ ...s, why: '呼出しはあるが、製品入口からの到達根拠が示せない',
        calls: calls.map(c => `${c.file}:${c.line}`) });
      continue;
    }
    passed.push({ ...s, verdict: 'wired', calls: calls.length,
      entry: reach.entry, path: reach.path.join(' ← ') });
  }

  const report = {
    base: base || ('fs:' + fsBase), symbols: symbols.length, passed: passed.length, findings, allow_errors: allow.errors,
    allow_count: allow.entries.length,
    static_analysis_limits: [
      '動的 dispatch（変数経由の呼出し・文字列からの解決・`window[name]()`）は追えない',
      '入口判定は「囲む名前つき関数が無い位置＝ハンドラ／top-level」とする。'
      + 'アロー関数・無名関数の中身は入口として扱うため、実際には到達しない配線を'
      + '合格にし得る（過検出ではなく**見逃し**の方向）',
      '呼出しは同名の別関数と区別しない（同名衝突があれば誤って合格にし得る）',
      'これらは allow list へ逃がさず、静的検査外として記録する',
    ],
  };
  if (jsonOut) fs.writeFileSync(path.resolve(ROOT, jsonOut), JSON.stringify(report, null, 2));

  for (const e of allow.errors) console.error('  ❌ allow: ' + e);
  for (const f of findings) console.error(`  ❌ ${f.kind} ${f.name}（${f.file}:${f.line}）— ${f.why}`);
  for (const p of passed) console.log(`  ✅ ${p.kind} ${p.name} — ${p.verdict}`
    + (p.path ? `（${p.path}）` : ''));
  console.log(`[wiring] base=${base || ('fs:' + path.basename(fsBase))} 対象 ${symbols.length} / 合格 ${passed.length}`
    + ` / 未配線 ${findings.length} / allow ${allow.entries.length}（不備 ${allow.errors.length}）`);

  process.exit(findings.length || allow.errors.length ? 1 : 0);
}

main();
