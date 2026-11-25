#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

runtime="$HOME/.local/share/debate-room/venv"
if [[ ! -x "$runtime/bin/python" ]]; then
    if command -v uv >/dev/null; then
        uv venv --python 3.12 "$runtime"
    elif command -v python3.12 >/dev/null; then
        python3.12 -m venv "$runtime"
    else
        echo 'Install uv or Python 3.12 to set up the local runtime. With Homebrew, run: brew install uv' >&2
        exit 1
    fi
fi

# Let the debate timer load even if the optional AI components need setup.
if ! "$runtime/bin/python" -c 'import mlx_whisper' >/dev/null 2>&1; then
    if command -v uv >/dev/null; then
        uv pip install --python "$runtime/bin/python" -r requirements.txt || true
    else
        "$runtime/bin/python" -m pip install -r requirements.txt || true
    fi
fi

if ! /usr/bin/curl --noproxy '*' --silent --fail --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null; then
    /usr/bin/open -g -a Ollama || true
fi
exec "$runtime/bin/python" local_service.py --port "$1" --stop-on-stdin-eof
