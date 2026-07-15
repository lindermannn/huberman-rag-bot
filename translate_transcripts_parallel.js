// Traduce los transcripts faltantes en PARALELO usando TODAS las keys
// disponibles de Gemini Y Groq a la vez. Cada key = un proceso propio con un
// lote de episodios que no se solapa con los demás, así se aprovecha el cupo
// diario de cada key (y de cada proveedor) al mismo tiempo.
//
// Uso:
//   node translate_transcripts_parallel.js            -> reparte TODOS los transcripts faltantes
//   node translate_transcripts_parallel.js 20          -> reparte solo 20 episodios (para probar)
//
// Requiere en .env: GEMINI_API_KEY(_2.._6) y/o GROQ_API_KEY(_2.._5)

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config();

const rawPath = path.join(__dirname, 'data', 'raw');
const transPath = path.join(__dirname, 'data', 'translated');
const translateJsPath = path.join(__dirname, 'src', 'translate.js').replace(/\\/g, '\\\\');

// ─── Detectar todas las keys disponibles por motor ────────────────────────
function detectKeys(prefix) {
  const keys = [];
  if (process.env[prefix]) keys.push(process.env[prefix]);
  let i = 2;
  while (process.env[`${prefix}_${i}`]) {
    keys.push(process.env[`${prefix}_${i}`]);
    i++;
  }
  return keys;
}

const engineConfigs = [
  { engine: 'gemini', prefix: 'GEMINI_API_KEY', maxIndex: 20 },
  { engine: 'groq', prefix: 'GROQ_API_KEY', maxIndex: 20 },
  { engine: 'deepseek', prefix: 'DEEPSEEK_API_KEY', maxIndex: 20 },
];

const workers = []; // { engine, key, prefix, maxIndex }
for (const cfg of engineConfigs) {
  const keys = detectKeys(cfg.prefix);
  keys.forEach(key => workers.push({ engine: cfg.engine, key, prefix: cfg.prefix, maxIndex: cfg.maxIndex }));
  console.log(`Keys de ${cfg.engine} detectadas: ${keys.length}`);
}

if (workers.length === 0) {
  console.error('ERROR: No se encontraron keys de Gemini ni Groq en el archivo .env.');
  process.exit(1);
}

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

console.log(`\nTotal workers (keys) disponibles: ${workers.length}`);
console.log(`Episodios pendientes a traducir en esta corrida: ${pending.length}\n`);

if (pending.length === 0) {
  console.log('No hay episodios pendientes. Nada que hacer.');
  process.exit(0);
}

// ─── Repartir episodios entre TODOS los workers (round robin) ────────────
const buckets = workers.map(() => []);
pending.forEach((id, idx) => {
  buckets[idx % workers.length].push(id);
});

console.log('Reparto de episodios por worker:');
buckets.forEach((b, idx) => {
  const w = workers[idx];
  console.log(`  Worker ${idx + 1} [${w.engine}]: ${b.length} episodios`);
});
console.log('');

// ─── Lanzar un proceso hijo por cada key, con SOLO esa key visible ────────
let finished = 0;
const total = buckets.filter(b => b.length > 0).length;

buckets.forEach((bucket, idx) => {
  if (bucket.length === 0) return;

  const worker = workers[idx];
  const workerNum = idx + 1;
  const childEnv = { ...process.env };

  // Aislar: el hijo solo debe ver UNA key para su propio motor (las demás
  // keys de ESE MISMO motor se dejan en '' para que dotenv.config() -llamado
  // dentro de translate.js- no las vuelva a rellenar desde el .env).
  for (let n = 2; n <= worker.maxIndex; n++) childEnv[`${worker.prefix}_${n}`] = '';
  childEnv[worker.prefix] = worker.key;

  const script = `
    const { runTranslation } = require('${translateJsPath}');
    runTranslation({
      engine: '${worker.engine}',
      mode: 'transcripts',
      limit: 'all',
      episodeIds: ${JSON.stringify(bucket)},
    }).then(() => process.exit(0)).catch(err => { console.error('WORKER ERROR:', err.message); process.exit(1); });
  `;

  const child = spawn(process.execPath, ['-e', script], { env: childEnv, cwd: __dirname });

  child.stdout.on('data', data => {
    data.toString().split('\n').filter(Boolean).forEach(line => {
      console.log(`[W${workerNum}:${worker.engine}] ${line}`);
    });
  });
  child.stderr.on('data', data => {
    data.toString().split('\n').filter(Boolean).forEach(line => {
      console.error(`[W${workerNum}:${worker.engine}] ${line}`);
    });
  });

  child.on('close', code => {
    finished++;
    console.log(`\n>>> Worker ${workerNum} [${worker.engine}] terminó (código ${code}). Workers finalizados: ${finished}/${total}\n`);
    if (finished === total) {
      console.log('\nTodos los workers terminaron. Traducción paralela completa.');
    }
  });
});
