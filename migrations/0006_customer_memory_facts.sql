-- customer_memory_facts is a distinct concept from customer_memory (the
-- generic memory_type/memory_key/memory_value store from the original
-- schema): it's the small set of toggleable facts the AI assistant has
-- learned about a customer, shown/editable on their own memory-facts
-- screen (see src/routes/memory.ts, served at GET/PATCH /memory-facts,
-- mapped via mapMemoryFactRow in src/lib/mappers.ts). The table was
-- referenced by that route and by the generated types
-- (src/types/database.types.ts) but was never actually created, which
-- caused GET/PATCH /memory-facts to 500 with PGRST205 "Could not find
-- the table 'public.customer_memory_facts'" (PostgREST's own error even
-- suggested the similarly-named but differently-shaped customer_memory).
--
-- Columns match the existing Row/Insert types exactly. customer_id
-- references profiles(id) like every other customer-owned table here
-- (customer_memory, notifications, etc.), ON DELETE CASCADE since a fact
-- has no meaning once the customer is gone.
--
-- RLS is enabled with a single policy: customers may only read/update
-- their own facts, matching the "customer_id = auth.uid()" pattern this
-- schema uses elsewhere (e.g. the customer_memory / requests policies).
-- Row creation isn't customer-facing (the assistant writes facts via the
-- service-role key from a future agent tool), so there's no INSERT policy
-- yet — service-role bypasses RLS regardless.

create table if not exists public.customer_memory_facts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id) on delete cascade,
  label text not null,
  detail text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.customer_memory_facts enable row level security;

create policy "Customers can view own memory facts"
  on public.customer_memory_facts
  for select
  to authenticated
  using (customer_id = (select auth.uid()));

create policy "Customers can update own memory facts"
  on public.customer_memory_facts
  for update
  to authenticated
  using (customer_id = (select auth.uid()))
  with check (customer_id = (select auth.uid()));

comment on table public.customer_memory_facts is
  'Toggleable facts the AI assistant has learned about a customer. See src/routes/memory.ts.';

notify pgrst, 'reload schema';
