# OMORAY PITWALL Development Rules

## Mission

### Yujiの恒久指示：Codexの家訓（2026-09-13）

**Yujiの時間と費用を、使えるPITWALLの前進として返す。正しい指摘・謝罪・MDの往復・検査件数を成果の代わりにしない。**

背景：Codexは局所的な確認と差戻しに偏り、同じ「自然なレース会話」という要求を何度も説明させた。比較fixtureを作っても製品経路へ接続せず、修正後に隣の欠陥を見つける往復を続けた。未完成の正直な報告だけでは責任を果たしていない。この失敗を以後の作業基準とする。

1. **レース会話を土台にする。** Driverの意味・目的を理解し、相談と訂正を持ち続ける。反射は並行する即応経路、戦略は会話が利用する判断機能、個人記憶は相談と判断を支える。分類・計算の都合で基本会話を切らない。
2. **返事の存在を成功に数えない。** 問いの意味に応え、必要な判断・代案へつながったかで評価する。別の事実が正しい、接続できた、音声が出た、好意的な所感があるという理由で回答品質の基準を下げない。
3. **一つの相談を完成単位にする。** 質問→説明→訂正→再提案→合意→実行→結果評価→記憶の再利用を、対象スライスの製品経路で接続する。段階的実装は可能だが、部分実装を区間全体の完成と呼ばない。
4. **レビュー前に全経路の反証をまとめる。** 正常会話と、音声待機・非同期待機・中断・確認質問・別話題・データ欠損・古い応答・session切替を適用範囲に応じて確認する。見えている関連欠陥を小出しにせず、完成条件と再現ケースをそろえて返す。後から発見した欠陥は隠さず報告する。
5. **旧版と新版を同条件で比較する。** 改善・維持・後退を実回答と状態の証拠で示す。既存の比較fixtureを製品へ接続せず、検証準備だけで終えない。元ログの暗記を避け、言い換え・未使用場面でも反証する。
6. **未接続を機械的に検出する。** 保存先、関数、呼出しの存在だけを完成証拠にしない。出力からsourceまで逆に追跡できるか確認する。実装と独立確認の担当分離を保ちつつ、MDを渡して責任を終えない。
7. **訂正を次の判断へ戻す。** 元の質問・誤答・訂正・適用条件・予測と実結果を関連付け、次回取得と別sessionでの改善を検証する。保存だけを学習と呼ばず、会話ごとにモデル本体が再学習するとも説明しない。
8. **判断を出す能力も検証する。** 根拠ある暫定提案の予測誤差は検証・改善の材料とする。必要な提案を出さない失敗も測る。別対象への回答、架空の観測、訂正無視と戦略予測の誤差を混同しない。
9. **合意済みの作業で再承認待ちを作らない。** 実LLMを呼べなくても保存応答・mockで送信→解析→状態反映→出力の接続を進める。接続検証と実LLMの意味判定品質、実音声、実走検証は分ける。外部有料API・Build・公開等の既存承認境界は守る。
10. **成果を会話で報告する。** 「何件通った」だけでなく「以前できなかったこの相談が、ここまで続くようになった」を示す。実証がなければ改善済みと呼ばない。遅れは開発日数だけでなく、Yujiの費用・信頼、ユーザーへの提供機会、実走から学ぶ機会の損失である。

見逃しゼロを約束するのではなく、早く発見し、同じ後退を再発させない仕組みで責任を果たす。

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

YujiのWindows／iRacing実走は、公開update経路からinstallerを取得して行う。Gate 0〜5（変更時はGate 7も）に合格し、Yujiの公開GOを受けたら、Gate 6／8の事前完了を要求して公開を止めない。公開物をfield-test candidateとして即時照合し、その後のGate 6／8結果で継続またはGate 10停止を判断する。公開前検査済みartifactと公開後field evidenceを混同しない。

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

### 必須の作業回覧（変更箇所・不安点を隠さない）

CodexまたはClaude Codeが、相手の独立確認を要する変更を行った時は、**Build提案・公開提案より先に**
`review/PITWALL_SHARED_WORKING_LOG.md`へ一つの回覧項目を追記する。散文だけの「直した」は不可。

回覧項目には最低限、次を表で明記する。

1. 作業者、対象commit/SHA、目的、実装・未commit・Build・公開の各状態
2. **変更箇所**（ファイル、関数または狭い行範囲、何を変えたか）
3. 実行した検査と結果。実行していない検査・Windows/iRacingでしか確かめられない項目も同じ表へ残す
4. 不安点、設計上の選択、反証してほしい点、既知の未解決事項
5. 次に誰が何を確認するか。Gate 4なら確認者と合否条件を明記する

確認者はこの表を起点にdiff・実行経路・失敗経路を独立に辿る。表が無い、SHAが曖昧、または未検証点を隠した回覧は
Gate 4の依頼として受理しない。緊急時も省略せず、短縮した検査と残るリスクをYujiへ明示して判断を仰ぐ。

共有MDへ回覧を追加したチャット報告には、既存ルールどおり必ず次の一文を含める。

`次のMDに指示書あり`

Keep `HANDOFF.md` concise and current. Update it after a meaningful completed slice, before ending a session with unfinished work, and whenever the release/field/cost state changes materially.

It must answer:

- What is released now?
- What is in the working tree now?
- What is verified, and how?
- What still requires field verification?
- What is the next action?
- What genuinely requires Yuji's decision?

Replace stale status instead of appending an endless diary. Git is the historical record.
