// Session strategy state — 走行中の「合意した戦略」を1つの正本に集約する。
//
// なぜ要るか（2026-09-05 Build 298 実走・Codex 事後Gate §3）:
//   fuel履歴・race format・残時間／残周・pit実績・ドライバーと合意したPlanが
//   **別系統のまま**で、質問ごとに違う前提から答えていた。
//
//     18:22:48 Driver「この週でピットイン だ。」→ Luna「了解。この周の終わりでボックス。」
//     18:25:54 pit_entry ＝ **実際にピットした**
//     18:43:21 Luna「今はステイアウト。ピットウィンドウまで走れる。」← 17分前に済んだPlan
//     18:44:53 Luna「完走まで8.3L不足。Plan Aを継続」← 実際は 15.9L・残り約2周で足りている
//     18:51:35 Driver「戦略も毎回同じなんだけど、君が把握してないっていうのが一番痛いね。」
//
//   8.3L不足は「pit前の全レース距離」を前提に計算し続けた結果である。値の誤差ではなく、
//   **前提が更新されていない**ことが原因。だから個々の回答を直すのではなく、
//   前提そのものを1つの state に集めて revision で読む。
//
// 契約:
//   - Plan は合意・訂正・取消・実行のいずれでも revision が進む。
//   - pit を実行したら、その Plan は即座に失効する（履歴には残す）。
//   - 燃料の判定は**残り距離**に対して行う。全レース距離を前提に残さない。
//   - ドライバーの戦略申告は保存ACKで終わらせず、内容を短く復唱して返す。
//
// ★2026-09-13 提案と合意を分離（Codex反証「合意中のpit案を変える必要が出た場合、
//   どの経路が責任を持ってDriverへ変更を伝えるか」への対応・第一段）:
//   strategy-playbook.js の evaluateSwitch() が Plan B/C を発話しても、
//   この state の pit_plan（answerFuel/answerPitDecision が読む唯一の正本）は
//   一切更新されていなかった。エンジニアが「Plan B、アンダーカット候補」と
//   言った直後に driver が裸の「はい」を返しても、それは agreePitPlan を通らず
//   ただの相槌として消えるため、次に「何周目にピット？」と聞くと
//   「まだ決めていない」に戻る——**言ったことと state が食い違う**。
//   一方で 8/29 の教訓（裸の「はい」は確定にならない）もある。解は
//   「直前に何を提案したか」を pending_proposal として一時保持し、
//   その有効期限内の応答だけを合意へ昇格させる。提案なしの裸の「はい」は
//   従来どおり何も確定しない。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallSessionStrategyState = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const finite = v => {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    return Number.isFinite(Number(v)) ? Number(v) : null;
  };

  function create(input) {
    const opts = input && typeof input === 'object' ? input : {};
    return {
      session_key: String(opts.session_key || ''),
      revision: 0,
      pit_plan: null,        // {lap, source, at, plan_id}
      pit_executed: null,    // {lap, at}
      pending_proposal: null, // {plan_id, lap, at, decision_id, basis}。合意ではない
      history: [],           // 監査用。合意・訂正・取消・実行を全部残す
      driver_strategy: null, // ドライバー本人の申告
      laps_dispute: null,    // {driver_laps, sdk_laps_at_dispute, at}。訂正の保留（e09）
    };
  }

  function bump(st, entry) {
    st.revision += 1;
    st.history.push({ ...entry, revision: st.revision });
    return st.revision;
  }

  const revision = st => (st && Number.isInteger(st.revision) ? st.revision : 0);

  // 合意されたピット周。source は 'driver'（本人申告）か 'engineer'（提案の承認）。
  // plan_id は任意（strategy-playbook の A/B/C 等の由来を追跡するため）。
  function agreePitPlan(st, input) {
    if (!st) return null;
    const lap = finite(input && input.lap);
    if (lap === null) return null;
    const planId = (input && input.plan_id) ? String(input.plan_id) : null;
    st.pit_plan = { lap, source: String((input && input.source) || 'driver'),
      at: finite(input && input.at), plan_id: planId };
    bump(st, { kind: 'plan_agreed', lap, plan_id: planId, at: st.pit_plan.at });
    return st.pit_plan;
  }

  // エンジニア側の提案（Plan B/C 等）。**これは合意ではない。**
  // pit_plan（唯一の正本）はまだ動かさない。driver の応答を待つ短命の記録。
  //
  // ★2026-09-13 Codex差戻し（P1）：この提案は amendPitPlan／cancelPitPlan／
  //   recordPitExecuted／別経路の agreePitPlan のどれでも失効しないままだった。
  //   例：12周合意→14周提案→16周へ訂正→その後の「了解」が古い14周へ巻き戻る。
  //   個々の関数へ失効処理を足して回るのではなく、**提案時点の revision を
  //   焼き込み、以後 revision が動いたら無条件で無効**にする（この state の
  //   既存契約＝「前提はrevisionで読む」をそのまま使う）。agreePitPlan／
  //   amendPitPlan／cancelPitPlan／recordPitExecuted は全て bump() を通るため、
  //   提案後に何が起きても（訂正・取消・実行・別の直接合意）自動的に無効化される。
  function proposePlan(st, input) {
    if (!st) return null;
    const lap = finite(input && input.lap);
    if (lap === null) return null;
    const rev = bump(st, { kind: 'plan_proposed', plan_id: String((input && input.plan_id) || ''), lap,
      at: finite(input && input.at) });
    st.pending_proposal = {
      plan_id: String((input && input.plan_id) || ''),
      lap,
      at: finite(input && input.at),
      decision_id: String((input && input.decision_id) || ''),
      basis: String((input && input.basis) || ''),
      base_revision: rev,
    };
    return st.pending_proposal;
  }

  // 提案の判断期限。次周相当を大きく超えて「さっきの話」に裸のはいで
  // 合意させないための上限（秒読み中の会話幅を想定した固定値）。
  const PENDING_PROPOSAL_TTL_MS = 90 * 1000;

  function pendingProposal(st, input) {
    if (!st || !st.pending_proposal) return null;
    // ★state が提案後に動いていたら無効（訂正・取消・実行・別の直接合意と競合させない）。
    if (revision(st) !== st.pending_proposal.base_revision) return null;
    const at = finite(input && input.at);
    const proposedAt = finite(st.pending_proposal.at);
    if (at !== null && proposedAt !== null && at - proposedAt > PENDING_PROPOSAL_TTL_MS) return null;
    return st.pending_proposal;
  }

  // ★2026-09-13 Codex第6回差戻し：ローカルで意味が決まらずLLMへ渡る発話を
  //   「無効化」（旧・第5回で撤回済み）でも「無条件で温存」（旧・語彙緩和）でも
  //   扱わない第三の状態。「意味判定待ち」の間は提案を消さないが、**裸の相槌では
  //   確定させない**——確定させるのは意味判定（applyProposalClassification）だけ。
  //   decision_id を渡された時はその提案だけへ狙い撃ちで適用する。
  function markAwaitingJudgment(st, input) {
    const p = pendingProposal(st, { at: finite(input && input.at) });
    if (!p) return null;
    const wantDecisionId = input && input.decision_id !== undefined && input.decision_id !== null
      ? String(input.decision_id) : null;
    if (wantDecisionId !== null && p.decision_id !== wantDecisionId) return null;
    // ★bump() は revision を進める。proposePlan と同じ契約で、この呼出自体が
    //   作る新しい revision を base_revision へ書き戻さないと、pendingProposal() の
    //   「revision不変」チェックに自分自身が引っ掛かって即座に無効化されてしまう。
    const rev = bump(st, { kind: 'plan_awaiting_judgment', plan_id: p.plan_id, lap: p.lap,
      at: finite(input && input.at) });
    st.pending_proposal = { ...p, awaiting_judgment: true, base_revision: rev };
    return st.pending_proposal;
  }

  // 保留中の提案への応答。accepted=true で初めて pit_plan（正本）へ昇格する。
  // 期限切れ・失効済み・提案なしなら null を返し、呼び出し側は従来どおり
  // 「提案の裏付けが無い裸のはい」として扱う（何も確定しない）。
  //
  // ★2026-09-13：awaiting_judgment 中の**確定（accepted:true）**だけは拒否する
  //   （裸の相槌を承認にしない）。bypassJudgmentGate は applyProposalClassification
  //   （実際の意味判定の適用）専用の内部フラグで、router 等の一般呼び出しからは
  //   渡さない。明示的な拒否（accepted:false、「いや」等）は判定待ちでも通す——
  //   拒否の意思表示自体は曖昧ではないため。
  function resolvePendingProposal(st, input) {
    const at = finite(input && input.at);
    const proposal = pendingProposal(st, { at });
    if (!proposal) {
      if (st) st.pending_proposal = null;   // 死んだ提案の掃除。bumpはしない
      return null;
    }
    const accepted = (input && input.accepted) === true;
    if (proposal.awaiting_judgment === true && accepted
        && !(input && input.bypassJudgmentGate === true)) {
      return null;
    }
    st.pending_proposal = null;
    if (!accepted) {
      bump(st, { kind: 'plan_declined', plan_id: proposal.plan_id, lap: proposal.lap, at });
      return { accepted: false, proposal, plan: pitPlan(st) };
    }
    const plan = agreePitPlan(st, { lap: proposal.lap, source: 'engineer', at, plan_id: proposal.plan_id });
    return { accepted: true, proposal, plan };
  }

  // ★2026-09-13 Codex差戻し（P1-B）：提案の直後に無関係な話（「データ入ってる？」等）
  //   を挟んでから「了解」が来ても、まだ期限内・revision不変なら古い提案を合意させて
  //   しまっていた。「直前の話」でなくなったら明示的にここで捨てる
  //   （router 側が「提案を承認/却下する応答以外の何かを処理した」時に呼ぶ）。
  //   同（audible_interrupted）：発話の冒頭だけ聞こえて中断された場合も、
  //   その提案は正しく聞いたことにしない。decision_id を渡された時は
  //   その提案だけを狙い撃ちで捨てる（無関係な後発の提案を巻き込まない）。
  function invalidatePendingProposal(st, input) {
    if (!st || !st.pending_proposal) return null;
    const wantDecisionId = input && input.decision_id !== undefined && input.decision_id !== null
      ? String(input.decision_id) : null;
    if (wantDecisionId !== null && st.pending_proposal.decision_id !== wantDecisionId) return null;
    const prev = st.pending_proposal;
    st.pending_proposal = null;
    bump(st, { kind: 'plan_proposal_invalidated', plan_id: prev.plan_id, lap: prev.lap,
      reason: String((input && input.reason) || ''), at: finite(input && input.at) });
    return prev;
  }

  // ★2026-09-13 Codex第5回差戻し：「提案語彙の有無」という文言ヒューリスティックは
  //   「どうして？」（語彙を含まないが同じ相談の継続）を誤って別話題扱いし、
  //   「その案という英語を教えて」（語彙を含むが実際は無関係な語学質問）を誤って
  //   同じ相談として温存する、という両方向の反例をCodexが実routerで示した。
  //   90秒TTLは古さの上限であって意味の同一性の根拠にならない、という指摘のとおり。
  //
  //   この関数は「意味理解（本物の分類）」そのものではなく、**分類結果を安全に
  //   適用する接続層**である。分類（confirm/decline/same_topic/unrelated）は
  //   将来、実LLM呼出等の外部処理が行う——ここでは決めない。Codexの言う
  //   「決定論の接続検査は保存応答／mockで可能」に対応する部分がこれで、
  //   実際の意味判定の質は別途の検証課題として残る（未実装・未検証と明記）。
  //
  //   stale guard：decision_id が一致し、かつ pendingProposal() 自体が有効
  //   （revision不変・TTL内）である時だけ適用する。非同期で遅れて届いた
  //   分類結果が、既に動いた状態や別の提案を勝手に上書きしないため。
  //
  //   ★2026-09-13 Codex第6回差戻し：decision_id の省略を許すと、対象を取り違えた
  //   ／古い外部応答がたまたま今pendingなものへ紛れ込む。**外部からの分類適用は
  //   対象IDの提示を必須**にする（省略時は no_pending_proposal と別の理由で拒否）。
  //
  //   ★2026-09-14 Codex MD#1確認・実再現：decision_id一致だけでは不十分だった。
  //   12周合意→d1(14周)提案→「その提案に賛成だ」（callAPI開始）→そのfetch応答が
  //   届く前に「その提案への賛成は撤回したい」（同じd1へ2回目のmarkAwaitingJudgment）
  //   →1回目の**古い**応答が遅れて confirm を返すと、decision_id=d1 は一致した
  //   ままなので14周が確定してしまう。「いや」等の明示的拒否や、別decision_idへの
  //   再提案、直接invalidateとは異なる入力で、既存の3ガードでは検出できない。
  //   これは「対象」ではなく「入力世代」の古さ——リクエスト送出時点の
  //   base_revision（=その時点までの markAwaitingJudgment／訂正／再提案の回数を
  //   反映する）を呼び出し側が持ち歩き、適用時に**今も同じか**を照合する。
  //   省略時（request_revision未指定）は従来どおり世代照合をスキップする
  //   （テストの直接呼出など、世代を意識しない呼び出し元との後方互換）。
  function applyProposalClassification(st, input) {
    const at = finite(input && input.at);
    const classification = String((input && input.classification) || '');
    const wantDecisionId = input && input.decision_id !== undefined && input.decision_id !== null
      ? String(input.decision_id) : null;
    const requestRevision = input && input.request_revision !== undefined && input.request_revision !== null
      ? input.request_revision : null;
    const current = pendingProposal(st, { at });
    if (!current) return { applied: false, reason: 'no_pending_proposal' };
    if (wantDecisionId === null) return { applied: false, reason: 'decision_id_required' };
    if (current.decision_id !== wantDecisionId) {
      return { applied: false, reason: 'stale_classification_target_mismatch' };
    }
    if (requestRevision !== null && current.base_revision !== requestRevision) {
      return { applied: false, reason: 'stale_request_generation' };
    }
    if (classification === 'confirm') {
      return { applied: true, outcome: 'confirmed',
        resolved: resolvePendingProposal(st, { accepted: true, at, bypassJudgmentGate: true }) };
    }
    if (classification === 'decline') {
      return { applied: true, outcome: 'declined',
        resolved: resolvePendingProposal(st, { accepted: false, at, bypassJudgmentGate: true }) };
    }
    if (classification === 'same_topic') {
      // ★2026-09-14 Codex独立probe：ここで awaiting_judgment を解除しないと、
      //   一度「意味判定待ち」に入った提案は二度と裸の相槌で確定できなくなる
      //   （説明→same_topic→「はい」を送っても永久にawaiting_judgmentのまま）。
      //   pit_plan は動かさないが、以後の応答（次の「了解」等）を再び
      //   resolvePendingProposal の通常経路で確定できるようにする。
      //   ★呼び出し側（renderer.html の applyProposalJudgeTag）は、この解除を
      //   「この判定の根拠になった説明が実際にDriverへ届いた後」まで遅らせる
      //   契約——ここでは配送確認をしない・呼ばれたら即座に解除する。
      const rev = bump(st, { kind: 'plan_judgment_same_topic', plan_id: current.plan_id,
        lap: current.lap, at });
      st.pending_proposal = { ...current, awaiting_judgment: false, base_revision: rev };
      return { applied: true, outcome: 'kept_pending' };
    }
    if (classification === 'unrelated') {
      return { applied: true, outcome: 'invalidated',
        invalidated: invalidatePendingProposal(st,
          { at, decision_id: wantDecisionId, reason: 'classified_unrelated' }) };
    }
    return { applied: false, reason: 'unknown_classification' };
  }

  // 訂正。合意元（誰が決めたか）は引き継ぐ。訂正で「ドライバーが決めた」事実は消えない。
  function amendPitPlan(st, input) {
    if (!st || !st.pit_plan) return agreePitPlan(st, input);
    const lap = finite(input && input.lap);
    if (lap === null) return st.pit_plan;
    const prev = st.pit_plan;
    st.pit_plan = { lap, source: prev.source, at: finite(input && input.at),
      amended_from: prev.lap };
    bump(st, { kind: 'plan_amended', from: prev.lap, lap, at: st.pit_plan.at });
    return st.pit_plan;
  }

  function cancelPitPlan(st, input) {
    if (!st) return null;
    const prev = st.pit_plan;
    st.pit_plan = null;
    bump(st, { kind: 'plan_cancelled', from: prev ? prev.lap : null,
      at: finite(input && input.at) });
    return null;
  }

  // ★pit_entry が成立したらここを通す。旧Planは即座に失効する。
  function recordPitExecuted(st, input) {
    if (!st) return null;
    const lap = finite(input && input.lap);
    const at = finite(input && input.at);
    st.pit_executed = { lap, at, planned_lap: st.pit_plan ? st.pit_plan.lap : null };
    st.pit_plan = null;
    bump(st, { kind: 'pit_executed', lap, at });
    return st.pit_executed;
  }

  const pitPlan = st => (st && st.pit_plan ? st.pit_plan : null);
  const pitExecuted = st => (st && st.pit_executed ? st.pit_executed : null);

  // ピット判断の回答。**実行済みなら古い「ステイアウト」を絶対に出さない。**
  //
  // ★2026-09-13 Codex差戻し（P1）：pit_executed を pit_plan より先に見ていたため、
  //   耐久の追加pit（12周で1回目実行→20周へ新たに合意）で「12周目でピット済み。
  //   残り8周、このまま走り切る。」に固定され、合意した2回目のpitを一切答えなかった。
  //   recordPitExecuted は実行のたびに pit_plan を必ず null にするので、pit_plan が
  //   非nullである時点でそれは**実行後に新しく合意された作戦**でしかありえない
  //   （古い実行前Planが紛れ込む余地が無い）。だから pit_plan を先に見てよい。
  //   履歴（pit_executed）は消さず、優先順位だけを直す。
  // ★2026-09-13 Codex第3回差戻し：確定Planと保留提案が両方ある時、質問文だけでは
  //   「旧合意か新提案か」曖昧になる。以前は確定Planだけを答え、その直後に
  //   router側が「別の話題を処理した」と見なして提案を無効化していたため、
  //   Driverが提案について確認しただけで提案そのものが消えていた（自然な相談の
  //   継続を壊す）。曖昧なままにせず、両方を区別して伝える。
  function pendingProposalMention(st, at) {
    const p = pendingProposal(st, { at });
    if (!p) return '';
    if (st.pit_plan && st.pit_plan.lap === p.lap) return '';
    return `提案中は${p.lap}周目、まだ合意していない。`;
  }

  function answerPitDecision(st, input) {
    const at = finite(input && input.at);
    const lapsRemaining = finite(input && input.laps_remaining);
    if (!st) return { reply: 'ピット周はまだ決めていない。', state: 'unknown', revision: 0 };
    const mention = pendingProposalMention(st, at);
    if (st.pit_plan) {
      return { reply: `${st.pit_plan.lap}周目でボックス。合意どおり。${mention}`,
        state: 'planned', revision: revision(st), at };
    }
    if (st.pit_executed) {
      const done = st.pit_executed;
      const tail = lapsRemaining !== null ? `残り${lapsRemaining}周、このまま走り切る。` : 'このまま走り切る。';
      return {
        reply: (done.lap !== null ? `${done.lap}周目でピット済み。` : 'ピットは済んでいる。') + tail + mention,
        state: 'executed', revision: revision(st), at,
      };
    }
    return { reply: `ピット周はまだ決めていない。${mention}`, state: 'none', revision: revision(st), at };
  }

  // 燃料は**残り距離**に対して判定する。全レース距離を前提に残さない。
  //
  // ★2026-09-11 実走Gate 8不合格で判明：laps_remaining（残り周回の権威値）が
  //   未確定なだけで、実測済みの現在燃料・平均燃費まで一括で「まだ足りない」と
  //   拒否していた（20:30:38、燃料99.0L・燃費実測済みなのに全否定）。
  //   Yuji指示「同一driver/車/sessionの有効燃費は暫定基準として即継続し…
  //   新周回取得まで全回答を停止させない」に従い、権威値の確定度に応じて
  //   段階的に言える範囲まで答える。確定済みの必要量／過不足の断定は、
  //   laps（残り周回の権威値）が揃った時だけ行う——ここは変えない。
  // ★2026-09-14 Yuji指示「既存11イベントfixtureと実ログを製品経路へ接続」：
  //   `session-memory.strategyFuelEvidence()`（本人・同条件の過去燃費、確認済み・
  //   独自テスト済み）が answerFuel の梯子へ一度も配線されていなかった
  //   （2026-09-13独立調査で既知だった未接続。desktop/session-memory.js:202）。
  //   ライブ実測が無い時だけ、呼び出し側が渡す history_per_lap_l を**暫定根拠**
  //   として使う。実測（'live'）と履歴（'history'）を混同しないよう、返答へ
  //   出典を必ず載せる——「前回実績」という言葉が「今の実測」より弱い根拠だと
  //   分かる形にする。history基準の値は shortfall（過不足）の断定にも使うが、
  //   その時も返答は「前回実績ベースの推定」と明示し、実測とは言わない。
  // ══ driver の残り周回訂正（fixture e09）══════════════════════════════
  // 「残り、一周少なく数えてない？ あと9周だよ。」——SDK は8周と言っている。
  // GAP には既に同型の保留（gap-freshness.disputeGap / gapHoldStatus）があるのに、
  // laps_remaining には無かった。無いと二択の悪手しか残らない：
  //   (a) driver 申告を黙って採用する＝申告を実測と偽る
  //   (b) SDK 8周のまま継続する＝訂正を無視して旧案を押し通す
  // どちらもレースエンジニアの仕事ではない。**両方の数を区別したまま条件付きで
  // 答え、次の観測で確定する**のが正しい。GAPの保留と同じ契約にする：
  //   - 保留は driver 申告時に立つ（申告値は「driver申告」としてのみ保持）
  //   - 解除は**新しい観測が来た時だけ**（時間経過では解かない）
  //   - 保留中は SDK 値を唯一の事実として断定しない
  const observationId = input => {
    if (!input) return null;
    const raw = input.observation_id;
    if (raw === null || raw === undefined || raw === '') return null;
    return String(raw);
  };

  function disputeLapsRemaining(st, input) {
    if (!st) return null;
    const driverLaps = finite(input && input.driver_laps);
    if (driverLaps === null || driverLaps < 0) return null;
    const sdkLaps = finite(input && input.laps_remaining);
    const at = finite(input && input.at);
    if (sdkLaps !== null && sdkLaps === driverLaps) {
      // 申告とSDKが一致＝争いがない。保留は立てない（立てると解除条件が来ない）。
      st.laps_dispute = null;
      return { held: false, agreed: true, laps_remaining: sdkLaps, driver_laps: driverLaps };
    }
    bump(st, { kind: 'laps_disputed', driver_laps: driverLaps, sdk_laps: sdkLaps, at });
    st.laps_dispute = { driver_laps: driverLaps, sdk_laps_at_dispute: sdkLaps, at,
      observation_id_at_dispute: observationId(input), reason: 'driver_disputed' };
    return { held: true, agreed: false, ...st.laps_dispute };
  }

  // 現在の保留状態。
  //
  // ★2026-09-14 Codex差戻し（MD#6 P1）：旧実装は「SDK値が訂正時点から変わったか」で
  //   解除していた。これは2つの点で誤りだった。
  //   (1) 訂正時にSDK値が欠損（null）だと、以後どんな正常観測が来ても
  //       `sdkNow !== null_at_dispute` の比較が成立せず**永久に保留**になった。
  //   (2) 「新しい観測が来た時だけ解除」と言いながら、実装は**値の変化**を新観測の
  //       代用にしていた。同じ8という新しい観測でdriver申告9が否定されても解除できない。
  //   正しくは観測そのものの同一性で判断する。呼び出し側が観測ID（snapshotの識別子）を
  //   渡し、IDが変われば値が同じでも新SDK値を採用して解除する。IDが渡らない古い
  //   呼び出しでは従来の値変化規則へ落ちる（黙って永久保留にしない）。
  //   null→finite は、どちらの規則でも必ず解除する。
  function lapsRemainingStatus(st, input) {
    const sdkNow = finite(input && input.laps_remaining);
    const obsNow = observationId(input);
    const dispute = st && st.laps_dispute ? st.laps_dispute : null;
    if (!dispute) {
      return { held: false, released: false, laps_remaining: sdkNow, driver_laps: null,
        sdk_laps: sdkNow, source: sdkNow === null ? 'unavailable' : 'sdk' };
    }
    const release = reason => {
      const matched = sdkNow === dispute.driver_laps;
      st.laps_dispute = null;
      bump(st, { kind: 'laps_dispute_released', laps_remaining: sdkNow,
        matched_driver: matched, release_reason: reason, at: finite(input && input.at) });
      return { held: false, released: true, laps_remaining: sdkNow, sdk_laps: sdkNow,
        driver_laps: dispute.driver_laps, matched_driver: matched,
        release_reason: reason, source: 'sdk' };
    };
    const held = () => ({ held: true, released: false, laps_remaining: null, sdk_laps: sdkNow,
      driver_laps: dispute.driver_laps, source: 'held' });
    if (sdkNow === null) return held();               // 今の観測が無い＝比べる相手がいない
    // 欠損から復旧した観測は、値に関わらず必ず採用する（永久保留を作らない）。
    if (dispute.sdk_laps_at_dispute === null) return release('sdk_recovered');
    const obsAtDispute = dispute.observation_id_at_dispute === undefined
      ? null : dispute.observation_id_at_dispute;
    if (obsNow !== null && obsAtDispute !== null) {
      // 観測IDで判断できる：同一snapshotの再質問は保持、新しい観測なら値が同じでも解除。
      return obsNow === obsAtDispute ? held() : release('new_observation');
    }
    // 観測IDが無い呼び出し（旧経路）は従来どおり値の変化で判断する。
    return sdkNow !== dispute.sdk_laps_at_dispute ? release('value_changed') : held();
  }

  function answerFuel(st, input) {
    const fuel = finite(input && input.fuel_l);
    const laps = finite(input && input.laps_remaining);
    let perLap = finite(input && input.per_lap_l);
    let perLapIsHistory = false;
    if (perLap === null || perLap <= 0) {
      const historyPerLap = finite(input && input.history_per_lap_l);
      if (historyPerLap !== null && historyPerLap > 0) {
        perLap = historyPerLap;
        perLapIsHistory = true;
      }
    }
    if (fuel === null) {
      return { shortfall_l: null, laps_possible: null,
        reply: '現在燃料が取得できない。', revision: revision(st) };
    }
    if (perLap === null || perLap <= 0) {
      return { shortfall_l: null, laps_possible: null,
        reply: `現在燃料${fuel.toFixed(1)}L。燃費の実測がまだ足りない。`, revision: revision(st) };
    }
    const possible = fuel / perLap;
    const basisTag = perLapIsHistory ? `前回実績${perLap.toFixed(2)}L/周（暫定）` : `平均${perLap.toFixed(2)}L/周`;
    // ★e09：残り周回が係争中（driver申告 vs SDK）の間は、どちらか一方を事実として
    //   断定しない。両方の数で計算し、どちらがどちらの出所かを言ったうえで
    //   条件付きに答える。確定は次の観測（lapsRemainingStatus の解除）に委ねる。
    const dispute = (input && input.laps_dispute && typeof input.laps_dispute === 'object')
      ? input.laps_dispute : null;
    const disputeDriverLaps = dispute ? finite(dispute.driver_laps) : null;
    const disputeSdkLaps = dispute ? finite(dispute.sdk_laps) : null;
    if (disputeDriverLaps !== null && disputeSdkLaps !== null
        && disputeDriverLaps !== disputeSdkLaps) {
      const verdict = n => {
        const short = perLap * n - fuel;
        return short <= 0
          ? `${n}周なら足りている（残り${(fuel - perLap * n).toFixed(1)}L）`
          : `${n}周なら${short.toFixed(1)}L足りない`;
      };
      const low = Math.min(disputeSdkLaps, disputeDriverLaps);
      const high = Math.max(disputeSdkLaps, disputeDriverLaps);
      const noteBits = [];
      if (perLapIsHistory) noteBits.push('前回実績ベースの推定');
      return {
        shortfall_l: null,
        laps_possible: Math.round(possible * 10) / 10,
        laps_disputed: true,
        laps_conditional: { sdk_laps: disputeSdkLaps, driver_laps: disputeDriverLaps },
        fuel_basis: perLapIsHistory ? 'memory_previous' : 'live_measured',
        reply: `残り周回が食い違っている——こちらの計測は${disputeSdkLaps}周、君の申告は${disputeDriverLaps}周。`
          + `燃料${fuel.toFixed(1)}L・${basisTag}なら、${verdict(low)}、${verdict(high)}。`
          + `どちらか確定するまでは${high}周前提で動く${noteBits.length ? `（${noteBits.join('・')}）` : ''}。次の計測で言い直す。`,
        revision: revision(st),
      };
    }
    if (laps === null) {
      // 残り周回はまだ未確定。捏造せず、現在燃料と燃費から走行可能周回数
      // という「言える事実」だけを返す。必要量・過不足は断定しない。
      // ★Codex差戻し：「権威値」等の内部用語をそのまま無線口調に出さない。
      return { shortfall_l: null, laps_possible: Math.round(possible * 10) / 10,
        reply: `現在燃料${fuel.toFixed(1)}L、${basisTag}で約${Math.floor(possible)}周走行可能。まだ残り周回が確定していないから、必要量・過不足はまだ言えない。`,
        fuel_basis: perLapIsHistory ? 'memory_previous' : 'live_measured', revision: revision(st) };
    }
    const need = perLap * laps;
    const shortfall = need - fuel;
    const historyNote = perLapIsHistory ? '（前回実績ベースの推定。実測で更新する）' : '';
    if (shortfall <= 0) {
      return { shortfall_l: null, laps_possible: Math.round(possible * 10) / 10,
        reply: `残り${laps}周に対して燃料${fuel.toFixed(1)}L。足りている${historyNote}。`,
        fuel_basis: perLapIsHistory ? 'memory_previous' : 'live_measured', revision: revision(st) };
    }
    return { shortfall_l: Math.round(shortfall * 10) / 10,
      laps_possible: Math.round(possible * 10) / 10,
      reply: `残り${laps}周に${shortfall.toFixed(1)}L足りない${historyNote}。`,
      fuel_basis: perLapIsHistory ? 'memory_previous' : 'live_measured', revision: revision(st) };
  }

  // ドライバーの戦略申告。保存ACKだけで返さず、内容を短く復唱する。
  function restateDriverStrategy(st, input) {
    const text = String((input && input.text) || '').trim();
    const at = finite(input && input.at);
    if (!st || !text) return { reply: '', stored: false };
    st.driver_strategy = { text, at };
    bump(st, { kind: 'driver_strategy', at });
    const gist = text.length > 40 ? text.slice(0, 40) + '…' : text;
    return {
      reply: `「${gist}」だね。この方針で今のPlanを見る。`,
      stored: true, revision: revision(st),
    };
  }

  return { create, revision, agreePitPlan, amendPitPlan, cancelPitPlan,
    pitPlan, pitExecuted, recordPitExecuted, answerPitDecision, answerFuel,
    restateDriverStrategy, proposePlan, pendingProposal, resolvePendingProposal,
    invalidatePendingProposal, applyProposalClassification, markAwaitingJudgment,
    disputeLapsRemaining, lapsRemainingStatus };
}));
