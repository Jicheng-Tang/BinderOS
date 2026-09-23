# BinderOS

BinderOS is an evidence-first workflow for target discovery, structure/topology analysis, binding-site selection, binder design, computational triage, and experiment-ready handoff.

## Architecture

- The Sites Worker serves the web app and same-origin API.
- `/api/research` retrieves current evidence from Europe PMC and reviewed UniProt records. If `DEEPSEEK_API_KEY` is configured, DeepSeek converts that evidence into `binderos.target-report.v1`; without the key, the API returns an evidence-only report and makes no AI recommendation.
- `/api/models/jobs` forwards AlphaFold 3, DeepTMHMM2, and BindCraft jobs to the separate authenticated model gateway in `gateway/`.
- The model gateway runs on a Linux compute host. AlphaFold 3 should use its official container, model parameters, databases, and supported GPU configuration. The hosted website does not run GPU inference itself.

## Production environment

Set these on the Site, not in source control:

- `DEEPSEEK_API_KEY` (secret)
- `DEEPSEEK_BASE_URL=https://api.deepseek.com`
- `DEEPSEEK_MODEL=deepseek-flash`
- `MODEL_GATEWAY_URL=https://your-model-gateway.example`
- `MODEL_GATEWAY_TOKEN` (secret)

The model gateway uses the variables in `gateway/.env.example`.

## Model and protocol references

- [DeepSeek Responses API](https://api-docs.deepseek.com/api/create-response/)
- [AlphaFold 3 code, inputs, outputs and installation](https://github.com/google-deepmind/alphafold3)
- [DeepTMHMM2](https://github.com/fteufel/DeepTMHMM2)
- [BindCraft](https://github.com/martinpacesa/BindCraft)
- [ProteinMPNN](https://github.com/dauparas/ProteinMPNN)
- [RFdiffusion](https://github.com/RosettaCommons/RFdiffusion)

## Local checks

`npm run check` builds the Worker artifact, validates `default.fetch`, and tests report streaming, upstream failures, source validation and gateway status. Gateway tests: `cd gateway && python -m unittest test_gateway.py` (requires httpx).

## Current pilot: DeepSeek and a local DeepTMHMM2 server

Research supports an NDJSON response with progress and heartbeat events. Literature requests have a 15-second limit; DeepSeek has its own 90-second limit. The model returns only concise analysis, with original evidence and provenance attached by the server. Candidate identities and URLs are checked against retrieved records. There are no invented numerical evidence scores. Failed AI requests preserve retrieved evidence and explicitly report the failure. A report can correctly contain zero recommendations.

The local pilot only enables DeepTMHMM2, one job at a time, a maximum of four pending/running jobs and sequences up to 1000 residues. Jobs and results are saved outside the repository and can be reopened using the last job ID. Interrupted jobs are marked failed on restart. Segments use **1-based inclusive** positions. AlphaFold 3 and BindCraft are not installed by this pilot and are shown as unavailable.

Directory layout beside this checkout:

```
work/
  protein-binder-agent/  # this repository
  model-runtime/        # isolated Python environment
  deeptmhmm2/           # upstream source and checkpoints
  model-cache/          # ESM2 weights (~2.6 GB) and caches
  binderos-runtime/     # private gateway token, jobs, logs
```

DeepTMHMM2 source is pinned to `b05e27adf50738405e1de0b4a6b7072bb145fd3a`. Install its dependencies into the separate environment. The CUDA environment uses PyTorch 2.10.0 + CUDA 12.6; CPU installations can use PyTorch 2.10.0 + cpu. CUDA availability must be checked from the host system terminal, because a sandbox may not expose NVIDIA devices.

Start the GPU gateway from the host terminal with `bash gateway/start-gpu.sh`. It defaults to physical GPU 1; set `CUDA_VISIBLE_DEVICES=0` for the first GPU. The startup tests an actual CUDA tensor operation before serving HTTP. CPU mode: run `model-runtime/bin/python protein-binder-agent/gateway/run_local.py` from the parent directory.

The gateway listens only on `127.0.0.1:8765`; it requires a bearer token generated in `binderos-runtime/gateway-token.txt`. A Cloudflare quick tunnel forwards the hosted site's model requests to this port. Store that tunnel URL as `MODEL_GATEWAY_URL` and the token as the Site secret `MODEL_GATEWAY_TOKEN`, then redeploy. Never commit either token or model weights. The quick tunnel is for this private pilot: its URL changes when restarted, the computer and both processes must stay on, and it has no availability guarantee. Use a managed persistent endpoint for production.

The hosted website is private. Making it public requires per-user job authorization and quotas; do not expose the shared computation account without those controls.

Computational metrics are prioritization signals, not experimental validation. Every campaign should preserve source evidence, software/model versions, parameters, seeds, raw outputs, failures, and human approvals.
