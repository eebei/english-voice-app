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
  const answer = (intent, reply, action) => reply
    ? { handled:true, intent, reply, ...(action ? { action } : {}) }
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
    }
    return identity;
  };
  const gapAnswer = (intent, reply, identities) => reply
    ? { handled:true, intent, reply, gapIdentities:identities }
    : { handled:false };

  function fuelWindowStatus(live, lang) {
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
  function normalizeSttText(raw) {
    return String(raw || '')
      .replace(/gdp|GDP|ジーディーピー|ジーティーピー/g, 'GTP')
      .replace(/GTP.{0,4}コード/g, 'GTPのギャップ')
      .replace(/シュピート|シューピット/g, 'ピット');
  }

  function route(input) {
    const text = normalizeSttText(String(input && input.text || '').trim());
    const lang = input && input.lang === 'en' ? 'en' : 'ja';
    const live = input && input.live && typeof input.live === 'object' ? input.live : null;
    // PTT の直接質問も snapshot 時刻を検査する。渡されない場合は従来どおり
    // 検査しない（呼び出し側が古さを判断できない時に黙らせないため）。
    const snapshotAgeMs = finite(input && input.snapshotAgeMs);
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
    if (!text || !live) return { handled:false };

    if (/^(?:了解|了解です|わかった|分かった|オーケー|OK|copy|roger|understood)[。.!！?？]?$/i.test(text)) {
      return answer('acknowledgement', isJP(lang) ? '了解。' : 'Copy.');
    }
    // A future fuel-window instruction is a monitor command, not a request
    // for the current generic fuel total.  Build 279 sent this through
    // fuelReply(), then lost the promised follow-up entirely.  Arm a local
    // one-shot monitor; renderer delivers it from the authoritative Plan B
    // window without an LLM or Railway round trip.
    if (/(?:フューエル|燃料|給油).{0,10}(?:ウ[ィイ]?ンドウ|ウインド|window).{0,14}(?:(?:開)?いたら|開けば|オープンしたら).{0,14}(?:教えて|言って|コール|入る|入ろう|よろしく)|(?:tell|call|let me know).{0,16}(?:fuel )?window.{0,8}(?:open|opens)/i.test(text)) {
      return answer('fuel_window_watch', isJP(lang)
        ? '了解。ウィンドウが開いたら短くコールする。'
        : 'Copy. I will call it briefly when the fuel window opens.',
      { type:'arm_fuel_window_watch' });
    }
    if (/(?:フューエル|燃料|給油).{0,10}(?:ウ[ィイ]?ンドウ|ウインド|window)|(?:fuel )?window/i.test(text)) {
      const status = fuelWindowStatus(live, lang);
      return answer('fuel_window_status', status.reply);
    }
    if (/(?:燃料|給油|足りる|リットル|リッター|何(?:リットル|リッター|L)|fuel|lit(?:er|re)|make it)/i.test(text)) {
      return answer('fuel_status', fuelReply(live, lang));
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
    if (!/(?:トップ|首位|P1|leader)/i.test(text)
        && /残り.{0,5}(?:周|ラップ)|あと.{0,5}(?:周|ラップ)|何周|laps? (?:left|remaining)/i.test(text)) {
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
        parts.push(isJP(lang) ? `前${ahead.toFixed(1)}秒` : `${ahead.toFixed(1)} seconds ahead`);
        identities.push(gapIdentityFor(live, 'ahead', ahead));
      }
      if (wantsBehind && behind !== null) {
        parts.push(isJP(lang) ? `後ろ${behind.toFixed(1)}秒` : `${behind.toFixed(1)} seconds behind`);
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
        parts.push(isJP(lang) ? `前${ahead.toFixed(1)}秒` : `${ahead.toFixed(1)} seconds ahead`);
        identities.push(gapIdentityFor(live, 'ahead', ahead));
      }
      if (behind !== null) {
        parts.push(isJP(lang) ? `後ろ${behind.toFixed(1)}秒` : `${behind.toFixed(1)} seconds behind`);
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

  return { route, formatDuration, formatLapTime, fuelWindowStatus };
}));
