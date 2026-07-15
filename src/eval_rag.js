// Evalua el RAG de tenant_huberman contra el set de preguntas doradas (data/golden_questions.json).
// Corre 100% local. Mide Hit@K, Recall@K y MRR comparando episode_number esperado vs el que devuelve Supabase.
//
// Uso (PowerShell):
//   $env:OPENAI_API_KEY = "sk-..."
//   $env:SUPABASE_SERVICE_ROLE_KEY = "sb_secret_..."
//   node src/eval_rag.js            (vector puro, funcion match_kb_documents)
//   $env:RAG_MODE = "hybrid"; node src/eval_rag.js   (BM25 + vector, funcion match_kb_documents_hybrid)
//
// Guarda el resultado con timestamp y modo en data/eval_results/ para comparar antes/despues de cada fase.

const fs = require('fs');
const path = require('path');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MODE = (process.env.RAG_MODE || 'vector').toLowerCase();
const SUPABASE_RPC_URL = MODE === 'hybrid'
  ? 'https://lmyqexbucniromvnudjo.supabase.co/rest/v1/rpc/match_kb_documents_hybrid'
  : 'https://lmyqexbucniromvnudjo.supabase.co/rest/v1/rpc/match_kb_documents';
const TENANT_ID = 'tenant_huberman';
const TOP_K = 8;

if (!OPENAI_KEY) { console.error('Falta OPENAI_API_KEY.'); process.exit(1); }
if (!SUPABASE_KEY) { console.error('Falta SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1); }

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'golden_questions.json'), 'utf8'));

async function embed(text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: [text] })
  });
  const body = await res.json();
  if (!res.ok || !body.data) throw new Error(`OpenAI ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.data[0].embedding;
}

async function queryKb(embedding, queryText) {
  const payload = { query_embedding: embedding, match_tenant_id: TENANT_ID, match_count: TOP_K };
  if (MODE === 'hybrid') payload.query_text = queryText;
  const res = await fetch(SUPABASE_RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    },
    body: JSON.stringify(payload)
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return Array.isArray(body) ? body : [];
}

function evalOne(rows, expectedEpisodes) {
  const gotEpisodes = rows.map(r => r.episode_number).filter(e => e != null);
  const topScore = rows.length ? rows[0].similarity : 0;
  if (expectedEpisodes.length === 0) {
    return { hit: null, rank: null, topScore, gotEpisodes };
  }
  let rank = null;
  for (let i = 0; i < gotEpisodes.length; i++) {
    if (expectedEpisodes.includes(gotEpisodes[i])) { rank = i + 1; break; }
  }
  return { hit: rank !== null, rank, topScore, gotEpisodes };
}

async function main() {
  const results = [];
  let hits = 0, evaluable = 0, mrrSum = 0;

  for (const q of golden.questions) {
    const embedding = await embed(q.question);
    const rows = await queryKb(embedding, q.question);
    const evalResult = evalOne(rows, q.expected_episodes || []);
    results.push({ id: q.id, type: q.type, question: q.question, ...evalResult });

    if (q.type !== 'offtopic') {
      evaluable++;
      if (evalResult.hit) { hits++; mrrSum += 1 / evalResult.rank; }
    }

    const status = q.type === 'offtopic'
      ? `topScore=${evalResult.topScore.toFixed(2)} (se espera bajo)`
      : (evalResult.hit ? `HIT rank=${evalResult.rank}` : 'MISS');
    console.log(`[${q.type}] ${q.id} ${status} -- ${q.question}`);
  }

  const recallAtK = evaluable ? (hits / evaluable) : 0;
  const mrr = evaluable ? (mrrSum / evaluable) : 0;
  const offtopicScores = results.filter(r => r.type === 'offtopic').map(r => r.topScore);
  const avgOfftopicScore = offtopicScores.length ? offtopicScores.reduce((a, b) => a + b, 0) / offtopicScores.length : null;

  const summary = {
    timestamp: new Date().toISOString(),
    mode: MODE,
    topK: TOP_K,
    totalQuestions: golden.questions.length,
    evaluable,
    hits,
    recallAtK: Math.round(recallAtK * 1000) / 1000,
    mrr: Math.round(mrr * 1000) / 1000,
    avgOfftopicScore: avgOfftopicScore !== null ? Math.round(avgOfftopicScore * 1000) / 1000 : null,
    results
  };

  console.log(`\n=== RESUMEN (modo: ${MODE}) ===`);
  console.log(`Recall@${TOP_K}: ${(recallAtK * 100).toFixed(1)}% (${hits}/${evaluable})`);
  console.log(`MRR: ${mrr.toFixed(3)}`);
  if (avgOfftopicScore !== null) console.log(`Score promedio en preguntas fuera de tema: ${avgOfftopicScore.toFixed(3)} (mientras mas bajo, mejor)`);

  const outDir = path.join(__dirname, '..', 'data', 'eval_results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `eval_${MODE}_${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log(`\nGuardado en ${outFile}`);
}

main().catch(err => { console.error('Error fatal:', err); process.exit(1); });
