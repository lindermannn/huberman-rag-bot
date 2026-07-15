// Traduce los transcripts faltantes en PARALELO usando varias API keys de Groq
// a la vez (una key = un proceso = un lote de episodios no solapado con los
// demás). Esto multiplica la velocidad ~Nx respecto a usar una sola key,
// porque cada key tiene su propio cupo independiente en Groq.
//
// Uso:
//   node translate_transcripts_parallel_groq.js            -> reparte TODOS los transcripts faltantes
//   node translate_transcripts_parallel_groq.js 20          -> reparte solo 20 episodios entre las keys (para probar)
//
// Requiere GROQ_API_KEY, GROQ_API_KEY_2, GROQ_API_KEY_3, ... en el archivo .env

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config();

const rawPath = path.join(__dirname, 'data', 'raw');
const transPath = path.join(__dirname, 'data', 'translated');

// ─── Detectar todas las keys de Groq disponibles ──────────────────────────
const groqKeys = [];
if (process.env.GROQ_API_KEY) groqKeys.push(process.env.GROQ_API_KEY);
let i = 2;
while (process.env[`GROQ_API_KEY_${i}`]) {
  groqKeys.push(process.env[`GROQ_API_KEY_${i}`]);
  i++;
}

if (groqKeys.length === 0) {
  console.error('ERROR: No se encontraron keys de Groq en el archivo .env.');
  process.exit(1);
}

console.log(`Keys de Groq detectadas: ${groqKeys.length}`);

// ─── Calcular episodios pendientes de traducir (transcript) ───────────────
const metadata = JSON.parse(fs.readFileSync(path.join(rawPath, 'index.json'), 'utf8'));
let progress = {};
const progressFilePath = path.join(transPath, 'progress.json');
if (fs.existsSync(progressFilePath)) {
  progress = JSON.parse(fs.readFileSync(progressFilePath, 'utf8'));
}

let pending = Object.keys(metadata).filter(id => {
  const hasTranscript = metadata[id].hasTranscript;
  const alreadyDone = progress[id] && progress[id].transcript;
  return hasTranscript && !alreadyDone;
});

const limitArg = process.argv[2];
if (limitArg) {
  pending = pending.slice(0, parseInt(limitArg, 10));
}

console.log(`Episodios pendientes a traducir en esta corrida: ${pending.length}`);

if (pending.length === 0) {
  console.log('No hay episodios pendientes. Nada que hacer.');
  process.exit(0);
}

// ─── Repartir episodios entre las keys (round robin) ──────────────────────
const buckets = groqKeys.map(() => []);
pending.forEach((id, idx) => {
  buckets[idx % groqKeys.length].push(id);
});

console.log('Reparto de episodios por worker:');
buckets.forEach((b, idx) => console.log(`  Worker ${idx + 1} (key #${idx + 1}): ${b.length} episodios`));
console.log('');

// ─── Lanzar un proceso hijo por cada key, con SOLO esa key visible ────────
let finished = 0;
const total = buckets.filter(b => b.length > 0).length;

buckets.forEach((bucket, idx) => {
  if (bucket.length === 0) return;

  const workerNum = idx + 1;
  const childEnv = { ...process.env };
  // Aislar: el hijo solo debe ver UNA key de Groq, bajo el nombre GROQ_API_KEY.
  // OJO: dotenv.config() (llamado dentro de translate.js) vuelve a leer el
  // archivo .env y RELLENA cualquier variable que falte en process.env, así
  // que no basta con `delete` — hay que dejarlas en '' para que dotenv las
  // considere "ya definidas" y no las sobrescriba.
  for (let n = 2; n <= 20; n++) childEnv[`GROQ_API_KEY_${n}`] = '';
  childEnv.GROQ_API_KEY = groqKeys[idx];

  const script = `
    const { runTranslation } = require('${path.join(__dirname, 'src', 'translate.js').replace(/\\/g, '\\\\')}');
    runTranslation({
      engine: 'groq',
      mode: 'transcripts',
      limit: 'all',
      episodeIds: ${JSON.stringify(bucket)},
    }).then(() => process.exit(0)).catch(err => { console.error('WORKER ERROR:', err.message); process.exit(1); });
  `;

  const child = spawn(process.execPath, ['-e', script], { env: childEnv, cwd: __dirname });

  child.stdout.on('data', data => {
    data.toString().split('\n').filter(Boolean).forEach(line => {
      console.log(`[W${workerNum}] ${line}`);
    });
  });
  child.stderr.on('data', data => {
    data.toString().split('\n').filter(Boolean).forEach(line => {
      console.error(`[W${workerNum}] ${line}`);
    });
  });

  child.on('close', code => {
    finished++;
    console.log(`\n>>> Worker ${workerNum} terminó (código ${code}). Workers finalizados: ${finished}/${total}\n`);
    if (finished === total) {
      console.log('\nTodos los workers terminaron. Traducción paralela completa.');
    }
  });
});
