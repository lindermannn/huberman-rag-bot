// Fase 3: parsea data/translated/EP-XXX/transcript.md (ya traducidos, con timestamps
// intactos) y los divide en chunks por seccion de timestamp real del propio Huberman Lab
// (## [mm:ss] Titulo). 100% local, sin llamadas a APIs -- solo lectura de archivos.
//
// Uso:
//   node src/build_transcript_chunks.js            -> escribe data/transcript_chunks.json
//   node src/build_transcript_chunks.js --sample 3  -> solo procesa 3 episodios (debug)

const fs = require('fs');
const path = require('path');

const RAW_DIR = path.join(__dirname, '..', 'data', 'translated');
const OUT_FILE = path.join(__dirname, '..', 'data', 'transcript_chunks.json');

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^"|"$/g, '');
  }
  return { meta, body: m[2] };
}

function timestampToSeconds(ts) {
  const parts = ts.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(parts[0]) || 0;
}

const MAX_CHUNK_CHARS = 3000;

// Splits long text into ~MAX_CHUNK_CHARS pieces on sentence boundaries (never mid-sentence).
function splitLongText(text) {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
  const parts = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > MAX_CHUNK_CHARS && cur.length > 0) {
      parts.push(cur.trim());
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function parseTranscript(raw, episodeNumberFallback) {
  const { meta, body } = parseFrontmatter(raw);
  const episodeNumber = meta.episode_number ? parseInt(meta.episode_number, 10) : episodeNumberFallback;
  const episodeDate = meta.episode_date || null;
  const title = meta.title || '';

  // Split on lines like "## [00:23:36] Some Title"
  const headerRe = /^##\s*\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+(.*)$/gm;
  const matches = [...body.matchAll(headerRe)];

  const seenIds = new Set(); // salvaguarda: algunos episodios repiten el mismo timestamp base
  // (marcadores "... cont.", encabezados duplicados en el transcript original, etc.)
  function uniqueId(baseId) {
    if (!seenIds.has(baseId)) { seenIds.add(baseId); return baseId; }
    let n = 2;
    while (seenIds.has(`${baseId}-dup${n}`)) n++;
    const id = `${baseId}-dup${n}`;
    seenIds.add(id);
    return id;
  }

  const chunks = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const tsStart = m[1];
    const sectionTitle = m[2].trim();
    const startIdx = m.index + m[0].length;
    const endIdx = i + 1 < matches.length ? matches[i + 1].index : body.length;
    const text = body.slice(startIdx, endIdx).trim().replace(/\s+/g, ' ');
    const tsEnd = i + 1 < matches.length ? matches[i + 1][1] : null;

    if (text.length < 40) continue; // skip near-empty sections (e.g. ad breaks with no real content)

    const parts = splitLongText(text);
    parts.forEach((part, partIdx) => {
      const baseId = `hub-ep${String(episodeNumber).padStart(3, '0')}-ts${tsStart.replace(/:/g, '')}` + (parts.length > 1 ? `-p${partIdx + 1}` : '');
      chunks.push({
        id: uniqueId(baseId),
        episode_number: episodeNumber,
        episode_date: episodeDate,
        episode_title: title,
        timestamp_start: tsStart,
        timestamp_end: tsEnd,
        timestamp_start_seconds: timestampToSeconds(tsStart),
        section_title: sectionTitle,
        content: part
      });
    });
  }
  return chunks;
}

function main() {
  const sampleArgIdx = process.argv.indexOf('--sample');
  const sampleN = sampleArgIdx !== -1 ? parseInt(process.argv[sampleArgIdx + 1], 10) : null;

  let episodeDirs = fs.readdirSync(RAW_DIR).filter(d => /^EP-\d+$/.test(d)).sort();
  if (sampleN) episodeDirs = episodeDirs.slice(0, sampleN);

  const allChunks = [];
  let episodesOk = 0;
  let episodesSkipped = 0;
  const skippedList = [];

  for (const dir of episodeDirs) {
    const transcriptPath = path.join(RAW_DIR, dir, 'transcript.md');
    if (!fs.existsSync(transcriptPath)) {
      episodesSkipped++;
      skippedList.push(dir + ' (sin transcript.md)');
      continue;
    }
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const epNumFallback = parseInt(dir.replace('EP-', ''), 10);
    const chunks = parseTranscript(raw, epNumFallback);
    if (chunks.length === 0) {
      episodesSkipped++;
      skippedList.push(dir + ' (0 chunks -- sin marcadores de timestamp reconocibles)');
      continue;
    }
    allChunks.push(...chunks);
    episodesOk++;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(allChunks, null, 2), 'utf8');

  console.log(`Episodios procesados OK: ${episodesOk}`);
  console.log(`Episodios saltados: ${episodesSkipped}`);
  if (skippedList.length > 0 && skippedList.length <= 20) {
    console.log('Saltados:', skippedList.join(', '));
  } else if (skippedList.length > 20) {
    console.log('Saltados (primeros 20):', skippedList.slice(0, 20).join(', '));
  }
  console.log(`Total chunks generados: ${allChunks.length}`);
  console.log(`Promedio chunks/episodio: ${(allChunks.length / Math.max(episodesOk, 1)).toFixed(1)}`);
  console.log(`Escrito en: ${OUT_FILE}`);

  if (allChunks.length > 0) {
    console.log('\n=== Ejemplo de chunk ===');
    const sample = allChunks[Math.floor(allChunks.length / 2)];
    console.log(JSON.stringify({ ...sample, content: sample.content.slice(0, 200) + '...' }, null, 2));
  }
}

main();
