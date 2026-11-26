# Changelog

All notable changes to the planner, driver and test documentation are recorded here. The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Results are per-run displayed scores, not cumulative across restarts. See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for the full table and result-state definitions.

---

## [Unreleased]

### Added

- **Browser trainer panel (`panel/trainer/`):** inject a control panel into an existing slither.io tab and take over the snake that is already on screen. It never launches a browser, navigates, clicks Play, reconnects, or creates a new run. Includes a Tampermonkey loader, a bookmarklet, hotkeys, a local radar, and a self-contained live-state planner.
- **Self-body collision modeling:** above `SELF_COLLISION_MIN_LEN = 140`, the visible own-body trail is inserted into the planner grid with neck skipping, cumulative trail arc, tail-death expiry and a 120-segment cap.
- **Future-path self check:** candidates whose own rollout loops back within two body radii of an older self point are rejected. Active at length 140+.
- **Per-target reaction lag:** predicted enemy headings are held for roughly 0.05 s for fast tiny boosters and 0.09 to 0.11 s for ordinary and long snakes.
- **Open-sector escape bias:** eight surrounding sectors are scored every 400 ms from enemy and wall clearance and smoothed. Low-clearance sectors bias ordinary farming without diluting escape behaviour.
- **Proactive boosted-snake evasion:** the tiny-booster geometry is now applied to non-tiny boosters within about 1.1k units: run from a trail-side approach, cut perpendicular to a head-on approach.
- **Kill re-engage:** a confirmed kill or target disappearance opens a 10 s local window before returning to ordinary farming.
- **Result states:** `NO-DEATH`, `DIED`, `CANCELLED` and `FILTERED` are recorded explicitly in the README and performance log.
- **Contributor workflow:** `tools/sync_embedded.py`, CI syntax and sync checks, issue and PR templates, and an expanded contributor guide.
- `recon/recon_food.py` now accepts `--out`.

### Changed

- Recon scripts write to the current directory by default instead of a fixed temporary path.

### Fixed

- Reset `reengage`, `openBias`, `openSectorScores` and `lastOpenScan` on death, stall recovery and new-run paths.
- Target acquisition is gated off while a corpse lock is active.
- Body-collision kills use the previous head position as the corpse drop-search centre instead of losing the mass claim.

### Validated

- Lowered-threshold self-grid test: `[SELFGRID] len=8 segs=5 stride=1 body=235 skip=95`. Grid insertion and tail expiry were exercised.
- Path-self geometry tests: straight, 90°, 180° and 270° candidate turns kept positive self-clearance.
- Test 58: 4 min, 0 deaths, length 39, score 647, 1 kill.
- Test 63: length 62, score 1,093, 3 kills. Died in a 9 to 12 snake box-in.
- Test 64: 17 min across 3 starts, best length 59 / score 1,038, 2 kills.
- Test 65: 4 starts, best length 36 / score 589.
- Test 66: cancelled by the host at length 28 / score 433, no death.

### Known limitations

- Survival is the main limit. Best hunting-enabled run: length 102 / score 2,053. Latest planner best: length 62 / score 1,093. Longest zero-death run: 15 min, length 108 / score 2,244.
- Production self-grid behaviour at length 140+ has not been exercised in a live run.
- Multi-snake box-ins, boosted side and rear attacks, and boosted tiny snakes remain the dominant failures.
- Two long attempts were cancelled by the host environment, not by the game.

---

## [v2.1] — hunting planner

### Added

- **Offensive coil** (`window.__slitherHuntCoil`, default on): acquire smaller, slower targets at `me.sct >= 26`, lead-intercept approach, then spiral inward. Locks last up to 9 s and drop on crowd, big, fast or flee conditions.
- **Boost intercept** (`window.__slitherHuntBoost`, default on): two-phase cut-off gated on target ratio, range, rollout value and clearance. It stays dormant in most runs.
- **Corpse sweep** (`window.__slitherCorpseSweep`, default on): detect a rival kill from a burst of large pellets, lock the position for 9.5 s and weight corpse pellets 12x in path evaluation.
- **BIGRUN is opt-in** (`window.__slitherBigRun`, default off). The pre-BIGRUN baseline survived 15 min with zero deaths (length 108, score 2,244), while the BIGRUN era never passed length 60.
- Crowded-spawn filtering (`--start-max-threats`, `--abort-attempts`) and forced server selection (`--server ip:port`).
- Server sampler `probe_tops.py`.

### Changed

- 2.2 s rollout, 48 coarse + 64 fine candidates, 240 ms control lag.
- Threat capsules use birth-stamped moving head trails and velocity-dependent safety halos.
- Food is a soft attraction only when the neighbourhood is calm. Pellets inside a 220 to 420 unit enemy-head/body bubble are rejected.
- Crowd escape commits to one heading for about 1.1 s, and big-snake escape takes priority over crowd escape.

---

## [v2.0] — bot_v2.js

Full rewrite of the steering engine from the embedded v1 planner.

### Added

- 48 candidate headings with a 1.8 s rollout and 20 path steps.
- Spatial grid for static body capsules and moving head trails.
- Kill counter and stats fields in `window.__slitherBotStats`.
- Preferred-server hint and stall detection.
- Crowded-spawn reconnect filter.
- Nearby threat directions veto headings that steer into a body.
- Escape candidates ranked by first predicted overlap time, not exit clearance.
- Wall evasion cuts inward rather than hugging the rim.

### Results

- test 29 (pre-BIGRUN): 15 min, 0 deaths, length 108, score 2,244, 4 kills.
- test 32 (pre-BIGRUN): 20 min, length 78, score 1,449, 5 kills.

---

## [v1] — embedded BOT_JS (tests 1 to 28)

The original planner, embedded as a string in `slither_bot.py`.

### Behaviour

- Arena orbit at 0.64x radius with inward and outward corrections.
- Fixed flee radius when the nearest threat is inside alert range.
- Boost used only as an escape, never held.
- Food attraction disabled near threat bodies.
- Crowd term pushes away from the local centre of mass of nearby snakes.

### Best results

- Best score: 1,393 (test 28, length 75, 1 death).
- Median death length: 27.
