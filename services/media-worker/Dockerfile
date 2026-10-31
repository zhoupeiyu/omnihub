FROM python:3.12-slim-bookworm

ARG YTDLP_VERSION=2026.10.26
ARG U2NETP_SHA256=309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 U2NET_HOME=/models

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /nonexistent mediaworker
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
 && python - <<'PY'
import yt_dlp
assert yt_dlp.version.__version__ == '2026.10.26'
PY
RUN mkdir -p /models /var/lib/media-worker/files /var/lib/media-worker/tmp \
 && curl -fsSL --proto '=https' --tlsv1.2 -o /models/u2netp.onnx https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx \
 && echo "${U2NETP_SHA256}  /models/u2netp.onnx" | sha256sum -c - \
 && chown -R 10001:10001 /models /var/lib/media-worker
WORKDIR /app
COPY app.py /app/app.py
COPY gallery.py video_edit.py /app/
COPY advanced.py /app/advanced.py
COPY advanced-runner.py /app/advanced-runner.py
COPY tests /app/tests
USER 10001:10001
EXPOSE 8110
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8110", "--no-access-log"]
