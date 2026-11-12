# Data Sources (verified)

Only use the sources listed here. Add a new source here (with credit line) before using it.
Last verified: **2026-11-12**.

## NASA data (primary)

| Survey | Years | Role in project | Where | Browser access (CORS) |
|---|---|---|---|---|
| **SPHEREx QR2** | Apr 2025 – mid 2026 | Main time series | IRSA SIA collection `spherex_qr2` | ❌ build time only |
| **SPHEREx QR3** | Aug 2026 – | Main time series (newest) | IRSA SIA collection `spherex_qr3` | ❌ build time only |
| SPHEREx 3I/ATLAS images | Aug 2025 – | Fast-mover showcase | IRSA comet page (see links) | ❌ |
| **2MASS All-Sky** | 1997–2001 | Deep-time "then" frame | IRSA SIA `twomass_allsky` | ❌ |
| **WISE / AllWISE** | 2010 | Deep-time middle frame | IRSA SIA `wise_allsky`, `wise_allwise` | ❌ |
| NEOWISE | 2014–2024 | Stretch: yearly frames | IRSA SIA `neowiser` (slow/large responses in testing) | ❌ |
| **SPHEREx DR1 all-sky cube (HiPS)** | to May 2026, released 2026-11-01 | Sky map, 102 wavelength channels | IRSA `https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube` (order 5, png, frame = 17×(band−1)+(channel−1); frames 50, 51 blank) | ✅ |
| 2MASS sky map (HiPS) | 1997–2001 | Sky map layer | IRSA `…/data/hips/CDS/2MASS/Color` (copy of CDS) | ✅ |
| AllWISE sky map (HiPS) | 2010 | Sky map layer | IRSA `…/data/hips/CDS/AllWISE/RGB-W4-W2-W1` | ✅ |
| SPHEREx QR2 sky maps (HiPS) | combined QR2 | Sky map layer (backup) | CDS `https://alasky.cds.unistra.fr/SPHEREx/color` (+ `D1`…`D6`) | ✅ (CDS HiPS server was down 2026-11-12) |

IRSA HiPS list: `https://irsa.ipac.caltech.edu/data/hips/list`. Aladin 3.8.2 cube quirk: `setSliceNumber` maps slice→wavelength linearly but picks tiles linearly in frequency; `applySlice()` in `dist/app.js` converts so the right `_<frame>.png` loads.

Other SPHEREx collections that exist at IRSA: `spherex_qr2_cal`, `spherex_qr3_cal`, `spherex_qr2_deep`, `spherex_qr3_deep`.

## Non-NASA (supporting only)
| Source | Use | Note |
|---|---|---|
| **Gaia DR3** (ESA) via CDS VizieR | Proper motion, parallax → tracks and predictions | Positions only, no images. Brief suggests Gaia overlays. |
| CDS Sesame | Name → coordinates + motion | Browser access only via mirrors `vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/S?` and `vizier.idia.ac.za/…` (the main `cds.unistra.fr` address redirects without CORS). The server uses the same mirrors. |
| CDS Aladin Lite | Sky viewer | GPLv3, pin a fixed version |

## SPHEREx from AWS (pipeline/s3cut.py, added 2026-11-13)
- Same Level-2 files as IRSA, public bucket `nasa-irsa-spherex` (us-east-1): `https://nasa-irsa-spherex.s3.amazonaws.com/<path after /ibe/data/spherex/>`.
- Read with HTTP range requests: first 64 KB (headers), then only the IMAGE / FLAGS / ZODI rows around the target and the WCS-WAVE table, in parallel. The file layout is learned once and checked on every reuse.
- Speed from Dhaka varied from ≈1 MB/s to ≈3 KB/s per connection; 8 parallel connections gave ≈4–5× more. Every request has a hard time limit and is retried; IRSA's cutout service is the fallback.

## 2MASS / WISE as used by the pipeline (checked 2026-11-12)
- 2MASS: SIA `twomass_allsky`, `dataproduct_subtype = science`, band `K`; files are `.fits.gz` — add `gzip=false` to the IBE cutout request. Tiles are 8.5′ × 17′, so the pipeline searches the whole field and mosaics up to 12 tiles (≈1998–2001).
- WISE: SIA `wise_allsky`, science **single exposures** (`…/4band_p1bm_frm/…-w2-int-1b.fits`), band `W2`, one visit (≈2010-03 to 2010-05 depending on position), up to 8 stacked. Saturated cores are NaN in these files. AllWISE coadds are not used (they mix 2010 visits 6 months apart and smear fast stars).
- Positions in 2MASS/WISE are measured with a half-maximum region centre (starts at the brightest pixel, not the prediction).

## Removed
- DSS2 (visible-light, not NASA) — dropped 2026-11-12.
- SPHEREx DR1 HiPS cube slider in the sky view — dropped 2026-11-12 (slow, coverage gaps, blank channels, low resolution). The URL stays listed above for reference.

## Endpoints
- IRSA SIA: `https://irsa.ipac.caltech.edu/SIA?COLLECTION=<c>&POS=CIRCLE+<ra>+<dec>+<r>&MAXREC=<n>`
- IRSA TAP: `https://irsa.ipac.caltech.edu/TAP/sync` (`ivoa.obscore` lists collections)
- IRSA datalink: `https://irsa.ipac.caltech.edu/datalink/links/spherex?ID=ivo://irsa.ipac/spherex_qr2?<obs_id>/<Dn>`
- IRSA cutout: append `?center=<ra>,<dec>&size=<deg>` to the IBE FITS URL (tested OK; ~5 MB for 0.1°, all extensions)
- CDS MocServer (list HiPS): `https://alasky.cds.unistra.fr/MocServer/query?ID=<pattern>&get=id`
- SPHEREx mission page at IRSA: https://irsa.ipac.caltech.edu/Missions/spherex.html
- Challenge page: https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/ (Resources tab opens 2026-11-13 — recheck)

## SPHEREx file facts the pipeline relies on (checked 2026-11-12)
- SIA `access_url` for `spherex_qr2`/`qr3` is the **direct FITS URL** (IBE). Rows also carry `cloud_access` (AWS S3 bucket `nasa-irsa-spherex`). The 3I/ATLAS table's `access_url` is a **datalink** URL; resolve `#this`.
- SIA responses contain a small self-description table first; read the table with the most fields, using column **names** (not IDs).
- Cutout extensions: `IMAGE` (MJy/sr, TAN-SIP), `FLAGS` (bit names in `MP_*` header keys), `VARIANCE`, `ZODI`, `PSF` (121×101×101 cube — ~5 MB, makes every cutout ~5 MB), `WCS-WAVE` (lookup table). Wavelength per pixel: `WCS(header, fobj=hdul, key="W")`.
- Native pixel ≈ 6.15″. Detectors pair up on the sky: **D1/D4, D2/D5, D3/D6** see the same field at the same time, so a single visit covers only some detectors at a given target.
- Bright stars (Barnard's Star) **saturate**: core pixels are NaN in the archive image and flagged OVERFLOW / SUR_ERROR. Pipeline fills these near the target and marks the frame `saturated`.
- IRSA connections from this machine sometimes reset or truncate; pipeline retries and checks Content-Length.
- SIMBAD TAP was down on 2026-11-12; astrometry is read through **CDS Sesame** (same SIMBAD values: position J2000, proper motion, parallax).

## Coordinates (SIMBAD via Sesame, J2000)
| Target | RA | Dec | pmRA* (mas/yr) | pmDec (mas/yr) | Parallax (mas) |
|---|---|---|---|---|---|
| Barnard's Star | 269.45208 | 4.69336 | −801.6 | 10362.4 | 547.0 |
| Epsilon Indi B | 331.04415 | −56.78284 | 3982.0 | −2466.8 | 270.7 |
| WISE 0855−0714 | 133.81891 | −7.24705 | −8123.7 | 673.2 | 439.0 |
| RW Aurigae | 76.95653 | 30.40144 | 7.2 | −20.3 | 15.4 |
| R Draconis | 248.16761 | 66.75498 | −20.6 | 6.1 | 1.25 |

## SPHEREx coverage of the test targets (IRSA SIA, r = 0.01°)
⚠ The Epsilon Indi B and R Draconis rows below were queried at wrong coordinates (330.84 / 245.14). Use the counts in each target's `dist/data/<id>/manifest.json` instead.


| Target | RA, Dec used (deg) | QR2 images / days | QR3 images / days | Observing periods |
|---|---|---|---|---|
| Barnard's Star | 269.452, 4.694 | 241 / 26 | 123 / 15 | Aug–Sep 2025; Sep–Oct 2025; Mar–Apr 2026; May 2026; Aug–Sep 2026 |
| Epsilon Indi B | 330.84, −56.786 | 338 / 53 | 117 / 10 | Apr–Jun 2025; Sep–Nov 2025; Apr–May 2026; Sep–Oct 2026 |
| WISE 0855 | 133.795, −7.245 | 256 / 27 | 0 | May 2025; Oct–Nov 2025; Dec 2025; Apr–May 2026 |
| RW Aurigae | 76.956, 30.401 | 224 / 25 | 110 / 10 | Sep 2025; Feb–Mar 2026; Sep 2026 |
| R Draconis | 245.141, 66.753 | 454 / 67 | 0 | May–Jul 2025; Oct 2025–Jan 2026; Apr 2026; May–Jul 2026 |

Barnard's Star older epochs: 2MASS 2000-05-28 (27 images), AllWISE 2010-03-18 (28), WISE all-sky (51).
Note: RA/Dec above are approximate J2000 values; the pipeline must use Gaia positions + proper motion for the epoch of each frame (Barnard's Star has moved ~4.6′ since 2000).

## Motion expected (pixel = SPHEREx 6.2″)
| Target | Proper motion | SPHEREx-only shift | Since 2000 (2MASS) |
|---|---|---|---|
| Barnard's Star | ~10.4″/yr | ~11″ ≈ 1.8 px | ~4.6′ ≈ 44 px |
| Epsilon Indi B | ~4.7″/yr | ~7″ ≈ 1.1 px | ~2′ |
| WISE 0855 | ~8.1″/yr | ~8″ ≈ 1.3 px | (no 2MASS detection; WISE 2010 → ~2′) |

## Credit lines (must appear on site + README)
- **SPHEREx:** "This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration."
- **2MASS:** "This publication makes use of data products from the Two Micron All Sky Survey, which is a joint project of the University of Massachusetts and the Infrared Processing and Analysis Center/California Institute of Technology, funded by the National Aeronautics and Space Administration and the National Science Foundation."
- **WISE:** "This publication makes use of data products from the Wide-field Infrared Survey Explorer, which is a joint project of the University of California, Los Angeles, and the Jet Propulsion Laboratory/California Institute of Technology, funded by the National Aeronautics and Space Administration."
- **NEOWISE** (if used): funded by NASA's Planetary Science Division; JPL/Caltech.
- **IRSA:** "This research has made use of the NASA/IPAC Infrared Science Archive, which is funded by the National Aeronautics and Space Administration and operated by the California Institute of Technology."
- **Gaia:** "This work has made use of data from the European Space Agency (ESA) mission Gaia, processed by the Gaia Data Processing and Analysis Consortium (DPAC)."
- **CDS / Aladin:** "This research has made use of the CDS services (Aladin Lite, VizieR, Sesame), Strasbourg, France."

Verify exact wording against each archive's acknowledgement page before final submission (P6.1).
