import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';

const protein = { primaryAccession: 'PTEST', genes: [{ geneName: { value: 'TEST' } }], proteinDescription: { recommendedName: { fullName: { value: 'Test protein' } } } };
const candidate = { symbol: 'TEST', rationale: 'Limited evidence', structural_accessibility: 'Unknown', risks: ['Not validated'], sources: ['https://www.uniprot.org/uniprotkb/PTEST/entry'] };
function mockFetch(mode) {
  return async (url, init) => {
    if (url.includes('europepmc')) return Response.json({ resultList: { result: [{ pmid: '123', title: 'Test evidence' }] } });
    if (url.includes('uniprot')) return Response.json({ results: [protein] });
    assert.ok(init.signal);
    assert.equal(JSON.parse(init.body).reasoning.effort, 'none');
    if (mode === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
    const output = { summary: 'Evidence summary', candidates: [{ ...candidate, sources: mode === 'fake' ? ['https://invented.example'] : candidate.sources }], caveats: ['Research only'] };
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
  };
}
for (const mode of ['valid', 'fake', 'timeout']) {
  test(`research streaming: ${mode}`, async t => {
    t.mock.method(globalThis, 'fetch', mockFetch(mode));
    const r = await worker.fetch(new Request('http://test/api/research', { method: 'POST', headers: { accept: 'application/x-ndjson' }, body: JSON.stringify({ species: 'Homo sapiens', topic: 'immune regulation' }) }), { DEEPSEEK_API_KEY: 'test-placeholder' }, { waitUntil() {} });
    const events = (await r.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events[0].type, 'progress');
    const report = events.at(-1).report;
    assert.equal(report.status, mode === 'valid' ? 'ai_synthesized' : 'evidence_only');
    assert.equal(report.candidates[0].evidence_strength, null);
    if (mode !== 'valid') assert.ok(report.ai_error);
    if (mode === 'fake') assert.equal(report.ai_error, 'deepseek_unverified_evidence');
  });
}
test('missing gateway is explicit', async () => {
  const r = await worker.fetch(new Request('http://test/api/models/jobs', { method: 'POST' }), {});
  assert.equal(r.status, 503);
});
test('benchmark proxy is fixed-target, authenticated, and resumable', async t => {
  const env={MODEL_GATEWAY_URL:'https://gateway.example', MODEL_GATEWAY_TOKEN:'test-token'};
  let count=0;
  t.mock.method(globalThis, 'fetch', async (url, init)=>{
    count++; assert.equal(url,'https://gateway.example/v1/benchmarks');
    assert.equal(init.headers.authorization,'Bearer test-token');
    assert.equal(JSON.parse(init.body).benchmark_id,'ubiquitin-dsk2-1wr1-v1');
    return Response.json({id:'a'.repeat(32),status:'queued'},{status:202});
  });
  const payload={benchmark_id:'ubiquitin-dsk2-1wr1-v1',request_id:'fixture-1234'};
  let r=await worker.fetch(new Request('http://test/api/benchmarks',{method:'POST',body:JSON.stringify(payload)}),env);
  assert.equal(r.status,202);
  r=await worker.fetch(new Request('http://test/api/benchmarks',{method:'POST',body:JSON.stringify({...payload,sequence:'AAAA'})}),env);
  assert.equal(r.status,400); assert.equal(count,1);
  r=await worker.fetch(new Request('http://test/api/benchmarks/not-a-job'),env);
  assert.equal(r.status,400);
});
test('ProteinMPNN PDB requests reach the authenticated gateway', async t => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://gateway.example/v1/jobs');
    assert.equal(init.headers.authorization, 'Bearer test-token');
    assert.equal(JSON.parse(init.body).pdb_text, 'fixture');
    return Response.json({ id: 'job-fixture', status: 'queued' }, { status: 202 });
  });
  const r = await worker.fetch(new Request('http://test/api/models/jobs', { method: 'POST', body: JSON.stringify({ model: 'proteinmpnn', pdb_text: 'fixture', parameters: { design_chains: ['A'] } }) }), { MODEL_GATEWAY_URL: 'https://gateway.example', MODEL_GATEWAY_TOKEN: 'test-token' });
  assert.equal(r.status, 202);
});
test('public benchmark includes actual structure and sequence', async () => {
  const r = await worker.fetch(new Request('http://test/api/models/example'), {});
  const sample = await r.json();
  assert.equal(sample.sequence.length, 76);
  assert.ok(sample.pdb_text.includes('ATOM'));
});
test('evidence retry and partial-source warning', async t => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('europepmc')) { attempts++; throw new Error('upstream_503'); }
    return Response.json({ results: [protein] });
  });
  const r = await worker.fetch(new Request('http://test/api/research', { method: 'POST', body: JSON.stringify({ species: 'Homo sapiens' }) }), {});
  const report = await r.json();
  assert.equal(attempts, 2);
  assert.equal(report.source_errors.europe_pmc, 'upstream_503');
  assert.ok(report.caveats.some(value => value.includes('请求失败')));
});
test('health does not advertise uninstalled models', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'ok', models: ['deeptmhmm2'], device: 'cpu' }));
  const r = await worker.fetch(new Request('http://test/api/health'), { MODEL_GATEWAY_URL: 'https://gateway.example' });
  const j = await r.json();
  assert.deepEqual(j.services.model_gateway.models, ['deeptmhmm2']);
  assert.equal(j.services.model_gateway.online, true);
});
