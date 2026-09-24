# BinderOS

BinderOS is an evidence-first workflow for target discovery, structure/topology analysis, binding-site selection, binder design, computational triage, and experiment-ready handoff.

## Architecture

- The Sites Worker serves the web app and same-origin API.
- `/api/research` retrieves current evidence from Europe PMC and reviewed UniProt records. If `DEEPSEEK_API_KEY` is configured, DeepSeek converts that evidence into `binderos.target-report.v1`; without the key, the API returns an evidence-only report and makes no AI recommendation.
- `/api/models/jobs` forwards validated jobs to the separate authenticated model gateway in `gateway/`. The local deployment supports DeepTMHMM2, ProteinMPNN and a bounded Boltz-2 adapter; AlphaFold 3 and BindCraft remain unavailable.
- `/api/structures/atlas` retrieves exact-sequence Biohub ESM Atlas records without on-demand folding or inference credentials. It distinguishes missing records, missing structures, and verified PDBs; model feature labels are not functional-site conclusions. See [Biohub integration review](docs/biohub-integration.md).
- The model gateway runs on a Linux compute host. AlphaFold 3 should use its official container, model parameters, databases, and supported GPU configuration. The hosted website does not run GPU inference itself.

## Production environment

Set these on the Site, not in source control:

- `DEEPSEEK_API_KEY` (secret)
- `DEEPSEEK_BASE_URL=https://api.deepseek.com`
- `DEEPSEEK_MODEL=deepseek-flash`
- `MODEL_GATEWAY_URL=https://your-model-gateway.example`
- `MODEL_GATEWAY_TOKEN` (secret)
- `BIOHUB_API_KEY` (secret; reserved for separately authorized inference, not required for Atlas lookup)

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

The local pilot runs one model job at a time across all models, with a maximum of four pending/running jobs. DeepTMHMM2 accepts sequences up to 1000 residues. Jobs and results are saved outside the repository and can be reopened using the last job ID. Interrupted jobs are marked failed on restart. Topology segments use **1-based inclusive** positions. AlphaFold 3 and BindCraft are not installed by this pilot and are shown as unavailable.

## Real benign benchmark loop (gateway 0.4.0)

**End-to-end run verified on 2026-09-24:** campaign `283d671cfd524830ab409c5f089aa872` was submitted through the private website API, completed on the host GPU in 421.539 seconds, and was retrieved through the website API. All 14 child jobs succeeded on CUDA: 1 DeepTMHMM2, 2 ProteinMPNN and 11 Boltz-2 predictions. Four first-round and two second-round sequences were generated. Raw outputs were checked for target/binder identity, fixed positions, seeds and parent lineage. The outcome was `control_failed_inconclusive`, with **zero qualified deliveries** because the known native control failed the predeclared checks. The paired second-round child did not improve over its parent (worst-seed ipTM delta -0.013957, binder pLDDT delta -0.016950). This demonstrates software-loop completion, **not a successful binder discovery or experimentally verified optimization**. A private link with `?benchmark=<32-character-job-id>` restores the existing run without starting new GPU work.

Stage 3 now separates a real **fixed 1WR1 ubiquitin–DSK2 UBA scaffold benchmark** from the collapsed old simulation. Both proteins are from *Saccharomyces cerevisiae*. This is **sequence redesign on a known experimental binder backbone**, not de novo backbone generation and not evidence of successful binding. No arbitrary target or sequence is accepted by the benchmark endpoint.

The preset runs target topology, a native UBA Boltz-2 control, four ProteinMPNN sequence designs, Boltz-2 two-chain evaluations, one-parent/two-child local redesign, and second-seed confirmation. It records original-to-prepared residue numbering, input checksum, model job IDs, seeds, fixed positions, duplicate sequences, parent–child relationships, evaluation metrics and failures. First-round interface residues are fixed; second-round design retains the parent sequence except a recorded subset of non-interface positions. Target chain A is never redesigned. ProteinMPNN `fixed_positions` use 1-based chain sequence order, not original PDB numbering.

Engineering gates are predeclared: ipTM >=0.5, mean binder CA pLDDT >=0.7, >=5 inter-chain heavy-atom contact residue pairs (<4.5 A), and zero severe clashing residue pairs (<2.0 A). These gates are **uncalibrated software-screening criteria**, not experimentally established binding thresholds. Final selection uses conservative values across seeds and >=3 residue differences between sequences. It can return zero candidates. If the first-round parent fails the gates, round two is explicitly exploratory; it is not labeled a hit. Computational improvement requires increased worst-seed ipTM without worsened worst-seed binder pLDDT or clashes, and does not establish improved affinity. The report retains parents even when children do not improve.

Boltz receives sequences only, with no MSA or experimental template. Public 1WR1 can overlap model training data; this benchmark verifies software wiring, not generalization. No binding-affinity, specificity, expression, aggregation, stability or experimental-success claim is made. At most two computational candidates are delivered in this small pilot, not 10–15 validated binders.

Endpoints: `POST /api/benchmarks` accepts only `{benchmark_id:"ubiquitin-dsk2-1wr1-v1",request_id:"unique-request-id"}`; `GET /api/benchmarks/<id>` restores progress; `POST /api/benchmarks/<id>/cancel` stops after the active model finishes. One campaign at a time, shared serial GPU queue, per-model timeout, durable local reports, no automatic restart of interrupted computation. Repeated request IDs do not launch duplicates. Private Sites access and server-side gateway authentication remain unchanged. The host service must be restarted after gateway changes.

Fixture preparation: download the [official 1WR1 PDB](https://files.rcsb.org/download/1WR1.pdb), then run `node scripts/prepare-benchmark.mjs /absolute/path/to/1WR1.pdb`. Only the first NMR conformer is used; all 76 target and 58 binder residues are retained. Inputs and source hashes are checked into `gateway/benchmarks/`. The scientific source is [RCSB 1WR1](https://www.rcsb.org/structure/1WR1), associated with DOI 10.1016/j.str.2005.01.011.

Validation: `npm run check` and `python -m unittest gateway/test_gateway.py gateway/test_benchmark.py`. Orchestration unit tests explicitly mock models and **must never be presented as real GPU runs**. Actual run status must be read from the gateway campaign and child-job records. On 2026-09-24, real CPU ProteinMPNN generated four 58-aa sequences with all fixed positions verified. A real RTX 2080 Ti Boltz-2 native-control job (`8d804e6309d64ceea2a705de7c8fc2e5`, seed 11) completed in about 38 seconds but produced ipTM 0.2697, mean binder pLDDT 0.6151, 46 contact residue pairs and 1 severe clashing residue pair: **the known binder control failed the preset checks**. This is not evidence that the experimental complex does not bind; the current single-sequence prediction configuration has not demonstrated reliable benchmark recovery. The campaign now confirms the native control with a second seed and suppresses qualified delivery whenever conservative control checks fail. Candidate computations may continue solely to exercise the software loop. Full website/GPU campaign verification still requires loading gateway 0.4.0 and completing a campaign.

## Additional local models

| Model | Input and current bounds | Output and limitations |
| --- | --- | --- |
| ProteinMPNN | PDB with complete backbone, standard residues, named chains and continuous numbering; 10–500 residues; explicit design chains; 1–16 sequences; temperature 0.1–0.3 | FASTA and negative-log-probability scores. Non-design chains are fixed; all residues in design chains may change. Requires an existing backbone; not a binder-generation pipeline or affinity predictor. |
| Boltz-2 | One or two protein sequences, 10–200 residues total; seed 1 by default | PDB and raw confidence JSON. Single-sequence/no-MSA pilot, 3 recycles, 200 sampling steps, one sample, no custom kernels. FP32 compatibility wrapper for RTX 2080 Ti; not the upstream default precision. Length caps are pilot limits, not guaranteed memory bounds. |

ProteinMPNN is pinned to upstream `8907e6671bfbfc92303b5f79c4b5e6ce47cdef57` with vanilla `v_48_020` weights (MIT). Clone the official repository into `work/proteinmpnn`; it uses the dedicated `model-runtime` environment without extra dependencies. Runtime logs record whether CUDA actually ran.

Boltz uses the existing **2.1.1** environment at `/home/hy/miniconda3/envs/boltz/bin/python`; it is not upgraded or edited. Configure `BOLTZ_PYTHON` for another installation. `work/model-cache/boltz` references the existing `boltz2_conf.ckpt`, `boltz2_aff.ckpt` and `mols` resources under `/home/hy/.boltz`, avoiding duplicate downloads. Boltz code and weights are MIT licensed. A per-process wrapper overrides Trainer precision to `32-true` and disables custom kernels; it fails explicitly without a GPU. Other computers must configure their own environment and weight locations.

No sequence is sent to a remote MSA service. Boltz authors warn that single-sequence mode may reduce accuracy; this pilot is for deployment verification and preliminary exploration, not final candidate selection. pLDDT/pTM/ipTM are confidence metrics, not protein-binder affinities. Single-chain ipTM is not meaningful. Raw PDB/FASTA and JSON are downloadable from the website; source/weights, parameters and actual device are recorded.

Use “载入公开泛素联调样例” for the public [RCSB 1UBQ](https://www.rcsb.org/structure/1UBQ) smoke-test structure and its 76-aa sequence. These are deployment tests, not validated new binders. After changing gateway code, restart the host-terminal service so new adapters load. Existing jobs are kept outside Git.

Sources: [ProteinMPNN](https://github.com/dauparas/ProteinMPNN), [Boltz installation/license](https://github.com/jwohlwend/boltz), [Boltz input/output documentation](https://github.com/jwohlwend/boltz/blob/main/docs/prediction.md). For BindCraft, the authors recommend at least 32 GB GPU memory; separate GPUs do not combine for one job, and PyRosetta licensing must be checked before use. See [BindCraft hardware guidance](https://github.com/martinpacesa/BindCraft/wiki/De-novo-binder-design-with-BindCraft). AlphaFold 3 requires its separately obtained model parameters and supported hardware; no AF3 weight authorization is assumed.

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
