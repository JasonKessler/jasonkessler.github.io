#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'This launcher requires an Apple Silicon Mac. See README.md.'; read -r -p 'Press Return to close.'; exit 1
fi
if ! command -v ffmpeg >/dev/null; then
  echo 'Install free FFmpeg first: brew install ffmpeg'; read -r -p 'Press Return to close.'; exit 1
fi
if ! command -v ollama >/dev/null; then
  echo 'Install the free Ollama app from https://ollama.com and download a local model.'; read -r -p 'Press Return to close.'; exit 1
fi
if ! curl --silent --fail http://127.0.0.1:11434/api/tags >/dev/null; then
  open -a Ollama || true
fi
RUNTIME="$HOME/.local/share/debate-room/venv"
if [[ ! -x "$RUNTIME/bin/python" ]]; then
  if command -v uv >/dev/null; then
    uv venv --python 3.12 "$RUNTIME"
  elif command -v python3.12 >/dev/null; then
    python3.12 -m venv "$RUNTIME"
  else
    echo 'Install free uv first: brew install uv'; read -r -p 'Press Return to close.'; exit 1
  fi
fi
if ! "$RUNTIME/bin/python" -c 'import mlx_whisper' >/dev/null 2>&1; then
  if command -v uv >/dev/null; then
    uv pip install --python "$RUNTIME/bin/python" -r requirements.txt
  else
    "$RUNTIME/bin/python" -m pip install -r requirements.txt
  fi
fi
(sleep 2; open http://127.0.0.1:8766/) &
exec "$RUNTIME/bin/python" local_service.py
