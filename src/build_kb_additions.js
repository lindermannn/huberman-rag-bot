// Genera las filas ADICIONALES (no incluidas en huberman-kb-v1.csv):
// - Resumen general de cada episodio (## Resumen del Episodio / Descripcion general del episodio)
// - Recursos mencionados de cada episodio (seccion completa, sin sub-parsear estudios/patrocinadores)
// Se pegan al FINAL del CSV existente en el Sheet, no lo reemplazan.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'data', 'translated');
const OUT = path.join(__dirname, '..', 'data', 'huberman-kb-additions.csv');

function slugify(s) {
  return String(s || 'general')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'general';
}

function csvEscape(v) {
  const s = String(v == null ? '' : v).replace(/\r?\n/g, ' ').trim();
  if (/[",]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = { temas: [], etiquetas: [] };
  if (!m) return fm;
  const lines = m[1].split(/\r?\n/);
  let mode = null;
  for (const line of lines) {
    if (/^temas:\s*$/.test(line)) { mode = 'temas'; continue; }
    if (/^etiquetas:\s*$/.test(line)) { mode = 'etiquetas'; continue; }
    const listItem = line.match(/^-\s*(.+)$/);
    if (mode && listItem) { fm[mode].push(listItem[1].trim()); continue; }
    const kv = line.match(/^([a-zA-Záéíóúñ_]+):\s*(.*)$/);
    if (kv) {
      mode = null;
      fm[kv[1]] = kv[2].replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1').trim();
    }
  }
  return fm;
}

function stripInline(s) {
  return s
    .replace(/\[(\d{2}:\d{2}:\d{2}|\d{2}:\d{2})\]\([^)]*\)/g, '')
    .replace(/\*\*/g, '')
    .replace(/#{1,4}\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractSection(md, headerPattern) {
  const re = new RegExp('##\\s*(?:' + headerPattern + ')[^\\r\\n]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s|$)', 'i');
  const m = md.match(re);
  return m ? m[1] : '';
}

const OVERVIEW_HEADER = 'Resumen del Episodio|Descripci[oó]n general del episodio';
const RESOURCES_HEADER = 'Recursos(?:\\s+Mencionados)?';

const episodes = fs.readdirSync(ROOT).filter(d => /^EP-\d+$/.test(d)).sort();
const rows = [['id', 'topic', 'text', 'active']];
let epCount = 0, overviewCount = 0, resourceCount = 0;

for (const ep of episodes) {
  const file = path.join(ROOT, ep, 'summary.md');
  if (!fs.existsSync(file)) continue;
  const md = fs.readFileSync(file, 'utf8');
  const fm = parseFrontmatter(md);
  const epNum = String(fm.número_episodio || ep.replace('EP-', '')).padStart(3, '0');
  const primaryTopic = slugify((fm.temas && fm.temas[0]) || 'neurociencia');
  const guest = fm.invitado || '';
  const titleLine = (md.match(/^#\s*Episodio\s*\d+:\s*(.+)$/m) || [])[1] || '';

  const overviewSection = extractSection(md, OVERVIEW_HEADER);
  const overviewText = stripInline(overviewSection).slice(0, 1200);
  if (overviewText.length > 40) {
    const prefix = 'Episodio ' + parseInt(epNum, 10) + (titleLine ? ' - ' + titleLine : '') + (guest ? ' (invitado: ' + guest + ')' : '') + '. ';
    rows.push([`hub-ep${epNum}-overview`, primaryTopic, prefix + overviewText, 'true']);
    overviewCount++;
  }

  const resourcesSection = extractSection(md, RESOURCES_HEADER);
  const resourcesText = stripInline(resourcesSection).slice(0, 1500);
  if (resourcesText.length > 40) {
    const prefix = 'Recursos y estudios mencionados en el episodio ' + parseInt(epNum, 10) + (titleLine ? ' (' + titleLine + ')' : '') + ': ';
    rows.push([`hub-ep${epNum}-recursos`, primaryTopic, prefix + resourcesText, 'true']);
    resourceCount++;
  }

  if (overviewText.length > 40 || resourcesText.length > 40) epCount++;
}

const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
fs.writeFileSync(OUT, csv, 'utf8');

console.log(JSON.stringify({ episodesProcessed: epCount, overviewRows: overviewCount, resourceRows: resourceCount, totalRows: rows.length - 1, outFile: OUT }, null, 2));
