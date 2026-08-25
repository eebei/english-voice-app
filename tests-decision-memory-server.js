#!/usr/bin/env node
'use strict';

// ══════════════════════════════════════════════════════════════════════
// スライス3（2026-08-25）— 戦略判断のサーバー正本・auth分離・訂正・削除・保持期間。
//
// 正本 §5.2 / §5.5。
//
// ここで守る性質：
//   - 何を預かるかを **サーバーが決める**（client を信用しない）。
//   - 生音声・会話全文・raw telemetry・自由文は預からない。
//   - owner_key で認証主体を分離し、他人の記録へ触れない。
//   - 既定は opt-out（公開ページの約束を破らない）。
//   - 削除は物理削除。ローカルだけ消して正本に残さない。
//
// DB は張らない。SQL は文面で契約を検査し、sanitize は実際に呼んで挙動で検査する。
// 外部有料APIは呼ばない。
// ══════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  (ok ? console.log : console.error)('  ' + (ok ? '✅ ' : '❌ ') + label + (ok ? '' : ' -> ' + (detail || '')));
  ok ? pass++ : fail++;
}

const authSrc = fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const stripLineComments = t => t.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
const rendererSrc = stripLineComments(
  fs.readFileSync(path.join(__dirname, 'desktop/renderer.html'), 'utf8'));

// auth.js は Postgres 接続を必要とするが、sanitize と owner key は純関数。
// DB 無しで実際に呼べることを確認したうえで挙動を検査する。
const auth = require('./auth.js');

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ① 何を預かるかはサーバーが決める（client を信用しない）══');
// ══════════════════════════════════════════════════════════════════
{
  const full = {
    decision_id: 'snap-1:decision-lap:6', date: '2026-08-24',
    recordedAt: '2026-08-24T12:00:00.000Z', updatedAt: '2026-08-24T12:30:00.000Z',
    outcome: 'success', status: 'closed',
    track: 'Okayama', car: 'Audi R8 LMS GT3', carClass: 'GT3',
    seriesId: 419, setupFingerprint: 'abc123', raceFormat: 'race', sessionNum: 2,
    proposal: {
      selected_plan: 'B', reason: 'undercut_window_open', decided_at_lap: 6,
      entry_class_position: 8, target_lap: 6, add_fuel_l: 34,
      conditions: { fuel_window_open: true, relative_pace_advantage_s: 0.4, rejoin_not_worse: true },
    },
    execution: { executed_plan: 'B', actual_entry_lap: 6, pos_in: 8, pos_out: 12, fuel_add_error_l: 0.1 },
    blend: { post_cycle_actual_position: 4, condition_met: true, closed_reason: 'condition_met' },
    closure: { finish_pos: 4, finish_pos_confirmed: true, total_laps: 20, incidents: 0, reason: 'session_ended' },
    // ↓ client が余計に送ってきたもの
    conversation: [{ role: 'user', content: '燃料どう？' }],
    raw_telemetry: [{ lap: 1, speed: 210 }],
    audio_base64: 'AAAA', driver_email: 'x@example.com', notes: '個人的なメモ',
  };
  const clean = auth.sanitizeDecisionRecord(full);
  check('戦略の事実は残る', clean.proposal.decided_at_lap === 6 && clean.blend.post_cycle_actual_position === 4);
  check('★会話全文は預からない', clean.conversation === undefined);
  check('★raw telemetry は預からない', clean.raw_telemetry === undefined);
  check('★生音声は預からない', clean.audio_base64 === undefined);
  check('★メールアドレスは預からない', clean.driver_email === undefined);
  check('★自由文メモは預からない', clean.notes === undefined);
  const keys = Object.keys(clean);
  check('返る項目は閉じた集合だけ',
    keys.every(k => ['decision_id', 'date', 'recordedAt', 'updatedAt', 'outcome', 'status',
      'track', 'car', 'carClass', 'seriesId', 'setupFingerprint', 'raceFormat', 'sessionNum',
      'proposal', 'execution', 'blend', 'closure', 'dispute'].includes(k)), keys.join(','));

  check('decision_id が無ければ受け取らない', auth.sanitizeDecisionRecord({ proposal: {} }) === null);
  check('提案が無ければ受け取らない', auth.sanitizeDecisionRecord({ decision_id: 'x' }) === null);
  check('配列や null は受け取らない',
    auth.sanitizeDecisionRecord([]) === null && auth.sanitizeDecisionRecord(null) === null);

  const bogus = auth.sanitizeDecisionRecord({ ...full, outcome: 'awesome', status: 'shipped' });
  check('★outcome は閉じた集合へ落とす', bogus.outcome === 'unknown', bogus.outcome);
  check('★status も閉じた集合へ落とす', bogus.status === 'open', bogus.status);

  const disputed = auth.sanitizeDecisionRecord({ ...full,
    dispute: { at: '2026-08-25T00:00:00.000Z', note: 'ドライバーの言い分そのまま', resolved_at: null } });
  check('★訂正の自由文は預からない（時刻だけ残す）',
    disputed.dispute.note === null && disputed.dispute.at === '2026-08-25T00:00:00.000Z');

  const huge = auth.sanitizeDecisionRecord({ ...full, track: 'x'.repeat(500) });
  check('長すぎる文字列は切り詰める', huge.track.length === 80, String(huge.track.length));
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ② 認証主体の分離（他人の記録へ触れない）══');
// ══════════════════════════════════════════════════════════════════
{
  const hash = 'a'.repeat(64);
  check('ログインユーザーは user: で分離', auth.decisionOwnerKey({ userId: 7 }) === 'user:7');
  check('beta token は beta: で分離', auth.decisionOwnerKey({ betaTokenHash: hash }) === 'beta:' + hash);
  check('ユーザーが居れば beta より優先',
    auth.decisionOwnerKey({ userId: 7, betaTokenHash: hash }) === 'user:7');
  check('★識別子が無ければ owner を作らない', auth.decisionOwnerKey({}) === null);
  check('★不正な hash では owner を作らない', auth.decisionOwnerKey({ betaTokenHash: 'short' }) === null);

  check('★全 SQL が owner_key で絞られている',
    (authSrc.match(/FROM strategy_decisions|UPDATE strategy_decisions|INTO strategy_decisions|DELETE FROM strategy_decisions/g) || []).length
    === (authSrc.match(/strategy_decisions[\s\S]{0,260}?owner_key=\$1|INTO strategy_decisions[\s\S]{0,200}?VALUES \(\$1/g) || []).length,
    'owner絞り込みのない SQL がある');
  check('主キーが owner と decision の複合', /PRIMARY KEY \(owner_key, decision_id\)/.test(authSrc));
  check('★endpoint が body の識別子を信用しない',
    /function decisionOwner\(req\) \{\s*return \{ userId: \(req\.user && req\.user\.id\) \|\| null, betaTokenHash: req\.betaTokenHash \|\| null \};/.test(serverSrc));
  check('★4本すべてが entitlement を通る',
    (serverSrc.match(/'\/api\/memory\/decisions[^']*',[^\n]*requirePitwallEntitlement/g) || []).length >= 4,
    String((serverSrc.match(/'\/api\/memory\/decisions[^']*',[^\n]*requirePitwallEntitlement/g) || []).length));
  check('rate limit がかかっている',
    (serverSrc.match(/decisionMemoryLimiter/g) || []).length >= 5);
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ③ 表示・訂正・削除・保持期間が同じ scope にある ══');
// ══════════════════════════════════════════════════════════════════
{
  check('表示（GET）がある', /app\.get\('\/api\/memory\/decisions'/.test(serverSrc));
  check('保存（PUT）がある', /app\.put\('\/api\/memory\/decisions'/.test(serverSrc));
  check('訂正（dispute）がある', /app\.post\('\/api\/memory\/decisions\/dispute'/.test(serverSrc));
  check('削除（DELETE）がある', /app\.delete\('\/api\/memory\/decisions'/.test(serverSrc));
  check('★id 欠落を「全部消す」と解釈しない',
    /body\.all === true\) \? null/.test(serverSrc) && /decision_id_required/.test(serverSrc));
  check('保持期間が定数として存在する', auth.DECISION_RETENTION_MS === 90 * 24 * 60 * 60 * 1000);
  check('★保持期間超過を読み書きのたびに消す',
    (authSrc.match(/purgeExpiredDecisions\(ownerKey\)/g) || []).length >= 3);
  check('件数上限を超えたら古いものから消す', /DECISION_MAX_PER_OWNER/.test(authSrc));
  check('★削除は物理削除（tombstone を残さない）',
    /DELETE FROM strategy_decisions WHERE owner_key=\$1 AND decision_id=\$2/.test(authSrc));
  check('全削除も用意されている（消す権利）',
    /DELETE FROM strategy_decisions WHERE owner_key=\$1`, \[ownerKey\]/.test(authSrc));
  check('ローカルにも表示関数がある', /function listDecisionsForDisplay\(\)/.test(rendererSrc));
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ④ 既定は opt-out（公開済みの約束を破らない）══');
// ══════════════════════════════════════════════════════════════════
{
  check('★opt-in キーが無ければ同期しない',
    /localStorage\.getItem\(DECISION_SYNC_OPTIN_KEY\)==='1'/.test(rendererSrc));
  check('★push が opt-out で止まる', /if\(!decisionSyncEnabled\(\)\)\{ diagnosticLog\('DECISION_SYNC','skipped=optout'\); return false; \}/.test(rendererSrc));
  check('★pull が opt-out で止まる', /pull skipped=optout/.test(rendererSrc));
  check('★dispute の送信も opt-in の時だけ',
    /if\(decisionSyncEnabled\(\)\)\{[\s\S]{0,200}decisions\/dispute/.test(rendererSrc));
  check('★delete の送信も opt-in の時だけ',
    /if\(decisionSyncEnabled\(\)\)\{[\s\S]{0,200}method:'DELETE'/.test(rendererSrc));
  check('同期の有無が trace に残る', /diagnosticLog\('DECISION_SYNC'/.test(rendererSrc));
  check('切替関数がある（opt-out へ戻せる）', /function setDecisionSyncEnabled\(on\)/.test(rendererSrc));
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ⑤ 同期の向き：正本が勝ち、古い cache で上書きしない ══');
// ══════════════════════════════════════════════════════════════════
{
  // renderer の実関数を取り出して実行する（写経しない）。
  const m = rendererSrc.match(/function mergeDecisionStores\(localStore,serverStore\)\{[\s\S]*?\n\}/);
  check('本番の merge 関数が取り出せた', !!m);
  const mergeDecisionStores = new Function('return (' + m[0] + ')')();

  const local = [{ decision_id: 'a', updatedAt: '2026-08-24T10:00:00.000Z', outcome: 'unknown' }];
  const server = [{ decision_id: 'a', updatedAt: '2026-08-25T10:00:00.000Z', outcome: 'success' }];
  check('★新しいサーバー版が勝つ',
    mergeDecisionStores(local, server)[0].outcome === 'success');
  check('★古いサーバー版で新しいローカルを潰さない',
    mergeDecisionStores(server, local)[0].outcome === 'success');
  check('ローカルにしか無い記録は残る（未同期を捨てない）',
    mergeDecisionStores([{ decision_id: 'b', updatedAt: '2026-08-25T10:00:00.000Z' }], []).length === 1);
  check('サーバーにしか無い記録は取り込む（別PCの結果）',
    mergeDecisionStores([], [{ decision_id: 'c', updatedAt: '2026-08-25T10:00:00.000Z' }]).length === 1);
  check('時刻を持つ方を採る（推測で古い方を残さない）',
    mergeDecisionStores([{ decision_id: 'd' }], [{ decision_id: 'd', updatedAt: '2026-08-25T10:00:00.000Z', outcome: 'success' }])[0].outcome === 'success');
  check('id の無いものは混ぜない',
    mergeDecisionStores([], [{ updatedAt: '2026-08-25T10:00:00.000Z' }]).length === 0);
  check('★ブリーフィング前に正本を引く（古い cache で喋らない）',
    /await pullDecisionsFromServer\(\);\s*\n\s*const _decSel=decisionBriefingSelection\(\);/.test(rendererSrc));
}

// ══════════════════════════════════════════════════════════════════
console.log('\n══ ⑥ 同期失敗で走行が壊れない ══');
// ══════════════════════════════════════════════════════════════════
{
  check('★push 失敗でも cache を消さない',
    /push failed=/.test(rendererSrc) && !/saveDecisions\(\[\]\)/.test(rendererSrc));
  check('push が catch を持つ', /catch\(e\)\{[\s\S]{0,160}DECISION_SYNC','push failed=/.test(rendererSrc));
  check('pull が catch を持つ', /catch\(e\)\{[\s\S]{0,160}DECISION_SYNC','pull failed=/.test(rendererSrc));
  check('サーバー側が例外で 5xx/4xx を返す（無言で成功にしない）',
    (serverSrc.match(/decision_memory_unavailable|invalid_decision_payload|invalid_decision_dispute|invalid_decision_delete/g) || []).length >= 4);
}

console.log(`\nDecision memory server: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
