const fs = require('fs');
const path = require('path');

const dbIndexPath = path.resolve(__dirname, '..', 'data', 'database', 'index.json');

function search(query) {
  if (!fs.existsSync(dbIndexPath)) {
    console.error('ERROR: Database index.json not found. Please compile the database first.');
    return;
  }

  const indexData = JSON.parse(fs.readFileSync(dbIndexPath, 'utf8'));
  const searchWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  if (searchWords.length === 0) {
    console.log('Please enter a query with words longer than 2 characters.');
    return;
  }

  console.log(`Searching for: "${query}" (words: ${searchWords.join(', ')})`);

  const results = [];

  for (const ep of indexData) {
    let score = 0;
    const titleEn = (ep.title_en || '').toLowerCase();
    const titleEs = (ep.title_es || '').toLowerCase();
    const summaryEn = (ep.summary_en || '').toLowerCase();
    const summaryEs = (ep.summary_es || '').toLowerCase();

    for (const word of searchWords) {
      // Titles are high value
      if (titleEs.includes(word)) score += 15;
      if (titleEn.includes(word)) score += 10;
      
      // Summaries are medium value
      if (summaryEs.includes(word)) score += 3;
      if (summaryEn.includes(word)) score += 2;
    }

    if (score > 0) {
      results.push({
        id: ep.id,
        title_es: ep.title_es,
        title_en: ep.title_en,
        has_summary_translated: ep.has_summary_translated,
        has_transcript_translated: ep.has_transcript_translated,
        score
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  console.log(`Found ${results.length} matches:`);
  console.log('----------------------------------------------------');
  results.slice(0, 5).forEach((r, idx) => {
    console.log(`[${idx + 1}] ${r.id} - ${r.title_es} (Score: ${r.score})`);
    console.log(`    English: ${r.title_en}`);
    console.log(`    Translated: Summary: ${r.has_summary_translated ? 'YES' : 'NO'}, Transcript: ${r.has_transcript_translated ? 'YES' : 'NO'}`);
    console.log('----------------------------------------------------');
  });
}

// Running search if query argument is provided
if (require.main === module) {
  const queryArg = process.argv.slice(2).join(' ');
  if (!queryArg) {
    // Example searches
    search('dormir sleep');
  } else {
    search(queryArg);
  }
}

module.exports = { search };
