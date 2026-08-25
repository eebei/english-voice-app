#!/usr/bin/env node
'use strict';

// 2026-08-19 — デプロイ反映の確認手段（/api/version と verify-deploy.sh）。
//
// 経緯：PITWALL の更新は2系統ある。
//   exe側    : bridge.py / desktop/** → GitHub Actions → installer（成否の証拠が残る）
//   サーバー側: server.js / prompts.js / engineer-card.js / auth.js → Railway
// サーバー側は「push したから反映されているはず」だけで運用しており、本番が今どの
// コミットで動いているかを知る手段が存在しなかった。GitHub Actions が緑でも Railway
// が落ちていれば、installer だけ新しく中身は古い、という状態になる。
// Build 277 の発話短縮は engineer-card.js＝サーバー側にしか無く、まさにこの型だった。
//
// 外部APIは呼ばない。ネットワークにも出ない。

const fs = require('fs');
const server = fs.readFileSync('server.js', 'utf8');
const script = fs.readFileSync('verify-deploy.sh', 'utf8');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : ' -> ' + (detail || '')));
  ok ? pass++ : fail++;
}

console.log('══ /api/version（本番のコミットを外から確認できる） ══');
check('公開エンドポイントがある', /app\.get\('\/api\/version'/.test(server));
check('Railway注入のcommit SHAを返す', /RAILWAY_GIT_COMMIT_SHA/.test(server));
check('起動時刻を返す（いつ入れ替わったかが分かる）',
  /SERVER_STARTED_AT/.test(server) && /const SERVER_STARTED_AT = new Date\(\)\.toISOString\(\)/.test(server));
check('キャッシュされない（古い答えを掴まない）',
  /app\.get\('\/api\/version'[\s\S]{0,200}Cache-Control'?,\s*'no-store'/.test(server));

// 認証で塞いでしまうと、デプロイ事故の時に一番見たい情報が見られなくなる。
check('認証ミドルウェアを噛ませていない',
  !/app\.get\('\/api\/version',\s*require/.test(server)
  && !/app\.get\('\/api\/version',\s*[a-zA-Z]+,/.test(server));

// 秘密を漏らさないこと。返してよいのは commit / branch / 起動時刻だけ。
{
  const m = server.match(/app\.get\('\/api\/version'[\s\S]{0,700}?\n\}\);/);
  const body = m ? m[0] : '';
  check('/api/version の本体を特定できる', !!body);
  const FORBIDDEN = /ANTHROPIC_API_KEY|ADMIN_SECRET|STRIPE|DATABASE_URL|GOOGLE_APPLICATION|SECRET|TOKEN|PASSWORD/i;
  check('秘密の環境変数を返していない', !FORBIDDEN.test(body), body.slice(0, 200));
  check('process.env を丸ごと吐いていない', !/res\.json\(\s*process\.env/.test(body));
}

console.log('\n══ verify-deploy.sh（突合が手作業の記憶に頼らない） ══');
check('既定でローカルHEADと突合する', /git rev-parse HEAD/.test(script));
check('別URL（staging等）を指定できる', /--url/.test(script));
check('実行可能ビットが立っている',
  (fs.statSync('verify-deploy.sh').mode & 0o111) !== 0);

// ここは文字列一致で守れない。`exit 1` がファイル内のどこかにあることと、
// 不一致の時に実際に失敗することは別物だった（初版はこの変異を見逃した）。
// 偽の本番を立てて、スクリプトを本当に走らせて終了コードを見る。
{
  const { execFileSync, spawnSync, spawn } = require('child_process');

  // スタブサーバーは**別プロセス**で立てる。同一プロセスだと execFileSync が
  // イベントループを止めてしまい、サーバーが応答できない。その状態では
  // 全ケースが「到達不能」で失敗し、「不一致を検出できた」ように見えてしまう
  // （初版はこれで嘘の合格を出した）。
  const PORT = 39200 + (process.pid % 300);
  // ★経路の応答も渡す。既定 401 は「経路が生きていて認証も効いている」本番の正常形。
  const runAgainst = (payload, expectCommit, memoryStatus = 401) => {
    const stub = spawn(process.execPath, ['-e', `
      const http=require('http');
      http.createServer((q,r)=>{
        if(q.url==='/api/memory/decisions'){r.writeHead(${memoryStatus});return r.end();}
        if(q.url!=='/api/version'){r.writeHead(404);return r.end();}
        r.writeHead(200,{'Content-Type':'application/json'});
        r.end(${JSON.stringify(payload)});
      }).listen(${PORT});
    `], { stdio: 'ignore' });
    // listen するまで待つ（固定 sleep にしない）。
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      up = spawnSync('curl', ['-sf', '-m', '1',
        'http://127.0.0.1:' + PORT + '/api/version'], { stdio: 'ignore' }).status === 0;
      if (!up) spawnSync('sleep', ['0.1']);
    }
    if (!up) { stub.kill(); throw new Error('スタブサーバーが立たなかった'); }
    let code = 0;
    try {
      execFileSync('./verify-deploy.sh',
        ['--url', 'http://127.0.0.1:' + PORT, expectCommit],
        { stdio: 'pipe', timeout: 30000 });
    } catch (e) { code = e.status === undefined ? -1 : e.status; }
    stub.kill();
    spawnSync('sleep', ['0.2']);
    return code;
  };

  const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);
  const version = c => JSON.stringify({ commit: c, branch: 'main', startedAt: 'x' });
  check('SHA一致かつ経路が生きていれば成功する（exit 0）',
    runAgainst(version(SHA), SHA, 401) === 0);
  // ★ここが Build 281 型の事故：SHA は合っているのに、その版の経路が本番に無い。
  check('★SHA一致でも経路が404なら失敗する（反映済みと誤認しない）',
    runAgainst(version(SHA), SHA, 404) !== 0);
  check('★SHA一致でも503（DB未準備）なら失敗する',
    runAgainst(version(SHA), SHA, 503) !== 0);
  check('★経路が200（認証が外れている）なら失敗する',
    runAgainst(version(SHA), SHA, 200) !== 0);
  check('不一致なら失敗する（本番が古いまま素通りしない）',
    runAgainst(JSON.stringify({ commit: OTHER, branch: 'main', startedAt: 'x' }), SHA) !== 0);
  check('commitを返さない旧版は失敗（＝この変更自体が未反映）',
    runAgainst(JSON.stringify({ ok: true }), SHA) !== 0);

  // 到達不能：どこも listen していないポートを指す。
  let code = 0;
  try {
    execFileSync('./verify-deploy.sh', ['--url', 'http://127.0.0.1:1', SHA],
      { stdio: 'pipe', timeout: 30000 });
  } catch (e) { code = e.status === undefined ? -1 : e.status; }
  check('本番へ到達できない時も失敗する', code !== 0);
}

console.log('\n══ 運用に組み込まれているか ══');
{
  const handoff = fs.readFileSync('HANDOFF.md', 'utf8');
  check('引き継ぎ文書がデプロイ確認手順を書いている',
    /verify-deploy\.sh/.test(handoff), '手順が文書化されていないと、また忘れる');
}

console.log(`\nDeploy verification: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);

// ══════════════════════════════════════════════════════════════════════
// ★2026-08-25 — SHA一致だけを「反映済み」と読まない。
//
// スライス3で auth.init() に `CREATE TABLE strategy_decisions` を足した。
// マイグレーションが失敗しても /api/version は正しい SHA を返し続けるため、
// SHA だけ見ると「反映済み」に見えて記憶APIが 503 のまま、という状態になる。
// Build 281（SHAは合っていたが module が入っていなかった）と同じ型。
// ══════════════════════════════════════════════════════════════════════
{
  console.log('\n══ 経路が生きているかを SHA と別に確認する ══');
  check('★未認証で経路を叩く関数がある', /probe_endpoint\(\)/.test(script));
  check('★戦略判断の正本を確認対象にしている',
    /probe_endpoint "\/api\/memory\/decisions"/.test(script));
  check('★401/403 を「生きている」と判定する（認証情報を使わない）',
    /401\|403\)\s*echo[^\n]*経路は生きている/.test(script));
  check('★404 を「この版が入っていない」と判定する', /404\)[^\n]*経路が無い/.test(script));
  check('★503 を「テーブル作成の失敗」と判定する（auth未準備と区別する）',
    /503\)[^\n]*未準備/.test(script));
  check('★200 を重大扱いにする（認証が外れている）',
    /200\)[^\n]*認証が外れている/.test(script));
  check('★SHA一致でも経路が死んでいれば失敗する',
    /SHAは合っているのに経路が死んでいる/.test(script) && /verify_live_routes; then[\s\S]{0,200}exit 0/.test(script));
  check('経路が死んだ時に調べ先を示す', /DBマイグレーション\)失敗|マイグレーション/.test(script));
  // 「一致したら即 exit 0」に戻す変異を検出するため、経路確認を通らない exit 0 が無いことを見る。
  const okPaths = (script.match(/exit 0/g) || []).length;
  check('★経路確認を経ない成功パスが無い', okPaths === 1, String(okPaths) + ' 個の exit 0');
}

console.log(`\n(経路確認を含む累計) ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
