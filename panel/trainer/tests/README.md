# Trainer tests

Offline Playwright tests for `panel/trainer/trainer.js`. The trainer itself
never launches or controls a browser; only this test harness does. The test
pages are local files, so the closed-loop suite does not connect to slither.io.

The harness prefers the browser that owns the default HTTP handler on Windows:
`ChromeHTML` uses Playwright's installed Chrome channel, and `MSEdgeHTM` uses
Edge. It falls back to the other installed channel, then to bundled Chromium.
Override detection with `TRAINER_BROWSER=chrome`, `msedge`, or `chromium`.

## Setup

```bash
python -m pip install -r panel/trainer/tests/requirements.txt
```

Installed Chrome/Edge is used directly. Bundled Chromium is only needed when
neither channel is available:

```bash
python -m playwright install chromium
```

## Run everything

```bash
python panel/trainer/tests/run_all.py
```

`--headed` shows the browser. `--quick` cuts the closed-loop scenarios to four
seconds each. The full suite is about two to three minutes on the reference
machine.

## Run individual suites

```bash
# 18 closed-loop collision, wall, hunting, body, feast and radar scenarios
python panel/trainer/tests/test_modes.py

# 29 takeover, release, death-handling and input-shield checks
python panel/trainer/tests/test_takeover.py

# 37 hunt, corpse-feast, radar and panel-control checks
python panel/trainer/tests/test_hunt_radar.py

# planner FPS with a synthetic crowd
python panel/trainer/tests/bench.py
python panel/trainer/tests/bench.py --enemies 24 --segments 140 --min-fps 50
```

Useful options:

```bash
python panel/trainer/tests/test_modes.py --seconds 5
python panel/trainer/tests/test_modes.py --modes body_far_head,body_target_last
python panel/trainer/tests/test_takeover.py --headed
```

## Body regression scenarios

| Scenario | What it proves |
| --- | --- |
| `body_far_head` | A body crossing 300 units in front is avoided even when its head is outside the 2,400-unit threat range. |
| `body_far_moving` | A head-far body sweeps sideways through the path and remains visible to the planner. |
| `body_target_last` | The locked target's body is planned against first when eight head-far bodies compete for the body-point budget. The test also asserts that the target body appears in the snapshot. |
| `body_many` | Ten long, head-far bodies around the spawn do not cause a body collision. |

`body_far_head` reproduced the live ramming bug before the v0.2.1 fix: the
enemy head was 2,600 units away, its body crossed the trainer's path, and the
trainer died with one collision. After the fix it completes with zero
collisions and roughly 200 units of minimum enemy clearance.

## Reference result

Validated on Windows with Playwright 1.59.0, the installed default Chrome
channel (Chrome 155), and headless mode:

```text
test_modes.py       18/18 modes passed
test_takeover.py    29/29 checks passed
test_hunt_radar.py  37/37 checks passed
bench.py             60 fps, 5 enemies x 120 points
bench.py --enemies 24 --segments 140
                     60 fps, 24 enemies x 140 points
```

Console and page errors are treated as failures. The closed-loop suite also
fails on any simulated collision, a non-positive wall clearance, or a missing
takeover.

## Limits

These are geometry and UI tests, not a replacement for a live run. The mock
pages approximate the client's trail, turn, speed and collision model, but they
do not reproduce server latency, other players' decisions, anti-cheat, or the
live server's exact collision resolution. Run a short manual live session before
publishing a trainer change. See
[`docs/TRAINER_TESTING.md`](../../../docs/TRAINER_TESTING.md) for the full test
protocol and root-cause notes.
