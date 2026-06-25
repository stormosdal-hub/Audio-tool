#!/usr/bin/env bash
# Serve the Conga Transient Grapher locally and open it in a browser.
# getUserMedia + ES modules require http://localhost (not file://), so we serve.
set -e

PORT="${1:-8000}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://localhost:${PORT}"

echo "Serving Conga Transient Grapher at ${URL}"
echo "Press Ctrl+C to stop."

# Try to open a browser (best-effort, ignore failures).
( sleep 1
  if   command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  elif command -v open      >/dev/null 2>&1; then open "$URL"
  fi ) >/dev/null 2>&1 &

cd "$DIR"
exec python3 -m http.server "$PORT"
