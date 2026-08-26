# IMSA Fixed Rival Strategy Learning Brief

## Product decision

PITWALL must not promise a guaranteed undercut, overcut, or race result.  Its job is to make the strongest currently supported call, state the evidence and uncertainty in one short radio message, then grade that call after the pit cycle.

The target user value is not a generic fuel calculator.  It is a transparent race-engineering loop for repeated official races: rival context, a bounded alternative, and an honest review of what actually happened.

## Initial scope

Start with IMSA Fixed, one official-week track/car combination at a time.  The repeated format makes samples comparable, but every stored observation must retain its condition key and must not silently mix incompatible sessions.

Required condition dimensions:

- series / season-week identifier when available;
- track configuration, car model, fixed-setup identity when available;
- session type, race distance / timed-race state, caution state;
- weather / track-state evidence when exposed;
- own driver, with no cross-driver performance attribution by default.

## What each strategy snapshot must compare

At each viable pit window, form separate, traceable scenarios:

1. Pit now.
2. Pit in +1 lap.
3. Pit in +2 laps only when fuel, capacity, and stint constraints permit it.
4. Stay out / fuel-save only when the required saving rate is evidenced.

Every scenario must use the same snapshot timestamp and include:

- own fuel, reserve, required service, and calibrated line-to-line pit loss;
- own recent clean pace, measured in-lap and out-lap behaviour where samples exist;
- current same-class field position, nearby pack, physical rejoin position, and blend risk;
- evidence status for each assumption.

Do not collapse a physical exit position and a post-cycle position into one claimed fact.

## Rival model: observe, do not invent

The simulator does not expose competitors' fuel, intended service, tyre condition, or pit plan.  PITWALL must therefore never say a rival *will* stop merely because that would make its own call work.

It may retain observations for the current official-week condition:

- when nearby rivals actually enter/exit pit road;
- observed line-to-line service duration and their in/out-lap pace;
- whether an observed nearby pack stopped in the same window;
- resulting physical and post-cycle class positions.

Until a sufficiently comparable history exists, the rival outcome remains conditional:

> "Pit now: physical P12. If the three-car pack ahead stops in its normal window, P9 is possible. Their move is not confirmed, so I cannot guarantee it."

This is correct product behaviour.  A rival choosing the opposite response is a genuine racing outcome, not a system failure.

## Strategy recommendation contract

A driver-facing recommendation must contain only:

1. Action: pit now / hold / save / wait for next crossing.
2. One measured reason: fuel window, measured pace edge, or safer physical rejoin.
3. One uncertainty clause whenever rival intent or post-cycle outcome is not observed.

Example:

> "Box this lap. You have the fuel window and a clear physical rejoin; position gain is possible if the pack ahead stops next lap, but their move is not confirmed."

No exact gained position, rival pit intent, or tyre benefit may be spoken as fact without corresponding evidence.

## Debrief: the learning loop

Each recommendation receives a decision ID.  After the relevant pit cycle, persist and review:

- selected scenario and alternatives;
- evidence available at decision time;
- actual pit-entry / exit timing and service;
- physical exit position and post-cycle class position;
- rival pack actions actually observed;
- fuel error, pace / in-out-lap delta, and whether the recommendation's stated condition occurred;
- result classification: supported win, supported loss, rival counter-move, execution loss, data unavailable, or model error.

The debrief should explain the outcome without rewriting history.  A correct conditional call can still lose when a rival counters it.

## Graduation gates

Do not use historical rival patterns as a strong recommendation until:

- samples are condition-compatible and auditable;
- physical rejoin forecast passes its real-run accuracy gate;
- each scenario is graded against actual outcomes;
- messages remain subordinate to critical / spotter radio priority;
- a no-evidence path says `unavailable` or conditional language rather than inventing a prediction.

## Cost policy

All live arithmetic and scenario construction remain deterministic and local.  Luna converts a confirmed recommendation into short radio language; it does not manufacture racing facts.  Normal test coverage uses internal simulation fixtures with no paid model calls.  A limited, explicitly approved real-provider evaluation is reserved for release validation only.
