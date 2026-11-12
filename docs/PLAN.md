# Final Plan — SPHEREx Open Sky Observatory

**Event:** NASA Space Apps Challenge 2026 — Dhaka · Challenge: *Planet X and SPHEREx*
**Goal of the project:** let anyone pick a spot in the sky and **travel through time** — from 2000 (2MASS) through 2010 (WISE) to 2025–2026 (SPHEREx) and into the predicted future — to *see* how stars, brown dwarfs, comets and variable stars change.

> Track progress in [PROGRESS.md](PROGRESS.md). Verified datasets and endpoints are in [DATA_SOURCES.md](DATA_SOURCES.md).

---

## 1. What the judges will look for

The brief's core objective, quoted in short: users enter RA/Dec and the tool shows "a series of images of that patch like a little video". It names five test targets:

| Test target | What the user should see | Main evidence |
|---|---|---|
| **Barnard's Star** | Fastest star in the sky (~10.4″/yr) sliding across the frame | 2MASS 2000 → WISE 2010 → SPHEREx 2025–26 (~4.6′ total shift) |
| **Epsilon Indi B** | Brown dwarf pair moving with its star | Same "deep time" view + Gaia track |
| **WISE 0855** | Coldest known brown dwarf, fast and faint | SPHEREx long-wavelength detector (D5/D6) + WISE |
| **RW Aurigae** | Variable star changing brightness | SPHEREx light curve, wavelength-matched |
| **R Draconis** | Long-period variable (Mira) brightening/dimming | SPHEREx light curve, wavelength-matched |

Our current demo covers **none** of these. The plan below fixes that first.

## 2. Key facts that shape the plan (verified 2026-11-12)

- SPHEREx data at IRSA: **QR2** (Apr 2025 → mid-2026) and **QR3** (from Sep 2026). Every test target has **2–5 observing periods**; see DATA_SOURCES.md.
- SPHEREx alone spans ~1.5 years → nearby stars move only **1–2 SPHEREx pixels (6.2″/px)**. Visible with difference images and centroid measurement, not by eye.
- **Deep time** fixes this: NASA's **2MASS (2000)** and **WISE (2010)** images exist for the same spots at IRSA. Barnard's Star moved ~45 SPHEREx pixels since 2000.
- **IRSA does not allow browser access (no CORS)** → all IRSA downloads happen at build time in Python (GitHub Action). Site stays 100% static.
- **CDS hosts NASA sky maps with browser access**: SPHEREx QR2 (D1–D6 + color), 2MASS, AllWISE. These power the "any coordinate" explorer in Aladin Lite.
- SPHEREx uses a **linear variable filter**: wavelength changes across the detector. Comparing brightness between dates is only valid at **matching wavelengths**. Motion comparisons are fine with stacked frames.

## 3. Architecture (decided: static, no backend)

```
targets.yaml ──► pipeline/build.py (Python, astroquery/pyvo/astropy/reproject)
                     │  queries IRSA SIA (SPHEREx QR2+QR3, 2MASS, WISE, NEOWISE)
                     │  cutouts → reproject to common north-up grid → stretch
                     │  centroid target, wavelength at target, flags
                     ▼
              dist/data/<target>/frames/*.webp + manifest.json + lightcurve.json
                     │
   GitHub Action "refresh-data" (weekly + manual + "request a target" issue)
     commits new data → existing "deploy" Action publishes dist/ to GitHub Pages
                     │
                     ▼
   Static site: timeline player, deep-time view, difference, light curve,
   Gaia track & future prediction (browser math), Aladin Lite explorer
```

Why commit generated data instead of building it during deploy: if IRSA is slow or down, deploys still work and the demo never breaks.

Backend: **added as an optional live builder** (`server/`, decision 2026-11-12). The static site still works on its own for the prepared list.

## 4. Features — keep, add, remove

### Keep (improve)
- Blink / swipe / side-by-side compare → become modes of the new timeline viewer.
- Zoom, pan, keyboard control, provenance links to original NASA FITS.
- 3I/ATLAS as a "fast mover" showcase (rebuild with all its SPHEREx frames, QR2 + comet collection).
- Honest labelling ("predicted, not detected", "reference survey, not SPHEREx"). Judges value scientific honesty.
- NASA/SPHEREx acknowledgement, "independent project" note.

### Add
| Feature | Why it wins points |
|---|---|
| **Timeline player** (play/pause, speed, scrubber, date + survey + wavelength on every frame) | The core "little video" objective |
| **Prepared targets**: 5 test targets + 3I/ATLAS + 3–6 extras (e.g. Proxima Cen, Luhman 16, a bright asteroid) | Every judge test works instantly |
| **Deep time view**: 2MASS 2000 → WISE 2010 → SPHEREx 2025–26 | Makes star motion dramatic and visible — our signature feature |
| **Gaia motion track** (past + future positions, markers at each frame date) | Explains what you see; ties images to real measurements |
| **Future prediction slider** ("where will it be in 2030?") + **predicted vs observed** check on each new SPHEREx release | Unique "predict then verify" story |
| **Measured shift readout** ("Measured 10.6″ — Gaia predicts 11.2″") from centroiding | Scientific validity, not just pictures |
| **Difference mode** (frame B − frame A) | Makes 1–2 px motion and brightness change obvious |
| **Light curve** for variables, wavelength-matched | Covers RW Aur and R Dra properly |
| **Detector / wavelength picker** (D1–D6, stacked per period) | Uses SPHEREx's 102 bands; WISE 0855 needs D5/D6 |
| **Quality flags overlay** | Brief suggests showing contamination flags |
| **URL state** (`?target=barnard` or `?ra=..&dec=..&fov=..&t=..`) | Shareable/embeddable, brief suggests it |
| **Search box**: name (CDS Sesame) or RA/Dec in degrees *or* sexagesimal | WISE 0855 is given in h/m/s in the brief |
| **Any-coordinate explorer**: Aladin Lite with SPHEREx QR2 HiPS (D1–D6), 2MASS, AllWISE layers | Real SPHEREx at any position with no backend |
| **"Request a target"** via GitHub issue → Action builds it | Shows the tool grows with new data, still static |
| **Guided tour** (3 short steps) + "What am I looking at?" panels | Public-facing, beginner friendly |
| *Stretch:* spectrum on click (precomputed for prepared targets) | Brief's "extra kudos" |

### Remove / replace
| Item | Action | Reason |
|---|---|---|
| Orion / Andromeda / Galactic Center / Pleiades shortcuts | **Remove** → replace with prepared targets | Sightseeing, not the challenge |
| DSS2 visible-light layer | **Remove** | Not NASA, not infrared, not needed |
| Separate "Sky map" tab as a destination | **Merge** into one explorer (layer switcher) | One clear workflow instead of two apps |
| Coordinate box that only moves the reference map | **Replace** with unified search | Currently misleading |
| Hard-coded two-image `observations.json` | **Replace** with per-target `manifest.json` | Scales to many frames/targets |
| Aladin `latest` script URL | **Pin a fixed version** | Prevents surprise breakage on demo day |
| Marketing filler ("One universe…", "OPEN ACCESS" tag) | **Trim** | Space for real controls/info |

## 5. GUI redesign

Layout (desktop):
```
┌──────────────────────────────────────────────────────────────────────┐
│ ✳ SPHEREx Time Machine   [ Search name or RA/Dec ......... ] [Share] │
├──────────────┬───────────────────────────────────────┬───────────────┤
│ TARGETS      │                                       │ THIS FRAME    │
│ ★ Barnard's  │            MAIN VIEWER                │ Date, survey  │
│   Eps Ind B  │  (frame / blink / swipe / diff)       │ Detector, λ   │
│   WISE 0855  │  crosshair · Gaia track · scale bar   │ Flags         │
│   RW Aur     │  compass N/E                          │ Measured vs   │
│   R Dra      │                                       │ predicted     │
│   3I/ATLAS   │                                       │ shift         │
│ + Request    ├───────────────────────────────────────┤ [Light curve] │
│              │ ◀ ▶ ⏯  speed  [ Play | Blink | Swipe | Diff ]  λ: D3 │
│              │ 2000 ──●── 2010 ───────── 2025 ●●● 2026 ●● │ 2030 ▷ │
│              │  2MASS     WISE           SPHEREx QR2  QR3   future │
└──────────────┴───────────────────────────────────────┴───────────────┘
```
- **Timeline strip** is the hero: frames as dots coloured by survey, gaps shown to scale, future section dashed.
- Mobile: search on top, viewer, timeline, then collapsible "Targets" and "Frame info" drawers.
- Keyboard: `Space` play, `←/→` frame, `B` blink, `D` difference, `G` Gaia track, `+/−` zoom.
- Accessibility: colour-blind-safe survey colours, visible focus, `prefers-reduced-motion` stops autoplay, alt text on frames.
- Light + dark theme (dark default for astronomy).
- Loading states and clear errors ("This frame failed to load — show next").

## 6. Phases (priority order)

| Phase | Outcome | Must-have? |
|---|---|---|
| **P0 Cleanup** | Docs, remove unneeded features, pin versions, project structure | Yes |
| **P1 Data pipeline** | `build.py` + `targets.yaml` produce SPHEREx frame series for all prepared targets | Yes |
| **P2 Timeline viewer + new GUI** | Player, modes, frame info, URL state, search, mobile | Yes |
| **P3 Deep time + Gaia** | 2MASS/WISE frames, Gaia track, future slider, measured vs predicted shift | Yes — signature feature |
| **P4 Analysis** | Difference mode, wavelength-matched light curves, detector picker, flags | Yes |
| **P5 Any coordinate + updates** | Aladin explorer with SPHEREx HiPS, refresh Action, request-a-target | Should |
| **P6 Presentation** | Demo script, README, screenshots/video, slides, final QA | Yes |
| **P7 Stretch** | Spectrum on click, NEOWISE yearly frames, optional live backend | Only if time |

## 7. Demo script (3 minutes)

1. **Hook (20 s):** "Pluto was found by blinking two photos. We built a time machine for NASA's newest sky survey."
2. **Barnard's Star (50 s):** play 2000 → 2026; star slides ~4.6′; switch to SPHEREx-only + difference → 1–2 px shift; readout "measured vs Gaia predicted"; drag future slider to 2035.
3. **WISE 0855 (30 s):** invisible at short wavelengths, appears in D6 → why 102 bands matter.
4. **R Draconis (30 s):** light curve, wavelength-matched; explain the SPHEREx filter honestly.
5. **3I/ATLAS (20 s):** moves in hours — fast movers pop out instantly.
6. **Any coordinate + share link (20 s):** paste URL, show SPHEREx layer anywhere; "request a target" updates automatically with new releases.
7. **Close (10 s):** static, free, open, NASA data, updates itself.

## 8. Rules for all work

- **SPHEREx is the main data.** 2MASS and WISE (NASA/IPAC) are comparison layers; Gaia (ESA) only provides positions/motions. Label every frame with its survey.
- Only use data from the sources in DATA_SOURCES.md; add any new source there first, with its credit line.
- Never present predictions as detections.
- Keep the site static; every IRSA call lives in `pipeline/`.
- After finishing a task, tick it in PROGRESS.md and add a line to its session log.

## 9. Decisions log

| Date | Decision |
|---|---|
| 2026-11-12 | Static site + build-time GitHub Action; no backend (IRSA has no CORS; reliability for judging). |
| 2026-11-12 | Signature feature = deep time (2MASS 2000 → WISE 2010 → SPHEREx) + Gaia prediction. |
| 2026-11-12 | Remove DSS2 and sightseeing shortcuts; merge Sky map into one explorer. |
| 2026-11-12 | Commit generated data via a refresh Action instead of fetching during deploy. |
| 2026-11-12 | User feedback: tool felt closed (6 targets), Sky map had no time, wavelength slider unreliable, images unclear, timeline not draggable. → Redesign as one "Time Machine" screen; option **C**: prepared list (now 14) + live builder server for any position/name. |
| 2026-11-12 | Sky map tab removed; replaced by a "Pick on sky map" dialog (IRSA 2MASS/AllWISE, CDS SPHEREx QR2) that opens a time series at the clicked point. SPHEREx DR1 cube slider dropped (slow, gaps, low resolution). |
| 2026-11-12 | "Since 2000" view (2MASS ≈2000, WISE 2010, SPHEREx 2025–26) is the default for moving stars. Barnard's Star: 272″ measured vs 273″ expected over 26 years. |
