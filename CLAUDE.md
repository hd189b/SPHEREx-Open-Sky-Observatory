# SPHEREx Open Sky Observatory

Entry for **NASA Space Apps Challenge 2026 (Dhaka)**, challenge *Planet X and SPHEREx*: a public web tool that shows how the sky changes over time using NASA SPHEREx images.

## Start here (every new chat)
1. Read [docs/PROGRESS.md](docs/PROGRESS.md) → "Current phase" and "Next task".
2. Read [docs/PLAN.md](docs/PLAN.md) for the why, the feature list and the GUI layout.
3. Read [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) before touching data.

## Hard rules
- **Static site + optional live builder** (decided 2026-11-12, option C). `dist/` is a static site (GitHub Pages) that must work fully on its own for the prepared targets. `server/` (FastAPI, Hugging Face Spaces) builds any other sky position on request with the same `pipeline/build.py`. The browser never calls IRSA directly (no CORS).
- **Always use NASA data when it is available** (user rule, 2026-11-13): NASA/IPAC IRSA or NASA's AWS open-data buckets before any other host. Non-NASA services only where NASA has no equivalent (SIMBAD/Sesame for names → coordinates; Aladin Lite as viewer software).
- **SPHEREx is the main data.** 2MASS/WISE are labelled comparison layers; Gaia gives positions/motions only. No DSS2.
- Only use sources listed in DATA_SOURCES.md. Never present predictions as detections.
- Compare SPHEREx brightness only at matching wavelengths (linear variable filter).
- After each task: tick it in PROGRESS.md, update "Current phase"/"Next task", add a session-log line.
- New decisions go in the Decisions log in PLAN.md.

## Run locally
```sh
python -m http.server 8080 --directory dist          # site
pipeline/.venv/bin/uvicorn server.app:app --port 7860  # live builder (optional)
```
