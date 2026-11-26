# Performance Log

This file records measured live runs, not projections. Scores are the displayed per-run score. Auto-restart does not carry score across deaths. Server population is the dominant uncontrolled variable.

The browser trainer has separate offline validation in [TRAINER_TESTING.md](TRAINER_TESTING.md); this file covers the Python driver's live runs.

The current focus is **survival**. The longest zero-death run is 15 minutes.

---

## Result states

| State | Meaning |
| --- | --- |
| `NO-DEATH` | The run reached its time limit without a real death. |
| `DIED` | A body/head collision caused a real death. Auto-restart may have followed. |
| `CANCELLED` | The process was ended by the host environment, not by the game. Not a death. |
| `FILTERED` | A crowded spawn was rejected by the start filter. Not counted as a death. |

A long session may include several starts. A session with a real death is recorded as `DIED` even if auto-restart continued it. `CANCELLED` is used only when no real death occurred before the process ended.

---

## Current results

| Run | Server | Duration | State | Deaths | Best len | Best score | Kills |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| test 29, pre-hunt baseline | quiet server | 15m00s | `NO-DEATH` | **0** | 108 | **2,244** | 4 |
| test 56, hunt on | forced `66.165.238.34` | 11m08s | `DIED` | 1 | 102 | 2,053 | 2 |
| test 32, pre-hunt baseline | quiet server | 20m00s | `DIED` | 2 | 78 | 1,449 | 5 |
| test 53, hunt on | `181.41.140.170` | 15m00s | `DIED` | 3 | 67 | 1,202 | 1 |
| test 63, new-build long attempt | forced `92.222.100.202` | 7m22s first run | `DIED` | 1 | 62 | 1,093 | 3 |
| test 64, long attempt | forced `213.159.5.171` | 17m00s, 3 starts | `DIED` | 2 | 59 | 1,038 | 2 |
| final embedded validation | default pick `181.41.140.170` | 15m00s | `DIED` | 2 | 53 | 907 | 2 |
| test 58, new-features smoke | forced `213.159.5.171` | 4m00s | `NO-DEATH` | 0 | 39 | 647 | 1 |
| test 65, second long attempt | forced `148.113.20.151` | 9m00s, 4 starts | `DIED` | 3 | 36 | 589 | 0 |
| test 57, hunt off | forced `66.165.238.34` | 3m46s | `DIED` | 1 | 28 | 441 | 1 |
| test 66, post-restart retry | forced `213.159.5.171` | 2m48s | `CANCELLED` | 0 | 28 | 433 | 1 |

### Best results by category

| Category | Run | Result |
| --- | --- | --- |
| Longest zero-death run | test 29 | 15 min, length 108, score 2,244, 4 kills |
| Best hunting-enabled score | test 56 | length 102, score 2,053, 2 kills |
| Best latest-planner score | test 63 | length 62, score 1,093, 3 kills |
| Best no-death smoke with new features | test 58 | 4 min, length 39, score 647, 1 kill |

---

## Feature-era comparison

| Era | Planner | Best len | Best score | Notes |
| --- | --- | ---: | ---: | --- |
| v1, tests 1–28 | embedded `BOT_JS` | 75 | 1,393 | fixed flee radius, no hunting |
| pre-BIGRUN v2, tests 29–32 | `bot_v2.js` | **108** | **2,244** | best survival so far |
| BIGRUN, tests 33–47 | v2 + BIGRUN | 60 | 1,059 | BIGRUN regressed survival; now opt-in and off |
| hunting v2.1, tests 48–58 | coil / boost / corpse | 102 | 2,053 | growth and kills, shorter survival sample |
| self-grid v2.2, tests 59–66 | self-body + lag + open bias | 62 | 1,093 | production gate 140 not reached live |

BIGRUN is historical. It is disabled by default and should not be re-enabled without new A/B evidence.

---

## Death profile

The historical death profile through era 47 (68 deaths) was:

- Median death length: **34**
- 49% below length 30
- 66% below length 50
- Attributed causes: big-snake flee 40%, unattributed 21%, coil 15%, BIGRUN 12%, matador 6%, kill mode 6%

That profile predates the current self-grid and proactive booster evasions, so the percentages are not current. The recent long-run deaths are more specific:

- **test 63:** length 62, nearby count 9 to 12, negative clearance. A multi-snake box-in, not a self-coil.
- **test 64 death 1:** length 59, nearby count 4, negative clearance.
- **test 64 death 2:** length 39, nearby count 8, negative clearance.
- **test 65:** four starts on a crowded server. Best length 36 / score 589.
- **test 66:** no death. Cancelled by the host at length 28 / score 433.

The recurring killers remain:

1. Boosted big snakes (length 100 to 324, speed 438) attacking from the side or rear.
2. Fast tiny snakes (length 2 to 20, speed 438) cutting inside a turn.
3. Multi-snake box-ins between length 20 and 100.
4. Dense starts where the escape lane closes before the planner reacts.

The common terminal signature is a negative clearance and no valid safe heading (`safe=0/112`), but that is the final state, not the root cause. The positioning failure happens earlier.

---

## Growth rate

The displayed score is computed as:

```text
floor((fpsls[sct] + fam/fmlts[sct] - 1) * 15 - 5)
```

While alive, the bot gains roughly **150 to 185 score per minute**. Growth is not the bottleneck. Survival is: the best zero-death run is 15 minutes, and most runs end well before that.

Server quality is not stable. One server's population changed noticeably during a single 11-minute run, so compare runs on the same server whenever possible.

---

## Validation gaps and open problems

1. **Production self-grid gate.** The length-140 self-body insertion has not been exercised in a live run. A separate validation lowered `SELF_COLLISION_MIN_LEN` to 8 and logged `[SELFGRID] len=8 segs=5 stride=1 body=235 skip=95`. Geometry tests covered straight, 90°, 180° and 270° candidate turns with positive self-clearance.
2. **Multi-snake crowd escape.** The planner still reaches `safe=0/112` in boxes of 4 to 12 snakes. Proactive lane selection is needed.
3. **Boosted side and rear attacks.** The proactive response fires (`[FAST]` appears repeatedly) but does not prevent all boosted collisions.
4. **Boost intercept validation.** The gated boost cut-off has not produced a validated live kill. It remains intentionally dormant.
5. **Server selection.** `ac` is a poor proxy for arena density. Servers should be ranked by measured nearby-snake counts.

Contributions and reproducible death logs are welcome. See [../CONTRIBUTING.md](../CONTRIBUTING.md).
