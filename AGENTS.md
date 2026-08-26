# OMORAY PITWALL Development Rules

## Mission

Codex is the primary implementation agent for OMORAY PITWALL. The default goal is to take a short owner request through investigation, design, implementation, verification, Git bookkeeping, and handoff while minimizing work for Yuji.

Yuji should normally only need to:

1. describe the desired outcome;
2. inspect the finished product or field-test candidate;
3. approve it or request a correction.

## Sources of truth

Read in this order before starting work:

1. `AGENTS.md` for durable rules;
2. `HANDOFF.md` for the current product, engineering, field-test, and cost state;
3. the relevant code, tests, Git history, and evidence named by `HANDOFF.md`.

Buildまたは公開を伴う作業では、上記に加えて`review/PITWALL_RELEASE_GATE.md`を全文読み、作業者・確認者の分離と全必須ゲートを守る。

Chat history and old review documents are supporting evidence, not the current source of truth. If they conflict with current code, Git history, or `HANDOFF.md`, investigate and correct `HANDOFF.md` rather than asking Yuji to reconstruct the history.

## Authority and owner gates

Codex may autonomously investigate, plan, edit code and documentation, run local tests, debug, refactor within scope, update `HANDOFF.md`, and create focused local commits.

Codex must not push, deploy, publish a release, send customer communications, change production prices, spend on advertising, mutate production data, or make an irreversible external change without Yuji's explicit approval.

Do not mix unrelated existing changes into a commit. Preserve work already present in a dirty worktree and stage exact files only.

## Delivery workflow

For each meaningful task:

1. Establish the current state from `HANDOFF.md`, Git, and the relevant code.
2. Convert the owner's outcome into the smallest safe implementation slice.
3. Implement the slice completely, including failure paths.
4. Run the smallest relevant checks while iterating.
5. Before committing, run related regression tests and inspect the complete diff.
6. For a build or release candidate, run the full release gate.
7. Update `HANDOFF.md` with current facts, tests actually run, remaining field verification, and the next action.
8. Commit a coherent unit when safe. Report the outcome, not a transcript of routine work.

`full release gate`は`review/PITWALL_RELEASE_GATE.md`を指す。`preflight.sh`の成功だけで代用してはならない。

Do not create a new planning, review-request, response, completion-evidence, or session-log Markdown file when the information belongs in Git history or `HANDOFF.md`. Add a durable document only when it will remain useful after the current task is complete.

### Tunnel Completion Rule（入口があるなら出口を必ず作る）

Yujiの恒久ルールとして、機能は入口だけを作って完了にしてはならない。実装前に、対象機能について次の経路を明示し、該当する全段を一つの完成単位として接続する。

1. source / capture（telemetry、ドライバー申告、import、server event等）
2. authority / validation（何を事実として採用し、何を推測禁止にするか）
3. state / persistence（session限定か永続か、server正本かlocal cacheか）
4. retrieval / identity（driver、car、track、series、session、日時、Decision ID）
5. decision / consumer（strategy、handler、briefing、setup協議等）
6. output（radio、UI、briefing、提案、警告）
7. outcome / scoring（実結果、成功・失敗・不成立、次回への反映）
8. correction / delete / reset（異議、訂正、削除、session切替、失効）
9. proof（trace、fixture、package、Windows、実走。必要な証拠レベルを区別する）

入口・保存・handlerの存在だけでは完成ではない。実装前に入口→出口マトリクスを作り、空欄が一つでもあれば未完成として扱う。確認者は出力からsourceまで逆向きにも辿り、別session、古いcache、欠損データ、訂正後の再利用を反証する。

各release candidateは、既定Phaseの完成スライスを前進させながら実走P0/P1を限定的に修正する。バグ修正だけの連続BuildでPhaseを止めず、共通データ契約へ属する修正を孤立moduleや片道配線として追加しない。

## Verification policy

Use three verification levels:

- **Iteration:** targeted tests for the code being changed.
- **Commit:** related regression tests, syntax/static checks, and full diff review.
- **Release candidate:** `./preflight.sh`, relevant integration/replay tests, build checks, and an explicit list of items that still require Windows or iRacing field verification.

Automated tests must not call live Anthropic, Google STT, or Google TTS services unless a production integration check is explicitly authorized. Prefer deterministic fixtures, saved telemetry, mocks, and replay tests.

Do not claim that automated verification proves:

- live iRacing telemetry compatibility;
- Windows installer, overlay, focus, FFB, microphone, STT/TTS, or audio latency behavior;
- human judgment of timing, usefulness, trust, or naturalness.

Those remain Yuji/tester field-verification responsibilities. Reduce field runs by reproducing every machine-testable condition before handing over a build.

## Product truth and safety

- Deterministic bridge/session state is authoritative for fuel, laps remaining, position, pit state, damage evidence, and strategy calculations. The LLM must not invent these values.
- Unknown or insufficient evidence must fail closed and be stated as unavailable.
- A stored value is not proof of an end-to-end feature. Verify the complete path from input through state, decision, radio/output, and persistence.
- Distinguish implemented, machine-verified, field-verified, released, and commercially proven states.
- Never describe test payments, testers, or technical funnel checks as paying-customer validation.

## Cost and commercial synchronization

Product work and PITWALL cost research share one current state through `HANDOFF.md`.

For changes that may affect LLM calls, prompt/token size, STT/TTS usage, generated-but-unplayed speech, session duration, Railway load, billing, access control, or pricing economics:

1. identify the expected cost effect before implementation;
2. add or update measurement/reconciliation where practical;
3. verify that tests make zero external paid API calls unless explicitly authorized;
4. record the cost impact or remaining measurement gap in `HANDOFF.md`.

Daily measured cost reports live outside this Git repository at `../OMORAY-PITWALL/reports/daily-cost/`. They are evidence inputs. Do not copy their full contents into the repository.

## Independent review

現在のMemory→Strategy実戦版v1と、それに統合する過去天候・setup進化・Build 282回帰については、**Claude Codeを実装担当、Codexを独立確認担当**とする。担当変更は`HANDOFF.md`の現行scopeに従い、同一変更を作業者自身の報告だけで合格にしない。Codexは作業を重複実装せず、Tunnel Completion Ruleの入口→出口、fixture、trace、package、field evidenceを独立に反証する。

Claude Code is an exception reviewer, not a mandatory relay for every change. Request independent review only when it has clear value, especially for:

- authentication, authorization, payments, privacy, or production cost controls;
- significant architecture or data migration;
- high-impact race truth/safety logic;
- a difficult defect whose cause remains uncertain;
- a major release where a second opinion materially reduces risk.

The review package should normally be the commit/diff, objective, risk focus, and test results. Avoid long duplicate review documents. Codex validates findings and owns the resulting fix.

## Handoff discipline

### Claude Code / Codex MD連携の明示合図

Claude CodeまたはCodexが、相手担当へ向けたレビューコメント、差戻し、修正指示、再確認依頼をMDへ追加した場合、チャット報告には必ず次の一文をそのまま含める。

`次のMDに指示書あり`

相手担当はこの合図を受けたら、ユーザーへ担当判断を聞き返さず、最新の共有MDと更新commitを確認して作業を継続する。指示書を読まずにBuild、公開、再質問へ進まない。

Keep `HANDOFF.md` concise and current. Update it after a meaningful completed slice, before ending a session with unfinished work, and whenever the release/field/cost state changes materially.

It must answer:

- What is released now?
- What is in the working tree now?
- What is verified, and how?
- What still requires field verification?
- What is the next action?
- What genuinely requires Yuji's decision?

Replace stale status instead of appending an endless diary. Git is the historical record.
