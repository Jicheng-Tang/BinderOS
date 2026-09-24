// Read-only external structures; independent of local GPU limits. No inference keys.
const UNIPROT_ID=/^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-[0-9]+)?$/;
async function structureRead(url,limit=4_000_000){
  const r=await fetch(url,{redirect:'manual',headers:{accept:'application/json, text/plain'},signal:AbortSignal.timeout(20000)});
  if(r.status===404)return null;
  if(!r.ok)throw Error('upstream_http_'+r.status);
  const reader=r.body.getReader();let size=0;const chunks=[];
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('structure_response_too_large');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}return new TextDecoder().decode(bytes);
}
async function structureJson(url){const raw=await structureRead(url);return raw===null?null:JSON.parse(raw);}
function proteinIdentity(p){return {accession:p.primaryAccession,name:cleanText(p.proteinDescription?.recommendedName?.fullName?.value||p.proteinDescription?.submissionNames?.[0]?.fullName?.value||p.uniProtkbId,300),organism:cleanText(p.organism?.scientificName,160),taxon_id:p.organism?.taxonId,length:p.sequence?.length,reviewed:p.entryType==='UniProtKB reviewed (Swiss-Prot)',source_url:'https://www.uniprot.org/uniprotkb/'+p.primaryAccession+'/entry'};}
async function handleProteinSearch(request){
  let b;try{const raw=await request.text();if(raw.length>2000)return json({error:'request_too_large'},413);b=JSON.parse(raw);}catch{return json({error:'invalid_json'},400);}
  if(!b||typeof b.query!=='string'||b.query.trim().length<2||b.query.length>120||typeof(b.organism??'')!=='string'||(b.organism||'').length>100)return json({error:'invalid_search'},400);
  const q=b.query.trim(),organism=(b.organism||'').trim();
  const quoted=s=>'"'+s.replace(/["\\\r\n]/g,' ')+'"';
  const query=UNIPROT_ID.test(q.toUpperCase())?'accession:'+q.toUpperCase():`(protein_name:${quoted(q)} OR gene_exact:${quoted(q)})`+(organism?' AND organism_name:'+quoted(organism):'');
  try{const result=await structureJson('https://rest.uniprot.org/uniprotkb/search?'+new URLSearchParams({query,format:'json',size:'8',fields:'accession,id,protein_name,organism_name,organism_id,length,reviewed'}));return json({candidates:(result?.results||[]).map(proteinIdentity),truncated:(result?.results||[]).length===8,provider:'UniProt'});}
  catch{return json({error:'protein_search_unavailable',message:'UniProt 查询暂时不可用；请稍后重试。'},502);}
}
function lookupAnalysis(pdb,sequence,knownConfidence){
  const verified=atlasStructure(pdb,sequence);if(!verified.sequence_verified)throw Error('structure_sequence_mismatch');
  const residues=[];for(const line of pdb.split('\n')){
    if(!line.startsWith('ATOM  ')||line.slice(12,16).trim()!=='CA'||![' ','A'].includes(line[16]))continue;
    const value=line.slice(60,66).trim(),raw=value?Number(value):NaN;
    residues.push({position:residues.length+1,amino_acid:sequence[residues.length],chain:line[21],pdb_residue_number:Number(line.slice(22,26)),insertion_code:line[26].trim(),plddt:knownConfidence&&Number.isFinite(raw)&&raw>=0&&raw<=100?raw:null,sasa_angstrom2:null});
  }
  const complete=knownConfidence&&residues.every(r=>r.plddt!==null),low=[];
  if(complete)for(const r of residues)if(r.plddt<70){if(low.at(-1)?.end===r.position-1)low.at(-1).end=r.position;else low.push({start:r.position,end:r.position});}
  return {sequence_verified:true,residue_count:residues.length,chain:residues[0].chain,residues,plddt_scale:complete?'0-100':null,mean_plddt:complete?residues.reduce((s,r)=>s+r.plddt,0)/residues.length:null,low_confidence_regions:low};
}
async function handleExistingStructure(request){
  let b,sequence,accession;
  try{const raw=await request.text();if(raw.length>22000)return json({error:'request_too_large'},413);b=JSON.parse(raw);
    if(!b||Array.isArray(b)||Object.keys(b).some(k=>!['sequence','accession'].includes(k)))throw Error();
    if(b.sequence)sequence=atlasSequence(b.sequence);
    if(b.accession){if(typeof b.accession!=='string')throw Error();accession=b.accession.trim().toUpperCase();if(!UNIPROT_ID.test(accession))throw Error();}
    if(!sequence&&!accession)throw Error();
  }catch{return json({error:'invalid_structure_query',message:'请输入单条 1–5000 aa 标准序列，或有效 UniProt 编号。'},400);}
  const attempts=[];let identity=null;
  const make=(pdb,source,known)=>({schema_version:'binderos.structure-lookup.v1',status:'structure_available',sequence,identity,source,analysis:lookupAnalysis(pdb,sequence,known),pdb_text:pdb,attempts,retrieved_at:new Date().toISOString(),new_prediction:false});
  if(accession){
    try{const p=await structureJson('https://rest.uniprot.org/uniprotkb/'+accession+'.json');if(!p)return json({status:'not_found',attempts:[{provider:'UniProt',status:'not_found'}]});
      const full=atlasSequence(p.sequence?.value);if(sequence&&full!==sequence)return json({error:'accession_sequence_mismatch',message:'所选编号与输入完整序列不同；不会自动截断、拼接或替换。'},409);sequence=full;identity=proteinIdentity(p);
    }catch{return json({error:'identity_lookup_failed',message:'无法取得可支持的完整 UniProt 序列（当前最多 5000 aa）；未继续匹配结构。'},502);}
    try{
      const records=await structureJson('https://alphafold.ebi.ac.uk/api/prediction/'+accession);
      const list=Array.isArray(records)?records:[];
      // Never select a fragment or a similar sequence as the full target.
      const record=list.find(r=>(r.sequence??r.uniprotSequence)===sequence&&(r.sequenceStart??r.uniprotStart)===1&&(r.sequenceEnd??r.uniprotEnd)===sequence.length&&r.pdbUrl);
      if(record){const url=new URL(record.pdbUrl);if(url.protocol!=='https:'||url.username||url.password||url.port||!['alphafold.ebi.ac.uk','www.alphafold.ebi.ac.uk','alphafold.com','www.alphafold.com'].includes(url.hostname)||!url.pathname.startsWith('/files/'))throw Error('untrusted_structure_url');
        const pdb=await structureRead(url.href);const result=make(pdb,{provider:'AlphaFold DB',kind:'existing_prediction',source_url:'https://alphafold.ebi.ac.uk/entry/'+encodeURIComponent(record.modelEntityId||record.entryId||accession),download_url:url.href,model_id:record.modelEntityId||record.entryId,version:record.latestVersion??null,attribution:'AlphaFold DB · Google DeepMind / EMBL-EBI · CC BY 4.0'},true);attempts.push({provider:'AlphaFold DB',status:'exact_full_structure'});return json(result);}
      attempts.push({provider:'AlphaFold DB',status:list.length?'no_exact_full_structure':'not_found'});
    }catch(e){attempts.push({provider:'AlphaFold DB',status:'unavailable_or_rejected',error:/^(upstream_http_\d+|structure_sequence_mismatch|untrusted_structure_url)$/.test(e.message)?e.message:'upstream_unavailable'});}
    // Official EMBL-EBI metadata fallback. Keep its exact model version; no guessed version or similar-protein substitution.
    try{
      const metadataUrl='https://www.ebi.ac.uk/pdbe/pdbe-kb/3dbeacons/api/uniprot/summary/'+accession+'.json';
      const beacon=await structureJson(metadataUrl);
      const record=beacon?.structures?.map(x=>x.summary).find(s=>s.provider==='AlphaFold DB'&&s.uniprot_start===1&&s.uniprot_end===sequence.length&&s.coverage===1&&s.sequence_identity===1&&s.oligomeric_state==='MONOMER');
      if(record){const url=new URL(record.model_url);if(url.protocol!=='https:'||url.username||url.password||url.port||url.hostname!=='alphafold.ebi.ac.uk'||!/^\/files\/AF-[A-Z0-9-]+-model_v\d+\.(cif|pdb)$/.test(url.pathname))throw Error('untrusted_structure_url');
        // AFDB distributes PDB and CIF companions with the same versioned stem.
        url.pathname=url.pathname.replace(/\.cif$/,'.pdb');
        const pdb=await structureRead(url.href);const result=make(pdb,{provider:'AlphaFold DB',kind:'existing_prediction',source_url:'https://alphafold.ebi.ac.uk/entry/'+encodeURIComponent(record.model_identifier),download_url:url.href,metadata_url:metadataUrl,model_id:record.model_identifier,attribution:'AlphaFold DB · Google DeepMind / EMBL-EBI · CC BY 4.0'},true);
        attempts.push({provider:'EMBL-EBI 3D-Beacons → AlphaFold DB',status:'exact_full_structure'});return json(result);
      }
      attempts.push({provider:'EMBL-EBI 3D-Beacons',status:'no_exact_full_structure'});
    }catch{attempts.push({provider:'EMBL-EBI 3D-Beacons',status:'unavailable_or_rejected'});}
  }
  try{
    const hash=atlasHash(sequence),path='/proteins/'+hash+'?fold_on_miss=false&topk_features=1';const record=await atlasGet(path);
    if(record){if(record.sequence!==sequence||record.protein_hash!==hash||record.folded_on_demand)throw Error('atlas_record_rejected');
      if(record.pdb){const result=make(record.pdb,{provider:'Biohub ESM Atlas',kind:'existing_prediction',source_url:ATLAS_BASE+path,confidence_note:'Atlas confidence units not assumed'},false);attempts.push({provider:'Biohub ESM Atlas',status:'exact_full_structure'});return json(result);}
      let linkedAccession=!accession&&typeof record.accession==='string'&&UNIPROT_ID.test(record.accession)?record.accession:null;
      if(!accession&&record.source==='uniparc'&&/^UPI[A-F0-9]{10}$/.test(record.accession||'')){
        const archive=await structureJson('https://rest.uniprot.org/uniparc/'+record.accession+'.json');
        if(!archive||archive.uniParcId!==record.accession||atlasSequence(archive.sequence?.value)!==sequence)throw Error('archive_sequence_mismatch');
        const refs=(archive.uniParcCrossReferences||[]).filter(r=>r.active===true&&['UniProtKB/Swiss-Prot','UniProtKB/TrEMBL'].includes(r.database)&&UNIPROT_ID.test(r.id||''));
        refs.sort((a,b)=>Number(b.database==='UniProtKB/Swiss-Prot')-Number(a.database==='UniProtKB/Swiss-Prot'));linkedAccession=refs[0]?.id;
      }
      if(!accession&&linkedAccession){
        // Resolve only an explicit Atlas accession and re-check its complete UniProt sequence.
        const linked=await handleExistingStructure(new Request('https://binderos.local/api/structures/existing',{method:'POST',body:JSON.stringify({sequence,accession:linkedAccession})}));
        if(linked.ok){const result=await linked.json();result.identity_note='名称与物种属于数据库参考条目；仅凭相同序列不能推断用户样本的来源物种。';result.attempts=[{provider:'Biohub ESM Atlas / UniProt',status:'exact_accession_resolved'},...(result.attempts||[])];return json(result);}
      }
      attempts.push({provider:'Biohub ESM Atlas',status:'record_without_structure'});
    }else attempts.push({provider:'Biohub ESM Atlas',status:'not_found'});
  }catch{attempts.push({provider:'Biohub ESM Atlas',status:'unavailable_or_rejected'});}
  return json({schema_version:'binderos.structure-lookup.v1',status:attempts.some(a=>a.status==='unavailable_or_rejected')?'lookup_incomplete':'no_structure',sequence,identity,attempts,new_prediction:false,message:'本次未取得与完整序列一致的可用结构。不会用近似蛋白、片段或示意图替代，也未启动新预测。'});
}
