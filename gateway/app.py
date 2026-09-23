from __future__ import annotations

import asyncio
import json
import os
import secrets
import shutil
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, field_validator
try:
    from .model_adapters import installed_models, validate_new_model, build_new_command, collect_new_result
except ImportError:
    from model_adapters import installed_models, validate_new_model, build_new_command, collect_new_result

app = FastAPI(title="BinderOS Model Gateway", version="0.3.0")
JOBS: dict[str, dict] = {}
JOB_ROOT = Path(os.getenv("BINDEROS_JOB_ROOT", "/tmp/binderos-jobs")).resolve()
JOB_ROOT.mkdir(parents=True, exist_ok=True)
ENABLED_MODELS = set(os.getenv("BINDEROS_ENABLED_MODELS", "deeptmhmm2").split(","))
RUN_LOCK = asyncio.Semaphore(1)
for record in JOB_ROOT.glob("*/status.json"):
    try:
        job = json.loads(record.read_text())
        if job["status"] in ("queued", "running"):
            job.update(status="failed", error="gateway_restarted: 请重新提交任务")
            record.write_text(json.dumps(job))
        JOBS[job["id"]] = job
    except (ValueError, KeyError):
        continue


def save_job(job_id: str) -> None:
    folder = JOB_ROOT / job_id
    folder.mkdir(exist_ok=True)
    temp = folder / "status.tmp"
    temp.write_text(json.dumps(JOBS[job_id], ensure_ascii=False))
    temp.replace(folder / "status.json")


def available_models() -> list[str]:
    available = []
    available.extend(model for model in installed_models() if model in ENABLED_MODELS)
    if "deeptmhmm2" in ENABLED_MODELS and shutil.which(os.getenv("DEEPTMHMM_BIN", "dtm2")):
        available.append("deeptmhmm2")
    for model, key in [("alphafold3", "ALPHAFOLD3_SCRIPT"), ("bindcraft", "BINDCRAFT_SCRIPT")]:
        if model in ENABLED_MODELS and os.getenv(key) and Path(os.environ[key]).is_file():
            available.append(model)
    return available


class JobRequest(BaseModel):
    model: Literal["alphafold3", "deeptmhmm2", "bindcraft", "proteinmpnn", "boltz2"]
    name: str = Field(default="binderos-job", min_length=1, max_length=80)
    sequence: str | None = None
    partner_sequence: str | None = None
    pdb_text: str | None = Field(default=None, max_length=500_000)
    sequences: list[dict] | None = None
    seeds: list[int] = Field(default_factory=lambda: [1])
    parameters: dict = Field(default_factory=dict)
    request_id: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9-]{8,80}$")

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return re.sub(r"[^A-Za-z0-9_.-]", "_", value)

    @field_validator("sequence", "partner_sequence")
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
    if request.model in ("proteinmpnn", "boltz2"):
        return build_new_command(job_dir, request)
    if request.model == "deeptmhmm2":
        fasta = job_dir / "input.fasta"
        fasta.write_text(f">{request.name}\n{request.sequence}\n", encoding="utf-8")
        command = [os.getenv("DEEPTMHMM_BIN", "dtm2"), str(fasta), str(job_dir / "results"), "--device", os.getenv("DEEPTMHMM_DEVICE", "cpu"), "--marginals", "--batch-size", "1"]
        if os.getenv("DEEPTMHMM_MODEL_DIR"):
            command.extend(["--model-dir", os.environ["DEEPTMHMM_MODEL_DIR"]])
        return command

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
    if model in ("proteinmpnn", "boltz2"):
        return collect_new_result(job_dir, model)
    if model == "deeptmhmm2":
        path = job_dir / "results" / "predictions.json"
        if not path.exists():
            raise RuntimeError("model_output_missing")
        records = json.loads(path.read_text())
        if not isinstance(records, list) or not records:
            raise RuntimeError("model_output_invalid")
        predictions = [record for record in records if isinstance(record, dict) and "id" in record and "type" in record]
        metadata = next((record["metadata"] for record in records if isinstance(record, dict) and "metadata" in record), {})
        if not predictions:
            raise RuntimeError("model_predictions_missing")
        for prediction in predictions:
            prediction["segments"] = [segment if isinstance(segment, dict) else {"name": segment[0], "start": segment[1], "end": segment[2]} for segment in prediction.get("segments", [])]
            prediction["coordinate_system"] = "1-based inclusive"
        return {"predictions": predictions, "metadata": metadata, "provenance": {"model": "DeepTMHMM2", "version": "0.1.0", "source_revision": os.getenv("DEEPTMHMM_REVISION", "unknown"), "device": os.getenv("DEEPTMHMM_DEVICE", "cpu"), "parameters": {"marginals": True, "batch_size": 1}}}
    if model == "alphafold3":
        summaries = list((job_dir / "results").rglob("*_summary_confidences.json"))
        return {"summary_confidences": [json.loads(path.read_text()) for path in summaries[:10]]}
    stats = list((job_dir / "results").rglob("final_design_stats.csv"))
    return {"result_files": [str(path.relative_to(job_dir)) for path in stats]}


async def run_job(job_id: str, request: JobRequest) -> None:
    async with RUN_LOCK:
        await execute_job(job_id, request)


async def execute_job(job_id: str, request: JobRequest) -> None:
    job_dir = JOB_ROOT / job_id
    JOBS[job_id].update(status="running", started_at=now())
    save_job(job_id)
    try:
        command = build_command(job_dir, request)
        with (job_dir / "job.log").open("w") as log:
            process = await asyncio.create_subprocess_exec(*command, cwd=job_dir, stdout=log, stderr=asyncio.subprocess.STDOUT)
            try:
                await asyncio.wait_for(process.wait(), timeout=int(os.getenv("BINDEROS_JOB_TIMEOUT", "1200")))
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
                raise RuntimeError("model_timeout: 计算超时，请缩短序列或检查本机日志")
        if process.returncode != 0:
            raise RuntimeError(f"model exited with code {process.returncode}")
        JOBS[job_id].update(status="succeeded", finished_at=now(), result=collect_result(job_dir, request.model))
    except Exception as error:
        JOBS[job_id].update(status="failed", finished_at=now(), error=str(error))
    finally:
        save_job(job_id)


@app.get("/health")
async def health(_: None = Depends(authorize)) -> dict:
    return {"status": "ok", "version": app.version, "models": available_models(), "device": os.getenv("DEEPTMHMM_DEVICE", "cpu"), "active_jobs": sum(j["status"] in ("queued", "running") for j in JOBS.values())}


@app.post("/v1/jobs", status_code=202)
async def create_job(request: JobRequest, background_tasks: BackgroundTasks, _: None = Depends(authorize)) -> dict:
    if not request.sequence and not request.sequences and not request.pdb_text:
        raise HTTPException(status_code=422, detail="sequence or sequences is required")
    if request.model not in available_models():
        raise HTTPException(status_code=503, detail="model_not_installed")
    if request.model in ("proteinmpnn", "boltz2"):
        try:
            validate_new_model(request)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from None
    if request.model == "deeptmhmm2" and (not request.sequence or len(request.sequence) > 1000 or request.sequences):
        raise HTTPException(status_code=422, detail="本机试运行仅接受单条 1–1000 aa 序列")
    if request.request_id:
        for job in JOBS.values():
            if job.get("request_id") == request.request_id:
                return job
    if sum(j["status"] in ("queued", "running") for j in JOBS.values()) >= 4:
        raise HTTPException(status_code=429, detail="本机队列已满，请稍后提交")
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"id": job_id, "request_id": request.request_id, "model": request.model, "name": request.name, "sequence_length": len(request.sequence or ""), "status": "queued", "created_at": now()}
    save_job(job_id)
    background_tasks.add_task(run_job, job_id, request)
    return JOBS[job_id]


@app.get("/v1/jobs/{job_id}")
async def get_job(job_id: str, _: None = Depends(authorize)) -> dict:
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="job not found")
    return JOBS[job_id]
