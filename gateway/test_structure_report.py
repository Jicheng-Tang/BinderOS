import asyncio
import importlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

from gateway.structure_report import analyze

SEQ='MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG'
PDB=(Path(__file__).resolve().parents[1]/'public/examples/1UBQ.pdb').read_text()


class StructureReportTest(unittest.TestCase):
    def test_idempotence_and_conflicting_retry(self):
        module=importlib.import_module('gateway.app')
        request=module.StructureRequest(sequence=SEQ,request_id='fixture-structure',lookup_atlas=False)
        with tempfile.TemporaryDirectory() as temp, patch.object(module,'REPORT_ROOT',Path(temp)), patch.object(module,'REPORTS',{}), patch.object(module,'JOBS',{}), patch.object(module,'available_models',lambda:['boltz2','deeptmhmm2']):
            tasks=BackgroundTasks()
            report=asyncio.run(module.create_structure_report(request,tasks))
            retry=asyncio.run(module.create_structure_report(request,tasks))
            self.assertEqual(report['id'],retry['id'])
            self.assertEqual(len(tasks.tasks),1)
            with self.assertRaises(HTTPException) as conflict:
                asyncio.run(module.create_structure_report(request.model_copy(update={'sequence':'G'+SEQ[1:]}),tasks))
            self.assertEqual(conflict.exception.status_code,409)
            with self.assertRaises(HTTPException) as busy:
                asyncio.run(module.create_structure_report(request.model_copy(update={'request_id':'another-request'}),tasks))
            self.assertEqual(busy.exception.status_code,429)
        with self.assertRaises(ValidationError):
            module.StructureRequest(sequence='A'*201,request_id='fixture-structure')

    def test_real_reference_coordinates_and_sasa(self):
        result=analyze(PDB, SEQ, predicted=False)
        self.assertEqual(result['residue_count'],76)
        self.assertIsNone(result['mean_plddt'])
        self.assertGreater(sum(r['sasa_angstrom2'] for r in result['residues']),0)
        self.assertTrue(result['sequence_verified'])
        with self.assertRaisesRegex(ValueError,'sequence_mismatch'):
            analyze(PDB,'G'+SEQ[1:])

    def test_atlas_b_factors_are_not_assumed_to_be_plddt(self):
        result=analyze(PDB,SEQ,True,confidence_scale_known=False)
        self.assertIsNone(result['mean_plddt'])
        self.assertEqual(result['low_confidence_regions'],[])

    def test_pipeline_failure_and_success_are_durable(self):
        module=importlib.import_module('gateway.app')
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);reports=root/'reports';reports.mkdir()
            async def fake_run(job_id, request):
                result={'predictions':[{'type':'Globular','segments':[]}],'provenance':{'device':'mock'}} if request.model=='deeptmhmm2' else {'structures':[{'pdb':PDB,'confidence':{}}],'provenance':{'device':'mock'}}
                module.JOBS[job_id].update(status='succeeded',result=result)
            with patch.object(module,'JOB_ROOT',root),patch.object(module,'REPORT_ROOT',reports),patch.object(module,'run_job',fake_run),patch.object(module,'JOBS',{}):
                record={'id':'a'*32,'sequence':SEQ,'lookup_atlas':False,'jobs':[]}
                asyncio.run(module.run_structure_report(record))
                self.assertEqual(record['status'],'succeeded')
                self.assertEqual(len(record['jobs']),2)
                self.assertTrue((reports/('a'*32+'.json')).exists())
                self.assertEqual(record['result']['source']['provenance']['device'],'mock')
                async def failure(*args):
                    raise RuntimeError('mock_gpu_failure')
                with patch.object(module,'run_job',failure):
                    failed={'id':'b'*32,'sequence':SEQ,'lookup_atlas':False,'jobs':[]}
                    asyncio.run(module.run_structure_report(failed))
                    self.assertEqual(failed['status'],'failed')


if __name__=='__main__':
    unittest.main()
