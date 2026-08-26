#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════
// 2026-08-26 — Gate 5 の artifact 検査を道具にする（`verify-artifact.sh`）。
//
// 経緯：Build 284 / 285 / 286 と、同じ検査をその場限りのシェル操作で
// 毎回打ち直していた。作業者と確認者が別々に手順を再現する形は、
// Build 282 で「証拠だけが古いまま残った」事故と同じ性質の弱さを持つ。
//
// ここで固定するのは、道具が**落ちるべき時に落ちる**という性質。
// ネットワークには出ない。外部有料APIも呼ばない。
// ══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const script = fs.readFileSync(path.join(__dirname, 'verify-artifact.sh'), 'utf8');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : ' -> ' + (detail || '')));
  ok ? pass++ : fail++;
}

console.log('\n══ 実行可能で、引数を要求する ══');
{
  const st = fs.statSync(path.join(__dirname, 'verify-artifact.sh'));
  check('実行可能ビットが立っている', (st.mode & 0o111) !== 0);
  let code = 0;
  try { execFileSync('./verify-artifact.sh', [], { cwd: __dirname, stdio: 'pipe' }); }
  catch (e) { code = e.status; }
  check('引数なしでは使い方を出して失敗する', code === 2, String(code));
  let code2 = 0;
  try { execFileSync('./verify-artifact.sh', ['123'], { cwd: __dirname, stdio: 'pipe' }); }
  catch (e) { code2 = e.status; }
  check('★対象SHAとBuild番号を省略できない（曖昧なまま走らせない）', code2 === 2, String(code2));
}

console.log('\n══ 「別のコードから作られた artifact」を掴まない ══');
{
  check('run の headSha と対象SHAを突き合わせる', /headSha が対象SHAと一致/.test(script));
  check('★不一致なら「別のコードから作られている」と失敗する',
    /この artifact は別のコードから作られている/.test(script)
    && /bad "headSha=/.test(script));
  check('run の結論が success でなければ失敗する', /run の結論が \$CONCL/.test(script));
  check('★artifact 名が名乗る Build 番号を検査する',
    /\*"Build-\$BUILD_NUM-"\*\)/.test(script));
  check('build-info.json の buildNum も検査する',
    /build-info\.json の buildNum が \$GOT/.test(script));
}

console.log('\n══ 公開していないことを確認する ══');
{
  check('Publish ステップの結論を見る', /Publish to Release -> skipped/.test(script));
  check('★skipped でなければ失敗する', /公開された可能性/.test(script));
}

console.log('\n══ 途中で切れた取得物を証拠にしない ══');
{
  check('★期待サイズと突き合わせて再利用を決める',
    /HAVE_BYTES" != "\$ART_BYTES"/.test(script));
  check('  非空判定だけで再利用しない（truncate を通さない）',
    !/if \[ ! -s "\$WORK\/artifact\.zip" \]/.test(script));
  check('サイズ違いなら消して取り直す', /rm -f "\$WORK\/artifact\.zip"/.test(script));
  check('展開に失敗したら止まる', /zip 展開失敗/.test(script));
}

console.log('\n══ 同梱物を実物で見る（manifest を証拠にしない）══');
{
  check('installer を実際に展開する', /bsdtar -xf "\$INST" resources/.test(script));
  check('app.asar と Bridge のハッシュを自分で計算する',
    /shasum -a 256 "\$R\/\$f"/.test(script));
  check('★CI manifest は「突合相手」であって証拠ではないと明示している',
    /runner の自己申告/.test(script));
  check('installer 3本の同一性を見る（latest が古い版を指す事故）',
    /installer 3本すべて同一ハッシュ/.test(script));
  check('同梱物が欠けていれば失敗する', /が installer に入っていない/.test(script));
}

console.log('\n══ runtime module の欠落検査が派生である ══');
{
  check('ファイル名をハードコードしない',
    /matchAll\(\/<script src="\(\[a-z0-9-\]\+\\\.js\)"/.test(script));
  check('★検査対象を **artifact 側の renderer** から取る（手元のソースからではない）',
    /artifact 側の renderer/.test(script)
    && /fs\.readFileSync\(path\.join\(asar,'renderer\.html'\)/.test(script));
  check('  手元のソースから作ると古い artifact でも一致に見える、と理由が書いてある',
    /artifact が古くても「一致」に見えてしまう/.test(script));
  check('欠落があれば非ゼロで終わる', /process\.exit\(missing\.length\|\|diff\?1:0\)/.test(script));
}

console.log('\n══ 中身が対象SHAと同じことを確認する ══');
{
  check('git show で対象SHAのソースを取る', /git show \$\{sha\}:desktop\//.test(script));
  check('★CRLF を正規化して比べる（Windows runner の checkout）',
    /replace\(\/\\r\/g,''\)/.test(script));
  check('対象SHAに無いファイルは失敗にする', /が対象SHAに存在しない/.test(script));
}

console.log('\n══ Bridge 実行体を推測で判定しない ══');
{
  check('★strings で出ないことを「入っていない」と読まず zlib 展開する',
    /PyInstaller は圧縮するので zlib 展開して見る/.test(script));
  check('期待する Build 番号を Bridge の中で探す', /f"Build \{build\}"\.encode\(\)/.test(script));
  check('Decision ID の結合キーも探す', /b"active_decision_id"/.test(script));
  check('★旧 Build 文字列を同じストリーム内で判定する（打ち切りでも健全）',
    /同じストリーム/.test(script) && /stale_in_same_stream/.test(script));
  check('  全走査しない理由が書いてある', /道具として使われなくなる/.test(script));
  check('★2系統の取り違え（PTT が欠ける）を検査する',
    /pygame が無い＝Bridge単体用を掴んでいる/.test(script));
}

console.log('\n══ 何の証拠かを言い過ぎない ══');
{
  check('★Gate 5 の証拠であって実走の証拠ではないと明示する',
    /Windows起動・server反映・実走の証拠ではない/.test(script));
  check('不合格なら「証拠に使うな」と言う', /証拠に使わないこと/.test(script));
  check('成功と失敗で終了コードが違う', /exit \$fail/.test(script));
}

console.log('\n══ 運用に組み込まれているか ══');
{
  const log = fs.readFileSync(path.join(__dirname, 'review/PITWALL_SHARED_WORKING_LOG.md'), 'utf8');
  check('共有ログが道具の存在と使い方を書いている',
    /verify-artifact\.sh/.test(log), '書いていないと、また手作業に戻る');
}

console.log(`\nArtifact verification tool: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
