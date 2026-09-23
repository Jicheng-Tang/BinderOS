"""Run the authenticated local pilot; secrets and model files stay outside Git."""
import os
import secrets
from pathlib import Path

import uvicorn

workspace = Path(__file__).resolve().parents[2]
runtime = Path(os.environ.get("BINDEROS_RUNTIME_DIR", str(workspace / "binderos-runtime")))
runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
token_path = runtime / "gateway-token.txt"
if not token_path.exists():
    with token_path.open("x") as stream:
        stream.write(secrets.token_urlsafe(48))
token_path.chmod(0o600)
os.environ["BINDEROS_GATEWAY_TOKEN"] = token_path.read_text().strip()
defaults = {
    "BINDEROS_JOB_ROOT": str(runtime / "jobs"),
    "DEEPTMHMM_BIN": str(workspace / "model-runtime/bin/dtm2"),
    "DEEPTMHMM_MODEL_DIR": str(workspace / "deeptmhmm2/checkpoints"),
    "DEEPTMHMM_DEVICE": "cpu",
    "BINDEROS_ENABLED_MODELS": "deeptmhmm2,proteinmpnn,boltz2",
    "PROTEINMPNN_DIR": str(workspace / "proteinmpnn"),
    "PROTEINMPNN_REVISION": "8907e6671bfbfc92303b5f79c4b5e6ce47cdef57",
    "BOLTZ_PYTHON": "/home/hy/miniconda3/envs/boltz/bin/python",
    "BOLTZ_CACHE": str(workspace / "model-cache/boltz"),
    "NUMBA_CACHE_DIR": str(workspace / "model-cache/numba"),
    "DEEPTMHMM_REVISION": "b05e27adf50738405e1de0b4a6b7072bb145fd3a",
    "TORCH_HOME": str(workspace / "model-cache/torch"),
    "MPLCONFIGDIR": str(workspace / "model-cache/matplotlib"),
    "XDG_CACHE_HOME": str(workspace / "model-cache"),
    "OMP_NUM_THREADS": "4",
    "MKL_NUM_THREADS": "4",
}
for key, value in defaults.items():
    os.environ.setdefault(key, value)

if __name__ == "__main__":
    if os.environ["DEEPTMHMM_DEVICE"].startswith("cuda"):
        import torch
        if not torch.cuda.is_available():
            raise SystemExit("GPU unavailable in this terminal. Run from the host system terminal with CUDA-enabled PyTorch.")
        probe = torch.ones((16, 16), device="cuda")
        _ = (probe @ probe).sum().item()
        print(f"GPU ready: {torch.cuda.get_device_name(0)} / PyTorch {torch.__version__}", flush=True)
    uvicorn.run("app:app", host="127.0.0.1", port=8765, workers=1)
