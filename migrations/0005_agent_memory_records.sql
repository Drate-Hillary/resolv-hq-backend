-- agent_memory_records is what the agent remembers between sessions
-- (distinct from customer_memory_facts, the customer's own facts) — see
-- src/routes/admin/memory-records.ts and the dashboard's memoryRecords
-- count in src/routes/admin/dashboard.ts. The table was referenced by both
-- routes and by the generated types (src/types/database.types.ts) but was
-- never actually created, which is what caused GET /admin/dashboard and
-- GET /admin/memory-records to 500 with PGRST205 "Could not find the
-- table 'public.agent_memory_records'".
--
-- Columns match the existing Row/Insert types exactly. request_id is
-- nullable with ON DELETE SET NULL, matching this codebase's other
-- optional FKs (see 0003_agent_runs_add_columns.sql's initiated_by).
-- retention_days/created_at get sensible defaults; expires_at has none
-- since it's derived per-row from retention_days at insert time.
--
-- RLS is enabled with zero policies: only the service-role key (used by
-- resolv-hq-backend's `db` client, see src/lib/supabase.ts) can read or
-- write this table, matching every other admin-only table here.

create table if not exists public.agent_memory_records (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references public.requests(id) on delete set null,
  title text not null,
  content text not null,
  reason text not null,
  access_scope text not null,
  source text not null,
  retention_days integer not null default 30,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.agent_memory_records enable row level security;

comment on table public.agent_memory_records is
  'What the agent remembers between sessions, staff-only. See src/routes/admin/memory-records.ts.';

notify pgrst, 'reload schema';
