// OMO-PW V3 local intent router.
//
// This is deliberately narrow: it answers only questions whose answer is
// already in the current Bridge snapshot.  Everything involving judgement,
// a plan change, or an ambiguous driver instruction returns `handled:false`
// and remains a conversation for Luna.  It is shared as a UMD module so the
// browser path and the no-network test path use exactly the same contract.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallLocalIntentRouter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const isJP = lang => lang === 'ja';
  // ★2026-08-30 P0-1：`Number(null) === 0` かつ `Number.isFinite(0) === true`。
  //   以前の実装は Number() へ直接渡していたため、**未取得の値が 0 という
  //   確定値に化けた**。8/30 RB Ring 実走では「最終目安は0周目、あと0周」を
  //   喋り、GAP が取れていない場面では「前0.0秒、後ろ0.0秒」＝真後ろに
  //   張り付かれていると断言し得た。この router は GAP・燃料・残り周回・
  //   天候の即答を全部持っているので、緩い変換は全回答に効く毒になる。
  //   リポジトリの他モジュール（team-plan / fuel-plan-guard / gap-freshness /
  //   engineer-card / server.js）は全て先に null 系を弾いており、ここだけが
  //   例外だった。欠損は欠損のまま null で返し、各回答の「取得できない」
  //   分岐へ落とす。
  const finite = value => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  };
  const integer = value => {
    const n = finite(value);
    return n !== null && Number.isInteger(n) ? n : null;
  };
  // ★Codex P2（2026-09-06）：注入された strategy API が部分実装（例：`pitExecuted`
  //   だけを持つテストダブル）だと、`answerFuel` 等の未定義メソッド呼出しで
  //   router 全体が throw していた。呼ぶ前に**能力を確認**し、欠けていれば
  //   fail-closed（unhandled もしくは既存の未配線時フォールバック）へ落とす。
  const stratCan = (mod, name) => !!(mod && typeof mod[name] === 'function');
  // ★Codex P1-2（2026-09-07 第2回差戻し）：固定 `NO_AUTHORITY_MAX_AHEAD=20` を廃止した。
  //   耐久では20周より先の正当なPlanが普通にある（現在10周・35周目でピット、等）。
  //   優先順位は (1) 正式な総周回 authority (2) 正式な残りcrossings authority
  //   (3) どちらも無ければ「現在周・次周だけ自明」として、それ以外は確定も拒否もせず聞き返す。
  //
  //   ★off-by-one 契約（当方の解釈・**未確認**。`irsdk-bridge/final_lap.py` の
  //   `estimated_crossings_to_finish` は「S/Fをあと何回通過するか」。現在ラップを
  //   走行中に crossings=N なら、最終有効ラップ = currentLap + N - 1 と解釈した
  //   （現在ラップの完走で1回、以降の各ラップ完走で1回ずつ通過するため）。
  //   実テレメトリでの検証はしていない。境界を誤っていれば1周分ずれる。
  const resolvePitLapCeiling = (currentLap, live) => {
    // ★Codex P1-2（2026-09-07 第3回差戻し）：bridge側の未検証センチネル
    //   （iRacing SessionLapsTotal の32767等）が `laps_total` としてそのまま
    //   desktopへ届き、`finish_crossings_authority` が正しくても上書きしていた。
    //   bridge側（`bridge.py` の broadcast）を `_laps_total_ok` で検証済みの時だけ
    //   公開するよう直したが、desktop側にも**二重の防御**を置く。
    //   `race_plan.kind==='timed'` と分かっている時は、`laps_total` が届いても
    //   周回レースの総周回として信用しない（時間制に周回総数は存在しない）。
    const plan = live.race_plan && typeof live.race_plan === 'object' ? live.race_plan : null;
    const isTimedRace = plan && plan.kind === 'timed';
    const totalLaps = isTimedRace ? null : integer(live.laps_total);
    if (totalLaps !== null) return { total: totalLaps, source: 'laps_total' };
    // ★1〜10という上限は他所（Last-N周回コールの表示範囲）由来の値を
    //   そのまま転用していた「恣意的な制限」（Codex指摘）。ここでは外す。
    const crossings = integer(live.finish_crossings_authority);
    if (crossings !== null && crossings >= 0) {
      return { total: currentLap + crossings - 1, source: 'finish_crossings_authority' };
    }
    return null;   // authority 無し
  };

  const formatDuration = (seconds, lang) => {
    const value = finite(seconds);
    if (value === null) return '';
    const total = Math.max(0, Math.round(value));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return isJP(lang) ? `${h}時間${m ? m + '分' : ''}` : `${h}h${m ? ' ' + m + 'm' : ''}`;
    if (m) return isJP(lang) ? `${m}分${s}秒` : `${m}m ${s}s`;
    return isJP(lang) ? `${s}秒` : `${s}s`;
  };
  const formatLapTime = (seconds, lang) => {
    const value = finite(seconds);
    if (value === null || value <= 0 || value >= 86400) return '';
    const totalMs = Math.round(value * 1000);
    const minutes = Math.floor(totalMs / 60000);
    const wholeSeconds = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;
    if (isJP(lang)) return `${minutes}分${wholeSeconds}秒${String(millis).padStart(3, '0')}`;
    return `${minutes}:${String(wholeSeconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  };
  const weatherValues = live => {
    const weather = live && live.weather && typeof live.weather === 'object' ? live.weather : {};
    return {
      track: finite(weather.track_temp_c),
      air: finite(weather.air_temp_c),
      humidity: finite(weather.humidity),
      wet: finite(weather.track_wetness_code),
    };
  };
  // Every local fact response carries provenance and a conservative confidence
  // label.  The renderer can use this contract to prevent an LLM response from
  // replacing an authoritative local answer, while unavailable/stale/held
  // results remain explicitly non-confirmed instead of looking like facts.
  // Keep this as an independent semantic vocabulary, not a copy of a test
  // oracle.  It covers the softer Japanese forms used by the actual cards
  // (取れていない／未確定／足りない／確認できない) as well as English.
  const replySignalsUnavailable = reply => {
    const text = String(reply);
    const patterns = [
      /取れていない|取得できない|確認できない|確定できない/,
      /未確定|足りない|記録は.*ない|データ.*ない/,
      /受信していない|届いていない|不明|ありません/,
      /not available|not confirmed|no data|unknown|cannot|can't|unavailable|do not have|don't have/i,
    ];
    return patterns.some(pattern => pattern.test(text)); };
  const replyConfidence = (intent, reply) => {
    if (/(?:unavailable|stale|held)/i.test(String(intent)) || replySignalsUnavailable(reply)) return 'unavailable';
    if (/(?:measuring|確認中|次の計測|あと\d+周|まだ。)/i.test(String(intent) + ' ' + String(reply))) return 'estimated';
    return 'confirmed';
  };
  const answer = (intent, reply, action, overrides) => reply
    ? { handled:true, intent, reply, source:'local_authority',
      confidence: replyConfidence(intent, reply),
      ...(action ? { action } : {}),
      // ★2026-09-14 Codex差戻し：本文で「暫定」と言いながら機械契約が
      //   `confidence:'confirmed'` では矛盾する。推定根拠で答えた回答は、
      //   呼び出し側が確度と差異を上書きできるようにする。
      ...(overrides && typeof overrides === 'object' ? overrides : {}) }
    : { handled:false };

  // ★G5（2026-08-25）Codex Build 284 P1：GAP の回答は queue 待ちで陳腐化しうる。
  //   回答生成時の 5 秒契約だけでは出口まで届かないので、どの方向の・どの車の・
  //   どのセッションの値を述べたのかを一緒に返し、renderer が TTS 開始直前に
  //   `gap-freshness.evaluateAnswer()` で照合できるようにする。
  //   値は `live.gap_<direction>`（この関数が答えに使うのと同じ値）を出所とし、
  //   session / generation / target は `gap_authority` から取る。
  //   Practice など権威レコードが無い場合も、方向と値だけの identity を返す
  //   （照合対象が減るだけで、全面沈黙にはしない）。
  const gapIdentityFor = (live, direction, gapS) => {
    const table = live && live.gap_authority && typeof live.gap_authority === 'object'
      ? live.gap_authority : null;
    const record = table && table[direction] && typeof table[direction] === 'object'
      ? table[direction] : null;
    const identity = { direction, gap_s: gapS };
    if (record) {
      identity.session_key = record.session_key === undefined ? null : record.session_key;
      identity.generation = record.generation === undefined ? null : record.generation;
      identity.source_kind = record.source_kind === undefined ? null : record.source_kind;
      identity.target_car_idx = record.target_car_idx === undefined ? null : record.target_car_idx;
      identity.target_class = record.target_class === undefined ? null : record.target_class;
      identity.target_class_position = record.target_class_position === undefined ? null : record.target_class_position;
      identity.sampled_at = record.sampled_at === undefined ? null : record.sampled_at;
    }
    return identity;
  };
  const gapAnswer = (intent, reply, identities) => reply
    ? { handled:true, intent, reply, source:'local_authority',
      confidence: replyConfidence(intent, reply),
      gapIdentities:identities }
    : { handled:false };
  const gapClassLabel = (live, direction, lang) => {
    const rec = live && live.gap_authority && live.gap_authority[direction];
    const cls = rec && typeof rec.target_class === 'string' ? rec.target_class.trim() : '';
    if (!cls) return '';
    return isJP(lang) ? `${cls} ` : `${cls} `;
  };
  const gapPhrase = (live, direction, value, lang) => {
    const cls = gapClassLabel(live, direction, lang);
    if (isJP(lang)) return cls
      ? `${direction==='ahead'?'前':'後ろ'}の${cls}${value.toFixed(1)}秒`
      : `${direction==='ahead'?'前':'後ろ'}${value.toFixed(1)}秒`;
    return `${cls}${value.toFixed(1)} seconds ${direction}`;
  };

  function fuelWindowStatus(live, lang) {
    if(live?.strategy_projection){
      const ref=live.strategy_options_reference,plan=ref?.value?.plan_b;
      if(!ref?.source_valid||!plan)return {state:'measuring',reply:isJP(lang)?'燃料ウィンドウの計算根拠を確認できない。':'The fuel-window calculation is unavailable.'};
      // A countdown and open flag describe the original calculation, not a
      // later frame. Never promote that reference into a current BOX permission.
      const sameFrame=ref.calculation_source?.source_frame_sequence===live.canonical_lifecycle?.source_frame?.sequence;
      const age=Number(ref.age_s).toFixed(1);
      if(!sameFrame){
        // WO-019: answer the question with what that calculation said (window lap, never a
        // countdown or "pit now") plus the current canonical agreement, keeping its age.
        const jp=isJP(lang),openLap=integer(plan.target_lap),active=live.canonical_lifecycle?.lifecycle?.active||null;
        const windowLine=openLap===null?'':plan.fuel_window_open===true
          ?(jp?`その計算では${openLap}周目から窓が開いている。`:`It had the window open from lap ${openLap}. `)
          :plan.fuel_window_open===false||plan.reason==='fuel_window_not_open'
            ?(jp?`その計算では${openLap}周目から開く見込み。`:`It expected the window to open on lap ${openLap}. `):'';
        const activeLine=active?(jp?`合意中はPlan ${active.selected_plan}${integer(active.target_lap)===null?'、ピット周未確認':`、${active.target_lap}周目ピット`}。`
          :`The agreed plan is ${active.selected_plan}${integer(active.target_lap)===null?', with an unknown target':', pit lap '+active.target_lap}. `)
          :(jp?'合意中のPlanは無い。':'There is no agreed plan. ');
        return {state:'reference',reply:jp?`燃料ウィンドウは${age}秒前の比較計算。${windowLine}${activeLine}現在の成立条件は再確認が必要。`
          :`The fuel-window comparison was calculated ${age} seconds ago. ${windowLine}${activeLine}Current conditions require confirmation.`};
      }
      if(plan.available===true&&plan.fuel_window_open===true)return {state:'open',reply:isJP(lang)?'燃料ウィンドウの比較条件は成立。ピット実行は現在合意中のPlanで確認する。':'The fuel-window comparison conditions hold. Check execution against the current agreed plan.'};
      return {state:'waiting',reply:isJP(lang)?'燃料ウィンドウの比較条件はまだ成立していない。':'The fuel-window comparison conditions do not currently hold.'};
    }
    const options = live && live.strategy_options && typeof live.strategy_options === 'object'
      ? live.strategy_options : {};
    const planB = options.plan_b && typeof options.plan_b === 'object' ? options.plan_b : {};
    const inLaps = integer(options.fuel_window_open_in_laps ?? planB.target_in_laps);
    if (planB.fuel_window_open === true) return {
      state:'open',
      reply:isJP(lang) ? 'ウィンドウは開いている。今周から入れる。'
        : 'The fuel window is open. We can stop from this lap.'
    };
    if (inLaps !== null && inLaps > 0) return {
      state:'waiting',
      inLaps,
      reply:isJP(lang) ? `まだ。あと${inLaps}周。`
        : `Not yet. ${inLaps} lap${inLaps === 1 ? '' : 's'} to the fuel window.`
    };
    return {
      state:'measuring',
      reply:isJP(lang) ? 'まだ。燃費と完走距離を確認中。'
        : 'Not yet. I am still confirming fuel burn and the finish distance.'
    };
  }

  const strategyCallKind = text => {
    if (/アンダー\s*カット|under\s*cut/i.test(text)) return 'B';
    if (/オーバー\s*カット|over\s*cut/i.test(text)) return 'C';
    if (/(?:通常|基準|予定通り).{0,8}(?:ピット|ボックス|プラン)|(?:normal|baseline|scheduled).{0,8}(?:pit|stop|plan)/i.test(text)) return 'A';
    if (/(?:今|この周|次周|次の周)?.{0,8}(?:ピット|ボックス).{0,10}(?:入る|行く|どう|べき|判断)|(?:戦略|作戦).{0,10}(?:どう|どれ|判断)|(?:pit|box).{0,12}(?:now|this lap|next lap|should|strategy)/i.test(text)) return 'recommendation';
    return null;
  };

  // WO-019: "前回のピット" is the previous-REFUEL lookup only with a quantity word.
  // "前回のピットはどうだった？" asks how it went and continues to the conversation path,
  // whose context carries the saved Bridge-confirmed outcome of that race.
  const PREVIOUS_FUEL_RE=/(?:前回|前の|この前).{0,10}(?:給油|ガソリン|フューエル|fuel)|(?:前回|前の|この前).{0,10}ピット.{0,12}(?:給油|何リットル|リットル|リッター|量)|last.*fuel|prev.*refuel/i;

  // One semantic decision is shared by the public command API and sendMsg.
  function classifyDriverIntent(raw) {
    const text=normalizeSttText(String(raw||'').trim());
    const windowTopic=/(?:ウ[ィイ]?ンド(?:ウ)?|ウインド(?:ウ)?|window)/i.test(text);
    const pit=/(?:ピット|ボックス|box|pit|プラン|plan|先に入る|早めに入る)/i.test(text);
    const historical=/(?:前回|先週|昨日|前のレース|この前|以前|さっき.{0,12}(?:言った|言って)|って言った|と言った|と言って|と発言|とは言って|ってどういう意味|という意味|[「『“]|last time|previously|said|quoted)/i.test(text);
    // A separate tyre clause must not negate an explicit pit cancellation:
    // "ピット中止、タイヤ交換はしない". Keep unknown clauses and every
    // pit/plan clause conservative; only an explicitly separate tyre topic is
    // outside this operation's negation scope. History/condition/question
    // checks below still apply to the complete utterance.
    const negationText=text.split(/[、。;,；]/).filter(clause=>
      !/(?:タイヤ|tyres?|tires?)/i.test(clause)
      ||/(?:ピット|ボックス|box|pit|プラン|plan|キャンセル|取消|中止|cancel)/i.test(clause)).join('、');
    const negated=/(?:^\s*(?:not|no)\s+(?:box|pit)|言ってない|言っていない|入らない|入んない|行かない|行かん|しない|つもりはない|やめないで|取り消さない|キャンセルしない|ではない|じゃない|入るな|行くな|don't|do not|won't|will not|not going)/i.test(negationText);
    const conditional=/(?:もし|仮に|だったら|ならば|なら|if\b|would\b)/i.test(text);
    const question=/[?？]|(?:入って|行って|して)いい|入れる|入るべき|どう|べき|いいの|入るかな|入ろうか|合ってる|合っている|だよね|だった|should|can (?:we|i)|may i|could|whether/i.test(text);
    const penalty=/(?:黒旗|ブラックフラッグ|ペナルティ|ドライブスルー|ストップ.{0,2}ゴー|black flag|penalty|drive.?through|stop.?go)/i.test(text);
    if(windowTopic){
      // Remove only the window clause, then reuse the same operation parser.
      // A future window condition scopes the whole instruction.
      if(!historical&&!conditional&&!/(?:開いたら|開けば|オープンしたら|when.{0,20}window|if.{0,20}window)/i.test(text)){
        const operationText=text.replace(/[^、。]*(?:ウ[ィイ]?ンド(?:ウ)?|ウインド(?:ウ)?|window)[^、。]*?(?:だけど|けど|だから|でも|but|so)\s*/i,'');
        if(operationText!==text){const out=classifyDriverIntent(operationText);if(out.kind==='command'||out.kind==='ambiguous'||out.kind==='penalty')return {...out,reasonText:out.kind==='command'&&/(?:から|because)/i.test(text)?text:out.reasonText};}
      }
      if(historical)return {kind:'historical',topic:'window'};
      if(/(?:コール|watch|call).{0,12}(?:やめないで|取り消さない|取消しない|キャンセルしない)|don't.{0,10}cancel/i.test(text))return {kind:'negated',topic:'window'};
      if(/(?:教えないで|言わないで|コール.{0,5}(?:取消|取り消|やめ|中止)|(?:watch|call|notify|notification).{0,8}cancel|cancel.{0,8}(?:watch|call)|don't.{0,16}(?:tell|call|notify))/i.test(text))return {kind:'window_cancel',priority:true};
      if(/(?:(?:開)?いたら|開けば|オープンしたら|open).{0,30}(?:教えて|言って|コール|知らせ|notify|よろしく)|(?:tell|call|let me know|notify).{0,24}window.{0,10}open/i.test(text))return {kind:'window_watch',priority:true};
      if(conditional||/(?:開いたら|開けば|オープンしたら|if.*window)/i.test(text))return {kind:'conditional',topic:'window'};
      return {kind:'window_status',priority:true};
    }
    if(!pit&&!penalty&&/(?:から|ので|ため|because|reason)/i.test(text)&&/(?:前|遅い|詰ま|traffic|slow|because)/i.test(text))return {kind:'reason_followup',priority:true};
    if(!pit&&!penalty&&!/(?:やっぱり|変更|訂正).{0,12}[0-9０-９]+周|cancel.{0,8}plan/i.test(text))return {kind:'other'};
    if(historical)return {kind:'historical',topic:'pit'};
    if(penalty)return {kind:'penalty',priority:true};
    if(negated)return {kind:'negated',topic:'pit'};
    if(conditional)return {kind:'conditional',topic:'pit'};
    if(question)return {kind:'consultation',topic:'pit',executionQuestion:/(?:合ってる|合っている|だよね|だった)|(?:入る|入って|入れる|行って|pit|box).{0,12}(?:いい|べき|can|should)|(?:can|should|may|could).{0,12}(?:pit|box)|この周|今周/i.test(text)};
    const targets=[...text.matchAll(/([0-9０-９]{1,3})\s*周(?:目)?/g)].map(m=>Number(m[1].replace(/[０-９]/g,d=>'０１２３４５６７８９'.indexOf(d))));
    const cancel=/(?:やめる|やめとく|止める|取り消|キャンセル|中止|cancel)/i.test(text);
    const early=/(?:先に|早めに)入る|(?:今周|この周|今の周|この\s*周|今の\s*周).{0,8}(?:入る|ピット|ボックス)|(?:ピット|ボックス).{0,8}(?:入る|行く|する)|(?:box|pit)\s+(?:this lap|now)\b/i.test(text);
    if(/(?:今周|この周|this lap|now).{0,24}(?:次周|次の周|next lap)|(?:次周|次の周|next lap).{0,24}(?:今周|この周|this lap|now)/i.test(text)||new Set(targets).size>1||(cancel&&early)||(targets.length&&/(?:今周|この周|this lap|next lap|次周)/i.test(text)))return {kind:'ambiguous',priority:true};
    if(cancel)return {kind:'command',operation:'cancel',requestedTargetLap:null,priority:true};
    if(targets.length&&!/(?:変更|変え|訂正|じゃなくて|やっぱり|ピット.{0,12}(?:入る|行く)|box|pit|move|change)/i.test(text))return {kind:'consultation',topic:'pit',executionQuestion:true};
    if(targets.length)return {kind:'command',operation:'amend',requestedTargetLap:targets[0],reasonText:/(?:から|ので|ため|because)/i.test(text)?text:null,priority:true};
    if(/次(?:の)?周|next lap/i.test(text))return {kind:'command',operation:'amend',nextLap:true,priority:true};
    const reason=/(?:から|ので|ため|because|due to|traffic|slow)/i.test(text);
    if(early)return {kind:'command',operation:'early_pit',requestedTargetLap:null,reasonText:reason?text:null,explanationContinuation:reason&&!/(?:今周|この周|今の周|now|this lap)/i.test(text),priority:true};
    return {kind:'consultation',topic:'pit'};
  }
  const driverPlanCommand=text=>{const semantic=classifyDriverIntent(text);return semantic.kind==='command'?semantic:null;};

  function strategyCallAnswer(input, live, text, lang) {
    const requested = strategyCallKind(text);
    if (!requested) return null;
    const wiring = input && input.strategyEvaluation && typeof input.strategyEvaluation === 'object'
      ? input.strategyEvaluation : null;
    const engine = wiring && wiring.api;
    const playbook = wiring && wiring.playbook;
    if (!engine || typeof engine.evaluateStrategies !== 'function' || !playbook) return null;
    const snapshot = engine.evaluateStrategies(playbook, live);
    if(snapshot?.source==='bridge_canonical'){
      const rec=snapshot.recommendations?.strategy_options,opts=rec?.value;
      const active=snapshot.active;
      if(!opts?.available||rec?.source_valid!==true)return answer('strategy_consultation_unavailable',isJP(lang)?'現在の戦略候補の計算根拠を確認できない。':'Current strategy comparison evidence is unavailable.',{sourceRef:snapshot.publication_ref});
      const id=requested==='recommendation'?opts.selected_plan:requested;
      const candidate=opts['plan_'+String(id).toLowerCase()];
      const age=rec.age_s;
      const name='Plan '+id;
      const target=integer(candidate?.target_lap);
      const ev=opts.decision_evidence?.['plan_'+String(id).toLowerCase()+'_evidence']||opts['plan_'+String(id).toLowerCase()+'_evidence']||{};
      const required=Array.isArray(candidate?.conditions_required)?candidate.conditions_required:[];
      const failed=Array.isArray(ev.conditions_failed)?ev.conditions_failed:required.filter(k=>ev.conditions_met?.[k]!==true);
      const labels={fuel_window_open:['燃料窓','fuel window'],relative_pace_advantage:['前走車に対する実測ペース優位','measured pace advantage over the car ahead'],rejoin_clear:['復帰先のクリアな状況','clear rejoin'],rival_pitted_first:['前走車の先ピット','the rival pitting first'],clean_air:['クリーンエア','clean air'],fuel_save_on_target:['燃費目標達成','fuel-saving target'],rejoin_not_worse:['復帰位置が悪化しないこと','rejoin not getting worse']};
      const reasonText={no_undercut_room:['早入りできる余地がない','there is no room to undercut'],fuel_window_not_open:['燃料窓がまだ開いていない','the fuel window is not open'],conditions_unproven:['成立条件をまだ確認できていない','the required conditions are not proven'],no_room_to_extend:['延長できる余地がない','there is no room to extend'],fuel_save_target_unreachable:['必要な燃費目標に届かない','the fuel-saving target is unreachable'],fuel_save_target_unrealistic:['必要な燃費節約が現実的な範囲を超えている','the required fuel saving is beyond the supported range'],effective_capacity_insufficient:['タンク容量が不足する','fuel capacity is insufficient']};
      const jp=isJP(lang),available=candidate?.available===true;
      const reason=reasonText[candidate?.reason||ev.reason]?.[jp?0:1]||(jp?'必要な根拠が未成立または不足している':'required evidence is unmet or unavailable');
      const evidence=failed.map(k=>labels[k]?.[jp?0:1]||(jp?'未確認の成立条件':'an unconfirmed required condition')).join(jp?'・':', ');
      const targetLine=target===null?'':jp?`、${target}周目ピット案`:` for lap ${target}`;
      const result=available?(jp?`${name}の比較条件は成立${targetLine}。`:`${name} comparison conditions are met${targetLine}. `)
        :(jp?`${name}は今は選べない。${reason}。${evidence?'確認が必要なのは'+evidence+'。':''}`:`${name} is held: ${reason}. ${evidence?'Still needed: '+evidence+'. ':''}`);
      const activeLine=active?(jp?`合意中はPlan ${active.selected_plan}${integer(active.target_lap)===null?'、ピット周未確認':`、${active.target_lap}周目`}。`:`The agreed plan is ${active.selected_plan}${integer(active.target_lap)===null?', with an unknown target':', lap '+active.target_lap}. `):(jp?'まだ合意していない。':'There is no agreed plan. ');
      const msg=result+activeLine+(jp?`計算は${age.toFixed(1)}秒前。候補の成立と実行指示は分けて確認する。`:`The calculation is ${age.toFixed(1)} seconds old. Candidate conditions are separate from execution permission.`);
      return answer('strategy_consultation',msg,{role:'recommendation_not_execution',candidateAvailable:available,candidateReason:candidate?.reason||ev.reason||'evidence_unavailable',calculationSource:rec.calculation_source,calculationAgeS:age},{strategySnapshot:snapshot});
    }
    const meta = {
      type:'strategy_consultation', requestedPlan:requested,
      selectedPlan:snapshot && snapshot.recommendation
        ? snapshot.recommendation.selected_plan : null,
      snapshotId:snapshot ? snapshot.snapshot_id : null,
    };
    if (!snapshot || snapshot.available !== true) {
      return answer('strategy_consultation_unavailable', isJP(lang)
        ? 'まだ戦略を判定できない。燃料窓と復帰予測を確認中。'
        : 'I cannot judge the strategy yet. I am confirming the fuel window and rejoin forecast.',
      meta, { confidence:'unavailable', strategySnapshot:snapshot || null });
    }
    const recommendation = snapshot.recommendation;
    const candidate = requested === 'recommendation' ? null : snapshot.candidates[requested];
    const recId = recommendation && recommendation.selected_plan;
    const planName = id => isJP(lang)
      ? ({A:'通常プラン',B:'アンダーカット',C:'オーバーカット'}[id] || '戦略')
      : ({A:'the normal stop',B:'the undercut',C:'the overcut'}[id] || 'the strategy');
    const normalTarget = snapshot.candidates.A && snapshot.candidates.A.target_lap;
    const normalLine = isJP(lang)
      ? `通常プラン継続${normalTarget ? `、${normalTarget}周を終えてピット予定` : ''}。`
      : `Continue the normal plan${normalTarget ? ` and stop after lap ${normalTarget}` : ''}.`;

    if (!recommendation) {
      const held = candidate && candidate.status === 'held_for_latest_evidence';
      return answer('strategy_consultation_held', isJP(lang)
        ? `${requested === 'recommendation' ? '推奨' : planName(requested)}はまだ確定できない。最新のペースと復帰位置を確認中。`
        : `${requested === 'recommendation' ? 'The recommendation' : planName(requested)} is not confirmed yet. I am checking the latest pace and rejoin position.`,
      meta, { confidence:held ? 'held' : 'unavailable', strategySnapshot:snapshot });
    }

    if (requested === 'B' && recId !== 'B') {
      return answer('strategy_undercut', isJP(lang)
        ? `今はアンダーカット条件未成立。${recId === 'A' ? normalLine : `${planName(recId)}を推す。`}`
        : `The undercut conditions are not met. ${recId === 'A' ? normalLine : `I recommend ${planName(recId)}.`}`,
      meta, { strategySnapshot:snapshot });
    }
    if (requested === 'C' && recId !== 'C') {
      return answer('strategy_overcut', isJP(lang)
        ? `今はオーバーカット条件未成立。${recId === 'A' ? normalLine : `${planName(recId)}を推す。`}`
        : `The overcut conditions are not met. ${recId === 'A' ? normalLine : `I recommend ${planName(recId)}.`}`,
      meta, { strategySnapshot:snapshot });
    }

    const e = recommendation.evidence || {};
    let reply;
    if (recId === 'B') {
      const gap = finite(e.gap_ahead_s), pace = finite(e.player_pace_advantage_s);
      const pos = integer(e.physical_rejoin_position);
      reply = isJP(lang)
        ? `アンダーカット成立、今周ピットを推す。${gap !== null ? `前まで${gap.toFixed(1)}秒、` : ''}${pace !== null ? `こちらが${pace.toFixed(1)}秒速い。` : ''}${pos !== null ? `復帰予測P${pos}。` : ''}`
        : `Undercut conditions are met; I recommend pitting this lap.${gap !== null ? ` Gap ahead ${gap.toFixed(1)} seconds.` : ''}${pace !== null ? ` We are ${pace.toFixed(1)} seconds faster.` : ''}${pos !== null ? ` Predicted rejoin P${pos}.` : ''}`;
    } else if (recId === 'C') {
      const nowPos = integer(e.pit_now_position), nextPos = integer(e.pit_next_lap_position);
      reply = isJP(lang)
        ? `オーバーカット成立、もう1周走る案を推す。${nowPos !== null && nextPos !== null ? `今入るとP${nowPos}、次周ならP${nextPos}予測。` : ''}`
        : `Overcut conditions are met; I recommend one more lap.${nowPos !== null && nextPos !== null ? ` Rejoin is P${nowPos} now versus P${nextPos} next lap.` : ''}`;
    } else {
      reply = normalLine;
    }
    return answer(requested === 'recommendation' ? 'strategy_recommendation'
      : (requested === 'A' ? 'strategy_normal' : requested === 'B' ? 'strategy_undercut' : 'strategy_overcut'),
    reply, meta, { strategySnapshot:snapshot });
  }

  function fuelReply(live, lang) {
    const fs = live && live.fuel_strategy && typeof live.fuel_strategy === 'object'
      ? live.fuel_strategy : {};
    const endurance = fs.endurance_plan || live.endurance_fuel_plan || {};
    const timing = fs.pit_timing_authority && typeof fs.pit_timing_authority === 'object'
      ? fs.pit_timing_authority : null;
    if (timing && timing.available === true && finite(timing.range_laps) !== null) {
      const range=finite(timing.range_laps), shortfall=finite(timing.shortfall_to_finish_l);
      const until=integer(timing.laps_until_latest_safe_pit), latest=integer(timing.latest_safe_pit_lap);
      const when=timing.decision==='pit_now'
        ? (isJP(lang)?'今周ピット。':'Pit this lap.')
        : (until!==null&&latest!==null
          ? (isJP(lang)?`今は${timing.decision==='hold'?'待てる':'次のウインドウ'}。最終目安は${latest}周目、あと${until}周。`:`${timing.decision==='hold'?'Hold':'Pit later'}. Latest target lap ${latest}, ${until} laps away.`)
          : (isJP(lang)
            ? `ごめん、最終目安の周はまだ確定できない。Plan ${timing.selected_plan || 'A'}を継続、次のクリーン周で詰める。`
            : `Sorry — the latest target lap is not confirmed yet. Continue Plan ${timing.selected_plan || 'A'}; I will tighten it on the next clean lap.`));
      return isJP(lang)
        ? `現燃料で約${range.toFixed(1)}周。完走まで${shortfall!==null?shortfall.toFixed(1)+'L不足':'不足量は未確定'}。${when}`
        : `About ${range.toFixed(1)} laps of fuel remain. ${shortfall!==null?shortfall.toFixed(1)+'L short to finish':'Finish shortfall is not confirmed'}. ${when}`;
    }
    const next = integer(endurance.next_fuel_stop_in_laps);
    const stops = integer(endurance.future_stop_count);
    if (endurance.available === true && endurance.multi_stop === true && next !== null && stops !== null) {
      return isJP(lang)
        ? `次の給油目安はあと${next}周、残り給油は${stops}回見込み。`
        : `Next fuel stop in about ${next} laps; ${stops} stops projected.`;
    }
    const required = finite(fs.required_fuel_l);
    const margin = finite(fs.margin_l);
    const crossings = integer(fs.estimated_crossings_to_finish);
    const current = finite(live.fuel);
    if (required !== null && margin !== null && crossings !== null) {
      return isJP(lang)
        ? `現在${current !== null ? current.toFixed(1) + 'L、' : ''}チェッカーまで${crossings}回、必要${required.toFixed(1)}L。${margin >= 0 ? margin.toFixed(1) + 'L余裕' : Math.abs(margin).toFixed(1) + 'L不足'}。`
        : `${current !== null ? `Current ${current.toFixed(1)}L. ` : ''}${crossings} crossings to the finish; ${required.toFixed(1)}L required, ${margin >= 0 ? margin.toFixed(1) + 'L margin' : Math.abs(margin).toFixed(1) + 'L short'}.`;
    }
    const average = finite(fs.avg_fuel_per_lap);
    if (average !== null) return isJP(lang)
      ? `平均${average.toFixed(2)}L/周。必要量はクリーン3周そろい次第、計算で出す。`
      : `Average ${average.toFixed(2)}L per lap. I will calculate the requirement after three clean laps.`;
    return isJP(lang) ? '燃料の実測がまだ足りない。クリーンラップを待つ。'
      : 'I need clean-lap fuel data before I can calculate the requirement.';
  }

  // ★G3（2026-08-25）GAP 回答の許容鮮度。
  //   接続判定は TELEMETRY_STALE_MS=12000ms だが、GAP は数秒で意味が変わる。
  //   gap-freshness.js の再生側と同じ 5 秒に揃える。片方だけ緩いと、
  //   queue では破棄される古さの値を質問回答では喋ってしまう。
  const GAP_ANSWER_MAX_AGE_MS = 5000;

  // ★2026-08-30 修正2：STT の表記揺れを**入口で一度だけ**正す。
  //   Road Atlanta では「GTP」が gdp に化け、同一レースで3回連続して intent へ
  //   届かなかった（「gdpのコード教えて」がプログラミング依頼と誤解され、
  //   「ごめん、わたしはレースエンジニア。」で拒否された）。各正規表現へ gdp を
  //   足して回るのは破綻するので、ここで一度だけ正規化する。
  // ★2026-09-06 Build 298 実走 replay：STT が「周」を「週」と書き起こしていた。
  //   これが残り周回とピット周回の質問を同時に殺していた実文字列である。
  //
  //     18:19:39 「何週目にピットインする？」 → unhandled → 「Plan Aのピット周はまだ成立していない。」
  //     18:22:48 「この週でピットイン だ。」   → unhandled
  //     18:42:57 「あと何週？」               → unhandled → 時間だけ回答
  //     18:43:20 「この周囲 入れて あと2週かな？」→ unhandled → pit_decision へ誤分類
  //
  //   **一律に 週→周 とはしない。** 来週・今週・先週・毎週・週末・週明けは
  //   曜日／週単位の本来の意味で、レース会話でも普通に出る。
  //   周回を数えている文脈だけを直す。
  function normalizeLapWords(text) {
    return String(text)
      // 「この週」＝現在周。「この週末」は除く。
      .replace(/この週(?![末明])/g, 'この周')
      // 数字・「何」に続く週＝周回数。「今週」「先週」は直前が数でないので残る。
      .replace(/(?<=[0-9０-９一二三四五六七八九十何])\s*週(?![末明])/g, '周');
  }

  function normalizeSttText(raw) {
    return normalizeLapWords(String(raw || '')
      .replace(/gdp|GDP|ジーディーピー|ジーティーピー/g, 'GTP')
      .replace(/GTP.{0,4}コード/g, 'GTPのギャップ')
      .replace(/シュピート|シューピット/g, 'ピット'));
  }

  // ★2026-09-14 本人・同条件の過去燃費。ライブ実測が無い時だけ使う暫定根拠で、
  //   実測とは呼ばない。条件照合（series・session種別・レース形式・燃料/タイヤ規則・
  //   setup・路温）は session-memory.strategyFuelEvidence() の契約に従う。ここでの
  //   仕事は「現在側の条件を欠けなく渡す」こと——渡さないと全てが不明として
  //   素通りする（Codex 2026-09-14 P1）。燃料分岐と残り周回の係争判断で共有する。
  function historyFuelEvidence(input, live, sessionAuthority, currentUserId) {
    const mem = input && input.sessionMemory && typeof input.sessionMemory === 'object'
      ? input.sessionMemory : null;
    const history = input && Array.isArray(input.raceHistory) ? input.raceHistory : [];
    if (!mem || typeof mem.strategyFuelEvidence !== 'function' || history.length === 0) return null;
    const liveNow = live && typeof live === 'object' ? live : {};
    const memIdent = (input && input.memoryIdentity && typeof input.memoryIdentity === 'object')
      ? input.memoryIdentity : {};
    const auth = (sessionAuthority && typeof sessionAuthority === 'object') ? sessionAuthority : {};
    const racePlan = (liveNow.race_plan && typeof liveNow.race_plan === 'object') ? liveNow.race_plan : {};
    const weather = (liveNow.weather && typeof liveNow.weather === 'object') ? liveNow.weather : {};
    const pick = (a, b) => (a === undefined || a === null || a === '') ? (b === undefined || b === '' ? null : b) : a;
    const identity = {
      userId: pick(currentUserId, memIdent.userId),
      custId: pick(liveNow.cust_id, memIdent.custId),
      track: pick(liveNow.track, memIdent.track),
      car: pick(liveNow.car_model, memIdent.car),
      carClass: pick(liveNow.car_class, memIdent.carClass),
      seriesId: Number.isInteger(memIdent.seriesId) ? memIdent.seriesId
        : (Number.isInteger(auth.series_id) ? auth.series_id : null),
      sessionType: pick(memIdent.sessionType, pick(auth.session_type, liveNow.session_type)),
      raceFormat: pick(memIdent.raceFormat, racePlan.kind),
      fuelRule: pick(memIdent.fuelRule, auth.fuel_rule),
      tyreRule: pick(memIdent.tyreRule, auth.tyre_rule),
      setupFingerprint: pick(memIdent.setupFingerprint,
        auth.setup_fingerprint === 'unknown' ? null : auth.setup_fingerprint),
      trackTempC: finite(memIdent.trackTempC) !== null ? finite(memIdent.trackTempC)
        : finite(weather.track_temp_c),
    };
    const evidence = mem.strategyFuelEvidence(history, identity, Date.now());
    return (evidence && evidence.available && finite(evidence.avgFuelPerLap) > 0) ? evidence : null;
  }

  function routeInner(input) {
    const text = normalizeSttText(String(input && input.text || '').trim());
    const lang = input && input.lang === 'en' ? 'en' : 'ja';
    const live = input && input.live && typeof input.live === 'object' ? input.live : null;
    // PTT の直接質問も snapshot 時刻を検査する。渡されない場合は従来どおり
    // 検査しない（呼び出し側が古さを判断できない時に黙らせないため）。
    const snapshotAgeMs = finite(input && input.snapshotAgeMs);
    // ★2026-09-14 Codex MD#6 P1：残り周回の保留解除は「値が変わったか」ではなく
    //   **新しい観測が来たか**で決める。renderer が渡す snapshotId（telemetry 受信の
    //   識別子）を使い、無ければ live 側の時計で代用する。どちらも無い時は state 側が
    //   従来の値変化規則へ落ちる（黙って永久保留にしない）。
    const observationIdNow = (() => {
      const direct = input && input.snapshotId;
      if (direct !== null && direct !== undefined && direct !== '') return String(direct);
      const t = live ? (finite(live.session_time_s) !== null ? finite(live.session_time_s)
        : finite(live.session_time_remaining_s)) : null;
      return t === null ? null : 'session_time:' + t;
    })();
    const sessionAuthority = input && input.sessionAuthority
      && typeof input.sessionAuthority === 'object' ? input.sessionAuthority : null;
    const raceHistory = input && Array.isArray(input.raceHistory) ? input.raceHistory : [];
    // ★F2：ドライバー訂正で保留中の方向。保留中の値は「今の事実」として
    //   言い直さない（訂正の自由文も実測へ昇格させない）。再観測で解ける。
    const gapHeld = (input && input.gapHeld && typeof input.gapHeld === 'object')
      ? { ahead: input.gapHeld.ahead === true, behind: input.gapHeld.behind === true }
      : { ahead: false, behind: false };
    const currentUserId = input && input.currentUserId !== undefined && input.currentUserId !== null
      ? String(input.currentUserId) : '';
    // 合意Plan・pit実績の唯一の正本。渡されない場合は従来どおり live だけで答える。
    const strategy = input && input.strategy && typeof input.strategy === 'object'
      ? input.strategy : null;
    const strategyState = strategy && strategy.state ? strategy.state : null;
    const strategyModule = (strategy && strategy.api)
      || (typeof globalThis !== 'undefined' ? globalThis.PitwallSessionStrategyState : null)
      || null;
    if (!text || !live) return { handled:false };
    const semantic=input.driverIntent||classifyDriverIntent(text);
    const reasonTarget=input.pendingDriverPlanCommand;
    if(semantic.kind==='reason_followup')return reasonTarget&&reasonTarget.operation==='early_pit'?{handled:true,intent:'pit_execution_reason',reply:'',source:'local_authority',confidence:'requested',action:{type:'driver_plan_reason',reasonText:text}}:{handled:false};
    if(semantic.kind==='command'){
      if(semantic.explanationContinuation&&reasonTarget&&reasonTarget.operation==='early_pit')return {handled:true,intent:'pit_execution_reason',reply:'',source:'local_authority',confidence:'requested',action:{type:'driver_plan_reason',reasonText:text}};
      return {handled:true,intent:semantic.operation==='early_pit'?'pit_execution_declaration':semantic.operation==='amend'?'pit_plan_amend_request':'pit_plan_cancel_request',reply:'',source:'local_authority',confidence:'requested',action:{type:'driver_plan_command',operation:semantic.operation,requestedTargetLap:semantic.nextLap?(integer(live.lap)===null?null:integer(live.lap)+1):semantic.requestedTargetLap,reasonText:semantic.reasonText||null}};
    }
    if(semantic.kind==='ambiguous')return answer('pit_command_clarification',isJP(lang)?'ピット指示が複数ある。変更する周回か取消か、一つに確認して。':'There are conflicting pit instructions. Confirm one target lap or cancellation.');
    if(semantic.kind==='penalty'){
      const event=strategyState?.available?strategyState.pitEvents?.at(-1):null;
      const official=event?.execution_relation==='penalty'&&stratCan(strategyModule,'answerPitDecision')?strategyModule.answerPitDecision(strategyState,{lang}).reply:null;
      const flag=strategyState?.available?strategyState.black_flag:null;
      const jp=isJP(lang);
      const status=flag?.available&&flag.state==='true'?(jp?'現在のSDK黒旗はON。処罰内容と消化済みかはこのbitだけでは分からない。':'The current SDK black flag is ON; this bit does not establish the penalty requirement or completion.')
        :flag?.available&&flag.state==='false'?(jp?'現在のSDK黒旗はOFF。処罰なしや消化済みとは断定しない。':'The current SDK black flag is OFF; this does not establish no penalty or completion.')
        :(jp?'現在の黒旗状態は確認できない。':'The current black-flag state is unavailable.');
      return answer('penalty_consultation',(official?official+' ':jp?'ペナルティ対応の申告として受けた。':'I received a penalty report. ')+status+(jp?' 通常のピット変更は送っていない。':' No ordinary pit change was sent.'));

    }
    if(semantic.kind==='window_cancel')return answer('fuel_window_cancel',isJP(lang)?'了解。ウィンドウのコールを取り消した。':'Copy. The window notification is cancelled.',{type:'cancel_fuel_window_watch'});
    if(semantic.kind==='window_watch')return answer('fuel_window_watch',isJP(lang)?'了解。ウィンドウが開いたら短くコールする。':'Copy. I will call when the window opens.',{type:'arm_fuel_window_watch'});
    if(semantic.kind==='window_status')return answer('fuel_window_status',fuelWindowStatus(live,lang).reply);
    // These turns continue through the existing conversation/LLM path. No
    // later legacy pattern may reinterpret them as a current pit operation.
    if((['negated','conditional'].includes(semantic.kind)||semantic.kind==='historical'&&!PREVIOUS_FUEL_RE.test(text)||semantic.kind==='consultation'&&semantic.executionQuestion)&&semantic.topic)return {handled:false,driverIntent:semantic};

    // ★Phase 3：過去レース記録への質問（「前回給油は？」等）
    // session-memory.answerPreviousFuel() へ delegate。raceHistory + currentUserId で照合。
    if (PREVIOUS_FUEL_RE.test(text)) {
      const sessionMem = input && input.sessionMemory && typeof input.sessionMemory === 'object'
        ? input.sessionMemory : null;
      const history = Array.isArray(input.raceHistory) ? input.raceHistory : [];
      if (sessionMem && typeof sessionMem.answerPreviousFuel === 'function' && history.length > 0) {
        // ★P0-3：現セッション cust_id は live state から（Bridge → renderer live 保持 → router input.live）
        //   履歴は identity の検索対象のみ（発行元ではない）。別セッション誤認を防止
        const currentCustId = (input && input.live && input.live.cust_id) || null;
        // ★P0-3修正：car_model も identity へ渡し、session-memory の car 比較を可能に
        const identity = {
          userId: currentUserId || null,
          custId: currentCustId,
          track: live.track || null,
          car: live.car_model || null,
          carClass: live.car_class || null,
        };
        const fuelAnswer = sessionMem.answerPreviousFuel(history, identity, lang, Date.now());
        if (fuelAnswer && fuelAnswer.handled) {
          // intent を維持（pending/incomplete/unavailable も適切に返す）
          // ★Codex差戻し（残件1続き）：recordedAtはミリ秒精度で同時保存時に衝突しうるため、
          //   race識別子のfallbackとして使わない（実際に同一recordedAtの別2recordで再現
          //   された）。旧record（raceRecordId未付与）は renderer.html の loadRaceHistory()
          //   が読込時に一度だけ永続IDを付与するマイグレーションで解消する——ここでは
          //   recordedAtへの黙示フォールバックを行わず、raceRecordIdが無ければnullのまま
          //   出す（衝突しうる値を安定識別子として偽装しない）。
          const raceRecordId = (fuelAnswer.record && fuelAnswer.record.raceRecordId) || null;
          return answer(fuelAnswer.intent, fuelAnswer.reply,
            { source:'race_history', raceRecordId });
        }
      }
      return { handled:false };
    }

    // ★2026-09-13：裸の「はい」を合意へ昇格させるのは、直前に何を提案したかが
    //   session-strategy-state 側に残っている時だけ（pending_proposal・期限内）。
    //   提案が無い／期限切れなら、これまでどおり相槌のまま何も確定しない
    //   （8/29の教訓「裸のはいは確定にならない」はここでは崩さない）。
    // ★Codex差戻し（P2）：「了解」等は既に拾えていたが、提案への最も自然な
    //   肯定応答である裸の「はい／うん／ええ」がどの分岐にも無く handled:false
    //   だった（新規24検査は「了解」のみで「はい」は未検証だった）。
    if (/^(?:了解|了解です|わかった|分かった|オーケー|OK|copy|roger|understood|はい|うん|ええ)[。.!！?？]?$/i.test(text)) {
      if (strategyModule && strategyState && stratCan(strategyModule, 'resolvePendingProposal')) {
        const resolved = strategyModule.resolvePendingProposal(strategyState,
          { accepted: true, at: Date.now() });
        if (resolved && resolved.accepted && resolved.plan) {
          // ★2026-09-17 Codex MD#6/#7差戻し：状態機械が実際に適用した結果
          //   （accepted:true・このdecision_id）をrendererへ返す。Bridge発の提案
          //   だったかどうかはrenderer側が追跡し、該当する時だけ
          //   `strategy_decision_response`を送り返す——ここ（純粋な意思決定層）は
          //   I/Oを持たず、結果を返すだけ。
          return answer(strategyState.readonly_projection?'plan_confirmation_requested':'plan_confirmed', isJP(lang)
            ? (strategyState.readonly_projection?`了解、${resolved.plan.lap}周目案への承認を送る。反映を確認中。`:`了解、${resolved.plan.lap}周目でボックス。合意した。`)
            : (strategyState.readonly_projection?`Copy. Sending approval for lap ${resolved.plan.lap}; awaiting Bridge confirmation.`:`Copy. Box on lap ${resolved.plan.lap}, agreed.`),
          { planId: resolved.proposal.plan_id || null },
          { resolvedProposal: { decisionId: resolved.proposal.decision_id || null, accepted: true } });
        }
      }
      return answer('acknowledgement', isJP(lang) ? '了解。' : 'Copy.');
    }
    // 提案への明示的な否定（「いや」「やめて」等）。提案が無ければ通常経路へ流す
    // （既存の pit 取消・訂正パターンと衝突しないよう、pending_proposal がある時だけ拾う）。
    if (/^(?:いや|いいえ|やめ(?:て|とく|とこう)?|ちがう|違う|no|not now|not yet)[。.!！?？]?$/i.test(text)) {
      if (strategyModule && strategyState && stratCan(strategyModule, 'resolvePendingProposal')) {
        const declined = strategyModule.resolvePendingProposal(strategyState,
          { accepted: false, at: Date.now() });
        if (declined && declined.accepted === false) {
          return answer('plan_declined', isJP(lang)
            ? (strategyState.readonly_projection?'了解、見送りの意思を送る。現在の合意プランはBridgeで確認する。':'了解、今回は見送り。基準プランを継続。')
            : (strategyState.readonly_projection?'Copy, sending your decline. The current agreed plan remains with Bridge.':'Copy, holding off. Continuing the baseline plan.'), null,
          { resolvedProposal: {
              decisionId: (declined.proposal && declined.proposal.decision_id) || null,
              accepted: false } });
        }
      }
    }
    // Driver strategy calls consume the same A/B/C snapshot as proactive
    // radio.  The LLM must not independently recalculate or rename the plan.
    const strategyCall = strategyCallAnswer(input, live, text, lang);
    if (strategyCall) return strategyCall;
    if (/(?:燃料|給油|足りる|リットル|リッター|何(?:リットル|リッター|L)|fuel|lit(?:er|re)|make it)/i.test(text)) {
      if(strategyState?.readonly_projection){
        const a=strategyModule.answerFuel(strategyState,{lang});
        const history=a.fuel_basis==='unavailable'?historyFuelEvidence(input,live,sessionAuthority,currentUserId):null;
        const rate=history?finite(history.avgFuelPerLap):null;
        let reply=a.reply;
        if(rate!==null&&rate>0){
          const warnings=Array.isArray(history.warnings)?history.warnings:[];
          const differences=[];
          if(warnings.includes('setup_mismatch'))differences.push(isJP(lang)?'セットアップが違う':'different setup');
          if(warnings.includes('track_temp_delta'))differences.push(isJP(lang)?'路温が違う':'different track temperature');
          reply+=isJP(lang)?` 同条件の本人履歴では1周${rate.toFixed(2)}L（過去参考値）。現在の実測燃費ではなく、完走やピット指示は確定できない。${differences.length?'前回とは'+differences.join('・')+'。':''}`:` Your scoped previous record used ${rate.toFixed(2)} L per lap (historical reference). This is not current measured fuel burn and does not establish finish or pit instructions.${differences.length?' '+differences.join(', ')+'.':''}`;
        }
        return answer('fuel_status',reply,null,{confidence:rate!==null?'estimate':a.fuel_basis==='unavailable'?'unavailable':'estimate',strategyBinding:a.binding,basis:rate!==null?'historical_reference':'bridge_calculation_reference',evidence_date:history?.recordDate||null});
      }
      // ★Codex P1-1：`fuelReply()` は `pit_timing_authority`（pit前の全レース距離を
      //   前提にした旧権威）から「◯L不足」「Plan A継続」を作る。実走 18:44:53 は
      //   ピット済み・残り約2周で足りているのに「完走まで8.3L不足。Plan Aを継続」と言った。
      //   ピット実行後は**残り距離**に対してのみ答える。
      // ★Codex P2（2026-09-06／2026-09-07 差戻し）：`pitExecuted` だけを持つ部分APIが
      //   注入されると `answerFuel` 未定義で throw していた。能力確認してから使う。
      //   **pit済みと分かっているのに answerFuel が無い場合は、`fuelReply()`（pit前提の
      //   旧権威）へ落とさない。** 落とすと、ピット済みなのに「完走まで◯L不足」という
      //   実走18:44:53の誤りをそのまま再現する。答えられないなら fail-closed で黙る。
      // ★2026-09-14 Yuji指示：session-memory.strategyFuelEvidence()（本人・同条件の
      //   過去燃費）が answerFuel の梯子へ一度も配線されていなかった（2026-09-13独立
      //   調査で既知）。ライブ実測が無い時だけ暫定根拠として渡す——ライブが有る限り
      //   ライブを優先する（「本人履歴を先に見つけたから終了」にしない、Codex 9/13指摘）。
      const fuelEvidenceNow = historyFuelEvidence(input, live, sessionAuthority, currentUserId);
      const historyEvidence = fuelEvidenceNow;
      const historyPerLapL = fuelEvidenceNow ? finite(fuelEvidenceNow.avgFuelPerLap) : null;
      // ★2026-09-14 Codex差戻し：履歴根拠で答えた時は confidence を推定へ落とし、
      //   setup違い・路温差は本文にも明示する（本文の「暫定」と機械契約を一致させる）。
      const historyOverrides = () => {
        const ev = historyEvidence;
        const warns = (ev && Array.isArray(ev.warnings)) ? ev.warnings : [];
        return { confidence: warns.length ? 'estimate_low' : 'estimate',
          basis: 'memory_previous', evidence_warnings: warns,
          evidence_date: (ev && ev.recordDate) || null };
      };
      const historyDiffNote = () => {
        const ev = historyEvidence;
        const warns = (ev && Array.isArray(ev.warnings)) ? ev.warnings : [];
        if (!warns.length) return '';
        const bits = [];
        if (warns.indexOf('setup_mismatch') >= 0) bits.push(isJP(lang) ? 'セットアップが違う' : 'different setup');
        if (warns.indexOf('track_temp_delta') >= 0) {
          const d = ev && finite(ev.trackTempDeltaC);
          bits.push(isJP(lang)
            ? `路温差${d !== null ? d.toFixed(0) : ''}℃`
            : `track temp differs by ${d !== null ? d.toFixed(0) : ''}C`);
        }
        if (!bits.length) return '';
        return isJP(lang) ? `（前回とは${bits.join('・')}）` : ` (vs last time: ${bits.join(', ')})`;
      };

      // ★e09：残り周回が係争中なら、燃料の答えも一方の数を事実として断定しない。
      //   両方の数で条件付きに答える。再観測が来ていれば解除され、確定値で答える。
      const lapsStateForFuel = (stratCan(strategyModule, 'lapsRemainingStatus') && strategyState)
        ? strategyModule.lapsRemainingStatus(strategyState,
          { laps_remaining: integer(live.finish_crossings_authority), at: Date.now(),
            observation_id: observationIdNow })
        : null;
      if (lapsStateForFuel && lapsStateForFuel.held === true
          && stratCan(strategyModule, 'answerFuel') && finite(live.fuel) !== null) {
        const fsH = (live.fuel_strategy && typeof live.fuel_strategy === 'object') ? live.fuel_strategy : {};
        const a = strategyModule.answerFuel(strategyState, {
          fuel_l: finite(live.fuel),
          per_lap_l: finite(fsH.avg_fuel_per_lap) !== null ? finite(fsH.avg_fuel_per_lap)
            : finite(live.fuel_per_lap_l),
          history_per_lap_l: historyPerLapL,
          laps_dispute: { driver_laps: lapsStateForFuel.driver_laps, sdk_laps: lapsStateForFuel.sdk_laps },
          at: Date.now(),
        });
        if (a && a.laps_disputed === true && a.reply) {
          return answer('fuel_status_laps_disputed', a.reply, null, { confidence: 'held' });
        }
      }
      const lapsForFuel = lapsStateForFuel && lapsStateForFuel.laps_remaining !== null
        ? integer(lapsStateForFuel.laps_remaining)
        : integer(live.finish_crossings_authority);
      const pitKnownExecuted = strategyModule && strategyState
        && stratCan(strategyModule, 'pitExecuted') && strategyModule.pitExecuted(strategyState);
      if (pitKnownExecuted) {
        if (!stratCan(strategyModule, 'answerFuel')) return { handled:false };
        // ★2026-09-06：ここは独自に文を組み立てていたため、`answerFuel()` が
        //   **製品から一度も呼ばれない**まま残っていた（wiring lint が検出）。
        //   燃料判定の正本は state 側に一本化する。
        const fs2 = (live.fuel_strategy && typeof live.fuel_strategy === 'object') ? live.fuel_strategy : {};
        const a = strategyModule.answerFuel(strategyState, {
          fuel_l: finite(live.fuel),
          per_lap_l: finite(fs2.avg_fuel_per_lap) !== null ? finite(fs2.avg_fuel_per_lap)
            : finite(live.fuel_per_lap_l),
          history_per_lap_l: historyPerLapL,
          laps_remaining: lapsForFuel,
          at: Date.now(),
        });
        if (a && a.fuel_basis === 'memory_previous') {
          return answer('fuel_status', a.reply + historyDiffNote(), null, historyOverrides());
        }
        return answer('fuel_status', a && a.reply);
      }
      // pit未実行・または pit実行の可否自体が分からない：まず旧経路（pit_timing_authority
      // やendurance計画等、履歴より詳しい権威があればそちらを優先する）。
      const preFuelReply = fuelReply(live, lang);
      // ★旧経路が最終の「実測がまだ足りない」catch-allまで落ちた時だけ、履歴フォールバックで
      //   置き換える——fuelReplyの他の分岐（pit_timing_authority等）を迂回しない。
      const isWeakestFallback = isJP(lang)
        ? preFuelReply === '燃料の実測がまだ足りない。クリーンラップを待つ。'
        : preFuelReply === 'I need clean-lap fuel data before I can calculate the requirement.';
      if (isWeakestFallback && historyPerLapL !== null && stratCan(strategyModule, 'answerFuel')) {
        const liveFuel = finite(live.fuel);
        if (liveFuel !== null) {
          const a = strategyModule.answerFuel(strategyState, {
            fuel_l: liveFuel, per_lap_l: null, history_per_lap_l: historyPerLapL,
            laps_remaining: lapsForFuel, at: Date.now(),
          });
          if (a && a.reply) {
            return a.fuel_basis === 'memory_previous'
              ? answer('fuel_status', a.reply + historyDiffNote(), null, historyOverrides())
              : answer('fuel_status', a.reply);
          }
        }
      }
      return answer('fuel_status', preFuelReply);
    }
    // Build 287 field replay: Google correctly transcribed both
    // "ベストラップ いくつ？" and the punctuation-shifted
    // "ベストラップ わかります。".  Sending either to the LLM let the
    // telemetry truth gate discard the correct number and reduce it to an
    // unrelated acknowledgement.  Best lap is already a Bridge-owned fact,
    // so answer it here from the same live snapshot.
    if (/(?:ベスト|自己ベスト|ベストラップ).{0,10}(?:いくつ|何|わかる|分かる|わかります|分かります|教えて|タイム)|(?:best|personal best).{0,12}(?:what|time|know|tell)/i.test(text)) {
      const best = formatLapTime(live.best, lang);
      return answer('best_lap', best
        ? (isJP(lang) ? `ベスト${best}。` : `Best lap ${best}.`)
        : (isJP(lang) ? 'ベストラップはまだ確定していない。' : 'The best lap is not confirmed yet.'));
    }
    // A driver may say 入ってる/来てる quickly enough for STT to produce
    // 行ってる or 空いてる.  In a live session those variants all ask
    // whether PITWALL is receiving the current session data; they are not
    // authority to invent a track or car name.
    if (/(?:コース|セッション)?\s*データ.{0,8}(?:入って|はいって|行って|いって|来て|きて|取れて|届いて|空いて|あいて)|(?:data|telemetry).{0,12}(?:coming|connected|receiv|working)/i.test(text)) {
      const scoped = !!(sessionAuthority && (sessionAuthority.track || sessionAuthority.car_model || sessionAuthority.session_type));
      return answer('telemetry_status', isJP(lang)
        ? (scoped ? 'データは来ている。コースと車両も確認済み。' : 'テレメトリは来ている。セッション詳細は確認中。')
        : (scoped ? 'Data is live. Track and car are confirmed.' : 'Telemetry is live. Session details are still being confirmed.'));
    }
    if (/(?:レース.{0,10})?(?:フォーマット|フォーマー|形式)|何分\s*(?:制|製)(?:の)?(?:レース)?|session format|race format/i.test(text)) {
      const plan = live.race_plan && typeof live.race_plan === 'object' ? live.race_plan : {};
      const duration = finite(plan.configured_duration_s);
      if (plan.kind === 'timed' && duration !== null) {
        return answer('race_format', isJP(lang)
          ? `${formatDuration(duration, lang)}のタイムレース。`
          : `${formatDuration(duration, lang)} timed race.`);
      }
      const total = integer(live.laps_total);
      if (plan.kind === 'laps' && total !== null) return answer('race_format', isJP(lang) ? `全${total}周。` : `${total} laps total.`);
      return answer('race_format_unavailable', isJP(lang) ? 'このレースの時間・周回ルールはまだ確定できない。' : 'The race duration and lap rule are not confirmed yet.');
    }
    // ★2026-09-06 Build 298 実走：ピット周の質問と申告を、残り周回より先に見る。
    //   「何周目にピットインする？」は `何周` を含むため、順序を誤ると
    //   残り周回の質問として食われる。実走ではそもそも `何週` で unhandled だった。
    //   合意Plan・pit実績は session-strategy-state が唯一の正本。
    if (/(?:何周目|いつ|どこ).{0,8}(?:ピット|ボックス|box)|(?:ピット|ボックス).{0,10}(?:何周目|いつ|予定)/i.test(text)
        || /pit.{0,10}(?:which lap|what lap|when)|when.{0,10}pit/i.test(text)) {
      if (strategyModule && strategyState && stratCan(strategyModule, 'answerPitDecision')) {
        const a = strategyModule.answerPitDecision(strategyState,
          { at: Date.now(), lang, laps_remaining: integer(live.finish_crossings_authority) });
        return answer('pit_plan_question', a && a.reply);
      }
      return answer('pit_plan_question', isJP(lang)
        ? 'ピット周はまだ決めていない。'
        : 'The pit lap is not agreed yet.');
    }

    // ★2026-09-06：訂正・取消をPlan状態へ繋ぐ。Founder 固定要件
    //   「訂正・取消・聞き返し後もPlan状態を追跡する」に対し、
    //   これまで `amendPitPlan` / `cancelPitPlan` は **API を作っただけで製品経路が無かった**
    //   （wiring lint が未配線として検出）。合意済みのPlanがある時だけ受ける。
    // ★Codex P1-1（2026-09-06 差戻し・第2回）：`やめない`／`取り消さない`のような
    //   語尾直結の否定形は塞いだが、**助詞を挟む自然な否定**
    //   （「キャンセルは**しない**」「中止に**しない**」「やめることは**しない**」
    //   「取り消すつもりは**ない**」）を落としていた。取消語の**否定scope**を
    //   広く見る：取消語から10文字以内に「ない」が現れたら、確定表現として扱わない。
    //   窓を広げた分、無関係な文をまたいで誤検出する余地は残る（当方の判断・要確認）。
    // ★Codex P1-1（2026-09-07 第3回差戻し）：10文字窓は「ピット中止、タイヤ交換は
    //   **しない**。」のような**別命令の否定**を巻き込んでいた。
    //   最初に節（読点・句点・！・？区切り）へ分割してから判定する版を作ったが、
    //   実際に節境界を効かせているのは**否定側の正規表現に読点を除外文字として
    //   含めていること**であり、分割は何もしていなかった（変異試験 M-W12 で発覚：
    //   分割を無効化しても結果が変わらなかった）。分割を削り、正規表現1本にする。
    //   `[^、。！?？]{0,10}` が読点・句点をまたげないので、「中止、タイヤ交換は
    //   しない」の`ない`は`中止`から見て読点の先にあり、そもそも到達できない。
    const PIT_CANCEL_WORD = /(?:ピット|ボックス|box).{0,8}(?:やめ|取り消|キャンセル|中止)|(?:やめ|取り消|キャンセル|中止).{0,8}(?:ピット|ボックス|box)/i;
    const PIT_CANCEL_NEGATED = /(?:やめ|取り消|キャンセル|中止)[^、。！?？]{0,10}ない/;
    if (!/[?？]/.test(text) && PIT_CANCEL_WORD.test(text) && !PIT_CANCEL_NEGATED.test(text)) {
      if (!stratCan(strategyModule, 'pitPlan') || !stratCan(strategyModule, 'cancelPitPlan')) {
        return { handled:false };   // P2：能力が無ければ確定させず fail-closed
      }
      const had = strategyModule.pitPlan(strategyState) || null;
      if (!had) {
        return answer('pit_plan_cancel', isJP(lang)
          ? '取り消すピット予定が無い。' : 'There is no agreed pit plan to cancel.');
      }
      strategyModule.cancelPitPlan(strategyState, { source: 'driver', at: Date.now() });
      return answer('pit_plan_cancel', isJP(lang)
        ? `${had.lap}周目のピットは取り消した。`
        : `Cancelled the pit stop planned for lap ${had.lap}.`);
    }

    // 「やっぱり14周目」＝合意済みPlanの訂正。周が読めない訂正は受けない（推測しない）。
    // ★Codex P1-2（2026-09-06 差戻し）：現在9周・合意12周の状態で「やっぱり5周」（過去）
    //   「やっぱり999周」（範囲外）を**無検証で確定保存**していた。current lap・
    //   総周回／残り周回のauthorityがあれば範囲検証し、authority不足でも
    //   999のような値を無条件確定しない。成立しない指定はPlanを維持したまま聞き返す。
    if (!/[?？]/.test(text)
        && /(?:やっぱり|やはり|変更|訂正|じゃなくて)/.test(text)
        && /(?:ピット|ボックス|box)|周/.test(text)) {
      if (!stratCan(strategyModule, 'pitPlan') || !stratCan(strategyModule, 'amendPitPlan')) {
        return { handled:false };   // P2：能力が無ければ確定させず fail-closed
      }
      const lapM = text.match(/([0-9０-９]{1,3})\s*周/);
      const lap = lapM ? integer(lapM[1].replace(/[０-９]/g, d => '０１２３４５６７８９'.indexOf(d))) : null;
      const cur = strategyModule.pitPlan(strategyState) || null;
      if (!cur) return { handled:false };
      if (lap === null) {
        return answer('pit_plan_amend', isJP(lang)
          ? `今は${cur.lap}周目で合意している。何周目に変える？`
          : `We agreed on lap ${cur.lap}. Which lap instead?`);
      }
      const currentLap = integer(live.lap);
      // 現在周が分からなければ、過去／範囲外の判定ができないので確定しない。
      if (currentLap === null) {
        return answer('pit_plan_amend', isJP(lang)
          ? `今の周回が確認できない。今は${cur.lap}周目で合意したまま。`
          : `Current lap is not confirmed. Keeping the agreed stop at lap ${cur.lap}.`);
      }
      if (lap < currentLap) {
        return answer('pit_plan_amend', isJP(lang)
          ? `${lap}周目は既に過ぎている。今は${currentLap}周目。何周目に変える？`
          : `Lap ${lap} has already passed (we're on lap ${currentLap}). Which lap instead?`);
      }
      const ceiling = resolvePitLapCeiling(currentLap, live);
      if (ceiling !== null) {
        if (lap > ceiling.total) {
          return answer('pit_plan_amend', isJP(lang)
            ? `${lap}周目はレース範囲外（全${ceiling.total}周）。今は${cur.lap}周目で合意したまま。`
            : `Lap ${lap} is beyond the race (${ceiling.total} laps total). Keeping lap ${cur.lap}.`);
        }
      } else if (lap > currentLap + 1) {
        // ★Codex 指摘：authority が無い時に「999等を無条件確定しない」ための固定capは
        //   耐久で正当な先の周（+20超）まで拒否してしまうため廃止した。現在周・次周を
        //   超える指定は、authority が無い限り**確定も拒否もせず**、一度だけ確認する。
        return answer('pit_plan_amend', isJP(lang)
          ? `${lap}周目まで有効か確認できない。今は${cur.lap}周目で合意したまま。何周目に変える？`
          : `Cannot confirm lap ${lap} is valid yet. Keeping lap ${cur.lap}. Which lap instead?`);
      }
      strategyModule.amendPitPlan(strategyState, { lap, source: 'driver', at: Date.now() });
      return answer('pit_plan_amend', isJP(lang)
        ? `${cur.lap}周目から${lap}周目へ変更した。`
        : `Moved the stop from lap ${cur.lap} to lap ${lap}.`);
    }

    // 「この周でピットイン だ。」＝Plan申告（質問ではない）。
    // ★Codex P1-4：「この／今の」と「次の」を同じ分岐に潰していた。
    //   S/F を1回またぐかどうかが違う。「次の周」は current+1 で保存し、復唱も変える。
    //   現在周が取れない時は**推測しない**（周を確定できないまま合意扱いにしない）。
    if (!/[?？]/.test(text)
        && /(?:この|今の|次の)\s*周.{0,6}(?:ピット|ボックス|box)|(?:ピット|ボックス).{0,6}(?:この|今の|次の)\s*周/i.test(text)) {
      const nextLap = /次の\s*周/.test(text);
      const currentLap = integer(live.lap);
      const planLap = currentLap === null ? null : (nextLap ? currentLap + 1 : currentLap);
      if (strategyModule && strategyState && planLap !== null
          && stratCan(strategyModule, 'agreePitPlan')) {
        strategyModule.agreePitPlan(strategyState,
          { lap: planLap, source: 'driver', at: Date.now() });
      }
      if (planLap === null) {
        return answer('pit_this_lap', isJP(lang)
          ? '現在周を確定できない。周を教えて。'
          : 'I cannot confirm the current lap. Tell me the lap.');
      }
      return answer('pit_this_lap', isJP(lang)
        ? (nextLap ? `次の周の終わりでボックス。${planLap}周目。` : `この周の終わりでボックス。${planLap}周目。`)
        : (nextLap ? `Box at the end of the next lap, lap ${planLap}.` : `Box at the end of this lap, lap ${planLap}.`));
    }

    // ★2026-09-14 fixture e09：「残り、一周少なく数えてない？ あと9周だよ。」
    //   driver の申告と SDK の残り周回が食い違う。GAP には gapHeld（保留）が
    //   あるのに laps_remaining には無く、申告を黙って採用する（＝申告を実測と偽る）か
    //   無視して旧案を押し通すかしか無かった。保留を立て、**両方の数を区別したまま
    //   条件付きで答える**。確定は次の観測に委ねる（session-strategy-state 参照）。
    if (stratCan(strategyModule, 'disputeLapsRemaining') && strategyState) {
      const claim = text.match(/(?:あと|残り)\s*(\d{1,2})\s*(?:周|ラップ)/)
        || text.match(/(\d{1,2})\s*laps?\s*(?:to go|left|remaining)/i);
      const isCommand = /ピット|ボックス|給油|入る|入れ|box\b|pit\b|fuel/i.test(text);
      const claimLaps = claim ? integer(claim[1]) : null;
      const sdkLaps = integer(live.finish_crossings_authority);
      const correctionMark = /少なく|多く|数え|違う|ちがう|間違|おかしい|ずれ|miscount|wrong|off by/i.test(text);
      // 申告が現在のSDK値と食い違う時、または明示的な訂正表現がある時だけ扱う。
      // 「あと5周でピットイン」のような指示文は対象外（命令語を含む）。
      if (claimLaps !== null && !isCommand
          && (correctionMark || (sdkLaps !== null && claimLaps !== sdkLaps))) {
        const d = strategyModule.disputeLapsRemaining(strategyState,
          { driver_laps: claimLaps, laps_remaining: sdkLaps, at: Date.now(),
            observation_id: observationIdNow });
        if (d && d.agreed === true) {
          return answer('laps_remaining_confirmed', isJP(lang)
            ? `こちらの計測も残り${claimLaps}周。合っている。`
            : `My count agrees: ${claimLaps} laps remaining.`);
        }
        if (d && d.held === true) {
          const disputeHistoryEvidence = historyFuelEvidence(input, live, sessionAuthority, currentUserId);
          const fsD = (live.fuel_strategy && typeof live.fuel_strategy === 'object') ? live.fuel_strategy : {};
          const perLapD = finite(fsD.avg_fuel_per_lap) !== null ? finite(fsD.avg_fuel_per_lap)
            : finite(live.fuel_per_lap_l);
          if (isJP(lang) && stratCan(strategyModule, 'answerFuel')
              && finite(live.fuel) !== null && (perLapD !== null || (disputeHistoryEvidence ? finite(disputeHistoryEvidence.avgFuelPerLap) : null) !== null)) {
            const a = strategyModule.answerFuel(strategyState, {
              fuel_l: finite(live.fuel), per_lap_l: perLapD,
              history_per_lap_l: (disputeHistoryEvidence ? finite(disputeHistoryEvidence.avgFuelPerLap) : null),
              laps_dispute: { driver_laps: claimLaps, sdk_laps: sdkLaps }, at: Date.now(),
            });
            if (a && a.reply && a.laps_disputed === true) {
              return answer('laps_remaining_disputed', a.reply, null, { confidence: 'held' });
            }
          }
          return answer('laps_remaining_disputed', isJP(lang)
            ? `こちらの計測は残り${sdkLaps === null ? '不明' : sdkLaps + '周'}、君の申告は${claimLaps}周。`
              + `どちらか確定するまで${sdkLaps === null ? '' : sdkLaps + '周前提の'}判断は続けない。次の計測で言い直す。`
            : `My count is ${sdkLaps === null ? 'unavailable' : sdkLaps + ' laps'}, yours is ${claimLaps}. `
              + 'I will hold that call until the next observation.', null, { confidence: 'held' });
        }
      }
    }
    if (!/(?:トップ|首位|P1|leader)/i.test(text)
        && /残り.{0,5}(?:周|ラップ)|あと.{0,5}(?:周|ラップ)|何周|laps? (?:left|remaining)/i.test(text)) {
      // 保留中は SDK 値を唯一の事実として断定しない。再観測が来ていれば自動で解ける。
      if (stratCan(strategyModule, 'lapsRemainingStatus') && strategyState) {
        const st9 = strategyModule.lapsRemainingStatus(strategyState,
          { laps_remaining: integer(live.finish_crossings_authority), at: Date.now(),
            observation_id: observationIdNow });
        if (st9 && st9.held === true) {
          return answer('laps_remaining_disputed', isJP(lang)
            ? `残り周回はまだ確定していない。こちらの計測は${st9.sdk_laps === null ? '不明' : st9.sdk_laps + '周'}、君の申告は${st9.driver_laps}周。次の計測で言い直す。`
            : `Laps remaining are unresolved: my count ${st9.sdk_laps === null ? 'unavailable' : st9.sdk_laps}, yours ${st9.driver_laps}. I will confirm at the next observation.`,
            null, { confidence: 'held' });
        }
        if (st9 && st9.released === true && st9.laps_remaining !== null) {
          return answer('laps_remaining', isJP(lang)
            ? `残り${st9.laps_remaining}周で確定。${st9.matched_driver ? '君の申告どおりだった。' : 'さっきの申告とは違う値だ。'}`
            : `Confirmed: ${st9.laps_remaining} laps remaining.${st9.matched_driver ? ' Your count was right.' : ''}`);
        }
      }
      const crossings = integer(live.finish_crossings_authority);
      if (crossings !== null && crossings >= 1 && crossings <= 10) return answer('laps_remaining', isJP(lang) ? `残り${crossings}周。` : `${crossings} lap${crossings === 1 ? '' : 's'} remaining.`);
      const remaining = finite(live.session_time_remaining_s);
      return answer('laps_remaining', remaining !== null
        ? (isJP(lang) ? `残り${formatDuration(remaining, lang)}。残り周回はまだ確定できない。` : `${formatDuration(remaining, lang)} remain; finish crossings are not confirmed.`)
        : (isJP(lang) ? '残り周回の権威データがない。' : 'Authoritative finish distance is unavailable.'));
    }
    if (/何分|レース時間|残り時間|how (?:long|much time)|time (?:left|remaining)/i.test(text)) {
      const remaining = finite(live.session_time_remaining_s);
      if (remaining !== null) return answer('time_remaining', isJP(lang) ? `残り${formatDuration(remaining, lang)}。` : `${formatDuration(remaining, lang)} remaining.`);
    }
    const weatherQuestion = /天気|天候|気温|路面(?:温度|状況)|路温|トラック温度|雨|濡れ|湿度|weather|track temp|air temp|rain|wet/i.test(text);
    if (weatherQuestion && /昨日|前回|前の(?:レース|走行|セッション)|yesterday|last (?:race|run|session)/i.test(text)) {
      return answer('historical_weather_unavailable', isJP(lang)
        ? '前回の天候記録は確認できない。現在値では代用しない。'
        : 'I cannot verify the previous weather record. I will not substitute the current value.');
    }
    if (weatherQuestion) {
      const w = weatherValues(live);
      if (/路面(?:温度)?|路温|トラック温度|track temp/i.test(text)) return answer('track_temperature', w.track !== null
        ? (isJP(lang) ? `路面${w.track.toFixed(1)}℃。` : `Track temperature ${w.track.toFixed(1)}C.`)
        : (isJP(lang) ? '現在の路面温度は取得できない。' : 'Current track temperature is unavailable.'));
      const wetJP = {1:'ドライ',2:'ほぼドライ',3:'ごく薄いウェット',4:'ライトウェット',5:'ウェット',6:'かなりウェット',7:'極端なウェット'};
      const parts = [];
      if (w.track !== null) parts.push(isJP(lang) ? `路面${w.track.toFixed(1)}℃` : `track ${w.track.toFixed(1)}C`);
      if (w.air !== null) parts.push(isJP(lang) ? `気温${w.air.toFixed(1)}℃` : `air ${w.air.toFixed(1)}C`);
      if (w.humidity !== null) parts.push(isJP(lang) ? `湿度${w.humidity.toFixed(0)}%` : `humidity ${w.humidity.toFixed(0)}%`);
      if (w.wet !== null) parts.push(isJP(lang) ? `路面${wetJP[Math.trunc(w.wet)] || '不明'}` : `surface code ${Math.trunc(w.wet)}`);
      return answer('weather_status', parts.length
        ? `${parts.join(isJP(lang) ? '、' : ', ')}。`
        : (isJP(lang) ? '現在の天候テレメトリは取得できない。' : 'Current weather telemetry is unavailable.'));
    }
    // ★修正2：上位クラス接近の照会。クラス名だけで推測せず、実測 competitors から
    //   「どの車が・何秒」を答える。無ければ理由を言う（汎用拒否へ落とさない）。
    if (/(?:GTP|上位クラス|速いクラス|別クラス).{0,10}(?:来て|きて|どこ|どう|近い|後ろ|接近|ギャップ|差|何秒)|(?:来て|接近).{0,8}(?:GTP|上位クラス)/i.test(text)) {
      const list = Array.isArray(live.competitors) ? live.competitors : [];
      const behind = list
        .map(c => ({ idx: integer(c && c.car_idx), num: c && c.car_number, gap: finite(c && c.gap_s) }))
        .filter(c => c.idx !== null && c.gap !== null && c.gap > 0)
        .sort((a, b) => a.gap - b.gap);
      const nearest = behind[0];
      if (nearest) {
        const who = nearest.num ? '#' + nearest.num : 'CarIdx ' + nearest.idx;
        return answer('faster_class_status', isJP(lang)
          ? who + '、' + nearest.gap.toFixed(1) + '秒後方。'
          : 'Nearest behind is ' + who + ' at ' + nearest.gap.toFixed(1) + ' seconds.');
      }
      return answer('faster_class_unavailable', isJP(lang)
        ? '上位クラスの接近は今の実測では確定できない。推測では言わない。'
        : 'I cannot confirm a faster-class approach from the current measurement; I will not guess.');
    }
    // ★修正2：接近コール／GAPへの訂正は「質問」ではなく記録への操作。
    //   汎用の拒否文へ落とさず、保留にする意思表示を返す。
    if (/(?:まだ|全然)[^。]{0,10}秒以内[^。]{0,8}(?:入って|来て)ない|(?:その|そんな)[^。]{0,6}(?:差|ギャップ|距離)[^。]{0,6}(?:じゃない|違う|ちがう)/i.test(text)) {
      return answer('measurement_disputed', isJP(lang)
        ? '了解。その値は保留にする。次の計測で言い直す。'
        : 'Copy. I am holding that value and will re-report it at the next measurement.');
    }
    if (/(?:ちゃんと|さっき).{0,10}(?:ギャップ|GAP).{0,10}(?:答えた|言えた|出た)/i.test(text)) {
      return answer('gap_reply_acknowledgement', isJP(lang) ? '了解。' : 'Copy.');
    }
    const incidentAverage = text.match(/(?:ここ|直近|最近|過去)?\s*(\d{1,2})\s*(?:レース|戦|走行).{0,14}(?:インシデント|incident).{0,10}(?:平均|アベレージ|average)|(?:インシデント|incident).{0,14}(?:ここ|直近|最近|過去)?\s*(\d{1,2})\s*(?:レース|戦|走行).{0,10}(?:平均|アベレージ|average)/i);
    if (incidentAverage) {
      const requested = Math.min(10, Math.max(1, Number(incidentAverage[1] || incidentAverage[2])));
      if (!currentUserId) return answer('incident_average_unavailable', isJP(lang)
        ? '本人の成績記録を確認できない。ログイン状態を確認して。'
        : 'I cannot identify the driver record. Check the signed-in account.');
      const rows = raceHistory.filter(row => row && String(row.userId ?? '') === currentUserId
        && integer(row.incidents) !== null).slice(-requested);
      if (rows.length < requested) return answer('incident_average_unavailable', isJP(lang)
        ? `本人記録は${rows.length}レース分。直近${requested}レースの平均には足りない。`
        : `Only ${rows.length} personal race records are available; ${requested} are required.`);
      const total = rows.reduce((sum, row) => sum + integer(row.incidents), 0);
      const average = total / rows.length;
      return answer('incident_average', isJP(lang)
        ? `直近${requested}レースは合計${total}、平均${average.toFixed(1)}インシデント。`
        : `Across the last ${requested} races: ${total} incidents, ${average.toFixed(1)} on average.`);
    }
    if (/(?:走り始め|走行(?:中|開始)|グリーン).{0,12}(?:ギャップ|GAP).{0,12}(?:教えて|言って|コール)|(?:when|once).{0,12}(?:driving|green).{0,12}(?:gap|difference)/i.test(text)) {
      return answer('gap_reporting_acknowledgement', isJP(lang)
        ? '了解。走行中は質問に前後GAPで答える。変化が大きければこちらからもコールする。'
        : 'Copy. I will answer with the nearest gaps and call material changes while running.');
    }
    // Nearest-car gaps are distinct from the class-leader gap.  This must be
    // evaluated first: a driver asking "後ろとの差" must never fall through
    // to an LLM/no-data template while the Bridge already has gap_behind.
    if (/(?:前|後ろ|後方|前後).{0,8}(?:ギャップ|差)|(?:ギャップ|差).{0,8}(?:前|後ろ|後方)|(?:ahead|behind).{0,12}(?:gap|difference)|(?:gap|difference).{0,12}(?:ahead|behind)|^(?:出ました[。.!！\s]*)?(?:前|後ろ|後方)(?:は|どう)[。.!！?？]*$/i.test(text)) {
      const wantsBoth = /前後|both/i.test(text);
      const wantsAhead = wantsBoth || /前|ahead/i.test(text);
      const wantsBehind = wantsBoth || /後ろ|後方|behind/i.test(text);
      // ★G3：値があっても古ければ答えない。古い数字を今の事実として渡さない。
      //   接続判定(12秒)より厳しくし、G2 の再生側(5秒)と同じ基準に揃える。
      if (snapshotAgeMs !== null && snapshotAgeMs > GAP_ANSWER_MAX_AGE_MS) {
        return answer('nearest_gap_stale', isJP(lang)
          ? 'いまのGAPは取れていない。少し待って。'
          : 'I do not have a current gap right now. Give me a moment.');
      }
      const ahead = gapHeld.ahead ? null : finite(live.gap_ahead);
      const behind = gapHeld.behind ? null : finite(live.gap_behind);
      if ((wantsAhead && gapHeld.ahead && !(wantsBehind && !gapHeld.behind))
          || (wantsBehind && gapHeld.behind && !(wantsAhead && !gapHeld.ahead))) {
        const heldDirection = (wantsBehind && gapHeld.behind) ? 'behind' : 'ahead';
        return answer('nearest_gap_held', isJP(lang)
          ? `${heldDirection === 'ahead' ? '前' : '後ろ'}の車間は未確認。前の値は保留にした。次の観測で言い直す。`
          : `The gap ${heldDirection} is unconfirmed; the previous value is on hold until the next observation.`);
      }
      const parts = [];
      const identities = [];
      if (wantsAhead && ahead !== null) {
        parts.push(gapPhrase(live,'ahead',ahead,lang));
        identities.push(gapIdentityFor(live, 'ahead', ahead));
      }
      if (wantsBehind && behind !== null) {
        parts.push(gapPhrase(live,'behind',behind,lang));
        identities.push(gapIdentityFor(live, 'behind', behind));
      }
      if (parts.length) return gapAnswer('nearest_gap', isJP(lang) ? `${parts.join('、')}。` : `${parts.join(', ')}.`, identities);
      const requested = wantsAhead && wantsBehind ? (isJP(lang) ? '前後のGAP' : 'The nearest gaps')
        : wantsAhead ? (isJP(lang) ? '前のGAP' : 'Gap ahead') : (isJP(lang) ? '後ろのGAP' : 'Gap behind');
      return answer('nearest_gap_unavailable', isJP(lang)
        ? `${requested}はまだ取れていない。`
        : `${requested} is not available yet.`);
    }
    if (/(?:ギャップ|GAP|gap).{0,8}(?:どう|教えて|何秒|どれくらい|どのくらい|[?？])|(?:どう|何秒).{0,8}(?:ギャップ|GAP|gap)/i.test(text)) {
      // ★G3：値があっても古ければ答えない。古い数字を今の事実として渡さない。
      //   接続判定(12秒)より厳しくし、G2 の再生側(5秒)と同じ基準に揃える。
      if (snapshotAgeMs !== null && snapshotAgeMs > GAP_ANSWER_MAX_AGE_MS) {
        return answer('nearest_gap_stale', isJP(lang)
          ? 'いまのGAPは取れていない。少し待って。'
          : 'I do not have a current gap right now. Give me a moment.');
      }
      const ahead = finite(live.gap_ahead);
      const behind = finite(live.gap_behind);
      const parts = [];
      const identities = [];
      if (ahead !== null) {
        parts.push(gapPhrase(live,'ahead',ahead,lang));
        identities.push(gapIdentityFor(live, 'ahead', ahead));
      }
      if (behind !== null) {
        parts.push(gapPhrase(live,'behind',behind,lang));
        identities.push(gapIdentityFor(live, 'behind', behind));
      }
      if (parts.length) return gapAnswer('nearest_gap',
        isJP(lang) ? `${parts.join('、')}。` : `${parts.join(', ')}.`, identities);
      return answer('nearest_gap_unavailable',
        isJP(lang) ? 'ごめん、前後のGAPはまだ取れていない。次の計測で言う。'
          : 'Sorry — the nearest gaps are not available yet. I will call them at the next measurement.');
    }
    if (/(?:トップ|首位|P1|leader).{0,10}(?:何周|何ラップ|周回|ラップ数|lap)|(?:何周|何ラップ|周回|ラップ数).{0,10}(?:トップ|首位|P1|leader)/i.test(text)) {
      const wantsOverall = /総合|GTP|gdp|overall/i.test(text);
      const leader = wantsOverall ? live.leaders && live.leaders.overall : live.leaders && live.leaders.player_class;
      const lap = integer(leader && leader.lap);
      return answer('leader_lap', lap !== null && lap > 0
        ? (isJP(lang) ? `${wantsOverall ? '総合首位' : 'クラス首位'}は${lap}周目。` : `The ${wantsOverall ? 'overall' : 'class'} leader is on lap ${lap}.`)
        : (isJP(lang) ? `${wantsOverall ? '総合首位' : 'クラス首位'}の周回数は取得できない。` : `The ${wantsOverall ? 'overall' : 'class'} leader lap is unavailable.`));
    }
    if (/トップ|首位|P1|何秒|ギャップ|差|leader|gap/i.test(text)) {
      const wantsOverall = /総合|GTP|gdp|overall/i.test(text);
      const leader = wantsOverall ? live.leaders && live.leaders.overall : live.leaders && live.leaders.player_class;
      const gap = finite(leader && leader.gap_s);
      return answer('leader_gap', gap !== null
        ? (isJP(lang) ? `${wantsOverall ? '総合首位' : 'クラス首位'}まで${Math.abs(gap).toFixed(1)}秒。` : `${Math.abs(gap).toFixed(1)} seconds to the ${wantsOverall ? 'overall' : 'class'} leader.`)
        : (isJP(lang) ? `${wantsOverall ? '総合首位' : 'クラス首位'}とのGAPは取得できない。直前車のGAPでは代用しない。` : `Gap to the ${wantsOverall ? 'overall' : 'class'} leader is unavailable; I will not substitute the nearest-car gap.`));
    }
    if (/(?:今|現在).{0,6}(?:順位|ポジション)|(?:順位|ポジション).{0,6}(?:何|どこ|いくつ)|current (?:position|place)/i.test(text)) {
      const position = integer(live.player_class_position ?? live.class_position ?? live.class_pos);
      return answer('current_position', position !== null && position > 0
        ? (isJP(lang) ? `現在P${position}。` : `Currently P${position}.`)
        : (isJP(lang) ? '現在順位の権威データがない。' : 'Authoritative current position is unavailable.'));
    }
    if (!/[?？]/.test(text) && /(?:俺たち|うち|自分).{0,8}ピット.{0,12}出口.{0,8}近|our pit.{0,12}(?:near|close to).{0,8}(?:the )?exit/i.test(text)) {
      return answer('pit_location_ack', isJP(lang) ? '了解。ボックスは出口寄りだな。' : 'Copy. Our box is near pit exit.');
    }
    // Narrow race-side acknowledgements keep an ordinary driver comment out
    // of a long conversation history, where Build 279 replayed an unrelated
    // old Turn-1 briefing.  Questions and operational requests still fall
    // through to the deterministic cards / conversational engineer.
    if (!/[?？]/.test(text) && /(?:無事.{0,6}完走|完走.{0,6}目指|インシデント.{0,6}ゼロ|bring it home|finish clean)/i.test(text)) {
      return answer('race_goal_ack', isJP(lang) ? '了解。完走を優先しよう。' : 'Copy. Let us prioritise bringing it home.');
    }
    if (!/[?？]/.test(text) && /(?:全く|ひどい|荒れて|めちゃくちゃ|ばっか|祭り|危なすぎ|what a mess|this is chaos)/i.test(text)) {
      return answer('race_comment_ack', isJP(lang) ? '了解。落ち着いていこう。' : 'Copy. Stay calm and keep it clean.');
    }
    return { handled:false };
  }

  // ★2026-09-13 Codex差戻し（P1-B）：pending_proposal は「直前に提案したことへの
  //   応答だけを合意にする」契約のはずだったが、実装は「まだ期限内で失効していない
  //   提案があるか」しか見ていなかった。提案の直後に無関係な話（「データ入ってる？」
  //   等）を挟んでから「了解」が来ても、古い提案をそのまま合意させてしまう
  //   （何を承認したか不明な裸の相槌で作戦を確定させない、という要求に反する）。
  //   route() 全体を1回だけ包み、**提案を承認／却下する応答以外の何かを
  //   routeInner が処理したら、その時点で pending_proposal を無効化する**。
  //   個々の意図分岐（十数箇所ある return の全て）へ失効処理を書いて回らずに
  //   1箇所へ集約する。handled:false（LLMへ渡る＝別の話）でも同様に無効化する。
  //
  // ★2026-09-13 Codex第3回差戻し：上の無効化が広すぎた。12周合意→14周新提案の
  //   直後に「何周目にピット？」（pit_plan_question）を挟むと、これは提案**その
  //   ものについての確認**なのに「別の話題」として提案を消してしまい、続く
  //   「はい」が合意にならなくなった。「固定質問ごとに例外を足す」のではなく、
  //   pit/戦略の**同じ意図ドメイン**の質問（何周目か・訂正・取消・この周申告・
  //   燃料・フォーマット）は無効化の対象から外す。answerPitDecision 側も
  //   pendingProposalMention() で確定Planと保留提案を区別して両方伝えるため、
  //   曖昧な質問文のまま片方だけを答えて終わらせない。
  const STRATEGY_TOPIC_INTENTS = new Set([
    'pit_plan_question', 'pit_plan_amend', 'pit_plan_cancel', 'pit_this_lap',
    'fuel_status', 'fuel_window_watch', 'fuel_window_cancel', 'fuel_window_status', 'penalty_consultation', 'race_format',
    'strategy_recommendation', 'strategy_normal', 'strategy_undercut', 'strategy_overcut',
    'strategy_consultation_held', 'strategy_consultation_unavailable',
  ]);
  // ★2026-09-13 Codex第6回差戻し対応中に発見：意味判定待ち(awaiting_judgment)の
  //   間に来た裸の「了解」は resolvePendingProposal のゲートで弾かれ、
  //   intent='acknowledgement' の中身の無い相槌へ落ちる。これは「別の話題を処理した」
  //   のではなく「まだ何も判定されていない」だけなので、無効化の対象にしない。
  //   中身を持たない相槌は、それ単体では話題判定の根拠にならない。
  const NEUTRAL_NON_TOPIC_INTENTS = new Set(['acknowledgement']);
  // ★2026-09-13 Codex第4回差戻し→第5回差戻しで撤回：handled:false（ローカルで
  //   意味が決まらずLLMへ渡る）発話について、いったん「提案・戦略ドメインの語彙
  //   （ピット/プラン/その案 等）を含むかどうか」で即時無効化を見送る緩和を入れたが、
  //   Codexが実routerで両方向の反例を示した——「どうして？」（語彙を含まないが
  //   同じ相談の継続）を誤って無効化し、「その案という英語を教えて」（語彙を含むが
  //   実際は無関係な語学質問）を誤って温存して次の裸の「はい」が誤確定しうる状態を
  //   作った。「90秒TTLは古さの上限であり、意味の同一性の根拠にならない」という
  //   指摘のとおりで、語彙の有無というヒューリスティックそのものを撤回する。
  //
  //   代わりに、意味理解を要する分類は`applyProposalClassification()`という
  //   接続層（このファイルの外、session-strategy-state.js）を用意した——実際の
  //   分類（confirm/decline/same_topic/unrelated）は将来、実LLM呼出等の外部処理が
  //   行う設計で、まだ本番経路には接続していない。それが接続されるまでの間、
  //   handled:false は**フェイルクローズ**（即時無効化）をデフォルトに戻す。
  //   「同じ相談の継続を誤って切る」より「無関係な相槌でpitを誤確定させる」方が
  //   レース戦略ツールとして被害が大きいため、未接続の間は安全側に倒す。
  //
  // ★2026-09-13 Codex第6回差戻し：上の「フェイルクローズへ戻した」判断自体は
  //   間違っていないが、「立ち止まって良い理由」にしてはいけないという指摘を受けた。
  //   handled:false（LLMで意味を判定する）の場合だけ、無効化ではなく
  //   `markAwaitingJudgment()`（意味判定待ち）へ変える。この間 pending_proposal は
  //   消えないが、`resolvePendingProposal`側のゲートにより裸の相槌
  //   （「了解」「はい」）では確定しない——確定させるのは
  //   `renderer.html`のcallAPI()がLLM応答から抽出し`applyProposalClassification()`へ
  //   渡す実際の判定結果だけ。判定が届かなければ従来どおり90秒TTLで自然に失効する。
  //   handled:true で許可リスト外の意図（天気・ベストラップ等、ローカルで確定的に
  //   別トピックと分かる場合）は引き続き即時無効化する——ここは変えない。
  function routeLegacy(input) {
    const strategy = input && input.strategy && typeof input.strategy === 'object' ? input.strategy : null;
    const strategyState = strategy && strategy.state ? strategy.state : null;
    const strategyModule = (strategy && strategy.api)
      || (typeof globalThis !== 'undefined' ? globalThis.PitwallSessionStrategyState : null)
      || null;
    const canTrack = !!(strategyModule && strategyState && stratCan(strategyModule, 'pendingProposal')
      && stratCan(strategyModule, 'invalidatePendingProposal'));
    const hadPending = canTrack && !!strategyModule.pendingProposal(strategyState, { at: Date.now() });
    const result = routeInner(input);
    const sameTopic = !!(result && (STRATEGY_TOPIC_INTENTS.has(result.intent)
      || NEUTRAL_NON_TOPIC_INTENTS.has(result.intent)));
    if (hadPending && !sameTopic && result
        && result.intent !== 'plan_confirmed' && result.intent !== 'plan_declined') {
      const stillPending = strategyModule.pendingProposal(strategyState, { at: Date.now() });
      if (stillPending) {
        if (result.handled === false && stratCan(strategyModule, 'markAwaitingJudgment')) {
          strategyModule.markAwaitingJudgment(strategyState,
            { decision_id: stillPending.decision_id, at: Date.now() });
        } else {
          strategyModule.invalidatePendingProposal(strategyState,
            { at: Date.now(), reason: 'other_exchange' });
        }
      }
    }
    return result;
  }

  // normalizeLapWords を公開するのは検査のため。route() 経由だけでは
  // 「来週」を壊しても intent が変わらず**変異が検出できなかった**（2026-09-06）。
  function route(input){
    const out=routeLegacy(input);
    if(input?.strategy?.state?.readonly_projection&&out?.handled&&/(?:pit|plan|fuel|strategy)/.test(String(out.intent||''))){
      out.strategyBinding=out.strategyBinding||input.strategy.binding||null;
      out.canonicalSource=input.strategy.state.publication_ref||null;
    }
    return out;
  }

  return { route, formatDuration, formatLapTime, fuelWindowStatus, normalizeLapWords,
    driverPlanCommand, classifyDriverIntent };
}));
