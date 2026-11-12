#!/bin/sh
# Assemble everything a Hugging Face Docker Space needs into one folder.
# Usage:  sh server/prepare_space.sh <space-folder>
#   e.g.  git clone https://huggingface.co/spaces/<user>/spherex-tm && sh server/prepare_space.sh spherex-tm
set -e
DEST="${1:?usage: sh server/prepare_space.sh <space-folder>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$DEST/pipeline" "$DEST/server"
cp "$ROOT/pipeline/build.py" "$ROOT/pipeline/s3cut.py" "$ROOT/pipeline/targets.yaml" "$ROOT/pipeline/requirements.txt" "$DEST/pipeline/"
cp "$ROOT/server/app.py" "$ROOT/server/requirements.txt" "$DEST/server/"
cp "$ROOT/server/Dockerfile" "$DEST/Dockerfile"
cat > "$DEST/README.md" <<'EOF'
---
title: SPHEREx Time Machine builder
emoji: 🔭
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

Live builder for the SPHEREx Time Machine (NASA Space Apps 2026). Builds SPHEREx / 2MASS / WISE time series for any
sky position from NASA/IPAC IRSA and NASA's AWS open data. API: `/api/health`, `/api/fields`, `/api/jobs`.
EOF
echo "Ready: $DEST — now: cd $DEST && git add -A && git commit -m 'Deploy builder' && git push"
