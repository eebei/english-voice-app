# INDYCAR Strategy Sample Cards v0

Purpose: establish human race-engineer decision patterns for OMORAY PITWALL.
These are public-reference *decision cards*, not scripts to copy or claims that
the same rules apply to iRacing.  Each card separates the applicable decision
shape from series-specific rules.

## How Luna should use a card

1. Confirm live facts and the applicable iRacing session rules.
2. Match the live situation to a card's trigger.
3. Build a Race Decision Packet before speaking: situation, decision, driver
   action, physical pit-exit prediction, blended pit-cycle prediction, and
   conditions that would invalidate the call.
4. Speak before the driver reaches pit road, then score the outcome.

## First 10 INDYCAR cards

| ID | Public reference | Situation and human decision pattern | PITWALL transfer |
|---|---|---|---|
| INDY-01 | [St. Petersburg alternate-tire tactics (2025)](https://www.indycar.com/news/2025/03/03-01-buzz) | Fast alternate tyres can create a stop before a fuel window; teams choose when to satisfy mandatory compounds and preserve durable tyres for the final stint. | Never treat fuel range as the only pit trigger. Compare fuel window, tyre state, mandatory tyre use, and final-stint objective. |
| INDY-02 | [Long Beach caution changed Dixon/Power tyre plans (2024)](https://www.indycar.com/news/2024/04/04-21-buzz) | An early caution made an early stop advantageous for one car but left another without the preferred compound for the final stint. | On a caution or sudden pit opportunity, report both the immediate gain and the tyre/fuel inventory cost later. |
| INDY-03 | [Nashville four-stop alternate strategy (2025)](https://www.indycar.com/news/2025/08/08-31-nashville-buzz) | A driver saved a faster compound for the final stint within mandatory compound rules; tire wear defined a four-stop race. | A pit plan must state the selected service and the purpose of the next stint, not only litres to add. |
| INDY-04 | [Alternate tyre rule and degradation objective (2024)](https://www.indycar.com/News/2024/09/09-06-Alternates-Nashville) | Series intentionally used a faster-wearing alternate to make tyre wear potentially end a stint before fuel. | Add a `tyre_ends_stint_before_fuel` branch; do not assume a fuel-only strategy. |
| INDY-05 | [St. Petersburg: pit stops cost estimated positions (2026)](https://www.indycar.com/news/2026/03/03-01-buzz-stpete) | A rookie and crew lost an estimated four positions through pit execution; in- and out-laps were highlighted as a key skill. | Report pit execution risk separately from strategic prediction; log actual positions lost and improve the pit-loss model. |
| INDY-06 | [Indy 500 pit performance as a race-outcome factor (2026)](https://www.indycar.com/news/2026/05/05-22-buzz) | A low-starting team expected pit performance and strategy to be central to its charge through the field. | Treat pit-lane loss as a first-class input to blended-position prediction, not background telemetry. |
| INDY-07 | [Fuel window design and fuel-saving incentive (2013)](https://www.indycar.com/News/2013/02/2-12-Fuel-options-for-teams) | Race length and fuel windows create a choice between pushing and stretching mileage to eliminate a stop. | When fuel is short, compare `pit now`, `pit later`, and `save-to-eliminate/shorten-stop`; say the driving consequence plainly. |
| INDY-08 | [Pit in/out laps and cold-tyre execution (2026)](https://www.indycar.com/news/2026/03/03-05-hauger-feature) | A rookie identified confident pit in/out laps and early cold-tyre execution as decisive racecraft. | After a stop, issue one brief, evidence-backed exit call.  Score whether the out-lap protected or lost the predicted position. |
| INDY-09 | [2026 tyre-use requirements](https://epaddock.indycar.com/docs/default-source/rules-regulations-and-policies/2026-indycar-rulebook.pdf?sfvrsn=56785b60_43) | Mandatory primary/alternate usage makes the rule contract part of every strategy call. | Session rules are authoritative inputs.  Luna must state the actual session format/rules, never invent or silently omit them. |
| INDY-10 | [Pit-stop performance: fuel, four tyres, wing adjustment (2020)](https://www.indycar.com/News/2020/09/09-18-BMartin-PitStops) | Fuel, four tyres and wing adjustments compete for pit-stop time. | Model the service bundle: fuel amount + tyres + repair/adjustment.  Give the driver the next-stop configuration before pit entry. |

## First acceptance scenario for PITWALL

**Monza GT3 AI Race, 20-minute timed session, 3+ clean fuel laps, forward
unpit group, driver says "next lap pit".**

Before pit entry, Luna must deliver one concise decision packet:

1. race format and remaining time from SessionInfo;
2. fuel target for the next stint/finish, current fuel, and **litres to add**;
3. tyre-service decision or explicit unavailable status;
4. immediate physical exit prediction;
5. blended position after the identified forward group completes normal stops;
6. confidence/range and the condition that can invalidate the blend.

After the pit cycle, PITWALL records immediate exit, blended result, service
time and forecast error.  A missed pre-pit call is an execution failure even
when the calculation later proves correct.
