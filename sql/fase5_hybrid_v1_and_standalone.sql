-- Fase 5: reintroduccion de hybrid search (RRF) tras una regresion silenciosa tenant-huberman quedo
-- sirviendo a match_kb_published_documents_v2 (similitud coseno pura, funcion generica del "Centro
-- de Conocimiento" multi-tenant) despues de una migracion de plataforma que cambio que funcion se
-- llama, sin decision explicita de sacrificar el hybrid para este tenant.
--
-- Verificado leyendo pg_proc: match_kb_documents_hybrid (la funcion original, standalone, previa al
-- Centro de Conocimiento) seguia existiendo pero con dos bugs propios: (a) hardcodeaba
-- episode_number/episode_date/timestamp_start/timestamp_end a null en vez de leerlos de la tabla
-- (mataba las citas con deep-link aunque se reactivara tal cual), y (b) calculaba to_tsvector() al
-- vuelo en vez de usar la columna content_tsv ya indexada (GIN), sin aprovechar el indice.
--
-- Esta funcion es ADITIVA: no modifica match_kb_published_documents_v2 ni ningun otro objeto
-- existente. Reimplementa RRF (vector + full-text) sobre el esquema actual, con el mismo modelo de
-- seguridad que v2 (service_role + validacion de brand activo), usa la columna content_tsv (indice
-- GIN existente) y devuelve episode_number/episode_date/timestamp_start/timestamp_end reales.

create or replace function public.match_kb_published_documents_hybrid_v1(
  query_embedding vector,
  query_text text,
  match_tenant_id text,
  match_brand_id uuid,
  match_count integer default 8,
  rrf_k integer default 50
)
returns table(
  id text,
  topic text,
  content text,
  episode_number integer,
  episode_date date,
  timestamp_start text,
  timestamp_end text,
  similarity double precision,
  rank_score double precision
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_brand uuid := coalesce(match_brand_id, public.kb_default_brand(match_tenant_id));
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.kb_brands b
    where b.id = v_brand and b.tenant_id = match_tenant_id and b.active
  ) then
    raise exception using errcode = '42501', message = 'TENANT_OR_BRAND_MISMATCH';
  end if;

  return query
  with vector_results as (
    select d.id,
           row_number() over (order by d.embedding <=> query_embedding) as rnk,
           1 - (d.embedding <=> query_embedding) as similarity
    from public.kb_documents d
    where d.tenant_id = match_tenant_id
      and d.brand_id = v_brand
      and d.active
      and d.embedding is not null
    order by d.embedding <=> query_embedding
    limit 50
  ),
  text_results as (
    select d.id,
           row_number() over (
             order by ts_rank_cd(d.content_tsv, websearch_to_tsquery('spanish', coalesce(query_text, ''))) desc
           ) as rnk
    from public.kb_documents d
    where d.tenant_id = match_tenant_id
      and d.brand_id = v_brand
      and d.active
      and coalesce(query_text, '') <> ''
      and d.content_tsv @@ websearch_to_tsquery('spanish', query_text)
    order by ts_rank_cd(d.content_tsv, websearch_to_tsquery('spanish', query_text)) desc
    limit 50
  ),
  fused as (
    select coalesce(v.id, t.id) as id,
           coalesce(1.0 / (rrf_k + v.rnk), 0) + coalesce(1.0 / (rrf_k + t.rnk), 0) as rrf_score,
           v.similarity
    from vector_results v
    full outer join text_results t on t.id = v.id
  )
  select d.id,
         coalesce(d.topic, 'General'),
         d.content,
         d.episode_number,
         d.episode_date,
         d.timestamp_start,
         d.timestamp_end,
         coalesce(f.similarity, 0)::double precision as similarity,
         f.rrf_score::double precision as rank_score
  from fused f
  join public.kb_documents d on d.id = f.id
  order by f.rrf_score desc
  limit greatest(1, least(coalesce(match_count, 8), 20));
end;
$function$;

-- Nota sobre el consumo del score: un chunk top-ranked por RRF puede venir solo del full-text
-- (similarity vectorial = 0). El codigo que arma la respuesta (workflow) usa el MAXIMO de
-- similarity entre los chunks realmente citados -- no el del primero -- para no subestimar la
-- confianza y disparar falsos "gaps" cuando el hit fuerte fue lexico, no semantico.
