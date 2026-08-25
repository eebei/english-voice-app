#!/usr/bin/env node
'use strict';

// G2（2026-08-25）— queue に残った GAP 候補を再生直前に照合する。
//
// 実走欠陥（`OMORAY-bridge-debug-20260823-1403.log`）:
//   19:14:16 「前5.5秒」を queue へ登録 → 19:14:24 実値 0.7 → 19:14:31 に 5.5 を再生
//   19:11:59 「後ろ3.8秒」 → 19:12:00 DATA CHECK gapBehind 0.6
//
// 指示書 §4 の 7・8・9 をここで固定する。外部APIは呼ばない。

const fs = require('fs');
const F = require('./desktop/gap-freshness');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : ' -> ' + (detail || '')));
  ok ? pass++ : fail++;
}

const T0 = 1_700_000_000;           // 秒（bridge の observed_at 相当）
const NOW = T0 * 1000;              // ミリ秒
const SK = "(2, 'Okayama', 'Audi R8 LMS GT3')";

const identity = (over = {}) => Object.assign({
  session_key: SK, generation: 3, source_kind: 'same_class_battle_gap',
  direction: 'ahead', target_car_idx: 12, gap_s: 5.5, sampled_at: T0,
}, over);

const live = (over = {}) => ({
  gap_authority: {
    ahead: Object.assign({
      session_key: SK, generation: 3, direction: 'ahead',
      target_car_idx: 12, gap_s: 5.5, source_kind: 'same_class_battle_gap',
    }, over.ahead || {}),
    behind: over.behind === undefined ? null : over.behind,
  },
});

// ── 素通り：GAP以外の発話には触れない ──────────────────────────
console.log('\n══ GAP以外は素通り ══');
check('identity が無ければ play', F.evaluate(null, live(), NOW).fate === F.FATE_PLAY);
check('理由も残る', F.evaluate(null, live(), NOW).reason === F.REASON_NOT_GAP);

// ── §4-7 queue 年齢の境界 ────────────────────────────────────
console.log('\n══ §4-7 queue 年齢（14秒の旧数値は絶対に再生しない） ══');
check('0.5秒待機なら再生してよい',
  F.evaluate(identity(), live(), NOW + 500).fate === F.FATE_PLAY);
check(`境界ちょうど（${F.MAX_AGE_MS}ms）は再生してよい`,
  F.evaluate(identity(), live(), NOW + F.MAX_AGE_MS).fate === F.FATE_PLAY);
check('境界超過（+1ms）は破棄',
  F.evaluate(identity(), live(), NOW + F.MAX_AGE_MS + 1).fate === F.FATE_DISCARD);
{
  const r = F.evaluate(identity(), live(), NOW + 14742);   // 実走と同じ 14,742ms
  check('★実走の 14,742ms 後は破棄', r.fate === F.FATE_DISCARD, r.fate);
  check('  理由が age_exceeded として残る', r.reason === F.REASON_STALE, r.reason);
  check('  古い数字を返さない', r.gapS === null);
}

// ── §4-8 値が変わった場合 ───────────────────────────────────
console.log('\n══ §4-8 候補生成後に 5.5→0.7 へ変化 ══');
{
  const r = F.evaluate(identity({ gap_s: 5.5 }), live({ ahead: { gap_s: 0.7 } }), NOW + 1000);
  check('★旧5.5を再生しない', r.fate !== F.FATE_PLAY, r.fate);
  check('  同じ車・同じ方向なら黙らず作り直す', r.fate === F.FATE_REBUILD, r.fate);
  check('  最新値 0.7 を返す', r.gapS === 0.7, String(r.gapS));
  check('  作り直した文が最新値になる',
    F.rebuildText('ahead', r.gapS, 'ja') === '前0.7秒。', F.rebuildText('ahead', r.gapS, 'ja'));
}

// ── §4-9 3.8→0.6 の後方ケース ────────────────────────────────
console.log('\n══ §4-9 候補生成後に 3.8→0.6 へ変化（19:11:59 の実走） ══');
{
  const id = identity({ direction: 'behind', target_car_idx: 31, gap_s: 3.8 });
  const snapshot = {
    gap_authority: {
      ahead: null,
      behind: { session_key: SK, generation: 3, direction: 'behind',
                target_car_idx: 31, gap_s: 0.6, source_kind: 'same_class_battle_gap' },
    },
  };
  const r = F.evaluate(id, snapshot, NOW + 1000);
  check('★旧3.8を再生しない', r.fate !== F.FATE_PLAY, r.fate);
  check('  最新値 0.6 で作り直す', r.fate === F.FATE_REBUILD && r.gapS === 0.6, String(r.gapS));
  check('  日本語の文が「後ろ0.6秒。」', F.rebuildText('behind', 0.6, 'ja') === '後ろ0.6秒。');
  check('  英語の文も方向を保つ', F.rebuildText('behind', 0.6, 'en') === '0.6 seconds behind.');
}

// ── §4-5 追越しで対象車が入れ替わる ──────────────────────────
console.log('\n══ §4-5 対象車の交代・方向反転・セッション変更は破棄 ══');
{
  const cases = [
    ['対象車が別の車になった', live({ ahead: { target_car_idx: 44 } }), F.REASON_TARGET],
    ['方向が反転した', live({ ahead: { direction: 'behind' } }), F.REASON_DIRECTION],
    ['セッションが変わった', live({ ahead: { session_key: "(3, 'Monza', 'Audi R8 LMS GT3')" } }), F.REASON_SESSION],
    ['世代が進んだ', live({ ahead: { generation: 4 } }), F.REASON_GENERATION],
  ];
  cases.forEach(([label, snapshot, reason]) => {
    const r = F.evaluate(identity(), snapshot, NOW + 500);
    check(`${label} → 破棄`, r.fate === F.FATE_DISCARD, r.fate);
    check(`  理由が ${reason}`, r.reason === reason, r.reason);
  });
}

// ── 現在値が取れない場合は黙る ──────────────────────────────
console.log('\n══ 現在値が無ければ黙る（古い数字を喋らない） ══');
check('権威テーブルが無ければ破棄',
  F.evaluate(identity(), {}, NOW).fate === F.FATE_DISCARD);
check('その方向の権威が null なら破棄',
  F.evaluate(identity({ direction: 'behind' }), live(), NOW).fate === F.FATE_DISCARD);
check('現在値が数値でなければ破棄',
  F.evaluate(identity(), live({ ahead: { gap_s: null } }), NOW).fate === F.FATE_DISCARD);
check('理由は no_live_authority',
  F.evaluate(identity(), {}, NOW).reason === F.REASON_NO_LIVE);

// ── 正常系 ────────────────────────────────────────────────
console.log('\n══ 正常系 ══');
{
  const r = F.evaluate(identity(), live(), NOW + 200);
  check('同じ車・同じ方向・同じ値なら再生', r.fate === F.FATE_PLAY, r.fate);
  check('  最新値を返す', r.gapS === 5.5);
}
check('0.1秒未満の差は作り直さない（無駄な言い直しをしない）',
  F.evaluate(identity({ gap_s: 5.5 }), live({ ahead: { gap_s: 5.55 } }), NOW).fate === F.FATE_PLAY);

// ── 配線：実際に再生直前で使われているか ───────────────────────
console.log('\n══ 配線（TTS開始直前に照合されるか） ══');
{
  const renderer = fs.readFileSync('desktop/renderer.html', 'utf8');
  check('renderer が gap-freshness.js を読み込む（完成asar検査の対象になる）',
    /<script src="gap-freshness\.js"><\/script>/.test(renderer));
  check('bridge の identity を queue item へ載せる',
    /gapIdentity:\(data\.gap_identity&&typeof data\.gap_identity==='object'\)/.test(renderer));
  check('speak() が item へ引き継ぐ', /gapIdentity:o\.gapIdentity\|\|null/.test(renderer));

  const splice = renderer.indexOf('const _it = speakQueue.splice(nextIndex,1)[0];');
  const evaluate = renderer.indexOf('PitwallGapFreshness.evaluate(');
  const ttsStart = renderer.indexOf("speechLatencyTrace('tts_start'");
  check('照合は queue から取り出した後・TTS開始より前',
    splice >= 0 && evaluate > splice && ttsStart > evaluate);
  check('破棄は理由つきで cost へ計上する',
    /costRecord\('discarded',\{id:_it\.costId, kind:_it\.kind, reason:'gap_'\+_fresh\.reason\}\)/.test(renderer));
  check('破棄は latency trace にも残る',
    /speechLatencyTrace\('discarded',_it,\{reason:'gap_'\+_fresh\.reason\}\)/.test(renderer));
  check('破棄後も queue が止まらない（次の発話へ進む）',
    /draining=false; isSpeaking=false;[\s\S]{0,80}setTimeout\(drainQueue,0\)/.test(renderer));
  check('module 欠落は破棄として扱う（黙って素通りさせない）',
    /\{fate:'discard', reason:'module_missing', gapS:null\}/.test(renderer));
  check('fate を必ず trace する', /diagnosticLog\('GAP_FRESHNESS'/.test(renderer));
}

// ── bridge が identity を積んでいるか ─────────────────────────
console.log('\n══ bridge 側の identity ══');
{
  const bridge = fs.readFileSync('irsdk-bridge/bridge.py', 'utf8');
  check('gap_trend に gap_identity を積む', /_gap_event\['gap_identity'\] = \{/.test(bridge));
  ['session_key', 'generation', 'source_kind', 'direction', 'target_car_idx', 'gap_s', 'sampled_at']
    .forEach(f => check(`  identity に ${f} が入る`, new RegExp("'" + f + "':").test(bridge)));
  check('telemetry snapshot に現在の権威を載せる（照合相手）',
    /'gap_authority': \{/.test(bridge));
  check('speakable でない方向は null にする（喋れない値を渡さない）',
    /if isinstance\(_r, dict\) and _r\.get\('speakable'\) else None/.test(bridge));
}

// ── §4-10 PTT の直接質問（G3）─────────────────────────────────
console.log('\n══ §4-10 PTT質問：live値があれば必ず答える／古ければ黙る ══');
{
  const R = require('./desktop/local-intent-router');
  const LIVE = { gap_ahead: 4.6, gap_behind: 5.8 };
  const ask = (text, age) => R.route({ text, lang: 'ja', live: LIVE, snapshotAgeMs: age });

  // Build 281 の実走欠陥：値があるのに no-data へ落ちた。
  ['後ろとの差は？', '前とのギャップは？', '前後のギャップは？', 'パンで後ろとの差。'].forEach(q => {
    const r = ask(q, 1000);
    check(`★live値があれば答える: ${q}`,
      r.handled && r.intent === 'nearest_gap' && /秒/.test(r.reply), JSON.stringify(r));
    check('  no-data文言へ落ちない', !/取れていない|伝えられない/.test(r.reply), r.reply);
  });

  // 古い snapshot は喋らない。G2 の再生側と同じ基準。
  const stale = ask('後ろとの差は？', 9000);
  check('★12秒接続判定のままにしない（9秒の値は喋らない）',
    stale.intent === 'nearest_gap_stale', stale.intent);
  check('  数字を含まない', !/[0-9]/.test(stale.reply), stale.reply);
  check('  短く待つよう伝える', /少し待って/.test(stale.reply), stale.reply);
  check('  英語も同じ契約',
    /do not have a current gap/.test(
      R.route({ text: '後ろとの差は？', lang: 'en', live: LIVE, snapshotAgeMs: 9000 }).reply));

  check('境界ちょうど（5000ms）は答える', ask('後ろとの差は？', 5000).intent === 'nearest_gap');
  check('境界超過（5001ms）は黙る', ask('後ろとの差は？', 5001).intent === 'nearest_gap_stale');
  check('年齢が渡されなければ従来どおり答える（呼び出し側が判断できない時に黙らせない）',
    R.route({ text: '後ろとの差は？', lang: 'ja', live: LIVE }).intent === 'nearest_gap');

  // 値そのものが無い場合は、古さではなく「まだ取れていない」を返す（従来契約）。
  const noValue = R.route({ text: '後ろとの差は？', lang: 'ja', live: { gap_ahead: 4.6 }, snapshotAgeMs: 1000 });
  check('値が無い時は unavailable（stale と区別する）',
    noValue.intent === 'nearest_gap_unavailable', noValue.intent);
}

console.log('\n══ 再生側と質問側の基準が揃っているか ══');
{
  const router = fs.readFileSync('desktop/local-intent-router.js', 'utf8');
  const m = router.match(/const GAP_ANSWER_MAX_AGE_MS = (\d+);/);
  check('router に closed constant がある', !!m);
  check(`★再生側(${F.MAX_AGE_MS}ms)と質問側が同じ基準`,
    m && Number(m[1]) === F.MAX_AGE_MS, m && m[1]);
  const renderer2 = fs.readFileSync('desktop/renderer.html', 'utf8');
  check('renderer が実際の snapshot 年齢を渡す',
    /snapshotAgeMs:\(lastTelemetryAt>0\?Date\.now\(\)-lastTelemetryAt:null\)/.test(renderer2));
  check('両方のGAP分岐で検査する（片方に抜け道を残さない）',
    (router.match(/nearest_gap_stale/g) || []).length >= 2);
}

console.log(`\nGap freshness: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
