// Verifica la integridad estructural de los transcripts ya traducidos,
// comparando el número de encabezados "## " entre el original (raw) y la
// traducción. Si no coinciden, es señal de un encabezado alucinado (de más)
// u omitido (de menos) durante la traducción con LM Studio/Groq/etc.
//
// Uso:
//   node verify_transcripts.js

const fs = require('fs');
const path = require('path');

const rawPath = path.join(__dirname, 'data', 'raw');
const transPath = path.join(__dirname, 'data', 'translated');

const progress = JSON.parse(fs.readFileSync(path.join(transPath, 'progress.json'), 'utf8'));

function countHeaders(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return (content.match(/^## /gm) || []).length;
}

function countFrontmatterFences(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return (content.match(/^---$/gm) || []).length;
}

let ok = 0;
let mismatched = [];
let missingFile = [];
let strayFrontmatter = [];

for (const episodeId of Object.keys(progress)) {
  if (!progress[episodeId].transcript) continue;

  const rawFile = path.join(rawPath, episodeId, 'transcript.md');
  const transFile = path.join(transPath, episodeId, 'transcript.md');

  if (!fs.existsSync(rawFile) || !fs.existsSync(transFile)) {
    missingFile.push(episodeId);
    continue;
  }

  const rawCount = countHeaders(rawFile);
  const transCount = countHeaders(transFile);

  if (rawCount === transCount) {
    ok++;
  } else {
    mismatched.push({ episodeId, rawCount, transCount, diff: transCount - rawCount });
  }

  // Algunos episodios usan "---" como separador legítimo entre secciones (no solo
  // en el frontmatter), así que comparamos contra el conteo real del original en
  // vez de asumir que siempre debe ser 2.
  const rawFenceCount = countFrontmatterFences(rawFile);
  const transFenceCount = countFrontmatterFences(transFile);
  if (transFenceCount !== rawFenceCount) {
    strayFrontmatter.push({ episodeId, rawFenceCount, transFenceCount });
  }
}

console.log(`\nEpisodios con transcript traducido: ${ok + mismatched.length + missingFile.length}`);
console.log(`  OK (encabezados coinciden): ${ok}`);
console.log(`  Con diferencias: ${mismatched.length}`);
console.log(`  Con archivo faltante: ${missingFile.length}`);

if (mismatched.length > 0) {
  console.log('\n--- Episodios a revisar manualmente ---');
  mismatched.forEach(m => {
    const tipo = m.diff > 0 ? `+${m.diff} de más (posible alucinación)` : `${m.diff} (posible encabezado omitido)`;
    console.log(`  ${m.episodeId}: raw=${m.rawCount} traducido=${m.transCount}  ->  ${tipo}`);
  });
}

if (missingFile.length > 0) {
  console.log('\n--- Marcados como completos pero sin archivo ---');
  missingFile.forEach(id => console.log(`  ${id}`));
}

if (strayFrontmatter.length > 0) {
  console.log('\n--- Posible frontmatter/separador fantasma (conteo de "---" no coincide con el original) ---');
  strayFrontmatter.forEach(s => console.log(`  ${s.episodeId}: raw=${s.rawFenceCount} traducido=${s.transFenceCount}`));
}
