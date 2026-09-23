import importlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class GatewayTest(unittest.TestCase):
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
