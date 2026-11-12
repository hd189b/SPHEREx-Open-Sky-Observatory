"""Fast SPHEREx cutouts from NASA's open-data copy on Amazon S3 (bucket nasa-irsa-spherex).

IRSA's cutout service makes IRSA's servers cut each image, which can be very slow. The same Level-2
files are public on AWS. This module reads only what the pipeline needs, with HTTP range requests:
  1 request  : the first 64 KB (primary + IMAGE headers → WCS → which rows we need)
  4 requests : IMAGE / FLAGS / ZODI rows around the target + the WCS-WAVE table, fetched in parallel
The position of FLAGS / ZODI / WCS-WAVE inside the file is the same for every file with the same
layout, so it is learned once (full header walk) and then reused; each reuse is checked against the
real header bytes, and any mismatch falls back to a full walk.

Slow international links: every request has a hard time limit and is retried on a fresh connection,
because a stalled connection can otherwise trickle a few KB per minute.
"""
from __future__ import annotations

import concurrent.futures as cf
import io
import math
import re
import threading
import time

import numpy as np
import requests
from astropy.io import fits
from astropy.wcs import WCS

S3 = "https://nasa-irsa-spherex.s3.amazonaws.com/"
IBE_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
BLOCK = 2880
HEAD = 64 * 1024
MIN_RATE = 8_000  # bytes/s; slower than this → abandon the connection and retry
_local = threading.local()
_layouts: dict = {}
_lock = threading.Lock()


def s3_url(ibe_url: str) -> str | None:
    return S3 + ibe_url[len(IBE_PREFIX):] if ibe_url.startswith(IBE_PREFIX) else None


def _session() -> requests.Session:
    if not hasattr(_local, "s"):
        _local.s = requests.Session()
        _local.s.headers["User-Agent"] = "spherex-open-sky-pipeline/1.0"
    return _local.s


def _range(url: str, start: int, length: int, tries: int = 6, upto_eof: bool = False) -> bytes:
    """Bytes [start, start+length). With upto_eof, a shorter answer is fine when the file ends earlier."""
    last = None
    for i in range(tries):
        t0, buf = time.time(), bytearray()
        try:
            with _session().get(url, headers={"Range": f"bytes={start}-{start + length - 1}"},
                                timeout=(8, 10), stream=True) as r:
                r.raise_for_status()
                cr = r.headers.get("Content-Range", "")  # "bytes a-b/total"
                at_eof = upto_eof and "/" in cr and int(cr.split("-")[1].split("/")[0]) + 1 == int(cr.split("/")[1])
                for chunk in r.iter_content(65536):
                    buf += chunk
                    if time.time() - t0 > 8 + length / MIN_RATE:
                        raise TimeoutError("connection too slow")
            if len(buf) != length and not (at_eof and len(buf) > 0):
                raise IOError(f"short read {len(buf)}/{length}")
            return bytes(buf)
        except Exception as e:  # noqa: BLE001 — retry on a fresh connection
            last = e
            _local.__dict__.pop("s", None)
            time.sleep(0.5 * i)
    raise IOError(f"range read failed after {tries} tries: {last}")


def _parse_header(raw: bytes, pos: int = 0):
    """Header starting at raw[pos:] → (header, header_length_in_bytes), or None if not complete."""
    end = pos
    while True:
        end = raw.find(b"END" + b" " * 77, end)
        if end < 0:
            return None
        if (end - pos) % 80 == 0:
            break
        end += 1
    hlen = math.ceil((end - pos + 80) / BLOCK) * BLOCK
    return fits.Header.fromstring(raw[pos:end + 80].decode("ascii")), hlen


def _data_size(hdr) -> int:
    naxis = int(hdr.get("NAXIS", 0))
    if not naxis:
        return 0
    n = (abs(int(hdr["BITPIX"])) // 8) * int(np.prod([hdr[f"NAXIS{i}"] for i in range(1, naxis + 1)]))
    return (n + int(hdr.get("PCOUNT", 0))) * int(hdr.get("GCOUNT", 1))


def _walk(url: str) -> dict:
    """Full header walk → {name: (header_offset, header, data_offset, data_size)}."""
    out, pos = {}, 0
    while True:
        raw = _range(url, pos, HEAD, upto_eof=True)
        parsed = _parse_header(raw) or _parse_header(_range(url, pos, HEAD * 4, upto_eof=True))
        hdr, hlen = parsed
        name, size = hdr.get("EXTNAME", "PRIMARY"), _data_size(hdr)
        out[name] = (pos, hdr, pos + hlen, size)
        pos += hlen + math.ceil(size / BLOCK) * BLOCK
        if name == "WCS-WAVE" or len(out) > 10:
            return out


def cutout(ibe_url: str, ra: float, dec: float, size_deg: float) -> bytes:
    """FITS bytes with IMAGE, FLAGS, ZODI cut around (ra, dec) plus the WCS-WAVE table.
    If a remembered file layout turns out wrong for this file, learn this file's layout and try once more."""
    try:
        return _cutout(ibe_url, ra, dec, size_deg, relearn=False)
    except LayoutError:
        return _cutout(ibe_url, ra, dec, size_deg, relearn=True)


class LayoutError(IOError):
    pass


def _cutout(ibe_url: str, ra: float, dec: float, size_deg: float, relearn: bool) -> bytes:
    url = s3_url(ibe_url)
    if not url:
        raise ValueError("not a SPHEREx IBE url")
    head = _range(url, 0, HEAD)
    p0 = _parse_header(head)
    p1 = _parse_header(head, p0[1]) if p0 else None
    if not (p0 and p1):
        raise IOError("headers larger than expected")
    img_hdr, img_data = p1[0], p0[1] + p1[1]
    version = re.search(r"l2b-v\d+", ibe_url)
    key = (version.group(0) if version else "", p0[1], p1[1], int(img_hdr["NAXIS1"]), int(img_hdr["NAXIS2"]))
    with _lock:
        lay = None if relearn else _layouts.get(key)
    if lay is None:
        lay = _walk(url)
        with _lock:
            _layouts[key] = lay

    w = WCS(img_hdr).celestial
    x, y = (float(v) for v in w.world_to_pixel_values(ra, dec))
    half = size_deg / 2 * 3600 / 6.15  # native SPHEREx pixel ≈ 6.15″
    nx, ny = int(img_hdr["NAXIS1"]), int(img_hdr["NAXIS2"])
    x0, x1 = max(0, int(x - half)), min(nx, int(x + half) + 1)
    y0, y1 = max(0, int(y - half)), min(ny, int(y + half) + 1)
    if x0 >= x1 or y0 >= y1:
        raise ValueError("position not on this image")

    specs = {"IMAGE": (img_hdr, img_data, None)}
    for name in ("FLAGS", "ZODI"):
        hoff, hdr, doff, _ = lay[name]
        specs[name] = (hdr, doff, hoff)

    def rows(name):
        hdr, doff, hoff = specs[name]
        bpp = abs(int(hdr["BITPIX"])) // 8
        raw = _range(url, doff + y0 * nx * bpp, (y1 - y0) * nx * bpp)
        # The whole header (EXTNAME may be far down a long header) — used to verify the remembered layout.
        check = _range(url, hoff, doff - hoff) if hoff is not None else b""
        return name, raw, check

    def table():
        hoff, _, doff, size = lay["WCS-WAVE"]
        return _range(url, hoff, doff - hoff + size)

    with cf.ThreadPoolExecutor(4) as ex:
        futs = [ex.submit(rows, n) for n in specs]
        tfut = ex.submit(table)
        got = {n: (raw, chk) for n, raw, chk in (f.result() for f in futs)}
        traw = tfut.result()

    # Check the reused layout against the real header bytes; on mismatch forget it (caller retries).
    bad = [n for n in ("FLAGS", "ZODI") if not re.search(rb"EXTNAME\s*=\s*'" + n.encode() + rb"\s*'", got[n][1])]
    if bad or b"WCS-WAVE" not in traw[:BLOCK * 4]:
        with _lock:
            _layouts.pop(key, None)
        raise LayoutError(f"file layout differs ({bad or 'WCS-WAVE'})")

    hdus = [fits.PrimaryHDU()]
    for name in ("IMAGE", "FLAGS", "ZODI"):
        hdr = specs[name][0]
        dtype = {-32: ">f4", -64: ">f8", 8: "u1", 16: ">i2", 32: ">i4", 64: ">i8"}[int(hdr["BITPIX"])]
        arr = np.frombuffer(got[name][0], dtype=dtype).reshape(y1 - y0, nx)[:, x0:x1]
        if "BZERO" in hdr or "BSCALE" in hdr:
            arr = arr * hdr.get("BSCALE", 1) + hdr.get("BZERO", 0)
        h2 = hdr.copy()
        for k, d in (("CRPIX1", x0), ("CRPIX2", y0), ("CRPIX1W", x0), ("CRPIX2W", y0)):
            if k in h2:
                h2[k] = h2[k] - d
        for k in ("BZERO", "BSCALE"):
            h2.remove(k, ignore_missing=True)
        hdus.append(fits.ImageHDU(data=np.ascontiguousarray(arr), header=h2, name=name))
    pad = lambda b: b + b"\0" * (-len(b) % BLOCK)  # noqa: E731
    tbl = fits.open(io.BytesIO(pad(fits.PrimaryHDU().header.tostring().encode()) + pad(traw)))[1]
    hdus.append(fits.BinTableHDU(data=tbl.data.copy(), header=tbl.header, name="WCS-WAVE"))
    buf = io.BytesIO()
    fits.HDUList(hdus).writeto(buf)
    return buf.getvalue()
