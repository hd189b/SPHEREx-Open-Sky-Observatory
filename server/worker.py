"""One build, run in its own process by server/app.py.

A separate process means several builds can run at the same time, and a build that hangs (for example
while NASA's archive does not answer) can be stopped cleanly without affecting the others.
Progress is sent back to the server through a queue: ("log", text), ("plan", [...]), ("done", n) or ("error", text).
"""
from __future__ import annotations

import os
import sys
import threading
import time
import traceback
from pathlib import Path


def _exit_with_parent() -> None:
    """Quit if the server that started this build goes away (no orphaned downloads)."""
    parent = os.getppid()
    def watch():
        while True:
            time.sleep(3)
            if os.getppid() != parent:
                os._exit(1)
    threading.Thread(target=watch, daemon=True).start()


def run(target: dict, defaults: dict, data_dir: str, cache_dir: str, q) -> None:
    _exit_with_parent()
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
    import build  # noqa: E402  (pipeline/build.py)

    build.OUT, build.CACHE = Path(data_dir), Path(cache_dir)
    build.LOG_HOOK = lambda msg: q.put(("log", msg))
    build.PLAN_HOOK = lambda plan: q.put(("plan", plan))
    try:
        m = build.build_target(target, defaults, refresh=False, workers=8)
        if not m["frames"]:
            raise RuntimeError("SPHEREx has not observed this position yet (no usable images).")
        q.put(("done", len(m["frames"])))
    except Exception as e:  # noqa: BLE001 — report every failure to the server
        traceback.print_exc()
        q.put(("error", str(e) or e.__class__.__name__))
