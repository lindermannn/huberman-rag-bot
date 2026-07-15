const fs = require('fs');
const path = require('path');

const rawPath = path.resolve(__dirname, '..', 'data', 'raw');
const transPath = path.resolve(__dirname, '..', 'data', 'translated');
const dbPath = path.resolve(__dirname, '..', 'data', 'database');

// Ensure output directory exists
if (!fs.existsSync(dbPath)) {
  fs.mkdirSync(dbPath, { recursive: true });
}
const episodesDbPath = path.join(dbPath, 'episodes');
if (!fs.existsSync(episodesDbPath)) {
  fs.mkdirSync(episodesDbPath, { recursive: true });
}

// Helper to extract title from markdown content
function extractTitleFromMarkdown(mdContent, fallback) {
  if (!mdContent) return fallback;
  const lines = mdContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      // Remove '# ' and any leading episode numbers if present, e.g., '# EP-001 - Title' -> 'Title'
      let title = trimmed.substring(2).trim();
      const dashIndex = title.indexOf(' - ');
      if (dashIndex !== -1 && title.startsWith('EP-')) {
        title = title.substring(dashIndex + 3).trim();
      }
      return title;
    }
  }
  return fallback;
}

function buildDatabase() {
  const indexFilePath = path.join(rawPath, 'index.json');
  if (!fs.existsSync(indexFilePath)) {
    console.error('ERROR: raw index.json not found. Please run extraction first.');
    return;
  }

  const rawMetadata = JSON.parse(fs.readFileSync(indexFilePath, 'utf8'));
  const episodeIds = Object.keys(rawMetadata);

  console.log(`Building database from ${episodeIds.length} episodes...`);

  const dbIndex = [];
  let compiledCount = 0;

  for (const episodeId of episodeIds) {
    const ep = rawMetadata[episodeId];
    
    // Read raw English content
    let summaryEn = '';
    let transcriptEn = '';
    const summaryEnPath = path.join(rawPath, episodeId, 'summary.md');
    const transcriptEnPath = path.join(rawPath, episodeId, 'transcript.md');

    if (fs.existsSync(summaryEnPath)) {
      summaryEn = fs.readFileSync(summaryEnPath, 'utf8');
    }
    if (fs.existsSync(transcriptEnPath)) {
      transcriptEn = fs.readFileSync(transcriptEnPath, 'utf8');
    }

    // Read translated Spanish content
    let summaryEs = '';
    let transcriptEs = '';
    const summaryEsPath = path.join(transPath, episodeId, 'summary.md');
    const transcriptEsPath = path.join(transPath, episodeId, 'transcript.md');

    if (fs.existsSync(summaryEsPath)) {
      summaryEs = fs.readFileSync(summaryEsPath, 'utf8');
    }
    if (fs.existsSync(transcriptEsPath)) {
      transcriptEs = fs.readFileSync(transcriptEsPath, 'utf8');
    }

    // Extract titles
    const titleEn = extractTitleFromMarkdown(summaryEn, ep.title);
    const titleEs = extractTitleFromMarkdown(summaryEs, titleEn); // Fallback to English title if not translated

    // Build the full episode object
    const episodeData = {
      id: episodeId,
      title_en: titleEn,
      title_es: titleEs,
      summary_en: summaryEn,
      summary_es: summaryEs,
      transcript_en: transcriptEn,
      transcript_es: transcriptEs,
      has_summary: !!summaryEn,
      has_summary_translated: !!summaryEs,
      has_transcript: !!transcriptEn,
      has_transcript_translated: !!transcriptEs
    };

    // Write full episode file
    fs.writeFileSync(
      path.join(episodesDbPath, `${episodeId}.json`),
      JSON.stringify(episodeData, null, 2),
      'utf8'
    );

    // Build compact search index entry (contains metadata and summaries for fast in-memory search)
    dbIndex.push({
      id: episodeId,
      title_en: titleEn,
      title_es: titleEs,
      summary_en: summaryEn.substring(0, 5000), // Cap length slightly if needed, but standard summaries are small
      summary_es: summaryEs.substring(0, 5000),
      has_summary_translated: !!summaryEs,
      has_transcript_translated: !!transcriptEs
    });

    compiledCount++;
  }

  // Write index file
  fs.writeFileSync(
    path.join(dbPath, 'index.json'),
    JSON.stringify(dbIndex, null, 2),
    'utf8'
  );

  console.log(`Database compilation complete!`);
  console.log(`- Index: data/database/index.json (${(fs.statSync(path.join(dbPath, 'index.json')).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`- Episode Files: data/database/episodes/*.json (total ${compiledCount} files)`);
}

module.exports = { buildDatabase };
