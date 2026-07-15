// Genera el mapa episode_number -> youtube_id leyendo el frontmatter de cada
// transcript traducido. Es un artefacto de build: la salida (un objeto JS literal)
// se incrusta en el nodo "Format RAG Response" de module-rag-v3 para construir
// links de YouTube al minuto exacto (https://youtu.be/<id>?t=<seg>).
// 100% local, solo lectura de archivos.
//
// Uso: node src/gen_youtube_map.js  -> escribe data/youtube_map.json y data/youtube_map.literal.txt

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'translated');
const eps = fs.readdirSync(DIR).filter(d => /^EP-\d+$/.test(d)).sort();

const map = {};
let ok = 0, miss = 0;
const missList = [];

for (const d of eps) {
  const f = path.join(DIR, d, 'transcript.md');
  if (!fs.existsSync(f)) { miss++; missList.push(d + ' (sin transcript.md)'); continue; }
  const raw = fs.readFileSync(f, 'utf8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) { miss++; missList.push(d + ' (sin frontmatter)'); continue; }
  const numM = fm[1].match(/^episode_number:\s*(\d+)/m);
  const ytM = fm[1].match(/^youtube_id:\s*(\S+)/m);
  // Algunos frontmatter traen el id entre comillas (youtube_id: "abc"), otros no.
  // Limpiar comillas envolventes y validar el charset real de un id de YouTube (11 chars [A-Za-z0-9_-]).
  const ytRaw = ytM ? ytM[1].replace(/^["']|["']$/g, '') : '';
  const ytValid = /^[A-Za-z0-9_-]{11}$/.test(ytRaw);
  if (numM && ytValid) { map[Number(numM[1])] = ytRaw; ok++; }
  else if (numM && ytM && !ytValid) { miss++; missList.push(d + ' (youtube_id invalido: "' + ytRaw + '")'); }
  else { miss++; missList.push(d + ' (sin episode_number o youtube_id)'); }
}

const keys = Object.keys(map).map(Number).sort((a, b) => a - b);
const literal = '{' + keys.map(k => k + ':"' + map[k] + '"').join(',') + '}';

fs.writeFileSync(path.join(__dirname, '..', 'data', 'youtube_map.json'), JSON.stringify(map, null, 0), 'utf8');
fs.writeFileSync(path.join(__dirname, '..', 'data', 'youtube_map.literal.txt'), literal, 'utf8');

console.log('Episodios con youtube_id:', ok, '| sin:', miss, '| entradas:', keys.length);
console.log('Tamano del literal (chars):', literal.length);
if (missList.length) console.log('Faltantes:', missList.join(', '));
console.log('Muestra:', literal.slice(0, 100) + '...');
