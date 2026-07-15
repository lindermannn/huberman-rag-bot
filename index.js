const readline = require('readline');
const { main: runExtract } = require('./src/extract');
const { runTranslation } = require('./src/translate');
const { buildDatabase } = require('./src/database');
const { search } = require('./src/test_search');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function menu() {
  console.log('\n======================================');
  console.log('Huberman Lab Wiki Bot Database Builder');
  console.log('======================================');
  console.log('1. Run Safe Extraction (Git -> data/raw)');
  console.log('2. Translate Episodes in Batches (EN -> ES)');
  console.log('3. Compile JSON Database (data/raw + data/translated -> data/database)');
  console.log('4. Run Test Search Query');
  console.log('5. Exit');
  console.log('======================================');
  
  const choice = await askQuestion('Select an option (1-5): ');
  
  switch (choice.trim()) {
    case '1':
      console.log('\nRunning extraction...');
      try {
        runExtract();
      } catch (e) {
        console.error('Extraction failed:', e.message);
      }
      break;
    case '2':
      await handleTranslationMenu();
      break;
    case '3':
      console.log('\nCompiling database...');
      try {
        buildDatabase();
      } catch (e) {
        console.error('Database build failed:', e.message);
      }
      break;
    case '4':
      const query = await askQuestion('\nEnter search query: ');
      search(query);
      break;
    case '5':
      console.log('Goodbye!');
      rl.close();
      return;
    default:
      console.log('Invalid choice. Please select 1-5.');
  }
  
  // Return to menu
  setTimeout(menu, 1000);
}

async function handleTranslationMenu() {
  console.log('\n--- Translation Settings ---');
  
  // 1. Engine
  console.log('1. Free Google Translate Web API (No key, small delay between calls)');
  console.log('2. Gemini API (Requires GEMINI_API_KEY environment variable)');
  const engineChoice = await askQuestion('Select translation engine (1-2, default 1): ');
  const engine = engineChoice.trim() === '2' ? 'gemini' : 'google';
  
  // 2. Mode
  console.log('\n1. Translate Summaries Only (Highly Recommended - Fast & Cheap)');
  console.log('2. Translate Transcripts Only (Takes longer)');
  console.log('3. Translate Both Summaries & Transcripts');
  const modeChoice = await askQuestion('Select mode (1-3, default 1): ');
  let mode = 'summaries';
  if (modeChoice.trim() === '2') mode = 'transcripts';
  if (modeChoice.trim() === '3') mode = 'all';
  
  // 3. Limit
  const limitStr = await askQuestion('\nEnter max number of new episodes to translate (e.g. 5, 10, all, default 5): ');
  let limit = 5;
  if (limitStr.trim().toLowerCase() === 'all') {
    limit = 'all';
  } else if (limitStr.trim()) {
    const parsed = parseInt(limitStr.trim(), 10);
    if (!isNaN(parsed)) limit = parsed;
  }
  
  console.log(`\nStarting translation batch: engine=${engine}, mode=${mode}, limit=${limit}`);
  try {
    await runTranslation({ engine, mode, limit });
  } catch (e) {
    console.error('Translation failed:', e.message);
  }
}

// Start menu
menu();
