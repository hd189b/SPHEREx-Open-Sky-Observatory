"""SPHEREx Time Machine — on-demand builder for any sky position.

The static site (GitHub Pages) calls this small server when someone asks for a place that is not in the
prepared list. The server runs the same pipeline (pipeline/build.py) as the prepared targets: it fetches
SPHEREx QR2/QR3 cutouts (+ 2MASS 2000 and WISE 2010) from NASA/IPAC IRSA, aligns and stacks them, and
serves the frames + manifest.json. Results are cached, so each place is built only once.

Endpoints
  GET  /api/health                         → {"ok": true}
  GET  /api/resolve?name=…                 → name → coordinates + motion (CDS Sesame / SIMBAD)
  POST /api/fields?ra=&dec=&fov=&name=     → {"status": "done"|"queued"|"running", "id", "manifest"?}
  GET  /api/fields/{id}                    → status, progress lines, queue position, error
  GET  /data/{id}/…                        → built manifest.json and frames

Run locally:  pipeline/.venv/bin/uvicorn server.app:app --port 7860
"""
from __future__ import annotations

import json
import os
import queue
import re
import shutil
import sys
import threading
import time
import traceback
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote

import yaml
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
sys.path.insert(0, str(REPO / "pipeline"))
import build  # noqa: E402  (pipeline/build.py)

DATA = Path(os.environ.get("TM_DATA_DIR", ROOT / "data"))
CACHE = Path(os.environ.get("TM_CACHE_DIR", ROOT / "cache"))
MAX_QUEUE = int(os.environ.get("TM_MAX_QUEUE", "8"))
KEEP_CUTOUTS = os.environ.get("TM_KEEP_CUTOUTS", "0") == "1"
DATA.mkdir(parents=True, exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)
build.OUT, build.CACHE = DATA, CACHE
DEFAULTS = yaml.safe_load((REPO / "pipeline" / "targets.yaml").read_text())["defaults"]
SESAME = ["https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/S?",
          "https://vizier.idia.ac.za/viz-bin/nph-sesame/-oxp/S?",
          "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/S?"]

app = FastAPI(title="SPHEREx Time Machine builder", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])
app.mount("/data", StaticFiles(directory=DATA), name="data")

jobs: dict[str, dict] = {}
work: "queue.Queue[str]" = queue.Queue()
lock = threading.Lock()


def field_id(ra: float, dec: float, fov: float) -> str:
    """Stable id; positions are rounded to 0.001° (3.6″) so nearby requests share one build."""
    return f"f{ra:08.3f}{dec:+07.3f}w{fov:.2f}".replace(".", "p").replace("+", "n").replace("-", "s")


def resolve(name: str) -> dict | None:
    for base in SESAME:
        try:
            root = ET.fromstring(build.get(base + quote(name), timeout=20, tries=2))
        except Exception:  # noqa: BLE001 — try the next mirror
            continue
        res = root.find(".//Resolver")
        if res is None or res.find("jradeg") is None:
            return None
        num = lambda p: float(res.findtext(p)) if res.findtext(p) else 0.0  # noqa: E731
        return {"name": name, "main_id": res.findtext("oname"), "ra": num("jradeg"), "dec": num("jdedeg"),
                "pmra": num("pm/pmRA"), "pmdec": num("pm/pmDE"), "plx": num("plx/v")}
    return None


def manifest_state(jid: str) -> str | None:
    """None (nothing yet), "partial" (build still adding dates) or "complete"."""
    p = DATA / jid / "manifest.json"
    if not p.exists():
        return None
    try:
        return "complete" if json.loads(p.read_text()).get("complete", True) else "partial"
    except Exception:  # noqa: BLE001 — being rewritten right now
        return "partial"


def summary(plan: list | None) -> dict:
    plan = plan or []
    return {"items_total": len(plan), "items_done": sum(p["status"] in ("done", "skipped") for p in plan),
            "files_total": sum(p.get("files") or 0 for p in plan), "files_done": sum(p.get("files_done") or 0 for p in plan)}


def planet_note(label: str, star: dict) -> str:
    """Exoplanets resolve to their host star; say so plainly."""
    planet = re.search(r"[\d\s][b-h]$", label.strip()) or re.search(r"[\d\s][b-h]$", star.get("main_id") or "")
    return ("The planet itself is far too faint and too close to its star to be seen separately — the circle "
            "marks its host star. ") if planet else ""


def run_job(jid: str):
    job = jobs[jid]
    job.update(status="running", started=time.time())

    def hook(msg: str):
        with lock:
            job["log"] = (job["log"] + [msg])[-30:]

    def plan_hook(plan: list):
        with lock:
            job["plan"] = plan
    build.LOG_HOOK, build.PLAN_HOOK = hook, plan_hook
    try:
        t = job["target"]
        m = build.build_target(t, DEFAULTS, refresh=False, workers=8)
        if not m["frames"]:
            raise RuntimeError("SPHEREx has not observed this position yet (no usable images).")
        job.update(status="done", manifest=f"/data/{jid}/manifest.json", frames=len(m["frames"]))
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        job.update(status="error", error=str(e) or e.__class__.__name__)
    finally:
        build.LOG_HOOK = build.PLAN_HOOK = None
        job["finished"] = time.time()
        if not KEEP_CUTOUTS:
            shutil.rmtree(CACHE / jid / "cutouts", ignore_errors=True)


def worker():
    while True:
        jid = work.get()
        try:
            run_job(jid)
        finally:
            work.task_done()


threading.Thread(target=worker, daemon=True).start()


@app.get("/api/health")
def health():
    return {"ok": True, "queue": work.qsize(), "version": app.version}


@app.get("/api/resolve")
def api_resolve(name: str = Query(..., min_length=1, max_length=80)):
    r = resolve(name.strip())
    if not r:
        raise HTTPException(404, f"No object called {name!r} was found.")
    return r


@app.post("/api/fields")
def api_fields(ra: float = Query(..., ge=0, lt=360), dec: float = Query(..., ge=-90, le=90),
               fov: float = Query(0.15, ge=0.05, le=0.3), name: str | None = Query(None, max_length=80)):
    ra, dec, fov = round(ra, 3), round(dec, 3), round(fov, 2)
    jid = field_id(ra, dec, fov)
    if manifest_state(jid) == "complete" and jobs.get(jid, {}).get("status") != "running":
        return {"status": "done", "id": jid, "manifest": f"/data/{jid}/manifest.json"}
    with lock:
        if jid in jobs and jobs[jid]["status"] in ("queued", "running"):
            return {"status": jobs[jid]["status"], "id": jid,
                    "manifest": f"/data/{jid}/manifest.json" if manifest_state(jid) else None}
        if work.qsize() >= MAX_QUEUE:
            raise HTTPException(503, "The builder is busy. Please try again in a few minutes.")
        label = (name or "").strip()
        star = resolve(label) if label else None
        moving = bool(star and abs(star["pmra"]) + abs(star["pmdec"]) > 50)  # > 0.05″/yr: track it
        safe = re.sub(r"[^\w .+\-−'()/]", "", label)[:60]
        target = {
            "id": jid, "name": safe or f"RA {ra:.3f}° Dec {dec:+.3f}°",
            # Named things are always marked; "object" = known star/system that hardly moves.
            "kind": "star" if moving else ("object" if star else "field"), "fov_deg": fov, "deep_time": True,
            # Kept small so a new place downloads ≈10–20 SPHEREx cutouts (≈50–100 MB) instead of ≈200 MB:
            # two detectors (near-IR D2 and mid-IR D5) and one image per observing period.
            "default_detector": 2, "per_group": 1, "detectors": [2, 5],
            "blurb": (planet_note(label, star) + f"SIMBAD: {star['main_id']}. Built on request from SPHEREx QR2 + QR3, 2MASS and WISE." if star else
                      "A sky field built on request from SPHEREx QR2 + QR3, with 2MASS (≈2000) and WISE (2010) "
                      "for comparison. Look for anything that moves or changes brightness."),
        }
        if star:
            target["simbad"] = label
        else:
            target.update(ra=ra, dec=dec)
        jobs[jid] = {"status": "queued", "target": target, "log": ["Waiting in queue…"], "created": time.time()}
        work.put(jid)
    return {"status": "queued", "id": jid}


@app.get("/api/fields/{jid}")
def api_field_status(jid: str):
    job = jobs.get(jid)
    state = manifest_state(jid)
    if state == "complete" and (not job or job["status"] not in ("running", "queued")):
        return {"status": "done", "id": jid, "manifest": f"/data/{jid}/manifest.json"}
    if not job:
        raise HTTPException(404, "Unknown request.")
    ahead = list(work.queue).index(jid) if jid in work.queue else 0
    return {k: job.get(k) for k in ("status", "error", "frames")} | {
        "id": jid, "name": job["target"]["name"], "log": job["log"][-8:], "queue_position": ahead,
        "manifest": f"/data/{jid}/manifest.json" if state else None, "partial": state == "partial",
        "plan": job.get("plan") or [], "progress": summary(job.get("plan")),
        "elapsed_s": round(time.time() - job.get("started", time.time()), 1)}


@app.get("/api/jobs")
def api_jobs():
    """Everything this server is building or has built (newest first) — for the site's Downloads panel."""
    out, seen = [], set()
    with lock:
        items = sorted(jobs.items(), key=lambda kv: kv[1].get("created", 0), reverse=True)
    for jid, job in items:
        seen.add(jid)
        started = job.get("started")
        out.append({"id": jid, "name": job["target"]["name"], "status": job["status"], "error": job.get("error"),
                    "queue_position": list(work.queue).index(jid) if jid in work.queue else 0,
                    "manifest": f"/data/{jid}/manifest.json" if manifest_state(jid) else None,
                    "progress": summary(job.get("plan")), "frames": job.get("frames"),
                    "elapsed_s": round((job.get("finished") or time.time()) - started, 1) if started else 0,
                    "created": job.get("created")})
    for d in sorted(DATA.glob("*/manifest.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:30]:
        jid = d.parent.name
        if jid in seen:
            continue
        try:
            m = json.loads(d.read_text())
        except Exception:  # noqa: BLE001
            continue
        out.append({"id": jid, "name": m.get("name", jid), "status": "done" if m.get("complete", True) else "stopped",
                    "manifest": f"/data/{jid}/manifest.json", "progress": summary(m.get("plan")),
                    "frames": len(m.get("frames", [])), "elapsed_s": None, "created": d.stat().st_mtime})
    return {"jobs": out[:40]}
