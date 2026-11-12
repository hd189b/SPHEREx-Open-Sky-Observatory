# SPHEREx Time Machine

**A time machine for the infrared sky.** Pick a star — or search any star or sky position — and travel through time in NASA infrared images: from **2MASS (≈2000)** and **WISE (2010)** to **SPHEREx (2025–2026)**, and on into the predicted future.

> ### What it does
> - **Shows how the sky changes over time** in real NASA SPHEREx images: nearby stars and brown dwarfs that **move**, stars that **change brightness**, and an interstellar comet that **crosses the sky in hours**.
> - **Measures it, not just shows it:** the position of the target is measured in every image and compared with its catalogued motion. Barnard's Star moves **272″ in 26 years — the expected value is 273″**.
> - **Works for any place in the sky:** eight targets are ready-made; anything else (a name like *TRAPPIST-1* or coordinates) is built on request from NASA archives in a few minutes, showing each date as soon as it is ready.
> - **Answers the challenge brief:** coordinates in → a "little video" of SPHEREx images out, with blink, swipe and difference views, the six SPHEREx detectors, metadata and shareable links.

Entry for the **[NASA Space Apps Challenge 2026 — *Planet X and SPHEREx*](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/)** (Dhaka). Independent project, not an official NASA service.

---

## Data used

### NASA data (all images)
| Data | Years | What it is used for | Where it comes from |
|---|---|---|---|
| **SPHEREx Quick Release QR2 + QR3** — Level-2 spectral images | 2025–2026 | **Main data**: every frame of every time series | NASA/IPAC **IRSA** (search + cutouts) and NASA's **AWS open-data** copy (`nasa-irsa-spherex`) |
| **SPHEREx Data Release 1** all-sky map (102 wavelength channels) | 2025–2026 | Sky map for picking a place | IRSA HiPS |
| **SPHEREx observations of comet 3I/ATLAS** + predicted positions | Aug 2025 | Comet time series | IRSA 3I/ATLAS table |
| **2MASS** All-Sky images (Ks band) | 1997–2001 | "Since 2000" — oldest frame of each moving star | IRSA |
| **WISE** All-Sky single exposures (W2 band) | 2010 | "Since 2000" — middle frame | IRSA |
| **2MASS** and **AllWISE** sky maps | — | Sky map layers | IRSA HiPS |

### External (non-NASA) — only where NASA has no equivalent
| Service | Used for | Note |
|---|---|---|
| **SIMBAD** via **CDS Sesame** (Strasbourg) | Turning a name (e.g. *WASP-17b*) into coordinates and its known motion | Positions only — no images |
| **Aladin Lite** (CDS) | Viewer software for the sky map | Loads NASA maps from IRSA |
| jsDelivr | Delivers the Aladin Lite script | — |

**Rule of the project: NASA data whenever it is available.** No non-NASA images are used.

---

## How SPHEREx data is used

> SPHEREx maps the whole sky every six months in **102 infrared colours** (0.75–5 µm) with **six detectors**. Each detector has a filter whose wavelength changes across it, so a star is seen at a slightly different colour every time it lands on a different part of the detector. The tool uses this data in five steps:

1. **Find every observation** of the position in **QR2 and QR3** (IRSA search), so each target gets *all* dates SPHEREx has observed — typically 3–5 visits since spring 2025.
2. **Fetch only the needed part** of each 70 MB image: a small cutout around the target — `IMAGE`, `FLAGS` and `ZODI` rows plus the per-pixel wavelength table — read directly from NASA's AWS copy (or IRSA's cutout service).
3. **Clean and align:** remove pixels flagged as bad by the mission, subtract the zodiacal-light model (`ZODI`) and the background, then reproject every image onto one north-up grid so that only real changes remain.
4. **Stack per visit and detector:** images from the same visit are averaged for less noise. Each frame records the **date, detector, exact wavelength at the target**, number of images, saturation and links to every original NASA file.
5. **Measure:** the target's position is measured in every frame (saturated stars from the mission's own saturation flags) and compared with the prediction. A straight-line fit through all dates gives the motion:

| Target | Measured with SPHEREx (+2MASS/WISE) | Known motion |
|---|---|---|
| Barnard's Star | 10.4″/yr north · 272″ since 2000 | 10.4″/yr · 273″ |
| Epsilon Indi B (brown dwarfs) | 4.7″/yr south-east | 4.7″/yr |
| WISE 0855−0714 (coldest brown dwarf) | 8.2–8.7″/yr west — visible only at 3.8–4.4 µm | 8.2″/yr |
| Kapteyn's Star | 8.6″/yr | 8.7″/yr |
| Proxima Centauri | 3.9″/yr | 3.9″/yr |
| Comet 3I/ATLAS | 13.7′ in 8.2 hours | IRSA ephemeris |

The **six detectors** are offered as "infrared colours" (D1 0.75 µm → D6 5 µm): the coldest brown dwarf only appears at the long end. Brightness is only compared between frames with similar wavelengths, because of the changing filter.

---

## Features
- **Ready-made targets:** the five challenge test targets (Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae, R Draconis), Proxima Centauri, Kapteyn's Star and comet 3I/ATLAS — open instantly.
- **Search anything:** star names, exoplanets (the circle marks the host star), or coordinates in degrees or h/m/s. **Pick on sky map** lets you click a place.
- **Live building with progress:** new places show each date as soon as it is ready, a card lists what is still loading, and a **Downloads** panel shows every build step by step.
- **Time machine:** play or drag the timeline; **Since 2000 / SPHEREx only**; future slider ("where will it be in 2050?").
- **Compare two dates:** Blink, Swipe and Difference (blue = brighter before, orange = brighter after).
- **Readable images:** brightness/contrast, colour maps, sharp pixels, name label, scale bar, compass, RA/Dec under the cursor.
- **Shareable links**, keyboard shortcuts, phone layout, light/dark theme.

---

## Project structure
```
dist/                 the website (static HTML/CSS/JS) — published to GitHub Pages
  data/               ready-made targets: targets.json + <target>/manifest.json + frames/*.webp
  config.js           address of the live builder (TM_API)
pipeline/             Python: builds time series from NASA archives
  build.py            search → cutouts → clean/align/stack → measure → manifest.json
  s3cut.py            fast partial reads of SPHEREx files from NASA's AWS copy
  targets.yaml        the ready-made targets
server/               live builder for any position (FastAPI) + Dockerfile for Hugging Face Spaces
docs/                 PLAN.md, PROGRESS.md, DATA_SOURCES.md (decisions, progress, verified data sources)
.github/workflows/    deploy.yml — publishes dist/ to GitHub Pages on every push to main
```

---

## Run a new instance (from scratch)
Needs **git** and **Python 3.11+**.
```sh
git clone https://github.com/hd189b/SPHEREx-Open-Sky-Observatory.git
cd SPHEREx-Open-Sky-Observatory
python3 -m venv pipeline/.venv
pipeline/.venv/bin/pip install -r server/requirements.txt
```
Start the website (the ready-made targets are already in `dist/data/`):
```sh
python3 -m http.server 8080 --directory dist
```
Start the live builder in a second terminal (optional — needed for searching new places):
```sh
pipeline/.venv/bin/uvicorn server.app:app --port 7860
```
Open http://localhost:8080 — on localhost the site finds the builder at port 7860 automatically.

Rebuild or add ready-made targets (downloads from NASA, ≈150–300 MB per target, cached in `pipeline/cache/`):
```sh
pipeline/.venv/bin/python pipeline/build.py barnard          # one target
pipeline/.venv/bin/python pipeline/build.py                  # all targets in pipeline/targets.yaml
pipeline/.venv/bin/python pipeline/build.py --index-only     # only rewrite the target list
```
To add a target, add an entry to `pipeline/targets.yaml` (see [pipeline/README.md](pipeline/README.md)).

---

## Host it
**Website — GitHub Pages (free):**
1. Push to the `main` branch of the GitHub repository.
2. On GitHub: **Settings → Pages → Source: GitHub Actions** (once).
3. The workflow in `.github/workflows/deploy.yml` publishes `dist/` on every push. The site appears at `https://<user>.github.io/SPHEREx-Open-Sky-Observatory/`.

Without the live builder the hosted site shows the eight ready-made targets; searching a new place says the builder is not connected.

**Live builder — Hugging Face Spaces (free, Docker):** full steps in [server/README.md](server/README.md). In short:
```sh
git clone https://huggingface.co/spaces/<user>/spherex-tm ../spherex-tm   # after creating a Docker Space
sh server/prepare_space.sh ../spherex-tm                                  # copies pipeline/, server/, Dockerfile
cd ../spherex-tm && git add -A && git commit -m "Deploy builder" && git push
```
Then set the Space address in `dist/config.js`:
```js
window.TM_API = 'https://<user>-spherex-tm.hf.space';
```
and push again. Running the builder in the cloud is also much faster: it sits next to NASA's servers in the US.

---

## Back up
Everything needed to run a new instance is in git: the website, the ready-made target data (`dist/data`, ≈4 MB), the pipeline, the server and the docs.
```sh
git add -A
git commit -m "Describe the change"
git push origin main
```
Not in git (re-created automatically): `pipeline/.venv/` (Python packages), `pipeline/cache/` (downloaded NASA files, several GB) and `server/data/`, `server/cache/` (places built on request).

---

## Limits
- A new place takes 1–5 minutes to build; NASA's archives can be slow from some countries.
- Predicted positions are guides, not detections. Brightness is shown on one scale per detector; compare it only between frames with similar wavelength.
- Solar-system objects (planets, asteroids) are not supported — they move every day and have no fixed position. Mercury and Venus are never observed by SPHEREx (always too close to the Sun).

## Credits
This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration. This research has made use of the NASA/IPAC Infrared Science Archive, which is funded by the National Aeronautics and Space Administration and operated by the California Institute of Technology. This publication makes use of data products from the Two Micron All Sky Survey (University of Massachusetts and IPAC/Caltech, funded by NASA and the NSF) and the Wide-field Infrared Survey Explorer (UCLA and JPL/Caltech, funded by NASA). This research has made use of the SIMBAD database and Aladin Lite, operated at CDS, Strasbourg, France.

Code: Apache License 2.0 (see `LICENSE`). Data keeps its providers' terms.
