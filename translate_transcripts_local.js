// Traduce los transcripts faltantes usando el modelo local de LM Studio.
// Requisitos: LM Studio abierto, con el servidor iniciado (pestaña "Developer" > "Start Server")
// y el modelo "google/gemma-2-9b" cargado.
//
// Uso:
//   node translate_transcripts_local.js            -> traduce todos los transcripts faltantes
//   node translate_transcripts_local.js 5           -> traduce solo 5 episodios y se detiene
//
// Puedes cerrar esta ventana en cualquier momento (Ctrl+C) y el progreso ya
// guardado en data/translated/progress.json no se pierde. Al volver a
// correrlo, continúa donde se quedó.

const { runTranslation } = require('./src/translate.js');

const arg = process.argv[2];
const limit = arg ? parseInt(arg, 10) : 'all';

runTranslation({
  engine: 'lmstudio',
  mode: 'transcripts',
  limit,
}).then(() => {
  console.log('\nProceso terminado.');
}).catch(err => {
  console.error('\nERROR FATAL:', err.message);
});
