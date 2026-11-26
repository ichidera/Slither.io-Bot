# Slither.io Bot

A headless Playwright bot for [slither.io](https://slither.io) with a self-contained JavaScript planner injected into the live browser page.

The bot reads the game's own state (`window.slither`, `window.slithers`, `window.foods`, etc.) and writes steering through `window.xm` / `window.ym`. It does not reconstruct the game from pixels or network traffic.

![Slither.io Bot playing](assets/slither_playing.png)

> **Project status: experimental.**
> The current focus is **survival**: how long the bot can stay alive in a crowded arena. The longest zero-death run so far is **15 minutes** (length 108, score 2,244). See [Results](#results).
>
> Maintained by **ichidera**. Contributions are welcome, see [Contributing](#contributing).

> **Responsible use:** this is a research project about planning and collision avoidance. It is not affiliated with Slither.io or Lowtech Studios, and using bots may break the game's terms of service. Run it sparingly, one instance at a time, and don't use it to disrupt other players or to hammer the game's servers. Use it at your own risk.

---

## How it works

- **Live-state planner:** a `requestAnimationFrame` loop at roughly the client's 30 Hz cadence.
- **2.2 s rollout:** 48 coarse and 64 fine heading candidates, turn-rate limits, and a 240 ms control/server lag model.
- **Threat capsules:** enemy body points and birth-stamped moving head trails in a spatial grid, with velocity-dependent safety halos.
- **Self-body modeling:** above length 140 the bot's own visible trail is inserted into the grid. Candidate paths that loop back within two body radii of an older point are rejected.
- **Per-target reaction lag:** enemy headings are held for roughly 0.05 s for fast tiny boosters and 0.09 to 0.11 s for ordinary and long snakes before easing toward the requested heading.
- **Open-space bias:** every 400 ms the planner scores eight surrounding sectors by enemy and wall clearance and nudges ordinary farming toward the best one.
- **Boosted-snake evasion:** run when a booster approaches from behind, cut perpendicular when head-on, ignore when moving away.
- **Near-wall escape:** turns inward instead of hugging the rim.
- **Optional behaviours:** an offensive coil, a gated boost cut-off and a corpse sweep exist as feature flags (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). BIGRUN is off by default because A/B tests showed more boosted deaths without reliable growth.

The production planner is embedded in `slither_bot.py` as `BOT_JS`. `bot_v2.js` is the editable source, and `run_v2.py` reloads it after each death for fast iteration.

---

## Requirements

- Python 3.11+
- Node.js is **not** required at runtime. It is only used for `node --check` during development.

```bash
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium
```

If Chromium is already installed elsewhere, set `PLAYWRIGHT_BROWSERS_PATH` or pass `--browser /path/to/chrome`.

---

## Usage

```bash
python slither_bot.py --headless                    # run until Ctrl+C
python slither_bot.py --headless --verbose          # planner logs
python slither_bot.py --headless --seconds 1800     # stop after 30 minutes
python slither_bot.py --headless --games 5          # stop after 5 deaths
python slither_bot.py --headless --nick Survivor    # in-game nickname
```

| Flag | Description |
| --- | --- |
| `--url URL` | Game URL |
| `--headless` | Run Chromium without a window |
| `--games N` | Stop after N deaths (`0` = until Ctrl+C) |
| `--seconds N` | Stop after N seconds (`0` = no limit) |
| `--verbose` | Print planning decisions |
| `--browser PATH` | Use a specific Chromium/Chrome executable |
| `--nick NAME` | In-game nickname (default `Survivor`) |
| `--server IP:PORT` | Force a specific server |
| `--start-max-threats N` | Abort and reconnect if more than N threats are near the spawn (default 8) |
| `--abort-attempts N` | How many crowded spawns to reject before accepting one (default 3) |
| `--no-start-filter` | Disable the crowded-spawn filter |

The driver restarts automatically after a real death. Aborted starts are not counted as deaths.

### Development runner

```bash
python run_v2.py --headless --seconds 900 --verbose
```

The runner loads `bot_v2.js` from disk, so edits take effect on the next death or restart without rebuilding the embedded string. When a change is ready for the production driver:

```bash
python tools/sync_embedded.py
python tools/sync_embedded.py --check
```

### Browser trainer panel (live session)

`panel/trainer/` injects a control panel into a slither.io tab you already have
open. It takes over the snake in that live session instead of launching a new
browser or creating a new run. Start the run yourself, inject the panel, then
click **Take over**. v0.2.1 fixes body ramming: enemy bodies are collected even
when their heads are outside the 2,400-unit threat range, and the hunt target's
body is prioritized in a crowd. v0.2.0 added the 2,400-unit threat radar,
time-to-collision and faster-chaser evasion, smaller-snake hunting with
chase/cut/coil maneuvers, corpse feasts, and tunable safety, aggression and radar
controls. See [panel/trainer/README.md](panel/trainer/README.md) and
[docs/TRAINER_TESTING.md](docs/TRAINER_TESTING.md).

### Server probing

The client's quiet-server pick uses `ac` (active connections), which can be high even when the actual arena is sparse. `probe_tops.py` samples candidate servers and reports how many snakes are within 1k / 2k / 4k units.

```bash
python probe_tops.py
python slither_bot.py --headless --seconds 3600 \
  --server 213.159.5.171:444 --start-max-threats 6 --abort-attempts 5 --verbose
```

### Recon probes

Read-only scripts that dump live game state, for developing and debugging the planner:

```bash
python recon/recon_slither.py
python recon/recon_food.py --out food_probe.json
python recon/recon_mechanics.py --out slither_mechanics.json
```

---

## Results

All are live headless runs. Scores are the displayed per-run score, not cumulative across restarts. Server population is the dominant uncontrolled variable.

| State | Meaning |
| --- | --- |
| `NO-DEATH` | The run reached its time limit without a real death. |
| `DIED` | A body/head collision caused a real death. Auto-restart may have continued the session. |
| `CANCELLED` | The process was ended by the host environment, not by the game. Not a death. |
| `FILTERED` | A crowded spawn was rejected by the start filter. Not a death. |

| Run | Duration | State | Deaths | Best len | Best score | Kills |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| test 29, pre-hunt baseline | 15m00s | `NO-DEATH` | **0** | 108 | **2,244** | 4 |
| test 56, hunt on | 11m08s | `DIED` | 1 | 102 | 2,053 | 2 |
| test 32, pre-hunt baseline | 20m00s | `DIED` | 2 | 78 | 1,449 | 5 |
| test 53, hunt on | 15m00s | `DIED` | 3 | 67 | 1,202 | 1 |
| test 63, new build | 7m22s | `DIED` | 1 | 62 | 1,093 | 3 |
| test 64, new build | 17m00s, 3 starts | `DIED` | 2 | 59 | 1,038 | 2 |
| final embedded validation | 15m00s | `DIED` | 2 | 53 | 907 | 2 |
| test 58, smoke test | 4m00s | `NO-DEATH` | 0 | 39 | 647 | 1 |
| test 65 | 9m00s, 4 starts | `DIED` | 3 | 36 | 589 | 0 |
| test 57, hunt off | 3m46s | `DIED` | 1 | 28 | 441 | 1 |
| test 66 | 2m48s | `CANCELLED` | 0 | 28 | 433 | 1 |

The full log, with servers and death contexts, is in [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### What the results show

- The hunt-enabled run reached length 102 in 11 minutes, against length 28 in under 4 minutes with all hunt flags off, so those systems do produce growth.
- The pre-hunt build still holds the longest zero-death run (test 29).
- Growth is not the limit. Survival is: the observed growth rate is about 150 to 185 score per minute while alive, but runs end in boosted-snake attacks and multi-snake box-ins long before they get far.
- The production self-grid gate (length 140) has not been reached in a live run. It was validated with a lowered threshold and with path-geometry tests.

---

## Project layout

```text
slither_bot.py          Python driver: Playwright lifecycle, death detection, CLI
bot_v2.js               Injected JS planner (editable source)
run_v2.py               Dev runner: loads bot_v2.js from disk
probe_tops.py           Server sampler (nearby-snake density)
tools/sync_embedded.py  Syncs bot_v2.js into the embedded BOT_JS
recon/                  Read-only live-state, food and physics probes
panel/trainer/          Browser-injectable panel for taking over a live tab
panel/trainer/tests/    Offline Playwright regression and FPS tests
docs/
  ARCHITECTURE.md       Planner internals and game-state surface
  PERFORMANCE.md        Measured runs, death profile, open problems
  TRAINER_TESTING.md    Trainer body fix, Playwright tests and live checklist
assets/                 Reference screenshots
```

The Python driver only manages browser lifecycle, logging, restarts and the crowded-spawn filter. The injected planner owns steering.

---

## Contributing

The biggest open problem is **survival**. Useful contributions, in rough order of value:

1. **Survival and escape planning:** early crowd-box detection, better multi-threat escape routes, safe wall handling.
2. **Boosted-snake prediction:** tiny (length 2 to 20) and large (length 60 to 330) boosters attacking from the side or rear.
3. **Server selection:** choose arenas by measured nearby-snake count instead of `ac`.
4. **Log tooling:** a portable parser for run logs and result states, with fixtures.
5. **Tests and docs:** replay geometry tests and reproduction commands.

Read [CONTRIBUTING.md](CONTRIBUTING.md) first, since it covers the test protocol and the invariants that keep the embedded planner in sync. This project follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE).
