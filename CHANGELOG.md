# Changelog

All notable changes to the planner, driver and test documentation are recorded here. The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Results are per-run displayed scores, not cumulative across restarts. See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for the full table and result-state definitions.

---

## [v0.2.1] - 2026-11-26

### Fixed

- **Trainer body ramming:** enemy bodies are collected independently of head
  distance, so a long snake whose head is outside the 2,400-unit threat range
  can no longer hide a body crossing directly in front of the player.
- **Body-point budget:** each snake keeps a bounded heap of its nearest body
  points, and the locked hunt target's body is prioritized before other bodies.
  This prevents a crowded scene or a long tail from dropping the body the
  planner is about to cross.
- **Planner/snapshot/radar consistency:** static head points and prioritized
  body points are separate lists; the planner, snapshots and radar all use the
  same body obstacle set.

### Added

- **Playwright regression suite (`panel/trainer/tests/`):** installed default
  Chrome/Edge detection, 18 closed-loop scenarios, 29 takeover/input-shield
  checks, 37 hunt/radar/UI checks, and a 5/24-snake FPS benchmark.
- **Body regressions:** `body_far_head`, `body_far_moving`,
  `body_target_last` and `body_many` cover static and moving head-far
  crossings, target-body priority under budget pressure, and multiple long
  bodies.
- **[docs/TRAINER_TESTING.md](docs/TRAINER_TESTING.md):** root cause, fix,
  test setup, validation results, live checklist and limitations.

### Validated

- Trainer v0.2.1 closed-loop suite: 18/18 modes passed with zero simulated
  collisions. `body_far_head` measured about 200 units minimum enemy clearance;
  `body_far_moving` about 221; `body_target_last` about 114; `body_many` about
  401.
- Trainer takeover suite: 29/29 checks passed.
- Trainer hunt/radar/UI suite: 37/37 checks passed.
- Trainer benchmark: 60 fps with five enemies x 120 points, and 60 fps with
  24 enemies x 140 points, using Playwright 1.59.0 and installed Chrome 155.
- Short live probe: a one-off Playwright probe started a run, injected the
  v0.2.1 trainer and took over for about 21 seconds. No death; stayed clear of
  nearby bodies; no trainer page errors. The game logged IPv6
  WebSocket fallback errors during server selection. Release returned to idle
  with zero play clicks. The production trainer did not start the run. This was
  not a substitute for a full live run.

### Known limitations

- The offline mock does not reproduce live server collision resolution or
  latency. A short live test is still required before publishing.
- A body with more than 64 sampled points inside the 2,520-unit body range
  keeps only its 64 closest points. Points farther along the same body can be
  omitted; the target body is prioritized and the closest crossing is retained.

---

## [Unreleased]

### Added

- **Browser trainer panel (`panel/trainer/`):** inject a control panel into an existing slither.io tab and take over the snake that is already on screen. It never launches a browser, navigates, clicks Play, reconnects, or creates a new run. Includes a Tampermonkey loader, a bookmarklet, hotkeys, a local radar, and a self-contained live-state planner.
- **Trainer v0.2.0 hunting and radar:** threat range expanded to 2,400 units with time-to-collision, closest-approach, crowd, wall and persistent faster-chaser detection; lead-intercept hunting with chase, coil, cut-across and body-trap maneuvers for smaller isolated snakes; corpse/feast detection from kills or dense big-pellet clusters; target locking, hunt-aware food weighting, and gated cut-off boost.
- **Trainer radar and controls:** 800–2,400 unit radar range slider, hunt toggle, aggression slider, target/feast overlays, and an emergency 40 ms panic turn for urgent head-on threats.
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

- Trainer v0.2.0 closed-loop scenarios: `walls`, `wall`, `headon`, `cross`, `behind`, `hunt`, `hunt_cut`, `hunt_far`, `hunt_kill`, `hunt_flee`, `hunt_bigger`, `hunt_crowd`, `feast` and `radar` all survived 10 s with zero self-collisions; hunting scenarios scored kills.
- Trainer smoke suite: 29/29 checks passed, including takeover/release, handler restoration, input shielding, death handling and auto-rearm.
- Trainer behavior/UI suite: 37/37 checks passed, including chase/cut kills, corpse feasts, larger-snake and crowd rejection, radar range, and panel controls.
- Trainer benchmark: 60 fps with five large enemy snakes and 120 body points each.
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
