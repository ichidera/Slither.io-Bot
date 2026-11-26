"""Takeover, release and game-input shielding checks on the offline mock page.

    python panel/trainer/tests/test_takeover.py
    python panel/trainer/tests/test_takeover.py --headed
"""

import argparse
import json
import math
from pathlib import Path

from playwright.sync_api import sync_playwright

from playwright_browser import add_browser_args, launch_browser

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
TRAINER = str(ROOT / "panel" / "trainer" / "trainer.js")
MOCK = HERE / "mock.html"


def shadow(page, expr):
    return page.evaluate(
        "(expr) => { const root = document.getElementById('slither-trainer-host').shadowRoot; return eval(expr); }",
        expr,
    )


def state(page):
    return page.evaluate(
        """() => {
          const t = window.__slitherTrainer;
          return {
            takeover: t.state.takeover,
            armed: t.state.armed,
            hidden: t.state.hidden,
            sessionId: t.state.sessionId,
            mode: t.state.mode,
            heading: t.state.heading,
            clearance: t.state.clearance,
            threats: t.state.threats,
            xm: window.xm,
            ym: window.ym,
            mag: Math.hypot(window.xm || 0, window.ym || 0),
            wmd: !!(window.slither && window.slither.wmd),
            origHandler: window.onmousemove === window.__origMouseMove,
            gameMoves: window.__gameMouseMoves || 0,
            gameDowns: window.__gameMouseDowns || 0,
            gameUps: window.__gameMouseUps || 0,
            playClicks: window.__playClicks || 0
          };
        }"""
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    add_browser_args(parser)
    args = parser.parse_args()

    console = []
    errors = []
    results = []

    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail))
        print(("PASS" if ok else "FAIL"), name, detail)

    with sync_playwright() as p:
        browser = launch_browser(p, headless=not args.headed)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: console.append((m.type, m.text)))
        page.goto(MOCK.as_uri())
        page.add_script_tag(path=TRAINER)
        page.wait_for_timeout(500)

        check("api installed", page.evaluate("() => !!window.__slitherTrainer"))
        check("panel present", page.evaluate("() => !!document.getElementById('slither-trainer-host')"))
        check(
            "status live idle",
            "Run live" in shadow(page, "root.getElementById('status').textContent"),
            shadow(page, "root.getElementById('status').textContent"),
        )
        score_text = shadow(page, "root.getElementById('score').textContent")
        check("score rendered", score_text not in ("", "\u2013"), score_text)

        # Take over the current run.
        shadow(page, "root.getElementById('takeBtn').click()")
        page.wait_for_timeout(500)
        s = state(page)
        check("takeover active", s["takeover"], json.dumps(s))
        check("steering magnitude", 550 <= s["mag"] <= 650, str(s["mag"]))
        check("session id", s["sessionId"] == 1, str(s["sessionId"]))
        check("game mousemove replaced", not s["origHandler"])
        check("no boost without threat", not s["wmd"])

        # Synthetic input must not reach the game while controlling.
        before = s["gameMoves"]
        page.mouse.move(120, 120)
        page.wait_for_timeout(120)
        s = state(page)
        check("mousemove shielded", s["gameMoves"] == before, f'{before} -> {s["gameMoves"]}')
        page.mouse.down()
        page.wait_for_timeout(60)
        page.mouse.up()
        page.wait_for_timeout(60)
        s = state(page)
        check("mousedown shielded", s["gameDowns"] == 0, str(s["gameDowns"]))
        check("mouseup shielded", s["gameUps"] == 0, str(s["gameUps"]))

        # Release restores control.
        shadow(page, "root.getElementById('releaseBtn').click()")
        page.wait_for_timeout(250)
        s = state(page)
        check("released", not s["takeover"])
        check("handlers restored", s["origHandler"])
        before = s["gameMoves"]
        page.mouse.move(300, 300)
        page.wait_for_timeout(120)
        s = state(page)
        check("game receives mouse after release", s["gameMoves"] > before, f'{before} -> {s["gameMoves"]}')

        # Moving over or clicking the panel while idle must not steer or boost.
        before = s["gameDowns"]
        before_moves = s["gameMoves"]
        box = shadow(page, "(() => { const r = root.getElementById('panel').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()")
        page.mouse.move(box["x"] + box["w"] / 2, box["y"] + 80)
        page.wait_for_timeout(120)
        s = state(page)
        check(
            "panel mousemove shielded while idle",
            s["gameMoves"] == before_moves,
            f'{before_moves} -> {s["gameMoves"]}',
        )
        page.mouse.click(box["x"] + box["w"] / 2, box["y"] + 80)
        page.wait_for_timeout(120)
        s = state(page)
        check("panel click shielded", s["gameDowns"] == before, f'{before} -> {s["gameDowns"]}')

        # Emergency release while idle must not touch the player's steering.
        page.mouse.move(300, 300)
        page.wait_for_timeout(100)
        idle = state(page)
        page.keyboard.press("Alt+Shift+x")
        page.wait_for_timeout(120)
        s = state(page)
        check(
            "idle emergency release leaves steering alone",
            s["xm"] == idle["xm"] and s["ym"] == idle["ym"] and not s["takeover"],
            f'{idle["xm"]},{idle["ym"]} -> {s["xm"]},{s["ym"]}',
        )

        # Threat present: takeover should still be safe and count the threat.
        page.evaluate(
            """() => {
              window.__enemy.xx = 16684;
              window.__enemy.yy = 16384;
              window.__enemy.pts = [];
              for (let i = 0; i < 16; i++) {
                window.__enemy.pts.push({xx: 16884 - i * 12.5, yy: 16384, dying: false});
              }
              window.slithers = [window.slither, window.__enemy];
            }"""
        )
        page.wait_for_timeout(200)
        shadow(page, "root.getElementById('takeBtn').click()")
        page.wait_for_timeout(600)
        s = state(page)
        check("takeover with threat", s["takeover"], json.dumps(s))
        check("threat counted", s["threats"] >= 1, str(s["threats"]))
        check("mode set", s["mode"] in ("avoid", "danger", "escape", "farm", "cruise", "hunt", "coil", "cut", "feast"), s["mode"])

        # Death: stop, arm, never click Play.
        page.evaluate("() => { window.slither.id = -1234; }")
        page.wait_for_timeout(350)
        s = state(page)
        check("death stops takeover", not s["takeover"])
        check("death leaves armed", s["armed"])
        check("death never clicks play", s["playClicks"] == 0, str(s["playClicks"]))
        check(
            "armed status",
            "Armed" in shadow(page, "root.getElementById('status').textContent"),
            shadow(page, "root.getElementById('status').textContent"),
        )

        # User starts the next run manually: auto-takeover re-arms.
        page.evaluate(
            """() => {
              const old = window.slither;
              const next = {
                id: 2, xx: 16384, yy: 16384, ang: 0, eang: 0, wang: 0,
                sp: 5.5, sc: 1.2, scang: 1, sct: 22, rsc: 0, fam: 0, wmd: false,
                pts: old.pts.slice()
              };
              window.slither = next;
              window.slithers = [next];
            }"""
        )
        page.wait_for_timeout(500)
        s = state(page)
        check("new run auto-takeover", s["takeover"] and s["sessionId"] == 2, json.dumps(s))

        # Hotkeys.
        page.keyboard.press("Alt+b")
        page.wait_for_timeout(120)
        check("alt+b hides", page.evaluate("() => window.__slitherTrainer.state.hidden"))
        page.keyboard.press("Alt+b")
        page.wait_for_timeout(120)
        check("alt+b shows", not page.evaluate("() => window.__slitherTrainer.state.hidden"))
        page.keyboard.press("Alt+Shift+x")
        page.wait_for_timeout(250)
        s = state(page)
        check("alt+shift+x releases", not s["takeover"] and not s["armed"], json.dumps(s))

        browser.close()

    print("\nERRORS:", errors)
    console_errors = [c for c in console if c[0] == "error"]
    print("CONSOLE ERRORS:", console_errors)
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    if failed or errors or console_errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
