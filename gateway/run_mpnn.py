"""Run the pinned official ProteinMPNN script in the dedicated model runtime."""
import json
import os
import runpy
import sys
from pathlib import Path
import torch

job_dir = Path(sys.argv[1]).resolve()
settings = json.loads((job_dir / "settings.json").read_text())
source = Path(os.environ["PROTEINMPNN_DIR"])
device = "cuda" if torch.cuda.is_available() else "cpu"
if os.getenv("DEEPTMHMM_DEVICE", "cpu").startswith("cuda") and device != "cuda":
    raise SystemExit("GPU gateway requested CUDA, but ProteinMPNN cannot access it")
(job_dir / "runtime.json").write_text(json.dumps({"device": device, "gpu": torch.cuda.get_device_name(0) if device == "cuda" else None, "source_revision": os.environ["PROTEINMPNN_REVISION"], "torch_version": torch.__version__}))
sys.path.insert(0, str(source))
sys.argv = [str(source / "protein_mpnn_run.py"), "--pdb_path", str(job_dir / "input.pdb"), "--pdb_path_chains", " ".join(settings["design_chains"]), "--out_folder", str(job_dir / "results"), "--num_seq_per_target", str(settings["num_sequences"]), "--sampling_temp", str(settings["temperature"]), "--seed", str(settings["seed"]), "--batch_size", "1", "--max_length", "500", "--model_name", "v_48_020"]
runpy.run_path(str(source / "protein_mpnn_run.py"), run_name="__main__")
