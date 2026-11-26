# Trainer testing and the v0.2.1 body-collision fix

This document covers the browser-injectable trainer in `panel/trainer/`, its
offline Playwright tests, and the body-visibility bug that caused the trainer to
ram other snakes in a live run.

The production trainer still does **not** launch a browser, navigate, click
**Play**, reconnect, or create a run. The Playwright harness is test-only.

---

## The body-ramming failure

The reported failure was simple: the trainer sometimes drove straight through
another snake's body and died, even though the same planner avoided heads and
walls reliably.

The threat collector in v0.2.0 used the enemy **head** distance as a gate:

```text
if head is farther than THREAT_RANGE (2,400):
    skip this snake completely
```

That is wrong for a long snake. A body can cross directly in front of the
player while the head is thousands of units away. Those body points were never
added to the planner, so the rollout saw a clear path and the snake died on the
body.

A second, related problem was the global body-point budget. Body points were
appended to one shared list and capped. In a crowded scene, points near the
head end of nearby snakes could fill the budget before the crossing point of a
different snake, or before the locked hunt target's body. The planner then
looked safe even though the relevant body was missing.

### Reproduction

The regression scenario is `body_far_head` in
`panel/trainer/tests/sim_modes.html`:

- player at `(16384, 16384)`;
- enemy head at `(16684, 18984)`, about 2,600 units away, outside the 2,400
  threat range;
- enemy body vertical at `x = 16684`, crossing the player's path at about 300
  units ahead.

Before the fix, this scenario produced a collision and the trainer died. The
test now requires zero collisions and positive clearance.

A second scenario, `body_target_last`, puts the locked target last in
`window.slithers` behind eight head-far decoy bodies. It asserts both that the
target is still acquired and that the target's body points appear in the
planner snapshot. This is the regression test for the shared-budget problem.

---

## The fix

The collector now stores bodies separately from static heads:

```text
collectThreats()
  heads[]        live heads for collision and hunting
  points[]       static head points for the current frame
  bodies{id}     body points for each snake
  bodyNear{id}   nearest sampled body distance
```

Body points are collected independently of head distance. For each snake, a
bounded max-heap keeps the nearest `THREAT_POINTS` body points inside the body
threat range. This means a nearby crossing cannot be lost behind a long tail,
a deep coil, or a crowd of other snakes.

`buildBodyPoints(threats, targetId)` then builds the actual planner obstacle
list:

1. the current hunt target's body first;
2. the remaining bodies ordered by nearest sampled distance;
3. the shared `THREAT_TOTAL` cap.

The planner uses `headPoints + prioritized bodyPoints + selfBody` as obstacles.
Snapshots and the radar use the same prioritized body list, so what the planner
sees and what the UI shows cannot diverge.

The body-point cap remains bounded (`THREAT_POINTS = 64` per snake,
`THREAT_TOTAL = 460` overall), and the bounded nearest-point heap keeps the
per-frame cost flat enough for the existing 60 fps target. A 24-snake,
140-point-per-snake benchmark still measured 60 fps in the installed Chrome
channel.

---

## Test harness

The suite is in `panel/trainer/tests/`. It uses Playwright with the browser that
owns the default HTTP handler on Windows:

- `ChromeHTML` -> Playwright `channel="chrome"`;
- `MSEdgeHTM` -> Playwright `channel="msedge"`;
- otherwise the other installed channel, then bundled Chromium.

Set `TRAINER_BROWSER=chrome`, `msedge`, or `chromium` to override detection.
The browser channel does not download a browser; only the bundled-Chromium
fallback needs `python -m playwright install chromium`.

```bash
python -m pip install -r panel/trainer/tests/requirements.txt
python panel/trainer/tests/run_all.py
```

Individual suites:

| Command | Checks |
| --- | --- |
| `python panel/trainer/tests/test_modes.py` | 18 closed-loop scenarios: walls, head-on, crossing, hunting, corpse feast, radar, and four body regressions. |
| `python panel/trainer/tests/test_takeover.py` | 29 takeover/release, death handling, handler restoration and input-shield checks. |
| `python panel/trainer/tests/test_hunt_radar.py` | 37 hunt/cut/kill, feast, radar range/drawing and panel-control checks. |
| `python panel/trainer/tests/bench.py` | Planner FPS with five enemies and 120 points each. |
| `python panel/trainer/tests/bench.py --enemies 24 --segments 140` | Crowded-scene FPS stress test. |

`--headed` shows the browser. `test_modes.py --modes body_far_head` runs one
scenario. The test pages are local files; they do not contact slither.io.

The body scenarios specifically check:

| Scenario | Assertion |
| --- | --- |
| `body_far_head` | Zero collisions; positive enemy clearance despite the head being outside the 2,400 range. |
| `body_far_moving` | The head-far body sweeps sideways through the path and remains visible to the planner. |
| `body_target_last` | Target acquired; target body present in the snapshot; zero collisions while eight decoy bodies compete for the budget. |
| `body_many` | Ten long head-far bodies do not cause a collision. |

The runner treats page errors as failures. The closed-loop runner also fails on
a simulated collision, non-positive wall clearance, or missing takeover.

---

## Validation results

Reference environment: Windows, Playwright 1.59.0, installed default Chrome
channel (Chrome 155), headless mode.

```text
test_modes.py       18/18 modes passed
test_takeover.py    29/29 checks passed
test_hunt_radar.py  37/37 checks passed
bench.py            60 fps, 5 enemies x 120 points
bench.py --enemies 24 --segments 140
                    60 fps, 24 enemies x 140 points
```

Representative body minima from one full run:

| Scenario | Simulated frames | Collisions | Minimum enemy distance |
| --- | ---: | ---: | ---: |
| `body_far_head` | 500 | 0 | 200.5 |
| `body_far_moving` | 500 | 0 | 220.8 |
| `body_target_last` | 501 | 0 | 113.8 |
| `body_many` | 500 | 0 | 401.3 |

The mock collision radius is the sum of the two body radii. The planner uses an
additional safety margin, so these minima are not the actual collision
threshold.

A short live probe was also run on 2026-11-26 against slither.io. A one-off
Playwright probe started a run, injected the final v0.2.1 trainer, and clicked
**Take over**; the production trainer did not start the run. Takeover was active
for about 21 seconds. The snake survived, stayed clear of nearby bodies, and
there were no trainer page errors. The game itself logged
IPv6 WebSocket fallback failures while choosing a server; those were not trainer
errors. The snake was too small to qualify a hunt target during that probe.
Release returned the panel to idle and did not click **Play Again** (zero play
clicks). This is a smoke check only; live server latency and other players
cannot be made deterministic in this suite.

---

## Live test checklist

The user should still do a short live test before publishing, because the
offline pages cannot reproduce the live server:

1. Start slither.io manually and spawn a snake.
2. Paste `panel/trainer/trainer.js` into the DevTools console.
3. Confirm the panel header shows `v0.2.1`.
4. Click **Take over** and check steering, radar and FPS.
5. Approach a long snake's body, preferably with its head off-screen; confirm
   the trainer turns away instead of crossing it.
6. Click **Release** and `Alt+Shift+X`; confirm the game gets control back.
7. Let the snake die once and confirm the trainer stops without clicking
   **Play Again** or creating a new run.

---

## Limitations

- The local mock is a geometry/behaviour test, not a server simulator. It does
  not model live collision resolution, network jitter, anti-cheat, or other
  players' decisions.
- A body with more than 64 sampled points inside the 2,520-unit body range
  keeps only its 64 closest points. Points farther along the same body can be
  omitted, but the nearest crossing is retained; the target body is also
  prioritized first in the shared budget.
- The test suite is offline by default. The live probe is one-off and
  non-deterministic.
- Bots may violate the game's terms of service. Use the trainer sparingly and
  only on a run you started yourself.

See also:

- [`panel/trainer/README.md`](../panel/trainer/README.md)
- [`panel/trainer/tests/README.md`](../panel/trainer/tests/README.md)
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)
