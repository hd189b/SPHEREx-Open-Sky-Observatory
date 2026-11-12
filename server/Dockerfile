# SPHEREx Time Machine builder — runs on Hugging Face Spaces (Docker SDK) or any container host.
# Build from the repository root:  docker build -f server/Dockerfile -t spherex-tm .
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 TM_DATA_DIR=/tmp/tm/data TM_CACHE_DIR=/tmp/tm/cache
RUN useradd -m -u 1000 app
WORKDIR /app

COPY pipeline/requirements.txt pipeline/requirements.txt
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY pipeline/build.py pipeline/s3cut.py pipeline/targets.yaml pipeline/
COPY server/app.py server/
RUN mkdir -p /tmp/tm && chown -R app /tmp/tm
USER app

EXPOSE 7860
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "7860"]
