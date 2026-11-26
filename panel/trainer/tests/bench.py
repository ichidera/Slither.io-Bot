"""Measure trainer planning FPS with a synthetic crowd.

    python panel/trainer/tests/bench.py
    python panel/trainer/tests/bench.py --enemies 24 --segments 140 --min-fps 45
"""

from __future__ import annotations

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright

from playwright_browser import add_browser_args, launch_browser

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
TRAINER = ROOT / "panel" / "trainer" / "trainer.js"
MOCK = HERE / "mock.html"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enemies", type=int, default=5)
    parser.add_argument("--segments", type=int, default=120)
    parser.add_argument("--min-fps", type=float, default=45.0)
    add_browser_args(parser)
    args = parser.parse_args()

    with sync_playwright() as playwright:
        browser = launch_browser(playwright, headless=not args.headed)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        try:
            page.goto(MOCK.as_uri())
            page.evaluate(
                """({count, segments}) => {
                  const enemies = [];
                  for (let e = 0; e < count; e++) {
                    const ang = e * Math.PI * 2 / count;
                    const hx = 16384 + Math.cos(ang) * (500 + (e % 4) * 450);
                    const hy = 16384 + Math.sin(ang) * (500 + (e % 4) * 450);
                    const pts = [];
                    for (let i = 0; i < segments; i++) {
                      pts.push({
                        xx: hx + Math.cos(ang + Math.PI) * i * 8,
                        yy: hy + Math.sin(ang + Math.PI) * i * 8,
                        dying: false
                      });
                    }
                    enemies.push({
                      id: 10 + e, xx: hx, yy: hy, ang: ang + Math.PI,
                      sp: 5.5, sc: 2.2, scang: 0.4, sct: segments,
                      wmd: false, pts: pts
                    });
                  }
                  window.slithers = [window.slither].concat(enemies);
                }""",
                {"count": args.enemies, "segments": args.segments},
            )
            page.add_script_tag(path=str(TRAINER))
            page.wait_for_timeout(400)
            page.evaluate(
                "() => document.getElementById('slither-trainer-host')"
                ".shadowRoot.getElementById('takeBtn').click()"
            )
            page.wait_for_timeout(3500)
            info = page.evaluate(
                """() => ({
                  fps: window.__slitherTrainer.state.fps,
                  mode: window.__slitherTrainer.state.mode,
                  threats: window.__slitherTrainer.state.threats,
                  clearance: window.__slitherTrainer.state.clearance,
                  takeover: window.__slitherTrainer.state.takeover,
                  xm: window.xm, ym: window.ym
                })"""
            )
            print(info)
            print("errors:", errors)
            ok = (
                not errors
                and info["takeover"]
                and info["fps"] >= args.min_fps
            )
            return 0 if ok else 1
        finally:
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
