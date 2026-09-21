-- agent_steps' real definition (confirmed from its CREATE TABLE) uses
-- agent_run_id/step_type/step_number/result_summary/tool_id — not the
-- run_id/step_key/sequence/label/detail the ported admin agent-runs.ts
-- route and database.types.ts assumed. Unlike agent_runs, the mismatched
-- columns here (agent_run_id, step_type, step_number) are NOT NULL with no
-- defaults, so they can't be left unpopulated alongside new same-purpose
-- columns — the application code is updated instead to write the real
-- column names. The only genuinely missing pieces are a short display
-- label and the rich per-step JSON the demo script produces (result_summary
-- is plain text and can't hold that), so those are the only two columns
-- added here.
alter table public.agent_steps
  add column if not exists label text,
  add column if not exists detail jsonb;

-- Preserves security_invoker = on from the live view's current definition
-- (runs with the querying role's own RLS, not the view owner's).
drop view if exists public.trace_runs_view;

create view public.trace_runs_view
with (security_invoker = on) as
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
          'kind', s.step_type
        )
        order by s.step_number
      )
      from public.agent_steps s
      where s.agent_run_id = r.id
    ),
    '[]'::jsonb
  ) as events
from public.agent_runs r;

notify pgrst, 'reload schema';
