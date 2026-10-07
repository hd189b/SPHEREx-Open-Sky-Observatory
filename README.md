# SPHEREx Open Sky Observatory

A public, static HTML/CSS/JavaScript explorer. No backend, account, analytics, database or API key.

## Run locally

Serve the `dist` directory with any static web server, for example:

```sh
python -m http.server 8080 --directory dist
```

Open http://localhost:8080. A server is needed because browsers restrict JSON fetches on file:// URLs. This is only static file serving, not application backend logic.

## Features

- Curated real SPHEREx observation pair of the 3I/ATLAS field.
- Swipe, blink and side-by-side views, pan, zoom, keyboard navigation.
- Predicted comet positions from IRSA, not automatic detections.
- Full-sky reference navigation through CDS Aladin Lite using 2MASS and DSS2.
- Source links, UTC timestamps and scientific limitations.

## Data boundaries

The bundled pair is archival. This app does not offer a latest SPHEREx exposure at every sky position, or all 102 bands. Full-sky reference imagery is clearly labelled and is not SPHEREx imagery. Remote atlas requires network access and WebGL2. The bundled comparison only needs the static site files.

SPHEREx FITS cutouts were processed once during development to generate static PNGs on a common celestial grid. Python is not required to run the website. See `prepare_images.py` for provenance of processing and `dist/observations.json` for input sources, dates, field and scaling.

NASA acknowledgement: This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration.

Aladin Lite is provided by CDS, Strasbourg Observatory (GPLv3). External survey data retain their providers' terms. This is an independent project, not an official NASA service.
