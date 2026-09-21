-- agent_runs' real original definition (confirmed from its CREATE TABLE)
-- is for the customer-facing agent-execution flow: customer_id/
-- conversation_id/request_id/iterations/error_message, FK'd to
-- profiles/ai_conversations/requests. The admin demo-run feature
-- (src/routes/admin/agent-runs.ts) was layered on top later and writes
-- title/model/prompt_version/latency_ms/initiated_by, which were never
-- added to the table. This adds just those missing columns, additively —
-- every original column stays untouched.
--
-- Existing rows will have NULL for these new columns (there's no sensible
-- backfill value for title/model/prompt_version on old rows), so they're
-- added nullable rather than NOT NULL. New rows created via
-- POST /admin/agent-runs always populate title/model/prompt_version.
-- initiated_by follows the same ON DELETE SET NULL style as the table's
-- other FKs (customer_id, conversation_id, request_id).
alter table public.agent_runs
  add column if not exists title text,
  add column if not exists model text,
  add column if not exists prompt_version text,
  add column if not exists latency_ms integer,
  add column if not exists initiated_by uuid references public.profiles(id) on delete set null;

-- Rebuild trace_runs_view now that agent_runs has the columns it selects.
-- Uses DROP + CREATE rather than CREATE OR REPLACE: the view that already
-- exists here predates title/model/prompt_version/latency_ms and has
-- different column names/order, and CREATE OR REPLACE VIEW can only append
-- columns, never rename or reorder existing ones — it would error with
-- something like `cannot change name of view column "..." to "title"`.
drop view if exists public.trace_runs_view;

create view public.trace_runs_view as
select
  r.id,
  r.title,
  r.started_at as date,
  r.status,
  r.model,
  r.prompt_version,
  r.latency_ms,
  coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'time', s.created_at,
          'label', s.label,
          'detail', s.detail,
          'kind', s.step_key
        )
        order by s.sequence
      )
      from public.agent_steps s
      where s.run_id = r.id
    ),
    '[]'::jsonb
  ) as events
from public.agent_runs r;

notify pgrst, 'reload schema';
