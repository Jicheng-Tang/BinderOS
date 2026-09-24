"""Fixed benign 1WR1 scaffold benchmark, not a general target-design endpoint.

The protocol is chosen before execution. No MSA, template or experimental pose is
sent to Boltz. Scores are computational diagnostics, never affinity estimates.
"""
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "benchmarks"
ID = "ubiquitin-dsk2-1wr1-v1"
AA3 = "ALA CYS ASP GLU PHE GLY HIS ILE LYS LEU MET ASN PRO GLN ARG SER THR VAL TRP TYR".split()
AA1 = "ACDEFGHIKLMNPQRSTVWY"
TO1 = dict(zip(AA3, AA1))
TO3 = dict(zip(AA1, AA3))
GATES = {"min_iptm": 0.5, "min_binder_plddt": 0.7, "min_contact_pairs": 5, "max_clashing_pairs": 0}


def atoms(pdb):
    output = []
    for line in pdb.splitlines():
        if line.startswith("ATOM  ") and line[76:78].strip() != "H":
            output.append({"chain": line[21], "position": int(line[22:26]), "residue": TO1[line[17:20]],
                           "atom": line[12:16].strip(), "xyz": tuple(float(line[i:i+8]) for i in (30, 38, 46)),
                           "bfactor": float(line[60:66]), "line": line})
    if not output:
        raise ValueError("No protein atoms in structure")
    return output


def sequences(pdb):
    chains = {}
    for atom in atoms(pdb):
        if atom["atom"] == "CA":
            chains.setdefault(atom["chain"], []).append(atom["residue"])
    return {chain: "".join(seq) for chain, seq in chains.items()}


def contacts(pdb):
    parsed = atoms(pdb)
    a = [x for x in parsed if x["chain"] == "A"]
    b = [x for x in parsed if x["chain"] == "B"]
    if not a or not b:
        raise ValueError("Both target A and binder B are required")
    pairs, clashes = set(), set()
    for x in a:
        for y in b:
            d2 = sum((u-v)**2 for u, v in zip(x["xyz"], y["xyz"]))
            if d2 < 4.5**2:
                pairs.add((x["position"], y["position"]))
            if d2 < 2.0**2:
                clashes.add((x["position"], y["position"]))
    return pairs, clashes


def load_benchmark():
    manifest = json.loads((ROOT / "1WR1.json").read_text())
    pdb = (ROOT / "1WR1.pdb").read_text()
    if hashlib.sha256(pdb.encode()).hexdigest() != manifest["prepared_sha256"]:
        raise ValueError("Benchmark checksum mismatch")
    seq = sequences(pdb)
    if len(seq.get("A", "")) != 76 or len(seq.get("B", "")) != 58:
        raise ValueError("Benchmark chain identity mismatch")
    return manifest, pdb, seq


def metrics(result, expected):
    structure = result["structures"][0]
    if sequences(structure["pdb"]) != expected:
        raise ValueError("Predicted chain sequences differ from submitted sequences")
    iptm = structure["confidence"].get("iptm")
    if not isinstance(iptm, (int, float)) or not math.isfinite(iptm) or not 0 <= iptm <= 1:
        raise ValueError("Missing/invalid two-chain ipTM")
    b = [x["bfactor"] / 100 for x in atoms(structure["pdb"]) if x["chain"] == "B" and x["atom"] == "CA"]
    if any(not math.isfinite(x) or not 0 <= x <= 1 for x in b):
        raise ValueError("Invalid binder pLDDT")
    pair, clash = contacts(structure["pdb"])
    return {"iptm": iptm, "binder_plddt": sum(b)/len(b), "contact_pairs": len(pair), "clashing_pairs": len(clash)}


def aggregate(candidate):
    runs = candidate.get("evaluations", [])
    if not runs:
        return None
    ms = [r["metrics"] for r in runs]
    return {"iptm": min(m["iptm"] for m in ms), "binder_plddt": min(m["binder_plddt"] for m in ms),
            "contact_pairs": min(m["contact_pairs"] for m in ms), "clashing_pairs": max(m["clashing_pairs"] for m in ms)}


def passes(m):
    return bool(m and m["iptm"] >= GATES["min_iptm"] and m["binder_plddt"] >= GATES["min_binder_plddt"] and m["contact_pairs"] >= GATES["min_contact_pairs"] and m["clashing_pairs"] <= GATES["max_clashing_pairs"])


def rank(candidates):
    candidates = [c for c in candidates if aggregate(c)]
    return sorted(candidates, key=lambda c: (not passes(aggregate(c)), aggregate(c)["clashing_pairs"] > 0,
                  -aggregate(c)["iptm"], -aggregate(c)["binder_plddt"], c.get("mpnn_score", math.inf), c["id"]))


def diverse(candidates, limit=2):
    selected = []
    for c in rank(candidates):
        if all(sum(a != b for a, b in zip(c["sequence"], s["sequence"])) >= 3 for s in selected):
            selected.append(c)
        if len(selected) >= limit:
            break
    return selected


def parent_backbone(pdb, sequence):
    # Only retain backbone atoms when changing residue identities; never relabel
    # existing side-chain coordinates as another amino acid.
    lines = []
    for atom in atoms(pdb):
        line = atom["line"]
        if atom["chain"] == "B":
            if atom["atom"] not in {"N", "CA", "C", "O"}:
                continue
            line = line[:17] + TO3[sequence[atom["position"]-1]] + line[20:]
        lines.append(line)
    return "\n".join(lines) + "\nEND\n"


async def run(campaign, invoke, save):
    """invoke(label, model request) returns a persisted real model job."""
    manifest, pdb, seq = load_benchmark()
    interface = sorted({b for _, b in contacts(pdb)[0]})
    campaign.update(benchmark=manifest, protocol={
        "version": ID, "round1_count": 4, "round2_count": 2, "parent_count": 1,
        "round1_temperature": 0.2, "round2_temperature": 0.1, "seeds": [11, 29],
        "gates": GATES, "fixed_interface_positions": interface,
        "selection": "Engineering gates, then clash flag, ipTM, binder pLDDT, MPNN score; final sequences differ at >=3 positions.",
        "gate_meaning": "Uncalibrated engineering checks, not experimentally validated binding thresholds.",
        "geometry": "Inter-chain heavy-atom residue pairs: contact <4.5 A; clash <2.0 A. pLDDT from Boltz CA B-factor /100.",
    }, candidates=[], warnings=[
        "已知实验骨架上的序列重设计，不是从零生成 binder 骨架。",
        "1WR1 是公开历史结构，可能存在模型训练数据重叠；此测试不证明泛化能力。",
        "Boltz-2 无 MSA、无模板，使用 3 recycles / 200 steps / 1 sample / FP32。",
        "pLDDT、ipTM 和几何检查不是亲和力、抑制能力、特异性或实验成功率。",
        "第二轮只是优化尝试；无改善时保留父代，不宣称优化成功。",
    ])
    def stage(name):
        if campaign.get("cancel_requested"):
            raise RuntimeError("cancelled_by_user")
        campaign["stage"] = name
        save()

    async def evaluate(c, seed, label):
        stage(label)
        job = await invoke(label, {"model": "boltz2", "sequence": seq["A"], "partner_sequence": c["sequence"], "parameters": {"seed": seed}})
        m = metrics(job["result"], {"A": seq["A"], "B": c["sequence"]})
        c.setdefault("evaluations", []).append({"job_id": job["id"], "seed": seed, "metrics": m})
        c.update(metrics=aggregate(c), preliminary_pass=passes(aggregate(c)))
        save()

    stage("target_topology")
    top = await invoke("target_topology", {"model": "deeptmhmm2", "sequence": seq["A"]})
    campaign["topology_job_id"] = top["id"]
    baseline = {"id": "native-control", "round": 0, "sequence": seq["B"], "parent_id": None}
    campaign["control"] = baseline
    await evaluate(baseline, 11, "native_control")
    await evaluate(baseline, 29, "native_control_confirmation")
    campaign["control_passed"] = passes(aggregate(baseline))
    if not campaign["control_passed"]:
        campaign["warnings"].append("已知结合的原始 UBA 对照未通过当前预测检查；评价体系未通过本样例校准。继续计算仅验证软件流程，不能交付合格候选。")
    save()

    async def generate(round_number, parent, fixed, input_pdb, seed, count, temperature):
        stage(f"round{round_number}_generation")
        job = await invoke(campaign["stage"], {"model": "proteinmpnn", "pdb_text": input_pdb,
                           "parameters": {"design_chains": ["B"], "fixed_positions": {"B": fixed},
                                          "num_sequences": count, "temperature": temperature, "seed": seed}})
        base = parent["sequence"] if parent else seq["B"]
        seen = {c["sequence"] for c in campaign["candidates"]} | {seq["B"]}
        created = []
        for i, design in enumerate(job["result"]["designs"], 1):
            sequence = design["sequence"]
            if len(sequence) != len(base) or set(sequence)-set(AA1) or any(sequence[n-1] != base[n-1] for n in fixed):
                raise ValueError("Generated sequence violates fixed positions or binder chain boundary")
            c = {"id": f"r{round_number}-{i}", "round": round_number, "sequence": sequence,
                 "parent_id": parent["id"] if parent else "native-control", "generation_job_id": job["id"],
                 "mpnn_score": design["score"], "fixed_positions": fixed, "duplicate": sequence in seen,
                 "mutations_from_parent": sum(a != b for a, b in zip(sequence, base)), "evaluations": []}
            campaign["candidates"].append(c)
            if not c["duplicate"]:
                created.append(c)
            seen.add(sequence)
        save()
        for c in created:
            await evaluate(c, 11, f"evaluate_{c['id']}")
        return created

    first = await generate(1, None, interface, pdb, 11, 4, 0.2)
    ordered = rank(first)
    if not ordered:
        campaign.update(outcome="no_unique_evaluable_candidates", selected_ids=[], stage="complete")
        save()
        return
    parent = ordered[0]
    campaign["parent_selection"] = {"id": parent["id"], "passed_gate": passes(aggregate(parent)),
                                    "mode": "qualified" if passes(aggregate(parent)) else "exploratory_not_a_hit"}
    # Keep interface plus three quarters of non-interface positions fixed in the
    # selected parent. The deterministic mutable subset is recorded, not hidden.
    mutable = [n for n in range(1, 59) if n not in interface][::4]
    fixed = [n for n in range(1, 59) if n not in mutable]
    children = await generate(2, parent, fixed, parent_backbone(pdb, parent["sequence"]), 29, 2, 0.1)
    finalist = diverse(first + children, 2)
    # Always re-evaluate the chosen parent and best child with the same seed for
    # a paired comparison, even if they were not selected by the global ranking.
    paired = [parent] + rank(children)[:1]
    confirm = {c["id"]: c for c in finalist + paired}
    for c in confirm.values():
        await evaluate(c, 29, f"confirm_{c['id']}")
    qualified = [c for c in confirm.values() if len(c["evaluations"]) == 2 and passes(aggregate(c))]
    selected = diverse(qualified, 2) if campaign["control_passed"] else []
    for c in campaign["candidates"]:
        c["selected"] = c in selected
        c["confirmed_pass"] = len(c["evaluations"]) == 2 and passes(aggregate(c))
    comparison = []
    for c in children:
        if len(c["evaluations"]) != 2:
            continue
        pm, cm = aggregate(parent), aggregate(c)
        comparison.append({"parent_id": parent["id"], "child_id": c["id"],
                           "delta_worst_seed_iptm": cm["iptm"]-pm["iptm"],
                           "delta_worst_seed_binder_plddt": cm["binder_plddt"]-pm["binder_plddt"],
                           "computational_improvement": passes(cm) and cm["iptm"] > pm["iptm"] and cm["binder_plddt"] >= pm["binder_plddt"] and cm["clashing_pairs"] <= pm["clashing_pairs"]})
    campaign.update(stage="complete", outcome="control_failed_inconclusive" if not campaign["control_passed"] else "computational_candidates" if selected else "no_candidates_passed",
                    selected_ids=[c["id"] for c in selected], optimization_comparison=comparison,
                    selected_fasta="".join(f">{c['id']}|computational_only|parent={c['parent_id']}\n{c['sequence']}\n" for c in selected))
    save()
