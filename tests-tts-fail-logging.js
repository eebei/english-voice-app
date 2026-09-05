// ══════════════════════════════════════════════════════════════════════
// TTS/Audio失敗経路の診断計装テスト（Codex再指摘 2026-07-23 対応）
//   本番renderer.htmlのspeak/drainQueue/playWebSpeechをvm.runInContextで実行し、
//   9経路それぞれで正しいkindが1回だけログされ、フォールバックが1回だけ発火し、
//   reportSpokeも1回だけ発火することを検証する。
//
//   Codex指摘の欠陥2件を検出する能力：
//   - P0: onerror+play rejectの二重フォールバック → WebSpeech呼び出しが1回でなく2回になる
//   - P1: HTTP/空audioがcatchで cloud_tts_fetch_error として二重記録 →
//         ログkind一覧に cloud_tts_http + cloud_tts_fetch_error が両方出現する
//
//   スタブは fetch レスポンス・Audio 挙動をテスト側で完全に制御できるようにする。
// ══════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(__dirname + '/desktop/renderer.html', 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.reduce((a, b) => (a.length > b.length ? a : b));

// 既存のtests-speak-async.jsと同じ抽出方式（同じ本番ソースが対象）
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

// テストごとに新しいサンドボックスを作って独立実行する
function makeSandbox({ fetchImpl, AudioImpl, webSpeechImpl, voiceLang = 'ja-JP', gVoice = 'ja-JP-x' }) {
  const state = {
    ttsFails: [],           // ttsFailLog呼び出し
    spokeReports: [],       // 'spoke'計上
    webSpeechCalls: [],     // playWebSpeech内でspeechSynthesis.speakへ渡されたutterance
    audioInstances: [],     // 生成されたAudio
    audioPlayed: [],        // 実際にplay()が呼ばれたAudio
    audioPlayResolves: 0,   // play()が解決した回数
    webSpeechCancels: 0,
    utteranceDoneCalls: 0,  // onUtteranceDoneが呼ばれた回数
  };
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    speakQueue: [], draining: false, isSpeaking: false, speakWatchdog: null,
    ttsAudio: null, currentSpeakPrio: 9, speakGeneration: 0, speakFetchCtrl: null,
    voiceOn: true, sel: 'LunaJP', pwVolume: 1, ttsDisabledUntil: 0,
    autoMicActive: false, autoMicRec: null, isBusy: false,
    jamesAutoMicEnabled: false, jamesMuted: false, startAutoMic: () => {},
    MAX_RADIO_QUEUE: 2,
    speakWindowOk: true, speakGateActive: false,
    IMMEDIATE_PIT_KINDS: new Set(['pit_entry','limiter_off','pit_box_here','pit_box_countdown']),
    SPEAK_PRIO: { P0_SAFETY: 0, P1_HAZARD: 1, P2_PROCEDURE: 2, P3_STRATEGY: 3, P4_INFO: 4, P5_CHAT: 5 },
    CHARS: { LunaJP: { gVoice, gLang: 'ja-JP', gRate: 1, gPitch: 0, voiceLang, pitch: 1, rate: 1, voiceNames: ['test-voice'] } },
    API_BASE: 'http://x',
    phonetify: t => t, normalizeLunaSpeech: t => t,
    stripMarkdown: t => t, stripParens: t => t, stripEmoji: t => t,
    pickVoice: () => webSpeechImpl && webSpeechImpl.pickVoiceReturn !== undefined ? webSpeechImpl.pickVoiceReturn : { name: 'test' },
    localStorage: { getItem: () => null, setItem: () => {} },
    usageSessionId: 'test-usage-session-id',
    irBridge: {
      readyState: 1,
      send: (j) => {
        try {
          const msg = JSON.parse(j);
          if (msg.cmd === 'spoke') state.spokeReports.push(msg);
          else if (msg.cmd === 'log_line' && String(msg.text || '').startsWith('[TTS_FAIL]')) {
            // ttsFailLogが送るbridgeログ経路（本番と同じ）
            state.ttsFails.push(msg.text);
          }
        } catch (_) {}
      },
    },
    // 本番のttsFailLogを直接スタブに置き換え（bridgeログ経路も維持したいので両立させる）
    ttsFailLog: (where, detail) => {
      state.ttsFails.push('[TTS_FAIL] ' + where + ' | ' + (detail || ''));
    },
    ttsEventLog: () => {},
    AbortController: class {
      constructor() { this.signal = { aborted: false }; }
      abort() { this.signal.aborted = true; if (this._onabort) this._onabort(); }
    },
    fetch: fetchImpl,
    Audio: AudioImpl,
    speechSynthesis: {
      cancel: () => { state.webSpeechCancels++; },
      speak: (utt) => {
        state.webSpeechCalls.push(utt);
        // WebSpeech本体の挙動をテストが指定可能
        if (webSpeechImpl && webSpeechImpl.throwOnSpeak) throw new Error(webSpeechImpl.throwOnSpeak);
        // ★2026-09-05：実際の WebSpeech は speak() の後 onstart で再生が始まる。
        //   reportSpoke は**開始してから**呼ぶ契約になったので、ここで onstart を模す。
        //   onerror を指定したケースでは onstart を発火させない＝一度も音が出ていない。
        if (!(webSpeechImpl && (webSpeechImpl.fireOnError || webSpeechImpl.suppressOnStart))
            && utt.onstart) utt.onstart();
        setTimeout(() => {
          if (webSpeechImpl && webSpeechImpl.fireOnError) {
            if (utt.onerror) utt.onerror({ error: webSpeechImpl.fireOnError });
          } else if (utt.onend) {
            utt.onend();
          }
        }, 1);
      },
    },
    SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
  };
  sandbox.window = sandbox;
  // onUtteranceDoneが元々グローバル依存なので、呼び出し回数を数える差し替え関数を注入
  sandbox._testOrigOnUtteranceDone = null;   // 抽出関数で上書きされる
  // ★2026-09-05：発話の終端集約（utterance_id／finalizer）を製品へ入れたため、
  // 抽出実行するハーネスにも同じ記号を置く。ここでの finalizer は
  // 「呼ばれたことを記録するだけ」で、契約は tests-gap-display-sync.js が持つ。
  sandbox._uttSeq = 0;
  sandbox.nextUtteranceId = () => 'u' + (++sandbox._uttSeq);
  sandbox.__finalized = [];
  sandbox.finalizeUtterance = (item, outcome, finalText, reason) => {
    sandbox.__finalized.push({ uid: item && item.utteranceId, outcome, reason });
  };
  sandbox.discardQueuedUtterances = (items, reason) => {
    (items || []).forEach(i => sandbox.finalizeUtterance(i, 'dropped', null, reason));
  };
  vm.createContext(sandbox);
  vm.runInContext(parts, sandbox);
  // 抽出でloadされたonUtteranceDoneをラップして呼び出し回数を数える
  const origOUD = sandbox.onUtteranceDone;
  sandbox.onUtteranceDone = function () { state.utteranceDoneCalls++; return origOUD(); };
  return { sandbox, state };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (cond ? '' : (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')));
};

// Audio共通スタブ（テストごとに挙動を分岐）
function makeAudio({ playRejects, fireOnError, fireOnended, fireOnendedThenOnError }) {
  return class {
    constructor(url) {
      this.src = url; this.volume = 1; this.onended = null; this.onerror = null;
      this._playRejects = playRejects;
      this._fireOnError = fireOnError;
      this._fireOnended = fireOnended;
      this._fireOnendedThenOnError = fireOnendedThenOnError;
      if (fireOnError || fireOnendedThenOnError) this.error = { code: 4, message: 'MEDIA_ELEMENT_ERROR: unsupported' };
    }
    async play() {
      // onerror発火オプションがあれば、play()の内側で発火させる（実ブラウザで両方起きるケースを模擬）
      if (this._fireOnError) {
        setTimeout(() => { if (this.onerror) this.onerror(new Event('error')); }, 0);
      }
      // 正常完了(onended)を発火させるオプション
      if (this._fireOnended) {
        setTimeout(() => { if (this.onended) this.onended(); }, 1);
      }
      // 正常完了 → その直後に遅延 onerror が来るケース（_completed guard の検証用）
      if (this._fireOnendedThenOnError) {
        setTimeout(() => { if (this.onended) this.onended(); }, 1);
        setTimeout(() => { if (this.onerror) this.onerror(new Event('error')); }, 2);
      }
      if (this._playRejects) {
        throw new Error(this._playRejects);
      }
    }
    pause() {}
  };
}

async function runCase(label, opts, verify, speakOpts = { prio: 0, kind: 'stopped_ahead' }) {
  console.log('\n══ ' + label + ' ══');
  const { sandbox, state } = makeSandbox(opts);
  sandbox.speak('テスト発話', speakOpts);
  await sleep(650);   // 250ms retry×1 + fetch/Audio/onerrorが全部落ち着くまで待つ
  verify(state);
}

// ── 各失敗経路 ────────────────────────────────────────────────

(async () => {
  // ケース1: HTTP 503 → cloud_tts_503のみ、WebSpeech 1回
  await runCase('HTTP 503 → cloud_tts_503のみ', {
    fetchImpl: async () => ({ status: 503, ok: false, json: async () => ({}) }),
    AudioImpl: makeAudio({}),
  }, (s) => {
    const kinds = s.ttsFails.map(l => l.split(' | ')[0].replace('[TTS_FAIL] ', ''));
    check('cloud_tts_503 が1回だけログされる', kinds.filter(k => k === 'cloud_tts_503').length === 1, kinds);
    check('cloud_tts_fetch_error は出ない (二重ログなし)', !kinds.includes('cloud_tts_fetch_error'), kinds);
    check('cloud_tts_http は出ない', !kinds.includes('cloud_tts_http'), kinds);
    check('WebSpeech呼び出しは1回だけ', s.webSpeechCalls.length === 1, s.webSpeechCalls.length);
    check('spokeReportは1回だけ', s.spokeReports.length === 1, s.spokeReports.length);
  });

  // ケース2: HTTP 500 → cloud_tts_httpのみ (cloud_tts_fetch_error二重ログしない=P1修正の検証)
  await runCase('HTTP 500 → cloud_tts_httpのみ (P1: 二重ログ再発防止)', {
    fetchImpl: async () => ({ status: 500, ok: false, json: async () => ({}) }),
    AudioImpl: makeAudio({}),
  }, (s) => {
    const kinds = s.ttsFails.map(l => l.split(' | ')[0].replace('[TTS_FAIL] ', ''));
    check('cloud_tts_http が1回だけログされる', kinds.filter(k => k === 'cloud_tts_http').length === 1, kinds);
    check('cloud_tts_fetch_error は出ない (P1修正の効き・throwせず早期return)',
      !kinds.includes('cloud_tts_fetch_error'), kinds);
    check('ttsFailログ総数は1つだけ', kinds.length === 1, kinds);
    check('WebSpeech呼び出しは1回だけ', s.webSpeechCalls.length === 1, s.webSpeechCalls.length);
    check('spokeReportは1回だけ', s.spokeReports.length === 1, s.spokeReports.length);
  });

  // ケース3: 空audioContent → cloud_tts_empty_audioのみ (二重ログしない)
  await runCase('空audioContent → cloud_tts_empty_audioのみ (P1: 二重ログ再発防止)', {
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({}) }),   // audioContent無し
    AudioImpl: makeAudio({}),
  }, (s) => {
    const kinds = s.ttsFails.map(l => l.split(' | ')[0].replace('[TTS_FAIL] ', ''));
    check('cloud_tts_empty_audio が1回だけログされる', kinds.filter(k => k === 'cloud_tts_empty_audio').length === 1, kinds);
    check('cloud_tts_fetch_error は出ない (P1修正の効き)', !kinds.includes('cloud_tts_fetch_error'), kinds);
    check('ttsFailログ総数は1つだけ', kinds.length === 1, kinds);
    check('WebSpeech呼び出しは1回だけ', s.webSpeechCalls.length === 1, s.webSpeechCalls.length);
  });

  // ケース4: fetch通常エラー → cloud_tts_fetch_error
  await runCase('fetch通常エラー → cloud_tts_fetch_error', {
    fetchImpl: async () => { throw new Error('network down'); },
    AudioImpl: makeAudio({}),
  }, (s) => {
    const kinds = s.ttsFails.map(l => l.split(' | ')[0].replace('[TTS_FAIL] ', ''));
    check('cloud_tts_fetch_error が1回だけログされる', kinds.filter(k => k === 'cloud_tts_fetch_error').length === 1, kinds);
    check('cloud_tts_timeout_5s は出ない', !kinds.includes('cloud_tts_timeout_5s'), kinds);
    check('WebSpeech呼び出しは1回だけ', s.webSpeechCalls.length === 1, s.webSpeechCalls.length);
  });

  // ケース5: fetchタイムアウト (AbortError) → cloud_tts_timeout_5s
  await runCase('fetchタイムアウト → cloud_tts_timeout_5s', {
    fetchImpl: async () => { const e = new Error('The user aborted a request.'); e.name = 'AbortError'; throw e; },
    AudioImpl: makeAudio({}),
  }, (s) => {
    const kinds = s.ttsFails.map(l => l.split(' | ')[0].replace('[TTS_FAIL] ', ''));
    check('cloud_tts_timeout_5s が1回だけログされる', kinds.filter(k => k === 'cloud_tts_timeout_5s').length === 1, kinds);
    check('cloud_tts_fetch_error は出ない (AbortErrorの分離)', !kinds.includes('cloud_tts_fetch_error'), kinds);
    check('WebSpeech呼び出しは1回だけ', s.webSpeechCalls.length === 1, s.webSpeechCalls.length);
  });

  // ケース6: audio.onerror + audio.play reject の両方発火 → WebSpeechは1回のみ (P0修正の検証)
  await runCase('audio.onerror + audio.play reject 両方発火 → WebSpeech1回のみ (P0: 二重フォールバック再発防止)', {
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ audioContent: 'BASE64DATA' }) }),
    AudioImpl: makeAudio({ playRejects: 'NotAllowedError: autoplay blocked', fireOnError: true }),
  }, (s) => {
    check('WebSpeech呼び出しは1回だけ (二重フォールバックしない)', s.webSpeechCalls.length === 1, s.webSpeechCalls.length);
    check('spokeReportは1回だけ (二重計上しない)', s.spokeReports.length === 1, s.spokeReports.length);
    check('utteranceDoneCalls === 1 (完了通知も1回だけ・キュー二重進行なし)', s.utteranceDoneCalls === 1, s.utteranceDoneCalls);
    // ログはaudio_element_onerror と audio_play_reject のどちらか片方だけ (先着1件のみ_fallbackOnceが受理)
    const kinds = s.ttsFails.map(l => l.split(' | ')[0].replace('[TTS_FAIL] ', ''));
    const audioKinds = kinds.filter(k => k === 'audio_element_onerror' || k === 'audio_play_reject');
    check('audio失敗ログは1件のみ (二重ログしない)', audioKinds.length === 1, audioKinds);
  });

  // ケース6b: audio.onerror のみ発火 (play() は resolve・遅延onerror) → 完了は1回 (Codex追加要求)
  //   実ブラウザで「play() は成功したが再生中にデコード失敗」で起きる状況を模擬。
  //   ここでフォールバックが2重に走ったり utteranceDone が2回呼ばれるとキュー二重進行になる。
  await runCase('audio.onerror のみ発火 (play resolve後の遅延onerror) → 各回数=1 (Codex追加要求)', {
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ audioContent: 'BASE64DATA' }) }),
    AudioImpl: makeAudio({ fireOnError: true }),   // playRejectsなし＝play()はresolve
  }, (s) => {
    const kinds = s.ttsFails.map(l => l.split(' | ')[0].replace('[TTS_FAIL] ', ''));
    check('audio_element_onerror が1回だけ', kinds.filter(k => k === 'audio_element_onerror').length === 1, kinds);
    check('audio_play_reject は出ない (play()はresolveしている)', !kinds.includes('audio_play_reject'), kinds);
    check('WebSpeech呼び出しは1回だけ (フォールバック1回)', s.webSpeechCalls.length === 1, s.webSpeechCalls.length);
    check('spokeReportは1回だけ', s.spokeReports.length === 1, s.spokeReports.length);
    check('utteranceDoneCalls === 1 (キュー二重進行なし)', s.utteranceDoneCalls === 1, s.utteranceDoneCalls);
  });

  // ケース6c: 正常完了(onended) → その直後の遅延onerror でも utteranceDone は1回 (_completed guard の検証)
  await runCase('正常完了(onended)後の遅延onerror → utteranceDoneCalls === 1 (_completed guard の効き)', {
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ audioContent: 'BASE64DATA' }) }),
    AudioImpl: makeAudio({ fireOnendedThenOnError: true }),
  }, (s) => {
    // audio.onendedで完了扱い後、遅延onerrorは_completed guardで無視されるべき
    check('spokeReportは1回だけ (play resolveで1回計上)', s.spokeReports.length === 1, s.spokeReports.length);
    check('utteranceDoneCalls === 1 (完了後の遅延onerrorで二重発火しない)', s.utteranceDoneCalls === 1, s.utteranceDoneCalls);
    check('WebSpeechは呼ばれない (既に完了しているのでフォールバック不要)', s.webSpeechCalls.length === 0, s.webSpeechCalls.length);
    const kinds = s.ttsFails.map(l => l.split(' | ')[0].replace('[TTS_FAIL] ', ''));
    check('audio_element_onerrorログは出ない (完了済みで無視)', !kinds.includes('audio_element_onerror'), kinds);
  });

  // ケース7: audio.play rejectのみ (onerror発火なし) → audio_play_reject
  await runCase('audio.play rejectのみ → audio_play_reject', {
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ audioContent: 'BASE64DATA' }) }),
    AudioImpl: makeAudio({ playRejects: 'NotAllowedError' }),
  }, (s) => {
    const kinds = s.ttsFails.map(l => l.split(' | ')[0].replace('[TTS_FAIL] ', ''));
    check('audio_play_reject が1回だけ', kinds.filter(k => k === 'audio_play_reject').length === 1, kinds);
    check('audio_element_onerror は出ない', !kinds.includes('audio_element_onerror'), kinds);
    check('WebSpeech呼び出しは1回だけ', s.webSpeechCalls.length === 1, s.webSpeechCalls.length);
    check('utteranceDoneCalls === 1', s.utteranceDoneCalls === 1, s.utteranceDoneCalls);
  });

  // ケース8: WebSpeech no-voice → webspeech_no_voice
  await runCase('WebSpeech pickVoice()==null → webspeech_no_voice', {
    fetchImpl: async () => ({ status: 503, ok: false, json: async () => ({}) }),   // Cloud 503でWebSpeechへ
    AudioImpl: makeAudio({}),
    webSpeechImpl: { pickVoiceReturn: null },
  }, (s) => {
    const kinds = s.ttsFails.map(l => l.split(' | ')[0].replace('[TTS_FAIL] ', ''));
    check('webspeech_no_voice が1回だけ', kinds.filter(k => k === 'webspeech_no_voice').length === 1, kinds);
    check('cloud_tts_503もログされている (経路確認)', kinds.includes('cloud_tts_503'), kinds);
  });

  // ケース9: WebSpeech utt.onerror発火 → webspeech_onerror
  await runCase('WebSpeech utt.onerror発火 → webspeech_onerror', {
    fetchImpl: async () => ({ status: 503, ok: false, json: async () => ({}) }),
    AudioImpl: makeAudio({}),
    webSpeechImpl: { fireOnError: 'synthesis-failed' },
  }, (s) => {
    const kinds = s.ttsFails.map(l => l.split(' | ')[0].replace('[TTS_FAIL] ', ''));
    check('webspeech_onerror が1回だけ', kinds.filter(k => k === 'webspeech_onerror').length === 1, kinds);
  });

  // ケース10: WebSpeech speak()throw → webspeech_throw
  await runCase('WebSpeech speak()throw → webspeech_throw', {
    fetchImpl: async () => ({ status: 503, ok: false, json: async () => ({}) }),
    AudioImpl: makeAudio({}),
    webSpeechImpl: { throwOnSpeak: 'speechSynthesis broken' },
  }, (s) => {
    const kinds = s.ttsFails.map(l => l.split(' | ')[0].replace('[TTS_FAIL] ', ''));
    check('webspeech_throw が1回だけ', kinds.filter(k => k === 'webspeech_throw').length === 1, kinds);
  });

  // ケース11: 通常会話はCloud失敗時に別人の機械音へ落とさない
  await runCase('通常会話のCloud失敗 → 機械音を抑止', {
    fetchImpl: async () => { throw new Error('network down'); },
    AudioImpl: makeAudio({}),
  }, (s) => {
    const kinds = s.ttsFails.map(l => l.split(' | ')[0].replace('[TTS_FAIL] ', ''));
    check('Cloud失敗は記録される', kinds.filter(k => k === 'cloud_tts_fetch_error').length === 1, kinds);
    check('通常会話ではWebSpeechを使わない', s.webSpeechCalls.length === 0, s.webSpeechCalls.length);
    check('再生していない発話をspoke計上しない', s.spokeReports.length === 0, s.spokeReports.length);
  }, { prio: 4, kind: 'info' });

  // ケース12: 1回目の一時失敗は短い再試行でCloud音声へ復帰
  let retryCalls = 0;
  await runCase('Cloud一時失敗 → 2回目で復帰', {
    fetchImpl: async () => {
      retryCalls++;
      if(retryCalls === 1) throw new Error('temporary network failure');
      return { status: 200, ok: true, json: async () => ({ audioContent: 'RECOVERED' }) };
    },
    AudioImpl: makeAudio({ fireOnended: true }),
  }, (s) => {
    check('Cloud fetchを2回試行', retryCalls === 2, retryCalls);
    check('復帰時は失敗ログを残さない', s.ttsFails.length === 0, s.ttsFails);
    check('WebSpeechへ落ちない', s.webSpeechCalls.length === 0, s.webSpeechCalls.length);
    check('Cloud再生を1回だけ計上', s.spokeReports.length === 1, s.spokeReports.length);
  });

  // ケース13: 正常系 (何もログされない・spoke1回)
  await runCase('正常系 → ttsFailログ0件・spoke1回', {
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ audioContent: 'OK' }) }),
    AudioImpl: makeAudio({}),
  }, (s) => {
    const kinds = s.ttsFails.map(l => l.split(' | ')[0].replace('[TTS_FAIL] ', ''));
    check('ttsFailログは0件', kinds.length === 0, kinds);
    check('WebSpeechは呼ばれない', s.webSpeechCalls.length === 0, s.webSpeechCalls.length);
    check('spokeReportは1回だけ', s.spokeReports.length === 1, s.spokeReports.length);
  });

  console.log(`\n${fail === 0 ? '✅' : '❌'} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
