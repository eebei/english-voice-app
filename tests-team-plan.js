#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════
// 2026-08-29 — Team Plan の一本の縦穴：
//   ブリーフィング合意 → 実測による小変更候補 → 交代 packet → 受信側 →
//   レース後の構造化結果。
//
// 写経しない：モジュールは実物を require し、renderer 側は本番 HTML から
// 関数を抽出して実行する。外部 API も本番 Team Link Code も使わない。
// ══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const vm = require('vm');
const TP = require('./desktop/team-plan.js');

const html = fs.readFileSync('desktop/renderer.html', 'utf8');
let pass = 0, fail = 0;
function ck(label, ok, detail) {
  (ok ? console.log : console.error)((ok ? '  ✅ ' : '  ❌ ') + label + (ok ? '' : ' -> ' + (detail === undefined ? '' : String(detail))));
  ok ? pass++ : fail++;
}
const NOW = '2026-08-29T01:00:00.000Z';

// ── ① 初期Plan → 2〜3項目確認 → 訂正 → 明示確定 ───────────────────────
console.log('══ ① ブリーフィングの state / revision 遷移 ══');
{
  let s = TP.emptyState();
  ck('確定前の revision は 0', s.revision === 0 && s.confirmed === null);

  const start = TP.startBriefing({ state: s, lang: 'ja', roster: ['八木', 'まーぼ', 'ダート'], now: NOW });
  s = start.state;
  ck('一度に聞くのは2〜3項目', start.questions.length >= 2 && start.questions.length <= 3, start.questions.length);
  ck('ブリーフィングが active', s.briefing.active === true);
  ck('roster を勝手に確定 Plan にしない', s.confirmed === null && s.candidate === null);

  const a1 = TP.ingestHumanInput({ state: s, text: '走行順は八木、まーぼ、ダートで回す', lang: 'ja', now: NOW });
  s = a1.state;
  ck('人の入力は candidate へ入る', !!(s.candidate && s.candidate.fields.driver_order), JSON.stringify(s.candidate));
  ck('candidate 段階では confirmed が生まれない', s.confirmed === null);
  ck('根拠種別は human', s.candidate.fields.driver_order.source === 'human');
  ck('更新時刻を持つ', s.candidate.fields.driver_order.at === NOW);

  const a2 = TP.ingestHumanInput({ state: s, text: '交代は1時間ごと', lang: 'ja', now: NOW });
  s = a2.state;
  ck('次の項目へ進む質問を返す', typeof a2.reply === 'string' && a2.reply.length > 0);

  // 訂正：同じ項目を上書きしても confirmed は動かない
  const fix = TP.ingestHumanInput({ state: s, text: '走行順はまーぼ、八木、ダートに変える', lang: 'ja', now: NOW });
  s = fix.state;
  ck('訂正は candidate を書き換える', /まーぼ、八木/.test(s.candidate.fields.driver_order.value));
  ck('訂正だけでは confirmed にならない', s.confirmed === null);

  const conf = TP.confirmCandidate({ state: s, lang: 'ja', now: NOW });
  s = conf.state;
  ck('明示確定で revision が 1 になる', s.revision === 1 && s.confirmed && s.confirmed.revision === 1, s.revision);
  ck('確定後に candidate は残らない', s.candidate === null);
  ck('未確定項目は「不明」のまま残る', TP.missingFields(s).length > 0, JSON.stringify(TP.missingFields(s)));
  ck('確定を読み返せる', /rev1/.test(TP.describe(s, 'ja')), TP.describe(s, 'ja'));
}

// ── ② 曖昧な「はい」では Plan が変わらない ────────────────────────────
console.log('══ ② 曖昧語で Plan を変えない ══');
{
  ['はい', 'OK', 'ok', 'yes', '了解', 'わかった', 'copy'].forEach(word => {
    ck(`「${word}」は確定にならない`, TP.isExplicitConfirmation(word) === false);
  });
  ['その内容で確定', 'はい、確定', 'プランを確定', 'confirm the plan', "that's confirmed"]
    .forEach(word => ck(`「${word}」は確定`, TP.isExplicitConfirmation(word) === true, word));

  // confirmed 済みの Plan が曖昧語で壊れないこと
  let s = TP.confirmCandidate({
    state: TP.ingestHumanInput({
      state: TP.startBriefing({ state: TP.emptyState(), lang: 'ja', now: NOW }).state,
      text: '走行順は八木から', lang: 'ja', now: NOW
    }).state, lang: 'ja', now: NOW
  }).state;
  const before = JSON.stringify(s.confirmed);

  const ack = TP.ingestHumanInput({ state: s, text: 'はい', lang: 'ja', now: NOW });
  ck('走行中の「はい」で confirmed は不変', JSON.stringify(ack.state.confirmed) === before);
  ck('走行中の「はい」は Plan 入力として扱わない', ack.handled === false);

  const vague = TP.ingestHumanInput({ state: s, text: '違う', lang: 'ja', now: NOW });
  ck('「違う」だけでは confirmed を変えない', JSON.stringify(vague.state.confirmed) === before);
  ck('「違う」には必要情報を短く聞き返す', vague.handled === true && /どこを直す/.test(vague.reply), vague.reply);
  ck('「違う」で candidate を捏造しない', vague.state.candidate === null);

  const chat = TP.ingestHumanInput({ state: s, text: '今日は寒いね', lang: 'ja', now: NOW });
  ck('無関係な会話は Plan 側で扱わない', chat.handled === false && chat.changed === false);
}

// ── ③ 3クリーン周の実測：維持 / 小変更候補 / 確認なしでは変わらない ────
console.log('══ ③ 実測による live authority ══');
{
  const confirmedState = TP.confirmCandidate({
    state: TP.ingestHumanInput({
      state: TP.startBriefing({ state: TP.emptyState(), lang: 'ja', now: NOW }).state,
      text: 'ピットは30周で入る', lang: 'ja', now: NOW
    }).state, lang: 'ja', now: NOW
  }).state;
  ck('Plan にピット周回が入っている',
    !!confirmedState.confirmed.fields.initial_pit_plan, JSON.stringify(confirmedState.confirmed));

  const live = laps => ({
    fuel: 68.4, lap: 12, last: 505.2,
    fuel_strategy: { avg_fuel_per_lap: 6.12, clean_laps_sampled: laps, laps_of_fuel_left: 11.1 },
    strategy_plan: { target_lap: 30, projected_finish_margin_l: 1.8 },
    weather: { track_temp_c: 24.5, air_temp_c: 18.0, track_wetness_code: 1 },
    tire_measurement: { available: false, source: 'unavailable_while_running', session_time_s: null },
    tires: { lf: { wear_min_pct: 71 } },
    damage_s: 0,
    timed_finish_forecast: { driver_avg_lap_s: 505.0 },
    session_time_remaining_s: 7200
  });

  const early = TP.compareLiveEvidence({ state: confirmedState, live: live(2), lang: 'ja' });
  ck('2周では判定しない', early.available === false && early.verdict === 'insufficient_evidence');
  ck('2周では Plan を動かさないと言う', /Planは動かさない/.test(early.reply), early.reply);

  const hold = TP.compareLiveEvidence({ state: confirmedState, live: live(3), lang: 'ja' });
  ck('3周揃えば判定する', hold.available === true);
  ck('実測が Plan と一致していれば「維持」', hold.verdict === 'hold', hold.verdict);
  ck('燃料・燃費・サンプル数を提示', /68\.4L/.test(hold.reply) && /6\.12L/.test(hold.reply) && /クリーン3本/.test(hold.reply), hold.reply);
  ck('pit now を出さない', !/今すぐ|pit now|ボックス/i.test(hold.reply), hold.reply);

  const drifted = live(4); drifted.strategy_plan.target_lap = 34;
  const minor = TP.compareLiveEvidence({ state: confirmedState, live: drifted, lang: 'ja' });
  ck('実測がズレたら小変更候補', minor.verdict === 'minor_change_candidate', minor.verdict);
  ck('変更対象と根拠が構造化されている',
    minor.changes[0].field === 'initial_pit_plan' && minor.changes[0].reason === 'measured_pit_window_differs',
    JSON.stringify(minor.changes));

  const proposed = TP.proposeFromEvidence({ state: confirmedState, comparison: minor, now: NOW }).state;
  ck('確認なしでは confirmed revision が変わらない', proposed.confirmed.revision === confirmedState.confirmed.revision);
  ck('確認なしでは confirmed 本文が変わらない',
    proposed.confirmed.fields.initial_pit_plan.value === confirmedState.confirmed.fields.initial_pit_plan.value);
  ck('候補として保持し、根拠種別を bridge_evidence にする',
    proposed.candidate.fields.initial_pit_plan.source === 'bridge_evidence');
  ck('明示確認で初めて昇格する',
    TP.confirmCandidate({ state: proposed, lang: 'ja', now: NOW }).state.confirmed.revision === 2);

  // 固定ルール（残70%なら交換不要）を持たない
  const evidence = TP.evidenceSnapshot(live(4));
  const review = TP.tyreChangeReview({ evidence, nextStintLaps: null, reviewThresholdPct: 70 });
  ck('材料が揃わないタイヤ判断は保留', review.verdict === 'insufficient_evidence', JSON.stringify(review));
  ck('欠けている材料を名指しする',
    review.missing.includes('four_corner_measurement') && review.missing.includes('next_stint_length'),
    JSON.stringify(review.missing));
}

// ── ④ 欠損値が推測値やゼロに化けない ──────────────────────────────────
console.log('══ ④ 欠損は欠損のまま ══');
{
  const blind = TP.evidenceSnapshot({ lap: 3 });
  ck('燃料未取得は null', blind.fuel_l === null);
  ck('燃費未取得は null（0 にしない）', blind.clean_fuel_burn_l === null);
  ck('平均ラップ未取得は null', blind.avg_lap_s === null);
  ck('天候未取得は null', blind.weather.track_temp_c === null && blind.weather.track_wetness_code === null);
  ck('走行中のタイヤは計測値扱いにしない',
    blind.tires.available === false && Object.keys(blind.tires.corners).length === 0);
  ck('損傷未確認で修理要否を断定しない', blind.damage.repair_required === null);

  const running = TP.evidenceSnapshot({
    tire_measurement: { available: false }, tires: { lf: { wear_min_pct: 88 }, rf: {}, lr: {}, rr: {} }
  });
  ck('走行中はタイヤ4輪値を持ち出さない', Object.keys(running.tires.corners).length === 0);

  const measured = TP.evidenceSnapshot({
    tire_measurement: { available: true, source: 'pit_return', session_time_s: 1820.4 },
    tires: { lf: { wear_min_pct: 71 }, rf: { wear_min_pct: 69 }, lr: { wear_min_pct: 80 }, rr: { wear_min_pct: 78 } }
  });
  ck('ピット計測は4輪そのまま渡す', Object.keys(measured.tires.corners).length === 4);
  ck('計測時刻を持つ', measured.tires.measured_at_session_s === 1820.4);

  const noIncidentData = TP.summarizeStint({
    driver_name: '八木', laps: [{ lap: 1, lap_time_s: 500.1, valid_clean: true }]
  });
  ck('インシデント記録が無ければ 0 と断定しない',
    noIncidentData.incidents === null && noIncidentData.incident_scope === 'unknown', JSON.stringify(noIncidentData));
  ck('周回が無ければ clean_laps も null', TP.summarizeStint({ laps: [] }).clean_laps === null);
}

// ── ⑤ handoff の serialize / 対象 driver / stale / revision / stint ────
console.log('══ ⑤ 交代 packet ══');
{
  let s = TP.confirmCandidate({
    state: TP.ingestHumanInput({
      state: TP.startBriefing({ state: TP.emptyState(), lang: 'ja', now: NOW }).state,
      text: 'ピットは30周で入る', lang: 'ja', now: NOW
    }).state, lang: 'ja', now: NOW
  }).state;
  // 未確認の候補を1つ足しておく（＝これは相手へ確定事項として渡してはいけない）
  s = TP.ingestHumanInput({ state: s, text: '燃料は満タン想定', lang: 'ja', now: NOW }).state;

  const stint = TP.summarizeStint({
    driver_name: '八木', driver_index: 0, start_lap: 1, end_lap: 4,
    laps: [
      { lap: 1, lap_time_s: 512.0, valid_clean: false, incidents: 1, fuel_used_l: 6.2 },
      { lap: 2, lap_time_s: 505.5, valid_clean: true, incidents: 0, fuel_used_l: 6.1 },
      { lap: 3, lap_time_s: 503.9, valid_clean: true, incidents: 0, fuel_used_l: 6.0 }
    ],
    pit_events: [{ entry_lap: 3, repair: false }], plan_revision: 1
  });
  ck('stint summary はベスト/平均/クリーン/燃費/インシデントを持つ',
    stint.best_lap_s === 503.9 && stint.clean_laps === 2 && stint.incidents === 1
    && stint.fuel_burn_l_per_lap !== null && stint.average_lap_s !== null, JSON.stringify(stint));
  ck('インシデントの対象範囲を明示する', stint.incident_scope === 'observed_laps_in_stint');
  ck('pit/repair イベントを持つ', stint.pit_events.length === 1 && stint.repairs === 0);

  const section = TP.buildHandoffTeamSection({
    state: s, evidence: TP.evidenceSnapshot({ fuel: 60.2, fuel_strategy: { avg_fuel_per_lap: 6.1, clean_laps_sampled: 5 } }),
    stintSummary: stint
  });
  const wire = JSON.parse(JSON.stringify(section));   // serialize / deserialize
  ck('confirmed の revision と内容を載せる', wire.plan_revision === 1 && !!wire.plan_fields.initial_pit_plan);
  ck('未確認の候補は確定事項として渡さない',
    !wire.plan_fields.fuel_policy && wire.candidate_pending === true, JSON.stringify(wire.plan_fields));
  ck('実測燃料・clean sample を載せる',
    wire.evidence.fuel_l === 60.2 && wire.evidence.clean_laps_sampled === 5);
  ck('送信ドライバーの stint summary を載せる', wire.stint_summary.driver_name === '八木');

  // 受信側
  let next = TP.emptyState();
  const recv = TP.applyReceivedTeamSection({ state: next, section: wire, lang: 'ja', now: NOW });
  next = recv.state;
  ck('受信側に confirmed Plan が入る', recv.applied === true && next.confirmed.revision === 1);
  ck('受信元を team_handoff として記録', next.confirmed.source === 'team_handoff');
  ck('受信後に短く再確認できる読み上げを返す', /rev1/.test(recv.reply) && /違うなら/.test(recv.reply), recv.reply);

  const stale = TP.applyReceivedTeamSection({ state: next, section: wire, lang: 'ja', now: NOW });
  ck('同一/古い revision は再適用しない', stale.applied === false, stale.reply);
  ck('stale 拒否で手元の Plan が壊れない', stale.state.confirmed.revision === 1);

  const junk = TP.applyReceivedTeamSection({ state: next, section: { schema: 'nope' }, lang: 'ja', now: NOW });
  ck('未知スキーマの packet を適用しない', junk.applied === false);

  const candidateOnly = TP.buildHandoffTeamSection({ state: TP.emptyState() });
  ck('確定 Plan が無ければ plan_status=none', candidateOnly.plan_status === 'none' && candidateOnly.plan_revision === null);
  ck('未確定 packet は受信側で適用されない',
    TP.applyReceivedTeamSection({ state: TP.emptyState(), section: candidateOnly, lang: 'ja', now: NOW }).applied === false);
}

// ── ⑥ renderer 配線：入口から出口まで実際に繋がっているか ─────────────
console.log('══ ⑥ renderer 配線（片側だけで終わっていないこと） ══');
{
  ck('team-plan.js を読み込む', /<script src="team-plan\.js"><\/script>/.test(html));
  ck('確定 Plan を再起動後も残す', /'pw_team_plan_v1'/.test(html));
  ck('発話入口が LLM より前で Team Plan を受ける',
    /handleTeamPlanUtterance\(text\)\)\{[\s\S]{0,120}return;/.test(html));
  ck('telemetry から実測評価を呼ぶ', /evaluateTeamPlanLiveEvidence\(lastTelemetry\)/.test(html));
  ck('telemetry からスティントを集計する', /captureTeamStintLap\(lastTelemetry\)/.test(html));
  ck('交代時に team section を作って送信する',
    /const teamSection=buildTeamHandoffSection\(\);[\s\S]{0,200}publishChiefTeamHandoff\(outgoingPacket\)/.test(html));
  ck('交代先へ送る packet と手元 radio が同じ内容',
    /injectRadio\(\{type:'radio',trigger:'chief_engineer_handoff',packet:outgoingPacket\}\)/.test(html));
  ck('受信側で確定 Plan を適用する', /applyReceivedTeamPlan\(packet\.team_plan\)/.test(html));
  ck('受信は対象ドライバー照合の後にだけ起きる',
    html.indexOf('packet.next_driver_index!==cfg.this_driver_index') < html.indexOf('applyReceivedTeamPlan(packet.team_plan)'));
  ck('レース終了時に構造化結果を保存する', /persistTeamRaceLearning\(data\)/.test(html));
  ck('デブリーフ回答が構造化ソースから出る', /function teamStintResultAnswer\(/.test(html));

  // 本番の handleTeamPlanUtterance を抽出して実挙動を見る
  const grab = name => {
    const i = html.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const rest = html.slice(i);
    const end = rest.slice(1).search(/\n(?:async function |function |const |let |\/\/ |\/\/─)/);
    return rest.slice(0, end > 0 ? end + 1 : rest.length);
  };
  const store = {};
  const spoken = [];
  const box = {
    console, JSON, Number, String, Math, Date, RegExp, Object, Array,
    window: { PitwallTeamPlan: TP },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    persistentSet: (k, v) => { store[k] = String(v); },
    diagnosticLog: () => {},
    addMsg: () => {}, pushMsg: () => {},
    speak: (text) => spoken.push(text),
    SPEAK_PRIO: { P4_INFO: 4, P2_PROCEDURE: 2 },
    sel: 'LunaJP',
    chiefEngineerSettings: () => ({ enabled: true, roster: ['八木', 'まーぼ', 'ダート'], current_index: 0, this_driver_index: 1, team_code: 'TEST-FIXTURE-CODE' }),
    chiefShareStatus: () => {},
    lastTelemetry: null
  };
  box.window.localStorage = box.localStorage;
  vm.createContext(box);
  const code = ['teamModeActive', 'teamPlanModule', 'loadTeamPlanState', 'saveTeamPlanState', 'teamPlanLang',
    'teamPlanSay', 'handleTeamPlanUtterance', 'evaluateTeamPlanLiveEvidence', 'captureTeamStintLap',
    'currentTeamStintSummary', 'resetTeamStint', 'buildTeamHandoffSection', 'applyReceivedTeamPlan',
    'loadTeamRaceLearning', 'persistTeamRaceLearning', 'teamStintResultAnswer'].map(grab).join('\n');
  ck('本番関数を全部抽出できた', code.split('function ').length - 1 >= 15, code.split('function ').length - 1);
  vm.runInContext('const TEAM_PLAN_KEY="pw_team_plan_v1";const TEAM_RACE_LEARNING_KEY="pw_team_race_learning_v1";'
    + 'let teamPlanEvidenceAnnounced=false;let teamStintLaps=[],teamStintPitEvents=[],teamStintStartLap=null,teamStintLastLap=null;'
    + 'let teamRaceStints=[];\n' + code, box);

  ck('本番導線：ブリーフィング開始を受ける', box.handleTeamPlanUtterance('作戦会議を開始') === true);
  ck('本番導線：質問を読み上げる', spoken.length === 1 && /走行順/.test(spoken[0]), spoken[0]);
  ck('本番導線：回答が candidate へ入る', box.handleTeamPlanUtterance('走行順は八木から') === true);
  const midState = TP.normalize(JSON.parse(store['pw_team_plan_v1']));
  ck('本番導線：確定前は revision 0', midState.revision === 0 && !!midState.candidate);
  const beforeAck = store['pw_team_plan_v1'];
  box.handleTeamPlanUtterance('はい');
  ck('本番導線：相槌では Plan の中身が変わらない', store['pw_team_plan_v1'] === beforeAck);
  ck('本番導線：事実質問は Team Plan が飲まない', box.handleTeamPlanUtterance('燃料あと何リットル？') === false);
  ck('本番導線：明示確定を受ける', box.handleTeamPlanUtterance('その内容で確定') === true);
  const confirmedStore = TP.normalize(JSON.parse(store['pw_team_plan_v1']));
  ck('本番導線：confirmed rev1 が保存される', confirmedStore.revision === 1 && confirmedStore.confirmed.revision === 1);

  // 実測 → 交代 → レース後
  const live = {
    lap: 5, last: 503.2, fuel: 61.0, lap_valid_clean: true, incidents_this_lap: 0,
    fuel_strategy: { avg_fuel_per_lap: 6.05, clean_laps_sampled: 3 },
    strategy_plan: { target_lap: 30 }, weather: { track_temp_c: 25 },
    tire_measurement: { available: false }, damage_s: 0
  };
  box.lastTelemetry = live;
  const cmp = box.evaluateTeamPlanLiveEvidence(live);
  ck('本番導線：3周で実測が読み上げられる', cmp && cmp.available === true && spoken.length >= 4, JSON.stringify(cmp && cmp.verdict));
  ck('本番導線：実測だけで confirmed は変わらない',
    TP.normalize(JSON.parse(store['pw_team_plan_v1'])).confirmed.revision === 1);

  box.captureTeamStintLap(live);
  box.captureTeamStintLap(Object.assign({}, live, { lap: 6, last: 502.8 }));
  const section = box.buildTeamHandoffSection();
  ck('本番導線：交代 section に confirmed rev が載る', section.plan_revision === 1);
  ck('本番導線：交代 section に stint summary が載る',
    !!section.stint_summary && section.stint_summary.driver_name === '八木', JSON.stringify(section.stint_summary));
  ck('本番導線：交代 section に実測が載る', section.evidence && section.evidence.clean_laps_sampled === 3);

  // 受信側 PC を別 store で再現
  const store2 = {};
  box.localStorage.getItem = k => (k in store2 ? store2[k] : null);
  box.localStorage.setItem = (k, v) => { store2[k] = String(v); };
  box.persistentSet = (k, v) => { store2[k] = String(v); };
  const appliedOk = box.applyReceivedTeamPlan(JSON.parse(JSON.stringify(section)));
  ck('本番導線：受信側 PC に確定 Plan が入る', appliedOk === true
    && TP.normalize(JSON.parse(store2['pw_team_plan_v1'])).confirmed.revision === 1);
  ck('本番導線：受信側で再確認の発話が出る', /rev1/.test(spoken[spoken.length - 1]), spoken[spoken.length - 1]);
  ck('本番導線：同じ packet の再受信は適用しない',
    box.applyReceivedTeamPlan(JSON.parse(JSON.stringify(section))) === false);

  // Chief Engineer Mode を切った単独走行：Team Plan は一切作動しない。
  box.chiefEngineerSettings = () => ({ enabled: false, roster: [], current_index: 0, this_driver_index: 0, team_code: '' });
  const soloBefore = JSON.stringify(store2);
  ck('単独走行：ブリーフィング開始を横取りしない', box.handleTeamPlanUtterance('作戦会議を開始') === false);
  ck('単独走行：確定語も横取りしない', box.handleTeamPlanUtterance('その内容で確定') === false);
  ck('単独走行：実測評価を出さない', box.evaluateTeamPlanLiveEvidence(live) === null);
  ck('単独走行：交代 section を作らない', box.buildTeamHandoffSection() === null);
  ck('単独走行：レース後保存をしない', box.persistTeamRaceLearning({ is_race: true }) === null);
  box.captureTeamStintLap(Object.assign({}, live, { lap: 40 }));
  ck('単独走行：保存領域を一切触らない', JSON.stringify(store2) === soloBefore);
}

// ── ⑥-b Chief Engineer Mode が実行面であること／単独走行を壊さないこと ──
console.log('══ ⑥-b Chief Engineer Mode 前提 ══');
{
  ck('Chief の roster / 現在担当から stint identity を取る',
    /chiefEngineerSettings\(\);[\s\S]{0,200}driver_name:cfg\.roster\[cfg\.current_index\]/.test(html));
  ck('Chief の relay へ team_plan を載せて送る',
    /publishChiefTeamHandoff\(outgoingPacket\)/.test(html));
  ck('受信は Chief の share status（次 Driver の UI）へ出る',
    /chiefShareStatus\(r\.reply\)/.test(html));
  ck('Chief が無効な単独走行では Team Plan を作動させない',
    /function teamModeActive\(\)\{[\s\S]{0,220}cfg\.enabled===true && cfg\.roster\.length>=2/.test(html));
  ['handleTeamPlanUtterance', 'evaluateTeamPlanLiveEvidence', 'captureTeamStintLap',
    'persistTeamRaceLearning', 'buildTeamHandoffSection'].forEach(fn => {
    const body = html.slice(html.indexOf('function ' + fn + '('), html.indexOf('function ' + fn + '(') + 260);
    ck('  ' + fn + ' が Chief 無効時に早期 return する', /!teamModeActive\(\)/.test(body), body.slice(0, 120));
  });
}

// ── ⑦ レース後：確定した構造化ソースから答える ────────────────────────
console.log('══ ⑦ レース後の学習データと確定回答 ══');
{
  const s = TP.confirmCandidate({
    state: TP.ingestHumanInput({
      state: TP.startBriefing({ state: TP.emptyState(), lang: 'ja', now: NOW }).state,
      text: 'ピットは30周で入る', lang: 'ja', now: NOW
    }).state, lang: 'ja', now: NOW
  }).state;
  const stints = [
    TP.summarizeStint({
      driver_name: '八木', driver_index: 0, laps: [
        { lap: 1, lap_time_s: 505.0, valid_clean: true, incidents: 0, fuel_used_l: 6.1 },
        { lap: 2, lap_time_s: 503.0, valid_clean: true, incidents: 1, fuel_used_l: 6.0 }],
      pit_events: [{ entry_lap: 33, repair: false }]
    }),
    TP.summarizeStint({ driver_name: 'まーぼ', driver_index: 1, laps: [{ lap: 34, lap_time_s: 508.0, valid_clean: true }] })
  ];
  const entry = TP.buildRaceLearning({ state: s, stints, result: { track: 'Nurburgring Nordschleife', is_race: true }, now: NOW });
  ck('driver 別の記録を持つ', entry.stints.length === 2 && entry.stints[0].driver_name === '八木');
  ck('確定 Plan と実際の差分を持つ',
    entry.plan_vs_actual.planned_first_pit_lap === 30 && entry.plan_vs_actual.first_pit_delta_laps === 3,
    JSON.stringify(entry.plan_vs_actual));
  ck('レース識別（track / is_race）を持つ', entry.track === 'Nurburgring Nordschleife' && entry.is_race === true);

  const answer = TP.answerFromRaceLearning({ entry, driverName: '八木', lang: 'ja' });
  ck('ベスト/平均/クリーンを確定値で答える',
    /503\.000秒/.test(answer) && /クリーン2本/.test(answer), answer);
  ck('インシデントの対象範囲を添える', /observed_laps_in_stint/.test(answer), answer);

  const unknownScope = TP.answerFromRaceLearning({
    entry: { stints: [TP.summarizeStint({ driver_name: 'ダート', laps: [{ lap: 1, lap_time_s: 500 }] })] },
    driverName: 'ダート', lang: 'ja'
  });
  ck('インシデント未記録なら 0 と断定しない',
    /記録範囲外/.test(unknownScope) && !/インシデント0/.test(unknownScope), unknownScope);

  const missing = TP.answerFromRaceLearning({ entry, driverName: '知らない人', lang: 'ja' });
  ck('記録の無いドライバーは推測しない', /推測では答えない/.test(missing), missing);
}

// ── ⑧ 本番 Team Link Code / 外部 API を使っていない ──────────────────
console.log('══ ⑧ 禁止事項 ══');
{
  // 本番 Link Code は文字列としても置かない。分割して照合する。
  const PROD_CODE = ['109876', 'PW', 'NUR4', '8Q7K'].join('-');
  const self = fs.readFileSync('tests-team-plan.js', 'utf8');
  const fixtures = self.split('const PROD_CODE')[0];
  ck('本番 Team Link Code を fixture に使っていない', !fixtures.includes(PROD_CODE));
  ck('モジュールに本番 Link Code を埋めていない',
    !fs.readFileSync('desktop/team-plan.js', 'utf8').includes(PROD_CODE));
  ck('テストは外部 API を呼ばない', !/\bfetch\(/.test(self) && !/require\('https?'\)/.test(self));
}

console.log(`\n[team plan] 合格 ${pass} / 不合格 ${fail}`);
process.exit(fail ? 1 : 0);
