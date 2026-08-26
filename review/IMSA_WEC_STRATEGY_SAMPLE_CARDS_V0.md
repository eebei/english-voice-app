# IMSA / WEC Strategy Sample Cards v0

Purpose: collect **observable professional decision patterns** that PITWALL can imitate first.  These are not a rules database for iRacing.  At runtime, iRacing SessionInfo, the current session rules, telemetry and calibrated local pit loss remain authoritative.

Each card is deliberately written as: `situation -> decision -> driver call -> evidence to grade`.  That is the layer Luna currently lacks.

## IMSA cards

| ID | Situation and professional pattern | PITWALL transfer / required call | Source |
|---|---|---|---|
| IMSA-01 | A timed race can become a fuel-mileage finish; the final number of laps is a moving target. | Early: `Finish target is provisional: N laps / X L. Next update at the next clean lap.` Never pretend the lap count is fixed before evidence. | [IMSA: Mid-Ohio fuel strategy](https://www.imsa.com/news/2021/05/20/fueling-the-drama-mid-ohio-a-prime-example-of-how-strategy-builds-excitement/) |
| IMSA-02 | Strategy room considers controllable variables (tyres, fuel, driver order) and external variables (weather, track, competitors) together. | One pre-pit sentence must name the inputs: self pace, rival/group status, service package and pit-loss calibration. | [IMSA pit-lane strategy room](https://www.imsa.com/news/2023/12/20/pit-lane-team-always-seen-rarely-heard/) |
| IMSA-03 | Tyre double-stinting can gain track position; it is a conscious trade against pace/life. | Offer `tyres` and `no tyres` as separate service scenarios, each with loss and predicted blended position. Do not call a tyre change by default. | [IMSA tyre-use strategy](https://www.imsa.com/news/2026/01/22/new-imsa-michelin-sustainability-in-racing-award-program-launches-at-rolex-24-at-daytona/) |
| IMSA-04 | Long Beach showed extended tyre life enables longer first stints, staggered stops and partial-tyre choices. | The forecaster needs an option set, not one magic answer: short/undercut, cover, stay out, and tyre-service variants. | [IMSA Long Beach strategy](https://www.imsa.com/press-releases/042019/new-records-strategies-highlight-michelins-100-minute-long-beach-street-fight) |
| IMSA-05 | A caution can turn a stop just before it into track position; clean air can be worth more than nominal pace. | Detect field compression and pit intent. Say conditional outcomes: `Pit now: physical Pxx; if this goes green / if a caution arrives, net Pyy.` | [IMSA Laguna Seca caution call](https://www.imsa.com/news/2022/04/30/cagey-strategy-bolts-volt-aston-martin-to-michelin-pilot-challenge-win/) |
| IMSA-06 | Fuel target and traffic are managed concurrently over a stint, and teams watch rivals who go off strategy. | `Target pace` must be tied to the next decision: push, hold, fuel-save, or protect tyres—plus the trigger to cancel it. | [IMSA CTMP race report](https://www.imsa.com/news/2026/07/12/inter-europols-dillmann-clarke-deliver-pole-win-double-at-ctmp/) |
| IMSA-07 | A small execution failure in the box can erase a strategy; fuel-only and tyre-service outcomes differ. | Record actual lane+stationary loss by service bundle. Luna must say `calibrated` or `not yet calibrated`, never claim it has no history when it does. | [IMSA fuel-save / pit error example](https://www.imsa.com/news/2019/09/17/park-place-motorsports-fuel-strategy-save/) |
| IMSA-08 | Endurance outcomes combine pace, multiple stops and execution—not pace alone. | Grade every stop: forecast announced before pit entry? actual physical exit? blended post-cycle position? pit-loss error? | [IMSA endurance strategy](https://www.imsa.com/news/2024/09/13/doubling-endurance-fun-doubles-strategy-for-final-two-races/) |
| IMSA-09 | GTP manages stint energy as well as fuel; the transferable lesson is a finite-stint budget, not the GTP rule itself. | PITWALL schema should support `resource budget -> predicted end -> required top-up -> confidence`, with fuel as today’s resource. | [IMSA virtual energy explanation](https://www.imsa.com/news/2023/09/27/high-tech-pit-stops-how-does-gtp-virtual-energy-replenishment-work/) |
| IMSA-10 | Some series have mandatory stops/minimum times and prohibit simultaneous fuel/tyre work. Those details are series-specific. | Read the current session rule; never borrow a real-series restriction into an iRacing race. If unavailable: `Rule not verified; no rule-based instruction.` | [IMSA Endurance Challenge format](https://www.imsa.com/news/2026/03/03/imsa-airbnb-endurance-challenge-premieres-at-sebring-for-lmp3-competitors/) |

## WEC cards

| ID | Situation and professional pattern | PITWALL transfer / required call | Source |
|---|---|---|---|
| WEC-01 | Safety-car timing can rewrite a fuel plan; a splash may still be necessary. | Keep an explicit `green plan` and `neutralised plan`; announce which is active and what evidence caused the switch. | [WEC São Paulo race report](https://www.fiawec.com/en/news/race-report-lmp-first-historic-fia-wec-victory-for-toyota/582) |
| WEC-02 | Double-stint can be the best overall choice even when the second stint is slower. | Compare seconds saved in service with seconds lost in tyre pace; do not reduce it to `fresh is faster`. | [WEC Shanghai driver report](https://www.fiawec.com/en/news/what-the-drivers-said-after-the-6-hours-of-shanghai/4565) |
| WEC-03 | Tyre wear can veto a double stint even if fuel and position make it tempting. | A double-stint recommendation needs a tyre-evidence threshold; if telemetry cannot support one, state it is unverified. | [WEC São Paulo tyre-wear report](https://www.fiawec.com/en/news/what-the-drivers-said-after-the-6-hours-of-sao-paulo/2816) |
| WEC-04 | Single- and double-stint choices can diverge on the same circuit; the decision is empirical. | Store per driver/car/track/conditions stint pace deltas, then revise the recommendation after the stop. | [WEC Fuji tyre strategy](https://www.fiawec.com/en/news/toyota-are-home-town-heroes-at-fuji/2463) |
| WEC-05 | Heat and reduced tyre allocation can force a double-stint plan. | Treat track condition and tyre allocation as plan inputs when the session exposes them; otherwise do not fabricate a tyre-life claim. | [WEC COTA tyre challenge](https://www.fiawec.com/en/news/sebs-secrets-of-cotas-toughest-challenge/5396) |
| WEC-06 | A driver can protect tyres while holding reserve for a possible safety car. | `Manage` needs an objective and end condition: `manage tyres until rival pit window / safety-car decision`, not a vague instruction. | [WEC São Paulo press conference](https://www.fiawec.com/en/news/sao-paulo-post-race-press-conference/8037) |
| WEC-07 | A safety car bunches the field while teams run different tyre strategies. | Group detection must feed the forecast: distinguish a forward pack from isolated cars and calculate their likely common pit window. | [WEC Imola race report](https://www.fiawec.com/en/news/ferrari-in-charge-and-on-a-charge-at-imola/8284) |
| WEC-08 | A double-stint requires a car/driver combination that can deliver consistent laps, not merely survive. | Pace model uses clean-lap trend and traffic context; flag `degrading`, `stable`, or `insufficient evidence`. | [WEC Shanghai strategy diary](https://www.fiawec.com/en/news/more-than-a-race-ryan-dalziels-shanghai-diary/2598) |
| WEC-09 | Hot conditions make the push-versus-tyre-care decision non-trivial, so the engineer must be specific. | Driver call format: `Push for two laps to clear traffic, then return to target`; every push call has a duration and reason. | [WEC COTA race press conference](https://www.fiawec.com/en/news/what-the-drivers-said-lone-star-le-mans-race-press-conference/8069) |
| WEC-10 | “Splash & dash” is a recognised distinct service choice near the finish. | Fuel output must always give `current / stint target / add` early enough for the driver to set it, with a final-lap top-up scenario separated. | [FIA WEC media guide](https://press.fiawec.com/assets/fileuploads/69/de/69de3eb7877d4.pdf) |

## What becomes product requirements, not commentary

1. **Before the pit road, not in it.**  Once a stop is likely, issue: `current fuel -> stint/end target -> add litres -> service options -> decision deadline` at least one lap before entry.
2. **Two positions, always labelled.**  `Physical exit` is the immediate order after the stop. `Blended pit-cycle position` is the strategic result after the relevant rival/group stops. The latter is the primary recommendation; the former is a risk reference.
3. **A conditional forecast is allowed; an unexplained one is not.**  Each forecast names the rival group/window and the pit-loss assumption. Example structure: `Exit P20. If the P8–P16 pack stops in its normal 1–2 lap window, blended P8–P10. If they stay out, P15 or worse.`
4. **Luna is never the database.**  Deterministic telemetry/rules/pit calibration own the facts. Luna converts confirmed facts and a queued engineer task into a concise radio call.
5. **Every promise becomes a graded task.**  If Luna says it will compare the forward pack, the runtime creates a task with trigger, deadline and required evidence. Debrief records completed / missed / inaccurate—not another vague promise.

## First GT3 acceptance test derived from these cards

For the next Monza 20-minute AI Race, the pass condition is not “Luna sounds clever.”  Before the planned stop, it must produce one traceable call containing:

`race format | current fuel | target fuel | add litres | self clean-lap trend | forward pack status | pit-loss source | physical-exit range | blended-position range | decision deadline`.

After the pit cycle, it must report the two actual positions separately and state why the forecast moved.  If any required telemetry is missing, it says exactly which field is unverified rather than filling the gap with language-model guesswork.
