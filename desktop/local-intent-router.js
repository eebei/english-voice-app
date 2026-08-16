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
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
  const integer = value => {
    const n = finite(value);
    return n !== null && Number.isInteger(n) ? n : null;
  };
  const formatDuration = (seconds, lang) => {
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return isJP(lang) ? `${h}時間${m ? m + '分' : ''}` : `${h}h${m ? ' ' + m + 'm' : ''}`;
    if (m) return isJP(lang) ? `${m}分${s}秒` : `${m}m ${s}s`;
    return isJP(lang) ? `${s}秒` : `${s}s`;
  };
  const answer = (intent, reply) => reply ? { handled:true, intent, reply } : { handled:false };

  function fuelReply(live, lang) {
    const fs = live && live.fuel_strategy && typeof live.fuel_strategy === 'object'
      ? live.fuel_strategy : {};
    const endurance = fs.endurance_plan || live.endurance_fuel_plan || {};
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

  function route(input) {
    const text = String(input && input.text || '').trim();
    const lang = input && input.lang === 'en' ? 'en' : 'ja';
    const live = input && input.live && typeof input.live === 'object' ? input.live : null;
    if (!text || !live) return { handled:false };

    if (/^(?:了解|了解です|わかった|分かった|オーケー|OK|copy|roger|understood)[。.!！?？]?$/i.test(text)) {
      return answer('acknowledgement', isJP(lang) ? '了解。' : 'Copy.');
    }
    if (/(?:燃料|給油|足りる|リットル|リッター|何(?:リットル|リッター|L)|fuel|lit(?:er|re)|make it)/i.test(text)) {
      return answer('fuel_status', fuelReply(live, lang));
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
    if (/残り.{0,5}(?:周|ラップ)|あと.{0,5}(?:周|ラップ)|何周|laps? (?:left|remaining)/i.test(text)) {
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
    if (/トップ|首位|P1|何秒|ギャップ|差|leader|gap/i.test(text)) {
      const wantsOverall = /総合|GTP|gdp|overall/i.test(text);
      const leader = wantsOverall ? live.leaders && live.leaders.overall : live.leaders && live.leaders.player_class;
      const gap = finite(leader && leader.gap_s);
      return answer('leader_gap', gap !== null
        ? (isJP(lang) ? `${wantsOverall ? '総合首位' : 'クラス首位'}まで${Math.abs(gap).toFixed(1)}秒。` : `${Math.abs(gap).toFixed(1)} seconds to the ${wantsOverall ? 'overall' : 'class'} leader.`)
        : (isJP(lang) ? `${wantsOverall ? '総合首位' : 'クラス首位'}とのGAPは取得できない。直前車のGAPでは代用しない。` : `Gap to the ${wantsOverall ? 'overall' : 'class'} leader is unavailable; I will not substitute the nearest-car gap.`));
    }
    if (/(?:今|現在).{0,6}(?:順位|ポジション)|(?:順位|ポジション).{0,6}(?:何|どこ|いくつ)|current (?:position|place)/i.test(text)) {
      const position = integer(live.player_class_position ?? live.class_position);
      return answer('current_position', position !== null && position > 0
        ? (isJP(lang) ? `現在P${position}。` : `Currently P${position}.`)
        : (isJP(lang) ? '現在順位の権威データがない。' : 'Authoritative current position is unavailable.'));
    }
    return { handled:false };
  }

  return { route, formatDuration };
}));
