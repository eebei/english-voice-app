#!/usr/bin/env node
'use strict';

// 提案（strategy-playbook.evaluateSwitch が話す Plan B/C）と、
// 合意の唯一の正本（session-strategy-state.pit_plan）が食い違っていた欠陥への
// 修正確認。共有MD 2026-09-13「Codex：no-refusal案の深掘り」より:
//
//   「問うべきは、合意中のpit案を変える必要が出た場合、どの経路が責任を持って
//    Driverへ変更を伝えるか」
//
// 実態：evaluateLiveStrategySwitch() が「Plan B、アンダーカット候補」と発話しても
// pit_plan は一切更新されず、直後に driver が裸の「はい」を返しても
// agreePitPlan を通らないためただの相槌として消えていた。次に「何周目にピット？」
// と聞くと answerPitDecision は「まだ決めていない」に戻る＝言ったことと state が
// 食い違う。一方 8/29 の教訓（裸の「はい」は確定にならない）は維持する必要がある
// ため、pending_proposal という短命の記録を挟み、その有効期限内の応答だけを
// 合意へ昇格させる。
//
// ★このテストは実 session-strategy-state.js と実 local-intent-router.js の
//   製品コードを require して実行する。API単体呼出しの検査に留めない。

const path = require('path');
const fs = require('fs');
const vm = require('vm');

// ★2026-09-13 Codex独立確認で増分①は差戻し（共有MD「Codex独立確認：提案→合意
//   増分①は差戻し」）。以下4点の再現テストをここへ追加した：
//   P1 古い保留提案が訂正・取消・pit実行後・別の直接合意でも合意されてしまう
//   P1 pit_executedがpit_planより優先され、実行後の新しい合意を答えられない
//   P1 proposePlanがspeak()のqueue登録直後に発火し、実際に耳へ届いたかを見ない
//   P2 「はい」単体がどの分岐にも無くhandled:falseだった

let pass = 0;
const failures = [];
function check(group, name, ok, detail) {
  if (ok) { pass++; return true; }
  failures.push(`[${group}] ${name}` + (detail ? '\n       ' + detail : ''));
  return false;
}

const S = require(path.join(__dirname, 'desktop/session-strategy-state.js'));
const router = require(path.join(__dirname, 'desktop/local-intent-router.js'));

// ════════════════════════════════════════════════════════════════════
// ① session-strategy-state.js: propose / pendingProposal / resolvePendingProposal
// ════════════════════════════════════════════════════════════════════
{
  const G = '①state';

  // 提案しただけでは pit_plan は動かない（提案は合意ではない）。
  {
    const st = S.create({ session_key: 'k1' });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: 1000, decision_id: 'd1', basis: 'undercut' });
    check(G, '提案直後は pit_plan が未確定のまま', S.pitPlan(st) === null,
      JSON.stringify(S.pitPlan(st)));
    check(G, '提案は pendingProposal で読み戻せる',
      !!S.pendingProposal(st, { at: 1000 }) && S.pendingProposal(st, { at: 1000 }).lap === 14);
  }

  // 期限内に accepted=true → pit_plan へ昇格。source は 'engineer'、plan_id を保持。
  {
    const st = S.create({ session_key: 'k2' });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: 1000, decision_id: 'd1', basis: 'undercut' });
    const resolved = S.resolvePendingProposal(st, { accepted: true, at: 1500 });
    check(G, '期限内の合意で resolved.accepted===true', resolved && resolved.accepted === true);
    check(G, '期限内の合意で pit_plan が確定する',
      S.pitPlan(st) && S.pitPlan(st).lap === 14 && S.pitPlan(st).source === 'engineer',
      JSON.stringify(S.pitPlan(st)));
    check(G, 'pit_plan に plan_id が引き継がれる', S.pitPlan(st).plan_id === 'B');
    check(G, '合意後は pending_proposal が消える', S.pendingProposal(st, { at: 1500 }) === null);
  }

  // 期限切れ（TTL=90秒超）なら resolvePendingProposal は null を返し、何も確定しない。
  {
    const st = S.create({ session_key: 'k3' });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: 1000, decision_id: 'd1', basis: 'undercut' });
    const resolved = S.resolvePendingProposal(st, { accepted: true, at: 1000 + 91 * 1000 });
    check(G, '期限切れの提案は resolvePendingProposal が null', resolved === null);
    check(G, '期限切れなら pit_plan は確定しない', S.pitPlan(st) === null);
  }

  // 明示的な否定（accepted=false）→ pending_proposal は消えるが pit_plan は動かない。
  {
    const st = S.create({ session_key: 'k4' });
    S.proposePlan(st, { plan_id: 'C', lap: 20, at: 1000, decision_id: 'd2', basis: 'overcut' });
    const resolved = S.resolvePendingProposal(st, { accepted: false, at: 1200 });
    check(G, '否定で resolved.accepted===false', resolved && resolved.accepted === false);
    check(G, '否定では pit_plan が確定しない', S.pitPlan(st) === null);
    check(G, '否定後は pending_proposal が消える', S.pendingProposal(st, { at: 1200 }) === null);
  }

  // 提案が無い状態での resolvePendingProposal は null（8/29 原則：裸のはいは確定にならない）。
  {
    const st = S.create({ session_key: 'k5' });
    const resolved = S.resolvePendingProposal(st, { accepted: true, at: 1000 });
    check(G, '提案が無ければ resolvePendingProposal は null', resolved === null);
  }

  // 既存の agreePitPlan は plan_id 無しでも従来どおり動く（後方互換）。
  {
    const st = S.create({ session_key: 'k6' });
    S.agreePitPlan(st, { lap: 12, source: 'driver', at: 1000 });
    check(G, '既存 agreePitPlan は plan_id 無しでも動く（回帰）',
      S.pitPlan(st) && S.pitPlan(st).lap === 12 && S.pitPlan(st).plan_id === null,
      JSON.stringify(S.pitPlan(st)));
  }
}

// ════════════════════════════════════════════════════════════════════
// ② local-intent-router.js: 裸の「はい／いや」が pending_proposal と接続する
// ════════════════════════════════════════════════════════════════════
{
  const G = '②router';

  // 提案直後の「了解」→ 具体的な周でのピット合意になり、pit_plan が確定する。
  // ★router内部は Date.now() で期限判定するため、テストの提案時刻も現在時刻基準にする
  //   （state直接呼出しの①と違い、②は製品経路＝実時計を通す）。
  {
    const st = S.create({ session_key: 'r1' });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: Date.now(), decision_id: 'd1', basis: 'undercut' });
    const r = router.route({ text: '了解', lang: 'ja', live: {},
      strategy: { state: st, api: S } });
    check(G, '提案後の「了解」が handled', r && r.handled === true, JSON.stringify(r));
    check(G, '提案後の「了解」は具体的な周を復唱する', r && /14周目/.test(String(r.reply || '')),
      JSON.stringify(r));
    check(G, '提案後の「了解」で pit_plan が確定する（製品経路）',
      S.pitPlan(st) && S.pitPlan(st).lap === 14, JSON.stringify(S.pitPlan(st)));
  }

  // 提案が無い時の「了解」は、従来どおり中身の無い相槌のまま（8/29 原則を崩さない）。
  {
    const st = S.create({ session_key: 'r2' });
    const r = router.route({ text: '了解', lang: 'ja', live: {},
      strategy: { state: st, api: S } });
    check(G, '提案が無い「了解」は従来どおり中身が無い', r && r.reply === '了解。',
      JSON.stringify(r));
    check(G, '提案が無い「了解」は pit_plan を確定しない（回帰）', S.pitPlan(st) === null);
  }

  // strategy を渡さない既存呼び出し（大多数の呼び出し）は今までどおり壊れない。
  {
    const r = router.route({ text: '了解', lang: 'ja', live: {} });
    check(G, 'strategy未注入でも従来どおり動く（回帰）', r && r.reply === '了解。',
      JSON.stringify(r));
  }

  // 提案後の明示的な否定「いや」→ pit_plan は確定せず、基準プラン継続の返答になる。
  {
    const st = S.create({ session_key: 'r3' });
    S.proposePlan(st, { plan_id: 'B', lap: 9, at: Date.now(), decision_id: 'd3', basis: 'undercut' });
    const r = router.route({ text: 'いや', lang: 'ja', live: {},
      strategy: { state: st, api: S } });
    check(G, '提案後の「いや」が handled', r && r.handled === true, JSON.stringify(r));
    check(G, '提案後の「いや」は pit_plan を確定しない', S.pitPlan(st) === null);
  }

  // 期限切れの提案への「了解」は、確定せず従来の相槌へ落ちる（捏造しない）。
  {
    const st = S.create({ session_key: 'r4' });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: Date.now() - 91 * 1000, decision_id: 'd4', basis: 'undercut' });
    const r = router.route({ text: '了解', lang: 'ja', live: {},
      strategy: { state: st, api: S } });
    check(G, '期限切れ提案への「了解」は pit_plan を確定しない', S.pitPlan(st) === null);
    check(G, '期限切れ提案への「了解」は中身の無い相槌に落ちる', r && r.reply === '了解。',
      JSON.stringify(r));
  }

  // 合意後、answerPitDecision がその周を答える（正本の一貫性を通しで確認）。
  {
    const st = S.create({ session_key: 'r5' });
    S.proposePlan(st, { plan_id: 'B', lap: 11, at: Date.now(), decision_id: 'd5', basis: 'undercut' });
    router.route({ text: '了解', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    const a = S.answerPitDecision(st, { at: 2000 });
    check(G, '合意後は answerPitDecision が同じ周を答える（正本の一貫性）',
      /11周目/.test(String(a.reply || '')), JSON.stringify(a));
  }

  // ★Codex差戻しP2：裸の「はい」単体もどの分岐にも無く handled:false だった。
  {
    const st = S.create({ session_key: 'r6' });
    S.proposePlan(st, { plan_id: 'B', lap: 15, at: Date.now(), decision_id: 'd6', basis: 'undercut' });
    const r = router.route({ text: 'はい', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    check(G, '「はい」単体が handled になる（Codex P2）', r && r.handled === true, JSON.stringify(r));
    check(G, '「はい」で pit_plan が確定する（Codex P2）',
      S.pitPlan(st) && S.pitPlan(st).lap === 15, JSON.stringify(S.pitPlan(st)));
    const st2 = S.create({ session_key: 'r7' });
    const r3 = router.route({ text: 'はい', lang: 'ja', live: {}, strategy: { state: st2, api: S } });
    check(G, '提案が無い「はい」も従来どおり中身が無い相槌のまま', r3 && r3.reply === '了解。',
      JSON.stringify(r3));
    check(G, '提案が無い「はい」は pit_plan を確定しない（回帰）', S.pitPlan(st2) === null);
  }
}

// ════════════════════════════════════════════════════════════════════
// ③ Codex差戻し修正確認：古い提案の失効・pit_executed優先順位・配送確認
// ════════════════════════════════════════════════════════════════════
{
  const G = '③codex差戻し';

  // P1-1a：提案後に直接 amendPitPlan で訂正されたら、古い提案は失効する
  //        （12周合意→14周提案→16周へ訂正→「了解」で14周へ巻き戻らない）。
  {
    const st = S.create({ session_key: 'c1' });
    S.agreePitPlan(st, { lap: 12, source: 'driver', at: 1000 });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: 1100, decision_id: 'dc1', basis: 'undercut' });
    S.amendPitPlan(st, { lap: 16, source: 'driver', at: 1200 });
    const resolved = S.resolvePendingProposal(st, { accepted: true, at: 1250 });
    check(G, 'P1-1a 訂正後は古い提案が resolvePendingProposal で null', resolved === null);
    check(G, 'P1-1a 訂正後の pit_plan は16周のまま巻き戻らない',
      S.pitPlan(st) && S.pitPlan(st).lap === 16, JSON.stringify(S.pitPlan(st)));
  }

  // P1-1b：提案後に cancelPitPlan されたら、古い提案は復活しない。
  {
    const st = S.create({ session_key: 'c2' });
    S.agreePitPlan(st, { lap: 12, source: 'driver', at: 1000 });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: 1100, decision_id: 'dc2', basis: 'undercut' });
    S.cancelPitPlan(st, { source: 'driver', at: 1200 });
    const resolved = S.resolvePendingProposal(st, { accepted: true, at: 1250 });
    check(G, 'P1-1b 取消後は古い提案が null', resolved === null);
    check(G, 'P1-1b 取消後の pit_plan は復活しない', S.pitPlan(st) === null);
  }

  // P1-1c：提案後に recordPitExecuted（実行）されたら、古い提案は実行後に復活しない。
  {
    const st = S.create({ session_key: 'c3' });
    S.agreePitPlan(st, { lap: 12, source: 'driver', at: 1000 });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: 1100, decision_id: 'dc3', basis: 'undercut' });
    S.recordPitExecuted(st, { lap: 12, at: 1200 });
    const resolved = S.resolvePendingProposal(st, { accepted: true, at: 1250 });
    check(G, 'P1-1c 実行後は古い提案が null', resolved === null);
    check(G, 'P1-1c 実行後の pit_plan は古い提案で復活しない', S.pitPlan(st) === null);
  }

  // P1-1d：提案後に別の直接合意（driver申告）と競合したら、古い提案は勝てない。
  {
    const st = S.create({ session_key: 'c4' });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: 1000, decision_id: 'dc4', basis: 'undercut' });
    S.agreePitPlan(st, { lap: 9, source: 'driver', at: 1100 });  // 「この周でピットイン」等の直接申告
    const resolved = S.resolvePendingProposal(st, { accepted: true, at: 1150 });
    check(G, 'P1-1d 直接合意と競合した古い提案は null', resolved === null);
    check(G, 'P1-1d 直接合意（9周）が古い提案（14周）に上書きされない',
      S.pitPlan(st) && S.pitPlan(st).lap === 9, JSON.stringify(S.pitPlan(st)));
  }

  // P1-2：実行後に新しい合意ができたら、answerPitDecisionは新しい合意を答える
  //       （旧「12周目でピット済み」に固定されない＝耐久の追加pit）。
  {
    const st = S.create({ session_key: 'c5' });
    S.agreePitPlan(st, { lap: 12, source: 'driver', at: 1000 });
    S.recordPitExecuted(st, { lap: 12, at: 2000 });
    S.proposePlan(st, { plan_id: 'B', lap: 20, at: 2100, decision_id: 'dc5', basis: 'undercut' });
    const resolved = S.resolvePendingProposal(st, { accepted: true, at: 2150 });
    check(G, 'P1-2 実行後の新提案は合意できる（失効しない）', resolved && resolved.accepted === true);
    const a = S.answerPitDecision(st, { at: 2200 });
    check(G, 'P1-2 実行後に新しく合意した周を答える（旧「ピット済み」に固定されない）',
      /20周目/.test(String(a.reply || '')), JSON.stringify(a));
    check(G, 'P1-2 旧い実行済みの文言は出さない', !/12周目でピット済み/.test(String(a.reply || '')),
      JSON.stringify(a));
  }

  // P1-3：renderer.html 側で proposePlan が speak() 直後ではなく、
  //       finalizeUtterance の 'spoken'（実際に配送された時）に紐付いていること。
  //       ★Codex第2回差戻し「callbackが存在するという静的検査だけでは今回の
  //       競合を検出できない」を受け、文字列存在検査ではなく実関数を抽出・
  //       vm実行して検証する（下の④で evaluateLiveStrategySwitch と
  //       finalizeUtterance を実際に動かして確認する）。
}

// ★④⑤共用：renderer.html から実関数を抽出し vm 実行するための土台
// （grabFunction は tests-build298-race-replay.js と同じ手法。ブロックscopeの
//   function/constだと④でしか使えないため、複数セクションで共有できるよう
//   トップレベルへ出す）。
const html = fs.readFileSync(path.join(__dirname, 'desktop/renderer.html'), 'utf8');
function grabFn(src, name) {
  const i = src.indexOf('function ' + name);
  if (i < 0) return '';
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  return '';
}
const finalizeSrc = grabFn(html, 'finalizeUtterance');
// ★2026-09-17 Codex MD#8差戻し（P1-4）：JS自前の`evaluateLiveStrategySwitch`は
//   自前のdecision IDで提案を発話する**競合エンジン**だったため廃止され、Bridge推薦を
//   allow/hold/dropする検証だけになった。提案→合意の唯一の入口は
//   `handleStrategyPlanProposal`（Bridgeのcanonical ID）——ここもそれを実行する。
const proposalSrc = grabFn(html, 'handleStrategyPlanProposal');
const stillCurrentSrc = grabFn(html, 'bridgeProposalStillCurrent');
const supportSrc = grabFn(html, 'strategyOptionsSupportProposal');
const condFromOptsSrc = grabFn(html, 'planConditionsFromOptions');
const sameCondSrc = grabFn(html, 'sameProposalConditions');
const deliverySrc = grabFn(html, 'sendStrategyDecisionDelivery');
const deliveryKeySrc = grabFn(html, 'strategyDeliveryKey');
const deliveryFlushSrc = grabFn(html, 'flushStrategyDeliveryOutbox');
const responseKeySrc = grabFn(html, 'strategyResponseKey');

// playbook.__nextDecision で evaluateSwitch の判断そのものはモックし、
// 提案登録の配線（本テストの対象）だけを実行する。
function makeCtx(st, proposal) {
  const ctx = {
    console, globalThis: null, JSON, Number, String, Set, Map, Date,
    PitwallSessionStrategyState: S,
    ensureStrategyState: () => st,
    selMode: 'race', lastSessionNum: 1,
    // 配信直前のprecheckは**最新telemetry**の権威と照合する（MD#9 P1-2）。
    //   提案と同じsnapshot・同じ選択Plan・同じ数値をここへ置く＝「根拠は動いていない」状態。
    lastTelemetry: { cust_id: 1, strategy_options: { available: true,
      snapshot_id: 'recalc:test:1:' + proposal.lap, selected_plan: proposal.plan,
      decision_evidence: proposal.plan === 'C'
        ? { decision_id: proposal.decisionId,
            plan_c_evidence: { conditions_met: { rival_pitted_first: true, clean_air: true,
              fuel_save_on_target: true } } }
        : { decision_id: proposal.decisionId,
            plan_b_evidence: { relative_pace_advantage_s: 0.8,
              conditions_met: { fuel_window_open: true, relative_pace_advantage: true, rejoin_clear: true } } },
      ['plan_' + proposal.plan.toLowerCase()]: { target_lap: proposal.lap,
        add_fuel_l: 10, set_fuel_l: 24, fuel_window_open: true } } },
    liveStrategyValidation: null,
    bridgeStrategyDecisions: new Map(),
    strategyDeliveryOutbox: new Map(),
    // Bridgeへの配送通知そのものは別ファイル（tests-bridge-strategy-proposal-roundtrip.js）
    // が実WS送信まで検証する。ここは提案→合意の状態遷移が対象なのでsocket無しでよい。
    irBridge: null,
    diagnosticLog: () => {}, addMsg: () => {}, pushMsg: () => {},
    // ★2026-09-17 Codex MD#4〜#6差戻し：applyProposalJudgeTagがBridge発の提案の
    //   合意結果をBridgeへ送り返すsendStrategyDecisionResponseを呼ぶようになった
    //   （本番配線はtests-bridge-strategy-proposal-roundtrip.jsで別途検証）。
    //   このファイルはPW_JUDGE状態遷移そのものが対象なのでno-opでよい。
    sendStrategyDecisionResponse: () => {},
    isJapaneseEngineer: () => true,
    strategyPlaybookDecisionKeys: new Set(),
    SPEAK_PRIO: { P2_CRITICAL: 2 },
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;   // renderer.html は window.PitwallStrategyPlaybook 等を直接参照する
  // speak() の実装はここでは対象外（音声パイプライン全体は別関心事）。
  // finalizeUtterance が読む item 形状だけを最小再現する fake。
  ctx.speak = (text, opts) => {
    ctx.__lastItem = { text, kind: opts && opts.kind, onSpoken: opts && opts.onSpoken,
      onAudibleInterrupted: opts && opts.onAudibleInterrupted,
      precheck: opts && opts.precheck, _finalized: null };
  };
  vm.createContext(ctx);
  vm.runInContext(finalizeSrc + '\n' + proposalSrc + '\n' + stillCurrentSrc + '\n' + supportSrc
    + '\n' + condFromOptsSrc + '\n' + sameCondSrc
    + '\n' + responseKeySrc + '\n' + deliveryKeySrc + '\n' + deliveryFlushSrc + '\n' + deliverySrc
    + '\nglobalThis.__propose = handleStrategyPlanProposal;'
    + '\nglobalThis.__finalize = finalizeUtterance;', ctx);
  // Bridgeが送ってくるdata eventの最小形（bridge.pyの`build_strategy_decision()`が
  // 凍結したplanレコードをそのまま`decision_plan`として載せる）。
  // ★2026-09-17 Codex MD#9差戻し（P1-2）：Desktopの同一frame判定はfail-closed——
  //   eventへその frame の`strategy_options`（available・selected_plan・snapshot_id・
  //   plan詳細）が同梱されていなければ発話しない。Bridgeが実際に送る形に合わせる。
  const snapshotId = 'recalc:test:1:' + proposal.lap;
  const dispatchId = proposal.decisionId + '#1';
  // ★2026-09-17 Codex MD#9チェック差戻し：Plan別conditionsも凍結・照合の対象になった。
  //   `decision_evidence`（decision-lock時点のlive再検証）は`build_strategy_decision()`と
  //   同じ出所——`planConditionsFromOptions()`が両方（凍結時／配信直前）で同じ結果を返すよう、
  //   ここでも同じ形を用意する。
  const decisionEvidence = proposal.plan === 'C'
    ? { decision_id: proposal.decisionId,
        plan_c_evidence: { conditions_met: { rival_pitted_first: true, clean_air: true,
          fuel_save_on_target: true } } }
    : { decision_id: proposal.decisionId,
        plan_b_evidence: { relative_pace_advantage_s: 0.8,
          conditions_met: { fuel_window_open: true, relative_pace_advantage: true, rejoin_clear: true } } };
  const frozenConditions = proposal.plan === 'C'
    ? { rival_pitted_first: true, clean_air: true, fuel_save_on_target: true }
    : { fuel_window_open: true, relative_pace_advantage_s: 0.8, rejoin_not_worse: true };
  ctx.__deliverProposal = () => ctx.__propose({
    type: 'radio', trigger: 'strategy_plan_proposal',
    decision_id: proposal.decisionId, dispatch_id: dispatchId,
    selected_plan: proposal.plan, reason: 'undercut',
    decision_plan: { decision_id: proposal.decisionId, dispatch_id: dispatchId,
      selected_plan: proposal.plan, target_lap: proposal.lap, add_fuel_l: 10, set_fuel_l: 24,
      session_num: 1, evidence_snapshot_id: snapshotId, conditions: frozenConditions },
    strategy_options: { available: true, snapshot_id: snapshotId,
      selected_plan: proposal.plan, decision_evidence: decisionEvidence,
      ['plan_' + proposal.plan.toLowerCase()]: { target_lap: proposal.lap,
        add_fuel_l: 10, set_fuel_l: 24, fuel_window_open: true } },
  });
  return ctx;
}

// ★⑦用：意味判定タグの抽出・除去・適用（stripProposalJudgeTag／applyProposalJudgeTag）
// を実際に抽出・実行するための土台。実LLM・実通信は使わない——文字列を渡して
// 挙動を検証する（Codexの言う「決定論の接続検査は保存応答／mockで可能」の範囲）。
const judgeConstStartMatch = html.match(/const PW_JUDGE_TAG_START = [\s\S]*?;/);
const judgeConstMatch = html.match(/const PW_JUDGE_TAG_RE = [\s\S]*?;/);
const judgeConstSrc = (judgeConstStartMatch ? judgeConstStartMatch[0] : '')
  + '\n' + (judgeConstMatch ? judgeConstMatch[0] : '');
const stripJudgeTagSrc = grabFn(html, 'stripProposalJudgeTag');
const applyJudgeTagSrc = grabFn(html, 'applyProposalJudgeTag');
function makeJudgeCtx(st) {
  const ctx = {
    console, globalThis: null,
    PitwallSessionStrategyState: S,
    ensureStrategyState: () => st,
    diagnosticLog: () => {},
    sendStrategyDecisionResponse: () => {},
    // same_topicの配送確認先。テストが直接セットして動作を制御する
    // （実speak()/speakReplyChunk()は呼ばない——ここは接続層の検証）。
    lastQueuedSpeakItem: null,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(judgeConstSrc + '\n' + stripJudgeTagSrc + '\n' + applyJudgeTagSrc
    + '\nglobalThis.__strip = stripProposalJudgeTag;'
    + '\nglobalThis.__apply = applyProposalJudgeTag;', ctx);
  return ctx;
}

// ════════════════════════════════════════════════════════════════════
// ④ Codex第2回差戻し：revision確定タイミング(P1-A)と配送/文脈(P1-B)
//    renderer.html から実関数を抽出し vm 実行して検証する（静的検査に留めない）。
// ════════════════════════════════════════════════════════════════════
{
  const G = '④codex第2回';
  check(G, 'finalizeUtterance を抽出できる', !!finalizeSrc);
  check(G, 'handleStrategyPlanProposal（提案の唯一の入口）を抽出できる', !!proposalSrc);

  // P1-3（回帰・実行で確認）：speak()直後ではなく、finalizeUtterance('spoken')後に
  // proposePlan が呼ばれる。
  {
    const st = S.create({ session_key: 'v1' });
    const ctx = makeCtx(st, { plan: 'B', lap: 14, decisionId: 'dv1' });
    ctx.__deliverProposal();
    check(G, 'P1-3(実行) speak()段階では pending_proposal がまだ無い',
      S.pendingProposal(st, { at: Date.now() }) === null);
    ctx.__finalize(ctx.__lastItem, 'spoken');
    check(G, 'P1-3(実行) spoken確定後に pending_proposal が登録される',
      !!S.pendingProposal(st, { at: Date.now() }), JSON.stringify(S.pendingProposal(st, { at: Date.now() })));
  }

  // P1-A：queue待機中（生成後・再生前）に別の訂正が起きたら、配送時に「新鮮」と
  // 誤認せず、登録そのものを見送る（12周合意→14周提案生成→queue待機中に16周へ
  // 訂正→そのqueue itemが遅れて再生されても14周は合意可能にならない）。
  {
    const st = S.create({ session_key: 'v2' });
    S.agreePitPlan(st, { lap: 12, source: 'driver', at: 1000 });
    const ctx = makeCtx(st, { plan: 'B', lap: 14, decisionId: 'dv2' });
    ctx.__deliverProposal();                             // 生成：14周提案がqueueへ（revisionを内部で確定）
    S.amendPitPlan(st, { lap: 16, source: 'driver', at: 1100 });  // queue待機中に訂正
    ctx.__finalize(ctx.__lastItem, 'spoken');              // 遅れて配送
    check(G, 'P1-A 待機中に訂正された提案は配送時に登録されない',
      S.pendingProposal(st, { at: Date.now() }) === null);
    check(G, 'P1-A pit_plan は訂正後の16周のまま（14周へ巻き戻らない）',
      S.pitPlan(st) && S.pitPlan(st).lap === 16, JSON.stringify(S.pitPlan(st)));
    const r = router.route({ text: '了解', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    check(G, 'P1-A 登録されなかった提案は「了解」でも合意にならない',
      S.pitPlan(st) && S.pitPlan(st).lap === 16, JSON.stringify(S.pitPlan(st)));
    check(G, 'P1-A その「了解」は中身の無い相槌に落ちる', r && r.reply === '了解。', JSON.stringify(r));
  }

  // P1-B（audible_interrupted）：冒頭だけ聞こえて中断されたら、登録済みの提案でも
  // 取り消す（合意可能なままにしない）。
  {
    const st = S.create({ session_key: 'v3' });
    const ctx = makeCtx(st, { plan: 'B', lap: 9, decisionId: 'dv3' });
    ctx.__deliverProposal();
    ctx.__finalize(ctx.__lastItem, 'spoken');
    check(G, 'P1-B(interrupted) 配送直後は提案が有効', !!S.pendingProposal(st, { at: Date.now() }));
    ctx.__finalize(ctx.__lastItem, 'audible_interrupted');
    check(G, 'P1-B(interrupted) 中断されたら提案が取り消される',
      S.pendingProposal(st, { at: Date.now() }) === null);
    const r = router.route({ text: '了解', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    check(G, 'P1-B(interrupted) 中断後の「了解」は合意にならない', S.pitPlan(st) === null);
    check(G, 'P1-B(interrupted) その「了解」は中身の無い相槌に落ちる', r && r.reply === '了解。',
      JSON.stringify(r));
  }

  // P1-B（無関係な話題）：提案の直後に無関係な質問を挟んだら、その後の「了解」は
  // 合意にならない（router.route() の実行を通す）。
  {
    const st = S.create({ session_key: 'v4' });
    S.proposePlan(st, { plan_id: 'B', lap: 18, at: Date.now(), decision_id: 'dv4', basis: 'undercut' });
    const mid = router.route({ text: 'データ入ってる？', lang: 'ja', live: {},
      strategy: { state: st, api: S } });
    check(G, 'P1-B(話題) 無関係な質問は handled になる（別経路が処理した証拠）',
      mid && mid.handled === true, JSON.stringify(mid));
    check(G, 'P1-B(話題) 無関係な質問を挟むと提案が無効化される',
      S.pendingProposal(st, { at: Date.now() }) === null);
    const r = router.route({ text: '了解', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    check(G, 'P1-B(話題) 話題を挟んだ後の「了解」は合意にならない', S.pitPlan(st) === null,
      JSON.stringify(S.pitPlan(st)));
    check(G, 'P1-B(話題) その「了解」は中身の無い相槌に落ちる', r && r.reply === '了解。',
      JSON.stringify(r));
  }

  // 回帰：提案直後・訂正/話題挟みなしの素直な「了解」は、引き続き合意になる。
  {
    const st = S.create({ session_key: 'v5' });
    const ctx = makeCtx(st, { plan: 'C', lap: 22, decisionId: 'dv5' });
    ctx.__deliverProposal();
    ctx.__finalize(ctx.__lastItem, 'spoken');
    const r = router.route({ text: '了解', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    check(G, '回帰：訂正/話題挟みなしなら通常どおり合意になる',
      S.pitPlan(st) && S.pitPlan(st).lap === 22, JSON.stringify(S.pitPlan(st)));
  }
}

// ════════════════════════════════════════════════════════════════════
// ⑤ Codex第3回差戻し：再生前チェック(残存P1)と会話継続(確認質問)
// ════════════════════════════════════════════════════════════════════
{
  const G = '⑤codex第3回';

  // 残存P1：queue待機中に前提が変わったら、precheckが再生前にfalseを返す
  // （drainQueue全体の実行はしないが、実際に呼ばれるprecheck関数そのものを検証する）。
  {
    const st = S.create({ session_key: 'w1' });
    S.agreePitPlan(st, { lap: 12, source: 'driver', at: 1000 });
    const ctx = makeCtx(st, { plan: 'B', lap: 14, decisionId: 'dw1' });
    ctx.__deliverProposal();
    check(G, '残存P1 生成直後のprecheckは true（訂正が無い）',
      typeof ctx.__lastItem.precheck === 'function' && ctx.__lastItem.precheck() === true);
    S.amendPitPlan(st, { lap: 16, source: 'driver', at: 1100 });   // queue待機中に訂正
    check(G, '残存P1 待機中に訂正されたらprecheckがfalseになる（再生前に検出）',
      ctx.__lastItem.precheck() === false);
    check(G, '残存P1 drainQueue はprecheckを再生開始の直前で呼ぶ（配線の確認）',
      /const _it = speakQueue\.splice\(nextIndex,1\)\[0\];\s*\n[\s\S]{0,400}typeof _it\.precheck\s*===\s*['"]function['"]/.test(html));
  }

  // 会話継続：同じ相談の確認（「何周目にピット？」）は提案を消さず、両方を伝える。
  {
    // ★router内部はDate.now()で期限判定するため、提案時刻も現在時刻基準にする
    //   （②③の router 実行テストと同じ注意点）。
    const st = S.create({ session_key: 'w2' });
    S.agreePitPlan(st, { lap: 12, source: 'driver', at: 1000 });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: Date.now(), decision_id: 'dw2', basis: 'undercut' });
    const q = router.route({ text: '何周目にピット？', lang: 'ja', live: {},
      strategy: { state: st, api: S } });
    check(G, '会話継続 確認質問は handled になる', q && q.handled === true, JSON.stringify(q));
    check(G, '会話継続 確認質問は確定Planを答える', /12周目/.test(String(q.reply || '')),
      JSON.stringify(q));
    check(G, '会話継続 確認質問は保留中の提案も伝える（曖昧なまま片方だけにしない）',
      /14周目/.test(String(q.reply || '')), JSON.stringify(q));
    check(G, '会話継続 確認質問では提案が消えない',
      !!S.pendingProposal(st, { at: Date.now() }), JSON.stringify(S.pendingProposal(st, { at: Date.now() })));
    const r = router.route({ text: '了解', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    check(G, '会話継続 確認質問の後でも「了解」で提案(14周)へ合意できる',
      S.pitPlan(st) && S.pitPlan(st).lap === 14, JSON.stringify(S.pitPlan(st)));
  }

  // 回帰：それでも真に無関係な話題（「データ入ってる？」）は引き続き無効化する。
  {
    const st = S.create({ session_key: 'w3' });
    S.proposePlan(st, { plan_id: 'B', lap: 19, at: Date.now(), decision_id: 'dw3', basis: 'undercut' });
    router.route({ text: 'データ入ってる？', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    check(G, '回帰：真に無関係な話題は引き続き提案を無効化する',
      S.pendingProposal(st, { at: Date.now() }) === null);
  }
}

// ════════════════════════════════════════════════════════════════════
// ⑥ Codex第4回差戻し：LLM行きの理由確認（handled:false）と再生直前の再照合
// ════════════════════════════════════════════════════════════════════
{
  const G = '⑥codex第4回';

  // ★2026-09-13 Codex第5回差戻しで語彙ヒューリスティックは一度撤回してフェイルクローズへ
  //   戻したが、第6回差戻しで「意味判定待ち」（⑦参照）へ更に置き換えた。ローカルでは
  //   「なぜ」を含むかどうかで真に無関係な話題かを判定できないという指摘は変わらず
  //   正しいため、handled:falseは内容を問わず一律に「意味判定待ち」へ入る——
  //   提案は消えないが、意味判定（またはTTL失効）が来るまで裸の相槌では確定しない。
  //   詳細な状態遷移の検証は⑦へ集約し、ここでは3つの発話（理由確認・言い換え・
  //   真に無関係）が同じ扱いを受けることだけを確認する。
  {
    const st = S.create({ session_key: 'x1' });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: Date.now(), decision_id: 'dx1', basis: 'undercut' });
    const q = router.route({ text: 'なぜその案がいいの？', lang: 'ja', live: {},
      strategy: { state: st, api: S } });
    check(G, '理由確認は handled:false のままLLMへ渡る（ローカルで断定しない）',
      q && q.handled === false, JSON.stringify(q));
    check(G, '理由確認は提案を無効化せず意味判定待ちへ入れる',
      !!S.pendingProposal(st, { at: Date.now() }), JSON.stringify(S.pendingProposal(st, { at: Date.now() })));
  }
  {
    const st = S.create({ session_key: 'x1b' });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: Date.now(), decision_id: 'dx1b', basis: 'undercut' });
    router.route({ text: 'どうして？', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    check(G, '語彙を含まない「どうして？」も同じ扱いで意味判定待ちへ入る',
      !!S.pendingProposal(st, { at: Date.now() }));
  }
  {
    // ★「今日はいい天気だと思わない？」は実は天気の局所回答(weather_status)に
    //   一致してしまう（handled:true・許可リスト外）ため、真に無関係の例には
    //   ならない——それは既存の「回帰：handled:trueの別トピックは即時無効化する」
    //   （⑦）が別途確認している。ここではローカルのどの意図にも一致しない、
    //   本当にhandled:falseになる無関係発話を使う。
    const st = S.create({ session_key: 'x2' });
    S.proposePlan(st, { plan_id: 'B', lap: 21, at: Date.now(), decision_id: 'dx2', basis: 'undercut' });
    const q = router.route({ text: '好きな食べ物は何？', lang: 'ja', live: {},
      strategy: { state: st, api: S } });
    check(G, '真に無関係な発話もhandled:falseならLLMへ渡る', q && q.handled === false, JSON.stringify(q));
    check(G, '真に無関係な話題も同じ扱いで意味判定待ちへ入る（無効化しない）',
      !!S.pendingProposal(st, { at: Date.now() }));
    const r = router.route({ text: '了解', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    check(G, '判定が来ない限り、無関係な話題の後の「了解」でも確定しない（安全側）',
      S.pitPlan(st) === null, JSON.stringify(S.pitPlan(st)));
  }

  // ⑥-b：applyProposalClassification（接続層）を保存応答／mockで検証する。
  // 実LLMによる意味判定の質はここでは検証していない——「分類結果が来たら
  // 状態を正しく更新する」という決定論の配線だけを確認する（Codexが認めた
  // テスト境界：「決定論の接続検査は保存応答／mockで可能」）。
  {
    // confirm
    let st = S.create({ session_key: 'y1' });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: Date.now(), decision_id: 'dy1', basis: 'undercut' });
    let res = S.applyProposalClassification(st, { classification: 'confirm', decision_id: 'dy1', at: Date.now() });
    check(G, 'applyProposalClassification: confirmでpit_planへ昇格', res.applied && res.outcome === 'confirmed');
    check(G, 'applyProposalClassification: confirm後のpit_planが正しい',
      S.pitPlan(st) && S.pitPlan(st).lap === 14, JSON.stringify(S.pitPlan(st)));

    // decline
    st = S.create({ session_key: 'y2' });
    S.proposePlan(st, { plan_id: 'B', lap: 15, at: Date.now(), decision_id: 'dy2', basis: 'undercut' });
    res = S.applyProposalClassification(st, { classification: 'decline', decision_id: 'dy2', at: Date.now() });
    check(G, 'applyProposalClassification: declineでpit_planを確定しない',
      res.applied && res.outcome === 'declined' && S.pitPlan(st) === null);

    // same_topic：何も動かさない（保留のまま）
    st = S.create({ session_key: 'y3' });
    S.proposePlan(st, { plan_id: 'B', lap: 16, at: Date.now(), decision_id: 'dy3', basis: 'undercut' });
    res = S.applyProposalClassification(st, { classification: 'same_topic', decision_id: 'dy3', at: Date.now() });
    check(G, 'applyProposalClassification: same_topicは保留を維持する',
      res.applied && res.outcome === 'kept_pending'
      && !!S.pendingProposal(st, { at: Date.now() }) && S.pitPlan(st) === null);

    // unrelated：無効化する
    st = S.create({ session_key: 'y4' });
    S.proposePlan(st, { plan_id: 'B', lap: 17, at: Date.now(), decision_id: 'dy4', basis: 'undercut' });
    res = S.applyProposalClassification(st, { classification: 'unrelated', decision_id: 'dy4', at: Date.now() });
    check(G, 'applyProposalClassification: unrelatedで提案を無効化する',
      res.applied && res.outcome === 'invalidated' && S.pendingProposal(st, { at: Date.now() }) === null);

    // stale guard：decision_idが一致しない（別の・より新しい提案に上書きされた後）分類結果は無視する
    st = S.create({ session_key: 'y5' });
    S.proposePlan(st, { plan_id: 'B', lap: 18, at: Date.now(), decision_id: 'dy5-old', basis: 'undercut' });
    S.proposePlan(st, { plan_id: 'C', lap: 22, at: Date.now(), decision_id: 'dy5-new', basis: 'overcut' });
    res = S.applyProposalClassification(st, { classification: 'confirm', decision_id: 'dy5-old', at: Date.now() });
    check(G, 'applyProposalClassification: stale guardが古いdecision_idの分類結果を拒否する',
      res.applied === false && res.reason === 'stale_classification_target_mismatch');
    check(G, 'applyProposalClassification: stale guard後も新しい提案(22周)は保留のまま',
      S.pendingProposal(st, { at: Date.now() }) && S.pendingProposal(st, { at: Date.now() }).lap === 22,
      JSON.stringify(S.pendingProposal(st, { at: Date.now() })));

    // 提案なしなら適用不可
    st = S.create({ session_key: 'y6' });
    res = S.applyProposalClassification(st, { classification: 'confirm', at: Date.now() });
    check(G, 'applyProposalClassification: 提案が無ければ適用不可',
      res.applied === false && res.reason === 'no_pending_proposal');
  }

  // 残存P1：再生直前（fetch/json待ちの非同期区間の後）にも precheck を再照合する
  // 配線があること。drainQueue全体（fetch/Audio/timerの完全なmock）の実行はしていない
  // ——構造的な配線確認に留める境界をここに明示する（indexOfで前後関係のみ検査、
  // 空白の揺れに影響されない形にする）。
  {
    const audioAssignIdx = html.indexOf('ttsAudio = audio;');
    const audioPlayIdx = html.indexOf('await audio.play();');
    const fallbackDefIdx = html.indexOf('const _fallbackOnce = (where, detail)=>{');
    const staleIdxCloud = html.indexOf('stale_precondition_pre_play', audioAssignIdx >= 0 ? audioAssignIdx : 0);
    const staleIdxFallback = html.indexOf('stale_precondition_pre_play', fallbackDefIdx >= 0 ? fallbackDefIdx : 0);
    check(G, '残存P1 audio.play()直前にもprecheckを再照合する（cloud経路）',
      audioAssignIdx >= 0 && audioPlayIdx > audioAssignIdx
      && staleIdxCloud > audioAssignIdx && staleIdxCloud < audioPlayIdx);
    check(G, '残存P1 フォールバック（WebSpeech）経路でも再照合する',
      fallbackDefIdx >= 0 && staleIdxFallback > fallbackDefIdx
      && staleIdxFallback < fallbackDefIdx + 400);
  }
}

// ════════════════════════════════════════════════════════════════════
// ⑦ Codex第6回差戻し：意味判定待ち状態(awaiting_judgment)と
//    <<PW_JUDGE>>タグの抽出・除去・適用（実LLM呼出は行わない）
// ════════════════════════════════════════════════════════════════════
{
  const G = '⑦codex第6回';

  // ①state：markAwaitingJudgment と resolvePendingProposal のゲート
  {
    // 判定待ちの間、裸の accepted:true は確定しない
    let st = S.create({ session_key: 'z1' });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: Date.now(), decision_id: 'dz1', basis: 'undercut' });
    S.markAwaitingJudgment(st, { decision_id: 'dz1', at: Date.now() });
    let resolved = S.resolvePendingProposal(st, { accepted: true, at: Date.now() });
    check(G, '判定待ち中は裸のacceptedで確定しない', resolved === null);
    check(G, '判定待ち中も提案自体は消えない', !!S.pendingProposal(st, { at: Date.now() }));

    // 判定待ちの間でも明示的な拒否（accepted:false）は通る
    st = S.create({ session_key: 'z2' });
    S.proposePlan(st, { plan_id: 'B', lap: 15, at: Date.now(), decision_id: 'dz2', basis: 'undercut' });
    S.markAwaitingJudgment(st, { decision_id: 'dz2', at: Date.now() });
    resolved = S.resolvePendingProposal(st, { accepted: false, at: Date.now() });
    check(G, '判定待ち中でも明示的な拒否は通る', resolved && resolved.accepted === false);

    // applyProposalClassification は bypassJudgmentGate で判定待ちを解除できる
    st = S.create({ session_key: 'z3' });
    S.proposePlan(st, { plan_id: 'B', lap: 16, at: Date.now(), decision_id: 'dz3', basis: 'undercut' });
    S.markAwaitingJudgment(st, { decision_id: 'dz3', at: Date.now() });
    const applied = S.applyProposalClassification(st, { classification: 'confirm', decision_id: 'dz3', at: Date.now() });
    check(G, '意味判定confirmは判定待ちを乗り越えて確定できる',
      applied.applied && applied.outcome === 'confirmed' && S.pitPlan(st) && S.pitPlan(st).lap === 16,
      JSON.stringify(S.pitPlan(st)));

    // ★Codex第6回：decision_id省略は拒否する（対象IDの提示を必須にする）
    st = S.create({ session_key: 'z4' });
    S.proposePlan(st, { plan_id: 'B', lap: 17, at: Date.now(), decision_id: 'dz4', basis: 'undercut' });
    const rejected = S.applyProposalClassification(st, { classification: 'confirm', at: Date.now() });
    check(G, 'decision_id省略の分類は拒否される', rejected.applied === false && rejected.reason === 'decision_id_required');
    check(G, 'decision_id省略の分類はpit_planを動かさない', S.pitPlan(st) === null);
  }

  // ②router：handled:falseは無効化ではなく意味判定待ちへ。提案は生き残るが
  // 裸の「了解」では確定しない。真に別トピック（handled:true・許可リスト外）は
  // 引き続き即時無効化する。
  {
    const st = S.create({ session_key: 'z5' });
    S.proposePlan(st, { plan_id: 'B', lap: 18, at: Date.now(), decision_id: 'dz5', basis: 'undercut' });
    const q = router.route({ text: 'どうして？', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    check(G, 'handled:falseはLLMへ渡る', q && q.handled === false);
    check(G, 'handled:false後も提案は消えない（意味判定待ちへ）',
      !!S.pendingProposal(st, { at: Date.now() }), JSON.stringify(S.pendingProposal(st, { at: Date.now() })));
    const r = router.route({ text: '了解', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    check(G, '意味判定が来る前の裸の「了解」では確定しない', S.pitPlan(st) === null, JSON.stringify(S.pitPlan(st)));
    check(G, 'その「了解」は中身の無い相槌に落ちる', r && r.reply === '了解。', JSON.stringify(r));

    // 実際の意味判定（mock）が来たら、その後の「了解」を待たず直接確定する
    const applied = S.applyProposalClassification(st, { classification: 'confirm', decision_id: 'dz5', at: Date.now() });
    check(G, '判定confirmが来れば直接pit_planへ確定する',
      applied.applied && S.pitPlan(st) && S.pitPlan(st).lap === 18, JSON.stringify(S.pitPlan(st)));
  }
  {
    // 回帰：真に別トピック（handled:true・許可リスト外）は引き続き即時無効化する。
    const st = S.create({ session_key: 'z6' });
    S.proposePlan(st, { plan_id: 'B', lap: 19, at: Date.now(), decision_id: 'dz6', basis: 'undercut' });
    router.route({ text: 'データ入ってる？', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    check(G, '回帰：handled:trueの別トピックは即時無効化する',
      S.pendingProposal(st, { at: Date.now() }) === null);
  }

  // ③タグの抽出・除去（実LLM呼出はしない。渡す文字列はテストが用意したmock）
  {
    check(G, 'stripProposalJudgeTag を抽出できる', !!stripJudgeTagSrc);
    check(G, 'applyProposalJudgeTag を抽出できる', !!applyJudgeTagSrc);
    check(G, 'PW_JUDGE_TAG_RE の宣言を抽出できる', !!judgeConstSrc);

    const ctx = makeJudgeCtx(S.create({ session_key: 'zz' }));
    const clean = ctx.__strip('前走車まで1.2秒、こちらが0.4秒速い。だから今がチャンス。');
    check(G, 'タグが無い応答はそのまま・judgment=null', clean.text.includes('だから今がチャンス') && clean.judgment === null);

    const tagged = ctx.__strip('だから今がチャンス。\n<<PW_JUDGE decision_id="dz7" classification="confirm">>');
    check(G, 'タグ付き応答からjudgmentを抽出できる',
      tagged.judgment && tagged.judgment.decision_id === 'dz7' && tagged.judgment.classification === 'confirm',
      JSON.stringify(tagged));
    check(G, 'タグ自体は表示・音声用テキストに残らない（[JA:と同じ扱い）',
      !tagged.text.includes('PW_JUDGE') && tagged.text.trim() === 'だから今がチャンス。', JSON.stringify(tagged));

    const malformed = ctx.__strip('説明本文。\n<<PW_JUDGE decision_id="dz8" classification="maybe">>');
    check(G, '不正なclassification値のタグは抽出しない（未知タグで状態を動かさない）',
      malformed.judgment === null && malformed.text.includes('説明本文'), JSON.stringify(malformed));
  }

  // ④接続の通し：stripしたjudgmentをapplyProposalJudgeTag経由でstateへ適用する
  // （callAPI()の実際の呼び出し方を模した最小再現。実通信・実LLMは無し）。
  {
    const st = S.create({ session_key: 'z7' });
    S.proposePlan(st, { plan_id: 'B', lap: 20, at: Date.now(), decision_id: 'dz7', basis: 'undercut' });
    S.markAwaitingJudgment(st, { decision_id: 'dz7', at: Date.now() });
    const ctx = makeJudgeCtx(st);
    const mockLlmReply = '前走車まで1.2秒差、ペースは0.4秒速い。だから今がチャンスだと思う。\n'
      + '<<PW_JUDGE decision_id="dz7" classification="confirm">>';
    const parsed = ctx.__strip(mockLlmReply);
    check(G, '接続の通し：mock応答からタグを剥がした本文はDriver向けとして自然',
      !parsed.text.includes('PW_JUDGE') && parsed.text.includes('チャンスだと思う'));
    ctx.__apply(parsed.judgment);
    check(G, '接続の通し：apply後にpit_planが確定する',
      S.pitPlan(st) && S.pitPlan(st).lap === 20, JSON.stringify(S.pitPlan(st)));

    // stale：別の提案に切り替わった後に古いdecision_idの判定が遅れて届いても無視する
    const st2 = S.create({ session_key: 'z8' });
    S.proposePlan(st2, { plan_id: 'B', lap: 21, at: Date.now(), decision_id: 'dz8-old', basis: 'undercut' });
    S.markAwaitingJudgment(st2, { decision_id: 'dz8-old', at: Date.now() });
    S.proposePlan(st2, { plan_id: 'C', lap: 25, at: Date.now(), decision_id: 'dz8-new', basis: 'overcut' });
    const ctx2 = makeJudgeCtx(st2);
    const staleReply = '古い提案の説明。\n<<PW_JUDGE decision_id="dz8-old" classification="confirm">>';
    const parsedStale = ctx2.__strip(staleReply);
    ctx2.__apply(parsedStale.judgment);
    check(G, '接続の通し：古いdecision_idの遅延判定は新しい提案(25周)を上書きしない',
      S.pendingProposal(st2, { at: Date.now() }) && S.pendingProposal(st2, { at: Date.now() }).lap === 25
      && S.pitPlan(st2) === null,
      JSON.stringify({ pending: S.pendingProposal(st2, { at: Date.now() }), plan: S.pitPlan(st2) }));
  }
}

// ════════════════════════════════════════════════════════════════════
// ⑧ 2026-09-14 Codex独立probeで反証された2件の修正確認
//    (A) same_topicがawaiting_judgmentを解除せず永久に確定不能だった
//    (B) 未完成／未知classificationのタグが最終表示・途中経過へ漏れていた
// ════════════════════════════════════════════════════════════════════
{
  const G = '⑧9/14 codex probe';

  // (A-1) state層：same_topic適用後はawaiting_judgmentが解除され、
  //       通常のresolvePendingProposal経路で確定できる。
  {
    const st = S.create({ session_key: 'aa1' });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: Date.now(), decision_id: 'daa1', basis: 'undercut' });
    S.markAwaitingJudgment(st, { decision_id: 'daa1', at: Date.now() });
    const before = S.resolvePendingProposal(st, { accepted: true, at: Date.now() });
    check(G, 'same_topic適用前は裸のacceptedで確定しない（前提確認）', before === null);
    const applied = S.applyProposalClassification(st, { classification: 'same_topic', decision_id: 'daa1', at: Date.now() });
    check(G, 'same_topicは適用できる', applied.applied && applied.outcome === 'kept_pending');
    check(G, 'same_topic後も提案自体・pit_planは変わらない',
      !!S.pendingProposal(st, { at: Date.now() }) && S.pitPlan(st) === null);
    const after = S.resolvePendingProposal(st, { accepted: true, at: Date.now() });
    check(G, 'same_topic後は裸のacceptedで確定できる（旧バグ：永久に確定不能だった）',
      after && after.accepted === true && S.pitPlan(st) && S.pitPlan(st).lap === 14,
      JSON.stringify({ after, plan: S.pitPlan(st) }));
  }

  // (A-2) router層：同じ流れを実routerで確認する。
  {
    const st = S.create({ session_key: 'aa2' });
    S.proposePlan(st, { plan_id: 'B', lap: 15, at: Date.now(), decision_id: 'daa2', basis: 'undercut' });
    router.route({ text: 'どうして？', lang: 'ja', live: {}, strategy: { state: st, api: S } }); // → awaiting_judgment
    S.applyProposalClassification(st, { classification: 'same_topic', decision_id: 'daa2', at: Date.now() });
    const r = router.route({ text: 'はい', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    check(G, 'same_topic適用後、実routerの「はい」で合意できる',
      S.pitPlan(st) && S.pitPlan(st).lap === 15, JSON.stringify({ r, plan: S.pitPlan(st) }));
  }

  // (A-3) applyProposalJudgeTag：same_topicは配送確認（onSpoken）を待ってから適用する。
  {
    const st = S.create({ session_key: 'aa3' });
    S.proposePlan(st, { plan_id: 'B', lap: 16, at: Date.now(), decision_id: 'daa3', basis: 'undercut' });
    S.markAwaitingJudgment(st, { decision_id: 'daa3', at: Date.now() });
    const ctx = makeJudgeCtx(st);
    // まだ再生されていない（_finalizedなし）queue item
    const pendingItem = { _finalized: null };
    ctx.lastQueuedSpeakItem = pendingItem;
    ctx.__apply({ decision_id: 'daa3', classification: 'same_topic' });
    check(G, 'A-3 配送前はawaiting_judgmentがまだ解除されない（同期的に即適用しない）',
      S.resolvePendingProposal(st, { accepted: true, at: Date.now() }) === null);
    check(G, 'A-3 onSpokenフックがitemへ仕込まれる', typeof pendingItem.onSpoken === 'function');
    // 実際に配送された（finalizeUtteranceがonSpokenを呼ぶのと同じ形）
    pendingItem._finalized = 'spoken';
    pendingItem.onSpoken();
    check(G, 'A-3 配送確認後は解除され、裸のacceptedで確定できる',
      S.resolvePendingProposal(st, { accepted: true, at: Date.now() }) !== null
      && S.pitPlan(st) && S.pitPlan(st).lap === 16, JSON.stringify(S.pitPlan(st)));
  }
  {
    // 既に配送済み（_finalized==='spoken'）のitemなら即座に適用する。
    const st = S.create({ session_key: 'aa4' });
    S.proposePlan(st, { plan_id: 'B', lap: 17, at: Date.now(), decision_id: 'daa4', basis: 'undercut' });
    S.markAwaitingJudgment(st, { decision_id: 'daa4', at: Date.now() });
    const ctx = makeJudgeCtx(st);
    ctx.lastQueuedSpeakItem = { _finalized: 'spoken' };
    ctx.__apply({ decision_id: 'daa4', classification: 'same_topic' });
    check(G, 'A-4 既に配送済みのitemなら即座に適用される',
      S.resolvePendingProposal(st, { accepted: true, at: Date.now() }) !== null);
  }
  {
    // 一度も配送されなかった（dropped）itemなら適用しない（沈黙、判定待ちのまま）。
    const st = S.create({ session_key: 'aa5' });
    S.proposePlan(st, { plan_id: 'B', lap: 18, at: Date.now(), decision_id: 'daa5', basis: 'undercut' });
    S.markAwaitingJudgment(st, { decision_id: 'daa5', at: Date.now() });
    const ctx = makeJudgeCtx(st);
    ctx.lastQueuedSpeakItem = { _finalized: 'dropped_before_audible' };
    ctx.__apply({ decision_id: 'daa5', classification: 'same_topic' });
    check(G, 'A-5 未配送(dropped)のitemなら適用しない（誤確定より沈黙）',
      S.resolvePendingProposal(st, { accepted: true, at: Date.now() }) === null);
  }
  {
    // confirm/decline/unrelatedは配送確認を待たず即時適用する（回帰）。
    const st = S.create({ session_key: 'aa6' });
    S.proposePlan(st, { plan_id: 'B', lap: 19, at: Date.now(), decision_id: 'daa6', basis: 'undercut' });
    S.markAwaitingJudgment(st, { decision_id: 'daa6', at: Date.now() });
    const ctx = makeJudgeCtx(st);
    ctx.lastQueuedSpeakItem = null; // 配送先の有無に関係なく即時適用されるはず
    ctx.__apply({ decision_id: 'daa6', classification: 'confirm' });
    check(G, '回帰：confirmはlastQueuedSpeakItemが無くても即時適用される',
      S.pitPlan(st) && S.pitPlan(st).lap === 19, JSON.stringify(S.pitPlan(st)));
  }

  // (B) stripProposalJudgeTag：未完成／未知タグの表示漏れを防ぐ。
  {
    const html2 = html; // 既に読み込み済み
    const ctx = makeJudgeCtx(S.create({ session_key: 'bb0' }));
    // B-1: 完全なタグ（回帰）
    const full = ctx.__strip('説明終わり。\n<<PW_JUDGE decision_id="d1" classification="confirm">>');
    check(G, 'B-1 完全なタグは除去され、judgmentが取れる（回帰）',
      full.text === '説明終わり。' && full.judgment
      && full.judgment.decision_id === 'd1' && full.judgment.classification === 'confirm',
      JSON.stringify(full));

    // B-2: 未完成（途中で切れた）タグ——開始位置で無条件に切り捨て、judgmentはnull
    const partial = ctx.__strip('説明終わり。\n<<PW_JUDGE decision_id="d1" clas');
    check(G, 'B-2 未完成タグは表示へ残らない（開始位置で切る）',
      partial.text === '説明終わり。' && !partial.text.includes('PW_JUDGE'), JSON.stringify(partial));
    check(G, 'B-2 未完成タグはjudgmentを生成しない（不正な指示で状態を動かさない）',
      partial.judgment === null);

    // B-3: 未知のclassification値——開始位置で切り捨て、judgmentはnull
    const unknown = ctx.__strip('説明終わり。\n<<PW_JUDGE decision_id="d1" classification="maybe">>');
    check(G, 'B-3 未知classification値は表示へ残らない',
      unknown.text === '説明終わり。' && !unknown.text.includes('PW_JUDGE'), JSON.stringify(unknown));
    check(G, 'B-3 未知classification値はjudgmentを生成しない', unknown.judgment === null);

    // B-4：★2026-09-14 Codex MD#1確認・実再現：1文字ずつ配信すると `<<PW`／`<<PW_`／
    //      `<<PW_J`等、マーカー完成前の接頭辞が表示へ残った（完全一致のindexOfだけでは
    //      検出できない）。末尾がマーカーの接頭辞と一致する断片も、その時点で切り捨てる。
    const oneChar = ctx.__strip('説明終わり。<');
    check(G, 'B-4 マーカー冒頭の断片（1文字）でもその時点で切り捨てる（Codex実再現の修正）',
      oneChar.text === '説明終わり。' && oneChar.judgment === null, JSON.stringify(oneChar));
    const fourChar = ctx.__strip('説明終わり。<<PW');
    check(G, 'B-4 4文字の断片（<<PW）も切り捨てる',
      fourChar.text === '説明終わり。' && fourChar.judgment === null, JSON.stringify(fourChar));
    const eightChar = ctx.__strip('説明終わり。<<PW_JUD');
    check(G, 'B-4 8文字の断片（<<PW_JUD）も切り捨てる',
      eightChar.text === '説明終わり。' && eightChar.judgment === null, JSON.stringify(eightChar));
    const markerStart = ctx.__strip('説明終わり。<<PW_JUDGE');
    check(G, 'B-4 マーカー開始10文字が揃った時点で切り捨てる',
      markerStart.text === '説明終わり。' && markerStart.judgment === null, JSON.stringify(markerStart));
    // 誤検出しないことも確認：全く無関係な"<"を含む文はそのまま。
    const unrelatedLt = ctx.__strip('5 < 10 という意味です。');
    check(G, 'B-4 無関係な"<"を含む文は誤って切り捨てない',
      unrelatedLt.text === '5 < 10 という意味です。' && unrelatedLt.judgment === null,
      JSON.stringify(unrelatedLt));

    // B-5: タグが無い通常の応答（回帰）
    const none = ctx.__strip('普通の説明文だけ。');
    check(G, 'B-5 タグが無い応答はそのまま（回帰）',
      none.text === '普通の説明文だけ。' && none.judgment === null);
  }
}

// ════════════════════════════════════════════════════════════════════
// ⑨ 2026-09-14 Codex MD#1：request_revision（入力世代）ガードの実再現
//    Codexが提供した正確な再現手順どおりに構成する：
//    12周合意→d1(14周)提案→「その提案に賛成だ」（callAPI開始・世代Rを捕獲）
//    →応答が届く前に「その提案への賛成は撤回したい」（同じd1へ2回目の
//    markAwaitingJudgment・世代R+1）→1回目の古い応答が遅れてconfirmを返す
//    →decision_id一致だけでは14周を誤確定していた（Codex実再現）。
// ════════════════════════════════════════════════════════════════════
{
  const G = '⑨9/14 request_revision';

  {
    const st = S.create({ session_key: 'gen1' });
    S.agreePitPlan(st, { lap: 12, source: 'driver', at: 1000 });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: Date.now(), decision_id: 'd1', basis: 'undercut' });
    router.route({ text: 'その提案に賛成だ', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    // ★callAPI()が「賛成だ」の送信直前に捕まえるのと同じ値を、ここでも同じ手段で取る。
    const requestRevision = S.pendingProposal(st, { at: Date.now() }).base_revision;

    // 応答が届く前に、同じ提案への2件目の曖昧な発話が来る（2回目のmarkAwaitingJudgment）。
    router.route({ text: 'その提案への賛成は撤回したい', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    check(G, '2件目の発話で入力世代が進む（base_revisionが変わる）',
      S.pendingProposal(st, { at: Date.now() }).base_revision !== requestRevision);

    // 1件目の古い応答が、捕獲済みの古いrequestRevisionを持って遅れて返ってくる。
    const staleApplied = S.applyProposalClassification(st,
      { classification: 'confirm', decision_id: 'd1', at: Date.now(), request_revision: requestRevision });
    check(G, '古い入力世代のconfirmは拒否される（Codex実再現の修正）',
      staleApplied.applied === false && staleApplied.reason === 'stale_request_generation',
      JSON.stringify(staleApplied));
    check(G, '古いconfirmはpit_planを14周へ確定しない（12周のまま）',
      S.pitPlan(st) && S.pitPlan(st).lap === 12, JSON.stringify(S.pitPlan(st)));
  }

  // 回帰：世代が進んでいなければ、同じrequest_revisionのconfirmは正しく適用される。
  {
    const st = S.create({ session_key: 'gen2' });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: Date.now(), decision_id: 'd2', basis: 'undercut' });
    router.route({ text: 'その提案に賛成だ', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    const requestRevision = S.pendingProposal(st, { at: Date.now() }).base_revision;
    const applied = S.applyProposalClassification(st,
      { classification: 'confirm', decision_id: 'd2', at: Date.now(), request_revision: requestRevision });
    check(G, '回帰：世代が進んでいなければ正しく適用される',
      applied.applied === true && S.pitPlan(st) && S.pitPlan(st).lap === 14, JSON.stringify(applied));
  }

  // 回帰：request_revision省略時は従来どおり世代照合をスキップする（テスト⑦⑧との後方互換）。
  {
    const st = S.create({ session_key: 'gen3' });
    S.proposePlan(st, { plan_id: 'B', lap: 14, at: Date.now(), decision_id: 'd3', basis: 'undercut' });
    router.route({ text: 'その提案に賛成だ', lang: 'ja', live: {}, strategy: { state: st, api: S } });
    const applied = S.applyProposalClassification(st,
      { classification: 'confirm', decision_id: 'd3', at: Date.now() }); // request_revision省略
    check(G, '回帰：request_revision省略時は世代照合しない',
      applied.applied === true && S.pitPlan(st) && S.pitPlan(st).lap === 14, JSON.stringify(applied));
  }

  // renderer.html側：callAPI()が送信直前にrequest_revisionを捕獲し、
  // applyProposalJudgeTag経由でapplyProposalClassificationへ渡す配線の確認。
  {
    check(G, 'callAPI()が送信直前にpending_proposalのbase_revisionを捕獲する',
      /const _judgeRequestRevision=_judgePendingAtRequest \? _judgePendingAtRequest\.base_revision : null;/.test(html));
    check(G, 'applyProposalJudgeTagがrequest_revisionを引数に取る',
      /function applyProposalJudgeTag\(judgment, requestRevision\)/.test(html));
    check(G, 'applyProposalJudgeTagがrequest_revisionをapplyProposalClassificationへ渡す',
      /request_revision:\(requestRevision===undefined\?null:requestRevision\)/.test(html));
    check(G, 'callAPI()内でapplyProposalJudgeTagへ_judgeRequestRevisionを渡す',
      /applyProposalJudgeTag\(_judged\.judgment, _judgeRequestRevision\)/.test(html));
  }
}

console.log(`\n${pass} checks passed, ${failures.length} failed.`);
if (failures.length) {
  console.error('\nFAILURES:\n' + failures.join('\n\n'));
  process.exit(1);
}
