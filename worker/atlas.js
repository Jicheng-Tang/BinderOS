// Atlas is an optional, read-only Alpha API. Never start on-demand folding here.
const ATLAS_BASE = 'https://biohub.ai/esm/protein/api/v1alpha1';
const ATLAS_DOCS = 'https://www.biohub.ai/esm/protein/atlas/api-docs/api_reference.html';

// MD5 is Atlas's content-addressing convention, NOT a security primitive.
function atlasHash(sequence) {
  const input = new TextEncoder().encode(sequence);
  const bytes = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  bytes.set(input); bytes[input.length] = 128;
  const view = new DataView(bytes.buffer);
  view.setUint32(bytes.length - 8, input.length * 8, true);
  let state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const shifts = [[7,12,17,22],[5,9,14,20],[4,11,16,23],[6,10,15,21]];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    let [a,b,c,d] = state;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5*i+1)%16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3*i+5)%16; }
      else { f = c ^ (b | ~d); g = (7*i)%16; }
      const sum = (a + f + Math.floor(Math.abs(Math.sin(i+1))*2**32) + view.getUint32(offset+g*4,true)) | 0;
      const shift = shifts[Math.floor(i/16)][i%4];
      [a,b,c,d] = [d,(b+((sum<<shift)|(sum>>>(32-shift))))|0,b,c];
    }
    state = state.map((v,i)=>(v+[a,b,c,d][i])>>>0);
  }
  return state.flatMap(v=>[0,8,16,24].map(s=>((v>>>s)&255).toString(16).padStart(2,'0'))).join('');
}

function atlasSequence(value) {
  if (typeof value !== 'string' || value.length > 20000) throw new Error('invalid_sequence');
  const lines=value.trim().split(/\r?\n/);
  if (lines[0]?.startsWith('>')) lines.shift();
  if (lines.some(x=>x.includes('>'))) throw new Error('single_sequence_required');
  const sequence=lines.join('').replace(/\s/g,'').toUpperCase();
  if (!/^[ACDEFGHIKLMNPQRSTVWY]{1,5000}$/.test(sequence)) throw new Error('invalid_sequence');
  return sequence;
}

async function atlasGet(path) {
  // Fixed origin, no user URLs, no inference token, and no cross-origin redirects.
  // workerd does not support redirect:"error"; manual mode rejects 3xx below.
  const response=await fetch(ATLAS_BASE+path,{redirect:'manual',signal:AbortSignal.timeout(30000),headers:{accept:'application/json'}});
  if (response.status===404) return null;
  if (!response.ok) throw new Error(`atlas_upstream_${response.status}`);
  const reader=response.body.getReader(); const chunks=[]; let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16_000_000)throw new Error('atlas_response_too_large');chunks.push(value);}
  }finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}

function atlasStructure(pdb, sequence) {
  if (!pdb) return {status:'not_available',pdb_text:null,sequence_verified:false};
  if (typeof pdb!=='string' || pdb.length>4_000_000) throw new Error('atlas_invalid_structure');
  const aa={ALA:'A',ARG:'R',ASN:'N',ASP:'D',CYS:'C',GLN:'Q',GLU:'E',GLY:'G',HIS:'H',ILE:'I',LEU:'L',LYS:'K',MET:'M',PHE:'F',PRO:'P',SER:'S',THR:'T',TRP:'W',TYR:'Y',VAL:'V'};
  const residues=new Map();const chains=new Set();let models=0;let invalid=false;
  for(const line of pdb.split('\n')){
    if(line.startsWith('MODEL '))models++;
    if(!line.startsWith('ATOM  ')||line.slice(12,16).trim()!=='CA')continue;
    if(![' ','A'].includes(line[16]))continue;
    const key=line.slice(21,27);const residue=aa[line.slice(17,20)];
    const coordinates=[30,38,46].map(i=>line.slice(i,i+8).trim());
    if(!residue||coordinates.some(x=>!x||!Number.isFinite(Number(x))))invalid=true;
    if(residues.has(key))invalid=true;
    residues.set(key,residue||'?');chains.add(line[21]);
  }
  const verified=!invalid&&models<=1&&chains.size===1&&[...residues.values()].join('')===sequence;
  return {status:verified?'available':'sequence_or_format_mismatch',sequence_verified:verified,pdb_text:verified?pdb:null,residue_count:residues.size};
}

async function handleAtlasLookup(request) {
  let body;
  try {
    const raw=await request.text();if(raw.length>22000)return json({error:'request_too_large'},413);
    body=JSON.parse(raw);
  }catch{return json({error:'invalid_json'},400);}
  let sequence, accession;
  try {
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['sequence','accession'].includes(k)))throw new Error('invalid_lookup_request');
    if(body.sequence!==undefined&&body.sequence!=='')sequence=atlasSequence(body.sequence);
    if(body.accession!==undefined&&body.accession!==''){
      if(typeof body.accession!=='string')throw new Error('invalid_accession');
      accession=body.accession.trim().toUpperCase();
      if(!/^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-[0-9]+)?$/.test(accession))throw new Error('invalid_accession');
    }
    if(!sequence&&!accession)throw new Error('sequence_or_accession_required');
  }catch(e){return json({error:e.message},400);}
  try {
    let metadata=null;
    const provenance={provider:'Biohub ESM Atlas',api_stage:'alpha',retrieved_at:new Date().toISOString(),documentation_url:ATLAS_DOCS,on_demand_folding:false,inference_key_used:false};
    if(accession){
      metadata=await atlasGet('/uniprot/'+encodeURIComponent(accession));
      if(!metadata)return json({schema_version:'binderos.atlas.v1',status:'not_found',query:{accession},provenance});
      let resolved;try{resolved=atlasSequence(metadata.sequence);}catch{throw new Error('atlas_invalid_record');}
      if(sequence&&resolved!==sequence)return json({error:'accession_sequence_mismatch',message:'编号对应的完整序列与输入不同；请核对截短体或序列版本。'},409);
      sequence=resolved;
    }
    const hash=atlasHash(sequence);
    if(metadata?.protein_hash&&metadata.protein_hash!==hash)throw new Error('atlas_hash_mismatch');
    const source_url=ATLAS_BASE+'/proteins/'+hash+'?fold_on_miss=false&topk_features=5';
    const record=await atlasGet('/proteins/'+hash+'?fold_on_miss=false&topk_features=5');
    const query={accession:accession||null,sequence,length:sequence.length,protein_hash:hash};
    if(!record)return json({schema_version:'binderos.atlas.v1',status:'not_found',query,provenance:{...provenance,source_url}});
    if(record.sequence!==sequence||record.protein_hash!==hash||record.sequence_length!==sequence.length)throw new Error('atlas_sequence_mismatch');
    if(record.folded_on_demand===true)throw new Error('atlas_unexpected_on_demand_result');
    const structure=atlasStructure(record.pdb,sequence);
    const numberOrNull=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
    const plddt=Array.isArray(record.residues_plddt)&&record.residues_plddt.length===sequence.length&&record.residues_plddt.every(x=>numberOrNull(x)!==null)?record.residues_plddt:null;
    const report={schema_version:'binderos.atlas.v1',status:structure.status==='available'?'structure_available':'record_only',query,
      identity:{sequence_match:'exact',protein_name:cleanText(metadata?.protein_name||'',300),organism:cleanText(metadata?.organism||'',300),source:cleanText(record.source,200),source_accession:cleanText(record.accession,500),uniprot_url:accession?'https://www.uniprot.org/uniprotkb/'+accession+'/entry':null},
      structure:{...structure,kind:'predicted_not_experimental',ptm:numberOrNull(record.ptm),mean_plddt:numberOrNull(record.mean_plddt),residues_plddt:plddt,confidence_scale:'as_returned_by_atlas'},
      features:(Array.isArray(record.sae_features)?record.sae_features:[]).slice(0,5).map(f=>({feature_index:Number.isInteger(f.feature_index)?f.feature_index:null,label:cleanText(f.label,300),description:cleanText(f.description,1500),activation:numberOrNull(f.value),evidence_type:'model_hypothesis_not_functional_site',residue_regions_raw:Array.isArray(f.residue_regions)?f.residue_regions.slice(0,30).map(r=>({start:numberOrNull(r.start),end:numberOrNull(r.end),peak_residue:numberOrNull(r.peak_residue)})):[],coordinate_note:'Raw Atlas coordinates; not converted into design hotspots.'})),
      caveats:['Atlas 不覆盖所有蛋白；精确序列命中不证明来源物种相同。','结构为模型预测，不是实验结构；功能特征不是已验证的功能位点。','未启用重新折叠、相似序列替代、binder 设计或自动位点选择。','Atlas 接口处于 Alpha 阶段；保存报告可保留本次查询结果。'],provenance:{...provenance,source_url}};
    if(structure.status==='sequence_or_format_mismatch')report.caveats.push('返回结构未通过单链完整序列核对，已隔离，不能作为当前靶标结构下载。');
    return json(report);
  }catch(e){
    // No credentials are sent on this path. Do not log sequence, record, or URL.
    console.error(JSON.stringify({event:'atlas_lookup_failure',name:e?.name,message:String(e?.message||'unknown').replace(/https?:\/\/\S+/g,'[upstream]').slice(0,200)}));
    const error=/^(atlas_[a-z_]+(?:_[0-9]+)?)$/.test(e.message)?e.message:'atlas_unavailable';
    return json({error,message:'Atlas 查询失败或返回数据不一致；这不表示蛋白不存在，请稍后重试。'},502);
  }
}
