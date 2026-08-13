#!/usr/bin/env node
'use strict';

// Build 266 — 原価ゲート（Codex差戻し#7 / 内部シミュレーション正本 §Cost gate）。
//
// 正本の要求：各テスト結果に最低限、次を出す。
//   外部Anthropic呼出数（通常テストは0）／外部Google STT・TTS呼出数（同0）／
//   simulated API calls／generated／played／deferred／expired・discarded／
//   estimated Anthropic cost／estimated Google cost／wasted-generation cost
//
// また「生成／保留／再生／完了／期限切れ・破棄を別eventでtrace」すること。
//
// このテストは外部APIを一切呼ばない。fetch も import しない。

const fs = require('fs');
const { createMeter, EVENTS } = require('./desktop/cost-meter');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : ' -> ' + (detail || '')));
  ok ? pass++ : fail++;
}

// ── 1. 各段が別イベントとして記録されること ──────────────────────
{
  const meter = createMeter();
  check('正本が要求する全段が別eventとして定義されている',
    ['generated', 'queued', 'tts_requested', 'deferred', 'played', 'completed',
     'expired', 'discarded'].every(e => EVENTS.includes(e)));

  meter.record('generated', { id: 'r1', kind: 'reply', tokens: { input: 1200, output: 90 } });
  meter.record('queued', { id: 'r1', kind: 'reply' });
  meter.record('tts_requested', { id: 'r1', kind: 'reply' });
  meter.record('played', { id: 'r1', kind: 'reply' });
  meter.record('completed', { id: 'r1', kind: 'reply' });

  const events = meter.events().map(e => e.event);
  check('生成→キュー→TTS→再生→完了が順に別eventで残る',
    JSON.stringify(events) ===
    JSON.stringify(['generated', 'queued', 'tts_requested', 'played', 'completed']),
    events.join(','));
  check('未知のeventは受け付けない', (() => {
    try { meter.record('exploded', {}); return false; } catch (e) { return true; }
  })());
}

// ── 2. 不可視の無駄生成が見えること ─────────────────────────────
{
  const meter = createMeter();
  // 生成したが、上位割り込みで後送りにされ、期限切れで一度も再生されなかった。
  meter.record('generated', { id: 'r2', kind: 'reply', tokens: { input: 1500, output: 120 } });
  meter.record('queued', { id: 'r2', kind: 'reply' });
  meter.record('deferred', { id: 'r2', kind: 'reply' });
  meter.record('expired', { id: 'r2', kind: 'reply', reason: 'stale_information' });

  const report = meter.report();
  check('未再生の生成が無駄生成として数えられる', report.wasted_generation_count === 1);
  check('無駄生成に原価が積まれる', report.wasted_generation_cost_usd > 0,
    String(report.wasted_generation_cost_usd));
  check('played は 0 のまま', report.played_replies === 0);
  check('deferred が計上される', report.deferred_replies === 1);
  check('expired が discarded と合算して出る', report.expired_or_discarded_replies === 1);
}

// ── 3. 再生された生成は無駄に数えない ───────────────────────────
{
  const meter = createMeter();
  meter.record('generated', { id: 'r3', kind: 'reply', tokens: { input: 1000, output: 80 } });
  meter.record('played', { id: 'r3', kind: 'reply' });
  meter.record('completed', { id: 'r3', kind: 'reply' });
  const report = meter.report();
  check('再生された生成は無駄ではない', report.wasted_generation_count === 0);
  check('wasted cost はゼロ', report.wasted_generation_cost_usd === 0);
}

// ── 4. 外部API呼出がゼロであること（正本の絶対条件）──────────────
{
  const meter = createMeter();
  // stub 経由の模擬呼び出しだけを行う。external は一度も立てない。
  meter.recordApiCall('anthropic', { tokens: { input: 2000, output: 150, cache_read: 8000 } });
  meter.recordApiCall('google_tts', { chars: 420 });
  meter.recordApiCall('google_stt', { seconds: 3.2 });

  const verdict = meter.verdict();
  check('通常テストで外部Anthropic呼出は0', verdict.report.external_anthropic_calls === 0);
  check('通常テストで外部Google STT呼出は0', verdict.report.external_google_stt_calls === 0);
  check('通常テストで外部Google TTS呼出は0', verdict.report.external_google_tts_calls === 0);
  check('simulated 呼び出しは計上される', verdict.report.simulated_api_calls === 3);
  check('原価ゲートを通過する', verdict.pass === true, verdict.failures.join(','));
  check('Anthropic原価が見積もられる', verdict.report.estimated_anthropic_cost_usd > 0);
  check('Google原価が見積もられる', verdict.report.estimated_google_cost_usd > 0);
}

// ── 5. 外部呼び出しが混ざったら失敗にすること ──────────────────
{
  const meter = createMeter();
  meter.recordApiCall('anthropic', { external: true });
  const verdict = meter.verdict();
  check('実外部呼出を検出したら原価ゲートは失敗', verdict.pass === false);
  check('失敗理由に external_anthropic_calls が出る',
    verdict.failures.includes('external_anthropic_calls'));
}

// ── 6. 無駄生成の上限を課せること ───────────────────────────────
{
  const meter = createMeter();
  for (let i = 0; i < 3; i++) {
    meter.record('generated', { id: 'w' + i, kind: 'reply', tokens: { input: 900, output: 60 } });
    meter.record('discarded', { id: 'w' + i, kind: 'reply', reason: 'queue_overflow' });
  }
  check('無駄生成が上限を超えたら失敗',
    meter.verdict({ maxWastedGenerations: 2 }).pass === false);
  check('上限内なら通過',
    meter.verdict({ maxWastedGenerations: 5 }).pass === true);
}

// ── 7. renderer が実際に各 seam で計上していること ────────────────
{
  const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('desktop/package.json', 'utf8'));
  check('renderer が cost-meter を読み込む', renderer.includes('cost-meter.js'));
  check('Windows配布物に cost-meter を同梱する',
    Array.isArray(pkg.build && pkg.build.files) && pkg.build.files.includes('cost-meter.js'));
  check('生成を計上する', /costRecord\('generated'/.test(renderer));
  check('キュー投入を計上する', /costRecord\('queued'/.test(renderer));
  check('TTS要求を計上する', /costRecord\('tts_requested'/.test(renderer));
  check('後送りを計上する', /costRecord\('deferred'/.test(renderer));
  check('再生開始を計上する', /costRecord\('played'/.test(renderer));
  check('完了を計上する', /costRecord\('completed'/.test(renderer));
  check('破棄を計上する', /costRecord\('discarded'/.test(renderer));
  check('重複破棄も無言で消さず計上する',
    /reason:'duplicate_dedupe_key'/.test(renderer));
  check('キュー溢れの破棄も計上する', /reason:'queue_overflow'/.test(renderer));
  check('後送り上限での破棄も計上する', /reason:'defer_cap_reached'/.test(renderer));
  check('本番の外部呼出は external として記録する',
    /costApiCall\('anthropic', \{external:true/.test(renderer)
    && /costApiCall\('google_tts', \{external:true/.test(renderer));
}

// ── 8. このテスト自身が外部APIへ到達し得ないこと ───────────────
{
  // 自己言及で誤検出しないよう、この判定ブロック自身は走査から外す。
  const self = fs.readFileSync(__filename, 'utf8')
    .split('\n').filter(line => !line.includes('NO-NET-SCAN')).join('\n');
  const forbidden = ['fet' + 'ch(', "requi" + "re('http", 'axi' + 'os',
                     'anthro' + 'pic-ai'];                     // NO-NET-SCAN
  check('このテストは外部APIを呼ぶ手段を持たない',
    forbidden.every(f => !self.includes(f)),
    forbidden.filter(f => self.includes(f)).join(','));
}

// ── 原価ゲート結果の出力（正本 §Cost gate が要求する全項目）──────
{
  const meter = createMeter();
  // 1レース分の縮約シミュレーション：15生成・12再生・2後送り・1破棄。
  for (let i = 0; i < 15; i++) {
    const id = 'sim' + i;
    meter.record('generated', { id, kind: 'radio', tokens: { input: 1400, output: 70, cache_read: 6000 } });
    meter.recordApiCall('anthropic', { tokens: { input: 1400, output: 70, cache_read: 6000 } });
    meter.record('queued', { id, kind: 'radio' });
    if (i < 12) {
      meter.record('tts_requested', { id, kind: 'radio' });
      meter.recordApiCall('google_tts', { chars: 48 });
      meter.record('played', { id, kind: 'radio' });
      meter.record('completed', { id, kind: 'radio' });
    } else if (i < 14) {
      meter.record('deferred', { id, kind: 'radio' });
      meter.record('expired', { id, kind: 'radio', reason: 'information_stale' });
    } else {
      meter.record('discarded', { id, kind: 'radio', reason: 'queue_overflow' });
    }
  }
  console.log('\n' + meter.formatReport());
  const verdict = meter.verdict();
  check('\n縮約1レースのシミュレーションが原価ゲートを通過する', verdict.pass === true,
    verdict.failures.join(','));
}

console.log(`\nCost Gate: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
