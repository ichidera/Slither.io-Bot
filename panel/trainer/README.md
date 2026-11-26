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
| **Safety** | Extra clearance in world units added to every obstacle. Higher is more cautious. |
| **Food pull** | How strongly the planner is attracted to pellets. `0` disables farming; `2` is aggressive. |
| **Boost only to escape** | Allows a short boost burst only when a threat is very close and the chosen escape heading points away from it. |
| **Radar** | Local view: red = enemy heads, orange = enemy body points, green = food, cyan line = planned heading. Range is 1,200 world units. |
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
   gated escape boost is wanted.
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

## Planner

The trainer uses a compact live-state planner, not the full 2.2 s / 112-candidate
rollout described in the main project docs. It reads the game's own state
(`window.slither`, `window.slithers`, `window.foods`, `window.flux_grd`,
`window.grd`) and scores candidate headings:

- 24 coarse headings over the full circle plus 12 fine headings around the
  previous choice.
- A 1.4 s rollout with the client's turn-rate scaling (`scang`) and a 240 ms
  control lag.
- Clearance to enemy heads, predicted head ghosts, local enemy body points and
  the local part of the player's own body.
- Arena-wall clearance.
- Soft food attraction, weighted by pellet size.
- A small continuity bonus to avoid oscillating between two equally safe paths.
- A short boost burst only when clearance is already low, a threat is within
  340 units, and the chosen heading points away from it.

The planner is deliberately conservative. It is intended for experimenting with
a live session, not for leaderboard play or unattended farming.

---

## Files

| File | Purpose |
| --- | --- |
| `trainer.js` | Self-contained panel, takeover and planner. Paste this into the DevTools console or serve it as a script. |
| `trainer.user.js` | Tampermonkey/Greasemonkey loader. Loads `trainer.js` with `@require`. |
| `bookmarklet.txt` | One-line bookmarklet for a published copy of `trainer.js`. |
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
