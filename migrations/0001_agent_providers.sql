-- Registered AI agents/providers (e.g. OpenAI, Anthropic, Google, or a
-- custom endpoint) and the API key used to call them. Run this against the
-- Supabase project's SQL editor (or via `supabase db push` once the project
-- is linked) — resolv-hq-backend has no live credentials to run it itself.
--
-- RLS is enabled with zero policies: only the service-role key (which is
-- what resolv-hq-backend's `db` client uses, see src/lib/supabase.ts) can
-- read or write this table. Nothing should ever query it with the anon/
-- publishable key, since rows contain plaintext API keys.

create table if not exists public.agent_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  provider text not null,
  model text,
  api_key text not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agent_providers enable row level security;

comment on table public.agent_providers is
  'AI provider credentials registered for the agent to call (name, provider, model, api_key). Service-role access only — see src/routes/admin/agent-providers.ts.';
comment on column public.agent_providers.api_key is
  'Plaintext API key. Consider Supabase Vault (pgsodium) for at-rest encryption if this ever needs a higher security bar than "service-role only, RLS-blocked from every other key".';
