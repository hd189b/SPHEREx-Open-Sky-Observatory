# Progress Tracker

Status keys: `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` dropped
Update this file after every task. Plan and reasons: [PLAN.md](PLAN.md). Data facts: [DATA_SOURCES.md](DATA_SOURCES.md).

**Current phase:** Option C done (prepared list + live builder) → record the 240-second demo video, then deploy the server
**Next task:** Deploy `server/` to Hugging Face Spaces and set `dist/config.js` (needs the user's account); then P3 leftovers (light curves P4.3).
**Demo set (kept small to limit downloads, 2026-11-12):** 5 challenge targets + Proxima Centauri + Kapteyn's Star + 3I/ATLAS. Live builder fetches only D2 + D5, 1 image per period (≈10–20 cutouts).
**Waiting on:** challenge Resources tab (published 2026-11-13) — user will share new data.

---

## P0 — Cleanup
- [x] P0.1 Write PLAN.md, PROGRESS.md, DATA_SOURCES.md, CLAUDE.md
- [x] P0.2 Restructure repo: `pipeline/` (Python), `dist/` (site), `dist/data/<target>/` (generated); `.gitignore` for venv/cache
- [x] P0.3 Remove DSS2 layer and sightseeing shortcuts (Orion, Andromeda, Galactic Center, Pleiades)
- [x] P0.4 Pin Aladin Lite to 3.8.2 (jsDelivr ES module, loaded with `import()`)
- [x] P0.5 Old `obs0.json`, `obs1.json`, `prepare_images.py` moved to `pipeline/legacy/`; old `dist/observations.json` + `epoch-*.png` removed (replaced by `dist/data/3i-atlas/`)

## P1 — Data pipeline (SPHEREx time series)
- [x] P1.1 `pipeline/targets.yaml` (SIMBAD names; astrometry fetched at build time via CDS Sesame — SIMBAD TAP was down)
- [x] P1.2 `pipeline/requirements.txt` + `pipeline/README.md`
- [x] P1.3 IRSA SIA `spherex_qr2` + `spherex_qr3`; dedupe; periods (gap > 20 d) × detector
- [x] P1.4 Cutouts with retries + Content-Length check; cached in `pipeline/cache/`
- [x] P1.5 Wavelength at target from `WCS-WAVE` (alt WCS "W", SIP stripped)
- [x] P1.6 Mean stack per period × detector on fixed north-up TAN grid (deep-time targets centred between 2000 and today)
- [x] P1.7 Shared asinh stretch per detector → lossless WebP; flags overlay PNG; saturated cores filled; small holes filled for display
- [x] P1.8 Flux-weighted centroid (global background/noise) → measured position, offset, S/N
- [x] P1.9 `manifest.json` per target + `targets.json` index
- [x] P1.10 All 5 test targets built and checked (fitted motion in the viewer's Motion check):
  - Barnard's Star: 9–13.5″/yr north per detector (catalogue 10.4″/yr; saturated → footprint centre)
  - Epsilon Indi B: 4.8″/yr south-east in D2 (catalogue 4.7″/yr)
  - WISE 0855: 8.7″/yr west in D5 (catalogue 8.2″/yr); undetected at short wavelengths, as expected
  - RW Aur, R Dra: motion tiny; position scatter 0.4–2″ = noise floor → brightness is the story (P4.3)
- [x] P1.11 3I/ATLAS from IRSA's comet table (Aug 7 2025, D3, 8 single exposures; moves ~13.7′ in 8.2 h)
- [x] P1.12 Unbiased positions for saturated stars: fill + measure only the archive's OVERFLOW footprint (earlier fill centred on the prediction biased results — fixed)

## P2 — Timeline viewer + new GUI
- [x] P2.1 New layout: top bar (views, search, share/help/about/theme), targets list, viewer, controls, timeline, frame-data panel
- [x] P2.2 Loads `data/targets.json` + per-target `manifest.json`
- [x] P2.3 Player: ▶/❚❚, speed, prev/next, timeline dots; HUD with date, detector, λ, release, exposures
- [x] P2.4 Modes: All dates, Blink, Swipe (draggable divider), Difference (B − A) — A/B picked on timeline
- [x] P2.5 Overlays: predicted ○, measured +, predicted track, flags; scale bar, N/E compass, RA/Dec under cursor; colour maps (grey/inverted/heat/ice)
- [x] P2.6 URL state (`target, det, mode, f, a, b, cmap` / `view=sky, ra, dec, fov, layer, ch`) + Share button
- [~] P2.7 Search: prepared-target names/aliases + RA/Dec degrees & sexagesimal parser done; name lookup for any object (Sesame) not yet
- [x] P2.8 Responsive layout, keyboard shortcuts, reduced-motion, focus styles, dark/light theme (saved)
- [~] P2.9 Help dialog (steps, markers, keys, wavelength explanation) done; guided tour not yet
- [x] P2.10 Motion check panel: measured shift vs SIMBAD expectation per detector; comet travel rate
- [x] P2.11 Sky map rebuilt: IRSA SPHEREx DR1 102-channel cube (wavelength slider + sweep), 2MASS + AllWISE from IRSA, SPHEREx QR2 colour from CDS; each layer health-checked before use (fixes the endless "P/DSS2/color loading" when CDS is down); prepared targets marked on the map
- [ ] P2.12 Confirm Sky map in a normal browser (built-in pane blocks some CDS requests; CDS HiPS server was down 2026-11-12)

## Redesign + option C (2026-11-12, after user feedback)
- [x] R.1 One "Time Machine" screen; Sky map tab removed → "Pick on sky map" dialog (IRSA 2MASS / AllWISE, CDS SPHEREx QR2) that opens a time series at the clicked point
- [x] R.2 Draggable timeline with broken axis (2000 · 2MASS ≈ 2010 · WISE ≈ 2025–26 · SPHEREx), Set A / Set B buttons, date label
- [x] R.3 "Since 2000" / "SPHEREx only" span toggle; moving stars open on "Since 2000"
- [x] R.4 Clearer images: whole path in view, brightness + contrast sliders, sharp-pixels option, name label on the image, plain-language help
- [x] R.5 Future slider ("where will it be in 2050?") + dashed path with year marks
- [x] R.6 Motion check: line fit over all dates; plain words ("moves north by about 10.4″ per year")
- [x] R.7 Live builder `server/app.py` (FastAPI): resolve names, queue builds, progress, cached results, CORS; Dockerfile + deploy guide (`server/README.md`)
- [x] R.8 Site search: prepared target → instant; any other name/coordinates → live builder with progress panel; results kept under "Your searches"; builds keep running if you open another target
- [x] R.9 Prepared list grouped (challenge targets / fast stars / comets); added Proxima Centauri, Kapteyn's Star
- [x] R.10 Pipeline: any coordinates (`kind: field`), progress hook, skips 2MASS tiles IRSA cannot cut, `--index-only`
- [x] R.12 Progressive results: pipeline publishes each finished date (manifest `complete:false` + `plan`); default detector first; final shared stretch at the end
- [x] R.13 Site: viewer opens as soon as the first date is ready, merges new dates while you watch; loading card lists missing parts with status/progress; detectors still loading are marked
- [x] R.14 Downloads panel (top bar, badge) listing every live build with progress, time and Open / Open (partial)
- [x] R.15 SPHEREx read from NASA's AWS open-data copy with range requests (pipeline/s3cut.py), IRSA fallback; shorter waits for 2MASS/WISE
- [x] R.16 Named objects that hardly move (e.g. exoplanet hosts like WASP-17b) are kind `object`: circle + name label; planets get a "the circle marks its host star" note
- [x] R.17 Downloads: click a build to see every step (status, files) and server messages; updates live
- [x] R.18 AWS reader fixes: end-of-file reads, layout learned per processing version (l2b-v20/v24/v25), whole-header check, 8-bit data
- [x] R.19 Sky picker: NASA maps only (2MASS default, SPHEREx DR1, AllWISE — all IRSA); map check waits 20 s, retries, says why it failed; tile loading bar ("Loading map tiles: 14 of 20")
- [x] R.20 README rewritten (what it does, NASA vs external data, how SPHEREx is used, run/host/back up); `server/prepare_space.sh` assembles a Hugging Face Space; astroquery dropped from requirements. Docker image not test-built locally (Docker daemon not running).
- [x] R.21 Server: builds run in separate processes (server/worker.py), up to 3 at once (TM_WORKERS) with a queue; stall timeout 4 min, total 15 min; retry starts a fresh build; builds stop with the server; archive search fails in ≈3 min instead of 20+
- [-] R.11 Six more fast stars (Lacaille 9352, Groombridge 1830, Wolf 359, Teegarden, Luhman 16, van Maanen) — dropped to save downloads; available through the live builder

## P3 — Deep time + Gaia (signature feature)
- [x] P3.1 Pipeline: 2MASS K mosaic (`twomass_allsky`) and WISE W2 single exposures (`wise_allsky`) on the same grid
- [x] P3.2 Timeline shows 2000 / 2010 / 2025–26 with survey colours (broken axis)
- [x] P3.3 Path from catalogue motion (SIMBAD, not Gaia; parallax ignored) with 5-year marks
- [x] P3.4 Future slider (to 2100) with predicted-position marker, labelled "predicted"
- [x] P3.5 Measured vs known motion (fit over all dates)
- [x] P3.6 Barnard's Star 2000 → 2026: 272.2″ measured vs 272.9″ expected

## P4 — Analysis tools
- [x] P4.1 Difference mode (B − A) with diverging colour map (done in P2)
- [x] P4.2 Detector / wavelength picker (D1–D6) (done in P2)
- [ ] P4.3 Wavelength-matched photometry → `lightcurve.json` for RW Aur, R Dra
- [ ] P4.4 Light-curve chart linked to timeline (click point → jump to frame)
- [ ] P4.5 WISE 0855 check: visible in D5/D6? document result honestly

## P5 — Any coordinate + updates
- [ ] P5.1 Explorer view: Aladin Lite with CDS SPHEREx QR2 D1–D6/color, 2MASS, AllWISE layers
- [ ] P5.2 Gaia catalogue overlay in Aladin (VizieR)
- [ ] P5.3 If searched position is near a prepared target → offer its timeline
- [ ] P5.4 GitHub Action `refresh-data.yml`: weekly + manual; runs pipeline; commits changed data
- [ ] P5.5 "Request a target" issue template → Action builds target → commits
- [ ] P5.6 Confirm deploy still works when IRSA is unreachable

## P6 — Presentation
- [ ] P6.1 README rewrite (features, data sources, credits, how to add a target, limitations)
- [ ] P6.2 Demo script rehearsal (PLAN.md §7), timed
- [ ] P6.3 Screenshots + 30 s screen recording
- [ ] P6.4 Slides / project page text for Space Apps submission
- [ ] P6.5 Final QA: all 5 test targets, mobile, slow network, offline, broken-frame handling

## P7 — Stretch
- [ ] P7.1 Spectrum on click for prepared targets (IRSA Spectrophotometry Tool output, precomputed)
- [ ] P7.2 NEOWISE yearly frames (2014–2024) — IRSA `neowiser` SIA was slow in testing
- [ ] P7.3 Optional live backend with static fallback

---

## Session log
| Date | Session summary |
|---|---|
| 2026-11-13 | Search looked broken: one build was stuck on IRSA's archive search and blocked the single-lane queue → parallel builds + timeouts; tested timeout, retry and 2 builds at once. |
| 2026-11-13 | WASP-17b search: worked but nothing was marked (treated as a sky field) → named objects always marked; AWS reader layout bug fixed (8 files in 33 s); Downloads rows expand to show steps. |
| 2026-11-13 | Progressive loading + loading card + Downloads panel; SPHEREx via AWS range reads. Network to US servers very slow from Dhaka during tests → recommend deploying the server to Hugging Face. |
| 2026-11-12 | Redesign after user feedback; option C (prepared list + live builder server); deep time 2MASS/WISE; demo set trimmed to 8 targets because IRSA cutouts were very slow (≈4 KB/s). |
| 2026-11-12 | Fixed centroid bias for saturated stars; motion fit over all dates; WISE 0855 default D5; old 2-image demo files removed. |
| 2026-11-12 | P0 + P1 + P2 core done: pipeline builds all prepared targets from IRSA; new UI with timeline, compare modes, motion check; Sky map moved to IRSA HiPS incl. SPHEREx DR1 cube. |
| 2026-11-12 | Confirmed demo uses real SPHEREx QR2 data (3I/ATLAS, 2 frames). Checked challenge brief (resources publish 2026-11-13). Verified SPHEREx coverage of all 5 test targets, CORS limits, CDS SPHEREx HiPS. Wrote final plan and tracking docs. |
