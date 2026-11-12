# Live builder (server)

A small Python web server that builds a SPHEREx time series for **any** sky position or star name, on request. The static site uses it for anything that is not in the prepared list (option C: prepared list + live builder). It runs the same code as the prepared targets (`pipeline/build.py`) and caches each result, so a place is built only once.

## Run locally
```sh
pipeline/.venv/bin/pip install -r server/requirements.txt
pipeline/.venv/bin/uvicorn server.app:app --port 7860
```
When the site is served from `localhost`, it automatically uses `http://localhost:7860`.

## API
| Call | Purpose |
|---|---|
| `GET /api/health` | Is the server up? |
| `GET /api/resolve?name=Teegarden's star` | Name → coordinates and motion (CDS Sesame / SIMBAD) |
| `POST /api/fields?ra=43.25&dec=16.88&fov=0.15&name=…` | Start (or reuse) a build → `{status, id}` |
| `GET /api/fields/{id}` | Status, queue position, `plan` (every part with its file count and status), `progress`, and `manifest` as soon as the first date is ready (`partial: true` until finished) |
| `GET /api/jobs` | All builds on this server (newest first) with progress — used by the site's Downloads panel |
| `GET /data/{id}/manifest.json` | The result (same format as `dist/data/<id>/manifest.json`) |

Results are published progressively: `manifest.json` is rewritten after every finished date with `complete: false` and a `plan`, so the site shows what is ready while the rest downloads. SPHEREx is read from NASA's AWS open-data copy first (`TM_USE_S3=1`, default), falling back to IRSA's cutout service.

A new place takes about 1–5 minutes (it downloads ~40 SPHEREx cutouts plus 2MASS and WISE images from IRSA). One build runs at a time; up to 8 wait in a queue. Downloaded cutouts are deleted after each build (set `TM_KEEP_CUTOUTS=1` to keep them).

## Deploy free on Hugging Face Spaces (needs your account)
1. On https://huggingface.co → **New Space** → name `spherex-tm` → SDK **Docker** → **Blank** → hardware **CPU basic (free)** → Create.
2. Copy the files into it with the helper script (from this repository's folder):
   ```sh
   git clone https://huggingface.co/spaces/<your-user>/spherex-tm ../spherex-tm
   sh server/prepare_space.sh ../spherex-tm
   cd ../spherex-tm && git add -A && git commit -m "Deploy builder" && git push
   ```
   (`git push` asks for your Hugging Face user name and an **access token with write permission** as the password — create one under Settings → Access Tokens.)
3. Wait until the Space shows **Running** (first build ≈3–5 min). Test: `https://<your-user>-spherex-tm.hf.space/api/health` → `{"ok": true, …}`.
4. Put the address in `dist/config.js` of this repository:
   ```js
   window.TM_API = 'https://<your-user>-spherex-tm.hf.space';
   ```
5. Commit and push this repository; GitHub Pages republishes the site, which now uses the live builder.

To update the builder later, run step 2 again.

Free Spaces sleep after inactivity and their disk is temporary: results disappear on restart and are rebuilt on the next request. That is fine for a demo; the prepared list never depends on the server.

## Environment variables
`TM_DATA_DIR`, `TM_CACHE_DIR` (where results/cutouts go), `TM_MAX_QUEUE` (default 8), `TM_KEEP_CUTOUTS` (default 0), `TM_USE_S3` (default 1).

## Why deploy it in the cloud
The server downloads from NASA servers in the US (IRSA and AWS us-east-1). From Dhaka that route was very slow during testing (≈3–11 KB/s per connection on 2026-11-12/13), while a server on Hugging Face (US/EU) is next to them. Visitors only download the small finished result (≈0.3 MB).
