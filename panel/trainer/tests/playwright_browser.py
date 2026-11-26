"""Launch the user's installed browser for the trainer test harness.

The trainer itself never launches a browser.  This helper exists only for the
offline Playwright tests in this directory.  On Windows it reads the default
HTTP handler from the registry and prefers the matching Playwright channel
(Chrome or Edge).  If that is unavailable it falls back to any installed
Chrome/Edge channel, then to Playwright's bundled Chromium.

Set ``TRAINER_BROWSER=chrome``, ``msedge``, or ``chromium`` to override the
detection.  The bundled Chromium fallback requires ``playwright install
chromium``; the channel fallbacks do not download anything.
"""

from __future__ import annotations

import argparse
import os
import sys


def default_channel() -> str | None:
    """Return the Playwright channel matching the default browser, if known."""
    override = os.environ.get("TRAINER_BROWSER", "").strip().lower()
    if override:
        return None if override in ("chromium", "bundled") else override

    if sys.platform != "win32":
        return None

    try:
        import winreg

        key_path = (
            r"Software\Microsoft\Windows\Shell\Associations"
            r"\UrlAssociations\http\UserChoice"
        )
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            prog_id = str(winreg.QueryValueEx(key, "ProgId")[0]).lower()
    except (ImportError, OSError):
        return None

    if "chrome" in prog_id:
        return "chrome"
    if "edge" in prog_id:
        return "msedge"
    return None


def add_browser_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--headed",
        action="store_true",
        help="show the browser instead of running headless",
    )


def launch_browser(playwright, headless: bool = True):
    """Launch the default browser, falling back to other installed channels."""
    args = [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--mute-audio",
    ]
    override = os.environ.get("TRAINER_BROWSER", "").strip().lower()
    if override:
        candidates = [None if override in ("chromium", "bundled") else override]
    else:
        preferred = default_channel()
        candidates = ([preferred] if preferred else []) + ["chrome", "msedge", None]

    seen = set()
    failures = []
    for channel in candidates:
        if channel in seen:
            continue
        seen.add(channel)
        label = channel or "bundled chromium"
        try:
            return playwright.chromium.launch(
                channel=channel,
                headless=headless,
                args=args,
            )
        except Exception as exc:  # pragma: no cover - depends on host install
            failures.append(f"{label}: {type(exc).__name__}: {exc}")

    detail = "\n".join(failures)
    raise RuntimeError(
        "Could not launch a browser for the trainer tests.\n"
        "Install Chrome/Edge, set TRAINER_BROWSER=chrome|msedge, or run:\n"
        "  python -m playwright install chromium\n\n"
        f"{detail}"
    )
