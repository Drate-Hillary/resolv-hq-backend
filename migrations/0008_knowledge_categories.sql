-- Restores knowledge-base categorization, dropped during the earlier
-- schema simplification (see types/database.types.ts's header comment).
-- Run this against the Supabase project's SQL editor (or via
-- `supabase db push` once the project is linked) — resolv-hq-backend has
-- no live credentials to run it itself.

create table if not exists public.knowledge_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  created_at timestamptz not null default now()
);

alter table public.knowledge_categories enable row level security;

alter table public.knowledge_documents
  add column if not exists category_id uuid references public.knowledge_categories(id) on delete set null;

create index if not exists idx_knowledge_documents_category
  on public.knowledge_documents(category_id);

comment on table public.knowledge_categories is
  'Categories admins group knowledge_documents under (e.g. Billing, Policies, FAQ). Service-role access only — see src/routes/admin/knowledge-categories.ts.';
