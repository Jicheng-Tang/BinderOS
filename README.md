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

`npm run check` builds the Worker artifact and validates that it exports `default.fetch`.

Computational metrics are prioritization signals, not experimental validation. Every campaign should preserve source evidence, software/model versions, parameters, seeds, raw outputs, failures, and human approvals.
