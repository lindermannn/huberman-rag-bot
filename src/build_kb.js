// Convierte data/translated/EP-XXX/summary.md en un CSV de Knowledge Base
// (esquema id,topic,text,active) compatible con module-rag-v3 / Google Sheets.
// Fuente: Conclusiones clave + Herramientas y protocolos de cada episodio.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'data', 'translated');
const OUT = path.join(__dirname, '..', 'data', 'huberman-kb-v1.csv');

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
    .replace(/\[(\d{2}:\d{2}:\d{2}|\d{2}:\d{2})\]\([^)]*\)/g, '') // [00:05:00](link)
    .replace(/\*\*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// headerPattern es un fragmento de regex (sin anclas) que cubre las variantes de titulo
// observadas en el corpus (distintas corridas de traduccion usaron distinta redaccion).
function extractSection(md, headerPattern) {
  const re = new RegExp('##\\s*(?:' + headerPattern + ')[^\\r\\n]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s|$)', 'i');
  const m = md.match(re);
  return m ? m[1] : '';
}

const TAKEAWAYS_HEADER = 'Puntos\\s+Clave|Conclusiones\\s+clave|Hallazgos\\s+Clave';
const PROTOCOLS_HEADER = 'Herramientas\\s+y\\s+Protocolos';

function parseTakeaways(section) {
  if (!section) return [];
  // Cada item empieza en una linea "- **Titulo...** " o "1. **Titulo...** " y puede
  // seguir en lineas siguientes hasta el proximo bullet/numero o fin de seccion.
  const items = [];
  const parts = section.split(/\r?\n(?=(?:-\s*|\d+\.\s*)\*\*)/);
  for (const p of parts) {
    const cleaned = stripInline(p.replace(/^\d+\.\s*/, '').replace(/^-\s*/, ''));
    if (cleaned.length > 15) items.push(cleaned);
  }
  return items;
}

function parseProtocols(section) {
  if (!section) return [];
  const blocks = section.split(/\r?\n(?=###\s)/).filter(b => /^###\s/.test(b.trim()));
  const items = [];
  for (const b of blocks) {
    const titleM = b.match(/^###\s*(.+)/);
    const title = titleM ? titleM[1].trim() : 'Protocolo';
    const que = (b.match(/\*\*Qu[eé]:\*\*\s*(.+)/i) || [])[1] || '';
    const como = (b.match(/\*\*C[oó]mo:\*\*\s*(.+)/i) || [])[1] || '';
    const cuando = (b.match(/\*\*Cu[aá]ndo:\*\*\s*(.+)/i) || [])[1] || '';
    const text = stripInline(`${title}. Que: ${que} Como: ${como} Cuando: ${cuando}`);
    if (text.length > 20) items.push(text);
  }
  return items;
}

const episodes = fs.readdirSync(ROOT).filter(d => /^EP-\d+$/.test(d)).sort();
const rows = [['id', 'topic', 'text', 'active']];
let epCount = 0, tkCount = 0, protoCount = 0;

for (const ep of episodes) {
  const file = path.join(ROOT, ep, 'summary.md');
  if (!fs.existsSync(file)) continue;
  const md = fs.readFileSync(file, 'utf8');
  const fm = parseFrontmatter(md);
  const epNum = String(fm.número_episodio || ep.replace('EP-', '')).padStart(3, '0');
  const primaryTopic = slugify((fm.temas && fm.temas[0]) || 'neurociencia');

  const takeSection = extractSection(md, TAKEAWAYS_HEADER);
  const protoSection = extractSection(md, PROTOCOLS_HEADER);

  const takeaways = parseTakeaways(takeSection);
  const protocols = parseProtocols(protoSection);

  takeaways.forEach((t, i) => {
    rows.push([`hub-ep${epNum}-tk${i + 1}`, primaryTopic, t, 'true']);
    tkCount++;
  });
  protocols.forEach((p, i) => {
    rows.push([`hub-ep${epNum}-proto${i + 1}`, primaryTopic, p, 'true']);
    protoCount++;
  });
  if (takeaways.length || protocols.length) epCount++;
}

const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
fs.writeFileSync(OUT, csv, 'utf8');

console.log(JSON.stringify({ episodesProcessed: epCount, takeaways: tkCount, protocols: protoCount, totalRows: rows.length - 1, outFile: OUT }, null, 2));
