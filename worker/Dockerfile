# Orb.IT worker: Node 22 + ffmpeg + local Whisper. Runs anywhere a long-lived container can
# (a VPS, Railway, Fly.io, Render, or a Mac for development).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates fonts-inter python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
# Local transcription (TRANSCRIBE_PROVIDER=local) without an API key. The small English-capable model is
# baked in; mount a larger one and point WHISPER_MODEL_DIR at it for better accuracy.
RUN python3 -m venv /opt/whisper && /opt/whisper/bin/pip install --no-cache-dir faster-whisper==1.2.1 huggingface_hub \
    && /opt/whisper/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-small', local_dir='/opt/whisper-small')"
ENV WHISPER_PYTHON=/opt/whisper/bin/python WHISPER_MODEL_DIR=/opt/whisper-small
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY py ./py
USER node
CMD ["npx", "tsx", "src/index.ts"]
