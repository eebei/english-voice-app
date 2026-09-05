#!/usr/bin/env node
'use strict';

// callAPI() 実行型テスト（Codex差戻し・2026-09-03）
//
// Codex の留保：
//   「ストリーム検査は `callAPI()` 自体を実行せず、`recordLunaTurn()` を直接呼んでいる。
//     実ストリーミング分岐の完全検証ではない。」
//
// **そのとおりだったので、ここでは `callAPI()` そのものを renderer から取り出して実行する。**
// 偽装するのは外界の境界だけ（fetch / DOM / localStorage / タイマー）。
// ストリームは `res.body.getReader()` を本物の分割チャンクで返し、
// **本番と同じデコード・逐次更新・完了処理**を通す。
//
// 確かめること：
//   1. ストリーム完了後、Luna の回答が会話Boxへ**一度だけ**入る
//   2. その文脈で**次ターンの訂正が検出できる**
//   3. 途中チャンクでは入らない（空吹き出し／部分文が保存されない）

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const box = require('./desktop/conversation-memory-box.js');
const det = require('./desktop/dispute-detector.js');

let pass = 0, fail = 0;
function check(label, ok, got) {
  (ok ? console.log : console.error)((ok ? '✅ ' : '❌ ') + label + (ok ? '' : '  → ' + JSON.stringify(got)));
  ok ? pass++ : fail++;
}

const renderer = fs.readFileSync(path.join(__dirname, 'desktop', 'renderer.html'), 'utf8');

// ── callAPI 本体と、記憶まわりの関数を renderer から取り出す ───────────
function grabFn(name, isAsync) {
  const kw = isAsync ? 'async function ' : 'function ';
  const i = renderer.indexOf(kw + name + '(');
  if (i < 0) return null;
  // 対応する閉じ括弧まで（renderer は先頭カラムの `}` で関数が終わる書式）
  const rest = renderer.slice(i);
  const end = rest.search(/\n\}\n/);
  return end < 0 ? null : rest.slice(0, end + 3);
}

const callApiSrc = grabFn('callAPI', true);
check('renderer から callAPI() を取り出せる', !!callApiSrc && callApiSrc.length > 2000,
  callApiSrc ? callApiSrc.length : null);

const memSrc = ['recordLunaTurn', 'ensureConversationBox', 'saveConversationBox',
                'conversationSessionKey', 'addMsg', 'convoLog'].map(n => grabFn(n, false));
check('記憶まわりの関数も取り出せる', memSrc.every(Boolean),
  memSrc.map((v, i) => v ? 'ok' : ['recordLunaTurn','ensureConversationBox','saveConversationBox',
    'conversationSessionKey','addMsg','convoLog'][i]));

if (!callApiSrc || !memSrc.every(Boolean)) {
  console.log(`\n[callAPI stream memory] 合格 ${pass} / 不合格 ${fail}`);
  process.exit(1);
}

const decls = (renderer.match(/const CONVO_BOX_KEY='[^']+';/) || [''])[0]
  + '\n' + (renderer.match(/let _convoBox=null;/) || [''])[0];

// ── 外界だけ偽装する。ストリームは本物のチャンク列で流す ────────────────
function makeContext(chunks, options = {}) {
  const ctxErrors = [];
  const store = {};
  const spoken = [];
  const requests = [];
  const brainCompleted = [];
  const enc = new TextEncoder();
  let idx = 0;
  const ctx = {
    // ★ここが本体：本番と同じ getReader() のインターフェースで分割配信する
    fetch: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return ({
      ok: true,
      // 本番は X-Pitwall-Authority / X-Pitwall-Intent をヘッダで受ける
      headers: { get: (k) => (k === 'X-Pitwall-Authority' ? 'llm' : '') },
      body: {
        getReader: () => ({
          read: async () => (idx < chunks.length
            ? { done: false, value: enc.encode(chunks[idx++]) }
            : { done: true, value: undefined }),
        }),
      },
      });
    },
    TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout,
    Date, JSON, Math, String, Number, Error, RegExp, Promise, console,
    window: { PitwallConversationMemoryBox: box, PitwallDisputeDetector: det,
      PitwallReflexEvents: null },
    localStorage: { getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); } },
    document: {
      getElementById: () => ({ classList: { add(){}, remove(){} },
        appendChild(){}, scrollTop: 0, scrollHeight: 0, value: '', style: {} }),
      createElement: () => ({ className: '', textContent: '' }),
    },
    // 記憶と無関係な依存は無害なスタブにする
    usageCount(){}, applyPitwallAccess(){}, costApiCall(){}, costRecord(){},
    diagnosticLog(tag, msg){ if(String(tag)==='CLIENT ERROR') ctxErrors.push(String(msg).slice(0,150)); },
    mirrorToOverlay(){}, flushSentences(){},
    // `t()` は i18n。catch 節で使われるので、呼ばれたら**本体が例外を投げた**証拠になる。
    t: (k) => { ctxErrors.push('reached_catch:' + k); return String(k); },
    forwardDriverDamageReport(){}, hydrateLegacyStrategyObjective: () => ({}),
    loadProfile: () => ({}), buildProfileNote: () => '', buildCarTrackMemory: () => '',
    buildPracticeProfileNote: () => '', buildFuelAuthorityNote: () => '',
    buildWeekendAuthorityNote: () => '', buildCurrentSessionFactNote: () => '',
    buildSessionEvidenceNote: () => '', buildContractNote: () => '',
    buildActiveRaceFactsNote: () => '', buildMemoryStatusNote: () => '',
    currentMemoryBrainPrompt: () => options.brainPrompt || '',
    completeMemoryBrainTurn: reply => { brainCompleted.push(reply); return options.brainRecord || null; },
    buildRaceHistoryContext: () => '', buildNamedRivalNote: () => '',
    hasTelemetryOwnedVehicleClaim: () => false,
    normalizeLunaSpeech: (t) => t,
    speak: (t) => { spoken.push(t); },
    // ★2026-09-05 第6回P1：内部IDが**実際に付いた履歴**を送信させないと反証にならない。
    //   本番と同じく非列挙で `_mid` を付ける。
    _msgSeq: 0,
    pushMsg(m){
      if(m && typeof m==='object' && !m._mid){
        Object.defineProperty(m,'_mid',{value:'m'+(++ctx._msgSeq),
          enumerable:false, writable:true, configurable:true});
      }
      ctx.messages.push(m); return m && m._mid ? m._mid : null;
    },
    // 会話状態
    sel: 'LunaJP', selMode: 'race', userName: 'Yuji', messages: [],
    turns: 0, sessionMsgCount: 0, isBusy: false,
    iracingLive: true, bridgeConnected: true, lastTelemetry: {}, lastTelemetryAt: Date.now(),
    lastSessionType: 'Race', lastSessionAuthority: null, lastCarClass: 'GT3',
    lastCarModel: 'AMG', lastTrack: 'Le Mans', lastSessionNum: 9,
    driverState: 'track', driverActivity: 'ACTIVE',
    API_BASE: '', usageBuild: 'test', usageSessionId: 's',
    currentMemoryUserId: () => 'Yuji',
    memorySavedThisSession: true, evidenceDebrief: null,
    responseIntent: null, responseAuthority: 'llm',
    SPEAK_PRIO: { P0_SAFETY: 0, P1_URGENT: 1, P2_PROCEDURE: 2, P3_INFO: 3, P4_INFO: 4 },
    jamesAutoMicEnabled: undefined,
    updateNamedRivalFromUser: () => null,
    lastSectors: () => null,
    speakReplyChunk: t => { spoken.push(t); },
    _spoken: spoken, _store: store, _errors: ctxErrors, _requests: requests,
    _brainCompleted: brainCompleted,
  };
  ctx.globalThis = ctx;
  ctx.window.localStorage = ctx.localStorage;
  return ctx;
}

// ── 実行：ストリームを3チャンクに割って流す ───────────────────────────
const CHUNKS = ['後ろ0', '.0秒。前', 'とは1.2秒。'];
const FULL = CHUNKS.join('');

let ranOk = false;
const ctx = makeContext(CHUNKS);
vm.createContext(ctx);
try {
  vm.runInContext(decls + '\n' + memSrc.join('\n') + '\n' + callApiSrc
    + '\nthis.callAPI = callAPI; this.ensureConversationBox = ensureConversationBox;', ctx);
  ranOk = true;
} catch (e) {
  check('callAPI をコンテキストへ読み込める', false, String(e.message).slice(0, 160));
}

if (ranOk) {
  check('callAPI をコンテキストへ読み込める', true);
  (async () => {
    let threw = null;
    try { await ctx.callAPI('typed'); } catch (e) { threw = String(e.message).slice(0, 120); }

    // 実行が最後まで届かなかった場合、それ自体を失格として出す（緑にしない）
    // `t()` は catch 節でしか使われない i18n。呼ばれていたら本体が例外を投げた証拠。
    const reachedCatch = ctx._errors.some(e => String(e).startsWith('reached_catch'));
    check('callAPI が例外なく完走する（catch 節へ落ちていない）',
      threw === null && !reachedCatch, { threw, errors: ctx._errors });

    const b = ctx.ensureConversationBox();
    const lunaTurns = b ? b.turns.filter(t => t.who === 'luna') : [];

    check('★ストリーム完了後、Luna の回答が箱へ入る',
      lunaTurns.length === 1, { turns: b && b.turns.map(t => [t.who, t.text]) });
    check('保存されたのは結合後の全文（途中チャンクではない）',
      lunaTurns[0] && lunaTurns[0].text === FULL, lunaTurns[0] && lunaTurns[0].text);
    check('kind が streamed_reply（定型応答と区別できる）',
      lunaTurns[0] && lunaTurns[0].kind === 'streamed_reply', lunaTurns[0] && lunaTurns[0].kind);
    check('箱が localStorage へ永続化される',
      typeof ctx._store['pw_conversation_box_v1'] === 'string', Object.keys(ctx._store));

    // ★本題：この文脈で次ターンの訂正が成立するか
    const hit = det.detect('後ろ2.0 だね。ギャップ。', {
      lunaTurns: box.turnContext(b, Date.now()).filter(t => t.who === 'luna'),
      reflexes: box.reflexContext(b, Date.now()), at: Date.now(),
    });
    check('★callAPI 経由の文脈から、次ターンの訂正が検出される',
      !!hit && hit.confidence === 'confirmed' && hit.axis === 'gap_behind', hit);

    // ── Codex §10 が挙げた3出口を、すべて実行で確かめる ────────────────
    //   ①ストリーミング完了 ②Truth Gate fallback ③通信エラー
    console.log('\n══ 全 Luna 出力の出口（Codex §10） ══');
    {
      const renderer2 = renderer;   // 同じ内容
      // ② Truth Gate fallback は `display` に含まれるので①と同じ出口を通る
      check('② Truth Gate fallback は display 経由で①と同じ出口を通る',
        /const display = truthBlocked\s*\n\s*\? truthFallback/.test(renderer2)
        && renderer2.includes("recordLunaTurn(display, 'streamed_reply')"));
      // ③ 通信エラーは addMsg('sys',…) しか通らないので個別接続が要る
      check('③ 通信エラーの発話も箱へ記録する',
        renderer2.includes("recordLunaTurn(errMsg, 'connection_error')"));
      const codeLines = renderer2.split('\n').filter(l => !/^\s*(\/\/|\*|#)/.test(l));
      const calls = codeLines.filter(l => /recordLunaTurn\(/.test(l)).length;
      check('実呼出しは 定義1＋addMsg1＋stream1＋error1 の計4箇所',
        calls === 4, { calls, lines: codeLines.filter(l => /recordLunaTurn\(/.test(l)).map(l => l.trim().slice(0, 52)) });
    }

    // ── 通信エラー経路を実行する（fetch が失敗する場合） ──────────────
    {
      const errCtx = makeContext([]);
      errCtx.fetch = async () => { throw new Error('network down'); };
      vm.createContext(errCtx);
      vm.runInContext(decls + '\n' + memSrc.join('\n') + '\n' + callApiSrc
        + '\nthis.callAPI = callAPI; this.ensureConversationBox = ensureConversationBox;', errCtx);
      await errCtx.callAPI('typed');
      const eb = errCtx.ensureConversationBox();
      const turns = eb ? eb.turns.filter(t => t.who === 'luna') : [];
      check('★通信エラー時も Luna の発話が箱へ入る（実行）',
        turns.length === 1 && turns[0].kind === 'connection_error',
        eb && eb.turns.map(t => [t.who, t.kind, t.text.slice(0, 20)]));
      check('通信エラーの直後でも次ターンの文脈が空でない',
        box.turnContext(eb, Date.now()).filter(t => t.who === 'luna').length === 1);
    }

    // ── Memory Brain の実製品出口：prompt注入→stream→TTS→再保存 ───
    {
      const brainPrompt='\n\n━━ LUNA MEMORY BRAIN ━━\n{"memory_ids":["race|88462769|315555"],"positions_gained":2}';
      const reply='危険を避けながらP10からP8、1xで50を持ち帰った。判断は正しかった。';
      const brainCtx=makeContext([reply.slice(0,18),reply.slice(18)],{brainPrompt,brainRecord:{memory_id:'evaluation|1'}});
      vm.createContext(brainCtx);
      vm.runInContext(decls + '\n' + memSrc.join('\n') + '\n' + callApiSrc+'\nthis.callAPI=callAPI;',brainCtx);
      await brainCtx.callAPI('typed');
      check('Memory Brain検索結果が実callAPI requestへ注入される',
        brainCtx._requests[0]&&brainCtx._requests[0].profileNote.includes('race|88462769|315555'));
      check('Memory Brain根拠付き回答が実ストリームからTTSへ出る',
        brainCtx._spoken.join('').includes('P10からP8')&&brainCtx._spoken.join('').includes('判断は正しかった'),brainCtx._spoken);
      check('実回答全文がMemory Brain復路へ再保存される',
        brainCtx._brainCompleted.length===1&&brainCtx._brainCompleted[0]===reply,brainCtx._brainCompleted);
    }

    // ══ ★2026-09-05 Codex 第6回P1：送信payloadに内部IDを漏らさない ══
    //   `_mid` は内部管理用で、Anthropic の messages schema は role/content のみ。
    //   列挙可能なまま持つと `JSON.stringify(chatBody)` で外部APIまで届く。
    {
      console.log('\n══ 送信payload：内部IDを外部APIへ出さない ══');
      // ★履歴が空だと「キーが正しい」が空配列で通ってしまう。
      //   内部IDの付いた履歴を実際に積んでから、実 callAPI() で送らせる。
      ctx.pushMsg({ role:'user', content:'後ろとのギャップは？' });
      ctx.pushMsg({ role:'assistant', content:'後ろ3.8秒。' });
      ctx._requests.length = 0;
      await ctx.callAPI('ptt');

      const sent = (ctx._requests || []).filter(r => r && Array.isArray(r.messages));
      check('送信payloadを捕捉できた', sent.length > 0, String(sent.length));
      const allMsgs = sent.flatMap(r => r.messages);
      check('送信メッセージが1件以上ある', allMsgs.length > 0, String(allMsgs.length));

      const ALLOWED = new Set(['role','content']);
      const badKeys = [];
      for (const m of allMsgs) {
        for (const k of Object.keys(m || {})) if (!ALLOWED.has(k)) badKeys.push(k);
      }
      check('★送信メッセージのキーが role/content だけ', badKeys.length === 0,
        JSON.stringify([...new Set(badKeys)]));
      check('★内部ID `_mid` が送信payloadに0件',
        !JSON.stringify(sent).includes('_mid'),
        JSON.stringify(sent).slice(0, 200));

      // 内部では ID が生きていること（外部から消しても機能が壊れていない）
      // ★多層防御は end-to-end 検査だけでは**片方を外しても緑**になる。
      //   Codex 受入条件④（配線を一つ外すと赤）を満たすため、各層を個別に固定する。
      const rsrc = fs.readFileSync(path.join(__dirname, 'desktop', 'renderer.html'), 'utf8');
      // 層A：`_mid` は非列挙で持つ
      // 本番の pushMsg を renderer から取り出して、この1件だけで層Aを固定する。
      //   （ハーネスの pushMsg は模造なので、それを見ても製品の契約にならない）
      const _pushSrc = (fs.readFileSync(path.join(__dirname,'desktop','renderer.html'),'utf8')
        .match(/function pushMsg\(m\)\{[\s\S]*?\n\}/) || [''])[0];
      const _probeCtx = { messages: [], MAX_CLIENT_MESSAGES: 40, _msgSeq: 0, Object };
      _probeCtx.globalThis = _probeCtx;
      vm.createContext(_probeCtx);
      vm.runInContext(_pushSrc + '\nthis.pushMsg = pushMsg;', _probeCtx);
      const probe = { role:'user', content:'x' };
      _probeCtx.pushMsg(probe);
      const desc = Object.getOwnPropertyDescriptor(probe, '_mid');
      check('層A：内部IDは非列挙プロパティ', !!desc && desc.enumerable === false,
        JSON.stringify(desc));
      // 層B：送信境界が role/content だけへ絞る
      check('層B：送信境界に明示のホワイトリストがある',
        /const outboundMessages = \(Array\.isArray\(messages\)\?messages:\[\]\)\s*\n\s*\.map\(m => \(\{ role:m\.role, content:m\.content \}\)\);/.test(rsrc)
        && /messages: outboundMessages,/.test(rsrc));
      // 層C：サーバー側も同じ契約で絞る
      const ssrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
      check('層C：サーバーも role/content だけへ絞る',
        /messages: safeMessages/.test(ssrc)
        && /\.map\(m => \(\{ role: m && m\.role, content: m && m\.content \}\)\)/.test(ssrc));

      const withMid = (ctx.messages || []).filter(m => m && m._mid);
      check('内部では message ID が保持されている', withMid.length > 0,
        String((ctx.messages||[]).length));
      check('内部IDは列挙されない（JSON化しても出ない）',
        (ctx.messages||[]).every(m => !JSON.stringify(m).includes('_mid')),
        JSON.stringify(ctx.messages||[]).slice(0,160));
    }

    console.log(`\n[callAPI stream memory] 合格 ${pass} / 不合格 ${fail}`);
    console.log('\n※ ここまでで確かめたのは callAPI のストリーム分岐までである。');
    console.log('   PTT→STT→訂正→ACK→TTS、Windows実機、実走は Gate 6/8 で未確認。');
    process.exit(fail ? 1 : 0);
  })();
} else {
  console.log(`\n[callAPI stream memory] 合格 ${pass} / 不合格 ${fail}`);
  process.exit(1);
}
