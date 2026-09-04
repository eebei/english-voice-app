'use strict';

// Build 255 substrate: race-operation numbers come from deterministic handlers.
// The LLM remains for ordinary conversation, never for these intents.

const TOPIC = Object.freeze({
  CURRENT_FUEL: 'current_fuel',
  FUEL_EMERGENCY: 'fuel_emergency',
  FUEL_PLAN: 'fuel_plan',
  FUEL_USE: 'fuel_use',
  RACE_DISTANCE: 'race_distance',
  REJOIN: 'rejoin',
  PIT_LOSS: 'pit_loss',
  PIT_DECISION: 'pit_decision',
  STRATEGY_SWITCH: 'strategy_switch',
  PIT_SERVICE: 'pit_service',
  PACE: 'pace',
  POSITION_GAP: 'position_gap',
  CURRENT_POSITION: 'current_position',
  LEADER_GAP: 'leader_gap',
  TYRE_STATUS: 'tyre_status',
  DAMAGE_STATUS: 'damage_status',
  WEATHER_STATUS: 'weather_status',
  HISTORICAL_WEATHER: 'historical_weather',
  HANDLING_SETUP_ADVICE: 'handling_setup_advice',
  HANDLING_REPORT: 'handling_report',
  PENALTY_REPORT: 'penalty_report',
  TRAFFIC_STATUS: 'traffic_status',
  PLAN_STATUS: 'plan_status',
  PIT_LAP_QUERY: 'pit_lap_query',
  SESSION_FORMAT: 'session_format',
  ACKNOWLEDGEMENT: 'acknowledgement',
  UNRESOLVED_OPERATIONAL: 'unresolved_operational',
});

const OPERATIONAL_RE = /燃料|給油|リットル|リッター|ピット|ボックス|順位|何番手|ギャップ|差|ペース|タイヤ|摩耗|ダメージ|修理|天候|気温|路面|雨|残り(?:周|時間)|レース時間|戦略|プラン|アンダー\s*カット|オーバー\s*カット|トラフィック|前の車|後ろの車|ペナルティ|ドライブスルー|fuel|pit|box|position|gap|pace|tyre|tire|damage|repair|weather|rain|laps? left|race time|strategy|plan|traffic|undercut|overcut|penalt|drive.?through/i;

function unresolvedSubject(text) {
  const t = String(text || '');
  if (/ギャップ|前|後ろ|後方|gap|ahead|behind/i.test(t)) return 'gap';
  if (/ピット|ボックス|pit|box/i.test(t)) return 'pit';
  if (/燃料|給油|リットル|リッター|fuel|lit(?:er|re)/i.test(t)) return 'fuel';
  if (/ペナルティ|ドライブスルー|penalt|drive.?through/i.test(t)) return 'penalty';
  return 'operation';
}

function handlingSymptomName(text) {
  const t = String(text || '');
  // 「リアの踏ん張りが欲しい」は、ドライバーが求めるセットアップの方向を
  // 既に指定している相談。オーバーステアの発生報告とは分け、聞き返さずに
  // 最初の一手を返す。
  if (/リア.{0,12}(?:踏ん張り|グリップ).{0,8}(?:欲しい|ほしい|足りない|不足)|(?:rear).{0,12}(?:grip|traction).{0,12}(?:need|want|lack)/i.test(t)) return 'rear_grip';
  if (/オーバー(?:ステア)?|oversteer|loose|リア.{0,4}(?:出る|流れる)/i.test(t)) return 'oversteer';
  if (/アンダー(?:ステア)?|understeer|push|曲がらない|フロント.{0,6}(?:食わない|入らない)/i.test(t)) return 'understeer';
  if (/タイヤ.{0,6}(?:持たない|もたない|垂れ|タレ)|グリップ.{0,6}(?:ない|落ち|不足)/i.test(t)) return 'tyre_degradation';
  return 'unspecified';
}

function classify(text, options = {}) {
  const raw = String(text || '').trim();
  // Japanese STT frequently turns ピット into ビット.  Normalize only when
  // the following word proves a race-operation context; ordinary "bit" talk
  // remains untouched.
  const t = raw
    .replace(/ビット(?=\s*(?:イン|タイミング|戦略|作戦|レーン|ロード|ウインドウ|給油))/g, 'ピット')
    .replace(/次のしゅ(?=\s*(?:ピット|ボックス))/g, '次の周');
  if (!t) return null;

  if (/ピット(?:レーン)?(?:ロス|タイム|時間)|IN.{0,8}OUT|制限ライン.{0,8}(?:秒|時間)|直近.{0,8}ピット.{0,8}(?:秒|時間)|pit loss|pit lane time|in.{0,8}out/i.test(t)) return { topic: TOPIC.PIT_LOSS, confidence: 0.99 };
  if (/ピット(?:作業|サービス)|給油量.*(?:さっき|直近)|停止時間|service time|pit service|fuel added/i.test(t)) return { topic: TOPIC.PIT_SERVICE, confidence: 0.98 };

  const shortageClarification = t.match(/(\d+(?:\.\d+)?)\s*(?:リットル|リッター|[lL])\s*(?:足りない|たりない|不足)(?:ってこと|ということ)?/i);
  if (shortageClarification) return {
    topic: TOPIC.FUEL_PLAN,
    confidence: 0.995,
    shortageClarificationL: Number(shortageClarification[1]),
  };

  const fuelWord = /燃料|燃費|消費|ガソリン|リットル|リッター|fuel|consumption|lit(?:er|re)/i.test(t);
  // A splash question is not a generic checker-distance question.  It asks
  // whether the planned stop leaves another fuel stop before the finish.
  if (/スプラッシュ|splash/i.test(t)) return {
    topic: TOPIC.FUEL_PLAN,
    splashQuestion: true,
    confidence: 0.995,
  };
  // Fuel starvation is a safety-critical immediate condition.  It must not
  // fall into the generic "wait for the next S/F" follow-up path.
  if (/(?:ガス欠|燃料.{0,10}(?:ゼロ|0(?:\.0+)?\s*(?:[lL]|リットル|リッター)?|持たない)|ピット.{0,10}持たない|out of fuel|won'?t make it to (?:the )?pit)/i.test(t)) return { topic: TOPIC.FUEL_EMERGENCY, confidence: 0.995 };
  if (fuelWord && /燃費|消費|一周|1周|周あたり|平均|per lap|consumption|burn/i.test(t)) return { topic: TOPIC.FUEL_USE, confidence: 0.99 };
  const fuelPlan = /給油|足り|必要|不足|余裕|完走|最後|ゴール|チェッカー|入れ|セット|何周.*(?:持|走)|make it|to (?:the )?finish|add fuel|fuel plan/i.test(t);
  if (fuelWord && fuelPlan) return { topic: TOPIC.FUEL_PLAN, confidence: 0.99 };
  // Real 8/15 STT: 「ゴールまでの数量が増えちゃってるぞ」.  The driver is
  // challenging the to-finish fuel figure, but STT omitted the word 燃料.
  // Keep this narrow to a changing finish/required quantity so ordinary
  // comments about an unrelated quantity do not enter the fuel authority.
  if (/(?:ゴールまで|完走まで).{0,12}(?:数量|必要量|量).{0,10}(?:増|減|変)|(?:必要量|数量).{0,10}(?:増|減|変)/i.test(t)) {
    return { topic: TOPIC.FUEL_PLAN, confidence: 0.99 };
  }
  if (fuelWord && /搭載|残量|現在|いま|今|スタート|積ん|どれだけ|何(?:リットル|リッター|L)|0(?:\.?0*)?(?:\s*[lL])?|ゼロ|on board|remaining|right now|how much/i.test(t)) return { topic: TOPIC.CURRENT_FUEL, confidence: 0.99 };
  if (/給油|何(?:リットル|リッター|L).*(?:入れ|セット)|(?:入れ|セット).*何(?:リットル|リッター|L)/i.test(t)) return { topic: TOPIC.FUEL_PLAN, confidence: 0.97 };
  if (/\d+(?:\.\d+)?\s*[lL].*(?:大丈夫|足り|必要)|(?:大丈夫|足り|必要).*\d+(?:\.\d+)?\s*[lL]/.test(t)) return { topic: TOPIC.FUEL_PLAN, confidence: 0.96 };
  if (/今.{0,8}\d+(?:\.\d+)?\s*[lL]/.test(t)) return { topic: TOPIC.CURRENT_FUEL, confidence: 0.94 };

  if (/(?:レース.{0,10})?(?:フォーマット|フォーマー|形式)|レース.{0,10}(?:距離|時間)|何分\s*(?:制|製)(?:の)?(?:レース)?|予選(?:あり|なし)|このセッション.{0,8}(?:何|なん|どれ)|セッション.{0,8}(?:何|なん|どれ|練習|予選|決勝)|練習.{0,8}予選.{0,8}(?:決勝|レース)|session format|race format|qualifying/i.test(t)) return { topic: TOPIC.SESSION_FORMAT, confidence: 0.99 };
  if (/(?:ドライブ\s*(?:スルー|する)|ドライブスルー|drive.?through).{0,12}(?:ペナルティ|だった|受けた|来た|penalt)|(?:ペナルティ|penalt).{0,12}(?:ドライブ\s*(?:スルー|する)|ドライブスルー|drive.?through)/i.test(t)) {
    return { topic: TOPIC.PENALTY_REPORT, confidence: 0.99 };
  }
  if (/残り.{0,8}(?:何[周週]|周回|時間)|あと.{0,8}(?:何[周週]|何分)|レース.{0,8}(?:何[周週]|何分|時間)|チェッカー|ホワイトフラッグ|race distance|laps? left|time remaining|white flag/i.test(t)) return { topic: TOPIC.RACE_DISTANCE, confidence: 0.98 };
  if (/(?:アンダー\s*カット|オーバー\s*カット).*(?:どう思う|どうする|あり|狙|判断|いけ)|(?:どう思う|どうする|判断).*(?:アンダー\s*カット|オーバー\s*カット)/i.test(t)) return {
    topic: TOPIC.STRATEGY_SWITCH,
    requestedPlan: /オーバー\s*カット|overcut/i.test(t) ? 'C' : 'B',
    confidence: 0.99,
  };
  // ★2026-08-30 P0-2：トラフィック／ブレンドの相談を pit 判断に化けさせない。
  //   8/30 RB Ring 実走で「俺、この週に入ったら後方の方の車とブレンドしちゃうか？」
  //   （STT が「この周」を「この週」と書いた）が pit_decision(0.97) になり、
  //   「ピットを推奨。燃料不足が根拠。給油設定は22L。」と返した。犯人は下の
  //   `この(?:ラップ|周|週|州).*(?:入|ピット|判断)` の**無制限 `.*`** で、文末の
  //   「**入**ったら」まで届いていた（他の選択肢は全て `.{0,8}` で縛っている）。
  //   距離を縛るだけでは「この週に入」が近すぎて残るため、ブレンド／集団／
  //   トラフィック語が混ざる文は pit 判断から明示的に外し、下の rejoin /
  //   traffic ハンドラーへ送る。
  // ★2026-08-31：ドライバーの「決定」と「質問」を分ける。
  //   8/31 RBR実走で「いや、もうこの周で入るよ」「ボックス。」に対し
  //   `今はステイアウト。ピットウィンドウまで走れる。`を2回返した。
  //   前の集団の動きが見えているのはドライバーであり、決定は覆さない。
  //   疑問符・疑問語があれば質問、無くて決定の言い回しなら命令として扱う。
  // ★2026-09-01 Gate 4 差戻し（Codex P1）：否定リスト方式は、STTが句読点を落とした
  //   相談（`もう入るか` / `are we pitting` / `are they coming in`）を命令へ通していた。
  //   ボックスは取り消せない指示なので、**命令形だけを許可する positive contract** にする。
  //   疑問の形が一つでも見えたら相談として扱い、timing authority の判断を返す。
  const PIT_INTERROGATIVE = [
    /[？?]/,                                   // 明示の疑問符
    /いつ|何周|どう|べき|かな|ますか|でしょうか|判断してくれ/,  // 日本語の疑問語
    /(?:か|かい|の)\s*[。.!！]?\s*$/,           // 文末の疑問助詞（`もう入るか`）
    /^\s*(?:are|is|am|do|does|did|can|could|will|would|shall|should|have|has)\b/i, // 英語の疑問語順
    /\b(?:or|should|when|how many|what lap)\b/i,
  ];
  // 命令・意思表明として認める形だけを列挙する。ここに無い言い回しは相談側へ落ちる。
  const PIT_COMMAND = [
    /^(?:ボックス|box\s*box|box)[。.!！\s]*$/i,     // 単独のコール
    /ボックス(?:する|入る|入れ|だ|で)/,
    /(?:この|次の|今)(?:の)?(?:周|ラップ|週|州|lap)[でに]?.{0,4}(?:入る|入るよ|入るわ|入ります|ピット|ボックス)/,
    /(?:もう)?.{0,4}(?:入るよ|入るわ|入ります)/,     // 意思表明の語尾
    /もう.{0,4}入る(?![かのねぇ])/,                 // `もう入る` は可、`もう入るか` は不可
    /ピットイン(?:する|だ|して)|ピットする/,
    /\b(?:box this lap|boxing|coming in|pitting|pit now)\b/i,
    /\bstay ?out(?:\s*now)?[。.!！]*$/i,
    /ステイアウト(?:で|だ|する)/,
  ];
  const isDriverPitCommand = (txt) => {
    const q = String(txt || '').trim();
    if (PIT_INTERROGATIVE.some((re) => re.test(q))) return false;
    return PIT_COMMAND.some((re) => re.test(q));
  };
  const blendOrTrafficTalk = /ブレンド|集団|車群|トラフィック|クリアエア|blend|pack\b|traffic|clear ?air/i.test(t);
  if (!blendOrTrafficTalk
      && /^(?:ボックス|box)[。.!！?？]*$|次のピット.{0,6}(?:タイミング|いつ|何周)|(?:次|この)(?:の)?(?:周|ラップ).{0,8}(?:ピット|ボックス)|ピット.{0,8}(?:入ろう|入るかな|タイミング|いつ)|ボックス\s*(?:する|入る|入れ)|ピット\s*(?:する|入る|入れ|判断)|ピットに(?:入れ|行け|向か)|今\s*ピットに[。.!！?？]*$|入れなかった|入れなかっ|入れない|入るべき|ステイアウト|もう(?:1|一)周|この(?:ラップ|周|週|州).{0,10}(?:入|ピット|判断)|(?:この|ディス|this)(?:ラップ|周|週|州|lap).{0,8}(?:ボックス|box)|判断してくれ|box or|pit or|stay out|should .*pit|もう.{0,4}入る|ピットイン(?:して|する|だ)|box this lap|boxing|pitting|coming in|pit now/i.test(t)) return { topic: TOPIC.PIT_DECISION, confidence: 0.97, driverCommand: isDriverPitCommand(t) };
  if (/アンダー\s*カット|オーバー\s*カット|復帰|戻れ|戻る|ブレンド|サイクル後|暫定.{0,12}(?:何位|何番手|順位|ポジション)|予測.{0,12}(?:何位|何番手|順位|ポジション)|(?:何位|何番手|順位|ポジション).{0,12}予測|ピット.*(?:何位|何番手|どこ)|(?:何位|何番手).*(?:ピット|戻|復帰)|undercut|overcut|rejoin|blend|cycle position/i.test(t)) return { topic: TOPIC.REJOIN, confidence: 0.99 };
  if (/戦略.{0,8}(?:は|どう|確認|ある|何|教)|作戦.{0,8}(?:は|どう|確認|ある|何|教)|プラン.{0,8}(?:は|どう|確認|ある|何|教)|プラン\s*[ABCＡＢＣ]|次の判断|strategy status|what(?:'s| is) the plan|plan status|plan\s*[abc]/i.test(t)) {
    const choice=/プラン\s*[AＡ]|plan\s*a/i.test(t)?'A':/プラン\s*[BＢ]|plan\s*b/i.test(t)?'B':/プラン\s*[CＣ]|plan\s*c/i.test(t)?'C':null;
    return { topic: TOPIC.PLAN_STATUS, planChoice: choice, confidence: 0.96 };
  }
  if (/トラフィック|集団|クリアエア|前方.*(?:集団|車群)|traffic|pack|clear air/i.test(t)) return { topic: TOPIC.TRAFFIC_STATUS, confidence: 0.96 };
  if (/ペース|タイム.*上げ|上げて|プッシュ|攻め|飛ば|push|pace|speed up/i.test(t)) return { topic: TOPIC.PACE, confidence: 0.97 };

  if (/クラストップ|クラスリーダー|トップまで|首位まで|リーダーまで|overall leader|class leader|gap to (?:the )?leader/i.test(t)) return { topic: TOPIC.LEADER_GAP, confidence: 0.99 };
  if (/(?:P|p)\s*\d+.*(?:何秒|差|ギャップ)|(?:何秒|差|ギャップ).*(?:P|p)\s*\d+|前.*(?:何秒|\d+(?:\.\d+)?秒|差|ギャップ)|gap/i.test(t)) {
    const m = t.match(/(?:P|p)\s*(\d+)/);
    return { topic: TOPIC.POSITION_GAP, targetPosition: m ? Number(m[1]) : null, confidence: 0.97 };
  }
  const positionReport = t.match(/^(?:Luna[、,\s]*)?(?:現在|今)?\s*(?:ポジション)?\s*(?:P\s*)?(\d{1,3})\s*(?:位|番手)(?:だ|です|ね|になった|まで上がった|まで下がった)?[。.!！?？]*$/i);
  if (positionReport) return {
    topic: TOPIC.ACKNOWLEDGEMENT,
    reportedPosition: Number(positionReport[1]),
    confidence: 0.99,
  };
  if (/今.*(?:何位|何番手)|現在.*(?:順位|ポジション)|順位は|current position|what position/i.test(t)) return { topic: TOPIC.CURRENT_POSITION, confidence: 0.98 };
  // ★八木さん実走ログ 7-1（2026-08-11）：高路温でタイヤが持たない、という
  //   セットアップ相談が `weather_status` に吸い込まれ、気温と路面温度だけを
  //   読み上げて終わっていた。相談は温度の質問ではない。
  //   セットアップ語 or ハンドリング症状があれば weather より先に取る。
  // セットアップという語そのものは、温度の質問ではありえない。単独で weather に勝つ。
  const setupNoun = /セッ?ト\s*ア(?:ッ|ツ)?プ|セッティング|set-?up/i.test(t);
  // 「方向」「変えたい」「意見」等は単独では弱いので、症状と組み合わせて判定する。
  const setupIntent = /方向性|方向|変えたい|変更したい|振り|アドバイス|意見|どうすれば|balance/i.test(t);
  const handlingSymptom = /アンダー(?:ステア)?|オーバー(?:ステア)?|タイヤ.{0,6}(?:持たない|もたない|垂れ|タレ|厳しい|きつい)|グリップ.{0,6}(?:ない|落ち|不足)|曲がらない|滑る|フロント.{0,6}(?:食わない|入らない)|リア.{0,12}(?:出る|流れる|踏ん張り|グリップ).{0,8}(?:欲しい|ほしい|ない|不足)?|understeer|oversteer|grip|traction|slide|loose|push/i.test(t);
  if (setupNoun || (setupIntent && handlingSymptom)
      || (handlingSymptom && /どう|なに|何|対策|解決|直|なおし|改善|what should|how do i|any (?:advice|ideas?|suggestions?)|fix|help/i.test(t))) {
    return { topic: TOPIC.HANDLING_SETUP_ADVICE,
             confidence: setupNoun ? 0.99 : 0.97,
             symptom: handlingSymptomName(t) };
  }
  if (handlingSymptom && !/[?？]|どう|なに|何|対策|改善|help|advice/i.test(t)) {
    return { topic: TOPIC.HANDLING_REPORT, confidence: 0.95,
             symptom: handlingSymptomName(t) };
  }
  // Weather must win before the generic tyre vocabulary.  Previously
  // "路面温度" matched the bare "温度" tyre rule and returned tyre wear.
  if (/昨日|前回|前の(?:レース|走行|セッション)|yesterday|last (?:race|run|session)/i.test(t)
      && /天気|天候|気温|路面(?:温度|状況)|路温|トラック温度|雨|濡れ|湿度|weather|track temp|air temp|rain|wet/i.test(t)) {
    return { topic: TOPIC.HISTORICAL_WEATHER, confidence: 0.99 };
  }
  if (/天気|天候|気温|路面(?:温度|状況)|路温|トラック温度|雨|濡れ|湿度|weather|track temp|air temp|rain|wet/i.test(t)) return { topic: TOPIC.WEATHER_STATUS, confidence: 0.99 };
  if (/タイヤ|摩耗|左前|右前|左後|右後|tyre|tire|wear/i.test(t)) {
    const tyreQuery = /(?:タイヤ|tyre|tire).{0,8}(?:温度|temp)|(?:温度|temp).{0,8}(?:タイヤ|tyre|tire)/i.test(t)
      ? 'temperature'
      : /摩耗|残量|残り|wear/i.test(t) ? 'wear' : 'status';
    return { topic: TOPIC.TYRE_STATUS, tyreQuery, confidence: 0.98 };
  }
  if (/ダメージ|損傷|修理|壊れ|damage|repair/i.test(t)) return { topic: TOPIC.DAMAGE_STATUS, confidence: 0.98 };

  // ★八木さん実走ログ 7-2（2026-08-11）：アンダーステア相談の直後に
  //   「どうしたらいいですか？」と聞かれ、対象を見失った。
  //   相談は Practice でも起きる。race ゲートの外で、直前の相談対象を引き継ぐ。
  //   短くて対象語を含まない問いだけを引き継ぎ対象にする（長い新規質問は奪わない）。
  const vagueFollowUp = t.length <= 24 && (
       /^(?:じゃあ|それで|で|でも)?\s*どう(?:したら|すれば|する|なの)[^。.!！?？]{0,10}[?？。.!！]*\s*$/i.test(t)
    || /^(?:他|ほか)に\s*(?:何|なに)か?\s*(?:ある|ありますか|ない)?[?？。.!！]*\s*$/i.test(t)
    || /^(?:何|なに)か\s*(?:対策|解決|方法|案)\s*(?:は|ある|ありますか)?[?？。.!！]*\s*$/i.test(t)
    || /^\s*(?:what should i do|any(?:thing)? else|how do i fix (?:it|that))[?.!]*\s*$/i.test(t));
  if (vagueFollowUp && options.recentText) {
    const priorSetup = classify(String(options.recentText), {});
    if (priorSetup && priorSetup.topic === TOPIC.HANDLING_SETUP_ADVICE) {
      return { ...priorSetup, confidence: Math.min(priorSetup.confidence || 0.9, 0.9),
               inherited: true };
    }
  }

  if (options.race === true && /^\s*\d+(?:\.\d+)?\s*[lL](?:級|ぐらい|くらい|だ|です)?[。.!！?？]?\s*$/.test(t)) return { topic: TOPIC.FUEL_PLAN, confidence: 0.85 };
  if (options.race === true && /計算|判断|どうする|大丈夫|予測|これ|それ|もう/.test(t)) {
    const prior = classify(String(options.recentText || ''), { race: false });
    if (prior && ![TOPIC.CURRENT_POSITION, TOPIC.UNRESOLVED_OPERATIONAL].includes(prior.topic)) return {
      ...prior,
      confidence: Math.min(prior.confidence || 0.9, 0.9),
      inherited: true,
      actionRequested: /どうする|どっち|ゆっくり|セーブ|飛ば|ペース/i.test(t),
    };
  }
  // A driver calling "final lap" is a status acknowledgement, not a request
  // for a fresh strategy calculation.  Do not answer it through the generic
  // no-data/Truth Gate path while they are finishing the race.
  if (/^(?:ファイナル(?:ラップ)?|最終(?:周|ラップ)|final lap)[。.!！?？]*$/i.test(t)) {
    return { topic: TOPIC.ACKNOWLEDGEMENT, confidence: 1, finalLap: true };
  }
  if (/^(?:はい[、,\s]*)?(?:ピットイン|ボックスへ入る|ピットへ入る)[。.!！?？]*$/i.test(t)) {
    return { topic: TOPIC.ACKNOWLEDGEMENT, confidence: 1, pitEntryReport: true };
  }
  if (options.race === true && OPERATIONAL_RE.test(t)) return {
    topic: TOPIC.UNRESOLVED_OPERATIONAL, confidence: 0,
    subject: unresolvedSubject(t),
  };
  if (/^(?:了解|了解です|分かった|わかった|なるほど|OK|オーケー|ありがとう|ナイス)[。.!！?？]*$/i.test(t)) {
    return { topic: TOPIC.ACKNOWLEDGEMENT, confidence: 1 };
  }
  return null;
}

// Collect secondary meanings without changing the long-standing first-match
// classifier.  A single match therefore follows the exact legacy route; only
// utterances that currently lose a second explicit question are composed.
function classifyAll(text, options = {}) {
  const primary = classify(text, options);
  if (!primary) return [];
  const out = [primary];
  const t = String(text || '').trim();
  const asksPitLap = /(?:何|どの|いつの?)\s*(?:周|週|ラップ)\s*目|(?:何|どの)\s*(?:周|週|ラップ).{0,8}(?:ピット|ボックス|入)|(?:ピット|ボックス).{0,8}(?:何|どの|いつの?)\s*(?:周|週|ラップ)|what\s+lap.{0,10}(?:pit|box)|(?:pit|box).{0,10}what\s+lap/i.test(t);
  if (asksPitLap && primary.topic !== TOPIC.PIT_LAP_QUERY) {
    const choice = /プラン\s*[AＡ]|plan\s*a/i.test(t) ? 'A'
      : /プラン\s*[BＢ]|plan\s*b/i.test(t) ? 'B'
      : /プラン\s*[CＣ]|plan\s*c/i.test(t) ? 'C' : null;
    out.push({ topic: TOPIC.PIT_LAP_QUERY, planChoice: choice, confidence: 0.99 });
  }
  return out;
}

const finite = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};
const position = value => {
  const n = finite(value);
  return n != null && n >= 1 ? Math.trunc(n) : null;
};
const ja = lang => lang === 'ja';

function formatDuration(seconds, lang = 'en') {
  const value = finite(seconds);
  if (value == null) return null;
  const total = Math.max(0, Math.round(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60), rest = total % 60;
  if (ja(lang) && hours > 0) return `${hours}時間${minutes}分`;
  if (ja(lang)) return minutes > 0 ? `${minutes}分${rest}秒` : `${rest}秒`;
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'} ${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (minutes > 0) return `${minutes} minute${minutes === 1 ? '' : 's'} ${rest} second${rest === 1 ? '' : 's'}`;
  return `${rest} second${rest === 1 ? '' : 's'}`;
}

function pitPhase(live) {
  const lifecycle = String(live && live.lifecycle_state || '').toUpperCase();
  if (['PLAYER_FINISHED', 'DEBRIEF'].includes(lifecycle)) return 'finished';
  const explicit = String(live && live.pit_phase_state || '').toLowerCase();
  if (['in_lap', 'pit_lane', 'out_lap', 'racing', 'finished'].includes(explicit)) return explicit;
  if (live && live.on_pit_road === true) return 'pit_lane';
  return 'racing';
}

function fuelPlan(live) {
  const fs = live && typeof live.fuel_strategy === 'object' ? live.fuel_strategy : {};
  const current = finite(live && live.fuel);
  let required = finite(fs.required_fuel_l);
  const evaluated = finite(fs.evaluated_fuel_l);
  // required_fuel_l and add_fuel_l are one S/F snapshot.  Between crossings,
  // the car burns the same amount from both the tank and the remaining race
  // requirement.  Bring the displayed requirement forward to the live tank
  // instead of mixing a live current value with a stale full-lap total.
  if (required != null && evaluated != null && current != null
      && current <= evaluated + 0.2) {
    required = Math.max(0, required - Math.max(0, evaluated - current));
  }
  const authoritativeAdd = finite(fs.evaluated_fuel_l) != null || fs.awaiting_post_pit_s_f === true
    ? finite(fs.add_fuel_l) : null;
  const add = authoritativeAdd != null ? authoritativeAdd
    : current != null && required != null ? Math.max(0, required - current) : null;
  const set = finite(fs.set_fuel_l) != null ? Math.trunc(finite(fs.set_fuel_l))
    : add != null ? Math.ceil(add) : null;
  return { fs, current, required, add, set };
}

function hasAuthoritativeFinishTarget(live) {
  const fs = live && typeof live.fuel_strategy === 'object' ? live.fuel_strategy : {};
  const sessionType = String(live && (live.session_type || live.sessionType) || '').toLowerCase();
  const manualTarget = fs.authoritative_target_kind === 'driver_stint'
    && Number.isInteger(finite(fs.authoritative_target_laps));
  const raceTarget = /race/.test(sessionType)
    && (Number.isInteger(finite(fs.estimated_crossings_to_finish))
      || Number.isInteger(finite(fs.provisional_laps_to_time_expiry)));
  return manualTarget || raceTarget;
}

function buildCurrentFuel(live, lang) {
  const current = finite(live && live.fuel);
  if (current == null) return ja(lang) ? '現在燃料は取得できない。' : 'Current fuel is unavailable.';
  return ja(lang) ? `現在${current.toFixed(1)}L。` : `Current fuel ${current.toFixed(1)}L.`;
}

function buildFuelEmergency(live, lang) {
  const current = finite(live && live.fuel);
  if (current == null) return ja(lang)
    ? '燃料危機は受信したが、現在燃料を確認できない。ピット到達可否は断定しない。'
    : 'Fuel emergency received, but current fuel is unavailable. I will not claim whether the pit is reachable.';
  if (current <= 0.5) return ja(lang)
    ? `燃料${current.toFixed(1)}L。ガス欠域で、ピット到達は保証できない。次のS/F待ちはしない。安全を優先して。`
    : `Fuel ${current.toFixed(1)}L. This is a fuel-starvation range; pit arrival is not guaranteed. I will not wait for the next S/F. Prioritise safety.`;
  // ★Build 266 Codex 差戻し⑨：無線側(fuel_strategy_warning/fuel_strategy_safe)が既に
  //   確定した fuel_band を会話側も同じ権威として読む。band=safe なのに"保証できない"と
  //   矛盾した答えを返さない。
  const fs = (live && live.fuel_strategy) || {};
  if (fs.fuel_band === 'safe') return ja(lang)
    ? `燃料${current.toFixed(1)}L。直近の判定は安全域。ガス欠の兆候はない。`
    : `Fuel ${current.toFixed(1)}L. The latest evaluation is in the safe band; no starvation signs.`;
  return ja(lang)
    ? `燃料${current.toFixed(1)}L。ピット到達は保証できない。今は燃費セーブと安全を優先。`
    : `Fuel ${current.toFixed(1)}L. Pit arrival is not guaranteed. Save fuel now and prioritise safety.`;
}

function buildFuelUse(live, lang) {
  const fs = live && live.fuel_strategy || {};
  const avg = finite(fs.avg_fuel_per_lap), samples = finite(fs.clean_laps_sampled);
  // fuel_strategy is lap-boundary evidence while live.fuel is a frequent snapshot.
  // Never read a pit-entry `laps_of_fuel_left` together with post-refuel fuel.
  const current = finite(live && live.fuel);
  const range = current != null && avg != null ? current / avg : null;
  if (avg == null) return ja(lang) ? '一周あたりの燃料消費はまだ実測できていない。' : 'Measured fuel use per lap is not ready.';
  return ja(lang)
    ? `平均${avg.toFixed(2)}L/周、クリーン${samples == null ? '不明' : Math.trunc(samples)}周の実測。現在燃料で約${range == null ? '不明' : range.toFixed(1)}周。`
    : `${avg.toFixed(2)}L/lap from ${samples == null ? 'unknown' : Math.trunc(samples)} clean laps; about ${range == null ? 'unknown' : range.toFixed(1)} laps in the tank.`;
}

function buildFuelPlan(live, lang, card = {}) {
  const { fs, current, required, add, set } = fuelPlan(live || {});
  const endurance = fs.endurance_plan || live.endurance_fuel_plan || {};
  if (!hasAuthoritativeFinishTarget(live)) {
    const avg = finite(fs.avg_fuel_per_lap);
    return ja(lang)
      ? `${current != null ? `現在${current.toFixed(1)}L。` : ''}${avg != null ? `平均${avg.toFixed(2)}L/周。` : ''}完走目標が確定していないため、必要燃料・給油量・ピット周は出さない。`
      : `${current != null ? `Current ${current.toFixed(1)}L. ` : ''}${avg != null ? `Average ${avg.toFixed(2)}L/lap. ` : ''}The finish target is not authoritative, so I will not give required fuel, an add amount, or a pit-lap call.`;
  }
  if (endurance.available === true && endurance.multi_stop === true) {
    const stops = finite(endurance.future_stop_count);
    const next = finite(endurance.next_fuel_stop_in_laps);
    const splash = endurance.splash_forecast || {};
    if (card.splashQuestion) {
      if (splash.available !== true) return ja(lang)
        ? 'スプラッシュ予測は後半の燃費が成立してから出す。今は通常スティントを継続。'
        : 'I will project the splash after halfway with stable fuel data; continue the normal stint.';
      if (splash.splash_candidate !== true) return ja(lang)
        ? '現状燃費なら、終盤スプラッシュは不要の見込み。'
        : 'At the current fuel rate, no final splash is projected.';
      const finalAdd = finite(splash.projected_final_service_l);
      const save = finite(splash.avoid_splash_save_l_per_lap);
      if (splash.avoid_splash_feasible === true) return ja(lang)
        ? `終盤スプラッシュ約${finalAdd.toFixed(1)}L見込み。回避には毎周${save.toFixed(2)}Lセーブ。`
        : `Projected final splash ${finalAdd.toFixed(1)}L. Avoiding it requires ${save.toFixed(2)}L saving per lap.`;
      return ja(lang)
        ? `終盤スプラッシュ約${finalAdd.toFixed(1)}L見込み。回避セーブは大きすぎるため、現状はスプラッシュ前提。`
        : `Projected final splash ${finalAdd.toFixed(1)}L. The saving required is too large, so plan for the splash.`;
    }
    if (endurance.box_this_lap === true) return ja(lang)
      ? `この周ボックス。通常給油、残り給油はあと${Math.max(0, Math.trunc(stops) - 1)}回見込み。`
      : `Box this lap for the normal fuel stop; about ${Math.max(0, Math.trunc(stops) - 1)} further stops projected.`;
    return ja(lang)
      ? `現在${current == null ? '燃料不明' : current.toFixed(1) + 'L'}。次の給油目安はあと${Math.trunc(next)}周、残り給油は${Math.trunc(stops)}回見込み。`
      : `Current ${current == null ? 'fuel unavailable' : current.toFixed(1) + 'L'}. Next fuel stop in about ${Math.trunc(next)} laps; ${Math.trunc(stops)} stops projected.`;
  }
  // A refuel can happen between two S/F crossings. During that out-lap the
  // live tank and the fixed S/F requirement burn together, so use the
  // Bridge-owned post-stop margin until the next S/F recalculation.
  const heldPostPitMargin = finite(fs.post_pit_margin_l);
  if (fs.post_pit_margin_hold === true && heldPostPitMargin != null) {
    if (ja(lang)) return heldPostPitMargin >= 0
      ? `燃料は足りる。ピット後の完走余裕は${heldPostPitMargin.toFixed(1)}L。次のS/Fで更新する。`
      : `追加給油が必要。ピット後の見込みで${Math.abs(heldPostPitMargin).toFixed(1)}L不足。`;
    return heldPostPitMargin >= 0
      ? `Fuel is sufficient. Post-stop finish margin ${heldPostPitMargin.toFixed(1)}L; I will refresh it at the next S/F.`
      : `Additional fuel is required; post-stop projection is ${Math.abs(heldPostPitMargin).toFixed(1)}L short.`;
  }
  if (card.splashQuestion) {
    const bridgeProjection = live && live.post_stop_fuel_projection || {};
    const bridgeMargin = finite(bridgeProjection.margin_l);
    if (bridgeProjection.available === true && bridgeMargin != null) {
      if (ja(lang)) return bridgeProjection.splash_required === true
        ? `スプラッシュが必要。満タンでも約${Math.abs(bridgeMargin).toFixed(1)}L不足。`
        : `スプラッシュ不要。このピットで満タンなら、ゴール時約${bridgeMargin.toFixed(1)}L余る見込み。`;
      return bridgeProjection.splash_required === true
        ? `Splash required. A full tank still projects ${Math.abs(bridgeMargin).toFixed(1)}L short.`
        : `No splash. A full tank at this stop projects about ${bridgeMargin.toFixed(1)}L at the finish.`;
    }
    const timed = live && live.timed_finish_forecast || {};
    const calibration = live && live.pit_loss_calibration || {};
    const leaderChecker = finite(timed.leader_time_to_checkered_s);
    const driverNextSf = finite(timed.driver_time_to_next_sf_s);
    const driverLap = finite(timed.driver_avg_lap_s);
    const pitLoss = finite(calibration.observed_loss_median_s);
    const burn = finite(fs.avg_fuel_per_lap);
    const capacity = finite(fs.effective_capacity_l);
    const reserve = finite(fs.reserve_l) == null ? 0.5 : finite(fs.reserve_l);
    if (timed.confidence === 'model_valid' && leaderChecker != null
        && driverNextSf != null && driverLap != null && driverLap > 0
        && pitLoss != null && pitLoss >= 0 && burn != null && capacity != null) {
      // The next S/F is the pit-entry crossing.  Fuel added at the stop only
      // has to cover the complete crossings after service.  Pit loss moves
      // the driver later relative to the overall leader's checker clock.
      const postStopCrossings = Math.max(0, Math.floor(
        (leaderChecker - driverNextSf - pitLoss) / driverLap + 1e-9));
      const postStopRequired = postStopCrossings * burn + reserve;
      const margin = capacity - postStopRequired;
      if (ja(lang)) return margin >= 0
        ? `スプラッシュ不要。このピットで満タンなら、ゴール時約${margin.toFixed(1)}L余る見込み。`
        : `スプラッシュが必要。満タンでも約${Math.abs(margin).toFixed(1)}L不足。`;
      return margin >= 0
        ? `No splash. A full tank at this stop projects about ${margin.toFixed(1)}L at the finish.`
        : `Splash required. A full tank still projects ${Math.abs(margin).toFixed(1)}L short.`;
    }
    return ja(lang)
      ? 'スプラッシュの要否は、このピット後の周回予測がまだ成立していない。'
      : 'The post-stop lap projection is not ready, so splash need is not confirmed.';
  }
  const exact = finite(fs.estimated_crossings_to_finish), provisional = finite(fs.provisional_laps_to_time_expiry);
  const oneStopShort=finite(fs.one_stop_shortfall_l);
  const settingJP=oneStopShort!=null&&oneStopShort>0.05
    ? `設定上限${set}Lでも一度では${oneStopShort.toFixed(1)}L不足。追加のセーブか別ピットが必要。`
    : `給油設定${set}L。`;
  const settingEN=oneStopShort!=null&&oneStopShort>0.05
    ? `The ${set}L setting limit still leaves ${oneStopShort.toFixed(1)}L short in one stop; additional saving or another stop is required.`
    : `Set ${set}L.`;
  if (current != null && required != null && add != null) {
    const distance = Number.isInteger(exact)
      ? (ja(lang) ? `現在周を含めて、チェッカーまでS/Fあと${exact}回。` : `${exact} S/F crossings to the finish, including this lap. `)
      : Number.isInteger(provisional) ? (ja(lang) ? `暫定あと${provisional}周分。` : `Provisional ${provisional}-lap plan. `) : '';
    if (ja(lang)) {
      if (finite(card.shortageClarificationL) != null) return add > 0
        ? `${finite(card.shortageClarificationL).toFixed(0)}L不足という意味ではない。最新値では現在${current.toFixed(1)}L、ゴールまで${required.toFixed(1)}L必要。燃料は${add.toFixed(1)}L不足。${settingJP}`
        : `${finite(card.shortageClarificationL).toFixed(0)}L不足という意味ではない。最新値では燃料は足りる。現在${current.toFixed(1)}L、ゴールまで${required.toFixed(1)}L必要。`;
      if (add > 0) {
        const action = card.actionRequested && fs.pit_required === true
          ? 'この周でピットを推奨。'
          : '追加給油が必要。';
        return `${action}現在${current.toFixed(1)}L、ゴールまで${required.toFixed(1)}L必要。燃料は${add.toFixed(1)}L不足。${settingJP}`;
      }
      return `燃料は足りる。現在${current.toFixed(1)}L、ゴールまで${required.toFixed(1)}L必要。${distance}`;
    }
    return add > 0
      ? `Current ${current.toFixed(1)}L. ${distance}${required.toFixed(1)}L total required; ${add.toFixed(1)}L short. ${settingEN}`
      : `Current ${current.toFixed(1)}L. ${distance}${required.toFixed(1)}L total required; no fuel needed.`;
  }
  const avg = finite(fs.avg_fuel_per_lap);
  if (avg != null) return ja(lang)
    ? `現在${current != null ? current.toFixed(1) + 'L。' : ''}平均${avg.toFixed(2)}L/周。ゴール必要量はまだ確定していない。`
    : `${current != null ? `Current ${current.toFixed(1)}L. ` : ''}Average ${avg.toFixed(2)}L/lap; finish requirement is not confirmed.`;
  return ja(lang) ? '燃料計画に必要な実測がまだ揃っていない。' : 'Measured data for a fuel plan is not ready.';
}

function buildRaceDistance(live, lang) {
  const plan = live && live.race_plan || {};
  const crossings = finite(live && live.finish_crossings_authority);
  const remaining = finite(live && live.session_time_remaining_s);
  const totalLaps = finite(live && live.laps_total), lap = finite(live && live.lap);
  if (plan.kind === 'timed') {
    const clock = formatDuration(remaining, lang);
    const shortDistance = crossings != null && crossings <= 10;
    if (ja(lang)) return `${clock ? `残り${clock}。` : '残り時間は未取得。'}${shortDistance ? `残り${Math.trunc(crossings)}周。` : ''}`;
    return `${clock ? `${clock} remaining. ` : 'Remaining time unavailable. '}${shortDistance ? `${Math.trunc(crossings)} laps remaining.` : ''}`;
  }
  if (plan.kind === 'laps' && totalLaps != null && lap != null) {
    const left = Math.max(0, Math.trunc(totalLaps - lap));
    return ja(lang) ? `全${Math.trunc(totalLaps)}周、現在${Math.trunc(lap)}周目。残り約${left}周。` : `${Math.trunc(totalLaps)} laps total, lap ${Math.trunc(lap)} now, about ${left} remaining.`;
  }
  return ja(lang) ? 'レース距離の権威データが未確定。周回数は作らない。' : 'Authoritative race distance is unavailable; I will not invent a lap count.';
}

function buildRejoin(live, lang) {
  const outcome = live && live.pit_cycle_outcome;
  if (outcome) {
    const actual = position(outcome.post_cycle_actual_position), predicted = position(outcome.conditional_cycle_position);
    const stopped = Number(outcome.observed_pack_pit_count) || 0;
    const total = Number(outcome.observed_pack_car_count) || 0;
    if (outcome.condition_met === true) {
      return ja(lang) ? `ブレンド実績P${actual || '不明'}。事前予測P${predicted || '不明'}、${actual && predicted ? Math.abs(actual - predicted) + 'ポジション差。' : '誤差は未採点。'}`
        : `Blended result P${actual || 'unknown'}. Forecast P${predicted || 'unknown'}${actual && predicted ? `, ${Math.abs(actual - predicted)} positions off.` : '; error ungraded.'}`;
    }
    if (actual && predicted) {
      const delta = predicted - actual;
      const comparison = delta > 0 ? (ja(lang) ? `予測より${delta}つ上。` : `${delta} position${delta === 1 ? '' : 's'} better than forecast. `)
        : delta < 0 ? (ja(lang) ? `予測より${Math.abs(delta)}つ下。` : `${Math.abs(delta)} position${Math.abs(delta) === 1 ? '' : 's'} worse than forecast. `)
          : (ja(lang) ? '予測通り。' : 'Matched the forecast. ');
      return ja(lang)
        ? `ブレンド実績P${actual}。事前の条件付き予測P${predicted}、${comparison}停止条件は${stopped}/${total}台で未成立。`
        : `Blended result P${actual}. Conditional forecast P${predicted}; ${comparison}The stop condition was not met (${stopped}/${total}).`;
    }
  }
  const status = live && live.pit_cycle_status;
  if (status && status.active) {
    const current = position(live.class_pos), stopped = Number(status.observed_pack_pit_count) || 0;
    const total = Number(status.observed_pack_car_count) || 0, predicted = position(status.conditional_cycle_position);
    return ja(lang)
      ? `現在順位P${current || '不明'}。対象集団停止${stopped}/${total}台で条件はまだ未成立。事前のP${predicted || '不明'}は条件付き予測なので、現順位との一致判定はまだしない。`
      : `Current position P${current || 'unknown'}. The condition is not met: ${stopped}/${total} target cars have stopped. P${predicted || 'unknown'} remains conditional, so I will not grade it against the current position yet.`;
  }
  const f = live && live.pit_exit_forecast;
  const likely = position(f && f.likely && f.likely.position), best = position(f && f.best && f.best.position), worst = position(f && f.worst && f.worst.position);
  if (!(f && f.available && likely && best && worst)) return ja(lang) ? '復帰予測のライブデータが揃っていない。順位は出さない。' : 'Live rejoin data is incomplete; I will not give a position.';
  const cycle = f.pit_cycle && f.pit_cycle.if_pack_stops && f.pit_cycle.if_pack_stops.likely;
  const cyclePos = position(cycle && cycle.position), pack = finite(cycle && cycle.pack_car_count);
  if (ja(lang)) return `今入る物理復帰P${likely}、範囲P${best}〜P${worst}。${cyclePos && pack ? `近傍${Math.trunc(pack)}台が停止すればブレンド後P${cyclePos}。停止意図は未確認。` : '他車の停止意図は未確認。'}`;
  return `Physical exit P${likely}, range P${best}-P${worst}. ${cyclePos && pack ? `If the ${Math.trunc(pack)}-car pack stops, cycle P${cyclePos}; intent unconfirmed.` : 'Rival pit intent is unconfirmed.'}`;
}

function buildStrategySwitch(live, lang, card = {}) {
  const requested=card.requestedPlan==='C'?'C':'B';
  const playbook=live&&live.strategy_playbook;
  if(!playbook||!playbook.available) return ja(lang)
    ? 'ベース戦略がまだ成立していない。アンダーカット／オーバーカットを推測では選ばない。'
    : 'The baseline playbook is not established, so I will not guess an undercut or overcut.';
  const plan=playbook.plans&&playbook.plans[requested];
  if(!plan||plan.available===false) return ja(lang)
    ? `Plan ${requested}は同じ給油回数では成立しない。`
    : `Plan ${requested} is not viable with the same stop count.`;
  const battle=live.battle_context||{};
  const gap=finite(live.gap_ahead??battle.gap_ahead_s);
  const pace=finite(battle.player_pace_advantage_s);
  const now=live.pit_exit_forecast||{}, next=live.pit_next_lap_forecast||{};
  const nowPos=position(now.likely&&now.likely.position), nextPos=position(next.likely&&next.likely.position);
  if(requested==='B'){
    if(gap!=null&&pace!=null&&gap<=1.5&&pace>=0.4&&nowPos!=null
      &&String(now.likely?.traffic_state||'')!=='blend_risk') return ja(lang)
      ? `Plan B、アンダーカットを推奨。前走車まで${gap.toFixed(1)}秒、こちらが${pace.toFixed(1)}秒速く詰まっている。根拠は燃料不足ではなくトラフィック回避。今入る物理復帰P${nowPos}。`
      : `Recommend Plan B, the undercut. The gap is ${gap.toFixed(1)}s and we are ${pace.toFixed(1)}s faster. The reason is traffic avoidance, not a fuel shortfall. Physical rejoin P${nowPos}.`;
    return ja(lang)
      ? `Plan Bの条件を確認中。${gap!=null?`前走車まで${gap.toFixed(1)}秒。`:''}${pace!=null?`相対ペースは${pace>=0?'こちらが'+pace.toFixed(1)+'秒速い':'こちらが'+Math.abs(pace).toFixed(1)+'秒遅い'}。`:'3周の相対ペース待ち。'}物理復帰がクリアになればアンダーカットを出す。`
      : `Plan B conditions are still being checked. ${gap!=null?`Gap ${gap.toFixed(1)}s. `:''}${pace!=null?`Our pace delta is ${pace.toFixed(1)}s. `:'Waiting for a three-lap relative pace sample. '}I will call the undercut only with a clear physical rejoin.`;
  }
  const fs=live.fuel_strategy||{}, avg=finite(fs.avg_fuel_per_lap), fuel=finite(live.fuel);
  const lap=finite(live.lap), target=finite(plan.first_pit_lap);
  const laps=lap!=null&&target!=null?Math.max(1,target-lap):null;
  const fuelSafe=avg!=null&&fuel!=null&&laps!=null&&fuel-avg*laps>=0.5;
  if(gap!=null&&pace!=null&&Math.abs(pace)<=0.3&&fuelSafe&&nowPos!=null&&nextPos!=null&&nextPos<=nowPos) return ja(lang)
    ? `Plan C、オーバーカットを推奨。ペース差は${Math.abs(pace).toFixed(1)}秒で小さい。次周まで燃料成立、復帰予測は今P${nowPos}に対して次周P${nextPos}。`
    : `Recommend Plan C, the overcut. Pace difference is only ${Math.abs(pace).toFixed(1)}s. Fuel supports the next lap, and rejoin improves from P${nowPos} now to P${nextPos} next lap.`;
  return ja(lang)
    ? `Plan Cの条件を確認中。ペース差、次周までの燃料、今と次周の物理復帰をそろえてからオーバーカットを出す。`
    : 'Plan C conditions are still being checked. I need the pace delta, fuel to the next lap, and physical rejoin now versus next lap before calling the overcut.';
}

function buildPitLoss(live, lang) {
  const exact = live && live.last_pit_service || {};
  const lane = finite(exact.lane_total_s);
  if (lane != null && lane > 0) return ja(lang) ? `直近のINからOUTまで${lane.toFixed(1)}秒。実測値。` : `Latest measured IN-to-OUT time: ${lane.toFixed(1)}s.`;
  const cal = live && live.pit_loss_calibration || {};
  const median = finite(cal.lane_total_median_s), q1 = finite(cal.lane_total_q1_s), q3 = finite(cal.lane_total_q3_s), count = finite(cal.usable_sample_count);
  if (median != null) return ja(lang)
    ? `この車とコースのピットレーン中央値${median.toFixed(1)}秒${q1 != null && q3 != null ? `、実測範囲${q1.toFixed(1)}〜${q3.toFixed(1)}秒` : ''}。${count != null ? `${Math.trunc(count)}件の実測。` : ''}`
    : `Car-and-track pit-lane median ${median.toFixed(1)}s${q1 != null && q3 != null ? `, measured band ${q1.toFixed(1)}-${q3.toFixed(1)}s` : ''}${count != null ? ` from ${Math.trunc(count)} samples.` : '.'}`;
  return ja(lang) ? 'この車とコースのピットロス実測はまだ利用できない。' : 'Measured pit loss for this car and track is unavailable.';
}

function buildPitService(live, lang) {
  const sample = live && live.last_pit_service || {};
  const lane = finite(sample.lane_total_s), stall = finite(sample.stall_s), fuel = finite(sample.fuel_added_l);
  if (lane == null && stall == null && fuel == null) return ja(lang) ? '直近のピットサービス実測はまだない。' : 'No measured pit-service sample is available yet.';
  return ja(lang)
    ? `直近ピットはIN→OUT ${lane == null ? '不明' : lane.toFixed(1) + '秒'}、停止${stall == null ? '不明' : stall.toFixed(1) + '秒'}、給油${fuel == null ? '不明' : fuel.toFixed(1) + 'L'}。`
    : `Latest stop: IN-to-OUT ${lane == null ? 'unknown' : lane.toFixed(1) + 's'}, stationary ${stall == null ? 'unknown' : stall.toFixed(1) + 's'}, fuel ${fuel == null ? 'unknown' : fuel.toFixed(1) + 'L'}.`;
}

function derivedAction(live) {
  if (!hasAuthoritativeFinishTarget(live)) {
    return { action: 'hold', reason: 'finish_target_unavailable', set_fuel_l: null };
  }
  const { fs, add, set } = fuelPlan(live || {});
  const phase = pitPhase(live);
  if (phase === 'finished') return { action: 'hold', reason: 'race_finished', set_fuel_l: 0 };
  if (phase === 'out_lap' && add != null && add <= 0) {
    return { action: 'hold', reason: 'out_lap', set_fuel_l: 0, margin_l: finite(fs.margin_l) };
  }
  const owned = live && live.strategy_plan;
  if (owned && owned.action) {
    if (owned.action === 'box' && add != null && add <= 0) {
      return { action: phase === 'racing' ? 'push' : 'hold', reason: phase === 'racing' ? 'fuel_margin' : phase,
        set_fuel_l: 0, margin_l: finite(fs.margin_l) };
    }
    return owned;
  }
  if (fs.pit_required === true || (add != null && add > 0)) return { action: 'box', reason: 'fuel_shortfall', set_fuel_l: set };
  const margin = finite(fs.margin_l);
  if (margin != null && margin >= 0) return { action: 'push', reason: 'fuel_margin', margin_l: margin };
  return { action: 'hold', reason: 'insufficient_data' };
}

function buildPitDecision(live, lang, card) {
  // ★2026-08-31：ドライバーが決めた時は従う。前の集団の動きが見えているのは
  //   ドライバーであり、こちらのtiming authorityより判断材料が多い場面がある。
  //   反論があっても「ステイアウト」で上書きせず、入れながら一言添えるだけにする。
  if (card && card.driverCommand === true) {
    const phaseNow = pitPhase(live);
    if (phaseNow === 'pit_lane') return ja(lang)
      ? '了解、ピットレーン内。作業を完了する。' : 'Copy, in the lane. Completing the stop.';
    if (phaseNow === 'finished') return ja(lang)
      ? 'レース終了。ここでのピットは無い。' : 'Race is over; there is no stop to make.';
    const add = finite(fuelPlan(live || {}).add);
    const t = live && live.fuel_strategy && live.fuel_strategy.pit_timing_authority;
    const planLap = t && t.available === true ? finite(t.latest_safe_pit_lap) : null;
    const differs = t && t.available === true && t.decision && t.decision !== 'pit_now';
    if (ja(lang)) {
      const head = add != null ? `了解、ボックス。給油${add.toFixed(1)}Lで最後まで持つ。` : '了解、ボックス。';
      return head + (differs && planLap != null
        ? `Plan ${t.selected_plan || 'A'}の目安は${Math.trunc(planLap)}周目だったけど、判断は任せる。` : '');
    }
    const head = add != null ? `Copy, box. ${add.toFixed(1)} litres takes you to the finish.` : 'Copy, box.';
    return head + (differs && planLap != null
      ? ` Plan ${t.selected_plan || 'A'} had lap ${Math.trunc(planLap)}, but it is your call.` : '');
  }
  const endurance = live && ((live.fuel_strategy || {}).endurance_plan
    || live.endurance_fuel_plan) || {};
  if (endurance.available === true && endurance.multi_stop === true) {
    if (endurance.box_this_lap === true) return ja(lang)
      ? 'この周ボックス。通常給油。' : 'Box this lap for the normal fuel stop.';
    const next = finite(endurance.next_fuel_stop_in_laps);
    return ja(lang)
      ? `ステイアウト。次の給油目安はあと${Math.trunc(next)}周。`
      : `Stay out. Next fuel stop in about ${Math.trunc(next)} laps.`;
  }
  const p = derivedAction(live), phase = pitPhase(live), shortage = fuelPlan(live || {}).add;
  if (phase === 'finished') return ja(lang) ? 'レース終了。追加のピット判断は出さない。' : 'Race finished; no further pit decision.';
  if (phase === 'pit_lane') return ja(lang) ? '現在ピットレーン内。今の作業を完了する。' : 'Currently in the pit lane; complete this stop.';
  if (phase === 'out_lap') {
    if (p.action === 'box') return ja(lang)
      ? `給油不足が${finite(shortage) == null ? '残っている' : finite(shortage).toFixed(1) + 'L残っている'}。ペースは上げず、次の周で再ピット。`
      : `Fuel shortfall remains. Do not push; box again next lap.`;
    return ja(lang) ? 'ピット完了。アウトラップはタイヤを作ってペースキープ。' : 'Stop complete. Build the tyres and hold pace on the out-lap.';
  }
  // A negative total-to-finish margin does not mean "box this lap" when the
  // owned timing authority says the planned window is still ahead.  Keep the
  // response aligned with the same authority used by the bridge warning gate.
  const timing = live && live.fuel_strategy && live.fuel_strategy.pit_timing_authority;
  if (p.action === 'box' && timing && timing.available === true
      && timing.decision && timing.decision !== 'pit_now') {
    const latest = finite(timing.latest_safe_pit_lap);
    const until = finite(timing.laps_until_latest_safe_pit);
    if (ja(lang)) {
      return latest != null && until != null
        ? `今はステイアウト。Plan ${timing.selected_plan || 'A'}を継続、最終目安は${Math.trunc(latest)}周目、あと${Math.trunc(until)}周。`
        : '今はステイアウト。ピットウィンドウまで走れる。';
    }
    return latest != null && until != null
      ? `Stay out for now. Continue Plan ${timing.selected_plan || 'A'}; latest target lap ${Math.trunc(latest)}, ${Math.trunc(until)} laps away.`
      : 'Stay out for now; the pit window is still reachable.';
  }
  if (p.action === 'box') {
    const f = live && live.pit_exit_forecast || {};
    const cycle = f.pit_cycle && f.pit_cycle.if_pack_stops && f.pit_cycle.if_pack_stops.likely;
    const cyclePos = position(cycle && cycle.position), current = position(live && live.class_pos);
    const strong = cyclePos && current && cyclePos < current;
    if (ja(lang)) return `${strong ? 'この周でピットを強く推奨' : 'ピットを推奨'}。燃料不足が根拠。${finite(p.set_fuel_l) == null ? '給油量は未確定' : '給油設定は' + Math.trunc(p.set_fuel_l) + 'L'}。${cyclePos ? `条件成立ならブレンド後P${cyclePos}見込み。` : ''}`;
    return `${strong ? 'Strong recommendation: box this lap' : 'Recommendation: box'}. Fuel shortfall is the reason. ${finite(p.set_fuel_l) == null ? 'Fuel amount unconfirmed' : `Set ${Math.trunc(p.set_fuel_l)}L`}.${cyclePos ? ` P${cyclePos} blended if the condition is met.` : ''}`;
  }
  if (p.action === 'push') return ja(lang) ? `判断はステイアウトしてプッシュ。燃料余裕${finite(p.margin_l) == null ? '確認済み' : finite(p.margin_l).toFixed(1) + 'L'}。` : `Decision: stay out and push; fuel margin ${finite(p.margin_l) == null ? 'confirmed' : finite(p.margin_l).toFixed(1) + 'L'}.`;
  return ja(lang) ? '判断はホールド。確定データが足りないのでボックス指示は出さない。' : 'Decision: hold. Data is insufficient, so I will not call a stop.';
}

function buildPlanStatus(live, lang, card = {}) {
  const p = derivedAction(live), prefix = '';
  const playbook=live&&live.strategy_playbook;
  if(playbook&&playbook.available){
    const chosen=card.planChoice||playbook.selected_plan||'A';
    const plan=playbook.plans&&playbook.plans[chosen];
    if(card.planChoice&&plan){
      const label={A:'ベースライン',B:'アンダーカット',C:'オーバーカット'}[chosen];
      const stops=Array.isArray(plan.pit_laps)&&plan.pit_laps.length?plan.pit_laps.join('・'):'なし';
      const condition=chosen==='B'?'前で詰まり、こちらの相対ペースが速く、物理復帰がクリアなら切り替える。'
        :chosen==='C'?`ペース差が小さく、次周の復帰が悪化せず、燃費${Number(plan.required_fuel_saving_pct||0).toFixed(1)}%改善が成立すれば切り替える。`
          :'現在の基準案。';
      return ja(lang)?`Plan ${chosen}は${label}。${condition}`
        :`Plan ${chosen} is the ${chosen==='A'?'baseline':chosen==='B'?'undercut':'overcut'}. Planned stops: laps ${stops}.`;
    }
    const a=playbook.plans.A||{}, b=playbook.plans.B||{}, c=playbook.plans.C||{};
    return ja(lang)
      ? `現在はPlan ${playbook.selected_plan||'A'}。Plan Aは基準、Plan Bは燃料ウィンドウ成立時のアンダーカット、Plan Cは節約燃費が成立した時のオーバーカット。具体的なピット周は当日計算が揃ってから出す。`
      : `Current selection is Plan ${playbook.selected_plan||'A'}. Plan A is the baseline, Plan B the undercut, and Plan C the overcut.`;
  }
  const options=live&&live.strategy_options;
  if(card.planChoice&&options&&options.available){
    const plan=options['plan_'+card.planChoice.toLowerCase()]||{};
    if(!plan.available) return ja(lang)?`プラン${card.planChoice}は現在成立していない。`:`Plan ${card.planChoice} is not currently viable.`;
    const when=Number(plan.target_in_laps)===0?(ja(lang)?'この周':'this lap'):(ja(lang)?`あと${Math.trunc(plan.target_in_laps)}周走って`:`in ${Math.trunc(plan.target_in_laps)} laps`);
    return ja(lang)
      ? `${card.planChoice==='B'?'1周延長案':'燃料タイミング基準案'}は${when}ピット、給油設定${Math.trunc(plan.set_fuel_l)}L。${card.planChoice==='B'?'燃料予測と復帰トラフィックを再確認して切り替える。':'現在の燃料基準案。'}`
      : `${card.planChoice==='B'?'One-lap fuel extension':'Fuel timing baseline'}: pit ${when}, set ${Math.trunc(plan.set_fuel_l)}L.`;
  }
  if (p.action === 'box') return prefix + (ja(lang) ? `燃料不足でボックス。給油${finite(p.set_fuel_l) == null ? '未確定' : Math.trunc(p.set_fuel_l) + 'L'}。` : `Box for fuel; set ${finite(p.set_fuel_l) == null ? 'unconfirmed' : Math.trunc(p.set_fuel_l) + 'L'}.`);
  if (p.action === 'push') return prefix + (ja(lang) ? 'ステイアウトしてプッシュ。燃料余裕あり。' : 'Stay out and push; fuel margin is positive.');
  const current = position(live && live.class_pos), remaining = finite(live && live.session_time_remaining_s);
  const fs = live && live.fuel_strategy || {};
  const samples = finite(fs.clean_laps_sampled), avg = finite(fs.avg_fuel_per_lap);
  if (ja(lang)) {
    const facts = `${current != null ? `現在P${current}。` : ''}${remaining != null ? `残り${formatDuration(remaining, lang)}。` : ''}`;
    if (avg != null && samples != null && samples < 3) return prefix + `${facts}燃費はクリーン${Math.trunc(samples)}周の実測。あと${Math.max(0, 3 - Math.trunc(samples))}周で燃料判断を更新する。今はピット判断を固定しない。`;
    if (avg == null) return prefix + `${facts}燃費のクリーン実測がまだない。3周そろうまでピット判断は固定しない。`;
    return prefix + `${facts}燃料の完走根拠がまだ不足。今はピット判断を固定しない。`;
  }
  return prefix + 'Fuel-finish evidence is not ready; I will not lock a pit call yet.';
}

function buildPitLapQuery(live, lang, card = {}) {
  const playbook = live && live.strategy_playbook;
  const chosen = card.planChoice || (playbook && playbook.selected_plan) || 'A';
  const plan = playbook && playbook.available && playbook.plans && playbook.plans[chosen];
  if (!plan || plan.available === false) return ja(lang)
    ? `Plan ${chosen}のピット周はまだ成立していない。`
    : `The pit lap for Plan ${chosen} is not established yet.`;
  const entry = finite(plan.pit_entry_after_lap ?? plan.first_pit_lap);
  const service = finite(plan.pit_service_lap ?? (entry != null ? entry + 1 : null));
  if (entry == null) return ja(lang)
    ? `Plan ${chosen}のピット周はまだ計算できない。`
    : `The pit lap for Plan ${chosen} is not calculated yet.`;
  const memoryBasis = playbook.pit_lap_plan && playbook.pit_lap_plan.basis === 'memory_previous';
  const basis = memoryBasis
    ? (ja(lang) ? '前回の同条件燃費からの推定' : 'estimated from the previous matching fuel record')
    : (ja(lang) ? '今日の実測燃費' : "today's measured fuel burn");
  return ja(lang)
    ? `Plan ${chosen}。${Math.trunc(entry)}周を走り終えてピットイン、作業は${Math.trunc(service)}周目。${basis}だよ。`
    : `Plan ${chosen}: pit after completing lap ${Math.trunc(entry)}; service is on lap ${Math.trunc(service)}. This is ${basis}.`;
}

function buildPace(live, lang) {
  const { fs, current, required, add } = fuelPlan(live || {});
  const endurance = fs.endurance_plan || live.endurance_fuel_plan || {};
  // A total-to-finish shortfall says that a service will be needed, not that
  // it is needed now.  The Bridge timing contract is the only authority that
  // may turn a pace conversation into a box-now instruction.  This prevents
  // the RBR replay failure where “the cars behind look faster” was answered
  // with a premature fuel lecture while Plan A was still reachable.
  const timing = fs.pit_timing_authority && typeof fs.pit_timing_authority === 'object'
    ? fs.pit_timing_authority : null;
  const pitNow = timing && timing.available === true && timing.decision === 'pit_now';
  // `required_fuel_l` is evaluated at an S/F crossing.  Subtracting it from
  // the *current* tank later in the same lap double-counts burned fuel and
  // produced the 8/14 false “0.1L margin, push” call.  Only the Bridge's
  // margin and explicit push permission are valid for a pace decision.
  const margin = finite(fs.margin_l);
  const pushAllowed = fs.push_allowed === true;
  const phase = pitPhase(live);
  if (phase === 'finished') return ja(lang) ? 'レース終了。ペース指示は終了。' : 'Race finished; pace calls are complete.';
  if (phase === 'pit_lane') return ja(lang) ? '現在ピットレーン内。作業完了を優先。' : 'Currently in the pit lane; complete the stop.';
  if (endurance.available === true && endurance.multi_stop === true
      && endurance.box_this_lap !== true) {
    const next = finite(endurance.next_fuel_stop_in_laps);
    return ja(lang)
      ? `通常スティント継続。ペースキープ、次の給油目安はあと${Math.trunc(next)}周。`
      : `Continue the normal stint and hold pace; next fuel stop in about ${Math.trunc(next)} laps.`;
  }
  if (phase === 'out_lap') return ja(lang)
    ? (add != null && add > 0
      ? `給油不足が${add.toFixed(1)}L残っている。ペースは上げず、次の周で再ピット。`
      : `アウトラップ。タイヤを作ってペースキープ。燃費セーブ量は次の有効周で更新する。`)
    : (add != null && add > 0
      ? `Fuel shortfall ${add.toFixed(1)}L. Do not push; box again next lap.`
      : `Stop complete. ${margin != null && margin >= 0 ? `Projected finish margin ${margin.toFixed(1)}L. ` : ''}Build the tyres and hold pace.`);
  if (pitNow) return ja(lang) ? `今周ピット。現在${current != null ? current.toFixed(1) : '不明'}L、必要総量${required != null ? required.toFixed(1) : '未確定'}L。` : `Pit this lap. Current ${current != null ? current.toFixed(1) : 'unknown'}L; ${required != null ? required.toFixed(1) + 'L required' : 'requirement unconfirmed'}.`;
  if (timing && timing.available === true && (timing.decision === 'hold' || timing.decision === 'pit_later')) {
    const until = finite(timing.laps_until_latest_safe_pit);
    return ja(lang)
      ? `前後の相対ペースはまだ確定できない。燃料はPlan ${timing.selected_plan || 'A'}を維持、次の判断は${until != null ? `あと${Math.max(0, Math.trunc(until))}周` : '次のウィンドウ'}。`
      : `Front-and-rear relative pace is not confirmed yet. Hold Plan ${timing.selected_plan || 'A'}; next decision ${until != null ? `in ${Math.max(0, Math.trunc(until))} laps` : 'at the next window'}.`;
  }
  if (margin != null && margin >= 0 && pushAllowed) return ja(lang) ? `燃料は${margin.toFixed(1)}L余裕。ペースを上げていい。` : `${margin.toFixed(1)}L fuel margin. You can push.`;
  if (margin != null && margin >= 0) return ja(lang) ? `燃料は${margin.toFixed(1)}L余裕。ペースキープ。` : `${margin.toFixed(1)}L fuel margin. Hold pace.`;
  return ja(lang) ? 'ペースアップ可否を決める燃料余裕がまだ確定していない。' : 'Fuel margin is not confirmed, so I cannot clear a push yet.';
}

function findStandingGap(live, targetPosition) {
  const raw = live && live.standings_gaps;
  if (raw && !Array.isArray(raw) && typeof raw === 'object') return finite(raw[String(targetPosition)]);
  const rows = Array.isArray(raw) ? raw : [];
  const row = rows.find(r => position(r.class_pos ?? r.class_position ?? r.position) === targetPosition);
  return row ? finite(row.gap_s ?? row.gap_to_player_s ?? row.delta_s) : null;
}

function buildPositionGap(live, targetPosition, lang) {
  const current = position(live && live.class_pos);
  if (targetPosition) {
    const gap = findStandingGap(live, targetPosition);
    if (gap != null) return ja(lang) ? `現在P${current || '不明'}。P${targetPosition}まで${Math.abs(gap).toFixed(1)}秒。` : `Currently P${current || 'unknown'}; ${Math.abs(gap).toFixed(1)}s to P${targetPosition}.`;
    return ja(lang) ? `現在P${current || '不明'}。P${targetPosition}との確定GAPは取得できない。` : `Currently P${current || 'unknown'}; verified gap to P${targetPosition} is unavailable.`;
  }
  const gap = finite(live && live.gap_ahead);
  if (gap != null) return ja(lang) ? `現在P${current || '不明'}。直前車まで${Math.abs(gap).toFixed(1)}秒。` : `Currently P${current || 'unknown'}; ${Math.abs(gap).toFixed(1)}s to the car ahead.`;
  return ja(lang) ? `現在P${current || '不明'}。直前車GAPは取得できない。` : `Currently P${current || 'unknown'}; gap ahead is unavailable.`;
}

function buildCurrentPosition(live, lang) {
  const cls = position(live && live.class_pos), overall = position(live && live.pos);
  if (cls == null && overall == null) return ja(lang) ? '現在順位は取得できない。' : 'Current position is unavailable.';
  return ja(lang) ? `クラスP${cls || '不明'}、総合P${overall || '不明'}。` : `Class P${cls || 'unknown'}, overall P${overall || 'unknown'}.`;
}

function buildLeaderGap(live, lang) {
  const leader = live && live.leaders && live.leaders.player_class;
  const gap = finite(leader && leader.gap_s), current = position(live && live.class_pos);
  if (current === 1) return ja(lang) ? '現在クラスリーダー。' : 'You are the class leader.';
  if (gap == null) return ja(lang) ? 'クラスリーダーとの確定GAPは取得できない。' : 'Verified gap to the class leader is unavailable.';
  return ja(lang) ? `クラスリーダーまで${Math.abs(gap).toFixed(1)}秒。` : `${Math.abs(gap).toFixed(1)}s to the class leader.`;
}

function buildTyreStatus(live, lang, card = {}) {
  const tires = live && live.tires || {}, names = { lf:'左前', rf:'右前', lr:'左後', rr:'右後' };
  const measurement = live && live.tire_measurement || {};
  const query = card.tyreQuery || 'status';
  if (measurement.available !== true) {
    if (query === 'temperature') return ja(lang)
      ? '走行中のタイヤ温度はエンジニア側では取得できない。車種によってダッシュ表示があれば値を教えて。表示がなければ挙動と路面温度で判断する。'
      : 'Live tyre temperature is unavailable to the engineer. If this car shows it on the dash, read me the value; otherwise we work from handling and track temperature.';
    if (query === 'wear') return ja(lang)
      ? '走行中のタイヤ摩耗は取得できない。ピット帰還後の計測値で確認する。'
      : 'Live tyre wear is unavailable. I can confirm the measured value after the car returns to the pit.';
    return ja(lang)
      ? '走行中のタイヤ温度・摩耗は取得できない。温度は車両ダッシュ、摩耗はピット帰還後に確認する。'
      : 'Live tyre temperature and wear are unavailable. Read temperature from the car dashboard and confirm wear after returning to the pit.';
  }
  const rows = Object.keys(names).map(k => {
    const tire = tires[k] || {}, wear = Array.isArray(tire.w) ? tire.w.map(finite).filter(v => v != null) : [];
    const temp = Array.isArray(tire.t) ? tire.t.map(finite).filter(v => v != null) : [];
    return { k, wear: wear.length ? Math.min(...wear) : null, temp: temp.length ? temp.reduce((a,b)=>a+b,0)/temp.length : null };
  });
  if (!rows.some(r => r.wear != null || r.temp != null)) return ja(lang) ? '走行中に信頼できるタイヤ摩耗・温度は取得できない。' : 'Reliable tyre wear and temperature are unavailable while running.';
  const parts = rows.filter(r => query === 'temperature' ? r.temp != null : query === 'wear' ? r.wear != null : (r.wear != null || r.temp != null)).map(r => ja(lang)
    ? `${names[r.k]}${query === 'temperature' ? ` ${r.temp.toFixed(1)}℃` : query === 'wear' ? ` 残${r.wear.toFixed(1)}%` : ` 残${r.wear == null ? '不明' : r.wear.toFixed(1) + '%'}${r.temp == null ? '' : ` ${r.temp.toFixed(1)}℃`}`}`
    : `${r.k.toUpperCase()}${query === 'temperature' ? ` ${r.temp.toFixed(1)}C` : query === 'wear' ? ` ${r.wear.toFixed(1)}% remaining` : ` ${r.wear == null ? 'wear unknown' : r.wear.toFixed(1) + '% remaining'}${r.temp == null ? '' : ` ${r.temp.toFixed(1)}C`}`}`);
  return parts.join(ja(lang) ? '、' : ', ') + (ja(lang) ? '。' : '.');
}

function buildDamageStatus(live, lang) {
  const seconds = finite(live && live.damage_s);
  if (seconds == null) return ja(lang) ? 'SDK修理時間は取得できない。' : 'SDK repair time is unavailable.';
  if (seconds > 0) return ja(lang) ? `SDKの修理残り${seconds.toFixed(1)}秒。` : `${seconds.toFixed(1)}s SDK repair time remaining.`;
  return ja(lang) ? 'SDKの修理残り0.0秒。空力損傷なしとは断定しない。' : 'SDK repair time is 0.0s; that does not prove zero aero damage.';
}

function buildWeatherStatus(live, lang) {
  const w = live && live.weather || {}, track = finite(w.track_temp_c), air = finite(w.air_temp_c), humidity = finite(w.humidity), wet = finite(w.track_wetness_code);
  if ([track, air, humidity, wet].every(v=>v == null)) return ja(lang) ? '天候テレメトリは取得できない。' : 'Weather telemetry is unavailable.';
  const wetJP = {1:'ドライ',2:'ほぼドライ',3:'ごく薄いウェット',4:'ライトウェット',5:'ウェット',6:'かなりウェット',7:'極端なウェット'};
  const wetEN = {1:'dry',2:'mostly dry',3:'very lightly wet',4:'lightly wet',5:'moderately wet',6:'very wet',7:'extremely wet'};
  return ja(lang)
    ? `路面${track == null ? '不明' : track.toFixed(1) + '℃'}、気温${air == null ? '不明' : air.toFixed(1) + '℃'}、湿度${humidity == null ? '不明' : humidity.toFixed(0) + '%'}、路面${wet == null ? '不明' : wetJP[Math.trunc(wet)] || '不明'}。`
    : `Track ${track == null ? 'unknown' : track.toFixed(1) + 'C'}, air ${air == null ? 'unknown' : air.toFixed(1) + 'C'}, humidity ${humidity == null ? 'unknown' : humidity.toFixed(0) + '%'}, surface ${wet == null ? 'unknown' : wetEN[Math.trunc(wet)] || 'unknown'}.`;
}

function buildHistoricalWeather(_live, lang) {
  return ja(lang)
    ? '前回の天候記録は確認できない。現在値では代用しない。'
    : 'I cannot verify the previous weather record. I will not substitute the current value.';
}

function buildTrafficStatus(live, lang) {
  const a = finite(live && live.gap_ahead), b = finite(live && live.gap_behind);
  if (a == null && b == null) return ja(lang) ? '現在の前後GAPは取得できない。' : 'Current verified gaps are unavailable.';
  return ja(lang) ? `現在の直前車まで${a == null ? '不明' : a.toFixed(1) + '秒'}、直後車まで${b == null ? '不明' : b.toFixed(1) + '秒'}。` : `Current gaps: ${a == null ? 'unknown' : a.toFixed(1) + 's'} to the car ahead, ${b == null ? 'unknown' : b.toFixed(1) + 's'} to the car behind.`;
}

// ★八木さん実走ログ 7-1：セットアップ相談への回答。
//   brief の指定した順序で組む。
//     1. 実測の環境値を短く根拠として確認する
//     2. 症状と、低速／中速／高速のどこで強いかを確認する
//     3. 車種固有の未検証な数値を断定せず、試す方向を最大二つ提案する
//     4. 次の走行で比較する観測項目を一つ指定する
//   数値は live テレメトリにある実測だけを使う。無ければ触れない（捏造しない）。
// 症状ごとに「次の走行で何を見るか」。無線を短く保つため一つだけ指定する。
const SETUP_OBSERVATION = {
  rear_grip:        { ja: '低速出口を3周だけ比べて。', en: 'Compare three low-speed exits.' },
  understeer:       { ja: '低速進入を3周比べて。',     en: 'Compare three slow entries.' },
  oversteer:        { ja: '低速出口を3周比べて。',     en: 'Compare three low-speed exits.' },
  tyre_degradation: { ja: '3周後のタイム落ちを見て。', en: 'Watch the drop-off after three laps.' },
  unspecified:      { ja: 'アンダーとオーバー、どっちが強い？', en: 'Which is stronger, understeer or oversteer?' },
};

const SETUP_DIRECTIONS = {
  rear_grip: {
    ja: ['リアスプリングを1段柔らかく', 'リアのアンチロールバーを1段柔らかく'],
    en: ['soften the rear spring one step', 'soften the rear anti-roll bar one step'],
  },
  understeer: {
    ja: ['フロントのアンチロールバーを1段柔らかく', 'リアの車高をわずかに上げる'],
    en: ['soften the front anti-roll bar one step', 'raise the rear ride height slightly'],
  },
  oversteer: {
    ja: ['リアのアンチロールバーを1段柔らかく', 'リアウイングを1段立てる'],
    en: ['soften the rear anti-roll bar one step', 'add one step of rear wing'],
  },
  tyre_degradation: {
    ja: ['タイヤ内圧を少し下げて発熱を抑える', 'ブレーキバイアスをわずかに後ろへ'],
    en: ['drop tyre pressures slightly to limit heat build-up',
         'move brake bias marginally rearward'],
  },
  // 症状が特定できていない時だけは聞き返してよい。どこを直すか決まらないため。
  unspecified: {
    ja: ['1周、同じラインで基準を取る'],
    en: ['take one reference lap on a consistent line'],
  },
};

function buildHandlingSetupAdvice(live, lang, card) {
  const isJa = ja(lang);
  const symptom = (card && card.symptom) || 'unspecified';
  const directions = (SETUP_DIRECTIONS[symptom] || SETUP_DIRECTIONS.unspecified)[isJa ? 'ja' : 'en'];
  const observe = (SETUP_OBSERVATION[symptom] || SETUP_OBSERVATION.unspecified)[isJa ? 'ja' : 'en'];
  const followUp = !!(card && card.inherited);

  // ★8/18 St Petersburg 実走（Build 276 → 277）：
  //   アンダー相談の回答が129文字あり、TTSが4分割されて全部言い終わるまで24秒かかった
  //   （22:44:42 質問 → 22:45:06 完了）。最初の声は665msで出ていたので、問題は長さそのもの。
  //   実測レートは約7文字/秒（chars=35 のチャンクが5秒）。Yuji判断で許容は3〜5秒＝21〜35文字。
  //
  //   したがって無線は「最初の一手」＋「何を見るか」だけにする。
  //     - 環境値の復唱をしない（聞かれていない数字を読み上げない）
  //     - 速度域を聞き返さない（一往復増えるとその分だけ遅くなる）
  //     - 症状名を復唱しない（直前に本人が言っている）
  //   二手目は、続けて聞かれた時（文脈引き継ぎ）に出す。同じ答えを繰り返さない。
  //   部品名は略さず正式名称で言う（Yuji指示・8/19）。
  const move = followUp && directions[1] ? directions[1] : directions[0];
  const lead = isJa ? (followUp && directions[1] ? '次は' : 'まず')
                    : (followUp && directions[1] ? 'Then ' : 'First ');
  if (isJa) return `${lead}${move}。${observe}`;
  return `${lead}${move}. ${observe}`;
}

function buildHandlingReport(live, lang, card) {
  const symptom = String(card && card.symptom || 'unspecified');
  if (!ja(lang)) return symptom === 'understeer'
    ? 'Copy. Let us compare the front response on the next clean lap.'
    : 'Copy. Let us compare the change on the next clean lap.';
  return symptom === 'understeer'
    ? '了解。次の有効周でフロントの反応を比べよう。'
    : '了解。次の有効周で変化を比べよう。';
}

function buildPenaltyReport(live, lang) {
  return ja(lang) ? '了解。ドライブスルーだったな。'
    : 'Copy. That was a drive-through penalty.';
}

function buildUnresolved(lang, card = {}) {
  const subject = String(card.subject || 'operation');
  if (!ja(lang)) {
    if (subject === 'gap') return 'I cannot verify that gap.';
    if (subject === 'pit') return 'I cannot verify that pit operation.';
    if (subject === 'fuel') return 'I cannot verify that fuel condition.';
    if (subject === 'penalty') return 'I cannot verify that penalty state.';
    return 'Say the key point again.';
  }
  if (subject === 'gap') return 'そのGAPは確認できない。';
  if (subject === 'pit') return 'そのピット操作は確認できない。';
  if (subject === 'fuel') return 'その燃料条件は確認できない。';
  if (subject === 'penalty') return 'そのペナルティ状態は確認できない。';
  return 'もう一度、要点だけ言って。';
}

function buildSessionFormat(live, lang) {
  const plan = live && live.race_plan || {};
  const type = String(live && live.session_type || '').trim();
  const remaining = finite(live && live.session_time_remaining_s);
  const configuredDuration = finite(plan.configured_duration_s);
  const configuredLabel = configuredDuration != null
    ? (configuredDuration >= 3600
      ? (ja(lang) ? `${Math.round(configuredDuration / 3600)}時間の` : `${Math.round(configuredDuration / 3600)}-hour `)
      : (ja(lang) ? `${Math.round(configuredDuration / 60)}分の` : `${Math.round(configuredDuration / 60)}-minute `))
    : '';
  const totalLaps = finite(live && live.laps_total);
  if (plan.kind === 'timed') return ja(lang)
    ? `${type || 'レース'}、${configuredLabel}レース。${remaining != null ? `残り${formatDuration(remaining, lang)}。` : '残り時間は未取得。'}`
    : `${type || 'Race'}, ${configuredLabel}race.${remaining != null ? ` ${formatDuration(remaining, lang)} remaining.` : ' Remaining time unavailable.'}`;
  if (plan.kind === 'laps' && totalLaps != null) return ja(lang)
    ? `${type || 'レース'}、${Math.trunc(totalLaps)}周制。` : `${type || 'Race'}, ${Math.trunc(totalLaps)} laps.`;
  return ja(lang) ? `${type || '現在のセッション'}の形式は、確定データを受信中。次の更新で伝える。` : `Session format data is still being confirmed; I will update on the next snapshot.`;
}

function build(card, live, lang = 'en') {
  if (!card) return null;
  const handlers = {
    [TOPIC.CURRENT_FUEL]: buildCurrentFuel, [TOPIC.FUEL_EMERGENCY]: buildFuelEmergency, [TOPIC.FUEL_PLAN]: buildFuelPlan,
    [TOPIC.FUEL_USE]: buildFuelUse, [TOPIC.RACE_DISTANCE]: buildRaceDistance,
    [TOPIC.REJOIN]: buildRejoin, [TOPIC.PIT_LOSS]: buildPitLoss,
    [TOPIC.PIT_DECISION]: buildPitDecision, [TOPIC.STRATEGY_SWITCH]: buildStrategySwitch,
    [TOPIC.PIT_SERVICE]: buildPitService,
    [TOPIC.PACE]: buildPace, [TOPIC.CURRENT_POSITION]: buildCurrentPosition,
    [TOPIC.LEADER_GAP]: buildLeaderGap, [TOPIC.TYRE_STATUS]: buildTyreStatus,
    [TOPIC.DAMAGE_STATUS]: buildDamageStatus, [TOPIC.WEATHER_STATUS]: buildWeatherStatus,
    [TOPIC.HISTORICAL_WEATHER]: buildHistoricalWeather,
    [TOPIC.HANDLING_SETUP_ADVICE]: (l, lg) => buildHandlingSetupAdvice(l, lg, card),
    [TOPIC.HANDLING_REPORT]: (l, lg) => buildHandlingReport(l, lg, card),
    [TOPIC.PENALTY_REPORT]: buildPenaltyReport,
    [TOPIC.TRAFFIC_STATUS]: buildTrafficStatus, [TOPIC.PLAN_STATUS]: buildPlanStatus,
    [TOPIC.PIT_LAP_QUERY]: (l, lg) => buildPitLapQuery(l, lg, card),
    [TOPIC.SESSION_FORMAT]: buildSessionFormat,
  };
  if (card.topic === TOPIC.ACKNOWLEDGEMENT) {
    if (card.finalLap) return ja(lang) ? '了解。ファイナルラップ。' : 'Copy. Final lap.';
    if (card.pitEntryReport) return ja(lang) ? '了解、ピットイン。' : 'Copy, pit entry.';
    if (Number.isInteger(card.reportedPosition)) {
      const actual = position(live && live.class_pos);
      if (actual != null && actual !== card.reportedPosition) return ja(lang)
        ? `確認、現在P${actual}。` : `Checked, currently P${actual}.`;
      return ja(lang) ? `了解、現在P${card.reportedPosition}。` : `Copy, currently P${card.reportedPosition}.`;
    }
    return ja(lang) ? '了解。' : 'Copy.';
  }
  if (card.topic === TOPIC.FUEL_PLAN) return buildFuelPlan(live || {}, lang, card);
  if (card.topic === TOPIC.POSITION_GAP) return buildPositionGap(live || {}, card.targetPosition, lang);
  if (card.topic === TOPIC.UNRESOLVED_OPERATIONAL) return buildUnresolved(lang, card);
  const handler = handlers[card.topic];
  return handler ? handler(live || {}, lang, card) : null;
}

function route(text, live, lang = 'en', options = {}) {
  const cards = classifyAll(text, options);
  if (!cards.length) return null;
  if (cards.length === 1) {
    const card = cards[0];
    const reply = build(card, live || {}, lang);
    return { card, cards, reply, status: card.topic === TOPIC.UNRESOLVED_OPERATIONAL ? 'deferred' : 'fired' };
  }
  const pitLap = cards.find(card => card.topic === TOPIC.PIT_LAP_QUERY);
  // The pit-lap answer includes the selected plan and is the complete answer
  // for "Plan A, what lap?".  Do not concatenate the generic Plan description.
  const reply = pitLap ? buildPitLapQuery(live || {}, lang, pitLap)
    : cards.map(card => build(card, live || {}, lang)).filter(Boolean).join(ja(lang) ? '' : ' ');
  return { card: cards[0], cards, reply, status: 'fired' };
}

module.exports = { TOPIC, classify, classifyAll, build, route, fuelPlan, hasAuthoritativeFinishTarget, formatDuration, pitPhase, OPERATIONAL_RE };
