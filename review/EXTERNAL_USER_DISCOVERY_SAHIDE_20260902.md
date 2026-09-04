# External User Discovery: Sahide X Thread

Date: 2026-09-02  
Audience: PITWALL product and engineering

## Executive correction

Do not interpret the X discussion as proof that PITWALL already exceeds these workflows. It does not. The founder's current assessment is that ordinary in-race conversation is not yet reliably successful. A correct internal calculation that is ignored, displaced, delayed or never spoken is a user-visible failure.

## What the posts actually establish

Sahide is expressing a desired PMR feature, not demonstrating his own implementation. His requested AI team would:

- analyze the driver's own laps;
- recommend concrete setup changes such as brake pressure and brake bias;
- separate qualifying and race setup;
- advise on pit strategy;
- accept conversational constraints and driver intent;
- execute an advice -> test -> verification -> improvement cycle;
- use game-internal physics, FFB and tire information if exposed.

Shirokuma reports a narrower manual experiment:

- a local AI was given driving video;
- braking and racing lines were compared with domestic and international videos;
- AI-generated prompts were used;
- the human repeatedly instructed the AI and manually applied its advice;
- the process reportedly improved performance but consumed a full day and caused fatigue.

## Product lesson

The strongest evidence is not merely demand for AI analysis. It is demand for elimination of the work required to operate the AI. PITWALL must acquire evidence, decide whether intervention is needed, deliver the useful call and evaluate the result without turning the driver into the AI's operator.

## Required engineering order

1. Ordinary race conversation must complete reliably.
2. A requested answer backed by existing telemetry/calculation must be delivered, not silently lost or replaced by another topic.
3. Implement one narrow improvement recommendation with clear evidence and a safe explanation.
4. Persist the recommendation and compare the next run to determine whether it worked.
5. Expand only after that loop works: broader setup coaching, video comparison, qualifying/race differentiation, and whole-race/rival strategy.

## Acceptance criteria for the first two steps

- The driver's utterance is captured and classified correctly.
- Relevant authoritative evidence is attached to the request.
- The response directly answers the request before optional commentary.
- Higher-priority safety/spotter calls may interrupt, but the answer is queued and resumed rather than discarded.
- The driver hears the answer within a defined deadline.
- Logs identify every failure stage: capture, classification, evidence retrieval, reasoning, scheduling, TTS or playback.
- A test passes only when the audible driver-facing result is verified; internal computation alone is not success.

## Non-goals for the immediate fix

- Do not market the long-term real-engineer vision as current capability.
- Do not add large setup, video or rival-analysis surfaces before the basic conversation/delivery tunnel works.
- Do not optimize feature count while answer delivery remains unreliable.

## Source posts

- https://x.com/ySzFThNBYxxNyaU/status/2094994566349021568
- https://x.com/ySzFThNBYxxNyaU/status/2095011643570995482
- https://x.com/ySzFThNBYxxNyaU/status/2094913734498209991
- https://x.com/ySzFThNBYxxNyaU/status/2095036435397300690
- https://x.com/ySzFThNBYxxNyaU/status/2095041286533464472
- Shirokuma manual experiment: https://x.com/TheGameingFafa/status/2095039885388501225
