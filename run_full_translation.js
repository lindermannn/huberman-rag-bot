const { runTranslation } = require('./src/translate');

async function run() {
  console.log('=== FASE 1: Completando resúmenes faltantes ===');
  await runTranslation({ engine: 'gemini', mode: 'summaries', limit: 'all' });

  console.log('\n=== FASE 2: Traduciendo todas las transcripciones ===');
  await runTranslation({ engine: 'gemini', mode: 'transcripts', limit: 'all' });

  console.log('\n=== TRADUCCION COMPLETA ===');
}

run().catch(e => {
  console.error('FATAL ERROR:', e);
  process.exit(1);
});
