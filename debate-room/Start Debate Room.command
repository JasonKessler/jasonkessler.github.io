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
URL=http://127.0.0.1:18766/
if curl --noproxy '*' --silent --fail --max-time 2 "${URL}api/health" | "$RUNTIME/bin/python" -c 'import json,sys; d=json.load(sys.stdin); sys.exit(not (d.get("local") is True and "whisper_model" in d))' 2>/dev/null; then
  echo "Debate Room is already running at $URL"
  if [[ "${1:-}" != --no-open ]]; then open "$URL"; fi
  exit 0
fi
if lsof -nP -iTCP:18766 -sTCP:LISTEN >/dev/null 2>&1; then
  echo 'Port 18766 is in use by another process. Close that server, or run local_service.py with a different --port and open its printed URL directly.'
  exit 1
fi
if [[ "${1:-}" != --no-open ]]; then
  (for attempt in {1..20}; do
    if curl --noproxy '*' --silent --fail --max-time 1 "$URL" >/dev/null; then
      open "$URL"
      break
    fi
    sleep 0.25
  done) &
fi
exec "$RUNTIME/bin/python" local_service.py
