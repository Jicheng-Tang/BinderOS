import importlib
import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch


class GatewayTest(unittest.TestCase):
    def test_bounded_model_adapters(self):
        module = importlib.import_module("gateway.model_adapters" if __package__ else "model_adapters")
        request = SimpleNamespace(model="boltz2", parameters={}, sequence="A" * 76, partner_sequence=None, sequences=None, pdb_text=None)
        settings = module.validate_new_model(request)
        self.assertEqual(settings["msa_mode"], "single_sequence")
        self.assertEqual(settings["precision"], "32-true")
        request.sequence = "A" * 201
        with self.assertRaises(ValueError):
            module.validate_new_model(request)
        request.sequence = "A" * 76
        request.parameters = {"use_msa_server": True}
        with self.assertRaises(ValueError):
            module.validate_new_model(request)
        request.model = "proteinmpnn"
        request.sequence = None
        request.pdb_text = (Path(__file__).resolve().parents[1] / "public/examples/1UBQ.pdb").read_text()
        request.parameters = {"design_chains": ["A"], "num_sequences": 2}
        settings = module.validate_new_model(request)
        self.assertEqual(settings["residue_count"], 76)
        self.assertEqual(settings["fixed_chains"], [])
        request.parameters["design_chains"] = ["B"]
        with self.assertRaises(ValueError):
            module.validate_new_model(request)
        request.parameters = {"design_chains": ["A"], "num_sequences": 10000}
        with self.assertRaises(ValueError):
            module.validate_new_model(request)

    def test_auth_validation_and_output(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"BINDEROS_JOB_ROOT": directory, "BINDEROS_GATEWAY_TOKEN": "local-test-only"}):
                module = importlib.import_module("gateway.app" if __package__ else "app")
                from fastapi.testclient import TestClient
                client = TestClient(module.app)
                self.assertEqual(client.get("/health").status_code, 401)
                response = client.post("/v1/jobs", headers={"Authorization": "Bearer local-test-only"}, json={"model": "deeptmhmm2", "sequence": "not a valid protein!"})
                self.assertEqual(response.status_code, 422)
                result_dir = Path(directory) / "fixture" / "results"
                result_dir.mkdir(parents=True)
                (result_dir / "predictions.json").write_text(json.dumps([{"id": "fixture", "type": "Globular", "segments": [["Inside", 1, 12]]}, {"metadata": {"num_sequences": 1}}]))
                result = module.collect_result(result_dir.parent, "deeptmhmm2")
                self.assertEqual(result["predictions"][0]["segments"][0], {"name": "Inside", "start": 1, "end": 12})
                self.assertEqual(result["predictions"][0]["coordinate_system"], "1-based inclusive")
                self.assertEqual(len(result["predictions"]), 1)
                self.assertEqual(result["metadata"]["num_sequences"], 1)


if __name__ == "__main__":
    unittest.main()
