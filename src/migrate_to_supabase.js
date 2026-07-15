// Migracion one-time de la KB de Huberman a Supabase (kb_documents, pgvector).
// Corre 100% local -- no toca n8n Cloud, evita el limite de memoria del workspace.
//
// Uso (PowerShell):
//   $env:OPENAI_API_KEY = "sk-..."
//   $env:SUPABASE_SERVICE_ROLE_KEY = "sb_secret_..."
//   node src/migrate_to_supabase.js
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

const DATES = require(path.join(__dirname, '..', 'data', 'episode-dates.json'));

function parseCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = [];
    let cur = '';
    let inQuotes = false;
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (inQuotes) {
        if (c === '"' && line[j + 1] === '"') { cur += '"'; j++; }
        else if (c === '"') { inQuotes = false; }
        else { cur += c; }
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { fields.push(cur); cur = ''; }
        else cur += c;
      }
    }
    fields.push(cur);
    const [id, topic, textField, active] = fields;
    rows.push({ id, topic, text: textField, active });
  }
  return rows;
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
  const v1 = parseCsv(path.join(__dirname, '..', 'data', 'huberman-kb-v1.csv'));
  const additions = parseCsv(path.join(__dirname, '..', 'data', 'huberman-kb-additions.csv'));
  const all = [...v1, ...additions].filter(r => r.id && r.active === 'true');

  console.log(`Filas a migrar: ${all.length}`);

  const rows = all.map(r => {
    const m = String(r.id).match(/hub-ep(\d+)-/);
    const epNum = m ? m[1] : null;
    return {
      id: r.id,
      tenant_id: TENANT_ID,
      topic: r.topic || 'general',
      content: r.text,
      episode_number: epNum ? parseInt(epNum, 10) : null,
      episode_date: epNum && DATES[epNum] ? DATES[epNum] : null
    };
  });

  const totalBatches = Math.ceil(rows.length / BATCH_SIZE);
  let inserted = 0;
  const startTime = Date.now();

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = rows.slice(i, i + BATCH_SIZE);

    const embeddings = await computeEmbeddings(batch.map(r => r.content));
    const batchWithEmbeddings = batch.map((r, idx) => ({ ...r, embedding: embeddings[idx] }));

    await insertBatch(batchWithEmbeddings);
    inserted += batch.length;

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Lote ${batchNum}/${totalBatches} OK -- ${inserted}/${rows.length} filas insertadas (${elapsed}s)`);
  }

  console.log(`\nMigracion completa: ${inserted} filas insertadas en kb_documents.`);
}

main().catch(err => {
  console.error('\nError fatal:', err);
  process.exit(1);
});
