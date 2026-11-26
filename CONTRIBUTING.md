# Contributing to Slither.io Bot

Thanks for taking a look. This project welcomes contributors, and the most valuable help is not only code: reproducible session logs, death recordings, server surveys and focused geometry tests all move the bot forward.

**Maintainer:** ichidera

By participating you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---

## Where help is most useful

The current focus is **survival**. The longest zero-death run is 15 minutes (length 108, score 2,244), and most runs end in boosted-snake attacks or multi-snake box-ins.

### Good first issues

1. **Result-state log parser:** parse `[DEATH]`, `[START]`, `[KILL]` and end-of-run summaries into a portable table. Use the logs in `docs/PERFORMANCE.md` as fixtures.
2. **Server picker:** use `probe_tops.py` measurements (`near1k`, `near2k`, `near4k`) instead of `ac` to rank candidate arenas.
3. **Self-grid replay test:** construct straight, 90°, 180°, 270° and tight coil paths and assert the candidate self-clearance rule.
4. **Crowded-spawn statistics:** correlate `--start-max-threats` with early deaths and recommend a default.
5. **Docs reproduction:** run a 10-minute session on a forced server and add the result-state row to `docs/PERFORMANCE.md`.

### Larger features

- **Crowd escape:** model multiple closing heads as a moving cage and pick an escape lane before the planner reaches `safe=0/112`.
- **Boosted-snake prediction:** improve responses to side and rear attacks from length 60 to 330 boosters and tiny length 2 to 20 boosters.
- **Safe wall handling:** avoid being pinned against the arena boundary.

Open an issue before a large change so the approach can be discussed. Small, well-tested fixes can go straight to a PR.

---

## Scope

This is a research project about planning and collision avoidance. Please don't contribute changes meant to:

- disrupt other players or the game's servers (e.g. running many instances, flooding connections),
- abuse accounts, or bypass the game's protections,
- gain leaderboard placement.

Pull requests like that won't be merged. Using bots may break the game's terms of service, so run the bot sparingly and at your own risk.

---

## Setup

```bash
git clone https://github.com/ichidera/Slither.io-Bot.git
cd Slither.io-Bot
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium
```

No build step is required. The JS planner runs inside Playwright's browser. Node.js is only used for `node --check bot_v2.js` and the optional CI job.

If Chromium is already installed, pass `--browser /path/to/chrome` or set `PLAYWRIGHT_BROWSERS_PATH`.

---

## Project layout

| File / dir | What it is |
| --- | --- |
| `slither_bot.py` | Production driver. Public names: `BOT_JS`, `chromium_path`, `main`. |
| `bot_v2.js` | Editable planner. The main target for tuning. |
| `run_v2.py` | Dev runner. Loads `bot_v2.js` from disk after every death. |
| `probe_tops.py` | Samples servers and reports nearby-snake density. |
| `tools/sync_embedded.py` | Syncs (or checks) `bot_v2.js` to the embedded `BOT_JS`. |
| `recon/` | Standalone read-only probes. Do not write game state from them. |
| `panel/trainer/` | Browser-injectable panel that takes over a live slither.io tab. Threat-aware radar, smaller-snake hunting and corpse feasts; it never starts a run. |
| `panel/trainer/tests/` | Offline Playwright collision, takeover, UI and FPS tests. The harness may launch a browser; the production trainer does not. |
| `docs/` | Architecture, measured results, trainer testing and open problems. |
| `.github/` | Issue and PR templates and the syntax/sync CI workflow. |

---

## Workflow

### Planner changes (`bot_v2.js`)

Use the dev runner so edits take effect without restarting Python:

```bash
python run_v2.py --headless --seconds 600 --verbose
```

After a death, the runner reloads `bot_v2.js` from disk. If the change is meant for the production driver, synchronize the embedded copy:

```bash
python tools/sync_embedded.py
python tools/sync_embedded.py --check
```

The sync check must pass before a PR is merged. `BOT_JS` in `slither_bot.py` must be byte-identical to `bot_v2.js`.

### Driver changes (`slither_bot.py`)

Keep `BOT_JS`, `chromium_path()` and `main()` stable. `run_v2.py` and the recon probes import those names.

### Feature flags for A/B tests

Each can be set from the browser devtools or a small Playwright probe:

| Flag | Default | Effect |
| --- | --- | --- |
| `window.__slitherHuntCoil` | `true` | Offensive coil acquisition |
| `window.__slitherHuntBoost` | `true` | Gated boost cut-off |
| `window.__slitherCorpseSweep` | `true` | Detect and claim rival corpses |
| `window.__slitherBigRun` | `false` | Historical BIGRUN mode, opt-in only |

Do not enable BIGRUN by default without new A/B evidence. It is associated with more boosted deaths and no reliable growth benefit.

---

## Test protocol

A minimal PR needs one comparable run plus the checks below.

```bash
# 1. Syntax and embedded-planner sync
python -m py_compile slither_bot.py run_v2.py probe_tops.py recon/*.py tools/*.py
node --check bot_v2.js
python tools/sync_embedded.py --check

# 2. Ten-minute live run on a forced server
python run_v2.py --headless --seconds 600 --verbose \
  --server 213.159.5.171:444 --start-max-threats 6 --abort-attempts 5
```

For survival changes, use a longer run when possible. For behaviour changes, run the same server, duration and flags with the feature on and off, otherwise the result isn't a useful comparison.

Trainer-only changes use the offline Playwright suite instead of the Python
driver. It runs against local mock pages and the installed default Chrome/Edge:

```bash
python -m pip install -r panel/trainer/tests/requirements.txt
node --check panel/trainer/trainer.js
python panel/trainer/tests/run_all.py
```

Add a focused scenario to `panel/trainer/tests/sim_modes.html` for new movement
or collision behaviour, and update
[`docs/TRAINER_TESTING.md`](docs/TRAINER_TESTING.md) when the threat/body model
changes. The trainer test harness may launch a browser; the production trainer
must never do so.

Record at least:

- result state (`NO-DEATH`, `DIED`, `CANCELLED`, `FILTERED`)
- server `ip:port`
- duration and number of starts and deaths
- best length and displayed score
- kill count
- death context (`[THREATS]`: nearby count, clearance, `safe` headings)

Add the row to [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Log tags

| Tag | Meaning |
| --- | --- |
| `[PLAN]` | Normal tick: heading, speed, clearance, nearby count |
| `[RANK]` | Periodic status sample |
| `[HUNT]` | Target acquired or dropped, with reason |
| `[KILL]` | Confirmed kill counter |
| `[CORPSE]` | Corpse detected or claimed |
| `[REENGAGE]` | Post-kill local target re-engagement |
| `[FAST]` | Proactive boosted-snake evasion |
| `[SELFGRID]` | Own body trail entered the collision grid at length 140+ |
| `[THREATS]` | Death context dump |
| `[DEATH]` | Real death, score, length |

---

## Code style

- Match the surrounding style. Don't introduce a build system.
- Keep planner constants in the `// ---- tunables` blocks at the top of `bot_v2.js`.
- Prefer small pure helpers for geometry so they can be replay-tested.
- Never remove a survival check to make another behaviour easier to trigger.
- Keep comments factual, and don't describe something as achieved unless a run proves it.
- Update `docs/PERFORMANCE.md` and `CHANGELOG.md` with behaviour changes and new measurements.

---

## Pull requests

Start from `main`, keep the diff scoped, and fill in the PR template. A good PR has:

- [ ] one behaviour change (or one clearly related set of changes)
- [ ] syntax and embedded-sync checks passing
- [ ] a 10-minute (or longer) forced-server run
- [ ] the result state and stats recorded in `docs/PERFORMANCE.md`
- [ ] a short explanation of the death type being fixed and how it was verified
- [ ] no leftover debug logs, local paths or generated JSON

Large features should be behind a flag until they have an A/B result.

---

## Questions

Open a discussion or issue, or tag **ichidera** in a PR. If you find a repeatable death, attach the command, server, result state and the `[THREATS]` line. That is more useful than a screenshot alone.
