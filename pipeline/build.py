#!/usr/bin/env python3
"""Build SPHEREx time-series frames for the prepared targets.

For each target in targets.yaml this script
  1. gets position + proper motion from SIMBAD (stars) or IRSA's moving-object table (comets),
  2. finds every SPHEREx image covering it (IRSA SIA, collections spherex_qr2 + spherex_qr3),
  3. groups images by observing period × detector and downloads small cutouts,
  4. masks flagged pixels, removes the zodiacal-light model and background,
  5. reprojects onto one fixed north-up grid and stacks each group,
  6. records the wavelength at the target (SPHEREx's filter varies across the detector),
  7. measures the target's position (centroid) and compares it with the prediction,
  8. writes WebP frames, flag overlays and a manifest.json the static site reads.

Output: dist/data/targets.json and dist/data/<target>/{manifest.json,frames/,flags/}
Cache:  pipeline/cache/ (not committed)

Usage:
  pipeline/.venv/bin/python pipeline/build.py                # all targets
  pipeline/.venv/bin/python pipeline/build.py barnard r-dra  # some targets
  ... --refresh  re-query IRSA/SIMBAD instead of using cached search results
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import hashlib
import io
import json
import math
import os
import shutil
import sys
import threading
import time
import warnings
from pathlib import Path

import numpy as np
import requests
import yaml
from astropy.io import fits
from astropy.io.votable import parse
from astropy.stats import sigma_clipped_stats
from astropy.time import Time
from astropy.wcs import WCS
from PIL import Image
from reproject import reproject_interp

sys.path.insert(0, str(Path(__file__).resolve().parent))
import s3cut  # noqa: E402

warnings.simplefilter("ignore")  # astropy WCS/FITS chatter about SIP and header fixes

PIPELINE_VERSION = "1.0"
ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache"
OUT = ROOT.parent / "dist" / "data"
IRSA = "https://irsa.ipac.caltech.edu"
COLLECTIONS = ["spherex_qr2", "spherex_qr3"]
SPHEREX_PIX_ARCSEC = 6.15
# FLAGS bits treated as bad (bit numbers from the FLAGS extension header, MP_* keywords).
BAD_BITS = {
    "TRANSIENT": 0, "OVERFLOW": 1, "SUR_ERROR": 2, "PHANTOM": 4, "NONFUNC": 6,
    "MISSING_DATA": 9, "HOT": 10, "COLD": 11, "NONLINEAR": 15, "PERSIST": 17, "OUTLIER": 19,
}
BAD_MASK = sum(1 << b for b in BAD_BITS.values())
SAT_MASK = (1 << BAD_BITS["OVERFLOW"]) | (1 << BAD_BITS["SUR_ERROR"])
USE_S3 = os.environ.get("TM_USE_S3", "1") == "1"  # read SPHEREx from AWS open data first
SAT_RADIUS = 6  # native SPHEREx pixels around the target where saturated cores are filled
CREDITS = [
    "This publication makes use of data products from the Spectro-Photometer for the History of the "
    "Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet "
    "Propulsion Laboratory and the California Institute of Technology, and is funded by the National "
    "Aeronautics and Space Administration.",
    "This research has made use of the NASA/IPAC Infrared Science Archive, which is funded by the "
    "National Aeronautics and Space Administration and operated by the California Institute of Technology.",
    "This research has made use of the SIMBAD database, operated at CDS, Strasbourg, France.",
]

session = requests.Session()
session.headers["User-Agent"] = "spherex-open-sky-pipeline/1.0"


# ---------------------------------------------------------------- helpers
LOG_HOOK = None  # optional callable(str); the server sets it to report job progress


def log(*a):
    msg = " ".join(str(x) for x in a)
    print(msg, flush=True)
    if LOG_HOOK:
        LOG_HOOK(msg.strip())


def get(url: str, *, params=None, timeout=180, tries=8) -> bytes:
    """GET with retries; rejects responses shorter than Content-Length (IRSA sometimes truncates)."""
    last = None
    for i in range(tries):
        try:
            r = session.get(url, params=params, timeout=timeout)
            r.raise_for_status()
            want = r.headers.get("Content-Length")
            if want and int(want) != len(r.content):
                raise IOError(f"truncated {len(r.content)}/{want}")
            return r.content
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(min(60, 5 * 2 ** i))
    raise RuntimeError(f"GET failed after {tries} tries: {url} ({last})")


def votable_rows(data: bytes) -> list[dict]:
    tables = list(parse(io.BytesIO(data)).iter_tables())
    if not tables:
        raise RuntimeError("VOTable has no tables")
    t = max(tables, key=lambda x: len(x.fields)).to_table(use_names_over_ids=True)  # skip small self-description tables
    rows = []
    for r in t:
        rows.append({k: (v.item() if hasattr(v, "item") else v) for k, v in zip(t.colnames, r)})
    return rows


def cached_json(path: Path, refresh: bool, fn):
    if path.exists() and not refresh:
        return json.loads(path.read_text())
    val = fn()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(val, indent=1, default=str))
    return val


def mjd_to_year(mjd: float) -> float:
    return 2000.0 + (mjd - 51544.5) / 365.25


def iso(mjd: float) -> str:
    return Time(mjd, format="mjd").isot[:19] + "Z"


def position_at(ast: dict, year: float) -> tuple[float, float]:
    """Linear proper motion from the SIMBAD epoch (J2000). Parallax is ignored (< 0.1 SPHEREx pixel)."""
    dy = year - ast["epoch"]
    dec = ast["dec"] + ast["pmdec"] / 3.6e6 * dy
    ra = ast["ra"] + ast["pmra"] / 3.6e6 * dy / math.cos(math.radians(ast["dec"]))
    return ra % 360.0, dec


def grid_wcs(center, fov, n) -> WCS:
    w = WCS(naxis=2)
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.crval = list(center)
    w.wcs.cdelt = [-fov / n, fov / n]  # north up, east left
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    return w


def to_frac(w: WCS, n: int, ra: float, dec: float) -> list[float]:
    """World → fractional image coords (0..1, origin top-left as drawn in the browser)."""
    x, y = w.world_to_pixel_values(ra, dec)
    return [round(float(x + 0.5) / n, 5), round(1 - float(y + 0.5) / n, 5)]


# ---------------------------------------------------------------- astrometry
def simbad_astrometry(name: str, tid: str, refresh: bool) -> dict:
    """SIMBAD values via the CDS Sesame name resolver (lighter and more available than SIMBAD TAP)."""
    def fetch():
        import xml.etree.ElementTree as ET
        from urllib.parse import quote
        root = ET.fromstring(get(f"https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/S?{quote(name)}"))
        res = root.find(".//Resolver")
        if res is None or res.find("jradeg") is None:
            raise RuntimeError(f"SIMBAD/Sesame has no object {name!r}")
        num = lambda path: float(res.findtext(path)) if res.findtext(path) else 0.0  # noqa: E731
        return {
            "source": "SIMBAD (via CDS Sesame)", "main_id": res.findtext("oname"),
            "ra": num("jradeg"), "dec": num("jdedeg"), "epoch": 2000.0,
            "pmra": num("pm/pmRA"), "pmdec": num("pm/pmDE"), "plx": num("plx/v"),
            "plx_ref": res.findtext("plx/r"),
        }
    return cached_json(CACHE / tid / "simbad.json", refresh, fetch)


# ---------------------------------------------------------------- image lists
def sia_images(ra: float, dec: float, tid: str, refresh: bool) -> list[dict]:
    def fetch():
        rows = []
        for c in COLLECTIONS:
            data = get(f"{IRSA}/SIA", params={
                "COLLECTION": c, "POS": f"CIRCLE {ra} {dec} 0.002", "MAXREC": 20000})
            for r in votable_rows(data):
                rows.append({
                    "did": r["obs_publisher_did"], "obs_id": r["obs_id"], "collection": c,
                    "detector": int(str(r["energy_bandpassname"]).split("D")[-1]),
                    "mjd": float(r["t_min"]), "mjd_end": float(r["t_max"]),
                    "em_min": float(r["em_min"]), "em_max": float(r["em_max"]),
                    "url": r["access_url"],
                })
        return rows
    return cached_json(CACHE / tid / "sia.json", refresh, fetch)


def datalink_fits_url(datalink: str) -> str:
    rows = votable_rows(get(datalink))
    for r in rows:
        if r.get("semantics") == "#this" and r.get("access_url"):
            return r["access_url"]
    raise RuntimeError(f"no #this link in {datalink}")


def comet_images(t: dict, refresh: bool) -> list[dict]:
    def fetch():
        rows = votable_rows(get(t["irsa_table"]))
        lo, hi = (Time(x).mjd for x in t["window_utc"])
        keep = [r for r in rows if lo <= float(r["t_min"]) < hi and int(r["spherex_detector"].strip("D")) in t["detectors"]]
        out = []
        with cf.ThreadPoolExecutor(6) as ex:
            urls = list(ex.map(lambda r: datalink_fits_url(r["access_url"]), keep))
        for r, url in zip(keep, urls):
            out.append({
                "did": r["obs_creator_did"], "obs_id": r["obs_id"], "collection": r["obs_collection"],
                "detector": int(r["spherex_detector"].strip("D")),
                "mjd": float(r["t_min"]), "mjd_end": float(r["t_max"]),
                "em_min": float(r["em_min"]), "em_max": float(r["em_max"]),
                "url": url, "comet_ra": float(r["comet_ra"]), "comet_dec": float(r["comet_dec"]),
                "source_page": r["access_url"],
            })
        return out
    return cached_json(CACHE / t["id"] / "comet.json", refresh, fetch)


def dedupe(rows: list[dict]) -> list[dict]:
    """Keep one row per observation+detector, preferring the newest release."""
    best = {}
    for r in rows:
        key = (r["obs_id"], r["detector"])
        if key not in best or r["collection"] > best[key]["collection"]:
            best[key] = r
    return sorted(best.values(), key=lambda r: r["mjd"])


def periods(rows: list[dict], gap: float) -> list[list[dict]]:
    out: list[list[dict]] = []
    for r in sorted(rows, key=lambda r: r["mjd"]):
        if out and r["mjd"] - out[-1][-1]["mjd"] <= gap:
            out[-1].append(r)
        else:
            out.append([r])
    return out


def spread(rows: list[dict], k: int) -> list[dict]:
    if len(rows) <= k:
        return rows
    idx = np.unique(np.round(np.linspace(0, len(rows) - 1, k)).astype(int))
    return [rows[i] for i in idx]


# ---------------------------------------------------------------- cutouts
def cutout(url: str, ra: float, dec: float, size: float, tid: str, extra: dict | None = None,
           timeout: int = 180, tries: int = 8) -> Path:
    key = hashlib.sha1(f"{url}|{ra:.6f}|{dec:.6f}|{size:.4f}".encode()).hexdigest()[:16]
    path = CACHE / tid / "cutouts" / f"{key}.fits"
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    data = None
    if USE_S3 and s3cut.s3_url(url):
        try:  # SPHEREx: NASA's AWS open-data copy, read in parts (usually much faster than IRSA's cutout service)
            data = s3cut.cutout(url, ra, dec, size)
        except Exception as e:  # noqa: BLE001 — fall back to IRSA
            log(f"  AWS read failed, using IRSA ({str(e)[:160]})")
    if data is None:
        data = get(url, params={"center": f"{ra:.6f},{dec:.6f}", "size": f"{size:.4f}", **(extra or {})},
                   timeout=timeout, tries=tries)
    if data[:2] == b"\x1f\x8b":
        import gzip
        data = gzip.decompress(data)
    with fits.open(io.BytesIO(data)) as h:  # validate before caching
        if not any(x.data is not None and getattr(x.data, "ndim", 0) == 2 for x in h):
            raise IOError(f"no image in cutout of {url}")
    tmp = path.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.rename(path)
    return path


def load_image(path: Path, grid: WCS, n: int, target_radec):
    """Return (sky, flagged, wavelength_um, bandwidth_um, saturated_at_target) on the output grid.

    Bright stars (e.g. Barnard's Star) saturate: their core pixels are NaN in the archive image and
    flagged OVERFLOW / SUR_ERROR. Saturated pixels within SAT_RADIUS native pixels of the target are
    filled with the image's brightest valid value so the star shows as a solid bright core instead of
    a hole; the frame is marked "saturated" in the manifest. Elsewhere they stay masked.
    """
    with fits.open(path) as h:
        hdr = h["IMAGE"].header
        img = h["IMAGE"].data.astype(np.float64)
        flags = h["FLAGS"].data.astype(np.int64)
        zodi = h["ZODI"].data.astype(np.float64) if "ZODI" in h else 0.0
        cel = WCS(hdr).celestial
        bad = (flags & BAD_MASK) != 0
        sat = (flags & SAT_MASK) != 0
        sky = img - zodi
        sky[bad | ~np.isfinite(sky)] = np.nan
        _, med, _ = sigma_clipped_stats(sky[np.isfinite(sky)], sigma=3)
        sky -= med
        tx, ty = (float(v) for v in cel.world_to_pixel_values(*target_radec))
        yy, xx = np.mgrid[0:img.shape[0], 0:img.shape[1]]
        near = np.hypot(xx - tx, yy - ty) <= SAT_RADIUS
        # A real saturated core = several OVERFLOW pixels next to the target. The fill follows the
        # archive's own flags (the star's actual footprint), never a shape centred on the prediction,
        # so it cannot pull the measured position toward the predicted one.
        overflow = ((flags & (1 << BAD_BITS["OVERFLOW"])) != 0) & near
        saturated = int(overflow.sum()) >= 2
        if saturated:
            grown = overflow.copy()
            for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                grown |= np.roll(overflow, (dy, dx), axis=(0, 1))
            core = (overflow | (sat & grown)) & near
        else:
            core = np.zeros_like(near)
        if saturated:
            # The wings of a saturated star are flagged TRANSIENT / SUR_ERROR but hold valid values;
            # keep them (otherwise the star gets a dark ring).
            soft = (1 << BAD_BITS["TRANSIENT"]) | (1 << BAD_BITS["SUR_ERROR"])
            relax = near & np.isfinite(img) & ((flags & BAD_MASK & ~soft) == 0)
            raw = img - zodi - med
            sky[relax] = raw[relax]
            bad = bad & ~relax
        core_radec = None
        if saturated:
            # Position of a saturated star = centre of its OVERFLOW footprint (archive flags only).
            core_radec = tuple(float(v) for v in cel.pixel_to_world_values(xx[overflow].mean(), yy[overflow].mean()))
        if saturated and np.isfinite(sky).any():
            sky[core] = np.nanmax(sky)
            bad = bad & ~core
        # Wavelength lookup: alternate WCS "W" (lookup table). Strip SIP so it is not applied to it.
        whdr = hdr.copy()
        for k in list(whdr.keys()):
            if k.split("_")[0] in ("A", "B", "AP", "BP"):
                del whdr[k]
        wave_wcs = WCS(whdr, fobj=h, key="W")
        lam, bw = (float(v) for v in wave_wcs.pixel_to_world_values(tx, ty))
    arr, foot = reproject_interp((sky, cel), grid, shape_out=(n, n))
    arr[foot < 0.9] = np.nan
    flg, _ = reproject_interp((bad.astype(np.float64), cel), grid, shape_out=(n, n))
    return arr, flg, lam, bw, saturated, core_radec


# ---------------------------------------------------------------- measurement
def centroid(arr: np.ndarray, x0: float, y0: float, r_pix: float):
    """Flux-weighted centroid near (x0, y0). Returns (x, y, snr) or None.

    Background and noise come from the whole frame (sigma-clipped), not a local annulus, because
    bright stars' wings would inflate a local noise estimate.
    """
    n = arr.shape[0]
    fin = arr[np.isfinite(arr)]
    if fin.size < 100:
        return None
    _, bg, sd = sigma_clipped_stats(fin, sigma=3, maxiters=10)
    yy, xx = np.mgrid[0:n, 0:n]
    x, y = x0, y0
    for _ in range(4):
        d = np.hypot(xx - x, yy - y)
        ap = (d <= r_pix) & np.isfinite(arr)
        if ap.sum() < 5:
            return None
        w = np.clip(arr[ap] - bg, 0, None)
        if w.sum() <= 0:
            return None
        x, y = float((xx[ap] * w).sum() / w.sum()), float((yy[ap] * w).sum() / w.sum())
    peak = float(np.nanmax(arr[(np.hypot(xx - x, yy - y) <= r_pix)]) - bg)
    snr = peak / sd if sd > 0 else 0.0
    if snr < 5 or math.hypot(x - x0, y - y0) > 1.5 * r_pix:
        return None
    return x, y, snr


# ---------------------------------------------------------------- output
def stretch_limits(arrays):
    vals = np.concatenate([a[np.isfinite(a)].ravel() for a in arrays])
    lo, hi = np.percentile(vals, [10, 99.8])
    return float(lo), float(max(hi, lo + 1e-6))


def fill_holes(arr, passes=8):
    """Display only: fill small NaN holes (masked pixels) with the mean of their finite neighbours.
    Large uncovered areas stay empty. Masked pixels remain visible in the flags overlay."""
    a = arr.copy()
    for _ in range(passes):
        nan = ~np.isfinite(a)
        if not nan.any():
            break
        p = np.pad(a, 1, constant_values=np.nan)
        nb = np.stack([p[1 + dy:p.shape[0] - 1 + dy, 1 + dx:p.shape[1] - 1 + dx]
                       for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx])
        cnt = np.isfinite(nb).sum(0)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            mean = np.nanmean(nb, 0)
        ok = nan & (cnt >= 4)
        a[ok] = mean[ok]
    return a


def save_frame(arr, lo, hi, path: Path):
    arr = fill_holes(arr)
    z = np.clip((arr - lo) / (hi - lo), 0, 1)
    v = np.arcsinh(z * 10) / np.arcsinh(10)
    v = np.nan_to_num(v, nan=0.0)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.uint8(np.flipud(v) * 255), "L").save(path, "WEBP", lossless=True)


def save_flags(flg, path: Path) -> float:
    m = np.nan_to_num(flg, nan=0.0) > 0.5
    rgba = np.zeros(m.shape + (4,), np.uint8)
    rgba[m] = (255, 90, 90, 150)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.flipud(rgba), "RGBA").save(path, "PNG", optimize=True)
    return float(m.mean())


# ---------------------------------------------------------------- deep time (2MASS 2000, WISE 2010)
DEEP_SURVEYS = {
    "2MASS": {"collection": "twomass_allsky", "release": "2MASS All-Sky", "psf_arcsec": 3.0, "year": 2000.0,
              "bands": {"J": 1.235, "H": 1.662, "K": 2.159},
              "credit": "This publication makes use of data products from the Two Micron All Sky Survey, which is a "
                        "joint project of the University of Massachusetts and the Infrared Processing and Analysis "
                        "Center/California Institute of Technology, funded by the National Aeronautics and Space "
                        "Administration and the National Science Foundation."},
    "WISE": {"collection": "wise_allsky", "release": "WISE All-Sky", "psf_arcsec": 6.4, "year": 2010.3,
             "bands": {"W1": 3.368, "W2": 4.618, "W3": 12.08, "W4": 22.19},
             "credit": "This publication makes use of data products from the Wide-field Infrared Survey Explorer, "
                       "which is a joint project of the University of California, Los Angeles, and the Jet Propulsion "
                       "Laboratory/California Institute of Technology, funded by the National Aeronautics and Space "
                       "Administration."},
}


def deep_images(survey: str, band: str, ra: float, dec: float, tid: str, refresh: bool, radius: float = 0.002) -> list[dict]:
    """Science images of one survey band. 2MASS tiles are small (8.5′ × 17′), so it is searched over the
    whole field (radius) to mosaic neighbouring tiles; WISE single exposures are searched at the target."""
    s = DEEP_SURVEYS[survey]
    def fetch():
        rows = votable_rows(get(f"{IRSA}/SIA", params={
            "COLLECTION": s["collection"], "POS": f"CIRCLE {ra} {dec} {radius}", "MAXREC": 3000}))
        return [{"obs_id": str(r["obs_id"]), "did": r["obs_publisher_did"], "band": str(r["energy_bandpassname"]),
                 "mjd": float(r["t_min"]), "mjd_end": float(r["t_max"]), "url": r["access_url"]}
                for r in rows if r.get("dataproduct_subtype") == "science"]
    return [r for r in cached_json(CACHE / tid / f"sia_{survey.lower()}_{radius:.3f}.json", refresh, fetch) if r["band"] == band]


def load_plain(path: Path, grid: WCS, n: int):
    """2MASS / WISE image → background-subtracted array on the output grid (native units, DN)."""
    with fits.open(path) as h:
        hdu = next(x for x in h if x.data is not None and getattr(x.data, "ndim", 0) == 2)
        img = hdu.data.astype(np.float64)
        cel = WCS(hdu.header).celestial
    img[~np.isfinite(img)] = np.nan
    _, med, _ = sigma_clipped_stats(img[np.isfinite(img)], sigma=3)
    img -= med
    arr, foot = reproject_interp((img, cel), grid, shape_out=(n, n))
    arr[foot < 0.9] = np.nan
    return arr


def centroid_halfmax(arr: np.ndarray, x0: float, y0: float, search_r: float):
    """Centre of the region brighter than half the peak, found near (x0, y0).

    Starts from the brightest pixel (not from the prediction), so a flat saturated core gives the
    centre of the plateau rather than the starting guess. Returns (x, y, snr) or None.
    """
    n = arr.shape[0]
    fin = arr[np.isfinite(arr)]
    if fin.size < 100:
        return None
    _, bg, sd = sigma_clipped_stats(fin, sigma=3, maxiters=10)
    yy, xx = np.mgrid[0:n, 0:n]
    win = (np.hypot(xx - x0, yy - y0) <= search_r) & np.isfinite(arr)
    if win.sum() < 5:
        return None
    vals = np.where(win, arr, -np.inf)
    py, px = np.unravel_index(np.argmax(vals), vals.shape)
    peak = float(arr[py, px] - bg)
    if sd <= 0 or peak / sd < 5:
        return None
    reg = win & (arr - bg >= 0.5 * peak) & (np.hypot(xx - px, yy - py) <= search_r)
    w = arr[reg] - bg
    x, y = float((xx[reg] * w).sum() / w.sum()), float((yy[reg] * w).sum() / w.sum())
    return x, y, peak / sd


def _deep_download(t, d, ast, grid, n, center, cut_size, survey, band, refresh, item, lock, workers=6):
    """One older-survey band (2MASS ≈2000 or WISE 2010) on the SPHEREx grid → frame dict or None.
    Updates `item` (a plan entry) with file counts and status as it goes. Gives up quickly on slow tiles."""
    s = DEEP_SURVEYS[survey]
    def note(**kw):
        with lock:
            item.update(kw)
    note(status="searching")
    radius = float(t["fov_deg"]) * 0.75 if survey == "2MASS" else 0.002
    try:
        rows = deep_images(survey, band, *position_at(ast, s["year"]), t["id"], refresh, radius)
    except Exception as e:  # noqa: BLE001
        note(status="skipped", note=f"archive search failed ({str(e)[:40]})")
        return None
    if not rows:
        note(status="skipped", note="no images here")
        return None
    single = [r for r in rows if "_frm/" in r["url"]]  # WISE single exposures (not Atlas coadds)
    rows = single or rows
    if survey == "2MASS":
        g = rows[:12]  # all overlapping tiles (one per scan, ≈1998–2001) → mosaic
    else:
        visit = max(periods(rows, d["period_gap_days"]), key=len)
        g = spread(visit, int(d.get("per_group_deep", 8)))
    note(files=len(g), status="downloading")

    def fetch_tile(r):
        try:
            pth = cutout(r["url"], *center, cut_size, t["id"], {"gzip": "false"}, timeout=60, tries=3)
        except Exception as e:  # noqa: BLE001 — IRSA returns 500 when a tile does not reach the field
            log(f"  {survey} {band}: skipped one image ({str(e)[:60]}…)")
            pth = None
        with lock:
            item["files_done"] += 1
        return pth
    with cf.ThreadPoolExecutor(min(workers, 6)) as ex:
        paths = list(ex.map(fetch_tile, g))
    g, paths = [r for r, p in zip(g, paths) if p], [p for p in paths if p]
    if not g:
        note(status="skipped", note="archive did not respond in time")
        return None
    note(status="processing")
    mjd_mean = float(np.mean([r["mjd"] for r in g]))
    pred = position_at(ast, mjd_to_year(mjd_mean))
    px, py = (float(v) for v in grid.world_to_pixel_values(*pred))
    ix, iy = int(round(px)), int(round(py))
    if not (3 <= ix < n - 3 and 3 <= iy < n - 3):
        note(status="skipped", note="target outside the picture")
        return None
    stack, sources, on_target = [], [], 0
    for r, pth in zip(g, paths):
        arr = load_plain(pth, grid, n)
        if np.isfinite(arr).mean() < 0.05:
            continue  # tile barely overlaps the field
        # Coverage at the target, on a wider box: saturated cores are empty (NaN) in WISE exposures.
        on_target += np.isfinite(arr[max(0, iy - 15):iy + 16, max(0, ix - 15):ix + 16]).mean() >= 0.5
        stack.append(arr)
        sources.append({"obs_id": r["obs_id"], "did": r["did"], "release": s["release"], "utc": iso(r["mjd"]),
                        "mjd": round(r["mjd"], 6), "fits": r["url"], "wavelength_um": s["bands"][band]})
    if not stack or not on_target:
        note(status="skipped", note="target not covered")
        return None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        arr = np.nanmean(np.stack(stack), axis=0)
    lam = s["bands"][band]
    log(f"  {survey} {band}: {len(stack)} images, {iso(mjd_mean)[:10]}")
    return {"_arr": arr, "_pred": pred, "survey": survey, "band": band, "band_label": f"{survey} {band}",
            "detector": None, "period": None, "mjd": round(mjd_mean, 6), "utc": iso(mjd_mean),
            "utc_start": iso(min(r["mjd"] for r in g)), "utc_end": iso(max(r["mjd_end"] for r in g)),
            "releases": [s["release"]], "n_images": len(stack), "saturated": None,
            "wavelength_um": {"mean": lam, "min": lam, "max": lam}, "sources": sources}


# ---------------------------------------------------------------- per target (progressive)
PLAN_HOOK = None  # optional callable(plan list); the server sets it to report per-item progress


def _measure_spherex(f, arr, grid, n, kind, r_pix):
    pred = f["_pred"]
    px, py = grid.world_to_pixel_values(*pred)
    f["predicted"] = {"ra": round(pred[0], 6), "dec": round(pred[1], 6), "xy": to_frac(grid, n, *pred)}
    cores = [c for c in (s.pop("_core", None) for s in f["sources"]) if c]
    if kind == "field":
        mra = None
    elif cores:
        # Saturated: a flat filled plateau has no light-weighted centre, so use the mean centre of
        # the archive's OVERFLOW footprints instead (independent of the prediction).
        mra, mdec = float(np.mean([c[0] for c in cores])), float(np.mean([c[1] for c in cores]))
        method, snr = "saturated-core centre (OVERFLOW footprint)", None
    else:
        m = centroid(arr, float(px), float(py), r_pix)
        mra, mdec = (float(v) for v in grid.pixel_to_world_values(m[0], m[1])) if m else (None, None)
        method, snr = "flux-weighted centroid", (round(m[2], 1) if m else None)
    if mra is not None:
        off = math.hypot((mra - pred[0]) * math.cos(math.radians(pred[1])), mdec - pred[1]) * 3600
        f["measured"] = {"ra": round(mra, 6), "dec": round(mdec, 6), "xy": to_frac(grid, n, mra, mdec),
                         "offset_from_predicted_arcsec": round(off, 2), "snr": snr, "method": method}
    else:
        f["measured"] = None


def _measure_deep(f, arr, grid, n, kind, pix_arcsec):
    pred = f["_pred"]
    px, py = grid.world_to_pixel_values(*pred)
    f["predicted"] = {"ra": round(pred[0], 6), "dec": round(pred[1], 6), "xy": to_frac(grid, n, *pred)}
    psf = DEEP_SURVEYS[f["survey"]]["psf_arcsec"]
    m = None if kind == "field" else centroid_halfmax(arr, float(px), float(py), max(2.5 * psf, 12.0) / pix_arcsec)
    if m:
        mra, mdec = (float(v) for v in grid.pixel_to_world_values(m[0], m[1]))
        off = math.hypot((mra - pred[0]) * math.cos(math.radians(pred[1])), mdec - pred[1]) * 3600
        f["measured"] = {"ra": round(mra, 6), "dec": round(mdec, 6), "xy": to_frac(grid, n, mra, mdec),
                         "offset_from_predicted_arcsec": round(off, 2), "snr": round(m[2], 1),
                         "method": "half-maximum region centre"}
    else:
        f["measured"] = None


def build_target(t: dict, d: dict, refresh: bool, workers: int) -> dict:
    """Build one target. Publishes manifest.json after every finished date (complete=false) so viewers
    can show what is ready; the final write re-stretches every detector over all its dates."""
    tid = t["id"]
    kind = t["kind"]
    fov = float(t["fov_deg"])
    n = int(t.get("size_px", d["size_px"]))
    dets = t.get("detectors", d["detectors"])
    k = int(t.get("per_group", d["per_group"]))
    log(f"\n=== {t['name']} ({tid})")
    if PLAN_HOOK:  # first visible step while the archive search runs
        PLAN_HOOK([{"key": "search", "survey": "SPHEREx", "detector": None, "band": None, "utc": None,
                    "label": "Finding SPHEREx images in NASA's archive", "files": None, "files_done": 0,
                    "status": "searching"}])

    now_year = mjd_to_year(Time.now().mjd)
    if kind == "comet":
        ast = None
        rows = dedupe(comet_images(t, refresh))
        center = (float(np.mean([r["comet_ra"] for r in rows])), float(np.mean([r["comet_dec"] for r in rows])))
        groups = [[r] for r in rows]
    else:
        if t.get("simbad"):
            ast = simbad_astrometry(t["simbad"], tid, refresh)
        else:  # plain sky position requested by a user: no known motion
            ast = {"source": "requested coordinates", "main_id": None, "ra": float(t["ra"]), "dec": float(t["dec"]),
                   "epoch": 2000.0, "pmra": 0.0, "pmdec": 0.0, "plx": 0.0}
        here = position_at(ast, now_year)
        rows = [r for r in dedupe(sia_images(*here, tid, refresh)) if r["detector"] in dets]
        if t.get("deep_time"):
            a, b = position_at(ast, 2000.0), here
            center = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        else:
            center = here
        groups = []
        for p_i, prow in enumerate(periods(rows, d["period_gap_days"])):
            for det in dets:
                g = [r for r in prow if r["detector"] == det]
                if g:
                    for r in g:
                        r["period"] = p_i
                    groups.append(spread(g, k))
    default_det = t.get("default_detector", dets[0])
    # Default detector first (so viewers see something quickly), then the rest, each in time order.
    groups.sort(key=lambda g: (g[0]["detector"] != default_det, g[0]["detector"], g[0]["mjd"]))
    log(f"  {len(rows)} images, {len(groups)} groups, grid {n}px over {fov}° centred {center[0]:.5f},{center[1]:.5f}")

    grid = grid_wcs(center, fov, n)
    pix_arcsec = fov * 3600 / n
    cut_size = fov * 1.45
    r_pix = 1.2 * SPHEREX_PIX_ARCSEC / pix_arcsec
    tdir = OUT / tid
    if tdir.exists():
        shutil.rmtree(tdir)
    (tdir / "frames").mkdir(parents=True, exist_ok=True)

    # ---- plan: one item per date × detector, plus older surveys
    plan = []
    for gi, g in enumerate(groups):
        det = g[0]["detector"]
        fid = f"d{det}_i{gi:03d}" if kind == "comet" else f"d{det}_p{g[0].get('period', 0):02d}"
        mj = float(np.mean([r["mjd"] for r in g]))
        plan.append({"key": fid, "survey": "SPHEREx", "detector": det, "band": None, "utc": iso(mj),
                     "label": f"SPHEREx D{det} · {iso(mj)[:10]}", "files": len(g), "files_done": 0, "status": "waiting"})
    deep_specs = (t.get("deep", d.get("deep", [])) if t.get("deep_time") and ast else [])
    for spec in deep_specs:
        sv, band = spec.split(":")
        plan.append({"key": f"{sv.lower()}_{band.lower()}", "survey": sv, "detector": None, "band": band, "utc": None,
                     "label": f"{sv} {band} (≈{int(DEEP_SURVEYS[sv]['year'])})", "files": None, "files_done": 0,
                     "status": "waiting"})
    by_key = {p["key"]: p for p in plan}
    lock = threading.Lock()
    frames, arrays, det_info, deep_info = [], {}, {}, {}
    state = {"revision": 0, "last_plan": 0.0}

    def manifest(complete: bool) -> dict:
        return {
            "id": tid, "name": t["name"], "kind": kind, "blurb": t.get("blurb", "").strip(),
            "default_detector": default_det, "astrometry": ast,
            "astrometry_note": None if ast is None else "Linear proper motion from SIMBAD (epoch J2000); parallax ignored.",
            "prediction_source": "IRSA 3I/ATLAS observation table (predicted positions)" if kind == "comet" else "SIMBAD proper motion",
            "grid": {"center": [round(center[0], 6), round(center[1], 6)], "fov_deg": fov, "size_px": n,
                     "pixel_arcsec": round(pix_arcsec, 3), "projection": "TAN", "orientation": "north up, east left",
                     "deep_time": bool(t.get("deep_time"))},
            "detectors": {str(k2): {**v, "frames": sum(1 for f in frames if f["detector"] == k2)} for k2, v in sorted(det_info.items())},
            "deep_surveys": deep_info,
            "frames": sorted(frames, key=lambda f: (f["detector"] or 0, f["mjd"])),
            "complete": complete, "revision": state["revision"],
            "plan": [{k2: v for k2, v in p.items()} for p in plan],
            "processing": (
                f"SPHEREx Level-2 cutouts (NASA/IPAC IRSA, {', '.join(COLLECTIONS)}; read from IRSA or its AWS open-data copy). "
                f"Flagged pixels ({', '.join(BAD_BITS)}) masked; ZODI model and median background subtracted; bilinear "
                f"reprojection to a {n}×{n} TAN grid; mean stack of up to {k} images per observing period and detector "
                "(wavelength varies between images — see each frame's range); shared asinh stretch per detector. Small masked "
                "holes are filled for display only; saturated star cores are filled with the image maximum."
                if kind != "comet" else
                f"Single SPHEREx Level-2 cutouts from IRSA's 3I/ATLAS table; flagged pixels masked; ZODI and median "
                f"background subtracted; bilinear reprojection to a fixed {n}×{n} TAN grid; shared asinh stretch."),
            "credits": (CREDITS if kind != "comet" else CREDITS[:2]) + [DEEP_SURVEYS[sv]["credit"] for sv in sorted({f["survey"] for f in frames if f["survey"] != "SPHEREx"})],
            "generated_utc": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            "pipeline_version": PIPELINE_VERSION,
        }

    def publish(complete=False, plan_only=False):
        with lock:
            if plan_only and time.time() - state["last_plan"] < 2:
                return
            state["last_plan"] = time.time()
            state["revision"] += 0 if plan_only else 1
            m = manifest(complete)
            tmp = tdir / "manifest.json.part"
            tmp.write_text(json.dumps(m, indent=1))
            tmp.replace(tdir / "manifest.json")
            if PLAN_HOOK:
                PLAN_HOOK(m["plan"])
        return m

    def mark(key, **kw):
        with lock:
            by_key[key].update(kw)
        publish(plan_only=True)

    # ---- downloads: everything in parallel from the start
    pool = cf.ThreadPoolExecutor(workers)
    gfuts = []
    for p, g in zip(plan, groups):
        def dl(r, key=p["key"]):
            c = (r["comet_ra"], r["comet_dec"]) if kind == "comet" else center
            path = str(cutout(r["url"], *c, cut_size, tid))
            with lock:
                by_key[key]["files_done"] += 1
                by_key[key]["status"] = "downloading"
            publish(plan_only=True)
            return path
        gfuts.append([pool.submit(dl, r) for r in g])

    deep_futs = {}
    for spec in deep_specs:
        sv, band = spec.split(":")
        key = f"{sv.lower()}_{band.lower()}"
        deep_futs[key] = pool.submit(_deep_download, t, d, ast, grid, n, center, cut_size, sv, band, refresh, by_key[key], lock, workers)

    # ---- process SPHEREx dates as their files arrive
    for p, g, futs in zip(plan, groups, gfuts):
        for r, fu in zip(g, futs):
            try:
                r["cutout"] = fu.result()
            except Exception as e:  # noqa: BLE001
                log(f"  {p['label']}: one file failed ({str(e)[:60]})")
                r["cutout"] = None
        g = [r for r in g if r.get("cutout")]
        mark(p["key"], status="processing")
        fr = _process_group(g, kind, ast, grid, n) if g else None
        if not fr:
            mark(p["key"], status="skipped", note="target not on usable pixels")
            continue
        det = fr["detector"]
        if det not in det_info:
            lo, hi = stretch_limits([fr["_arr"]])
            em = [r for r in rows if r["detector"] == det]
            det_info[det] = {"range_um": [round(min(r["em_min"] for r in em) * 1e6, 3), round(max(r["em_max"] for r in em) * 1e6, 3)],
                             "stretch": {"type": "asinh", "lower": lo, "upper": hi, "unit": "MJy/sr"}}
        st = det_info[det]["stretch"]
        fr["id"] = p["key"]
        fr["image"], fr["flags"] = f"frames/{p['key']}.webp", f"flags/{p['key']}.png"
        save_frame(fr["_arr"], st["lower"], st["upper"], tdir / fr["image"])
        fr["flagged_fraction"] = round(save_flags(fr["_flg"], tdir / fr["flags"]), 4)
        _measure_spherex(fr, fr["_arr"], grid, n, kind, r_pix)
        arrays[fr["id"]] = fr.pop("_arr")
        fr.pop("_flg"), fr.pop("_pred")
        with lock:
            frames.append({"survey": "SPHEREx", **fr})
            by_key[p["key"]]["status"] = "done"
        publish()
    log(f"  {sum(1 for f in frames if f['survey'] == 'SPHEREx')} SPHEREx frames")

    # ---- older surveys
    for key, fu in deep_futs.items():
        try:
            fr = fu.result()
        except Exception as e:  # noqa: BLE001
            log(f"  {by_key[key]['label']}: failed ({str(e)[:80]})")
            fr = None
        if not fr:
            if by_key[key]["status"] not in ("skipped",):
                mark(key, status="skipped", note=by_key[key].get("note") or "not available")
            continue
        lo, hi = stretch_limits([fr["_arr"]])
        deep_info[fr["band_label"]] = {"wavelength_um": fr["wavelength_um"]["mean"], "stretch": {"type": "asinh", "lower": lo, "upper": hi, "unit": "DN"}}
        fr.update(id=key, image=f"frames/{key}.webp", flags=None, flagged_fraction=None)
        save_frame(fr["_arr"], lo, hi, tdir / fr["image"])
        _measure_deep(fr, fr["_arr"], grid, n, kind, pix_arcsec)
        fr.pop("_arr"), fr.pop("_pred")
        with lock:
            frames.append(fr)
            by_key[key].update(status="done", utc=fr["utc"])
        publish()
    pool.shutdown(wait=False, cancel_futures=True)

    # ---- final: one shared stretch per detector over all its dates
    for det, info in det_info.items():
        ids = [f["id"] for f in frames if f["detector"] == det]
        lo, hi = stretch_limits([arrays[i] for i in ids])
        info["stretch"].update(lower=lo, upper=hi)
        for i in ids:
            save_frame(arrays[i], lo, hi, tdir / "frames" / f"{i}.webp")
    m = publish(complete=True)
    log(f"  wrote {tdir} ({len(frames)} frames)")
    return m


def _process_group(g, kind, ast, grid, n):
    """Stack one observing period × detector → frame dict with private _arr/_flg/_pred, or None."""
    mjd_mean = float(np.mean([r["mjd"] for r in g]))
    pred = (g[0]["comet_ra"], g[0]["comet_dec"]) if kind == "comet" else position_at(ast, mjd_to_year(mjd_mean))
    px, py = grid.world_to_pixel_values(*pred)
    ix, iy = int(round(float(px))), int(round(float(py)))
    if not (3 <= ix < n - 3 and 3 <= iy < n - 3):
        return None
    stack, flgs, sources = [], [], []
    for r in g:
        try:
            arr, flg, lam, bw, sat, core = load_image(Path(r["cutout"]), grid, n, pred)
        except Exception as e:  # noqa: BLE001 — a damaged file should not stop the build
            log(f"  skipped unreadable file {r['obs_id']} ({str(e)[:60]})")
            continue
        if np.isfinite(arr[iy - 3:iy + 4, ix - 3:ix + 4]).mean() < 0.5:
            continue
        stack.append(arr)
        flgs.append(flg)
        sources.append({"obs_id": r["obs_id"], "did": r["did"], "release": r["collection"].replace("spherex_", "").upper(),
                        "utc": iso(r["mjd"]), "mjd": round(r["mjd"], 6), "fits": r["url"],
                        "wavelength_um": round(lam, 4), "bandwidth_um": round(bw, 4), "saturated": sat, "_core": core})
    if not stack:
        return None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        arr = np.nanmean(np.stack(stack), axis=0)
        flg = np.nanmean(np.stack(flgs), axis=0)
    lams = [s["wavelength_um"] for s in sources]
    return {"_arr": arr, "_flg": flg, "_pred": pred, "detector": g[0]["detector"], "period": g[0].get("period"),
            "mjd": round(mjd_mean, 6), "utc": iso(mjd_mean),
            "utc_start": iso(min(r["mjd"] for r in g)), "utc_end": iso(max(r["mjd_end"] for r in g)),
            "releases": sorted({s["release"] for s in sources}), "n_images": len(stack),
            "saturated": any(s["saturated"] for s in sources),
            "wavelength_um": {"mean": round(float(np.mean(lams)), 4), "min": min(lams), "max": max(lams)},
            "sources": sources}


def write_index(manifests: list[dict]):
    idx_path = OUT / "targets.json"
    old = {t["id"]: t for t in json.loads(idx_path.read_text())["targets"]} if idx_path.exists() else {}
    for m in manifests:
        fr = m["frames"]
        dd = [f for f in fr if f["detector"] == m["default_detector"]] or fr
        old[m["id"]] = {
            "id": m["id"], "name": m["name"], "kind": m["kind"], "blurb": m["blurb"],
            "center": m["grid"]["center"], "frames": len(fr),
            "first_utc": min(f["utc"] for f in fr), "last_utc": max(f["utc"] for f in fr),
            "thumbnail": f"{m['id']}/{dd[-1]['image']}", "manifest": f"{m['id']}/manifest.json",
        }
    cfg_targets = yaml.safe_load((ROOT / "targets.yaml").read_text())["targets"]
    order = [t["id"] for t in cfg_targets]
    groups = {t["id"]: t.get("group", "Targets") for t in cfg_targets}
    for t in old.values():
        t["group"] = groups.get(t["id"], t.get("group", "Targets"))
    targets = sorted((t for t in old.values() if t["id"] in order), key=lambda t: order.index(t["id"]))
    idx_path.write_text(json.dumps({"generated_utc": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
                                    "targets": targets}, indent=1))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("targets", nargs="*", help="target ids (default: all)")
    ap.add_argument("--refresh", action="store_true", help="re-query IRSA/SIMBAD")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--index-only", action="store_true", help="only rewrite dist/data/targets.json from built manifests")
    a = ap.parse_args()
    cfg = yaml.safe_load((ROOT / "targets.yaml").read_text())
    todo = [t for t in cfg["targets"] if not a.targets or t["id"] in a.targets]
    unknown = set(a.targets) - {t["id"] for t in cfg["targets"]}
    if unknown:
        sys.exit(f"unknown target(s): {', '.join(sorted(unknown))}")
    if a.index_only:
        found = [json.loads((OUT / t["id"] / "manifest.json").read_text()) for t in todo if (OUT / t["id"] / "manifest.json").exists()]
        write_index(found)
        log(f"index: {len(found)} targets")
        return
    built, failed = [], []
    for t in todo:
        try:
            built.append(build_target(t, cfg["defaults"], a.refresh, a.workers))
        except Exception as e:  # noqa: BLE001 — keep going so one bad target does not block the rest
            log(f"  FAILED {t['id']}: {e}")
            failed.append(t["id"])
    if built:
        write_index(built)
    if failed:
        sys.exit(f"failed: {', '.join(failed)}")


if __name__ == "__main__":
    main()
