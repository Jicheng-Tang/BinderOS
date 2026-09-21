const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const SOURCE_LINKS = {
  europePmc: "https://europepmc.org/",
  uniprot: "https://www.uniprot.org/",
  deepseek: "https://api-docs.deepseek.com/api/create-response/",
  alphafold3: "https://github.com/google-deepmind/alphafold3",
  deeptmhmm2: "https://github.com/fteufel/DeepTMHMM2",
  bindcraft: "https://github.com/martinpacesa/BindCraft",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function cleanText(value, max = 120) {
  return String(value ?? "").replace(/[<>]/g, "").trim().slice(0, max);
}

async function readJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 1_000_000) throw new Error("request_too_large");
  return request.json();
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`upstream_${response.status}`);
  return response.json();
}

function normalizeLiterature(data) {
  return (data?.resultList?.result || []).slice(0, 10).map((item, index) => ({
    id: item.pmid ? `PMID:${item.pmid}` : item.pmcid || `EPMC:${index + 1}`,
    title: item.title || "Untitled record",
    authors: item.authorString || "",
    journal: item.journalTitle || "",
    year: item.pubYear || "",
    doi: item.doi || "",
    citedBy: Number(item.citedByCount || 0),
    sourceUrl: item.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${item.pmid}/` : SOURCE_LINKS.europePmc,
  }));
}

function normalizeProteins(data) {
  return (data?.results || []).slice(0, 10).map((item) => ({
    accession: item.primaryAccession || "",
    symbol: item.genes?.[0]?.geneName?.value || item.uniProtkbId?.split("_")?.[0] || "Unknown",
    proteinName: item.proteinDescription?.recommendedName?.fullName?.value || item.proteinDescription?.submissionNames?.[0]?.fullName?.value || "Uncharacterized protein",
    organism: item.organism?.scientificName || "",
    length: item.sequence?.length || null,
    sourceUrl: item.primaryAccession ? `https://www.uniprot.org/uniprotkb/${item.primaryAccession}/entry` : SOURCE_LINKS.uniprot,
  }));
}

function evidenceOnlyReport(species, topic, literature, proteins) {
  const candidates = proteins.slice(0, 6).map((protein, index) => ({
    symbol: protein.symbol,
    protein_name: protein.proteinName,
    rationale: "来自已审阅的 UniProt 记录；需要结合疾病机制、组织表达与结构可及性进一步人工审核。",
    evidence_strength: Math.max(0.5, 0.78 - index * 0.04),
    structural_accessibility: "待结构模型确认",
    risks: ["尚未完成疾病因果证据归并", "尚未执行脱靶与同源蛋白分析"],
    sources: [protein.sourceUrl],
  }));
  return {
    schema_version: "binderos.target-report.v1",
    query: { species, topic },
    status: "evidence_only",
    summary: `已联网检索 ${literature.length} 条文献和 ${proteins.length} 条已审阅蛋白记录。DeepSeek 未配置，因此当前报告仅做证据标准化，不执行 AI 靶点结论。`,
    candidates,
    literature,
    caveats: ["联网检索结果不等于靶点验证", "任何 AI 推荐必须由领域专家复核", "候选进入实验前需要独立结构与安全性评估"],
    provenance: { generated_at: new Date().toISOString(), ai_model: null, sources: [SOURCE_LINKS.europePmc, SOURCE_LINKS.uniprot] },
  };
}

function deepSeekSchema() {
  return {
    type: "object",
    properties: {
      schema_version: { type: "string" },
      query: { type: "object", properties: { species: { type: "string" }, topic: { type: "string" } }, required: ["species", "topic"], additionalProperties: false },
      status: { type: "string", enum: ["ai_synthesized"] },
      summary: { type: "string" },
      candidates: { type: "array", items: { type: "object", properties: {
        symbol: { type: "string" }, protein_name: { type: "string" }, rationale: { type: "string" }, evidence_strength: { type: "number" }, structural_accessibility: { type: "string" }, risks: { type: "array", items: { type: "string" } }, sources: { type: "array", items: { type: "string" } }
      }, required: ["symbol", "protein_name", "rationale", "evidence_strength", "structural_accessibility", "risks", "sources"], additionalProperties: false } },
      literature: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, authors: { type: "string" }, journal: { type: "string" }, year: { type: "string" }, doi: { type: "string" }, citedBy: { type: "number" }, sourceUrl: { type: "string" } }, required: ["id", "title", "authors", "journal", "year", "doi", "citedBy", "sourceUrl"], additionalProperties: false } },
      caveats: { type: "array", items: { type: "string" } },
      provenance: { type: "object", properties: { generated_at: { type: "string" }, ai_model: { type: "string" }, sources: { type: "array", items: { type: "string" } } }, required: ["generated_at", "ai_model", "sources"], additionalProperties: false }
    },
    required: ["schema_version", "query", "status", "summary", "candidates", "literature", "caveats", "provenance"],
    additionalProperties: false,
  };
}

async function synthesizeWithDeepSeek(env, species, topic, literature, proteins) {
  const base = (env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
  const model = env.DEEPSEEK_MODEL || "deepseek-flash";
  const payload = {
    model,
    input: [
      { role: "system", content: "You are the evidence synthesis component of a protein target discovery system. Return only JSON matching the supplied schema. Use only the supplied evidence. Do not invent mechanisms, scores, citations, sequences, clinical status, or structural facts. A candidate may be omitted when evidence is insufficient. Evidence strength must be 0 to 1." },
      { role: "user", content: JSON.stringify({ task: "Create a standard target candidate report in JSON", species, topic, literature, reviewed_uniprot_records: proteins }) },
    ],
    text: { format: { type: "json_schema", name: "binderos_target_report", schema: deepSeekSchema() } },
    reasoning: { effort: "low" },
  };
  const response = await fetchJson(`${base}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify(payload),
  });
  const outputText = (response.output || []).filter((item) => item.type === "message").flatMap((item) => item.content || []).filter((part) => part.type === "output_text").map((part) => part.text).join("");
  if (!outputText) throw new Error("deepseek_empty_output");
  const report = JSON.parse(outputText);
  report.provenance = { generated_at: new Date().toISOString(), ai_model: model, sources: [SOURCE_LINKS.europePmc, SOURCE_LINKS.uniprot] };
  return report;
}

async function handleResearch(request, env) {
  const body = await readJson(request);
  const species = cleanText(body.species || "Homo sapiens", 100);
  const topic = cleanText(body.topic || "immune regulation", 120);
  if (!species || !topic) return json({ error: "species_and_topic_required" }, 400);
  const literatureQuery = encodeURIComponent(`(${species}) AND (${topic}) AND (FIRST_PDATE:[2021-01-01 TO 3000-12-31])`);
  const proteinQuery = encodeURIComponent(`(organism_name:\"${species}\") AND (reviewed:true) AND (${topic})`);
  const [literatureResult, proteinResult] = await Promise.allSettled([
    fetchJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${literatureQuery}&format=json&pageSize=10&resultType=core`),
    fetchJson(`https://rest.uniprot.org/uniprotkb/search?query=${proteinQuery}&format=json&size=10&fields=accession,id,protein_name,gene_names,organism_name,length`),
  ]);
  const literature = literatureResult.status === "fulfilled" ? normalizeLiterature(literatureResult.value) : [];
  const proteins = proteinResult.status === "fulfilled" ? normalizeProteins(proteinResult.value) : [];
  if (!literature.length && !proteins.length) return json({ error: "upstream_sources_unavailable", sources: SOURCE_LINKS }, 502);
  let report = evidenceOnlyReport(species, topic, literature, proteins);
  if (env.DEEPSEEK_API_KEY) {
    try { report = await synthesizeWithDeepSeek(env, species, topic, literature, proteins); }
    catch (error) { report.ai_error = String(error?.message || error); }
  }
  return json(report);
}

function gatewayHeaders(env) {
  const headers = { "content-type": "application/json" };
  if (env.MODEL_GATEWAY_TOKEN) headers.authorization = `Bearer ${env.MODEL_GATEWAY_TOKEN}`;
  return headers;
}

async function handleModelJob(request, env) {
  if (!env.MODEL_GATEWAY_URL) return json({ error: "model_gateway_unconfigured", message: "请配置 MODEL_GATEWAY_URL 后提交真实模型任务。" }, 503);
  const body = await readJson(request);
  if (!new Set(["alphafold3", "deeptmhmm2", "bindcraft"]).has(body.model)) return json({ error: "unsupported_model" }, 400);
  if (!body.sequence && !body.sequences?.length) return json({ error: "sequence_required" }, 400);
  const response = await fetch(`${env.MODEL_GATEWAY_URL.replace(/\/$/, "")}/v1/jobs`, { method: "POST", headers: gatewayHeaders(env), body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const data = await response.json().catch(() => ({ error: "invalid_gateway_response" }));
  return json(data, response.status);
}

async function handleModelStatus(pathname, env) {
  if (!env.MODEL_GATEWAY_URL) return json({ error: "model_gateway_unconfigured" }, 503);
  const jobId = pathname.split("/").pop();
  const response = await fetch(`${env.MODEL_GATEWAY_URL.replace(/\/$/, "")}/v1/jobs/${encodeURIComponent(jobId)}`, { headers: gatewayHeaders(env), signal: AbortSignal.timeout(15_000) });
  const data = await response.json().catch(() => ({ error: "invalid_gateway_response" }));
  return json(data, response.status);
}

function handleHealth(env) {
  return json({
    status: "ok",
    services: {
      europe_pmc: { configured: true, mode: "live_rest" },
      uniprot: { configured: true, mode: "live_rest" },
      deepseek: { configured: Boolean(env.DEEPSEEK_API_KEY), model: env.DEEPSEEK_MODEL || "deepseek-flash" },
      model_gateway: { configured: Boolean(env.MODEL_GATEWAY_URL), models: ["alphafold3", "deeptmhmm2", "bindcraft"] },
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    void ctx;
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") return handleHealth(env);
      if (request.method === "POST" && url.pathname === "/api/research") return await handleResearch(request, env);
      if (request.method === "POST" && url.pathname === "/api/models/jobs") return await handleModelJob(request, env);
      if (request.method === "GET" && url.pathname.startsWith("/api/models/jobs/")) return await handleModelStatus(url.pathname, env);
      if (request.method === "GET" && url.pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
      return json({ error: "not_found" }, 404);
    } catch (error) {
      const message = String(error?.message || error);
      const status = message === "request_too_large" ? 413 : 500;
      return json({ error: "request_failed", message }, status);
    }
  },
};
