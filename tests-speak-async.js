// ══════════════════════════════════════════════════════════════════════
// 非同期割り込みテスト（Codex再レビュー P0-2 への対応）
//   指摘：前回の割り込みテストは stopCurrentAudio/drainQueue をテスト内に
//   再実装した「写経」で、本番の await fetch や Audio callback を通っておらず、
//   非同期競合を検出できない。写経を増やすと実装とテストが再び乖離する。
//
//   対策：**desktop/renderer.html から本物の関数定義を抽出して実行する**。
//   単一の真実（renderer.html）をテストするので、実装を変えればテストも追随する。
//   ブラウザAPI（fetch / Audio / speechSynthesis / WebSocket）はスタブで置き換える。
// ══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(__dirname + '/desktop/renderer.html', 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.reduce((a, b) => (a.length > b.length ? a : b));

// 本番から検証対象の関数だけを切り出す（定義の先頭から次のトップレベル定義の直前まで）
function extract(name, kind) {
  const head = kind === 'async' ? `async function ${name}(` : `function ${name}(`;
  const i = src.indexOf(head);
  if (i < 0) throw new Error('本番コードに ' + name + ' が見つからない（実装が変わった可能性）');
  const rest = src.slice(i);
  const end = rest.search(/\n(?:async function |function |const |let |\/\/ ──)/);
  return rest.slice(0, end > 0 ? end : rest.length);
}

const parts = ['speak', 'speechMayStart', 'drainQueue', 'stopCurrentAudio', 'onUtteranceDone', 'playWebSpeech']
  .map(n => extract(n, n === 'drainQueue' ? 'async' : 'fn')).join('\n');

// ── テスト用のスタブ環境 ──
let ttsResolve = null;                 // TTS取得の完了を手動で制御する
const played = [];                     // 実際に再生された音声（順序と内容）
const audioInstances = [];             // 本番コードが生成したAudio（callbackを本物のまま検証する）
const utterances = [];                 // 本番コードが生成したWeb Speech utterance（onendを本物のまま検証する）
const wsCancels = [];                  // speechSynthesis.cancel() の呼び出し記録
const spokeReports = [];               // bridgeへ送られた 'spoke'（予算計上）

const sandbox = {
  console,
  setTimeout, clearTimeout,
  // 状態変数（本番と同じ初期値）
  speakQueue: [], draining: false, isSpeaking: false, speakWatchdog: null,
  ttsAudio: null, currentSpeakPrio: 9, speakGeneration: 0, speakFetchCtrl: null,
  voiceOn: true, sel: 'LunaJP', pwVolume: 1, ttsDisabledUntil: 0,
  autoMicActive: false, autoMicRec: null, isBusy: false,
  jamesAutoMicEnabled: false, jamesMuted: false, startAutoMic: ()=>{},
  MAX_RADIO_QUEUE: 2,
  speakWindowOk: true, speakGateActive: false,
  IMMEDIATE_PIT_KINDS: new Set(['pit_entry','limiter_off','pit_box_here','pit_box_stop','pit_box_countdown']),
  SPEAK_PRIO: { P0_SAFETY: 0, P1_HAZARD: 1, P2_PROCEDURE: 2, P3_STRATEGY: 3, P4_INFO: 4, P5_CHAT: 5 },
  CHARS: { LunaJP: { gVoice: 'ja-JP-x', gLang: 'ja-JP', gRate: 1, gPitch: 0, voiceLang: 'ja-JP', pitch: 1, rate: 1, voiceNames: [] } },
  API_BASE: 'http://x',
  // 依存関数のスタブ
  phonetify: t => t, stripMarkdown: t => t, stripParens: t => t, stripEmoji: t => t,
  pickVoice: () => null,
  irBridge: { readyState: 1, send: (j) => spokeReports.push(JSON.parse(j)) },
  // ★2026-07-23 speak()がusageSessionId計測のためlocalStorage.getItem('pw_auth_token')を
  //   参照するようになった（Codexレビュー対応）。本番同様に未ログイン状態を模擬する。
  localStorage: { getItem: () => null, setItem: () => {} },
  usageSessionId: 'test-usage-session-id',
  // ★2026-07-23 診断計装：ttsFailLogは本番でrenderer.htmlにdefineされているが、
  //   このテストではspeak/drainQueue/playWebSpeechしか抽出しないためスタブが必要。
  ttsFailLog: () => {},
  AbortController: class { constructor(){ this.signal={aborted:false}; } abort(){ this.signal.aborted=true; } },
  // TTS取得：テストが好きなタイミングで完了させられる
  fetch: () => new Promise((res, rej) => { ttsResolve = { res, rej }; }),
  Audio: class {
    constructor(srcUrl){ this.src = srcUrl; this.volume = 1; this.onended = null; this.onerror = null;
      audioInstances.push(this); }   // ★本番が付けた onended を後で呼ぶために保持する
    async play(){ played.push(this.src); }
    pause(){ this.paused = true; }
  },
  speechSynthesis: { cancel(){ wsCancels.push(Date.now()); },
                     speak(u){ played.push('webspeech:'+u.text); utterances.push(u); } },
  SpeechSynthesisUtterance: class { constructor(t){ this.text = t; } },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(parts, sandbox);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  ✅ ' : '  ❌ ') + name); };
const reset = () => {
  sandbox.speakQueue = []; sandbox.draining = false; sandbox.isSpeaking = false;
  sandbox.ttsAudio = null; sandbox.currentSpeakPrio = 9; sandbox.speakGeneration = 0;
  sandbox.speakFetchCtrl = null; sandbox.speakWatchdog = null;
  played.length = 0; spokeReports.length = 0; ttsResolve = null;
  audioInstances.length = 0; utterances.length = 0; wsCancels.length = 0;
  sandbox.ttsDisabledUntil = 0;
};

(async () => {
  console.log('══ 非同期割り込み（本番コードを renderer.html から抽出して実行）══\n');

  // ① TTS取得中に割り込まれたP4は、後から再生されてはいけない
  reset();
  sandbox.speak('情報', { prio: 4, kind: 'info' });
  await sleep(5);
  const p4Fetch = ttsResolve;                       // P4がfetch待ちで止まっている
  check('P4がTTS取得中（まだ再生されていない）', played.length === 0 && p4Fetch !== null);
  sandbox.speak('停止車両', { prio: 0, kind: 'stopped_ahead' });   // P0到着＝割り込み
  await sleep(5);
  p4Fetch.res({ status: 200, ok: true, json: async () => ({ audioContent: 'P4AUDIO' }) });  // 遅れて完了
  await sleep(10);
  check('割り込まれたP4は再生されない', !played.includes('data:audio/mp3;base64,P4AUDIO'));
  check('P0のfetchが開始されている', ttsResolve !== null && ttsResolve !== p4Fetch);

  // ② P0再生中に、旧P4の**本番が付けた**遅延onendedがP0の状態を解除しない
  reset();
  sandbox.speak('情報', { prio: 4 });
  await sleep(5);
  ttsResolve.res({ status: 200, ok: true, json: async () => ({ audioContent: 'P4' }) });
  await sleep(10);
  const p4Audio = audioInstances[audioInstances.length - 1];   // 本番が生成し、本番がcallbackを付けたAudio
  check('P4のAudioが本番コードで生成された', !!p4Audio && typeof p4Audio.onended === 'function');
  // ブラウザが既にcallbackをスケジュール済みの状況を再現する：割り込み前に本番のcallbackを捕まえておく
  const staleCb = p4Audio.onended;
  sandbox.speak('停止車両', { prio: 0 });                        // 割り込み
  await sleep(5);
  check('P0が再生中', sandbox.isSpeaking === true);
  staleCb();                                                    // ★本番のcallbackが遅れて発火
  check('旧世代の遅延onendedはP0の再生状態を壊さない', sandbox.isSpeaking === true && sandbox.draining === true);

  // ③ 2回連続割り込み：最新世代だけが生きる
  reset();
  sandbox.speak('情報', { prio: 4 });   await sleep(5);
  sandbox.speak('速いクラス', { prio: 1 }); await sleep(5);
  const genAfter1 = sandbox.speakGeneration;
  sandbox.speak('停止車両', { prio: 0 }); await sleep(5);
  check('割り込むたびに世代が進む', sandbox.speakGeneration > genAfter1);
  check('再生処理は1本だけ（drainingが多重化しない）', sandbox.draining === true);

  // ④ 'spoke'（予算計上）は実際に再生された分だけ
  reset();
  sandbox.speak('情報', { prio: 4 });
  await sleep(5);
  check('取り出しただけでは計上しない', spokeReports.length === 0);
  const f = ttsResolve;
  f.res({ status: 200, ok: true, json: async () => ({ audioContent: 'OK' }) });
  await sleep(10);
  check('再生開始後に1回だけ計上される', spokeReports.filter(r => r.cmd === 'spoke').length === 1);


  // ⑤【Codex #6】Web Speech：cancel後に遅れて届く旧onendがP0を壊さない
  //    ※前回の依頼書で「テスト済み」と書いたが、実際にはこの経路を一度も通していなかった。
  reset();
  sandbox.ttsDisabledUntil = Date.now() + 60000;      // Cloud TTSを無効化＝Web Speechへ強制フォールバック
  sandbox.speak('情報', { prio: 4 });
  await sleep(10);
  const p4Utt = utterances[utterances.length - 1];
  check('[WS] P4がWeb Speechで再生された', played.some(x => x.startsWith('webspeech:')) && !!p4Utt);
  check('[WS] 本番がonendを付けている', typeof p4Utt.onend === 'function');
  const staleOnEnd = p4Utt.onend;                     // 割り込み前に本番のcallbackを捕まえる
  sandbox.speak('停止車両', { prio: 0 });              // 割り込み
  await sleep(10);
  check('[WS] 割り込みでcancelが呼ばれた', wsCancels.length >= 1);
  const wsSpeakingBefore = sandbox.isSpeaking, wsDrainingBefore = sandbox.draining;
  staleOnEnd();                                       // ★旧utteranceのonendが遅れて届く
  check('[WS] 旧onendはP0のisSpeaking/drainingを解除しない',
        sandbox.isSpeaking === wsSpeakingBefore && sandbox.draining === wsDrainingBefore);

  // ⑥【Codex #7】2回連続割り込み：最新のP0だけが実際に再生され、計上も1回だけ
  //    ※前回は世代が進むこととdrainingしか見ておらず「最新世代だけが再生される」を確認していなかった。
  reset();
  sandbox.speak('情報', { prio: 4 });        await sleep(5); const f4 = ttsResolve;
  sandbox.speak('速いクラス', { prio: 1 });   await sleep(5); const f1 = ttsResolve;
  sandbox.speak('停止車両', { prio: 0 });     await sleep(5); const f0 = ttsResolve;
  check('[連続] 3件それぞれがfetchを開始した', f4 && f1 && f0 && f4 !== f1 && f1 !== f0);
  f4.res({ status: 200, ok: true, json: async () => ({ audioContent: 'AUD_P4' }) });
  f1.res({ status: 200, ok: true, json: async () => ({ audioContent: 'AUD_P1' }) });
  f0.res({ status: 200, ok: true, json: async () => ({ audioContent: 'AUD_P0' }) });
  await sleep(20);
  const playedAudio = played.filter(x => x.startsWith('data:audio/mp3'));
  check('[連続] 旧世代(P4/P1)は再生されない',
        !playedAudio.some(x => x.includes('AUD_P4')) && !playedAudio.some(x => x.includes('AUD_P1')));
  check('[連続] 最新のP0だけが再生される',
        playedAudio.length === 1 && playedAudio[0].includes('AUD_P0'));
  check('[連続] 予算計上も1回だけ', spokeReports.filter(r => r.cmd === 'spoke').length === 1);

  console.log('\n[非同期割り込み] 合格 ' + pass + ' / 不合格 ' + fail);
  process.exit(fail ? 1 : 0);
})();
