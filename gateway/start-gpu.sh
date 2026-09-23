#!/usr/bin/env bash
set -euo pipefail
GATEWAY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(cd -- "$GATEWAY_DIR/../.." && pwd)"
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-1}"
export DEEPTMHMM_DEVICE=cuda
exec "$WORK_DIR/model-runtime/bin/python" "$GATEWAY_DIR/run_local.py"
