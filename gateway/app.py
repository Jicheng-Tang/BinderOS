from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, field_validator

app = FastAPI(title="BinderOS Model Gateway", version="0.2.0")
JOBS: dict[str, dict] = {}
JOB_ROOT = Path(os.getenv("BINDEROS_JOB_ROOT", "/tmp/binderos-jobs")).resolve()
JOB_ROOT.mkdir(parents=True, exist_ok=True)


class JobRequest(BaseModel):
    model: Literal["alphafold3", "deeptmhmm2", "bindcraft"]
    name: str = Field(default="binderos-job", min_length=1, max_length=80)
    sequence: str | None = None
    sequences: list[dict] | None = None
    seeds: list[int] = Field(default_factory=lambda: [1])
    parameters: dict = Field(default_factory=dict)

    @field_validator("sequence")
    @classmethod
    def validate_sequence(cls, value: str | None) -> str | None:
        if value is None:
            return value
        sequence = "".join(value.split()).upper()
        if not sequence or len(sequence) > 10_000 or any(aa not in "ACDEFGHIKLMNPQRSTVWYX" for aa in sequence):
            raise ValueError("sequence must contain 1-10000 amino-acid characters")
        return sequence


def authorize(authorization: str | None = Header(default=None)) -> None:
    expected = os.getenv("BINDEROS_GATEWAY_TOKEN")
    if not expected:
        raise HTTPException(status_code=503, detail="gateway token is not configured")
    supplied = authorization.removeprefix("Bearer ") if authorization else ""
    if not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_command(job_dir: Path, request: JobRequest) -> list[str]:
    if request.model == "deeptmhmm2":
        fasta = job_dir / "input.fasta"
        fasta.write_text(f">{request.name}\n{request.sequence}\n", encoding="utf-8")
        return [os.getenv("DEEPTMHMM_BIN", "dtm2"), str(fasta), str(job_dir / "results"), "--device", os.getenv("DEEPTMHMM_DEVICE", "cuda"), "--marginals"]

    if request.model == "alphafold3":
        entities = request.sequences or [{"protein": {"id": "A", "sequence": request.sequence}}]
        input_json = {"name": request.name, "modelSeeds": request.seeds, "sequences": entities, "dialect": "alphafold3", "version": 4}
        input_path = job_dir / "input.json"
        input_path.write_text(json.dumps(input_json), encoding="utf-8")
        return [sys.executable, os.getenv("ALPHAFOLD3_SCRIPT", "/opt/alphafold3/run_alphafold.py"), "--json_path", str(input_path), "--model_dir", os.getenv("ALPHAFOLD3_MODEL_DIR", "/opt/alphafold3/models"), "--db_dir", os.getenv("ALPHAFOLD3_DB_DIR", "/opt/alphafold3/databases"), "--output_dir", str(job_dir / "results")]

    preset = request.parameters.get("preset", "default")
    if preset != "default":
        raise ValueError("unsupported BindCraft preset")
    settings = os.getenv("BINDCRAFT_SETTINGS", "/opt/BindCraft/settings_target/default.json")
    filters = os.getenv("BINDCRAFT_FILTERS", "/opt/BindCraft/settings_filters/default_filters.json")
    advanced = os.getenv("BINDCRAFT_ADVANCED", "/opt/BindCraft/settings_advanced/default_4stage_multimer.json")
    return [os.getenv("BINDCRAFT_PYTHON", sys.executable), os.getenv("BINDCRAFT_SCRIPT", "/opt/BindCraft/bindcraft.py"), "--settings", settings, "--filters", filters, "--advanced", advanced]


def collect_result(job_dir: Path, model: str) -> dict:
    if model == "deeptmhmm2":
        path = job_dir / "results" / "predictions.json"
        return {"predictions": json.loads(path.read_text())} if path.exists() else {}
    if model == "alphafold3":
        summaries = list((job_dir / "results").rglob("*_summary_confidences.json"))
        return {"summary_confidences": [json.loads(path.read_text()) for path in summaries[:10]]}
    stats = list((job_dir / "results").rglob("final_design_stats.csv"))
    return {"result_files": [str(path.relative_to(job_dir)) for path in stats]}


async def run_job(job_id: str, request: JobRequest) -> None:
    job_dir = JOB_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=False)
    JOBS[job_id].update(status="running", started_at=now())
    try:
        command = build_command(job_dir, request)
        process = await asyncio.create_subprocess_exec(*command, cwd=job_dir, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        output, _ = await process.communicate()
        log = output.decode("utf-8", errors="replace")[-20_000:]
        (job_dir / "job.log").write_text(log, encoding="utf-8")
        if process.returncode != 0:
            raise RuntimeError(f"model exited with code {process.returncode}")
        JOBS[job_id].update(status="succeeded", finished_at=now(), result=collect_result(job_dir, request.model))
    except Exception as error:
        JOBS[job_id].update(status="failed", finished_at=now(), error=str(error))


@app.get("/health")
async def health(_: None = Depends(authorize)) -> dict:
    return {"status": "ok", "models": ["alphafold3", "deeptmhmm2", "bindcraft"]}


@app.post("/v1/jobs", status_code=202)
async def create_job(request: JobRequest, background_tasks: BackgroundTasks, _: None = Depends(authorize)) -> dict:
    if not request.sequence and not request.sequences:
        raise HTTPException(status_code=422, detail="sequence or sequences is required")
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"id": job_id, "model": request.model, "name": request.name, "status": "queued", "created_at": now()}
    background_tasks.add_task(run_job, job_id, request)
    return JOBS[job_id]


@app.get("/v1/jobs/{job_id}")
async def get_job(job_id: str, _: None = Depends(authorize)) -> dict:
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="job not found")
    return JOBS[job_id]
