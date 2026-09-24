import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
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
  assert.equal(j.services.biohub.inference_enabled, false);
});

const atlasSeq='MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG';
test('database lookup accepts a >200 aa exact structure, new AFDB fields, and rejects arbitrary hosts',async t=>{
  const seq=atlasSeq.repeat(3),base=readFileSync(new URL('../public/examples/1UBQ.pdb',import.meta.url),'utf8').split('\n').filter(l=>l.startsWith('ATOM  '));
  const pdb=[0,1,2].flatMap(copy=>base.map(l=>l.slice(0,22)+String(Number(l.slice(22,26))+copy*76).padStart(4)+l.slice(26))).join('\n');
  let bad=false,downloads=0;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(init.redirect,'manual');assert.equal(init.headers.authorization,undefined);
    if(url.startsWith('https://rest.uniprot.org/'))return Response.json({primaryAccession:'P42212',sequence:{value:seq,length:seq.length}});
    if(url.includes('/api/prediction/'))return Response.json([{sequence:seq,sequenceStart:1,sequenceEnd:228,modelEntityId:'AF-P42212-F1',pdbUrl:bad?'https://untrusted.example/file.pdb':'https://alphafold.ebi.ac.uk/files/fixture.pdb'}]);
    if(url.startsWith('https://alphafold.ebi.ac.uk/files/')){downloads++;return new Response(pdb);}
    if(url.startsWith('https://biohub.ai/'))return new Response(null,{status:404});
    throw Error('unexpected_host');
  });
  const request=()=>new Request('http://test/api/structures/existing',{method:'POST',body:JSON.stringify({accession:'P42212'})});
  let j=await(await worker.fetch(request(),{})).json();assert.equal(j.status,'structure_available');assert.equal(j.analysis.residue_count,228);assert.equal(j.new_prediction,false);
  bad=true;j=await(await worker.fetch(request(),{})).json();assert.equal(j.status,'lookup_incomplete');assert.equal(downloads,1);assert.ok(!j.pdb_text);
});
test('database search preserves identity choices and rejects malformed queries',async t=>{
  t.mock.method(globalThis,'fetch',async(url)=>{assert.ok(url.startsWith('https://rest.uniprot.org/uniprotkb/search?'));return Response.json({results:[{primaryAccession:'P42212',proteinDescription:{recommendedName:{fullName:{value:'GFP'}}},organism:{scientificName:'Aequorea victoria'},sequence:{length:238}}]});});
  const req=body=>new Request('http://test/api/structures/search',{method:'POST',body:JSON.stringify(body)});
  let j=await(await worker.fetch(req({query:'GFP'}),{})).json();assert.equal(j.candidates[0].organism,'Aequorea victoria');assert.equal(j.candidates[0].length,238);
  assert.equal((await worker.fetch(req({query:'A'.repeat(121)}),{})).status,400);
});
test('raw sequence resolves Atlas UniParc to an exact AlphaFold structure via official fallback',async t=>{
  const pdb=readFileSync(new URL('../public/examples/1UBQ.pdb',import.meta.url),'utf8');let mismatched=false;
  t.mock.method(globalThis,'fetch',async(url)=>{
    if(url.startsWith('https://biohub.ai/'))return Response.json({sequence:atlasSeq,protein_hash:atlasHashFixture,source:'uniparc',accession:'UPI0000002FB4',pdb:null});
    if(url.includes('/uniparc/'))return Response.json({uniParcId:'UPI0000002FB4',sequence:{value:mismatched?'G'+atlasSeq.slice(1):atlasSeq},uniParcCrossReferences:[{active:true,database:'UniProtKB/Swiss-Prot',id:'P42212'}]});
    if(url.startsWith('https://rest.uniprot.org/'))return Response.json({primaryAccession:'P42212',sequence:{value:atlasSeq,length:76}});
    if(url.includes('/api/prediction/'))return new Response(null,{status:403});
    if(url.startsWith('https://www.ebi.ac.uk/'))return Response.json({structures:[{summary:{provider:'AlphaFold DB',uniprot_start:1,uniprot_end:76,coverage:1,sequence_identity:1,oligomeric_state:'MONOMER',model_identifier:'AF-P42212-F1',model_url:'https://alphafold.ebi.ac.uk/files/AF-P42212-F1-model_v6.cif'}}]});
    if(url==='https://alphafold.ebi.ac.uk/files/AF-P42212-F1-model_v6.pdb')return new Response(pdb);
    throw Error('unexpected_url');
  });
  const req=()=>new Request('http://test/api/structures/existing',{method:'POST',body:JSON.stringify({sequence:atlasSeq})});
  let j=await(await worker.fetch(req(),{})).json();assert.equal(j.status,'structure_available');assert.match(j.identity_note,/不能推断/);assert.equal(j.source.provider,'AlphaFold DB');
  mismatched=true;j=await(await worker.fetch(req(),{})).json();assert.equal(j.status,'lookup_incomplete');assert.ok(!j.pdb_text);
});
test('structure report proxy validates, authenticates and refuses redirects',async t=>{
  const env={MODEL_GATEWAY_URL:'https://gateway.example',MODEL_GATEWAY_TOKEN:'test-token'};
  const payload={sequence:atlasSeq,request_id:'structure-test-1',lookup_atlas:false};
  const request=body=>new Request('http://test/api/structures/reports',{method:'POST',body:JSON.stringify(body)});
  let count=0;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    count++;assert.equal(url,'https://gateway.example/v1/structures');
    assert.equal(init.headers.authorization,'Bearer test-token');assert.equal(init.redirect,'manual');
    assert.deepEqual(JSON.parse(init.body),payload);
    return Response.json({id:'a'.repeat(32),status:'queued'},{status:202});
  });
  assert.equal((await worker.fetch(request(payload),env)).status,202);
  for(const body of [{...payload,sequence:'A'.repeat(201)},{...payload,sequence:'AXXXXXXXAA'},{...payload,request_id:'../bad'},{...payload,model:'arbitrary'},{...payload,lookup_atlas:'false'}])assert.equal((await worker.fetch(request(body),env)).status,400);
  assert.equal(count,1);
  t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:302,headers:{location:'https://untrusted.example'}}));
  assert.equal((await worker.fetch(request(payload),env)).status,502);
});
test('structure errors distinguish old gateway, missing report and outage',async t=>{
  const env={MODEL_GATEWAY_URL:'https://gateway.example',MODEL_GATEWAY_TOKEN:'test-token'};
  t.mock.method(globalThis,'fetch',async()=>Response.json({detail:'Not Found'},{status:404}));
  const start=()=>new Request('http://test/api/structures/reports',{method:'POST',body:JSON.stringify({sequence:atlasSeq,request_id:'structure-test-2',lookup_atlas:true})});
  assert.equal((await(await worker.fetch(start(),env)).json()).error,'gateway_upgrade_required');
  const get=()=>new Request('http://test/api/structures/reports/'+'a'.repeat(32));
  assert.equal((await(await worker.fetch(get(),env)).json()).error,'structure_report_not_found');
  t.mock.method(globalThis,'fetch',async()=>{throw Error('offline');});
  assert.equal((await worker.fetch(get(),env)).status,503);
});
test('3D viewer scripts are self-hosted and syntactically valid',async()=>{
  for(const path of ['/assets/3dmol-2.5.5.js','/assets/structure-workbench.js']){
    const r=await worker.fetch(new Request('http://test'+path),{});
    assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/javascript/);
    new Script(await r.text());
  }
});
const atlasHashFixture='4bbff14e49fc0da0d3902dab2290abdd';
const atlasRecord={protein_hash:atlasHashFixture,sequence:atlasSeq,sequence_length:76,ptm:null,mean_plddt:null,residues_plddt:null,sae_features:[],pdb:null,folded_on_demand:false};
const atlasRequest=body=>new Request('http://test/api/structures/atlas',{method:'POST',body:JSON.stringify(body)});
test('Atlas exact lookup hashes FASTA correctly, never authenticates or folds, preserves missing metrics',async t=>{
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,`https://biohub.ai/esm/protein/api/v1alpha1/proteins/${atlasHashFixture}?fold_on_miss=false&topk_features=5`);
    assert.equal(init.headers.authorization,undefined);assert.equal(init.redirect,'manual');
    return Response.json(atlasRecord);
  });
  const r=await worker.fetch(atlasRequest({sequence:'>public\n'+atlasSeq.toLowerCase()}),{BIOHUB_API_KEY:'must-not-leave-server'});
  const j=await r.json();assert.equal(r.status,200);assert.equal(j.status,'record_only');assert.equal(j.structure.mean_plddt,null);assert.equal(j.structure.sequence_verified,false);
  assert.equal(JSON.stringify(j).includes('must-not-leave-server'),false);
});
test('Atlas accepts an exact complete PDB and quarantines mismatched structures',async t=>{
  const pdb=readFileSync(new URL('../public/examples/1UBQ.pdb',import.meta.url),'utf8');
  let bad=false;
  t.mock.method(globalThis,'fetch',async()=>Response.json({...atlasRecord,pdb:bad?pdb.replaceAll('MET A   1','GLY A   1'):pdb}));
  let j=await(await worker.fetch(atlasRequest({sequence:atlasSeq}),{})).json();
  assert.equal(j.status,'structure_available');assert.equal(j.structure.sequence_verified,true);assert.equal(j.structure.pdb_text,pdb);
  bad=true;j=await(await worker.fetch(atlasRequest({sequence:atlasSeq}),{})).json();
  assert.equal(j.structure.status,'sequence_or_format_mismatch');assert.equal(j.structure.pdb_text,null);
});
test('Atlas rejects multiple sequences, invalid IDs, unsupported fields, and accession/sequence mismatch',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({sequence:'ACDE',protein_hash:'irrelevant'});});
  for(const body of [{sequence:'>a\nACDE\n>b\nACDE'},{sequence:'AXDE'},{accession:'https://example.com'},{sequence:'ACDE',fold_on_miss:true}]){
    const r=await worker.fetch(atlasRequest(body),{});assert.equal(r.status,400);
  }
  assert.equal(calls,0);
  const r=await worker.fetch(atlasRequest({sequence:atlasSeq,accession:'P42212'}),{});assert.equal(r.status,409);assert.equal(calls,1);
});
test('Atlas distinguishes absent records, corrupt records and unavailable upstream',async t=>{
  let mode='missing';
  t.mock.method(globalThis,'fetch',async()=>mode==='missing'?new Response('',{status:404}):mode==='corrupt'?Response.json({...atlasRecord,sequence:'ACDE'}):new Response('',{status:503}));
  let r=await worker.fetch(atlasRequest({sequence:atlasSeq}),{});assert.equal(r.status,200);assert.equal((await r.json()).status,'not_found');
  mode='corrupt';r=await worker.fetch(atlasRequest({sequence:atlasSeq}),{});assert.equal(r.status,502);assert.equal((await r.json()).error,'atlas_sequence_mismatch');
  mode='down';r=await worker.fetch(atlasRequest({sequence:atlasSeq}),{});assert.equal(r.status,502);assert.equal((await r.json()).error,'atlas_upstream_503');
});
test('Atlas rejects redirects without following them to another host',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{calls++;assert.equal(init.redirect,'manual');return new Response('',{status:302,headers:{location:'https://untrusted.example'}});});
  const r=await worker.fetch(atlasRequest({sequence:atlasSeq}),{});assert.equal(r.status,502);assert.equal((await r.json()).error,'atlas_upstream_302');assert.equal(calls,1);
});
