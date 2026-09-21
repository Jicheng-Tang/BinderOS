# Contributing to BinderOS

Use a short-lived branch and a pull request. Changes to model adapters, evaluation thresholds, evidence schemas, or ranking logic require:

1. A primary source or benchmark reference.
2. A reproducible test fixture with no private sequence or credential.
3. Before/after output in the standard schema.
4. Explicit notes on model version, license, hardware, random seeds, and failure modes.
5. Review by one software owner and one protein-design reviewer.

The quality gate rejects committed secrets, invalid Worker artifacts, broken standard schemas, and unreviewed changes to scientific thresholds. Never commit API keys, model weights, patient data, unpublished sequences, or licensed databases.
