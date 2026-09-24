import asyncio
import copy
import unittest
from types import SimpleNamespace
from gateway import benchmark as b
from gateway.model_adapters import validate_new_model


class BenchmarkTests(unittest.TestCase):
    def test_fixture_and_fixed_positions(self):
        manifest, pdb, seq = b.load_benchmark()
        self.assertEqual((len(seq['A']), len(seq['B'])), (76, 58))
        self.assertEqual(manifest['original_residue_numbers']['B'][0], 316)
        request = SimpleNamespace(model='proteinmpnn', parameters={'design_chains': ['B'], 'fixed_positions': {'B': [1, 58]}}, pdb_text=pdb, sequence=None, partner_sequence=None, sequences=None)
        self.assertEqual(validate_new_model(request)['fixed_chains'], ['A'])
        for invalid in ({'B': [59]}, {'A': [1]}, {'B': [True]}, {'B': [1, 1]}, {'B': list(range(1,59))}):
            request.parameters['fixed_positions'] = invalid
            with self.assertRaises(ValueError):
                validate_new_model(request)

    def test_conservative_selection_and_sequence_check(self):
        good = {'iptm': .8, 'binder_plddt': .9, 'contact_pairs': 10, 'clashing_pairs': 0}
        bad = {**good, 'iptm': .2, 'clashing_pairs': 1}
        c = {'evaluations': [{'metrics':good}, {'metrics':bad}]}
        self.assertFalse(b.passes(b.aggregate(c)))
        self.assertFalse(b.passes(None))
        self.assertEqual(b.rank([{'id':'failed','evaluations':[]}]), [])
        _, pdb, seq = b.load_benchmark()
        with self.assertRaises(ValueError):
            b.metrics({'structures':[{'pdb':pdb, 'confidence':{'iptm':.8}}]}, {**seq, 'B':'A'*58})

    def test_orchestration_with_explicitly_mocked_models(self):
        # Tests orchestration only. No result from this test is deployed as GPU output.
        _, pdb, seq = b.load_benchmark()
        campaign = {'id':'test', 'jobs':[]}
        calls = []
        async def invoke(label, request):
            calls.append((label, copy.deepcopy(request)))
            if request['model'] == 'deeptmhmm2':
                result = {'predictions':[]}
            elif request['model'] == 'proteinmpnn':
                base = b.sequences(request['pdb_text'])['B']
                mutable = [n for n in range(1,59) if n not in request['parameters']['fixed_positions']['B']]
                pos = mutable[0]-1
                choices = [aa for aa in 'ACDEFGHIKLMNPQRSTVWY' if aa != base[pos]]
                result = {'designs':[{'sequence':base[:pos]+aa+base[pos+1:], 'score':1.0} for aa in choices[:request['parameters']['num_sequences']]]}
            else:
                structure = b.parent_backbone(pdb, request['partner_sequence'])
                # Deliberately low confidence checks the no-qualified-candidates path.
                result = {'structures':[{'pdb':structure, 'confidence':{'iptm':.1}}]}
            return {'id':str(len(calls)), 'result':result}
        asyncio.run(b.run(campaign, invoke, lambda: None))
        self.assertEqual(campaign['outcome'], 'control_failed_inconclusive')
        self.assertFalse(campaign['control_passed'])
        self.assertEqual(campaign['selected_ids'], [])
        self.assertEqual(campaign['parent_selection']['mode'], 'exploratory_not_a_hit')
        self.assertTrue(any(label == 'round2_generation' for label, _ in calls))
        r2 = next(r for label, r in calls if label == 'round2_generation')
        self.assertGreater(len(r2['parameters']['fixed_positions']['B']), 40)
        parent = next(c for c in campaign['candidates'] if c['id']==campaign['parent_selection']['id'])
        self.assertEqual(b.sequences(r2['pdb_text'])['B'], parent['sequence'])
        self.assertEqual(b.sequences(r2['pdb_text'])['A'], seq['A'])
        self.assertEqual({e['seed'] for e in parent['evaluations']}, {11,29})

    def test_cancel_prevents_model_submission(self):
        async def invoke(*args):
            self.fail('Cancelled benchmark must not submit jobs')
        with self.assertRaisesRegex(RuntimeError, 'cancelled'):
            asyncio.run(b.run({'cancel_requested':True}, invoke, lambda:None))


if __name__ == '__main__':
    unittest.main()
