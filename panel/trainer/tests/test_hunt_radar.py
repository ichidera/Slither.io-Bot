"""Hunt, corpse-feast, radar and UI regression checks.

    python panel/trainer/tests/test_hunt_radar.py
    python panel/trainer/tests/test_hunt_radar.py --headed
"""

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

from playwright_browser import add_browser_args, launch_browser

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
TRAINER = str(ROOT / "panel" / "trainer" / "trainer.js")
SIM = HERE / "sim_modes.html"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS" if ok else "FAIL"), name, detail)


def open_mode(browser, mode):
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(SIM.as_uri() + "?mode=" + mode)
    page.add_script_tag(path=TRAINER)
    page.wait_for_timeout(350)
    page.evaluate(
        "() => document.getElementById('slither-trainer-host').shadowRoot.getElementById('takeBtn').click()"
    )
    return page, errors


def sample(page):
    return page.evaluate(
        """() => {
          const t = window.__slitherTrainer.state;
          const s = window.slither;
          const e = window.slithers && window.slithers[1];
          return {
            takeover: t.takeover,
            mode: t.mode,
            target: t.huntTarget ? t.huntTarget.id : null,
            targetMan: t.huntTarget ? t.huntTarget.maneuver : null,
            targetD: t.huntTarget ? t.huntTarget.d : null,
            kills: t.kills,
            corpse: !!t.corpse,
            threats: t.threats,
            clearance: t.clearance,
            danger: t.danger,
            range: t.settings.radarRange,
            hunt: t.settings.hunt,
            aggression: t.settings.aggression,
            safety: t.settings.safety,
            boostEscape: t.settings.boostEscape,
            snapshot: !!t.snapshot,
            snapRange: t.snapshot ? t.snapshot.range : null,
            snapHeads: t.snapshot ? t.snapshot.heads.length : 0,
            snapCorpse: !!(t.snapshot && t.snapshot.corpse),
            snapPath: t.snapshot ? t.snapshot.path.length : 0,
            self: s ? {x: s.xx, y: s.yy, ang: s.ang} : null,
            enemy: e ? {x: e.xx, y: e.yy, dead: !!e.dead} : null,
            sim: window.__sim,
            playing: window.playing
          };
        }"""
    )


def collect(page, seconds, interval=0.1):
    samples = []
    steps = max(1, int(round(seconds / interval)))
    for _ in range(steps):
        page.wait_for_timeout(int(interval * 1000))
        samples.append(sample(page))
        if not samples[-1]["playing"]:
            break
    return samples


def safe(samples):
    return samples and samples[-1]["playing"] and samples[-1]["sim"]["collisions"] == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    add_browser_args(parser)
    args = parser.parse_args()

    with sync_playwright() as p:
        browser = launch_browser(p, headless=not args.headed)

        # A slower snake running away is a real hunt, not a reason to stop.
        page, errors = open_mode(browser, "hunt_flee")
        samples = collect(page, 12)
        modes = {s["mode"] for s in samples}
        check("hunt_flee survives", safe(samples), json.dumps(samples[-1]["sim"]))
        check("hunt_flee kills", samples[-1]["kills"] >= 1, str(samples[-1]["kills"]))
        check("hunt_flee chases", "chase" in modes, str(sorted(modes)))
        check("hunt_flee closes", any(s["targetD"] is not None and s["targetD"] < 220 for s in samples),
              str(min([s["targetD"] for s in samples if s["targetD"] is not None] or [None])))
        check("hunt_flee no errors", not errors, str(errors))
        page.close()

        # A close target moving at us should produce a cut and a kill.
        page, errors = open_mode(browser, "hunt_cut")
        samples = collect(page, 6)
        modes = {s["mode"] for s in samples}
        check("hunt_cut survives", safe(samples), json.dumps(samples[-1]["sim"]))
        check("hunt_cut kills", samples[-1]["kills"] >= 1, str(samples[-1]["kills"]))
        check("hunt_cut mode", "cut" in modes, str(sorted(modes)))
        check("hunt_cut corpse", any(s["corpse"] for s in samples), str([s["corpse"] for s in samples[-3:]]))
        check("hunt_cut no errors", not errors, str(errors))
        page.close()

        # A prey that crosses our path should be trapped by the trailing body.
        page, errors = open_mode(browser, "hunt_kill")
        samples = collect(page, 6)
        check("hunt_kill survives", safe(samples), json.dumps(samples[-1]["sim"]))
        check("hunt_kill kills", samples[-1]["kills"] >= 1, str(samples[-1]["kills"]))
        check("hunt_kill corpse snapshot", any(s["snapCorpse"] for s in samples), "")
        check("hunt_kill no errors", not errors, str(errors))
        page.close()

        # A larger snake must never become a hunt target.
        page, errors = open_mode(browser, "hunt_bigger")
        samples = collect(page, 5)
        check("hunt_bigger survives", safe(samples), json.dumps(samples[-1]["sim"]))
        check("hunt_bigger not targeted", all(s["target"] is None for s in samples), str([s["target"] for s in samples]))
        check("hunt_bigger no errors", not errors, str(errors))
        page.close()

        # A crowd around the prey makes it a bad target.
        page, errors = open_mode(browser, "hunt_crowd")
        samples = collect(page, 1.2)
        check("hunt_crowd survives", safe(samples), json.dumps(samples[-1]["sim"]))
        check("hunt_crowd not targeted", all(s["target"] is None for s in samples), str([s["target"] for s in samples]))
        check("hunt_crowd no errors", not errors, str(errors))
        page.close()

        # A food cluster creates a feast site.
        page, errors = open_mode(browser, "feast")
        samples = collect(page, 2)
        check("feast survives", safe(samples), json.dumps(samples[-1]["sim"]))
        check("feast mode", any(s["mode"] == "feast" for s in samples), str([s["mode"] for s in samples]))
        check("feast corpse", any(s["corpse"] and s["snapCorpse"] for s in samples), "")
        check("feast no errors", not errors, str(errors))
        page.close()

        # Radar must detect a snake beyond the default 2,000 unit view and
        # the slider must resize the rendered range.
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(SIM.as_uri() + "?mode=radar")
        page.add_script_tag(path=TRAINER)
        page.wait_for_timeout(500)
        s = sample(page)
        check("radar detects far snake", s["threats"] >= 1 and s["snapHeads"] >= 1,
              f'threats={s["threats"]} heads={s["snapHeads"]}')
        check("radar default range", s["range"] == 2000 and s["snapRange"] == 2000,
              f'range={s["range"]} snap={s["snapRange"]}')
        page.evaluate(
            """() => {
              const root = document.getElementById('slither-trainer-host').shadowRoot;
              const el = root.getElementById('radarRange');
              el.value = '2400';
              el.dispatchEvent(new Event('input', {bubbles: true}));
              el.dispatchEvent(new Event('change', {bubbles: true}));
            }"""
        )
        page.wait_for_timeout(250)
        s = sample(page)
        label = page.evaluate(
            "() => document.getElementById('slither-trainer-host').shadowRoot.getElementById('radarlabel').textContent"
        )
        check("radar slider max", s["range"] == 2400 and s["snapRange"] == 2400,
              f'range={s["range"]} snap={s["snapRange"]}')
        check("radar label updates", "2,400" in label, label)
        canvas_ok = page.evaluate(
            """() => {
              const c = document.getElementById('slither-trainer-host').shadowRoot.getElementById('radar');
              const g = c.getContext('2d');
              const d = g.getImageData(0, 0, c.width, c.height).data;
              let nonBg = 0;
              for (let i = 0; i < d.length; i += 4) {
                if (d[i] > 20 || d[i + 1] > 20 || d[i + 2] > 20) nonBg++;
              }
              return nonBg;
            }"""
        )
        check("radar draws", canvas_ok > 500, str(canvas_ok))
        check("radar no errors", not errors, str(errors))
        page.close()

        # UI controls: hunt toggle, aggression, safety, boost, minimize/hide.
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(SIM.as_uri() + "?mode=radar")
        page.add_script_tag(path=TRAINER)
        page.wait_for_timeout(350)
        page.evaluate(
            """() => {
              const root = document.getElementById('slither-trainer-host').shadowRoot;
              const hunt = root.getElementById('hunt');
              hunt.checked = false;
              hunt.dispatchEvent(new Event('change', {bubbles: true}));
              const ag = root.getElementById('aggression');
              ag.value = '2';
              ag.dispatchEvent(new Event('input', {bubbles: true}));
              ag.dispatchEvent(new Event('change', {bubbles: true}));
              const sf = root.getElementById('safety');
              sf.value = '30';
              sf.dispatchEvent(new Event('input', {bubbles: true}));
              sf.dispatchEvent(new Event('change', {bubbles: true}));
              const be = root.getElementById('boostEscape');
              be.checked = false;
              be.dispatchEvent(new Event('change', {bubbles: true}));
            }"""
        )
        page.wait_for_timeout(300)
        s = sample(page)
        outs = page.evaluate(
            """() => {
              const root = document.getElementById('slither-trainer-host').shadowRoot;
              return {
                ag: root.getElementById('aggressionOut').textContent,
                sf: root.getElementById('safetyOut').textContent,
                hunt: root.getElementById('hunt').checked,
                boost: root.getElementById('boostEscape').checked
              };
            }"""
        )
        check("ui hunt off", s["hunt"] is False and outs["hunt"] is False, json.dumps(s))
        check("ui aggression", s["aggression"] == 2 and outs["ag"] == "2.0", json.dumps(outs))
        check("ui safety", s["safety"] == 30 and outs["sf"] == "30", json.dumps(outs))
        check("ui boost off", s["boostEscape"] is False and outs["boost"] is False, json.dumps(outs))

        page.evaluate(
            "() => document.getElementById('slither-trainer-host').shadowRoot.getElementById('minBtn').click()"
        )
        page.wait_for_timeout(100)
        hidden_body = page.evaluate(
            "() => document.getElementById('slither-trainer-host').shadowRoot.getElementById('body').hidden"
        )
        page.evaluate(
            "() => document.getElementById('slither-trainer-host').shadowRoot.getElementById('minBtn').click()"
        )
        page.wait_for_timeout(100)
        shown_body = page.evaluate(
            "() => !document.getElementById('slither-trainer-host').shadowRoot.getElementById('body').hidden"
        )
        check("ui minimize", hidden_body and shown_body, f"{hidden_body} {shown_body}")

        page.evaluate(
            "() => document.getElementById('slither-trainer-host').shadowRoot.getElementById('hideBtn').click()"
        )
        page.wait_for_timeout(100)
        tab_visible = page.evaluate(
            "() => !document.getElementById('slither-trainer-host').shadowRoot.getElementById('tab').hidden"
        )
        page.evaluate(
            "() => document.getElementById('slither-trainer-host').shadowRoot.getElementById('tab').click()"
        )
        page.wait_for_timeout(100)
        panel_visible = page.evaluate(
            "() => !document.getElementById('slither-trainer-host').shadowRoot.getElementById('panel').hidden"
        )
        check("ui hide/show", tab_visible and panel_visible, f"{tab_visible} {panel_visible}")
        check("ui no errors", not errors, str(errors))
        page.close()

        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"{len(results) - len(failed)}/{len(results)} checks passed")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
