"""Bounded local adapters; no client-supplied commands, paths or remote MSAs."""
import json
import math
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
AA = set("ACDEFGHIKLMNPQRSTVWY")
RESIDUES = set("ALA ARG ASN ASP CYS GLN GLU GLY HIS ILE LEU LYS MET PHE PRO SER THR TRP TYR VAL".split())


def installed_models():
    available = []
    mpnn = Path(os.getenv("PROTEINMPNN_DIR", "/nonexistent"))
    if (mpnn / "protein_mpnn_run.py").is_file() and (mpnn / "vanilla_model_weights/v_48_020.pt").is_file():
        available.append("proteinmpnn")
    cache = Path(os.getenv("BOLTZ_CACHE", "/nonexistent"))
    if Path(os.getenv("BOLTZ_PYTHON", "/nonexistent")).is_file() and all((cache / name).exists() for name in ["boltz2_conf.ckpt", "boltz2_aff.ckpt", "mols"]):
        available.append("boltz2")
    return available


def bounded_int(value, default, low, high, name):
    value = default if value is None else value
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{name} must be an integer from {low} to {high}")
    return value


def validate_new_model(request):
    p = request.parameters
    seed = bounded_int(p.get("seed"), 1, 1, 2147483647, "seed")
    if request.model == "boltz2":
        if set(p) - {"seed"}:
            raise ValueError("Boltz-2 pilot uses a fixed, recorded preset; remote MSA is disabled")
        chains = [request.sequence, request.partner_sequence] if request.partner_sequence else [request.sequence]
        if request.sequences or request.pdb_text or any(not s or set(s) - AA for s in chains):
            raise ValueError("Boltz-2 accepts one or two canonical protein sequences")
        if not 10 <= sum(map(len, chains)) <= 200:
            raise ValueError("11 GB GPU pilot: total length must be 10–200 residues")
        return {"seed": seed, "chains": chains, "msa_mode": "single_sequence", "recycling_steps": 3, "sampling_steps": 200, "diffusion_samples": 1, "precision": "32-true", "kernels": False}
    if request.model != "proteinmpnn":
        raise ValueError("unsupported adapter")
    if set(p) - {"seed", "num_sequences", "temperature", "design_chains", "fixed_positions"}:
        raise ValueError("unsupported ProteinMPNN parameters")
    if request.sequence or request.partner_sequence or request.sequences:
        raise ValueError("ProteinMPNN requires a PDB backbone, not a sequence")
    count = bounded_int(p.get("num_sequences"), 4, 1, 16, "num_sequences")
    temperature = p.get("temperature", 0.1)
    if type(temperature) not in (float, int) or temperature not in (0.1, 0.15, 0.2, 0.25, 0.3):
        raise ValueError("temperature must be 0.1, 0.15, 0.2, 0.25 or 0.3")
    design_chains = p.get("design_chains")
    if not isinstance(design_chains, list) or not design_chains or any(not isinstance(c, str) or not re.fullmatch(r"[A-Za-z0-9]", c) for c in design_chains) or len(set(design_chains)) != len(design_chains):
        raise ValueError("Explicit unique design_chains are required; all other chains stay fixed")
    text = request.pdb_text or ""
    residues = {}
    models = 0
    atoms = []
    for line in text.splitlines():
        if line.startswith("MODEL "):
            models += 1
        if not line.startswith("ATOM  "):
            continue
        if len(line) < 54 or line[16] not in (" ", "A"):
            raise ValueError("PDB must contain complete ATOM records without alternate conformers")
        chain, resid, resname, atom = line[21], line[22:27], line[17:20], line[12:16].strip()
        if not re.fullmatch(r"[A-Za-z0-9]", chain) or resname not in RESIDUES:
            raise ValueError("PDB requires named chains and canonical amino acids")
        if line[26] != " " or not re.fullmatch(r" *[0-9]+", line[22:26]):
            raise ValueError("PDB insertion codes/negative residue numbers are not supported in this pilot")
        try:
            if not all(math.isfinite(float(line[i:i + 8])) for i in (30, 38, 46)):
                raise ValueError()
        except ValueError:
            raise ValueError("PDB coordinates must be finite numbers") from None
        key = (chain, resid)
        if key not in residues:
            residues[key] = set()
        if atom in residues[key]:
            raise ValueError("Duplicate atom or multiple-model PDB not supported")
        residues[key].add(atom)
        atoms.append(line)
    if models > 1 or not 10 <= len(residues) <= 500:
        raise ValueError("ProteinMPNN pilot requires one PDB model with 10–500 residues")
    if any(not {"N", "CA", "C", "O"} <= atoms for atoms in residues.values()):
        raise ValueError("Each residue must contain N, CA, C and O backbone atoms")
    chains = sorted({c for c, _ in residues})
    if not set(design_chains) <= set(chains):
        raise ValueError("Selected design chain does not exist in the PDB")
    # MPNN fills residue-number gaps with X; reject gaps instead of silently changing length.
    for chain in chains:
        numbers = sorted(int(resid[:4]) for c, resid in residues if c == chain)
        if numbers != list(range(numbers[0], numbers[-1] + 1)):
            raise ValueError("PDB residue-number gaps must be resolved before sequence design")
    fixed = p.get("fixed_positions", {})
    if not isinstance(fixed, dict) or set(fixed) - set(design_chains):
        raise ValueError("fixed_positions must map design chains to 1-based sequence positions")
    for chain, positions in fixed.items():
        length = sum(c == chain for c, _ in residues)
        if not isinstance(positions, list) or any(type(n) is not int or not 1 <= n <= length for n in positions) or len(set(positions)) != len(positions) or len(positions) == length:
            raise ValueError("Invalid fixed positions (1-based sequence order, not PDB residue numbers)")
    return {"seed": seed, "num_sequences": count, "temperature": temperature, "design_chains": design_chains, "fixed_positions": fixed, "fixed_chains": sorted(set(chains) - set(design_chains)), "model_name": "v_48_020", "batch_size": 1, "pdb": "\n".join(atoms) + "\nEND\n", "residue_count": len(residues)}


def build_new_command(job_dir, request):
    settings = validate_new_model(request)
    if request.model == "proteinmpnn":
        (job_dir / "input.pdb").write_text(settings.pop("pdb"))
        command = [sys.executable, str(ROOT / "run_mpnn.py"), str(job_dir)]
    else:
        entries = [{"protein": {"id": chr(65 + i), "sequence": s, "msa": "empty"}} for i, s in enumerate(settings["chains"])]
        # JSON is valid YAML; input schema is constructed here, never passed through from the client.
        (job_dir / "input.yaml").write_text(json.dumps({"version": 1, "sequences": entries}))
        command = [os.environ["BOLTZ_PYTHON"], str(ROOT / "run_boltz.py"), str(job_dir)]
    (job_dir / "settings.json").write_text(json.dumps(settings))
    return command


def finite_json(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: finite_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [finite_json(item) for item in value]
    return value


def collect_new_result(job_dir, model):
    settings = json.loads((job_dir / "settings.json").read_text())
    runtime = json.loads((job_dir / "runtime.json").read_text())
    result = {"provenance": {"model": model, **runtime, "parameters": settings}}
    if model == "proteinmpnn":
        path = job_dir / "results/seqs/input.fa"
        lines = path.read_text().splitlines()
        entries = []
        for line in lines:
            if line.startswith(">"):
                entries.append({"header": line[1:], "sequence": ""})
            elif entries:
                entries[-1]["sequence"] += line.strip()
        designs = []
        for item in entries:
            if not item["header"].startswith("T="):
                continue
            fields = dict(re.findall(r"(score|global_score|seq_recovery|sample)=([0-9.eE+-]+)", item["header"]))
            designs.append({**item, **{k: float(v) for k, v in fields.items()}})
        if len(designs) != settings["num_sequences"] or any(not d["sequence"] for d in designs):
            raise RuntimeError("ProteinMPNN output is incomplete")
        result.update(designs=designs, fasta=path.read_text(), warnings=["给定骨架的序列设计，不是从零设计 binder。", "score 是模型负对数概率，越低越符合该模型；不是结合亲和力或实验成功率。", "未指定为设计链的链保持固定；设计链内仅 fixed_positions 指定的位置固定。"])
    else:
        paths = sorted((job_dir / "results").rglob("input_model_*.pdb"))
        structures = []
        for path in paths:
            confidence = path.with_name("confidence_" + path.stem + ".json")
            if not confidence.is_file() or not path.stat().st_size:
                raise RuntimeError("Boltz structure or confidence output is missing")
            structures.append({"filename": path.name, "pdb": path.read_text(), "confidence": finite_json(json.loads(confidence.read_text()))})
        if len(structures) != settings["diffusion_samples"]:
            raise RuntimeError("Boltz prediction missing (check local log for GPU memory errors)")
        result.update(structures=structures, warnings=["当前为无 MSA 的单序列模式，准确性可能降低；不向外部 MSA 服务发送序列。", "FP32 兼容模式、3 recycles / 200 steps / 1 sample；仅限短蛋白联调，不代表完整候选筛选。", "pLDDT/pTM/ipTM 是结构置信度，不是蛋白 binder 的亲和力；单链 ipTM 不适用。"])
    return result
