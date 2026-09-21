-- Reconstructed, not restored: this view is referenced by
-- src/routes/admin/dashboard.ts and src/routes/admin/traces.ts (and
-- database.types.ts documents its expected shape), but its actual
-- definition doesn't exist anywhere in this repo's git history — the
-- supabase/ folder that would normally hold it is empty. If you have the
-- real original definition (e.g. from Supabase's own migration history),
-- use that instead of this one.
--
-- This aggregates agent_runs + its agent_steps into a single row per run,
-- with `events` as a JSON array ordered by step sequence. `kind` is set to
-- the step's step_key verbatim (request/context/retrieval/plan/tool/
-- observation/decision/approval/result) — note this doesn't perfectly match
-- the frontend's narrower TraceEvent.kind union (which also expects
-- "error" and omits "context"/"observation"/"decision"), since there's no
-- record of how the original view resolved that. Adjust the CASE mapping
-- below if you know the intended semantics.
create or replace view public.trace_runs_view as
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

-- Views inherit RLS from their underlying tables in Postgres by default,
-- but PostgREST's schema cache needs a nudge after DDL — if the app still
-- 404s on this after running this file, also run:
--   NOTIFY pgrst, 'reload schema';
