// Fase 3: sube los chunks de transcript (data/transcript_chunks.json, generados por
// build_transcript_chunks.js) a kb_documents, con timestamp real de origen.
// Corre 100% local. No borra ni toca las filas de resumen existentes -- las agrega aparte
// (topic='transcript_segment'), asi que es reversible: si el eval no mejora, se puede borrar
// solo este lote (DELETE FROM kb_documents WHERE topic = 'transcript_segment').
//
// Requiere primero correr el SQL de sql/add_transcript_timestamp_columns.sql en Supabase.
//
// Uso (PowerShell):
//   $env:OPENAI_API_KEY = "sk-..."
//   $env:SUPABASE_SERVICE_ROLE_KEY = "sb_secret_..."
//   node src/build_transcript_chunks.js        (si no lo corriste antes)
//   node src/migrate_transcript_chunks_to_supabase.js
//
// Es idempotente (upsert por id), asi que si se corta a la mitad, se puede
// volver a correr sin duplicar ni gastar de mas.

const fs = require('fs');
const path = require('path');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_URL = 'https://lmyqexbucniromvnudjo.supabase.co/rest/v1/kb_documents';
const TENANT_ID = 'tenant_huberman';
const BATCH_SIZE = 100;

if (!OPENAI_KEY) {
  console.error('Falta la variable de entorno OPENAI_API_KEY.');
  process.exit(1);
}
if (!SUPABASE_KEY) {
  console.error('Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const CHUNKS_FILE = path.join(__dirname, '..', 'data', 'transcript_chunks.json');
if (!fs.existsSync(CHUNKS_FILE)) {
  console.error(`No existe ${CHUNKS_FILE}. Corre primero: node src/build_transcript_chunks.js`);
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, label, maxTries = 4) {
  let lastErr;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const wait = 1000 * Math.pow(2, attempt - 1);
      console.warn(`  ${label} fallo (intento ${attempt}/${maxTries}): ${err.message}. Reintentando en ${wait}ms...`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function computeEmbeddings(texts) {
  return withRetry(async () => {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts })
    });
    const body = await res.json();
    if (!res.ok || !body.data) {
      throw new Error(`OpenAI ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
    return body.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
  }, 'OpenAI embeddings');
}

async function insertBatch(rows) {
  return withRetry(async () => {
    const res = await fetch(SUPABASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(rows)
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase ${res.status}: ${body.slice(0, 300)}`);
    }
  }, 'Supabase insert');
}

async function main() {
  const chunks = JSON.parse(fs.readFileSync(CHUNKS_FILE, 'utf8'));
  console.log(`Chunks a migrar: ${chunks.length}`);

  const rows = chunks.map(c => ({
    id: c.id,
    tenant_id: TENANT_ID,
    topic: 'transcript_segment',
    content: c.content,
    episode_number: c.episode_number,
    episode_date: c.episode_date,
    timestamp_start: c.timestamp_start,
    timestamp_end: c.timestamp_end,
    // texto usado SOLO para calcular el embedding (mejor retrieval con el titulo de seccion);
    // lo que se guarda y se le muestra al agente es "content" (arriba), sin el titulo pegado.
    _embedInput: `${c.section_title}. ${c.content}`
  }));

  const totalBatches = Math.ceil(rows.length / BATCH_SIZE);
  let inserted = 0;
  const startTime = Date.now();

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = rows.slice(i, i + BATCH_SIZE);

    const embeddings = await computeEmbeddings(batch.map(r => r._embedInput));
    const batchWithEmbeddings = batch.map((r, idx) => {
      const { _embedInput, ...rest } = r;
      return { ...rest, embedding: embeddings[idx] };
    });

    await insertBatch(batchWithEmbeddings);
    inserted += batch.length;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Lote ${batchNum}/${totalBatches} OK -- ${inserted}/${rows.length} filas insertadas (${elapsed}s)`);
  }

  console.log(`\nMigracion completa: ${inserted} chunks de transcript insertados en kb_documents (topic='transcript_segment').`);
  console.log('Las filas de resumen existentes (topic != transcript_segment) no se tocaron.');
}

main().catch(err => {
  console.error('\nError fatal:', err);
  process.exit(1);
});
