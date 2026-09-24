(() => {
  const el=id=>document.getElementById(id);
  let viewer, current, selected, pollTimer, reportId=localStorage.getItem('binderos-structure-id'), activeId=null;
  let connectionReady=false, inFlight=false, drawVersion=0;
  const stageNames={queued:'等待计算',lookup_existing_structure:'查询已有结构',topology:'预测跨膜拓扑与信号肽',predicting_structure:'本机 GPU 结构预测',analyzing_structure:'核对序列与计算结构指标',complete:'报告完成',failed:'任务未完成'};
  const text=(parent,tag,value)=>{const n=document.createElement(tag);n.textContent=value;parent.append(n);return n;};
  const save=(data,name,type='text/plain')=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
  const button=(parent,label,fn)=>{const n=text(parent,'button',label);n.className='ghost';n.onclick=fn;return n;};
  const format=v=>typeof v==='number'&&Number.isFinite(v)?v.toFixed(2):'未提供';
  const confidenceColor=a=>a.b>=90?0x0053d6:a.b>=70?0x65cbf3:a.b>=50?0xffdb13:0xff7d45;
  function ensureViewer(){
    if(viewer)return viewer;
    if(!window.$3Dmol)throw Error('三维查看器未加载，请刷新页面。');
    el('structureViewer').replaceChildren();
    try{viewer=$3Dmol.createViewer(el('structureViewer'),{backgroundColor:'#071421',antialias:true});}
    catch{throw Error('浏览器无法启用 WebGL。仍可下载原始结构与报告。');}
    $3Dmol.setSyncSurface(true);
    new ResizeObserver(()=>{if(viewer){viewer.resize();viewer.render();}}).observe(el('structureViewer'));
    return viewer;
  }
  function selectResidue(row){
    selected=row;
    el('structureSelected').textContent=`输入位置 ${row.position} · ${row.amino_acid||row.resname||''} · PDB ${row.chain}:${row.pdb_residue_number}${row.insertion_code||''} · pLDDT ${format(row.plddt)} · 可及面积 ${format(row.sasa_angstrom2)} Å²`;
    styleViewer();
  }
  async function styleViewer(){
    if(!viewer||!current)return;
    const version=++drawVersion;viewer.removeAllSurfaces();
    const color=el('structureColor').value;
    const style=color==='confidence'&&current.plddt?{colorfunc:confidenceColor}:color==='spectrum'?{color:'spectrum'}:{color:0x30cbb2};
    viewer.setStyle({}, {cartoon:style});
    if(el('structureStyle').value==='sticks')viewer.addStyle({}, {stick:{radius:.13,colorscheme:'Jmol'}});
    if(selected)viewer.addStyle({chain:selected.chain,resi:selected.pdb_residue_number},{stick:{color:0xff8bbd,radius:.24},sphere:{color:0xff8bbd,scale:.28}});
    viewer.render();
    if(el('structureStyle').value==='surface'){
      try{await viewer.addSurface($3Dmol.SurfaceType.VDW,{opacity:.72,color:0x49bcae},{});if(version===drawVersion)viewer.render();}
      catch{el('structureSelected').textContent='表面计算未完成；带状结构仍可查看。';}
    }
  }
  function showStructure(pdb,{name,kind,analysis,report}={}){
    const v=ensureViewer();v.removeAllModels();v.removeAllSurfaces();selected=null;
    const model=v.addModel(pdb,'pdb');const atoms=model.selectedAtoms({atom:'CA'});
    if(!atoms.length)throw Error('结构文件没有可显示的蛋白主链坐标。');
    const plddt=analysis?.plddt_scale==='0-100';
    const rows=analysis?.residues||atoms.map((a,i)=>({position:i+1,resname:a.resn,chain:a.chain,pdb_residue_number:a.resi,insertion_code:a.icode||'',plddt:null}));
    current={pdb,name,kind,analysis,report,rows,plddt};
    el('structureColor').querySelector('[value="confidence"]').disabled=!plddt;
    el('structureColor').value=plddt?'confidence':'chain';
    el('structureLegend').textContent=plddt?'pLDDT：蓝 ≥90 · 青 70–90 · 黄 50–70 · 橙 <50。仅表示局部预测置信度，不是实验成功率。':'此结构未按 pLDDT 着色。实验 PDB 的 B-factor 不作为预测置信度。';
    const strip=el('structureResidues');strip.replaceChildren();
    rows.forEach(row=>{const b=button(strip,row.amino_acid||row.resname,()=>selectResidue(row));b.title=`输入 ${row.position} / ${row.chain}:${row.pdb_residue_number}`;b.setAttribute('aria-label',b.title);if(plddt&&row.plddt!==null)b.style.borderBottom=`3px solid #${confidenceColor({b:row.plddt}).toString(16).padStart(6,'0')}`;});
    v.setClickable({},true,atom=>{const row=rows.find(r=>r.chain===atom.chain&&r.pdb_residue_number===atom.resi);if(row)selectResidue(row);});
    v.zoomTo();v.resize();styleViewer();el('structureSelected').textContent=`${name||'结构'} · ${atoms.length} 个 CA 原子。拖动旋转、滚轮缩放，点击残基查看编号。`;
  }
  function renderReport(report){
    const parent=el('structureSummary');parent.replaceChildren();const result=report.result,a=result.analysis;
    text(parent,'h3','真实结构分析报告');
    text(parent,'p',`任务 ${report.id.slice(0,12)} · ${result.source.provider} · 预测结构（非实验测定）`);
    text(parent,'p',`${a.residue_count} aa · 全序列核对通过 · ${a.chain} 链`);
    text(parent,'p',`平均 pLDDT：${format(a.mean_plddt)}${a.plddt_scale?' / 100':''}；pTM：${format(a.model_confidence?.ptm)}`);
    text(parent,'p',`局部 pLDDT ≥70 的比例：${a.fraction_plddt_ge_70===null?'未分类':(100*a.fraction_plddt_ge_70).toFixed(1)+'%'}。不代表整体构象已验证。`);
    text(parent,'p','低置信区间：'+(a.low_confidence_regions.map(r=>`${r.start}–${r.end}`).join('，')||(a.plddt_scale?'未检出 <70 区间':'未分类')));
    text(parent,'p',`已有结构查询：${report.lookup?.status||'未知'}；运行设备：${report.prediction_provenance?.gpu||report.topology?.provenance?.device||'见报告'}`);
    for(const prediction of result.topology?.predictions||[]){text(parent,'h4',`拓扑：${prediction.type}`);text(parent,'p',(prediction.segments||[]).map(s=>`${s.name} ${s.start}–${s.end}`).join('；'));}
    button(parent,'下载完整报告 JSON',()=>save(JSON.stringify(report,null,2),`BinderOS-structure-${report.id}.json`,'application/json'));
    button(parent,'下载结构 PDB',()=>save(result.pdb_text,`BinderOS-${report.id}.pdb`));
    button(parent,'下载逐残基 CSV',()=>{const fields=['position','amino_acid','chain','pdb_residue_number','insertion_code','plddt','sasa_angstrom2'];save([fields.join(','),...a.residues.map(r=>fields.map(f=>JSON.stringify(r[f]??'')).join(','))].join('\n'),`BinderOS-${report.id}-residues.csv`,'text/csv');});
    for(const warning of a.warnings)text(parent,'p',warning).className='job-status';
    try{showStructure(result.pdb_text,{name:result.source.provider,kind:'predicted',analysis:a,report});}
    catch(e){text(parent,'p',e.message);}
  }
  async function api(path,options={}){
    const r=await fetch(path,{...options,signal:AbortSignal.timeout(22000)});const data=await r.json();
    if(!r.ok){const error=new Error(data.message||({structure_queue_busy:'已有结构任务在运行，请恢复报告或稍后再试。',structure_models_unavailable:'本机模型尚未就绪。',request_id_payload_mismatch:'请求标识与输入不一致，请刷新后重新提交。'}[data.detail])||data.detail||data.error||'请求失败');error.status=r.status;throw error;}
    return data;
  }
  function clearView(){current=null;selected=null;drawVersion++;if(viewer){viewer.removeAllModels();viewer.removeAllSurfaces();viewer.render();}el('structureLegend').textContent='等待新结构，尚无置信度结果。';el('structureSelected').textContent='尚未选择残基。';el('structureResidues').replaceChildren();el('structureSummary').replaceChildren();text(el('structureSummary'),'p','新任务尚未完成；不显示上一条蛋白的结构或指标。');}
  function showStatus(report){
    el('structureStatus').textContent=`${report.id.slice(0,12)} · ${stageNames[report.stage]||report.status}${report.error?'：'+report.error:''}`;
    inFlight=['queued','running'].includes(report.status);el('structureSubmit').disabled=inFlight||!connectionReady;
    if(report.status==='succeeded')renderReport(report);
    if(!inFlight)localStorage.removeItem('binderos-structure-pending');
  }
  async function poll(id,attempt=0){
    clearTimeout(pollTimer);activeId=id;
    try{
      const report=await api('/api/structures/reports/'+id);if(activeId!==id)return;showStatus(report);
      if(inFlight&&attempt<240)pollTimer=setTimeout(()=>poll(id,attempt+1),5000);
      else if(inFlight)el('structureStatus').textContent='自动查询已暂停，后台计算未取消。点击“恢复上次报告”继续查询。';
    }catch(e){
      if(activeId!==id)return;
      el('structureStatus').textContent=`${e.message}；任务编号已保留，可恢复查询。`;
      if(e.status!==404&&attempt<240)pollTimer=setTimeout(()=>poll(id,attempt+1),10000);
    }
  }
  async function health(){
    try{
      const {services}=await api('/api/health');const g=services.model_gateway;
      connectionReady=!!(g.online&&g.capabilities?.includes('structure-report-v1')&&['boltz2','deeptmhmm2'].every(m=>g.models.includes(m)));
      el('structureConnection').textContent=!g.online?`连接不可用（${g.error||'未配置'}）。不代表模型未安装；计算服务与外网通道需要同时在线。`:!g.capabilities?.includes('structure-report-v1')?`本机在线，但需重启加载 0.5.0（当前 ${g.version}）。`:`本机在线 · ${g.version} · ${g.device} · 正在运行 ${g.active_jobs||0} 个模型任务${g.connection_type==='temporary_tunnel'?' · 当前仍为临时通道，尚非长期稳定连接':''}`;
    }catch{connectionReady=false;el('structureConnection').textContent='连接状态暂时无法确认，请稍后刷新。';}
    el('structureSubmit').disabled=inFlight||!connectionReady;
  }
  el('structureExample').onclick=async()=>{try{const s=await api('/api/models/example');el('structureSequence').value=s.sequence;}catch(e){el('structureStatus').textContent=e.message;}};
  el('structureReference').onclick=async()=>{
    clearTimeout(pollTimer);activeId=null;
    try{const s=await api('/api/models/example');const parent=el('structureSummary');parent.replaceChildren();text(parent,'h3','1UBQ · 实验参考结构');text(parent,'p','这是真实公开 PDB 坐标，不是刚刚执行的预测，也不是当前输入序列的自动查询结果。');const link=text(parent,'a','查看 RCSB 来源');link.href=s.source_url;link.target='_blank';link.rel='noreferrer';button(parent,'下载实验参考 PDB',()=>save(s.pdb_text,'1UBQ-reference.pdb'));showStructure(s.pdb_text,{name:'1UBQ 实验参考',kind:'experimental_reference'});el('structureStatus').textContent='正在查看实验参考；没有新建模型任务。原任务如有运行，仍可点击恢复。';}catch(e){el('structureStatus').textContent=e.message;}
  };
  el('structureSubmit').onclick=async()=>{
    const lines=el('structureSequence').value.trim().split(/\r?\n/);if(lines[0]?.startsWith('>'))lines.shift();const sequence=lines.join('').replace(/\s/g,'').toUpperCase();
    if(!/^[ACDEFGHIKLMNPQRSTVWY]{10,200}$/.test(sequence)){el('structureStatus').textContent='请输入一条 10–200 aa 的标准序列；不接受多条 FASTA、未知残基或自动截断。';return;}
    const lookup_atlas=el('structureLookup').checked;
    inFlight=true;el('structureSubmit').disabled=true;clearTimeout(pollTimer);activeId=null;clearView();el('structureStatus').textContent='正在提交。网络中断时保留请求标识，避免重复计算…';
    try{
      const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(sequence+':'+lookup_atlas)))].map(x=>x.toString(16).padStart(2,'0')).join('');
      let saved;try{saved=JSON.parse(localStorage.getItem('binderos-structure-pending'));}catch{}
      const request_id=saved?.sha===sha?saved.id:crypto.randomUUID();localStorage.setItem('binderos-structure-pending',JSON.stringify({sha,id:request_id}));
      const report=await api('/api/structures/reports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sequence,lookup_atlas,request_id})});
      reportId=report.id;localStorage.setItem('binderos-structure-id',reportId);el('structureResume').hidden=false;showStatus(report);poll(reportId);
    }catch(e){inFlight=false;el('structureStatus').textContent=e.message+'；重试相同输入会复用请求标识。';el('structureSubmit').disabled=!connectionReady;}
  };
  el('structureResume').hidden=!/^[a-f0-9]{32}$/.test(reportId||'');
  el('structureResume').onclick=()=>{if(reportId){clearView();poll(reportId);}};
  el('structureStyle').onchange=styleViewer;el('structureColor').onchange=styleViewer;
  el('structureReset').onclick=()=>{if(viewer){selected=null;viewer.zoomTo();styleViewer();}};
  const reportLink=new URLSearchParams(location.search).get('structure');
  if(/^[a-f0-9]{32}$/.test(reportLink||'')){reportId=reportLink;localStorage.setItem('binderos-structure-id',reportId);el('structureResume').hidden=false;switchStage(2);poll(reportId);}
  health();setInterval(()=>{if(!document.hidden)health();},30000);
})();
