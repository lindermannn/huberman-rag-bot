-- Fase 3: extiende match_kb_documents_hybrid para devolver timestamp_start/timestamp_end.
-- Cambios respecto a la version actual (confirmada via pg_get_functiondef): SOLO se agregan
-- las 2 columnas nuevas al RETURNS TABLE y al SELECT final. Los CTEs (vector_results,
-- text_results, fused) quedan identicos -- no tocan timestamps, no hace falta cambiarlos.
-- Correr como paso aislado en el SQL Editor de Supabase, despues de fase3_add_timestamp_columns.sql
-- y despues de correr migrate_transcript_chunks_to_supabase.js (para que las columnas existan
-- y tengan datos antes de que la funcion las intente devolver).
--
-- OJO: Postgres no permite cambiar las columnas de retorno de una funcion existente con
-- CREATE OR REPLACE -- hay que borrarla primero. Correr este DROP en su propio paso aislado
-- (un solo statement por vez, no pegado junto con el CREATE de abajo):
--
--   drop function match_kb_documents_hybrid(vector, text, text, integer, integer);
--
-- Recien despues de que el DROP corra OK, correr el CREATE FUNCTION de abajo como otro paso aislado.

create or replace function public.match_kb_documents_hybrid(
  query_embedding vector, query_text text, match_tenant_id text,
  match_count integer default 8, rrf_k integer default 50
)
 returns table(
   id text, topic text, content text, episode_number integer, episode_date date,
   timestamp_start text, timestamp_end text,
   similarity double precision, rank_score double precision
 )
 language sql
 stable
as $function$
  with vector_results as (
    select id, row_number() over (order by embedding <=> query_embedding) as rnk,
           1 - (embedding <=> query_embedding) as similarity
    from kb_documents
    where tenant_id = match_tenant_id and active = true
    order by embedding <=> query_embedding
    limit 50
  ),
  text_results as (
    select id, row_number() over (order by ts_rank_cd(content_tsv, websearch_to_tsquery('spanish', query_text)) desc) as rnk
    from kb_documents
    where tenant_id = match_tenant_id and active = true
      and content_tsv @@ websearch_to_tsquery('spanish', query_text)
    order by ts_rank_cd(content_tsv, websearch_to_tsquery('spanish', query_text)) desc
    limit 50
  ),
  fused as (
    select coalesce(v.id, t.id) as id,
           coalesce(1.0/(rrf_k + v.rnk), 0) + coalesce(1.0/(rrf_k + t.rnk), 0) as rrf_score,
           v.similarity
    from vector_results v
    full outer join text_results t on v.id = t.id
  )
  select d.id, d.topic, d.content, d.episode_number, d.episode_date,
         d.timestamp_start, d.timestamp_end,
         coalesce(f.similarity, 0) as similarity, f.rrf_score as rank_score
  from fused f
  join kb_documents d on d.id = f.id
  order by f.rrf_score desc
  limit match_count;
$function$;
