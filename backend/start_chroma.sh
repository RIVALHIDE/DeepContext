#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHROMA_PORT="${CHROMA_PORT:-8001}"

echo "Starting local Chroma HTTP server on port ${CHROMA_PORT}"
echo "Backend .env should use:"
echo "  CHROMA_HOST=localhost"
echo "  CHROMA_PORT=${CHROMA_PORT}"
echo "  CHROMA_COLLECTION_NAME=deepcontext_v2"

exec chroma run --path "$SCRIPT_DIR/chroma_db" --host 0.0.0.0 --port "$CHROMA_PORT"
