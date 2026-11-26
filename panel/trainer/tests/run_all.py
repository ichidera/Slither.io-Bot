"""Run the complete offline trainer regression suite.

    python panel/trainer/tests/run_all.py
    python panel/trainer/tests/run_all.py --headed
    python panel/trainer/tests/run_all.py --quick

This is a test-only runner. The trainer itself never launches a browser.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument(
        "--quick",
        action="store_true",
        help="shorten the closed-loop scenarios to 4 seconds",
    )
    args = parser.parse_args()

    browser_args = ["--headed"] if args.headed else []
    commands = [
        [sys.executable, str(HERE / "test_modes.py"), *browser_args]
        + (["--seconds", "4"] if args.quick else []),
        [sys.executable, str(HERE / "test_takeover.py"), *browser_args],
        [sys.executable, str(HERE / "test_hunt_radar.py"), *browser_args],
        [sys.executable, str(HERE / "bench.py"), *browser_args],
    ]

    for command in commands:
        print("\n$", " ".join(command))
        completed = subprocess.run(command, cwd=HERE)
        if completed.returncode:
            return completed.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
