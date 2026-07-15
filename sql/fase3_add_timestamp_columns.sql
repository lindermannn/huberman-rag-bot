-- Fase 3: agrega columnas de timestamp a kb_documents para los chunks de transcript.
-- Nullable, aditivo -- no toca las filas existentes de resumen (topic != 'transcript_segment').
-- Correr como paso aislado en el SQL Editor de Supabase (no pegar junto con otras sentencias
-- en el mismo run, para evitar que un fallo posterior haga rollback de esto tambien).

alter table kb_documents add column if not exists timestamp_start text;
alter table kb_documents add column if not exists timestamp_end text;
