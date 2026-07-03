#!/bin/bash
# PLATEAU Viewer 起動スクリプト（macOS / Linux）
cd "$(dirname "$0")"
if [ -d ".venv" ]; then
    source .venv/bin/activate
fi
python3 plateau_viewer.py "$@"
