#!/usr/bin/env node
'use strict';

// 実走コーパスのフルソフトウェア再生。
// 4セッション・68件の実際の質問とLuna返信を使い、製品の callAPI() を
// 仮想HTTP境界（分割ストリーム）越しに実行する。外部API/STT/TTSは呼ばない。
// 検証範囲：実質問 → callAPI → ストリーム結合 → 会話Box永続化 → 仮想発話。
// 実マイク、Windows音声デバイス、iRacingメモリ、実走時タイミングはGate 6/8。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const box = require('./desktop/conversation-memory-box.js');
const det = require('./desktop/dispute-detector.js');

const corpus = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'review', 'corpus', 'utterances_20260830_20260831.json')));
const labels = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'review', 'corpus', 'labels_v2.json')));
const renderer = fs.readFileSync(path.join(__dirname, 'desktop', 'renderer.html'), 'utf8');

let pass = 0, fail = 0;
function check(label, ok, got) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label
    + (ok ? '' : '  → ' + JSON.stringify(got)));
  ok ? pass++ : fail++;
}

function grabFn(name, isAsync) {
  const kw = isAsync ? 'async function ' : 'function ';
  const i = renderer.indexOf(kw + name + '(');
  if (i < 0) return null;
  const rest = renderer.slice(i);
  const end = rest.search(/\n\}\n/);
  return end < 0 ? null : rest.slice(0, end + 3);
}

const fnNames = ['callAPI', 'recordLunaTurn', 'ensureConversationBox',
  'saveConversationBox', 'conversationSessionKey', 'addMsg', 'convoLog'];
const fnSrc = fnNames.map(n => grabFn(n, n === 'callAPI'));
check('rendererの再生対象関数を取得できる', fnSrc.every(Boolean),
  fnSrc.map((v, i) => v ? 'ok' : fnNames[i]));

const decls = (renderer.match(/const CONVO_BOX_KEY='[^']+';/) || [''])[0]
  + '\n' + (renderer.match(/let _convoBox=null;/) || [''])[0];
check('会話Boxのモジュール変数を取得できる',
  decls.includes('CONVO_BOX_KEY') && decls.includes('_convoBox'), decls);

function contextFor(entries) {
  const store = {};
  const spoken = [];
  const errors = [];
  let current = null;
  let chunkIndex = 0;
  const ctx = {
    fetch: async () => {
      const chunks = current._chunks;
      return {
        ok: true,
        headers: { get: k => k === 'X-Pitwall-Authority' ? 'llm' : 'conversation' },
        body: { getReader: () => ({ read: async () => chunkIndex < chunks.length
          ? { done: false, value: new TextEncoder().encode(chunks[chunkIndex++]) }
          : { done: true, value: undefined } }) },
      };
    },
    TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout,
    Date, JSON, Math, String, Number, Error, RegExp, Promise, console,
    window: { PitwallConversationMemoryBox: box, PitwallDisputeDetector: det,
      PitwallReflexEvents: null },
    localStorage: { getItem: k => k in store ? store[k] : null,
      setItem: (k, v) => { store[k] = String(v); } },
    document: {
      getElementById: () => ({ classList: { add(){}, remove(){} }, appendChild(){},
        scrollTop: 0, scrollHeight: 0, value: '', style: {} }),
      createElement: () => ({ className: '', textContent: '' }),
    },
    usageCount(){}, applyPitwallAccess(){}, costApiCall(){}, costRecord(){},
    diagnosticLog(tag, msg) { if (String(tag) === 'CLIENT ERROR') errors.push(String(msg)); },
    mirrorToOverlay(){}, flushSentences(){},
    t: k => { errors.push('reached_catch:' + k); return String(k); },
    forwardDriverDamageReport(){}, hydrateLegacyStrategyObjective: () => ({}),
    loadProfile: () => ({}), buildProfileNote: () => '', buildCarTrackMemory: () => '',
    buildPracticeProfileNote: () => '', buildFuelAuthorityNote: () => '',
    buildWeekendAuthorityNote: () => '', buildCurrentSessionFactNote: () => '',
    buildSessionEvidenceNote: () => '', buildContractNote: () => '',
    buildActiveRaceFactsNote: () => '', buildMemoryStatusNote: () => '',
    buildRaceHistoryContext: () => '', buildNamedRivalNote: () => '',
    hasTelemetryOwnedVehicleClaim: () => false,
    normalizeLunaSpeech: t => t,
    speak: t => spoken.push(String(t)), speakReplyChunk: t => spoken.push(String(t)),
    pushMsg(){},
    sel: 'LunaJP', selMode: 'race', userName: 'Yuji', messages: [],
    turns: 0, sessionMsgCount: 0, isBusy: false, iracingLive: true,
    bridgeConnected: true, lastTelemetry: {}, lastTelemetryAt: Date.now(),
    lastSessionType: 'Race', lastSessionAuthority: null, lastCarClass: 'GT3',
    lastCarModel: 'Mercedes-AMG GT3 2020', lastTrack: 'Red Bull Ring', lastSessionNum: 1,
    driverState: 'track', driverActivity: 'ACTIVE', API_BASE: '', usageBuild: 'replay',
    usageSessionId: 'replay-session', currentMemoryUserId: () => 'Yuji',
    memorySavedThisSession: true, evidenceDebrief: null, responseIntent: null,
    responseAuthority: 'llm', SPEAK_PRIO: { P0_SAFETY: 0, P1_URGENT: 1, P2_PROCEDURE: 2,
      P3_INFO: 3, P4_INFO: 4 }, jamesAutoMicEnabled: undefined,
    updateNamedRivalFromUser: () => null, lastSectors: () => null,
    _spoken: spoken, _store: store, _errors: errors,
  };
  ctx.globalThis = ctx;
  ctx.window.localStorage = ctx.localStorage;
  ctx.setCurrent = e => { current = e; chunkIndex = 0; };
  ctx.messages = [];
  return ctx;
}

const groups = new Map();
for (const e of corpus) {
  if (!groups.has(e.log)) groups.set(e.log, []);
  groups.get(e.log).push(e);
}
check('実走コーパスが4セッション68件ある', corpus.length === 68 && groups.size === 4,
  { entries: corpus.length, sessions: groups.size });

let totalEntries = 0;
let totalReplies = 0;
let totalSpeech = 0;
let totalCorrections = 0;
let detectedCorrections = 0;
let confirmedCorrections = 0;
const correctionCandidates = [];
let totalNonCloud = 0;

(async () => {
  for (const [log, entries] of groups) {
    const ctx = contextFor(entries);
    vm.createContext(ctx);
    let loaded = false;
    try {
      vm.runInContext(decls + '\n' + fnSrc.join('\n')
        + '\nthis.callAPI=callAPI; this.addMsg=addMsg; this.ensureConversationBox=ensureConversationBox;', ctx);
      loaded = true;
    } catch (e) {
      check(`${log}: renderer関数を実行コンテキストへ読み込める`, false, String(e));
    }
    if (!loaded) continue;

    // corpusの最初の luna_before は、この抽出範囲より前の実走発話なので
    // 製品の addMsg 出口を通してセッション初期状態へ投入する。
    for (const prior of entries[0].luna_before || []) ctx.addMsg('ai', prior.text);
    const initial = ctx.ensureConversationBox();
    const seedCount = (entries[0].luna_before || []).length;
    check(`${log}: 初期履歴が会話Boxへ入る`, initial.turns.length === seedCount,
      { expected: seedCount, actual: initial.turns.length });

    for (const [index, e] of entries.entries()) {
      totalEntries++;
      // 1件（#32）は実走ログ上、local handlerで処理されてcloud replyが無い。
      // nullを無理にcallAPIへ流して「接続エラー」を捏造しない。
      if (typeof e.reply !== 'string') {
        totalNonCloud++;
        check(`${log} #${index + 1}: cloud応答なしのlocal経路を再現`,
          e.route === null && e.reply === null, { route: e.route, reply: e.reply });
        continue;
      }
      e._chunks = e.reply.length > 8
        ? [e.reply.slice(0, Math.ceil(e.reply.length / 3)),
           e.reply.slice(Math.ceil(e.reply.length / 3), Math.ceil(e.reply.length * 2 / 3)),
           e.reply.slice(Math.ceil(e.reply.length * 2 / 3))]
        : [e.reply];
      ctx.setCurrent(e);
      ctx.messages.push({ role: 'user', content: e.question });
      const before = ctx.ensureConversationBox().turns.length;
      const speechBefore = ctx._spoken.length;
      let thrown = null;
      try { await ctx.callAPI('ptt'); } catch (err) { thrown = String(err); }
      const afterBox = ctx.ensureConversationBox();
      const luna = afterBox.turns.filter(t => t.who === 'luna');
      const latest = luna[luna.length - 1];
      const caught = ctx._errors.some(x => String(x).startsWith('reached_catch:'));
      check(`${log} #${index + 1}: callAPIがcatchなしで完走`,
        !thrown && !caught, { thrown, errors: ctx._errors.slice(-2) });
      check(`${log} #${index + 1}: 実返信が全文で一度だけBoxへ保存`,
        afterBox.turns.length === before + 1 && latest && latest.text === e.reply,
        { before, after: afterBox.turns.length, latest: latest && latest.text });
      totalReplies++;
      if (ctx._spoken.length > speechBefore) totalSpeech++;

      const label = labels[String(totalEntries)];
      if (label && label.speech_act === '訂正') {
        totalCorrections++;
        // 抽出元ログが示す「この質問の直前に実際に流れていたLuna発話」を
        // そのまま検出器へ渡す。セッション全体の箱はログの省略を含むため、
        // 直前文脈の正解性と、全件のBox保存性を混ぜずに採点する。
        const logContext = (e.luna_before || []).map((x, i) => ({
          who: 'luna', text: x.text,
          at: Date.now() - (e.luna_before.length - i) * 1000,
        }));
        const hit = det.detect(e.question, {
          lunaTurns: logContext,
          reflexes: box.reflexContext(afterBox, Date.now()), at: Date.now(),
        });
        if (hit) {
          detectedCorrections++;
          if (hit.confidence === 'confirmed') confirmedCorrections++;
          else correctionCandidates.push({ id: totalEntries, axis: hit.axis, reason: hit.reason });
        }
      }
      ctx.messages.push({ role: 'assistant', content: e.reply });
    }
    check(`${log}: localStorageへ永続化される`,
      typeof ctx._store.pw_conversation_box_v1 === 'string', Object.keys(ctx._store));
  }

  check('68件すべてを再生（cloud 67件＋local 1件）',
    totalEntries === 68 && totalReplies === 67 && totalNonCloud === 1,
    { totalEntries, totalReplies, totalNonCloud });
  check('cloud応答67件すべて仮想発話キューへ到達', totalSpeech === 67,
    { totalSpeech, cloudReplies: totalReplies, nonCloud: totalNonCloud });
  check('実ログ由来の訂正16件がすべて検出器へ到達する',
    totalCorrections === 16 && detectedCorrections === 16,
    { totalCorrections, detectedCorrections });
  console.log(`   confirmed ${confirmedCorrections}/16、candidate ${correctionCandidates.length}/16`);
  if (correctionCandidates.length) console.log('   candidate:', JSON.stringify(correctionCandidates));

  console.log(`\n[conversation corpus replay] 合格 ${pass} / 不合格 ${fail}`);
  console.log('※ 外部API/STT/TTS、Windows/iRacing実機、実走タイミングはこのテストの対象外。');
  process.exit(fail ? 1 : 0);
})();
