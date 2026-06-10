-- Concord database schema (Supabase / Postgres + pgvector).
-- Apply this ONCE in the Supabase dashboard: SQL Editor -> paste -> Run.
-- It is idempotent, so re-running is safe.

-- 1. pgvector extension (provides the `vector` type and distance operators).
create extension if not exists vector;

-- 2. One row per source record. Per-source records have different clinical
--    shapes, so the queryable provenance/identity lives in columns and the
--    variable clinical payload lives in JSONB. `embedding` is the 384-dim
--    identity vector produced by all-MiniLM-L6-v2 (see app/embeddings.py).
create table if not exists records (
    id          bigint generated always as identity primary key,
    record_id   text        not null unique,          -- source-local id (clinic id = entry key)
    source_type text        not null,                 -- clinic | lab | pharmacy
    source_name text        not null,
    record_date date        not null,                 -- recency signal for adjudication
    identity    jsonb       not null,                 -- PatientIdentity (name, dob, nic, phone, gender)
    clinical    jsonb       not null default '{}'::jsonb,  -- per-source clinical fields
    embedding   vector(384) not null
);

-- 3. Approximate-nearest-neighbour index for cosine similarity.
create index if not exists records_embedding_idx
    on records using hnsw (embedding vector_cosine_ops);

-- 4. Similarity search exposed to the app via the Supabase client (.rpc()).
--    Returns the most similar records to a query identity embedding.
--    cosine similarity = 1 - cosine distance (the <=> operator).
create or replace function match_records(
    query_embedding vector(384),
    match_count     int default 10
)
returns table (
    record_id   text,
    source_type text,
    source_name text,
    record_date date,
    identity    jsonb,
    clinical    jsonb,
    similarity  float
)
language sql stable
as $$
    select
        r.record_id,
        r.source_type,
        r.source_name,
        r.record_date,
        r.identity,
        r.clinical,
        1 - (r.embedding <=> query_embedding) as similarity
    from records r
    order by r.embedding <=> query_embedding
    limit match_count;
$$;
