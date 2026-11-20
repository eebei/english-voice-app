'use strict';
// レース設定（Owner/Driver設定）：給油回数と燃料余裕（周数）。出所付きで保持し、実計算とLUNAの文脈へ渡す。
//   監督 2026-11-18：「60分以内のショート耐久・給油1回」をOwner指定の設定として保持する。全レースへ固定値を埋め込まない：
//     ・観測したレース形式（時間制／制限時間）が設定の範囲に入る時だけ適用する（範囲外・形式未確認は適用せず、そう伝える）
//     ・Driverは確認・訂正できる（訂正はそのレース限り。別raceへ持ち越さない）
//   「給油回数」は**給油を確認したピット**の回数（ピット進入・ドライブスルー・入口ノイズでは消費しない）。
//   燃料余裕は周数で持つ（既定1周分、Driverが0.5周分へ変更可）。Lへは燃費で換算する。
(function (root) {
  const OWNER_SHORT_ENDURANCE = Object.freeze({
    id: 'owner_short_endurance_1_refuel', max_duration_s: 3600, refuels_required: 1, source: 'owner_directive',
    note: 'Owner指定(2026-11-17)：60分以内のショート耐久・給油1回', set_on: '2026-11-17',
  });
  const MARGIN_DEFAULT_LAPS = 1.0;            // 監督既定（Ownerの希望は1周分、攻める時0.5周分も許容）。Ownerの0.5周既定承認ではない
  const MARGIN_ALLOWED_LAPS = Object.freeze([0.5, 1.0, 1.5, 2.0]);
  const fin = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

  // 設定がレースに適用されるか。overrideはDriverのそのレース限りの訂正。
  function resolve(input) {
    const i = input || {}, rule = i.rule === undefined ? OWNER_SHORT_ENDURANCE : i.rule, plan = i.race_plan || {};
    const fo = i.format_override && typeof i.format_override === 'object' ? i.format_override : null;   // Driverの明示的な形式訂正（そのレース限り）
    const kind = fo ? fo.kind : (plan.kind || null), dur = fo ? fin(fo.duration_s) : fin(plan.configured_duration_s);
    const base = { kind, duration_s: dur, format_source: fo ? 'driver_correction' : null };
    if (i.override && Number.isInteger(i.override.refuels_required) && i.override.refuels_required >= 0) {
      return Object.assign(base, { applies: true, refuels_required: i.override.refuels_required, source: 'driver_correction', rule_id: rule ? rule.id : null, reason: null });
    }
    if (!rule) return Object.assign(base, { applies: false, refuels_required: null, source: null, rule_id: null, reason: 'no_rule' });
    if (kind === null || (kind === 'timed' && dur === null)) return Object.assign(base, { applies: false, refuels_required: null, source: rule.source, rule_id: rule.id, reason: 'race_format_unconfirmed' });
    if (kind === 'timed' && dur <= rule.max_duration_s) return Object.assign(base, { applies: true, refuels_required: rule.refuels_required, source: rule.source, rule_id: rule.id, reason: null });
    return Object.assign(base, { applies: false, refuels_required: null, source: rule.source, rule_id: rule.id, reason: 'outside_rule_scope' });
  }
  const mins = s => Math.round(s / 60);
  // Driverへの確認文（結論から短く）。done＝給油を確認したピットの回数。
  function sentence(res, done, lang) {
    const jp = lang !== 'en', d = Number.isInteger(done) ? done : 0;
    if (!res) return '';
    const fmt = res.kind === 'timed' && res.duration_s ? (jp ? `${mins(res.duration_s)}分のタイムレース${res.format_source === 'driver_correction' ? '、あなたの訂正' : ''}` : `${mins(res.duration_s)}-minute timed race`) : null;
    if (res.applies) {
      const src = res.source === 'driver_correction' ? (jp ? 'あなたの訂正' : 'your correction') : (jp ? 'Owner設定' : 'owner setting');
      return jp ? `給油は${res.refuels_required}回の設定（${src}${fmt ? '、' + fmt : ''}）。済んだのは${d}回。違えば言って。` : `Refuel is set to ${res.refuels_required} (${src}${fmt ? ', ' + fmt : ''}). ${d} done so far. Tell me if that is wrong.`;
    }
    if (res.reason === 'race_format_unconfirmed') return jp ? 'レース形式がまだ確認できていないので、給油回数の設定は使っていない。回数を言ってくれれば、それで見る。' : 'The race format is not confirmed yet, so I am not using a refuel count. Tell me the count and I will use it.';
    if (res.reason === 'outside_rule_scope') return jp ? `このレースは60分以内のショート耐久ではないので、給油1回の設定は使っていない。回数を言ってくれれば、それで見る。` : 'This is not a short endurance race of 60 minutes or less, so the one-refuel setting is not applied. Tell me the count and I will use it.';
    return jp ? '給油回数の設定は無い。回数を言ってくれれば、それで見る。' : 'No refuel count is set. Tell me and I will use it.';
  }
  // 発話の解釈：Driverが「合計の給油回数」を言い直した発話（「給油は2回」「ピットは1回でいい」「給油なし」）。
  //   監督/Owner 2026-11-19：**会話から給油回数だけを抽出して、レース設定を上書きしない**。序数（「次のピットは2回目」）・残り（「あと2回入る」）・過去の話は対象外。
  //   戻り値は「言われた回数」だけ（設定は変えない）。レース形式そのものの訂正は、明示的な形式訂正として別に検証してから適用する（未実装）。
  const KANJI = { '一': 1, '二': 2, '三': 3 };
  function parseRefuelStatement(text) {
    const t = String(text || '');
    if (!/給油|ピット(?:ストップ)?|補給/.test(t)) return null;
    if (/[?？]|何回|いくつ|どうなって|教えて/.test(t)) return null;   // 質問は対象にしない
    if (/前回|昨日|昨夜|先週|さっき|過去|だった|でした|しました|入った|記録|履歴/.test(t)) return null;   // 過去のレースの話
    if (/回目|[0-9０-９一二三]\s*回\s*目|(?:あと|もう|残り|さらに|追加で?|まだ|次の|最初の|最後の)\s*[0-9０-９一二三]\s*回|[0-9０-９一二三]\s*回\s*(?:しか|だけ|まで)(?:入れ|入る|ある|残)/.test(t)) return null;   // 序数・残り回数は合計の言い直しではない
    const m = t.match(/(?:給油|補給|ピット(?:ストップ)?)[^。、0-9０-９一二三ゼロぜろ]{0,6}([0-9０-９]|一|二|三)\s*回/);
    if (m) { const v = /[0-9]/.test(m[1]) ? Number(m[1]) : (/[０-９]/.test(m[1]) ? m[1].charCodeAt(0) - 0xFF10 : KANJI[m[1]]); if (Number.isInteger(v) && v >= 0 && v <= 5) return { refuels_stated: v }; }
    if (/(?:給油|補給)[^。、]{0,4}(?:なし|無し|不要|いらない|しない|ゼロ)|ノーピット|ノーストップ/.test(t)) return { refuels_stated: 0 };
    return null;
  }
  // 言い直された回数への返答：設定は変えない。形式と矛盾する時は、そのことと、足りない時の扱いを伝える。
  function statementReply(res, stated, done, lang) {
    const jp = lang !== 'en';
    if (!res || !res.applies) return jp ? `給油回数の設定は、会話の言い直しでは変えない。${sentence(res, done, lang)}` : `The refuel setting is not changed by conversation. ${sentence(res, done, lang)}`;
    const req = res.refuels_required;
    if (stated === req) return jp ? `給油${req}回の設定どおり。済んだのは${done}回。` : `That matches the ${req}-refuel setting. ${done} done.`;
    return jp ? `このレースは給油${req}回の設定のまま、言い直しでは変えない。足りない時は、不足量と追加の停止が要る条件を伝える。` : `This race stays at ${req} refuel(s); restating does not change it. If fuel runs short I will give the shortfall and the conditions for another stop.`;
  }
  // レース形式の明示訂正：「このレースは45分のタイムレース」「今回は周回レース」。
  //   採用するのは「このレース／今回」と「N分＋形式語」が同じ節にある断定だけ。質問・過去・否定・残り時間・確認文・予選/練習などは採用しない（Build 310 検査R-B310-1）。
  //   形式だけを変える。給油回数の設定そのものは会話で変えない。
  const FMT_SUBJECT = '(?:このレース|今回(?:の)?(?:レース|セッション)?|今日(?:の)?レース|今(?:の)?レース|このセッション)';
  const FMT_EXCLUDE = /[?？]|何分|何周|どれ|教えて|かな|だっけ|前回|昨日|昨夜|先週|さっき|過去|だった|でした|記録|履歴|残り|あと|まだ|終わ|じゃ?ない|ではない|でない|じゃなく|ではなく|違う|違って|ちがう|合って|あってる|もたせ|もつ|走った|走る|前に|予選|プラクティス|練習|フリー|ウォーム|[0-9０-９]\s*回|周回数|何度/;
  function parseFormatStatement(text) {
    const t = String(text || '').replace(/(?:給油|補給|ピット(?:ストップ)?)[^。、]{0,6}[0-9０-９一二三]\s*回[^。、]*/g, '');   // 同じ発話の給油回数の部分は形式の判定から外す（回数は別に扱う）
    if (FMT_EXCLUDE.test(t)) return null;
    const m = t.match(new RegExp(FMT_SUBJECT + '(?:は|って|が|も)?[^。、0-9０-９]{0,3}(?<![0-9０-９.])([0-9０-９]{1,3})\\s*分(?:間)?(?:の)?(?:タイム)?(?:レース|耐久|スプリント)'));
    if (m) {
      const v = Number(m[1].replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xFF10)));
      if (Number.isFinite(v) && v >= 5 && v <= 1440) return { kind: 'timed', duration_s: v * 60 };
      return null;
    }
    if (new RegExp(FMT_SUBJECT + '(?:は|って|が)?[^。、]{0,3}(?:周回(?:数)?(?:の)?レース|ラップレース|周回制)').test(t)) return { kind: 'laps', duration_s: null };
    return null;
  }
  // 観測した形式と食い違うか（食い違う訂正は、採用の前に一度確認する）。観測が不明なら食い違いではない。
  function observedFormat(plan) {
    const p = plan || {}, dur = fin(p.configured_duration_s);
    if (p.kind === 'timed' && dur !== null) return { kind: 'timed', duration_s: dur };
    if (p.kind && p.kind !== 'timed') return { kind: 'laps', duration_s: null };
    return null;
  }
  function formatConflicts(plan, fo) {
    const ob = observedFormat(plan);
    if (!ob || !fo) return false;
    if (ob.kind !== fo.kind) return true;
    return ob.kind === 'timed' && Math.abs(ob.duration_s - fo.duration_s) > 120;
  }
  function formatName(f, lang) {
    const jp = lang !== 'en';
    if (!f) return jp ? '形式不明' : 'unknown format';
    if (f.kind === 'timed') { const m = mins(f.duration_s); const lbl = m >= 60 && m % 60 === 0 ? (m / 60) + '時間' : m + '分'; return jp ? lbl + 'のタイムレース' : m + '-minute timed race'; }
    return jp ? '周回レース' : 'lap race';
  }
  function formatConfirmQuestion(plan, fo, lang) {
    const jp = lang !== 'en';
    return jp ? `観測では${formatName(observedFormat(plan), lang)}。${formatName(fo, lang)}として見る？` : `Observed: ${formatName(observedFormat(plan), lang)}. Treat it as ${formatName(fo, lang)}?`;
  }
  // 確認への返答（直前の確認質問への「はい／いいえ」だけ）。
  function parseConfirmation(text) {
    const t = String(text || '').trim();
    if (/^(?:いや|いえ|違う|ちがう|だめ|やめ|そのまま|観測のまま)|(?:しない|やめて|違う|いらない)/.test(t)) return 'no';
    if (/^(?:はい|うん|そう|そうして|それで|お願い|OK|オーケー|ok|頼む|見て)/.test(t)) return 'yes';
    return null;
  }
  // 「今のレース形式は？」への読み戻し（形式の出所を添える）。
  function isFormatQuestion(text) {
    const t = String(text || '');
    if (/前回|昨日|昨夜|先週|さっき|過去|だった|記録|履歴/.test(t)) return false;
    return /(?:レース)?形式|何分(?:の)?レース|何分(?:の)?(?:耐久|スプリント)|どんなレース|何周(?:の)?レース/.test(t) && /[?？]|教えて|何|どう/.test(t);
  }
  function formatReadback(res, lang) {
    const jp = lang !== 'en';
    if (!res || !res.kind) return jp ? 'レース形式はまだ確認できていない。' : 'The race format is not confirmed yet.';
    const f = { kind: res.kind === 'timed' ? 'timed' : 'laps', duration_s: res.duration_s };
    const src = res.format_source === 'driver_correction' ? (jp ? '、あなたの訂正' : ', your correction') : (jp ? '、観測' : ', observed');
    return jp ? `今は${formatName(f, lang)}${src}。` : `Now: ${formatName(f, lang)}${src}.`;
  }
  function formatReply(res, fo, done, lang) {
    const jp = lang !== 'en';
    if (!fo) return '';
    const what = formatName(fo, lang);
    const lead = jp ? `了解、このレースは${what}として見る。` : `Copy, treating this as a ${what}.`;
    return lead + sentence(res, done, lang);
  }
  function isRefuelCountQuestion(text) {
    const t = String(text || '');
    if (/前回|昨日|昨夜|先週|さっき|過去|した[？?。\s]*$|しました|ゴール|何位|だった|でした|入った|記録|履歴/.test(t)) return false;   // 過去のレースの質問（「何回ピットで何位でゴールした？」）は設定の確認ではない
    const about = /(?:給油|補給|ピットストップ|ピット)[^。]{0,8}(?:何回|いくつ|設定|ルール)|(?:何回|いくつ)[^。]{0,6}(?:給油|補給|ピット)/.test(t);
    return about && /設定|ルール|予定|必要|義務|このレース|今回|今日|(?:給油|ピット|補給)(?:は|って)何回[？?]?$/.test(t);
  }
  // 燃料余裕（周数）。Driverの訂正：「余裕は半周」「0.5周でいい」「1周分」。
  function parseMarginCorrection(text) {
    const t = String(text || '');
    if (!/余裕|マージン|予備/.test(t)) return null;
    if (/[?？]|どのくらい|いくつ|何周|教えて/.test(t)) return null;
    const NUM = '(?<![0-9０-９.])';   // 「12周」を「2周」と読まない（前に数字・小数点が付く場合は別の数）
    if (/半周|はんしゅう/.test(t) || new RegExp(NUM + '0?\\.5\\s*周').test(t) || /ゼロ?点?五\s*周/.test(t)) return { laps: 0.5 };
    if (new RegExp(NUM + '1\\.5\\s*周').test(t) || /一周半/.test(t)) return { laps: 1.5 };
    if (new RegExp(NUM + '2\\s*周').test(t) || /二周/.test(t)) return { laps: 2.0 };
    if (new RegExp(NUM + '1\\s*周').test(t) || /一周|いっしゅう/.test(t)) return { laps: 1.0 };
    return null;
  }
  function marginLaps(policy) {
    const v = policy && fin(policy.laps);
    return v !== null && MARGIN_ALLOWED_LAPS.includes(v) ? v : MARGIN_DEFAULT_LAPS;
  }
  // 余裕(L)＝周数×1周の燃費。燃費が分からなければ null（Lへ換算しない）。
  function marginLiters(policy, burnPerLap) {
    const b = fin(burnPerLap);
    return b !== null && b > 0 ? Math.round(marginLaps(policy) * b * 100) / 100 : null;
  }
  const api = { OWNER_SHORT_ENDURANCE, MARGIN_DEFAULT_LAPS, MARGIN_ALLOWED_LAPS, resolve, sentence, parseRefuelStatement, statementReply, parseFormatStatement, formatReply, formatConflicts, formatConfirmQuestion, parseConfirmation, isFormatQuestion, formatReadback, observedFormat, isRefuelCountQuestion, parseMarginCorrection, marginLaps, marginLiters };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallRaceRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
