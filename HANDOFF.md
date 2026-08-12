# OMORAY PITWALL Current Handoff

Last updated: 2026-08-12 JST

## Current

- Repository: `eebei/english-voice-app`
- Branch: `main`
- Released/committed baseline: `de54d0e` — Build 265 authoritative race radio controls
- Working state: uncommitted Build 266 / Phase E candidate on top of Build 265
- Owner direction: Codex is now the primary implementation agent. Yuji reviews finished output and performs the human/field checks that cannot be automated.
- External actions: push, deploy, release/publication, customer communications, pricing changes, advertising spend, and production-data mutations still require Yuji approval.

The repository currently has pre-existing modified and untracked Build 266 files. Do not discard, overwrite, or sweep them into an unrelated commit.

## Build 266 candidate

Objective: adapt strategy when damage, fuel use, pace, or opponent behavior changes, then recompute Plan A/B/C and provide short evidence-based radio.

### Reviewed and accepted in the current working tree

- Optional-repair observation persists the first/max evidence during pit service.
- Cancelled optional repair is distinguished from genuinely consumed repair time.
- Phase E pace/fuel baselines use the same clean-lap set without changing legacy `lap_time_hist` consumers.
- Fuel/pace deviation detection is wired at completed-lap boundaries.
- Japanese `strategy_recalculation` radio does not fall through to the English bridge message.
- The limited rerun recorded in `review/BUILD266_REJECTION_1_5_3_CODEX_REREVIEW.md` passed: 65 session-state checks, 51 bridge-wiring checks, 28/28 Japanese-radio checks, Python compilation, and diff inspection.

This acceptance is limited to those points. Build 266 is not yet a release candidate.

### Next engineering work

1. Replace trace-only recalculation with real Plan A/B/C re-evaluation and update `active_plan`.
2. Implement conditional Plan C; do not model it as a blind `+1 lap` rule.
3. Add a replay/integration path that exercises the real bridge input → session state → recalculation → broadcast → queue-fate circuit.
4. Implement the internal simulation/cost gate for `simulated`, `generated`, `played`, `deferred`, `discarded`, and wasted-generation cost.
5. Resolve the five Build 264 field findings:
   - route high-temperature/tyre/setup questions to handling advice;
   - preserve follow-up context for “どうしたらいい？”;
   - prevent truncated radio;
   - suppress debrief interruption during technical advice;
   - make `limiter_off` unique to one pit cycle.
6. Investigate `tests-five-day-access.js`, which also fails at committed Build 265. Authentication/billing behavior must not be changed merely to satisfy a stale occurrence-count assertion.

Primary detailed evidence while this migration is completed:

- `review/PITWALL_SHARED_WORKING_LOG.md`
- `review/BUILD266_PHASE_E_ADAPTIVE_RACE_INTELLIGENCE_BRIEF.md`
- `review/BUILD266_PHASE_E_COMPLETION_EVIDENCE.md`

After Build 266 closes, keep the current state here and treat old review files as historical evidence.

## Verification and field boundary

No build, push, deploy, publication, or new field run has been performed for the current Build 266 candidate.

Before field handoff:

- run targeted tests during implementation;
- run related Python and JavaScript regression suites;
- run `./preflight.sh` for the release candidate;
- inspect the complete diff against Build 265;
- prove that automated tests made zero paid external API calls;
- document only the remaining Windows/iRacing/human checks.

Field verification remains necessary for real iRacing telemetry, Windows packaging/overlay/focus/FFB, microphone and STT/TTS behavior, radio timing, and whether strategy advice is useful and trustworthy to a human driver.

## Cost state

Product development and PITWALL cost research use this handoff as their shared entry point.

Measured source reports:

- `../OMORAY-PITWALL/reports/daily-cost/2026-08-09.md`
- `../OMORAY-PITWALL/reports/daily-cost/2026-08-10.md`
- `../OMORAY-PITWALL/reports/daily-cost/2026-08-11.md`

Month-to-date through 2026-08-11:

- 68.18 iRacing-connected hours
- 2,216 API calls
- Anthropic estimated cost: `$17.5427`
- Google estimated cost: `$2.6163`
- API variable cost: `$20.1590`
- simple August API-variable-cost projection: `$56.81`

These are measured usage plus pricing estimates, not reconciled invoices. Anthropic Console actual billing, Google Cloud actual billing/free-tier effects, Railway final fixed fees/tax/credits, Stripe net revenue, and per-paying-customer gross margin remain incomplete.

Cost varies heavily by behavior: observed daily user rates ranged from roughly `$0.0245` to `$1.1130` per connected hour. Do not price from the blended average alone. Build 266 must expose generated-but-not-played speech and wasted-generation cost before its strategy-radio expansion is considered cost-verified.

## Upcoming Founding renewals

Stripe screenshots supplied by Yuji on 2026-08-12 confirm that the two original one-month-free testers are active Founding subscriptions, not standalone expiring beta grants:

- Masato Takeda: first `$29.99` invoice scheduled for 2026-08-17.
- Masao Kamijo (Dirt): first `$29.99` invoice scheduled for 2026-08-21.

If they continue, Stripe charges automatically and PITWALL access remains active. If they do not continue, the subscription must be cancelled before its invoice date. The current webhook circuit handles `customer.subscription.deleted` and terminal `customer.subscription.updated` states by setting `users.is_member=false` and revoking the linked exe code; the entitlement middleware then blocks chat, translate, TTS, and STT on every request.

Operational audit:

1. Confirm each driver's intention before the invoice date; do not cancel on assumption.
2. After a requested cancellation/end date, verify the Stripe subscription state and corresponding PITWALL member/access-code state.
3. Check the next day's usage report for unexpected API usage.
4. If the webhook or state reconciliation fails, use the existing admin member revoke as the immediate fail-safe and investigate before restoring access.

Do not treat `billing_start` on legacy beta tokens as an expiry control; it is not enforced by `verifyBetaToken()`.

## Commercial state and forecast

Known commercial facts:

- Public offer: five-day free trial, then `$29.99/month` Founding price while membership remains active.
- Stripe and funnel plumbing have technical test evidence.
- The last recorded verified count of unrelated paying customers is zero.
- Current repository evidence does not contain up-to-date post-level funnel counts for LP visitors, CTA clicks, checkout starts, trials, first races, or paid conversions.
- Current measured users/testers must not be counted as prospects or paying-customer validation unless they independently enter the commercial funnel.

Working forecast for 2026-08-15 through 2026-09-30, before obtaining current funnel data:

| Scenario | Qualified prospects | Trial starts | First paid conversions |
|---|---:|---:|---:|
| Conservative | 3–8 | 0–2 | 0–1 |
| Base | 8–20 | 2–6 | 1–3 |
| Strong execution | 20–40 | 6–12 | 3–6 |

Definitions:

- **Qualified prospect:** an identifiable iRacing road driver who engages, asks for details, joins the relevant Discord/onboarding path, or starts checkout. Raw impressions and anonymous LP views do not count.
- **Trial start:** a real non-test Stripe trial.
- **Paid conversion:** the first successful non-test charge after the trial.

The base case is provisional, not a demand claim. With zero independently verified paid conversions and missing current funnel counts, a forecast above six paid customers by the end of September is not evidence-based yet.

### Free-access policy decision — 2026-08-12

Open-ended free access is discontinued as a default acquisition method. Evidence from Shouta, Jaff, Scott, and the recent tester-usage pattern suggests a plausible deferral problem: when access can be started at any time and costs the recipient nothing, there is no reason to begin now, complete onboarding, run a second session, or explain abandonment. This is a hypothesis about behavior, not yet a proven causal claim, but it is sufficient to remove the open-ended incentive.

Future ordinary trials must have two independent server-side deadlines:

- `must_activate_by`: the code becomes unusable if the recipient does not start by this date;
- `expires_at`: once activated, access ends after the defined trial duration (normally five days).

The intended lifecycle is:

`issued → waiting_for_activation → active_trial → converted | expired | revoked`

Requirements:

- Display the activation deadline before the user accepts the trial.
- Use server time; client clock changes and old builds must not bypass either deadline.
- Verify both deadlines on every cost-bearing API request.
- Record issued, first activation, first iRacing connection, second session, expiry, conversion, and post-expiry denial.
- Do not silently extend a trial because the user delayed installation or onboarding.
- Extensions are explicit, auditable owner/admin decisions with a reason.

Complimentary influencer access is a separate commercial instrument, not an unlimited tester code. It must have a named purpose, start/end dates, expected deliverable or evaluation point, cost attribution, and an owner-approved renewal. No perpetual free access by default.

The current `trial_5day` implementation starts five days at first verification but has no `must_activate_by`; this must be corrected before issuing the next ordinary free code.

The fastest way to tighten the forecast is to recover the actual funnel for the latest 14 and 30 days:

`lp_view → primary_cta_click → checkout_started → trial_started → first iRacing connection → second session → first_paid_invoice`

Then forecast from observed stage conversion and named-prospect capacity. Until those numbers are available, plan operationally for 1–3 new paid customers and ensure onboarding can comfortably support six.

## Owner decisions needed

None for the next local engineering slice. Codex can continue Build 266 implementation and verification autonomously.

Yuji approval will be requested only when a push/deploy/release or production/commercial action is ready.
