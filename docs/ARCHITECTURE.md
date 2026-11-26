# Architecture

## Runtime model

The bot has two layers that communicate through the browser:

```text
Python (slither_bot.py / run_v2.py)
  |  Playwright: launch, navigate, inject, poll
  |  Reads:  window.__botLogs[], window.__slitherBotStats
  |  Writes: window.__slitherVerbose, window.__slitherNick,
  |          window.__slitherPreferredServer, hunt flags
  v
Browser (Chromium, headless)
  |  slither.io client running normally
  v
Injected JS (bot_v2.js / embedded BOT_JS)
  |  requestAnimationFrame loop at ~30 Hz
  |  Reads:  window.slither, window.slithers, window.foods,
  |          window.grd, window.flux_grd, window.real_flux_grd
  |  Writes: window.xm, window.ym  (steering vector)
  |          window.wmd            (boost flag)
```

The game derives the snake's target angle as:

```js
eang = Math.atan2(ym - screenCenterY, xm - screenCenterX)
```

and sends angle packets at ~30 Hz. The bot writes an absolute vector; it does
not simulate mouse events.

The Python driver only manages browser lifecycle, auto-restart, crowded-start
filtering, and log/stat polling. Steering lives entirely in the injected planner.

---

## Planner tick

Each `requestAnimationFrame` callback:

1. **Sample state** — read `window.slither` (self), `window.slithers` (all
   snakes in view), and `window.foods` (pellets).
2. **Build the threat grid** — every other snake becomes a polyline of body
   capsules; the predicted head is a birth-stamped moving trail. Each body point
   gets a local tangent velocity toward the head instead of translating the whole
   snake as a rigid slab. A spatial grid keeps the rollout cheap.
3. **Add the self trail** — above length 140, the visible own-body trail enters
   the same grid with `me.r + 2` capsules. The neck is skipped using a 95-unit
   cumulative arc, tail capsules expire when the receding tail passes them, and
   chords are strided/capped at 120 segments.
4. **Generate candidates** — 48 coarse headings over the full circle plus 64
   fine headings over a 0.55 rad span around the current choice.
5. **Roll out** — simulate each candidate for 2.2 s (40 steps), accounting for:
   - turn-rate limits (`TURN_BASE`, modified by `scang` / `spang`);
   - a 240 ms control/server delay (`LAG`);
   - boosted speed before the server acknowledges boost;
   - per-target reaction lag: hold the current heading through the lag, then
     ease toward the requested heading for the remainder.
6. **Reject self-coil paths** — at length 140+, reject a candidate whose future
   path loops back within two body radii of an older point on the same path.
7. **Score** — minimum clearance to all capsules, weighted by food proximity,
   wall distance, crowd pressure, and mode-specific terms. Headings that steer
   directly into a body are vetoed.
8. **Maintain open-space bias** — every 400 ms, score eight surrounding sectors
   from enemy body/head and wall clearance. Smoothed scores nudge ordinary
   farming toward the best sector. Combat, flee, crowd escape, and corpse claims
   are never diluted by this bias.
9. **Select mode** — normal farming, flee, crowd escape, hunt/coil, corpse
   claim, or re-engage.
10. **Write steering** — set `window.xm = cos(heading) * XMAG`,
    `window.ym = sin(heading) * XMAG`.

The loop is self-contained and remains active across the client's own restart
button. The driver reinjects it after a death/restart.

---

## Key constants

Defined in the `// ---- tunables` block at the top of `bot_v2.js`.

| Constant | Default | Description |
|---|---:|---|
| `HORIZON` | 2.2 | Rollout lookahead (seconds) |
| `PATH_N` | 40 | Steps per rollout |
| `LAG` | 0.24 | Control/server steering delay (s) |
| `COARSE_N` | 48 | Coarse heading candidates |
| `FINE_N` | 64 | Fine heading candidates |
| `FINE_SPAN` | 0.55 | Fine-search span (rad) |
| `BODY_HALF` | 14.5 | Rendered body half-width at `sc=1` |
| `BODY_MARGIN` | 13 | Planner-only body clearance |
| `HEAD_MARGIN` | 30 | Extra margin for a moving head |
| `SAFE_MIN` | 10 | Minimum clearance for a "safe" path |
| `BOUND_MARG` | 520 | Stay this far inside the circular wall |
| `ORBIT_FRAC` | 0.66 | Preferred patrol radius (fraction of arena) |
| `OUTER_FRAC` | 0.80 | Hard inward bias above this fraction |
| `INNER_FRAC` | 0.28 | Gentle outward bias below this fraction |
| `THREAT_RNG` | 2400 | Ignore snakes farther than this |
| `GRID_R` | 2300 | Spatial grid radius |
| `GRID_CELL` | 140 | Spatial grid cell size |
| `SPEED_MULT` | 31.25 | World units/s per `sp` unit |
| `TURN_BASE` | 4.125 | Base turn rate (rad/s) |
| `XMAG` | 600 | Steering-vector magnitude |
| `BOOST_SPEED` | 430 | Planner boost speed assumption |
| `SELF_COLLISION_MIN_LEN` | 140 | Self trail enters the grid at this length |
| `SELF_SKIP_ARC` | 95 | Neck arc excluded from self collision |
| `OPEN_SCAN_MS` | 400 | Open-sector scan cadence |

Hunt constants live in the next block and are documented below.

---

## Game-state surface

Confirmed by recon probes. All fields are on `window` in the slither.io client.

### `window.slither` — self

| Field | Type | Description |
|---|---|---|
| `id` | int | Snake ID; `-1234` when dead |
| `xx`, `yy` | float | Head position (world coords) |
| `ang` | float | Current heading (radians) |
| `eang` | float | Target heading |
| `sp` | float | Speed |
| `sc` | float | Scale factor |
| `sct` | float | Score counter |
| `pts` | array | Body point list |

### `window.slithers` — all snakes in view

Same fields as `window.slither`, plus other snakes. Includes self.

### `window.foods`

| Field | Type | Description |
|---|---|---|
| `xx`, `yy` | float | Pellet position |
| `sz` | float | Size; large drops indicate a dead snake |

### Arena

| Global | Description |
|---|---|
| `window.grd` | Arena centre; centre is at `(grd, grd)` |
| `window.flux_grd` | Current arena radius |
| `window.real_flux_grd` | Alternate radius; planner takes the smaller valid value |

### Leaderboard fields

`window.lbs` and `window.rank` are read only to include context in the log output. The planner does not use them for decisions.

---

## Steering and boost

The bot writes an absolute vector through `window.xm` / `window.ym`. It does not
emit mouse events.

Boost is sent through the same acceleration packet (`window.wmd`). Ordinary
farming does not hold boost. Boost is reserved for:

- a gated escape burst;
- the deliberately narrow two-phase kill cut-off.

The kill cut-off is dormant in most runs because the rollout must predict a
real head/body hit with adequate clearance.

---

## Hunting systems

Three optional systems are enabled by default. Each can be disabled from the page
for A/B tests without editing the planner.

### Offensive coil — `window.__slitherHuntCoil`

- Starts when `me.sct >= 26`, target `<= 0.80 * me.sct`, distance 170–620, and
  fewer than two other threats within 480 units.
- Directly fleeing equal-speed targets are skipped.
- Lead-intercept approach, then spiral inward.
- Standoff is `max(70 + 2.4*target.sct, self-length radius above len 140, 130)`.
- Locks last up to 9 s and drop on crowd, big, fast, or flee conditions.
- The self-length term and self-body grid activate together at length 140.

### Boost intercept — `window.__slitherHuntBoost`

- Starts when `me.sct >= 30`, non-coil target `<= 0.72 * me.sct`, distance
  170–560, rollout `kill >= 1200`, and clearance at least `SAFE_MIN + 6`.
- Boosts for 480 ms, then turns across the target's nose for 650 ms.
- Cooldown 3.6 s.
- Any unrelated urgent threat, crowd, big snake, or nearby booster aborts it.
- It is intentionally dormant rather than a general boost mode.

### Corpse sweep — `window.__slitherCorpseSweep`

- Tracks new large-food IDs.
- A rival kill is recognized as at least 6 pellets of `sz >= 7` within 240 units
  in a 1 s window, total weight at least 72.
- A confirmed kill locks the victim's last head position for 9.5 s.
- Corpse pellets receive a 12x path-evaluation weight.
- Only created at `me.sct >= 24`, outside crowds, and with no big/fast threat
  nearby.
- A matador/orbit kill stamps the victim position so the mass claim starts
  immediately.

### Kill re-engage

A confirmed kill, or a hunt target that disappears mid-lock, opens a 10 s local
re-engagement window. The bot sweeps the corpse first, then gives nearby targets
a 1.3x acquisition bonus before returning to ordinary farming. A target that
simply moves out of view does not create a false kill; only an ID disappearance
does.

### BIGRUN (opt-in, off by default)

`window.__slitherBigRun = true` re-enables the historical acquisition mode. It
is off because the pre-BIGRUN baseline survived 41 boosted-big encounters in a
15-minute zero-death run, while the BIGRUN era never passed length 60. Do not
enable it by default without new A/B evidence.

---

## Self-body collision model

The planner does not trust a coil to be safe just because the bot is short.

- Activation: `me.sct >= SELF_COLLISION_MIN_LEN` (140).
- The visible own trail is converted to capsules with radius `me.r + 2`.
- The neck behind the head is skipped through `SELF_SKIP_ARC` (95 units of
  cumulative arc).
- Tail capsules expire using the time until the receding tail passes them.
- The trail is strided/capped at 120 segments to keep the grid bounded.
- At length 140+, candidate future paths are rejected if they loop back within
  two body radii of an older point on the same path.

The production threshold has not been reached in a live run yet. A validation
run lowered `SELF_COLLISION_MIN_LEN` to 8 and logged
`[SELFGRID] len=8 segs=5 stride=1 body=235 skip=95`. Unit geometry tests covered
straight, 90°, 180°, and 270° candidate turns.

---

## Death detection

The slither.io client sets `window.slither.id = -1234` on death but leaves the
object alive briefly. The driver tracks positive run IDs, records each real
death exactly once, then calls `window.play_btn.elem.onclick()` to restart.

The `.nsi.click()` path is unreliable and is not used.

`[DEATH]` includes score, best score, length and kills.
`[THREATS]` follows with the local threat list and clearance/safe-heading
context.

---

## Crowded-spawn filter

On spawn, if more than `START_MAX` nearby threats are visible within the first
few seconds, the driver closes the socket and lets the Play button reconnect.
This is not counted as a death. Controlled by `--start-max-threats` and
`--abort-attempts`, disabled by `--no-start-filter`.

The filter is useful but imperfect: `ac` and even initial nearby counts do not
capture how quickly a server will crowd the spawn. Improving this measurement is
an open contributor task.

---

## Embedded planner sync

The production driver ships `BOT_JS` as a raw string inside `slither_bot.py`.
When `bot_v2.js` changes, run:

```bash
python tools/sync_embedded.py
python tools/sync_embedded.py --check
```

`--check` exits non-zero if the embedded planner differs from `bot_v2.js`; CI
runs this check. `run_v2.py` intentionally loads `bot_v2.js` directly so
development iterations do not need a sync.

---

## Browser trainer panel

`panel/trainer/trainer.js` is a separate, self-contained planner for a run the
user already started. It does not use the Python driver or `bot_v2.js`. It reads
`window.slither`, `window.slithers`, `window.foods` and the game's mouse/boost
globals, then writes `window.xm`, `window.ym` and the boost flag while takeover
is active.

The trainer's threat collector keeps separate data for:

- live heads and static head points for collision/hunting;
- per-snake nearest body points collected independently of the head's distance;
- the prioritized body obstacle list used by the planner and radar.

Each body is reduced to its nearest points even when the head is outside the
2,400-unit threat range. `buildBodyPoints` puts the current hunt target's body
first, then orders other bodies by nearest sampled distance, before applying the
shared point cap. This prevents a crowded scene from silently dropping the body
the trainer is about to cross. See
[`docs/TRAINER_TESTING.md`](TRAINER_TESTING.md) for the v0.2.1 regression and the
Playwright test harness.

The panel saves and replaces the game's mouse/touch handlers during takeover,
shields panel clicks from the game, and restores the handlers on release or
death. It never calls the Play button, reconnect or socket APIs.

---

## Known design constraints

- The planner is reactive at roughly 30 Hz; it does not have a global map of
  unseen snakes.
- Food is a soft attraction only when the neighbourhood is calm.
- Open-sector bias is deliberately weak and cannot override survival modes.
- The boost economy is conservative; mass is lost while boosting.
- Long-run reliability is unproven. The best zero-death run is 15 minutes.
