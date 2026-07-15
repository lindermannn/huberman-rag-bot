-- Fase 3: fix de timeout en match_kb_documents_hybrid tras la migracion masiva de transcript_segment.
-- Diagnostico: Query Supabase KB devolvio "57014: canceling statement due to statement timeout"
-- al probar "que es la L-teanina" contra tenant_huberman despues de la migracion (kb_documents
-- paso de ~9,355 a ~27,254 filas). pg_indexes confirmo:
--   kb_documents_pkey          -- btree(id), ok
--   kb_documents_tenant_idx    -- btree(tenant_id), ok
--   kb_documents_embedding_idx -- ivfflat(embedding, lists=100), calculado cuando la tabla
--                                  tenia ~9,355 filas, nunca reconstruido
--   (sin indice sobre content_tsv) -- el CTE text_results hace seq scan + ts_rank_cd sobre
--                                     toda la tabla en cada llamada
--
-- Correr cada sentencia como paso aislado en el SQL Editor de Supabase.

-- Paso 1: actualiza las estadisticas del planner (barato, no bloquea escrituras/lecturas,
-- corregir esto solo ya puede arreglar el timeout si la causa era conteos/plan obsoletos).
analyze kb_documents;

-- Paso 2: indice GIN que falta para el full-text search (content_tsv). Sin esto, text_results
-- siempre hace seq scan sobre toda la tabla para calcular ts_rank_cd.
create index if not exists kb_documents_content_tsv_idx
  on public.kb_documents using gin (content_tsv);

-- Paso 3 (opcional, no bloqueante para el timeout -- mejora la calidad del ANN, no la causa
-- del timeout en si): el ivfflat actual tiene lists=100, calculado para ~9,355 filas. La regla
-- practica es lists ~= sqrt(filas); con ~27,254 filas eso da ~165. Reconstruir el indice con
-- mas lists mejora recall/velocidad del CTE vector_results a este tamano de tabla.
-- drop index if exists kb_documents_embedding_idx;
-- create index kb_documents_embedding_idx
--   on public.kb_documents using ivfflat (embedding vector_cosine_ops) with (lists = 165);
-- analyze kb_documents;
