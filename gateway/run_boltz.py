"""Reuse installed Boltz without editing it; use FP32 on Turing GPUs."""
import importlib.metadata
import json
import os
import sys
from pathlib import Path

job_dir = Path(sys.argv[1]).resolve()
settings = json.loads((job_dir / "settings.json").read_text())
import torch
import boltz.main as upstream

if not torch.cuda.is_available():
    raise SystemExit("Boltz-2 requires the host GPU service; no silent CPU fallback")
base_trainer = upstream.Trainer


def fp32_trainer(*args, **kwargs):
    kwargs["precision"] = "32-true"
    return base_trainer(*args, **kwargs)


upstream.Trainer = fp32_trainer
(job_dir / "runtime.json").write_text(json.dumps({"version": importlib.metadata.version("boltz"), "device": "cuda", "gpu": torch.cuda.get_device_name(0), "precision": "32-true", "checkpoint": "boltz2_conf.ckpt", "compatibility_adapter": "Trainer precision override; upstream package unchanged"}))
upstream.cli(args=["predict", str(job_dir / "input.yaml"), "--out_dir", str(job_dir / "results"), "--cache", os.environ["BOLTZ_CACHE"], "--model", "boltz2", "--accelerator", "gpu", "--devices", "1", "--recycling_steps", str(settings["recycling_steps"]), "--sampling_steps", str(settings["sampling_steps"]), "--diffusion_samples", "1", "--max_parallel_samples", "1", "--output_format", "pdb", "--num_workers", "0", "--preprocessing-threads", "1", "--seed", str(settings["seed"]), "--no_kernels"], standalone_mode=False)
