// Auditoría + parche automático de TODOS los transcripts ya traducidos, buscando
// los efectos del bug de "falta de contexto entre fragmentos" al traducir con
// cualquier motor (Gemini, Groq, DeepSeek, OpenAI, Anthropic, LM Studio):
//
//   a) Bloques de frontmatter/título FALSOS insertados a mitad de documento.
//   b) Encabezados reales que perdieron el prefijo "## " (quedan como texto
//      plano en vez de encabezado) - visible pero no es pérdida de contenido.
//   c) Contenido realmente RESUMIDO/COMPRIMIDO en vez de traducido completo
//      (el archivo termina mucho más corto de lo esperado) - esto sí es
//      pérdida real de contenido y no se puede reparar, solo retraducir.
//   d) Contenido realmente DUPLICADO (el archivo termina mucho más largo de
//      lo esperado) - tampoco reparable, retraducir.
//
// Estrategia: primero se aplican las reparaciones seguras (a y b), que no
// pierden ni una palabra de la traducción real. Solo DESPUÉS de reparar se
// evalúa si el archivo sigue mostrando señales de pérdida/duplicación real
// de contenido (c y d) -- en ese caso, y solo en ese caso, se descarta.
//
// Uso:
//   node patch_transcripts.js            -> aplica los cambios
//   node patch_transcripts.js --dry-run  -> solo reporta, no modifica nada

const fs = require('fs');
const path = require('path');

const rawPath = path.join(__dirname, 'data', 'raw');
const transPath = path.join(__dirname, 'data', 'translated');
const progressFilePath = path.join(transPath, 'progress.json');

const dryRun = process.argv.includes('--dry-run');

const progress = JSON.parse(fs.readFileSync(progressFilePath, 'utf8'));

let stats = { ok: 0, patched: 0, discarded: 0, missing: 0 };
const patchedList = [];
const discardedList = [];

// ─── Paso 1: quitar bloques de frontmatter/título fantasma a mitad de doc ──
function stripGhostFrontmatter(content) {
  const lines = content.split('\n');
  const out = [];
  let i = 0;
  let realFrontmatterClosed = false;
  let removedBlocks = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (i === 0 && line.trim() === '---') {
      out.push(line);
      i++;
      while (i < lines.length && lines[i].trim() !== '---') {
        out.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        out.push(lines[i]);
        i++;
        realFrontmatterClosed = true;
      }
      continue;
    }

    if (realFrontmatterClosed && line.trim() === '---') {
      let j = i + 1;
      let sawTitle = false;
      let titleIdx = -1;
      let closeIdx = -1;
      while (j < lines.length && j < i + 12) {
        if (/^title:/.test(lines[j])) { sawTitle = true; titleIdx = j; }
        if (lines[j].trim() === '---') { closeIdx = j; break; }
        j++;
      }
      if (sawTitle && closeIdx !== -1) {
        removedBlocks++;
        i = closeIdx + 1;
        continue;
      }
      // Caso sin "---" de cierre: el modelo generó un bloque de frontmatter
      // roto donde "title:" en realidad contiene un párrafo entero del
      // contenido (cientos de caracteres) en vez de un título real. Un
      // título legítimo nunca es tan largo, así que es una señal segura de
      // que hay que descartar solo el bloque "---"/"type:"/"title:" (sin
      // tocar el párrafo real de contenido que sigue después).
      if (sawTitle && lines[titleIdx].length > 300) {
        removedBlocks++;
        i = titleIdx + 1;
        continue;
      }
      out.push(line);
      i++;
      continue;
    }

    out.push(line);
    i++;
  }

  return { content: out.join('\n'), removedBlocks };
}

// ─── Paso 2: restaurar el prefijo "## " en encabezados que lo perdieron ────
// Patrón observado: un encabezado real como "## [02:05:48] Internet Cuántico"
// a veces sale como línea suelta "[02:05:48] Internet Cuántico" (sin "## ").
// Es seguro de arreglar porque no se toca ni una palabra de la traducción,
// solo se restaura el marcador de encabezado.
function restoreMissingHeadingPrefix(content) {
  const lines = content.split('\n');
  let fixedCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\[(\d{2}:\d{2}:\d{2})\]\s+\S.*$/);
    if (m && !lines[i].startsWith('##')) {
      lines[i] = '## ' + lines[i];
      fixedCount++;
    }
  }
  return { content: lines.join('\n'), fixedCount };
}

for (const episodeId of Object.keys(progress)) {
  if (!progress[episodeId].transcript) continue;

  const rawFile = path.join(rawPath, episodeId, 'transcript.md');
  const transFile = path.join(transPath, episodeId, 'transcript.md');

  if (!fs.existsSync(rawFile) || !fs.existsSync(transFile)) {
    stats.missing++;
    continue;
  }

  // Normalizar a \n antes de cualquier split/join por línea, para no dejar
  // '\r' sueltos si el archivo se guardó con saltos de línea estilo Windows.
  const rawContent = fs.readFileSync(rawFile, 'utf8').replace(/\r\n/g, '\n');
  let transContent = fs.readFileSync(transFile, 'utf8').replace(/\r\n/g, '\n');

  const rawLen = rawContent.length;

  // Algunos episodios (formato más reciente) no usan encabezados "## " en
  // absoluto -- son transcripciones estilo subtítulos con un timestamp al
  // inicio de CADA línea (ej. "[00:00:05] texto..."). Para esos, restaurar
  // "## " sería un error grave (convertiría miles de líneas en encabezados
  // falsos), y el conteo de encabezados no significa nada -- se debe omitir
  // por completo esa reparación y esa señal de descarte para esos episodios.
  const rawHeaders = (rawContent.match(/^## /gm) || []).length;
  const usesHeadingStyle = rawHeaders > 0;

  // Aplicar reparaciones seguras primero.
  const step1 = stripGhostFrontmatter(transContent);
  transContent = step1.content;
  let step2 = { content: transContent, fixedCount: 0 };
  if (usesHeadingStyle) {
    step2 = restoreMissingHeadingPrefix(transContent);
    transContent = step2.content;
  }

  const wasPatched = step1.removedBlocks > 0 || step2.fixedCount > 0;

  // Re-evaluar DESPUÉS de reparar.
  const transLen = transContent.length;
  const titleCount = (transContent.match(/^title:/gm) || []).length;
  const transHeaders = (transContent.match(/^## /gm) || []).length;
  const headerDiff = transHeaders - rawHeaders;
  const ratio = transLen / rawLen;

  // Umbrales calibrados con casos reales verificados manualmente:
  //   - Traducción completa y fiel: ratio ~0.95x-1.20x (el español suele ser
  //     un poco más largo, pero no siempre).
  //   - ratio < 0.85: fuerte señal de contenido resumido/perdido (caso real
  //     verificado: EP-247 con 0.54x tenía ~50% del contenido faltante).
  //   - ratio > 1.40: fuerte señal de contenido duplicado.
  const looksTruncated = ratio < 0.85;
  const looksInflated = ratio > 1.40;
  const stillHasGhostTitle = titleCount > 1;
  const stillMissingHeaders = usesHeadingStyle && headerDiff <= -2;

  const needsDiscard = looksTruncated || looksInflated || stillHasGhostTitle || stillMissingHeaders;

  if (needsDiscard) {
    stats.discarded++;
    discardedList.push({
      episodeId,
      ratio: ratio.toFixed(2),
      titleCount,
      headerDiff,
      reason: looksTruncated ? 'contenido resumido/incompleto (~' + Math.round((1 - ratio) * 100) + '% faltante)'
        : looksInflated ? 'contenido duplicado/inflado'
        : stillHasGhostTitle ? 'título fantasma no reparable automáticamente'
        : 'encabezados faltantes tras reparación',
    });
    if (!dryRun) {
      fs.unlinkSync(transFile);
      progress[episodeId].transcript = false;
    }
    continue;
  }

  if (wasPatched) {
    stats.patched++;
    patchedList.push({ episodeId, removedBlocks: step1.removedBlocks, headingsFixed: step2.fixedCount, headersAfter: transHeaders, rawHeaders });
    if (!dryRun) {
      fs.writeFileSync(transFile, transContent, 'utf8');
    }
    continue;
  }

  stats.ok++;
}

if (!dryRun) {
  fs.writeFileSync(progressFilePath, JSON.stringify(progress, null, 2));
}

console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Auditoría completa:`);
console.log(`  OK sin cambios: ${stats.ok}`);
console.log(`  Reparados automáticamente (sin perder contenido): ${stats.patched}`);
console.log(`  Descartados (requieren retraducción): ${stats.discarded}`);
console.log(`  Con archivo faltante: ${stats.missing}`);

if (patchedList.length > 0) {
  console.log('\n--- Reparados ---');
  patchedList.forEach(p => console.log(`  ${p.episodeId}: ${p.removedBlocks} bloque(s) fantasma quitados, ${p.headingsFixed} encabezado(s) con prefijo "##" restaurado. Encabezados: ${p.headersAfter}/${p.rawHeaders}`));
}

if (discardedList.length > 0) {
  console.log('\n--- Descartados (progreso revertido) ---');
  discardedList.forEach(d => console.log(`  ${d.episodeId}: ratio=${d.ratio}x, títulos=${d.titleCount}, diff encabezados=${d.headerDiff} - ${d.reason}`));
}
