# Engineer Intent × Response Contract V1

Build 255 converts the strategy samples into runtime contracts. Samples supply the response shape; live SDK/derived telemetry supplies every number.

| Intent | Example driver wording | Truth input | Fixed response shape | Runtime result |
|---|---|---|---|---|
| `current_fuel` | 燃料は？ | `fuel` | current litres | handler |
| `fuel_use` | 燃費は？ | `fuel_strategy` | L/lap, samples, range | handler |
| `fuel_plan` | 何L入れる？ | `fuel`, `fuel_strategy` | current, required, add, set | handler |
| `race_distance` | 残り何周？ | clock/final-lap authority | clock plus confirmed crossings | handler |
| `pit_loss` | ピットロスは？ | exact stop or calibration | exact/latest, otherwise median and band | handler |
| `pit_service` | 直近の作業は？ | `last_pit_service` | IN→OUT, stationary, fuel added | handler |
| `pit_decision` | Box or stay out? | owned strategy plan | decision plus one measured reason | handler |
| `rejoin` | 何番手で復帰？ | Phase C forecast/cycle | physical, range, conditional cycle | handler |
| `traffic_status` | 復帰トラフィックは？ | Phase C forecast | state, ahead, behind | handler |
| `plan_status` | プランは？ | `strategy_plan` | revision, action, reason | handler |
| `pace` | 上げていい？ | fuel margin/plan | push, hold, or box priority | handler |
| `current_position` | 今何位？ | SDK class/overall position | class and overall | handler |
| `position_gap` | P19まで？ | F2 standings gap | signed target reduced to driver-facing magnitude | handler |
| `leader_gap` | 首位まで？ | explicit class leader | class-leader gap only | handler |
| `tyre_status` | タイヤは？ | SDK wear/temperature | per-corner measured values or unavailable | handler |
| `damage_status` | ダメージは？ | SDK repair seconds | repair time; no aero inference | handler |
| `weather_status` | 路面は？ | SDK weather | track/air/humidity/wetness | handler |
| `unresolved_operational` | operational wording not classified | none | handler unavailable; no guess | fail-closed |

Runtime trace contract:

`[INTENT_ROUTE] intent=<intent> confidence=<0..1> handler=fired|unavailable`

Memory trace contracts:

- `[MEMORY_COMMIT] ... readback=verified`
- `[MEMORY_IMPORT] received=<n> local_verified=<n> server_ack=<n>`
- `[MEMORY_CONTEXT] ... injected=<n>`

No `saved`, `imported`, or `injected` completion claim is valid without its corresponding trace and, for protected imports, the server ACK.
