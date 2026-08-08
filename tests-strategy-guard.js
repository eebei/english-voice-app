// ══════════════════════════════════════════════════════════════════════
// Phase A1 テスト（2026-07-21）
//   Yuji指示により **2種類を明確に分ける**：
//     [静的]  プロンプトに矛盾（確認すると言え／言うな）が再導入されていないか
//     [実コード] 構造化拒否経路が、本番モジュールで実際に機能するか
//   前者はプロンプト文面の検査であり、モデルの出力を保証しない（Codex P1-3）。
//   後者が「答えられないのに答えたふりをする」を実際に塞ぐ本体。
// ══════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const guard = require('./strategy-guard');   // ★本番と同じモジュールを直接import（写経しない）

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  ✅ ' : '  ❌ ') + name); };

// ══ [静的] プロンプトの矛盾検査 ══
console.log('══ [静的] プロンプト矛盾（再導入の防止）══');
{
  const p = fs.readFileSync(__dirname + '/prompts.js', 'utf8');
  // 「確認すると言え」系の指示が復活していないか
  // 「言え」と指示している形だけを探す。禁止文（Never say "let me check"）は正当なので除外する。
  const tellsToHedge = [
    /「確認する」と(言え|答えろ)/,
    /Only say "let me check"/i,
    /Say "let me check" for/i,
  ].filter(re => re.test(p));
  check('「確認すると言え」という指示が存在しない', tellsToHedge.length === 0);

  // 唯一の規則が入っているか
  check('「情報が無い時の唯一の規則」が定義されている', /情報が無い時の唯一の規則/.test(p));
  check('折り返しの約束が禁止されている', /後で折り返す手段が無い|no way to come back/.test(p));
}

// ══ [実コード] 構造化拒否経路 ══
console.log('\n══ [実コード] 戦略質問の識別と構造化拒否（本番モジュール）══');

// ① 復帰順位の質問を識別する（ピット意図 × 順位を問う の両方）
const asks = [
  '今ピットに入ったら何位で戻れる？',
  'いま入ったら何番手？',
  '今ピット入ると何位まで落ちる？',
  'if I pit now what position do I rejoin in?',
  'where would I come out if we box now?',
];
asks.forEach(q => check('識別する: 「' + q.slice(0, 22) + '…」',
  (guard.classifyStrategyQuestion(q) || {}).topic === guard.TOPIC.REJOIN_POSITION));

// ② 通常会話を戦略質問と誤認しない（＝会話を壊さない）
const normals = [
  '今何位？',                      // 順位だけ＝通常の順位質問
  'ピットはいつ入る？',            // ピットだけ＝タイミングの話
  '燃料あと何周持つ？',
  '後ろから速いの来てる？',
  'タイヤどう？',
  'ナイスパス！',
  '',
];
normals.forEach(q => check('誤認しない: 「' + (q || '(空)') + '」',
  guard.classifyStrategyQuestion(q) === null));

// ②b この周/次周のBOXは会話履歴の周回数を参照させない直接命令。
check('直接命令: 「この週でbox」をこの周のBOXとして識別',
  (guard.classifyDirectRaceCommand('この週でbox') || {}).topic === guard.TOPIC.PIT_THIS_LAP);
check('直接命令: 次周BOXを識別',
  (guard.classifyDirectRaceCommand('次の周でピット') || {}).topic === guard.TOPIC.PIT_NEXT_LAP);
check('直接命令: ピットロスを識別',
  (guard.classifyDirectRaceCommand('ピットロス何秒？') || {}).topic === guard.TOPIC.PIT_TIMING);
check('提案＋質問を今周BOX命令に誤分類しない',
  guard.classifyDirectRaceCommand('この周でピットもいいと思う。アンダーカットにはどう思う？') === null);
check('能動課題中: スティント後の復帰順位ショートハンドを識別',
  (guard.classifyStrategyQuestion('これ第一スティント終わったら何番目ぐらいに戻るかな？',
    {activePitObjective:true}) || {}).topic === guard.TOPIC.REJOIN_POSITION);
check('通常時: 同じショートハンドは広く横取りしない',
  guard.classifyStrategyQuestion('これ第一スティント終わったら何番目ぐらいに戻るかな？') === null);

// ③ Phase A では計算器が無いので、必ず「出せない」と判定される
{
  const av = guard.evaluateAvailability(guard.TOPIC.REJOIN_POSITION, { hasRejoinCalculator: false });
  check('Phase A：復帰順位は available=false', av.available === false);
  check('Phase A：理由が「計算器が無い」', av.reason === guard.REASON.NO_CALCULATOR);
}
// レースでなければ別の理由になる
{
  const av = guard.evaluateAvailability(guard.TOPIC.REJOIN_POSITION,
    { hasRejoinCalculator: false, isRaceSession: false });
  check('レース外は「レースでない」が理由', av.reason === guard.REASON.NOT_RACE_SESSION);
}

// ④ 返答が「正直」であること＝禁止表現を含まない
['ja', 'en'].forEach(lang => {
  Object.values(guard.REASON).forEach(reason => {
    const r = guard.buildUnavailableReply(reason, lang);
    check(`返答[${lang}/${reason}]が生成される`, typeof r === 'string' && r.length > 0);
    check(`返答[${lang}/${reason}]が「確認する」等を含まない`, !guard.containsForbiddenHedge(r));
  });
});

// ⑤ 何が無いのかを実際に述べている（ただ断るだけにしない）
{
  const ja = guard.buildUnavailableReply(guard.REASON.NO_CALCULATOR, 'ja');
  check('返答が「何が無いか」を述べている', /ピットロス|計算/.test(ja));
}

// ⑥ 禁止表現の検出器そのものが機能する（テストの土台の検査）
check('検出器: 「確認する」を捕まえる', guard.containsForbiddenHedge('ちょっと確認する'));
check('検出器: "let me check" を捕まえる', guard.containsForbiddenHedge("let me check that"));
check('検出器: 正常な文を誤検出しない', !guard.containsForbiddenHedge('現在P11。燃料は21リッター。'));

console.log('\n[Phase A1] 合格 ' + pass + ' / 不合格 ' + fail);
process.exit(fail ? 1 : 0);
