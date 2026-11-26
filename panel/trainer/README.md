# Slither.io Trainer Panel

A browser-injectable control panel for a **live** slither.io run. You start the
game normally in your own browser, spawn your snake, then inject the panel. The
panel attaches to that page and takes over the snake that is already on screen.

It does **not** launch Playwright or Chromium, open a tab, navigate, click
**Play**, reconnect, or start a new snake. If there is no live run, it waits.
If the snake dies, it stops steering and never restarts the game for you.

```text
you open slither.io  ->  you press Play  ->  you inject trainer.js
                                             |
                                             +-> "Take over" drives that snake
                                             +-> "Release" returns control
```

This is separate from the headless `slither_bot.py` / `bot_v2.js` driver. The
trainer is self-contained and does not require Python or a build step.

### What is new in v0.2.1

- Fixed the body-ramming failure: a long snake's body is now collected even
  when its head is outside the `2,400`-unit threat range.
- Body points use a bounded nearest-point heap, and the locked hunt target's
  body is prioritized ahead of a crowded scene's shared body-point budget.
- The planner, snapshots and radar now use the same prioritized body list, so
  the trainer cannot plan against an empty body while the radar shows one.
- Added an offline Playwright regression suite for body crossings, target
  priority, takeover/input shielding, hunting, radar and FPS.

### v0.2.0 features

- Threat range expanded from `1,200` to `2,400` units, with time-to-collision,
  closest-approach, crowd, wall and faster-chaser detection.
- Hunt smaller, isolated snakes with lead-intercept, chase, coil, cut-across and
  body-trap behaviour. It still flees real danger.
- Corpse/feast detection: a kill or a dense big-pellet cluster becomes a
  temporary high-value food site.
- Radar range slider (`800`–`2,400`), hunt toggle, aggression slider and a
  clearer target/feast overlay.
- Panic turns for urgent head-on threats and a gated cut-off boost that is only
  used when the path is already clear.

---

## Quick start (DevTools, works immediately)

1. Open <https://slither.io> in your browser and start a run manually.
2. Press `F12` (or `Ctrl+Shift+I`) to open DevTools, then open the **Console**.
3. Open `panel/trainer/trainer.js`, copy the whole file, paste it into the
   console, and press `Enter`.
4. The **SLITHER TRAINER** panel appears in the top-right corner.
5. Click **Take over**. The bot now drives the snake you already spawned.
6. Click **Release** (or press `Alt+Shift+X`) to give control back instantly.

The panel is injected into the current page only. Reloading the page removes it;
paste it again if needed.

> Chrome may ask you to type `allow pasting` the first time you paste code into
> the DevTools console. That is normal.

---

## Userscript (auto-inject on every visit)

1. Install [Tampermonkey](https://www.tampermonkey.net/) or a compatible
   userscript manager.
2. Create a new userscript and paste the contents of
   [`trainer.user.js`](trainer.user.js).
3. Save it, then reload <https://slither.io>.

`trainer.user.js` loads `trainer.js` through its `@require` URL. If you use a
fork or a different branch, change that URL to your copy. The userscript also
shows a small warning if the `@require` file could not be loaded.

---

## Bookmarklet

[`bookmarklet.txt`](bookmarklet.txt) contains a one-line bookmarklet that loads
`trainer.js` from jsDelivr. Create a bookmark and paste that line as its URL.
It requires the file to be published at the URL in the bookmarklet. If the
site's Content Security Policy blocks external scripts, use the DevTools
method instead.

> **Published URL required.** The userscript and bookmarklet default to the
> `main` branch of `ichidera/Slither.io-Bot`. Those URLs only serve the trainer
> after `panel/trainer/` has been committed and pushed there. Until then, or for
> a fork, point the loader at your own published copy, or use the DevTools
> method above.

---

## Controls

| Control | What it does |
| --- | --- |
| **Take over** | Starts steering the live snake. If no snake is live, it arms and waits for the next run you start. |
| **Release** | Stops steering and restores the game's own mouse/touch handlers. |
| **Re-arm after death** | When checked, a death stops control but leaves the trainer armed. When you start the next run yourself, it takes over automatically. |
| **Hunt smaller snakes** | Enables target selection. The trainer only hunts snakes that are clearly smaller, isolated, and in open space. |
| **Safety** | Extra clearance in world units added to every obstacle. Higher is more cautious. |
| **Food pull** | How strongly the planner is attracted to pellets. `0` disables farming; `2` is aggressive. Food pull is reduced while a hunt target is locked. |
| **Aggro** | `0` disables hunting. Higher values allow larger prey, a longer target range, and a little more crowd tolerance. |
| **Radar range** | Rendered radar radius from `800` to `2,400` world units. The planner itself always watches up to `2,400`. |
| **Allow gated boost** | Allows short boost bursts for a close escape or a gated cut-off on a smaller target. It never boosts just to chase food. |
| **Radar** | Local view: pink = enemy heads, orange = enemy body points, red/pink target = locked prey, green = food, amber = corpse/feast food, teal = your body and planned path. |
| **Header drag** | Move the panel. The position is saved for the next injection. |
| **Minimize / hide** | Collapse the panel to its header, or hide it to the round **T** button (`Alt+B` restores it). |

### Hotkeys

| Keys | Action |
| --- | --- |
| `Alt+B` | Show or hide the panel |
| `Alt+T` | Take over / release |
| `Alt+Shift+X` | Emergency release (always returns control) |

The hotkeys work while the panel is hidden and while the game has focus.

---

## How takeover works

The slither.io client reads steering from two globals:

```js
window.xm, window.ym   // mouse offset from the centre of the viewport
window.slither.wmd     // boost (the current client stores it on the snake)
```

`window.onmousemove` normally writes `xm = clientX - innerWidth / 2` and
`ym = clientY - innerHeight / 2`; the client then uses
`Math.atan2(ym, xm)` as the target angle. While takeover is active the panel:

1. Saves and temporarily replaces the game's `onmousemove`, `onmousedown`,
   `ontouchstart`, `ontouchmove` and `ontouchend` handlers.
2. Adds capture-phase guards for mouse, pointer, touch, click, wheel and the
   boost/steering keys, so the game cannot overwrite the bot's steering.
3. Writes `xm` / `ym` every animation frame and sets
   `window.slither.wmd` (plus `window.wmd` for older builds) only when a
   gated escape or cut-off boost is wanted.
4. Leaves all events that target the panel alone, so the panel stays usable.
5. On release, restores the saved handlers, clears boost, and leaves the snake
   heading in its current direction. The next real mouse move takes over.

The panel never calls `play_btn`, `resetGame`, `connect`, or any socket method.
Death detection only reads `window.playing`, `window.slither.id` and the game
state. A death ends control; it does not click **Play Again**.

### Session behaviour

| Situation | Panel behaviour |
| --- | --- |
| Start screen, no snake | `Waiting for a run — start it yourself` |
| Live snake, trainer idle | Shows stats; radar updates; no steering |
| Take over clicked while live | Control starts immediately |
| Take over clicked while not live | Arms; control starts when a live snake appears |
| Snake dies while controlling | Control stops. With **Re-arm after death** on, it waits armed for the next run you start. It never creates that run. |
| Release clicked / hotkey | Control stops, handlers restore, trainer disarms |

---

## Hunting, feasts and threat model

The trainer does not flee from every snake. It measures each nearby head with a
time-to-collision model: relative velocity, closest approach, crowd pressure,
wall distance, boost state and size. A snake that is moving away or passing wide
is ignored; a faster snake sitting behind you is treated as a persistent chase
threat even before it starts closing.

Body points are collected independently of the head distance. A head 2,600
units away does not hide a body crossing 300 units in front of you. Within the
body budget, the locked target's body is always planned against first; other
bodies follow nearest-first. This matters in a crowd, where a long tail or a
different snake could otherwise consume every available body point.

When hunting is enabled, a target must pass all of these gates:

- It is smaller than you (`85%` of your length by default; **Aggro** raises the
  limit to about `97%`).
- It is isolated: at most one other head within `520` units of the target by
  default.
- It is within the hunt range (about `760` units, scaled by **Aggro**) and not
  sitting against the arena wall.
- It is not a fast booster far away, and it is not a same-speed snake running
  directly away.

A locked target is kept for up to `3.2 s` so the trainer does not flicker
between two candidates. While locked, food attraction is cut to `35%`. The
target is dropped if another snake becomes an urgent threat or if the chosen
path loses safe clearance.

| Maneuver | When it is used | What it does |
| --- | --- | --- |
| **hunt** | Target is far or crossing | Lead-intercept toward its future position. |
| **chase** | Target is running away | Overtakes alongside the target's body instead of rear-ending its tail, then closes the gap. |
| **coil** | Target is close and not fleeing | Spirals at a stand-off distance to make it turn into your body. |
| **cut** | Target is head-on or you are ahead of it | Cuts across its nose; a smaller snake that hits your trailing body dies. |

A target is never worth a collision. If the best rollout has less than `18`
units of clearance, the trainer drops the hunt and treats the situation as a
survival problem. When an urgent head-on threat is inside `340` units, the
rollout uses a short `40 ms` panic reaction instead of the normal `240 ms`
control lag so it can still turn away.

A confirmed kill, or any visible death within `900` units, creates a feast site
for `10 s`. Large pellets around that site are weighted much more heavily than
ordinary food. A dense cluster of big pellets can also be recognised as a
corpse without seeing the kill.

---

## Planner

The trainer uses a compact live-state planner, not the full 2.2 s / 112-candidate
rollout described in the main project docs. It reads the game's own state
(`window.slither`, `window.slithers`, `window.foods`, `window.flux_grd`,
`window.grd`) and scores candidate headings:

- 24 coarse headings over the full circle, 14 fine headings around the previous
  choice, and 8 ultra-fine refinements around the winner.
- A 1.4 s rollout with the client's turn-rate scaling (`scang`), a 240 ms
  control lag, and a 40 ms panic lag for urgent head-on threats.
- Clearance to enemy heads, predicted head ghosts, local enemy body points and
  the local part of the player's own body.
- Time-to-collision, closest-approach and persistent faster-chaser checks for
  every visible head inside `2,400` units.
- Arena-wall clearance, crowd pressure, and a committed escape heading.
- Soft food attraction, weighted by pellet size, with corpse pellets boosted.
- Hunt scoring for lead-intercept, chase, coil, cut-across and body-trap paths.
  Target avoidance is softened above `26` units so a cut can close, but below
  the `18`-unit danger margin it becomes a hard safety penalty again.
- A small continuity bonus to avoid oscillating between two equally safe paths.
- Gated boost bursts only for a close escape or a clear cut-off on a smaller
  target; never for ordinary food.

The planner is deliberately conservative about body clearance. It is intended
for experimenting with a live session, not for leaderboard play or unattended
farming. Raise **Safety** if it feels reckless, lower **Aggro** to reduce
hunting, or turn **Hunt smaller snakes** off entirely.

---

## Tests

The offline Playwright suite is in [`tests/`](tests/README.md). It uses the
installed default browser (Chrome or Edge) and never contacts slither.io. The
trainer itself still never launches a browser; the harness is test-only.

```bash
python -m pip install -r panel/trainer/tests/requirements.txt
python panel/trainer/tests/run_all.py
```

Use `--headed` to watch a run, or run one suite directly:

```bash
python panel/trainer/tests/test_modes.py
python panel/trainer/tests/test_takeover.py
python panel/trainer/tests/test_hunt_radar.py
python panel/trainer/tests/bench.py --enemies 24 --segments 140
```

The closed-loop suite includes `body_far_head`, `body_far_moving`,
`body_target_last` and `body_many` for the v0.2.1 body fix. See
[`docs/TRAINER_TESTING.md`](../../docs/TRAINER_TESTING.md) for the root cause,
test geometry, validation results and live-test checklist.

---

## Files

| File | Purpose |
| --- | --- |
| `trainer.js` | Self-contained panel, takeover and planner. Paste this into the DevTools console or serve it as a script. |
| `trainer.user.js` | Tampermonkey/Greasemonkey loader. Loads `trainer.js` with `@require`. |
| `bookmarklet.txt` | One-line bookmarklet for a published copy of `trainer.js`. |
| `tests/` | Offline Playwright scenarios, takeover/UI checks and the FPS benchmark. |
| `README.md` | This file. |

---

## Troubleshooting

**The panel does not appear.**
Check the DevTools console for errors. Make sure you are on `https://slither.io`
and that the whole `trainer.js` file was pasted, including the final `})();`.
If a userscript manager is installed, its `@require` URL may be wrong.

**The status says "Waiting for a run".**
Start a run manually. The panel requires `window.playing` and a positive
`window.slither.id`. It will not press Play for you.

**The snake does not move after Take over.**
Another planner (for example the headless `bot_v2.js`) may also be writing
`xm`/`ym`. Run only one planner at a time. Reload the page to clear the other
one.

**Clicking the panel boosts the snake.**
That should not happen. Panel events are shielded whether takeover is active
or idle. If it still happens, another injected script is also handling mouse
input; remove it and reload.

**The panel disappeared after a reload.**
Injected scripts do not survive navigation. Use the userscript if you want it
to load automatically, or paste `trainer.js` again.

**Can I use it on a phone or tablet?**
The panel uses touch input shields and should render, but it is designed for a
desktop browser with DevTools. The userscript route is the practical option on
mobile.

---

## Responsible use

This is a research tool for planning and collision avoidance. It is not
affiliated with Slither.io or Lowtech Studios. Using bots may break the game's
terms of service. Run it sparingly, one instance at a time, and do not use it to
disrupt other players or to hammer the game's servers. Use it at your own risk.
