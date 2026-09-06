// Build 298 実走 replay — ①PDDP ②GAP ③残周回 ④Plan/Memory
//
// 由来: 公開 Build 298 の実走ログ `OMORAY-bridge-debug-20260905-1738.log`
//       （Le Mans / Mercedes-AMG GT3 2020 / Qualify→Race→checker）と
//       公式結果 `eventresult-88487294.json`。
//       fixture は `fixtures/build298/` へ抽出済み（実ログ由来・合成ではない）。
//
// Codex 事後Gate（共有ログ 2026-09-05 17:38）の指示:
//   「次のBuildを採番する前に、保存済みログreplayで下記4系統を再現し、
//     同じ失敗が赤になる検査を先に作ること。」
//
// Founder 指示（2026-09-06）:
//   「4系統の赤テストを先に全部並べる。④→③→①→②の順で直す。
//     ②はBuild 297方式への追加修正ではなく構造の置き換え。
//     赤テストには『初期本文とTTSだけが変わる旧方式では不合格』を含める。」
//
// ★このファイルは**意図的に赤で始まる**。全緑になるまで commit・Build・公開はしない。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const failures = [];
function check(group, name, ok, detail) {
  if (ok) { pass++; return true; }
  failures.push(`[${group}] ${name}` + (detail ? '\n       ' + detail : ''));
  return false;
}
const read = rel => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const fixture = name => JSON.parse(read(path.join('fixtures/build298', name)));

const renderer = read('desktop/renderer.html');
const router = require('./desktop/local-intent-router.js');
const pddp = require('./desktop/pddp.js');

// ════════════════════════════════════════════════════════════════════
// ① PDDP — 母数10で語り、根拠を残さず、長い
// ════════════════════════════════════════════════════════════════════
//
// 実走 17:49:42:
//   CONVO [PDDP_BRIEFING] {"available":true,"sample_size":10,"focus":"consistency"}
//   「直近10レース、平均Incidents 1.7、最新iRating 2077。今回の重点は完走順位の
//     ばらつき。次の1レースは同じ判断を再現するを一つだけ試そう」
// 同時刻 MEMORY_BRIEFING / DECISION_BRIEFING / SETUP_MEMORY は全て unavailable。
// PDDP だけが別履歴から話し、採用した行の identity も集計式もログに無い＝監査不能。
{
  const G = '①PDDP';
  // 直近10戦。後半5戦（＝採用されるべき母数）は悪化している。
  const rows = [
    { subsession_id: 101, date: '2026-08-20', incidents: 0, finishPos: 5, irating: 2000 },
    { subsession_id: 102, date: '2026-08-21', incidents: 0, finishPos: 6, irating: 2010 },
    { subsession_id: 103, date: '2026-08-22', incidents: 1, finishPos: 4, irating: 2020 },
    { subsession_id: 104, date: '2026-08-23', incidents: 0, finishPos: 7, irating: 2030 },
    { subsession_id: 105, date: '2026-08-24', incidents: 1, finishPos: 5, irating: 2040 },
    { subsession_id: 106, date: '2026-08-30', incidents: 2, finishPos: 9, irating: 2050 },
    { subsession_id: 107, date: '2026-08-31', incidents: 3, finishPos: 12, irating: 2055 },
    { subsession_id: 108, date: '2026-09-01', incidents: 4, finishPos: 14, irating: 2060 },
    { subsession_id: 109, date: '2026-09-02', incidents: 3, finishPos: 11, irating: 2070 },
    { subsession_id: 110, date: '2026-09-03', incidents: 5, finishPos: 15, irating: 2077 },
  ];

  // ①-1 母数は5。実走は10で話した。
  const s = pddp.analyze(rows);
  check(G, '母数は直近5戦（実走は10戦で話した）', s.sample_size === 5,
    `sample_size=${s.sample_size}`);

  // ①-2 採用行の identity・各incident・合計・平均・直前5件との増減を証拠化する。
  //     これが無い限り平均値を独立再計算できず、製品としては監査不能。
  const ev = typeof pddp.briefingEvidence === 'function' ? pddp.briefingEvidence(rows) : null;
  check(G, 'briefingEvidence() が存在する', !!ev,
    'PDDP に採用根拠を外へ出すAPIが無い＝ログから平均を再計算できない');
  if (ev) {
    check(G, '採用5件の identity を持つ',
      Array.isArray(ev.adopted) && ev.adopted.length === 5
      && ev.adopted.every(r => r.subsession_id != null && r.date && r.incidents != null),
      JSON.stringify(ev.adopted));
    check(G, '合計・平均・直前5件との増減を持つ',
      Number.isFinite(ev.incident_sum) && Number.isFinite(ev.incident_average)
      && Number.isFinite(ev.incident_delta_vs_prev),
      JSON.stringify(ev));
    check(G, '平均が採用5件から再計算できる',
      ev.incident_average === (2 + 3 + 4 + 3 + 5) / 5, String(ev.incident_average));
  }

  // ①-3 発話は「事実＋一行動」。実走の定型末尾は冗長で行動になっていない。
  const line = pddp.briefingLine(pddp.analyze(rows), 'ドライバー');
  check(G, '発話に定型の「次の1レースは…一つだけ試そう」を含まない',
    typeof line === 'string' && !/次の1レースは.*一つだけ試そう/.test(line), line);
  check(G, '発話は事実＋一行動（60字以内）',
    typeof line === 'string' && line.length <= 60, `${line && line.length}字: ${line}`);

  // ★①-w 配線。既定値を直しても、製品が `{limit:10}` を明示的に渡していれば
  //   実走の「直近10レース」は変わらない（`renderer.html:5177`）。
  //   ④で4回続けた「動くコードを書いたが繋がっているかを検査していない」を先に塞ぐ。
  // ★`[^)]*` は `loadRaceHistory()` の `)` を越えられず**偽の緑**になった。
  //   呼出し位置から一定範囲を切り出して見る。
  {
    const at = renderer.indexOf('PitwallPddp.analyze(');
    const callSite = at < 0 ? '' : renderer.slice(at, at + 120);
    check(G, '製品が analyze へ limit:10 を渡していない',
      at >= 0 && !/limit:\s*10\b/.test(callSite),
      `renderer.html の呼出し: ${callSite.split('\n')[0]}`);
  }
  check(G, 'PDDP_BRIEFING trace が採用根拠を残す',
    /diagnosticLog\('PDDP_BRIEFING'[\s\S]{0,400}?adopted/.test(renderer),
    'trace に採用5件の identity・合計・平均・増減が無い＝平均値を独立再計算できない');
  check(G, 'PDDP_BRIEFING trace の母数が発話と同じ値を使う',
    /sample_size:_pddp&&_pddp\.sample_size/.test(renderer),
    '表示・音声・traceで母数が食い違い得る');

  // ★①-P1-1（Codex差戻し 2026-09-06）：発話閾値が Founder 方針と違った。
  //   Founder は「直近5レース平均Incidents 5以上」を会話判断の数値例として明示。
  //   `delta>0` だけだと**平均0.2でも喋り**、ブリーフィングを不要情報で増やす。
  {
    const mk = (prevInc, recentInc) => Array.from({ length: 10 }, (_, i) => ({
      subsession_id: 500 + i, date: `2026-08-${String(i + 1).padStart(2, '0')}`,
      incidents: i < 5 ? prevInc : recentInc, finishPos: 10, irating: 2000,
    }));
    check(G, 'P1-1 平均5未満の微増では沈黙する（0.0→0.2）',
      !pddp.briefingLine(pddp.analyze(mk(0, 0.2)), 'ドライバー'),
      JSON.stringify(pddp.briefingLine(pddp.analyze(mk(0, 0.2)), 'ドライバー')));
    check(G, 'P1-1 平均5未満なら大きな増加でも沈黙する（0.0→4.0）',
      !pddp.briefingLine(pddp.analyze(mk(0, 4)), 'ドライバー'),
      JSON.stringify(pddp.briefingLine(pddp.analyze(mk(0, 4)), 'ドライバー')));
    const spoken = pddp.briefingLine(pddp.analyze(mk(2, 5)), 'ドライバー');
    check(G, 'P1-1 平均5以上かつ悪化なら発話する（2.0→5.0）', !!spoken, JSON.stringify(spoken));
    check(G, 'P1-1 平均5以上でも横ばいなら沈黙する（5.0→5.0）',
      !pddp.briefingLine(pddp.analyze(mk(5, 5)), 'ドライバー'),
      JSON.stringify(pddp.briefingLine(pddp.analyze(mk(5, 5)), 'ドライバー')));
    check(G, 'P1-1 平均5以上でも改善なら沈黙する（8.0→5.0）',
      !pddp.briefingLine(pddp.analyze(mk(8, 5)), 'ドライバー'),
      JSON.stringify(pddp.briefingLine(pddp.analyze(mk(8, 5)), 'ドライバー')));
    // 継続注意：Incidents は接触だけではない（オフトラック・スピンも含む）。
    check(G, 'P1-1 文言が Incidents を接触だと断定しない',
      /インシデントを減らして/.test(String(spoken)) && !/接触を減らして/.test(String(spoken)),
      String(spoken));
  }

  // ★①-P1-2：identity 欠損でも発話できてしまっていた。
  //   「採用レースを独立照合できない」という Build 298 の根本を閉じない。
  {
    const noId = Array.from({ length: 10 }, (_, i) => ({
      date: null, incidents: i < 5 ? 2 : 5, finishPos: 10, irating: 2000,
    }));
    const ev = pddp.briefingEvidence(noId);
    check(G, 'P1-2 identity の無い行は adopted へ入れない',
      ev.adopted.every(r => r.subsession_id != null || r.identity != null),
      JSON.stringify(ev.adopted));
    check(G, 'P1-2 identity 欠損なら沈黙する',
      !pddp.briefingLine(pddp.analyze(noId), 'ドライバー'),
      JSON.stringify(pddp.briefingLine(pddp.analyze(noId), 'ドライバー')));

    // 旧レコード（subsession_id 無し）は date 等から再現可能な identity を作れる。
    const legacy = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, '0')}`, track: 'Le Mans',
      car: 'Mercedes-AMG GT3 2020', incidents: i < 5 ? 2 : 6, finishPos: 10, irating: 2000,
    }));
    const evL = pddp.briefingEvidence(legacy);
    check(G, 'P1-2 旧レコードは date 等から一意な identity を正規化する',
      evL.adopted.length === 5 && evL.adopted.every(r => !!r.identity)
      && new Set(evL.adopted.map(r => r.identity)).size === 5,
      JSON.stringify(evL.adopted));
    check(G, 'P1-2 identity が揃えば発話できる',
      !!pddp.briefingLine(pddp.analyze(legacy), 'ドライバー'),
      JSON.stringify(pddp.briefingLine(pddp.analyze(legacy), 'ドライバー')));

    // 現在窓・比較窓の完全性（5件揃っていること）
    const short = legacy.slice(0, 8);   // 比較窓が3件しかない
    check(G, 'P1-2 比較窓が5件揃わなければ沈黙する',
      !pddp.briefingLine(pddp.analyze(short), 'ドライバー'),
      JSON.stringify(pddp.briefingEvidence(short)));
    const holed = legacy.map((r, i) => (i === 7 ? { ...r, incidents: null } : r));
    check(G, 'P1-2 現在窓に incidents 欠損があれば沈黙する',
      !pddp.briefingLine(pddp.analyze(holed), 'ドライバー'),
      JSON.stringify(pddp.briefingEvidence(holed).excluded));

    // ★P1-2b（Codex 再差戻し 2026-09-06）：`identitiesUnique` が **現在窓だけ**を見ていた。
    //   比較窓5行が同一レースの重複でも `windows_complete=true` になり、
    //   「前の5戦から+3.0」と発話した。**要点は「5行ある」ではなく
    //   「異なる5レースを比較した」と証明できること。**
    const uniq = (o) => Array.from({ length: 10 }, (_, i) => ({
      subsession_id: o(i), date: `2026-07-${String(i + 1).padStart(2, '0')}`,
      track: 'Le Mans', car: 'Mercedes-AMG GT3 2020',
      incidents: i < 5 ? 3 : 6, finishPos: 10, irating: 2000,
    }));
    check(G, 'P1-2b 比較窓内の重複で沈黙する',
      !pddp.briefingLine(pddp.analyze(uniq(i => (i < 5 ? 1 : 600 + i))), 'ドライバー'),
      JSON.stringify(pddp.briefingEvidence(uniq(i => (i < 5 ? 1 : 600 + i))).windows_complete));
    check(G, 'P1-2b 現在窓内の重複で沈黙する',
      !pddp.briefingLine(pddp.analyze(uniq(i => (i < 5 ? 600 + i : 2))), 'ドライバー'),
      JSON.stringify(pddp.briefingEvidence(uniq(i => (i < 5 ? 600 + i : 2))).windows_complete));
    check(G, 'P1-2b 窓を跨ぐ重複で沈黙する',
      !pddp.briefingLine(pddp.analyze(uniq(i => 700 + (i % 5))), 'ドライバー'),
      JSON.stringify(pddp.briefingEvidence(uniq(i => 700 + (i % 5))).windows_complete));
    check(G, 'P1-2b 10件すべて一意なら発話できる',
      !!pddp.briefingLine(pddp.analyze(uniq(i => 800 + i)), 'ドライバー'),
      JSON.stringify(pddp.briefingLine(pddp.analyze(uniq(i => 800 + i)), 'ドライバー')));

    // legacy identity でも同じ一意性契約が効くこと（date を潰して重複させる）
    const legacyDup = legacy.map((r, i) => (i < 5
      ? { ...r, date: '2026-08-01', recordedAt: '2026-08-01T10:00:00.000Z' } : r));
    check(G, 'P1-2b legacy identity にも同じ一意性契約を適用する',
      !pddp.briefingLine(pddp.analyze(legacyDup), 'ドライバー'),
      JSON.stringify(pddp.briefingEvidence(legacyDup).windows_complete));

    // 比較窓の内訳も独立再計算できること
    const evOk = pddp.briefingEvidence(uniq(i => 800 + i));
    check(G, 'P1-2b trace から比較窓の内訳を再計算できる',
      Array.isArray(evOk.previous) && evOk.previous.length === 5
      && evOk.previous.every(r => r.identity && r.incidents != null)
      && evOk.previous.reduce((a, r) => a + r.incidents, 0) / 5 === evOk.prev_incident_average,
      JSON.stringify(evOk.previous));
    check(G, 'P1-2b 製品 trace が比較窓の内訳を出す',
      /previous:_pddpEv&&_pddpEv\.previous/.test(renderer),
      'PDDP_BRIEFING に previous が無い＝前5件の内訳を独立再計算できない');
  }

  // ①-4 横ばい・改善・証拠不足なら無理に話さない。
  //   ★5件だけだと「直前5戦が無い＝証拠不足」で黙るため、**横ばいの分岐を
  //     通っていなかった**（変異M2が素通り・2026-09-06）。10件で比較窓を作る。
  const flat = rows.map((r, i) => ({ ...r, subsession_id: 300 + i, incidents: 1 }));
  const flatLine = pddp.briefingLine(pddp.analyze(flat), 'ドライバー');
  check(G, '横ばい（前5戦と同じ）なら沈黙する', !flatLine, JSON.stringify(flatLine));
  const better = rows.map((r, i) => ({ ...r, subsession_id: 400 + i, incidents: i < 5 ? 5 : 1 }));
  check(G, '改善しているなら沈黙する',
    !pddp.briefingLine(pddp.analyze(better), 'ドライバー'),
    JSON.stringify(pddp.briefingLine(pddp.analyze(better), 'ドライバー')));
  check(G, '証拠不足（比較窓が無い）なら沈黙する',
    !pddp.briefingLine(pddp.analyze(rows.slice(0, 3)), 'ドライバー'),
    JSON.stringify(pddp.briefingLine(pddp.analyze(rows.slice(0, 3)), 'ドライバー')));
}

// ════════════════════════════════════════════════════════════════════
// ② GAP — 「先に表示し、TTS直前に本文を作り替える」構造そのもの
// ════════════════════════════════════════════════════════════════════
//
// 実走 18:14:24:
//   CONVO [LunaJP] 後ろ3.7秒。1.6秒縮んだ。      ← 表示・会話Boxへ先に出た
//   GAP_FRESHNESS fate=rebuild was=3.7 now=4.84
//   UTTERANCE_FINAL uid=u13 outcome=rebuilt text="後ろ4.8秒。"  ← 音声だけ差し替え
//
// 実走の rebuild は10回。fixture は全件を実ログから抽出したもの。
// **求める構造**: authority確定 → 最終本文を1回生成 → Overlay・会話Box・TTSへ fan-out。
{
  const G = '②GAP';
  const rebuilds = fixture('gap-rebuilds.json');
  check(G, '実走 rebuild を10件 replay できる', rebuilds.length === 10, `件数=${rebuilds.length}`);

  // ②-1 ★Founder明示条件：初期本文とTTSだけが変わる旧方式では不合格。
  //     finalizeUtterance に「表示後に本文を差し替える」分岐が残っていたら赤。
  check(G, '旧方式（表示後amend）が製品に残っていない',
    !/outcome === 'rebuilt'/.test(renderer),
    "renderer.html の finalizeUtterance に outcome==='rebuilt' 分岐が残っている"
    + '＝表示してから作り替える構造。置き換え対象');
  check(G, 'Overlay本文の後追い差し替えを行わない',
    !/overlayPush\(\{ update:true, id:[^}]*text:finalText/.test(renderer),
    'overlayPush({update,text:finalText}) が残っている＝表示後に上書きしている');

  // ★②-1b 「旧方式が消えた」だけでは足りない。**候補を表示していないこと**と
  //   **確定本文を喋っていること**を名指しで見る。これが無いと、
  //   injectRadio を旧方式へ戻す変異も、確定本文を捨てて候補文を喋る変異も
  //   素通りした（2026-09-06 変異M1・M3）。
  check(G, '自発GAPは候補を表示しない',
    /const _radioEl = _isGapCandidate \? null : addMsg\('ai',text,\{uid:_uid\}\);/.test(renderer),
    'injectRadio が候補文をそのまま表示している＝旧方式');
  check(G, 'PTT回答のGAPも候補を表示しない',
    /const _ansEl = _ansIsGap \? null : addMsg\('ai',reply,\{uid:_ansUid\}\);/.test(renderer),
    '回答経路が候補文をそのまま表示している');
  check(G, '喋る本文が authority から作った本文である（自発）',
    /_it\.text = _final;/.test(renderer),
    'drainQueue が確定本文を item へ入れていない＝候補文を喋る');
  check(G, '喋る本文が authority から作った本文である（PTT回答）',
    /_it\.text = _ansFinal;/.test(renderer),
    '回答経路が確定本文を item へ入れていない');

  // ②-2 authority確定後に最終本文を1回だけ作るAPIが要る。
  const hasBuilder = /function buildGapUtterance\s*\(/.test(renderer);
  check(G, 'buildGapUtterance(authority) が存在する', hasBuilder,
    'authority snapshot から最終本文を1回生成する関数が無い');

  if (hasBuilder) {
    // fixture の全件で、authority値から作った本文＝実走の最終音声本文になること。
    const src = grabFunction(renderer, 'buildGapUtterance');
    const ctx = { console };
    vm.createContext(ctx);
    vm.runInContext(src + '\nglobalThis.__b = buildGapUtterance;', ctx);
    for (const r of rebuilds) {
      const out = ctx.__b({ direction: r.fresh.now === null ? null : (/後ろ/.test(r.final) ? 'behind' : 'ahead'),
        gap_s: r.fresh.now, target_car_idx: r.fresh.target, trend: null, lang: 'ja' });
      check(G, `${r.t} 最終本文が authority 値から1回で出る`, out === r.final,
        `期待="${r.final}" 実際="${out}"`);
    }
  }

  // ②-3 fan-out の同一性をログで証明できること。
  //     現行の `UTTERANCE_FINAL ... ovl=Lxx` はID一致を示すだけで、
  //     Overlay本文が最終本文になった証拠ではない（Codex 反証依頼）。
  check(G, 'UTTERANCE_FINAL が overlay_text を残す',
    /overlay_text=/.test(renderer),
    'Overlay へ渡した最終本文が trace に無い＝画面一致を独立検証できない');
  check(G, 'UTTERANCE_FINAL が box_text と tts_text を残す',
    /box_text=/.test(renderer) && /tts_text=/.test(renderer),
    '会話Box本文・TTS本文が trace に無い');

  // ②-4 trend は最終GAPと同一 snapshot 系列でしか語らない。
  //     実走の候補は古い snapshot 間の差（「1.6秒縮んだ」）を持ったまま表示された。
  const withTrend = rebuilds.filter(r => /縮んだ|開いた/.test(r.candidate));
  check(G, `候補が古いtrendを持って表示された（${withTrend.length}件）を再現`,
    withTrend.length > 0, '');
  check(G, 'trendは同一snapshot系列でのみ生成する契約がある',
    /trend_snapshot_series|sameSnapshotSeries/.test(renderer),
    'trend の出所を snapshot 系列に縛る実装が無い');
}

// ════════════════════════════════════════════════════════════════════
// ③ 残周回 — 自動通知・直接質問・LLMフォールバックが別authority
// ════════════════════════════════════════════════════════════════════
//
// 実走の実文字列（STTが「周」を「週」と書き起こしている）:
//   18:36:09 あと何周 だっけ？        → laps_remaining（confidence=unavailable）
//   18:42:57 あと何週？               → LOCAL_INTENT_BYPASS unhandled → 「残り3分59秒。」
//   18:43:20 この周囲 入れて あと2週かな？ → unhandled → intent=pit_decision へ誤分類
//   18:30:42 （自動）「残り5周。」    → 別経路では周回が出ていた
{
  const G = '③残周回';
  const live = {
    session_time_remaining_s: 239,
    finish_crossings_authority: 2,
    race_plan: { kind: 'timed', configured_duration_s: 2400 },
    laps_total: null,
  };
  const utterances = [
    'あと何周 だっけ？',
    'あと何週？',
    'この周囲 入れて あと2週かな？',
    'この周を入れてあと2周かな？',
  ];
  for (const text of utterances) {
    const r = router.route({ text, lang: 'ja', live });
    check(G, `「${text}」が laps_remaining へ入る`,
      r && r.handled && r.intent === 'laps_remaining',
      `handled=${r && r.handled} intent=${r && r.intent}`);
  }

  // ③-1b ★一般的な「週」まで一律変換しない（Founder固定要件）。
  //      ★route() 越しに intent を見るだけでは足りない。「来週も走る？」は
  //        周へ化けても laps_remaining の条件（残り／あと／何＋周）に当たらず、
  //        **一律変換の変異を検出できなかった**（2026-09-06 変異M2）。
  //        正規化そのものを直接検査する。
  const norm = router.normalizeLapWords;
  check(G, 'normalizeLapWords が公開されている', typeof norm === 'function');
  if (typeof norm === 'function') {
    for (const [before, after] of [
      ['何週目にピットインする？', '何周目にピットインする？'],
      ['この週でピットイン だ。', 'この周でピットイン だ。'],
      ['あと何週？', 'あと何周？'],
      ['この周囲 入れて あと2週かな？', 'この周囲 入れて あと2周かな？'],
      ['3週目でピット', '3周目でピット'],
    ]) check(G, `周回語を正規化：「${before}」`, norm(before) === after, norm(before));

    for (const keep of ['来週も走る？', '今週の予定は？', '先週のレースどうだった？',
      '週末のレース何時？', '毎週走ってる', '週明けにテスト', 'この週末は空いてる？']) {
      check(G, `一般語は変えない：「${keep}」`, norm(keep) === keep, norm(keep));
    }
  }
  for (const text of ['来週も走る？', '今週の予定は？', '先週のレースどうだった？', '週末のレース何時？']) {
    const r = router.route({ text, lang: 'ja', live });
    check(G, `「${text}」を周回質問へ化かさない`,
      !(r && r.handled && r.intent === 'laps_remaining'),
      `intent=${r && r.intent}`);
  }

  // ③-2 3経路が同じ関数を使うこと。実走では同じ正規表現と回答が
  //     `local-intent-router.js` と `renderer.html` に別々に複製されていた。
  const dupes = (renderer.match(/finish_crossings_authority/g) || []).length;
  check(G, '残周回の回答が renderer.html に複製されていない', dupes === 0,
    `renderer.html に finish_crossings_authority 参照が ${dupes} 箇所`
    + '（local-intent-router と二重実装）');

  // ★不在検査だけでは「委譲をやめた」変異を検出できない（2026-09-06 変異M1）。
  //   renderer の LLMフォールバックを**実際に実行**し、router と同じ答えを返すか見る。
  {
    const src = grabFunction(renderer, 'telemetryTruthFallback');
    check(G, 'telemetryTruthFallback を取り出せる', !!src);
    if (src) {
      const ctx = {
        console, globalThis: null,
        PitwallLocalIntentRouter: router,
        fmtDuration: (s, jp) => (jp ? `${Math.round(s)}秒` : `${Math.round(s)}s`),
        lastWeekendAuthority: null,
      };
      ctx.globalThis = ctx;
      vm.createContext(ctx);
      vm.runInContext(src + '\nglobalThis.__f = telemetryTruthFallback;', ctx);
      for (const text of ['あと何周 だっけ？', 'あと何週？', 'この周囲 入れて あと2週かな？']) {
        const viaRenderer = ctx.__f(live, text, true);
        const viaRouter = router.route({ text, lang: 'ja', live });
        check(G, `フォールバックが router と同じ答えを返す：「${text}」`,
          viaRenderer === (viaRouter && viaRouter.reply),
          `renderer="${viaRenderer}" router="${viaRouter && viaRouter.reply}"`);
      }
    }
  }

  // ③-3 権威が取れない時、自動コールと質問回答が矛盾しないこと。
  const noAuth = router.route({ text: 'あと何周？', lang: 'ja',
    live: { ...live, finish_crossings_authority: null } });
  check(G, '権威不足の回答は時間だけで終わらせず不確かさを明示する',
    noAuth && noAuth.handled && /確定できない|未確定/.test(String(noAuth.reply || '')),
    JSON.stringify(noAuth));
}

// ════════════════════════════════════════════════════════════════════
// ④ Plan／Memory — 合意したPlanが保持されず、pit実行後も旧Planが生きる
// ════════════════════════════════════════════════════════════════════
//
// 実走の往復:
//   18:19:39 「何週目にピットインする？」→ unhandled → 「Plan Aのピット周はまだ成立していない。」
//   18:22:48 「この週でピットイン だ。」  → unhandled → 「了解。この周の終わりでボックス。」
//   18:25:54 pit_entry / 18:26:10 pit_box_here  ← **実際にピットした**
//   18:43:21 「今はステイアウト。ピットウィンドウまで走れる。」 ← 旧Planが失効していない
//   18:44:53 「完走まで8.3L不足。Plan Aを継続」 ← pit後・残り約1周で逆方向
//   18:51:35 「戦略も毎回同じなんだけど、君が把握してないっていうのが一番痛いね。」
//            → 内容に答えず「保存したよ」と機械的に返答
{
  const G = '④Plan/Memory';

  // ④-1 単一の session strategy state が要る（fuel履歴・race format・残時間/残周・
  //      pit実績・合意Planを同じ revision で読む）。
  const statePath = path.join(__dirname, 'desktop/session-strategy-state.js');
  const hasState = fs.existsSync(statePath);
  check(G, 'desktop/session-strategy-state.js が存在する', hasState,
    'fuel履歴・pit実績・合意Planが別系統のまま＝質問ごとに違う前提で答える');

  if (hasState) {
    const S = require(statePath);
    const st = S.create({ session_key: 'Yuji|3|Race|Le Mans|Mercedes-AMG GT3 2020' });

    // 合意したPlanが同じ revision で読み戻せる
    S.agreePitPlan(st, { lap: 12, source: 'driver', at: 1000 });
    const rev1 = S.revision(st);
    check(G, '合意Planが読み戻せる', S.pitPlan(st) && S.pitPlan(st).lap === 12,
      JSON.stringify(S.pitPlan(st)));

    // pit実行で旧Planは失効する
    S.recordPitExecuted(st, { lap: 12, at: 2000 });
    check(G, 'pit実行後に旧Planが失効する', S.pitPlan(st) === null || S.pitPlan(st).expired === true,
      JSON.stringify(S.pitPlan(st)));
    check(G, 'pit実行で revision が進む', S.revision(st) !== rev1, `${rev1} -> ${S.revision(st)}`);

    // pit後の「完走まで8.3L不足」「Plan A継続」は出さない。
    // 実走 18:44:53 の実値：Fuel 15.9L・実測 7.865L/lap・残り約2周＝足りている。
    // 8.3L不足は、pit前の全レース距離を前提に計算し続けた結果。
    const ans = S.answerFuel(st, { fuel_l: 15.9, per_lap_l: 7.865, laps_remaining: 2, at: 3000 });
    check(G, 'pit後・残り2周で不足を言わない（実走は8.3L不足と言った）',
      ans && ans.shortfall_l === null || (ans && ans.shortfall_l <= 0),
      JSON.stringify(ans));
    check(G, '失効したPlan Aの継続を言わない',
      ans && !/Plan A/.test(String(ans.reply || '')), JSON.stringify(ans));

    // ④-1b ピット後に古い「ステイアウト」「ピットウィンドウまで走れる」を出さない。
    //      実走 18:43:21 は pit 実行から17分後にこれを喋った。
    const after = S.answerPitDecision(st, { at: 4000, laps_remaining: 2 });
    check(G, 'pit後に「ステイアウト」を言わない',
      after && !/ステイアウト/.test(String(after.reply || '')), JSON.stringify(after));
    check(G, 'pit後に「ピットウィンドウまで走れる」を言わない',
      after && !/ピットウィンドウまで走れる/.test(String(after.reply || '')), JSON.stringify(after));

    // ④-1c 訂正・取消・聞き返しの後もPlan状態を追跡する。
    const st3 = S.create({ session_key: 'k' });
    S.agreePitPlan(st3, { lap: 12, source: 'driver', at: 1000 });
    S.amendPitPlan(st3, { lap: 14, source: 'driver', at: 1100 });
    check(G, '訂正でPlanが更新される', S.pitPlan(st3) && S.pitPlan(st3).lap === 14,
      JSON.stringify(S.pitPlan(st3)));
    check(G, '訂正しても合意元は失われない',
      S.pitPlan(st3) && S.pitPlan(st3).source === 'driver', JSON.stringify(S.pitPlan(st3)));
    S.cancelPitPlan(st3, { source: 'driver', at: 1200 });
    check(G, '取消でPlanが消える', S.pitPlan(st3) === null, JSON.stringify(S.pitPlan(st3)));
    check(G, '取消後の聞き返しでPlan無しと答える',
      /まだ|無い|ない|未定/.test(String((S.answerPitDecision(st3, { at: 1300 }) || {}).reply || '')),
      JSON.stringify(S.answerPitDecision(st3, { at: 1300 })));
    S.agreePitPlan(st3, { lap: 18, source: 'driver', at: 1400 });
    check(G, '取消の後でも新しいPlanを追跡できる',
      S.pitPlan(st3) && S.pitPlan(st3).lap === 18, JSON.stringify(S.pitPlan(st3)));
  }

  // ④-1d pit_entry 成立でPlanを実行済みへ遷移させる配線が製品にあること。
  check(G, 'renderer が pit_entry で Plan を実行済みにする',
    /recordPitExecuted\(/.test(renderer),
    'pit_entry イベントから Plan 失効へ繋がる配線が renderer.html に無い');

  // ══ Codex 独立Gate 4 差戻し（2026-09-06）P1 4件 ══════════════════
  //   「新しいstate APIは動くが、実走で失敗した製品経路まで接続されていない」。
  //   以下はすべて**製品経路を実行する**。API単体呼出しでは緑にしない。

  // ★P1-1 燃料：実走 18:44:53 の文は router の `fuelReply()` が作っている。
  //   pit_timing_authority（旧権威）から「不足」「Plan A継続」を今も生成できる。
  {
    const liveFuel = {
      session_time_remaining_s: 300,
      finish_crossings_authority: 2,
      fuel: 15.9,
      fuel_strategy: {
        pit_timing_authority: { available: true, range_laps: 2.0,
          shortfall_to_finish_l: 8.3, decision: 'hold',
          laps_until_latest_safe_pit: null, latest_safe_pit_lap: null,
          selected_plan: 'A' },
      },
    };
    // 基準：state を渡さなければ実走の文がそのまま再現する（再現の証明）。
    const before = router.route({ text: '燃料 どのくらい残ってますか？', lang: 'ja', live: liveFuel });
    check(G, '実走 18:44:53 の「8.3L不足／Plan A継続」を再現できる',
      before && before.handled && /8\.3L不足/.test(String(before.reply || ''))
      && /Plan A/.test(String(before.reply || '')), JSON.stringify(before));

    // pit 実行済みの state を渡したら、その文は**出せない**こと。
    if (hasState) {
      const S = require(statePath);
      const stF = S.create({ session_key: 'k' });
      S.agreePitPlan(stF, { lap: 12, source: 'driver', at: 1000 });
      S.recordPitExecuted(stF, { lap: 12, at: 2000 });
      const after = router.route({ text: '燃料 どのくらい残ってますか？', lang: 'ja',
        live: liveFuel, strategy: { state: stF, api: S } });
      check(G, 'P1-1 pit後の燃料回答が「不足」を言わない（実経路）',
        after && after.handled && !/不足/.test(String(after.reply || '')),
        JSON.stringify(after));
      check(G, 'P1-1 pit後の燃料回答が失効した「Plan A継続」を言わない（実経路）',
        after && !/Plan A/.test(String(after.reply || '')), JSON.stringify(after));
    }
  }

  // ★P1-2 戦略指摘：実走 18:51 は debrief の `recordEvidenceAnswer()` が
  //   最終回答として受け取り、定型の `ready`（「…保存したよ。」）を返していた。
  //   製品経路を実行して、返答が**内容を含む**ことを見る。
  {
    const src = grabFunction(renderer, 'recordEvidenceAnswer');
    check(G, 'P1-2 recordEvidenceAnswer を取り出せる', !!src);
    if (src && hasState) {
      const S = require(statePath);
      const said = [];
      const ctx = {
        console, globalThis: null,
        PitwallSessionStrategyState: S,
        speakQueue: [], isSpeaking: false, sessionPurpose: 'race',
        evidenceDebrief: { active: true, index: 0, feedbackIndex: 99, acceptAfter: 0,
          questions: ['燃料とピット判断は想定どおりだった？'], answers: [], data: {} },
        evidenceCopy: () => ({ ready: '書き込み後の再読込まで確認し、回答を実測データ付きの'
          + 'ドライバー申告記憶として保存したよ。内容を確認するか、回答を修正してね。',
          failed: 'x', wait: 'w', preview: 'p' }),
        applyEvidenceCorrection: () => false,
        isEvidenceAnswerCandidate: () => true,
        autoSaveEvidenceMemory: () => true,
        usageCount: () => {}, askEvidenceQuestion: () => {},
        addMsg: (k, t) => { said.push(t); }, pushMsg: () => {}, speak: t => { said.push(t); },
        document: { getElementById: () => ({ textContent: '', style: {} }) },
        ensureStrategyState: () => S.create({ session_key: 'k' }),
      };
      ctx.globalThis = ctx;
      vm.createContext(ctx);
      vm.runInContext(src + '\nglobalThis.__r = recordEvidenceAnswer;', ctx);
      const complaint = '戦略も毎回同じなんだけど、君が把握してないっていうのが一番痛いね。';
      ctx.__r(complaint);
      const reply = said.join(' ');
      check(G, 'P1-2 戦略の指摘へ定型の保存ACKだけを返さない（実経路）',
        /戦略|把握/.test(reply), JSON.stringify(said));
    }
  }

  // ★P1-3 pit実行の遷移を、発話可否から独立した権威 pit-state へ繋ぐ。
  //   Bridge の radio `pit_entry` は Speed>5m/s のときだけ流れる。
  //   低速進入・radio抑止時も Plan は失効しなければならない。
  {
    const src = grabFunction(renderer, 'observePitState');
    check(G, 'P1-3 observePitState（権威pit-state観測）が存在する', !!src,
      'renderer が radio pit_entry にしか繋がっていない＝低速進入でPlanが失効しない');
    if (src && hasState) {
      const S = require(statePath);
      const st = S.create({ session_key: 'k' });
      S.agreePitPlan(st, { lap: 7, source: 'driver', at: 1000 });
      const ctx = { console, globalThis: null, PitwallSessionStrategyState: S,
        ensureStrategyState: () => st, diagnosticLog: () => {} };
      ctx.globalThis = ctx;
      vm.createContext(ctx);
      vm.runInContext(src + '\nglobalThis.__o = observePitState;', ctx);
      ctx.__o({ on_pit_road: false, lap: 7 });
      check(G, 'P1-3 コース上ではPlanを失効させない', S.pitPlan(st) !== null,
        JSON.stringify(S.pitPlan(st)));
      ctx.__o({ on_pit_road: true, lap: 7 });   // 低速進入＝radio は流れない
      check(G, 'P1-3 低速進入（radio無し）でもPlanが失効する', S.pitPlan(st) === null,
        JSON.stringify(S.pitPlan(st)));
      check(G, 'P1-3 pit実績が記録される',
        S.pitExecuted(st) && S.pitExecuted(st).lap === 7, JSON.stringify(S.pitExecuted(st)));
    }
    // ★Codex 第2回差戻し（2026-09-06）：`_pitRoadPrev=false` 初期化のため、
    //   **接続時・セッション開始時の最初の telemetry が `on_pit_road=true`**
    //   （＝ピットボックスからのレーススタートは常にこれ）なら、
    //   false→true の遷移が無いのに pit実行として扱ってしまう。
    //   Bridge 側は同じ誤爆を `prev['onPit'] is False` で既に塞いでいる。
    //   pit前状態は unknown / off / on の三値で持ち、**初回観測は seed だけ**にする。
    if (src && hasState) {
      const S = require(statePath);
      const mk = (seed) => {
        const st = S.create({ session_key: 'k' });
        S.agreePitPlan(st, { lap: 3, source: 'driver', at: 1 });
        const ctx = { console, globalThis: null, PitwallSessionStrategyState: S,
          ensureStrategyState: () => st, diagnosticLog: () => {} };
        ctx.globalThis = ctx;
        vm.createContext(ctx);
        vm.runInContext(grabFunction(renderer, 'resetPitStateObservation') + '\n' + src
          + '\nglobalThis.__o = observePitState;'
          + '\nglobalThis.__reset = (typeof resetPitStateObservation===\'function\')'
          + ' ? resetPitStateObservation : null;', ctx);
        return { st, ctx };
      };

      // 1. 初回観測が true でも pit実行にしない（seed のみ）
      const a = mk();
      a.ctx.__o({ on_pit_road: true, lap: 0 });
      check(G, 'P1-3b 初回 true は pit未実行（ボックスからのスタート）',
        S.pitPlan(a.st) !== null && S.pitExecuted(a.st) === null,
        `plan=${JSON.stringify(S.pitPlan(a.st))} exec=${JSON.stringify(S.pitExecuted(a.st))}`);
      // 続けて off→on を観測したら実行になる
      a.ctx.__o({ on_pit_road: false, lap: 3 });
      a.ctx.__o({ on_pit_road: true, lap: 3 });
      check(G, 'P1-3b seed の後の false→true は pit実行',
        S.pitExecuted(a.st) && S.pitExecuted(a.st).lap === 3,
        JSON.stringify(S.pitExecuted(a.st)));

      // 2. セッション境界で観測状態を reset し、前セッション末尾を持ち越さない
      const b = mk();
      b.ctx.__o({ on_pit_road: false, lap: 9 });
      check(G, 'P1-3b reset API がある', typeof b.ctx.__reset === 'function',
        'resetPitStateObservation() が無い＝セッション境界で持ち越す');
      if (typeof b.ctx.__reset === 'function') {
        b.ctx.__reset();
        b.ctx.__o({ on_pit_road: true, lap: 0 });   // 新セッションの初回が true
        check(G, 'P1-3b reset 後の初回 true も pit未実行',
          S.pitExecuted(b.st) === null, JSON.stringify(S.pitExecuted(b.st)));
      }

      // 3. ★状態系列 `off → 切断 → 再接続の初回 on` で誤発火しない（Codex 受入条件3）
      const c = mk();
      c.ctx.__o({ on_pit_road: false, lap: 5 });    // 切断前の最終観測は off
      check(G, 'P1-3b（前提）切断前は off を観測している', S.pitExecuted(c.st) === null);
      if (typeof c.ctx.__reset === 'function') {
        c.ctx.__reset();                            // iracing_disconnected 相当
        c.ctx.__o({ on_pit_road: true, lap: 0 });   // 再接続後の初回が on
        check(G, 'P1-3b off→切断→再接続の初回 on で pit未実行',
          S.pitExecuted(c.st) === null && S.pitPlan(c.st) !== null,
          `exec=${JSON.stringify(S.pitExecuted(c.st))} plan=${JSON.stringify(S.pitPlan(c.st))}`);
      }
    }
    // ★セッション境界・切断で reset が呼ばれていること（配線）。
    //   ★件数で数えると**定義行の `(){`** まで数えてしまい、呼出しを1つ消しても
    //     緑のままだった（2026-09-06 変異M2/M3）。呼出し文脈を名指しで見る。
    check(G, 'P1-3b stale 検知で pit観測状態を reset する',
      /iracingLive=false;usageIracingLive=false;lastTelemetry=null;lastSectors=null;\s*\n\s*resetPitStateObservation\(\);/
        .test(renderer),
      'markTelemetryStale の reset 呼出しが無い');

    // ★Codex 第3回差戻し（2026-09-06）：reset を `markTelemetryStale()` にだけ繋いでいた。
    //   **実切断分岐 `data.type==='iracing_disconnected'` は未配線**だった。
    //   切断前の最終観測が off で、再接続後の初回が on なら、seed ではなく
    //   false→true と判定され偽の pit_executed が再発する。
    //   分岐**範囲内**にあることを名指しで検査する（ファイル全体の有無では通ってしまう）。
    {
      const at = renderer.indexOf("data.type==='iracing_disconnected'");
      const branch = at < 0 ? '' : renderer.slice(at, renderer.indexOf('return;', at));
      check(G, 'P1-3b iracing_disconnected 実分岐で reset する',
        branch.indexOf('resetPitStateObservation()') >= 0,
        '切断分岐内に reset が無い＝再接続後の初回 on を実進入と誤判定する');
    }
    check(G, 'P1-3b セッション境界（Qualify→Race）で reset する',
      /resetSessionScopedReviewState\(nextSessionNum\);\s*\n\s*resetPitStateObservation\(\);/
        .test(renderer),
      'session_num 変化時の reset 呼出しが無い');

    // ★関数を実行できるだけでは足りない。**telemetry 受信経路から呼ばれている**こと。
    //   呼出しを消しても緑のままだった（2026-09-06 変異M2）。
    const ingest = renderer.slice(renderer.indexOf("data.type==='telemetry_live'"));
    check(G, 'P1-3 telemetry 受信経路が observePitState を呼ぶ',
      ingest.indexOf('observePitState(') >= 0
      && ingest.indexOf('observePitState(') < 1500,
      'telemetry_live の処理内に observePitState() の呼出しが無い');
  }

  // ★P1-4 Plan申告は**保存**まで検証する。「次の周」は current+1。
  if (hasState) {
    const S = require(statePath);
    const liveLap = { session_time_remaining_s: 1500, lap: 9,
      race_plan: { kind: 'timed', configured_duration_s: 2400 } };

    const stThis = S.create({ session_key: 'k' });
    const rThis = router.route({ text: 'この週でピットイン だ。', lang: 'ja',
      live: liveLap, strategy: { state: stThis, api: S } });
    check(G, 'P1-4 「この周」でPlanが保存される',
      S.pitPlan(stThis) && S.pitPlan(stThis).lap === 9, JSON.stringify(S.pitPlan(stThis)));
    check(G, 'P1-4 保存元が driver である',
      S.pitPlan(stThis) && S.pitPlan(stThis).source === 'driver', JSON.stringify(S.pitPlan(stThis)));
    check(G, 'P1-4 「この周」の復唱が現在周を指す',
      rThis && /この周/.test(String(rThis.reply || '')), JSON.stringify(rThis));

    const stNext = S.create({ session_key: 'k' });
    const rNext = router.route({ text: '次の周でピットイン。', lang: 'ja',
      live: liveLap, strategy: { state: stNext, api: S } });
    check(G, 'P1-4 「次の周」は current+1 で保存される',
      S.pitPlan(stNext) && S.pitPlan(stNext).lap === 10, JSON.stringify(S.pitPlan(stNext)));
    check(G, 'P1-4 「次の周」を「この周」と復唱しない',
      rNext && !/この周/.test(String(rNext.reply || '')), JSON.stringify(rNext));
  }

  // ④-2 「何週目にピットインする？」が pit 周回の質問として成立する。
  //      実走では 週 のせいで unhandled → LLM → 「まだ成立していない」。
  const live = {
    session_time_remaining_s: 1500,
    finish_crossings_authority: null,
    race_plan: { kind: 'timed', configured_duration_s: 2400 },
    fuel_per_lap_l: 7.865,
  };
  const q = router.route({ text: '何週目にピットインする？', lang: 'ja', live });
  check(G, '「何週目にピットインする？」がピット周回の質問になる',
    q && q.handled && /pit/.test(String(q.intent || '')),
    `handled=${q && q.handled} intent=${q && q.intent}`);

  // ④-3 「この週でピットイン だ。」がドライバーのPlan申告として保存される。
  const d = router.route({ text: 'この週でピットイン だ。', lang: 'ja', live });
  check(G, '「この週でピットイン だ。」がPlan申告として扱われる',
    d && d.handled && /pit_this_lap|pit_plan/.test(String(d.intent || '')),
    `handled=${d && d.handled} intent=${d && d.intent}`);

  // ④-4 ドライバーの戦略申告に、保存ACKだけで返さない。
  //     ★実走 18:51:35 の「保存したよ」は local router ではなく記憶保存側から出た。
  //       router へ問い合わせても unhandled で**素通り＝偽の緑**になるため、
  //       申告内容を短く復唱して返す capability の有無そのものを検査する。
  const hasRestate = hasState
    && typeof require(statePath).restateDriverStrategy === 'function';
  check(G, 'ドライバー戦略申告を復唱して返す capability がある', hasRestate,
    '保存ACKだけを返す実装しか無い（実走 18:51:35「保存したよ」）');
  if (hasRestate) {
    const S = require(statePath);
    const st2 = S.create({ session_key: 'Yuji|3|Race|Le Mans|Mercedes-AMG GT3 2020' });
    const r = S.restateDriverStrategy(st2,
      { text: '戦略も毎回同じなんだけど、君が把握してないっていうのが一番痛いね。', at: 4000 });
    check(G, '復唱に「保存した」だけで終わらせない',
      r && r.reply && !/^.{0,40}保存.{0,40}$/.test(String(r.reply)), JSON.stringify(r));
  }
}

// ── ソースから関数本体を取り出す（波括弧対応）──────────────────
function grabFunction(src, name) {
  const i = src.indexOf('function ' + name);
  if (i < 0) return '';
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  return '';
}

const total = pass + failures.length;
for (const f of failures) console.error('  ❌ ' + f);
console.log(`[build298 race replay] 合格 ${pass} / 不合格 ${failures.length}（実行 ${total}）`);
if (failures.length) process.exit(1);
