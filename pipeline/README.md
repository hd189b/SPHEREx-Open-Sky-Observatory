# Data pipeline

Builds the SPHEREx time-series frames that the static site shows. Runs on a developer machine or in a GitHub Action, never in the browser (IRSA does not allow browser access).

## Setup (or see the main README)
```sh
python3 -m venv pipeline/.venv
pipeline/.venv/bin/pip install -r pipeline/requirements.txt
```

## Run
```sh
pipeline/.venv/bin/python pipeline/build.py              # all targets
pipeline/.venv/bin/python pipeline/build.py barnard      # one target
pipeline/.venv/bin/python pipeline/build.py --refresh    # re-query IRSA/SIMBAD (new data release)
```
Downloads are cached in `pipeline/cache/` (about 5 MB per SPHEREx cutout, not committed).

## Output
```
dist/data/targets.json              list of prepared targets (for the target picker)
dist/data/<id>/manifest.json        frames, dates, detector, wavelength, flags, predicted + measured position
dist/data/<id>/frames/d<D>_<i>.webp stacked frame (grayscale, north up, east left)
dist/data/<id>/flags/d<D>_<i>.png   red overlay of masked pixels
```
Frame fields: `utc`, `utc_start`/`utc_end`, `releases` (QR2/QR3), `detector`, `wavelength_um` at the target (min/mean/max over stacked images), `n_images`, `saturated`, `flagged_fraction`, `predicted` and `measured` (`xy` is 0–1, origin top-left), and `sources` with links to every original FITS file.

## Add a target
Add an entry to `targets.yaml` (`id`, `name`, `simbad` name, `kind`, `fov_deg`, `default_detector`), then run `build.py <id>`. For a moving object use `kind: comet` with an IRSA table of predicted positions.

## What the processing does
1. SIMBAD position + proper motion (via CDS Sesame) → predicted position at each date.
2. IRSA SIA search in `spherex_qr2` and `spherex_qr3`; duplicates removed (newest release kept).
3. Images grouped into observing periods (gap > 20 days) × detector; up to `per_group` images per group, spread in time.
4. Cutouts; flagged pixels masked; ZODI model and median background subtracted; saturated cores filled.
5. Reprojection to one fixed north-up TAN grid per target; mean stack per group.
6. Shared asinh stretch per detector (so brightness changes between dates stay visible).
7. Flux-weighted centroid → measured position and offset from prediction.

Barnard's Star check (2026-11-12): measured motion 9.1–10.8″ north over one year in all six detectors, matching the expected ~10.4″/yr; measured positions are within 0.05–2.3″ of SIMBAD predictions.
