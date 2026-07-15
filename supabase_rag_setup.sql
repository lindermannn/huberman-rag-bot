-- ============================================================
-- Setup de RAG con pgvector para tenant_huberman
-- Correr una sola vez en Supabase → SQL Editor → Run
-- No afecta ninguna tabla existente (conversation_events, etc.)
-- ============================================================

-- 1. Habilitar la extensión de vectores
create extension if not exists vector;

-- 2. Tabla de documentos de la KB
create table if not exists kb_documents (
  id text primary key,              -- ej. 'hub-ep200-tk3', mismo id que ya usa la KB actual
  tenant_id text not null,          -- 'tenant_huberman' (permite agregar mas tenants despues)
  topic text,                       -- categoria (ej. 'sueno-y-descanso')
  content text not null,            -- el texto del protocolo/hallazgo
  embedding vector(1536),           -- text-embedding-3-small = 1536 dimensiones
  episode_number int,               -- numero de episodio (para citar y para vigencia temporal)
  episode_date date,                -- fecha de emision del episodio (Nivel 1 del roadmap)
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 3. Indice por tenant (todas las consultas filtran por tenant_id primero)
create index if not exists kb_documents_tenant_idx
  on kb_documents (tenant_id);

-- 4. Indice de similitud vectorial (ivfflat, distancia coseno)
--    'lists = 100' es razonable para unos miles de filas; se puede ajustar mas adelante.
create index if not exists kb_documents_embedding_idx
  on kb_documents using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- 5. Funcion de busqueda por similitud, filtrada por tenant
--    module-rag-v3 la llama via /rest/v1/rpc/match_kb_documents
create or replace function match_kb_documents(
  query_embedding vector(1536),
  match_tenant_id text,
  match_count int default 3
)
returns table (
  id text,
  topic text,
  content text,
  episode_number int,
  episode_date date,
  similarity float
)
language sql stable
as $$
  select
    id,
    topic,
    content,
    episode_number,
    episode_date,
    1 - (embedding <=> query_embedding) as similarity
  from kb_documents
  where tenant_id = match_tenant_id
    and active = true
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- ============================================================
-- Verificacion rapida despues de correr esto:
-- select count(*) from kb_documents;  -- deberia dar 0 (recien creada, vacia)
-- select * from pg_extension where extname = 'vector';  -- deberia devolver 1 fila
-- ============================================================
