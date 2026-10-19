'use strict';
// WO016: reconstruct the pre-WO016 renderer.html / server.js for the same-fixture
// before/after comparison.
//
// Provenance: the original pre-WO016 snapshot (/tmp/wo016-before-files) no longer exists.
// The WO016 v1 files are preserved (desktop/renderer.html 1619c406…, server.js c9b0deab…;
// today's partial baseline /tmp/wo016-oct16-before-files). This module applies the exact
// inverse of every v1 edit recorded in the implementing Claude Code session transcript
// (each edit's new_string -> old_string). The result is ACCEPTED ONLY if its SHA256 equals
// the pre-WO016 hash recorded in /tmp/wo016-before.json at the time
// (renderer 79cb130e…, server b89f3aa0…). Otherwise the caller must report the
// comparison as unavailable — never as a pass.
const crypto = require('crypto');
const PRE_SHA = {
  renderer: '79cb130e59d9637c582d2e348e3f10d7c6be2011b309c572606d6cb0e1bc3a22',
  server: 'b89f3aa0d52b9adb8686ece7444ed0a3657d4d12f392de886a428aa9a0eac818',
};
const V1_SHA = {
  renderer: '1619c406a93a3db2df3738fd5c0a4b36fa1dafc9c7919ead3c40599b2a32647a',
  server: 'c9b0deab4c951d0a4803169f1c1ab360a181de23ada60d302277d0fd43de60d3',
};
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function swap(text, from, to, label, misses) {
  const i = text.indexOf(from);
  if (i < 0 || text.indexOf(from, i + 1) >= 0) { misses.push(label); return text; }
  return text.slice(0, i) + to + text.slice(i + from.length);
}

function reconstructRenderer(v1) {
  const m = [];
  let s = v1;
  s = swap(s, '<script src="local-intent-router.js"></script>\n<script src="driver-input-arbiter.js"></script>\n',
    '<script src="local-intent-router.js"></script>\n', 'script', m);
  s = swap(s, "// WO016: only a real bridge PTT-down opens a capture; a bridge STT terminal with no capture\n"
    + "// awaiting one is rejected (replaces the old 120s bridgePttCaptureArmedAt timestamp gate).\n"
    + "const driverInputArbiter = globalThis.PitwallDriverInputArbiter.create();\n"
    + "let pttCaptureId = null;\nlet lastAdmittedDriverInput = null;\n",
  "let bridgePttCaptureArmedAt = 0; // only a real bridge PTT-down may authorise driver STT\n", 'globals', m);
  {
    const a = s.indexOf('// ── WO016: Driver input ownership');
    const endMark = "  if(fromEditor){ inp.value=''; inp.style.height='auto'; }\n  addMsg('user',text);";
    const b = s.indexOf(endMark, a);
    if (a < 0 || b < 0) m.push('sendMsg-head');
    else s = s.slice(0, a) + "async function sendMsg(inputSource){\n  const inp = document.getElementById('chat-input');\n"
      + "  const text = inp.value.trim();\n  if(!text||isBusy) return;\n  inp.value=''; inp.style.height='auto';\n  addMsg('user',text);"
      + s.slice(b + endMark.length);
  }
  s = swap(s, "  // ★WO016：この呼出し＝1turn owner。外部（優先入力・PTT割込み）から取消せるcontrollerを持ち、\n"
    + "  //   取消後は本文/判定/履歴/memoryへ到達しない。終了時はownerの時だけbusyを閉じる。\n"
    + "  const _turn=(typeof beginDriverTurn==='function')?beginDriverTurn(inputSource):null;\n"
    + "  const _turnLive=()=>!_turn||driverTurnLive(_turn);\n  let fetchTimer=null;\n", '', 'callAPI-start', m);
  s = swap(s, "    const ctrl = (_turn&&_turn.controller) ? _turn.controller : new AbortController();\n"
    + "    // Chat API 30秒でタイムアウト。timeoutはネット障害として扱い、意図的な取消とは区別する。\n"
    + "    fetchTimer = setTimeout(()=>{ if(_turn) timeoutDriverTurn(_turn); else ctrl.abort(); }, 30000);\n",
  "    const ctrl = new AbortController();\n    const fetchTimer = setTimeout(()=>ctrl.abort(), 30000);  // Chat API 30秒でタイムアウト\n", 'ctrl', m);
  s = swap(s, "    if(!_turnLive()){ try{res.body&&res.body.cancel&&res.body.cancel();}catch(e){} diagnosticLog('DRIVER_TURN','stale_response_after_cancel turn='+_turn.turnId); return; }\n", '', 'post-fetch', m);
  s = swap(s, "\n    // ★WO016：取消時に旧replyの吹き出しと積んだ発話itemを名指しで止められるようturnへ結ぶ。\n"
    + "    if(_turn){ _turn.bubble=bubble; _turn.queuedItems=_replyQueuedItems; }", '', 'bubble', m);
  s = swap(s, "      // ★WO016：取消済みturnの遅延chunk/終端は、表示・発話・judgeへ一切進めない。\n"
    + "      if(!_turnLive()){ try{reader.cancel?.();}catch(e){} diagnosticLog('DRIVER_TURN','stale_chunk_after_cancel turn='+_turn.turnId); return; }\n", '', 'read-guard', m);
  s = swap(s, "      // ★WO016：busy解除は下のfinally（ownerの時だけ）へ一本化。\n"
    + "      if(!strategyReplyBindingValid(_replyStrategyBinding,full,_replyAuxAtRequest)){reader.cancel?.();diagnosticLog('STRATEGY_PROJECTION','stale_reply_discarded');return;}",
  "      if(!strategyReplyBindingValid(_replyStrategyBinding,full,_replyAuxAtRequest)){reader.cancel?.();diagnosticLog('STRATEGY_PROJECTION','stale_reply_discarded');isBusy=false;document.getElementById('busy-ind').classList.remove('show');return;}", 'fence', m);
  s = swap(s, "          if(_turn&&lastQueuedSpeakItem)_turn.auxItems.push(lastQueuedSpeakItem);\n", '', 'truth-aux', m);
  s = swap(s, "    if(!_turnLive()){ diagnosticLog('DRIVER_TURN','stale_completion_after_cancel turn='+_turn.turnId); return; }\n", '', 'post-loop', m);
  s = swap(s, "    // ★WO016：意図的な取消（優先入力・PTT割込み）はネット障害ではない。接続エラー音声・\n"
    + "    //   エラー履歴を出さない（中断の事実はcancelDriverTurnが同期で1件だけ積み済み）。\n"
    + "    if(_turn && _turn.cancelled){\n"
    + "      diagnosticLog('DRIVER_TURN','cancelled turn='+_turn.turnId+' reason='+_turn.cancelReason+' error='+(e&&e.name||'?'));\n"
    + "      return;\n    }\n", '', 'catch', m);
  s = swap(s, "    pushMsg({role:'assistant',content:errMsg});\n  } finally {\n    clearTimeout(fetchTimer);\n"
    + "    // ★WO016：ownerの時だけbusyを閉じる。取消済み旧turnのfinallyは新ownerへ触れない。\n"
    + "    if(_turn) finishDriverTurn(_turn);\n    else {\n      isBusy=false;\n"
    + "      document.getElementById('busy-ind').classList.remove('show');\n"
    + "      if(jamesAutoMicEnabled&&!jamesMuted) setTimeout(startAutoMic,400);\n    }\n  }\n}",
  "    pushMsg({role:'assistant',content:errMsg});\n  }\n  isBusy=false;\n"
    + "  document.getElementById('busy-ind').classList.remove('show');\n"
    + "  if(jamesAutoMicEnabled&&!jamesMuted) setTimeout(startAutoMic,400);\n}", 'finally', m);
  s = swap(s, "if(data.state==='down'){ pttStart(); }", "if(data.state==='down'){ bridgePttCaptureArmedAt=Date.now(); pttStart(); }", 'ptt-down', m);
  s = swap(s, "      if(data.type==='ptt_text'){ handleBridgePttText(data); return; }\n"
    + "      if(data.type==='ptt_audio'){ handleBridgePttAudio(data); return; }\n"
    + "      if(data.type==='ptt_diagnostic'){ handleBridgePttDiagnostic(data); return; }\n"
    + "      if(data.type==='ptt_error'){ handleBridgePttError(data); return; }",
  "      if(data.type==='ptt_text'){\n"
    + "        if(!bridgePttCaptureArmedAt || Date.now()-bridgePttCaptureArmedAt>120000){\n"
    + "          diagnosticLog('PTT_SOURCE','rejected ptt_text without a recent physical PTT-down');\n"
    + "          return;\n        }\n        bridgePttCaptureArmedAt=0;\n        setHint('');\n"
    + "        const text=(data.text||'').trim();\n        if(text){\n"
    + "          document.getElementById('chat-input').value=text;\n"
    + "          sendMsg('ptt');  // Claude→大石の返答フロー\n        } else {\n"
    + "          setHint(t('hint_not_caught'));\n        }\n      }\n"
    + "      if(data.type==='ptt_audio'){\n"
    + "        if(!bridgePttCaptureArmedAt || Date.now()-bridgePttCaptureArmedAt>120000){\n"
    + "          diagnosticLog('PTT_SOURCE','rejected ptt_audio without a recent physical PTT-down');\n"
    + "          return;\n        }\n        bridgePttCaptureArmedAt=0;\n        transcribePttAudio(data);\n        return;\n      }\n"
    + "      if(data.type==='ptt_diagnostic'){\n        const reason=String(data.reason||'');\n"
    + "        setHint(reason==='too_short'\n          ? 'PTTを押して一呼吸してから話してください。'\n"
    + "          : 'マイク入力が無音です。設定画面のTestで確認してください。');\n        return;\n      }\n"
    + "      if(data.type==='ptt_error'){\n"
    + "        setHint(data.reason==='network' ? t('hint_ptt_network') : t('sys_conn_error'));\n        return;\n      }", 'onmessage-ptt', m);
  {
    const a = s.indexOf('// ★WO016：busy中でも録音は破棄しない（旧ptt_abortを廃止）。');
    const b = s.indexOf('async function transcribePttAudio(data, captureId){', a);
    if (a < 0 || b < 0) m.push('ptt-block');
    else s = s.slice(0, a) + "async function pttStart(){\n  if(pttHeld) return;\n  if(isBusy){\n    try{\n"
      + "      if(irBridge && irBridge.readyState===1){\n        irBridge.send(JSON.stringify({cmd:'ptt_abort'}));\n      }\n"
      + "    }catch(e){}\n    return;\n  }\n  if(!irBridge || irBridge.readyState!==1){ setHint(t('hint_bridge_off')); return; }\n"
      + "  pttHeld = true;\n  // 録音中はAI発話を止める（自分の声に被せない）\n"
      + "  discardQueuedUtterances(speakQueue,'ptt_pressed');   // ★P1-2\n  speakQueue=[]; stopCurrentAudio();\n"
      + "  document.getElementById('mic-btn').classList.add('recording');\n  setHint(t('hint_recording'));\n  try{\n"
      + "    // 選択キャラの言語でSTTさせる（James/Luna/Hajime=英語, 官兵衛/大石=日本語）。\n"
      + "    // これが無いと英語で喋っても日本語モデルで文字起こしされ崩れる。\n"
      + "    const _c = CHARS[sel];\n    const sttLang = (_c && _c.gLang) ? _c.gLang : 'ja-JP';\n"
      + "    irBridge.send(JSON.stringify({cmd:'ptt_start', lang:sttLang}));\n  }catch(e){\n    pttHeld=false;\n"
      + "    addMsg('sys',t('sys_ptt_start_fail')+e.message);\n  }\n}\n\nfunction pttStop(){\n  if(!pttHeld) return;\n"
      + "  pttHeld = false;\n  document.getElementById('mic-btn').classList.remove('recording');\n"
      + "  setHint(t('hint_transcribing'));\n  try{\n    irBridge.send(JSON.stringify({cmd:'ptt_stop'}));\n  }catch(e){\n"
      + "    addMsg('sys',t('sys_ptt_stop_fail')+e.message);\n  }\n}\n\nasync function transcribePttAudio(data){"
      + s.slice(b + 'async function transcribePttAudio(data, captureId){'.length);
  }
  s = swap(s, "    setHint('');\n"
    + "    // ★WO016：入力欄を経由せず、このcaptureへ帰属させてcapture順に解放する\n"
    + "    //   （旧STTが新しいeditor内容や新turnを上書きしない）。captureIdの無い旧呼出しは従来経路。\n"
    + "    if(captureId){\n"
    + "      deliverReleasedCaptures(driverInputArbiter.resolveCapture(captureId,text?{kind:'text',text}:{kind:'empty'},currentDriverInputScopeKey()).released);\n"
    + "    }else if(text){\n      sendMsg('ptt',{text});\n    }else{\n      setHint(t('hint_not_caught'));\n    }\n",
  "    setHint('');\n    if(text){\n      document.getElementById('chat-input').value=text;\n      sendMsg('ptt');\n"
    + "    }else{\n      setHint(t('hint_not_caught'));\n    }\n", 'transcribe-ok', m);
  s = swap(s, "    // STT失敗はこのcaptureだけを終端させる。処理中の新しい入力・turnには触れない。\n"
    + "    if(captureId) deliverReleasedCaptures(driverInputArbiter.resolveCapture(captureId,{kind:'error',reason:String(e&&e.message||e)},currentDriverInputScopeKey()).released);\n", '', 'transcribe-err', m);
  s = swap(s, "    // WO016: busy中も受付policy（urgent/明示待機）へ渡す。入力欄に黙って残さない。\n"
    + "    const t=document.getElementById('chat-input').value.trim(); if(t) sendMsg(); };",
  "    const t=document.getElementById('chat-input').value.trim(); if(t&&!isBusy) sendMsg(); };", 'startRec', m);
  return { text: s, misses: m };
}

function reconstructServer(v1) {
  const m = [];
  let s = v1;
  s = swap(s, "      // ★WO016：Renderer側のturn取消（fetch abort）でclient接続が閉じたら、provider生成も\n"
    + "      //   SDKのsignal契約で取り消す。'close'は正常終了後にも来るため、未完了時だけを切断と扱う。\n"
    + "      //   切断後はwrite・judgment/end frameを出さず、stream ERRORとも区別して記録する。\n"
    + "      const providerAbort = new AbortController();\n      let clientClosed = false;\n"
    + "      res.on('close', () => {\n        if (res.writableFinished) return;\n        clientClosed = true;\n"
    + "        try { providerAbort.abort(); } catch (e) {}\n      });\n"
    + "      const emitCompleteSentences = (final = false) => {\n        if (outputClosed || clientClosed) return;",
  "      const emitCompleteSentences = (final = false) => {\n        if (outputClosed) return;", 'emit', m);
  s = swap(s, "      const jtWriteFrame = (obj) => {\n        if (clientClosed) return;\n        try {",
    "      const jtWriteFrame = (obj) => {\n        try {", 'jt', m);
  s = swap(s, "        }, { signal: providerAbort.signal });\n        for await (const event of stream) {\n          if (clientClosed) break;\n",
    "        });\n        for await (const event of stream) {\n", 'signal', m);
  s = swap(s, "        if (clientClosed) {\n"
    + "          // 既存のusage記録は維持（input tokensは実測。途中取消のoutput tokensは過少の可能性＝未測定）。\n"
    + "          console.log('[/api/chat stream ABORTED] reason=client_closed');\n          logUsage(streamUsage);\n          return;\n        }\n", '', 'abort-done', m);
  s = swap(s, "        if (clientClosed) {\n"
    + "          console.log('[/api/chat stream ABORTED] reason=client_closed error=' + (streamErr && streamErr.name));\n"
    + "          logUsage(streamUsage);\n          return;\n        }\n", '', 'abort-catch', m);
  return { text: s, misses: m };
}

function reconstruct(v1Renderer, v1Server) {
  const out = { v1Verified: sha(v1Renderer) === V1_SHA.renderer && sha(v1Server) === V1_SHA.server };
  const r = reconstructRenderer(v1Renderer), sv = reconstructServer(v1Server);
  out.renderer = r.text; out.server = sv.text; out.misses = r.misses.concat(sv.misses);
  out.rendererSha = sha(r.text); out.serverSha = sha(sv.text);
  out.ok = out.v1Verified && out.misses.length === 0 && out.rendererSha === PRE_SHA.renderer && out.serverSha === PRE_SHA.server;
  return out;
}
module.exports = { reconstruct, PRE_SHA, V1_SHA };
