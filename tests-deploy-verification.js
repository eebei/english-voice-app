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
  const runAgainst = (payload, expectCommit) => {
    const stub = spawn(process.execPath, ['-e', `
      const http=require('http');
      http.createServer((q,r)=>{
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
  check('一致なら成功する（exit 0）',
    runAgainst(JSON.stringify({ commit: SHA, branch: 'main', startedAt: 'x' }), SHA) === 0);
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
