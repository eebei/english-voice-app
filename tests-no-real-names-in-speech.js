// 実在テスターの名前が「ドライバーへ話しかける文字列」として残っていないか。
//
// なぜ要るか（2026-09-05・Yuji 実走 Build 297）:
//   `renderer.html` の PDDP ブリーフィングに `'八木さん'` がリテラルで入っており、
//   **誰が走っても別人の名前で呼びかけていた**。Build 294〜297 が公開済み。
//   Gate 5 は同梱を確認するが**中身の正しさは見ない**ため、公開まで誰も気づかなかった。
//
// Codex 第6回指摘（受入条件）:
//   「コメント・docs・fixture の歴史的名称まで一律 grep 失敗にすると誤検知になる。
//     **製品実行コードの driver-facing 文字列／名前引数**を対象に検査し、
//     テスト fixture は明示的に分離する」
//
// したがって次だけを見る:
//   - コメントを除いた実行コード
//   - 文字列リテラルの中身
//   - 実走ログの本文（過去の会話記録）は対象外＝`review/` と `*.log` は見ない

const fs = require('fs');
const path = require('path');

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; return true; }
  failures.push(name + (detail ? '\n     ' + detail : ''));
  return false;
}

// 実在するテスター／個人の名前。ここへ足せば以後は自動で守られる。
// **一般名（ドライバー / Driver / Engineer）は入れない。**
const REAL_NAMES = ['八木', 'Yagi', 'まーぼー', 'Marbo', 'marbo',
                    'ダート', 'Tobi', 'Shouta', 'Yokobori', '横堀'];

// 製品の実行コードだけ。docs / review / テスト fixture は対象外。
const PRODUCT_FILES = [
  'desktop/renderer.html', 'desktop/overlay.html', 'prompts.js', 'engineer-card.js',
  'server.js', 'auth.js',
  'desktop/pddp.js', 'desktop/local-intent-router.js', 'desktop/session-memory.js',
  'desktop/strategy-playbook.js', 'desktop/memory-brain.js',
  'desktop/conversation-memory-box.js', 'desktop/dispute-detector.js',
];

/** 行コメント・ブロックコメントを落とし、文字列リテラルだけを取り出す。
 *
 * ★正規表現リテラル（`/…/`）を割り算やコメントと区別するのは、字句解析器を
 *   丸ごと書くのと同じで、ここで正確にやるのは割に合わない。
 *   **誤検出も見落としも困る**ので、方針を変える：
 *     「コメント行を落とした**行単位**で、実在名が含まれるかを見る」
 *   コメントは行頭 `//` `*` `<!--` と行内 `//` で落とす。
 *   これなら文字列の切れ目を誤らず、コメントの歴史的記述も拾わない。
 */
function speechLiterals(src) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      line = line.slice(end + 2); inBlock = false;
    }
    // 行内のブロックコメント開始（閉じないなら以降は全部コメント）
    for (;;) {
      const st = line.indexOf('/*');
      if (st < 0) break;
      const en = line.indexOf('*/', st + 2);
      if (en < 0) { line = line.slice(0, st); inBlock = true; break; }
      line = line.slice(0, st) + line.slice(en + 2);
    }
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('<!--')) continue;
    // 行内コメント。URL の `//` を落とさないよう直前が `:` でない場合だけ切る。
    const li = line.search(/(^|[^:])\/\//);
    if (li >= 0) line = line.slice(0, line.indexOf('//', li));
    if (line.trim()) out.push(line);
  }
  return out;
}

for (const rel of PRODUCT_FILES) {
  const full = path.join(__dirname, rel);
  if (!fs.existsSync(full)) continue;
  const lits = speechLiterals(fs.readFileSync(full, 'utf8'));
  const hits = [];
  for (const lit of lits) {
    for (const nm of REAL_NAMES) {
      // ファイル名・パス・識別子は対象外（例 `PITWALL-YAGI-XXXX` のようなコード）
      if (lit.includes(nm)) hits.push({ nm, lit: lit.trim().slice(0, 80) });
    }
  }
  check(`実在名が発話文字列に無い：${rel}`, hits.length === 0,
    JSON.stringify(hits.slice(0, 4)));
}

// ★この検査自身が効いていることを確かめる（オラクル自己検査）。
{
  const kept = speechLiterals("const s = 'こんにちは八木さん';");
  check('自己検査：実行行の名前は拾う', kept.some(l => l.includes('八木')), JSON.stringify(kept));
  const dropped = speechLiterals("  // ★八木さん実走ログ 7-3：デブリーフへ入らない\n"
    + "  /* 八木さん の指摘 */\n  <!-- 八木さん・Tobi等の限定配布 -->");
  check('自己検査：コメントの歴史的記述は拾わない',
    !dropped.some(l => l.includes('八木')), JSON.stringify(dropped));
}

// 呼びかけ名が userName を正本にしていること（欠けたら一般名へ落ちる）
{
  const r = fs.readFileSync(path.join(__dirname, 'desktop', 'renderer.html'), 'utf8');
  check('呼びかけ名は userName を正本にする',
    /function driverAddressName\(lang\)\{[\s\S]*?userName[\s\S]*?\}/.test(r));
  check('userName が無ければ一般名へ落とす',
    /'ドライバー' : 'Driver'/.test(r));
  check('PDDPブリーフィングが driverAddressName を使う',
    /briefingLine\(_pddp, driverAddressName\(_decLang\)\)/.test(r));
}

const total = pass + failures.length;
for (const f of failures) console.error('  ❌ ' + f);
console.log(`[no real names in speech] 合格 ${pass} / 不合格 ${failures.length}（実行 ${total}）`);
if (failures.length) process.exit(1);
