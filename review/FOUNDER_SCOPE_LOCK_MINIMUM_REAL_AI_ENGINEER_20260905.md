# Founder Scope Lock: Minimum Real AI Engineer

Date: 2026-09-05
Authority: Founder decision
Audience: Claude Code, Codex and all PITWALL engineering/review work

## Decision

Freeze the next product-completion slice to:

1. safety calls (deterministic reflex);
2. GAP questions and relevant GAP change calls;
3. fuel and pit-window questions, confirmation and plan continuity.

This is not a permanent product reduction and not a decision to turn PITWALL into a spotter. The product objective remains unchanged: reproduce with AI what a real assigned race engineer does.

The founder currently assesses PITWALL at approximately 70% overall. Many components exist, but ordinary race conversation is not yet dependable. The remaining 30% contains most of the perceived product value because the complete driver-visible chain must succeed.

## Temporary testing and budget decision

- Two external testers remain paused.
- External testing cost is treated as a real validation/acquisition expense similar to advertising expenditure.
- Do not design the immediate development plan around paid or compensated multi-user testing.
- Use founder-only Windows/iRacing field runs plus saved-log replay until the fixed slice is dependable.
- Tester reactivation is a later founder decision; do not infer a date or budget.

## Layer contract

### Reflex layer

Safety events must remain deterministic, local where supported, immediate and able to interrupt lower-priority speech. This includes nearby/overlap/clear and stopped-car or incident warnings supported by reliable evidence.

### Authoritative fact layer

GAP, identity, direction/trend, fuel, remaining laps/time, required fuel and pit-window bounds must come from deterministic authoritative evidence. An LLM must not invent or alter these values.

### Engineer layer

The engineer layer must:

- understand the driver's question;
- select the relevant authoritative facts;
- answer the requested question first;
- preserve the plan agreed with the driver;
- observe relevant changes;
- explain the consequence for the plan briefly;
- revise or compare options only when evidence supports doing so.

This is the distinction between a telemetry reader and the minimum real AI Engineer.

## Required vertical race loop

```text
safety event -> correct priority interruption
driver GAP question -> correct target, direction, value and freshness
driver fuel/pit question -> correct fuel and window answer
driver agrees a plan -> plan stored with evidence and session identity
later turn -> same plan is retained
relevant evidence changes -> impact on plan is detected
engineer communicates only the useful consequence
audible final speech = Overlay final text = conversation-memory record
```

## Required implementation order

1. Reliable direct answers for the fixed fact domains.
2. Agreed-plan continuity across later turns.
3. Relevant change detection.
4. Concise plan-impact calls.
5. Contextual comparison of viable options.

Do not expand the active completion scope into broad setup coaching, video comparison, additional simulations or whole-field strategy until the vertical loop above passes founder field testing.

## Acceptance evidence

- Every utterance has one stable ID across candidate, queue, final TTS play, Overlay and conversation memory.
- A calculated answer is not credited unless the driver actually hears the relevant answer.
- All discard/non-play exits finalize the same utterance state and do not leave unheard speech as conversation memory.
- GAP answers bind value, target identity, direction, class relationship, source and freshness.
- Stopped cars are not presented as normal competitive GAP when stopped-car evidence is available.
- Fuel and pit-window answers use authoritative measured/calculated values and preserve the driver's agreed target/plan.
- Saved real-run replay fails before a fix and passes after it; synthetic/string-wiring checks alone are insufficient.
- Founder Windows/iRacing field evidence remains the release truth during this scope lock.

## Explicit non-goals for this slice

- broad automatic setup generation;
- video-based driving comparison;
- new character/language count;
- new simulator breadth;
- complete whole-field rival strategy;
- tester-growth or revenue targets.

These may remain in the roadmap, but they must not displace completion of the fixed slice.
